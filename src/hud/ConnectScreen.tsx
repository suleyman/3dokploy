import { useState, type FormEvent } from 'react';
import { normalizeUrl } from '../data/connection';
import { fetchVersion, relayTransport } from '../data/dokploy/api';
import { useSession } from '../session';
import { Logo } from './icons';

/** First screen (over the demo world): connect a Dokploy, or just look around. */
export function ConnectScreen() {
  const current = useSession((s) => s.conn);
  const pinned = useSession((s) => s.server?.url ?? null);
  const canCancel = useSession((s) => !!s.conn || s.demo);
  const [url, setUrl] = useState(pinned ?? current?.url ?? '');
  const [apiKey, setApiKey] = useState(current?.apiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { connect, startDemo, closeConnect, disconnect } = useSession.getState();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let conn;
    try {
      conn = { url: pinned ?? normalizeUrl(url), apiKey: apiKey.trim() };
    } catch {
      return setError('That doesn’t look like a URL.');
    }
    if (!conn.apiKey) return setError('Paste an API key.');
    setBusy(true);
    try {
      const version = await fetchVersion(relayTransport(conn));
      connect(conn, typeof version === 'string' ? version : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <form className="gate-card panel" onSubmit={submit}>
        <div className="gate-brand">
          <Logo width={30} height={30} />
          <span className="brand-name">
            <b>3D</b>okploy
          </span>
        </div>
        <h1 id="gate-title">Your Dokploy, as a living server floor.</h1>
        <p className="muted">Projects become buildings, services become racks, deploys roll in on carts. Read-only.</p>

        <label className="field">
          <span className="label">Dokploy URL</span>
          <input
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://dokploy.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            readOnly={!!pinned}
            required
            autoFocus={!pinned}
          />
          {pinned && <span className="muted small">Set by this server.</span>}
        </label>

        <label className="field">
          <span className="label">API key</span>
          <span className="field-row">
            <input
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="Dokploy → Settings → Profile → API/CLI"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              autoFocus={!!pinned}
            />
            <button type="button" className="link" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'hide' : 'show'}
            </button>
          </span>
        </label>

        {error && (
          <p className="gate-error" role="alert">
            {error}
          </p>
        )}

        <div className="gate-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Connecting…' : current ? 'Save & reconnect' : 'Connect'}
          </button>
          <button type="button" className="btn" onClick={startDemo}>
            Try the demo
          </button>
        </div>
        {canCancel && (
          <div className="gate-secondary">
            <button type="button" className="link" onClick={closeConnect}>
              Cancel
            </button>
            {current && (
              <button type="button" className="link danger" onClick={disconnect}>
                Disconnect &amp; forget key
              </button>
            )}
          </div>
        )}

        <details className="gate-privacy">
          <summary>Where does my API key go?</summary>
          <p>
            It is saved only in <b>this browser’s localStorage</b>. Browsers can’t call Dokploy directly (it sends no CORS headers,
            and an <code>http://</code> Dokploy is blocked on an https page), so each request passes through this site’s relay,
            which forwards it and keeps nothing: no storage, no logs.
          </p>
          <p>
            The relay only allows <b>read-only</b> endpoints and strips secrets (env vars, passwords, tokens) from responses. Nothing
            can be deployed, stopped or changed through 3Dokploy. Prefer your own setup? It’s open source and self-hostable.
          </p>
        </details>
      </form>
    </div>
  );
}
