/**
 * Spec 24 Phase 2 — IntroDirector + CameraRig intro tracks headless smoke test.
 *
 * Boots `IntroDirector` over a NullEngine scene with a real `CameraRig`
 * (intro_cabin / intro_cinematic modes) and a `TransportLander`, then
 * verifies:
 *
 *   1. CameraRig exposes the two new intro modes in `CAMERA_MODES`.
 *   2. Phase state machine: idle → orbit → burn → touchdown → depressurize →
 *      ramp → walkout → completed (auto-advance by duration).
 *   3. Lander effects per phase: thruster intensity during burn, gear
 *      compression on touchdown, ramp deployment across the ramp phase.
 *   4. jumpToPhase('touchdown') jumps directly and resets the timeline.
 *   5. skipCurrentPhase() advances to the next beat immediately.
 *   6. skipToFinish() transitions straight to 'completed' (fires onComplete).
 *   7. updateSkipInput accumulates hold time and returns true at ≥ 1.2 s
 *      (Spec 24 §3.2), skipping the current phase once.
 *   8. reset() restores lander (ramp closed, thrusters off) and returns to
 *      'idle'.
 *
 * Run: `npx tsx scripts/smoke-intro-director.ts` (exit 0 == all green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Scene } from '@babylonjs/core/scene.js';

import {
  CameraRig,
  CAMERA_MODES,
} from '../src/engine/CameraRig.ts';
import { TransportLander } from '../src/entities/TransportLander.ts';
import {
  IntroDirector,
  PHASE_DURATIONS,
  SKIP_HOLD_THRESHOLD_S,
  type IntroPhase,
} from '../src/client/IntroDirector.ts';

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

const approx = (a: number, b: number, eps = 1e-6): boolean =>
  Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// Headless scene + lander + camera rig
// ---------------------------------------------------------------------------
section('0. headless harness (NullEngine)');

const engine = new NullEngine({ renderWidth: 1600, renderHeight: 900 });
const scene = new Scene(engine);

const lander = new TransportLander({
  scene,
  position: new Vector3(0, 28, -40),
  headingRad: 0.35,
});
const rig = new CameraRig(scene);

check('CAMERA_MODES includes intro_cabin', CAMERA_MODES.includes('intro_cabin'));
check('CAMERA_MODES includes intro_cinematic', CAMERA_MODES.includes('intro_cinematic'));

// ---------------------------------------------------------------------------
// 1. State machine: full auto-advance
// ---------------------------------------------------------------------------
section('1. phase state machine (idle → … → completed)');

const phasesSeen: IntroPhase[] = [];
let completeCount = 0;

const director = new IntroDirector({
  scene,
  cameraRig: rig,
  lander,
  onPhaseChange: (p) => phasesSeen.push(p),
  onComplete: () => completeCount++,
});

check('initial phase is idle', director.getPhase() === 'idle');
check('not running before start', director.isRunning() === false);

director.start('orbit');
check('start("orbit") sets phase to orbit', director.getPhase() === 'orbit');
check('running after start', director.isRunning() === true);
check('orbit → intro_cabin camera mode', rig.getMode() === 'intro_cabin');

// Step through each duration boundary.
director.update(PHASE_DURATIONS.orbit); // 6s → burn
check('after orbit duration → burn', director.getPhase() === 'burn');
check('burn → intro_cinematic camera mode', rig.getMode() === 'intro_cinematic');
// Thruster intensity is driven on the first burn-frame update, not on the
// transition frame itself (the phase body runs before auto-advance).
director.update(0.01);
check('burn lights thrusters at full', lander.getThrusterIntensity() === 1);

director.update(PHASE_DURATIONS.burn); // 12s → touchdown
check('after burn duration → touchdown', director.getPhase() === 'touchdown');

director.update(PHASE_DURATIONS.touchdown); // 3.5s → depressurize
check('after touchdown duration → depressurize', director.getPhase() === 'depressurize');
check('depressurize → intro_cabin camera mode', rig.getMode() === 'intro_cabin');

director.update(PHASE_DURATIONS.depressurize); // 4s → ramp
check('after depressurize duration → ramp', director.getPhase() === 'ramp');

director.update(PHASE_DURATIONS.ramp); // 8s → walkout
check('after ramp duration → walkout', director.getPhase() === 'walkout');
check('walkout hands back to eva_first_person', rig.getMode() === 'eva_first_person');

director.update(PHASE_DURATIONS.walkout); // 10s → completed
check('after walkout duration → completed', director.getPhase() === 'completed');
check('onComplete fired once on natural completion', completeCount === 1);
check('running stops at completed', director.isRunning() === false);

// ---------------------------------------------------------------------------
// 2. Lander effects across phases
// ---------------------------------------------------------------------------
section('2. lander effects (thruster / gear / ramp)');

director.jumpToPhase('burn');
director.update(0.5);
check('burn phase drives thruster intensity to 1',
  approx(lander.getThrusterIntensity(), 1),
  `got ${lander.getThrusterIntensity()}`,
);

// Touchdown: gear compression fires once on entry — footpads sink. Capture the
// resting pose BEFORE jumpToPhase so the comparison sees the actual compression.
const footYBefore = lander
  .getMeshes()
  .filter((m) => m.name.includes('footpad'))
  .map((f) => f.position.y);
director.jumpToPhase('touchdown'); // triggers gear compression on entry
director.update(0.01); // enter the phase body (spool-down drives intensity < 1)
const footYAfter = lander
  .getMeshes()
  .filter((m) => m.name.includes('footpad'))
  .map((f) => f.position.y);
check('touchdown compresses gear footpads once',
  footYBefore.length > 0
    && footYAfter.length === footYBefore.length
    && footYAfter.every((y, i) => y < (footYBefore[i] ?? Infinity)),
);
check('touchdown spools thrusters down (< 1)',
  lander.getThrusterIntensity() > 0 && lander.getThrusterIntensity() < 1,
  `got ${lander.getThrusterIntensity().toFixed(3)}`,
);

// Ramp: deployment progress across the ramp phase.
director.jumpToPhase('ramp');
director.update(PHASE_DURATIONS.ramp / 2);
check('ramp partially deploys (angle < 0)',
  lander.getRampAngleRad() < -1e-6,
  `got ${lander.getRampAngleRad().toFixed(4)} rad`,
);
director.update(PHASE_DURATIONS.ramp / 2 + 0.01);
check('ramp fully deploys (≈ −35°)',
  approx(lander.getRampAngleRad(), -0.610865, 1e-3),
  `got ${lander.getRampAngleRad().toFixed(4)} rad`,
);

// ---------------------------------------------------------------------------
// 3. jumpToPhase
// ---------------------------------------------------------------------------
section('3. jumpToPhase');

director.jumpToPhase('touchdown');
check('jumpToPhase("touchdown") lands on touchdown', director.getPhase() === 'touchdown');
check('jump resets phase clock (phaseElapsed ≈ 0)',
  Math.abs(director.phaseElapsed) < 1e-9,
);
check('jump sets intro_cinematic mode', rig.getMode() === 'intro_cinematic');

// ---------------------------------------------------------------------------
// 4. skipCurrentPhase
// ---------------------------------------------------------------------------
section('4. skipCurrentPhase');

director.skipCurrentPhase();
check('skipCurrentPhase advances touchdown → depressurize',
  director.getPhase() === 'depressurize',
);

// ---------------------------------------------------------------------------
// 5. skipToFinish
// ---------------------------------------------------------------------------
section('5. skipToFinish');

const beforeSkip = completeCount;
director.skipToFinish();
check('skipToFinish transitions to completed', director.getPhase() === 'completed');
check('skipToFinish fires onComplete', completeCount === beforeSkip + 1);

// ---------------------------------------------------------------------------
// 6. updateSkipInput (hold-to-skip, Spec 24 §3.2)
// ---------------------------------------------------------------------------
section('6. updateSkipInput hold accumulation');

director.jumpToPhase('burn');
let held = false;
const step = 0.4; // 40 ms frames
for (let i = 1; i <= 5; i++) {
  const fired = director.updateSkipInput(true, step);
  if (fired) {
    held = true;
    break;
  }
}
// 3 × 0.4 = 1.2 s → threshold crossed on the third frame.
check('updateSkipInput returns true at ≥ 1.2 s hold', held);
check('hold-to-skip advances burn → touchdown',
  director.getPhase() === 'touchdown',
);

director.updateSkipInput(false, step);
check('releasing resets the skip accumulator',
  approx(director.getSkipHoldProgress(), 0),
  `got ${director.getSkipHoldProgress().toFixed(3)}`,
);

// ---------------------------------------------------------------------------
// 7. reset()
// ---------------------------------------------------------------------------
section('7. reset');

director.reset();
check('reset returns to idle', director.getPhase() === 'idle');
check('reset closes the ramp (sealed horizontal)',
  Math.abs(lander.getRampAngleRad()) < 1e-9,
);
check('reset kills thrusters', lander.getThrusterIntensity() === 0);
check('reset stops running', director.isRunning() === false);

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED ✔  (IntroDirector + CameraRig, Spec 24 Phase 2)`);
  engine.dispose();
  process.exit(0);
} else {
  console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  - ${f}`);
  engine.dispose();
  process.exit(1);
}
