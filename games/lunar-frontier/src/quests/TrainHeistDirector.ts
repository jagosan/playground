/**
 * Lunar Frontier — Train Heist Director, "Operation Gilded Serpent" (Spec 26 §3.3).
 *
 * The Phase 3 state machine that turns the Phase 2 Apex Express into a
 * boardable, crackable, survivable (barely) moving target. It owns:
 *
 *  • the velocity-matching interception envelope (blueprint §3.2):
 *      Δv = ‖v_rover − v_train‖ ≤ 3.5 m/s
 *      d_lat = ‖r_rel − (r_rel·T̂)T̂‖ ∈ [2.5, 5.5] m
 *      d_long = |r_rel·T̂| ≤ 3.0 m,  r_rel = P_rover − P_vault
 *    — inside it `canBoard` lights the HUD green and `executeBoardingJump()`
 *    lands the avatar on the vault car catwalk;
 *  • relative platform kinematics (blueprint §3.1): while boarded, the player
 *    is anchored to the vault car local frame, P_world = M_vault · P_local,
 *    with the deck bounds (L_car ≈ 14 m × 3.2 m) enforced in local space so
 *    deck locomotion never slides the avatar off a train doing 25 m/s;
 *  • the rover tethered-autopilot target: a point 4.5 m starboard of the
 *    guideway on the maintenance service road, recomputed every frame so the
 *    parked rover waits for the bailout extraction;
 *  • the Cyber-Lock bypass (6.0 s hold-to-hack), the loot siphon (3× He-3
 *    cryo-flasks, 1× quantum cipher slate, 2× superconducting coils), the
 *    44.0 s depot-proximity countdown, and the bailout jump kinematics
 *    v_exit = v_train + v_lateral (Spec 26 §3.3.3–§3.3.4);
 *  • Spec 36 Phase 2 active cargo: roof-cradle unclamp & pick-up on the
 *    vault-car catwalk, the moving-frame ballistic throw
 *    v_cargo = v_train + v_throw (impulse 8.0–14.0 m/s, pitch ≈ 25°), and
 *    the predictive lead readout the HUD reticle paints toward the tracking
 *    buggy (blueprint 36 §"Physical Capture & Ballistic Envelopes").
 *
 * Phase machine (blueprint §2.1, canonical union in the Spec 26 Phase 3
 * contract): INACTIVE → INTERCEPTING ⇄ BOARDING_WINDOW → ON_BOARD_CRACKING →
 * LOOT_SECURED → DEPOT_COUNTDOWN → BAILOUT_SUCCESS → ESCAPE_COMPLETE, with
 * DEPOT_COUNTDOWN → FAILED on countdown expiry or Citadel shield-barrier
 * contact (the blast-gate depot sits at the citadel seat, inside the kinetic
 * dome, so "train reached the perimeter" and "countdown hit 0:00" are the
 * same vaporization answered two ways).
 *
 * Deterministic and scene-independent: every kinematic query resolves through
 * `HighSpeedMaglev`'s pure spline math and `XCorpCitadel`'s pure potential
 * field — the director answers before `init()`, after `dispose()`, and with
 * no Babylon scene at all. It NEVER advances the maglev clock (WorldScene
 * renders the train); `update(dt, …)` only advances the heist timers.
 * Garbage input (NaN positions, negative dt, missing velocity) degrades to
 * "outside the envelope", never to a throw or a NaN telemetry field.
 *
 * Coordinates: world metres (x, y lateral, z up) throughout; vault-car local
 * frame is forward +z, right-handed with the car quaternion (Babylon frame,
 * model up +y) exactly like HighSpeedMaglev's car roots.
 *
 * Usage:
 *   const director = new TrainHeistDirector(maglev, citadel);
 *   director.startHeist();
 *   const t = director.update(dt, roverPos, roverVel);   // per frame
 *   if (t.canBoard) director.executeBoardingJump();
 *   if (director.interactVaultLock(dt)) { /* loot secured *\/ }
 */
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { babylonToWorld } from '../engine/CameraRig.ts';
import { LUNAR_GRAVITY } from '../physics/TraversalPhysics.ts';
import type { HighSpeedMaglev } from '../infrastructure/HighSpeedMaglev.ts';
import type { XCorpCitadel } from '../infrastructure/XCorpCitadel.ts';

// -- canonical constants (Spec 26 §3.3) -----------------------------------------

/** Spec 26 §3.3.1: maximum relative velocity for the boarding window (m/s). */
export const MAX_RELATIVE_SPEED_MPS = 3.5;
/** Spec 26 §3.3.1: lateral-distance boarding band, inclusive (m). */
export const BOARDING_LATERAL_MIN_M = 2.5;
export const BOARDING_LATERAL_MAX_M = 5.5;
/** Spec 26 §3.3.1: longitudinal tolerance against the vault car centre (m). */
export const BOARDING_LONGITUDINAL_MAX_M = 3.0;

/** Spec 26 §3.3.1: tethered-autopilot standoff, starboard on the service road (m). */
export const TETHER_STANDBOFF_M = 4.5;

/** Spec 26 §3.3.3: Mag-Lock bypass hold-to-hack duration (s). */
export const VAULT_HACK_DURATION_S = 6.0;
/** Spec 26 §3.3.3 loot table: 3× Enriched He-3 Cryo-Flasks. */
export const LOOT_HE3_CRYO_FLASKS = 3;
/** Spec 26 §3.3.3 loot table: 1× X-Corp Quantum Cipher Slate. */
export const LOOT_QUANTUM_CIPHER_SLATES = 1;
/** Spec 26 §3.3.3 loot table: 2× Military-Grade Superconducting Coils. */
export const LOOT_SUPERCONDUCTING_COILS = 2;

/**
 * Spec 36 §3.1: the Apex Express hauls the moon's most vital survival
 * commodities — pressurized liquid water ice, high-pressure oxygen and
 * enriched Helium-3. Canonical physical-container identities for the heist:
 * per-unit mass (kg) and base fence value (credits) of each container type.
 *
 * `HE3_FLASK` is the Spec 36 physical-container identity of the Spec 26
 * "Enriched He-3 Cryo-Flask" loot line — the same 4.0 kg vessel, modelled
 * and throwable from Phase 2 onward.
 */
export const HEIST_MOON_CARGO_TYPES = ['WATER_CRYO_CELL', 'LOX_CYLINDER', 'HE3_FLASK'] as const;

export type HeistMoonCargoType = (typeof HEIST_MOON_CARGO_TYPES)[number];

/** Physical / economic spec of one moon-cargo container type (Spec 36 §3.1). */
export interface HeistMoonCargoSpec {
  /** Human-readable container label for HUD prompts. */
  label: string;
  /** Full container unit mass (kg) — drives throw ballistics and hopper load. */
  unitMassKg: number;
  /** Base per-container value at the Frontier Trading Post (credits). */
  unitValueCredits: number;
}

export const HEIST_MOON_CARGO: Readonly<Record<HeistMoonCargoType, HeistMoonCargoSpec>> = {
  WATER_CRYO_CELL: { label: 'Water Cryo-Cell', unitMassKg: 10.0, unitValueCredits: 1200 },
  LOX_CYLINDER: { label: 'LOX Cylinder', unitMassKg: 8.0, unitValueCredits: 950 },
  HE3_FLASK: { label: 'Enriched He-3 Flask', unitMassKg: 4.0, unitValueCredits: 4500 },
};

/** Type guard for externally supplied cargo-type strings (metadata, network). */
export function isHeistMoonCargoType(value: unknown): value is HeistMoonCargoType {
  return typeof value === 'string' && (HEIST_MOON_CARGO_TYPES as readonly string[]).includes(value);
}

// -- Spec 36 Phase 2: active cargo pick-up, aim & ballistic throw -------------

/** Spec 36 §2.1: lower bound of the player throw impulse (m/s). */
export const CARGO_THROW_MIN_MPS = 8.0;
/** Spec 36 §2.1: upper bound of the player throw impulse (m/s). */
export const CARGO_THROW_MAX_MPS = 14.0;
/** Spec 36 §2.1: standard uncharged-throw impulse (m/s). */
export const CARGO_THROW_STANDARD_MPS = 10.0;
/** Spec 36 §2.1: throw pitch elevation ≈ 25° above the local horizontal (rad). */
export const CARGO_THROW_PITCH_RAD = 0.44;
/** Spec 36 §2.2: soft electromagnetic catch-envelope radius R_catch (m). */
export const CARGO_CATCH_RADIUS_M = 1.8;
/** Spec 36 §2.2: relative-velocity ceiling for a magnetic capture (m/s). */
export const CARGO_CATCH_RELATIVE_MAX_MPS = 6.0;
/** Magnetic capture window: the gap cross must complete inside this (s).
 *  Spec §2.1 books the canonical crossing at 0.45–0.55 s; the window is the
 *  generous outer bound a weak (8 m/s) lob still lands inside. */
export const CARGO_CAPTURE_WINDOW_S = 2.5;
/** Two-handed chest carry / release height above the deck anchor (m). */
export const CARGO_RELEASE_HEIGHT_M = 1.2;
/** Buggy flatbed centre height — mid-point of the bed bounds
 *  Z ∈ [0.20, 0.90] m above the chassis datum (m, Spec 36 §2.2). */
export const BUGGY_BED_CENTRE_HEIGHT_M = 0.55;
/** Unclamp & pick-up reach on the catwalk, horizontal car-local (m). */
export const CARGO_PICKUP_RADIUS_M = 2.0;
/** Containers clamped per roof cradle on a fresh run. */
export const ROOF_CARGO_DEFAULT_COUNT_PER_TYPE = 2;

/**
 * Vault-car roof cradle stow points in the car-local frame (forward +z,
 * up +y; deck skin tops out at {@link BAILOUT_DECK_HEIGHT_M} = 2.9 m, the
 * cradles sit on the container deck above it). Phase 1's procedural PBR
 * container meshes mount on these same points, so pick-up proximity, throw
 * release and the clamp LEDs can never drift apart.
 */
export const ROOF_CARGO_CRADLES: Readonly<Record<HeistMoonCargoType, { x: number; y: number; z: number }>> = {
  WATER_CRYO_CELL: { x: 0.0, y: 3.3, z: -4.0 },
  LOX_CYLINDER: { x: 0.0, y: 3.3, z: 0.0 },
  HE3_FLASK: { x: 0.0, y: 3.3, z: 4.0 },
};

/**
 * Resolved snapshot of one cargo throw (Spec 36 §2.1/§2.2). The launch
 * follows r(t) = r₀ + v_cargo·t + ½g·t² in vacuum (C_d = 0,
 * g = 1.62 m/s²) with v_cargo = v_train + v_throw.
 */
export interface CargoThrowState {
  cargoType: HeistMoonCargoType;
  /** Human-readable container label (HUD / feedback). */
  label: string;
  /** World-frame release point of the canister (m). */
  releasePoint: { x: number; y: number; z: number };
  /** World-frame launch velocity v_cargo = v_train + v_throw (m/s). */
  launchVelocity: { x: number; y: number; z: number };
  /** Vacuum flight time until the canister crosses the buggy bed plane (s). */
  flightTimeS: number;
  /** Moving-frame time at which the canister closes the lateral gap (s). */
  gapCrossTimeS: number;
  /** Moving-frame miss distance of the ground track past the bed centre (m). */
  missDistanceM: number;
  /** Predicted intercept point on the bed plane (world m). */
  interceptPoint: { x: number; y: number; z: number };
  /** True once the throw is inside the magnetic capture envelope. */
  caught: boolean;
}

/** Per-frame predictive throw aim for the HUD lead reticle (Spec 36 Phase 2). */
export interface CargoAimTelemetry {
  carriedCargoType: HeistMoonCargoType;
  /** Container label for the HUD (e.g. `Water Cryo-Cell`). */
  label: string;
  /** Standard throw speed the prediction was solved at (m/s). */
  throwSpeedMps: number;
  /** Aim heading compass of the intercept bearing (deg, az 0 = +x). */
  aimAzimuthDeg: number;
  /** Moving-frame time to cross the lateral gap at this aim (s). */
  gapCrossTimeS: number;
  /** Moving-frame miss distance past the bed centre at this aim (m). */
  missDistanceM: number;
  /** Predicted intercept point on the buggy bed plane (world m). */
  interceptPoint: { x: number; y: number; z: number };
  /** True while the magnetic hopper would take the canister at this aim. */
  willCatch: boolean;
}

/** Result of a catwalk pick-up proximity scan (prompt / touch verb). */
export interface CargoPickupContact {
  cargoType: HeistMoonCargoType;
  /** Human-readable container label. */
  label: string;
  /** Horizontal catwalk distance from the player anchor to the cradle (m). */
  distanceM: number;
  /** World-frame cradle position (m). */
  worldPosition: { x: number; y: number; z: number };
}

/**
 * Spec 26 Phase 4: per-item cargo mass of the vault loot (kg). The siphon
 * hands the secured payload to the player's carrier (suit backpack, then
 * buggy flatbed) at the clamshell pop — the full canonical 3/1/2 table
 * weighs 3×4.0 + 1×1.0 + 2×5.5 = 24 kg.
 *
 * Spec 36 §3.1 adds the moon-volatile container masses alongside the legacy
 * lines; the He-3 flask entry aliases the canonical {@link HEIST_MOON_CARGO}
 * value so the physical and bookkeeping models can never drift.
 */
export const HEIST_LOOT_UNIT_MASS_KG = {
  he3CryoFlask: HEIST_MOON_CARGO.HE3_FLASK.unitMassKg, // 4.0 kg (Spec 26 line)
  quantumCipherSlate: 1.0,
  superconductingCoil: 5.5,
  /** Spec 36 §3.1: liquid water ice container. */
  waterCryoCell: HEIST_MOON_CARGO.WATER_CRYO_CELL.unitMassKg, // 10.0 kg
  /** Spec 36 §3.1: high-pressure oxygen cylinder. */
  loxCylinder: HEIST_MOON_CARGO.LOX_CYLINDER.unitMassKg, // 8.0 kg
  /** Spec 36 §3.1: physical He-3 flask (same vessel as he3CryoFlask). */
  he3Flask: HEIST_MOON_CARGO.HE3_FLASK.unitMassKg, // 4.0 kg
} as const;

function positiveCount(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0;
}

/**
 * Spec 36-aware He-3 count: the physical `he3Flasks` line, when present and
 * finite, REPLACES the legacy `he3CryoFlasks` line (same vessel — never both,
 * or the same flasks would be weighed twice). Unset reads the legacy field.
 */
function he3FlaskCount(payload: Partial<HeistLootPayload>): number {
  return Number.isFinite(payload.he3Flasks)
    ? positiveCount(payload.he3Flasks)
    : positiveCount(payload.he3CryoFlasks);
}

/**
 * Total cargo mass (kg) of a loot payload; NaN/negative counts read 0.
 * Covers the Spec 26 canonical 3/1/2 table plus the Spec 36 §3.1 moon
 * volatiles (water cryo-cells ×10.0, LOX cylinders ×8.0, He-3 flasks ×4.0),
 * which contribute 0 while absent — legacy payloads weigh exactly as before.
 */
export function heistLootCargoKg(payload: Partial<HeistLootPayload> | null | undefined): number {
  if (payload === null || payload === undefined) return 0;
  return (
    he3FlaskCount(payload) * HEIST_LOOT_UNIT_MASS_KG.he3Flask +
    positiveCount(payload.quantumCipherSlates) * HEIST_LOOT_UNIT_MASS_KG.quantumCipherSlate +
    positiveCount(payload.superconductingCoils) * HEIST_LOOT_UNIT_MASS_KG.superconductingCoil +
    positiveCount(payload.waterCryoCells) * HEIST_LOOT_UNIT_MASS_KG.waterCryoCell +
    positiveCount(payload.loxCylinders) * HEIST_LOOT_UNIT_MASS_KG.loxCylinder
  );
}

/**
 * Secured count of one moon-cargo type in a payload (Spec 36 §3.1). The
 * HE3_FLASK type folds the legacy he3CryoFlasks line (see {@link he3FlaskCount}).
 */
export function heistMoonCargoCount(
  payload: Partial<HeistLootPayload> | null | undefined,
  type: HeistMoonCargoType,
): number {
  if (payload === null || payload === undefined) return 0;
  switch (type) {
    case 'WATER_CRYO_CELL':
      return positiveCount(payload.waterCryoCells);
    case 'LOX_CYLINDER':
      return positiveCount(payload.loxCylinders);
    case 'HE3_FLASK':
      return he3FlaskCount(payload);
  }
}

/**
 * Base fence value (credits) of the moon-volatile lines of a payload
 * (water 1,200 / LOX 950 / He-3 flask 4,500 per Spec 36 §3.1). The Spec 26
 * slate/coil lines have no canonical credit value yet, so they read 0 here;
 * the Phase 5 trading-post settlement layers them on when specified.
 */
export function heistMoonCargoValueCredits(payload: Partial<HeistLootPayload> | null | undefined): number {
  if (payload === null || payload === undefined) return 0;
  let credits = 0;
  for (const type of HEIST_MOON_CARGO_TYPES) {
    credits += heistMoonCargoCount(payload, type) * HEIST_MOON_CARGO[type].unitValueCredits;
  }
  return credits;
}

/** Spec 26 §3.3.4: exactly 44.0 s from the intrusion alarm to depot entry. */
export const DEPOT_COUNTDOWN_S = 44.0;
/** Spec 26 §3.3.4: HUD red-banner banner threshold ("BAIL OUT NOW"). */
export const BAILOUT_WARNING_S = 30.0;
/** Spec 26 §3.3.4: lateral launch speed of the Leap of Faith, away from the rails (m/s). */
export const BAILOUT_LATERAL_MPS = 4.0;
/** Spec 26 §3.3.4: catwalk deck height of the vault car, measured from the
 *  car origin (body is 2.9 m tall, deck skin tops out at 2.9 m). */
export const BAILOUT_DECK_HEIGHT_M = 2.9;

/** Vault-car deck geometry in the local frame (m): length ≈ L_car, width ≈ 2×catwalk span. */
export const VAULT_DECK_LENGTH_M = 14.0;
export const VAULT_DECK_WIDTH_M = 3.2;

/** Boarding-jump apex height above the catwalk deck (m). */
export const BOARDING_APEX_HEIGHT_M = 0.5;

/** Spec 26 §3.3.4: 1,100 m from the blast gates at the alarm — the countdown seat. */
export const DEPOT_ALARM_DISTANCE_M = 1100;

/**
 * Canonical phase machine (blueprint §2.1) in transition order. The task
 * contract names LOOT_SECURED and DEPOT_COUNTDOWN as distinct states:
 * the hack completion lands the state in LOOT_SECURED (alarm fires, loot
 * granted), and the very next director `update()` tick moves it into
 * DEPOT_COUNTDOWN where the clock actually drains.
 */
export const HEIST_PHASES = [
  'INACTIVE',
  'INTERCEPTING',
  'BOARDING_WINDOW',
  'ON_BOARD_CRACKING',
  'LOOT_SECURED',
  'DEPOT_COUNTDOWN',
  'BAILOUT_SUCCESS',
  'ESCAPE_COMPLETE',
  'FAILED',
] as const;

export type HeistPhase = (typeof HEIST_PHASES)[number];

// -- public shapes (Spec 26 §4 contract) -----------------------------------------

/** Per-frame heist telemetry for the HUD intercept radar / countdown bar. */
export interface HeistTelemetry {
  phase: HeistPhase;
  /** ‖v_rover − v_train‖ (m/s) — 0 when the rover velocity is unknown. */
  relativeSpeedMps: number;
  /** Lateral offset of the rover from the vault car heading line (m). */
  lateralDistanceM: number;
  /** Signed signed longitudinal offset along the vault car tangent (m). */
  longitudinalOffsetM: number;
  /** True while the full velocity + position envelope holds (HUD green lock). */
  canBoard: boolean;
  /** Mag-Lock bypass progress 0…1 (frozen at 1 once the clamshell pops). */
  hackProgressFraction: number;
  /** Depot-proximity countdown remaining (s) — 0 outside the escape window. */
  countdownRemainingS: number;
  /** Secured loot items so far (0 before the crack, 6 after). */
  stolenCargoCount: number;
  /** Spec 36 Phase 2: true while the avatar carries a canister. */
  carryingCargo?: boolean;
  /** Spec 36 Phase 2: carried container type (null with hands free). */
  carriedCargoType?: HeistMoonCargoType | null;
  /** Spec 36 Phase 2: canisters the buggy hopper has taken this run. */
  cargoCaughtCount?: number;
  /** Spec 36 Phase 2: predictive throw aim for the HUD lead reticle
   *  (null with hands free or off the train). */
  cargoAim?: CargoAimTelemetry | null;
}

/**
 * The Cyber-Lock container payload (Spec 26 §3.3.3), extended by Spec 36
 * §3.1 with the moon-volatile lines. The three legacy fields stay canonical
 * (default heist tables carry only them); the Spec 36 fields are optional
 * and simply absent from un-migrated payloads — see {@link heistLootCargoKg}
 * and {@link heistMoonCargoCount} for the fold/replace semantics.
 */
export interface HeistLootPayload {
  he3CryoFlasks: number;
  quantumCipherSlates: number;
  superconductingCoils: number;
  /** Spec 36 §3.1: secured WATER_CRYO_CELL containers (10.0 kg / 1,200 cr). */
  waterCryoCells?: number;
  /** Spec 36 §3.1: secured LOX_CYLINDER cylinders (8.0 kg / 950 cr). */
  loxCylinders?: number;
  /**
   * Spec 36 §3.1: physical HE3_FLASK count (4.0 kg / 4,500 cr). When present
   * it REPLACES the legacy he3CryoFlasks line — the same vessel, so setting
   * both would double-count the same flasks.
   */
  he3Flasks?: number;
}

/** Construction options; every field falls back to the Spec 26 canonical. */
export interface TrainHeistOptions {
  maxRelativeSpeedMps: number;
  lateralBandMinM: number;
  lateralBandMaxM: number;
  longitudinalMaxM: number;
  hackDurationS: number;
  countdownS: number;
  tetherStandoffM: number;
  bailoutLateralMps: number;
  vaultDeckLengthM: number;
  vaultDeckWidthM: number;
  /** Spec 36 Phase 2: roof cradles clamp this many containers per type
   *  on a fresh run (clamped 0–99; default {@link ROOF_CARGO_DEFAULT_COUNT_PER_TYPE}). */
  roofCargoPerType?: number;
  /** Spec 36 Phase 2: standard throw impulse (m/s). Out-of-band values
   *  fall back to {@link CARGO_THROW_STANDARD_MPS}; per-throw callers may
   *  still request anything inside [8.0, 14.0]. */
  throwSpeedMps?: number;
  /** Loot table overrides (headless harnesses shrink the payload). */
  loot: Partial<HeistLootPayload>;
}

/** Velocity-ish input: a world-frame vector or a plain scalar road speed. */
export type RoverVelocityLike =
  | { x?: number; y?: number; z?: number }
  | number
  | null
  | undefined;

/** Player-state-ish input: an optional local-frame deck offset {x, y}. */
export type PlayerStateLike = unknown;

// -- helpers ---------------------------------------------------------------------

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Normalise the polymorphic rover velocity into a world-frame vector.
 * A scalar is interpreted as the road speed along the train's forward
 * tangent (the canonical service-road parallel-pursuit readout). Anything
 * non-finite or missing answers the zero vector (Δv = train speed —
 * "not matched", the safe side).
 */
function roverVelocityVector(
  roverVel: RoverVelocityLike,
  tangent: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  if (typeof roverVel === 'number') {
    const s = Number.isFinite(roverVel) ? roverVel : 0;
    return { x: tangent.x * s, y: tangent.y * s, z: tangent.z * s };
  }
  if (roverVel === null || roverVel === undefined) return { x: 0, y: 0, z: 0 };
  return {
    x: finiteOr(roverVel.x, 0),
    y: finiteOr(roverVel.y, 0),
    z: finiteOr(roverVel.z, 0),
  };
}

/**
 * Rotate v by unit quaternion q (v' = v + 2w·(q×v) + 2·q×(q×v)) — explicit
 * math, NaN-free and `.d.ts`-drift-proof (Babylon v9's
 * `Vector3.TransformCoordinates(Quaternion)` overload is the known
 * Quaternion-vs-Matrix signature trap).
 */
function rotateByQuaternion(
  q: Quaternion,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } {
  // t = 2 · (q_vec × v)
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  // v' = v + w·t + q_vec × t
  return {
    x: x + q.w * tx + (q.y * tz - q.z * ty),
    y: y + q.w * ty + (q.z * tx - q.x * tz),
    z: z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/**
 * P_world = M_vault · P_local: rotate the car-local point by the vault car
 * quaternion and translate to the car origin (both Babylon frame), then drop
 * the result back into the world frame (x, y lateral, z up) via the shared
 * converter — the director's whole contract is world metres.
 */
function transformPoint(
  local: { x: number; y: number; z: number },
  position: Vector3,
  rotationQuaternion: Quaternion,
): { x: number; y: number; z: number } {
  const r = rotateByQuaternion(rotationQuaternion, local.x, local.y, local.z);
  return babylonToWorld(new Vector3(r.x + position.x, r.y + position.y, r.z + position.z));
}

// ================================================================================

export class TrainHeistDirector {
  // -- options -------------------------------------------------------------------
  private readonly maglev: HighSpeedMaglev;
  private readonly citadel: XCorpCitadel | null;

  private readonly maxRelativeSpeedMps: number;
  private readonly lateralBandMinM: number;
  private readonly lateralBandMaxM: number;
  private readonly longitudinalMaxM: number;
  private readonly hackDurationS: number;
  private readonly countdownS: number;
  private readonly tetherStandoffM: number;
  private readonly bailoutLateralMps: number;
  private readonly vaultDeckLengthM: number;
  private readonly vaultDeckWidthM: number;
  private readonly lootTable: HeistLootPayload;

  // -- state machine (pure timers; the maglev clock is not ours) -------------------
  private phase: HeistPhase = 'INACTIVE';
  /** Seconds accumulated on the Mag-Lock bypass (only in ON_BOARD_CRACKING). */
  private hackElapsedS = 0;
  /** Depot countdown remaining (s); armed at LOOT_SECURED, drained in DEPOT_COUNTDOWN. */
  private countdownRemainingS = 0;
  /** Loot secured so far (all-or-nothing at the clamshell pop). */
  private securedLoot: HeistLootPayload = {
    he3CryoFlasks: 0,
    quantumCipherSlates: 0,
    superconductingCoils: 0,
  };
  /** Player anchor in the vault-car local frame while boarded. */
  private playerLocal: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  /** Tethered-autopilot engagement (engaged on boarding, released at escape). */
  private tetherActive = false;
  /** Last bailout exit velocity (world frame, m/s) — zero before the leap. */
  private lastBailoutVelocity: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  /** Last boarding-jump apex world point (catwalk deck + lift) — null pre-jump. */
  private lastBoardingApex: { x: number; y: number; z: number } | null = null;
  /** Spec 36 Phase 2: canister in the avatar's hands (null with hands free). */
  private carriedCargoType: HeistMoonCargoType | null = null;
  /** Spec 36 Phase 2: containers still clamped per roof cradle type. */
  private roofCargoRemaining: Record<HeistMoonCargoType, number> = {
    WATER_CRYO_CELL: ROOF_CARGO_DEFAULT_COUNT_PER_TYPE,
    LOX_CYLINDER: ROOF_CARGO_DEFAULT_COUNT_PER_TYPE,
    HE3_FLASK: ROOF_CARGO_DEFAULT_COUNT_PER_TYPE,
  };
  /** Player throw aim (world horizontal unit vector); null = auto-track buggy. */
  private cargoAimHeading: { x: number; y: number } | null = null;
  /** Resolved snapshot of the most recent throw (null before the first). */
  private lastCargoThrow: CargoThrowState | null = null;
  /** Canisters the buggy's magnetic hopper has taken this run. */
  private cargoCaughtCount = 0;
  /** Standard throw impulse (m/s) — constructor-sanitised. */
  private readonly throwSpeedMps: number;
  /** Whole containers clamped per roof cradle — constructor-sanitised. */
  private roofCradleStock: number;
  /** Last telemetry snapshot (HUD readback without re-evaluation). */
  private lastTelemetry: HeistTelemetry = this.buildTelemetry(0, 0, 0, 0, 0, false);

  private disposed = false;

  constructor(maglev: HighSpeedMaglev, citadel?: XCorpCitadel | null, options: Partial<TrainHeistOptions> = {}) {
    this.maglev = maglev;
    this.citadel = citadel ?? null;

    let maxRel = finiteOr(options.maxRelativeSpeedMps, MAX_RELATIVE_SPEED_MPS);
    let latMin = finiteOr(options.lateralBandMinM, BOARDING_LATERAL_MIN_M);
    let latMax = finiteOr(options.lateralBandMaxM, BOARDING_LATERAL_MAX_M);
    let lonMax = finiteOr(options.longitudinalMaxM, BOARDING_LONGITUDINAL_MAX_M);
    let hack = finiteOr(options.hackDurationS, VAULT_HACK_DURATION_S);
    let countdown = finiteOr(options.countdownS, DEPOT_COUNTDOWN_S);
    let tether = finiteOr(options.tetherStandoffM, TETHER_STANDBOFF_M);
    let bailout = finiteOr(options.bailoutLateralMps, BAILOUT_LATERAL_MPS);
    let deckL = finiteOr(options.vaultDeckLengthM, VAULT_DECK_LENGTH_M);
    let deckW = finiteOr(options.vaultDeckWidthM, VAULT_DECK_WIDTH_M);
    if (maxRel <= 0) maxRel = MAX_RELATIVE_SPEED_MPS;
    if (latMin < 0) latMin = BOARDING_LATERAL_MIN_M;
    if (latMax <= latMin) latMax = BOARDING_LATERAL_MAX_M;
    if (lonMax <= 0) lonMax = BOARDING_LONGITUDINAL_MAX_M;
    if (hack <= 0) hack = VAULT_HACK_DURATION_S;
    if (countdown <= 0) countdown = DEPOT_COUNTDOWN_S;
    if (tether <= 0) tether = TETHER_STANDBOFF_M;
    if (bailout <= 0) bailout = BAILOUT_LATERAL_MPS;
    if (deckL <= 0) deckL = VAULT_DECK_LENGTH_M;
    if (deckW <= 0) deckW = VAULT_DECK_WIDTH_M;
    this.maxRelativeSpeedMps = maxRel;
    this.lateralBandMinM = latMin;
    this.lateralBandMaxM = latMax;
    this.longitudinalMaxM = lonMax;
    this.hackDurationS = hack;
    this.countdownS = countdown;
    this.tetherStandoffM = tether;
    this.bailoutLateralMps = bailout;
    this.vaultDeckLengthM = deckL;
    this.vaultDeckWidthM = deckW;
    // Spec 36 Phase 2: standard throw impulse — anything outside the
    // [8.0, 14.0] canonical band (or non-finite) degrades to 10.0 m/s;
    // per-throw callers may still pin any in-band speed explicitly.
    const throwSpeed = finiteOr(options.throwSpeedMps, CARGO_THROW_STANDARD_MPS);
    this.throwSpeedMps =
      throwSpeed >= CARGO_THROW_MIN_MPS && throwSpeed <= CARGO_THROW_MAX_MPS
        ? throwSpeed
        : CARGO_THROW_STANDARD_MPS;
    // Roof cradle stock: clamped whole containers per type (QA harnesses
    // shrink it; a fresh run clamps the canonical pair of each commodity).
    this.roofCradleStock = clamp(
      Math.round(finiteOr(options.roofCargoPerType, ROOF_CARGO_DEFAULT_COUNT_PER_TYPE)),
      0,
      99,
    );
    this.roofCargoRemaining = {
      WATER_CRYO_CELL: this.roofCradleStock,
      LOX_CYLINDER: this.roofCradleStock,
      HE3_FLASK: this.roofCradleStock,
    };
    const loot = options.loot ?? {};
    // Spec 36 §3.1: volatile lines are carried ONLY when the table supplies
    // them — a canonical Spec 26 table stays exactly the legacy 3-key shape
    // (loot-payload serialization gates, cargo mass and counts unchanged).
    const volatileCount = (raw: number | undefined): number | null =>
      raw === undefined ? null : clamp(Math.round(finiteOr(raw, 0)), 0, 999);
    const water = volatileCount(loot.waterCryoCells);
    const lox = volatileCount(loot.loxCylinders);
    const he3Flask = volatileCount(loot.he3Flasks);
    this.lootTable = {
      he3CryoFlasks: clamp(Math.round(finiteOr(loot.he3CryoFlasks, LOOT_HE3_CRYO_FLASKS)), 0, 999),
      quantumCipherSlates: clamp(
        Math.round(finiteOr(loot.quantumCipherSlates, LOOT_QUANTUM_CIPHER_SLATES)),
        0,
        999,
      ),
      superconductingCoils: clamp(Math.round(finiteOr(loot.superconductingCoils, LOOT_SUPERCONDUCTING_COILS)), 0, 999),
      ...(water !== null ? { waterCryoCells: water } : {}),
      ...(lox !== null ? { loxCylinders: lox } : {}),
      ...(he3Flask !== null ? { he3Flasks: he3Flask } : {}),
    };
  }

  // -- phase drivers ---------------------------------------------------------------

  /**
   * Kick off "Operation Gilded Serpent": INACTIVE → INTERCEPTING. Returns
   * true when the transition happened (false in any other phase, before
   * init-independent readiness, or after dispose).
   */
  startHeist(): boolean {
    if (this.disposed || this.phase !== 'INACTIVE') return false;
    this.phase = 'INTERCEPTING';
    return true;
  }

  /**
   * One frame of the heist: re-evaluate the interception envelope against the
   * live vault car, advance the phase machine, drain the hack and depot
   * timers. NEVER advances the maglev (WorldScene renders the train).
   * Garbage dt (NaN / negative) is treated as a frozen frame — telemetry
   * still answers, no timers move, no transitions fire.
   */
  update(
    dt: number,
    roverPos: { x: number; y: number; z: number },
    roverVel: RoverVelocityLike,
    playerState?: PlayerStateLike,
  ): HeistTelemetry {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    const vault = this.vaultFrame();
    const rover = {
      x: finiteOr(roverPos?.x, 0),
      y: finiteOr(roverPos?.y, 0),
      z: finiteOr(roverPos?.z, 0),
    };
    const roverV = roverVelocityVector(roverVel, vault.tangent);

    // -- envelope -----------------------------------------------------------------
    const relV = {
      x: roverV.x - vault.velocity.x,
      y: roverV.y - vault.velocity.y,
      z: roverV.z - vault.velocity.z,
    };
    const relativeSpeed = Math.hypot(relV.x, relV.y, relV.z);
    const rRel = { x: rover.x - vault.position.x, y: rover.y - vault.position.y, z: rover.z - vault.position.z };
    const along = rRel.x * vault.tangent.x + rRel.y * vault.tangent.y + rRel.z * vault.tangent.z;
    const latVec = {
      x: rRel.x - along * vault.tangent.x,
      y: rRel.y - along * vault.tangent.y,
      z: rRel.z - along * vault.tangent.z,
    };
    const lateralDistance = Math.hypot(latVec.x, latVec.y, latVec.z);
    const longitudinalOffset = along;
    // Inclusive band semantics with an epsilon allowance: the spec's closed
    // interval [2.5, 5.5] must still contain the readout when a caller
    // positions the rover AT the boundary (hypot round-off lands 2.5 on
    // 2.4999999999999996).
    const canBoardRaw =
      relativeSpeed <= this.maxRelativeSpeedMps + 1e-9 &&
      lateralDistance >= this.lateralBandMinM - 1e-6 &&
      lateralDistance <= this.lateralBandMaxM + 1e-6 &&
      Math.abs(longitudinalOffset) <= this.longitudinalMaxM + 1e-6;
    let canBoard = canBoardRaw;

    // -- phase machine (blueprint §2.1) ---------------------------------------------
    if (step > 0) {
      switch (this.phase) {
        case 'INTERCEPTING':
          // Envelope in → BOARDING_WINDOW; fall out → back to INTERCEPTING.
          this.phase = canBoard ? 'BOARDING_WINDOW' : 'INTERCEPTING';
          break;
        case 'BOARDING_WINDOW':
          if (!canBoard) this.phase = 'INTERCEPTING';
          break;
        case 'ON_BOARD_CRACKING':
          // Deck locomotion (optional player-state local delta) stays inside
          // the car frame — world velocity is structurally zero here.
          this.applyLocalDeckDelta(playerState, step);
          break;
        case 'LOOT_SECURED':
          // The klaxon needs one frame to spool; the very next tick hands off
          // to the countdown where the clock drains.
          this.phase = 'DEPOT_COUNTDOWN';
          break;
        case 'DEPOT_COUNTDOWN': {
          this.countdownRemainingS = Math.max(0, this.countdownRemainingS - step);
          // Epsilon guard: repeated 1/60 drains land on 1e-13, not 0 — snap
          // so "T-0" is a real state, matching the hack timer rule.
          if (this.countdownRemainingS < 1e-9) this.countdownRemainingS = 0;
          const status = this.vaultPerimeterStatus();
          if (this.countdownRemainingS <= 0 || status.inShieldPerimeter) {
            this.fail();
          }
          break;
        }
        default:
          // INACTIVE / BAILOUT_SUCCESS / ESCAPE_COMPLETE / FAILED: frozen.
          break;
      }
    }
    // A boarding jump fired between frames with a stale envelope can never
    // leave the run unresolvable; canBoard only ever means "right now".
    if (this.phase === 'ON_BOARD_CRACKING' || this.phase === 'LOOT_SECURED') {
      canBoard = false;
    }

    this.lastTelemetry = this.buildTelemetry(
      relativeSpeed,
      lateralDistance,
      longitudinalOffset,
      this.hackElapsedS / this.hackDurationS,
      this.phase === 'LOOT_SECURED' || this.phase === 'DEPOT_COUNTDOWN' ? this.countdownRemainingS : 0,
      canBoard,
    );
    return this.lastTelemetry;
  }

  // -- boarding ----------------------------------------------------------------------

  /**
   * The High-Speed Jump (Spec 26 §3.3.1): leap from the rover cockpit onto
   * the vault car catwalk. Succeeds only while the envelope holds
   * (`canBoard`); engages the rover tethered-autopilot target, anchors the
   * player to the vault-car local frame, and returns true.
   */
  executeBoardingJump(): boolean {
    if (this.disposed) return false;
    if (this.phase !== 'INTERCEPTING' && this.phase !== 'BOARDING_WINDOW') return false;
    if (!this.lastTelemetry.canBoard) return false;
    this.phase = 'ON_BOARD_CRACKING';
    this.playerLocal = { x: 0, y: BAILOUT_DECK_HEIGHT_M, z: 0 };
    this.lastBoardingApex = transformPoint(
      { x: 0, y: BAILOUT_DECK_HEIGHT_M + BOARDING_APEX_HEIGHT_M, z: 0 },
      this.vaultFrame().babylonPosition,
      this.vaultFrame().rotationQuaternion,
    );
    this.tetherActive = true;
    return true;
  }

  // -- vault cracking -------------------------------------------------------------------

  /**
   * Hold-to-hack the roof Cyber-Lock (Spec 26 §3.3.3). Advances the bypass
   * timer by dt while ON_BOARD_CRACKING and returns true exactly on the
   * frame the clamshell pops: loot is granted (all six items), the alarm
   * arms the depot countdown at T-44.0 s, and the phase lands in
   * LOOT_SECURED (→ DEPOT_COUNTDOWN on the next tick). Always false in any
   * other phase or on a frozen frame.
   */
  interactVaultLock(dt: number): boolean {
    if (this.disposed || this.phase !== 'ON_BOARD_CRACKING') return false;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    if (step === 0) return false;
    this.hackElapsedS = Math.min(this.hackDurationS, this.hackElapsedS + step);
    // Epsilon guard: 60 × (1/60) accumulates to 9.999999999999998 — the pop
    // must land on the 6.000 s frame, not the 6.017 s one.
    if (this.hackElapsedS >= this.hackDurationS - 1e-9) {
      this.hackElapsedS = this.hackDurationS;
      this.securedLoot = { ...this.lootTable };
      this.countdownRemainingS = this.countdownS;
      this.phase = 'LOOT_SECURED';
      // Refresh the snapshot so getTelemetry() never lags the pop (loot,
      // countdown, phase all read current on the winning frame). The rover
      // reads are stale until the next update() tick — carry the current
      // train speed as the honest relative-speed placeholder.
      const t = this.vaultFrame();
      this.lastTelemetry = this.buildTelemetry(
        Math.hypot(t.velocity.x, t.velocity.y, t.velocity.z),
        this.lastTelemetry.lateralDistanceM,
        this.lastTelemetry.longitudinalOffsetM,
        this.hackElapsedS / this.hackDurationS,
        this.countdownRemainingS,
        false,
      );
      return true;
    }
    return false;
  }

  // -- Spec 36 Phase 2: active cargo pick-up, aim & ballistic throw --------------

  /**
   * True while the avatar holds an unclamped canister in the two-handed
   * carry stance (Spec 36 §3 Phase 2). False with hands free or disposed.
   */
  isCarryingCargo(): boolean {
    return this.carriedCargoType !== null && !this.disposed;
  }

  /** The carried container type (null with hands free). */
  getCarriedCargoType(): HeistMoonCargoType | null {
    return this.isCarryingCargo() ? this.carriedCargoType : null;
  }

  /** Containers still clamped per roof cradle type (copy). */
  getRoofCargoRemaining(): Record<HeistMoonCargoType, number> {
    return { ...this.roofCargoRemaining };
  }

  /**
   * Nearest stocked roof cradle within {@link CARGO_PICKUP_RADIUS_M} of the
   * player's deck anchor (horizontal catwalk distance). Answers null while
   * the hands are full, off the train, or nothing is in reach — drives the
   * `[E] / (X) Unclamp & Pick Up Cargo` prompt and the touch smart-button
   * verb.
   */
  nearestCargoPickup(): CargoPickupContact | null {
    if (this.disposed || !this.isPlayerOnBoard() || this.isCarryingCargo()) return null;
    const anchor = this.playerLocal;
    let best: CargoPickupContact | null = null;
    for (const type of HEIST_MOON_CARGO_TYPES) {
      if ((this.roofCargoRemaining[type] ?? 0) <= 0) continue;
      const cradle = ROOF_CARGO_CRADLES[type];
      const distanceM = Math.hypot(anchor.x - cradle.x, anchor.z - cradle.z);
      if (distanceM > CARGO_PICKUP_RADIUS_M + 1e-6) continue;
      if (best === null || distanceM < best.distanceM) {
        best = {
          cargoType: type,
          label: HEIST_MOON_CARGO[type].label,
          distanceM,
          worldPosition: this.localToWorld(cradle),
        };
      }
    }
    return best;
  }

  /**
   * `[E]` / `(X)` Unclamp & Pick Up Cargo (Spec 36 §3 Phase 2): pops the
   * clamp on the nearest stocked cradle and hands the container to the
   * avatar in the two-handed carry stance. Returns the picked container
   * type, or null when nothing was taken (off the train, hands full, no
   * cradle in reach, or cradle empty).
   */
  interactCargoPickUp(): HeistMoonCargoType | null {
    const contact = this.nearestCargoPickup();
    if (contact === null) return null;
    const remaining = this.roofCargoRemaining[contact.cargoType] ?? 0;
    if (remaining <= 0) return null;
    this.roofCargoRemaining[contact.cargoType] = remaining - 1;
    this.carriedCargoType = contact.cargoType;
    return contact.cargoType;
  }

  /**
   * Aim the next throw along a player heading — a world-frame horizontal
   * direction ({x, cos law of the avatar heading, e.g. {x: cos h, y: sin h}})
   * or an angle in radians. Degenerate / non-finite input is ignored (the
   * previous aim survives); `null` reverts to the default auto-track
   * bearing on the tethered buggy.
   */
  setCargoAimHeading(heading: { x: number; y: number } | number | null): void {
    if (heading === null) {
      this.cargoAimHeading = null;
      return;
    }
    if (typeof heading === 'number') {
      if (!Number.isFinite(heading)) return;
      this.cargoAimHeading = { x: Math.cos(heading), y: Math.sin(heading) };
      return;
    }
    const x = finiteOr(heading?.x, 0);
    const y = finiteOr(heading?.y, 0);
    const len = Math.hypot(x, y);
    if (!(len > 1e-6)) return;
    this.cargoAimHeading = { x: x / len, y: y / len };
  }

  /** Chest-height throw release point (world m) — null when off the train. */
  getCargoReleasePoint(): { x: number; y: number; z: number } | null {
    if (this.disposed || !this.isPlayerOnBoard()) return null;
    return this.localToWorld({
      x: this.playerLocal.x,
      y: this.playerLocal.y + CARGO_RELEASE_HEIGHT_M,
      z: this.playerLocal.z,
    });
  }

  /**
   * Pure vacuum throw solution (Spec 36 §2.1/§2.2) — no state, no side
   * effects:
   *
   *   v_cargo(0) = v_train + v_throw·(cos φ·û_aim + sin φ·k̂),  φ ≈ 25°
   *   r(t) = r₀ + v_cargo·t − ½·g·k̂·t²                        (C_d = 0)
   *
   * Because the tethered autopilot mirrors the train (v_buggy ≈ v_train),
   * the capture decision collapses into the MOVING FRAME exactly as §2.1
   * books it ("traverses the 4.5 m lateral gap in ≈ 0.45–0.55 s,
   * maintaining parallel forward velocity"): the canister's relative
   * ground track is q(τ) = d₀ + v_throw,horiz·τ, and the magnetic hopper
   * (§2.2, R_catch = 1.8 m with attractor damping that owns the vertical
   * settlement in Phase 3) takes the canister when the track's closest
   * approach to the bed centre sits inside the envelope within the capture
   * window. Null when off the train or the bed-plane crossing is
   * degenerate.
   */
  private solveCargoThrow(
    throwSpeedMps: number,
  ): Omit<CargoThrowState, 'cargoType' | 'label'> | null {
    const releasePoint = this.getCargoReleasePoint();
    if (releasePoint === null) return null;
    const vault = this.vaultFrame();
    const tether = this.getTetheredRoverTargetPos();
    const bedCentre = { x: tether.x, y: tether.y, z: tether.z + BUGGY_BED_CENTRE_HEIGHT_M };
    // Aim heading: the player's bearing, falling back to the auto-track
    // release→buggy direction; a degenerate guideway falls back to starboard.
    let aim = this.cargoAimHeading;
    if (aim === null) {
      const ax = bedCentre.x - releasePoint.x;
      const ay = bedCentre.y - releasePoint.y;
      const al = Math.hypot(ax, ay);
      aim = al > 1e-6 ? { x: ax / al, y: ay / al } : { x: vault.tangent.y, y: -vault.tangent.x };
    }
    const cosPhi = Math.cos(CARGO_THROW_PITCH_RAD);
    const sinPhi = Math.sin(CARGO_THROW_PITCH_RAD);
    const launchVelocity = {
      x: vault.velocity.x + throwSpeedMps * cosPhi * aim.x,
      y: vault.velocity.y + throwSpeedMps * cosPhi * aim.y,
      z: vault.velocity.z + throwSpeedMps * sinPhi,
    };
    // Bed-plane crossing of the vacuum arc: (g/2)t² − v_z t + (z_bed − z₀) = 0,
    // positive root of the descending branch.
    const g = LUNAR_GRAVITY;
    const dz = releasePoint.z - bedCentre.z;
    const disc = launchVelocity.z * launchVelocity.z + 2 * g * dz;
    if (!(disc >= 0)) return null;
    const flightTimeS = (launchVelocity.z + Math.sqrt(disc)) / g;
    if (!(flightTimeS > 0) || !Number.isFinite(flightTimeS)) return null;
    // Moving-frame ground track: d(τ) = d₀ + w·τ with d₀ = release − bed and
    // w = v_cargo − v_buggy = the horizontal throw component (parallel frame).
    const d0 = { x: releasePoint.x - bedCentre.x, y: releasePoint.y - bedCentre.y };
    const w = { x: throwSpeedMps * cosPhi * aim.x, y: throwSpeedMps * cosPhi * aim.y };
    const wSq = w.x * w.x + w.y * w.y;
    const gapCrossTimeS = wSq > 1e-12 ? Math.max(0, -(d0.x * w.x + d0.y * w.y) / wSq) : 0;
    const qx = d0.x + w.x * gapCrossTimeS;
    const qy = d0.y + w.y * gapCrossTimeS;
    const missDistanceM = Math.hypot(qx, qy);
    const caught = missDistanceM <= CARGO_CATCH_RADIUS_M && gapCrossTimeS <= CARGO_CAPTURE_WINDOW_S;
    // Predicted intercept on the bed plane along the full vacuum arc.
    const interceptPoint = {
      x: releasePoint.x + launchVelocity.x * flightTimeS,
      y: releasePoint.y + launchVelocity.y * flightTimeS,
      z: bedCentre.z,
    };
    if (!Number.isFinite(interceptPoint.x) || !Number.isFinite(interceptPoint.y)) return null;
    return {
      releasePoint,
      launchVelocity,
      flightTimeS,
      gapCrossTimeS,
      missDistanceM,
      interceptPoint,
      caught,
    };
  }

  /**
   * Predictive throw aim for the HUD lead reticle (Spec 36 §3 Phase 2):
   * the intercept bearing, moving-frame gap-cross time and miss distance
   * the throw would take at the STANDARD impulse from the current stance.
   * Null with hands free or off the train.
   */
  getCargoThrowAim(): CargoAimTelemetry | null {
    const carried = this.getCarriedCargoType();
    if (carried === null) return null;
    const solved = this.solveCargoThrow(this.throwSpeedMps);
    if (solved === null) return null;
    const dxa = solved.interceptPoint.x - solved.releasePoint.x;
    const dya = solved.interceptPoint.y - solved.releasePoint.y;
    return {
      carriedCargoType: carried,
      label: HEIST_MOON_CARGO[carried].label,
      throwSpeedMps: this.throwSpeedMps,
      aimAzimuthDeg: (Math.atan2(dya, dxa) * 180) / Math.PI,
      gapCrossTimeS: solved.gapCrossTimeS,
      missDistanceM: solved.missDistanceM,
      interceptPoint: solved.interceptPoint,
      willCatch: solved.caught,
    };
  }

  /**
   * The ballistic cargo throw (Spec 36 §2.1): releases the carried canister
   * with v_cargo = v_train + v_throw (impulse clamped to [8.0, 14.0] m/s,
   * default 10.0, at the ≈25° pitch elevation along the current aim
   * heading). The moving-frame capture arbiter (blueprint "Physical Capture
   * & Ballistic Envelopes") credits the buggy's magnetic hopper on a clean
   * gap cross — the secured canister lands on the payload's moon-volatile
   * line and counts toward stolen cargo. Returns the resolved throw state,
   * or null when nothing was released (hands free or off the train).
   */
  executeCargoThrow(throwSpeedMps?: number): CargoThrowState | null {
    const carried = this.getCarriedCargoType();
    if (carried === null) return null;
    let speed = finiteOr(throwSpeedMps, this.throwSpeedMps);
    speed = clamp(speed, CARGO_THROW_MIN_MPS, CARGO_THROW_MAX_MPS);
    const solved = this.solveCargoThrow(speed);
    if (solved === null) return null;
    // The hands leave the canister behind either way.
    this.carriedCargoType = null;
    if (solved.caught) this.creditCaughtCargo(carried);
    const state: CargoThrowState = {
      cargoType: carried,
      label: HEIST_MOON_CARGO[carried].label,
      ...solved,
    };
    this.lastCargoThrow = state;
    return { ...state };
  }

  /** Credit one magnetically-caught canister to the payload's moon line. */
  private creditCaughtCargo(type: HeistMoonCargoType): void {
    const p = this.securedLoot;
    switch (type) {
      case 'WATER_CRYO_CELL':
        p.waterCryoCells = positiveCount(p.waterCryoCells) + 1;
        break;
      case 'LOX_CYLINDER':
        p.loxCylinders = positiveCount(p.loxCylinders) + 1;
        break;
      case 'HE3_FLASK':
        // Physical flask REPLACES the legacy cryo-flask line (same vessel) —
        // credit on top of the post-replacement read so nothing double-counts.
        p.he3Flasks = he3FlaskCount(p) + 1;
        break;
    }
    this.cargoCaughtCount += 1;
  }

  /** Resolved snapshot of the most recent throw (null before the first). */
  getLastCargoThrow(): CargoThrowState | null {
    return this.lastCargoThrow === null ? null : { ...this.lastCargoThrow };
  }

  /** Canisters the buggy's magnetic hopper has taken this run. */
  getCargoCaughtCount(): number {
    return this.cargoCaughtCount;
  }

  // -- bailout & escape --------------------------------------------------------------------

  /**
   * The Leap of Faith (Spec 26 §3.3.4): launch off the catwalk during the
   * depot countdown with v_exit = v_train + v_lateral (lateral = starboard,
   * away from the guideway). Records the exit velocity for the ballistic
   * landing solver and transitions to BAILOUT_SUCCESS. Returns false when
   * the player is not on the train inside the escape window.
   */
  executeBailoutJump(): boolean {
    if (this.disposed) return false;
    if (this.phase !== 'DEPOT_COUNTDOWN') return false;
    const vault = this.vaultFrame();
    // Starboard unit (right of heading) in the world frame: r = T̂ × ẑ.
    const rx = vault.tangent.y;
    const ry = -vault.tangent.x;
    const rl = Math.hypot(rx, ry) || 1;
    this.lastBailoutVelocity = {
      x: vault.velocity.x + (rx / rl) * this.bailoutLateralMps,
      y: vault.velocity.y + (ry / rl) * this.bailoutLateralMps,
      z: vault.velocity.z,
    };
    this.phase = 'BAILOUT_SUCCESS';
    return true;
  }

  /**
   * Hand the run off to Phase 4's delivery stage: BAILOUT_SUCCESS →
   * ESCAPE_COMPLETE releases the rover tether (the autopilot parks the
   * rover beside the maintenance road; the player climbs in and rides to
   * RustBelt). Returns true when the transition happened.
   */
  finishEscape(): boolean {
    if (this.disposed || this.phase !== 'BAILOUT_SUCCESS') return false;
    this.phase = 'ESCAPE_COMPLETE';
    this.tetherActive = false;
    return true;
  }

  /** Force the terminal FAILED state (countdown expiry / shield contact). */
  private fail(): void {
    this.phase = 'FAILED';
    this.tetherActive = false;
  }

  // -- relative platform kinematics (blueprint §3.1 / §3.2) -----------------------------

  /** Vault car world-frame frame of reference: position, tangent, velocity. */
  private vaultFrame(): {
    position: { x: number; y: number; z: number };
    /** Unit forward tangent of the guideway at the vault car (world frame). */
    tangent: { x: number; y: number; z: number };
    /** v_train = speed · T̂ (world frame, m/s). */
    velocity: { x: number; y: number; z: number };
    /** Babylon-frame car origin (for local→world point transforms). */
    babylonPosition: Vector3;
    rotationQuaternion: Quaternion;
  } {
    const vault = this.maglev.getVaultCarState();
    const transform = this.maglev.getVaultCarTransform();
    const position = vault?.worldPosition ?? { x: 0, y: 0, z: 0 };
    const tangent = vault?.worldForward ?? { x: 1, y: 0, z: 0 };
    const speed = vault?.speedMps ?? 0;
    return {
      position,
      tangent,
      velocity: { x: tangent.x * speed, y: tangent.y * speed, z: tangent.z * speed },
      babylonPosition: transform.position,
      rotationQuaternion: transform.rotationQuaternion,
    };
  }

  /**
   * The vault car world transform (Babylon frame) — the M_vault of
   * P_world = M_vault · P_local. Pass-through to the maglev so quests/HUD
   * never hold the maglev reference themselves.
   */
  getVaultCarTransform(): { position: Vector3; rotationQuaternion: Quaternion } {
    return this.maglev.getVaultCarTransform();
  }

  /**
   * Map a point in the vault-car local frame (forward +z, up +y, right-
   * handed, deck bounds ±L/2 × ±W/2) to world metres via
   * P_world = M_vault · P_local. Points outside the deck clamp onto the deck
   * edge — the avatar never leaves the car by arithmetic.
   */
  localToWorld(local: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const halfL = this.vaultDeckLengthM / 2;
    const halfW = this.vaultDeckWidthM / 2;
    const localClamped = {
      x: clamp(finiteOr(local?.x, 0), -halfW, halfW),
      y: finiteOr(local?.y, 0),
      z: clamp(finiteOr(local?.z, 0), -halfL, halfL),
    };
    const t = this.vaultFrame();
    return transformPoint(localClamped, t.babylonPosition, t.rotationQuaternion);
  }

  /**
   * Deck-bounds clamp in the vault-car local frame (no transform): the
   * locomotion law applies ΔP_local freely then snaps back inside
   * ±L/2 × ±W/2 so deck traversal has walls, not a void.
   */
  clampLocalToDeck(local: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const halfL = this.vaultDeckLengthM / 2;
    const halfW = this.vaultDeckWidthM / 2;
    return {
      x: clamp(finiteOr(local?.x, 0), -halfW, halfW),
      y: finiteOr(local?.y, 0),
      z: clamp(finiteOr(local?.z, 0), -halfL, halfL),
    };
  }

  /** Apply a {x, y, dz} local-frame displacement from an injected player state. */
  private applyLocalDeckDelta(playerState: PlayerStateLike, step: number): void {
    if (playerState === null || playerState === undefined || typeof playerState !== 'object') return;
    const ps = playerState as { x?: number; y?: number; dz?: number };
    const next = this.clampLocalToDeck({
      x: this.playerLocal.x + finiteOr(ps.x, 0) * step,
      y: this.playerLocal.y,
      z: this.playerLocal.z + finiteOr(ps.dz, 0) * step,
    });
    this.playerLocal = next;
  }

  /** Player anchor in the vault-car local frame (zero before boarding). */
  getPlayerLocalPos(): { x: number; y: number; z: number } {
    return { ...this.playerLocal };
  }

  /** Player anchor in world metres via P_world = M_vault · P_local. */
  getPlayerWorldPos(): { x: number; y: number; z: number } {
    return this.localToWorld(this.playerLocal);
  }

  /** True while the avatar is riding the car (crack, secured, or countdown). */
  isPlayerOnBoard(): boolean {
    return (
      this.phase === 'ON_BOARD_CRACKING' ||
      this.phase === 'LOOT_SECURED' ||
      this.phase === 'DEPOT_COUNTDOWN'
    );
  }

  /** Last boarding-jump apex world point (null before the jump). */
  getLastBoardingApex(): { x: number; y: number; z: number } | null {
    return this.lastBoardingApex === null ? null : { ...this.lastBoardingApex };
  }

  // -- rover tethered autopilot (Spec 26 §3.3.1) -------------------------------------------

  /** True from the boarding jump until the escape completes (or fails). */
  isAutopilotTetherActive(): boolean {
    return this.tetherActive && !this.disposed;
  }

  /**
   * The autopilot target: a point {@link TETHER_STANDBOFF_M} starboard of
   * the guideway on the maintenance service road at the vault car's current
   * station, recomputed every call so the rover parallels the train and
   * waits at the railhead for the bailout extraction. Answers from the
   * maglev's pure spline math even after the heist ends (the extraction
   * stage still needs it); returns the vault centre only for a degenerate
   * maglev with no spline answer.
   */
  getTetheredRoverTargetPos(): { x: number; y: number; z: number } {
    const vault = this.maglev.getVaultCarState();
    if (vault === null) {
      return { ...this.maglev.getPointAtDistance(0) };
    }
    const road = this.maglev.getServiceRoadPointAtDistance(vault.distanceAlongSplineM);
    // Service road centre sits 4.0 m starboard; nudge the standoff to 4.5 m
    // along the same starboard ray from the guideway centreline.
    const track = this.maglev.getPointAtDistance(vault.distanceAlongSplineM);
    const dx = road.x - track.x;
    const dy = road.y - track.y;
    const dl = Math.hypot(dx, dy) || 1;
    const scale = this.tetherStandoffM / dl;
    return {
      x: track.x + dx * scale,
      y: track.y + dy * scale,
      z: road.z,
    };
  }

  // -- loot & countdown readouts -------------------------------------------------------------

  /** Secured loot payload (all zeros before the clamshell pops). */
  getLootPayload(): HeistLootPayload {
    return { ...this.securedLoot };
  }

  /** Total secured item count (0 before, 6 with the full canonical table;
   *  Spec 36 volatile lines count on top, He-3 folds the legacy line). */
  getStolenCargoCount(): number {
    const p = this.securedLoot;
    return (
      p.quantumCipherSlates +
      p.superconductingCoils +
      heistMoonCargoCount(p, 'WATER_CRYO_CELL') +
      heistMoonCargoCount(p, 'LOX_CYLINDER') +
      heistMoonCargoCount(p, 'HE3_FLASK')
    );
  }

  /** The configured loot table (what a successful crack yields). */
  getLootTable(): HeistLootPayload {
    return { ...this.lootTable };
  }

  /** Depot countdown remaining (s) — 0 until LOOT_SECURED arms it. */
  getCountdownRemainingS(): number {
    return this.countdownRemainingS;
  }

  /** True once the alarm armed the countdown and it is under 30 s (red banners). */
  isBailoutUrgent(): boolean {
    return (
      (this.phase === 'LOOT_SECURED' || this.phase === 'DEPOT_COUNTDOWN') &&
      this.countdownRemainingS <= BAILOUT_WARNING_S
    );
  }

  /** Mag-Lock bypass progress 0…1. */
  getHackProgress(): number {
    return this.hackElapsedS / this.hackDurationS;
  }

  /** Last bailout exit velocity (world frame, m/s) — zero before the leap. */
  getBailoutExitVelocity(): { x: number; y: number; z: number } {
    return { ...this.lastBailoutVelocity };
  }

  /** Current phase (blueprint §2.1 machine). */
  getPhase(): HeistPhase {
    return this.phase;
  }

  /** Last telemetry snapshot (no re-evaluation). */
  getTelemetry(): HeistTelemetry {
    return this.lastTelemetry;
  }

  /** Perimeter evaluation of the vault car against the Citadel defense rings. */
  private vaultPerimeterStatus(): { inShieldPerimeter: boolean; distanceM: number } {
    if (this.citadel === null || this.disposed) {
      return { inShieldPerimeter: false, distanceM: Infinity };
    }
    const vault = this.maglev.getVaultCarState();
    if (vault === null) return { inShieldPerimeter: false, distanceM: Infinity };
    const status = this.citadel.getPerimeterStatus(vault.worldPosition);
    return { inShieldPerimeter: status.inShieldPerimeter, distanceM: status.distanceM };
  }

  // -- lifecycle -----------------------------------------------------------------------------

  /**
   * Full reset to a pristine INACTIVE run (timers, loot, tether, anchors).
   * Answers after dispose too (state-only; the director holds no meshes).
   */
  reset(): void {
    this.phase = 'INACTIVE';
    this.hackElapsedS = 0;
    this.countdownRemainingS = 0;
    this.securedLoot = { he3CryoFlasks: 0, quantumCipherSlates: 0, superconductingCoils: 0 };
    this.playerLocal = { x: 0, y: 0, z: 0 };
    this.tetherActive = false;
    this.lastBailoutVelocity = { x: 0, y: 0, z: 0 };
    this.lastBoardingApex = null;
    // Spec 36 Phase 2: hands free, cradles re-clamped, throw bookkeeping cold.
    this.carriedCargoType = null;
    this.roofCargoRemaining = {
      WATER_CRYO_CELL: this.roofCradleStock,
      LOX_CYLINDER: this.roofCradleStock,
      HE3_FLASK: this.roofCradleStock,
    };
    this.cargoAimHeading = null;
    this.lastCargoThrow = null;
    this.cargoCaughtCount = 0;
  }

  /** Tear down: reset state and drop references. The director owns no meshes. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
  }

  /** True after `dispose()` — every query still answers, every driver refuses. */
  isDisposed(): boolean {
    return this.disposed;
  }

  // -- telemetry builder -----------------------------------------------------------------------

  private buildTelemetry(
    relativeSpeedMps: number,
    lateralDistanceM: number,
    longitudinalOffsetM: number,
    hackProgressFraction: number,
    countdownRemainingS: number,
    canBoard: boolean,
  ): HeistTelemetry {
    // Spec 36 Phase 2: throw aim readback rides every frame — null with
    // hands free, solved once per build otherwise (pure, cheap).
    const cargoAim = this.getCargoThrowAim();
    return {
      phase: this.phase,
      relativeSpeedMps,
      lateralDistanceM,
      longitudinalOffsetM,
      canBoard,
      hackProgressFraction: clamp(hackProgressFraction, 0, 1),
      countdownRemainingS,
      stolenCargoCount: this.getStolenCargoCount(),
      carryingCargo: this.isCarryingCargo(),
      carriedCargoType: this.getCarriedCargoType(),
      cargoCaughtCount: this.cargoCaughtCount,
      cargoAim,
    };
  }
}
