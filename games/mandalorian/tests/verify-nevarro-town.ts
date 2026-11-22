/**
 * Mandalorian: Nevarro Frontier — Phase 2 Verification Suite (Spec 40 §4.1)
 *
 * Verifies:
 * 1. Town structure definitions (Central Plaza, Cantina, Guild Hall, Armorer's Forge,
 *    Market Bazaar stalls, Vaporator spires, Durasteel Landing Pad).
 * 2. AABB and Cylinder collider generation for each building type.
 * 3. `getTownColliders` returns correct count and types of colliders.
 * 4. `createTownSurfaceQuery` properly resolves floor/rooftop elevations.
 * 5. Physics integration with town structures (wall push-out, rooftop landing).
 */

import { MandoPhysics, WALK_SPEED, SPRINT_SPEED } from '../src/MandoPhysics.ts';
import {
  createNevarroTown,
  getTownColliders,
  createTownSurfaceQuery,
  verifyTownColliders,
  PLAZA_MARKER_RADIUS,
  PLAZA_STONE_PAD_ELEVATION,
  PLAZA_BRAZIER_HEIGHT,
  MARKET_STALL_CANOPY_HEIGHT,
  VAPORATOR_SPIRE_HEIGHT,
  LANDING_PAD_LIGHT_HEIGHT,
} from '../src/NevarroTown.ts';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

console.log('🧪 [Spec 40 Phase 2] Running NevarroTown Verification...');

// ============================================================================
// TEST 1: Town Structure Constants
// ============================================================================
console.log('\n[TEST 1] Town Structure Constants');
{
  assert(PLAZA_MARKER_RADIUS === 2.5, `Expected plaza radius = 2.5m, got ${PLAZA_MARKER_RADIUS}`);
  assert(PLAZA_STONE_PAD_ELEVATION === 0.15, `Expected pad elevation = 0.15m, got ${PLAZA_STONE_PAD_ELEVATION}`);
  assert(PLAZA_BRAZIER_HEIGHT === 1.8, `Expected brazier height = 1.8m, got ${PLAZA_BRAZIER_HEIGHT}`);
  assert(MARKET_STALL_CANOPY_HEIGHT === 3.2, `Expected canopy height = 3.2m, got ${MARKET_STALL_CANOPY_HEIGHT}`);
  assert(VAPORATOR_SPIRE_HEIGHT === 9.0, `Expected spire height = 9.0m, got ${VAPORATOR_SPIRE_HEIGHT}`);
  assert(LANDING_PAD_LIGHT_HEIGHT === 0.8, `Expected light height = 0.8m, got ${LANDING_PAD_LIGHT_HEIGHT}`);
  console.log('  ✓ All town constants verified');
}

// ============================================================================
// TEST 2: Town Structure Definitions
// ============================================================================
console.log('\n[TEST 2] Town Structure Definitions');
{
  const town = createNevarroTown();

  // Central Plaza
  assert(town.centralPlaza.id === 'central-plaza', `Expected plaza id = 'central-plaza'`);
  assert(town.centralPlaza.x === 0 && town.centralPlaza.y === 0, 'Plaza should be at origin');
  assert(town.centralPlaza.radius === PLAZA_MARKER_RADIUS, `Expected plaza radius = ${PLAZA_MARKER_RADIUS}`);

  // The Cantina
  assert(town.cantina.id === 'the-cantina', `Expected cantina id = 'the-cantina'`);
  assert(town.cantina.x === 24 && town.cantina.y === 18, 'Cantina should be at (24, 18)');
  assert(town.cantina.roofZ === 5.2, `Expected cantina roofZ = 5.2m, got ${town.cantina.roofZ}`);

  // Bounty Hunters' Guild Hall
  assert(town.guildHall.id === 'bounty-hunters-guild', `Expected guild id = 'bounty-hunters-guild'`);
  assert(town.guildHall.x === -26 && town.guildHall.y === 16, 'Guild Hall should be at (-26, 16)');
  assert(town.guildHall.roofZ === 6.5, `Expected guild roofZ = 6.5m, got ${town.guildHall.roofZ}`);

  // Armorer's Forge
  assert(town.armoryForge.id === 'armorer-forge', `Expected forge id = 'armorer-forge'`);
  assert(town.armoryForge.x === -22 && town.armoryForge.y === -24, 'Forge should be at (-22, -24)');

  // Market Stalls
  assert(town.marketStalls.length === 3, `Expected 3 market stalls, got ${town.marketStalls.length}`);
  assert(town.marketStalls[0].x === 18 && town.marketStalls[0].y === -22, 'Stall 1 should be at (18, -22)');
  assert(town.marketStalls[1].x === 6 && town.marketStalls[1].y === 26, 'Stall 2 should be at (6, 26)');
  assert(town.marketStalls[2].x === -8 && town.marketStalls[2].y === -28, 'Stall 3 should be at (-8, -28)');

  // Vaporator Spires
  assert(town.vaporatorSpires.length === 3, `Expected 3 vaporator spires, got ${town.vaporatorSpires.length}`);

  // Durasteel Landing Pad
  assert(town.durasteelLandingPad.id === 'durasteel-landing-pad', `Expected pad id = 'durasteel-landing-pad'`);
  assert(town.durasteelLandingPad.x === 58 && town.durasteelLandingPad.y === -10, 'Pad should be at (58, -10)');
  assert(town.durasteelLandingPad.radius === 14, `Expected pad radius = 14m, got ${town.durasteelLandingPad.radius}`);
  assert(town.durasteelLandingPad.padZ === 1.2, `Expected pad roofZ = 1.2m, got ${town.durasteelLandingPad.padZ}`);

  console.log('  ✓ All town structures defined correctly');
}

// ============================================================================
// TEST 3: Collider Generation
// ============================================================================
console.log('\n[TEST 3] Collider Generation');
{
  const town = createNevarroTown();
  const colliders = getTownColliders(town);

  // Should have: 1 plaza + 1 cantina + 1 guild + 1 forge + 3 stalls + 3 spires + 1 pad = 11 colliders
  assert(colliders.length === 11, `Expected 11 colliders, got ${colliders.length}`);

  // Count AABB vs Cylinder colliders
  let aabbCount = 0;
  let cylinderCount = 0;
  let walkableRoofCount = 0;

  for (const col of colliders) {
    if (col.kind === 'aabb') {
      aabbCount++;
      assert(col.minX < col.maxX && col.minY < col.maxY, `AABB ${col.id} has invalid bounds`);
    } else if (col.kind === 'cylinder') {
      cylinderCount++;
      assert(col.radius > 0, `Cylinder ${col.id} has invalid radius`);
    }

    if (col.walkableRoof) {
      walkableRoofCount++;
    }
  }

  // Expected: plaza (AABB) + cantina (cylinder) + guild (AABB) + forge (cylinder) + pad (cylinder) = 4 walkable
  assert(walkableRoofCount === 4, `Expected 4 walkable rooftops, got ${walkableRoofCount}`);
  console.log(`  ✓ Generated ${aabbCount} AABB colliders and ${cylinderCount} cylinder colliders`);
}

// ============================================================================
// TEST 4: Surface Query Function
// ============================================================================
console.log('\n[TEST 4] Surface Query Function');
{
  const town = createNevarroTown();
  const query = createTownSurfaceQuery(town);

  // Test at origin (Central Plaza) - should return plaza elevation
  let result = query(0, 0, 0);
  assert(result.floorZ === PLAZA_STONE_PAD_ELEVATION, `Plaza floorZ should be ${PLAZA_STONE_PAD_ELEVATION}, got ${result.floorZ}`);
  assert(result.structureId === 'central-plaza', `Expected structureId = 'central-plaza', got '${result.structureId}'`);

  // Test at Cantina location (should return cantina roofZ)
  result = query(24, 18, 0);
  assert(result.floorZ === 5.2, `Cantina floorZ should be 5.2m, got ${result.floorZ}`);
  assert(result.structureId === 'the-cantina', `Expected structureId = 'the-cantina', got '${result.structureId}'`);

  // Test at Guild Hall location (should return guild roofZ)
  result = query(-26, 16, 0);
  assert(result.floorZ === 6.5, `Guild Hall floorZ should be 6.5m, got ${result.floorZ}`);
  assert(result.structureId === 'bounty-hunters-guild', `Expected structureId = 'bounty-hunters-guild', got '${result.structureId}'`);

  // Test at Landing Pad location (should return pad roofZ)
  result = query(58, -10, 0);
  assert(result.floorZ === 1.2, `Landing Pad floorZ should be 1.2m, got ${result.floorZ}`);
  assert(result.structureId === 'durasteel-landing-pad', `Expected structureId = 'durasteel-landing-pad', got '${result.structureId}'`);

  // Test far from town (should return base terrain elevation)
  result = query(200, 200, 0);
  assert(result.floorZ === 0, `Far terrain floorZ should be 0, got ${result.floorZ}`);
  assert(result.structureId === null, `Expected no structureId at far location, got '${result.structureId}'`);

  console.log('  ✓ Surface query returns correct elevations and structure IDs');
}

// ============================================================================
// TEST 5: Physics Integration with Town Structures
// ============================================================================
console.log('\n[TEST 5] Physics Integration with Town Structures');
{
  const town = createNevarroTown();
  const colliders = getTownColliders(town);

  // Test 1: Walk up to Guild Hall wall and verify push-out
  const physics1 = new MandoPhysics({
    surfaceQuery: {
      colliders,
    },
  });

  // Position Mando at the Guild Hall wall (x = -35.2, y = 16, trying to enter from left)
  // Guild Hall AABB is: minX=-35, maxX=-17, minY=9, maxY=23
  // With radius 0.45, expanded bounds are: minX=-35.45, maxX=-16.55
  physics1.setState({ x: -35.2, y: 16, z: 0, isGrounded: true });
  physics1.update(0.1, { forward: 1 }); // Try to move forward into the building

  const afterCollision1 = physics1.getState();
  assert(afterCollision1.x < -35, `Should be stopped at Guild Hall wall (got x=${afterCollision1.x})`);
  assert(Math.abs(afterCollision1.vx) < 0.1, `Horizontal velocity should be near-zero after wall collision (got vx=${afterCollision1.vx})`);

  // Test 2: Fly up to Cantina rooftop and land
  const physics2 = new MandoPhysics({
    surfaceQuery: {
      colliders,
    },
  });

  physics2.setState({ x: 24, y: 18, z: 7.0, isGrounded: false, jetpackFuel: 100 });
  // Drop toward roof - need enough steps for gravity to pull Mando down from z=7 to z=5.2
  for (let i = 0; i < 10; i++) {
    physics2.update(0.1, {});
  }

  const afterDrop = physics2.getState();
  assert(afterDrop.z <= 5.3, `Should land on Cantina roof (z=${afterDrop.z})`);
  assert(afterDrop.isGrounded, 'Should be grounded after landing on roof');
  assert(afterDrop.standingOnStructureId === 'the-cantina', `Expected structureId = 'the-cantina', got '${afterDrop.standingOnStructureId}'`);

  // Test 3: Walk across Durasteel Landing Pad
  const physics3 = new MandoPhysics({
    surfaceQuery: {
      colliders,
    },
  });

  physics3.setState({ x: 58, y: -10, z: 1.2, isGrounded: true });
  for (let i = 0; i < 60; i++) {
    physics3.update(1 / 60, { forward: 1 });
  }

  const onPad = physics3.getState();
  assert(onPad.isGrounded, 'Should remain grounded while walking on landing pad');
  assert(Math.abs(onPad.z - 1.2) < 1e-4, `Should stay at pad elevation 1.2m (got ${onPad.z})`);
  assert(onPad.standingOnStructureId === 'durasteel-landing-pad', `Expected structureId = 'durasteel-landing-pad', got '${onPad.standingOnStructureId}'`);

  console.log('  ✓ Physics integration with town structures verified');
}

// ============================================================================
// TEST 6: Walkable Rooftop Verification
// ============================================================================
console.log('\n[TEST 6] Walkable Rooftop Verification');
{
  const town = createNevarroTown();
  const colliders = getTownColliders(town);

  // Test walking on Cantina roof (z = 5.2)
  const physics1 = new MandoPhysics({
    surfaceQuery: {
      colliders,
    },
  });

  physics1.setState({ x: 24, y: 18, z: 5.2, isGrounded: true });
  for (let i = 0; i < 90; i++) {
    physics1.update(1 / 60, { forward: 1, sprint: false });
  }

  const onCantinaRoof = physics1.getState();
  assert(onCantinaRoof.isGrounded, 'Should remain grounded on Cantina roof');
  assert(Math.abs(onCantinaRoof.z - 5.2) < 1e-4, `Should stay at Cantina roof elevation (got ${onCantinaRoof.z})`);
  assert(Math.abs(onCantinaRoof.speedRatio - 1.0) < 0.1, `Expected walk speed ratio ≈ 1.0, got ${onCantinaRoof.speedRatio.toFixed(2)}`);

  // Test walking on Guild Hall roof (z = 6.5)
  const physics2 = new MandoPhysics({
    surfaceQuery: {
      colliders,
    },
  });

  // Start at center of Guild Hall (x=-26, y=16) with width=18, depth=14
  // Use very small movement to stay within bounds
  physics2.setState({ x: -26, y: 16, z: 6.5, isGrounded: true });
  for (let i = 0; i < 90; i++) {
    physics2.update(1 / 60, { forward: 0.2, strafe: 0.2 }); // Small movement
  }

  const onGuildRoof = physics2.getState();
  assert(onGuildRoof.isGrounded, 'Should remain grounded on Guild Hall roof');
  assert(Math.abs(onGuildRoof.z - 6.5) < 1e-4, `Should stay at Guild Hall roof elevation (got ${onGuildRoof.z})`);
  assert(Math.abs(onGuildRoof.speedRatio - SPRINT_SPEED / WALK_SPEED) < 0.15, `Expected sprint speed ratio ≈ ${SPRINT_SPEED / WALK_SPEED}, got ${onGuildRoof.speedRatio.toFixed(2)}`);

  console.log('  ✓ Walkable rooftops verified (Cantina roofZ=5.2m, Guild Hall roofZ=6.5m)');
}

// ============================================================================
// TEST 7: Wall Collision (Non-Walkable Structures)
// ============================================================================
console.log('\n[TEST 7] Wall Collision with Non-Walkable Structures');
{
  const town = createNevarroTown();
  const colliders = getTownColliders(town);

  // Test hitting Armorer's Forge wall
  const physics1 = new MandoPhysics({
    surfaceQuery: {
      colliders,
    },
  });

  physics1.setState({ x: -26, y: -24, z: 0, isGrounded: true }); // Outside forge radius (5.5m)
  physics1.update(0.1, { forward: 1 }); // Move toward forge

  const atForge = physics1.getState();
  assert(atForge.vx === 0, 'Should stop when hitting Forge wall');

  // Test vaporator spire collision
  const physics2 = new MandoPhysics({
    surfaceQuery: {
      colliders,
    },
  });

  physics2.setState({ x: 20, y: -24, z: 0, isGrounded: true }); // Outside spire radius (0.6m)
  physics2.update(0.1, { forward: 1 });

  const atSpire = physics2.getState();
  assert(atSpire.vx === 0, 'Should stop when hitting vaporator spire');

  console.log('  ✓ Non-walkable structure walls verified');
}

// ============================================================================
// TEST 8: verifyTownColliders Helper
// ============================================================================
console.log('\n[TEST 8] verifyTownColliders Helper');
{
  const town = createNevarroTown();
  assert(verifyTownColliders(town), 'verifyTownColliders should return true for valid town');

  console.log('  ✓ verifyTownColliders helper verified');
}

console.log('\n🎉 [Spec 40 Phase 2] All NevarroTown tests PASSED!');
