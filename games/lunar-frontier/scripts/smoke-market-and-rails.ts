/**
 * Phase 8a smoke test — MarketEngine + LunarServer TRADE / LAY_RAIL handlers.
 *
 * Runs headless under tsx (`npx tsx scripts/smoke-market-and-rails.ts`) and
 * exits 0 only when every check passes. Three layers are exercised:
 *
 *   A. MarketEngine pure maths      — curve shape, spread, slippage, bands
 *   B. MarketEngine + real SQLite   — atomic fills, overdraft, double-sell races
 *   C. LunarServer over WebSocket   — TRADE / LAY_RAIL wire protocol + broadcasts
 *
 * Layer A deliberately cross-checks the engine's closed-form fill against a
 * naive per-unit walk of the curve: if the two ever disagree, the pricing fast
 * path is wrong and the whole economy is untrustworthy.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import WebSocket from 'ws';

import DatabaseManager, { STATION_ID, TradeError } from '../src/database';
import {
  MarketEngine,
  BASE_PRICES,
  BASELINE_RESERVES,
  COMMODITIES,
  MAX_TRADE_AMOUNT,
  PRICE_CEILING_MULTIPLIER,
  PRICE_FLOOR_MULTIPLIER,
  type Commodity,
} from '../src/economy/MarketEngine';
import LunarServer, {
  MAX_RAIL_SEGMENT_M,
  MIN_RAIL_SEGMENT_M,
  PLAYER_RAIL_GAUGE_M,
} from '../src/server/LunarServer';

const DB_PATH = './.smoke-market-rails.db';
const STAGE = { passed: 0 };

function ok(label: string, detail = ''): void {
  STAGE.passed++;
  console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/**
 * Reference implementation: walk the bonding curve one unit at a time and sum
 * the clamped unit prices. Independent of MarketEngine's internals on purpose.
 *
 * `reserveStart` is the reserve the FIRST traded unit sees. MarketEngine uses
 * the taker convention — a buy's first unit sees (R - 1) — so callers pass
 * BASELINE_RESERVES[c] ∓ 1 to match.
 */
function walkCurve(
  reserveStart: number,
  amount: number,
  isBuy: boolean,
  base: number,
  baseline: number,
  elasticity = 0.5,
): number {
  let total = 0;
  for (let n = 0; n < amount; n++) {
    const reserve = isBuy ? reserveStart - n : reserveStart + n;
    const multiplier = 1 + elasticity * ((baseline - reserve) / baseline);
    const clamped = Math.min(PRICE_CEILING_MULTIPLIER, Math.max(PRICE_FLOOR_MULTIPLIER, multiplier));
    total += base * clamped;
  }
  return total;
}

function approx(actual: number, expected: number, epsilon = 0.02, msg = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${msg || 'approx'}: expected ~${expected}, got ${actual}`,
  );
}

// ---------------------------------------------------------------------------
// Frame recorder (same shape as smoke-lunarserver.ts)
// ---------------------------------------------------------------------------

interface Recorder {
  inbox: any[];
  waitFor: (predicate: (m: any) => boolean, label: string, timeoutMs?: number) => Promise<any>;
}

function record(ws: WebSocket): Recorder {
  const inbox: any[] = [];
  let waiter: (() => void) | null = null;
  ws.on('message', (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString());
      msg.__seen = false;
      inbox.push(msg);
      if (waiter !== null) waiter();
    } catch {
      /* ignore non-JSON frames */
    }
  });
  const waitFor = async (predicate: (m: any) => boolean, label: string, timeoutMs = 5000): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = inbox.find((m) => !m.__seen && predicate(m));
      if (hit !== undefined) {
        hit.__seen = true;
        return hit;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out waiting for: ${label} — inbox: ` +
            JSON.stringify(inbox.map((m) => ({ type: m.type, code: m.code, message: m.message }))),
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiter = null;
          resolve();
        }, remaining);
        waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };
  return { inbox, waitFor };
}

// ===========================================================================
// LAYER A — pure pricing maths
// ===========================================================================

function layerA(): void {
  section('A. MarketEngine pricing maths (pure, no DB)');
  const market = new MarketEngine();

  // A1 — every commodity opens exactly at its spec base price.
  for (const commodity of COMMODITIES) {
    assert.strictEqual(
      Math.round(market.spotPrice(commodity) * 100),
      Math.round(BASE_PRICES[commodity] * 100),
      `${commodity} should open at base price`,
    );
  }
  ok('all 6 commodities open at spec base price', COMMODITIES.map((c) => `${c}=${BASE_PRICES[c]}`).join(' '));

  // A2 — the six spec commodities exist, with the six spec base prices.
  assert.deepStrictEqual([...COMMODITIES].sort(), [
    'BASALT', 'HELIUM3', 'ILMENITE', 'REGOLITH', 'TITANIUM', 'WATER_ICE',
  ]);
  assert.strictEqual(BASE_PRICES.REGOLITH, 5);
  assert.strictEqual(BASE_PRICES.BASALT, 15);
  assert.strictEqual(BASE_PRICES.TITANIUM, 45);
  assert.strictEqual(BASE_PRICES.ILMENITE, 75);
  assert.strictEqual(BASE_PRICES.WATER_ICE, 120);
  assert.strictEqual(BASE_PRICES.HELIUM3, 500);
  ok('commodity catalogue matches spec 13 §4 exactly');

  // A3 — buy quote is strictly more expensive than the sell quote (spread).
  //      Checked on BOTH the unit price and the total: rounding unit prices too
  //      coarsely makes the cheapest commodity look spread-free, which an
  //      earlier revision of this test caught.
  for (const commodity of COMMODITIES) {
    const buy = market.quoteOrder(commodity, 250, true);
    const sell = market.quoteOrder(commodity, 250, false);
    assert.ok(
      buy.averagePrice > sell.averagePrice,
      `${commodity}: buy avg ${buy.averagePrice} must strictly exceed sell avg ${sell.averagePrice}`,
    );
    assert.ok(
      buy.totalCredits > sell.totalCredits,
      `${commodity}: buy total ${buy.totalCredits} must exceed sell total ${sell.totalCredits}`,
    );
    // The marginal quote (amount=1) must show a spread too, or the market
    // terminal renders a bid equal to its ask.
    const buyMarginal = market.getPrice(commodity, true, 1);
    const sellMarginal = market.getPrice(commodity, false, 1);
    assert.ok(
      buyMarginal > sellMarginal,
      `${commodity}: marginal buy ${buyMarginal} must exceed marginal sell ${sellMarginal}`,
    );
  }
  ok('buy > sell spread holds strictly for all 6 (250 kg totals AND marginal unit prices)');

  // A4 — reserve impact: buying drains the pool and raises spot; selling
  //      supplies it and lowers spot. Verified against the spec formula.
  const he3 = 'HELIUM3' as Commodity;
  const spotBefore = market.spotPrice(he3);
  const buyQuote = market.quoteOrder(he3, 100, true);
  assert.strictEqual(buyQuote.reserveBefore, BASELINE_RESERVES.HELIUM3);
  assert.strictEqual(buyQuote.reserveAfter, BASELINE_RESERVES.HELIUM3 - 100);
  const spotAfterBuy = market.spotPrice(he3, BASELINE_RESERVES.HELIUM3 - 100);
  assert.ok(spotAfterBuy > spotBefore, 'draining the pool must raise spot price');

  const sellQuote = market.quoteOrder(he3, 100, false);
  assert.strictEqual(sellQuote.reserveAfter, BASELINE_RESERVES.HELIUM3 + 100);
  const spotAfterSell = market.spotPrice(he3, BASELINE_RESERVES.HELIUM3 + 100);
  assert.ok(spotAfterSell < spotBefore, 'flooding the pool must soften spot price');
  ok(
    'reserve impact: buy drains+raises, sell supplies+softens',
    `spot ${spotBefore} -> ${spotAfterBuy} (drain) / ${spotAfterSell} (flood)`,
  );

  // A5 — spec formula P(c) = P0 * max(0.2, 1 + 0.5*(Rbase - Rcur)/Rbase),
  //      checked at an arbitrary reserve deep inside the pool.
  const probeReserve = BASELINE_RESERVES.ILMENITE * 0.4;
  const expectedMultiplier = 1 + 0.5 * ((BASELINE_RESERVES.ILMENITE - probeReserve) / BASELINE_RESERVES.ILMENITE);
  approx(
    market.spotPrice('ILMENITE', probeReserve),
    BASE_PRICES.ILMENITE * expectedMultiplier,
    1e-9,
    'spec formula at 40% reserve',
  );
  ok('spot price reproduces the spec formula at 40% reserve', `mult=${expectedMultiplier.toFixed(4)}`);

  // A6 — price band: floor 20%, ceiling 500% of base, never breached.
  //      With elasticity 0.5 the multiplier hits 5.0 only when the reserve
  //      reaches -7x baseline (1 + 0.5*(R0-R)/R0 = 5  =>  R = -7*R0), so the
  //      ceiling probes sit past that; the floor binds far earlier at 2.6x.
  const he3CeilingReserve = -7 * BASELINE_RESERVES.HELIUM3;
  approx(
    market.spotPrice('HELIUM3', he3CeilingReserve - 1000),
    BASE_PRICES.HELIUM3 * PRICE_CEILING_MULTIPLIER,
    1e-9,
    'ceiling (drained past the clamp point)',
  );
  // Exactly at the clamp point the raw formula equals the ceiling (no clamp).
  approx(market.spotPrice('HELIUM3', he3CeilingReserve), BASE_PRICES.HELIUM3 * PRICE_CEILING_MULTIPLIER, 1e-9, 'ceiling boundary');
  // A drain that is NOT past the clamp point must stay on the raw curve.
  const partialDrain = market.spotPrice('REGOLITH', -50_000);
  approx(partialDrain, BASE_PRICES.REGOLITH * 1.75, 1e-9, 'raw curve at -50k (below clamp)');
  const flooded = market.spotPrice('REGOLITH', 1_000_000);
  approx(flooded, BASE_PRICES.REGOLITH * PRICE_FLOOR_MULTIPLIER, 1e-9, 'floor (flooded 10x)');
  // The floor binds at 2.6x baseline: 1 + 0.5*(1-2.6) = 0.2 exactly.
  approx(
    market.spotPrice('BASALT', BASELINE_RESERVES.BASALT * 3),
    BASE_PRICES.BASALT * PRICE_FLOOR_MULTIPLIER,
    1e-9,
    'floor boundary (3x flooded)',
  );
  // No reserve value, sane or absurd, escapes the band.
  for (const probe of [-1e12, -1e9, -1e6, 0, 1e6, 1e9, 1e12]) {
    const p = market.spotPrice('TITANIUM', probe);
    assert.ok(
      p >= BASE_PRICES.TITANIUM * PRICE_FLOOR_MULTIPLIER - 1e-9 &&
        p <= BASE_PRICES.TITANIUM * PRICE_CEILING_MULTIPLIER + 1e-9,
      `TITANIUM at reserve ${probe} escaped the band: ${p}`,
    );
  }
  ok(
    'price band enforced (floor 20%, ceiling 500%, raw curve in between)',
    `TITANIUM stays in [${BASE_PRICES.TITANIUM * PRICE_FLOOR_MULTIPLIER}, ${BASE_PRICES.TITANIUM * PRICE_CEILING_MULTIPLIER}]`,
  );

  // A7 — CRITICAL: the closed-form fill equals a naive per-unit walk of the
  //      curve, including orders that run INTO the clamped band:
  //        HELIUM3 buy 10k  — reserve walks 999 -> -9001, ceiling (R = -7000)
  //                           starts binding at unit ~8000
  //        HELIUM3 sell 1.8k — reserve walks 1001 -> 2801, floor (R = 2600)
  //                           starts binding at unit ~1600
  const probes: Array<[Commodity, number, boolean]> = [
    ['TITANIUM', 1, true],
    ['TITANIUM', 37, true],
    ['WATER_ICE', 500, false],
    ['BASALT', 4000, true],
    ['REGOLITH', 25_000, true],   // deep pool, still inside the band
    ['HELIUM3', 900, false],      // inside the band
    ['HELIUM3', 10_000, true],    // clamps at the CEILING mid-order
    ['HELIUM3', 1_800, false],    // clamps at the FLOOR mid-order
  ];
  for (const [commodity, amount, isBuy] of probes) {
    const quote = market.quoteOrder(commodity, amount, isBuy);
    // Taker convention: the first traded unit sees the pool move by 1 first.
    const firstReserve = isBuy
      ? BASELINE_RESERVES[commodity] - 1
      : BASELINE_RESERVES[commodity] + 1;
    const manual = walkCurve(
      firstReserve,
      amount,
      isBuy,
      BASE_PRICES[commodity],
      BASELINE_RESERVES[commodity],
    );
    approx(quote.totalCredits, Math.round(manual * 100) / 100, 0.05, `${commodity} ${amount} ${isBuy ? 'buy' : 'sell'}`);
  }
  ok(`closed-form fill matches per-unit curve walk on ${probes.length} probes (incl. clamped band)`);

  // A7b — book/tape consistency: the snapshot ask is the per-kg price a 1 kg
  //       buy pays (the fill total is that price rounded to cents, so the
  //       invariant is "within one cent", not exact), and the snapshot bid is
  //       what a 1 kg sell receives. If these drift, the terminal quotes a
  //       book the fills disagree with.
  for (const commodity of COMMODITIES) {
    const fresh = new MarketEngine();
    const snap = fresh.getMarketSnapshot();
    approx(snap.prices[commodity], fresh.quoteOrder(commodity, 1, true).totalCredits, 0.01, `${commodity} ask == 1kg buy cost`);
    approx(snap.sellPrices[commodity], fresh.quoteOrder(commodity, 1, false).totalCredits, 0.01, `${commodity} bid == 1kg sell payout`);
    assert.ok(snap.prices[commodity] > snap.sellPrices[commodity], `${commodity} snapshot ask must exceed bid`);
    fresh.dispose();
  }
  ok('snapshot book matches 1 kg fills within a cent (ask > bid) for all 6');

  // A8 — slippage: a larger order pays more per unit than a marginal one.
  const small = market.quoteOrder('TITANIUM', 1, true);
  const large = market.quoteOrder('TITANIUM', 2000, true);
  assert.ok(large.averagePrice > small.averagePrice, 'bigger orders must pay more per kg');
  assert.ok(large.priceImpact > small.priceImpact, 'bigger orders must slip more');
  ok('slippage scales with order size', `avg ${small.averagePrice} -> ${large.averagePrice}`);

  // A9 — quoteOrder input hygiene.
  assert.throws(() => market.quoteOrder('TITANIUM', 0, true), (e: unknown) => (e as TradeError).code === 'bad_amount');
  assert.throws(() => market.quoteOrder('TITANIUM', -5, true), (e: unknown) => (e as TradeError).code === 'bad_amount');
  assert.throws(() => market.quoteOrder('TITANIUM', Number.NaN, true), (e: unknown) => (e as TradeError).code === 'bad_amount');
  ok('quoteOrder rejects zero, negative, and NaN amounts');

  // A9b — fractional kilogram amounts. The wire accepts any positive number and
  //       the curve is evaluated continuously, so sub-kg orders must price
  //       monotonically and keep a spread — never collapse to zero cost or
  //       invert. Guards against a future integer-assuming refactor.
  for (const commodity of ['REGOLITH', 'TITANIUM', 'HELIUM3'] as Commodity[]) {
    let prevTotal = 0;
    for (let amount = 0.25; amount < 8000; amount *= 1.7) {
      const quote = market.quoteOrder(commodity, amount, true);
      assert.ok(quote.totalCredits > 0, `${commodity} ${amount} kg must cost something`);
      assert.ok(
        quote.totalCredits >= prevTotal - 1e-9,
        `${commodity}: ${amount} kg must not cost less than the previous smaller order`,
      );
      prevTotal = quote.totalCredits;
    }
    const half = market.quoteOrder(commodity, 0.5, true);
    const halfSell = market.quoteOrder(commodity, 0.5, false);
    assert.ok(half.averagePrice > halfSell.averagePrice, `${commodity} 0.5 kg must still cross a spread`);
  }
  ok('fractional kg orders price monotonically and keep a spread');

  // A10 — commodity aliasing (world-generator spellings map to market ids).
  assert.strictEqual(MarketEngine.normalizeCommodity('helium3'), 'HELIUM3');
  assert.strictEqual(MarketEngine.normalizeCommodity('  HELIUM_3  '), 'HELIUM3');
  assert.strictEqual(MarketEngine.normalizeCommodity('water_ice'), 'WATER_ICE');
  assert.strictEqual(MarketEngine.normalizeCommodity('banana'), undefined);
  ok('normalizeCommodity is case/space tolerant and rejects non-commodities');

  // A11 — snapshot shape.
  const snapshot = market.getMarketSnapshot();
  assert.strictEqual(typeof snapshot.timestamp, 'number');
  for (const commodity of COMMODITIES) {
    assert.ok(commodity in snapshot.prices, 'prices missing ' + commodity);
    assert.ok(commodity in snapshot.sellPrices, 'sellPrices missing ' + commodity);
    assert.ok(commodity in snapshot.reserves, 'reserves missing ' + commodity);
    assert.ok(commodity in snapshot.basePrices, 'basePrices missing ' + commodity);
    // The station's ask must sit above its bid in the snapshot too.
    assert.ok(snapshot.prices[commodity] >= snapshot.sellPrices[commodity]);
  }
  ok('getMarketSnapshot carries prices/sellPrices/reserves/basePrices for all 6');

  market.dispose();
  assert.strictEqual(market.isInitialized(), false);
  assert.throws(() => market.getMarketSnapshot(), /disposed/);
  ok('dispose() is final — engine refuses further work');
}

// ===========================================================================
// LAYER B — MarketEngine against a real SQLite database
// ===========================================================================

async function layerB(): Promise<void> {
  section('B. Trade execution against real SQLite (ACID)');
  const db = new DatabaseManager(DB_PATH);
  await db.initialize();
  const market = new MarketEngine();
  await market.initialize(db);

  const trader = await db.createPlayer({
    id: 'trader-1',
    username: 'vaultbreaker',
    faction: 'esa',
    credits: 10_000,
    role: 'quartermaster',
  });

  // B1 — seeding is idempotent and starts pools at baseline.
  await market.initialize(db);
  const pools = await db.listMarketReserves();
  assert.strictEqual(pools.length, COMMODITIES.length);
  for (const pool of pools) {
    assert.strictEqual(pool.reserve, pool.baseline_reserve, `${pool.commodity} should start at baseline`);
  }
  ok('liquidity pools seeded once, idempotent across re-init', `${pools.length} commodities`);

  // B2 — a BUY: credits fall, inventory rises, reserve drains, ledger row lands.
  const buyAmount = 40;
  const quoteBefore = market.quoteOrder('TITANIUM', buyAmount, true);
  const buy = await market.executeTrade(trader.id, 'TITANIUM', buyAmount, true, db);
  assert.strictEqual(buy.amount, buyAmount);
  assert.strictEqual(buy.commodity, 'TITANIUM');
  assert.strictEqual(buy.isBuy, true);
  approx(buy.totalCredits, quoteBefore.totalCredits, 0.01, 'fill honoured its quote');
  assert.strictEqual(
    Math.round(trader.credits - buy.totalCredits),
    Math.round(buy.newBalance),
    'receipt balance must be credits minus cost',
  );
  const afterBuy = await db.getPlayer(trader.id);
  assert.strictEqual(Math.round(afterBuy!.credits), Math.round(buy.newBalance), 'DB balance must match receipt');
  const invAfterBuy = await db.getInventory(trader.id);
  assert.strictEqual(invAfterBuy.TITANIUM, buyAmount, 'bought units must appear in inventory');
  assert.strictEqual(buy.reserveAfter, BASELINE_RESERVES.TITANIUM - buyAmount);
  const dbPool = await db.getMarketReserve('TITANIUM');
  assert.strictEqual(dbPool!.reserve, buy.reserveAfter, 'DB pool must match the fill');
  const ledger = await db.listTransactionsForPlayer(trader.id);
  assert.strictEqual(ledger.length, 1);
  assert.strictEqual(ledger[0].item_type, 'TITANIUM');
  assert.strictEqual(ledger[0].buyer_id, trader.id);
  assert.strictEqual(ledger[0].seller_id, STATION_ID, 'the station is the virtual seller');
  assert.strictEqual(ledger[0].quantity, buyAmount);
  ok('BUY moves credits down, inventory up, reserve down, and logs the fill',
     `${buyAmount} TITANIUM for ${buy.totalCredits} cr`);

  // B3 — buying raises the next buyer's price (reserve impact, end to end).
  const priceAfterDrain = market.quoteOrder('TITANIUM', 1, true).averagePrice;
  assert.ok(priceAfterDrain > BASE_PRICES.TITANIUM, 'spot must exceed base after a drain');
  ok('reserve impact survives the DB round-trip', `TITANIUM 1kg now ${priceAfterDrain}`);

  // B4 — a SELL: credits rise, inventory falls, reserve refills.
  const sell = await market.executeTrade(trader.id, 'TITANIUM', 25, false, db);
  assert.strictEqual(sell.isBuy, false);
  assert.ok(sell.totalCredits > 0);
  const invAfterSell = await db.getInventory(trader.id);
  assert.strictEqual(invAfterSell.TITANIUM, buyAmount - 25, 'selling must reduce inventory');
  const afterSell = await db.getPlayer(trader.id);
  assert.ok(afterSell!.credits > buy.newBalance, 'selling must credit the player');
  ok('SELL returns credits and reduces inventory', `+${sell.totalCredits} cr, inventory ${invAfterSell.TITANIUM}`);

  // B5 — overdraft fails cleanly: no partial debit, no inventory mint.
  const beforeOverdraft = await db.getPlayer(trader.id);
  const invBeforeOverdraft = await db.getInventory(trader.id);
  await assert.rejects(
    () => market.executeTrade(trader.id, 'HELIUM3', 900, true, db),
    (err: unknown) => (err as TradeError).code === 'insufficient_credits',
    'a 450k credit order on a 10k account must be refused',
  );
  const afterOverdraft = await db.getPlayer(trader.id);
  assert.strictEqual(afterOverdraft!.credits, beforeOverdraft!.credits, 'refused buy must not debit');
  const invAfterOverdraft = await db.getInventory(trader.id);
  assert.deepStrictEqual(invAfterOverdraft, invBeforeOverdraft, 'refused buy must not mint inventory');
  const poolAfterFail = await db.getMarketReserve('HELIUM3');
  assert.strictEqual(poolAfterFail!.reserve, BASELINE_RESERVES.HELIUM3, 'refused buy must not move the pool');
  ok('overdraft refused atomically — no debit, no mint, pool untouched');

  // B6 — oversell fails cleanly.
  const heldBefore = (await db.getInventory(trader.id)).TITANIUM ?? 0;
  await assert.rejects(
    () => market.executeTrade(trader.id, 'TITANIUM', heldBefore + 500, false, db),
    (err: unknown) => (err as TradeError).code === 'insufficient_inventory',
    'selling stock you do not hold must be refused',
  );
  assert.strictEqual((await db.getInventory(trader.id)).TITANIUM, heldBefore, 'refused sell must not burn stock');
  ok('oversell refused — inventory unchanged after rejection');

  // B7 — unknown player and bad amount are refused at the engine boundary.
  await assert.rejects(
    () => market.executeTrade('ghost', 'REGOLITH', 1, true, db),
    (err: unknown) => (err as TradeError).code === 'unknown_player',
  );
  await assert.rejects(
    () => market.executeTrade(trader.id, 'REGOLITH', -1, true, db),
    (err: unknown) => (err as TradeError).code === 'bad_amount',
  );
  await assert.rejects(
    () => market.executeTrade(trader.id, 'UNOBTANIUM' as Commodity, 1, true, db),
    (err: unknown) => (err as TradeError).code === 'unknown_commodity',
  );
  await assert.rejects(
    () => market.executeTrade(trader.id, 'REGOLITH', MAX_TRADE_AMOUNT + 1, true, db),
    (err: unknown) => (err as TradeError).code === 'bad_amount',
    'orders above the per-order cap must be refused',
  );
  ok('engine rejects unknown player, bad amount, bogus commodity, and oversized orders');

  // B8 — the CAS guard: a stale expected reserve must be rejected outright.
  await assert.rejects(
    () =>
      db.recordTrade({
        tradeId: 'stale-fill',
        playerId: trader.id,
        commodity: 'REGOLITH',
        amount: 1,
        isBuy: true,
        totalCredits: 1,
        unitPrice: 1,
        expectedReserve: 12_345_678, // not the live pool
        newReserve: 12_345_677,
      }),
    (err: unknown) => (err as TradeError).code === 'reserve_changed',
    'a fill priced against a dead reserve must never land',
  );
  assert.strictEqual((await db.getTransaction('stale-fill')), undefined, 'rejected fill leaves no ledger row');
  ok('optimistic-concurrency CAS rejects stale-reserve fills, ledger stays clean');

  // B9 — rollback integrity: an aborted transaction leaves every ledger alone.
  const snapshotBefore = await db.snapshot();
  await assert.rejects(() => db.withTransaction(async () => {
    await db.adjustInventory(trader.id, 'BASALT', 999);
    throw new Error('boom');
  }));
  const invAfterRollback = await db.getInventory(trader.id);
  assert.ok(!invAfterRollback.BASALT || invAfterRollback.BASALT === 0, 'rolled-back inventory must not persist');
  const snapshotAfter = await db.snapshot();
  assert.strictEqual(
    JSON.stringify(snapshotBefore.inventory),
    JSON.stringify(snapshotAfter.inventory),
    'inventory must be byte-identical after a rollback',
  );
  ok('transaction rollback unwinds inventory writes completely');

  // B10 — nested transactions compose (savepoints, not BEGIN-in-BEGIN).
  const nested = await db.withTransaction(async () => {
    await db.adjustInventory(trader.id, 'ILMENITE', 10);
    return db.withTransaction(async () => {
      await db.adjustInventory(trader.id, 'ILMENITE', 5);
      return (await db.getInventory(trader.id)).ILMENITE;
    });
  });
  assert.strictEqual(nested, 15, 'nested savepoints must both apply');
  await assert.rejects(() => db.withTransaction(async () => {
    await db.adjustInventory(trader.id, 'ILMENITE', 100);
    await db.withTransaction(async () => {
      throw new Error('inner boom');
    });
  }));
  assert.strictEqual((await db.getInventory(trader.id)).ILMENITE, 15, 'inner failure must unwind the outer frame too');
  ok('nested transactions use savepoints and unwind as one unit');

  // B11 — mining feeds the tradable wallet (legacy mirror stays consistent).
  const miner = await db.createPlayer({ id: 'miner-1', username: 'digby', faction: 'cha', credits: 0, role: 'miner' });
  await db.creditExtraction(miner.id, { regolith: 120 }, 120, { REGOLITH: 120 });
  const minerRes = await db.getResources(miner.id);
  const minerInv = await db.getInventory(miner.id);
  assert.strictEqual(minerRes!.regolith, 120, 'physical ledger credited');
  assert.strictEqual(minerInv.REGOLITH, 120, 'tradable wallet mirrored');
  assert.strictEqual((await db.getPlayer(miner.id))!.credits, 120, 'extraction bounty paid');
  // ...and the mined haul is sellable.
  const sellMined = await market.executeTrade(miner.id, 'REGOLITH', 100, false, db);
  assert.ok(sellMined.totalCredits > 0);
  assert.strictEqual((await db.getInventory(miner.id)).REGOLITH, 20);
  assert.strictEqual((await db.getResources(miner.id))!.regolith, 20, 'legacy ledger must follow the sale');
  ok('mined ore is sellable and both ledgers stay in lockstep', `sold 100 for ${sellMined.totalCredits}`);

  await db.close();
  market.dispose();
}

// ===========================================================================
// LAYER C — LunarServer wire protocol over WebSocket
// ===========================================================================

async function layerC(): Promise<void> {
  section('C. LunarServer TRADE / LAY_RAIL over WebSocket');
  const port = 3987 + Math.floor(Math.random() * 40);
  const server = new LunarServer({ port, dbPath: DB_PATH + '.srv', marketSyncIntervalSeconds: 0 });
  const address = await server.start();
  console.log(`  server listening on ${address}`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const { waitFor } = record(ws);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  await waitFor((m) => m.type === 'hello', 'hello');

  // C1 — JOIN carries a pre-populated market snapshot + inventory wallet.
  ws.send(JSON.stringify({ type: 'JOIN', payload: { username: 'market_rat', faction: 'esa' } }));
  const welcome = await waitFor((m) => m.type === 'welcome', 'welcome');
  assert.ok(welcome.market, 'welcome must carry a market snapshot');
  assert.strictEqual(Object.keys(welcome.market.prices).length, COMMODITIES.length);
  assert.ok(welcome.market.reserves.HELIUM3 > 0);
  assert.ok(welcome.inventory && typeof welcome.inventory === 'object');
  assert.ok(Array.isArray(welcome.world.rail_tracks), 'welcome must list laid rail');
  const playerId = welcome.player.id;
  ok('JOIN welcome ships market snapshot + inventory wallet + rail_tracks',
     `He3 ask ${welcome.market.prices.HELIUM3}`);

  // C2 — TRADE before JOIN is refused on a fresh socket.
  const anon = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const anonRec = record(anon);
  await new Promise((res, rej) => {
    anon.on('open', res);
    anon.on('error', rej);
  });
  await anonRec.waitFor((m) => m.type === 'hello', 'anon hello');
  anon.send(JSON.stringify({ type: 'TRADE', payload: { commodity: 'REGOLITH', amount: 5, is_buy: true } }));
  const notJoined = await anonRec.waitFor((m) => m.type === 'error' && m.code === 'not_joined', 'not_joined');
  ok('TRADE without JOIN rejected', notJoined.code);
  anon.close();

  // C3 — malformed frames get precise codes.
  ws.send(JSON.stringify({ type: 'TRADE', payload: { commodity: 'UNOBTANIUM', amount: 5, is_buy: true } }));
  const badCommodity = await waitFor((m) => m.type === 'error' && m.code === 'unknown_commodity', 'unknown_commodity');
  ok('unknown commodity rejected', badCommodity.code);

  ws.send(JSON.stringify({ type: 'TRADE', payload: { commodity: 'REGOLITH', amount: -3, is_buy: true } }));
  await waitFor((m) => m.type === 'error' && m.code === 'bad_amount', 'bad_amount (negative)');
  ws.send(JSON.stringify({ type: 'TRADE', payload: { commodity: 'REGOLITH', amount: 0, is_buy: true } }));
  await waitFor((m) => m.type === 'error' && m.code === 'bad_amount', 'bad_amount (zero)');
  ws.send(JSON.stringify({ type: 'TRADE', payload: { commodity: 'REGOLITH', amount: 5 } }));
  await waitFor((m) => m.type === 'error' && m.code === 'bad_trade', 'bad_trade (is_buy missing)');
  ws.send(JSON.stringify({ type: 'TRADE', payload: { commodity: 'REGOLITH', amount: 1e9, is_buy: true } }));
  await waitFor((m) => m.type === 'error' && m.code === 'bad_amount', 'bad_amount (over cap)');
  ok('TRADE validates amount > 0, the is_buy boolean, and the order cap');

  // C4 — a successful BUY: receipt + market_sync broadcast.
  //      Sizing note: a fresh JOIN holds STARTING_CREDITS = 1000, and TITANIUM
  //      runs ~45 cr/kg, so 15 kg (~675 cr) is comfortably affordable. The
  //      server already refused an unaffordable 30 kg order above-style in the
  //      C6 overdraft probe, which is the behaviour we want.
  ws.send(JSON.stringify({ type: 'TRADE', payload: { commodity: 'TITANIUM', amount: 15, is_buy: true } }));
  const buyConf = await waitFor((m) => m.type === 'trade_confirmed', 'trade_confirmed (buy)');
  assert.strictEqual(buyConf.commodity, 'TITANIUM');
  assert.strictEqual(buyConf.amount, 15);
  assert.strictEqual(buyConf.is_buy, true);
  assert.ok(buyConf.total_credits > 0, 'buy must cost credits');
  assert.ok(typeof buyConf.trade_id === 'string' && buyConf.trade_id.length > 0);
  assert.strictEqual(buyConf.new_balance, buyConf.credits);
  assert.ok(buyConf.new_balance < welcome.player.credits, 'balance must fall after a buy');
  assert.strictEqual(buyConf.inventory.TITANIUM, 15, 'receipt inventory must show the fill');
  assert.ok(buyConf.quote && buyConf.quote.reserve_before > buyConf.quote.reserve_after, 'buy drained the pool');
  ok('BUY trade_confirmed', `15 TITANIUM for ${buyConf.total_credits} cr -> balance ${buyConf.new_balance}`);

  const buySync = await waitFor((m) => m.type === 'market_sync', 'market_sync after buy');
  assert.strictEqual(typeof buySync.timestamp, 'number');
  assert.ok(buySync.prices && buySync.reserves);
  assert.ok(buySync.reserves.TITANIUM < BASELINE_RESERVES.TITANIUM, 'sync must show the drained pool');
  ok('market_sync broadcast follows the trade', `TITANIUM reserve ${buySync.reserves.TITANIUM}`);

  // C5 — full round trip: buy 15, sell the same 15 back.
  //
  //      The provable invariant. A buy walks the reserve DOWN through
  //      {R-1 … R-N}; selling N back UP walks {R-N+1 … R}. Subtracting the two
  //      sums leaves exactly P(R-N) - P(R), which is strictly positive because
  //      price falls as reserve rises. So buying and selling the SAME quantity
  //      must always return less than it cost — the spread, guaranteed.
  //
  //      (A *partial* round trip can look profitable on the units sold alone,
  //      because the retained stock absorbs the rest of the spread; that is an
  //      accounting artifact of comparing unequal quantities, not free money —
  //      closing the position in full always nets a loss.)
  ws.send(JSON.stringify({ type: 'TRADE', payload: { commodity: 'TITANIUM', amount: 15, is_buy: false } }));
  const sellConf = await waitFor((m) => m.type === 'trade_confirmed', 'trade_confirmed (sell)');
  assert.strictEqual(sellConf.is_buy, false);
  assert.strictEqual(sellConf.amount, 15);
  assert.ok(sellConf.total_credits > 0);
  assert.strictEqual(sellConf.inventory.TITANIUM ?? 0, 0, 'full round trip closes the position');
  assert.ok(sellConf.new_balance > buyConf.new_balance, 'selling must credit credits even at a loss');
  const roundTripLoss = buyConf.total_credits - sellConf.total_credits;
  assert.ok(roundTripLoss > 0,
    `round trip must lose the spread: cost ${buyConf.total_credits}, returned ${sellConf.total_credits}`);
  assert.ok(roundTripLoss < buyConf.total_credits * 0.5,
    `loss must be a spread, not a haircut: ${roundTripLoss} of ${buyConf.total_credits}`);
  ok('buy 15 / sell 15 returns less than it cost (guaranteed spread)',
     `paid ${buyConf.total_credits}, returned ${sellConf.total_credits}, lost ${roundTripLoss.toFixed(3)} cr`);

  const sellSync = await waitFor((m) => m.type === 'market_sync', 'market_sync after sell');
  assert.ok(
    sellSync.reserves.TITANIUM > buySync.reserves.TITANIUM,
    'selling must refill the station pool',
  );
  ok('selling refills reserves', `${buySync.reserves.TITANIUM} -> ${sellSync.reserves.TITANIUM}`);

  // C6 — overdraft over the wire: clean error, balance untouched.
  const balanceNow = sellConf.new_balance;
  ws.send(JSON.stringify({ type: 'TRADE', payload: { commodity: 'HELIUM3', amount: 5000, is_buy: true } }));
  const broke = await waitFor((m) => m.type === 'error' && m.code === 'insufficient_credits', 'insufficient_credits');
  ok('wire-level overdraft refused cleanly', broke.message.slice(0, 60));
  ws.send(JSON.stringify({ type: 'MARKET_QUERY' }));
  await waitFor((m) => m.type === 'market_sync', 'market_sync after overdraft');
  // Balance must not have moved: probe with a tiny known trade.
  ws.send(JSON.stringify({ type: 'TRADE', payload: { commodity: 'REGOLITH', amount: 1, is_buy: true } }));
  const probe = await waitFor((m) => m.type === 'trade_confirmed', 'probe buy after overdraft');
  assert.ok(probe.new_balance < balanceNow && probe.new_balance > balanceNow - 200,
    `balance should have moved only by the probe cost (was ${balanceNow}, now ${probe.new_balance})`);
  ok('overdraft left the balance intact', `${balanceNow} -> ${probe.new_balance} after a 1 kg probe`);

  // C7 — oversell over the wire.
  ws.send(JSON.stringify({ type: 'TRADE', payload: { commodity: 'WATER_ICE', amount: 500, is_buy: false } }));
  const noStock = await waitFor((m) => m.type === 'error' && m.code === 'insufficient_inventory', 'insufficient_inventory');
  ok('wire-level oversell refused', noStock.code);

  // C8 — LAY_RAIL happy path: receipt + rail_placed broadcast.
  ws.send(JSON.stringify({
    type: 'LAY_RAIL',
    payload: { p0: [100, 200, 5], p1: [130, 240, 5] },
  }));
  const laid = await waitFor((m) => m.type === 'rail_laid', 'rail_laid');
  assert.strictEqual(laid.ok, true);
  assert.ok(typeof laid.rail_id === 'string' && laid.rail_id.length > 0);
  assert.deepStrictEqual(laid.p0, [100, 200, 5]);
  assert.deepStrictEqual(laid.p1, [130, 240, 5]);
  approx(laid.length, 50, 1e-9, 'segment length');
  assert.strictEqual(laid.gauge, PLAYER_RAIL_GAUGE_M);
  assert.strictEqual(laid.built_by, playerId);
  ok('LAY_RAIL accepted and echoed', `id ${String(laid.rail_id).slice(0, 8)} len ${laid.length}`);

  const placed = await waitFor((m) => m.type === 'rail_placed', 'rail_placed broadcast');
  assert.strictEqual(placed.rail_id, laid.rail_id);
  assert.deepStrictEqual(placed.p0, [100, 200, 5]);
  assert.deepStrictEqual(placed.p1, [130, 240, 5]);
  assert.strictEqual(placed.built_by, playerId);
  ok('rail_placed broadcast carries rail_id, p0, p1, built_by');

  // C9 — LAY_RAIL validation boundaries.
  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [0, 0, 0], p1: [0.2, 0, 0] } }));
  const tooShort = await waitFor((m) => m.type === 'error' && m.code === 'bad_rail', 'rail too short');
  assert.ok(tooShort.message.includes(String(MIN_RAIL_SEGMENT_M)));
  ok(`rail under ${MIN_RAIL_SEGMENT_M} m rejected`);

  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [0, 0, 0], p1: [0, 200, 0] } }));
  const tooLong = await waitFor((m) => m.type === 'error' && m.code === 'bad_rail', 'rail too long');
  assert.ok(tooLong.message.includes(String(MAX_RAIL_SEGMENT_M)));
  ok(`rail over ${MAX_RAIL_SEGMENT_M} m rejected`);

  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [0, 0], p1: [10, 0, 0] } }));
  await waitFor((m) => m.type === 'error' && m.code === 'bad_rail', 'malformed p0');
  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [0, 0, 0], p1: [10, 0, 'x'] } }));
  await waitFor((m) => m.type === 'error' && m.code === 'bad_rail', 'non-numeric coordinate');
  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [0, 0, 0], p1: [10, 0, null] } }));
  await waitFor((m) => m.type === 'error' && m.code === 'bad_rail', 'null coordinate');
  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [0, 0, 0], p1: [Infinity, 0, 0] } }));
  await waitFor((m) => m.type === 'error' && m.code === 'bad_rail', 'infinite coordinate');
  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p1: [10, 0, 0] } }));
  await waitFor((m) => m.type === 'error' && m.code === 'bad_rail', 'missing p0');
  ok('LAY_RAIL rejects short/long/malformed/non-numeric/null/infinite/missing endpoints');

  // C10 — exact boundary lengths are accepted (1 m and 100 m inclusive).
  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [500, 500, 2], p1: [501, 500, 2] } }));
  const edge1 = await waitFor((m) => m.type === 'rail_laid' || (m.type === 'error' && m.code === 'bad_rail'), '1 m rail');
  assert.strictEqual(edge1.type, 'rail_laid', `exactly ${MIN_RAIL_SEGMENT_M} m must be legal: ${JSON.stringify(edge1)}`);
  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [600, 600, 2], p1: [700, 600, 2] } }));
  const edge100 = await waitFor((m) => m.type === 'rail_laid' || (m.type === 'error' && m.code === 'bad_rail'), '100 m rail');
  assert.strictEqual(edge100.type, 'rail_laid', `exactly ${MAX_RAIL_SEGMENT_M} m must be legal: ${JSON.stringify(edge100)}`);
  ok('boundary lengths 1 m and 100 m are accepted (inclusive)');

  // C11 — sub-surface rail is legal, surface-straddling is not.
  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [10, 10, -5], p1: [20, 10, -12] } }));
  const tunnel = await waitFor((m) => m.type === 'rail_laid', 'sub-surface rail');
  assert.strictEqual(tunnel.ok, true);
  ok('sub-surface rail accepted (tunnel descents are valid)');

  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [40, 10, 5], p1: [50, 10, -20] } }));
  const straddle = await waitFor((m) => m.type === 'error' && m.code === 'bad_rail', 'surface-straddling rail');
  assert.ok(straddle.message.includes('surface'));
  ok('surface-straddling rail rejected');

  // C12 — LAY_RAIL before JOIN.
  const anon2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const anon2Rec = record(anon2);
  await new Promise((res, rej) => {
    anon2.on('open', res);
    anon2.on('error', rej);
  });
  await anon2Rec.waitFor((m) => m.type === 'hello', 'anon2 hello');
  anon2.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [0, 0, 0], p1: [10, 0, 0] } }));
  await anon2Rec.waitFor((m) => m.type === 'error' && m.code === 'not_joined', 'LAY_RAIL not_joined');
  ok('LAY_RAIL without JOIN rejected');
  anon2.close();

  // C13 — rails persisted and surfaced over HTTP.
  const worldHttp = await (await fetch(`http://127.0.0.1:${port}/api/world`)).json();
  assert.ok(Array.isArray(worldHttp.rail_tracks));
  assert.ok(worldHttp.rail_tracks.length >= 4, `expected >=4 persisted rails, got ${worldHttp.rail_tracks.length}`);
  const match = worldHttp.rail_tracks.find((r: any) => r.id === laid.rail_id);
  assert.ok(match, 'the rail we laid must be listed by /api/world');
  assert.strictEqual(match.built_by, playerId);
  approx(match.length, 50, 1e-9);
  assert.strictEqual(match.status, 'active');
  ok('rails persist to SQLite and surface via GET /api/world', `${worldHttp.rail_tracks.length} active rails`);

  // C14 — market HTTP feed reflects LIVE state, not constructor defaults.
  //       TITANIUM was round-tripped in C5 (buy 15, sell 15), which must
  //       restore that pool to EXACTLY baseline — reserves move with fills and
  //       nothing leaks. REGOLITH only ever had a one-way 1 kg probe buy, so
  //       its pool must sit strictly below baseline.
  const marketHttp = await (await fetch(`http://127.0.0.1:${port}/api/market`)).json();
  assert.strictEqual(Object.keys(marketHttp.prices).length, COMMODITIES.length);
  assert.strictEqual(
    marketHttp.reserves.TITANIUM,
    BASELINE_RESERVES.TITANIUM,
    'a full round trip must restore the pool exactly (no reserve leak)',
  );
  assert.ok(
    marketHttp.reserves.REGOLITH < BASELINE_RESERVES.REGOLITH,
    `REGOLITH pool must show the one-way probe buy (got ${marketHttp.reserves.REGOLITH})`,
  );
  assert.ok(marketHttp.prices.HELIUM3 > marketHttp.sellPrices.HELIUM3, 'HTTP book keeps a live spread');
  ok('GET /api/market reflects live fills; round trip leaked no reserve',
     `TITANIUM ${marketHttp.reserves.TITANIUM} (restored), REGOLITH ${marketHttp.reserves.REGOLITH}`);

  // C15 — a second client sees the first client's rail broadcast live.
  const peer = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const peerRec = record(peer);
  await new Promise((res, rej) => {
    peer.on('open', res);
    peer.on('error', rej);
  });
  await peerRec.waitFor((m) => m.type === 'hello', 'peer hello');
  peer.send(JSON.stringify({ type: 'JOIN', payload: { username: 'observer', faction: 'cha' } }));
  const peerWelcome = await peerRec.waitFor((m) => m.type === 'welcome', 'peer welcome');
  assert.ok(peerWelcome.world.rail_tracks.length >= 4, 'a joiner sees previously laid rail');
  ws.send(JSON.stringify({ type: 'LAY_RAIL', payload: { p0: [900, 900, 1], p1: [925, 900, 1] } }));
  const liveRail = await peerRec.waitFor((m) => m.type === 'rail_placed', 'peer receives live rail_placed');
  assert.strictEqual(liveRail.built_by, playerId, 'peer attributes the rail to its builder');
  ok('live rail broadcast reaches a connected peer');
  peer.close();

  await server.stop();
  const downAfter = await fetch(`http://127.0.0.1:${port}/health`).then(() => 'up', () => 'down');
  assert.strictEqual(downAfter, 'down');
  await server.stop(); // idempotent
  ok('server.stop() closes HTTP and is idempotent');
  ws.close();
}

// ===========================================================================
// LAYER D — periodic market_sync timer
// ===========================================================================

async function layerD(): Promise<void> {
  section('D. Periodic market_sync broadcast timer');
  const port = 4411 + Math.floor(Math.random() * 30);
  // 0.1 s interval so a sub-second wait collects several frames.
  const server = new LunarServer({ port, dbPath: DB_PATH + '.sync', marketSyncIntervalSeconds: 0.1 });
  await server.start();

  const syncs: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('message', (raw: WebSocket.RawData) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'market_sync') syncs.push(m);
    } catch {
      /* ignore */
    }
  });
  await new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', (e: unknown) => rej(e));
  });
  ws.send(JSON.stringify({ type: 'JOIN', payload: { username: 'ticker', faction: 'esa' } }));

  await new Promise((r) => setTimeout(r, 700));
  assert.ok(syncs.length >= 4, `expected >=4 periodic syncs in ~700ms, got ${syncs.length}`);
  assert.strictEqual(Object.keys(syncs[0].prices).length, COMMODITIES.length);
  assert.ok(syncs[0].reserves && syncs[0].sell_prices);
  for (let i = 1; i < syncs.length; i++) {
    assert.ok(syncs[i].timestamp >= syncs[i - 1].timestamp, 'sync timestamps must never go backwards');
  }
  ok('periodic market_sync fires on schedule, payloads well-formed',
     `${syncs.length} frames in ~700ms`);

  // stop() must clear the interval, or a stopped server keeps broadcasting.
  const before = syncs.length;
  await server.stop();
  await new Promise((r) => setTimeout(r, 350));
  assert.strictEqual(syncs.length, before, 'stop() must halt the periodic sync timer');
  ok('stop() clears the market_sync timer (no broadcast after shutdown)',
     `${before} -> ${syncs.length} frames`);
  ws.close();
  for (const suffix of ['', '-wal', '-shm', '.sync', '.sync-wal', '.sync-shm']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
}

// ===========================================================================

async function main(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '.srv', '.srv-wal', '.srv-shm']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }

  console.log('LUNAR FRONTIER — PHASE 8a MARKET & RAILS SMOKE TEST');
  await layerA();
  await layerB();
  await layerC();
  await layerD();

  for (const suffix of ['', '-wal', '-shm', '.srv', '.srv-wal', '.srv-shm']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
  console.log(`\nALL ${STAGE.passed} MARKET & RAIL CHECKS PASSED`);
}

main().catch((err) => {
  console.error('\nSMOKE FAILED:', err);
  process.exit(1);
});
