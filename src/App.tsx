import { useEffect } from 'react';
import { DokploySource } from './data/source';
import { ago } from './format';
import { Breadcrumb } from './hud/Breadcrumb';
import { Inspector } from './hud/Inspector';
import { Kpis } from './hud/Kpis';
import { MapControls } from './hud/MapControls';
import { Pipeline } from './hud/Pipeline';
import { ProjectPanel } from './hud/ProjectPanel';
import { Toasts } from './hud/Toasts';
import { TopBar } from './hud/TopBar';
import { Scene } from './scene/Scene';
import { bindSounds } from './sound';
import { useStore } from './store';

export function App() {
  const ready = useStore((s) => s.ready);

  useEffect(() => useStore.getState().connect(new DokploySource()), []);
  useEffect(() => bindSounds(), []);

  return (
    <div className="app">
      <Scene />
      <div className="hud">
        <TopBar />
        {ready ? (
          <>
            <Kpis />
            <Breadcrumb />
            <MapControls />
            <Inspector />
            <ProjectPanel />
            <Pipeline />
            <Toasts />
            <SyncBanner />
          </>
        ) : (
          <Boot />
        )}
      </div>
    </div>
  );
}

/** Before the first snapshot: a spinner, or why it failed and what to do about it. */
function Boot() {
  const loadError = useStore((s) => s.loadError);
  if (!loadError) {
    return (
      <div className="boot panel">
        <span className="bubble-spinner" />
        Connecting to Dokploy…
      </div>
    );
  }
  return (
    <div className="boot boot-error panel" role="alert">
      <strong>Can't load Dokploy data</strong>
      <p className="mono">{loadError}</p>
      <p className="muted small">
        Retrying every 5 seconds. Check <code>DOKPLOY_URL</code> and <code>DOKPLOY_API_KEY</code> in this server's environment.
      </p>
    </div>
  );
}

/** After the first snapshot: keep showing the last known state, but say it may be stale. */
function SyncBanner() {
  const status = useStore((s) => s.status);
  const now = useStore((s) => s.now);
  if (status.state !== 'error') return null;
  return (
    <div className="sync-banner" role="status">
      <i className="dot dot-crit" />
      {status.message ?? 'Sync failed'}
      {status.syncedAt && <span className="muted"> · last sync {ago(status.syncedAt, now)}</span>}
    </div>
  );
}
