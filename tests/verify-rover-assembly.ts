import * as THREE from 'three';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ApolloRoverModel } from '../src/minigames/moonbuggy2/ApolloRoverModel';
import { RoboticArmController } from '../src/minigames/moonbuggy2/RoboticArmController';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🧪 [Piglet Triage] Running Artemis LTV Assembly & Kinematics Verification...\n');

// 1. Validate raw glTF 2.0 structure of apollo_lrv.glb
const glbPath = path.resolve(__dirname, '../public/models/apollo_lrv.glb');
if (!fs.existsSync(glbPath)) {
  console.error(`❌ Missing GLB at: ${glbPath}`);
  process.exit(1);
}

const buffer = fs.readFileSync(glbPath);
const magic = buffer.toString('utf8', 0, 4);
if (magic !== 'glTF') {
  console.error(`❌ Invalid GLB magic: ${magic}`);
  process.exit(1);
}

const chunkLen = buffer.readUInt32LE(12);
const jsonString = buffer.toString('utf8', 20, 20 + chunkLen);
const gltf = JSON.parse(jsonString);

console.log('[1/4] Inspecting glTF Node Transforms & Coordinate Alignment...');
const nodesByName = new Map<string, any>();
gltf.nodes.forEach((n: any, idx: number) => {
  if (n.name) nodesByName.set(n.name, { ...n, _index: idx });
});

// Check Knuckles & Wheels
const knuckleFL = nodesByName.get('SteeringKnuckle_FL');
const knuckleFR = nodesByName.get('SteeringKnuckle_FR');
const knuckleRL = nodesByName.get('SteeringKnuckle_RL');
const knuckleRR = nodesByName.get('SteeringKnuckle_RR');

if (!knuckleFL || !knuckleFR || !knuckleRL || !knuckleRR) {
  console.error('❌ Missing SteeringKnuckle nodes in glTF');
  process.exit(1);
}

// Check knuckle translations (Blender +Y -> glTF -Z)
// FL should be at -X (left), -Z (front)
if (knuckleFL.translation[0] >= 0 || knuckleFL.translation[2] >= 0) {
  console.error(`❌ SteeringKnuckle_FL not at front-left: ${JSON.stringify(knuckleFL.translation)}`);
  process.exit(1);
}
// FR should be at +X (right), -Z (front)
if (knuckleFR.translation[0] <= 0 || knuckleFR.translation[2] >= 0) {
  console.error(`❌ SteeringKnuckle_FR not at front-right: ${JSON.stringify(knuckleFR.translation)}`);
  process.exit(1);
}
// RL should be at -X (left), +Z (rear)
if (knuckleRL.translation[0] >= 0 || knuckleRL.translation[2] <= 0) {
  console.error(`❌ SteeringKnuckle_RL not at rear-left: ${JSON.stringify(knuckleRL.translation)}`);
  process.exit(1);
}
// RR should be at +X (right), +Z (rear)
if (knuckleRR.translation[0] <= 0 || knuckleRR.translation[2] <= 0) {
  console.error(`❌ SteeringKnuckle_RR not at rear-right: ${JSON.stringify(knuckleRR.translation)}`);
  process.exit(1);
}

console.log('  ✓ SteeringKnuckle coordinates match Three.js chassis frame:');
console.log(`      FL: [${knuckleFL.translation.map((v: number) => v.toFixed(2)).join(', ')}] (Front-Left)`);
console.log(`      FR: [${knuckleFR.translation.map((v: number) => v.toFixed(2)).join(', ')}] (Front-Right)`);
console.log(`      RL: [${knuckleRL.translation.map((v: number) => v.toFixed(2)).join(', ')}] (Rear-Left)`);
console.log(`      RR: [${knuckleRR.translation.map((v: number) => v.toFixed(2)).join(', ')}] (Rear-Right)`);

// Check Wheel parenting and identity rest transform
for (const label of ['FL', 'FR', 'RL', 'RR']) {
  const knuckle = nodesByName.get(`SteeringKnuckle_${label}`);
  const wheel = nodesByName.get(`Wheel_${label}`);
  if (!wheel) {
    console.error(`❌ Missing Wheel_${label} in glTF`);
    process.exit(1);
  }
  if (!knuckle.children || !knuckle.children.includes(wheel._index)) {
    console.error(`❌ Wheel_${label} is not a child of SteeringKnuckle_${label}`);
    process.exit(1);
  }
  if (wheel.translation && (wheel.translation[0] !== 0 || wheel.translation[1] !== 0 || wheel.translation[2] !== 0)) {
    console.error(`❌ Wheel_${label} has non-zero translation relative to knuckle: ${JSON.stringify(wheel.translation)}`);
    process.exit(1);
  }
}
console.log('  ✓ All 4 wheels correctly parented under SteeringKnuckles at local (0, 0, 0) origin.');

console.log('\n[2/4] Inspecting 4-DOF Robotic Arm Joint Hierarchy...');
const armBase = nodesByName.get('RoboticArm_Base');
const armBoom = nodesByName.get('RoboticArm_Boom');
const armForearm = nodesByName.get('RoboticArm_Forearm');
const armClaw = nodesByName.get('RoboticArm_Claw');

if (!armBase || !armBoom || !armForearm || !armClaw) {
  console.error('❌ Missing RoboticArm nodes in glTF');
  process.exit(1);
}

// Arm base at starboard front (+X, -Z)
if (armBase.translation[0] <= 0 || armBase.translation[2] >= 0) {
  console.error(`❌ RoboticArm_Base not at starboard front: ${JSON.stringify(armBase.translation)}`);
  process.exit(1);
}
console.log(`  ✓ RoboticArm_Base at starboard front: [${armBase.translation.map((v: number) => v.toFixed(2)).join(', ')}]`);

// Parent chain verification
if (!armBase.children || !armBase.children.includes(armBoom._index)) {
  console.error('❌ RoboticArm_Boom not child of RoboticArm_Base');
  process.exit(1);
}
if (!armBoom.children || !armBoom.children.includes(armForearm._index)) {
  console.error('❌ RoboticArm_Forearm not child of RoboticArm_Boom');
  process.exit(1);
}
if (!armForearm.children || !armForearm.children.includes(armClaw._index)) {
  console.error('❌ RoboticArm_Claw not child of RoboticArm_Forearm');
  process.exit(1);
}

// Check joint offsets along -Z
if (Math.abs(armForearm.translation[2] - (-0.92)) > 0.05) {
  console.error(`❌ Forearm elbow offset along -Z expected ~ -0.92m, got: ${armForearm.translation[2]}`);
  process.exit(1);
}
if (Math.abs(armClaw.translation[2] - (-0.82)) > 0.05) {
  console.error(`❌ Claw wrist offset along -Z expected ~ -0.82m, got: ${armClaw.translation[2]}`);
  process.exit(1);
}

console.log('  ✓ Continuous parent chain: Base -> Boom -> Forearm -> Claw');
console.log(`  ✓ Forearm elbow pivot: ${armForearm.translation[2].toFixed(2)}m along -Z`);
console.log(`  ✓ Claw wrist pivot: ${armClaw.translation[2].toFixed(2)}m along -Z`);

console.log('\n[3/4] Testing Model Kinematic Binding & Wheel Transform Updates...');
const model = new ApolloRoverModel();

// Simulate bound GLTF knuckles & wheels
const mockKnuckles: THREE.Object3D[] = [];
const mockWheels: THREE.Object3D[] = [];
for (let i = 0; i < 4; i++) {
  const k = new THREE.Object3D();
  const w = new THREE.Object3D();
  k.add(w);
  mockKnuckles.push(k);
  mockWheels.push(w);
}
model.gltfKnuckles = mockKnuckles;
model.gltfWheels = mockWheels;

// Update transforms with 25 deg steer and 45 deg roll
const testSteer = 0.436; // 25 deg
const testRoll = 0.785;  // 45 deg
const wheelPositions = [
  new THREE.Vector3(-1.02, 0, -1.15),
  new THREE.Vector3(1.02, 0, -1.15),
  new THREE.Vector3(-1.02, 0, 1.15),
  new THREE.Vector3(1.02, 0, 1.15),
];
const wheelRotations = [
  new THREE.Euler(testRoll, 0, 0),
  new THREE.Euler(testRoll, 0, 0),
  new THREE.Euler(testRoll, 0, 0),
  new THREE.Euler(testRoll, 0, 0),
];

model.updateWheelTransforms(wheelPositions, wheelRotations, testSteer);

// Assert knuckle steering
if (Math.abs(mockKnuckles[0].rotation.y - testSteer) > 1e-4) {
  console.error(`❌ Front knuckle steering incorrect: ${mockKnuckles[0].rotation.y}`);
  process.exit(1);
}
if (Math.abs(mockKnuckles[2].rotation.y - (-testSteer * 0.7)) > 1e-4) {
  console.error(`❌ Rear knuckle counter-steering incorrect: ${mockKnuckles[2].rotation.y}`);
  process.exit(1);
}

// Assert wheel rolling and ZERO lateral displacement
for (let i = 0; i < 4; i++) {
  const w = mockWheels[i];
  if (Math.abs(w.rotation.x - testRoll) > 1e-4) {
    console.error(`❌ Wheel ${i} roll rotation incorrect: ${w.rotation.x}`);
    process.exit(1);
  }
  if (w.position.length() > 1e-4) {
    console.error(`❌ Wheel ${i} has non-zero position relative to knuckle (floating): ${JSON.stringify(w.position)}`);
    process.exit(1);
  }
}
console.log('  ✓ Knuckle yaw steering angles verified (front steer, rear counter-steer)');
console.log('  ✓ Wheel forward rolling verified on X axis');
console.log('  ✓ Wheel position remains strictly (0, 0, 0) relative to knuckle (0.00m lateral drift)');

console.log('\n[4/4] Testing Robotic Arm Articulation Cycle...');
const armController = new RoboticArmController(model);
const mockBase = new THREE.Object3D();
const mockBoom = new THREE.Object3D();
const mockForearm = new THREE.Object3D();
const mockClaw = new THREE.Object3D();
model.armBaseNode = mockBase;
model.armBoomNode = mockBoom;
model.armForearmNode = mockForearm;
model.armClawNode = mockClaw;

let cycleCompleted = false;
let grabFired = false;

armController.triggerPickup({
  targetWorldPos: new THREE.Vector3(2.5, 0, -3.0),
  roverPos: new THREE.Vector3(0, 0, 0),
  roverHeading: 0,
  onGrab: () => { grabFired = true; },
  onComplete: () => { cycleCompleted = true; },
});

// Step Phase 1: Targeting (t = 0.25s / 1.4s)
armController.update(0.25);
if (mockBoom.rotation.x >= 0) {
  console.error(`❌ Boom pitch did not tilt downward during targeting: ${mockBoom.rotation.x}`);
  process.exit(1);
}
if (mockForearm.rotation.x >= 0) {
  console.error(`❌ Forearm pitch did not tilt downward during targeting: ${mockForearm.rotation.x}`);
  process.exit(1);
}
console.log(`  ✓ Phase 1 (Targeting): Base yaw=${mockBase.rotation.y.toFixed(2)}rad, Boom pitch=${mockBoom.rotation.x.toFixed(2)}rad (downward reach)`);

// Step Phase 2: Grabbing (t = 0.35s -> total 0.60s)
armController.update(0.35);
if (!grabFired) {
  console.error('❌ onGrab callback did not fire in Phase 2');
  process.exit(1);
}
console.log('  ✓ Phase 2 (Grabbing): onGrab callback fired, specimen secured');

// Step Phase 3: Stowing (t = 0.40s -> total 1.00s)
armController.update(0.40);
if (mockBase.rotation.y < 1.0) {
  console.error(`❌ Turret did not swing toward rear cargo bay during stow: ${mockBase.rotation.y}`);
  process.exit(1);
}
if (mockBoom.rotation.x <= 0) {
  console.error(`❌ Boom did not lift upward over cargo bay during stow: ${mockBoom.rotation.x}`);
  process.exit(1);
}
console.log(`  ✓ Phase 3 (Stowing): Base swung rearward (${mockBase.rotation.y.toFixed(2)}rad), Boom lifted (${mockBoom.rotation.x.toFixed(2)}rad)`);

// Step Phase 4: Retracting to complete (t = 0.45s -> total 1.45s)
armController.update(0.45);
if (!cycleCompleted) {
  console.error('❌ Cycle did not complete');
  process.exit(1);
}
if (mockBase.rotation.y !== 0 || mockBoom.rotation.x !== 0 || mockForearm.rotation.x !== 0 || mockClaw.rotation.x !== 0) {
  console.error('❌ Arm did not return to identity rest pose after cycle');
  process.exit(1);
}
console.log('  ✓ Phase 4 (Completion): Arm smoothly returned to identity aerodynamic rest pose (0, 0, 0)');

console.log('\n========================================================================');
console.log('🎉 [Piglet Triage] ALL ARTEMIS LTV ASSEMBLY & KINEMATICS CHECKS PASSED!');
console.log('========================================================================\n');
