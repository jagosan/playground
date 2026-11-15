/**
 * Lunar Frontier — Spec 38 Phase 1: Subterranean Excavation State Machine &
 * Data Model.
 *
 * Typed depth-tier hierarchy for vertical base excavation (Spec 38 §2.1):
 * surface datum (Z = 0 m) through Tier 1 shielded habitation (Z = −15 m),
 * Tier 2 heavy industrial & power vault (Z = −45 m), and the Tier 3 deep-core
 * lava tube cavern (Z = −95 m). Tracks unlocked depth tiers, excavation
 * progress (0…100 %) and mined basalt rubble tonnage, with excavation cost
 * validation and level-up transition triggers (basalt + credits per tier).
 *
 * Persistence mirrors Spec 37 Phase 1: a versioned, validated envelope in
 * browser `localStorage` (`lunar_frontier_subterranean`), plus an
 * authoritative SQLite shard table (`subterranean_base`) managed by
 * {@link SubterraneanRepository} through an injected structural
 * {@link SqliteLike} executor (satisfied by `DatabaseManager`) so this module
 * never imports the `sqlite3` driver and stays safe in the client bundle.
 *
 * Usage:
 *   const exc = new SubterraneanExcavator();
 *   exc.load();                                    // restore from storage
 *   exc.addBasaltRubble(1200);                     // drill pulses mine rubble
 *   const r = exc.unlockNextTier(8000);            // level-up trigger
 *   if (r.unlocked) syncWallet(r.remainingCredits);
 */

// ---------------------------------------------------------------------------
// Depth tier contracts (Spec 38 §2.1)
// ---------------------------------------------------------------------------

/**
 * Commodity / material identifier for manufactured compressed slag bricks
 * (Spec 38 §3 Phase 4). Primary construction currency for Spec 39 base modules.
 */
export const SLAG_CONSTRUCTION_BRICK = 'SLAG_CONSTRUCTION_BRICK';

/** Kilograms of raw basalt rubble consumed per slag brick (Spec 38 §3 Phase 4). */
export const BASALT_PER_SLAG_BRICK_KG = 100;

/** Mass of one compressed slag construction brick (kg, Spec 38 §3 Phase 4). */
export const SLAG_BRICK_MASS_KG = 25;

/** Total trace metals (iron + titanium) produced per slag brick (kg, Spec 38 §3 Phase 4). */
export const TRACE_METALS_PER_BRICK_KG = 5;

/** Trace iron yield per slag brick (kg). */
export const TRACE_IRON_PER_BRICK_KG = 3.0;

/** Trace titanium yield per slag brick (kg). */
export const TRACE_TITANIUM_PER_BRICK_KG = 2.0;

/** Slag tailings / volatile mass released per brick during sintering (kg, 100 - 25 - 5 = 70). */
export const SLAG_WASTE_PER_BRICK_KG = 70;

/** Minimum depth tier required to operate the Autoclave / Sintering Unit (Tier 2). */
export const AUTOCLAVE_REQUIRED_TIER: DepthTierIndex = 2;

/** Depth tier index: 0 (surface datum) .. {@link MAX_DEPTH_TIER}. */
export type DepthTierIndex = 0 | 1 | 2 | 3;

/** Surface datum — no excavation performed yet. */
export const SURFACE_TIER: DepthTierIndex = 0;

/** Deepest excavable tier (deep-core lava tube cavern). */
export const MAX_DEPTH_TIER: DepthTierIndex = 3;

/** Static definition of one depth tier and its unlock costs. */
export interface DepthTierSpec {
  tier: DepthTierIndex;
  /** Display name (Spec 38 §2 depth hierarchy). */
  name: string;
  /** Vertical datum of the chamber floor, metres below the surface (negative). */
  depthZ: number;
  /** Basalt rubble that must be spent to unlock this tier (kg). 0 on surface. */
  basaltKg: number;
  /** Credit cost to unlock this tier. 0 on surface. */
  creditCost: number;
}

/** The four excavation levels, indexable by {@link DepthTierIndex}. */
export const DEPTH_TIERS: readonly DepthTierSpec[] = [
  {
    tier: 0,
    name: 'Surface Base Datum',
    depthZ: 0,
    basaltKg: 0,
    creditCost: 0,
  },
  {
    tier: 1,
    name: 'Living & Life Support Level',
    depthZ: -15,
    basaltKg: 2_500,
    creditCost: 5_000,
  },
  {
    tier: 2,
    name: 'Heavy Industrial & Power Vault',
    depthZ: -45,
    basaltKg: 8_000,
    creditCost: 15_000,
  },
  {
    tier: 3,
    name: 'Deep Core Lava Tube Cavern',
    depthZ: -95,
    basaltKg: 25_000,
    creditCost: 35_000,
  },
];

/** Look up a tier spec by index; `undefined` for out-of-range values. */
export function depthTierSpec(tier: number): DepthTierSpec | undefined {
  return DEPTH_TIERS.find((t) => t.tier === tier);
}

// ---------------------------------------------------------------------------
// Dynamic state
// ---------------------------------------------------------------------------

/** Mutable per-player excavation state (Spec 38 §3 Phase 1 & Phase 4). */
export interface SubterraneanTierState {
  /** Deepest tier whose chamber has been excavated and handed over. */
  unlockedTier: DepthTierIndex;
  /** Excavation progress toward the *next* tier, 0…100 (%). 100 at max tier. */
  excavationProgress: number;
  /** Usable basalt rubble stockpile (kg) available to spend on unlocks / sintering. */
  basaltRubbleKg: number;
  /** Cumulative mined rubble tonnage across the whole run (kg). */
  totalMinedKg: number;
  /** Stockpile of manufactured SLAG_CONSTRUCTION_BRICK (Spec 38 §3 Phase 4). */
  slagBricks?: number;
  /** Stockpile of extracted trace metals in kg (iron/titanium, Spec 38 §3 Phase 4). */
  traceMetalsKg?: number;
}

/** Fresh surface-datum state with an empty stockpile. */
export function defaultTierState(): SubterraneanTierState {
  return {
    unlockedTier: SURFACE_TIER,
    excavationProgress: 0,
    basaltRubbleKg: 0,
    totalMinedKg: 0,
    slagBricks: 0,
    traceMetalsKg: 0,
  };
}

/** Numeric clamp that maps non-finite input to `min`. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Coerce an arbitrary number into a valid {@link DepthTierIndex}. */
function clampTierIndex(value: number): DepthTierIndex {
  const v = clamp(Math.trunc(value), SURFACE_TIER, MAX_DEPTH_TIER);
  return v as DepthTierIndex;
}

/**
 * Excavation progress toward the next tier as a percentage: the share of the
 * next tier's basalt requirement already stockpiled. Returns 100 once the
 * deepest tier is unlocked.
 */
export function computeExcavationProgress(state: SubterraneanTierState): number {
  if (state.unlockedTier >= MAX_DEPTH_TIER) return 100;
  const next = DEPTH_TIERS[state.unlockedTier + 1];
  if (next === undefined || next.basaltKg <= 0) return 100;
  const ratio = (state.basaltRubbleKg / next.basaltKg) * 100;
  return Math.round(clamp(ratio, 0, 100) * 100) / 100;
}

/** Runtime shape check for deserialized / row-loaded state (never throws). */
export function validateTierShape(state: unknown): state is SubterraneanTierState {
  if (typeof state !== 'object' || state === null) return false;
  const s = state as Partial<SubterraneanTierState>;
  return (
    typeof s.unlockedTier === 'number' &&
    Number.isInteger(s.unlockedTier) &&
    s.unlockedTier >= SURFACE_TIER &&
    s.unlockedTier <= MAX_DEPTH_TIER &&
    typeof s.excavationProgress === 'number' &&
    s.excavationProgress >= 0 &&
    s.excavationProgress <= 100 &&
    typeof s.basaltRubbleKg === 'number' &&
    s.basaltRubbleKg >= 0 &&
    typeof s.totalMinedKg === 'number' &&
    s.totalMinedKg >= 0 &&
    (s.slagBricks === undefined || (typeof s.slagBricks === 'number' && s.slagBricks >= 0)) &&
    (s.traceMetalsKg === undefined || (typeof s.traceMetalsKg === 'number' && s.traceMetalsKg >= 0))
  );
}

// ---------------------------------------------------------------------------
// localStorage persistence (client)
// ---------------------------------------------------------------------------

/** `localStorage` slot holding the client-side subterranean excavation save. */
export const SUBTERRANEAN_STORAGE_KEY = 'lunar_frontier_subterranean';

/** Minimal storage contract — structural subset of the DOM `Storage` API. */
export interface ExcavationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Fallback whenever real `localStorage` is unavailable (headless/NullEngine). */
export class InMemoryExcavationStorage implements ExcavationStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/**
 * Resolve a usable {@link ExcavationStorage}: prefer the real `localStorage`
 * when it exists *and* survives a probe write (private-mode Safari throws on
 * `setItem`); otherwise return an in-memory instance so headless runs and
 * Node smoke scripts never crash.
 */
export function detectExcavationStorage(): ExcavationStorage {
  const candidate = (globalThis as { localStorage?: ExcavationStorage }).localStorage;
  if (candidate !== undefined && candidate !== null) {
    try {
      const probeKey = `${SUBTERRANEAN_STORAGE_KEY}.__probe__`;
      candidate.setItem(probeKey, '1');
      candidate.removeItem(probeKey);
      return candidate;
    } catch {
      /* fall through to memory */
    }
  }
  return new InMemoryExcavationStorage();
}

/** Versioned save envelope so future phases can migrate old client saves. */
export interface SubterraneanSaveEnvelope {
  version: number;
  savedAt: number;
  state: SubterraneanTierState;
}

export const SUBTERRANEAN_SAVE_VERSION = 1;

/** Serialize excavation state into the versioned save-envelope JSON. */
export function serializeTierState(state: SubterraneanTierState): string {
  const envelope: SubterraneanSaveEnvelope = {
    version: SUBTERRANEAN_SAVE_VERSION,
    savedAt: Date.now(),
    state,
  };
  return JSON.stringify(envelope);
}

/**
 * Parse + validate a save-envelope string. Returns `null` (never throws) on
 * malformed JSON, wrong version, or corrupted shape.
 */
export function deserializeTierState(raw: string): SubterraneanTierState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const env = parsed as Partial<SubterraneanSaveEnvelope>;
  if (env.version !== SUBTERRANEAN_SAVE_VERSION) return null;
  if (env.state === undefined || !validateTierShape(env.state)) return null;
  return env.state;
}

// ---------------------------------------------------------------------------
// Cost validation & level-up transitions (Spec 38 §2.1 / §3 Phase 1)
// ---------------------------------------------------------------------------

/** Result of checking whether the next depth tier can be afforded. */
export interface CostCheck {
  /** True when both the basalt and credit requirements are satisfied. */
  canUnlock: boolean;
  /** Kilograms of basalt still missing (0 when satisfied). */
  missingBasaltKg: number;
  /** Credits still missing (0 when satisfied). */
  missingCredits: number;
  /** The tier spec being checked, or `null` when already at max tier. */
  target: DepthTierSpec | null;
}

/**
 * Pure validation of the next tier's excavation cost against the current
 * basalt stockpile and a candidate credit balance. No state is mutated.
 */
export function validateExcavationCost(
  state: SubterraneanTierState,
  currentCredits: number,
): CostCheck {
  if (state.unlockedTier >= MAX_DEPTH_TIER) {
    return { canUnlock: false, missingBasaltKg: 0, missingCredits: 0, target: null };
  }
  const target = DEPTH_TIERS[state.unlockedTier + 1];
  if (target === undefined) {
    return { canUnlock: false, missingBasaltKg: 0, missingCredits: 0, target: null };
  }
  const safeCredits = clamp(currentCredits, 0, Number.MAX_SAFE_INTEGER);
  const missingBasaltKg = Math.max(0, target.basaltKg - state.basaltRubbleKg);
  const missingCredits = Math.max(0, target.creditCost - safeCredits);
  return {
    canUnlock: missingBasaltKg === 0 && missingCredits === 0,
    missingBasaltKg,
    missingCredits,
    target,
  };
}

/** Reasons an unlock attempt can be refused. */
export type UnlockFailureReason = 'insufficient_basalt' | 'insufficient_credits' | 'max_tier';

/** Outcome of an {@link SubterraneanExcavator.unlockNextTier} attempt. */
export interface UnlockResult {
  /** True when the tier leveled up and costs were deducted. */
  unlocked: boolean;
  /** Populated only when `unlocked` is false. */
  reason?: UnlockFailureReason;
  /** State snapshot after the attempt (mutated in place when successful). */
  state: SubterraneanTierState;
  /** The tier reached / targeted, `undefined` when already at max tier. */
  tier?: DepthTierSpec;
  /**
   * Credits left after deduction. Credits are caller-owned — sync the wallet
   * to this value when `unlocked` is true.
   */
  remainingCredits: number;
}

// ---------------------------------------------------------------------------
// Mineral Processing & Slag Sintering (Spec 38 §3 Phase 4)
// ---------------------------------------------------------------------------

/** Reasons a sintering conversion attempt can be refused. */
export type SinterFailureReason =
  | 'tier_locked'
  | 'insufficient_basalt'
  | 'invalid_amount';

/** Yield breakdown for a sintering batch (Spec 38 §3 Phase 4). */
export interface SinterYield {
  /** Quantity of SLAG_CONSTRUCTION_BRICK manufactured. */
  bricks: number;
  /** Kilograms of basalt rubble consumed. */
  basaltConsumedKg: number;
  /** Kilograms of trace metals (iron + titanium) extracted. */
  traceMetalsKg: number;
  /** Trace iron fraction (kg). */
  traceIronKg: number;
  /** Trace titanium fraction (kg). */
  traceTitaniumKg: number;
  /** Total structural mass of manufactured slag bricks (kg, 25 kg per brick). */
  slagMassKg: number;
  /** Sintering volatile tailings / mass loss (kg, 70 kg per brick). */
  tailingsMassKg: number;
}

/** Result of checking whether sintering can be executed. */
export interface SinterCheck {
  /** True when the autoclave is unlocked and sufficient basalt is stockpiled. */
  canSinter: boolean;
  /** Reason for refusal when canSinter is false. */
  reason?: SinterFailureReason;
  /** Maximum number of bricks that could be manufactured with current stockpile. */
  maxBricks: number;
  /** Maximum basalt rubble that could be consumed (kg). */
  maxBasaltKg: number;
  /** Tier required for autoclave operation (Tier 2). */
  requiredTier: DepthTierIndex;
  /** Current unlocked tier. */
  currentTier: DepthTierIndex;
  /** Available basalt rubble stockpile (kg). */
  availableBasaltKg: number;
}

/** Outcome of a sintering attempt. */
export interface SinterResult {
  /** True when sintering succeeded and inventory was updated. */
  success: boolean;
  /** Populated only when success is false. */
  reason?: SinterFailureReason;
  /** Detailed breakdown of manufactured products and consumed inputs. */
  yield: SinterYield;
  /** Excavation state after the sintering attempt. */
  state: SubterraneanTierState;
}

/**
 * Pure calculation of theoretical sintering yield from a given mass of basalt rubble.
 * Converts 100 kg basalt rubble into 1x SLAG_CONSTRUCTION_BRICK (25 kg) + 5 kg trace metals.
 */
export function calculateSinterYield(basaltKg: number): SinterYield {
  if (!Number.isFinite(basaltKg) || basaltKg <= 0) {
    return {
      bricks: 0,
      basaltConsumedKg: 0,
      traceMetalsKg: 0,
      traceIronKg: 0,
      traceTitaniumKg: 0,
      slagMassKg: 0,
      tailingsMassKg: 0,
    };
  }
  const bricks = Math.floor(basaltKg / BASALT_PER_SLAG_BRICK_KG);
  const basaltConsumedKg = bricks * BASALT_PER_SLAG_BRICK_KG;
  const traceMetalsKg = bricks * TRACE_METALS_PER_BRICK_KG;
  const traceIronKg = bricks * TRACE_IRON_PER_BRICK_KG;
  const traceTitaniumKg = bricks * TRACE_TITANIUM_PER_BRICK_KG;
  const slagMassKg = bricks * SLAG_BRICK_MASS_KG;
  const tailingsMassKg = bricks * SLAG_WASTE_PER_BRICK_KG;

  return {
    bricks,
    basaltConsumedKg,
    traceMetalsKg,
    traceIronKg,
    traceTitaniumKg,
    slagMassKg,
    tailingsMassKg,
  };
}

/**
 * Pure affordability and tier check for sintering operations.
 * Validates that Tier >= 2 is unlocked and sufficient basalt rubble exists.
 */
export function validateSinter(
  state: SubterraneanTierState,
  requestedBasaltKg = BASALT_PER_SLAG_BRICK_KG,
): SinterCheck {
  const currentTier = state.unlockedTier;
  const requiredTier = AUTOCLAVE_REQUIRED_TIER;
  const availableBasaltKg = state.basaltRubbleKg;
  const maxBricks =
    currentTier >= requiredTier
      ? Math.floor(availableBasaltKg / BASALT_PER_SLAG_BRICK_KG)
      : 0;
  const maxBasaltKg = maxBricks * BASALT_PER_SLAG_BRICK_KG;

  if (currentTier < requiredTier) {
    return {
      canSinter: false,
      reason: 'tier_locked',
      maxBricks: 0,
      maxBasaltKg: 0,
      requiredTier,
      currentTier,
      availableBasaltKg,
    };
  }

  if (!Number.isFinite(requestedBasaltKg) || requestedBasaltKg < BASALT_PER_SLAG_BRICK_KG) {
    return {
      canSinter: false,
      reason: 'invalid_amount',
      maxBricks,
      maxBasaltKg,
      requiredTier,
      currentTier,
      availableBasaltKg,
    };
  }

  const requestedBricks = Math.floor(requestedBasaltKg / BASALT_PER_SLAG_BRICK_KG);
  const neededBasaltKg = requestedBricks * BASALT_PER_SLAG_BRICK_KG;
  if (availableBasaltKg < neededBasaltKg) {
    return {
      canSinter: false,
      reason: 'insufficient_basalt',
      maxBricks,
      maxBasaltKg,
      requiredTier,
      currentTier,
      availableBasaltKg,
    };
  }

  return {
    canSinter: true,
    maxBricks,
    maxBasaltKg,
    requiredTier,
    currentTier,
    availableBasaltKg,
  };
}

/** Operational telemetry for the Tier 2 Autoclave / Sintering Unit. */
export interface AutoclaveTelemetry {
  /** Operating sintering chamber temperature in Kelvin (1450 K when active). */
  temperatureK: number;
  /** Compaction hydraulic press pressure in MPa (120 MPa). */
  compactionPressureMpa: number;
  /** Machine state: 'locked' (Tier < 2), 'idle', or 'sintering'. */
  status: 'locked' | 'idle' | 'sintering';
  /** Total sintering batches processed in this session. */
  totalBatchesProcessed: number;
  /** Total slag bricks manufactured in this session. */
  totalBricksManufactured: number;
}

/**
 * Autoclave & Sintering Unit on Tier 2 (Heavy Industrial & Power Vault, Z = -45 m).
 * Compresses and sinters raw basalt rubble at 1,450 K and 120 MPa into high-density
 * SLAG_CONSTRUCTION_BRICK units and extracts valuable trace iron/titanium metals.
 */
export class SinteringAutoclaveUnit {
  readonly requiredTier: DepthTierIndex = AUTOCLAVE_REQUIRED_TIER;
  readonly basaltPerBrickKg: number = BASALT_PER_SLAG_BRICK_KG;
  readonly slagBrickMassKg: number = SLAG_BRICK_MASS_KG;
  readonly traceMetalsPerBrickKg: number = TRACE_METALS_PER_BRICK_KG;

  private totalBatches = 0;
  private totalBricks = 0;

  calculateYield(basaltKg: number): SinterYield {
    return calculateSinterYield(basaltKg);
  }

  check(state: SubterraneanTierState, requestedBasaltKg?: number): SinterCheck {
    return validateSinter(state, requestedBasaltKg);
  }

  recordBatch(bricks: number): void {
    if (bricks > 0) {
      this.totalBatches += 1;
      this.totalBricks += bricks;
    }
  }

  getTelemetry(currentTier: DepthTierIndex): AutoclaveTelemetry {
    if (currentTier < this.requiredTier) {
      return {
        temperatureK: 253, // -20°C ambient
        compactionPressureMpa: 0,
        status: 'locked',
        totalBatchesProcessed: this.totalBatches,
        totalBricksManufactured: this.totalBricks,
      };
    }
    return {
      temperatureK: 1450, // 1450 K sintering temperature for basalt
      compactionPressureMpa: 120, // 120 MPa hydraulic compaction
      status: 'idle',
      totalBatchesProcessed: this.totalBatches,
      totalBricksManufactured: this.totalBricks,
    };
  }
}

// ---------------------------------------------------------------------------
// SQLite persistence (server-authoritative, Spec 38 §3 Phase 1)
// ---------------------------------------------------------------------------

/** Structural subset of `DatabaseManager` (src/database.ts) — avoids importing
 *  the `sqlite3` driver into client-reachable code. */
export interface SqliteLike {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ lastID: number; changes: number }>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Idempotent `subterranean_base` schema migration (Spec 38 §3 Phase 1 & Phase 4). */
export const SUBTERRANEAN_BASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS subterranean_base (
    player_id TEXT PRIMARY KEY,
    unlocked_tier INTEGER NOT NULL DEFAULT 0,
    basalt_rubble_kg REAL NOT NULL DEFAULT 0,
    total_mined_kg REAL NOT NULL DEFAULT 0,
    slag_bricks INTEGER NOT NULL DEFAULT 0,
    trace_metals_kg REAL NOT NULL DEFAULT 0,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_subterranean_base_updated
    ON subterranean_base (updated_at);
`;

interface SubterraneanBaseRow {
  player_id: string;
  unlocked_tier: number;
  basalt_rubble_kg: number;
  total_mined_kg: number;
  slag_bricks?: number;
  trace_metals_kg?: number;
  updated_at: string | null;
}

/**
 * Server-side repository for the authoritative per-player excavation shard.
 * Mirrors `DatabaseManager`'s promise-wrapped style; takes any
 * {@link SqliteLike} executor so it is testable without the real driver.
 */
export class SubterraneanRepository {
  constructor(private readonly db: SqliteLike) {}

  /** Apply the idempotent `subterranean_base` table + index migration. */
  async migrate(): Promise<void> {
    await this.db.exec(SUBTERRANEAN_BASE_SCHEMA_SQL);
    // Backward compatibility for databases created prior to Phase 4
    try {
      await this.db.run(
        'ALTER TABLE subterranean_base ADD COLUMN slag_bricks INTEGER NOT NULL DEFAULT 0',
      );
    } catch {
      // Column already exists
    }
    try {
      await this.db.run(
        'ALTER TABLE subterranean_base ADD COLUMN trace_metals_kg REAL NOT NULL DEFAULT 0',
      );
    } catch {
      // Column already exists
    }
  }

  /** Upsert the player's excavation state; returns the persisted state. */
  async saveState(playerId: string, state: SubterraneanTierState): Promise<SubterraneanTierState> {
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO subterranean_base
         (player_id, unlocked_tier, basalt_rubble_kg, total_mined_kg, slag_bricks, trace_metals_kg, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         unlocked_tier = excluded.unlocked_tier,
         basalt_rubble_kg = excluded.basalt_rubble_kg,
         total_mined_kg = excluded.total_mined_kg,
         slag_bricks = excluded.slag_bricks,
         trace_metals_kg = excluded.trace_metals_kg,
         updated_at = excluded.updated_at`,
      [
        playerId,
        clampTierIndex(state.unlockedTier),
        clamp(state.basaltRubbleKg, 0, Number.MAX_SAFE_INTEGER),
        clamp(state.totalMinedKg, 0, Number.MAX_SAFE_INTEGER),
        clamp(Math.floor(state.slagBricks ?? 0), 0, Number.MAX_SAFE_INTEGER),
        clamp(state.traceMetalsKg ?? 0, 0, Number.MAX_SAFE_INTEGER),
        now,
      ],
    );
    const persisted = await this.getState(playerId);
    if (persisted === undefined) {
      throw new Error(
        `SubterraneanRepository: upsert did not persist state for "${playerId}".`,
      );
    }
    return persisted;
  }

  /** Load the player's excavation state; `undefined` if no row exists yet. */
  async getState(playerId: string): Promise<SubterraneanTierState | undefined> {
    const row = await this.db.get<SubterraneanBaseRow>(
      `SELECT player_id, unlocked_tier, basalt_rubble_kg, total_mined_kg, slag_bricks, trace_metals_kg, updated_at
         FROM subterranean_base WHERE player_id = ?`,
      [playerId],
    );
    if (row === undefined) return undefined;
    const state: SubterraneanTierState = {
      unlockedTier: clampTierIndex(row.unlocked_tier),
      excavationProgress: 0,
      basaltRubbleKg: clamp(row.basalt_rubble_kg, 0, Number.MAX_SAFE_INTEGER),
      totalMinedKg: clamp(row.total_mined_kg, 0, Number.MAX_SAFE_INTEGER),
      slagBricks: clamp(row.slag_bricks ?? 0, 0, Number.MAX_SAFE_INTEGER),
      traceMetalsKg: clamp(row.trace_metals_kg ?? 0, 0, Number.MAX_SAFE_INTEGER),
    };
    state.excavationProgress = computeExcavationProgress(state);
    return state;
  }

  /** Delete the player's excavation shard; returns the number of rows removed. */
  async deleteState(playerId: string): Promise<number> {
    const res = await this.db.run('DELETE FROM subterranean_base WHERE player_id = ?', [playerId]);
    return res.changes;
  }
}

// ---------------------------------------------------------------------------
// State machine facade
// ---------------------------------------------------------------------------

/** Structural audio interface so SubterraneanExcavator stays decoupled from Web Audio. */
export interface SubterraneanAudioLike {
  playAutoclaveSinter?: (durationS?: number) => void;
}

export interface SubterraneanExcavatorOptions {
  /** Storage backend; defaults to {@link detectExcavationStorage}. */
  storage?: ExcavationStorage;
  /** Player id label (defaults to `'local'` for client sessions). */
  playerId?: string;
  /** Starting state overrides (merged over {@link defaultTierState}). */
  initial?: Partial<SubterraneanTierState>;
  /** Persist automatically after every rubble add / unlock / sinter (default true). */
  autosave?: boolean;
  /** Optional audio system for sintering press effects (Spec 38 §3 Phase 4). */
  audioSystem?: SubterraneanAudioLike;
}

/**
 * Client-facing excavation state machine: rubble accrual, progress reporting,
 * validated level-up transitions, and compressed slag sintering (Phase 4),
 * with versioned localStorage persistence. Server code should additionally
 * mirror state through {@link SubterraneanRepository} for authority.
 */
export class SubterraneanExcavator {
  private readonly storage: ExcavationStorage;
  private readonly autosave: boolean;
  private readonly autoclave: SinteringAutoclaveUnit;
  private audioSystem?: SubterraneanAudioLike;
  private state: SubterraneanTierState;

  readonly playerId: string;

  constructor(options: SubterraneanExcavatorOptions = {}) {
    this.storage = options.storage ?? detectExcavationStorage();
    this.autosave = options.autosave ?? true;
    this.playerId = options.playerId ?? 'local';
    this.autoclave = new SinteringAutoclaveUnit();
    this.audioSystem = options.audioSystem;
    this.state = this.sanitize({ ...defaultTierState(), ...(options.initial ?? {}) });
  }

  // -- persistence -----------------------------------------------------------

  /** Restore excavation state from storage. Returns `true` when a valid save
   *  was found and applied, `false` (fresh state kept) otherwise. */
  load(): boolean {
    const raw = this.storage.getItem(SUBTERRANEAN_STORAGE_KEY);
    if (raw === null) return false;
    const restored = deserializeTierState(raw);
    if (restored === null) return false;
    this.state = this.sanitize(restored);
    return true;
  }

  /** Persist the current excavation state to storage. */
  save(): void {
    this.storage.setItem(SUBTERRANEAN_STORAGE_KEY, serializeTierState(this.getExcavationState()));
  }

  /** Wipe the stored save and reset to the surface datum. */
  reset(): void {
    this.storage.removeItem(SUBTERRANEAN_STORAGE_KEY);
    this.state = defaultTierState();
  }

  // -- state reads -----------------------------------------------------------

  /** Snapshot of the excavation state with progress recomputed. */
  getExcavationState(): SubterraneanTierState {
    return {
      ...this.state,
      excavationProgress: computeExcavationProgress(this.state),
      slagBricks: this.state.slagBricks ?? 0,
      traceMetalsKg: this.state.traceMetalsKg ?? 0,
    };
  }

  /** Spec of the deepest tier currently unlocked. */
  getCurrentTier(): DepthTierSpec {
    return DEPTH_TIERS[this.state.unlockedTier];
  }

  /** Spec of the next tier to excavate, or `null` at the deepest tier. */
  getNextTier(): DepthTierSpec | null {
    if (this.state.unlockedTier >= MAX_DEPTH_TIER) return null;
    return DEPTH_TIERS[this.state.unlockedTier + 1];
  }

  /** Pure affordability check for the next tier (no mutation, no side effects). */
  canUnlockNextTier(currentCredits: number): CostCheck {
    return validateExcavationCost(this.getExcavationState(), currentCredits);
  }

  // -- transitions -----------------------------------------------------------

  /**
   * Add freshly mined basalt rubble to the stockpile (drill pulses, mining
   * suites). Non-finite or non-positive amounts are ignored. Cumulative
   * tonnage always grows by the added mass; the stockpile is what unlock
   * spend draws down against. Returns the new stockpile in kg.
   */
  addBasaltRubble(kg: number): number {
    if (!Number.isFinite(kg) || kg <= 0) return this.getExcavationState().basaltRubbleKg;
    const added = clamp(kg, 0, Number.MAX_SAFE_INTEGER);
    this.state.basaltRubbleKg = clamp(
      this.state.basaltRubbleKg + added,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    this.state.totalMinedKg = clamp(
      this.state.totalMinedKg + added,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (this.autosave) this.save();
    return this.getExcavationState().basaltRubbleKg;
  }

  /**
   * Level-up trigger: validate and, if affordable, consume the next tier's
   * basalt requirement + credit cost and advance to that tier. Credits are
   * caller-owned — sync the wallet to `result.remainingCredits` when
   * `unlocked` is true.
   */
  unlockNextTier(currentCredits: number): UnlockResult {
    const safeCredits = clamp(currentCredits, 0, Number.MAX_SAFE_INTEGER);
    const snapshot = this.getExcavationState();
    const check = validateExcavationCost(snapshot, safeCredits);

    if (check.target === null) {
      return {
        unlocked: false,
        reason: 'max_tier',
        state: snapshot,
        remainingCredits: safeCredits,
      };
    }
    if (check.missingBasaltKg > 0) {
      return {
        unlocked: false,
        reason: 'insufficient_basalt',
        state: snapshot,
        tier: check.target,
        remainingCredits: safeCredits,
      };
    }
    if (check.missingCredits > 0) {
      return {
        unlocked: false,
        reason: 'insufficient_credits',
        state: snapshot,
        tier: check.target,
        remainingCredits: safeCredits,
      };
    }

    // Commit the transition.
    const target = check.target;
    this.state.basaltRubbleKg = clamp(
      this.state.basaltRubbleKg - target.basaltKg,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    this.state.unlockedTier = target.tier;
    const remainingCredits = clamp(
      safeCredits - target.creditCost,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (this.autosave) this.save();

    return {
      unlocked: true,
      state: this.getExcavationState(),
      tier: target,
      remainingCredits,
    };
  }

  // -- mineral processing & slag sintering (Spec 38 §3 Phase 4) ---------------

  /** Reference to the Tier 2 Autoclave / Sintering Unit component. */
  getAutoclave(): SinteringAutoclaveUnit {
    return this.autoclave;
  }

  /** Check if the player can sinter basalt with current tier and stockpile. */
  canSinter(basaltKg?: number): SinterCheck {
    return validateSinter(this.getExcavationState(), basaltKg);
  }

  /**
   * Sinter a given mass of basalt rubble into SLAG_CONSTRUCTION_BRICK and trace metals.
   * Converts 100 kg basalt rubble into 1x SLAG_CONSTRUCTION_BRICK (25 kg) + 5 kg trace metals.
   * Requires Tier 2 to be unlocked.
   */
  sinterBasalt(basaltKg: number): SinterResult {
    const check = validateSinter(this.getExcavationState(), basaltKg);
    if (!check.canSinter) {
      return {
        success: false,
        reason: check.reason,
        yield: calculateSinterYield(0),
        state: this.getExcavationState(),
      };
    }

    const yieldData = calculateSinterYield(basaltKg);
    if (yieldData.bricks <= 0) {
      return {
        success: false,
        reason: 'insufficient_basalt',
        yield: yieldData,
        state: this.getExcavationState(),
      };
    }

    // Deduct basalt rubble and add manufactured bricks & trace metals
    this.state.basaltRubbleKg = clamp(
      this.state.basaltRubbleKg - yieldData.basaltConsumedKg,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    this.state.slagBricks = clamp(
      (this.state.slagBricks ?? 0) + yieldData.bricks,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    this.state.traceMetalsKg = clamp(
      (this.state.traceMetalsKg ?? 0) + yieldData.traceMetalsKg,
      0,
      Number.MAX_SAFE_INTEGER,
    );

    this.autoclave.recordBatch(yieldData.bricks);
    this.audioSystem?.playAutoclaveSinter?.();

    if (this.autosave) this.save();

    return {
      success: true,
      yield: yieldData,
      state: this.getExcavationState(),
    };
  }

  /**
   * Sinter an exact number of SLAG_CONSTRUCTION_BRICK units.
   * Requires brickCount * 100 kg of basalt rubble.
   */
  sinterSlagBricks(brickCount: number): SinterResult {
    if (!Number.isFinite(brickCount) || brickCount <= 0) {
      return {
        success: false,
        reason: 'invalid_amount',
        yield: calculateSinterYield(0),
        state: this.getExcavationState(),
      };
    }
    const basaltKg = Math.floor(brickCount) * BASALT_PER_SLAG_BRICK_KG;
    return this.sinterBasalt(basaltKg);
  }

  /**
   * Universal sintering call accepting either basalt kilograms or brick counts.
   */
  sinter(amount: number, unit: 'basalt' | 'bricks' = 'basalt'): SinterResult {
    if (unit === 'bricks') {
      return this.sinterSlagBricks(amount);
    }
    return this.sinterBasalt(amount);
  }

  /** Current stockpile of SLAG_CONSTRUCTION_BRICK. */
  getSlagBricks(): number {
    return this.state.slagBricks ?? 0;
  }

  /** Current stockpile of extracted trace metals (kg). */
  getTraceMetalsKg(): number {
    return this.state.traceMetalsKg ?? 0;
  }

  /**
   * Spend/consume SLAG_CONSTRUCTION_BRICK units (e.g. constructing Spec 39 base modules).
   * Returns true when affordable and deducted; false otherwise.
   */
  consumeSlagBricks(count: number): boolean {
    if (!Number.isFinite(count) || count <= 0) return false;
    const needed = Math.floor(count);
    const current = this.state.slagBricks ?? 0;
    if (current < needed) return false;
    this.state.slagBricks = current - needed;
    if (this.autosave) this.save();
    return true;
  }

  /**
   * Spend/consume extracted trace metals (kg).
   * Returns true when affordable and deducted; false otherwise.
   */
  consumeTraceMetals(kg: number): boolean {
    if (!Number.isFinite(kg) || kg <= 0) return false;
    const current = this.state.traceMetalsKg ?? 0;
    if (current < kg) return false;
    this.state.traceMetalsKg = clamp(current - kg, 0, Number.MAX_SAFE_INTEGER);
    if (this.autosave) this.save();
    return true;
  }

  /** Add slag bricks directly to the stockpile (rewards, trade). */
  addSlagBricks(count: number): number {
    if (!Number.isFinite(count) || count <= 0) return this.getSlagBricks();
    this.state.slagBricks = clamp(
      (this.state.slagBricks ?? 0) + Math.floor(count),
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (this.autosave) this.save();
    return this.getSlagBricks();
  }

  /** Add trace metals directly to the stockpile (rewards, trade). */
  addTraceMetals(kg: number): number {
    if (!Number.isFinite(kg) || kg <= 0) return this.getTraceMetalsKg();
    this.state.traceMetalsKg = clamp(
      (this.state.traceMetalsKg ?? 0) + kg,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (this.autosave) this.save();
    return this.getTraceMetalsKg();
  }

  /** Attach or replace the audio system for sintering press playback. */
  attachAudioSystem(audioSystem?: SubterraneanAudioLike): void {
    this.audioSystem = audioSystem;
  }

  // -- internals -------------------------------------------------------------

  /** Clamp every field into legal range and re-anchor cumulative tonnage. */
  private sanitize(state: SubterraneanTierState): SubterraneanTierState {
    const sanitized: SubterraneanTierState = {
      unlockedTier: clampTierIndex(state.unlockedTier),
      excavationProgress: clamp(state.excavationProgress, 0, 100),
      basaltRubbleKg: clamp(state.basaltRubbleKg, 0, Number.MAX_SAFE_INTEGER),
      totalMinedKg: clamp(state.totalMinedKg, 0, Number.MAX_SAFE_INTEGER),
      slagBricks: clamp(state.slagBricks ?? 0, 0, Number.MAX_SAFE_INTEGER),
      traceMetalsKg: clamp(state.traceMetalsKg ?? 0, 0, Number.MAX_SAFE_INTEGER),
    };
    // Cumulative tonnage can never be less than what tier transitions spent.
    for (let t = 1; t <= sanitized.unlockedTier; t += 1) {
      const spec = DEPTH_TIERS[t];
      if (spec !== undefined) {
        sanitized.totalMinedKg = Math.max(sanitized.totalMinedKg, spec.basaltKg);
      }
    }
    return sanitized;
  }
}
