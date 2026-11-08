/**
 * Spec 37 Phase 6 — headless acceptance smoke suite for the Buggy Workshop &
 * Modular Upgrades: Cargo Beds, High-Torque Powertrain & Magnetic Catchers.
 *
 * Runs fully headless under `npx tsx scripts/smoke-spec37-buggy-upgrades.ts`
 * (exit 0 == all green). One shared `NullEngine` for the process; a minimal
 * fake DOM for the garage terminal harness; no network, no audio device
 * (audio is exercised through injected cue spies).
 *
 * Acceptance gates (Spec 37 §4, blueprint 37 §Phase 6):
 *   GATE 1  Stat Scaling (§4.1) — factory baseline 18.0 m/s / 6 cans /
 *           200 kg / 1.8 m / 0.35 m / 6 m absorb; Tier 3 Quad Motors lands
 *           EXACTLY 35.0 m/s; Tier 4 nitro reaches 45.0 m/s (4.0 s burn,
 *           15.0 s recharge) and drives the physics governor there; Tier 2
 *           Extended Bed raises hopper capacity to 12; every tree's tier
 *           effects compound deterministically (pure function, no clock).
 *   GATE 2  Economic Debit (§4.2) — purchases debit the wallet by the exact
 *           catalog cost; insufficient funds fail cleanly (error code,
 *           balance AND installed state untouched); sequential tier gating,
 *           already-installed / invalid category / invalid tier rejections;
 *           verifyPurchase purity; autosave on success.
 *   GATE 3  Chassis RCS Jump (§4.3) — rising-edge Jump while driving on the
 *           ground delivers ≥ 7.5 m/s upward vertical velocity (law: 8.0),
 *           opens the 0.45 s cold-gas plume window, counts firings, refuses
 *           held-button pumping, ignores the press on a stock build, and
 *           clears ≥ 15 m of lunar hangtime.
 *   GATE 4  Procedural Attachment & Bay Meshes — extended flatbed deck +
 *           subframe, double-tier rails, upper deck, mag-net webbing,
 *           tractor gantry, 4 cyan hub caps, 4 nitrogen reservoirs, 4 RCS
 *           nozzles + plume emitters, mining array; root/physics identity
 *           across re-mount churn; downgrade tears down cleanly; the outpost
 *           maintenance bay assembly (≥ 50 meshes, 4 floodlights, seat at
 *           (240, −160), 12 m proximity ring) builds under NullEngine.
 *   GATE 5  Persistence — versioned localStorage envelope round-trip,
 *           corrupt/wrong-version saves rejected without mutation; SQLite
 *           repository migration, upsert, read-back, clamp and delete
 *           against a real `sqlite3` :memory: driver.
 *   GATE 6  Interactive Terminal UI — headless GarageTerminalUI: keyboard
 *           (Tab / arrows / WASD / Enter / Esc) and gamepad (RB / LB /
 *           D-Pad / A / B) navigation with rising edges, delta meters
 *           (`Top Speed: 18.0 m/s -> 26.0 m/s (+44%)` + NEW feature rows),
 *           purchase callbacks committing the wallet, tier pips, red
 *           insufficient-funds feedback, and audio cue triggers.
 *   GATE 7  NullEngine Gate — ≥ 65 assertions, zero failures, clean
 *           scene/engine dispose.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import sqlite3 from 'sqlite3';

import { OpenBuggy } from '../src/entities/OpenBuggy.ts';
import type { InstalledUpgrades } from '../src/garage/BuggyUpgradeSystem.ts';
import {
  BuggyUpgradeSystem,
  BuggyUpgradeRepository,
  BUGGY_UPGRADE_STORAGE_KEY,
  BUGGY_UPGRADE_SAVE_VERSION,
  InMemoryUpgradeStorage,
  UPGRADE_CATEGORIES,
  UPGRADE_CATALOG,
  calculateBuggyStats,
  defaultInstalledUpgrades,
  deserializeInstalled,
  getUpgradeCost,
  getUpgradeTier,
  serializeInstalled,
  validateInstalledShape,
  verifyPurchase,
} from '../src/garage/BuggyUpgradeSystem.ts';
import type { PurchaseResult, SqliteLike } from '../src/garage/BuggyUpgradeSystem.ts';
import {
  LunarBuggy,
  LUNAR_GRAVITY,
  BUGGY_RCS_PLUME_S,
} from '../src/physics/TraversalPhysics.ts';
import type { BuggyInput } from '../src/physics/TraversalPhysics.ts';
import { WorldScene, MAINTENANCE_BAY_RADIUS_M } from '../src/engine/index.ts';
import {
  GarageTerminalUI,
  computeStatDeltaRows,
  tierStateFor,
  GARAGE_GAMEPAD_BUTTONS,
  GARAGE_TERMINAL_ID,
} from '../src/ui/GarageTerminalUI.ts';
import type { GarageAudioCues } from '../src/ui/GarageTerminalUI.ts';

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];
let currentGate = 'preamble';

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  [GATE ${currentGate}] PASS ${label}`);
  } else {
    failures.push(`[GATE ${currentGate}] ${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  [GATE ${currentGate}] FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const EQ = 1e-9;
const IDLE: BuggyInput = { throttle: 0, brake: 0, regen: 0, steer: 0, parkBrake: true };

// ---------------------------------------------------------------------------
// One shared NullEngine + scene for every mesh gate
// ---------------------------------------------------------------------------

const engine = new NullEngine();
const scene = new Scene(engine);
check('NullEngine constructed', engine !== null && scene !== null);

// ===========================================================================
// GATE 1 — Stat Scaling (Spec 37 §4.1)
// ===========================================================================
currentGate = '1';
{
  const base = calculateBuggyStats();
  check('baseline top speed is 18.0 m/s', base.topSpeedMs === 18.0);
  check('baseline wheel torque is 1400 N·m', base.wheelTorqueNm === 1400);
  check('baseline hopper holds 6 canisters', base.canisterCapacity === 6);
  check('baseline payload is 200 kg', base.maxPayloadKg === 200);
  check('baseline capture radius is 1.8 m', Math.abs(base.captureRadiusM - 1.8) < EQ);
  check('baseline suspension travel is 0.35 m', Math.abs(base.suspensionTravelM - 0.35) < EQ);
  check('baseline absorb drop is 6 m', base.maxAbsorbDropM === 6);
  check(
    'baseline mining: 1.0×, no swath, no deep core',
    base.extractionMultiplier === 1.0 && base.swathWidthM === 0 && base.unlocksDeepCore === false,
  );
  check(
    'baseline has no nitro / RCS / tractor beam',
    base.nitro === null && base.rcsJump === null && base.tractorBeam === null,
  );

  // Powertrain ladder: 18 → 26 → 35 → +nitro 45.
  check('Tier 2 brushless reaches 26.0 m/s', calculateBuggyStats({ powertrain: 2 }).topSpeedMs === 26.0);
  const t3 = calculateBuggyStats({ powertrain: 3 });
  check('Tier 3 Quad Motors reaches EXACTLY 35.0 m/s (§4.1)', t3.topSpeedMs === 35.0);
  check('Tier 3 wheel torque is 3800 N·m', t3.wheelTorqueNm === 3800);
  const t4 = calculateBuggyStats({ powertrain: 4 });
  check(
    'Tier 4 nitro sprint law is 45.0 m/s for 4.0 s',
    t4.nitro !== null && t4.nitro.sprintSpeedMs === 45.0 && t4.nitro.durationS === 4.0,
    JSON.stringify(t4.nitro),
  );
  check('Tier 4 capacitor recharge is 15.0 s', t4.nitro !== null && t4.nitro.rechargeS === 15.0);
  check('Tier 4 keeps the 35.0 m/s non-nitro ceiling', t4.topSpeedMs === 35.0);

  // Cargo ladder.
  const bed2 = calculateBuggyStats({ cargo_bed: 2 });
  check('Tier 2 Extended Bed raises capacity to 12 cans (§ gate)', bed2.canisterCapacity === 12);
  check(
    'Tier 2 payload 500 kg, +0.6 m subframe',
    bed2.maxPayloadKg === 500 && Math.abs(bed2.subframeExtensionM - 0.6) < EQ,
  );
  check(
    'Tier 3 mag net expands capture radius to 3.5 m',
    Math.abs(calculateBuggyStats({ cargo_bed: 3 }).captureRadiusM - 3.5) < EQ,
  );
  const bed4 = calculateBuggyStats({ cargo_bed: 4 });
  check(
    'Tier 4 tractor beam reels 12 m @ 8.0 m/s',
    bed4.tractorBeam !== null && bed4.tractorBeam.radiusM === 12 && bed4.tractorBeam.reelSpeedMs === 8.0,
  );

  // Suspension ladder.
  const susp2 = calculateBuggyStats({ suspension: 2 });
  check(
    'Tier 2 dampers: 0.55 m travel, 15 m absorb',
    Math.abs(susp2.suspensionTravelM - 0.55) < EQ && susp2.maxAbsorbDropM === 15,
  );
  check(
    'Tier 3 active ride-height adds +0.25 m',
    Math.abs(calculateBuggyStats({ suspension: 3 }).rideHeightBonusM - 0.25) < EQ,
  );
  const susp4 = calculateBuggyStats({ suspension: 4 });
  check(
    'Tier 4 RCS jump law is vz → +8.0 m/s',
    susp4.rcsJump !== null && susp4.rcsJump.vzMs === 8.0,
  );

  // Mining ladder.
  check('Tier 2 thermal drill is 2.5×', calculateBuggyStats({ mining_suite: 2 }).extractionMultiplier === 2.5);
  check(
    'Tier 3 wide scoop opens a 4.5 m swath',
    Math.abs(calculateBuggyStats({ mining_suite: 3 }).swathWidthM - 4.5) < EQ,
  );
  check('Tier 4 resonator unlocks deep core', calculateBuggyStats({ mining_suite: 4 }).unlocksDeepCore === true);

  // Determinism + catalog costs.
  const maxed: InstalledUpgrades = { cargo_bed: 4, powertrain: 4, suspension: 4, mining_suite: 4 };
  check(
    'calculateBuggyStats is deterministic (pure)',
    JSON.stringify(calculateBuggyStats(maxed)) === JSON.stringify(calculateBuggyStats(maxed)),
  );
  check(
    'catalog costs match Spec 37 §2 exactly',
    getUpgradeCost('cargo_bed', 2) === 3500 &&
      getUpgradeCost('powertrain', 3) === 14000 &&
      getUpgradeCost('powertrain', 4) === 32000 &&
      getUpgradeCost('suspension', 2) === 5000 &&
      getUpgradeCost('suspension', 4) === 28000 &&
      getUpgradeCost('mining_suite', 4) === 25000,
  );
  check('tier 5 does not exist in any tree', UPGRADE_CATEGORIES.every((c) => getUpgradeTier(c, 5) === undefined));
  check('stock tiers are free', UPGRADE_CATEGORIES.every((c) => getUpgradeCost(c, 1) === 0));
}

// ===========================================================================
// GATE 2 — Economic Debit (Spec 37 §4.2)
// ===========================================================================
currentGate = '2';
{
  const storage = new InMemoryUpgradeStorage();
  const sys = new BuggyUpgradeSystem({ storage });

  const r1 = sys.purchaseUpgrade('cargo_bed', 2, 20000);
  check('purchase succeeds with sufficient funds', r1.success === true);
  check('wallet debited by EXACT catalog cost (20000→16500)', r1.newBalance === 16500);
  check('installed cargo_bed becomes tier 2', r1.installed.cargo_bed === 2 && sys.getInstalled().cargo_bed === 2);
  check('autosave persisted the purchase', storage.getItem(BUGGY_UPGRADE_STORAGE_KEY) !== null);

  // Insufficient funds — clean rejection, zero state mutation.
  const beforeState = sys.getInstalled();
  const r2 = sys.purchaseUpgrade('powertrain', 2, 4499);
  check('insufficient funds rejected with machine code', r2.success === false && r2.error === 'insufficient_funds');
  check('rejected purchase leaves balance untouched', r2.newBalance === 4499);
  check(
    'rejected purchase mutates NO installed state',
    JSON.stringify(sys.getInstalled()) === JSON.stringify(beforeState),
  );

  // Sequential tier gating.
  const r3 = sys.purchaseUpgrade('powertrain', 3, 999999);
  check('tier 3 before tier 2 → tier_not_unlocked', r3.success === false && r3.error === 'tier_not_unlocked');
  check('locked-tier attempt mutates no state', sys.getInstalled().powertrain === 1);

  // Already installed / invalid inputs.
  const r4 = sys.purchaseUpgrade('cargo_bed', 2, 999999);
  check('re-purchase of installed tier → already_installed', r4.success === false && r4.error === 'already_installed');
  const r5 = sys.purchaseUpgrade('powertrain', 9 as never, 999999);
  check('nonexistent tier → invalid_tier', r5.success === false && r5.error === 'invalid_tier');
  const r6 = sys.purchaseUpgrade('warp_drive' as never, 2, 999999);
  check('unknown category → invalid_category', r6.success === false && r6.error === 'invalid_category');

  // verifyPurchase purity.
  const frozen = defaultInstalledUpgrades();
  const pure = verifyPurchase(frozen, 'suspension', 2, 5000);
  check(
    'verifyPurchase is pure: returns new state, inputs untouched',
    pure.success === true &&
      pure.installed.suspension === 2 &&
      frozen.suspension === 1 &&
      pure.newBalance === 0,
  );

  // Chained ladder pays out to the exact residual (Spec 37 §2 totals).
  const sysAll = new BuggyUpgradeSystem({ storage: new InMemoryUpgradeStorage(), autosave: false });
  let balance = 200000;
  const plan: Array<[keyof InstalledUpgrades, number]> = [
    ['cargo_bed', 2], ['cargo_bed', 3], ['cargo_bed', 4],
    ['powertrain', 2], ['powertrain', 3], ['powertrain', 4],
    ['suspension', 2], ['suspension', 3], ['suspension', 4],
    ['mining_suite', 2], ['mining_suite', 3], ['mining_suite', 4],
  ];
  let allOk = true;
  for (const [cat, tier] of plan) {
    const r = sysAll.purchaseUpgrade(cat as never, tier, balance);
    if (!r.success) allOk = false;
    else balance = r.newBalance;
  }
  // Total catalog spend: 34000 + 50500 + 44000 + 41500 = 170000.
  check('full 12-purchase ladder succeeds and debits 170,000 cr exactly', allOk && balance === 30000);

  // Shape validation guards.
  check('validateInstalledShape rejects junk', !validateInstalledShape({ cargo_bed: 0 }) && !validateInstalledShape(null));
  let threw = false;
  try {
    sysAll.setInstalled({ cargo_bed: 9, powertrain: 1, suspension: 1, mining_suite: 1 } as unknown as InstalledUpgrades);
  } catch {
    threw = true;
  }
  check('setInstalled rejects corrupted shape', threw);
}

// ===========================================================================
// GATE 3 — Chassis RCS Jump (Spec 37 §4.3)
// ===========================================================================
currentGate = '3';
{
  check('cold-gas plume window constant is 0.45 s', BUGGY_RCS_PLUME_S === 0.45);

  const stats = calculateBuggyStats({ suspension: 4 });
  check('RCS jump spec law is exactly vz = 8.0 m/s', stats.rcsJump !== null && stats.rcsJump.vzMs === 8.0);

  const flat = () => 0;
  const phys = new LunarBuggy({ groundElevation: flat });
  phys.setUpgradeStats(stats);

  // Settle on the ground.
  let s = phys.getState();
  for (let i = 0; i < 120; i++) s = phys.step(1 / 120, IDLE);
  check('buggy settles grounded before the jump', s.airborne === false);

  // Driving on the ground, rising-edge Jump press.
  const drive: BuggyInput = { throttle: 0.6, brake: 0, regen: 0, steer: 0, parkBrake: false, jump: true };
  s = phys.step(1 / 120, drive);
  check('jump delivers ≥ 7.5 m/s upward (§4.3)', s.vBody >= 7.5, `vBody=${s.vBody.toFixed(3)}`);
  check('jump law sets vBody to exactly 8.0 m/s', Math.abs(s.vBody - 8.0) < 0.05);
  check('firing counted (rcsJumpCount === 1)', s.rcsJumpCount === 1);
  check('cold-gas plume window opens on firing', s.rcsPlumeActive === true);

  // A held button must not pump the pods through the arc.
  const z0 = s.z;
  let pumped = false;
  for (let i = 0; i < 40; i++) {
    s = phys.step(1 / 120, drive); // jump still held
    if ((s.rcsJumpCount ?? 0) !== 1) pumped = true;
  }
  check('held jump does not pump extra firings', pumped === false);

  // Release, fly the whole lunar arc (2·vz/g ≈ 9.9 s) back to the ground,
  // tracking the apex rise across the entire flight.
  const release: BuggyInput = { ...drive, jump: false };
  let steps = 0;
  let rise = s.z - z0;
  while (s.airborne && steps < 3000) {
    s = phys.step(1 / 120, release);
    rise = Math.max(rise, s.z - z0);
    steps += 1;
  }
  check(
    `hangtime clears ≥ 15 m of relief (rose ${rise.toFixed(1)} m, apex law ${((8 * 8) / (2 * LUNAR_GRAVITY)).toFixed(1)} m)`,
    rise >= 15,
  );
  check('buggy lands back on the regolith', s.airborne === false);
  check('plume window expired after the 0.45 s clock', s.rcsPlumeActive === false);

  // Fresh ground press fires again.
  s = phys.step(1 / 120, drive);
  check('second grounded press fires (count === 2)', s.rcsJumpCount === 2 && s.rcsPlumeActive === true);

  // Stock build ignores the jump input entirely.
  const stock = new LunarBuggy({ groundElevation: flat });
  stock.setUpgradeStats(calculateBuggyStats());
  let ss = stock.getState();
  for (let i = 0; i < 60; i++) ss = stock.step(1 / 120, IDLE);
  ss = stock.step(1 / 120, drive);
  check('stock build ignores jump press (vBody < 7.5, count 0)', ss.vBody < 7.5 && ss.rcsJumpCount === 0);
}

// -- Tier 4 nitro overdrive physics (Spec 37 §2.2 law, part of Gate 1/3 span)
currentGate = '3n';
{
  const flat = () => 0;
  const nitro = new LunarBuggy({ groundElevation: flat });
  nitro.setUpgradeStats(calculateBuggyStats({ powertrain: 4 }));
  const go: BuggyInput = { throttle: 1, brake: 0, regen: 0, steer: 0, parkBrake: false, boost: true };

  let s = nitro.getState();
  let maxV = 0;
  let governorDuringSprint = 0;
  let sawActive = false;
  for (let i = 0; i < Math.round(3.4 * 120); i++) {
    s = nitro.step(1 / 120, go);
    if (s.nitroActive) {
      sawActive = true;
      governorDuringSprint = nitro.topSpeedGovernor;
    }
    maxV = Math.max(maxV, s.vLong);
  }
  check('nitro sprint engages on rising-edge boost', sawActive);
  check('governor lifts to 45.0 m/s while sprinting', Math.abs(governorDuringSprint - 45.0) < EQ);
  check(`nitro sprint drives the buggy to 45 m/s (maxV ${maxV.toFixed(2)})`, maxV >= 44.0);
  check('capacitor drains while discharging', (s.nitroCharge ?? 1) < 0.99);

  // Hold past the 4.0 s burn: capacitor empties into a recharge cooldown.
  for (let i = 0; i < Math.round(1.0 * 120); i++) s = nitro.step(1 / 120, go);
  check(
    'empty capacitor trips nitro off into ~15 s recharge',
    s.nitroActive === false && (s.nitroCooldownS ?? 0) > 14 && (s.nitroCooldownS ?? 0) <= 15,
    `cooldown=${(s.nitroCooldownS ?? -1).toFixed(2)}`,
  );
  check('governor falls back to the 35.0 m/s ceiling', Math.abs(nitro.topSpeedGovernor - 35.0) < EQ);
}

// ===========================================================================
// GATE 4 — Procedural Attachments & Maintenance Bay Meshes
// ===========================================================================
currentGate = '4';
{
  const buggy = new OpenBuggy().init(scene);
  const root = buggy.getRootNode();
  const physicsRef = buggy.getPhysics();
  check('stock buggy mounts zero upgrade attachments', buggy.getUpgradeMeshes().length === 0);
  check('stock hopper capacity is 6', buggy.getCargoHopper()?.getCapacity() === 6);
  check('base 69-mesh contract intact', buggy.getMeshes().length === 69);

  const maxed: InstalledUpgrades = { cargo_bed: 4, powertrain: 4, suspension: 4, mining_suite: 4 };
  const stats = buggy.applyUpgrades(maxed);
  const ups = buggy.getUpgradeMeshes().map((m) => m.name);
  check('max build raises stats.canisterCapacity to 12', stats.canisterCapacity === 12);
  check('hopper physically raised to 12 slots', buggy.getCargoHopper()?.getCapacity() === 12);
  check('extended bed deck + subframe beam mounted', ups.some((n) => n.includes('flatbed-deck')) && ups.some((n) => n.includes('subframe-beam')));
  check('double-tier side rails mounted', ups.some((n) => n.includes('side-rail-lower')) && ups.some((n) => n.includes('side-rail-upper')));
  check('upper deck mounted for the 12-slot stack', ups.some((n) => n.includes('upper-deck')));
  check('mag-net holo webbing mounted', ups.some((n) => n.includes('mag-net')));
  check('tractor gantry + lens mounted', ups.some((n) => n.includes('gantry-crossbar')) && ups.some((n) => n.includes('tractor-lens')));
  check('4 cyan hub caps mounted', ups.filter((n) => n.includes('hubcap')).length === 4);
  check('4 nitrogen reservoir reservoirs mounted', ups.filter((n) => n.includes('nitro-canister-') && !n.includes('cap')).length === 4);
  check('4 RCS nozzle cones mounted', ups.filter((n) => n.includes('rcs-nozzle')).length === 4);
  check('4 RCS plume emitters live', buggy.getRcsPlumes().length === 4);
  check('mining thermal emitter mounted', ups.some((n) => n.includes('thermal-barrel')));
  check('mining wide scoop mounted', ups.some((n) => n.includes('scoop-plate')));
  check('deep-core resonator dish mounted', ups.some((n) => n.includes('resonator-dish')));
  check('physics root NOT rebuilt on upgrade', buggy.getRootNode() === root && buggy.getPhysics() === physicsRef);

  // Frames keep stepping finitely with every attachment live.
  let ok = true;
  for (let i = 0; i < 30; i++) {
    const st = buggy.update(1 / 60, { throttle: 0.8, brake: 0, regen: 0, steer: 0.3, parkBrake: false });
    ok = ok && Number.isFinite(st.x) && Number.isFinite(st.y) && Number.isFinite(st.z);
  }
  check('30 frames of update() finite with full build', ok);

  // Dynamic downgrade tears down without touching the root.
  buggy.applyUpgrades({ cargo_bed: 2, powertrain: 1, suspension: 1, mining_suite: 1 });
  const ups2 = buggy.getUpgradeMeshes().map((m) => m.name);
  check('downgrade removes hub caps', !ups2.some((n) => n.includes('hubcap')));
  check('downgrade drains plume emitters', buggy.getRcsPlumes().length === 0);
  check('downgrade keeps the flatbed', ups2.some((n) => n.includes('flatbed-deck')));
  check('downgrade preserves root identity', buggy.getRootNode() === root);

  // Re-apply churn does not leak meshes.
  buggy.applyUpgrades(maxed);
  const before = buggy.getUpgradeMeshes().length;
  for (let i = 0; i < 5; i++) buggy.applyUpgrades(maxed);
  check('re-apply churn accumulates no meshes', buggy.getUpgradeMeshes().length === before && before > 0);

  buggy.dispose();
  check('dispose drains upgrade meshes + plumes', buggy.getUpgradeMeshes().length === 0 && buggy.getRcsPlumes().length === 0);

  // -- Outpost maintenance bay (Spec 37 Phase 5 environment) ------------------
  const world = new WorldScene({ seed: 'spec37-p6' });
  world.init(engine);
  const bay = world.getMaintenanceBay();
  check('maintenance bay auto-builds on init()', bay !== null);
  if (bay !== null) {
    check(`bay assembly ≥ 50 meshes (got ${bay.meshes.length})`, bay.meshes.length >= 50);
    check(`bay has 4 halogen floodlights (got ${bay.lights.length})`, bay.lights.length === 4);
    check('bay seat is (240, −160)', bay.center.x === 240 && bay.center.y === -160);
    check('bay proximity ring radius is 12 m', bay.radiusM === MAINTENANCE_BAY_RADIUS_M);
  }
  check('isInMaintenanceBay true inside the ring', world.isInMaintenanceBay({ x: 243, y: -157 }));
  check('isInMaintenanceBay false outside the ring', !world.isInMaintenanceBay({ x: 300, y: -160 }));
  world.render();
  check('NullEngine world render throws nothing', true);
  world.dispose();
  check('dispose drains the bay', world.getMaintenanceBay() === null);
}

// ===========================================================================
// GATE 5 — Persistence (localStorage envelope + SQLite repository)
// ===========================================================================
currentGate = '5';
{
  // -- Versioned localStorage round-trip --------------------------------------
  const env = JSON.parse(serializeInstalled({ cargo_bed: 3, powertrain: 2, suspension: 1, mining_suite: 4 })) as {
    version: number;
    savedAt: number;
  };
  check('save envelope carries version + timestamp', env.version === BUGGY_UPGRADE_SAVE_VERSION && typeof env.savedAt === 'number');
  const storage = new InMemoryUpgradeStorage();
  const sysA = new BuggyUpgradeSystem({ storage });
  sysA.setInstalled({ cargo_bed: 3, powertrain: 2, suspension: 1, mining_suite: 4 });
  const sysB = new BuggyUpgradeSystem({ storage });
  check('client reload restores installed state', sysB.load() === true && JSON.stringify(sysB.getInstalled()) === JSON.stringify({ cargo_bed: 3, powertrain: 2, suspension: 1, mining_suite: 4 }));
  check('corrupt save JSON ignored without mutation', deserializeInstalled('{not json') === null);
  check(
    'wrong-version envelope ignored',
    deserializeInstalled(JSON.stringify({ version: 99, savedAt: 1, installed: defaultInstalledUpgrades() })) === null,
  );
  check(
    'shape-corrupted envelope ignored',
    deserializeInstalled(JSON.stringify({ version: BUGGY_UPGRADE_SAVE_VERSION, savedAt: 1, installed: { cargo_bed: 42 } })) === null,
  );
  const sysC = new BuggyUpgradeSystem({ storage: new InMemoryUpgradeStorage() });
  check('load() on empty storage returns false', sysC.load() === false);
  sysB.clear();
  check('clear() wipes storage and resets to stock', storage.getItem(BUGGY_UPGRADE_STORAGE_KEY) === null && sysB.getInstalled().cargo_bed === 1);

  // -- SQLite repository against a REAL sqlite3 :memory: driver ----------------
  class NodeSqlite implements SqliteLike {
    private readonly db: sqlite3.Database;
    constructor(path: string) {
      this.db = new sqlite3.Database(path);
    }
    exec(sql: string): Promise<void> {
      return new Promise((resolve, reject) => this.db.exec(sql, (err) => (err ? reject(err) : resolve())));
    }
    run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
      return new Promise((resolve, reject) =>
        this.db.run(sql, params, function (this: sqlite3.RunResult, err: Error | null) {
          if (err) reject(err);
          else resolve({ lastID: this.lastID, changes: this.changes });
        }),
      );
    }
    get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      return new Promise((resolve, reject) =>
        this.db.get(sql, params, (err: Error | null, row: T | undefined) => (err ? reject(err) : resolve(row))),
      );
    }
    all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return new Promise((resolve, reject) =>
        this.db.all(sql, params, (err: Error | null, rows: T[]) => (err ? reject(err) : resolve(rows))),
      );
    }
    close(): Promise<void> {
      return new Promise((resolve, reject) => this.db.close((err) => (err ? reject(err) : resolve())));
    }
  }
  void (async () => {
    const db = new NodeSqlite(':memory:');
    const repo = new BuggyUpgradeRepository(db);
    let sqliteFails = 0;
    const c = (label: string, ok: boolean, detail?: string): void => {
      check(label, ok, detail);
      if (!ok) sqliteFails += 1;
    };
    try {
      await repo.migrate();
      c('buggy_upgrades migration applies cleanly', true);
      const tables = await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='buggy_upgrades'",
      );
      c('buggy_upgrades table exists after migration', tables.length === 1);
      await repo.migrate();
      c('migration is idempotent', true);

      const installed: InstalledUpgrades = { cargo_bed: 2, powertrain: 3, suspension: 1, mining_suite: 1 };
      const saved = await repo.saveInstalled('player-1', installed);
      c('SQLite save round-trips installed tiers exactly', JSON.stringify(saved) === JSON.stringify(installed));
      const read = await repo.getInstalled('player-1');
      c('SQLite read-back matches', JSON.stringify(read) === JSON.stringify(installed));

      const upgraded: InstalledUpgrades = { ...installed, powertrain: 4 };
      await repo.saveInstalled('player-1', upgraded);
      const read2 = await repo.getInstalled('player-1');
      c('upsert overwrites (powertrain 3→4, single row)', JSON.stringify(read2) === JSON.stringify(upgraded));
      c('unknown player has no row', (await repo.getInstalled('ghost')) === undefined);

      // Corrupt row → clampTier guard on read.
      await db.run(
        'INSERT INTO buggy_upgrades (player_id, cargo_bed, powertrain, suspension, mining_suite, updated_at) VALUES (?,?,?,?,?,?)',
        ['player-bad', 99, -5, 2.7, 0, '2026-01-01T00:00:00Z'],
      );
      const clamped = await repo.getInstalled('player-bad');
      c(
        'corrupt DB row clamps to legal tiers',
        clamped !== undefined && clamped.cargo_bed === 4 && clamped.powertrain === 1 && clamped.suspension === 2 && clamped.mining_suite === 1,
        JSON.stringify(clamped),
      );

      const deleted = await repo.deleteInstalled('player-1');
      c('deleteInstalled removes exactly one row', deleted === 1 && (await repo.getInstalled('player-1')) === undefined);
    } catch (err) {
      c(`SQLite repository section threw: ${String(err)}`, false);
    }
    await db.close();
    finish(sqliteFails);
  })();
}

// ===========================================================================
// GATE 6 — Interactive Garage Terminal UI (headless fake DOM)
// ===========================================================================
function runTerminalGate(): void {
  currentGate = '6';

  // -- minimal fake DOM compatible with Elementish / Documentish ---------------
  interface FEl {
    tag: string;
    id: string;
    textContent: string;
    children: FEl[];
    parent: FEl | null;
    classes: Set<string>;
    attrs: Map<string, string>;
    classList: {
      add(...names: string[]): void;
      remove(...names: string[]): void;
      contains(name: string): boolean;
    };
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    appendChild(child: FEl): FEl;
    remove(): void;
    addEventListener?(type: string, listener: (e: unknown) => void): void;
    removeEventListener?(type: string, listener: (e: unknown) => void): void;
  }
  const registry = new Map<string, FEl>();
  function makeEl(tag: string): FEl {
    const el: FEl = {
      tag,
      id: '',
      textContent: '',
      children: [],
      parent: null,
      classes: new Set<string>(),
      attrs: new Map<string, string>(),
      classList: {
        add: (...names: string[]) => names.forEach((n) => el.classes.add(n)),
        remove: (...names: string[]) => names.forEach((n) => el.classes.delete(n)),
        contains: (n: string) => el.classes.has(n),
      },
      setAttribute: (name: string, value: string) => {
        el.attrs.set(name, value);
        if (name === 'id') {
          el.id = value;
          registry.set(value, el);
        }
      },
      getAttribute: (name: string) => el.attrs.get(name) ?? null,
      appendChild: (child: FEl) => {
        el.children.push(child);
        child.parent = el;
        return child;
      },
      remove: () => {
        if (el.parent !== null) {
          const idx = el.parent.children.indexOf(el);
          if (idx >= 0) el.parent.children.splice(idx, 1);
        }
      },
    };
    return el;
  }
  const body = makeEl('body');
  const doc = {
    body,
    createElement: (tag: string) => makeEl(tag),
    addEventListener: (_type: string, _l: unknown) => undefined,
    removeEventListener: (_type: string, _l: unknown) => undefined,
  };

  const findByTestId = (root: FEl, testid: string): FEl | undefined => {
    if (root.attrs.get('data-testid') === testid) return root;
    for (const child of root.children) {
      const hit = findByTestId(child, testid);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const countWithClass = (root: FEl, cls: string): number => {
    let n = root.classes.has(cls) ? 1 : 0;
    for (const child of root.children) n += countWithClass(child, cls);
    return n;
  };

  // -- wiring ------------------------------------------------------------------
  const storage = new InMemoryUpgradeStorage();
  const system = new BuggyUpgradeSystem({ storage });
  let wallet = 20000;
  const cues: Record<string, number> = { cashRegister: 0, pneumaticClank: 0, weldingBuzz: 0 };
  const audio: GarageAudioCues = {
    cashRegister: () => (cues.cashRegister += 1),
    pneumaticClank: () => (cues.pneumaticClank += 1),
    weldingBuzz: () => (cues.weldingBuzz += 1),
  };
  const purchases: PurchaseResult[] = [];

  const ui = new GarageTerminalUI({
    upgradeSystem: system,
    getBalance: () => wallet,
    audio,
    onPurchaseSuccess: (result) => {
      wallet = result.newBalance;
      purchases.push(result);
    },
    document: doc as never,
    mount: body as never,
  });

  check('terminal constructs against the fake DOM', ui !== null && registry.has(GARAGE_TERMINAL_ID));
  check('tab strip rendered with 4 categories', registry.has('garage-category-tabs') && findByTestId(findRoot(), 'garage-tab-powertrain') !== undefined);

  ui.show();
  check('show() opens the modal', ui.isOpen() === true && registry.get(GARAGE_TERMINAL_ID)!.attrs.get('data-garage-open') === 'true');
  check('opening fires the pneumatic lift cue', cues.pneumaticClank >= 1);
  check('balance readout paints live wallet', registry.get('garage-balance')!.textContent === '20,000');

  // Keyboard: Tab cycles branch, arrows move the tier cursor.
  check('Tab routes to the terminal', ui.handleKey('Tab', 'down') === true);
  check('Tab advances cargo_bed → powertrain', ui.getActiveCategory() === 'powertrain');
  check('ArrowLeft routes + goes back', ui.handleKey('ArrowLeft', 'down') === true && ui.getActiveCategory() === 'cargo_bed');
  check('KeyW moves the tier cursor up', ui.handleKey('KeyW', 'down') === true && ui.getSelectedTier() === 1);
  check('KeyS moves the tier cursor down', ui.handleKey('KeyS', 'down') === true && ui.getSelectedTier() === 2);
  check('cursor clamps at tier 1', (() => { ui.handleKey('KeyW', 'down'); ui.handleKey('KeyW', 'down'); return ui.getSelectedTier() === 1; })());

  // Delta meters: T2 brushless card shows the canonical green delta line.
  ui.setCategory('powertrain');
  const delta = findByTestId(findRoot(), 'garage-delta-top-speed');
  check(
    'delta meter renders "Top Speed: 18.0 m/s -> 26.0 m/s (+44%)"',
    delta !== undefined &&
      delta.textContent.includes('18.0 m/s') &&
      delta.textContent.includes('26.0 m/s') &&
      delta.textContent.includes('(+44%)'),
    delta?.textContent,
  );
  ui.setCategory('suspension');
  const rows = computeStatDeltaRows(calculateBuggyStats(), calculateBuggyStats({ suspension: 4 }));
  check(
    'feature rows carry NEW markers (RCS Jump Jets + vz law)',
    rows.some((r) => r.label === 'RCS Jump Jets' && r.deltaText === 'NEW' && r.toText.includes('8')),
    JSON.stringify(rows.map((r) => r.label)),
  );

  // Purchase via Enter: wallet commits, callback fires, transaction cues play.
  ui.setCategory('cargo_bed'); // selectedTier snaps to next purchasable = 2
  check('category snap selects next purchasable tier', ui.getSelectedTier() === 2);
  const buyRes = ui.handleKey('Enter', 'down');
  check('Enter purchases the selected tier', buyRes === true && purchases.length === 1 && purchases[0]!.success);
  check('terminal callback debits wallet 20,000 → 16,500', wallet === 16500);
  check('success fires cash-register + welding + settle cues', cues.cashRegister === 1 && cues.weldingBuzz === 1 && cues.pneumaticClank >= 2);
  check('balance readout repaints to 16,500', registry.get('garage-balance')!.textContent === '16,500');
  const feedback = registry.get('garage-feedback')!;
  check('success feedback line names the install', feedback.textContent.includes('Extended Freight Flatbed'));
  const pips = countWithClass(findRoot(), 'is-filled');
  check(`tier pips fill for installed tiers (got ${pips})`, pips >= 1);

  // Insufficient funds through the UI: red feedback, wallet intact.
  wallet = 1000;
  ui.setCategory('powertrain');
  const failRes = ui.buySelected();
  check('UI purchase rejected on insufficient funds', failRes !== null && failRes.success === false && failRes.error === 'insufficient_funds');
  check('red feedback names the catalog cost', feedback.textContent.includes('3500') || feedback.textContent.includes('4500'), feedback.textContent);
  check('rejected purchase leaves wallet intact', wallet === 1000);

  // Gamepad lane: RB next branch, D-Pad ←/→, D-Pad ↑/↓, A buy, B dismiss.
  wallet = 100000;
  ui.setCategory('cargo_bed');
  const pad = (n: number, idx: number): boolean[] => Array.from({ length: 16 }, (_, i) => i === idx);
  const allOff = new Array<boolean>(16).fill(false);
  ui.pumpGamepad(allOff);
  check(
    'RB switches to the next branch',
    ui.pumpGamepad(pad(16, GARAGE_GAMEPAD_BUTTONS.branchNext)) === true &&
      ui.getActiveCategory() === UPGRADE_CATEGORIES[(UPGRADE_CATEGORIES.indexOf('cargo_bed') + 1) % 4],
  );
  ui.pumpGamepad(allOff);
  check('D-Pad Down moves the tier cursor', ui.pumpGamepad(pad(16, GARAGE_GAMEPAD_BUTTONS.tierDown)) === true && ui.getSelectedTier() === 3);
  ui.pumpGamepad(allOff);
  check('D-Pad Up moves the tier cursor back', ui.pumpGamepad(pad(16, GARAGE_GAMEPAD_BUTTONS.tierUp)) === true && ui.getSelectedTier() === 2);
  ui.pumpGamepad(allOff);
  const padBuy = ui.pumpGamepad(pad(16, GARAGE_GAMEPAD_BUTTONS.purchase));
  check('(A) purchases through the gamepad lane', padBuy === true && purchases.length >= 2 && purchases[purchases.length - 1]!.success);
  ui.pumpGamepad(allOff);
  check('(B) dismisses the terminal', ui.pumpGamepad(pad(16, GARAGE_GAMEPAD_BUTTONS.dismiss)) === true && ui.isOpen() === false);
  check('closed terminal parks garage keys / ignores input', ui.handleKey('Tab', 'down') === false && ui.pumpGamepad(allOff) === false);

  // Escape fallback reopens→closes lifecycle.
  ui.show();
  check('Escape closes the modal', ui.handleKey('Escape', 'down') === true && ui.isOpen() === false);
  check('hide() fires a settle pneumatic cue', cues.pneumaticClank >= 3);

  // tierStateFor state machine + dispose idempotence.
  check(
    'tierStateFor covers installed / available / locked (+ MAX_TIER ceiling)',
    tierStateFor({ cargo_bed: 2, powertrain: 1, suspension: 4, mining_suite: 1 }, 'cargo_bed', 1) === 'installed' &&
      tierStateFor({ cargo_bed: 2, powertrain: 1, suspension: 4, mining_suite: 1 }, 'cargo_bed', 3) === 'available' &&
      tierStateFor({ cargo_bed: 2, powertrain: 1, suspension: 4, mining_suite: 1 }, 'cargo_bed', 4) === 'locked' &&
      tierStateFor({ cargo_bed: 2, powertrain: 1, suspension: 4, mining_suite: 1 }, 'suspension', 4) === 'installed',
  );
  ui.dispose();
  ui.dispose();
  check('dispose is idempotent and marks disposed', ui.isDisposed() === true);

  function findRoot(): FEl {
    const el = registry.get(GARAGE_TERMINAL_ID);
    if (el === undefined) throw new Error('terminal root vanished from registry');
    return el;
  }
}

// ---------------------------------------------------------------------------
// Wrap-up
// ---------------------------------------------------------------------------
function finish(sqliteFails: number): void {
  runTerminalGate();

  currentGate = '7';
  check(`assertion count meets the ≥ 65 smoke gate (${passed} run so far)`, passed >= 65);
  try {
    scene.dispose();
    engine.dispose();
    check('scene + NullEngine dispose cleanly', true);
  } catch (err) {
    check(`dispose threw: ${String(err)}`, false);
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`ALL GREEN — ${passed} assertions passed, 0 failed (SQLite failures: ${sqliteFails}).`);
    process.exit(0);
  } else {
    console.log(`${failures.length} FAILURE(S) of ${passed + failures.length} assertions:`);
    for (const f of failures) console.log(`  ✘ ${f}`);
    process.exit(1);
  }
}
