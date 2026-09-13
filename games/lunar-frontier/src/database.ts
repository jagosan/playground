/**
 * Lunar Frontier — SQLite persistence layer.
 *
 * Promise-wrapped manager around the `sqlite3` driver. Owns schema creation,
 * CRUD for players / factions / claims / resources / infrastructure, and the
 * market transaction log. All methods are async; the underlying driver is
 * callback-based and adapted internally.
 *
 * Usage:
 *   import DatabaseManager from './database';
 *   const db = new DatabaseManager('./lunarfrontier.db');
 *   await db.initialize();
 *   await db.createPlayer({ id: 'p1', username: 'jagosan', faction: 'ESA', credits: 5000, role: 'surveyor' });
 */

import sqlite3 from 'sqlite3';

// ---------------------------------------------------------------------------
// Row / entity types
// ---------------------------------------------------------------------------

export interface PlayerRow {
  id: string;
  username: string;
  faction: string;
  credits: number;
  role: string;
  created_at: string;
}

export interface FactionRow {
  id: string;
  name: string;
  type: string;
  funding_tier: number;
  reputation: number;
}

export interface ClaimRow {
  id: string;
  player_id: string;
  x: number;
  y: number;
  radius: number;
  claim_type: string;
  status: string;
}

export interface ResourceRow {
  player_id: string;
  regolith: number;
  water_ice: number;
  helium3: number;
  rare_earths: number;
}

export interface InfrastructureRow {
  id: string;
  claim_id: string;
  type: string;
  level: number;
  x: number;
  y: number;
  health: number;
}

export interface TransactionRow {
  id: string;
  buyer_id: string;
  seller_id: string;
  item_type: string;
  quantity: number;
  total_credits: number;
  created_at: string;
}

/** Tradable stock held by one player (Phase 8a market ledger). */
export interface InventoryRow {
  player_id: string;
  /** Commodity id, e.g. 'HELIUM3'. */
  commodity: string;
  units: number;
  updated_at: string;
}

/** One commodity's liquidity pool: baseline + current reserve (market state). */
export interface MarketReserveRow {
  commodity: string;
  /** Reserve the pool was seeded with — the bonding-curve denominator. */
  baseline_reserve: number;
  /** Live reserve; may go negative (a bookkeeping net-position signal). */
  reserve: number;
  updated_at: string;
}

/** A laid rail segment between two world-space endpoints (metres). */
export interface RailTrackRow {
  id: string;
  built_by: string;
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  /** Euclidean segment length in metres. */
  length: number;
  /** Track gauge in metres (narrow gauge, spec 12). */
  gauge: number;
  status: string;
  built_at: string;
}

export type RailTrackUpdate = Partial<Omit<RailTrackRow, 'id' | 'built_by'>>;

/** Why `recordTrade` refused a commit. */
export type TradeErrorCode =
  | 'bad_trade'
  | 'bad_amount'
  | 'unknown_commodity'
  | 'unknown_player'
  | 'insufficient_credits'
  | 'insufficient_inventory'
  | 'reserve_changed';

/**
 * Thrown by {@link DatabaseManager.recordTrade}. Exported so callers can
 * branch on `code` (notably `reserve_changed`, the optimistic-concurrency
 * retry signal) without string-matching messages.
 */
export class TradeError extends Error {
  readonly code: TradeErrorCode;
  constructor(code: TradeErrorCode, message: string) {
    super(message);
    this.name = 'TradeError';
    this.code = code;
  }
}

/**
 * Virtual counterparty id for every station-side (AMM) trade. The exchange is
 * not a player, so it deliberately has no `players` row; `recordTrade` moves
 * only the human leg of the credits and never touches a station balance.
 */
export const STATION_ID = 'STATION_EXCHANGE';

/** Everything needed to commit one station trade atomically. */
export interface MarketTradeCommit {
  tradeId: string;
  playerId: string;
  commodity: string;
  amount: number;
  isBuy: boolean;
  /** Total credits for the fill (unit price x amount, rounded). */
  totalCredits: number;
  /** Average unit price actually paid/received, for the receipt. */
  unitPrice: number;
  /** Reserve the pool must still hold for this fill to be valid (CAS). */
  expectedReserve: number;
  /** Reserve after the fill. */
  newReserve: number;
  /** Legacy `resources` column to mirror, when the commodity has one. */
  legacyColumn?: keyof ResourceUpdate;
}

/** Committed fill, echoed back to the trader. */
export interface MarketTradeResult {
  tradeId: string;
  commodity: string;
  amount: number;
  isBuy: boolean;
  unitPrice: number;
  totalCredits: number;
  newBalance: number;
  inventory: number;
  reserveBefore: number;
  reserveAfter: number;
}

/** Payload for `addRailTrack` (built_at/status are filled in automatically). */
export type NewRailTrack = Omit<RailTrackRow, 'built_at' | 'status'> & {
  built_at?: string;
  status?: string;
};

/** Payload for createPlayer (created_at is filled in automatically). */
export type NewPlayer = Omit<PlayerRow, 'created_at'> & { created_at?: string };

/** Payload for a completed market trade (created_at is filled in automatically). */
export type NewTransaction = Omit<TransactionRow, 'created_at'> & { created_at?: string };

/** Partial update bags — only the listed columns may be written. */
export interface PlayerUpdate {
  username?: string;
  faction?: string;
  credits?: number;
  role?: string;
}
export type FactionUpdate = Partial<Omit<FactionRow, 'id'>>;
export type ClaimUpdate = Partial<Omit<ClaimRow, 'id' | 'player_id'>>;
export type ResourceUpdate = Partial<Omit<ResourceRow, 'player_id'>>;
export type InfrastructureUpdate = Partial<Omit<InfrastructureRow, 'id' | 'claim_id'>>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Columns allowed per table, so caller-supplied keys can never become SQL. */
const COLUMNS: Record<string, readonly string[]> = {
  players: ['id', 'username', 'faction', 'credits', 'role', 'created_at'],
  factions: ['id', 'name', 'type', 'funding_tier', 'reputation'],
  claims: ['id', 'player_id', 'x', 'y', 'radius', 'claim_type', 'status'],
  resources: ['player_id', 'regolith', 'water_ice', 'helium3', 'rare_earths'],
  infrastructure: ['id', 'claim_id', 'type', 'level', 'x', 'y', 'health'],
  transactions: ['id', 'buyer_id', 'seller_id', 'item_type', 'quantity', 'total_credits', 'created_at'],
  inventory: ['player_id', 'commodity', 'units', 'updated_at'],
  market_reserves: ['commodity', 'baseline_reserve', 'reserve', 'updated_at'],
  rail_tracks: ['id', 'built_by', 'x0', 'y0', 'z0', 'x1', 'y1', 'z1', 'length', 'gauge', 'status', 'built_at'],
};

/** SQLite comparison operators whitelisted for generic queries. */
const OPERATORS = ['=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'IS', 'IS NOT'] as const;

/** Name prefix for nested-transaction savepoints (see `withTransaction`). */
const SAVEPOINT_NAME = 'lf_tx';
export type Operator = (typeof OPERATORS)[number];

export type QueryCondition = Record<string, { op: Operator; value: unknown } | unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Filters a caller-supplied object down to known columns of a table.
 * Returns the sanitized record and the parallel placeholder list.
 */
function sanitize(table: keyof typeof COLUMNS, record: Record<string, unknown>): {
  cols: string[];
  values: unknown[];
} {
  const allowed = COLUMNS[table];
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`DatabaseManager: unknown column "${key}" for table "${table}"`);
    }
    if (value === undefined) continue;
    cols.push(key);
    values.push(value);
  }
  if (cols.length === 0) {
    throw new Error(`DatabaseManager: no columns supplied for table "${table}"`);
  }
  return { cols, values };
}

/** Builds `col op ?` clauses from a generic condition bag (keys validated). */
function buildWhere(table: keyof typeof COLUMNS, conditions: QueryCondition | undefined): {
  clause: string;
  params: unknown[];
} {
  if (!conditions || Object.keys(conditions).length === 0) {
    return { clause: '', params: [] };
  }
  const allowed = COLUMNS[table];
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [key, spec] of Object.entries(conditions)) {
    if (!allowed.includes(key)) {
      throw new Error(`DatabaseManager: unknown column "${key}" in query on "${table}"`);
    }
    if (spec !== null && typeof spec === 'object' && 'op' in (spec as object)) {
      const { op, value } = spec as { op: Operator; value: unknown };
      if (!OPERATORS.includes(op)) {
        throw new Error(`DatabaseManager: unsupported operator "${op}"`);
      }
      parts.push(`${key} ${op} ?`);
      params.push(value);
    } else {
      parts.push(`${key} = ?`);
      params.push(spec);
    }
  }
  return { clause: ` WHERE ${parts.join(' AND ')}`, params };
}

// ---------------------------------------------------------------------------
// DatabaseManager
// ---------------------------------------------------------------------------

export class DatabaseManager {
  private db: sqlite3.Database | null = null;
  private readonly path: string;
  private initialized = false;
  /** Nesting depth of {@link withTransaction}; 0 when no frame is open. */
  private txDepth = 0;

  constructor(dbPath: string = './lunarfrontier.db') {
    this.path = dbPath;
  }

  // -- lifecycle ------------------------------------------------------------

  /** Opens the database, applies pragmas, and creates tables + indexes. Idempotent. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const handle = new sqlite3.Database(this.path, (err) => {
        if (err) reject(new Error(`DatabaseManager: failed to open "${this.path}": ${err.message}`));
        else resolve(handle);
      });
    });

    try {
      await this.exec('PRAGMA foreign_keys = ON;');
      await this.exec('PRAGMA journal_mode = WAL;');
      await this.exec('PRAGMA busy_timeout = 5000;');

      await this.exec(`
        CREATE TABLE IF NOT EXISTS players (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE,
          faction TEXT,
          credits REAL,
          role TEXT,
          created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS factions (
          id TEXT PRIMARY KEY,
          name TEXT,
          type TEXT,
          funding_tier INTEGER,
          reputation REAL
        );

        CREATE TABLE IF NOT EXISTS claims (
          id TEXT PRIMARY KEY,
          player_id TEXT,
          x REAL,
          y REAL,
          radius REAL,
          claim_type TEXT,
          status TEXT
        );

        CREATE TABLE IF NOT EXISTS resources (
          player_id TEXT PRIMARY KEY,
          regolith REAL,
          water_ice REAL,
          helium3 REAL,
          rare_earths REAL
        );

        CREATE TABLE IF NOT EXISTS infrastructure (
          id TEXT PRIMARY KEY,
          claim_id TEXT,
          type TEXT,
          level INTEGER,
          x REAL,
          y REAL,
          health REAL
        );

        CREATE TABLE IF NOT EXISTS transactions (
          id TEXT PRIMARY KEY,
          buyer_id TEXT,
          seller_id TEXT,
          item_type TEXT,
          quantity REAL,
          total_credits REAL,
          created_at TEXT
        );

        /* Phase 8a — tradable stock per player (commodities have no column in
           the legacy fixed-column resources ledger). */
        CREATE TABLE IF NOT EXISTS inventory (
          player_id TEXT NOT NULL,
          commodity TEXT NOT NULL,
          units REAL NOT NULL DEFAULT 0,
          updated_at TEXT,
          PRIMARY KEY (player_id, commodity)
        );

        /* Phase 8a — one liquidity pool per commodity (market state). */
        CREATE TABLE IF NOT EXISTS market_reserves (
          commodity TEXT PRIMARY KEY,
          baseline_reserve REAL NOT NULL,
          reserve REAL NOT NULL,
          updated_at TEXT
        );

        /* Phase 8a — player-laid rail segments between two world points. */
        CREATE TABLE IF NOT EXISTS rail_tracks (
          id TEXT PRIMARY KEY,
          built_by TEXT,
          x0 REAL, y0 REAL, z0 REAL,
          x1 REAL, y1 REAL, z1 REAL,
          length REAL,
          gauge REAL,
          status TEXT,
          built_at TEXT
        );
      `);

      // Hot paths: per-player lookups, ownership joins, market history.
      await this.exec(`
        CREATE INDEX IF NOT EXISTS idx_claims_player ON claims (player_id);
        CREATE INDEX IF NOT EXISTS idx_infra_claim ON infrastructure (claim_id);
        CREATE INDEX IF NOT EXISTS idx_tx_buyer ON transactions (buyer_id);
        CREATE INDEX IF NOT EXISTS idx_tx_seller ON transactions (seller_id);
        CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions (created_at);
        CREATE INDEX IF NOT EXISTS idx_inventory_player ON inventory (player_id);
        CREATE INDEX IF NOT EXISTS idx_rail_built_by ON rail_tracks (built_by);
        CREATE INDEX IF NOT EXISTS idx_rail_status ON rail_tracks (status);
      `);

      this.initialized = true;
    } catch (err) {
      // Never leak a half-open handle if setup fails.
      await new Promise<void>((resolve) => {
        this.db?.close(() => resolve());
      });
      this.db = null;
      this.initialized = false;
      throw err;
    }
  }

  /** Closes the underlying handle. Safe to call more than once. */
  async close(): Promise<void> {
    if (!this.db) return;
    const handle = this.db;
    this.db = null;
    this.initialized = false;
    await new Promise<void>((resolve, reject) => {
      handle.close((err) => (err ? reject(err) : resolve()));
    });
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  // -- generic low-level access ---------------------------------------------

  /** Runs one or more statements with no result rows (DDL / multi-statement). */
  async exec(sql: string): Promise<void> {
    const db = this.requireDb();
    return new Promise((resolve, reject) => {
      db.exec(sql, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Runs a statement with bound params; resolves with lastID / changes. */
  async run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
    const db = this.requireDb();
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (this: sqlite3.RunResult, err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  /** Fetches a single row (or undefined). */
  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const db = this.requireDb();
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T | undefined)));
    });
  }

  /** Fetches all rows. */
  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = this.requireDb();
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve((rows ?? []) as T[])));
    });
  }

  /**
   * Runs `fn` inside a transaction with rollback on any throw.
   *
   * Re-entrancy safe: every public helper below opens its own transaction, so
   * composing them (e.g. `recordTrade` → `adjustInventory` → `getPlayer`) used
   * to die with `cannot start a transaction within a transaction`. Nested calls
   * now ride SAVEPOINTs, and only the outermost frame issues the real
   * BEGIN/COMMIT/ROLLBACK — so an inner failure still unwinds the whole unit
   * of work, which is exactly the all-or-nothing semantics a trade needs.
   */
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const db = this.requireDb();
    const depth = ++this.txDepth;
    if (depth === 1) await this.exec('BEGIN IMMEDIATE');
    else await this.exec(`SAVEPOINT ${SAVEPOINT_NAME}_${depth}`);
    try {
      const result = await fn();
      if (depth === 1) await this.exec('COMMIT');
      else await this.exec(`RELEASE ${SAVEPOINT_NAME}_${depth}`);
      return result;
    } catch (err) {
      // Unwind to this frame's mark. At depth 1 that is a full ROLLBACK; if the
      // unwind itself fails we surface the ORIGINAL error, never the cleanup
      // one. A COMMIT that threw (e.g. SQLITE_BUSY) may already have ended the
      // transaction, leaving this ROLLBACK a harmless no-op error.
      await new Promise<void>((resolve) => {
        const sql = depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${SAVEPOINT_NAME}_${depth}`;
        db.run(sql, () => resolve());
      });
      if (depth > 1) {
        await new Promise<void>((resolve) => {
          db.run(`RELEASE ${SAVEPOINT_NAME}_${depth}`, () => resolve());
        });
      }
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  /** True while a transaction frame owned by this manager is open. */
  inTransaction(): boolean {
    return this.txDepth > 0;
  }

  // -- players ----------------------------------------------------------------

  async createPlayer(player: NewPlayer): Promise<PlayerRow> {
    const row: PlayerRow = {
      id: player.id,
      username: player.username,
      faction: player.faction,
      credits: player.credits,
      role: player.role,
      created_at: player.created_at ?? nowIso(),
    };
    await this.run(
      `INSERT INTO players (id, username, faction, credits, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.username, row.faction, row.credits, row.role, row.created_at],
    );
    return row;
  }

  getPlayer(id: string): Promise<PlayerRow | undefined> {
    return this.get<PlayerRow>('SELECT * FROM players WHERE id = ?', [id]);
  }

  getPlayerByUsername(username: string): Promise<PlayerRow | undefined> {
    return this.get<PlayerRow>('SELECT * FROM players WHERE username = ?', [username]);
  }

  listPlayers(limit = 1000, offset = 0): Promise<PlayerRow[]> {
    return this.all<PlayerRow>('SELECT * FROM players ORDER BY created_at LIMIT ? OFFSET ?', [limit, offset]);
  }

  async updatePlayer(id: string, updates: PlayerUpdate): Promise<number> {
    const { cols, values } = sanitize('players', updates as Record<string, unknown>);
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    const { changes } = await this.run(
      `UPDATE players SET ${setClause} WHERE id = ?`,
      [...values, id],
    );
    return changes;
  }

  /** Atomic credit delta (negative = spend). Returns the new balance, or null if the player is missing or would go negative. */
  adjustCredits(playerId: string, delta: number): Promise<number | null> {
    return this.withTransaction(async () => {
      const player = await this.getPlayer(playerId);
      if (!player) return null;
      const balance = (player.credits ?? 0) + delta;
      if (balance < 0) return null;
      await this.run('UPDATE players SET credits = ? WHERE id = ?', [balance, playerId]);
      return balance;
    });
  }

  async deletePlayer(id: string): Promise<number> {
    return this.withTransaction(async () => {
      const { changes: infra } = await this.run(
        `DELETE FROM infrastructure WHERE claim_id IN (SELECT id FROM claims WHERE player_id = ?)`,
        [id],
      );
      void infra;
      await this.run('DELETE FROM claims WHERE player_id = ?', [id]);
      await this.run('DELETE FROM resources WHERE player_id = ?', [id]);
      await this.run('DELETE FROM inventory WHERE player_id = ?', [id]);
      await this.run('DELETE FROM rail_tracks WHERE built_by = ?', [id]);
      await this.run('DELETE FROM transactions WHERE buyer_id = ? OR seller_id = ?', [id, id]);
      const { changes } = await this.run('DELETE FROM players WHERE id = ?', [id]);
      return changes;
    });
  }

  // -- factions ---------------------------------------------------------------

  async createFaction(faction: FactionRow): Promise<FactionRow> {
    await this.run(
      `INSERT INTO factions (id, name, type, funding_tier, reputation)
       VALUES (?, ?, ?, ?, ?)`,
      [faction.id, faction.name, faction.type, faction.funding_tier, faction.reputation],
    );
    return faction;
  }

  getFaction(id: string): Promise<FactionRow | undefined> {
    return this.get<FactionRow>('SELECT * FROM factions WHERE id = ?', [id]);
  }

  listFactions(): Promise<FactionRow[]> {
    return this.all<FactionRow>('SELECT * FROM factions ORDER BY reputation DESC');
  }

  async updateFaction(id: string, updates: FactionUpdate): Promise<number> {
    const { cols, values } = sanitize('factions', updates as Record<string, unknown>);
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    const { changes } = await this.run(`UPDATE factions SET ${setClause} WHERE id = ?`, [...values, id]);
    return changes;
  }

  async deleteFaction(id: string): Promise<number> {
    const { changes } = await this.run('DELETE FROM factions WHERE id = ?', [id]);
    return changes;
  }

  // -- claims -------------------------------------------------------------------

  async createClaim(claim: ClaimRow): Promise<ClaimRow> {
    await this.run(
      `INSERT INTO claims (id, player_id, x, y, radius, claim_type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [claim.id, claim.player_id, claim.x, claim.y, claim.radius, claim.claim_type, claim.status],
    );
    return claim;
  }

  getClaim(id: string): Promise<ClaimRow | undefined> {
    return this.get<ClaimRow>('SELECT * FROM claims WHERE id = ?', [id]);
  }

  listClaimsByPlayer(playerId: string): Promise<ClaimRow[]> {
    return this.all<ClaimRow>('SELECT * FROM claims WHERE player_id = ?', [playerId]);
  }

  listClaims(status?: string): Promise<ClaimRow[]> {
    return status
      ? this.all<ClaimRow>('SELECT * FROM claims WHERE status = ? ORDER BY x, y', [status])
      : this.all<ClaimRow>('SELECT * FROM claims ORDER BY x, y');
  }

  /**
   * Claims whose circular area contains (px, py). Radius-only overlap check —
   * good enough for the 20 Hz simulation tick without spatial indexing.
   */
  claimsContaining(px: number, py: number): Promise<ClaimRow[]> {
    return this.all<ClaimRow>(
      `SELECT * FROM claims
       WHERE (x - ?) * (x - ?) + (y - ?) * (y - ?) <= radius * radius
       ORDER BY radius ASC`,
      [px, px, py, py],
    );
  }

  async updateClaim(id: string, updates: ClaimUpdate): Promise<number> {
    const { cols, values } = sanitize('claims', updates as Record<string, unknown>);
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    const { changes } = await this.run(`UPDATE claims SET ${setClause} WHERE id = ?`, [...values, id]);
    return changes;
  }

  async transferClaim(claimId: string, newOwnerId: string): Promise<number> {
    const { changes } = await this.run('UPDATE claims SET player_id = ? WHERE id = ?', [newOwnerId, claimId]);
    return changes;
  }

  async deleteClaim(id: string): Promise<number> {
    return this.withTransaction(async () => {
      await this.run('DELETE FROM infrastructure WHERE claim_id = ?', [id]);
      const { changes } = await this.run('DELETE FROM claims WHERE id = ?', [id]);
      return changes;
    });
  }

  // -- resources (1:1 with player) ----------------------------------------------

  /** Upserts the resource ledger for a player; missing fields default to 0. */
  async setResources(playerId: string, resources: Partial<ResourceRow>): Promise<void> {
    const row: ResourceRow = {
      player_id: playerId,
      regolith: resources.regolith ?? 0,
      water_ice: resources.water_ice ?? 0,
      helium3: resources.helium3 ?? 0,
      rare_earths: resources.rare_earths ?? 0,
    };
    await this.run(
      `INSERT INTO resources (player_id, regolith, water_ice, helium3, rare_earths)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         regolith = excluded.regolith,
         water_ice = excluded.water_ice,
         helium3 = excluded.helium3,
         rare_earths = excluded.rare_earths`,
      [row.player_id, row.regolith, row.water_ice, row.helium3, row.rare_earths],
    );
  }

  getResources(playerId: string): Promise<ResourceRow | undefined> {
    return this.get<ResourceRow>('SELECT * FROM resources WHERE player_id = ?', [playerId]);
  }

  listResources(): Promise<ResourceRow[]> {
    return this.all<ResourceRow>('SELECT * FROM resources');
  }

  /**
   * Atomic per-player resource deltas (negatives allowed, clamped at 0).
   * Creates the ledger row on first use.
   *
   * `opts.requireNonNegative` makes a shortfall a hard rejection instead of a
   * silent clamp — used by anything spending physical stock, so a lost race
   * can never mint resources out of thin air.
   */
  async adjustResources(
    playerId: string,
    deltas: ResourceUpdate,
    opts: { requireNonNegative?: boolean } = {},
  ): Promise<ResourceRow | null> {
    const allowed: (keyof ResourceUpdate)[] = ['regolith', 'water_ice', 'helium3', 'rare_earths'];
    for (const key of Object.keys(deltas)) {
      if (!allowed.includes(key as keyof ResourceUpdate)) {
        throw new Error(`DatabaseManager: unknown resource field "${key}"`);
      }
    }
    return this.withTransaction(async () => {
      const current =
        (await this.getResources(playerId)) ?? {
          player_id: playerId,
          regolith: 0,
          water_ice: 0,
          helium3: 0,
          rare_earths: 0,
        };
      const next: ResourceRow = {
        player_id: playerId,
        regolith: current.regolith + (deltas.regolith ?? 0),
        water_ice: current.water_ice + (deltas.water_ice ?? 0),
        helium3: current.helium3 + (deltas.helium3 ?? 0),
        rare_earths: current.rare_earths + (deltas.rare_earths ?? 0),
      };
      if (opts.requireNonNegative) {
        for (const key of allowed) {
          if (next[key] < 0) {
            throw new TradeError(
              'insufficient_inventory',
              `DatabaseManager: player "${playerId}" has insufficient ${key} (${current[key]} < ${-(deltas[key] ?? 0)})`,
            );
          }
        }
      }
      for (const key of allowed) next[key] = Math.max(0, next[key]);
      await this.run(
        `INSERT INTO resources (player_id, regolith, water_ice, helium3, rare_earths)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
           regolith = excluded.regolith,
           water_ice = excluded.water_ice,
           helium3 = excluded.helium3,
           rare_earths = excluded.rare_earths`,
        [next.player_id, next.regolith, next.water_ice, next.helium3, next.rare_earths],
      );
      return next;
    });
  }

  /**
   * Atomic "extraction credit": pays `credits`, grants `deltas` to the legacy
   * resource ledger, and (when `inventory` is supplied) credits the tradable
   * wallet — all in one transaction, so a haul is always both physical stock
   * and sellable stock, never one without the other.
   *
   * Currency guard: both ledgers are physical holdings, so this entry point
   * accepts GAINS only. Every SPEND must go through `adjustResources` /
   * `adjustInventory` with `requireNonNegative`, otherwise a concurrent spend
   * and a concurrent gain could each read the same pre-image and silently lose
   * one update.
   */
  creditExtraction(
    playerId: string,
    deltas: ResourceUpdate,
    credits: number,
    inventory: Record<string, number> = {},
  ): Promise<ResourceRow | null> {
    for (const [key, value] of Object.entries(deltas)) {
      if ((value as number) < 0) {
        throw new Error(`DatabaseManager: creditExtraction accepts gains only (bad delta ${key}=${value})`);
      }
    }
    for (const [commodity, units] of Object.entries(inventory)) {
      if (!(units >= 0)) {
        throw new Error(`DatabaseManager: creditExtraction accepts gains only (bad inventory ${commodity}=${units})`);
      }
    }
    if (credits < 0) throw new Error('DatabaseManager: creditExtraction accepts a non-negative credit amount');
    return this.withTransaction(async () => {
      const player = await this.getPlayer(playerId);
      if (!player) return null;
      const granted = await this.adjustResources(playerId, deltas);
      for (const [commodity, units] of Object.entries(inventory)) {
        await this.applyInventoryDelta(playerId, commodity, units, {});
      }
      await this.run('UPDATE players SET credits = credits + ? WHERE id = ?', [credits, playerId]);
      return granted;
    });
  }


  // -- infrastructure --------------------------------------------------------------

  async createInfrastructure(item: InfrastructureRow): Promise<InfrastructureRow> {
    await this.run(
      `INSERT INTO infrastructure (id, claim_id, type, level, x, y, health)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [item.id, item.claim_id, item.type, item.level, item.x, item.y, item.health],
    );
    return item;
  }

  getInfrastructure(id: string): Promise<InfrastructureRow | undefined> {
    return this.get<InfrastructureRow>('SELECT * FROM infrastructure WHERE id = ?', [id]);
  }

  listInfrastructureByClaim(claimId: string): Promise<InfrastructureRow[]> {
    return this.all<InfrastructureRow>('SELECT * FROM infrastructure WHERE claim_id = ?', [claimId]);
  }

  listInfrastructure(type?: string): Promise<InfrastructureRow[]> {
    return type
      ? this.all<InfrastructureRow>('SELECT * FROM infrastructure WHERE type = ? ORDER BY x, y', [type])
      : this.all<InfrastructureRow>('SELECT * FROM infrastructure ORDER BY x, y');
  }

  async updateInfrastructure(id: string, updates: InfrastructureUpdate): Promise<number> {
    const { cols, values } = sanitize('infrastructure', updates as Record<string, unknown>);
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    const { changes } = await this.run(`UPDATE infrastructure SET ${setClause} WHERE id = ?`, [...values, id]);
    return changes;
  }

  /** Damage / repair that can never push health below 0 or above 100. */
  damageInfrastructure(id: string, amount: number): Promise<number | null> {
    return this.get<{ health: number }>('SELECT health FROM infrastructure WHERE id = ?', [id]).then(
      async (row) => {
        if (!row) return null;
        const health = Math.min(100, Math.max(0, row.health + amount));
        await this.run('UPDATE infrastructure SET health = ? WHERE id = ?', [health, id]);
        return health;
      },
    );
  }

  async deleteInfrastructure(id: string): Promise<number> {
    const { changes } = await this.run('DELETE FROM infrastructure WHERE id = ?', [id]);
    return changes;
  }

  // -- transactions / market ---------------------------------------------------------

  /**
   * Records a market trade atomically: debits buyer, credits seller (both
   * checked against overdraft), then inserts the ledger row.
   * Throws on insufficient funds or unknown parties.
   */
  async recordTransaction(tx: NewTransaction): Promise<TransactionRow> {
    const row: TransactionRow = {
      id: tx.id,
      buyer_id: tx.buyer_id,
      seller_id: tx.seller_id,
      item_type: tx.item_type,
      quantity: tx.quantity,
      total_credits: tx.total_credits,
      created_at: tx.created_at ?? nowIso(),
    };
    return this.withTransaction(async () => {
      const buyer = await this.getPlayer(row.buyer_id);
      const seller = await this.getPlayer(row.seller_id);
      if (!buyer) throw new Error(`DatabaseManager: buyer "${row.buyer_id}" not found`);
      if (!seller) throw new Error(`DatabaseManager: seller "${row.seller_id}" not found`);
      if (row.total_credits < 0) throw new Error('DatabaseManager: transaction total must be >= 0');
      if ((buyer.credits ?? 0) < row.total_credits) {
        throw new Error(
          `DatabaseManager: buyer "${row.buyer_id}" has insufficient credits (${buyer.credits} < ${row.total_credits})`,
        );
      }
      await this.run('UPDATE players SET credits = credits - ? WHERE id = ?', [row.total_credits, row.buyer_id]);
      await this.run('UPDATE players SET credits = credits + ? WHERE id = ?', [row.total_credits, row.seller_id]);
      await this.run(
        `INSERT INTO transactions (id, buyer_id, seller_id, item_type, quantity, total_credits, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.buyer_id, row.seller_id, row.item_type, row.quantity, row.total_credits, row.created_at],
      );
      return row;
    });
  }

  getTransaction(id: string): Promise<TransactionRow | undefined> {
    return this.get<TransactionRow>('SELECT * FROM transactions WHERE id = ?', [id]);
  }

  listTransactions(limit = 100, offset = 0): Promise<TransactionRow[]> {
    return this.all<TransactionRow>(
      'SELECT * FROM transactions ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset],
    );
  }

  /** Trade history for a player in either direction, newest first. */
  listTransactionsForPlayer(playerId: string, limit = 100, offset = 0): Promise<TransactionRow[]> {
    return this.all<TransactionRow>(
      `SELECT * FROM transactions WHERE buyer_id = ? OR seller_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [playerId, playerId, limit, offset],
    );
  }

  /** Aggregate market stats, optionally scoped to a single item_type. */
  marketStats(itemType?: string): Promise<{ item_type: string; trades: number; volume: number; avg_price: number }[]> {
    return itemType
      ? this.all(
          `SELECT item_type,
                  COUNT(*) AS trades,
                  COALESCE(SUM(total_credits), 0) AS volume,
                  COALESCE(AVG(total_credits), 0) AS avg_price
           FROM transactions WHERE item_type = ? GROUP BY item_type`,
          [itemType],
        )
      : this.all(
          `SELECT item_type,
                  COUNT(*) AS trades,
                  COALESCE(SUM(total_credits), 0) AS volume,
                  COALESCE(AVG(total_credits), 0) AS avg_price
           FROM transactions GROUP BY item_type ORDER BY volume DESC`,
        );
  }

  // -- market: reserves / inventory / atomic trades -----------------------------------

  /** Idempotently seed liquidity pools. Existing commodities are untouched. */
  async seedMarketReserves(
    seeds: ReadonlyArray<{ commodity: string; baseline: number }>,
  ): Promise<void> {
    const ts = nowIso();
    await this.withTransaction(async () => {
      for (const seed of seeds) {
        if (!Number.isFinite(seed.baseline) || seed.baseline <= 0) {
          throw new TradeError('bad_trade', `baseline reserve for "${seed.commodity}" must be > 0`);
        }
        await this.run(
          `INSERT INTO market_reserves (commodity, baseline_reserve, reserve, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(commodity) DO NOTHING`,
          [seed.commodity, seed.baseline, seed.baseline, ts],
        );
      }
    });
  }

  /** All liquidity pools (baseline + live reserve), ordered by commodity. */
  listMarketReserves(): Promise<MarketReserveRow[]> {
    return this.all<MarketReserveRow>('SELECT * FROM market_reserves ORDER BY commodity');
  }

  getMarketReserve(commodity: string): Promise<MarketReserveRow | undefined> {
    return this.get<MarketReserveRow>('SELECT * FROM market_reserves WHERE commodity = ?', [commodity]);
  }

  /** Tradable stock per commodity for one player (missing rows mean zero). */
  async getInventory(playerId: string): Promise<Record<string, number>> {
    const rows = await this.all<InventoryRow>(
      'SELECT * FROM inventory WHERE player_id = ? AND units > 0 ORDER BY commodity',
      [playerId],
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[row.commodity] = row.units;
    return out;
  }

  /**
   * One-time, idempotent migration: mirrors pre-market holdings from the legacy
   * fixed-column `resources` ledger into `inventory` for commodities that have a
   * legacy column. Only creates rows that do not exist yet, so it can never
   * double-count — and without it, ore mined before the market tables landed
   * would be permanently unsellable.
   *
   * `mapping` maps commodity id -> legacy column. Returns units backfilled.
   */
  async backfillInventoryFromResources(
    mapping: Record<string, keyof ResourceUpdate>,
  ): Promise<Record<string, number>> {
    const backfilled: Record<string, number> = {};
    const ts = nowIso();
    await this.withTransaction(async () => {
      const rows = await this.all<ResourceRow>('SELECT * FROM resources');
      for (const [commodity, column] of Object.entries(mapping)) {
        let total = 0;
        for (const row of rows) {
          const units = row[column] ?? 0;
          if (!(units > 0)) continue;
          const inserted = await this.run(
            `INSERT INTO inventory (player_id, commodity, units, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(player_id, commodity) DO NOTHING`,
            [row.player_id, commodity, units, ts],
          );
          if (inserted.changes === 1) total += units;
        }
        backfilled[commodity] = total;
      }
    });
    return backfilled;
  }

  /** Atomic per-commodity stock delta (creates the row; clamped at 0). */
  async adjustInventory(
    playerId: string,
    commodity: string,
    delta: number,
    opts: { requireNonNegative?: boolean } = {},
  ): Promise<number> {
    return this.withTransaction(async () => this.applyInventoryDelta(playerId, commodity, delta, opts));
  }

  /** Bare delta writer — call ONLY inside an open withTransaction frame. */
  private async applyInventoryDelta(
    playerId: string,
    commodity: string,
    delta: number,
    opts: { requireNonNegative?: boolean },
  ): Promise<number> {
    const current = await this.get<InventoryRow>(
      'SELECT * FROM inventory WHERE player_id = ? AND commodity = ?',
      [playerId, commodity],
    );
    const next = (current?.units ?? 0) + delta;
    if (opts.requireNonNegative && next < 0) {
      throw new TradeError(
        'insufficient_inventory',
        `DatabaseManager: player "${playerId}" holds ${current?.units ?? 0} ${commodity}, needs ${delta}`,
      );
    }
    const clamped = Math.max(0, next);
    await this.run(
      `INSERT INTO inventory (player_id, commodity, units, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id, commodity) DO UPDATE SET
         units = excluded.units,
         updated_at = excluded.updated_at`,
      [playerId, commodity, clamped, nowIso()],
    );
    return clamped;
  }

  /**
   * The single atomic unit of a market trade, mirroring `recordTransaction`
   * for station-side (AMM) counterparties. In one transaction:
   *
   *  1. validates the player, balance (buy) and stock (sell);
   *  2. CAS-updates the liquidity pool: the write only lands if `reserve`
   *     still equals `expectedReserve` — a lost race throws `reserve_changed`
   *     so the caller can reprice, never fill at a stale curve;
   *  3. moves credits, inventory, and (when the commodity maps to a legacy
   *     `resources` column) the physical ledger together;
   *  4. appends the immutable `transactions` row.
   *
   * The station ("STATION_EXCHANGE") is a virtual counterparty: it needs no
   * players row and its own balance is not tracked here.
   */
  async recordTrade(trade: MarketTradeCommit): Promise<MarketTradeResult> {
    const {
      tradeId, playerId, commodity, amount, isBuy,
      totalCredits, unitPrice, expectedReserve, newReserve, legacyColumn,
    } = trade;
    if (!Number.isFinite(amount) || amount <= 0) throw new TradeError('bad_amount', 'trade amount must be > 0');
    if (!Number.isFinite(totalCredits) || totalCredits < 0) {
      throw new TradeError('bad_trade', 'trade total must be >= 0');
    }
    const ts = nowIso();
    return this.withTransaction(async () => {
      const player = await this.getPlayer(playerId);
      if (!player) throw new TradeError('unknown_player', `player "${playerId}" not found`);
      if (isBuy && (player.credits ?? 0) < totalCredits) {
        throw new TradeError(
          'insufficient_credits',
          `balance ${player.credits} < trade total ${totalCredits}`,
        );
      }

      // CAS on the pool: stale repricers lose and retry against fresh state.
      const pool = await this.run(
        'UPDATE market_reserves SET reserve = ?, updated_at = ? WHERE commodity = ? AND reserve = ?',
        [newReserve, ts, commodity, expectedReserve],
      );
      if (pool.changes !== 1) {
        throw new TradeError(
          'reserve_changed',
          `liquidity pool "${commodity}" moved under this trade (expected reserve ${expectedReserve})`,
        );
      }

      // Credits: buy debits the player, sell credits them (station is virtual).
      const balanceRow = isBuy
        ? await this.run('UPDATE players SET credits = credits - ? WHERE id = ? AND credits >= ?', [totalCredits, playerId, totalCredits])
        : await this.run('UPDATE players SET credits = credits + ? WHERE id = ?', [totalCredits, playerId]);
      if (isBuy && balanceRow.changes !== 1) {
        throw new TradeError('insufficient_credits', `could not debit ${totalCredits} from "${playerId}"`);
      }
      const newBalance = isBuy ? (player.credits ?? 0) - totalCredits : (player.credits ?? 0) + totalCredits;

      // Tradable wallet, then the physical mirror where one exists.
      const inventory = await this.applyInventoryDelta(playerId, commodity, isBuy ? amount : -amount, {
        requireNonNegative: true,
      });
      if (legacyColumn !== undefined) {
        await this.adjustResources(playerId, { [legacyColumn]: isBuy ? amount : -amount }, {
          requireNonNegative: true,
        });
      }

      await this.run(
        `INSERT INTO transactions (id, buyer_id, seller_id, item_type, quantity, total_credits, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          tradeId,
          isBuy ? playerId : STATION_ID,
          isBuy ? STATION_ID : playerId,
          commodity,
          amount,
          totalCredits,
          ts,
        ],
      );

      return {
        tradeId,
        commodity,
        amount,
        isBuy,
        unitPrice,
        totalCredits,
        newBalance,
        inventory,
        reserveBefore: expectedReserve,
        reserveAfter: newReserve,
      };
    });
  }

  // -- rail tracks ------------------------------------------------------------------------

  async addRailTrack(track: NewRailTrack): Promise<RailTrackRow> {
    const row: RailTrackRow = {
      id: track.id,
      built_by: track.built_by,
      x0: track.x0, y0: track.y0, z0: track.z0,
      x1: track.x1, y1: track.y1, z1: track.z1,
      length: track.length,
      gauge: track.gauge,
      status: track.status ?? 'active',
      built_at: track.built_at ?? nowIso(),
    };
    await this.run(
      `INSERT INTO rail_tracks (id, built_by, x0, y0, z0, x1, y1, z1, length, gauge, status, built_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.built_by, row.x0, row.y0, row.z0, row.x1, row.y1, row.z1, row.length, row.gauge, row.status, row.built_at],
    );
    return row;
  }

  getRailTrack(id: string): Promise<RailTrackRow | undefined> {
    return this.get<RailTrackRow>('SELECT * FROM rail_tracks WHERE id = ?', [id]);
  }

  listRailTracks(status?: string): Promise<RailTrackRow[]> {
    return status
      ? this.all<RailTrackRow>('SELECT * FROM rail_tracks WHERE status = ? ORDER BY built_at', [status])
      : this.all<RailTrackRow>('SELECT * FROM rail_tracks ORDER BY built_at');
  }

  async updateRailTrack(id: string, updates: RailTrackUpdate): Promise<number> {
    const { cols, values } = sanitize('rail_tracks', updates as Record<string, unknown>);
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    const { changes } = await this.run(`UPDATE rail_tracks SET ${setClause} WHERE id = ?`, [...values, id]);
    return changes;
  }

  async deleteRailTrack(id: string): Promise<number> {
    const { changes } = await this.run('DELETE FROM rail_tracks WHERE id = ?', [id]);
    return changes;
  }

  // -- generic query / delete ----------------------------------------------------------

  /** Small typed query helper: `query('claims', { status: 'active', radius: { op: '>=', value: 10 } })` */
  async query<T = Record<string, unknown>>(table: keyof typeof COLUMNS, conditions: QueryCondition = {}, limit = 1000): Promise<T[]> {
    const { clause, params } = buildWhere(table, conditions);
    return this.all<T>(`SELECT * FROM ${table}${clause} LIMIT ?`, [...params, limit]);
  }

  /** Generic delete with the same condition grammar as query(). */
  async deleteWhere(table: keyof typeof COLUMNS, conditions: QueryCondition): Promise<number> {
    const { clause, params } = buildWhere(table, conditions);
    if (!clause) throw new Error('DatabaseManager: refusing to delete every row; supply conditions');
    const { changes } = await this.run(`DELETE FROM ${table}${clause}`, params);
    return changes;
  }

  /** Row count for a table, optionally filtered. */
  async count(table: keyof typeof COLUMNS, conditions: QueryCondition = {}): Promise<number> {
    const { clause, params } = buildWhere(table, conditions);
    const row = await this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}${clause}`, params);
    return row?.n ?? 0;
  }

  // -- housekeeping ----------------------------------------------------------------------

  /** Drops every table (destructive — tests and local resets only). */
  async reset(): Promise<void> {
    await this.withTransaction(async () => {
      await this.exec(`
        DROP TABLE IF EXISTS transactions;
        DROP TABLE IF EXISTS rail_tracks;
        DROP TABLE IF EXISTS inventory;
        DROP TABLE IF EXISTS market_reserves;
        DROP TABLE IF EXISTS infrastructure;
        DROP TABLE IF EXISTS claims;
        DROP TABLE IF EXISTS resources;
        DROP TABLE IF EXISTS factions;
        DROP TABLE IF EXISTS players;
      `);
    });
    this.initialized = false;
  }

  /** Full snapshot of every table, for save-game dumps / debugging. */
  async snapshot(): Promise<Record<string, unknown[]>> {
    const tables = Object.keys(COLUMNS) as (keyof typeof COLUMNS)[];
    const out: Record<string, unknown[]> = {};
    for (const table of tables) {
      out[table] = await this.all(`SELECT * FROM ${table}`);
    }
    return out;
  }

  // -- internals ---------------------------------------------------------------------------

  private requireDb(): sqlite3.Database {
    if (!this.db) {
      throw new Error('DatabaseManager: database not open — call initialize() first');
    }
    return this.db;
  }
}

export default DatabaseManager;
