/**
 * Which world is on screen: the user's Dokploy, the demo, or the connect screen in front of the
 * demo. A user-entered connection is persisted in localStorage (data/connection.ts), nowhere else.
 * Self-hosted servers can pin the Dokploy and hold the key (see /config and server/relay.ts).
 */
import { create } from 'zustand';
import { clearConnection, loadConnection, saveConnection } from './data/connection';
import type { Connection } from './data/dokploy/api';

/** From the server's /config: set when it is pinned to one Dokploy via env. */
export interface ServerDokploy {
  url: string;
  /** The server holds the API key: no connect screen at all. */
  keyOnServer: boolean;
}

interface Session {
  server: ServerDokploy | null;
  conn: Connection | null;
  /** Dokploy version reported when connecting (unknown after a reload). */
  version: string | null;
  demo: boolean;
  /** Connect screen open on top of whatever is running. */
  editing: boolean;
  connect(conn: Connection, version: string | null): void;
  disconnect(): void;
  openConnect(): void;
  closeConnect(): void;
  startDemo(): void;
}

export const useSession = create<Session>()((set, get) => ({
  server: null,
  conn: null,
  version: null,
  demo: new URLSearchParams(window.location.search).has('mock'),
  editing: false,

  connect(conn, version) {
    if (!conn.managed) saveConnection(conn);
    set({ conn, version, demo: false, editing: false });
  },
  disconnect() {
    clearConnection();
    if (get().server?.keyOnServer) return; // nothing to forget: the server owns the key
    set({ conn: null, version: null, demo: false, editing: false });
  },
  openConnect() {
    if (!get().server?.keyOnServer) set({ editing: true });
  },
  closeConnect() {
    set({ editing: false });
  },
  startDemo() {
    set({ demo: true, editing: false });
  },
}));

/** Reads the server setup once, before the first render. */
export async function initSession() {
  let server: ServerDokploy | null = null;
  try {
    const res = await fetch('/config', { signal: AbortSignal.timeout(4000) });
    server = res.ok ? (((await res.json()) as { dokploy?: ServerDokploy | null }).dokploy ?? null) : null;
  } catch {
    // no server config (e.g. static hosting): behave like an open instance
  }
  const stored = loadConnection();
  const conn: Connection | null = server?.keyOnServer
    ? { url: server.url, apiKey: '', managed: true }
    : stored && server
      ? { ...stored, url: server.url } // a pinned server decides where requests go
      : stored;
  useSession.setState({ server, conn });
}

/** Connect screen visible: asked for, or nothing chosen yet. */
export const isGated = (s: Session) => s.editing || (!s.conn && !s.demo);
