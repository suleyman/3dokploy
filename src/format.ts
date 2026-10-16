export const pct = (v: number) => `${Math.round(v * 100)}%`;

export const mb = (v: number) => (v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`);

export const num = (v: number) => new Intl.NumberFormat('en-US').format(Math.round(v));

export function ago(ts: number | null | undefined, now: number) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** 148000 → "2m 28s" */
export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** bytes/s → "830 B/s", "12.4 kB/s", "3.1 MB/s" */
export function rate(bps: number) {
  if (bps < 1000) return `${Math.round(bps)} B/s`;
  if (bps < 1e6) return `${(bps / 1e3).toFixed(bps < 1e4 ? 1 : 0)} kB/s`;
  return `${(bps / 1e6).toFixed(1)} MB/s`;
}
