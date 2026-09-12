/**
 * Lunar Frontier — industrial loading-dock breaker mech (TASK-PLAY-050).
 *
 * A procedural Babylon.js excavation rig that dresses the freight docks and
 * startup yards the FactionBases module plants: a heavy bipedal hauler with a
 * reinforced cockpit cab, twin hydraulic leg struts and two pneumatic
 * breaker arms ending in excavator claws / rock-breaker bits. Ore comes out
 * through the world generator's OWN ledger — `excavate()` drains a vein's
 * `remaining` through the vein's own `harvest` hook when it has one (the
 * contract `LunarWorldGenerator.harvest` exposes), falls back to a direct
 * clamp when it does not, and reports exactly how many units came up.
 *
 * Meshes (procedural only, no GLB):
 *  - Hip chassis + torso with armour chest plate and a hazard chevron;
 *    reinforced cockpit cab (armour box + three emissive view slits + visor
 *    beam + roof beacon) slung on the right shoulder.
 *  - Heavy hydraulic leg struts: hip yoke, thigh, knee cylinder (the
 *    hydraulic actuator body), shin with toe brake, wide regolith foot pads —
 *    mirrored left/right under the hip chassis.
 *  - Dual pneumatic breaker arms: shoulder yoke, boom carrying a pneumatic
 *    cylinder, and a three-finger excavator claw with a central rock-breaker
 *    spike — merged per arm; a separate piston-rod mesh strokes in and out
 *    while the rig hammers.
 *  - Two `SpotLight` floodlights on cab shoulder mounts that ride the root
 *    transform every frame (unparented, recomputed from the world matrix —
 *    the OpenBuggy headless lamp pattern).
 *
 * Materials: industrial hazard yellow, oxidised industrial orange, gear
 * steel and dark; emissive amber view slits and lamp faces.
 *
 * Coordinates: world metres (x, y lateral, z up) map to Babylon (x, z↑, -y)
 * via the shared `worldToBabylon` from CameraRig; heading (radians, 0 = +x)
 * maps to Babylon `rotation.y = PI/2 + heading` exactly like OpenBuggy, so
 * mech, camera, bases and physics cannot disagree about where the rig stands.
 *
 * Headless-safe: `init()` accepts a Scene, a raw engine (a scene is created
 * around it), or nothing (self-owned NullEngine fallback). `dispose()` is
 * idempotent and never throws; after disposal `update()`/`excavate()` keep
 * answering from bookkeeping and `init()` refuses with a clear error.
 *
 * Usage:
 *   const mech = new LoadingDockMech({ name: 'dock-mech-01' }).init(scene);
 *   mech.faceToward(vein.center);
 *   mech.update(1 / 60, true);                      // breakers hammering
 *   const units = mech.excavate(vein, 42, 1 / 60);  // ore comes out
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';

import { worldToBabylon } from '../engine/CameraRig.ts';
import type { Vec3 } from '../world/LunarWorldGenerator.ts';

// -- tunables ------------------------------------------------------------------

/** Default excavation throughput (units/s) at full pneumatic rate. */
export const MECH_EXCAVATION_RATE = 42;
/** Breaker hammer rate while firing (full strokes per second). */
export const MECH_BREAKER_RATE_HZ = 6.5;
/** Floodlight intensity on the cab shoulder mounts. */
export const MECH_FLOODLIGHT_INTENSITY = 5.8;
/** Floodlight cone full angle, degrees. */
export const MECH_FLOODLIGHT_ANGLE_DEG = 72;
/** Floodlight beam range, metres. */
export const MECH_FLOODLIGHT_RANGE_M = 48;
/** Default unit id prefix; smoke suite asserts `dock-mech-*` naming. */
export const DEFAULT_NAME_PREFIX = 'dock-mech';
/** Yaw slew rate toward a commanded heading (rad/s, visual smoothing). */
export const MECH_YAW_RATE = 2.4;
/** Pitch clamp on the breaker arms (rad) — the rig cannot dig the sky. */
export const MECH_PITCH_LIMIT = Math.PI / 3;

/**
 * The minimum a caller must expose for `excavate()` to drain a vein. The
 * world generator's `ResourceVein` + `harvest` pair satisfies this shape.
 */
export interface ExcavatableVein {
  id: string;
  /** Units still in place — the ledger `excavate()` drains. */
  remaining: number;
  /**
   * The owner's own harvest hook (same contract as
   * `LunarWorldGenerator.harvest`): takes a request amount, returns the
   * units actually taken. When absent the mech clamps against `remaining`
   * directly and decrements it in place.
   */
  harvest?: (amt: number) => number;
}

/** Options for the dock mech. */
export interface LoadingDockMechOptions {
  /** Stable unit id (default `dock-mech-01`). Meshes are `${name}-*`. */
  name?: string;
  /** Spawn position in the WORLD frame (x, y lateral, z elevation). */
  position?: Vec3;
  /** Spawn heading, radians in the x-y plane (0 = +x). Default 0. */
  heading?: number;
  /** Material name prefix override (default `dock-mech`). */
  namePrefix?: string;
  /** Build the two shoulder SpotLights (default true). */
  floodlights?: boolean;
}

/** Consolidated rig telemetry, one allocation per call. */
export interface DockMechTelemetry {
  /** World-frame position (x, y lateral, z up). */
  position: Vec3;
  /** Current heading, radians (0 = +x), slewed toward the commanded one. */
  heading: number;
  /** Breaker working pitch, radians (down into the cut = positive). */
  pitch: number;
  /** True while the pneumatic breakers are hammering. */
  drilling: boolean;
  /** Breaker phase accumulator (rad) — the hammer clock. */
  breakerPhase: number;
  /** Total units extracted since spawn. */
  extractedTotal: number;
  /** Floodlights lit. */
  floodlightsOn: boolean;
}

/** Geometry table, metres. Model frame under root: +z nose, +x left, +y up. */
const GEO = {
  hip: { width: 2.2, height: 0.7, depth: 1.5, y: 2.35 },
  torso: { width: 2.6, height: 1.7, depth: 1.7, y: 3.45 },
  chestPlate: { width: 2.75, height: 0.9, depth: 0.35, y: 3.7, z: 0.95 },
  chevron: { width: 1.1, height: 0.6, depth: 0.12, y: 4.35 },
  cab: { width: 1.5, height: 1.3, depth: 1.9, x: 1.95, y: 3.95, z: 0.35,
    slitCount: 3, slitWidth: 0.14, slitLength: 1.2, slitY: 0.28, slitSpacing: 0.42,
    visor: { width: 1.4, height: 0.18, z: 1.31 }, beaconDiameter: 0.28 },
  leg: { x: 1.0,
    yoke: { width: 0.5, height: 0.55, depth: 0.7 },
    thigh: { width: 0.62, height: 1.5, depth: 0.7, y: 1.62 },
    knee: { diameter: 0.72, length: 1.0, y: 0.95 },
    shin: { width: 0.55, height: 1.5, depth: 0.62, y: 0.78 },
    foot: { width: 1.45, height: 0.3, depth: 2.25, y: 0.15 },
    toe: { width: 0.5, height: 0.55, z: 1.15, y: 0.5 } },
  arm: { shoulderX: 1.35, shoulderY: 4.0, shoulderZ: 0.1,
    yoke: { diameter: 0.6, height: 0.5 },
    boom: { width: 0.52, length: 2.1, depth: 0.56, pitch: -0.55 },
    cylinder: { diameter: 0.42, length: 1.4, y: 0.3, z: 0.55 },
    clawBase: 2.2,
    claw: { fingerLength: 1.15, fingerDiameter: 0.2, fan: 0.55, tipTilt: 0.85 },
    spike: { length: 0.85, diameter: 0.3 },
    piston: { diameter: 0.16, length: 0.9, y: 0.12, z: 1.3, stroke: 0.42 } },
  flood: { x: 1.95, y: 4.75, z: 1.25 },
} as const;

/** Lamp mount points in the model frame (cab shoulder mounts). */
const FLOOD_MOUNTS: ReadonlyArray<Vector3> = [
  new Vector3(GEO.flood.x, GEO.flood.y, GEO.flood.z),
  new Vector3(GEO.flood.x - 0.55, GEO.flood.y, GEO.flood.z - 0.4),
];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Shortest signed angular difference a-b, wrapped to (-PI, PI]. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Vacuum-lunar PBR shorthand. */
function makePbr(
  name: string,
  scene: Scene,
  albedo: [number, number, number],
  metallic: number,
  roughness: number,
  emissive?: [number, number, number],
): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  material.albedoColor = new Color3(albedo[0], albedo[1], albedo[2]);
  material.metallic = metallic;
  material.roughness = roughness;
  if (emissive !== undefined) material.emissiveColor = new Color3(emissive[0], emissive[1], emissive[2]);
  material.environmentIntensity = 0.06;
  return material;
}

/**
 * Industrial bipedal excavation mech. Owns its procedural kit and its own
 * bookkeeping (heading, pitch, breaker phase, extraction total); the ore
 * ledger stays with the vein record it was handed — exactly the division of
 * labour `LunarWorldGenerator.harvest` implies.
 */
export class LoadingDockMech {
  /** Stable unit id (`dock-mech-01`); every mesh is named `${name}-*`. */
  readonly name: string;

  private readonly prefix: string;
  private readonly wantFloodlights: boolean;

  private posePos: Vec3;
  private headingRad: number;
  private commandedHeading: number;
  private pitchRad = 0;
  private drilling = false;
  private breakerPhase = 0;
  private extractedTotal = 0;
  private floodlightsOn = true;

  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;

  private root: TransformNode | null = null;
  private parts: Mesh[] = [];
  /** Per-side breaker arms + piston rods whose transforms animate. */
  private arms: Mesh[] = [];
  private pistons: Mesh[] = [];
  private lamps: SpotLight[] = [];
  private materialList: PBRMaterial[] = [];

  private built = false;
  private disposed = false;

  /** Scratch object for the per-frame lamp maths (no GC churn). */
  private readonly scratchPoint = new Vector3();

  constructor(options: LoadingDockMechOptions = {}) {
    this.prefix = options.namePrefix ?? DEFAULT_NAME_PREFIX;
    this.name = options.name ?? `${this.prefix}-01`;
    this.posePos = {
      x: options.position?.x ?? 0,
      y: options.position?.y ?? 0,
      z: options.position?.z ?? 0,
    };
    this.headingRad = Number.isFinite(options.heading) ? (options.heading as number) : 0;
    this.commandedHeading = this.headingRad;
    this.wantFloodlights = options.floodlights ?? true;
  }

  // -- lifecycle -----------------------------------------------------------------

  /**
   * Build the mech. Accepts an existing `Scene`, a raw engine (a scene is
   * created around it), or nothing — falling back to a self-owned
   * `NullEngine`, exactly what CI wants. Idempotent; refuses after `dispose()`.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('LoadingDockMech: init() after dispose()');
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
      throw new Error('LoadingDockMech.init: browser needs a Scene or Engine');
    }

    this.buildMech(this.scene);
    this.built = true;
    this.applyPose();
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /** Tear down kit, lights, materials, root and any self-owned engine. Never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;
    this.drilling = false;

    for (const lamp of this.lamps) LoadingDockMech.disposeQuietly(lamp);
    this.lamps = [];
    for (const mesh of this.parts) LoadingDockMech.disposeQuietly(mesh);
    this.parts = [];
    this.arms = [];
    this.pistons = [];
    for (const material of this.materialList) LoadingDockMech.disposeQuietly(material);
    this.materialList = [];
    LoadingDockMech.disposeQuietly(this.root);
    this.root = null;

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) LoadingDockMech.disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- kinematics -------------------------------------------------------------------

  /**
   * Advance one frame. `activeDrill = true` hammers the pneumatic breakers:
   * the breaker phase integrates at `MECH_BREAKER_RATE_HZ`, the piston rods
   * stroke, and the arms recoil with the hammer cycle; at rest the phase
   * freezes mid-strike. Heading slews toward the commanded bearing (from
   * `faceToward` / `setHeading`) at `MECH_YAW_RATE`; pitch tracks a damped
   * working rake. No world physics is integrated here — the rig is parked
   * ground furniture; this is animation + heading bookkeeping only, and it
   * stays safe (a no-op) after `dispose()`.
   */
  update(dt: number, activeDrill?: boolean): void {
    if (this.disposed) return;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.drilling = activeDrill === true;

    // Heading slew (shortest way round) toward the commanded bearing.
    const delta = angleDelta(this.commandedHeading, this.headingRad);
    const slew = MECH_YAW_RATE * step;
    this.headingRad = Math.abs(delta) <= slew ? this.commandedHeading : this.headingRad + slew;

    // Working pitch: digs in when firing, lifts to an idle rest when not;
    // always inside the mechanical stop.
    const targetPitch = this.drilling ? 0.32 : 0.05;
    const track = 1 - Math.exp(-4 * step);
    this.pitchRad = clamp(this.pitchRad + (targetPitch - this.pitchRad) * track, 0, MECH_PITCH_LIMIT);

    if (this.drilling) {
      this.breakerPhase = (this.breakerPhase + step * MECH_BREAKER_RATE_HZ * Math.PI * 2) % (Math.PI * 2);
    }
    if (this.built) this.applyPose();
  }

  /**
   * Point the rig at a world-frame target; the heading bookkeeps the command
   * immediately and the meshes slew there across `update()` frames.
   * Returns the commanded heading (radians, 0 = +x).
   */
  faceToward(target: Vec3): number {
    if (this.disposed) return this.commandedHeading;
    const dx = target.x - this.posePos.x;
    const dy = target.y - this.posePos.y;
    if (Math.hypot(dx, dy) < 1e-9) return this.commandedHeading;
    this.commandedHeading = Math.atan2(dy, dx);
    return this.commandedHeading;
  }

  /** Command an absolute heading (radians, 0 = +x). Returns the command. */
  setHeading(headingRad: number): number {
    if (this.disposed || !Number.isFinite(headingRad)) return this.commandedHeading;
    this.commandedHeading = headingRad;
    return this.commandedHeading;
  }

  /** Warp the rig (e.g. onto a dock flatcar). Keeps heading; returns copy. */
  setPosition(p: Vec3): Vec3 {
    if (this.disposed) return { ...this.posePos };
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      this.posePos = { x: p.x, y: p.y, z: p.z };
      if (this.built) this.applyPose();
    }
    return { ...this.posePos };
  }

  /** Babylon yaw matching the shared heading mapping: PI/2 + heading. */
  getBabylonYaw(): number {
    return Math.PI / 2 + this.headingRad;
  }

  // -- excavation ---------------------------------------------------------------------

  /**
   * Run the breakers on a vein for `dt` seconds at `ratePerSec` units/s:
   * request `ratePerSec * dt` units from the vein's OWN `harvest` hook when
   * it exposes one (the `LunarWorldGenerator.harvest` contract — the owner
   * keeps authority over purity, credits and rounding), else clamp the
   * request against `vein.remaining` locally and decrement it in place.
   * Returns the units actually extracted (0 when dry, depleted, or refused),
   * accumulates them into `extractedTotal`, and hammers the breaker clock.
   */
  excavate(vein: ExcavatableVein, ratePerSec: number = MECH_EXCAVATION_RATE, dt: number = 1 / 60): number {
    if (this.disposed || vein === null || vein === undefined) return 0;
    const rate = Number.isFinite(ratePerSec) && ratePerSec > 0 ? ratePerSec : MECH_EXCAVATION_RATE;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 5) : 0;
    const request = rate * step;
    if (request <= 0 || !(vein.remaining > 0)) return 0;

    let extracted: number;
    if (typeof vein.harvest === 'function') {
      const got = vein.harvest(request);
      extracted = Number.isFinite(got) && got > 0 ? got : 0;
    } else {
      extracted = Math.min(request, vein.remaining);
      vein.remaining -= extracted;
    }
    if (extracted <= 0) return 0;

    this.extractedTotal += extracted;
    // Ore-taking is what drives the hammer: advance the strike clock even
    // when the caller animates through excavate() instead of update().
    this.breakerPhase = (this.breakerPhase + extracted * 0.05) % (Math.PI * 2);
    return extracted;
  }

  /** Total units the rig has pulled since spawn. */
  getExtractedTotal(): number {
    return this.extractedTotal;
  }

  /** Consolidated telemetry for HUDs / smoke asserts. */
  getTelemetry(): DockMechTelemetry {
    return {
      position: { ...this.posePos },
      heading: this.headingRad,
      pitch: this.pitchRad,
      drilling: this.drilling,
      breakerPhase: this.breakerPhase,
      extractedTotal: this.extractedTotal,
      floodlightsOn: this.floodlightsOn,
    };
  }

  // -- accessors -------------------------------------------------------------------------

  /** Root transform node of the mech (null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every mech mesh (shadow casters / picking registration). */
  getMeshes(): ReadonlyArray<AbstractMesh> {
    return [...this.parts];
  }

  /** The two shoulder floodlight SpotLights ([] before init / after dispose). */
  getFloodlights(): ReadonlyArray<SpotLight> {
    return [...this.lamps];
  }

  /** Meshes tagged with a kit part id: 'chassis' | 'cab' | 'leg' | 'arm'. */
  getPartMeshes(part: string): Mesh[] {
    return this.parts.filter((m) => (m.metadata?.part as string | undefined) === part);
  }

  /** True while the breakers are commanded on. */
  isDrilling(): boolean {
    return this.drilling && !this.disposed;
  }

  /**
   * Switch the shoulder floodlights: `setFloodlights(true|false)` forces, a
   * bare call toggles. Returns the state now in force. Safe before `init()`
   * and after `dispose()`, idempotent.
   */
  setFloodlights(on?: boolean): boolean {
    this.floodlightsOn = on === undefined ? !this.floodlightsOn : on;
    if (this.built && !this.disposed) this.applyLamps();
    return this.floodlightsOn;
  }

  // -- construction -----------------------------------------------------------------------

  /** Hazard-yellow biped: chassis, cab, hydraulic legs, breaker arms, lamps. */
  private buildMech(scene: Scene): void {
    const p = this.prefix;
    const hazard = makePbr(`${p}-hazard`, scene, [0.78, 0.58, 0.1], 0.25, 0.55);
    const rust = makePbr(`${p}-rust`, scene, [0.46, 0.22, 0.08], 0.3, 0.85);
    const steel = makePbr(`${p}-steel`, scene, [0.58, 0.59, 0.62], 0.9, 0.35);
    const dark = makePbr(`${p}-dark`, scene, [0.1, 0.1, 0.11], 0.5, 0.62);
    const slit = makePbr(`${p}-slit`, scene, [0.95, 0.72, 0.25], 0.1, 0.3, [1, 0.66, 0.16]);
    const lampFace = makePbr(`${p}-lamp`, scene, [0.92, 0.9, 0.82], 0.1, 0.32, [1, 0.9, 0.7]);
    this.materialList = [hazard, rust, steel, dark, slit, lampFace];

    this.root = new TransformNode(this.name, scene);
    // Kit helpers: create → place → parent → tag in one call.
    const box = (n: string, part: string, w: number, h: number, d: number, x: number, y: number, z: number, mat: PBRMaterial): Mesh => {
      const m = MeshBuilder.CreateBox(`${p}-${n}`, { width: w, height: h, depth: d }, scene);
      m.position.set(x, y, z);
      return this.track(m, part, mat);
    };
    const cyl = (n: string, part: string, diameter: number, h: number, x: number, y: number, z: number, mat: PBRMaterial, tess = 14): Mesh => {
      const m = MeshBuilder.CreateCylinder(`${p}-${n}`, { diameter, height: h, tessellation: tess }, scene);
      m.position.set(x, y, z);
      return this.track(m, part, mat);
    };

    // -- chassis + torso + hazard chevron ------------------------------------
    box('hip-chassis', 'chassis', GEO.hip.width, GEO.hip.height, GEO.hip.depth, 0, GEO.hip.y, 0, steel);
    box('torso', 'chassis', GEO.torso.width, GEO.torso.height, GEO.torso.depth, 0, GEO.torso.y, 0, hazard);
    box('chest-plate', 'chassis', GEO.chestPlate.width, GEO.chestPlate.height, GEO.chestPlate.depth,
      0, GEO.chestPlate.y, GEO.chestPlate.z, rust); // oxidised industrial orange plate
    const chevron = box('hazard-chevron', 'chassis', GEO.chevron.width, GEO.chevron.height, GEO.chevron.depth,
      0, GEO.chevron.y, GEO.torso.depth / 2 + 0.2, dark);
    chevron.rotation.z = Math.PI / 4; // diamond stripe on the back

    // -- reinforced cockpit cab (right shoulder) -------------------------------
    const cab = GEO.cab;
    box('cockpit-cab', 'cab', cab.width, cab.height, cab.depth, cab.x, cab.y, cab.z, hazard);
    for (let i = 0; i < cab.slitCount; i++) {
      // Armoured view slits: emissive slots across the cab face.
      box(`view-slit-${i}`, 'cab', cab.slitWidth, cab.slitWidth * 3.2, cab.slitLength,
        cab.x + (i - (cab.slitCount - 1) / 2) * cab.slitSpacing, cab.y + cab.slitY,
        cab.z + cab.depth / 2 + 0.02, slit);
    }
    box('cab-visor', 'cab', cab.visor.width, cab.visor.height, 0.1,
      cab.x, cab.y - cab.height / 2 + 0.14, cab.visor.z, dark);
    const beacon = MeshBuilder.CreateSphere(`${p}-cab-beacon`, { diameter: cab.beaconDiameter, segments: 8 }, scene);
    beacon.position.set(cab.x, cab.y + cab.height / 2 + 0.16, cab.z);
    this.track(beacon, 'cab', lampFace);

    // -- heavy hydraulic leg struts (mirrored left / right) ---------------------
    const L = GEO.leg;
    for (const side of [1, -1]) {
      const tag = side > 0 ? 'l' : 'r';
      box(`leg-hip-${tag}`, 'leg', L.yoke.width, L.yoke.height, L.yoke.depth,
        side * L.x, GEO.hip.y - L.yoke.height / 2, 0, steel);
      box(`leg-thigh-${tag}`, 'leg', L.thigh.width, L.thigh.height, L.thigh.depth, side * L.x, L.thigh.y, 0, hazard);
      // The knee cylinder IS the hydraulic actuator body on this strut.
      const knee = cyl(`leg-hydraulic-${tag}`, 'leg', L.knee.diameter, L.knee.length, side * L.x, L.knee.y, 0, rust);
      knee.rotation.z = Math.PI / 2; // actuator lies across the strut
      box(`leg-shin-${tag}`, 'leg', L.shin.width, L.shin.height, L.shin.depth, side * L.x, L.shin.y, 0, steel);
      box(`leg-foot-${tag}`, 'leg', L.foot.width, L.foot.height, L.foot.depth, side * L.x, L.foot.y, 0.2, dark);
      box(`leg-toe-${tag}`, 'leg', L.toe.width, L.toe.height, L.toe.width, side * L.x, L.toe.y, L.toe.z, rust);
    }

    // -- dual pneumatic breaker arms ---------------------------------------------
    const A = GEO.arm;
    for (const side of [1, -1]) {
      const tag = side > 0 ? 'l' : 'r';
      const yoke = cyl(`arm-yoke-${tag}`, 'arm', A.yoke.diameter, A.yoke.height,
        side * A.shoulderX, A.shoulderY, A.shoulderZ, steel, 12);
      yoke.rotation.z = Math.PI / 2;

      // Boom + pneumatic cylinder + three-finger claw + rock-breaker spike,
      // merged into one arm mesh that pivots at the shoulder yoke.
      const src: Mesh[] = [];
      const boom = MeshBuilder.CreateBox(`arm-boom-${tag}-src`,
        { width: A.boom.width, height: A.boom.depth, depth: A.boom.length }, scene);
      boom.position.set(0, 0, A.boom.length / 2);
      src.push(boom);

      const barrel = MeshBuilder.CreateCylinder(`arm-cyl-${tag}-src`,
        { diameter: A.cylinder.diameter, height: A.cylinder.length, tessellation: 12 }, scene);
      barrel.position.set(0, A.cylinder.y, A.cylinder.z);
      barrel.rotation.x = Math.PI / 2; // barrel along the boom
      src.push(barrel);

      for (let f = 0; f < 3; f++) {
        // Fingers fan around the boom axis; tips curl inward (−y).
        const fan = (f - 1) * A.claw.fan;
        const finger = MeshBuilder.CreateCylinder(`arm-claw-${tag}-f${f}-src`,
          { diameterTop: A.claw.fingerDiameter * 0.3, diameterBottom: A.claw.fingerDiameter,
            height: A.claw.fingerLength, tessellation: 8 }, scene);
        finger.position.set(Math.sin(fan) * 0.32, Math.cos(fan) * 0.2, A.clawBase);
        finger.rotation.x = Math.PI / 2 - A.claw.tipTilt;
        finger.rotation.z = -fan;
        src.push(finger);
      }
      const spike = MeshBuilder.CreateCylinder(`arm-breaker-${tag}-src`,
        { diameterTop: 0.02, diameterBottom: A.spike.diameter, height: A.spike.length, tessellation: 8 }, scene);
      spike.position.set(0, -0.12, A.clawBase + A.spike.length / 2 - 0.1);
      spike.rotation.x = 0.35; // drive angle into the rock face
      src.push(spike);

      const arm = LoadingDockMech.mergeInto(`${this.name}-breaker-arm-${tag}`, src, scene);
      arm.position.set(side * A.shoulderX, A.shoulderY, A.shoulderZ);
      arm.rotation.x = A.boom.pitch;
      // Weathered mismatched pair: one hazard, one rust arm. Nobody audits.
      this.track(arm, 'arm', side > 0 ? hazard : rust);
      this.arms.push(arm);

      // Piston rod stays its own mesh — it strokes in/out while firing.
      const piston = cyl(`arm-piston-${tag}`, 'arm', A.piston.diameter, A.piston.length,
        side * A.shoulderX, A.shoulderY + A.piston.y, A.shoulderZ + A.piston.z, steel, 10);
      piston.name = `${this.name}-arm-piston-${tag}`; // unit-id naming, like arms
      piston.rotation.x = Math.PI / 2;
      this.pistons.push(piston);
    }

    // -- shoulder floodlights -----------------------------------------------------
    // Lamps stay UNPARENTED and get their world position recomputed from the
    // root matrix every frame (OpenBuggy pattern), so both beams stay
    // truthful under NullEngine where no render loop propagates parenting.
    if (!this.wantFloodlights) return;
    this.lamps = FLOOD_MOUNTS.map((mount, index) => {
      const lamp = new SpotLight(
        `${this.name}-floodlight-${index === 0 ? 'l' : 'r'}`,
        mount.clone(),
        new Vector3(0, -0.35, 1),
        (MECH_FLOODLIGHT_ANGLE_DEG * Math.PI) / 180,
        1.6,
        scene,
      );
      lamp.range = MECH_FLOODLIGHT_RANGE_M;
      lamp.diffuse = new Color3(1, 0.9, 0.72);
      return lamp;
    });
  }

  /** Parent to the root, tag with mech id + part, register for teardown. */
  private track(mesh: Mesh, part: string, material: PBRMaterial): Mesh {
    mesh.parent = this.root;
    mesh.material = material;
    mesh.isPickable = true;
    mesh.receiveShadows = false;
    mesh.metadata = { mechId: this.name, part };
    this.parts.push(mesh);
    return mesh;
  }

  /** Push pose bookkeeping into the root, arms, pistons and lamps. */
  private applyPose(): void {
    const root = this.root;
    if (root === null || root.isDisposed() || this.scene === null || this.scene.isDisposed) return;

    const b = worldToBabylon(this.posePos);
    root.position.set(b.x, b.y, b.z);
    root.rotation.set(0, this.getBabylonYaw(), 0); // shared PI/2 + heading map
    root.computeWorldMatrix(true);

    // Hammer cycle: arms recoil and piston rods fly on the strike phase.
    const strike = Math.sin(this.breakerPhase);
    const recoil = this.drilling ? strike * 0.16 : 0;
    const stroke = this.drilling ? (0.5 + 0.5 * strike) * GEO.arm.piston.stroke : 0;
    const digPitch = GEO.arm.boom.pitch + this.pitchRad * 0.6;

    for (const arm of this.arms) {
      if (arm.isDisposed()) continue;
      arm.rotation.x = digPitch + recoil * 0.5;
      arm.position.y = GEO.arm.shoulderY + recoil * 0.1;
    }
    for (const piston of this.pistons) {
      if (piston.isDisposed()) continue;
      piston.position.z = GEO.arm.shoulderZ + GEO.arm.piston.z + stroke;
    }
    this.applyLamps();
  }

  /** Push floodlight on/off, world position and beam aim into the SpotLights. */
  private applyLamps(): void {
    const scene = this.scene;
    const root = this.root;
    if (this.lamps.length === 0) return;
    if (scene === null || scene.isDisposed || root === null || root.isDisposed()) return;

    // Work-light beam rakes down over the cut; the horizontal aim rotates
    // with heading through the SAME map as every other transform — model
    // +z (the nose) lands on Babylon (cos h, 0, −sin h).
    const h = this.headingRad;
    const intensity = this.floodlightsOn ? MECH_FLOODLIGHT_INTENSITY : 0;
    const matrix = root.getWorldMatrix();

    for (let i = 0; i < this.lamps.length; i++) {
      Vector3.TransformCoordinatesToRef(FLOOD_MOUNTS[i], matrix, this.scratchPoint);
      this.lamps[i].position.copyFrom(this.scratchPoint);
      this.lamps[i].direction.set(Math.cos(h) * 0.6, -0.8, -Math.sin(h) * 0.6);
      this.lamps[i].intensity = intensity;
    }
  }

  /** Merge primitives, tolerating a refused merge (sources always cleaned). */
  private static mergeInto(name: string, parts: Mesh[], scene: Scene): Mesh {
    const merged = Mesh.MergeMeshes(parts, true, true);
    if (merged !== null) {
      merged.name = name;
      return merged;
    }
    // Merge refused (degenerate source): keep one primitive, drop the rest.
    const survivor = parts[0] ?? MeshBuilder.CreateBox(`${name}-stub`, { size: 0.1 }, scene);
    survivor.name = name;
    for (const extra of parts.slice(1)) LoadingDockMech.disposeQuietly(extra);
    return survivor;
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

export default LoadingDockMech;
