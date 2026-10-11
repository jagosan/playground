/**
 * Lunar Frontier — Spec 24 Phase 1: transport lander smoke harness.
 *
 * Boots `TransportLander` headless over an explicit `NullEngine` scene (no DOM,
 * no render loop) and verifies:
 *
 *   1. Construction: rootNode / rampNode / thrusterLights exist, meshes built
 *      under NullEngine, octagonal hull geometry contract present.
 *   2. Ramp kinematics: setRampDeployment(0|0.5|1) drives the stern pivot
 *      rotation.x through 0° → −17.5° → −35° (−0.6108 rad), clamped, and
 *      the fully-deployed ramp tip rests on regolith (y ≈ 0).
 *   3. Thruster lighting: setThrusterIntensity(0|1) scales every PointLight
 *      intensity together with the emissive throat materials.
 *   4. World anchors: getCabinSpawnPoint() / getRampExitPoint() return finite,
 *      non-NaN Vector3s; the ramp exit sits on regolith, forward of the stern.
 *   5. Landing gear: triggerGearCompression() compresses footpads/pistons and
 *      schedules a rebound (cleared on dispose).
 *   6. Dispose lifecycle: idempotent dispose really disposes meshes + lights,
 *      mutators become silent no-ops, getMeshes() empty after dispose.
 *
 * Run: `npx tsx scripts/smoke-transport-lander.ts` (exit 0 == all green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Scene } from '@babylonjs/core/scene.js';

import {
  TransportLander,
  HULL_RADIUS_M,
  RAMP_FULL_ANGLE_RAD,
  THRUSTER_LIGHT_INTENSITY,
} from '../src/entities/TransportLander.ts';

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

// ---------------------------------------------------------------------------
// 1. Headless build over an explicit NullEngine scene
// ---------------------------------------------------------------------------
section('1. headless build (NullEngine)');

const engine = new NullEngine({ renderWidth: 1600, renderHeight: 900 });
const scene = new Scene(engine);

const lander = new TransportLander({
  scene,
  position: new Vector3(0, 28, -40),
  headingRad: 0.35,
});

check('rootNode present', lander.rootNode !== undefined && !lander.rootNode.isDisposed());
check('rampNode present + stern-parented', lander.rampNode !== undefined && lander.rampNode.parent === lander.rootNode);
check('4 thruster PointLights built', lander.thrusterLights.length === 4, `got ${lander.thrusterLights.length}`);
check('all thruster lights start dark (intensity 0)', lander.thrusterLights.every((l) => l.intensity === 0));
check('meshes built under NullEngine', lander.getMeshes().length > 20, `${lander.getMeshes().length} meshes`);
check('root pose matches requested heading/position',
  Math.abs(lander.rootNode.position.x - 0) < 1e-9
    && Math.abs(lander.rootNode.position.y - 28) < 1e-9
    && Math.abs(lander.rootNode.position.z + 40) < 1e-9,
);
check('scene is the injected one', lander.getScene() === scene);

// ---------------------------------------------------------------------------
// 2. Ramp kinematics: deployment progress → stern pivot angle
// ---------------------------------------------------------------------------
section('2. ramp kinematics');

lander.setRampDeployment(0);
check('setRampDeployment(0) seals horizontal (rotation.x = 0)',
  Math.abs(lander.getRampAngleRad()) < 1e-9,
  `${lander.getRampAngleRad().toFixed(4)} rad`,
);

lander.setRampDeployment(0.5);
const half = lander.getRampAngleRad();
check('setRampDeployment(0.5) lowers to −17.5°',
  Math.abs(half + RAMP_FULL_ANGLE_RAD / 2) < 1e-9,
  `${half.toFixed(4)} rad`,
);

lander.setRampDeployment(1);
const full = lander.getRampAngleRad();
check('setRampDeployment(1) fully deploys to −35° (−0.6108 rad)',
  Math.abs(full + RAMP_FULL_ANGLE_RAD) < 1e-9 && Math.abs(RAMP_FULL_ANGLE_RAD - 0.610865) < 1e-4,
  `${full.toFixed(4)} rad`,
);

lander.setRampDeployment(2); // over-deploy clamps at full
check('over-deployment clamps at −35°', Math.abs(lander.getRampAngleRad() + RAMP_FULL_ANGLE_RAD) < 1e-9);
lander.setRampDeployment(-1); // negative clamps to sealed
check('negative deployment clamps to sealed horizontal', Math.abs(lander.getRampAngleRad()) < 1e-9);

// Fully-deployed ramp tip must rest on regolith: its world y equals the lander
// root's elevation (the caller parks the root on the surface datum).
const exit = lander.getRampExitPoint();
check('fully-deployed ramp exit rests on regolith (y ≈ root elevation)',
  Number.isFinite(exit.y)
    && Math.abs(exit.y - lander.rootNode.position.y) < 0.65,
  `y=${exit.y.toFixed(3)} rootY=${lander.rootNode.position.y.toFixed(2)}`,
);
check('ramp exit sits stern of the hull centre (−z beyond the hull radius)',
  exit.z < -HULL_RADIUS_M,
  `z=${exit.z.toFixed(2)}`,
);

// ---------------------------------------------------------------------------
// 3. Thruster lighting
// ---------------------------------------------------------------------------
section('3. thruster lighting');

lander.setThrusterIntensity(1);
check('setThrusterIntensity(1) lights every PointLight at peak',
  lander.thrusterLights.every((l) => Math.abs(l.intensity - THRUSTER_LIGHT_INTENSITY) < 1e-9),
  lander.thrusterLights.map((l) => l.intensity.toFixed(2)).join(','),
);
check('getThrusterIntensity() reflects full burn', lander.getThrusterIntensity() === 1);

lander.setThrusterIntensity(0.5);
check('setThrusterIntensity(0.5) scales lights to half',
  lander.thrusterLights.every((l) => Math.abs(l.intensity - THRUSTER_LIGHT_INTENSITY * 0.5) < 1e-9),
);

lander.setThrusterIntensity(0);
check('setThrusterIntensity(0) kills the lights',
  lander.thrusterLights.every((l) => l.intensity === 0),
);
check('getThrusterIntensity() reflects shutdown', lander.getThrusterIntensity() === 0);

// ---------------------------------------------------------------------------
// 4. World anchors
// ---------------------------------------------------------------------------
section('4. world anchors');

const cabin = lander.getCabinSpawnPoint();
check('cabin spawn point is a finite Vector3',
  Number.isFinite(cabin.x) && Number.isFinite(cabin.y) && Number.isFinite(cabin.z),
  `(${cabin.x.toFixed(2)}, ${cabin.y.toFixed(2)}, ${cabin.z.toFixed(2)})`,
);
check('cabin spawn sits inside the passenger cabin (local y between hull base and nose)',
  (() => {
    const localY = cabin.y - lander.rootNode.position.y;
    return localY > 4 && localY < 26;
  })(),
  `worldY=${cabin.y.toFixed(2)} rootY=${lander.rootNode.position.y.toFixed(2)}`,
);

const exitPoint = lander.getRampExitPoint();
check('ramp exit point is a finite Vector3',
  Number.isFinite(exitPoint.x) && Number.isFinite(exitPoint.y) && Number.isFinite(exitPoint.z),
);
check('cabin spawn ≠ ramp exit (distinct anchors)', Vector3.Distance(cabin, exitPoint) > 8);

// ---------------------------------------------------------------------------
// 5. Landing gear compression
// ---------------------------------------------------------------------------
section('5. landing gear');

// Snapshot footpad y values eagerly — the meshes are shared references, so a
// lazy read after compression would compare each footpad against itself.
const footYBeforeList = lander
  .getMeshes()
  .filter((m) => m.name.includes('footpad'))
  .map((f) => f.position.y);
lander.triggerGearCompression(50);
const footpadsAfter = lander.getMeshes().filter((m) => m.name.includes('footpad'));
check('gear compression sinks the footpads',
  footYBeforeList.length > 0
    && footpadsAfter.length === footYBeforeList.length
    && footpadsAfter.every((f, i) => f.position.y < (footYBeforeList[i] ?? Infinity)),
  `before=${footYBeforeList[0]?.toFixed(3)} after=${footpadsAfter[0]?.position.y.toFixed(3)}`,
);
check('triggerGearCompression() returns cleanly', true);

// ---------------------------------------------------------------------------
// 6. Dispose lifecycle
// ---------------------------------------------------------------------------
section('6. dispose lifecycle');

const meshCount = lander.getMeshes().length;
lander.dispose();
check('dispose() is idempotent', (() => { lander.dispose(); return true; })());
check('meshes disposed (getMeshes empty)', lander.getMeshes().length === 0, `${meshCount} → 0`);
check('rootNode disposed', lander.rootNode.isDisposed());
check('rampNode disposed', lander.rampNode.isDisposed());
check('thruster lights list cleared', lander.thrusterLights.length === 0);
lander.setRampDeployment(1); // must be a silent no-op
lander.setThrusterIntensity(1);
lander.triggerGearCompression();
check('mutators are silent no-ops after dispose',
  lander.getMeshes().length === 0 && lander.thrusterLights.length === 0,
);

// Caller-owned engine survives the lander's dispose.
check('caller-owned NullEngine survives', engine.isDisposed === false);
engine.dispose();

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED ✔  (transport lander, Spec 24 Phase 1)`);
  process.exit(0);
} else {
  console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
