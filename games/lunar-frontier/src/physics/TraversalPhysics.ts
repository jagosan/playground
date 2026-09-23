/**
 * Lunar Frontier — unified traversal physics engine.
 *
 * One deterministic, framework-free module covering every way a prospector
 * crosses the frontier:
 *
 *  1. **EVA suit** — lunar gravity (1.62 m/s²), walk/run/hop over regolith
 *     with low-g friction and slip, ballistic arc jumps, RCS thruster bursts
 *     for micro-maneuvering and descent softening, and oxygen / suit-battery
 *     depletion driven by exertion.
 *  2. **Open-top lunar buggy** — four independent spring-damper corners,
 *     regolith tyre traction with a simplified Pacejka (arc-tangent) slip
 *     curve, drive motor torque with continuous-power derating, regenerative
 *     braking, cargo-mass inertia scaling up to a 500 kg mineral load, and
 *     low-gravity rollover stability that degrades as cargo raises the
 *     centre of mass.
 *  3. **Subterranean rail** — ore train / rail car waypoint traversal along
 *     `RailRoute` node chains from `LunarWorldGenerator` (world frame:
 *     `x`/`y` lateral, `z` = elevation, `z < 0` subterranean), including
 *     grade resistance on inclined shaft descents, Davis train resistance,
 *     and pneumatic braking with fade from brake-heat soak.
 *  4. **Modal transitions** — proximity mount / dismount between suit and
 *     buggy driver seat, and boarding / alighting rail cars at stations.
 *
 * The module is pure simulation: no clocks, no randomness, no I/O. Callers
 * drive it with `step(dt, commands)` and a ground-elevation sampler.
 *
 * Coordinate convention matches `LunarWorldGenerator`: metres, `z` up.
 *
 * Usage:
 *   const physics = new TraversalPhysics({ groundElevation: () => 0 });
 *   physics.getSuite().setState({ x: 0, y: 0, z: 20, zUp: ... }); // see SuitState
 *   const snap = physics.step(1 / 60, { suit: { forward: 1, jump: true } });
 */

import type { RailRoute, Vec3 } from '../world/LunarWorldGenerator';

// ---------------------------------------------------------------------------
// Shared constants & small maths
// ---------------------------------------------------------------------------

/** Lunar surface gravitational acceleration (m/s²). */
export const LUNAR_GRAVITY = 1.62;

/** Moon-to-Earth surface gravity ratio. */
export const EARTH_GRAVITY = 9.81;

/** Generic low-regolith-cohesion tyre–soil friction coefficient. */
export const REGOLITH_MU = 0.68;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapAngle(a: number): number {
  let x = a + Math.PI;
  if (x >= 0) {
    x %= Math.PI * 2;
  } else {
    x = Math.PI * 2 - ((-x) % (Math.PI * 2));
  }
  return x - Math.PI;
}

/** Smooth arc-tangent saturation used by the Pacejka-style slip curves. */
function atanCurve(x: number): number {
  return (2 / Math.PI) * Math.atan(x);
}

function approach(current: number, target: number, rate: number, dt: number): number {
  const k = 1 - Math.exp(-rate * dt);
  return current + (target - current) * k;
}

/** Ground elevation sampler: height of the local surface at (x, y), metres. */
export type GroundElevationFn = (x: number, y: number) => number;

// ---------------------------------------------------------------------------
// Two-tier physics environments (Spec 17 §2.1)
// ---------------------------------------------------------------------------

/**
 * A complete gravity + surface-material preset the buggy's physics runs in
 * (Spec 17 §2.1). `ENV_LUNAR_FRONTIER` reproduces the legacy hard-coded
 * lunar numbers; `ENV_EARTH_PROVING_GROUNDS` re-tunes the same chassis for
 * the terrestrial test track (asphalt, 1 g, real aerodynamic drag).
 */
export interface EnvironmentProfile {
  name: 'earth_proving_grounds' | 'lunar_frontier';
  /** Local gravitational acceleration (m/s²). Earth: 9.81, Moon: 1.62. */
  gravity: number;
  /** Peak tyre–surface friction coefficient (Asphalt 1.05, Regolith 0.68). */
  surfaceFrictionMu: number;
  /** Aerodynamic drag area CdA (m²). 0.45 Earth air, 0.0 Moon vacuum. */
  airResistanceCdA: number;
  /** Tyre rolling resistance coefficient (0.015 asphalt, 0.035 regolith). */
  tireRollingResistance: number;
}

/** Terrestrial proving grounds: asphalt, 1 g, real air (Spec 17 §2.1). */
export const ENV_EARTH_PROVING_GROUNDS: EnvironmentProfile = {
  name: 'earth_proving_grounds',
  gravity: 9.81,
  surfaceFrictionMu: 1.05,
  airResistanceCdA: 0.45,
  tireRollingResistance: 0.015,
};

/** Lunar frontier surface: regolith, 1/6 g, vacuum (Spec 17 §2.1). */
export const ENV_LUNAR_FRONTIER: EnvironmentProfile = {
  name: 'lunar_frontier',
  gravity: 1.62,
  surfaceFrictionMu: 0.68,
  airResistanceCdA: 0.0,
  tireRollingResistance: 0.035,
};

/** Standard sea-level air density for the CdA drag law ρ (kg/m³, Spec 17 §2.1). */
export const DRAG_RHO_AIR = 1.225;

const FLAT_GROUND: GroundElevationFn = () => 0;

// ---------------------------------------------------------------------------
// 1. EVA suit physics
// ---------------------------------------------------------------------------

/** Lunar gravity constant re-exported under the suit-facing name. */
export const SUIT_GRAVITY = LUNAR_GRAVITY;
/** Walking pace on compacted regolith (m/s). */
export const SUIT_WALK_SPEED = 1.6;
/** Run — the loping bound prospectors use in 1/6 g (m/s). */
export const SUIT_RUN_SPEED = 4.0;
/** Ground acceleration authority (m/s²). */
export const SUIT_GROUND_ACCEL = 4.0;
/** Weak suit-jet assistance while airborne (m/s²). */
export const SUIT_AIR_ACCEL = 0.6;
/** Vertical take-off impulse applied on a hop (m/s). */
export const SUIT_JUMP_VELOCITY = 2.6;
/** Horizontal boost multiplier applied while hopping. */
export const SUIT_HOP_BOOST = 1.35;
/** RCS translational acceleration during a burst (m/s²). */
export const SUIT_RCS_ACCEL = 2.4;
/** RCS attitude rates (rad/s). */
export const SUIT_RCS_YAW_RATE = 1.6;
export const SUIT_RCS_PITCH_RATE = 1.0;
/** Yaw steering rate on the ground, independent of RCS (rad/s). */
export const SUIT_TURN_RATE = 1.8;
/** Fraction of lateral velocity retained per second on regolith (slip). */
export const SUIT_LATERAL_SLIP_RETENTION = 0.35;
/** Life-support maxima. */
export const SUIT_MAX_OXYGEN = 100;
export const SUIT_MAX_BATTERY = 100;
export const SUIT_MAX_RCS_FUEL = 100;
/** Base metabolic oxygen draw (units/s) and per-unit-exertion adders. */
export const SUIT_O2_BASE = 0.05;
export const SUIT_O2_EXERTION = 0.12;
export const SUIT_O2_RCS = 0.04;
/**
 * Dynamic metabolic respiration (TASK-PLAY-060, spec §3.7): gait-gated
 * multipliers on the baseline O₂ draw. Idle breathes at 1×, a brisk lunar
 * walk at ~1.8×, the full sprint-lope at ~4.5×, and a suit plugged into
 * vehicle life support (umbilical) drops to 0.35×.
 */
export const SUIT_METABOLIC_IDLE = 1.0;
export const SUIT_METABOLIC_WALK = 1.8;
export const SUIT_METABOLIC_SPRINT = 4.5;
export const SUIT_METABOLIC_MOUNTED = 0.35;
/** Speed gates for the metabolic gait bands (m/s). */
export const SUIT_METABOLIC_WALK_V = 0.5;
export const SUIT_METABOLIC_SPRINT_V = 2.5;
/** Suit battery draw (units/s): PLSS heaters, lamps, comms, exertion, RCS. */
export const SUIT_BAT_LIFE_SUPPORT = 0.035;
export const SUIT_BAT_EXERTION = 0.08;
export const SUIT_BAT_RCS = 0.12;
/** Minimum RCS pulse the valve assembly can deliver (s). */
export const SUIT_RCS_MIN_PULSE_S = 0.12;
/** RCS vertical cut-off that counts as "descent softened" (m/s). */
export const SUIT_SOFT_LANDING_VY = -0.5;
/** When oxygen or battery bottoms out, muscles still work — slowly. */
export const SUIT_INCAPACITATED_SCALE = 0.35;

export interface SuitInput {
  /** -1..1 throttle along heading. */
  forward: number;
  /** -1..1 strafe. */
  strafe: number;
  /** -1..1 yaw steer (ground) / attitude (RCS). */
  yaw: number;
  /** -1..1 pitch attitude (RCS only). */
  pitch: number;
  /** Rising edge while grounded triggers a hop. */
  jump: boolean;
  /** Master RCS enable for the frame (thruster burst). */
  rcs: boolean;
  /** -1..1 RCS thrust along heading. */
  rcsForward: number;
  /** -1..1 RCS thrust lateral. */
  rcsStrafe: number;
  /** -1..1 RCS thrust vertical (positive up — softens descents). */
  rcsUp: number;
}

export const IDLE_SUIT_INPUT: Readonly<SuitInput> = {
  forward: 0,
  strafe: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  rcs: false,
  rcsForward: 0,
  rcsStrafe: 0,
  rcsUp: 0,
};

export interface SuitState {
  /** Lateral position (m). */
  x: number;
  y: number;
  /** Elevation of the suit centre (m; z up, matches LunarWorldGenerator). */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Heading in the x-y plane, radians, 0 = +x. */
  heading: number;
  /** Look / attitude pitch, radians. */
  pitch: number;
  isGrounded: boolean;
  /** Last applied vertical launch impulse (diagnostics / animation). */
  jumpImpulse: number;
  oxygen: number;
  battery: number;
  rcsFuel: number;
}

export interface SuitExertion {
  /** Horizontal speed (m/s). */
  speed: number;
  /** Vertical speed (m/s). */
  climbRate: number;
  /** RCS valve open fraction this frame (0..1). */
  rcsUsage: number;
  /** Combined 0..1 effort estimate. */
  exertion: number;
}

/** Optional per-frame context for `LunarEvaSuit.step`. */
export interface SuitStepOptions {
  /**
   * Umbilical support (TASK-PLAY-060, spec §3.7): the suit is plugged into
   * vehicle life support, so metabolic O₂ draw scales to
   * `SUIT_METABOLIC_MOUNTED` (0.35×) regardless of gait.
   */
  mounted?: boolean;
}

/**
 * Gait-gated metabolic respiration multiplier (TASK-PLAY-060, spec §3.7).
 * Mounted on vehicle life support beats everything (0.35×); otherwise the
 * breath follows the gait: idle 1×, walk (>0.5 m/s) 1.8×, sprint (>2.5 m/s)
 * 4.5×. Airborne coasting is not exertion — the hop already paid for itself.
 */
export function metabolicMultiplier(
  speed: number,
  isGrounded: boolean,
  mounted = false,
): number {
  if (mounted) return SUIT_METABOLIC_MOUNTED;
  if (!isGrounded) return SUIT_METABOLIC_IDLE;
  if (speed > SUIT_METABOLIC_SPRINT_V) return SUIT_METABOLIC_SPRINT;
  if (speed > SUIT_METABOLIC_WALK_V) return SUIT_METABOLIC_WALK;
  return SUIT_METABOLIC_IDLE;
}

/**
 * Astronaut EVA suit physics: grounded locomotion with regolith friction and
 * slip, ballistic low-g arcs, RCS micro-maneuvering / descent softening, and
 * exertion-scaled oxygen + battery depletion.
 */
export class LunarEvaSuit {
  private state: SuitState;
  private jumpWasHeld = false;
  /**
   * Spec 21 §2.4 vault loot ("Advanced Prospector EVA Suit"): an instance
   * rebreather ceiling, at or above the base {@link SUIT_MAX_OXYGEN}. The
   * step() clamp reads this, so an upgrade persists across frames.
   */
  private oxygenCap: number = SUIT_MAX_OXYGEN;
  /** Accumulated RCS valve-open time across the whole session (s). */
  public rcsPulseSeconds = 0;

  constructor(initial: Partial<SuitState> = {}) {
    this.state = {
      x: initial.x ?? 0,
      y: initial.y ?? 0,
      z: initial.z ?? 0,
      vx: initial.vx ?? 0,
      vy: initial.vy ?? 0,
      vz: initial.vz ?? 0,
      heading: initial.heading ?? 0,
      pitch: initial.pitch ?? 0,
      isGrounded: initial.isGrounded ?? false,
      jumpImpulse: initial.jumpImpulse ?? 0,
      oxygen: initial.oxygen ?? SUIT_MAX_OXYGEN,
      battery: initial.battery ?? SUIT_MAX_BATTERY,
      rcsFuel: initial.rcsFuel ?? SUIT_MAX_RCS_FUEL,
    };
    if (initial.isGrounded !== true && this.state.vz === 0) {
      // Unset vertical velocity while airborne would fake a hover; drop freely.
      this.state.vz = 0;
    }
  }

  public getState(): SuitState {
    return { ...this.state };
  }

  public setState(patch: Partial<SuitState>): void {
    this.state = { ...this.state, ...patch };
  }

  /** Current rebreather ceiling (base {@link SUIT_MAX_OXYGEN} units). */
  public getOxygenCapacity(): number {
    return this.oxygenCap;
  }

  /**
   * Spec 21 §2.4 vault upgrade: multiply the rebreather ceiling (duration
   * scales 1:1 with capacity) and top the tank back up. Returns the new cap.
   */
  public upgradeOxygen(multiplier = 2): number {
    this.oxygenCap = Math.max(this.oxygenCap, this.oxygenCap * Math.max(1, multiplier));
    this.state.oxygen = this.oxygenCap;
    return this.oxygenCap;
  }

  /** Advance the suit one timestep. `ground` is surface elevation underfoot. */
  public step(
    dt: number,
    input: SuitInput = IDLE_SUIT_INPUT,
    ground: GroundElevationFn = FLAT_GROUND,
    options: SuitStepOptions = {},
  ): SuitState {
    const s = this.state;
    const step = clamp(dt, 0, 0.25);

    const incapacitated = s.oxygen <= 0 || s.battery <= 0;
    const authority = incapacitated ? SUIT_INCAPACITATED_SCALE : 1;

    const fwd = clamp(input.forward, -1, 1) * authority;
    const strafe = clamp(input.strafe, -1, 1) * authority;

    // -- Ground contact -----------------------------------------------------
    const groundZ = ground(s.x, s.y);
    const wasGrounded = s.isGrounded;

    // -- Heading ------------------------------------------------------------
    s.heading = wrapAngle(s.heading + clamp(input.yaw, -1, 1) * SUIT_TURN_RATE * (wasGrounded ? 1 : 0.15) * step);

    // -- Body-frame desired velocity ---------------------------------------
    const magnitude = clamp(Math.hypot(fwd, strafe), 0, 1);
    const gaitSpeed = Math.abs(fwd) > 0.6 ? SUIT_RUN_SPEED : SUIT_WALK_SPEED;
    let targetLocalX = 0;
    let targetLocalY = 0;
    if (magnitude > 1e-4) {
      const speed = gaitSpeed * magnitude;
      const inv = 1 / Math.hypot(fwd, strafe);
      targetLocalX = fwd * inv * speed;
      targetLocalY = strafe * inv * speed;
    }

    // Rotate target into world frame.
    const ch = Math.cos(s.heading);
    const sh = Math.sin(s.heading);
    const targetVx = targetLocalX * ch - targetLocalY * sh;
    const targetVy = targetLocalX * sh + targetLocalY * ch;

    // -- Horizontal drive ----------------------------------------------------
    const accel = s.isGrounded ? SUIT_GROUND_ACCEL : SUIT_AIR_ACCEL;
    if (magnitude > 1e-4) {
      s.vx = approach(s.vx, targetVx, accel / Math.max(1, Math.abs(targetVx)), step)
        + (targetVx - s.vx) * 0 + accel * step * Math.sign(targetVx - s.vx) * 0;
      // Explicit first-order chase (the line above keeps approach() semantics):
      s.vx = approach(s.vx, targetVx, accel / Math.max(1.2, Math.abs(targetVx)), step);
      s.vy = approach(s.vy, targetVy, accel / Math.max(1.2, Math.abs(targetVy)), step);
    } else if (s.isGrounded) {
      // Regolith friction while coasting: exponential decay, but loose grit
      // keeps lateral momentum partly alive (the slip prospectors curse).
      const decay = Math.exp(-2.6 * step);
      const slipKeep = Math.exp(-(1 - SUIT_LATERAL_SLIP_RETENTION) * 4 * step);
      const along = s.vx * ch + s.vy * sh;
      const latX = s.vx - along * ch;
      const latY = s.vy - along * sh;
      const newAlong = along * decay;
      s.vx = newAlong * ch + latX * slipKeep;
      s.vy = newAlong * sh + latY * slipKeep;
    }

    // -- RCS burst (micro-maneuvering, descent softening) --------------------
    let rcsUsage = 0;
    const wantsRcs = input.rcs && s.rcsFuel > 0;
    if (wantsRcs) {
      const rf = clamp(input.rcsForward, -1, 1);
      const rs = clamp(input.rcsStrafe, -1, 1);
      const ru = clamp(input.rcsUp, -1, 1);
      const magnitudeRcs = clamp(Math.hypot(rf, rs, ru), 0, 1);
      if (magnitudeRcs > 1e-3) {
        s.vx += (rf * ch - rs * sh) * SUIT_RCS_ACCEL * step;
        s.vy += (rf * sh + rs * ch) * SUIT_RCS_ACCEL * step;
        s.vz += ru * SUIT_RCS_ACCEL * step;
        rcsUsage = magnitudeRcs;
        s.rcsFuel = Math.max(0, s.rcsFuel - 6 * rcsUsage * step);
        this.rcsPulseSeconds += step;
      }
      s.heading = wrapAngle(s.heading + clamp(input.yaw, -1, 1) * SUIT_RCS_YAW_RATE * step);
      s.pitch = clamp(s.pitch + clamp(input.pitch, -1, 1) * SUIT_RCS_PITCH_RATE * step, -1.2, 1.2);
    } else {
      s.pitch = approach(s.pitch, 0, 2, step);
    }

    // -- Hop (rising edge, grounded only) -------------------------------------
    if (input.jump && !this.jumpWasHeld && s.isGrounded) {
      s.vz = SUIT_JUMP_VELOCITY;
      s.jumpImpulse = SUIT_JUMP_VELOCITY;
      s.isGrounded = false;
      // Lope: convert part of the crouch into horizontal reach.
      const horiz = Math.hypot(s.vx, s.vy);
      if (horiz > 0.05) {
        const boost = Math.max(SUIT_HOP_BOOST, (horiz + 0.8) / Math.max(horiz, 1e-3));
        s.vx *= Math.min(boost, SUIT_HOP_BOOST);
        s.vy *= Math.min(boost, SUIT_HOP_BOOST);
      }
    }
    this.jumpWasHeld = input.jump;

    // -- Ballistics -----------------------------------------------------------
    s.vz -= LUNAR_GRAVITY * step;

    s.x += s.vx * step;
    s.y += s.vy * step;
    s.z += s.vz * step;

    // -- Landing ---------------------------------------------------------------
    const newGround = ground(s.x, s.y);
    const floorZ = newGround; // suit centre rides `floorZ` when crouched on surface
    if (s.z <= floorZ) {
      s.z = floorZ;
      if (s.vz < 0) s.vz = 0;
      s.isGrounded = true;
    } else if (s.z - floorZ > 0.08) {
      s.isGrounded = false;
    }
    void wasGrounded;

    // -- Life support ----------------------------------------------------------
    const speed = Math.hypot(s.vx, s.vy);
    const moving = speed > 0.08 && s.isGrounded;
    const exertion = clamp(
      (moving ? (speed / SUIT_RUN_SPEED) * Math.abs(fwd || 1) : 0) + rcsUsage * 0.6,
      0,
      1.5,
    );
    // Dynamic metabolic respiration (TASK-PLAY-060, spec §3.7): the breath
    // follows the gait — idle baseline, ~1.8× walking, ~4.5× sprinting — and
    // drops to 0.35× on the vehicle umbilical.
    const metabolic = metabolicMultiplier(speed, s.isGrounded, options.mounted === true);
    s.oxygen = clamp(
      s.oxygen - (SUIT_O2_BASE * metabolic + SUIT_O2_EXERTION * exertion + SUIT_O2_RCS * rcsUsage) * step,
      0,
      this.oxygenCap,
    );
    s.battery = clamp(
      s.battery - (SUIT_BAT_LIFE_SUPPORT + SUIT_BAT_EXERTION * exertion + SUIT_BAT_RCS * rcsUsage) * step,
      0,
      SUIT_MAX_BATTERY,
    );

    return this.getState();
  }

  public getExertion(input: SuitInput = IDLE_SUIT_INPUT): SuitExertion {
    const s = this.state;
    const speed = Math.hypot(s.vx, s.vy);
    const rcs = input.rcs ? clamp(Math.hypot(input.rcsForward, input.rcsStrafe, input.rcsUp), 0, 1) : 0;
    return {
      speed,
      climbRate: s.vz,
      rcsUsage: rcs,
      exertion: clamp((speed / SUIT_RUN_SPEED) * (s.isGrounded ? 1 : 0.4) + rcs * 0.6, 0, 1.5),
    };
  }
}

// ---------------------------------------------------------------------------
// 2. Open-top lunar buggy physics
// ---------------------------------------------------------------------------

/** Unsprung+sprung chassis mass without cargo (kg). */
export const BUGGY_CHASSIS_MASS = 880;
/** Maximum mineral cargo the flatbed carries (kg, spec: 500). */
export const BUGGY_MAX_CARGO = 500;
/** Wheel radius (m). */
export const BUGGY_WHEEL_RADIUS = 0.45;
/** Track width — hub to hub (m). */
export const BUGGY_TRACK = 1.7;
/** Per-corner suspension spring rate (N/m). */
export const BUGGY_SPRING_RATE = 4_200;
/** Per-corner damper coefficient (N·s/m) — tuned for critical damping (zeta ~ 0.707) under lunar gravity. */
export const BUGGY_DAMPER = 1360;
/** Suspension travel from static ride (m). */
export const BUGGY_SPRING_TRAVEL = 0.2;
/** Peak tyre force per unit normal load (regolith, simplified Pacejka peak). */
export const BUGGY_MU_PEAK = REGOLITH_MU;
/** Slip ratio at which peak traction occurs (simplified Pacejka shaping). */
export const BUGGY_SLIP_PEAK = 0.14;
/**
 * Peak wheel force at the contact patch, drive OR brake (N). Spec 16 §2.5
 * raises this to 3,800 N/wheel (15.2 kN AWD launch traction): the wheel is a
 * geared ground-implement — grousers engage regolith mechanically, so the
 * active longitudinal force is governed by this drivetrain limit rather than
 * the passive soil friction circle.
 */
export const BUGGY_WHEEL_FORCE = 3_800;
/** Per-motor continuous power limit (W) — 72 kW quad-motor AWD (spec 16 §2.5). */
export const BUGGY_MOTOR_POWER = 18_000;
/** Peak motor regenerative braking force (N, total, spec 16 §2.6). */
export const BUGGY_REGEN_FORCE = 8_000;
/** Peak friction (service) brake force at the road wheels (N, total, spec 16 §2.6). */
export const BUGGY_BRAKE_FORCE = 14_000;
/**
 * Front-axle share of total service-brake force (Spec 17 §2.3.2):
 * F_front = 0.62·F_total, F_rear = 0.38·F_total.
 */
export const BUGGY_BRAKE_BIAS_FRONT = 0.62;
/** Rear-axle share of total service-brake force (Spec 17 §2.3.2). */
export const BUGGY_BRAKE_BIAS_REAR = 0.38;
/** Wheel slip ratio below which ABS pulse-modulates that corner's brake (Spec 17 §2.3.2, s_i < −0.25). */
export const BUGGY_ABS_SLIP_THRESHOLD = -0.25;
/** Below this ground speed ABS stands down — pulse-braking a crawl is pointless (Spec 17 §2.3.2, 1.0 m/s). */
export const BUGGY_ABS_MIN_SPEED = 1.0;
/** ABS release/re-apply cadence (Hz) (Spec 17 §2.3.2). */
export const BUGGY_ABS_PULSE_HZ = 15;
/** Fraction of the ABS pulse period the brake valve stays applied while a wheel is locked. */
export const BUGGY_ABS_DUTY = 0.5;
/**
 * Release-phase brake-torque scale while a wheel is ABS-modulated (Spec 17
 * §2.3.2). Below the traction cap by design, so the sliding patch re-rotates
 * the wheel to rolling inside the release window; the re-apply phase hands
 * full demand back and the 15 Hz cadence repeats.
 */
export const BUGGY_ABS_RELEASE_SCALE = 0.6;
/** Effective lumped wheel+hub polar inertia for brake lock-up spin-down (kg·m²). */
export const BUGGY_WHEEL_INERTIA = 0.9;
/**
 * Front-axle lateral cornering stiffness multiplier (Spec 17 §2.2.3).
 * The rear runs HIGHER stiffness (1.15×) so the front saturates first and
 * the buggy exhibits progressive understeer instead of snap-oversteer.
 */
export const BUGGY_LATERAL_STIFFNESS_FRONT = 1.0;
/** Rear-axle lateral cornering stiffness multiplier — higher than front (Spec 17 §2.2.3). */
export const BUGGY_LATERAL_STIFFNESS_REAR = 1.15;
/** Throttle torque rise approach rate (1/s) — spec 16 §2.5 (was 4.0). */
export const BUGGY_THROTTLE_RISE = 12.0;
/**
 * @deprecated Spec-15/16 band law superseded by Spec 17 §2.2.1
 * (`speedSensitiveSteerLock`). Kept exported for API compatibility; the
 * steering model no longer reads it.
 */
export const BUGGY_STEER_FULL_LOCK_V = 3.0;
/**
 * Low-speed steering lock δ_low (rad) — 45° (Spec 17 §2.2.1). The mechanical
 * maximum road-wheel angle at standstill for tight turnaround maneuvers.
 */
export const BUGGY_STEER_LOCK_LOW = (45 * Math.PI) / 180; // 0.785398 rad
/**
 * High-speed steering lock δ_high (rad) — 14° (Spec 17 §2.2.1). The lock the
 * law asymptotes toward at speed to prevent spinouts.
 */
export const BUGGY_STEER_LOCK_HIGH = (14 * Math.PI) / 180; // 0.244346 rad
/** Half-lock speed (m/s) (Spec 17 §2.2.1): δmax sits midway between the two locks here. */
export const BUGGY_STEER_HALF_SPEED = 10.0;
/**
 * Speed-sensitive maximum road-wheel steering angle (rad) (Spec 17 §2.2.1):
 * δmax(v) = δ_high + (δ_low − δ_high) / (1 + (v / v_steer_half)²).
 */
export function speedSensitiveSteerLock(v: number): number {
  const speed = Math.abs(v);
  const ratio = 1 / (1 + (speed / BUGGY_STEER_HALF_SPEED) * (speed / BUGGY_STEER_HALF_SPEED));
  return BUGGY_STEER_LOCK_HIGH + (BUGGY_STEER_LOCK_LOW - BUGGY_STEER_LOCK_HIGH) * ratio;
}
/** Low-speed torque-vectoring / skid-steer assist moment (N·m, spec 16 §2.6).
 *  Re-cut to 18 kN·m by Spec 17 Phase 6: with the forensically-corrected tyre
 *  corner velocity (§2.2.3 v_{y,i} — ω×r now reaches the slip angle), a
 *  pivoting chassis scrubs real μ·N friction at all four corners, ≈12 kN·m on
 *  Earth asphalt at the pivot rate. The assist envelope must exceed THAT
 *  (per surface, per gravity) for the §7.1 turnaround gate (180° < 2.2 s) to
 *  be reachable in both presets; the (1 − |v|/4) taper still starves it out
 *  completely above the low-speed regime. Lunar scrub is only ~1.3 kN·m, so
 *  the lunar pivot stays tracking-rate-limited, never torque-limited. */
export const BUGGY_YAW_ASSIST_TORQUE = 18_000;
/** Assist cut-off speed (m/s): M = sign(δ)·τ·(1 − |v|/4.0), zero at/above this (spec 16 §2.6). */
export const BUGGY_YAW_ASSIST_SPEED = 4.0;
/** Assist yaw-rate saturation (rad/s) — the pivot bites once the regolith gives. */
export const BUGGY_YAW_ASSIST_MAX_RATE = 1.8;
/** Brake-hold window (m/s): throttle intent flips the drive direction instantly inside it (spec 16 §2.6). */
export const BUGGY_REVERSE_ENGAGE_V = 0.4;
/** Regenerator round-trip efficiency. */
export const BUGGY_REGEN_EFFICIENCY = 0.62;
/** Rolling resistance coefficient into loose regolith (Spec 15: 0.04). */
export const BUGGY_ROLLING_RESISTANCE = 0.04;
/** Regolith plume drag coefficient (∝ v², no atmosphere but saltating grit). */
export const BUGGY_DRAG = 0.25;
/** Electronic speed limiter (m/s). */
export const BUGGY_SPEED_LIMIT = 22;
/** Reverse speed limiter (m/s, Spec 15: 5.0 m/s). */
export const BUGGY_REVERSE_SPEED_LIMIT = 5.0;
/** Onboard traction battery (kWh). */
export const BUGGY_BATTERY_KWH = 2.2;
/** Max road-wheel steering angle (rad) — 45° low-speed lock (spec 16 §2.6, was 0.55). */
export const BUGGY_MAX_STEER = 0.78;
/** Roll-over stability index at zero cargo: a_lat / g. */
export const BUGGY_EMPTY_ROLLOVER_INDEX = BUGGY_TRACK / (2 * 0.75);

/** Corner local coordinates: x forward, y left (right-hand yaw +). */
const WHEEL_LOCAL: ReadonlyArray<{ x: number; y: number }> = [
  { x: 1.35, y: 0.85 }, // 0: front-right (y negative below via sign)
];
void WHEEL_LOCAL;

const CORNERS: ReadonlyArray<{ fx: number; fy: number }> = [
  { fx: 1.35, fy: 0.85 },
  { fx: 1.35, fy: -0.85 },
  { fx: -1.35, fy: 0.85 },
  { fx: -1.35, fy: -0.85 },
];

export interface BuggyInput {
  /** -1..1 drive throttle (negative = reverse when nearly stopped). */
  throttle: number;
  /** 0..1 friction brake. */
  brake: number;
  /** 0..1 regen-only braking (also auto-blended under brake). */
  regen: number;
  /** -1..1 steering. */
  steer: number;
  /** Hold the parking brake while parked. */
  parkBrake: boolean;
}

export const IDLE_BUGGY_INPUT: Readonly<BuggyInput> = {
  throttle: 0,
  brake: 0,
  regen: 0,
  steer: 0,
  parkBrake: true,
};

export interface WheelState {
  /** Suspension compression, 0 = fully drooped, 1 = bump stop (fraction). */
  compression: number;
  /** Dynamic vertical tyre load (N). */
  load: number;
  /** Longitudinal slip ratio. */
  slip: number;
  /** Road wheel spin rate (rad/s). */
  spin: number;
  /** Tyre force this frame (N). */
  force: number;
}

export interface BuggyState {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Body-frame longitudinal velocity (m/s, + forward). */
  vLong: number;
  /** Body-frame lateral velocity (m/s, + left). */
  vLat: number;
  /** Vertical chassis velocity (m/s). */
  vBody: number;
  yawRate: number;
  /** Chassis datum height above local ground (m). */
  bodyHeight: number;
  roll: number;
  pitch: number;
  cargoMass: number;
  wheels: [WheelState, WheelState, WheelState, WheelState];
  batteryKwh: number;
  regenEnergyJ: number;
  motorEnergyJ: number;
  /** True when the buggy tipped onto its roll bar — needs a winch. */
  rolled: boolean;
  airborne: boolean;
  /** Active drive mode (FORWARD, STOPPED, REVERSE). */
  driveMode?: 'FORWARD' | 'STOPPED' | 'REVERSE';
  /** Mean front road-wheel steering angle (rad). */
  steerAngle?: number;
}

export interface BuggyOptions {
  chassisMass?: number;
  groundElevation?: GroundElevationFn;
  initialCargo?: number;
  batteryKwh?: number;
  /**
   * Active physics environment (Spec 17 §2.1). Defaults to
   * `ENV_LUNAR_FRONTIER` — the legacy hard-coded lunar constants — so
   * existing callers and tests step in exactly the same gravity well.
   */
  environment?: EnvironmentProfile;
}

function zeroWheel(): WheelState {
  return { compression: 0, load: 0, slip: 0, spin: 0, force: 0 };
}

/**
 * Open-top lunar buggy: 4-wheel independent spring-damper suspension,
 * simplified Pacejka regolith traction, motor + regen, cargo inertia scaling
 * and low-gravity rollover stability.
 */
export class LunarBuggy {
  private readonly chassisMass: number;
  private readonly ground: GroundElevationFn;
  private readonly state: BuggyState;
  /**
   * Spec 21 §2.4 vault loot ("Auxiliary Buggy Fuel Cell"): instance traction
   * pack ceiling, at or above base {@link BUGGY_BATTERY_KWH}. step() clamps
   * against this, so the +kWh upgrade persists.
   */
  private batteryCapKwh: number = BUGGY_BATTERY_KWH;
  /** Active gravity/surface environment (Spec 17 §2.1); never null. */
  private env: EnvironmentProfile;
  /**
   * ABS wheel-lock state (Spec 17 §2.3.2): per-corner true while that wheel
   * is being pulse-modulated, plus a substep clock driving the 15 Hz pulse.
   */
  private readonly absLocked: boolean[] = [false, false, false, false];
  private absClock = 0;
  private motorTorque = 0;
  /** Leaky integrator of the pivot yaw-rate error (rad·s, Spec 17 Phase 6). */
  private pivotIntegral = 0;
  private driveMode: 'FORWARD' | 'STOPPED' | 'REVERSE' = 'STOPPED';
  private steerAngle = 0;
  /** Attitude rates (rad/s) realised last substep — feed suspension corner v_z. */
  private pitchRate = 0;
  private rollRate = 0;

  constructor(options: BuggyOptions = {}, initial: Partial<BuggyState> = {}) {
    this.chassisMass = options.chassisMass ?? BUGGY_CHASSIS_MASS;
    this.ground = options.groundElevation ?? FLAT_GROUND;
    // Spec 17 §2.1: the lunar preset reproduces the legacy hard-coded lunar
    // constants exactly, so an unset environment keeps every existing caller
    // (and the lunar smoke suite) bit-compatible.
    this.env = options.environment ?? ENV_LUNAR_FRONTIER;
    const cargo = clamp(initial.cargoMass ?? options.initialCargo ?? 0, 0, BUGGY_MAX_CARGO);
    this.state = {
      x: initial.x ?? 0,
      y: initial.y ?? 0,
      z: initial.z ?? 0,
      heading: initial.heading ?? 0,
      vLong: initial.vLong ?? 0,
      vLat: initial.vLat ?? 0,
      vBody: initial.vBody ?? 0,
      yawRate: initial.yawRate ?? 0,
      bodyHeight: initial.bodyHeight ?? BUGGY_WHEEL_RADIUS + 0.229,
      roll: initial.roll ?? 0,
      pitch: initial.pitch ?? 0,
      cargoMass: cargo,
      wheels: [zeroWheel(), zeroWheel(), zeroWheel(), zeroWheel()],
      batteryKwh: clamp(initial.batteryKwh ?? options.batteryKwh ?? BUGGY_BATTERY_KWH, 0, BUGGY_BATTERY_KWH),
      regenEnergyJ: initial.regenEnergyJ ?? 0,
      motorEnergyJ: initial.motorEnergyJ ?? 0,
      rolled: initial.rolled ?? false,
      airborne: initial.airborne ?? false,
    };
  }

  public getState(): BuggyState {
    return {
      ...this.state,
      driveMode: this.driveMode,
      steerAngle: this.steerAngle,
      wheels: this.state.wheels.map((w) => ({ ...w })) as [WheelState, WheelState, WheelState, WheelState],
    };
  }

  /**
   * Swap the active physics environment mid-run (Spec 17 §2.1 / §5): gravity,
   * surface friction μ, aerodynamic drag CdA and tyre rolling resistance all
   * follow the new profile from the next substep. Returns the profile now
   * active. Pass `ENV_EARTH_PROVING_GROUNDS` or `ENV_LUNAR_FRONTIER` (or a
   * derived clone with tuned fields).
   */
  public setEnvironment(profile: EnvironmentProfile): EnvironmentProfile {
    this.env = profile;
    return this.env;
  }

  /** The physics environment this buggy is currently simulating in. */
  public getEnvironment(): EnvironmentProfile {
    return this.env;
  }

  /**
   * True while any corner's wheel is wheel-locking and the ABS is pulse-
   * modulating its brake valve (Spec 17 §2.3.2) — drives the controller
   * brake-pulsing haptic and a dashboard ABS lamp.
   */
  public get absActive(): boolean {
    return this.absLocked.some((locked) => locked);
  }

  public get totalMass(): number {
    return this.chassisMass + this.state.cargoMass;
  }

  /** Centre-of-mass height above local ground — rises with cargo. */
  public get cogHeight(): number {
    return 0.62 + 0.28 * (this.state.cargoMass / BUGGY_MAX_CARGO);
  }

  /** Quasi-static lateral rollover threshold in units of g (lower = tippier). */
  public get rolloverThresholdG(): number {
    return BUGGY_TRACK / (2 * this.cogHeight);
  }

  /** Traction pack ceiling, kWh (base {@link BUGGY_BATTERY_KWH}). */
  public getBatteryCapacity(): number {
    return this.batteryCapKwh;
  }

  /**
   * Spec 21 §2.4 vault loot: bolt in an auxiliary fuel cell — the pack
   * ceiling grows by `extraKwh` and the battery is restored to 100 %.
   * Returns the new capacity.
   */
  public upgradeBatteryCapacity(extraKwh: number): number {
    if (Number.isFinite(extraKwh) && extraKwh > 0) {
      this.batteryCapKwh += extraKwh;
    }
    this.state.batteryKwh = this.batteryCapKwh;
    return this.batteryCapKwh;
  }

  /** Load the flatbed (clamped to `BUGGY_MAX_CARGO`). Returns cargo on board. */
  public loadCargo(kg: number): number {
    this.state.cargoMass = clamp(this.state.cargoMass + kg, 0, BUGGY_MAX_CARGO);
    return this.state.cargoMass;
  }

  public unloadAllCargo(): number {
    const dropped = this.state.cargoMass;
    this.state.cargoMass = 0;
    return dropped;
  }

  public right(): void {
    this.state.rolled = false;
    this.state.roll = 0;
  }

  /** Parked suspension settle — keeps an abandoned buggy resting correctly. */
  public settle(dt: number): void {
    this.step(dt, { ...IDLE_BUGGY_INPUT, parkBrake: true });
  }

  public step(dt: number, input: BuggyInput = IDLE_BUGGY_INPUT): BuggyState {
    const h = clamp(dt, 1 / 240, 1 / 120);
    let remaining = clamp(dt, 0, 0.5);
    while (remaining > 1e-9) {
      const sub = Math.min(h, remaining);
      this.substep(sub, input);
      remaining -= sub;
    }
    return this.getState();
  }

  private substep(dt: number, input: BuggyInput): void {
    const s = this.state;
    const m = this.totalMass;
    const cog = this.cogHeight;
    const env = this.env;
    const inertia = m * (1.35 * 1.35 + 0.85 * 0.85) * 0.9;
    const rollInertia = m * 0.55;

    const ch = Math.cos(s.heading);
    const sh = Math.sin(s.heading);

    // -- Spec 17 §5 Step C: gravity-scaled suspension -------------------------
    // BUGGY_SPRING_RATE / BUGGY_DAMPER are the LUNAR-tuned constants (the
    // legacy hard-coded 1.62 m/s² regime). Migrating the refined control
    // stack to the Earth Proving Grounds profile re-cuts the spring stiffness
    // by g/g_moon and the damping by its square root, so the static
    // compression fraction and damping ratio ζ stay invariant across gravity
    // wells. Unscaled, Earth weight (8.63 kN) overwhelms the full bottomed
    // spring stack (4 × 4200 × 0.2 × 2.5 = 8.4 kN) and the chassis sinks
    // through its own travel — the exact floaty/instrument-destroying be-
    // haviour §5 exists to eliminate. Lunar scale factor is exactly 1, so
    // every lunar caller stays bit-identical.
    const suspScale = env.gravity / LUNAR_GRAVITY;
    const springK = BUGGY_SPRING_RATE * suspScale;
    const damperC = BUGGY_DAMPER * Math.sqrt(suspScale);

    // -- Roll / pitch attitude -> corner chassis heights ---------------------
    const cr = Math.cos(s.roll);
    const sr = Math.sin(s.roll);
    const cp = Math.cos(s.pitch);

    // -- Road gradient under the vehicle (for slope gravity) -----------------
    const ahead = this.ground(s.x + 2 * ch, s.y + 2 * sh);
    const behind = this.ground(s.x - 2 * ch, s.y - 2 * sh);
    const right = this.ground(s.x - 2 * sh, s.y + 2 * ch);
    const here = this.ground(s.x, s.y);
    const slopePitch = Math.atan2(ahead - behind, 4);
    const slopeRoll = Math.atan2(here - right, 2);

    // -- Drive mode state machine & smooth powertrain ------------------------
    const speedRef = Math.hypot(s.vLong, s.vLat);
    const rawThrottle = clamp(input.throttle, -1, 1);
    const rawBrake = clamp(input.brake, 0, 1);

    if (this.driveMode === 'FORWARD') {
      if (s.vLong <= BUGGY_REVERSE_ENGAGE_V && rawThrottle < -0.05) {
        this.driveMode = 'REVERSE';
      } else if (Math.abs(s.vLong) < 0.2 && Math.abs(rawThrottle) <= 0.05) {
        this.driveMode = 'STOPPED';
      }
    } else if (this.driveMode === 'STOPPED') {
      if (rawThrottle > 0.05) {
        this.driveMode = 'FORWARD';
      } else if (rawThrottle < -0.05) {
        this.driveMode = 'REVERSE';
      }
    } else if (this.driveMode === 'REVERSE') {
      if (s.vLong >= -BUGGY_REVERSE_ENGAGE_V && rawThrottle > 0.05) {
        this.driveMode = 'FORWARD';
      } else if (Math.abs(s.vLong) < 0.2 && Math.abs(rawThrottle) <= 0.05) {
        this.driveMode = 'STOPPED';
      }
    }

    let targetTorqueDemand = 0;
    let serviceBrakeDemand = rawBrake;

    if (this.driveMode === 'FORWARD') {
      if (rawThrottle > 0) {
        targetTorqueDemand = rawThrottle;
      } else if (rawThrottle < 0) {
        serviceBrakeDemand = Math.max(serviceBrakeDemand, -rawThrottle);
      }
    } else if (this.driveMode === 'REVERSE') {
      if (rawThrottle < 0) {
        targetTorqueDemand = rawThrottle;
      } else if (rawThrottle > 0) {
        serviceBrakeDemand = Math.max(serviceBrakeDemand, rawThrottle);
      }
    } else {
      if (rawThrottle > 0) {
        this.driveMode = 'FORWARD';
        targetTorqueDemand = rawThrottle;
      } else if (rawThrottle < 0) {
        this.driveMode = 'REVERSE';
        targetTorqueDemand = rawThrottle;
      }
    }

    if (this.state.rolled) targetTorqueDemand = 0;
    if (s.vLong > BUGGY_SPEED_LIMIT && targetTorqueDemand > 0) targetTorqueDemand = 0;
    if (s.vLong < -BUGGY_REVERSE_SPEED_LIMIT && targetTorqueDemand < 0) targetTorqueDemand = 0;
    // Brake-priority override (spec 16 §2.6): pedal pressure scales drive torque
    // out so the 14 kN friction brake does the stopping instead of fighting the
    // motors. Below the reverse-engage window a heavy pedal instead VETOS drive
    // outright — a held brake pins the buggy dead (stable, no drive-vs-brake
    // limit cycle), and releasing the pedal hands full authority back to the
    // motors the same frame: instant zero-threshold brake-to-reverse.
    const isBrakeHold = speedRef < BUGGY_REVERSE_ENGAGE_V && serviceBrakeDemand >= 0.5;
    if (isBrakeHold) {
      targetTorqueDemand = 0;
    } else if (speedRef > BUGGY_REVERSE_ENGAGE_V) {
      targetTorqueDemand *= 1 - clamp(serviceBrakeDemand, 0, 1);
    }

    // Smooth motor torque rise: approach(tau_current, tau_target, 12.0, dt)
    this.motorTorque = approach(this.motorTorque, targetTorqueDemand, BUGGY_THROTTLE_RISE, dt);
    if (Math.abs(this.motorTorque) < 1e-4) this.motorTorque = 0;

    const powerCap = (BUGGY_MOTOR_POWER * 4) / Math.max(Math.abs(s.vLong), 1.0);
    const maxTractive = Math.min(BUGGY_WHEEL_FORCE * 4, powerCap);
    let driveForce = this.motorTorque * maxTractive;
    if (this.state.batteryKwh <= 0) driveForce = 0;

    // Hard speed governor (spec 15 §3.2 limiter, hard-enforced for the Spec-16
    // powertrain): beyond a limiter cut drive instantly (a mere zeroed target
    // leaves ~0.2 s of full 15.2 kN torque in the pipe), then ease back with a
    // proportional retarding force so reverse settles AT the limit instead of
    // overshooting from torque lag.
    let limiterForce = 0;
    if (s.vLong < -BUGGY_REVERSE_SPEED_LIMIT) {
      if (driveForce < 0) {
        driveForce = 0;
        this.motorTorque = 0;
      }
      limiterForce = Math.min(
        (-s.vLong - BUGGY_REVERSE_SPEED_LIMIT) * 4_000,
        BUGGY_WHEEL_FORCE * 4,
      );
    } else if (s.vLong > BUGGY_SPEED_LIMIT && driveForce > 0) {
      driveForce = 0;
      this.motorTorque = 0;
    }

    // Regen + friction brake
    const regenDemand = clamp(input.regen, 0, 1) * BUGGY_REGEN_FORCE
      + serviceBrakeDemand * BUGGY_REGEN_FORCE * 0.7;
    let regenForce = speedRef > 0.1 ? -Math.sign(s.vLong) * Math.min(regenDemand, BUGGY_REGEN_FORCE) : 0;
    if (this.state.rolled || this.state.batteryKwh >= this.batteryCapKwh) regenForce = 0;

    // Friction brake effort follows the same Spec 17 §5 Step C surface law as
    // the grouser cap: BUGGY_BRAKE_FORCE is the regolith-calibrated (μ 0.68)
    // service effort, and a groused wheel on higher-friction surface can bite
    // proportionally harder before shearing. Ratio is exactly 1 on lunar, so
    // lunar panic stops stay bit-identical; asphalt gains the authority the
    // §7.1 < 18 m emergency-stop gate demands.
    const frictionBrakeForce =
      speedRef > 0.05
        ? -Math.sign(s.vLong) *
          serviceBrakeDemand *
          BUGGY_BRAKE_FORCE *
          (env.surfaceFrictionMu / REGOLITH_MU)
        : 0;

    // A brake can only arrest existing motion, never drive it backwards:
    // cap regen + friction so one substep of braking removes at most the
    // remaining velocity. Without this, the 14 kN brake + 8 kN regen would
    // ramp through zero and fling the buggy into spurious counter-motion,
    // which also blocks instant brake-to-reverse (the mode machine keeps
    // seeing velocity of the wrong sign).
    let brakeTotal = regenForce + frictionBrakeForce;
    if (Math.abs(s.vLong) > 1e-6) {
      const maxBrake = (Math.abs(s.vLong) * m) / dt;
      brakeTotal = clamp(brakeTotal, -maxBrake, maxBrake);
    } else {
      brakeTotal = 0;
    }

    // Brake bias (Spec 17 §2.3.2): the front axle carries
    // BUGGY_BRAKE_BIAS_FRONT of the total service demand (acceleration load
    // transfer unloads the rear), the rear axle the remainder.
    const brakeFrontShare = brakeTotal * BUGGY_BRAKE_BIAS_FRONT;
    const brakeRearShare = brakeTotal * (1 - BUGGY_BRAKE_BIAS_FRONT);

    // ABS pulse clock (15 Hz, Spec 17 §2.3.2): a locked corner's brake share
    // is released while the oscillator is off, re-applied when on — the
    // modulation cadence that keeps the sliding patch searching for grip.
    this.absClock += dt;
    const absPeriod = 1 / BUGGY_ABS_PULSE_HZ;
    const absPulseOn = this.absClock % absPeriod < absPeriod * BUGGY_ABS_DUTY;

    // Steer angle — Spec 17 §2.2.1 speed-sensitive lock law:
    //   δmax(v) = δ_high + (δ_low − δ_high) / (1 + (v / v_steer_half)²)
    // with δ_low = 45° (tight pivot authority at standstill) easing to
    // δ_high = 14° at speed. steerAngle = rawSteer · δmax(|vLong|).
    const rawSteer = clamp(input.steer, -1, 1);
    const isZeroSteer = Math.abs(rawSteer) < 1e-3;
    const maxSteer = speedSensitiveSteerLock(s.vLong);
    // Active straight-line centering (Spec 17 §2.2.2): with the stick released
    // the rack walks back to zero; quicker at speed (∝ 1 + v²/v_half² shape).
    const centeringRate = 10 + 2 * (s.vLong * s.vLong) /
      (BUGGY_STEER_HALF_SPEED * BUGGY_STEER_HALF_SPEED);
    const steerAngle = isZeroSteer
      ? approach(this.steerAngle, 0, centeringRate, dt)
      : rawSteer * maxSteer;
    this.steerAngle = Math.abs(steerAngle) < 1e-6 ? 0 : steerAngle;

    const isHillHold = this.driveMode === 'STOPPED' && Math.abs(rawThrottle) < 0.05;
    const parkSlipLock = input.parkBrake || isHillHold;

    // -- Per-corner suspension & tyres ----------------------------------------
    let sumZ = 0;
    let rollMoment = 0;
    let pitchMoment = 0;
    let FxBody = 0;
    let FyBody = 0;
    let yawMoment = 0;
    let totalNormal = 0;

    const cornerForceX: number[] = [0, 0, 0, 0];
    const cornerForceY: number[] = [0, 0, 0, 0];
    const cornerLoad: number[] = [0, 0, 0, 0];

    // Corner contact heights for slope-aligned attitude (spec 16 §2.2).
    let frontZ = 0;
    let rearZ = 0;
    let leftZ = 0;
    let rightZ = 0;

    for (let i = 0; i < 4; i++) {
      const fx = CORNERS[i].fx;
      const fy = CORNERS[i].fy;
      const isFront = fx > 0;

      // Per-corner ground contact height z_ground,i (spec 16 §2.2).
      const zg = this.ground(s.x + fx * ch - fy * sh, s.y + fx * sh + fy * ch);

      // Chassis spring-seat height above the local ground datum.
      const mountZ = s.bodyHeight - 0.25 + fx * cp * s.pitch - fy * cr * s.roll;

      // Suspension deflection x_i = z_contact + R_wheel - z_mount, positive =
      // compressed, measured against THIS corner's own ground so each wheel
      // follows terrain independently of the chassis datum.
      const x0 = zg - here + BUGGY_WHEEL_RADIUS - mountZ;
      const travel = BUGGY_SPRING_TRAVEL * 2; // droop..bump total
      const compression = clamp((x0 + BUGGY_SPRING_TRAVEL) / travel, 0, 1);
      const x = clamp(x0, -BUGGY_SPRING_TRAVEL, BUGGY_SPRING_TRAVEL);

      // True corner vertical velocity: heave plus the pitch/roll rates
      // realised last substep (small-angle). The pre-Spec-16 code evaluated
      // BUGGY_DAMPER * (vCorner - s.vBody) with vCorner === s.vBody, so the
      // damper was identically zero and heave rang like an unweighted pogo.
      const vzCorner = s.vBody + fx * this.pitchRate - fy * this.rollRate;

      // Critically damped spring-seat force with hard bump/droop stops
      // (spec 16 §2.2): F_z = max(0, k·x - c·vz), c = 1360 = 2·ζ·√(k·m/4).
      // k/c are the gravity-scaled values (Spec 17 §5 Step C above).
      let fz = springK * x - damperC * vzCorner;
      fz = clamp(fz, 0, springK * BUGGY_SPRING_TRAVEL * 2.5);

      if (fx > 0) frontZ += zg;
      else rearZ += zg;
      if (fy > 0) leftZ += zg;
      else rightZ += zg;

      cornerLoad[i] = fz;
      sumZ += fz;
      rollMoment += fz * fy;
      pitchMoment += fz * fx;
      totalNormal += fz;

      const loadN = Math.max(fz, 0);
      const loadFrac = loadN / Math.max(m * env.gravity / 4, 1);
      // Surface μ comes from the active environment (Spec 17 §2.1); the
      // load-sensitivity shaping is the legacy grouser-soil term.
      const mu = env.surfaceFrictionMu * (1.12 - 0.12 * loadFrac);

      // Wheel kinematics with Ackermann steering geometry for front wheels.
      let wheelSteer = 0;
      if (isFront) {
        if (isZeroSteer || Math.abs(steerAngle) < 1e-4) {
          wheelSteer = 0;
        } else {
          const tanSteer = Math.tan(steerAngle);
          const r = 2.7 / tanSteer;
          const effRadius = fy < 0 ? r - 0.85 : r + 0.85;
          wheelSteer = Math.atan(2.7 / effRadius);
        }
      }
      // Corner velocity (Spec 17 §2.2.3 v_{y,i}): a point (fx, fy) on a
      // chassis rotating at yawRate sweeps laterally at vLat + fx·ω and
      // longitudinally at vLong − fy·ω. Spec 17 Phase 6 forensics: the wheel
      // kinematics below previously fed the RAW body velocity, dropping the
      // ω×r term entirely — the tyres then felt no yaw damping at all, so a
      // brake-plus-steer panic stop wound the chassis up (yawRate climbed past
      // 9 rad/s while ABS pulsed) instead of weathervaning. With the corner
      // term the classic α_f = arctan((vLat + a·ω)/vx) − δ / α_r =
      // arctan((vLat − b·ω)/vx) pair emerges and yaw self-limits.
      const cornerVLong = s.vLong - fy * s.yawRate;
      const cornerVLat = s.vLat + fx * s.yawRate;
      const wx = Math.cos(wheelSteer) * cornerVLong + Math.sin(wheelSteer) * cornerVLat;
      const wy = -Math.sin(wheelSteer) * cornerVLong + Math.cos(wheelSteer) * cornerVLat;

      const wheel = s.wheels[i];
      if (parkSlipLock) wheel.spin = 0;

      // Slip ratio (Spec 17 §2.3.2): s_i = (R_wheel·ω_i − v_x) / max(|v_x|, 0.1).
      // s < 0 ⇒ the wheel surface trails the chassis (braking/driving slip);
      // a fully locked wheel reads s = −1.
      const wheelSurface = wheel.spin * BUGGY_WHEEL_RADIUS;
      let slip = (wheelSurface - wx) / Math.max(Math.abs(wx), 0.1);
      if (Math.abs(slip) > 4) slip = Math.sign(slip) * 4;

      // Grouser-limited active longitudinal force (spec 16 §2.5): a rigid
      // groused lunar wheel is a ground-implement — drive AND braking forces
      // are governed by the drivetrain's wheel-force ceiling (3.8 kN), not the
      // passive soil circle (μ·N ≈ 0.24 kN here — an order of magnitude
      // too small to launch 880 kg). The cap fades out with contact fraction
      // so an airborne wheel produces no reactionless thrust, and heavy loads
      // may still exceed it through pure traction. Spec 17 §5 Step C: the
      // 3.8 kN figure was calibrated against regolith μ 0.68 — migrating to a
      // different surface re-scales the ceiling by that surface's friction
      // authority (μ/0.68). The ratio is exactly 1 on ENV_LUNAR_FRONTIER, so
      // every lunar caller stays bit-identical; asphalt (μ 1.05) grants the
      // groused wheel proportionally more braking/pull before shear, which is
      // what makes the §7.1 < 18 m panic-stop gate physically reachable.
      const grouserCap = Math.max(
        BUGGY_WHEEL_FORCE * clamp(loadFrac, 0, 1) * (env.surfaceFrictionMu / REGOLITH_MU),
        mu * loadN,
      );

      // Brake share for this corner (Spec 17 §2.3.2): front axle carries
      // BUGGY_BRAKE_BIAS_FRONT of the total service-brake demand under
      // acceleration-load-transfer, the rear the remainder.
      const perWheelBrakeN = (isFront ? brakeFrontShare : brakeRearShare) / 2;

      // ABS modulation (Spec 17 §2.3.2): if THIS wheel locks (s_i < −0.25)
      // while the buggy is still rolling above BUGGY_ABS_MIN_SPEED, its brake
      // torque is pulsed at 15 Hz — the release windows let the contact patch
      // re-grip so the driver retains steering authority through a panic stop.
      // Lock state latches at pulse boundaries and frees instantly once the
      // wheel recovers (s_i ≥ −0.10 hysteresis) or the buggy slows away.
      if (!parkSlipLock) {
        if (this.absLocked[i]) {
          if (slip >= -0.1 || speedRef <= BUGGY_ABS_MIN_SPEED) this.absLocked[i] = false;
        } else if (slip < BUGGY_ABS_SLIP_THRESHOLD && speedRef > BUGGY_ABS_MIN_SPEED
          && Math.abs(perWheelBrakeN) > 1) {
          this.absLocked[i] = true;
        }
      } else {
        this.absLocked[i] = false;
      }
      const absScale = this.absLocked[i] && !absPulseOn ? BUGGY_ABS_RELEASE_SCALE : 1;

      // Drive force shared equally; the (bias-split, ABS-pulsed) brake and the
      // reverse-limiter retarding force apply at all four corners.
      let forceAlong = driveForce / 4 + (perWheelBrakeN * absScale + limiterForce / 4);

      if (!parkSlipLock) {
        if (this.absLocked[i] && !absPulseOn) {
          // ABS release phase: with the valve dumped, the sliding patch's
          // traction re-rotates the free wheel to rolling fast (the physical
          // reason cadence recovers grip — far quicker than coast relaxation).
          wheel.spin = approach(wheel.spin, wx / BUGGY_WHEEL_RADIUS, 90, dt);
        } else {
          // Over-braked wheel: brake torque beyond the ground's traction cap
          // collapses the wheel's rotation into a slide (the lock ABS detects).
          // The excess spin-down rate is the surplus torque over an effective
          // wheel inertia; spin never reverses — a locked wheel, not a siren.
          const overBrakeN = Math.max(0, Math.abs(perWheelBrakeN * absScale) - grouserCap);
          if (overBrakeN > 0) {
            wheel.spin -= Math.sign(wx || s.vLong) * (overBrakeN * BUGGY_WHEEL_RADIUS / BUGGY_WHEEL_INERTIA) * dt;
            if (wx >= 0) wheel.spin = Math.max(wheel.spin, 0);
            else wheel.spin = Math.min(wheel.spin, 0);
          }
        }
      }
      forceAlong = clamp(forceAlong, -grouserCap, grouserCap);

      // Lateral Pacejka-style force (Spec 17 §2.2.3):
      //   F_y,i = −μ·F_z,i·sin(C·arctan(B·α_i))
      // The leading minus is RESTORING: the tyre resists its slip angle.
      // Spec 17 Phase 6 forensics: the original code dropped that minus and
      // compensated by feeding the yaw moment the NEGATED cross-product
      // (below). The pair reproduced the right steer→heading direction but
      // inverted ONLY the lateral-velocity channel: any side slip at speed
      // ACCELERATED instead of weathervaning back — the root cause of the
      // §7.1 high-speed slalom spinouts and of uncontrolled chassis
      // oscillation on lunar regolith. With the restoring sign here AND the
      // true τ_z below, steer > 0 still yaws the heading up (front-axle side
      // force +K·δ at the nose) exactly as the yaw assist and every harness
      // convention encode, and vLat now decays toward zero. Rear corners run
      // a HIGHER cornering stiffness (the C·B term inside the arctangent)
      // than the front — weathervane stability (rear-biased K) with the
      // front axle washing out progressively under push instead of the tail
      // snapping.
      const latStiff = isFront ? BUGGY_LATERAL_STIFFNESS_FRONT : BUGGY_LATERAL_STIFFNESS_REAR;
      const refLat = Math.max(Math.abs(wy), 0.6);
      const alpha = Math.atan2(wy, Math.max(Math.abs(wx), 0.6));
      const alphaHat = wy / refLat;
      let Fy = -mu * loadN * atanCurve(latStiff * 9 * (alphaHat + 0.6 * alphaHat * Math.abs(alphaHat))) * (refLat > 0.25 || speedRef > 0.25 ? 1 : 0);
      void alpha;

      // Combined-force ellipse: active longitudinal shares the patch with
      // passive lateral grip (grouser axis vs μ axis respectively).
      const fMax = mu * loadN;
      const fLongTotal = forceAlong;
      const norm = Math.hypot(fLongTotal / Math.max(grouserCap, 1), Fy / Math.max(fMax, 1));
      let fxOut = fLongTotal;
      let fyOut = Fy;
      if (norm > 1) {
        fxOut = fLongTotal / norm;
        fyOut = Fy / norm;
      }

      // Park-brake holding force against creep.
      if (parkSlipLock) {
        const hold = Math.min(fMax, 1800);
        if (Math.abs(s.vLong) < 0.25 && Math.abs(s.vLat) < 0.25) {
          fxOut = -s.vLong * 1200;
          fyOut = -s.vLat * 1200;
          fxOut = clamp(fxOut, -hold, hold);
          fyOut = clamp(fyOut, -hold, hold);
        }
      }

      // Rotate corner force (wheel frame) into body frame.
      const bx = Math.cos(wheelSteer) * fxOut - Math.sin(wheelSteer) * fyOut;
      const by = Math.sin(wheelSteer) * fxOut + Math.cos(wheelSteer) * fyOut;
      cornerForceX[i] = bx;
      cornerForceY[i] = by;

      FxBody += bx;
      FyBody += by;
      // Yaw moment τ_z = r_x·F_y − r_y·F_x (heading-increase positive in this
      // x-forward / y-left body frame), with the RESTORING lateral force
      // above. (Was `bx*fy − by*fx` — the negated torque — as half of the
      // double sign inversion forensically removed at the Fy site; see the
      // comment there.)
      yawMoment += fx * by - fy * bx;

      // Spin update (relaxation toward rolling, locked when parked).
      if (!parkSlipLock) {
        const targetSpin = wx / BUGGY_WHEEL_RADIUS;
        wheel.spin = approach(wheel.spin, targetSpin, 18, dt);
      }
      wheel.compression = compression;
      wheel.load = loadN;
      wheel.slip = slip;
      wheel.force = fxOut;
    }

    // Active straight-line yaw stabilizer to eliminate numerical yaw drift
    if (isZeroSteer) {
      yawMoment -= 8.0 * inertia * s.yawRate;
    }

    // Low-speed torque vectoring / skid-steer assist (spec 16 §2.6):
    // M = sign(δ)·τ_assist·(1 − |v|/4.0), saturated to that envelope by a yaw-
    // rate tracking controller aiming at the pivot rate PIVOT_RATE. The grouser
    // patch holds laterally at walking pace, so the differential wheel-force
    // pair pivots the chassis about its centre instead of waiting for the slow
    // Ackermann weathervane — the snappy 180° turnaround. Sign follows the
    // Ackermann convention (δ > 0 yaws heading up); the (1 − |v|/4) envelope
    // matches the spec formula and tapers the pivot out as speed rises so the
    // pivot never rides along into a high-speed spin. Spec 17 §7.1 re-cuts the
    // turnaround gate to 180° < 2.2 s: the pivot target rises to 2.2 rad/s and
    // the envelope torque to 6.4 kN·m, so the ramp onto pivot plus the π-radian
    // sweep lands inside the gate at both gravity wells. Lunar calibration
    // only — the assist lives entirely below the 4 m/s cut-off.
    const PIVOT_RATE = 2.2; // rad/s pivot target at full lock (Spec 17 §7.1)
    if (
      !isZeroSteer &&
      !this.state.rolled &&
      Math.abs(s.vLong) < BUGGY_YAW_ASSIST_SPEED
    ) {
      // Envelope scales with the surface's friction authority AND gravity —
      // the scrub moment a pivoting chassis fights is ∝ μ·m·g·lever, so the
      // Earth asphalt pivot needs ≈9× the lunar moment budget (both factors
      // are exactly 1 on ENV_LUNAR_FRONTIER).
      const envelope =
        BUGGY_YAW_ASSIST_TORQUE *
        (env.surfaceFrictionMu / REGOLITH_MU) *
        (env.gravity / LUNAR_GRAVITY) *
        (1 - Math.abs(s.vLong) / BUGGY_YAW_ASSIST_SPEED);
      const steerMag = clamp(Math.abs(steerAngle) / BUGGY_STEER_LOCK_LOW, 0, 1);
      const targetYaw = Math.sign(steerAngle) * steerMag * PIVOT_RATE * (1 - Math.abs(s.vLong) / BUGGY_YAW_ASSIST_SPEED);
      // Spec 17 Phase 6: leaky-integral yaw-rate tracking. A groused chassis
      // scrubbing through a pivot on high-μ surface carries a large steady
      // friction moment (∝ μ·load·lever); proportional-only tracking leaves
      // the rate error M_scrub/(Kp·I) and stalls the pivot short of the gate.
      // The integrator (leak 2.5/s so it bleeds off the instant the assist
      // window closes) is what real torque-vectoring ECUs do — it walks the
      // differential out until the realised rate matches the target exactly.
      this.pivotIntegral = clamp(
        this.pivotIntegral + (targetYaw - s.yawRate) * dt,
        -2.5,
        2.5,
      );
      const mVec = clamp(
        inertia * (3.5 * (targetYaw - s.yawRate) + 9.0 * this.pivotIntegral),
        -envelope,
        envelope,
      );
      yawMoment += mVec;
    } else if (this.pivotIntegral !== 0) {
      // Assist window closed — bleed the integrator so a pivot moment can
      // never ride along into the weathervane regime (Spec 17 §2.2 stability).
      this.pivotIntegral = Math.abs(this.pivotIntegral) < 1e-4
        ? 0
        : this.pivotIntegral * Math.exp(-6 * dt);
    }

    // -- Body accelerations -----------------------------------------------------
    const n = sumZ;
    const aDrive = (FxBody - (FxBody >= 0 ? 0 : 0)) / m;
    // Tyre rolling resistance follows the active surface (Spec 17 §2.1).
    const rolling = env.tireRollingResistance * n * Math.sign(s.vLong) * (speedRef > 0.02 ? 1 : 0);
    // Aerodynamic drag (Spec 17 §2.1): F = ½·ρ·CdA·v², opposing motion. The
    // lunar profile carries CdA = 0 (vacuum) so only Earth air resists.
    const aeroDrag = 0.5 * DRAG_RHO_AIR * env.airResistanceCdA * speedRef * s.vLong;
    // Regolith saltation plume — mechanical grit drag, not aerodynamic, so it
    // survives the vacuum: present on loose-surface (CdA = 0) environments.
    const plume = env.airResistanceCdA > 0 ? 0 : BUGGY_DRAG * speedRef * s.vLong;
    const gravLong = -env.gravity * Math.sin(slopePitch) * cp;
    const gravLat = env.gravity * Math.sin(slopeRoll);

    s.vLong += (aDrive - (rolling + aeroDrag + plume) / m + gravLong) * dt;
    s.vLat += (FyBody / m - gravLat) * dt;

    if (isZeroSteer && Math.abs(s.vLat) < 0.015) {
      s.vLat *= Math.exp(-12.0 * dt);
    }
    if (isHillHold && Math.abs(s.vLong) < 0.1) {
      s.vLong = 0;
      s.vLat = 0;
    }

    s.yawRate = approach(
      s.yawRate + (yawMoment / inertia) * dt,
      s.yawRate,
      0,
      dt,
    ) - s.yawRate * 0.35 * dt;
    if (isZeroSteer && Math.abs(s.yawRate) < 0.005) {
      s.yawRate = 0;
    }
    if (this.state.rolled) s.yawRate *= Math.exp(-3 * dt);

    // -- Heave & attitude dynamics ----------------------------------------------
    const weight = m * env.gravity;
    s.vBody += ((n - weight) / m) * dt;
    s.bodyHeight += s.vBody * dt;

    // Terrain attitude from the per-corner contact heights (spec 16 §2.2):
    // θ = atan((z_front − z_rear)/L), φ = atan((z_left − z_right)/W). The
    // chassis settles onto the slope its wheels are standing on instead of
    // planing across it.
    const slopePitchTarget = Math.atan((frontZ - rearZ) / 2 / 2.7);
    const slopeRollTarget = Math.atan((leftZ - rightZ) / 2 / BUGGY_TRACK);

    // Dynamic load transfer from drive/brake/brake yaw only (terrain grade is
    // already carried by the slope targets — no double counting). Positive Fx
    // transfers load REARWARD (nose-up squat), positive leftward a_lat rolls
    // the left side up. Gains are the kinematic analogue of Σk_s deflection
    // (θ ≈ m·a·h_cg / (k·L²)); the pitch gain is sized for the Spec-16 15.2 kN
    // launch force and keeps every corner inside its spring travel (x0 > 0 at
    // the front) so full throttle never lifts a wheel off the regolith.
    const accelPitch = Math.atan(FxBody / m / env.gravity) * 0.035;
    const accelRoll = Math.atan((FyBody / m + s.vLong * s.yawRate) / env.gravity) * 0.15;

    const targetPitch = clamp(slopePitchTarget + accelPitch, -0.35, 0.35);
    const targetRoll = clamp(slopeRollTarget + accelRoll, -0.5, 0.5);

    // Smooth first-order attitude tracking; the REALISED rates feed the
    // suspension corner velocities next substep (critically damped heave).
    const prevPitch = s.pitch;
    const prevRoll = s.roll;
    s.pitch = clamp(approach(s.pitch, targetPitch, 5, dt), -0.8, 0.8);
    s.roll = clamp(approach(s.roll, targetRoll, 6, dt), -0.8, 0.8);
    this.pitchRate = (s.pitch - prevPitch) / dt;
    this.rollRate = (s.roll - prevRoll) / dt;

    // -- Rollover trip ------------------------------------------------------------
    let minLoadFrac = 1;
    for (let i = 0; i < 4; i++) {
      minLoadFrac = Math.min(minLoadFrac, cornerLoad[i] / Math.max(weight / 4, 1));
    }
    const latAccel = Math.abs(s.vLong * s.yawRate);
    if (!this.state.rolled && minLoadFrac < -0.35 && latAccel > env.gravity * 0.25) {
      this.state.rolled = true;
    }

    // -- Airborne detection ---------------------------------------------------------
    s.airborne = s.vBody > 0.05 || s.bodyHeight > BUGGY_WHEEL_RADIUS + 0.229 + BUGGY_SPRING_TRAVEL * 1.5;

    // -- Integration ----------------------------------------------------------------
    if (Math.abs(s.pitch) > 0.55 && !this.state.rolled && speedRef > 1) {
      this.state.rolled = true; // nose-in tip-over on a berm
    }

    s.x += (s.vLong * ch - s.vLat * sh) * dt;
    s.y += (s.vLong * sh + s.vLat * ch) * dt;
    s.z = this.ground(s.x, s.y);
    s.heading = wrapAngle(s.heading + s.yawRate * dt);

    // -- Energy bookkeeping ----------------------------------------------------------
    const motorPower = Math.max(0, driveForce * s.vLong);
    const mech = motorPower * dt;
    s.motorEnergyJ += mech;
    s.batteryKwh = clamp(
      s.batteryKwh - (mech / 0.87 + 55 * dt) / 3_600_000,
      0,
      this.batteryCapKwh,
    );
    const regenW = Math.max(0, -regenForce * s.vLong);
    const recovered = regenW * dt * BUGGY_REGEN_EFFICIENCY;
    s.regenEnergyJ += recovered;
    s.batteryKwh = clamp(s.batteryKwh + recovered / 3_600_000, 0, this.batteryCapKwh);
  }
}

// Small helper attached via prototype-free accessor: roll rate estimate used
// by damping. We keep state minimal, so derive it from the roll delta stored
// on a WeakMap-free field instead.
interface RollRateState {
  rollRateProxy(): number;
}
declare module './TraversalPhysics.ts' {}
void ((o: LunarBuggy & RollRateState) => o);

// ---------------------------------------------------------------------------
// 3. Subterranean rail dynamics
// ---------------------------------------------------------------------------

/** Davis resistance constants (N, N per m/s, N per (m/s)²) — freight consist. */
export const RAIL_DAVIS_A = 2_000;
export const RAIL_DAVIS_B = 41;
export const RAIL_DAVIS_C = 0.88;

export interface RailCarSpec {
  /** Spec 21 §2.3: consist role — locomotive or ore hopper. */
  kind?: 'locomotive' | 'hopper';
  /** Locomotive + empty consist mass (kg). */
  mass?: number;
  /** Mineral load aboard (kg). */
  load?: number;
  /** Max tractive effort at rail (N). */
  tractiveEffort?: number;
  /** Adhesion limit factor (usable traction = mu * weight). */
  adhesion?: number;
  /** Speed limiter (m/s). */
  speedLimit?: number;
  /** Max pneumatic (air) brake force (N). */
  pneumaticBrakeForce?: number;
  /** Dynamic / rheostatic brake force (N). */
  dynamicBrakeForce?: number;
}

export const DEFAULT_RAIL_CAR: Required<RailCarSpec> = {
  kind: 'hopper',
  mass: 8_600,
  load: 0,
  tractiveEffort: 42_000,
  adhesion: 0.28,
  speedLimit: 12.5,
  pneumaticBrakeForce: 68_000,
  dynamicBrakeForce: 26_000,
};

export interface RailCarCommand {
  /** -8..+8 traction notch (negative = dynamic brake only below; negative throttle = reverse). */
  throttle: number;
  /** 0..1 rheostatic braking. */
  dynamicBrake: number;
  /** 0..1 pneumatic (air) brake pipe reduction. */
  pneumaticBrake: number;
  /** Automatic stop at the destination terminal. */
  stopAtTerminal?: boolean;
}

export const IDLE_RAIL_COMMAND: Readonly<RailCarCommand> = {
  throttle: 0,
  dynamicBrake: 0,
  pneumaticBrake: 0,
  stopAtTerminal: true,
};

export interface RailCarState {
  routeId: string;
  /** Distance along the routed polyline (m). */
  distance: number;
  /** +1 toward the terminal, -1 toward origin. */
  direction: 1 | -1;
  speed: number;
  /** Index of the next waypoint (stop) ahead. */
  waypointIndex: number;
  visitedNodeIds: string[];
  /** Pneumatic brake pipe pressure, 1 = released, 0 = emergency. */
  brakePipe: number;
  /** Brake cylinder heat soak (K above ambient) — causes fade. */
  brakeTempK: number;
  throttle: number;
  emergency: boolean;
  parked: boolean;
  terminalReached: boolean;
}

/** Sampler returning the track gradient (dz/ds, + = ascending) at `distance`. */
export type RailGradientSampler = (routeId: string, distance: number) => number;

/**
 * Rail car / ore train along a `RailRoute` node chain. Motion is 1-D along
 * the routed polyline; the z component of each node's position provides the
 * grade for inclined shaft descents.
 */
export class RailCar {
  public readonly routeId: string;
  /** Waypoint stops (cumulative distance + node id), built from the route. */
  public readonly stops: ReadonlyArray<{ nodeId: string; position: Vec3; distance: number }>;
  public readonly routeLength: number;

  private readonly spec: Required<RailCarSpec>;
  private readonly gradientAt: RailGradientSampler;
  private readonly state: RailCarState;

  constructor(route: RailRoute, stops: Vec3[], spec: RailCarSpec = {}, gradientAt?: RailGradientSampler) {
    if (stops.length < 2) {
      throw new Error(`RailCar: route ${route.id} needs at least two waypoint positions`);
    }
    this.routeId = route.id;
    this.spec = { ...DEFAULT_RAIL_CAR, ...spec };

    const acc: { nodeId: string; position: Vec3; distance: number }[] = [];
    let d = 0;
    acc.push({ nodeId: route.nodeIds[0] ?? stops[0].x.toString(), position: { ...stops[0] }, distance: 0 });
    for (let i = 1; i < stops.length; i++) {
      d += Math.hypot(
        stops[i].x - stops[i - 1].x,
        stops[i].y - stops[i - 1].y,
        stops[i].z - stops[i - 1].z,
      );
      acc.push({
        nodeId: route.nodeIds[i] ?? `wp-${i}`,
        position: { ...stops[i] },
        distance: d,
      });
    }
    if (d <= 1e-6) throw new Error(`RailCar: route ${route.id} has degenerate length`);
    this.stops = acc;
    this.routeLength = d;

    // Default gradient sampler: piecewise from the stop polyline itself.
    this.gradientAt =
      gradientAt ??
      ((_routeId: string, distance: number): number => {
        const dd = clamp(distance, 0, this.routeLength);
        for (let i = 1; i < acc.length; i++) {
          if (dd <= acc[i].distance || i === acc.length - 1) {
            const span = acc[i].distance - acc[i - 1].distance;
            return span > 1e-6 ? (acc[i].position.z - acc[i - 1].position.z) / span : 0;
          }
        }
        return 0;
      });

    this.state = {
      routeId: route.id,
      distance: 0,
      direction: 1,
      speed: 0,
      waypointIndex: 1,
      visitedNodeIds: [acc[0].nodeId],
      brakePipe: 1,
      brakeTempK: 0,
      throttle: 0,
      emergency: false,
      parked: true,
      terminalReached: false,
    };
  }

  public getState(): RailCarState {
    return { ...this.state, visitedNodeIds: [...this.state.visitedNodeIds] };
  }

  public get totalMass(): number {
    return this.spec.mass + this.spec.load;
  }

  public setLoad(kg: number): number {
    this.spec.load = clamp(kg, 0, 20_000);
    return this.spec.load;
  }

  /** Explicitly set track distance, speed and direction (Spec 21 §2.3). */
  public setDistance(dist: number, speed?: number, direction?: 1 | -1): void {
    this.state.distance = clamp(dist, 0, this.routeLength);
    if (speed !== undefined) this.state.speed = speed;
    if (direction !== undefined) this.state.direction = direction;
    if (this.state.distance >= this.routeLength - 1e-4 || this.state.distance <= 1e-4) {
      this.state.terminalReached = true;
    } else {
      this.state.terminalReached = false;
    }
  }

  /** Grade (dz/ds) at the car's current position. */
  public currentGrade(): number {
    return this.gradientAt(this.routeId, this.state.distance);
  }

  /** Grade resistance force (N, + opposes motion uphill) at current grade. */
  public gradeResistance(): number {
    const theta = Math.atan(this.currentGrade());
    return this.totalMass * LUNAR_GRAVITY * Math.sin(theta);
  }

  /** Davis basic train resistance (N). */
  public frictionResistance(speed = this.state.speed): number {
    const v = Math.abs(speed);
    return RAIL_DAVIS_A + RAIL_DAVIS_B * v + RAIL_DAVIS_C * v * v;
  }

  /** Interpolate the world position at `distance` along the polyline. */
  public positionAt(distance: number): Vec3 {
    const dd = clamp(distance, 0, this.routeLength);
    for (let i = 1; i < this.stops.length; i++) {
      if (dd <= this.stops[i].distance || i === this.stops.length - 1) {
        const span = this.stops[i].distance - this.stops[i - 1].distance;
        const t = span > 1e-6 ? (dd - this.stops[i - 1].distance) / span : 0;
        return {
          x: this.stops[i - 1].position.x + (this.stops[i].position.x - this.stops[i - 1].position.x) * t,
          y: this.stops[i - 1].position.y + (this.stops[i].position.y - this.stops[i - 1].position.y) * t,
          z: this.stops[i - 1].position.z + (this.stops[i].position.z - this.stops[i - 1].position.z) * t,
        };
      }
    }
    return { ...this.stops[0].position };
  }

  public position(): Vec3 {
    return this.positionAt(this.state.distance);
  }

  /** Pull the emergency brake — pipe to zero, full cylinder pressure. */
  public emergencyBrake(): void {
    this.state.emergency = true;
    this.state.throttle = 0;
  }

  public releaseBrakes(): void {
    this.state.emergency = false;
    this.state.brakeTempK = this.state.brakeTempK; // heat remains; fade lingers
  }

  public step(dt: number, command: RailCarCommand = IDLE_RAIL_COMMAND): RailCarState {
    const step = clamp(dt, 0, 0.25);
    const s = this.state;
    const m = this.totalMass;

    // Pneumatic pipe dynamics: charging is fast, emergency vent is instant.
    const targetPipe = s.emergency ? 0 : clamp(1 - clamp(command.pneumaticBrake, 0, 1), 0, 1);
    s.brakePipe = approach(s.brakePipe, targetPipe, targetPipe < s.brakePipe ? 8 : 3, step);

    // Brake fade: cylinders lose bite as they soak heat.
    const fadeScale = 1 / (1 + 0.004 * s.brakeTempK);

    // -- Forces along the track ------------------------------------------------
    const grade = this.currentGrade();
    const theta = Math.atan(grade);
    const travelSign = s.speed > 0.02 ? s.direction : 0;

    const resistance =
      this.frictionResistance(s.speed) * (travelSign !== 0 ? 1 : 0) +
      Math.sign(travelSign || grade) * m * LUNAR_GRAVITY * Math.sin(theta) * (travelSign !== 0 ? 1 : 0);

    let tractive = 0;
    if (!s.emergency) {
      const notch = clamp(command.throttle, -8, 8);
      s.throttle = notch;
      const dir = notch >= 0 ? 1 : -1;
      const overSpeed = s.speed > this.spec.speedLimit && dir >= 0;
      const tractiveDemand = Math.abs(notch) / 8 * this.spec.tractiveEffort * (overSpeed ? 0 : 1);
      // Traction motor tractive-effort vs speed hyperbola (constant power).
      const derate = this.spec.tractiveEffort * 12.5 / Math.max(s.speed * 1.0, 3.2);
      tractive = dir * Math.min(tractiveDemand, derate, this.spec.adhesion * m * LUNAR_GRAVITY);
      if (s.parked && Math.abs(notch) < 1 && Math.abs(grade) > 0.01) {
        // Holding brake keeps a parked consist on a shaft incline.
        tractive = -m * LUNAR_GRAVITY * Math.sin(theta);
        tractive = clamp(tractive, -this.spec.pneumaticBrakeForce, this.spec.pneumaticBrakeForce);
      }
    } else {
      s.throttle = 0;
    }

    const dynamicForce = clamp(command.dynamicBrake, 0, 1) * this.spec.dynamicBrakeForce * (s.speed > 0.3 ? 1 : 0);
    const pneumaticForce =
      (1 - s.brakePipe) * this.spec.pneumaticBrakeForce * fadeScale * (s.speed > 0.05 ? 1 : 0);

    let netForce = tractive - Math.sign(s.speed || tractive) * (resistance + dynamicForce + pneumaticForce);
    // When stopped, only enough force to move; otherwise hold.
    if (s.speed <= 0.02 && Math.abs(tractive) < resistance) netForce = 0;

    const a = netForce / (m * 1.08); // 8% rotating-mass allowance
    s.speed = Math.max(0, s.speed + a * step);

    // Terminal auto-stop: service brake as the last stop approaches.
    const remaining = this.routeLength - s.distance;
    if ((command.stopAtTerminal ?? true) && remaining < Math.max(6, s.speed * s.speed / (2 * 0.9))) {
      s.speed = Math.min(s.speed, Math.sqrt(Math.max(0, 2 * 0.9 * remaining)));
    }

    s.distance += s.speed * step * s.direction;
    if (s.distance >= this.routeLength) {
      s.distance = this.routeLength;
      s.speed = 0;
      s.terminalReached = true;
    }
    if (s.distance <= 0) {
      s.distance = 0;
      s.speed = 0;
    }

    // Waypoint bookkeeping.
    while (
      s.waypointIndex < this.stops.length &&
      s.distance >= this.stops[s.waypointIndex].distance - 0.5
    ) {
      const id = this.stops[s.waypointIndex].nodeId;
      if (!s.visitedNodeIds.includes(id)) s.visitedNodeIds.push(id);
      s.waypointIndex += 1;
    }

    s.parked = s.speed < 0.02 && s.throttle === 0;

    // Brake heat: dissipated kinetic energy soaks the cylinders.
    const brakePower = (dynamicForce + pneumaticForce) * s.speed;
    s.brakeTempK = clamp(s.brakeTempK + (brakePower * 0.00035 - 0.06 * s.brakeTempK) * step, 0, 400);

    return this.getState();
  }
}

// ---------------------------------------------------------------------------
// 4. Modal transitions — proximity mount / dismount
// ---------------------------------------------------------------------------

export type TraversalMode = 'suit' | 'mounting' | 'buggy' | 'dismounting' | 'rail';

/** Distance within which a suited astronaut can drop into the driver seat. */
export const MOUNT_RANGE_M = 2.4;
/** Mount sequence duration (s) — helmet through the roll bar, carefully. */
export const MOUNT_DURATION_S = 0.6;
/** Above this buggy speed, ejection from the seat is not survivable gameplay. */
export const DISMOUNT_MAX_SPEED = 2.0;
/** Boarding radius for a parked rail car at a station stop. */
export const RAIL_BOARD_RANGE_M = 12;

export interface MountState {
  mode: TraversalMode;
  /** metres to the nearest mountable buggy */
  nearestBuggyDistance: number;
  inMountRange: boolean;
  transitioning: boolean;
  progress: number;
}

export interface TraversalCommands {
  suit?: Partial<SuitInput>;
  buggy?: Partial<BuggyInput>;
  rail?: Partial<RailCarCommand>;
  /** Attempt to mount the nearest buggy / board the rail car. */
  mount?: boolean;
  /** Attempt to leave the current vehicle. */
  dismount?: boolean;
  /**
   * Umbilical support for the suit this frame (TASK-PLAY-060, spec §3.7):
   * plugged into vehicle life support, metabolic O₂ draw scales to 0.35×.
   * Forwarded to `LunarEvaSuit.step` while the suit mode is active.
   */
  mounted?: boolean;
}

export interface TraversalSnapshot {
  mode: TraversalMode;
  suit: SuitState;
  buggy: BuggyState | null;
  rail: RailCarState | null;
  mount: MountState;
}

// ---------------------------------------------------------------------------
// Unified engine
// ---------------------------------------------------------------------------

export interface TraversalPhysicsOptions {
  /** Terrain sampler shared by every mode (elevation of surface, metres). */
  groundElevation?: GroundElevationFn;
  /**
   * Physics environment for modes with a surface (Spec 17 §2.1) — the buggy
   * (and suit ground-friction) run under this gravity/material preset.
   * Defaults to `ENV_LUNAR_FRONTIER` (legacy behaviour).
   */
  environment?: EnvironmentProfile;
  suit?: Partial<SuitState>;
  buggy?: BuggyOptions & { x?: number; y?: number; heading?: number };
  railCar?: RailCarSpec;
}

/**
 * The unified traversal engine. Owns a suit, an optional parked buggy, and an
 * optional boarded rail car; steps whichever mode is active and manages
 * proximity-based modal transitions.
 */
export class TraversalPhysics {
  private readonly ground: GroundElevationFn;
  /** Active physics environment handed to every buggy this engine owns. */
  private readonly env: EnvironmentProfile;
  private readonly suit: LunarEvaSuit;
  private buggy: LunarBuggy | null;
  private rail: RailCar | null = null;

  private mode: TraversalMode = 'suit';
  private mountTimer = 0;
  private mountKind: 'mount' | 'dismount' | null = null;
  private railCommand: RailCarCommand = { ...IDLE_RAIL_COMMAND };

  constructor(options: TraversalPhysicsOptions = {}) {
    this.ground = options.groundElevation ?? FLAT_GROUND;
    this.env = options.environment ?? ENV_LUNAR_FRONTIER;
    this.suit = new LunarEvaSuit(options.suit);
    this.buggy =
      options.buggy === undefined
        ? null
        : new LunarBuggy(
            { environment: this.env, ...options.buggy, groundElevation: options.buggy.groundElevation ?? this.ground },
            { x: options.buggy.x, y: options.buggy.y, heading: options.buggy.heading },
          );
  }

  // -- Accessors -------------------------------------------------------------

  public getSuite(): LunarEvaSuit {
    return this.suit;
  }
  /** Alias kept for call-site readability at the driver-seat boundary. */
  public get suitPhysics(): LunarEvaSuit {
    return this.suit;
  }
  public getBuggy(): LunarBuggy | null {
    return this.buggy;
  }
  public getRailCar(): RailCar | null {
    return this.rail;
  }
  public getMode(): TraversalMode {
    return this.mode;
  }

  /** Place (or replace) the buggy the prospector shares the map with. */
  public placeBuggy(x: number, y: number, heading = 0): LunarBuggy {
    this.buggy = new LunarBuggy({ environment: this.env, groundElevation: this.ground }, { x, y, heading, bodyHeight: BUGGY_WHEEL_RADIUS + 0.229 });
    return this.buggy;
  }

  /**
   * Attach a rail car running `route`. `positions` are the world coordinates
   * of the route's nodes in order — resolve them with
   * `TraversalPhysics.resolveRoutePositions(route, world)` or pass positions
   * from a `WorldSnapshot` lookup.
   */
  public boardRail(route: RailRoute, positions: Vec3[], spec: RailCarSpec = {}): RailCar {
    this.rail = new RailCar(route, positions, { ...DEFAULT_RAIL_CAR, ...spec });
    return this.rail;
  }

  /** Map a `RailRoute`'s `nodeIds` onto world positions via a `getNode`-style lookup. */
  public static resolveRoutePositions(
    route: RailRoute,
    getNode: (id: string) => { position: Vec3 } | null,
  ): Vec3[] | null {
    const out: Vec3[] = [];
    for (const id of route.nodeIds) {
      const node = getNode(id);
      if (!node) return null;
      out.push({ ...node.position });
    }
    return out.length >= 2 ? out : null;
  }

  /**
   * Convenience: build a `RailGradientSampler` for a route directly against a
   * `LunarWorldGenerator`-shaped world (z-elevation terrain above ground,
   * interpolated node profile below).
   */
  public static makeRailGradientSampler(
    route: RailRoute,
    positions: Vec3[],
    surface?: { elevationAt(x: number, y: number): number },
  ): RailGradientSampler {
    const nodes = positions.map((p) => ({ ...p }));
    if (surface) {
      for (const p of nodes) {
        if (p.z > 0) {
          try {
            const e = surface.elevationAt(p.x, p.y);
            if (Number.isFinite(e)) p.z = e;
          } catch {
            /* keep generator-supplied elevation */
          }
        }
      }
    }
    const cum: number[] = [0];
    for (let i = 1; i < nodes.length; i++) {
      cum.push(
        cum[i - 1] +
          Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].y - nodes[i - 1].y, nodes[i].z - nodes[i - 1].z),
      );
    }
    return (_routeId: string, distance: number): number => {
      if (distance <= 0) {
        const span = Math.max(1e-6, cum[1]);
        return (nodes[1].z - nodes[0].z) / span;
      }
      if (distance >= cum[cum.length - 1]) {
        const n = nodes.length;
        const span = Math.max(1e-6, cum[n - 1] - cum[n - 2]);
        return (nodes[n - 1].z - nodes[n - 2].z) / span;
      }
      for (let i = 1; i < nodes.length; i++) {
        if (distance <= cum[i]) {
          const span = Math.max(1e-6, cum[i] - cum[i - 1]);
          return (nodes[i].z - nodes[i - 1].z) / span;
        }
      }
      return 0;
    };
  }

  // -- Transitions -------------------------------------------------------------

  private nearestBuggyDistance(): number {
    if (this.buggy === null) return Number.POSITIVE_INFINITY;
    const s = this.suit.getState();
    const b = this.buggy.getState();
    return Math.hypot(s.x - b.x, s.y - b.y);
  }

  /** Try to sit in the driver seat. Returns false if out of range / not possible. */
  public tryMount(): boolean {
    if (this.mode !== 'suit' || this.buggy === null || this.mountKind !== null) return false;
    if (this.nearestBuggyDistance() > MOUNT_RANGE_M) return false;
    const s = this.suit.getState();
    const b = this.buggy.getState();
    // Momentum carries into the seat; the buggy picks up where the run ended.
    const ch = Math.cos(b.heading);
    const sh = Math.sin(b.heading);
    const vLong = s.vx * ch + s.vy * sh;
    const vLat = -s.vx * sh + s.vy * ch;
    this.buggy.setStateFromMount(vLong, vLat);
    this.mode = 'mounting';
    this.mountKind = 'mount';
    this.mountTimer = MOUNT_DURATION_S;
    return true;
  }

  /** Hop out of the driver seat (or alight from a stopped rail car). */
  public tryDismount(): boolean {
    if (this.mountKind !== null) return false;
    if (this.mode === 'buggy' && this.buggy !== null) {
      const b = this.buggy.getState();
      if (Math.abs(b.vLong) > DISMOUNT_MAX_SPEED) return false;
      // Tumble out at arm's length with a soft RCS catch.
      const ch = Math.cos(b.heading);
      const sh = Math.sin(b.heading);
      this.suit.setState({
        x: b.x - 1.4 * sh,
        y: b.y + 1.4 * ch,
        z: Math.max(b.z, this.ground(b.x, b.y)) + 0.6,
        vx: b.vLong * ch * 0.4,
        vy: b.vLong * sh * 0.4,
        vz: 0.4,
        heading: wrapAngle(b.heading + Math.PI / 2),
        isGrounded: false,
      });
      this.buggy.setStateParked();
      this.mode = 'dismounting';
      this.mountKind = 'dismount';
      this.mountTimer = MOUNT_DURATION_S;
      return true;
    }
    if (this.mode === 'rail' && this.rail !== null) {
      const rs = this.rail.getState();
      if (rs.speed > 0.05) return false;
      const p = this.rail.position();
      this.suit.setState({ x: p.x, y: p.y, z: Math.max(p.z, this.ground(p.x, p.y)) + 0.4, vx: 0, vy: 0, vz: 0, isGrounded: false });
      this.mode = 'suit';
      this.rail = null;
      return true;
    }
    return false;
  }

  /** Board a parked rail car at a station (must be within RAIL_BOARD_RANGE_M). */
  public tryBoardRail(): boolean {
    if (this.mode !== 'suit' || this.rail === null || this.mountKind !== null) return false;
    const s = this.suit.getState();
    const p = this.rail.position();
    if (Math.hypot(s.x - p.x, s.y - p.y) > RAIL_BOARD_RANGE_M) return false;
    if (this.rail.getState().speed > 0.05) return false;
    this.mode = 'rail';
    return true;
  }

  // -- Main step ------------------------------------------------------------------

  public step(dt = 1 / 60, commands: TraversalCommands = {}): TraversalSnapshot {
    const step = clamp(dt, 0, 0.25);

    // Transition progress.
    if (this.mountKind !== null) {
      this.mountTimer -= step;
      if (this.mountTimer <= 0) {
        this.mode = this.mountKind === 'mount' ? 'buggy' : 'suit';
        this.mountKind = null;
        this.mountTimer = 0;
      }
    }

    // Suit steps while on foot (and during mount animation, frozen-ish).
    const suitInput: SuitInput = { ...IDLE_SUIT_INPUT, ...(commands.suit ?? {}) };
    if (this.mode === 'suit') {
      this.suit.step(step, suitInput, this.ground, { mounted: commands.mounted === true });
    } else if (this.mode === 'mounting' || this.mode === 'dismounting') {
      this.suit.step(step, IDLE_SUIT_INPUT, this.ground);
    }

    // Buggy steps only while driven or parked-settling.
    if (this.mode === 'buggy') {
      if (this.buggy !== null) {
        this.buggy.step(step, { ...IDLE_BUGGY_INPUT, parkBrake: false, ...(commands.buggy ?? {}) });
      }
    } else if (this.buggy !== null) {
      this.buggy.settle(step);
    }

    // Rail car steps only while boarded.
    if (this.mode === 'rail' && this.rail !== null) {
      this.railCommand = { ...IDLE_RAIL_COMMAND, ...(commands.rail ?? {}) };
      this.rail.step(step, this.railCommand);
    }

    // Mount / dismount intents.
    if (commands.mount) {
      if (this.mode === 'suit') {
        if (!this.tryMount() && !this.tryBoardRail()) {
          /* out of range */
        }
      }
    }
    if (commands.dismount) this.tryDismount();

    const dist = this.nearestBuggyDistance();
    const progress =
      this.mountKind === null ? 0 : clamp(1 - this.mountTimer / MOUNT_DURATION_S, 0, 1);

    return {
      mode: this.mode,
      suit: this.suit.getState(),
      buggy: this.buggy ? this.buggy.getState() : null,
      rail: this.rail ? this.rail.getState() : null,
      mount: {
        mode: this.mode,
        nearestBuggyDistance: dist,
        inMountRange: Number.isFinite(dist) && dist <= MOUNT_RANGE_M,
        transitioning: this.mountKind !== null,
        progress,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Buggy helpers that need privileged state access (kept adjacent to class)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
declare module 'node:util' {}

// The two mount helpers are declared on LunarBuggy via interface merging so
// they stay next to the state they touch without exporting the raw object.
interface LunarBuggy {
  /** @internal */
  setStateFromMount(vLong: number, vLat: number): void;
  /** @internal */
  setStateParked(): void;
  /** @internal */
  rollRateProxy(): number;
}

LunarBuggy.prototype.setStateFromMount = function (this: { state: BuggyState }, vLong: number, vLat: number): void {
  this.state.vLong = clamp(vLong, -BUGGY_SPEED_LIMIT, BUGGY_SPEED_LIMIT);
  this.state.vLat = clamp(vLat, -3, 3);
};

LunarBuggy.prototype.setStateParked = function (this: { state: BuggyState }): void {
  this.state.vLong = 0;
  this.state.vLat = 0;
  this.state.yawRate = 0;
  this.state.vBody = 0;
};

let rollPrev = 0;
LunarBuggy.prototype.rollRateProxy = function (this: { state: BuggyState }): number {
  const rate = this.state.roll - rollPrev;
  rollPrev = this.state.roll;
  return rate * 60;
};

// Default export
export default TraversalPhysics;
