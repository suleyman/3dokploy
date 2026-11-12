/**
 * Keeps a live World for one Dokploy by polling at different cadences and merging the results
 * (runs in the browser; the caller drives `tick()`):
 *
 *   every tick (5 s)   projects + statuses, logs of running deploys
 *   every 2nd tick     deployment feed, container stats (CPU / memory / network)
 *   every 6th tick     compose stacks' container lists
 *   every 60th tick    domains + sources (per-service `.one` calls), host resources
 *
 * A service with several containers (a compose stack, or replicas) is split into one node per
 * container. The first keeps the service id, so deploys and alerts stay attached to it.
 *
 * Every refresh ends in `commit()`, which diffs the new World against the last one and
 * publishes only what changed.
 */
import { Backoff } from '../backoff';
import { diffWorld } from '../diff';
import type { Alert, Deployment, Link, Server, Service, ServiceKind, ServiceStatus, SourceStatus, World } from '../types';
import {
  UpstreamError,
  belongsTo,
  fetchCerts,
  fetchComposeContainers,
  fetchContainerStats,
  fetchExtra,
  fetchDeployments,
  fetchDetails,
  fetchHost,
  fetchKuma,
  fetchLogLines,
  fetchServiceDeployments,
  fetchStructure,
  inferStages,
  mapDeployment,
  mapLimit,
  type ComposeContainer,
  type ContainerStat,
  type Details,
  type Extras,
  type KumaState,
  type Structure,
  type Transport,
} from './api';

const HIST = 30;
const KEEP_DEPLOYS = 80;
const LOG_LINES = 8;
const HOUR = 3_600_000;
const ALERT_WINDOW = 48 * HOUR;

type MappedDeploy = NonNullable<ReturnType<typeof mapDeployment>>;

interface Metric {
  cpu: number;
  memMb: number;
  memLimitMb: number;
  rxBps: number;
  txBps: number;
  containers: number;
  hist: number[];
}

export type Publish = (event: 'patch' | 'status', data: unknown) => void;

const milli = (v: number) => Math.round(v * 1000) / 1000;
/** How far back a network rate may look for a counter change (see netRate). */
const NET_WINDOW_MS = 5 * 60_000;
/** How long a container that disappeared keeps its node (shown idle). */
const GRACE_MS = 60_000;

type NetSample = { at: number; rx: number; tx: number };

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};
/** Hosts whose first label is the service's name, digits aside ("maklerfotos24.de" for "maklerfotos"). */
export function guessDomains(service: string, hosts: string[]): string[] {
  const name = service.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (name.length < 4) return [];
  return hosts.filter((h) => {
    const label = h.toLowerCase().replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/g, '');
    const bare = label.replace(/\d+$/, '');
    return bare.length >= 4 && (label === name || bare === name || bare === name.replace(/\d+$/, ''));
  });
}

/** "www.example.com" and "example.com" are the same site for visitor counts. */
const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');

/** Id of the node for one container of a service; see `compose()`. */
export const containerNodeId = (serviceId: string, key: string) => `${serviceId}::${key}`;

/** Swarm tasks are named `app.1.<task id>`; drop the task id so the node survives redeploys. */
const containerKey = (name: string) => name.replace(/^(.+\.\d+)\.[a-z0-9]{10,}$/, '$1');

/** Main containers first (they take the service id, so deploy carts go there), helpers last. */
const MAIN = /(^|[-_.])(web|app|api|server|frontend)([-_.]|$)/i;
const HELPER = /(^|[-_.])(db|postgres|mysql|mariadb|mongo|redis|valkey|broker|backup|cron|worker|vpn|gluetun|egress|edge|proxy)([-_.\d]|$)/i;
/** Helpers that talk to the internet, not to their app: their traffic still comes from the gate. */
const INTERNET = /(^|[-_.])(vpn|gluetun|egress|edge|proxy)([-_.\d]|$)/i;
const rank = (key: string) => (MAIN.test(key) ? 0 : HELPER.test(key) ? 2 : 1);
const byRole = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);

/**
 * A database container inside a compose stack gets the database look, like a Dokploy database
 * service. Docker only tells us the name here, so this goes by the usual names.
 */
export function dbKind(key: string): ServiceKind | undefined {
  const k = key.toLowerCase();
  const has = (word: string) => new RegExp(`(^|[-_.])${word}([-_.\\d]|$)`).test(k);
  if (has('mongo') || has('mongodb')) return 'mongo';
  if (has('mariadb')) return 'mariadb';
  if (has('mysql')) return 'mysql';
  if (has('redis') || has('valkey') || has('keydb') || has('broker')) return 'redis';
  if (has('libsql') || has('sqld')) return 'libsql';
  if (has('db') || has('postgres') || has('postgresql') || has('pg') || has('database')) return 'postgres';
  return undefined;
}

/** A container's node status; a deploy in progress wins while the container itself is fine. */
function containerStatus(c: ComposeContainer, service: ServiceStatus): ServiceStatus {
  if (c.state === 'restarting' || c.state === 'dead' || /unhealthy/i.test(c.status)) return 'error';
  if (c.state !== 'running') return 'idle';
  return service === 'deploying' ? 'deploying' : 'running';
}

/** "apps-paperlessngx-rpsc0w-paperless-ngx-db-1" → "paperless-ngx-db"; fixed names stay as they are. */
function containerLabel(key: string, appName: string) {
  const short = key.startsWith(appName) ? key.slice(appName.length).replace(/^[-_.]/, '') : key;
  return short.replace(/[-_]1$/, '') || key;
}

/**
 * docker stats prints NetIO with three significant digits ("12.1MB"), so a 10 s delta is
 * usually zero. Measure against the newest older sample whose counter actually differs: the
 * step then averages over the time it took to show up, which is the best estimate available.
 */
function netRate(samples: NetSample[], now: NetSample, key: 'rx' | 'tx') {
  for (let i = samples.length - 1; i >= 0; i--) {
    const old = samples[i];
    if (now[key] < old[key]) return 0; // counters reset (container restarted)
    if (now[key] > old[key]) return (now[key] - old[key]) / ((now.at - old.at) / 1000);
  }
  return 0;
}

export class Collector {
  world: World | null = null;
  status: SourceStatus = { state: 'connecting' };

  private structure: Structure | null = null;
  private deploys: MappedDeploy[] = [];
  private details = new Map<string, Details>();
  private metrics = new Map<string, Metric>();
  /** Container keys per service id (main container first, then by name, so node order is stable). */
  private containerKeys = new Map<string, string[]>();
  private kuma: KumaState | null = null;
  /** One probe before each round; see Backoff. */
  private gate = new Backoff();
  private extras: Extras = {};
  /** TLS days left per domain host (null: no certificate / unreachable). */
  private certs = new Map<string, number | null>();
  /** Last time each container node was seen, so a container missing for a moment keeps its rack. */
  private seen = new Map<string, number>();
  /** Compose stacks' containers by service id, from Dokploy's label match. */
  private composeContainers = new Map<string, ComposeContainer[]>();
  private netHistory = new Map<string, NetSample[]>();
  private logs = new Map<string, { lines: string[]; final: boolean }>();
  private host: Partial<Server> & { hostname?: string } = {};
  private errorSince = new Map<string, number>();
  private resolved = new Map<string, Alert>();
  private inflight = new Map<string, Promise<void>>();
  private warned = new Set<string>();
  private ticks = 0;
  private lastStatus = new Map<string, ServiceStatus>();

  constructor(
    private readonly t: Transport,
    private readonly publish: Publish,
  ) {}

  /** First snapshot as fast as possible (structure + deploys), the rest streams in as patches. */
  bootstrap() {
    return this.once('bootstrap', async () => {
      await Promise.allSettled([this.refreshStructure(), this.refreshDeployments()]);
      this.commit();
      void Promise.allSettled([this.refreshContainers().then(() => this.refreshStats()), this.refreshKuma(), this.refreshExtras(), this.refreshDetails().then(() => this.refreshCerts()), this.refreshHost(), this.refreshRecentFailureLogs()]).then(() =>
        this.commit(),
      );
    });
  }

  tick() {
    return this.once('tick', async () => {
      if (!this.gate.allowed(Date.now())) return;
      try {
        await this.t('/healthz', 4_000);
        this.gate.ok();
      } catch {
        this.gate.fail(Date.now());
        this.setStatus({ state: 'error', message: '3Dokploy is restarting…', syncedAt: this.status.syncedAt });
        return;
      }
      const n = ++this.ticks;
      const jobs = [this.refreshStructure(), this.refreshRunningLogs()];
      // The container list (`docker ps` on the Dokploy host, per stack and per open tab) only changes
      // on deploys: refresh it every 30 s; the stats in between use the cached list.
      if (n % 2 === 0)
        jobs.push(this.refreshDeployments(), (n % 6 === 0 ? this.refreshContainers() : Promise.resolve()).then(() => this.refreshStats()), this.refreshKuma(), this.refreshExtras());
      if (n % 60 === 0) jobs.push(this.refreshDetails().then(() => this.refreshCerts()));
      if (n % 120 === 0) jobs.push(this.refreshHost());
      await Promise.allSettled(jobs);
      this.commit();
    });
  }

  logsFor(deploymentId: string, tail: number) {
    return fetchLogLines(this.t, deploymentId, tail);
  }

  // ---- refreshers --------------------------------------------------------------------

  private async refreshStructure() {
    try {
      this.structure = await fetchStructure(this.t);
      this.setStatus({ state: 'live', syncedAt: Date.now() });
      const missing = this.structure.services.filter((s) => !this.details.has(s.id));
      if (missing.length && this.details.size) void this.refreshDetails(missing).then(() => this.commit());

      // Dokploy flips a service to "running" (our "deploying") the moment a deploy starts, long
      // before the 10 s deployment feed notices; short deploys can even finish in between. Follow
      // those services directly, every tick, while they deploy and once more right after.
      const watch = this.structure.services.filter(
        (s) => (s.kind === 'app' || s.kind === 'compose') && (s.status === 'deploying' || this.lastStatus.get(s.id) === 'deploying'),
      );
      this.lastStatus = new Map(this.structure.services.map((s) => [s.id, s.status]));
      await mapLimit(watch, 3, (s) => this.refreshServiceDeploys(s));
    } catch (e) {
      const message = e instanceof UpstreamError ? e.message : `Unexpected error: ${(e as Error).message}`;
      this.setStatus({ state: 'error', message, syncedAt: this.status.syncedAt });
    }
  }

  private async refreshDeployments() {
    try {
      const before = new Map(this.deploys.map((d) => [d.id, d.status]));
      this.deploys = (await fetchDeployments(this.t)).map(mapDeployment).filter((d): d is MappedDeploy => !!d);
      // Grab the final log once for deploys that just finished, so the pipeline shows how they ended.
      const finished = this.deploys.filter((d) => d.status !== 'running' && before.get(d.id) === 'running');
      await mapLimit(finished, 3, (d) => this.loadLog(d.id, true));
    } catch (e) {
      this.warn('deployments', e);
    }
  }

  private async refreshServiceDeploys(svc: Service) {
    try {
      const fresh = (await fetchServiceDeployments(this.t, svc.kind, svc.id)).map(mapDeployment).filter((d): d is MappedDeploy => !!d);
      const byId = new Map(this.deploys.map((d) => [d.id, d]));
      const now = Date.now();
      for (const d of fresh) {
        const before = byId.get(d.id);
        byId.set(d.id, d);
        if (d.status === 'running') await this.loadLog(d.id, false);
        // Just finished (or finished before we ever saw it running): keep how it ended.
        else if ((!before || before.status === 'running') && now - d.createdAt < 10 * 60_000) await this.loadLog(d.id, true);
      }
      this.deploys = [...byId.values()];
    } catch (e) {
      this.warn('service-deploys', e);
    }
  }

  private async refreshRunningLogs() {
    const running = this.deploys.filter((d) => d.status === 'running');
    await mapLimit(running, 3, (d) => this.loadLog(d.id, false));
  }

  private async refreshRecentFailureLogs() {
    const now = Date.now();
    const recent = this.deploys.filter((d) => d.status === 'failed' && now - d.createdAt < ALERT_WINDOW).slice(0, 10);
    await mapLimit(recent, 3, (d) => this.loadLog(d.id, true));
  }

  private async loadLog(id: string, final: boolean) {
    if (this.logs.get(id)?.final) return;
    try {
      this.logs.set(id, { lines: await fetchLogLines(this.t, id, 400), final });
    } catch (e) {
      this.warn(`log:${id}`, e);
    }
  }

  private async refreshContainers() {
    const stacks = (this.structure?.services ?? []).filter((s) => s.kind === 'compose' && s.appName);
    // One call per stack: stop at the first failure (e.g. a proxy answering 404 while 3Dokploy
    // itself redeploys), so a burst of errors can't get the viewer banned by fail2ban/CrowdSec.
    let failed = false;
    await mapLimit(stacks, 2, async (svc) => {
      if (failed) return;
      try {
        this.composeContainers.set(svc.id, await fetchComposeContainers(this.t, svc.appName!, (name) => this.asleep().has(name)));
      } catch (e) {
        failed = true;
        this.warn('containers', e);
      }
    });
  }

  private async refreshKuma() {
    if (this.kuma && !this.kuma.enabled) return; // not configured: ask once, then stay quiet
    try {
      this.kuma = await fetchKuma(this.t);
      if (this.kuma.error) this.warn('kuma', new Error(this.kuma.error));
    } catch (e) {
      this.warn('kuma', e);
    }
  }

  /** Kuma monitors that are down, keyed by the host of their URL. */
  private kumaDown() {
    const down = new Map<string, string[]>();
    for (const m of this.kuma?.monitors ?? []) {
      const host = m.status === 0 && m.url ? hostOf(m.url) : null;
      if (host) down.set(host, [...(down.get(host) ?? []), m.name]);
    }
    return down;
  }

  /** Container flows → links between nodes (one per pair, ports merged) and outgoing counts per node. */
  private links(byContainer: Map<string, string>): { links?: Link[]; egress?: Record<string, number> } {
    const flows = this.extras.flows;
    if (!flows?.enabled || flows.error) return {};
    const pairs = new Map<string, Link>();
    const egress: Record<string, number> = {};
    for (const f of flows.flows) {
      const from = byContainer.get(f.from);
      if (!from) continue;
      if (f.to === 'internet') {
        egress[from] = (egress[from] ?? 0) + f.conns;
        continue;
      }
      const to = byContainer.get(f.to);
      if (!to || to === from) continue;
      const key = `${from}>${to}`;
      const l = pairs.get(key) ?? { from, to, ports: [], conns: 0 };
      if (!l.ports.includes(f.port)) l.ports.push(f.port);
      l.conns += f.conns;
      pairs.set(key, l);
    }
    for (const l of pairs.values()) l.ports.sort((a, b) => a - b);
    return { links: [...pairs.values()].sort((a, b) => b.conns - a.conns), egress };
  }

  /** Slowest response time per URL host across Kuma monitors. */
  private kumaLatency() {
    const out = new Map<string, number>();
    for (const m of this.kuma?.monitors ?? []) {
      if (m.responseMs === undefined || !m.url) continue;
      const host = hostOf(m.url);
      if (host) out.set(host, Math.max(out.get(host) ?? 0, m.responseMs));
    }
    return out;
  }

  /** Containers Sablier stopped while idle: name → Sablier group. */
  private asleep() {
    return new Map((this.extras.sablier?.containers ?? []).filter((c) => !c.running).map((c) => [c.name, c.group]));
  }

  /** The optional integrations of the 3Dokploy server; one that answers "not configured" isn't asked again. */
  private async refreshExtras() {
    const names = ['glitchtip', 'umami', 'crowdsec', 'host', 'backups', 'flows', 'sablier'] as const;
    await Promise.allSettled(
      names.map(async (name) => {
        if (this.extras[name]?.enabled === false) return;
        try {
          const next = await fetchExtra(this.t, name);
          (this.extras as Record<string, unknown>)[name] = next;
          if ('error' in next && next.error) this.warn(name, new Error(next.error));
        } catch (e) {
          this.warn(name, e);
        }
      }),
    );
  }

  /** Hosts Kuma watches or Umami counts: real public sites, also those Dokploy doesn't route. */
  private publicHosts() {
    const hosts = new Set<string>();
    for (const m of this.kuma?.monitors ?? []) {
      const h = m.url ? hostOf(m.url) : null;
      if (h) hosts.add(h);
    }
    for (const site of this.extras.umami?.sites ?? []) hosts.add(site.domain.toLowerCase());
    return [...hosts];
  }

  private async refreshCerts() {
    const hosts = [...new Set([...[...this.details.values()].flatMap((d) => d.domains), ...this.publicHosts()])].filter((h) => !/^(\d+\.){3}\d+(:\d+)?$|:/.test(h));
    if (!hosts.length) return;
    try {
      const { certs } = await fetchCerts(this.t, hosts);
      for (const [h, days] of Object.entries(certs)) this.certs.set(h, days);
    } catch (e) {
      this.warn('certs', e);
    }
  }

  /**
   * GlitchTip projects → nodes: a container of that name (maklerfotos-worker), else the service of
   * that name (kinderbuch), else the service named like its first part (broccoli-web → broccoli).
   */
  private attachErrors(nodes: Service[], services: Service[]) {
    const projects = this.extras.glitchtip?.projects ?? [];
    if (!projects.length) return;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const byContainer = new Map(nodes.filter((n) => n.container).map((n) => [n.container!.toLowerCase(), n]));
    const byName = new Map(services.map((s) => [s.name.toLowerCase(), byId.get(s.id)]));
    for (const p of projects) {
      const slug = p.project.toLowerCase();
      const node = byContainer.get(slug) ?? byName.get(slug) ?? byName.get(slug.split('-')[0]);
      if (!node) continue;
      node.errors = (node.errors ?? 0) + p.unresolved;
      node.errorAt = Math.max(node.errorAt ?? 0, p.lastSeen);
      node.issues = [...(node.issues ?? []), ...(p.issues ?? [])].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 5);
    }
  }

  private async refreshStats() {
    if (!this.structure) return;
    let stats: ContainerStat[];
    try {
      stats = await fetchContainerStats(this.t);
    } catch (e) {
      return this.warn('stats', e);
    }
    const now = Date.now();
    for (const svc of this.structure.services) {
      if (!svc.appName) continue;
      const listed = this.composeContainers.get(svc.id);
      const names = new Set(listed?.map((c) => c.name));
      const own = stats.filter((c) => names.has(c.name) || belongsTo(c.name, svc.appName!));
      this.measure(svc.id, own, now);
      const current = listed ? [...names] : [...new Set(own.map((c) => containerKey(c.name)))];
      for (const key of current) this.seen.set(containerNodeId(svc.id, key), now);
      // Keep containers seen in the last minute (a redeploy recreates them), so buildings don't jump.
      const recent = (this.containerKeys.get(svc.id) ?? []).filter(
        (k) => !current.includes(k) && now - (this.seen.get(containerNodeId(svc.id, k)) ?? 0) < GRACE_MS,
      );
      const keys = [...current, ...recent].sort(byRole);
      this.containerKeys.set(svc.id, keys);
      for (const key of keys) this.measure(containerNodeId(svc.id, key), own.filter((c) => containerKey(c.name) === key), now);
    }
  }

  /** Updates the metric (and network history) kept under `id` from a set of containers. */
  private measure(id: string, own: ContainerStat[], now: number) {
    const prev = this.metrics.get(id);
    const sample: NetSample = { at: now, rx: own.reduce((a, c) => a + c.rx, 0), tx: own.reduce((a, c) => a + c.tx, 0) };
    const history = (this.netHistory.get(id) ?? []).filter((x) => now - x.at <= NET_WINDOW_MS);
    const cpu = milli(own.reduce((a, c) => a + c.cpu, 0));
    this.metrics.set(id, {
      cpu,
      memMb: Math.round(own.reduce((a, c) => a + c.memMb, 0)),
      memLimitMb: Math.round(Math.max(0, ...own.map((c) => c.memLimitMb))) || prev?.memLimitMb || 0,
      rxBps: Math.round(netRate(history, sample, 'rx')),
      txBps: Math.round(netRate(history, sample, 'tx')),
      containers: own.length,
      hist: [...(prev?.hist ?? []).slice(-(HIST - 1)), cpu],
    });
    this.netHistory.set(id, [...history, sample]);
  }

  private async refreshDetails(only?: Service[]) {
    const list = only ?? this.structure?.services ?? [];
    await mapLimit(list, 4, async (svc) => {
      try {
        this.details.set(svc.id, await fetchDetails(this.t, svc.kind, svc.id));
      } catch (e) {
        this.warn(`details:${svc.kind}`, e);
      }
    });
  }

  private async refreshHost() {
    try {
      this.host = await fetchHost(this.t);
    } catch (e) {
      this.warn('host', e);
    }
  }

  // ---- composition -------------------------------------------------------------------

  private commit() {
    if (!this.structure) return;
    const next = this.compose(this.structure);
    const patch = diffWorld(this.world, next);
    this.world = next;
    if (patch) this.publish('patch', patch);
  }

  private compose(s: Structure): World {
    const known = new Set(s.services.map((x) => x.id));
    const active = this.deploys.filter((d) => known.has(d.serviceId) && (d.status === 'running' || d.status === 'queued'));
    const recent = this.deploys
      .filter((d) => known.has(d.serviceId) && d.status !== 'running' && d.status !== 'queued')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, KEEP_DEPLOYS);

    const deployments: Deployment[] = [...active, ...recent].map(({ errorMessage, ...d }) => {
      const lines = this.logs.get(d.id)?.lines;
      const log = (lines ?? []).slice(-LOG_LINES).map((l) => (l.length > 180 ? `${l.slice(0, 177)}…` : l));
      if (d.status === 'failed' && errorMessage) log.push(`✖ ${errorMessage}`);
      return { ...d, stages: inferStages(d.status, lines), log };
    });

    const lastDeploy = new Map<string, number>();
    for (const d of deployments) {
      const at = d.finishedAt ?? d.createdAt;
      if (d.status === 'success' && at > (lastDeploy.get(d.serviceId) ?? 0)) lastDeploy.set(d.serviceId, at);
    }

    const kumaDown = this.kumaDown();
    const latency = this.kumaLatency();
    const visitors = new Map((this.extras.umami?.sites ?? []).map((x) => [bareHost(x.domain), x.visitors]));
    const sites = this.publicHosts();
    const asleep = this.asleep();
    const services: Service[] = s.services.flatMap((svc) => {
      const det = this.details.get(svc.id);
      const m = this.metrics.get(svc.id);
      // Domains routed outside Dokploy (e.g. a Traefik file config) are unknown to it: guess by name.
      const domains = det?.domains.length ? det.domains : guessDomains(svc.name, sites);
      // A Kuma monitor on one of the service's domains is down: Docker may say "running", users don't.
      const failing = svc.status === 'deploying' ? [] : domains.flatMap((d) => kumaDown.get(d) ?? []);
      const ms = domains.map((d) => latency.get(d)).filter((x): x is number => x !== undefined);
      const seen = domains.map((d) => visitors.get(bareHost(d))).filter((x): x is number => x !== undefined);
      const days = domains.map((d) => this.certs.get(d)).filter((x): x is number => typeof x === 'number');
      const single = this.containerKeys.get(svc.id);
      const node: Service = {
        ...svc,
        ...(failing.length ? { status: 'error' as const, incident: `Kuma: ${failing.join(', ')} down` } : {}),
        container: single?.length === 1 ? single[0] : undefined,
        latencyMs: ms.length ? Math.max(...ms) : undefined,
        visitors: seen.length ? seen.reduce((a, b) => a + b, 0) : undefined,
        certDays: days.length ? Math.min(...days) : undefined,
        domain: det?.domain,
        source: det?.source,
        replicas: det?.replicas ?? svc.replicas,
        memLimitMb: det?.memLimitMb ?? m?.memLimitMb ?? 0,
        cpu: m?.cpu ?? 0,
        memMb: m?.memMb ?? 0,
        cpuHist: m?.hist ?? [],
        net: m ? { rxBps: m.rxBps, txBps: m.txBps } : undefined,
        containers: m?.containers,
        lastDeploy: lastDeploy.get(svc.id) ?? null,
      };
      // Asleep (Sablier) is not down: idle, no incident, and a deploy in progress still shows.
      const napOf = (name?: string) => (name && node.status !== 'deploying' ? asleep.get(name) : undefined);
      const keys = this.containerKeys.get(svc.id) ?? [];
      if (keys.length < 2) {
        const nap = napOf(node.container);
        return [nap ? { ...node, status: 'idle' as const, incident: undefined, sleeping: nap } : node];
      }
      const listed = new Map(this.composeContainers.get(svc.id)?.map((c) => [c.name, c]));
      return keys.map((key, i) => {
        const cm = this.metrics.get(containerNodeId(svc.id, key));
        const c = listed.get(key);
        const nap = napOf(key);
        // A failed deploy (or a Kuma monitor that is down) leaves the containers running: the first
        // node, which keeps the service id and carries deploys and alerts, keeps the error.
        const status = nap
          ? 'idle'
          : c
            ? i === 0 && node.status === 'error'
              ? 'error'
              : containerStatus(c, node.status)
            : listed.size
              ? i === 0 && node.status === 'error'
                ? 'error'
                : 'idle' // gone for the moment (within the grace period)
              : node.status;
        return {
          ...node,
          status,
          sleeping: nap,
          incident: nap ? undefined : i === 0 ? node.incident : status === 'error' && c ? `${key}: ${c.status}` : undefined,
          peerId: i > 0 && HELPER.test(key) && !INTERNET.test(key) ? svc.id : undefined,
          id: i === 0 ? svc.id : containerNodeId(svc.id, key),
          name: containerLabel(key, svc.appName ?? ''),
          description: `${svc.name} · container ${key}`,
          container: key,
          kind: (i > 0 && dbKind(key)) || node.kind,
          domain: i === 0 ? node.domain : undefined,
          // the site's numbers belong to the app, not to its database
          latencyMs: i === 0 ? node.latencyMs : undefined,
          visitors: i === 0 ? node.visitors : undefined,
          certDays: i === 0 ? node.certDays : undefined,
          replicas: 1,
          memLimitMb: cm?.memLimitMb || node.memLimitMb,
          cpu: cm?.cpu ?? 0,
          memMb: cm?.memMb ?? 0,
          cpuHist: cm?.hist ?? [],
          net: cm ? { rxBps: cm.rxBps, txBps: cm.txBps } : undefined,
          containers: cm?.containers,
        };
      });
    });

    this.attachErrors(services, s.services);
    const byContainer = new Map(services.filter((x) => x.container).map((x) => [x.container!, x.id]));
    const { host, crowdsec, backups } = this.extras;
    const servers = s.servers.map((sv) =>
      sv.id === 'local'
        ? {
            ...sv,
            name: this.host.hostname ?? sv.name,
            host: this.host.host,
            vcpu: this.host.vcpu,
            ramGb: this.host.ramGb,
            diskUsed: host?.diskUsed ?? undefined,
            memUsed: host?.memUsed ?? undefined,
            ...(crowdsec?.enabled && !crowdsec.error ? { bansActive: crowdsec.active, bansToday: crowdsec.today, banAt: crowdsec.lastAt || undefined } : {}),
            backups: backups?.enabled ? backups.backups.map((b) => ({ ...b, nodeId: byContainer.get(b.name) })) : undefined,
            ...this.links(byContainer),
          }
        : sv,
    );

    return {
      servers,
      projects: s.projects,
      environments: s.environments,
      services,
      deployments,
      alerts: this.alerts(services, deployments),
    };
  }

  /** Alerts Dokploy doesn't have as such: nodes in error, and recent failed deploys. */
  private alerts(services: Service[], deployments: Deployment[]): Alert[] {
    const now = Date.now();
    const out: Alert[] = [];
    for (const svc of services) {
      const id = `node-error:${svc.id}`;
      if (svc.status === 'error') {
        if (!this.errorSince.has(id)) this.errorSince.set(id, now);
        this.resolved.delete(id);
        out.push({
          id,
          serviceId: svc.id,
          severity: 'critical',
          title: 'Node in error state',
          message: svc.incident ?? `Dokploy reports ${svc.name} as errored`,
          createdAt: this.errorSince.get(id)!,
        });
      } else if (this.errorSince.has(id)) {
        this.resolved.set(id, {
          id,
          serviceId: svc.id,
          severity: 'critical',
          title: 'Node in error state',
          message: `${svc.name} recovered`,
          createdAt: this.errorSince.get(id)!,
          resolvedAt: now,
        });
        this.errorSince.delete(id);
      }
    }
    for (const [id, a] of this.resolved) {
      if (now - a.resolvedAt! > 24 * HOUR) this.resolved.delete(id);
      else out.push(a);
    }

    for (const d of deployments) {
      const at = d.finishedAt ?? d.createdAt;
      if (d.status !== 'failed' || now - at > ALERT_WINDOW) continue;
      const fixed = deployments.find((x) => x.serviceId === d.serviceId && x.status === 'success' && x.createdAt > d.createdAt);
      out.push({
        id: `deploy-failed:${d.id}`,
        serviceId: d.serviceId,
        severity: 'warning',
        title: 'Deploy failed',
        message: d.log.at(-1)?.replace(/^✖ /, '') ?? d.commit?.message ?? 'Deployment failed',
        createdAt: at,
        resolvedAt: fixed ? (fixed.finishedAt ?? fixed.createdAt) : undefined,
      });
    }
    return out;
  }

  // ---- plumbing ----------------------------------------------------------------------

  private setStatus(next: SourceStatus) {
    this.status = next;
    this.publish('status', next);
  }

  private warn(key: string, e: unknown) {
    const k = key.split(':')[0];
    if (this.warned.has(k)) return;
    this.warned.add(k);
    console.warn(`[3dokploy] ${k}: ${(e as Error).message}`);
  }

  private once(key: string, fn: () => Promise<void>) {
    let p = this.inflight.get(key);
    if (!p) {
      p = fn().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }
}
