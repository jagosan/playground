/**
 * Lunar Frontier — on-foot EVA suit avatar entity (TASK-PLAY-049a).
 *
 * Visual/state wrapper over the EXISTING traversal physics module: owns one
 * `LunarEvaSuit` (from ../physics/TraversalPhysics.ts) and dresses it in a
 * procedural Babylon.js astronaut. No physics in this file — no gravity, no
 * integration, no duplicated SUIT_* constants. `update(dt, input)` steps the
 * owned suit once and copies the resulting `SuitState` onto the meshes.
 *
 * Meshes (procedural only, no GLB): torso capsule, helmet sphere, gold visor
 * ellipsoid, PLSS backpack box, chest console box, two leg capsules, and a
 * helmet SpotLight.
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
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
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
/** Helmet lamp intensity while lit (Spec 21 §2.2). */
export const HEADLIGHT_INTENSITY = 2.0;
/** Helmet lamp cone full angle, degrees (Spec 21 §2.2). */
export const HEADLIGHT_ANGLE_DEG = 70;
/** Helmet lamp beam range, metres (Spec 21 §2.2). */
export const HEADLIGHT_RANGE_M = 30;
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
/** Peak leg swing amplitude (rad); arms/torso counter-move at half rate. */
export const LEG_SWING_RAD = 0.42;
/** Torso counter-bob amplitude (m). */
export const TORSO_BOB_M = 0.025;

/**
 * Spec 19 §2.3 / ADR-4: the suit backpack hauls at most this many kilograms
 * of ore. The 50 kg ceiling is the logistical argument for deploying the
 * 500 kg-capacity rover — mining on foot caps (or rejects) above it.
 */
export const SUIT_MAX_CARGO_KG = 50;

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

/** Body geometry, metres. Local frame: +y up, +z is the helmet facing. */
const GEO = {
  torso: { radius: 0.29, height: 1.0, y: 0.84 },
  helmet: { y: 1.56, diameter: 0.44 },
  visor: { y: 1.58, z: 0.14, diameter: 0.42, sx: 0.88, sy: 0.6, sz: 0.9 },
  backpack: { y: 1.16, z: -0.36, width: 0.52, height: 0.66, depth: 0.24 },
  console: { y: 1.16, z: 0.3, size: 0.22 },
  leg: { radius: 0.13, height: 0.68, y: 0.34, dx: 0.16 },
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
  private parts: Mesh[] = [];
  private visor: Mesh | null = null;
  private torso: Mesh | null = null;
  private legL: Mesh | null = null;
  private legR: Mesh | null = null;
  /** Locomotion walk-cycle clock (radians of phase), advanced in syncTransform. */
  private walkCycleTime = 0;
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
    for (const material of this.materials) EvaSuitAvatar.disposeQuietly(material);
    this.materials = [];
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

  // -- internals --------------------------------------------------------------

  /** Procedural astronaut: torso, helmet, gold visor, PLSS, console, legs, lamp. */
  private buildAvatar(scene: Scene): void {
    const p = this.prefix;

    const fabric = new PBRMaterial(`${p}-fabric`, scene);
    fabric.albedoColor = new Color3(0.86, 0.86, 0.83); // sun-bleached white
    fabric.metallic = 0.0;
    fabric.roughness = 0.74;
    fabric.environmentIntensity = 0.05; // vacuum: almost nothing to reflect

    const hardware = new PBRMaterial(`${p}-hardware`, scene);
    hardware.albedoColor = new Color3(0.6, 0.58, 0.56); // dusted gear grey
    hardware.metallic = 0.45;
    hardware.roughness = 0.55;
    hardware.environmentIntensity = 0.05;

    const gold = new PBRMaterial(`${p}-visor-gold`, scene);
    // Apollo EVA gold-sputtered sun visor: bright reflective amber, near-mirror
    // metalness (TASK-PLAY-060, spec §3.6 visual definition).
    gold.albedoColor = new Color3(0.92, 0.76, 0.22);
    gold.metallic = 0.95;
    gold.roughness = 0.12;
    gold.emissiveColor = new Color3(0.62, 0.4, 0.08); // classic gold EVA glow
    gold.environmentIntensity = 0.05;

    this.materials = [fabric, hardware, gold];
    this.root = new TransformNode(`${p}-avatar`, scene);

    const torso = MeshBuilder.CreateCapsule(
      `${p}-torso`,
      { radius: GEO.torso.radius, height: GEO.torso.height },
      scene,
    );
    torso.position.set(0, GEO.torso.y, 0);
    torso.material = fabric;

    const helmet = MeshBuilder.CreateSphere(
      `${p}-helmet`,
      { diameter: GEO.helmet.diameter, segments: 16 },
      scene,
    );
    helmet.position.set(0, GEO.helmet.y, 0);
    helmet.material = fabric;

    const visor = MeshBuilder.CreateSphere(
      `${p}-visor`,
      { diameter: GEO.visor.diameter, segments: 16 },
      scene,
    );
    visor.position.set(0, GEO.visor.y, GEO.visor.z);
    visor.scaling.set(GEO.visor.sx, GEO.visor.sy, GEO.visor.sz);
    visor.material = gold;
    this.visor = visor;

    const backpack = MeshBuilder.CreateBox(
      `${p}-backpack`,
      {
        width: GEO.backpack.width,
        height: GEO.backpack.height,
        depth: GEO.backpack.depth,
      },
      scene,
    );
    backpack.position.set(0, GEO.backpack.y, GEO.backpack.z);
    backpack.material = hardware;

    const consoleBox = MeshBuilder.CreateBox(
      `${p}-console`,
      { size: GEO.console.size },
      scene,
    );
    consoleBox.position.set(0, GEO.console.y, GEO.console.z);
    consoleBox.material = hardware;

    const legL = MeshBuilder.CreateCapsule(
      `${p}-leg-l`,
      { radius: GEO.leg.radius, height: GEO.leg.height },
      scene,
    );
    legL.position.set(-GEO.leg.dx, GEO.leg.y, 0);
    legL.material = fabric;

    const legR = MeshBuilder.CreateCapsule(
      `${p}-leg-r`,
      { radius: GEO.leg.radius, height: GEO.leg.height },
      scene,
    );
    legR.position.set(GEO.leg.dx, GEO.leg.y, 0);
    legR.material = fabric;

    this.torso = torso;
    this.legL = legL;
    this.legR = legR;

    this.parts = [torso, helmet, visor, backpack, consoleBox, legL, legR];
    for (const mesh of this.parts) {
      mesh.parent = this.root;
      mesh.isPickable = true;
      mesh.receiveShadows = false;
    }

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
   * Procedural walking articulation (TASK-PLAY-060, spec §3.6): counter-phase
   * leg swing and torso counter-bob driven by a locomotion clock. Visual only
   * — physics stays in `LunarEvaSuit`. Stopped or airborne the pose snaps back
   * to neutral standing.
   */
  private applyWalkCycle(state: SuitState): void {
    const torso = this.torso;
    const legL = this.legL;
    const legR = this.legR;
    if (torso === null || legL === null || legR === null) return;

    const speed = Math.hypot(state.vx, state.vy);
    if (speed > WALK_MIN_SPEED && state.isGrounded) {
      // Sprint cadence above SPRINT_MIN_SPEED, brisk lunar walk below.
      const rate = speed > SPRINT_MIN_SPEED ? SPRINT_CYCLE_RATE : WALK_CYCLE_RATE;
      this.walkCycleTime += rate * WALK_CYCLE_FRAME_S;
      const swing = Math.sin(this.walkCycleTime) * LEG_SWING_RAD;
      legL.rotation.x = swing;
      legR.rotation.x = -swing;
      // Torso counter-bob at twice the leg frequency (heel-strike impacts).
      torso.position.y = GEO.torso.y + Math.abs(Math.sin(this.walkCycleTime * 2)) * TORSO_BOB_M;
    } else {
      // Stopped or airborne: neutral standing pose, clock parked for next start.
      this.walkCycleTime = 0;
      legL.rotation.x = 0;
      legR.rotation.x = 0;
      torso.position.y = GEO.torso.y;
    }
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
