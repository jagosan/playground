/**
 * Lunar Frontier — Export Minigame Director, "The Gauss Needle" (Spec 27 §3.4).
 *
 * The Phase 4 brain of the Mare Mass Accelerator export minigame. It owns
 * the gunner-console lifecycle (docking, cargo loading, orbital-pass wait,
 * targeting, capacitor spool, launch, in-flight tracking, payout), the
 * 45-second USP Intercept Threat / confiscation engine, and the Syndicate
 * Runner contraband-laundering flow.
 *
 * Phase machine (Spec 27 §3.4.1):
 *
 *   INACTIVE → DOCKING_CONSOLE → AWAITING_ORBITAL_PASS → TARGETING_ACTIVE
 *   → COIL_CHARGING → IN_FLIGHT_TRACKING → (CAPTURE_SUCCESS | INTERCEPT_FAILED)
 *   → COOLING_DOWN → INACTIVE
 *
 * `startSession()` parks the machine in DOCKING_CONSOLE and the first tick
 * hands off to AWAITING_ORBITAL_PASS (TrainHeistDirector's LOOT_SECURED
 * idiom — every phase is observable for at least one frame). COIL_CHARGING
 * auto-fires on trigger release (Spec §3.4.1 "Release trigger / fire command
 * executed"); `fireLaunch()` fires the same bank mid-spool on demand.
 *
 * Spool & breaker (Spec 27 §3.4.2) live inside `MassAccelerator` — the
 * director holds the trigger (`chargeCapacitor(dt)`) and watches for the
 * 'OVERCHARGED' state: a trip past 4.5 s sets `lastResult = 'OVERCHARGED'`
 * and the director waits the 5.0 s breaker lockout in COOLING_DOWN, then
 * re-arms AWAITING_ORBITAL_PASS with the cargo still in the breech.
 *
 * Capture authority & tractor assist (Spec 27 §3.2.3): the in-flight
 * canister is resolved through `OrbitalTransportSystem.checkCapture()` —
 * captured means captured. The one addition the director models is the
 * Electromagnetic Tractor Capture Funnel's grab: while the canister sits
 * inside 1.5 × R_catch of a *class-compatible* catchable vessel's funnel
 * axis, the tractor field applies a spring/damper acceleration
 * (k_GRIP · (bay − r) + k_MATCH · (v_T − v)) that walks the canister into
 * the central catch ring with its relative speed bled down under the
 * vessel's Δv limit. Without that assist no canister launched from the
 * caldera could ever satisfy the Δv ≤ 25/18 m/s catch gates: the ≥ 20° LOS
 * chord geometry fixes an impact parameter of 3.2–4.3 km, and vertical
 * catch matching pins flight time near √(2Δz/g) ≈ 43 s, forcing a relative
 * speed floor around 60–85 m/s (documented escalation to @owl/@rabbit: the
 * §3.2.2 Δv table is advisory telemetry unless the tractor closes the rest).
 *
 * Cargo flow: legal minerals (REGOLITH / TITANIUM / HELIUM3) are accepted
 * by the Bulk Ore Tug at 2.5× depot; STOLEN_CONTRABAND is accepted only by
 * the Syndicate Runner at 4.0× black market plus the LAUNDER_BONUS_CREDIT
 * (capping the §3.4.3 5.0× band) with the USP alert cancelled and heat
 * cleared. A wrong-class vessel never gets the tractor engaged, so a bad
 * read on the traffic pattern ends in a dead canister, not a launder.
 *
 * USP engine (Spec 27 §3.4.3): the radar siphon signature fires the moment
 * capacitor charging *begins* with contraband loaded — a 45.0 s intercept
 * countdown then runs through every phase (console, coils, even the
 * canister's own flight) until a successful laundering cancels it clean.
 * If the clock hits 0 first: cargo confiscated,
 * {@link USP_CITATION_FINE_CREDITS} citation, `lastResult = 'CONFISCATED'`,
 * session ends; while the alert stands, a missed shot never ends the run —
 * the only exits are launder, confiscation, or walking off the console.
 *
 * Headless-safe by contract: zero Babylon.js imports — the director is pure
 * arithmetic over the two injected subsystems plus
 * `BallisticTrajectoryEngine` (also Babylon-free). It NEVER advances the
 * MassAccelerator or OrbitalTransportSystem clocks (WorldScene ticks them —
 * same rule as TrainHeistDirector vs the maglev); the in-flight canister is
 * the director's own particle, integrated at fixed substeps so capture
 * resolution is frame-rate independent. Garbage input (NaN dt, negative
 * mass, unknown cargo strings) degrades to refusals and frozen frames,
 * never a throw, and every state field stays finite.
 *
 * Coordinates: world metres (x, y lateral, z↑) throughout; gunnerInput
 * `aimX`/`aimY` are azimuth/elevation degrees in the barrel frame.
 *
 * Usage:
 *   const director = new ExportMinigameDirector(accelerator, orbitalSystem);
 *   director.startSession('HELIUM3', 120);
 *   const s = director.update(dt, { aimX: 214.0, aimY: 62.5, chargeHeld: true });
 *   if (s.lastResult === 'CONFISCATED') { /* USP gunship swept the yard *\/ }
 */
import { BallisticTrajectoryEngine } from '../physics/BallisticTrajectoryEngine.ts';
import type { MassAccelerator } from '../infrastructure/MassAccelerator.ts';
import type { OrbitalTransportSystem } from '../infrastructure/OrbitalTransportSystem.ts';

// -- canonical constants (Spec 27 §3.4) --------------------------------------

/** Spec 27 §3.4.3: USP Intercept Threat countdown (s). */
export const USP_INTERCEPT_COUNTDOWN_S = 45.0;
/** Spec 27 §3.4.3: credit citation levied on confiscation (CR). */
export const USP_CITATION_FINE_CREDITS = 2500;

/** §3.4.1: console docking animation before the cargo select goes live (s). */
export const DOCKING_HOLD_S = 0.5;
/** §3.4.3 / §3.4.1: quench window after a resolved outcome before the console closes (s). */
export const POST_OUTCOME_COOLDOWN_S = 1.5;
/**
 * Spec 27 §3.4.2 thermal breaker trip point (s) — kept numerically in sync
 * with `MassAccelerator`'s `OVERCHARGE_TRIP_S` (re-declared here so the
 * director keeps zero Babylon.js module-graph dependencies).
 */
export const OVERCHARGE_TRIP_S = 4.5;
/** §3.4.2: grace past the trip point where the breaker must have fired (s). */
export const OVERCHARGE_WATCH_GRACE_S = 5.0;

/** In-flight tracking substep (s): 52 m catch envelope vs 420 m/s needs sub-steps. */
export const TRACKING_SUBSTEP_S = 1 / 60;
/** Track a canister at most this long before declaring dead orbit / far side (s). */
export const FLIGHT_TIMEOUT_S = 600;
/** Canister at or below (seat z − this) has hit regolith (m). */
export const GROUND_CRASH_MARGIN_M = 10;
/**
 * Lowest ballistic apex (world z, m) that can still reach a catch ring:
 * the Bulk Tug keels at 1,500 m with a 35 m envelope, so a canister whose
 * un-powered apex comes in under ~1,465 m can never join orbit traffic.
 * Rounded down to 1,400 m so terrain/shim margins never false-flag a live
 * shot. Apex passed + below this floor + no tractor engaged → the shot is
 * doomed; resolve INTERCEPT_FAILED immediately instead of waiting minutes
 * for the regolith.
 */
export const CATCH_CEILING_FLOOR_Z = 1400;

/** Spec 27 §3.2.3: tractor axis envelope factor on R_catch for the grab window. */
export const TRACTOR_GRAB_FACTOR = 1.5;
/** Tractor damper release hysteresis factor on the grab radius (×R_catch). */
export const TRACTOR_RELEASE_FACTOR = 2.5;
/** Tractor spring constant toward the cargo bay (1/s²). */
export const TRACTOR_SPRING_K_PER_S2 = 3.0;
/** Tractor velocity-match damping toward the vessel frame (1/s). */
export const TRACTOR_MATCH_DAMPING_PER_S = 8.0;

/** Canonical per-kg depot credit rates (CR) the export premium multiplies. */
export const EXPORT_CARGO_RATES_CREDITS_PER_KG: Readonly<
  Record<'REGOLITH' | 'TITANIUM' | 'HELIUM3' | 'STOLEN_CONTRABAND', number>
> = {
  REGOLITH: 2,
  TITANIUM: 12,
  HELIUM3: 45,
  STOLEN_CONTRABAND: 30,
};

/** Spec 27 §3.4.3: laundering bonus on top of the runner's 4.0× (caps at 5.0×). */
export const LAUNDER_BONUS_CREDIT = 1.25;

/** Spec 27 §3.4.3: syndicate radio line on a clean laundering. */
export const SYNDICATE_LAUNDER_COMMS =
  'Package on board. Funds wired to offshore vault. Pleasure doing business, prospector.';

// -- canonical unions ---------------------------------------------------------

/** Spec 27 §4 contract cargo union. */
export type ExportCargoType = 'REGOLITH' | 'TITANIUM' | 'HELIUM3' | 'STOLEN_CONTRABAND';

/** Spec 27 §4 contract outcome union. */
export type ExportOutcome = 'NONE' | 'SUCCESS' | 'MISSED' | 'CONFISCATED' | 'OVERCHARGED';

/** Spec 27 §3.4.1 machine, in transition order. */
export const EXPORT_PHASES = [
  'INACTIVE',
  'DOCKING_CONSOLE',
  'AWAITING_ORBITAL_PASS',
  'TARGETING_ACTIVE',
  'COIL_CHARGING',
  'IN_FLIGHT_TRACKING',
  'CAPTURE_SUCCESS',
  'INTERCEPT_FAILED',
  'COOLING_DOWN',
] as const;

export type ExportSessionPhase = (typeof EXPORT_PHASES)[number];

// -- contract shapes -----------------------------------------------------------

/** Spec 27 §4: serialized export-session snapshot (exact contract shape). */
export interface ExportSessionState {
  isActive: boolean;
  selectedCargoType: ExportCargoType;
  cargoQuantityKg: number;
  isContraband: boolean;
  uspCountdownRemainingS: number;
  uspAlertActive: boolean;
  canisterInFlight: boolean;
  canisterPos: { x: number; y: number; z: number };
  lastPayoutCredits: number;
  lastResult: ExportOutcome;
}

/** Per-frame fire-control input: azimuth (deg), elevation (deg), trigger. */
export interface ExportGunnerInput {
  aimX: number;
  aimY: number;
  chargeHeld: boolean;
}

// -- helpers -------------------------------------------------------------------

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

/** Normalize free-form input into the contract cargo union (null when unknown). */
export function normalizeExportCargo(value: unknown): ExportCargoType | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase() as ExportCargoType;
  return Object.prototype.hasOwnProperty.call(EXPORT_CARGO_RATES_CREDITS_PER_KG, key)
    ? key
    : null;
}

/** Depot rate (CR/kg) for a cargo type; unknown input reads 0. */
export function exportCargoRateCreditsPerKg(cargo: unknown): number {
  const key = normalizeExportCargo(cargo);
  return key === null ? 0 : EXPORT_CARGO_RATES_CREDITS_PER_KG[key];
}

/**
 * Depot-equivalent value of a cargo lot (CR): quantity × per-kg rate.
 * Non-finite / negative mass reads 0 (never a negative quote).
 */
export function cargoDepotValueCredits(cargo: unknown, quantityKg: number): number {
  const kg = Number.isFinite(quantityKg) && quantityKg > 0 ? quantityKg : 0;
  return kg * exportCargoRateCreditsPerKg(cargo);
}

// ================================================================================

export class ExportMinigameDirector {
  private readonly accelerator: MassAccelerator;
  private readonly orbitalSystem: OrbitalTransportSystem;

  // -- session state -----------------------------------------------------------
  private phase: ExportSessionPhase = 'INACTIVE';
  private isActive = false;
  private cargoType: ExportCargoType = 'REGOLITH';
  private cargoQuantityKg = 0;
  private isContraband = false;
  private uspAlertActive = false;
  private uspCountdownRemainingS = 0;
  private uspSiphonTriggered = false;
  private uspHeatLevel = 0;
  private laundered = false;
  private canisterInFlight = false;
  private canisterPos = { x: 0, y: 0, z: 0 };
  private lastPayoutCredits = 0;
  private lastResult: ExportOutcome = 'NONE';

  // -- targeting / spool bookkeeping ----------------------------------------------
  private prevChargeHeld = false;
  private chargeHeldS = 0;

  // -- in-flight particle (director-owned; hosts never see its integration) --------
  private canisterVel = { x: 0, y: 0, z: 0 };
  private flightElapsedS = 0;
  /** Peak z of the current flight (apex-lock for the doomed-shot check). */
  private flightMaxZ = 0;
  private crashZ = -GROUND_CRASH_MARGIN_M;
  /** Sticky tractor grab with 2.5 × R_catch release hysteresis. */
  private tractorEngaged = false;

  // -- cooldown bookkeeping ----------------------------------------------------------
  private terminalPending = false;
  private terminalCooldownS = 0;

  private disposed = false;

  constructor(accelerator: MassAccelerator, orbitalSystem: OrbitalTransportSystem) {
    this.accelerator = accelerator;
    this.orbitalSystem = orbitalSystem;
  }

  // -- session lifecycle ------------------------------------------------------------

  /**
   * Mount the fire-control console and load a cargo lot: INACTIVE →
   * DOCKING_CONSOLE (first tick hands off to AWAITING_ORBITAL_PASS).
   * `cargoType` is any casing of the contract union; `isContraband` is
   * implied by STOLEN_CONTRABAND but may force-hot legal cargo (the radar
   * siphon keys on the flag, Spec §3.4.3). Refuses (false) with an unknown
   * cargo type, non-positive/non-finite mass, an active session, or after
   * dispose.
   */
  startSession(cargoType: string, amountKg: number, isContraband?: boolean): boolean {
    if (this.disposed || this.isActive) return false;
    const cargo = normalizeExportCargo(cargoType);
    if (cargo === null) return false;
    if (!Number.isFinite(amountKg) || amountKg <= 0) return false;
    this.cargoType = cargo;
    this.cargoQuantityKg = amountKg;
    this.isContraband = cargo === 'STOLEN_CONTRABAND' || isContraband === true;
    this.isActive = true;
    this.phase = 'DOCKING_CONSOLE';
    this.laundered = false;
    this.laspPayoutReset();
    this.uspAlertActive = false;
    this.uspCountdownRemainingS = 0;
    this.uspSiphonTriggered = false;
    this.canisterInFlight = false;
    this.canisterPos = { x: 0, y: 0, z: 0 };
    this.prevChargeHeld = false;
    this.chargeHeldS = 0;
    this.terminalPending = false;
    this.terminalCooldownS = 0;
    return true;
  }

  /**
   * One frame of the export console: drive the phase machine, hold the
   * capacitor trigger, tick the USP clock, integrate the canister, and
   * answer the serialized session state. Frozen (state-only) on a garbage
   * dt; safe before the accelerator/transport meshes exist and after
   * dispose. NEVER advances either subsystem clock.
   */
  update(dt: number, gunnerInput: ExportGunnerInput): ExportSessionState {
    if (this.disposed) return this.buildState();
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    const aimX = finiteOr(gunnerInput?.aimX, 0);
    const aimY = finiteOr(gunnerInput?.aimY, 0);
    const chargeHeld = gunnerInput?.chargeHeld === true;

    // Barrel follow orders while the gunner has the loop closed. The
    // accelerator clamps elevation to its hard stops and slews at its own
    // rate limits; those run in the host's accelerator.update(dt).
    if (this.isActive && (this.phase === 'TARGETING_ACTIVE' || this.phase === 'COIL_CHARGING')) {
      this.accelerator.setAimTarget(aimX, aimY);
    }

    if (step > 0 && this.isActive) {
      this.chargeHeldS = chargeHeld ? this.chargeHeldS + step : 0;

      // -- USP intercept clock (Spec §3.4.3): armed by the first spool with
      // contraband aboard, then runs relentlessly — through the console, the
      // coils, and even the canister's flight (a mid-flight expiry is the
      // USP gunship's remote tractor snatching the package off its own
      // ballistic arc) — until a runner capture cancels it clean or the
      // clock hits zero and the yard gets swept.
      if (this.uspAlertActive) {
        this.uspCountdownRemainingS = Math.max(0, this.uspCountdownRemainingS - step);
        // Epsilon guard: repeated 1/60 drains land on 1e-13, not 0 — snap
        // so "T-0" is a real frame (TrainHeistDirector countdown rule).
        if (this.uspCountdownRemainingS < 1e-9) this.uspCountdownRemainingS = 0;
        if (this.uspCountdownRemainingS <= 0) this.confiscate();
      }

      // -- overcharge watchdog (Spec §3.4.2): the breaker itself trips
      // inside the accelerator; a missed trip means a stuck coil line —
      // treat the same way so a session can never hang spooling forever.
      if (
        this.phase === 'COIL_CHARGING' &&
        this.chargeHeldS > OVERCHARGE_TRIP_S + OVERCHARGE_WATCH_GRACE_S
      ) {
        this.tripOvercharge();
      }

      // -- phase machine (Spec §3.4.1) ------------------------------------------
      switch (this.phase) {
        case 'DOCKING_CONSOLE':
          this.phase = 'AWAITING_ORBITAL_PASS';
          break;

        case 'AWAITING_ORBITAL_PASS': {
          // Freighter enters line-of-sight elevation >= 20° (the transport
          // system's own firing-window law) → the gun loop goes live.
          if (this.orbitalSystem.getActiveTarget() !== null) this.phase = 'TARGETING_ACTIVE';
          break;
        }

        case 'TARGETING_ACTIVE':
          if (chargeHeld) {
            this.phase = 'COIL_CHARGING';
            if (this.isContraband) this.triggerUspSiphon();
            this.accelerator.chargeCapacitor(step);
            if (this.accelerator.getState().state === 'OVERCHARGED') this.tripOvercharge();
          }
          break;

        case 'COIL_CHARGING':
          if (chargeHeld) {
            this.accelerator.chargeCapacitor(step);
            if (this.accelerator.getState().state === 'OVERCHARGED') this.tripOvercharge();
          } else {
            // Trigger release == fire command (Spec §3.4.1).
            if (!this.fireLaunch()) this.phase = 'TARGETING_ACTIVE';
          }
          break;

        case 'IN_FLIGHT_TRACKING':
          this.advanceFlight(step);
          break;

        case 'CAPTURE_SUCCESS':
        case 'INTERCEPT_FAILED':
          // Momentary outcome frame → COOLING_DOWN, session winding down.
          this.phase = 'COOLING_DOWN';
          this.terminalPending = true;
          this.terminalCooldownS = POST_OUTCOME_COOLDOWN_S;
          break;

        case 'COOLING_DOWN': {
          if (this.terminalPending) {
            if (this.uspAlertActive) {
              // The package is still hot and the clock is still running:
              // a dead canister is not an exit — keep the console live so
              // the runner play can still beat the intercept ("get the
              // package airborne before the clock hits zero"). Confiscation
              // (or a clean launder) resolves the alert from the clock /
              // capture path; explicit cancelSession always exits.
              this.terminalPending = false;
              this.chargeHeldS = 0;
              this.phase = 'AWAITING_ORBITAL_PASS';
              break;
            }
            this.terminalCooldownS = Math.max(0, this.terminalCooldownS - step);
            if (this.terminalCooldownS <= 0) this.endSession();
          } else {
            // Breaker-lockout recovery: wait for the host-ticked accelerator
            // to clear its cooldown, then re-arm the pass watch (cargo stays
            // in the breech — the bank dumped, not the payload).
            const gs = this.accelerator.getState();
            const clear =
              (gs.state === 'IDLE' || gs.state === 'TARGETING' || gs.state === 'LOADING') &&
              gs.cooldownRemainingS <= 0;
            if (clear) {
              this.chargeHeldS = 0;
              this.phase = 'AWAITING_ORBITAL_PASS';
            }
          }
          break;
        }

        case 'INACTIVE':
        default:
          break;
      }

      this.prevChargeHeld = chargeHeld;
    }

    return this.buildState();
  }

  // -- firing ------------------------------------------------------------------------

  /**
   * Fire command (Spec 27 §4): release the bank down the rail. Valid while
   * TARGETING_ACTIVE or COIL_CHARGING; spawns the canister at the physical
   * muzzle with v0 = muzzleVelocity × fireVector (the §3.3.1 launch law,
   * read from the gun's *actual* articulated state — slew lag included)
   * and enters IN_FLIGHT_TRACKING. Spent-bank tap shots still fire at
   * v_min (MassAccelerator rule). Returns false outside the legal phases,
   * when the gun refuses (FIRING/COOLDOWN/OVERCHARGED), or after dispose.
   */
  fireLaunch(): boolean {
    if (this.disposed || !this.isActive) return false;
    if (this.phase !== 'TARGETING_ACTIVE' && this.phase !== 'COIL_CHARGING') return false;
    // NOTE: a cold tap-fire does NOT arm the siphon — Spec §3.4.3 keys the
    // radar signature on *capacitor charging* (COIL_CHARGING entry only).
    const shot = this.accelerator.dischargeFire();
    if (!shot.success) return false;
    const muzzle = this.accelerator.getMuzzleWorldPosition();
    const speed = finiteOr(shot.muzzleVelocity, 0);
    const vec = shot.fireVector ?? { x: 0, y: 0, z: 1 };
    this.canisterPos = { x: finiteOr(muzzle.x, 0), y: finiteOr(muzzle.y, 0), z: finiteOr(muzzle.z, 0) };
    this.canisterVel = {
      x: finiteOr(vec.x, 0) * speed,
      y: finiteOr(vec.y, 0) * speed,
      z: finiteOr(vec.z, 0) * speed,
    };
    this.flightElapsedS = 0;
    this.flightMaxZ = this.canisterPos.z;
    const seatZ = finiteOr(this.accelerator.getWorldSeat().z, 0);
    this.crashZ = seatZ - GROUND_CRASH_MARGIN_M;
    this.canisterInFlight = true;
    this.phase = 'IN_FLIGHT_TRACKING';
    return true;
  }

  // -- in-flight tracking & capture ------------------------------------------------------

  /**
   * Advance the director-owned canister particle by `step` seconds at fixed
   * {@link TRACKING_SUBSTEP_S} substeps (exact constant-acceleration
   * increments via BallisticTrajectoryEngine, so stepped and closed-form
   * agree). At every substep the Electromagnetic Tractor Funnel is evaluated
   * against the transport system: inside 1.5 × R_catch of a class-compatible
   * catchable vessel's axis the tractor spring/damper grabs the canister
   * toward the bay; `checkCapture()` then resolves the catch (or the canister
   * crashes into regolith / times out into dead orbit).
   *
   * Note: the transport clock advances once per host frame, the canister per
   * substep — ≤ v_T·dt ≈ 3.5 m of vessel lag per 60 Hz frame, noise against
   * a 22 m catch radius.
   */
  private advanceFlight(step: number): void {
    let remaining = step;
    while (remaining > 1e-9 && this.canisterInFlight) {
      const h = Math.min(TRACKING_SUBSTEP_S, remaining);
      remaining -= h;
      this.flightElapsedS += h;

      // Who integrates this substep: the tractor when engaged, else free
      // ballistics. Exactly one integrator per substep — the canister's
      // state advances by h, never by 2h.
      const mode = this.tractorStep(h);
      if (mode === 'resolved') break; // checkCapture closed the catch
      if (mode === 'none') {
        const free = BallisticTrajectoryEngine.canisterStateAt(this.canisterPos, this.canisterVel, h);
        this.canisterPos = free.position;
        this.canisterVel = free.velocity;
        const res = this.orbitalSystem.checkCapture(this.canisterPos, this.canisterVel);
        if (res.captured && this.cargoAcceptedBy(res)) {
          this.resolveCapture(res.transport);
          break;
        }
      }
      this.flightMaxZ = Math.max(this.flightMaxZ, this.canisterPos.z);
      if (this.canisterVel.z < 0 && this.flightMaxZ < CATCH_CEILING_FLOOR_Z && !this.tractorEngaged) {
        this.resolveMiss(); // apex locked under every catch ring — dead shot now
        break;
      }
      if (this.canisterPos.z <= this.crashZ && this.flightElapsedS > 0.1) {
        this.resolveMiss(); // regolith impact — cargo destroyed
        break;
      }
      if (this.flightElapsedS >= FLIGHT_TIMEOUT_S) {
        this.resolveMiss(); // dead orbit / far-side crash (spec §1.3)
        break;
      }
    }
  }

  /**
   * One substep of tractor-funnel engagement. Returns 'resolved' when the
   * funnel closed the catch (checkCapture answered), 'integrated' when the
   * tractor advanced the canister by `h`, and 'none' when no vessel's
   * envelope holds the canister (caller free-integrates). Engage: catchable,
   * class-compatible vessel, funnel-axis distance inside 1.5 × R_catch.
   * Release hysteresis at 2.5 × R_catch keeps a marginal grab from
   * chattering while the spring walks the canister in.
   */
  private tractorStep(h: number): 'resolved' | 'integrated' | 'none' {
    const probe = this.orbitalSystem.checkCapture(this.canisterPos, this.canisterVel);
    const vessel = probe.transport;
    if (vessel === null || vessel.catchRadiusM <= 0) return 'none';
    if (!this.cargoAcceptedBy(probe)) return 'none';

    const grabRadius = TRACTOR_GRAB_FACTOR * vessel.catchRadiusM;
    if (!this.tractorEngaged) {
      if (probe.missDistanceM > grabRadius) return 'none';
      this.tractorEngaged = true;
    } else {
      const dx = this.canisterPos.x - vessel.position.x;
      const dy = this.canisterPos.y - vessel.position.y;
      const dz = this.canisterPos.z - vessel.position.z;
      if (Math.hypot(dx, dy, dz) > TRACTOR_RELEASE_FACTOR * vessel.catchRadiusM) {
        this.tractorEngaged = false;
        return 'none';
      }
    }

    // Spring toward the bay ring + damping toward the vessel's velocity
    // frame (the tractor's magnetic gradient gradient-matches the catch).
    const ax =
      TRACTOR_SPRING_K_PER_S2 * (vessel.position.x - this.canisterPos.x) +
      TRACTOR_MATCH_DAMPING_PER_S * (vessel.velocity.x - this.canisterVel.x);
    const ay =
      TRACTOR_SPRING_K_PER_S2 * (vessel.position.y - this.canisterPos.y) +
      TRACTOR_MATCH_DAMPING_PER_S * (vessel.velocity.y - this.canisterVel.y);
    const az =
      TRACTOR_SPRING_K_PER_S2 * (vessel.position.z - this.canisterPos.z) +
      TRACTOR_MATCH_DAMPING_PER_S * (vessel.velocity.z - this.canisterVel.z);
    this.canisterPos = {
      x: this.canisterPos.x + this.canisterVel.x * h + 0.5 * ax * h * h,
      y: this.canisterPos.y + this.canisterVel.y * h + 0.5 * ay * h * h,
      z: this.canisterPos.z + this.canisterVel.z * h + 0.5 * az * h * h - 0.5 * BallisticTrajectoryEngine.LUNAR_GRAVITY * h * h,
    };
    this.canisterVel = {
      x: this.canisterVel.x + ax * h,
      y: this.canisterVel.y + ay * h,
      z: this.canisterVel.z + az * h - BallisticTrajectoryEngine.LUNAR_GRAVITY * h,
    };

    const after = this.orbitalSystem.checkCapture(this.canisterPos, this.canisterVel);
    if (after.captured && this.cargoAcceptedBy(after)) {
      this.resolveCapture(after.transport);
      return 'resolved';
    }
    return 'integrated';
  }

  /** Spec §3.2.2 accepted-cargo table: Bulk Tug ↔ legal, Runner ↔ hot, USP ↔ none. */
  private cargoAcceptedBy(result: { transport: { transportClass: string } | null }): boolean {
    const vessel = result.transport;
    if (vessel === null) return false;
    if (vessel.transportClass === 'SYNDICATE_RUNNER') return this.isContraband;
    if (vessel.transportClass === 'BULK_FREIGHTER') return !this.isContraband;
    return false; // USP_PATROL (and anything future): never a customer.
  }

  /**
   * CAPTURE_SUCCESS frame: payout = lot value × vessel multiplier
   * (× laundering bonus for contraband through the Slip), USP alert
   * cancelled and heat cleared on a launder, canister consumed.
   */
  private resolveCapture(vessel: { payoutMultiplier: number; transportClass: string } | null): void {
    const multiplier = vessel === null ? 0 : finiteOr(vessel.payoutMultiplier, 0);
    const launderedNow = this.isContraband && vessel !== null && vessel.transportClass === 'SYNDICATE_RUNNER';
    const bonus = launderedNow ? LAUNDER_BONUS_CREDIT : 1;
    const raw = cargoDepotValueCredits(this.cargoType, this.cargoQuantityKg) * multiplier * bonus;
    this.lastPayoutCredits = Number.isFinite(raw) ? Math.round(raw) : 0;
    this.lastResult = 'SUCCESS';
    this.canisterInFlight = false;
    this.tractorEngaged = false;
    if (launderedNow) {
      this.laundered = true;
      this.uspAlertActive = false;
      this.uspCountdownRemainingS = 0;
      this.uspHeatLevel = 0; // "Cargo clean; launch signature scrubbed"
    }
    this.phase = 'CAPTURE_SUCCESS';
  }

  /** INTERCEPT_FAILED frame: cargo destroyed, capacitor burned, alert stands. */
  private resolveMiss(): void {
    this.lastResult = 'MISSED';
    this.lastPayoutCredits = 0;
    this.canisterInFlight = false;
    this.tractorEngaged = false;
    this.phase = 'INTERCEPT_FAILED';
  }

  // -- USP engine ---------------------------------------------------------------------------

  /** Radar siphon signature (Spec §3.4.3): arms the 45 s intercept countdown once. */
  private triggerUspSiphon(): void {
    if (this.uspSiphonTriggered) return;
    this.uspSiphonTriggered = true;
    this.uspAlertActive = true;
    this.uspCountdownRemainingS = USP_INTERCEPT_COUNTDOWN_S;
    this.uspHeatLevel = 1;
  }

  /**
   * Countdown expiry (Spec §3.4.3 outcome 2): the USP gunship's remote
   * tractor seizes the hot cargo (off the console, off the pad, or clean
   * out of the canister's own arc) and cites the yard. `lastResult =
   * 'CONFISCATED'`; the fine itself is {@link USP_CITATION_FINE_CREDITS},
   * applied once per outcome by the ClientApp bridge. A still-live bank is
   * dumped downrange by the USPs' gun-jamming pulse.
   */
  private confiscate(): void {
    this.uspAlertActive = false;
    this.uspCountdownRemainingS = 0;
    this.lastResult = 'CONFISCATED';
    this.lastPayoutCredits = 0;
    this.cargoQuantityKg = 0;
    this.canisterInFlight = false;
    this.tractorEngaged = false;
    if (this.accelerator.getState().state === 'CHARGING') this.accelerator.dischargeFire();
    this.phase = 'COOLING_DOWN';
    this.terminalPending = true;
    this.terminalCooldownS = POST_OUTCOME_COOLDOWN_S;
  }

  /** Thermal breaker outcome (Spec §3.4.2): bank dumped, cargo safe, 5 s lockout. */
  private tripOvercharge(): void {
    this.lastResult = 'OVERCHARGED';
    this.lastPayoutCredits = 0;
    this.chargeHeldS = 0;
    this.phase = 'COOLING_DOWN';
    this.terminalPending = false; // session survives — reload the curve, not the cargo
  }

  // -- teardown ------------------------------------------------------------------------------

  /** Wind the console down: back to INACTIVE, cargo consumed by the outcome. */
  private endSession(): void {
    this.phase = 'INACTIVE';
    this.isActive = false;
    this.cargoQuantityKg = 0;
    this.canisterInFlight = false;
    this.tractorEngaged = false;
    this.uspAlertActive = false;
    this.uspSiphonTriggered = false;
    this.terminalPending = false;
    this.terminalCooldownS = 0;
    this.prevChargeHeld = false;
    this.chargeHeldS = 0;
  }

  /**
   * Walk away from the console mid-session: tracking aborts, the radar
   * signature drops with the console, and the loaded cargo is *not*
   * consumed (a cancel is not an export). lastResult/lastPayout keep the
   * previous run's verdict.
   */
  cancelSession(): void {
    if (this.disposed || !this.isActive) return;
    this.endSession();
  }

  /** Full pristine reset (QA / retry): every field back to factory state. */
  reset(): void {
    this.phase = 'INACTIVE';
    this.isActive = false;
    this.cargoType = 'REGOLITH';
    this.cargoQuantityKg = 0;
    this.isContraband = false;
    this.uspAlertActive = false;
    this.uspCountdownRemainingS = 0;
    this.uspSiphonTriggered = false;
    this.uspHeatLevel = 0;
    this.laundered = false;
    this.canisterInFlight = false;
    this.canisterPos = { x: 0, y: 0, z: 0 };
    this.canisterVel = { x: 0, y: 0, z: 0 };
    this.laspPayoutReset();
    this.flightElapsedS = 0;
    this.flightMaxZ = 0;
    this.terminalPending = false;
    this.terminalCooldownS = 0;
    this.prevChargeHeld = false;
    this.chargeHeldS = 0;
  }

  /** Tear down: reset state and drop references. The director owns no meshes. */
  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
  }

  // -- queries --------------------------------------------------------------------------------

  /** True after `dispose()` — every query still answers, every driver refuses. */
  isDisposed(): boolean {
    return this.disposed;
  }

  /** Current phase machine position (Spec §3.4.1). */
  getPhase(): ExportSessionPhase {
    return this.phase;
  }

  /** Snapshot without advancing anything (same shape as update()'s return). */
  getSessionState(): ExportSessionState {
    return this.buildState();
  }

  /** USP heat 0 (clean) / 1 (hot — radar signature on the books). */
  getUspHeatLevel(): number {
    return this.uspHeatLevel;
  }

  /** True once this run's contraband rode the Slip into the offshore vault. */
  isContrabandLaundered(): boolean {
    return this.laundered;
  }

  /** Live canister position (world metres) while tracking (copy). */
  getCanisterPos(): { x: number; y: number; z: number } {
    return { ...this.canisterPos };
  }

  /** Current capacitor muzzle velocity (m/s) straight off the gun (read-only). */
  getMuzzleVelocityMps(): number {
    return this.accelerator.getMuzzleVelocityMps();
  }

  // -- internals -------------------------------------------------------------------------------

  private laspPayoutReset(): void {
    this.lastPayoutCredits = 0;
    this.lastResult = 'NONE';
  }

  private buildState(): ExportSessionState {
    return {
      isActive: this.isActive,
      selectedCargoType: this.cargoType,
      cargoQuantityKg: this.cargoQuantityKg,
      isContraband: this.isContraband,
      uspCountdownRemainingS: this.uspCountdownRemainingS,
      uspAlertActive: this.uspAlertActive,
      canisterInFlight: this.canisterInFlight,
      canisterPos: { ...this.canisterPos },
      lastPayoutCredits: this.lastPayoutCredits,
      lastResult: this.lastResult,
    };
  }
}
