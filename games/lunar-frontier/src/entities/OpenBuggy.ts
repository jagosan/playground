/**
 * Lunar Frontier — open-top lunar buggy entity (TASK-PLAY-049b; Spec 17 §4
 * visual realism overhaul, TASK-PLAY-064e).
 *
 * Visual/interaction wrapper over the EXISTING traversal physics module: owns
 * one `LunarBuggy` (from ../physics/TraversalPhysics.ts) and dresses it in a
 * procedural Babylon.js rover. No physics in this file — no gravity, no
 * integration, no duplicated BUGGY_* constants. `update(dt, input)` steps the
 * owned buggy exactly once and copies the resulting `BuggyState` onto meshes,
 * wheels and headlights.
 *
 * Spec 17 §4 assembly (procedural only, no GLB): chassis tub with underbody
 * skid plate, tubular powder-coated space frame + double roll hoop cage with
 * roof longons and X cross-bracing, reinforced front winch/bumper bar, twin
 * LED lightbars with translucent front light cones, racing bucket seat with
 * 4-point harness straps, live digital telemetry dash (speed/power segment
 * bars rastered into a RawTexture), per-corner double-wishbone A-arms,
 * coaxial coilover spring + damper-rod assemblies that visibly compress with
 * per-wheel suspension compression, and steering tie-rods from the rack to
 * the front knuckles that track the Ackermann-solved steer angle in real
 * time. PBR palette per §4.4: powder-coated frame, carbon-fibre textured
 * bed, matte rubber tyres, polished suspension stanchions.
 *
 * Frame convention matches TraversalPhysics / CameraRig: world metres
 * (x, y lateral, z up) map to Babylon (x, z↑, -y) via the shared
 * `worldToBabylon`, and heading (radians, 0 = +x) maps to Babylon
 * `rotation.y = PI/2 + heading` (exposed as `getBabylonYaw()`). Under that
 * yaw the model frame reads +z = nose (physics-forward), +x = left, +y = up —
 * identical to the mapping CameraRig gives a camera with rotation.y =
 * PI/2 + yaw, so nose, camera and physics cannot disagree. Attitude (pitch,
 * roll) is stored in a YXZ quaternion so the azimuth stays exactly PI/2 +
 * heading while the body tilts inside the yawed frame.
 *
 * Headless-safe: `init()` accepts a Scene, a raw engine (a scene is created
 * around it), or nothing (self-owned NullEngine fallback). `dispose()` is
 * idempotent; after disposal `update()` keeps stepping physics and returns
 * state instead of throwing.
 */
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';

import {
  BUGGY_BATTERY_KWH,
  BUGGY_CHASSIS_MASS,
  BUGGY_MAX_CARGO,
  BUGGY_SEAT_BELOW_DATUM,
  BUGGY_SPRING_RATE,
  BUGGY_SPRING_TRAVEL,
  BUGGY_TRACK,
  BUGGY_WHEEL_RADIUS,
  IDLE_BUGGY_INPUT,
  LunarBuggy,
  LUNAR_GRAVITY,
  type BuggyInput,
  type BuggyOptions,
  type BuggyState,
  type GroundElevationFn,
} from '../physics/TraversalPhysics.ts';
import { babylonToWorld, worldToBabylon } from '../engine/CameraRig.ts';
import {
  CARGO_CATCH_RADIUS_M,
  CARGO_CATCH_RELATIVE_MAX_MPS,
  HEIST_MOON_CARGO,
  type HeistMoonCargoType,
} from '../quests/TrainHeistDirector.ts';
import {
  calculateBuggyStats,
  defaultInstalledUpgrades,
  validateInstalledShape,
  type BuggyStats,
  type InstalledUpgrades,
} from '../garage/BuggyUpgradeSystem.ts';

/** Distance within which the prospector can drop into the driver seat (m). */
export const MOUNT_RADIUS_M = 3.5;
/** Lateral step to the driver side on dismount, perpendicular to heading (m). */
export const DISMOUNT_LATERAL_M = 2.0;
/** Headlight intensity while lit. */
export const HEADLIGHT_INTENSITY = 3.2;
/** Headlight cone full angle, degrees. */
export const HEADLIGHT_ANGLE_DEG = 58;
/** Headlight beam range, metres. */
export const HEADLIGHT_RANGE_M = 65;

// -- Dual-stage stadium projector rig (Spec 23 §2.4 / ADR-023-4) --------------
/**
 * Low-beam mega-flood: perimeter work wash.
 * Spec 23 §2.4.1 Stage 1 re-cut the Spec 21 values (85°/45 m/2.8) up to
 * stadium grade: 110° cone, 85 m throw, 8.5 intensity.
 */
export const LOW_BEAM_INTENSITY = 8.5;
export const LOW_BEAM_ANGLE_DEG = 110;
export const LOW_BEAM_RANGE_M = 85;

/**
 * High-beam hyper-piercing projector: long-range navigation spot.
 * Spec 23 §2.4.1 Stage 2 re-cut the Spec 21 values (42°/120 m/4.5) to
 * 30° cone, 250 m throw, 16.0 intensity, crisp daylight-white.
 */
export const HIGH_BEAM_INTENSITY = 16.0;
export const HIGH_BEAM_ANGLE_DEG = 30;
export const HIGH_BEAM_RANGE_M = 250;
/** Stage 2 projector colour temperature: crisp daylight white (Spec 23 §2.4.1). */
export const HIGH_BEAM_COLOR = { r: 1.0, g: 0.98, b: 0.95 };

/**
 * Visual length (m) of the additive dust-scattering cone shells (Spec 23
 * §2.4.2). Deliberately shorter than the SpotLight throw: a full 250 m
 * translucent shell would wash out the whole scene; a short dense shell at
 * the lightbar reads as forward scatter against the levitating dust layer
 * while the invisible SpotLight does the actual 250 m illumination. Cone
 * mouths keep the true beam angles: d = 2·L·tan(θ/2).
 */
export const BEAM_CONE_FLOOD_M = 12;
export const BEAM_CONE_HIGH_M = 30;

/** Coilover spring body length scale at full droop (compression = 0). */
export const COIL_SCALE_DROOP = 1.15;
/** Coilover spring body length scale at the bump stop (compression = 1). */
export const COIL_SCALE_BUMP = 0.72;
/** Damper rod visible-length scale at full droop (compression = 0). */
export const ROD_SCALE_DROOP = 1.18;
/** Damper rod visible-length scale at the bump stop (compression = 1). */
export const ROD_SCALE_BUMP = 0.62;

/** Linear coilover spring scale from suspension compression 0..1 (Spec 17 §4.2). */
export function coilScaleFor(compression: number): number {
  const c = compression < 0 ? 0 : compression > 1 ? 1 : compression;
  return COIL_SCALE_DROOP + (COIL_SCALE_BUMP - COIL_SCALE_DROOP) * c;
}

/** Linear damper-rod scale from suspension compression 0..1 (Spec 17 §4.2). */
export function rodScaleFor(compression: number): number {
  const c = compression < 0 ? 0 : compression > 1 ? 1 : compression;
  return ROD_SCALE_DROOP + (ROD_SCALE_BUMP - ROD_SCALE_DROOP) * c;
}

/**
 * Quest/contractor telemetry mirrored onto the cockpit dash (Spec 18 §6.3,
 * ADR-18-3). Fed by `ClientApp` whenever the player boards the buggy and on
 * every quest state change; every field is optional so partial updates merge
 * cleanly into the last snapshot. Rastered into the same RawTexture buffer as
 * the speed/power segment bars — no DOM canvas, NullEngine-safe.
 */
export interface BuggyDashTelemetry {
  /** Active quest title (e.g. "A One-Way Ticket to the Frontier"). */
  questTitle?: string;
  /** Current objective text shown under the title. */
  objectiveText?: string;
  /** Slant range to the active objective, metres. */
  targetDistanceM?: number;
  /** Compass bearing to the active objective, degrees (0 = north, CW). */
  targetBearingDeg?: number;
  /** Haul aboard, kg (dash cargo meter; independent of physics cargo). */
  cargoKg?: number;
  /** Cargo capacity, kg (default `BUGGY_MAX_CARGO`). */
  maxCargoKg?: number;
  /** Contractor corporation / faction tag (insignia line). */
  faction?: string;
  /** Radio link status readout (e.g. "ONLINE - 128 kbps"). */
  linkStatus?: string;
}

/**
 * Last rastered dash state — the inspection surface headless tests use to
 * verify quest telemetry landed (Spec 18 §8.3: entering the buggy updates the
 * dashboard with quest coordinates and cargo inventory).
 */
export interface BuggyDashView {
  /** True once quest/contractor telemetry has been installed. */
  questActive: boolean;
  questTitle: string | null;
  objectiveText: string | null;
  /** Null only when no target distance has ever been received. */
  targetDistanceM: number | null;
  targetBearingDeg: number | null;
  cargoKg: number;
  maxCargoKg: number;
  faction: string | null;
  linkStatus: string | null;
}

/** Options for the entity; physics tuning delegates to `BuggyOptions`. */
export interface OpenBuggyOptions extends BuggyOptions {
  /** Spawn position (physics frame). Defaults to the origin. */
  x?: number;
  y?: number;
  /** Spawn heading, radians in the x-y plane (0 = +x). Default 0. */
  heading?: number;
  /** Headlights lit at spawn (default true). */
  headlights?: boolean;
  /** Node/mesh/material name prefix (default `buggy`). */
  namePrefix?: string;
}

/** Consolidated HUD readout, one allocation per call. */
export interface OpenBuggyTelemetry {
  /** Road speed |vLong| (m/s). */
  speed: number;
  /** Body-frame longitudinal velocity (m/s, + forward). */
  vLong: number;
  /** Heading, radians in the x-y plane (0 = +x). */
  heading: number;
  /** Nose-up chassis attitude, radians. */
  pitch: number;
  /** Roll attitude, radians (+ = left side up). */
  roll: number;
  /** Traction battery remaining (kWh). */
  battery: number;
  /** Battery state of charge, 0..1. */
  batteryFraction: number;
  /** Mineral load aboard (kg). */
  cargoMass: number;
  /** Cargo load fraction, 0..1 of `BUGGY_MAX_CARGO`. */
  cargoFraction: number;
  /** Sprung + unsprung mass including cargo (kg). */
  totalMass: number;
  /** Chassis datum height above local ground (m). */
  rideHeight: number;
  /** Mean suspension compression, 0 drooped .. 1 bump stop. */
  suspensionCompression: number;
  /** Instantaneous drivetrain mechanical output (kW), Spec 17 §4.3 dash feed. */
  powerKw: number;
  isGrounded: boolean;
  airborne: boolean;
  rolled: boolean;
  headlightsOn: boolean;
  mounted: boolean;
}

/**
 * Body geometry, metres. Model frame under the root: +z = nose (physics
 * forward), +x = left, +y = up.
 */
const GEO = {
  chassis: { width: 1.42, height: 0.22, depth: 2.9 },
  bed: { width: 1.5, height: 0.18, depth: 1.7, z: -0.55, y: 0.42 },
  seat: { width: 0.55, height: 0.14, depth: 0.55, z: 0.3, y: 0.5, x: -0.26 },
  seatBack: { width: 0.55, height: 0.55, depth: 0.12, z: 0.02, y: 0.78, x: -0.26 },
  wheel: { depth: 0.34, tessellation: 20, axle: 1.35 },
  lamp: { lateral: 0.66, y: 0.42, z: 1.35 },
  /** Tubular space-frame members (Spec 17 §4.1 chamfered structural tubes). */
  tube: { diameter: 0.07 },
  /** Reinforced front winch/bumper bar. */
  bumper: { z: 1.66, y: 0.16, width: 1.62 },
  /** Coilover mounts (chassis-local frame): upper on the frame rail, lower
   *  at the lower A-arm outer ball joint. */
  coil: { upperX: 0.56, upperY: 0.3, lowerX: 0.78, lowerY: 0.02, zScale: 0.94 },
  /** Steering rack (tie-rod anchor rail, chassis-local). */
  rack: { y: 0.2, z: 1.12, halfWidth: 0.4, diameter: 0.07 },
  /** Tie-rod outer attach offset from the front knuckle centre (upright). */
  tieAttach: { x: 0.1, y: -0.08, z: -0.14 },
} as const;

/** Wheel mount slots: front-left, front-right, rear-left, rear-right. */
const WHEEL_SLOTS: ReadonlyArray<{ z: number; side: 1 | -1 }> = [
  { z: GEO.wheel.axle, side: 1 },
  { z: GEO.wheel.axle, side: -1 },
  { z: -GEO.wheel.axle, side: 1 },
  { z: -GEO.wheel.axle, side: -1 },
];

const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
/** Chassis datum rise above the wheel-centre plane at rest spawn ride (m).
 *  Mirrors the physics module's initial `bodyHeight = R + 0.229`. */
const CHASSIS_DATUM_RISE = 0.229;

/**
 * Spec 32 §2.5: chassis-LOCAL wheel-centre height for a suspension
 * compression fraction (0 = full droop, 1 = bump stop). Mirrors the physics
 * corner law x0 = (2c − 1)·travel measured against the spring seat
 * BUGGY_SEAT_BELOW_DATUM under the chassis datum. The root node rides at the
 * chassis datum's true world elevation, so on the ground this places each
 * wheel centre exactly on its own corner's terrain + R, and at compression
 * 0 (airborne) the road wheels hang at MAXIMUM droop travel below the
 * chassis body — decoupled from the terrain floor far below.
 */
function wheelLocalY(compression: number): number {
  return (compression * 2 - 1) * BUGGY_SPRING_TRAVEL - BUGGY_SEAT_BELOW_DATUM;
}
/** Static build pose: neutral ride (compression ½) in the datum-riding root. */
const WHEEL_NEUTRAL_LOCAL_Y = wheelLocalY(0.5);
/** Tyre lay-down: cylinder axis local +y → axle axis local +x (left). */
const LAY_DOWN = Quaternion.RotationAxis(new Vector3(0, 0, 1), -Math.PI / 2);
/** Lamp attach points in the model frame: index 0 = left, 1 = right. */
const LAMP_POINTS = [
  new Vector3(GEO.lamp.lateral, GEO.lamp.y, GEO.lamp.z),
  new Vector3(-GEO.lamp.lateral, GEO.lamp.y, GEO.lamp.z),
];
/** Dash readout texture raster (segment-bar telemetry display, Spec 17 §4.3). */
const DASH_W = 64;
const DASH_H = 32;
/** Dash gauge full-scale values: m/s and kW (4 × 18 kW motors, Spec 16 §2.5). */
const DASH_SPEED_FSK = 30;
const DASH_POWER_FSKW = 72;
/** Quest range-ladder full scale (Spec 18 §6.3): 120 m to the objective. */
const DASH_RANGE_FULL_M = 120;

// -- Spec 36 Phase 3: flatbed magnetic cargo hopper ---------------------------

/**
 * Spec 36 §2.2 / §3 Phase 3: the flatbed hopper holds up to six physical
 * canisters in an aligned 2×3 grid. Caught mass rides the physics cargo
 * loader, so inertia and suspension compression follow automatically
 * (M_total = M_chassis + Σ M_cargo).
 */
export const HOPPER_CAPACITY = 6;
/** Spec 36 §2.2: magnetic attractor strength k_mag (N). */
export const HOPPER_K_MAG_N = 120;
/** Spec 36 §2.2: relative-velocity damping c_damp (N·s/m). */
export const HOPPER_C_DAMP_NS_M = 35;
/** Spec 36 §2.2: soft electromagnetic capture gradient R_catch (m). Aliases
 *  the director's {@link CARGO_CATCH_RADIUS_M} so aim prediction and the
 *  physical catch can never drift apart. */
export const HOPPER_CATCH_RADIUS_M = CARGO_CATCH_RADIUS_M;
/** Spec 36 §2.2: relative-velocity ceiling for a magnetic capture (m/s). */
export const HOPPER_RELATIVE_MAX_MPS = CARGO_CATCH_RELATIVE_MAX_MPS;
/**
 * Spec 36 §2.2: physical bed bounding envelope in the buggy hopper frame —
 * X ∈ [−0.75, +0.75] m (width), Y ∈ [−1.20, −0.10] m (aft bed),
 * Z ∈ [0.20, 0.90] m (height above the chassis datum). The spec's Y/Z pair
 * maps onto the OpenBuggy model frame (x = left, y = up, z = nose) as
 * model-y = spec-Z and model-z = spec-Y: the envelope is the air column
 * above the carbon cargo bed, aft of the cockpit.
 */
export const HOPPER_BED_BOUNDS = {
  x: [-0.75, 0.75],
  y: [-1.2, -0.1],
  z: [0.2, 0.9],
} as const;
/** Hopper-frame bed-centre point (m): mid of Y and Z extents. The height
 *  matches the director's BUGGY_BED_CENTRE_HEIGHT_M = 0.55 m. */
export const HOPPER_BED_CENTRE = { x: 0, y: -0.65, z: 0.55 } as const;
/**
 * The bed centre expressed in the Babylon model frame (x left, y up, z
 * nose): (0, 0.55, −0.65) — parent point for latched canister meshes.
 */
const HOPPER_BED_CENTRE_MODEL = { x: 0, y: HOPPER_BED_CENTRE.z, z: HOPPER_BED_CENTRE.y };
/** Half-extents derived from {@link HOPPER_BED_BOUNDS} in model axes
 *  (lat = spec X, lon = spec Y, up = spec Z). */
const HOPPER_BED_HALF = {
  lat: (HOPPER_BED_BOUNDS.x[1] - HOPPER_BED_BOUNDS.x[0]) / 2,
  lon: (HOPPER_BED_BOUNDS.y[1] - HOPPER_BED_BOUNDS.y[0]) / 2,
  up: (HOPPER_BED_BOUNDS.z[1] - HOPPER_BED_BOUNDS.z[0]) / 2,
} as const;
/**
 * Aligned 2×3 stacking grid (model frame, x = left, z = nose): column 0 is
 * port (x = +0.36 m), column 1 starboard; three rows aft → forward. Slot
 * pitch keeps ≥ 70 mm clearance between the widest container (the 0.30 m
 * water cryo-cell).
 */
export const HOPPER_GRID_SLOTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: 0.36, z: -1.02 },
  { x: 0.36, z: -0.65 },
  { x: 0.36, z: -0.28 },
  { x: -0.36, z: -1.02 },
  { x: -0.36, z: -0.65 },
  { x: -0.36, z: -0.28 },
];
/** Canister rest plane: the cargo-bed floor top in model y (m) — the carbon
 *  bed box tops out at 0.25 + 0.18/2 = 0.34 and latched canisters sit on it. */
const HOPPER_BED_FLOOR_Y = 0.34;
/** An inbound canister that has not latched within this window has missed
 *  the hopper and is quietly dropped from tracking (s). */
export const HOPPER_INBOUND_MAX_AGE_S = 5.0;

// -- Spec 37 Phase 2: modular upgrade geometry --------------------------------

/**
 * Spec 37 §2.1 Tier 2 (Extended Freight Flatbed): hopper ceiling grows from
 * the stock 6 slots to a 12-slot double-tier stack (the original 2×3 lower
 * grid plus a mirrored 2×3 upper deck above it, served by the double-tiered
 * side rails). {@link BuggyCargoHopper.setCapacity} moves the ceiling; the
 * stock constant {@link HOPPER_CAPACITY} stays 6 for Tier-1 builds.
 */
export const HOPPER_EXTENDED_CAPACITY = 12;
/** Vertical rise of the upper cargo deck above the bed floor (m): clears the
 *  tallest container (0.44 m LOX cylinder) with stacking headroom. */
export const HOPPER_UPPER_DECK_Y = 0.54;
/** Rear subframe extension of the Tier-2 flatbed along model −z (m) —
 *  mirrors the catalog's `subframeExtensionM: 0.6` (Spec 37 §2.1). */
export const UPGRADE_SUBFRAME_EXTENSION_M = 0.6;
/** Model-frame z of the rear frame rail the extended subframe splices onto. */
const REAR_FRAME_Z = -1.45;
/** Lateral x of the cargo side rails (bed half-width + a knuckle, m). */
const SIDE_RAIL_X = 0.7;

/**
 * Grid slot for the double-tier stack: slot index `s` maps to column `s % 6`
 * of {@link HOPPER_GRID_SLOTS} and deck 0 (floor) or 1 (upper) — slots 6..11
 * ride the upper deck (Spec 37 §2.1 Tier 2).
 */
export function hopperGridSlot(s: number): { x: number; z: number; deck: 0 | 1 } {
  const base = HOPPER_GRID_SLOTS[s % HOPPER_GRID_SLOTS.length] ?? HOPPER_GRID_SLOTS[0]!;
  return { x: base.x, z: base.z, deck: s >= HOPPER_GRID_SLOTS.length ? 1 : 0 };
}

/** Per-type container envelope + PBR silhouette for the bed stack. */
interface HopperCargoShape {
  /** Container diameter across (m). */
  diameter: number;
  /** Container height along its rest axis (m) — flask reads as a sphere. */
  height: number;
  /** True to render a sphere (He-3 flask) instead of a cylinder. */
  flask: boolean;
}
const HOPPER_ITEM_SHAPE: Readonly<Record<HeistMoonCargoType, HopperCargoShape>> = {
  WATER_CRYO_CELL: { diameter: 0.3, height: 0.34, flask: false },
  LOX_CYLINDER: { diameter: 0.22, height: 0.44, flask: false },
  HE3_FLASK: { diameter: 0.24, height: 0.24, flask: true },
};

/** A plain {x, y, z} triple (physics frame unless stated otherwise). */
type HopperVec3 = { x: number; y: number; z: number };

/** Lifecycle of one tracked hopper canister (Spec 36 §2.2). */
export type BuggyCargoItemState = 'INBOUND' | 'LATCHED';

/** Public snapshot of one canister tracked by the hopper. */
export interface BuggyCargoItem {
  /** Monotonic per-hopper id. */
  id: number;
  /** Moon-volatile container identity (Spec 36 §3.1). */
  type: HeistMoonCargoType;
  /** Human-readable container label. */
  label: string;
  /** Full container mass (kg), from the canonical cargo table. */
  massKg: number;
  /** Inbound (integrating through the attractor) or hard-latched. */
  state: BuggyCargoItemState;
  /** Occupied 2×3 grid slot 0..5; −1 while inbound. */
  slot: number;
  /** Latched mesh offset in the Babylon model frame (x left, y up, z nose). */
  localOffset: HopperVec3;
  /** Live world-frame centre (m); rest pose once latched. */
  position: HopperVec3;
}

/** One evaluation of the magnetic attractor field (Spec 36 §2.2). */
export interface HopperCaptureField {
  /** Slant distance from the canister to the bed centre (m). */
  distanceToBedCentreM: number;
  /** ‖v_cargo − v_buggy‖ (m/s). */
  relativeSpeedMps: number;
  /** True when inside R_catch AND under the relative-velocity ceiling. */
  withinCatchEnvelope: boolean;
  /** True when inside the hard physical bed bounding envelope. */
  insideBedBounds: boolean;
  /**
   * F_mag = −k_mag·r̂ − c_damp·(v_cargo − v_buggy) in the world frame (N);
   * zero outside the capture envelope.
   */
  force: HopperVec3;
}

/** Wiring for {@link BuggyCargoHopper}; all hooks optional except owner. */
export interface BuggyCargoHopperOptions {
  /** Procedural mesh factory for a latched canister (null when sceneless). */
  createItemMesh?: (type: HeistMoonCargoType, slot: number, offset: HopperVec3) => Mesh | null;
  /** Disposer for hopper meshes (defaults to `mesh.dispose()`). */
  disposeItemMesh?: (mesh: Mesh) => void;
  /** Mass bookkeeping: apply ±kg to the buggy (inertia + suspension). */
  applyMassDelta?: (deltaKg: number) => void;
  /** Fired after a canister hard-latches into the bed. */
  onLatch?: (item: BuggyCargoItem) => void;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Quaternion rotating local +y onto the (normalised) direction `dir`, with
 * the parallel/antiparallel edge cases handled explicitly. Babylon 9 ships
 * `Quaternion.FromUnitVectorsToRef`; the degenerate fallbacks keep build and
 * sync branch-free of NaNs for vertical members.
 */
function alignYTo(dir: Vector3, out: Quaternion): void {
  if (1 - dir.y < 1e-9) {
    out.set(0, 0, 0, 1);
  } else if (1 + dir.y < 1e-9) {
    // +y → −y: half-turn about any perpendicular axis (x here).
    Quaternion.RotationAxisToRef(AXIS_X, Math.PI, out);
  } else {
    Quaternion.FromUnitVectorsToRef(AXIS_Y, dir, out);
  }
}

/** Structural view of `LunarBuggy` covering the module's mount helpers. */
interface BuggySeatAccess {
  setStateFromMount?: (vLong: number, vLat: number) => void;
  setStateParked?: () => void;
}

/** Anything duck-typed that can report a physics-frame position. */
type MountCandidate = {
  getPosition?: () => { x: number; y: number; z: number };
  getState?: () => { x?: number; y?: number; z?: number; vx?: number; vy?: number };
  x?: number;
  y?: number;
  z?: number;
};

export class OpenBuggy {
  /** The single source of truth for buggy motion. Never duplicated. */
  readonly physics: LunarBuggy;

  private readonly prefix: string;
  private readonly ground: GroundElevationFn;

  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;

  private root: TransformNode | null = null;
  private chassisBody: TransformNode | null = null;
  private chassis: Mesh | null = null;
  private parts: Mesh[] = [];
  private wheels: Mesh[] = [];
  private cornerPivots: TransformNode[] = [];
  /** Front steering knuckles, uprights index 0 = FL, 1 = FR (Spec 17 §4.2). */
  private steeringKnuckles: (TransformNode | Mesh)[] = [];
  /** Coilover spring bodies (index = wheel slot) — compress with heave. */
  private coilovers: Mesh[] = [];
  /** Damper rods telescoping out of each coilover body. */
  private damperRods: Mesh[] = [];
  /** Steering tie-rods: [left, right] front corners (Spec 17 §4.2). */
  private tieRods: Mesh[] = [];
  /** Nominal tie-rod chord (m) at straight-ahead rest geometry. */
  private tieRodRestLen = 1;
  /** Live telemetry dash texture (speed/power segment bars). */
  private dashTexture: RawTexture | null = null;
  private dashPixels: Uint8Array | null = null;
  private cargoCrates: Mesh | null = null;
  private taillights: Mesh | null = null;
  private taillightMaterial: PBRMaterial | null = null;
  /**
   * Spec 36 Phase 3: flatbed magnetic cargo hopper (lazily constructed —
   * bookkeeping works sceneless, meshes appear once the rover is built).
   */
  private hopper: BuggyCargoHopper | null = null;
  /** Per-cargo-type PBR materials for the bed stack (created on demand). */
  private hopperMaterials: Partial<Record<HeistMoonCargoType, PBRMaterial>> = {};

  // -- Spec 37 Phase 2: modular upgrade attachments ---------------------------
  /** Installed tier per tree (drives which attachments are mounted). */
  private installed: InstalledUpgrades = defaultInstalledUpgrades();
  /** Compounded stats of the current build (cargo ceiling, visuals, Phase 3). */
  private stats: BuggyStats = calculateBuggyStats();
  /**
   * Procedural upgrade attachment meshes. Deliberately kept OUT of
   * `this.parts` (own bookkeeping + own dispose, like the Spec 23 beam
   * cones) so the stock 69-mesh contract and picking contracts hold; the
   * readback surface is {@link getUpgradeMeshes}.
   */
  private upgradeParts: Mesh[] = [];
  /** Dedicated PBR materials for upgrade attachments (disposed with entity). */
  private upgradeMaterials: PBRMaterial[] = [];
  /** Dedicated unlit/blend materials (holo webbing, plume sprites). */
  private upgradeBlendMaterials: StandardMaterial[] = [];
  /** Textures owned by upgrade attachments (particle sprite spritesheet). */
  private upgradeTextures: RawTexture[] = [];
  /** Tier-4 RCS cold-gas plume emitters (one per chassis corner). */
  private rcsPlumes: ParticleSystem[] = [];
  /** Transform nodes owned by upgrade attachments (plume emitter anchors). */
  private upgradeNodes: TransformNode[] = [];
  /** Pulsing electromagnetic cargo-net material (Tier 3, animated per frame). */
  private magNetMaterial: StandardMaterial | null = null;
  /** Four wheel-hub meshes (index = wheel slot) — cyan hub-cap attach points. */
  private wheelHubs: Mesh[] = [];
  /** Four coilover top-mount nodes (index = wheel slot) — nitro canister mounts. */
  private coilMounts: TransformNode[] = [];
  private lamps: SpotLight[] = [];
  /**
   * Spec 23 §2.4.2 / ADR-023-4: procedural translucent light cones drifting
   * from each headlight lightbar, simulating forward scattering against
   * photoelectrically-charged levitating lunar dust. Additive-blend
   * StandardMaterial shells; parented to the chassis body so they ride the
   * pitch/yaw/roll kinematics, with their per-frame aim recomputed alongside
   * the SpotLights in `applyLamps()`. NullEngine-safe (no DOM, no GPU-only
   * effects) and disposed with the entity.
   */
  private beamCones: Mesh[] = [];
  /** Stage-2 hyper-piercing projector cones (index = lamp point 0/1). */
  private beamConesHigh: Mesh[] = [];
  private beamConeMaterial: StandardMaterial | null = null;
  private beamConeHighMaterial: StandardMaterial | null = null;
  private materials: PBRMaterial[] = [];
  /** Procedural textures owned by the entity (dash, carbon weave). */
  private ownedTextures: RawTexture[] = [];

  private lampOn: boolean;
  private mounted = false;
  private built = false;
  private disposed = false;
  /** Road-wheel spin phase (rad), integrated from `WheelState.spin`. */
  private wheelPhase = 0;
  /** Wall-clock seconds of synced visuals — drives Spec 37 pulse animations. */
  private visualTimeS = 0;
  /** Most recently stepped state — keeps getters honest across scene life. */
  private last: BuggyState;
  /** Previous cumulative motor energy (J) for the kW dash readout. */
  private lastMotorEnergyJ = 0;
  /** Last synced drivetrain output (kW), fed to telemetry between frames. */
  private lastPowerKw = 0;
  /**
   * Live quest/contractor dashboard snapshot (Spec 18 §6.3, ADR-18-3).
   * Partial updates merge into this; `drawDash` rasterizes it under the
   * existing speed/power segment bars every synced frame.
   */
  private questDash: Required<
    Pick<
      BuggyDashView,
      'questActive' | 'questTitle' | 'objectiveText' | 'targetDistanceM' | 'targetBearingDeg' | 'cargoKg' | 'maxCargoKg' | 'faction' | 'linkStatus'
    >
  > = {
    questActive: false,
    questTitle: null,
    objectiveText: null,
    targetDistanceM: null,
    targetBearingDeg: null,
    cargoKg: 0,
    maxCargoKg: BUGGY_MAX_CARGO,
    faction: null,
    linkStatus: null,
  };

  /** Scratch objects for the per-frame lamp maths (no GC churn). */
  private readonly scratchAim = new Vector3(1, 0, 0);
  private readonly scratchPoint = new Vector3();
  /** Half-length beam offset for the Spec 23 volumetric cone shells. */
  private readonly scratchBeamOffset = new Vector3();
  private readonly scratchSpin = new Quaternion();
  /** Scratch for coilover/tie-rod articulation (no GC churn). */
  private readonly scratchDir = new Vector3();
  private readonly scratchQuat = new Quaternion();

  constructor(options: OpenBuggyOptions = {}) {
    this.prefix = options.namePrefix ?? 'buggy';
    this.ground = options.groundElevation ?? (() => 0);
    this.physics = new LunarBuggy(
      {
        chassisMass: options.chassisMass,
        groundElevation: this.ground,
        initialCargo: options.initialCargo,
        batteryKwh: options.batteryKwh,
      },
      { x: options.x, y: options.y, heading: options.heading },
    );
    this.last = this.physics.getState();
    this.lastMotorEnergyJ = this.last.motorEnergyJ;
    this.lampOn = options.headlights ?? true;
  }

  // -- lifecycle ---------------------------------------------------------------

  /**
   * Build the rover. Accepts an existing `Scene`, a raw engine (a scene is
   * created around it), or nothing — falling back to a self-owned
   * `NullEngine`, exactly what CI wants. Idempotent.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('OpenBuggy: init() after dispose()');
    if (this.built) return this;

    if (sceneOrEngine instanceof Scene) {
      this.scene = sceneOrEngine;
    } else if (sceneOrEngine !== null && sceneOrEngine !== undefined) {
      // Bare engine (typically a shared NullEngine): wrap it, never own it.
      this.scene = new Scene(sceneOrEngine);
    } else if (typeof window === 'undefined') {
      const engine = new NullEngine();
      this.ownedEngine = engine;
      this.scene = new Scene(engine);
    } else {
      throw new Error('OpenBuggy.init: browser needs a Scene or Engine');
    }

    this.buildRover(this.scene);
    this.built = true;
    this.syncTransform(this.last, 0);
    // Spec 36 Phase 3: canisters that latched before/without a scene get
    // their bed meshes now that the chassis hierarchy exists.
    this.hopper?.rebuildMeshes();
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /**
   * Advance one frame: step the owned physics buggy, then sync the chassis
   * transform, wheels, suspension, tie-rods, dash and headlights from the
   * result. Performs no integration of its own and mutates no input. Safe
   * after `dispose()` (physics-only — keeps stepping, still returns finite
   * state).
   *
   * @param dt    seconds since last frame (`LunarBuggy` sub-steps/clamps it)
   * @param input this frame's drive input (idle with park brake if omitted)
   * @returns a copy of the post-step `BuggyState`
   */
  update(dt: number, input: BuggyInput = IDLE_BUGGY_INPUT): BuggyState {
    const state = this.physics.step(dt, input);
    this.last = state;
    // Spec 36 Phase 3: inbound hopper canisters integrate against the
    // freshly stepped chassis pose/velocity before visuals sync.
    if (this.hopper !== null && !this.disposed) this.hopper.step(dt);
    if (this.built && !this.disposed) this.syncTransform(state, dt);
    return { ...state };
  }

  /** Tear down rover nodes, lights, materials and any self-owned engine. Never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;
    this.mounted = false;

    // Spec 36 Phase 3: drop the hopper (bed canister meshes + bookkeeping)
    // before tearing down the chassis body the canisters parent to.
    if (this.hopper !== null) {
      this.hopper.dispose();
      this.hopper = null;
    }
    this.hopperMaterials = {};

    // Spec 37 Phase 2: tear the upgrade attachments down with the entity —
    // root/physics are dropped below, attachments never survive a dispose.
    this.disposeUpgradeVisuals();

    for (const lamp of this.lamps) OpenBuggy.disposeQuietly(lamp);
    this.lamps = [];
    // Spec 23 §2.4.2: volumetric cone shells ride their own bookkeeping —
    // dispose them with the entity so a re-init starts from a clean scene.
    for (const cone of this.beamCones) OpenBuggy.disposeQuietly(cone);
    this.beamCones = [];
    for (const cone of this.beamConesHigh) OpenBuggy.disposeQuietly(cone);
    this.beamConesHigh = [];
    OpenBuggy.disposeQuietly(this.beamConeMaterial);
    this.beamConeMaterial = null;
    OpenBuggy.disposeQuietly(this.beamConeHighMaterial);
    this.beamConeHighMaterial = null;
    for (const mesh of this.parts) OpenBuggy.disposeQuietly(mesh);
    this.parts = [];
    this.wheels = [];
    this.chassis = null;
    this.cargoCrates = null;
    this.taillights = null;
    this.taillightMaterial = null;
    for (const knuckle of this.steeringKnuckles) OpenBuggy.disposeQuietly(knuckle);
    this.steeringKnuckles = [];
    for (const pivot of this.cornerPivots) OpenBuggy.disposeQuietly(pivot);
    this.cornerPivots = [];
    for (const tex of this.ownedTextures) OpenBuggy.disposeQuietly(tex);
    this.ownedTextures = [];
    this.dashTexture = null;
    this.dashPixels = null;
    this.coilovers = [];
    this.damperRods = [];
    this.tieRods = [];
    OpenBuggy.disposeQuietly(this.chassisBody);
    this.chassisBody = null;
    for (const material of this.materials) OpenBuggy.disposeQuietly(material);
    this.materials = [];
    OpenBuggy.disposeQuietly(this.root);
    this.root = null;

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) OpenBuggy.disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- accessors -----------------------------------------------------------------

  /** The owned physics buggy — advance it through `update()`, not directly. */
  getPhysics(): LunarBuggy {
    return this.physics;
  }

  /** Root transform node of the rover (null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every rover mesh (for shadow casters / picking registration). */
  getMeshes(): Mesh[] {
    return [...this.parts];
  }

  /** The two headlight SpotLights (empty before init / after dispose). */
  getHeadlights(): SpotLight[] {
    return [...this.lamps];
  }

  /**
   * All volumetric dust-scattering beam shells — `[lowL, lowR, highL, highR]`
   * (empty before init / after dispose). Spec 23 §2.4.2 readback for headless
   * harnesses: assert additive blend (`alphaMode === Engine.ALPHA_ADD`),
   * non-zero alpha, and that the shells track the chassis pose frame to frame.
   */
  getBeamCones(): Mesh[] {
    return [...this.beamCones, ...this.beamConesHigh];
  }

  /**
   * Coilover spring bodies, one per wheel corner (index = wheel slot).
   * Their local `scaling.y` tracks suspension compression — longer toward
   * droop, shorter at the bump stop (Spec 17 §4.2, `coilScaleFor`).
   */
  getCoilovers(): Mesh[] {
    return [...this.coilovers];
  }

  /** Damper rods telescoping from each coilover body (`rodScaleFor`). */
  getDamperRods(): Mesh[] {
    return [...this.damperRods];
  }

  /** The two steering tie-rods `[left, right]` (Spec 17 §4.2). Their
   *  position, aim and stretch follow the Ackermann front-knuckle yaw and
   *  suspension heave live, every synced frame. */
  getTieRods(): Mesh[] {
    return [...this.tieRods];
  }

  /** Front steering knuckles `[FL, FR]` (uprights that carry steer yaw). */
  getSteeringKnuckles(): Array<TransformNode | Mesh> {
    return [...this.steeringKnuckles];
  }

  /** Chassis datum in the **physics** frame (x, y lateral; z = elevation). */
  getPosition(): { x: number; y: number; z: number } {
    const s = this.last;
    return { x: s.x, y: s.y, z: s.z };
  }

  /** Chassis datum in Babylon's y-up frame, via the shared converter. */
  getBabylonPosition(): Vector3 {
    return worldToBabylon(this.last);
  }

  /** Heading, radians in the x-y plane (0 = +x). */
  getHeading(): number {
    return this.last.heading;
  }

  /** Babylon azimuth matching the shared heading mapping: PI/2 + heading. */
  getBabylonYaw(): number {
    return Math.PI / 2 + this.last.heading;
  }

  /** Nose-up chassis attitude, radians. */
  getPitch(): number {
    return this.last.pitch;
  }

  /** Roll attitude, radians (+ = left side up). */
  getRoll(): number {
    return this.last.roll;
  }

  /** Road speed |vLong|, m/s. */
  getSpeed(): number {
    return Math.abs(this.last.vLong);
  }

  /**
   * Body-frame longitudinal velocity (m/s, + forward). Spec 17 §2.4.2 feeds
   * this (with `getVLat()`) to the chase camera's velocity-vector lookahead.
   */
  getVLong(): number {
    return this.last.vLong;
  }

  /** Body-frame lateral velocity (m/s, + left). Zero while traction holds. */
  getVLat(): number {
    return this.last.vLat;
  }

  /** Body-frame velocity pair for the chase-cam lookahead (spec 17 §2.4.2). */
  getVelocity(): { vLong: number; vLat: number } {
    return { vLong: this.last.vLong, vLat: this.last.vLat };
  }

  /** Traction battery remaining, kWh. */
  getBattery(): number {
    return this.last.batteryKwh;
  }

  /** Traction pack ceiling, kWh (grows with the Spec 21 §2.4 fuel cell). */
  getBatteryCapacity(): number {
    return this.physics.getBatteryCapacity();
  }

  /**
   * Spec 21 §2.4 vault loot: fit an auxiliary fuel cell (+`extraKwh` to the
   * pack ceiling, charge restored to 100 %). Returns the new capacity.
   */
  upgradeFuelCell(extraKwh = 15): number {
    const cap = this.physics.upgradeBatteryCapacity(extraKwh);
    // The physics pack was mutated in place (capacity + full charge) — pull
    // the mirror so `getBattery()`/telemetry read the restored pack NOW,
    // not the stale pre-upgrade frame (Spec 21 §2.4).
    this.last = this.physics.getState();
    return cap;
  }

  /** Full physics state copy. */
  getState(): BuggyState {
    return this.physics.getState();
  }

  /** World-frame point at (forward, left, up) metres from the chassis datum. */
  pointAt(forward: number, lateral = 0, up = 0): { x: number; y: number; z: number } {
    const s = this.last;
    const h = s.heading;
    const x = s.x + forward * Math.cos(h) - lateral * Math.sin(h);
    const y = s.y + forward * Math.sin(h) + lateral * Math.cos(h);
    // Round trip through the shared converters so callers land in exactly the
    // frame CameraRig/WorldScene render in, whatever the mapping becomes.
    return babylonToWorld(worldToBabylon({ x, y, z: s.z + up }));
  }

  /** Consolidated telemetry for the HUD. */
  getTelemetry(): OpenBuggyTelemetry {
    const s = this.last;
    let compression = 0;
    for (const wheel of s.wheels) compression += wheel.compression;
    compression /= s.wheels.length;
    return {
      speed: Math.abs(s.vLong),
      vLong: s.vLong,
      heading: s.heading,
      pitch: s.pitch,
      roll: s.roll,
      battery: s.batteryKwh,
      batteryFraction: clamp(s.batteryKwh / this.physics.getBatteryCapacity(), 0, 1),
      cargoMass: s.cargoMass,
      cargoFraction: this.getCargoMassFraction(),
      totalMass: this.physics.totalMass,
      rideHeight: s.bodyHeight,
      suspensionCompression: compression,
      powerKw: this.instantPowerKw(),
      isGrounded: !s.airborne,
      airborne: s.airborne,
      rolled: s.rolled,
      headlightsOn: this.lampOn,
      mounted: this.mounted,
    };
  }

  // -- headlights ------------------------------------------------------------------

  /**
   * Switch the headlights: `setHeadlights(true|false)` forces, a bare call
   * toggles. Returns the state now in force. Safe before `init()`, after
   * `dispose()`, and idempotent.
   */
  setHeadlights(on?: boolean): boolean {
    this.lampOn = on === undefined ? !this.lampOn : on;
    if (this.built && !this.disposed) this.applyLamps(this.last);
    return this.lampOn;
  }

  /** Headlight state, independent of scene lifetime. */
  isHeadlightsOn(): boolean {
    return this.lampOn;
  }

  // -- cargo -----------------------------------------------------------------------

  /**
   * Set the absolute mineral load aboard (kg); the physics module clamps to
   * `[0, BUGGY_MAX_CARGO]`. Returns the cargo mass now on the flatbed so
   * callers can watch the clamp land. Cargo raises the CoG and scales the
   * effective inertia entirely inside `LunarBuggy` — nothing is re-derived
   * here.
   */
  setCargoMass(kg: number): number {
    if (this.disposed || !Number.isFinite(kg)) return this.getCargoMass();
    const current = this.physics.getState().cargoMass;
    const delta = kg - current;
    if (delta === 0) return current;
    return this.physics.loadCargo(delta);
  }

  /** Mineral load aboard (kg). */
  getCargoMass(): number {
    return this.physics.getState().cargoMass;
  }

  /** Load fraction 0..1 of `BUGGY_MAX_CARGO`. */
  getCargoMassFraction(): number {
    return clamp(this.getCargoMass() / BUGGY_MAX_CARGO, 0, 1);
  }

  /** Flatbed ceiling, kg (spec 19 §2.3: 500). */
  getCargoCapacity(): number {
    return BUGGY_MAX_CARGO;
  }

  /** True when `amountKg` more would still fit on the flatbed. */
  canAcceptCargo(amountKg: number): boolean {
    if (!Number.isFinite(amountKg) || amountKg <= 0) return false;
    return this.getCargoMass() + amountKg <= BUGGY_MAX_CARGO + 1e-9;
  }

  /**
   * Add ore to the flatbed through the physics loader (capped at
   * `BUGGY_MAX_CARGO`). Returns the kilograms actually taken aboard.
   */
  addCargo(amountKg: number): number {
    if (this.disposed || !Number.isFinite(amountKg) || amountKg <= 0) return 0;
    const before = this.getCargoMass();
    this.setCargoMass(before + amountKg);
    return this.getCargoMass() - before;
  }

  // -- Spec 36 Phase 3: flatbed magnetic cargo hopper -------------------------

  /**
   * The flatbed cargo hopper: magnetic catch envelope, 2×3 physical
   * stacking grid and caught-mass bookkeeping (Spec 36 §2.2/§3 Phase 3).
   * Lazily constructed; null after `dispose()`.
   */
  getCargoHopper(): BuggyCargoHopper | null {
    if (this.disposed) return null;
    if (this.hopper === null) {
      this.hopper = new BuggyCargoHopper(this, {
        createItemMesh: (type, slot, offset) => this.buildHopperItemMesh(type, slot, offset),
        disposeItemMesh: (mesh) => OpenBuggy.disposeQuietly(mesh),
        applyMassDelta: (deltaKg) => {
          // Route caught mass through the physics cargo loader so inertia
          // and suspension compression follow (M_total = M_chassis + ΣM).
          this.physics.loadCargo(deltaKg);
          this.last = this.physics.getState();
        },
      });
      // Spec 37 Phase 2: a Tier-2+ flatbed build starts with 12 slots.
      this.hopper.setCapacity(this.stats.canisterCapacity);
    }
    return this.hopper;
  }

  /** Convenience: hard-latch a moon-cargo canister into the hopper bed
   *  (what the moving-frame capture arbiter does on a clean throw). */
  addHopperCargo(type: HeistMoonCargoType): BuggyCargoItem | null {
    return this.getCargoHopper()?.addCargo(type) ?? null;
  }

  /** Convenience: unload every canister from the hopper bed. */
  clearHopperCargo(): void {
    this.hopper?.clearCargo();
  }

  /** Convenience: snapshots of the tracked hopper canisters. */
  getHopperCargoItems(): BuggyCargoItem[] {
    return this.hopper?.getCargoItems() ?? [];
  }

  /** Convenience: latched hopper cargo mass aboard (kg). */
  getHopperCargoMassKg(): number {
    return this.hopper?.getCargoMassKg() ?? 0;
  }

  /**
   * Procedural PBR container mesh for a latched hopper canister: cylinder
   * silhouettes for the water cryo-cell and LOX cylinder, a sphere for the
   * He-3 flask, each in its cargo-type material, parented to the chassis
   * body and positioned on the 2×3 stacking grid. Null when the rover has
   * no scene yet (bookkeeping still proceeds; `rebuildMeshes()` catches up).
   */
  private buildHopperItemMesh(
    type: HeistMoonCargoType,
    slot: number,
    offset: { x: number; y: number; z: number },
  ): Mesh | null {
    if (this.disposed || !this.built || this.scene === null || this.scene.isDisposed) return null;
    const shape = HOPPER_ITEM_SHAPE[type];
    const name = `${this.prefix}-hopper-cargo-${slot}-${type.toLowerCase()}`;
    const mesh = shape.flask
      ? MeshBuilder.CreateSphere(name, { diameter: shape.diameter, segments: 12 }, this.scene)
      : MeshBuilder.CreateCylinder(
          name,
          { diameter: shape.diameter, height: shape.height, tessellation: 14 },
          this.scene,
        );
    mesh.material = this.hopperMaterial(type);
    mesh.parent = this.chassisBody;
    mesh.position.set(offset.x, offset.y, offset.z);
    mesh.isPickable = true;
    mesh.receiveShadows = false;
    return mesh;
  }

  /**
   * Cargo-type PBR palette (Spec 36 §3 Phase 3): translucent ice-blue for
   * water cryo-cells, frosted white metal for LOX cylinders, emissive
   * amber for the enriched He-3 flasks. Created once per entity and
   * disposed with the rest of the material set.
   */
  private hopperMaterial(type: HeistMoonCargoType): PBRMaterial {
    const existing = this.hopperMaterials[type];
    if (existing !== undefined && this.materials.includes(existing)) return existing;
    const scene = this.scene;
    if (scene === null || scene.isDisposed) {
      throw new Error('OpenBuggy.hopperMaterial: no scene — call init() first');
    }
    const mat = new PBRMaterial(`${this.prefix}-hopper-${type.toLowerCase()}-mat`, scene);
    switch (type) {
      case 'WATER_CRYO_CELL':
        mat.albedoColor = new Color3(0.55, 0.82, 0.95); // pressurized ice blue
        mat.emissiveColor = new Color3(0.04, 0.1, 0.18);
        mat.metallic = 0.15;
        mat.roughness = 0.18;
        break;
      case 'LOX_CYLINDER':
        mat.albedoColor = new Color3(0.88, 0.9, 0.92); // frosted white bottle
        mat.emissiveColor = new Color3(0.02, 0.03, 0.04);
        mat.metallic = 0.65;
        mat.roughness = 0.3;
        break;
      case 'HE3_FLASK':
        mat.albedoColor = new Color3(0.95, 0.75, 0.25); // glowing enriched amber
        mat.emissiveColor = new Color3(0.55, 0.32, 0.05);
        mat.metallic = 0.3;
        mat.roughness = 0.25;
        break;
    }
    mat.environmentIntensity = 0.05;
    this.hopperMaterials[type] = mat;
    this.materials.push(mat);
    return mat;
  }

  // -- Spec 37 Phase 2: dynamic 3D mesh attachments & visual upgrades ----------

  /**
   * Install a modular upgrade build (Spec 37 §3 Phase 2). Recomputes the
   * compounded stats, raises the hopper slot ceiling (6 → 12 with the
   * Tier-2 flatbed) and re-mounts the procedural 3D attachments live on the
   * existing chassis hierarchy — the physics root is never rebuilt and the
   * rover's motion is untouched. Idempotent: applying the same build twice
   * churns nothing user-visible beyond a visual refresh.
   *
   * Scene-less safe: before `init()` the build is recorded (attachments are
   * mounted by `buildRover`); after `dispose()` it stays bookkeeping-only.
   *
   * @throws Error when `installed` is not a valid {@link InstalledUpgrades}.
   */
  applyUpgrades(installed: InstalledUpgrades): BuggyStats {
    if (!validateInstalledShape(installed)) {
      throw new Error('OpenBuggy.applyUpgrades: invalid InstalledUpgrades shape.');
    }
    this.installed = { ...installed };
    this.stats = calculateBuggyStats(this.installed);
    if (this.hopper !== null) this.hopper.setCapacity(this.stats.canisterCapacity);
    if (this.built && !this.disposed) this.applyUpgradeVisuals();
    return { ...this.stats };
  }

  /** Copy of the installed upgrade tiers driving the current attachments. */
  getInstalledUpgrades(): InstalledUpgrades {
    return { ...this.installed };
  }

  /** Copy of the compounded physical stats of the current build. */
  getUpgradeStats(): BuggyStats {
    return { ...this.stats };
  }

  /**
   * Procedural upgrade attachment meshes (empty for a stock Tier-1 build or
   * after `dispose()`). Kept out of {@link getMeshes} so the stock 69-mesh
   * contract holds; this is the headless readback for Spec 37 harnesses.
   */
  getUpgradeMeshes(): Mesh[] {
    return [...this.upgradeParts];
  }

  /** Tier-4 RCS plume particle systems (empty unless suspension Tier 4). */
  getRcsPlumes(): ParticleSystem[] {
    return [...this.rcsPlumes];
  }

  /**
   * Rebuild every active mesh attachment from `this.installed`. Disposes
   * only the tracked attachment set — never the root, wheels, suspension or
   * materials of the base rover — then re-creates what the current tiers
   * require. Gracefully no-ops with no scene (NullEngine headless runs
   * simply keep bookkeeping state).
   */
  private applyUpgradeVisuals(): void {
    this.disposeUpgradeVisuals();
    const scene = this.scene;
    // Runs from buildRover() before `built` flips — the live scene + chassis
    // hierarchy are the real precondition, not the built flag.
    if (this.disposed || scene === null || scene.isDisposed || this.chassisBody === null) {
      return;
    }
    this.buildCargoBedUpgrades(scene);
    this.buildPowertrainUpgrades(scene);
    this.buildSuspensionUpgrades(scene);
    this.buildMiningUpgrades(scene);
  }

  /** Tear down every tracked upgrade attachment, material, texture, node. */
  private disposeUpgradeVisuals(): void {
    for (const ps of this.rcsPlumes) {
      try {
        ps.dispose();
      } catch {
        // Engine torn down first — never propagate.
      }
    }
    this.rcsPlumes = [];
    for (const mesh of this.upgradeParts) OpenBuggy.disposeQuietly(mesh);
    this.upgradeParts = [];
    for (const node of this.upgradeNodes) OpenBuggy.disposeQuietly(node);
    this.upgradeNodes = [];
    for (const mat of this.upgradeMaterials) OpenBuggy.disposeQuietly(mat);
    this.upgradeMaterials = [];
    for (const mat of this.upgradeBlendMaterials) OpenBuggy.disposeQuietly(mat);
    this.upgradeBlendMaterials = [];
    for (const tex of this.upgradeTextures) OpenBuggy.disposeQuietly(tex);
    this.upgradeTextures = [];
    this.magNetMaterial = null;
  }

  /** Register an upgrade attachment mesh: material + chassis-body parent +
   *  bookkeeping (kept OUT of `this.parts`, see {@link getUpgradeMeshes}). */
  private upgradePart(mesh: Mesh, mat: PBRMaterial | StandardMaterial): Mesh {
    mesh.material = mat;
    mesh.parent = this.chassisBody;
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    this.upgradeParts.push(mesh);
    return mesh;
  }

  /** Chassis-local upgrade tube between two points (same solve as §4 tubes). */
  private upgradeTube(
    scene: Scene,
    name: string,
    from: readonly [number, number, number],
    to: readonly [number, number, number],
    mat: PBRMaterial,
    diameter: number = GEO.tube.diameter,
  ): Mesh {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz);
    this.scratchDir.set(dx, dy, dz).normalize();
    alignYTo(this.scratchDir, this.scratchQuat);
    const rod = MeshBuilder.CreateCylinder(name, { diameter, height: len, tessellation: 10 }, scene);
    rod.rotationQuaternion = this.scratchQuat.clone();
    rod.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2);
    return this.upgradePart(rod, mat);
  }

  /** On-demand PBR material for an upgrade component (disposed with set). */
  private upgradePbrMaterial(
    name: string,
    albedo: Color3,
    metallic: number,
    roughness: number,
    emissive?: Color3,
  ): PBRMaterial {
    const scene = this.scene;
    if (scene === null || scene.isDisposed) {
      throw new Error('OpenBuggy.upgradePbrMaterial: no scene — call init() first');
    }
    const mat = new PBRMaterial(name, scene);
    mat.albedoColor = albedo;
    mat.metallic = metallic;
    mat.roughness = roughness;
    if (emissive !== undefined) mat.emissiveColor = emissive;
    mat.environmentIntensity = 0.05;
    this.upgradeMaterials.push(mat);
    return mat;
  }

  /**
   * `cargo_bed` tree (Spec 37 §2.1):
   * Tier 2+: extended rear flatbed subframe (+0.6 m splice), double-tiered
   * side rails and the upper cargo deck serving the 12-slot stack.
   * Tier 3: pulsing blue holographic energy webbing over the bed (the
   * electromagnetic cargo net — alpha-animated in `animateUpgradeVisuals`).
   * Tier 4: rear tractor-beam emitter gantry with projector head.
   */
  private buildCargoBedUpgrades(scene: Scene): void {
    const p = this.prefix;
    const tier = this.installed.cargo_bed;
    if (tier < 2) return;

    const ext =
      this.stats.subframeExtensionM > 0 ? this.stats.subframeExtensionM : UPGRADE_SUBFRAME_EXTENSION_M;
    const rearZ = REAR_FRAME_Z - ext;
    const midZ = (REAR_FRAME_Z + rearZ) / 2;

    const alu = this.upgradePbrMaterial(`${p}-up-freight-alu`, new Color3(0.72, 0.74, 0.78), 0.9, 0.35);
    const railMat = this.upgradePbrMaterial(`${p}-up-freight-rail`, new Color3(0.82, 0.6, 0.12), 0.4, 0.5);

    // -- Tier 2: extended rear flatbed subframe ----------------------------
    this.upgradePart(
      MeshBuilder.CreateBox(`${p}-up-flatbed-deck`, { width: 1.46, height: 0.07, depth: ext + 0.08 }, scene),
      alu,
    ).position.set(0, 0.245, midZ - 0.02);
    for (const side of [1, -1] as const) {
      const tag = side > 0 ? 'l' : 'r';
      this.upgradePart(
        MeshBuilder.CreateBox(`${p}-up-subframe-beam-${tag}`, { width: 0.08, height: 0.1, depth: ext }, scene),
        alu,
      ).position.set(side * 0.6, 0.12, midZ);
      // Double-tiered side rails: lower + upper rails with rear stanchions.
      this.upgradeTube(scene, `${p}-up-side-rail-lower-${tag}`, [side * SIDE_RAIL_X, 0.44, -0.08], [side * SIDE_RAIL_X, 0.44, rearZ + 0.02], railMat, 0.055);
      this.upgradeTube(scene, `${p}-up-side-rail-upper-${tag}`, [side * SIDE_RAIL_X, 0.9, -0.08], [side * SIDE_RAIL_X, 0.9, rearZ + 0.02], railMat, 0.055);
      this.upgradeTube(scene, `${p}-up-rail-stanchion-${tag}`, [side * SIDE_RAIL_X, 0.44, rearZ + 0.04], [side * SIDE_RAIL_X, 0.9, rearZ + 0.04], railMat, 0.05);
    }
    // Upper cargo deck for slots 6..11 of the double-tier stack.
    if (this.stats.canisterCapacity > HOPPER_CAPACITY) {
      this.upgradePart(
        MeshBuilder.CreateBox(`${p}-up-upper-deck`, { width: 1.34, height: 0.04, depth: 1.46 }, scene),
        alu,
      ).position.set(0, HOPPER_BED_FLOOR_Y + HOPPER_UPPER_DECK_Y - 0.02, -0.65);
    }

    // -- Tier 3: electromagnetic cargo net (pulsing holo webbing) -----------
    if (tier >= 3) {
      const netLen = rearZ - -0.05;
      const net = MeshBuilder.CreateBox(
        `${p}-up-mag-net`,
        { width: 1.36, height: 0.62, depth: Math.abs(netLen) },
        scene,
      );
      const holo = new StandardMaterial(`${p}-up-mag-net-mat`, scene);
      holo.disableLighting = true;
      holo.emissiveColor = new Color3(0.22, 0.55, 1.0); // Spec 37: pulsing blue
      holo.diffuseColor = new Color3(0, 0, 0);
      holo.specularColor = new Color3(0, 0, 0);
      holo.alpha = 0.12;
      holo.alphaMode = Engine.ALPHA_ADD;
      holo.backFaceCulling = false;
      this.upgradeBlendMaterials.push(holo);
      this.magNetMaterial = holo;
      this.upgradePart(net, holo).position.set(0, 0.68, (-0.05 + rearZ) / 2);
    }

    // -- Tier 4: rear tractor-beam emitter gantry ---------------------------
    if (tier >= 4) {
      const gz = REAR_FRAME_Z - 0.45;
      const cyan = this.upgradePbrMaterial(
        `${p}-up-tractor-emissive`,
        new Color3(0.15, 0.85, 0.95),
        0.2,
        0.2,
        new Color3(0.05, 0.6, 0.7),
      );
      for (const side of [1, -1] as const) {
        const tag = side > 0 ? 'l' : 'r';
        this.upgradeTube(scene, `${p}-up-gantry-post-${tag}`, [side * 0.66, 0.26, gz], [side * 0.66, 1.24, gz - 0.06], railMat, 0.06);
      }
      this.upgradeTube(scene, `${p}-up-gantry-crossbar`, [-0.66, 1.24, gz - 0.06], [0.66, 1.24, gz - 0.06], railMat, 0.06);
      this.upgradePart(
        MeshBuilder.CreateCylinder(`${p}-up-tractor-housing`, { diameter: 0.24, height: 0.18, tessellation: 14 }, scene),
        alu,
      ).position.set(0, 1.12, gz - 0.06);
      this.upgradePart(
        MeshBuilder.CreateCylinder(`${p}-up-tractor-lens`, { diameter: 0.18, height: 0.04, tessellation: 14 }, scene),
        cyan,
      ).position.set(0, 1.02, gz - 0.06);
    }
  }

  /**
   * `powertrain` tree (Spec 37 §2.2): Tier 3+ quad hyper-induction drive
   * gets cyan emissive hub-motor caps on all four wheel hubs (parented to
   * the corner pivots so they follow steering yaw and suspension droop).
   */
  private buildPowertrainUpgrades(scene: Scene): void {
    if (this.installed.powertrain < 3) return;
    const p = this.prefix;
    const cyan = this.upgradePbrMaterial(
      `${p}-up-hubcap`,
      new Color3(0.1, 0.85, 0.95),
      0.45,
      0.25,
      new Color3(0.04, 0.55, 0.62),
    );
    for (let i = 0; i < WHEEL_SLOTS.length; i++) {
      const pivot = this.cornerPivots[i];
      if (pivot === undefined || pivot.isDisposed()) continue;
      const side = WHEEL_SLOTS[i]?.side ?? 1;
      const cap = MeshBuilder.CreateCylinder(
        `${p}-up-hubcap-${i}`,
        { diameter: 0.24, height: 0.045, tessellation: 16 },
        scene,
      );
      cap.rotation.set(0, 0, -Math.PI / 2);
      cap.material = cyan;
      cap.parent = pivot;
      cap.position.set(side * 0.195, 0, 0);
      cap.isPickable = false;
      cap.receiveShadows = false;
      this.upgradeParts.push(cap);
    }
  }

  /**
   * `suspension` tree (Spec 37 §2.3):
   * Tier 2+: anodized gold nitrogen reservoir canisters riding each
   * coilover strut (parented to the coilover mount node).
   * Tier 4: quad cold-gas RCS thruster nozzle cones on the four chassis
   * corners, each with a downward plume particle emitter.
   */
  private buildSuspensionUpgrades(scene: Scene): void {
    const p = this.prefix;
    const tier = this.installed.suspension;

    if (tier >= 2) {
      const gold = this.upgradePbrMaterial(
        `${p}-up-nitro-gold`,
        new Color3(0.95, 0.68, 0.14),
        0.85,
        0.28,
        new Color3(0.08, 0.04, 0.0),
      );
      const capMat = this.upgradePbrMaterial(`${p}-up-nitro-cap`, new Color3(0.15, 0.15, 0.16), 0.6, 0.4);
      for (let i = 0; i < this.coilMounts.length; i++) {
        const mount = this.coilMounts[i];
        if (mount === undefined || mount.isDisposed()) continue;
        const can = MeshBuilder.CreateCylinder(
          `${p}-up-nitro-canister-${i}`,
          { diameter: 0.09, height: 0.3, tessellation: 12 },
          scene,
        );
        can.material = gold;
        can.parent = mount;
        can.position.set(0.115, 0.27, 0);
        can.isPickable = false;
        this.upgradeParts.push(can);
        const cap = MeshBuilder.CreateCylinder(
          `${p}-up-nitro-canister-cap-${i}`,
          { diameter: 0.05, height: 0.06, tessellation: 10 },
          scene,
        );
        cap.material = capMat;
        cap.parent = mount;
        cap.position.set(0.115, 0.44, 0);
        cap.isPickable = false;
        this.upgradeParts.push(cap);
      }
    }

    if (tier >= 4) {
      const steel = this.upgradePbrMaterial(`${p}-up-rcs-steel`, new Color3(0.3, 0.32, 0.34), 0.9, 0.3);
      let k = 0;
      for (const zc of [GEO.wheel.axle, -GEO.wheel.axle]) {
        for (const side of [1, -1] as const) {
          // Nozzle cone: narrow inlet at the chassis, wide exit bell below.
          const nozzle = MeshBuilder.CreateCylinder(
            `${p}-up-rcs-nozzle-${k}`,
            { diameterTop: 0.06, diameterBottom: 0.18, height: 0.2, tessellation: 12 },
            scene,
          );
          this.upgradePart(nozzle, steel).position.set(side * 0.66, -0.02, zc);
          // Downward cold-gas plume emitter anchored under the nozzle bell.
          const anchor = new TransformNode(`${p}-up-rcs-emitter-${k}`, scene);
          anchor.parent = this.chassisBody;
          anchor.position.set(side * 0.66, -0.16, zc);
          this.upgradeNodes.push(anchor);
          this.buildRcsPlume(scene, k, anchor);
          k += 1;
        }
      }
    }
  }

  /** One cold-gas plume particle system (NullEngine-safe: failures degrade
   *  to "no plume" — the geometry and bookkeeping stay intact). */
  private buildRcsPlume(scene: Scene, index: number, anchor: TransformNode): void {
    try {
      const p = this.prefix;
      const sprite = this.plumeSpriteTexture(scene);
      const ps = new ParticleSystem(`${p}-up-rcs-plume-${index}`, 48, scene);
      ps.particleTexture = sprite;
      // Node emitters are supported at runtime; the CLI type union is narrow.
      ps.emitter = anchor as unknown as Mesh;
      ps.minEmitBox.set(-0.02, 0, -0.02);
      ps.maxEmitBox.set(0.02, 0, 0.02);
      ps.direction1 = new Vector3(-0.15, -1, -0.15);
      ps.direction2 = new Vector3(0.15, -1, 0.15);
      ps.color1 = new Color4(0.78, 0.9, 1.0, 0.85);
      ps.color2 = new Color4(0.35, 0.6, 1.0, 0.5);
      ps.colorDead = new Color4(0.2, 0.35, 0.6, 0);
      ps.minSize = 0.05;
      ps.maxSize = 0.16;
      ps.minLifeTime = 0.12;
      ps.maxLifeTime = 0.3;
      ps.emitRate = 48;
      ps.blendMode = ParticleSystem.BLENDMODE_ADD;
      ps.gravity.set(0, 0, 0);
      ps.start();
      this.rcsPlumes.push(ps);
    } catch {
      // Headless / restricted engine: plume is cosmetic, degrade silently.
    }
  }

  /** 16×16 soft radial white sprite for the RCS plumes (RawTexture, so it
   *  works under NullEngine with no DOM canvas). */
  private plumeSpriteTexture(scene: Scene): RawTexture {
    const S = 16;
    const px = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const d = Math.hypot(x - (S - 1) / 2, y - (S - 1) / 2) / ((S - 1) / 2);
        const a = Math.pow(clamp(1 - d, 0, 1), 1.5);
        px[i] = 255;
        px[i + 1] = 255;
        px[i + 2] = 255;
        px[i + 3] = Math.round(a * 255);
      }
    }
    const tex = new RawTexture(px, S, S, Engine.TEXTUREFORMAT_RGBA, scene, false);
    tex.hasAlpha = true;
    this.upgradeTextures.push(tex);
    return tex;
  }

  /**
   * `mining_suite` tree (Spec 37 §2.4):
   * Tier 2+: thermal resonance beam emitter mounted to the frontal bumper
   * (orange emissive projector barrel).
   * Tier 3: wide-swath regolith scoop array on the frontal bumper.
   * Tier 4: deep-core resonator — seismic emitter dish under the chassis.
   */
  private buildMiningUpgrades(scene: Scene): void {
    const p = this.prefix;
    const tier = this.installed.mining_suite;
    if (tier < 2) return;

    const steel = this.upgradePbrMaterial(`${p}-up-mining-steel`, new Color3(0.35, 0.37, 0.4), 0.85, 0.35);
    const thermal = this.upgradePbrMaterial(
      `${p}-up-thermal-emissive`,
      new Color3(0.95, 0.45, 0.1),
      0.3,
      0.3,
      new Color3(0.7, 0.18, 0.02),
    );

    // -- Tier 2: thermal resonance beam emitter on the front bumper --------
    this.upgradePart(
      MeshBuilder.CreateBox(`${p}-up-thermal-mount`, { width: 0.26, height: 0.14, depth: 0.14 }, scene),
      steel,
    ).position.set(0.36, 0.27, GEO.bumper.z - 0.02);
    const barrel = MeshBuilder.CreateCylinder(
      `${p}-up-thermal-barrel`,
      { diameter: 0.08, height: 0.4, tessellation: 12 },
      scene,
    );
    barrel.rotation.set(Math.PI / 2, 0, 0);
    this.upgradePart(barrel, steel).position.set(0.36, 0.27, GEO.bumper.z + 0.18);
    const tip = MeshBuilder.CreateCylinder(
      `${p}-up-thermal-tip`,
      { diameter: 0.09, height: 0.05, tessellation: 12 },
      scene,
    );
    tip.rotation.set(Math.PI / 2, 0, 0);
    this.upgradePart(tip, thermal).position.set(0.36, 0.27, GEO.bumper.z + 0.4);

    // -- Tier 3: wide-swath regolith collector scoop ------------------------
    if (tier >= 3) {
      const scoopMat = this.upgradePbrMaterial(`${p}-up-scoop`, new Color3(0.8, 0.6, 0.15), 0.6, 0.45);
      const plate = MeshBuilder.CreateBox(`${p}-up-scoop-plate`, { width: 2.6, height: 0.05, depth: 0.62 }, scene);
      plate.rotation.set(-0.5, 0, 0); // leading lip kicks up over the regolith
      this.upgradePart(plate, scoopMat).position.set(0, 0.13, GEO.bumper.z + 0.3);
      for (const side of [1, -1] as const) {
        const tag = side > 0 ? 'l' : 'r';
        const cheek = MeshBuilder.CreateBox(`${p}-up-scoop-cheek-${tag}`, { width: 0.06, height: 0.3, depth: 0.55 }, scene);
        cheek.rotation.set(-0.5, 0, 0);
        this.upgradePart(cheek, scoopMat).position.set(side * 1.26, 0.17, GEO.bumper.z + 0.28);
      }
      // Scoop intake glow strip.
      this.upgradePart(
        MeshBuilder.CreateBox(`${p}-up-scoop-glow`, { width: 2.4, height: 0.03, depth: 0.03 }, scene),
        thermal,
      ).position.set(0, 0.06, GEO.bumper.z + 0.06);
    }

    // -- Tier 4: deep-core resonator seismic dish (underbody) ---------------
    if (tier >= 4) {
      const seismic = this.upgradePbrMaterial(
        `${p}-up-resonator-emissive`,
        new Color3(0.65, 0.3, 0.95),
        0.3,
        0.3,
        new Color3(0.3, 0.08, 0.5),
      );
      this.upgradePart(
        MeshBuilder.CreateCylinder(`${p}-up-resonator-dish`, { diameterTop: 0.44, diameterBottom: 0.2, height: 0.12, tessellation: 16 }, scene),
        steel,
      ).position.set(0, -0.1, 0.15);
      this.upgradePart(
        MeshBuilder.CreateCylinder(`${p}-up-resonator-core`, { diameter: 0.14, height: 0.05, tessellation: 14 }, scene),
        seismic,
      ).position.set(0, -0.17, 0.15);
    }
  }

  /** Per-frame Spec 37 pulse animation: holo cargo-net webbing breathes and
   *  the RCS plumes crackle. Cheap; no-ops on a stock build. */
  private animateUpgradeVisuals(dt: number): void {
    if (this.magNetMaterial === null && this.rcsPlumes.length === 0) return;
    if (Number.isFinite(dt) && dt > 0) this.visualTimeS += dt;
    const t = this.visualTimeS;
    if (this.magNetMaterial !== null) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 3.2);
      this.magNetMaterial.alpha = 0.07 + 0.09 * pulse;
    }
    for (const ps of this.rcsPlumes) {
      try {
        if (ps.isStarted()) ps.emitRate = 36 + 24 * (0.5 + 0.5 * Math.sin(t * 11));
      } catch {
        // Engine detached mid-frame — plume flicker is cosmetic.
      }
    }
  }

  // -- quest dashboard telemetry (Spec 18 §6.3, ADR-18-3) ------------------------

  /**
   * Install / update the quest + contractor telemetry rastered onto the
   * cockpit dash (Spec 18 §6.3): quest title & objective strip, nav pip
   * toward the active target, cargo capacity meter, radio link LED and a
   * target-range ladder. Every field is optional — partial updates merge
   * into the last snapshot; non-finite numbers are ignored. Works before
   * `init()` and after `dispose()` (state is recorded either way; the raster
   * only runs while built), so headless harnesses can drive it without a GPU.
   *
   * @returns the merged dashboard snapshot (same object {@link
   * getDashboardTelemetry} returns a copy of).
   */
  setQuestDashboardTelemetry(data: BuggyDashTelemetry): BuggyDashView {
    const d = this.questDash;
    if (typeof data.questTitle === 'string') d.questTitle = data.questTitle;
    if (typeof data.objectiveText === 'string') d.objectiveText = data.objectiveText;
    if (typeof data.targetDistanceM === 'number' && Number.isFinite(data.targetDistanceM)) {
      d.targetDistanceM = Math.max(0, data.targetDistanceM);
    }
    if (typeof data.targetBearingDeg === 'number' && Number.isFinite(data.targetBearingDeg)) {
      d.targetBearingDeg = ((data.targetBearingDeg % 360) + 360) % 360;
    }
    if (typeof data.cargoKg === 'number' && Number.isFinite(data.cargoKg)) {
      d.cargoKg = Math.max(0, data.cargoKg);
    }
    if (typeof data.maxCargoKg === 'number' && Number.isFinite(data.maxCargoKg) && data.maxCargoKg > 0) {
      d.maxCargoKg = data.maxCargoKg;
    }
    if (typeof data.faction === 'string') d.faction = data.faction;
    if (typeof data.linkStatus === 'string') d.linkStatus = data.linkStatus;
    d.questActive =
      d.questTitle !== null ||
      d.objectiveText !== null ||
      d.targetDistanceM !== null ||
      d.targetBearingDeg !== null;
    // Repaint immediately so a harness that never steps a frame still sees
    // the update land on the texture.
    if (this.built && !this.disposed) {
      this.drawDash(Math.abs(this.last.vLong), this.lastPowerKw, this.last.heading);
    }
    return this.getDashboardTelemetry();
  }

  /**
   * Copy of the live dashboard snapshot — the headless inspection helper
   * Spec 18 §8.3 requires ("entering the buggy updates the dashboard with
   * current quest coordinates and cargo inventory").
   */
  getDashboardTelemetry(): BuggyDashView {
    return { ...this.questDash };
  }

  /**
   * Read one RGBA pixel from the dash raster (0..DASH_W-1, 0..DASH_H-1).
   * Returns null before `init()` / after `dispose()`. Lets smoke tests
   * verify the nav pip, cargo meter and link LED actually painted.
   */
  readDashPixel(x: number, y: number): readonly [number, number, number, number] | null {
    const px = this.dashPixels;
    if (px === null || !Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (x < 0 || x >= DASH_W || y < 0 || y >= DASH_H) return null;
    const i = (y * DASH_W + x) * 4;
    return [px[i] as number, px[i + 1] as number, px[i + 2] as number, px[i + 3] as number];
  }

  // -- mount / dismount -------------------------------------------------------------

  /**
   * True when the given suit (EVA avatar, bare suit state, or raw x/y/z
   * point) is within `MOUNT_RADIUS_M` of the chassis datum. A bare call has
   * no candidate to measure and returns true (the seat is reachable).
   */
  canMount(suitOrPos?: MountCandidate): boolean {
    if (this.disposed) return false;
    const p = OpenBuggy.resolvePoint(suitOrPos);
    if (p === null) return true;
    const s = this.last;
    return Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) <= MOUNT_RADIUS_M;
  }

  /**
   * Drop into the driver seat. Refuses when already mounted, or when a suit
   * is supplied and out of `canMount` range. Parks the wheels first, then
   * seeds the buggy with the suit's momentum through the physics module's
   * own mount helper (when present) so running velocity carries into the
   * seat exactly as `TraversalPhysics.tryMount` intends. Tracks mounted
   * status.
   */
  mount(suit?: unknown): boolean {
    if (this.disposed || this.mounted) return false;
    const rider = (suit ?? null) as MountCandidate | null;
    if (rider !== null && !this.canMount(rider)) return false;

    const seat = this.physics as unknown as BuggySeatAccess;
    if (typeof seat.setStateParked === 'function') seat.setStateParked();

    // Carry the rider's ground momentum into the drivetrain.
    let vLong = 0;
    let vLat = 0;
    if (rider !== null && typeof rider.getState === 'function') {
      const r = rider.getState();
      const ch = Math.cos(this.last.heading);
      const sh = Math.sin(this.last.heading);
      const vx = Number.isFinite(r.vx) ? (r.vx as number) : 0;
      const vy = Number.isFinite(r.vy) ? (r.vy as number) : 0;
      vLong = vx * ch + vy * sh;
      vLat = -vx * sh + vy * ch;
    }
    if ((vLong !== 0 || vLat !== 0) && typeof seat.setStateFromMount === 'function') {
      seat.setStateFromMount(vLong, vLat);
    }

    this.mounted = true;
    return true;
  }

  /**
   * Climb out. Refuses unless currently mounted. Parks the buggy through the
   * physics module's own parked helper and steps the suit off to the driver
   * side — `DISMOUNT_LATERAL_M` perpendicular to heading (physics +y, the
   * left side) — via `suit.teleport` when present, else `suit.setState`.
   * Clears mounted status so the prospector can climb back in.
   */
  dismount(suit?: {
    teleport?: (x: number, y: number) => void;
    setState?: (patch: Record<string, unknown>) => void;
  }): boolean {
    if (this.disposed || !this.mounted) return false;
    const target = this.pointAt(0, DISMOUNT_LATERAL_M, 0);

    if (suit !== undefined && suit !== null) {
      if (typeof suit.teleport === 'function') {
        suit.teleport(target.x, target.y);
      } else if (typeof suit.setState === 'function') {
        suit.setState({ x: target.x, y: target.y, z: target.z, vx: 0, vy: 0, vz: 0 });
      }
    }

    const seat = this.physics as unknown as BuggySeatAccess;
    if (typeof seat.setStateParked === 'function') seat.setStateParked();

    this.mounted = false;
    return true;
  }

  /** True while a prospector is in the driver seat. */
  isMounted(): boolean {
    return this.mounted;
  }

  // -- internals --------------------------------------------------------------

  /**
   * Ackermann-solved steer angle for front wheel `i` (0 = FL, 1 = FR) given
   * the mean steer angle δ, with a 2.7 m wheelbase and 1.7 m track. Returns
   * 0 when δ is inside the deadband. Shared by knuckles, road wheels and
   * tie-rods so all three always agree (Spec 17 §4.2).
   */
  private ackermannFor(i: number, steerAngle: number): number {
    if (!Number.isFinite(steerAngle) || Math.abs(steerAngle) < 1e-4) return 0;
    const r = 2.7 / Math.tan(steerAngle);
    const fy = i === 0 ? 0.85 : -0.85;
    const effRadius = fy < 0 ? r - 0.85 : r + 0.85;
    return Math.atan(2.7 / effRadius);
  }

  /**
   * Chassis-local tie-rod chord for front corner `i` at steer angle δ. The
   * rod spans the fixed rack end (on the steering-rack rail) to the knuckle
   * outer attach point, whose in-plane offset is Ackermann-rotated about the
   * upright king-pin. The corner pivot rides with the wheel plane while the
   * chassis heaves independently, so `relativeHeave` — the wheel-plane minus
   * chassis-datum height in Babylon y — stretches the chord with suspension
   * travel. `rackEnd`/`attach` are caller-owned scratch vectors.
   */
  private tieRodChord(
    i: number,
    steerAngle: number,
    relativeHeave: number,
    rackEnd: Vector3,
    attach: Vector3,
  ): number {
    const slot = WHEEL_SLOTS[i];
    const side = slot.side;
    rackEnd.set(side * GEO.rack.halfWidth, GEO.rack.y, GEO.rack.z);

    const delta = this.ackermannFor(i, steerAngle);
    const offX = -side * GEO.tieAttach.x;
    const offZ = GEO.tieAttach.z;
    const cosd = Math.cos(delta);
    const sind = Math.sin(delta);
    attach.set(
      side * (BUGGY_TRACK / 2) + (offX * cosd + offZ * sind),
      relativeHeave + GEO.tieAttach.y,
      slot.z + (-offX * sind + offZ * cosd),
    );
    return Vector3.Distance(rackEnd, attach);
  }

  /** Procedural rover: cohesive chassis hierarchy, double wishbones,
   *  coilovers, tie-rods, knuckles, wheels, cockpit and lighting
   *  (Spec 17 §4). */
  private buildRover(scene: Scene): void {
    const p = this.prefix;
    const tube = GEO.tube.diameter;

    // -- Spec 17 §4.4 PBR Materials Palette --------------------------------
    const gold = new PBRMaterial(`${p}-gold`, scene);
    gold.albedoColor = new Color3(0.92, 0.76, 0.20); // Kapton foil
    gold.metallic = 0.85;
    gold.roughness = 0.25;
    gold.environmentIntensity = 0.05;

    const hazard = new PBRMaterial(`${p}-hazard`, scene);
    hazard.albedoColor = new Color3(0.82, 0.62, 0.12); // Hazard matte yellow
    hazard.metallic = 0.10;
    hazard.roughness = 0.55;
    hazard.environmentIntensity = 0.05;

    const aluminum = new PBRMaterial(`${p}-aluminum`, scene);
    aluminum.albedoColor = new Color3(0.75, 0.77, 0.80); // Anodized aluminum
    aluminum.metallic = 0.90;
    aluminum.roughness = 0.35;
    aluminum.environmentIntensity = 0.05;

    // Spec 17 §4.4: matte rubber tyres (near-zero metallic, high roughness).
    const tire = new PBRMaterial(`${p}-tire`, scene);
    tire.albedoColor = new Color3(0.09, 0.09, 0.10);
    tire.metallic = 0.05;
    tire.roughness = 0.95;
    tire.environmentIntensity = 0.05;

    // Spec 17 §4.4: powder-coated steel space-frame tubing.
    const powdercoat = new PBRMaterial(`${p}-powdercoat`, scene);
    powdercoat.albedoColor = new Color3(0.72, 0.28, 0.06); // Safety orange
    powdercoat.metallic = 0.30;
    powdercoat.roughness = 0.62;
    powdercoat.environmentIntensity = 0.05;

    // Spec 17 §4.4: carbon-fibre woven tow texture (procedural twill weave).
    const carbon = this.buildCarbonFibreMaterial(scene, `${p}-carbon`);

    // Spec 17 §4.4: polished suspension stanchions / chrome hardware.
    const polished = new PBRMaterial(`${p}-polished`, scene);
    polished.albedoColor = new Color3(0.88, 0.90, 0.92);
    polished.metallic = 1.0;
    polished.roughness = 0.12;
    polished.environmentIntensity = 0.05;

    const taillightMat = new PBRMaterial(`${p}-taillight-mat`, scene);
    taillightMat.albedoColor = new Color3(0.8, 0.05, 0.05);
    taillightMat.emissiveColor = new Color3(0.3, 0.0, 0.0);
    taillightMat.metallic = 0.1;
    taillightMat.roughness = 0.5;
    this.taillightMaterial = taillightMat;

    // Live digital telemetry dash (Spec 17 §4.3): segment bars rastered into
    // a RawTexture — no DOM canvas, so NullEngine-safe.
    const dashMat = new PBRMaterial(`${p}-dash-mat`, scene);
    dashMat.albedoColor = new Color3(1, 1, 1);
    dashMat.emissiveColor = new Color3(0.55, 0.6, 0.7);
    dashMat.metallic = 0.1;
    dashMat.roughness = 0.4;
    this.dashPixels = new Uint8Array(DASH_W * DASH_H * 4);
    const dashTex = new RawTexture(this.dashPixels, DASH_W, DASH_H, Engine.TEXTUREFORMAT_RGBA, scene, false);
    dashTex.hasAlpha = false;
    this.dashTexture = dashTex;
    this.ownedTextures.push(dashTex);
    dashMat.albedoTexture = dashTex;

    // Twin LED lightbar emission (Spec 17 §4.3).
    const ledMat = new PBRMaterial(`${p}-led`, scene);
    ledMat.albedoColor = new Color3(0.95, 0.97, 1.0);
    ledMat.emissiveColor = new Color3(0.9, 0.94, 1.0);
    ledMat.metallic = 0.0;
    ledMat.roughness = 0.3;

    // Translucent volumetric-style front light cones (Spec 17 §4.3):
    // alpha-blended emissive shells in front of the LED bars.
    const lens = new PBRMaterial(`${p}-lens`, scene);
    lens.albedoColor = new Color3(1.0, 0.97, 0.86);
    lens.emissiveColor = new Color3(0.45, 0.44, 0.34);
    lens.metallic = 0.0;
    lens.roughness = 0.2;
    lens.alpha = 0.14;
    lens.disableLighting = true;

    this.materials = [gold, hazard, aluminum, tire, powdercoat, carbon, polished, taillightMat, dashMat, ledMat, lens];
    this.root = new TransformNode(`${p}-rover`, scene);

    // Unified rigid chassis body node: all chassis elements share this transform
    const chassisBody = new TransformNode(`${p}-chassis-body`, scene);
    chassisBody.parent = this.root;
    this.chassisBody = chassisBody;

    const chassisMeshes: Mesh[] = [];
    /** Register a chassis-body child mesh (parent bookkeeping only). */
    const register = (mesh: Mesh, mat: PBRMaterial): Mesh => {
      mesh.material = mat;
      mesh.parent = chassisBody;
      chassisMeshes.push(mesh);
      return mesh;
    };
    /** Straight tube between two chassis-local points (merged naming by caller). */
    const tubeBetween = (
      name: string,
      from: readonly [number, number, number],
      to: readonly [number, number, number],
      mat: PBRMaterial,
    ): Mesh => {
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const dz = to[2] - from[2];
      const len = Math.hypot(dx, dy, dz);
      this.scratchDir.set(dx, dy, dz).normalize();
      alignYTo(this.scratchDir, this.scratchQuat);
      const rod = MeshBuilder.CreateCylinder(name, { diameter: tube, height: len, tessellation: 10 }, scene);
      rod.rotationQuaternion = this.scratchQuat.clone();
      rod.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2);
      return register(rod, mat);
    };

    // -- 1. Structural chassis tub + underbody skid plate (Spec 17 §4.1) ---
    const tub = register(
      MeshBuilder.CreateBox(
        `${p}-tub-chassis`,
        { width: GEO.chassis.width, height: 0.25, depth: GEO.chassis.depth },
        scene,
      ),
      aluminum,
    );
    tub.position.set(0, 0.12, 0);

    register(
      MeshBuilder.CreateBox(`${p}-skid-plate`, { width: 1.32, height: 0.05, depth: 3.05 }, scene),
      aluminum,
    ).position.set(0, -0.03, 0.05);

    // -- 2. Tubular space frame + double roll hoop cage, X cross-braced ----
    tubeBetween(`${p}-frame-rail-l`, [0.62, 0.1, -1.45], [0.62, 0.1, 1.35], powdercoat);
    tubeBetween(`${p}-frame-rail-r`, [-0.62, 0.1, -1.45], [-0.62, 0.1, 1.35], powdercoat);
    tubeBetween(`${p}-frame-crossmember-front`, [-0.62, 0.1, 1.35], [0.62, 0.1, 1.35], powdercoat);
    tubeBetween(`${p}-frame-crossmember-rear`, [-0.62, 0.1, -1.45], [0.62, 0.1, -1.45], powdercoat);
    // Front hoop (posts + top bar)
    tubeBetween(`${p}-cage-hoop-front-post-l`, [0.6, 0.2, 0.55], [0.52, 1.32, 0.4], powdercoat);
    tubeBetween(`${p}-cage-hoop-front-post-r`, [-0.6, 0.2, 0.55], [-0.52, 1.32, 0.4], powdercoat);
    tubeBetween(`${p}-cage-hoop-front-top`, [-0.52, 1.32, 0.4], [0.52, 1.32, 0.4], powdercoat);
    // Rear hoop
    tubeBetween(`${p}-cage-hoop-rear-post-l`, [0.62, 0.2, -1.05], [0.55, 1.32, -0.95], powdercoat);
    tubeBetween(`${p}-cage-hoop-rear-post-r`, [-0.62, 0.2, -1.05], [-0.55, 1.32, -0.95], powdercoat);
    tubeBetween(`${p}-cage-hoop-rear-top`, [-0.55, 1.32, -0.95], [0.55, 1.32, -0.95], powdercoat);
    // Roof longons + X cross-bracing
    tubeBetween(`${p}-cage-roof-longon-l`, [0.52, 1.32, 0.4], [0.55, 1.32, -0.95], powdercoat);
    tubeBetween(`${p}-cage-roof-longon-r`, [-0.52, 1.32, 0.4], [-0.55, 1.32, -0.95], powdercoat);
    tubeBetween(`${p}-cage-cross-brace-1`, [-0.52, 1.32, 0.4], [0.55, 1.32, -0.95], powdercoat);
    tubeBetween(`${p}-cage-cross-brace-2`, [0.52, 1.32, 0.4], [-0.55, 1.32, -0.95], powdercoat);

    // -- 3. Reinforced winch/bumper bar (Spec 17 §4.1) ----------------------
    register(
      MeshBuilder.CreateBox(
        `${p}-winch-bumper`,
        { width: GEO.bumper.width, height: 0.09, depth: 0.09 },
        scene,
      ),
      powdercoat,
    ).position.set(0, GEO.bumper.y, GEO.bumper.z);
    register(
      MeshBuilder.CreateCylinder(
        `${p}-winch-bumper-stub-l`,
        { diameter: tube, height: 0.3, tessellation: 8 },
        scene,
      ),
      powdercoat,
    ).position.set(GEO.bumper.width / 2 - 0.08, GEO.bumper.y + 0.12, GEO.bumper.z - 0.1);
    register(
      MeshBuilder.CreateCylinder(
        `${p}-winch-bumper-stub-r`,
        { diameter: tube, height: 0.3, tessellation: 8 },
        scene,
      ),
      powdercoat,
    ).position.set(-GEO.bumper.width / 2 + 0.08, GEO.bumper.y + 0.12, GEO.bumper.z - 0.1);
    const winchDrum = register(
      MeshBuilder.CreateCylinder(
        `${p}-winch-drum`,
        { diameter: 0.14, height: 0.22, tessellation: 12 },
        scene,
      ),
      polished,
    );
    winchDrum.rotation.set(0, 0, Math.PI / 2);
    winchDrum.position.set(0, GEO.bumper.y + 0.02, GEO.bumper.z - 0.06);

    // -- 4. Sloped front cowl -----------------------------------------------
    register(
      MeshBuilder.CreateBox(`${p}-front-cowl`, { width: 1.25, height: 0.28, depth: 0.8 }, scene),
      gold,
    ).position.set(0, 0.35, 1.15);

    // -- 5. Cockpit: bucket seat + 4-pt harness + T-bar + live dash (§4.3) --
    register(
      MeshBuilder.CreateBox(`${p}-seat-base`, { width: 0.55, height: 0.14, depth: 0.55 }, scene),
      tire,
    ).position.set(-0.28, 0.32, 0.3);
    register(
      MeshBuilder.CreateBox(`${p}-seat-back`, { width: 0.55, height: 0.72, depth: 0.12 }, scene),
      tire,
    ).position.set(-0.28, 0.7, 0.02);
    // Bucket side bolsters
    register(
      MeshBuilder.CreateBox(`${p}-seat-bolster-l`, { width: 0.09, height: 0.3, depth: 0.5 }, scene),
      tire,
    ).position.set(-0.28 + 0.26, 0.46, 0.3);
    register(
      MeshBuilder.CreateBox(`${p}-seat-bolster-r`, { width: 0.09, height: 0.3, depth: 0.5 }, scene),
      tire,
    ).position.set(-0.28 - 0.26, 0.46, 0.3);
    // 4-point harness: two shoulder straps + two lap straps
    const harnessSl = register(
      MeshBuilder.CreateBox(`${p}-harness-shoulder-l`, { width: 0.07, height: 0.62, depth: 0.02 }, scene),
      hazard,
    );
    harnessSl.rotation.set(0.35, 0, 0);
    harnessSl.position.set(-0.28 + 0.14, 0.72, 0.1);
    const harnessSr = register(
      MeshBuilder.CreateBox(`${p}-harness-shoulder-r`, { width: 0.07, height: 0.62, depth: 0.02 }, scene),
      hazard,
    );
    harnessSr.rotation.set(0.35, 0, 0);
    harnessSr.position.set(-0.28 - 0.14, 0.72, 0.1);
    register(
      MeshBuilder.CreateBox(`${p}-harness-lap-l`, { width: 0.24, height: 0.05, depth: 0.02 }, scene),
      hazard,
    ).position.set(-0.28 + 0.14, 0.4, 0.54);
    register(
      MeshBuilder.CreateBox(`${p}-harness-lap-r`, { width: 0.24, height: 0.05, depth: 0.02 }, scene),
      hazard,
    ).position.set(-0.28 - 0.14, 0.4, 0.54);

    const tBar = register(
      MeshBuilder.CreateCylinder(`${p}-steering-t-bar`, { diameter: 0.05, height: 0.45 }, scene),
      aluminum,
    );
    tBar.rotation.set(Math.PI / 3.2, 0, 0);
    tBar.position.set(-0.28, 0.52, 0.62);

    const dash = register(
      MeshBuilder.CreateBox(`${p}-dash-display`, { width: 0.45, height: 0.24, depth: 0.06 }, scene),
      dashMat,
    );
    dash.rotation.set(Math.PI / 5, 0, 0);
    dash.position.set(-0.28, 0.52, 0.78);

    // -- 6. Cargo bay: carbon bed + dynamic mineral crates -------------------
    register(
      MeshBuilder.CreateBox(`${p}-cargo-bed`, { width: 1.5, height: 0.18, depth: 1.6 }, scene),
      carbon,
    ).position.set(0, 0.25, -0.65);
    const crates = register(
      MeshBuilder.CreateBox(`${p}-cargo-crates`, { width: 1.3, height: 0.45, depth: 1.4 }, scene),
      gold,
    );
    crates.position.set(0, 0.55, -0.65);
    this.cargoCrates = crates;

    // -- 7. Lighting: twin LED lightbars + taillights + cone shells (§4.3) --
    register(
      MeshBuilder.CreateBox(`${p}-lightbar-l`, { width: 0.52, height: 0.07, depth: 0.08 }, scene),
      ledMat,
    ).position.set(0.3, 1.4, 0.4);
    register(
      MeshBuilder.CreateBox(`${p}-lightbar-r`, { width: 0.52, height: 0.07, depth: 0.08 }, scene),
      ledMat,
    ).position.set(-0.3, 1.4, 0.4);
    const taillights = register(
      MeshBuilder.CreateBox(`${p}-taillights`, { width: 1.35, height: 0.08, depth: 0.06 }, scene),
      taillightMat,
    );
    taillights.position.set(0, 0.28, -1.45);
    this.taillights = taillights;

    // Translucent front light cones: cylinder axis oriented onto model +z;
    // the narrow end sits at the lamp and the beam spreads forward past the
    // bumper (apex → wide base along +z).
    const coneLen = 2.2;
    for (let i = 0; i < LAMP_POINTS.length; i++) {
      const cone = MeshBuilder.CreateCylinder(
        `${p}-light-cone-${i === 0 ? 'l' : 'r'}`,
        {
          diameterTop: 1.15,
          diameterBottom: 0.05,
          height: coneLen,
          tessellation: 14,
        },
        scene,
      );
      cone.rotationQuaternion = Quaternion.RotationAxis(AXIS_X, Math.PI / 2);
      cone.position.set(LAMP_POINTS[i].x, LAMP_POINTS[i].y, LAMP_POINTS[i].z + coneLen / 2);
      register(cone, lens);
    }

    // -- 8. Steering rack (tie-rod anchor rail, Spec 17 §4.2) ----------------
    const rack = register(
      MeshBuilder.CreateCylinder(
        `${p}-steering-rack`,
        { diameter: GEO.rack.diameter, height: GEO.rack.halfWidth * 2, tessellation: 10 },
        scene,
      ),
      polished,
    );
    rack.rotation.set(0, 0, Math.PI / 2);
    rack.position.set(0, GEO.rack.y, GEO.rack.z);

    // -- 9. Suspension corners (FL, FR, RL, RR) (§4.2) -----------------------
    const cornerPivots: TransformNode[] = [];
    const steeringKnuckles: TransformNode[] = [];
    const upperArms: Mesh[] = [];
    const lowerArms: Mesh[] = [];
    const coilovers: Mesh[] = [];
    const damperRods: Mesh[] = [];
    const tieRods: Mesh[] = [];
    const hubList: Mesh[] = [];
    const coilGroups: TransformNode[] = [];
    const wheelsList: Mesh[] = [];
    const mudFlapsList: Mesh[] = [];

    const wheelDiameter = BUGGY_WHEEL_RADIUS * 2;

    // Nominal tie-rod chord (rest length) straight ahead at static ride:
    // Spec 32 §2.5 the wheel plane hangs below the datum-riding root at the
    // static-ride deflection of the corner law — x₀ = m·g/(4k) of spring
    // compression under the empty chassis at lunar gravity — so the rods
    // rest at their true chord while the rover rolls straight and level.
    {
      const a = new Vector3();
      const b = new Vector3();
      const staticRideDeflection =
        (BUGGY_CHASSIS_MASS * LUNAR_GRAVITY) / (4 * BUGGY_SPRING_RATE);
      this.tieRodRestLen = this.tieRodChord(
        0,
        0,
        WHEEL_NEUTRAL_LOCAL_Y + staticRideDeflection,
        a,
        b,
      );
    }

    for (let i = 0; i < WHEEL_SLOTS.length; i++) {
      const slot = WHEEL_SLOTS[i];
      const isFront = i < 2;
      const cornerPivot = new TransformNode(`${p}-corner-pivot-${i}`, scene);
      cornerPivot.parent = this.root;
      // Spec 32 §2.5: the root now rides at the chassis datum elevation, so
      // the wheel plane hangs BELOW it (static build pose = neutral ride).
      cornerPivot.position.set(slot.side * (BUGGY_TRACK / 2), WHEEL_NEUTRAL_LOCAL_Y, slot.z);
      cornerPivots.push(cornerPivot);

      // Double wishbone A-arms: upper + lower V-struts, each merged from two
      // tubes running from chassis-side inner pivots to the wheel-upright
      // outer ball joints (cornerPivot-local frame, Spec 17 §4.2).
      const makeWishbone = (name: string, innerY: number, outerY: number, zFore: number, zAft: number): Mesh => {
        const strut = (suffix: string, z: number): Mesh => {
          const from = new Vector3(-slot.side * 0.5, innerY, z);
          const to = new Vector3(-slot.side * 0.02, outerY, z * 0.5);
          const dir = to.subtract(from);
          const len = dir.length();
          dir.normalize();
          alignYTo(dir, this.scratchQuat);
          const rod = MeshBuilder.CreateCylinder(
            `${name}-${suffix}`,
            { diameter: tube * 0.85, height: len, tessellation: 8 },
            scene,
          );
          rod.rotationQuaternion = this.scratchQuat.clone();
          rod.position.copyFrom(from.add(to).scale(0.5));
          return rod;
        };
        const fwd = strut('fwd', zFore);
        const aft = strut('aft', zAft);
        const merged = Mesh.MergeMeshes([fwd, aft], true, true, undefined, false, false)
          ?? MeshBuilder.CreateBox(name, { size: 0.1 }, scene);
        merged.name = name;
        merged.material = aluminum;
        merged.parent = cornerPivot;
        return merged;
      };
      upperArms.push(makeWishbone(`${p}-a-arm-upper-${i}`, 0.35, 0.24, 0.26, -0.26));
      lowerArms.push(makeWishbone(`${p}-a-arm-lower-${i}`, 0.02, -0.04, 0.3, -0.3));

      // Coaxial coilover: merged torus stack (visible coils) + telescoping
      // polished damper rod, anchored at the chassis upper mount and
      // oriented along the nominal spring axis (Spec 17 §4.2). Parented to
      // chassisBody so the top mount rides with the sprung mass; compression
      // scales the spring stack along its own axis.
      const upper = new Vector3(slot.side * GEO.coil.upperX, GEO.coil.upperY, slot.z * GEO.coil.zScale);
      const lower = new Vector3(slot.side * GEO.coil.lowerX, GEO.coil.lowerY, slot.z * GEO.coil.zScale);
      const coilAxis = lower.subtract(upper);
      const coilLen = coilAxis.length();
      coilAxis.normalize();

      const coilGroup = new TransformNode(`${p}-coilover-mount-${i}`, scene);
      coilGroup.parent = chassisBody;
      coilGroup.position.copyFrom(upper);
      alignYTo(coilAxis, this.scratchQuat);
      coilGroup.rotationQuaternion = this.scratchQuat.clone();
      coilGroups.push(coilGroup);

      const coils: Mesh[] = [];
      const coilCount = 6;
      for (let k = 0; k < coilCount; k++) {
        const turn = MeshBuilder.CreateTorus(
          `${p}-coilover-${i}-turn-${k}`,
          { diameter: 0.15, thickness: 0.022, tessellation: 12 },
          scene,
        );
        turn.position.y = ((k + 0.5) / coilCount) * coilLen;
        coils.push(turn);
      }
      const spring = Mesh.MergeMeshes(coils, true, true, undefined, false, false)
        ?? MeshBuilder.CreateCylinder(`${p}-coilover-spring-${i}`, { diameter: 0.15, height: coilLen }, scene);
      spring.name = `${p}-coilover-spring-${i}`;
      spring.material = polished;
      spring.parent = coilGroup;
      spring.position.set(0, 0, 0);
      coilovers.push(spring);

      const rod = MeshBuilder.CreateCylinder(
        `${p}-coilover-damper-${i}`,
        { diameter: 0.05, height: coilLen * 1.18, tessellation: 10 },
        scene,
      );
      rod.material = aluminum;
      rod.parent = coilGroup;
      rod.position.y = coilLen * (1.18 / 2) - 0.06;
      damperRods.push(rod);

      // Steering knuckle: front uprights carry hub + wheel steer yaw; rear
      // corners hang their hub straight off the corner pivot.
      let knuckleParent: TransformNode = cornerPivot;
      if (isFront) {
        const knuckle = new TransformNode(`${p}-steering-knuckle-${i}`, scene);
        knuckle.parent = cornerPivot;
        steeringKnuckles.push(knuckle);
        knuckleParent = knuckle;
      }

      // Tie-rod assembly on the FRONT corners only (Spec 17 §4.2): spans
      // rack end → knuckle outer attach, re-aimed every synced frame.
      if (isFront) {
        const tie = MeshBuilder.CreateCylinder(
          `${p}-tie-rod-${slot.side > 0 ? 'l' : 'r'}`,
          { diameter: 0.045, height: this.tieRodRestLen, tessellation: 8 },
          scene,
        );
        tie.material = polished;
        tie.parent = chassisBody;
        tieRods.push(tie);
      }

      // Wheel hub
      const hub = MeshBuilder.CreateCylinder(
        `${p}-hub-${i}`,
        { diameter: 0.18, height: 0.12 },
        scene,
      );
      hub.rotation.set(0, 0, -Math.PI / 2);
      hub.material = polished;
      hub.parent = knuckleParent;
      hubList.push(hub);

      // Road wheel: cylinder starts with axis along +y; rotated to lay down along axle
      const wheel = MeshBuilder.CreateCylinder(
        `${p}-wheel-${i}`,
        { diameter: wheelDiameter, height: 0.34, tessellation: 24 },
        scene,
      );
      wheel.position.set(slot.side * (BUGGY_TRACK / 2), WHEEL_NEUTRAL_LOCAL_Y, slot.z);
      wheel.material = tire;
      wheel.parent = this.root;
      wheelsList.push(wheel);

      // Mud flap / regolith dust fender
      const flap = MeshBuilder.CreateBox(
        `${p}-mud-flap-${i}`,
        { width: 0.38, height: 0.08, depth: 0.55 },
        scene,
      );
      flap.position.set(0, BUGGY_WHEEL_RADIUS * 0.52, 0);
      flap.material = hazard;
      flap.parent = cornerPivot;
      mudFlapsList.push(flap);
    }

    this.cornerPivots = cornerPivots;
    this.steeringKnuckles = steeringKnuckles;
    this.wheels = wheelsList;
    this.coilovers = coilovers;
    this.damperRods = damperRods;
    this.tieRods = tieRods;
    // Spec 37 Phase 2: attachment attach-points for upgrade visuals.
    this.wheelHubs = hubList;
    this.coilMounts = coilGroups;

    this.parts = [
      ...chassisMeshes,
      ...upperArms,
      ...lowerArms,
      ...coilovers,
      ...damperRods,
      ...tieRods,
      ...hubList,
      ...wheelsList,
      ...mudFlapsList,
    ];

    for (const mesh of this.parts) {
      mesh.isPickable = true;
      mesh.receiveShadows = false;
    }

    // Dual-stage stadium projector rig (Spec 23 §2.4 / ADR-023-4):
    // For each mount point (L/R), create:
    // 1. Low-beam mega-flood (wide 110° cone, 85m throw, 8.5 intensity)
    // 2. High-beam hyper-piercing projector (30° cone, 250m throw, 16.0)
    // Headlights stay UNPARENTED and get their world position and chassis-matrix
    // beam direction recomputed every frame (see applyLamps).
    const lamps: SpotLight[] = [];
    for (let index = 0; index < LAMP_POINTS.length; index++) {
      const side = index === 0 ? 'l' : 'r';
      const lowLamp = new SpotLight(
        `${p}-headlight-${side}-low`,
        LAMP_POINTS[index].clone(),
        new Vector3(0, -0.07, 1).normalize(),
        (LOW_BEAM_ANGLE_DEG * Math.PI) / 180,
        2,
        scene,
      );
      lowLamp.range = LOW_BEAM_RANGE_M;
      lowLamp.diffuse = new Color3(1, 0.96, 0.88);
      lamps.push(lowLamp);

      const highLamp = new SpotLight(
        `${p}-headlight-${side}-high`,
        LAMP_POINTS[index].clone(),
        new Vector3(0, -0.07, 1).normalize(),
        (HIGH_BEAM_ANGLE_DEG * Math.PI) / 180,
        2,
        scene,
      );
      highLamp.range = HIGH_BEAM_RANGE_M;
      // Spec 23 §2.4.1 Stage 2: crisp daylight-white projector colour.
      highLamp.diffuse = new Color3(HIGH_BEAM_COLOR.r, HIGH_BEAM_COLOR.g, HIGH_BEAM_COLOR.b);
      lamps.push(highLamp);
    }
    this.lamps = lamps;

    this.buildBeamCones(scene);
    // Spec 37 Phase 2: mount the procedural components the current build has
    // purchased (no-op at factory Tier-1-everywhere state).
    this.applyUpgradeVisuals();
  }

  /**
   * Spec 23 §2.4.2 / ADR-023-4: procedural translucent light cones drifting
   * from the headlight lightbars. Each cone is an open cylinder (apex at the
   * lamp, mouth down-range) with an additive-blend unlit material, faking
   * forward scattering against the photoelectrically-charged levitating dust
   * layer over the regolith. Cones are deliberately kept OUT of `this.parts`
   * (own bookkeeping + own dispose) so shadow-caster registration, picking
   * and mesh-count contracts of the physical buggy stay untouched. They are
   * NOT parented — like the SpotLights, their world pose is recomputed from
   * the chassis matrix every frame (`applyLamps`), which is what makes them
   * track pitch/yaw/roll smoothly and truthfully under NullEngine too.
   */
  private buildBeamCones(scene: Scene): void {
    const p = this.prefix;

    // Stage-1 mega-flood scatter shell: wide, very faint.
    const floodMat = new StandardMaterial(`${p}-beamcone-flood`, scene);
    floodMat.disableLighting = true;
    floodMat.emissiveColor = new Color3(1.0, 0.96, 0.88);
    floodMat.diffuseColor = new Color3(0, 0, 0);
    floodMat.specularColor = new Color3(0, 0, 0);
    floodMat.alpha = 0.045;
    floodMat.alphaMode = Engine.ALPHA_ADD;
    floodMat.backFaceCulling = false;
    this.beamConeMaterial = floodMat;

    // Stage-2 piercing projector core: narrower, brighter dust core.
    const highMat = new StandardMaterial(`${p}-beamcone-high`, scene);
    highMat.disableLighting = true;
    highMat.emissiveColor = new Color3(HIGH_BEAM_COLOR.r, HIGH_BEAM_COLOR.g, HIGH_BEAM_COLOR.b);
    highMat.diffuseColor = new Color3(0, 0, 0);
    highMat.specularColor = new Color3(0, 0, 0);
    highMat.alpha = 0.07;
    highMat.alphaMode = Engine.ALPHA_ADD;
    highMat.backFaceCulling = false;
    this.beamConeHighMaterial = highMat;

    // Cone mouth diameters follow the beam geometry: d = 2·L·tan(θ/2).
    const floodDiameter = 2 * BEAM_CONE_FLOOD_M * Math.tan(((LOW_BEAM_ANGLE_DEG * Math.PI) / 180) / 2);
    const highDiameter = 2 * BEAM_CONE_HIGH_M * Math.tan(((HIGH_BEAM_ANGLE_DEG * Math.PI) / 180) / 2);

    for (let index = 0; index < LAMP_POINTS.length; index++) {
      const side = index === 0 ? 'l' : 'r';
      const flood = MeshBuilder.CreateCylinder(
        `${p}-beamcone-${side}-low`,
        { diameterTop: floodDiameter, diameterBottom: 0.2, height: BEAM_CONE_FLOOD_M, tessellation: 20, cap: 0 },
        scene,
      );
      flood.material = floodMat;
      flood.isPickable = false;
      flood.receiveShadows = false;
      this.beamCones.push(flood);

      const high = MeshBuilder.CreateCylinder(
        `${p}-beamcone-${side}-high`,
        { diameterTop: highDiameter, diameterBottom: 0.14, height: BEAM_CONE_HIGH_M, tessellation: 20, cap: 0 },
        scene,
      );
      high.material = highMat;
      high.isPickable = false;
      high.receiveShadows = false;
      this.beamConesHigh.push(high);
    }
  }

  /**
   * Procedural carbon-fibre twill weave material (Spec 17 §4.4): a tiny RGBA
   * raster of interlocking tows tiled with u/v scale so it reads as woven
   * carbon over the bed panels. RawTexture keeps it NullEngine-safe.
   */
  private buildCarbonFibreMaterial(scene: Scene, name: string): PBRMaterial {
    const W = 16;
    const H = 16;
    const px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        // 2×2 twill: alternating warp/weft over-floats with a fine sheen.
        const over = ((x >> 1) + (y >> 1)) % 2 === 0;
        const grain = (x + y) % 4 === 0 ? 18 : 0;
        const v = over ? 58 + grain : 30 + grain;
        px[i] = v;
        px[i + 1] = v;
        px[i + 2] = v + 12; // cool carbon tint
        px[i + 3] = 255;
      }
    }
    const tex = new RawTexture(px, W, H, Engine.TEXTUREFORMAT_RGBA, scene, true);
    tex.uScale = 8;
    tex.vScale = 8;
    tex.hasAlpha = false;
    this.ownedTextures.push(tex);
    const mat = new PBRMaterial(name, scene);
    mat.albedoTexture = tex;
    mat.metallic = 0.55;
    mat.roughness = 0.38;
    mat.environmentIntensity = 0.05;
    return mat;
  }

  /**
   * Paint the digital telemetry dash (Spec 17 §4.3): cyan speed segment bar,
   * amber power segment bar and a direction pip, rastered into the
   * persistent RGBA buffer and pushed to the GPU with `RawTexture.update` —
   * no DOM canvas, so it runs on NullEngine.
   *
   * Spec 18 §6.3 / ADR-18-3 overlay (only while quest telemetry is active,
   * and never over the two segment bars): magenta quest-title text strip
   * (rows 0–1), a relative-bearing nav pip row under the speed bar (rows
   * 12–14), a green cargo capacity meter (rows 16–18) with the radio-link
   * LED at its right end, and an orange target-range ladder along the bottom
   * edge (rows 29–31).
   */
  private drawDash(speed: number, powerKw: number, heading = 0): void {
    const px = this.dashPixels;
    const tex = this.dashTexture;
    if (px === null || tex === null) return;
    px.fill(0);
    const put = (x: number, y: number, r: number, g: number, b: number): void => {
      if (x < 0 || x >= DASH_W || y < 0 || y >= DASH_H) return;
      const i = (y * DASH_W + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    };
    const bar = (x0: number, y0: number, w: number, h: number, frac: number, r: number, g: number, b: number): void => {
      const filled = Math.round(clamp(frac, 0, 1) * w);
      for (let seg = 0; seg < w; seg++) {
        const on = seg < filled;
        const groove = seg % 4 === 3;
        for (let yy = 0; yy < h; yy++) {
          if (groove) put(x0 + seg, y0 + yy, 8, 8, 10);
          else if (on) put(x0 + seg, y0 + yy, r, g, b);
          else put(x0 + seg, y0 + yy, 20, 22, 30);
        }
      }
    };
    bar(2, 3, 60, 9, speed / DASH_SPEED_FSK, 40, 220, 255);
    bar(2, 20, 60, 9, powerKw / DASH_POWER_FSKW, 255, 180, 40);
    for (let x = 2; x < 62; x++) put(x, 15, 12, 14, 18);
    put(Math.round(clamp(powerKw / DASH_POWER_FSKW, 0, 1) * 58) + 2, 15, 255, 90, 60);

    // -- Spec 18 §6.3 quest overlay (rows 0–1, 12–14, 16–18, 29–31) ---------
    const q = this.questDash;
    if (q.questActive) {
      // Quest title / objective text strip: a two-pixel-tall dot-matrix run
      // (the diegetic stand-in for the title + directive lines).
      const textLen = Math.max(4, Math.min(60, ((q.questTitle?.length ?? 0) + (q.objectiveText?.length ?? 0)) >> 1));
      for (let x = 0; x < textLen; x++) {
        for (let y = 0; y < 2; y++) {
          if ((x + y) % 2 === 0) put(2 + x, y, 236, 64, 255);
        }
      }
      // Nav pip row: relative compass bearing of the active target, mapped
      // (-180..180] across the dash width. Own bearing = 90° − heading°
      // (same convention as the HUD compass tape).
      const trackY = 13;
      for (let x = 2; x < 62; x++) {
        put(x, trackY - 1, 14, 16, 22);
        put(x, trackY + 1, 14, 16, 22);
      }
      put(32, trackY - 1, 90, 96, 110);
      put(32, trackY + 1, 90, 96, 110);
      if (q.targetBearingDeg !== null) {
        const ownBearing = ((90 - (heading * 180) / Math.PI) % 360 + 360) % 360;
        let rel = q.targetBearingDeg - ownBearing;
        rel = ((rel + 540) % 360) - 180; // wrap to (-180, 180]
        const pipX = Math.round(clamp(rel / 180, -1, 1) * 29) + 32;
        for (let y = trackY - 1; y <= trackY + 1; y++) put(pipX, y, 255, 255, 255);
      }
      // Cargo capacity meter (green) + radio-link LED at the right end.
      bar(2, 16, 56, 3, q.cargoKg / q.maxCargoKg, 60, 230, 120);
      const online = q.linkStatus !== null && /^online/i.test(q.linkStatus);
      const ledR = q.linkStatus === null ? 30 : online ? 40 : 180;
      const ledG = q.linkStatus === null ? 34 : online ? 255 : 40;
      const ledB = q.linkStatus === null ? 40 : online ? 120 : 40;
      for (let y = 16; y < 19; y++) put(60, y, ledR, ledG, ledB);
      // Target-range ladder (orange): 0 at full-scale DASH_RANGE_FULL_M.
      if (q.targetDistanceM !== null) {
        const ladderFrac = 1 - clamp(q.targetDistanceM / DASH_RANGE_FULL_M, 0, 1);
        const ladderFilled = Math.round(ladderFrac * 59);
        for (let seg = 0; seg < 60; seg++) {
          const on = seg < ladderFilled && seg % 2 === 0;
          if (on) {
            put(2 + seg, 29, 255, 120, 60);
            put(2 + seg, 30, 255, 120, 60);
          }
        }
      }
    }
    tex.update(px);
  }

  /** Instantaneous drivetrain output (kW) from the module's own energy tally. */
  private instantPowerKw(): number {
    if (this.built && !this.disposed) return this.lastPowerKw;
    // Sceneless path: F·v estimate straight off the physics state.
    const s = this.last;
    let force = 0;
    for (const w of s.wheels) force += w.force;
    return (Math.abs(force) * Math.abs(s.vLong)) / 1000;
  }

  /** Copy physics state onto the rover transform, wheels and lamps. */
  private syncTransform(state: BuggyState, dt: number): void {
    const root = this.root;
    if (root === null || this.scene === null || this.scene.isDisposed) return;

    // Physics frame (x, y lateral, z up) → Babylon (x, z up, -y) via the
    // shared converter. Spec 32 §2.5: state.z is the chassis datum's TRUE
    // world elevation (ballistically integrated, terrain-barriered), so the
    // node — and every chassis child riding on it — flies with the rover
    // through lunar hangtime instead of staying tethered to the regolith
    // under it.
    const b = worldToBabylon(state);
    root.position.set(b.x, b.y, b.z);

    // Heading is an x-y-plane yaw (0 = +x) → Babylon azimuth PI/2 + heading
    // (the mapping CameraRig uses for vehicle_chase). YXZ quaternion order
    // keeps that azimuth exact while nose-up pitch (-rotation.x) and roll
    // (+rotation.z) tilt compose inside the yawed frame.
    if (root.rotationQuaternion === null) root.rotationQuaternion = new Quaternion();
    Quaternion.RotationYawPitchRollToRef(
      this.getBabylonYaw(),
      -state.pitch,
      state.roll,
      root.rotationQuaternion,
    );
    root.computeWorldMatrix(true);

    // Rigid chassis body translation (heave). Spec 32 §2.5: the root node
    // now rides at the chassis datum's true world elevation s.z, so the
    // sprung mass IS the root frame — the chassis body sits exactly on the
    // datum (the barriered z integration bounds it by construction, which
    // supersedes the Spec-16 visual heave clamp against a z-pinned body).
    if (this.chassisBody !== null) {
      // Spec 32 §2.5 — visual wheel-suspension decoupling: each corner road
      // wheel (and its pivot) HANGS below the datum by its own suspension
      // deflection via wheelLocalY(). On the ground that lands each wheel
      // centre on its own corner's terrain + R (wheels track the surface,
      // the chassis flies); when `state.airborne` the spring rings out to
      // compression 0 and the road wheels suspend at MAXIMUM droop travel
      // from the chassis body rather than being projected from the terrain
      // floor below.
      for (let i = 0; i < this.wheels.length; i++) {
        const droopY = wheelLocalY(state.wheels[i]?.compression ?? 0.5);
        this.wheels[i].position.y = droopY;
        if (this.cornerPivots[i]) {
          this.cornerPivots[i].position.y = droopY;
        }
      }
      this.chassisBody.position.y = 0;
    }

    // -- Spec 17 §4.2: coilovers compress with per-wheel suspension --------
    // The spring stack scales along its axis (anchored at the chassis top
    // mount); the polished rod telescopes inversely so compression pulls
    // more rod INTO the body. Deterministic: scale = coilScaleFor(compr).
    for (let i = 0; i < this.coilovers.length; i++) {
      const c = state.wheels[i]?.compression ?? 0.5;
      this.coilovers[i].scaling.set(1, coilScaleFor(c), 1);
      const rod = this.damperRods[i];
      if (rod !== undefined) rod.scaling.set(1, rodScaleFor(c), 1);
    }

    // -- Spec 17 §4.2: Ackermann knuckle yaw + live tie-rod tracking ------
    const steerAngle = state.steerAngle ?? 0;
    for (let i = 0; i < 2 && i < this.steeringKnuckles.length; i++) {
      this.steeringKnuckles[i].rotation.set(0, this.ackermannFor(i, steerAngle), 0);
    }
    this.applyTieRods(state);

    // Reactive taillights brightening on braking/reversing
    if (this.taillightMaterial !== null) {
      const isBraking = state.vLong < 0 || (state.driveMode === 'FORWARD' && state.vLong > 0.2 && state.vLong < this.last.vLong);
      this.taillightMaterial.emissiveColor.set(isBraking ? 1.0 : 0.25, 0.02, 0.02);
    }

    // Dynamic cargo crates scaling
    if (this.cargoCrates !== null) {
      const cargoFrac = clamp(state.cargoMass / BUGGY_MAX_CARGO, 0, 1);
      this.cargoCrates.setEnabled(cargoFrac > 0.001);
      this.cargoCrates.scaling.y = Math.max(0.1, cargoFrac);
    }

    // Live telemetry dash: speed + drivetrain kW segment bars, plus the
    // Spec 18 §6.3 quest overlay (nav pip / cargo / link) when active.
    const dJ = state.motorEnergyJ - this.lastMotorEnergyJ;
    const powerKw = Number.isFinite(dJ) && dJ >= 0 ? dJ / Math.max(dt, 1e-6) / 1000 : 0;
    this.lastPowerKw = powerKw;
    this.drawDash(Math.abs(state.vLong), powerKw, state.heading);
    this.lastMotorEnergyJ = state.motorEnergyJ;

    this.applyWheelSpin(state, dt);
    this.applyLamps(state);
    // Spec 37 Phase 2: pulse the holographic cargo webbing / upgrade glows.
    this.animateUpgradeVisuals(dt);
  }

  /**
   * Re-aim both tie-rods between the (fixed) steering-rack ends and the
   * (steering) front knuckle outer attach points, in the chassis-local
   * frame. Each rod's stretch is the true chord length over the rest
   * length, so the rods visibly push/pull with the Ackermann yaw and the
   * chassis-vs-wheel heave — the same solve the knuckles use, every synced
   * frame (Spec 17 §4.2).
   */
  private applyTieRods(state: BuggyState): void {
    if (this.tieRods.length < 2) return;
    const steerAngle = state.steerAngle ?? 0;
    const chassisY = this.chassisBody !== null ? this.chassisBody.position.y : 0;
    const rackEnd = new Vector3();
    const attach = new Vector3();
    for (let i = 0; i < 2; i++) {
      const rod = this.tieRods[i];
      // Wheel-plane height minus chassis-datum height in chassis-local y:
      // Spec 32 §2.5 the corner pivot rides at wheelLocalY(compression) in
      // the datum-riding root frame, the chassis body at chassisY, so the
      // tie-rod attach sees relativeHeave = droop law − chassisY.
      const relativeHeave =
        wheelLocalY(state.wheels[i]?.compression ?? 0.5) - chassisY;
      const chord = this.tieRodChord(i, steerAngle, relativeHeave, rackEnd, attach);

      const dx = attach.x - rackEnd.x;
      const dy = attach.y - rackEnd.y;
      const dz = attach.z - rackEnd.z;
      if (chord > 1e-9) {
        this.scratchDir.set(dx / chord, dy / chord, dz / chord);
        if (rod.rotationQuaternion === null) rod.rotationQuaternion = new Quaternion();
        alignYTo(this.scratchDir, rod.rotationQuaternion);
      }
      rod.position.set(
        (rackEnd.x + attach.x) / 2,
        (rackEnd.y + attach.y) / 2,
        (rackEnd.z + attach.z) / 2,
      );
      rod.scaling.set(1, chord / this.tieRodRestLen, 1);
    }
  }

  /** Animate road-wheel rotation from the physics spin rates (visual only). */
  private applyWheelSpin(state: BuggyState, dt: number): void {
    if (this.wheels.length === 0) return;
    // Integrate the mean road-wheel rate into a phase (rad). Deterministic
    // in dt, fed only by physics spin — never fed back into physics.
    let spin = 0;
    for (const wheel of state.wheels) spin += wheel.spin;
    this.wheelPhase = (this.wheelPhase + (spin / state.wheels.length) * dt) % (Math.PI * 2);

    for (let i = 0; i < this.wheels.length; i++) {
      const wheel = this.wheels[i];
      if (wheel.rotationQuaternion === null) wheel.rotationQuaternion = new Quaternion();
      Quaternion.RotationAxisToRef(AXIS_X, this.wheelPhase, this.scratchSpin);
      this.scratchSpin.multiplyToRef(LAY_DOWN, wheel.rotationQuaternion);

      // Articulate front wheels steering yaw with spin: WheelRotation = R_steer(delta) * R_spin(theta)
      if (i < 2) {
        const delta = this.ackermannFor(i, state.steerAngle ?? 0);
        if (delta !== 0) {
          const steerQuat = Quaternion.RotationAxis(AXIS_Y, delta);
          steerQuat.multiplyToRef(wheel.rotationQuaternion, wheel.rotationQuaternion);
        }
      }
    }
  }

  /** Push headlight on/off, world position and beam aim into the SpotLights. */
  private applyLamps(state: BuggyState): void {
    if (this.lamps.length === 0 || this.scene === null || this.scene.isDisposed) return;
    const root = this.root;
    if (root === null) return;

    // Spec 21 §2.2 / ADR-021-2: Recompute spotlight beam directions dynamically from the
    // buggy chassis orientation matrix, incorporating true pitch and roll:
    // d_beam = R_chassis * (0, -0.07, 1) normalized (-4° downward depression to illuminate dips)
    const matrix = root.getWorldMatrix();
    const localAim = new Vector3(0, -0.07, 1).normalize();
    Vector3.TransformNormalToRef(localAim, matrix, this.scratchAim);
    this.scratchAim.normalize();

    for (let i = 0; i < this.lamps.length; i++) {
      const lampPointIdx = Math.floor(i / 2);
      const isHighBeam = (i % 2) === 1;
      Vector3.TransformCoordinatesToRef(LAMP_POINTS[lampPointIdx], matrix, this.scratchPoint);
      this.lamps[i].position.copyFrom(this.scratchPoint);
      this.lamps[i].direction.copyFrom(this.scratchAim);
      this.lamps[i].intensity = this.lampOn
        ? (isHighBeam ? HIGH_BEAM_INTENSITY : LOW_BEAM_INTENSITY)
        : 0;
    }

    // Spec 23 §2.4.2: sweep the additive dust-scattering shells with the same
    // chassis-derived aim. Each shell sits with its narrow end at the lamp
    // and its mouth down-range: centre = lamp + aim·(L/2), orientation maps
    // the cylinder axis (+y) onto the beam direction. Because the aim comes
    // from the chassis world matrix — recomputed from live pitch/yaw/roll
    // every synced frame — the cones track the suspension without lagging a
    // frame behind the SpotLights (no jitter, no double-smoothing).
    const coneVisible = this.lampOn;
    const alignCone = (cone: Mesh, length: number, lampPointIdx: number): void => {
      Vector3.TransformCoordinatesToRef(LAMP_POINTS[lampPointIdx], matrix, this.scratchPoint);
      cone.position.copyFrom(this.scratchPoint);
      this.scratchBeamOffset.copyFrom(this.scratchAim);
      this.scratchBeamOffset.scaleInPlace(length / 2);
      cone.position.addInPlace(this.scratchBeamOffset);
      if (cone.rotationQuaternion === null) cone.rotationQuaternion = new Quaternion();
      alignYTo(this.scratchAim, cone.rotationQuaternion);
      cone.isVisible = coneVisible;
    };
    for (let i = 0; i < this.beamCones.length; i++) alignCone(this.beamCones[i], BEAM_CONE_FLOOD_M, i);
    for (let i = 0; i < this.beamConesHigh.length; i++) alignCone(this.beamConesHigh[i], BEAM_CONE_HIGH_M, i);
  }

  private static resolvePoint(candidate: MountCandidate | undefined): { x: number; y: number; z: number } | null {
    if (candidate === null || candidate === undefined) return null;
    if (typeof candidate.getPosition === 'function') {
      const p = candidate.getPosition();
      if (p !== null && p !== undefined) return { x: p.x, y: p.y, z: p.z };
    }
    if (typeof candidate.getState === 'function') {
      const s = candidate.getState();
      if (typeof s.x === 'number' && typeof s.y === 'number') {
        return { x: s.x, y: s.y, z: typeof s.z === 'number' ? s.z : 0 };
      }
    }
    if (typeof candidate.x === 'number' && typeof candidate.y === 'number') {
      return { x: candidate.x, y: candidate.y, z: typeof candidate.z === 'number' ? candidate.z : 0 };
    }
    return null;
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

/**
 * Spec 36 Phase 3: the flatbed magnetic cargo hopper.
 *
 * Tracks physical canisters thrown from the speeding Apex Express (Spec 36
 * §2.1/§2.2): inbound canisters integrate under lunar gravity plus the
 * electromagnetic attractor
 *
 *   F_mag = −k_mag·r̂ − c_damp·(v_cargo − v_buggy)
 *
 * while inside the soft capture gradient (R_catch = 1.8 m from the bed
 * centre, relative speed ≤ 6.0 m/s). Crossing the hard physical bed
 * bounding envelope ({@link HOPPER_BED_BOUNDS}) hard-latches the canister:
 * it snaps to the next free slot of the aligned 2×3 stacking grid, gains a
 * procedural PBR child mesh parented to the chassis body, and its mass is
 * loaded through the buggy physics cargo loader — so total mass, inertia
 * and suspension compression all follow (M_total = M_chassis + Σ M_cargo).
 *
 * Sceneless-safe: without a `createItemMesh` factory (or before `init()`)
 * items latch bookkeeping-only and `rebuildMeshes()` catches the visuals up
 * once the rover is built. All state mutations flow through this class —
 * `OpenBuggy` never touches the item list directly.
 */
export class BuggyCargoHopper {
  private readonly owner: OpenBuggy;
  private readonly options: BuggyCargoHopperOptions;
  private items: HopperTrackedItem[] = [];
  private nextId = 1;
  private hopperDisposed = false;
  /**
   * Spec 37 Phase 2: live ceiling — 6 on the stock hopper, raised to 12 by
   * the Tier-2 Extended Freight Flatbed through {@link setCapacity}.
   */
  private capacity = HOPPER_CAPACITY;

  constructor(owner: OpenBuggy, options: BuggyCargoHopperOptions = {}) {
    this.owner = owner;
    this.options = options;
  }

  /** Hopper ceiling: 6 stock canisters, 12 with the Tier-2 flatbed. */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Raise/restore the slot ceiling (Spec 37 §2.1 Tier 2: 6 → 12). Clamped
   * to `[1, HOPPER_EXTENDED_CAPACITY]`; returns the ceiling now in force.
   * Latched items are untouched — shrinking never drops cargo.
   */
  setCapacity(slots: number): number {
    if (!Number.isFinite(slots)) return this.capacity;
    this.capacity = Math.min(HOPPER_EXTENDED_CAPACITY, Math.max(1, Math.trunc(slots)));
    return this.capacity;
  }

  /** True once every grid slot holds a latched canister. */
  isFull(): boolean {
    return this.latchedCount() >= this.capacity;
  }

  /**
   * Mount a canister straight into the next free grid slot (hard latch),
   * as the moving-frame capture arbiter does on a clean gap cross. Returns
   * the item snapshot, or null when the hopper is already full.
   */
  addCargo(type: HeistMoonCargoType): BuggyCargoItem | null {
    if (this.hopperDisposed || this.isFull()) return null;
    const item = this.makeItem(type);
    this.items.push(item);
    this.latchItem(item);
    return BuggyCargoHopper.copyItem(item);
  }

  /**
   * Release a canister into the attractor field with a world-frame
   * position and velocity (e.g. `v_train + v_throw` from the catwalk). The
   * canister integrates through {@link step} until it crosses the bed
   * envelope (latch) or ages out of the window (dropped).
   */
  launchCargo(type: HeistMoonCargoType, position: HopperVec3, velocity: HopperVec3): BuggyCargoItem | null {
    if (this.hopperDisposed || this.isFull()) return null;
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
      return null;
    }
    const item = this.makeItem(type);
    item.state = 'INBOUND';
    item.slot = -1;
    item.position = { x: position.x, y: position.y, z: position.z };
    item.velocity = {
      x: Number.isFinite(velocity.x) ? velocity.x : 0,
      y: Number.isFinite(velocity.y) ? velocity.y : 0,
      z: Number.isFinite(velocity.z) ? velocity.z : 0,
    };
    this.items.push(item);
    return BuggyCargoHopper.copyItem(item);
  }

  /**
   * Advance every inbound canister one frame: vacuum ballistics (g = 1.62
   * m/s² down) plus the magnetic attractor while inside the capture
   * envelope, then hard-latch on bed-envelope containment. Returns the
   * canisters that latched on this frame (empty most frames).
   */
  step(dt: number): BuggyCargoItem[] {
    const latched: BuggyCargoItem[] = [];
    if (this.hopperDisposed || !Number.isFinite(dt) || dt <= 0) return latched;
    for (const item of [...this.items]) {
      if (item.state !== 'INBOUND') continue;
      item.ageS += dt;
      const field = this.evaluateCapture(item.position, item.velocity);
      const invMass = 1 / item.massKg;
      item.velocity.x += field.force.x * invMass * dt;
      item.velocity.y += field.force.y * invMass * dt;
      item.velocity.z += (field.force.z * invMass - LUNAR_GRAVITY) * dt;
      item.position.x += item.velocity.x * dt;
      item.position.y += item.velocity.y * dt;
      item.position.z += item.velocity.z * dt;
      if (field.insideBedBounds && !this.isFull()) {
        this.latchItem(item);
        latched.push(BuggyCargoHopper.copyItem(item));
        continue;
      }
      if (item.ageS > HOPPER_INBOUND_MAX_AGE_S) {
        // Missed the hopper — drop it from tracking (never weighed).
        const idx = this.items.indexOf(item);
        if (idx >= 0) this.items.splice(idx, 1);
      }
    }
    return latched;
  }

  /**
   * Sample the attractor field at a candidate canister state (world-frame
   * position + velocity): distance/relative-speed gates and the F_mag
   * vector the field would apply. Pure — mutates nothing.
   */
  evaluateCapture(position: HopperVec3, velocity: HopperVec3): HopperCaptureField {
    const centre = this.bedCentreWorld();
    const buggyV = this.buggyVelocityWorld();
    const dx = position.x - centre.x;
    const dy = position.y - centre.y;
    const dz = position.z - centre.z;
    const dist = Math.hypot(dx, dy, dz);
    const rvx = velocity.x - buggyV.x;
    const rvy = velocity.y - buggyV.y;
    const rvz = velocity.z - buggyV.z;
    const relSpeed = Math.hypot(rvx, rvy, rvz);
    const within =
      dist <= HOPPER_CATCH_RADIUS_M && relSpeed <= HOPPER_RELATIVE_MAX_MPS;
    let fx = 0;
    let fy = 0;
    let fz = 0;
    if (within && dist > 1e-9) {
      const kOverDist = HOPPER_K_MAG_N / dist;
      fx = -kOverDist * dx - HOPPER_C_DAMP_NS_M * rvx;
      fy = -kOverDist * dy - HOPPER_C_DAMP_NS_M * rvy;
      fz = -kOverDist * dz - HOPPER_C_DAMP_NS_M * rvz;
    }
    return {
      distanceToBedCentreM: dist,
      relativeSpeedMps: relSpeed,
      withinCatchEnvelope: within,
      insideBedBounds: BuggyCargoHopper.insideBedLocal(this.bedLocalOffset(position, centre), this.owner.getHeading()),
      force: { x: fx, y: fy, z: fz },
    };
  }

  /** World-frame bed-centre point (chassis datum + {@link HOPPER_BED_CENTRE}). */
  bedCentreWorld(): HopperVec3 {
    return this.owner.pointAt(HOPPER_BED_CENTRE_MODEL.z, HOPPER_BED_CENTRE_MODEL.x, HOPPER_BED_CENTRE_MODEL.y);
  }

  /** True when `point` sits inside the hard physical bed envelope. */
  isInsideBedBounds(point: HopperVec3): boolean {
    return BuggyCargoHopper.insideBedLocal(
      this.bedLocalOffset(point, this.bedCentreWorld()),
      this.owner.getHeading(),
    );
  }

  /**
   * Unload the flatbed: every tracked canister (inbound or latched) is
   * dropped, its mesh disposed, and the latched mass is taken back off the
   * physics loader. The bed returns to empty.
   */
  clearCargo(): void {
    if (this.hopperDisposed) return;
    let massKg = 0;
    for (const item of this.items) {
      if (item.state === 'LATCHED') massKg += item.massKg;
      this.dropMesh(item);
    }
    this.items = [];
    if (massKg > 0) this.options.applyMassDelta?.(-massKg);
  }

  /** Snapshots of every tracked canister (inbound + latched), slot order. */
  getCargoItems(): BuggyCargoItem[] {
    return this.items.map(BuggyCargoHopper.copyItem);
  }

  /** Latched cargo mass aboard the flatbed (kg) — Σ M_cargo. */
  getCargoMassKg(): number {
    let kg = 0;
    for (const item of this.items) {
      if (item.state === 'LATCHED') kg += item.massKg;
    }
    return kg;
  }

  /** M_chassis + Σ M_cargo (kg), straight off the physics loader. */
  getGrossVehicleMassKg(): number {
    return this.owner.physics.totalMass;
  }

  /** Latched canister meshes (visual readback for headless harnesses). */
  getMeshes(): Mesh[] {
    const meshes: Mesh[] = [];
    for (const item of this.items) {
      if (item.state === 'LATCHED' && item.mesh !== null) meshes.push(item.mesh);
    }
    return meshes;
  }

  /**
   * Create meshes for latched items that latched while sceneless (e.g. a
   * test harness or a pre-`init()` catch). Idempotent; safe to call on
   * every `OpenBuggy.init()`.
   */
  rebuildMeshes(): void {
    if (this.hopperDisposed) return;
    for (const item of this.items) {
      if (item.state === 'LATCHED' && item.mesh === null) this.attachMesh(item);
    }
  }

  /** Release the hopper's own mesh refs (the owner disposes the entity). */
  dispose(): void {
    if (this.hopperDisposed) return;
    this.clearCargo();
    this.hopperDisposed = true;
  }

  // -- internals -----------------------------------------------------------------

  /** Latched subset count. */
  private latchedCount(): number {
    let n = 0;
    for (const item of this.items) if (item.state === 'LATCHED') n += 1;
    return n;
  }

  /** Fresh bookkeeping record for one canister (mass from the cargo table). */
  private makeItem(type: HeistMoonCargoType): HopperTrackedItem {
    const spec = HEIST_MOON_CARGO[type];
    return {
      id: this.nextId++,
      type,
      label: spec.label,
      massKg: spec.unitMassKg,
      state: 'LATCHED',
      slot: -1,
      localOffset: { x: 0, y: 0, z: 0 },
      position: this.bedCentreWorld(),
      velocity: { x: 0, y: 0, z: 0 },
      ageS: 0,
      mesh: null,
    };
  }

  /**
   * Hard-latch: assign the first free 2×3 grid slot, rest the canister on
   * the bed floor above it, mount the procedural mesh, and load the mass
   * through the physics cargo loader (inertia + suspension follow).
   */
  private latchItem(item: HopperTrackedItem): void {
    const slot = this.firstFreeSlot();
    if (slot < 0) return;
    item.state = 'LATCHED';
    item.slot = slot;
    item.localOffset = BuggyCargoHopper.restOffset(item.type, slot);
    // World rest pose from the model offset (pointAt takes forward/left/up).
    item.position = this.owner.pointAt(item.localOffset.z, item.localOffset.x, item.localOffset.y);
    item.velocity = { x: 0, y: 0, z: 0 };
    this.attachMesh(item);
    this.options.applyMassDelta?.(item.massKg);
    this.options.onLatch?.(BuggyCargoHopper.copyItem(item));
  }

  /** Next unoccupied grid slot in stack order, or −1 when the bed is full. */
  private firstFreeSlot(): number {
    const used = new Set<number>();
    for (const item of this.items) {
      if (item.state === 'LATCHED') used.add(item.slot);
    }
    for (let s = 0; s < this.capacity; s++) {
      if (!used.has(s)) return s;
    }
    return -1;
  }

  /** Rest offset in the Babylon model frame for `type` in grid `slot`:
   *  grid column/row (upper deck for slots 6..11, Spec 37 Tier 2) + half
   *  the container height off that deck's floor. */
  private static restOffset(type: HeistMoonCargoType, slot: number): HopperVec3 {
    const grid = hopperGridSlot(slot);
    const shape = HOPPER_ITEM_SHAPE[type];
    const deckY = HOPPER_BED_FLOOR_Y + (grid.deck === 1 ? HOPPER_UPPER_DECK_Y : 0);
    return { x: grid.x, y: deckY + shape.height / 2, z: grid.z };
  }

  /** World offset from the bed centre → hopper-local (lat, lon, up) about
   *  the buggy heading (pitch/roll ignored: the envelope rides the datum). */
  private bedLocalOffset(point: HopperVec3, centre: HopperVec3): { lat: number; lon: number; up: number } {
    const h = this.owner.getHeading();
    const cos = Math.cos(h);
    const sin = Math.sin(h);
    const dx = point.x - centre.x;
    const dy = point.y - centre.y;
    const dz = point.z - centre.z;
    return {
      lat: -dx * sin + dy * cos,
      lon: dx * cos + dy * sin,
      up: dz,
    };
  }

  /** Containment test in hopper-local half-extents. */
  private static insideBedLocal(ofs: { lat: number; lon: number; up: number }, _heading: number): boolean {
    return (
      Math.abs(ofs.lat) <= HOPPER_BED_HALF.lat &&
      Math.abs(ofs.lon) <= HOPPER_BED_HALF.lon &&
      Math.abs(ofs.up) <= HOPPER_BED_HALF.up
    );
  }

  /** Chassis-datum world velocity (vLong/vLat rotated by heading + heave). */
  private buggyVelocityWorld(): HopperVec3 {
    const h = this.owner.getHeading();
    const cos = Math.cos(h);
    const sin = Math.sin(h);
    const vLong = this.owner.getVLong();
    const vLat = this.owner.getVLat();
    const state = this.owner.getState() as BuggyState & { vBody?: number };
    return {
      x: vLong * cos - vLat * sin,
      y: vLong * sin + vLat * cos,
      z: Number.isFinite(state.vBody) ? (state.vBody as number) : 0,
    };
  }

  /** Mount the procedural PBR canister mesh for a latched item. */
  private attachMesh(item: HopperTrackedItem): void {
    if (item.mesh !== null) return;
    const mesh = this.options.createItemMesh?.(item.type, item.slot, item.localOffset) ?? null;
    item.mesh = mesh;
  }

  /** Dispose + unbind an item's mesh (quietly — teardown races allowed). */
  private dropMesh(item: HopperTrackedItem): void {
    const mesh = item.mesh;
    if (mesh === null) return;
    item.mesh = null;
    try {
      if (this.options.disposeItemMesh !== undefined) this.options.disposeItemMesh(mesh);
      else mesh.dispose();
    } catch {
      // Engine torn down first — never propagate.
    }
  }

  /** Public view of a tracked item (mesh/velocity/age stripped off). */
  private static copyItem(item: HopperTrackedItem): BuggyCargoItem {
    return {
      id: item.id,
      type: item.type,
      label: item.label,
      massKg: item.massKg,
      state: item.state,
      slot: item.slot,
      localOffset: { ...item.localOffset },
      position: { x: item.position.x, y: item.position.y, z: item.position.z },
    };
  }
}

/** Internal bookkeeping record: public item + integration/visual state. */
interface HopperTrackedItem extends BuggyCargoItem {
  velocity: HopperVec3;
  /** Seconds since release (inbound); frozen at latch. */
  ageS: number;
  /** Procedural bed mesh while latched (null when sceneless). */
  mesh: Mesh | null;
}

export default OpenBuggy;
