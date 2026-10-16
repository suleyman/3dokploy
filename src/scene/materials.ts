/**
 * Shared geometries and status materials. One material per (status × dimmed), animated once per
 * frame by <LedDriver/>, so each rack only picks a reference. This keeps Rack trivially portable
 * to <Instances> later.
 *
 * Emissive intensities above ~1 are what the bloom pass picks up (see Scene.tsx), so "glow" is
 * controlled here, not in the post-processing.
 */
import * as THREE from 'three';
import type { ServiceStatus } from '../data/types';
import { RACK, TANK } from '../layout';

export const DIM_OPACITY = 0.18;

export const LED_COLOR: Record<ServiceStatus, string> = {
  running: '#2bff9a',
  deploying: '#3da2ff',
  error: '#ff2e55',
  idle: '#3a4456',
};

const STATUSES: ServiceStatus[] = ['running', 'deploying', 'error', 'idle'];

function ledMaterials(dim: boolean) {
  return Object.fromEntries(
    STATUSES.map((s) => [
      s,
      new THREE.MeshStandardMaterial({
        color: '#000000',
        emissive: LED_COLOR[s],
        emissiveIntensity: 1,
        roughness: 0.4,
        toneMapped: false,
        transparent: dim,
        opacity: dim ? DIM_OPACITY : 1,
      }),
    ]),
  ) as Record<ServiceStatus, THREE.MeshStandardMaterial>;
}

const LED = ledMaterials(false);
const LED_DIM = ledMaterials(true);

export const ledMaterial = (status: ServiceStatus, dim: boolean) => (dim ? LED_DIM : LED)[status];

/** running breathes, deploying pulses fast, error blinks, idle stays dim. */
export function animateLeds(t: number, still: boolean) {
  const level: Record<ServiceStatus, number> = still
    ? { running: 1.8, deploying: 2, error: 2.4, idle: 0.8 }
    : {
        running: 1.3 + 0.9 * (0.5 + 0.5 * Math.sin(t * 2.1)),
        deploying: 0.6 + 2.4 * (0.5 + 0.5 * Math.sin(t * 11)) ** 2,
        error: (t * 2.2) % 1 < 0.55 ? 3 : 0.15,
        idle: 0.8,
      };
  for (const s of STATUSES) {
    LED[s].emissiveIntensity = level[s];
    LED_DIM[s].emissiveIntensity = level[s] * 0.4;
  }
}

export const GEO = {
  rackBody: new THREE.BoxGeometry(RACK.w, RACK.h, RACK.d),
  rackLid: new THREE.BoxGeometry(RACK.w + 0.04, 0.06, RACK.d + 0.04),
  rackDoor: new THREE.BoxGeometry(RACK.w - 0.12, RACK.h - 0.18, 0.012),
  rackLed: new THREE.BoxGeometry(RACK.w - 0.32, 0.034, 0.014),
  rackFoot: new THREE.BoxGeometry(RACK.w - 0.06, 0.05, RACK.d - 0.06),
  replica: new THREE.PlaneGeometry(0.11, 0.11),
  tankBody: new THREE.CylinderGeometry(TANK.r, TANK.r, TANK.h, 32),
  tankDome: new THREE.SphereGeometry(TANK.r, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2),
  tankBand: new THREE.CylinderGeometry(TANK.r + 0.008, TANK.r + 0.008, 0.07, 32, 1, true),
  tankBase: new THREE.CylinderGeometry(TANK.r + 0.05, TANK.r + 0.07, 0.08, 32),
  tankLed: new THREE.SphereGeometry(0.06, 16, 12),
  ring: new THREE.RingGeometry(0.74, 0.84, 64),
};

export const CABINET = '#0b111c';
export const CABINET_DOOR = '#111a29';
export const TANK_BODY = '#121b2b';

const DARK = new THREE.Color(CABINET);
const STEEL = new THREE.Color(TANK_BODY);
const ORANGE = new THREE.Color('#ff9f1a');
const RED = new THREE.Color('#ff2e55');

/** Heatmap colour: base → orange → red as CPU climbs. */
export function heatColor(cpu: number, base: 'cabinet' | 'tank', out = new THREE.Color()) {
  const t = Math.min(1, Math.max(0, cpu / 0.85));
  return t < 0.5
    ? out.copy(base === 'cabinet' ? DARK : STEEL).lerp(ORANGE, t / 0.5)
    : out.copy(ORANGE).lerp(RED, (t - 0.5) / 0.5);
}
