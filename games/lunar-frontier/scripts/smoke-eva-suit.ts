/**
 * Lunar Frontier — EVA suit avatar smoke harness (TASK-PLAY-049a).
 *
 * Boots `EvaSuitAvatar` headless (self-owned NullEngine + explicit
 * NullEngine injection) and verifies:
 *
 *   1. Build: avatar constructs without a DOM, 7 procedural meshes, root
 *      node + helmet SpotLight present, idempotent init.
 *   2. Physics delegation: identical inputs on the avatar and on a bare
 *      `LunarEvaSuit` produce bit-identical states (the wrapper adds no
 *      physics of its own), and forward input actually moves the suit.
 *   3. Low-G jump: rising-edge hop gives +vz, gravity bleeds it, the suit
 *      lands back on the datum, re-jump requires a fresh edge.
 *   4. Consumables: oxygen and battery deplete monotonically over time and
 *      clamp at zero (suit goes non-operational, never negative).
 *   5. Headlight: toggle toggles lamp intensity between lit and off, state
 *      query tracks it, safe pre-init/post-dispose.
 *   6. Frame sync: mesh root transform tracks physics through the shared
 *      worldToBabylon mapping (root.y == elevation, azimuth == PI/2 + h).
 *   7. Lifecycle: dispose is idempotent, post-dispose update keeps stepping
 *      physics and returns state instead of throwing.
 *
 * Run: `node --no-warnings scripts/smoke-eva-suit.ts` (exit 0 == all green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';

import {
  EvaSuitAvatar,
  HEADLIGHT_INTENSITY,
} from '../src/entities/AstronautSuit.ts';
import {
  IDLE_SUIT_INPUT,
  LunarEvaSuit,
  SUIT_JUMP_VELOCITY,
  SUIT_MAX_OXYGEN,
  SUIT_MAX_BATTERY,
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

/** Run `frames` steps of forward-walking on a bare suit (reference oracle). */
function referenceWalk(frames: number, input = { ...IDLE_SUIT_INPUT, forward: 1 }) {
  const oracle = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true });
  for (let i = 0; i < frames; i++) oracle.step(DT, input, () => 0);
  return oracle.getState();
}

// ---------------------------------------------------------------------------
// 1. Headless build
// ---------------------------------------------------------------------------
section('1. headless build (NullEngine)');

const avatar = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } });
check('no meshes before init', avatar.isBuilt() === false && avatar.getMeshes().length === 0);

avatar.init(); // no args → self-owned NullEngine fallback
check('init() builds under NullEngine', avatar.isBuilt() === true);
check('init() is idempotent', avatar.init().isBuilt() === true);
check('7 procedural meshes', avatar.getMeshes().length === 7, `got ${avatar.getMeshes().length}`);
check('all meshes named eva-*', avatar.getMeshes().every((m) => m.name.startsWith('eva-')));
check('root transform node present', avatar.getRootNode() !== null);
check('helmet spotlight present', avatar.getHeadlight() !== null);
check('lit at spawn by default', avatar.isHeadlightOn() === true);
check('scene exposed', avatar.getScene() !== null);

// ---------------------------------------------------------------------------
// 2. Physics delegation — the wrapper must not add its own physics
// ---------------------------------------------------------------------------
section('2. update() delegates to LunarEvaSuit physics');

const walkAvatar = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } }).init();
const forwardInput = { ...IDLE_SUIT_INPUT, forward: 1 };
let last = walkAvatar.getState();
for (let i = 0; i < 120; i++) last = walkAvatar.update(DT, forwardInput);

check('forward input moves the suit', last.x > 1.0, `x=${last.x.toFixed(3)}`);
check('z stays on the datum while walking', Math.abs(last.z) < 1e-9);
check('speed getter matches state', Math.abs(walkAvatar.getSpeed() - Math.hypot(last.vx, last.vy)) < 1e-12);

const oracleState = referenceWalk(120);
check(
  'bit-identical to bare LunarEvaSuit (x)',
  Object.is(last.x, oracleState.x),
  `${last.x} vs ${oracleState.x}`,
);
check('bit-identical to bare LunarEvaSuit (vy)', Object.is(last.vy, oracleState.vy));
check(
  'bit-identical oxygen depletion',
  Object.is(last.oxygen, oracleState.oxygen),
);
check('getPhysics() returns the owned suit', walkAvatar.getPhysics().getState().x === last.x);

// Babylon frame mapping: root.y tracks elevation, azimuth tracks PI/2 + h.
const root = walkAvatar.getRootNode()!;
const bpos = walkAvatar.getBabylonPosition();
check('mesh root follows worldToBabylon', Math.abs(root.position.y - bpos.y) < 1e-9 && Math.abs(root.position.z - bpos.z) < 1e-9);
check('rotation.y = PI/2 + heading', Math.abs(root.rotation.y - (Math.PI / 2 + last.heading)) < 1e-9);

// ---------------------------------------------------------------------------
// 3. Low-G jump
// ---------------------------------------------------------------------------
section('3. low-G hop');

const jumper = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } }).init();
const hop = { ...IDLE_SUIT_INPUT, jump: true };

const afterHop = jumper.update(DT, hop);
check(`hop launches at +vz (${afterHop.vz.toFixed(2)} m/s)`, afterHop.vz > 0);
check('vz consistent with SUIT_JUMP_VELOCITY minus one gravity tick',
  Math.abs(afterHop.vz - (SUIT_JUMP_VELOCITY - 1.62 * DT)) < 1e-9);
check('airborne after hop', afterHop.isGrounded === false);

// Hold the button (no new rising edge) and coast until landing.
let peak = afterHop.vz;
let state = afterHop;
let landed = false;
for (let i = 0; i < 600; i++) {
  state = jumper.update(DT, hop);
  peak = Math.max(peak, state.vz);
  if (state.isGrounded) { landed = true; break; }
}
check('gravity brings the suit back down', landed);
check('lands on the datum', Math.abs(state.z) < 1e-9, `z=${state.z}`);
check('landing zeroes descent', state.vz === 0);

// Held button must not re-launch (rising-edge only).
const afterLand = jumper.update(DT, hop);
check('held jump does not re-launch', afterLand.vz <= 0 && afterLand.isGrounded === true);

// Peak apex sanity: v² = 2 g h → apex ≈ 2.6²/(2·1.62) ≈ 2.09 m.
let apex = 0;
const arc = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } }).init();
arc.update(DT, hop);
for (let i = 0; i < 600; i++) apex = Math.max(apex, arc.update(DT, IDLE_SUIT_INPUT).z);
check(`apex matches 1/6-g ballistics (${apex.toFixed(2)} m)`, apex > 1.9 && apex < 2.3);

// ---------------------------------------------------------------------------
// 4. Consumables deplete over time
// ---------------------------------------------------------------------------
section('4. oxygen & battery depletion');

const lifer = new EvaSuitAvatar({
  initial: { x: 0, y: 0, z: 0, isGrounded: true, oxygen: SUIT_MAX_OXYGEN, battery: SUIT_MAX_BATTERY },
}).init();
const o2Start = lifer.getOxygen();
const batStart = lifer.getBattery();
let monotonic = true;
let prevO2 = o2Start;
let prevBat = batStart;
for (let i = 0; i < 600; i++) {
  const s = lifer.update(DT, forwardInput);
  if (s.oxygen > prevO2 || s.battery > prevBat) monotonic = false;
  prevO2 = s.oxygen;
  prevBat = s.battery;
}
check('oxygen depletes over 10 s EVA', lifer.getOxygen() < o2Start - 0.4, `Δ=${(o2Start - lifer.getOxygen()).toFixed(3)}`);
check('battery depletes over 10 s EVA', lifer.getBattery() < batStart - 0.3, `Δ=${(batStart - lifer.getBattery()).toFixed(3)}`);
check('depletion is monotonic', monotonic);
check('telemetry mirrors readouts', lifer.getTelemetry().oxygen === lifer.getOxygen());
check('still operational with reserves left', lifer.getTelemetry().operational === true);

// Bottom-out: seed near-empty reserves, drain, verify clamp + operational=false.
const dead = new EvaSuitAvatar({
  initial: { x: 0, y: 0, z: 0, isGrounded: true, oxygen: 0.01, battery: 0.01 },
}).init();
for (let i = 0; i < 240; i++) dead.update(DT, forwardInput);
check('oxygen clamps at 0 (never negative)', dead.getOxygen() === 0);
check('battery clamps at 0', dead.getBattery() === 0);
check('dead suit reports operational=false', dead.getTelemetry().operational === false);

// ---------------------------------------------------------------------------
// 5. Headlight toggle
// ---------------------------------------------------------------------------
section('5. headlight toggle');

const lamp = avatar.getHeadlight()!;
const onIntensity = lamp.intensity;
check('lit intensity matches HEADLIGHT_INTENSITY while alive', Math.abs(onIntensity - HEADLIGHT_INTENSITY) < 1e-9);

check('setHeadlight(false) returns false', avatar.setHeadlight(false) === false);
check('lamp intensity drops to 0', lamp.intensity === 0);
check('isHeadlightOn() false', avatar.isHeadlightOn() === false);

check('bare setHeadlight() toggles back on', avatar.setHeadlight() === true);
check('lamp intensity restored', Math.abs(lamp.intensity - HEADLIGHT_INTENSITY) < 1e-9);
check('toggle is idempotent-safe (force on twice)',
  avatar.setHeadlight(true) === true && avatar.setHeadlight(true) === true && lamp.intensity > 0);

// ---------------------------------------------------------------------------
// 6. setState / teleport
// ---------------------------------------------------------------------------
section('6. setState & teleport');

walkAvatar.setState({ x: 250, y: -80, z: 12, vx: 0, vy: 0, vz: 0, isGrounded: false });
const tp = walkAvatar.getPosition();
check('setState moves physics state', tp.x === 250 && tp.y === -80 && tp.z === 12);
check('mesh root follows teleport', Math.abs(walkAvatar.getRootNode()!.position.y - 12) < 1e-9);

walkAvatar.teleport(5, 5);
const tp2 = walkAvatar.getPosition();
check('teleport lands on sampled datum', tp2.x === 5 && tp2.y === 5 && tp2.z === 0);
check('teleport kills velocity', walkAvatar.getSpeed() === 0);

// ---------------------------------------------------------------------------
// 7. Lifecycle & post-dispose behaviour
// ---------------------------------------------------------------------------
section('7. dispose lifecycle');

check('dispose() returns cleanly', (() => { avatar.dispose(); return true; })());
check('dispose is idempotent', (() => { avatar.dispose(); avatar.dispose(); return true; })());
check('isBuilt() false after dispose', avatar.isBuilt() === false);
check('mesh list empty after dispose', avatar.getMeshes().length === 0);
check('root null after dispose', avatar.getRootNode() === null);
check('headlight query safe after dispose', typeof avatar.isHeadlightOn() === 'boolean');
check('setHeadlight safe after dispose', typeof avatar.setHeadlight(true) === 'boolean');

const postState = avatar.update(DT, forwardInput); // must NOT throw
check('post-dispose update returns finite state', Number.isFinite(postState.x) && Number.isFinite(postState.y));

// Injected-engine path: caller-owned NullEngine must survive avatar disposal.
const sharedEngine = new NullEngine({ renderWidth: 640, renderHeight: 360 });
const injected = new EvaSuitAvatar({ initial: { x: 1, y: 2, z: 0, isGrounded: true } }).init(sharedEngine);
check('injected engine builds', injected.isBuilt() === true && injected.getScene() !== null);
injected.update(DT, forwardInput);
injected.dispose();
check('caller-owned engine survives avatar dispose', sharedEngine.isDisposed === false);
sharedEngine.dispose();

for (const a of [walkAvatar, jumper, arc, lifer, dead]) a.dispose();

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED ✔  (EVA suit avatar, TASK-PLAY-049a)`);
  process.exit(0);
} else {
  console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
