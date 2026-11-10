/**
 * Optional: Uptime Kuma monitor states, so the scene can show outages Docker can't see (a site
 * answering 502 while its container runs). Read from Kuma's Prometheus endpoint with an API key
 * (Settings → API Keys), only when KUMA_URL and KUMA_API_KEY are set. Always answers 200, so an
 * unconfigured Kuma never turns into a stream of errors.
 */
import type { Context } from 'hono';

const TTL_MS = 10_000;

export interface KumaMonitor {
  name: string;
  type: string;
  url?: string;
  /** 1 up, 0 down, 2 pending, 3 maintenance */
  status: number;
}

/** `monitor_status{monitor_name="x",monitor_url="https://…"} 1` lines → monitors. */
export function parseMetrics(text: string): KumaMonitor[] {
  const out: KumaMonitor[] = [];
  for (const line of text.split('\n')) {
    const m = /^monitor_status\{(.*)\}\s+(-?\d+(?:\.\d+)?)\s*$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const [, k, v] of m[1].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[k] = v.replace(/\\(.)/g, '$1');
    const url = labels.monitor_url && labels.monitor_url !== 'null' && labels.monitor_url !== 'https://' ? labels.monitor_url : undefined;
    out.push({ name: labels.monitor_name ?? '', type: labels.monitor_type ?? '', url, status: Number(m[2]) });
  }
  return out;
}

export function kuma() {
  const base = process.env.KUMA_URL?.replace(/\/+$/, '');
  const key = process.env.KUMA_API_KEY;
  let cache: { at: number; body: unknown } | null = null;

  return async (c: Context) => {
    c.header('cache-control', 'no-store');
    if (!base || !key) return c.json({ enabled: false, monitors: [] });
    if (cache && Date.now() - cache.at < TTL_MS) return c.json(cache.body);
    let body: unknown;
    try {
      const res = await fetch(`${base}/metrics`, {
        headers: { authorization: `Basic ${Buffer.from(`:${key}`).toString('base64')}` },
        signal: AbortSignal.timeout(8_000),
      });
      body = res.ok
        ? { enabled: true, monitors: parseMetrics(await res.text()) }
        : { enabled: true, monitors: [], error: `Kuma /metrics → ${res.status}${res.status === 401 ? ' (check KUMA_API_KEY)' : ''}` };
    } catch (e) {
      body = { enabled: true, monitors: [], error: `Can't reach Kuma at ${base} (${(e as Error).message})` };
    }
    cache = { at: Date.now(), body };
    return c.json(body);
  };
}
