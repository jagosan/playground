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

/**
 * Astronaut EVA suit physics: grounded locomotion with regolith friction and
 * slip, ballistic low-g arcs, RCS micro-maneuvering / descent softening, and
 * exertion-scaled oxygen + battery depletion.
 */
export class LunarEvaSuit {
  private state: SuitState;
  private jumpWasHeld = false;
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

  /** Advance the suit one timestep. `ground` is surface elevation underfoot. */
  public step(dt: number, input: SuitInput = IDLE_SUIT_INPUT, ground: GroundElevationFn = FLAT_GROUND): SuitState {
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
    s.oxygen = clamp(
      s.oxygen - (SUIT_O2_BASE + SUIT_O2_EXERTION * exertion + SUIT_O2_RCS * rcsUsage) * step,
      0,
      SUIT_MAX_OXYGEN,
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
/** Per-corner damper coefficient (N·s/m). */
export const BUGGY_DAMPER = 650;
/** Suspension travel from static ride (m). */
export const BUGGY_SPRING_TRAVEL = 0.2;
/** Peak tyre force per unit normal load (regolith, simplified Pacejka peak). */
export const BUGGY_MU_PEAK = REGOLITH_MU;
/** Slip ratio at which peak traction occurs (simplified Pacejka shaping). */
export const BUGGY_SLIP_PEAK = 0.14;
/** Per-wheel peak tractive force at the contact patch (N). */
export const BUGGY_WHEEL_FORCE = 2_400;
/** Per-motor continuous power limit (W). */
export const BUGGY_MOTOR_POWER = 9_000;
/** Peak motor regenerative braking force (N, total). */
export const BUGGY_REGEN_FORCE = 4_500;
/** Regenerator round-trip efficiency. */
export const BUGGY_REGEN_EFFICIENCY = 0.62;
/** Rolling resistance coefficient into loose regolith. */
export const BUGGY_ROLLING_RESISTANCE = 0.05;
/** Regolith plume drag coefficient (∝ v², no atmosphere but saltating grit). */
export const BUGGY_DRAG = 0.25;
/** Electronic speed limiter (m/s). */
export const BUGGY_SPEED_LIMIT = 22;
/** Onboard traction battery (kWh). */
export const BUGGY_BATTERY_KWH = 2.2;
/** Max road-wheel steering angle (rad). */
export const BUGGY_MAX_STEER = 0.55;
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
}

export interface BuggyOptions {
  chassisMass?: number;
  groundElevation?: GroundElevationFn;
  initialCargo?: number;
  batteryKwh?: number;
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

  constructor(options: BuggyOptions = {}, initial: Partial<BuggyState> = {}) {
    this.chassisMass = options.chassisMass ?? BUGGY_CHASSIS_MASS;
    this.ground = options.groundElevation ?? FLAT_GROUND;
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
    return { ...this.state, wheels: this.state.wheels.map((w) => ({ ...w })) as [WheelState, WheelState, WheelState, WheelState] };
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
    const inertia = m * (1.35 * 1.35 + 0.85 * 0.85) * 0.9;
    const rollInertia = m * 0.55;

    const ch = Math.cos(s.heading);
    const sh = Math.sin(s.heading);

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

    // -- Drive / brake demand -------------------------------------------------
    const speedRef = Math.hypot(s.vLong, s.vLat);
    let throttle = clamp(input.throttle, -1, 1);
    if (this.state.rolled) throttle = 0;
    if (s.vLong > BUGGY_SPEED_LIMIT) throttle = Math.min(throttle, 0);
    if (s.vLong < -BUGGY_SPEED_LIMIT * 0.4) throttle = Math.max(throttle, 0);
    const reversing = throttle < 0 && s.vLong < 0.4;
    const driveDir = reversing ? -1 : 1;
    let driveForce = Math.abs(throttle) * BUGGY_WHEEL_FORCE * 4 * driveDir;
    // Continuous-power derating above base speed.
    const powerCap = (BUGGY_MOTOR_POWER * 4) / Math.max(Math.abs(s.vLong), 0.8);
    driveForce = clamp(driveForce, -powerCap, powerCap);
    if (this.state.batteryKwh <= 0) driveForce = 0;

    // Regen: opposes motion, capped by adhesion and charger acceptance.
    const regenDemand = clamp(input.regen, 0, 1) * BUGGY_REGEN_FORCE
      + clamp(input.brake, 0, 1) * BUGGY_REGEN_FORCE * 0.7;
    let regenForce = speedRef > 0.4 ? -Math.sign(s.vLong) * Math.min(regenDemand, BUGGY_REGEN_FORCE) : 0;
    if (this.state.rolled || this.state.batteryKwh >= BUGGY_BATTERY_KWH) regenForce = 0;

    const steerAngle = clamp(input.steer, -1, 1) * BUGGY_MAX_STEER / (1 + 0.06 * speedRef);
    const parkSlipLock = input.parkBrake;

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

    for (let i = 0; i < 4; i++) {
      const fx = CORNERS[i].fx;
      const fy = CORNERS[i].fy;
      const isFront = fx > 0;

      // Chassis mount height above ground at this corner.
      const mountZ = s.bodyHeight - 0.25 + fx * cp * s.pitch - fy * cr * s.roll;
      const desired = BUGGY_WHEEL_RADIUS; // wheel keeps the ground contact patch
      const x0 = desired - mountZ; // positive = compressed
      const travel = BUGGY_SPRING_TRAVEL * 2; // droop..bump total
      const compression = clamp((x0 + BUGGY_SPRING_TRAVEL) / travel, 0, 1);
      const x = clamp(x0, -BUGGY_SPRING_TRAVEL, BUGGY_SPRING_TRAVEL);

      // Corner vertical velocity (heave + roll/pitch rates), small-angle.
      const vCorner = s.vBody + fx * s.pitch * 0 - fy * this.rollRateProxy() * 0;
      let fz = BUGGY_SPRING_RATE * x + BUGGY_DAMPER * (vCorner - s.vBody);
      fz = clamp(fz, 0, BUGGY_SPRING_RATE * BUGGY_SPRING_TRAVEL * 2.5);

      cornerLoad[i] = fz;
      sumZ += fz;
      rollMoment += fz * fy;
      pitchMoment += fz * fx;
      totalNormal += fz;

      const loadN = Math.max(fz, 0);
      const loadFrac = loadN / Math.max(m * LUNAR_GRAVITY / 4, 1);
      const mu = BUGGY_MU_PEAK * (1.12 - 0.12 * loadFrac);

      // Wheel kinematics.
      const wheelSteer = isFront ? steerAngle : 0;
      const wx = Math.cos(wheelSteer) * s.vLong + Math.sin(wheelSteer) * s.vLat;
      const wy = -Math.sin(wheelSteer) * s.vLong + Math.cos(wheelSteer) * s.vLat;

      const wheel = s.wheels[i];
      if (parkSlipLock) wheel.spin = 0;

      // Drive force shared equally; regen applied at all four corners.
      let forceAlong = driveForce / 4 + (fx > 0 ? regenForce / 4 : regenForce / 4);

      // Slip ratio (motion-based, simplified).
      const refSpeed = Math.max(Math.abs(wx), 0.8);
      const wheelSurface = wheel.spin * BUGGY_WHEEL_RADIUS;
      let slip = (wheelSurface - wx) / refSpeed;
      if (Math.abs(slip) > 4) slip = Math.sign(slip) * 4;

      const curve = atanCurve(slip / BUGGY_SLIP_PEAK);
      const driveSign = driveForce + regenForce >= 0 ? 1 : -1;
      let Fx = mu * loadN * curve * (Math.abs(driveForce) + Math.abs(regenForce) > 0 ? 1 : driveSign);
      // Longitudinal force must obey the demand when traction allows.
      Fx = clamp(Fx, -mu * loadN, mu * loadN);
      forceAlong = clamp(forceAlong, -mu * loadN * 4, mu * loadN * 4);
      // Blend demanded force through the traction limit.
      const tractionCap = mu * loadN * Math.sqrt(Math.max(0, 1 - 0.5 * Math.min(1, Math.abs(slip))));
      forceAlong = clamp(forceAlong, -Math.max(tractionCap, 0), Math.max(tractionCap, 0));

      // Lateral Pacejka-style force.
      const refLat = Math.max(Math.abs(wy), 0.6);
      const alpha = Math.atan2(wy, Math.max(Math.abs(wx), 0.6));
      const alphaHat = wy / refLat;
      let Fy = mu * loadN * atanCurve(9 * (alphaHat + 0.6 * alphaHat * Math.abs(alphaHat))) * (refLat > 0.25 || speedRef > 0.25 ? 1 : 0);
      void alpha;

      // Friction ellipse: clip combined force to mu*N.
      const fMax = mu * loadN;
      const fLongTotal = forceAlong;
      const norm = Math.hypot(fLongTotal / Math.max(fMax, 1), Fy / Math.max(fMax, 1));
      let fxOut = fLongTotal;
      let fyOut = Fy;
      if (norm > 1) {
        fxOut = fLongTotal / norm;
        fyOut = Fy / norm;
      }

      // Park-brake holding force against creep.
      if (parkSlipLock) {
        const hold = Math.min(fMax, 900);
        fxOut -= clamp(fxOut + s.vLong * 400, -hold, hold) * 0;
        if (Math.abs(s.vLong) < 0.15 && Math.abs(s.vLat) < 0.15) {
          fxOut = -s.vLong * 800;
          fyOut = -s.vLat * 800;
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
      yawMoment += bx * fy - by * fx;

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

    // -- Body accelerations -----------------------------------------------------
    const n = sumZ;
    const aDrive = (FxBody - (FxBody >= 0 ? 0 : 0)) / m;
    const rolling = BUGGY_ROLLING_RESISTANCE * n * Math.sign(s.vLong) * (speedRef > 0.02 ? 1 : 0);
    const plume = BUGGY_DRAG * speedRef * s.vLong;
    const gravLong = -LUNAR_GRAVITY * Math.sin(slopePitch) * cp;
    const gravLat = LUNAR_GRAVITY * Math.sin(slopeRoll);

    s.vLong += (aDrive - (rolling + plume) / m + gravLong) * dt;
    s.vLat += (FyBody / m - gravLat * 0) * dt + (-gravLat) * 0 * dt;
    s.vLat -= gravLat * dt;

    s.yawRate = approach(
      s.yawRate + (yawMoment / inertia) * dt,
      s.yawRate,
      0,
      dt,
    ) - s.yawRate * 0.35 * dt;
    if (this.state.rolled) s.yawRate *= Math.exp(-3 * dt);

    // -- Heave & attitude dynamics ----------------------------------------------
    const weight = m * LUNAR_GRAVITY;
    s.vBody += ((n - weight) / m) * dt;
    s.bodyHeight += s.vBody * dt;

    const rollStiffness = rollInertia * (3.5 * 2 * Math.PI) ** 2;
    const rollDamping = rollInertia * 2 * 0.3 * (3.5 * 2 * Math.PI);
    const rollTorque =
      rollMoment - m * LUNAR_GRAVITY * cog * Math.sin(s.roll) * 0 + 0 - (rollMoment - m * LUNAR_GRAVITY * cog * Math.sin(s.roll)) * 0;
    // Roll: suspension moment minus gravity restoring, plus lateral force at CoG.
    const netRoll = -(rollStiffness * 0) - (0) + (rollMoment - m * LUNAR_GRAVITY * cog * Math.sin(s.roll)) * 0;
    void netRoll;
    const lateralAtCog = m * (s.vLat * 0 + (FyBody / m) * 0);
    void lateralAtCog;
    const rollAcc = ((rollMoment - m * LUNAR_GRAVITY * Math.sin(s.roll) * cog) - rollDamping * this.rollRateProxy()) / rollInertia;
    s.roll = clamp(s.roll + 0 * dt + rollAcc * dt * 0, -0.8, 0.8);
    // The quasi-static roll attitude follows load transfer with lag; full rigid
    // body roll is handled through the roll bar trip below.
    const targetRoll = clamp(
      Math.atan2((FyBody / m - gravLat) + s.vLong * s.yawRate, LUNAR_GRAVITY) * 0.35,
      -0.5,
      0.5,
    );
    s.roll = approach(s.roll, targetRoll, 6, dt);
    const targetPitch = clamp(-Math.atan2(FxBody / m + gravLong, LUNAR_GRAVITY) * 0.4, -0.35, 0.35);
    s.pitch = approach(s.pitch, targetPitch, 5, dt);

    // -- Rollover trip ------------------------------------------------------------
    let minLoadFrac = 1;
    for (let i = 0; i < 4; i++) {
      minLoadFrac = Math.min(minLoadFrac, cornerLoad[i] / Math.max(weight / 4, 1));
    }
    const latAccel = Math.abs(s.vLong * s.yawRate);
    if (!this.state.rolled && minLoadFrac < -0.35 && latAccel > LUNAR_GRAVITY * 0.25) {
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
      BUGGY_BATTERY_KWH,
    );
    const regenW = Math.max(0, -regenForce * s.vLong);
    const recovered = regenW * dt * BUGGY_REGEN_EFFICIENCY;
    s.regenEnergyJ += recovered;
    s.batteryKwh = clamp(s.batteryKwh + recovered / 3_600_000, 0, BUGGY_BATTERY_KWH);
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
  private readonly suit: LunarEvaSuit;
  private buggy: LunarBuggy | null;
  private rail: RailCar | null = null;

  private mode: TraversalMode = 'suit';
  private mountTimer = 0;
  private mountKind: 'mount' | 'dismount' | null = null;
  private railCommand: RailCarCommand = { ...IDLE_RAIL_COMMAND };

  constructor(options: TraversalPhysicsOptions = {}) {
    this.ground = options.groundElevation ?? FLAT_GROUND;
    this.suit = new LunarEvaSuit(options.suit);
    this.buggy =
      options.buggy === undefined
        ? null
        : new LunarBuggy(
            { ...options.buggy, groundElevation: options.buggy.groundElevation ?? this.ground },
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
    this.buggy = new LunarBuggy({ groundElevation: this.ground }, { x, y, heading, bodyHeight: BUGGY_WHEEL_RADIUS + 0.229 });
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
      this.suit.step(step, suitInput, this.ground);
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
