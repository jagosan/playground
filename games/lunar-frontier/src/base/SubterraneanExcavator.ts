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

/** Mutable per-player excavation state (Spec 38 §3 Phase 1). */
export interface SubterraneanTierState {
  /** Deepest tier whose chamber has been excavated and handed over. */
  unlockedTier: DepthTierIndex;
  /** Excavation progress toward the *next* tier, 0…100 (%). 100 at max tier. */
  excavationProgress: number;
  /** Usable basalt rubble stockpile (kg) available to spend on unlocks. */
  basaltRubbleKg: number;
  /** Cumulative mined rubble tonnage across the whole run (kg). */
  totalMinedKg: number;
}

/** Fresh surface-datum state with an empty stockpile. */
export function defaultTierState(): SubterraneanTierState {
  return {
    unlockedTier: SURFACE_TIER,
    excavationProgress: 0,
    basaltRubbleKg: 0,
    totalMinedKg: 0,
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
    s.totalMinedKg >= 0
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

/** Idempotent `subterranean_base` schema migration (Spec 38 §3 Phase 1). */
export const SUBTERRANEAN_BASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS subterranean_base (
    player_id TEXT PRIMARY KEY,
    unlocked_tier INTEGER NOT NULL DEFAULT 0,
    basalt_rubble_kg REAL NOT NULL DEFAULT 0,
    total_mined_kg REAL NOT NULL DEFAULT 0,
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
  }

  /** Upsert the player's excavation state; returns the persisted state. */
  async saveState(playerId: string, state: SubterraneanTierState): Promise<SubterraneanTierState> {
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO subterranean_base
         (player_id, unlocked_tier, basalt_rubble_kg, total_mined_kg, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         unlocked_tier = excluded.unlocked_tier,
         basalt_rubble_kg = excluded.basalt_rubble_kg,
         total_mined_kg = excluded.total_mined_kg,
         updated_at = excluded.updated_at`,
      [
        playerId,
        clampTierIndex(state.unlockedTier),
        clamp(state.basaltRubbleKg, 0, Number.MAX_SAFE_INTEGER),
        clamp(state.totalMinedKg, 0, Number.MAX_SAFE_INTEGER),
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
      `SELECT player_id, unlocked_tier, basalt_rubble_kg, total_mined_kg, updated_at
         FROM subterranean_base WHERE player_id = ?`,
      [playerId],
    );
    if (row === undefined) return undefined;
    const state: SubterraneanTierState = {
      unlockedTier: clampTierIndex(row.unlocked_tier),
      excavationProgress: 0,
      basaltRubbleKg: clamp(row.basalt_rubble_kg, 0, Number.MAX_SAFE_INTEGER),
      totalMinedKg: clamp(row.total_mined_kg, 0, Number.MAX_SAFE_INTEGER),
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

export interface SubterraneanExcavatorOptions {
  /** Storage backend; defaults to {@link detectExcavationStorage}. */
  storage?: ExcavationStorage;
  /** Player id label (defaults to `'local'` for client sessions). */
  playerId?: string;
  /** Starting state overrides (merged over {@link defaultTierState}). */
  initial?: Partial<SubterraneanTierState>;
  /** Persist automatically after every rubble add / unlock (default true). */
  autosave?: boolean;
}

/**
 * Client-facing excavation state machine: rubble accrual, progress reporting
 * and validated level-up transitions, with versioned localStorage persistence.
 * Server code should additionally mirror state through
 * {@link SubterraneanRepository} for authority.
 */
export class SubterraneanExcavator {
  private readonly storage: ExcavationStorage;
  private readonly autosave: boolean;
  private state: SubterraneanTierState;

  readonly playerId: string;

  constructor(options: SubterraneanExcavatorOptions = {}) {
    this.storage = options.storage ?? detectExcavationStorage();
    this.autosave = options.autosave ?? true;
    this.playerId = options.playerId ?? 'local';
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

  // -- internals -------------------------------------------------------------

  /** Clamp every field into legal range and re-anchor cumulative tonnage. */
  private sanitize(state: SubterraneanTierState): SubterraneanTierState {
    const sanitized: SubterraneanTierState = {
      unlockedTier: clampTierIndex(state.unlockedTier),
      excavationProgress: clamp(state.excavationProgress, 0, 100),
      basaltRubbleKg: clamp(state.basaltRubbleKg, 0, Number.MAX_SAFE_INTEGER),
      totalMinedKg: clamp(state.totalMinedKg, 0, Number.MAX_SAFE_INTEGER),
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
