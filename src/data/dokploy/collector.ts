/**
 * Keeps a live World for one Dokploy by polling at different cadences and merging the results
 * (runs in the browser; the caller drives `tick()`):
 *
 *   every tick (5 s)   projects + statuses, logs of running deploys
 *   every 2nd tick     deployment feed, container stats (CPU / memory / network)
 *   every 60th tick    domains + sources (per-service `.one` calls), host resources
 *
 * Every refresh ends in `commit()`, which diffs the new World against the last one and
 * publishes only what changed.
 */
import { diffWorld } from '../diff';
import type { Alert, Deployment, Server, Service, ServiceStatus, SourceStatus, World } from '../types';
import {
  UpstreamError,
  belongsTo,
  fetchContainerStats,
  fetchDeployments,
  fetchDetails,
  fetchHost,
  fetchLogLines,
  fetchServiceDeployments,
  fetchStructure,
  inferStages,
  mapDeployment,
  mapLimit,
  type ContainerStat,
  type Details,
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

type NetSample = { at: number; rx: number; tx: number };

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
      void Promise.allSettled([this.refreshStats(), this.refreshDetails(), this.refreshHost(), this.refreshRecentFailureLogs()]).then(() =>
        this.commit(),
      );
    });
  }

  tick() {
    return this.once('tick', async () => {
      const n = ++this.ticks;
      const jobs = [this.refreshStructure(), this.refreshRunningLogs()];
      if (n % 2 === 0) jobs.push(this.refreshDeployments(), this.refreshStats());
      if (n % 60 === 0) jobs.push(this.refreshDetails());
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
      const own = stats.filter((c) => belongsTo(c.name, svc.appName!));
      const prev = this.metrics.get(svc.id);
      const sample: NetSample = { at: now, rx: own.reduce((a, c) => a + c.rx, 0), tx: own.reduce((a, c) => a + c.tx, 0) };
      const history = (this.netHistory.get(svc.id) ?? []).filter((x) => now - x.at <= NET_WINDOW_MS);
      const cpu = milli(own.reduce((a, c) => a + c.cpu, 0));
      this.metrics.set(svc.id, {
        cpu,
        memMb: Math.round(own.reduce((a, c) => a + c.memMb, 0)),
        memLimitMb: Math.round(Math.max(0, ...own.map((c) => c.memLimitMb))) || prev?.memLimitMb || 0,
        rxBps: Math.round(netRate(history, sample, 'rx')),
        txBps: Math.round(netRate(history, sample, 'tx')),
        containers: own.length,
        hist: [...(prev?.hist ?? []).slice(-(HIST - 1)), cpu],
      });
      this.netHistory.set(svc.id, [...history, sample]);
    }
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

    const services: Service[] = s.services.map((svc) => {
      const det = this.details.get(svc.id);
      const m = this.metrics.get(svc.id);
      return {
        ...svc,
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
    });

    const servers = s.servers.map((sv) =>
      sv.id === 'local'
        ? { ...sv, name: this.host.hostname ?? sv.name, host: this.host.host, vcpu: this.host.vcpu, ramGb: this.host.ramGb }
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
          message: `Dokploy reports ${svc.name} as errored`,
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
