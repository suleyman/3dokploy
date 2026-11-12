/**
 * Optional, read-only data from services around Dokploy. Each endpoint is off unless its
 * environment is set, always answers 200 (`enabled: false` when off), caches upstream calls, and
 * never forwards credentials or file contents to the browser.
 *
 *   /api/glitchtip  GLITCHTIP_URL + GLITCHTIP_TOKEN         unresolved issues per project
 *   /api/umami      UMAMI_URL + UMAMI_API_KEY               active visitors per website
 *   /api/crowdsec   CROWDSEC_URL + CROWDSEC_BOUNCER_KEY      active bans, bans seen today
 *   /api/logs       DOCKER_PROXY_URL (docker-socket-proxy)  last lines of one container
 *   /api/backups    BACKUP_STATUS_FILE                      newest dump per backup folder
 *   /api/flows      FLOW_STATUS_FILE + DOCKER_PROXY_URL     connections between containers
 *   /api/sablier    DOCKER_PROXY_URL                        containers Sablier stops when idle
 *   /api/certs      (always)                                TLS days left per host
 *   /api/host       (always)                                disk + memory of the host
 */
import { readFile, statfs } from 'node:fs/promises';
import { connect } from 'node:tls';
import type { Context } from 'hono';

const env = (k: string) => process.env[k]?.trim() || undefined;
const base = (k: string) => env(k)?.replace(/\/+$/, '');

/** Caches one async value for `ms`; concurrent callers share the same request. */
function cached<T>(ms: number, load: () => Promise<T>) {
  let at = 0;
  let value: Promise<T> | null = null;
  return () => {
    if (!value || Date.now() - at > ms) {
      at = Date.now();
      value = load().catch((e) => {
        at = 0; // retry on the next call
        throw e;
      });
    }
    return value;
  };
}

const json = (c: Context, body: unknown) => {
  c.header('cache-control', 'no-store');
  return c.json(body);
};

async function getJson(url: string, headers: Record<string, string>, timeoutMs = 8_000) {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).pathname} → ${res.status}`);
  return res.json() as Promise<unknown>;
}

const errorOf = (e: unknown) => (e as Error).message;

// ---- GlitchTip ---------------------------------------------------------------------------------

export interface Issue {
  title: string;
  culprit?: string;
  count: number;
  lastSeen: number;
  level?: string;
  /** link to the issue in GlitchTip */
  url?: string;
}

export interface ProjectErrors {
  project: string;
  unresolved: number;
  events: number;
  /** epoch ms of the newest event across the project's unresolved issues */
  lastSeen: number;
  /** the newest few, for the inspector */
  issues: Issue[];
}

const ISSUES_PER_PROJECT = 5;

/** Issues (GlitchTip/Sentry shape) → one row per project slug. */
export function groupIssues(issues: unknown[]): ProjectErrors[] {
  const by = new Map<string, ProjectErrors>();
  for (const raw of issues) {
    const i = raw as { project?: { slug?: string }; count?: string | number; lastSeen?: string; title?: string; culprit?: string; level?: string; permalink?: string };
    const slug = i.project?.slug;
    if (!slug) continue;
    const row = by.get(slug) ?? { project: slug, unresolved: 0, events: 0, lastSeen: 0, issues: [] };
    const lastSeen = Date.parse(i.lastSeen ?? '') || 0;
    row.unresolved++;
    row.events += Number(i.count) || 0;
    row.lastSeen = Math.max(row.lastSeen, lastSeen);
    row.issues.push({
      title: String(i.title ?? 'Error').slice(0, 200),
      ...(i.culprit ? { culprit: String(i.culprit).slice(0, 120) } : {}),
      count: Number(i.count) || 0,
      lastSeen,
      ...(i.level ? { level: String(i.level).slice(0, 12) } : {}),
      ...(typeof i.permalink === 'string' && /^https?:\/\//.test(i.permalink) ? { url: i.permalink.slice(0, 300) } : {}),
    });
    by.set(slug, row);
  }
  for (const row of by.values()) row.issues = row.issues.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, ISSUES_PER_PROJECT);
  return [...by.values()];
}

export function glitchtip() {
  const url = base('GLITCHTIP_URL');
  const token = env('GLITCHTIP_TOKEN');
  const auth = { authorization: `Bearer ${token}` };
  const load = cached(30_000, async () => {
    const orgs = (await getJson(`${url}/api/0/organizations/`, auth)) as { slug: string }[];
    const issues: unknown[] = [];
    for (const org of orgs) {
      const page = await getJson(`${url}/api/0/organizations/${encodeURIComponent(org.slug)}/issues/?query=is:unresolved&limit=100`, auth);
      if (Array.isArray(page)) issues.push(...page);
    }
    return groupIssues(issues);
  });
  return async (c: Context) => {
    if (!url || !token) return json(c, { enabled: false, projects: [] });
    try {
      return json(c, { enabled: true, projects: await load() });
    } catch (e) {
      return json(c, { enabled: true, projects: [], error: `GlitchTip: ${errorOf(e)}` });
    }
  };
}

// ---- Umami -------------------------------------------------------------------------------------

/** Umami v2 answers `[{ x: n }]`, v3 `{ visitors: n }`. */
export function activeVisitors(body: unknown): number {
  if (Array.isArray(body)) return Number((body[0] as { x?: number })?.x) || 0;
  const b = body as { visitors?: number; x?: number } | null;
  return Number(b?.visitors ?? b?.x) || 0;
}

export function umami() {
  const url = base('UMAMI_URL');
  const key = env('UMAMI_API_KEY');
  // self-hosted Umami checks the key as a Bearer token; Umami Cloud reads x-umami-api-key
  const auth = { authorization: `Bearer ${key}`, 'x-umami-api-key': key ?? '' };
  const load = cached(15_000, async () => {
    const body = (await getJson(`${url}/api/websites?pageSize=200`, auth)) as { data?: { id: string; domain?: string }[] } | { id: string; domain?: string }[];
    const sites = Array.isArray(body) ? body : (body.data ?? []);
    return Promise.all(
      sites
        .filter((s) => s.domain)
        .map(async (s) => ({ domain: s.domain!, visitors: activeVisitors(await getJson(`${url}/api/websites/${s.id}/active`, auth).catch(() => null)) })),
    );
  });
  return async (c: Context) => {
    if (!url || !key) return json(c, { enabled: false, sites: [] });
    try {
      return json(c, { enabled: true, sites: await load() });
    } catch (e) {
      return json(c, { enabled: true, sites: [], error: `Umami: ${errorOf(e)}` });
    }
  };
}

// ---- CrowdSec ----------------------------------------------------------------------------------

/** Decisions from this server's own detections; CAPI / blocklists are thousands of community entries. */
const LOCAL = new Set(['crowdsec', 'cscli']);

/** Keeps "bans seen today" across polls (no database, so it restarts with the server). */
export class BanCounter {
  private seen = new Set<string>();
  private day = '';
  today = 0;
  lastAt = 0;

  update(decisions: { id?: number | string; type?: string; origin?: string }[], now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.today = 0;
    }
    const first = this.seen.size === 0;
    const ids = new Set<string>();
    for (const d of decisions) {
      if ((d.type && d.type !== 'ban') || (d.origin && !LOCAL.has(d.origin))) continue;
      const id = String(d.id ?? '');
      ids.add(id);
      if (!first && !this.seen.has(id)) {
        this.today++;
        this.lastAt = now;
      }
    }
    this.seen = ids;
    return { active: ids.size, today: this.today, lastAt: this.lastAt };
  }
}

export function crowdsec() {
  const url = base('CROWDSEC_URL');
  const key = env('CROWDSEC_BOUNCER_KEY');
  const counter = new BanCounter();
  const load = cached(10_000, async () => {
    const body = await getJson(`${url}/v1/decisions`, { 'x-api-key': key ?? '' });
    return counter.update(Array.isArray(body) ? body : []); // LAPI answers `null` when empty
  });
  return async (c: Context) => {
    if (!url || !key) return json(c, { enabled: false });
    try {
      return json(c, { enabled: true, ...(await load()) });
    } catch (e) {
      return json(c, { enabled: true, active: 0, today: counter.today, lastAt: counter.lastAt, error: `CrowdSec: ${errorOf(e)}` });
    }
  };
}

// ---- container logs ----------------------------------------------------------------------------

const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SECRETISH = /((?:pass(?:word)?|secret|token|api[-_]?key|cookie)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi;
const AUTH_HEADER = /(authorization["']?\s*[:=]\s*).*/gi; // the whole value: "Bearer <token>", "Basic <b64>"
const AUTH_SCHEME = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Docker's multiplexed log stream (8-byte frame headers, no TTY) or plain text → lines. */
export function demuxLogs(buf: Uint8Array): string[] {
  const out: string[] = [];
  let text = '';
  let i = 0;
  const framed = buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (framed) {
    while (i + 8 <= buf.length) {
      const len = (buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7];
      text += new TextDecoder().decode(buf.subarray(i + 8, i + 8 + len));
      i += 8 + len;
    }
  } else text = new TextDecoder().decode(buf);
  for (const line of text.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(AUTH_HEADER, '$1•••').replace(AUTH_SCHEME, '$1 •••').replace(SECRETISH, '$1•••').trimEnd();
    if (clean) out.push(clean.length > 300 ? `${clean.slice(0, 297)}…` : clean);
  }
  return out;
}

export function logs() {
  const url = base('DOCKER_PROXY_URL');
  return async (c: Context) => {
    if (!url) return json(c, { enabled: false, lines: [] });
    const name = c.req.query('container') ?? '';
    const tail = Math.min(100, Math.max(1, Number(c.req.query('tail')) || 40));
    if (!CONTAINER.test(name)) return json(c, { enabled: true, lines: [], error: 'Invalid container name.' });
    try {
      const res = await fetch(`${url}/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&timestamps=0&tail=${tail}`, {
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) return json(c, { enabled: true, lines: [], error: `Docker → ${res.status}` });
      return json(c, { enabled: true, lines: demuxLogs(new Uint8Array(await res.arrayBuffer())) });
    } catch (e) {
      return json(c, { enabled: true, lines: [], error: `Docker proxy: ${errorOf(e)}` });
    }
  };
}

// ---- container-to-container connections ---------------------------------------------------------

export interface Flow {
  from: string;
  /** container name, or "internet" for connections leaving the docker networks */
  to: string;
  port: number;
  conns: number;
}

/**
 * Connection counts by IP (from a conntrack sidecar) → by container name, using the IPs Docker
 * reports per container. Connections whose ends aren't containers are dropped, except the
 * outgoing ones, which are summed up as "internet".
 */
export function mapFlows(rows: { s: string; d: string; p: number; n: number }[], containers: { Names?: string[]; NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }[]): Flow[] {
  const byIp = new Map<string, string>();
  for (const c of containers) {
    const name = c.Names?.[0]?.replace(/^\//, '');
    if (!name) continue;
    for (const net of Object.values(c.NetworkSettings?.Networks ?? {})) if (net.IPAddress) byIp.set(net.IPAddress, name);
  }
  const out = new Map<string, Flow>();
  for (const r of rows) {
    const from = byIp.get(r.s);
    const to = r.d === 'internet' ? 'internet' : byIp.get(r.d);
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}:${r.p}`;
    const f = out.get(key) ?? { from, to, port: r.p, conns: 0 };
    f.conns += r.n;
    out.set(key, f);
  }
  return [...out.values()];
}

export function flows() {
  const file = env('FLOW_STATUS_FILE');
  const proxy = base('DOCKER_PROXY_URL');
  const load = cached(10_000, async () => {
    const rows = JSON.parse(await readFile(file!, 'utf8')) as { s: string; d: string; p: number; n: number }[];
    const containers = (await getJson(`${proxy}/containers/json`, {})) as Parameters<typeof mapFlows>[1];
    return mapFlows(rows, containers);
  });
  return async (c: Context) => {
    if (!file || !proxy) return json(c, { enabled: false, flows: [] });
    try {
      return json(c, { enabled: true, flows: await load() });
    } catch (e) {
      return json(c, { enabled: true, flows: [], error: `Flows: ${errorOf(e)}` });
    }
  };
}

// ---- Sablier (stop when idle, start on the next request) ----------------------------------------

export interface SablierContainer {
  name: string;
  group: string;
  running: boolean;
}

/** Containers labelled for Sablier (`sablier.enable=true`), running or not. */
export function mapSablier(containers: { Names?: string[]; State?: string; Labels?: Record<string, string> }[]): SablierContainer[] {
  return containers
    .map((c) => ({ name: c.Names?.[0]?.replace(/^\//, '') ?? '', group: c.Labels?.['sablier.group'] ?? 'default', running: c.State === 'running' }))
    .filter((c) => c.name);
}

export function sablier() {
  const proxy = base('DOCKER_PROXY_URL');
  const filters = encodeURIComponent(JSON.stringify({ label: ['sablier.enable=true'] }));
  const load = cached(10_000, async () => mapSablier((await getJson(`${proxy}/containers/json?all=1&filters=${filters}`, {})) as Parameters<typeof mapSablier>[0]));
  return async (c: Context) => {
    if (!proxy) return json(c, { enabled: false, containers: [] });
    try {
      return json(c, { enabled: true, containers: await load() });
    } catch (e) {
      return json(c, { enabled: true, containers: [], error: `Sablier: ${errorOf(e)}` });
    }
  };
}

// ---- backups -----------------------------------------------------------------------------------

export function backups() {
  const file = env('BACKUP_STATUS_FILE');
  return async (c: Context) => {
    if (!file) return json(c, { enabled: false, backups: [] });
    try {
      const rows = JSON.parse(await readFile(file, 'utf8')) as { name: string; newest: number; size: number; files: number }[];
      // newest is epoch seconds from `stat`; 0 = empty folder
      return json(c, { enabled: true, backups: rows.map((r) => ({ name: r.name, newest: r.newest * 1000, sizeMb: r.size >= 1e6 ? Math.round(r.size / 1e5) / 10 : Math.round(r.size / 1e3) / 1e3, files: r.files })) });
    } catch (e) {
      return json(c, { enabled: true, backups: [], error: `Backups: ${errorOf(e)}` });
    }
  };
}

// ---- TLS certificates --------------------------------------------------------------------------

const HOST = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

function certDays(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const s = connect({ host, port: 443, servername: host, timeout: 5_000, rejectUnauthorized: false }, () => {
      const valid = s.getPeerCertificate()?.valid_to;
      s.end();
      resolve(valid ? Math.floor((Date.parse(valid) - Date.now()) / 86_400_000) : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => {
      s.destroy();
      resolve(null);
    });
  });
}

export function certs() {
  const cache = new Map<string, { at: number; days: number | null }>();
  return async (c: Context) => {
    const hosts = [...new Set((c.req.query('hosts') ?? '').split(',').map((h) => h.trim().toLowerCase()))].filter((h) => HOST.test(h)).slice(0, 60);
    const out: Record<string, number | null> = {};
    await Promise.all(
      hosts.map(async (h) => {
        const hit = cache.get(h);
        if (hit && Date.now() - hit.at < 6 * 3_600_000) return (out[h] = hit.days);
        const days = await certDays(h);
        cache.set(h, { at: Date.now(), days });
        out[h] = days;
      }),
    );
    return json(c, { enabled: true, certs: out });
  };
}

// ---- host disk + memory ------------------------------------------------------------------------

/** /proc/meminfo → used fraction (MemTotal − MemAvailable). */
export function memUsed(meminfo: string): number | null {
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1]);
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  return total > 0 && avail >= 0 ? 1 - avail / total : null;
}

export function host() {
  return async (c: Context) => {
    // A container shares the host's kernel: /proc/meminfo and the overlay's file system are the host's.
    const [fs, mem] = await Promise.all([statfs('/').catch(() => null), readFile('/proc/meminfo', 'utf8').catch(() => '')]);
    const disk = fs && fs.blocks > 0 ? 1 - fs.bavail / fs.blocks : null;
    return json(c, { enabled: true, diskUsed: disk, diskGb: fs ? Math.round((fs.blocks * fs.bsize) / 1e9) : null, memUsed: memUsed(mem) });
  };
}
