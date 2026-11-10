/**
 * Network traffic as packets: every node's measured rx/tx turns into small glowing cubes,
 * received in cyan, sent in violet. Density grows with the log of the throughput. One
 * InstancedMesh draws all of them.
 *
 * Public traffic enters at the Traefik gate and travels avenue → street → door → spine → rack.
 * A helper container (database, cache, broker…) mostly talks to its own app, so its packets run
 * inside the building between the app's rack and its own instead.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { approach, routeBetween, routeFromGate, type Layout, type V3 } from '../layout';
import { matchesSearch, useStore } from '../store';
import { ACCENT, NEON } from '../theme';
import { Label } from './Label';

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

  // "node>peer" pairs, so routes are only rebuilt when the pairing changes, not on every stats tick.
  const peers = Object.values(services)
    .filter((s) => s.peerId)
    .map((s) => `${s.id}>${s.peerId}`)
    .sort()
    .join('|');

  // One inbound route per node: from its app's rack for helpers, otherwise from the gate.
  const paths = useMemo(() => {
    const peerOf = new Map(peers ? peers.split('|').map((p) => p.split('>') as [string, string]) : []);
    const out = new Map<string, Path>();
    for (const id of Object.keys(layout.slots)) {
      const slot = layout.slots[id];
      const peer = peerOf.get(id);
      const route: V3[] | null = (peer && layout.slots[peer] && routeBetween(layout, peer, id, 0)) || routeFromGate(layout, id) || approach(layout, id);
      if (!route) continue;
      const pts = [...route, [slot.pos[0], 0, slot.pos[2] + 0.25] as V3].map(([x, , z]) => new THREE.Vector3(x, 0, z));
      out.set(id, makePath(pts));
    }
    return out;
  }, [layout, peers]);

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

  return (
    <>
      <instancedMesh ref={mesh} args={[geometry, material, CAPACITY]} frustumCulled={false} />
      <Gate at={layout.gate} />
    </>
  );
}

const pctOf = (f?: number) => (f === undefined ? null : Math.round(f * 100));
const level = (p: number | null) => (p === null ? '' : p >= 95 ? 'is-alert' : p >= 85 ? 'is-warn' : '');
const BOUNCE_S = 1.4;

/**
 * Where the internet comes in: a neon arch over the avenue, with the host's disk / memory and,
 * when CrowdSec is connected, the attackers it turned away (each new ban bounces off the gate).
 */
function Gate({ at }: { at: V3 }) {
  const glow = useRef<THREE.MeshBasicMaterial>(null);
  const attacker = useRef<THREE.Mesh>(null);
  const still = useStore((s) => s.reducedMotion);
  const local = useStore((s) => s.servers.local);
  const banAt = local?.banAt;
  const seenBan = useRef(banAt);
  const bounce = useRef(-1);
  useFrame(({ clock }, rawDt) => {
    const t = clock.elapsedTime;
    if (banAt !== seenBan.current) {
      if (seenBan.current !== undefined && !still) bounce.current = 0;
      seenBan.current = banAt;
    }
    const a = attacker.current;
    if (a) {
      if (bounce.current < 0) a.visible = false;
      else {
        bounce.current += Math.min(rawDt, 0.1);
        const p = bounce.current / BOUNCE_S;
        // flies in from the left, hits the arch at p = 0.5, thrown back out
        const x = p < 0.5 ? -4 + p * 8 : -(p - 0.5) * 7;
        a.visible = p < 1;
        a.position.set(x, 0.6 + (p < 0.5 ? 0 : Math.sin((p - 0.5) * Math.PI) * 0.9), 0);
        if (p >= 1) bounce.current = -1;
      }
    }
    const hit = bounce.current >= 0 && Math.abs(bounce.current / BOUNCE_S - 0.5) < 0.12;
    if (glow.current) {
      glow.current.color.set(hit ? '#ff2e55' : NEON);
      if (!still) glow.current.opacity = hit ? 1 : 0.75 + Math.sin(t * 2) * 0.2;
    }
  });
  const disk = pctOf(local?.diskUsed);
  const mem = pctOf(local?.memUsed);
  const W = 1.5;
  const H = 1.25;
  return (
    <group position={at}>
      {[-W / 2, W / 2].map((x) => (
        <mesh key={x} position={[x, H / 2, 0]}>
          <boxGeometry args={[0.1, H, 0.1]} />
          <meshStandardMaterial color="#0d1a2b" emissive={NEON} emissiveIntensity={0.25} />
        </mesh>
      ))}
      <mesh position={[0, H, 0]}>
        <boxGeometry args={[W + 0.1, 0.1, 0.1]} />
        <meshBasicMaterial ref={glow} color={NEON} toneMapped={false} transparent opacity={0.9} />
      </mesh>
      <mesh position={[0, 0.005, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[W, 0.5]} />
        <meshBasicMaterial color={NEON} toneMapped={false} transparent opacity={0.12} depthWrite={false} />
      </mesh>
      <mesh ref={attacker} visible={false}>
        <boxGeometry args={[0.16, 0.16, 0.16]} />
        <meshBasicMaterial color="#ff2e55" toneMapped={false} />
      </mesh>
      <Label position={[0, H + 0.45, 0]} zIndex={4}>
        <div className="gate-panel">
          <strong>Traefik · Internet</strong>
          {local?.bansActive !== undefined && (
            <span>
              🛡 {local.bansToday ?? 0} blocked today · {local.bansActive} active
            </span>
          )}
          {(disk !== null || mem !== null) && (
            <span>
              {disk !== null && <span className={level(disk)}>Disk {disk}%</span>}
              {disk !== null && mem !== null && ' · '}
              {mem !== null && <span className={level(mem)}>RAM {mem}%</span>}
            </span>
          )}
        </div>
      </Label>
    </group>
  );
}
