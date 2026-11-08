/**
 * Lunar Frontier — Spec 37 Phase 1: Buggy Workshop & Modular Upgrades.
 *
 * Typed data contracts for the four modular upgrade trees (cargo bed,
 * powertrain, suspension, mining suite) across Tiers 1-4 (Spec 37 §2), the
 * deterministic stat-compounding getter `calculateBuggyStats()`, purchase
 * verification with clean insufficient-funds rejection, and persistence to
 * both browser `localStorage` (versioned, validated envelope) and the
 * authoritative server SQLite database (`buggy_upgrades` table).
 *
 * This module is dependency-free and safe to import from the client bundle:
 * the SQLite repository ({@link BuggyUpgradeRepository}) talks to an injected
 * structural `SqliteLike` executor (satisfied by `DatabaseManager`) rather
 * than importing the `sqlite3` driver itself.
 *
 * Usage:
 *   const sys = new BuggyUpgradeSystem();
 *   sys.load();                                   // restore from localStorage
 *   const r = sys.purchaseUpgrade('powertrain', 3, 20000);
 *   if (r.success) { const stats = calculateBuggyStats(r.installed); sys.save(); }
 */

// ---------------------------------------------------------------------------
// Categories & tier contracts
// ---------------------------------------------------------------------------

/** The four modular upgrade trees (Spec 37 §2). */
export type UpgradeCategory = 'cargo_bed' | 'powertrain' | 'suspension' | 'mining_suite';

export const UPGRADE_CATEGORIES: readonly UpgradeCategory[] = [
  'cargo_bed',
  'powertrain',
  'suspension',
  'mining_suite',
];

/** Highest purchasable tier in every tree (Tier 1 is stock / already owned). */
export const MAX_TIER = 4;

/** A tier index: 1 (stock) .. {@link MAX_TIER}. */
export type TierIndex = 1 | 2 | 3 | 4;

/** Emergency nitro sprint delivered by the Tier 4 overdrive capacitor. */
export interface NitroSpec {
  /** Sprint velocity reached while discharging (m/s). */
  sprintSpeedMs: number;
  /** How long a full discharge lasts (seconds). */
  durationS: number;
  /** Recharge time back to a full capacitor (seconds). */
  rechargeS: number;
}

/** Tractor-beam auto-reel delivered by the Tier 4 cargo gantry. */
export interface TractorBeamSpec {
  /** Free-floating loot within this radius is reeled in (m). */
  radiusM: number;
  /** Constant reel-in speed (m/s). */
  reelSpeedMs: number;
}

/** Vertical reactive impulse delivered by the Tier 4 chassis RCS pods. */
export interface RcsJumpSpec {
  /** Upward velocity set while firing (m/s). */
  vzMs: number;
}

/** Effect payload for the `cargo_bed` tree. */
export interface CargoBedEffects {
  canisterCapacity?: number;
  maxPayloadKg?: number;
  captureRadiusM?: number;
  /** Rear subframe extension added by the extended flatbed (m). */
  subframeExtensionM?: number;
  tractorBeam?: TractorBeamSpec;
}

/** Effect payload for the `powertrain` tree. */
export interface PowertrainEffects {
  topSpeedMs?: number;
  wheelTorqueNm?: number;
  nitro?: NitroSpec;
}

/** Effect payload for the `suspension` tree. */
export interface SuspensionEffects {
  suspensionTravelM?: number;
  /** Extra ground clearance from Active Ride-Height high mode (m). */
  rideHeightBonusM?: number;
  /** Largest leap height absorbed without chassis bottom-out (m). */
  maxAbsorbDropM?: number;
  rcsJump?: RcsJumpSpec;
}

/** Effect payload for the `mining_suite` tree. */
export interface MiningSuiteEffects {
  extractionMultiplier?: number;
  /** Drive-over harvest swath width; 0 = no passive collection (m). */
  swathWidthM?: number;
  /** Deep Core Resonator unlocks subsurface bedrock seams. */
  unlocksDeepCore?: boolean;
}

/** Category-keyed map of effect payload shapes. */
export interface CategoryEffectsMap {
  cargo_bed: CargoBedEffects;
  powertrain: PowertrainEffects;
  suspension: SuspensionEffects;
  mining_suite: MiningSuiteEffects;
}

/** One catalog entry in an upgrade tree. */
export interface BuggyUpgradeTier<C extends UpgradeCategory = UpgradeCategory> {
  /** Stable machine id, e.g. 'powertrain_t3_quad_hyper'. */
  id: string;
  category: C;
  tier: TierIndex;
  /** Human-readable display name for the garage terminal. */
  name: string;
  /** One-line technical description. */
  description: string;
  /** Catalog cost in credits (0 for the stock Tier 1). */
  cost: number;
  /** Physical/gameplay effects this tier contributes. */
  effects: CategoryEffectsMap[C];
}

// ---------------------------------------------------------------------------
// Catalog (Spec 37 §2.1 – §2.4)
// ---------------------------------------------------------------------------

const STOCK_CAPTURE_RADIUS_M = 1.8;
const STOCK_ABSORB_DROP_M = 6;

export const CARGO_BED_TREE: readonly BuggyUpgradeTier<'cargo_bed'>[] = [
  {
    id: 'cargo_bed_t1_stock_hopper',
    category: 'cargo_bed',
    tier: 1,
    name: 'Stock Hopper',
    description: '6-canister hopper, 200 kg max payload, 1.8 m capture radius.',
    cost: 0,
    effects: {
      canisterCapacity: 6,
      maxPayloadKg: 200,
      captureRadiusM: STOCK_CAPTURE_RADIUS_M,
    },
  },
  {
    id: 'cargo_bed_t2_extended_flatbed',
    category: 'cargo_bed',
    tier: 2,
    name: 'Extended Freight Flatbed',
    description: '12 canisters, 500 kg payload, +0.6 m rear subframe, double-tier rails.',
    cost: 3500,
    effects: {
      canisterCapacity: 12,
      maxPayloadKg: 500,
      subframeExtensionM: 0.6,
    },
  },
  {
    id: 'cargo_bed_t3_mag_cargo_net',
    category: 'cargo_bed',
    tier: 3,
    name: 'Electromagnetic Cargo Net',
    description: 'Pulsing energy webbing expands throw-capture radius 1.8 m -> 3.5 m.',
    cost: 8500,
    effects: {
      captureRadiusM: 3.5,
    },
  },
  {
    id: 'cargo_bed_t4_tractor_beam',
    category: 'cargo_bed',
    tier: 4,
    name: 'Tractor Beam Harpoon',
    description: 'Rear gantry reels in free canisters and ore within 12 m at 8 m/s.',
    cost: 22000,
    effects: {
      tractorBeam: { radiusM: 12, reelSpeedMs: 8.0 },
    },
  },
];

export const POWERTRAIN_TREE: readonly BuggyUpgradeTier<'powertrain'>[] = [
  {
    id: 'powertrain_t1_stock_dual',
    category: 'powertrain',
    tier: 1,
    name: 'Stock Dual Motors',
    description: 'Top speed 18 m/s (65 km/h), max wheel torque 1400 N·m.',
    cost: 0,
    effects: {
      topSpeedMs: 18.0,
      wheelTorqueNm: 1400,
    },
  },
  {
    id: 'powertrain_t2_brushless',
    category: 'powertrain',
    tier: 2,
    name: 'High-Torque Brushless Motors',
    description: 'Top speed 26 m/s (94 km/h), 2400 N·m wheel torque, +71% hill-climb authority.',
    cost: 4500,
    effects: {
      topSpeedMs: 26.0,
      wheelTorqueNm: 2400,
    },
  },
  {
    id: 'powertrain_t3_quad_hyper',
    category: 'powertrain',
    tier: 3,
    name: 'Quad Hyper-Induction Motors',
    description: 'All-wheel independent drive, 35 m/s (126 km/h), 3800 N·m — outdrives the Apex Express.',
    cost: 14000,
    effects: {
      topSpeedMs: 35.0,
      wheelTorqueNm: 3800,
    },
  },
  {
    id: 'powertrain_t4_overdrive_capacitor',
    category: 'powertrain',
    tier: 4,
    name: 'Superconducting Overdrive Capacitor',
    description: 'Nitro sprint to 45 m/s (162 km/h) for 4 s; 15 s recharge. [Left Shift] / pad (A).',
    cost: 32000,
    effects: {
      nitro: { sprintSpeedMs: 45.0, durationS: 4.0, rechargeS: 15.0 },
    },
  },
];

export const SUSPENSION_TREE: readonly BuggyUpgradeTier<'suspension'>[] = [
  {
    id: 'suspension_t1_stock_coils',
    category: 'suspension',
    tier: 1,
    name: 'Stock Leaf & Coils',
    description: '0.35 m travel, baseline damping, bottom-out shock on leaps > 6 m.',
    cost: 0,
    effects: {
      suspensionTravelM: 0.35,
      maxAbsorbDropM: STOCK_ABSORB_DROP_M,
    },
  },
  {
    id: 'suspension_t2_nitro_dampers',
    category: 'suspension',
    tier: 2,
    name: 'Heavy-Duty Nitrogen Reservoir Dampers',
    description: '0.55 m travel, progressive bump-stops; absorbs 15 m crater-lip landings clean.',
    cost: 5000,
    effects: {
      suspensionTravelM: 0.55,
      maxAbsorbDropM: 15,
    },
  },
  {
    id: 'suspension_t3_active_ride_height',
    category: 'suspension',
    tier: 3,
    name: 'Hydraulic Active Ride-Height',
    description: 'Slammed mode for 35 m/s stability; High-Clearance mode +0.25 m for boulder fields.',
    cost: 11000,
    effects: {
      rideHeightBonusM: 0.25,
    },
  },
  {
    id: 'suspension_t4_rcs_jump_jets',
    category: 'suspension',
    tier: 4,
    name: 'PLSS Chassis RCS Jump Thrusters',
    description: 'Four cold-gas pods; Jump while driving sets vz -> +8 m/s to clear rails and ravines.',
    cost: 28000,
    effects: {
      rcsJump: { vzMs: 8.0 },
    },
  },
];

export const MINING_SUITE_TREE: readonly BuggyUpgradeTier<'mining_suite'>[] = [
  {
    id: 'mining_suite_t1_pulse_laser',
    category: 'mining_suite',
    tier: 1,
    name: 'Survey Pulse Laser',
    description: '1.0× extraction rate, single-target lock.',
    cost: 0,
    effects: {
      extractionMultiplier: 1.0,
    },
  },
  {
    id: 'mining_suite_t2_thermal_beam',
    category: 'mining_suite',
    tier: 2,
    name: 'Thermal Resonance Drill',
    description: '2.5× extraction speed; fractures basalt veins in under 2.5 s.',
    cost: 4000,
    effects: {
      extractionMultiplier: 2.5,
    },
  },
  {
    id: 'mining_suite_t3_wide_scoop',
    category: 'mining_suite',
    tier: 3,
    name: 'Wide-Angle Regolith Collector',
    description: 'Front scoop array auto-harvests a 4.5 m swath of surface minerals on the drive-by.',
    cost: 12500,
    effects: {
      swathWidthM: 4.5,
    },
  },
  {
    id: 'mining_suite_t4_deep_core_resonator',
    category: 'mining_suite',
    tier: 4,
    name: 'Deep Core Resonator',
    description: 'Seismic emitter unlocks deep bedrock seams of rare isotopes and titanium.',
    cost: 25000,
    effects: {
      unlocksDeepCore: true,
    },
  },
];

/** Full catalog indexed by category, tiers ordered 1 → 4. */
export const UPGRADE_CATALOG: Record<UpgradeCategory, readonly BuggyUpgradeTier[]> = {
  cargo_bed: CARGO_BED_TREE,
  powertrain: POWERTRAIN_TREE,
  suspension: SUSPENSION_TREE,
  mining_suite: MINING_SUITE_TREE,
};

/** Look up one catalog entry; `undefined` if the (category, tier) pair is invalid. */
export function getUpgradeTier(
  category: UpgradeCategory,
  tier: number,
): BuggyUpgradeTier | undefined {
  return UPGRADE_CATALOG[category]?.find((t) => tier === t.tier);
}

/** Catalog cost of one upgrade; `undefined` for an invalid (category, tier) pair. */
export function getUpgradeCost(category: UpgradeCategory, tier: number): number | undefined {
  return getUpgradeTier(category, tier)?.cost;
}

// ---------------------------------------------------------------------------
// Installed state & compounded stats
// ---------------------------------------------------------------------------

/**
 * Installed tier per tree. Every tree always has at least its Tier 1 stock
 * component; values are 1 .. {@link MAX_TIER}. Sequential progression is
 * enforced at purchase time (tier n requires tier-1 already installed).
 */
export interface InstalledUpgrades {
  cargo_bed: TierIndex;
  powertrain: TierIndex;
  suspension: TierIndex;
  mining_suite: TierIndex;
}

/** Factory-fresh buggy: every tree at stock Tier 1. */
export function defaultInstalledUpgrades(): InstalledUpgrades {
  return { cargo_bed: 1, powertrain: 1, suspension: 1, mining_suite: 1 };
}

/**
 * Fully-resolved physical attributes of a buggy build, consumed by
 * `OpenBuggy` (visuals), `TraversalPhysics` (drive/suspension/nitro/jump)
 * and the garage terminal's delta meters.
 */
export interface BuggyStats {
  // -- cargo bed ------------------------------------------------------------
  canisterCapacity: number;
  maxPayloadKg: number;
  /** Canister capture radius around the bed (m). */
  captureRadiusM: number;
  /** Rear subframe extension from the extended flatbed (m). */
  subframeExtensionM: number;
  tractorBeam: TractorBeamSpec | null;
  // -- powertrain -----------------------------------------------------------
  topSpeedMs: number;
  wheelTorqueNm: number;
  nitro: NitroSpec | null;
  // -- suspension -----------------------------------------------------------
  suspensionTravelM: number;
  /** Extra clearance from Active Ride-Height high mode (m). */
  rideHeightBonusM: number;
  /** Largest leap absorbed without bottom-out (m). */
  maxAbsorbDropM: number;
  rcsJump: RcsJumpSpec | null;
  // -- mining suite ----------------------------------------------------------
  extractionMultiplier: number;
  /** Passive drive-over harvest swath width; 0 = none (m). */
  swathWidthM: number;
  unlocksDeepCore: boolean;
}

/**
 * Structural shape check for an unknown object claiming to be
 * {@link InstalledUpgrades}. Guards restore against corrupted saves.
 */
export function validateInstalledShape(value: unknown): value is InstalledUpgrades {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<UpgradeCategory, unknown>;
  return UPGRADE_CATEGORIES.every((cat) => {
    const t = v[cat];
    return typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= MAX_TIER;
  });
}

/**
 * Deterministically compound the installed tiers into physical stats
 * (Spec 37 Phase 1). Starts from the Tier 1 baseline of each tree and
 * overlays the optional effects of every higher installed tier in ascending
 * order, so the result depends only on `installed` — no clock, no I/O.
 *
 * Example gate (Spec 37 §4.1): powertrain Tier 3 yields exactly
 * `topSpeedMs === 35.0`.
 */
export function calculateBuggyStats(installed?: Partial<InstalledUpgrades>): BuggyStats {
  const state = { ...defaultInstalledUpgrades(), ...(installed ?? {}) };

  // Baselines mirror the Tier-1 stock components of each tree.
  const stats: BuggyStats = {
    canisterCapacity: 6,
    maxPayloadKg: 200,
    captureRadiusM: STOCK_CAPTURE_RADIUS_M,
    subframeExtensionM: 0,
    tractorBeam: null,
    topSpeedMs: 18.0,
    wheelTorqueNm: 1400,
    nitro: null,
    suspensionTravelM: 0.35,
    rideHeightBonusM: 0,
    maxAbsorbDropM: STOCK_ABSORB_DROP_M,
    rcsJump: null,
    extractionMultiplier: 1.0,
    swathWidthM: 0,
    unlocksDeepCore: false,
  };

  for (const category of UPGRADE_CATEGORIES) {
    const topTier = state[category];
    for (const def of UPGRADE_CATALOG[category]) {
      // Only apply tiers the player owns, above the stock baseline.
      if (def.tier <= 1 || def.tier > topTier) continue;
      const e = def.effects as Record<string, unknown>;
      if (e.canisterCapacity !== undefined) stats.canisterCapacity = e.canisterCapacity as number;
      if (e.maxPayloadKg !== undefined) stats.maxPayloadKg = e.maxPayloadKg as number;
      if (e.captureRadiusM !== undefined) stats.captureRadiusM = e.captureRadiusM as number;
      if (e.subframeExtensionM !== undefined) {
        stats.subframeExtensionM = e.subframeExtensionM as number;
      }
      if (e.tractorBeam !== undefined) stats.tractorBeam = e.tractorBeam as TractorBeamSpec;
      if (e.topSpeedMs !== undefined) stats.topSpeedMs = e.topSpeedMs as number;
      if (e.wheelTorqueNm !== undefined) stats.wheelTorqueNm = e.wheelTorqueNm as number;
      if (e.nitro !== undefined) stats.nitro = e.nitro as NitroSpec;
      if (e.suspensionTravelM !== undefined) stats.suspensionTravelM = e.suspensionTravelM as number;
      if (e.rideHeightBonusM !== undefined) stats.rideHeightBonusM = e.rideHeightBonusM as number;
      if (e.maxAbsorbDropM !== undefined) stats.maxAbsorbDropM = e.maxAbsorbDropM as number;
      if (e.rcsJump !== undefined) stats.rcsJump = e.rcsJump as RcsJumpSpec;
      if (e.extractionMultiplier !== undefined) {
        stats.extractionMultiplier = e.extractionMultiplier as number;
      }
      if (e.swathWidthM !== undefined) stats.swathWidthM = e.swathWidthM as number;
      if (e.unlocksDeepCore !== undefined) stats.unlocksDeepCore = e.unlocksDeepCore as boolean;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Purchase verification
// ---------------------------------------------------------------------------

/** Outcome of a {@link BuggyUpgradeSystem.purchaseUpgrade} attempt. */
export interface PurchaseResult {
  success: boolean;
  /** Balance after the debit, or the untouched balance when `success === false`. */
  newBalance: number;
  /** Installed tiers after the purchase, or the untouched state on failure. */
  installed: InstalledUpgrades;
  /** Machine-readable failure code when `success === false`. */
  error?:
    | 'invalid_category'
    | 'invalid_tier'
    | 'already_installed'
    | 'tier_not_unlocked'
    | 'insufficient_funds';
  /** Human-readable message for the garage terminal. */
  message?: string;
}

/** Pure, pure-function purchase check (no state, no persistence). */
export function verifyPurchase(
  installed: InstalledUpgrades,
  category: UpgradeCategory,
  tier: number,
  currentBalance: number,
): PurchaseResult {
  const fail = (
    error: NonNullable<PurchaseResult['error']>,
    message: string,
  ): PurchaseResult => ({ success: false, newBalance: currentBalance, installed, error, message });

  if (!UPGRADE_CATEGORIES.includes(category)) {
    return fail('invalid_category', `Unknown upgrade category "${String(category)}".`);
  }
  const def = getUpgradeTier(category, tier);
  if (def === undefined) {
    return fail('invalid_tier', `Tier ${String(tier)} does not exist in tree "${category}".`);
  }
  if (tier <= installed[category]) {
    return fail('already_installed', `${def.name} is already installed on this buggy.`);
  }
  if (tier !== installed[category] + 1) {
    return fail(
      'tier_not_unlocked',
      `${def.name} requires the previous ${category} tier to be installed first.`,
    );
  }
  if (!Number.isFinite(currentBalance) || currentBalance < def.cost) {
    return fail(
      'insufficient_funds',
      `${def.name} costs ${String(def.cost)} credits; balance is ${String(currentBalance)}.`,
    );
  }

  const next: InstalledUpgrades = { ...installed, [category]: tier as TierIndex };
  return {
    success: true,
    newBalance: currentBalance - def.cost,
    installed: next,
    message: `${def.name} installed for ${String(def.cost)} credits.`,
  };
}

// ---------------------------------------------------------------------------
// localStorage persistence (client)
// ---------------------------------------------------------------------------

/** `localStorage` slot holding the client-side buggy upgrade save. */
export const BUGGY_UPGRADE_STORAGE_KEY = 'lunar_frontier_buggy_upgrades';

/** Minimal storage contract — structural subset of the DOM `Storage` API. */
export interface UpgradeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Fallback whenever real `localStorage` is unavailable (headless/NullEngine). */
export class InMemoryUpgradeStorage implements UpgradeStorage {
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
 * Resolve a usable {@link UpgradeStorage}: prefer the real `localStorage`
 * when it exists *and* survives a probe write (Safari private mode throws on
 * `setItem`); otherwise return an in-memory instance so headless runs and
 * Node smoke scripts never crash.
 */
export function detectUpgradeStorage(): UpgradeStorage {
  const candidate = (globalThis as { localStorage?: UpgradeStorage }).localStorage;
  if (candidate !== undefined && candidate !== null) {
    try {
      const probeKey = `${BUGGY_UPGRADE_STORAGE_KEY}.__probe__`;
      candidate.setItem(probeKey, '1');
      candidate.removeItem(probeKey);
      return candidate;
    } catch {
      /* fall through to memory */
    }
  }
  return new InMemoryUpgradeStorage();
}

/** Versioned save envelope so future phases can migrate old client saves. */
export interface BuggyUpgradeSaveEnvelope {
  version: number;
  savedAt: number;
  installed: InstalledUpgrades;
}

export const BUGGY_UPGRADE_SAVE_VERSION = 1;

/** Serialize installed upgrades into the versioned save envelope JSON. */
export function serializeInstalled(installed: InstalledUpgrades): string {
  const envelope: BuggyUpgradeSaveEnvelope = {
    version: BUGGY_UPGRADE_SAVE_VERSION,
    savedAt: Date.now(),
    installed,
  };
  return JSON.stringify(envelope);
}

/**
 * Parse + validate a save envelope string. Returns `null` (never throws) on
 * malformed JSON, wrong version, or corrupted shape.
 */
export function deserializeInstalled(raw: string): InstalledUpgrades | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const env = parsed as Partial<BuggyUpgradeSaveEnvelope>;
  if (env.version !== BUGGY_UPGRADE_SAVE_VERSION) return null;
  if (!validateInstalledShape(env.installed)) return null;
  return env.installed as InstalledUpgrades;
}

// ---------------------------------------------------------------------------
// SQLite persistence (server-authoritative, Spec 37 Phase 1)
// ---------------------------------------------------------------------------

/** Structural subset of `DatabaseManager` (src/database.ts) — avoids importing
 *  the `sqlite3` driver into client-reachable code. */
export interface SqliteLike {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ lastID: number; changes: number }>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Idempotent `buggy_upgrades` schema migration (Spec 37 §3 Phase 1). */
export const BUGGY_UPGRADES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS buggy_upgrades (
    player_id TEXT PRIMARY KEY,
    cargo_bed INTEGER NOT NULL DEFAULT 1,
    powertrain INTEGER NOT NULL DEFAULT 1,
    suspension INTEGER NOT NULL DEFAULT 1,
    mining_suite INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_buggy_upgrades_updated
    ON buggy_upgrades (updated_at);
`;

interface BuggyUpgradeRow {
  player_id: string;
  cargo_bed: number;
  powertrain: number;
  suspension: number;
  mining_suite: number;
  updated_at: string;
}

/**
 * Server-side repository for the authoritative per-player buggy upgrade
 * state. Mirrors `DatabaseManager`'s promise-wrapped style; takes any
 * {@link SqliteLike} executor so it is testable without the real driver.
 */
export class BuggyUpgradeRepository {
  constructor(private readonly db: SqliteLike) {}

  /** Apply the idempotent `buggy_upgrades` table + index migration. */
  async migrate(): Promise<void> {
    await this.db.exec(BUGGY_UPGRADES_SCHEMA_SQL);
  }

  /** Upsert the player's installed tiers; returns the persisted state. */
  async saveInstalled(playerId: string, installed: InstalledUpgrades): Promise<InstalledUpgrades> {
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO buggy_upgrades
         (player_id, cargo_bed, powertrain, suspension, mining_suite, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         cargo_bed = excluded.cargo_bed,
         powertrain = excluded.powertrain,
         suspension = excluded.suspension,
         mining_suite = excluded.mining_suite,
         updated_at = excluded.updated_at`,
      [
        playerId,
        installed.cargo_bed,
        installed.powertrain,
        installed.suspension,
        installed.mining_suite,
        now,
      ],
    );
    const row = await this.getInstalled(playerId);
    if (row === undefined) {
      throw new Error(`BuggyUpgradeRepository: upsert did not persist state for "${playerId}".`);
    }
    return row;
  }

  /** Load the player's installed tiers; `undefined` if no row exists yet. */
  async getInstalled(playerId: string): Promise<InstalledUpgrades | undefined> {
    const row = await this.db.get<BuggyUpgradeRow>(
      'SELECT player_id, cargo_bed, powertrain, suspension, mining_suite, updated_at FROM buggy_upgrades WHERE player_id = ?',
      [playerId],
    );
    if (row === undefined) return undefined;
    const installed: InstalledUpgrades = {
      cargo_bed: clampTier(row.cargo_bed),
      powertrain: clampTier(row.powertrain),
      suspension: clampTier(row.suspension),
      mining_suite: clampTier(row.mining_suite),
    };
    return installed;
  }

  /** Delete the player's save (drops them back to a stock buggy). */
  async deleteInstalled(playerId: string): Promise<number> {
    const res = await this.db.run('DELETE FROM buggy_upgrades WHERE player_id = ?', [playerId]);
    return res.changes;
  }
}

function clampTier(value: number): TierIndex {
  const v = Math.min(MAX_TIER, Math.max(1, Math.trunc(value) || 1));
  return v as TierIndex;
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

export interface BuggyUpgradeSystemOptions {
  /** Storage backend; defaults to `detectUpgradeStorage()`. */
  storage?: UpgradeStorage;
  /** Player id used when a `BuggyUpgradeRepository` is attached later. */
  playerId?: string;
  /** Starting state (defaults to stock Tier-1 everywhere). */
  initial?: Partial<InstalledUpgrades>;
  /** Persist automatically after every successful purchase (default true). */
  autosave?: boolean;
}

/**
 * Client-facing facade tying together catalog, purchase verification and
 * localStorage persistence. Server code should additionally mirror state
 * through {@link BuggyUpgradeRepository} for authority.
 */
export class BuggyUpgradeSystem {
  private installed: InstalledUpgrades;
  private readonly storage: UpgradeStorage;
  private readonly autosave: boolean;

  constructor(options: BuggyUpgradeSystemOptions = {}) {
    this.storage = options.storage ?? detectUpgradeStorage();
    this.autosave = options.autosave ?? true;
    this.installed = { ...defaultInstalledUpgrades(), ...(options.initial ?? {}) };
  }

  /** Current installed tiers (copy — mutating it does not affect the system). */
  getInstalled(): InstalledUpgrades {
    return { ...this.installed };
  }

  /** Compounded physical stats for the current build. */
  getStats(): BuggyStats {
    return calculateBuggyStats(this.installed);
  }

  /**
   * Restore installed upgrades from `localStorage`. Returns `true` when a
   * valid save was found (invalid/corrupt saves are ignored, state untouched).
   */
  load(): boolean {
    const raw = this.storage.getItem(BUGGY_UPGRADE_STORAGE_KEY);
    if (raw === null) return false;
    const parsed = deserializeInstalled(raw);
    if (parsed === null) return false;
    this.installed = parsed;
    return true;
  }

  /** Persist the current installed state to `localStorage`. */
  save(): void {
    this.storage.setItem(BUGGY_UPGRADE_STORAGE_KEY, serializeInstalled(this.installed));
  }

  /** Remove the client save (server state, if any, is authoritative). */
  clear(): void {
    this.storage.removeItem(BUGGY_UPGRADE_STORAGE_KEY);
    this.installed = defaultInstalledUpgrades();
  }

  /** Replace the whole installed state (e.g. after a server sync). */
  setInstalled(installed: InstalledUpgrades): void {
    if (!validateInstalledShape(installed)) {
      throw new Error('BuggyUpgradeSystem.setInstalled: invalid InstalledUpgrades shape.');
    }
    this.installed = { ...installed };
    if (this.autosave) this.save();
  }

  /**
   * Verify and apply one upgrade purchase against `currentBalance`.
   * Sequential-tier and insufficient-funds rules live in
   * {@link verifyPurchase}; failures never mutate state or the balance.
   * On success the balance is debited by the exact catalog cost (Spec 37 §4.2)
   * — the caller owns the wallet and must commit `result.newBalance`.
   */
  purchaseUpgrade(
    category: UpgradeCategory,
    tier: number,
    currentBalance: number,
  ): PurchaseResult {
    const result = verifyPurchase(this.installed, category, tier, currentBalance);
    if (result.success) {
      this.installed = result.installed;
      if (this.autosave) this.save();
    }
    return result;
  }
}
