/**
 * Lunar Frontier — Phase 8a station market engine (spec 13 §4).
 *
 * A constant-product-ish bonding curve over per-commodity liquidity pools,
 * server-authoritative and SQLite-backed. Six commodities trade with the
 * station ("STATION_EXCHANGE") as the virtual counterparty:
 *
 *   REGOLITH 5 · BASALT 15 · TITANIUM 45 · ILMENITE 75 · WATER_ICE 120 · HELIUM3 500
 *
 * Spot price (spec 13 §4):
 *
 *   P(c) = P0(c) * clamp(1 + 0.5 * (R_base - R_cur) / R_base, 0.2, 5.0)
 *
 * Buying draws down the station reserve, pushing R_cur down and the spot price
 * UP; selling supplies the station, pushing R_cur up and the price DOWN. The
 * clamp keeps price within [20%, 500%] of base no matter how far a pool is
 * drained or flooded.
 *
 * Slippage / execution model — the important subtlety: a market order is NOT
 * filled at the pre-trade spot price. Each unit fills at the curve's marginal
 * price *for that unit*, so the fill cost is the integral of the curve across
 * the order. It uses the taker convention: the first traded unit sees the pool
 * already moved by one, so unit n of a buy sees reserve (R - 1 - n) and unit n
 * of a sell sees (R + 1 + n). Two reasons:
 *
 *   1. every order crosses a real spread — including a 1 kg order, which under
 *      a pre-trade convention would buy and sell at an identical price; and
 *   2. `getMarketSnapshot().prices[c]` is exactly what a 1 kg buy costs, so the
 *      quoted book can never disagree with the fill it produces.
 *
 * Buying therefore always costs MORE than `amount * spot`, and selling always
 * pays LESS. Quoting via `getPrice` is indicative; `quoteOrder` is what fills.
 *
 * Note on precision: unit prices keep 6 decimals, totals keep 2. On a 5-credit
 * commodity with a deep pool the whole spread is ~0.006 cr/kg, so rounding unit
 * prices to cents would collapse bid and ask onto the same number.
 *
 * The integral is computed in closed form (arithmetic series) while the order
 * stays inside the price band, so a 1 kg order and a 100 000 kg order cost the
 * same CPU:
 *
 *   sum_{n=0}^{N-1} (R - n) = N*R - N(N-1)/2        (buy: price rises)
 *   sum_{n=0}^{N-1} (R + n) = N*R + N(N-1)/2        (sell: price falls)
 *
 * Atomicity: `executeTrade` re-reads the pool, prices against that exact
 * reserve, and commits through `DatabaseManager.recordTrade`, which compare-
 * and-swaps the pool row. A concurrent trade that moved the pool first makes
 * this one throw `reserve_changed` rather than fill at a stale price; the
 * caller reprices and retries (bounded, `retryLimit`).
 *
 * Usage:
 *   const market = new MarketEngine();
 *   await market.initialize(db);                 // seeds pools, idempotent
 *   await market.quoteOrder('HELIUM3', 10, true) // -> { totalCredits, ... }
 *   await market.executeTrade('p1', 'HELIUM3', 10, true, db)
 *   market.getMarketSnapshot()                   // -> { prices, reserves }
 */

import {
  DatabaseManager,
  STATION_ID,
  TradeError,
  type MarketReserveRow,
  type MarketTradeResult,
  type ResourceUpdate,
} from '../database';

// ---------------------------------------------------------------------------
// Commodity catalogue
// ---------------------------------------------------------------------------

/** Every commodity the station quotes. */
export type Commodity =
  | 'REGOLITH'
  | 'BASALT'
  | 'TITANIUM'
  | 'ILMENITE'
  | 'WATER_ICE'
  | 'HELIUM3';

export const COMMODITIES: readonly Commodity[] = [
  'REGOLITH',
  'BASALT',
  'TITANIUM',
  'ILMENITE',
  'WATER_ICE',
  'HELIUM3',
];

/** Spec 13 §4 base prices P0, credits per kg. */
export const BASE_PRICES: Record<Commodity, number> = {
  REGOLITH: 5,
  BASALT: 15,
  TITANIUM: 45,
  ILMENITE: 75,
  WATER_ICE: 120,
  HELIUM3: 500,
};

/**
 * Starting liquidity pool per commodity (kg). Chosen roughly inversely to
 * scarcity — the station stockpiles cheap bulk fill and holds little He-3 —
 * so a fresh server opens every commodity exactly at its base price.
 */
export const BASELINE_RESERVES: Record<Commodity, number> = {
  REGOLITH: 100_000,
  BASALT: 40_000,
  TITANIUM: 12_000,
  ILMENITE: 8_000,
  WATER_ICE: 5_000,
  HELIUM3: 1_000,
};

/** Price floor / ceiling as multiples of base (spec 13 §4: 20% .. 500%). */
export const PRICE_FLOOR_MULTIPLIER = 0.2;
export const PRICE_CEILING_MULTIPLIER = 5.0;

/** Curve slope coefficient: 0.5 per spec (max +/-50% swing per full pool). */
export const PRICE_ELASTICITY = 0.5;

/** Hard cap on units per market order — keeps a fat-finger order from moving
 *  the whole curve and bounds per-frame DB work. */
export const MAX_TRADE_AMOUNT = 50_000;

/** Bounded repricing retries when the pool moves under a trade. */
export const TRADE_RETRY_LIMIT = 4;

/**
 * Which legacy `resources` column mirrors a commodity, when one exists.
 * BASALT / TITANIUM / ILMENITE have no legacy column and live only in the
 * Phase 8a `inventory` ledger.
 */
export const LEGACY_RESOURCE_COLUMNS: Partial<Record<Commodity, keyof ResourceUpdate>> = {
  REGOLITH: 'regolith',
  WATER_ICE: 'water_ice',
  HELIUM3: 'helium3',
};

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface PriceQuote {
  commodity: Commodity;
  isBuy: boolean;
  /** Units the order would move. */
  amount: number;
  /** Indicative spot price for a marginal unit at the current reserve. */
  spotPrice: number;
  /** Average unit price across the whole order (total / amount). */
  averagePrice: number;
  /** First unit's marginal price. */
  firstUnitPrice: number;
  /** Last unit's marginal price (worst price the order touches). */
  lastUnitPrice: number;
  /** Credits to pay (buy) or receive (sell), rounded to 2dp. */
  totalCredits: number;
  reserveBefore: number;
  reserveAfter: number;
  /** Fractional slippage vs. filling everything at spot (0 when amount ~ 0). */
  priceImpact: number;
}

export interface MarketSnapshot {
  /** Indicative buy price per commodity (what the station asks). */
  prices: Record<string, number>;
  /** Live reserve per commodity. */
  reserves: Record<string, number>;
  /** Base price per commodity, so clients can render a P0 reference line. */
  basePrices: Record<string, number>;
  /** Live sell price per commodity (what the station bids). */
  sellPrices: Record<string, number>;
  timestamp: number;
}

export interface MarketEngineOptions {
  /** Override base prices (tests / reskins). */
  basePrices?: Partial<Record<Commodity, number>>;
  /** Override baseline reserves used when seeding pools. */
  baselineReserves?: Partial<Record<Commodity, number>>;
  /** Override the price band. */
  floorMultiplier?: number;
  ceilingMultiplier?: number;
  /** Curve elasticity (spec default 0.5). */
  elasticity?: number;
  /** Bounded repricing retries per executeTrade. */
  retryLimit?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /** Trade-id factory. */
  idFactory?: () => string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Unit prices keep 6 decimals while money keeps 2.
 *
 * This is not cosmetic. On a 5-credit commodity with a deep pool the entire
 * buy/sell spread is ~0.006 credits per kg, so a 2-decimal unit price rounds
 * BOTH sides to the same number and the terminal renders a market with no
 * spread at all. The totals (the money that actually moves) stay in cents.
 */
function roundPrice(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// MarketEngine
// ---------------------------------------------------------------------------

export class MarketEngine {
  /** Live reserve per commodity (mirror of `market_reserves`, refreshed by sync). */
  private reserves = new Map<Commodity, number>();
  private baseline = new Map<Commodity, number>();

  private readonly basePrice = new Map<Commodity, number>();
  private readonly floorMult: number;
  private readonly ceilingMult: number;
  private readonly elasticity: number;
  private readonly retryLimit: number;
  private readonly now: () => number;
  private readonly makeId: () => string;

  /** The manager `executeTrade` commits against (may be per-call instead). */
  private db: DatabaseManager | null = null;
  private initialized = false;
  private disposed = false;

  /** Monotonic counter so retries never reuse a trade id. */
  private tradeSeq = 0;

  constructor(options: MarketEngineOptions = {}) {
    for (const commodity of COMMODITIES) {
      const price = options.basePrices?.[commodity] ?? BASE_PRICES[commodity];
      if (!(price > 0)) throw new Error(`MarketEngine: base price for ${commodity} must be > 0`);
      this.basePrice.set(commodity, price);
      const base = options.baselineReserves?.[commodity] ?? BASELINE_RESERVES[commodity];
      if (!(base > 0)) throw new Error(`MarketEngine: baseline reserve for ${commodity} must be > 0`);
      this.baseline.set(commodity, base);
      this.reserves.set(commodity, base);
    }
    this.floorMult = options.floorMultiplier ?? PRICE_FLOOR_MULTIPLIER;
    this.ceilingMult = options.ceilingMultiplier ?? PRICE_CEILING_MULTIPLIER;
    if (!(this.ceilingMult > this.floorMult)) {
      throw new Error('MarketEngine: ceiling multiplier must exceed floor multiplier');
    }
    this.elasticity = options.elasticity ?? PRICE_ELASTICITY;
    this.retryLimit = options.retryLimit ?? TRADE_RETRY_LIMIT;
    this.now = options.now ?? (() => Date.now());
    this.makeId = options.idFactory ?? (() => `tx-${this.now().toString(36)}-${(++this.tradeSeq).toString(36)}`);
  }

  // -- lifecycle ---------------------------------------------------------------

  /**
   * Attaches the persistence layer and idempotently seeds the liquidity pools,
   * then loads live reserves and backfills pre-market ore into `inventory`.
   * Safe to call again to reload state from disk.
   */
  async initialize(db: DatabaseManager): Promise<this> {
    this.assertAlive();
    this.db = db;
    await db.seedMarketReserves(
      COMMODITIES.map((commodity) => ({ commodity, baseline: this.baseline.get(commodity) as number })),
    );
    await db.backfillInventoryFromResources(LEGACY_RESOURCE_COLUMNS);
    await this.syncReserves();
    this.initialized = true;
    return this;
  }

  /** Reload live reserves from the database (multi-server / out-of-band writes). */
  async syncReserves(): Promise<void> {
    this.assertAlive();
    if (this.db === null) return;
    const rows: MarketReserveRow[] = await this.db.listMarketReserves();
    for (const row of rows) {
      const commodity = row.commodity as Commodity;
      if (!COMMODITIES.includes(commodity)) continue;
      this.reserves.set(commodity, row.reserve);
      // Trust the persisted baseline once persisted (allows tuned live servers).
      this.baseline.set(commodity, row.baseline_reserve);
    }
  }

  /** Releases the DB reference. Idempotent; engine refuses work afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.db = null;
    this.initialized = false;
    this.reserves.clear();
  }

  isInitialized(): boolean {
    return this.initialized && !this.disposed;
  }

  // -- catalogue ---------------------------------------------------------------

  /** Base price P0 for a commodity. Throws for unknown ids. */
  basePriceOf(commodity: Commodity): number {
    const price = this.basePrice.get(commodity);
    if (price === undefined) throw new Error(`MarketEngine: unknown commodity "${commodity}"`);
    return price;
  }

  /** Live reserve for a commodity (falls back to baseline if unseeded). */
  reserveOf(commodity: Commodity): number {
    if (!COMMODITIES.includes(commodity)) throw new Error(`MarketEngine: unknown commodity "${commodity}"`);
    return this.reserves.get(commodity) ?? (this.baseline.get(commodity) as number);
  }

  /** Baseline reserve (the curve denominator) for a commodity. */
  baselineOf(commodity: Commodity): number {
    if (!COMMODITIES.includes(commodity)) throw new Error(`MarketEngine: unknown commodity "${commodity}"`);
    return this.baseline.get(commodity) as number;
  }

  /** Case/alias-tolerant commodity resolution; `undefined` for non-commodities. */
  static normalizeCommodity(value: unknown): Commodity | undefined {
    if (typeof value !== 'string') return undefined;
    const upper = value.trim().toUpperCase();
    // Accept the world generator's spellings alongside the market's.
    const aliases: Record<string, Commodity> = {
      HELIUM_3: 'HELIUM3',
      HE3: 'HELIUM3',
      ICE: 'WATER_ICE',
      WATER: 'WATER_ICE',
      TITANIUM_ORE: 'TITANIUM',
    };
    const candidate = aliases[upper] ?? upper;
    return COMMODITIES.includes(candidate as Commodity) ? (candidate as Commodity) : undefined;
  }

  /**
   * Reverse of {@link LEGACY_RESOURCE_COLUMNS}: which tradable commodity (if
   * any) a legacy `resources` column feeds, so MINE can credit both ledgers.
   */
  static commodityForLegacyResource(column: string): Commodity | undefined {
    for (const [commodity, legacy] of Object.entries(LEGACY_RESOURCE_COLUMNS)) {
      if (legacy === column) return commodity as Commodity;
    }
    return undefined;
  }

  // -- pricing -----------------------------------------------------------------

  /**
   * Spec 13 §4 spot price at a given reserve — the price of a *marginal* unit.
   * `reserve` defaults to the live pool.
   */
  spotPrice(commodity: Commodity, reserve: number = this.reserveOf(commodity)): number {
    const base = this.basePriceOf(commodity);
    const baselineReserve = this.baselineOf(commodity);
    const raw = 1 + this.elasticity * ((baselineReserve - reserve) / baselineReserve);
    return base * Math.min(this.ceilingMult, Math.max(this.floorMult, raw));
  }

  /**
   * Indicative price for `amount` units. When `amount` is supplied the average
   * marginal fill is returned (that is the honest per-unit cost of the order);
   * otherwise the plain spot price.
   *
   * Buy quotes come in ABOVE sell quotes for the same size — that spread is
   * the curve doing its job, not a fee.
   */
  getPrice(commodity: Commodity, isBuy: boolean, amount = 1): number {
    this.assertAlive();
    const resolved = MarketEngine.normalizeCommodity(commodity) ?? commodity;
    if (amount <= 0) return this.spotPrice(resolved);
    return this.quoteOrder(resolved, amount, isBuy).averagePrice;
  }

  /**
   * Full execution quote. Uses the closed-form marginal series so the total is
   * exactly what `executeTrade` will commit for the same reserve.
   */
  quoteOrder(commodity: Commodity, amount: number, isBuy: boolean): PriceQuote {
    this.assertAlive();
    const resolved = MarketEngine.normalizeCommodity(commodity) ?? commodity;
    if (!(amount > 0)) throw new TradeError('bad_amount', `amount must be > 0 (got ${amount})`);
    if (!Number.isFinite(amount)) throw new TradeError('bad_amount', 'amount must be finite');

    const reserveBefore = this.reserveOf(resolved);
    const reserveAfter = isBuy ? reserveBefore - amount : reserveBefore + amount;

    // Execution convention: the taker pays the price *after* its own first
    // unit moves the pool — a buy's unit n trades at (R - 1 - n), a sell's at
    // (R + 1 + n). Two consequences, both intended:
    //
    //   1. every order size (down to 1 kg) crosses a real bid/ask spread, and
    //   2. `getMarketSnapshot().prices[c]` is exactly what a 1 kg buy costs, so
    //      the terminal can never quote a price the fill then disagrees with.
    //
    // Filling at the pre-trade reserve instead would quote buys and sells
    // identically at amount=1 and desynchronise the book from the tape.
    const firstTradeReserve = isBuy ? reserveBefore - 1 : reserveBefore + 1;
    const credits = this.curveIntegral(resolved, firstTradeReserve, amount, isBuy);

    const firstUnitPrice = this.spotPrice(resolved, firstTradeReserve);
    const lastUnitPrice = this.spotPrice(
      resolved,
      isBuy ? firstTradeReserve - (amount - 1) : firstTradeReserve + (amount - 1),
    );
    const spotTotal = firstUnitPrice * amount;

    return {
      commodity: resolved,
      isBuy,
      amount,
      spotPrice: roundPrice(firstUnitPrice),
      averagePrice: roundPrice(credits / amount),
      firstUnitPrice: roundPrice(firstUnitPrice),
      lastUnitPrice: roundPrice(lastUnitPrice),
      totalCredits: round2(credits),
      reserveBefore,
      reserveAfter,
      // Slippage vs. filling the whole order at today's spot — 0 for a 1 kg
      // order, positive for both buys and sells as impact bites.
      priceImpact: spotTotal > 0 ? (credits - spotTotal) / spotTotal : 0,
    };
  }

  /**
   * Sum of the clamped curve across `amount` units, in credits: the exact cost
   * of walking the order one unit at a time, where unit n trades at reserve
   * (R - n) for a buy and (R + n) for a sell.
   *
   * Because the curve is affine in reserve, unit price is LINEAR in n, so an
   * order that stays inside the [floor, ceiling] band is an arithmetic
   * progression and sums in closed form — the path every realistic order takes.
   *
   * Once a band binds, the progression kinks. Rather than solving the kink
   * analytically (easy to get off by one), the clamped path walks units
   * directly: exact by construction, and cheap enough because binding requires
   * draining/flooding ~80% of a pool, which the per-order cap makes rare.
   */
  private curveIntegral(
    commodity: Commodity,
    reserveStart: number,
    amount: number,
    isBuy: boolean,
  ): number {
    const base = this.basePriceOf(commodity);
    const baselineReserve = this.baselineOf(commodity);
    const e = this.elasticity;
    const floor = base * this.floorMult;
    const ceiling = base * this.ceilingMult;

    // Unit n's price, unclamped: affine in n (slope sign fixed by side).
    const slope = (isBuy ? e : -e) * (base / baselineReserve);
    const intercept = base * (1 + e * ((baselineReserve - reserveStart) / baselineReserve));
    const priceAt = (n: number): number => intercept + slope * n;

    const p0 = priceAt(0);
    const pLast = priceAt(amount - 1);

    // In-band fast path: arithmetic progression over n = 0 .. amount-1.
    if (p0 >= floor && p0 <= ceiling && pLast >= floor && pLast <= ceiling) {
      return ((p0 + pLast) / 2) * amount;
    }

    // Band binds somewhere: sum each unit at its clamped price.
    let total = 0;
    for (let n = 0; n < amount; n++) {
      const p = priceAt(n);
      total += p < floor ? floor : p > ceiling ? ceiling : p;
    }
    return total;
  }

  // -- execution ---------------------------------------------------------------

  /**
   * Executes a market order against the station and commits it atomically.
   *
   * Returns the fill receipt; throws `TradeError` with a machine-readable
   * `code` on rejection (`insufficient_credits`, `insufficient_inventory`,
   * `bad_amount`, `unknown_commodity`, `unknown_player`). `reserve_changed`
   * retried up to `retryLimit` times before propagating.
   */
  async executeTrade(
    playerId: string,
    commodity: Commodity,
    amount: number,
    isBuy: boolean,
    db: DatabaseManager = this.db as DatabaseManager,
  ): Promise<MarketTradeResult & { quote: PriceQuote }> {
    this.assertAlive();
    if (db === null || db === undefined) {
      throw new Error('MarketEngine.executeTrade: no DatabaseManager available — call initialize(db) first');
    }
    if (typeof playerId !== 'string' || playerId.length === 0) {
      throw new TradeError('unknown_player', 'playerId is required');
    }
    const resolved = MarketEngine.normalizeCommodity(commodity) ?? commodity;
    if (!COMMODITIES.includes(resolved)) {
      throw new TradeError('unknown_commodity', `not a tradable commodity: "${String(commodity)}"`);
    }
    if (!(amount > 0) || !Number.isFinite(amount)) {
      throw new TradeError('bad_amount', `amount must be a finite number > 0 (got ${String(amount)})`);
    }
    if (amount > MAX_TRADE_AMOUNT) {
      throw new TradeError(
        'bad_amount',
        `order size ${amount} exceeds the per-order cap of ${MAX_TRADE_AMOUNT} kg`,
      );
    }

    let attempts = 0;
    for (;;) {
      attempts++;
      // Always price against the freshest pool we can see.
      await this.syncReserves();
      const quote = this.quoteOrder(resolved, amount, isBuy);

      if (isBuy) {
        const player = await db.getPlayer(playerId);
        if (!player) throw new TradeError('unknown_player', `player "${playerId}" not found`);
        if ((player.credits ?? 0) < quote.totalCredits) {
          throw new TradeError(
            'insufficient_credits',
            `order costs ${quote.totalCredits} credits, balance is ${player.credits}`,
          );
        }
      } else {
        const inventory = await db.getInventory(playerId);
        const held = inventory[resolved] ?? 0;
        if (held < amount) {
          throw new TradeError(
            'insufficient_inventory',
            `selling ${amount} ${resolved} but only ${held} in inventory`,
          );
        }
      }

      try {
        const result = await db.recordTrade({
          tradeId: this.makeId(),
          playerId,
          commodity: resolved,
          amount,
          isBuy,
          totalCredits: quote.totalCredits,
          unitPrice: quote.averagePrice,
          expectedReserve: quote.reserveBefore,
          newReserve: quote.reserveAfter,
          legacyColumn: LEGACY_RESOURCE_COLUMNS[resolved],
        });
        // Commit landed — update the in-memory pool so the next quote is right.
        this.reserves.set(resolved, result.reserveAfter);
        return { ...result, quote };
      } catch (err) {
        if (err instanceof TradeError && err.code === 'reserve_changed' && attempts <= this.retryLimit) {
          continue; // someone repriced the pool; loop re-reads and re-prices
        }
        throw err;
      }
    }
  }

  // -- reporting ---------------------------------------------------------------

  /**
   * Broadcast-ready snapshot: buy prices, sell prices, reserves and base
   * references. Cheap enough to send on JOIN and every market tick.
   */
  getMarketSnapshot(): MarketSnapshot {
    this.assertAlive();
    const prices: Record<string, number> = {};
    const sellPrices: Record<string, number> = {};
    const reserves: Record<string, number> = {};
    const basePrices: Record<string, number> = {};
    for (const commodity of COMMODITIES) {
      const reserve = this.reserveOf(commodity);
      // A marginal buy consumes one unit; a marginal sell supplies one.
      // Unit prices keep 6dp so thin spreads survive the round-trip.
      prices[commodity] = roundPrice(this.spotPrice(commodity, reserve - 1));
      sellPrices[commodity] = roundPrice(this.spotPrice(commodity, reserve + 1));
      reserves[commodity] = reserve;
      basePrices[commodity] = this.basePriceOf(commodity);
    }
    return { prices, reserves, basePrices, sellPrices, timestamp: this.now() };
  }

  /** Station identity used as the virtual counterparty on every fill. */
  get stationId(): string {
    return STATION_ID;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('MarketEngine: engine disposed');
  }
}

export default MarketEngine;
