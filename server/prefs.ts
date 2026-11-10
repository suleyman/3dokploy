/**
 * Map preferences shared by everyone who opens this 3Dokploy: building order, complexes (groups
 * of buildings) and colour presets. One small JSON file (PREFS_FILE, default /data/prefs.json);
 * mount a volume there to keep it across redeploys.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Context } from 'hono';

export interface Prefs {
  order: string[];
  groups: { id: string; name: string; projects: string[] }[];
  colors: Record<string, string>;
}

const MAX_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const empty = (): Prefs => ({ order: [], groups: [], colors: {} });

/** Keeps only well-formed entries; anything else is dropped, never echoed back. */
export function cleanPrefs(input: unknown): Prefs {
  const p = (input ?? {}) as Partial<Record<keyof Prefs, unknown>>;
  const ids = (xs: unknown) => (Array.isArray(xs) ? [...new Set(xs.filter((x): x is string => typeof x === 'string' && ID.test(x)))].slice(0, 500) : []);
  const groups = Array.isArray(p.groups)
    ? p.groups
        .map((g) => g as { id?: unknown; name?: unknown; projects?: unknown })
        .filter((g) => typeof g.id === 'string' && ID.test(g.id) && typeof g.name === 'string')
        .map((g) => ({ id: g.id as string, name: (g.name as string).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Complex', projects: ids(g.projects) }))
        .slice(0, 50)
    : [];
  // a project belongs to one complex at most: the first that lists it
  const taken = new Set<string>();
  for (const g of groups) g.projects = g.projects.filter((id) => !taken.has(id) && taken.add(id));
  const colors: Record<string, string> = {};
  if (p.colors && typeof p.colors === 'object') {
    for (const [k, v] of Object.entries(p.colors as Record<string, unknown>).slice(0, 500)) {
      if (ID.test(k) && typeof v === 'string' && /^[a-z]{2,20}$/.test(v)) colors[k] = v;
    }
  }
  return { order: ids(p.order), groups, colors };
}

export function prefs() {
  const file = process.env.PREFS_FILE?.trim() || '/data/prefs.json';
  let writing = Promise.resolve();

  const get = async (c: Context) => {
    c.header('cache-control', 'no-store');
    try {
      return c.json({ stored: true, prefs: cleanPrefs(JSON.parse(await readFile(file, 'utf8'))) });
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      return c.json({ stored: missing, prefs: empty(), ...(missing ? {} : { error: `Can't read ${file}` }) });
    }
  };

  const put = async (c: Context) => {
    const body = await c.req.text();
    if (body.length > MAX_BYTES) return c.json({ error: 'Too large.' }, 413);
    let next: Prefs;
    try {
      next = cleanPrefs(JSON.parse(body));
    } catch {
      return c.json({ error: 'Invalid JSON.' }, 400);
    }
    // one write at a time, atomically (write + rename), so a crash never leaves half a file
    writing = writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(next));
      await rename(`${file}.tmp`, file);
    });
    try {
      await writing;
      return c.json({ stored: true, prefs: next });
    } catch (e) {
      writing = Promise.resolve();
      return c.json({ stored: false, error: `Can't write ${file} (${(e as Error).message}). Mount a writable volume there.` }, 500);
    }
  };

  return { get, put };
}
