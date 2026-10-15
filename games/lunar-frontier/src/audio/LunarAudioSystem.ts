/**
 * Lunar Frontier — 100% procedural Web Audio engine (Spec 25 §2.5 / §3.3).
 *
 * Zero audio assets: every sound is synthesised live with `AudioContext`,
 * `OscillatorNode`, `GainNode`, `BiquadFilterNode` and looped white-noise
 * buffers. The signal graph floats on three user-mixable buses feeding one
 * master gain:
 *
 *   ambience ──┐                      ┌── motor whine (saw, 120→950 Hz)
 *   music ─────┼──► master ──► out    ├── regolith crunch (band-passed noise)
 *   sfx ───────┘                      ├── mining laser (440 Hz square,
 *        (world sub-bus)             │    30 Hz tremolo + noise crackle)
 *                                     └── one-shots: ore chime, footstep,
 *                                          comms chirp
 *
 * Buses:
 *   • ambience — sub-bass life-support drone: dual sines at 48 Hz & 52 Hz
 *     with a slow 0.15 Hz LFO pulse on the shared gain.
 *   • music    — generative pentatonic chords (sine/triangle voices through
 *     an 800 Hz low-pass, 2.5 s attack / 4.0 s decay) triggering every
 *     12–20 s.
 *   • sfx      — driving loop (motor + regolith crunch), mining loop, and
 *     one-shot cues (ore chime 1760→2640 Hz, 80 Hz suit thud, comms chirps).
 *
 * The sfx bus carries a mode shaper (`cabin` vs `vacuum`): on the airless
 * surface only suit-conducted and radio paths survive, so world-coupled
 * loops (motor / crunch / laser) duck hard while footsteps, chimes and
 * comms stay full-level (Spec 24 §2.4 acoustic cut).
 *
 * Headless-resilient (Spec 25 §2.5): when neither `AudioContext` nor
 * `window` exists (CI — e.g. `scripts/smoke-client-app.ts` under tsx), an
 * internal mock context/nodes keeps the full public surface callable with
 * no wall-clock audio and no thrown errors. Browser autoplay policy is
 * honoured: the context stays suspended until the first pointer/key gesture
 * resumes it (retries lazily on every play call).
 */

// ---------------------------------------------------------------------------
// Public contract (Spec 25 §2.5)
// ---------------------------------------------------------------------------

/** User-facing fader positions, each normalised 0.0 – 1.0. */
export interface AudioVolumes {
  master: number;
  ambience: number;
  music: number;
  sfx: number;
}

/** Comms chirp flavours (Spec 25 §2.5: alert / incoming / burst). */
export type CommsChirpType = 'alert' | 'incoming' | 'burst';

/** Acoustic environment: pressurised lander cabin vs vacuum EVA. */
export type AudioMode = 'cabin' | 'vacuum';

/** Boot defaults (mirrored structurally by `HUD_DEFAULT_AUDIO_VOLUMES`). */
export const DEFAULT_AUDIO_VOLUMES: Readonly<AudioVolumes> = {
  master: 1.0,
  ambience: 0.7,
  music: 0.55,
  sfx: 0.9,
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Exponential-ramp floor: WebAudio forbids exp-ramping to exactly 0. */
const SILENT = 0.0001;

/** Internal bus base levels (user fader multiplies on top of these). */
const BASE_LEVEL = {
  ambience: 0.18,
  music: 0.32,
  motor: 0.11,
  crunch: 0.075,
  mining: 0.16,
  oneShot: 0.9,
} as const;

/**
 * Mode shapers. `ambience` scales the life-support drone; `world` scales
 * the world-coupled sfx sub-bus (motor / crunch / laser). One-shots (chime,
 * footstep, comms) ride the sfx bus directly — suit-conducted paths survive.
 */
const MODE_SHAPERS: Readonly<Record<AudioMode, { ambience: number; world: number }>> = {
  cabin: { ambience: 1.0, world: 1.0 },
  vacuum: { ambience: 0.32, world: 0.16 },
};

/** Electric motor whine band (Spec: 120 Hz → 950 Hz over ground speed). */
const MOTOR_FLOOR_HZ = 120;
const MOTOR_CEILING_HZ = 950;
/** Speed that pegs the driving-audio fader (m/s, traction-battery redline). */
const SOUND_REF_SPEED_MPS = 22;

/** Life-support drone pair + LFO (Spec 25 §2.5: 48/52 Hz, 0.15 Hz pulse). */
const DRONE_FREQ_A_HZ = 48;
const DRONE_FREQ_B_HZ = 52;
const DRONE_LFO_HZ = 0.15;

/** Generative music window (Spec: every 12–20 s). */
const MUSIC_MIN_GAP_S = 12;
const MUSIC_MAX_GAP_S = 20;
/** Chord envelope (Spec: attack 2.5 s / decay 4.0 s) + filter (800 Hz). */
const MUSIC_ATTACK_S = 2.5;
const MUSIC_DECAY_S = 4.0;
const MUSIC_LOWPASS_HZ = 800;
/** A2 root + minor-pentatonic semitone steps (5 degrees). */
const MUSIC_PENTA_ROOT_HZ = 110;
const MUSIC_PENTA_STEPS: readonly number[] = [0, 3, 5, 7, 10];

/** Mining laser (Spec: 440 Hz square, 30 Hz tremolo, noise crackle). */
const MINING_SQUARE_HZ = 440;
const MINING_TREMOLO_HZ = 30;

/** Mineral chime sweep (Spec: 1760 Hz → 2640 Hz crystalline ping). */
const CHIME_START_HZ = 1760;
const CHIME_END_HZ = 2640;

/** Suit footstep thud (Spec: 80 Hz muffled) + anti-machine-gun gate. */
const FOOTSTEP_THUD_HZ = 80;
const FOOTSTEP_MIN_GAP_S = 0.14;

/** Noise buffer length baked once per context (seconds). */
const NOISE_BUFFER_SECONDS = 2;

// ---------------------------------------------------------------------------
// Structural Web Audio surface
// ---------------------------------------------------------------------------

/**
 * The exact subset of the Web Audio API this engine touches, declared
 * structurally so the module compiles with zero imports and the headless
 * mock can satisfy it. Real browsers satisfy it directly (the concrete
 * `AudioContext` is cast through `unknown` at the boundary).
 */
interface Paramish {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
  cancelScheduledValues(startTime: number): unknown;
}

interface Nodeish {
  connect(destination: Nodeish | Paramish): Nodeish | void;
  disconnect(): unknown;
}

interface Oscillatorish extends Nodeish {
  frequency: Paramish;
  detune: Paramish;
  type: string;
  start(when?: number): unknown;
  stop(when?: number): unknown;
}

interface Gainish extends Nodeish {
  gain: Paramish;
}

interface Filterish extends Nodeish {
  frequency: Paramish;
  Q: Paramish;
  type: string;
}

interface Bufferish {
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

interface BufferSourceish extends Nodeish {
  buffer: Bufferish | null;
  loop: boolean;
  playbackRate: Paramish;
  start(when?: number): unknown;
  stop(when?: number): unknown;
}

interface Contextish {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: Nodeish;
  resume(): Promise<void>;
  createOscillator(): Oscillatorish;
  createGain(): Gainish;
  createBiquadFilter(): Filterish;
  createBufferSource(): BufferSourceish;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): Bufferish;
}

// ---------------------------------------------------------------------------
// Headless mock (Spec 25 §2.5: smoke suites run without a browser)
// ---------------------------------------------------------------------------

class MockParam implements Paramish {
  value = 0;
  setValueAtTime(value: number): this {
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number): this {
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number): this {
    this.value = Math.max(value, 0);
    return this;
  }
  setTargetAtTime(target: number): this {
    this.value = target;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class MockNode implements Nodeish {
  connect(destination: Nodeish | Paramish): Nodeish | void {
    return destination instanceof MockNode ? destination : undefined;
  }
  disconnect(): void {
    /* no-op */
  }
}

class MockGain extends MockNode implements Gainish {
  readonly gain = new MockParam();
}

class MockOscillator extends MockNode implements Oscillatorish {
  readonly frequency = new MockParam();
  readonly detune = new MockParam();
  type = 'sine';
  start(): void {
    /* no-op */
  }
  stop(): void {
    /* no-op */
  }
}

class MockBiquadFilter extends MockNode implements Filterish {
  readonly frequency = new MockParam();
  readonly Q = new MockParam();
  type = 'lowpass';
}

class MockBufferSource extends MockNode implements BufferSourceish {
  buffer: Bufferish | null = null;
  loop = false;
  readonly playbackRate = new MockParam();
  start(): void {
    /* no-op */
  }
  stop(): void {
    /* no-op */
  }
}

/** Mock `AudioContext` — full structural surface, zero sound, zero timers. */
export class MockAudioContext implements Contextish {
  readonly currentTime = 0;
  readonly sampleRate = 48000;
  state = 'running';
  readonly destination: Nodeish = new MockNode();

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  createOscillator(): Oscillatorish {
    return new MockOscillator();
  }
  createGain(): Gainish {
    return new MockGain();
  }
  createBiquadFilter(): Filterish {
    return new MockBiquadFilter();
  }
  createBufferSource(): BufferSourceish {
    return new MockBufferSource();
  }
  createBuffer(_channels: number, length: number, sampleRate: number): Bufferish {
    const data = new Float32Array(length);
    return {
      length,
      sampleRate,
      getChannelData: () => data,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// LunarAudioSystem
// ---------------------------------------------------------------------------

export class LunarAudioSystem {
  /** Null until `init()` builds it (real context in browsers, mock in CI). */
  private ctx: Contextish | null = null;
  private initialized = false;
  private disposed = false;
  /** True when running on the internal mock (no AudioContext available). */
  private headless = false;

  private volumes: AudioVolumes = { ...DEFAULT_AUDIO_VOLUMES };
  private mode: AudioMode = 'vacuum';

  // -- graph (built once in init; all gain-gated, oscillators run forever) --
  private master: Gainish | null = null;
  private ambienceBus: Gainish | null = null;
  private musicBus: Gainish | null = null;
  private sfxBus: Gainish | null = null;
  /** Mode shaper for world-coupled sfx (motor / crunch / laser). */
  private worldMode: Gainish | null = null;

  private motorOsc: Oscillatorish | null = null;
  private motorFilter: Filterish | null = null;
  private motorGain: Gainish | null = null;

  private crunchSource: BufferSourceish | null = null;
  private crunchFilter: Filterish | null = null;
  private crunchGain: Gainish | null = null;

  private miningGain: Gainish | null = null;

  private musicFilter: Filterish | null = null;

  /** Drive factors (0..1) written by `updateDrivingAudio` every frame. */
  private motorDrive = 0;
  private crunchDrive = 0;
  /** Mining loop state (0 = silent). */
  private miningLevel = 0;

  private noiseBuffer: Bufferish | null = null;
  private musicTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFootstepAt = Number.NEGATIVE_INFINITY;

  /** Persistent voices stopped on dispose (one-shots self-stop). */
  private readonly ownedVoices: { stop(): unknown }[] = [];
  /** Autoplay-policy gesture listeners (browsers only). */
  private gestureHandlers: {
    target: { removeEventListener: (t: string, fn: unknown) => void };
    type: string;
    fn: unknown;
  }[] = [];

  // -- lifecycle -------------------------------------------------------------

  /**
   * Build the synthesis graph. Idempotent and autoplay-safe: in a browser
   * the context may start `suspended` and is resumed on the first user
   * gesture (pointerdown/keydown) — or immediately if already running.
   * Headless (no `AudioContext`, no `window`) falls back to the internal
   * mock so smoke suites exercise the same call surface without a browser.
   */
  async init(): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;

    this.ctx = this.createContext();
    const ctx = this.ctx;
    this.buildGraph(ctx);
    this.applyVolumes();
    this.applyModeTargets();
    this.attachAutoplayHandlers();

    // Generative music loop: self-rescheduling 12–20 s chain (unref'd so a
    // Node CI process is never held open by the score).
    this.scheduleNextChord();
  }

  /** Tear the graph down; idempotent, safe before `init()`. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.musicTimer !== null) {
      clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
    for (const entry of this.gestureHandlers) {
      try {
        entry.target.removeEventListener(entry.type, entry.fn);
      } catch {
        /* headless teardown — nothing was attached anyway */
      }
    }
    this.gestureHandlers = [];

    for (const voice of this.ownedVoices) {
      try {
        voice.stop();
      } catch {
        /* already stopped / context closed */
      }
    }
    this.ownedVoices.length = 0;

    const ctx = this.ctx as (Contextish & { close?: () => Promise<void> }) | null;
    if (ctx !== null && typeof ctx.close === 'function') {
      try {
        void ctx.close();
      } catch {
        /* already closed */
      }
    }
    this.ctx = null;
    this.master = null;
    this.ambienceBus = null;
    this.musicBus = null;
    this.sfxBus = null;
    this.worldMode = null;
    this.motorOsc = null;
    this.motorFilter = null;
    this.motorGain = null;
    this.crunchSource = null;
    this.crunchFilter = null;
    this.crunchGain = null;
    this.miningGain = null;
    this.musicFilter = null;
    this.noiseBuffer = null;
  }

  // -- state / readback --------------------------------------------------------

  /** Current user volumes (pre-mode, pre-base-level). */
  getVolumes(): AudioVolumes {
    return { ...this.volumes };
  }

  /** Current acoustic environment. */
  getMode(): AudioMode {
    return this.mode;
  }

  isInitialized(): boolean {
    return this.initialized && !this.disposed;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** True when running against the internal mock context (CI). */
  isHeadless(): boolean {
    return this.headless;
  }

  // -- user mixing -------------------------------------------------------------

  /** Apply a partial volume snapshot (0..1 clamped). Safe before `init()`. */
  setVolumes(volumes: Partial<AudioVolumes>): void {
    if (this.disposed) return;
    const next = { ...this.volumes };
    if (volumes.master !== undefined) next.master = clamp01(volumes.master);
    if (volumes.ambience !== undefined) next.ambience = clamp01(volumes.ambience);
    if (volumes.music !== undefined) next.music = clamp01(volumes.music);
    if (volumes.sfx !== undefined) next.sfx = clamp01(volumes.sfx);
    this.volumes = next;
    this.applyVolumes();
  }

  /**
   * Switch acoustic environment (Spec 24 §2.4 / Spec 25 §2.5). `vacuum`
   * ducks the life-support drone and hard-attenuates world-coupled loops;
   * suit-conducted one-shots (footsteps, chimes) and comms stay full.
   */
  setAudioMode(mode: AudioMode): void {
    if (this.disposed || this.mode === mode) return;
    this.mode = mode;
    this.applyModeTargets();
    this.applyVolumes();
  }

  // -- continuous sources --------------------------------------------------------

  /**
   * Frame pump for the driving loop: electric motor whine (sawtooth steered
   * 120→950 Hz by ground speed, level riding throttle demand) and the
   * regolith tyre crunch (band-passed noise modulated by speed and ground
   * contact / suspension). Pass zeros when unmounted.
   */
  updateDrivingAudio(speedMps: number, throttleDemand: number, onGround: boolean): void {
    if (!this.ready()) return;
    const speed = clamp01(Math.abs(speedMps) / SOUND_REF_SPEED_MPS);
    const throttle = clamp01(Math.abs(throttleDemand));
    const grounded = onGround === true;
    const t = this.ctx!.currentTime;

    // Motor whine tracks ground speed across the full 120–950 Hz band.
    if (this.motorOsc !== null) {
      const freq = MOTOR_FLOOR_HZ + speed * (MOTOR_CEILING_HZ - MOTOR_FLOOR_HZ);
      this.motorOsc.frequency.setTargetAtTime(freq, t, 0.08);
      this.motorOsc.detune.setTargetAtTime(speed * 14, t, 0.2);
    }
    this.motorDrive =
      speed <= 0.02 && throttle <= 0.02
        ? 0
        : (0.22 + 0.78 * throttle) * (0.35 + 0.65 * speed) * (grounded ? 1 : 0.3);

    // Regolith crunch: noise floor rises with speed, gated by suspension
    // contact — airborne wheels never grind regolith.
    if (this.crunchFilter !== null) {
      this.crunchFilter.frequency.setTargetAtTime(850 + speed * 1400, t, 0.12);
    }
    this.crunchDrive = grounded ? speed * speed * (0.55 + 0.45 * throttle) : 0;

    this.applyDriveGains();
  }

  /**
   * Mining-laser loop (440 Hz square chopped by a 30 Hz tremolo plus a
   * white-noise crackle). Pulse `true` for the beam burst, then `false`
   * when the laser retracts; `intensity` (default 1) scales the burn.
   */
  setMiningAudioActive(active: boolean, intensity = 1): void {
    if (!this.ready()) return;
    this.miningLevel = active ? clamp01(intensity) : 0;
    if (this.miningGain !== null) {
      const t = this.ctx!.currentTime;
      const level =
        BASE_LEVEL.mining * this.volumes.sfx * this.miningLevel;
      this.miningGain.gain.setTargetAtTime(Math.max(level, 0), t, 0.05);
    }
    void this.resumeIfSuspended();
  }

  // -- one-shots ------------------------------------------------------------------

  /** High crystalline mineral ping: 1760 Hz → 2640 Hz sweep + shimmer. */
  playOreCollectChime(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + 0.01;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(CHIME_START_HZ, t0);
    osc.frequency.exponentialRampToValueAtTime(CHIME_END_HZ, t0 + 0.16);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(BASE_LEVEL.oneShot * 0.6, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(SILENT, t0 + 0.75);
    osc.connect(gain);
    gain.connect(this.sfxBus!);
    osc.start(t0);
    osc.stop(t0 + 0.8);

    // Octave shimmer tail.
    const shimmer = ctx.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.setValueAtTime(CHIME_END_HZ * 1.5, t0 + 0.02);
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.setValueAtTime(0, t0 + 0.02);
    shimmerGain.gain.linearRampToValueAtTime(BASE_LEVEL.oneShot * 0.22, t0 + 0.03);
    shimmerGain.gain.exponentialRampToValueAtTime(SILENT, t0 + 0.55);
    shimmer.connect(shimmerGain);
    shimmerGain.connect(this.sfxBus!);
    shimmer.start(t0 + 0.02);
    shimmer.stop(t0 + 0.6);

    void this.resumeIfSuspended();
  }

  /** 80 Hz muffled thud + short regolith scuff (suit footfall). */
  playFootstep(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    if (now - this.lastFootstepAt < FOOTSTEP_MIN_GAP_S) return;
    this.lastFootstepAt = now;
    const t0 = now + 0.005;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(FOOTSTEP_THUD_HZ * 1.4, t0);
    osc.frequency.exponentialRampToValueAtTime(FOOTSTEP_THUD_HZ * 0.75, t0 + 0.1);
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 180;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(BASE_LEVEL.oneShot * 0.5, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(SILENT, t0 + 0.14);
    osc.connect(muffle);
    muffle.connect(gain);
    gain.connect(this.sfxBus!);
    osc.start(t0);
    osc.stop(t0 + 0.16);

    // Scuff layer (band-passed noise, ~90 ms).
    const scuff = this.createNoiseSource();
    if (scuff !== null) {
      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 620;
      const scuffGain = ctx.createGain();
      scuffGain.gain.setValueAtTime(BASE_LEVEL.oneShot * 0.12, t0);
      scuffGain.gain.exponentialRampToValueAtTime(SILENT, t0 + 0.09);
      scuff.connect(bandpass);
      bandpass.connect(scuffGain);
      scuffGain.connect(this.sfxBus!);
      scuff.start(t0);
      scuff.stop(t0 + 0.1);
    }

    void this.resumeIfSuspended();
  }

  /** Short synthesised sine sequence announcing a comms transmission. */
  playCommsChirp(type: 'alert' | 'incoming' | 'burst'): void {
    if (!this.ready()) return;
    //           [startOffset, dur, freqStart, freqEnd]
    let sequence: readonly (readonly [number, number, number, number])[];
    switch (type) {
      case 'alert':
        sequence = [
          [0, 0.09, 740, 740],
          [0.13, 0.11, 988, 988],
        ];
        break;
      case 'burst':
        sequence = [
          [0, 0.14, 420, 1180],
          [0.16, 0.1, 1180, 520],
        ];
        break;
      case 'incoming':
      default:
        sequence = [
          [0, 0.07, 523, 523],
          [0.09, 0.07, 659, 659],
          [0.18, 0.09, 784, 784],
        ];
        break;
    }
    for (const [offset, dur, freqStart, freqEnd] of sequence) {
      this.chirpTone(offset, dur, freqStart, freqEnd);
    }
    void this.resumeIfSuspended();
  }

  // -- internals ---------------------------------------------------------------------

  private chirpTone(offset: number, dur: number, freqStart: number, freqEnd: number): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + 0.01 + offset;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqStart, t0);
    if (freqEnd !== freqStart) {
      osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(BASE_LEVEL.oneShot * 0.35, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(SILENT, t0 + dur + 0.03);
    osc.connect(gain);
    gain.connect(this.sfxBus!);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** Real AudioContext when available; internal mock in CI. */
  private createContext(): Contextish {
    const g = globalThis as { AudioContext?: unknown; window?: unknown };
    const hasAudioContext = typeof g.AudioContext === 'function';
    const hasWindow = typeof g.window !== 'undefined';
    if (hasAudioContext) {
      try {
        const Ctor = g.AudioContext as new () => unknown;
        return new Ctor() as unknown as Contextish;
      } catch {
        /* locked-down context — fall through to the mock */
      }
    } else if (!hasWindow) {
      // Spec 25 §2.5: headless CI (no AudioContext, no window) — mock.
      this.headless = true;
    }
    return new MockAudioContext();
  }

  /** Assemble the full synthesis graph on the given context. */
  private buildGraph(ctx: Contextish): void {
    // -- master chain ---------------------------------------------------------
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);

    this.ambienceBus = ctx.createGain();
    this.ambienceBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.worldMode = ctx.createGain();
    this.worldMode.connect(this.sfxBus);

    // -- ambience: 48 Hz + 52 Hz sines, 0.15 Hz LFO pulse ----------------------
    const droneMod = ctx.createGain();
    droneMod.connect(this.ambienceBus);
    const droneA = ctx.createOscillator();
    droneA.type = 'sine';
    droneA.frequency.value = DRONE_FREQ_A_HZ;
    const droneAGain = ctx.createGain();
    droneAGain.gain.value = 0.55;
    droneA.connect(droneAGain);
    droneAGain.connect(droneMod);
    const droneB = ctx.createOscillator();
    droneB.type = 'sine';
    droneB.frequency.value = DRONE_FREQ_B_HZ;
    droneB.detune.value = 6;
    const droneBGain = ctx.createGain();
    droneBGain.gain.value = 0.45;
    droneB.connect(droneBGain);
    droneBGain.connect(droneMod);
    // LFO swings the shared drone gain (0.25 ± 0.2 → the slow pulse).
    droneMod.gain.value = 0.55;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = DRONE_LFO_HZ;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.2;
    lfo.connect(lfoDepth);
    lfoDepth.connect(droneMod.gain);
    this.ownedVoices.push(droneA, droneB, lfo);
    droneA.start();
    droneB.start();
    lfo.start();

    // -- driving loop: motor whine (saw, speed-steered) -------------------------
    this.motorOsc = ctx.createOscillator();
    this.motorOsc.type = 'sawtooth';
    this.motorOsc.frequency.value = MOTOR_FLOOR_HZ;
    this.motorFilter = ctx.createBiquadFilter();
    this.motorFilter.type = 'lowpass';
    this.motorFilter.frequency.value = 2400;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    this.motorOsc.connect(this.motorFilter);
    this.motorFilter.connect(this.motorGain);
    this.motorGain.connect(this.worldMode);
    this.ownedVoices.push(this.motorOsc);
    this.motorOsc.start();

    // -- driving loop: regolith crunch (band-passed looped noise) ---------------
    const noise = this.ensureNoiseBuffer(ctx);
    this.crunchSource = ctx.createBufferSource();
    if (noise !== null) this.crunchSource.buffer = noise;
    this.crunchSource.loop = true;
    this.crunchFilter = ctx.createBiquadFilter();
    this.crunchFilter.type = 'bandpass';
    this.crunchFilter.frequency.value = 1100;
    this.crunchFilter.Q.value = 0.9;
    this.crunchGain = ctx.createGain();
    this.crunchGain.gain.value = 0;
    this.crunchSource.connect(this.crunchFilter);
    this.crunchFilter.connect(this.crunchGain);
    this.crunchGain.connect(this.worldMode);
    this.ownedVoices.push(this.crunchSource);
    this.crunchSource.start();

    // -- mining loop: 440 Hz square, 30 Hz tremolo, noise crackle ---------------
    const miningOsc = ctx.createOscillator();
    miningOsc.type = 'square';
    miningOsc.frequency.value = MINING_SQUARE_HZ;
    const tremoloBase = ctx.createGain();
    tremoloBase.gain.value = 0.5;
    miningOsc.connect(tremoloBase);
    const tremolo = ctx.createOscillator();
    tremolo.type = 'sine';
    tremolo.frequency.value = MINING_TREMOLO_HZ;
    const tremoloDepth = ctx.createGain();
    tremoloDepth.gain.value = 0.5;
    tremolo.connect(tremoloDepth);
    tremoloDepth.connect(tremoloBase.gain);
    this.miningGain = ctx.createGain();
    this.miningGain.gain.value = 0;
    tremoloBase.connect(this.miningGain);
    const crackle = ctx.createBufferSource();
    if (noise !== null) crackle.buffer = noise;
    crackle.loop = true;
    crackle.playbackRate.value = 1.7;
    const crackleFilter = ctx.createBiquadFilter();
    crackleFilter.type = 'highpass';
    crackleFilter.frequency.value = 2800;
    const crackleGain = ctx.createGain();
    crackleGain.gain.value = 0.35;
    crackle.connect(crackleFilter);
    crackleFilter.connect(crackleGain);
    crackleGain.connect(this.miningGain);
    this.miningGain.connect(this.worldMode);
    this.ownedVoices.push(miningOsc, tremolo, crackle);
    miningOsc.start();
    tremolo.start();
    crackle.start();

    // -- music bus: 800 Hz low-pass into the music fader ------------------------
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = MUSIC_LOWPASS_HZ;
    this.musicFilter.Q.value = 0.7;
    this.musicFilter.connect(this.musicBus);
  }

  private ensureNoiseBuffer(ctx: Contextish): Bufferish | null {
    if (this.noiseBuffer !== null) return this.noiseBuffer;
    try {
      const length = Math.floor(ctx.sampleRate * NOISE_BUFFER_SECONDS);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        // Light low-pass shaping (averaged pair) reads less harsh than raw
        // white; the crunch band-pass re-weights it downstream anyway.
        const a = Math.random() * 2 - 1;
        const b = Math.random() * 2 - 1;
        data[i] = (a + b) * 0.5;
      }
      this.noiseBuffer = buffer;
      return buffer;
    } catch {
      return null;
    }
  }

  /** One-shot noise source primed with the baked noise buffer (null in CI
   *  only if the context refused createBuffer). */
  private createNoiseSource(): BufferSourceish | null {
    const ctx = this.ctx;
    if (ctx === null) return null;
    try {
      const source = ctx.createBufferSource();
      const noise = this.ensureNoiseBuffer(ctx);
      if (noise !== null) source.buffer = noise;
      return source;
    } catch {
      return null;
    }
  }

  private applyVolumes(): void {
    if (this.master === null) return;
    const t = this.ctx === null ? 0 : this.ctx.currentTime;
    const shaper = MODE_SHAPERS[this.mode];
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.04);
    this.ambienceBus!.gain.setTargetAtTime(
      BASE_LEVEL.ambience * this.volumes.ambience * shaper.ambience,
      t,
      0.06,
    );
    this.musicBus!.gain.setTargetAtTime(BASE_LEVEL.music * this.volumes.music, t, 0.06);
    this.sfxBus!.gain.setTargetAtTime(this.volumes.sfx, t, 0.04);
    this.applyDriveGains();
  }

  private applyModeTargets(): void {
    if (this.worldMode === null || this.ctx === null) return;
    const t = this.ctx.currentTime;
    this.worldMode.gain.setTargetAtTime(MODE_SHAPERS[this.mode].world, t, 0.08);
  }

  private applyDriveGains(): void {
    if (this.ctx === null) return;
    const t = this.ctx.currentTime;
    if (this.motorGain !== null) {
      this.motorGain.gain.setTargetAtTime(
        BASE_LEVEL.motor * this.volumes.sfx * this.motorDrive,
        t,
        0.09,
      );
    }
    if (this.crunchGain !== null) {
      this.crunchGain.gain.setTargetAtTime(
        BASE_LEVEL.crunch * this.volumes.sfx * this.crunchDrive,
        t,
        0.12,
      );
    }
  }

  /** Self-rescheduling generative-chord timer (12–20 s, unref'd in Node). */
  private scheduleNextChord(): void {
    if (this.disposed || this.ctx === null) return;
    const gapMs =
      (MUSIC_MIN_GAP_S + Math.random() * (MUSIC_MAX_GAP_S - MUSIC_MIN_GAP_S)) * 1000;
    this.musicTimer = setTimeout(() => {
      this.musicTimer = null;
      if (this.disposed) return;
      this.playGenerativeChord();
      this.scheduleNextChord();
    }, gapMs);
    const handle = this.musicTimer as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') handle.unref();
  }

  /**
   * One pentatonic chord (3 voices: sine, sine, triangle) through the
   * 800 Hz low-pass with the 2.5 s / 4.0 s envelope. A2-rooted minor
   * pentatonic — the intervals never clash, so consecutive chords always
   * sit together no matter how the walk wanders.
   */
  playGenerativeChord(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    if (this.musicFilter === null) return;
    const t0 = ctx.currentTime + 0.05;

    const degree = Math.floor(Math.random() * MUSIC_PENTA_STEPS.length);
    const voiceDegrees = [degree, (degree + 2) % 5, (degree + 3) % 5];
    const voiceTypes = ['sine', 'sine', 'triangle'] as const;
    for (let i = 0; i < voiceDegrees.length; i++) {
      const d = voiceDegrees[i]!;
      // Wrap the pentatonic walk upward an octave past 5 degrees.
      const semitones = MUSIC_PENTA_STEPS[d]! + (i > 0 && d < degree ? 12 : 0);
      const freq = MUSIC_PENTA_ROOT_HZ * Math.pow(2, semitones / 12) * (i === 2 ? 2 : 1);
      const osc = ctx.createOscillator();
      osc.type = voiceTypes[i]!;
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.22, t0 + MUSIC_ATTACK_S);
      gain.gain.linearRampToValueAtTime(0, t0 + MUSIC_ATTACK_S + MUSIC_DECAY_S);
      osc.connect(gain);
      gain.connect(this.musicFilter);
      osc.start(t0);
      osc.stop(t0 + MUSIC_ATTACK_S + MUSIC_DECAY_S + 0.1);
    }
    void this.resumeIfSuspended();
  }

  /** Autoplay policy: resume on the first pointer/key gesture (once). */
  private attachAutoplayHandlers(): void {
    const g = globalThis as {
      window?: {
        addEventListener?: (type: string, fn: unknown, opts?: unknown) => void;
        removeEventListener?: (type: string, fn: unknown) => void;
      };
    };
    const win = g.window;
    if (win === undefined || win === null || typeof win.addEventListener !== 'function') {
      return;
    }
    for (const type of ['pointerdown', 'keydown', 'click'] as const) {
      const fn = () => {
        void this.resumeIfSuspended();
      };
      try {
        win.addEventListener(type, fn, { once: true });
        this.gestureHandlers.push({
          target: win as { removeEventListener: (t: string, fn: unknown) => void },
          type,
          fn: fn as unknown,
        });
      } catch {
        /* hostile window — lazy lazy-resume on play calls still applies */
      }
    }
  }

  /** Resume a suspended context; silently ignores rejections (pre-gesture). */
  private async resumeIfSuspended(): Promise<void> {
    const ctx = this.ctx;
    if (ctx === null || this.disposed) return;
    if (ctx.state === 'running') return;
    try {
      await ctx.resume();
    } catch {
      /* autoplay still blocked — the gesture handler retries */
    }
  }

  /** Graph ready flag for the public surface (false pre-init / post-dispose). */
  private ready(): boolean {
    return !this.disposed && this.initialized && this.ctx !== null;
  }
}

export default LunarAudioSystem;
