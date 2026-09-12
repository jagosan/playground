/**
 * Lunar Frontier — open-top lunar buggy entity (TASK-PLAY-049b).
 *
 * Visual/interaction wrapper over the EXISTING traversal physics module: owns
 * one `LunarBuggy` (from ../physics/TraversalPhysics.ts) and dresses it in a
 * procedural Babylon.js rover. No physics in this file — no gravity, no
 * integration, no duplicated BUGGY_* constants. `update(dt, input)` steps the
 * owned buggy exactly once and copies the resulting `BuggyState` onto meshes,
 * wheels and headlights.
 *
 * Meshes (procedural only, no GLB): chassis box, flatbed box, seat base +
 * back, three-cylinder roll bar, axle stub, and four cylinders at
 * ±BUGGY_TRACK/2 with radius BUGGY_WHEEL_RADIUS, spinning from the per-wheel
 * `WheelState.spin` rates. Two SpotLight headlights sit outboard up front.
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
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';

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
  rollPost: { diameter: 0.08, height: 1.0, y: 0.9, z: -0.62, dx: 0.62 },
  rollBar: { diameter: 0.08, length: 1.5, y: 1.38, z: -0.62 },
  wheel: { depth: 0.34, tessellation: 20, axle: 1.35 },
  hub: { diameter: 0.16, length: 1.62 },
  lamp: { lateral: 0.66, y: 0.42, z: 1.35 },
} as const;

/** Wheel mount slots: front-left, front-right, rear-left, rear-right. */
const WHEEL_SLOTS: ReadonlyArray<{ z: number; side: 1 | -1 }> = [
  { z: GEO.wheel.axle, side: 1 },
  { z: GEO.wheel.axle, side: -1 },
  { z: -GEO.wheel.axle, side: 1 },
  { z: -GEO.wheel.axle, side: -1 },
];

const AXIS_X = new Vector3(1, 0, 0);
/** Tyre lay-down: cylinder axis local +y → axle axis local +x (left). */
const LAY_DOWN = Quaternion.RotationAxis(new Vector3(0, 0, 1), -Math.PI / 2);
/** Lamp attach points in the model frame: index 0 = left, 1 = right. */
const LAMP_POINTS = [
  new Vector3(GEO.lamp.lateral, GEO.lamp.y, GEO.lamp.z),
  new Vector3(-GEO.lamp.lateral, GEO.lamp.y, GEO.lamp.z),
];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
  private chassis: Mesh | null = null;
  private parts: Mesh[] = [];
  private wheels: Mesh[] = [];
  private lamps: SpotLight[] = [];
  private materials: PBRMaterial[] = [];

  private lampOn: boolean;
  private mounted = false;
  private built = false;
  private disposed = false;
  /** Road-wheel spin phase (rad), integrated from `WheelState.spin`. */
  private wheelPhase = 0;
  /** Most recently stepped state — keeps getters honest across scene life. */
  private last: BuggyState;

  /** Scratch objects for the per-frame lamp maths (no GC churn). */
  private readonly scratchAim = new Vector3(1, 0, 0);
  private readonly scratchPoint = new Vector3();
  private readonly scratchSpin = new Quaternion();

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
   * transform, road-wheel spin and headlights from the result. Performs no
   * integration of its own and mutates no input. Safe after `dispose()`
   * (physics-only — keeps stepping and still returns finite state).
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

  /** Procedural rover: chassis, flatbed, seat, roll bar, 4 wheels, 2 lamps. */
  private buildRover(scene: Scene): void {
    const p = this.prefix;

    const paint = new PBRMaterial(`${p}-paint`, scene);
    paint.albedoColor = new Color3(0.78, 0.55, 0.18); // hazard yellow, dusted
    paint.metallic = 0.2;
    paint.roughness = 0.62;
    paint.environmentIntensity = 0.05; // vacuum: almost nothing to reflect

    const hardware = new PBRMaterial(`${p}-hardware`, scene);
    hardware.albedoColor = new Color3(0.55, 0.53, 0.52); // dusted gear grey
    hardware.metallic = 0.5;
    hardware.roughness = 0.5;
    hardware.environmentIntensity = 0.05;

    const rubber = new PBRMaterial(`${p}-rubber`, scene);
    rubber.albedoColor = new Color3(0.09, 0.09, 0.1); // wire-mesh tyre dark
    rubber.metallic = 0.1;
    rubber.roughness = 0.95;
    rubber.environmentIntensity = 0.05;

    this.materials = [paint, hardware, rubber];
    this.root = new TransformNode(`${p}-rover`, scene);

    const chassis = MeshBuilder.CreateBox(
      `${p}-chassis`,
      { width: GEO.chassis.width, height: GEO.chassis.height, depth: GEO.chassis.depth },
      scene,
    );
    chassis.material = hardware;
    this.chassis = chassis;

    const bed = MeshBuilder.CreateBox(
      `${p}-bed`,
      { width: GEO.bed.width, height: GEO.bed.height, depth: GEO.bed.depth },
      scene,
    );
    bed.position.set(0, GEO.bed.y, GEO.bed.z);
    bed.material = paint;

    const seat = MeshBuilder.CreateBox(
      `${p}-seat`,
      { width: GEO.seat.width, height: GEO.seat.height, depth: GEO.seat.depth },
      scene,
    );
    seat.position.set(GEO.seat.x, GEO.seat.y, GEO.seat.z);
    seat.material = rubber;

    const seatBack = MeshBuilder.CreateBox(
      `${p}-seat-back`,
      { width: GEO.seatBack.width, height: GEO.seatBack.height, depth: GEO.seatBack.depth },
      scene,
    );
    seatBack.position.set(GEO.seatBack.x, GEO.seatBack.y, GEO.seatBack.z);
    seatBack.material = rubber;

    const postL = MeshBuilder.CreateCylinder(
      `${p}-roll-post-l`,
      { diameter: GEO.rollPost.diameter, height: GEO.rollPost.height },
      scene,
    );
    postL.position.set(GEO.rollPost.dx, GEO.rollPost.y, GEO.rollPost.z);
    postL.material = hardware;

    const postR = MeshBuilder.CreateCylinder(
      `${p}-roll-post-r`,
      { diameter: GEO.rollPost.diameter, height: GEO.rollPost.height },
      scene,
    );
    postR.position.set(-GEO.rollPost.dx, GEO.rollPost.y, GEO.rollPost.z);
    postR.material = hardware;

    // Crossbar + axle stub run across the rover (model x): lay the cylinders
    // on their sides with a 90° roll about the nose axis.
    const crossbar = MeshBuilder.CreateCylinder(
      `${p}-roll-bar`,
      { diameter: GEO.rollBar.diameter, height: GEO.rollBar.length },
      scene,
    );
    crossbar.position.set(0, GEO.rollBar.y, GEO.rollBar.z);
    crossbar.rotation.set(0, 0, -Math.PI / 2);
    crossbar.material = hardware;

    const hub = MeshBuilder.CreateCylinder(
      `${p}-axle`,
      { diameter: GEO.hub.diameter, height: GEO.hub.length },
      scene,
    );
    hub.rotation.set(0, 0, -Math.PI / 2);
    hub.position.set(0, BUGGY_WHEEL_RADIUS * 0.6, 0);
    hub.material = hardware;

    // Wheels: radius BUGGY_WHEEL_RADIUS, hubs at ±BUGGY_TRACK/2 (model x) on
    // two axles (model z). Side +1 = physics left = model +x. Cylinder axis
    // starts vertical (+y); LAY_DOWN tips it onto the axle axis and the spin
    // quaternion turns the tyre in its own plane (order verified headless).
    const wheelDiameter = BUGGY_WHEEL_RADIUS * 2;
    this.wheels = WHEEL_SLOTS.map((slot, index) => {
      const wheel = MeshBuilder.CreateCylinder(
        `${p}-wheel-${index}`,
        { diameter: wheelDiameter, height: GEO.wheel.depth, tessellation: GEO.wheel.tessellation },
        scene,
      );
      wheel.position.set(slot.side * (BUGGY_TRACK / 2), BUGGY_WHEEL_RADIUS, slot.z);
      wheel.material = rubber;
      return wheel;
    });

    this.parts = [chassis, bed, seat, seatBack, postL, postR, crossbar, hub, ...this.wheels];
    for (const mesh of this.parts) {
      mesh.parent = this.root;
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

    // Heave + suspension articulation: chassis rides the physics datum, wheel
    // centres sit at wheel radius minus travel around the static mid stroke.
    if (this.chassis !== null) {
      this.chassis.position.y = state.bodyHeight;
    }
    for (let i = 0; i < this.wheels.length; i++) {
      this.wheels[i].position.y =
        BUGGY_WHEEL_RADIUS - (state.wheels[i].compression - 0.5) * BUGGY_SPRING_TRAVEL;
    }

    this.applyWheelSpin(state, dt);
    this.applyLamps(state);
  }

  /** Animate road-wheel rotation from the physics spin rates (visual only). */
  private applyWheelSpin(state: BuggyState, dt: number): void {
    if (this.wheels.length === 0) return;
    // Integrate the mean road-wheel rate into a phase (rad). Deterministic
    // in dt, fed only by physics spin — never fed back into physics.
    let spin = 0;
    for (const wheel of state.wheels) spin += wheel.spin;
    this.wheelPhase = (this.wheelPhase + (spin / state.wheels.length) * dt) % (Math.PI * 2);

    for (const wheel of this.wheels) {
      if (wheel.rotationQuaternion === null) wheel.rotationQuaternion = new Quaternion();
      Quaternion.RotationAxisToRef(AXIS_X, this.wheelPhase, this.scratchSpin);
      this.scratchSpin.multiplyToRef(LAY_DOWN, wheel.rotationQuaternion);
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
