/**
 * Spec 32 Phase 6 — acceptance smoke suite: locomotion acrobatics, wayfinding
 * & true 3D rover ballistics.
 *
 * Runs fully headless under `npx tsx scripts/smoke-acrobatics-nav-ballistics.ts`
 * (exit 0 == all green). One shared `NullEngine`; no DOM beyond the minimal
 * fake the HUD harness needs; no network, no audio device.
 *
 * Contract gates (Spec 32 §4):
 *   GATE 1  Forward anatomical elbow flexion — rest/stride/sprint/pump/climb
 *           pose laws swept across 1000 phases; every elbow channel strictly
 *           negative (θ < 0 ⇔ z′ > 0 toward visor/chest), zero backward
 *           hyperextension anywhere.
 *   GATE 2  Mid-air fluid leg tuck (Spec 35 rectification) — tuck envelope
 *           (torso 0.22 rad, hips −1.20, knees 1.80, elbows −1.35), strict
 *           zero root flip (flipPitchRad ≡ 0 — the Spec 32 360° somersault
 *           is removed), quintic W_tuck(u) fold/glide/unfold shape, plus the
 *           TraversalPhysics `acrobaticRoll` wiring. Full Spec 35 acceptance
 *           lives in smoke-spec35-airborne-tuck.ts.
 *   GATE 3  PLSS cold-gas jump boost — airborne rising-edge re-tap applies
 *           az = +2.8 m/s² and afwd = +1.5 m/s² (differenced against a
 *           control run to the last bit), O₂ drawn at exactly
 *           SUIT_O2_RCS_BOOST = 12.0 units/s, valve cuts at O₂ = 0 / release
 *           / touchdown, twin plume + thruster-hiss FX fire on the edge.
 *   GATE 4  Clockwise compass & POI nav — right turn from W(270°) steps
 *           W→NW→N→NE→E, Citadel (−1850, 2400) and Radio Tower (−1550, 2320)
 *           pins carry exact wrap360(90+θ) bearings + live distance, fuzzy
 *           setNavTarget/clear semantics, gold ▼ chevron pin render/hide.
 *   GATE 5  Untethered rover ballistics — 25° crater-lip launch catches
 *           s.z > z_floor + 0.5 m with > 1.0 s hangtime, rim exits preserve
 *           horizontal momentum under ballistic lunar-g descent, zero
 *           ground/nose penetration on steep approaches, road wheels hang at
 *           maximum droop travel while airborne.
 */
import assert from 'node:assert';

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';

import { ClientApp, NAV_POI_DIRECTORY } from '../src/client/ClientApp.ts';
import LunarHUD from '../src/ui/LunarHUD.ts';
import {
  ELBOW_REST_RAD,
  HURRY_ARM_ELBOW_FWD_FLEX_RAD,
  HURRY_ARM_ELBOW_AFT_FLEX_RAD,
  HURRY_PUMP_ELBOW_STANCE_RAD,
  HURRY_PUMP_ELBOW_RECOVERY_RAD,
  CLIMB_ELBOW_FLEX_RAD,
  CLIMB_REACH_ELBOW_RELIEF_RAD,
  TUCK_TORSO_PITCH_RAD,
  TUCK_HIP_FLEXION_RAD,
  TUCK_KNEE_FLEXION_RAD,
  TUCK_ELBOW_FLEXION_RAD,
  TUCK_RAMP_IN_START_U,
  TUCK_RAMP_OUT_END_U,
  acrobaticTuckPose,
  acrobaticTuckEnvelope,
  climbGripPose,
  hurryStridePose,
} from '../src/entities/AstronautSuit.ts';
import { OpenBuggy } from '../src/entities/OpenBuggy.ts';
import {
  BUGGY_SEAT_BELOW_DATUM,
  BUGGY_SPRING_TRAVEL,
  IDLE_BUGGY_INPUT,
  IDLE_SUIT_INPUT,
  LUNAR_GRAVITY,
  SUIT_O2_RCS_BOOST,
  SUIT_RCS_BOOST_FWD_ACCEL,
  SUIT_RCS_BOOST_UP_ACCEL,
  SUIT_SOFT_LANDING_VY,
  LunarBuggy,
  LunarEvaSuit,
  type BuggyState,
  type GroundElevationFn,
} from '../src/physics/TraversalPhysics.ts';

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  \u2714 ${label}`);
  } else {
    failures.push(label);
    console.error(`  \u2718 ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}

const wrap360 = (d: number): number => ((d % 360) + 360) % 360;
const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;
const PI = Math.PI;

/** Forearm-forward displacement z′ = −h·sin θ (Blueprint 32 §2.1, h = 0.30 m). */
const FORWARD = 0.3;
const forwardZ = (thetaRad: number): number => -FORWARD * Math.sin(thetaRad);

// Shared NullEngine — one for every Babylon surface in this process.
const engine = new NullEngine();

// ---------------------------------------------------------------------------
// Minimal fake DOM (same subset smoke-spec32-nav.ts / smoke-client-app.ts use)
// ---------------------------------------------------------------------------

interface FakeEl {
  id: string;
  className: string;
  textContent: string | null;
  style: Record<string, string>;
  classList: { add(n: string): void; remove(n: string): void; contains(n: string): boolean };
  children: FakeEl[];
  parent: FakeEl | null;
  appendChild<T extends FakeEl>(c: T): T;
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  addEventListener(): void;
  removeEventListener(): void;
  remove(): void;
  text(): string;
}

function fakeEl(reg: Map<string, FakeEl>): FakeEl {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  let own = '';
  const el: FakeEl = {
    id: '',
    className: '',
    get textContent() {
      return own;
    },
    set textContent(v: string | null) {
      own = v ?? '';
      el.children.length = 0;
    },
    style: {},
    classList: {
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
      contains: (n) => classes.has(n),
    },
    children: [],
    parent: null,
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    getAttribute: (n) => attrs.get(n) ?? null,
    setAttribute(n, v) {
      attrs.set(n, v);
      if (n === 'id') {
        el.id = v;
        reg.set(v, el);
      }
    },
    addEventListener() {},
    removeEventListener() {},
    remove() {
      if (el.parent !== null) {
        const i = el.parent.children.indexOf(el);
        if (i >= 0) el.parent.children.splice(i, 1);
        el.parent = null;
      }
    },
    text() {
      return own + el.children.map((c) => c.text()).join('');
    },
  };
  return el;
}

function fakeDoc(): {
  body: FakeEl;
  createElement: () => FakeEl;
  getElementById: (id: string) => FakeEl | null;
} {
  const reg = new Map<string, FakeEl>();
  const body = fakeEl(reg);
  return {
    body,
    createElement: () => fakeEl(reg),
    getElementById: (id: string) => reg.get(id) ?? null,
  };
}

// ===========================================================================
// GATE 1 — Forward anatomical elbow flexion (Spec 32 §2.1 / §4)
// ===========================================================================
section('GATE 1a — elbow law constants carry Spec 32 signs (θ < 0 = forward)');
{
  check('ELBOW_REST_RAD = -0.18', ELBOW_REST_RAD === -0.18, `${ELBOW_REST_RAD}`);
  check('HURRY_ARM_ELBOW_FWD_FLEX_RAD = -0.50', HURRY_ARM_ELBOW_FWD_FLEX_RAD === -0.5);
  check('HURRY_ARM_ELBOW_AFT_FLEX_RAD = -0.25', HURRY_ARM_ELBOW_AFT_FLEX_RAD === -0.25);
  check('HURRY_PUMP_ELBOW_STANCE_RAD = -0.50', HURRY_PUMP_ELBOW_STANCE_RAD === -0.5);
  check('HURRY_PUMP_ELBOW_RECOVERY_RAD = -0.40', HURRY_PUMP_ELBOW_RECOVERY_RAD === -0.4);
  check('CLIMB_ELBOW_FLEX_RAD = -0.85', CLIMB_ELBOW_FLEX_RAD === -0.85);
  check('CLIMB_REACH_ELBOW_RELIEF_RAD = -0.20', CLIMB_REACH_ELBOW_RELIEF_RAD === -0.2);
}

section('GATE 1b — 1000-phase sweep: rest / stride / sprint / pump / climb elbows all negative');
{
  let minElbow = Number.POSITIVE_INFINITY;
  let maxElbow = Number.NEGATIVE_INFINITY;
  let minForwardZ = Number.POSITIVE_INFINITY;
  let bad = 0;
  let samples = 0;
  const eat = (label: string, theta: number): void => {
    samples++;
    if (!(theta < 0)) bad++;
    if (!Number.isFinite(theta) || forwardZ(theta) <= 0) bad++;
    minElbow = Math.min(minElbow, theta);
    maxElbow = Math.max(maxElbow, theta);
    minForwardZ = Math.min(minForwardZ, forwardZ(theta));
    void label;
  };

  for (let i = 0; i < 1000; i++) {
    const u = i / 1000;
    // Rest / grounded brace stride frame (both stance legs), low speed.
    for (const leg of ['left', 'right'] as const) {
      const rest = hurryStridePose(leg, false, 0, 0);
      eat('rest', rest.elbowLx);
      eat('rest', rest.elbowRx);
      const stride = hurryStridePose(leg, false, u, 2.6);
      eat('stride', stride.elbowLx);
      eat('stride', stride.elbowRx);
      // Sprint / pump flight frame (Olympic triple-jump cycle, live phase).
      const sprint = hurryStridePose(leg, true, u, 5.2);
      eat('sprint/pump', sprint.elbowLx);
      eat('sprint/pump', sprint.elbowRx);
      // Acrobatic tuck overlay over the same flight cycle.
      const acro = hurryStridePose(leg, true, u, 5.2, true);
      eat('acro-overlay', acro.elbowLx);
      eat('acro-overlay', acro.elbowRx);
    }
    // Climb grip cycle: ascending, descending, and the frozen hold.
    const up = climbGripPose(u * 14.0, 2.2);
    eat('climb-up', up.elbowLx);
    eat('climb-up', up.elbowRx);
    const down = climbGripPose(u * 14.0, -2.2);
    eat('climb-down', down.elbowLx);
    eat('climb-down', down.elbowRx);
    const hold = climbGripPose(u * 14.0, 0);
    eat('climb-hold', hold.elbowLx);
    eat('climb-hold', hold.elbowRx);
  }
  check(`22 000 elbow samples across 1000 phases, all strictly θ < 0 (bad=${bad})`,
    bad === 0 && samples === 22000, `samples=${samples}`);
  check(`no sample reaches 0 rad — zero backward hyperextension (max θ = ${maxElbow.toFixed(4)})`,
    maxElbow < 0);
  check(`forearm z′ = −h·sin θ > 0 for every sample (min z′ = ${minForwardZ.toFixed(4)} m)`,
    minForwardZ > 0);
  check(`sweep range inside anatomical envelope [−1.35, −0.18] ⊇ [${minElbow.toFixed(2)}, ${maxElbow.toFixed(2)}]`,
    minElbow >= TUCK_ELBOW_FLEXION_RAD - 1e-12 && maxElbow <= ELBOW_REST_RAD + 1e-12);
}

// ===========================================================================
// GATE 2 — Mid-air fluid leg tuck (Spec 35 §2 rectification of Spec 32 §2.2)
// ===========================================================================
section('GATE 2a — acrobaticTuckPose envelope at full tuck (Spec 35 constants)');
{
  const mid = acrobaticTuckPose(0.5);
  check('full tuck blend w = 1 mid-window', mid.tuckBlend === 1);
  check(`torso pitch ≈ 0.22 rad (${mid.torsoPitchRad})`, near(mid.torsoPitchRad, 0.22, 1e-12));
  check(`bilateral hips ≈ -1.20 rad (${mid.hipLx}/${mid.hipRx})`,
    near(mid.hipLx, -1.2, 1e-12) && near(mid.hipRx, -1.2, 1e-12));
  check(`bilateral knees ≈ 1.80 rad (${mid.kneeLx}/${mid.kneeRx})`,
    near(mid.kneeLx, 1.8, 1e-12) && near(mid.kneeRx, 1.8, 1e-12));
  check(`bilateral elbows ≈ -1.35 rad (${mid.elbowLx}/${mid.elbowRx})`,
    near(mid.elbowLx, -1.35, 1e-12) && near(mid.elbowRx, -1.35, 1e-12));
  check('bilateral hip/knee tuck magnitude > 1.2 rad (gate §4)',
    Math.abs(mid.hipLx) >= 1.2 && mid.kneeLx >= 1.2);
  check('constants: TUCK_TORSO 0.22 / HIP -1.20 / KNEE 1.80 / ELBOW -1.35',
    TUCK_TORSO_PITCH_RAD === 0.22 && TUCK_HIP_FLEXION_RAD === -1.2 &&
      TUCK_KNEE_FLEXION_RAD === 1.8 && TUCK_ELBOW_FLEXION_RAD === -1.35);

  // Overlay inside the live triple-jump stride law.
  const ov = hurryStridePose('left', true, 0.5, 5.2, true);
  check('stride-law acrobatic overlay lands on the tuck envelope at u = 0.5',
    near(ov.elbowLx, -1.35, 1e-12) && near(ov.hipLx, -1.2, 1e-12) &&
      near(ov.kneeLx, 1.8, 1e-12));
}

section('GATE 2b — strict-zero root flip + quintic W_tuck fold/glide/unfold (Spec 35 §2.1/§2.2)');
{
  // Spec 35 rectification: the 360° root somersault is eliminated — the pose
  // root flip channel is STRICT ZERO under all conditions.
  let flipBad = 0;
  for (let i = 0; i <= 1000; i++) {
    const u = i / 1000;
    if (acrobaticTuckPose(u).flipPitchRad !== 0) flipBad++;
    if (hurryStridePose('left', true, u, 5.2, true).flipPitchRad !== 0) flipBad++;
    if (hurryStridePose('right', true, u, 5.2, false).flipPitchRad !== 0) flipBad++;
  }
  check('flipPitchRad === 0 across 3000 pose samples — no somersault channel (bad=' + flipBad + ')',
    flipBad === 0);

  // Quintic W_tuck(u): silent before fold-in, full glide through mid-arc,
  // cleared for the landing handoff from u ≥ 0.90.
  check(`fold-in window starts at u = ${TUCK_RAMP_IN_START_U} and unfold clears by u = ${TUCK_RAMP_OUT_END_U}`,
    TUCK_RAMP_IN_START_U === 0.15 && TUCK_RAMP_OUT_END_U === 0.9);
  check('no tuck before fold-in (W(0) = W(0.15) = 0)',
    acrobaticTuckEnvelope(0) === 0 && acrobaticTuckEnvelope(0.15) === 0);
  check('aerodynamic glide holds W = 1 across u ∈ [0.30, 0.70]',
    acrobaticTuckEnvelope(0.3) === 1 && acrobaticTuckEnvelope(0.5) === 1 &&
      acrobaticTuckEnvelope(0.7) === 1);
  check('smooth unfold mid-ramp (W(0.8) = 0.5 quintic midpoint)',
    near(acrobaticTuckEnvelope(0.8), 0.5, 1e-12));
  check('cleared for landing handoff (W(0.9) = W(0.95) = W(1) = 0)',
    acrobaticTuckEnvelope(0.9) === 0 && acrobaticTuckEnvelope(0.95) === 0 &&
      acrobaticTuckEnvelope(1) === 0);
  // Boundary continuity at the seams (lag ≪ ε/slope per skill #40; seams sit
  // at zero-slope points of the quintic smoothstep).
  let seamOk = true;
  for (const seam of [0.15, 0.3, 0.7, 0.9]) {
    const w0 = acrobaticTuckEnvelope(seam);
    if (!near(acrobaticTuckEnvelope(seam + 1e-9), w0, 1e-6)) seamOk = false;
    if (!near(acrobaticTuckEnvelope(seam - 1e-9), w0, 1e-6)) seamOk = false;
  }
  check('W_tuck continuous at all four seams (lag 1e-9)', seamOk);
  const land = acrobaticTuckPose(1);
  check('landing frame returns elbows to the neutral forward hang',
    near(land.elbowLx, ELBOW_REST_RAD, 1e-12) && near(land.torsoPitchRad, 0, 1e-12));
}

section('GATE 2c — TraversalPhysics acrobaticRoll wiring over real bounding arcs');
{
  const suit = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true, oxygen: 100 });
  const dt = 1 / 60;
  let airborneFrames = 0;
  let rollMirrored = 0;
  let inFlipWindow = 0;
  let phaseBad = 0;
  for (let i = 0; i < 1500; i++) {
    const s = suit.step(dt, { ...IDLE_SUIT_INPUT, forward: 1, sprint: true, acrobaticRoll: true });
    if (!s.isGrounded) {
      airborneFrames++;
      if (s.acrobaticRoll === true) rollMirrored++;
      const u = s.hurryAirPhase ?? 0;
      if (u >= TUCK_RAMP_IN_START_U && u <= TUCK_RAMP_OUT_END_U) inFlipWindow++;
      if (u < 0 || u > 1.0000001) phaseBad++;
    }
  }
  check('bounding flight arcs observed (sprint engaged Steelpush bounds)', airborneFrames > 300,
    `airborne frames=${airborneFrames}`);
  check('acrobaticRoll input mirrored on every airborne frame',
    rollMirrored === airborneFrames, `${rollMirrored}/${airborneFrames}`);
  check('live flight phase crosses the tuck window [0.15, 0.90]', inFlipWindow > 100,
    `window frames=${inFlipWindow}`);
  check('hurryAirPhase stays inside [0, 1]', phaseBad === 0);
}

// ===========================================================================
// GATE 3 — PLSS cold-gas RCS jump boost & O₂ depletion (Spec 32 §2.3 / §4)
// ===========================================================================
section('GATE 3a — boost constants & rising-edge arming discipline');
{
  check('SUIT_RCS_BOOST_UP_ACCEL = 2.8 m/s²', SUIT_RCS_BOOST_UP_ACCEL === 2.8);
  check('SUIT_RCS_BOOST_FWD_ACCEL = 1.5 m/s²', SUIT_RCS_BOOST_FWD_ACCEL === 1.5);
  check('SUIT_O2_RCS_BOOST = 12.0 units/s', SUIT_O2_RCS_BOOST === 12.0);

  // A ground hop holding the button through the arc must NEVER steal the
  // airborne RCS channel (skill #48).
  const hopper = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true, oxygen: 100 });
  let boostOnHeldHop = false;
  let everAirborne = false;
  for (let i = 0; i < 180; i++) {
    const s = hopper.step(1 / 60, { ...IDLE_SUIT_INPUT, jump: true });
    if (s.rcsBoostActive) boostOnHeldHop = true;
    if (!s.isGrounded) everAirborne = true;
  }
  check('ground hop really left the deck', everAirborne);
  check('held ground-hop never ignites the airborne RCS boost', !boostOnHeldHop);
}

section('GATE 3b — mid-air re-tap impulse: az = 2.8, afwd = 1.5 m/s² (differenced vs control)');
{
  const dt = 1 / 60;
  const mk = (): LunarEvaSuit =>
    new LunarEvaSuit({ x: 0, y: 0, z: 10, vz: 0, isGrounded: false, oxygen: 100, heading: 0 });

  // One boost frame vs one idle frame from identical states: differencing
  // removes lunar gravity and every shared term, isolating the RCS delta.
  const boost = mk();
  const ctrl = mk();
  const b0 = boost.getState();
  const c0 = ctrl.getState();
  const bs = boost.step(dt, { ...IDLE_SUIT_INPUT, jump: true });
  const cs = ctrl.step(dt, { ...IDLE_SUIT_INPUT });
  check('boost engaged on the airborne rising edge', bs.rcsBoostActive === true &&
    !cs.rcsBoostActive);
  const dvz = (bs.vz - b0.vz) - (cs.vz - c0.vz);
  const dvx = (bs.vx - b0.vx) - (cs.vx - c0.vx);
  check(`vertical impulse Δaz = 2.8·dt exactly (${dvz.toFixed(12)} vs ${(2.8 * dt).toFixed(12)})`,
    near(dvz, SUIT_RCS_BOOST_UP_ACCEL * dt, 1e-12));
  check(`forward impulse Δafwd = 1.5·dt along heading (${dvx.toFixed(12)} vs ${(1.5 * dt).toFixed(12)})`,
    near(dvx, SUIT_RCS_BOOST_FWD_ACCEL * dt, 1e-12));

  // Sustained hold: valve holds while the button is held aloft.
  let held = 0;
  for (let i = 0; i < 30; i++) {
    if (boost.step(dt, { ...IDLE_SUIT_INPUT, jump: true }).rcsBoostActive) held++;
  }
  check('valve stays open across 30 held airborne frames', held === 30);
  check('valve cuts the instant the button lifts',
    boost.step(dt, { ...IDLE_SUIT_INPUT }).rcsBoostActive === false);

  // Descent arrest: firing while plummeting chases the soft-landing rate.
  const dropper = new LunarEvaSuit({ x: 0, y: 0, z: 40, vz: -8, isGrounded: false, oxygen: 100 });
  dropper.step(dt, { ...IDLE_SUIT_INPUT, jump: true });
  let prevVz = -8;
  let rising = true;
  for (let i = 0; i < 30; i++) {
    const s = dropper.step(dt, { ...IDLE_SUIT_INPUT, jump: true });
    if (!(s.vz > prevVz)) rising = false;
    prevVz = s.vz;
  }
  check('descent arrest monotonically cushions a -8 m/s plummet', rising);
  check(`descent rate pulled past the soft-landing floor (${prevVz.toFixed(3)} > ${SUIT_SOFT_LANDING_VY})`,
    prevVz > SUIT_SOFT_LANDING_VY - 1e-9);
}

section('GATE 3c — oxygen draw at exactly SUIT_O2_RCS_BOOST = 12.0 units/s');
{
  const dt = 1 / 60;
  const N = 60; // one second of boost
  const boost = new LunarEvaSuit({ x: 0, y: 0, z: 200, vz: 0.2, isGrounded: false, oxygen: 100 });
  const ctrl = new LunarEvaSuit({ x: 0, y: 0, z: 200, vz: 0.2, isGrounded: false, oxygen: 100 });
  const o2b0 = boost.getState().oxygen;
  const o2c0 = ctrl.getState().oxygen;
  boost.step(dt, { ...IDLE_SUIT_INPUT, jump: true }); // ignite
  ctrl.step(dt, { ...IDLE_SUIT_INPUT });
  const o2b1 = boost.getState().oxygen;
  const o2c1 = ctrl.getState().oxygen;
  check(`first boost frame draws exactly (12.0 + shared baseline)·dt`,
    near(o2c0 - o2c1, (o2b0 - o2b1) - SUIT_O2_RCS_BOOST * dt, 1e-12));
  for (let i = 1; i < N; i++) {
    boost.step(dt, { ...IDLE_SUIT_INPUT, jump: true });
    ctrl.step(dt, { ...IDLE_SUIT_INPUT });
  }
  const dropBoost = o2b0 - boost.getState().oxygen;
  const dropCtrl = o2c0 - ctrl.getState().oxygen;
  const rate = (dropBoost - dropCtrl) / (N * dt);
  check(`differenced O₂ draw over 1 s = ${rate.toFixed(6)} u/s ≈ 12.0 (±0.1)`,
    near(rate, 12.0, 0.1));
  check(`gate §4 threshold ≥ 10 u/s met (${rate.toFixed(2)})`, rate >= 10);
  check(`O₂ actually depleted from the tank (${(o2b0 - boost.getState().oxygen).toFixed(1)} units)`,
    dropBoost > 10);
}

section('GATE 3d — valve cut-outs: O₂ empty, touchdown');
{
  const dt = 1 / 60;
  // Reservoir runs dry mid-burst.
  const suit = new LunarEvaSuit({ x: 0, y: 0, z: 60, vz: 0, isGrounded: false, oxygen: 0.5 });
  suit.step(dt, { ...IDLE_SUIT_INPUT, jump: true });
  let framesToCutoff = 0;
  let active = true;
  for (let i = 0; i < 300; i++) {
    const s = suit.step(dt, { ...IDLE_SUIT_INPUT, jump: true });
    framesToCutoff++;
    active = s.rcsBoostActive;
    if (!active) break;
  }
  check(`boost cuts out when the reservoir hits 0 (after ${framesToCutoff} frames)`,
    active === false && suit.getState().oxygen === 0);
  const vzAtCut = suit.getState().vz;
  suit.step(dt, { ...IDLE_SUIT_INPUT, jump: true });
  const vzAfterCut = suit.getState().vz;
  check('no RCS acceleration is applied after the O₂ cut-out',
    near(vzAfterCut - vzAtCut, -LUNAR_GRAVITY * dt, 1e-12));

  // Touchdown closes the valve even with the button held and gas in reserve.
  const lander = new LunarEvaSuit({ x: 0, y: 0, z: 3, vz: -2, isGrounded: false, oxygen: 100 });
  lander.step(dt, { ...IDLE_SUIT_INPUT, jump: true });
  let activeOnGround = false;
  for (let i = 0; i < 240; i++) {
    const s = lander.step(dt, { ...IDLE_SUIT_INPUT, jump: true });
    if (s.isGrounded && s.rcsBoostActive) activeOnGround = true;
  }
  check('valve never fires again once boots are back on the regolith', !activeOnGround);
}

async function runGate3e(): Promise<void> {
section('GATE 3e — twin PLSS plume + thruster-hiss FX fire on the boost edge');
{
  const doc = fakeDoc();
  const hud = new LunarHUD({ document: doc as unknown as Document });
  const app = new ClientApp({ seed: 'spec32-phase6-fx', autoConnect: false, silent: true, hud });
  await app.init(engine as never);

  const avatar = app.getSuit();
  // Instrument the plume trigger and read the audio cue counter.
  let vents = 0;
  const origVent = avatar.triggerBackpackRcsVent.bind(avatar);
  avatar.triggerBackpackRcsVent = (): number => {
    vents++;
    return origVent();
  };
  const audio = app.getAudio();
  check('audio system present on the client app', audio !== null);
  void audio?.init(); // headless mock graph, synchronous body
  const audio0 = audio?.getRcsThrustCount() ?? 0;

  const pump = (dt: number): void => {
    (app as unknown as { pumpRcsBoostFx(dt: number, s: unknown): void })
      .pumpRcsBoostFx(dt, avatar);
  };

  // Ignition edge: valve open → first frame fires plume + hiss immediately.
  avatar.setState({ rcsBoostActive: true });
  pump(0.016);
  check('plume + hiss fire immediately on the boost ignition frame',
    vents === 1 && (audio?.getRcsThrustCount() ?? 0) === audio0 + 1);

  // Re-arm every 0.22 s while the valve holds.
  const ventsAtFirst = vents;
  pump(0.1);
  pump(0.1);
  check('no re-fire before the 0.22 s plume-lifespan re-arm clock expires',
    vents === ventsAtFirst);
  pump(0.02);
  check('plume re-arms once the clock expires while the valve holds',
    vents === ventsAtFirst + 1);

  // Stand-down parks the clock; the next burst starts flush with the edge.
  avatar.setState({ rcsBoostActive: false });
  pump(1);
  pump(1);
  const ventsAtStand = vents;
  check('FX pump stands down cleanly when the valve closes', vents === ventsAtStand);
  avatar.setState({ rcsBoostActive: true });
  pump(0.016);
  check('next burst fires flush with its own ignition edge', vents === ventsAtStand + 1);

  // Plume port sits at the backpack upper exhaust behind the shoulder line.
  const pos = (avatar as unknown as {
    lastRcsBackpackVentPos?: { x: number; y: number; z: number };
  }).lastRcsBackpackVentPos;
  check('twin-plume emitters record the backpack upper-port coordinates',
    pos !== undefined && Number.isFinite(pos.x) && Number.isFinite(pos.z));

  avatar.dispose();
  app.dispose();
}
}

// ===========================================================================
// GATE 4 — Clockwise compass & POI navigation (Spec 32 §2.4 / §2.6 / §4)
// ===========================================================================
async function runGate4(): Promise<void> {
section('GATE 4a — clockwise compass tape: right turn W → NW → N → NE → E');
{
  const doc = fakeDoc();
  const hud = new LunarHUD({ document: doc as unknown as Document });
  type Capture = { heading: number; nav?: { name: string; bearing: number; dist: number; arrow?: string } };
  const captured: Capture[] = [];
  const realUpdateCompass = hud.updateCompass.bind(hud);
  hud.updateCompass = (h: number, t: Parameters<LunarHUD['updateCompass']>[1] = {}): void => {
    captured.push({ heading: h, nav: t.nav });
    realUpdateCompass(h, t);
  };

  const app = new ClientApp({ seed: 'spec32-phase6-nav', autoConnect: false, silent: true, hud });
  await app.init(engine as never);
  const suit = app.getSuit();
  let now = 200_000;
  const step = (headingRad: number): Capture => {
    suit.setState({ heading: headingRad, vx: 0, vy: 0 });
    now += 100;
    app.update(now);
    return captured[captured.length - 1]!;
  };

  // Physics yaw increases clockwise; azimuth = wrap360(90 + θ). Turning
  // RIGHT from West must read W 270 → NW 315 → N 0 → NE 45 → E 90.
  const seq: Array<[number, number, string]> = [
    [PI, 270, 'W'],
    [PI + PI / 4, 315, 'NW'],
    [PI + PI / 2, 0, 'N'],
    [PI + (3 * PI) / 4, 45, 'NE'],
    [PI + PI, 90, 'E'],
  ];
  const readings: number[] = [];
  for (const [theta, want, label] of seq) {
    const c = step(theta);
    readings.push(c.heading);
    check(`right turn reads ${want}° ${label} (θ = ${((theta * 180) / PI).toFixed(0)}°)`,
      near(wrap360(c.heading - want + 180) - 180, 0, 1e-6), `got ${c.heading}`);
  }
  let clockwise = true;
  for (let i = 1; i < readings.length; i++) {
    if (!near(wrap360(readings[i]! - readings[i - 1]!) - 45, 0, 1e-6)) clockwise = false;
  }
  check('each right turn advances the tape strictly +45° clockwise', clockwise);

  // POI bearings + distances (from the live spawn position).
  const p = suit.getPosition();
  const by = Object.fromEntries(NAV_POI_DIRECTORY.map((q) => [q.id, q]));
  const poiCases = [
    ['citadel', by['citadel']!, 'X-Corp Citadel Monolith'],
    ['tower', by['tower']!, 'Frontier Radio Tower'],
  ] as const;
  for (const [id, poi, name] of poiCases) {
    check(`setNavTarget('${id}') arms the ${name} target`,
      app.setNavTarget(id) === true && app.getNavTarget()?.id === id);
    const c = step(PI); // face West, re-capture the pin payload
    const wantBearing = wrap360(90 + (Math.atan2(poi.position.y - p.y, poi.position.x - p.x) * 180) / PI);
    const wantDist = Math.hypot(poi.position.x - p.x, poi.position.y - p.y);
    check(`${name} pin present while armed`, c.nav !== undefined);
    check(`${name} bearing = wrap360(90 + atan2(Δy, Δx)) = ${wantBearing.toFixed(3)}°`,
      c.nav !== undefined && near(c.nav.bearing, wantBearing, 1e-6),
      c.nav === undefined ? 'missing' : `got ${c.nav.bearing}`);
    check(`${name} distance = ${wantDist.toFixed(1)} m live metres`,
      c.nav !== undefined && near(c.nav.dist, wantDist, 1e-6));
    check(`${name} guidance arrow is one of ◀ ▲ ▶`,
      c.nav !== undefined && ['\u25c0', '\u25b2', '\u25b6'].includes(c.nav.arrow ?? ''));
  }

  // Fuzzy queries + clear semantics.
  const fuzzy: Array<[string, string]> = [
    ['corp', 'citadel'], ['hq', 'citadel'], ['x-corp', 'citadel'], ['monolith', 'citadel'],
    ['radio', 'tower'], ['relay', 'tower'], ['frontier', 'tower'],
    ['gauss', 'accelerator'], ['mass accelerator', 'accelerator'],
    ['landing', 'touchdown'], ['canyon', 'outpost'],
  ];
  let allFuzzy = true;
  for (const [q, want] of fuzzy) {
    if (!(app.setNavTarget(q) && app.getNavTarget()?.id === want)) {
      allFuzzy = false;
      console.error(`    • "${q}" → ${app.getNavTarget()?.id ?? 'null'}, want ${want}`);
    }
  }
  check(`${fuzzy.length} fuzzy queries resolve to the right POI`, allFuzzy);
  check('nonsense query refused, previous target kept',
    (app.setNavTarget('citadel'), app.setNavTarget('zzz-no-such-place') === false) &&
      app.getNavTarget()?.id === 'citadel');
  check('setNavTarget(null | "" | "clear") clears the target',
    app.setNavTarget(null) === true && app.getNavTarget() === null &&
      app.setNavTarget('clear') === true && app.getNavTarget() === null);

  // Gold HUD chevron pin.
  const pin = doc.getElementById('lunar-hud-compass-pin-nav');
  check('compass-pin-nav element exists on the tape', pin !== null);
  check('chevron glyph is ▼', pin !== null && pin.children[0]?.textContent === '\u25bc');
  app.setNavTarget('citadel');
  step(PI);
  check('gold pin visible while armed', pin !== null && !pin.classList.contains('is-hidden'));
  const citadelDist = Math.hypot(-1850 - p.x, 2400 - p.y);
  const pinText = pin?.text() ?? '';
  check(`pin readout carries name + [${Math.round(citadelDist)}m] live distance`,
    pinText.includes('Citadel') && pinText.includes(`[${Math.round(citadelDist)}m]`), pinText);
  app.setNavTarget('clear');
  const cleared = step(PI);
  check('targets.nav undefined after clear', cleared.nav === undefined);
  check('gold pin hidden after clear', pin !== null && pin.classList.contains('is-hidden'));

  suit.dispose();
  app.dispose();
}
}

// ===========================================================================
// GATE 5 — Untethered rover ballistics & crater-lip leaps (Spec 32 §2.5 / §4)
// ===========================================================================
function runGate5(): void {

/** 25° launch ramp of height H followed by a sheer cliff back to the plain. */
function bermTerrain(bermX: number, H: number): GroundElevationFn {
  const t25 = Math.tan((25 * PI) / 180);
  const L = H / t25;
  return (x: number): number => {
    if (x < bermX || x >= bermX + L) return 0;
    return t25 * (x - bermX);
  };
}

/** Conical crater bowl whose rim slope at the lip is exactly 25°. */
function craterTerrain(cx: number, cy: number, R: number): GroundElevationFn {
  const D = (2 * R * Math.tan((25 * PI) / 180)) / PI;
  return (x: number, y: number): number => {
    const d = Math.hypot(x - cx, y - cy);
    if (d >= R) return 0;
    return -D * Math.cos((PI * d) / (2 * R));
  };
}

interface RunProbe {
  maxClearance: number;
  airborneSeconds: number;
  minDatumPenetration: number;
  minNosePenetration: number;
  launchVLong: number;
  landingVLong: number;
  ballisticDescentFrames: number;
  quietDescentFrames: number;
  overGravityFrames: number;
  descentFrames: number;
  finite: boolean;
}

/**
 * Rebound-damping stop speed: the corner law fz = max(0, k·x − c·vz) with x
 * pinned at full droop (−travel) unloads to zero once the corner climbs
 * faster than k·travel/c = 4200·0.2/1360 ≈ 0.62 m/s. Below that speed the
 * damper legitimately retards the fall (rebound damping, not suction), so
 * the exact lunar-free-fall gate only samples frames where the chassis is
 * still climbing with every wheel on its droop stop.
 */

/** Drive a raw LunarBuggy across `terrain`, sampling the Spec 32 §2.5 probes. */
function driveBuggy(
  terrain: GroundElevationFn,
  opts: { x: number; y: number; vLong: number; frames: number; throttle?: number },
): RunProbe {
  const dt = 1 / 60;
  const buggy = new LunarBuggy({ groundElevation: terrain }, {
    x: opts.x, y: opts.y, heading: 0, vLong: opts.vLong,
  });
  const probe: RunProbe = {
    maxClearance: -Infinity, airborneSeconds: 0, minDatumPenetration: Infinity,
    minNosePenetration: Infinity, launchVLong: opts.vLong, landingVLong: 0,
    ballisticDescentFrames: 0, quietDescentFrames: 0, overGravityFrames: 0,
    descentFrames: 0, finite: true,
  };
  let prevVz = 0;
  let prevAirborne = false;
  let prevAllDrooped = false;
  for (let i = 0; i < opts.frames; i++) {
    const s = buggy.step(dt, {
      ...IDLE_BUGGY_INPUT, parkBrake: false, throttle: opts.throttle ?? 0.45, brake: 0,
    });
    const floorZ = terrain(s.x, s.y);
    probe.maxClearance = Math.max(probe.maxClearance, s.z - floorZ);
    probe.minDatumPenetration = Math.min(probe.minDatumPenetration, s.z - floorZ);
    // Recompute the nose-underside barrier exactly as the physics guard does.
    const noseGround = terrain(
      s.x + 1.6 * Math.cos(s.heading),
      s.y + 1.6 * Math.sin(s.heading),
    );
    const noseUnderZ = s.z + 1.6 * Math.sin(s.pitch) - 0.12;
    probe.minNosePenetration = Math.min(probe.minNosePenetration, noseUnderZ - noseGround);
    if (s.airborne) {
      probe.airborneSeconds += dt;
      probe.launchVLong = Math.max(probe.launchVLong, Math.abs(s.vLong));
      if (prevAirborne && s.vBody < prevVz) {
        probe.descentFrames++;
        // No suspension can pull the rover DOWN faster than lunar free fall.
        if (s.vBody - prevVz < -LUNAR_GRAVITY * dt - 1e-9) probe.overGravityFrames++;
        // Provably-unloaded window: every wheel pinned on its droop stop in
        // BOTH neighbouring frames (zero spring term across the frame) while
        // the chassis still climbs (zero rebound damper term). There the
        // frame must match lunar gravity exactly.
        const allDrooped = s.wheels.every((w) => w.compression <= 1e-9);
        if (allDrooped && prevAllDrooped && prevVz > 0.2) {
          probe.quietDescentFrames++;
          if (near((s.vBody - prevVz) / dt, -LUNAR_GRAVITY, 1e-6)) probe.ballisticDescentFrames++;
        }
        prevAllDrooped = allDrooped;
      }
    }
    probe.landingVLong = Math.abs(s.vLong);
    prevVz = s.vBody;
    prevAirborne = s.airborne;
    probe.finite &&= Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.vBody);
  }
  return probe;
}

section('GATE 5a — 25° berm launch: s.z > z_floor + 0.5 m, hangtime > 1.0 s');
{
  const berm = bermTerrain(0, 3);
  const probe = driveBuggy(berm, { x: -22, y: 0, vLong: 12, frames: 900 });
  check(`cleared the lip: max z − z_floor = ${probe.maxClearance.toFixed(3)} m > 0.5 m`,
    probe.maxClearance > 0.5);
  check(`hangtime ${probe.airborneSeconds.toFixed(2)} s > 1.0 s`, probe.airborneSeconds > 1.0);
  check(`free-fall frames match lunar g exactly where springs+dampers are provably unloaded (${probe.ballisticDescentFrames}/${probe.quietDescentFrames})`,
    probe.quietDescentFrames > 5 && probe.ballisticDescentFrames === probe.quietDescentFrames);
  check('no airborne frame is pulled down faster than lunar free fall (gravity is the ceiling)',
    probe.overGravityFrames === 0);
  check('zero ground penetration on the steep approach (datum ≥ floor)',
    probe.minDatumPenetration > -1e-9, `min ${probe.minDatumPenetration.toExponential(2)}`);
  check('zero nose-clip penetration (undersight lookout ≥ terrain)',
    probe.minNosePenetration > -1e-9, `min ${probe.minNosePenetration.toExponential(2)}`);
  check('state stayed finite through launch + touchdown', probe.finite);
}

section('GATE 5b — crater rim exit: momentum preserved, ballistic lunar-g descent');
{
  const crater = craterTerrain(0, 0, 14);
  const probe = driveBuggy(crater, { x: -4, y: 0, vLong: 10, frames: 1200 });
  check(`crater lip launch caught air: max z − z_floor = ${probe.maxClearance.toFixed(3)} m > 0.5 m`,
    probe.maxClearance > 0.5);
  check(`hangtime ${probe.airborneSeconds.toFixed(2)} s observed over the rim`,
    probe.airborneSeconds > 1.0);
  check(`horizontal momentum preserved through the flight (${probe.landingVLong.toFixed(2)} m/s ≥ 0.85 × ${probe.launchVLong.toFixed(2)})`,
    probe.landingVLong >= 0.85 * probe.launchVLong);
  check(`sustained gravity-driven descent over the rim (${probe.descentFrames} frames ≥ 0.5 s of falling)`,
    probe.descentFrames >= 30);
  check('every rim-descent frame is cushioned or free-falling — none exceeds lunar g', probe.overGravityFrames === 0);
  check('zero ground penetration crossing the crater floor and walls',
    probe.minDatumPenetration > -1e-9 && probe.minNosePenetration > -1e-9);
}

section('GATE 5c — steep 40° wall approach: nose-clip guard, no tunnelling');
{
  const t40 = Math.tan((40 * PI) / 180);
  const wall: GroundElevationFn = (x: number): number =>
    x < 0 ? 0 : Math.min(t40 * x, 8);
  const probe = driveBuggy(wall, { x: -15, y: 0, vLong: 14, frames: 720, throttle: 0.6 });
  check('chassis datum never sinks below the wall face',
    probe.minDatumPenetration > -1e-9, `min ${probe.minDatumPenetration.toExponential(2)}`);
  check('nose underside never clips the rising terrain',
    probe.minNosePenetration > -1e-9, `min ${probe.minNosePenetration.toExponential(2)}`);
  check('simulation stayed finite against the hard wall', probe.finite);
}

section('GATE 5d — airborne road wheels hang at maximum droop travel (OpenBuggy)');
{
  const berm = bermTerrain(0, 3);
  const rover = new OpenBuggy({ groundElevation: berm, x: -22, y: 0, heading: 0 }).init(engine);
  const wheelMeshes = [0, 1, 2, 3].map(
    (i) => rover.getMeshes().find((m) => m.name.endsWith(`-wheel-${i}`)) ?? null,
  );
  check('4 corner road-wheel meshes found in the rig', wheelMeshes.every((m) => m !== null));

  // Grounded ride: suspension carries load, wheels NOT at full droop.
  const grounded = rover.update(1 / 60, { ...IDLE_BUGGY_INPUT, parkBrake: false, throttle: 0 });
  const groundedCompressions = grounded.wheels.map((w) => w.compression);
  check('grounded static ride compresses the springs (> 0)',
    groundedCompressions.every((c) => c > 0.01), JSON.stringify(groundedCompressions.map((c) => c.toFixed(3))));
  const groundedY = (wheelMeshes[0] as { position: { y: number } }).position.y;

  // Launch off the berm and let the springs ring out: capture only after the
  // rover has sustained flight (the first airborne frame still carries the
  // launch-compressed suspension, which rings to droop over ~0.3–0.5 s).
  let airborneState: BuggyState | null = null;
  let airFrames = 0;
  for (let i = 0; i < 900; i++) {
    const s = rover.update(1 / 60, { ...IDLE_BUGGY_INPUT, parkBrake: false, throttle: 0.45 });
    airFrames = s.airborne ? airFrames + 1 : 0;
    if (airFrames >= 30) {
      airborneState = s;
      break;
    }
  }
  check('OpenBuggy sustains ≥ 0.5 s of true flight off the berm lip', airborneState !== null);
  if (airborneState !== null) {
    check('airborne springs ring out to full droop (compression = 0)',
      airborneState.wheels.every((w) => w.compression <= 1e-9),
      JSON.stringify(airborneState.wheels.map((w) => Number(w.compression.toFixed(4)))));
    // Spec 32 §2.5 wheel law: chassis-local y = (2c − 1)·travel − datum offset.
    // At c = 0 (airborne) the wheel centre hangs exactly R below the datum.
    const droopLocalY = (0 * 2 - 1) * BUGGY_SPRING_TRAVEL - BUGGY_SEAT_BELOW_DATUM;
    check(`max-droop local y = −R (${droopLocalY.toFixed(3)} m)`, near(droopLocalY, -0.45, 1e-12));
    let hung = 0;
    const hangYs: number[] = [];
    for (const m of wheelMeshes) {
      if (m === null) continue;
      const y = m.position.y;
      hangYs.push(y);
      if (near(y, droopLocalY, 1e-6)) hung++;
    }
    check(`all 4 road wheels hang at max droop travel below the airborne chassis (${hung}/4)`,
      hung === 4, JSON.stringify(hangYs));
    check('airborne droop hangs strictly further down than the grounded ride height',
      hangYs.every((y) => y < groundedY - 1e-9), `droop ${hangYs[0]} vs grounded ${groundedY.toFixed(3)}`);
    // And the root rides the TRUE world elevation, not the floor below.
    const root = (rover as unknown as { root: { position: { y: number } } | null }).root;
    check('rover root node flies with the chassis datum (world z → Babylon y)',
      root !== null && near(root.position.y, airborneState.z, 1e-6),
      root === null ? 'no root' : `root ${root.position.y} vs z ${airborneState.z}`);
  }
  rover.dispose();
}
}

// ===========================================================================
// Report
// ===========================================================================
async function main(): Promise<void> {
  await runGate3e();
  await runGate4();
  runGate5();
  engine.dispose();
  console.log('\n' + '='.repeat(62));
  if (failures.length > 0) {
    console.error(`\u{1f6d1} smoke-acrobatics-nav-ballistics: ${failures.length}/${passed + failures.length} FAILED`);
    for (const f of failures) console.error(`  • ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\u{1f389} smoke-acrobatics-nav-ballistics: ALL ${passed} CHECKS GREEN`);
  }
}

void main().catch((err: unknown) => {
  console.error('\ud83d\udca5 smoke-acrobatics-nav-ballistics crashed:', err);
  process.exit(1);
});
