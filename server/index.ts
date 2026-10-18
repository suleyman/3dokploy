/**
 * 3Dokploy server: forwards the browser's read-only Dokploy calls (/api/<procedure>) with the API
 * key from its environment and, in production, serves the built web app from ./dist. A plain
 * Node.js process (Hono), no database, no sessions.
 *
 * Meant to run next to your own Dokploy (as a container on it, or on your machine) with
 * DOKPLOY_URL and DOKPLOY_API_KEY set; BASIC_AUTH guards the page when it is reachable by others.
 *
 * Plain, erasable TypeScript so Node ≥ 22.6 runs it directly (`node server/index.ts` on Node 24).
 */
import './env.ts';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { forward, loadTarget } from './dokploy.ts';

const PORT = Number(process.env.PORT ?? 3000);
const STATIC_DIR = process.env.STATIC_DIR ?? 'dist';
const AUTH = /^([^:]+):(.+)$/.exec(process.env.BASIC_AUTH ?? '');

let target: ReturnType<typeof loadTarget>;
try {
  target = loadTarget();
} catch (e) {
  console.error(`[3dokploy] ${(e as Error).message}`);
  process.exit(1);
}

// Same-origin everything: the page only ever talks to this server.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true }));

if (AUTH) app.use('*', basicAuth({ username: AUTH[1], password: AUTH[2], realm: '3Dokploy' }));

app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  if (!c.req.path.startsWith('/api/')) c.header('content-security-policy', CSP);
});

app.get('/api/:procedure', forward(target));
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

if (existsSync(STATIC_DIR)) {
  app.use('/*', serveStatic({ root: STATIC_DIR }));
  app.get('*', serveStatic({ path: `${STATIC_DIR}/index.html` })); // single page app
}

serve({ fetch: app.fetch, port: PORT }, () => {
  const ui = existsSync(STATIC_DIR) ? 'app + api' : 'api only (run "npm run build" to serve the app)';
  console.log(`[3dokploy] ${ui} on http://localhost:${PORT} → ${target.url}${AUTH ? ' (basic auth)' : ''}`);
  if (!AUTH) console.log('[3dokploy] No BASIC_AUTH: anyone who can open this address sees your Dokploy (read-only).');
});
