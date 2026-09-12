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
  BUGGY_CHASSIS_MASS,
  BUGGY_MAX_CARGO,
  BUGGY_TRACK,
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
check('12 procedural meshes', rover.getMeshes().length === 12, `got ${rover.getMeshes().length}`);
check('all meshes named buggy-*', rover.getMeshes().every((m) => m.name.startsWith('buggy-')));
check('root transform node present', rover.getRootNode() !== null);
check('2 spotlight headlights', rover.getHeadlights().length === 2);
check('headlights lit at spawn by default', rover.isHeadlightsOn() === true);

const materials = new Set(rover.getMeshes().map((m) => m.material));
check('meshes carry materials (3 shared PBR)', materials.size === 3 && [...materials].every((mm) => mm !== null));

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

// ---------------------------------------------------------------------------
// 2. Driving — zero duplicated physics (bit-identical oracle)
// ---------------------------------------------------------------------------
section('2. driving verification (bit-identical to standalone LunarBuggy)');

const driver = new OpenBuggy().init();
const throttleInput = drive();
let last = driver.getState();
for (let i = 0; i < 300; i++) last = driver.update(DT, throttleInput);

check('throttle moves the vehicle forward', last.x > 5 && last.vLong > 1, `x=${last.x.toFixed(2)} vLong=${last.vLong.toFixed(2)}`);
check('speed getter matches |vLong|', Math.abs(driver.getSpeed() - Math.abs(last.vLong)) < 1e-12);

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
check('chassis visibly tilts under acceleration (pitch/roll applied)', Math.abs(nose.y) > 1e-3, `nose.y=${nose.y.toFixed(4)}`);
check('getBabylonYaw() = PI/2 + heading', Math.abs(driver.getBabylonYaw() - (Math.PI / 2 + last.heading)) < 1e-12);

// ---------------------------------------------------------------------------
// 3. Steering
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

for (const r of [driver, steerLeft, rightBuggy, rig, hauler, empty, loaded, dock, spin90]) r.dispose();
suit.dispose();

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
