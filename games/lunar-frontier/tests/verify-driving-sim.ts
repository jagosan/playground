/**
 * Spec 17 §7 — Headless driving-simulation acceptance gate (TASK-PLAY-064f).
 *
 * One suite for the whole Spec 17 driving sim:
 *   A. Deterministic driving metrics (§7.1) — 20 m/s slalom zero-spinout on
 *      Earth asphalt AND lunar regolith, emergency braking < 18 m with
 *      steering authority, < 2.2 s / < 3.5 m turnaround, lunar migration
 *      physics (gravity/mu/vacuum/steering-lock/suspension-scale).
 *   B. Chase-camera UX (§7.2) — 8.5 m / 3.8 m / −18° framing, velocity-vector
 *      lookahead keeping the road apex framed through drifts, 60°→78° FOV.
 *   C. Visual realism (§7.3) — 69-mesh hierarchy, articulating knuckles &
 *      tie-rods, compressing coilovers, PBR material palette.
 *   D. Proving grounds (§3) — 1,200 m closed circuit, 5 sections, sequential
 *      S1/S2 sector gates, lap completion, speed-trap capture.
 *   E. ClientApp mode switching (§5) — Earth Proving Grounds ⇄ Lunar Surface
 *      preserving entity states, terrain visibility and HUD panels.
 *
 * Headless: Babylon runs on NullEngine, the ClientApp gets a minimal fake DOM.
 * Exit code 0 == every check green.
 *
 * Run:  npx tsx tests/verify-driving-sim.ts
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';

import {
  ENV_EARTH_PROVING_GROUNDS,
  ENV_LUNAR_FRONTIER,
  IDLE_BUGGY_INPUT,
  LunarBuggy,
  speedSensitiveSteerLock,
  type BuggyInput,
  type EnvironmentProfile,
} from '../src/physics/TraversalPhysics.ts';
import {
  CameraRig,
  CHASE_FOV_BASE_DEG,
  CHASE_FOV_MAX_DEG,
  CHASE_LOOKAHEAD_BETA,
  velocityLookaheadTheta,
} from '../src/engine/CameraRig.ts';
import { OpenBuggy, coilScaleFor } from '../src/entities/OpenBuggy.ts';
import {
  ProvingGroundsScene,
  TRACK_TOTAL_LENGTH_M,
  TRACK_WIDTH_M,
  SWEEPER_BANK_RAD,
  HAIRPIN_RADIUS_M,
  CREST_ELEVATION_M,
} from '../src/engine/ProvingGroundsScene.ts';
import { ClientApp } from '../src/client/ClientApp.ts';

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// Check bookkeeping
// ---------------------------------------------------------------------------
let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log('  PASS  ' + label);
  } else {
    failures.push(label);
    console.error('  FAIL  ' + label + (detail ? '  [' + detail + ']' : ''));
  }
}

function section(title: string): void {
  console.log('\n=== ' + title + ' ===');
}

function wrapPi(a: number): number {
  let d = (a + Math.PI) % (2 * Math.PI);
  if (d < 0) d += 2 * Math.PI;
  return d - Math.PI;
}

function drive(over: Partial<BuggyInput> = {}): BuggyInput {
  return { ...IDLE_BUGGY_INPUT, throttle: 1, parkBrake: false, ...over };
}

// ---------------------------------------------------------------------------
// A. Deterministic driving metrics (Spec 17 §7.1)
// ---------------------------------------------------------------------------

interface SlalomReport {
  yawMax: number;
  slipMax: number;
  hdgMax: number;
  latMax: number;
  vMin: number;
  rolled: boolean;
}

/**
 * Stanley-style closed-loop sine slalom at a held 20 m/s: path
 * y = A·sin(2πx/λ) with heading feed-forward plus proportional cross-track.
 * A spinout is |heading| past 90°, |yawRate| past 1.5 rad/s, |slip| past 30°,
 * or a rollover — the §7.1 "uncontrolled spinout" definition.
 */
function slalomOnce(env: EnvironmentProfile): SlalomReport {
  const buggy = new LunarBuggy({ environment: env }, { vLong: 20, batteryKwh: 2.2 });
  for (let i = 0; i < 18; i++) buggy.step(DT, drive({ throttle: 0.2 }));
  const A = 3.0;
  const LAM = 290;
  const yRef = (x: number): number => A * Math.sin((2 * Math.PI * x) / LAM);
  const psiRef = (x: number): number =>
    Math.atan(((A * 2 * Math.PI) / LAM) * Math.cos((2 * Math.PI * x) / LAM));
  let yawMax = 0;
  let slipMax = 0;
  let hdgMax = 0;
  let latMax = 0;
  let vMin = 99;
  let rolled = false;
  for (let i = 0; i < Math.round(36 / DT); i++) {
    const s0 = buggy.getState();
    const headCmd = Math.atan(1.2 * wrapPi(psiRef(s0.x) - s0.heading));
    const crossCmd = Math.atan((0.6 * (yRef(s0.x) - s0.y)) / Math.max(s0.vLong, 5));
    let steer = headCmd + crossCmd;
    if (steer > 0.5) steer = 0.5;
    if (steer < -0.5) steer = -0.5;
    const gas = s0.vLong < 20 ? 1 : 0;
    const s1 = buggy.step(DT, drive({ throttle: gas, steer }));
    yawMax = Math.max(yawMax, Math.abs(s1.yawRate));
    hdgMax = Math.max(hdgMax, Math.abs(wrapPi(s1.heading)));
    latMax = Math.max(latMax, Math.abs(s1.y - yRef(s1.x)));
    vMin = Math.min(vMin, s1.vLong);
    if (Math.hypot(s1.vLong, s1.vLat) > 2) {
      const beta = Math.atan2(s1.vLat, s1.vLong);
      slipMax = Math.max(slipMax, Math.abs(wrapPi(beta - s1.heading)));
    }
    if (s1.rolled) { rolled = true; break; }
  }
  return { yawMax, slipMax, hdgMax, latMax, vMin, rolled };
}

function slalomGate(env: EnvironmentProfile, label: string): void {
  const r = slalomOnce(env);
  const spinout = r.hdgMax > Math.PI / 2 || r.yawMax > 1.5 || r.slipMax > 0.524 || r.rolled;
  const ok = !spinout && r.latMax < 2.0 && r.vMin > 19;
  check(
    'slalom at 20 m/s completes with zero uncontrolled spinouts (' + label + ')',
    ok,
    'spin=' + spinout +
      ' latMax=' + r.latMax.toFixed(2) + 'm' +
      ' yawMax=' + r.yawMax.toFixed(2) +
      ' slip=' + ((r.slipMax * 180) / Math.PI).toFixed(1) + 'deg' +
      ' vMin=' + r.vMin.toFixed(1),
  );
}

/** Emergency braking from an injected 25 m/s on asphalt: < 18 m to stop. */
function brakeGate(): void {
  const buggy = new LunarBuggy(
    { environment: ENV_EARTH_PROVING_GROUNDS },
    { vLong: 25, batteryKwh: 1.9 },
  );
  for (let i = 0; i < 12; i++) buggy.step(DT, drive({ throttle: 0 }));
  const p0 = buggy.getState();
  let dist = -1;
  let tStop = -1;
  for (let i = 0; i < 500; i++) {
    const s = buggy.step(DT, drive({ throttle: 0, brake: 1 }));
    if (Math.abs(s.vLong) < 0.05) {
      dist = Math.hypot(s.x - p0.x, s.y - p0.y);
      tStop = (i + 1) * DT;
      break;
    }
  }
  check(
    'emergency braking from 25 m/s stops in < 18 m on asphalt (ABS modulated)',
    dist >= 0 && dist < 18,
    'dist=' + dist.toFixed(2) + 'm t=' + tStop.toFixed(2) + 's',
  );
}

/** Braking with the stick held over: lateral authority retained, no spin. */
function brakeAuthorityGate(): void {
  const buggy = new LunarBuggy(
    { environment: ENV_EARTH_PROVING_GROUNDS },
    { vLong: 25, batteryKwh: 1.9 },
  );
  for (let i = 0; i < 12; i++) buggy.step(DT, drive({ throttle: 0 }));
  let yrMax = 0;
  let hdgMax = 0;
  let lateral = 0;
  let rolled = false;
  let stopped = false;
  for (let i = 0; i < 500; i++) {
    const s = buggy.step(DT, drive({ throttle: 0, brake: 1, steer: 0.2 }));
    yrMax = Math.max(yrMax, Math.abs(s.yawRate));
    hdgMax = Math.max(hdgMax, Math.abs(wrapPi(s.heading)));
    lateral = Math.abs(s.y);
    if (s.rolled) rolled = true;
    if (Math.abs(s.vLong) < 0.05) { stopped = true; break; }
  }
  check(
    'panic stop with steering held keeps lateral authority (no spinout/rollover)',
    stopped && !rolled && yrMax >= 0.3 && hdgMax < 1.6 && lateral >= 2,
    'yrMax=' + yrMax.toFixed(2) +
      ' hdgMax=' + ((hdgMax * 180) / Math.PI).toFixed(0) + 'deg' +
      ' lateral=' + lateral.toFixed(1) + 'm rolled=' + rolled,
  );
}

/** ABS engages while pulse-modulating a locked corner on a rolling panic stop. */
function absGate(): void {
  const buggy = new LunarBuggy(
    { environment: ENV_EARTH_PROVING_GROUNDS },
    { batteryKwh: 2.2 },
  );
  for (let i = 0; i < 3600; i++) {
    (buggy as unknown as { state: { batteryKwh: number } }).state.batteryKwh = 2.2;
    if (buggy.step(DT, drive()).vLong >= 21.9) break;
  }
  for (let i = 0; i < 30; i++) buggy.step(DT, drive({ throttle: 0 }));
  let absFrames = 0;
  let worstSlip = 0;
  for (let i = 0; i < 400; i++) {
    const s = buggy.step(DT, drive({ throttle: 0, brake: 1 }));
    if (buggy.absActive) absFrames++;
    for (const w of s.wheels) worstSlip = Math.min(worstSlip, w.slip);
    if (Math.abs(s.vLong) < 0.05) break;
  }
  check(
    'ABS pulses a locked corner during the panic stop (s_i < -0.25 detected)',
    absFrames > 0 && worstSlip < -0.25,
    'absFrames=' + absFrames + ' worstSlip=' + worstSlip.toFixed(2),
  );
}

/** Low-speed 180° turnaround: < 2.2 s inside a 3.5 m radius, both envs. */
function turnaroundGate(env: EnvironmentProfile, label: string): void {
  const buggy = new LunarBuggy({ environment: env }, {});
  for (let i = 0; i < 60; i++) buggy.step(DT, IDLE_BUGGY_INPUT);
  const p0 = buggy.getState();
  let acc = 0;
  let t180 = -1;
  let radiusMax = 0;
  let vMax = 0;
  for (let i = 0; i < 600 && t180 < 0; i++) {
    const s = buggy.step(DT, drive({ throttle: 1, steer: 1, brake: 0.6 }));
    acc += Math.abs(s.yawRate) * DT;
    radiusMax = Math.max(radiusMax, Math.hypot(s.x - p0.x, s.y - p0.y));
    vMax = Math.max(vMax, Math.hypot(s.vLong, s.vLat));
    if (acc >= Math.PI) t180 = (i + 1) * DT;
  }
  check(
    'low-speed 180 deg turnaround < 2.2 s within 3.5 m radius (' + label + ')',
    t180 > 0 && t180 < 2.2 && radiusMax < 3.5 && vMax < 4,
    't=' + t180.toFixed(2) + 's rMax=' + radiusMax.toFixed(2) + 'm vMax=' + vMax.toFixed(2),
  );
}

/** Lunar migration (Spec 17 §5): parameters, vacuum, lock law, suspension. */
function migrationGate(): void {
  check(
    'ENV_LUNAR_FRONTIER = {g 1.62, mu 0.68, CdA 0 (vacuum)}',
    ENV_LUNAR_FRONTIER.gravity === 1.62 &&
      ENV_LUNAR_FRONTIER.surfaceFrictionMu === 0.68 &&
      ENV_LUNAR_FRONTIER.airResistanceCdA === 0,
  );
  check(
    'ENV_EARTH_PROVING_GROUNDS = {g 9.81, mu 1.05, CdA 0.45}',
    ENV_EARTH_PROVING_GROUNDS.gravity === 9.81 &&
      ENV_EARTH_PROVING_GROUNDS.surfaceFrictionMu === 1.05 &&
      ENV_EARTH_PROVING_GROUNDS.airResistanceCdA === 0.45,
  );
  const buggy = new LunarBuggy({}, {});
  const swapped = buggy.setEnvironment(ENV_EARTH_PROVING_GROUNDS);
  const back = buggy.setEnvironment(ENV_LUNAR_FRONTIER);
  check(
    'runtime setEnvironment round-trips (earth -> lunar) mid-run',
    swapped.name === 'earth_proving_grounds' && buggy.getEnvironment().name === 'lunar_frontier',
  );
  // Vacuum: lunar coast decelerates LESS than earth (no aero drag term).
  const coast = (env: EnvironmentProfile): number => {
    const b = new LunarBuggy({ environment: env }, { vLong: 20, batteryKwh: 2.2 });
    for (let i = 0; i < 10; i++) b.step(DT, drive({ throttle: 0 }));
    const v0 = b.getState().vLong;
    for (let i = 0; i < 120; i++) b.step(DT, drive({ throttle: 0 }));
    const v1 = b.getState().vLong;
    return (v0 - v1) / 2;
  };
  const decelEarth = coast(ENV_EARTH_PROVING_GROUNDS);
  const decelLunar = coast(ENV_LUNAR_FRONTIER);
  check(
    'lunar vacuum coast deceleration < earth (aero drag absent in vacuum)',
    decelLunar < decelEarth,
    'lunar=' + decelLunar.toFixed(3) + ' earth=' + decelEarth.toFixed(3) + ' m/s2',
  );
  // Speed-sensitive lock law applies unchanged under lunar gravity.
  const lockBuggy = new LunarBuggy(
    { environment: ENV_LUNAR_FRONTIER },
    { vLong: 20 },
  );
  const applied = lockBuggy.step(DT, drive({ throttle: 0.5, steer: 1 })).steerAngle ?? 0;
  const formula = speedSensitiveSteerLock(20);
  check(
    'speed-sensitive steering lock δmax(20) = 14°+(45°−14°)/(1+(v/10)²) under lunar g',
    Math.abs(applied - formula) < 1e-3 && formula < 0.4 && formula > 0.24,
    'applied=' + applied.toFixed(4) + ' formula=' + formula.toFixed(4),
  );
  // Suspension migration scale: identical compression fraction in both wells
  // (k scales with g), and Earth static load carries the full Earth weight.
  const settleLoad = (env: EnvironmentProfile): { load: number; comp: number } => {
    const b = new LunarBuggy({ environment: env }, {});
    for (let i = 0; i < 600; i++) b.step(DT, IDLE_BUGGY_INPUT);
    const s = b.getState();
    return { load: s.wheels[0].load, comp: s.wheels[0].compression };
  };
  const e = settleLoad(ENV_EARTH_PROVING_GROUNDS);
  const l = settleLoad(ENV_LUNAR_FRONTIER);
  check(
    'suspension migrates: same static compression fraction Earth vs Lunar (k ∝ g)',
    Math.abs(e.comp - l.comp) < 0.05 && e.comp > 0.5 && e.comp < 0.9,
    'compEarth=' + e.comp.toFixed(3) + ' compLunar=' + l.comp.toFixed(3),
  );
  check(
    'earth static corner load carries the 1 g weight (no chassis bottom-out)',
    e.load > 1900 && e.load < 2250,
    'load=' + e.load.toFixed(0) + 'N',
  );
}

/** Bumpy lunar cruise: bounded heave, no growing oscillation, no rollover. */
function lunarStabilityGate(): void {
  const bump = (x: number, y: number): number =>
    0.22 * Math.sin(x * 0.9) + 0.15 * Math.sin(x * 0.33 + 1.2);
  const buggy = new LunarBuggy(
    { environment: ENV_LUNAR_FRONTIER, groundElevation: bump },
    { vLong: 8 },
  );
  let vbMax = 0;
  let rolled = false;
  const early: number[] = [];
  const late: number[] = [];
  for (let i = 0; i < 60 * 30; i++) {
    const s = buggy.step(DT, drive({ throttle: 1 }));
    vbMax = Math.max(vbMax, Math.abs(s.vBody));
    rolled = rolled || s.rolled;
    if (i < 600) early.push(Math.abs(s.vBody));
    else late.push(Math.abs(s.vBody));
  }
  const mean = (a: number[]): number => a.reduce((p, c) => p + c, 0) / a.length;
  check(
    'lunar rough-regolith cruise: bounded heave, no chassis oscillation growth',
    vbMax < 0.5 && !rolled && mean(late) <= mean(early) * 1.15,
    'vbMax=' + vbMax.toFixed(3) + ' rolled=' + rolled +
      ' meanEarly=' + mean(early).toFixed(4) + ' meanLate=' + mean(late).toFixed(4),
  );
  check(
    'lunar cruise maintains forward drive (no uncontrolled yaw)',
    Math.abs(buggy.getState().yawRate) < 0.05,
    'yawRate=' + buggy.getState().yawRate.toFixed(4),
  );
}

function partA(): void {
  section('A. deterministic driving metrics (Spec 17 §7.1)');
  slalomGate(ENV_EARTH_PROVING_GROUNDS, 'earth asphalt');
  slalomGate(ENV_LUNAR_FRONTIER, 'lunar regolith');
  brakeGate();
  brakeAuthorityGate();
  absGate();
  turnaroundGate(ENV_EARTH_PROVING_GROUNDS, 'earth asphalt');
  turnaroundGate(ENV_LUNAR_FRONTIER, 'lunar regolith');
  migrationGate();
  lunarStabilityGate();
}

// ---------------------------------------------------------------------------
// B. Chase-camera UX (Spec 17 §7.2)
// ---------------------------------------------------------------------------

function partB(): void {
  section('B. chase-camera UX (Spec 17 §7.2)');
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const rig = new CameraRig(scene, { initialMode: 'vehicle_chase', silent: true });
  const cfg = rig.getConfig();
  check('chase framing: 8.5 m distance / 3.8 m height',
    cfg.distance === 8.5 && cfg.heightOffset === 3.8,
    `d=${cfg.distance} h=${cfg.heightOffset}`);

  // Settle into a steady drift (20 m/s forward, 8 m/s lateral).
  const drift = Math.atan2(8, 20);
  for (let i = 0; i < 300; i++) {
    rig.update({ x: 100 + i * 0.33, y: 50, z: 0 }, 0, DT, 0, 0.9, { vLong: 20, vLat: 8 });
  }
  const cam = rig.getActiveCamera() as unknown as {
    alpha: number; beta: number; radius: number; fov: number;
    globalPosition: { y: number };
  };
  const pitchDeg = ((Math.PI / 2 - cam.beta) * 180) / Math.PI;
  check('chase pitch holds -18 deg nose-down attitude',
    Math.abs(pitchDeg - 18) < 0.3, `pitch=${pitchDeg.toFixed(2)}`);
  check('camera radius rides at the configured chase distance',
    Math.abs(cam.radius - 8.5) < 1e-6, `r=${cam.radius.toFixed(3)}`);

  // Velocity-vector lookahead: azimuth converged to θ_look, not θ_body.
  const lookGoal = Math.PI - CHASE_LOOKAHEAD_BETA * drift;
  const bodyGoal = Math.PI;
  const dLook = Math.abs(cam.alpha - lookGoal);
  const dBody = Math.abs(cam.alpha - bodyGoal);
  check('theta_look blends toward the drift angle (apex stays framed)',
    dLook < 1e-4 && dBody > 0.1,
    `dLook=${dLook.toExponential(1)} dBody=${dBody.toFixed(3)} beta=${CHASE_LOOKAHEAD_BETA}`);
  const tLook = velocityLookaheadTheta(1.0, 20, 8);
  check('velocityLookaheadTheta = θ + 0.35·atan2(vLat, vLong) above the gate',
    Math.abs(tLook - (1.0 + 0.35 * drift)) < 1e-9,
    `${tLook.toFixed(5)} vs ${(1.0 + 0.35 * drift).toFixed(5)}`);
  const tLow = velocityLookaheadTheta(1.0, 1.5, 0.9);
  check('lookahead gated OFF at crawl speed (|v| ≤ 2 m/s → θ_body)',
    tLow === 1.0, `v=${Math.hypot(1.5, 0.9).toFixed(2)} t=${tLow}`);

  // Dynamic speed FOV: 60° at rest, easing smoothly to 78° at reference speed.
  const rig2 = new CameraRig(scene, { initialMode: 'vehicle_chase', silent: true });
  for (let i = 0; i < 150; i++) rig2.update({ x: 0, y: 0, z: 0 }, 0, DT, 0, 0);
  const restFov = rig2.getFovDegrees();
  const samples: number[] = [];
  for (let i = 0; i < 150; i++) {
    rig2.update({ x: 0, y: 0, z: 0 }, 0, DT, 0, 1);
    if (i % 25 === 24) samples.push(rig2.getFovDegrees());
  }
  const fullFov = rig2.getFovDegrees();
  let monotonic = true;
  for (let i = 1; i < samples.length; i++) if (samples[i] < samples[i - 1] - 1e-9) monotonic = false;
  check(`FOV widens ${CHASE_FOV_BASE_DEG}° → ${CHASE_FOV_MAX_DEG}° with speed, smoothly (no jump)`,
    Math.abs(restFov - CHASE_FOV_BASE_DEG) < 0.2 &&
      Math.abs(fullFov - CHASE_FOV_MAX_DEG) < 0.2 && monotonic,
    `rest=${restFov.toFixed(1)} full=${fullFov.toFixed(1)} sweep=${samples.map((s) => s.toFixed(1)).join('>')}`);

  // Zero clipping: camera stays above ground with terrain sampling enabled.
  const rig3 = new CameraRig(scene, {
    initialMode: 'vehicle_chase',
    silent: true,
    groundHeightAt: () => 0,
  });
  let clipped = false;
  for (let i = 0; i < 120; i++) {
    rig3.update({ x: 0, y: 0, z: 0 }, 0, DT, 0, 0.5, { vLong: 10, vLat: 0 });
    if (rig3.getPhysicsPosition().z < 0.9) clipped = true;
  }
  check('no ground clipping during a sustained chase drive', !clipped);
  rig.dispose();
  rig2.dispose();
  rig3.dispose();
  scene.dispose();
  engine.dispose();
}

// ---------------------------------------------------------------------------
// C. Visual realism (Spec 17 §7.3 / §4)
// ---------------------------------------------------------------------------

function partC(): void {
  section('C. visual realism (Spec 17 §7.3)');
  const engine = new NullEngine();
  const buggy = new OpenBuggy();
  buggy.init(engine);
  const meshes = buggy.getMeshes();
  check('69 procedural meshes in the cohesive buggy hierarchy',
    meshes.length === 69 && meshes.every((m) => m.name.startsWith('buggy-')),
    `got ${meshes.length}`);
  const named = (n: string) => meshes.filter((m) => m.name.includes(n)).length;
  check('cohesive hierarchy: named sub-assemblies present (coilover/tie-rod/wishbone/cage/wheel)',
    named('coilover') >= 4 && named('tie-rod') >= 2 && named('arm') >= 4 &&
      named('wheel') >= 4 && named('hoop') >= 1,
    `coil=${named('coilover')} tie=${named('tie-rod')} arms=${named('arm')} wheels=${named('wheel')}`);

  // Steering knuckles + tie-rods articulate with steering angle.
  const knL0 = buggy.getSteeringKnuckles()[0]!.rotation.y;
  const tieS0 = buggy.getTieRods().map((r) => Number(r.scaling.y.toFixed(6)));
  for (let i = 0; i < 40; i++) {
    buggy.update(DT, { throttle: 0.5, brake: 0, regen: 0, steer: 1, parkBrake: false });
  }
  const knL = buggy.getSteeringKnuckles()[0]!.rotation.y;
  const knR = buggy.getSteeringKnuckles()[1]!.rotation.y;
  const tieS = buggy.getTieRods().map((r) => Number(r.scaling.y.toFixed(6)));
  check('steering knuckles physically articulate with steering angle',
    Math.abs(knL - knL0) > 0.25 && Math.abs(knR) > 0.25 && Math.abs(knL - knR) > 0.05,
    `L=${knL.toFixed(3)} R=${knR.toFixed(3)} (Ackermann-differentiated)`);
  check('tie-rods stretch/pull with the knuckle yaw (chord changes)',
    tieS0.every((s, i) => Math.abs(tieS[i] - s) > 1e-4),
    `rest=${tieS0.join('/')} steered=${tieS.map((s) => s.toFixed(4)).join('/')}`);

  // Coilover spring + damper compress with suspension heave: the mesh scale
  // IS coilScaleFor/rodScaleFor(compression) every synced frame, and a rough
  // lunar ride drives visible per-corner travel.
  const coils = buggy.getCoilovers();
  const rods = buggy.getDamperRods();
  check('coaxial coilover spring + damper assemblies per wheel (4 + 4)',
    coils.length === 4 && rods.length === 4);
  let identity = true;
  let variation = 0;
  let compressionSeen = 0;
  const bump = (x: number, y: number): number => 0.2 * Math.sin(x * 0.9);
  const rough = new OpenBuggy({ groundElevation: bump });
  rough.init(engine);
  for (let i = 0; i < 240; i++) {
    rough.update(DT, { throttle: 1, brake: 0, regen: 0, steer: 0, parkBrake: false });
    const st = rough.getState();
    const cs = rough.getCoilovers();
    for (let w = 0; w < 4; w++) {
      if (Math.abs(cs[w]!.scaling.y - coilScaleFor(st.wheels[w]!.compression)) > 1e-6) identity = false;
      variation = Math.max(variation, Math.abs(cs[w]!.scaling.y - coilScaleFor(0.5)));
    }
    compressionSeen = Math.max(compressionSeen, Math.abs(st.wheels[0]!.compression - 0.5));
  }
  check('coilover compression tracks physics heave (scale = coilScaleFor(compression))',
    identity, 'per-frame identity across 240 frames');
  check('suspension heave visibly compresses the springs (> 0.08 travel)',
    variation > 0.08 && compressionSeen > 0.1,
    `visualTravel=${variation.toFixed(3)}`);

  // PBR palette (Spec 17 §4.4).
  const pbr = (frag: string): PBRMaterial | null => {
    for (const m of meshes) {
      const mat = m.material;
      if (mat instanceof PBRMaterial && m.name.includes(frag)) return mat;
    }
    for (const m of meshes) {
      const mat = m.material;
      if (mat instanceof PBRMaterial && mat.name.includes(frag)) return mat;
    }
    return null;
  };
  const powder = pbr('powdercoat');
  const rubber = pbr('tire');
  const polished = pbr('polished');
  const carbon = pbr('carbon');
  check('PBR powdercoat coating (metallic 0.30 / rough 0.62)',
    powder !== null && Math.abs(powder.metallic - 0.3) < 1e-9 && Math.abs(powder.roughness - 0.62) < 1e-9);
  check('PBR matte rubber tyres (metallic ≤ 0.1 / rough ≥ 0.9)',
    rubber !== null && rubber.metallic <= 0.1 && rubber.roughness >= 0.9);
  check('PBR polished stanchions (metallic 1.0 / rough ≤ 0.15)',
    polished !== null && polished.metallic === 1.0 && polished.roughness <= 0.15);
  check('PBR carbon-fibre bed panels (woven tow albedo texture)',
    carbon !== null && carbon.albedoTexture !== null && carbon.metallic >= 0.4);

  buggy.dispose();
  rough.dispose();
  engine.dispose();
}

// ---------------------------------------------------------------------------
// D. Proving Grounds circuit & lap timing (Spec 17 §3)
// ---------------------------------------------------------------------------

function partD(): void {
  section('D. proving grounds circuit & lap timing (Spec 17 §3)');
  const engine = new NullEngine();
  const track = new ProvingGroundsScene({ silent: true });
  track.init(engine);
  check('closed circuit ≈ 1,200 m, 12 m wide',
    Math.abs(track.lengthM - TRACK_TOTAL_LENGTH_M) < 2 && TRACK_WIDTH_M === 12,
    `length=${track.lengthM.toFixed(1)}`);
  const secs = track.getSections();
  const kinds = secs.map((s) => s.kind).join(',');
  check('5 sections: straightaway speed trap, 10° banked sweeper, slalom, 15 m hairpin, crest',
    secs.length === 5 &&
      kinds === 'straightaway,banked-sweeper,slalom,hairpin,crest',
    kinds);
  const straight = secs[0]!;
  const sweeper = secs[1]!;
  const hairpin = secs[3]!;
  const crest = secs[4]!;
  check('section geometry: 250 m straight / 10° bank / R15 hairpin / 5 m crest',
    Math.abs(straight.lengthM - 250) < 1 &&
      Math.abs(sweeper.peakBankRad - SWEEPER_BANK_RAD) < 0.005 &&
      HAIRPIN_RADIUS_M === 15 &&
      Math.abs(crest.peakElevationM - CREST_ELEVATION_M) < 0.05,
    `straight=${straight.lengthM.toFixed(0)} bank=${((sweeper.peakBankRad * 180) / Math.PI).toFixed(1)}deg crest=${crest.peakElevationM.toFixed(2)}`);
  const secsSum = secs.reduce((p, s) => p + s.lengthM, 0);
  check('sections tile the full lap with no gaps', Math.abs(secsSum - track.lengthM) < 1);
  const wp = track.getWaypoints();
  check('waypoint spline carries sector + section indices',
    wp.length > 2000 && wp.every((w) => w.sectorIndex >= 1 && w.sectorIndex <= 3 && w.sectionIndex >= 1 && w.sectionIndex <= 5));

  // ---- lap timer: sequential S1 → S2 gate sectors, lap completion, trap ----
  const timer = track.createLapTimer();
  const SPEED = 25; // m/s synthetic shuttle speed
  let sPos = 0;
  let sec1 = false;
  let sec2 = false;
  let lapDone = false;
  const runS = (targetS: number): void => {
    while (sPos < targetS) {
      const adv = Math.min(SPEED * DT, targetS - sPos);
      sPos += adv;
      const p = track.getPointAt(sPos);
      timer.step(DT, p.x, p.y, SPEED);
    }
  };
  // Gate 1 (end of Sector 1) — first sequential split.
  const g1 = track.getWaypoints().find((w) => w.isCheckpoint && w.arcLengthM > 100)!.arcLengthM;
  runS(g1 + 2);
  sec1 = timer.getTelemetry().sectorTimesS.length === 1 && timer.pendingGateIndex === 2;
  check('sector gate 1 registers S1 split (sequential arming)', sec1,
    JSON.stringify(timer.getTelemetry().sectorTimesS.map((x) => x.toFixed(1))));

  // Speed trap sits inside Sector 1 — capture the shuttle speed.
  runS(215); // already past the trap zone; capture happened inside [60,210]
  const trap = timer.getTelemetry().speedTrapKmh;
  check('speed trap captures the capture-zone speed',
    trap !== null && Math.abs(trap - SPEED * 3.6) < 1,
    `trap=${trap?.toFixed(1)} km/h`);

  // Gate 2 (crest brow) — second sequential split.
  const g2 = track.getWaypoints().find((w) => w.isCheckpoint && w.arcLengthM > 900)!.arcLengthM;
  runS(g2 + 2);
  sec2 = timer.getTelemetry().sectorTimesS.length === 2 && timer.pendingGateIndex === 0;
  check('sector gate 2 registers S2 split, arming the finish line', sec2);

  // Finish-line wrap completes the lap.
  runS(track.lengthM + 3);
  const fin = timer.getTelemetry();
  lapDone = fin.currentLap === 2 && fin.lastLapTimeS !== null && fin.bestLapTimeS !== null;
  check('lap completion on the start/finish crossing (lap 2, best/last recorded)',
    lapDone,
    `lap=${fin.currentLap} last=${fin.lastLapTimeS?.toFixed(1)}`);
  check('top speed tracked across the run', fin.topSpeedKmh >= SPEED * 3.6 - 0.5);

  // Reversing back across the line never completes a lap.
  const before = timer.getTelemetry().currentLap;
  const p0 = track.getPointAt(track.lengthM - 1);
  for (let i = 0; i < 20; i++) timer.step(DT, p0.x, p0.y, 0);
  const q0 = track.getPointAt(track.lengthM + 1.5);
  timer.step(DT * 20, q0.x, q0.y, 0);
  check('a backwards hop is not a forward crossing (no phantom lap)',
    timer.getTelemetry().currentLap === before);

  track.dispose();
  engine.dispose();
}

// ---------------------------------------------------------------------------
// E. ClientApp runtime mode switching (Spec 17 §5 / Phase 6)
// ---------------------------------------------------------------------------

interface FakeElement {
  id: string;
  className: string;
  textContent: string | null;
  style: { width: string; [key: string]: string };
  classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
  children: FakeElement[];
  parent?: FakeElement;
  appendChild<T extends FakeElement>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
}

function makeFakeElement(tag: string, registry: Map<string, FakeElement>): FakeElement {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const el: FakeElement = {
    id: '',
    className: '',
    textContent: '',
    style: { width: '' },
    children: [],
    classList: {
      add: (name) => void classes.add(name),
      remove: (name) => void classes.delete(name),
      contains: (name) => classes.has(name),
    },
    appendChild(child) {
      el.children.push(child);
      (child as FakeElement).parent = el;
      return child;
    },
    remove() {
      const parent = el.parent;
      if (parent !== undefined) {
        const i = parent.children.indexOf(el);
        if (i >= 0) parent.children.splice(i, 1);
      }
    },
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute(name, value) {
      attrs.set(name, value);
      if (name === 'id') {
        el.id = value;
        registry.set(value, el);
      }
    },
    addEventListener() {},
  };
  void tag;
  return el;
}

function makeFakeDocument(): FakeElement & { createElement(t: string): FakeElement; getElementById(id: string): FakeElement | null; addEventListener(): void } {
  const registry = new Map<string, FakeElement>();
  const body = makeFakeElement('body', registry);
  return Object.assign(body, {
    createElement: (t: string) => makeFakeElement(t, registry),
    getElementById: (id: string) => registry.get(id) ?? null,
    addEventListener() {},
  });
}

async function partE(): Promise<void> {
  section('E. ClientApp Earth ⇄ Lunar mode switching (Spec 17 §5)');
  (globalThis as { document?: unknown }).document = makeFakeDocument();
  let nowMs = 1000;
  const app = new ClientApp({ network: null, autoConnect: false, silent: true });
  await app.init(new NullEngine());
  check('boots on the lunar surface', app.getEnvironmentMode() === 'lunar_frontier');

  // Park a measurable entity state on the lunar side: cargo + battery level.
  const buggy = app.getBuggy();
  buggy.setCargoMass(180);
  const battLunar = buggy.getBattery();
  const lunarPos = buggy.getPosition();

  app.enableProvingGrounds();
  check('mode flips to earth_proving_grounds', app.getEnvironmentMode() === 'earth_proving_grounds');
  check('buggy physics profile is Earth (9.81 / 1.05)',
    buggy.physics.getEnvironment().gravity === 9.81 &&
      buggy.physics.getEnvironment().surfaceFrictionMu === 1.05);
  const track = app.getProvingGrounds();
  check('circuit built into the live scene', track !== null && track.isBuilt());
  const start = track!.getStartPose();
  const onLine = buggy.getPosition();
  check('buggy warped onto the start/finish line',
    Math.hypot(onLine.x - start.x, onLine.y - start.y) < 1.5);
  const terrain = app.world.getTerrainMesh();
  check('lunar terrain hidden (not destroyed) in track mode',
    terrain === null || terrain.isEnabled() === false);
  check('lap HUD panel shown in track mode', app.getHud()?.isLapPanelVisible() === true);
  check('entity state preserved across the switch (cargo aboard, battery intact)',
    Math.abs(buggy.getCargoMass() - 180) < 1e-9 && Math.abs(buggy.getBattery() - battLunar) < 1e-9);

  // Frames pump the lap timer while on the track.
  for (let i = 0; i < 90; i++) { nowMs += 50; app.update(nowMs); }
  const tele = app.getLapTelemetry();
  check('lap telemetry flows through the client frame loop',
    tele !== null && tele.currentLapTimeS > 1, JSON.stringify(tele?.currentLapTimeS));

  const meshCount = track!.getMeshes().length;
  app.enableProvingGrounds();
  check('enable is idempotent (no duplicate track meshes)',
    track!.getMeshes().length === meshCount);

  app.disableProvingGrounds();
  check('back on the lunar surface', app.getEnvironmentMode() === 'lunar_frontier');
  check('lunar gravity profile restored (1.62 / 0.68)',
    buggy.physics.getEnvironment().gravity === 1.62 &&
      buggy.physics.getEnvironment().surfaceFrictionMu === 0.68);
  check('lunar terrain restored', terrain === null || terrain.isEnabled() === true);
  check('lap HUD panel hidden again', app.getHud()?.isLapPanelVisible() === false);
  check('track stays built for cheap re-entry', track!.isBuilt());
  check('entity state survives the return trip (cargo + battery)',
    Math.abs(buggy.getCargoMass() - 180) < 1e-9 &&
      Math.abs(buggy.getBattery() - battLunar) < 0.05 &&
      Number.isFinite(buggy.getPosition().x + buggy.getPosition().y));
  app.disableProvingGrounds(); // idempotent
  check('disable idempotent (mode unchanged)', app.getEnvironmentMode() === 'lunar_frontier');

  // Keybind R toggles both directions (Spec 17 Phase 4 hotkey).
  const modeBefore = app.getEnvironmentMode();
  app.handleKeyInput('KeyR', 'down');
  check('R hotkey toggles the environment mode',
    app.getEnvironmentMode() !== modeBefore);
  app.handleKeyInput('KeyR', 'down');
  check('R hotkey toggles back', app.getEnvironmentMode() === modeBefore);

  app.dispose();
  app.dispose();
  check('client disposes cleanly (idempotent)', true);
}

async function main(): Promise<void> {
  partA();
  partB();
  partC();
  partD();
  await partE();
  const line = '='.repeat(64);
  console.log('\n' + line);
  if (failures.length === 0) {
    console.log('ALL ' + passed + ' CHECKS PASSED (driving-sim verification)');
    process.exit(0);
  } else {
    console.error('FAILED ' + failures.length + ' of ' + (passed + failures.length));
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error('HARNESS CRASH:', err);
  process.exit(1);
});
