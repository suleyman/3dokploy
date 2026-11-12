import { Billboard } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { memo, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { isDb, type Service } from '../data/types';
import { mb, pct } from '../format';
import { RACK, TANK, type Layout, type Slot } from '../layout';
import { matchesSearch, useStore } from '../store';
import { ACCENT, KIND_COLOR, NEON } from '../theme';
import { Label } from './Label';
import { trouble, type Trouble } from '../trouble';

export { trouble };
import { CABINET, CABINET_DOOR, DIM_OPACITY, GEO, TANK_BODY, heatColor, ledMaterial, slowness } from './materials';

const LED_ROWS = [0.36, 0.62, 0.88, 1.14, 1.4];
const BASE_Y = 0.03; // building slab height

export const unitHeight = (svc: Service) => (isDb(svc.kind) ? 0.08 + TANK.h + TANK.r * 0.35 : RACK.h + 0.06);

/** One service in the scene: wiring (data, pointer events) around a dumb Cabinet / Tank. */
export const ServiceUnit = memo(function ServiceUnit({ slot }: { slot: Slot }) {
  const id = slot.serviceId;
  const svc = useStore((s) => s.services[id] ?? s.transit?.ghosts.find((g) => g.id === id));
  const project = useStore((s) => s.projects[slot.projectId] ?? s.transit?.projects.find((p) => p.id === slot.projectId));
  const env = useStore((s) => s.environments[slot.environmentId]);
  const search = useStore((s) => s.search);
  const heatmap = useStore((s) => s.heatmap);
  const moving = useStore((s) => !!s.moving[id]);

  if (!svc || moving) return null; // a moving rack is drawn on the hand truck until it arrives
  const dim = !matchesSearch(svc, project, search, env);

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    useStore.getState().hover(id);
    document.body.style.cursor = 'pointer';
  };
  const out = () => {
    if (useStore.getState().hoveredId === id) useStore.getState().hover(null);
    document.body.style.cursor = '';
  };
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    useStore.getState().select(id);
  };

  return (
    <group position={[slot.pos[0], BASE_Y, slot.pos[2]]} onPointerOver={over} onPointerOut={out} onClick={click}>
      {isDb(svc.kind) ? (
        <Tank svc={svc} dim={dim} heat={heatmap} />
      ) : (
        <Cabinet svc={svc} dim={dim} heat={heatmap} />
      )}
      {svc.status === 'error' && <ErrorBalloon y={unitHeight(svc) + 0.75} />}
      {svc.sleeping && !dim && (
        <Label position={[0, unitHeight(svc) + 0.45, 0]} zIndex={2}>
          <div className="rack-sleep" title={`Asleep (Sablier group ${svc.sleeping}): starts on the next request`}>
            z<span>z</span><span>z</span>
          </div>
        </Label>
      )}
      <Burn level={trouble(svc)} y={unitHeight(svc)} />
      <Sparks at={svc.errorAt} y={unitHeight(svc)} />
      {!dim && (!!svc.errors || (svc.certDays !== undefined && svc.certDays < 14)) && (
        <Label position={[0, -0.05, RACK.d / 2 + 0.35]} zIndex={3}>
          <div className="rack-badges">
            {!!svc.errors && <span className="badge badge-warn" title={`${svc.errors} unresolved in GlitchTip`}>⚠ {svc.errors}</span>}
            {svc.certDays !== undefined && svc.certDays < 14 && (
              <span className={`badge ${svc.certDays < 5 ? 'badge-crit' : 'badge-warn'}`} title="TLS certificate expires soon">
                TLS {svc.certDays}d
              </span>
            )}
          </div>
        </Label>
      )}
    </group>
  );
});

// ---- sparks: a new GlitchTip event ----------------------------------------------------

const SPARK_N = 14;
const SPARK_S = 3.5;

/** A burst of sparks when the newest error event of this node changes (never on first sight). */
const Sparks = memo(function Sparks({ at, y }: { at?: number; y: number }) {
  const seen = useRef(at);
  const until = useRef(0);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const still = useStore((s) => s.reducedMotion);
  const dirs = useMemo(
    () => Array.from({ length: SPARK_N }, () => new THREE.Vector3(Math.random() - 0.5, 0.6 + Math.random(), Math.random() - 0.5).multiplyScalar(1.6)),
    [],
  );
  const tmp = useMemo(() => new THREE.Matrix4(), []);
  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m) return;
    const t = clock.elapsedTime;
    if (at !== seen.current) {
      if (seen.current !== undefined && (at ?? 0) > seen.current && !still) until.current = t + SPARK_S;
      seen.current = at;
    }
    const left = until.current - t;
    if (left <= 0) {
      m.count = 0;
      return;
    }
    const p = ((SPARK_S - left) % 0.9) / 0.9; // three short bursts
    for (let i = 0; i < SPARK_N; i++) {
      const d = dirs[i];
      tmp.makeTranslation(d.x * p, y + 0.1 + d.y * p - 2.2 * p * p, d.z * p + 0.2);
      m.setMatrixAt(i, tmp);
    }
    m.count = SPARK_N;
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, SPARK_N]} frustumCulled={false}>
      <boxGeometry args={[0.04, 0.04, 0.04]} />
      <meshBasicMaterial color="#ffe08a" toneMapped={false} />
    </instancedMesh>
  );
});

// ---- trouble: smoke under load, fire when down -------------------------------------

const FLAMES = [
  { x: 0, z: 0, s: 1, c: '#ffd23d' },
  { x: -0.16, z: 0.05, s: 0.75, c: '#ff8a1f' },
  { x: 0.15, z: -0.04, s: 0.8, c: '#ff6a1a' },
  { x: 0.05, z: 0.12, s: 0.6, c: '#ff3d2e' },
  { x: -0.06, z: -0.12, s: 0.65, c: '#ff9d2b' },
];
const PUFFS = 7;

const Burn = memo(function Burn({ level, y }: { level: Trouble; y: number }) {
  const flames = useRef<(THREE.Mesh | null)[]>([]);
  const puffs = useRef<(THREE.Mesh | null)[]>([]);
  const light = useRef<THREE.PointLight>(null);
  const still = useStore((s) => s.reducedMotion);
  const seed = useMemo(() => Math.random() * 100, []);

  useFrame(({ clock }) => {
    if (!level) return;
    const t = clock.elapsedTime + seed;
    flames.current.forEach((m, i) => {
      if (!m) return;
      const f = still ? 1 : 0.75 + Math.abs(Math.sin(t * (7 + i * 1.7)) * 0.35) + Math.sin(t * 13 + i) * 0.08;
      m.scale.set(FLAMES[i].s, FLAMES[i].s * f, FLAMES[i].s);
    });
    if (light.current) light.current.intensity = still ? 2.2 : 1.8 + Math.sin(t * 17) * 0.5 + Math.sin(t * 7.3) * 0.4;
    puffs.current.forEach((m, i) => {
      if (!m) return;
      const p = still ? i / PUFFS : (t * 0.45 + i / PUFFS) % 1; // 0 → 1 over the puff's life
      m.position.set(Math.sin(i * 2.4 + t * 0.3) * 0.18 * p, 0.25 + p * 1.6, Math.cos(i * 1.7) * 0.12 * p);
      m.scale.setScalar(0.12 + p * 0.32);
      (m.material as THREE.MeshBasicMaterial).opacity = (level === 'fire' ? 0.5 : 0.35) * (1 - p) * Math.min(1, p * 5);
    });
  });

  if (!level) return null;
  return (
    <group position-y={y}>
      {level === 'fire' && (
        <>
          {FLAMES.map((f, i) => (
            <mesh key={i} ref={(m) => (flames.current[i] = m)} position={[f.x, 0.22 * f.s, f.z]}>
              <coneGeometry args={[0.14, 0.5, 10, 1, true]} />
              <meshBasicMaterial color={f.c} toneMapped={false} transparent opacity={0.85} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
            </mesh>
          ))}
          <pointLight ref={light} color="#ff7a1a" intensity={2} distance={3.2} position={[0, 0.4, 0.3]} />
        </>
      )}
      {Array.from({ length: PUFFS }, (_, i) => (
        <mesh key={i} ref={(m) => (puffs.current[i] = m)}>
          <sphereGeometry args={[1, 10, 8]} />
          <meshBasicMaterial color={level === 'fire' ? '#2a2a33' : '#8a93a6'} transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
});

interface UnitProps {
  svc: Service;
  dim: boolean;
  heat: boolean;
}

export function Cabinet({ svc, dim, heat }: UnitProps) {
  const body = useMemo(() => (heat ? heatColor(svc.cpu, 'cabinet') : new THREE.Color(CABINET)), [heat, svc.cpu]);
  const door = useMemo(() => (heat ? body.clone().multiplyScalar(0.8) : new THREE.Color(CABINET_DOOR)), [heat, body]);
  // `transparent` is baked into the shader program, so a dim toggle remounts the material (key).
  const fade = { transparent: dim, opacity: dim ? DIM_OPACITY : 1 };
  const mk = dim ? 'dim' : 'solid';
  const led = ledMaterial(svc.status, dim, slowness(svc.latencyMs));
  const kind = KIND_COLOR[svc.kind];

  return (
    <group>
      <mesh geometry={GEO.rackFoot} position-y={0.025}>
        <meshStandardMaterial key={mk} color="#05080e" {...fade} />
      </mesh>
      <mesh geometry={GEO.rackBody} position-y={RACK.h / 2 + 0.03} castShadow={!dim} receiveShadow>
        <meshStandardMaterial key={mk} color={body} roughness={0.35} metalness={0.6} {...fade} />
      </mesh>
      <mesh geometry={GEO.rackLid} position-y={RACK.h + 0.06} castShadow={!dim}>
        <meshStandardMaterial
          key={mk}
          color={kind}
          emissive={kind}
          emissiveIntensity={dim ? 0.2 : 1.15}
          roughness={0.4}
          toneMapped={false}
          {...fade}
        />
      </mesh>
      <mesh geometry={GEO.rackDoor} position={[0, RACK.h / 2 + 0.03, RACK.d / 2 + 0.006]}>
        <meshStandardMaterial key={mk} color={door} roughness={0.3} metalness={0.7} {...fade} />
      </mesh>
      {LED_ROWS.map((y) => (
        <mesh key={y} geometry={GEO.rackLed} material={led} position={[0, y, RACK.d / 2 + 0.016]} />
      ))}
      <ReplicaMarks count={svc.replicas} z={RACK.d / 2 + 0.2} dim={dim} />
    </group>
  );
}

export function Tank({ svc, dim, heat }: UnitProps) {
  const body = useMemo(() => (heat ? heatColor(svc.cpu, 'tank') : new THREE.Color(TANK_BODY)), [heat, svc.cpu]);
  const fade = { transparent: dim, opacity: dim ? DIM_OPACITY : 1 };
  const mk = dim ? 'dim' : 'solid';
  const band = KIND_COLOR[svc.kind];
  const top = 0.08 + TANK.h;

  return (
    <group>
      <mesh geometry={GEO.tankBase} position-y={0.04} receiveShadow>
        <meshStandardMaterial key={mk} color="#070b13" roughness={0.6} metalness={0.4} {...fade} />
      </mesh>
      <mesh geometry={GEO.tankBody} position-y={0.08 + TANK.h / 2} castShadow={!dim} receiveShadow>
        <meshStandardMaterial key={mk} color={body} roughness={0.28} metalness={0.75} {...fade} />
      </mesh>
      <mesh geometry={GEO.tankDome} position-y={top} scale-y={0.35} castShadow={!dim}>
        <meshStandardMaterial key={mk} color={body} roughness={0.28} metalness={0.75} {...fade} />
      </mesh>
      {[0.3, 0.55, 0.8].map((f) => (
        <mesh key={f} geometry={GEO.tankBand} position-y={0.08 + TANK.h * f}>
          <meshStandardMaterial
            key={mk}
            color="#000000"
            emissive={band}
            emissiveIntensity={dim ? 0.25 : 1.9}
            side={THREE.DoubleSide}
            toneMapped={false}
            {...fade}
          />
        </mesh>
      ))}
      <mesh geometry={GEO.tankLed} material={ledMaterial(svc.status, dim)} position-y={top + TANK.r * 0.35 + 0.02} />
    </group>
  );
}

function ReplicaMarks({ count, z, dim }: { count: number; z: number; dim: boolean }) {
  const step = 0.17;
  const x0 = (-(count - 1) * step) / 2;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <mesh key={i} geometry={GEO.replica} position={[x0 + i * step, 0.012, z]} rotation-x={-Math.PI / 2}>
          <meshBasicMaterial color={NEON} toneMapped={false} transparent opacity={dim ? 0.12 : 0.9} />
        </mesh>
      ))}
    </>
  );
}

function ErrorBalloon({ y }: { y: number }) {
  const ref = useRef<THREE.Group>(null);
  const still = useStore((s) => s.reducedMotion);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.position.y = still ? y : y + Math.sin(clock.elapsedTime * 2.4) * 0.09;
  });
  return (
    <group ref={ref} position-y={y}>
      <Billboard>
        <mesh scale={[1, 1.12, 1]}>
          <sphereGeometry args={[0.26, 24, 16]} />
          <meshStandardMaterial color="#ff2e55" emissive="#ff2e55" emissiveIntensity={1.4} roughness={0.3} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.06, 0.27]}>
          <boxGeometry args={[0.06, 0.18, 0.01]} />
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </mesh>
        <mesh position={[0, -0.12, 0.27]}>
          <boxGeometry args={[0.06, 0.06, 0.01]} />
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </mesh>
        <mesh position-y={-0.32} rotation-x={Math.PI}>
          <coneGeometry args={[0.05, 0.07, 8]} />
          <meshStandardMaterial color="#c4203f" />
        </mesh>
      </Billboard>
      <mesh position-y={-0.62}>
        <cylinderGeometry args={[0.006, 0.006, 0.55, 4]} />
        <meshBasicMaterial color="#ff8aa0" toneMapped={false} />
      </mesh>
    </group>
  );
}

// ---- hover / selection ------------------------------------------------------------

function Ring({ slot, color, opacity, pulse }: { slot: Slot; color: string; opacity: number; pulse?: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  const still = useStore((s) => s.reducedMotion);
  useFrame(({ clock }) => {
    if (ref.current && pulse && !still) ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 3) * 0.04);
  });
  return (
    <mesh ref={ref} geometry={GEO.ring} position={[slot.pos[0], 0.05, slot.pos[2]]} rotation-x={-Math.PI / 2}>
      <meshBasicMaterial color={color} transparent opacity={opacity} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

function HoverTip({ slot }: { slot: Slot }) {
  const svc = useStore((s) => s.services[slot.serviceId]);
  if (!svc) return null;
  return (
    <Label position={[slot.pos[0], unitHeight(svc) + 0.45, slot.pos[2]]} zIndex={12}>
      <div className="tip">
        <strong>{svc.name}</strong>
        <span>CPU {pct(svc.cpu)}</span>
        <span>{mb(svc.memMb)}</span>
      </div>
    </Label>
  );
}

/** Spinning diamond above the selected unit; floor rings get hidden behind the row in front. */
function SelectPin({ slot }: { slot: Slot }) {
  const svc = useStore((s) => s.services[slot.serviceId]);
  const still = useStore((s) => s.reducedMotion);
  const ref = useRef<THREE.Group>(null);
  const y = svc ? unitHeight(svc) + (svc.status === 'error' ? 1.7 : 0.75) : 2.4;
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    ref.current.position.y = still ? y : y + Math.sin(t * 2.6) * 0.07;
    if (!still) ref.current.rotation.y = t * 1.6;
  });
  return (
    <group ref={ref} position={[slot.pos[0], y, slot.pos[2]]}>
      <mesh scale={[1, 1.6, 1]}>
        <octahedronGeometry args={[0.24, 0]} />
        <meshStandardMaterial color={NEON} emissive={NEON} emissiveIntensity={1.6} roughness={0.3} flatShading toneMapped={false} />
      </mesh>
    </group>
  );
}

export function Markers({ layout }: { layout: Layout }) {
  const hoveredId = useStore((s) => s.hoveredId);
  const selectedId = useStore((s) => s.selectedId);
  const hovered = hoveredId ? layout.slots[hoveredId] : undefined;
  const selected = selectedId ? layout.slots[selectedId] : undefined;
  return (
    <>
      {selected && <Ring slot={selected} color={NEON} opacity={0.95} pulse />}
      {selected && <SelectPin slot={selected} />}
      {hovered && hovered !== selected && <Ring slot={hovered} color={ACCENT} opacity={0.6} />}
      {hovered && <HoverTip slot={hovered} />}
    </>
  );
}
