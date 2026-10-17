/**
 * Lunar Frontier — Orbital Transport Traffic & Passing Windows (Spec 27 §3.2).
 *
 * High overhead in compressed Low Lunar Orbit, cis-lunar freight traffic
 * sweeps past the Gauss Needle on deterministic transit arcs:
 *   • Bulk Ore Tug *CisLunar Horizon* — 1,500 m @ 150 m/s, 35 m catch radius,
 *     Δv ≤ 25 m/s, pays 2.5× base depot for raw minerals (legal).
 *   • Syndicate Runner *The Obsidian Slip* — 1,800 m @ 210 m/s, 22 m radius,
 *     Δv ≤ 18 m/s, pays 4.0× black market for laundered contraband (hot).
 *   • USP Patrol Cutter *USP Vigilance* — 1,200 m @ 180 m/s, 0 m envelope
 *     (hostile: scans, never catches), 0.0× payout.
 *
 * Transit schedule (Spec 27 §3.2.1): a scheduled transit occurs every
 * 90–120 s, alternating east-to-west and south-to-north chords across the
 * celestial vault, with an active firing window of 20–35 s while the ship
 * holds line-of-sight elevation ≥ 20° above the fire-control datum (the
 * canonical Mass Accelerator seat unless the constructor says otherwise).
 *
 * Window geometry is EXACT, not approximated: each pass is a straight-line
 * constant-altitude chord at impact parameter p from the datum, and p is
 * chosen per transit as
 *     p = √( (H·cot 20°)² − (w·v/2)² )
 * for the scheduled window length w ∈ [20, 35] s. Elevation ≥ 20° then holds
 * for exactly |t − t_close| ≤ w/2 (horizontal range ≤ H·cot 20° by
 * construction), so the reported `inFiringWindow` flag and the physical LOS
 * law can never drift apart.
 *
 * Determinism: transit intervals, window jitter and lateral offset signs all
 * come from a seeded mulberry32 stream consumed strictly in transit order,
 * so two systems built with the same seed — even stepped with different dt
 * sequences — open identical windows at identical times.
 *
 * Capture (Spec 27 §3.2.3): catchable vessels project a truncated electromagnetic
 * tractor cone extending 80 m behind the cargo bay, mouth radius R_catch
 * (apex radius FRUSTUM_BAY_RADIUS_M at the bay ring). `checkCapture()`
 * captures when the canister sits inside that frustum — or inside the
 * 1.5 × R_catch magnetic assist sphere around the bay ring — with relative
 * speed ≤ maxCatchRelSpeedMps. The USP cutter has a 0 m envelope and can
 * never capture.
 *
 * Pure kinematic contract (Phase 3/4/5 dependency): `update()`,
 * `getActiveTarget()`, `checkCapture()`, `getSchedule()` and every constant
 * answer before `init()`, after `dispose()`, and with no scene at all — the
 * BallisticTrajectoryEngine and ExportMinigameDirector never race the mesh
 * build. `init()` accepts a Scene, a raw engine (a scene is created around
 * it), or nothing (self-owned NullEngine fallback, CI default). `dispose()`
 * is idempotent and never throws; after it the mesh accessors return empty.
 *
 * Frame convention (shared with `CameraRig` / `WorldScene` / `MassAccelerator`):
 * world metres (x, y lateral, z↑) map to Babylon (x, z↑, −y) via
 * `worldToBabylon`; vessel nose (local +z) is yawed with
 * rotation.y = atan2(dirX, −dirY), the exact left-handed image of the world
 * velocity direction.
 *
 * Usage:
 *   const ot = new OrbitalTransportSystem({ seed: 'cis-lunar-transit-2431' }).init(scene);
 *   const states = ot.update(dt);            // every frame
 *   const target = ot.getActiveTarget();     // HUD lead reticle feed
 *   const hit = ot.checkCapture(pos, vel);   // in-flight canister resolution
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
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
export const ORBITAL_TRANSPORT_NAME_PREFIX = 'orbital-transport';

/**
 * Default fire-control datum (world metres, z↑): the canonical Mass
 * Accelerator caldera seat (Spec 27 §3.1.1) — the transit chords and the
 * ≥ 20° elevation law are evaluated from this point unless the constructor
 * overrides `observer`.
 */
export const ORBITAL_OBSERVER_DEFAULT: Readonly<{ x: number; y: number; z: number }> = {
  x: -320,
  y: -1450,
  z: 0,
};

/** Spec 27 §3.2.1: minimum scheduled transit interval (s). */
export const TRANSIT_INTERVAL_MIN_S = 90;
/** Spec 27 §3.2.1: maximum scheduled transit interval (s). */
export const TRANSIT_INTERVAL_MAX_S = 120;
/** Spec 27 §3.2.1: minimum active firing window (s). */
export const TRANSIT_WINDOW_MIN_S = 20;
/** Spec 27 §3.2.1: maximum active firing window (s). */
export const TRANSIT_WINDOW_MAX_S = 35;
/** Spec 27 §3.2.1: line-of-sight elevation gate for a firing window (deg). */
export const LOS_ELEVATION_MIN_DEG = 20;
/** First transit's closest-approach time on the system clock (s). */
export const FIRST_TRANSIT_CLOSEST_APPROACH_S = 35;
/** Vessel is scene-visible this far before the window opens / after it closes (s). */
export const APPROACH_VISIBILITY_S = 15;
/** Spec 27 §3.2.3: tractor funnel length behind the cargo bay (m). */
export const CAPTURE_FUNNEL_LENGTH_M = 80;
/** Tractor funnel apex (bay ring) radius — the frustum's narrow end (m). */
export const FRUSTUM_BAY_RADIUS_M = 2;
/** Spec 27 §3.2.3: magnetic assist radius factor around the bay ring (×R_catch). */
export const MAGNETIC_ASSIST_FACTOR = 1.5;

/** cot(20°) — horizontal-range / altitude ratio at the LOS elevation gate. */
const COT_LOS = 1 / Math.tan(LOS_ELEVATION_MIN_DEG * (Math.PI / 180));

/** Spec 27 §3.2.2: the three operational classes. */
export type TransportClass = 'BULK_FREIGHTER' | 'SYNDICATE_RUNNER' | 'USP_PATROL';

/** Spec 27 §4: serialized per-transport state snapshot. */
export interface OrbitalTransportState {
  id: string;
  name: string;
  transportClass: TransportClass;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  speedMps: number;
  altitudeM: number;
  catchRadiusM: number;
  maxCatchRelSpeedMps: number;
  payoutMultiplier: number;
  inFiringWindow: boolean;
  timeRemainingInWindowS: number;
}

/** Static archetype definition for one vessel (Spec 27 §3.2.2 table row). */
export interface VesselBlueprint {
  readonly id: string;
  readonly name: string;
  readonly transportClass: TransportClass;
  /** Constant chord altitude above the datum datum (m) — Spec §3.2.2. */
  readonly altitudeM: number;
  /** Constant transit speed (m/s) — Spec §3.2.2. */
  readonly speedMps: number;
  /** Capture cone mouth radius R_catch (m); 0 for hostiles. */
  readonly catchRadiusM: number;
  /** Max acceptable relative Δv at catch (m/s); 0 for hostiles. */
  readonly maxCatchRelSpeedMps: number;
  /** Export payout multiplier (0 for hostiles). */
  readonly payoutMultiplier: number;
  /** Scheduled window centre (s), jittered into [20, 35] per transit. */
  readonly windowBaseS: number;
  /** Per-transit window jitter amplitude (s). */
  readonly windowJitterS: number;
}

/** Spec 27 §3.2.2: the three canonical vessels, in deterministic rotation. */
export const TRANSPORT_VESSELS: readonly [VesselBlueprint, VesselBlueprint, VesselBlueprint] = [
  {
    id: 'orbital-cislunar-horizon',
    name: 'CisLunar Horizon',
    transportClass: 'BULK_FREIGHTER',
    altitudeM: 1500,
    speedMps: 150,
    catchRadiusM: 35,
    maxCatchRelSpeedMps: 25,
    payoutMultiplier: 2.5,
    windowBaseS: 30,
    windowJitterS: 3,
  },
  {
    id: 'orbital-obsidian-slip',
    name: 'The Obsidian Slip',
    transportClass: 'SYNDICATE_RUNNER',
    altitudeM: 1800,
    speedMps: 210,
    catchRadiusM: 22,
    maxCatchRelSpeedMps: 18,
    payoutMultiplier: 4.0,
    windowBaseS: 24,
    windowJitterS: 2.5,
  },
  {
    id: 'orbital-usp-vigilance',
    name: 'USP Vigilance',
    transportClass: 'USP_PATROL',
    altitudeM: 1200,
    speedMps: 180,
    catchRadiusM: 0,
    maxCatchRelSpeedMps: 0,
    payoutMultiplier: 0.0,
    windowBaseS: 27,
    windowJitterS: 3,
  },
];

/** One planned transit (memoized schedule entry; deterministic). */
interface TransitPlan {
  readonly index: number;
  readonly blueprint: VesselBlueprint;
  /** Unit chord direction in the world horizontal plane (x, y). */
  readonly dirX: number;
  readonly dirY: number;
  /** Closest-approach ground point (world x, y; z = blueprint altitude). */
  readonly closestX: number;
  readonly closestY: number;
  /** Clock time of closest approach (s). */
  readonly tCloseS: number;
  /** Scheduled window length (s) ∈ [20, 35]. */
  readonly windowS: number;
  /** Interval from this transit's close-approach to the next one's (s). */
  readonly intervalToNextS: number;
}

/** Currently scene-resident transit. */
interface ActiveTransit {
  readonly plan: TransitPlan;
  openS: number;
  closeS: number;
}

/** Radar-radar schedule row for the HUD sky-track widget (Phase 5). */
export interface TransitScheduleEntry {
  readonly id: string;
  readonly name: string;
  readonly transportClass: TransportClass;
  /** Seconds until the window opens (0 while currently inside it). */
  readonly opensInS: number;
  /** Scheduled window length (s). */
  readonly windowS: number;
  readonly inFiringWindow: boolean;
}

// -- helpers ------------------------------------------------------------------

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** FNV-1a 32-bit string hash (deterministic seed derivation). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic [0, 1) stream from a uint32 seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distance from point p to the segment [a, a + unit·segLen] (unit is unit). */
function distPointToAxisSegment(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  ux: number, uy: number, uz: number,
  segLen: number,
): number {
  const rx = px - ax;
  const ry = py - ay;
  const rz = pz - az;
  const along = clamp(rx * ux + ry * uy + rz * uz, 0, segLen);
  const dx = rx - ux * along;
  const dy = ry - uy * along;
  const dz = rz - uz * along;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ================================================================================

export class OrbitalTransportSystem {
  // -- fire-control datum (world frame, scene-independent) ------------------------
  private readonly observer: { x: number; y: number; z: number };
  private readonly rand: () => number;

  // -- schedule (deterministic, memoized in transit order) -------------------------
  private readonly plans: TransitPlan[] = [];
  private readonly actives: ActiveTransit[] = [];
  private clockS = 0;

  // -- scene graph -------------------------------------------------------------------
  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;

  private root: TransformNode | null = null;
  /** Per-vessel root node + its meshes + its capture-cone material. */
  private vesselRoots: TransformNode[] = [];
  private coneMaterials: (PBRMaterial | null)[] = [];
  private beaconMaterials: [PBRMaterial, PBRMaterial] | null = null;
  private engineGlowMaterial: PBRMaterial | null = null;
  /** Shared cyan emissive for tractor emitter / bay rings (built once). */
  private tractorStaticMaterial: PBRMaterial | null = null;
  private meshList: Mesh[] = [];
  private materialList: PBRMaterial[] = [];

  private built = false;
  private disposed = false;

  constructor(options: { seed?: string; observer?: { x: number; y: number; z?: number } } = {}) {
    const d = ORBITAL_OBSERVER_DEFAULT;
    const o = options.observer;
    this.observer = {
      x: finiteOr(o?.x, d.x),
      y: finiteOr(o?.y, d.y),
      z: finiteOr(o?.z, d.z),
    };
    const seed = typeof options.seed === 'string' && options.seed.length > 0
      ? fnv1a(`orbital-transit:${options.seed}`)
      : fnv1a('orbital-transit:cis-lunar-transit-2431');
    this.rand = mulberry32(seed);
  }

  // -- lifecycle ---------------------------------------------------------------------

  /**
   * Build the three procedural vessels. Accepts an existing `Scene`, a raw
   * engine (a scene is created around it), or nothing — falling back to a
   * self-owned `NullEngine`, exactly what CI wants. Idempotent; refuses
   * after `dispose()`. The transit schedule and capture kinematics answer
   * with or without this call.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('OrbitalTransportSystem: init() after dispose()');
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
      throw new Error('OrbitalTransportSystem.init: browser needs a Scene or Engine');
    }

    const scene = this.scene;
    this.root = new TransformNode(`${ORBITAL_TRANSPORT_NAME_PREFIX}-system`, scene);
    for (let i = 0; i < TRANSPORT_VESSELS.length; i++) {
      this.buildVessel(scene, TRANSPORT_VESSELS[i], i);
    }
    this.built = true;
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /**
   * Tear down every mesh, material, node and any self-owned engine. Never
   * throws; after this call the pure kinematics still advance and every
   * query still answers, and the mesh accessors return empty.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;

    for (const mesh of this.meshList) OrbitalTransportSystem.disposeQuietly(mesh);
    this.meshList = [];
    for (const material of this.materialList) OrbitalTransportSystem.disposeQuietly(material);
    this.materialList = [];
    for (const node of this.vesselRoots) OrbitalTransportSystem.disposeQuietly(node);
    this.vesselRoots = [];
    this.coneMaterials = [];
    this.beaconMaterials = null;
    this.engineGlowMaterial = null;
    this.tractorStaticMaterial = null;
    OrbitalTransportSystem.disposeQuietly(this.root);
    this.root = null;

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) OrbitalTransportSystem.disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- per-frame -----------------------------------------------------------------------

  /**
   * Advance the transit clock by `dt` seconds and answer the state of every
   * scene-resident transport (usually 0 or 1 — the schedule never overlaps
   * actives). Spawns/hides vessels at the approach/departure edges and
   * modulates the capture-cone shimmer, engine glow and USP beacons.
   * Safe before init / after dispose (pure schedule still advances; no mesh
   * animation). dt is not clamped (MassAccelerator convention): step the
   * clock the way you step the scene.
   */
  update(dt: number): OrbitalTransportState[] {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (step > 0) {
      this.clockS += step;
      this.ensurePlans(this.clockS);
      // Departure edge: retire actives whose scene-residency has lapsed.
      for (let i = this.actives.length - 1; i >= 0; i--) {
        const active = this.actives[i];
        if (active !== undefined && this.clockS > active.closeS + APPROACH_VISIBILITY_S) {
          if (this.built) this.setVesselEnabled(active.plan.blueprint, false);
          this.actives.splice(i, 1);
        }
      }
      // Approach edge: promote scheduled transits into scene residency.
      for (const plan of this.plans) {
        if (this.actives.some((a) => a.plan.index === plan.index)) continue;
        if (this.clockS >= plan.tCloseS - (plan.windowS / 2 + APPROACH_VISIBILITY_S) &&
            this.clockS <= plan.tCloseS + plan.windowS / 2 + APPROACH_VISIBILITY_S) {
          const openS = plan.tCloseS - plan.windowS / 2;
          const closeS = plan.tCloseS + plan.windowS / 2;
          this.actives.push({ plan, openS, closeS });
          if (this.built) this.setVesselEnabled(plan.blueprint, true);
        }
      }
    }
    if (!this.disposed && this.built) {
      this.placeVessels();
      this.animateVisuals();
    }
    return this.actives.map((a) => this.stateOf(a.plan, this.clockS));
  }

  /**
   * The transport the gunner should be leading right now: the scene-resident
   * vessel currently inside its ≥ 20° firing window (the schedule never
   * overlaps actives, so at most one exists). Null when the sky is empty.
   * Answers scenelessly (pure schedule).
   */
  getActiveTarget(): OrbitalTransportState | null {
    for (const a of this.actives) {
      if (this.clockS >= a.openS && this.clockS <= a.closeS) return this.stateOf(a.plan, this.clockS);
    }
    return null;
  }

  /**
   * In-flight canister resolution (Spec 27 §3.2.3). The candidate is the
   * active transport whose 80 m tractor-cone axis is nearest the canister.
   * `missDistanceM` is the distance from the canister to that axis segment;
   * `relativeSpeedMps` is ‖v_canister − v_transport‖ at the candidate.
   * Capture requires a catchable class (R_catch > 0), relative speed at or
   * under maxCatchRelSpeedMps, and the canister inside the tractor frustum
   * OR inside the 1.5 × R_catch magnetic-assist sphere around the bay ring.
   * With no active transport the answer is
   * `{ captured: false, transport: null, missDistanceM: Infinity, relativeSpeedMps: 0 }`.
   */
  checkCapture(canisterPos: { x: number; y: number; z: number }, canisterVel: { x: number; y: number; z: number }): {
    captured: boolean;
    transport: OrbitalTransportState | null;
    missDistanceM: number;
    relativeSpeedMps: number;
  } {
    const px = finiteOr(canisterPos?.x, 0);
    const py = finiteOr(canisterPos?.y, 0);
    const pz = finiteOr(canisterPos?.z, 0);
    const cvx = finiteOr(canisterVel?.x, 0);
    const cvy = finiteOr(canisterVel?.y, 0);
    const cvz = finiteOr(canisterVel?.z, 0);

    let best: ActiveTransit | null = null;
    let bestState: OrbitalTransportState | null = null;
    let bestMiss = Infinity;
    let bestRel = 0;

    for (const active of this.actives) {
      const plan = active.plan;
      const bp = plan.blueprint;
      const t = this.stateOf(plan, this.clockS);
      const speed = bp.speedMps;
      const ux = plan.dirX;
      const uy = plan.dirY;
      // Axis segment: bay ring (t.position) extending 80 m aft (−velocity).
      const miss = distPointToAxisSegment(
        px, py, pz,
        t.position.x, t.position.y, t.position.z,
        -ux, -uy, 0,
        CAPTURE_FUNNEL_LENGTH_M,
      );
      if (miss < bestMiss) {
        const tvx = ux * speed;
        const tvy = uy * speed;
        const dvx = cvx - tvx;
        const dvy = cvy - tvy;
        const dvz = cvz - 0;
        best = active;
        bestState = t;
        bestMiss = miss;
        bestRel = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
      }
    }

    if (best === null || bestState === null) {
      return { captured: false, transport: null, missDistanceM: Infinity, relativeSpeedMps: 0 };
    }

    const bp = best.plan.blueprint;
    const speed = bp.speedMps;
    const ux = best.plan.dirX;
    const uy = best.plan.dirY;
    const rx = px - bestState.position.x;
    const ry = py - bestState.position.y;
    const rz = pz - bestState.position.z;
    const along = rx * ux + ry * uy; // + = ahead of the bay along the velocity
    const behind = -along;           // + = astern, where the funnel lives
    const radialX = rx - ux * along;
    const radialY = ry - uy * along;
    const r = Math.sqrt(radialX * radialX + radialY * radialY + rz * rz);

    let captured = false;
    if (bp.catchRadiusM > 0 && bestRel <= bp.maxCatchRelSpeedMps) {
      // Tractor frustum: bay ring (radius FRUSTUM_BAY_RADIUS_M) widening to
      // R_catch at 80 m astern.
      const inFrustum =
        behind >= 0 &&
        behind <= CAPTURE_FUNNEL_LENGTH_M &&
        r <= FRUSTUM_BAY_RADIUS_M + (bp.catchRadiusM - FRUSTUM_BAY_RADIUS_M) * (behind / CAPTURE_FUNNEL_LENGTH_M);
      // Magnetic assist window (Spec 27 §3.2.3).
      const distToBay = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const inAssist = distToBay <= MAGNETIC_ASSIST_FACTOR * bp.catchRadiusM;
      captured = inFrustum || inAssist;
    }
    return { captured, transport: bestState, missDistanceM: bestMiss, relativeSpeedMps: bestRel };
  }

  // -- schedule queries -----------------------------------------------------------------

  /** System clock in seconds since construction (readback). */
  getClockS(): number {
    return this.clockS;
  }

  /**
   * Sky-track radar feed (Phase 5 HUD): the next `count` scheduled transits
   * with their open countdowns. Always answers (pure schedule); opensInS is
   * 0 while the window is currently open.
   */
  getSchedule(count = 3): TransitScheduleEntry[] {
    const n = clamp(Math.floor(finiteOr(count, 3)), 1, 16);
    // Look far enough ahead that `n` future windows are always memoized.
    this.ensurePlans(this.clockS + (n - 1) * TRANSIT_INTERVAL_MAX_S);
    // Include every planned transit whose window opens in the future, plus
    // the one currently open; take the first `n` in time order.
    const out: TransitScheduleEntry[] = [];
    for (const plan of this.plans) {
      const openS = plan.tCloseS - plan.windowS / 2;
      if (openS < this.clockS - plan.windowS) continue; // long finished
      out.push({
        id: plan.blueprint.id,
        name: plan.blueprint.name,
        transportClass: plan.blueprint.transportClass,
        opensInS: Math.max(0, openS - this.clockS),
        windowS: plan.windowS,
        inFiringWindow: this.clockS >= openS && this.clockS <= plan.tCloseS + plan.windowS / 2,
      });
      if (out.length >= n) break;
    }
    return out;
  }

  /** Seconds until the next firing window opens (0 while inside one). */
  timeToNextWindowS(): number {
    const current = this.getActiveTarget();
    if (current !== null) return 0;
    this.ensurePlans(this.clockS);
    let best = Infinity;
    for (const plan of this.plans) {
      const openS = plan.tCloseS - plan.windowS / 2;
      if (openS > this.clockS && openS - this.clockS < best) best = openS - this.clockS;
    }
    return best;
  }

  // -- accessors --------------------------------------------------------------------------

  /** System root transform (null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every vessel + cone mesh (registration / picking handle). */
  getMeshes(): AbstractMesh[] {
    return [...this.meshList];
  }

  /**
   * Meshes tagged with a part id — 'vessel_hull' | 'nose' | 'crew_cab' |
   * 'ore_hopper' | 'engine_bell' | 'engine_block' | 'tractor_ring' |
   * 'cargo_bay' | 'nav_light' | 'capture_cone' | 'wing' | 'fin' |
   * 'superstructure' | 'sensor_dome' | 'beacon_bar' | 'stripe' | 'antenna'.
   */
  getPartMeshes(part: string): Mesh[] {
    return this.meshList.filter((m) => (m.metadata?.part as string | undefined) === part);
  }

  /** Meshes belonging to one vessel id (see {@link TRANSPORT_VESSELS}). */
  getVesselMeshes(vesselId: string): Mesh[] {
    return this.meshList.filter((m) => (m.metadata?.vessel as string | undefined) === vesselId);
  }

  // -- pure schedule core --------------------------------------------------------------------

  /** Extend the memoized schedule until a close-approach exists past t + lookahead. */
  private ensurePlans(t: number): void {
    const LOOKAHEAD_S = 130;
    for (;;) {
      const last = this.plans[this.plans.length - 1];
      if (last !== undefined && last.tCloseS >= t + LOOKAHEAD_S) return;
      this.buildNextPlan();
    }
  }

  /**
   * Derive the next transit from the seeded stream (consumed strictly in
   * transit order — deterministic regardless of when this runs).
   */
  private buildNextPlan(): TransitPlan {
    const index = this.plans.length;
    const blueprint = TRANSPORT_VESSELS[index % TRANSPORT_VESSELS.length];
    // Interval from the previous transit's close-approach (first: fixed).
    const intervalToNextS =
      TRANSIT_INTERVAL_MIN_S + this.rand() * (TRANSIT_INTERVAL_MAX_S - TRANSIT_INTERVAL_MIN_S);
    const prev = this.plans[index - 1];
    const tCloseS = index === 0
      ? FIRST_TRANSIT_CLOSEST_APPROACH_S
      : (prev !== undefined ? prev.tCloseS : FIRST_TRANSIT_CLOSEST_APPROACH_S) +
        (prev !== undefined ? prev.intervalToNextS : 0);
    // Window length: base ± jitter, clamped into the Spec [20, 35] band.
    const windowS = clamp(
      blueprint.windowBaseS + (this.rand() * 2 - 1) * blueprint.windowJitterS,
      TRANSIT_WINDOW_MIN_S,
      TRANSIT_WINDOW_MAX_S,
    );
    // Pass direction alternates E→W / S→N (Spec 27 §3.2.1).
    const eastWest = index % 2 === 0;
    const dirX = eastWest ? -1 : 0;
    const dirY = eastWest ? 0 : 1;
    // Impact parameter chosen so the LOS ≥ 20° chord lasts exactly windowS.
    const hCot = blueprint.altitudeM * COT_LOS;
    const halfChord = (windowS * blueprint.speedMps) / 2;
    const impact = Math.sqrt(Math.max(hCot * hCot - halfChord * halfChord, 0));
    // Lateral offset side (perpendicular left of dir) from the seeded stream.
    const side = this.rand() < 0.5 ? -1 : 1;
    const normalX = -dirY * side;
    const normalY = dirX * side;
    const plan: TransitPlan = {
      index,
      blueprint,
      dirX,
      dirY,
      closestX: this.observer.x + normalX * impact,
      closestY: this.observer.y + normalY * impact,
      tCloseS,
      windowS,
      intervalToNextS,
    };
    this.plans.push(plan);
    return plan;
  }

  /** Pure kinematic state snapshot of one plan at clock time `t`. */
  private stateOf(plan: TransitPlan, t: number): OrbitalTransportState {
    const bp = plan.blueprint;
    const s = bp.speedMps * (t - plan.tCloseS);
    const openS = plan.tCloseS - plan.windowS / 2;
    const closeS = plan.tCloseS + plan.windowS / 2;
    const inWindow = t >= openS && t <= closeS;
    return {
      id: bp.id,
      name: bp.name,
      transportClass: bp.transportClass,
      position: {
        x: plan.closestX + plan.dirX * s,
        y: plan.closestY + plan.dirY * s,
        z: bp.altitudeM,
      },
      velocity: {
        x: plan.dirX * bp.speedMps,
        y: plan.dirY * bp.speedMps,
        z: 0,
      },
      speedMps: bp.speedMps,
      altitudeM: bp.altitudeM,
      catchRadiusM: bp.catchRadiusM,
      maxCatchRelSpeedMps: bp.maxCatchRelSpeedMps,
      payoutMultiplier: bp.payoutMultiplier,
      inFiringWindow: inWindow,
      timeRemainingInWindowS: inWindow ? Math.max(0, closeS - t) : 0,
    };
  }

  // -- scene placement & animation -------------------------------------------------------------

  private findVesselRoot(bp: VesselBlueprint): TransformNode | null {
    for (let i = 0; i < TRANSPORT_VESSELS.length; i++) {
      if (TRANSPORT_VESSELS[i] === bp) return this.vesselRoots[i] ?? null;
    }
    return null;
  }

  private setVesselEnabled(bp: VesselBlueprint, enabled: boolean): void {
    const node = this.findVesselRoot(bp);
    if (node !== null) node.setEnabled(enabled);
  }

  /** Push pure kinematics onto Babylon nodes: position + nose-along-velocity yaw. */
  private placeVessels(): void {
    for (let i = 0; i < TRANSPORT_VESSELS.length; i++) {
      const node = this.vesselRoots[i];
      if (node === undefined || node === null) continue;
      if (!node.isEnabled()) continue;
      // Find the active transit using this vessel (actives are few).
      for (const active of this.actives) {
        if (active.plan.blueprint !== TRANSPORT_VESSELS[i]) continue;
        const st = this.stateOf(active.plan, this.clockS);
        node.position.copyFrom(worldToBabylon(st.position));
        // Local +z (nose) → world velocity direction (left-handed image).
        node.rotation.y = Math.atan2(active.plan.dirX, -active.plan.dirY);
        break;
      }
    }
  }

  /** Cone shimmer, engine glow, USP beacon alternation. */
  private animateVisuals(): void {
    const t = this.clockS;
    // Shared engine plume: idle shimmer.
    const glow = this.engineGlowMaterial;
    if (glow !== null) {
      const g = 0.55 + 0.18 * Math.sin(t * 3.1);
      glow.emissiveColor.set(0.95 * g, 0.42 * g, 0.12 * g);
    }
    // Tractor cones shimmer gently when scene-resident, snap to a hard
    // steady field once the firing window is open.
    for (let i = 0; i < this.coneMaterials.length; i++) {
      const mat = this.coneMaterials[i];
      if (mat === null || mat === undefined) continue;
      const bp = TRANSPORT_VESSELS[i];
      const active = this.actives.find((a) => a.plan.blueprint === bp);
      if (active === undefined) continue;
      const inWindow = t >= active.openS && t <= active.closeS;
      mat.alpha = inWindow
        ? 0.22 + 0.03 * Math.sin(t * 9.0)
        : 0.10 + 0.03 * Math.sin(t * 2.4 + i);
    }
    // USP Vigilance: alternating blue law-enforcement strobes.
    const beacons = this.beaconMaterials;
    if (beacons !== null) {
      const a = 0.5 + 0.5 * Math.sin(t * 8.0);
      beacons[0].emissiveColor.set(0.06 * (0.3 + a), 0.42 * (0.3 + a), 0.95 * (0.3 + a));
      beacons[1].emissiveColor.set(0.06 * (1.3 - a), 0.42 * (1.3 - a), 0.95 * (1.3 - a));
    }
  }

  // -- materials -------------------------------------------------------------------------

  /** Vacuum-lunar PBR shorthand; environment stays near zero, nothing to reflect. */
  private mkTracked(
    name: string,
    scene: Scene,
    albedo: readonly [number, number, number],
    metallic: number,
    roughness: number,
    emissive?: readonly [number, number, number],
    environmentIntensity = 0.05,
  ): PBRMaterial {
    const material = new PBRMaterial(`${ORBITAL_TRANSPORT_NAME_PREFIX}-${name}`, scene);
    material.albedoColor = Color3.FromArray(albedo);
    material.metallic = metallic;
    material.roughness = roughness;
    if (emissive !== undefined) material.emissiveColor = Color3.FromArray(emissive);
    material.environmentIntensity = environmentIntensity;
    this.materialList.push(material);
    return material;
  }

  // -- vessel construction -------------------------------------------------------------------

  /** Create + place + parent + metadata-tag in one call (Babylon-local frame). */
  private part(
    partId: string,
    bp: VesselBlueprint,
    slot: number,
    mesh: Mesh,
    mat: PBRMaterial,
    x: number,
    y: number,
    z: number,
    parent: TransformNode,
  ): Mesh {
    mesh.material = mat;
    mesh.position.set(x, y, z);
    mesh.parent = parent;
    mesh.metadata = { part: partId, system: ORBITAL_TRANSPORT_NAME_PREFIX, vessel: bp.id };
    this.meshList.push(mesh);
    return mesh;
  }

  /**
   * Build one vessel at index `slot` of TRANSPORT_VESSELS. The vessel root IS
   * the cargo-bay capture-ring datum: state position == root position, nose
   * along local +z, capture frustum extending along local −z. Vessels start
   * hidden and are enabled by the schedule.
   */
  private buildVessel(scene: Scene, bp: VesselBlueprint, slot: number): void {
    const tag = bp.id.replace(`${ORBITAL_TRANSPORT_NAME_PREFIX}-`, '');
    const node = new TransformNode(`${ORBITAL_TRANSPORT_NAME_PREFIX}-vessel-${tag}`, scene);
    node.parent = this.root;
    node.setEnabled(false);
    this.vesselRoots[slot] = node;

    // Shared hull/fit-out set.
    const hull = this.mkTracked(`${tag}-hull`, scene, [0.14, 0.15, 0.17], 0.8, 0.45, undefined, 0.16);
    const dark = this.mkTracked(`${tag}-dark`, scene, [0.05, 0.055, 0.065], 0.5, 0.6, undefined, 0.08);
    const steel = this.mkTracked(`${tag}-steel`, scene, [0.24, 0.25, 0.28], 0.9, 0.3, undefined, 0.2);
    const glass = this.mkTracked(`${tag}-glass`, scene, [0.08, 0.14, 0.2], 0.6, 0.05, undefined, 0.5);
    glass.alpha = 0.45;
    const engineGlow = this.engineGlowMaterial ??
      this.mkTracked('engine-glow', scene, [0.06, 0.03, 0.01], 0.2, 0.5, [0.5, 0.22, 0.06], 0);
    if (this.engineGlowMaterial === null) {
      engineGlow.disableLighting = true;
      this.engineGlowMaterial = engineGlow;
    }

    if (bp.transportClass === 'BULK_FREIGHTER') {
      this.buildBulkTug(scene, bp, slot, node, { hull, dark, steel, glass }, engineGlow);
    } else if (bp.transportClass === 'SYNDICATE_RUNNER') {
      this.buildSyndicateRunner(scene, bp, slot, node, { hull, dark, steel, glass }, engineGlow);
    } else {
      this.buildPatrolCutter(scene, bp, slot, node, { hull, dark, steel, glass }, engineGlow);
    }

    // Electromagnetic capture frustum (Spec 27 §3.2.3): bay ring → mouth at
    // 80 m astern. Hostiles project no catchable field (R_catch = 0).
    if (bp.catchRadiusM > 0) {
      const coneMat = this.mkTracked(`${tag}-tractor-field`, scene, [0.0, 0.05, 0.08], 0, 1, [0, 0.62, 0.75], 0);
      coneMat.disableLighting = true;
      coneMat.alpha = 0.1;
      const cone = MeshBuilder.CreateCylinder(`${ORBITAL_TRANSPORT_NAME_PREFIX}-cone-${tag}`, {
        diameterTop: bp.catchRadiusM * 2,
        diameterBottom: FRUSTUM_BAY_RADIUS_M * 2,
        height: CAPTURE_FUNNEL_LENGTH_M,
        tessellation: 24,
      }, scene);
      // Cylinder top (+y) → local −z (astern): the wide mouth trails behind.
      cone.rotation.x = -Math.PI / 2;
      this.part('capture_cone', bp, slot, cone, coneMat, 0, 0, -CAPTURE_FUNNEL_LENGTH_M / 2, node);
      cone.isPickable = false;
      this.coneMaterials[slot] = coneMat;
    } else {
      this.coneMaterials[slot] = null;
    }
  }

  private buildBulkTug(
    scene: Scene, bp: VesselBlueprint, slot: number, node: TransformNode,
    mats: { hull: PBRMaterial; dark: PBRMaterial; steel: PBRMaterial; glass: PBRMaterial },
    engineGlow: PBRMaterial,
  ): void {
    // ~64 m industrial ore tug: spine, slab hull, tapered nose, crew cupola,
    // twin dorsal ore hoppers, stern engine block with 4 bells, belly tractor
    // emitter ring and nav lights.
    const spine = this.part('vessel_hull', bp, slot,
      MeshBuilder.CreateCylinder(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-spine-${slot}`,
        { diameter: 2.6, height: 64, tessellation: 10 }, scene),
      mats.dark, 0, 0, 0, node);
    spine.rotation.x = Math.PI / 2; // cylinder axis → local z
    this.part('vessel_hull', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-hull-${slot}`,
        { width: 12, height: 10, depth: 44 }, scene),
      mats.hull, 0, 0, -2, node);
    const nose = this.part('nose', bp, slot,
      MeshBuilder.CreateCylinder(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-nose-${slot}`,
        { diameterTop: 1.2, diameterBottom: 10, height: 10, tessellation: 10 }, scene),
      mats.hull, 0, 0, 25, node);
    nose.rotation.x = Math.PI / 2; // small end points +z (ahead)
    this.part('crew_cab', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-cab-${slot}`,
        { width: 6, height: 3.6, depth: 8 }, scene),
      mats.steel, 0, 6.8, 12, node);
    this.part('crew_cab', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-cabglass-${slot}`,
        { width: 5.6, height: 2.2, depth: 7 }, scene),
      mats.glass, 0, 7.4, 12.4, node);
    for (const hopperZ of [-6, -17]) {
      this.part('ore_hopper', bp, slot,
        MeshBuilder.CreateCylinder(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-hopper-${slot}-${hopperZ}`,
          { diameter: 7, height: 12, tessellation: 8 }, scene),
        mats.dark, 0, 11, hopperZ, node);
    }
    this.part('engine_block', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-engines-${slot}`,
        { width: 10, height: 4.4, depth: 4.5 }, scene),
      mats.steel, 0, 0, -26, node);
    for (const bellX of [-3.6, -1.2, 1.2, 3.6]) {
      const bell = this.part('engine_bell', bp, slot,
        MeshBuilder.CreateCylinder(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-bell-${slot}-${bellX}`,
          { diameterTop: 2.8, diameterBottom: 1.4, height: 4, tessellation: 8 }, scene),
        engineGlow, bellX, 0, -30, node);
      bell.rotation.x = -Math.PI / 2; // wide mouth opens astern (−z)
    }
    // Tractor emitter ring on the belly under the cargo bay.
    const ring = this.part('tractor_ring', bp, slot,
      MeshBuilder.CreateTorus(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-ring-${slot}`,
        { diameter: 14, thickness: 1.2, tessellation: 20 }, scene),
      this.tractorStatic(scene), 0, -6.4, -4, node);
    ring.rotation.x = 0; // torus plane is already horizontal (XZ)
    // Cargo bay marker ring at the capture datum (root origin).
    const bay = this.part('cargo_bay', bp, slot,
      MeshBuilder.CreateTorus(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-bay-${slot}`,
        { diameter: 5, thickness: 0.5, tessellation: 16 }, scene),
      this.tractorStatic(scene), 0, -5.2, 0, node);
    bay.rotation.x = 0;
    // Nav lights: port red, starboard green.
    const navRed = this.mkTracked('nav-red', scene, [0.1, 0.01, 0.01], 0.1, 0.5, [0.95, 0.06, 0.04], 0);
    const navGreen = this.mkTracked('nav-green', scene, [0.01, 0.1, 0.02], 0.1, 0.5, [0.05, 0.9, 0.2], 0);
    navRed.disableLighting = true;
    navGreen.disableLighting = true;
    this.part('nav_light', bp, slot,
      MeshBuilder.CreateSphere(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-navport-${slot}`, { diameter: 1.2, segments: 6 }, scene),
      navRed, -6.4, 0, 18, node);
    this.part('nav_light', bp, slot,
      MeshBuilder.CreateSphere(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-navstbd-${slot}`, { diameter: 1.2, segments: 6 }, scene),
      navGreen, 6.4, 0, 18, node);
    this.part('antenna', bp, slot,
      MeshBuilder.CreateCylinder(`${ORBITAL_TRANSPORT_NAME_PREFIX}-tug-mast-${slot}`,
        { diameter: 0.3, height: 6, tessellation: 6 }, scene),
      mats.steel, 0, 15.5, 2, node);
  }

  /** Shared cyan emissive for tractor emitter / bay rings (built once). */
  private tractorStatic(scene: Scene): PBRMaterial {
    if (this.tractorStaticMaterial === null) {
      const mat = this.mkTracked('tractor-static', scene, [0.02, 0.06, 0.08], 0.3, 0.4, [0, 0.55, 0.62], 0);
      mat.disableLighting = true;
      this.tractorStaticMaterial = mat;
    }
    return this.tractorStaticMaterial;
  }

  private buildSyndicateRunner(
    scene: Scene, bp: VesselBlueprint, slot: number, node: TransformNode,
    mats: { hull: PBRMaterial; dark: PBRMaterial; steel: PBRMaterial; glass: PBRMaterial },
    engineGlow: PBRMaterial,
  ): void {
    // ~38 m black-market dart: round fuselage, canopy, swept delta wings,
    // magenta trim slits, stern glow slit, small belly tractor ring.
    const fuselage = this.part('vessel_hull', bp, slot,
      MeshBuilder.CreateCylinder(`${ORBITAL_TRANSPORT_NAME_PREFIX}-slip-fuse-${slot}`,
        { diameter: 3.4, height: 34, tessellation: 10 }, scene),
      mats.dark, 0, 0, -2, node);
    fuselage.rotation.x = Math.PI / 2;
    const nose = this.part('nose', bp, slot,
      MeshBuilder.CreateCylinder(`${ORBITAL_TRANSPORT_NAME_PREFIX}-slip-nose-${slot}`,
        { diameterTop: 0.5, diameterBottom: 3.4, height: 8, tessellation: 10 }, scene),
      mats.dark, 0, 0, 19, node);
    nose.rotation.x = Math.PI / 2;
    this.part('crew_cab', bp, slot,
      MeshBuilder.CreateSphere(`${ORBITAL_TRANSPORT_NAME_PREFIX}-slip-canopy-${slot}`,
        { diameter: 5, segments: 10, slice: 0.55 }, scene),
      mats.glass, 0, 1.2, 8, node);
    const magenta = this.mkTracked('trim-magenta', scene, [0.08, 0.01, 0.1], 0.3, 0.4, [0.55, 0.02, 0.65], 0);
    magenta.disableLighting = true;
    for (const side of [-1, 1]) {
      const wing = this.part('wing', bp, slot,
        MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-slip-wing-${slot}-${side}`,
          { width: 15, height: 0.4, depth: 8 }, scene),
        mats.dark, side * 8.5, -0.2, -8, node);
      wing.rotation.y = -side * 0.35; // swept-back delta
      this.part('stripe', bp, slot,
        MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-slip-stripe-${slot}-${side}`,
          { width: 13, height: 0.12, depth: 0.6 }, scene),
        magenta, side * 8.8, 0.12, -7.6, node).rotation.y = -side * 0.35;
    }
    this.part('fin', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-slip-fin-${slot}`,
        { width: 0.4, height: 5.4, depth: 7 }, scene),
      mats.dark, 0, 2.8, -13, node);
    const slit = this.part('engine_bell', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-slip-slit-${slot}`,
        { width: 4.4, height: 1.5, depth: 0.6 }, scene),
      engineGlow, 0, 0, -19.6, node);
    slit.rotation.y = 0;
    const ring = this.part('tractor_ring', bp, slot,
      MeshBuilder.CreateTorus(`${ORBITAL_TRANSPORT_NAME_PREFIX}-slip-ring-${slot}`,
        { diameter: 9, thickness: 0.8, tessellation: 18 }, scene),
      magenta, 0, -2.4, -6, node);
    ring.rotation.x = 0;
    const bay = this.part('cargo_bay', bp, slot,
      MeshBuilder.CreateTorus(`${ORBITAL_TRANSPORT_NAME_PREFIX}-slip-bay-${slot}`,
        { diameter: 4, thickness: 0.4, tessellation: 14 }, scene),
      magenta, 0, -2.1, 0, node);
    bay.rotation.x = 0;
    this.part('antenna', bp, slot,
      MeshBuilder.CreateCylinder(`${ORBITAL_TRANSPORT_NAME_PREFIX}-slip-dish-mast-${slot}`,
        { diameter: 0.22, height: 3.4, tessellation: 6 }, scene),
      mats.steel, 0, -2.6, 12, node);
  }

  private buildPatrolCutter(
    scene: Scene, bp: VesselBlueprint, slot: number, node: TransformNode,
    mats: { hull: PBRMaterial; dark: PBRMaterial; steel: PBRMaterial; glass: PBRMaterial },
    engineGlow: PBRMaterial,
  ): void {
    // ~44 m USP law-enforcement cutter: angular armored hull, sensor dome,
    // alternating blue strobe bars, wing fins, triple stern engines.
    this.part('vessel_hull', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-hull-${slot}`,
        { width: 9, height: 7, depth: 40 }, scene),
      mats.hull, 0, 0, -2, node);
    const nose = this.part('nose', bp, slot,
      MeshBuilder.CreateCylinder(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-nose-${slot}`,
        { diameterTop: 1, diameterBottom: 9, height: 9, tessellation: 4 }, scene),
      mats.steel, 0, 0, 22.5, node);
    nose.rotation.x = Math.PI / 2;
    nose.rotation.y = Math.PI / 4;
    this.part('superstructure', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-bridge-${slot}`,
        { width: 5, height: 4, depth: 14 }, scene),
      mats.dark, 0, 5.4, 6, node);
    this.part('crew_cab', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-glass-${slot}`,
        { width: 4.6, height: 1.8, depth: 5 }, scene),
      mats.glass, 0, 6.6, 10.5, node);
    const sensorWhite = this.mkTracked('sensor-white', scene, [0.2, 0.2, 0.22], 0.2, 0.3, [0.5, 0.55, 0.62], 0);
    sensorWhite.disableLighting = true;
    this.part('sensor_dome', bp, slot,
      MeshBuilder.CreateSphere(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-dome-${slot}`,
        { diameter: 3.4, segments: 10 }, scene),
      sensorWhite, 0, 4.6, 16, node);
    // Alternating blue strobes (tracked pair, animated out of phase).
    const strobeA = this.mkTracked('usp-strobe-a', scene, [0.02, 0.06, 0.14], 0.2, 0.4, [0.06, 0.42, 0.95], 0);
    const strobeB = this.mkTracked('usp-strobe-b', scene, [0.02, 0.06, 0.14], 0.2, 0.4, [0.06, 0.42, 0.95], 0);
    strobeA.disableLighting = true;
    strobeB.disableLighting = true;
    this.beaconMaterials = [strobeA, strobeB];
    this.part('beacon_bar', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-strobe-fwd-${slot}`,
        { width: 6.4, height: 0.8, depth: 0.8 }, scene),
      strobeA, 0, 3.9, 14, node);
    this.part('beacon_bar', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-strobe-aft-${slot}`,
        { width: 5.4, height: 0.8, depth: 0.8 }, scene),
      strobeB, 0, 3.9, -14, node);
    for (const side of [-1, 1]) {
      const fin = this.part('fin', bp, slot,
        MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-fin-${slot}-${side}`,
          { width: 12, height: 0.6, depth: 7 }, scene),
        mats.hull, side * 8.6, 0, -10, node);
      fin.rotation.y = -side * 0.25;
    }
    this.part('stripe', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-stripeside-${slot}`,
        { width: 0.25, height: 1.1, depth: 26 }, scene),
      sensorWhite, 4.62, 0.5, -3, node);
    this.part('engine_block', bp, slot,
      MeshBuilder.CreateBox(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-engines-${slot}`,
        { width: 7, height: 4, depth: 4 }, scene),
      mats.steel, 0, 0, -24, node);
    for (const bellX of [-2.4, 0, 2.4]) {
      const bell = this.part('engine_bell', bp, slot,
        MeshBuilder.CreateCylinder(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-bell-${slot}-${bellX}`,
          { diameterTop: 2.2, diameterBottom: 1.1, height: 3.6, tessellation: 8 }, scene),
        engineGlow, bellX, 0, -27.6, node);
      bell.rotation.x = -Math.PI / 2;
    }
    const bay = this.part('cargo_bay', bp, slot,
      MeshBuilder.CreateTorus(`${ORBITAL_TRANSPORT_NAME_PREFIX}-usp-bay-${slot}`,
        { diameter: 4.4, thickness: 0.4, tessellation: 14 }, scene),
      mats.steel, 0, -3.8, 0, node);
    bay.rotation.x = 0;
  }

  // -- teardown helper ------------------------------------------------------------------------

  private static disposeQuietly(target: { dispose(): unknown } | null): void {
    if (target === null) return;
    try {
      target.dispose();
    } catch {
      /* already gone */
    }
  }
}
