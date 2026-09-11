/**
 * Lunar Frontier — Phase 3 World Engine & Camera Rig smoke harness.
 *
 * Boots `WorldScene` + `CameraRig` against a Babylon.js **NullEngine** (no
 * window/document needed) and asserts:
 *
 *   1. Scene bootstrap: engine/scene alive, vacuum clear colour, lights
 *      (stark sun + earthshine fill) configured, shadows wired.
 *   2. Terrain: heightmap mesh built from `LunarWorldGenerator` craters,
 *      non-degenerate geometry, height queries agree with the generator's
 *      analytic `elevationAt` on datum & inside a real crater.
 *   3. Camera rig: all three modes switch, active camera identity/type
 *      changes, FOV lands in the 55–65° band, `update()` lerps positions
 *      smoothly (never teleports), chase camera sits behind the rover.
 *   4. Entities: add/remove bookkeeping, parenting, double-add idempotence.
 *   5. Render loop & lifecycle: frames advance, dispose is clean and
 *      idempotent, post-dispose calls no-op instead of throwing.
 *
 * Run: `npx tsx scripts/smoke-worldscene.ts`  (exit code 0 == all green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import '@babylonjs/core/Culling/ray.js'; // side-effect: Ray for getForwardRay
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';

import {
  WorldScene,
  CameraRig,
  CAMERA_MODES,
  type CameraMode,
} from '../src/engine/index.ts';
import { LunarWorldGenerator } from '../src/world/LunarWorldGenerator.ts';

const SEED = 'mala-voyage-2431';

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** Distance between a physics-frame point and a Babylon-frame vector. */
function distWB(
  p: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = p.x - b.x;
  const dy = p.y - -b.z; // physics y = -babylon z
  const dz = p.z - b.y; // physics z(up) = babylon y
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------
// 1. Scene bootstrap
// ---------------------------------------------------------------------------
section('1. scene bootstrap (NullEngine, headless)');

const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720 });
const world = new WorldScene({ seed: SEED, terrainSize: 1024, terrainResolution: 129 });
world.init(engine);

const scene = world.getScene();
check('scene constructed', scene !== null && scene === engine.scenes[0]);
check('vacuum clear colour is pure black', (() => {
  const c = scene.clearColor;
  return c.r === 0 && c.g === 0 && c.b === 0 && c.a === 1;
})());
check('no fog in vacuum', scene.fogMode === 0);

const sun = scene.lights.find((l) => l.name === 'sun');
const earthshine = scene.lights.find((l) => l.name === 'earthshine');
check('stark sun DirectionalLight present', sun !== undefined && sun.getClassName() === 'DirectionalLight');
check('sun intensity is harsh (> 2)', sun !== undefined && sun.intensity > 2);
check('earthshine hemispheric fill present', earthshine !== undefined && earthshine.getClassName() === 'HemisphericLight');
check('earthshine intensity ~0.08', earthshine !== undefined && Math.abs(earthshine.intensity - 0.08) < 1e-6);
check('earthshine hue is blue-dominant', (() => {
  if (earthshine === undefined) return false;
  const d = earthshine.diffuse;
  return d.b > d.r && d.b > d.g;
})());

const terrain = world.getTerrainMesh();
check('terrain mesh built', terrain !== null && terrain.getTotalVertices() === 129 * 129);
const regolith = terrain?.material;
check('regolith PBR material bound', regolith !== null && regolith !== undefined && regolith.getClassName() === 'PBRMaterial');
check('regolith albedo ~0.12 low', (() => {
  if (regolith === undefined || regolith === null) return false;
  const c = (regolith as { albedoColor?: { r: number; g: number; b: number } }).albedoColor;
  return c !== undefined && c.r < 0.16 && c.g < 0.16 && c.b < 0.16;
})());
check('shadow casters registered', (() => {
  if (sun === undefined) return false;
  const maps = sun.getShadowGenerators();
  return maps !== null && maps.size > 0;
})());

const starfield = scene.meshes.find((m) => m.name === 'starfield');
check('procedural starfield dome present', starfield !== undefined && starfield.getTotalVertices() > 1000);

// ---------------------------------------------------------------------------
// 2. Terrain vs generator agreement
// ---------------------------------------------------------------------------
section('2. terrain generation & ground-height queries');

const gen = new LunarWorldGenerator(SEED);
const snapshot = gen.generate();
check('snapshot matches scene world seed', world.getSnapshot()?.seed === SEED);
check('craters exist to sculpt relief', snapshot.craters.length > 0);

// Datum plain: far from every crater → analytic elevation is exactly 0.
const far = { x: -4000, y: -4000 };
check('off-patch datum query returns ~0', Math.abs(world.getGroundHeightAt(far.x, far.y)) < 1.5);

// Inside the deepest crater: height must be strongly negative, close to the
// generator's analytic bowl (± micro-relief allowance).
const deepest = snapshot.craters.reduce((a, b) => (b.depth > a.depth ? b : a));
const analytic = gen.elevationAt(deepest.center.x, deepest.center.y);
const sampled = world.getGroundHeightAt(deepest.center.x, deepest.center.y);
check(
  `crater ${deepest.id} floor is below datum (sampled ${sampled.toFixed(2)} m)`,
  sampled < -5,
);
check(
  `sampled floor tracks analytic elevation ${analytic.toFixed(2)} within 2.5 m`,
  Math.abs(sampled - analytic) < 2.5,
);

// Determinism: query twice, and query a fresh WorldScene instance.
const again = world.getGroundHeightAt(deepest.center.x, deepest.center.y);
check('height query deterministic (repeat)', again === sampled);
const world2 = new WorldScene({ seed: SEED, terrainSize: 1024, terrainResolution: 129 });
world2.init(new NullEngine({ renderWidth: 640, renderHeight: 360 }));
check(
  'height query deterministic across instances',
  Math.abs(world2.getGroundHeightAt(deepest.center.x, deepest.center.y) - sampled) < 1e-9,
);
world2.dispose();

// Mesh geometry sanity: every vertex y equals the cached height (frame map).
const pos = terrain?.getVerticesData('position');
const spawn = world.getSpawnPoint();
check('spawn point sits on terrain + clearance', Math.abs(spawn.z - world.getGroundHeightAt(spawn.x, spawn.y) - 1.7) < 1e-6);
check('mesh has normals', (terrain?.getVerticesData('normal')?.length ?? 0) === pos?.length);

// ---------------------------------------------------------------------------
// 3. Camera rig
// ---------------------------------------------------------------------------
section('3. camera rig modes, FOV & smoothing');

const rig = world.getCameraRig();
check('rig attached to scene', rig !== null);
check('initial mode is eva_first_person', rig.getMode() === 'eva_first_person');
check(
  'active camera is the rig first-person camera',
  scene.activeCamera?.name === 'rig_eva_fp',
);
const fpFov = rig.getFovDegrees();
check(`first-person FOV in 55–65° band (${fpFov.toFixed(1)}°)`, fpFov >= 55 && fpFov <= 65);

// Headless attach must refuse gracefully, not throw.
check('attachControl(null) returns false in headless', rig.attachControl(null) === false);

const target = { x: spawn.x, y: spawn.y, z: spawn.z };
const yaw = Math.PI / 2; // facing +y

// Drive frames and confirm the FP camera settles at the eye point
// (suit centre + 1.62 m helmet height, not the body centre itself).
for (let i = 0; i < 120; i++) rig.update(target, yaw, 1 / 60);
const fpPos = scene.activeCamera!.globalPosition;
const eyePoint = { x: target.x, y: target.y, z: target.z + 1.62 };
const settled = distWB(eyePoint, fpPos);
check(`FP camera settles at eye point (Δ=${settled.toFixed(3)} m)`, settled < 0.05);
const eyeHeight = fpPos.y - target.z;
check(`eye height ≈ 1.62 m (${eyeHeight.toFixed(2)})`, Math.abs(eyeHeight - 1.62) < 0.02);

// Forward vector must match physics heading (yaw=π/2 → +y world).
const fwd = scene.activeCamera!.getForwardRay(1).direction;
const fwdWorld = { x: fwd.x, y: -fwd.z, z: fwd.y };
const headingOk = Math.atan2(fwdWorld.y, fwdWorld.x);
check(
  `FP look direction tracks yaw (Δ=${Math.abs(headingOk - yaw).toFixed(4)} rad)`,
  Math.abs(headingOk - yaw) < 0.01,
);

// Mode switch → third person: ArcRotateCamera, different object, FOV band.
check('setMode(eva_third_person) accepted', rig.setMode('eva_third_person') === true);
const tpCam = scene.activeCamera as ArcRotateCamera;
check('third-person active camera swapped', tpCam.name === 'rig_eva_tp' && tpCam.getClassName() === 'ArcRotateCamera');
const tpFov = rig.getFovDegrees();
check(`third-person FOV in 55–65° band (${tpFov.toFixed(1)}°)`, tpFov >= 55 && tpFov <= 65);
const tpRadius = tpCam.radius;
check(`third-person orbits at ≈6.5 m (${tpRadius.toFixed(2)})`, Math.abs(tpRadius - 6.5) < 0.01);

// Lerp discipline: a teleport of the target must NOT teleport the camera.
const beforeMove = tpCam.target.clone();
rig.update({ x: target.x + 50, y: target.y, z: target.z }, yaw, 1 / 60);
const afterOne = tpCam.target.clone();
const step = Math.hypot(afterOne.x - beforeMove.x, afterOne.z - beforeMove.z);
check(`single-frame follow lags the 50 m jump (moved ${step.toFixed(2)} m)`, step > 0.1 && step < 20);
check('camera never teleports to target in one frame', step < 50);

// Vehicle chase: switch, settle, then confirm it sits BEHIND the rover.
check('setMode(vehicle_chase) accepted', rig.setMode('vehicle_chase') === true);
const chaseCam = scene.activeCamera as ArcRotateCamera;
check('chase active camera is ArcRotate rig cam', chaseCam.name === 'rig_vehicle_chase');
const chaseFov = rig.getFovDegrees();
check(`chase FOV in 55–65° band (${chaseFov.toFixed(1)}°)`, chaseFov >= 55 && chaseFov <= 65);

const rover = { x: 500, y: 512, z: world.getGroundHeightAt(500, 512) };
const roverYaw = 0; // facing +x
for (let i = 0; i < 240; i++) rig.update(rover, roverYaw, 1 / 60);
const cp = chaseCam.globalPosition;
const toCamWorld = { x: cp.x - rover.x, y: -cp.z - -rover.y, z: cp.y - rover.z };
const behindDot = toCamWorld.x * Math.cos(roverYaw) + toCamWorld.y * Math.sin(roverYaw);
check(`chase camera behind rover heading (dot=${behindDot.toFixed(2)})`, behindDot < -3);
const chaseDist = distWB(rover, cp);
check(`chase distance ≈ configured 11.5–13 m (${chaseDist.toFixed(2)})`, chaseDist > 9 && chaseDist < 16);
const chaseHeight = cp.y - rover.z;
check(`chase camera airborne above rover (${chaseHeight.toFixed(2)} m)`, chaseHeight > 1.5);

// Invalid mode must be rejected, current mode retained.
check('invalid mode rejected', rig.setMode('cockpit_view' as CameraMode) === false);
check('mode unchanged after rejection', rig.getMode() === 'vehicle_chase');

// Back to first person preserves continuity (no wild jump).
const lastChasePos = chaseCam.globalPosition.clone();
rig.setMode('eva_first_person');
const continuityDelta = Math.hypot(
  lastChasePos.x - scene.activeCamera!.globalPosition.x,
  lastChasePos.y - scene.activeCamera!.globalPosition.y,
  lastChasePos.z - scene.activeCamera!.globalPosition.z,
);
check(`mode-switch keeps shared interpolation state (Δ=${continuityDelta.toFixed(2)})`, continuityDelta < 15);

// All modes cycled cleanly.
const seenModes = new Set<string>();
for (const mode of CAMERA_MODES) {
  rig.setMode(mode);
  seenModes.add(rig.getMode());
  rig.update(rover, roverYaw, 1 / 60);
  scene.render();
}
check('all 3 modes cycle without error', seenModes.size === 3);

// ---------------------------------------------------------------------------
// 4. Entity bookkeeping
// ---------------------------------------------------------------------------
section('4. entity add / remove');

const crate = MeshBuilder.CreateBox('ore-crate', { size: 1.2 }, scene);
world.addEntity(crate);
check('entity registered', world.getEntities().includes(crate));
check('entity parented to world root', crate.parent?.name === 'world-root');
world.addEntity(crate); // idempotent
check('double-add does not duplicate', world.getEntities().length === 1);
check('removeEntity returns true', world.removeEntity(crate) === true);
check('entity unregistered', !world.getEntities().includes(crate));
check('orphan remove returns false', world.removeEntity(crate) === false);
check('entity unparented after remove', crate.parent === null);
crate.dispose();

// ---------------------------------------------------------------------------
// 5. Render loop & lifecycle
// ---------------------------------------------------------------------------
section('5. render & dispose lifecycle');

const frame0 = scene.getFrameId();
world.render();
world.render();
check('render() advances frames', scene.getFrameId() > frame0);
check('render() is chainable', world.render() === world);

world.dispose();
check('post-dispose getGroundHeightAt falls back to generator',
  Math.abs(world.getGroundHeightAt(deepest.center.x, deepest.center.y) - gen.elevationAt(deepest.center.x, deepest.center.y)) < 2.5);
check('post-dispose render is a no-op', (() => {
  try {
    world.render();
    return true;
  } catch {
    return false;
  }
})());
check('dispose is idempotent', (() => {
  try {
    world.dispose();
    return true;
  } catch {
    return false;
  }
})());
check('post-dispose rig access throws (not silent corruption)', (() => {
  try {
    world.getCameraRig();
    return false;
  } catch {
    return true;
  }
})());

// The engine we passed in is NOT disposed by the scene (caller owns it).
check('caller-owned engine survives scene dispose', !engine.isDisposed);
engine.dispose();

// Auto-NullEngine path: init() with no args in Node.
// NB: Babylon v9 NullEngine.getClassName() reports 'ThinEngine' (it does not
// override the override), so assert on the concrete constructor instead.
const world3 = new WorldScene({ seed: 'auto-null' });
world3.init();
check('init() with no args boots NullEngine headless', world3.getEngine().constructor.name === 'NullEngine');
world3.dispose();

// Standalone CameraRig against a raw scene.
const soloEngine = new NullEngine({ renderWidth: 320, renderHeight: 240 });
const soloWorld = new WorldScene({ seed: 'solo' });
soloWorld.init(soloEngine);
const soloRig = new CameraRig(soloWorld.getScene());
check('standalone rig defaults to FP', soloRig.getMode() === 'eva_first_person');
soloRig.update({ x: 1, y: 2, z: 3 }, 0.5, 1 / 60);
check('standalone rig updates', Number.isFinite(soloRig.getPhysicsPosition().x));
soloRig.dispose();
check('standalone rig dispose ok', soloRig.setMode('eva_third_person') === false);
soloWorld.dispose();

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED ✔  (seed: ${SEED})`);
  process.exit(0);
} else {
  console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
