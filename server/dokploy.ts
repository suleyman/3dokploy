/**
 * The one Dokploy this server shows, from DOKPLOY_URL and DOKPLOY_API_KEY, and the handler that
 * forwards the browser's reads to it.
 *
 * Why it exists: Dokploy's API sends no CORS headers, and the API key must stay off the page.
 * So the browser calls /api/<procedure> here, and this calls the same procedure on Dokploy with
 * the key added.
 *
 * What it guarantees:
 *  - only an allowlist of read-only GET endpoints is forwarded: nothing can be changed through it
 *  - secrets in responses (env vars, passwords, tokens…) are removed before they reach the browser
 *  - the key never leaves this process
 */
import type { Context } from 'hono';

const TIMEOUT_MS = 25_000;

/** "dokploy.example.com/" → "https://dokploy.example.com"; a pasted API/Swagger URL loses its path. */
function normalizeUrl(raw: string) {
  const s = raw.trim();
  const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  const path = u.pathname.replace(/\/(api|swagger)(\/.*)?$/i, '').replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/** Reads the target from the environment, or explains what is missing. */
export function loadTarget(): { url: string; key: string } {
  const raw = process.env.DOKPLOY_URL?.trim();
  const key = process.env.DOKPLOY_API_KEY?.trim();
  const missing = [!raw && 'DOKPLOY_URL', !key && 'DOKPLOY_API_KEY'].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        'Put them in .env.local (see .env.example) or in the container environment.',
    );
  }
  try {
    return { url: normalizeUrl(raw!), key: key! };
  } catch {
    throw new Error(`DOKPLOY_URL is not a valid URL: ${raw}`);
  }
}

/** Everything 3Dokploy reads. Mutations are not on the list, so they can't pass. */
const READ_ONLY = new Set([
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

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!SECRET.test(k)) out[k] = redact(x);
    return out;
  }
  return v;
}

/** A network failure, in words that point at the fix. */
function describe(e: unknown, url: URL) {
  if ((e as Error).name === 'TimeoutError') return 'Dokploy did not answer in time.';
  const code = ((e as { cause?: { code?: string } }).cause?.code ?? '') as string;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Can't resolve ${url.hostname}. Check DOKPLOY_URL.`;
  if (code === 'ECONNREFUSED') return `${url.host} refused the connection. Check DOKPLOY_URL.`;
  if (code.startsWith('ERR_TLS') || code.includes('CERT')) return `TLS problem with ${url.host} (${code}).`;
  return `Can't reach ${url.host}${code ? ` (${code})` : ''}.`;
}

export function forward(target: { url: string; key: string }) {
  return async (c: Context) => {
    const procedure = c.req.param('procedure') ?? '';
    if (!READ_ONLY.has(procedure)) {
      return c.json({ error: `3Dokploy only reads from Dokploy; ${procedure || 'this'} is not an allowed endpoint.` }, 403);
    }
    const url = new URL(`${target.url}/api/${procedure}`);
    url.search = new URL(c.req.url).search;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'x-api-key': target.key, accept: 'application/json', 'user-agent': '3dokploy' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      return c.json({ error: describe(e, url) }, 502);
    }

    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location');
      return c.json({ error: `Dokploy redirected to ${to ?? 'another address'}. Set DOKPLOY_URL to that address.` }, 502);
    }
    if (res.status === 401 || res.status === 403) return c.json({ error: 'Dokploy rejected DOKPLOY_API_KEY.' }, 401);
    if (!res.headers.get('content-type')?.includes('json')) {
      return c.json({ error: `DOKPLOY_URL doesn't answer like a Dokploy API (HTTP ${res.status}).` }, 502);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return c.json({ error: 'Dokploy sent malformed JSON.' }, 502);
    }
    if (!res.ok) {
      const message = (data as { message?: string } | null)?.message;
      return c.json({ error: `Dokploy ${procedure} → ${res.status}${message ? `: ${message}` : ''}` }, 502);
    }
    c.header('cache-control', 'no-store');
    return c.json(redact(data));
  };
}
