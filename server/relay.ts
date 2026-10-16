/**
 * Stateless, read-only relay between the browser and a user's Dokploy.
 *
 * Why it exists: Dokploy's API sends no CORS headers, and a plain-http Dokploy can't be called
 * from an https page (mixed content). So the browser sends each request here with the Dokploy
 * URL and API key in headers, and this forwards it.
 *
 * What it guarantees:
 *  - nothing is stored or logged (no keys, no URLs, no bodies)
 *  - only an allowlist of read-only GET endpoints is forwarded: nothing can be changed through it
 *  - secrets in responses (env vars, passwords, tokens…) are removed before they reach the browser
 *  - SSRF guard: private / loopback / link-local targets are refused at connect time (after DNS,
 *    so rebinding doesn't help), redirects are not followed; ALLOW_PRIVATE_TARGETS=1 lifts this
 *    for self-hosted setups on a LAN
 *  - timeouts, a response size cap and a per-IP rate limit
 *
 * Self-hosted instances can pin the target with DOKPLOY_URL (the relay then talks to nothing
 * else, private addresses allowed for it) and optionally keep the key on the server with
 * DOKPLOY_API_KEY, in which case the browser never sees it.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

const ALLOW_PRIVATE = /^(1|true|yes)$/i.test(process.env.ALLOW_PRIVATE_TARGETS ?? '');

/** The Dokploy this server is pinned to (if any), normalised like the browser does it. */
export const PINNED_URL = pinned(process.env.DOKPLOY_URL);
export const SERVER_KEY = (PINNED_URL && process.env.DOKPLOY_API_KEY?.trim()) || null;

function pinned(raw: string | undefined) {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    console.error('[3dokploy] DOKPLOY_URL is not a valid URL; ignoring it.');
    return null;
  }
}
const RATE_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 1200);
const TIMEOUT_MS = 25_000;
const MAX_BYTES = 25 * 1024 * 1024;

/** Everything 3Dokploy reads. Mutations are not on the list, so they can't pass. */
export const READ_ONLY = new Set([
  'settings.getDokployVersion',
  'project.all',
  'project.one',
  'deployment.allCentralized',
  'deployment.all',
  'deployment.allByCompose',
  'deployment.readLogs',
  'swarm.getContainerStats',
  'swarm.getNodes',
  'swarm.getNodeInfo',
  'application.one',
  'compose.one',
  'postgres.one',
  'mysql.one',
  'mariadb.one',
  'mongo.one',
  'redis.one',
  'libsql.one',
]);

/** Field names that may hold secrets anywhere in a response. 3Dokploy never needs them. */
const SECRET = /password|secret|token|api[-_]?key|ssh[-_]?key|private[-_]?key|credential|certificate|env$|buildargs/i;

class RelayError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const BLOCKED =
  'This address is on a private network. The public relay only reaches internet-facing Dokploy instances; ' +
  'self-host 3Dokploy with ALLOW_PRIVATE_TARGETS=1 to reach private ones.';

// ---- SSRF guard -------------------------------------------------------------------------

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast, reserved, broadcast
    );
  }
  const v = ip.toLowerCase();
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(v);
  if (mapped) {
    if (mapped[1]) return isBlockedIp(mapped[1]);
    const hi = parseInt(mapped[2], 16);
    const lo = parseInt(mapped[3], 16);
    return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('64:ff9b:');
}

/** dns.lookup that refuses private answers. Used by the socket itself, so it checks what we connect to. */
const guardedLookup = (allowPrivate: boolean) =>
  ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    dns.lookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
      if (err) return callback(err);
      if (!allowPrivate && addresses.some((a) => isBlockedIp(a.address))) {
        return callback(Object.assign(new Error('blocked'), { code: 'EBLOCKED' }));
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  }) as unknown as net.LookupFunction;

interface Upstream {
  status: number;
  type: string;
  body: Buffer;
  location?: string;
}

function upstream(url: URL, key: string, allowPrivate: boolean): Promise<Upstream> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // IP literals skip DNS, so check them here.
  if (net.isIP(host) && !allowPrivate && isBlockedIp(host)) return Promise.reject(new RelayError(400, BLOCKED));
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: { 'x-api-key': key, accept: 'application/json', 'user-agent': '3dokploy-relay' },
        lookup: guardedLookup(allowPrivate),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) req.destroy(new RelayError(502, 'Dokploy answered with more data than the relay accepts.'));
          else chunks.push(c);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 502, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), location: res.headers.location }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new RelayError(504, 'Dokploy did not answer in time.')));
    req.on('error', reject);
    req.end();
  });
}

function describe(e: unknown, url: URL): RelayError {
  if (e instanceof RelayError) return e;
  const code = (e as { code?: string }).code;
  if (code === 'EBLOCKED') return new RelayError(400, BLOCKED);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new RelayError(502, `Can't resolve ${url.hostname}.`);
  if (code === 'ECONNREFUSED') return new RelayError(502, `${url.host} refused the connection.`);
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT') return new RelayError(502, `Connection to ${url.host} failed (${code}).`);
  if (code?.startsWith('ERR_TLS') || code?.includes('CERT')) return new RelayError(502, `TLS problem with ${url.host} (${code}).`);
  return new RelayError(502, `Can't reach ${url.host}.`);
}

// ---- secrets ------------------------------------------------------------------------------

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!SECRET.test(k)) out[k] = redact(x);
    return out;
  }
  return v;
}

// ---- rate limit -----------------------------------------------------------------------------

const hits = new Map<string, { n: number; since: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (now - h.since > 60_000) hits.delete(ip);
}, 60_000).unref();

function allowed(ip: string) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.since > 60_000) {
    hits.set(ip, { n: 1, since: now });
    return true;
  }
  return ++h.n <= RATE_PER_MIN;
}

function clientIp(c: Context) {
  // Behind a reverse proxy (Traefik, nginx) the right-most X-Forwarded-For entry is the one it added.
  const xff = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
  return xff || getConnInfo(c).remote.address || 'unknown';
}

// ---- handler ------------------------------------------------------------------------------

export async function relay(c: Context) {
  const procedure = c.req.param('procedure') ?? '';
  if (!READ_ONLY.has(procedure)) {
    return c.json({ error: `3Dokploy only relays read-only endpoints; ${procedure || 'this'} is not one of them.` }, 403);
  }
  if (!allowed(clientIp(c))) return c.json({ error: 'Too many requests to the relay. Slow down a little.' }, 429);

  // A pinned server only ever talks to its own Dokploy (whatever the browser sends), and may
  // hold the key itself.
  const rawUrl = PINNED_URL ?? c.req.header('x-dokploy-url');
  const key = c.req.header('x-dokploy-key') || SERVER_KEY;
  if (!rawUrl || !key) return c.json({ error: 'Missing Dokploy URL or API key.' }, 400);
  const allowPrivate = ALLOW_PRIVATE || !!PINNED_URL; // the operator chose that address

  let base: URL;
  try {
    base = new URL(rawUrl);
  } catch {
    return c.json({ error: 'That Dokploy URL is not valid.' }, 400);
  }
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) {
    return c.json({ error: 'Use an http(s) Dokploy URL without credentials in it.' }, 400);
  }
  const target = new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}/api/${procedure}`);
  target.search = new URL(c.req.url).search;

  let res: Upstream;
  try {
    res = await upstream(target, key, allowPrivate);
  } catch (e) {
    const err = describe(e, target);
    return c.json({ error: err.message }, err.status as 400);
  }

  if (res.status >= 300 && res.status < 400) {
    return c.json({ error: `Dokploy redirected to ${res.location ?? 'another address'}. Connect with that URL instead.` }, 502);
  }
  if (res.status === 401 || res.status === 403) return c.json({ error: 'Dokploy rejected the API key.' }, 401);
  if (!res.type.includes('json')) {
    return c.json({ error: `That URL doesn't answer like a Dokploy API (HTTP ${res.status}). Check the address.` }, 502);
  }

  let data: unknown;
  try {
    data = JSON.parse(res.body.toString('utf8'));
  } catch {
    return c.json({ error: 'Dokploy sent malformed JSON.' }, 502);
  }
  if (res.status >= 400) {
    const message = (data as { message?: string } | null)?.message;
    return c.json({ error: `Dokploy ${procedure} → ${res.status}${message ? `: ${message}` : ''}` }, 502);
  }
  c.header('cache-control', 'no-store');
  return c.json(redact(data));
}
