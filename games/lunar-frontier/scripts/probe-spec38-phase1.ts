/**
 * Spec 38 Phase 1 probe — exercises the SubterraneanExcavator state machine
 * end to end in a headless (no-browser) run: tier specs vs §2.1 cost table,
 * rubble accrual, progress %, unlock rejections, full level-up chain,
 * localStorage envelope round-trip, and the SQLite repository against a fake
 * in-memory SqliteLike executor.
 */
import {
  SubterraneanExcavator,
  SubterraneanRepository,
  DEPTH_TIERS,
  SURFACE_TIER,
  MAX_DEPTH_TIER,
  SUBTERRANEAN_STORAGE_KEY,
  InMemoryExcavationStorage,
  defaultTierState,
  serializeTierState,
  deserializeTierState,
  validateTierShape,
  computeExcavationProgress,
  type SubterraneanTierState,
  type SqliteLike,
} from '../src/base/SubterraneanExcavator.ts';
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
  // --- §2.1 cost table ----------------------------------------------------
  check('tier1 = 2500kg/5000cr @ -15m',
    DEPTH_TIERS[1]!.basaltKg === 2_500 && DEPTH_TIERS[1]!.creditCost === 5_000 && DEPTH_TIERS[1]!.depthZ === -15);
  check('tier2 = 8000kg/15000cr @ -45m',
    DEPTH_TIERS[2]!.basaltKg === 8_000 && DEPTH_TIERS[2]!.creditCost === 15_000 && DEPTH_TIERS[2]!.depthZ === -45);
  check('tier3 = 25000kg/35000cr @ -95m',
    DEPTH_TIERS[3]!.basaltKg === 25_000 && DEPTH_TIERS[3]!.creditCost === 35_000 && DEPTH_TIERS[3]!.depthZ === -95);
  check('MAX_DEPTH_TIER === 3 and SURFACE_TIER === 0', MAX_DEPTH_TIER === 3 && SURFACE_TIER === 0);

  // --- rubble + progress ---------------------------------------------------
  const storage = new InMemoryExcavationStorage();
  const exc = new SubterraneanExcavator({ storage });
  check('fresh state is surface tier, 0%', exc.getExcavationState().unlockedTier === 0);
  check('current tier name', exc.getCurrentTier().name === 'Surface Base Datum');

  check('addBasaltRubble(1250) -> 1250', exc.addBasaltRubble(1250) === 1250);
  check('progress = 50% of tier1', exc.getExcavationState().excavationProgress === 50);
  check('negative add ignored', exc.addBasaltRubble(-100) === 1250);
  check('NaN add ignored', exc.addBasaltRubble(Number.NaN) === 1250);

  // --- unlock rejections ---------------------------------------------------
  const noFunds = exc.unlockNextTier(1_000); // needs 2500kg + 5000cr
  check('rejects on missing basalt first', !noFunds.unlocked && noFunds.reason === 'insufficient_basalt');
  exc.addBasaltRubble(1_300); // 2550 kg total
  const shortCr = exc.unlockNextTier(4_999);
  check('rejects on missing credits', !shortCr.unlocked && shortCr.reason === 'insufficient_credits');
  check('reject preserves state', shortCr.state.unlockedTier === 0);

  // --- full level-up chain -------------------------------------------------
  const r1 = exc.unlockNextTier(5_000); // exactly affordable
  check('tier 1 unlocks at exact cost', r1.unlocked && r1.state.unlockedTier === 1);
  check('basalt consumed on unlock', r1.state.basaltRubbleKg === 50);
  check('credits returned', r1.remainingCredits === 0);
  check('current tier is tier 1 now', exc.getCurrentTier().tier === 1);
  check('autosave wrote envelope', storage.getItem(SUBTERRANEAN_STORAGE_KEY) !== null);

  exc.addBasaltRubble(8_000);
  const r2 = exc.unlockNextTier(15_000);
  check('tier 2 unlocks', r2.unlocked && r2.state.unlockedTier === 2);
  exc.addBasaltRubble(25_000);
  const r3 = exc.unlockNextTier(35_000);
  check('tier 3 unlocks', r3.unlocked && r3.state.unlockedTier === 3);
  check('max tier progress = 100%', r3.state.excavationProgress === 100);
  const rMax = exc.unlockNextTier(1_000_000);
  check('max tier refuses further unlock', !rMax.unlocked && rMax.reason === 'max_tier');
  const totalExpected = 1_250 + 1_300 + 8_000 + 25_000;
  check('total mined tonnage tracked', rMax.state.totalMinedKg === totalExpected);

  // --- envelope round-trip -------------------------------------------------
  const restored = new SubterraneanExcavator({ storage, autosave: false });
  check('load() restores save', restored.load() === true);
  check('restored tier = 3', restored.getExcavationState().unlockedTier === 3);
  check('envelope tamper -> version reject', deserializeTierState('{"version":99,"state":{}}') === null);
  check('malformed json -> null', deserializeTierState('{oops') === null);
  const goodEnvelope = JSON.parse(serializeTierState(defaultTierState()));
  goodEnvelope.state.unlockedTier = 99;
  check('shape check rejects tier 99', validateTierShape(goodEnvelope.state) === false);

  // reset wipes storage
  restored.reset();
  check('reset clears storage', storage.getItem(SUBTERRANEAN_STORAGE_KEY) === null);

  // --- SQLite repository over node:sqlite ---------------------------------
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
  await repo.migrate(); // idempotent
  check('migrate is idempotent', true);

  const s2: SubterraneanTierState = {
    unlockedTier: 2, excavationProgress: 0, basaltRubbleKg: 4_000.5, totalMinedKg: 33_000,
  };
  const saved = await repo.saveState('p1', s2);
  check('repo round-trip tier', saved.unlockedTier === 2);
  check('repo round-trip rubble (REAL)', saved.basaltRubbleKg === 4_000.5);
  check('repo progress recomputed', saved.excavationProgress === computeExcavationProgress(s2));

  const savedAgain = await repo.saveState('p1', { ...s2, unlockedTier: 3, basaltRubbleKg: 0 });
  check('upsert overwrote row', savedAgain.unlockedTier === 3 && savedAgain.basaltRubbleKg === 0);
  check('missing player -> undefined', (await repo.getState('ghost')) === undefined);
  check('deleteState removes row', (await repo.deleteState('p1')) === 1);
  db.close();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('PROBE CRASHED:', err);
  process.exitCode = 1;
});
