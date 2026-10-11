/**
 * Lunar Frontier — Spec 24 Phase 2: IntroDirector cinematic sequencer.
 *
 * A finite state machine that coordinates the first-time arrival experience:
 * orbit → retro-burn → touchdown → depressurize → ramp deploy → walkout →
 * completed. It drives the `CameraRig` between its two new intro tracks
 * (`intro_cabin` interior viewport / `intro_cinematic` exterior tracking),
 * animates the `TransportLander` (thruster intensity, gear compression, ramp
 * deployment), and emits phase-change / completion callbacks.
 *
 * Design notes:
 *   - Headless-safe by construction: no DOM, no render loop. The director only
 *     reads Babylon scene state and calls `CameraRig.update()` / lander mutators,
 *     all of which are NullEngine-safe.
 *   - Durations are wall-clock seconds at `timeScale = 1`; `update(dt)` scales
 *     dt by `timeScale` before accumulating, so test harnesses can fast-forward.
 *   - The state machine is linear and monotonic: each phase advances to the next
 *     once its duration elapses. `jumpToPhase`, `skipCurrentPhase`,
 *     `skipToFinish` and `reset` are provided for the replay/test suite.
 *
 * Usage (ClientApp):
 *   const director = new IntroDirector({ scene, cameraRig, lander, hud });
 *   director.start('orbit');          // or jumpToPhase / skipToFinish
 *   director.update(dt);             // every render frame
 */

import type { Scene } from '@babylonjs/core/scene.js';
import type { CameraRig } from '../engine/CameraRig.ts';
import { babylonToWorld } from '../engine/CameraRig.ts';
import type { TransportLander } from '../entities/TransportLander.ts';

/** Intro state-machine phase (Spec 24 §4.2). */
export type IntroPhase =
  | 'idle'
  | 'orbit'
  | 'burn'
  | 'touchdown'
  | 'depressurize'
  | 'ramp'
  | 'walkout'
  | 'completed';

/** Director construction options (Spec 24 §4.2). */
export interface IntroDirectorOptions {
  /** The Babylon scene hosting the lander and cameras. */
  scene: Scene;
  /** Camera rig whose intro tracks this director drives. */
  cameraRig: CameraRig;
  /** Optional HUD overlay (`LunarHUD` or a duck-typed stub). */
  hud?: unknown;
  /** The transport lander being animated (thrusters, gear, ramp). */
  lander: TransportLander;
  /** Fired on every phase transition (including entering `completed`). */
  onPhaseChange?: (phase: IntroPhase) => void;
  /** Fired once when the sequence reaches `completed`. */
  onComplete?: () => void;
  /** Time multiplier applied to `update(dt)` (default 1.0). */
  timeScale?: number;
  /** Optional persistence backend (defaults to localStorage in ClientApp). */
  storage?: Storage;
}

/** Phase durations in seconds at `timeScale = 1`. */
export const PHASE_DURATIONS: Record<IntroPhase, number> = {
  idle: 0,
  orbit: 6.0,
  burn: 12.0,
  touchdown: 3.5,
  depressurize: 4.0,
  ramp: 8.0,
  walkout: 10.0,
  completed: 0,
};

/** Canonical phase order (index drives auto-advance). */
export const PHASE_ORDER: readonly IntroPhase[] = [
  'idle',
  'orbit',
  'burn',
  'touchdown',
  'depressurize',
  'ramp',
  'walkout',
  'completed',
];

/** Hold-to-skip threshold, seconds (Spec 24 §3.2). */
export const SKIP_HOLD_THRESHOLD_S = 1.2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Cinematic sequencer for the first-time arrival (Spec 24 §4.2).
 */
export class IntroDirector {
  /** Current phase of the state machine. */
  phase: IntroPhase = 'idle';
  /** Time multiplier applied to `update(dt)` accumulation. */
  timeScale: number;
  /** Total elapsed scaled seconds since `start()` / `jumpToPhase()`. */
  elapsed = 0;
  /** Seconds spent in the current phase (scaled). */
  phaseElapsed = 0;

  private readonly scene: Scene;
  private readonly cameraRig: CameraRig;
  private readonly hud?: unknown;
  private readonly lander: TransportLander;
  private readonly onPhaseChange?: (phase: IntroPhase) => void;
  private readonly onComplete?: () => void;
  private readonly storage?: Storage;

  private running = false;
  private disposed = false;
  /** Skip-hold accumulator (Spec 24 §3.2). */
  private skipHoldSeconds = 0;

  constructor(options: IntroDirectorOptions) {
    this.scene = options.scene;
    this.cameraRig = options.cameraRig;
    this.hud = options.hud;
    this.lander = options.lander;
    this.onPhaseChange = options.onPhaseChange;
    this.onComplete = options.onComplete;
    const ts = Number.isFinite(options.timeScale ?? 1) ? (options.timeScale ?? 1) : 1;
    this.timeScale = Math.max(0, ts);
    this.storage = options.storage;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Starts the arrival sequence from `startPhase` (default `'orbit'`). */
  start(startPhase?: IntroPhase): void {
    if (this.disposed) return;
    const phase = startPhase ?? 'orbit';
    if (!PHASE_ORDER.includes(phase)) {
      throw new Error(`IntroDirector: unknown start phase "${String(phase)}"`);
    }
    this.running = true;
    this.elapsed = 0;
    this.phaseElapsed = 0;
    this.skipHoldSeconds = 0;
    this.setPhase(phase);
  }

  /** Advances the sequence by `dt` scaled seconds (called from render loop). */
  update(dtSeconds: number): void {
    if (this.disposed || !this.running) return;
    const dt = Math.max(0, Number.isFinite(dtSeconds) ? dtSeconds : 0) * this.timeScale;
    this.elapsed += dt;
    this.phaseElapsed += dt;

    // Drive lander effects per phase.
    switch (this.phase) {
      case 'burn':
        this.lander.setThrusterIntensity(1);
        break;
      case 'touchdown':
        // Spool the retro-thrusters down 1 → 0 across the touchdown beat.
        // Gear compression itself fires ONCE on phase entry (setPhase), not per
        // frame — `triggerGearCompression` sinks the footpads by a fixed Δ and
        // would otherwise keep driving them into the regolith every update.
        this.lander.setThrusterIntensity(this.thrusterForTouchdown());
        break;
      case 'ramp':
        this.lander.setRampDeployment(this.rampProgress());
        this.lander.setThrusterIntensity(0);
        break;
      default:
        // orbit / depressurize / ramp / walkout: thrusters off between burns.
        this.lander.setThrusterIntensity(0);
    }

    // Keep the intro camera tracking the lander.
    this.updateCamera(dt);

    // Advance once a phase's duration elapses.
    const dur = PHASE_DURATIONS[this.phase];
    if (dur > 0 && this.phaseElapsed >= dur) {
      this.advanceToNext();
    }
  }

  /** Skips the current phase, advancing to the next beat immediately. */
  skipCurrentPhase(): void {
    if (this.disposed || !this.running) return;
    this.advanceToNext();
  }

  /** Jumps straight to `completed` and fires `onComplete`. */
  skipToFinish(): void {
    if (this.disposed || !this.running) return;
    this.setPhase('completed');
    this.finish();
  }

  /** Jumps directly to a named phase, resetting the timeline. */
  jumpToPhase(phase: IntroPhase): void {
    if (this.disposed) throw new Error('IntroDirector: disposed');
    if (!PHASE_ORDER.includes(phase)) {
      throw new Error(`IntroDirector: unknown phase "${String(phase)}"`);
    }
    this.running = true;
    this.elapsed = 0;
    this.phaseElapsed = 0;
    this.skipHoldSeconds = 0;
    this.setPhase(phase);
  }

  /**
   * Resets the state machine and restores the lander (ramp closed, thrusters
   * off), returning to `idle`. Safe before/after dispose.
   */
  reset(): void {
    if (this.disposed) return;
    this.lander.setRampDeployment(0);
    this.lander.setThrusterIntensity(0);
    this.elapsed = 0;
    this.phaseElapsed = 0;
    this.skipHoldSeconds = 0;
    this.running = false;
    this.setPhase('idle');
  }

  /**
   * Evaluates hold-to-skip input (Spec 24 §3.2): accumulates while holding,
   * returns true once the 1.2 s threshold is crossed, then skips the current
   * phase and resets the accumulator so a continued hold starts timing the next.
   */
  updateSkipInput(isHolding: boolean, dtSeconds: number): boolean {
    if (this.disposed) return false;
    const dt = Math.max(0, Number.isFinite(dtSeconds) ? dtSeconds : 0);
    if (!isHolding) {
      this.skipHoldSeconds = 0;
      return false;
    }
    this.skipHoldSeconds += dt;
    if (this.skipHoldSeconds >= SKIP_HOLD_THRESHOLD_S) {
      this.skipCurrentPhase();
      this.skipHoldSeconds = 0;
      return true;
    }
    return false;
  }

  /** Whether the sequence is actively running. */
  isRunning(): boolean {
    return this.running;
  }

  /** The current phase (readback for HUD / harness). */
  getPhase(): IntroPhase {
    return this.phase;
  }

  /** Current hold-to-skip progress in [0,1] (Spec 24 §3.2 radial fill). */
  getSkipHoldProgress(): number {
    return clamp01(this.skipHoldSeconds / SKIP_HOLD_THRESHOLD_S);
  }

  /** Tears down the director and restores lander effects. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.lander.setRampDeployment(0);
    this.lander.setThrusterIntensity(0);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Retro-thruster spool-down over the touchdown phase (1 → 0). */
  private thrusterForTouchdown(): number {
    const dur = PHASE_DURATIONS.touchdown;
    return clamp01(1 - this.phaseElapsed / dur);
  }

  /** Ramp deployment progress [0,1] across the ramp phase. */
  private rampProgress(): number {
    const dur = PHASE_DURATIONS.ramp;
    return clamp01(this.phaseElapsed / dur);
  }

  /** Advances to the next phase (or completes when at the end). */
  private advanceToNext(): void {
    const idx = PHASE_ORDER.indexOf(this.phase);
    const next =
      idx >= 0 && idx < PHASE_ORDER.length - 1 ? PHASE_ORDER[idx + 1] : 'completed';
    this.setPhase(next);
    if (next === 'completed') this.finish();
  }

  /** Applies a phase: resets the phase clock, switches camera mode. */
  private setPhase(phase: IntroPhase): void {
    this.phase = phase;
    this.phaseElapsed = 0;
    switch (phase) {
      case 'orbit':
        this.cameraRig.setMode('intro_cabin');
        break;
      case 'burn':
        this.cameraRig.setMode('intro_cinematic');
        break;
      case 'touchdown':
        this.cameraRig.setMode('intro_cinematic');
        // One-shot strut shock-compression on touchdown (Spec 24 §2.3): the
        // footpads sink once and rebound on their own timer.
        this.lander.triggerGearCompression();
        break;
      case 'depressurize':
        this.cameraRig.setMode('intro_cabin');
        break;
      case 'ramp':
        this.cameraRig.setMode('intro_cabin');
        break;
      case 'walkout':
        // Hand the camera back to the EVA first-person rig as the player
        // disembarks (Spec 24 §4.3.3 seamless lerp handoff).
        this.cameraRig.setMode('eva_first_person');
        break;
      default:
        break; // idle / completed keep whatever camera is already active
    }
    this.onPhaseChange?.(phase);
  }

  /** Fires the completion callback exactly once per run. */
  private finish(): void {
    if (this.disposed) return;
    this.running = false;
    this.onComplete?.();
  }

  /**
   * Keeps the active intro camera tracking the lander each frame: the interior
   * cabin view anchors on the passenger-seat spawn point; the exterior cinematic
   * tracks the descending hull root. Positions are converted from the Babylon
   * y-up frame to the physics frame (`babylonToWorld`).
   */
  private updateCamera(dt: number): void {
    if (dt <= 0) return;
    const heading = this.lander.getRootNode().rotation.y - Math.PI / 2;
    if (this.phase === 'orbit' || this.phase === 'depressurize') {
      const spawn = this.lander.getCabinSpawnPoint();
      if (!Number.isFinite(spawn.x)) return; // lander disposed
      this.cameraRig.update(babylonToWorld(spawn), heading, dt);
    } else if (this.phase === 'burn' || this.phase === 'touchdown') {
      const root = this.lander.getRootNode().position;
      this.cameraRig.update(babylonToWorld(root), heading, dt);
    }
  }
}

export default IntroDirector;
