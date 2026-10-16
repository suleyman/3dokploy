import {
  STAGES,
  type Alert,
  type Commit,
  type Deployment,
  type Environment,
  type Project,
  type Server,
  type Service,
  type ServiceKind,
  type ServiceStatus,
  type StageName,
  type World,
} from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Small deterministic PRNG so the seed looks the same on every reload. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T,>(xs: readonly T[], r: () => number = Math.random): T => xs[Math.floor(r() * xs.length)];
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const COMMIT_MESSAGES = [
  'fix: debounce search input',
  'feat: CSV export for orders',
  'chore(deps): bump vite to 8.3',
  'perf: cache tenant lookups',
  'fix(auth): refresh token race',
  'feat: webhook retries with backoff',
  'refactor: extract billing service',
  'fix: n+1 in ticket list',
  'feat(api): per-key rate limiting',
  'chore: move healthcheck to /healthz',
  'fix: timezone drift in scheduler',
  'feat: dark mode for dashboard',
  'perf: stream large exports',
  'fix(ui): modal focus trap',
] as const;

export const AUTHORS = ['you', 'alex', 'sam', 'renovate[bot]'] as const;

export function randomSha(r: () => number = Math.random) {
  let s = '';
  for (let i = 0; i < 7; i++) s += '0123456789abcdef'[Math.floor(r() * 16)];
  return s;
}

export function randomCommit(r: () => number = Math.random): Commit {
  return { sha: randomSha(r), message: pick(COMMIT_MESSAGES, r), author: pick(AUTHORS, r) };
}

/** "github · acme/api@main" → ["github", "acme/api@main"] */
function splitSource(source: string): [string, string] {
  const [provider, ref = provider] = source.split(' · ');
  return [provider, ref];
}

const BUILD_ERRORS = [
  'npm ERR! code ELIFECYCLE · `pnpm build` exited with 1',
  "error TS2339: Property 'tenantId' does not exist on type 'Session'",
  "nixpacks: failed to resolve dependency 'sharp@0.33.5'",
  'ERROR: failed to solve: process "/bin/sh -c pnpm build" did not complete',
] as const;

/** One log line per finished stage. Shared by the seed (history) and the simulation. */
export function stageLog(svc: Service, stage: StageName, d: Pick<Deployment, 'commit' | 'cart'>): string {
  const [provider, ref] = splitSource(svc.source ?? 'docker · unknown');
  const sha = d.commit?.sha ?? 'latest';
  const image = `${svc.name}:${sha}`;
  switch (stage) {
    case 'Clone':
      return provider === 'docker' ? `Resolved ${ref} digest sha256:${sha}…` : `Cloned ${ref} (${sha})`;
    case 'Build':
      return provider === 'compose'
        ? `docker compose build · ${2 + (sha.charCodeAt(0) % 3)} services`
        : provider === 'docker'
          ? `Pulled ${ref}`
          : `Built ${image} with nixpacks in ${20 + (sha.charCodeAt(1) % 40)}s`;
    case 'Push':
      return `Pushed registry.internal/${image}`;
    case 'Start':
      return `Started ${svc.replicas}/${svc.replicas} replica${svc.replicas > 1 ? 's' : ''} · rolling update`;
    case 'Health':
      return `Healthcheck passed · GET /healthz 200 in ${18 + (sha.charCodeAt(2) % 60)}ms`;
  }
}

export const buildErrorLog = () => pick(BUILD_ERRORS);
export const dockLog = (svc: Service, d: Pick<Deployment, 'cart' | 'commit'>) =>
  `RC${d.cart} docked at ${svc.name} · ${d.commit ? `${d.commit.sha} "${d.commit.message}"` : 'restart'}`;

// ---------------------------------------------------------------------------

interface SvcSeed {
  name: string;
  kind: ServiceKind;
  source: string;
  memLimitMb: number;
  cpu: number;
  domain?: string;
  replicas?: number;
  rps?: number;
  status?: ServiceStatus;
  /** Environment name, defaults to "production". */
  env?: string;
}

interface ProjectSeed {
  name: string;
  color: string;
  serverId: string;
  services: SvcSeed[];
}

const SERVERS: Server[] = [
  { id: 'srv-fra-prod-01', name: 'fra-prod-01', host: '203.0.113.17', vcpu: 8, ramGb: 32 },
  { id: 'srv-hel-tools-01', name: 'hel-tools-01', host: '198.51.100.9', vcpu: 4, ramGb: 16 },
];

const PG = 'postgres:16-alpine';
const REDIS = 'redis:7.4-alpine';

/** Made-up example projects (example.com domains, an imaginary "acme" GitHub org). */
const PROJECTS: ProjectSeed[] = [
  {
    name: 'Storefront',
    color: '#a77bff',
    serverId: 'srv-fra-prod-01',
    services: [
      { name: 'shop-web', kind: 'app', source: 'github · acme/storefront-web@main', domain: 'shop.example.com', replicas: 2, memLimitMb: 512, cpu: 0.22, rps: 38 },
      { name: 'shop-api', kind: 'app', source: 'github · acme/storefront-api@main', domain: 'api.shop.example.com', replicas: 3, memLimitMb: 1024, cpu: 0.41, rps: 112 },
      { name: 'shop-worker', kind: 'app', source: 'github · acme/storefront-api@main', memLimitMb: 768, cpu: 0.35 },
      { name: 'shop-db', kind: 'postgres', source: PG, memLimitMb: 2048, cpu: 0.28 },
      { name: 'shop-cache', kind: 'redis', source: REDIS, memLimitMb: 256, cpu: 0.08 },
      { name: 'shop-web-stg', kind: 'app', source: 'github · acme/storefront-web@develop', domain: 'staging.shop.example.com', memLimitMb: 384, cpu: 0.06, rps: 2, env: 'staging' },
      { name: 'shop-api-stg', kind: 'app', source: 'github · acme/storefront-api@develop', domain: 'api.staging.shop.example.com', memLimitMb: 512, cpu: 0.09, rps: 3, env: 'staging' },
      { name: 'shop-db-stg', kind: 'postgres', source: PG, memLimitMb: 512, cpu: 0.05, env: 'staging' },
    ],
  },
  {
    name: 'Helpdesk',
    color: '#2d9bff',
    serverId: 'srv-fra-prod-01',
    services: [
      { name: 'desk-web', kind: 'app', source: 'github · acme/helpdesk-web@main', domain: 'help.example.com', replicas: 2, memLimitMb: 512, cpu: 0.18, rps: 54 },
      { name: 'desk-api', kind: 'app', source: 'github · acme/helpdesk-api@main', domain: 'api.help.example.com', replicas: 2, memLimitMb: 1024, cpu: 0.46, rps: 97 },
      { name: 'desk-mail', kind: 'compose', source: 'compose · acme/mail-relay', domain: 'mail.example.com', memLimitMb: 1536, cpu: 0.52, rps: 21 },
      { name: 'desk-scheduler', kind: 'app', source: 'github · acme/helpdesk-api@main', memLimitMb: 384, cpu: 0.12 },
      { name: 'desk-db', kind: 'postgres', source: PG, memLimitMb: 2048, cpu: 0.33 },
      { name: 'desk-queue', kind: 'redis', source: REDIS, memLimitMb: 512, cpu: 0.14 },
    ],
  },
  {
    name: 'Habit Tracker',
    color: '#2bd98a',
    serverId: 'srv-fra-prod-01',
    services: [
      { name: 'habits-web', kind: 'app', source: 'github · acme/habits-web@main', domain: 'habits.example.com', memLimitMb: 512, cpu: 0.15, rps: 26 },
      { name: 'habits-api', kind: 'app', source: 'github · acme/habits-api@main', domain: 'api.habits.example.com', replicas: 2, memLimitMb: 768, cpu: 0.31, rps: 64 },
      { name: 'habits-cron', kind: 'app', source: 'github · acme/habits-api@main', memLimitMb: 256, cpu: 0.2, status: 'error' },
      { name: 'habits-db', kind: 'mongo', source: 'mongo:7.0', memLimitMb: 2048, cpu: 0.24 },
    ],
  },
  {
    name: 'Docs Portal',
    color: '#ff8a3d',
    serverId: 'srv-fra-prod-01',
    services: [
      { name: 'docs-web', kind: 'app', source: 'github · acme/docs-web@main', domain: 'docs.example.com', memLimitMb: 512, cpu: 0.12, rps: 18 },
      { name: 'docs-api', kind: 'app', source: 'github · acme/docs-api@main', domain: 'api.docs.example.com', replicas: 2, memLimitMb: 768, cpu: 0.27, rps: 41 },
      { name: 'docs-search', kind: 'compose', source: 'compose · acme/meilisearch', domain: 'search.example.com', memLimitMb: 1024, cpu: 0.19, rps: 12 },
      { name: 'docs-db', kind: 'mysql', source: 'mysql:8.4', memLimitMb: 1536, cpu: 0.21 },
    ],
  },
  {
    name: 'Internal Tools',
    color: '#1fd1c1',
    serverId: 'srv-hel-tools-01',
    services: [
      { name: 'plausible', kind: 'compose', source: 'compose · plausible/community-edition', domain: 'stats.example.com', memLimitMb: 2048, cpu: 0.26, rps: 15 },
      { name: 'uptime-kuma', kind: 'app', source: 'docker · louislam/uptime-kuma:1', domain: 'status.example.com', memLimitMb: 384, cpu: 0.09, rps: 4 },
      { name: 'n8n', kind: 'app', source: 'docker · n8nio/n8n:1.112', domain: 'n8n.example.com', memLimitMb: 1024, cpu: 0.17, rps: 6 },
      { name: 'n8n-db', kind: 'postgres', source: PG, memLimitMb: 1024, cpu: 0.11 },
    ],
  },
  {
    name: 'Company Blog',
    color: '#ff5fa2',
    serverId: 'srv-hel-tools-01',
    services: [
      { name: 'blog-web', kind: 'app', source: 'github · acme/blog-web@main', domain: 'blog.example.com', memLimitMb: 512, cpu: 0.14, rps: 22 },
      { name: 'blog-cms', kind: 'app', source: 'github · acme/blog-cms@main', domain: 'cms.example.com', memLimitMb: 768, cpu: 0.2, status: 'idle' },
      { name: 'blog-db', kind: 'mariadb', source: 'mariadb:11.4', memLimitMb: 1024, cpu: 0.16 },
    ],
  },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export function seed(now = Date.now()): World {
  const r = mulberry32(0x5a1b);
  const projects: Project[] = [];
  const environments: Environment[] = [];
  const services: Service[] = [];

  for (const p of PROJECTS) {
    const projectId = `prj-${slug(p.name)}`;
    projects.push({ id: projectId, name: p.name, color: p.color });

    for (const s of p.services) {
      const envName = s.env ?? 'production';
      const environmentId = `env-${slug(p.name)}-${envName}`;
      if (!environments.some((e) => e.id === environmentId)) {
        environments.push({ id: environmentId, projectId, name: envName });
      }
      const status = s.status ?? 'running';
      const live = status === 'running';
      const hist: number[] = [];
      let c = s.cpu;
      for (let i = 0; i < 30; i++) {
        c = clamp(c + (r() - 0.5) * 0.08 + (s.cpu - c) * 0.15, 0.02, 0.95);
        hist.push(live || i < 22 ? c : 0);
      }
      services.push({
        id: `svc-${s.name}`,
        projectId,
        environmentId,
        serverId: p.serverId,
        name: s.name,
        kind: s.kind,
        status,
        cpu: live ? hist[hist.length - 1] : 0,
        memMb: live ? Math.round(s.memLimitMb * (0.35 + r() * 0.35)) : 0,
        memLimitMb: s.memLimitMb,
        domain: s.domain,
        source: s.source,
        replicas: s.replicas ?? 1,
        lastDeploy: s.kind === 'app' || s.kind === 'compose' ? now - Math.round((0.3 + r() * 70) * HOUR) : null,
        cpuHist: hist,
        rps: s.rps !== undefined ? (live ? s.rps : 0) : undefined,
      });
    }
  }

  // Deploy history for "today".
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  const span = Math.max(20 * MIN, Math.min(9 * HOUR, now - startOfDay - 5 * MIN));
  const deployable = services.filter((s) => s.kind === 'app' || s.kind === 'compose');
  const deployments: Deployment[] = [];
  for (let i = 0; i < 8; i++) {
    const svc = pick(deployable, r);
    const createdAt = now - Math.round(span * (0.05 + 0.9 * (i / 8) + r() * 0.05));
    const failed = i === 3;
    const commit = randomCommit(r);
    const d: Deployment = {
      id: `dep-seed-${i}`,
      serviceId: svc.id,
      trigger: i === 5 ? 'manual' : 'push',
      status: failed ? 'failed' : 'success',
      stages: STAGES.map((_, k) => (failed ? (k < 1 ? 'done' : k === 1 ? 'failed' : 'queued') : 'done')),
      log: [],
      commit,
      cart: (i % 8) + 1,
      createdAt,
      startedAt: createdAt + 9_000,
      finishedAt: createdAt + (failed ? 14_000 : 21_000),
    };
    d.log = [dockLog(svc, d)];
    for (const [k, st] of STAGES.entries()) {
      if (d.stages[k] === 'done') d.log.push(stageLog(svc, st, d));
      if (d.stages[k] === 'failed') d.log.push(`✖ Build failed: ${pick(BUILD_ERRORS, r)}`);
    }
    deployments.push(d);
  }
  // Keep each service's lastDeploy consistent with the history above.
  for (const d of deployments) {
    const svc = services.find((s) => s.id === d.serviceId)!;
    if (d.status === 'success' && d.finishedAt! > (svc.lastDeploy ?? 0)) svc.lastDeploy = d.finishedAt!;
  }

  const alerts: Alert[] = [
    {
      id: 'alr-seed-0',
      serviceId: 'svc-habits-cron',
      severity: 'critical',
      title: 'OOMKilled',
      message: 'Container exceeded its 256 MB memory limit · exit code 137',
      createdAt: now - 25_000,
    },
    {
      id: 'alr-seed-1',
      serviceId: 'svc-desk-api',
      severity: 'critical',
      title: 'Healthcheck failing',
      message: 'GET /healthz → 503 (3/3 retries)',
      createdAt: now - 5.2 * HOUR,
      resolvedAt: now - 5.1 * HOUR,
    },
    {
      id: 'alr-seed-2',
      serviceId: 'svc-docs-api',
      severity: 'warning',
      title: 'Deploy failed at Build',
      message: 'Previous version kept running',
      createdAt: now - 3 * HOUR,
      resolvedAt: now - 2.6 * HOUR,
    },
  ];

  return { servers: SERVERS.map((s) => ({ ...s })), projects, environments, services, deployments, alerts };
}
