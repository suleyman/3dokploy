import { useMemo } from 'react';
import { isDb } from '../data/types';
import { ago, duration, mb, pct, rate } from '../format';
import { activeDeployFor, latestDeploys, useStore } from '../store';
import { TRIGGER_LABEL } from '../theme';
import { DeployPill, KindBadge, Sparkline, StatusPill } from './bits';
import { CloseIcon, ExternalIcon, PlayIcon, PowerIcon, RocketIcon } from './icons';

export function Inspector() {
  const id = useStore((s) => s.selectedId);
  const svc = useStore((s) => (id ? s.services[id] : undefined));
  const project = useStore((s) => (svc ? s.projects[svc.projectId] : undefined));
  const env = useStore((s) => (svc ? s.environments[svc.environmentId] : undefined));
  const server = useStore((s) => (svc ? s.servers[svc.serverId] : undefined));
  const caps = useStore((s) => s.capabilities);
  const deployments = useStore((s) => s.deployments);
  const now = useStore((s) => s.now);

  const recent = useMemo(() => (id ? latestDeploys(deployments, id, 3) : []), [deployments, id]);
  const active = useMemo(() => (id ? activeDeployFor(deployments, id) : undefined), [deployments, id]);

  if (!svc) return null;

  const memRatio = svc.memLimitMb ? svc.memMb / svc.memLimitMb : 0;
  const db = isDb(svc.kind);
  const { redeploy, setRunning, select, focusProject } = useStore.getState();

  return (
    <aside className="inspector panel" aria-label={`${svc.name} details`}>
      <header className="insp-head">
        <div className="insp-title">
          <KindBadge kind={svc.kind} />
          <h2>{svc.name}</h2>
          <p className="muted">
            <button type="button" className="link" onClick={() => focusProject(svc.projectId)}>
              {project?.name}
            </button>
            {env && <> · {env.name}</>}
          </p>
        </div>
        <button type="button" className="icon-btn ghost" onClick={() => select(null)} aria-label="Close inspector">
          <CloseIcon />
        </button>
      </header>

      <div className="insp-row">
        <StatusPill status={svc.status} />
        {svc.domain ? (
          <a className="domain mono" href={`https://${svc.domain}`} target="_blank" rel="noreferrer noopener">
            {svc.domain}
            <ExternalIcon />
          </a>
        ) : (
          // Live payloads don't include domains yet, so only claim "none" when the data is complete.
          caps.metrics && <span className="muted small">No public domain</span>
        )}
      </div>

      {svc.description && <p className="insp-desc">{svc.description}</p>}

      {caps.metrics && (
        <>
          <section className="insp-card">
            <div className="insp-card-head">
              <span className="label">CPU</span>
              <span className="value num">{pct(svc.cpu)}</span>
            </div>
            <Sparkline values={svc.cpuHist} height={48} />
            <div className="spark-axis muted">
              <span>{svc.cpuHist.length > 1 ? `${duration(svc.cpuHist.length * caps.sampleSeconds * 1000)} ago` : 'collecting…'}</span>
              <span>now</span>
            </div>
          </section>

          <section className="insp-card">
            <div className="insp-card-head">
              <span className="label">Memory</span>
              <span className="value num">
                {mb(svc.memMb)} <span className="muted">/ {mb(svc.memLimitMb)}</span>
              </span>
            </div>
            <div className={`bar ${memRatio > 0.8 ? 'is-warn' : ''}`}>
              <span style={{ width: `${Math.min(100, memRatio * 100)}%` }} />
            </div>
          </section>

          {svc.net && (
            <section className="insp-card net-card">
              <div>
                <span className="label">↓ Received</span>
                <b className="num rx">{rate(svc.net.rxBps)}</b>
              </div>
              <div>
                <span className="label">↑ Sent</span>
                <b className="num tx">{rate(svc.net.txBps)}</b>
              </div>
            </section>
          )}
        </>
      )}

      <dl className="meta">
        {svc.appName && (
          <>
            <dt>App name</dt>
            <dd className="mono">{svc.appName}</dd>
          </>
        )}
        {svc.source && (
          <>
            <dt>Source</dt>
            <dd className="mono">{svc.source}</dd>
          </>
        )}
        <dt>Server</dt>
        <dd className="mono">{server?.name ?? svc.serverId}</dd>
        <dt>Replicas</dt>
        <dd className="num">
          {svc.containers === undefined || !caps.metrics
            ? svc.replicas
            : svc.kind === 'compose'
              ? `${svc.containers} container${svc.containers === 1 ? '' : 's'}`
              : `${svc.containers} / ${svc.replicas} running`}
        </dd>
        {!caps.metrics && svc.memLimitMb > 0 && (
          <>
            <dt>Memory limit</dt>
            <dd className="num">{mb(svc.memLimitMb)}</dd>
          </>
        )}
        {caps.deployments && !db && (
          <>
            <dt>Last deploy</dt>
            <dd>{ago(svc.lastDeploy, now)}</dd>
          </>
        )}
        {svc.createdAt && (
          <>
            <dt>Created</dt>
            <dd>{new Date(svc.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</dd>
          </>
        )}
      </dl>

      {caps.actions && !db && (
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={!!active} onClick={() => redeploy(svc.id)}>
            <RocketIcon />
            {active ? 'Deploying…' : 'Redeploy'}
          </button>
          {svc.status === 'idle' ? (
            <button type="button" className="btn" disabled={!!active} onClick={() => setRunning(svc.id, true)}>
              <PlayIcon />
              Start
            </button>
          ) : (
            <button type="button" className="btn btn-danger" disabled={!!active} onClick={() => setRunning(svc.id, false)}>
              <PowerIcon />
              Stop
            </button>
          )}
        </div>
      )}

      {caps.deployments && !db && (
        <section>
          <h3 className="section-title">Recent deploys</h3>
          {recent.length ? (
            <ul className="mini-list">
              {recent.map((d) => (
                <li key={d.id} title={`${TRIGGER_LABEL[d.trigger]} · ${d.commit?.author ?? 'shipyard'}`}>
                  <span className="mono">{d.commit?.sha ?? 'restart'}</span>
                  <span className="truncate">{d.commit?.message ?? 'Auto-heal restart'}</span>
                  <span className="muted small">{ago(d.createdAt, now)}</span>
                  <DeployPill status={d.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No deploys yet.</p>
          )}
        </section>
      )}

      {!caps.actions && <p className="insp-foot muted small">Read-only · live from Dokploy</p>}
    </aside>
  );
}
