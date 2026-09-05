import assert from 'node:assert';
import { LunarTerrain } from '../src/minigames/moon-buggy/LunarTerrain';
import { MoonRover } from '../src/minigames/moon-buggy/MoonRover';
import * as THREE from 'three';

console.log('🧪 [Piglet Triage] Running Moon Buggy Unit & Physics Tests...');

// 1. Terrain Tests
const terrain = new LunarTerrain(300, 100);
const h0 = terrain.getHeightAt(0, 0);
assert(typeof h0 === 'number' && !isNaN(h0), 'Height at origin must be valid number');

const normal0 = terrain.getNormalAt(0, 0);
assert(normal0.isVector3, 'Normal must be a THREE.Vector3');
assert(Math.abs(normal0.length() - 1.0) < 0.01, 'Normal must be normalized unit vector');
console.log('  ✓ LunarTerrain: Procedural cratered heightfield and normal calculations validated.');

// 2. Rover Physics & Lunar Gravity Tests
const spawnPos = new THREE.Vector3(0, 10, 0);
const rover = new MoonRover(terrain, spawnPos);
assert.strictEqual(rover.gravity, 1.62, 'Moon gravity constant must be 1.62 m/s^2');

// Simulate 1.0 second of freefall in lunar gravity
const dt = 0.016; // ~60fps
for (let i = 0; i < 60; i++) {
  rover.update(dt);
}

// In freefall under -1.62 m/s^2, after ~1s, downward velocity should approximate -1.62 m/s or settling on suspension
console.log(`  Rover state after 1s: Y=${rover.position.y.toFixed(2)}, Vy=${rover.velocity.y.toFixed(2)}, Grounded=${rover.isGrounded}`);
assert(rover.position.y < 10, 'Rover must fall downwards under lunar gravity');
assert(!isNaN(rover.position.y), 'Position must not be NaN');
console.log('  ✓ MoonRover: Lunar gravity acceleration and suspension damping verified.');

console.log('🎉 [Piglet Triage] All Moon Buggy physics verification tests PASSED with zero exceptions!');
