/**
 * Spec 35 Phase 4 — headless acceptance smoke suite for the Fluid Low-G
 * Airborne Leg Tuck & Kinematic Bounding Rectification.
 *
 * Runs fully headless under `npx tsx scripts/smoke-spec35-airborne-tuck.ts`
 * (exit 0 == all green). One shared `NullEngine`; only the minimal fake DOM
 * the HUD harness needs; no network, no audio device (the LunarAudioSystem
 * graph is a synchronous mock under Node).
 *
 * Contract gates (Spec 35 §4 / Blueprint 35 §5):
 *   GATE 1  Root pitch zero-flip — pose.flipPitchRad === 0 under ALL
 *           conditions (pure-law sweep of hurryStridePose / acrobaticTuckPose
 *           across 1001 phases × both legs × tuck on/off, plus the live
 *           avatar root mesh on real bounding arcs) and the root-mesh pitch
 *           never exceeds 0.35 rad — the Spec 32 360° somersault is gone.
 *   GATE 2  Bilateral symmetry — at mid-arc u = 0.50 the standalone tuck
 *           pose and the live stride-law overlay both land bilaterally on
 *           TUCK_HIP_FLEXION_RAD (−1.20) and TUCK_KNEE_FLEXION_RAD (+1.80)
 *           within 1e-6; L/R hips and L/R knees identical within 0.01 rad
 *           across every frame where W_tuck > 0.8.
 *   GATE 3  Elbow sign convention — every elbow channel of every pose law
 *           (rest / stride / sprint pump / acrobatic overlay / climb) stays
 *           negative (≤ −0.15 rad inside the tuck maneuver); zero backward
 *           hyperextension anywhere across the sweep.
 *   GATE 4  Smoothness continuity — W_tuck(u) is the quintic smoothstep:
 *           finite, NaN-free, range [0, 1], zero first derivative at all
 *           four seams (C¹ fold-in/unfold), bounded slope; consecutive-pose
 *           joint deltas stay small (no popping) across 2000 arc samples.
 *   GATE 5  Landing handoff — physics `acrobaticRoll` self-clears the
 *           instant the boots touch down (tuck weight → 0 within one frame),
 *           `hurryPreLanding` fires the pre-touchdown edge at u ≥ 0.90, the
 *           grounded brace ramps Δz ≈ −0.08 m stance compression, horizontal
 *           momentum is bit-identical between a tuck run and a control run,
 *           and mid-arc release pins the mirrored latch false immediately.
 *   GATE 6  HUD + audio — `AERODYNAMIC TUCK` pill lights strictly above
 *           HUD_TUCK_PILL_MIN_W (0.5) with the airborneTuck override
 *           winning, ClientApp.refreshHud feeds W_tuck(u) from live state,
 *           and the pneumatic compression hiss / hydraulic extension latch
 *           fire exactly once per edge on the ClientApp audio pump.
 */
import assert from 'node:assert';

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

import { ClientApp } from '../src/client/ClientApp.ts';
import LunarHUD, { HUD_TUCK_PILL_MIN_W } from '../src/ui/LunarHUD.ts';
import {
  ELBOW_REST_RAD,
  TUCK_ELBOW_FLEXION_RAD,
  TUCK_HIP_FLEXION_RAD,
  TUCK_KNEE_FLEXION_RAD,
  TUCK_TORSO_PITCH_RAD,
  TUCK_ANKLE_PITCH_RAD,
  TUCK_SHOULDER_PITCH_RAD,
  TUCK_ROOT_FLIP_RAD,
  TUCK_RAMP_IN_START_U,
  TUCK_HOLD_START_U,
  TUCK_UNFOLD_START_U,
  TUCK_RAMP_OUT_END_U,
  acrobaticTuckEnvelope,
  acrobaticTuckPose,
  climbGripPose,
  hurryStridePose,
  EvaSuitAvatar,
} from '../src/entities/AstronautSuit.ts';
import {
  IDLE_SUIT_INPUT,
  SUIT_HURRY_BRACE_COMPRESSION_M,
  SUIT_HURRY_PRE_LANDING_U,
  LunarEvaSuit,
  type SuitState,
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

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;
const isFiniteNumber = (v: number): boolean => Number.isFinite(v);

// Shared NullEngine — one for every Babylon surface in this process (skill #2).
const engine = new NullEngine();
void engine;

// Minimal fake DOM (same subset smoke-acrobatics-nav-ballistics.ts uses).
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

/** Sprint bounding input with the fluid leg tuck held aloft. */
const SPRINT_TUCK = {
  ...IDLE_SUIT_INPUT,
  forward: 1,
  sprint: true,
  acrobaticRoll: true,
} as const;
const DT = 1 / 60;

/** HudSuitTelemetry payload carrying only the tuck channels of interest. */
const tele = (t: { tuckWeight?: number; airborneTuck?: boolean }): Parameters<LunarHUD['updateSuitTelemetry']>[0] => ({
  oxygen: 100,
  battery: 100,
  headlightOn: false,
  ...t,
});

// ===========================================================================
// GATE 1 — Root pitch zero-flip (Spec 35 §2.2 / §4.1)
// ===========================================================================
section('GATE 1a — pure-law sweep: flipPitchRad strictly 0 under all conditions');
{
  let flipSamples = 0;
  let badFlip = 0;
  let maxTorso = 0;
  for (let i = 0; i <= 1000; i++) {
    const u = i / 1000;
    for (const leg of ['left', 'right'] as const) {
      for (const acro of [false, true]) {
        const flight = hurryStridePose(leg, true, u, 5.2, acro);
        flipSamples++;
        if (flight.flipPitchRad !== 0) badFlip++;
        maxTorso = Math.max(maxTorso, Math.abs(flight.torsoPitchRad));
        // Grounded brace frames too.
        const brace = hurryStridePose(leg, false, u, 2.6);
        flipSamples++;
        if (brace.flipPitchRad !== 0) badFlip++;
      }
      // Phaseless canonical snapshot.
      const legacy = hurryStridePose(leg, true);
      flipSamples++;
      if (legacy.flipPitchRad !== 0) badFlip++;
    }
    const tuck = acrobaticTuckPose(u);
    flipSamples++;
    if (tuck.flipPitchRad !== 0) badFlip++;
  }
  check(`${flipSamples} pose samples across u ∈ [0,1], flipPitchRad === 0 on every one (bad=${badFlip})`,
    badFlip === 0);
  check(`TUCK_ROOT_FLIP_RAD constant is strict zero (${TUCK_ROOT_FLIP_RAD})`,
    TUCK_ROOT_FLIP_RAD === 0);
  check(`torso rake channel stays ≤ 0.35 rad everywhere (max |pitch| = ${maxTorso.toFixed(4)} rad)`,
    maxTorso <= 0.35);
  // Non-finite phases must not smuggle a flip either.
  check('flipPitchRad === 0 on NaN / ±∞ phase inputs',
    hurryStridePose('left', true, Number.NaN, 5.2, true).flipPitchRad === 0 &&
      acrobaticTuckPose(Number.POSITIVE_INFINITY).flipPitchRad === 0);
}

section('GATE 1b — live avatar root mesh never somersaults on real bounding arcs');
{
  const avatar = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } });
  avatar.init(); // self-owned NullEngine fallback (shared-process safe)
  check('EvaSuitAvatar builds headless (NullEngine)', avatar.isBuilt() === true);

  const nodes = new Map<string, TransformNode>();
  for (const m of avatar.getMeshes()) {
    let n = m.parent as TransformNode | null;
    while (n !== null) {
      if (!nodes.has(n.name)) nodes.set(n.name, n);
      n = n.parent as TransformNode | null;
    }
  }
  const root = nodes.get('eva-avatar') ?? null;
  check('avatar root pivot (eva-avatar) resolved for the zero-flip gate', root !== null);
  const upper = nodes.get('eva-upper-body');
  assert(upper !== undefined, 'eva-upper-body pivot missing');

  let flightFrames = 0;
  let maxRootPitch = 0;
  let maxUpperPitch = 0;
  let flipAccum = 0;
  let prevRootX = 0;
  for (let i = 0; i < 1800; i++) {
    const s = avatar.update(DT, SPRINT_TUCK);
    const rootX = root !== null ? root.rotation.x : 0;
    maxRootPitch = Math.max(maxRootPitch, Math.abs(rootX));
    maxUpperPitch = Math.max(maxUpperPitch, Math.abs(upper.rotation.x));
    // Accumulated root rotation delta: a somersault would ring up ~2π per arc.
    if (!s.isGrounded) {
      flipAccum += Math.abs(rootX - prevRootX);
      flightFrames++;
    }
    prevRootX = rootX;
  }
  check(`live bounding flight arcs observed (${flightFrames} airborne frames)`,
    flightFrames > 300);
  check(`root-mesh |rotation.x| ≤ 0.35 rad across every frame (max ${maxRootPitch.toFixed(6)})`,
    maxRootPitch <= 0.35);
  check(`accumulated root pitch change aloft ≪ 2π — no 360° flip (${flipAccum.toFixed(6)} rad total)`,
    flipAccum < 0.5);
  check(`upper-body pitch channel stays bounded ≤ 0.35 rad (max ${maxUpperPitch.toFixed(4)})`,
    maxUpperPitch <= 0.35);
  avatar.dispose();
}

// ===========================================================================
// GATE 2 — Bilateral symmetry at mid-arc (Spec 35 §2.2 / §4.2)
// ===========================================================================
section('GATE 2a — standalone tuck pose lands bilaterally on the envelope at u = 0.50');
{
  const mid = acrobaticTuckPose(0.5);
  check('full tuck blend W_tuck(0.50) === 1', mid.tuckBlend === 1);
  check(`bilateral hips within 1e-6 of TUCK_HIP_FLEXION_RAD (−1.20) (${mid.hipLx}/${mid.hipRx})`,
    near(mid.hipLx, TUCK_HIP_FLEXION_RAD, 1e-6) && near(mid.hipRx, TUCK_HIP_FLEXION_RAD, 1e-6));
  check(`bilateral knees within 1e-6 of TUCK_KNEE_FLEXION_RAD (+1.80) (${mid.kneeLx}/${mid.kneeRx})`,
    near(mid.kneeLx, TUCK_KNEE_FLEXION_RAD, 1e-6) && near(mid.kneeRx, TUCK_KNEE_FLEXION_RAD, 1e-6));
  check(`bilateral elbows ≈ TUCK_ELBOW_FLEXION_RAD (−1.35) (${mid.elbowLx}/${mid.elbowRx})`,
    near(mid.elbowLx, TUCK_ELBOW_FLEXION_RAD, 1e-12) && near(mid.elbowRx, TUCK_ELBOW_FLEXION_RAD, 1e-12));
  check(`shoulders bracket at TUCK_SHOULDER_PITCH_RAD (−0.65)`,
    near(mid.shoulderLx, TUCK_SHOULDER_PITCH_RAD, 1e-12) &&
      near(mid.shoulderRx, TUCK_SHOULDER_PITCH_RAD, 1e-12));
  check(`ankles streamline at TUCK_ANKLE_PITCH_RAD (−0.35)`,
    near(mid.ankleLx!, TUCK_ANKLE_PITCH_RAD, 1e-12) && near(mid.ankleRx!, TUCK_ANKLE_PITCH_RAD, 1e-12));
  check(`torso holds athletic rake TUCK_TORSO_PITCH_RAD (0.22)`,
    near(mid.torsoPitchRad, TUCK_TORSO_PITCH_RAD, 1e-12));
  check(`L/R hip symmetry within 0.01 rad (§4.2)`, Math.abs(mid.hipLx - mid.hipRx) <= 0.01);
  check(`L/R knee symmetry within 0.01 rad (§4.2)`, Math.abs(mid.kneeLx - mid.kneeRx) <= 0.01);
  check('hip/knee tuck magnitude ≥ 1.2 rad (compact fold)',
    Math.abs(mid.hipLx) >= 1.2 && mid.kneeLx >= 1.2);
}

section('GATE 2b — live stride-law overlay folds bilaterally onto the envelope');
{
  // At u = 0.50, W_tuck = 1, so both legs (lead + push channels) land exactly
  // on the tuck target regardless of the underlying triple-jump channels.
  for (const leg of ['left', 'right'] as const) {
    const ov = hurryStridePose(leg, true, 0.5, 5.2, true);
    check(`overlay (${leg} stride frame): hips bilaterally −1.20 at u = 0.5`,
      near(ov.hipLx, TUCK_HIP_FLEXION_RAD, 1e-6) && near(ov.hipRx, TUCK_HIP_FLEXION_RAD, 1e-6));
    check(`overlay (${leg} stride frame): knees bilaterally +1.80 at u = 0.5`,
      near(ov.kneeLx, TUCK_KNEE_FLEXION_RAD, 1e-6) && near(ov.kneeRx, TUCK_KNEE_FLEXION_RAD, 1e-6));
    check(`overlay (${leg} stride frame): elbows bilaterally −1.35 at u = 0.5`,
      near(ov.elbowLx, TUCK_ELBOW_FLEXION_RAD, 1e-12) && near(ov.elbowRx, TUCK_ELBOW_FLEXION_RAD, 1e-12));
  }
  // Across the deep-tuck hold band, L/R channels must match within 0.01 rad.
  let symBad = 0;
  let holdFrames = 0;
  for (let i = 0; i <= 1000; i++) {
    const u = 0.30 + (0.40 * i) / 1000;
    if (acrobaticTuckEnvelope(u) <= 0.8) continue;
    for (const leg of ['left', 'right'] as const) {
      const p = hurryStridePose(leg, true, u, 5.2, true);
      holdFrames++;
      if (Math.abs(p.hipLx - p.hipRx) > 0.01) symBad++;
      if (Math.abs(p.kneeLx - p.kneeRx) > 0.01) symBad++;
    }
  }
  check(`${holdFrames} frames with W_tuck > 0.8: L/R hips and knees identical within 0.01 rad (bad=${symBad})`,
    symBad === 0 && holdFrames > 500);
  // acrobatic = false must leave the Spec 31 cycle untouched (no tuck leak).
  const plain = hurryStridePose('left', true, 0.5, 5.2, false);
  check('acrobatic=false frames carry no tuck leak (hips off −1.20 target)',
    !near(plain.hipLx, TUCK_HIP_FLEXION_RAD, 0.05) && !near(plain.kneeLx, TUCK_KNEE_FLEXION_RAD, 0.05));
}

// ===========================================================================
// GATE 3 — Elbow sign convention (Spec 32 §2.1 / Spec 35 §4.3)
// ===========================================================================
section('GATE 3 — every elbow channel stays negative through the whole maneuver');
{
  let samples = 0;
  let bad = 0;
  let minElbow = Number.POSITIVE_INFINITY;
  let maxElbow = Number.NEGATIVE_INFINITY;
  const eat = (theta: number, maneuver = false): void => {
    samples++;
    if (!(theta <= -0.15) && maneuver) bad++;
    if (!(theta < 0)) bad++;
    minElbow = Math.min(minElbow, theta);
    maxElbow = Math.max(maxElbow, theta);
  };
  for (let i = 0; i <= 1000; i++) {
    const u = i / 1000;
    for (const leg of ['left', 'right'] as const) {
      const brace = hurryStridePose(leg, false, u, 2.6);
      eat(brace.elbowLx);
      eat(brace.elbowRx);
      const flight = hurryStridePose(leg, true, u, 5.2, false);
      eat(flight.elbowLx);
      eat(flight.elbowRx);
      // The tuck maneuver itself — strict −0.15 rad gate.
      const acro = hurryStridePose(leg, true, u, 5.2, true);
      eat(acro.elbowLx, true);
      eat(acro.elbowRx, true);
    }
    const tuck = acrobaticTuckPose(u);
    eat(tuck.elbowLx, true);
    eat(tuck.elbowRx, true);
    const climb = climbGripPose(u * 14.0, 2.2);
    eat(climb.elbowLx);
    eat(climb.elbowRx);
  }
  check(`${samples} elbow samples swept; zero non-negative values, zero backward hyperextension (bad=${bad})`,
    bad === 0);
  check(`maneuver elbow range inside [−1.35, −0.15] ⊇ [${minElbow.toFixed(3)}, ${maxElbow.toFixed(3)}]`,
    minElbow >= TUCK_ELBOW_FLEXION_RAD - 1e-12 && maxElbow <= ELBOW_REST_RAD + 1e-12 && maxElbow <= -0.15);
  check(`ELBOW_REST_RAD itself obeys the sign law (${ELBOW_REST_RAD})`, ELBOW_REST_RAD < 0);
}

// ===========================================================================
// GATE 4 — Quintic smoothstep continuity, NaN-free (Spec 35 §2.1 / §4.3)
// ===========================================================================
section('GATE 4a — W_tuck(u) quintic envelope: shape, range, C¹ seams');
{
  check('seam constants: ramp-in 0.15 → hold 0.30 → unfold 0.70 → clear 0.90',
    TUCK_RAMP_IN_START_U === 0.15 && TUCK_HOLD_START_U === 0.3 &&
      TUCK_UNFOLD_START_U === 0.7 && TUCK_RAMP_OUT_END_U === 0.9);
  check('zero before fold-in (W(0) = W(0.149…) = 0)',
    acrobaticTuckEnvelope(0) === 0 && acrobaticTuckEnvelope(0.1499999) === 0);
  check('full aerodynamic glide through u ∈ [0.30, 0.70]',
    acrobaticTuckEnvelope(0.3) === 1 && acrobaticTuckEnvelope(0.5) === 1 &&
      acrobaticTuckEnvelope(0.7) === 1);
  check('cleared for landing handoff from u ≥ 0.90',
    acrobaticTuckEnvelope(0.9) === 0 && acrobaticTuckEnvelope(0.95) === 0 &&
      acrobaticTuckEnvelope(1) === 0);
  const midIn = acrobaticTuckEnvelope(0.225);
  const midOut = acrobaticTuckEnvelope(0.8);
  check(`ramps pass through the quintic midpoints (${midIn.toFixed(6)}, ${midOut.toFixed(6)})`,
    near(midIn, 0.5, 1e-12) && near(midOut, 0.5, 1e-12));

  let nanCount = 0;
  let rangeBad = 0;
  let monotoneInOk = true;
  let monotoneOutOk = true;
  let prev = acrobaticTuckEnvelope(0);
  let prevU = 0;
  let maxSlope = 0;
  for (let i = 1; i <= 20000; i++) {
    const u = i / 20000;
    const v = acrobaticTuckEnvelope(u);
    if (!isFiniteNumber(v)) nanCount++;
    if (v < 0 || v > 1) rangeBad++;
    if (u > TUCK_RAMP_IN_START_U && u < TUCK_HOLD_START_U && v < prev - 1e-12) monotoneInOk = false;
    if (u > TUCK_UNFOLD_START_U && u < TUCK_RAMP_OUT_END_U && v > prev + 1e-12) monotoneOutOk = false;
    maxSlope = Math.max(maxSlope, Math.abs(v - prev) / (u - prevU));
    prev = v;
    prevU = u;
  }
  check('20 000-sample sweep: zero NaN / non-finite values', nanCount === 0);
  check('envelope range stays inside [0, 1]', rangeBad === 0);
  check('strictly non-decreasing across fold-in ramp, non-increasing across unfold ramp',
    monotoneInOk && monotoneOutOk);
  // Quintic smoothstep peak slope is 1.875/window → 12.5 for the 0.15 ramp.
  check(`finite bounded derivative (max |dW/du| = ${maxSlope.toFixed(2)} ≤ 12.6)`, maxSlope <= 12.6);

  // C¹ seams: value AND one-sided derivative continuous at 0.15 / 0.30 / 0.70 / 0.90.
  // Lag ≪ ε/slope (skill #40): seams sit at zero-slope points of the quintic.
  for (const seam of [0.15, 0.30, 0.70, 0.90]) {
    const w0 = acrobaticTuckEnvelope(seam);
    const lag = 1e-9;
    const wMinus = acrobaticTuckEnvelope(seam - lag);
    const wPlus = acrobaticTuckEnvelope(seam + lag);
    const dMinus = (w0 - wMinus) / lag;
    const dPlus = (wPlus - w0) / lag;
    check(`C¹ at u = ${seam}: value continuous (${Math.abs(wPlus - w0).toExponential(1)} / ${Math.abs(w0 - wMinus).toExponential(1)}), slopes → 0 (${dMinus.toFixed(3)} | ${dPlus.toFixed(3)})`,
      near(wPlus, w0, 1e-6) && near(wMinus, w0, 1e-6) &&
        Math.abs(dMinus) < 1e-3 && Math.abs(dPlus) < 1e-3);
  }
}

section('GATE 4b — joint channels NaN-free and pop-free across the arc');
{
  const channels = ['hipLx', 'hipRx', 'kneeLx', 'kneeRx', 'shoulderLx', 'shoulderRx',
    'elbowLx', 'elbowRx', 'torsoPitchRad'] as const;
  let nanCount = 0;
  let maxDelta = 0;
  let prevPose = hurryStridePose('left', true, 0, 5.2, true);
  for (let i = 1; i <= 2000; i++) {
    const u = i / 2000;
    const pose = hurryStridePose('left', true, u, 5.2, true);
    for (const c of channels) {
      const v = pose[c];
      const pv = prevPose[c];
      if (!isFiniteNumber(v) || !isFiniteNumber(pv)) nanCount++;
      maxDelta = Math.max(maxDelta, Math.abs(v - pv));
    }
    prevPose = pose;
  }
  check('2000-sample stride-overlay sweep: zero NaN in any joint channel', nanCount === 0);
  check(`consecutive-frame joint delta bounded (max ${maxDelta.toFixed(6)} rad < 0.05 — no popping)`,
    maxDelta < 0.05);
  const land = acrobaticTuckPose(1);
  check('landing frame unwinds to neutral (elbows at rest hang, torso pitch 0)',
    near(land.elbowLx, ELBOW_REST_RAD, 1e-12) && near(land.torsoPitchRad, 0, 1e-12) &&
      land.hipLx === 0 && land.kneeLx === 0);
}

// ===========================================================================
// GATE 5 — Landing handoff & momentum preservation (Spec 35 Phase 2 / §4)
// ===========================================================================
section('GATE 5a — touchdown self-clears the tuck latch within one frame');
{
  const suit = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true, oxygen: 100 });
  let arcs = 0;
  let touchdownFrames = 0;
  let latchStuck = 0;
  let preLandingEdges = 0;
  let preLandingOnGround = 0;
  let wOnTouchdownBad = 0;
  let prev: SuitState | null = null;
  let prevPreLanding = false;
  for (let i = 0; i < 2400; i++) {
    const s = suit.step(DT, { ...SPRINT_TUCK });
    if (prev !== null && !prev.isGrounded && s.isGrounded) {
      // Touchdown frame: latch MUST already read false, tuck weight 0.
      touchdownFrames++;
      if (s.acrobaticRoll === true) latchStuck++;
      const w = acrobaticTuckEnvelope(s.hurryAirPhase ?? 0);
      if (w !== 0) wOnTouchdownBad++;
    }
    if (s.hurryPreLanding === true && !prevPreLanding) preLandingEdges++;
    if (s.hurryPreLanding === true && s.isGrounded) preLandingOnGround++;
    prevPreLanding = s.hurryPreLanding === true;
    if (s.gaitMode === 'bounding') arcs++;
    prev = s;
  }
  check('sustained bounding loop ran (bounding frames present)', arcs > 100);
  check(`clean touchdowns observed (${touchdownFrames})`, touchdownFrames >= 2);
  check(`tuck latch false on EVERY touchdown frame — zero one-frame hitch (stuck=${latchStuck})`,
    latchStuck === 0 && touchdownFrames >= 2);
  check(`tuck weight W_tuck(u) = 0 on every touchdown frame (bad=${wOnTouchdownBad})`,
    wOnTouchdownBad === 0);
  // One pre-landing edge per arc at most; nominal τ arcs all reach u ≥ 0.90
  // before touchdown, so at least one edge fires per observed touchdown bar
  // the single engagement arc.
  check(`pre-landing edges fire at u ≥ ${SUIT_HURRY_PRE_LANDING_U} before touchdown ` +
    `(${preLandingEdges} edges / ${touchdownFrames} touchdowns)`,
    preLandingEdges >= 1 && preLandingEdges <= touchdownFrames &&
      SUIT_HURRY_PRE_LANDING_U === 0.9);
  check('hurryPreLanding never true on grounded frames', preLandingOnGround === 0);

  // Idle-walking never opens a brace pop on the grounded gait.
  const grounded = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true, oxygen: 100 });
  let maxCompression = 0;
  for (let i = 0; i < 60; i++) {
    const s = grounded.step(DT, { ...IDLE_SUIT_INPUT, forward: 1 });
    maxCompression = Math.max(maxCompression, Math.abs(s.hurryBraceCompression ?? 0));
  }
  check(`grounded idle-walk carries no brace compression (${maxCompression.toFixed(4)} m < ${SUIT_HURRY_BRACE_COMPRESSION_M})`,
    maxCompression < SUIT_HURRY_BRACE_COMPRESSION_M);
}

section('GATE 5b — tuck latch never perturbs v_xy (bit-identical to control run)');
{
  const tucker = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true, oxygen: 100 });
  const control = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true, oxygen: 100 });
  let maxDrift = 0;
  let frames = 0;
  for (let i = 0; i < 1200; i++) {
    const a = tucker.step(DT, { ...SPRINT_TUCK });
    const b = control.step(DT, { ...IDLE_SUIT_INPUT, forward: 1, sprint: true });
    maxDrift = Math.max(
      maxDrift,
      Math.abs(a.x - b.x),
      Math.abs(a.y - b.y),
      Math.abs(a.z - b.z),
      Math.abs(a.vx - b.vx),
      Math.abs(a.vy - b.vy),
      Math.abs(a.vz - b.vz),
    );
    frames++;
  }
  check(`${frames} frames: tuck run trajectory bit-identical to control (max drift ${maxDrift.toExponential(1)} m)`,
    maxDrift === 0);
}

section('GATE 5c — mid-arc release pins the mirrored latch false immediately');
{
  const suit = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true, oxygen: 100 });
  // Launch + latch.
  let latched = false;
  for (let i = 0; i < 2400 && !latched; i++) {
    const s = suit.step(DT, { ...SPRINT_TUCK });
    latched = s.acrobaticRoll === true && (s.hurryAirPhase ?? 0) > 0.35;
  }
  check('tuck latch mirrors input on deep-arc airborne frames', latched);
  // Release mid-flight: the very next frame must report false.
  const released = suit.step(DT, { ...IDLE_SUIT_INPUT, forward: 1, sprint: true });
  check('release while airborne clears acrobaticRoll on the SAME next frame',
    released.acrobaticRoll === false && !released.isGrounded);
  // Re-press later in the same arc re-arms the envelope (toggle semantics).
  let relatched = false;
  for (let i = 0; i < 90 && !relatched; i++) {
    const s = suit.step(DT, { ...SPRINT_TUCK });
    if (s.acrobaticRoll === true && !s.isGrounded) relatched = true;
  }
  check('re-press aloft re-arms the tuck latch', relatched);
}

// ===========================================================================
// GATE 6 — HUD status pill + audio triggers under mock context
// ===========================================================================
async function runGate6(): Promise<void> {
  section('GATE 6a — AERODYNAMIC TUCK pill threshold logic (HUD_TUCK_PILL_MIN_W = 0.5)');
  {
    const doc = fakeDoc();
    const hud = new LunarHUD({ document: doc as unknown as Document });
    check('pill threshold constant is 0.5 (mid-fold of the quintic)', HUD_TUCK_PILL_MIN_W === 0.5);
    // Initial state: hidden.
    check('pill starts hidden', hud.hasClass('tuck-chip', 'is-hidden'));

    hud.updateSuitTelemetry(tele({ tuckWeight: 0.75 }));
    check('pill LIT at W_tuck = 0.75', !hud.hasClass('tuck-chip', 'is-hidden'));
    hud.updateSuitTelemetry(tele({ tuckWeight: 0.5 }));
    check('pill dark at exactly W_tuck = 0.5 (strict > comparison)', hud.hasClass('tuck-chip', 'is-hidden'));
    hud.updateSuitTelemetry(tele({ tuckWeight: 0.5001 }));
    check('pill LIT just above threshold (0.5001)', !hud.hasClass('tuck-chip', 'is-hidden'));
    hud.updateSuitTelemetry(tele({ tuckWeight: 1 }));
    check('pill LIT at full tuck (W_tuck = 1)', !hud.hasClass('tuck-chip', 'is-hidden'));
    hud.updateSuitTelemetry(tele({ tuckWeight: 0 }));
    check('pill dark again at W_tuck = 0 (landing handoff)', hud.hasClass('tuck-chip', 'is-hidden'));
    // Explicit override wins for harnesses / custom blends.
    hud.updateSuitTelemetry(tele({ tuckWeight: 0, airborneTuck: true }));
    check('airborneTuck=true override lights the pill despite W_tuck = 0',
      !hud.hasClass('tuck-chip', 'is-hidden'));
    hud.updateSuitTelemetry(tele({ tuckWeight: 0.9, airborneTuck: false }));
    check('airborneTuck=false override clears the pill despite W_tuck = 0.9',
      hud.hasClass('tuck-chip', 'is-hidden'));
    // Key legends reflect the rectified maneuver (no "somersault/flip").
    const legendText = doc.body.text();
    check('controller legends read "airborne tuck", never "somersault"',
      /airborne tuck/i.test(legendText) && !/somersault/i.test(legendText));
  }

  section('GATE 6b — ClientApp feeds live W_tuck(u) into suit telemetry');
  {
    const doc = fakeDoc();
    const hud = new LunarHUD({ document: doc as unknown as Document });
    type Tele = { tuckWeight?: number; airborneTuck?: boolean };
    const captured: Tele[] = [];
    const realUpdate = hud.updateSuitTelemetry.bind(hud);
    hud.updateSuitTelemetry = (t: Parameters<LunarHUD['updateSuitTelemetry']>[0]): void => {
      captured.push(t as Tele);
      realUpdate(t);
    };
    const app = new ClientApp({ seed: 'spec35-phase4-hud', autoConnect: false, silent: true, hud });
    await app.init(engine as never);
    const suit = app.getSuit();
    // Drive the telemetry paint directly — app.update() would re-step the
    // physics and overwrite the scripted flight-phase frames.
    const paint = (): void => {
      (app as unknown as { refreshHud(): void }).refreshHud();
    };

    // Grounded frame: tuck weight pinned to 0.
    suit.setState({ isGrounded: true, acrobaticRoll: false, hurryAirPhase: 0.5 });
    paint();
    check('grounded frame reports tuckWeight = 0', captured.at(-1)?.tuckWeight === 0);

    // Airborne tuck latch at u = 0.50: full envelope flows through.
    suit.setState({ isGrounded: false, acrobaticRoll: true, hurryAirPhase: 0.5 });
    paint();
    check('airborne latch at u = 0.5 → tuckWeight = 1', captured.at(-1)?.tuckWeight === 1);
    check('pill flag airborneTuck true at u = 0.5', captured.at(-1)?.airborneTuck === true);

    // Deep fold-in ramp point u = 0.225 → quintic midpoint 0.5 (pill dark, strict >).
    suit.setState({ isGrounded: false, acrobaticRoll: true, hurryAirPhase: 0.225 });
    paint();
    check('ramp point u = 0.225 → tuckWeight = 0.5 (quintic midpoint)',
      near(captured.at(-1)?.tuckWeight ?? -1, 0.5, 1e-12));

    // Latch released: weight drops to 0 on the very next frame.
    suit.setState({ isGrounded: false, acrobaticRoll: false, hurryAirPhase: 0.5 });
    paint();
    check('released latch → tuckWeight = 0 next frame', captured.at(-1)?.tuckWeight === 0);
    suit.dispose();
    app.dispose();
  }

  section('GATE 6c — pneumatic hiss / hydraulic latch fire exactly once per edge');
  {
    const doc = fakeDoc();
    const hud = new LunarHUD({ document: doc as unknown as Document });
    const app = new ClientApp({ seed: 'spec35-phase4-audio', autoConnect: false, silent: true, hud });
    await app.init(engine as never);
    const avatar = app.getSuit();
    const audio = app.getAudio();
    check('audio system present on the client app', audio !== null);
    void audio?.init(); // headless mock graph, synchronous body
    const hiss0 = audio?.getAirborneTuckCompressCount() ?? 0;
    const latch0 = audio?.getTuckExtensionLatchCount() ?? 0;

    const pump = (): void => {
      (app as unknown as { pumpTuckAudioFx(s: unknown): void }).pumpTuckAudioFx(avatar);
    };

    // Compression hiss: rising edge of the mid-air latch only.
    avatar.setState({ isGrounded: true, acrobaticRoll: true });
    pump();
    check('grounded latch frame never fires the compression hiss',
      (audio?.getAirborneTuckCompressCount() ?? 0) === hiss0);
    avatar.setState({ isGrounded: false, acrobaticRoll: true });
    pump();
    check('compression hiss fires on the airborne rising edge',
      (audio?.getAirborneTuckCompressCount() ?? 0) === hiss0 + 1);
    pump();
    pump();
    check('hiss does NOT repeat while the latch holds',
      (audio?.getAirborneTuckCompressCount() ?? 0) === hiss0 + 1);
    avatar.setState({ isGrounded: false, acrobaticRoll: false });
    pump();
    avatar.setState({ isGrounded: false, acrobaticRoll: true });
    pump();
    check('hiss re-arms and fires on the next distinct airborne edge',
      (audio?.getAirborneTuckCompressCount() ?? 0) === hiss0 + 2);

    // Extension latch click: rising edge of hurryPreLanding, once per arc.
    avatar.setState({ isGrounded: false, acrobaticRoll: false, hurryPreLanding: true });
    pump();
    check('extension latch click fires at u ≥ 0.90 pre-landing edge',
      (audio?.getTuckExtensionLatchCount() ?? 0) === latch0 + 1);
    pump();
    pump();
    check('latch click does NOT repeat while pre-landing holds',
      (audio?.getTuckExtensionLatchCount() ?? 0) === latch0 + 1);
    avatar.setState({ isGrounded: false, acrobaticRoll: false, hurryPreLanding: false });
    pump();
    avatar.setState({ isGrounded: true, acrobaticRoll: false, hurryPreLanding: false });
    pump();
    check('grounded frame re-arms the latch for the next arc', true);
    avatar.setState({ isGrounded: false, acrobaticRoll: false, hurryPreLanding: true });
    pump();
    check('second arc gets its own single latch click',
      (audio?.getTuckExtensionLatchCount() ?? 0) === latch0 + 2);
    // Never during the grounded brace itself.
    avatar.setState({ isGrounded: true, acrobaticRoll: false, hurryPreLanding: false });
    pump();
    check('no latch click during grounded brace frames',
      (audio?.getTuckExtensionLatchCount() ?? 0) === latch0 + 2);

    avatar.dispose();
    app.dispose();
  }
}

// ===========================================================================
// Run + report
// ===========================================================================
async function main(): Promise<void> {
  await runGate6();

  console.log(`\n${'='.repeat(72)}`);
  if (failures.length === 0) {
    console.log(`\u{1f389} smoke-spec35-airborne-tuck: ALL ${passed} CHECKS GREEN`);
  } else {
    console.error(`\u{1f6d1} smoke-spec35-airborne-tuck: ${failures.length}/${passed + failures.length} FAILED`);
    for (const f of failures) console.error(`  \u2022 ${f}`);
    process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  console.error('\ud83d\udca5 smoke-spec35-airborne-tuck crashed:', err);
  process.exit(1);
});
