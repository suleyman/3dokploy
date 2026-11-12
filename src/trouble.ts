/** When a rack smokes or burns. Shared by the scene, the crew and the activity feed. */
import type { Service } from './data/types';

const SMOKE_CPU = 0.85; // cores, sustained
const FIRE_CPU = 2;
export type Trouble = 'smoke' | 'fire' | null;

/** Down (Dokploy, Docker or Kuma) or sustained extreme load → fire; high load → smoke. */
export function trouble(svc: Service): Trouble {
  const recent = svc.cpuHist.slice(-3);
  const cpu = recent.length ? Math.min(...recent) : svc.cpu; // sustained: every recent sample, not one spike
  const mem = svc.memLimitMb > 0 ? svc.memMb / svc.memLimitMb : 0;
  if (svc.status === 'error' || cpu >= FIRE_CPU || mem >= 0.95) return 'fire';
  if (cpu >= SMOKE_CPU || mem >= 0.85) return 'smoke';
  return null;
}
