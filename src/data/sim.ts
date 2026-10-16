/**
 * Mock-only simulation. Lives entirely behind MockSource; the live source will not use any of this.
 * Every mutation replaces objects (never edits in place) because emitted objects end up in the store.
 */
import { buildErrorLog, clamp, dockLog, pick, randomCommit, randomSha, stageLog } from './mock';
import {
  STAGES,
  isActiveDeploy,
  type Alert,
  type Deployment,
  type DeployTrigger,
  type Service,
  type ServiceStatus,
  type World,
  type WorldPatch,
} from './types';

const MAX_ACTIVE = 2;
const PUSH_CHANCE = 0.09;
const INCIDENT_CHANCE = 0.01;
const BUILD_FAIL_CHANCE = 0.14;
const TICKS_PER_STAGE = 2;
const KEEP_DEPLOYMENTS = 60;
const KEEP_RESOLVED_ALERTS = 40;
const HIST = 30;
const BUILD = STAGES.indexOf('Build');

interface Baseline {
  cpu: number;
  mem: number; // fraction of limit
  rps: number;
}

class Changes {
  services = new Map<string, Service>();
  deployments = new Map<string, Deployment>();
  alerts = new Map<string, Alert>();
  removedDeployments: string[] = [];
  removedAlerts: string[] = [];

  toPatch(): WorldPatch | null {
    const p: WorldPatch = {};
    if (this.services.size) p.services = [...this.services.values()];
    if (this.deployments.size) p.deployments = [...this.deployments.values()];
    if (this.alerts.size) p.alerts = [...this.alerts.values()];
    if (this.removedDeployments.length || this.removedAlerts.length) {
      p.removed = { deployments: this.removedDeployments, alerts: this.removedAlerts };
    }
    return Object.keys(p).length ? p : null;
  }
}

export class Simulation {
  private services = new Map<string, Service>();
  private deployments = new Map<string, Deployment>();
  private alerts = new Map<string, Alert>();
  private baseline = new Map<string, Baseline>();
  private stageTicks = new Map<string, number>();
  /** Status to fall back to when a deploy fails. */
  private prevStatus = new Map<string, ServiceStatus>();
  private seq = 0;
  private ticks = 0;
  private cartSeq = 0;
  private ch = new Changes();

  constructor(private readonly world: World) {
    for (const s of world.services) {
      this.services.set(s.id, s);
      const nz = s.cpuHist.filter((v) => v > 0);
      this.baseline.set(s.id, {
        cpu: nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : 0.15,
        mem: s.memMb > 0 ? s.memMb / s.memLimitMb : 0.45,
        rps: s.rps || 10,
      });
    }
    for (const d of world.deployments) this.deployments.set(d.id, d);
    for (const a of world.alerts) this.alerts.set(a.id, a);
    this.cartSeq = Math.max(0, ...world.deployments.map((d) => d.cart));
  }

  snapshot(): World {
    return {
      servers: this.world.servers,
      projects: this.world.projects,
      environments: this.world.environments,
      services: [...this.services.values()],
      deployments: [...this.deployments.values()],
      alerts: [...this.alerts.values()],
    };
  }

  // ---- commands ----------------------------------------------------------------

  tick(now: number): WorldPatch | null {
    for (const s of this.services.values()) this.stepMetrics(s);
    for (const d of this.deployments.values()) if (d.status === 'running') this.stepDeploy(d, now);

    // Random pushes respect the cap; manual and auto-heal deploys always go through.
    // The 3rd tick always brings a push so the first cart leaves right after load.
    const kickoff = ++this.ticks === 3;
    const active = [...this.deployments.values()].filter(isActiveDeploy).length;
    if (active < MAX_ACTIVE && (kickoff || Math.random() < PUSH_CHANCE)) {
      const candidates = this.idleDeployables((s) => !!s.source?.match(/^(github|compose)/));
      if (candidates.length) this.createDeploy(pick(candidates), 'push', now);
    }
    if (Math.random() < INCIDENT_CHANCE) {
      const candidates = this.idleDeployables(() => true, true);
      if (candidates.length) this.incident(pick(candidates), now);
    }
    this.prune();
    return this.flush();
  }

  redeploy(serviceId: string, now: number): WorldPatch | null {
    const s = this.services.get(serviceId);
    if (s && !this.activeDeployFor(serviceId)) this.createDeploy(s, 'manual', now);
    return this.flush();
  }

  setRunning(serviceId: string, running: boolean, now: number): WorldPatch | null {
    const s = this.services.get(serviceId);
    if (!s || this.activeDeployFor(serviceId)) return null;
    if (!running && s.status !== 'idle') {
      this.putService({ ...s, status: 'idle', cpu: 0, memMb: 0, rps: s.rps === undefined ? undefined : 0 });
      this.resolveAlerts(serviceId, now, () => true);
    } else if (running && s.status === 'idle') {
      const b = this.baseline.get(s.id)!;
      this.putService({
        ...s,
        status: 'running',
        cpu: b.cpu * 0.6,
        memMb: Math.round(s.memLimitMb * b.mem * 0.7),
        rps: s.rps === undefined ? undefined : Math.round(b.rps * 0.4),
      });
    }
    return this.flush();
  }

  /** The cart reached the rack: the build slot opens and stages start. */
  cartArrived(deploymentId: string, now: number): WorldPatch | null {
    const d = this.deployments.get(deploymentId);
    const s = d && this.services.get(d.serviceId);
    if (!d || !s || d.status !== 'queued') return null;
    if (!this.prevStatus.has(d.id)) this.prevStatus.set(d.id, s.status === 'deploying' ? 'running' : s.status);
    this.stageTicks.set(d.id, 0);
    this.putDeploy({
      ...d,
      status: 'running',
      startedAt: now,
      stages: d.stages.map((_, i) => (i === 0 ? 'running' : 'queued')),
      log: [...d.log, dockLog(s, d)],
    });
    this.putService({ ...s, status: 'deploying' });
    return this.flush();
  }

  /** The technician finished "Restarting…": resolve the incident and roll out a fresh copy. */
  techFixed(serviceId: string, now: number): WorldPatch | null {
    const s = this.services.get(serviceId);
    if (!s) return null;
    this.resolveAlerts(serviceId, now, (a) => a.severity === 'critical');
    if (s.status === 'error' && !this.activeDeployFor(serviceId)) {
      const d = this.createDeploy(s, 'auto-heal', now);
      this.prevStatus.set(d.id, 'error');
      this.putService({ ...this.services.get(serviceId)!, status: 'deploying' });
    }
    return this.flush();
  }

  // ---- internals ---------------------------------------------------------------

  private stepMetrics(s: Service) {
    const b = this.baseline.get(s.id)!;
    const live = s.status === 'running' || s.status === 'deploying';
    let { cpu, memMb, rps } = s;
    if (live) {
      const building = s.status === 'deploying' && this.activeDeployFor(s.id)?.stages[BUILD] === 'running';
      const target = clamp(b.cpu + (building ? 0.3 : 0), 0, 0.92);
      cpu = clamp(cpu + (Math.random() - 0.5) * 0.08 + (target - cpu) * 0.15, 0.02, 0.97);
      const memTarget = b.mem * s.memLimitMb;
      memMb = Math.round(
        clamp(memMb + (Math.random() - 0.48) * s.memLimitMb * 0.02 + (memTarget - memMb) * 0.05, s.memLimitMb * 0.12, s.memLimitMb * 0.97),
      );
      if (rps !== undefined) rps = Math.max(0, Math.round(rps + (Math.random() - 0.5) * b.rps * 0.18 + (b.rps - rps) * 0.1));
    } else {
      cpu = 0;
      memMb = 0;
      if (rps !== undefined) rps = 0;
    }
    // Edge services move bytes per request; databases roughly with their load.
    const net = !live
      ? { rxBps: 0, txBps: 0 }
      : rps !== undefined
        ? { rxBps: Math.round(rps * (700 + Math.random() * 900)), txBps: Math.round(rps * (5000 + Math.random() * 9000)) }
        : { rxBps: Math.round(cpu * 260_000 * (0.7 + Math.random() * 0.6)), txBps: Math.round(cpu * 520_000 * (0.7 + Math.random() * 0.6)) };
    const cpuHist = [...s.cpuHist.slice(-(HIST - 1)), cpu];
    this.putService({ ...s, cpu, memMb, rps, cpuHist, net, containers: live ? s.replicas : 0 });
  }

  private stepDeploy(d: Deployment, now: number) {
    const t = (this.stageTicks.get(d.id) ?? 0) + 1;
    if (t < TICKS_PER_STAGE) {
      this.stageTicks.set(d.id, t);
      return;
    }
    this.stageTicks.set(d.id, 0);
    const s = this.services.get(d.serviceId)!;
    const k = d.stages.indexOf('running');
    const stages = [...d.stages];

    if (k === BUILD && d.trigger !== 'auto-heal' && Math.random() < BUILD_FAIL_CHANCE) {
      stages[k] = 'failed';
      this.finish({ ...d, stages, status: 'failed', finishedAt: now, log: [...d.log, `✖ Build failed: ${buildErrorLog()}`] });
      const back = this.prevStatus.get(d.id) ?? 'running';
      this.putService({ ...this.services.get(s.id)!, status: back });
      this.putAlert({
        id: this.id('alr'),
        serviceId: s.id,
        severity: 'warning',
        title: 'Deploy failed at Build',
        message: back === 'running' ? 'Previous version kept running' : 'Service left in previous state',
        createdAt: now,
      });
      return;
    }

    stages[k] = 'done';
    const log = [...d.log, stageLog(s, STAGES[k], d)];
    if (k === STAGES.length - 1) {
      this.finish({ ...d, stages, log, status: 'success', finishedAt: now });
      this.putService({ ...this.services.get(s.id)!, status: 'running', lastDeploy: now });
      this.resolveAlerts(s.id, now, (a) => a.severity !== 'critical');
    } else {
      stages[k + 1] = 'running';
      this.putDeploy({ ...d, stages, log });
    }
  }

  private finish(d: Deployment) {
    this.stageTicks.delete(d.id);
    this.prevStatus.delete(d.id);
    this.putDeploy(d);
  }

  private createDeploy(s: Service, trigger: DeployTrigger, now: number): Deployment {
    this.cartSeq = (this.cartSeq % 8) + 1;
    const d: Deployment = {
      id: this.id('dep'),
      serviceId: s.id,
      trigger,
      status: 'queued',
      stages: STAGES.map(() => 'queued'),
      log: [],
      commit:
        trigger === 'push'
          ? randomCommit()
          : trigger === 'manual'
            ? { sha: randomSha(), message: 'Manual redeploy', author: 'you' }
            : undefined,
      cart: this.cartSeq,
      createdAt: now,
    };
    this.putDeploy(d);
    return d;
  }

  private incident(s: Service, now: number) {
    const oom = Math.random() < 0.5;
    const probe: Record<Service['kind'], string> = {
      app: 'GET /healthz → 503 (3/3 retries)',
      compose: 'GET /healthz → 502 Bad Gateway (3/3 retries)',
      postgres: 'pg_isready: no response (3/3 retries)',
      redis: 'PING timed out after 5s (3/3 retries)',
      mongo: "db.adminCommand('ping') timed out (3/3 retries)",
      mysql: 'mysqladmin ping: connection refused (3/3 retries)',
      mariadb: 'mariadb-admin ping: connection refused (3/3 retries)',
      libsql: 'GET /health → connection reset (3/3 retries)',
    };
    this.putService({ ...s, status: 'error', cpu: 0, memMb: 0, rps: s.rps === undefined ? undefined : 0 });
    this.putAlert({
      id: this.id('alr'),
      serviceId: s.id,
      severity: 'critical',
      title: oom ? 'OOMKilled' : 'Healthcheck failing',
      message: oom ? `Container exceeded its ${s.memLimitMb} MB memory limit · exit code 137` : probe[s.kind],
      createdAt: now,
    });
  }

  private resolveAlerts(serviceId: string, now: number, match: (a: Alert) => boolean) {
    for (const a of this.alerts.values()) {
      if (a.serviceId === serviceId && !a.resolvedAt && match(a)) this.putAlert({ ...a, resolvedAt: now });
    }
  }

  private prune() {
    if (this.deployments.size > KEEP_DEPLOYMENTS) {
      const done = [...this.deployments.values()].filter((d) => !isActiveDeploy(d)).sort((a, b) => a.createdAt - b.createdAt);
      for (const d of done.slice(0, this.deployments.size - KEEP_DEPLOYMENTS)) {
        this.deployments.delete(d.id);
        this.ch.deployments.delete(d.id);
        this.ch.removedDeployments.push(d.id);
      }
    }
    const resolved = [...this.alerts.values()].filter((a) => a.resolvedAt).sort((a, b) => a.createdAt - b.createdAt);
    for (const a of resolved.slice(0, Math.max(0, resolved.length - KEEP_RESOLVED_ALERTS))) {
      this.alerts.delete(a.id);
      this.ch.alerts.delete(a.id);
      this.ch.removedAlerts.push(a.id);
    }
  }

  /** Running services without an in-flight deploy (optionally DBs too). */
  private idleDeployables(filter: (s: Service) => boolean, includeDbs = false) {
    return [...this.services.values()].filter(
      (s) =>
        s.status === 'running' &&
        (includeDbs || s.kind === 'app' || s.kind === 'compose') &&
        filter(s) &&
        !this.activeDeployFor(s.id),
    );
  }

  private activeDeployFor(serviceId: string) {
    for (const d of this.deployments.values()) if (d.serviceId === serviceId && isActiveDeploy(d)) return d;
    return undefined;
  }

  private id(prefix: string) {
    return `${prefix}-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
  }

  private putService(s: Service) {
    this.services.set(s.id, s);
    this.ch.services.set(s.id, s);
  }
  private putDeploy(d: Deployment) {
    this.deployments.set(d.id, d);
    this.ch.deployments.set(d.id, d);
  }
  private putAlert(a: Alert) {
    this.alerts.set(a.id, a);
    this.ch.alerts.set(a.id, a);
  }
  private flush() {
    const p = this.ch.toPatch();
    this.ch = new Changes();
    return p;
  }
}
