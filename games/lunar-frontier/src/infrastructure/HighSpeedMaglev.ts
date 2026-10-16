/**
 * Lunar Frontier — High-Speed Maglev Rail System, "Apex Express" (Spec 26 §3.2).
 *
 * A 3,500 m elevated linear-induction guideway threading the basalt canyon
 * from the Canyon Extraction Outpost (1200, 800) to the Citadel Grand
 * Terminal (−1850, 2400): concrete-composite pylons every ~24 m lift the deck
 * 2.5–6.0 m above the regolith, twin stator guide rails pulse blue-light
 * chevrons forward along the line, and a graded maintenance service road runs
 * 4.0 m to starboard for the rover interception (Phase 3's velocity-matching
 * corridor).
 *
 * The train is a 4-car aerodynamic consist — locomotive, armored vault car
 * (the heist target with its roof-mounted Cyber-Lock container), executive
 * courier with a carbon-glass roof, and a drone/comm flatbed escort — each
 * car anchored at s_i(t) = s(t) − i·L_car on a uniform parametric cubic
 * Catmull-Rom spline with arc-length parameterization s ∈ [0, totalSplineLengthM],
 * oriented with the local forward tangent (blueprint §3.2.3).
 *
 * Deterministic and scene-independent: the control net, arc-length LUT,
 * elevation profile, and every kinematic query (`update`, `getTrainState`,
 * `getVaultCarState`, `getServiceRoadPointAtDistance`, …) are pure math over
 * constructor options — they answer before `init()`, after `dispose()`, and
 * with no scene at all, so the TrainHeistDirector (Phase 3) and the LunarHUD
 * telemetry can never race the mesh build. `init()` accepts a Scene, a raw
 * engine (a scene is created around it), or nothing (self-owned NullEngine
 * fallback), exactly like XCorpCitadel. `dispose()` is idempotent and never
 * throws.
 *
 * Coordinates: world metres (x, y lateral, z up) → Babylon (x, z↑, −y) via
 * the shared `worldToBabylon`; car model local frame is forward +z, up +y
 * (same convention as RailSystem ore carts).
 *
 * Usage:
 *   const maglev = new HighSpeedMaglev().init(scene);
 *   const state = maglev.update(dt);       // per frame
 *   const vault = maglev.getVaultCarState(); // heist tracking anchor
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { VertexBuffer } from '@babylonjs/core/Meshes/buffer.js';
import { Scene } from '@babylonjs/core/scene.js';

import { worldToBabylon } from '../engine/CameraRig.ts';
import {
  CANYON_EXTRACTION_OUTPOST,
  CITADEL_DEFAULT_WORLD_CENTER,
} from './XCorpCitadel.ts';

// -- canonical constants (Spec 26 §3.2) ----------------------------------------

/** Guideway line length the control net is tuned to hit (m). */
export const GUIDEWAY_TARGET_LENGTH_M = 3500;

/** Spec 26 §3.2.3: cruise velocity (m/s) — 90 km/h "Gilded Serpent". */
export const DEFAULT_CRUISE_SPEED_MPS = 25.0;
/** Spec 26 §3.2.3: linear-induction acceleration rate (m/s²). */
export const DEFAULT_ACCELERATION_MPS2 = 2.0;
/** Blueprint §4: articulated car length L_car (m). */
export const DEFAULT_CAR_LENGTH_M = 14.0;

/** Spec 26 §3.2.1: graded maintenance service road starboard offset (m). */
export const SERVICE_ROAD_OFFSET_M = 4.0;
/** Spec 26 §3.2.1: concrete-composite pylon spacing (m). */
export const PYLON_SPACING_M = 24;
/** Spec 26 §3.2.1: guideway elevation band above the terrain (m). */
export const GUIDEWAY_ELEVATION_MIN_M = 2.5;
export const GUIDEWAY_ELEVATION_MAX_M = 6.0;

/** Spec 26 §3.2.2: the locomotive floats 0.4 m above the stator guideway… */
export const CARRIAGE_FLOAT_M = 0.4;
/** …with ±0.04 m suspension bobbing. */
export const SUSPENSION_BOB_M = 0.04;

/** Chevron wave travel speed along the stator rails (m/s). */
export const CHEVRON_WAVE_MPS = 18.0;
/** Chevron period along the guideway (m). */
export const CHEVRON_PERIOD_M = 40.0;

/** Consist order (Spec 26 §3.2.2). Index i of the s_i = s − i·L_car law. */
export const MAGLEV_CAR_TYPES = ['locomotive', 'vault', 'executive', 'escort'] as const;
export type MaglevCarType = (typeof MAGLEV_CAR_TYPES)[number];

/** Root/material name prefix. */
export const MAGLEV_NAME_PREFIX = 'high-speed-maglev';

// -- public shapes (Spec 26 §4 contract) ----------------------------------------

/** Per-car kinematic snapshot, world frame (m, unit vectors). */
export interface MaglevCarState {
  index: number;
  type: MaglevCarType;
  distanceAlongSplineM: number;
  worldPosition: { x: number; y: number; z: number };
  worldForward: { x: number; y: number; z: number };
  speedMps: number;
}

/** Whole-train kinematic snapshot (Spec 26 contract). */
export interface MaglevTrainState {
  speedMps: number;
  /** Consist length: cars × L_car (m) — not the guideway length. */
  totalLengthM: number;
  cars: MaglevCarState[];
  /** Remaining guideway distance from the locomotive to the depot terminal (m). */
  distanceToDepotM: number;
  /** distanceToDepotM / max(speedMps, 1.0) (s). */
  timeToDepotS: number;
}

/** Construction options; every field falls back to the Spec 26 canonical. */
export interface MaglevOptions {
  /** Line start = Canyon Extraction Outpost dock (default canonical). */
  startPos: { x: number; y: number; z: number };
  /** Line end = Citadel Grand Terminal depot (default canonical). */
  endPos: { x: number; y: number; z: number };
  /** Target guideway arc length the meander is tuned to (default 3500 m). */
  targetLengthM: number;
  cruiseSpeedMps: number;
  accelerationMps2: number;
  carLengthM: number;
}

// -- helpers ---------------------------------------------------------------------

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Deterministic low-relief canyon-floor model (world metres, z up). The
 * guideway clearance and service road crown are measured against THIS profile
 * so the whole line is self-consistent without a WorldSnapshot; amplitude
 * stays inside ±2.2 m of datum — a graded canyon corridor, not a mountain.
 */
export function maglevTerrainElevationAt(x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return (
    1.5 * Math.sin(0.0016 * x + 0.7) * Math.cos(0.0013 * y - 0.4) +
    0.7 * Math.sin(0.0009 * (0.6 * x + 0.8 * y) + 2.1)
  );
}

/** Yaw/pitch quaternion mapping model +z onto a Babylon-frame unit vector. */
function orientToTangent(target: Quaternion, f: Vector3): void {
  const yaw = Math.atan2(f.x, f.z);
  const pitch = -Math.asin(clamp(f.y, -1, 1));
  Quaternion.RotationYawPitchRollToRef(yaw, pitch, 0, target);
}

function disposeQuietly(target: { dispose(): unknown } | null): void {
  if (target === null) return;
  try {
    target.dispose();
  } catch {
    /* already gone */
  }
}

/** 2D point on the control net (meander amplitude applied at build time). */
interface NetPoint {
  x: number;
  y: number;
}

/** One stator-rail ribbon + its station arc lengths (chevron driver data). */
interface RailWave {
  mesh: Mesh;
  stationS: number[];
  colors: Float32Array;
}

/** Shared PBR set, built once per guideway. */
interface MaglevMaterials {
  concrete: PBRMaterial;
  steel: PBRMaterial;
  titanium: PBRMaterial;
  hazard: PBRMaterial;
  coil: PBRMaterial;
  glass: PBRMaterial;
  interior: PBRMaterial;
  searchlight: PBRMaterial;
  road: PBRMaterial;
  barcode: PBRMaterial;
}

// ================================================================================

export class HighSpeedMaglev {
  // -- options -------------------------------------------------------------------
  private readonly startPos: { x: number; y: number; z: number };
  private readonly endPos: { x: number; y: number; z: number };
  private readonly cruiseSpeedMps: number;
  private readonly accelerationMps2: number;
  private readonly carLengthM: number;

  // -- spline source of truth (pure math; scene-independent) ---------------------
  /** Catmull-Rom control net with mirrored phantom ends [P₋₁ … Pₙ]. */
  private readonly ctrl: NetPoint[];
  /** Arc-length LUT: cumulative metres at each uniform parameter sample. */
  private readonly lutS: number[];
  private readonly lutT: number[];
  private readonly totalSplineLengthM: number;

  // -- kinematics (pure, advances in update()) -----------------------------------
  /** Locomotive parameter s along the spline (m). */
  private headS: number;
  /** Accelerating clock: speed = min(cruise, accel × runTimeS). */
  private runTimeS = 0;
  /** Free-running clock driving chevron pulse / bobbing. */
  private elapsed = 0;

  // -- scene graph -----------------------------------------------------------------
  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;
  private root: TransformNode | null = null;
  private meshList: Mesh[] = [];
  private materials: MaglevMaterials | null = null;
  private materialList: PBRMaterial[] = [];
  private carRoots: TransformNode[] = [];
  private railWaves: RailWave[] = [];
  /** Last emitted state (harness/debug readback without re-evaluating). */
  private lastState: MaglevTrainState;

  private built = false;
  private disposed = false;

  constructor(options: Partial<MaglevOptions> = {}) {
    const sp = options.startPos ?? { ...CANYON_EXTRACTION_OUTPOST, z: 0 };
    const ep = options.endPos ?? { ...CITADEL_DEFAULT_WORLD_CENTER };
    this.startPos = {
      x: finiteOr(sp.x, CANYON_EXTRACTION_OUTPOST.x),
      y: finiteOr(sp.y, CANYON_EXTRACTION_OUTPOST.y),
      z: finiteOr(sp.z, 0),
    };
    this.endPos = {
      x: finiteOr(ep.x, CITADEL_DEFAULT_WORLD_CENTER.x),
      y: finiteOr(ep.y, CITADEL_DEFAULT_WORLD_CENTER.y),
      z: finiteOr(ep.z, CITADEL_DEFAULT_WORLD_CENTER.z),
    };
    let cruise = finiteOr(options.cruiseSpeedMps, DEFAULT_CRUISE_SPEED_MPS);
    let accel = finiteOr(options.accelerationMps2, DEFAULT_ACCELERATION_MPS2);
    let carLen = finiteOr(options.carLengthM, DEFAULT_CAR_LENGTH_M);
    if (cruise <= 0) cruise = DEFAULT_CRUISE_SPEED_MPS;
    if (accel <= 0) accel = DEFAULT_ACCELERATION_MPS2;
    if (carLen <= 0) carLen = DEFAULT_CAR_LENGTH_M;
    this.cruiseSpeedMps = cruise;
    this.accelerationMps2 = accel;
    this.carLengthM = carLen;

    // Build the meandered control net whose arc length hits the target line
    // distance: bisect a single lateral-amplitude scalar. At A = 0 the spline
    // is the straight chord (shorter than the target by construction of the
    // canon seat/outpost pair); length grows monotonically with A.
    const target = clamp(
      finiteOr(options.targetLengthM, GUIDEWAY_TARGET_LENGTH_M),
      this.chordLength() + 1e-4,
      this.chordLength() * 4,
    );
    this.ctrl = this.buildControlNet(this.amplitudeForLength(target));
    const { s, t, total } = this.buildArcLengthTable(this.ctrl);
    this.lutS = s;
    this.lutT = t;
    this.totalSplineLengthM = total;

    // Stand the consist fully on the guideway at the outpost dock: the head
    // parks at (cars − 1)·L_car so the escort tail sits at s = 0.
    this.headS = this.standbyHeadS();
    this.lastState = this.buildState(0);
  }

  // -- spline construction (constructor-time, pure) ------------------------------

  private chordLength(): number {
    return Math.hypot(this.endPos.x - this.startPos.x, this.endPos.y - this.startPos.y);
  }

  /** Meander weight envelope: zero at both terminals, unit mid-span. */
  private static meanderWeight(t: number): number {
    return Math.sin(Math.PI * clamp(t, 0, 1));
  }

  /**
   * Control net: 2 terminals + 4 interior waypoints at fixed fractional
   * stations, offset along the chord perpendicular by amplitude × pattern.
   * Phantom ends mirror across their neighbour for C¹ continuity.
   */
  private buildControlNet(amplitude: number): NetPoint[] {
    const sx = this.startPos.x;
    const sy = this.startPos.y;
    const dx = this.endPos.x - sx;
    const dy = this.endPos.y - sy;
    const len = Math.hypot(dx, dy) || 1;
    // Chord-left perpendicular (unit).
    const px = -dy / len;
    const py = dx / len;
    // Interior stations (t) and lateral pattern (m) — an asymmetric S-S run
    // through the badlands, never straight (that is what the target length is
    // measured against).
    const STATIONS: ReadonlyArray<readonly [number, number]> = [
      [0.16, 1.0],
      [0.38, -0.75],
      [0.58, 1.15],
      [0.8, -0.9],
    ];
    const inner: NetPoint[] = STATIONS.map(([t, m]) => ({
      x: sx + dx * t + px * amplitude * m * HighSpeedMaglev.meanderWeight(t),
      y: sy + dy * t + py * amplitude * m * HighSpeedMaglev.meanderWeight(t),
    }));
    const pts: NetPoint[] = [{ x: sx, y: sy }, ...inner, { x: this.endPos.x, y: this.endPos.y }];
    // Mirror phantoms: P₋₁ = 2P₀ − P₁, Pₙ = 2Pₙ₋₁ − Pₙ₋₂.
    const phantomStart: NetPoint = {
      x: 2 * pts[0]!.x - pts[1]!.x,
      y: 2 * pts[0]!.y - pts[1]!.y,
    };
    const n = pts.length;
    const phantomEnd: NetPoint = {
      x: 2 * pts[n - 1]!.x - pts[n - 2]!.x,
      y: 2 * pts[n - 1]!.y - pts[n - 2]!.y,
    };
    return [phantomStart, ...pts, phantomEnd];
  }

  /** Uniform parametric Catmull-Rom (tension ½) at global parameter u. */
  private evalNet(ctrl: NetPoint[], u: number): NetPoint {
    const segs = ctrl.length - 3;
    const seg = clamp(Math.floor(u), 0, segs - 1);
    const t = clamp(u - seg, 0, 1);
    const p0 = ctrl[seg]!;
    const p1 = ctrl[seg + 1]!;
    const p2 = ctrl[seg + 2]!;
    const p3 = ctrl[seg + 3]!;
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x:
        0.5 *
        (2 * p1.x +
          (p2.x - p0.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (3 * p1.x - p0.x - 3 * p2.x + p3.x) * t3),
      y:
        0.5 *
        (2 * p1.y +
          (p2.y - p0.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (3 * p1.y - p0.y - 3 * p2.y + p3.y) * t3),
    };
  }

  /** Polyline arc length of the net sampled at `samplesPerSeg` per segment. */
  private netArcLength(amplitude: number, samplesPerSeg: number): number {
    const ctrl = this.buildControlNet(amplitude);
    const segs = ctrl.length - 3;
    let total = 0;
    let prev = this.evalNet(ctrl, 0);
    for (let s = 1; s <= segs * samplesPerSeg; s++) {
      const p = this.evalNet(ctrl, s / samplesPerSeg);
      total += Math.hypot(p.x - prev.x, p.y - prev.y);
      prev = p;
    }
    return total;
  }

  /** Bisection on the single meander amplitude: netArcLength(A) = target. */
  private amplitudeForLength(target: number): number {
    let lo = 0;
    let hi = 500;
    // Guard against pathological option pairs where even hi does not reach.
    for (let guard = 0; guard < 8 && this.netArcLength(hi, 32) < target; guard++) hi *= 2;
    for (let i = 0; i < 42; i++) {
      const mid = (lo + hi) / 2;
      if (this.netArcLength(mid, 128) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** Fine arc-length LUT over the final control net (256 samples/segment). */
  private buildArcLengthTable(ctrl: NetPoint[]): { s: number[]; t: number[]; total: number } {
    const segs = ctrl.length - 3;
    const per = 256;
    const s: number[] = [0];
    const t: number[] = [0];
    let prev = this.evalNet(ctrl, 0);
    let acc = 0;
    for (let i = 1; i <= segs * per; i++) {
      const u = i / per;
      const p = this.evalNet(ctrl, u);
      acc += Math.hypot(p.x - prev.x, p.y - prev.y);
      s.push(acc);
      t.push(u);
      prev = p;
    }
    return { s, t, total: acc };
  }

  // -- spatial API (world frame, scene-independent) --------------------------------

  /** Total guideway arc length s_max (m) — answers before init/dispose. */
  getTotalSplineLengthM(): number {
    return this.totalSplineLengthM;
  }

  /** Locomotive distance along the spline (m). */
  getHeadDistanceM(): number {
    return this.headS;
  }

  /**
   * Guideway centreline point at arc distance s (world metres, z up — the
   * deck top carries the elevation profile + clearance, see
   * {@link getGuidewayClearanceAtDistance}).
   */
  getPointAtDistance(s: number): { x: number; y: number; z: number } {
    const d = clamp(Number.isFinite(s) ? s : 0, 0, this.totalSplineLengthM);
    const p = this.netAtArc(d);
    return { x: p.x, y: p.y, z: this.elevationAt(d, p) };
  }

  /**
   * Unit forward tangent of the guideway at arc distance s (world frame,
   * includes the grade component z). Central difference on the arc-length
   * parameterization; one-sided at the terminals.
   */
  getForwardAtDistance(s: number): { x: number; y: number; z: number } {
    const total = this.totalSplineLengthM;
    const d = clamp(Number.isFinite(s) ? s : 0, 0, total);
    const delta = 0.5;
    // Clamping the pair to [0, total] already yields a one-sided difference
    // at the terminals.
    const a = this.getPointAtDistance(Math.max(0, d - delta));
    const b = this.getPointAtDistance(Math.min(total, d + delta));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return { x: dx / len, y: dy / len, z: dz / len };
  }

  /** Vertical clearance of the guideway deck above the canyon floor at s (m). */
  getGuidewayClearanceAtDistance(s: number): number {
    const d = Number.isFinite(s) ? clamp(s, 0, this.totalSplineLengthM) : 0;
    return guidewayClearanceAt(d);
  }

  /**
   * Graded maintenance service road centre at arc distance s, offset
   * {@link SERVICE_ROAD_OFFSET_M} to starboard of the guideway heading,
   * crowned +0.15 m over the terrain model. Returns the road tangent too —
   * Phase 3's rover autopilot follows this line.
   */
  getServiceRoadPointAtDistance(s: number): {
    x: number;
    y: number;
    z: number;
    forward: { x: number; y: number; z: number };
  } {
    const track = this.getPointAtDistance(s);
    const f = this.getForwardAtDistance(s);
    // Starboard (right of heading) in the right-handed world frame: r = f × ẑ.
    const rx = f.y;
    const ry = -f.x;
    const rl = Math.hypot(rx, ry);
    const ux = rl > 1e-9 ? rx / rl : 1;
    const uy = rl > 1e-9 ? ry / rl : 0;
    const x = track.x + ux * SERVICE_ROAD_OFFSET_M;
    const y = track.y + uy * SERVICE_ROAD_OFFSET_M;
    return { x, y, z: maglevTerrainElevationAt(x, y) + 0.15, forward: f };
  }

  /** Net point at arc distance via binary search + CR re-evaluation. */
  private netAtArc(d: number): NetPoint {
    const s = this.lutS;
    if (d <= 0) return this.evalNet(this.ctrl, this.lutT[0]!);
    if (d >= this.totalSplineLengthM) return this.evalNet(this.ctrl, this.lutT[s.length - 1]!);
    let lo = 0;
    let hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid]! <= d) lo = mid;
      else hi = mid;
    }
    const span = s[hi]! - s[lo]!;
    const frac = span > 1e-12 ? (d - s[lo]!) / span : 0;
    return this.evalNet(this.ctrl, this.lutT[lo]! + (this.lutT[hi]! - this.lutT[lo]!) * frac);
  }

  /** Elevation (world z) of the guideway deck at arc s over the terrain net. */
  private elevationAt(d: number, net?: NetPoint): number {
    const p = net ?? this.netAtArc(d);
    return maglevTerrainElevationAt(p.x, p.y) + guidewayClearanceAt(d);
  }

  // -- kinematics -------------------------------------------------------------------

  private standbyHeadS(): number {
    return Math.min((MAGLEV_CAR_TYPES.length - 1) * this.carLengthM, this.totalSplineLengthM * 0.5);
  }

  /** Consist length (cars × L_car). */
  getConsistLengthM(): number {
    return MAGLEV_CAR_TYPES.length * this.carLengthM;
  }

  /** Current train state without advancing time (pure query). */
  getTrainState(): MaglevTrainState {
    return this.buildState(this.currentSpeedMps());
  }

  private currentSpeedMps(): number {
    return Math.min(this.cruiseSpeedMps, this.accelerationMps2 * this.runTimeS);
  }

  private buildState(speedMps: number): MaglevTrainState {
    const cars: MaglevCarState[] = MAGLEV_CAR_TYPES.map((type, i) => {
      const sI = this.headS - i * this.carLengthM;
      const evalS = clamp(sI, 0, this.totalSplineLengthM);
      const p = this.getPointAtDistance(evalS);
      const f = this.getForwardAtDistance(evalS);
      return {
        index: i,
        type,
        distanceAlongSplineM: sI,
        worldPosition: p,
        worldForward: f,
        speedMps,
      };
    });
    const distanceToDepotM = Math.max(0, this.totalSplineLengthM - this.headS);
    this.lastState = {
      speedMps,
      totalLengthM: this.getConsistLengthM(),
      cars,
      distanceToDepotM,
      timeToDepotS: distanceToDepotM / Math.max(speedMps, 1.0),
    };
    return this.lastState;
  }

  /**
   * One frame (60 Hz nominal): ramp speed toward cruise, advance the consist
   * along the guideway, drive the stator chevron chevrons and suspension bob,
   * and loop continuously at the depot terminal. Safe before init / after
   * dispose — the kinematics and returned state are scene-independent; only
   * mesh animation is skipped.
   */
  update(dt: number): MaglevTrainState {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    if (step > 0) {
      this.elapsed += step;
      this.runTimeS += step;
      const v = this.currentSpeedMps();
      this.headS += v * step;
      // Continuous transit: continuous loop back to the outpost dock.
      const standby = this.standbyHeadS();
      const span = this.totalSplineLengthM - standby;
      if (span > 1e-9 && this.headS >= this.totalSplineLengthM) {
        this.headS = standby + ((this.headS - standby) % span);
      }
    }
    const state = this.buildState(this.currentSpeedMps());
    if (!this.disposed && this.built) {
      this.drawCars(state);
      this.drawRailChevrons();
    }
    return state;
  }

  // -- heist tracking helpers (Spec 26 §3.3 / blueprint §2.2) ----------------------

  /** Vault car kinematics (index 1) — null only for degenerate consists. */
  getVaultCarState(): MaglevCarState | null {
    const state = this.getTrainState();
    return state.cars.find((c) => c.type === 'vault') ?? null;
  }

  /**
   * Vault car world transform (Babylon frame): position on the guideway +
   * float + bob, quaternion aligning model +z with the local tangent. Answers
   * before init from pure math (no bob — no clock-owning mesh exists yet).
   */
  getVaultCarTransform(): { position: Vector3; rotationQuaternion: Quaternion } {
    const vault = this.getVaultCarState();
    const sEval = vault !== null ? clamp(vault.distanceAlongSplineM, 0, this.totalSplineLengthM) : 0;
    const p = this.getPointAtDistance(sEval);
    const f = this.getForwardAtDistance(sEval);
    const bob = this.built ? SUSPENSION_BOB_M * Math.sin(this.elapsed * 3.1) : 0;
    const pos = worldToBabylon({ x: p.x, y: p.y, z: p.z + CARRIAGE_FLOAT_M + bob });
    const quat = new Quaternion();
    orientToTangent(quat, new Vector3(f.x, f.z, -f.y));
    return { position: pos, rotationQuaternion: quat };
  }

  /** Live vault car root node (null before init / after dispose). */
  getVaultCarNode(): TransformNode | null {
    return this.carRoots[1] ?? null;
  }

  private bobAt(i: number): number {
    return SUSPENSION_BOB_M * Math.sin(this.elapsed * 3.1 + i * 1.7);
  }

  /** Mirror car states onto their Babylon roots (world-absolute placement). */
  private drawCars(state: MaglevTrainState): void {
    for (let i = 0; i < this.carRoots.length; i++) {
      const car = state.cars[i];
      const node = this.carRoots[i];
      if (car === undefined || node === undefined) continue;
      const b = worldToBabylon({
        x: car.worldPosition.x,
        y: car.worldPosition.y,
        z: car.worldPosition.z + CARRIAGE_FLOAT_M + this.bobAt(i),
      });
      node.position.set(b.x, b.y, b.z);
      const f = car.worldForward;
      const len = Math.hypot(f.x, f.z, -f.y);
      if (len > 1e-9 && node.rotationQuaternion !== null) {
        orientToTangent(node.rotationQuaternion, new Vector3(f.x / len, f.z / len, -f.y / len));
      }
      node.computeWorldMatrix(true);
    }
  }

  /** Traveling forward-chevron light pulse on the twin stator rails. */
  private drawRailChevrons(): void {
    const m = this.materials;
    if (m === null) return;
    // Whole-line induction pulse (inducted hum band, Spec 26 §3.5.2 sibling).
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 4.2);
    m.coil.emissiveColor.set(0.1 + 0.08 * pulse, 0.4 + 0.15 * pulse, 0.85 + 0.1 * pulse);
    for (const wave of this.railWaves) {
      const colors = wave.colors;
      for (let i = 0; i < wave.stationS.length; i++) {
        const u = (1 - ((((wave.stationS[i]! - this.elapsed * CHEVRON_WAVE_MPS) % CHEVRON_PERIOD_M) + CHEVRON_PERIOD_M) % CHEVRON_PERIOD_M) / CHEVRON_PERIOD_M);
        // Sharpen into a chevron crest (front-lit leading edge).
        const crest = Math.pow(Math.sin(Math.PI * u), 6);
        const r = 0.05 + 0.9 * crest * 0.4;
        const g = 0.25 + 0.75 * crest;
        const b = 0.55 + 0.45 * crest;
        colors[i * 2] = r;
        colors[i * 2 + 1] = g;
        colors[i * 2 + 2] = b;
        colors[i * 2 + 3] = 1;
        colors[i * 2 + 4] = r;
        colors[i * 2 + 5] = g;
        colors[i * 2 + 6] = b;
        colors[i * 2 + 7] = 1;
      }
      wave.mesh.setVerticesData(VertexBuffer.ColorKind, colors, false);
    }
  }

  // -- lifecycle ----------------------------------------------------------------------

  /**
   * Build guideway + consist. Accepts an existing `Scene`, a raw engine (a
   * scene is created around it), or nothing — falling back to a self-owned
   * `NullEngine`. Idempotent; refuses after `dispose()`.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('HighSpeedMaglev: init() after dispose()');
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
      throw new Error('HighSpeedMaglev.init: browser needs a Scene or Engine');
    }

    const scene = this.scene;
    this.root = new TransformNode(`${MAGLEV_NAME_PREFIX}-system`, scene);
    // Spline points are absolute world→Babylon coordinates: the system root
    // stays at the origin and never transforms its children.
    this.materials = this.buildMaterials(scene);
    this.buildGuideway(scene);
    this.buildConsist(scene);
    this.built = true;
    this.drawCars(this.getTrainState());
    this.drawRailChevrons();
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /** Tear down every mesh, material, root and any self-owned engine. Never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;

    for (const mesh of this.meshList) disposeQuietly(mesh);
    this.meshList = [];
    for (const material of this.materialList) disposeQuietly(material);
    this.materialList = [];
    this.materials = null;
    for (const node of this.carRoots) disposeQuietly(node);
    this.carRoots = [];
    this.railWaves = [];
    disposeQuietly(this.root);
    this.root = null;

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- accessors ------------------------------------------------------------------------

  /** System root transform (null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every guideway + consist mesh (shadow/picking registration). */
  getMeshes(): Mesh[] {
    return [...this.meshList];
  }

  /**
   * Shadow-casting subset of `getMeshes()`: the long ribbon ribbons (deck
   * skin, stator fins, service road) are paper-thin light-catchers that would
   * smear the shadow map — pylons and the consist are the matter.
   */
  getShadowCasterMeshes(): AbstractMesh[] {
    return this.meshList.filter((m) => {
      const part = m.metadata?.part as string | undefined;
      return part !== 'deck' && part !== 'stator_rail' && part !== 'road';
    });
  }

  /**
   * Meshes tagged with a part id — 'pylon' | 'deck' | 'stator_rail' | 'road' |
   * 'terminal_pad' | 'locomotive' | 'vault' | 'executive' | 'escort' |
   * 'coupler' | 'catwalk' | 'vault_container' | 'vault_lock' | 'glass' |
   * 'interior' | 'searchlight' | 'drone' | 'dish' | 'trim' | 'barcode' — the
   * smoke suite's structural assertion handle.
   */
  getPartMeshes(part: string): Mesh[] {
    return this.meshList.filter((m) => (m.metadata?.part as string | undefined) === part);
  }

  /** Last emitted train state (readback without re-evaluation). */
  getLastState(): MaglevTrainState {
    return this.lastState;
  }

  // -- materials --------------------------------------------------------------------------

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

  private buildMaterials(scene: Scene): MaglevMaterials {
    const materials: MaglevMaterials = {
      concrete: HighSpeedMaglev.mk(`${MAGLEV_NAME_PREFIX}-concrete`, scene, [0.16, 0.16, 0.17], 0.1, 0.85, undefined, 0.1),
      steel: HighSpeedMaglev.mk(`${MAGLEV_NAME_PREFIX}-steel`, scene, [0.12, 0.14, 0.18], 0.85, 0.3, undefined, 0.2),
      titanium: HighSpeedMaglev.mk(`${MAGLEV_NAME_PREFIX}-titanium`, scene, [0.55, 0.57, 0.6], 0.9, 0.32, undefined, 0.25),
      // Spec 26 §3.2.2: hazard yellow trim, faintly emissive.
      hazard: HighSpeedMaglev.mk(`${MAGLEV_NAME_PREFIX}-hazard`, scene, [0.75, 0.58, 0.06], 0.3, 0.5, [0.35, 0.26, 0.02], 0.1),
      // Spec 26 §3.2.1: linear induction coils — forward blue chevron pulses.
      coil: HighSpeedMaglev.mk(`${MAGLEV_NAME_PREFIX}-coil`, scene, [0.1, 0.3, 0.4], 0.3, 0.4, [0.15, 0.5, 1.0], 0),
      // Spec 26 §3.2.2: translucent carbon-glass executive roof.
      glass: HighSpeedMaglev.mk(`${MAGLEV_NAME_PREFIX}-glass`, scene, [0.08, 0.14, 0.2], 0.6, 0.05, undefined, 0.5),
      interior: HighSpeedMaglev.mk(`${MAGLEV_NAME_PREFIX}-interior`, scene, [0.1, 0.08, 0.04], 0.2, 0.6, [0.95, 0.66, 0.28], 0.1),
      searchlight: HighSpeedMaglev.mk(`${MAGLEV_NAME_PREFIX}-searchlight`, scene, [0.9, 0.88, 0.75], 0.2, 0.3, [1.0, 0.97, 0.85], 0),
      road: HighSpeedMaglev.mk(`${MAGLEV_NAME_PREFIX}-road`, scene, [0.09, 0.085, 0.08], 0.05, 0.95, undefined, 0.08),
      barcode: HighSpeedMaglev.mk(`${MAGLEV_NAME_PREFIX}-barcode`, scene, [0.85, 0.85, 0.9], 0.4, 0.3, [0.6, 0.6, 0.7], 0),
    };
    materials.glass.alpha = 0.45;
    for (const material of Object.values(materials)) this.materialList.push(material);
    return materials;
  }

  // -- mesh construction --------------------------------------------------------------

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
    mesh.metadata = { part: partId, system: MAGLEV_NAME_PREFIX };
    this.meshList.push(mesh);
    return mesh;
  }

  /**
   * Ribbon cross-section helper: world-frame points per station → a swept
   * MeshBuilder ribbon in the absolute system-root frame.
   */
  private ribbon(name: string, partId: string, crosses: Array<{ x: number; y: number; z: number }[]>, mat: PBRMaterial): Mesh {
    const pathArray = crosses.map((cross) => cross.map((p) => worldToBabylon(p)));
    const mesh = MeshBuilder.CreateRibbon(name, { pathArray }, this.scene as Scene);
    return this.part(partId, partId, mesh, mat, 0, 0, 0);
  }

  private buildGuideway(scene: Scene): void {
    void scene; // scene captured on this.scene by init(); ribbon helper uses it
    const m = this.materials as MaglevMaterials;
    const total = this.totalSplineLengthM;

    // -- deck skin ribbon (top surface of the elevated guideway) ----------------
    const deckCrosses: Array<Array<{ x: number; y: number; z: number }>> = [];
    const railCrossesL: Array<Array<{ x: number; y: number; z: number }>> = [];
    const railCrossesR: Array<Array<{ x: number; y: number; z: number }>> = [];
    const roadCrosses: Array<Array<{ x: number; y: number; z: number }>> = [];
    const railStations: number[] = [];
    const RIB_STEP = 10;
    for (let s = 0; s <= total; s += RIB_STEP) {
      const p = this.getPointAtDistance(s);
      const f = this.getForwardAtDistance(s);
      const h = Math.hypot(f.x, f.y) || 1;
      // Port (+) / starboard (−) horizontal unit along the guideway.
      const px = (-f.y / h);
      const py = (f.x / h);
      const deckZ = p.z + 0.1;
      deckCrosses.push([
        { x: p.x - px * 4.25, y: p.y - py * 4.25, z: deckZ },
        { x: p.x + px * 4.25, y: p.y + py * 4.25, z: deckZ },
      ]);
      // Twin stator guide rails: vertical fins flanking the car skirt.
      const finBase = p.z + 0.05;
      const finTop = p.z + 0.95;
      railCrossesL.push([
        { x: p.x + px * 1.75, y: p.y + py * 1.75, z: finBase },
        { x: p.x + px * 1.75, y: p.y + py * 1.75, z: finTop },
      ]);
      railCrossesR.push([
        { x: p.x - px * 1.75, y: p.y - py * 1.75, z: finBase },
        { x: p.x - px * 1.75, y: p.y - py * 1.75, z: finTop },
      ]);
      railStations.push(s);
      // Graded maintenance service road, 4.0 m starboard (r = f × ẑ).
      const road = this.getServiceRoadPointAtDistance(s);
      roadCrosses.push([
        { x: road.x - px * 3, y: road.y - py * 3, z: maglevTerrainElevationAt(road.x - px * 3, road.y - py * 3) + 0.12 },
        { x: road.x + px * 3, y: road.y + py * 3, z: maglevTerrainElevationAt(road.x + px * 3, road.y + py * 3) + 0.12 },
      ]);
    }
    this.ribbon(`${MAGLEV_NAME_PREFIX}-deck`, 'deck', deckCrosses, m.concrete);
    const railL = this.ribbon(`${MAGLEV_NAME_PREFIX}-stator-l`, 'stator_rail', railCrossesL, m.coil);
    const railR = this.ribbon(`${MAGLEV_NAME_PREFIX}-stator-r`, 'stator_rail', railCrossesR, m.coil);
    this.ribbon(`${MAGLEV_NAME_PREFIX}-road`, 'road', roadCrosses, m.road);
    // Chevron vertex colours: 2 verts per station, RGBA.
    const colorsL = new Float32Array(railStations.length * 2 * 4).fill(1);
    const colorsR = new Float32Array(railStations.length * 2 * 4).fill(1);
    railL.setVerticesData(VertexBuffer.ColorKind, colorsL, false);
    railR.setVerticesData(VertexBuffer.ColorKind, colorsR, false);
    this.railWaves.push({ mesh: railL, stationS: railStations, colors: colorsL });
    this.railWaves.push({ mesh: railR, stationS: railStations, colors: colorsR });

    // -- concrete-composite pylons every ~24 m (Spec 26 §3.2.1) -------------------
    for (let s = 12; s <= total - 12; s += PYLON_SPACING_M) {
      const p = this.getPointAtDistance(s);
      const terrain = maglevTerrainElevationAt(p.x, p.y);
      const height = p.z - terrain + 0.45; // pierces deck, embeds 0.3 in regolith
      const pylon = this.part(`${MAGLEV_NAME_PREFIX}-pylon-${Math.round(s)}`, 'pylon',
        MeshBuilder.CreateBox(`${MAGLEV_NAME_PREFIX}-pylon-${Math.round(s)}`, { width: 1, height: 1, depth: 1 }, scene),
        m.concrete, 0, 0, 0);
      pylon.scaling.set(2.4, height, 3.4);
      const b = worldToBabylon({ x: p.x, y: p.y, z: terrain - 0.3 + height / 2 });
      pylon.position.copyFrom(b);
      // Tapered capital bracket under the deck.
      const capital = this.part(`${MAGLEV_NAME_PREFIX}-pylon-cap-${Math.round(s)}`, 'pylon',
        MeshBuilder.CreateCylinder(`${MAGLEV_NAME_PREFIX}-pylon-cap-${Math.round(s)}`,
          { diameterTop: 4.6, diameterBottom: 2.6, height: 1.1, tessellation: 8 }, scene),
        m.steel, 0, 0, 0);
      capital.position.copyFrom(worldToBabylon({ x: p.x, y: p.y, z: p.z - 0.55 }));
    }

    // -- terminal pads: outpost dock + citadel depot mouth ------------------------
    for (const [s, tag] of [[0, 'dock'], [total, 'depot']] as const) {
      const p = this.getPointAtDistance(s);
      const terrain = maglevTerrainElevationAt(p.x, p.y);
      this.part(`${MAGLEV_NAME_PREFIX}-pad-${tag}`, 'terminal_pad',
        MeshBuilder.CreateBox(`${MAGLEV_NAME_PREFIX}-pad-${tag}`, { width: 12, height: 0.6, depth: 16 }, scene),
        m.concrete, 0, 0, 0)
        .position.copyFrom(worldToBabylon({ x: p.x, y: p.y, z: terrain + 0.3 }));
    }
  }

  // -- the Apex Express consist (Spec 26 §3.2.2) -------------------------------------

  private buildConsist(scene: Scene): void {
    const m = this.materials as MaglevMaterials;
    for (let i = 0; i < MAGLEV_CAR_TYPES.length; i++) {
      const type = MAGLEV_CAR_TYPES[i] as MaglevCarType;
      const carRoot = new TransformNode(`${MAGLEV_NAME_PREFIX}-${type}`, scene);
      carRoot.parent = this.root;
      carRoot.rotationQuaternion = new Quaternion();
      this.carRoots.push(carRoot);
      const tag = (part: string) => `${MAGLEV_NAME_PREFIX}-${type}-${part}`;
      const body = (partId: string, mesh: Mesh, mat: PBRMaterial, x: number, y: number, z: number): Mesh => {
        mesh.material = mat;
        mesh.position.set(x, y, z);
        mesh.parent = carRoot;
        mesh.metadata = { part: partId, system: MAGLEV_NAME_PREFIX, car: i, carType: type };
        this.meshList.push(mesh);
        return mesh;
      };

      if (type === 'locomotive') {
        // Streamlined wedge prow + maglev skirts + twin searchlights.
        body('locomotive', MeshBuilder.CreateBox(tag('body'), { width: 3.4, height: 2.6, depth: 12.4 }, scene), m.steel, 0, 1.65, 0);
        body('locomotive', MeshBuilder.CreateCylinder(tag('prow'), { diameterTop: 0.5, diameterBottom: 3.0, height: 1.8, tessellation: 8 }, scene), m.steel, 0, 1.65, 6.95)
          .rotation.x = Math.PI / 2;
        body('locomotive', MeshBuilder.CreateBox(tag('fin'), { width: 0.3, height: 0.7, depth: 9 }, scene), m.steel, 0, 3.3, -1);
        body('locomotive', MeshBuilder.CreateBox(tag('skirt-l'), { width: 0.5, height: 0.62, depth: 12.2 }, scene), m.coil, 1.55, 0.05, 0);
        body('locomotive', MeshBuilder.CreateBox(tag('skirt-r'), { width: 0.5, height: 0.62, depth: 12.2 }, scene), m.coil, -1.55, 0.05, 0);
        body('searchlight', MeshBuilder.CreateSphere(tag('light-l'), { diameter: 0.34, segments: 8 }, scene), m.searchlight, 1.05, 1.15, 7.6);
        body('searchlight', MeshBuilder.CreateSphere(tag('light-r'), { diameter: 0.34, segments: 8 }, scene), m.searchlight, -1.05, 1.15, 7.6);
      } else if (type === 'vault') {
        // Armored titanium plates, hazard trim, flank catwalks, Cyber-Lock roof.
        body('vault', MeshBuilder.CreateBox(tag('body'), { width: 3.4, height: 2.9, depth: 13.6 }, scene), m.titanium, 0, 1.45, 0);
        body('trim', MeshBuilder.CreateBox(tag('trim-l'), { width: 0.06, height: 0.45, depth: 13.0 }, scene), m.hazard, 1.73, 1.45, 0);
        body('trim', MeshBuilder.CreateBox(tag('trim-r'), { width: 0.06, height: 0.45, depth: 13.0 }, scene), m.hazard, -1.73, 1.45, 0);
        body('barcode', MeshBuilder.CreateBox(tag('barcode'), { width: 0.05, height: 0.8, depth: 1.6 }, scene), m.barcode, 1.76, 1.9, -4.2);
        // External maintenance catwalk with yellow safety grab rails, both flanks.
        for (const sgn of [-1, 1]) {
          body('catwalk', MeshBuilder.CreateBox(tag(`walk-${sgn}`), { width: 0.95, height: 0.1, depth: 12.6 }, scene), m.steel, sgn * 2.2, 1.0, 0);
          body('catwalk', MeshBuilder.CreateCylinder(tag(`rail-${sgn}`), { diameter: 0.08, height: 12.6, tessellation: 6 }, scene), m.hazard, sgn * 2.6, 1.95, 0)
            .rotation.x = Math.PI / 2;
          for (const z of [-5, 0, 5]) {
            body('catwalk', MeshBuilder.CreateCylinder(tag(`post-${sgn}-${z}`), { diameter: 0.07, height: 1.0, tessellation: 6 }, scene), m.hazard, sgn * 2.6, 1.45, z);
          }
        }
        // Roof-mounted X-Corp Cyber-Lock vault container (the heist target).
        body('vault_container', MeshBuilder.CreateBox(tag('vault-box'), { width: 2.3, height: 1.5, depth: 3.4 }, scene), m.hazard, 0, 3.65, 0);
        body('vault_lock', MeshBuilder.CreateBox(tag('vault-lock'), { width: 0.5, height: 0.5, depth: 0.12 }, scene), m.coil, 0, 3.65, 1.76);
      } else if (type === 'executive') {
        // Translucent carbon-glass roof over a warm luxury cabin.
        body('executive', MeshBuilder.CreateBox(tag('body'), { width: 3.4, height: 2.9, depth: 13.6 }, scene), m.steel, 0, 1.45, 0);
        body('glass', MeshBuilder.CreateBox(tag('roof'), { width: 2.9, height: 0.14, depth: 9.5 }, scene), m.glass, 0, 2.97, 0);
        body('interior', MeshBuilder.CreateBox(tag('cabin'), { width: 2.7, height: 0.6, depth: 9.1 }, scene), m.interior, 0, 2.55, 0);
        body('glass', MeshBuilder.CreateBox(tag('win-l'), { width: 0.05, height: 1.3, depth: 11.8 }, scene), m.glass, 1.72, 1.75, 0);
        body('glass', MeshBuilder.CreateBox(tag('win-r'), { width: 0.05, height: 1.3, depth: 11.8 }, scene), m.glass, -1.72, 1.75, 0);
      } else {
        // Automated drone escort flatbed + comms uplink dish.
        body('escort', MeshBuilder.CreateBox(tag('flatbed'), { width: 3.4, height: 0.4, depth: 13.6 }, scene), m.steel, 0, 0.2, 0);
        body('escort', MeshBuilder.CreateBox(tag('headboard'), { width: 3.4, height: 1.0, depth: 0.35 }, scene), m.hazard, 0, 0.9, 6.3);
        for (const sgn of [-1, 1]) {
          body('drone', MeshBuilder.CreateSphere(tag(`drone-${sgn}`), { diameter: 0.7, segments: 8 }, scene), m.titanium, sgn * 0.85, 0.75, 2.2);
          body('drone', MeshBuilder.CreateCylinder(tag(`rotor-${sgn}`), { diameter: 1.5, height: 0.05, tessellation: 12 }, scene), m.steel, sgn * 0.85, 1.18, 2.2);
        }
        body('dish', MeshBuilder.CreateCylinder(tag('mast'), { diameter: 0.18, height: 1.6, tessellation: 8 }, scene), m.steel, 0, 1.2, -3.5);
        body('dish', MeshBuilder.CreateCylinder(tag('reflector'), { diameterTop: 2.4, diameterBottom: 0.3, height: 1.0, tessellation: 16 }, scene), m.titanium, 0, 2.3, -3.5);
      }

      // Magnetic coupler to the preceding car (articulation link).
      if (i > 0) {
        body('coupler', MeshBuilder.CreateCylinder(tag('coupler'), { diameter: 0.35, height: 0.7, tessellation: 8 }, scene), m.steel, 0, 0.5, -6.95)
          .rotation.x = Math.PI / 2;
      }
    }
  }
}

// -- clearance law ---------------------------------------------------------------

/**
 * Guideway deck clearance above the canyon floor at arc distance s (m):
 * a gentle graded swell that stays inside the spec's 2.5–6.0 m band by
 * construction (mid 4.25 ± 1.75).
 */
function guidewayClearanceAt(d: number): number {
  return 4.25 + 1.75 * Math.sin(0.0016 * d + 0.85);
}
