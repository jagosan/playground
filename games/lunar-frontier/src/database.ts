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
};

/** SQLite comparison operators whitelisted for generic queries. */
const OPERATORS = ['=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'IS', 'IS NOT'] as const;
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
      `);

      // Hot paths: per-player lookups, ownership joins, market history.
      await this.exec(`
        CREATE INDEX IF NOT EXISTS idx_claims_player ON claims (player_id);
        CREATE INDEX IF NOT EXISTS idx_infra_claim ON infrastructure (claim_id);
        CREATE INDEX IF NOT EXISTS idx_tx_buyer ON transactions (buyer_id);
        CREATE INDEX IF NOT EXISTS idx_tx_seller ON transactions (seller_id);
        CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions (created_at);
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

  /** Runs `fn` inside BEGIN/COMMIT with a rollback on any throw. */
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const db = this.requireDb();
    await this.exec('BEGIN');
    try {
      const result = await fn();
      await this.exec('COMMIT');
      return result;
    } catch (err) {
      await new Promise<void>((resolve) => db.run('ROLLBACK', () => resolve()));
      throw err;
    }
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
   */
  async adjustResources(playerId: string, deltas: ResourceUpdate): Promise<ResourceRow | null> {
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
        regolith: Math.max(0, current.regolith + (deltas.regolith ?? 0)),
        water_ice: Math.max(0, current.water_ice + (deltas.water_ice ?? 0)),
        helium3: Math.max(0, current.helium3 + (deltas.helium3 ?? 0)),
        rare_earths: Math.max(0, current.rare_earths + (deltas.rare_earths ?? 0)),
      };
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
