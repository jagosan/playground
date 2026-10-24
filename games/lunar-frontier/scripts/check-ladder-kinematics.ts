/**
 * Spec 29 Phase 3 verification: CLIMBING locomotion mode & ladder kinematics
 * engine (`TraversalPhysics.ts`) plus the ClientApp-facing contracts
 * (proximity → latch → climb → hop / release / deck & ground hand-off).
 * Run: `npx tsx scripts/check-ladder-kinematics.ts`  (exit code 0 == all green)
 *
 * Pure headless kinematics — LunarEvaSuit/TraversalPhysics are framework-free
 * and the RadioTower mathematical layer answers without a scene, so no
 * NullEngine is required here (the assembly suite owns mesh checks).
 * No top-level await (tsx CJS); everything here is synchronous.
 */
import {
  LunarEvaSuit,
  TraversalPhysics,
  IDLE_SUIT_INPUT,
  LUNAR_GRAVITY,
  LADDER_CLIMB_SPEED,
  LADDER_CLIMB_SPRINT_SPEED,
  LADDER_HOP_VZ,
  LADDER_DISENGAGE_PUSH_MPS,
  LADDER_BODY_RAIL_OFFSET_M,
  LADDER_SUMMIT_EPS_M,
  LADDER_DECK_STEP_IN_M,
  LADDER_BASE_EPS_M,
  LADDER_GROUND_STEP_BACK_M,
  type LadderBounds,
  type SuitInput,
  type GroundElevationFn,
} from '../src/physics/TraversalPhysics';
import { RadioTower } from '../src/infrastructure/RadioTower.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(label); console.log(`  ✘ ${label} ${detail}`); }
}
function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

const DT = 1 / 60;
function input(patch: Partial<SuitInput> = {}): SuitInput {
  return { ...IDLE_SUIT_INPUT, ...patch };
}

// Canonical tower + ladder rail datum (physics law: linear lerp of the
// tapered rung-line endpoints + 0.30 m body-rail offset along the normal).
const tower = new RadioTower();
const B: LadderBounds = tower.getLadderBounds();
const NX = B.facingNormal.x;
const NY = B.facingNormal.y;
const DECK_Z = tower.getDeckElevation();
const AX = -1550; // tower seat x
const AY = 2320; // tower seat y
function railAt(z: number): { x: number; y: number } {
  const t = Math.min(Math.max((z - B.basePosition.z) / (B.topPosition.z - B.basePosition.z), 0), 1);
  return {
    x: B.basePosition.x + (B.topPosition.x - B.basePosition.x) * t + NX * LADDER_BODY_RAIL_OFFSET_M,
    y: B.basePosition.y + (B.topPosition.y - B.basePosition.y) * t + NY * LADDER_BODY_RAIL_OFFSET_M,
  };
}
// Deck-aware ground mirror of ClientApp.groundAt (5 m hex deck → r 2.6 zone).
const deckGround: GroundElevationFn = (x, y) =>
  Math.hypot(x - AX, y - AY) <= 2.6 ? DECK_Z : 0;
const FLAT: GroundElevationFn = () => 0;

function baseMountedSuit(startZ: number = B.basePosition.z): LunarEvaSuit {
  const suit = new LunarEvaSuit({ x: B.basePosition.x + NX, y: B.basePosition.y + NY, z: 0, isGrounded: true });
  const ok = suit.mountLadder(B, startZ);
  if (!ok) throw new Error(`mountLadder(${startZ}) failed in fixture`);
  return suit;
}

// --- 1. exports, constants, state shape -------------------------------------
console.log('\n[1] Exports, constants & SuitState shape');
check('climb speed 2.2 / sprint 3.6 m/s', LADDER_CLIMB_SPEED === 2.2 && LADDER_CLIMB_SPRINT_SPEED === 3.6);
check('hop impulse +3.2 m/s', LADDER_HOP_VZ === 3.2);
check('release push 0.8 m/s', LADDER_DISENGAGE_PUSH_MPS === 0.8);
check('body rail offset 0.30 m', LADDER_BODY_RAIL_OFFSET_M === 0.3);
check('summit eps 0.1 / step-in 1.2 m', LADDER_SUMMIT_EPS_M === 0.1 && LADDER_DECK_STEP_IN_M === 1.2);
check('base eps 0.1 / step-back 1.0 m', LADDER_BASE_EPS_M === 0.1 && LADDER_GROUND_STEP_BACK_M === 1.0);
const fresh = new LunarEvaSuit({ z: 0, isGrounded: true }).getState();
check('fresh state: WALK, unlatched, climb fields parked',
  fresh.locomotionMode === 'WALK' && fresh.ladderLatchActive === false
  && fresh.climbProgressM === 0 && fresh.climbRate === 0);

// --- 2. mount at base / mid-span / top hatch ----------------------------------
console.log('\n[2] Latch: base, mid-span and deck-hatch mounts');
const m0 = new LunarEvaSuit({ x: B.basePosition.x + NX * 0.8, y: B.basePosition.y + NY * 0.8, z: 0, isGrounded: true });
check('mountLadder at base answers true', m0.mountLadder(B, B.basePosition.z));
{
  const s = m0.getState();
  const r0 = railAt(0);
  check('latched: ladderLatchActive + CLIMBING', s.ladderLatchActive === true && s.locomotionMode === 'CLIMBING');
  check('(x,y) snapped to rung line + 0.30·n', near(s.x, r0.x, 1e-9) && near(s.y, r0.y, 1e-9));
  check('z at base datum, momenta absorbed', s.z === 0 && s.vx === 0 && s.vy === 0 && s.vz === 0);
  check('isOnLadder() true / isGrounded false', m0.isOnLadder() && !s.isGrounded);
}
check('double mount refused while latched', m0.mountLadder(B, 5) === false);
const mMid = baseMountedSuit(12);
{
  const s = mMid.getState();
  const r12 = railAt(12);
  check('mid-span mount z=12, rail-clamped', s.z === 12 && near(s.x, r12.x, 1e-9) && near(s.y, r12.y, 1e-9));
  check('climbProgressM tracks height above base', near(s.climbProgressM ?? -1, 12, 1e-9));
}
const mTop = baseMountedSuit(DECK_Z - 0.2);
{
  const s = mTop.getState();
  const rT = railAt(DECK_Z - 0.2);
  check('deck-hatch mount latches at deck − 0.2 m', s.ladderLatchActive === true && s.z === DECK_Z - 0.2
    && near(s.x, rT.x, 1e-9) && near(s.y, rT.y, 1e-9));
}
check('startZ clamped into climb span (999 → 48)', near(baseMountedSuit(999).getState().z, DECK_Z, 1e-9));
check('garbage contract refused (null)', new LunarEvaSuit().mountLadder(null as unknown as LadderBounds) === false);
check('degenerate contract refused (top ≤ base)',
  new LunarEvaSuit().mountLadder({ ...B, topPosition: { ...B.topPosition, z: B.basePosition.z } }) === false);
check('NaN startZ falls back to current elevation', (() => {
  const s = new LunarEvaSuit({ z: 7.5 });
  return s.mountLadder(B, NaN) && s.getState().z === 7.5;
})());
// Cross-check against the RadioTower rail oracle (acceptance: Δxy ≤ 0.05 m).
let maxRailErr = 0;
for (const z of [0, 6, 24, 47.8]) {
  const probe = baseMountedSuit(z);
  const p = probe.getState();
  const oracle = tower.getClimbOffsetPosition(z);
  maxRailErr = Math.max(maxRailErr, Math.hypot(p.x - oracle.x, p.y - oracle.y));
}
check(`rail agrees with RadioTower.getClimbOffsetPosition (max Δ ${maxRailErr.toFixed(6)} m ≤ 0.05)`, maxRailErr <= 0.05);

// --- 3. climb speeds, sprint boost, mechanical hold -----------------------------
console.log('\n[3] Vertical kinematics: 2.2 / 3.6 m/s, mechanical hold, strafe mute');
{
  const s0 = baseMountedSuit(0);
  let s = s0.getState();
  for (let i = 0; i < 60; i++) s = s0.step(DT, input({ forward: 1 }), FLAT);
  check('standard climb rate = 2.2 m/s (exact)', s.climbRate === 2.2 && s.vz === 2.2);
  check('1 s ascent Δz ≈ 2.2 m', Math.abs(s.z - LADDER_CLIMB_SPEED) < 1e-6, `z=${s.z}`);
  check('acceptance band 2.2 ± 0.3', Math.abs(s.climbRate! - 2.2) < 0.3);
  const r = railAt(s.z);
  check('(x,y) rigidly rail-locked while climbing (Δ ≤ 1e-9)', Math.abs(s.x - r.x) <= 1e-9 && Math.abs(s.y - r.y) <= 1e-9);
  check('mode CLIMBING, latch held, no gravity slide start', s.locomotionMode === 'CLIMBING' && s.ladderLatchActive === true);
}
{
  const s0 = baseMountedSuit(30);
  let s = s0.getState();
  for (let i = 0; i < 30; i++) s = s0.step(DT, input({ forward: 1, sprint: true }), FLAT);
  check('sprint climb rate = 3.6 m/s (exact)', s.climbRate === 3.6 && s.vz === 3.6);
  check('0.5 s sprint ascent Δz ≈ 1.8 m', Math.abs(s.z - (30 + 1.8)) < 1e-6, `z=${s.z}`);
  check('acceptance band 3.6 ± 0.4', Math.abs(s.climbRate! - 3.6) < 0.4);
}
{
  const s0 = baseMountedSuit(30);
  let s = s0.getState();
  for (let i = 0; i < 30; i++) s = s0.step(DT, input({ forward: -1 }), FLAT);
  check('descent rate = −2.2 m/s', s.climbRate === -2.2);
}
{
  const s0 = baseMountedSuit(24);
  let s = s0.getState();
  const x0 = s.x; const y0 = s.y; const z0 = s.z;
  for (let i = 0; i < 300; i++) s = s0.step(DT, IDLE_SUIT_INPUT, FLAT); // 5 seconds
  check('mechanical hold: zero slide over 300 frames (5 s)',
    s.z === z0 && s.x === x0 && s.y === y0 && s.vz === 0 && s.ladderLatchActive === true,
    `Δz=${s.z - z0}`);
  for (let i = 0; i < 60; i++) s = s0.step(DT, input({ strafe: 1 }), FLAT);
  check('lateral strafe muted: position unmoved, vz = 0',
    s.x === x0 && s.y === y0 && Math.abs(s.vz) < 1e-9 && s.ladderLatchActive === true);
  for (let i = 0; i < 10; i++) s = s0.step(DT, input({ forward: 1, strafe: -1 }), FLAT);
  const r = railAt(s.z);
  check('strafe + forward: rail owns x-y, climb proceeds',
    Math.abs(s.x - r.x) <= 1e-9 && Math.abs(s.y - r.y) <= 1e-9 && s.vz === 2.2 && s.z > z0);
}
{
  const s0 = baseMountedSuit(10);
  for (let i = 0; i < 60; i++) s0.step(DT, input({ forward: 1 }), FLAT);
  const s = s0.getState();
  check('life support keeps running while climbing (O₂/battery drained)',
    s.oxygen < 100 && s.battery < 100);
}

// --- 4. low-g rung hop -----------------------------------------------------------
console.log('\n[4] Low-g rung hop (+3.2 m/s impulse, ballistic arc)');
{
  const s0 = baseMountedSuit(0);
  const s = s0.step(DT, input({ jump: true }), FLAT);
  check('hop frame: unlatched, AIRBORNE', s.ladderLatchActive === false && s.locomotionMode === 'AIRBORNE' && !s0.isOnLadder());
  check('hop frame: vz = +3.2 m/s exactly', s.vz === 3.2 && s.jumpImpulse === 3.2);
  check('hop frame: rail position retained (no teleport)', near(s.z, 0, 1e-12));
  // Ballistic flight from the hop frame (Euler law of the normal branch:
  // z(n) = z0 + v0·T − g·dt²·n(n+1)/2 = z0 + v0·T − ½g·T·(T+dt)).
  const hop = baseMountedSuit(0);
  hop.step(DT, input({ jump: true }), FLAT);
  let z = hop.getState().z;
  const vx = hop.getState().vx;
  const x = hop.getState().x;
  let apex = z;
  // Full 3 s flight window (T_apex = v/g ≈ 1.98 s).
  let zAt1s = z;
  for (let i = 0; i < 180; i++) {
    const ns = hop.step(DT, IDLE_SUIT_INPUT, FLAT);
    z = ns.z;
    if (i === 59) zAt1s = ns.z;
    if (ns.z > apex) apex = ns.z;
  }
  const T1 = 60 * DT;
  const expected1s = LADDER_HOP_VZ * T1 - 0.5 * LUNAR_GRAVITY * T1 * (T1 + DT);
  check('ballistic z at t = 1 s matches v₀t − ½g·t(t+dt) exactly', near(zAt1s, expected1s, 1e-9), `z=${zAt1s}`);
  check('apex ≥ 2.5 m (spec gate)', apex >= 2.5, `apex=${apex.toFixed(3)}`);
  check('apex = v²/2g − v₀·dt/2 (Euler half-frame sampling)',
    Math.abs(apex - (LADDER_HOP_VZ * LADDER_HOP_VZ / (2 * LUNAR_GRAVITY) - LADDER_HOP_VZ * DT / 2)) < 0.005,
    `apex=${apex.toFixed(4)}`);
  check('horizontal stays put (vx from rail = 0)', vx === 0 && near(x, railAt(0).x, 1e-9));
}
{
  const s0 = baseMountedSuit(0);
  let last = s0.getState();
  // Holding jump must not re-trigger the impulse every frame (rising edge).
  s0.step(DT, input({ jump: true }), FLAT);
  last = s0.step(DT, input({ jump: true }), FLAT);
  check('jump rising edge enforced while held (no repeat impulse)', near(last.vz, 3.2 - LUNAR_GRAVITY * DT, 1e-9));
}

// --- 5. dismount release: 0.8 m/s push + free fall ---------------------------------
console.log('\n[5] Dismount: outward push 0.8 m/s along +n, parabolic descent');
check('dismountLadder off-ladder answers false', new LunarEvaSuit().dismountLadder() === false);
{
  const s0 = baseMountedSuit(20);
  const x0 = s0.getState().x;
  const s = s0.dismountLadder();
  const st = s0.getState();
  check('release answers true, unlatched → AIRBORNE', s && st.ladderLatchActive === false && st.locomotionMode === 'AIRBORNE' && !s0.isOnLadder());
  check('outward push vx/vy = 0.8·n exactly', near(st.vx, NX * 0.8, 1e-12) && near(st.vy, NY * 0.8, 1e-12));
  check('mechanical-hold release carries vz = 0', st.vz === 0);
  check('climb fields parked on release', st.climbRate === 0 && st.climbProgressM === 0);
  // Free-fall: x(t) = x0 + 0.8·nx·T (vacuum, no drag), z by the Euler law.
  for (let i = 0; i < 60; i++) s0.step(DT, IDLE_SUIT_INPUT, FLAT);
  const f = s0.getState();
  const T = 60 * DT;
  const nInt = 60;
  check('x drifts outward linearly at 0.8·nx', near(f.x, x0 + NX * 0.8 * nInt * DT, 1e-9));
  check('vy frozen at 0.8·ny (vacuum, no lateral force)', near(f.vy, NY * 0.8, 1e-12));
  check('free-fall vz = −g·t(t+dt)/t law', near(f.vz, -LUNAR_GRAVITY * T, 1e-9), `vz=${f.vz}`);
  check('z = 20 − ½g·t(t+dt) exactly', near(f.z, 20 - 0.5 * LUNAR_GRAVITY * T * (T + DT), 1e-9), `z=${f.z}`);
  // Ride it down to the regolith.
  let land = f;
  for (let i = 0; i < 400 && !(land.isGrounded && land.z <= 0.001); i++) land = s0.step(DT, IDLE_SUIT_INPUT, FLAT);
  check('lands grounded on the regolith (z clamped to floor)', land.isGrounded && land.z === 0 && land.vz === 0);
}
{
  const s0 = baseMountedSuit(20);
  s0.dismountLadder(2.0);
  const st = s0.getState();
  check('custom kick magnitude honoured (2.0 m/s)', near(Math.hypot(st.vx, st.vy), 2.0, 1e-12));
}

// --- 6. deck summit hand-off ----------------------------------------------------------
console.log('\n[6] Deck summit transition (z ≥ 48 − 0.1, vz > 0 → walk on deck)');
{
  const s0 = baseMountedSuit(0);
  let s = s0.getState();
  let progressMid = -1;
  let frames = 0;
  while (s.ladderLatchActive && frames < 2400) {
    s = s0.step(DT, input({ forward: 1 }), deckGround);
    if (frames === 600) progressMid = s.climbProgressM ?? -1;
    frames++;
  }
  check('summit reached automatically while ascending', !s.ladderLatchActive && frames > 1000 && frames < 1500, `frames=${frames}`);
  check('climbProgressM tracked mid-climb (≈ z)', progressMid > 20 && progressMid < 24, `${progressMid}`);
  check('z set exactly to deck elevation 48.0', s.z === DECK_Z);
  check('grounded WALK restored on deck', s.isGrounded === true && s.locomotionMode === 'WALK');
  check('velocities zeroed at step-off', s.vx === 0 && s.vy === 0 && s.vz === 0);
  const planar = Math.hypot(s.x - AX, s.y - AY);
  check(`stepped 1.2 m inboard along −n (planar radius ${planar.toFixed(4)} ∈ [0.44, 0.46])`,
    planar >= 0.44 && planar <= 0.46);
  const cross = (s.x - AX) * NY - (s.y - AY) * NX;
  check('step-off lands on the ladder normal line (cross ≈ 0)', Math.abs(cross) < 1e-9);
  // Stands on the gantry: deck-aware floor holds the avatar at 48.
  let stand = s;
  for (let i = 0; i < 60; i++) stand = s0.step(DT, IDLE_SUIT_INPUT, deckGround);
  check('stands on the observation deck (no pop, no fall)', stand.z === DECK_Z && stand.isGrounded === true);
  // Walks on the deck afterwards (heading defaults to +x, still on the grate).
  let walk = stand;
  for (let i = 0; i < 60; i++) walk = s0.step(DT, input({ forward: 0.5 }), deckGround);
  check('grounded walk resumes on the deck', walk.isGrounded === true && walk.z === DECK_Z
    && Math.hypot(walk.x - stand.x, walk.y - stand.y) > 0.4,
    `Δ=${Math.hypot(walk.x - stand.x, walk.y - stand.y).toFixed(3)} z=${walk.z}`);
}

// --- 7. ground step-off -----------------------------------------------------------------
console.log('\n[7] Base transition (z ≤ z_ground + 0.1, vz < 0 → walk on regolith)');
{
  const s0 = baseMountedSuit(DECK_Z - 0.2);
  let s = s0.getState();
  let frames = 0;
  while (s.ladderLatchActive && frames < 2400) {
    s = s0.step(DT, input({ forward: -1 }), deckGround);
    frames++;
  }
  check('base reached automatically while descending', !s.ladderLatchActive && frames > 1000 && frames < 1500, `frames=${frames}`);
  check('z clamped to ground datum 0.0', s.z === B.basePosition.z);
  check('grounded WALK restored on regolith', s.isGrounded === true && s.locomotionMode === 'WALK');
  check('velocities zeroed at step-back', s.vx === 0 && s.vy === 0 && s.vz === 0);
  const planar = Math.hypot(s.x - AX, s.y - AY);
  check(`stepped 1.0 m outward along +n (planar radius ${planar.toFixed(4)} ∈ [4.5, 4.6])`,
    planar >= 4.5 && planar <= 4.6);
  const cross = (s.x - AX) * NY - (s.y - AY) * NX;
  check('step-back lands on the ladder normal line (cross ≈ 0)', Math.abs(cross) < 1e-9);
  let stand = s;
  for (let i = 0; i < 60; i++) stand = s0.step(DT, IDLE_SUIT_INPUT, FLAT);
  check('stands on the regolith clear of the tower footprint', stand.z === 0 && stand.isGrounded === true);
}

// --- 8. locomotion mode bands (non-ladder) ----------------------------------------------
console.log('\n[8] LocomotionMode bands on the classic EVA loop');
{
  const s0 = new LunarEvaSuit({ z: 0, isGrounded: true });
  const s = s0.step(DT, input({ forward: 1 }), FLAT);
  check('ground stride → WALK', s.isGrounded && s.locomotionMode === 'WALK');
}
{
  const s0 = new LunarEvaSuit({ z: 0, isGrounded: true, vx: 1.2 });
  const s = s0.step(DT, input({ forward: 0.5, sprint: true }), FLAT);
  check('sprint latch moving → SPRINT', s.locomotionMode === 'SPRINT');
}
{
  const s0 = new LunarEvaSuit({ z: 0, isGrounded: true, vx: 3.0 });
  const s = s0.step(DT, input({ forward: 1 }), FLAT);
  check('bound launch frame → BOUND', s.locomotionMode === 'BOUND' && !s.isGrounded);
}
{
  const s0 = new LunarEvaSuit({ z: 0, isGrounded: true });
  const s = s0.step(DT, input({ jump: true }), FLAT);
  check('manual hop → AIRBORNE', s.locomotionMode === 'AIRBORNE' && near(s.vz, 2.6 - LUNAR_GRAVITY * DT, 1e-9));
  const after = s0.step(DT, IDLE_SUIT_INPUT, FLAT);
  check('ladder fields parked while airborne', after.ladderLatchActive === false && after.climbRate === 0);
}

// --- 9. TraversalPhysics facade ----------------------------------------------------------
console.log('\n[9] TraversalPhysics facade (ClientApp integration surface)');
{
  const tp = new TraversalPhysics();
  tp.getSuite().setState({ x: B.basePosition.x, y: B.basePosition.y, z: 0, isGrounded: true });
  check('facade mountLadder true, isClimbing', tp.mountLadder(B, 0) === true && tp.isClimbing());
  check('facade double mount refused', tp.mountLadder(B, 0) === false);
  let snap = tp.step(DT, { suit: { ...IDLE_SUIT_INPUT, forward: 1 } });
  for (let i = 0; i < 59; i++) snap = tp.step(DT, { suit: { ...IDLE_SUIT_INPUT, forward: 1 } });
  check('engine step drives the climb (1 s ≈ 2.2 m)', Math.abs(snap.suit.z - 2.2) < 1e-6, `z=${snap.suit.z}`);
  check('snapshot reports CLIMBING + latch', snap.suit.locomotionMode === 'CLIMBING' && snap.suit.ladderLatchActive === true);
  check('facade dismountLadder true, no longer climbing', tp.dismountLadder() === true && !tp.isClimbing());
  const air = tp.getSuite().getState();
  check('facade release pushes outward 0.8·n', near(air.vx, NX * 0.8, 1e-12) && near(air.vy, NY * 0.8, 1e-12));
}

// --- summary ---------------------------------------------------------------------------------
console.log(`\n${failures.length === 0 ? `ALL ${passed} CHECKS PASSED` : `${failures.length} FAILURES of ${passed + failures.length}: ${failures.join(', ')}`}`);
process.exitCode = failures.length === 0 ? 0 : 1;
