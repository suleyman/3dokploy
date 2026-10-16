import { useStore } from '../store';

/** Where the camera is: Overview › Project › Node. Every crumb flies back to that level. */
export function Breadcrumb() {
  const project = useStore((s) => (s.selectedProjectId ? s.projects[s.selectedProjectId] : undefined));
  const node = useStore((s) => (s.selectedId ? s.services[s.selectedId] : undefined));
  const { clearSelection, cameraCommand, focusProject, frame } = useStore.getState();

  return (
    <nav className="crumbs panel" aria-label="Location">
      <button
        type="button"
        className={`crumb ${project ? '' : 'is-current'}`}
        onClick={() => {
          clearSelection();
          cameraCommand('reset');
        }}
      >
        Overview
      </button>
      {project && (
        <>
          <span className="crumb-sep">›</span>
          <button
            type="button"
            className={`crumb ${node ? '' : 'is-current'}`}
            style={{ ['--tone' as string]: project.color }}
            onClick={() => focusProject(project.id)}
          >
            <i className="swatch" style={{ background: project.color, color: project.color }} />
            {project.name}
          </button>
        </>
      )}
      {node && (
        <>
          <span className="crumb-sep">›</span>
          <button type="button" className="crumb is-current" onClick={frame}>
            {node.name}
          </button>
        </>
      )}
      <span className="crumb-hint">{project ? 'Esc back · F frame · Space+drag pan' : 'Click a building · Space+drag pan · scroll/pinch zoom · R reset'}</span>
    </nav>
  );
}
