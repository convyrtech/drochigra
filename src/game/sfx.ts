/**
 * Sound and vibration for the game, synthesized on the Web Audio API.
 *
 * There are no audio assets anywhere — the whole issue #7 sound is generated in
 * code: every effect is a short oscillator or noise patch that is started, shaped
 * by an envelope and then stopped. Nothing is loaded, nothing lives outside the
 * page, and a stopped node cannot leak.
 *
 * This is pure view: src/sim never sees it. A missing AudioContext, a muted
 * toggle or a desktop without vibration just makes each call a no-op.
 *
 * The mute preference lives in its own little localStorage key, not inside the
 * saved game profile: it must survive reloads without touching the save schema
 * or the measured v1→v2 migration (AGENTS.md, issue #7).
 */

/** Where the mute toggle lives. Not the game profile, on purpose. */
export const SOUND_KEY = 'vostok9.sound';

interface ToneOptions {
  readonly freq: number;
  /** Hz the frequency runs towards over the note, for slides. */
  readonly freqEnd?: number;
  readonly type?: OscillatorType;
  /** Seconds the whole note lasts, envelope included. */
  readonly dur: number;
  /** Peak gain for this note, 0..1. */
  readonly gain?: number;
  readonly delay?: number;
}

interface NoiseOptions {
  /** Seconds of noise. */
  readonly dur: number;
  readonly gain?: number;
  /** Center of the bandpass the noise runs through. */
  readonly filterFreq?: number;
  readonly delay?: number;
}

interface Block {
  audio: AudioContext | null;
  muted: boolean;
}

const block: Block = { audio: null, muted: readMuted() };

function readMuted(): boolean {
  try {
    const value = (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage?.getItem(
      SOUND_KEY,
    );
    // Sound is on by default; only an explicit «off» mutes.
    return value === 'off';
  } catch {
    return false;
  }
}

function audio(): AudioContext | null {
  return block.audio;
}

/** Create or resume the context. Web Audio needs a user gesture to start. */
function unlock(): void {
  if (block.audio === null) {
    const Ctor = (globalThis as { AudioContext?: new () => AudioContext }).AudioContext;
    if (typeof Ctor !== 'function') {
      return;
    }
    block.audio = new Ctor();
  }
  const ctx = block.audio;
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume();
  }
}

/** Turn the whole sound system off or on; the choice is remembered. */
function setMuted(muted: boolean): void {
  block.muted = muted;
  try {
    (globalThis as { localStorage?: { setItem(key: string, value: string): void } }).localStorage?.setItem(
      SOUND_KEY,
      muted ? 'off' : 'on',
    );
  } catch {
    // Storage can be blocked; the toggle still works for this session.
  }
}

function isMuted(): boolean {
  return block.muted;
}

/** One short oscillator note, stopped after its envelope. */
function tone(options: ToneOptions): void {
  if (block.muted) {
    return;
  }
  const ctx = audio();
  if (!ctx) {
    return;
  }
  const start = ctx.currentTime + (options.delay ?? 0);
  const dur = options.dur;
  const gain = options.gain ?? 0.2;

  const osc = ctx.createOscillator();
  osc.type = options.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(1, options.freq), start);
  if (options.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, options.freqEnd), start + dur);
  }

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  osc.connect(g).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** A short burst of bandpassed noise, for scratches and impacts. */
function noise(options: NoiseOptions): void {
  if (block.muted) {
    return;
  }
  const ctx = audio();
  if (!ctx) {
    return;
  }
  const start = ctx.currentTime + (options.delay ?? 0);
  const dur = options.dur;
  const gain = options.gain ?? 0.2;

  const buffer = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * dur)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = options.filterFreq ?? 900;
  filter.Q.value = 1;

  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  source.connect(filter).connect(g).connect(ctx.destination);
  source.start(start);
  source.stop(start + dur + 0.02);
}

export interface Effects {
  /** Create/resume the AudioContext. Call on the first user gesture. */
  readonly unlock: () => void;
  readonly setMuted: (muted: boolean) => void;
  readonly isMuted: () => boolean;
  /** Various haptics; a desktop with no vibrate ignores the call. */
  readonly vibrate: (pattern: number | number[]) => void;
  readonly dig: () => void;
  readonly turret: () => void;
  readonly salvo: () => void;
  readonly domeHit: () => void;
  readonly siren: () => void;
  readonly bank: () => void;
  readonly hangarCollect: () => void;
  readonly victory: () => void;
}

/** The single sound object the view calls. Not connected to src/sim. */
export const SFX: Effects = {
  unlock,
  setMuted,
  isMuted,
  vibrate(pattern: number | number[]): void {
    const vibrate = (globalThis as { navigator?: Navigator }).navigator?.vibrate?.bind(
      (globalThis as { navigator?: Navigator }).navigator,
    );
    if (typeof vibrate === 'function') {
      try {
        vibrate(pattern);
      } catch {
        // Some browsers throw on a bad pattern; haptics are never worth crashing for.
      }
    }
  },

  /** Short low scratch/thud — the drill biting rock. */
  dig(): void {
    noise({ dur: 0.07, gain: 0.25, filterFreq: 700 });
    tone({ freq: 140, freqEnd: 90, type: 'triangle', dur: 0.09, gain: 0.18 });
  },

  /** Short high «pew» — a turret shot. */
  turret(): void {
    tone({ freq: 420, freqEnd: 920, type: 'square', dur: 0.09, gain: 0.09 });
  },

  /** Low powerful impact with a rumble — one salvo over the whole screen. */
  salvo(): void {
    noise({ dur: 0.42, gain: 0.34, filterFreq: 320 });
    tone({ freq: 130, freqEnd: 40, type: 'sawtooth', dur: 0.4, gain: 0.28 });
    tone({ freq: 60, freqEnd: 30, type: 'sine', dur: 0.45, gain: 0.3 });
  },

  /** Dull thud with decay — an enemy biting the dome. */
  domeHit(): void {
    tone({ freq: 110, freqEnd: 55, type: 'sine', dur: 0.22, gain: 0.32 });
    noise({ dur: 0.12, gain: 0.16, filterFreq: 260 });
  },

  /** Two-tone alarm wail — the dome is on the edge. */
  siren(): void {
    // A triangle that sways up and down reads as an alarm, not a static beep.
    tone({ freq: 560, freqEnd: 880, type: 'triangle', dur: 0.28, gain: 0.16 });
    tone({ freq: 880, freqEnd: 560, type: 'triangle', dur: 0.28, gain: 0.16, delay: 0.26 });
    tone({ freq: 560, freqEnd: 880, type: 'triangle', dur: 0.28, gain: 0.14, delay: 0.52 });
  },

  /** A coin pop — the cargo is handed over. */
  bank(): void {
    tone({ freq: 980, type: 'sine', dur: 0.1, gain: 0.16 });
    tone({ freq: 1470, type: 'sine', dur: 0.16, gain: 0.1, delay: 0.04 });
  },

  /** Rising sparkle — taking the hangar's pile. */
  hangarCollect(): void {
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, i) => {
      tone({ freq, type: 'triangle', dur: 0.22, gain: 0.16, delay: i * 0.07 });
    });
  },

  /** Rising fanfare — the bottom is reached. */
  victory(): void {
    const chord: readonly [number, number][] = [
      [523, 0],
      [659, 0],
      [784, 0],
      [1047, 0.12],
      [1319, 0.24],
    ];
    for (const [freq, delay] of chord) {
      tone({ freq, type: 'triangle', dur: 0.9, gain: 0.16, delay });
    }
  },
};
