import { useMemo, useState } from 'react';
import { isDb } from '../data/types';
import { ago, mb, pct, rate } from '../format';
import { useStore } from '../store';
import { KIND_COLOR, KIND_LABEL, PRESETS } from '../theme';
import { DeployPill, StatusDot } from './bits';
import { CloseIcon } from './icons';

/** Opens in the inspector slot when a project is in focus and no node is selected. */
export function ProjectPanel() {
  const projectId = useStore((s) => (s.selectedId ? null : s.selectedProjectId));
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined));
  const services = useStore((s) => s.services);
  const environments = useStore((s) => s.environments);
  const deployments = useStore((s) => s.deployments);
  const now = useStore((s) => s.now);

  const data = useMemo(() => {
    if (!projectId) return null;
    const nodes = Object.values(services).filter((s) => s.projectId === projectId);
    const envs = Object.values(environments)
      .filter((e) => e.projectId === projectId)
      .map((env) => ({
        env,
        nodes: nodes
          .filter((s) => s.environmentId === env.id)
          .sort((a, b) => Number(isDb(a.kind)) - Number(isDb(b.kind)) || a.name.localeCompare(b.name)),
      }))
      .filter((e) => e.nodes.length);
    const ids = new Set(nodes.map((n) => n.id));
    const deploys = Object.values(deployments)
      .filter((d) => ids.has(d.serviceId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5);
    return {
      envs,
      deploys,
      total: nodes.length,
      running: nodes.filter((s) => s.status === 'running').length,
      down: nodes.filter((s) => s.status === 'error').length,
      deploying: nodes.filter((s) => s.status === 'deploying').length,
      cpu: nodes.reduce((a, s) => a + s.cpu, 0),
      mem: nodes.reduce((a, s) => a + s.memMb, 0),
      net: nodes.reduce((a, s) => a + (s.net ? s.net.rxBps + s.net.txBps : 0), 0),
    };
  }, [projectId, services, environments, deployments]);

  if (!project || !data) return null;
  const { select, back } = useStore.getState();

  return (
    <aside className="inspector project-panel panel" aria-label={`${project.name} project`} style={{ ['--tone' as string]: project.color }}>
      <header className="insp-head">
        <div className="insp-title">
          <span className="kind-badge" style={{ ['--kind' as string]: project.color }}>
            Project
          </span>
          <h2 className="project-name">{project.name}</h2>
          <p className="muted">
            {data.envs.map((e) => e.env.name).join(' · ') || 'no environments'}
            {project.description && <> — {project.description}</>}
          </p>
        </div>
        <button type="button" className="icon-btn ghost" onClick={back} aria-label="Back to overview">
          <CloseIcon />
        </button>
      </header>

      <BuildingSettings projectId={project.id} />

      <div className="stat-grid">
        <div>
          <span className="label">Nodes</span>
          <b className="num">
            {data.running}
            <small>/{data.total}</small>
          </b>
        </div>
        <div>
          <span className="label">Down</span>
          <b className={`num ${data.down ? 'crit' : ''}`}>{data.down}</b>
        </div>
        <div>
          <span className="label">Deploying</span>
          <b className={`num ${data.deploying ? 'info' : ''}`}>{data.deploying}</b>
        </div>
        <div>
          <span className="label">CPU</span>
          <b className="num">
            {data.cpu.toFixed(2)}
            <small> cores</small>
          </b>
        </div>
        <div>
          <span className="label">Memory</span>
          <b className="num">{mb(data.mem)}</b>
        </div>
        <div>
          <span className="label">Network</span>
          <b className="num">{rate(data.net)}</b>
        </div>
      </div>

      {data.envs.map(({ env, nodes }) => (
        <section key={env.id}>
          <h3 className="section-title">{env.name}</h3>
          <ul className="node-list">
            {nodes.map((n) => (
              <li key={n.id}>
                <button type="button" className="node-row" onClick={() => select(n.id)}>
                  <StatusDot status={n.status} />
                  <span className="truncate">{n.name}</span>
                  <span className="kind-chip" style={{ ['--kind' as string]: KIND_COLOR[n.kind] }}>
                    {KIND_LABEL[n.kind]}
                  </span>
                  <span className="num muted small">{n.status === 'running' ? pct(n.cpu) : '—'}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {data.deploys.length > 0 && (
        <section>
          <h3 className="section-title">Recent deploys</h3>
          <ul className="mini-list">
            {data.deploys.map((d) => (
              <li key={d.id}>
                <span className="mono">{services[d.serviceId]?.name}</span>
                <span className="truncate">{d.commit?.message ?? (d.trigger === 'manual' ? 'Manual deployment' : 'Deployment')}</span>
                <span className="muted small">{ago(d.createdAt, now)}</span>
                <DeployPill status={d.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

/** Colour preset, position and complex of this building (saved for everyone via /api/prefs). */
function BuildingSettings({ projectId }: { projectId: string }) {
  const prefs = useStore((s) => s.prefs);
  const shared = useStore((s) => s.prefsShared);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const s = useStore.getState();
  const complex = prefs.groups.find((g) => g.projects.includes(projectId));
  const color = prefs.colors[projectId];

  const create = () => {
    if (name.trim()) s.createComplex(name, projectId);
    setNaming(false);
    setName('');
  };

  return (
    <section className="building-settings">
      <h3 className="section-title">Building</h3>
      <div className="swatches" role="radiogroup" aria-label="Colour">
        <button type="button" className={`swatch-btn auto ${color ? '' : 'is-on'}`} onClick={() => s.setProjectColor(projectId, null)} title="Automatic colour" aria-checked={!color} role="radio">
          Auto
        </button>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`swatch-btn ${color === p.key ? 'is-on' : ''}`}
            style={{ ['--swatch' as string]: p.hex }}
            onClick={() => s.setProjectColor(projectId, p.key)}
            title={p.label}
            aria-label={p.label}
            aria-checked={color === p.key}
            role="radio"
          />
        ))}
      </div>
      <div className="row-actions">
        <button type="button" className="text-btn" onClick={() => s.moveProject(projectId, -1)} title="Move this building one place earlier">
          ◀ Earlier
        </button>
        <button type="button" className="text-btn" onClick={() => s.moveProject(projectId, 1)} title="Move this building one place later">
          Later ▶
        </button>
      </div>
      <div className="row-actions">
        <label className="muted small" htmlFor="complex-select">
          Complex
        </label>
        {naming ? (
          <>
            <input
              className="complex-input"
              autoFocus
              value={name}
              maxLength={40}
              placeholder="Name of the complex"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => (e.key === 'Enter' ? create() : e.key === 'Escape' ? setNaming(false) : undefined)}
            />
            <button type="button" className="text-btn" onClick={create}>
              Create
            </button>
          </>
        ) : (
          <select
            id="complex-select"
            className="complex-select"
            value={complex?.id ?? ''}
            onChange={(e) => (e.target.value === '+new' ? setNaming(true) : s.setProjectComplex(projectId, e.target.value || null))}
          >
            <option value="">None</option>
            {prefs.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.projects.length})
              </option>
            ))}
            <option value="+new">+ New complex…</option>
          </select>
        )}
      </div>
      {complex && !naming && (
        <div className="row-actions">
          <input
            className="complex-input"
            key={complex.id}
            defaultValue={complex.name}
            maxLength={40}
            aria-label="Rename complex"
            onBlur={(e) => e.target.value.trim() && e.target.value !== complex.name && s.renameComplex(complex.id, e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <button type="button" className="text-btn" onClick={() => s.removeComplex(complex.id)} title="Dissolve the complex (the buildings stay)">
            Dissolve
          </button>
        </div>
      )}
      {shared === false && <p className="muted small">Saved in this browser only (the server can't store settings).</p>}
    </section>
  );
}
