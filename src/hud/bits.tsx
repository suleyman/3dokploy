import type { Deployment, ServiceKind, ServiceStatus } from '../data/types';
import { KIND_COLOR, KIND_LABEL, STATUS_LABEL } from '../theme';

const STATUS_TONE: Record<ServiceStatus, string> = { running: 'ok', deploying: 'info', error: 'crit', idle: 'muted' };
const DEPLOY_TONE: Record<Deployment['status'], string> = { queued: 'muted', running: 'info', success: 'ok', failed: 'crit' };
const DEPLOY_LABEL: Record<Deployment['status'], string> = { queued: 'Queued', running: 'Running', success: 'Success', failed: 'Failed' };

export function StatusPill({ status }: { status: ServiceStatus }) {
  return (
    <span className={`pill pill-${STATUS_TONE[status]}`}>
      <i className={`dot dot-${STATUS_TONE[status]} ${status === 'deploying' ? 'is-pulsing' : ''}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function DeployPill({ status }: { status: Deployment['status'] }) {
  return <span className={`pill pill-${DEPLOY_TONE[status]}`}>{DEPLOY_LABEL[status]}</span>;
}

export function StatusDot({ status }: { status: ServiceStatus }) {
  return <i className={`dot dot-${STATUS_TONE[status]}`} aria-label={STATUS_LABEL[status]} />;
}

export function KindBadge({ kind }: { kind: ServiceKind }) {
  return (
    <span className="kind-badge" style={{ ['--kind' as string]: KIND_COLOR[kind] }}>
      {KIND_LABEL[kind]}
    </span>
  );
}

/** CPU history: horizontal grid, filled area, line, and a dot on the latest sample. */
export function Sparkline({ values, width = 300, height = 64 }: { values: number[]; width?: number; height?: number }) {
  const pad = 3;
  const n = Math.max(values.length, 2);
  const x = (i: number) => pad + (i / (n - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - Math.min(1, Math.max(0, v))) * (height - pad * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = pts.length ? `M${pts.join('L')}` : '';
  const area = pts.length ? `${line}L${x(values.length - 1).toFixed(1)},${height - pad}L${x(0).toFixed(1)},${height - pad}Z` : '';
  const last = values[values.length - 1];

  // The SVG stretches to the container; the end dot is HTML so it stays round.
  return (
    <div className="sparkline" role="img" aria-label="CPU history">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={pad} x2={width - pad} y1={y(g)} y2={y(g)} className="spark-grid" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={area} className="spark-area" />
        <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />
      </svg>
      {last !== undefined && (
        <span
          className="spark-dot"
          style={{ left: `${(x(values.length - 1) / width) * 100}%`, top: `${(y(last) / height) * 100}%` }}
        />
      )}
    </div>
  );
}
