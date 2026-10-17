/**
 * Lunar Frontier — Vacuum Ballistics & Predictive Lead Engine (Spec 27 §3.3).
 *
 * Pure, allocation-light lunar vacuum kinematics for the Gauss Needle fire
 * control suite (C_d = 0, g = 1.62 m/s²):
 *
 *   r_payload(t) = r_muzzle + v0·t + ½·g⃗·t²        v_payload(t) = v0 + g⃗·t
 *
 * with the Spec §3.3.1 / §3.1.2 launch parameterization expressed in the
 * codebase z-up physics frame (shared with `MassAccelerator` / `CameraRig`):
 *
 *   v0 = v0 · (cosθ·cosψ, cosθ·sinψ, sinθ),  g⃗ = (0, 0, −1.62)
 *   θ (elevation) ∈ [15°, 85°] hard stops,   ψ (azimuth) ∈ [0°, 360°)
 *
 * ## Lead math (closed form reduction + robust bracketing)
 * For a target on a straight constant-velocity run r_T(t) = r_T0 + v_T·t, a
 * shot at speed s with flight time τ lands on the sphere of radius s·τ around
 * c(τ) = r_muzzle + ½·g⃗·τ². Defining the required launch velocity
 *
 *   V_req(τ) = Δ/τ + v_T + (0, 0, g·τ/2),    Δ = r_T0 − r_muzzle,   k = g/2
 *
 * the intercept condition is exactly ‖V_req(τ)‖ = s (τ²·q(τ) with q(τ)=‖V_req‖²
 * is a quartic-over-τ² form, so q′(τ)·τ³/2 is a quartic polynomial in τ whose
 * smallest positive root is found by bracket-doubling bisection — no Newton,
 * no complex branches, total-function on τ > 0). When min q ≤ s² the two
 * crossings τ_near ≤ τ* ≤ τ_far are the classic direct / lofted firing arcs;
 * each is accepted only if its elevation lies inside the barrel hard stops
 * (near arc preferred for shortest flight time, far arc as fallback). The
 * aim direction for any τ is u(τ) = normalize(Δ + v_T·τ + (0,0,k·τ²)) — note
 * the azimuth lead falls out of Δ + v_T·τ automatically, gravity drop falls
 * out of the k·τ² term — and the achievable miss distance at fixed τ is
 * |‖Δ + v_T·τ + k·τ²·ẑ‖ − s·τ with u elevation-clamped when outside limits.
 *
 * ## Solution semantics
 * - `hasSolution: true`  — an exact intercept (predictedMissDistanceM ≈ 0)
 *   exists at `estimatedFlightTimeS` with the barrel inside both hard stops;
 *   `recommendedMuzzleSpeedMps` is the coil charge the solution was solved at.
 * - `hasSolution: false` — either the target is beyond coil reach (then
 *   `recommendedMuzzleSpeedMps` reports the MINIMUM speed that would make an
 *   intercept possible, useful for the HUD "optimal velocity bracket") or the
 *   only intercept arcs violate the elevation hard stops; the returned
 *   azimuth/elevation are the best aim available inside the limits and
 *   `predictedMissDistanceM` is the corresponding closest-approach distance.
 * - Non-finite inputs or negative speed answer hasSolution false with
 *   predictedMissDistanceM Infinity and finite (nominal) aim fields — the
 *   HUD can render a solution object without NaN guards.
 *
 * `simulateCanister()` integrates with the closed-form constant-acceleration
 * step, so stepped and unstepped answers agree to floating-point rounding.
 *
 * Headless-safe and deterministic: no Babylon.js imports, no clocks, no RNG,
 * no shared state — every method is static and pure.
 *
 * Usage (HUD lead pip, 60 Hz):
 *   const t = orbitalSystem.getActiveTarget();
 *   const sol = BallisticTrajectoryEngine.calculateLead(
 *     gun.getMuzzleWorldPosition(), t.position, t.velocity,
 *     gun.getMuzzleVelocityMps());
 *   if (sol.hasSolution) gun.setAimTarget(sol.leadAzimuthDeg, sol.leadElevationDeg);
 */

// -- types ---------------------------------------------------------------------

/** A bare 3-vector in the z-up world physics frame (x, y lateral, z↑). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Spec 27 §4: serialized predictive-lead solution for the fire control HUD. */
export interface TrajectorySolution {
  hasSolution: boolean;
  leadAzimuthDeg: number;
  leadElevationDeg: number;
  recommendedMuzzleSpeedMps: number;
  estimatedFlightTimeS: number;
  predictedMissDistanceM: number;
}

/** Which of the two intercept arcs to prefer when both exist and are feasible. */
export type InterceptArc = 'near' | 'far';

// -- helpers -------------------------------------------------------------------

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap degrees into [0, 360). */
function wrapDeg(a: number): number {
  const t = a % 360;
  return t < 0 ? t + 360 : t;
}

// ================================================================================

export class BallisticTrajectoryEngine {
  /** Spec 27 §3.3.1: lunar surface gravity magnitude (m/s²), g⃗ = (0,0,−g). */
  static readonly LUNAR_GRAVITY = 1.62;

  /** Spec 27 §3.1.2: elevation hard stop — terrain scrape limit (deg). */
  static readonly ELEVATION_MIN_DEG = 15;
  /** Spec 27 §3.1.2: elevation hard stop — zenith gimbal guard (deg). */
  static readonly ELEVATION_MAX_DEG = 85;

  /** Search horizon for flight times (s): past a full 420 m/s vertical shot. */
  static readonly MAX_SEARCH_FLIGHT_TIME_S = 1200;

  // -- public lead solvers -------------------------------------------------------

  /**
   * Predictive lead for a constant-velocity target at the given coil charge
   * (Spec 27 §3.3.2): the intercept time minimizing flight time (near arc
   * first, lofted arc fallback when the near arc violates the elevation hard
   * stops). Drives the 60 Hz "Ghost Target" HUD pip.
   */
  static calculateLead(
    muzzlePos: Vec3Like,
    targetPos: Vec3Like,
    targetVel: Vec3Like,
    muzzleSpeedMps: number
  ): TrajectorySolution {
    return BallisticTrajectoryEngine.solve(muzzlePos, targetPos, targetVel, muzzleSpeedMps, 'near');
  }

  /**
   * Same solution space as {@link calculateLead} but preferring the LOFTED
   * (far) arc — the high-trajectory option the gunner can pick when a flat
   * shot would pass under a tractor cone or behind a terrain mask.
   */
  static calculateLeadLongArc(
    muzzlePos: Vec3Like,
    targetPos: Vec3Like,
    targetVel: Vec3Like,
    muzzleSpeedMps: number
  ): TrajectorySolution {
    return BallisticTrajectoryEngine.solve(muzzlePos, targetPos, targetVel, muzzleSpeedMps, 'far');
  }

  // -- helper methods (Phase 4 director / Phase 5 HUD) -----------------------------

  /**
   * Unit launch direction for barrel azimuth/elevation per Spec §3.3.1:
   * (cosθ·cosψ, cosθ·sinψ, sinθ). Elevation is clamped to the hard stops.
   */
  static aimVector(azimuthDeg: number, elevationDeg: number): Vec3Like {
    const psi = wrapDeg(finiteOr(azimuthDeg, 0)) * DEG;
    const theta = clamp(finiteOr(elevationDeg, BallisticTrajectoryEngine.ELEVATION_MIN_DEG),
      BallisticTrajectoryEngine.ELEVATION_MIN_DEG, BallisticTrajectoryEngine.ELEVATION_MAX_DEG) * DEG;
    const cosEl = Math.cos(theta);
    return { x: cosEl * Math.cos(psi), y: cosEl * Math.sin(psi), z: Math.sin(theta) };
  }

  /** Launch velocity vector v0 = speed · aimVector(azimuth, elevation). */
  static launchVelocity(azimuthDeg: number, elevationDeg: number, speedMps: number): Vec3Like {
    const u = BallisticTrajectoryEngine.aimVector(azimuthDeg, elevationDeg);
    const s = finiteOr(speedMps, 0);
    return { x: u.x * s, y: u.y * s, z: u.z * s };
  }

  /**
   * Exact canister state at time t: p = p0 + v0·t + (0,0,−½·g·t²),
   * v = v0 + (0,0,−g·t).
   */
  static canisterStateAt(initialPos: Vec3Like, initialVel: Vec3Like, t: number):
    { position: Vec3Like; velocity: Vec3Like } {
    const T = Number.isFinite(t) && t > 0 ? t : 0;
    const g = BallisticTrajectoryEngine.LUNAR_GRAVITY;
    const px = finiteOr(initialPos?.x, 0);
    const py = finiteOr(initialPos?.y, 0);
    const pz = finiteOr(initialPos?.z, 0);
    const vx = finiteOr(initialVel?.x, 0);
    const vy = finiteOr(initialVel?.y, 0);
    const vz = finiteOr(initialVel?.z, 0);
    return {
      position: { x: px + vx * T, y: py + vy * T, z: pz + vz * T - 0.5 * g * T * T },
      velocity: { x: vx, y: vy, z: vz - g * T },
    };
  }

  /**
   * Spec 27 §4: forward-propagate a launched canister `flightTimeS` seconds.
   * With `stepDt` given the closed-form constant-acceleration step is chained
   * at that cadence (exact under constant gravity — stepped and unstepped
   * answers agree to floating-point rounding); otherwise one closed-form leap.
   */
  static simulateCanister(
    initialPos: Vec3Like,
    initialVel: Vec3Like,
    flightTimeS: number,
    stepDt?: number
  ): { position: Vec3Like; velocity: Vec3Like } {
    const T = Number.isFinite(flightTimeS) && flightTimeS > 0 ? flightTimeS : 0;
    const dt = Number.isFinite(stepDt) && (stepDt as number) > 0 ? (stepDt as number) : 0;
    if (dt <= 0 || T === 0) return BallisticTrajectoryEngine.canisterStateAt(initialPos, initialVel, T);

    const g = BallisticTrajectoryEngine.LUNAR_GRAVITY;
    let px = finiteOr(initialPos?.x, 0);
    let py = finiteOr(initialPos?.y, 0);
    let pz = finiteOr(initialPos?.z, 0);
    let vx = finiteOr(initialVel?.x, 0);
    let vy = finiteOr(initialVel?.y, 0);
    let vz = finiteOr(initialVel?.z, 0);
    let elapsed = 0;
    // Guard against absurd step counts (T/dt > 10M): fall back to the leap.
    if (T / dt > 1e7) return BallisticTrajectoryEngine.canisterStateAt(initialPos, initialVel, T);
    while (elapsed < T) {
      const h = Math.min(dt, T - elapsed);
      // Exact constant-acceleration increment (no drift vs closed form).
      px += vx * h;
      py += vy * h;
      pz += vz * h - 0.5 * g * h * h;
      vz -= g * h;
      elapsed += h;
    }
    return { position: { x: px, y: py, z: pz }, velocity: { x: vx, y: vy, z: vz } };
  }

  /**
   * Minimum muzzle speed that admits ANY intercept of the moving target
   * (unconstrained by elevation), and the flight time at which it holds.
   * The HUD draws this as the green "Optimal Velocity Bracket" marker on the
   * capacitor bar; the ExportMinigameDirector uses it to decide whether the
   * current pass is catchable at all (v_max = 420 m/s).
   */
  static minimumMuzzleSpeed(
    muzzlePos: Vec3Like,
    targetPos: Vec3Like,
    targetVel: Vec3Like
  ): { requiredSpeedMps: number; flightTimeS: number } {
    const ctx = BallisticTrajectoryEngine.context(muzzlePos, targetPos, targetVel);
    if (ctx === null) return { requiredSpeedMps: 0, flightTimeS: 0 };
    return {
      requiredSpeedMps: Math.sqrt(BallisticTrajectoryEngine.q(ctx, ctx.tauStar)),
      flightTimeS: ctx.tauStar,
    };
  }

  /**
   * Relative speed ‖v_canister(τ) − v_T‖ at the intercept chosen by
   * {@link calculateLead}, or Infinity when there is no intercept solution.
   * Phase 4 compares this against the vessel's maxCatchRelSpeedMps (Spec §3.2.2).
   */
  static interceptDeltaVelocity(
    muzzlePos: Vec3Like,
    targetPos: Vec3Like,
    targetVel: Vec3Like,
    muzzleSpeedMps: number
  ): number {
    const sol = BallisticTrajectoryEngine.calculateLead(muzzlePos, targetPos, targetVel, muzzleSpeedMps);
    if (!sol.hasSolution) return Infinity;
    const v0 = BallisticTrajectoryEngine.launchVelocity(
      sol.leadAzimuthDeg, sol.leadElevationDeg, sol.recommendedMuzzleSpeedMps);
    const state = BallisticTrajectoryEngine.canisterStateAt(muzzlePos, v0, sol.estimatedFlightTimeS);
    const tx = finiteOr(targetVel?.x, 0);
    const ty = finiteOr(targetVel?.y, 0);
    const tz = finiteOr(targetVel?.z, 0);
    const dx = state.velocity.x - tx;
    const dy = state.velocity.y - ty;
    const dz = state.velocity.z - tz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * HUD trajectory arc: `sampleCount` exact canister positions spaced evenly
   * over [0, totalFlightTimeS] (first = launch point, last = state at T).
   */
  static trajectoryArcPoints(
    initialPos: Vec3Like,
    initialVel: Vec3Like,
    totalFlightTimeS: number,
    sampleCount: number
  ): Vec3Like[] {
    const n = clamp(Math.floor(finiteOr(sampleCount, 32)), 2, 4096);
    const T = Number.isFinite(totalFlightTimeS) && totalFlightTimeS > 0 ? totalFlightTimeS : 0;
    const points: Vec3Like[] = [];
    for (let i = 0; i < n; i++) {
      points.push(BallisticTrajectoryEngine.canisterStateAt(initialPos, initialVel, (T * i) / (n - 1)).position);
    }
    return points;
  }

  // -- solver core ------------------------------------------------------------------

  /** Per-scenario constants of q(τ) = ‖V_req(τ)‖². */
  private static context(muzzlePos: Vec3Like, targetPos: Vec3Like, targetVel: Vec3Like): {
    ax: number; ay: number; az: number;
    vx: number; vy: number; vz: number;
    k: number;
    aDotV: number;
    aLenSq: number;
    tauStar: number; // argmin of q over τ > 0
  } | null {
    const mx = finiteOr(muzzlePos?.x, NaN);
    const my = finiteOr(muzzlePos?.y, NaN);
    const mz = finiteOr(muzzlePos?.z, NaN);
    const tx = finiteOr(targetPos?.x, NaN);
    const ty = finiteOr(targetPos?.y, NaN);
    const tz = finiteOr(targetPos?.z, NaN);
    const vx = finiteOr(targetVel?.x, 0);
    const vy = finiteOr(targetVel?.y, 0);
    const vz = finiteOr(targetVel?.z, 0);
    if (![mx, my, mz, tx, ty, tz, vx, vy, vz].every(Number.isFinite)) return null;

    const ax = tx - mx;
    const ay = ty - my;
    const az = tz - mz;
    const k = BallisticTrajectoryEngine.LUNAR_GRAVITY / 2;
    const aDotV = ax * vx + ay * vy + az * vz;
    const aLenSq = ax * ax + ay * ay + az * az;
    if (aLenSq < 1e-18) return null; // target already at the muzzle (degenerate)

    return { ax, ay, az, vx, vy, vz, k, aDotV, aLenSq, tauStar: BallisticTrajectoryEngine.argMinQ(k, vz, aDotV, aLenSq) };
  }

  /** q(τ) = ‖Δ/τ + v_T + (0,0,k·τ)‖². */
  private static q(c: { ax: number; ay: number; az: number; vx: number; vy: number; vz: number; k: number }, tau: number): number {
    const rx = c.ax / tau + c.vx;
    const ry = c.ay / tau + c.vy;
    const rz = c.az / tau + c.vz + c.k * tau;
    return rx * rx + ry * ry + rz * rz;
  }

  /**
   * Smallest positive root of q′(τ)·τ³/2 = k²τ⁴ + v_z·k·τ³ − (Δ·v_T)·τ − ‖Δ‖².
   * The polynomial is negative at τ = 0 and → +∞, so bracket-doubling
   * bisection always terminates; the first (− → +) crossing is the global
   * minimum of q for the physical scenarios this engine serves.
   */
  private static argMinQ(k: number, vTz: number, aDotV: number, aLenSq: number): number {
    const Q = (tau: number): number =>
      k * k * tau * tau * tau * tau + vTz * k * tau * tau * tau - aDotV * tau - aLenSq;
    let hi = 1;
    for (let i = 0; i < 64 && Q(hi) < 0; i++) hi *= 2;
    let lo = 0;
    for (let i = 0; i < 90; i++) {
      const mid = (lo + hi) * 0.5;
      if (Q(mid) < 0) lo = mid; else hi = mid;
    }
    return (lo + hi) * 0.5;
  }

  /** Aim offset w(τ) = r_T(τ) − c(τ) = Δ + v_T·τ + (0,0,k·τ²); the aim ray is u = w/‖w‖. */
  private static w(c: { ax: number; ay: number; az: number; vx: number; vy: number; vz: number; k: number }, tau: number):
    { wx: number; wy: number; wz: number } {
    return {
      wx: c.ax + c.vx * tau,
      wy: c.ay + c.vy * tau,
      wz: c.az + c.vz * tau + c.k * tau * tau,
    };
  }

  /** Elevation (deg) of the aim ray at flight time τ (atan2 of w). */
  private static elevationAtDeg(c: { ax: number; ay: number; az: number; vx: number; vy: number; vz: number; k: number }, tau: number): number {
    const wv = BallisticTrajectoryEngine.w(c, tau);
    return Math.atan2(wv.wz, Math.hypot(wv.wx, wv.wy)) * RAD;
  }

  private static solve(
    muzzlePos: Vec3Like,
    targetPos: Vec3Like,
    targetVel: Vec3Like,
    muzzleSpeedMps: number,
    arc: InterceptArc
  ): TrajectorySolution {
    const s = finiteOr(muzzleSpeedMps, NaN);
    if (!(s >= 0)) {
      // Invalid charge: nominal answer with finite aim fields, no NaNs.
      return {
        hasSolution: false,
        leadAzimuthDeg: 0,
        leadElevationDeg: BallisticTrajectoryEngine.ELEVATION_MIN_DEG,
        recommendedMuzzleSpeedMps: Number.isFinite(s) ? Math.max(0, s) : 0,
        estimatedFlightTimeS: 0,
        predictedMissDistanceM: Infinity,
      };
    }
    // Sanitize exactly once, no re-entry: geometry must be finite (invalid →
    // Infinity report); a non-finite target velocity is tolerated as zero.
    const mx = finiteOr(muzzlePos?.x, NaN);
    const my = finiteOr(muzzlePos?.y, NaN);
    const mz = finiteOr(muzzlePos?.z, NaN);
    const tx = finiteOr(targetPos?.x, NaN);
    const ty = finiteOr(targetPos?.y, NaN);
    const tz = finiteOr(targetPos?.z, NaN);
    if (![mx, my, mz, tx, ty, tz].every(Number.isFinite)) {
      return {
        hasSolution: false, leadAzimuthDeg: 0, leadElevationDeg: BallisticTrajectoryEngine.ELEVATION_MIN_DEG,
        recommendedMuzzleSpeedMps: s, estimatedFlightTimeS: 0, predictedMissDistanceM: Infinity,
      };
    }
    const k = BallisticTrajectoryEngine.LUNAR_GRAVITY / 2;
    const ax = tx - mx;
    const ay = ty - my;
    const az = tz - mz;
    const aLenSq = ax * ax + ay * ay + az * az;
    if (aLenSq < 1e-18) {
      // Target already at the muzzle: zero-flight intercept, nominal aim.
      return {
        hasSolution: true, leadAzimuthDeg: 0, leadElevationDeg: 50,
        recommendedMuzzleSpeedMps: s, estimatedFlightTimeS: 0, predictedMissDistanceM: 0,
      };
    }
    const tvx = finiteOr(targetVel?.x, 0);
    const tvy = finiteOr(targetVel?.y, 0);
    const tvz = finiteOr(targetVel?.z, 0);
    const aDotV = ax * tvx + ay * tvy + az * tvz;
    const ctx = {
      ax, ay, az,
      vx: tvx, vy: tvy, vz: tvz,
      k, aDotV, aLenSq,
      tauStar: BallisticTrajectoryEngine.argMinQ(k, tvz, aDotV, aLenSq),
    };
    const minSol = (tauBest: number, minRequired: number): TrajectorySolution =>
      BallisticTrajectoryEngine.constrainedReport(ctx, s, tauBest, minRequired);

    const tauStar = ctx.tauStar;
    const minRequired = Math.sqrt(BallisticTrajectoryEngine.q(ctx, tauStar));

    if (minRequired > s) {
      // Beyond coil reach: best-effort aim at the closest-approach window.
      return minSol(BallisticTrajectoryEngine.scanMinTau(ctx, s, tauStar), minRequired);
    }

    // --- intercept exists: bisect the two crossings of f(τ)=√q(τ)−s ---------
    const f = (tau: number): number => Math.sqrt(BallisticTrajectoryEngine.q(ctx, tau)) - s;

    // Near root τ1 ∈ (0, τ*]: f decreases on (0, τ*], single crossing.
    let lo = Math.min(1e-4, tauStar * 0.5);
    let tauNear: number;
    if (f(lo) <= 0) {
      tauNear = lo; // intercept is essentially immediate
    } else {
      let hiN = tauStar;
      for (let i = 0; i < 100; i++) {
        const mid = (lo + hiN) * 0.5;
        if (mid <= lo || mid >= hiN) break;
        if (f(mid) > 0) lo = mid; else hiN = mid;
      }
      tauNear = (lo + hiN) * 0.5;
    }

    // Far root τ2 ∈ [τ*, ∞): f increases on [τ*, ∞); expand, then bisect.
    let tauFar: number | null = null;
    if (f(tauStar) < 0) {
      let loF = tauStar;
      let hi = Math.min(BallisticTrajectoryEngine.MAX_SEARCH_FLIGHT_TIME_S, Math.max(tauStar * 2, tauStar + 1));
      if (f(hi) < 0) {
        for (let i = 0; i < 32 && hi < BallisticTrajectoryEngine.MAX_SEARCH_FLIGHT_TIME_S; i++) {
          hi = Math.min(BallisticTrajectoryEngine.MAX_SEARCH_FLIGHT_TIME_S, hi * 2);
        }
      }
      if (f(hi) >= 0) {
        for (let i = 0; i < 100; i++) {
          const mid = (loF + hi) * 0.5;
          if (mid <= loF || mid >= hi) break;
          if (f(mid) < 0) loF = mid; else hi = mid;
        }
        tauFar = (loF + hi) * 0.5;
      }
    } else {
      tauFar = tauStar; // grazing single-solution case
    }

    const elNear = BallisticTrajectoryEngine.elevationAtDeg(ctx, tauNear);
    const elFar = tauFar !== null ? BallisticTrajectoryEngine.elevationAtDeg(ctx, tauFar) : NaN;
    const elOk = (el: number): boolean =>
      Number.isFinite(el) &&
      el >= BallisticTrajectoryEngine.ELEVATION_MIN_DEG - 1e-6 &&
      el <= BallisticTrajectoryEngine.ELEVATION_MAX_DEG + 1e-6;

    const order: (number | null)[] = arc === 'far' ? [tauFar, tauNear] : [tauNear, tauFar];
    for (const tauPick of order) {
      if (tauPick === null) continue;
      const elPick = tauPick === tauNear ? elNear : elFar;
      if (!elOk(elPick)) continue;
      const wv = BallisticTrajectoryEngine.w(ctx, tauPick);
      const az = wrapDeg(Math.atan2(wv.wy, wv.wx) * RAD);
      const miss = Math.max(0, Math.hypot(wv.wx, wv.wy, wv.wz) - s * tauPick);
      return {
        hasSolution: true,
        leadAzimuthDeg: az,
        leadElevationDeg: clamp(elPick, BallisticTrajectoryEngine.ELEVATION_MIN_DEG, BallisticTrajectoryEngine.ELEVATION_MAX_DEG),
        recommendedMuzzleSpeedMps: s,
        estimatedFlightTimeS: tauPick,
        predictedMissDistanceM: miss,
      };
    }

    // Both arcs violate the elevation hard stops: report the constrained best.
    return minSol(BallisticTrajectoryEngine.scanMinTau(ctx, s, tauStar), minRequired);
  }

  /**
   * Robust 1-D minimizer of the achievable miss distance over flight time
   * (geometric coarse scan + golden-section refine), used whenever no exact
   * intercept is reportable — speed-limited or elevation-limited.
   */
  private static scanMinTau(
    c: { ax: number; ay: number; az: number; vx: number; vy: number; vz: number; k: number },
    s: number,
    tauStar: number
  ): number {
    const cost = (tau: number): number => BallisticTrajectoryEngine.missAtTau(c, s, tau);
    const lo = Math.min(1e-3, tauStar * 0.5);
    const hi = Math.min(
      BallisticTrajectoryEngine.MAX_SEARCH_FLIGHT_TIME_S,
      Math.max(8 * tauStar, 2 * (s / c.k), tauStar + 60)
    );
    if (!(hi > lo)) return tauStar;
    const N = 96;
    const ratio = Math.pow(hi / lo, 1 / N);
    let bestT = tauStar;
    let bestC = Infinity;
    let bestI = 0;
    let t = lo;
    for (let i = 0; i <= N; i++) {
      const cI = cost(t);
      if (cI < bestC) { bestC = cI; bestT = t; bestI = i; }
      t *= ratio;
    }
    // Golden-section refine inside the neighbouring coarse cells.
    let a = bestI === 0 ? lo : bestT / Math.sqrt(ratio);
    let b = bestI === N ? hi : bestT * Math.sqrt(ratio);
    const gr = (Math.sqrt(5) - 1) / 2;
    let x1 = b - (b - a) * gr;
    let x2 = a + (b - a) * gr;
    let f1 = cost(x1);
    let f2 = cost(x2);
    for (let i = 0; i < 80 && b - a > 1e-9; i++) {
      if (f1 <= f2) {
        b = x2; x2 = x1; f2 = f1;
        x1 = b - (b - a) * gr; f1 = cost(x1);
      } else {
        a = x1; x1 = x2; f1 = f2;
        x2 = a + (b - a) * gr; f2 = cost(x2);
      }
    }
    const refined = (a + b) * 0.5;
    return cost(refined) <= bestC ? refined : bestT;
  }

  /**
   * Achievable miss distance at flight time τ with the optimal aim ray
   * (elevation-clamped to the hard stops when outside), plus the aim used.
   */
  private static missAtTau(
    c: { ax: number; ay: number; az: number; vx: number; vy: number; vz: number; k: number },
    s: number,
    tau: number
  ): number {
    const wv = BallisticTrajectoryEngine.w(c, tau);
    const rLen = Math.hypot(wv.wx, wv.wy, wv.wz);
    const horiz = Math.hypot(wv.wx, wv.wy);
    const el = Math.atan2(wv.wz, horiz) * RAD;
    const loE = BallisticTrajectoryEngine.ELEVATION_MIN_DEG;
    const hiE = BallisticTrajectoryEngine.ELEVATION_MAX_DEG;
    if (el >= loE && el <= hiE) return Math.abs(rLen - s * tau);
    // Aim ray outside the barrel's elevation cap: best legal aim keeps the
    // azimuth, clamps the elevation; miss is |w − s·τ·u_clamped|.
    const elR = clamp(el, loE, hiE) * DEG;
    const azR = Math.atan2(wv.wy, wv.wx);
    const ux = Math.cos(elR) * Math.cos(azR);
    const uy = Math.cos(elR) * Math.sin(azR);
    const uz = Math.sin(elR);
    const dx = wv.wx - s * tau * ux;
    const dy = wv.wy - s * tau * uy;
    const dz = wv.wz - s * tau * uz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * No-exact-solution report: aim at the constrained-optimal flight time,
   * elevation clamped to the hard stops; `recommendedMuzzleSpeedMps` carries
   * the minimum speed that WOULD make the intercept possible (HUD bracket /
   * Phase 4 feasibility gate).
   */
  private static constrainedReport(
    ctx: { ax: number; ay: number; az: number; vx: number; vy: number; vz: number; k: number },
    s: number,
    tauBest: number,
    minRequired: number
  ): TrajectorySolution {
    const wv = BallisticTrajectoryEngine.w(ctx, tauBest);
    const az = wrapDeg(Math.atan2(wv.wy, wv.wx) * RAD);
    const elRaw = Math.atan2(wv.wz, Math.hypot(wv.wx, wv.wy)) * RAD;
    const el = clamp(elRaw, BallisticTrajectoryEngine.ELEVATION_MIN_DEG, BallisticTrajectoryEngine.ELEVATION_MAX_DEG);
    // Report the miss of the CLAMPED legal aim ray (what the gun can actually do).
    const miss = BallisticTrajectoryEngine.missAtTau(ctx, s, tauBest);
    return {
      hasSolution: false,
      leadAzimuthDeg: az,
      leadElevationDeg: el,
      recommendedMuzzleSpeedMps: minRequired,
      estimatedFlightTimeS: tauBest,
      predictedMissDistanceM: miss,
    };
  }
}
