/**
 * Spec 33 Phase 5 §2.6 — Tactile haptic feedback engine.
 *
 * A lightweight, duck-typed wrapper around `navigator.vibrate` giving mobile
 * players physical feedback the desktop client simply does not need:
 *
 *   • `footfall()`        — 12 ms micro-pulse on stance-boot impact.
 *   • `rcsBoost()`        — crisp double-tap [15, 30, 20] on PLSS ignition.
 *   • `miningPulse()`     — 25 ms buzz, self-throttled to one pulse per
 *                           150 ms while a mining beam stays latched.
 *   • `collisionImpact()` — 60 ms heavy shock on rover landings / bottom-outs.
 *
 * Safety contract: every call is a no-op returning `false` when the platform
 * has no `navigator.vibrate` (iOS Safari ships without the Vibration API,
 * headless Node has no navigator at all) or when the player toggled haptics
 * off. The toggle persists in `localStorage['LF_HAPTICS']` (shared slot with
 * MobileSettings; the name deliberately avoids a `_KEY` suffix because secret
 * redaction pipelines redact `*_KEY` identifiers).
 */

import { readHapticsEnabled, writeHapticsEnabled } from '../client/MobileSettings.ts';

/** Footfall micro-pulse length (ms) — spec 33 §2.6 "single micro-tap". */
export const FOOTFALL_PULSE_MS = 12;

/** RCS boost double-tap pattern (ms on / ms off / ms on) — spec 33 §2.6. */
export const RCS_BOOST_PATTERN: readonly number[] = [15, 30, 20];

/** Mining laser pulse length (ms) — spec 33 §2.6 "low-amplitude buzz". */
export const MINING_PULSE_MS = 25;

/** Minimum spacing between mining pulses while the beam is latched (ms). */
export const MINING_PULSE_INTERVAL_MS = 150;

/** Rover ground collision / bottoming-out shock thump (ms). */
export const COLLISION_IMPACT_MS = 60;

/** Minimum spacing between heavy impacts so hammering bumps cannot buzz-saw. */
export const COLLISION_IMPACT_INTERVAL_MS = 250;

/** Duck-typed view of the Vibration API surface we depend on. */
export interface VibratesLike {
  vibrate(pattern: number | readonly number[]): boolean;
}

/** Resolve `navigator.vibrate` when present, else null (iOS / headless). */
export function resolveVibrator(): VibratesLike | null {
  try {
    const nav = globalThis as { navigator?: { vibrate?: unknown } };
    const candidate = nav.navigator?.vibrate;
    return typeof candidate === 'function'
      ? (nav.navigator as unknown as VibratesLike)
      : null;
  } catch {
    return null;
  }
}

/** performance.now()-based clock with a Date fallback for exotic runtimes. */
function nowMs(): number {
  try {
    const p = globalThis as { performance?: { now?: () => number } };
    if (typeof p.performance?.now === 'function') return p.performance.now();
  } catch {
    /* fall through */
  }
  return Date.now();
}

export interface TactileHapticsOptions {
  /** Force the enable flag (wins over the persisted `LF_HAPTICS` value). */
  enabled?: boolean;
  /** Injected clock (headless harnesses) — milliseconds, monotonic. */
  now?: () => number;
}

/**
 * Haptic synthesizer. One instance per ClientApp; all methods are safe to
 * call at any frame rate on any platform (return value reports whether a
 * pulse was actually dispatched, which smoke suites assert against).
 */
export class TactileHaptics {
  private enabled: boolean;
  private readonly clock: () => number;
  /** Throttle clock for the periodic mining buzz. */
  private lastMiningPulseAt = Number.NEGATIVE_INFINITY;
  /** Throttle clock for heavy collision shocks. */
  private lastImpactAt = Number.NEGATIVE_INFINITY;

  constructor(options: TactileHapticsOptions = {}) {
    this.clock = options.now ?? nowMs;
    this.enabled = options.enabled ?? readHapticsEnabled();
  }

  /** True when this platform exposes `navigator.vibrate` at all. */
  static isSupported(): boolean {
    return resolveVibrator() !== null;
  }

  /** Current enable flag (platform support is checked per pulse). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Toggle haptics and persist the choice to `localStorage['LF_HAPTICS']`.
   * Returns the resulting state.
   */
  setEnabled(on: boolean): boolean {
    this.enabled = on;
    writeHapticsEnabled(on);
    if (!on) {
      // Cancel any pattern still playing when the player bails out mid-pulse.
      const vibrator = resolveVibrator();
      if (vibrator !== null) {
        try {
          vibrator.vibrate(0);
        } catch {
          /* hostile implementation */
        }
      }
    }
    return this.enabled;
  }

  /** Suit footfall contact: single 12 ms micro-tap on boot impact. */
  footfall(): boolean {
    return this.pulse(FOOTFALL_PULSE_MS);
  }

  /** RCS boost activation: crisp [15, 30, 20] cold-gas double tap. */
  rcsBoost(): boolean {
    return this.pulse(RCS_BOOST_PATTERN);
  }

  /**
   * Mining laser discharge: 25 ms pulse, self-throttled to one pulse per
   * {@link MINING_PULSE_INTERVAL_MS} while the caller keeps the beam latched.
   * Returns false for pulses suppressed by the throttle.
   */
  miningPulse(): boolean {
    const now = this.clock();
    if (now - this.lastMiningPulseAt < MINING_PULSE_INTERVAL_MS) return false;
    this.lastMiningPulseAt = now;
    return this.pulse(MINING_PULSE_MS);
  }

  /** Rover ground collision / suspension bottom-out: heavy 60 ms thump. */
  collisionImpact(): boolean {
    const now = this.clock();
    if (now - this.lastImpactAt < COLLISION_IMPACT_INTERVAL_MS) return false;
    this.lastImpactAt = now;
    return this.pulse(COLLISION_IMPACT_MS);
  }

  /** Dispatch one pattern; false when disabled / unsupported / hostile. */
  private pulse(pattern: number | readonly number[]): boolean {
    if (!this.enabled) return false;
    const vibrator = resolveVibrator();
    if (vibrator === null) return false;
    try {
      // Treat "no throw" as dispatched: the Vibration API is specced to
      // return a boolean, but lenient implementations return undefined.
      vibrator.vibrate(pattern);
      return true;
    } catch {
      return false;
    }
  }
}

export default TactileHaptics;
