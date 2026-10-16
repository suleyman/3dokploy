import { useEffect, useMemo, useState } from 'react';
import { STAGES, isActiveDeploy } from '../data/types';
import { ago, duration } from '../format';
import { useStore } from '../store';
import { TRIGGER_LABEL } from '../theme';
import { DeployPill } from './bits';
import { CheckIcon, XIcon } from './icons';

const TERMINAL_LINES = 2;

/** Selected service's latest deploy; otherwise the one building now, then queued, then the newest. */
export function Pipeline() {
  const deployments = useStore((s) => s.deployments);
  const services = useStore((s) => s.services);
  const selectedId = useStore((s) => s.selectedId);
  const now = useStore((s) => s.now);

  const dep = useMemo(() => {
    const all = Object.values(deployments).sort((a, b) => b.createdAt - a.createdAt);
    const mine = selectedId ? all.filter((d) => d.serviceId === selectedId) : [];
    return (
      mine.find(isActiveDeploy) ??
      mine[0] ??
      all.find((d) => d.status === 'running') ??
      all.find(isActiveDeploy) ??
      all[0]
    );
  }, [deployments, selectedId]);

  // Older deploys come without a log tail; fetch it once when one of them is shown.
  const [fetched, setFetched] = useState<{ id: string; lines: string[] } | null>(null);
  const needsLog = !!dep && dep.log.length === 0 && !isActiveDeploy(dep);
  useEffect(() => {
    if (!dep || !needsLog) return;
    let alive = true;
    void useStore
      .getState()
      .fetchLogs(dep.id)
      .then((lines) => alive && setFetched({ id: dep.id, lines: lines.slice(-TERMINAL_LINES) }));
    return () => {
      alive = false;
    };
  }, [dep, needsLog]);

  if (!dep) return null;
  const svc = services[dep.serviceId];
  const lines = dep.log.length ? dep.log.slice(-TERMINAL_LINES) : fetched?.id === dep.id ? fetched.lines : [];
  const took = dep.finishedAt ? duration(dep.finishedAt - (dep.startedAt ?? dep.createdAt)) : dep.startedAt ? duration(now - dep.startedAt) : undefined;

  return (
    <section className="pipeline panel" aria-label="Deploy pipeline">
      <header className="pipe-head">
        <span className="label">Pipeline</span>
        <strong className="truncate">{svc?.name ?? dep.serviceId}</strong>
        <DeployPill status={dep.status} />
        <span className="pipe-meta muted">
          {ago(dep.createdAt, now)}
          {took && <> · {isActiveDeploy(dep) ? `${took}…` : took}</>}
        </span>
      </header>

      {dep.commit && (
        <p className="pipe-commit" title={`${TRIGGER_LABEL[dep.trigger]}${dep.commit.author ? ` by ${dep.commit.author}` : ''}`}>
          {dep.commit.sha && <span className="mono sha">{dep.commit.sha}</span>}
          <span className="truncate">{dep.commit.message}</span>
        </p>
      )}

      <ol className="stepper">
        {STAGES.map((name, i) => {
          const st = dep.stages[i];
          return (
            <li key={name} className={`step step-${st}`} aria-current={st === 'running' ? 'step' : undefined} title={`${name}: ${st}`}>
              <span className="step-node">
                {st === 'done' ? <CheckIcon width={8} height={8} /> : st === 'failed' ? <XIcon width={8} height={8} /> : null}
              </span>
              <span className="step-name">{name}</span>
            </li>
          );
        })}
      </ol>

      <div className={`terminal mono ${dep.status === 'failed' ? 'is-failed' : ''}`} aria-live="polite">
        {lines.length ? (
          lines.map((l, i) => (
            // Only the newest line is keyed by log length, so only it re-mounts (and slides in).
            <div
              key={i === lines.length - 1 ? `${dep.id}-${dep.log.length}` : `${dep.id}-${l}`}
              className={`term-line ${i === lines.length - 1 ? 'is-new' : ''} ${l.startsWith('✖') ? 'term-err' : ''}`}
            >
              <span className="prompt">{i === lines.length - 1 ? '$' : '·'}</span>
              <span className="truncate">{l}</span>
              {i === lines.length - 1 && isActiveDeploy(dep) && <span className="caret" />}
            </div>
          ))
        ) : (
          <div className="term-line">
            <span className="prompt">$</span>
            <span className="truncate muted">
              {dep.status === 'queued' ? `Waiting for RC${dep.cart} to dock at ${svc?.name ?? 'the rack'}…` : 'Loading log…'}
            </span>
            {isActiveDeploy(dep) && <span className="caret" />}
          </div>
        )}
      </div>
    </section>
  );
}
