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
 *    v_exit = v_train + v_lateral (Spec 26 §3.3.3–§3.3.4).
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
 * Spec 26 Phase 4: per-item cargo mass of the vault loot (kg). The siphon
 * hands the secured payload to the player's carrier (suit backpack, then
 * buggy flatbed) at the clamshell pop — the full canonical 3/1/2 table
 * weighs 3×4.0 + 1×1.0 + 2×5.5 = 24 kg.
 */
export const HEIST_LOOT_UNIT_MASS_KG = {
  he3CryoFlask: 4.0,
  quantumCipherSlate: 1.0,
  superconductingCoil: 5.5,
} as const;

/** Total cargo mass (kg) of a loot payload; NaN/negative counts read 0. */
export function heistLootCargoKg(payload: Partial<HeistLootPayload> | null | undefined): number {
  if (payload === null || payload === undefined) return 0;
  const k = (v: number | undefined): number => (Number.isFinite(v) && (v as number) > 0 ? (v as number) : 0);
  return (
    k(payload.he3CryoFlasks) * HEIST_LOOT_UNIT_MASS_KG.he3CryoFlask +
    k(payload.quantumCipherSlates) * HEIST_LOOT_UNIT_MASS_KG.quantumCipherSlate +
    k(payload.superconductingCoils) * HEIST_LOOT_UNIT_MASS_KG.superconductingCoil
  );
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
}

/** The Cyber-Lock container payload (Spec 26 §3.3.3). */
export interface HeistLootPayload {
  he3CryoFlasks: number;
  quantumCipherSlates: number;
  superconductingCoils: number;
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
    const loot = options.loot ?? {};
    this.lootTable = {
      he3CryoFlasks: clamp(Math.round(finiteOr(loot.he3CryoFlasks, LOOT_HE3_CRYO_FLASKS)), 0, 999),
      quantumCipherSlates: clamp(
        Math.round(finiteOr(loot.quantumCipherSlates, LOOT_QUANTUM_CIPHER_SLATES)),
        0,
        999,
      ),
      superconductingCoils: clamp(Math.round(finiteOr(loot.superconductingCoils, LOOT_SUPERCONDUCTING_COILS)), 0, 999),
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

  /** Total secured item count (0 before, 6 with the full canonical table). */
  getStolenCargoCount(): number {
    return (
      this.securedLoot.he3CryoFlasks +
      this.securedLoot.quantumCipherSlates +
      this.securedLoot.superconductingCoils
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
    return {
      phase: this.phase,
      relativeSpeedMps,
      lateralDistanceM,
      longitudinalOffsetM,
      canBoard,
      hackProgressFraction: clamp(hackProgressFraction, 0, 1),
      countdownRemainingS,
      stolenCargoCount: this.getStolenCargoCount(),
    };
  }
}
