import { useMemo, useState } from 'react';
import { useStore, type EventKind } from '../store';

const KINDS = new Set<EventKind>(['deploy-start', 'deploy-ok', 'deploy-fail', 'down', 'up', 'new-node']);
const TTL = 8000;
const MAX = 4;

/** Bottom-right pop-ups for what just happened (deploys, nodes going down / up). Click to jump there. */
export function Toasts() {
  const events = useStore((s) => s.events);
  const now = useStore((s) => s.now);
  const [since] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  const list = useMemo(
    () => events.filter((e) => KINDS.has(e.kind) && e.at >= since && now - e.at < TTL && !dismissed.has(e.id)).slice(0, MAX),
    [events, now, since, dismissed],
  );
  if (!list.length) return null;

  return (
    <div className="toasts" aria-live="polite">
      {list.map((e) => (
        <button
          key={e.id}
          type="button"
          className={`toast panel tone-${e.tone}`}
          onClick={() => {
            if (e.serviceId) useStore.getState().select(e.serviceId);
            setDismissed((d) => new Set(d).add(e.id));
          }}
        >
          <i className={`sev sev-${e.tone}`} />
          <span className="toast-text">
            <strong>{e.text}</strong>
            {e.detail && <span className="muted truncate">{e.detail}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
