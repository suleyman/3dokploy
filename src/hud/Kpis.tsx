import { useMemo, type ReactNode } from 'react';
import { isActiveDeploy } from '../data/types';
import { rate } from '../format';
import { useStore } from '../store';

export function Kpis() {
  return (
    <section className="kpis" aria-label="Cluster metrics">
      <MetricKpis />
    </section>
  );
}

function Kpi({ label, value, sub, tone, children }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; children?: ReactNode }) {
  return (
    <div className="kpi panel">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub !== undefined && <span className={`kpi-sub ${tone ?? ''}`}>{sub}</span>}
      {children}
    </div>
  );
}

function MetricKpis() {
  const services = useStore((s) => s.services);
  const servers = useStore((s) => s.servers);
  const deployments = useStore((s) => s.deployments);
  const trends = useStore((s) => s.trends);
  const now = useStore((s) => s.now);
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);

  const k = useMemo(() => {
    const all = Object.values(services);
    const hosts = Object.values(servers);
    const cores = hosts.reduce((a, s) => a + (s.vcpu ?? 0), 0);
    const ramGb = hosts.reduce((a, s) => a + (s.ramGb ?? 0), 0);
    const usedCores = all.reduce((a, s) => a + s.cpu, 0);
    return {
      total: all.length,
      up: all.filter((s) => s.status === 'running' || s.status === 'deploying').length,
      down: all.filter((s) => s.status === 'error').length,
      cores,
      usedCores,
      cpu: cores ? usedCores / cores : usedCores,
      memGb: all.reduce((a, s) => a + s.memMb, 0) / 1024,
      ramGb,
      rx: all.reduce((a, s) => a + (s.net?.rxBps ?? 0), 0),
      tx: all.reduce((a, s) => a + (s.net?.txBps ?? 0), 0),
    };
  }, [services, servers]);

  const deploys = useMemo(() => {
    const today = Object.values(deployments).filter((d) => d.createdAt >= startOfDay);
    return {
      today: today.length,
      failed: today.filter((d) => d.status === 'failed').length,
      active: Object.values(deployments).filter(isActiveDeploy).length,
    };
  }, [deployments, startOfDay]);

  return (
    <>
      <Kpi
        label="Nodes up"
        value={
          <>
            {k.up}
            <small> / {k.total}</small>
          </>
        }
        sub={k.down ? `${k.down} down` : 'All healthy'}
        tone={k.down ? 'crit' : 'ok'}
      >
        <Meter value={k.total ? k.up / k.total : 0} health />
      </Kpi>
      <Kpi
        label="CPU"
        value={
          <>
            {Math.round(k.cpu * 100)}
            <small>%</small>
          </>
        }
        sub={k.cores ? `${k.usedCores.toFixed(2)} / ${k.cores} cores` : 'of one core'}
      >
        <Trend values={trends.cpu} />
      </Kpi>
      <Kpi
        label="Memory"
        value={
          <>
            {k.memGb.toFixed(1)}
            <small>{k.ramGb ? ` / ${k.ramGb} GB` : ' GB'}</small>
          </>
        }
        sub={k.ramGb ? `${Math.round((k.memGb / k.ramGb) * 100)}% of host` : undefined}
      >
        <Trend values={trends.mem} />
      </Kpi>
      <Kpi label="Network" value={rate(k.rx + k.tx)} sub={`↓ ${rate(k.rx)} · ↑ ${rate(k.tx)}`}>
        <Trend values={trends.net} />
      </Kpi>
      <Kpi
        label="Deploys today"
        value={deploys.today}
        sub={deploys.active ? `${deploys.active} in progress` : deploys.failed ? `${deploys.failed} failed` : 'No failures'}
        tone={deploys.active ? 'info' : deploys.failed ? 'warn' : ''}
      />
    </>
  );
}

/** Tiny live line under a KPI value; scales to its own min/max so movement stays visible. */
function Trend({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="trend" />;
  const w = 100;
  const h = 18;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`);
  return (
    <svg className="trend" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <path d={`M${pts.join('L')}L${w},${h}L0,${h}Z`} className="trend-area" />
      <path d={`M${pts.join('L')}`} className="trend-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Load meters warn when high; `health` meters (share of nodes up) are green. */
function Meter({ value, health }: { value: number; health?: boolean }) {
  const v = Math.min(1, Math.max(0, value));
  return (
    <span className={`meter ${health ? 'is-ok' : v > 0.8 ? 'is-warn' : ''}`} role="presentation">
      <span style={{ width: `${v * 100}%` }} />
    </span>
  );
}
