/**
 * Deploy carts and the technician. All motion runs in useFrame on refs; the store only hears
 * about milestones (cart docked / cart gone / incident fixed).
 */
import { RoundedBox } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { STAGES } from '../data/types';
import { cartRoute, routeBetween, routeFromHome, routeHome, type Layout, type V3 } from '../layout';
import { useStore } from '../store';
import { Label } from './Label';

const CART_SPEED = 3.2;
const TECH_SPEED = 2.3;
const TECH_DX = 0.42;
const WORK_SECONDS = 2.5;
const FACE_RACK = Math.PI; // racks face +z, so agents look toward -z

// ---- path following -----------------------------------------------------------------

class Walker {
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

function dampAngle(current: number, target: number, lambda: number, dt: number) {
  const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + diff * (1 - Math.exp(-lambda * dt));
}

// ---- carts ----------------------------------------------------------------------------

/**
 * Deploy carts, plus the technician. In the simulation he "fixes" incidents ('fix'); against a real
 * Dokploy he only goes to look ('watch') and leaves when Dokploy reports the node healthy again.
 */
export type TechMode = 'fix' | 'watch';

export function Agents({ layout, technician }: { layout: Layout; technician: TechMode }) {
  const carts = useStore((s) => s.carts);
  return (
    <>
      {carts.map((id) => (
        <Cart key={id} deploymentId={id} layout={layout} />
      ))}
      <Technician layout={layout} behavior={technician} />
      <HomeMarker at={layout.home} />
    </>
  );
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

  // No place to drive to (unknown service): skip the animation but keep the deploy moving.
  useEffect(() => {
    if (route) return;
    const { cartArrived, cartGone } = useStore.getState();
    if (!terminal) cartArrived(deploymentId);
    else cartGone(deploymentId);
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
        useStore.getState().cartArrived(deploymentId);
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

type TechPhase = 'idle' | 'walk' | 'work' | 'home';

function Technician({ layout, behavior }: { layout: Layout; behavior: TechMode }) {
  const alerts = useStore((s) => s.alerts);
  const services = useStore((s) => s.services);
  const still = useStore((s) => s.reducedMotion);

  // Services that need a hand: open critical alert + still in error. Oldest incident first.
  const queue = useMemo(() => {
    const ids = Object.values(alerts)
      .filter((a) => !a.resolvedAt && a.severity === 'critical' && services[a.serviceId]?.status === 'error')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => a.serviceId);
    return [...new Set(ids)].filter((id) => layout.slots[id]);
  }, [alerts, services, layout]);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const [mode, setMode] = useState<TechPhase>('idle');
  const sim = useRef({
    phase: 'idle' as TechPhase,
    walker: null as Walker | null,
    target: null as string | null,
    at: null as string | null,
    work: 0,
    t: 0,
  });

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
      if (!(job && go('walk', routeBetween(layout, from, job, TECH_DX), job))) {
        go('home', routeHome(layout, from, TECH_DX), null);
      }
    };

    switch (st.phase) {
      case 'idle': {
        const job = queueRef.current[0];
        if (job) go('walk', routeFromHome(layout, job, TECH_DX), job);
        break;
      }
      case 'walk':
        if (st.walker!.step(TECH_SPEED * dt)) {
          st.at = st.target;
          if (st.at && queueRef.current.includes(st.at)) {
            st.phase = 'work';
            st.work = 0;
            setMode('work');
          } else next();
        }
        break;
      case 'work':
        st.work += dt;
        if (behavior === 'fix' && st.work >= WORK_SECONDS) {
          useStore.getState().techFixed(st.at!);
          next();
        } else if (behavior === 'watch' && !queueRef.current.includes(st.at!)) {
          next(); // Dokploy says it's healthy again
        }
        break;
      case 'home':
        if (st.walker!.step(TECH_SPEED * dt)) {
          st.phase = 'idle';
          st.at = null;
          st.walker = null;
          setMode('idle');
        }
        break;
    }

    // pose
    const walking = st.phase === 'walk' || st.phase === 'home';
    if (st.walker) g.position.copy(st.walker.pos);
    else g.position.set(...layout.home);
    const heading = st.phase === 'work' ? FACE_RACK : st.walker ? st.walker.heading : 0;
    g.rotation.y = dampAngle(g.rotation.y, heading, 10, dt);

    const swing = walking && !still ? Math.sin(st.t * 10) * 0.55 : 0;
    if (legL.current) legL.current.rotation.x = swing;
    if (legR.current) legR.current.rotation.x = -swing;
    if (armL.current) armL.current.rotation.x = -swing * 0.8;
    if (armR.current) {
      armR.current.rotation.x =
        st.phase === 'work' ? (still ? -1.9 : -1.6 - Math.abs(Math.sin(st.t * 7)) * 0.7) : swing * 0.8;
    }
    if (body.current) {
      body.current.position.y = walking && !still ? Math.abs(Math.sin(st.t * 10)) * 0.035 : still ? 0 : Math.sin(st.t * 2) * 0.006;
    }
  });

  return (
    <group ref={root} position={layout.home}>
      <group ref={body}>
        <TechModel legL={legL} legR={legR} armL={armL} armR={armR} />
      </group>
      {mode === 'work' && (
        <Label position={[0, 1.6, 0]} zIndex={9}>
          <div className="bubble">
            <span className="bubble-spinner" />
            {behavior === 'fix' ? 'Restarting…' : 'Investigating…'}
          </div>
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

function TechModel({ legL, legR, armL, armR }: { legL: GroupRef; legR: GroupRef; armL: GroupRef; armR: GroupRef }) {
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
