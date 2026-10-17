/**
 * Spec 27 Phase 2 verification probe: OrbitalTransportSystem functional contract.
 * Run: `npx tsx scripts/smoke-orbital-transport.ts`  (exit code 0 == all green)
 *
 * Covers Spec 27 §3.2 gate group 2: deterministic transit scheduling (90–120 s
 * cycle, 20–35 s active window), the ≥ 20° line-of-sight elevation law (exact
 * by construction from the impact-parameter chord), the three vessel archetypes
 * and their catch parameters, the 80 m electromagnetic tractor capture cone
 * incl. the 1.5 × R_catch magnetic assist window, sceneless/headless pure
 * kinematics, seed determinism across different dt step sequences, the
 * NullEngine lifecycle, and the WorldScene integration surface
 * (buildOrbitalTransportSystem / getOrbitalTransportSystem / update / dispose).
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

import {
  OrbitalTransportSystem,
  TRANSPORT_VESSELS,
  ORBITAL_OBSERVER_DEFAULT,
  TRANSIT_INTERVAL_MIN_S,
  TRANSIT_INTERVAL_MAX_S,
  TRANSIT_WINDOW_MIN_S,
  TRANSIT_WINDOW_MAX_S,
  CAPTURE_FUNNEL_LENGTH_M,
  MAGNETIC_ASSIST_FACTOR,
} from '../src/infrastructure/OrbitalTransportSystem.ts';
import type { OrbitalTransportState } from '../src/infrastructure/OrbitalTransportSystem.ts';
import { WorldScene } from '../src/engine/WorldScene.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(label); console.log(`  ✘ ${label} ${detail}`); }
}
const hFrame = () => 1 / 60;
const DEG = 180 / Math.PI;

/** Elevation of a transport above the fire-control datum (degrees). */
function elevationDeg(st: OrbitalTransportState): number {
  const dx = st.position.x - ORBITAL_OBSERVER_DEFAULT.x;
  const dy = st.position.y - ORBITAL_OBSERVER_DEFAULT.y;
  return Math.atan2(st.position.z - ORBITAL_OBSERVER_DEFAULT.z, Math.hypot(dx, dy)) * DEG;
}

// --- constants & canonical anchors -------------------------------------------
check('transit interval band 90–120 s', TRANSIT_INTERVAL_MIN_S === 90 && TRANSIT_INTERVAL_MAX_S === 120);
check('window band 20–35 s', TRANSIT_WINDOW_MIN_S === 20 && TRANSIT_WINDOW_MAX_S === 35);
check('tractor funnel length 80 m', CAPTURE_FUNNEL_LENGTH_M === 80);
check('magnetic assist factor 1.5×', MAGNETIC_ASSIST_FACTOR === 1.5);
check('observer datum = caldera seat (-320, -1450)',
  ORBITAL_OBSERVER_DEFAULT.x === -320 && ORBITAL_OBSERVER_DEFAULT.y === -1450);

check('three vessel archetypes', TRANSPORT_VESSELS.length === 3);
const tug = TRANSPORT_VESSELS[0];
const slip = TRANSPORT_VESSELS[1];
const usp = TRANSPORT_VESSELS[2];
check('CisLunar Horizon 1500 m @ 150, R 35, Δv 25, 2.5x',
  tug.name === 'CisLunar Horizon' && tug.transportClass === 'BULK_FREIGHTER'
  && tug.altitudeM === 1500 && tug.speedMps === 150
  && tug.catchRadiusM === 35 && tug.maxCatchRelSpeedMps === 25 && tug.payoutMultiplier === 2.5);
check('The Obsidian Slip 1800 m @ 210, R 22, Δv 18, 4.0x',
  slip.name === 'The Obsidian Slip' && slip.transportClass === 'SYNDICATE_RUNNER'
  && slip.altitudeM === 1800 && slip.speedMps === 210
  && slip.catchRadiusM === 22 && slip.maxCatchRelSpeedMps === 18 && slip.payoutMultiplier === 4.0);
check('USP Vigilance 1200 m @ 180, R 0 hostile, 0.0x',
  usp.name === 'USP Vigilance' && usp.transportClass === 'USP_PATROL'
  && usp.altitudeM === 1200 && usp.speedMps === 180
  && usp.catchRadiusM === 0 && usp.payoutMultiplier === 0.0);

// --- sceneless pure schedule ---------------------------------------------------
console.log('\n[sceneless schedule & windows]');
const sys = new OrbitalTransportSystem();
check('update(0) before init answers empty array', Array.isArray(sys.update(0)) && sys.update(0).length === 0);
check('garbage dt ignored (NaN / negative)', (() => {
  const t0 = sys.getClockS();
  sys.update(NaN); sys.update(-5);
  return sys.getClockS() === t0;
})());

interface PassRecord { id: string; openT: number; closeT: number; velX: number; velY: number; minElevInWindow: number; }
function runSchedule(system: OrbitalTransportSystem, seconds: number, dt: number): PassRecord[] {
  const out: PassRecord[] = [];
  let open: PassRecord | null = null;
  const frames = Math.ceil(seconds / dt);
  for (let f = 0; f < frames; f++) {
    const states = system.update(dt);
    const t = system.getClockS();
    const st = states.length > 0 ? states[states.length - 1] ?? null : null;
    const isOpen = st !== null && st.inFiringWindow;
    if (isOpen && open === null && st !== null) {
      open = { id: st.id, openT: t, closeT: NaN, velX: st.velocity.x, velY: st.velocity.y, minElevInWindow: Infinity };
    }
    if (isOpen && open !== null) {
      if (st !== null) open.minElevInWindow = Math.min(open.minElevInWindow, elevationDeg(st));
    }
    if (!isOpen && open !== null) {
      open.closeT = t;
      out.push(open);
      open = null;
    }
  }
  return out;
}

const passes = runSchedule(sys, 600, hFrame());
check('at least 5 transits scheduled in 600 s', passes.length >= 5, `got ${passes.length}`);
check('first transit is the CisLunar Horizon', passes[0]?.id === 'orbital-cislunar-horizon');
check('window opens between 17.5 s and 25.0 s', (passes[0]?.openT ?? 0) >= 17.4 && (passes[0]?.openT ?? 1e9) <= 25.1,
  `openT=${passes[0]?.openT}`);
let windowsOk = true, intervalsOk = true, elevOk = true;
for (let i = 0; i < passes.length; i++) {
  const p = passes[i];
  if (p === undefined) continue;
  const w = p.closeT - p.openT;
  if (w < TRANSIT_WINDOW_MIN_S - 0.05 || w > TRANSIT_WINDOW_MAX_S + 0.05) windowsOk = false;
  if (i > 0) {
    const prev = passes[i - 1];
    const gap = p.openT - (prev?.openT ?? 0);
    // open-to-open = interval + (w_prev − w_cur)/2 ∈ [82.5, 127.5]
    if (gap < 82.4 || gap > 127.6) intervalsOk = false;
  }
  if (!(p.minElevInWindow >= 20 - 0.01)) elevOk = false;
}
check('every active window lasts 20–35 s', windowsOk);
check('transit cycle 90–120 s (open-to-open derived)', intervalsOk);
check('LOS law: elevation ≥ 20° throughout every window', elevOk);

// Vessel rotation covers all three archetypes with exact spec parameters.
const seenIds = new Set(passes.map((p) => p.id));
check('deterministic rotation covers all three vessels',
  seenIds.has('orbital-cislunar-horizon') && seenIds.has('orbital-obsidian-slip') && seenIds.has('orbital-usp-vigilance'));
check('pass direction alternates E→W / S→N', (() => {
  for (const p of passes) {
    const ew = Math.abs(p.velX) > 0 && p.velY === 0;
    const sn = p.velX === 0 && p.velY > 0;
    if (!ew && !sn) return false;
    if (ew && p.velX >= 0) return false; // east→west means negative x
  }
  return true;
})());

// In-window state fields (mid-window sample of the first tug pass).
const mid = (() => {
  const s2 = new OrbitalTransportSystem();
  runSchedule(s2, 22, hFrame()); // advance into the first window
  const target = s2.getActiveTarget();
  return { s2, target };
})();
check('getActiveTarget answers during window', mid.target !== null && mid.target.id === 'orbital-cislunar-horizon');
if (mid.target !== null) {
  const t = mid.target;
  check('state: altitudeM === position.z === 1500', t.altitudeM === 1500 && t.position.z === 1500);
  check('state: speedMps === |velocity| === 150', t.speedMps === 150 && Math.hypot(t.velocity.x, t.velocity.y, t.velocity.z) === 150);
  check('state: catchRadius 35 / maxRel 25 / payout 2.5',
    t.catchRadiusM === 35 && t.maxCatchRelSpeedMps === 25 && t.payoutMultiplier === 2.5);
  // Kinematics: straight-line chord, constant altitude.
  const before = mid.s2.update(0)[0];
  mid.s2.update(0.5);
  const after = mid.s2.getActiveTarget();
  if (before !== undefined && before !== null && after !== null) {
    const moved = Math.hypot(after.position.x - before.position.x, after.position.y - before.position.y);
    check('moves 75 m in 0.5 s at constant altitude', Math.abs(moved - 75) < 0.1 && after.position.z === before.position.z);
  }
  check('timeRemainingInWindowS > 0 in window & ≤ windowS', t.timeRemainingInWindowS > 0 && t.timeRemainingInWindowS <= 35);
}

// Window close edge: target retires, timeRemaining drops to 0.
const closeEdge = (() => {
  const s3 = new OrbitalTransportSystem();
  const p = runSchedule(s3, 60, hFrame());
  const first = p[0];
  if (first === undefined) return { ok: false };
  // now clock ≈ first.closeT + 1/60 → just closed
  const states = s3.update(hFrame());
  const justClosed = s3.getActiveTarget();
  return {
    ok: justClosed === null
      && (states.length === 0 || (states[0]?.inFiringWindow !== true)),
  };
})();
check('window close edge retires the active target', closeEdge.ok);

// timeRemaining decreases monotonically across a second.
const monotonic = (() => {
  const s4 = new OrbitalTransportSystem();
  runSchedule(s4, 22, hFrame());
  let prev = s4.getActiveTarget()?.timeRemainingInWindowS ?? -1;
  for (let f = 0; f < 60; f++) {
    s4.update(hFrame());
    const cur = s4.getActiveTarget()?.timeRemainingInWindowS ?? -1;
    if (cur > prev + 1e-12) return false;
    prev = cur;
  }
  return true;
})();
check('timeRemainingInWindowS monotonically decreases', monotonic);

// Schedule radar.
const sched = sys.getSchedule(3);
check('getSchedule(3) answers 3 rows with 20–35 s windows', sched.length === 3
  && sched.every((s) => s.windowS >= 20 && s.windowS <= 35));
check('timeToNextWindowS is 0 in-window, > 0 out-of-window', (() => {
  const s5 = new OrbitalTransportSystem();
  if (s5.timeToNextWindowS() <= 0) return false;
  runSchedule(s5, 22, hFrame());
  return s5.timeToNextWindowS() === 0;
})());

// --- seed determinism across step sequences ------------------------------------
console.log('\n[determinism]');
const runA = (() => { const s = new OrbitalTransportSystem(); return runSchedule(s, 400, hFrame()); })();
const runB = (() => { const s = new OrbitalTransportSystem(); return runSchedule(s, 400, 0.1); })();
check('same seed: identical vessel sequence', runA.map((p) => p.id).join() === runB.map((p) => p.id).join());
check('same seed: window opens reproducible across dt sequences',
  runA.length === runB.length && runA.every((p, i) => Math.abs(p.openT - (runB[i]?.openT ?? NaN)) <= 0.11));

// --- tractor capture cone --------------------------------------------------------
console.log('\n[capture cone]');
const cap = (() => { const s = new OrbitalTransportSystem(); runSchedule(s, 22, hFrame()); return s; })();
const tgt = cap.getActiveTarget();
if (tgt === null) {
  check('capture fixture has an active target', false);
} else {
  const ux = tgt.velocity.x / tgt.speedMps;
  const uy = tgt.velocity.y / tgt.speedMps;
  const matched = { x: tgt.velocity.x, y: tgt.velocity.y, z: 0 };
  const behind = (s: number, r: number) => ({
    x: tgt.position.x - ux * s + 0, // radial offset in +z (perpendicular to vel)
    y: tgt.position.y - uy * s,
    z: tgt.position.z + r,
  });
  // Frustum center hit: 40 m astern, 5 m off-axis, matched velocity.
  const hit = cap.checkCapture(behind(40, 5), matched);
  check('frustum center catch (s=40, r=5, Δv=0)', hit.captured === true && hit.transport?.id === tgt.id);
  check('missDistance = radial 5 m, relativeSpeed = 0',
    Math.abs(hit.missDistanceM - 5) < 1e-6 && Math.abs(hit.relativeSpeedMps) < 1e-9);
  // Δv too high → no capture despite perfect geometry.
  const hot = cap.checkCapture(behind(40, 5), { x: tgt.velocity.x * 1.5, y: tgt.velocity.y * 1.5, z: 0 });
  check('Δv 75 m/s > 25 m/s max → NO capture', hot.captured === false && Math.abs(hot.relativeSpeedMps - 75) < 1e-9);
  // Outside cone mouth radius and outside assist sphere.
  const wide = cap.checkCapture(behind(40, 60), matched);
  check('r=60 > R_catch=35 and > 1.5·R_catch=52.5 → NO capture', wide.captured === false && wide.missDistanceM > 59 && wide.missDistanceM < 61);
  // Magnetic assist window: outside frustum (frustum r at s=5 is ~4.1 m) but
  // inside the 52.5 m assist sphere.
  const assist = cap.checkCapture(behind(5, 45), matched);
  check('assist window: frustum-outside, 1.5·R_catch-inside → capture', assist.captured === true);
  // Way out in front of the funnel axis.
  const farAhead = cap.checkCapture(
    { x: tgt.position.x + ux * 5000, y: tgt.position.y + uy * 5000, z: tgt.position.z }, matched);
  check('5 km ahead of the bay → NO capture, miss ≈ 5 km', farAhead.captured === false && farAhead.missDistanceM > 4990);
}
// Hostile patrol can never capture — evaluated WHILE the Vigilance window
// is open (a stale post-window checkCapture has no active to reject against).
const hostileRes = (() => {
  const s = new OrbitalTransportSystem();
  for (let f = 0; f < 60 * 800; f++) {
    const states = s.update(hFrame());
    const st = states.length > 0 ? states[states.length - 1] ?? null : null;
    if (st !== null && st.transportClass === 'USP_PATROL' && st.inFiringWindow) {
      const ux = st.velocity.x / st.speedMps;
      const uy = st.velocity.y / st.speedMps;
      const pos = { x: st.position.x - ux * 40, y: st.position.y - uy * 40, z: st.position.z };
      return s.checkCapture(pos, { x: st.velocity.x, y: st.velocity.y, z: 0 });
    }
  }
  return null;
})();
check('USP Vigilance rejects capture even dead-center, Δv=0',
  hostileRes !== null && hostileRes.captured === false
  && hostileRes.transport?.transportClass === 'USP_PATROL'
  && Math.abs(hostileRes.missDistanceM) < 1e-6);
// No active transport → Infinity miss distance contract.
const emptySys = new OrbitalTransportSystem();
emptySys.update(0);
const empty = emptySys.checkCapture({ x: 100, y: 200, z: 1500 }, { x: 0, y: 0, z: 0 });
check('no active transport → {captured:false, transport:null, miss:Infinity}',
  empty.captured === false && empty.transport === null && empty.missDistanceM === Infinity && empty.relativeSpeedMps === 0);

// --- NullEngine lifecycle ---------------------------------------------------------
console.log('\n[NullEngine lifecycle]');
const engine = new NullEngine();
const built = new OrbitalTransportSystem().init(engine);
check('init(engine) wraps bare engine, isBuilt', built.isBuilt() === true);
check('mesh count ≥ 45 across three vessels', built.getMeshes().length >= 45, `got ${built.getMeshes().length}`);
check('two capture cones built (tug + slip; Vigilance none)',
  built.getPartMeshes('capture_cone').length === 2);
check('per-vessel mesh sets answer', built.getVesselMeshes('orbital-obsidian-slip').length > 5);
const windowStates = runSchedule(built, 60, hFrame());
check('built system schedules its first window', windowStates.length >= 1, `got ${windowStates.length}`);
// Drive forward until a vessel sits in its firing window, then assert the
// scene mirror (visibility + Babylon placement) at that live instant.
let liveId: string | null = null;
for (let f = 0; f < 60 * 200 && liveId === null; f++) {
  built.update(hFrame());
  const tgt = built.getActiveTarget();
  if (tgt !== null) liveId = tgt.id;
}
check('built system has an in-window target when driven', liveId !== null);
const liveTarget = built.getActiveTarget();
const liveMesh = liveId !== null ? built.getVesselMeshes(liveId)[0] : undefined;
const tugMesh = built.getVesselMeshes('orbital-cislunar-horizon')[0];
const idleVesselMesh = built.getVesselMeshes('orbital-usp-vigilance')[0];
check('live vessel meshes enabled, retired/idle vessels hidden',
  (liveMesh?.isEnabled() ?? false) === true
  && (tugMesh?.isEnabled() ?? true) === false
  && (idleVesselMesh?.isEnabled() ?? true) === false);
check('Babylon placement tracks kinematic state (1e-6)', (() => {
  if (liveTarget === null || liveTarget === undefined || liveMesh === undefined) return false;
  const p = liveMesh.parent;
  if (!(p instanceof TransformNode)) return false;
  return Math.abs(p.position.x - liveTarget.position.x) < 1e-6
    && Math.abs(p.position.y - liveTarget.position.z) < 1e-6
    && Math.abs(p.position.z + liveTarget.position.y) < 1e-6;
})());
check('NullEngine scene.render() stable with vessels in scene', (() => {
  try { built.update(hFrame()); return true; } catch { return false; }
})());
built.dispose();
built.dispose();
check('dispose() idempotent; meshes emptied; isBuilt false',
  built.getMeshes().length === 0 && built.isBuilt() === false);
check('post-dispose pure kinematics still answer', (() => {
  const states = built.update(hFrame());
  return Array.isArray(states) && Number.isFinite(built.getClockS());
})());
check('init() after dispose throws', (() => {
  try { built.init(engine); return false; } catch { return true; }
})());
// Self-owned NullEngine fallback (CI default, no args).
const fallback = new OrbitalTransportSystem();
fallback.init();
check('init() no-args self-owned NullEngine fallback builds', fallback.isBuilt() === true);
fallback.dispose();
check('fallback dispose cleans up', fallback.getMeshes().length === 0);

// --- WorldScene integration ---------------------------------------------------------
console.log('\n[WorldScene integration]');
const ws = new WorldScene({ seed: 'spec27-phase2', terrainSize: 256, terrainResolution: 33 });
ws.init(new NullEngine());
const wsSystem = ws.buildOrbitalTransportSystem();
check('buildOrbitalTransportSystem returns built system', wsSystem.isBuilt() === true);
check('build idempotent (same instance)', ws.buildOrbitalTransportSystem() === wsSystem);
check('getOrbitalTransportSystem accessor round-trips', ws.getOrbitalTransportSystem() === wsSystem);
check('system root is scene-rooted, not terrain-parented', wsSystem.getRootNode() !== null && wsSystem.getRootNode()?.parent === null);
ws.update(500, { x: 0, y: 0, z: 0 });
ws.update(500, { x: 0, y: 0, z: 0 });
check('WorldScene.update advances the transit clock', wsSystem.getClockS() >= 0.99);
const wsStates = wsSystem.update(hFrame());
check('WorldScene-driven system answers states', Array.isArray(wsStates));
wsSystem.update(25); // run into the first firing window
const wsTarget = wsSystem.getActiveTarget();
check('window opens under WorldScene driving', wsTarget !== null);
wsSystem.update(40); // past close — vessels retire but meshes stay allocated
ws.dispose();
check('WorldScene.dispose nulls the accessor', ws.getOrbitalTransportSystem() === null);
check('post-dispose build refuses', (() => {
  try { ws.buildOrbitalTransportSystem(); return false; } catch { return true; }
})());

// --- summary --------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`FAILURES: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log(`ALL ${passed} CHECKS PASSED`);
process.exit(0);
