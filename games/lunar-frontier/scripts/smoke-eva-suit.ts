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
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

import {
  ARM_SWING_SCALE,
  EvaSuitAvatar,
  GEO,
  HEADLIGHT_INTENSITY,
  HEADLIGHT_ANGLE_DEG,
  HEADLIGHT_RANGE_M,
} from '../src/entities/AstronautSuit.ts';
import {
  IDLE_SUIT_INPUT,
  LunarEvaSuit,
  SUIT_BOUND_LAUNCH_VZ,
  SUIT_BOUND_MIN_SPEED,
  SUIT_BOUND_RESTITUTION,
  SUIT_BOUND_SPEED,
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
function referenceWalk(frames: number, input = { ...IDLE_SUIT_INPUT, forward: 0.55 }) {
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
// Spec 28 Phase 3 re-cut: the retro-modern slimmer suit (torso + chest plate
// + waist band, helmet + visor, twin-tank PLSS panel/cowl/nozzles, telemetry
// pad, 2×4 arm meshes, 2×4 leg meshes) replaces the old 7-mesh blocky build.
check('28 procedural meshes (Spec 28 §2.2 build)', avatar.getMeshes().length === 28, `got ${avatar.getMeshes().length}`);
check('all meshes named eva-*', avatar.getMeshes().every((m) => m.name.startsWith('eva-')));
check('root transform node present', avatar.getRootNode() !== null);
check('helmet spotlight present', avatar.getHeadlight() !== null);
check('lit at spawn by default', avatar.isHeadlightOn() === true);
check('scene exposed', avatar.getScene() !== null);

// ---------------------------------------------------------------------------
// 1b. Spec 28 §2.2 retro-modern suit contract (Phase 3)
// ---------------------------------------------------------------------------
section('1b. Spec 28 §2.2 retro-modern geometry & materials');

{
  const meshes = avatar.getMeshes();
  const byName = (n: string): Mesh | undefined => meshes.find((m) => m.name === `eva-${n}`);
  check('slim tapered torso r 0.20 (gate ≤ 0.22), h 0.92, y 0.84',
    GEO.torso.radius === 0.2 && GEO.torso.radius <= 0.22 && GEO.torso.height === 0.92 && GEO.torso.y === 0.84
    && byName('torso') !== undefined && byName('chest-plate') !== undefined && byName('waist-band') !== undefined,
    `r=${GEO.torso.radius} h=${GEO.torso.height} y=${GEO.torso.y}`);
  check('left + right arm assemblies (upper, forearm, glove) present',
    ['arm-upper-l', 'arm-forearm-l', 'arm-glove-l', 'arm-upper-r', 'arm-forearm-r', 'arm-glove-r']
      .every((n) => byName(n) !== undefined));
  check('bubble helmet d 0.38 + panoramic visor d 0.36 (gate ≥ 0.34)',
    GEO.helmet.diameter === 0.38 && GEO.visor.diameter === 0.36 && GEO.visor.diameter >= 0.34
    && byName('helmet') !== undefined && byName('visor') !== undefined);
  const visorMesh = byName('visor')!;
  check('visor ellipsoid scaling sx 0.92, sy 0.65, sz 0.95',
    Math.abs(visorMesh.scaling.x - 0.92) < 1e-9 && Math.abs(visorMesh.scaling.y - 0.65) < 1e-9
    && Math.abs(visorMesh.scaling.z - 0.95) < 1e-9);
  check('twin cryo-cylinder PLSS r 0.08 h 0.52 replaces monolithic box',
    GEO.plss.tank.radius === 0.08 && GEO.plss.tank.height === 0.52
    && byName('plss-tank-l') !== undefined && byName('plss-tank-r') !== undefined
    && byName('backpack') === undefined);
  check('central radiator cowl + twin lower thruster nozzles present',
    byName('plss-radiator-cowl') !== undefined && byName('plss-nozzle-l') !== undefined
    && byName('plss-nozzle-r') !== undefined);
  check('flush chest telemetry slate 0.16 × 0.12 × 0.03',
    GEO.telemetry.width === 0.16 && GEO.telemetry.height === 0.12 && GEO.telemetry.depth === 0.03
    && byName('telemetry-pad') !== undefined);
  check('slender legs: knee articulators + 0.11 × 0.22 treaded lunar boots',
    ['leg-thigh-l', 'leg-knee-l', 'leg-calf-l', 'leg-boot-l',
      'leg-thigh-r', 'leg-knee-r', 'leg-calf-r', 'leg-boot-r'].every((n) => byName(n) !== undefined)
    && GEO.leg.boot.width === 0.11 && GEO.leg.boot.depth === 0.22);
  const suitScene = avatar.getScene()!;
  const fab = suitScene.getMaterialByName('eva-fabric-white') as PBRMaterial | null;
  const trim = suitScene.getMaterialByName('eva-trim-hardware') as PBRMaterial | null;
  const acc = suitScene.getMaterialByName('eva-trim-accent') as PBRMaterial | null;
  const goldM = suitScene.getMaterialByName('eva-visor-gold') as PBRMaterial | null;
  check('fabric-white PBR: albedo (0.88,0.88,0.86), rough 0.65, metal 0.02',
    fab !== null && Math.abs(fab.albedoColor.r - 0.88) < 1e-6 && Math.abs(fab.albedoColor.g - 0.88) < 1e-6
    && Math.abs(fab.albedoColor.b - 0.86) < 1e-6 && Math.abs(fab.roughness! - 0.65) < 1e-9
    && Math.abs(fab.metallic! - 0.02) < 1e-9);
  check('trim-hardware slate (0.25,0.26,0.28) + safety-orange accent (0.92,0.42,0.12)',
    trim !== null && acc !== null
    && Math.abs(trim.albedoColor.r - 0.25) < 1e-6 && Math.abs(trim.albedoColor.g - 0.26) < 1e-6
    && Math.abs(trim.albedoColor.b - 0.28) < 1e-6
    && Math.abs(acc.albedoColor.r - 0.92) < 1e-6 && Math.abs(acc.albedoColor.g - 0.42) < 1e-6
    && Math.abs(acc.albedoColor.b - 0.12) < 1e-6);
  check('visor-gold mirror: metal 0.98, rough 0.08, amber emissive (0.12,0.08,0.02)',
    goldM !== null && Math.abs(goldM.metallic! - 0.98) < 1e-9 && Math.abs(goldM.roughness! - 0.08) < 1e-9
    && Math.abs(goldM.emissiveColor.r - 0.12) < 1e-6 && Math.abs(goldM.emissiveColor.g - 0.08) < 1e-6
    && Math.abs(goldM.emissiveColor.b - 0.02) < 1e-6);
}

// ---------------------------------------------------------------------------
// 2. Physics delegation — the wrapper must not add its own physics
// ---------------------------------------------------------------------------
section('2. update() delegates to LunarEvaSuit physics');

const walkAvatar = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } }).init();
// Spec 28 §2.3: forward past 0.6 (or sprint held) now erupts into the
// automatic lunar bound, so the pure-walk delegation / datum / stride-pose
// probes ride the production non-sprint throttle scale (ClientApp walks at
// 0.55). The bounding loop gets its own dedicated section below.
const forwardInput = { ...IDLE_SUIT_INPUT, forward: 0.55 };
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

// Spec 28 Phase 3: arms swing in NATURAL OPPOSITION to the legs mid-stride
// (walkAvatar has been stepping forward: hip swing is non-zero right now).
{
  const find = (n: string): Mesh => walkAvatar.getMeshes().find((m) => m.name === n)!;
  const hip = find('eva-leg-thigh-l').parent as TransformNode;
  const shoulderL = find('eva-arm-upper-l').parent as TransformNode;
  const shoulderR = find('eva-arm-upper-r').parent as TransformNode;
  check('hip swing non-zero while walking', Math.abs(hip.rotation.x) > 1e-6, `hip=${hip.rotation.x}`);
  check('left arm opposes left leg', hip.rotation.x * shoulderL.rotation.x < 0,
    `hip=${hip.rotation.x} shoulder=${shoulderL.rotation.x}`);
  check('arm amplitude = ARM_SWING_SCALE × leg swing',
    Math.abs(Math.abs(shoulderL.rotation.x) - ARM_SWING_SCALE * Math.abs(hip.rotation.x)) < 1e-12);
  check('left and right arms counter-phase', shoulderL.rotation.x * shoulderR.rotation.x < 0);
}

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
// 3b. Spec 28 §2.3 — lunar low-G bounding & ballistic looping
// ---------------------------------------------------------------------------
section('3b. Spec 28 §2.3 lunar bounding sprint');

{
  check(
    'bound constants: vz 1.35, cruise 5.0, restitution 0.88, gate 1.8',
    SUIT_BOUND_LAUNCH_VZ === 1.35 && SUIT_BOUND_SPEED === 5.0
    && SUIT_BOUND_RESTITUTION === 0.88 && SUIT_BOUND_MIN_SPEED === 1.8,
  );

  const bSuit = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true });
  check('idle suit reports gaitMode "idle"', bSuit.getState().gaitMode === 'idle');

  // Regular walking (forward ≤ 0.6, sprint off) stays grounded on the stride.
  const walkOnly = { ...IDLE_SUIT_INPUT, forward: 0.55 };
  let bs = bSuit.getState();
  for (let i = 0; i < 180; i++) bs = bSuit.step(DT, walkOnly, () => 0);
  check(
    'walking (fwd 0.55, sprint off): gaitMode walk, grounded on datum, hangtime 0',
    bs.gaitMode === 'walk' && bs.isGrounded === true && Math.abs(bs.z) < 1e-9
    && bs.hangtime === 0,
    `gait=${bs.gaitMode} z=${bs.z}`,
  );

  // Bury the sprint throttle: the stride erupts into ballistic bounds.
  const sprintBound = { ...IDLE_SUIT_INPUT, forward: 1, sprint: true };
  let apex = 0;
  let maxSpeed = 0;
  let maxHang = 0;
  let leaps = 0;
  let wasAir = false;
  let boundingSeen = false;
  for (let i = 0; i < 1200; i++) {
    bs = bSuit.step(DT, sprintBound, () => 0);
    apex = Math.max(apex, bs.z);
    maxSpeed = Math.max(maxSpeed, Math.hypot(bs.vx, bs.vy));
    maxHang = Math.max(maxHang, bs.hangtime);
    if (bs.gaitMode === 'bounding') boundingSeen = true;
    if (!bs.isGrounded && !wasAir) leaps += 1;
    wasAir = !bs.isGrounded;
  }
  check('gaitMode reaches "bounding"', boundingSeen);
  check(`bound apex clears the 0.35 m gate (${apex.toFixed(2)} m, ~0.56 expected)`, apex >= 0.35);
  check(`bound hangtime clears the 0.6 s gate (${maxHang.toFixed(2)} s)`, maxHang >= 0.6);
  check(`forward speed clears the 4.5 m/s gate (${maxSpeed.toFixed(2)} m/s)`, maxSpeed >= 4.5);
  check(`ballistic looping: alternating airborne leaps (${leaps} in 20 s)`, leaps >= 3);
  check(
    'bounding keeps a rhythmic cadence (multiple distinct airtime arcs)',
    leaps * 1.4 <= 20 / 0.8, // ≤ ~14 leaps in 20 s at ≥ 0.8 s per cycle
    `leaps=${leaps}`,
  );

  // Manual [Space]/A leap stays the high escape hatch cut from the loop.
  const bJump = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true });
  let js = bJump.getState();
  let launchVz = 0;
  let manualApex = 0;
  let jumped = false;
  for (let i = 0; i < 1800; i++) {
    if (!jumped && js.isGrounded && js.gaitMode === 'bounding') {
      js = bJump.step(DT, { ...sprintBound, jump: true }, () => 0);
      launchVz = js.vz;
      jumped = true;
    } else {
      js = bJump.step(DT, sprintBound, () => 0);
    }
    if (jumped) manualApex = Math.max(manualApex, js.z);
  }
  check('manual leap from a bound launches at SUIT_JUMP_VELOCITY minus gravity',
    jumped && Math.abs(launchVz - (SUIT_JUMP_VELOCITY - 1.62 * DT)) < 1e-9,
    `vz=${launchVz.toFixed(3)}`);
  check(`manual leap out of the bound is the high arc (${manualApex.toFixed(2)} m > bound apex)`,
    manualApex > 1.8);

  // Throttle lifted → the loop settles back into a grounded walk stride.
  const bCool = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true });
  let cs = bCool.getState();
  for (let i = 0; i < 600; i++) cs = bCool.step(DT, sprintBound, () => 0);
  for (let i = 0; i < 300; i++) cs = bCool.step(DT, walkOnly, () => 0);
  check(
    'throttle lifted: back to grounded walk stride (gaitMode walk, hangtime 0)',
    cs.gaitMode === 'walk' && cs.isGrounded === true && cs.hangtime === 0
    && Math.abs(cs.z) < 1e-9,
    `gait=${cs.gaitMode} grounded=${cs.isGrounded} z=${cs.z}`,
  );

  // The avatar wrapper adds no physics of its own under the bound loop.
  const bBare = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true });
  const bWrap = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } }).init();
  let xs = bBare.getState();
  let ys2 = bWrap.getState();
  for (let i = 0; i < 420; i++) {
    xs = bBare.step(DT, sprintBound, () => 0);
    ys2 = bWrap.update(DT, sprintBound);
  }
  check(
    'bounding bit-identical between avatar and bare suit (x, z, hangtime, oxygen)',
    Object.is(ys2.x, xs.x) && Object.is(ys2.z, xs.z) && Object.is(ys2.hangtime, xs.hangtime)
    && Object.is(ys2.oxygen, xs.oxygen),
  );

  // -- AstronautSuit articulation on the arc ----------------------------------
  const bndAvatar = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } }).init();
  const node = (n: string): TransformNode => (bndAvatar.getMeshes().find((m) => m.name === n)!).parent as TransformNode;
  const mesh = (n: string): Mesh => bndAvatar.getMeshes().find((m) => m.name === n)!;
  let as = bndAvatar.getState();
  for (let i = 0; i < 900 && (as.isGrounded || as.gaitMode !== 'bounding'); i++) {
    as = bndAvatar.update(DT, sprintBound);
  }
  const hipFL = node('eva-leg-thigh-l');
  const hipFR = node('eva-leg-thigh-r');
  const slF = node('eva-arm-upper-l');
  const srF = node('eva-arm-upper-r');
  check('flight pose: legs trail aft in knee flexion',
    !as.isGrounded && as.gaitMode === 'bounding'
    && hipFL.rotation.x > 0.3 && hipFR.rotation.x > 0.3
    && Math.abs(hipFL.rotation.x - hipFR.rotation.x) < 1e-12,
    `hipL=${hipFL.rotation.x} hipR=${hipFR.rotation.x}`);
  check('flight pose: arms spread outward for balance',
    slF.rotation.z < -0.1 && srF.rotation.z > 0.1
    && Math.abs(slF.rotation.z + srF.rotation.z) < 1e-12,
    `zL=${slF.rotation.z} zR=${srF.rotation.z}`);

  // Touchdown: boot-dust puff + landing crouch compression.
  const puffsBefore = bndAvatar.getBootDustPuffCount();
  for (let i = 0; i < 400 && as.isGrounded !== true; i++) as = bndAvatar.update(DT, sprintBound);
  check('bounding touchdown kicks regolith boot dust', bndAvatar.getBootDustPuffCount() > puffsBefore,
    `${puffsBefore} → ${bndAvatar.getBootDustPuffCount()}`);
  let crouched = false;
  let lowest = 0;
  for (let i = 0; i < 8; i++) {
    as = bndAvatar.update(DT, sprintBound);
    const ty = mesh('eva-torso').position.y - GEO.torso.y;
    lowest = Math.min(lowest, ty);
    if (ty < -0.03) crouched = true;
  }
  check(`landing crouch compresses the torso (-${(-lowest).toFixed(3)} m ≤ -0.03)`, crouched);

  // Walking after bounding parks the flight pose back to the stride.
  for (let i = 0; i < 300; i++) as = bndAvatar.update(DT, walkOnly);
  check('post-bound walk: flight spread cleared, arms back in the stride plane',
    Math.abs(slF.rotation.z) < 1e-12 && Math.abs(srF.rotation.z) < 1e-12);

  bndAvatar.dispose();
  bWrap.dispose();
}

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
// Spec 23 §2.4.3 / acceptance gate 4: helmet projector re-cut to 6.0 / 85° /
// 50 m (from the Spec 21 2.0 / 70° / 30 m flashlight). Assert the new
// contract exactly, on the constant AND on the live SpotLight.
check('helmet projector constants are Spec 23 grade (6.0 / 85° / 50 m)',
  HEADLIGHT_INTENSITY === 6.0 && HEADLIGHT_ANGLE_DEG === 85 && HEADLIGHT_RANGE_M === 50,
  `${HEADLIGHT_INTENSITY} / ${HEADLIGHT_ANGLE_DEG}° / ${HEADLIGHT_RANGE_M} m`);
check('live helmet SpotLight carries the Spec 23 beam geometry',
  Math.abs(lamp.range - 50) < 1e-9 && Math.abs((lamp.angle * 180) / Math.PI - 85) < 1e-6);
check('gate 4 bounds hold (intensity ≥ 5.0, throw ≥ 45 m, angle ≥ 80°)',
  HEADLIGHT_INTENSITY >= 5.0 && HEADLIGHT_RANGE_M >= 45 && HEADLIGHT_ANGLE_DEG >= 80);

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
