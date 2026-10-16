import { useEffect, useState } from 'react';
import { sfx } from '../sound';

export const fullscreenSupported = () => !!document.fullscreenEnabled;

export function toggleFullscreen() {
  const on = !!document.fullscreenElement;
  sfx.toggle(!on);
  if (on) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
}

/** Fullscreen state, kept in sync with exits via Esc or the browser's own controls. */
export function useFullscreen() {
  const [on, setOn] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  return on;
}
