/**
 * Header menus: Live / Deploys / Alerts / Nodes / Projects. Each header button opens its list
 * as a dropdown right under it. Nodes carries the search box (it also dims the scene).
 */
import { useEffect, useMemo, useRef } from 'react';
import { STAGES, isActiveDeploy } from '../data/types';
import { ago, clock, mb, pct } from '../format';
import { matchesSearch, useStore, type MenuTab } from '../store';
import { KIND_LABEL, TRIGGER_LABEL } from '../theme';
import { DeployPill, StatusDot } from './bits';
import { SearchIcon } from './icons';

export interface MenuItem {
  id: MenuTab;
  label: string;
  count: number;
  tone?: 'info' | 'crit';
}

/** Buttons for the header, with live counts. */
export function useMenuItems(): MenuItem[] {
  const deployments = useStore((s) => s.deployments);
  const alerts = useStore((s) => s.alerts);
  const services = useStore((s) => s.services);
  const projects = useStore((s) => s.projects);
  const events = useStore((s) => s.events);
  const seenAt = useStore((s) => s.seenEventsAt);

  return useMemo(() => {
    const active = Object.values(deployments).filter(isActiveDeploy).length;
    const open = Object.values(alerts).filter((a) => !a.resolvedAt).length;
    const unseen = events.filter((e) => e.at > seenAt).length;
    return [
      { id: 'activity' as const, label: 'Activity', count: unseen, tone: unseen ? ('info' as const) : undefined },
      { id: 'deploys' as const, label: 'Deploys', count: active, tone: active ? ('info' as const) : undefined },
      { id: 'alerts' as const, label: 'Alerts', count: open, tone: open ? ('crit' as const) : undefined },
      { id: 'services' as const, label: 'Nodes', count: Object.keys(services).length },
      { id: 'projects' as const, label: 'Projects', count: Object.keys(projects).length },
    ];
  }, [deployments, alerts, services, projects, events, seenAt]);
}

/** Pick an item: select a node (or open a project) and close the menu. */
function useChoose() {
  return useMemo(() => {
    const s = useStore.getState();
    return {
      node: (id: string) => {
        s.select(id);
        s.toggleMenu(null);
      },
      project: (id: string) => {
        s.focusProject(id);
        s.toggleMenu(null);
      },
    };
  }, []);
}

export function MenuContent({ tab }: { tab: MenuTab }) {
  switch (tab) {
    case 'activity':
      return <ActivityList />;
    case 'deploys':
      return <DeployList />;
    case 'alerts':
      return <AlertList />;
    case 'services':
      return <NodeList />;
    case 'projects':
      return <ProjectList />;
  }
}

function ActivityList() {
  const events = useStore((s) => s.events);
  const now = useStore((s) => s.now);
  const choose = useChoose();
  if (!events.length) return <p className="empty muted">Waiting for something to happen…</p>;
  return (
    <ol className="feed">
      {events.map((e) => (
        <li key={e.id} className={`feed-item tone-${e.tone}`}>
          <button type="button" className="feed-row" onClick={() => e.serviceId && choose.node(e.serviceId)}>
            <time className="mono">{now - e.at < 86_400_000 ? clock(e.at) : ago(e.at, now)}</time>
            <i className={`sev sev-${e.tone}`} />
            <span className="feed-text">
              <strong>{e.text}</strong>
              {e.detail && <span className="muted truncate">{e.detail}</span>}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function DeployList() {
  const deployments = useStore((s) => s.deployments);
  const services = useStore((s) => s.services);
  const now = useStore((s) => s.now);
  const choose = useChoose();
  const list = useMemo(() => Object.values(deployments).sort((a, b) => b.createdAt - a.createdAt).slice(0, 40), [deployments]);
  if (!list.length) return <p className="empty muted">No deploys yet.</p>;
  return (
    <ul className="rows">
      {list.map((d) => {
        const stage = d.stages.findIndex((s) => s === 'running');
        return (
          <li key={d.id}>
            <button type="button" className="row" onClick={() => choose.node(d.serviceId)}>
              <span className="row-main">
                <strong>{services[d.serviceId]?.name ?? d.serviceId}</strong>
                <span className="muted small truncate">
                  {TRIGGER_LABEL[d.trigger]}
                  {d.commit && (
                    <>
                      {' · '}
                      {d.commit.sha && <span className="mono">{d.commit.sha} </span>}
                      {d.commit.message}
                    </>
                  )}
                </span>
              </span>
              <span className="row-side">
                <DeployPill status={d.status} />
                <span className="muted small">{d.status === 'running' && stage >= 0 ? STAGES[stage] : ago(d.createdAt, now)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function AlertList() {
  const alerts = useStore((s) => s.alerts);
  const services = useStore((s) => s.services);
  const now = useStore((s) => s.now);
  const choose = useChoose();
  const list = useMemo(
    () => Object.values(alerts).sort((a, b) => Number(!!a.resolvedAt) - Number(!!b.resolvedAt) || b.createdAt - a.createdAt),
    [alerts],
  );
  if (!list.length) return <p className="empty muted">No alerts. All quiet.</p>;
  return (
    <ul className="rows">
      {list.map((a) => (
        <li key={a.id}>
          <button type="button" className={`row ${a.resolvedAt ? 'is-resolved' : ''}`} onClick={() => choose.node(a.serviceId)}>
            <i className={`sev sev-${a.resolvedAt ? 'resolved' : a.severity}`} />
            <span className="row-main">
              <strong>
                {a.title} <span className="muted">· {services[a.serviceId]?.name ?? 'node'}</span>
              </strong>
              <span className="muted small truncate">{a.message}</span>
            </span>
            <span className="row-side">
              {a.resolvedAt ? (
                <span className="pill pill-ok">Resolved</span>
              ) : (
                <span className={`pill pill-${a.severity === 'critical' ? 'crit' : 'warn'}`}>{a.severity === 'critical' ? 'Critical' : 'Warning'}</span>
              )}
              <span className="muted small">{ago(a.createdAt, now)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function NodeList() {
  const services = useStore((s) => s.services);
  const projects = useStore((s) => s.projects);
  const environments = useStore((s) => s.environments);
  const search = useStore((s) => s.search);
  const choose = useChoose();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const list = useMemo(() => {
    const order = Object.values(projects)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => p.id);
    return Object.values(services)
      .filter((s) => matchesSearch(s, projects[s.projectId], search, environments[s.environmentId]))
      .sort((a, b) => order.indexOf(a.projectId) - order.indexOf(b.projectId) || a.name.localeCompare(b.name));
  }, [services, projects, environments, search]);

  return (
    <>
      <label className="menu-search">
        <SearchIcon />
        <input
          ref={input}
          type="search"
          placeholder="Filter nodes, projects, environments…"
          aria-label="Filter nodes"
          value={search}
          onChange={(e) => useStore.getState().setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              if (search) useStore.getState().setSearch('');
              else useStore.getState().toggleMenu(null);
            } else if (e.key === 'Enter' && list[0]) {
              choose.node(list[0].id);
            }
          }}
        />
        {search && <span className="muted small num">{list.length}</span>}
      </label>
      {list.length ? (
        <ul className="rows">
          {list.map((s) => (
            <li key={s.id}>
              <button type="button" className="row" onClick={() => choose.node(s.id)}>
                <StatusDot status={s.status} />
                <span className="row-main">
                  <strong>{s.name}</strong>
                  <span className="muted small truncate">
                    {projects[s.projectId]?.name} · {environments[s.environmentId]?.name} · {KIND_LABEL[s.kind]}
                  </span>
                </span>
                <span className="row-side num small">
                  <span>{pct(s.cpu)}</span>
                  <span className="muted">{mb(s.memMb)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty muted">No nodes match “{search}”.</p>
      )}
    </>
  );
}

function ProjectList() {
  const projects = useStore((s) => s.projects);
  const services = useStore((s) => s.services);
  const environments = useStore((s) => s.environments);
  const choose = useChoose();
  const list = useMemo(
    () =>
      Object.values(projects)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => {
          const own = Object.values(services).filter((s) => s.projectId === p.id);
          return {
            project: p,
            total: own.length,
            down: own.filter((s) => s.status === 'error').length,
            deploying: own.filter((s) => s.status === 'deploying').length,
            envs: Object.values(environments)
              .filter((e) => e.projectId === p.id)
              .map((e) => e.name),
          };
        }),
    [projects, services, environments],
  );
  return (
    <ul className="rows">
      {list.map(({ project, total, down, deploying, envs }) => (
        <li key={project.id}>
          <button type="button" className="row" onClick={() => choose.project(project.id)}>
            <i className="swatch" style={{ background: project.color, color: project.color }} />
            <span className="row-main">
              <strong>{project.name}</strong>
              <span className="muted small truncate">{envs.join(' · ') || 'no environments'}</span>
            </span>
            <span className="row-side small">
              <span className="num">
                {total} node{total === 1 ? '' : 's'}
              </span>
              {down ? (
                <span className="pill pill-crit">{down} down</span>
              ) : deploying ? (
                <span className="pill pill-info">{deploying} deploying</span>
              ) : (
                <span className="muted">healthy</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
