/**
 * Spec 38 Phase 4 probe — Mineral Processing & Compressed Slag Production.
 *
 * Headless NullEngine verification exercising {@link SubterraneanExcavator}
 * and {@link SinteringAutoclaveUnit} (Spec 38 §3 Phase 4):
 *  1. Sintering constants and contracts (SLAG_CONSTRUCTION_BRICK, ratios).
 *  2. Pure calculation helper {@link calculateSinterYield}: 100 kg basalt -> 1 brick + 5 kg trace metals.
 *  3. Autoclave Tier gating: sintering locked at Tier 0 & Tier 1; unlocked at Tier 2 (Z = −45 m).
 *  4. Stockpile affordability validation and failure reason reporting.
 *  5. Acceptance Criteria 3 (Slag Conversion Gate): Sintering 1,000 kg basalt produces
 *     exactly 10x SLAG_CONSTRUCTION_BRICK and 50 kg trace metals.
 *  6. Stockpile management: brick-based sintering, universal sinter(), and stockpile getters.
 *  7. Material consumption for base construction modules (Spec 39 currency).
 *  8. Autoclave unit telemetry: thermal (1,450 K), hydraulic compaction (120 MPa), batch counters.
 *  9. Persistence: LocalStorage envelope and SQLite SubterraneanRepository round-trips.
 * 10. Audio synthesis: LunarAudioSystem.playAutoclaveSinter headless execution.
 */
import {
  SubterraneanExcavator,
  SubterraneanRepository,
  SinteringAutoclaveUnit,
  SLAG_CONSTRUCTION_BRICK,
  BASALT_PER_SLAG_BRICK_KG,
  SLAG_BRICK_MASS_KG,
  TRACE_METALS_PER_BRICK_KG,
  TRACE_IRON_PER_BRICK_KG,
  TRACE_TITANIUM_PER_BRICK_KG,
  SLAG_WASTE_PER_BRICK_KG,
  AUTOCLAVE_REQUIRED_TIER,
  calculateSinterYield,
  InMemoryExcavationStorage,
  type SubterraneanTierState,
  type SqliteLike,
} from '../src/base/SubterraneanExcavator.ts';
import { LunarAudioSystem } from '../src/audio/LunarAudioSystem.ts';
import { DatabaseSync } from 'node:sqlite';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (!cond) {
    failures += 1;
    console.error(`FAIL  ${label}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

async function main(): Promise<void> {
  console.log('--- 1. Testing Spec 38 Phase 4 Constants & Formulas ---');
  check('SLAG_CONSTRUCTION_BRICK identifier', SLAG_CONSTRUCTION_BRICK === 'SLAG_CONSTRUCTION_BRICK');
  check('basalt per brick = 100 kg', BASALT_PER_SLAG_BRICK_KG === 100);
  check('slag brick mass = 25 kg', SLAG_BRICK_MASS_KG === 25);
  check('trace metals per brick = 5 kg', TRACE_METALS_PER_BRICK_KG === 5);
  check('iron + titanium = 5 kg', TRACE_IRON_PER_BRICK_KG + TRACE_TITANIUM_PER_BRICK_KG === 5);
  check('conservation of mass: 25 kg brick + 5 kg metals + 70 kg waste = 100 kg',
    SLAG_BRICK_MASS_KG + TRACE_METALS_PER_BRICK_KG + SLAG_WASTE_PER_BRICK_KG === BASALT_PER_SLAG_BRICK_KG);
  check('autoclave required tier = Tier 2', AUTOCLAVE_REQUIRED_TIER === 2);

  // --- 2. Pure Calculation Helper ------------------------------------------
  console.log('--- 2. Testing calculateSinterYield Pure Calculations ---');
  const zeroYield = calculateSinterYield(0);
  check('0 kg yields 0 bricks', zeroYield.bricks === 0 && zeroYield.traceMetalsKg === 0);

  const subBatch = calculateSinterYield(99);
  check('99 kg yields 0 bricks (floor)', subBatch.bricks === 0 && subBatch.basaltConsumedKg === 0);

  const singleBatch = calculateSinterYield(100);
  check('100 kg yields 1 brick', singleBatch.bricks === 1);
  check('100 kg consumes 100 kg basalt', singleBatch.basaltConsumedKg === 100);
  check('100 kg yields 5 kg trace metals', singleBatch.traceMetalsKg === 5);
  check('100 kg yields 25 kg structural slag mass', singleBatch.slagMassKg === 25);
  check('100 kg yields 70 kg tailings', singleBatch.tailingsMassKg === 70);

  // Acceptance Criterion 3: Slag Conversion Gate
  const gateYield = calculateSinterYield(1_000);
  check('Gate 3: 1,000 kg yields exactly 10 bricks', gateYield.bricks === 10);
  check('Gate 3: 1,000 kg yields exactly 50 kg trace metals', gateYield.traceMetalsKg === 50);
  check('Gate 3: 1,000 kg consumes exactly 1,000 kg basalt', gateYield.basaltConsumedKg === 1_000);
  check('Gate 3: 1,000 kg yields 250 kg slag brick mass', gateYield.slagMassKg === 250);

  const partialBatch = calculateSinterYield(2_550);
  check('2,550 kg yields 25 bricks', partialBatch.bricks === 25);
  check('2,550 kg consumes 2,500 kg basalt', partialBatch.basaltConsumedKg === 2_500);
  check('2,550 kg yields 125 kg trace metals', partialBatch.traceMetalsKg === 125);

  // --- 3. Autoclave Tier Gating --------------------------------------------
  console.log('--- 3. Testing Autoclave Tier Gating (Tier 2 Required) ---');
  const storage = new InMemoryExcavationStorage();
  const excavator = new SubterraneanExcavator({ storage });

  check('fresh excavator is Tier 0', excavator.getCurrentTier().tier === 0);
  check('sintering locked at Tier 0', !excavator.canSinter(1_000).canSinter);
  check('reason is tier_locked at Tier 0', excavator.canSinter(1_000).reason === 'tier_locked');

  // Attempting to sinter at Tier 0 fails cleanly
  excavator.addBasaltRubble(2_500); // exactly enough for Tier 1 unlock
  const failT0 = excavator.sinterBasalt(1_000);
  check('sinterBasalt fails at Tier 0', !failT0.success && failT0.reason === 'tier_locked');
  check('stockpile untouched on Tier 0 failure', excavator.getExcavationState().basaltRubbleKg === 2_500);
  check('slag bricks remain 0 on Tier 0 failure', excavator.getSlagBricks() === 0);

  // Advance to Tier 1
  excavator.unlockNextTier(5_000);
  check('excavator now at Tier 1', excavator.getCurrentTier().tier === 1);
  check('basalt stockpile drawn down to 0 after Tier 1 unlock', excavator.getExcavationState().basaltRubbleKg === 0);

  excavator.addBasaltRubble(8_000); // exactly enough for Tier 2 unlock
  check('sintering still locked at Tier 1', !excavator.canSinter(1_000).canSinter);
  check('reason is tier_locked at Tier 1', excavator.canSinter(1_000).reason === 'tier_locked');

  const failT1 = excavator.sinterBasalt(1_000);
  check('sinterBasalt fails at Tier 1', !failT1.success && failT1.reason === 'tier_locked');

  // Advance to Tier 2 (Heavy Industrial & Power Vault)
  excavator.unlockNextTier(15_000);
  check('excavator now at Tier 2', excavator.getCurrentTier().tier === 2);
  check('sintering unlocked at Tier 2', excavator.getCurrentTier().tier >= AUTOCLAVE_REQUIRED_TIER);

  // --- 4. Stockpile Validation & Failure Modes on Tier 2 --------------------
  console.log('--- 4. Testing Sintering Affordability & Validation on Tier 2 ---');
  // Stockpile was drawn down to 0 on Tier 2 unlock
  check('current basalt stockpile is 0 kg', excavator.getExcavationState().basaltRubbleKg === 0);
  const checkEmpty = excavator.canSinter(100);
  check('canSinter false when stockpile empty', !checkEmpty.canSinter && checkEmpty.reason === 'insufficient_basalt');

  excavator.addBasaltRubble(50);
  const checkInsufficient = excavator.canSinter(100);
  check('canSinter false with 50 kg (< 100 kg requirement)',
    !checkInsufficient.canSinter && checkInsufficient.reason === 'insufficient_basalt');

  const failInsufficient = excavator.sinterBasalt(100);
  check('sinterBasalt fails with insufficient basalt',
    !failInsufficient.success && failInsufficient.reason === 'insufficient_basalt');

  const failInvalid = excavator.sinterBasalt(-100);
  check('sinterBasalt fails with negative amount', !failInvalid.success && failInvalid.reason === 'invalid_amount');

  // --- 5. Acceptance Criteria 3: Slag Conversion Gate ----------------------
  console.log('--- 5. Testing Slag Conversion Gate (1,000 kg Basalt -> 10 Bricks + 50 kg Metals) ---');
  // Top up to 1,000 kg basalt (already has 50 kg)
  excavator.addBasaltRubble(950);
  check('basalt stockpile is exactly 1,000 kg', excavator.getExcavationState().basaltRubbleKg === 1_000);

  const check1000 = excavator.canSinter(1_000);
  check('canSinter true for 1,000 kg', check1000.canSinter);
  check('maxBricks is 10 for 1,000 kg', check1000.maxBricks === 10);
  check('maxBasaltKg is 1,000 kg', check1000.maxBasaltKg === 1_000);

  // Audio telemetry spy
  let audioFired = false;
  const audioSpy = {
    playAutoclaveSinter: () => { audioFired = true; },
  };
  excavator.attachAudioSystem(audioSpy);

  const result1000 = excavator.sinterBasalt(1_000);
  check('sinterBasalt(1000) succeeds', result1000.success);
  check('produced exactly 10 SLAG_CONSTRUCTION_BRICK', result1000.yield.bricks === 10);
  check('produced exactly 50 kg trace metals', result1000.yield.traceMetalsKg === 50);
  check('consumed exactly 1,000 kg basalt', result1000.yield.basaltConsumedKg === 1_000);
  check('basalt stockpile drawn down to 0 kg', result1000.state.basaltRubbleKg === 0);
  check('slagBricks in state is 10', result1000.state.slagBricks === 10);
  check('traceMetalsKg in state is 50', result1000.state.traceMetalsKg === 50);
  check('getSlagBricks() returns 10', excavator.getSlagBricks() === 10);
  check('getTraceMetalsKg() returns 50', excavator.getTraceMetalsKg() === 50);
  check('autoclave sintering audio triggered', audioFired);

  // --- 6. Brick-Based Sintering & Universal sinter() -----------------------
  console.log('--- 6. Testing Brick-Based and Universal Sintering ---');
  excavator.addBasaltRubble(550);
  check('basalt stockpile is 550 kg', excavator.getExcavationState().basaltRubbleKg === 550);

  // Sinter exactly 5 bricks
  const brickResult = excavator.sinterSlagBricks(5);
  check('sinterSlagBricks(5) succeeds', brickResult.success);
  check('yielded 5 bricks', brickResult.yield.bricks === 5);
  check('yielded 25 kg trace metals', brickResult.yield.traceMetalsKg === 25);
  check('consumed 500 kg basalt', brickResult.yield.basaltConsumedKg === 500);
  check('50 kg basalt remaining in stockpile', excavator.getExcavationState().basaltRubbleKg === 50);
  check('total slag bricks is now 15', excavator.getSlagBricks() === 15);
  check('total trace metals is now 75 kg', excavator.getTraceMetalsKg() === 75);

  // Universal sinter API
  const univBricksFail = excavator.sinter(1, 'bricks'); // needs 100 kg, only 50 kg available
  check('sinter(1, "bricks") fails on insufficient basalt', !univBricksFail.success);

  excavator.addBasaltRubble(150); // now 200 kg
  const univSuccess = excavator.sinter(200, 'basalt');
  check('sinter(200, "basalt") succeeds', univSuccess.success && univSuccess.yield.bricks === 2);
  check('total slag bricks is now 17', excavator.getSlagBricks() === 17);
  check('total trace metals is now 85 kg', excavator.getTraceMetalsKg() === 85);

  // --- 7. Material Consumption (Spec 39 Currency) --------------------------
  console.log('--- 7. Testing Material Consumption (Spec 39 Base Modules) ---');
  check('consumeSlagBricks(7) succeeds', excavator.consumeSlagBricks(7));
  check('remaining slag bricks = 10', excavator.getSlagBricks() === 10);
  check('consumeSlagBricks(20) fails (insufficient)', !excavator.consumeSlagBricks(20));
  check('slag bricks unchanged after failed consumption', excavator.getSlagBricks() === 10);

  check('consumeTraceMetals(35) succeeds', excavator.consumeTraceMetals(35));
  check('remaining trace metals = 50 kg', excavator.getTraceMetalsKg() === 50);
  check('consumeTraceMetals(100) fails (insufficient)', !excavator.consumeTraceMetals(100));
  check('trace metals unchanged after failed consumption', excavator.getTraceMetalsKg() === 50);

  // Manual adders
  excavator.addSlagBricks(5);
  check('addSlagBricks(5) -> 15 bricks', excavator.getSlagBricks() === 15);
  excavator.addTraceMetals(10);
  check('addTraceMetals(10) -> 60 kg metals', excavator.getTraceMetalsKg() === 60);

  // --- 8. Autoclave Unit & Telemetry ---------------------------------------
  console.log('--- 8. Testing Autoclave Unit & Telemetry ---');
  const autoclave = excavator.getAutoclave();
  check('getAutoclave returns SinteringAutoclaveUnit', autoclave instanceof SinteringAutoclaveUnit);
  check('autoclave required tier is 2', autoclave.requiredTier === 2);

  const telemT2 = autoclave.getTelemetry(2);
  check('telemetry status is idle at Tier 2', telemT2.status === 'idle');
  check('telemetry temperature is 1,450 K', telemT2.temperatureK === 1450);
  check('telemetry compaction pressure is 120 MPa', telemT2.compactionPressureMpa === 120);
  check('telemetry tracked batches processed', telemT2.totalBatchesProcessed >= 3);
  check('telemetry tracked total bricks manufactured', telemT2.totalBricksManufactured >= 17);

  const telemT0 = autoclave.getTelemetry(0);
  check('telemetry status is locked at Tier 0', telemT0.status === 'locked');
  check('telemetry pressure is 0 at Tier 0', telemT0.compactionPressureMpa === 0);

  // --- 9. Persistence & Round-Trips ----------------------------------------
  console.log('--- 9. Testing Persistence (LocalStorage & SQLite) ---');
  // LocalStorage save
  excavator.save();
  const restoredExcavator = new SubterraneanExcavator({ storage });
  check('load() succeeds', restoredExcavator.load());
  check('restored slagBricks === 15', restoredExcavator.getSlagBricks() === 15);
  check('restored traceMetalsKg === 60', restoredExcavator.getTraceMetalsKg() === 60);
  check('restored unlockedTier === 2', restoredExcavator.getCurrentTier().tier === 2);

  // SQLite repository
  const db = new DatabaseSync(':memory:');
  const sqliteLike: SqliteLike = {
    exec: async (sql) => { db.exec(sql); },
    run: async (sql, params = []) => {
      const stmt = db.prepare(sql);
      const res = stmt.run(...(params as never[])) as { lastInsertRowid: number | bigint; changes: number | bigint };
      return { lastID: Number(res.lastInsertRowid), changes: Number(res.changes) };
    },
    get: async <T>(sql: string, params: unknown[] = []) => {
      const stmt = db.prepare(sql);
      const row = stmt.get(...(params as never[]));
      return row === undefined ? undefined : (row as T);
    },
    all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
  };

  const repo = new SubterraneanRepository(sqliteLike);
  await repo.migrate();
  await repo.migrate(); // Idempotency check

  const pState: SubterraneanTierState = {
    unlockedTier: 2,
    excavationProgress: 0,
    basaltRubbleKg: 350,
    totalMinedKg: 12_000,
    slagBricks: 24,
    traceMetalsKg: 120,
  };

  const saved = await repo.saveState('player_p4', pState);
  check('repo round-trip slag_bricks', saved.slagBricks === 24);
  check('repo round-trip trace_metals_kg', saved.traceMetalsKg === 120);

  const loaded = await repo.getState('player_p4');
  check('repo getState returns valid state', loaded !== undefined);
  check('repo loaded slagBricks === 24', loaded?.slagBricks === 24);
  check('repo loaded traceMetalsKg === 120', loaded?.traceMetalsKg === 120);
  db.close();

  // --- 10. Headless Audio Synthesis ----------------------------------------
  console.log('--- 10. Testing Headless Audio Synthesis ---');
  const audioSystem = new LunarAudioSystem();
  let audioException = false;
  try {
    audioSystem.playAutoclaveSinter(1.2);
  } catch {
    audioException = true;
  }
  check('LunarAudioSystem.playAutoclaveSinter runs headlessly without exception', !audioException);

  console.log('===========================================================');
  if (failures === 0) {
    console.log('ALL SPEC 38 PHASE 4 CHECKS PASSED CLEANLY');
  } else {
    console.error(`${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

void main();
