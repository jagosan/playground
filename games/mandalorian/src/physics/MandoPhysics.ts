/**
 * Mandalorian: Nevarro Frontier — Grounded Walking & Z-6 Jetpack Flight Physics (Spec 40 §3.1)
 *
 * Phase 1: Deterministic, NullEngine-safe physics subsystem with terrestrial
 * 9.81 m/s² gravity (never 1.62 lunar bounding), Z-6 jetpack climb/hover/air-steering,
 * fuel consumption & grounded recharge after 0.35s cooldown, soft altitude ceiling,
 * and AABB/cylinder building wall & walkable rooftop collision.
 *
 * Strict Invariants:
 * - Pure procedural code (100% NullEngine-safe, zero DOM/canvas/GLB dependencies)
 * - TypeScript strict compliance (verbatimModuleSyntax, import type, noUncheckedIndexedAccess)
 * - Zero Lunar Bounding: walking/sprinting keeps z clamped to surfaceZ when vz <= 0
 *   and jetpack is not active. Never applies Lunar Frontier's hurry/Steelpush impulses.
 */

// ============================================================================
// CONSTANTS (Spec 40 §3.1)
// ============================================================================

/** Terrestrial/Nevarro gravity: 9.81 m/s² (never 1.62 lunar gravity). */
export const MANDO_GRAVITY = 9.81;

/** Grounded walking speed (m/s). */
export const WALK_SPEED = 4.5;

/** Grounded sprinting speed (m/s). */
export const SPRINT_SPEED = 7.8;

/** Grounded horizontal acceleration rate (m/s²). */
export const GROUND_ACCEL = 32.0;

/** Grounded horizontal braking deceleration rate (m/s²). */
export const GROUND_DECEL = 28.0;

/** Jetpack upward thrust acceleration: 18.5 m/s² (net +8.69 m/s² climb against 9.81 gravity). */
export const JETPACK_THRUST = 18.5;

/** Jetpack horizontal steering acceleration while airborne (m/s²). */
export const JETPACK_AIR_ACCEL = 14.0;

/** Jetpack maximum horizontal XY flight speed (m/s). */
export const JETPACK_MAX_SPEED_XY = 13.5;

/** Jetpack maximum vertical climb speed (m/s). */
export const JETPACK_MAX_CLIMB_VZ = 9.0;

/** Jetpack maximum terminal descent speed (m/s). */
export const JETPACK_MAX_FALL_VZ = 28.0;

/** Jetpack fuel capacity (units). */
export const JETPACK_FUEL_MAX = 100.0;

/** Jetpack continuous fuel burn rate (units/s, ~4.55s full burn). */
export const JETPACK_BURN_RATE = 22.0;

/** Jetpack fuel recharge rate while grounded after cooldown (units/s). */
export const JETPACK_RECHARGE_RATE = 35.0;

/** Cooldown after jetpack shutoff before grounded fuel recharge begins (seconds). */
export const JETPACK_RECHARGE_COOLDOWN_S = 0.35;

/** Alias for legacy callers expecting JETPACK_COOLDOWN_TIME. */
export const JETPACK_COOLDOWN_TIME = JETPACK_RECHARGE_COOLDOWN_S;

/** Soft altitude ceiling above local terrain so players don't fly infinitely into skybox (m). */
export const JETPACK_MAX_ALTITUDE_M = 65.0;

/** Character horizontal collision capsule radius (m). */
export const MANDO_COLLISION_RADIUS_M = 0.45;

/** Maximum walkable step-up height onto curbs/low steps without blocking as a wall (m). */
export const MANDO_STEP_UP_HEIGHT_M = 0.55;

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

/** Physics state for the Mandalorian character (Spec 40 §3.1). */
export interface MandoPhysicsState {
  /** World X coordinate (meters). */
  x: number;
  /** World Y coordinate (meters, horizontal plane). */
  y: number;
  /** World Z coordinate (meters, vertical elevation). */
  z: number;
  /** Horizontal X velocity (m/s). */
  vx: number;
  /** Horizontal Y velocity (m/s). */
  vy: number;
  /** Vertical Z velocity (m/s). */
  vz: number;
  /** Facing direction heading in radians [-π, π] (0 = +X, π/2 = +Y). */
  heading: number;
  /** True when boots are planted on terrain or a walkable structure roof/deck. */
  isGrounded: boolean;
  /** True when Z-6 jetpack thrusters are actively firing. */
  isJetpacking: boolean;
  /** Remaining jetpack fuel in [0, JETPACK_FUEL_MAX]. */
  jetpackFuel: number;
  /** Accumulated grounded walking/sprinting stride phase in [0, 2π) radians. */
  stridePhase: number;
  /** Normalized horizontal speed ratio (0 when idle, 1 at WALK_SPEED, >1 when sprinting/flying). */
  speedRatio: number;
  /** ID of the building/roof/pad Mando is currently standing on, or null on open terrain. */
  standingOnStructureId: string | null;
  /** Internal cooldown timer (seconds) before grounded fuel recharge starts. */
  jetpackCooldownTimer?: number;
}

/**
 * Input command state for `stepMandoPhysics` and `MandoPhysics.update`.
 * Supports both canonical `jetpack` boolean and `jetpackHold` / `jetpackPress` aliases,
 * as well as camera-relative (`moveX`/`moveY` or `forward`/`strafe`) movement vectors.
 */
export interface MandoInputState {
  /** Forward/backward movement intent in [-1, 1] (+1 forward). */
  forward?: number;
  /** Strafe right/left movement intent in [-1, 1] (+1 right / +Y when heading=0). */
  strafe?: number;
  /** Optional direct world X movement axis in [-1, 1]. */
  moveX?: number;
  /** Optional direct world Y movement axis in [-1, 1]. */
  moveY?: number;
  /** Optional reference yaw/heading (radians) for camera-relative forward/strafe input. */
  cameraYaw?: number;
  /** Sprint modifier held. */
  sprint?: boolean;
  /** Primary jetpack thruster hold state (Space / Gamepad A / Touch [🚀 JET]). */
  jetpack?: boolean;
  /** Alias: rising-edge jetpack press. */
  jetpackPress?: boolean;
  /** Alias: continuous jetpack hold. */
  jetpackHold?: boolean;
}

/** Alias for compatibility with callers importing `MandoInput`. */
export type MandoInput = MandoInputState;

/** Axis-aligned bounding box structure collider with optional walkable roof. */
export interface MandoAabbCollider {
  kind: 'aabb';
  id: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Base elevation (default 0). */
  baseZ?: number;
  /** Top roof/deck elevation (meters). */
  topZ: number;
  /** If true (default), character can land and walk on top at `topZ`. */
  walkableRoof?: boolean;
}

/** Vertical cylinder structure collider with optional walkable roof/deck. */
export interface MandoCylinderCollider {
  kind: 'cylinder';
  id: string;
  x: number;
  y: number;
  radius: number;
  /** Base elevation (default 0). */
  baseZ?: number;
  /** Top roof/deck elevation (meters). */
  topZ: number;
  /** If true (default), character can land and walk on top at `topZ`. */
  walkableRoof?: boolean;
}

export type MandoStructureCollider = MandoAabbCollider | MandoCylinderCollider;

/** Result of querying the floor/rooftop elevation beneath `(x, y, currentZ)`. */
export interface SurfaceSample {
  /** Resolved floor elevation (max of terrain and any walkable roof at or below currentZ). */
  floorZ: number;
  /** Base terrain elevation at `(x, y)` (used for soft altitude ceiling calculation). */
  terrainZ?: number;
  /** Structure ID if standing on a rooftop/landing pad, otherwise null. */
  structureId: string | null;
}

/** Result of horizontal wall push-out resolution. */
export interface WallCollisionResolution {
  x: number;
  y: number;
  vx: number;
  vy: number;
  collidedId: string | null;
}

/**
 * Surface & Building Collision Query interface (Spec 40 §3.1).
 * Can be passed either as a function `(x, y, currentZ) => SurfaceSample`
 * or as an object providing `sampleFloor` / `querySurface` and `colliders` / `resolveWalls`.
 */
export interface SurfaceQueryObject {
  /** Sample floor/rooftop elevation at `(x, y)` given character feet at `currentZ`. */
  sampleFloor?: (x: number, y: number, currentZ: number) => SurfaceSample;
  /** Alias for `sampleFloor` matching `NevarroTown.querySurface`. */
  querySurface?: (x: number, y: number, currentZ: number) => SurfaceSample;
  /** Base terrain heightfield sampler `(x, y) => z`. */
  groundAt?: (x: number, y: number) => number;
  /** Optional list of building/pad AABB & cylinder colliders for wall push-out & rooftop floors. */
  colliders?: readonly MandoStructureCollider[];
  /** Optional custom horizontal wall push-out resolver. */
  resolveWalls?: (
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    radius: number,
  ) => WallCollisionResolution;
}

export type SurfaceQueryFn = (x: number, y: number, currentZ: number) => SurfaceSample;

export type SurfaceQuery = SurfaceQueryFn | SurfaceQueryObject;

/** Options for the stateful `MandoPhysics` class wrapper. */
export interface MandoPhysicsOptions {
  /** Ground elevation sampler `(x, y) => z`. */
  groundElevation?: (x: number, y: number) => number;
  /** Full surface/rooftop/wall query provider. */
  surfaceQuery?: SurfaceQuery;
  /** Optional list of structure colliders. */
  colliders?: readonly MandoStructureCollider[];
  /** Default structure ID when standing on base terrain (default `null`). */
  structureId?: string | null;
}

// ============================================================================
// PURE HELPERS & COLLISION SOLVERS
// ============================================================================

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function wrapRadians(angle: number): number {
  let a = (angle + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/**
 * Create a clean initial `MandoPhysicsState`.
 */
export function createInitialMandoState(
  overrides: Partial<MandoPhysicsState> = {},
): MandoPhysicsState {
  return {
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    z: overrides.z ?? 0,
    vx: overrides.vx ?? 0,
    vy: overrides.vy ?? 0,
    vz: overrides.vz ?? 0,
    heading: overrides.heading ?? 0,
    isGrounded: overrides.isGrounded ?? true,
    isJetpacking: overrides.isJetpacking ?? false,
    jetpackFuel: clamp(overrides.jetpackFuel ?? JETPACK_FUEL_MAX, 0, JETPACK_FUEL_MAX),
    stridePhase: overrides.stridePhase ?? 0,
    speedRatio: overrides.speedRatio ?? 0,
    standingOnStructureId:
      overrides.standingOnStructureId !== undefined ? overrides.standingOnStructureId : null,
    jetpackCooldownTimer: overrides.jetpackCooldownTimer ?? 0,
  };
}

/**
 * Test whether horizontal point `(x, y)` (expanded by `margin`) lies on the roof footprint
 * of a structure collider.
 */
function isPointOnColliderFootprint(
  x: number,
  y: number,
  col: MandoStructureCollider,
  margin: number = 0.15,
): boolean {
  if (col.kind === 'aabb') {
    return (
      x >= col.minX - margin &&
      x <= col.maxX + margin &&
      y >= col.minY - margin &&
      y <= col.maxY + margin
    );
  }
  const dx = x - col.x;
  const dy = y - col.y;
  const r = col.radius + margin;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Evaluate the highest walkable floor elevation (terrain or structure rooftop)
 * beneath `(x, y)` for a character currently at elevation `currentZ`.
 */
export function evaluateSurfaceSample(
  x: number,
  y: number,
  currentZ: number,
  surfaceQuery?: SurfaceQuery,
  defaultGroundFn: (x: number, y: number) => number = () => 0,
  defaultStructureId: string | null = null,
): { floorZ: number; terrainZ: number; structureId: string | null } {
  if (typeof surfaceQuery === 'function') {
    const sample = surfaceQuery(x, y, currentZ);
    const terrainZ = sample.terrainZ ?? Math.min(0, sample.floorZ);
    return {
      floorZ: sample.floorZ,
      terrainZ,
      structureId: sample.structureId ?? defaultStructureId,
    };
  }

  const terrainZ = surfaceQuery?.groundAt
    ? surfaceQuery.groundAt(x, y)
    : defaultGroundFn(x, y);

  let floorZ = terrainZ;
  let structureId: string | null = defaultStructureId;

  const customSampler = surfaceQuery?.sampleFloor ?? surfaceQuery?.querySurface;
  if (customSampler) {
    const sampled = customSampler(x, y, currentZ);
    if (sampled.floorZ >= floorZ) {
      floorZ = sampled.floorZ;
      structureId = sampled.structureId ?? structureId;
    }
  }

  const colliders = surfaceQuery?.colliders;
  if (colliders && colliders.length > 0) {
    for (let i = 0; i < colliders.length; i++) {
      const col = colliders[i];
      if (!col || col.walkableRoof === false) continue;
      // Character can stand on roof if they are at/above the roof (within step-up tolerance).
      if (currentZ + MANDO_STEP_UP_HEIGHT_M >= col.topZ) {
        if (isPointOnColliderFootprint(x, y, col, MANDO_COLLISION_RADIUS_M * 0.5)) {
          if (col.topZ >= floorZ) {
            floorZ = col.topZ;
            structureId = col.id;
          }
        }
      }
    }
  }

  return { floorZ, terrainZ, structureId };
}

/**
 * Push character `(x, y)` horizontally out of any AABB or cylinder structure collider
 * whose wall spans vertically above `currentZ + MANDO_STEP_UP_HEIGHT_M`.
 * If `currentZ` is at or above `col.topZ - MANDO_STEP_UP_HEIGHT_M`, Mando passes
 * cleanly over the rooftop!
 */
export function resolveStructureWallCollisions(
  x: number,
  y: number,
  currentZ: number,
  vx: number,
  vy: number,
  colliders: readonly MandoStructureCollider[] | undefined,
  radius: number = MANDO_COLLISION_RADIUS_M,
): WallCollisionResolution {
  let rx = x;
  let ry = y;
  let rvx = vx;
  let rvy = vy;
  let collidedId: string | null = null;

  if (!colliders || colliders.length === 0) {
    return { x: rx, y: ry, vx: rvx, vy: rvy, collidedId };
  }

  for (let i = 0; i < colliders.length; i++) {
    const col = colliders[i];
    if (!col) continue;
    const baseZ = col.baseZ ?? -100;
    // Only collide horizontally with walls when Mando's feet are below the roof top
    // (minus step-up allowance) and above the structure base.
    if (currentZ < baseZ - 2.0 || currentZ >= col.topZ - MANDO_STEP_UP_HEIGHT_M) {
      continue;
    }

    if (col.kind === 'aabb') {
      const expMinX = col.minX - radius;
      const expMaxX = col.maxX + radius;
      const expMinY = col.minY - radius;
      const expMaxY = col.maxY + radius;

      if (rx > expMinX && rx < expMaxX && ry > expMinY && ry < expMaxY) {
        const penLeft = rx - expMinX;
        const penRight = expMaxX - rx;
        const penBottom = ry - expMinY;
        const penTop = expMaxY - ry;
        const minPen = Math.min(penLeft, penRight, penBottom, penTop);

        if (minPen === penLeft) {
          rx = expMinX;
          if (rvx > 0) rvx = 0;
        } else if (minPen === penRight) {
          rx = expMaxX;
          if (rvx < 0) rvx = 0;
        } else if (minPen === penBottom) {
          ry = expMinY;
          if (rvy > 0) rvy = 0;
        } else {
          ry = expMaxY;
          if (rvy < 0) rvy = 0;
        }
        collidedId = col.id;
      }
    } else {
      const dx = rx - col.x;
      const dy = ry - col.y;
      const minDist = col.radius + radius;
      const distSq = dx * dx + dy * dy;
      if (distSq < minDist * minDist) {
        const dist = Math.sqrt(distSq);
        const nx = dist > 1e-6 ? dx / dist : 1;
        const ny = dist > 1e-6 ? dy / dist : 0;
        rx = col.x + nx * minDist;
        ry = col.y + ny * minDist;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          rvx -= vn * nx;
          rvy -= vn * ny;
        }
        collidedId = col.id;
      }
    }
  }

  return { x: rx, y: ry, vx: rvx, vy: rvy, collidedId };
}

// ============================================================================
// CORE STEP FUNCTION (Spec 40 §3.1 `stepMandoPhysics`)
// ============================================================================

/**
 * Advance `MandoPhysicsState` by `dt` seconds (mutates `state` in place and returns it).
 *
 * Enforces Spec 40 §3.1 invariants:
 * 1. Standard terrestrial/Nevarro gravity `MANDO_GRAVITY = 9.81 m/s²`.
 * 2. Zero Lunar Bounding: walking/sprinting on the ground NEVER applies vertical jump
 *    impulses; `z` stays clamped to `floorZ` whenever `vz <= 0` and jetpack is off.
 * 3. Holding Jetpack with `jetpackFuel > 0` ignites thrusters (`JETPACK_THRUST = 18.5 m/s²`,
 *    net `+8.69 m/s²` climb), burns fuel at `22.0/s`, steers in air at `14.0 m/s²` up to
 *    `13.5 m/s` XY and `9.0 m/s` climb VZ, and respects the `65.0 m` soft altitude ceiling.
 * 4. Landing on terrain or a walkable rooftop recharges fuel at `35.0/s` after a `0.35s` cooldown.
 */
export function stepMandoPhysics(
  state: MandoPhysicsState,
  input: MandoInputState,
  dt: number,
  surfaceQuery?: SurfaceQuery,
  defaultGroundFn: (x: number, y: number) => number = () => 0,
  defaultStructureId: string | null = null,
): MandoPhysicsState {
  if (!(dt > 0) || !Number.isFinite(dt)) {
    return state;
  }

  // Clamp overly large frame deltas for numerical stability while keeping exact sub-steps
  const stepDt = Math.min(dt, 0.1);

  // 1. Resolve directional movement intent
  const forward = clamp(input.forward ?? 0, -1, 1);
  const strafe = clamp(input.strafe ?? 0, -1, 1);
  const hasDirectWorldMove =
    typeof input.moveX === 'number' || typeof input.moveY === 'number';

  let wishDirX = 0;
  let wishDirY = 0;
  let inputMag = 0;

  if (hasDirectWorldMove) {
    const mx = clamp(input.moveX ?? 0, -1, 1);
    const my = clamp(input.moveY ?? 0, -1, 1);
    inputMag = Math.min(1, Math.hypot(mx, my));
    if (inputMag > 1e-5) {
      const len = Math.hypot(mx, my);
      wishDirX = mx / len;
      wishDirY = my / len;
    }
  } else {
    inputMag = Math.min(1, Math.hypot(forward, strafe));
    if (inputMag > 1e-5) {
      if (typeof input.cameraYaw === 'number') {
        // Camera-relative movement: forward is along cameraYaw, strafe is -90°/+90°
        const cosY = Math.cos(input.cameraYaw);
        const sinY = Math.sin(input.cameraYaw);
        const rawX = forward * cosY - strafe * sinY;
        const rawY = forward * sinY + strafe * cosY;
        const len = Math.hypot(rawX, rawY);
        if (len > 1e-5) {
          wishDirX = rawX / len;
          wishDirY = rawY / len;
        }
      } else {
        // Direct world-frame or heading-relative convention:
        // forward (+1) moves along +X (heading 0), strafe (+1) moves along +Y (heading +π/2)
        const moveAngle = Math.atan2(strafe, forward);
        wishDirX = Math.cos(moveAngle);
        wishDirY = Math.sin(moveAngle);
      }
    }
  }

  // Smoothly align character heading toward movement direction when moving
  if (inputMag > 0.05) {
    const targetHeading = Math.atan2(wishDirY, wishDirX);
    const delta = wrapRadians(targetHeading - state.heading);
    const maxTurn = 10.0 * stepDt;
    if (Math.abs(delta) <= maxTurn) {
      state.heading = targetHeading;
    } else {
      state.heading = wrapRadians(state.heading + Math.sign(delta) * maxTurn);
    }
  }

  // 2. Evaluate Jetpack Ignition, Thrust, Fuel Burn & Cooldown
  const wantsJetpack = Boolean(
    input.jetpack ?? input.jetpackHold ?? input.jetpackPress,
  );
  let cooldown = state.jetpackCooldownTimer ?? 0;

  // Pre-sample surface at current XY to check soft ceiling altitude
  const preSurface = evaluateSurfaceSample(
    state.x,
    state.y,
    state.z,
    surfaceQuery,
    defaultGroundFn,
    defaultStructureId,
  );

  if (wantsJetpack && state.jetpackFuel > 0) {
    const consumed = JETPACK_BURN_RATE * stepDt;
    const activeFraction =
      state.jetpackFuel >= consumed ? 1.0 : state.jetpackFuel / consumed;
    const burnDt = stepDt * activeFraction;

    state.jetpackFuel = Math.max(0, state.jetpackFuel - consumed);
    state.isJetpacking = state.jetpackFuel > 0;
    state.isGrounded = false;
    state.standingOnStructureId = null;
    cooldown = JETPACK_RECHARGE_COOLDOWN_S;

    // Apply upward jetpack thrust during the active burn window, plus gravity over full stepDt
    // Net vertical acceleration while burning: (JETPACK_THRUST - MANDO_GRAVITY) = +8.69 m/s²
    state.vz += JETPACK_THRUST * burnDt - MANDO_GRAVITY * stepDt;

    // Soft altitude ceiling damper above local terrain (JETPACK_MAX_ALTITUDE_M = 65.0m)
    const ceilingZ = preSurface.terrainZ + JETPACK_MAX_ALTITUDE_M;
    const altAboveTerrain = state.z - preSurface.terrainZ;
    if (altAboveTerrain >= JETPACK_MAX_ALTITUDE_M - 5.0 && state.vz > 0) {
      const t = clamp(
        (altAboveTerrain - (JETPACK_MAX_ALTITUDE_M - 5.0)) / 5.0,
        0,
        1,
      );
      const maxAllowedVz = JETPACK_MAX_CLIMB_VZ * (1 - t);
      state.vz = Math.min(state.vz, maxAllowedVz);
    }
    if (state.z >= ceilingZ && state.vz > 0) {
      state.vz = 0;
    }

    state.vz = clamp(state.vz, -JETPACK_MAX_FALL_VZ, JETPACK_MAX_CLIMB_VZ);

    // Airborne horizontal steering
    if (inputMag > 1e-5) {
      state.vx += wishDirX * JETPACK_AIR_ACCEL * inputMag * stepDt;
      state.vy += wishDirY * JETPACK_AIR_ACCEL * inputMag * stepDt;
    } else {
      // Gentle aerodynamic damping when hovering with neutral stick
      const drag = Math.exp(-1.5 * stepDt);
      state.vx *= drag;
      state.vy *= drag;
    }

    const xySpeed = Math.hypot(state.vx, state.vy);
    if (xySpeed > JETPACK_MAX_SPEED_XY) {
      const scale = JETPACK_MAX_SPEED_XY / xySpeed;
      state.vx *= scale;
      state.vy *= scale;
    }
  } else {
    // Jetpack not firing
    if (state.isJetpacking) {
      state.isJetpacking = false;
      cooldown = Math.max(cooldown, JETPACK_RECHARGE_COOLDOWN_S);
    }

    if (state.isGrounded) {
      // Grounded terrestrial walking / sprinting — ZERO lunar bounding
      const targetSpeed = (input.sprint ? SPRINT_SPEED : WALK_SPEED) * inputMag;
      const targetVx = wishDirX * targetSpeed;
      const targetVy = wishDirY * targetSpeed;

      const dvx = targetVx - state.vx;
      const dvy = targetVy - state.vy;
      const dvLen = Math.hypot(dvx, dvy);
      const accelRate = inputMag > 1e-5 ? GROUND_ACCEL : GROUND_DECEL;
      const maxDv = accelRate * stepDt;

      if (dvLen <= maxDv) {
        state.vx = targetVx;
        state.vy = targetVy;
      } else {
        state.vx += (dvx / dvLen) * maxDv;
        state.vy += (dvy / dvLen) * maxDv;
      }
    } else {
      // Airborne freefall (jetpack off)
      if (inputMag > 1e-5) {
        state.vx += wishDirX * (JETPACK_AIR_ACCEL * 0.5) * inputMag * stepDt;
        state.vy += wishDirY * (JETPACK_AIR_ACCEL * 0.5) * inputMag * stepDt;
        const xySpeed = Math.hypot(state.vx, state.vy);
        if (xySpeed > JETPACK_MAX_SPEED_XY) {
          const scale = JETPACK_MAX_SPEED_XY / xySpeed;
          state.vx *= scale;
          state.vy *= scale;
        }
      }
    }

    // Apply terrestrial gravity (9.81 m/s²)
    state.vz = Math.max(-JETPACK_MAX_FALL_VZ, state.vz - MANDO_GRAVITY * stepDt);
  }

  // 3. Integrate Position & Resolve Building Wall Push-Out
  const prevZ = state.z;
  let nextX = state.x + state.vx * stepDt;
  let nextY = state.y + state.vy * stepDt;
  let nextZ = state.z + state.vz * stepDt;

  // Enforce hard ceiling cap at terrainZ + JETPACK_MAX_ALTITUDE_M
  const maxCeilingZ = preSurface.terrainZ + JETPACK_MAX_ALTITUDE_M;
  if (nextZ > maxCeilingZ) {
    nextZ = maxCeilingZ;
    if (state.vz > 0) state.vz = 0;
  }

  if (typeof surfaceQuery === 'object' && surfaceQuery !== null) {
    if (surfaceQuery.resolveWalls) {
      const res = surfaceQuery.resolveWalls(
        nextX,
        nextY,
         Math.max(prevZ, nextZ),
        state.vx,
        state.vy,
        MANDO_COLLISION_RADIUS_M,
      );
      nextX = res.x;
      nextY = res.y;
      state.vx = res.vx;
      state.vy = res.vy;
    } else if (surfaceQuery.colliders && surfaceQuery.colliders.length > 0) {
      const res = resolveStructureWallCollisions(
        nextX,
        nextY,
        Math.max(prevZ, nextZ),
        state.vx,
        state.vy,
        surfaceQuery.colliders,
        MANDO_COLLISION_RADIUS_M,
      );
      nextX = res.x;
      nextY = res.y;
      state.vx = res.vx;
      state.vy = res.vy;
    }
  }

  state.x = nextX;
  state.y = nextY;

  // 4. Evaluate Surface / Rooftop Floor & Grounded Clamping (Zero Lunar Bounding Invariant)
  const postSurface = evaluateSurfaceSample(
    state.x,
    state.y,
    Math.max(prevZ, nextZ),
    surfaceQuery,
    defaultGroundFn,
    defaultStructureId,
  );

  // If walking on the ground and stepping onto a gentle downward slope (within step height)
  // while not jetpacking, keep Mando planted on the surface rather than micro-hopping.
  const slopeFollowTolerance =
    state.isGrounded && !state.isJetpacking ? MANDO_STEP_UP_HEIGHT_M : 0;

  if (!state.isJetpacking && state.vz <= 0 && nextZ <= postSurface.floorZ + slopeFollowTolerance) {
    state.z = postSurface.floorZ;
    state.vz = 0;
    state.isGrounded = true;
    state.standingOnStructureId = postSurface.structureId;
  } else if (nextZ <= postSurface.floorZ) {
    // Even if jetpacking, cannot tunnel below solid floor
    state.z = postSurface.floorZ;
    if (state.vz < 0) state.vz = 0;
    if (!state.isJetpacking) {
      state.isGrounded = true;
      state.standingOnStructureId = postSurface.structureId;
    }
  } else {
    state.z = nextZ;
    state.isGrounded = false;
    state.standingOnStructureId = null;
  }

  // 5. Grounded Jetpack Fuel Recharge (after 0.35s cooldown)
  if (!state.isJetpacking) {
    if (cooldown > 0) {
      cooldown = Math.max(0, cooldown - stepDt);
    }
    if (state.isGrounded && cooldown <= 0 && state.jetpackFuel < JETPACK_FUEL_MAX) {
      state.jetpackFuel = Math.min(
        JETPACK_FUEL_MAX,
        state.jetpackFuel + JETPACK_RECHARGE_RATE * stepDt,
      );
    }
  }
  state.jetpackCooldownTimer = cooldown;

  // 6. Stride Phase & Speed Ratio Telemetry
  const horizSpeed = Math.hypot(state.vx, state.vy);
  state.speedRatio = horizSpeed / WALK_SPEED;

  if (state.isGrounded && horizSpeed > 0.08) {
    state.stridePhase =
      (state.stridePhase + (horizSpeed / WALK_SPEED) * stepDt * 2 * Math.PI) %
      (2 * Math.PI);
  } else if (state.isGrounded && horizSpeed <= 0.08) {
    state.stridePhase = 0;
  }

  return state;
}

// ============================================================================
// CLASS WRAPPER (`MandoPhysics`)
// ============================================================================

export class MandoPhysics {
  private state: MandoPhysicsState;
  private groundElevation: (x: number, y: number) => number;
  private surfaceQuery: SurfaceQuery | undefined;
  private defaultStructureId: string | null;

  constructor(
    options: MandoPhysicsOptions = {},
    initialState?: Partial<MandoPhysicsState>,
  ) {
    this.groundElevation = options.groundElevation ?? (() => 0);
    this.defaultStructureId =
      options.structureId !== undefined ? options.structureId : null;

    if (options.surfaceQuery) {
      this.surfaceQuery = options.surfaceQuery;
    } else if (options.colliders) {
      this.surfaceQuery = {
        groundAt: this.groundElevation,
        colliders: options.colliders,
      };
    }

    const startX = initialState?.x ?? 0;
    const startY = initialState?.y ?? 0;
    const initialFloor = evaluateSurfaceSample(
      startX,
      startY,
      initialState?.z ?? 0,
      this.surfaceQuery,
      this.groundElevation,
      this.defaultStructureId,
    );

    const startZ = initialState?.z ?? initialFloor.floorZ;
    const isGrounded =
      initialState?.isGrounded ?? Math.abs(startZ - initialFloor.floorZ) <= 1e-3;

    this.state = createInitialMandoState({
      ...initialState,
      x: startX,
      y: startY,
      z: startZ,
      isGrounded,
      standingOnStructureId:
        initialState?.standingOnStructureId !== undefined
          ? initialState.standingOnStructureId
          : isGrounded
            ? initialFloor.structureId
            : null,
    });
  }

  /**
   * Step the physics simulation by `dt` seconds.
   */
  public update(
    dt: number,
    input: MandoInputState,
    surfaceQueryOverride?: SurfaceQuery,
  ): MandoPhysicsState {
    stepMandoPhysics(
      this.state,
      input,
      dt,
      surfaceQueryOverride ?? this.surfaceQuery,
      this.groundElevation,
      this.defaultStructureId,
    );
    return this.getState();
  }

  public getState(): MandoPhysicsState {
    return { ...this.state };
  }

  public setState(patch: Partial<MandoPhysicsState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
  }

  public getPosition(): { x: number; y: number; z: number } {
    return { x: this.state.x, y: this.state.y, z: this.state.z };
  }

  public getVelocity(): { vx: number; vy: number; vz: number } {
    return { vx: this.state.vx, vy: this.state.vy, vz: this.state.vz };
  }

  public getHeading(): number {
    return this.state.heading;
  }

  public isGrounded(): boolean {
    return this.state.isGrounded;
  }

  public isJetpacking(): boolean {
    return this.state.isJetpacking;
  }

  public getJetpackFuel(): number {
    return this.state.jetpackFuel;
  }

  public getMaxJetpackAltitude(): number {
    return JETPACK_MAX_ALTITUDE_M;
  }
}

// ============================================================================
// TERRAIN & TEST HELPERS
// ============================================================================

export function flatGroundElevation(): number {
  return 0;
}

export function rollingTerrainElevation(x: number, y: number): number {
  const scale = 0.08;
  return Math.sin(x * scale) * 1.5 + Math.cos(y * scale) * 1.5;
}

export function crateredTerrainElevation(x: number, y: number): number {
  const dist = Math.hypot(x, y);
  const craterRadius = 10;
  const craterDepth = 3;
  if (dist < craterRadius) {
    return -craterDepth * Math.cos((dist / craterRadius) * (Math.PI / 2));
  }
  return 0;
}

export function createTestPhysics(
  options: MandoPhysicsOptions = {},
  initialState?: Partial<MandoPhysicsState>,
): MandoPhysics {
  return new MandoPhysics(
    { groundElevation: flatGroundElevation, ...options },
    initialState,
  );
}
