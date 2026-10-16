import { useEffect, useMemo } from 'react';
import { DokploySource, MockSource } from './data/source';
import { ago } from './format';
import { Breadcrumb } from './hud/Breadcrumb';
import { ConnectScreen } from './hud/ConnectScreen';
import { Inspector } from './hud/Inspector';
import { Kpis } from './hud/Kpis';
import { MapControls } from './hud/MapControls';
import { Pipeline } from './hud/Pipeline';
import { ProjectPanel } from './hud/ProjectPanel';
import { Toasts } from './hud/Toasts';
import { TopBar } from './hud/TopBar';
import { Scene } from './scene/Scene';
import { isGated, useSession } from './session';
import { bindSounds } from './sound';
import { useStore } from './store';

export function App() {
  const ready = useStore((s) => s.ready);
  const deployments = useStore((s) => s.capabilities.deployments);
  const conn = useSession((s) => s.conn);
  const demo = useSession((s) => s.demo);
  const gated = useSession(isGated);

  // The user's Dokploy when connected (and not in demo); the demo world otherwise, also behind
  // the connect screen. Re-editing a connection keeps the current world running underneath.
  const live = !!conn && !demo;
  const source = useMemo(() => (live && conn ? new DokploySource(conn) : new MockSource()), [live, conn]);

  useEffect(() => useStore.getState().connect(source), [source]);
  useEffect(() => bindSounds(), []);

  return (
    <div className={`app ${gated ? 'is-gated' : ''}`}>
      <Scene />
      {gated ? (
        <ConnectScreen />
      ) : (
        <div className="hud">
          <TopBar />
          {ready ? (
            <>
              <Kpis />
              <Breadcrumb />
              <MapControls />
              <Inspector />
              <ProjectPanel />
              {deployments && <Pipeline />}
              <Toasts />
              <SyncBanner />
            </>
          ) : (
            <Boot />
          )}
        </div>
      )}
    </div>
  );
}

/** Before the first snapshot: a spinner, or why it failed and what to do about it. */
function Boot() {
  const loadError = useStore((s) => s.loadError);
  const managed = useSession((s) => !!s.conn?.managed);
  const { openConnect, startDemo } = useSession.getState();
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
        Retrying every 5 seconds.{managed && ' This server is configured with DOKPLOY_URL / DOKPLOY_API_KEY: check them.'}
      </p>
      <div className="gate-actions">
        {!managed && (
          <button type="button" className="btn" onClick={openConnect}>
            Edit connection
          </button>
        )}
        <button type="button" className="btn" onClick={startDemo}>
          Show the demo
        </button>
      </div>
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
