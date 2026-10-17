/**
 * Lunar Frontier — Mare Mass Accelerator "The Gauss Needle" (Spec 27 §3.1).
 *
 * High on the basalt caldera rim at (-320, -1450) overlooking Mare
 * Tranquillitatis, the illicit face of the lunar export economy is a 180 m
 * elevated electromagnetic coilgun: a 40 m traversing ring foundation with
 * motorized azimuth drive tracks, twin hydraulic elevation pedestals rising
 * 22 m to the barrel pivot, an open-truss hexagonal rail assembly carrying
 * 24 sequential HTS solenoid drive coils (blue #00e5ff stator rings pulsing
 * down the length during charge and discharge), six cryogenic capacitor
 * banks glowing amber (#ffab00) as stored energy rises, an automated cargo
 * crane linking the rover unloading bay to the breech loading chamber, and
 * the gunner's glass cupola bunker at the foot of the trunnion tower.
 *
 * Articulation (Spec 27 §3.1.2) is a pure two-axis kinematic model over
 * degrees, answered from state alone — `setAimTarget()` / `update()` /
 * `chargeCapacitor()` / `dischargeFire()` all work before `init()`, after
 * `dispose()`, and with no scene at all, so the ExportMinigameDirector
 * (Phase 4), the HUD (Phase 5) and the smoke suite (Phase 6) can never race
 * the mesh build:
 *   • Azimuth   ψ ∈ [0°, 360°) continuous, slew 25°/s, shortest-arc travel.
 *   • Elevation θ ∈ [15°, 85°] hard stops, slew 15°/s (no zenith gimbal
 *     singularity, no caldera-peak terrain scrape).
 *
 * Capacitor spool (Spec 27 §3.4.2 / blueprint §3):
 *   v0(t) = v_min + (v_max − v_min) · (1 − e^(−t / τ_spool))
 *   with v_min = 180 m/s, v_max = 420 m/s, τ_spool = 1.6 s.
 * Holding charge beyond 4.5 s trips the thermal breaker: energy is dumped
 * as an emergency heat flare and the gun is locked out for a 5.0 s cooldown.
 *
 * Frame convention (shared with `CameraRig` / `WorldScene`): world metres
 * (x, y lateral, z↑) map to Babylon (x, z↑, −y) via `worldToBabylon`. The
 * unit fire vector follows the Spec 27 §3.3.1 launch formula expressed in
 * the codebase z-up physics frame:
 *   v0 = v0 · (cosθ·cosψ, cosθ·sinψ, sinθ)
 * and the Babylon node rotations below (yaw = atan2(−cosψ, −sinψ), pitch =
 * θ about the elevation node's +x) are the exact left-handed image of that
 * formula — asserted against the physical muzzle marker's absolute position
 * by the headless smoke harness.
 *
 * Headless-safe: `init()` accepts a Scene, a raw engine (a scene is created
 * around it), or nothing (self-owned NullEngine fallback). `dispose()` is
 * idempotent and never throws; after disposal every query still answers and
 * every mesh accessor returns empty.
 *
 * Usage:
 *   const gun = new MassAccelerator().init(scene);
 *   gun.setAimTarget(214.0, 62.5);
 *   while (chargeHeld) gun.chargeCapacitor(dt);
 *   const shot = gun.dischargeFire(); // { success, muzzleVelocity, fireVector }
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

/** Spec 27 §1.1/§3.1.1: caldera-rim seat in world metres (z = datum datum). */
export const MASS_ACCELERATOR_DEFAULT_WORLD: Readonly<{ x: number; y: number; z: number }> = {
  x: -320,
  y: -1450,
  z: 0,
};

/** Spec 27 §3.1.1.3: linear induction barrel length along the fire axis (m). */
export const BARREL_LENGTH_M = 180;
/** Spec 27 §3.1.1.1: traversing ring foundation diameter (m). */
export const BASE_RING_DIAMETER_M = 40;
/** Spec 27 §3.1.1.2: trunnion towers rise 22 m to the barrel pivot (m). */
export const TRUNNION_HEIGHT_M = 22;
/** Spec 27 §3.1.1.3: sequential HTS solenoid drive coils along the barrel. */
export const COIL_COUNT = 24;
/** Spec 27 §3.1.1.5: cryogenic capacitor banks ringing the sub-station. */
export const CAPACITOR_BANK_COUNT = 6;

/** Spec 27 §3.1.2: azimuth slew rate, degrees per second. */
export const AZIMUTH_SLEW_RATE_DPS = 25;
/** Spec 27 §3.1.2: elevation slew rate, degrees per second. */
export const ELEVATION_SLEW_RATE_DPS = 15;
/** Spec 27 §3.1.2: elevation hard stop — terrain scrape limit (deg). */
export const ELEVATION_MIN_DEG = 15;
/** Spec 27 §3.1.2: elevation hard stop — zenith gimbal guard (deg). */
export const ELEVATION_MAX_DEG = 85;

/** Spec 27 §3.4.2: capacitor curve v_min (m/s). */
export const V_MIN_MPS = 180;
/** Spec 27 §3.4.2: capacitor curve v_max (m/s). */
export const V_MAX_MPS = 420;
/** Spec 27 §3.4.2: capacitor RC spool time constant (s). */
export const TAU_SPOOL_S = 1.6;
/** Spec 27 §3.4.2: thermal breaker trip point for a held charge (s). */
export const OVERCHARGE_TRIP_S = 4.5;
/** Spec 27 §3.4.2: breaker lockout after a coil dump (s). */
export const BREAKER_COOLDOWN_S = 5.0;
/** Post-shot quench/reset cycle before the coils may spool again (s). */
export const POST_FIRE_COOLDOWN_S = 1.5;
/** Lorentz recoil animation duration after a successful discharge (s). */
export const RECOIL_DURATION_S = 0.45;
/** Peak recoil travel of the barrel carriage along −axis (m). */
export const RECOIL_TRAVEL_M = 2.2;

/** Root/material name prefix. */
export const ACCELERATOR_NAME_PREFIX = 'mass-accelerator';

/** Spec 27 §4: serialized gantry + capacitor state snapshot. */
export interface AcceleratorGantryState {
  azimuthDeg: number;       // 0 to 360
  elevationDeg: number;     // 15 to 85
  isSlewing: boolean;
  capacitorChargeRatio: number; // 0.0 to 1.0
  muzzleVelocityMps: number;    // 180 to 420
  state: 'IDLE' | 'LOADING' | 'TARGETING' | 'CHARGING' | 'FIRING' | 'COOLDOWN' | 'OVERCHARGED';
  cooldownRemainingS: number;
}

/** One HTS stator ring + its own emissive material for the sequential pulse. */
interface DriveCoil {
  mesh: Mesh;
  material: PBRMaterial;
  /** Normalized station along the barrel, 0 (breech) → 1 (muzzle). */
  station: number;
}

// -- helpers ------------------------------------------------------------------

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

/** Wrap a radian angle to [0, 2π). */
function wrapRad(a: number): number {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

/** Shortest signed delta (radians) from `from` to `to`, in (−π, π]. */
function shortestDelta(from: number, to: number): number {
  let d = wrapRad(to) - wrapRad(from);
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Capacitor spool curve (blueprint §3): RC charge profile from v_min toward
 * v_max with time constant τ_spool. Pure and total-function: any non-finite
 * or negative time answers v_min.
 */
export function spoolVelocityMps(chargeTimeS: number): number {
  const t = Number.isFinite(chargeTimeS) && chargeTimeS > 0 ? chargeTimeS : 0;
  return V_MIN_MPS + (V_MAX_MPS - V_MIN_MPS) * (1 - Math.exp(-t / TAU_SPOOL_S));
}

const DEG = Math.PI / 180;

// ================================================================================

export class MassAccelerator {
  // -- seat (world frame, scene-independent) ------------------------------------
  private readonly seat: { x: number; y: number; z: number };

  // -- kinematic source of truth (degrees kept as radians internally) ------------
  private azimuthRad = 0;
  private elevationRad = ELEVATION_MIN_DEG * DEG;
  private targetAzimuthRad = 0;
  private targetElevationRad = ELEVATION_MIN_DEG * DEG;

  // -- capacitor / lifecycle ------------------------------------------------------
  private chargeTimeS = 0;
  private state: AcceleratorGantryState['state'] = 'IDLE';
  private cooldownRemainingS = 0;
  private firingRemainingS = 0;
  /** Total shots fired since construction (harness readback). */
  private shotsFired = 0;
  /** Total breaker trips since construction (harness readback). */
  private breakerTrips = 0;

  // -- scene graph -----------------------------------------------------------------
  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;

  private root: TransformNode | null = null;
  /** Azimuth carrier (rotates about facility +z↑ / Babylon +y). */
  private yawPivot: TransformNode | null = null;
  /** Elevation carrier, child of {@link yawPivot} at the trunnion pivot. */
  private elevationPivot: TransformNode | null = null;
  /** Recoil carriage between the elevation pivot and the barrel meshes. */
  private recoilNode: TransformNode | null = null;

  private coils: DriveCoil[] = [];
  private capacitorMaterial: PBRMaterial | null = null;
  private meshList: Mesh[] = [];
  private materialList: PBRMaterial[] = [];

  private elapsed = 0;
  private built = false;
  private disposed = false;

  constructor(position?: { x: number; y: number; z?: number }) {
    const d = MASS_ACCELERATOR_DEFAULT_WORLD;
    this.seat = {
      x: finiteOr(position?.x, d.x),
      y: finiteOr(position?.y, d.y),
      z: finiteOr(position?.z, d.z),
    };
  }

  // -- lifecycle ------------------------------------------------------------------

  /**
   * Build the facility. Accepts an existing `Scene`, a raw engine (a scene is
   * created around it), or nothing — falling back to a self-owned
   * `NullEngine`, exactly what CI wants. Idempotent; refuses after `dispose()`.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('MassAccelerator: init() after dispose()');
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
      throw new Error('MassAccelerator.init: browser needs a Scene or Engine');
    }

    const scene = this.scene;
    this.root = new TransformNode(`${ACCELERATOR_NAME_PREFIX}-system`, scene);
    this.root.position.copyFrom(worldToBabylon(this.seat));
    this.buildFacility(scene);
    this.applyArticulation();
    this.built = true;
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /**
   * Tear down every mesh, material, node and any self-owned engine. Never
   * throws; after this call every kinematic/capacitor query still answers
   * (pure state), and the mesh accessors return empty.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;

    for (const mesh of this.meshList) MassAccelerator.disposeQuietly(mesh);
    this.meshList = [];
    for (const material of this.materialList) MassAccelerator.disposeQuietly(material);
    this.materialList = [];
    this.coils = [];
    this.capacitorMaterial = null;
    MassAccelerator.disposeQuietly(this.root);
    this.root = null;
    this.yawPivot = null;
    this.elevationPivot = null;
    this.recoilNode = null;

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) MassAccelerator.disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- aiming ---------------------------------------------------------------------

  /**
   * Command the barrel to an aim solution. `azimuthDeg` wraps into
   * [0, 360) and the gun slews the shortest arc at 25°/s; `elevationDeg` is
   * clamped to the [15°, 85°] hard stops and slews at 15°/s. Non-finite
   * input is ignored (the gun keeps its last order). An IDLE gun promotes
   * itself to TARGETING; every other state keeps its lifecycle.
   */
  setAimTarget(azimuthDeg: number, elevationDeg: number): void {
    if (!Number.isFinite(azimuthDeg) || !Number.isFinite(elevationDeg)) return;
    this.targetAzimuthRad = wrapRad(azimuthDeg * DEG);
    this.targetElevationRad = clamp(elevationDeg, ELEVATION_MIN_DEG, ELEVATION_MAX_DEG) * DEG;
    if (this.state === 'IDLE') this.state = 'TARGETING';
  }

  // -- capacitor & firing -----------------------------------------------------------

  /**
   * Advance the cryogenic capacitor bank by `dt` seconds while the fire
   * trigger is held (Spec 27 §3.4.2) and answer the current muzzle velocity
   * in m/s. Ignored (returns the present velocity) while FIRING, COOLDOWN,
   * OVERCHARGED or LOADING. Holding past {@link OVERCHARGE_TRIP_S} trips the
   * thermal breaker: the bank dumps to zero and a {@link BREAKER_COOLDOWN_S}
   * lockout begins.
   */
  chargeCapacitor(dt: number): number {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (
      this.state !== 'IDLE' &&
      this.state !== 'TARGETING' &&
      this.state !== 'CHARGING'
    ) {
      return this.getMuzzleVelocityMps();
    }
    if (step > 0) {
      this.chargeTimeS += step;
      this.state = 'CHARGING';
      if (this.chargeTimeS >= OVERCHARGE_TRIP_S) {
        // Thermal coil saturation: dump the bank as emergency heat and lock out.
        this.chargeTimeS = 0;
        this.state = 'OVERCHARGED';
        this.cooldownRemainingS = BREAKER_COOLDOWN_S;
        this.breakerTrips += 1;
      }
    }
    return this.getMuzzleVelocityMps();
  }

  /**
   * Fire command: release the trigger and discharge the bank down the rail
   * (Spec 27 §4 contract). Answers `{ success, muzzleVelocity, fireVector }`
   * where `fireVector` is the unit launch direction in the z-up world frame
   * — (cosθ·cosψ, cosθ·sinψ, sinθ) per Spec 27 §3.3.1 — evaluated at the
   * *nominal* (un-recoiled) muzzle line. A success latches FIRING (recoil
   * animation), then a short quench COOLDOWN before the gun returns to IDLE
   * with a spent bank. Firing while FIRING / COOLDOWN / OVERCHARGED fails
   * and answers the still-locked velocity.
   */
  dischargeFire(): { success: boolean; muzzleVelocity: number; fireVector: { x: number; y: number; z: number } } {
    const velocity = this.getMuzzleVelocityMps();
    const fireVector = this.getFireVector();
    if (this.state === 'FIRING' || this.state === 'COOLDOWN' || this.state === 'OVERCHARGED') {
      return { success: false, muzzleVelocity: velocity, fireVector };
    }
    // Spent bank fires the curve floor (a tap-shot at v_min) — always a shot.
    this.shotsFired += 1;
    this.state = 'FIRING';
    this.firingRemainingS = RECOIL_DURATION_S;
    this.chargeTimeS = 0;
    return { success: true, muzzleVelocity: velocity, fireVector };
  }

  /**
   * Payload-flow hook for the ExportMinigameDirector (Phase 4): the breech
   * crane swinging a canister into the loading chamber. Toggles IDLE ↔
   * LOADING; charging is refused while loading. Every other lifecycle state
   * is left untouched.
   */
  setLoading(loading: boolean): void {
    if (loading && this.state === 'IDLE') this.state = 'LOADING';
    else if (!loading && this.state === 'LOADING') this.state = 'IDLE';
  }

  // -- queries -----------------------------------------------------------------------

  /** Current muzzle velocity (m/s) implied by the spool curve. */
  getMuzzleVelocityMps(): number {
    return spoolVelocityMps(this.chargeTimeS);
  }

  /** Capacitor bank charge as a 0..1 ratio of the [v_min, v_max] band. */
  getCapacitorChargeRatio(): number {
    return clamp((this.getMuzzleVelocityMps() - V_MIN_MPS) / (V_MAX_MPS - V_MIN_MPS), 0, 1);
  }

  /** Unit launch direction in the z-up world physics frame (Spec 27 §3.3.1). */
  getFireVector(): { x: number; y: number; z: number } {
    const cosEl = Math.cos(this.elevationRad);
    return {
      x: cosEl * Math.cos(this.azimuthRad),
      y: cosEl * Math.sin(this.azimuthRad),
      z: Math.sin(this.elevationRad),
    };
  }

  /** Muzzle mouth in world metres (z↑): pivot + BARREL_LENGTH · fire vector. */
  getMuzzleWorldPosition(): { x: number; y: number; z: number } {
    const u = this.getFireVector();
    return {
      x: this.seat.x + BARREL_LENGTH_M * u.x,
      y: this.seat.y + BARREL_LENGTH_M * u.y,
      z: this.seat.z + TRUNNION_HEIGHT_M + BARREL_LENGTH_M * u.z,
    };
  }

  /** Facility seat in world metres (copy). */
  getWorldSeat(): { x: number; y: number; z: number } {
    return { ...this.seat };
  }

  /** Shots fired / breaker trips since construction (harness readback). */
  getStats(): { shotsFired: number; breakerTrips: number } {
    return { shotsFired: this.shotsFired, breakerTrips: this.breakerTrips };
  }

  /**
   * Current serialized state without advancing anything (Spec 27 §4 shape).
   * `cooldownRemainingS` reports time until the coils may spool again: the
   * FIRING recoil plus quench are counted in full during a shot.
   */
  getState(): AcceleratorGantryState {
    const azErr = Math.abs(shortestDelta(this.azimuthRad, this.targetAzimuthRad));
    const elErr = Math.abs(this.targetElevationRad - this.elevationRad);
    let cooldownRemaining = 0;
    if (this.state === 'FIRING') cooldownRemaining = this.firingRemainingS + POST_FIRE_COOLDOWN_S;
    else if (this.state === 'COOLDOWN' || this.state === 'OVERCHARGED') {
      cooldownRemaining = this.cooldownRemainingS;
    }
    return {
      azimuthDeg: wrapRad(this.azimuthRad) / DEG,
      elevationDeg: this.elevationRad / DEG,
      isSlewing: azErr > 1e-3 || elErr > 1e-3,
      capacitorChargeRatio: this.getCapacitorChargeRatio(),
      muzzleVelocityMps: this.getMuzzleVelocityMps(),
      state: this.state,
      cooldownRemainingS: cooldownRemaining,
    };
  }

  /**
   * One frame: slew both axes toward the aim order at their rate limits,
   * advance the firing/quench/breaker timers, spring the recoil carriage and
   * modulate the HTS coil pulse and capacitor amber glow. Safe before init /
   * after dispose (pure state still advances; no mesh animation).
   */
  update(dt: number): AcceleratorGantryState {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (step > 0) {
      this.elapsed += step;

      // -- 2-axis slew (Spec 27 §3.1.2 rate limits) --------------------------------
      const azDelta = shortestDelta(this.azimuthRad, this.targetAzimuthRad);
      const azStep = AZIMUTH_SLEW_RATE_DPS * DEG * step;
      this.azimuthRad = wrapRad(
        Math.abs(azDelta) <= azStep ? this.targetAzimuthRad : this.azimuthRad + Math.sign(azDelta) * azStep,
      );
      const elDelta = this.targetElevationRad - this.elevationRad;
      const elStep = ELEVATION_SLEW_RATE_DPS * DEG * step;
      this.elevationRad =
        Math.abs(elDelta) <= elStep ? this.targetElevationRad : this.elevationRad + Math.sign(elDelta) * elStep;

      // -- lifecycle timers ----------------------------------------------------------
      if (this.state === 'FIRING') {
        this.firingRemainingS -= step;
        if (this.firingRemainingS <= 0) {
          this.firingRemainingS = 0;
          this.state = 'COOLDOWN';
          this.cooldownRemainingS = POST_FIRE_COOLDOWN_S;
        }
      } else if (this.state === 'COOLDOWN' || this.state === 'OVERCHARGED') {
        this.cooldownRemainingS -= step;
        if (this.cooldownRemainingS <= 0) {
          this.cooldownRemainingS = 0;
          this.state = 'IDLE';
        }
      }
    }

    if (!this.disposed && this.built) {
      this.applyArticulation();
      this.animateVisuals();
    }
    return this.getState();
  }

  // -- accessors ----------------------------------------------------------------------

  /** System root transform (null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every facility mesh (shadow/picking registration). */
  getMeshes(): AbstractMesh[] {
    return [...this.meshList];
  }

  /**
   * Shadow-casting subset of `getMeshes()`: the cupola glazing is light, not
   * matter, and never occludes the sun.
   */
  getShadowCasterMeshes(): AbstractMesh[] {
    return this.meshList.filter((m) => {
      const part = m.metadata?.part as string | undefined;
      return part !== 'cockpit_glass';
    });
  }

  /**
   * Meshes tagged with a part id — 'base_ring' | 'base_deck' | 'drive_track' |
   * 'trunnion_tower' | 'pivot_hub' | 'barrel_truss' | 'coil' | 'breech' |
   * 'muzzle' | 'capacitor_bank' | 'capacitor_cap' | 'conduit' | 'crane_arm' | 'hopper' |
   * 'rover_bay' | 'cockpit' | 'cockpit_glass' | 'console' — the smoke suite's
   * structural assertion handle.
   */
  getPartMeshes(part: string): Mesh[] {
    return this.meshList.filter((m) => (m.metadata?.part as string | undefined) === part);
  }

  // -- articulation application ---------------------------------------------------------

  /**
   * Push the kinematic state onto the Babylon node rotations. Exact
   * left-handed image of the Spec §3.3.1 launch formula: with yaw on the
   * azimuth node and pitch on the elevation node, local +z maps to
   * (sin y cos p, −sin p, cos y cos p) in Babylon, i.e. world
   * (cosθcosψ, cosθsinψ, sinθ) for y = atan2(cosψ, −sinψ), p = −θ (Babylon
   * pitch-down is positive, so elevation raises with a negative pitch).
   */
  private applyArticulation(): void {
    if (this.yawPivot !== null) {
      this.yawPivot.rotation.y = Math.atan2(Math.cos(this.azimuthRad), -Math.sin(this.azimuthRad));
    }
    if (this.elevationPivot !== null) {
      this.elevationPivot.rotation.x = -this.elevationRad;
    }
    if (this.recoilNode !== null) {
      // Spring back: full travel mid-recoil, decaying to the nominal line.
      if (this.state === 'FIRING' && this.firingRemainingS > 0) {
        const t = 1 - this.firingRemainingS / RECOIL_DURATION_S; // 0 → 1
        this.recoilNode.position.z = -RECOIL_TRAVEL_M * Math.sin(Math.PI * t) * (1 - 0.4 * t);
      } else if (this.recoilNode.position.z !== 0) {
        this.recoilNode.position.z = 0;
      }
    }
  }

  /** Emissive modulation: sequential HTS pulse + capacitor amber + heat flare. */
  private animateVisuals(): void {
    const t = this.elapsed;
    const ratio = this.getCapacitorChargeRatio();

    // Sequential stator pulse down the barrel (Spec 27 §3.1.1.4).
    const charging = this.state === 'CHARGING';
    const firing = this.state === 'FIRING';
    const tripped = this.state === 'OVERCHARGED';
    const sweepSpeed = 0.45 + 1.7 * ratio; // charge builds the wave train
    const sweep = charging || firing ? (t * sweepSpeed) % 1.15 - 0.075 : 0;
    for (const coil of this.coils) {
      let glow: number;
      if (firing) {
        glow = 1.6 * clamp(this.firingRemainingS / RECOIL_DURATION_S, 0, 1) + 0.4;
      } else if (charging) {
        const d = (coil.station - sweep) / 0.09;
        glow = 0.35 + 0.35 * ratio + Math.exp(-d * d) * (0.7 + 0.6 * ratio);
      } else if (tripped) {
        // Emergency heat flare: red ringing while the breaker locks out.
        glow = 0.5 + 0.5 * Math.sin(t * 17.5);
      } else {
        glow = 0.22 + 0.12 * Math.sin(t * 2.3 + coil.station * 9.4);
      }
      const mat = coil.material;
      if (tripped) {
        mat.emissiveColor.set(0.95 * glow, 0.12 * glow, 0.05 * glow);
      } else {
        // Stator ring blue #00e5ff = (0, 0.898, 1.0).
        mat.emissiveColor.set(0.05 * glow, 0.898 * glow, 1.0 * glow);
      }
    }

    // Cryogenic capacitor banks glow amber #ffab00 with stored energy.
    const bank = this.capacitorMaterial;
    if (bank !== null) {
      const breathe = 0.8 + 0.2 * Math.sin(t * 6.5);
      const a = ratio * breathe;
      bank.emissiveColor.set(1.0 * (0.08 + a), 0.67 * (0.05 + a), 0.0 * (0.0 + a) + 0.02);
    }
  }

  // -- materials ------------------------------------------------------------------------

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

  // -- mesh construction -------------------------------------------------------------------

  /** Create + place + parent + metadata-tag in one call (Babylon-local frame). */
  private part(
    _name: string,
    partId: string,
    mesh: Mesh,
    mat: PBRMaterial,
    x: number,
    y: number,
    z: number,
    parent?: TransformNode | null,
  ): Mesh {
    mesh.material = mat;
    mesh.position.set(x, y, z);
    mesh.parent = parent ?? this.root;
    mesh.metadata = { part: partId, system: ACCELERATOR_NAME_PREFIX };
    this.meshList.push(mesh);
    return mesh;
  }

  private buildFacility(scene: Scene): void {
    // Shared industrial set (each PBR is registered once for teardown).
    const steel = this.mkTracked(`${ACCELERATOR_NAME_PREFIX}-steel`, scene, [0.16, 0.17, 0.2], 0.85, 0.35, undefined, 0.18);
    const composite = this.mkTracked(`${ACCELERATOR_NAME_PREFIX}-composite`, scene, [0.05, 0.06, 0.07], 0.4, 0.6, undefined, 0.1);
    const concrete = this.mkTracked(`${ACCELERATOR_NAME_PREFIX}-concrete`, scene, [0.11, 0.11, 0.115], 0.05, 0.9, undefined, 0.08);
    const gold = this.mkTracked(`${ACCELERATOR_NAME_PREFIX}-gold`, scene, [0.85, 0.68, 0.22], 0.9, 0.35, undefined, 0.25);
    const hazard = this.mkTracked(`${ACCELERATOR_NAME_PREFIX}-hazard`, scene, [0.5, 0.32, 0.04], 0.3, 0.6, [0.28, 0.14, 0.02], 0.1);
    this.capacitorMaterial = this.mkTracked(`${ACCELERATOR_NAME_PREFIX}-capacitor`, scene, [0.08, 0.06, 0.02], 0.5, 0.4, [0.08, 0.05, 0.02], 0);
    const cockpitGlass = this.mkTracked(`${ACCELERATOR_NAME_PREFIX}-glass`, scene, [0.08, 0.14, 0.2], 0.6, 0.05, undefined, 0.5);
    cockpitGlass.alpha = 0.45;
    const consoleMat = this.mkTracked(`${ACCELERATOR_NAME_PREFIX}-console`, scene, [0.02, 0.05, 0.06], 0.2, 0.5, [0.0, 0.55, 0.62], 0);

    // -- circular traversing base (Spec 27 §3.1.1.1) ------------------------------------
    // 40 m titanium-concrete ring foundation embedded in bedrock.
    this.part('base-deck', 'base_deck',
      MeshBuilder.CreateCylinder(`${ACCELERATOR_NAME_PREFIX}-base-deck`,
        { diameter: BASE_RING_DIAMETER_M, height: 1.6, tessellation: 32 }, scene),
      concrete, 0, 0.8, 0);
    this.part('base-ring', 'base_ring',
      MeshBuilder.CreateTorus(`${ACCELERATOR_NAME_PREFIX}-base-ring`,
        { diameter: BASE_RING_DIAMETER_M, thickness: 0.8, tessellation: 48 }, scene),
      steel, 0, 1.75, 0);
    // Motorized azimuth drive track: segmented toothed ring.
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      this.part(`drive-track-${i}`, 'drive_track',
        MeshBuilder.CreateBox(`${ACCELERATOR_NAME_PREFIX}-drive-track-${i}`,
          { width: 7.4, height: 0.5, depth: 1.6 }, scene),
        gold, Math.cos(a) * 18.4, 1.95, Math.sin(a) * 18.4).rotation.y = -a;
    }

    // -- azimuth carrier -----------------------------------------------------------------
    // The towers, pivot and barrel all rotate together about facility +z↑.
    const yaw = new TransformNode(`${ACCELERATOR_NAME_PREFIX}-yaw`, scene);
    yaw.parent = this.root;
    yaw.position.set(0, 1.6, 0); // on top of the base deck
    this.yawPivot = yaw;

    this.part('yaw-cradle', 'pivot_hub',
      MeshBuilder.CreateCylinder(`${ACCELERATOR_NAME_PREFIX}-yaw-cradle`,
        { diameter: 12, height: 2.2, tessellation: 20 }, scene),
      steel, 0, 1.1, 0, yaw);

    // -- twin-boom hydraulic elevation pedestals (Spec 27 §3.1.1.2) ----------------------
    // 22 m trunnion towers flanking the fire axis (local +z), rams on the inner faces.
    for (const side of [-1, 1]) {
      const towerX = side * 7.5;
      this.part(`trunnion-tower-${side}`, 'trunnion_tower',
        MeshBuilder.CreateBox(`${ACCELERATOR_NAME_PREFIX}-trunnion-tower-${side}`,
          { width: 3.4, depth: 5.2, height: TRUNNION_HEIGHT_M }, scene),
        composite, towerX, TRUNNION_HEIGHT_M / 2, 0, yaw);
      this.part(`trunnion-cap-${side}`, 'trunnion_tower',
        MeshBuilder.CreateBox(`${ACCELERATOR_NAME_PREFIX}-trunnion-cap-${side}`,
          { width: 4.2, depth: 6, height: 1.1 }, scene),
        steel, towerX, TRUNNION_HEIGHT_M + 0.55, 0, yaw);
      // Hydraulic ram (gold piston) driving the pedestal.
      const ram = this.part(`trunnion-ram-${side}`, 'trunnion_tower',
        MeshBuilder.CreateCylinder(`${ACCELERATOR_NAME_PREFIX}-trunnion-ram-${side}`,
          { diameter: 0.7, height: 15, tessellation: 8 }, scene),
        gold, towerX - side * 2.6, TRUNNION_HEIGHT_M * 0.45, 1.6, yaw);
      ram.rotation.x = -0.5;
    }
    // Central barrel pivot hub sits at exactly TRUNNION_HEIGHT_M above the deck.
    const pivot = new TransformNode(`${ACCELERATOR_NAME_PREFIX}-elevation`, scene);
    pivot.parent = yaw;
    pivot.position.set(0, TRUNNION_HEIGHT_M - 1.6, 0);
    this.elevationPivot = pivot;
    this.part('pivot-hub', 'pivot_hub',
      MeshBuilder.CreateSphere(`${ACCELERATOR_NAME_PREFIX}-pivot-hub`, { diameter: 4.6, segments: 12 }, scene),
      steel, 0, 0, 0, pivot);

    // -- recoil carriage + 180 m linear induction barrel (Spec 27 §3.1.1.3) ---------------
    const carriage = new TransformNode(`${ACCELERATOR_NAME_PREFIX}-recoil`, scene);
    carriage.parent = pivot;
    this.recoilNode = carriage;

    // Hexagonal open-truss rail assembly: central composite spar + 6 carbon
    // corner spars run the full 180 m from breech (z=0) to muzzle (z=180).
    this.part('barrel-spine', 'barrel_truss',
      MeshBuilder.CreateCylinder(`${ACCELERATOR_NAME_PREFIX}-barrel-spine`,
        { diameter: 1.4, height: BARREL_LENGTH_M, tessellation: 12 }, scene),
      composite, 0, 0, BARREL_LENGTH_M / 2, carriage).rotation.x = Math.PI / 2;
    const TRUSS_R = 1.7;
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      const cx = Math.cos(a) * TRUSS_R;
      const cy = Math.sin(a) * TRUSS_R;
      this.part(`barrel-spar-${i}`, 'barrel_truss',
        MeshBuilder.CreateCylinder(`${ACCELERATOR_NAME_PREFIX}-barrel-spar-${i}`,
          { diameter: 0.34, height: BARREL_LENGTH_M, tessellation: 6 }, scene),
        steel, cx, cy, BARREL_LENGTH_M / 2, carriage).rotation.x = Math.PI / 2;
    }
    // Cross-brace rings every 15 m along the truss.
    for (let i = 1; i < BARREL_LENGTH_M / 15; i++) {
      this.part(`barrel-brace-${i}`, 'barrel_truss',
        MeshBuilder.CreateTorus(`${ACCELERATOR_NAME_PREFIX}-barrel-brace-${i}`,
          { diameter: TRUSS_R * 2, thickness: 0.22, tessellation: 12 }, scene),
        steel, 0, 0, i * 15, carriage).rotation.x = Math.PI / 2;
    }

    // 24 sequential HTS solenoid drive coils — each ring gets its own PBR so
    // the charge/discharge pulse can run down the barrel station by station.
    for (let i = 0; i < COIL_COUNT; i++) {
      const station = (i + 0.5) / COIL_COUNT; // 0 → 1 breech-to-muzzle
      const coilMat = this.mkTracked(`${ACCELERATOR_NAME_PREFIX}-coil-${i}`, scene,
        [0.02, 0.04, 0.1], 0.3, 0.4, [0.0, 0.2, 0.22], 0);
      coilMat.disableLighting = true;
      const coil = MeshBuilder.CreateTorus(`${ACCELERATOR_NAME_PREFIX}-coil-${i}`,
        { diameter: 4.6, thickness: 0.65, tessellation: 20 }, scene);
      this.part(`coil-${i}`, 'coil', coil, coilMat, 0, 0, station * BARREL_LENGTH_M, carriage);
      coil.isPickable = false;
      this.coils.push({ mesh: coil, material: coilMat as PBRMaterial, station });
    }

    // Breech loading chamber + muzzle mouth marker.
    this.part('breech-block', 'breech',
      MeshBuilder.CreateBox(`${ACCELERATOR_NAME_PREFIX}-breech`, { width: 5.4, height: 5.4, depth: 6.5 }, scene),
      steel, 0, 0, -3.4, carriage);
    const muzzleRing = this.part('muzzle-ring', 'muzzle',
      MeshBuilder.CreateTorus(`${ACCELERATOR_NAME_PREFIX}-muzzle`,
        { diameter: 4.2, thickness: 0.5, tessellation: 20 }, scene),
      gold, 0, 0, BARREL_LENGTH_M, carriage);
    muzzleRing.rotation.x = Math.PI / 2;
    // The harness asserts getMuzzleWorldPosition() against this marker.
    muzzleRing.metadata = { part: 'muzzle', system: ACCELERATOR_NAME_PREFIX, muzzleMarker: true };

    // -- cryogenic capacitor sub-station (Spec 27 §3.1.1.5) --------------------------------
    // 6 modular banks ringing the base outside the drive track (fixed to the
    // seat — they do NOT yaw with the barrel).
    for (let i = 0; i < CAPACITOR_BANK_COUNT; i++) {
      const a = (i * Math.PI * 2) / CAPACITOR_BANK_COUNT + Math.PI / 12;
      const bx = Math.cos(a) * 27;
      const bz = Math.sin(a) * 27;
      this.part(`capacitor-bank-${i}`, 'capacitor_bank',
        MeshBuilder.CreateCylinder(`${ACCELERATOR_NAME_PREFIX}-capacitor-bank-${i}`,
          { diameter: 4.6, height: 8.5, tessellation: 14 }, scene),
        this.capacitorMaterial ?? composite, bx, 4.25, bz);
      this.part(`capacitor-cap-${i}`, 'capacitor_cap',
        MeshBuilder.CreateTorus(`${ACCELERATOR_NAME_PREFIX}-capacitor-cap-${i}`,
          { diameter: 4.6, thickness: 0.45, tessellation: 14 }, scene),
        steel, bx, 8.7, bz);
      // Cryo conduit from the bank toward the ring.
      const conduit = this.part(`capacitor-conduit-${i}`, 'conduit',
        MeshBuilder.CreateCylinder(`${ACCELERATOR_NAME_PREFIX}-capacitor-conduit-${i}`,
          { diameter: 0.55, height: 6.4, tessellation: 6 }, scene),
        steel, bx * 0.83, 1.3, bz * 0.83);
      conduit.rotation.z = Math.PI / 2;
      conduit.rotation.y = -a + Math.PI / 2;
    }

    // -- cargo hopper, crane arm & rover unloading bay (Spec 27 §3.1.1.6) -------------------
    this.part('hopper-body', 'hopper',
      MeshBuilder.CreateCylinder(`${ACCELERATOR_NAME_PREFIX}-hopper`,
        { diameterTop: 9, diameterBottom: 4.5, height: 10, tessellation: 8 }, scene),
      composite, 34, 6.6, -18);
    this.part('hopper-skirt', 'hopper',
      MeshBuilder.CreateBox(`${ACCELERATOR_NAME_PREFIX}-hopper-skirt`, { width: 6, height: 1.8, depth: 6 }, scene),
      hazard, 34, 0.9, -18);
    // Gantry crane: column + jib swinging over the breech side of the ring.
    this.part('crane-column', 'crane_arm',
      MeshBuilder.CreateCylinder(`${ACCELERATOR_NAME_PREFIX}-crane-column`,
        { diameter: 1.8, height: 26, tessellation: 10 }, scene),
      steel, 24, 13, 6);
    this.part('crane-jib', 'crane_arm',
      MeshBuilder.CreateBox(`${ACCELERATOR_NAME_PREFIX}-crane-jib`, { width: 30, height: 1.3, depth: 2.2 }, scene),
      gold, 9.5, 25.4, 6);
    this.part('crane-hoist', 'crane_arm',
      MeshBuilder.CreateBox(`${ACCELERATOR_NAME_PREFIX}-crane-hoist`, { width: 2.4, height: 3.2, depth: 2.4 }, scene),
      steel, -2, 23.4, 6);
    // Rover unloading bay pad with hazard chevrons.
    this.part('rover-bay-pad', 'rover_bay',
      MeshBuilder.CreateCylinder(`${ACCELERATOR_NAME_PREFIX}-rover-bay`,
        { diameter: 22, height: 0.7, tessellation: 6 }, scene),
      concrete, 38, 0.35, 16);

    // -- gunner cockpit / fire control bunker (Spec 27 §3.1.1.7) ------------------------------
    // Elevated glass cupola at the base of the trunnion tower (fixed: the
    // bunker never rotates while the gun does).
    this.part('cockpit-bunker', 'cockpit',
      MeshBuilder.CreateBox(`${ACCELERATOR_NAME_PREFIX}-cockpit-bunker`, { width: 9, height: 6, depth: 8 }, scene),
      composite, -15, 3.8, 9);
    const cupola = this.part('cockpit-cupola', 'cockpit_glass',
      MeshBuilder.CreateSphere(`${ACCELERATOR_NAME_PREFIX}-cockpit-cupola`,
        { diameter: 7.5, segments: 12, slice: 0.6 }, scene),
      cockpitGlass, -15, 6.6, 9);
    cupola.rotation.x = -Math.PI / 2; // dome faces the sky + breech quadrant
    this.part('cockpit-console', 'console',
      MeshBuilder.CreateBox(`${ACCELERATOR_NAME_PREFIX}-cockpit-console`, { width: 4.6, height: 1.1, depth: 1.6 }, scene),
      consoleMat, -15, 5.1, 12.2);
  }

  /** Build a PBR material and register it for teardown (single list). */
  private mkTracked(
    name: string,
    scene: Scene,
    albedo: readonly [number, number, number],
    metallic: number,
    roughness: number,
    emissive?: readonly [number, number, number],
    environmentIntensity?: number,
  ): PBRMaterial {
    const material = MassAccelerator.mk(name, scene, albedo, metallic, roughness, emissive, environmentIntensity ?? 0.05);
    this.materialList.push(material);
    return material;
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
