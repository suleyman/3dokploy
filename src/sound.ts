/**
 * UI sound: every effect is synthesised with Web Audio (no files). A short feedback delay on a
 * send bus gives the sci-fi "space"; a compressor keeps stacked sounds from clipping.
 *
 * Sounds are not called from components. `bindSounds()` watches the store and maps state
 * transitions (menu opened, node selected, deploy finished…) to sounds, so the UI code stays silent.
 */
import { useStore, type ActivityEvent, type State } from './store';

type Wave = OscillatorType;

interface ToneOpts {
  freq: number;
  to?: number;
  type?: Wave;
  dur?: number;
  gain?: number;
  delay?: number;
  attack?: number;
  /** 0..1 amount sent to the echo bus */
  space?: number;
  lowpass?: number;
}

interface NoiseOpts {
  dur: number;
  gain: number;
  from: number;
  to: number;
  q?: number;
  delay?: number;
  space?: number;
}

const MASTER = 0.5;

class Engine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private echo!: GainNode;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;

  /** Create / resume the context. Browsers only allow this after a user gesture. */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      this.master = ctx.createGain();
      this.master.gain.value = MASTER;
      this.master.connect(comp).connect(ctx.destination);

      // Echo send: delay with feedback, darkened a little each round.
      this.echo = ctx.createGain();
      this.echo.gain.value = 0.22;
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.13;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.32;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 2600;
      this.echo.connect(delay);
      delay.connect(tone).connect(feedback).connect(delay);
      tone.connect(this.master);
      this.ctx = ctx;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private get ready() {
    return !this.muted && !!this.ctx && this.ctx.state === 'running';
  }

  tone({ freq, to, type = 'sine', dur = 0.08, gain = 0.1, delay = 0, attack = 0.004, space = 0.25, lowpass }: ToneOpts) {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node: AudioNode = osc;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      node = node.connect(f);
    }
    node.connect(env);
    env.connect(this.master);
    if (space > 0) {
      const send = ctx.createGain();
      send.gain.value = space;
      env.connect(send).connect(this.echo);
    }
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  noise({ dur, gain, from, to, q = 1.2, delay = 0, space = 0.3 }: NoiseOpts) {
    if (!this.ready) return;
    const ctx = this.ctx!;
    if (!this.noiseBuf) {
      this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = q;
    band.frequency.setValueAtTime(from, t);
    band.frequency.exponentialRampToValueAtTime(to, t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + dur * 0.35);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(band).connect(env).connect(this.master);
    if (space > 0) {
      const send = this.ctx!.createGain();
      send.gain.value = space;
      env.connect(send).connect(this.echo);
    }
    src.start(t);
    src.stop(t + dur + 0.05);
  }
}

const engine = new Engine();

// ---- the palette ------------------------------------------------------------------------

export const sfx = {
  key: () => engine.tone({ freq: 2800 + Math.random() * 900, type: 'triangle', dur: 0.018, gain: 0.03, space: 0 }),
  click: () => engine.tone({ freq: 1250, to: 900, type: 'triangle', dur: 0.045, gain: 0.08, space: 0.1 }),
  open: () => {
    engine.tone({ freq: 620, to: 930, dur: 0.07, gain: 0.07 });
    engine.tone({ freq: 930, to: 1400, dur: 0.07, gain: 0.06, delay: 0.05 });
    engine.noise({ dur: 0.18, gain: 0.025, from: 800, to: 4000, space: 0 });
  },
  close: () => {
    engine.tone({ freq: 1400, to: 930, dur: 0.07, gain: 0.06 });
    engine.tone({ freq: 930, to: 600, dur: 0.07, gain: 0.05, delay: 0.05 });
  },
  select: () => {
    engine.tone({ freq: 520, to: 1560, dur: 0.12, gain: 0.09 });
    engine.tone({ freq: 780, to: 2340, type: 'triangle', dur: 0.12, gain: 0.035, delay: 0.015 });
  },
  focus: () => {
    engine.noise({ dur: 0.5, gain: 0.07, from: 280, to: 2600, q: 2.2, space: 0.4 });
    engine.tone({ freq: 110, to: 220, dur: 0.45, gain: 0.08, attack: 0.05, lowpass: 900 });
    engine.tone({ freq: 880, to: 1320, dur: 0.12, gain: 0.05, delay: 0.32 });
  },
  back: () => engine.tone({ freq: 1300, to: 420, dur: 0.13, gain: 0.07 }),
  deselect: () => engine.tone({ freq: 900, to: 500, dur: 0.08, gain: 0.05, space: 0.1 }),
  zoomIn: () => engine.tone({ freq: 880, to: 1320, dur: 0.06, gain: 0.05, space: 0.05 }),
  zoomOut: () => engine.tone({ freq: 880, to: 587, dur: 0.06, gain: 0.05, space: 0.05 }),
  pan: () => engine.tone({ freq: 660, dur: 0.03, gain: 0.03, space: 0 }),
  reset: () => {
    engine.noise({ dur: 0.45, gain: 0.06, from: 2600, to: 300, q: 2, space: 0.35 });
    engine.tone({ freq: 440, to: 220, dur: 0.35, gain: 0.05, lowpass: 1200 });
  },
  toggle: (on: boolean) => {
    engine.tone({ freq: on ? 700 : 1050, dur: 0.05, gain: 0.06 });
    engine.tone({ freq: on ? 1050 : 700, dur: 0.06, gain: 0.06, delay: 0.06 });
  },
  launch: () => {
    engine.tone({ freq: 180, to: 1400, type: 'sawtooth', dur: 0.38, gain: 0.035, lowpass: 1800, attack: 0.03, space: 0.35 });
    engine.tone({ freq: 1320, dur: 0.08, gain: 0.05, delay: 0.3 });
  },
  success: () => [1046.5, 1318.5, 1568, 2093].forEach((f, i) => engine.tone({ freq: f, dur: 0.22, gain: 0.06, delay: i * 0.075, space: 0.35 })),
  error: () => {
    engine.tone({ freq: 220, type: 'square', dur: 0.16, gain: 0.05, lowpass: 900 });
    engine.tone({ freq: 165, type: 'square', dur: 0.24, gain: 0.05, lowpass: 800, delay: 0.17 });
  },
  alarm: () => [880, 660, 880, 660].forEach((f, i) => engine.tone({ freq: f, type: 'triangle', dur: 0.11, gain: 0.05, delay: i * 0.13, space: 0.15 })),
  recover: () => [660, 990, 1320].forEach((f, i) => engine.tone({ freq: f, dur: 0.14, gain: 0.05, delay: i * 0.07, space: 0.3 })),
  chime: () => {
    engine.tone({ freq: 1568, dur: 0.3, gain: 0.05, space: 0.4 });
    engine.tone({ freq: 2093, dur: 0.3, gain: 0.035, delay: 0.04, space: 0.4 });
  },
};

const EVENT_SOUND: Partial<Record<ActivityEvent['kind'], () => void>> = {
  'deploy-start': sfx.launch,
  'deploy-ok': sfx.success,
  'deploy-fail': sfx.error,
  down: sfx.alarm,
  up: sfx.recover,
  'new-node': sfx.chime,
};

/** Map store transitions to sounds. Returns a cleanup function. */
export function bindSounds() {
  engine.muted = useStore.getState().muted;
  const unlock = () => engine.unlock();
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  let lastEvent = 0;

  const unsubscribe = useStore.subscribe((s: State, p: State) => {
    if (s.muted !== p.muted) {
      engine.muted = s.muted;
      if (!s.muted) sfx.toggle(true);
      return;
    }
    if (!s.ready || !p.ready) return; // stay quiet while the first snapshot loads

    if (s.menu !== p.menu) (s.menu ? (p.menu ? sfx.click : sfx.open) : sfx.close)();

    if (s.selectedId !== p.selectedId) {
      if (s.selectedId) sfx.select();
      else if (s.selectedProjectId) sfx.back();
      else sfx.deselect();
    } else if (s.focus !== p.focus && s.focus?.kind === 'project') {
      if (p.selectedProjectId && !p.selectedId && s.selectedProjectId === p.selectedProjectId) sfx.click();
      else sfx.focus();
    } else if (s.focus !== p.focus && s.focus?.kind === 'service') {
      sfx.select(); // re-framing the same node
    } else if (!s.selectedProjectId && p.selectedProjectId) {
      sfx.deselect();
    }

    if (s.camera !== p.camera && s.camera) {
      const k = s.camera.kind;
      (k === 'zoomIn' ? sfx.zoomIn : k === 'zoomOut' ? sfx.zoomOut : k === 'reset' ? sfx.reset : sfx.pan)();
    }
    if (s.heatmap !== p.heatmap) sfx.toggle(s.heatmap);
    if (s.search !== p.search && s.search.length > p.search.length) sfx.key();

    // Live events: one sound at a time, never from a background tab.
    if (s.events !== p.events && s.events.length && !document.hidden) {
      const seen = new Set(p.events.map((e) => e.id));
      const fresh = s.events.filter((e) => !seen.has(e.id));
      const now = performance.now();
      const loudest = fresh.find((e) => e.kind === 'down' || e.kind === 'deploy-fail') ?? fresh.find((e) => EVENT_SOUND[e.kind]);
      if (loudest && now - lastEvent > 700) {
        lastEvent = now;
        EVENT_SOUND[loudest.kind]?.();
      }
    }
  });

  return () => {
    unsubscribe();
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
  };
}
