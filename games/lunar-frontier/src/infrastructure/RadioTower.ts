/**
 * Lunar Frontier — Frontier Radio Tower "X-Corp Transmission Relay 04" (Spec 29).
 *
 * A 52 m tapered four-leg titanium lattice spire standing at (-1550, 2320):
 * 310.5 m east-southeast of the X-Corp Citadel monolith (safely outside the
 * 260 m warning ring and the 220 m kinetic dome) and ~35 m lateral to the
 * high-speed maglev guideway, so climbing crews get a raking down-view of the
 * Apex Express while never tripping the corporate defense grid.
 *
 * The module is a two-layer design, exactly like XCorpCitadel (Spec 26):
 *
 *  1. A PURE MATHEMATICAL LAYER answered from constructor options alone —
 *     ladder bounds, proximity envelopes, climb-rail offsets, deck elevation
 *     and the beacon pulse law all work before `init()`, after `dispose()`,
 *     and with no scene at all, so ClientApp edge detection and the Phase 3
 *     CLIMBING locomotion mode can never race the mesh build.
 *
 *  2. A PROCEDURAL MESH LAYER built once inside `init(scene?)` on any engine
 *     (NullEngine-safe: zero canvas/WebGL context calls): foundation pads,
 *     8-bay tapered corner pillars with per-segment inward convergence,
 *     horizontal tie beams, 64 diagonal X-lattice braces, 137 ladder rungs at
 *     0.35 m pitch following the truss taper, 22 circular safety hoops every
 *     2.1 m from +3.0 m, a hexagonal observation deck at +48.0 m with 1.1 m
 *     handrail / mid-rail / kick-plate perimeter and a 0.9 m x 0.9 m trapdoor
 *     opening on the ladder face, dual parabolic microwave dishes at +38 m /
 *     +46 m, the centre antenna spire to +52.0 m, and a dual-strobe red/white
 *     aviation beacon animated by `update(deltaS)`.
 *
 * Coordinate contract: world metres (x, y lateral, z = elevation up) map to
 * Babylon left-handed y-up (x, z-up, -y) via the shared `worldToBabylon` from
 * CameraRig. The root TransformNode sits ON the tower foundation point; every
 * child is placed in the Babylon-local frame where local y == metres above
 * the foundation ground datum. World directions map (wx, wy) → Babylon
 * (wx, -wy); a world direction d has Babylon yaw atan2(d.x, -d.y) and the
 * corresponding unit planar point (sin yaw, 0, cos yaw).
 *
 * Ladder geometry law: the truss tapers linearly from `baseWidthM` at the
 * foundation to `topWidthM` at z = +47.5 m (the deck neck), clamped above.
 * The access ladder is centred on the tower face whose outward normal is
 * `ladderFacingRad` (default -45°, south-east toward the maglev line). Rung
 * centres ride that taper: horizontal distance from the tower axis ==
 * halfWidth(z) + 0.25 m protrusion. The climber's body rail is a further
 * 0.30 m outward along the face normal (`getClimbOffsetPosition`).
 *
 * Usage:
 *   const tower = new RadioTower().init(scene);
 *   tower.update(dt);                                     // beacon strobe
 *   if (tower.isNearLadderBase(playerPos)) promptClimb(); // pure math
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';

import { worldToBabylon } from '../engine/CameraRig.ts';

// -- canonical constants ------------------------------------------------------

/** Root/material name prefix. */
export const RADIO_TOWER_NAME_PREFIX = 'radio-tower';

/** Construction options; every field falls back to the Spec 29 canonical. */
export interface RadioTowerOptions {
  /** Tower foundation world position (default: { x: -1550, y: 2320, z: 0 }). */
  worldPosition: { x: number; y: number; z: number };
  /** Total structural height including antenna mast (default: 52.0m). */
  towerHeightM: number;
  /** Observation deck elevation above base ground (default: 48.0m). */
  deckElevationM: number;
  /** Foundation footprint width at ground (default: 6.0m). */
  baseWidthM: number;
  /** Footprint width at summit neck (default: 2.2m). */
  topWidthM: number;
  /** Facing angle of the access ladder in world radians (default: -PI/4). */
  ladderFacingRad: number;
  /** Color theme for warning beacons and corporate accents. */
  beaconColor: { r: number; g: number; b: number };
}

/** Spec 29 §2.1 / blueprint §2.1: canonical frozen option set. */
export const RADIO_TOWER_DEFAULTS: Readonly<RadioTowerOptions> = Object.freeze({
  worldPosition: Object.freeze({ x: -1550, y: 2320, z: 0 }),
  towerHeightM: 52.0,
  deckElevationM: 48.0,
  baseWidthM: 6.0,
  topWidthM: 2.2,
  ladderFacingRad: -Math.PI / 4, // 315 deg, facing south-east toward the maglev line
  beaconColor: Object.freeze({ r: 1.0, g: 0.15, b: 0.1 }),
});

/** Spec 29 §2.2: linear taper completes at the deck neck (z, m above base). */
export const TAPER_TOP_Z_M = 47.5;
/** Spec 29 §2.2: eight vertical lattice bays. */
export const LATTICE_BAY_COUNT = 8;

/** Spec 29 §2.3: uniform rung pitch (m). */
export const LADDER_RUNG_PITCH_M = 0.35;
/** Spec 29 §2.3: rung clear width (m). */
export const LADDER_RUNG_WIDTH_M = 0.6;
/** Spec 29 §2.3: rung tube radius (m). */
export const LADDER_RUNG_RADIUS_M = 0.02;
/** Spec 29 §2.3: rungs project this far out from the truss face (m). */
export const LADDER_PROTRUSION_M = 0.25;
/** Spec 29 §3.2.1: climber body rail offset outward from the rung line (m). */
export const LADDER_BODY_OFFSET_M = 0.3;
/** Spec 29 §2.3: base detection cylinder radius (m). */
export const LADDER_BASE_DETECT_RADIUS_M = 1.8;
/** Spec 29 §2.3: base detection vertical envelope around base z (m). */
export const LADDER_BASE_VERTICAL_ENVELOPE_M = 2.5;
/** Spec 29 §2.3 / blueprint §4: summit hatch detection radius (m). */
export const HATCH_DETECT_RADIUS_M = 1.0;
/** Summit hatch vertical envelope around deck z (m). */
export const HATCH_VERTICAL_ENVELOPE_M = 1.5;
/** Spec 29 §2.2: trapdoor clear opening size (m). */
export const HATCH_SIZE_M = 0.9;
/** Ladder bounding-cylinder radius for {@link RadioTower.isWithinClimbEnvelope} (m). */
export const CLIMB_ENVELOPE_RADIUS_M = 1.0;

/** Spec 29 §2.3: safety cage hoop radius (m). */
export const SAFETY_HOOP_RADIUS_M = 0.45;
/** Spec 29 §2.3: hoop vertical spacing (m). */
export const SAFETY_HOOP_SPACING_M = 2.1;
/** Spec 29 §2.3: first hoop height above ground (m). */
export const SAFETY_HOOP_START_M = 3.0;

/** Spec 29 §2.2: hexagonal observation deck vertex span (m). */
export const DECK_SPAN_M = 5.0;
/** Spec 29 §2.2: deck slab thickness (m); walking surface sits at deckElevationM. */
export const DECK_SLAB_THICKNESS_M = 0.15;
/** Spec 29 §2.2: handrail / mid-rail / kick-plate heights (m). */
export const HANDRAIL_HEIGHT_M = 1.1;
export const MIDRAIL_HEIGHT_M = 0.55;
export const KICKPLATE_HEIGHT_M = 0.15;

/** Spec 29 §2.2: microwave dish elevations, diameter and depth (m). */
export const DISH_ELEVATIONS_M: readonly number[] = Object.freeze([38.0, 46.0]);
export const DISH_DIAMETER_M = 1.6;
export const DISH_DEPTH_M = 0.4;

/** Blueprint §1: red obstruction pulse (Hz) and white xenon double-flash (Hz). */
export const RED_BEACON_PULSE_HZ = 0.85;
export const WHITE_STROBE_FLASH_HZ = 0.5;

/** X-Corp Citadel seat (Spec 26) — the +46 m comms dish aims at it; clearance math. */
export const CITADEL_SEAT: Readonly<{ x: number; y: number }> = Object.freeze({ x: -1850, y: 2400 });

/** Ladder rail contract answered by {@link RadioTower.getLadderBounds}. */
export interface LadderBounds {
  /** Foundation base coordinate of the ladder rungs (z = ground datum). */
  basePosition: { x: number; y: number; z: number };
  /** Summit deck threshold coordinate where ladder reaches platform trapdoor. */
  topPosition: { x: number; y: number; z: number };
  /** Outward normal vector perpendicular to ladder rungs (points away from tower core). */
  facingNormal: { x: number; y: number };
  /** Transverse width of each rung (m). */
  rungWidthM: number;
  /** Total rung count from base to top deck. */
  totalRungs: number;
  /** Total climbable height span (m). */
  climbHeightM: number;
}

/** Beacon strobe evaluation returned by {@link RadioTower.getBeaconPulseState}. */
export interface BeaconPulseState {
  /** Tower-local animation clock (s). */
  elapsedS: number;
  /** Red obstruction pulse 0..1 (sharp sine peak). */
  redIntensity: number;
  /** White xenon double-flash 0..1 (twin window per period). */
  whiteIntensity: number;
}

/** Shared PBR set, built once per tower. */
interface RadioTowerMaterials {
  /** Tapered lattice titanium corner struts, ties and X-braces. */
  titanium: PBRMaterial;
  /** Hexagonal observation deck steel grating. */
  grate: PBRMaterial;
  /** Safety-yellow ladder rungs, hoops, railings and hatch furniture. */
  safety: PBRMaterial;
  /** Animated red aviation obstruction beacon (emissive, base = beaconColor). */
  beaconRed: PBRMaterial;
  /** Animated white xenon strobe (emissive). */
  beaconWhite: PBRMaterial;
  /** Microwave dish composite shell. */
  dish: PBRMaterial;
  /** Foundation concrete. */
  concrete: PBRMaterial;
  /** Hatch void inset (near-black recess under the open trapdoor). */
  hatchVoid: PBRMaterial;
}

// -- helpers ------------------------------------------------------------------

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** World-frame 2D distance between two points. */
function dist2(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** Babylon-local planar point at yaw angle + radius (yaw law: (sin, 0, cos)). */
function polarLocal(yaw: number, radius: number): { x: number; z: number } {
  return { x: Math.sin(yaw) * radius, z: Math.cos(yaw) * radius };
}

/** Point lerp between two Babylon-local planar points. */
function lerpLocal(
  a: { x: number; z: number },
  b: { x: number; z: number },
  t: number,
): { x: number; z: number } {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

// ================================================================================

export class RadioTower {
  // -- canonical source of truth (pure math; scene-independent) ----------------
  private readonly worldPosition: { x: number; y: number; z: number };
  private readonly towerHeightM: number;
  private readonly deckElevationM: number;
  private readonly baseWidthM: number;
  private readonly topWidthM: number;
  private readonly ladderFacingRad: number;
  private readonly beaconColor: { r: number; g: number; b: number };

  /** Outward ladder face normal in world frame { x: cos f, y: sin f }. */
  private readonly nx: number;
  private readonly ny: number;
  /** Same normal as Babylon-local yaw (atan2(nx, -ny)). */
  private readonly ladderYaw: number;
  /** Climbable vertical span (== deckElevationM by contract). */
  private readonly climbHeightM: number;
  /** Rung count floor(climbHeight / pitch) — 48.0/0.35 -> 137 canonical. */
  private readonly totalRungs: number;

  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;

  private root: TransformNode | null = null;
  private subNodes: TransformNode[] = [];
  private meshList: Mesh[] = [];
  private materials: RadioTowerMaterials | null = null;
  private materialList: PBRMaterial[] = [];

  private elapsed = 0;
  private built = false;
  private disposed = false;

  constructor(options: Partial<RadioTowerOptions> = {}) {
    const wd = RADIO_TOWER_DEFAULTS;
    const wp = options.worldPosition ?? wd.worldPosition;
    this.worldPosition = {
      x: finiteOr(wp.x, wd.worldPosition.x),
      y: finiteOr(wp.y, wd.worldPosition.y),
      z: finiteOr(wp.z, wd.worldPosition.z),
    };
    let deck = finiteOr(options.deckElevationM, wd.deckElevationM);
    if (deck <= 0) deck = wd.deckElevationM;
    let height = finiteOr(options.towerHeightM, wd.towerHeightM);
    // The spire must clear the deck: an impossible tower gets deck + canonical cap margin.
    if (height <= deck) height = deck + (wd.towerHeightM - wd.deckElevationM);
    let base = finiteOr(options.baseWidthM, wd.baseWidthM);
    if (base <= 0) base = wd.baseWidthM;
    let top = finiteOr(options.topWidthM, wd.topWidthM);
    if (top <= 0 || top >= base) top = wd.topWidthM;
    const facing = finiteOr(options.ladderFacingRad, wd.ladderFacingRad);
    const bc = options.beaconColor ?? wd.beaconColor;
    this.beaconColor = {
      r: clamp(finiteOr(bc.r, wd.beaconColor.r), 0, 1),
      g: clamp(finiteOr(bc.g, wd.beaconColor.g), 0, 1),
      b: clamp(finiteOr(bc.b, wd.beaconColor.b), 0, 1),
    };
    this.deckElevationM = deck;
    this.towerHeightM = height;
    this.baseWidthM = base;
    this.topWidthM = top;
    this.ladderFacingRad = facing;
    this.nx = Math.cos(facing);
    this.ny = Math.sin(facing);
    this.ladderYaw = Math.atan2(this.nx, -this.ny);
    this.climbHeightM = deck;
    this.totalRungs = Math.floor(deck / LADDER_RUNG_PITCH_M);
  }

  // -- pure spatial API (world frame, scene-independent) ------------------------

  /**
   * Full ladder rail contract. `basePosition` sits at ground datum on the
   * ladder face (halfWidth(0) + 0.25 m out from the tower axis); `topPosition`
   * at deck elevation on the (tapered) face, right at the trapdoor threshold.
   * Answers before init, after dispose, with no scene.
   */
  getLadderBounds(): LadderBounds {
    return {
      basePosition: {
        x: this.worldPosition.x + this.nx * this.rungRadiusAtZ(0),
        y: this.worldPosition.y + this.ny * this.rungRadiusAtZ(0),
        z: this.worldPosition.z,
      },
      topPosition: {
        x: this.worldPosition.x + this.nx * this.rungRadiusAtZ(this.climbHeightM),
        y: this.worldPosition.y + this.ny * this.rungRadiusAtZ(this.climbHeightM),
        z: this.worldPosition.z + this.climbHeightM,
      },
      facingNormal: { x: this.nx, y: this.ny },
      rungWidthM: LADDER_RUNG_WIDTH_M,
      totalRungs: this.totalRungs,
      climbHeightM: this.climbHeightM,
    };
  }

  /**
   * Base detection cylinder (Spec 29 §2.3): within `radiusM` (default 1.8 m)
   * of the ladder base in plan AND within 2.5 m of base z. Non-finite input
   * answers false — the HUD never flickers on a NaN.
   */
  isNearLadderBase(pos: { x: number; y: number; z: number }, radiusM = LADDER_BASE_DETECT_RADIUS_M): boolean {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return false;
    const r = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : LADDER_BASE_DETECT_RADIUS_M;
    const bx = this.worldPosition.x + this.nx * this.rungRadiusAtZ(0);
    const by = this.worldPosition.y + this.ny * this.rungRadiusAtZ(0);
    if (dist2(pos.x, pos.y, bx, by) > r) return false;
    return Math.abs(pos.z - this.worldPosition.z) <= LADDER_BASE_VERTICAL_ENVELOPE_M;
  }

  /**
   * Summit hatch detection (Spec 29 §3.2.6): within `radiusM` (default 1.0 m)
   * of the trapdoor centre in plan AND within 1.5 m of deck elevation.
   */
  isNearTopHatch(pos: { x: number; y: number; z: number }, radiusM = HATCH_DETECT_RADIUS_M): boolean {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return false;
    const r = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : HATCH_DETECT_RADIUS_M;
    const hx = this.worldPosition.x + this.nx * this.rungRadiusAtZ(this.climbHeightM);
    const hy = this.worldPosition.y + this.ny * this.rungRadiusAtZ(this.climbHeightM);
    if (dist2(pos.x, pos.y, hx, hy) > r) return false;
    return Math.abs(pos.z - this.getDeckElevation()) <= HATCH_VERTICAL_ENVELOPE_M;
  }

  /**
   * Ladder bounding cylinder from base to summit: within
   * {@link CLIMB_ENVELOPE_RADIUS_M} (1.0 m) horizontally of the tapered rung
   * centreline at the sample's own height (clamped to the climb span), and
   * vertically within [base - 0.25 m, deck + 0.6 m] (the extra deck margin
   * keeps a player standing at the open hatch re-latchable).
   */
  isWithinClimbEnvelope(pos: { x: number; y: number; z: number }): boolean {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return false;
    const localZ = pos.z - this.worldPosition.z;
    if (localZ < -0.25 || localZ > this.climbHeightM + 0.6) return false;
    const rc = this.rungRadiusAtZ(clamp(localZ, 0, this.climbHeightM));
    const cx = this.worldPosition.x + this.nx * rc;
    const cy = this.worldPosition.y + this.ny * rc;
    return dist2(pos.x, pos.y, cx, cy) <= CLIMB_ENVELOPE_RADIUS_M;
  }

  /**
   * Climber body-rail plan position at world height z (Spec 29 §3.2.1): the
   * rung centre at that height (z clamped to the climb span) offset a further
   * 0.30 m outward along the ladder normal. Non-finite z is treated as the
   * base datum. Answers before init / after dispose.
   */
  getClimbOffsetPosition(z: number): { x: number; y: number } {
    const localZ = Number.isFinite(z) ? clamp(z - this.worldPosition.z, 0, this.climbHeightM) : 0;
    const r = this.rungRadiusAtZ(localZ) + LADDER_BODY_OFFSET_M;
    return {
      x: this.worldPosition.x + this.nx * r,
      y: this.worldPosition.y + this.ny * r,
    };
  }

  /** World z of the observation deck walking surface (foundation z + 48.0). */
  getDeckElevation(): number {
    return this.worldPosition.z + this.climbHeightM;
  }

  /** Tower foundation seat in world metres (copy). */
  getWorldPosition(): { x: number; y: number; z: number } {
    return { ...this.worldPosition };
  }

  /** 2D clearance from the X-Corp Citadel seat (m) — spec asserts > 260 m warning ring. */
  getDistanceToCitadel(): number {
    return dist2(this.worldPosition.x, this.worldPosition.y, CITADEL_SEAT.x, CITADEL_SEAT.y);
  }

  /**
   * Beacon strobe evaluation at the current clock (pure law; advances even
   * with no scene so headless harnesses see deterministic pulses).
   * Red: 0.85 Hz obstruction pulse, sin^3 shaping (sharp peak, dark floor).
   * White: 0.5 Hz xenon double-flash — two windows per period
   * (phase < 0.05 and 0.12..0.17), off elsewhere.
   */
  getBeaconPulseState(): BeaconPulseState {
    return { elapsedS: this.elapsed, ...RadioTower.pulseAt(this.elapsed) };
  }

  private static pulseAt(t: number): { redIntensity: number; whiteIntensity: number } {
    const s = 0.5 + 0.5 * Math.sin(2 * Math.PI * RED_BEACON_PULSE_HZ * t - Math.PI / 2);
    const redIntensity = s * s * s;
    const phase = (t * WHITE_STROBE_FLASH_HZ) % 1;
    const whiteIntensity = phase < 0.05 || (phase >= 0.12 && phase < 0.17) ? 1 : 0;
    return { redIntensity, whiteIntensity };
  }

  /**
   * One frame: advance the strobe clock and drive the beacon emissives.
   * Safe before init / after dispose (clock still advances; no mesh touch).
   */
  update(deltaS: number): void {
    if (Number.isFinite(deltaS) && deltaS > 0) this.elapsed += deltaS;
    if (!this.built || this.disposed || this.materials === null) return;
    const pulse = RadioTower.pulseAt(this.elapsed);
    const c = this.beaconColor;
    const ri = 0.1 + 0.9 * pulse.redIntensity;
    this.materials.beaconRed.emissiveColor.set(c.r * ri, c.g * ri, c.b * ri);
    const wi = 0.06 + 0.94 * pulse.whiteIntensity;
    this.materials.beaconWhite.emissiveColor.set(wi, wi, wi);
  }

  // -- internal geometry --------------------------------------------------------

  /** Truss half-width at height z above foundation (linear taper to topWidth/2 at 47.5 m, clamped above). */
  private halfWidthAtZ(z: number): number {
    const halfBase = this.baseWidthM / 2;
    const halfTop = this.topWidthM / 2;
    const t = clamp(z / TAPER_TOP_Z_M, 0, 1);
    return halfBase + (halfTop - halfBase) * t;
  }

  /** Horizontal tower-axis distance of a rung centre at height z (half-width + 0.25 m protrusion). */
  private rungRadiusAtZ(z: number): number {
    return this.halfWidthAtZ(z) + LADDER_PROTRUSION_M;
  }

  // -- lifecycle ------------------------------------------------------------------

  /**
   * Build the tower. Accepts an existing `Scene`, a raw engine (a scene is
   * created around it), or nothing — falling back to a self-owned
   * `NullEngine`, exactly what CI wants. Idempotent; refuses after `dispose()`.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('RadioTower: init() after dispose()');
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
      throw new Error('RadioTower.init: browser needs a Scene or Engine');
    }

    const scene = this.scene;
    this.root = new TransformNode(`${RADIO_TOWER_NAME_PREFIX}-system`, scene);
    this.root.position.copyFrom(worldToBabylon(this.worldPosition));
    this.materials = this.buildMaterials(scene);
    this.buildTower(scene);
    this.built = true;
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /** Tear down every mesh, material, node and any self-owned engine. Never throws; idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;

    for (const mesh of this.meshList) RadioTower.disposeQuietly(mesh);
    this.meshList = [];
    for (const material of this.materialList) RadioTower.disposeQuietly(material);
    this.materialList = [];
    this.materials = null;
    for (const node of this.subNodes) RadioTower.disposeQuietly(node);
    this.subNodes = [];
    RadioTower.disposeQuietly(this.root);
    this.root = null;

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) RadioTower.disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- accessors --------------------------------------------------------------------

  /** System root transform (null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every tower mesh (copy). Empty before init and after dispose. */
  getMeshes(): AbstractMesh[] {
    return [...this.meshList];
  }

  /**
   * Shadow-casting subset: the tower is all matter — every mesh occludes the
   * sun. The metadata filter excludes any future emissive-glow-only parts so
   * halo halos never harden the lattice shadow.
   */
  getShadowCasterMeshes(): AbstractMesh[] {
    return this.meshList.filter((m) => {
      const part = m.metadata?.part as string | undefined;
      return part !== 'glow';
    });
  }

  /**
   * Meshes tagged with a part id — 'foundation' | 'pillar' | 'tie-beam' |
   * 'diagonal' | 'rung' | 'hoop' | 'deck' | 'railing' | 'hatch' | 'dish' |
   * 'spire' | 'beacon' — the smoke suite's structural assertion handle.
   */
  getPartMeshes(part: string): Mesh[] {
    return this.meshList.filter((m) => (m.metadata?.part as string | undefined) === part);
  }

  // -- materials ----------------------------------------------------------------------

  /** Vacuum-lunar PBR shorthand; environment stays near zero, nothing to reflect. */
  private static mk(
    name: string,
    scene: Scene,
    albedo: readonly [number, number, number],
    metallic: number,
    roughness: number,
    emissive?: readonly [number, number, number],
    environmentIntensity = 0.05,
  ): PBRMaterial {
    const material = new PBRMaterial(name, scene);
    material.albedoColor = Color3.FromArray(albedo);
    material.metallic = metallic;
    material.roughness = roughness;
    if (emissive !== undefined) material.emissiveColor = Color3.FromArray(emissive);
    material.environmentIntensity = environmentIntensity;
    return material;
  }

  private buildMaterials(scene: Scene): RadioTowerMaterials {
    const c = this.beaconColor;
    const materials: RadioTowerMaterials = {
      // Spec 29 §2.2: titanium lattice — bright anodised metal, mid rough.
      titanium: RadioTower.mk(`${RADIO_TOWER_NAME_PREFIX}-lattice-titanium`, scene, [0.72, 0.73, 0.76], 0.85, 0.42, undefined, 0.15),
      // Industrial steel grating deck.
      grate: RadioTower.mk(`${RADIO_TOWER_NAME_PREFIX}-grate-deck`, scene, [0.35, 0.36, 0.38], 0.7, 0.62, undefined, 0.1),
      // Safety-yellow climbing furniture.
      safety: RadioTower.mk(`${RADIO_TOWER_NAME_PREFIX}-safety-yellow`, scene, [0.78, 0.56, 0.1], 0.55, 0.5, undefined, 0.1),
      // Animated aviation beacons (update() drives emissiveColor each frame).
      beaconRed: RadioTower.mk(`${RADIO_TOWER_NAME_PREFIX}-beacon-strobe`, scene, [0.2, 0.02, 0.02], 0.2, 0.35, [c.r * 0.1, c.g * 0.1, c.b * 0.1], 0),
      beaconWhite: RadioTower.mk(`${RADIO_TOWER_NAME_PREFIX}-beacon-white`, scene, [0.9, 0.9, 0.9], 0.2, 0.3, [0.06, 0.06, 0.06], 0),
      // Microwave dish composite.
      dish: RadioTower.mk(`${RADIO_TOWER_NAME_PREFIX}-dish-composite`, scene, [0.85, 0.85, 0.88], 0.3, 0.35, undefined, 0.2),
      concrete: RadioTower.mk(`${RADIO_TOWER_NAME_PREFIX}-foundation`, scene, [0.18, 0.17, 0.16], 0.2, 0.9, undefined, 0.05),
      hatchVoid: RadioTower.mk(`${RADIO_TOWER_NAME_PREFIX}-hatch-void`, scene, [0.01, 0.01, 0.012], 0.1, 0.95, undefined, 0),
    };
    for (const material of Object.values(materials)) this.materialList.push(material);
    return materials;
  }

  // -- mesh construction ----------------------------------------------------------------

  /** Create + place + parent + metadata-tag in one call (Babylon-local frame). */
  private part(
    name: string,
    partId: string,
    mesh: Mesh,
    mat: PBRMaterial,
    x: number,
    y: number,
    z: number,
    parent?: TransformNode,
  ): Mesh {
    mesh.material = mat;
    mesh.position.set(x, y, z);
    mesh.parent = parent ?? this.root;
    mesh.metadata = { part: partId, system: RADIO_TOWER_NAME_PREFIX };
    this.meshList.push(mesh);
    return mesh;
  }

  /**
   * Orient a cylinder so its local +y axis lies along the unit direction
   * (dx, dy, dz): axis = y-hat x d = (dz, 0, -dx), angle = atan2(|d_xz|, dy)
   * — verified exact on this Babylon build (maps +y onto d, antiparallel
   * included). d == +y leaves the default orientation (identity).
   */
  private static orientY(mesh: Mesh, dx: number, dy: number, dz: number): void {
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) return;
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    const ax = uz;
    const az = -ux;
    const s = Math.hypot(ax, az);
    if (s < 1e-9) {
      // Antiparallel to +y: flip 180 deg about z. (Parallel: identity.)
      if (uy < 0) mesh.rotationQuaternion = new Quaternion(0, 0, 1, 0);
      return;
    }
    const theta = Math.atan2(s, uy);
    const half = theta / 2;
    const k = Math.sin(half);
    mesh.rotationQuaternion = new Quaternion((ax / s) * k, 0, (az / s) * k, Math.cos(half));
  }

  /** Straight tube from point a to point b (Babylon-local), both endpoints exact. */
  private tube(
    scene: Scene,
    name: string,
    partId: string,
    mat: PBRMaterial,
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
    diameter: number,
    parent?: TransformNode,
    diameterTop?: number,
  ): Mesh {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const length = Math.max(Math.hypot(dx, dy, dz), 1e-4);
    const mesh = MeshBuilder.CreateCylinder(
      `${RADIO_TOWER_NAME_PREFIX}-${name}`,
      { diameterBottom: diameter, diameterTop: diameterTop ?? diameter, height: length, tessellation: 8 },
      scene,
    );
    this.part(name, partId, mesh, mat, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, parent);
    RadioTower.orientY(mesh, dx, dy, dz);
    return mesh;
  }

  /** Lattice corner j (wrapping), height z above foundation, Babylon local. */
  private cornerAt(j: number, z: number): { x: number; y: number; z: number } {
    const angle = this.ladderFacingRad + Math.PI / 4 + (((j % 4) + 4) % 4) * (Math.PI / 2);
    const r = this.halfWidthAtZ(z) * Math.SQRT2;
    return { x: Math.cos(angle) * r, y: z, z: -Math.sin(angle) * r };
  }

  private node(name: string, scene: Scene): TransformNode {
    const n = new TransformNode(`${RADIO_TOWER_NAME_PREFIX}-${name}`, scene);
    n.parent = this.root;
    this.subNodes.push(n);
    return n;
  }

  private buildTower(scene: Scene): void {
    const m = this.materials as RadioTowerMaterials; // set by init() before this call

    const lattice = this.node('lattice', scene);
    const ladder = this.node('ladder', scene);
    const deck = this.node('deck', scene);
    const antenna = this.node('antenna', scene);

    const psi = this.ladderYaw; // Babylon yaw of the ladder face normal
    // Unit bases of the ladder-face frame in Babylon local
    // (r̂ = outward normal via the (sin, cos) yaw law, t̂ = along-face).
    const rHat = polarLocal(psi, 1);
    const tHat = { x: Math.cos(psi), z: -Math.sin(psi) };

    // -- foundation ------------------------------------------------------------------
    this.part('pad', 'foundation',
      MeshBuilder.CreateBox(`${RADIO_TOWER_NAME_PREFIX}-pad`, { width: 9.0, depth: 9.0, height: 0.5 }, scene),
      m.concrete, 0, 0.25, 0);
    for (let j = 0; j < 4; j++) {
      const foot = this.cornerAt(j, 0);
      this.part(`footing-${j}`, 'foundation',
        MeshBuilder.CreateBox(`${RADIO_TOWER_NAME_PREFIX}-footing-${j}`, { width: 1.8, depth: 1.8, height: 0.9 }, scene),
        m.concrete, foot.x, 0.55, foot.z);
    }

    // -- tapered corner pillars: 8 bays x 4 legs, every segment converging -----------
    const bayH = TAPER_TOP_Z_M / LATTICE_BAY_COUNT; // 5.9375 m canonical
    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < LATTICE_BAY_COUNT; k++) {
        this.tube(scene, `pillar-${j}-${k}`, 'pillar', m.titanium,
          this.cornerAt(j, k * bayH), this.cornerAt(j, (k + 1) * bayH), 0.16, lattice, 0.12);
      }
    }

    // -- horizontal tie beams at every bay line (levels 1..8) -------------------------
    for (let k = 1; k <= LATTICE_BAY_COUNT; k++) {
      const z = k * bayH;
      for (let j = 0; j < 4; j++) {
        this.tube(scene, `tie-${j}-${k}`, 'tie-beam', m.titanium,
          this.cornerAt(j, z), this.cornerAt(j + 1, z), 0.1, lattice);
      }
    }

    // -- diagonal X-lattices: 8 bays x 4 faces x 2 braces (r = 0.03 m) ----------------
    for (let k = 0; k < LATTICE_BAY_COUNT; k++) {
      const zLo = k * bayH;
      const zHi = (k + 1) * bayH;
      for (let j = 0; j < 4; j++) {
        this.tube(scene, `xbr-${j}-${k}a`, 'diagonal', m.titanium,
          this.cornerAt(j, zLo), this.cornerAt(j + 1, zHi), 0.06, lattice);
        this.tube(scene, `xbr-${j}-${k}b`, 'diagonal', m.titanium,
          this.cornerAt(j + 1, zLo), this.cornerAt(j, zHi), 0.06, lattice);
      }
    }

    // -- ladder rungs: k * 0.35 m, k = 1..137, riding the truss taper -----------------
    for (let k = 1; k <= this.totalRungs; k++) {
      const z = k * LADDER_RUNG_PITCH_M;
      const c = polarLocal(psi, this.rungRadiusAtZ(z));
      const rung = MeshBuilder.CreateCylinder(`${RADIO_TOWER_NAME_PREFIX}-rung-${k}`,
        { diameter: LADDER_RUNG_RADIUS_M * 2, height: LADDER_RUNG_WIDTH_M, tessellation: 6 }, scene);
      this.part(`rung-${k}`, 'rung', rung, m.safety, c.x, z, c.z, ladder);
      RadioTower.orientY(rung, tHat.x, 0, tHat.z); // horizontal, along the face
    }

    // -- circular safety hoops every 2.1 m from +3.0 m (Spec 29 §2.3) ------------------
    const hoopCount = Math.floor((this.climbHeightM - SAFETY_HOOP_START_M) / SAFETY_HOOP_SPACING_M) + 1;
    for (let h = 0; h < hoopCount; h++) {
      const y = SAFETY_HOOP_START_M + h * SAFETY_HOOP_SPACING_M;
      const c = polarLocal(psi, this.rungRadiusAtZ(y));
      this.part(`hoop-${h}`, 'hoop',
        MeshBuilder.CreateTorus(`${RADIO_TOWER_NAME_PREFIX}-hoop-${h}`,
          { diameter: SAFETY_HOOP_RADIUS_M * 2, thickness: 0.035, tessellation: 20 }, scene),
        m.safety, c.x, y, c.z, ladder);
    }

    // -- hexagonal observation deck at +48.0 m -----------------------------------------
    const deckY = this.climbHeightM; // walking-surface datum (local y)
    const verts: { x: number; z: number }[] = [];
    for (let j = 0; j < 6; j++) verts.push(polarLocal(psi + Math.PI / 6 + (j * Math.PI) / 3, DECK_SPAN_M / 2));
    // Support stubs from the pillar tops (deck neck) up to the slab underside.
    for (let j = 0; j < 4; j++) {
      const c = this.cornerAt(j, TAPER_TOP_Z_M);
      this.tube(scene, `deck-stub-${j}`, 'deck', m.titanium,
        { x: c.x, y: TAPER_TOP_Z_M, z: c.z }, { x: c.x, y: deckY - DECK_SLAB_THICKNESS_M, z: c.z }, 0.16, deck);
    }
    const slab = this.part('slab', 'deck',
      MeshBuilder.CreateCylinder(`${RADIO_TOWER_NAME_PREFIX}-slab`,
        { diameterBottom: DECK_SPAN_M, diameterTop: DECK_SPAN_M, height: DECK_SLAB_THICKNESS_M, tessellation: 6 }, scene),
      m.grate, 0, deckY - DECK_SLAB_THICKNESS_M / 2, 0, deck);
    slab.rotation.y = psi + Math.PI / 6;

    // Perimeter railings: handrail 1.1 m + mid-rail 0.55 m + kick-plate 0.15 m.
    // Edge 0 (centred on the ladder face) carries the hatch gap in its rails.
    const edgeLen = Math.hypot(verts[1]!.x - verts[0]!.x, verts[1]!.z - verts[0]!.z);
    const GAP_HALF_T = (HATCH_SIZE_M + 0.3) / 2 / edgeLen; // half-gap in edge parameter
    const edgePoint = (j: number, t: number): { x: number; z: number } =>
      lerpLocal(verts[j % 6]!, verts[(j + 1) % 6]!, t);
    const railSegments: { a: { x: number; z: number }; b: { x: number; z: number } }[] = [];
    for (let j = 1; j < 6; j++) railSegments.push({ a: edgePoint(j, 0), b: edgePoint(j, 1) });
    railSegments.push({ a: edgePoint(0, 0), b: edgePoint(0, 0.5 - GAP_HALF_T) });
    railSegments.push({ a: edgePoint(0, 0.5 + GAP_HALF_T), b: edgePoint(0, 1) });
    railSegments.forEach((seg, i) => {
      this.tube(scene, `handrail-${i}`, 'railing', m.safety,
        { x: seg.a.x, y: deckY + HANDRAIL_HEIGHT_M, z: seg.a.z },
        { x: seg.b.x, y: deckY + HANDRAIL_HEIGHT_M, z: seg.b.z }, 0.055, deck);
      this.tube(scene, `midrail-${i}`, 'railing', m.safety,
        { x: seg.a.x, y: deckY + MIDRAIL_HEIGHT_M, z: seg.a.z },
        { x: seg.b.x, y: deckY + MIDRAIL_HEIGHT_M, z: seg.b.z }, 0.04, deck);
    });
    for (let j = 0; j < 6; j++) {
      const a = verts[j]!;
      const b = verts[(j + 1) % 6]!;
      const yaw = Math.atan2(-(b.z - a.z), b.x - a.x); // maps local +x onto the edge direction
      const plate = this.part(`kickplate-${j}`, 'railing',
        MeshBuilder.CreateBox(`${RADIO_TOWER_NAME_PREFIX}-kickplate-${j}`,
          { width: edgeLen, depth: 0.025, height: KICKPLATE_HEIGHT_M }, scene),
        m.safety, (a.x + b.x) / 2, deckY + KICKPLATE_HEIGHT_M / 2, (a.z + b.z) / 2, deck);
      plate.rotation.y = yaw;
    }
    // Posts at every hex vertex plus the two gap stiles on edge 0.
    const postSpots: { x: number; z: number }[] = verts.map((v) => ({ x: v.x, z: v.z }));
    postSpots.push(edgePoint(0, 0.5 - GAP_HALF_T), edgePoint(0, 0.5 + GAP_HALF_T));
    postSpots.forEach((p, i) => {
      this.tube(scene, `post-${i}`, 'railing', m.safety,
        { x: p.x, y: deckY + 0.02, z: p.z }, { x: p.x, y: deckY + HANDRAIL_HEIGHT_M, z: p.z }, 0.05, deck);
    });

    // Trapdoor: 0.9 x 0.9 m opening centred on the ladder line, swing-open
    // panel, raised curb, and a dark void recess (collision datum is pure math).
    const hatchCentre = polarLocal(psi, this.rungRadiusAtZ(this.climbHeightM));
    const hatch = new TransformNode(`${RADIO_TOWER_NAME_PREFIX}-hatch`, scene);
    hatch.parent = this.root;
    hatch.position.set(hatchCentre.x, deckY, hatchCentre.z);
    hatch.rotation.y = psi;
    this.subNodes.push(hatch);
    this.part('hatch-void', 'hatch',
      MeshBuilder.CreateBox(`${RADIO_TOWER_NAME_PREFIX}-hatch-void`,
        { width: HATCH_SIZE_M, depth: HATCH_SIZE_M, height: 0.06 }, scene),
      m.hatchVoid, 0, -0.02, 0, hatch);
    for (const s of [-1, 1]) {
      this.part(`hatch-curb-x${s}`, 'hatch',
        MeshBuilder.CreateBox(`${RADIO_TOWER_NAME_PREFIX}-hatch-curb-x${s}`,
          { width: HATCH_SIZE_M + 0.1, depth: 0.05, height: 0.12 }, scene),
        m.safety, 0, 0.06, s * (HATCH_SIZE_M / 2), hatch);
      this.part(`hatch-curb-z${s}`, 'hatch',
        MeshBuilder.CreateBox(`${RADIO_TOWER_NAME_PREFIX}-hatch-curb-z${s}`,
          { width: 0.05, depth: HATCH_SIZE_M + 0.1, height: 0.12 }, scene),
        m.safety, s * (HATCH_SIZE_M / 2), 0.06, 0, hatch);
    }
    const hinge = new TransformNode(`${RADIO_TOWER_NAME_PREFIX}-hatch-hinge`, scene);
    hinge.parent = hatch;
    hinge.position.set(HATCH_SIZE_M / 2, 0.02, 0);
    hinge.rotation.y = 2.0; // swung ~115 deg open toward the deck centre
    this.subNodes.push(hinge);
    this.part('hatch-panel', 'hatch',
      MeshBuilder.CreateBox(`${RADIO_TOWER_NAME_PREFIX}-hatch-panel`,
        { width: HATCH_SIZE_M, depth: HATCH_SIZE_M, height: 0.05 }, scene),
      m.safety, HATCH_SIZE_M / 2 + 0.03, 0, 0, hinge);

    // -- dual microwave dishes (Spec 29 §2.2): +38 m aims the orbital trajectory
    // axis, +46 m aims the Citadel comms receiver.
    const dishAims: { elev: number; aim: { x: number; y: number; z: number } }[] = [
      { elev: 38.0, aim: { x: -0.22, y: 0.4, z: 0.89 } },
      {
        elev: 46.0,
        aim: {
          x: CITADEL_SEAT.x - this.worldPosition.x,
          y: CITADEL_SEAT.y - this.worldPosition.y,
          z: 16,
        },
      },
    ];
    dishAims.forEach((spec, i) => {
      const y = spec.elev;
      const len = Math.hypot(spec.aim.x, spec.aim.y, spec.aim.z);
      // World aim -> Babylon local (x, z_up, -y).
      const aim = { x: spec.aim.x / len, y: spec.aim.z / len, z: -spec.aim.y / len };
      const hLen = Math.hypot(aim.x, aim.z) || 1;
      const dir = { x: aim.x / hLen, z: aim.z / hLen };
      const r0 = this.halfWidthAtZ(y);
      const base = { x: dir.x * (r0 - 0.3), y: y - 0.2, z: dir.z * (r0 - 0.3) };
      const mount = { x: dir.x * (r0 + 1.1), y: y, z: dir.z * (r0 + 1.1) };
      this.tube(scene, `dish-arm-${i}`, 'dish', m.titanium, base, mount, 0.14, antenna);
      const dish = MeshBuilder.CreateCylinder(`${RADIO_TOWER_NAME_PREFIX}-dish-${i}`,
        { diameterTop: DISH_DIAMETER_M, diameterBottom: DISH_DIAMETER_M * 0.35, height: DISH_DEPTH_M, tessellation: 20 }, scene);
      this.part(`dish-${i}`, 'dish', dish, m.dish,
        mount.x + aim.x * 0.25, mount.y + aim.y * 0.25, mount.z + aim.z * 0.25, antenna);
      RadioTower.orientY(dish, aim.x, aim.y, aim.z); // rim opens toward the aim
      const feedRoot = { x: mount.x + aim.x * 0.1, y: mount.y + aim.y * 0.1, z: mount.z + aim.z * 0.1 };
      const feed = { x: mount.x + aim.x * 0.68, y: mount.y + aim.y * 0.68, z: mount.z + aim.z * 0.68 };
      this.tube(scene, `dish-feed-${i}`, 'dish', m.titanium, feedRoot, feed, 0.05, antenna);
      this.part(`dish-horn-${i}`, 'dish',
        MeshBuilder.CreateSphere(`${RADIO_TOWER_NAME_PREFIX}-dish-horn-${i}`, { diameter: 0.22, segments: 8 }, scene),
        m.dish, feed.x, feed.y, feed.z, antenna);
    });

    // -- centre antenna spire to +52.0 m + dual-strobe aviation beacon ------------------
    this.tube(scene, 'spire-mast', 'spire', m.titanium,
      { x: 0, y: this.climbHeightM, z: 0 }, { x: 0, y: this.towerHeightM, z: 0 }, 0.55, antenna, 0.14);
    const dipole = MeshBuilder.CreateCylinder(`${RADIO_TOWER_NAME_PREFIX}-dipole-arm`,
      { diameter: 0.07, height: 3.2, tessellation: 6 }, scene);
    this.part('dipole-arm', 'spire', dipole, m.titanium, 0, this.towerHeightM - 0.9, 0, antenna);
    RadioTower.orientY(dipole, tHat.x, 0, tHat.z);
    const crossArm = MeshBuilder.CreateCylinder(`${RADIO_TOWER_NAME_PREFIX}-cross-arm`,
      { diameter: 0.07, height: 2.4, tessellation: 6 }, scene);
    this.part('cross-arm', 'spire', crossArm, m.titanium, 0, this.towerHeightM - 1.6, 0, antenna);
    RadioTower.orientY(crossArm, rHat.x, 0, rHat.z);
    this.part('spire-tip', 'spire',
      MeshBuilder.CreateSphere(`${RADIO_TOWER_NAME_PREFIX}-spire-tip`, { diameter: 0.2, segments: 8 }, scene),
      m.titanium, 0, this.towerHeightM + 0.06, 0, antenna);
    this.tube(scene, 'beacon-bracket', 'beacon', m.titanium,
      { x: 0, y: this.towerHeightM + 0.12, z: 0 }, { x: 0, y: this.towerHeightM + 0.62, z: 0 }, 0.08, antenna);
    this.part('beacon-red', 'beacon',
      MeshBuilder.CreateSphere(`${RADIO_TOWER_NAME_PREFIX}-beacon-red`, { diameter: 0.36, segments: 12 }, scene),
      m.beaconRed, 0, this.towerHeightM + 0.8, 0, antenna);
    this.part('beacon-white', 'beacon',
      MeshBuilder.CreateSphere(`${RADIO_TOWER_NAME_PREFIX}-beacon-white`, { diameter: 0.24, segments: 10 }, scene),
      m.beaconWhite, 0, this.towerHeightM + 0.42, 0, antenna);
  }

  // -- teardown helper ------------------------------------------------------------------

  private static disposeQuietly(target: { dispose(): unknown } | null): void {
    if (target === null) return;
    try {
      target.dispose();
    } catch {
      /* already gone */
    }
  }
}
