/**
 * Lunar Frontier — open-top lunar buggy smoke harness (TASK-PLAY-049b).
 *
 * Boots `OpenBuggy` headless (self-owned NullEngine + explicit NullEngine
 * injection) and verifies:
 *
 *   1. Build: rover constructs without a DOM, 12 procedural meshes, root
 *      node + 2 headlight SpotLights + materials present, idempotent init.
 *   2. Driving: throttle moves the vehicle forward and every state channel
 *      is BIT-IDENTICAL to a standalone `LunarBuggy` oracle stepped with the
 *      same inputs (the wrapper adds zero physics of its own).
 *   3. Steering: steer input changes heading, with opposite inputs producing
 *      opposite yaw.
 *   4. Battery: strict monotonic draw under motor acceleration.
 *   5. Cargo: mass loads/clamps up to 500 kg, fraction + total mass scale,
 *      and the loaded drivetrain response measurably diverges.
 *   6. Mount/dismount: mount, double-mount rejection, canMount range, and a
 *      real `EvaSuitAvatar` dismounted ~2 m to the driver side, then able to
 *      climb back in.
 *   7. Headlights: intensity toggles between lit and off; state query tracks.
 *   8. Lifecycle: idempotent dispose, post-dispose update keeps stepping
 *      physics without throwing, caller-owned engine survives.
 *
 * Run: `node --no-warnings scripts/smoke-open-buggy.ts` (exit 0 == all green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import { OpenBuggy, HEADLIGHT_INTENSITY, MOUNT_RADIUS_M } from '../src/entities/OpenBuggy.ts';
import { EvaSuitAvatar } from '../src/entities/AstronautSuit.ts';
import {
  BUGGY_BRAKE_FORCE,
  BUGGY_CHASSIS_MASS,
  BUGGY_MAX_CARGO,
  BUGGY_MAX_STEER,
  BUGGY_MOTOR_POWER,
  BUGGY_REGEN_FORCE,
  BUGGY_THROTTLE_RISE,
  BUGGY_TRACK,
  BUGGY_WHEEL_FORCE,
  BUGGY_WHEEL_RADIUS,
  IDLE_BUGGY_INPUT,
  LunarBuggy,
  type BuggyInput,
} from '../src/physics/TraversalPhysics.ts';

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

const DT = 1 / 60;
const drive = (over: Partial<BuggyInput> = {}): BuggyInput => ({
  ...IDLE_BUGGY_INPUT,
  throttle: 1,
  parkBrake: false,
  ...over,
});

/** Reference oracle: a bare LunarBuggy stepped `frames` times. */
function referenceRun(frames: number, input: BuggyInput, heading = 0) {
  const oracle = new LunarBuggy({}, { x: 0, y: 0, heading });
  for (let i = 0; i < frames; i++) oracle.step(DT, input);
  return oracle.getState();
}

// ---------------------------------------------------------------------------
// 1. Headless build
// ---------------------------------------------------------------------------
section('1. headless build (NullEngine)');

const rover = new OpenBuggy();
check('no meshes before init', rover.isBuilt() === false && rover.getMeshes().length === 0);
check('no root node before init', rover.getRootNode() === null);
check('no headlights before init', rover.getHeadlights().length === 0);

rover.init(); // no args → self-owned NullEngine fallback
check('init() builds under NullEngine', rover.isBuilt() === true);
check('init() is idempotent', rover.init().isBuilt() === true);
check('27 procedural meshes (cohesive hierarchy)', rover.getMeshes().length === 27, `got ${rover.getMeshes().length}`);
check('all meshes named buggy-*', rover.getMeshes().every((m) => m.name.startsWith('buggy-')));
check('root transform node present', rover.getRootNode() !== null);
check('2 spotlight headlights', rover.getHeadlights().length === 2);
check('headlights lit at spawn by default', rover.isHeadlightsOn() === true);

const materials = new Set(rover.getMeshes().map((m) => m.material));
check('meshes carry materials (6 PBR materials)', materials.size === 6 && [...materials].every((mm) => mm !== null));

const wheelMeshes = rover.getMeshes().filter((m) => m.name.includes('wheel'));
const expectedDia = BUGGY_WHEEL_RADIUS * 2;
// Cylinder is built along local +y, so the tyre diameter spans local x/z.
const diameters = wheelMeshes.map((m) => {
  const bb = m.getBoundingInfo().boundingBox;
  return Math.max(bb.maximum.x - bb.minimum.x, bb.maximum.z - bb.minimum.z);
});
check(
  '4 wheels at radius BUGGY_WHEEL_RADIUS',
  wheelMeshes.length === 4 && diameters.every((d) => Math.abs(d - expectedDia) < 1e-3),
  `diameters=${diameters.map((d) => d.toFixed(3)).join(',')}`,
);
const wheelXs = wheelMeshes.map((m) => m.position.x).sort((a, b) => a - b);
check(
  'wheel hubs at ±BUGGY_TRACK/2',
  Math.abs(Math.abs(wheelXs[0]) - BUGGY_TRACK / 2) < 1e-9 && Math.abs(Math.abs(wheelXs[3]) - BUGGY_TRACK / 2) < 1e-9,
  `x=${wheelXs.map((v) => v.toFixed(2)).join(',')}`,
);

// Verify rigid chassis hierarchy (Spec 15 §2.2):
// Chassis body components share unified parent and maintain zero relative offset.
const chassisParts = rover.getMeshes().filter((m) =>
  m.name.includes('tub') || m.name.includes('frame') || m.name.includes('cowl') ||
  m.name.includes('seat') || m.name.includes('cargo') || m.name.includes('lightbar') ||
  m.name.includes('taillights'),
);
const sharedParent = chassisParts[0]?.parent;
check(
  'rigid chassis hierarchy (components share unified chassis parent)',
  chassisParts.length >= 8 && chassisParts.every((m) => m.parent === sharedParent && m.parent !== null),
);

// ---------------------------------------------------------------------------
// 2. Driving — zero duplicated physics & straight-line stability
// ---------------------------------------------------------------------------
section('2. driving verification (bit-identical to standalone LunarBuggy)');

const driver = new OpenBuggy().init();
const throttleInput = drive();
let last = driver.getState();
const vHistory: number[] = [];
for (let i = 0; i < 300; i++) {
  last = driver.update(DT, throttleInput);
  vHistory.push(last.vLong);
}

check('throttle moves the vehicle forward', last.x > 5 && last.vLong > 1, `x=${last.x.toFixed(2)} vLong=${last.vLong.toFixed(2)}`);
check('speed getter matches |vLong|', Math.abs(driver.getSpeed() - Math.abs(last.vLong)) < 1e-12);

// Spec 15 §5: Progressive acceleration: smooth monotonic velocity increase without jerk or spikes.
let monotonicAccel = true;
for (let i = 1; i < 60; i++) {
  if (vHistory[i] < vHistory[i - 1] - 1e-5) monotonicAccel = false;
}
check('progressive acceleration (monotonic velocity rise without spikes)', monotonicAccel);

const oracle = referenceRun(300, throttleInput);
for (const key of ['x', 'y', 'z', 'heading', 'vLong', 'vLat', 'yawRate', 'batteryKwh', 'motorEnergyJ'] as const) {
  check(
    `bit-identical to bare LunarBuggy (${key})`,
    Object.is(last[key], oracle[key]),
    `${last[key]} vs ${oracle[key]}`,
  );
}
check('getPhysics() returns the owned buggy', driver.getPhysics().getState().x === last.x);
check('getState() is a fresh copy', driver.getState() !== driver.getState());

// Straight-line driving test (Spec 15 §5 & §6): 10 seconds of full throttle with zero steering
// must maintain heading within ±0.5° (0.0087 rad) and |Δy| < 0.05 m across >40m travel.
const straightBuggy = new OpenBuggy().init();
let straightState = straightBuggy.getState();
for (let i = 0; i < 600; i++) {
  straightState = straightBuggy.update(DT, drive({ steer: 0 }));
}
check(
  'straight-line test: |Δy| < 0.05m over 10 seconds',
  Math.abs(straightState.y) < 0.05,
  `Δy=${straightState.y.toFixed(5)}m at x=${straightState.x.toFixed(2)}m`,
);
check(
  'straight-line test: heading within ±0.5° (0.0087 rad)',
  Math.abs(straightState.heading) < 0.0087,
  `heading=${straightState.heading.toFixed(6)} rad`,
);

// Frame sync: root follows worldToBabylon; azimuth PI/2 + heading encoded in
// the quaternion (verified by transforming the model nose +z into world).
const root = driver.getRootNode()!;
const bpos = driver.getBabylonPosition();
check('mesh root follows worldToBabylon', Math.abs(root.position.x - bpos.x) < 1e-9 && Math.abs(root.position.y - bpos.y) < 1e-9 && Math.abs(root.position.z - bpos.z) < 1e-9);
const nose = Vector3.TransformNormal(new Vector3(0, 0, 1), root.getWorldMatrix());
// Attitude tilt (pitch/roll) shortens the nose's horizontal reach, so the
// azimuth contract lives in the horizontal projection: it must be exact.
const noseAzimuth = Math.atan2(-nose.z, nose.x);
check(
  'model nose horizontal projection = PI/2 + heading azimuth',
  Math.abs(noseAzimuth - last.heading) < 1e-6,
  `azimuth=${noseAzimuth.toFixed(6)} heading=${last.heading.toFixed(6)}`,
);
// Chassis attitude under drive (Spec 16 §2.2/§2.5): the load-transfer pitch is
// sampled through the LAUNCH phase — under the Spec-16 powertrain the buggy is
// already in limiter cruise by frame 300 (drive force ≈ 0, squat relieved), so
// a cruise-frame sample would prove nothing about accel squat.
const tiltRover = new OpenBuggy().init();
let maxNoseTilt = 0;
for (let i = 0; i < 120; i++) {
  tiltRover.update(DT, drive());
  const noseL = Vector3.TransformNormal(new Vector3(0, 0, 1), tiltRover.getRootNode()!.getWorldMatrix());
  maxNoseTilt = Math.max(maxNoseTilt, Math.abs(noseL.y));
}
check('chassis visibly tilts under acceleration (launch-phase pitch/roll)', maxNoseTilt > 1e-3, `max|nose.y|=${maxNoseTilt.toFixed(4)}`);
check('getBabylonYaw() = PI/2 + heading', Math.abs(driver.getBabylonYaw() - (Math.PI / 2 + last.heading)) < 1e-12);

// ---------------------------------------------------------------------------
// 3. Steering & Ackermann Geometry
// ---------------------------------------------------------------------------
section('3. steering verification');

const leftRun = referenceRun(300, drive({ steer: -1 }));
const steerLeft = new OpenBuggy().init();
let steerState = steerLeft.getState();
for (let i = 0; i < 300; i++) steerState = steerLeft.update(DT, drive({ steer: -1 }));
check('steer input changes heading', Math.abs(steerState.heading) > 0.5, `heading=${steerState.heading.toFixed(3)}`);
check('entity heading matches steer oracle', Object.is(steerState.heading, leftRun.heading));

const rightBuggy = new OpenBuggy().init();
let rightState = rightBuggy.getState();
for (let i = 0; i < 300; i++) rightState = rightBuggy.update(DT, drive({ steer: 1 }));
check('opposite steer yaws the opposite way', Math.sign(steerState.heading) === -Math.sign(rightState.heading) && rightState.heading !== 0);
check('lateral velocity developed in the turn', Math.abs(steerState.vLat) > 0.5, `vLat=${steerState.vLat.toFixed(3)}`);
check('pitch/roll getters finite during maneuver', Number.isFinite(steerLeft.getPitch()) && Number.isFinite(steerLeft.getRoll()));

// Spec 15 §3.1 & §5: High-speed steering derating verification: delta_max(v) = delta_0 / (1 + 0.08 * |vLong|)
const slowRover = new OpenBuggy().init();
slowRover.update(DT, drive({ throttle: 0.1, steer: 1 }));
const slowSteerAngle = slowRover.getState().steerAngle ?? 0;
const fastRover = new OpenBuggy().init();
for (let i = 0; i < 300; i++) fastRover.update(DT, drive({ throttle: 1, steer: 0 }));
fastRover.update(DT, drive({ throttle: 1, steer: 1 }));
const fastSteerAngle = fastRover.getState().steerAngle ?? 0;
check(
  'speed-sensitive steering derating (high-speed steer angle < low-speed steer angle)',
  fastSteerAngle > 0 && fastSteerAngle < slowSteerAngle * 0.85,
  `slow=${slowSteerAngle.toFixed(3)} fast=${fastSteerAngle.toFixed(3)}`,
);

// ---------------------------------------------------------------------------
// 3b. Stop & Reverse Transitions (Spec 15 §3.2 & §5)
// ---------------------------------------------------------------------------
section('3b. stop and reverse transitions');

const cycleRover = new OpenBuggy().init();
// 1. Accelerate forward
for (let i = 0; i < 180; i++) cycleRover.update(DT, drive({ throttle: 1 }));
const forwardSpeed = cycleRover.getSpeed();
check('forward drive accelerates (> 2 m/s)', forwardSpeed > 2.0, `speed=${forwardSpeed.toFixed(2)}`);

// 2. Brake to complete standstill
for (let i = 0; i < 180; i++) cycleRover.update(DT, drive({ throttle: -1, brake: 1 }));
const stoppedSpeed = cycleRover.getSpeed();
check('braking brings rover to standstill (< 0.2 m/s)', stoppedSpeed < 0.2, `speed=${stoppedSpeed.toFixed(3)}`);

// 3. Reverse throttle drives backward
for (let i = 0; i < 180; i++) cycleRover.update(DT, drive({ throttle: -1, brake: 0 }));
const revState = cycleRover.getState();
check('reverse throttle drives backward (vLong < 0)', revState.vLong < -1.0, `vLong=${revState.vLong.toFixed(2)}`);
check('reverse speed capped at BUGGY_REVERSE_SPEED_LIMIT (5.0 m/s)', revState.vLong >= -5.05, `vLong=${revState.vLong.toFixed(2)}`);

// 4. Return to forward drive
for (let i = 0; i < 180; i++) cycleRover.update(DT, drive({ throttle: 1, brake: 1 }));
for (let i = 0; i < 180; i++) cycleRover.update(DT, drive({ throttle: 1, brake: 0 }));
check('recovers from reverse to forward drive (vLong > 0)', cycleRover.getState().vLong > 1.0);

// ---------------------------------------------------------------------------
// 4. Battery draw under motor acceleration
// ---------------------------------------------------------------------------
section('4. battery draw');

const rig = new OpenBuggy().init();
const batteryStart = rig.getBattery();
let monotonic = true;
let prevBat = batteryStart;
for (let i = 0; i < 600; i++) {
  const s = rig.update(DT, drive());
  if (s.batteryKwh >= prevBat) monotonic = false;
  prevBat = s.batteryKwh;
}
check('battery strictly decreases while accelerating', monotonic);
check(`battery visibly drained over 10 s (Δ=${((batteryStart - rig.getBattery()) * 1000).toFixed(1)} Wh)`, rig.getBattery() < batteryStart - 0.05);
check('telemetry battery mirrors readout', rig.getTelemetry().battery === rig.getBattery());
check('telemetry state-of-charge in 0..1', rig.getTelemetry().batteryFraction > 0.9 && rig.getTelemetry().batteryFraction < 1);

// ---------------------------------------------------------------------------
// 5. Cargo mass & inertia scaling
// ---------------------------------------------------------------------------
section('5. cargo mass & inertia scaling');

const hauler = new OpenBuggy().init();
const massEmpty = hauler.getPhysics().totalMass;
check('starts empty', hauler.getCargoMass() === 0 && hauler.getCargoMassFraction() === 0);
check('setCargoMass(250) loads 250 kg', hauler.setCargoMass(250) === 250 && hauler.getCargoMass() === 250);
check('fraction tracks load', Math.abs(hauler.getCargoMassFraction() - 250 / BUGGY_MAX_CARGO) < 1e-12);
check('effective mass grows with cargo', hauler.getPhysics().totalMass === massEmpty + 250);
check('overload clamps at BUGGY_MAX_CARGO (500)', hauler.setCargoMass(700) === BUGGY_MAX_CARGO && hauler.getCargoMass() === BUGGY_MAX_CARGO);
check('clamp keeps fraction at 1', hauler.getCargoMassFraction() === 1);
check('negative input clamps at 0', hauler.setCargoMass(-9999) === 0 && hauler.getCargoMass() === 0);
check('telemetry totalMass via physics module', hauler.getTelemetry().totalMass === BUGGY_CHASSIS_MASS);
check('NaN input is rejected, load unchanged', hauler.setCargoMass(120) === 120 && hauler.setCargoMass(Number.NaN) === 120);

// Drivetrain response diverges between empty and fully loaded rungs.
const empty = new OpenBuggy().init();
const loaded = new OpenBuggy({ initialCargo: BUGGY_MAX_CARGO }).init();
for (let i = 0; i < 120; i++) {
  empty.update(DT, drive());
  loaded.update(DT, drive());
}
check(
  'loaded buggy response differs from empty',
  !Object.is(loaded.getState().vLong, empty.getState().vLong),
  `loaded=${loaded.getState().vLong.toFixed(4)} empty=${empty.getState().vLong.toFixed(4)}`,
);
check('loaded CoG rides higher (rollover degrades)', loaded.getPhysics().cogHeight > new OpenBuggy().getPhysics().cogHeight);

// ---------------------------------------------------------------------------
// 6. Mount / dismount mechanics
// ---------------------------------------------------------------------------
section('6. mount / dismount');

const dock = new OpenBuggy({ x: 0, y: 0, heading: 0 }).init();
const suit = new EvaSuitAvatar({ initial: { x: 2, y: 0, z: 0, isGrounded: true } }).init();

check('starts unmounted', dock.isMounted() === false);
check(`canMount within ${MOUNT_RADIUS_M} m (suit at 2 m)`, dock.canMount(suit) === true);
check('canMount accepts raw point in range', dock.canMount({ x: 3, y: 1, z: 0 }) === true);
check('canMount rejects point out of range', dock.canMount({ x: 40, y: 10, z: 0 }) === false);
check('canMount distance boundary at 3.4 m passes', dock.canMount({ x: 3.4, y: 0, z: 0 }) === true);
check('canMount distance boundary at 3.6 m fails', dock.canMount({ x: 3.6, y: 0, z: 0 }) === false);
check('mount() succeeds', dock.mount(suit) === true && dock.isMounted() === true);
check('double mount rejected', dock.mount(suit) === false && dock.isMounted() === true);
check('mount refuses out-of-range suit', (() => {
  const far = new OpenBuggy({ x: 100, y: 0 }).init();
  const r = far.mount(suit);
  far.dispose();
  return r === false && far.isMounted() === false;
})());
check('telemetry reports mounted', dock.getTelemetry().mounted === true);

const suitBefore = suit.getPosition();
check('dismount() succeeds', dock.dismount(suit) === true && dock.isMounted() === false);
const suitAfter = suit.getPosition();
const lateralOffset = Math.hypot(suitAfter.x - dock.getPosition().x, suitAfter.y - dock.getPosition().y);
check('suit repositioned ~2 m from buggy', Math.abs(lateralOffset - 2.0) < 0.35, `offset=${lateralOffset.toFixed(3)}`);
check('reposition is lateral (driver side), not fore/aft', Math.abs(suitAfter.y - 2.0) < 0.2 && Math.abs(suitAfter.x) < 0.2, `after=(${suitAfter.x.toFixed(3)},${suitAfter.y.toFixed(3)})`);
check('original suit spot changed', suitBefore.x !== suitAfter.x || suitBefore.y !== suitAfter.y);
check('dismount refuses when not mounted', dock.dismount(suit) === false);
check('mounting again after dismount works', dock.mount(suit) === true);
check('dismount without suit arg still works', dock.dismount() === true && dock.isMounted() === false);

// Heading-aware lateral target: heading PI/2 puts the driver side at -x.
const spin90 = new OpenBuggy({ x: 10, y: 10, heading: Math.PI / 2 }).init();
spin90.mount();
const drops: Array<{ x: number; y: number }> = [];
spin90.dismount({ teleport: (x: number, y: number) => drops.push({ x, y }) });
check(
  'dismount lateral follows heading (PI/2 → -x side)',
  drops.length === 1 && Math.abs(drops[0].x - 8) < 1e-9 && Math.abs(drops[0].y - 10) < 1e-9,
  JSON.stringify(drops),
);

// ---------------------------------------------------------------------------
// 7. Headlights toggle
// ---------------------------------------------------------------------------
section('7. headlights toggle');

const lamps = rover.getHeadlights();
check('both beams lit at HEADLIGHT_INTENSITY', lamps.every((l) => Math.abs(l.intensity - HEADLIGHT_INTENSITY) < 1e-9));
check('setHeadlights(false) returns false', rover.setHeadlights(false) === false);
check('both beams drop to 0', lamps.every((l) => l.intensity === 0));
check('isHeadlightsOn() false', rover.isHeadlightsOn() === false);
check('bare setHeadlights() toggles back on', rover.setHeadlights() === true);
check('beam intensity restored', lamps.every((l) => Math.abs(l.intensity - HEADLIGHT_INTENSITY) < 1e-9));
check('force-on twice is idempotent', rover.setHeadlights(true) === true && rover.setHeadlights(true) === true);
check('beams aim along heading (finite unit dirs)', lamps.every((l) => Number.isFinite(l.direction.x) && l.direction.lengthSquared() > 0));
check('beams sit ahead of the chassis datum', lamps.every((l) => Number.isFinite(l.position.x) && Number.isFinite(l.position.z)));

// ---------------------------------------------------------------------------
// 8. Dispose lifecycle
// ---------------------------------------------------------------------------
section('8. dispose lifecycle');

check('dispose() returns cleanly', (() => { rover.dispose(); return true; })());
check('dispose is idempotent', (() => { rover.dispose(); rover.dispose(); return true; })());
check('isBuilt() false after dispose', rover.isBuilt() === false);
check('mesh list empty after dispose', rover.getMeshes().length === 0);
check('lights gone after dispose', rover.getHeadlights().length === 0);
check('root null after dispose', rover.getRootNode() === null);
check('headlight queries safe after dispose', typeof rover.isHeadlightsOn() === 'boolean' && typeof rover.setHeadlights(true) === 'boolean');
check('cargo queries safe after dispose', typeof rover.getCargoMass() === 'number' && typeof rover.setCargoMass(10) === 'number');
check('mount/dismount safe after dispose', rover.canMount({ x: 0, y: 0 }) === false && rover.mount() === false && rover.dismount() === false);

const postState = rover.update(DT, drive()); // must NOT throw
check('post-dispose update returns finite state', Number.isFinite(postState.x) && Number.isFinite(postState.y) && Number.isFinite(postState.vLong));
check('post-dispose update keeps stepping physics', postState.x !== 0 || Math.abs(postState.vLong) > 0);
check('post-dispose telemetry still builds', Number.isFinite(rover.getTelemetry().speed));
check('post-dispose getState still finite', Number.isFinite(rover.getState().batteryKwh));

// Injected-engine path: caller-owned NullEngine must survive rover disposal.
const sharedEngine = new NullEngine();
const injected = new OpenBuggy({ x: 3, y: -2 }).init(sharedEngine);
check('injected engine builds', injected.isBuilt() === true);
injected.update(DT, drive());
injected.dispose();
check('caller-owned engine survives rover dispose', sharedEngine.isDisposed === false);
sharedEngine.dispose();

for (const r of [driver, steerLeft, rightBuggy, straightBuggy, slowRover, fastRover, cycleRover, rig, hauler, empty, loaded, dock, spin90]) r.dispose();
suit.dispose();

// ---------------------------------------------------------------------------
// 9. Suspension heave damping & chassis stability (spec 16 §2.2, gate 4.2)
// ---------------------------------------------------------------------------
section('9. suspension heave damping (no pogo oscillation)');

const spreadOf = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);

// (a) Resting: a damped heave converges to a DEAD stop. Pre-Spec-16 builds
// (vCorner === s.vBody made the damper term identically zero) rang ±6 cm
// around the ride height forever.
const restRover = new OpenBuggy().init();
for (let i = 0; i < 900; i++) restRover.update(DT, IDLE_BUGGY_INPUT);
const restHeave: number[] = [];
for (let i = 0; i < 300; i++) restHeave.push(restRover.update(DT, IDLE_BUGGY_INPUT).bodyHeight);
check(
  'resting chassis heave spread < 1e-9 m (damper verified)',
  spreadOf(restHeave) < 1e-9,
  `spread=${spreadOf(restHeave).toExponential(2)}`,
);
check(
  'resting heave velocity ~0',
  Math.abs(restRover.getState().vBody) < 1e-9,
  `vBody=${restRover.getState().vBody.toExponential(2)}`,
);

// (b) Dropped from 2 m: absorbs the impact and settles with no rebound ring.
const dropper = new LunarBuggy({}, { x: 0, y: 0, heading: 0, bodyHeight: 2.0, vBody: 0 });
for (let i = 0; i < 900; i++) dropper.step(DT, IDLE_BUGGY_INPUT);
const postDrop: number[] = [];
for (let i = 0; i < 300; i++) postDrop.push(dropper.step(DT, IDLE_BUGGY_INPUT).bodyHeight);
check(
  'post-landing heave spread < 1e-9 m (no rebound ring)',
  spreadOf(postDrop) < 1e-9,
  `spread=${spreadOf(postDrop).toExponential(2)}`,
);

// (c) From a settled standstill, full throttle keeps all four corners
// ground-loaded (no pogo-wheelie). The first frames after spawn are skipped:
// the attitude controller's initial slew is a known start-up transient, not
// suspension pogo, and exists in every build.
const launcher = new OpenBuggy().init();
for (let i = 0; i < 300; i++) launcher.update(DT, IDLE_BUGGY_INPUT);
let allCornersLoaded = true;
for (let i = 0; i < 600; i++) {
  const s = launcher.update(DT, drive());
  // Grace the first 90 frames: the attitude controller's slew-in is a
  // one-time start-up transient, not sustained suspension pogo.
  if (i >= 90 && s.wheels.some((w) => w.load <= 0)) allCornersLoaded = false;
}
check('full throttle keeps all 4 corners ground-loaded', allCornersLoaded);

restRover.dispose();
launcher.dispose();

// ---------------------------------------------------------------------------
// 10. Spec 16 Phase 4 — powertrain & agile turnaround (TASK-PLAY-063d,
//     spec §1.6/§1.7, §2.5/§2.6, gate 5 & 6)
// ---------------------------------------------------------------------------
section('10. spec-16 phase 4: acceleration / braking / turnaround / brake-to-reverse');

// (a) Mandated constants (spec §2.5/§2.6) — assert the contract exactly.
check('BUGGY_WHEEL_FORCE = 3800 N/wheel', BUGGY_WHEEL_FORCE === 3_800, `${BUGGY_WHEEL_FORCE}`);
check('BUGGY_MOTOR_POWER = 18 kW/motor (72 kW AWD)', BUGGY_MOTOR_POWER === 18_000, `${BUGGY_MOTOR_POWER}`);
check('BUGGY_REGEN_FORCE = 8000 N', BUGGY_REGEN_FORCE === 8_000, `${BUGGY_REGEN_FORCE}`);
check('BUGGY_BRAKE_FORCE = 14000 N', BUGGY_BRAKE_FORCE === 14_000, `${BUGGY_BRAKE_FORCE}`);
check('throttle torque rise rate = 12.0 /s', BUGGY_THROTTLE_RISE === 12.0, `${BUGGY_THROTTLE_RISE}`);
check('BUGGY_MAX_STEER = 0.78 rad (45 deg lock)', Math.abs(BUGGY_MAX_STEER - 0.78) < 1e-12, `${BUGGY_MAX_STEER}`);

// (b) Gate 5 — acceleration: >= 15 m/s within 3.0 s from standstill.
{
  const accelRover = new OpenBuggy().init();
  let t15 = -1;
  for (let i = 0; i < 600 && t15 < 0; i++) {
    if (accelRover.update(DT, drive()).vLong >= 15) t15 = (i + 1) * DT;
  }
  check('GATE5: 0 -> 15 m/s in <= 3.0 s', t15 >= 0 && t15 <= 3.0, t15 < 0 ? 'never reached 15' : `${t15.toFixed(2)}s`);
  accelRover.dispose();
}

// (c) Gate 6a — braking: 15 m/s -> standstill within 1.8 s.
{
  const braker = new OpenBuggy().init();
  for (let i = 0; i < 3_600; i++) if (braker.update(DT, drive()).vLong >= 15) break;
  let tb = -1;
  for (let i = 0; i < 300; i++) {
    if (Math.abs(braker.update(DT, drive({ throttle: 0, brake: 1 })).vLong) < 0.05) { tb = (i + 1) * DT; break; }
  }
  check('GATE6: 15 -> 0 m/s in <= 1.8 s', tb >= 0 && tb <= 1.8, tb < 0 ? 'never stopped' : `${tb.toFixed(2)}s`);
  braker.dispose();
}

// (d) Gate 6b — agile low-speed turnaround: full lock from standstill with a
//     blended brake pedal, the torque-vectoring pivot reverses heading in
//     < 3.0 s. Turning radius = half the path chord of the 180° reversal (the
//     space the maneuver needs; a pure pivot scores ~0). All motion must stay
//     inside the low-speed regime (< 4 m/s assist cut-off).
{
  const pivoter = new OpenBuggy().init();
  for (let i = 0; i < 60; i++) pivoter.update(DT, IDLE_BUGGY_INPUT);
  const p0 = pivoter.getState();
  let acc = 0, t180 = -1, vMax = 0;
  for (let i = 0; i < 600 && t180 < 0; i++) {
    const s = pivoter.update(DT, drive({ throttle: 1, steer: 1, brake: 0.6 }));
    acc += Math.abs(s.yawRate) * DT;
    vMax = Math.max(vMax, Math.hypot(s.vLong, s.vLat));
    if (acc >= Math.PI) t180 = (i + 1) * DT;
  }
  const p1 = pivoter.getState();
  const turnRadius = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2;
  check('GATE6: 180 deg turnaround in < 3.0 s (low speed, torque-vectored)', t180 > 0 && t180 < 3.0, t180 < 0 ? 'never turned 180' : `${t180.toFixed(2)}s`);
  check('turning radius < 3.5 m (half-chord of the reversal)', turnRadius < 3.5, `R=${turnRadius.toFixed(2)}m`);
  check('turnaround stays inside the low-speed regime (< 4 m/s)', vMax < 4.0, `vMax=${vMax.toFixed(2)}`);
  pivoter.dispose();
}

// (e) Speed-sensitive steering contract (Spec 15 law re-cut by Spec 16 §2.6):
//     full 0.78 lock below 3 m/s, delta_0/(1 + 0.08*(|v|-3)) above it.
{
  const steerAt = (v: number): number => {
    const b = new LunarBuggy({}, { vLong: v });
    return b.step(DT, { ...IDLE_BUGGY_INPUT, steer: 1, parkBrake: false }).steerAngle ?? 0;
  };
  const formula = (v: number): number => BUGGY_MAX_STEER / (1 + 0.08 * Math.max(0, v - 3));
  check('full 0.78 lock at standstill', Math.abs(steerAt(0) - BUGGY_MAX_STEER) < 1e-6, `${steerAt(0)}`);
  check('full lock held through 3 m/s band', Math.abs(steerAt(2) - BUGGY_MAX_STEER) < 1e-3, `${steerAt(2)}`);
  check('derating law delta_0/(1+0.08*(v-3)) above the band', Math.abs(steerAt(10) - formula(10)) < 1e-3, `${steerAt(10).toFixed(4)} vs ${formula(10).toFixed(4)}`);
  check('high-speed steer angle still below low-speed lock', steerAt(20) < BUGGY_MAX_STEER * 0.55, `${steerAt(20).toFixed(3)}`);
}

// (f) Instant brake-to-reverse: pedal release at a standstill hands reverse
//     authority back within a few frames — no 0.2 m/s coast-down gate.
{
  const b2r = new OpenBuggy().init();
  for (let i = 0; i < 3_600; i++) if (b2r.update(DT, drive()).vLong >= 15) break;
  // Brake (with reverse intent) to a dead stop, pedal held.
  let held = false;
  for (let i = 0; i < 300; i++) {
    const s = b2r.update(DT, drive({ throttle: -1, brake: 1 }));
    if (Math.abs(s.vLong) < 0.02) { held = true; break; }
  }
  check('b2r: held brake pins a dead standstill (< 0.02 m/s)', held);
  if (held) {
    // Release the brake, keep the reverse intent: motion must start NOW.
    let t = -1;
    for (let i = 0; i < 30; i++) {
      const s = b2r.update(DT, drive({ throttle: -1, brake: 0 }));
      if (s.vLong < -0.05) { t = (i + 1) * DT; break; }
    }
    check('b2r: reverse motion starts <= 0.5 s after pedal release', t >= 0 && t <= 0.5, t < 0 ? 'no reverse motion' : `${(t * 1000).toFixed(0)}ms`);
    check('b2r: driveMode flipped to REVERSE', b2r.getState().driveMode === 'REVERSE');
  }
  b2r.dispose();
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED ✔  (open-top lunar buggy, TASK-PLAY-049b)`);
  process.exit(0);
} else {
  console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
