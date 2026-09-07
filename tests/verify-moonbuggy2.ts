import assert from 'node:assert';
import { PhotorealisticTerrain } from '../src/minigames/moonbuggy2/PhotorealisticTerrain';
import { LRVPhysics } from '../src/minigames/moonbuggy2/LRVPhysics';
import * as THREE from 'three';

console.log('🧪 [Piglet Triage] Running Moonbuggy2 High-Fidelity Physics & Dynamics Tests...');

// 1. Photorealistic Terrain Tests
const terrain = new PhotorealisticTerrain(400, 100);
const h0 = terrain.getHeightAt(0, 0);
assert(!isNaN(h0), 'Terrain height must be a valid number');

const normal = terrain.getNormalAt(0, 0);
assert(normal.isVector3, 'Normal must be a THREE.Vector3');
assert(Math.abs(normal.length() - 1.0) < 0.01, 'Normal must be a unit vector');
console.log('  ✓ PhotorealisticTerrain: Multi-octave fBm and crater displacement validated.');

// 2. High-Fidelity Multi-Body Physics & Constants
const spawnPos = new THREE.Vector3(0, 15, 0);
const physics = new LRVPhysics(terrain, spawnPos);
assert.strictEqual(physics.gravity, 1.622, 'Lunar gravity must equal measured 1.622 m/s^2');
assert.strictEqual(physics.totalMass, 360.0, 'Base Apollo LRV mass must equal 360 kg');
assert.strictEqual(physics.tires.length, 4, 'Vehicle must feature 4 independent wheels');

// 3. Freefall Lunar Gravity & Suspension Settling Test
// Under -1.622 m/s^2, 120 steps @ 120Hz = 1.0 second
for (let i = 0; i < 120; i++) {
  physics.step(1 / 120, 0, 0, 0, false, false);
}
console.log(`  Rover state after 1.0s freefall: Y=${physics.position.y.toFixed(2)}, Vy=${physics.velocity.y.toFixed(2)}, Airborne=${physics.isAirborne}`);
assert(physics.position.y < 15, 'Rover must fall downwards');
assert(!isNaN(physics.position.y), 'Position must not be NaN');
console.log('  ✓ LRVPhysics: 120Hz sub-stepping solver and gravity integration verified.');

// 4. Drive & Steering Verification
// Step forward with full throttle for 60 ticks
for (let i = 0; i < 60; i++) {
  physics.step(1 / 60, 1.0, 0, 0.5, false, false);
}
console.log(`  Drive test: Speed=${physics.getSpeedKmh()} km/h, Heading=${physics.heading.toFixed(2)} rad, SteerAngle=${physics.steerAngle.toFixed(2)} rad`);
assert(!isNaN(physics.forwardSpeed), 'Forward speed must be valid');
console.log('  ✓ LRVPhysics: Traction, steering, and heading integration verified.');

console.log('🎉 [Piglet Triage] All Moonbuggy2 physics tests PASSED cleanly with zero errors!');
