import { Collector } from './dokploy/collector';
import { fetchVersion, serverTransport, type Transport } from './dokploy/api';
import type { SourceStatus, World, WorldPatch } from './types';

export type PatchListener = (patch: WorldPatch) => void;
export type StatusListener = (status: SourceStatus) => void;

export interface DataSource {
  /** Full snapshot; called once on startup. Rejects with a readable message when unreachable. */
  load(): Promise<World>;
  /** Incremental updates (+ connection status). Returns an unsubscribe function. */
  subscribe(onPatch: PatchListener, onStatus?: StatusListener): () => void;
  /** Log lines of a deployment whose tail isn't in the world yet. */
  logs(deploymentId: string, tail?: number): Promise<string[]>;
  /** Dokploy's version, for the header. */
  version(): Promise<string | null>;
}

const POLL_MS = 5000;
/** Seconds between two metric samples (container stats come every 2nd poll), for chart axes. */
export const SAMPLE_SECONDS = 10;

/**
 * Read-only view of the Dokploy this server is configured for (DOKPLOY_URL / DOKPLOY_API_KEY).
 * The collector runs right here in the browser and calls this app's own /api, which forwards
 * an allowlist of read-only endpoints with the server's key. Polling pauses while the tab is hidden.
 */
export class DokploySource implements DataSource {
  private readonly t: Transport = serverTransport();
  private readonly collector: Collector;
  private readonly patchListeners = new Set<PatchListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.collector = new Collector(this.t, (event, data) => {
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

  version() {
    return fetchVersion(this.t).then(
      (v) => (typeof v === 'string' && v.trim() ? v.trim() : null),
      () => null,
    );
  }
}
