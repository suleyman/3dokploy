import { Collector } from './dokploy/collector';
import { relayTransport, type Connection } from './dokploy/api';
import { seed } from './mock';
import { Simulation } from './sim';
import type { SourceCapabilities, SourceStatus, World, WorldPatch } from './types';

/**
 * Visual-only events raised by the 3D agents. A mock source uses them to drive the simulation
 * (a deploy waits for its cart, a technician "fixes" an incident). A live source ignores them.
 */
export type AgentEvent =
  | { type: 'cart-arrived'; deploymentId: string }
  | { type: 'tech-fixed'; serviceId: string };

export type PatchListener = (patch: WorldPatch) => void;
export type StatusListener = (status: SourceStatus) => void;

export interface DataSource {
  readonly kind: 'mock' | 'live';
  readonly capabilities: SourceCapabilities;
  /** Full snapshot; called once on startup. Rejects with a readable message when unreachable. */
  load(): Promise<World>;
  /** Incremental updates (+ connection status). Returns an unsubscribe function. */
  subscribe(onPatch: PatchListener, onStatus?: StatusListener): () => void;
  /** Dokploy: application.redeploy / compose.redeploy. Results arrive through `subscribe`. */
  redeploy(serviceId: string): Promise<void>;
  /** Dokploy: application.start / application.stop (and the compose / database equivalents). */
  setRunning(serviceId: string, running: boolean): Promise<void>;
  /** Log lines of a deployment whose tail isn't in the world yet. */
  logs?(deploymentId: string, tail?: number): Promise<string[]>;
  notify?(event: AgentEvent): void;
}

// ---- mock -----------------------------------------------------------------------------

export class MockSource implements DataSource {
  readonly kind = 'mock' as const;
  readonly capabilities: SourceCapabilities = { metrics: true, deployments: true, actions: true, simulation: true, sampleSeconds: 1 };
  private readonly sim = new Simulation(seed());
  private readonly listeners = new Set<PatchListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly tickMs = 1000) {}

  async load() {
    return this.sim.snapshot();
  }

  subscribe(onPatch: PatchListener, onStatus?: StatusListener) {
    this.listeners.add(onPatch);
    onStatus?.({ state: 'live', syncedAt: Date.now() });
    this.timer ??= setInterval(() => this.emit(this.sim.tick(Date.now())), this.tickMs);
    return () => {
      this.listeners.delete(onPatch);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  async redeploy(serviceId: string) {
    this.emit(this.sim.redeploy(serviceId, Date.now()));
  }

  async setRunning(serviceId: string, running: boolean) {
    this.emit(this.sim.setRunning(serviceId, running, Date.now()));
  }

  notify(event: AgentEvent) {
    const now = Date.now();
    switch (event.type) {
      case 'cart-arrived':
        return this.emit(this.sim.cartArrived(event.deploymentId, now));
      case 'tech-fixed':
        return this.emit(this.sim.techFixed(event.serviceId, now));
    }
  }

  private emit(patch: WorldPatch | null) {
    if (patch) for (const l of this.listeners) l(patch);
  }
}

// ---- live: Dokploy, polled from the browser through the relay -----------------------------

const POLL_MS = 5000;

/**
 * Read-only view of a real Dokploy. The collector runs right here in the browser; requests go
 * through the stateless relay (server/), which only forwards an allowlist of GET endpoints.
 * Polling pauses while the tab is hidden.
 */
export class DokploySource implements DataSource {
  readonly kind = 'live' as const;
  readonly capabilities: SourceCapabilities = { metrics: true, deployments: true, actions: false, simulation: false, sampleSeconds: 10 };
  private readonly collector: Collector;
  private readonly patchListeners = new Set<PatchListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(conn: Connection) {
    this.collector = new Collector(relayTransport(conn), new URL(conn.url).host, (event, data) => {
      if (event === 'patch') for (const l of this.patchListeners) l(data as WorldPatch);
      else for (const l of this.statusListeners) l(data as SourceStatus);
    });
  }

  async load() {
    await this.collector.bootstrap();
    if (!this.collector.world) throw new Error(this.collector.status.message ?? 'Could not load data from Dokploy.');
    return this.collector.world;
  }

  subscribe(onPatch: PatchListener, onStatus?: StatusListener) {
    this.patchListeners.add(onPatch);
    if (onStatus) {
      this.statusListeners.add(onStatus);
      onStatus(this.collector.status);
    }
    this.timer ??= setInterval(() => {
      if (!document.hidden) void this.collector.tick();
    }, POLL_MS);
    return () => {
      this.patchListeners.delete(onPatch);
      if (onStatus) this.statusListeners.delete(onStatus);
      if (!this.patchListeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  logs(deploymentId: string, tail = 60) {
    return this.collector.logsFor(deploymentId, tail);
  }

  async redeploy() {
    throw new Error('3Dokploy is read-only');
  }

  async setRunning() {
    throw new Error('3Dokploy is read-only');
  }
}
