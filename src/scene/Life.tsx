/**
 * Everything around the racks that makes the map feel inhabited:
 *
 *   <Visitors>  real people on the sites (Umami) walk in through the gate to their app's rack
 *   <Vault>     the backup vault; a truck drives each new dump there, stale backups glow red
 *   <Movers>    a service moved to another project is wheeled over on a hand truck
 *   <Sky>       day and night from the local clock
 *   <Tour>      wall-display mode: the camera visits buildings and stops at incidents
 */
import { useFrame, useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { isDb, type Backup } from '../data/types';
import { RACK, routeBetween, routeFromGate, routeFromHome, routeHome, routeToVault, type Layout, type V3 } from '../layout';
import { useStore } from '../store';
import { ACCENT, BG, NEON } from '../theme';
import { Label } from './Label';
import { TechModel, Walker, dampAngle } from './Agents';

// ---- visitors ------------------------------------------------------------------------

const VISITOR_CAP = 48;
const PER_SITE = 6;
const WALK = 1.7;

interface Walk {
  path: THREE.Vector3[];
  len: number[];
  d: number;
}

function walkOf(points: V3[]): Walk {
  const path = points.map((p) => new THREE.Vector3(...p));
  const len = [0];
  for (let i = 1; i < path.length; i++) len.push(len[i - 1] + path[i].distanceTo(path[i - 1]));
  return { path, len, d: 0 };
}

function pointAt(w: Walk, d: number, out: THREE.Vector3) {
  let i = 1;
  while (i < w.len.length - 1 && w.len[i] < d) i++;
  const seg = w.len[i] - w.len[i - 1] || 1;
  return out.lerpVectors(w.path[i - 1], w.path[i], Math.min(1, Math.max(0, (d - w.len[i - 1]) / seg)));
}

/** One small figure per active visitor (capped), walking gate → their site's rack, then again. */
export function Visitors({ layout }: { layout: Layout }) {
  const services = useStore((s) => s.services);
  const still = useStore((s) => s.reducedMotion);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const walkers = useRef<{ id: string; w: Walk; delay: number }[]>([]);
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), m: new THREE.Matrix4() }), []);

  // "id:count" pairs: only re-plan walkers when the crowd changes, not on every stats tick.
  const crowd = Object.values(services)
    .filter((s) => s.visitors && layout.slots[s.id])
    .map((s) => `${s.id}:${Math.min(PER_SITE, s.visitors!)}`)
    .join('|');

  useEffect(() => {
    const next: typeof walkers.current = [];
    for (const pair of crowd ? crowd.split('|') : []) {
      const [id, n] = pair.split(':');
      const route = routeFromGate(layout, id);
      if (!route) continue;
      for (let k = 0; k < Number(n) && next.length < VISITOR_CAP; k++) {
        const w = walkOf([...route.map(([x, , z]) => [x + (Math.random() - 0.5) * 0.5, 0, z] as V3)]);
        w.d = Math.random() * w.len[w.len.length - 1]; // spread along the way
        next.push({ id, w, delay: 0 });
      }
    }
    walkers.current = next;
  }, [crowd, layout]);

  useFrame((_, rawDt) => {
    const m = mesh.current;
    if (!m) return;
    const dt = Math.min(rawDt, 0.1);
    let n = 0;
    for (const v of walkers.current) {
      if (v.delay > 0) {
        v.delay -= dt;
        continue;
      }
      if (!still) v.w.d += WALK * dt;
      const total = v.w.len[v.w.len.length - 1];
      if (v.w.d >= total) {
        v.w.d = 0;
        v.delay = 1 + Math.random() * 3; // reached the rack: the next one comes in a moment
        continue;
      }
      pointAt(v.w, v.w.d, tmp.v);
      tmp.m.makeTranslation(tmp.v.x, 0.22 + (still ? 0 : Math.abs(Math.sin(v.w.d * 6)) * 0.03), tmp.v.z);
      m.setMatrixAt(n++, tmp.m);
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, VISITOR_CAP]} frustumCulled={false}>
      <capsuleGeometry args={[0.07, 0.22, 4, 8]} />
      <meshStandardMaterial color="#f4f1ea" emissive="#fff4d6" emissiveIntensity={0.6} roughness={0.6} />
    </instancedMesh>
  );
}

// ---- backup vault and trucks ------------------------------------------------------------

const STALE_MS = 26 * 3_600_000;
const TRUCK_SPEED = 3;

/** The vault building and one truck per newly written dump. */
export function Vault({ layout }: { layout: Layout }) {
  const backups = useStore((s) => s.servers.local?.backups);
  const now = useStore((s) => s.now);
  const [trucks, setTrucks] = useState<{ key: string; route: V3[] }[]>([]);
  const seen = useRef<Map<string, number> | null>(null);

  useEffect(() => {
    if (!backups) return;
    const before = seen.current;
    seen.current = new Map(backups.map((b) => [b.name, b.newest]));
    if (!before) return; // first sight: no trucks for old dumps
    const fresh = backups.filter((b) => b.newest > (before.get(b.name) ?? Infinity) && b.nodeId);
    const routes = fresh.map((b) => ({ key: `${b.name}:${b.newest}`, route: routeToVault(layout, b.nodeId!) })).filter((t): t is { key: string; route: V3[] } => !!t.route);
    if (routes.length) setTrucks((t) => [...t, ...routes]);
  }, [backups, layout]);

  if (!backups) return null;
  const stale = backups.filter((b) => now - b.newest > STALE_MS);
  const [x, , z] = layout.vault;
  return (
    <>
      <group position={[x, 0, z]}>
        <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
          <boxGeometry args={[1.8, 1.1, 1.3]} />
          <meshStandardMaterial color="#0c1626" metalness={0.7} roughness={0.35} emissive={stale.length ? '#ff2e55' : NEON} emissiveIntensity={stale.length ? 0.35 : 0.08} />
        </mesh>
        <mesh position={[0.91, 0.45, 0]}>
          <boxGeometry args={[0.02, 0.7, 0.6]} />
          <meshBasicMaterial color={stale.length ? '#ff5470' : '#2bff9a'} toneMapped={false} />
        </mesh>
        {/* anchored right: the panel opens away from the buildings */}
        <Label position={[-1, 1.2, 0]} anchor="right" zIndex={4}>
          <VaultPanel backups={backups} now={now} />
        </Label>
      </group>
      {trucks.map((t) => (
        <Truck key={t.key} route={t.route} onDone={() => setTrucks((all) => all.filter((x) => x.key !== t.key))} />
      ))}
    </>
  );
}

const age = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`);

const size = (mb: number) => (mb >= 1 ? `${mb} MB` : `${Math.max(1, Math.round(mb * 1000))} KB`);

function VaultPanel({ backups, now }: { backups: Backup[]; now: number }) {
  return (
    <div className="vault-panel">
      <strong>Backups</strong>
      {backups.map((b) => (
        <span key={b.name} className={!b.newest || now - b.newest > STALE_MS ? 'is-stale' : ''}>
          {b.name.replace(/-backup(-\d+)?$/, '')} · {b.newest ? `${age(now - b.newest)} ago · ${size(b.sizeMb)}` : 'none yet'}
        </span>
      ))}
    </div>
  );
}

const Truck = memo(function Truck({ route, onDone }: { route: V3[]; onDone: () => void }) {
  const g = useRef<THREE.Group>(null);
  const walker = useMemo(() => new Walker(route), [route]);
  const done = useRef(false);
  useFrame((_, rawDt) => {
    if (!g.current || done.current) return;
    if (walker.step(TRUCK_SPEED * Math.min(rawDt, 0.1))) {
      done.current = true;
      onDone();
    }
    g.current.position.copy(walker.pos);
    g.current.rotation.y = dampAngle(g.current.rotation.y, walker.heading, 8, Math.min(rawDt, 0.1));
  });
  return (
    <group ref={g}>
      <mesh position={[0, 0.2, 0.12]} castShadow>
        <boxGeometry args={[0.36, 0.3, 0.5]} />
        <meshStandardMaterial color="#e8eef8" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.17, -0.25]} castShadow>
        <boxGeometry args={[0.34, 0.24, 0.22]} />
        <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={0.5} />
      </mesh>
      <mesh position={[0, 0.36, 0.12]}>
        <boxGeometry args={[0.2, 0.02, 0.2]} />
        <meshBasicMaterial color="#2bff9a" toneMapped={false} />
      </mesh>
    </group>
  );
});

// ---- moved services: movers fetch the rack and wheel it to its new slot ------------------------

const FETCH_SPEED = 2.3;
const MOVE_SPEED = 1.6;
const LOAD_S = 0.9;
const TRANSIT_MAX_MS = 180_000;
const MOVER_LANES = [0.2, -0.2, 0.42, -0.42, 0.6];

/**
 * One mover per rack in transit: from the waiting spot to the rack's old place (its ghost), load
 * it, wheel it through doors and streets to its new slot, walk back. The store keeps the ghosts in
 * the layout until the last rack has arrived, so nobody walks a stale route.
 */
export function Movers({ layout }: { layout: Layout }) {
  const transit = useStore((s) => s.transit);
  const still = useStore((s) => s.reducedMotion);

  useEffect(() => {
    if (!transit) return;
    const finishAll = () => transit.ghosts.forEach((g) => useStore.getState().finishMove(g.id));
    if (still) return finishAll();
    const left = TRANSIT_MAX_MS - (Date.now() - transit.startedAt);
    const id = setTimeout(finishAll, Math.max(0, left)); // never leave the map half-moved
    return () => clearTimeout(id);
  }, [transit, still]);

  if (!transit) return null;
  return (
    <>
      {transit.ghosts.map((g, k) => (
        <Mover key={g.id} layout={layout} ghostId={g.id} targetId={transit.targets[g.id]} index={k} db={isDb(g.kind)} />
      ))}
    </>
  );
}

type MovePhase = 'wait' | 'fetch' | 'load' | 'carry' | 'back' | 'gone';

const Mover = memo(function Mover({ layout, ghostId, targetId, index, db }: { layout: Layout; ghostId: string; targetId: string; index: number; db: boolean }) {
  const root = useRef<THREE.Group>(null);
  const cargo = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const lane = MOVER_LANES[index % MOVER_LANES.length];
  const home: V3 = [layout.home[0] + 1.2 + (index % 4) * 0.5, 0, layout.home[2] + 0.6];
  const st = useRef({ phase: 'wait' as MovePhase, wait: index * 1.6, t: 0, walker: null as Walker | null, loaded: false });

  // a new layout (another change came in): start the current leg over on the new routes
  useEffect(() => {
    const s = st.current;
    if (s.phase === 'fetch') s.walker = walkerFor(fromHome(routeFromHome(layout, ghostId, lane), home));
    else if (s.phase === 'carry') s.walker = walkerFor(routeBetween(layout, ghostId, targetId, lane));
    else if (s.phase === 'back') s.walker = walkerFor(toHome(routeHome(layout, targetId, lane), home));
  }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, rawDt) => {
    const g = root.current;
    const s = st.current;
    if (!g) return;
    const dt = Math.min(rawDt, 0.1);
    s.t += dt;
    const store = useStore.getState();
    switch (s.phase) {
      case 'wait':
        if ((s.wait -= dt) <= 0) {
          s.walker = walkerFor(fromHome(routeFromHome(layout, ghostId, lane), home));
          s.phase = s.walker ? 'fetch' : 'gone';
          if (!s.walker) store.finishMove(ghostId);
        }
        break;
      case 'fetch':
        if (s.walker!.step(FETCH_SPEED * dt)) {
          store.pickUp(ghostId); // the rack leaves its old slot, onto the hand truck
          s.loaded = true;
          s.phase = 'load';
          s.wait = LOAD_S;
        }
        break;
      case 'load':
        if ((s.wait -= dt) <= 0) {
          s.walker = walkerFor(routeBetween(layout, ghostId, targetId, lane));
          if (!s.walker) {
            store.finishMove(ghostId);
            s.phase = 'gone';
          } else s.phase = 'carry';
        }
        break;
      case 'carry':
        if (s.walker!.step(MOVE_SPEED * dt)) {
          store.finishMove(ghostId); // set down: the rack stands at its new slot
          s.loaded = false;
          s.walker = walkerFor(toHome(routeHome(layout, targetId, lane), home));
          s.phase = s.walker ? 'back' : 'gone';
        }
        break;
      case 'back':
        if (s.walker!.step(FETCH_SPEED * dt)) s.phase = 'gone';
        break;
    }
    g.visible = s.phase !== 'wait' && s.phase !== 'gone';
    if (!g.visible || !s.walker) return;
    g.position.copy(s.walker.pos);
    if (s.phase !== 'load') g.rotation.y = dampAngle(g.rotation.y, s.walker.heading, 8, dt);
    if (cargo.current) cargo.current.visible = s.loaded;
    const walking = s.phase !== 'load';
    const swing = walking ? Math.sin(s.t * 9) * 0.5 : 0;
    if (legL.current) legL.current.rotation.x = swing;
    if (legR.current) legR.current.rotation.x = -swing;
    const grip = s.phase === 'load' ? -1.4 + Math.sin(s.t * 6) * 0.3 : -0.9; // both hands on the hand truck
    if (armL.current) armL.current.rotation.x = grip;
    if (armR.current) armR.current.rotation.x = grip;
  });

  // Hand truck in front of the technician, the rack tilted back onto it.
  return (
    <group ref={root} visible={false}>
      <TechModel legL={legL} legR={legR} armL={armL} armR={armR} />
      <group position={[0, 0, 0.62]} rotation-x={-0.32}>
        {[-0.22, 0.22].map((x) => (
          <mesh key={x} position={[x, 0.55, -0.12]}>
            <boxGeometry args={[0.03, 1.15, 0.03]} />
            <meshStandardMaterial color="#9aa6b8" metalness={0.8} roughness={0.3} />
          </mesh>
        ))}
        {[-0.24, 0.24].map((x) => (
          <mesh key={x} position={[x, 0.08, -0.1]} rotation-z={Math.PI / 2}>
            <cylinderGeometry args={[0.08, 0.08, 0.05, 14]} />
            <meshStandardMaterial color="#141a24" />
          </mesh>
        ))}
        <group ref={cargo} visible={false}>
        <mesh position={[0, db ? 0.38 : 0.52, 0.1]} castShadow scale={0.55}>
          {db ? <cylinderGeometry args={[0.45, 0.45, 1.1, 18]} /> : <boxGeometry args={[RACK.w, RACK.h, RACK.d]} />}
          <meshStandardMaterial color="#1b2536" metalness={0.6} roughness={0.35} emissive={NEON} emissiveIntensity={0.12} />
        </mesh>
        </group>
      </group>
    </group>
  );
});

const walkerFor = (route: V3[] | null) => (route && route.length > 1 ? new Walker(route) : null);
const fromHome = (route: V3[] | null, home: V3): V3[] | null => (route ? [home, ...route.slice(1)] : null);
const toHome = (route: V3[] | null, home: V3): V3[] | null => (route ? [...route.slice(0, -1), home] : null);

// ---- day and night -----------------------------------------------------------------------

const DAY_BG = new THREE.Color('#0d1b33');
const NIGHT_BG = new THREE.Color(BG);

/** 0 at 1:00, 1 at 13:00 (local time), smooth in between. */
export const daylight = (date: Date) => {
  const h = date.getHours() + date.getMinutes() / 60;
  return 0.5 - 0.5 * Math.cos(((h - 1) / 24) * Math.PI * 2);
};

/** Lights for the scene, following the local clock: brighter and bluer by day, neon by night. */
export function Sky() {
  const hemi = useRef<THREE.HemisphereLight>(null);
  const sun = useRef<THREE.DirectionalLight>(null);
  const neon = useRef<THREE.DirectionalLight>(null);
  const scene = useThree((s) => s.scene);
  const [day, setDay] = useState(() => daylight(new Date()));

  useEffect(() => {
    const id = setInterval(() => setDay(daylight(new Date())), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const bg = NIGHT_BG.clone().lerp(DAY_BG, day);
    scene.background = bg;
    if (scene.fog) (scene.fog as THREE.Fog).color.copy(bg);
    if (hemi.current) hemi.current.intensity = 0.55 + 0.6 * day;
    if (sun.current) {
      sun.current.intensity = 0.7 + 1.1 * day;
      sun.current.color.set(day > 0.25 ? '#dce8ff' : '#9fb6ff').lerp(new THREE.Color('#ffd9a8'), Math.max(0, 0.35 - Math.abs(day - 0.3)) * 1.5);
    }
    if (neon.current) neon.current.intensity = 0.4 + 0.8 * (1 - day); // the city glows at night
  }, [day, scene]);

  return (
    <>
      <hemisphereLight ref={hemi} args={['#6f8fd8', '#03060c', 0.85]} />
      <directionalLight
        ref={sun}
        castShadow
        color="#cfe0ff"
        position={[-14, 30, 18]}
        intensity={1.5}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      >
        <orthographicCamera attach="shadow-camera" args={[-40, 40, 40, -40, 1, 120]} />
      </directionalLight>
      <directionalLight ref={neon} color={NEON} position={[24, 10, -24]} intensity={0.5} />
    </>
  );
}

// ---- tour --------------------------------------------------------------------------------

const TOUR_STEP_MS = 9_000;

/** Wall-display mode: incidents first (one after another), otherwise building by building. */
export function Tour() {
  const tour = useStore((s) => s.tour);
  useEffect(() => {
    if (!tour) return;
    let k = 0;
    const step = () => {
      const s = useStore.getState();
      const incidents = Object.values(s.services)
        .filter((x) => x.status === 'error')
        .map((x) => x.id)
        .sort();
      if (incidents.length) return s.select(incidents[k++ % incidents.length]);
      const projects = Object.values(s.projects)
        .filter((p) => Object.values(s.services).some((x) => x.projectId === p.id))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!projects.length) return;
      if (k % (projects.length + 1) === projects.length) {
        k++;
        s.clearSelection();
        return s.cameraCommand('reset'); // the overview once per round
      }
      s.focusProject(projects[k++ % (projects.length + 1)].id);
    };
    step();
    const id = setInterval(step, TOUR_STEP_MS);
    return () => clearInterval(id);
  }, [tour]);
  return null;
}

// ---- complexes ---------------------------------------------------------------------------

/** A plate with a glowing rim and a name under the buildings of each complex. */
export function Complexes({ layout }: { layout: Layout }) {
  return (
    <>
      {layout.complexes.map((c) => {
        const w = c.x1 - c.x0;
        const d = c.z1 - c.z0;
        const rim = 0.05;
        return (
          <group key={c.id}>
            <mesh position={[c.x0 + w / 2, 0.001, c.z0 + d / 2]} rotation-x={-Math.PI / 2} receiveShadow>
              <planeGeometry args={[w, d]} />
              <meshStandardMaterial color="#0b1424" transparent opacity={0.55} depthWrite={false} />
            </mesh>
            {[
              [c.x0 + w / 2, c.z0, w, rim],
              [c.x0 + w / 2, c.z1, w, rim],
              [c.x0, c.z0 + d / 2, rim, d],
              [c.x1, c.z0 + d / 2, rim, d],
            ].map(([x, z, sx, sz], i) => (
              <mesh key={i} position={[x, 0.004, z]} rotation-x={-Math.PI / 2}>
                <planeGeometry args={[sx, sz]} />
                <meshBasicMaterial color={ACCENT} toneMapped={false} transparent opacity={0.8} />
              </mesh>
            ))}
            <Label position={[c.x0 + 0.2, 0.05, c.z1 + 0.35]} anchor="left" zIndex={3}>
              <div className="complex-label">{c.name}</div>
            </Label>
          </group>
        );
      })}
    </>
  );
}
