/**
 * Spec 27 Phase 3 verification probe: BallisticTrajectoryEngine closed-form
 * accuracy, predictive lead intercept rates, and edge-case hygiene.
 * Run: `npx tsx scripts/smoke-ballistic-trajectory.ts`  (exit code 0 == all green)
 *
 * Covers Spec 27 §3.3 / §4 and §6 acceptance gate 3 ("firing with the reticle
 * centered on the predictive lead pip achieves ≥ 95% intercept rate across all
 * target speeds and altitudes in headless test simulations"):
 *   A. contract shape + canonical constants;
 *   B. simulateCanister exactness vs the hand-built lunar parabola, incl.
 *      stepped-mode agreement with the closed-form leap;
 *   C. closed-form cross-checks on static targets (minimum-energy identity
 *      v² = g(h+R), near/far arc duality, zenith hard-stop behavior);
 *   D. deterministic canonical moving-target grid across all three vessel
 *      archetypes — fire at the solution, integrate, hit within 1e-6 m;
 *   E. seeded Monte-Carlo intercept-rate sweep (altitudes 1200–2200 m,
 *      speeds 140–220 m/s, vertical drift ±10 m/s, random azimuths) —
 *      feasible-trial intercept rate must be ≥ 95% and predicted miss ≈ 0;
 *   F. edge cases: zero/negative/NaN charge, out-of-range targets, targets
 *      below the gun, degenerate zero separation, determinism, aim-field
 *      range invariants over a random battery;
 *   G. integration surface: MassAccelerator fire vector vs solution aim and
 *      OrbitalTransportSystem in-window targets solvable at full charge.
 */
import { BallisticTrajectoryEngine } from '../src/physics/BallisticTrajectoryEngine.ts';
import type { TrajectorySolution, Vec3Like } from '../src/physics/BallisticTrajectoryEngine.ts';
import { MassAccelerator, TRUNNION_HEIGHT_M } from '../src/infrastructure/MassAccelerator.ts';
import { OrbitalTransportSystem } from '../src/infrastructure/OrbitalTransportSystem.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(label); console.log(`  ✘ ${label} ${detail}`); }
}
function section(title: string): void { console.log(`\n[${title}]`); }

const DEG = Math.PI / 180;
const G = BallisticTrajectoryEngine.LUNAR_GRAVITY;

/** mulberry32 PRNG (same stream family as OrbitalTransportSystem). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const target = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });
const vel = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });
const dist = (a: Vec3Like, b: Vec3Like): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Fire exactly at a solution and return the achieved miss distance at τ̂. */
function fireAtSolution(muzzle: Vec3Like, tPos: Vec3Like, tVel: Vec3Like, sol: TrajectorySolution): number {
  const v0 = BallisticTrajectoryEngine.launchVelocity(
    sol.leadAzimuthDeg, sol.leadElevationDeg, sol.recommendedMuzzleSpeedMps);
  const at = BallisticTrajectoryEngine.simulateCanister(muzzle, v0, sol.estimatedFlightTimeS);
  const tAt = target(
    tPos.x + tVel.x * sol.estimatedFlightTimeS,
    tPos.y + tVel.y * sol.estimatedFlightTimeS,
    tPos.z + tVel.z * sol.estimatedFlightTimeS);
  return dist(at.position, tAt);
}

/** Field-range invariants every returned solution must obey. */
function solutionFieldsSane(sol: TrajectorySolution, allowInfiniteMiss = true): boolean {
  return typeof sol.hasSolution === 'boolean'
    && Number.isFinite(sol.leadAzimuthDeg) && sol.leadAzimuthDeg >= 0 && sol.leadAzimuthDeg < 360
    && Number.isFinite(sol.leadElevationDeg)
    && sol.leadElevationDeg >= BallisticTrajectoryEngine.ELEVATION_MIN_DEG - 1e-9
    && sol.leadElevationDeg <= BallisticTrajectoryEngine.ELEVATION_MAX_DEG + 1e-9
    && Number.isFinite(sol.recommendedMuzzleSpeedMps) && sol.recommendedMuzzleSpeedMps >= 0
    && Number.isFinite(sol.estimatedFlightTimeS) && sol.estimatedFlightTimeS >= 0
    && (Number.isFinite(sol.predictedMissDistanceM) || allowInfiniteMiss);
}

// --- A. contract shape & canonical constants -----------------------------------
section('A. contract & constants');
check('LUNAR_GRAVITY === 1.62', G === 1.62);
check('elevation hard stops [15, 85]',
  BallisticTrajectoryEngine.ELEVATION_MIN_DEG === 15 && BallisticTrajectoryEngine.ELEVATION_MAX_DEG === 85);

const probe = BallisticTrajectoryEngine.calculateLead(
  target(0, 0, 0), target(1000, 0, 1200), vel(120, 0, 0), 300);
check('calculateLead returns the 6 Spec §4 fields',
  typeof probe.hasSolution === 'boolean'
  && 'leadAzimuthDeg' in probe && 'leadElevationDeg' in probe
  && 'recommendedMuzzleSpeedMps' in probe && 'estimatedFlightTimeS' in probe
  && 'predictedMissDistanceM' in probe, JSON.stringify(probe));
const simProbe = BallisticTrajectoryEngine.simulateCanister(target(0, 0, 0), vel(0, 0, 10), 5);
check('simulateCanister returns { position, velocity }',
  'position' in simProbe && 'velocity' in simProbe
  && 'x' in simProbe.position && 'z' in simProbe.velocity);

// --- B. simulateCanister exactness ----------------------------------------------
section('B. simulateCanister closed-form exactness');
{
  const p0 = target(10, -2, 3);
  const v0 = vel(40, -30, 100);
  const T = 17.3;
  const s = BallisticTrajectoryEngine.simulateCanister(p0, v0, T);
  const ex = p0.x + v0.x * T;
  const ey = p0.y + v0.y * T;
  const ez = p0.z + v0.z * T - 0.5 * G * T * T;
  check('leap matches hand-built parabola (< 1e-9 m)',
    Math.abs(s.position.x - ex) < 1e-9 && Math.abs(s.position.y - ey) < 1e-9 && Math.abs(s.position.z - ez) < 1e-9);
  check('velocity: horizontal held, vertical loses g·T',
    s.velocity.x === v0.x && s.velocity.y === v0.y && Math.abs(s.velocity.z - (v0.z - G * T)) < 1e-12);
  const stepped = BallisticTrajectoryEngine.simulateCanister(p0, v0, T, 0.0001);
  check('stepped mode (dt = 0.1 ms) agrees with leap (< 1e-5 m)',
    dist(stepped.position, s.position) < 1e-5 && Math.abs(stepped.velocity.z - s.velocity.z) < 1e-8);
  const zero = BallisticTrajectoryEngine.simulateCanister(p0, v0, 0);
  check('flightTime 0 returns the initial state',
    zero.position.x === p0.x && zero.position.y === p0.y && zero.position.z === p0.z);
  const bad1 = BallisticTrajectoryEngine.simulateCanister(p0, v0, T, 0);
  const bad2 = BallisticTrajectoryEngine.simulateCanister(p0, v0, T, NaN);
  const bad3 = BallisticTrajectoryEngine.simulateCanister(p0, v0, T, -2);
  check('garbage stepDt (0/NaN/negative) falls back to exact leap',
    dist(bad1.position, s.position) < 1e-9 && dist(bad2.position, s.position) < 1e-9 && dist(bad3.position, s.position) < 1e-9);
  // Apex check: vertical 40 m/s shot peaks at v²/2g = 493.827... m.
  const apexT = 40 / G;
  const apex = BallisticTrajectoryEngine.simulateCanister(target(0, 0, 0), vel(0, 0, 40), apexT);
  check('apex of vertical 40 m/s shot at v²/2g (< 1e-9 m)', Math.abs(apex.position.z - (40 * 40) / (2 * G)) < 1e-9);
}

// --- C. static-target closed-form cross-checks -----------------------------------
section('C. closed-form static-target checks');
{
  // Minimum-energy identity: min speed to pass point (r, h) is
  // v² = g·(h + √(r² + h²))  (reduces to √(2gh) straight up).
  const r = 400;
  const h = 1000;
  const expected = Math.sqrt(G * (h + Math.hypot(r, h)));
  const mm = BallisticTrajectoryEngine.minimumMuzzleSpeed(target(0, 0, 0), target(r, 0, h), vel(0, 0, 0));
  check(`minimumMuzzleSpeed matches √(g(h+R)) = ${expected.toFixed(3)} (< 1e-3)`,
    Math.abs(mm.requiredSpeedMps - expected) < 1e-3, JSON.stringify(mm));

  const lo = BallisticTrajectoryEngine.calculateLead(
    target(0, 0, 0), target(r, 0, h), vel(0, 0, 0), mm.requiredSpeedMps - 1);
  const hi = BallisticTrajectoryEngine.calculateLead(
    target(0, 0, 0), target(r, 0, h), vel(0, 0, 0), mm.requiredSpeedMps + 1);
  check('speed 1 m/s below minimum → no solution', !lo.hasSolution);
  check('speed 1 m/s above minimum → solution', hi.hasSolution);

  // Two-arc duality on a geometry where BOTH arcs sit inside [15°, 85°].
  const dTarget = target(2500, 0, 800);
  const near = BallisticTrajectoryEngine.calculateLead(target(0, 0, 0), dTarget, vel(0, 0, 0), 120);
  const far = BallisticTrajectoryEngine.calculateLeadLongArc(target(0, 0, 0), dTarget, vel(0, 0, 0), 120);
  check('near arc solves and is the shorter flight', near.hasSolution && far.hasSolution
    && near.estimatedFlightTimeS < far.estimatedFlightTimeS,
    `near=${near.estimatedFlightTimeS.toFixed(2)}s far=${far.estimatedFlightTimeS.toFixed(2)}s`);
  check('near arc flatter than lofted arc', near.leadElevationDeg < far.leadElevationDeg,
    `${near.leadElevationDeg.toFixed(1)} vs ${far.leadElevationDeg.toFixed(1)}`);
  check('far arc lands a dead-center hit', fireAtSolution(target(0, 0, 0), dTarget, vel(0, 0, 0), far) < 1e-6);
  check('near arc lands a dead-center hit', fireAtSolution(target(0, 0, 0), dTarget, vel(0, 0, 0), near) < 1e-6);

  // A lofted request whose far arc pierces the 85° zenith guard falls back
  // to the legal near arc instead of reporting no solution.
  const steepTarget = target(500, 0, 1500);
  const nearSteep = BallisticTrajectoryEngine.calculateLead(target(0, 0, 0), steepTarget, vel(0, 0, 0), 250);
  const farFallback = BallisticTrajectoryEngine.calculateLeadLongArc(target(0, 0, 0), steepTarget, vel(0, 0, 0), 250);
  check('far-arc request past the zenith guard falls back to the legal near arc',
    farFallback.hasSolution && Math.abs(farFallback.estimatedFlightTimeS - nearSteep.estimatedFlightTimeS) < 1e-9);
  check('steep near arc lands a dead-center hit',
    fireAtSolution(target(0, 0, 0), steepTarget, vel(0, 0, 0), nearSteep) < 1e-6);

  // Zenith target: only straight-up intercepts exist (el 90°) → hard stop wins.
  const zenith = BallisticTrajectoryEngine.calculateLead(
    target(0, 0, 0), target(0, 0, 1200), vel(0, 0, 0), 120);
  check('zenith target violates elevation stop → hasSolution false', !zenith.hasSolution);
  check('zenith report stays sane with a finite miss',
    solutionFieldsSane(zenith) && Number.isFinite(zenith.predictedMissDistanceM) && zenith.predictedMissDistanceM > 50,
    JSON.stringify(zenith));
}

// --- D. canonical moving-target grid ----------------------------------------------
section('D. moving-target canonical grid (fire → integrate → hit)');
{
  const muzzle = target(-320, -1450, TRUNNION_HEIGHT_M); // caldera seat + trunnion pivot
  const archetypes = [
    { alt: 1500, speed: 150 }, // CisLunar Horizon
    { alt: 1800, speed: 210 }, // The Obsidian Slip
    { alt: 1200, speed: 180 }, // USP Vigilance (kinematics identical, catch n/a)
  ];
  let cases = 0;
  let solved = 0;
  let hits = 0;
  for (const arch of archetypes) {
    for (const chordAz of [0, 37.5, 90, 180, 271]) {
      for (const along of [-900, -450, 0, 450, 900]) {
        const azR = chordAz * DEG;
        const dir = { x: Math.cos(azR), y: Math.sin(azR), z: 0 };
        const perp = { x: -Math.sin(azR), y: Math.cos(azR), z: 0 };
        const p = arch.alt / Math.tan(20 * DEG) * 0.6; // inside the ≥ 20° LOS funnel
        const tPos = target(
          muzzle.x + dir.x * along + perp.x * p,
          muzzle.y + dir.y * along + perp.y * p,
          arch.alt);
        const tVel = vel(dir.x * arch.speed, dir.y * arch.speed, 0);
        const mm = BallisticTrajectoryEngine.minimumMuzzleSpeed(muzzle, tPos, tVel);
        const s = Math.min(420, Math.max(180, mm.requiredSpeedMps * 1.1));
        const sol = BallisticTrajectoryEngine.calculateLead(muzzle, tPos, tVel, s);
        cases++;
        check(`grid alt=${arch.alt} az=${chordAz} along=${along}: fields sane`, solutionFieldsSane(sol));
        if (!sol.hasSolution) continue;
        solved++;
        const miss = fireAtSolution(muzzle, tPos, tVel, sol);
        if (miss < 1e-6) hits++;
        else console.log(`    · MISS ${miss.toFixed(3)} m  sol=${JSON.stringify(sol)}`);
      }
    }
  }
  check(`canonical grid: ${solved}/${cases} solved with elevation legal`, solved >= cases - 3,
    `solved=${solved} cases=${cases}`);
  check(`canonical grid: every solution fires a dead-center hit (${hits}/${solved})`, hits === solved);
}

// --- E. Monte-Carlo intercept-rate sweep -------------------------------------------
section('E. seeded Monte-Carlo intercept sweep (≥ 95% gate)');
{
  const rand = mulberry32(0x5eed27);
  const muzzle = target(-320, -1450, 0);
  const N = 600;
  let feasible = 0;
  let infeasible = 0;
  let solved = 0;
  let hits = 0;
  let maxFeasibleMinReq = 0;
  let dvFinite = 0;
  let worstMiss = 0;
  for (let i = 0; i < N; i++) {
    const alt = 1200 + rand() * 1000;             // Spec §3.2.1 altitude band
    const speed = 140 + rand() * 80;              // Spec §3.2.1 velocity band
    const vz = (rand() < 0.8 ? 0 : (rand() < 0.5 ? -10 : 10)); // mostly level, some drift
    const azR = rand() * Math.PI * 2;
    const dir = { x: Math.cos(azR), y: Math.sin(azR), z: 0 };
    const perp = { x: -Math.sin(azR), y: Math.cos(azR), z: 0 };
    const along = -1200 + rand() * 2400;
    const p = alt / Math.tan(20 * DEG) * (0.5 + rand() * 0.4);
    const tPos = target(muzzle.x + dir.x * along + perp.x * p, muzzle.y + dir.y * along + perp.y * p, alt);
    const tVel = vel(dir.x * speed, dir.y * speed, vz);
    const mm = BallisticTrajectoryEngine.minimumMuzzleSpeed(muzzle, tPos, tVel);
    if (mm.requiredSpeedMps > 420) {
      // Truly beyond the Gauss Needle: no charge in [180, 420] can intercept.
      infeasible++;
      const sol = BallisticTrajectoryEngine.calculateLead(muzzle, tPos, tVel, 420);
      if (!sol.hasSolution) { /* expected */ } else { failures.push('MC: solution beyond v_max?!'); }
      continue;
    }
    feasible++;
    maxFeasibleMinReq = Math.max(maxFeasibleMinReq, mm.requiredSpeedMps);
    const s = Math.min(420, Math.max(180, mm.requiredSpeedMps * 1.08));
    const sol = BallisticTrajectoryEngine.calculateLead(muzzle, tPos, tVel, s);
    if (!solutionFieldsSane(sol)) { failures.push(`MC: insane fields at i=${i}`); continue; }
    if (!sol.hasSolution) continue;
    solved++;
    const miss = fireAtSolution(muzzle, tPos, tVel, sol);
    worstMiss = Math.max(worstMiss, miss);
    if (miss < 1.0) hits++; // 1 m ≪ smallest R_catch (22 m) ⇒ inside every envelope
    const dv = BallisticTrajectoryEngine.interceptDeltaVelocity(muzzle, tPos, tVel, s);
    if (Number.isFinite(dv)) dvFinite++;
    if (sol.predictedMissDistanceM > 0.01) {
      failures.push(`MC: predicted miss ${sol.predictedMissDistanceM} at i=${i}`);
    }
  }
  const rate = solved > 0 ? hits / feasible : 0;
  console.log(`    · feasible=${feasible} infeasible(v>420)=${infeasible} solved=${solved} hits=${hits} rate=${(rate * 100).toFixed(2)}% worstMiss=${worstMiss.toExponential(2)} m`);
  check(`intercept rate ${(rate * 100).toFixed(2)}% ≥ 95% of catchable scenarios`, rate >= 0.95, `rate=${rate}`);
  check('solver never claims a solution beyond v_max (v>420 set all reported no-solution)', infeasible >= 0);
  check('interceptDeltaVelocity answers finite for solved solutions', dvFinite === solved, `${dvFinite}/${solved}`);
  check('predictedMissDistanceM ≈ 0 for every reported solution (checked inline)',
    !failures.some((f) => f.startsWith('MC: predicted miss')));
}

// --- F. edge cases ------------------------------------------------------------------
section('F. edge cases & invariants');
{
  const t1 = target(800, 200, 900);
  const sNaN = BallisticTrajectoryEngine.calculateLead(target(0, 0, 0), t1, vel(0, 0, 0), NaN);
  check('NaN charge → hasSolution false, miss Infinity, finite aim fields',
    !sNaN.hasSolution && sNaN.predictedMissDistanceM === Infinity
    && Number.isFinite(sNaN.leadAzimuthDeg) && Number.isFinite(sNaN.leadElevationDeg));
  const sNeg = BallisticTrajectoryEngine.calculateLead(target(0, 0, 0), t1, vel(0, 0, 0), -100);
  check('negative charge → same hygiene', !sNeg.hasSolution && sNeg.predictedMissDistanceM === Infinity);
  const sZero = BallisticTrajectoryEngine.calculateLead(target(0, 0, 0), t1, vel(0, 0, 0), 0);
  check('zero charge → hasSolution false with finite report',
    !sZero.hasSolution && Number.isFinite(sZero.predictedMissDistanceM) && solutionFieldsSane(sZero));
  const posNaN = BallisticTrajectoryEngine.calculateLead(target(NaN, 0, 0), t1, vel(0, 0, 0), 300);
  check('NaN muzzle → false + Infinity, no NaN leaks into aim',
    !posNaN.hasSolution && posNaN.predictedMissDistanceM === Infinity
    && Number.isFinite(posNaN.leadAzimuthDeg) && Number.isFinite(posNaN.leadElevationDeg));

  // Out of reach: 20 km static target needs v = √(2gh) ≈ 254.6 > any charge.
  const far = BallisticTrajectoryEngine.calculateLead(target(0, 0, 0), target(0, 500, 20000), vel(0, 0, 0), 180);
  check('20 km target at 180 m/s → no solution, recommends ≥ √(2g·h) ≈ 255',
    !far.hasSolution && far.recommendedMuzzleSpeedMps > 250 && Number.isFinite(far.predictedMissDistanceM),
    JSON.stringify(far));

  // Below the gun: elevation clamp wins, miss > 0.
  const below = BallisticTrajectoryEngine.calculateLead(target(0, 0, 100), target(600, 0, -200), vel(0, 0, 0), 300);
  check('target below the hard horizon → no solution, elevation clamped to 15°',
    !below.hasSolution && Math.abs(below.leadElevationDeg - 15) < 1e-9 && below.predictedMissDistanceM > 0,
    JSON.stringify(below));

  // Zero separation: degenerate instant intercept.
  const deg = BallisticTrajectoryEngine.calculateLead(target(5, 5, 5), target(5, 5, 5), vel(10, 0, 0), 300);
  check('zero separation → degenerate instant solution, miss 0',
    deg.hasSolution && deg.estimatedFlightTimeS === 0 && deg.predictedMissDistanceM === 0 && solutionFieldsSane(deg));

  // Determinism: identical inputs, byte-identical outputs.
  const a = BallisticTrajectoryEngine.calculateLead(target(-320, -1450, 22), target(200, -400, 1600), vel(-150, 40, 0), 260);
  const b = BallisticTrajectoryEngine.calculateLead(target(-320, -1450, 22), target(200, -400, 1600), vel(-150, 40, 0), 260);
  check('deterministic: two identical calls are identical', JSON.stringify(a) === JSON.stringify(b));

  // Random battery: aim-field invariants on EVERY answer (sane or not).
  const rand = mulberry32(0xBADC0DE);
  let saneAll = true;
  for (let i = 0; i < 400; i++) {
    const m = target(rand() * 2000 - 1000, rand() * 2000 - 1000, rand() * 50);
    const tp = target(rand() * 2000 - 1000, rand() * 2000 - 1000, rand() * 2500 - 300);
    const tv = vel(rand() * 440 - 220, rand() * 440 - 220, rand() * 60 - 30);
    const s = 180 + rand() * 240;
    const sol = BallisticTrajectoryEngine.calculateLead(m, tp, tv, s);
    const solFar = BallisticTrajectoryEngine.calculateLeadLongArc(m, tp, tv, s);
    if (!solutionFieldsSane(sol) || !solutionFieldsSane(solFar)) { saneAll = false; break; }
  }
  check('800 random scenarios (near + far): azimuth ∈ [0,360), elevation ∈ [15,85], fields finite', saneAll);
}

// --- G. integration surface -----------------------------------------------------------
section('G. MassAccelerator + OrbitalTransportSystem integration');
{
  const gun = new MassAccelerator(); // sceneless kinematics — no init() needed
  const muzzle = gun.getMuzzleWorldPosition();
  check('sceneless muzzle mouth at seat + trunnion + barrel·aim', Number.isFinite(muzzle.x + muzzle.y + muzzle.z));

  // Slew the gun onto a solution, then the physical fire vector must agree.
  const tPos = target(muzzle.x + 900, muzzle.y - 300, 1500);
  const tVel = vel(-150, 0, 0);
  const sol = BallisticTrajectoryEngine.calculateLead(muzzle, tPos, tVel, 300);
  check('integration scenario solvable', sol.hasSolution, JSON.stringify(sol));
  gun.setAimTarget(sol.leadAzimuthDeg, sol.leadElevationDeg);
  for (let i = 0; i < 60 * 40 && gun.update(1 / 60).isSlewing; i++) { /* slew to order */ }
  const gv = gun.getFireVector();
  const sv = BallisticTrajectoryEngine.aimVector(sol.leadAzimuthDeg, sol.leadElevationDeg);
  const gvErr = Math.hypot(gv.x - sv.x, gv.y - sv.y, gv.z - sv.z);
  check('MassAccelerator fire vector == solution aim vector (< 1e-6)', gvErr < 1e-6, `err=${gvErr.toExponential(2)}`);

  // Every in-window transport across the first 5 scheduled passes must be
  // solvable at full charge with a legal elevation.
  const ot = new OrbitalTransportSystem();
  let windowsSeen = 0;
  let windowTargets = 0;
  let windowSolved = 0;
  let inWindowPrev = false;
  for (let t = 0; t < 60 * 60 * 4 && windowsSeen < 5; t += 1 / 15) {
    ot.update(1 / 15);
    const st = ot.getActiveTarget();
    const inWindow = st !== null;
    if (inWindow && !inWindowPrev) windowsSeen++;
    inWindowPrev = inWindow;
    if (st === null) continue;
    if (Math.round(t * 15) % 120 !== 0) continue; // sample ~2 s cadence
    windowTargets++;
    const ws = BallisticTrajectoryEngine.calculateLead(muzzle, st.position, st.velocity, 420);
    if (ws.hasSolution && ws.leadElevationDeg >= 15 && ws.leadElevationDeg <= 85) windowSolved++;
    else console.log(`    · window target ${st.name} unsolved: ${JSON.stringify(ws)}`);
  }
  check(`first ${windowsSeen} firing windows opened (≥ 5)`, windowsSeen >= 5);
  check(`in-window targets solvable at full charge: ${windowSolved}/${windowTargets} (≥ 95%)`,
    windowTargets > 0 && windowSolved / windowTargets >= 0.95);

  // HUD arc helper: endpoints match simulateCanister.
  const arc = BallisticTrajectoryEngine.trajectoryArcPoints(muzzle, vel(100, 0, 200), 30, 13);
  const endState = BallisticTrajectoryEngine.simulateCanister(muzzle, vel(100, 0, 200), 30);
  check('trajectoryArcPoints: 13 samples, endpoints exact',
    arc.length === 13
    && Math.abs(arc[0]!.z - muzzle.z) < 1e-12
    && dist(arc[12]!, endState.position) < 1e-9);
}

// --- summary ----------------------------------------------------------------------
console.log(`\n${failures.length === 0 ? '✅ ALL GREEN' : '❌ FAILURES:'} ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✘ ${f}`);
  process.exit(1);
}
process.exit(0);
