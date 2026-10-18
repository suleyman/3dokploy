/**
 * Dokploy REST client + normalisation into 3Dokploy's types. Read-only: only GET endpoints.
 * Runs in the browser; requests go through a `Transport` (this app's own server in practice).
 *
 * Endpoints (verified against a v0.29.8 instance's OpenAPI document):
 *   project.all, project.one          → projects, environments, services + status
 *   deployment.allCentralized         → every deployment (title = commit message, status, timings)
 *   deployment.readLogs               → deployment log tail (stages are inferred from it)
 *   swarm.getContainerStats           → `docker stats` snapshot (CPU %, memory, network I/O)
 *   swarm.getNodes / getNodeInfo      → host CPU / memory
 *   application.one, compose.one, <db>.one → domains, source, replicas, limits
 *
 * `project.all` only lists ids (and for databases nothing else), so it is followed by
 * `project.one` per project. Projects from versions without environments are treated as a
 * single "production" environment.
 */
import {
  STAGES,
  type Deployment,
  type Environment,
  type Project,
  type Server,
  type Service,
  type ServiceKind,
  type ServiceStatus,
  type StageStatus,
} from '../types';

/** Performs one GET against Dokploy's API (`path` starts with /api/...) and returns parsed JSON. */
export type Transport = (path: string, timeoutMs?: number) => Promise<unknown>;

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type Raw = Record<string, unknown>;

/** Dokploy keeps one service list per kind, each with its own id column and `.one` endpoint. */
export const KINDS: { list: string; id: string; kind: ServiceKind; status: string; one: string }[] = [
  { list: 'applications', id: 'applicationId', kind: 'app', status: 'applicationStatus', one: 'application' },
  { list: 'compose', id: 'composeId', kind: 'compose', status: 'composeStatus', one: 'compose' },
  { list: 'postgres', id: 'postgresId', kind: 'postgres', status: 'applicationStatus', one: 'postgres' },
  { list: 'mysql', id: 'mysqlId', kind: 'mysql', status: 'applicationStatus', one: 'mysql' },
  { list: 'mariadb', id: 'mariadbId', kind: 'mariadb', status: 'applicationStatus', one: 'mariadb' },
  { list: 'mongo', id: 'mongoId', kind: 'mongo', status: 'applicationStatus', one: 'mongo' },
  { list: 'redis', id: 'redisId', kind: 'redis', status: 'applicationStatus', one: 'redis' },
  { list: 'libsql', id: 'libsqlId', kind: 'libsql', status: 'applicationStatus', one: 'libsql' },
];

/** Dokploy: idle = never deployed / stopped, running = deploy in progress, done = up, error = failed. */
const STATUS: Record<string, ServiceStatus> = { idle: 'idle', running: 'deploying', done: 'running', error: 'error' };

const PALETTE = ['#7c6cff', '#2de2ff', '#2bd98a', '#ffb547', '#ff5fa2', '#4f8bff', '#c86bff', '#ff7a45', '#1fd1c1', '#d4f54a', '#8fd3ff'];

export const LOCAL_SERVER: Server = { id: 'local', name: 'dokploy (local)' };

// ---- transport -------------------------------------------------------------------------

/**
 * Browsers can't call Dokploy directly (no CORS, and the API key must not reach the page), so
 * requests go to this app's own server under the same path (/api/<procedure>). It adds the key
 * from its environment and only forwards read-only endpoints.
 */
export function serverTransport(): Transport {
  return async (path, timeoutMs = 10_000) => {
    let res: Response;
    try {
      res = await fetch(path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new UpstreamError(`Can't reach the 3Dokploy server (${(e as Error).message})`);
    }
    if (res.ok) return res.json();
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (body?.error) throw new UpstreamError(body.error, res.status);
    if (res.status === 401 || res.status === 403) throw new UpstreamError(`Dokploy rejected the API key (${res.status}).`, res.status);
    throw new UpstreamError(`Dokploy ${path.split('?')[0]} → ${res.status}`, res.status);
  };
}

const get = async <T,>(t: Transport, path: string, timeoutMs?: number) => (await t(path, timeoutMs)) as T;

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const q = encodeURIComponent;
export const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
export const time = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** Cheapest authenticated call. */
export const fetchVersion = (t: Transport) => get<string>(t, '/api/settings.getDokployVersion', 15_000);

// ---- structure: projects → environments → services ---------------------------------------

export interface Structure {
  servers: Server[];
  projects: Project[];
  environments: Environment[];
  services: Service[];
}

export async function fetchStructure(t: Transport): Promise<Structure> {
  const list = await get<Raw[]>(t, '/api/project.all');
  const full = await mapLimit(list, 4, async (p) => {
    try {
      return await get<Raw>(t, `/api/project.one?projectId=${q(String(p.projectId))}`);
    } catch (e) {
      // Auth / network problems should surface; a single odd project should not hide the rest.
      if (e instanceof UpstreamError && (e.status === undefined || e.status === 401 || e.status === 403)) throw e;
      return p;
    }
  });
  return normalize(full);
}

/** Colours handed out in creation order: distinct for the first PALETTE.length projects, and stable when new ones appear. */
function projectColors(raw: Raw[]) {
  const ordered = [...raw].sort((a, b) => (time(a.createdAt) ?? 0) - (time(b.createdAt) ?? 0) || String(a.projectId).localeCompare(String(b.projectId)));
  return new Map(ordered.map((p, i) => [String(p.projectId), PALETTE[i % PALETTE.length]]));
}

export function normalize(rawProjects: Raw[]): Structure {
  const servers = new Map<string, Server>();
  const projects: Project[] = [];
  const environments: Environment[] = [];
  const services: Service[] = [];
  const colors = projectColors(rawProjects);

  for (const p of rawProjects) {
    const projectId = String(p.projectId);
    projects.push({ id: projectId, name: str(p.name) ?? projectId, color: colors.get(projectId)!, description: str(p.description) });

    const envs: Raw[] = Array.isArray(p.environments)
      ? (p.environments as Raw[])
      : [{ ...p, environmentId: `${projectId}:default`, name: 'production' }];

    for (const env of envs) {
      const environmentId = String(env.environmentId);
      environments.push({ id: environmentId, projectId, name: str(env.name) ?? 'default' });

      for (const k of KINDS) {
        const items = Array.isArray(env[k.list]) ? (env[k.list] as Raw[]) : [];
        for (const s of items) {
          const id = str(s[k.id]);
          if (!id) continue;
          const serverId = str(s.serverId) ?? LOCAL_SERVER.id;
          const serverName = str((s.server as Raw | null | undefined)?.name);
          if (!servers.has(serverId)) servers.set(serverId, serverId === LOCAL_SERVER.id ? { ...LOCAL_SERVER } : { id: serverId, name: serverName ?? serverId });

          services.push({
            id,
            projectId,
            environmentId,
            serverId,
            name: str(s.name) ?? str(s.appName) ?? k.kind,
            kind: k.kind,
            status: STATUS[String(s[k.status])] ?? 'idle',
            cpu: 0,
            memMb: 0,
            memLimitMb: 0,
            appName: str(s.appName),
            description: str(s.description),
            replicas: 1,
            lastDeploy: null,
            createdAt: time(s.createdAt),
            cpuHist: [],
          });
        }
      }
    }
  }

  return { servers: [...servers.values()], projects, environments, services };
}

// ---- per-service details (domains, source, limits) ----------------------------------------

export interface Details {
  domain?: string;
  source?: string;
  replicas?: number;
  memLimitMb?: number;
}

/** "github · owner/repo@branch", "docker · image:tag"… */
function sourceOf(s: Raw): string | undefined {
  switch (s.sourceType) {
    case 'github':
      return str(s.repository) && `github · ${s.owner}/${s.repository}@${s.branch ?? 'main'}`;
    case 'gitlab':
      return str(s.gitlabRepository) && `gitlab · ${s.gitlabOwner}/${s.gitlabRepository}@${s.gitlabBranch ?? 'main'}`;
    case 'bitbucket':
      return str(s.bitbucketRepository) && `bitbucket · ${s.bitbucketOwner}/${s.bitbucketRepository}@${s.bitbucketBranch ?? 'main'}`;
    case 'gitea':
      return str(s.giteaRepository) && `gitea · ${s.giteaOwner}/${s.giteaRepository}@${s.giteaBranch ?? 'main'}`;
    case 'git': {
      const url = str(s.customGitUrl)?.replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\//, '').replace(/\.git$/, '');
      return url && `git · ${url}@${s.customGitBranch ?? 'main'}`;
    }
    case 'docker':
      return str(s.dockerImage) && `docker · ${s.dockerImage}`;
    case 'raw':
      return 'compose · inline docker-compose.yml';
    default:
      return str(s.dockerImage);
  }
}

export async function fetchDetails(t: Transport, kind: ServiceKind, id: string): Promise<Details> {
  const k = KINDS.find((x) => x.kind === kind)!;
  const s = await get<Raw>(t, `/api/${k.one}.one?${k.id}=${q(id)}`);
  const domains = Array.isArray(s.domains) ? (s.domains as Raw[]) : [];
  const memBytes = Number(s.memoryLimit);
  return {
    domain: str(domains[0]?.host),
    source: sourceOf(s),
    replicas: typeof s.replicas === 'number' && s.replicas > 0 ? s.replicas : undefined,
    memLimitMb: Number.isFinite(memBytes) && memBytes > 0 ? Math.round(memBytes / 1048576) : undefined,
  };
}

// ---- host ------------------------------------------------------------------------------------

export async function fetchHost(t: Transport): Promise<Pick<Server, 'host' | 'vcpu' | 'ramGb'> & { hostname?: string }> {
  const nodes = await get<Raw[]>(t, '/api/swarm.getNodes');
  const self = nodes.find((n) => n.Self) ?? nodes[0];
  if (!self) return {};
  const info = await get<Raw>(t, `/api/swarm.getNodeInfo?nodeId=${q(String(self.ID))}`);
  const res = ((info.Description as Raw | undefined)?.Resources ?? {}) as Raw;
  const status = (info.Status ?? {}) as Raw;
  return {
    hostname: str(self.Hostname),
    host: str(status.Addr),
    vcpu: typeof res.NanoCPUs === 'number' ? Math.round(res.NanoCPUs / 1e9) : undefined,
    ramGb: typeof res.MemoryBytes === 'number' ? Math.round((res.MemoryBytes / 1024 ** 3) * 10) / 10 : undefined,
  };
}

// ---- container stats (`docker stats --no-stream`) ---------------------------------------------

export interface ContainerStat {
  name: string;
  cpu: number; // fraction of one core
  memMb: number;
  memLimitMb: number;
  rx: number; // cumulative bytes
  tx: number;
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** "96MiB", "3.25MB", "0B" → bytes */
export function bytes(s: string | undefined): number {
  const m = /([\d.]+)\s*([a-zA-Z]+)?/.exec(s ?? '');
  if (!m) return 0;
  return parseFloat(m[1]) * (UNITS[(m[2] ?? 'b').toLowerCase()] ?? 1);
}

export async function fetchContainerStats(t: Transport): Promise<ContainerStat[]> {
  const raw = await get<Raw[]>(t, '/api/swarm.getContainerStats', 25_000);
  return raw.map((c) => {
    const [used, limit] = String(c.MemUsage ?? '').split('/');
    const [rx, tx] = String(c.NetIO ?? '').split('/');
    return {
      name: String(c.Name ?? ''),
      cpu: (parseFloat(String(c.CPUPerc ?? '0')) || 0) / 100,
      memMb: bytes(used) / 1024 ** 2,
      memLimitMb: bytes(limit) / 1024 ** 2,
      rx: bytes(rx),
      tx: bytes(tx),
    };
  });
}

/** Containers that belong to a Dokploy service: swarm tasks (`app.1.xyz`), compose (`app-web-1`) or stacks (`app_web.1`). */
export const belongsTo = (container: string, appName: string) =>
  container === appName || container.startsWith(`${appName}.`) || container.startsWith(`${appName}-`) || container.startsWith(`${appName}_`);

// ---- deployments ----------------------------------------------------------------------------

export const fetchDeployments = (t: Transport) => get<Raw[]>(t, '/api/deployment.allCentralized', 20_000);

/** One service's deployments: cheap enough to poll every tick while it is deploying. */
export function fetchServiceDeployments(t: Transport, kind: ServiceKind, id: string) {
  return kind === 'compose'
    ? get<Raw[]>(t, `/api/deployment.allByCompose?composeId=${q(id)}`)
    : get<Raw[]>(t, `/api/deployment.all?applicationId=${q(id)}`);
}

export async function fetchLogLines(t: Transport, deploymentId: string, tail = 400): Promise<string[]> {
  const raw = await get<unknown>(t, `/api/deployment.readLogs?deploymentId=${q(deploymentId)}&tail=${tail}`, 15_000);
  const text = typeof raw === 'string' ? raw : '';
  return text
    .split('\n')
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '').trimEnd())
    .filter((l) => l.trim() && !/^(Receiving|Resolving|remote: (Counting|Compressing))/.test(l.trim()));
}

/** Which of Clone / Build / Push / Start / Health a log has reached (0..5). */
function progress(lines: string[]) {
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  if (has(/Deployed: ✅|Docker (Compose )?Deployed|deployed successfully/i)) return 5;
  if (has(/Container \S+ (Started|Running|Healthy|Created)|Starting (container|service)|service update|docker service (create|update)/i)) return 3;
  if (has(/build completed|Successfully (built|tagged)|exporting to (docker )?image|Built image|naming to /i)) return 3;
  if (has(/Build(ing)? |Railpack|nixpacks|Dockerfile|Build Compose|^#\d+ \[/i)) return 1;
  if (has(/Cloning Repo.*✅|Cloned |File '.*' created|Pulling image|docker pull/i)) return 1;
  return 0;
}

/** Stage statuses from the deployment's own status plus what its log shows. */
export function inferStages(status: Deployment['status'], lines: string[] | undefined): StageStatus[] {
  if (status === 'success') return STAGES.map(() => 'done');
  if (status === 'queued') return STAGES.map(() => 'queued');
  // Without a log we only know where a failed deploy most likely stopped: the build.
  const p = lines?.length ? Math.min(progress(lines), 4) : status === 'failed' ? 1 : 0;
  return STAGES.map((_, i) => (i < p ? 'done' : i === p ? (status === 'failed' ? 'failed' : 'running') : 'queued'));
}

const DEPLOY_STATUS: Record<string, Deployment['status']> = { running: 'running', done: 'success', error: 'failed', cancelled: 'failed' };

function cartNumber(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 8) + 1;
}

/** Dokploy deployment → 3Dokploy deployment (without stages / log, the collector adds those). */
export function mapDeployment(d: Raw): Omit<Deployment, 'stages' | 'log'> & { errorMessage?: string } | null {
  const serviceId = str(d.applicationId) ?? str(d.composeId);
  const id = str(d.deploymentId);
  if (!serviceId || !id || d.isPreviewDeployment) return null;
  const title = (str(d.title) ?? '').split('\n')[0].trim();
  const manual = /^(Manual|Rebuild) deployment/i.test(title);
  const sha = /Commit:\s*([0-9a-f]{7,40})/i.exec(String(d.description ?? ''))?.[1];
  return {
    id,
    serviceId,
    trigger: manual ? 'manual' : 'push',
    status: DEPLOY_STATUS[String(d.status)] ?? 'queued',
    commit: sha || !manual ? { sha: sha?.slice(0, 7) ?? '', message: title || 'Deployment', author: '' } : undefined,
    cart: cartNumber(id),
    createdAt: time(d.createdAt) ?? Date.now(),
    startedAt: time(d.startedAt),
    finishedAt: time(d.finishedAt),
    errorMessage: str(d.errorMessage),
  };
}
