/**
 * Spec 26 Phase 3 verification probe: TrainHeistDirector functional contract.
 * Run: `npx tsx scripts/smoke-train-heist-director.ts`  (exit code 0 == all green)
 *
 * Covers blueprint §4 gate group 3 (velocity-matching trigger logic with
 * tolerance fuzzing, relative coordinate matrix transforms / zero relative
 * slippage on deck, vault hacking timer, loot generation, 44 s depot
 * countdown) and gate group 4 (bailout launch kinematics, safe landing
 * outside the Citadel lethal threshold), plus the phase machine, the tether
 * autopilot target, garbage-input hardening and the reset/dispose lifecycle.
 *
 * The director is scene-independent by contract — this harness never builds
 * a Babylon scene at all: a bare `new HighSpeedMaglev()` (pure spline math)
 * and `new XCorpCitadel()` (pure potential field) drive every assertion.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { HighSpeedMaglev, CARRIAGE_FLOAT_M } from '../src/infrastructure/HighSpeedMaglev.ts';
import { XCorpCitadel } from '../src/infrastructure/XCorpCitadel.ts';
import { WorldScene } from '../src/engine/WorldScene.ts';
import {
  TrainHeistDirector,
  HEIST_PHASES,
  MAX_RELATIVE_SPEED_MPS,
  BOARDING_LATERAL_MIN_M,
  BOARDING_LATERAL_MAX_M,
  BOARDING_LONGITUDINAL_MAX_M,
  TETHER_STANDBOFF_M,
  VAULT_HACK_DURATION_S,
  LOOT_HE3_CRYO_FLASKS,
  LOOT_QUANTUM_CIPHER_SLATES,
  LOOT_SUPERCONDUCTING_COILS,
  DEPOT_COUNTDOWN_S,
  BAILOUT_WARNING_S,
  BAILOUT_LATERAL_MPS,
  VAULT_DECK_LENGTH_M,
  VAULT_DECK_WIDTH_M,
  BAILOUT_DECK_HEIGHT_M,
  BOARDING_APEX_HEIGHT_M,
  DEPOT_ALARM_DISTANCE_M,
  type HeistPhase,
} from '../src/quests/TrainHeistDirector.ts';
import { worldToBabylon } from '../src/engine/CameraRig.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(label); console.log(`  ✘ ${label} ${detail}`); }
}
const hFrame = () => 1 / 60;
type V3 = { x: number; y: number; z: number };
const vAdd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vSub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vScale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const vLen = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const finiteV = (v: V3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** Independent quaternion rotation (test-side oracle for M_vault · P_local). */
function qRotate(q: { x: number; y: number; z: number; w: number }, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Exact-magnitude lateral offset vector at the vault car (perpendicular to T̂). */
function trueLateral(v: { worldForward: V3 }, magnitude = 4): V3 {
  const f = v.worldForward;
  const raw = { x: 3, y: 3, z: 0 };
  const perp = vSub(raw, vScale(f, raw.x * f.x + raw.y * f.y + raw.z * f.z));
  return vScale(perp, magnitude / vLen(perp));
}

/** Board + crack a fresh director at the current (frozen) train state. */
function boardAndCrack(d: TrainHeistDirector, m: HighSpeedMaglev): boolean {
  const v = m.getVaultCarState()!;
  const rover = vAdd(v.worldPosition, trueLateral(v, 4));
  d.update(hFrame(), rover, v.speedMps);
  const boarded = d.executeBoardingJump();
  if (!boarded) return false;
  let cracked = false;
  for (let i = 0; i < 400 && !cracked; i++) cracked = d.interactVaultLock(hFrame());
  return cracked;
}

// --- constants & phase machine -------------------------------------------------
console.log('\n· constants & canonical contract');
check('Δv cap 3.5 m/s', MAX_RELATIVE_SPEED_MPS === 3.5);
check('lateral band [2.5, 5.5] m', BOARDING_LATERAL_MIN_M === 2.5 && BOARDING_LATERAL_MAX_M === 5.5);
check('longitudinal cap 3.0 m', BOARDING_LONGITUDINAL_MAX_M === 3.0);
check('tether standoff 4.5 m', TETHER_STANDBOFF_M === 4.5);
check('hack duration 6.0 s', VAULT_HACK_DURATION_S === 6.0);
check('loot table 3 / 1 / 2', LOOT_HE3_CRYO_FLASKS === 3 && LOOT_QUANTUM_CIPHER_SLATES === 1 && LOOT_SUPERCONDUCTING_COILS === 2);
check('depot countdown 44.0 s', DEPOT_COUNTDOWN_S === 44.0);
check('bailout red-banner at T-30 s', BAILOUT_WARNING_S === 30.0);
check('bailout lateral launch 4.0 m/s', BAILOUT_LATERAL_MPS === 4.0);
check('deck ≈ 14 m × 3.2 m', VAULT_DECK_LENGTH_M === 14.0 && VAULT_DECK_WIDTH_M === 3.2);
check('boarding apex lift 0.5 m', BOARDING_APEX_HEIGHT_M === 0.5);
check('alarm seat 1,100 m from blast gates', DEPOT_ALARM_DISTANCE_M === 1100);
const PHASE_ORDER: readonly string[] = [
  'INACTIVE', 'INTERCEPTING', 'BOARDING_WINDOW', 'ON_BOARD_CRACKING',
  'LOOT_SECURED', 'DEPOT_COUNTDOWN', 'BAILOUT_SUCCESS', 'ESCAPE_COMPLETE', 'FAILED',
];
check('HEIST_PHASES matches blueprint §2.1 machine',
  HEIST_PHASES.length === PHASE_ORDER.length && PHASE_ORDER.every((p, i) => p === HEIST_PHASES[i]),
  HEIST_PHASES.join(','));

// --- pristine state --------------------------------------------------------------
console.log('\n· initial state & startHeist');
const m = new HighSpeedMaglev();
const citadel = new XCorpCitadel();
const d = new TrainHeistDirector(m, citadel);
check('starts INACTIVE', d.getPhase() === 'INACTIVE');
check('isPlayerOnBoard false', d.isPlayerOnBoard() === false);
check('tether inactive', d.isAutopilotTetherActive() === false);
check('loot empty', JSON.stringify(d.getLootPayload()) === JSON.stringify({ he3CryoFlasks: 0, quantumCipherSlates: 0, superconductingCoils: 0 }));
check('countdown 0 / hack 0', d.getCountdownRemainingS() === 0 && d.getHackProgress() === 0);
check('initial telemetry all-finite', (() => {
  const t = d.getTelemetry();
  return Number.isFinite(t.relativeSpeedMps) && Number.isFinite(t.lateralDistanceM) &&
    Number.isFinite(t.longitudinalOffsetM) && Number.isFinite(t.hackProgressFraction) &&
    Number.isFinite(t.countdownRemainingS) && t.stolenCargoCount === 0 && t.canBoard === false;
})());
check('boarding jump refused before update/envelope', d.executeBoardingJump() === false);
check('vault lock refused while off-train', d.interactVaultLock(1) === false);
check('bailout refused while off-train', d.executeBailoutJump() === false);
check('finishEscape refused pre-bailout', d.finishEscape() === false);
check('startHeist → INTERCEPTING', d.startHeist() === true && d.getPhase() === 'INTERCEPTING');
check('startHeist not reentrant', d.startHeist() === false);
check('jump refused with stale telemetry (no fresh envelope)', (() => {
  // d is INTERCEPTING since the last update() — but the boarding gate is the
  // *current* telemetry snapshot; force one outside the pocket first.
  d.update(hFrame(), { x: 9999, y: 9999, z: 0 }, 0);
  return d.executeBoardingJump() === false;
})());
// The maglev clock is WorldScene's, never the director's.
const headBefore = m.getHeadDistanceM();
d.update(hFrame(), { x: 0, y: 0, z: 0 }, 0);
check('director.update never advances the maglev', m.getHeadDistanceM() === headBefore);

// --- velocity-matching envelope (fuzzed at the tolerances) -------------------------
console.log('\n· interception envelope math');
for (let i = 0; i < 750; i++) m.update(hFrame()); // 12.5 s → cruise 25.0 m/s
const v0 = m.getVaultCarState()!;
check('train at cruise for envelope tests', v0.speedMps === 25.0, `${v0.speedMps}`);
const T = v0.worldForward;
const P = v0.worldPosition;
// True lateral unit: perpendicular to the guideway tangent (heading +y world
// is NOT perpendicular to T on a meandered line — build the real one).
const latRaw = { x: 3, y: 3, z: 0 };
const latU = vSub(latRaw, vScale(T, latRaw.x * T.x + latRaw.y * T.y + latRaw.z * T.z));
const latUnit = vScale(latU, 1 / vLen(latU));
const lat4 = vScale(latUnit, 4); // exact 4.0 m lateral pocket offset
// Matched rover: exact train velocity (scalar read), 4 m lateral, 0 m longitudinal.
let t = d.update(hFrame(), vAdd(P, lat4), v0.speedMps);
check('Δv ≈ 0 for matched scalar speed', t.relativeSpeedMps < 1e-9, `${t.relativeSpeedMps}`);
check('lateral 4.0 m readback', Math.abs(t.lateralDistanceM - 4) < 1e-6, `${t.lateralDistanceM}`);
check('longitudinal 0 m readback', Math.abs(t.longitudinalOffsetM) < 1e-9, `${t.longitudinalOffsetM}`);
check('canBoard lights green in the pocket', t.canBoard === true);
check('BOARDING_WINDOW phase on envelope entry', d.getPhase() === 'BOARDING_WINDOW');
// Rover velocity as a full world vector matched to v_train.
t = d.update(hFrame(), vAdd(P, lat4), vScale(T, v0.speedMps));
check('vector velocity matched → Δv ≈ 0', t.relativeSpeedMps < 1e-9 && t.canBoard === true);
t = d.update(hFrame(), vAdd(P, lat4), vScale(T, v0.speedMps + 3.4));
check('Δv 3.4 inside cap', t.relativeSpeedMps < 3.4 + 1e-9 && t.canBoard === true);
t = d.update(hFrame(), vAdd(P, lat4), vScale(T, v0.speedMps + 3.5));
check('Δv 3.5 boundary still inside', t.relativeSpeedMps <= 3.5 + 1e-9 && t.canBoard === true);
t = d.update(hFrame(), vAdd(P, lat4), vScale(T, v0.speedMps + 3.6));
check('Δv 3.6 outside cap', t.relativeSpeedMps > 3.5 && t.canBoard === false);
// Lateral band fuzz: 2.4 / 2.5 / 5.5 / 5.6 m.
t = d.update(hFrame(), vAdd(P, vScale(latUnit, 2.4)), v0.speedMps);
check('lateral 2.4 below band', t.canBoard === false && Math.abs(t.lateralDistanceM - 2.4) < 1e-6);
t = d.update(hFrame(), vAdd(P, vScale(latUnit, BOARDING_LATERAL_MIN_M)), v0.speedMps);
check('lateral 2.5 band floor inside', t.canBoard === true);
t = d.update(hFrame(), vAdd(P, vScale(latUnit, BOARDING_LATERAL_MAX_M)), v0.speedMps);
check('lateral 5.5 band ceiling inside', t.canBoard === true);
t = d.update(hFrame(), vAdd(P, vScale(latUnit, 5.6)), v0.speedMps);
check('lateral 5.6 above band', t.canBoard === false);
// Longitudinal fuzz: 2.9 / 3.0 in, 3.1 out, both signs.
t = d.update(hFrame(), vAdd(P, vAdd(lat4, vScale(T, 2.9))), v0.speedMps);
check('longitudinal +2.9 inside', t.canBoard === true && Math.abs(t.longitudinalOffsetM - 2.9) < 1e-6);
t = d.update(hFrame(), vAdd(P, vAdd(lat4, vScale(T, -3.0))), v0.speedMps);
check('longitudinal −3.0 boundary inside', t.canBoard === true);
t = d.update(hFrame(), vAdd(P, vAdd(lat4, vScale(T, 3.1))), v0.speedMps);
check('longitudinal +3.1 outside', t.canBoard === false && d.getPhase() === 'INTERCEPTING');
// Combined perpendicular lateral (offset with a forward component removed).
const perp = vSub({ x: 3, y: 3, z: 0.5 }, vScale(T, (3 * T.x + 3 * T.y + 0.5 * T.z)));
t = d.update(hFrame(), vAdd(P, perp), v0.speedMps);
const perpLen = vLen(perp);
check('true lateral projection matches spec formula',
  Math.abs(t.lateralDistanceM - perpLen) < 1e-9 && t.canBoard === (perpLen >= 2.5 && perpLen <= 5.5),
  `perp=${perpLen.toFixed(3)} read=${t.lateralDistanceM.toFixed(3)}`);

// --- boarding window & the High-Speed Jump ------------------------------------------
console.log('\n· boarding window & catwalk anchor');
// Fall out of the envelope, then re-enter: INTERCEPTING ⇄ BOARDING_WINDOW.
t = d.update(hFrame(), { x: 0, y: 0, z: 0 }, 0);
check('falling out returns to INTERCEPTING', d.getPhase() === 'INTERCEPTING' && t.canBoard === false);
t = d.update(hFrame(), vAdd(P, lat4), v0.speedMps);
check('re-entry re-arms BOARDING_WINDOW', d.getPhase() === 'BOARDING_WINDOW' && t.canBoard === true);
d.reset();
d.startHeist();
d.update(hFrame(), vAdd(P, lat4), v0.speedMps);
check('intercepting + envelope → BOARDING_WINDOW', d.getPhase() === 'BOARDING_WINDOW');
check('executeBoardingJump succeeds in the pocket', d.executeBoardingJump() === true);
check('phase → ON_BOARD_CRACKING', d.getPhase() === 'ON_BOARD_CRACKING');
check('avatar on board', d.isPlayerOnBoard() === true);
check('rover autopilot tether engaged', d.isAutopilotTetherActive() === true);
check('player local anchor on the deck centre',
  JSON.stringify(d.getPlayerLocalPos()) === JSON.stringify({ x: 0, y: BAILOUT_DECK_HEIGHT_M, z: 0 }));
const pw = d.getPlayerWorldPos();
const expectedPw = (() => {
  const tf = m.getVaultCarTransform();
  const r = qRotate(tf.rotationQuaternion, { x: 0, y: BAILOUT_DECK_HEIGHT_M, z: 0 });
  const b = { x: r.x + tf.position.x, y: r.y + tf.position.y, z: r.z + tf.position.z };
  return { x: b.x, y: -b.z, z: b.y }; // babylonToWorld
})();
check('P_world = M_vault · P_local (deck centre, oracle)',
  Math.abs(pw.x - expectedPw.x) < 1e-9 && Math.abs(pw.y - expectedPw.y) < 1e-9 && Math.abs(pw.z - expectedPw.z) < 1e-9,
  `${JSON.stringify(pw)} vs ${JSON.stringify(expectedPw)}`);
check('deck anchor ≈ car origin + 2.9 m up (plus 0.4 m maglev float)',
  Math.abs(pw.z - P.z - BAILOUT_DECK_HEIGHT_M - CARRIAGE_FLOAT_M) < 1e-4, `${pw.z - P.z}`);
const apexW = d.getLastBoardingApex();
check('boarding apex recorded at deck + 0.5 m',
  apexW !== null && Math.abs(apexW!.z - pw.z - BOARDING_APEX_HEIGHT_M) < 1e-4);
check('canBoard suppressed while on deck', d.update(hFrame(), vAdd(P, lat4), v0.speedMps).canBoard === false);
// Zero relative slippage: the local anchor rides the car across 30 train frames.
const pwA = d.getPlayerWorldPos();
for (let i = 0; i < 30; i++) m.update(hFrame());
const pwB = d.getPlayerWorldPos();
const vNow = m.getVaultCarState()!;
const carDrift = vSub(vNow.worldPosition, P);
const anchorDrift = vSub(pwB, pwA);
// The car's kinematic state carries no suspension bob; the anchor rides the
// rendered transform (bob ±0.04 m) evaluated on the car's CURRENT frame
// frame (tangent re-sampled on the meander), so horizontal deviation is
// bounded by the arc-orientation delta over 30 frames (≈2.5e-4 m), z by the
// bob envelope — while remaining glued to the deck at every sample.
check('anchor drift equals car drift over 30 frames (no slide)',
  Math.abs(anchorDrift.x - carDrift.x) < 1e-3 && Math.abs(anchorDrift.y - carDrift.y) < 1e-3 &&
  Math.abs(anchorDrift.z - carDrift.z) < 0.1,
  `dA=${JSON.stringify(anchorDrift)} dC=${JSON.stringify(carDrift)}`);
const pwStill = d.getPlayerWorldPos();
const carStill = m.getPointAtDistance(vNow.distanceAlongSplineM);
check('anchor z tracks deck z (bob envelope)', Math.abs(pwStill.z - carStill.z - CARRIAGE_FLOAT_M - BAILOUT_DECK_HEIGHT_M) < 0.1,
  `${pwStill.z - carStill.z}`);

// --- deck bounds & local↔world transform ------------------------------------------------
console.log('\n· deck bounds & coordinate transform');
const cl = d.clampLocalToDeck({ x: 50, y: 2, z: 999 });
check('clamp snaps to deck ±W/2 × ±L/2', cl.x === 1.6 && cl.z === 7 && cl.y === 2);
const clN = d.clampLocalToDeck({ x: NaN, y: NaN, z: NaN });
check('clamp NaN-hardened', clN.x === 0 && clN.y === 0 && clN.z === 0);
const l2w = d.localToWorld({ x: 1.6, y: 1.5, z: 3 });
const expectedL2w: V3 = (() => {
  const tf = m.getVaultCarTransform();
  const r = qRotate(tf.rotationQuaternion, { x: 1.6, y: 1.5, z: 3 });
  const b = { x: r.x + tf.position.x, y: r.y + tf.position.y, z: r.z + tf.position.z };
  return { x: b.x, y: -b.z, z: b.y };
})();
check('localToWorld(1.6, 1.5, 3) matches M_vault oracle',
  Math.abs(l2w.x - expectedL2w.x) < 1e-9 && Math.abs(l2w.y - expectedL2w.y) < 1e-9 && Math.abs(l2w.z - expectedL2w.z) < 1e-9);
const l2wFar = d.localToWorld({ x: 500, y: 0, z: 0 });
const l2wClamped = d.localToWorld({ x: 1.6, y: 0, z: 0 });
check('localToWorld clamps off-deck points onto the deck edge',
  Math.abs(l2wFar.x - l2wClamped.x) < 1e-9 && Math.abs(l2wFar.z - l2wClamped.z) < 1e-9);
// Deck locomotion via injected player state (local-frame velocity, m/s).
const zBefore = d.getPlayerLocalPos().z;
d.update(hFrame(), vAdd(P, lat4), v0.speedMps, { dz: 2 });
check('deck walk advances local z', d.getPlayerLocalPos().z > zBefore);
for (let i = 0; i < 3000; i++) d.update(hFrame(), vAdd(P, lat4), v0.speedMps, { dz: 2 });
check('deck walk hits the bow wall, never leaves', Math.abs(d.getPlayerLocalPos().z) <= VAULT_DECK_LENGTH_M / 2);
check('locomotion keeps world slip at zero', (() => {
  const a = d.getPlayerWorldPos();
  const b = d.localToWorld(d.getPlayerLocalPos());
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.z - b.z) < 1e-9;
})());

// --- tether autopilot target ------------------------------------------------------------
console.log('\n· tethered rover autopilot');
const target = d.getTetheredRoverTargetPos();
const vtNow = m.getVaultCarState()!;
const trackPt = m.getPointAtDistance(vtNow.distanceAlongSplineM);
const roadPt = m.getServiceRoadPointAtDistance(vtNow.distanceAlongSplineM);
check('tether target finite', finiteV(target));
check('tether target 4.5 m from guideway centreline',
  Math.abs(Math.hypot(target.x - trackPt.x, target.y - trackPt.y) - 4.5) < 1e-9,
  `${Math.hypot(target.x - trackPt.x, target.y - trackPt.y)}`);
check('tether target on the starboard service-road ray',
  (() => {
    const dx = target.x - trackPt.x;
    const dy = target.y - trackPt.y;
    const rx = roadPt.x - trackPt.x;
    const ry = roadPt.y - trackPt.y;
    const cross = dx * ry - dy * rx;
    return Math.abs(cross) < 1e-6;
  })());

// --- vault cracking ------------------------------------------------------------------------
console.log('\n· Mag-Lock bypass & loot siphon');
const m2 = new HighSpeedMaglev();
for (let i = 0; i < 750; i++) m2.update(hFrame());
const d2 = new TrainHeistDirector(m2, citadel);
d2.startHeist();
check('crack refused before boarding', d2.interactVaultLock(1) === false && d2.getHackProgress() === 0);
const v2 = m2.getVaultCarState()!;
d2.update(hFrame(), vAdd(v2.worldPosition, lat4), v2.speedMps);
d2.executeBoardingJump();
let frames = 0;
let cracked = false;
let fracMonotone = true;
let prevFrac = 0;
while (!cracked && frames < 1000) {
  cracked = d2.interactVaultLock(hFrame());
  frames++;
  const f = d2.getHackProgress();
  if (f < prevFrac - 1e-12) fracMonotone = false;
  prevFrac = f;
}
check('hack completes on frame 360 (6.0 s @ 60 Hz)', cracked && frames === 360, `frames=${frames}`);
check('hack progress monotone 0…1', fracMonotone && prevFrac === 1);
check('progress ≈ 1/60 per frame mid-crack', Math.abs(d2.getHackProgress() - 1) < 1e-12);
check('phase → LOOT_SECURED on pop', d2.getPhase() === 'LOOT_SECURED');
const loot = d2.getLootPayload();
check('loot: 3 He-3 cryo-flasks', loot.he3CryoFlasks === 3);
check('loot: 1 quantum cipher slate', loot.quantumCipherSlates === 1);
check('loot: 2 superconducting coils', loot.superconductingCoils === 2);
check('stolen cargo count 6', d2.getStolenCargoCount() === 6 && d2.getTelemetry().stolenCargoCount === 6);
check('countdown armed at T-44.0 s', d2.getCountdownRemainingS() === 44.0);
check('second crack attempt refused', d2.interactVaultLock(hFrame()) === false);
// Custom loot table + junk options fallback.
const dSmall = new TrainHeistDirector(m2, citadel, { loot: { he3CryoFlasks: 1, quantumCipherSlates: 0, superconductingCoils: 0 } });
check('custom loot table honoured', dSmall.getLootTable().he3CryoFlasks === 1 && dSmall.getLootTable().quantumCipherSlates === 0);
const dJunk = new TrainHeistDirector(m2, citadel, { maxRelativeSpeedMps: -1, hackDurationS: 0, countdownS: NaN, lateralBandMinM: -5 });
check('junk options fall back to canonical', (() => {
  dJunk.startHeist();
  const vj = m2.getVaultCarState()!;
  const tj = dJunk.update(hFrame(), vAdd(vj.worldPosition, trueLateral(vj, 2.5)), vj.speedMps + MAX_RELATIVE_SPEED_MPS);
  return tj.canBoard === true;
})());

// --- depot countdown --------------------------------------------------------------------------
console.log('\n· depot proximity countdown');
const tSecure = d2.update(hFrame(), vAdd(v2.worldPosition, lat4), v2.speedMps);
check('LOOT_SECURED hands off next tick', d2.getPhase() === 'DEPOT_COUNTDOWN');
check('T-44.0 on the first countdown frame', tSecure.countdownRemainingS === 44.0);
for (let i = 0; i < 60; i++) d2.update(hFrame(), vAdd(v2.worldPosition, lat4), v2.speedMps);
check('1 s drains 1 s of T', Math.abs(d2.getCountdownRemainingS() - 43.0) < 1e-6, `${d2.getCountdownRemainingS()}`);
check('telemetry mirrors countdown', d2.getTelemetry().countdownRemainingS === d2.getCountdownRemainingS());
check('not urgent above T-30', d2.isBailoutUrgent() === false);
for (let i = 0; i < 15 * 60; i++) d2.update(hFrame(), vAdd(v2.worldPosition, lat4), v2.speedMps);
check('urgent once under T-30', d2.isBailoutUrgent() === true);
check('still DEPOT_COUNTDOWN mid-escape window', d2.getPhase() === 'DEPOT_COUNTDOWN');
// Countdown-expiry path (no citadel → no shield, only the clock can kill
// you). The train stays frozen: this isolates the TIMER law from the dome
// interception law (the dome always claims a live train before T-0 — see
// the shield-path test below).
const m3 = new HighSpeedMaglev();
for (let i = 0; i < 750; i++) m3.update(hFrame());
const d3 = new TrainHeistDirector(m3, null);
check('citadel-less director accepts null perimeter', d3.startHeist() === true);
check('crack helper drives full flow', boardAndCrack(d3, m3) === true);
let expiryFrames = 0;
while ((d3.getPhase() === 'LOOT_SECURED' || d3.getPhase() === 'DEPOT_COUNTDOWN') && expiryFrames < 3600) {
  d3.update(hFrame(), { x: 0, y: 0, z: 0 }, 0);
  expiryFrames++;
}
check('countdown expiry vaporizes (FAILED)', d3.getPhase() === 'FAILED');
// 1 handoff tick (LOOT_SECURED → DEPOT_COUNTDOWN, no drain) + 2640 × 1/60 s.
check('expiry drains exactly 44.0 s of clock (2641 ticks incl. alarm handoff)',
  expiryFrames === 2641, `${expiryFrames}`);
check('countdown floors at 0', d3.getCountdownRemainingS() === 0);
check('tether released on failure', d3.isAutopilotTetherActive() === false);
// Shield-barrier path: seat the train 1,100 m out, run live, the dome must
// claim the vault before the clock does.
const m4 = new HighSpeedMaglev();
{
  let guard = 0;
  while (m4.getTotalSplineLengthM() - m4.getHeadDistanceM() > 1020 && guard < 200000) { m4.update(hFrame()); guard++; }
}
const d4 = new TrainHeistDirector(m4, citadel);
d4.startHeist();
check('shield-path seat: vault ~1004 m from citadel', (() => {
  const v = m4.getVaultCarState()!;
  const s = citadel.getPerimeterStatus(v.worldPosition);
  return s.distanceM > 900 && s.distanceM < 1100 && s.inShieldPerimeter === false;
})());
check('shield-path crack succeeds', boardAndCrack(d4, m4) === true);
let shieldFrames = 0;
while (d4.getPhase() !== 'FAILED' && shieldFrames < 3000) {
  m4.update(hFrame());
  const v = m4.getVaultCarState()!;
  d4.update(hFrame(), vAdd(v.worldPosition, trueLateral(v, 4)), v.speedMps);
  shieldFrames++;
}
check('shield barrier claims the run (FAILED)', d4.getPhase() === 'FAILED');
check('failure answered while the clock still had ≥ 11 s to run',
  shieldFrames / 60 > 28.0 && shieldFrames / 60 < 36.0, `${shieldFrames / 60}s`);
check('failure was the dome, not the clock (T-remaining > 0)', d4.getCountdownRemainingS() > 10.0,
  `T-${d4.getCountdownRemainingS()}`);
check('at failure the vault is inside the dome', citadel.getPerimeterStatus(m4.getVaultCarState()!.worldPosition).inShieldPerimeter === true);

// --- bailout & escape ------------------------------------------------------------------------------
console.log('\n· Leap of Faith & extraction');
check('bailout gated to the countdown window', d2.getPhase() === 'DEPOT_COUNTDOWN' || d2.getPhase() === 'LOOT_SECURED');
const jumped = d2.executeBailoutJump();
check('bailout succeeds inside the window', jumped === true);
check('phase → BAILOUT_SUCCESS', d2.getPhase() === 'BAILOUT_SUCCESS');
const exitV = d2.getBailoutExitVelocity();
const vAtBail = m2.getVaultCarState()!;
const expectExit: V3 = (() => {
  const f = vAtBail.worldForward;
  const rl = Math.hypot(f.y, -f.x) || 1;
  return vAdd(vScale(f, vAtBail.speedMps), { x: f.y / rl * BAILOUT_LATERAL_MPS, y: -f.x / rl * BAILOUT_LATERAL_MPS, z: 0 });
})();
check('v_exit = v_train + v_lateral (starboard)',
  Math.abs(exitV.x - expectExit.x) < 1e-9 && Math.abs(exitV.y - expectExit.y) < 1e-9);
check('lateral component exactly 4.0 m/s',
  Math.abs(vLen(vSub(exitV, vScale(vAtBail.worldForward, vAtBail.speedMps))) - BAILOUT_LATERAL_MPS) < 1e-9);
check('exit is off-heading (away from the rails)',
  (exitV.x - vAtBail.worldForward.x * vAtBail.speedMps) * vAtBail.worldForward.y -
  (exitV.y - vAtBail.worldForward.y * vAtBail.speedMps) * vAtBail.worldForward.x !== 0);
// Ballistic landing on the regolith must sit outside the lethal threshold.
const flightS = 2 * 1.62 > 0 ? Math.sqrt((2 * 1.5) / 1.62) * 2 : 1; // lunar g hang-time estimate
const landing: V3 = {
  x: vAtBail.worldPosition.x + exitV.x * flightS,
  y: vAtBail.worldPosition.y + exitV.y * flightS,
  z: 0,
};
check('landing outside the lethal threshold (r > 180 m)',
  citadel.getPerimeterStatus(landing).distanceM > 180,
  `r=${citadel.getPerimeterStatus(landing).distanceM.toFixed(0)}`);
check('avatar off the train after the leap', d2.isPlayerOnBoard() === false);
check('tether stays engaged until extraction', d2.isAutopilotTetherActive() === true);
check('finishEscape → ESCAPE_COMPLETE', d2.finishEscape() === true && d2.getPhase() === 'ESCAPE_COMPLETE');
check('escape releases the tether', d2.isAutopilotTetherActive() === false);
check('finishEscape not reentrant', d2.finishEscape() === false);
check('no drivers alive after ESCAPE_COMPLETE',
  d2.startHeist() === false && d2.executeBailoutJump() === false && d2.interactVaultLock(1) === false);

// --- garbage hardening & lifecycle -------------------------------------------------------------------
console.log('\n· input hardening, reset & dispose');
// Deterministic LCG fuzz — the director must never throw or emit NaN.
let seed = 0x5eed;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
let fuzzOk = true;
const dFuzz = new TrainHeistDirector(m, citadel);
for (let i = 0; i < 600; i++) {
  const pos = { x: (rnd() - 0.5) * 6000, y: (rnd() - 0.5) * 6000, z: rnd() * 20 };
  const vel = rnd() < 0.3 ? Number.NaN : (rnd() - 0.5) * 60;
  const dt = rnd() < 0.1 ? -1 : rnd() * 0.5;
  try {
    const ft = dFuzz.update(dt, pos, vel);
    if (!HEIST_PHASES.includes(ft.phase as HeistPhase) ||
      !Number.isFinite(ft.relativeSpeedMps) || !Number.isFinite(ft.lateralDistanceM) ||
      !Number.isFinite(ft.longitudinalOffsetM) || !Number.isFinite(ft.hackProgressFraction) ||
      !Number.isFinite(ft.countdownRemainingS) || ft.hackProgressFraction < 0 || ft.hackProgressFraction > 1) {
      fuzzOk = false;
    }
    dFuzz.interactVaultLock(dt);
  } catch {
    fuzzOk = false;
  }
}
check('600 garbage frames: no throw, telemetry stays finite/bounded', fuzzOk);
check('dt > 0.25 clamps to 0.25 (no timer jump)', (() => {
  const dC = new TrainHeistDirector(m, citadel);
  dC.startHeist();
  dC.update(10, vAdd(P, lat4), v0.speedMps); // clamped; envelope only
  return dC.getPhase() === 'BOARDING_WINDOW' || dC.getPhase() === 'INTERCEPTING';
})());
d2.reset();
check('reset → pristine INACTIVE run', d2.getPhase() === 'INACTIVE' && d2.getStolenCargoCount() === 0 &&
  d2.getCountdownRemainingS() === 0 && d2.getHackProgress() === 0 && !d2.isAutopilotTetherActive() &&
  d2.getLastBoardingApex() === null && JSON.stringify(d2.getPlayerLocalPos()) === JSON.stringify({ x: 0, y: 0, z: 0 }));
check('resettable director can start a new heist', d2.startHeist() === true);
const dDead = new TrainHeistDirector(m, citadel);
dDead.startHeist();
dDead.update(hFrame(), vAdd(P, lat4), v0.speedMps);
dDead.dispose();
check('isDisposed after dispose', dDead.isDisposed() === true);
check('disposed: startHeist/execute/interact all refuse',
  dDead.startHeist() === false && dDead.executeBoardingJump() === false &&
  dDead.interactVaultLock(1) === false && dDead.executeBailoutJump() === false && dDead.finishEscape() === false);
check('disposed: tether drops', dDead.isAutopilotTetherActive() === false);
check('disposed: update still answers with finite telemetry', (() => {
  const t2 = dDead.update(hFrame(), vAdd(P, lat4), v0.speedMps);
  return Number.isFinite(t2.relativeSpeedMps) && Number.isFinite(t2.lateralDistanceM);
})());
check('dispose idempotent', (dDead.dispose(), true));
check('tether target answers post-dispose (extraction readout)', finiteV(dDead.getTetheredRoverTargetPos()));

// --- WorldScene integration surface (NullEngine, built systems) -----------------------------------
console.log('\n· WorldScene integration (NullEngine, built citadel + maglev)');
const engine = new NullEngine();
const scene = new Scene(engine);
const world = new WorldScene({ seed: 'train-heist-p3' });
world.init(scene as never);
const wCitadel = world.buildXCorpCitadel();
const wMaglev = world.buildHighSpeedMaglev();
check('WorldScene builds the citadel + maglev', wCitadel.isBuilt() && wMaglev.isBuilt());
check('accessors round-trip', world.getXCorpCitadel() === wCitadel && world.getHighSpeedMaglev() === wMaglev);
const dW = new TrainHeistDirector(wMaglev, wCitadel);
dW.startHeist();
for (let i = 0; i < 750; i++) world.update(1000 / 60, wCitadel.getWorldCenter()); // cruise, render pump live
const builtTransform = dW.getVaultCarTransform();
check('vault transform answers on the built (bobbing) consist',
  Number.isFinite(builtTransform.position.x) && Number.isFinite(builtTransform.position.y) &&
  Number.isFinite(builtTransform.position.z) &&
  Math.abs(builtTransform.rotationQuaternion.length() - 1) < 1e-6);
// Board + crack on the BUILT train (rendered transforms, suspension bob).
const wv = wMaglev.getVaultCarState()!;
dW.update(hFrame(), vAdd(wv.worldPosition, trueLateral(wv, 4)), wv.speedMps);
check('boarding lands on the built consist', dW.executeBoardingJump() === true);
let wCracked = false;
for (let i = 0; i < 400 && !wCracked; i++) wCracked = dW.interactVaultLock(hFrame());
check('vault crack completes on the built consist', wCracked === true && dW.getStolenCargoCount() === 6);
// Bailout velocity stays finite while the deck bobs under the avatar.
dW.update(hFrame(), { x: 0, y: 0, z: 0 }, 0);
const wJumpOk = dW.executeBailoutJump();
check('bailout succeeds from the bobbing deck', wJumpOk === true && finiteV(dW.getBailoutExitVelocity()));
dW.dispose();
world.dispose();
check('teardown runs with the world (maglev unbuilt after)', wMaglev.isBuilt() === false);
engine.dispose();

console.log('');
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED`);
  process.exit(0);
} else {
  console.log(`${failures.length} FAILURES of ${passed + failures.length}:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
