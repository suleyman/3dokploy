/**
 * Things that make activity readable from far away:
 *  - DeployBeams: a light column, a spinning floor ring and a stage label over every node
 *    that is deploying right now
 *  - Pulses: a one-off shockwave when a deploy finishes (green / red) or a node goes down / up
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { STAGES, isActiveDeploy, type Deployment } from '../data/types';
import { duration } from '../format';
import { type Layout, type Slot } from '../layout';
import { useStore, type ActivityEvent } from '../store';
import { Label } from './Label';

const BEAM = '#3da2ff';
const BEAM_H = 7;

const beamVertex = /* glsl */ `
  varying float vH;
  void main() {
    vH = position.y / ${BEAM_H.toFixed(1)} + 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const beamFragment = /* glsl */ `
  uniform vec3 color;
  uniform float time;
  varying float vH;
  void main() {
    float fade = pow(1.0 - clamp(vH, 0.0, 1.0), 1.7);
    float bands = 0.6 + 0.4 * sin(time * 7.0 - vH * 26.0);
    gl_FragColor = vec4(color * 2.2, fade * bands * 0.5);
  }
`;

export function DeployBeams({ layout }: { layout: Layout }) {
  const services = useStore((s) => s.services);
  const deployments = useStore((s) => s.deployments);

  // Deploying per Dokploy's status, or with a deploy record in flight (mock).
  const active = useMemo(() => {
    const byService = new Map<string, Deployment>();
    for (const d of Object.values(deployments)) if (isActiveDeploy(d)) byService.set(d.serviceId, d);
    return Object.values(services)
      .filter((s) => layout.slots[s.id] && (s.status === 'deploying' || byService.has(s.id)))
      .map((s) => ({ slot: layout.slots[s.id], deploy: byService.get(s.id) }));
  }, [services, deployments, layout]);

  return (
    <>
      {active.map(({ slot, deploy }) => (
        <Beam key={slot.serviceId} slot={slot} deploy={deploy} />
      ))}
    </>
  );
}

function Beam({ slot, deploy }: { slot: Slot; deploy?: Deployment }) {
  const still = useStore((s) => s.reducedMotion);
  const now = useStore((s) => s.now);
  const ring = useRef<THREE.Mesh>(null);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: beamVertex,
        fragmentShader: beamFragment,
        uniforms: { color: { value: new THREE.Color(BEAM) }, time: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ clock }) => {
    if (still) return;
    material.uniforms.time.value = clock.elapsedTime;
    if (ring.current) ring.current.rotation.z = clock.elapsedTime * 1.8;
  });

  const stage = deploy?.stages.findIndex((s) => s === 'running') ?? -1;
  const since = deploy?.startedAt ?? deploy?.createdAt;
  const [x, , z] = slot.pos;

  return (
    <group position={[x, 0, z]}>
      <mesh position-y={BEAM_H / 2} material={material} raycast={() => null}>
        <cylinderGeometry args={[0.62, 0.62, BEAM_H, 32, 1, true]} />
      </mesh>
      <mesh position-y={BEAM_H / 2} raycast={() => null}>
        <cylinderGeometry args={[0.035, 0.035, BEAM_H, 8, 1, true]} />
        <meshBasicMaterial color={new THREE.Color(BEAM).multiplyScalar(3)} toneMapped={false} transparent opacity={0.7} />
      </mesh>
      <mesh ref={ring} position-y={0.06} rotation-x={-Math.PI / 2} raycast={() => null}>
        <ringGeometry args={[0.86, 0.98, 48, 1, 0, Math.PI * 1.5]} />
        <meshBasicMaterial color={new THREE.Color(BEAM).multiplyScalar(2.5)} toneMapped={false} transparent opacity={0.9} side={THREE.DoubleSide} />
      </mesh>
      <Label position={[0, 2.5, 0]} zIndex={10} minZoom={11}>
        <div className="deploy-tag">
          <span className="bubble-spinner" />
          Deploying
          {stage >= 0 && <b>{STAGES[stage]}</b>}
          {since && <span className="num">{duration(now - since)}</span>}
        </div>
      </Label>
    </group>
  );
}

// ---- shockwaves -----------------------------------------------------------------------

const PULSE: Partial<Record<ActivityEvent['kind'], string>> = {
  'deploy-ok': '#2bff9a',
  'deploy-fail': '#ff2e55',
  down: '#ff2e55',
  up: '#2bff9a',
  'new-node': '#2de2ff',
};
const PULSE_S = 1.8;

interface Pulse {
  id: string;
  slot: Slot;
  color: string;
}

export function Pulses({ layout }: { layout: Layout }) {
  const events = useStore((s) => s.events);
  const still = useStore((s) => s.reducedMotion);
  const seen = useRef<Set<string> | null>(null);
  const [pulses, setPulses] = useState<Pulse[]>([]);

  // Only react to events that arrive after mount (the seeded history stays quiet).
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(events.map((e) => e.id));
      return;
    }
    const fresh: Pulse[] = [];
    for (const e of events) {
      if (seen.current.has(e.id)) continue;
      seen.current.add(e.id);
      const color = PULSE[e.kind];
      const slot = e.serviceId && layout.slots[e.serviceId];
      if (color && slot && !still) fresh.push({ id: e.id, slot, color });
    }
    if (fresh.length) setPulses((p) => [...p, ...fresh]);
  }, [events, layout, still]);

  return (
    <>
      {pulses.map((p) => (
        <Shockwave key={p.id} pulse={p} onDone={() => setPulses((all) => all.filter((x) => x.id !== p.id))} />
      ))}
    </>
  );
}

function Shockwave({ pulse, onDone }: { pulse: Pulse; onDone: () => void }) {
  const ring = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const age = useRef(0);
  const finished = useRef(false);
  const color = useMemo(() => new THREE.Color(pulse.color).multiplyScalar(2.6), [pulse.color]);

  useFrame((_, dt) => {
    age.current += dt;
    const t = age.current / PULSE_S;
    if (t >= 1) {
      if (!finished.current) onDone();
      finished.current = true;
      return;
    }
    const ease = 1 - (1 - t) ** 3;
    ring.current?.scale.setScalar(0.6 + ease * 4.2);
    if (mat.current) mat.current.opacity = (1 - t) ** 1.5;
  });

  return (
    <mesh ref={ring} position={[pulse.slot.pos[0], 0.07, pulse.slot.pos[2]]} rotation-x={-Math.PI / 2} raycast={() => null}>
      <ringGeometry args={[0.85, 1, 64]} />
      <meshBasicMaterial ref={mat} color={color} toneMapped={false} transparent depthWrite={false} />
    </mesh>
  );
}
