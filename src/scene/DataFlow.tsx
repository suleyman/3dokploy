/**
 * Network traffic as packets: every node's measured rx/tx turns into small glowing cubes that
 * travel street → door → spine → rack (received, cyan) or back out (sent, violet).
 * Density grows with the log of the throughput. One InstancedMesh draws all of them.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { approach, type Layout } from '../layout';
import { matchesSearch, useStore } from '../store';
import { ACCENT, NEON } from '../theme';

const CAPACITY = 900;
const SPEED = 3.6;
const IN_Y = 0.14;
const OUT_Y = 0.24;

interface Path {
  pts: THREE.Vector3[];
  cum: number[];
  len: number;
}

interface Packet {
  path: Path;
  out: boolean;
  d: number;
  speed: number;
  jx: number;
  jz: number;
}

function makePath(points: THREE.Vector3[]): Path {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + points[i].distanceTo(points[i - 1]));
  return { pts: points, cum, len: cum[cum.length - 1] };
}

function at(path: Path, d: number, out: THREE.Vector3) {
  const { pts, cum } = path;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  return out.lerpVectors(pts[i - 1], pts[i], Math.min(1, Math.max(0, (d - cum[i - 1]) / seg)));
}

/** packets per second for a byte rate: ~1/s at 1 kB/s, ~3/s at 100 kB/s, capped at 6/s */
const perSecond = (bps: number) => (bps > 50 ? Math.min(6, Math.max(0.15, (Math.log10(bps) - 2.3) * 1.2)) : 0);

export function DataFlow({ layout }: { layout: Layout }) {
  const still = useStore((s) => s.reducedMotion);
  const services = useStore((s) => s.services);
  const projects = useStore((s) => s.projects);
  const environments = useStore((s) => s.environments);
  const search = useStore((s) => s.search);

  // One inbound route per node: from up the street, through the door, down the spine to the rack.
  const paths = useMemo(() => {
    const out = new Map<string, Path>();
    for (const id of Object.keys(layout.slots)) {
      const a = approach(layout, id);
      if (!a) continue;
      const slot = layout.slots[id];
      const pts = [[a[0][0] - 3.2, 0, a[0][2]] as const, ...a, [slot.pos[0], 0, slot.pos[2] + 0.25] as const].map(
        ([x, , z]) => new THREE.Vector3(x, 0, z),
      );
      out.set(id, makePath(pts));
    }
    return out;
  }, [layout]);

  // Current spawn rates, read by the frame loop without re-rendering it.
  const rates = useRef(new Map<string, { rx: number; tx: number }>());
  useEffect(() => {
    const next = new Map<string, { rx: number; tx: number }>();
    for (const svc of Object.values(services)) {
      if (!svc.net || !paths.has(svc.id)) continue;
      if (!matchesSearch(svc, projects[svc.projectId], search, environments[svc.environmentId])) continue;
      next.set(svc.id, { rx: perSecond(svc.net.rxBps), tx: perSecond(svc.net.txBps) });
    }
    rates.current = next;
  }, [services, projects, environments, search, paths]);

  const mesh = useRef<THREE.InstancedMesh>(null);
  const packets = useRef<Packet[]>([]);
  const acc = useRef(new Map<string, number>());
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), m: new THREE.Matrix4() }), []);
  const colors = useMemo(() => ({ in: new THREE.Color(NEON), out: new THREE.Color(ACCENT) }), []);
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.4, 2.4), toneMapped: false, transparent: true, opacity: 0.95 }),
    [],
  );
  const geometry = useMemo(() => new THREE.BoxGeometry(0.07, 0.07, 0.07), []);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    for (let i = 0; i < CAPACITY; i++) m.setColorAt(i, colors.in);
    m.count = 0;
  }, [colors]);

  useEffect(() => {
    packets.current = [];
  }, [paths]);

  useFrame((_, rawDt) => {
    const m = mesh.current;
    if (!m) return;
    if (still) {
      m.count = 0;
      return;
    }
    const dt = Math.min(rawDt, 0.1);
    const list = packets.current;

    // Spawn.
    for (const [id, r] of rates.current) {
      const path = paths.get(id);
      if (!path) continue;
      for (const [key, perSec, out] of [
        [`${id}:in`, r.rx, false],
        [`${id}:out`, r.tx, true],
      ] as const) {
        let a = (acc.current.get(key) ?? Math.random()) + perSec * dt;
        while (a >= 1 && list.length < CAPACITY) {
          a -= 1;
          list.push({ path, out, d: 0, speed: SPEED * (0.8 + Math.random() * 0.4), jx: (Math.random() - 0.5) * 0.18, jz: (Math.random() - 0.5) * 0.18 });
        }
        acc.current.set(key, Math.min(a, 2));
      }
    }

    // Move + draw.
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.d += p.speed * dt;
      if (p.d >= p.path.len) continue;
      at(p.path, p.out ? p.path.len - p.d : p.d, tmp.v);
      tmp.m.makeTranslation(tmp.v.x + p.jx + (p.out ? 0.16 : -0.16), p.out ? OUT_Y : IN_Y, tmp.v.z + p.jz);
      m.setMatrixAt(n, tmp.m);
      m.setColorAt(n, p.out ? colors.out : colors.in);
      list[n++] = p;
    }
    list.length = n;
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return <instancedMesh ref={mesh} args={[geometry, material, CAPACITY]} frustumCulled={false} />;
}
