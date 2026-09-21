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
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';

import {
  BUGGY_BATTERY_KWH,
  BUGGY_MAX_CARGO,
  BUGGY_SPRING_TRAVEL,
  BUGGY_TRACK,
  BUGGY_WHEEL_RADIUS,
  IDLE_BUGGY_INPUT,
  LunarBuggy,
  type BuggyInput,
  type BuggyOptions,
  type BuggyState,
  type GroundElevationFn,
} from '../physics/TraversalPhysics.ts';
import { babylonToWorld, worldToBabylon } from '../engine/CameraRig.ts';

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
  private lamps: SpotLight[] = [];
  private materials: PBRMaterial[] = [];
  /** Procedural textures owned by the entity (dash, carbon weave). */
  private ownedTextures: RawTexture[] = [];

  private lampOn: boolean;
  private mounted = false;
  private built = false;
  private disposed = false;
  /** Road-wheel spin phase (rad), integrated from `WheelState.spin`. */
  private wheelPhase = 0;
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
    if (this.built && !this.disposed) this.syncTransform(state, dt);
    return { ...state };
  }

  /** Tear down rover nodes, lights, materials and any self-owned engine. Never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;
    this.mounted = false;

    for (const lamp of this.lamps) OpenBuggy.disposeQuietly(lamp);
    this.lamps = [];
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
      batteryFraction: clamp(s.batteryKwh / BUGGY_BATTERY_KWH, 0, 1),
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
    const wheelsList: Mesh[] = [];
    const mudFlapsList: Mesh[] = [];

    const wheelDiameter = BUGGY_WHEEL_RADIUS * 2;

    // Nominal tie-rod chord (rest length) straight ahead at static ride:
    // wheel plane sits CHASSIS_DATUM_RISE below the chassis datum.
    {
      const a = new Vector3();
      const b = new Vector3();
      this.tieRodRestLen = this.tieRodChord(0, 0, -CHASSIS_DATUM_RISE, a, b);
    }

    for (let i = 0; i < WHEEL_SLOTS.length; i++) {
      const slot = WHEEL_SLOTS[i];
      const isFront = i < 2;
      const cornerPivot = new TransformNode(`${p}-corner-pivot-${i}`, scene);
      cornerPivot.parent = this.root;
      cornerPivot.position.set(slot.side * (BUGGY_TRACK / 2), BUGGY_WHEEL_RADIUS, slot.z);
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
      wheel.position.set(slot.side * (BUGGY_TRACK / 2), BUGGY_WHEEL_RADIUS, slot.z);
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

    // Headlights stay UNPARENTED and get their world position recomputed from
    // the root matrix every frame (see applyLamps), so both beams remain
    // truthful under NullEngine where no render loop propagates parenting.
    this.lamps = LAMP_POINTS.map((_, index) => {
      const lamp = new SpotLight(
        `${p}-headlight-${index === 0 ? 'l' : 'r'}`,
        LAMP_POINTS[index].clone(),
        new Vector3(0, 0, 1),
        (HEADLIGHT_ANGLE_DEG * Math.PI) / 180,
        2,
        scene,
      );
      lamp.range = HEADLIGHT_RANGE_M;
      lamp.diffuse = new Color3(1, 0.96, 0.86);
      return lamp;
    });
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
    // shared converter; state.z is the sampled ground under the chassis, so
    // the node origin sits on the regolith and the body rides above it.
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

    // Rigid chassis body translation (heave): all chassis children move
    // together. Spec 16 §2.2 guard — the chassis may separate from the
    // wheel-centre plane only by the suspension travel plus the static ride
    // datum, so a transient physics excursion can never read as the body
    // oscillating chaotically against its wheels.
    if (this.chassisBody !== null) {
      let meanWheelY = 0;
      for (let i = 0; i < this.wheels.length; i++) {
        const springOffset = -(state.wheels[i].compression - 0.5) * BUGGY_SPRING_TRAVEL;
        this.wheels[i].position.y = BUGGY_WHEEL_RADIUS + springOffset;
        if (this.cornerPivots[i]) {
          this.cornerPivots[i].position.y = BUGGY_WHEEL_RADIUS + springOffset;
        }
        meanWheelY += springOffset;
      }
      meanWheelY = BUGGY_WHEEL_RADIUS + meanWheelY / Math.max(this.wheels.length, 1);
      const chassisNominal = meanWheelY + CHASSIS_DATUM_RISE;
      this.chassisBody.position.y = clamp(
        state.bodyHeight,
        chassisNominal - BUGGY_SPRING_TRAVEL,
        chassisNominal + BUGGY_SPRING_TRAVEL,
      );
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
    const chassisY = this.chassisBody !== null ? this.chassisBody.position.y : BUGGY_WHEEL_RADIUS + CHASSIS_DATUM_RISE;
    const rackEnd = new Vector3();
    const attach = new Vector3();
    for (let i = 0; i < 2; i++) {
      const rod = this.tieRods[i];
      // Wheel-plane height minus chassis-datum height, in chassis-local y:
      // corner pivot sits at R + springOffset (root frame), datum at
      // chassisY, so relative heave = R + springOffset − chassisY.
      const springOffset = -(state.wheels[i].compression - 0.5) * BUGGY_SPRING_TRAVEL;
      const relativeHeave = BUGGY_WHEEL_RADIUS + springOffset - chassisY;
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

    // Physics-forward (cos h, sin h, 0) → Babylon (cos h, 0, -sin h).
    this.scratchAim.set(Math.cos(state.heading), 0, -Math.sin(state.heading));
    const matrix = root.getWorldMatrix();
    const intensity = this.lampOn ? HEADLIGHT_INTENSITY : 0;

    for (let i = 0; i < this.lamps.length; i++) {
      Vector3.TransformCoordinatesToRef(LAMP_POINTS[i], matrix, this.scratchPoint);
      this.lamps[i].position.copyFrom(this.scratchPoint);
      this.lamps[i].direction.copyFrom(this.scratchAim);
      this.lamps[i].intensity = intensity;
    }
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

export default OpenBuggy;
