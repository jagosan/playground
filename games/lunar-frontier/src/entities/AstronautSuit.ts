/**
 * Lunar Frontier — on-foot EVA suit avatar entity (TASK-PLAY-049a).
 *
 * Visual/state wrapper over the EXISTING traversal physics module: owns one
 * `LunarEvaSuit` (from ../physics/TraversalPhysics.ts) and dresses it in a
 * procedural Babylon.js astronaut. No physics in this file — no gravity, no
 * integration, no duplicated SUIT_* constants. `update(dt, input)` steps the
 * owned suit once and copies the resulting `SuitState` onto the meshes.
 *
 * Meshes (procedural only, no GLB — Spec 28 §2.2 retro-modern slimmer
 * silhouette): tapered torso capsule with chest plate and waist compression
 * band, aerodynamic bubble helmet with panoramic gold-sputtered visor,
 * contour PLSS pack with twin oxygen cryo-cylinders, central radiator cowl
 * and lower thruster nozzles, flush chest telemetry pad, dual arm
 * assemblies (upper arm, forearm, gauntlet + cuff) and slender leg
 * assemblies (thigh, knee armour, calf, boot), hung on shoulder/elbow/hip/
 * knee pivots, plus the helmet SpotLight — 28 meshes in `getMeshes()`.
 *
 * Frame convention matches TraversalPhysics / CameraRig: world metres
 * (x, y lateral, z up) map to Babylon (x, z↑, -y) via the shared
 * `worldToBabylon`, and heading (radians, 0 = +x) maps to Babylon
 * `rotation.y = PI/2 + heading` — the same mapping the camera rig uses, so
 * mesh, camera and physics cannot disagree about up or ahead.
 *
 * Headless-safe: `init()` accepts a Scene, a raw engine (a scene is created
 * around it), or nothing (self-owned NullEngine fallback). `dispose()` is
 * idempotent; after disposal `update()` keeps stepping physics and returns
 * state instead of throwing.
 */
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';

import {
  IDLE_SUIT_INPUT,
  LunarEvaSuit,
  type GroundElevationFn,
  type SuitInput,
  type SuitState,
} from '../physics/TraversalPhysics.ts';
import { worldToBabylon } from '../engine/CameraRig.ts';

/** Helmet eye height above boot soles, metres. */
export const DEFAULT_HEAD_HEIGHT = 1.62;
/**
 * Helmet lamp intensity while lit. Spec 23 §2.4.3 / acceptance gate 4
 * upgraded the EVA searchlight from the Spec 21 2.0 / 70° / 30 m flashlight
 * to a stadium-glass helmet projector: 6.0 intensity, 85° cone, 50 m throw,
 * so on-foot exploration of shadowed crater bottoms keeps crisp contrast.
 */
export const HEADLIGHT_INTENSITY = 6.0;
/** Helmet lamp cone full angle, degrees (Spec 23 §2.4.3). */
export const HEADLIGHT_ANGLE_DEG = 85;
/** Helmet lamp beam range, metres (Spec 23 §2.4.3). */
export const HEADLIGHT_RANGE_M = 50;
/** Fraction of look-pitch the stiff torso copies. */
export const PITCH_LEAN_SCALE = 0.4;

// -- Walking articulation (TASK-PLAY-060, spec §3.6) --------------------------
/** Minimum ground speed that drives the walk cycle (m/s). */
export const WALK_MIN_SPEED = 0.08;
/** Speed above which the cycle quickens to the lope/sprint cadence (m/s). */
export const SPRINT_MIN_SPEED = 2.5;
/** Walk-cycle clock advance per 1/60 s reference frame (rad), walk / sprint. */
export const WALK_CYCLE_RATE = 7.5;
export const SPRINT_CYCLE_RATE = 12;
/** Reference frame time the cycle rates are tuned for (s). */
export const WALK_CYCLE_FRAME_S = 0.016;
/** Peak leg swing amplitude (rad); arms counter-swing at ARM_SWING_SCALE. */
export const LEG_SWING_RAD = 0.42;
/** Torso counter-bob amplitude (m). */
export const TORSO_BOB_M = 0.025;
/** Spec 28 §2.2: fraction of the leg swing the arms carry in natural opposition. */
export const ARM_SWING_SCALE = 0.75;
/** Knee flexion (rad per rad of back-swing) applied during the swing phase. */
export const KNEE_FLEX_WALK = 0.5;
/** Resting elbow flex of a relaxed hanging arm (rad). */
export const ELBOW_REST_RAD = 0.18;

// -- Lunar bounding articulation (Spec 28 §2.3) -------------------------------
/** Landing crouch compression before launch extension (m). */
export const BOUND_CROUCH_M = 0.06;
/** Crouch compress→release animation duration (s). */
export const BOUND_CROUCH_DURATION_S = 0.28;
/** Hips trailing aft during the ballistic flight arc (rad, + = aft). */
export const BOUND_TRAIL_HIP_RAD = 0.45;
/** Knee flexion carried while airborne (rad). */
export const BOUND_TRAIL_KNEE_RAD = 0.9;
/** Arms spread outward from the hull for balance in flight (rad). */
export const BOUND_ARM_SPREAD_RAD = 0.5;
/** Slight shoulder set-forward in flight (rad; applied as -x rotation). */
export const BOUND_SHOULDER_SET_RAD = 0.2;
/** Knee flex held on the single grounded trough frame between bounds (rad). */
export const BOUND_TROUGH_KNEE_RAD = 0.6;

// -- Climbing articulation (Spec 29 Phase 4) ----------------------------------
/**
 * Base shoulder flexion while the magnetic boots are clamped to the rung
 * rail (rad; negative `rotation.x` swings the arm forward/up the ladder
 * face, the same sign convention the walk cycle uses in reverse).
 */
export const CLIMB_SHOULDER_FLEX_RAD = -1.1;
/** Base elbow flexion of a hand gripping a rung (rad). */
export const CLIMB_ELBOW_FLEX_RAD = 0.85;
/** Shoulder reach amplitude of the alternating cycle (rad). */
export const CLIMB_REACH_AMPLITUDE_RAD = 0.22;
/** Elbow straightening the reaching arm carries at full reach (rad). */
export const CLIMB_REACH_ELBOW_RELIEF_RAD = 0.2;
/** Hip lift on the stepping half-cycle (rad; − = forward/up toward rung). */
export const CLIMB_STEP_HIP_RAD = 0.38;
/** Knee flex held with both boots pressed on rungs (mechanical hold). */
export const CLIMB_KNEE_HOLD_RAD = 0.25;
/** Extra knee flex as a boot lifts to the next rung (rad). */
export const CLIMB_STEP_KNEE_RAD = 0.75;
/**
 * Alternating limb-cycle wavelength (m) — two rungs at the Spec 29 §2.3
 * 0.35 m rung pitch: one full sin cycle = one left-arm-high + one
 * right-arm-high stroke.
 */
export const CLIMB_CYCLE_WAVELENGTH_M = 0.7;

/**
 * One frame of the Spec 29 Phase 4 climb grip pose, expressed as the
 * `rotation.x` targets for the six limb pivots (same radian convention as
 * the walk cycle: positive swings a limb aft, negative forward).
 */
export interface ClimbLimbPose {
  shoulderLx: number;
  shoulderRx: number;
  elbowLx: number;
  elbowRx: number;
  hipLx: number;
  hipRx: number;
  kneeLx: number;
  kneeRx: number;
  /** False on the mechanical hold (vz = 0) — frozen, jitter-free grip. */
  moving: boolean;
}

/**
 * Pure climbing articulation law (Spec 29 Phase 4 §3). While the climber
 * moves, the stroke clock rides `climbProgressM` directly (wavelength
 * {@link CLIMB_CYCLE_WAVELENGTH_M} = 2 rungs), so the pose is a deterministic
 * function of height — ascending runs it one way, descending reverses it,
 * and a mid-span mount lands in the matching phase. Left arm reaches high
 * while the right leg steps up, and vice versa; legs never swing aft of the
 * ladder face (the lift is gated at 0). With vz = 0 the pose collapses to
 * the canonical symmetric grip hold — no time term, zero jitter.
 */
export function climbGripPose(climbProgressM: number, climbRateMps: number): ClimbLimbPose {
  if (climbRateMps === 0 || !Number.isFinite(climbRateMps)) {
    return {
      shoulderLx: CLIMB_SHOULDER_FLEX_RAD,
      shoulderRx: CLIMB_SHOULDER_FLEX_RAD,
      elbowLx: CLIMB_ELBOW_FLEX_RAD,
      elbowRx: CLIMB_ELBOW_FLEX_RAD,
      hipLx: 0,
      hipRx: 0,
      kneeLx: CLIMB_KNEE_HOLD_RAD,
      kneeRx: CLIMB_KNEE_HOLD_RAD,
      moving: false,
    };
  }
  const progress = Number.isFinite(climbProgressM) ? climbProgressM : 0;
  const theta = (progress / CLIMB_CYCLE_WAVELENGTH_M) * Math.PI * 2;
  const reach = Math.sin(theta);
  // Left arm high ↔ right leg up (and the mirror): the arm pair runs on
  // ±reach, the leg pair on max(0, ∓reach) so a boot only ever lifts
  // forward toward the next rung, never back into the truss.
  const liftL = Math.max(0, -reach);
  const liftR = Math.max(0, reach);
  return {
    shoulderLx: CLIMB_SHOULDER_FLEX_RAD - CLIMB_REACH_AMPLITUDE_RAD * reach,
    shoulderRx: CLIMB_SHOULDER_FLEX_RAD + CLIMB_REACH_AMPLITUDE_RAD * reach,
    elbowLx: CLIMB_ELBOW_FLEX_RAD - CLIMB_REACH_ELBOW_RELIEF_RAD * reach,
    elbowRx: CLIMB_ELBOW_FLEX_RAD + CLIMB_REACH_ELBOW_RELIEF_RAD * reach,
    hipLx: -CLIMB_STEP_HIP_RAD * liftL,
    hipRx: -CLIMB_STEP_HIP_RAD * liftR,
    kneeLx: CLIMB_KNEE_HOLD_RAD + (CLIMB_STEP_KNEE_RAD - CLIMB_KNEE_HOLD_RAD) * liftL,
    kneeRx: CLIMB_KNEE_HOLD_RAD + (CLIMB_STEP_KNEE_RAD - CLIMB_KNEE_HOLD_RAD) * liftR,
    moving: true,
  };
}

/**
 * Avatar heading (radians, physics frame, 0 = +x) that faces the climber
 * inward toward the ladder rungs — i.e. opposite the ladder's outward
 * {@link LadderBounds.facingNormal}. Applied on mount so the first latched
 * frame already reads "hands on the rungs, face to the truss" for both the
 * avatar mesh and the first-person camera (Spec 29 §3.2.6).
 */
export function climbInwardHeadingRad(facingNormal: { x: number; y: number }): number {
  const nx = facingNormal?.x;
  const ny = facingNormal?.y;
  if (typeof nx !== 'number' || typeof ny !== 'number' || !Number.isFinite(nx) || !Number.isFinite(ny)) {
    return 0;
  }
  if (nx === 0 && ny === 0) return 0;
  return Math.atan2(-ny, -nx);
}

/**
 * Spec 19 §2.3 / ADR-4: the suit backpack hauls at most this many kilograms
 * of ore. The 50 kg ceiling is the logistical argument for deploying the
 * 500 kg-capacity rover — mining on foot caps (or rejects) above it.
 */
export const SUIT_MAX_CARGO_KG = 50;

/**
 * Spec 24 Phase 4 §2.6: fine regolith boot-dust puff budget. A tiny
 * ballistic emitter at the heels kicks up a handful of low-velocity dust motes
 * on each step — pure vacuum physics (no drag, g = −1.62 m/s²), matching
 * the retro-ejecta spec (§4.4) at foot scale.
 */
export const BOOT_DUST_PARTICLE_COUNT = 24;
/** Boot-dust puff gravity, metres per second squared (lunar datum). */
const BOOT_DUST_GRAVITY_Y = -1.62;

export interface EvaSuitAvatarOptions {
  /** Seed for the owned `LunarEvaSuit` (spawn position, reserves…). */
  initial?: Partial<SuitState>;
  /** Surface elevation underfoot, world-frame metres. Default datum 0. */
  groundElevation?: GroundElevationFn;
  /** Lamp lit at spawn (default true). */
  headlight?: boolean;
  /** Node/mesh/material name prefix (default `eva`). */
  namePrefix?: string;
  /** Spec 19 §2.3: backpack load at spawn, kg (clamped to 0..50). */
  initialCargo?: number;
}

/** Consolidated HUD readout, one allocation per call. */
export interface EvaSuitTelemetry {
  oxygen: number;
  battery: number;
  rcsFuel: number;
  /** Horizontal speed over the regolith (m/s). */
  speed: number;
  /** Vertical velocity (m/s, + climbing). */
  climbRate: number;
  /** Heading, radians in the x-y plane (0 = +x). */
  heading: number;
  /** Look pitch, radians (+ up). */
  pitch: number;
  /** Suit-centre elevation, world-frame metres. */
  altitude: number;
  isGrounded: boolean;
  headlightOn: boolean;
  /** False once oxygen or battery bottoms out (suit is dead weight). */
  operational: boolean;
  /** Spec 19 §2.3: ore mass in the backpack, kg (0..SUIT_MAX_CARGO_KG). */
  cargoMass: number;
  /** Spec 19 §2.3: backpack ceiling, kg (SUIT_MAX_CARGO_KG). */
  cargoCapacity: number;
}

/**
 * Body geometry, metres. Local frame: +y up, +z is the helmet facing.
 * Spec 28 §2.2 retro-modern slimmer silhouette — exported so smoke
 * harnesses assert the aesthetic gates (torso r ≤ 0.22, visor d ≥ 0.34,
 * twin cryo-cylinder r 0.08 / h 0.52) against the live build.
 */
export const GEO = {
  torso: { radius: 0.2, height: 0.92, y: 0.84 },
  chestPlate: { y: 1.02, z: 0.185, width: 0.3, height: 0.28, depth: 0.07 },
  waistBand: { y: 0.6, diameter: 0.44, height: 0.09 },
  helmet: { y: 1.56, diameter: 0.38 },
  visor: { y: 1.575, z: 0.075, diameter: 0.36, sx: 0.92, sy: 0.65, sz: 0.95 },
  telemetry: { y: 1.04, z: 0.235, width: 0.16, height: 0.12, depth: 0.03 },
  plss: {
    panel: { y: 1.06, z: -0.26, width: 0.36, height: 0.66, depth: 0.1 },
    tank: { y: 1.08, z: -0.4, dx: 0.115, radius: 0.08, height: 0.52 },
    cowl: { y: 1.08, z: -0.44, width: 0.14, height: 0.46, depth: 0.14 },
    nozzle: { y: 0.8, z: -0.38, dx: 0.09, diameter: 0.09, length: 0.12, tilt: 0.7 },
  },
  arm: {
    shoulderY: 1.22, shoulderDx: 0.235,
    upperRadius: 0.07, upperHeight: 0.32,
    forearmRadius: 0.065, forearmHeight: 0.28,
    cuffDiameter: 0.13, cuffHeight: 0.055,
    glove: { width: 0.1, height: 0.16, depth: 0.085 },
  },
  leg: {
    hipY: 0.66, hipDx: 0.105,
    thighRadius: 0.095, thighHeight: 0.36,
    kneeDiameter: 0.13, kneeWidth: 0.11,
    calfRadius: 0.08, calfHeight: 0.24,
    boot: { width: 0.11, height: 0.1, depth: 0.22 },
  },
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class EvaSuitAvatar {
  /** The single source of truth for suit motion. Never duplicated. */
  readonly suit: LunarEvaSuit;

  private readonly prefix: string;
  private readonly headHeight: number;
  private readonly ground: GroundElevationFn;
  private readonly groundIsDatum: boolean;

  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;

  private root: TransformNode | null = null;
  /** Upper-body pivot (helmet, visor, chest plate, PLSS, arms) — takes the walk bob. */
  private upperBody: TransformNode | null = null;
  private parts: Mesh[] = [];
  private visor: Mesh | null = null;
  private torso: Mesh | null = null;
  /** Hip pivots swing the leg assemblies in counter-phase (Spec 28 §2.2/§2.3). */
  private hipL: TransformNode | null = null;
  private hipR: TransformNode | null = null;
  /** Knee pivots flex the calf+boot during the swing phase. */
  private kneeL: TransformNode | null = null;
  private kneeR: TransformNode | null = null;
  /** Shoulder pivots swing the arms in natural opposition to the legs. */
  private shoulderL: TransformNode | null = null;
  private shoulderR: TransformNode | null = null;
  private elbowL: TransformNode | null = null;
  private elbowR: TransformNode | null = null;
  /** Locomotion walk-cycle clock (radians of phase), advanced in syncTransform. */
  private walkCycleTime = 0;
  /** True while the ballistic bound flight pose is in force (Spec 28 §2.3). */
  private boundingFlight = false;
  /**
   * Landing-crouch animation clock (s). Armed at half its duration on each
   * bounding touchdown — the torso reads FULL compression on the impact
   * frame and eases back out along the half-sine before the next launch.
   */
  private boundCrouchClock = 0;
  private lamp: SpotLight | null = null;
  private materials: PBRMaterial[] = [];

  private lampOn: boolean;
  /**
   * Spec 19 §2.3 / ADR-4: ore mass riding in the backpack, kg, always kept
   * inside `[0, SUIT_MAX_CARGO_KG]`. Inventory bookkeeping only — the suit
   * physics module never consumes it (the buggy's flatbed load does).
   */
  private cargoMass: number;
  /**
   * Spec 21 §2.4 vault loot ("Advanced Prospector EVA Suit"): instance
   * backpack ceiling, at or above {@link SUIT_MAX_CARGO_KG} once upgraded.
   */
  private cargoCapKg = SUIT_MAX_CARGO_KG;
  private built = false;
  private disposed = false;

  /** Spec 24 Phase 4 §2.6 boot-dust emitter (NullEngine-safe fallback node). */
  private bootDust?: ParticleSystem;
  private bootDustFallback?: TransformNode;
  /** Number of boot-dust puffs emitted since init (smoke readback). */
  private bootDustPuffCount = 0;
  /** Most recently stepped state — keeps getters honest across scene life. */
  private last: SuitState;

  constructor(options: EvaSuitAvatarOptions = {}) {
    this.prefix = options.namePrefix ?? 'eva';
    this.headHeight = DEFAULT_HEAD_HEIGHT;
    this.ground = options.groundElevation ?? (() => 0);
    this.groundIsDatum = options.groundElevation === undefined;
    this.suit = new LunarEvaSuit(options.initial ?? {});
    this.last = this.suit.getState();
    this.lampOn = options.headlight ?? true;
    this.cargoMass = clamp(
      Number.isFinite(options.initialCargo) ? (options.initialCargo as number) : 0,
      0,
      SUIT_MAX_CARGO_KG,
    );
  }

  // -- lifecycle ---------------------------------------------------------------

  /**
   * Build the avatar. Accepts an existing `Scene`, a raw engine (a scene is
   * created around it), or nothing — falling back to a self-owned
   * `NullEngine`, exactly what CI wants. Idempotent.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('EvaSuitAvatar: init() after dispose()');
    if (this.built) return this;

    if (sceneOrEngine instanceof Scene) {
      this.scene = sceneOrEngine;
    } else if (sceneOrEngine instanceof NullEngine) {
      // Caller already handed us a bare engine (maybe a shared NullEngine).
      this.scene = new Scene(sceneOrEngine);
    } else if (sceneOrEngine !== null && sceneOrEngine !== undefined) {
      // Foreign engine: wrap, but never dispose what is not ours.
      this.scene = new Scene(sceneOrEngine);
    } else if (typeof window === 'undefined') {
      const engine = new NullEngine({ renderWidth: 1600, renderHeight: 900 });
      this.ownedEngine = engine;
      this.scene = new Scene(engine);
    } else {
      throw new Error('EvaSuitAvatar.init: browser needs a Scene or Engine');
    }

    this.buildAvatar(this.scene);
    this.built = true;
    this.syncTransform(this.last);
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /**
   * Advance one frame: step the owned physics suit, then sync mesh
   * transform, heading and headlamp from the result. Performs no
   * integration of its own. Safe after `dispose()` (physics-only).
   *
   * @param dt    seconds since last frame (physics clamps to ≤ 0.25 s)
   * @param input this frame's suit input (idle if omitted)
   * @returns a copy of the post-step `SuitState`
   */
  update(dt: number, input: SuitInput = IDLE_SUIT_INPUT): SuitState {
    const state = this.suit.step(dt, input, this.ground);
    this.last = state;
    if (this.built && !this.disposed) this.syncTransform(state);
    return { ...state };
  }

  /**
   * Switch the helmet lamp: `setHeadlight(true|false)` forces, a bare call
   * toggles. Returns the state now in force. Safe before `init()`, after
   * `dispose()`, and idempotent.
   */
  setHeadlight(on?: boolean): boolean {
    this.lampOn = on === undefined ? !this.lampOn : on;
    if (this.lamp !== null && !this.disposed) this.applyLamp(this.last);
    return this.lampOn;
  }

  /** Lamp state, independent of scene lifetime. */
  isHeadlightOn(): boolean {
    return this.lampOn;
  }

  /** Tear down avatar nodes, materials and any self-owned engine. Never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;

    EvaSuitAvatar.disposeQuietly(this.lamp);
    this.lamp = null;
    for (const mesh of this.parts) EvaSuitAvatar.disposeQuietly(mesh);
    this.parts = [];
    this.visor = null;
    this.torso = null;
    this.upperBody = null;
    this.hipL = null;
    this.hipR = null;
    this.kneeL = null;
    this.kneeR = null;
    this.shoulderL = null;
    this.shoulderR = null;
    this.elbowL = null;
    this.elbowR = null;
    for (const material of this.materials) EvaSuitAvatar.disposeQuietly(material);
    this.materials = [];
    if (this.bootDust !== undefined) {
      EvaSuitAvatar.disposeQuietly(this.bootDust);
      this.bootDust = undefined;
    }
    if (this.bootDustFallback !== undefined) {
      EvaSuitAvatar.disposeQuietly(this.bootDustFallback);
      this.bootDustFallback = undefined;
    }
    EvaSuitAvatar.disposeQuietly(this.root);
    this.root = null;

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) EvaSuitAvatar.disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- accessors -----------------------------------------------------------------

  /** The owned physics suit — advance it through `update()`, not directly. */
  getPhysics(): LunarEvaSuit {
    return this.suit;
  }

  /** Root transform node of the avatar (null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every avatar mesh (for shadow casters / picking registration). */
  getMeshes(): Mesh[] {
    return [...this.parts];
  }

  /** The helmet SpotLight, or null before init / after dispose. */
  getHeadlight(): SpotLight | null {
    return this.lamp;
  }

  /** Suit centre in the **physics** frame (x, y lateral; z = elevation). */
  getPosition(): { x: number; y: number; z: number } {
    const s = this.last;
    return { x: s.x, y: s.y, z: s.z };
  }

  /** Suit centre in Babylon's y-up frame, via the shared converter. */
  getBabylonPosition(): Vector3 {
    return worldToBabylon(this.last);
  }

  /** Heading, radians in the x-y plane (0 = +x). */
  getHeading(): number {
    return this.last.heading;
  }

  /** Look attitude, radians (+ up). */
  getPitch(): number {
    return this.last.pitch;
  }

  /** Life-support readouts (0–100). */
  getOxygen(): number {
    return this.last.oxygen;
  }

  getBattery(): number {
    return this.last.battery;
  }

  getRcsFuel(): number {
    return this.last.rcsFuel;
  }

  // -- cargo (spec 19 §2.3 / ADR-4) ------------------------------------------------

  /** Backpack ore load (kg, 0..SUIT_MAX_CARGO_KG). */
  getCargoMass(): number {
    return this.cargoMass;
  }

  /** Backpack ceiling, kg (spec 19: 50; 160 with the vault suit upgrade). */
  getCargoCapacity(): number {
    return this.cargoCapKg;
  }

  /**
   * Hard-set the backpack load; clamps into `[0, SUIT_MAX_CARGO_KG]`.
   * Returns the mass now aboard so callers can watch the clamp land.
   */
  setCargoMass(kg: number): number {
    if (!Number.isFinite(kg)) return this.cargoMass;
    this.cargoMass = clamp(kg, 0, this.cargoCapKg);
    return this.cargoMass;
  }

  /** True when `amountKg` more would still fit in the backpack. */
  canAcceptCargo(amountKg: number): boolean {
    if (!Number.isFinite(amountKg) || amountKg <= 0) return false;
    return this.cargoMass + amountKg <= this.cargoCapKg + 1e-9;
  }

  /**
   * Add ore to the backpack, capping at the 50 kg ceiling. Returns the
   * kilograms actually taken up (0 when already full or on bad input) —
   * callers diff `requested − added` to know how much overflowed.
   */
  addCargo(amountKg: number): number {
    if (this.disposed || !Number.isFinite(amountKg) || amountKg <= 0) return 0;
    const before = this.cargoMass;
    this.cargoMass = clamp(before + amountKg, 0, this.cargoCapKg);
    return this.cargoMass - before;
  }

  /**
   * Spec 21 §2.4 vault upgrade: expand the backpack to `capacityKg` and
   * double the rebreather ceiling via the suit physics. Returns the new cap.
   */
  upgradeProspectorSuit(capacityKg = 160): number {
    this.cargoCapKg = Math.max(this.cargoCapKg, capacityKg);
    this.suit.upgradeOxygen(2);
    return this.cargoCapKg;
  }

  /** Rebreather ceiling (suit units; 200 with the vault upgrade). */
  getOxygenCapacity(): number {
    return this.suit.getOxygenCapacity();
  }

  /** Horizontal speed over the regolith, m/s. */
  getSpeed(): number {
    const s = this.last;
    return Math.hypot(s.vx, s.vy);
  }

  /** Full physics state copy. */
  getState(): SuitState {
    return { ...this.last };
  }

  /** Consolidated telemetry for the HUD. */
  getTelemetry(): EvaSuitTelemetry {
    const s = this.last;
    return {
      oxygen: s.oxygen,
      battery: s.battery,
      rcsFuel: s.rcsFuel,
      speed: Math.hypot(s.vx, s.vy),
      climbRate: s.vz,
      heading: s.heading,
      pitch: s.pitch,
      altitude: s.z,
      isGrounded: s.isGrounded,
      headlightOn: this.lampOn,
      operational: s.oxygen > 0 && s.battery > 0,
      cargoMass: this.cargoMass,
      cargoCapacity: this.cargoCapKg,
    };
  }

  /**
   * Hard-set the physics state (respawn / teleport / network correction),
   * then re-place the mesh. Pass-through to `LunarEvaSuit.setState`.
   */
  setState(patch: Partial<SuitState>): void {
    if (this.disposed) return;
    this.suit.setState(patch);
    this.last = this.suit.getState();
    if (this.built) this.syncTransform(this.last);
  }

  /** Respawn onto sampled ground at world (x, y) with zero velocity. */
  teleport(x: number, y: number): void {
    this.setState({
      x,
      y,
      z: this.ground(x, y),
      vx: 0,
      vy: 0,
      vz: 0,
      jumpImpulse: 0,
      isGrounded: true,
    });
  }

  /** The scene the avatar lives in (null before init / after dispose). */
  getScene(): Scene | null {
    return this.scene;
  }

  /**
   * Spec 24 Phase 4 §2.6: kick up a fine regolith boot-dust puff at the
   * suit's current heels (or an explicit world-frame point). NullEngine-safe —
   * with no GPU context we only bump the emitted-puff counter and track a
   * fallback node, so smoke harnesses exercise the trigger without WebGL.
   * Returns the cumulative number of puffs emitted since init (≥ 1 after a
   * successful call).
   */
  triggerBootDustPuff(at?: { x: number; y: number; z: number }): number {
    if (this.disposed) return this.bootDustPuffCount;
    const scene = this.scene;
    if (scene === null || scene.isDisposed) return this.bootDustPuffCount;
    const isNull = scene.getEngine().name === 'NullEngine';
    if (isNull) {
      if (this.bootDustFallback === undefined) {
        this.bootDustFallback = new TransformNode('eva-boot-dust-fallback', scene);
      }
      this.bootDustPuffCount += 1;
      return this.bootDustPuffCount;
    }
    if (this.bootDust === undefined) {
      const ps = new ParticleSystem('eva-boot-dust', BOOT_DUST_PARTICLE_COUNT, scene);
      ps.minEmitPower = 0.4;
      ps.maxEmitPower = 1.3;
      ps.minLifeTime = 0.5;
      ps.maxLifeTime = 1.6;
      ps.minSize = 0.06;
      ps.maxSize = 0.28;
      ps.gravity = new Vector3(0, BOOT_DUST_GRAVITY_Y, 0);
      ps.color1 = new Color4(0.62, 0.58, 0.52, 0.9);
      ps.color2 = new Color4(0.85, 0.8, 0.74, 0.15);
      ps.direction1 = new Vector3(-0.7, 0.5, -0.6);
      ps.direction2 = new Vector3(0.9, 0.95, 0.75);
      this.bootDust = ps;
    }
    const p = at ?? { x: this.last.x, y: this.last.y, z: this.last.z };
    const b = worldToBabylon(p);
    (this.bootDust.emitter as Vector3).set(b.x, b.y + 0.15, b.z);
    try {
      this.bootDust.start();
    } catch {
      /* NullEngine / disposed scene — never propagate a GPU failure. */
    }
    this.bootDustPuffCount += 1;
    return this.bootDustPuffCount;
  }

  /** Cumulative boot-dust puffs emitted since init (smoke readback). */
  getBootDustPuffCount(): number {
    return this.bootDustPuffCount;
  }

  // -- internals --------------------------------------------------------------

  /**
   * Procedural retro-modern astronaut (Spec 28 §2.2): slim tapered torso +
   * chest plate + waist band, bubble helmet + panoramic gold visor, twin-tank
   * contour PLSS, flush telemetry pad, dual arms and slender legs on
   * shoulder/elbow/hip/knee pivots, plus the helmet projector lamp.
   */
  private buildAvatar(scene: Scene): void {
    const p = this.prefix;
    const g = GEO;

    // -- three-tier PBR material system (Spec 28 §2.2) ------------------------
    const fabric = new PBRMaterial(`${p}-fabric-white`, scene);
    fabric.albedoColor = new Color3(0.88, 0.88, 0.86); // high-density composite weave
    fabric.metallic = 0.02;
    fabric.roughness = 0.65;
    fabric.environmentIntensity = 0.05; // vacuum: almost nothing to reflect

    const hardware = new PBRMaterial(`${p}-trim-hardware`, scene);
    hardware.albedoColor = new Color3(0.25, 0.26, 0.28); // matte slate titanium
    hardware.metallic = 0.72;
    hardware.roughness = 0.42;
    hardware.environmentIntensity = 0.05;

    const accent = new PBRMaterial(`${p}-trim-accent`, scene);
    accent.albedoColor = new Color3(0.92, 0.42, 0.12); // mission safety orange
    accent.metallic = 0.35;
    accent.roughness = 0.4;
    accent.environmentIntensity = 0.05;

    const gold = new PBRMaterial(`${p}-visor-gold`, scene);
    // Apollo EVA gold-sputtered sun visor: high-reflectivity mirror metal
    // with a subtle amber interior glow (TASK-PLAY-060 / Spec 28 §2.2).
    gold.albedoColor = new Color3(0.95, 0.78, 0.25);
    gold.metallic = 0.98;
    gold.roughness = 0.08;
    gold.emissiveColor = new Color3(0.12, 0.08, 0.02);
    gold.environmentIntensity = 0.05;

    this.materials = [fabric, hardware, accent, gold];
    this.root = new TransformNode(`${p}-avatar`, scene);
    const upperBody = new TransformNode(`${p}-upper-body`, scene);
    upperBody.parent = this.root;
    this.upperBody = upperBody;

    const meshes: Mesh[] = [];
    const add = (
      mesh: Mesh,
      mat: PBRMaterial,
      parent: TransformNode,
      x: number,
      y: number,
      z: number,
    ): Mesh => {
      mesh.material = mat;
      mesh.position.set(x, y, z);
      mesh.parent = parent;
      mesh.isPickable = true;
      mesh.receiveShadows = false;
      meshes.push(mesh);
      return mesh;
    };

    // -- torso: slender tapered capsule + articulated chest plate + band -----
    const torso = add(
      MeshBuilder.CreateCapsule(
        `${p}-torso`,
        { radius: g.torso.radius, height: g.torso.height },
        scene,
      ),
      fabric,
      this.root,
      0,
      g.torso.y,
      0,
    );
    add(
      MeshBuilder.CreateBox(
        `${p}-chest-plate`,
        { width: g.chestPlate.width, height: g.chestPlate.height, depth: g.chestPlate.depth },
        scene,
      ),
      hardware,
      upperBody,
      0,
      g.chestPlate.y,
      g.chestPlate.z,
    );
    // Low-profile flush telemetry slate integrated onto the breastplate.
    add(
      MeshBuilder.CreateBox(
        `${p}-telemetry-pad`,
        { width: g.telemetry.width, height: g.telemetry.height, depth: g.telemetry.depth },
        scene,
      ),
      accent,
      upperBody,
      0,
      g.telemetry.y,
      g.telemetry.z,
    );
    // Waist compression band (trim ring around the hips).
    add(
      MeshBuilder.CreateCylinder(
        `${p}-waist-band`,
        { diameter: g.waistBand.diameter, height: g.waistBand.height },
        scene,
      ),
      hardware,
      this.root,
      0,
      g.waistBand.y,
      0,
    );

    // -- helmet & panoramic gold visor ----------------------------------------
    add(
      MeshBuilder.CreateSphere(
        `${p}-helmet`,
        { diameter: g.helmet.diameter, segments: 20 },
        scene,
      ),
      fabric,
      upperBody,
      0,
      g.helmet.y,
      0,
    );
    const visor = add(
      MeshBuilder.CreateSphere(
        `${p}-visor`,
        { diameter: g.visor.diameter, segments: 20 },
        scene,
      ),
      gold,
      upperBody,
      0,
      g.visor.y,
      g.visor.z,
    );
    visor.scaling.set(g.visor.sx, g.visor.sy, g.visor.sz);
    this.visor = visor;

    // -- PLSS: contour pack, twin cryo-cylinders, cowl, nozzles --------------
    add(
      MeshBuilder.CreateBox(
        `${p}-plss-panel`,
        { width: g.plss.panel.width, height: g.plss.panel.height, depth: g.plss.panel.depth },
        scene,
      ),
      fabric,
      upperBody,
      0,
      g.plss.panel.y,
      g.plss.panel.z,
    );
    const tank = g.plss.tank;
    add(
      MeshBuilder.CreateCylinder(
        `${p}-plss-tank-l`,
        { diameter: tank.radius * 2, height: tank.height, tessellation: 16 },
        scene,
      ),
      hardware,
      upperBody,
      -tank.dx,
      tank.y,
      tank.z,
    );
    add(
      MeshBuilder.CreateCylinder(
        `${p}-plss-tank-r`,
        { diameter: tank.radius * 2, height: tank.height, tessellation: 16 },
        scene,
      ),
      hardware,
      upperBody,
      tank.dx,
      tank.y,
      tank.z,
    );
    add(
      MeshBuilder.CreateBox(
        `${p}-plss-radiator-cowl`,
        { width: g.plss.cowl.width, height: g.plss.cowl.height, depth: g.plss.cowl.depth },
        scene,
      ),
      hardware,
      upperBody,
      0,
      g.plss.cowl.y,
      g.plss.cowl.z,
    );
    const noz = g.plss.nozzle;
    const nozzleL = add(
      MeshBuilder.CreateCylinder(
        `${p}-plss-nozzle-l`,
        { diameter: noz.diameter, height: noz.length, tessellation: 12 },
        scene,
      ),
      hardware,
      upperBody,
      -noz.dx,
      noz.y,
      noz.z,
    );
    nozzleL.rotation.x = noz.tilt; // canted down-and-aft
    const nozzleR = add(
      MeshBuilder.CreateCylinder(
        `${p}-plss-nozzle-r`,
        { diameter: noz.diameter, height: noz.length, tessellation: 12 },
        scene,
      ),
      hardware,
      upperBody,
      noz.dx,
      noz.y,
      noz.z,
    );
    nozzleR.rotation.x = noz.tilt;

    // -- arms: shoulder → upper arm → elbow → forearm + cuff + gauntlet ------
    const buildArm = (side: 'l' | 'r'): {
      shoulder: TransformNode;
      elbow: TransformNode;
    } => {
      const sign = side === 'l' ? -1 : 1;
      const shoulder = new TransformNode(`${p}-shoulder-${side}`, scene);
      shoulder.parent = upperBody;
      shoulder.position.set(sign * g.arm.shoulderDx, g.arm.shoulderY, 0);
      add(
        MeshBuilder.CreateCapsule(
          `${p}-arm-upper-${side}`,
          { radius: g.arm.upperRadius, height: g.arm.upperHeight },
          scene,
        ),
        fabric,
        shoulder,
        0,
        -g.arm.upperHeight / 2,
        0,
      );
      const elbow = new TransformNode(`${p}-elbow-${side}`, scene);
      elbow.parent = shoulder;
      elbow.position.set(0, -g.arm.upperHeight, 0);
      elbow.rotation.x = ELBOW_REST_RAD; // relaxed hang, never locked straight
      add(
        MeshBuilder.CreateCapsule(
          `${p}-arm-forearm-${side}`,
          { radius: g.arm.forearmRadius, height: g.arm.forearmHeight },
          scene,
        ),
        fabric,
        elbow,
        0,
        -g.arm.forearmHeight / 2,
        0,
      );
      add(
        MeshBuilder.CreateCylinder(
          `${p}-arm-cuff-${side}`,
          { diameter: g.arm.cuffDiameter, height: g.arm.cuffHeight },
          scene,
        ),
        accent,
        elbow,
        0,
        -(g.arm.forearmHeight - g.arm.cuffHeight / 2 - 0.005),
        0,
      );
      add(
        MeshBuilder.CreateBox(
          `${p}-arm-glove-${side}`,
          { width: g.arm.glove.width, height: g.arm.glove.height, depth: g.arm.glove.depth },
          scene,
        ),
        fabric,
        elbow,
        0,
        -(g.arm.forearmHeight + g.arm.glove.height / 2 - g.arm.cuffHeight),
        0.005,
      );
      return { shoulder, elbow };
    };
    const armL = buildArm('l');
    const armR = buildArm('r');
    this.shoulderL = armL.shoulder;
    this.elbowL = armL.elbow;
    this.shoulderR = armR.shoulder;
    this.elbowR = armR.elbow;

    // -- legs: hip → thigh + knee armour → knee pivot → calf + boot ----------
    const buildLeg = (side: 'l' | 'r'): {
      hip: TransformNode;
      knee: TransformNode;
    } => {
      const sign = side === 'l' ? -1 : 1;
      const hip = new TransformNode(`${p}-hip-${side}`, scene);
      hip.parent = this.root;
      hip.position.set(sign * g.leg.hipDx, g.leg.hipY, 0);
      add(
        MeshBuilder.CreateCapsule(
          `${p}-leg-thigh-${side}`,
          { radius: g.leg.thighRadius, height: g.leg.thighHeight },
          scene,
        ),
        fabric,
        hip,
        0,
        -g.leg.thighHeight / 2,
        0,
      );
      // Armoured knee articulator (x-axis drum), carried with the thigh.
      const kneeCap = add(
        MeshBuilder.CreateCylinder(
          `${p}-leg-knee-${side}`,
          { diameter: g.leg.kneeDiameter, height: g.leg.kneeWidth },
          scene,
        ),
        hardware,
        hip,
        0,
        -g.leg.thighHeight,
        0,
      );
      kneeCap.rotation.z = Math.PI / 2; // drum axis across the body
      const knee = new TransformNode(`${p}-kneejoint-${side}`, scene);
      knee.parent = hip;
      knee.position.set(0, -g.leg.thighHeight, 0);
      add(
        MeshBuilder.CreateCapsule(
          `${p}-leg-calf-${side}`,
          { radius: g.leg.calfRadius, height: g.leg.calfHeight },
          scene,
        ),
        fabric,
        knee,
        0,
        -g.leg.calfHeight / 2,
        0,
      );
      // Treaded lunar boot (0.11 m across, 0.22 m long), toe forward.
      add(
        MeshBuilder.CreateBox(
          `${p}-leg-boot-${side}`,
          { width: g.leg.boot.width, height: g.leg.boot.height, depth: g.leg.boot.depth },
          scene,
        ),
        hardware,
        knee,
        0,
        -(g.leg.calfHeight + g.leg.boot.height / 2 - g.leg.calfRadius),
        0.02,
      );
      return { hip, knee };
    };
    const legL = buildLeg('l');
    const legR = buildLeg('r');
    this.hipL = legL.hip;
    this.kneeL = legL.knee;
    this.hipR = legR.hip;
    this.kneeR = legR.knee;

    this.torso = torso;
    this.parts = meshes;

    // Headlamp: parented for bookkeeping, but its world position and
    // direction are also written every frame in applyLamp(), so the beam is
    // truthful even under NullEngine (no render loop propagating parents).
    const lamp = new SpotLight(
      `${p}-headlamp`,
      new Vector3(0, DEFAULT_HEAD_HEIGHT, 0),
      new Vector3(0, 0, 1),
      (HEADLIGHT_ANGLE_DEG * Math.PI) / 180,
      2,
      scene,
    );
    lamp.range = HEADLIGHT_RANGE_M;
    lamp.diffuse = new Color3(1, 0.97, 0.9);
    lamp.parent = this.root;
    this.lamp = lamp;
  }

  /** Copy physics state onto the avatar transform + headlamp. */
  private syncTransform(state: SuitState): void {
    const root = this.root;
    if (root === null || this.scene === null || this.scene.isDisposed) return;

    // Physics frame (x, y lateral, z up) → Babylon (x, z up, -y) via the
    // shared converter; the mesh root sits at boot soles, physics centre at
    // hip height, so drop the root by nothing extra — centre rides at GEO.
    const b = worldToBabylon(state);
    root.position.set(b.x, b.y, b.z);

    // Heading is an x-y-plane yaw (0 = +x). A suit facing physics-forward
    // has Babylon azimuth PI/2 + heading (same mapping CameraRig uses). The
    // look pitch leans the torso a fraction inside that yawed frame.
    root.rotation.set(PITCH_LEAN_SCALE * state.pitch, Math.PI / 2 + state.heading, 0);

    this.applyWalkCycle(state);
    this.applyLamp(state);

    // Force a matrix rebuild so headless consumers read a truthful
    // globalPosition without an intervening render().
    root.computeWorldMatrix(true);
  }

  /**
   * Procedural walking articulation (TASK-PLAY-060; Spec 28 §2.2/§2.3):
   * counter-phase hip swing with knee flex on the recovery half-cycle, arms
   * swinging in natural opposition to the legs (elbows tracking the forward
   * sweep), and a torso/upper-body counter-bob at twice the leg frequency.
   * While the physics gait is `bounding`, the pose instead rides the
   * ballistic arc (Spec 28 §2.3): trailing legs in knee flexion and arms
   * spread outward for balance through flight, a knee-flexed trough pose on
   * the single grounded frame, each touchdown kicking a regolith boot-dust
   * puff and arming the -0.06 m landing crouch. Visual only — physics stays
   * in `LunarEvaSuit`. Stopped the pose snaps back to neutral standing.
   */
  private applyWalkCycle(state: SuitState): void {
    const torso = this.torso;
    const upper = this.upperBody;
    const hipL = this.hipL;
    const hipR = this.hipR;
    if (torso === null || upper === null || hipL === null || hipR === null) return;
    const kneeL = this.kneeL;
    const kneeR = this.kneeR;
    const shoulderL = this.shoulderL;
    const shoulderR = this.shoulderR;
    const elbowL = this.elbowL;
    const elbowR = this.elbowR;

    // Landing-crouch envelope (compress→release), advanced once per frame.
    const crouch = this.advanceBoundCrouch();
    const gait = state.gaitMode ?? 'walk';

    // Spec 29 Phase 4: the rung rail owns the frame while the boots are
    // clamped — alternating arm/leg stroke clocked by climbProgressM, or a
    // frozen mechanical-hold grip when vz = 0. The stride clock parks.
    if (state.locomotionMode === 'CLIMBING') {
      this.walkCycleTime = 0;
      this.boundingFlight = false;
      const pose = climbGripPose(state.climbProgressM ?? 0, state.vz);
      hipL.rotation.x = pose.hipLx;
      hipR.rotation.x = pose.hipRx;
      if (kneeL !== null) kneeL.rotation.x = pose.kneeLx;
      if (kneeR !== null) kneeR.rotation.x = pose.kneeRx;
      if (shoulderL !== null) {
        shoulderL.rotation.x = pose.shoulderLx;
        shoulderL.rotation.z = 0;
      }
      if (shoulderR !== null) {
        shoulderR.rotation.x = pose.shoulderRx;
        shoulderR.rotation.z = 0;
      }
      if (elbowL !== null) elbowL.rotation.x = pose.elbowLx;
      if (elbowR !== null) elbowR.rotation.x = pose.elbowRx;
      // Torso rides level on the rail — no stride bob while hanging.
      torso.position.y = GEO.torso.y;
      upper.position.y = 0;
      return;
    }

    if (gait === 'bounding') {
      // Spec 28 §2.3 ballistic looping — the stride clock parks while the
      // arc owns the frame.
      this.walkCycleTime = 0;
      if (!state.isGrounded) {
        this.boundingFlight = true;
        // Trailing legs in slight knee flexion ...
        hipL.rotation.x = BOUND_TRAIL_HIP_RAD;
        hipR.rotation.x = BOUND_TRAIL_HIP_RAD;
        if (kneeL !== null) kneeL.rotation.x = BOUND_TRAIL_KNEE_RAD;
        if (kneeR !== null) kneeR.rotation.x = BOUND_TRAIL_KNEE_RAD;
        // ... arms spread outward for balance, set slightly forward, curled.
        if (shoulderL !== null) {
          shoulderL.rotation.x = -BOUND_SHOULDER_SET_RAD;
          shoulderL.rotation.z = -BOUND_ARM_SPREAD_RAD; // left arm opens -x
        }
        if (shoulderR !== null) {
          shoulderR.rotation.x = -BOUND_SHOULDER_SET_RAD;
          shoulderR.rotation.z = BOUND_ARM_SPREAD_RAD; // right arm opens +x
        }
        if (elbowL !== null) elbowL.rotation.x = ELBOW_REST_RAD + 0.35;
        if (elbowR !== null) elbowR.rotation.x = ELBOW_REST_RAD + 0.35;
      } else {
        // The single grounded trough frame between bounds.
        if (this.boundingFlight) {
          // Touchdown edge: kick regolith dust, arm the compression crouch.
          this.boundingFlight = false;
          this.boundCrouchClock = BOUND_CROUCH_DURATION_S / 2;
          this.triggerBootDustPuff();
        }
        hipL.rotation.x = 0;
        hipR.rotation.x = 0;
        if (kneeL !== null) kneeL.rotation.x = BOUND_TROUGH_KNEE_RAD;
        if (kneeR !== null) kneeR.rotation.x = BOUND_TROUGH_KNEE_RAD;
        if (shoulderL !== null) {
          shoulderL.rotation.x = 0.1;
          shoulderL.rotation.z = -BOUND_ARM_SPREAD_RAD * 0.5;
        }
        if (shoulderR !== null) {
          shoulderR.rotation.x = 0.1;
          shoulderR.rotation.z = BOUND_ARM_SPREAD_RAD * 0.5;
        }
        if (elbowL !== null) elbowL.rotation.x = ELBOW_REST_RAD + 0.5;
        if (elbowR !== null) elbowR.rotation.x = ELBOW_REST_RAD + 0.5;
      }
      torso.position.y = GEO.torso.y + crouch;
      upper.position.y = crouch;
      return;
    }

    this.boundingFlight = false;
    const speed = Math.hypot(state.vx, state.vy);
    if (speed > WALK_MIN_SPEED && state.isGrounded) {
      // Sprint cadence above SPRINT_MIN_SPEED, brisk lunar walk below.
      const rate = speed > SPRINT_MIN_SPEED ? SPRINT_CYCLE_RATE : WALK_CYCLE_RATE;
      this.walkCycleTime += rate * WALK_CYCLE_FRAME_S;
      const swing = Math.sin(this.walkCycleTime) * LEG_SWING_RAD;
      // Positive rotation.x drives a limb aft: hips counter-swing in phase.
      hipL.rotation.x = swing;
      hipR.rotation.x = -swing;
      // Knees flex on the recovery (forward-thigh) half-cycle only — a leg
      // thrusting aft stays straight for toe-off.
      if (kneeL !== null) kneeL.rotation.x = Math.max(0, -swing) * KNEE_FLEX_WALK;
      if (kneeR !== null) kneeR.rotation.x = Math.max(0, swing) * KNEE_FLEX_WALK;
      // Arms swing in natural opposition to the legs on the same clock.
      const armSwing = swing * ARM_SWING_SCALE;
      if (shoulderL !== null) {
        shoulderL.rotation.x = -armSwing;
        shoulderL.rotation.z = 0;
      }
      if (shoulderR !== null) {
        shoulderR.rotation.x = armSwing;
        shoulderR.rotation.z = 0;
      }
      // Elbows add a touch of flex as their arm comes forward.
      if (elbowL !== null) elbowL.rotation.x = ELBOW_REST_RAD + Math.max(0, armSwing) * 0.3;
      if (elbowR !== null) elbowR.rotation.x = ELBOW_REST_RAD + Math.max(0, -armSwing) * 0.3;
      // Torso + upper-body counter-bob at twice the leg frequency (heel-strike).
      const bob = Math.abs(Math.sin(this.walkCycleTime * 2)) * TORSO_BOB_M;
      torso.position.y = GEO.torso.y + bob + crouch;
      upper.position.y = bob + crouch;
    } else {
      // Stopped or airborne: neutral standing pose, clock parked for next start.
      this.walkCycleTime = 0;
      hipL.rotation.x = 0;
      hipR.rotation.x = 0;
      if (kneeL !== null) kneeL.rotation.x = 0;
      if (kneeR !== null) kneeR.rotation.x = 0;
      if (shoulderL !== null) {
        shoulderL.rotation.x = 0;
        shoulderL.rotation.z = 0;
      }
      if (shoulderR !== null) {
        shoulderR.rotation.x = 0;
        shoulderR.rotation.z = 0;
      }
      if (elbowL !== null) elbowL.rotation.x = ELBOW_REST_RAD;
      if (elbowR !== null) elbowR.rotation.x = ELBOW_REST_RAD;
      torso.position.y = GEO.torso.y + crouch;
      upper.position.y = crouch;
    }
  }

  /**
   * Advance the landing-crouch envelope one frame and return this frame's
   * vertical torso offset (m). Armed by a bounding touchdown at half its
   * duration — the half-sine reads full -{@link BOUND_CROUCH_M} compression
   * immediately and releases smoothly to zero before the next launch
   * extension (Spec 28 §2.3).
   */
  private advanceBoundCrouch(): number {
    if (this.boundCrouchClock <= 0) return 0;
    this.boundCrouchClock += WALK_CYCLE_FRAME_S;
    if (this.boundCrouchClock >= BOUND_CROUCH_DURATION_S) {
      this.boundCrouchClock = 0;
      return 0;
    }
    const phase = this.boundCrouchClock / BOUND_CROUCH_DURATION_S;
    return -BOUND_CROUCH_M * Math.sin(Math.PI * phase);
  }

  /** Push lamp on/off and battery fade into the SpotLight. */
  private applyLamp(state: SuitState): void {
    const lamp = this.lamp;
    if (lamp === null || lamp.getScene().isDisposed) return;
    const eye = worldToBabylon({
      x: state.x,
      y: state.y,
      z: state.z + this.headHeight,
    });
    lamp.position.copyFrom(eye);
    // Physics-forward (cos h, sin h, 0) + look pitch → Babylon (cos p cos h, sin p, -cos p sin h).
    const pitch = state.pitch ?? 0;
    lamp.direction.set(
      Math.cos(pitch) * Math.cos(state.heading),
      Math.sin(pitch),
      -Math.cos(pitch) * Math.sin(state.heading),
    );
    const alive = state.oxygen > 0 && state.battery > 0 ? 1 : 0.15;
    lamp.intensity = this.lampOn ? HEADLIGHT_INTENSITY * alive : 0;
  }

  private static disposeQuietly(target: { dispose: () => unknown } | null): void {
    if (target === null) return;
    try {
      target.dispose();
    } catch {
      // Node already gone or engine torn down first — never propagate.
    }
  }
}

export default EvaSuitAvatar;
