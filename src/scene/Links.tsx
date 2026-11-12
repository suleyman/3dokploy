/**
 * Who talks to whom: live connections between containers (optional /api/flows, from conntrack).
 * Racks in different buildings are joined by an arc over the roofs, racks in the same building by
 * packets along the aisle; packet density follows the number of open connections. Hovering or
 * selecting a rack lights up its connections (with what they are, e.g. "Postgres · 12") and dims
 * the rest.
 */
import { QuadraticBezierLine } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Link } from '../data/types';
import { routeBetween, type Layout } from '../layout';
import { useStore } from '../store';
import { Label } from './Label';

const LIME = '#b6ff4a';
const CAPACITY = 600;
const ROOF_Y = 1.75;

const PORT_NAME: Record<number, string> = {
  5432: 'Postgres',
  6379: 'Redis',
  3306: 'MySQL',
  27017: 'Mongo',
  5672: 'AMQP',
  9091: 'Authelia',
  8288: 'Inngest',
  8888: 'Proxy',
  80: 'HTTP',
  443: 'HTTPS',
  3000: 'HTTP',
  8000: 'HTTP',
  8080: 'HTTP',
};
export const portName = (p: number) => PORT_NAME[p] ?? `:${p}`;
export const linkLabel = (l: Link) => `${[...new Set(l.ports.map(portName))].join(', ')} · ${l.conns}`;

/** Packets per second each way for a number of open connections: 1 → ~0.6/s, 50 → ~3/s, capped. */
const rate = (conns: number) => Math.min(3.5, 0.4 + Math.log2(conns + 1) * 0.5);

interface Track {
  key: string;
  link: Link;
  /** point at t ∈ [0, 1] */
  at: (t: number, out: THREE.Vector3) => THREE.Vector3;
  length: number;
  arc?: { start: THREE.Vector3; mid: THREE.Vector3; end: THREE.Vector3 };
}

export function Links({ layout }: { layout: Layout }) {
  const links = useStore((s) => s.servers.local?.links);
  const active = useStore((s) => s.selectedId ?? s.hoveredId);
  const still = useStore((s) => s.reducedMotion);

  const tracks = useMemo(() => {
    const out: Track[] = [];
    for (const link of links ?? []) {
      const a = layout.slots[link.from];
      const b = layout.slots[link.to];
      if (!a || !b) continue;
      if (a.projectId === b.projectId) {
        const route = routeBetween(layout, link.from, link.to, 0);
        if (!route) continue;
        const curve = new THREE.CurvePath<THREE.Vector3>();
        for (let i = 1; i < route.length; i++) curve.add(new THREE.LineCurve3(new THREE.Vector3(route[i - 1][0], 0.2, route[i - 1][2]), new THREE.Vector3(route[i][0], 0.2, route[i][2])));
        out.push({ key: `${link.from}>${link.to}`, link, at: (t, o) => o.copy(curve.getPointAt(t)), length: curve.getLength() });
      } else {
        const start = new THREE.Vector3(a.pos[0], ROOF_Y, a.pos[2]);
        const end = new THREE.Vector3(b.pos[0], ROOF_Y, b.pos[2]);
        const dist = start.distanceTo(end);
        const mid = start.clone().lerp(end, 0.5).setY(ROOF_Y + 1.5 + dist * 0.22);
        const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
        out.push({ key: `${link.from}>${link.to}`, link, at: (t, o) => o.copy(curve.getPoint(t)), length: curve.getLength(), arc: { start, mid, end } });
      }
    }
    return out;
  }, [links, layout]);

  return (
    <>
      {tracks.map((t) => {
        if (!t.arc) return null;
        const mine = !!active && (t.link.from === active || t.link.to === active);
        const opacity = active ? (mine ? 0.9 : 0.07) : 0.32;
        return (
          <QuadraticBezierLine
            key={t.key}
            start={t.arc.start}
            end={t.arc.end}
            mid={t.arc.mid}
            color={LIME}
            lineWidth={mine ? 2.4 : 1.2}
            transparent
            opacity={opacity}
            depthWrite={false}
            toneMapped={false}
          />
        );
      })}
      {active &&
        tracks
          .filter((t) => t.link.from === active || t.link.to === active)
          .map((t) => {
            const p = t.at(0.5, new THREE.Vector3());
            return (
              <Label key={`label:${t.key}`} position={[p.x, p.y + 0.25, p.z]} zIndex={6}>
                <div className="link-label">{linkLabel(t.link)}</div>
              </Label>
            );
          })}
      <Packets tracks={tracks} active={active} still={still} />
    </>
  );
}

interface Packet {
  track: Track;
  t: number;
  back: boolean;
  speed: number;
}

function Packets({ tracks, active, still }: { tracks: Track[]; active: string | null; still: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const packets = useRef<Packet[]>([]);
  const acc = useRef(new Map<string, number>());
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), m: new THREE.Matrix4() }), []);

  useFrame((_, rawDt) => {
    const m = mesh.current;
    if (!m) return;
    if (still) {
      m.count = 0;
      return;
    }
    const dt = Math.min(rawDt, 0.1);
    const list = packets.current;
    // spawn: requests go client → server, answers come back
    for (const track of tracks) {
      if (active && track.link.from !== active && track.link.to !== active) continue;
      const perSec = rate(track.link.conns);
      for (const back of [false, true]) {
        const key = `${track.key}:${back}`;
        let a = (acc.current.get(key) ?? Math.random()) + perSec * dt;
        while (a >= 1 && list.length < CAPACITY) {
          a -= 1;
          list.push({ track, t: 0, back, speed: (2.4 * (0.85 + Math.random() * 0.3)) / Math.max(1, track.length) });
        }
        acc.current.set(key, Math.min(a, 2));
      }
    }
    let n = 0;
    for (const p of list) {
      p.t += p.speed * dt;
      if (p.t >= 1 || !tracks.includes(p.track)) continue;
      p.track.at(p.back ? 1 - p.t : p.t, tmp.v);
      tmp.m.makeTranslation(tmp.v.x, tmp.v.y + (p.back ? 0.06 : 0), tmp.v.z);
      m.setMatrixAt(n, tmp.m);
      list[n++] = p;
    }
    list.length = n;
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, CAPACITY]} frustumCulled={false}>
      <sphereGeometry args={[0.045, 8, 6]} />
      <meshBasicMaterial color={LIME} toneMapped={false} />
    </instancedMesh>
  );
}
