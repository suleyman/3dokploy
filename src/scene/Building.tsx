import type { ThreeEvent } from '@react-three/fiber';
import { memo, useMemo } from 'react';
import * as THREE from 'three';
import { DOOR_W, WALL, type BuildingLayout, type ZoneLayout } from '../layout';
import { useStore } from '../store';
import { NEON } from '../theme';
import { Label } from './Label';

const SLAB = 0.03;
const GLASS = '#122440';
const FLOOR = '#070c17';
const SPINE = '#0b1324';
const TRIM = 0.045;
/** Thin glowing line on the floor. */
const LINE = 0.035;

interface WallProps {
  /** centre, local to the building */
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: string;
  opacity: number;
  glow: number;
  /** Low front/right walls sit in front of racks: let clicks pass through them. */
  pickable?: boolean;
}

const noRaycast = () => null;

/** Dark glass panel with a neon top edge in the project colour. */
function Wall({ x, z, w, d, h, color, opacity, glow, pickable = true }: WallProps) {
  return (
    <group position={[x, 0, z]}>
      <mesh position-y={h / 2} receiveShadow renderOrder={1} raycast={pickable ? undefined : noRaycast}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={GLASS} metalness={0.6} roughness={0.15} transparent opacity={opacity} depthWrite={false} />
      </mesh>
      <mesh position-y={h + TRIM / 2} raycast={noRaycast}>
        <boxGeometry args={[w + 0.01, TRIM, d + 0.01]} />
        <meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={glow} toneMapped={false} />
      </mesh>
    </group>
  );
}

function GlowLine({ x, z, w, d, color, intensity = 1.6 }: { x: number; z: number; w: number; d: number; color: string; intensity?: number }) {
  return (
    <mesh position={[x, SLAB + 0.006, z]} raycast={noRaycast}>
      <boxGeometry args={[w, 0.008, d]} />
      <meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={intensity} toneMapped={false} />
    </mesh>
  );
}

export const Building = memo(function Building({ b }: { b: BuildingLayout }) {
  const project = useStore((s) => s.projects[b.projectId]);
  const environments = useStore((s) => s.environments);
  const services = useStore((s) => s.services);
  const color = project?.color ?? NEON;
  const hovered = useStore((s) => s.hoveredProjectId === b.projectId);
  const focused = useStore((s) => s.selectedProjectId === b.projectId);
  // Trims brighten on hover / focus; that's the only highlight, so the scene stays calm.
  const glow = focused ? 3.6 : hovered ? 3.1 : 2.2;
  const lineGlow = focused ? 1.8 : hovered ? 1.5 : 0.9;

  const meta = useMemo(() => {
    const nodes = Object.values(services).filter((s) => s.projectId === b.projectId);
    const down = nodes.filter((s) => s.status === 'error').length;
    const deploying = nodes.filter((s) => s.status === 'deploying').length;
    const envs = b.zones.map((z) => environments[z.environmentId]?.name).filter(Boolean);
    return { nodes: nodes.length, down, deploying, envs };
  }, [services, environments, b]);

  const t = WALL.t;
  const doorX = b.doorX - b.x;
  const leftSeg = doorX - DOOR_W / 2;
  const rightSeg = b.w - (doorX + DOOR_W / 2);
  const cx = b.x + b.w / 2;
  const cz = b.z + b.d / 2;

  const { hoverProject, focusProject } = useStore.getState();
  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    hoverProject(b.projectId);
    document.body.style.cursor = 'pointer';
  };
  const out = () => {
    if (useStore.getState().hoveredProjectId === b.projectId) hoverProject(null);
    document.body.style.cursor = '';
  };
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    focusProject(b.projectId);
  };

  return (
    <group>
      <group position={[b.x, 0, b.z]} onPointerOver={over} onPointerOut={out} onClick={click}>
        <mesh position={[b.w / 2, SLAB / 2, b.d / 2]} receiveShadow>
          <boxGeometry args={[b.w, SLAB, b.d]} />
          <meshStandardMaterial color={FLOOR} roughness={0.55} metalness={0.4} />
        </mesh>

        {/* back + left: tall glass; front + right: low so the floor stays visible */}
        <Wall x={b.w / 2} z={t / 2} w={b.w} d={t} h={WALL.high} color={color} opacity={0.62} glow={glow} />
        <Wall x={t / 2} z={b.d / 2} w={t} d={b.d - t * 2} h={WALL.high} color={color} opacity={0.62} glow={glow} />
        <Wall x={b.w - t / 2} z={b.d / 2} w={t} d={b.d - t * 2} h={WALL.low} color={color} opacity={0.8} glow={glow} pickable={false} />
        <Wall x={leftSeg / 2} z={b.d - t / 2} w={leftSeg} d={t} h={WALL.low} color={color} opacity={0.8} glow={glow} pickable={false} />
        <Wall x={b.w - rightSeg / 2} z={b.d - t / 2} w={rightSeg} d={t} h={WALL.low} color={color} opacity={0.8} glow={glow} pickable={false} />

        {/* door posts */}
        {[doorX - DOOR_W / 2, doorX + DOOR_W / 2].map((x) => (
          <mesh key={x} position={[x, WALL.low / 2 + 0.08, b.d - t / 2]} raycast={noRaycast}>
            <boxGeometry args={[0.06, WALL.low + 0.16, t + 0.06]} />
            <meshStandardMaterial color="#000000" emissive={NEON} emissiveIntensity={2.4} toneMapped={false} />
          </mesh>
        ))}
      </group>

      {/* holographic footprint just outside the walls */}
      <GlowLine x={cx} z={b.z - 0.12} w={b.w + 0.24} d={LINE} color={color} intensity={lineGlow} />
      <GlowLine x={cx} z={b.z + b.d + 0.12} w={b.w + 0.24} d={LINE} color={color} intensity={lineGlow} />
      <GlowLine x={b.x - 0.12} z={cz} w={LINE} d={b.d + 0.24} color={color} intensity={lineGlow} />
      <GlowLine x={b.x + b.w + 0.12} z={cz} w={LINE} d={b.d + 0.24} color={color} intensity={lineGlow} />

      {/* spine corridor from the door to the back row, with guide lights on both edges */}
      <mesh position={[b.spine.x, SLAB + 0.002, (b.spine.z0 + b.spine.z1) / 2]} rotation-x={-Math.PI / 2} receiveShadow raycast={noRaycast}>
        <planeGeometry args={[b.spine.w, b.spine.z1 - b.spine.z0]} />
        <meshStandardMaterial color={SPINE} roughness={0.6} metalness={0.3} />
      </mesh>
      {[-1, 1].map((side) => (
        <GlowLine
          key={side}
          x={b.spine.x + side * (b.spine.w / 2 - 0.08)}
          z={(b.spine.z0 + b.spine.z1) / 2}
          w={0.025}
          d={b.spine.z1 - b.spine.z0}
          color={NEON}
          intensity={1.1}
        />
      ))}

      {b.zones.map((zone) => (
        <Zone key={zone.environmentId} zone={zone} color={color} labelled={b.zones.length > 1} />
      ))}

      {project && (
        // A nameplate on the street in front of the building: never covers racks or neighbours.
        <Label position={[cx, 0, b.z + b.d + 1.1]} zIndex={4} minZoom={13}>
          <div
            className={`building-label ${focused ? 'is-focused' : ''}`}
            style={{ ['--tone' as string]: color }}
            onClick={(e) => {
              // The label lives inside R3F's event container: without this the click would also
              // reach the canvas as a "missed" click and clear the selection again.
              e.stopPropagation();
              focusProject(b.projectId);
            }}
            onMouseEnter={() => hoverProject(b.projectId)}
            onMouseLeave={() => useStore.getState().hoveredProjectId === b.projectId && hoverProject(null)}
          >
            <span className="building-name">{project.name}</span>
            <span className="building-meta">
              {meta.nodes} node{meta.nodes === 1 ? '' : 's'}
              {meta.down > 0 && <b> · {meta.down} down</b>}
              {meta.deploying > 0 && <em> · deploying</em>}
              {meta.envs.length > 1 && <> · {meta.envs.length} envs</>}
            </span>
          </div>
        </Label>
      )}
    </group>
  );
});

/** `labelled`: only name environments when a project has more than one. */
const Zone = memo(function Zone({ zone, color, labelled }: { zone: ZoneLayout; color: string; labelled: boolean }) {
  const env = useStore((s) => s.environments[zone.environmentId]);
  const w = zone.x1 - zone.x0;
  const d = zone.z1 - zone.z0;
  const tint = useMemo(() => new THREE.Color(color), [color]);
  return (
    <group>
      <mesh position={[zone.x0 + w / 2, SLAB + 0.004, zone.z0 + d / 2]} rotation-x={-Math.PI / 2} raycast={noRaycast}>
        <planeGeometry args={[w, d]} />
        <meshBasicMaterial color={tint} transparent opacity={0.07} depthWrite={false} toneMapped={false} />
      </mesh>
      <GlowLine x={zone.x0 + w / 2} z={zone.z1} w={w} d={LINE} color={color} intensity={1.8} />
      <GlowLine x={zone.x0 + w / 2} z={zone.z0} w={w} d={0.02} color={color} intensity={0.7} />
      {env && labelled && (
        <Label position={[zone.x0 - 0.1, SLAB, zone.z0 + 0.1]} anchor="right" zIndex={3} minZoom={17}>
          <div className="zone-label" style={{ ['--zone' as string]: color }}>
            {env.name}
          </div>
        </Label>
      )}
    </group>
  );
});
