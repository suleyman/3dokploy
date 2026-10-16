import { Environment, Lightformer, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js';
import { WALL, type BuildingLayout, type Layout } from '../layout';
import { useStore } from '../store';
import { ACCENT, BG, NEON } from '../theme';
import { Agents } from './Agents';
import { DataFlow } from './DataFlow';
import { DeployBeams, Pulses } from './Effects';
import { InfiniteGrid } from './InfiniteGrid';
import { Building } from './Building';
import { animateLeds } from './materials';
import { Markers, ServiceUnit } from './Rack';

/** Isometric-ish offset from the orbit target. */
const OFFSET = new THREE.Vector3(26, 27, 30);
const MIN_ZOOM = 6;
const MAX_ZOOM = 160;
const ZOOM_STEP = 1.35;
/** Selecting a node from far away flies in to at least this zoom. */
const NODE_ZOOM = 48;
/** How far (world units) the orbit target may wander outside the buildings. */
const PAN_MARGIN = 8;

export function Scene() {
  const layout = useStore((s) => s.layout);
  const carts = useStore((s) => s.capabilities.deployments);
  const technician = useStore((s) => s.capabilities.simulation);
  const metrics = useStore((s) => s.capabilities.metrics);
  const session = useStore((s) => s.session);

  return (
    <Canvas
      className="scene"
      shadows="percentage"
      flat
      orthographic
      dpr={[1, 2]}
      gl={{ antialias: false }}
      // Orthographic: a negative near plane keeps the floor in front of the camera visible when zoomed far out.
      camera={{ position: OFFSET.toArray(), zoom: 30, near: -1000, far: 2000 }}
      onPointerMissed={() => useStore.getState().clearSelection()}
    >
      <color attach="background" args={[BG]} />
      <fog attach="fog" args={[BG, 70, 150]} />
      <hemisphereLight args={['#6f8fd8', '#03060c', 0.85]} />
      <directionalLight
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
      <directionalLight color={NEON} position={[24, 10, -24]} intensity={0.5} />

      {/* Local studio env (no network): gives the metal cabinets cyan/violet reflections. */}
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={2.2} color={NEON} position={[-10, 6, -8]} scale={[14, 2, 1]} />
        <Lightformer form="rect" intensity={1.6} color={ACCENT} position={[10, 8, 8]} scale={[12, 2, 1]} />
        <Lightformer form="ring" intensity={0.8} color="#ffffff" position={[0, 14, 0]} scale={6} />
      </Environment>

      <Ground />
      <LedDriver />
      {layout && (
        // Keyed by session: switching Dokploy ↔ demo rebuilds agents, effects and the camera fit.
        <group key={session}>
          {layout.buildings.map((b) => (
            <Building key={b.projectId} b={b} />
          ))}
          {Object.values(layout.slots).map((slot) => (
            <ServiceUnit key={slot.serviceId} slot={slot} />
          ))}
          <Markers layout={layout} />
          {carts && <Agents layout={layout} technician={technician ? 'fix' : 'watch'} />}
          <DeployBeams layout={layout} />
          <Pulses layout={layout} />
          {metrics && <DataFlow layout={layout} />}
          <CameraRig layout={layout} />
        </group>
      )}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minPolarAngle={0.35}
        maxPolarAngle={1.15}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        zoomSpeed={0.9}
        zoomToCursor
        // Wheel is handled in CameraRig (mouse zooms, trackpad pans); OrbitControls keeps
        // left-drag rotate, right/middle-drag pan and touch pinch.
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }}
      />

      {/* Only emissive surfaces above ~1 (LEDs, trims, bands) cross the threshold and glow. */}
      <EffectComposer multisampling={4}>
        <Bloom mipmapBlur intensity={0.85} luminanceThreshold={0.9} luminanceSmoothing={0.15} radius={0.65} />
        <Vignette offset={0.32} darkness={0.45} />
      </EffectComposer>
    </Canvas>
  );
}

/** Background-coloured floor (no visible edge), an endless neon grid, and a shadow catcher. */
function Ground() {
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.004}>
        <planeGeometry args={[1200, 1200]} />
        <meshBasicMaterial color={BG} toneMapped={false} />
      </mesh>
      <InfiniteGrid cellSize={1.2} sectionSize={6} cellColor="#0c1a2e" sectionColor="#14406a" />
      <mesh rotation-x={-Math.PI / 2} position-y={0} receiveShadow>
        <planeGeometry args={[240, 240]} />
        <shadowMaterial transparent opacity={0.45} />
      </mesh>
    </>
  );
}

function LedDriver() {
  const still = useStore((s) => s.reducedMotion);
  useFrame(({ clock }) => animateLeds(clock.elapsedTime, still));
  return null;
}

// ---- camera ---------------------------------------------------------------------------

interface CameraAnim {
  target?: THREE.Vector3;
  position?: THREE.Vector3;
  zoom?: number;
}

/** Building box plus the nameplate on the street in front of it. */
const corners = (b: BuildingLayout) =>
  [b.x, b.x + b.w].flatMap((x) => [b.z, b.z + b.d + 1.6].flatMap((z) => [0, WALL.high + 0.9].map((y) => new THREE.Vector3(x, y, z))));

/** Opening / reset view: every building (and the technician's spot when agents are on). */
function fitView(layout: Layout, width: number, height: number, agents: boolean) {
  const pts = layout.buildings.flatMap(corners);
  if (agents || !pts.length) pts.push(new THREE.Vector3(...layout.home), new THREE.Vector3(...layout.home).setY(1.2));
  return fitPoints(pts, width, height, 1);
}

/**
 * Zoom so `pts` fit in the part of the viewport the HUD leaves free (times `fill`), and slide the
 * target along the floor so they sit in the middle of that area.
 */
function fitPoints(pts: THREE.Vector3[], width: number, height: number, fill: number) {
  const dir = OFFSET.clone().normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(Math.max(1, pts.length)).setY(0);

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    p.sub(c);
    x0 = Math.min(x0, p.dot(right));
    x1 = Math.max(x1, p.dot(right));
    y0 = Math.min(y0, p.dot(up));
    y1 = Math.max(y1, p.dot(up));
  }

  // Desktop: keep clear of the top bar + KPIs, the ops panel column on the right and the bottom panels.
  const pad = width < 860 ? { t: 160, b: 260, l: 16, r: 56 } : { t: 240, b: 150, l: 24, r: 80 };
  const availW = Math.max(160, width - pad.l - pad.r);
  const availH = Math.max(160, height - pad.t - pad.b);
  const zoom = THREE.MathUtils.clamp(fill * Math.min(availW / (x1 - x0), availH / (y1 - y0)), MIN_ZOOM, MAX_ZOOM);

  // Screen offset (px) of the free area's centre from the viewport centre, converted to a floor shift.
  const dx = (x0 + x1) / 2 - (pad.l + availW / 2 - width / 2) / zoom;
  const dy = (y0 + y1) / 2 + (pad.t + availH / 2 - height / 2) / zoom;
  const floorUp = up.clone().setY(0);
  const k = floorUp.lengthSq() ? dy / floorUp.length() : 0;
  const target = c.add(right.multiplyScalar(dx)).add(floorUp.normalize().multiplyScalar(k));
  return { zoom, target };
}

/** Keeps the orbit target near the buildings so panning can't lose the scene. */
function clampTarget(controls: OrbitControlsImpl, camera: THREE.Camera, layout: Layout) {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const t = controls.target;
  const x = THREE.MathUtils.clamp(t.x, minX - PAN_MARGIN, maxX + PAN_MARGIN);
  const z = THREE.MathUtils.clamp(t.z, minZ - PAN_MARGIN, maxZ + PAN_MARGIN);
  if (x === t.x && z === t.z) return;
  camera.position.x += x - t.x;
  camera.position.z += z - t.z;
  t.x = x;
  t.z = z;
}

/** Where a focused rack should land on screen (px from centre): the middle of the area the inspector leaves free. */
function focusOffsetPx(width: number, height: number): [number, number] {
  if (width < 860) return [0, (150 + height * 0.38) / 2 - height / 2];
  return [(width - 416) / 2 - width / 2, -15];
}

/** Moves the orbit target along the floor so `point` shows up `px` pixels from the screen centre. */
function offsetTarget(camera: THREE.Camera, point: THREE.Vector3, [ox, oy]: [number, number], zoom: number) {
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const floorUp = up.clone().setY(0);
  const len = floorUp.length();
  const out = point.clone().addScaledVector(right, -ox / zoom);
  if (len > 1e-3) out.addScaledVector(floorUp.normalize(), oy / zoom / len);
  return out;
}

function CameraRig({ layout }: { layout: Layout }) {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const size = useThree((s) => s.size);
  const still = useStore((s) => s.reducedMotion);
  const agents = useStore((s) => s.capabilities.simulation);
  const anim = useRef<CameraAnim | null>(null);
  const placed = useRef(false);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const gl = useThree((s) => s.gl);

  // Direct manipulation: wheel / pinch / trackpad / Space-drag. Each one cancels a camera flight.
  useEffect(() => {
    const canvas = gl.domElement;
    const el = canvas.parentElement;
    if (!controls || !el) return;

    const ray = new THREE.Raycaster();
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ndc = new THREE.Vector2();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();

    const ground = (cx: number, cy: number) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      return ray.ray.intersectPlane(floor, new THREE.Vector3());
    };
    const shift = (d: THREE.Vector3) => {
      controls.target.add(d);
      camera.position.add(d);
    };
    /** Zoom keeping the floor point under the cursor fixed. */
    const zoomAt = (cx: number, cy: number, factor: number) => {
      anim.current = null;
      const before = ground(cx, cy);
      camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      camera.updateProjectionMatrix();
      const after = ground(cx, cy);
      if (before && after) shift(before.sub(after));
    };
    /** Move the picture by (dx, dy) screen pixels, sliding along the floor. */
    const panBy = (dx: number, dy: number) => {
      anim.current = null;
      camera.updateMatrixWorld();
      right.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
      up.setFromMatrixColumn(camera.matrixWorld, 1).setY(0);
      const len = up.length();
      up.normalize();
      shift(right.multiplyScalar(-dx / camera.zoom).add(up.multiplyScalar(len > 1e-3 ? dy / camera.zoom / len : 0)));
    };

    // Mouse wheel zooms at the cursor; a trackpad's two-finger scroll pans; pinch (ctrlKey) zooms.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation(); // keep OrbitControls' own wheel zoom out of it
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1;
      const dx = e.deltaX * k;
      const dy = e.deltaY * k;
      if (e.ctrlKey || e.metaKey) return zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.012));
      const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
      const trackpad = dx !== 0 || (legacy ? legacy === -3 * e.deltaY : e.deltaMode === 0);
      if (trackpad) panBy(-dx, -dy);
      else zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0016));
    };

    // Hold Space to grab the floor and drag it around.
    let space = false;
    let dragging = false;
    let dragged = false;
    let over = false;
    let last = { x: 0, y: 0 };
    const cursor = () => (canvas.style.cursor = dragging ? 'grabbing' : space ? 'grab' : '');
    const release = () => {
      space = false;
      dragging = false;
      controls.enabled = true;
      cursor();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('input, textarea, [contenteditable]')) return;
      if (t?.closest('button, a') && !over) return; // a focused HUD button keeps its Space
      e.preventDefault();
      if (space) return;
      space = true;
      controls.enabled = false;
      cursor();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !space) return;
      space = false;
      if (!dragging) controls.enabled = true;
      cursor();
    };
    const onDown = (e: PointerEvent) => {
      if (!space || e.button !== 0) return;
      // Capture phase: R3F (select) and OrbitControls (rotate) never see this press.
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      dragged = false;
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      cursor();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      e.stopPropagation();
      if (Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y) > 0) dragged = true;
      panBy(e.clientX - last.x, e.clientY - last.y);
      last = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      e.stopPropagation();
      dragging = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (!space) controls.enabled = true;
      cursor();
    };
    const onClick = (e: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      e.stopPropagation(); // a drag is not a click (no selecting / deselecting)
    };
    const onEnter = () => (over = true);
    const onLeave = () => (over = false);

    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('pointermove', onMove, true);
    el.addEventListener('pointerup', onUp, true);
    el.addEventListener('click', onClick, true);
    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('pointerleave', onLeave);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    return () => {
      el.removeEventListener('wheel', onWheel, true);
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('pointermove', onMove, true);
      el.removeEventListener('pointerup', onUp, true);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      release();
    };
  }, [gl, camera, controls]);

  // Opening shot: centred and fitted to the viewport.
  useEffect(() => {
    if (!controls || placed.current) return;
    placed.current = true;
    const view = fitView(layout, sizeRef.current.width, sizeRef.current.height, true);
    controls.target.copy(view.target);
    camera.position.copy(view.target).add(OFFSET);
    camera.zoom = view.zoom;
    camera.updateProjectionMatrix();
    controls.update();
  }, [controls, camera, layout, agents]);

  // Any user input cancels a running camera animation.
  useEffect(() => {
    if (!controls) return;
    const stop = () => (anim.current = null);
    controls.addEventListener('start', stop);
    return () => controls.removeEventListener('start', stop);
  }, [controls]);

  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.focus && s.focus !== prev.focus && s.focus.kind === 'project') {
          const b = layout.buildings.find((x) => x.projectId === s.focus!.id);
          if (b) {
            const view = fitPoints(corners(b), sizeRef.current.width, sizeRef.current.height, 0.7);
            anim.current = { target: view.target, zoom: Math.min(view.zoom, 70) };
          }
        } else if (s.focus && s.focus !== prev.focus) {
          const slot = layout.slots[s.focus.id];
          if (slot) {
            // Fly in when the node is selected from far away; keep the user's zoom otherwise.
            const { width, height } = sizeRef.current;
            const zoom = Math.min(MAX_ZOOM, Math.max(anim.current?.zoom ?? camera.zoom, NODE_ZOOM));
            const target = new THREE.Vector3(slot.pos[0], 0.6, slot.pos[2]);
            anim.current = { target: offsetTarget(camera, target, focusOffsetPx(width, height), zoom), zoom };
          }
        }
        if (s.camera && s.camera !== prev.camera) {
          const z = anim.current?.zoom ?? camera.zoom;
          switch (s.camera.kind) {
            case 'zoomIn':
              anim.current = { ...anim.current, zoom: Math.min(MAX_ZOOM, z * ZOOM_STEP) };
              break;
            case 'zoomOut':
              anim.current = { ...anim.current, zoom: Math.max(MIN_ZOOM, z / ZOOM_STEP) };
              break;
            case 'pan': {
              // Arrow keys: move one screen-step along the floor, relative to the current view.
              camera.updateMatrixWorld();
              const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
              const fwd = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).setY(0).normalize();
              const step = 160 / z;
              const from = anim.current?.target ?? controls?.target ?? new THREE.Vector3();
              anim.current = {
                ...anim.current,
                target: from.clone().addScaledVector(right, (s.camera.dx ?? 0) * step).addScaledVector(fwd, (s.camera.dz ?? 0) * step),
              };
              break;
            }
            case 'reset': {
              const view = fitView(layout, sizeRef.current.width, sizeRef.current.height, true);
              anim.current = { target: view.target, position: view.target.clone().add(OFFSET), zoom: view.zoom };
              break;
            }
          }
        }
      }),
    [layout, camera, agents, controls],
  );

  useFrame((_, dt) => {
    if (controls) clampTarget(controls, camera, layout);
    const a = anim.current;
    if (!a || !controls) return;
    const k = still ? 1 : 1 - Math.exp(-dt * 7);
    let done = true;

    if (a.target) {
      tmp.subVectors(a.target, controls.target).multiplyScalar(k);
      controls.target.add(tmp);
      // Pan: keep the viewing angle by moving the camera with the target.
      if (!a.position) camera.position.add(tmp);
      if (controls.target.distanceToSquared(a.target) > 1e-4) done = false;
    }
    if (a.position) {
      camera.position.lerp(a.position, k);
      if (camera.position.distanceToSquared(a.position) > 1e-4) done = false;
    }
    if (a.zoom !== undefined) {
      camera.zoom += (a.zoom - camera.zoom) * k;
      camera.updateProjectionMatrix();
      if (Math.abs(a.zoom - camera.zoom) > 0.02) done = false;
    }
    if (done) anim.current = null;
  });

  return null;
}
