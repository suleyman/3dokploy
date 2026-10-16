/**
 * 3Dokploy server: the read-only Dokploy relay (/relay/api/<procedure>) and, in production, the
 * built web app from ./dist. A plain Node.js process (Hono), no database, no sessions.
 *
 * By default it holds nothing: every user's Dokploy URL and API key stay in their own browser and
 * only pass through here per request. Self-hosters can pin a Dokploy (DOKPLOY_URL) and keep its
 * key on the server (DOKPLOY_API_KEY) so nobody has to log in; BASIC_AUTH then guards the page.
 *
 * Plain, erasable TypeScript so Node ≥ 22.6 runs it directly (`node server/index.ts` on Node 24).
 */
import './env.ts';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { PINNED_URL, SERVER_KEY, relay } from './relay.ts';

const PORT = Number(process.env.PORT ?? 3000);
const STATIC_DIR = process.env.STATIC_DIR ?? 'dist';
const AUTH = /^([^:]+):(.+)$/.exec(process.env.BASIC_AUTH ?? '');

// The API key may live in localStorage, so keep the page locked down: same-origin everything.
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
else if (SERVER_KEY) {
  console.warn('[3dokploy] DOKPLOY_API_KEY is set without BASIC_AUTH: anyone who can open this site sees your Dokploy (read-only).');
}

app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  if (!c.req.path.startsWith('/relay/')) c.header('content-security-policy', CSP);
});

/** What the browser needs to know about this server's setup (never the key itself). */
app.get('/config', (c) => {
  c.header('cache-control', 'no-store');
  return c.json({ dokploy: PINNED_URL ? { url: PINNED_URL, keyOnServer: !!SERVER_KEY } : null });
});

app.get('/relay/api/:procedure', relay);
app.all('/relay/*', (c) => c.json({ error: 'Not found' }, 404));

if (existsSync(STATIC_DIR)) {
  app.use('/*', serveStatic({ root: STATIC_DIR }));
  app.get('*', serveStatic({ path: `${STATIC_DIR}/index.html` })); // single page app
}

serve({ fetch: app.fetch, port: PORT }, () => {
  const ui = existsSync(STATIC_DIR) ? 'app + relay' : 'relay only (run "npm run build" to serve the app)';
  const mode = SERVER_KEY ? `pinned to ${PINNED_URL}, key on server` : PINNED_URL ? `pinned to ${PINNED_URL}` : 'open';
  console.log(`[3dokploy] ${ui} on http://localhost:${PORT} (${mode}${AUTH ? ', basic auth' : ''})`);
});
