/**
 * Spec 29 Phase 4 verification: avatar climbing visuals (AstronautSuit.ts
 * grip articulation, alternating limb cycle, inward ladder heading), the
 * observation-deck perimeter railing law + ladder-hatch pass-through
 * (ClientApp.ts), and the EVA camera look-pitch freedom band covering the
 * −50° maglev-guideway down-look and the antenna-spire up-look (CameraRig.ts).
 *
 * Run: `npx tsx scripts/check-climbing-visuals.ts`  (exit code 0 == all green)
 *
 * Headless: EvaSuitAvatar self-owns a NullEngine, the CameraRig runs against
 * one too, and the deck law / climb pose laws are pure functions — no DOM,
 * no top-level await (tsx CJS); everything here is synchronous.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

import {
  LunarEvaSuit,
  IDLE_SUIT_INPUT,
  LADDER_CLIMB_SPEED,
  type LadderBounds,
  type SuitInput,
} from '../src/physics/TraversalPhysics';
import { RadioTower } from '../src/infrastructure/RadioTower.ts';
import {
  EvaSuitAvatar,
  CLIMB_SHOULDER_FLEX_RAD,
  CLIMB_ELBOW_FLEX_RAD,
  CLIMB_REACH_AMPLITUDE_RAD,
  CLIMB_REACH_ELBOW_RELIEF_RAD,
  CLIMB_KNEE_HOLD_RAD,
  CLIMB_CYCLE_WAVELENGTH_M,
  climbGripPose,
  climbInwardHeadingRad,
} from '../src/entities/AstronautSuit.ts';
import {
  deckPerimeterClamp,
  DECK_EDGE_RADIUS_M,
  DECK_BOUNDARY_BAND_M,
  HATCH_SECTOR_HALF_ANGLE_RAD,
} from '../src/client/ClientApp.ts';
import {
  CameraRig,
  EVA_LOOK_PITCH_CLAMP_RAD,
  DECK_GUIDEWAY_VIEW_PITCH_RAD,
  evaLookPitchReachable,
} from '../src/engine/CameraRig.ts';

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

// Canonical tower + ladder datum (same oracle the Phase 3 suite uses).
const tower = new RadioTower();
const B: LadderBounds = tower.getLadderBounds();
const NX = B.facingNormal.x;
const NY = B.facingNormal.y;
const DECK_Z = tower.getDeckElevation();

// ---------------------------------------------------------------------------
// Avatar limb access (NullEngine build, nodes named by the avatar prefix).
// ---------------------------------------------------------------------------
function makeAvatar(): EvaSuitAvatar {
  const avatar = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } });
  avatar.init(); // self-owned NullEngine fallback
  return avatar;
}
function pivot(avatar: EvaSuitAvatar, name: string): TransformNode {
  const node = avatar.getScene()?.getNodeByName(name);
  if (!node) throw new Error(`avatar pivot node missing: ${name}`);
  return node as TransformNode;
}
function limbX(avatar: EvaSuitAvatar, name: string): number {
  return pivot(avatar, name).rotation.x;
}
/** One moving climbing frame at ladder rail z (mount snaps x/y/z exactly). */
function climbingAvatar(z: number, forward = 1): EvaSuitAvatar {
  const avatar = makeAvatar();
  if (!avatar.getPhysics().mountLadder(B, z)) throw new Error(`fixture mount(${z}) failed`);
  avatar.update(DT, input({ forward }));
  return avatar;
}

// --- 1. climbing pose engagement --------------------------------------------
console.log('\n[1] Climbing pose engages on locomotionMode === CLIMBING');
{
  const avatar = climbingAvatar(20, 1);
  const s = avatar.getState();
  check('latched step reports CLIMBING + moving', s.locomotionMode === 'CLIMBING'
    && s.ladderLatchActive === true && s.vz === LADDER_CLIMB_SPEED);
  const shL = limbX(avatar, 'eva-shoulder-l');
  const shR = limbX(avatar, 'eva-shoulder-r');
  const elL = limbX(avatar, 'eva-elbow-l');
  const elR = limbX(avatar, 'eva-elbow-r');
  check('both shoulders flexed forward/up (~ -1.1 rad band, always < -0.8)',
    shL < -0.8 && shR < -0.8 &&
    shL <= CLIMB_SHOULDER_FLEX_RAD + CLIMB_REACH_AMPLITUDE_RAD + 1e-12 &&
    shR >= CLIMB_SHOULDER_FLEX_RAD - CLIMB_REACH_AMPLITUDE_RAD - 1e-12,
    `L=${shL.toFixed(3)} R=${shR.toFixed(3)}`);
  check('elbows gripping rungs (~0.85 rad band)',
    elL >= CLIMB_ELBOW_FLEX_RAD - CLIMB_REACH_ELBOW_RELIEF_RAD - 1e-12 &&
    elR >= CLIMB_ELBOW_FLEX_RAD - CLIMB_REACH_ELBOW_RELIEF_RAD - 1e-12 &&
    elL > 0.6 && elR > 0.6,
    `L=${elL.toFixed(3)} R=${elR.toFixed(3)}`);
  // The live nodes must track the pure law for this exact state.
  const pose = climbGripPose(s.climbProgressM ?? 0, s.vz);
  check('live pivots == climbGripPose(climbProgressM, vz) exactly',
    near(shL, pose.shoulderLx, 1e-12) && near(shR, pose.shoulderRx, 1e-12)
    && near(elL, pose.elbowLx, 1e-12) && near(elR, pose.elbowRx, 1e-12)
    && near(limbX(avatar, 'eva-hip-l'), pose.hipLx, 1e-12)
    && near(limbX(avatar, 'eva-hip-r'), pose.hipRx, 1e-12)
    && near(limbX(avatar, 'eva-kneejoint-l'), pose.kneeLx, 1e-12)
    && near(limbX(avatar, 'eva-kneejoint-r'), pose.kneeRx, 1e-12));
  check('grip pose has no roll (arm z parked)',
    pivot(avatar, 'eva-shoulder-l').rotation.z === 0
    && pivot(avatar, 'eva-shoulder-r').rotation.z === 0);
  avatar.dispose();
}
{
  // Regression: the CLIMBING branch must not fire for a surface stride.
  const avatar = makeAvatar();
  let last = avatar.getState();
  // Gentle throttle (≤ 0.6) keeps the stride a walk — a full push launches
  // the Spec 28 bounding loop, which is not what this probe is about.
  for (let i = 0; i < 30; i++) last = avatar.update(DT, input({ forward: 0.5 }));
  const shL = limbX(avatar, 'eva-shoulder-l');
  check('surface walk unaffected (mode WALK, shoulder |x| < 0.5)',
    last.locomotionMode === 'WALK' && Math.abs(shL) < 0.5,
    `mode=${last.locomotionMode} shL=${shL.toFixed(3)}`);
  avatar.dispose();
}

// --- 2. alternating limb cycle clocked by climbProgressM ----------------------
console.log('\n[2] Alternating arms/legs cycle (wavelength 0.70 m = 2 rungs)');
{
  check('cycle wavelength constant = 2 rung pitches (0.70 m)',
    near(CLIMB_CYCLE_WAVELENGTH_M, 0.7, 1e-12));
  // Quarter-cycle point: reach = +sin(π/4) → left arm high, right leg up.
  const pA = CLIMB_CYCLE_WAVELENGTH_M / 8;
  const poseA = climbGripPose(pA, LADDER_CLIMB_SPEED);
  check('phase A: left arm reaches higher than right',
    poseA.shoulderLx < poseA.shoulderRx, `${poseA.shoulderLx} vs ${poseA.shoulderRx}`);
  check('phase A: right leg steps up while left leg stays planted',
    poseA.hipRx < poseA.hipLx && poseA.hipRx < 0 && poseA.hipLx === 0,
    `hipR=${poseA.hipRx} hipL=${poseA.hipLx}`);
  check('phase A: reaching arm straightens (less elbow flex than the gripping one)',
    poseA.elbowLx < poseA.elbowRx);
  check('phase A: lifting knee flexes deeper than the planted one',
    poseA.kneeRx > poseA.kneeLx);
  // Half-wavelength later: every left/right relation flips.
  const pB = pA + CLIMB_CYCLE_WAVELENGTH_M / 2; // +0.35 m = one rung
  const poseB = climbGripPose(pB, LADDER_CLIMB_SPEED);
  check('phase B (+0.35 m): right arm reaches higher than left',
    poseB.shoulderLx > poseB.shoulderRx, `${poseB.shoulderLx} vs ${poseB.shoulderRx}`);
  check('phase B: left leg steps up while right leg stays planted',
    poseB.hipLx < poseB.hipRx && poseB.hipLx < 0 && poseB.hipRx === 0);
  check('arm/leg cross-body coupling holds at every sampled progress '
    + '(left-arm-high ⇔ right-leg-up: (shL−shR)·(hipR−hipL) > 0)',
    Array.from({ length: 64 }, (_, i) => i / 64 * CLIMB_CYCLE_WAVELENGTH_M).every((p) => {
      const q = climbGripPose(p, 2.2);
      const arms = q.shoulderLx - q.shoulderRx;
      const legs = q.hipRx - q.hipLx;
      return arms === 0 || legs === 0 ? arms * legs >= 0 : arms * legs > 0;
    }));
  check('full cycle (progress + 0.70 m) returns the identical pose',
    (() => {
      const q1 = climbGripPose(pA + CLIMB_CYCLE_WAVELENGTH_M, 2.2);
      const q0 = climbGripPose(pA, 2.2);
      return Object.keys(q0).every(
        (k) => typeof q0[k as keyof typeof q0] === typeof q1[k as keyof typeof q1]
          ? (typeof q0[k as keyof typeof q0] === 'number'
            ? near(q0[k as keyof typeof q0] as number, q1[k as keyof typeof q1] as number, 1e-9)
            : q0[k as keyof typeof q0] === q1[k as keyof typeof q1])
          : false,
      );
    })());
  check('deterministic: same progress twice → byte-identical pose law',
    JSON.stringify(climbGripPose(13.37, 2.2)) === JSON.stringify(climbGripPose(13.37, 2.2)));
  // Live avatars one rung apart must show mirrored shoulder relation.
  const aA = climbingAvatar(5.0, 1);
  const aB = climbingAvatar(5.35, 1);
  const relA = limbX(aA, 'eva-shoulder-l') - limbX(aA, 'eva-shoulder-r');
  const relB = limbX(aB, 'eva-shoulder-l') - limbX(aB, 'eva-shoulder-r');
  check('live: avatars 0.35 m apart climb in opposite phase (relA·relB < 0)',
    relA * relB < 0, `relA=${relA.toFixed(4)} relB=${relB.toFixed(4)}`);
  aA.dispose();
  aB.dispose();
}

// --- 3. mechanical hold (vz === 0): frozen jitter-free grip --------------------
console.log('\n[3] Mechanical hold: vz = 0 → stable, jitter-free grip pose');
{
  const avatar = makeAvatar();
  avatar.getPhysics().mountLadder(B, 20);
  let s = avatar.getState();
  s = avatar.update(DT, IDLE_SUIT_INPUT);
  check('hold frame: CLIMBING, vz = 0 exactly', s.locomotionMode === 'CLIMBING' && s.vz === 0);
  const first = ['eva-shoulder-l', 'eva-shoulder-r', 'eva-elbow-l', 'eva-elbow-r',
    'eva-hip-l', 'eva-hip-r', 'eva-kneejoint-l', 'eva-kneejoint-r'].map((n) => limbX(avatar, n));
  for (let i = 0; i < 300; i++) s = avatar.update(DT, IDLE_SUIT_INPUT);
  const last = ['eva-shoulder-l', 'eva-shoulder-r', 'eva-elbow-l', 'eva-elbow-r',
    'eva-hip-l', 'eva-hip-r', 'eva-kneejoint-l', 'eva-kneejoint-r'].map((n) => limbX(avatar, n));
  check('300 idle frames (5 s): all eight limb pivots bit-identical, zero jitter',
    first.every((v, i) => v === last[i]),
    JSON.stringify({ first: first.map((v) => v.toFixed(6)), last: last.map((v) => v.toFixed(6)) }));
  check('hold equals the canonical grip law (climbGripPose(_, 0))',
    last[0] === CLIMB_SHOULDER_FLEX_RAD && last[1] === CLIMB_SHOULDER_FLEX_RAD
    && last[2] === CLIMB_ELBOW_FLEX_RAD && last[3] === CLIMB_ELBOW_FLEX_RAD
    && last[4] === 0 && last[5] === 0
    && last[6] === CLIMB_KNEE_HOLD_RAD && last[7] === CLIMB_KNEE_HOLD_RAD);
  const hold = climbGripPose(999, 0);
  check('canonical hold law ignores progress entirely (no time term)',
    hold.moving === false
    && JSON.stringify(hold) === JSON.stringify(climbGripPose(-42, 0)));
  // Resuming the climb re-engages the alternating stroke.
  s = avatar.update(DT, input({ forward: 1 }));
  const resumeShL = limbX(avatar, 'eva-shoulder-l');
  const resumeShR = limbX(avatar, 'eva-shoulder-r');
  check('climb input re-engages the alternating stroke (not the hold pose)',
    s.vz === LADDER_CLIMB_SPEED
    && (resumeShL - resumeShR !== 0 || climbGripPose(s.climbProgressM ?? 0, s.vz).moving === true));
  avatar.dispose();
}

// --- 4. inward facing heading ---------------------------------------------------
console.log('\n[4] Inward facing: avatar turns to the ladder rungs on latch');
{
  const h = climbInwardHeadingRad({ x: NX, y: NY });
  const dirX = Math.cos(h);
  const dirY = Math.sin(h);
  const dot = dirX * NX + dirY * NY;
  check('heading opposes the ladder facingNormal (dot = −1)', near(dot, -1, 1e-12));
  const cross = dirX * NY - dirY * NX;
  check('heading is collinear with the normal line (cross = 0)', near(cross, 0, 1e-12));
  // Canonical tower: normal points south-east (−45°) → face north-west (+135°).
  check('canonical tower faces NW (+135°) from the SE ladder',
    near(h, (3 * Math.PI) / 4, 1e-12), `h=${h.toFixed(6)}`);
  check('degenerate normals fall back to 0 (zero vector / NaN)',
    climbInwardHeadingRad({ x: 0, y: 0 }) === 0
    && climbInwardHeadingRad({ x: NaN, y: 1 }) === 0);
  // Behaviour: heading applied via setState lands on the avatar root yaw
  // with the shared PI/2 + heading mapping the mesh/camera use.
  const avatar = makeAvatar();
  avatar.setState({ heading: h });
  const root = avatar.getRootNode();
  check('avatar root yaw = PI/2 + inward heading (shared frame mapping)',
    root !== null && near(root.rotation.y, Math.PI / 2 + h, 1e-12));
  avatar.dispose();
  // Wiring: ClientApp applies the inward heading on BOTH mount paths.
  const srcPath = [
    path.resolve(process.cwd(), 'src/client/ClientApp.ts'),
    path.resolve(__dirname ?? '.', '../src/client/ClientApp.ts'),
  ].find((p) => fs.existsSync(p));
  if (srcPath === undefined) throw new Error('ClientApp.ts source not found for wiring check');
  const src = fs.readFileSync(srcPath, 'utf8');
  const mountHeadingCalls =
    (src.match(/setState\(\{ heading: climbInwardHeadingRad/g) ?? []).length;
  check('ClientApp mounts set heading via climbInwardHeadingRad (both mount branches)',
    mountHeadingCalls >= 2, `calls=${mountHeadingCalls}`);
}

// --- 5. deck perimeter clamping + hatch pass-through ------------------------------
console.log('\n[5] Observation-deck railing: r ≤ 2.5 m clamp, hatch sector opens');
{
  check('constants: edge 2.5 m, band 0.5 m (deck 48 → z gate 47.5), hatch half-sector 0.35 rad',
    DECK_EDGE_RADIUS_M === 2.5 && DECK_BOUNDARY_BAND_M === 0.5
    && near(HATCH_SECTOR_HALF_ANGLE_RAD, 0.35, 1e-12));
  const seat = { x: -1550, y: 2320, z: 0 };
  const ladderAngle = Math.atan2(NY, NX); // canonical: −45° (SE)
  const DECK_EDGE_Z = 48.0;
  const minZ = DECK_EDGE_Z - DECK_BOUNDARY_BAND_M; // 47.5
  const at = (angleRad: number, r: number, z: number) => ({
    x: seat.x + Math.cos(angleRad) * r,
    y: seat.y + Math.sin(angleRad) * r,
    z,
  });
  // Inside the deck: untouched.
  const inside = at(ladderAngle + 2.0, 2.4, DECK_EDGE_Z);
  const rInside = deckPerimeterClamp(inside, seat, tower.getLadderBounds().facingNormal, { minZ });
  check('point inside r=2.4 on deck passes untouched',
    rInside.clamped === false && near(rInside.x, inside.x, 1e-12) && near(rInside.y, inside.y, 1e-12));
  // Outside, opposite the ladder: railed back to exactly 2.5 m.
  const over = at(ladderAngle + Math.PI, 3.4, DECK_EDGE_Z);
  const rOver = deckPerimeterClamp(over, seat, tower.getLadderBounds().facingNormal, { minZ });
  const rOut = Math.hypot(rOver.x - seat.x, rOver.y - seat.y);
  check('outside railing opposite the ladder → clamped to r = 2.50 exactly',
    rOver.clamped === true && near(rOut, DECK_EDGE_RADIUS_M, 1e-12), `r=${rOut.toFixed(6)}`);
  const overCross = Math.atan2(rOver.y - seat.y, rOver.x - seat.x);
  check('clamp slides along the radial ray (angle preserved)',
    near(overCross, ((ladderAngle + Math.PI + 3 * Math.PI) % (2 * Math.PI)) - Math.PI, 1e-9)
    || near(Math.abs(overCross - (ladderAngle + Math.PI)), 0, 1e-9)
    || near(Math.abs(overCross - (ladderAngle + Math.PI) + 2 * Math.PI), 0, 1e-9)
    || near(Math.abs(overCross - (ladderAngle + Math.PI) - 2 * Math.PI), 0, 1e-9));
  // Hatch sector: the railing gap.
  for (const dA of [0, 0.2, -0.2, 0.35, -0.35]) {
    const p = at(ladderAngle + dA, 3.2, DECK_EDGE_Z);
    const rHatch = deckPerimeterClamp(p, seat, tower.getLadderBounds().facingNormal, { minZ });
    check(`hatch sector Δangle ${dA >= 0 ? '+' : ''}${dA} rad passes through unclamped`,
      rHatch.clamped === false && near(rHatch.x, p.x, 1e-12));
  }
  for (const dA of [0.5, -0.5, Math.PI, -Math.PI]) {
    const p = at(ladderAngle + dA, 3.2, DECK_EDGE_Z);
    const rRail = deckPerimeterClamp(p, seat, tower.getLadderBounds().facingNormal, { minZ });
    check(`sector ${dA >= 0 ? '+' : ''}${dA} rad outside the hatch is railed`,
      rRail.clamped === true);
  }
  // Elevation gate: below the band the regolith owns the body.
  const below = at(ladderAngle + Math.PI, 3.2, DECK_EDGE_Z - DECK_BOUNDARY_BAND_M - 0.1);
  const rBelow = deckPerimeterClamp(below, seat, tower.getLadderBounds().facingNormal, { minZ });
  check('below the 47.5 m band no railing applies (fall continues)',
    rBelow.clamped === false && near(rBelow.x, below.x, 1e-12));
  // Exact band edge (47.5) is still watched.
  const bandEdge = at(ladderAngle + Math.PI, 3.2, minZ);
  check('z exactly at the 47.5 m band edge is still railed',
    deckPerimeterClamp(bandEdge, seat, tower.getLadderBounds().facingNormal, { minZ }).clamped === true);
  // Degenerate inputs never throw and never move.
  const nanRes = deckPerimeterClamp({ x: NaN, y: 0, z: 48 }, seat, { x: 0, y: 0 }, { minZ });
  check('NaN position / zero normal handled (no clamp, no throw)',
    nanRes.clamped === false);
  // Walk-the-edge simulation: every outward step at any heading lands on deck.
  let worstR = 0;
  for (let i = 0; i < 72; i++) {
    const angle = ladderAngle + (i / 72) * 2 * Math.PI;
    let p = at(angle, 2.0, DECK_EDGE_Z);
    for (let k = 0; k < 20; k++) {
      p = {
        x: p.x + Math.cos(angle) * 0.12, // strafe straight outward
        y: p.y + Math.sin(angle) * 0.12,
        z: DECK_EDGE_Z,
      };
      const fixed = deckPerimeterClamp(p, seat, tower.getLadderBounds().facingNormal, { minZ });
      p = { x: fixed.x, y: fixed.y, z: DECK_EDGE_Z };
      const r = Math.hypot(p.x - seat.x, p.y - seat.y);
      const inHatch = Math.abs((angle - ladderAngle + 3 * Math.PI) % (2 * Math.PI) - Math.PI)
        <= HATCH_SECTOR_HALF_ANGLE_RAD;
      if (!inHatch) worstR = Math.max(worstR, r);
    }
  }
  check(`72-heading outward walk never breaches r=2.5 outside the hatch (worst ${worstR.toFixed(9)} ≤ 2.5)`,
    worstR <= DECK_EDGE_RADIUS_M + 1e-12);
}

// --- 6. camera pitch coverage -----------------------------------------------------
console.log('\n[6] Camera look-pitch freedom: −50° guideway down, spire/sky up');
{
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const rig = new CameraRig(scene, { silent: true });
    check('EVA look-pitch band covers the −50.2° guideway view angle',
      evaLookPitchReachable(DECK_GUIDEWAY_VIEW_PITCH_RAD)
      && EVA_LOOK_PITCH_CLAMP_RAD >= Math.abs(DECK_GUIDEWAY_VIEW_PITCH_RAD)
      && near(DECK_GUIDEWAY_VIEW_PITCH_RAD, (-50.2 * Math.PI) / 180, 1e-12));
    // Up-look: spire tip (52 m) seen from the climber rail near deck level.
    const spirePitch = Math.atan2(52 - 47.5, 1.7); // ≈ +1.30 rad
    check('up-look along the spire (≈ +69°) reachable inside the band',
      evaLookPitchReachable(spirePitch), `spire=${spirePitch.toFixed(4)}`);
    const deckPos = { x: -1550, y: 2320, z: DECK_Z };
    // Drive first-person: −50.2° goal must land on the camera (rotation.x is
    // the negated physics pitch in Babylon's y-up frame).
    for (let i = 0; i < 300; i++) rig.update(deckPos, 0, DT, DECK_GUIDEWAY_VIEW_PITCH_RAD);
    const downX = (rig.getActiveCamera() as UniversalCamera).rotation.x;
    check('first-person settles at exactly −50.2° down (rotation.x = +0.8757)',
      near(downX, -DECK_GUIDEWAY_VIEW_PITCH_RAD, 1e-6), `rotation.x=${downX.toFixed(7)}`);
    // Swing past level up to the spire.
    for (let i = 0; i < 300; i++) rig.update(deckPos, 0, DT, spirePitch);
    const upX = (rig.getActiveCamera() as UniversalCamera).rotation.x;
    check('camera swings up to the spire pitch (no clamp bite short of target)',
      near(upX, -spirePitch, 1e-6), `rotation.x=${upX.toFixed(7)}`);
    // Beyond the band the goal clamps at ±77.3° — no further, no NaN.
    for (let i = 0; i < 300; i++) rig.update(deckPos, 0, DT, -1.5);
    const hardX = (rig.getActiveCamera() as UniversalCamera).rotation.x;
    check('over-range −1.5 rad clamps at exactly the band edge (−77.3°)',
      near(hardX, EVA_LOOK_PITCH_CLAMP_RAD, 1e-6), `rotation.x=${hardX.toFixed(7)}`);
    // Third-person third-person arc keeps its own framing (no regression).
    rig.setMode('eva_third_person');
    for (let i = 0; i < 120; i++) rig.update(deckPos, 0.5, DT, DECK_GUIDEWAY_VIEW_PITCH_RAD);
    const tp = rig.getActiveCamera();
    check('third-person arc active and finite after the pitch sweeps',
      rig.getMode() === 'eva_third_person' && Number.isFinite(tp.globalPosition.y));
    rig.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
}

// --- summary -------------------------------------------------------------------------
console.log(`\n${failures.length === 0 ? `ALL ${passed} CHECKS PASSED` : `${failures.length} FAILURES of ${passed + failures.length}: ${failures.join(', ')}`}`);
process.exitCode = failures.length === 0 ? 0 : 1;
