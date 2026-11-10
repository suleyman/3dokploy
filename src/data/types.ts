export type ServiceKind = 'app' | 'compose' | 'postgres' | 'redis' | 'mongo' | 'mysql' | 'mariadb' | 'libsql';
export type ServiceStatus = 'running' | 'idle' | 'deploying' | 'error';

export const DB_KINDS: readonly ServiceKind[] = ['postgres', 'redis', 'mongo', 'mysql', 'mariadb', 'libsql'];
export const isDb = (kind: ServiceKind) => DB_KINDS.includes(kind);

export interface Backup {
  /** Backup folder = the backup container's name. */
  name: string;
  /** epoch ms of the newest file, 0 when the folder is empty */
  newest: number;
  sizeMb: number;
  files: number;
  /** The node of the backup container, when it is on the map. */
  nodeId?: string;
}

export interface Server {
  id: string;
  name: string;
  host?: string;
  vcpu?: number;
  ramGb?: number;
  /** Used fraction of the host's disk / memory (optional /api/host). */
  diskUsed?: number;
  memUsed?: number;
  /** CrowdSec (optional): active bans, bans seen today, epoch ms of the newest. */
  bansActive?: number;
  bansToday?: number;
  banAt?: number;
  backups?: Backup[];
}

export interface Project {
  id: string;
  name: string;
  /** Building trim / zone tint in the scene, any CSS color. */
  color: string;
  description?: string;
}

/** Dokploy: project → environment (production, staging…) → services. */
/** Map preferences shared by all viewers (server /api/prefs): building order, complexes, colours. */
export interface MapPrefs {
  /** Project ids in the order the buildings should appear (unlisted ones follow by name). */
  order: string[];
  /** Complexes: groups of buildings placed together on one plate. */
  groups: { id: string; name: string; projects: string[] }[];
  /** Project id → colour preset key (see theme PRESETS). */
  colors: Record<string, string>;
}

export const EMPTY_PREFS: MapPrefs = { order: [], groups: [], colors: {} };

export interface Environment {
  id: string;
  projectId: string;
  name: string;
}

export interface Service {
  id: string;
  projectId: string;
  environmentId: string;
  serverId: string;
  name: string;
  kind: ServiceKind;
  status: ServiceStatus;
  /** 0..1 of the service's CPU limit. 0 until container stats arrive. */
  cpu: number;
  memMb: number;
  memLimitMb: number;
  domain?: string;
  /** Human readable origin, e.g. "github · acme/api@main" or "postgres:16-alpine". */
  source?: string;
  /** Dokploy's internal (Docker service) name. */
  appName?: string;
  description?: string;
  replicas: number;
  /** Epoch ms of the last successful deploy. */
  lastDeploy: number | null;
  createdAt?: number;
  /** Last 30 CPU samples (0..1), oldest first. */
  cpuHist: number[];
  /** Network throughput in bytes/s (received by / sent from the service's containers). */
  net?: { rxBps: number; txBps: number };
  /** Running containers right now (from container stats). */
  containers?: number;
  /** For a helper container (db, cache, broker…): the node of the app it mostly talks to. */
  peerId?: string;
  /** Why the node is in error, when it is more specific than Dokploy's status (e.g. a Kuma monitor). */
  incident?: string;
  /** Docker container name, when the node is one container. */
  container?: string;
  /** GlitchTip (optional): unresolved issues and epoch ms of the newest event. */
  errors?: number;
  errorAt?: number;
  /** Umami (optional): visitors on the site right now. */
  visitors?: number;
  /** Kuma (optional): slowest response time of the site's monitors, ms. */
  latencyMs?: number;
  /** Days until the first TLS certificate of the service's domains expires. */
  certDays?: number;
}

export const STAGES = ['Clone', 'Build', 'Push', 'Start', 'Health'] as const;
export type StageName = (typeof STAGES)[number];
export type StageStatus = 'queued' | 'running' | 'done' | 'failed';

export type DeployTrigger = 'push' | 'manual';
/** `queued` = accepted, waiting for the build slot (in the scene: cart still en route). */
export type DeployStatus = 'queued' | 'running' | 'success' | 'failed';

export interface Commit {
  sha: string;
  message: string;
  author: string;
}

export interface Deployment {
  id: string;
  serviceId: string;
  trigger: DeployTrigger;
  status: DeployStatus;
  /** One entry per STAGES item. */
  stages: StageStatus[];
  log: string[];
  commit?: Commit;
  /** Robot cart number shown in the scene ("RC3"). */
  cart: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  id: string;
  serviceId: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface World {
  servers: Server[];
  projects: Project[];
  environments: Environment[];
  services: Service[];
  deployments: Deployment[];
  alerts: Alert[];
}

export type Collection = keyof World;

/** Incremental update. Arrays are upserts keyed by `id`; `removed` lists ids to drop. */
export type WorldPatch = { [K in Collection]?: World[K] } & {
  removed?: Partial<Record<Collection, string[]>>;
};

export const COLLECTIONS: readonly Collection[] = ['servers', 'projects', 'environments', 'services', 'deployments', 'alerts'];

export type SourceState = 'connecting' | 'live' | 'error';

export interface SourceStatus {
  state: SourceState;
  /** Human readable reason when state is "error". */
  message?: string;
  /** Epoch ms of the last successful sync with the upstream API. */
  syncedAt?: number;
}

export const isActiveDeploy = (d: Deployment) => d.status === 'queued' || d.status === 'running';
