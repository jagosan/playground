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
/** Helmet lamp intensity while lit. */
export const HEADLIGHT_INTENSITY = 2.4;
/** Helmet lamp cone full angle, degrees. */
export const HEADLIGHT_ANGLE_DEG = 50;
/** Helmet lamp beam range, metres. */
export const HEADLIGHT_RANGE_M = 45;
/** Fraction of look-pitch the stiff torso copies. */
export const PITCH_LEAN_SCALE = 0.4;

export interface EvaSuitAvatarOptions {
  /** Seed for the owned `LunarEvaSuit` (spawn position, reserves…). */
  initial?: Partial<SuitState>;
  /** Surface elevation underfoot, world-frame metres. Default datum 0. */
  groundElevation?: GroundElevationFn;
  /** Lamp lit at spawn (default true). */
  headlight?: boolean;
  /** Node/mesh/material name prefix (default `eva`). */
  namePrefix?: string;
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
  private lamp: SpotLight | null = null;
  private materials: PBRMaterial[] = [];

  private lampOn: boolean;
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
    gold.albedoColor = new Color3(0.12, 0.08, 0.02);
    gold.metallic = 0.9;
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

    this.applyLamp(state);

    // Force a matrix rebuild so headless consumers read a truthful
    // globalPosition without an intervening render().
    root.computeWorldMatrix(true);
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
    // Physics-forward (cos h, sin h, 0) → Babylon (cos h, 0, -sin h).
    lamp.direction.set(Math.cos(state.heading), 0, -Math.sin(state.heading));
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
