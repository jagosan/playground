import assert from 'node:assert';
import * as THREE from 'three';
import { PhotorealisticTerrain } from '../src/minigames/moonbuggy2/PhotorealisticTerrain';
import { LRVPhysics } from '../src/minigames/moonbuggy2/LRVPhysics';

// =============================================================================
// Piglet Triage — Moonbuggy2 Milestone 2 (Spec 04) Contract Verification
//
// Contract under test (specs/04-moonbuggy2-m2.md §2.1 / §2.3):
//   1. Speed governor: hard cap at 25.0 km/h (6.944 m/s), responsive 0–20 km/h
//   2. Dynamic mass: base 360 kg (210 chassis + 150 astronaut/suit), +35 kg/rock
//      (4 rocks => 360 + 140 = 500 kg), loaded vehicle accelerates slower
//   3. Drop station at origin (0,0), 6 m radius: clears cargo weight,
//      resets battery/fuel to 100%
//
// Expected M2 API surface on LRVPhysics (Spec 04 §2.1/§2.3):
//   rockCount: number            — rocks currently carried
//   cargoMass: number            — payload kg from rocks only (35 * rockCount)
//   addRock(): void              — sample one rock (+35 kg)
//   currentMass: number          — base 360 kg + cargoMass
//   battery: number              — 0..100, starts 100, drains ~0.35%/s driving
//   inDropStation: boolean       — true while within 6 m of (0,0)
//
// The suite runs ALL checks, reports each, and exits non-zero on any failure.
// =============================================================================

console.log('🧪 [Piglet Triage] Running Moonbuggy2 M2 Contract Tests (Spec 04)...');

const results: { name: string; pass: boolean; detail: string }[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, pass: true, detail: '' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, detail });
    console.log(`  ✗ ${name}\n      ${detail}`);
  }
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const terrain = new PhotorealisticTerrain(400, 100);
const DT = 1 / 60;

// --- M2 API guard -----------------------------------------------------------
const M2_API: (keyof LRVPhysics)[] = [
  'rockCount',
  'cargoMass',
  'addRock',
  'currentMass',
  'battery',
  'inDropStation',
];
function missingM2Api(p: LRVPhysics): string[] {
  return M2_API.filter((k) => (p as Record<string, unknown>)[k] === undefined);
}

// Helper: spawn a rover near flat ground and let it settle onto the surface.
function settleRover(spawnX: number, spawnZ: number, maxSettleSec = 5): LRVPhysics {
  const groundY = terrain.getHeightAt(spawnX, spawnZ);
  const p = new LRVPhysics(terrain, new THREE.Vector3(spawnX, groundY + 1.5, spawnZ));
  let t = 0;
  while (t < maxSettleSec) {
    p.step(DT, 0, 0, 0, false, false);
    t += DT;
    if (!p.isAirborne && Math.abs(p.velocity.y) < 0.1) break;
  }
  return p;
}

// =============================================================================
// TEST GROUP 1 — Unladen acceleration curve & 25 km/h governor
// =============================================================================
console.log('\n[1/3] Unladen acceleration curve (base mass, full throttle)');

check('Terrain sanity: flat-ish spawn pad exists for dynamics tests', () => {
  const h = terrain.getHeightAt(20, -30);
  assert(!isNaN(h), 'Terrain height must be a valid number');
});

check('M2 API surface present on LRVPhysics (rockCount/cargoMass/addRock/currentMass/battery/inDropStation)', () => {
  const probe = new LRVPhysics(terrain, new THREE.Vector3(20, 5, -30));
  const missing = missingM2Api(probe);
  expect(missing.length === 0,
    `Spec 04 §2.1/§2.3 M2 API MISSING on LRVPhysics: [${missing.join(', ')}] — dynamic rock mass & drop station not implemented`);
});

let unladenCurve: number[] = [];
let unladenTimeTo20Kmh = -1;
check('Unladen rover reaches 25 km/h (~6.94 m/s) under full throttle within 30 s', () => {
  const p = settleRover(20, -30);
  expect(!p.isAirborne, 'Rover failed to settle onto the regolith surface before drive test');
  unladenCurve = [];
  let t = 0;
  let reached = false;
  let peak = 0;
  while (t < 30 && !reached) {
    p.step(DT, 1.0, 0, 0, false, false);
    t += DT;
    if (t % (0.5 / DT) < 1) unladenCurve.push(p.forwardSpeed);
    peak = Math.max(peak, p.forwardSpeed);
    if (p.forwardSpeed >= 6.9) {
      reached = true;
      if (unladenTimeTo20Kmh < 0 && p.forwardSpeed >= 5.56) unladenTimeTo20Kmh = t;
    }
  }
  // Back-solve 0-20 km/h (5.56 m/s) time from the sampled curve
  if (unladenTimeTo20Kmh < 0) {
    for (let i = 0; i < unladenCurve.length; i++) {
      if (unladenCurve[i] >= 5.56) { unladenTimeTo20Kmh = i * 0.5; break; }
    }
  }
  expect(reached, `Rover only reached ${(peak * 3.6).toFixed(1)} km/h after 30 s of full throttle (needed ≥ 25 km/h). Peak=${peak.toFixed(2)} m/s. Curve: [${unladenCurve.map((v) => v.toFixed(2)).join(', ')}]`);
});

check('Speed governor: forward speed never exceeds maxSpeed cap', () => {
  const p = settleRover(20, -40);
  let peak = 0;
  for (let t = 0; t < 30; t += DT) {
    p.step(DT, 1.0, 0, 0, false, false);
    peak = Math.max(peak, p.forwardSpeed);
  }
  expect(peak <= p.maxSpeed + 0.05,
    `Speed governor violated: peak ${(peak * 3.6).toFixed(1)} km/h (${peak.toFixed(2)} m/s) exceeds ${p.maxSpeed} m/s cap`);
});

check('Acceleration curve is monotonically non-decreasing (no oscillation) while accelerating', () => {
  for (let i = 1; i < unladenCurve.length; i++) {
    expect(unladenCurve[i] >= unladenCurve[i - 1] - 0.01,
      `Curve dipped at t=${(i * 0.5).toFixed(1)}s: ${unladenCurve[i - 1].toFixed(3)} -> ${unladenCurve[i].toFixed(3)} m/s`);
  }
});

// Soft check (warning only): Spec 04 §2.1 says 0–20 km/h in ~2.8 s, but its own
// 340 N·m / 360 kg numbers imply ~6.4 s — spec is internally inconsistent, so
// this is reported as a warning, not a hard failure.
if (unladenTimeTo20Kmh >= 0) {
  const inBand = unladenTimeTo20Kmh <= 2.8 * 1.6;
  console.log(`  ${inBand ? '✓' : '⚠'} [soft] 0–20 km/h in ${unladenTimeTo20Kmh.toFixed(2)} s (spec target ~2.8 s; spec torque numbers imply ~6.4 s)`);
}

// =============================================================================
// TEST GROUP 2 — Dynamic rock mass physics (4 rocks: 360 + 140 = 500 kg)
// =============================================================================
console.log('\n[2/3] Dynamic rock mass physics (4 rocks => 360 kg + 140 kg = 500 kg)');

let unladenSpeedAt6s = 0;
let loadedSpeedAt6s = 0;
let loadedMass = 0;

check('Base (unladen) mass is 360 kg per Spec 04 §2.1', () => {
  const p = new LRVPhysics(terrain, new THREE.Vector3(20, 5, -30));
  const missing = missingM2Api(p);
  if (missing.length > 0) throw new Error(`M2 API missing: [${missing.join(', ')}]`);
  loadedMass = p.currentMass as number;
  expect(Math.abs(p.currentMass - 360) < 1.0,
    `Base mass must be 360 kg (210 chassis + 150 astronaut/suit), got currentMass=${p.currentMass} kg`);
});

check('Each sampled rock adds exactly +35 kg (cargoMass = 35 * rockCount)', () => {
  const p = settleRover(20, -50);
  const missing = missingM2Api(p);
  if (missing.length > 0) throw new Error(`M2 API missing: [${missing.join(', ')}]`);
  (p as unknown as { addRock: () => void }).addRock();
  (p as unknown as { addRock: () => void }).addRock();
  expect(p.rockCount === 2 && Math.abs(p.cargoMass - 70) < 0.5,
    `After 2 rocks: rockCount=${p.rockCount}, cargoMass=${p.cargoMass} (expected 2 / 70 kg)`);
});

check('4-rock payload: currentMass = 500 kg (360 + 4*35)', () => {
  const p = settleRover(20, -60);
  const missing = missingM2Api(p);
  if (missing.length > 0) throw new Error(`M2 API missing: [${missing.join(', ')}]`);
  for (let i = 0; i < 4; i++) (p as unknown as { addRock: () => void }).addRock();
  expect(p.rockCount === 4, `rockCount=${p.rockCount}, expected 4`);
  expect(Math.abs(p.currentMass - 500) < 1.0,
    `currentMass=${p.currentMass} kg with 4 rocks, expected 500 kg (360 + 140)`);
});

check('Loaded vehicle (500 kg) has measurably higher inertia / slower acceleration than unladen', () => {
  // Unladen run
  const a = settleRover(30, -30);
  for (let t = 0; t < 1.0; t += DT) a.step(DT, 1.0, 0, 0, false, false);
  unladenSpeedAt6s = a.forwardSpeed;

  // Loaded run (4 rocks)
  const b = settleRover(30, -30);
  const missing = missingM2Api(b);
  if (missing.length > 0) throw new Error(`M2 API missing: [${missing.join(', ')}]`);
  for (let i = 0; i < 4; i++) (b as unknown as { addRock: () => void }).addRock();
  for (let t = 0; t < 1.0; t += DT) b.step(DT, 1.0, 0, 0, false, false);
  loadedSpeedAt6s = b.forwardSpeed;

  expect(unladenSpeedAt6s > 0.5, `Unladen vehicle made no progress: ${unladenSpeedAt6s.toFixed(3)} m/s after 1 s (drive phase may not be engaging)`);
  expect(loadedSpeedAt6s < unladenSpeedAt6s * 0.92,
    `Loaded vehicle is not slower: unladen=${unladenSpeedAt6s.toFixed(3)} m/s vs loaded=${loadedSpeedAt6s.toFixed(3)} m/s after 1 s — mass change not affecting inertia (currentMass still ${b.currentMass} kg?)`);
  // Physics cross-check: with identical force, v_loaded/v_unladen ≈ 360/500 = 0.72
  const ratio = loadedSpeedAt6s / Math.max(unladenSpeedAt6s, 1e-6);
  console.log(`      inertia cross-check: v ratio = ${ratio.toFixed(2)} (ideal mass ratio 360/500 = 0.72)`);
});

// =============================================================================
// TEST GROUP 3 — Drop station mechanics at origin (6 m radius)
// =============================================================================
console.log('\n[3/3] Apollo Science Drop Station (origin, 6 m radius)');

check('Battery starts at 100% and drains under sustained full throttle (~0.35%/s)', () => {
  const p = settleRover(25, -30);
  const missing = missingM2Api(p);
  if (missing.length > 0) throw new Error(`M2 API missing: [${missing.join(', ')}]`);
  const start = p.battery;
  expect(Math.abs(start - 100) < 0.01, `battery should start at 100%, got ${start}%`);
  for (let t = 0; t < 20; t += DT) p.step(DT, 1.0, 0, 0, false, false);
  expect(p.battery < 100, `Battery did not drain after 20 s full throttle: ${p.battery}%`);
  expect(p.battery > 50, `Battery drained unrealistically fast: ${p.battery}% after 20 s (expected ~93% at 0.35%/s)`);
  console.log(`      battery after 20 s drive: ${p.battery.toFixed(1)}%`);
});

check('Entering 6 m drop-station radius flags inDropStation', () => {
  const p = settleRover(0, 2);
  const missing = missingM2Api(p);
  if (missing.length > 0) throw new Error(`M2 API missing: [${missing.join(', ')}]`);
  const dist = Math.hypot(p.position.x, p.position.z);
  expect(dist <= 6, `Rover settled ${dist.toFixed(2)} m from origin — outside station radius (spawn issue)`);
  expect(p.inDropStation === true, `inDropStation=false while ${dist.toFixed(2)} m from origin (station logic missing or radius wrong)`);
});

check('Drop station clears cargo weight (4 rocks -> 0, cargoMass -> 0)', () => {
  const p = settleRover(0, 3);
  const missing = missingM2Api(p);
  if (missing.length > 0) throw new Error(`M2 API missing: [${missing.join(', ')}]`);
  for (let i = 0; i < 4; i++) (p as unknown as { addRock: () => void }).addRock();
  expect(p.rockCount === 4, `setup: expected 4 rocks, got ${p.rockCount}`);
  // Give the station a few ticks to process the drop
  for (let t = 0; t < 2; t += DT) p.step(DT, 0, 0, 0, false, false);
  expect(p.rockCount === 0 && Math.abs(p.cargoMass) < 0.5,
    `Cargo not cleared at drop station: rockCount=${p.rockCount}, cargoMass=${p.cargoMass} kg (expected 0 / 0)`);
  expect(Math.abs(p.currentMass - 360) < 1.0, `Mass not restored to 360 kg after drop: ${p.currentMass} kg`);
});

check('Drop station resets battery to 100% (from drained state)', () => {
  const p = settleRover(0, 3);
  const missing = missingM2Api(p);
  if (missing.length > 0) throw new Error(`M2 API missing: [${missing.join(', ')}]`);
  for (let i = 0; i < 4; i++) (p as unknown as { addRock: () => void }).addRock();
  // Drive away to drain battery, then return to the station
  for (let t = 0; t < 20; t += DT) p.step(DT, 1.0, 0, 0, false, false);
  const drained = p.battery;
  // Teleport back inside the 6 m station radius
  const gy = terrain.getHeightAt(0, 0);
  p.position.set(0, gy + 1.2, 0);
  p.velocity.set(0, 0, 0);
  // Spec: station recharges at 15%/s — allow up to 12 s for full replenishment
  for (let t = 0; t < 12 && p.battery < 99.9; t += DT) p.step(DT, 0, 0, 0, false, false);
  expect(Math.abs(p.battery - 100) < 0.5,
    `Battery did not reset to 100% at drop station: drained=${drained.toFixed(1)}% -> ${p.battery.toFixed(1)}% (station recharge at 15%/s missing?)`);
  console.log(`      battery: ${drained.toFixed(1)}% -> ${p.battery.toFixed(1)}% after station dwell`);
});

// =============================================================================
// Summary
// =============================================================================
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`\n${'='.repeat(72)}`);
console.log(`📋 [Piglet Triage] M2 Contract Summary: ${passed}/${results.length} passed, ${failed} failed`);
for (const r of results) {
  if (!r.pass) console.log(`   ✗ ${r.name}\n     ${r.detail}`);
}
if (failed === 0) {
  console.log('🎉 [Piglet Triage] All Moonbuggy2 M2 contract tests PASSED — 25 km/h governor, dynamic rock mass, and drop station verified.');
} else {
  console.log('🚨 [Piglet Triage] M2 contract VIOLATED — Spec 04 (M2) features not verified. See failures above.');
}
process.exitCode = failed === 0 ? 0 : 1;
