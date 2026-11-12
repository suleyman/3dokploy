/**
 * App state: the world as the data source reports it, plus UI state.
 *
 * Selector rule: select raw slices (records, primitives) and derive with useMemo in components.
 * Returning a fresh array/object from a selector re-renders forever (React error #185).
 */
import { create } from 'zustand';
import { SAMPLE_SECONDS, type DataSource } from './data/source';
import {
  EMPTY_PREFS,
  isActiveDeploy,
  type MapPrefs,
  type Alert,
  type Deployment,
  type Environment,
  type Project,
  type Server,
  type Service,
  type SourceStatus,
  type World,
  type WorldPatch,
} from './data/types';
import { duration } from './format';
import { computeLayout, orderBuildings, structureKey, type Layout } from './layout';
import { presetHex } from './theme';
import { trouble } from './trouble';

export type MenuTab = 'activity' | 'deploys' | 'alerts' | 'services' | 'projects';
export type CameraCommand = { kind: 'zoomIn' | 'zoomOut' | 'reset' | 'pan'; n: number; dx?: number; dz?: number };
export type Focus = { kind: 'service' | 'project'; id: string; n: number };
export type Tone = 'ok' | 'info' | 'warn' | 'crit' | 'muted';

export type EventKind =
  | 'deploy-start'
  | 'deploy-ok'
  | 'deploy-fail'
  | 'down'
  | 'up'
  | 'stopped'
  | 'started'
  | 'new-node'
  | 'cpu'
  | 'fire'
  | 'error'
  | 'ban'
  | 'backup'
  | 'moved';

/** One line in the live activity feed, derived from what changed between two patches. */
export interface ActivityEvent {
  id: string;
  kind: EventKind;
  at: number;
  tone: Tone;
  text: string;
  detail?: string;
  serviceId?: string;
}

/** Cluster totals over time, one sample per metric tick (KPI sparklines). */
export interface Trends {
  at: number[];
  cpu: number[];
  mem: number[];
  net: number[];
}

type Rec<T> = Record<string, T>;

interface WorldSlice {
  servers: Rec<Server>;
  projects: Rec<Project>;
  environments: Rec<Environment>;
  services: Rec<Service>;
  deployments: Rec<Deployment>;
  alerts: Rec<Alert>;
}

const RETRY_MS = 5000;
const MAX_EVENTS = 80;
const TREND_LEN = 40;
const CPU_SPIKE = 0.85;
const RECENT_CART_MS = 2 * 60_000;

export interface State extends WorldSlice {
  /** Bumped every time a source is connected; the scene rebuilds per session. */
  session: number;
  ready: boolean;
  status: SourceStatus;
  /** Dokploy's version (header popover), once known. */
  version: string | null;
  /** Why the initial load failed (we keep retrying). */
  loadError: string | null;
  layout: Layout | null;
  layoutKey: string;
  /** Deployment ids that currently have a cart in the scene (UI-only lifecycle). */
  carts: string[];
  events: ActivityEvent[];
  trends: Trends;
  now: number;

  selectedId: string | null;
  /** Project in focus: set when a project is opened, or implied by the selected node. */
  selectedProjectId: string | null;
  /** Bumped on every focus request so the camera moves even when the target is unchanged. */
  focus: Focus | null;
  hoveredId: string | null;
  hoveredProjectId: string | null;
  search: string;
  heatmap: boolean;
  /** Header dropdown that is open, if any. */
  menu: MenuTab | null;
  /** Activity events newer than this are "unseen" (badge on the Live button). */
  seenEventsAt: number;
  camera: CameraCommand | null;
  reducedMotion: boolean;
  /** UI sounds off (remembered per browser). */
  muted: boolean;
  /** Wall-display mode: the camera tours buildings and stops at incidents. */
  tour: boolean;
  /** Tour: the moving figure (see scene/actors) the camera follows right now. */
  follow: string | null;
  /** Tour: what is on screen and why, shown as a caption. */
  tourCaption: { title: string; reason: string } | null;
  /** Building order, complexes and colour presets (shared through the server's /api/prefs). */
  prefs: MapPrefs;
  /** null while loading; false when the server can't store them (kept in this browser only). */
  prefsShared: boolean | null;
  /** Nodes being wheeled to another project's building (hidden at their new spot until they arrive). */
  moving: Rec<true>;
  /**
   * Racks on their way to another project: a ghost of each stays at its old place (in a ghost of
   * its building when the project was dissolved) until a mover has wheeled it to its new slot.
   */
  transit: Transit | null;

  connect(source: DataSource): () => void;
  select(id: string | null): void;
  focusProject(projectId: string): void;
  /** Esc: node → its project → overview. */
  back(): void;
  /** Re-run the camera move for whatever is selected. */
  frame(): void;
  clearSelection(): void;
  hover(id: string | null): void;
  hoverProject(id: string | null): void;
  setSearch(q: string): void;
  toggleHeatmap(): void;
  toggleMute(): void;
  toggleTour(): void;
  /** Tour: follow a moving figure (null stops), with a caption. */
  setTourShot(shot: { follow?: string | null; caption: State['tourCaption'] }): void;
  setProjectColor(projectId: string, preset: string | null): void;
  /** Swaps a building with its neighbour (-1 earlier, 1 later) inside its complex, or among the buildings without one. */
  moveProject(projectId: string, dir: -1 | 1): void;
  setProjectComplex(projectId: string, complexId: string | null): void;
  createComplex(name: string, projectId: string): void;
  renameComplex(complexId: string, name: string): void;
  removeComplex(complexId: string): void;
  setMoving(id: string, on: boolean): void;
  /** A mover loaded the ghost onto the hand truck. */
  pickUp(ghostId: string): void;
  /** A mover set the rack down at its new slot; the last one lets the map settle. */
  finishMove(ghostId: string): void;
  /** Opens a header dropdown, or closes it when it's already open (null closes any). */
  toggleMenu(tab: MenuTab | null): void;
  cameraCommand(kind: CameraCommand['kind'], extra?: Pick<CameraCommand, 'dx' | 'dz'>): void;
  fetchLogs(deploymentId: string): Promise<string[]>;
  fetchContainerLogs(container: string): Promise<{ enabled: boolean; lines: string[]; error?: string }>;
  cartGone(deploymentId: string): void;
}

let source: DataSource | null = null;
let eventSeq = 0;
const spiking = new Map<string, number>();

const byId = <T extends { id: string }>(xs: T[]): Rec<T> => Object.fromEntries(xs.map((x) => [x.id, x]));

function merge<T extends { id: string }>(rec: Rec<T>, upserts?: T[], removed?: string[]): Rec<T> {
  if (!upserts?.length && !removed?.length) return rec;
  const next = { ...rec };
  for (const x of upserts ?? []) next[x.id] = x;
  for (const id of removed ?? []) delete next[id];
  return next;
}

export interface Transit {
  ghosts: Service[];
  /** Ghosts of dissolved projects / removed environments, so the old building still stands. */
  projects: Project[];
  environments: Environment[];
  /** ghost id → the node at its new place */
  targets: Rec<string>;
  done: Rec<true>;
  startedAt: number;
}

/** Recently removed nodes by container name: a recreated service in another project is a move. */
const graveyard = new Map<string, { node: Service; project?: Project; env?: Environment; at: number }>();
const GRAVE_MS = 10 * 60_000;
const containerKey = (svc: Service) => (svc.container ? `c:${svc.container}` : null);

/**
 * Finds racks that changed project since the last patch: the same node id in another project, or
 * the same container name reappearing elsewhere (the service was recreated). Returns the transit
 * to add, or null.
 */
function detectMoves(s: State, slice: WorldSlice, p: WorldPatch): Transit | null {
  const now = Date.now();
  for (const [k, g] of graveyard) if (now - g.at > GRAVE_MS) graveyard.delete(k);
  const moves: { from: { node: Service; project?: Project; env?: Environment }; to: Service }[] = [];
  const byKey = new Map(Object.values(slice.services).flatMap((x) => (containerKey(x) ? [[containerKey(x)!, x] as const] : [])));

  for (const id of p.removed?.services ?? []) {
    const old = s.services[id];
    const key = old && containerKey(old);
    if (!old || !key) continue;
    const snap = { node: old, project: s.projects[old.projectId], env: s.environments[old.environmentId], at: now };
    const now_ = byKey.get(key);
    if (now_ && now_.projectId !== old.projectId && now_.id !== id) moves.push({ from: snap, to: now_ });
    else graveyard.set(key, snap);
  }
  for (const svc of p.services ?? []) {
    const prev = s.services[svc.id];
    const key = containerKey(svc);
    if (prev && prev.projectId !== svc.projectId) {
      moves.push({ from: { node: prev, project: s.projects[prev.projectId], env: s.environments[prev.environmentId] }, to: svc });
    } else if (key && (!prev || !containerKey(prev))) {
      const g = graveyard.get(key);
      if (g && g.node.projectId !== svc.projectId) moves.push({ from: g, to: svc });
      if (g) graveyard.delete(key);
    }
  }
  if (!moves.length) return null;

  const t: Transit = { ghosts: [], projects: [], environments: [], targets: {}, done: {}, startedAt: now };
  for (const { from, to } of moves) {
    if (moves.filter((m) => m.to.id === to.id).length > 1 && moves.find((m) => m.to.id === to.id)!.from !== from) continue;
    let projectId = from.node.projectId;
    let environmentId = from.node.environmentId;
    if (!slice.projects[projectId]) {
      // dissolved project: keep a ghost of its building until the last rack has left
      const gp = `ghostp:${projectId}`;
      if (!t.projects.some((x) => x.id === gp))
        t.projects.push({ ...(from.project ?? { color: '#5b6577', name: 'Project' }), id: gp, name: `${from.project?.name ?? 'Project'} (dissolved)` } as Project);
      projectId = gp;
    }
    if (!slice.environments[environmentId] || projectId !== from.node.projectId) {
      const ge = `ghoste:${environmentId}`;
      if (!t.environments.some((x) => x.id === ge)) t.environments.push({ ...(from.env ?? { name: 'production' }), id: ge, projectId } as Environment);
      environmentId = ge;
    }
    const ghost: Service = { ...from.node, id: `ghost:${from.node.id}`, projectId, environmentId, peerId: undefined };
    t.ghosts.push(ghost);
    t.targets[ghost.id] = to.id;
  }
  return t.ghosts.length ? t : null;
}

function mergeTransit(a: Transit | null, b: Transit): Transit {
  if (!a) return b;
  const fresh = b.ghosts.filter((g) => !a.ghosts.some((x) => x.id === g.id));
  return {
    ghosts: [...a.ghosts, ...fresh],
    projects: [...a.projects, ...b.projects.filter((x) => !a.projects.some((y) => y.id === x.id))],
    environments: [...a.environments, ...b.environments.filter((x) => !a.environments.some((y) => y.id === x.id))],
    targets: { ...a.targets, ...Object.fromEntries(fresh.map((g) => [g.id, b.targets[g.id]])) },
    done: a.done,
    startedAt: a.startedAt,
  };
}

function withLayout(
  s: Pick<State, 'layoutKey' | 'layout'> & { transit?: Transit | null },
  w: WorldSlice,
  prefs: MapPrefs,
  transit: Transit | null = s.transit ?? null,
): Pick<State, 'layoutKey' | 'layout'> {
  const structure = {
    projects: [...Object.values(w.projects), ...(transit?.projects ?? [])],
    environments: [...Object.values(w.environments), ...(transit?.environments ?? [])],
    services: [...Object.values(w.services), ...(transit?.ghosts ?? [])],
  };
  const key = structureKey(structure, prefs);
  return key === s.layoutKey ? { layoutKey: s.layoutKey, layout: s.layout } : { layoutKey: key, layout: computeLayout(structure, prefs) };
}

/** Each project's automatic colour, so "Auto" can restore it after a preset. */
const autoColor = new Map<string, string>();

/** Applies colour presets on top of the automatic colours. */
function paint(projects: Rec<Project>, prefs: MapPrefs, fresh: Project[] = []): Rec<Project> {
  for (const p of fresh) autoColor.set(p.id, p.color);
  const out: Rec<Project> = {};
  for (const [id, p] of Object.entries(projects)) {
    const color = presetHex(prefs.colors[id]) ?? autoColor.get(id) ?? p.color;
    out[id] = color === p.color ? p : { ...p, color };
  }
  return out;
}

const PREFS_KEY = '3dokploy:prefs';
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Server first (shared by every viewer), this browser's copy as fallback. */
async function loadPrefs(): Promise<{ prefs: MapPrefs; shared: boolean }> {
  try {
    const res = await fetch('/api/prefs', { headers: { accept: 'application/json' } });
    const body = (await res.json()) as { stored?: boolean; prefs?: MapPrefs; error?: string };
    if (res.ok && body.prefs && !body.error) return { prefs: body.prefs, shared: true };
  } catch {
    // offline, or a server without /api/prefs: fall through
  }
  try {
    const local = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as MapPrefs | null;
    if (local?.order && local.groups && local.colors) return { prefs: local, shared: false };
  } catch {
    // storage blocked
  }
  return { prefs: EMPTY_PREFS, shared: false };
}

function savePrefs(prefs: MapPrefs, done: (shared: boolean) => void) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // storage blocked
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/prefs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(prefs) })
      .then((r) => done(r.ok))
      .catch(() => done(false));
  }, 400);
}

const reducedMotionQuery = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

const MUTE_KEY = '3dokploy:muted';
function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export const useStore = create<State>()((set, get) => ({
  session: 0,
  servers: {},
  projects: {},
  environments: {},
  services: {},
  deployments: {},
  alerts: {},
  ready: false,
  status: { state: 'connecting' },
  version: null,
  loadError: null,
  layout: null,
  layoutKey: '',
  carts: [],
  events: [],
  trends: { at: [], cpu: [], mem: [], net: [] },
  now: Date.now(),

  selectedId: null,
  selectedProjectId: null,
  focus: null,
  hoveredId: null,
  hoveredProjectId: null,
  search: '',
  heatmap: false,
  tour: false,
  follow: null,
  tourCaption: null,
  prefs: EMPTY_PREFS,
  prefsShared: null,
  moving: {},
  transit: null,
  menu: null,
  seenEventsAt: Date.now(),
  camera: null,
  reducedMotion: reducedMotionQuery?.matches ?? false,
  muted: readMuted(),

  connect(src) {
    source = src;
    let cancelled = false;
    let unsubscribe = () => {};
    let retry: ReturnType<typeof setTimeout> | undefined;
    // A new source starts from nothing: no leftovers from the previous world.
    set((s) => ({
      session: s.session + 1,
      status: { state: 'connecting' },
      version: null,
      loadError: null,
      ready: false,
      servers: {},
      projects: {},
      environments: {},
      services: {},
      deployments: {},
      alerts: {},
      layout: null,
      layoutKey: '',
      carts: [],
      events: [],
      trends: { at: [], cpu: [], mem: [], net: [] },
      selectedId: null,
      selectedProjectId: null,
      hoveredId: null,
      hoveredProjectId: null,
      search: '',
      menu: null,
    }));

    void loadPrefs().then(({ prefs, shared }) => {
      if (cancelled) return;
      set((s) => ({ prefs, prefsShared: shared, projects: paint(s.projects, prefs), ...withLayout(s, s, prefs) }));
    });

    const load = () =>
      src.load().then(
        (world: World) => {
          if (cancelled) return;
          const slice: WorldSlice = {
            servers: byId(world.servers),
            projects: byId(world.projects),
            environments: byId(world.environments),
            services: byId(world.services),
            deployments: byId(world.deployments),
            alerts: byId(world.alerts),
          };
          set({
            ...slice,
            projects: paint(slice.projects, get().prefs, world.projects),
            ...withLayout({ layoutKey: '', layout: null }, slice, get().prefs),
            carts: world.deployments.filter(isActiveDeploy).map((d) => d.id),
            events: seedEvents(slice),
            trends: sampleTrends({ at: [], cpu: [], mem: [], net: [] }, slice.services, 0),
            loadError: null,
            ready: true,
          });
          unsubscribe = src.subscribe(
            (patch) => set((s) => applyPatch(s, patch)),
            (status) => set({ status }),
          );
          void src.version().then((version) => !cancelled && set({ version }));
        },
        (err: unknown) => {
          if (cancelled) return;
          set({ loadError: err instanceof Error ? err.message : String(err), status: { state: 'error' } });
          retry = setTimeout(load, RETRY_MS);
        },
      );
    load();

    const clock = setInterval(() => set({ now: Date.now() }), 1000);
    const onMotion = (e: MediaQueryListEvent) => set({ reducedMotion: e.matches });
    reducedMotionQuery?.addEventListener('change', onMotion);

    return () => {
      cancelled = true;
      clearTimeout(retry);
      unsubscribe();
      clearInterval(clock);
      reducedMotionQuery?.removeEventListener('change', onMotion);
    };
  },

  select(id) {
    const s = get();
    if (!id) return set({ selectedId: null });
    const projectId = s.services[id]?.projectId ?? s.selectedProjectId;
    set({ selectedId: id, selectedProjectId: projectId, focus: { kind: 'service', id, n: (s.focus?.n ?? 0) + 1 } });
  },
  focusProject(projectId) {
    const prev = get().focus;
    set({ selectedId: null, selectedProjectId: projectId, focus: { kind: 'project', id: projectId, n: (prev?.n ?? 0) + 1 } });
  },
  back() {
    const s = get();
    if (s.selectedId && s.selectedProjectId) s.focusProject(s.selectedProjectId);
    else if (s.selectedId || s.selectedProjectId) {
      set({ selectedId: null, selectedProjectId: null });
      s.cameraCommand('reset');
    }
  },
  frame() {
    const s = get();
    if (s.selectedId) s.select(s.selectedId);
    else if (s.selectedProjectId) s.focusProject(s.selectedProjectId);
    else s.cameraCommand('reset');
  },
  clearSelection() {
    set({ selectedId: null, selectedProjectId: null });
  },
  hover(id) {
    if (get().hoveredId !== id) set({ hoveredId: id });
  },
  hoverProject(id) {
    if (get().hoveredProjectId !== id) set({ hoveredProjectId: id });
  },
  setSearch(search) {
    set({ search });
  },
  toggleHeatmap() {
    set((s) => ({ heatmap: !s.heatmap }));
  },
  toggleTour() {
    set((s) => ({ tour: !s.tour, follow: null, tourCaption: null, hoveredId: s.tour ? null : s.hoveredId }));
  },
  setTourShot({ follow = null, caption }) {
    set({ follow, tourCaption: caption });
  },
  setProjectColor(projectId, preset) {
    updatePrefs((p) => {
      const colors = { ...p.colors };
      if (preset) colors[projectId] = preset;
      else delete colors[projectId];
      return { ...p, colors };
    });
  },
  moveProject(projectId, dir) {
    updatePrefs((p, s) => {
      const segments = orderBuildings(Object.values(s.projects), p);
      const seg = segments.find((x) => x.projects.some((q) => q.id === projectId));
      if (!seg) return p;
      const ids = seg.projects.map((q) => q.id);
      const i = ids.indexOf(projectId);
      const j = i + dir;
      if (j < 0 || j >= ids.length) return p;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      // the whole display order, with this segment's new order in place
      return { ...p, order: segments.flatMap((x) => (x === seg ? ids : x.projects.map((q) => q.id))) };
    });
  },
  setProjectComplex(projectId, complexId) {
    updatePrefs((p) => ({
      ...p,
      groups: p.groups
        .map((g) => ({ ...g, projects: g.id === complexId ? [...g.projects.filter((id) => id !== projectId), projectId] : g.projects.filter((id) => id !== projectId) }))
        .filter((g) => g.projects.length),
    }));
  },
  createComplex(name, projectId) {
    const id = 'c' + Date.now().toString(36);
    updatePrefs((p) => ({
      ...p,
      groups: [
        ...p.groups.map((g) => ({ ...g, projects: g.projects.filter((x) => x !== projectId) })).filter((g) => g.projects.length),
        { id, name: name.trim().slice(0, 40) || 'Complex', projects: [projectId] },
      ],
    }));
  },
  renameComplex(complexId, name) {
    updatePrefs((p) => ({ ...p, groups: p.groups.map((g) => (g.id === complexId ? { ...g, name: name.trim().slice(0, 40) || g.name } : g)) }));
  },
  removeComplex(complexId) {
    updatePrefs((p) => ({ ...p, groups: p.groups.filter((g) => g.id !== complexId) }));
  },
  pickUp(ghostId) {
    set((s) => ({ moving: { ...s.moving, [ghostId]: true } }));
  },
  finishMove(ghostId) {
    set((s) => {
      const t = s.transit;
      if (!t || t.done[ghostId]) return {};
      const moving = { ...s.moving };
      delete moving[t.targets[ghostId]];
      const done = { ...t.done, [ghostId]: true as const };
      if (Object.keys(done).length < t.ghosts.length) return { moving, transit: { ...t, done } };
      // everyone has arrived: drop the ghosts and let the map settle in one step
      for (const g of t.ghosts) delete moving[g.id];
      return { moving, transit: null, ...withLayout(s, s, s.prefs, null) };
    });
  },
  setMoving(id, on) {
    set((s) => {
      const moving = { ...s.moving };
      if (on) moving[id] = true;
      else delete moving[id];
      return { moving };
    });
  },
  toggleMute() {
    const muted = !get().muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      // private mode / blocked storage: the toggle still works for this session
    }
    set({ muted });
  },
  toggleMenu(tab) {
    const open = tab && get().menu !== tab ? tab : null;
    set(open === 'activity' || get().menu === 'activity' ? { menu: open, seenEventsAt: Date.now() } : { menu: open });
  },
  cameraCommand(kind, extra) {
    set((s) => ({ camera: { kind, n: (s.camera?.n ?? 0) + 1, ...extra } }));
  },

  fetchLogs(deploymentId) {
    return source ? source.logs(deploymentId) : Promise.resolve([]);
  },
  fetchContainerLogs(container) {
    return source?.containerLogs ? source.containerLogs(container) : Promise.resolve({ enabled: false, lines: [] });
  },
  cartGone(deploymentId) {
    set((s) => ({ carts: s.carts.filter((id) => id !== deploymentId) }));
  },
}));

function applyPatch(s: State, p: WorldPatch): Partial<State> {
  const rm = p.removed ?? {};
  const slice: WorldSlice = {
    servers: merge(s.servers, p.servers, rm.servers),
    projects: merge(s.projects, p.projects, rm.projects),
    environments: merge(s.environments, p.environments, rm.environments),
    services: merge(s.services, p.services, rm.services),
    deployments: merge(s.deployments, p.deployments, rm.deployments),
    alerts: merge(s.alerts, p.alerts, rm.alerts),
  };

  // A deployment we have never seen before gets a cart: in flight, or so recently finished that
  // it slipped between two polls (fast deploys). The latter just drive in, drop off and leave.
  const now = Date.now();
  const fresh = (p.deployments ?? [])
    .filter((d) => !(d.id in s.deployments) && (isActiveDeploy(d) || now - (d.finishedAt ?? d.createdAt) < RECENT_CART_MS))
    .map((d) => d.id);

  const moved = s.ready ? detectMoves(s, slice, p) : null;
  const transit = moved ? mergeTransit(s.transit, moved) : s.transit;
  const out: Partial<State> = { ...slice, projects: paint(slice.projects, s.prefs, p.projects), ...withLayout(s, slice, s.prefs, transit) };
  if (moved) {
    out.transit = transit;
    out.moving = { ...s.moving, ...Object.fromEntries(Object.values(moved.targets).map((id) => [id, true as const])) };
  }
  if (fresh.length) out.carts = [...s.carts, ...fresh];
  if (s.selectedId && !(s.selectedId in slice.services)) out.selectedId = null;
  if (s.selectedProjectId && !(s.selectedProjectId in slice.projects)) out.selectedProjectId = null;
  if (s.hoveredId && !(s.hoveredId in slice.services)) out.hoveredId = null;

  let events = diffEvents(s, slice, p);
  if (moved) {
    // a recreated service is not news, its move is
    const targets = new Set(Object.values(moved.targets));
    const where = (id: string) => slice.projects[slice.services[id]?.projectId ?? '']?.name ?? 'another project';
    events = events.filter((e) => !(e.kind === 'new-node' && e.serviceId && targets.has(e.serviceId)));
    out.events = s.events.filter((e) => !(e.kind === 'new-node' && e.serviceId && targets.has(e.serviceId))); // announced too early
    for (const id of targets)
      if (!events.some((e) => e.kind === 'moved' && e.serviceId === id))
        events.unshift(ev({ kind: 'moved', at: Date.now(), tone: 'info', text: `${slice.services[id]?.name ?? 'Rack'} moves`, detail: `to ${where(id)}`, serviceId: id }));
  }
  if (events.length || out.events) out.events = [...events, ...(out.events ?? s.events)].slice(0, MAX_EVENTS);
  if (p.services?.length) out.trends = sampleTrends(s.trends, slice.services, SAMPLE_SECONDS);
  return out;
}

/** Changes the map preferences: re-lays out and repaints at once, then saves (debounced). */
function updatePrefs(change: (p: MapPrefs, s: State) => MapPrefs) {
  const s = useStore.getState();
  const prefs = change(s.prefs, s);
  if (prefs === s.prefs) return;
  useStore.setState({ prefs, projects: paint(s.projects, prefs), ...withLayout(s, s, prefs) });
  savePrefs(prefs, (shared) => useStore.setState({ prefsShared: shared }));
}

// ---- activity feed + trends -----------------------------------------------------------

const ev = (e: Omit<ActivityEvent, 'id'>): ActivityEvent => ({ ...e, id: `ev-${++eventSeq}` });
const firstLine = (s?: string) => s?.split('\n')[0];

/** Turn "what changed" into human sentences. Removed items are ignored on purpose. */
function diffEvents(s: State, next: WorldSlice, p: WorldPatch): ActivityEvent[] {
  const now = Date.now();
  const out: ActivityEvent[] = [];
  const name = (id: string) => next.services[id]?.name ?? s.services[id]?.name ?? 'node';
  const where = (id: string) => next.projects[next.services[id]?.projectId ?? '']?.name;

  for (const d of p.deployments ?? []) {
    const prev = s.deployments[d.id];
    const who = name(d.serviceId);
    const done = d.status === 'success' || d.status === 'failed';
    if (!prev && isActiveDeploy(d)) {
      out.push(ev({ kind: 'deploy-start', at: now, tone: 'info', text: `${who} deploy started`, detail: firstLine(d.commit?.message) ?? where(d.serviceId), serviceId: d.serviceId }));
    } else if (done && (prev ? prev.status !== d.status : now - (d.finishedAt ?? d.createdAt) < RECENT_CART_MS)) {
      // Also reports deploys we only ever saw finished (they were faster than a poll).
      const took = d.finishedAt && (d.startedAt ?? d.createdAt) ? duration(d.finishedAt - (d.startedAt ?? d.createdAt)) : undefined;
      out.push(
        d.status === 'success'
          ? ev({ kind: 'deploy-ok', at: now, tone: 'ok', text: `${who} deployed`, detail: took ? `in ${took}` : undefined, serviceId: d.serviceId })
          : ev({ kind: 'deploy-fail', at: now, tone: 'crit', text: `${who} deploy failed`, detail: d.log.at(-1), serviceId: d.serviceId }),
      );
    }
  }

  for (const svc of p.services ?? []) {
    const prev = s.services[svc.id];
    if (!prev) {
      // Container nodes (`<service>::<container>`) appear once stats arrive; not news. Neither is a
      // service named like a container that just disappeared: that's a move about to be matched.
      if (!svc.id.includes('::') && !graveyard.has(`c:${svc.name}`)) out.push(ev({ kind: 'new-node', at: now, tone: 'info', text: `New node ${svc.name}`, detail: where(svc.id), serviceId: svc.id }));
      continue;
    }
    if (prev.status !== svc.status) {
      const t =
        svc.status === 'error'
          ? { kind: 'down' as const, tone: 'crit' as const, text: `${svc.name} is down` }
          : prev.status === 'error' && svc.status === 'running'
            ? { kind: 'up' as const, tone: 'ok' as const, text: `${svc.name} recovered` }
            : svc.status === 'idle'
              ? { kind: 'stopped' as const, tone: 'muted' as const, text: `${svc.name} stopped` }
              : prev.status === 'idle' && svc.status === 'running'
                ? { kind: 'started' as const, tone: 'ok' as const, text: `${svc.name} started` }
                : null;
      if (t) out.push(ev({ at: now, ...t, detail: where(svc.id), serviceId: svc.id }));
    }
    if (trouble(svc) === 'fire' && trouble(prev) !== 'fire' && svc.status !== 'error')
      out.push(ev({ kind: 'fire', at: now, tone: 'crit', text: `${svc.name} is overloaded`, detail: where(svc.id), serviceId: svc.id }));
    if ((svc.errorAt ?? 0) > (prev.errorAt ?? 0) && prev.errorAt !== undefined)
      out.push(ev({ kind: 'error', at: now, tone: 'warn', text: `New error in ${svc.name}`, detail: `${svc.errors ?? 0} unresolved in GlitchTip`, serviceId: svc.id }));
    if (svc.projectId !== prev.projectId)
      out.push(ev({ kind: 'moved', at: now, tone: 'info', text: `${svc.name} moved`, detail: `to ${where(svc.id) ?? 'another project'}`, serviceId: svc.id }));
    // CPU spikes: once per crossing, at most once a minute per node.
    if (svc.cpu >= CPU_SPIKE && prev.cpu < CPU_SPIKE && now - (spiking.get(svc.id) ?? 0) > 60_000) {
      spiking.set(svc.id, now);
      out.push(ev({ kind: 'cpu', at: now, tone: 'warn', text: `${svc.name} CPU ${Math.round(svc.cpu * 100)}%`, detail: where(svc.id), serviceId: svc.id }));
    }
  }
  for (const sv of p.servers ?? []) {
    const prev = s.servers[sv.id];
    if (!prev) continue;
    if ((sv.banAt ?? 0) > (prev.banAt ?? 0))
      out.push(ev({ kind: 'ban', at: now, tone: 'muted', text: 'CrowdSec blocked an attacker', detail: `${sv.bansToday ?? 0} today · ${sv.bansActive ?? 0} active` }));
    const before = new Map((prev.backups ?? []).map((b) => [b.name, b.newest]));
    for (const b of sv.backups ?? []) {
      if (b.newest > (before.get(b.name) ?? Infinity))
        out.push(ev({ kind: 'backup', at: now, tone: 'ok', text: `Backup ${b.name} written`, detail: `${b.sizeMb} MB`, serviceId: b.nodeId }));
    }
  }
  return out;
}

/** Start the feed with recent history so it isn't empty on load. */
function seedEvents(w: WorldSlice): ActivityEvent[] {
  return Object.values(w.deployments)
    .filter((d) => !isActiveDeploy(d))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 12)
    .map((d) => {
      const who = w.services[d.serviceId]?.name ?? 'node';
      const at = d.finishedAt ?? d.createdAt;
      return d.status === 'success'
        ? ev({ kind: 'deploy-ok', at, tone: 'ok', text: `${who} deployed`, detail: firstLine(d.commit?.message), serviceId: d.serviceId })
        : ev({ kind: 'deploy-fail', at, tone: 'crit', text: `${who} deploy failed`, detail: d.log.at(-1) ?? firstLine(d.commit?.message), serviceId: d.serviceId });
    });
}

function sampleTrends(t: Trends, services: Rec<Service>, sampleSeconds: number): Trends {
  const now = Date.now();
  if (t.at.length && now - t.at[t.at.length - 1] < sampleSeconds * 800) return t;
  const all = Object.values(services);
  const push = (xs: number[], v: number) => [...xs.slice(-(TREND_LEN - 1)), v];
  return {
    at: push(t.at, now),
    cpu: push(t.cpu, all.reduce((a, x) => a + x.cpu, 0)),
    mem: push(t.mem, all.reduce((a, x) => a + x.memMb, 0)),
    net: push(t.net, all.reduce((a, x) => a + (x.net ? x.net.rxBps + x.net.txBps : 0), 0)),
  };
}

// ---- shared derivations (call inside useMemo) ------------------------------------

export function matchesSearch(svc: Service, project: Project | undefined, q: string, env?: Environment) {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  return [svc.name, svc.domain, svc.kind, svc.appName, project?.name, env?.name].some((v) => v?.toLowerCase().includes(needle));
}

export function latestDeploys(deployments: Rec<Deployment>, serviceId: string, n: number) {
  return Object.values(deployments)
    .filter((d) => d.serviceId === serviceId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, n);
}

export const activeDeployFor = (deployments: Rec<Deployment>, serviceId: string) =>
  Object.values(deployments).find((d) => d.serviceId === serviceId && isActiveDeploy(d));
