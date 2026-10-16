/** World → WorldPatch diffing (the Dokploy collector publishes only what changed). */
import { COLLECTIONS, type Collection, type World, type WorldPatch } from './types';

type Item = { id: string };
type Loose = Partial<Record<Collection, Item[]>> & { removed?: Partial<Record<Collection, string[]>> };

/** Upserts for every item that is new or changed, removals for every id that disappeared. */
export function diffWorld(prev: World | null, next: World): WorldPatch | null {
  const out: Loose = {};
  const removed: Partial<Record<Collection, string[]>> = {};
  for (const key of COLLECTIONS) {
    const nextItems = next[key] as Item[];
    const before = new Map((prev?.[key] as Item[] | undefined)?.map((x) => [x.id, JSON.stringify(x)]) ?? []);
    const upserts = nextItems.filter((x) => before.get(x.id) !== JSON.stringify(x));
    const ids = new Set(nextItems.map((x) => x.id));
    const gone = [...before.keys()].filter((id) => !ids.has(id));
    if (upserts.length) out[key] = upserts;
    if (gone.length) removed[key] = gone;
  }
  if (Object.keys(removed).length) out.removed = removed;
  return Object.keys(out).length ? (out as WorldPatch) : null;
}
