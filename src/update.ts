/**
 * Reloads the page after 3Dokploy itself was redeployed: polls /api/build and reloads once a
 * different build answered twice in a row, so the new version is really up (not mid-restart).
 * Failed polls (the server restarting) are ignored; one request per interval stays far below
 * anything a WAF counts.
 */
const EVERY_MS = 20_000;

async function currentBuild(): Promise<string | null> {
  try {
    const res = await fetch('/api/build', { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { build?: unknown };
    return typeof body.build === 'string' ? body.build : null;
  } catch {
    return null;
  }
}

/** `seen` is the new build answered last time (if any); returns what to do with the latest answer. */
export function decide(mine: string | null, seen: string | null, latest: string | null): { reload: boolean; seen: string | null } {
  if (!mine || !latest || latest === mine) return { reload: false, seen: null };
  return latest === seen ? { reload: true, seen } : { reload: false, seen: latest };
}

export async function watchForUpdates() {
  const mine = await currentBuild();
  if (!mine || mine === 'dev') return; // dev server: Vite reloads by itself
  let seen: string | null = null;
  setInterval(async () => {
    if (document.hidden) return; // checked again when the tab is visible
    const next = decide(mine, seen, await currentBuild());
    seen = next.seen;
    if (next.reload) location.reload();
  }, EVERY_MS);
}
