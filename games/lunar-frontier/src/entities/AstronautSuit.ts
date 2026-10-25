/**
 * Lunar Frontier — on-foot EVA suit avatar entity (TASK-PLAY-049a).
 *
 * Visual/state wrapper over the EXISTING traversal physics module: owns one
 * `LunarEvaSuit` (from ../physics/TraversalPhysics.ts) and dresses it in a
 * procedural Babylon.js astronaut. No physics in this file — no gravity, no
 * integration, no duplicated SUIT_* constants. `update(dt, input)` steps the
 * owned suit once and copies the resulting `SuitState` onto the meshes.
 *
 * Meshes (procedural only, no GLB — Spec 30 §2.1 Stormtrooper stylized
 * composite armor carapace): muscular gasket undersuit core under a flared
 * pectoral chestplate with chiseled facets and trapezoidal sternum relief, a
 * 4-tier segmented abdominal rib cuirass, tactical utility belt with buckle,
 * codpiece and twin flank O2 canisters, an integrated PLSS backpack contouring
 * into the back yoke with twin cryo-cylinders, radiator cowl and downward
 * vector nozzles, a spherical helmet with raked brow rim, twin chin aerator
 * pods and vocoder grille over the panoramic gold visor, flared pauldron
 * shoulder bells on a 0.52 m shoulder stance, bicep cuffs, vambraces, heavy
 * magnetic gauntlet cuffs and articulated gloves, thigh cuirasses with
 * angular knee cops and strike plates, sculpted shin greaves and chunky
 * treaded magnetic boots with widened soles and aft heel spurs — 56
 * meshes in `getMeshes()`, bound to the four-material Spec 30 two-tone PBR
 * palette.
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
  type HurryStrideLeg,
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
/** Knee flex held on the single grounded trough frame between bounds (rad).
 *  @deprecated Superseded by Spec 30 §2.2.3 {@link HURRY_BRACE_STANCE_KNEE_RAD}
 *  — the brace window is now leg-specific; kept only for legacy readers. */
export const BOUND_TROUGH_KNEE_RAD = 0.6;

// -- Unilateral Steelpush stride articulation (Spec 30 §2.2.3 / Phase 4) ------
/*
 * All mesh-frame constants below follow the avatar pivot convention
 * (positive `rotation.x` swings a hanging limb AFT / leans the torso
 * FORWARD; positive `rotation.z` tilts the torso top toward the mesh-left
 * hip). The spec quotes hips in the anatomical convention (θ negative =
 * aft extension); the conversion is hip_mesh_x = −θ_anatomical, while knee
 * flexion keeps the spec sign directly.
 */
/** Pushing (stance) leg hip aft extension at launch, rad (spec θ_hip −0.55). */
export const HURRY_PUSH_HIP_AFT_RAD = 0.55;
/** Pushing leg knee near full straightening, rad (spec θ_knee +0.05). */
export const HURRY_PUSH_KNEE_RAD = 0.05;
/** Leading (recovery) leg hip forward lift, rad (spec θ_hip +0.48). */
export const HURRY_LEAD_HIP_FWD_RAD = 0.48;
/** Leading leg deep knee flex, rad (spec θ_knee +0.85). */
export const HURRY_LEAD_KNEE_RAD = 0.85;
/** Torso pitch forward into the thrust vector, rad (7°, spec 0.12). */
export const HURRY_TORSO_PITCH_FWD_RAD = 0.12;
/** Torso lateral roll sway toward the stance hip, rad (1.5°, spec 0.026). */
export const HURRY_TORSO_ROLL_RAD = 0.026;
/** Arm on the stance side drives forward, rad (spec θ_shoulder −0.45). */
export const HURRY_ARM_STANCE_FWD_RAD = 0.45;
/** Arm on the recovery side swings aft, rad (spec θ_shoulder +0.35). */
export const HURRY_ARM_RECOVERY_AFT_RAD = 0.35;
/** Elbow flex carried by the forward-driving sprint arm (rad). */
export const HURRY_ARM_ELBOW_FWD_FLEX_RAD = 0.5;
/** Elbow flex carried by the aft-swinging sprint arm (rad). */
export const HURRY_ARM_ELBOW_AFT_FLEX_RAD = 0.25;
/** Brace phase: stance-hip load angle, slightly aft as the spring compresses (rad). */
export const HURRY_BRACE_STANCE_HIP_RAD = 0.18;
/** Brace phase: stance knee spring flexion (rad). */
export const HURRY_BRACE_STANCE_KNEE_RAD = 0.5;
/** Brace phase: recovery hip reaching forward for the next datum (rad). */
export const HURRY_BRACE_LEAD_HIP_FWD_RAD = 0.32;
/** Brace phase: recovery knee flex ahead of the next flight arc (rad). */
export const HURRY_BRACE_LEAD_KNEE_RAD = 0.55;
/** Footfall dust burst lateral offset from the suit centre along the
 *  perpendicular to heading — one hip width (d_hip ≈ 0.13 m, Spec 30 §2.2.3). */
export const BOOT_DUST_HIP_OFFSET_M = 0.13;

/**
 * One frame of the Spec 30 §2.2.3 unilateral Steelpush stride pose in the
 * mesh pivot convention (same `rotation.x` sign law as the walk cycle:
 * positive swings a hanging limb aft).
 */
export interface HurryStridePose {
  hipLx: number;
  hipRx: number;
  kneeLx: number;
  kneeRx: number;
  shoulderLx: number;
  shoulderRx: number;
  elbowLx: number;
  elbowRx: number;
  /** Torso pitch forward into the thrust vector (rad, upperBody.rotation.x). */
  torsoPitchRad: number;
  /** Torso roll toward the stance hip (rad, upperBody.rotation.z; + = toward left hip). */
  torsoRollRad: number;
  /** True on the ballistic `flight_arc` half, false on `ground_brace`. */
  airborne: boolean;
  /** The power side of this frame: pushing leg in flight, bracing leg braced. */
  powerIsLeft: boolean;
  /** Physics `hurryStrideLeg` this pose was built for (next leg to land). */
  strideLegIsLeft: boolean;
}

/**
 * Pure Spec 30 §2.2.3 stride articulation law. `strideLeg` is the physics
 * `hurryStrideLeg`: the leg that RECEIVES the next touchdown. So on the
 * flight arc it is the leading leg (hip lifted +0.48, knee flexed 0.85)
 * while the opposite pushing leg trails aft in toe-off follow-through
 * (hip 0.55 aft, knee straightened to 0.05); on the grounded brace frame it
 * is the braced stance leg (spring flex 0.5) while the recovery leg reaches
 * forward for the next datum. Arms run athletic sprint opposition — the arm
 * on the stance/pushing side drives forward (−0.45), the recovery-side arm
 * swings aft (+0.35) — and the torso leans 7° into the thrust vector with a
 * 1.5° roll sway toward the stance hip.
 */
export function hurryStridePose(
  strideLeg: HurryStrideLeg | undefined,
  airborne: boolean,
): HurryStridePose {
  const strideLegIsLeft = strideLeg !== 'right';
  // In flight the stride leg is the LEADING leg, so the pushing side is the
  // opposite hip; on the brace frame the stride leg is the planted STANCE
  // leg that will deliver the next Steelpush, i.e. the power side itself.
  const powerIsLeft = airborne ? !strideLegIsLeft : strideLegIsLeft;
  const hipPower = airborne ? HURRY_PUSH_HIP_AFT_RAD : HURRY_BRACE_STANCE_HIP_RAD;
  const kneePower = airborne ? HURRY_PUSH_KNEE_RAD : HURRY_BRACE_STANCE_KNEE_RAD;
  const hipRecovery = airborne ? -HURRY_LEAD_HIP_FWD_RAD : -HURRY_BRACE_LEAD_HIP_FWD_RAD;
  const kneeRecovery = airborne ? HURRY_LEAD_KNEE_RAD : HURRY_BRACE_LEAD_KNEE_RAD;
  return {
    hipLx: powerIsLeft ? hipPower : hipRecovery,
    hipRx: powerIsLeft ? hipRecovery : hipPower,
    kneeLx: powerIsLeft ? kneePower : kneeRecovery,
    kneeRx: powerIsLeft ? kneeRecovery : kneePower,
    shoulderLx: powerIsLeft ? -HURRY_ARM_STANCE_FWD_RAD : HURRY_ARM_RECOVERY_AFT_RAD,
    shoulderRx: powerIsLeft ? HURRY_ARM_RECOVERY_AFT_RAD : -HURRY_ARM_STANCE_FWD_RAD,
    elbowLx: ELBOW_REST_RAD + (powerIsLeft
      ? HURRY_ARM_ELBOW_FWD_FLEX_RAD
      : HURRY_ARM_ELBOW_AFT_FLEX_RAD),
    elbowRx: ELBOW_REST_RAD + (powerIsLeft
      ? HURRY_ARM_ELBOW_AFT_FLEX_RAD
      : HURRY_ARM_ELBOW_FWD_FLEX_RAD),
    torsoPitchRad: HURRY_TORSO_PITCH_FWD_RAD,
    // +rotation.z tips the torso top toward the mesh-left hip.
    torsoRollRad: powerIsLeft ? HURRY_TORSO_ROLL_RAD : -HURRY_TORSO_ROLL_RAD,
    airborne,
    powerIsLeft,
    strideLegIsLeft,
  };
}

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
 * Body geometry, metres (Spec 30 §2.1 Stormtrooper stylized armor contract —
 * blueprint §2.2). Local frame: +y up, +z is the helmet facing. Exported so
 * smoke harnesses assert the aesthetic gates against the live build:
 * pectoral carapace 0.38 × 0.32 × 0.16, abdominal cuirass tapering
 * 0.32 → 0.28, belt h 0.08 / d 0.32, pauldron bells r 0.09 flared 15° on a
 * shoulderDx 0.26 (0.52 m) stance, thigh cuirass r 0.115 / h 0.34, knee cop
 * 0.14 × 0.12 × 0.12, greave r 0.10 / h 0.26, boot 0.14 × 0.11 × 0.26,
 * twin cryo-cylinders r 0.085 / h 0.50, visor aperture w 0.34 / h 0.22.
 */
export const GEO = {
  torso: { y: 0.98, radius: 0.18, height: 0.58 },
  pectoralPlate: { y: 1.12, z: 0.09, width: 0.38, height: 0.32, depth: 0.16 },
  pectoralFacet: { y: 1.17, z: 0.168, dx: 0.105, width: 0.14, height: 0.1, depth: 0.05 },
  sternumPlate: { y: 1.12, z: 0.148, diameterTop: 0.075, diameterBottom: 0.13, height: 0.2, depthScale: 0.62 },
  abdominalRibs: { y: 0.92, z: 0.055, width: 0.32, waistWidth: 0.28, height: 0.22, depth: 0.15, tiers: 4 },
  utilityBelt: { y: 0.74, width: 0.34, height: 0.08, depth: 0.32 },
  beltBuckle: { y: 0.74, z: 0.176, width: 0.09, height: 0.06, depth: 0.035 },
  codpiece: { y: 0.68, z: 0.11, width: 0.16, height: 0.16, depth: 0.1 },
  beltCanister: { y: 0.74, dx: 0.18, radius: 0.045, height: 0.14 },
  helmet: { y: 1.48, diameter: 0.38, browRakeDeg: 5 },
  browRim: { y: 1.565, z: 0.035, diameter: 0.33, tube: 0.03 },
  visor: { y: 1.46, z: 0.075, diameter: 0.36, width: 0.34, height: 0.22, sx: 0.944, sy: 0.611, sz: 0.96 },
  chinAerator: { y: 1.35, z: 0.128, dx: 0.085, radius: 0.035, length: 0.06 },
  vocoder: { y: 1.315, z: 0.105, width: 0.06, height: 0.05, depth: 0.04 },
  plss: {
    pack: { y: 1.06, z: -0.24, width: 0.38, height: 0.6, depth: 0.14 },
    tank: { y: 1.08, z: -0.395, dx: 0.12, radius: 0.085, height: 0.5 },
    cowl: { y: 1.08, z: -0.46, width: 0.16, height: 0.46, depth: 0.15 },
    nozzle: { y: 0.78, z: -0.4, dx: 0.1, diameter: 0.09, length: 0.12, tilt: 0.7 },
  },
  arm: {
    shoulderY: 1.22, shoulderDx: 0.26,
    pauldron: { radius: 0.09, height: 0.14, flareDeg: 15 },
    upperRadius: 0.062, upperHeight: 0.3,
    bicepRadius: 0.08, bicepHeight: 0.18,
    forearmRadius: 0.06, forearmHeight: 0.28,
    vambraceRadius: 0.075, vambraceHeight: 0.18,
    cuffDiameter: 0.14, cuffHeight: 0.06,
    glove: { width: 0.11, height: 0.16, depth: 0.09 },
  },
  leg: {
    hipY: 0.66, hipDx: 0.12,
    thighRadius: 0.115, thighTopRadius: 0.105, thighHeight: 0.34,
    kneeCop: { y: 0.01, z: 0.055, width: 0.14, height: 0.12, depth: 0.12 },
    strikePlate: { y: 0.01, z: 0.13, width: 0.1, height: 0.09, depth: 0.035 },
    greaveRadius: 0.1, greaveTopRadius: 0.0925, greaveHeight: 0.26,
    calfRadius: 0.08, calfHeight: 0.26,
    boot: { y: -0.235, z: 0.02, width: 0.14, height: 0.11, depth: 0.26 },
    sole: { y: -0.305, z: 0.02, width: 0.16, height: 0.03, depth: 0.28 },
    spur: { y: -0.27, z: -0.135, width: 0.09, height: 0.05, depth: 0.07 },
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
  /** Upper-body pivot (helmet, visor, chest carapace, PLSS, arms) — takes the walk bob. */
  private upperBody: TransformNode | null = null;
  private parts: Mesh[] = [];
  private visor: Mesh | null = null;
  private torso: Mesh | null = null;
  /** Hip pivots swing the leg assemblies in counter-phase (Spec 28 §2.2/§2.3). */
  private hipL: TransformNode | null = null;
  private hipR: TransformNode | null = null;
  /** Knee pivots flex the greave+boot stack during the swing phase. */
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
  /**
   * Spec 30 §2.2.3: physics-frame world coordinates of the most recent
   * boot-dust burst (the exact planting boot sole, offset d_hip along the
   * perpendicular to heading). Null until the first puff. Smoke harnesses
   * assert consecutive bounding footfalls alternate left/right through this.
   */
  private lastBootDustPuffPos: { x: number; y: number; z: number } | null = null;
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
   * successful call). Every puff records its physics-frame origin on
   * {@link getLastBootDustPuffPos} (Spec 30 §2.2.3 alternating footfalls).
   */
  triggerBootDustPuff(at?: { x: number; y: number; z: number }): number {
    if (this.disposed) return this.bootDustPuffCount;
    const scene = this.scene;
    if (scene === null || scene.isDisposed) return this.bootDustPuffCount;
    const p = at ?? { x: this.last.x, y: this.last.y, z: this.last.z };
    this.lastBootDustPuffPos = { x: p.x, y: p.y, z: p.z };
    const isNull = scene.getEngine().name === 'NullEngine';
    if (isNull) {
      if (this.bootDustFallback === undefined) {
        this.bootDustFallback = new TransformNode('eva-boot-dust-fallback', scene);
      }
      // Park the fallback node at the puff origin so headless consumers can
      // read the alternating left/right boot coordinates off the scene too.
      const fb = worldToBabylon(p);
      this.bootDustFallback.position.set(fb.x, fb.y + 0.15, fb.z);
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

  /**
   * Spec 30 §2.2.3: physics-frame coordinates of the most recent boot-dust
   * burst (the planting boot sole), or null before the first puff.
   */
  getLastBootDustPuffPos(): { x: number; y: number; z: number } | null {
    return this.lastBootDustPuffPos === null
      ? null
      : { ...this.lastBootDustPuffPos };
  }

  // -- internals --------------------------------------------------------------

  /**
   * Procedural Stormtrooper composite armor (Spec 30 §2.1): muscular gasket
   * core under a flared pectoral carapace with sternum relief and chiseled
   * facets, 4-tier abdominal rib cuirass, tactical belt + buckle + codpiece +
   * twin flank canisters, contour PLSS pack with twin cryo-cylinders, cowl
   * and downward vector nozzles, raked-brow helmet with chin aerators and
   * vocoder grille over the panoramic gold visor, flared pauldrons on a
   * 0.52 m shoulder stance, bicep cuffs / vambraces / magnetic gauntlets /
   * gloves, thigh cuirasses with knee cops and strike plates, greaves and
   * heavy treaded magnetic boots with widened soles and aft heel spurs —
   * bound to the two-tone armor-white / undersuit-gasket / trim-hardware /
   * visor-gold PBR palette.
   */
  private buildAvatar(scene: Scene): void {
    const p = this.prefix;
    const g = GEO;

    // -- Spec 30 §2.1.4 two-tone high-contrast PBR material system -----------
    const armor = new PBRMaterial(`${p}-armor-white`, scene);
    // High-gloss composite ceramic armor plating.
    armor.albedoColor = new Color3(0.95, 0.95, 0.96);
    armor.metallic = 0.08;
    armor.roughness = 0.22;
    armor.environmentIntensity = 0.05; // vacuum: almost nothing to reflect

    const gasket = new PBRMaterial(`${p}-undersuit-gasket`, scene);
    // Matte charcoal ribbed flexible joint seal.
    gasket.albedoColor = new Color3(0.12, 0.12, 0.14);
    gasket.metallic = 0.02;
    gasket.roughness = 0.85;
    gasket.environmentIntensity = 0.05;

    const hardware = new PBRMaterial(`${p}-trim-hardware`, scene);
    // Dark titanium latches, aerators and belt hardware.
    hardware.albedoColor = new Color3(0.22, 0.23, 0.25);
    hardware.metallic = 0.8;
    hardware.roughness = 0.35;
    hardware.environmentIntensity = 0.05;

    const gold = new PBRMaterial(`${p}-visor-gold`, scene);
    // Apollo EVA gold-sputtered sun visor: high-reflectivity mirror metal
    // with a subtle amber interior glow (TASK-PLAY-060 / Spec 30 §2.1.4).
    gold.albedoColor = new Color3(0.96, 0.8, 0.28);
    gold.metallic = 0.98;
    gold.roughness = 0.06;
    gold.emissiveColor = new Color3(0.12, 0.08, 0.02);
    gold.environmentIntensity = 0.05;

    this.materials = [armor, gasket, hardware, gold];
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

    // -- torso core: muscular gasket body under the composite carapace ------
    const torso = add(
      MeshBuilder.CreateCapsule(
        `${p}-torso`,
        { radius: g.torso.radius, height: g.torso.height },
        scene,
      ),
      gasket,
      this.root,
      0,
      g.torso.y,
      0,
    );

    // Flared pectoral chestplate carapace (0.38 × 0.32 × 0.16, Spec 30 §2.1.1).
    add(
      MeshBuilder.CreateBox(
        `${p}-chest-carapace`,
        { width: g.pectoralPlate.width, height: g.pectoralPlate.height, depth: g.pectoralPlate.depth },
        scene,
      ),
      armor,
      upperBody,
      0,
      g.pectoralPlate.y,
      g.pectoralPlate.z,
    );
    // Chiseled pectoral facets — angled slivers over each breast plate.
    for (const side of ['l', 'r'] as const) {
      const sign = side === 'l' ? -1 : 1;
      const facet = add(
        MeshBuilder.CreateBox(
          `${p}-chest-facet-${side}`,
          { width: g.pectoralFacet.width, height: g.pectoralFacet.height, depth: g.pectoralFacet.depth },
          scene,
        ),
        armor,
        upperBody,
        sign * g.pectoralFacet.dx,
        g.pectoralFacet.y,
        g.pectoralFacet.z,
      );
      facet.rotation.x = -0.16; // chiseled outward bevel
      facet.rotation.z = sign * -0.14;
    }
    // Central trapezoidal sternum relief — square-frustum ridge tapering
    // upward, diamond-cut along the facing axis (Spec 30 §2.1.1).
    const sternum = add(
      MeshBuilder.CreateCylinder(
        `${p}-sternum-plate`,
        {
          diameterTop: g.sternumPlate.diameterTop,
          diameterBottom: g.sternumPlate.diameterBottom,
          height: g.sternumPlate.height,
          tessellation: 4,
        },
        scene,
      ),
      armor,
      upperBody,
      0,
      g.sternumPlate.y,
      g.sternumPlate.z,
    );
    sternum.scaling.z = g.sternumPlate.depthScale;

    // 4-tier segmented abdominal rib gasket cuirass, tapering 0.32 → 0.28
    // toward the waist for the athletic V-taper (Spec 30 §2.1.1).
    const ribs = g.abdominalRibs;
    const tierH = ribs.height / ribs.tiers - 0.01; // 0.01 m segmented gap
    for (let i = 0; i < ribs.tiers; i++) {
      const w = ribs.width - (ribs.width - ribs.waistWidth) * (i / (ribs.tiers - 1));
      add(
        MeshBuilder.CreateBox(
          `${p}-abdomen-rib-${i + 1}`,
          { width: w, height: tierH, depth: ribs.depth },
          scene,
        ),
        gasket,
        upperBody,
        0,
        ribs.y + ribs.height / 2 - ribs.height * ((i + 0.5) / ribs.tiers),
        ribs.z,
      );
    }

    // -- tactical utility belt, buckle, codpiece, flank canisters ----------
    add(
      MeshBuilder.CreateBox(
        `${p}-utility-belt`,
        { width: g.utilityBelt.width, height: g.utilityBelt.height, depth: g.utilityBelt.depth },
        scene,
      ),
      armor,
      this.root,
      0,
      g.utilityBelt.y,
      0,
    );
    add(
      MeshBuilder.CreateBox(
        `${p}-belt-buckle`,
        { width: g.beltBuckle.width, height: g.beltBuckle.height, depth: g.beltBuckle.depth },
        scene,
      ),
      hardware,
      this.root,
      0,
      g.beltBuckle.y,
      g.beltBuckle.z,
    );
    add(
      MeshBuilder.CreateBox(
        `${p}-codpiece`,
        { width: g.codpiece.width, height: g.codpiece.height, depth: g.codpiece.depth },
        scene,
      ),
      armor,
      this.root,
      0,
      g.codpiece.y,
      g.codpiece.z,
    );
    // Twin flank utility canisters — emergency O2 reserves (r 0.045, h 0.14).
    for (const side of ['l', 'r'] as const) {
      const sign = side === 'l' ? -1 : 1;
      add(
        MeshBuilder.CreateCylinder(
          `${p}-belt-canister-${side}`,
          { diameter: g.beltCanister.radius * 2, height: g.beltCanister.height, tessellation: 12 },
          scene,
        ),
        hardware,
        this.root,
        sign * g.beltCanister.dx,
        g.beltCanister.y,
        0,
      );
    }

    // -- helmet: raked brow dome, chin aerators, vocoder, gold visor --------
    add(
      MeshBuilder.CreateSphere(
        `${p}-helmet`,
        { diameter: g.helmet.diameter, segments: 20 },
        scene,
      ),
      armor,
      upperBody,
      0,
      g.helmet.y,
      0,
    );
    // Extended downward-slanted brow rim, 5° forward rake (Spec 30 §2.1.3).
    const brow = add(
      MeshBuilder.CreateTorus(
        `${p}-helmet-brow`,
        { diameter: g.browRim.diameter, thickness: g.browRim.tube, tessellation: 24 },
        scene,
      ),
      armor,
      upperBody,
      0,
      g.browRim.y,
      g.browRim.z,
    );
    brow.rotation.x = (g.helmet.browRakeDeg * Math.PI) / 180;
    // Twin cylindrical respirator aerator pods at the lower chin flanks.
    for (const side of ['l', 'r'] as const) {
      const sign = side === 'l' ? -1 : 1;
      const aerator = add(
        MeshBuilder.CreateCylinder(
          `${p}-helmet-aerator-${side}`,
          { diameter: g.chinAerator.radius * 2, height: g.chinAerator.length, tessellation: 14 },
          scene,
        ),
        hardware,
        upperBody,
        sign * g.chinAerator.dx,
        g.chinAerator.y,
        g.chinAerator.z,
      );
      aerator.rotation.x = Math.PI / 2; // nozzle axis along the facing axis
    }
    // Central dark vocoder speaker grille between the aerators.
    add(
      MeshBuilder.CreateBox(
        `${p}-helmet-vocoder`,
        { width: g.vocoder.width, height: g.vocoder.height, depth: g.vocoder.depth },
        scene,
      ),
      hardware,
      upperBody,
      0,
      g.vocoder.y,
      g.vocoder.z,
    );
    // Panoramic gold-sputtered visor aperture w 0.34 / h 0.22, recessed
    // beneath the armored brow.
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

    // -- PLSS: contour pack into the back yoke, twin cryo-cylinders ---------
    add(
      MeshBuilder.CreateBox(
        `${p}-plss-pack`,
        { width: g.plss.pack.width, height: g.plss.pack.height, depth: g.plss.pack.depth },
        scene,
      ),
      armor,
      upperBody,
      0,
      g.plss.pack.y,
      g.plss.pack.z,
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

    // -- arms: pauldron → bicep → elbow → vambrace + gauntlet cuff + glove --
    const buildArm = (side: 'l' | 'r'): {
      shoulder: TransformNode;
      elbow: TransformNode;
    } => {
      const sign = side === 'l' ? -1 : 1;
      const shoulder = new TransformNode(`${p}-shoulder-${side}`, scene);
      shoulder.parent = upperBody;
      shoulder.position.set(sign * g.arm.shoulderDx, g.arm.shoulderY, 0);
      // Curved shoulder bell (pauldron), flared 15° outward off the pivot.
      const pauldronFlare = (g.arm.pauldron.flareDeg * Math.PI) / 180;
      const pauldron = add(
        MeshBuilder.CreateCylinder(
          `${p}-pauldron-${side}`,
          {
            diameterTop: (g.arm.pauldron.radius - Math.tan(pauldronFlare) * g.arm.pauldron.height) * 2,
            diameterBottom: g.arm.pauldron.radius * 2,
            height: g.arm.pauldron.height,
            tessellation: 20,
          },
          scene,
        ),
        armor,
        shoulder,
        0,
        -0.015,
        0,
      );
      pauldron.rotation.z = -sign * pauldronFlare; // bell opens down-and-out
      add(
        MeshBuilder.CreateCapsule(
          `${p}-arm-upper-${side}`,
          { radius: g.arm.upperRadius, height: g.arm.upperHeight },
          scene,
        ),
        gasket,
        shoulder,
        0,
        -g.arm.upperHeight / 2,
        0,
      );
      // Armored bicep cuff cuff (r 0.08).
      add(
        MeshBuilder.CreateCylinder(
          `${p}-arm-bicep-${side}`,
          { diameter: g.arm.bicepRadius * 2, height: g.arm.bicepHeight, tessellation: 16 },
          scene,
        ),
        armor,
        shoulder,
        0,
        -0.10,
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
        gasket,
        elbow,
        0,
        -g.arm.forearmHeight / 2,
        0,
      );
      // Contoured forearm vambrace (r 0.075).
      add(
        MeshBuilder.CreateCylinder(
          `${p}-arm-vambrace-${side}`,
          { diameter: g.arm.vambraceRadius * 2, height: g.arm.vambraceHeight, tessellation: 16 },
          scene,
        ),
        armor,
        elbow,
        0,
        -0.18,
        0.004,
      );
      // Heavy magnetic gauntlet cuff (d 0.14).
      add(
        MeshBuilder.CreateCylinder(
          `${p}-arm-cuff-${side}`,
          { diameter: g.arm.cuffDiameter, height: g.arm.cuffHeight, tessellation: 16 },
          scene,
        ),
        hardware,
        elbow,
        0,
        -(g.arm.forearmHeight - 0.02),
        0,
      );
      // Articulated glove mesh below the gauntlet cuff.
      add(
        MeshBuilder.CreateBox(
          `${p}-arm-glove-${side}`,
          { width: g.arm.glove.width, height: g.arm.glove.height, depth: g.arm.glove.depth },
          scene,
        ),
        armor,
        elbow,
        0,
        -(g.arm.forearmHeight + g.arm.glove.height / 2 - 0.06),
        0.01,
      );
      return { shoulder, elbow };
    };
    const armL = buildArm('l');
    const armR = buildArm('r');
    this.shoulderL = armL.shoulder;
    this.elbowL = armL.elbow;
    this.shoulderR = armR.shoulder;
    this.elbowR = armR.elbow;

    // -- legs: hip → thigh cuirass + knee cop/strike → knee → greave + boot -
    const buildLeg = (side: 'l' | 'r'): {
      hip: TransformNode;
      knee: TransformNode;
    } => {
      const sign = side === 'l' ? -1 : 1;
      const hip = new TransformNode(`${p}-hip-${side}`, scene);
      hip.parent = this.root;
      hip.position.set(sign * g.leg.hipDx, g.leg.hipY, 0);
      // Flared thigh cuirass sleeve (r 0.115, h 0.34) over the upper leg.
      add(
        MeshBuilder.CreateCylinder(
          `${p}-leg-thigh-${side}`,
          {
            diameterTop: g.leg.thighTopRadius * 2,
            diameterBottom: g.leg.thighRadius * 2,
            height: g.leg.thighHeight,
            tessellation: 18,
          },
          scene,
        ),
        armor,
        hip,
        0,
        -g.leg.thighHeight / 2,
        0,
      );
      // Prominent angular knee cop with forward strike plate (Spec 30 §2.1.2).
      add(
        MeshBuilder.CreateBox(
          `${p}-leg-kneecop-${side}`,
          { width: g.leg.kneeCop.width, height: g.leg.kneeCop.height, depth: g.leg.kneeCop.depth },
          scene,
        ),
        armor,
        hip,
        0,
        -g.leg.thighHeight + g.leg.kneeCop.y,
        g.leg.kneeCop.z,
      );
      add(
        MeshBuilder.CreateBox(
          `${p}-leg-strikeplate-${side}`,
          { width: g.leg.strikePlate.width, height: g.leg.strikePlate.height, depth: g.leg.strikePlate.depth },
          scene,
        ),
        hardware,
        hip,
        0,
        -g.leg.thighHeight + g.leg.strikePlate.y,
        g.leg.strikePlate.z,
      );
      const knee = new TransformNode(`${p}-kneejoint-${side}`, scene);
      knee.parent = hip;
      knee.position.set(0, -g.leg.thighHeight, 0);
      add(
        MeshBuilder.CreateCapsule(
          `${p}-leg-calf-${side}`,
          { radius: g.leg.calfRadius, height: g.leg.calfHeight },
          scene,
        ),
        gasket,
        knee,
        0,
        -g.leg.calfHeight / 2,
        0,
      );
      // Sculpted shin greave (r 0.10, h 0.26).
      add(
        MeshBuilder.CreateCylinder(
          `${p}-leg-greave-${side}`,
          {
            diameterTop: g.leg.greaveTopRadius * 2,
            diameterBottom: g.leg.greaveRadius * 2,
            height: g.leg.greaveHeight,
            tessellation: 18,
          },
          scene,
        ),
        armor,
        knee,
        0,
        -g.leg.greaveHeight / 2 + 0.005,
        0.008,
      );
      // Chunky treaded magnetic boot (0.14 × 0.11 × 0.26), toe forward.
      add(
        MeshBuilder.CreateBox(
          `${p}-leg-boot-${side}`,
          { width: g.leg.boot.width, height: g.leg.boot.height, depth: g.leg.boot.depth },
          scene,
        ),
        armor,
        knee,
        0,
        g.leg.boot.y,
        g.leg.boot.z,
      );
      // Widened ground-contact sole.
      add(
        MeshBuilder.CreateBox(
          `${p}-leg-sole-${side}`,
          { width: g.leg.sole.width, height: g.leg.sole.height, depth: g.leg.sole.depth },
          scene,
        ),
        hardware,
        knee,
        0,
        g.leg.sole.y,
        g.leg.sole.z,
      );
      // Aft heel spur.
      add(
        MeshBuilder.CreateBox(
          `${p}-leg-spur-${side}`,
          { width: g.leg.spur.width, height: g.leg.spur.height, depth: g.leg.spur.depth },
          scene,
        ),
        hardware,
        knee,
        0,
        g.leg.spur.y,
        g.leg.spur.z,
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

  /**
   * Spec 30 §2.2.3: physics-frame world coordinates of a boot sole at rest
   * on the regolith datum under the current suit — the suit centre offset by
   * ±d_hip along the perpendicular to heading (left leg on the −side, right
   * on the +side of travel; heading 0 = +x so the lateral unit vector is
   * (−sin h, cos h)). Footfall dust bursts fired from these exact points
   * trace the alternating left/right regolith trail down the surface.
   */
  private bootSoleWorldPos(
    state: SuitState,
    leg: HurryStrideLeg,
  ): { x: number; y: number; z: number } {
    const sign = leg === 'left' ? -1 : 1;
    const h = state.heading ?? 0;
    return {
      x: state.x - sign * BOOT_DUST_HIP_OFFSET_M * Math.sin(h),
      y: state.y + sign * BOOT_DUST_HIP_OFFSET_M * Math.cos(h),
      z: state.z,
    };
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
   * While the physics gait is `bounding`, the pose instead rides the Spec 30
   * §2.2.3 unilateral Steelpush stride ({@link hurryStridePose}): pushing
   * leg extended aft in toe-off follow-through, leading leg swung forward
   * with deeply flexed knee, arms in athletic sprint opposition, and the
   * torso leaning 7° into the thrust vector with a 1.5° roll sway toward the
   * stance hip. Each touchdown kicks a regolith boot-dust puff from the
   * exact planting-sole coordinates and arms the −0.06 m landing crouch.
   * Visual only — physics stays in `LunarEvaSuit`. Stopped the pose snaps
   * back to neutral standing.
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
    // Stride torso lean/roll is bounding-only — every other branch below
    // owns a level torso, so park it before dispatching on the gait band.
    upper.rotation.x = 0;
    upper.rotation.z = 0;

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
      // Spec 30 §2.2.3 unilateral Steelpush articulation — the stride clock
      // parks while the alternating arc owns the frame. `hurryStrideLeg` is
      // the leg that RECEIVES the next touchdown: on the flight arc it is
      // the leading leg (hip lifted, knee deeply flexed) while the opposite
      // pushing leg trails aft in toe-off follow-through; on the grounded
      // brace frame it is the planted stance leg loading the spring.
      this.walkCycleTime = 0;
      const strideLeg = state.hurryStrideLeg ?? 'left';
      const airborne = !state.isGrounded;
      if (airborne) {
        this.boundingFlight = true;
      } else if (this.boundingFlight) {
        // Touchdown edge: kick regolith dust at the EXACT world coordinates
        // of the planting boot sole, and arm the compression crouch.
        this.boundingFlight = false;
        this.boundCrouchClock = BOUND_CROUCH_DURATION_S / 2;
        this.triggerBootDustPuff(this.bootSoleWorldPos(state, strideLeg));
      }
      const pose = hurryStridePose(strideLeg, airborne);
      hipL.rotation.x = pose.hipLx;
      hipR.rotation.x = pose.hipRx;
      if (kneeL !== null) kneeL.rotation.x = pose.kneeLx;
      if (kneeR !== null) kneeR.rotation.x = pose.kneeRx;
      // Arms in athletic sprint opposition, held in the sagittal plane
      // (rotation.z parked — the Spec 28 balance spread is retired).
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
      // Torso dynamics: 7° pitch into the thrust vector + 1.5° roll sway
      // toward the stance hip; the upper body dips through the brace ramp
      // (physics-reported compression) and the landing crouch envelope.
      upper.rotation.x = pose.torsoPitchRad;
      upper.rotation.z = pose.torsoRollRad;
      const dip = crouch - (airborne ? 0 : (state.hurryBraceCompression ?? 0));
      torso.position.y = GEO.torso.y + dip;
      upper.position.y = dip;
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
