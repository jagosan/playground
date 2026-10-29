/**
 * Spec 31 Phase 5 — Headless Smoke Verification Suite & Build Gate
 * (TASK-PLAY-078f).
 *
 * Runs under `npx tsx scripts/smoke-steelpush-hustle.ts` (exit 0 == all green)
 * on `NullEngine` with a mini fake DOM + the mock Web Audio context. No
 * browser, no sockets, no real audio device. Validates all five Spec 31 §4
 * acceptance gates:
 *
 *   Gate 1 — Dynamic Non-Static Airborne Kinematics (§4 Gate 1):
 *            `hurryStridePose` evaluates continuously and phase-dependently
 *            across u ∈ [0, 1]; samples at u = 0.10 / 0.50 / 0.85 mutate the
 *            hip and knee channels ≥ 0.35 rad off the static takeoff
 *            snapshot (zero frozen statue), and the A→B (u = 0.28) and
 *            B→C (u = 0.72) phase boundaries are C0-continuous.
 *   Gate 2 — Olympic Triple-Jump Hitch-Kick & Stutter Step (§4 Gate 2):
 *            mid-flight (u ∈ [0.28, 0.72]) the trailing leg sweeps forward
 *            ≥ 0.45 rad with knee flexion ≥ 0.90 rad; the leading leg
 *            cycles downward from its high-knee apex into claw prep (hip
 *            ≤ −0.20 rad); at u ≥ 0.85 the landing leg sits in an active
 *            pre-tensioned posture with knee ∈ [0.25, 0.50] rad.
 *   Gate 3 — Ambient Upper-Body Hustle & Rake (§4 Gate 3): torso forward
 *            rake scales dynamically 0.12 rad (7°) at 1.8 m/s → ≥ 0.22 rad
 *            (13°–14°) at 5.2 m/s; thoracic counter-yaw reaches ≥ 0.05 rad
 *            in phase with the leg drive; arms pump ≥ 0.30 rad of shoulder
 *            flexion across the arc; the visor counter-pitches the head at
 *            headPitch = −0.65 × torsoPitch.
 *   Gate 4 — Hydraulic/Pneumatic Assist Boots FX & Audio (§4 Gate 4):
 *            deterministic procedural synthesis headlessly; in a live
 *            1500-frame sprint-bounding simulation the twin pneumatic vents
 *            fire on every launch edge at the pushing boot heel coordinates
 *            (alternating left/right), hydraulic compression + footstep
 *            audio fire on the touchdown edges, pneumatic launch audio fires
 *            on the launch edges, and ZERO distance-odometer footsteps occur
 *            mid-air while bounding.
 *   Gate 5 — Production Build & NPM Script Gate (§4 Gate 5): the
 *            `smoke:steelpush` npm script is registered and the production
 *            `vite build` target is present (build gate runs separately).
 *
 * Mesh-pivot sign law note (Spec 30 §2.2.3, unchanged by Spec 31): positive
 * `rotation.x` swings a hanging limb AFT, negative swings it FORWARD. The
 * Blueprint 31 angles quoted as "aft extension" therefore assert as positive
 * hip values and the "forward" claw/drive angles as negative.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

import {
  BOOT_DUST_HIP_OFFSET_M,
  EvaSuitAvatar,
  HEAD_HORIZON_STABILITY_RATIO,
  HURRY_PUMP_RECOVERY_AMP_RAD,
  HURRY_PUMP_STANCE_AMP_RAD,
  HURRY_SPRINT_RAKE_MAX_RAD,
  HURRY_SPINE_PULSE_RAD,
  HURRY_THORACIC_YAW_RAD,
  HURRY_TORSO_PITCH_FWD_RAD,
  hurryStridePose,
} from '../src/entities/AstronautSuit.ts';
import type { HurryStridePose } from '../src/entities/AstronautSuit.ts';
import {
  IDLE_SUIT_INPUT,
  LUNAR_GRAVITY,
  SUIT_HURRY_FLIGHT_TIME_S,
  SUIT_HURRY_LAUNCH_VZ,
  SUIT_HURRY_MIN_SPEED,
  SUIT_HURRY_TARGET_SPEED,
} from '../src/physics/TraversalPhysics.ts';
import type { HurryStrideLeg, SuitState } from '../src/physics/TraversalPhysics.ts';
import { LunarAudioSystem } from '../src/audio/LunarAudioSystem.ts';
import { ClientApp } from '../src/client/ClientApp.ts';

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

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

const HERE = typeof __filename !== 'undefined' ? dirname(__filename) : process.cwd();
const DT = 1 / 60;
const FLAT = () => 0;
const SPRINT = { ...IDLE_SUIT_INPUT, forward: 1.0, sprint: true };

/** All articulation channels the stride law emits, for sweep scans. */
const CHANNELS: Record<string, (p: HurryStridePose) => number> = {
  hipL: (p) => p.hipLx,
  hipR: (p) => p.hipRx,
  kneeL: (p) => p.kneeLx,
  kneeR: (p) => p.kneeRx,
  shoulderL: (p) => p.shoulderLx,
  shoulderR: (p) => p.shoulderRx,
  elbowL: (p) => p.elbowLx,
  elbowR: (p) => p.elbowRx,
  torsoPitch: (p) => p.torsoPitchRad,
  torsoYaw: (p) => p.torsoYawRad,
  torsoRoll: (p) => p.torsoRollRad,
  headPitch: (p) => p.headPitchRad,
};
const CHANNEL_NAMES = Object.keys(CHANNELS);

/** Max |a − b| over every stride-law channel. */
function maxChannelDelta(a: HurryStridePose, b: HurryStridePose): number {
  let m = 0;
  for (const name of CHANNEL_NAMES) {
    m = Math.max(m, Math.abs(CHANNELS[name]!(a) - CHANNELS[name]!(b)));
  }
  return m;
}

/** Max |f(u)| over the named channel group across a u-sweep. */
function maxAbsOver(
  us: number[],
  channelNames: string[],
  strideLeg: HurryStrideLeg,
  speed: number,
): number {
  let m = 0;
  for (const u of us) {
    const p = hurryStridePose(strideLeg, true, u, speed);
    for (const c of channelNames) m = Math.max(m, Math.abs(CHANNELS[c]!(p)));
  }
  return m;
}

const f3 = (v: number): string => v.toFixed(3);

// ===========================================================================
// GATE 1 — Dynamic Non-Static Airborne Kinematics (Spec 31 §4 Gate 1)
// ===========================================================================

function gate1AirborneKinematics(): void {
  section('GATE 1 — dynamic non-static airborne kinematics (§4 Gate 1)');

  // Analytical ballistic hangtime the phase clock rides: τ = 2·v_launch / g.
  check(
    `τ_flight = 2·${SUIT_HURRY_LAUNCH_VZ}/1.62 ≈ ${SUIT_HURRY_FLIGHT_TIME_S.toFixed(4)} s identity`,
    Math.abs(SUIT_HURRY_FLIGHT_TIME_S - (2 * SUIT_HURRY_LAUNCH_VZ) / LUNAR_GRAVITY) < 1e-12
    && SUIT_HURRY_FLIGHT_TIME_S > 0.95,
  );

  // -- Continuity: dense sweep u ∈ [0, 1], every channel finite with a
  // bounded step-to-step slope (max curve slope ≈ 4 rad/phase ⇒ < 0.03 per
  // 0.005-u step; a jump discontinuity would blow straight through it).
  {
    let finiteOk = true;
    let slopeOk = true;
    let prev: HurryStridePose | null = null;
    for (let u = 0; u <= 1.0000001; u += 0.005) {
      const p = hurryStridePose('left', true, Math.min(1, u), SUIT_HURRY_TARGET_SPEED);
      for (const name of CHANNEL_NAMES) {
        if (!Number.isFinite(CHANNELS[name]!(p))) finiteOk = false;
      }
      if (prev !== null) {
        for (const name of CHANNEL_NAMES) {
          if (Math.abs(CHANNELS[name]!(p) - CHANNELS[name]!(prev)) > 0.03) slopeOk = false;
        }
      }
      prev = p;
    }
    check('pose evaluates continuously + finitely across u ∈ [0, 1] (201-step sweep)',
      finiteOk && slopeOk);
    // The phase clock clamps outside the unit interval (u = clamp(t/τ, 0, 1)).
    const clampedHi = maxChannelDelta(
      hurryStridePose('left', true, 1.5, 5.2),
      hurryStridePose('left', true, 1.0, 5.2),
    );
    const clampedLo = maxChannelDelta(
      hurryStridePose('left', true, -0.4, 5.2),
      hurryStridePose('left', true, 0.0, 5.2),
    );
    check(`phase clamps at both ends (u = 1.5 ≡ u = 1, u = −0.4 ≡ u = 0)`,
      clampedHi < 1e-12 && clampedLo < 1e-12,
      `hi=${clampedHi} lo=${clampedLo}`);
  }

  // -- Zero frozen statue: samples mutate ≥ 0.35 rad off the STATIC takeoff
  // snapshot (the phaseless canonical Spec 30 pose).
  const staticTakeoff = hurryStridePose('left', true);
  const uSamples = [0.1, 0.5, 0.85];
  const sampled = uSamples.map((u) => hurryStridePose('left', true, u, SUIT_HURRY_TARGET_SPEED));
  {
    const hipDev = Math.max(
      ...sampled.map((p) => Math.max(Math.abs(p.hipLx - staticTakeoff.hipLx),
        Math.abs(p.hipRx - staticTakeoff.hipRx))),
    );
    const kneeDev = Math.max(
      ...sampled.map((p) => Math.max(Math.abs(p.kneeLx - staticTakeoff.kneeLx),
        Math.abs(p.kneeRx - staticTakeoff.kneeRx))),
    );
    check(`hip channel mutates ${f3(hipDev)} rad ≥ 0.35 off static takeoff snapshot`,
      hipDev >= 0.35, `hipDev=${hipDev}`);
    check(`knee channel mutates ${f3(kneeDev)} rad ≥ 0.35 off static takeoff snapshot`,
      kneeDev >= 0.35, `kneeDev=${kneeDev}`);
  }
  // Spec §4 wording: hip AND knee at the deep-flight sample (u = 0.85) each
  // individually clear the 0.35 rad bar against the frozen-pose baseline.
  {
    const p = hurryStridePose('left', true, 0.85, SUIT_HURRY_TARGET_SPEED);
    const hipD = Math.max(Math.abs(p.hipLx - staticTakeoff.hipLx),
      Math.abs(p.hipRx - staticTakeoff.hipRx));
    const kneeD = Math.max(Math.abs(p.kneeLx - staticTakeoff.kneeLx),
      Math.abs(p.kneeRx - staticTakeoff.kneeRx));
    check(`u = 0.85 vs static takeoff: hip Δ${f3(hipD)} AND knee Δ${f3(kneeD)} both ≥ 0.35 rad`,
      hipD >= 0.35 && kneeD >= 0.35);
  }
  // Knee at u = 0.50 vs u = 0.10 (Spec 31 §4 literal delta gate).
  {
    const kneeD = Math.max(
      Math.abs(sampled[1]!.kneeLx - sampled[0]!.kneeLx),
      Math.abs(sampled[1]!.kneeRx - sampled[0]!.kneeRx),
    );
    check(`knee angle at u = 0.50 differs from u = 0.10 by ${f3(kneeD)} rad ≥ 0.35`,
      kneeD >= 0.35, `kneeD=${kneeD}`);
  }
  // Consecutive samples are distinct poses (no two u's collapse together).
  {
    const dA = maxChannelDelta(sampled[0]!, sampled[1]!);
    const dB = maxChannelDelta(sampled[1]!, sampled[2]!);
    check(`u-samples are pairwise-distinct poses (Δ ${f3(dA)} / ${f3(dB)} rad > 0.1)`,
      dA > 0.1 && dB > 0.1);
  }

  // -- Phase-boundary continuity. Boundary-lag discipline (operations rule):
  // the one-sided lag itself injects slope×lag into the difference, so use
  // lag = 1e-12 (max slope ≈ 4 rad/u ⇒ ~4e-12 ≪ 1e-6 gate).
  for (const [name, b] of [['A→B', 0.28], ['B→C', 0.72]] as const) {
    const here = hurryStridePose('left', true, b, SUIT_HURRY_TARGET_SPEED);
    const before = hurryStridePose('left', true, b - 1e-12, SUIT_HURRY_TARGET_SPEED);
    const after = hurryStridePose('left', true, b + 1e-12, SUIT_HURRY_TARGET_SPEED);
    const dBefore = maxChannelDelta(here, before);
    const dAfter = maxChannelDelta(here, after);
    check(`phase boundary ${name} (u = ${b}) continuous from both sides (all channels < 1e-6)`,
      dBefore < 1e-6 && dAfter < 1e-6, `Δ⁻=${dBefore} Δ⁺=${dAfter}`);
  }
}

// ===========================================================================
// GATE 2 — Olympic Triple-Jump Hitch-Kick & Stutter Step (Spec 31 §4 Gate 2)
// ===========================================================================

function gate2TripleJump(): void {
  section('GATE 2 — Olympic triple-jump hitch-kick & stutter step (§4 Gate 2)');

  const SPEED = SUIT_HURRY_TARGET_SPEED;
  // Mid-flight window scan (u strictly inside the stutter window).
  const midUs: number[] = [];
  for (let u = 0.28; u < 0.72; u += 0.005) midUs.push(u);

  // Trailing (former pushing) leg whips forward into a tight pelvic tuck.
  {
    let kneeMax = 0;
    let kneeMaxU = 0;
    let hipStart = hurryStridePose('left', true, 0.28, SPEED).hipRx; // aft extension
    let hipMin = Infinity;
    let sawForward = false;
    for (const u of midUs) {
      const p = hurryStridePose('left', true, u, SPEED);
      // strideLeg = 'left' airborne ⇒ right hip carries the pushing/trailing leg.
      kneeMax = Math.max(kneeMax, p.kneeRx);
      kneeMaxU = kneeMax === p.kneeRx ? u : kneeMaxU;
      hipMin = Math.min(hipMin, p.hipRx);
      if (p.hipRx < 0) sawForward = true;
    }
    const sweep = hipStart - hipMin;
    check(`trailing-leg knee flexes to ${f3(kneeMax)} rad ≥ 0.90 mid-flight (peak at u=${kneeMaxU.toFixed(3)})`,
      kneeMax >= 0.9 && kneeMaxU > 0.28 && kneeMaxU < 0.72);
    check(`trailing-leg hip sweeps forward ${f3(sweep)} rad ≥ 0.45 (aft ${f3(hipStart)} → forward ${f3(hipMin)})`,
      sweep >= 0.45 && sawForward);
  }

  // Stutter perturbation s(u) = sin(π·tB) rides the hip channel at ±0.08 rad.
  {
    const lerpHipPush = (u: number): number => 0.62 + (-0.35 - 0.62) * ((u - 0.28) / 0.44);
    let maxPerturb = 0;
    for (const u of midUs) {
      const p = hurryStridePose('left', true, u, SPEED);
      maxPerturb = Math.max(maxPerturb, Math.abs(p.hipRx - lerpHipPush(u)));
    }
    check(`sin(π·tB) stutter modulation peaks at ${f3(maxPerturb)} rad ≈ 0.08 over the lerp ramp`,
      Math.abs(maxPerturb - 0.08) < 0.002, `maxPerturb=${maxPerturb}`);
    const mid = hurryStridePose('left', true, 0.5, SPEED);
    check(`stutter offset at u = 0.5 (s = 1) is exactly +0.08 rad`,
      Math.abs(mid.hipRx - lerpHipPush(0.5) - 0.08) < 1e-12);
  }

  // Leading leg cycles downward from its high-knee apex into claw prep.
  {
    const apex = hurryStridePose('left', true, 0.28, SPEED);
    let descending = true;
    let prevKnee = Infinity;
    for (const u of midUs) {
      const knee = hurryStridePose('left', true, u, SPEED).kneeLx; // left = leading leg
      if (knee > prevKnee + 1e-12) descending = false;
      prevKnee = knee;
    }
    const endKnee = hurryStridePose('left', true, 0.72, SPEED).kneeLx;
    check(`leading leg cycles down from apex knee ${f3(apex.kneeLx)} → ${f3(endKnee)} monotonically`,
      descending && endKnee < apex.kneeLx - 0.5);
    // Claw prep: hip breaks past −0.20 rad forward reach in phase C.
    let hipMin = 0;
    for (let u = 0.72; u <= 1.0000001; u += 0.005) {
      hipMin = Math.min(hipMin, hurryStridePose('left', true, Math.min(1, u), SPEED).hipLx);
    }
    const at85 = hurryStridePose('left', true, 0.85, SPEED);
    check(`leading leg claws down to hip ${f3(hipMin)} rad ≤ −0.20 (at u = 0.85: ${f3(at85.hipLx)})`,
      hipMin <= -0.2 && at85.hipLx <= -0.2);
  }

  // Touchdown prep at u ≥ 0.85: active pre-tensioned landing posture.
  {
    const us = [0.85, 0.9, 0.95, 0.98, 1.0];
    const knees = us.map((u) => hurryStridePose('left', true, u, SPEED).kneeLx);
    const hips = us.map((u) => hurryStridePose('left', true, u, SPEED).hipLx);
    check(`landing-leg knee pre-tensioned in [0.25, 0.50] rad across u ≥ 0.85 (${knees.map(f3).join(' → ')})`,
      knees.every((k) => k >= 0.25 && k <= 0.5));
    check(`landing leg reaches forward (hip negative) in the pre-tension window (${hips.map(f3).join(' → ')})`,
      hips.every((h) => h <= -0.2));
  }
}

// ===========================================================================
// GATE 3 — Ambient Upper-Body Hustle & Rake (Spec 31 §4 Gate 3)
// ===========================================================================

function gate3Hustle(): void {
  section('GATE 3 — ambient upper-body hustle & rake (§4 Gate 3)');

  // u = 0 carries zero spinal breathing pulse (sin(2π·0) = 0), isolating the
  // pure speed→rake law.
  const rakeAt = (speed: number, u = 0): number =>
    hurryStridePose('left', true, u, speed).torsoPitchRad;

  {
    const slow = rakeAt(SUIT_HURRY_MIN_SPEED);
    const fast = rakeAt(SUIT_HURRY_TARGET_SPEED);
    check(`torso rake at ${SUIT_HURRY_MIN_SPEED} m/s = ${f3(slow)} rad ≈ 0.12 (7°)`,
      Math.abs(slow - HURRY_TORSO_PITCH_FWD_RAD) < 1e-9 && HURRY_TORSO_PITCH_FWD_RAD === 0.12);
    check(`torso rake at ${SUIT_HURRY_TARGET_SPEED} m/s = ${f3(fast)} rad ≥ 0.22 (13°–14°)`,
      fast >= 0.22 && HURRY_SPRINT_RAKE_MAX_RAD === 0.24);
    const speeds = [1.8, 2.5, 3.2, 3.9, 3.95, 4.6, 5.2];
    const rakes = speeds.map((v) => rakeAt(v));
    let mono = true;
    for (let i = 1; i < rakes.length; i++) mono = mono && rakes[i]! > rakes[i - 1]!;
    check(`rake scales monotonically with horizontal speed (${speeds.map(f3).join('→')})`, mono);
    // Above the cruise cap the rake pins (clamped band), below it floors.
    check('rake clamps at the 14° cap above 5.2 m/s and floors at 7° below 1.8 m/s',
      Math.abs(rakeAt(7.5) - 0.24) < 1e-12 && Math.abs(rakeAt(0.2) - 0.12) < 1e-12);
  }

  // Thoracic counter-yaw: peaks with the takeoff leg drive on ±cos(πu).
  {
    let yawMax = 0;
    let prevAbs = Infinity;
    let phaseOk = true;
    for (let u = 0; u <= 0.5000001; u += 0.005) {
      const y = Math.abs(hurryStridePose('left', true, Math.min(1, u), 5.2).torsoYawRad);
      yawMax = Math.max(yawMax, y);
      if (y > prevAbs + 1e-12) phaseOk = false; // |yaw| must decay with the stride
      prevAbs = y;
    }
    check(`thoracic counter-yaw reaches ${f3(yawMax)} rad ≥ 0.05 (≈ 3°–4°)`,
      yawMax >= 0.05 && HURRY_THORACIC_YAW_RAD === 0.07);
    check('counter-yaw is phase-locked to the stride (|yaw| ∝ |cos πu|, decaying takeoff→landing)',
      phaseOk && Math.abs(hurryStridePose('left', true, 1, 5.2).torsoYawRad - -0.07) < 1e-12);
    const leftYaw = hurryStridePose('left', true, 0.13, 5.2).torsoYawRad;
    const rightYaw = hurryStridePose('right', true, 0.13, 5.2).torsoYawRad;
    check(`counter-yaw flips sign with the active drive leg (left ${f3(leftYaw)} vs right ${f3(rightYaw)})`,
      leftYaw * rightYaw < 0 && Math.abs(leftYaw + rightYaw) < 1e-12);
  }

  // Active arm sprint pumping: −cos(πu) anti-phase shoulder cycle.
  // NOTE: with strideLeg = 'left' airborne the power/stance side is the RIGHT
  // hip/arm (powerIsLeft = !strideLegIsLeft), so the stance channels here are
  // the *_Rx shoulder and elbow; the left-side channels carry the recovery.
  {
    const stanceShoulder = (u: number): number =>
      hurryStridePose('left', true, u, 5.2).shoulderRx; // stance = right arm
    const recoveryShoulder = (u: number): number =>
      hurryStridePose('left', true, u, 5.2).shoulderLx;
    let min = Infinity;
    let max = -Infinity;
    for (let u = 0; u <= 1.0000001; u += 0.005) {
      const v = stanceShoulder(Math.min(1, u));
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    const span = max - min;
    const launchToMid = Math.abs(stanceShoulder(0.5) - stanceShoulder(0));
    check(`stance arm pumps ${f3(span)} rad of shoulder flexion across the flight arc ≥ 0.30`,
      span >= 0.30 && HURRY_PUMP_STANCE_AMP_RAD === 0.55);
    check(`launch → mid-flight arm travel ${f3(launchToMid)} rad ≥ 0.30 (no locked mid-air arms)`,
      launchToMid >= 0.30);
    const recSpan = Math.abs(recoveryShoulder(0) - recoveryShoulder(1));
    check(`recovery arm counter-pumps ${f3(recSpan)} rad (±${HURRY_PUMP_RECOVERY_AMP_RAD})`,
      Math.abs(recSpan - 2 * HURRY_PUMP_RECOVERY_AMP_RAD) < 1e-9);
    // Arms run anti-phase: stance and recovery shoulders oppose.
    let antiPhase = true;
    for (const u of [0.05, 0.2, 0.4, 0.6, 0.8, 0.95]) {
      const p = hurryStridePose('left', true, u, 5.2);
      if (!(p.shoulderLx * p.shoulderRx < 0)) antiPhase = false;
    }
    check('arms pump in anti-phase (stance × recovery shoulder sign opposition, ±0.55/±0.45)',
      antiPhase && HURRY_PUMP_RECOVERY_AMP_RAD === 0.45);
    // Elbows flex dynamically with the pump: forward drive rides the rest
    // angle, full rear drive adds the stance-elbow flex term (0.5 rad).
    const elbowAt = (u: number): number => hurryStridePose('left', true, u, 5.2).elbowRx;
    check(`stance elbow flexes from ${f3(elbowAt(0))} rad at the forward drive to ${f3(elbowAt(1))} rad at full rear swing (Δ ${f3(elbowAt(1) - elbowAt(0))} ≥ 0.30)`,
      elbowAt(1) - elbowAt(0) >= 0.3);
  }

  // Visor horizon stabilization: headPitch = −0.65 × torsoPitch.
  {
    let ratioOk = true;
    let counterOk = true;
    for (let u = 0; u <= 1.0000001; u += 0.005) {
      for (const v of [1.8, 3.5, 5.2]) {
        const p = hurryStridePose('left', true, Math.min(1, u), v);
        if (Math.abs(p.headPitchRad - HEAD_HORIZON_STABILITY_RATIO * p.torsoPitchRad) > 1e-12) ratioOk = false;
        if (!(p.headPitchRad * p.torsoPitchRad < 0)) counterOk = false;
      }
    }
    check('visor law holds every sample: headPitch = −0.65 × torsoPitch',
      ratioOk && HEAD_HORIZON_STABILITY_RATIO === -0.65);
    check('head counter-pitches AGAINST the torso rake (opposite signs — horizon stays in the visor)',
      counterOk);
    const sprint = hurryStridePose('left', true, 0, 5.2);
    check(`at sprint cruise: torso ${f3(sprint.torsoPitchRad)} rad forward vs visor ${f3(sprint.headPitchRad)} rad counter-lift`,
      sprint.torsoPitchRad > 0.22 && sprint.headPitchRad < -0.15);
  }
}

// ===========================================================================
// GATE 4 — Hydraulic/Pneumatic Assist Boots FX & Audio (Spec 31 §4 Gate 4)
// ===========================================================================

/** Signed forward/lateral component of a world offset relative to heading. */
function lateralOf(
  p: { x: number; y: number },
  s: { x: number; y: number; heading?: number },
): number {
  const h = s.heading ?? 0;
  return (p.x - s.x) * -Math.sin(h) + (p.y - s.y) * Math.cos(h);
}

// -- 4a: deterministic procedural synthesis (mock Web Audio, headless) ------

function gate4AudioSynthesis(): void {
  section('GATE 4a — assist-boot procedural audio synthesis (headless mock nodes)');

  // Safe no-op before init().
  const cold = new LunarAudioSystem();
  cold.playHydraulicCompression();
  cold.playPneumaticLaunch();
  const coldCues = cold.getSteelpushCueTimes();
  check('cues are safe silent no-ops before init() (counts 0, times −∞)',
    coldCues.compressionCount === 0 && coldCues.launchCount === 0
    && coldCues.compressionAt === Number.NEGATIVE_INFINITY
    && coldCues.launchAt === Number.NEGATIVE_INFINITY);

  const audio = new LunarAudioSystem();
  void audio.init(); // async fn, sync body — mock graph built on this line
  check('LunarAudioSystem boots headless on the mock AudioContext',
    audio.getHydraulicCompressionCount() === 0 && audio.getPneumaticLaunchCount() === 0);

  audio.playHydraulicCompression();
  audio.playHydraulicCompression();
  audio.playPneumaticLaunch();
  audio.playHydraulicCompression();
  audio.playPneumaticLaunch();
  const cues = audio.getSteelpushCueTimes();
  check(`hydraulic compression + pneumatic launch execute deterministically (3 compressions, 2 launches fired)`,
    cues.compressionCount === 3 && cues.launchCount === 2,
    `c=${cues.compressionCount} l=${cues.launchCount}`);
  check('cue context-times are finite, scheduled and strictly ordered',
    Number.isFinite(cues.compressionAt) && Number.isFinite(cues.launchAt)
    && cues.launchAt >= cues.compressionAt - 1e-9);
  audio.dispose();
}

// -- 4b: live bare-avatar simulation — vent FX on the launch edges ----------

function gate4AvatarVents(): void {
  section('GATE 4b — live avatar sim: twin pneumatic vents on every Steelpush launch');

  const avatar = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } });
  avatar.init(); // self-owned NullEngine fallback
  check('EvaSuitAvatar builds headless (NullEngine)', avatar.isBuilt() === true);

  interface VentEvent {
    frame: number;
    x: number;
    y: number;
    z: number;
    lat: number;
    side: 'left' | 'right';
    strideLeg: HurryStrideLeg;
    airborne: boolean;
  }
  const vents: VentEvent[] = [];
  const dusts: { frame: number; lat: number; side: string }[] = [];

  let launches = 0;
  let touchdowns = 0;
  let prevGrounded = true;
  let flightRunStart = -1;
  let ventCountSeen = 0;
  let dustCountSeen = 0;
  let lawOk = 0;
  let headOk = 0;
  let flightSamples = 0;

  // Live pivots for the stride-law fidelity check (Spec 30 smoke precedent:
  // joint pivots are TransformNodes reached through the mesh parent chain).
  const nodes = new Map<string, TransformNode>();
  for (const m of avatar.getMeshes()) {
    let n = m.parent as TransformNode | null;
    while (n !== null) {
      if (!nodes.has(n.name)) nodes.set(n.name, n);
      n = n.parent as TransformNode | null;
    }
  }
  const pivotOf = (name: string): TransformNode => {
    const node = nodes.get(name);
    if (node === undefined) throw new Error(`avatar pivot ${name} missing`);
    return node;
  };
  const hipL = pivotOf('eva-hip-l');
  const hipR = pivotOf('eva-hip-r');
  const kneeL = pivotOf('eva-kneejoint-l');
  const kneeR = pivotOf('eva-kneejoint-r');
  const upper = pivotOf('eva-upper-body');
  const head = pivotOf('eva-head');

  for (let i = 0; i < 1500; i++) {
    const s = avatar.update(DT, SPRINT);

    // Stride-law fidelity on the live pivots (mirrors Spec 31 Phase 3 gate):
    // airborne frames must equal pose(strideLeg, true, livePhase, liveSpeed).
    if (s.gaitMode === 'bounding' && !s.isGrounded) {
      flightSamples++;
      const pose = hurryStridePose(
        s.hurryStrideLeg ?? 'left',
        true,
        s.hurryAirPhase ?? 0,
        Math.hypot(s.vx, s.vy),
      );
      if (Math.abs(hipL.rotation.x - pose.hipLx) < 1e-9
        && Math.abs(hipR.rotation.x - pose.hipRx) < 1e-9
        && Math.abs(kneeL.rotation.x - pose.kneeLx) < 1e-9
        && Math.abs(kneeR.rotation.x - pose.kneeRx) < 1e-9
        && Math.abs(upper.rotation.x - pose.torsoPitchRad) < 1e-9
        && Math.abs(upper.rotation.y - pose.torsoYawRad) < 1e-9) lawOk++;
      if (Math.abs(head.rotation.x - HEAD_HORIZON_STABILITY_RATIO * upper.rotation.x) < 1e-9) headOk++;
    }

    // Launch / touchdown edges on the physics oracle.
    if (prevGrounded && !s.isGrounded && s.gaitMode === 'bounding') {
      launches++;
      flightRunStart = i;
    } else if (!prevGrounded && s.isGrounded && s.gaitMode === 'bounding') {
      touchdowns++;
    }
    prevGrounded = s.isGrounded;

    // Pneumatic vent FX edge from the avatar.
    const vc = avatar.getPneumaticVentCount();
    if (vc > ventCountSeen) {
      ventCountSeen = vc;
      const p = avatar.getLastPneumaticVentPos();
      if (p !== null) {
        const lat = lateralOf(p, s);
        vents.push({
          frame: i,
          x: p.x,
          y: p.y,
          // Sole z is recorded relative to the SAME frame's state centre (the
          // launch frame already rides ~vz·dt above the regolith datum).
          z: p.z - s.z,
          lat,
          side: lat < 0 ? 'left' : 'right',
          strideLeg: s.hurryStrideLeg ?? 'left',
          airborne: !s.isGrounded,
        });
      }
    }

    // Regolith dust edge (Spec 30 companion — must accompany the touchdown).
    const dc = avatar.getBootDustPuffCount();
    if (dc > dustCountSeen) {
      dustCountSeen = dc;
      const p = avatar.getLastBootDustPuffPos();
      if (p !== null) dusts.push({ frame: i, lat: lateralOf(p, s), side: s.hurryStrideLeg ?? '?' });
    }
  }

  check(`sprint-bounding sim produced ≥ 4 launches (${launches} launches, ${touchdowns} touchdowns)`,
    launches >= 4 && touchdowns >= 4);
  check(`live pivots ride the dynamic stride law every airborne frame (${lawOk}/${flightSamples})`,
    flightSamples > 200 && lawOk === flightSamples);
  check(`live visor horizon lock tracks −0.65 × torso pitch (${headOk}/${flightSamples})`,
    flightSamples > 0 && headOk === flightSamples);
  check(`twin pneumatic vents fire once per launch edge (${vents.length} vents vs ${launches} launches)`,
    vents.length === launches && vents.length >= 4);
  check('every vent fires ON the airborne launch edge (first frame of the flight arc)',
    vents.every((v) => v.airborne) && vents.length >= 4);
  check(`vents sit at the pushing-boot heel (±${BOOT_DUST_HIP_OFFSET_M} m d_hip, sole z)`,
    vents.every((v) => Math.abs(Math.abs(v.lat) - BOOT_DUST_HIP_OFFSET_M) < 1e-9
      && Math.abs(v.z) < 1e-12),
    vents.slice(0, 3).map((v) => `lat=${v.lat.toFixed(3)}`).join(' '));
  check('vent side is the PUSHING leg — opposite the stride leg receiving the next touchdown',
    vents.every((v) => (v.strideLeg === 'left' ? 'right' : 'left') === v.side),
    vents.slice(0, 4).map((v) => `${v.side}←${v.strideLeg}`).join(' '));
  {
    let alternates = vents.length >= 4;
    for (let k = 1; k < vents.length; k++) alternates = alternates && vents[k]!.side !== vents[k - 1]!.side;
    check(`pneumatic vent puffs alternate left/right coordinates (${vents.map((v) => v.side[0]).join('→')})`,
      alternates);
    let distinct = true;
    for (let k = 1; k < vents.length; k++) {
      distinct = distinct
        && Math.hypot(vents[k]!.x - vents[k - 1]!.x, vents[k]!.y - vents[k - 1]!.y) > 0.5;
    }
    check('consecutive vent origins are distinct world points (one plume per boot, per leap)', distinct);
  }
  check(`regolith dust puffs accompany the touchdowns (${dusts.length} puffs ≥ 4)`, dusts.length >= 4);
  check('dust puffs land on the touchdown frames at the stride-leg sole',
    dusts.every((d) => Math.abs(Math.abs(d.lat) - BOOT_DUST_HIP_OFFSET_M) < 1e-9));

  avatar.dispose();
}

// -- 4c: live ClientApp simulation — assist-boot audio cues on the edges ----

interface FakeElement {
  id: string;
  className: string;
  textContent: string | null;
  style: Record<string, string>;
  classList: { add(n: string): void; remove(n: string): void; contains(n: string): boolean };
  children: FakeElement[];
  parent: FakeElement | null;
  attributes: Map<string, string>;
  appendChild<T>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  const make = (): FakeElement => {
    const attributes = new Map<string, string>();
    const children: FakeElement[] = [];
    const el: FakeElement = {
      id: '',
      className: '',
      textContent: null,
      style: {},
      classList: {
        add(n) {
          const s = new Set(el.className.split(/\s+/).filter(Boolean));
          s.add(n);
          el.className = [...s].join(' ');
        },
        remove(n) {
          const s = new Set(el.className.split(/\s+/).filter(Boolean));
          s.delete(n);
          el.className = [...s].join(' ');
        },
        contains(n) {
          return el.className.split(/\s+/).includes(n);
        },
      },
      children,
      parent: null,
      attributes,
      appendChild(child) {
        (child as FakeElement).parent = el;
        children.push(child as FakeElement);
        return child;
      },
      remove() {
        if (el.parent !== null) {
          const i = el.parent.children.indexOf(el);
          if (i >= 0) el.parent.children.splice(i, 1);
        }
        registry.delete(el.id);
      },
      getAttribute: (n) => attributes.get(n) ?? null,
      setAttribute(n, v) {
        attributes.set(n, v);
        if (n === 'id') {
          el.id = v;
          registry.set(v, el);
        }
      },
      addEventListener() {},
      removeEventListener() {},
    };
    return el;
  };
  return {
    body: make(),
    createElement: () => make(),
    getElementById: (id: string) => registry.get(id) ?? null,
    addEventListener() {},
    removeEventListener() {},
  };
}

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

async function gate4ClientAppAudio(): Promise<void> {
  section('GATE 4c — live ClientApp sim: assist-boot audio on touchdown/launch edges');

  const storage = new MemoryStorage();
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  (globalThis as { document?: unknown }).document = makeFakeDocument();

  const app = new ClientApp({
    seed: 'spec31-hustle',
    username: 'hustle',
    faction: 'CEC',
    silent: true,
    introQuery: 'skip_intro=1', // straight to the surface — no cinematic gate
  });
  await app.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));
  check('ClientApp boots headless to the surface (skip_intro, NullEngine)',
    app.getMode() === 'suit');

  const audio = app.getAudio();
  check('procedural audio system live on the mock context', audio !== null);
  if (audio === null) {
    app.dispose();
    return;
  }

  // Instrument the three assist-boot cues with (frame, grounded) stamps.
  let frameIdx = -1;
  interface CueEvent { frame: number; grounded: boolean }
  const compressionEvents: CueEvent[] = [];
  const launchEvents: CueEvent[] = [];
  const footstepEvents: CueEvent[] = [];
  const origCompression = audio.playHydraulicCompression.bind(audio);
  const origLaunch = audio.playPneumaticLaunch.bind(audio);
  const origFootstep = audio.playFootstep.bind(audio);
  audio.playHydraulicCompression = (): void => {
    compressionEvents.push({ frame: frameIdx, grounded: app.getSuit().getState().isGrounded });
    origCompression();
  };
  audio.playPneumaticLaunch = (): void => {
    launchEvents.push({ frame: frameIdx, grounded: app.getSuit().getState().isGrounded });
    origLaunch();
  };
  audio.playFootstep = (): void => {
    footstepEvents.push({ frame: frameIdx, grounded: app.getSuit().getState().isGrounded });
    origFootstep();
  };

  // 1500 frames of held sprint throttle (KeyW + Shift) through ClientApp's
  // real update() → stepEntities → pumpAudio → pumpFootstepAudio pipeline.
  app.handleKeyInput('KeyW', 'down');
  app.handleKeyInput('ShiftLeft', 'down');

  let nowMs = 0;
  let prevGrounded: boolean | null = null;
  let touchdownEdges = 0;
  let launchEdges = 0;
  let boundingFrames = 0;
  let airborneTravel = 0;
  let prevPos: { x: number; y: number } | null = null;

  for (frameIdx = 0; frameIdx < 1500; frameIdx++) {
    nowMs += 1000 / 60;
    app.update(nowMs);
    const s: SuitState = app.getSuit().getState();
    if (s.gaitMode === 'bounding') boundingFrames++;
    if (prevGrounded === false && s.isGrounded && s.gaitMode === 'bounding') touchdownEdges++;
    else if (prevGrounded === true && !s.isGrounded && s.gaitMode === 'bounding') launchEdges++;
    prevGrounded = s.isGrounded;
    const p = app.getSuit().getPosition();
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      throw new Error(`non-finite suit position at frame ${frameIdx}: ${JSON.stringify(p)}`);
    }
    if (prevPos !== null && !s.isGrounded && s.gaitMode === 'bounding') {
      airborneTravel += Math.hypot(p.x - prevPos.x, p.y - prevPos.y);
    }
    prevPos = { x: p.x, y: p.y };
  }

  const cues = audio.getSteelpushCueTimes();
  check(`live bounding engaged under sprint throttle (${boundingFrames} bounding frames)`,
    boundingFrames > 200);
  check(`physics oracle saw paired edges (${launchEdges} launches / ${touchdownEdges} touchdowns)`,
    launchEdges >= 3 && touchdownEdges >= 3);

  check(`hydraulic compression fires on every touchdown edge (${compressionEvents.length} cues / ${touchdownEdges} edges, engine count ${cues.compressionCount})`,
    compressionEvents.length === touchdownEdges && cues.compressionCount >= touchdownEdges);
  check('every hydraulic compression fires grounded on its touchdown edge frame',
    compressionEvents.length >= 3 && compressionEvents.every((e) => e.grounded));

  check(`pneumatic launch audio fires on every launch edge (${launchEvents.length} cues / ${launchEdges} edges, engine count ${cues.launchCount})`,
    launchEvents.length === launchEdges && cues.launchCount >= launchEdges);
  check('every pneumatic launch cue fires airborne on its launch edge frame',
    launchEvents.length >= 3 && launchEvents.every((e) => !e.grounded));

  check(`footsteps fire only on touchdown contacts (${footstepEvents.length} steps / ${touchdownEdges} touchdowns)`,
    footstepEvents.length === touchdownEdges && footstepEvents.every((e) => e.grounded));
  check(`ZERO mid-air distance-odometer footsteps during bounding (${airborneTravel.toFixed(1)} m flown, 0 steps aloft)`,
    airborneTravel > 5 && footstepEvents.every((e) => e.grounded));

  // The avatar-side vent FX runs inside the same ClientApp avatar too.
  check(`ClientApp avatar's twin vent emitters tracked every launch (${app.getSuit().getPneumaticVentCount()} vents / ${launchEdges} edges)`,
    app.getSuit().getPneumaticVentCount() === launchEdges);

  app.dispose();
  delete (globalThis as { localStorage?: Storage }).localStorage;
  delete (globalThis as { document?: unknown }).document;
}

// ===========================================================================
// GATE 5 — Production Build & NPM Script Gate (Spec 31 §4 Gate 5)
// ===========================================================================

function gate5Build(): void {
  section('GATE 5 — npm script registration & production build gate');

  const pkg = JSON.parse(
    readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  check('npm script smoke:steelpush registered → npx tsx scripts/smoke-steelpush-hustle.ts',
    pkg.scripts['smoke:steelpush'] === 'npx tsx scripts/smoke-steelpush-hustle.ts',
    `got: ${pkg.scripts['smoke:steelpush']}`);
  check('production build script present (vite build) — gate runs separately in CI',
    typeof pkg.scripts.build === 'string' && pkg.scripts.build.includes('vite build'));
}

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
  gate1AirborneKinematics();
  gate2TripleJump();
  gate3Hustle();
  gate4AudioSynthesis();
  gate4AvatarVents();
  await gate4ClientAppAudio();
  gate5Build();

  console.log(`\n${'='.repeat(64)}`);
  if (failures.length === 0) {
    console.log(
      `ALL ${passed} CHECKS PASSED ✔  (Spec 31 Phase 5 — steelpush hustle, triple-jump cycle & hydraulic assist gates)`,
    );
    process.exit(0);
  } else {
    console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  console.error('smoke-steelpush-hustle crashed:', err);
  process.exit(1);
});
