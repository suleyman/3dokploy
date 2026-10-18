import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ago, clock } from '../format';
import { useStore, type MenuTab } from '../store';
import { Logo } from './icons';
import { fullscreenSupported, toggleFullscreen } from './fullscreen';
import { MenuContent, useMenuItems } from './Menus';

export function TopBar() {
  const servers = useStore((s) => s.servers);
  const services = useStore((s) => s.services);
  const ready = useStore((s) => s.ready);
  const menu = useStore((s) => s.menu);
  const now = useStore((s) => s.now);
  const items = useMenuItems();
  const header = useRef<HTMLElement>(null);
  const dropdown = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<MenuTab, HTMLButtonElement>());
  const [anchor, setAnchor] = useState<{ left: number; width: number } | null>(null);

  const serverSummary = useMemo(
    () =>
      Object.values(servers).map((srv) => {
        const own = Object.values(services).filter((s) => s.serverId === srv.id);
        return { srv, count: own.length, down: own.filter((s) => s.status === 'error').length };
      }),
    [servers, services],
  );

  // Line the dropdown up under its button (and keep it inside the viewport).
  useLayoutEffect(() => {
    const btn = menu && buttons.current.get(menu);
    if (!btn) return setAnchor(null);
    const r = btn.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 16);
    setAnchor({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), width });
  }, [menu]);

  // Close on outside click.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (dropdown.current?.contains(t) || header.current?.contains(t)) return;
      useStore.getState().toggleMenu(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [menu]);

  useShortcuts();

  return (
    <>
      <header className="topbar panel" ref={header}>
        <div className="brand">
          <Logo />
          <span className="brand-name">
            <b>3D</b>okploy
          </span>
          <SourceBadge />
        </div>

        {ready && (
          <nav className="menu-bar" aria-label="Panels">
            {items.map((it) => (
              <button
                key={it.id}
                ref={(el) => {
                  if (el) buttons.current.set(it.id, el);
                  else buttons.current.delete(it.id);
                }}
                type="button"
                className={`menu-btn ${menu === it.id ? 'is-open' : ''}`}
                aria-expanded={menu === it.id}
                aria-haspopup="true"
                onClick={() => useStore.getState().toggleMenu(it.id)}
              >
                {it.id === 'activity' && <i className="live-dot" />}
                {it.label}
                <span className={`count ${it.tone ?? ''}`}>{it.count}</span>
              </button>
            ))}
          </nav>
        )}

        <div className="topbar-right">
          <div className="servers">
            {serverSummary.map(({ srv, count, down }) => (
              <span
                key={srv.id}
                className="server-chip"
                title={[srv.host, srv.vcpu && `${srv.vcpu} vCPU`, srv.ramGb && `${srv.ramGb} GB`].filter(Boolean).join(' · ') || srv.name}
              >
                <i className={`dot ${down ? 'dot-crit' : 'dot-ok'}`} />
                <span className="mono">{srv.name}</span>
                <span className="muted">{count}</span>
              </span>
            ))}
          </div>
          <time className="clock mono" dateTime={new Date(now).toISOString()}>
            {clock(now)}
          </time>
        </div>
      </header>

      {menu && anchor && (
        <div
          ref={dropdown}
          className="dropdown panel"
          role="dialog"
          aria-label={items.find((i) => i.id === menu)?.label}
          style={{ left: anchor.left, width: anchor.width }}
        >
          <MenuContent tab={menu} />
        </div>
      )}
    </>
  );
}

/**
 * Keyboard: "/" filter nodes · Esc close menu / back out (node → project → overview) ·
 * F frame · R reset · +/- zoom · arrows pan. (Space-drag panning lives in the scene.)
 */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable]');
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useStore.getState();
      const pan: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (e.key in pan) {
        e.preventDefault();
        const [dx, dz] = pan[e.key];
        return s.cameraCommand('pan', { dx, dz });
      }
      switch (e.key) {
        case '/':
          e.preventDefault();
          return s.menu === 'services' ? undefined : s.toggleMenu('services');
        case 'Escape':
          return s.menu ? s.toggleMenu(null) : s.back();
        case 'f':
        case 'F':
          // F frames the selection; Shift+F toggles fullscreen.
          return e.shiftKey ? fullscreenSupported() && toggleFullscreen() : s.frame();
        case 'm':
        case 'M':
          return s.toggleMute();
        case 'r':
        case 'R':
        case 'Home':
          s.clearSelection();
          return s.cameraCommand('reset');
        case '+':
        case '=':
          return s.cameraCommand('zoomIn');
        case '-':
        case '_':
          return s.cameraCommand('zoomOut');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** LIVE badge; opens a small popover with the sync state. */
function SourceBadge() {
  const status = useStore((s) => s.status);
  const loadError = useStore((s) => s.loadError);
  const version = useStore((s) => s.version);
  const now = useStore((s) => s.now);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);

  const state = loadError ? 'error' : status.state;
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Syncing' : 'Offline';
  const error = state === 'error' ? (loadError ?? status.message) : undefined;

  return (
    <span className="badge-wrap" ref={box}>
      <button type="button" className={`badge badge-live is-${state}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <i className="badge-dot" />
        {label}
      </button>
      {open && (
        <span className="badge-pop panel" role="dialog" aria-label="Connection">
          <span className="label">Connected to</span>
          <b className="mono truncate">{version ? `Dokploy ${version}` : 'Dokploy'}</b>
          <span className="muted small">{status.syncedAt ? `Synced ${ago(status.syncedAt, now)}` : 'Not synced yet'}</span>
          {error && <span className="pop-error small">{error}</span>}
          <span className="muted small">Read-only. Configured on this server; the API key never reaches your browser.</span>
        </span>
      )}
    </span>
  );
}
