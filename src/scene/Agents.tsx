/**
 * Deploy carts and the technician. All motion runs in useFrame on refs; the store only hears
 * when a cart is gone.
 */
import { RoundedBox } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { STAGES } from '../data/types';
import { cartRoute, routeBetween, routeFromHome, routeHome, type Layout, type V3 } from '../layout';
import { useStore } from '../store';
import { Label } from './Label';
import { trouble } from '../trouble';

const CART_SPEED = 3.2;
const TECH_SPEED = 2.3;
const TECH_DX = 0.42;
const FACE_RACK = Math.PI; // racks face +z, so agents look toward -z

// ---- path following -----------------------------------------------------------------

export class Walker {
  readonly pos: THREE.Vector3;
  heading = 0;
  private readonly pts: THREE.Vector3[];
  private i = 1;
  private traveled = 0;
  readonly total: number;

  constructor(points: V3[]) {
    this.pts = points.map((p) => new THREE.Vector3(...p));
    this.pos = this.pts[0].clone();
    this.total = this.pts.reduce((acc, p, k) => (k ? acc + p.distanceTo(this.pts[k - 1]) : 0), 0);
    if (this.pts.length > 1) this.heading = headingTo(this.pts[0], this.pts[1]);
  }

  /** Advances along the path; returns true once the last point is reached. */
  step(dist: number) {
    while (dist > 1e-6 && this.i < this.pts.length) {
      const target = this.pts[this.i];
      const d = this.pos.distanceTo(target);
      if (d > 1e-6) this.heading = headingTo(this.pos, target);
      if (d <= dist) {
        this.pos.copy(target);
        this.traveled += d;
        dist -= d;
        this.i++;
      } else {
        this.pos.lerp(target, dist / d);
        this.traveled += dist;
        dist = 0;
      }
    }
    return this.done;
  }

  get done() {
    return this.i >= this.pts.length;
  }
  get remaining() {
    return Math.max(0, this.total - this.traveled);
  }
}

const headingTo = (a: THREE.Vector3, b: THREE.Vector3) => Math.atan2(b.x - a.x, b.z - a.z);

export function dampAngle(current: number, target: number, lambda: number, dt: number) {
  const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + diff * (1 - Math.exp(-lambda * dt));
}

// ---- carts ----------------------------------------------------------------------------

/**
 * Deploy carts, plus the technician: he walks to nodes in error and stays until they are healthy
 * again; otherwise he patrols, checking busy and freshly deployed racks first.
 */
export function Agents({ layout }: { layout: Layout }) {
  const carts = useStore((s) => s.carts);
  const crew = useCrewSize();
  return (
    <>
      {carts.map((id) => (
        <Cart key={id} deploymentId={id} layout={layout} />
      ))}
      {Array.from({ length: crew }, (_, i) => (
        <Technician key={i} layout={layout} index={i} crew={crew} />
      ))}
      {Array.from({ length: crew }, (_, i) => (
        <HomeMarker key={i} at={homeOf(layout, i)} />
      ))}
    </>
  );
}

const MAX_CREW = 5;
const CREW_COOLDOWN_MS = 30_000;
/** Walking lanes, all inside the 1.5 m door, so technicians don't walk on top of each other. */
const LANES = [TECH_DX, -TECH_DX, 0.2, -0.2, 0.62];
const homeOf = (layout: Layout, i: number): V3 => [layout.home[0] + i * 0.6, 0, layout.home[2]];

/** 1 technician, +1 per open incident, +1 per two racks under load; shrinks only after a quiet spell. */
function useCrewSize() {
  const services = useStore((s) => s.services);
  const alerts = useStore((s) => s.alerts);
  const wanted = useMemo(() => {
    const incidents = new Set(
      Object.values(alerts)
        .filter((a) => !a.resolvedAt && a.severity === 'critical' && services[a.serviceId]?.status === 'error')
        .map((a) => a.serviceId),
    ).size;
    const loaded = Object.values(services).filter((s) => s.status !== 'error' && trouble(s)).length;
    return Math.min(MAX_CREW, 1 + incidents + Math.floor(loaded / 2));
  }, [services, alerts]);
  const [crew, setCrew] = useState(wanted);
  useEffect(() => {
    if (wanted >= crew) return setCrew(wanted);
    const t = setTimeout(() => setCrew(wanted), CREW_COOLDOWN_MS);
    return () => clearTimeout(t);
  }, [wanted, crew]);
  return crew;
}

type CartPhase = 'out' | 'docked' | 'back';

const Cart = memo(function Cart({ deploymentId, layout }: { deploymentId: string; layout: Layout }) {
  const dep = useStore((s) => s.deployments[deploymentId]);
  const svcName = useStore((s) => (dep ? s.services[dep.serviceId]?.name : undefined));
  const still = useStore((s) => s.reducedMotion);
  const [phase, setPhase] = useState<CartPhase>('out');

  // Route is fixed at spawn; later data changes don't reroute a cart that is already rolling.
  const [route] = useState(() => (dep ? cartRoute(layout, dep.serviceId, dep.cart % 2 ? -0.34 : 0.04) : null));
  const sim = useRef({ walker: route ? new Walker(route) : null, phase: 'out' as CartPhase | 'gone', age: 0, docked: 0 });

  const group = useRef<THREE.Group>(null);
  const chassis = useRef<THREE.Group>(null);
  const terminal = !dep || dep.status === 'success' || dep.status === 'failed';
  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;

  // No place to drive to (unknown service): no animation, drop the cart once the deploy ends.
  useEffect(() => {
    if (!route && terminal) useStore.getState().cartGone(deploymentId);
  }, [route, terminal, deploymentId]);

  useFrame((_, rawDt) => {
    const st = sim.current;
    const g = group.current;
    if (!g || !st.walker || st.phase === 'gone') return;
    const dt = Math.min(rawDt, 0.1);
    st.age += dt;

    let moving = false;
    if (st.phase === 'out') {
      moving = true;
      if (st.walker.step(CART_SPEED * dt)) {
        st.phase = 'docked';
        setPhase('docked');
      }
    } else if (st.phase === 'docked') {
      st.docked += dt;
      if (terminalRef.current && st.docked > 0.8 && route) {
        st.phase = 'back';
        st.walker = new Walker(route.slice().reverse());
        setPhase('back');
      }
    } else if (st.walker.step(CART_SPEED * dt)) {
      st.phase = 'gone';
      useStore.getState().cartGone(deploymentId);
      return;
    } else {
      moving = true;
    }

    g.position.copy(st.walker.pos);
    const heading = st.phase === 'docked' ? FACE_RACK : st.walker.heading;
    g.rotation.y = st.age < 0.05 ? heading : dampAngle(g.rotation.y, heading, 12, dt);
    const appear = Math.min(1, st.age / 0.35);
    const vanish = st.phase === 'back' ? Math.min(1, st.walker.remaining / 0.9) : 1;
    g.scale.setScalar(Math.max(0.001, Math.min(appear, vanish)));
    if (chassis.current) chassis.current.position.y = moving && !still ? Math.abs(Math.sin(st.age * 16)) * 0.02 : 0;
  });

  if (!route || !dep) return null;

  const stage = dep.stages.findIndex((s) => s === 'running' || s === 'failed');
  const label =
    phase === 'out'
      ? `To ${svcName ?? '…'}`
      : phase === 'docked'
        ? dep.status === 'running' && stage >= 0
          ? `${STAGES[stage]} · ${svcName}`
          : dep.status === 'queued'
            ? `Docking · ${svcName}`
            : dep.status === 'success'
              ? 'Delivered'
              : 'Build failed'
        : dep.status === 'failed'
          ? 'Returning · failed'
          : 'Returning';
  const delivered = phase === 'back' && dep.status === 'success';
  const failed = dep.status === 'failed';

  return (
    <group ref={group} scale={0.001} position={route[0]}>
      <group ref={chassis}>
        <RoundedBox args={[0.56, 0.2, 0.74]} radius={0.06} smoothness={3} position-y={0.2} castShadow>
          <meshStandardMaterial color="#1a2436" roughness={0.35} metalness={0.6} />
        </RoundedBox>
        <mesh position={[0, 0.21, 0.375]}>
          <boxGeometry args={[0.4, 0.06, 0.01]} />
          <meshStandardMaterial color="#000" emissive="#3d9bff" emissiveIntensity={2.2} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.305, -0.08]}>
          <boxGeometry args={[0.5, 0.012, 0.52]} />
          <meshStandardMaterial color="#000" emissive="#7c6cff" emissiveIntensity={0.9} toneMapped={false} />
        </mesh>
        {!delivered && (
          <mesh position={[0, 0.47, -0.08]} castShadow>
            <boxGeometry args={[0.32, 0.32, 0.32]} />
            <meshStandardMaterial
              color={failed ? '#e5484d' : '#3d8bff'}
              emissive={failed ? '#e5484d' : '#3d8bff'}
              emissiveIntensity={1.3}
              roughness={0.35}
              toneMapped={false}
            />
          </mesh>
        )}
        <mesh position={[0.2, 0.42, 0.28]}>
          <cylinderGeometry args={[0.012, 0.012, 0.26, 6]} />
          <meshStandardMaterial color="#8b929e" />
        </mesh>
        <mesh position={[0.2, 0.57, 0.28]}>
          <sphereGeometry args={[0.035, 10, 8]} />
          <meshStandardMaterial color="#000" emissive={failed ? '#ff2e55' : '#ffb224'} emissiveIntensity={2.6} toneMapped={false} />
        </mesh>
      </group>
      {[-0.22, 0.22].flatMap((x) =>
        [-0.24, 0.24].map((z) => (
          <mesh key={`${x}${z}`} position={[x * 1.12, 0.08, z]} rotation-z={Math.PI / 2}>
            <cylinderGeometry args={[0.08, 0.08, 0.06, 14]} />
            <meshStandardMaterial color="#2a2f3a" roughness={0.8} />
          </mesh>
        )),
      )}
      <Label position={[0, 1.05, 0]} zIndex={8} minZoom={13}>
        <div className={`cart-label ${failed ? 'is-failed' : ''}`}>
          <b>RC{dep.cart}</b> · {label}
        </div>
      </Label>
    </group>
  );
});

// ---- technician ---------------------------------------------------------------------

type TechPhase = 'idle' | 'walk' | 'work' | 'home' | 'patrol' | 'inspect';

/** Swaps the shared waiting spot at a route's start/end for this technician's own spot. */
function fromHomeTo(route: V3[] | null, home: V3, end: 'start' | 'end'): V3[] | null {
  if (!route) return null;
  return end === 'start' ? [home, ...route.slice(1)] : [...route.slice(0, -1), home];
}

const PATROL_ROUNDS = 5; // racks checked before a break at home
const REST_S = 8;

/** Picks the next rack to check: weighted towards CPU load and an active deploy. */
function pickPatrol(services: Record<string, { cpu: number; status: string }>, slots: Layout['slots'], not: string | null) {
  const ids = Object.keys(slots).filter((id) => id !== not && services[id]);
  if (!ids.length) return null;
  const weight = (id: string) => 1 + Math.min(services[id].cpu, 2) * 4 + (services[id].status === 'deploying' ? 6 : 0);
  let r = Math.random() * ids.reduce((a, id) => a + weight(id), 0);
  for (const id of ids) if ((r -= weight(id)) <= 0) return id;
  return ids[ids.length - 1];
}

function Technician({ layout, index, crew }: { layout: Layout; index: number; crew: number }) {
  const lane = LANES[index % LANES.length];
  const home = homeOf(layout, index);
  const alerts = useStore((s) => s.alerts);
  const services = useStore((s) => s.services);
  const still = useStore((s) => s.reducedMotion);

  // Services that need a hand: open critical alert + still in error. Oldest incident first.
  const queue = useMemo(() => {
    const ids = Object.values(alerts)
      .filter((a) => !a.resolvedAt && a.severity === 'critical' && services[a.serviceId]?.status === 'error')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => a.serviceId);
    const all = [...new Set(ids)].filter((id) => layout.slots[id]);
    const mine = all.filter((_, k) => k % crew === index);
    return mine.length ? mine : all.slice(index, index + 1);
  }, [alerts, services, layout, index, crew]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const servicesRef = useRef(services);
  servicesRef.current = services;
  const [checking, setChecking] = useState<string | null>(null);

  const [mode, setMode] = useState<TechPhase>('idle');
  const sim = useRef({
    phase: 'idle' as TechPhase,
    walker: null as Walker | null,
    target: null as string | null,
    at: null as string | null,
    t: 0,
    restUntil: 3 + index * 2.5, // the crew heads out one after another
    inspectUntil: 0,
    rounds: 0,
  });

  // The layout changed (nodes came or went, buildings resized): a route planned on the old one would
  // cut through the new walls. Start over from the waiting spot.
  useEffect(() => {
    const st = sim.current;
    if (st.phase === 'idle' && !st.walker) return;
    Object.assign(st, { phase: 'idle', walker: null, target: null, at: null, restUntil: st.t + 1 + index });
    setMode('idle');
    setChecking(null);
  }, [layout, index]);

  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);

  useFrame((_, rawDt) => {
    const st = sim.current;
    const g = root.current;
    if (!g) return;
    const dt = Math.min(rawDt, 0.1);
    st.t += dt;

    const go = (phase: TechPhase, path: V3[] | null, target: string | null) => {
      if (!path) return false;
      st.phase = phase;
      st.walker = new Walker(path);
      st.target = target;
      setMode(phase);
      return true;
    };
    const next = () => {
      const from = st.at!;
      const job = queueRef.current.find((id) => id !== from);
      if (!(job && go('walk', routeBetween(layout, from, job, lane), job))) {
        go('home', fromHomeTo(routeHome(layout, from, lane), home, 'end'), null);
      }
    };
    // Incidents first; otherwise carry on with the round or head home for a break.
    const afterCheck = () => {
      setChecking(null);
      const from = st.at!;
      if (queueRef.current.length || still) return next();
      const target = st.rounds < PATROL_ROUNDS ? pickPatrol(servicesRef.current, layout.slots, from) : null;
      if (!(target && go('patrol', routeBetween(layout, from, target, lane), target))) {
        go('home', fromHomeTo(routeHome(layout, from, lane), home, 'end'), null);
      }
    };

    switch (st.phase) {
      case 'idle': {
        const job = queueRef.current[0];
        if (job) go('walk', fromHomeTo(routeFromHome(layout, job, lane), home, 'start'), job);
        else if (!still && st.t >= st.restUntil) {
          const target = pickPatrol(servicesRef.current, layout.slots, null);
          st.rounds = 0;
          if (target) go('patrol', fromHomeTo(routeFromHome(layout, target, lane), home, 'start'), target);
        }
        break;
      }
      case 'walk':
        if (st.walker!.step(TECH_SPEED * dt)) {
          st.at = st.target;
          if (st.at && queueRef.current.includes(st.at)) {
            st.phase = 'work';
            setMode('work');
          } else next();
        }
        break;
      case 'patrol':
        if (st.walker!.step(TECH_SPEED * dt)) {
          st.at = st.target;
          if (queueRef.current.length) next();
          else {
            st.phase = 'inspect';
            st.inspectUntil = st.t + 3 + Math.random() * 3;
            st.rounds++;
            setMode('inspect');
            setChecking(st.at);
          }
        }
        break;
      case 'inspect':
        if (queueRef.current.length || st.t >= st.inspectUntil) afterCheck();
        break;
      case 'work':
        if (!queueRef.current.includes(st.at!)) next(); // Dokploy says it's healthy again
        break;
      case 'home':
        if (st.walker!.step(TECH_SPEED * dt)) {
          st.phase = 'idle';
          st.at = null;
          st.walker = null;
          st.restUntil = st.t + REST_S;
          setMode('idle');
        }
        break;
    }

    // pose
    const walking = st.phase === 'walk' || st.phase === 'home' || st.phase === 'patrol';
    const busy = st.phase === 'work' || st.phase === 'inspect';
    if (st.walker) g.position.copy(st.walker.pos);
    else g.position.set(...home);
    const heading = busy ? FACE_RACK : st.walker ? st.walker.heading : 0;
    g.rotation.y = dampAngle(g.rotation.y, heading, 10, dt);

    const swing = walking && !still ? Math.sin(st.t * 10) * 0.55 : 0;
    if (legL.current) legL.current.rotation.x = swing;
    if (legR.current) legR.current.rotation.x = -swing;
    if (armL.current) armL.current.rotation.x = -swing * 0.8;
    if (armR.current) {
      armR.current.rotation.x =
        st.phase === 'work'
          ? still
            ? -1.9
            : -1.6 - Math.abs(Math.sin(st.t * 7)) * 0.7
          : st.phase === 'inspect'
            ? -1.2 - Math.sin(st.t * 3) * 0.25 // holding up the tablet
            : swing * 0.8;
    }
    if (body.current) {
      body.current.position.y = walking && !still ? Math.abs(Math.sin(st.t * 10)) * 0.035 : still ? 0 : Math.sin(st.t * 2) * 0.006;
    }
  });

  return (
    <group ref={root} position={home}>
      <group ref={body}>
        <TechModel legL={legL} legR={legR} armL={armL} armR={armR} />
      </group>
      {mode === 'work' && (
        <Label position={[0, 1.6, 0]} zIndex={9}>
          <div className="bubble">
            <span className="bubble-spinner" />
            Investigating…
          </div>
        </Label>
      )}
      {mode === 'inspect' && checking && (
        <Label position={[0, 1.6, 0]} zIndex={8}>
          <div className="bubble">Routine check · {services[checking]?.name ?? 'rack'}</div>
        </Label>
      )}
    </group>
  );
}

type GroupRef = RefObject<THREE.Group | null>;

const SKIN = '#e9b993';
const VEST = '#ff7a1a';
const PANTS = '#2b3a55';
const HAT = '#ffc53d';

function Limb({ r, len, color }: { r: number; len: number; color: string }) {
  return (
    <mesh position-y={-len / 2 - r} castShadow>
      <capsuleGeometry args={[r, len, 4, 10]} />
      <meshStandardMaterial color={color} roughness={0.7} />
    </mesh>
  );
}

export function TechModel({ legL, legR, armL, armR }: { legL: GroupRef; legR: GroupRef; armL: GroupRef; armR: GroupRef }) {
  return (
    <group>
      <group ref={legL} position={[-0.075, 0.46, 0]}>
        <Limb r={0.065} len={0.3} color={PANTS} />
      </group>
      <group ref={legR} position={[0.075, 0.46, 0]}>
        <Limb r={0.065} len={0.3} color={PANTS} />
      </group>
      <mesh position-y={0.68} castShadow>
        <capsuleGeometry args={[0.15, 0.22, 4, 12]} />
        <meshStandardMaterial color={VEST} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.72, 0.12]}>
        <boxGeometry args={[0.2, 0.035, 0.08]} />
        <meshStandardMaterial color="#e8ecf1" emissive="#ffffff" emissiveIntensity={0.3} />
      </mesh>
      <group ref={armL} position={[-0.2, 0.86, 0]}>
        <Limb r={0.048} len={0.26} color={VEST} />
      </group>
      <group ref={armR} position={[0.2, 0.86, 0]}>
        <Limb r={0.048} len={0.26} color={VEST} />
        <mesh position={[0, -0.42, 0.02]}>
          <boxGeometry args={[0.04, 0.14, 0.04]} />
          <meshStandardMaterial color="#8b929e" metalness={0.6} roughness={0.3} />
        </mesh>
      </group>
      <mesh position-y={1.02} castShadow>
        <sphereGeometry args={[0.115, 16, 12]} />
        <meshStandardMaterial color={SKIN} roughness={0.8} />
      </mesh>
      <mesh position-y={1.05} castShadow>
        <sphereGeometry args={[0.13, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={HAT} roughness={0.4} />
      </mesh>
      <mesh position={[0, 1.05, 0.03]}>
        <cylinderGeometry args={[0.165, 0.165, 0.02, 20]} />
        <meshStandardMaterial color={HAT} roughness={0.4} />
      </mesh>
    </group>
  );
}

function HomeMarker({ at }: { at: V3 }) {
  return (
    <mesh position={[at[0], 0.004, at[2]]} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[0.36, 0.42, 40]} />
      <meshBasicMaterial color="#1f5f7a" toneMapped={false} />
    </mesh>
  );
}
