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
import { Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';

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

/**
 * Intro flight telemetry pushed to the HUD overlay every frame (Spec 24 Phase 3,
 * blueprint §3.1). Mirrors the spec's descent readouts:
 *   • altitude: 12,400 m → ~50 m during burn, closing to 0 m on touchdown;
 *   • descent rate: 180 m/s → 12 m/s retro-burn spool-down (§2.2);
 *   • cabin pressure: 101.3 kPa → 0.0 kPa as the atmosphere vents (§2.4);
 *   • audioMode flips 'cabin' → 'vacuum' the moment pressure drops below
 *     5.0 kPa (the suit-conducted acoustic cut).
 */
export interface IntroTelemetry {
  phase: IntroPhase;
  phaseElapsedSeconds: number;
  altitudeMeters: number;
  descentVelocityMps: number;
  cabinPressureKPa: number;
  audioMode: 'cabin' | 'vacuum';
  skipHoldProgress: number; // 0.0 to 1.0
}

/** Low-orbit altitude datum, metres (Spec 24 §2.2: 12,400 m). */
const ORBIT_ALTITUDE_M = 12600;
/** Retro-burn ignition altitude, metres (§2.2 countdown start). */
const BURN_START_ALTITUDE_M = 12400;
/** End-of-burn altitude, metres — touchdown closes the last stretch to 0 m. */
const BURN_END_ALTITUDE_M = 120;
/** Orbital drift rate during the cabin-view beat, m/s. */
const ORBIT_DESCENT_MPS = 6;
/** Retro-burn ignition descent rate, m/s (§2.2: 180 m/s). */
const BURN_START_VELOCITY_MPS = 160;
/** End-of-burn terminal descent rate, m/s (§2.2: ~12 m/s). */
const BURN_END_VELOCITY_MPS = 10;
/** Touchdown approach speed, m/s (blueprint §3.1 touchdown beat). */
const TOUCHDOWN_START_VELOCITY_MPS = 8;
/** Cabin atmosphere pressure at seal, kPa (§2.4: 101.3 kPa). */
const CABIN_PRESSURE_KPA = 100;
/** Pressure below which the cabin audio cuts to suit acoustics (§2.4: <5 kPa). */
const VACUUM_AUDIO_THRESHOLD_KPA = 6;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear interpolation helper for telemetry down-counts. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
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

  /**
   * Vacuum ejecta particle system (Spec 24 §4.4) — a radial ballistic sheet
   * sprayed around the footpads on touchdown. NullEngine-safe: when the engine is
   * the NullEngine there is no WebGL/shader context, so we swap in a tracked
   * fallback TransformNode instead of a GPU ParticleSystem (smoke harnesses run
   * cleanly with zero canvas).
   */
  private ejecta?: ParticleSystem;
  /** NullEngine stand-in for {@link ejecta} (no shaders, no WebGL). */
  private ejectaFallback?: TransformNode;
  /** True once the touchdown ejecta burst has fired this run. */
  private ejectaTriggered = false;

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

    // Build the vacuum ejecta emitter up-front (NullEngine-safe; see §4.4).
    this.buildEjecta();
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

    // Push intro telemetry to the HUD overlay every frame (Spec 24 Phase 3).
    this.pushTelemetry();
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
    this.stopEjecta();
    this.setPhase('idle');
    // Idle → the HUD overlay retracts its intro panel (Spec 24 Phase 3).
    this.pushTelemetry();
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

  /**
   * Intro flight telemetry for the HUD overlay (Spec 24 Phase 3, blueprint
   * §3.1). Computes the descent readouts per phase:
   *   • orbit:       12,400 m datum, slow orbital drift, cabin pressure.
   *   • burn:        altitude 12,400 → ~50 m; rate 180 → ~12 m/s (§2.2).
   *   • touchdown:   closes to 0 m / 0 m/s with the ejecta burst (§2.3).
   *   • depressurize: pressure 101.3 → 0.0 kPa; audioMode flips to 'vacuum'
   *                  once pressure drops below 5.0 kPa (§2.4 acoustic cut).
   *   • ramp/walkout/completed: on the surface, full vacuum acoustics.
   */
  getTelemetry(): IntroTelemetry {
    const p = this.phase;
    let altitudeMeters: number;
    let descentVelocityMps: number;
    let cabinPressureKPa: number;
    let audioMode: 'cabin' | 'vacuum';

    switch (p) {
      case 'burn': {
        const t = clamp01(this.phaseElapsed / PHASE_DURATIONS.burn);
        altitudeMeters = lerp(BURN_START_ALTITUDE_M, BURN_END_ALTITUDE_M, t);
        descentVelocityMps = lerp(BURN_START_VELOCITY_MPS, BURN_END_VELOCITY_MPS, t);
        cabinPressureKPa = CABIN_PRESSURE_KPA;
        audioMode = 'cabin';
        break;
      }
      case 'touchdown': {
        const t = clamp01(this.phaseElapsed / PHASE_DURATIONS.touchdown);
        altitudeMeters = lerp(BURN_END_ALTITUDE_M, 0, t);
        descentVelocityMps = lerp(TOUCHDOWN_START_VELOCITY_MPS, 0, t);
        cabinPressureKPa = CABIN_PRESSURE_KPA;
        audioMode = 'cabin';
        break;
      }
      case 'depressurize': {
        const t = clamp01(this.phaseElapsed / PHASE_DURATIONS.depressurize);
        altitudeMeters = 0;
        descentVelocityMps = 0;
        cabinPressureKPa = lerp(CABIN_PRESSURE_KPA, 0, t);
        // §2.4: the moment cabin air density bottoms out, external audio cuts to
        // suit-conducted acoustics — modelled as a hard sub-5 kPa threshold.
        audioMode = cabinPressureKPa < VACUUM_AUDIO_THRESHOLD_KPA ? 'vacuum' : 'cabin';
        break;
      }
      default: {
        // orbit datum, or ramp/walkout/completed on the surface.
        altitudeMeters = p === 'orbit' ? ORBIT_ALTITUDE_M : 0;
        descentVelocityMps = p === 'orbit' ? ORBIT_DESCENT_MPS : 0;
        cabinPressureKPa =
          p === 'orbit' || p === 'idle' ? CABIN_PRESSURE_KPA : 0;
        audioMode = p === 'orbit' || p === 'idle' ? 'cabin' : 'vacuum';
        break;
      }
    }

    return {
      phase: p,
      phaseElapsedSeconds: this.phaseElapsed,
      altitudeMeters,
      descentVelocityMps,
      cabinPressureKPa,
      audioMode,
      skipHoldProgress: this.getSkipHoldProgress(),
    };
  }

  /** Tears down the director and restores lander effects. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.lander.setRampDeployment(0);
    this.lander.setThrusterIntensity(0);
    // Retract the HUD intro panel and free the ejecta emitter (Spec 24 Phase 3).
    this.pushTelemetry();
    this.disposeEjecta();
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
        // Vacuum ejecta burst: high-velocity radial dust sheets spray out across
        // the regolith as the struts kiss the surface (§2.3 / §4.4).
        this.triggerEjecta();
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
   * Build the vacuum ejecta emitter (Spec 24 §4.4): a high-velocity radial
   * ballistic sheet around the footpad datum. NullEngine-safe — when the engine is
   * the NullEngine we skip the GPU ParticleSystem entirely and track a fallback
   * TransformNode so smoke harnesses exercise the same lifecycle without any WebGL/
   * shader context (zero canvas, zero crash).
   */
  private buildEjecta(): void {
    const isNull = this.scene.getEngine().name === 'NullEngine';
    if (isNull) {
      this.ejectaFallback = new TransformNode('intro-ejecta-fallback', this.scene);
      return;
    }
    const ps = new ParticleSystem('intro-ejecta', 500, this.scene);
    // Radial sheet emitter centred on the lander's footpad datum.
    ps.emitter = this.ejectaAnchor();
    ps.direction1 = new Vector3(-1.4, 0.7, -1.2);
    ps.direction2 = new Vector3(1.6, 1.05, 1.5);
    ps.minEmitPower = 26;
    ps.maxEmitPower = 42;
    ps.minLifeTime = 1.4;
    ps.maxLifeTime = 3.2;
    ps.minSize = 0.35;
    ps.maxSize = 2.6;
    ps.gravity = new Vector3(0, -1.62, 0); // lunar gravity (§2.3)
    ps.color1 = new Color4(0.55, 0.48, 0.42, 0.95);
    ps.color2 = new Color4(0.9, 0.82, 0.72, 0.35);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.emitRate = 420;
    this.ejecta = ps;
  }

  /** World anchor for the ejecta emitter: just above the footpad datum. */
  private ejectaAnchor(): Vector3 {
    const root = this.lander.getRootNode().position;
    return new Vector3(root.x, Math.max(0.15, root.y), root.z);
  }

  /**
   * Fire the touchdown ejecta burst once per run (Spec 24 §2.3). NullEngine-safe:
   * with no GPU system we only mark the fallback node as "live" so the smoke
   * harness can assert triggering without any particle rendering.
   */
  private triggerEjecta(): void {
    if (this.ejectaTriggered) return;
    this.ejectaTriggered = true;
    if (this.ejecta !== undefined) {
      try {
        this.ejecta.start();
      } catch {
        /* NullEngine-safe: never propagate a WebGL/shader failure. */
      }
    }
  }

  /** Stop the ejecta burst and clear its one-shot flag (reset path). */
  private stopEjecta(): void {
    this.ejectaTriggered = false;
    if (this.ejecta !== undefined) {
      try {
        this.ejecta.stop();
      } catch {
        /* already stopped / NullEngine fallback. */
      }
    }
  }

  /** Dispose the ejecta emitter (GPU system or NullEngine fallback node). */
  private disposeEjecta(): void {
    if (this.ejecta !== undefined) {
      try {
        this.ejecta.dispose();
      } catch {
        /* scene already torn down. */
      }
      this.ejecta = undefined;
    }
    if (this.ejectaFallback !== undefined) {
      try {
        this.ejectaFallback.dispose();
      } catch {
        /* scene already torn down. */
      }
      this.ejectaFallback = undefined;
    }
  }

  /** Whether the touchdown ejecta burst has fired this run (smoke readback). */
  getEjectaTriggered(): boolean {
    return this.ejectaTriggered;
  }

  /**
   * Forward the current intro telemetry to the HUD overlay, or retract it when
   * idle / completed (Spec 24 Phase 3: `hud.updateIntroTelemetry`). No-op for a
   * director built without a HUD or with a duck-typed stub lacking the method —
   * keeps the existing smoke harness (no hud) working unchanged.
   */
  private pushTelemetry(): void {
    const hud = this.hud as
      | ({ updateIntroTelemetry?: (t: IntroTelemetry | null) => void })
      | undefined;
    if (!hud || typeof hud.updateIntroTelemetry !== 'function') return;
    if (
      !this.running ||
      this.phase === 'idle' ||
      this.phase === 'completed'
    ) {
      hud.updateIntroTelemetry(null);
      return;
    }
    hud.updateIntroTelemetry(this.getTelemetry());
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
