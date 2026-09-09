import assert from 'node:assert';
import * as THREE from 'three';
import { RoverCollisionSystem, RoverCollider } from '../src/minigames/moonbuggy2/RoverCollisionSystem';
import { NPCCompetitorController, NPCCompetitor } from '../src/minigames/moonbuggy2/NPCCompetitorController';
import { LunarWaveManager } from '../src/minigames/moonbuggy2/LunarWaveManager';

console.log('🧪 [TASK-PLAY-044] Verifying Collision Physics, NPC Controller & Wave System...');

// 1. Rover Collision Physics & Inelastic Impulse Resolution
console.log('\n[1/3] Rover Collision System & Structural Damage Modeling');
const collisionSystem = new RoverCollisionSystem();

const roverA: RoverCollider = {
  id: 'player',
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(0, 0, -4.0), // Moving North at 4 m/s
  heading: 0,
  mass: 700,
  radius: 1.6,
  isPlayer: true,
  damage: 0,
};

const roverB: RoverCollider = {
  id: 'valkyrie-01',
  position: new THREE.Vector3(0, 0, -2.5), // Positioned 2.5m North (overlap: 3.2m sum of radii > 2.5m dist)
  velocity: new THREE.Vector3(0, 0, 3.0), // Moving South at 3 m/s towards player
  heading: Math.PI,
  mass: 700,
  radius: 1.6,
  isPlayer: false,
  damage: 0,
};

const impacts = collisionSystem.checkCollisions([roverA, roverB]);

assert.strictEqual(impacts.length, 1, 'Exactly one collision impact must be detected between overlapping rovers');
const impact = impacts[0];
console.log(`  Impact between ${impact.roverAId} and ${impact.roverBId}:`);
console.log(`    Relative Speed: ${impact.relativeSpeed.toFixed(2)} m/s`);
console.log(`    Impulse Magnitude: ${impact.impulseMagnitude.toFixed(1)} N*s`);
console.log(`    Damage A: ${impact.damageA.toFixed(1)}%, Damage B: ${impact.damageB.toFixed(1)}%`);

assert(impact.relativeSpeed < 0, 'Relative approach velocity must be negative');
assert(impact.impulseMagnitude < 0, 'Impulse magnitude must be calculated');
assert(impact.damageA > 0, 'Damage must be applied for relative impact speed > 1.5 m/s');
assert.strictEqual(impact.damageA, impact.damageB, 'Equal mass head-on impact should deal symmetric damage');

// Low-speed brush test (below minImpactSpeed)
const lowSpeedA: RoverCollider = {
  id: 'a_slow',
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(0.5, 0, 0),
  heading: 0,
  mass: 700,
  radius: 1.6,
  isPlayer: true,
  damage: 0,
};
const lowSpeedB: RoverCollider = {
  id: 'b_slow',
  position: new THREE.Vector3(2.0, 0, 0),
  velocity: new THREE.Vector3(-0.5, 0, 0),
  heading: Math.PI,
  mass: 700,
  radius: 1.6,
  isPlayer: false,
  damage: 0,
};
const lowSpeedImpacts = collisionSystem.checkCollisions([lowSpeedA, lowSpeedB]);
assert.strictEqual(lowSpeedImpacts.length, 1, 'Impulse should still be resolved for low-speed contact');
assert.strictEqual(lowSpeedImpacts[0].damageA, 0, 'No damage should be dealt below minImpactSpeed threshold');
assert.strictEqual(lowSpeedImpacts[0].damageB, 0, 'No damage should be dealt below minImpactSpeed threshold');
console.log('  ✓ Inelastic collision impulse and damage threshold validated.');

// 2. NPC Competitor Controller Behavior
console.log('\n[2/3] NPC Competitor Controller & State Management');
const npcController = new NPCCompetitorController();

const npc1: NPCCompetitor = {
  id: 'kaguya-01',
  name: 'Kaguya Prospector',
  position: new THREE.Vector3(-10, 0, 10),
  velocity: new THREE.Vector3(1, 0, 0),
  heading: 0,
  mass: 700,
  radius: 1.6,
  isPlayer: false,
  damage: 15,
  totalDelivered: 2,
};

npcController.addCompetitor(npc1);
const list = npcController.getCompetitors();
assert.strictEqual(list.length, 1, 'Should contain 1 registered competitor');
assert.strictEqual(list[0].id, 'kaguya-01', 'Competitor ID must match');

// Step NPC update
npcController.update(0.016);
assert(!isNaN(list[0].position.x), 'Position must be valid number after update');
assert(list[0].velocity.length() <= 3.01, 'Velocity must stay within clamped speed limit');
console.log('  ✓ NPC competitor tracking and movement bounds verified.');

// 3. Lunar Wave Manager & Economy Scoreboard
console.log('\n[3/3] Lunar Wave Progression & Resource Scoreboard');
const waveManager = new LunarWaveManager();

assert.strictEqual(waveManager.waveState, 'WAVE_ACTIVE', 'Initial state must be WAVE_ACTIVE');
waveManager.completeWave();
assert.strictEqual(waveManager.waveState, 'WAVE_COMPLETE', 'State after completeWave() must be WAVE_COMPLETE');

const advanced = waveManager.nextWave();
assert.strictEqual(advanced, true, 'Advancing to Wave 2 must succeed');
assert.strictEqual(waveManager.waveState, 'WAVE_ACTIVE', 'State after nextWave() must reset to WAVE_ACTIVE');

const scoreboard = waveManager.getScoreboard(12.5);
assert(scoreboard.length >= 1, 'Scoreboard must contain player entry');
assert.strictEqual(scoreboard[0].id, 'player', 'First entry should be player');
assert.strictEqual(scoreboard[0].damage, 13, 'Damage must be rounded in scoreboard');
console.log('  ✓ Wave progression lifecycle and resource scoreboard verified.');

console.log('\n🎉 [TASK-PLAY-044] All Collision Physics, NPC Controller & Wave System verification tests PASSED!\n');
