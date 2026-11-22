/**
 * Mandalorian: Nevarro Frontier — Phase 1 Verification Suite (Spec 40 §3.1 & §4.1)
 *
 * Verifies:
 * 1. Exact Spec 40 §3.1 constants (`MANDO_GRAVITY = 9.81`, `WALK_SPEED = 4.5`, `SPRINT_SPEED = 7.8`,
 *    `JETPACK_THRUST = 18.5`, `JETPACK_AIR_ACCEL = 14.0`, `JETPACK_MAX_SPEED_XY = 13.5`,
 *    `JETPACK_MAX_CLIMB_VZ = 9.0`, `JETPACK_FUEL_MAX = 100.0`, `JETPACK_BURN_RATE = 22.0`,
 *    `JETPACK_RECHARGE_RATE = 35.0`, `JETPACK_MAX_ALTITUDE_M = 65.0`).
 * 2. Terrestrial 9.81 m/s² gravity & Zero Lunar Bounding (grounded walk/sprint keeps z clamped
 *    to surfaceZ with zero Steelpush/hurry leaps).
 * 3. Z-6 Jetpack ignition, +8.69 m/s² net climb, air steering, fuel burn, 0.35s cooldown,
 *    and grounded fuel recharge.
 * 4. Soft altitude ceiling damper at 65.0m above local terrain.
 * 5. Building AABB & cylinder wall horizontal push-out collision AND walkable rooftop landing.
 * 6. `@lunar/world/LunarWorldGenerator` alias resolution & Babylon.js `NullEngine` compatibility.
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { LunarWorldGenerator } from '@lunar/world/LunarWorldGenerator.ts';
import {
  MandoPhysics,
  stepMandoPhysics,
  createInitialMandoState,
  MANDO_GRAVITY,
  WALK_SPEED,
  SPRINT_SPEED,
  JETPACK_THRUST,
  JETPACK_AIR_ACCEL,
  JETPACK_MAX_SPEED_XY,
  JETPACK_MAX_CLIMB_VZ,
  JETPACK_FUEL_MAX,
  JETPACK_BURN_RATE,
  JETPACK_RECHARGE_RATE,
  JETPACK_RECHARGE_COOLDOWN_S,
  JETPACK_MAX_ALTITUDE_M,
  type MandoStructureCollider,
} from '../src/MandoPhysics.ts';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

console.log('🧪 [Spec 40 Phase 1] Running Mandalorian Scaffold & MandoPhysics Verification...');

// ============================================================================
// TEST 1: Spec 40 §3.1 Physics Constants
// ============================================================================
console.log('\n[TEST 1] Spec 40 §3.1 Physics Constants');
{
  assert(MANDO_GRAVITY === 9.81, `Expected MANDO_GRAVITY = 9.81, got ${MANDO_GRAVITY}`);
  assert(WALK_SPEED === 4.5, `Expected WALK_SPEED = 4.5, got ${WALK_SPEED}`);
  assert(SPRINT_SPEED === 7.8, `Expected SPRINT_SPEED = 7.8, got ${SPRINT_SPEED}`);
  assert(JETPACK_THRUST === 18.5, `Expected JETPACK_THRUST = 18.5, got ${JETPACK_THRUST}`);
  assert(JETPACK_AIR_ACCEL === 14.0, `Expected JETPACK_AIR_ACCEL = 14.0, got ${JETPACK_AIR_ACCEL}`);
  assert(JETPACK_MAX_SPEED_XY === 13.5, `Expected JETPACK_MAX_SPEED_XY = 13.5, got ${JETPACK_MAX_SPEED_XY}`);
  assert(JETPACK_MAX_CLIMB_VZ === 9.0, `Expected JETPACK_MAX_CLIMB_VZ = 9.0, got ${JETPACK_MAX_CLIMB_VZ}`);
  assert(JETPACK_FUEL_MAX === 100.0, `Expected JETPACK_FUEL_MAX = 100.0, got ${JETPACK_FUEL_MAX}`);
  assert(JETPACK_BURN_RATE === 22.0, `Expected JETPACK_BURN_RATE = 22.0, got ${JETPACK_BURN_RATE}`);
  assert(JETPACK_RECHARGE_RATE === 35.0, `Expected JETPACK_RECHARGE_RATE = 35.0, got ${JETPACK_RECHARGE_RATE}`);
  assert(JETPACK_RECHARGE_COOLDOWN_S === 0.35, `Expected cooldown = 0.35, got ${JETPACK_RECHARGE_COOLDOWN_S}`);
  assert(JETPACK_MAX_ALTITUDE_M === 65.0, `Expected JETPACK_MAX_ALTITUDE_M = 65.0, got ${JETPACK_MAX_ALTITUDE_M}`);
  console.log('  ✓ All Spec 40 §3.1 constants verified');
}

// ============================================================================
// TEST 2: 9.81 m/s² Terrestrial Freefall Gravity
// ============================================================================
console.log('\n[TEST 2] 9.81 m/s² Terrestrial Freefall Gravity');
{
  const state = createInitialMandoState({ z: 20, isGrounded: false });
  const dt = 1 / 60;
  for (let i = 0; i < 60; i++) {
    stepMandoPhysics(state, {}, dt);
  }
  const expectedVz = -MANDO_GRAVITY * 1.0;
  assert(
    Math.abs(state.vz - expectedVz) < 0.05,
    `Expected vz ≈ ${expectedVz.toFixed(2)} m/s after 1s freefall, got ${state.vz.toFixed(2)}`,
  );
  assert(state.z < 16.0 && state.z > 14.5, `Expected z ≈ 15.1m after 1s drop from 20m, got ${state.z.toFixed(2)}`);
  console.log('  ✓ 9.81 m/s² gravitational acceleration verified');
}

// ============================================================================
// TEST 3: Grounded Walking & Sprinting — Zero Lunar Bounding Invariant
// ============================================================================
console.log('\n[TEST 3] Grounded Walk (4.5 m/s) & Sprint (7.8 m/s) — Zero Lunar Bounding');
{
  const walkState = createInitialMandoState();
  const dt = 1 / 60;
  for (let i = 0; i < 90; i++) {
    stepMandoPhysics(walkState, { forward: 1, sprint: false }, dt);
    assert(walkState.z === 0, `Walking must never bound off the ground (got z=${walkState.z})`);
    assert(walkState.vz === 0, `Walking must keep vz=0 (got vz=${walkState.vz})`);
    assert(walkState.isGrounded, 'Walking must remain grounded');
  }
  const walkSpeed = Math.hypot(walkState.vx, walkState.vy);
  assert(
    Math.abs(walkSpeed - WALK_SPEED) < 0.05,
    `Expected walk speed ${WALK_SPEED} m/s, got ${walkSpeed.toFixed(3)}`,
  );
  assert(walkState.stridePhase > 0, 'Walking must advance stridePhase');

  const sprintState = createInitialMandoState();
  for (let i = 0; i < 90; i++) {
    stepMandoPhysics(sprintState, { forward: 1, sprint: true }, dt);
    assert(sprintState.z === 0, `Sprinting must never lunar-bound off the ground (got z=${sprintState.z})`);
    assert(sprintState.vz === 0, `Sprinting must keep vz=0 (got vz=${sprintState.vz})`);
    assert(sprintState.isGrounded, 'Sprinting must remain grounded');
  }
  const sprintSpeed = Math.hypot(sprintState.vx, sprintState.vy);
  assert(
    Math.abs(sprintSpeed - SPRINT_SPEED) < 0.05,
    `Expected sprint speed ${SPRINT_SPEED} m/s, got ${sprintSpeed.toFixed(3)}`,
  );
  console.log('  ✓ Walk (4.5 m/s) & Sprint (7.8 m/s) grounded with zero lunar bounding verified');
}

// ============================================================================
// TEST 4: Z-6 Jetpack Ignition, Climb, Air Steering, Fuel Burn & Ground Recharge
// ============================================================================
console.log('\n[TEST 4] Z-6 Jetpack Climb, Air Steering, Fuel Burn & 0.35s Cooldown Recharge');
{
  const state = createInitialMandoState();
  const dt = 0.02;

  // Burn jetpack for 1.0 second (50 steps of 0.02s) with forward air steering
  for (let i = 0; i < 50; i++) {
    stepMandoPhysics(state, { jetpack: true, forward: 1 }, dt);
  }

  assert(state.isJetpacking, 'Jetpack must be active while holding jetpack with fuel');
  assert(!state.isGrounded, 'Must be airborne while jetpacking upward');
  const expectedNetClimbVz = (JETPACK_THRUST - MANDO_GRAVITY) * 1.0; // 8.69 m/s
  assert(
    Math.abs(state.vz - expectedNetClimbVz) < 0.15,
    `Expected climb vz ≈ ${expectedNetClimbVz.toFixed(2)}, got ${state.vz.toFixed(2)}`,
  );
  const expectedFuel = JETPACK_FUEL_MAX - JETPACK_BURN_RATE * 1.0; // 78.0
  assert(
    Math.abs(state.jetpackFuel - expectedFuel) < 0.1,
    `Expected fuel ≈ ${expectedFuel}, got ${state.jetpackFuel.toFixed(2)}`,
  );
  assert(state.vx > 10.0, `Expected air steering forward vx > 10 m/s, got ${state.vx.toFixed(2)}`);

  // Drop back to ground and verify 0.35s cooldown before recharge starts
  const landed = createInitialMandoState({
    z: 0,
    isGrounded: true,
    isJetpacking: false,
    jetpackFuel: 50.0,
    jetpackCooldownTimer: JETPACK_RECHARGE_COOLDOWN_S,
  });

  // Step 0.20s (still within 0.35s cooldown) -> fuel must remain 50.0
  for (let i = 0; i < 10; i++) {
    stepMandoPhysics(landed, {}, 0.02);
  }
  assert(
    Math.abs(landed.jetpackFuel - 50.0) < 1e-4,
    `Fuel must not recharge before 0.35s cooldown expires (got ${landed.jetpackFuel})`,
  );

  // Step another 1.0s after cooldown -> fuel must recharge at 35.0/s
  for (let i = 0; i < 60; i++) {
    stepMandoPhysics(landed, {}, 0.02);
  }
  assert(
    landed.jetpackFuel > 80.0,
    `Fuel must recharge rapidly on ground after cooldown (got ${landed.jetpackFuel.toFixed(2)})`,
  );
  console.log('  ✓ Jetpack thrust, air steering, fuel burn & post-cooldown ground recharge verified');
}

// ============================================================================
// TEST 5: Soft Altitude Ceiling (65.0m above terrain)
// ============================================================================
console.log('\n[TEST 5] Jetpack Soft Altitude Ceiling (65.0m)');
{
  const state = createInitialMandoState({ z: 62.0, isGrounded: false, jetpackFuel: 100 });
  for (let i = 0; i < 120; i++) {
    state.jetpackFuel = 100; // Keep fueled to test ceiling clamp
    stepMandoPhysics(state, { jetpack: true }, 1 / 60);
  }
  assert(
    state.z <= JETPACK_MAX_ALTITUDE_M + 1e-4,
    `Altitude must not exceed ${JETPACK_MAX_ALTITUDE_M}m ceiling, got ${state.z.toFixed(3)}m`,
  );
  console.log('  ✓ Soft altitude ceiling (65.0m) verified');
}

// ============================================================================
// TEST 6: Building Wall Push-Out & Walkable Rooftop Landing (Cantina & Pad)
// ============================================================================
console.log('\n[TEST 6] Building Wall Collision & Walkable Rooftop Landing');
{
  const colliders: MandoStructureCollider[] = [
    {
      kind: 'aabb',
      id: 'guild-hall',
      minX: 4.0,
      maxX: 12.0,
      minY: -4.0,
      maxY: 4.0,
      baseZ: 0,
      topZ: 6.5,
      walkableRoof: true,
    },
    {
      kind: 'cylinder',
      id: 'landing-pad',
      x: 25.0,
      y: 0.0,
      radius: 8.0,
      baseZ: 0,
      topZ: 1.2,
      walkableRoof: true,
    },
  ];

  const physics = new MandoPhysics({
    groundElevation: () => 0,
    colliders,
  });

  // 1. Walk horizontally into the Guild Hall wall at ground level (z = 0)
  for (let i = 0; i < 120; i++) {
    physics.update(1 / 60, { forward: 1, sprint: true });
  }
  const wallBlocked = physics.getState();
  assert(
    wallBlocked.x <= 4.0 - 0.44,
    `Mando must be pushed out by Guild Hall wall at x=4.0 (got x=${wallBlocked.x.toFixed(3)})`,
  );
  assert(wallBlocked.z === 0, 'Must remain on ground while pushing against wall');

  // 2. Ignite Jetpack to fly up above the 6.5m Guild Hall roof, position over the center of the roof, and land
  for (let i = 0; i < 65; i++) {
    physics.update(1 / 60, { jetpack: true });
  }
  for (let i = 0; i < 35; i++) {
    physics.update(1 / 60, { jetpack: true, forward: 0.45 });
  }
  const airborneOverRoof = physics.getState();
  assert(
    airborneOverRoof.z > 6.5 && airborneOverRoof.x > 4.2 && airborneOverRoof.x < 11.8,
    `Mando should have flown over Guild Hall roof (got x=${airborneOverRoof.x.toFixed(2)}, z=${airborneOverRoof.z.toFixed(2)})`,
  );

  // Zero horizontal velocity over the rooftop and release jetpack to descend onto Guild Hall rooftop (z = 6.5m)
  physics.setState({ vx: 0, vy: 0, x: 8.0, y: 0.0 });
  for (let i = 0; i < 180; i++) {
    physics.update(1 / 60, {});
  }
  const onRoof = physics.getState();
  assert(
    onRoof.isGrounded,
    `Must be grounded after landing on Guild Hall rooftop (got z=${onRoof.z.toFixed(2)}, vz=${onRoof.vz.toFixed(2)})`,
  );
  assert(
    Math.abs(onRoof.z - 6.5) < 1e-4,
    `Expected rooftop floorZ = 6.5m, got ${onRoof.z.toFixed(3)}m`,
  );
  assert(
    onRoof.standingOnStructureId === 'guild-hall',
    `Expected standingOnStructureId = 'guild-hall', got '${onRoof.standingOnStructureId}'`,
  );
  console.log('  ✓ Building wall push-out & rooftop landing (z = 6.5m, id = guild-hall) verified');
}

// ============================================================================
// TEST 7: @lunar/* Alias & Babylon.js NullEngine Headless Compatibility
// ============================================================================
console.log('\n[TEST 7] @lunar/world/LunarWorldGenerator Reuse & Babylon.js NullEngine Boot');
{
  const gen = new LunarWorldGenerator('nevarro-season1');
  const h0 = gen.elevationAt(0, 0);
  const hOuter = gen.elevationAt(120, -85);
  assert(Number.isFinite(h0) && Number.isFinite(hOuter), 'LunarWorldGenerator.elevationAt must return finite elevation');

  const engine = new NullEngine();
  const scene = new Scene(engine);
  assert(scene.meshes.length === 0, 'NullEngine scene initialized cleanly');
  scene.dispose();
  engine.dispose();
  console.log('  ✓ @lunar/world/LunarWorldGenerator & Babylon.js NullEngine verified');
}

console.log('\n🎉 [Spec 40 Phase 1] All Mandalorian Scaffold & MandoPhysics tests PASSED!');
