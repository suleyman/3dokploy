/**
 * App state: the world as the data source reports it, plus UI state.
 * There is no simulation here; the mock tick lives in MockSource (data/source.ts → data/sim.ts).
 *
 * Selector rule: select raw slices (records, primitives) and derive with useMemo in components.
 * Returning a fresh array/object from a selector re-renders forever (React error #185).
 */
import { create } from 'zustand';
import type { DataSource } from './data/source';
import {
  isActiveDeploy,
  type Alert,
  type Deployment,
  type Environment,
  type Project,
  type Server,
  type Service,
  type SourceCapabilities,
  type SourceStatus,
  type World,
  type WorldPatch,
} from './data/types';
import { duration } from './format';
import { computeLayout, structureKey, type Layout } from './layout';

export type MenuTab = 'activity' | 'deploys' | 'alerts' | 'services' | 'projects';
export type CameraCommand = { kind: 'zoomIn' | 'zoomOut' | 'reset' | 'pan'; n: number; dx?: number; dz?: number };
export type Focus = { kind: 'service' | 'project'; id: string; n: number };
export type Tone = 'ok' | 'info' | 'warn' | 'crit' | 'muted';

export type EventKind = 'deploy-start' | 'deploy-ok' | 'deploy-fail' | 'down' | 'up' | 'stopped' | 'started' | 'new-node' | 'cpu';

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

const NO_CAPABILITIES: SourceCapabilities = { metrics: false, deployments: false, actions: false, simulation: false, sampleSeconds: 1 };
const RETRY_MS = 5000;
const MAX_EVENTS = 80;
const TREND_LEN = 40;
const CPU_SPIKE = 0.85;
const RECENT_CART_MS = 2 * 60_000;

export interface State extends WorldSlice {
  /** Bumped every time a source is connected; the scene rebuilds per session. */
  session: number;
  ready: boolean;
  sourceKind: DataSource['kind'] | null;
  capabilities: SourceCapabilities;
  status: SourceStatus;
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
  /** Opens a header dropdown, or closes it when it's already open (null closes any). */
  toggleMenu(tab: MenuTab | null): void;
  cameraCommand(kind: CameraCommand['kind'], extra?: Pick<CameraCommand, 'dx' | 'dz'>): void;
  redeploy(serviceId: string): void;
  setRunning(serviceId: string, running: boolean): void;
  fetchLogs(deploymentId: string): Promise<string[]>;
  cartArrived(deploymentId: string): void;
  cartGone(deploymentId: string): void;
  techFixed(serviceId: string): void;
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

function withLayout(s: Pick<State, 'layoutKey' | 'layout'>, w: WorldSlice): Pick<State, 'layoutKey' | 'layout'> {
  const structure = {
    projects: Object.values(w.projects),
    environments: Object.values(w.environments),
    services: Object.values(w.services),
  };
  const key = structureKey(structure);
  return key === s.layoutKey ? { layoutKey: s.layoutKey, layout: s.layout } : { layoutKey: key, layout: computeLayout(structure) };
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
  sourceKind: null,
  capabilities: NO_CAPABILITIES,
  status: { state: 'connecting' },
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
      sourceKind: src.kind,
      capabilities: src.capabilities,
      status: { state: 'connecting' },
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
            ...withLayout({ layoutKey: '', layout: null }, slice),
            carts: src.capabilities.deployments ? world.deployments.filter(isActiveDeploy).map((d) => d.id) : [],
            events: seedEvents(slice),
            trends: sampleTrends({ at: [], cpu: [], mem: [], net: [] }, slice.services, 0),
            loadError: null,
            ready: true,
          });
          unsubscribe = src.subscribe(
            (patch) => set((s) => applyPatch(s, patch)),
            (status) => set({ status }),
          );
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

  redeploy(serviceId) {
    if (get().capabilities.actions) void source?.redeploy(serviceId);
  },
  setRunning(serviceId, running) {
    if (get().capabilities.actions) void source?.setRunning(serviceId, running);
  },
  fetchLogs(deploymentId) {
    return source?.logs ? source.logs(deploymentId) : Promise.resolve([]);
  },
  cartArrived(deploymentId) {
    source?.notify?.({ type: 'cart-arrived', deploymentId });
  },
  cartGone(deploymentId) {
    set((s) => ({ carts: s.carts.filter((id) => id !== deploymentId) }));
  },
  techFixed(serviceId) {
    source?.notify?.({ type: 'tech-fixed', serviceId });
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
  const fresh = s.capabilities.deployments
    ? (p.deployments ?? [])
        .filter((d) => !(d.id in s.deployments) && (isActiveDeploy(d) || now - (d.finishedAt ?? d.createdAt) < RECENT_CART_MS))
        .map((d) => d.id)
    : [];

  const out: Partial<State> = { ...slice, ...withLayout(s, slice) };
  if (fresh.length) out.carts = [...s.carts, ...fresh];
  if (s.selectedId && !(s.selectedId in slice.services)) out.selectedId = null;
  if (s.selectedProjectId && !(s.selectedProjectId in slice.projects)) out.selectedProjectId = null;
  if (s.hoveredId && !(s.hoveredId in slice.services)) out.hoveredId = null;

  const events = diffEvents(s, slice, p);
  if (events.length) out.events = [...events, ...s.events].slice(0, MAX_EVENTS);
  if (p.services?.length && s.capabilities.metrics) out.trends = sampleTrends(s.trends, slice.services, s.capabilities.sampleSeconds);
  return out;
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
      out.push(ev({ kind: 'new-node', at: now, tone: 'info', text: `New node ${svc.name}`, detail: where(svc.id), serviceId: svc.id }));
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
    // CPU spikes: once per crossing, at most once a minute per node.
    if (s.capabilities.metrics && svc.cpu >= CPU_SPIKE && prev.cpu < CPU_SPIKE && now - (spiking.get(svc.id) ?? 0) > 60_000) {
      spiking.set(svc.id, now);
      out.push(ev({ kind: 'cpu', at: now, tone: 'warn', text: `${svc.name} CPU ${Math.round(svc.cpu * 100)}%`, detail: where(svc.id), serviceId: svc.id }));
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
