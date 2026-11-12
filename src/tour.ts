/**
 * Tour director: picks the next "shot" for the wall-display tour from what is going on right now.
 * Pure (no store, no scene), so it can be checked on its own.
 *
 * Priority: incidents → deploys → fresh errors → load → visitors → a technician at work → busiest
 * traffic → quiet buildings, with an overview now and then. A subject shown recently waits its turn
 * (cooldown), so the tour keeps moving instead of sitting on the same rack.
 */
import { STAGES, type Deployment, type Project, type Service } from './data/types';
import { mb, pct, rate } from './format';
import { trouble } from './trouble';

export interface TourActor {
  id: string;
  kind: 'tech' | 'cart';
  phase: string;
  target: string | null;
}

export interface Shot {
  /** Cooldown key: the same key is not shown again for `cooldown` ms. */
  key: string;
  /** What is on screen. */
  caption: string;
  /** Why the tour shows it right now. */
  reason: string;
  ms: number;
  select?: string;
  project?: string;
  follow?: string;
  /** The node whose hover card is shown during the shot. */
  hover?: string | null;
  overview?: boolean;
}

export interface TourInput {
  services: Service[];
  projects: Project[];
  deployments: Deployment[];
  actors: TourActor[];
  now: number;
  /** key → last time shown */
  recent: Map<string, number>;
  /** shots since the last overview */
  sinceOverview: number;
}

const COOLDOWN: Record<string, number> = { inc: 40_000, dep: 60_000, err: 30 * 60_000, load: 3 * 60_000, vis: 3 * 60_000, tech: 90_000, net: 4 * 60_000, quiet: 6 * 60_000 };
const OVERVIEW_EVERY = 6;
const FRESH_ERROR_MS = 10 * 60_000;

const fresh = (input: TourInput, key: string) => {
  const at = input.recent.get(key);
  return at === undefined || input.now - at > (COOLDOWN[key.split(':')[0]] ?? 60_000);
};

const memRatio = (s: Service) => (s.memLimitMb > 0 ? s.memMb / s.memLimitMb : 0);

export function nextShot(input: TourInput): Shot {
  const { services, projects, deployments, actors, now } = input;
  const byId = new Map(services.map((s) => [s.id, s]));
  const name = (id: string | null | undefined) => (id && byId.get(id)?.name) || 'a rack';
  const firstFresh = (shots: Shot[]) => shots.find((s) => fresh(input, s.key));
  const pick = (...groups: (() => Shot[])[]) => {
    for (const g of groups) {
      const s = firstFresh(g());
      if (s) return s;
    }
    return undefined;
  };

  // 1. Incidents: follow the technician on his way there, else the rack itself.
  const incidents = (): Shot[] =>
    services
      .filter((s) => s.status === 'error')
      .map((s) => {
        const tech = actors.find((a) => a.kind === 'tech' && a.target === s.id && (a.phase === 'walk' || a.phase === 'work'));
        const why = s.incident ?? 'down';
        return tech && tech.phase === 'walk'
          ? { key: `inc:${s.id}`, caption: `Following the technician to ${s.name}`, reason: `incident: ${why}`, ms: 12_000, follow: tech.id, hover: s.id }
          : { key: `inc:${s.id}`, caption: `Incident · ${s.name}`, reason: why, ms: 12_000, select: s.id, hover: s.id };
      });

  // 2. Deploys: ride along with the cart, then watch the pipeline.
  const deploys = (): Shot[] =>
    deployments
      .filter((d) => (d.status === 'running' || d.status === 'queued') && byId.has(d.serviceId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((d) => {
        const cart = actors.find((a) => a.id === `cart-${d.id}` && a.phase === 'out');
        const stage = STAGES[d.stages.findIndex((x) => x === 'running')];
        const msg = d.commit?.message.split('\n')[0].slice(0, 60);
        const why = d.trigger === 'push' ? `push${msg ? `: ${msg}` : ''}` : 'manual deploy';
        return cart
          ? { key: `dep:${d.id}`, caption: `Riding along with RC${d.cart} to ${name(d.serviceId)}`, reason: `deploy started · ${why}`, ms: 10_000, follow: cart.id, hover: d.serviceId }
          : { key: `dep:${d.id}`, caption: `Deploy · ${name(d.serviceId)}`, reason: `${stage ? `stage ${stage}` : d.status} · ${why}`, ms: 10_000, select: d.serviceId, hover: d.serviceId };
      });

  // 3. A new error event in GlitchTip.
  const errors = (): Shot[] =>
    services
      .filter((s) => s.errorAt && now - s.errorAt < FRESH_ERROR_MS)
      .sort((a, b) => (b.errorAt ?? 0) - (a.errorAt ?? 0))
      .map((s) => ({
        key: `err:${s.id}:${s.errorAt}`,
        caption: `New error · ${s.name}`,
        reason: `GlitchTip event ${Math.max(1, Math.round((now - (s.errorAt ?? now)) / 60_000))} min ago${s.issues?.[0] ? `: ${s.issues[0].title}` : ''}`,
        ms: 9_000,
        select: s.id,
        hover: s.id,
      }));

  // 4. Load: smoking/burning racks first, then the busiest by CPU or memory.
  const load = (): Shot[] =>
    services
      .filter((s) => s.status === 'running' && (trouble(s) || s.cpu >= 0.5 || memRatio(s) >= 0.8))
      .sort((a, b) => Number(!!trouble(b)) - Number(!!trouble(a)) || Math.max(b.cpu, memRatio(b)) - Math.max(a.cpu, memRatio(a)))
      .map((s, i) => {
        const t = trouble(s);
        const why = [
          t === 'fire' ? 'overloaded (burning)' : t === 'smoke' ? 'under heavy load (smoking)' : '',
          s.cpu >= 0.5 ? `CPU ${pct(s.cpu)}` : '',
          memRatio(s) >= 0.8 ? `RAM ${pct(memRatio(s))} of its limit` : '',
          i === 0 ? 'the highest load right now' : '',
        ].filter(Boolean);
        return { key: `load:${s.id}`, caption: `High load · ${s.name} · ${mb(s.memMb)}`, reason: why.join(' · '), ms: 9_000, select: s.id, hover: s.id };
      });

  // Per project: visitors and traffic, with the node that carries most of it.
  const perProject = projects.map((p) => {
    const own = services.filter((s) => s.projectId === p.id);
    const top = (f: (s: Service) => number) => own.reduce<Service | undefined>((a, s) => (!a || f(s) > f(a) ? s : a), undefined);
    const net = (s: Service) => (s.net ? s.net.rxBps + s.net.txBps : 0);
    return { p, own, visitors: own.reduce((a, s) => a + (s.visitors ?? 0), 0), net: own.reduce((a, s) => a + net(s), 0), topNet: top(net), topCpu: top((s) => s.cpu) };
  });

  // 5. Visitors on a site right now.
  const visitors = (): Shot[] =>
    perProject
      .filter((x) => x.visitors > 0)
      .sort((a, b) => b.visitors - a.visitors)
      .map((x, i) => ({
        key: `vis:${x.p.id}`,
        caption: `Visitors · ${x.p.name}`,
        reason: `${x.visitors} ${x.visitors === 1 ? 'person' : 'people'} on the site right now (Umami)${i === 0 ? ', the most of all sites' : ''}`,
        ms: 9_000,
        project: x.p.id,
        hover: x.own.find((s) => s.visitors)?.id ?? null,
      }));

  // 6. Ride along with a technician on his round.
  const crew = (): Shot[] =>
    actors
      .filter((a) => a.kind === 'tech' && (a.phase === 'patrol' || a.phase === 'inspect' || a.phase === 'walk'))
      .map((a) => {
        const t = a.target ? byId.get(a.target) : undefined;
        const why = !t ? 'his round' : t.status === 'deploying' ? 'a deploy is running there' : t.cpu >= 0.5 ? `the rack is busy (CPU ${pct(t.cpu)})` : 'routine round';
        return {
          key: `tech:${a.id}`,
          caption: a.phase === 'inspect' ? `Following a technician · checking ${name(a.target)}` : `Following a technician · on his way to ${name(a.target)}`,
          reason: `nothing urgent, so the crew patrols · ${why}`,
          ms: 14_000,
          follow: a.id,
          hover: a.target,
        };
      });

  // 7. The building with the most network traffic.
  const traffic = (): Shot[] =>
    perProject
      .filter((x) => x.net > 50_000)
      .sort((a, b) => b.net - a.net)
      .map((x, i) => ({
        key: `net:${x.p.id}`,
        caption: `Traffic · ${x.p.name}`,
        reason: `${rate(x.net)} through its containers${i === 0 ? ', the most of all buildings' : ''}${x.topNet ? `, mostly ${x.topNet.name}` : ''}`,
        ms: 8_000,
        project: x.p.id,
        hover: x.topNet?.id ?? null,
      }));

  // 8. Otherwise the buildings one by one, the most active first.
  const quiet = (): Shot[] =>
    perProject
      .filter((x) => x.own.length)
      .sort((a, b) => b.own.reduce((s, n) => s + n.cpu, 0) - a.own.reduce((s, n) => s + n.cpu, 0))
      .map((x) => ({
        key: `quiet:${x.p.id}`,
        caption: `${x.p.name} · ${x.own.length} node${x.own.length === 1 ? '' : 's'}`,
        reason: 'nothing urgent · visiting the buildings, most active first',
        ms: 7_000,
        project: x.p.id,
        hover: x.topCpu?.id ?? null,
      }));

  const overview = (): Shot => {
    const up = services.filter((s) => s.status === 'running').length;
    const down = services.filter((s) => s.status === 'error').length;
    const parts = [`${up} running`, down ? `${down} down` : ''].filter(Boolean);
    return {
      key: 'overview',
      caption: `Overview · ${parts.join(' · ')}`,
      reason: input.sinceOverview >= OVERVIEW_EVERY ? `the whole map every ${OVERVIEW_EVERY} shots` : 'nothing else to show right now',
      ms: 7_000,
      overview: true,
      hover: null,
    };
  };

  // Incidents and deploys interrupt anything; the rest yields to an overview now and then.
  return (
    pick(incidents, deploys) ??
    (input.sinceOverview >= OVERVIEW_EVERY ? overview() : undefined) ??
    pick(errors, load, visitors, crew, traffic, quiet) ??
    overview()
  );
}
