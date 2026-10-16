/**
 * The user's Dokploy connection. Lives only in this browser's localStorage: the server never
 * stores it (the relay just forwards each request).
 */
import type { Connection } from './dokploy/api';

const KEY = '3dokploy:connection';

export function loadConnection(): Connection | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Connection> | null;
    return raw?.url && raw.apiKey ? { url: raw.url, apiKey: raw.apiKey } : null;
  } catch {
    return null;
  }
}

export function saveConnection(conn: Connection) {
  try {
    localStorage.setItem(KEY, JSON.stringify(conn));
  } catch {
    // storage blocked (private mode): stays connected for this session only
  }
}

export function clearConnection() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}

/** "dokploy.example.com/" → "https://dokploy.example.com"; pasted API/Swagger URLs lose their path. */
export function normalizeUrl(input: string) {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  const path = u.pathname.replace(/\/(api|swagger)(\/.*)?$/i, '').replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}
