/**
 * Lunar Frontier — Spec 37 Phase 4: Holographic Garage Terminal UI.
 *
 * Glassmorphic modal overlay (`#garage-terminal`) floating over the Babylon
 * canvas — the same ADR-013-1 DOM-overlay architecture as {@link LunarHUD}:
 * crisp text at any DPI, zero texture-draw overhead, fully inspectable by a
 * headless harness that injects a minimal `Document`-shaped object.
 *
 * Features (Spec 37 §3 Phase 4):
 *   • 4 category tabs (cargo bed / powertrain / suspension / mining suite)
 *     with icons and visual tier pips (Tiers 1–4).
 *   • Technical telemetry delta meters comparing the installed build against
 *     each candidate tier — green positive callouts in the exact catalog
 *     style, e.g. `Top Speed: 18 m/s -> 26 m/s (+44%)`.
 *   • Credit cost, live player balance, and a Purchase / Installed action
 *     button driven by `BuggyUpgradeSystem.purchaseUpgrade()` semantics
 *     (sequential tiers, clean insufficient-funds rejection).
 *   • Keyboard navigation: Tab/←/→ switch branches, ↑/↓ select tiers,
 *     Enter purchases, Escape dismisses.
 *   • Gamepad navigation: LB/RB switch branches, D-Pad ↑/↓ select tiers,
 *     D-Pad ←/→ switch branches, (A) purchases, (B) dismisses. Driven by
 *     {@link pumpGamepad} from ClientApp's per-frame edge pump.
 *   • Audio cue hooks (cash-register chime, pneumatic clank, welding buzz)
 *     injected by the host — this module never touches Web Audio directly.
 *
 * Headless / scene-less contract: every DOM handle is optional-called
 * (`addEventListener?.`), every external listener is tracked and removed by
 * {@link dispose}, and every interactive element carries `data-garage-*`
 * test hooks so synthetic-DOM smoke suites can assert state without CSS.
 */

import {
  MAX_TIER,
  UPGRADE_CATALOG,
  UPGRADE_CATEGORIES,
  calculateBuggyStats,
  type BuggyStats,
  type BuggyUpgradeSystem,
  type BuggyUpgradeTier,
  type InstalledUpgrades,
  type PurchaseResult,
  type UpgradeCategory,
} from '../garage/BuggyUpgradeSystem.ts';

// ---------------------------------------------------------------------------
// DOM structural contracts (mirrors the LunarHUD Elementish/Documentish pair;
// kept local so this module has no runtime dependency on the HUD bundle).
// ---------------------------------------------------------------------------

interface ClassListish {
  add(name: string): void;
  remove(name: string): void;
  contains(name: string): boolean;
}

interface Elementish {
  id: string;
  className: string;
  textContent: string;
  classList: ClassListish;
  children: Elementish[];
  appendChild<T>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

interface Documentish {
  createElement(tag: string): Elementish;
  body?: Elementish;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

// ---------------------------------------------------------------------------
// Public constants & types
// ---------------------------------------------------------------------------

/** Root element id for the garage terminal modal (styled by hud.css). */
export const GARAGE_TERMINAL_ID = 'garage-terminal';

/** Per-icon label for each upgrade tree tab (Spec 37 §2 topology). */
export const GARAGE_CATEGORY_ICONS: Readonly<Record<UpgradeCategory, string>> = {
  cargo_bed: '📦',
  powertrain: '⚡',
  suspension: '🛞',
  mining_suite: '⛏️',
};

/** Human-readable branch labels shown under the tab icons. */
export const GARAGE_CATEGORY_LABELS: Readonly<Record<UpgradeCategory, string>> = {
  cargo_bed: 'FLATBED & CARGO',
  powertrain: 'POWERTRAIN',
  suspension: 'SUSPENSION',
  mining_suite: 'MINING SUITE',
};

/**
 * Synthesis cue hooks (Spec 37 §3 Phase 4: transaction completion, welding
 * sparks, hydraulic lift cycling). The host wires these to its audio engine
 * (see `LunarAudioSystem.playCashRegisterChime` et al.); a headless run may
 * inject spies or nothing at all.
 */
export interface GarageAudioCues {
  /** Cash-register chime on a completed credit debit. */
  cashRegister?(): void;
  /** Pneumatic clank on hydraulic lift / modal open-close. */
  pneumaticClank?(): void;
  /** Welding buzz when a component is mounted to the chassis. */
  weldingBuzz?(): void;
}

/** Purchase card state machine (visual + `data-garage-state` hook). */
export type GarageTierState = 'installed' | 'available' | 'locked' | 'owned_higher';

/** One rendered telemetry delta line, e.g. Top Speed 18 -> 26 (+44%). */
export interface StatDeltaRow {
  label: string;
  fromText: string;
  toText: string;
  /** `(+44%)` style callout; empty string when no % is meaningful. */
  deltaText: string;
  improved: boolean;
}

export interface GarageTerminalOptions {
  /** Document to build against; defaults to `globalThis.document`. */
  document?: Documentish;
  /** Mount element; defaults to `document.body`. */
  mount?: Elementish | null;
  /** Upgrade facade used for purchase verification + installed readback. */
  upgradeSystem: BuggyUpgradeSystem;
  /** Current player credit balance (wallet owned by ClientApp). */
  getBalance: () => number;
  /** Optional procedural audio cue hooks. */
  audio?: GarageAudioCues;
  /** Fired after a successful purchase (commit `result.newBalance` here). */
  onPurchaseSuccess?: (result: PurchaseResult, category: UpgradeCategory) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

// ---------------------------------------------------------------------------
// Delta computation (pure — exported for smoke harnesses)
// ---------------------------------------------------------------------------

interface NumericStatSpec {
  key: keyof BuggyStats;
  label: string;
  unit: string;
  digits: number;
}

/** Numeric telemetry rows rendered on every tier card, in display order. */
const NUMERIC_STAT_SPECS: readonly NumericStatSpec[] = [
  { key: 'topSpeedMs', label: 'Top Speed', unit: ' m/s', digits: 1 },
  { key: 'wheelTorqueNm', label: 'Torque', unit: ' N·m', digits: 0 },
  { key: 'canisterCapacity', label: 'Cargo', unit: ' cans', digits: 0 },
  { key: 'maxPayloadKg', label: 'Payload', unit: ' kg', digits: 0 },
  { key: 'captureRadiusM', label: 'Capture Radius', unit: ' m', digits: 1 },
  { key: 'suspensionTravelM', label: 'Suspension Travel', unit: ' m', digits: 2 },
  { key: 'maxAbsorbDropM', label: 'Absorb Drop', unit: ' m', digits: 0 },
  { key: 'extractionMultiplier', label: 'Extraction', unit: '×', digits: 1 },
];

function fmtStat(value: number, digits: number, unit: string): string {
  const n = value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${n}${unit}`;
}

/**
 * Compare two resolved builds and emit one row per numeric stat that
 * actually changes, plus feature rows for the boolean/spec-carrying
 * attachments (nitro, tractor beam, RCS jets, deep core, ride height,
 * drive-over swath). Pure: same inputs always render the same rows.
 */
export function computeStatDeltaRows(base: BuggyStats, target: BuggyStats): StatDeltaRow[] {
  const rows: StatDeltaRow[] = [];
  for (const spec of NUMERIC_STAT_SPECS) {
    const from = base[spec.key] as number;
    const to = target[spec.key] as number;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
    let deltaText = '';
    if (from > 0) {
      const pct = Math.round(((to - from) / from) * 100);
      if (pct !== 0) deltaText = `(${pct > 0 ? '+' : ''}${pct}%)`;
    }
    rows.push({
      label: spec.label,
      fromText: fmtStat(from, spec.digits, spec.unit),
      toText: fmtStat(to, spec.digits, spec.unit),
      deltaText,
      improved: to > from,
    });
  }
  // Feature rows — discrete capabilities that no single number captures.
  if (base.nitro === null && target.nitro !== null) {
    rows.push({
      label: 'Nitro Sprint',
      fromText: 'OFF',
      toText: `45 m/s / ${String(target.nitro.durationS)} s`,
      deltaText: 'NEW',
      improved: true,
    });
  }
  if (base.tractorBeam === null && target.tractorBeam !== null) {
    rows.push({
      label: 'Tractor Beam',
      fromText: 'OFF',
      toText: `${String(target.tractorBeam.radiusM)} m @ ${String(target.tractorBeam.reelSpeedMs)} m/s`,
      deltaText: 'NEW',
      improved: true,
    });
  }
  if (base.rcsJump === null && target.rcsJump !== null) {
    rows.push({
      label: 'RCS Jump Jets',
      fromText: 'OFF',
      toText: `vz +${String(target.rcsJump.vzMs)} m/s`,
      deltaText: 'NEW',
      improved: true,
    });
  }
  if (!base.unlocksDeepCore && target.unlocksDeepCore) {
    rows.push({
      label: 'Deep Core Seams',
      fromText: 'LOCKED',
      toText: 'UNLOCKED',
      deltaText: 'NEW',
      improved: true,
    });
  }
  if (base.rideHeightBonusM < target.rideHeightBonusM) {
    rows.push({
      label: 'Ride Height',
      fromText: 'STANDARD',
      toText: `HIGH +${target.rideHeightBonusM.toFixed(2)} m`,
      deltaText: '(SELECTABLE)',
      improved: true,
    });
  }
  if (base.swathWidthM < target.swathWidthM) {
    rows.push({
      label: 'Drive-Over Swath',
      fromText: fmtStat(base.swathWidthM, 1, ' m'),
      toText: fmtStat(target.swathWidthM, 1, ' m'),
      deltaText: '(AUTO-HARVEST)',
      improved: true,
    });
  }
  return rows;
}

/** Purchase-card state for (installed, category, tier) under sequential rules. */
export function tierStateFor(
  installed: InstalledUpgrades,
  category: UpgradeCategory,
  tier: number,
): GarageTierState {
  const owned = installed[category];
  if (tier <= owned) return 'installed';
  if (tier === owned + 1) return 'available';
  if (owned === MAX_TIER) return 'owned_higher';
  return 'locked';
}

// ---------------------------------------------------------------------------
// Gamepad button map (XInput indices, mirrors ClientApp.GAMEPAD_BUTTONS)
// ---------------------------------------------------------------------------

export const GARAGE_GAMEPAD_BUTTONS: Readonly<{
  purchase: number; // A
  dismiss: number; // B
  branchPrev: number; // LB
  branchNext: number; // RB
  tierUp: number; // D-Pad Up
  tierDown: number; // D-Pad Down
  branchPrevDpad: number; // D-Pad Left
  branchNextDpad: number; // D-Pad Right
}> = {
  purchase: 0,
  dismiss: 1,
  branchPrev: 4,
  branchNext: 5,
  tierUp: 12,
  tierDown: 13,
  branchPrevDpad: 14,
  branchNextDpad: 15,
};

/** Keyboard codes consumed by the terminal while it owns the screen. */
const GARAGE_KEY_CODES: ReadonlySet<string> = new Set([
  'Tab',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'KeyA',
  'KeyD',
  'KeyW',
  'KeyS',
  'Enter',
  'NumpadEnter',
  'Escape',
  'KeyG',
]);

// ---------------------------------------------------------------------------
// The terminal
// ---------------------------------------------------------------------------

export class GarageTerminalUI {
  private readonly doc: Documentish;
  private readonly system: BuggyUpgradeSystem;
  private readonly getBalance: () => number;
  private readonly audio: GarageAudioCues | undefined;
  private readonly onPurchaseSuccess: ((r: PurchaseResult, c: UpgradeCategory) => void) | undefined;
  private readonly onOpenCb: (() => void) | undefined;
  private readonly onCloseCb: (() => void) | undefined;

  private readonly els = new Map<string, Elementish>();
  /** External (document-level) listeners registered for dispose-time removal. */
  private readonly bound: {
    target: Documentish;
    type: string;
    listener: (event: unknown) => void;
  }[] = [];

  private root: Elementish;
  private open = false;
  private disposed = false;
  private activeCategory: UpgradeCategory = 'cargo_bed';
  private selectedTier = 1;
  /** Previous gamepad button snapshot for self-contained rising edges. */
  private padPrev: readonly boolean[] = [];

  constructor(options: GarageTerminalOptions) {
    const doc = (options.document ??
      (globalThis as unknown as { document?: Documentish }).document) as
      | Documentish
      | undefined;
    if (doc === undefined || doc === null || typeof doc.createElement !== 'function') {
      throw new Error(
        'GarageTerminalUI: no DOM available — pass options.document (headless) or run in a browser',
      );
    }
    this.doc = doc;
    this.system = options.upgradeSystem;
    this.getBalance = options.getBalance;
    this.audio = options.audio;
    this.onPurchaseSuccess = options.onPurchaseSuccess;
    this.onOpenCb = options.onOpen;
    this.onCloseCb = options.onClose;

    // A fresh terminal always wins (HMR / re-init): drop any stale modal.
    this.disposeExisting(GARAGE_TERMINAL_ID);

    this.root = this.make('div', GARAGE_TERMINAL_ID, 'garage-terminal is-hidden');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Buggy customization garage terminal');
    this.root.setAttribute('data-garage-open', 'false');

    const mount = (options.mount ?? doc.body ?? null) as Elementish | null;
    if (mount !== null && typeof mount.appendChild === 'function') {
      mount.appendChild(this.root);
    }

    this.buildHeader();
    this.buildTabs();
    this.buildPanel();
    this.buildFooter();

    // Escape fallback: dismiss even if the host's global key router is absent
    // (mirrors the LunarHUD trade-terminal convention, Spec 30 §2.3.1 —
    // Escape stays strictly modal dismissal).
    if (typeof doc.addEventListener === 'function') {
      this.bindTo(doc, 'keydown', (event) => {
        if (this.disposed || !this.open) return;
        const code = (event as { code?: string } | null)?.code;
        if (code === 'Escape' || code === 'KeyG') this.hide();
      });
    }

    this.refresh();
  }

  // -- lifecycle ---------------------------------------------------------------

  /** Idempotent teardown: removes the modal, all listeners, all handles. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.bound) {
      try {
        b.target.removeEventListener?.(b.type, b.listener);
      } catch {
        /* hostile DOM — nothing else to release */
      }
    }
    this.bound.length = 0;
    this.els.clear();
    try {
      this.root.remove();
    } catch {
      /* already detached */
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  // -- visibility --------------------------------------------------------------

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    if (this.disposed || open === this.open) return;
    this.open = open;
    if (open) {
      this.root.classList.remove('is-hidden');
      this.root.setAttribute('data-garage-open', 'true');
      this.refresh();
      this.cue('pneumaticClank');
      this.onOpenCb?.();
    } else {
      this.root.classList.add('is-hidden');
      this.root.setAttribute('data-garage-open', 'false');
      this.padPrev = [];
      this.cue('pneumaticClank');
      this.onCloseCb?.();
    }
  }

  show(): void {
    this.setOpen(true);
  }

  hide(): void {
    this.setOpen(false);
  }

  // -- state readback (harness harness hooks) -----------------------------------

  getActiveCategory(): UpgradeCategory {
    return this.activeCategory;
  }

  getSelectedTier(): number {
    return this.selectedTier;
  }

  // -- navigation --------------------------------------------------------------

  /** Move to the next/previous upgrade branch (wraps). */
  cycleCategory(direction: 1 | -1): void {
    if (this.disposed) return;
    const idx = UPGRADE_CATEGORIES.indexOf(this.activeCategory);
    const n = UPGRADE_CATEGORIES.length;
    this.setCategory(UPGRADE_CATEGORIES[(idx + direction + n) % n]);
  }

  /** Jump to a branch; selection snaps to the next purchasable tier. */
  setCategory(category: UpgradeCategory): void {
    if (this.disposed) return;
    if (!UPGRADE_CATEGORIES.includes(category)) return;
    this.activeCategory = category;
    this.selectedTier = Math.min(MAX_TIER, this.system.getInstalled()[category] + 1);
    this.refresh();
  }

  /** Move the tier cursor up/down within the active branch (clamped 1..4). */
  moveTier(delta: 1 | -1): void {
    if (this.disposed) return;
    const next = Math.min(MAX_TIER, Math.max(1, this.selectedTier + delta));
    if (next === this.selectedTier) return;
    this.selectedTier = next;
    this.refresh();
  }

  selectTier(tier: number): void {
    if (this.disposed) return;
    if (tier < 1 || tier > MAX_TIER) return;
    this.selectedTier = tier;
    this.refresh();
  }

  // -- purchase ----------------------------------------------------------------

  /**
   * Attempt to purchase the currently selected tier of the active branch.
   * Verification (sequential tiers, funds) is delegated to
   * {@link BuggyUpgradeSystem.purchaseUpgrade}; failures never mutate state
   * and surface as a red feedback line (Spec 37 §4.2).
   */
  buySelected(): PurchaseResult | null {
    if (this.disposed) return null;
    const category = this.activeCategory;
    const tier = this.selectedTier;
    const def = UPGRADE_CATALOG[category].find((t) => tier === t.tier);
    if (def === undefined) return null;
    const result = this.system.purchaseUpgrade(category, tier, this.getBalance());
    if (result.success) {
      // Transaction + chassis mounting + lift settle (Spec 37 §3 Phase 4 cues).
      this.cue('cashRegister');
      this.cue('weldingBuzz');
      this.cue('pneumaticClank');
      this.setFeedback(`${def.name} installed — new components mounted to your chassis.`, 'success');
      this.onPurchaseSuccess?.(result, category);
    } else {
      this.setFeedback(result.message ?? 'Purchase rejected by workshop foreman.', 'error');
    }
    this.refresh();
    return result;
  }

  // -- input routing -----------------------------------------------------------

  /**
   * Keyboard routing while the terminal owns the screen. Returns `true` when
   * the code belongs to the terminal (host should preventDefault and park
   * world inputs). `phase === 'up'` answers true for tracked codes so the
   * host's key-state set never latches garage keys.
   */
  handleKey(code: string, phase: 'down' | 'up'): boolean {
    if (this.disposed || !this.open) return false;
    if (!GARAGE_KEY_CODES.has(code)) return false;
    if (phase === 'up') return true;
    switch (code) {
      case 'Tab':
      case 'ArrowRight':
      case 'KeyD':
        this.cycleCategory(1);
        return true;
      case 'ArrowLeft':
      case 'KeyA':
        this.cycleCategory(-1);
        return true;
      case 'ArrowUp':
      case 'KeyW':
        this.moveTier(-1);
        return true;
      case 'ArrowDown':
      case 'KeyS':
        this.moveTier(1);
        return true;
      case 'Enter':
      case 'NumpadEnter':
        this.buySelected();
        return true;
      case 'Escape':
      case 'KeyG':
        this.hide();
        return true;
      default:
        return false;
    }
  }

  /**
   * Per-frame gamepad lane (called from ClientApp's edge pump while the
   * modal is open). Self-contained rising-edge detection against the
   * previous snapshot: bumpers / D-Pad ←/→ switch branches, D-Pad ↑/↓ move
   * the tier cursor, (A) purchases, (B) dismisses. Returns `true` when any
   * edge was consumed so the host can claim the gamepad input source.
   */
  pumpGamepad(buttons: readonly boolean[], _timestampMs?: number): boolean {
    if (this.disposed || !this.open) {
      this.padPrev = buttons.slice();
      return false;
    }
    const prev = this.padPrev;
    const rising = (index: number): boolean =>
      buttons[index] === true && prev[index] !== true;
    this.padPrev = buttons.slice();

    let consumed = false;
    if (rising(GARAGE_GAMEPAD_BUTTONS.dismiss)) {
      this.hide();
      return true;
    }
    if (rising(GARAGE_GAMEPAD_BUTTONS.branchNext) || rising(GARAGE_GAMEPAD_BUTTONS.branchNextDpad)) {
      this.cycleCategory(1);
      consumed = true;
    }
    if (rising(GARAGE_GAMEPAD_BUTTONS.branchPrev) || rising(GARAGE_GAMEPAD_BUTTONS.branchPrevDpad)) {
      this.cycleCategory(-1);
      consumed = true;
    }
    if (rising(GARAGE_GAMEPAD_BUTTONS.tierUp)) {
      this.moveTier(-1);
      consumed = true;
    }
    if (rising(GARAGE_GAMEPAD_BUTTONS.tierDown)) {
      this.moveTier(1);
      consumed = true;
    }
    if (rising(GARAGE_GAMEPAD_BUTTONS.purchase)) {
      this.buySelected();
      consumed = true;
    }
    return consumed;
  }

  // -- rendering ---------------------------------------------------------------

  /** Repaint tabs, cards, balance, and the action button from live state. */
  refresh(): void {
    if (this.disposed) return;
    const installed = this.system.getInstalled();
    this.paintTabs(installed);
    this.paintPanel(installed);
    this.paintFooter(installed);
  }

  private paintTabs(installed: InstalledUpgrades): void {
    const strip = this.els.get('tabs');
    if (strip === undefined) return;
    this.clearChildren(strip);
    for (const category of UPGRADE_CATEGORIES) {
      const tab = this.make('button', undefined, 'garage-category-tab');
      tab.setAttribute('type', 'button');
      tab.setAttribute('data-garage-tab', category);
      tab.setAttribute('data-testid', `garage-tab-${category}`);
      tab.setAttribute('aria-selected', this.activeCategory === category ? 'true' : 'false');
      if (this.activeCategory === category) tab.classList.add('is-active');

      const icon = this.make('span', undefined, 'garage-tab-icon');
      icon.textContent = GARAGE_CATEGORY_ICONS[category];
      tab.appendChild(icon);

      const label = this.make('span', undefined, 'garage-tab-label');
      label.textContent = GARAGE_CATEGORY_LABELS[category];
      tab.appendChild(label);

      // Tier pips: filled ● for installed tiers, ○ for the rest (Spec 37 §2).
      const pips = this.make('span', undefined, 'garage-tier-pips');
      pips.setAttribute('data-garage-pips', category);
      for (let tier = 1; tier <= MAX_TIER; tier += 1) {
        const pip = this.make('span', undefined, 'garage-tier-pip');
        pip.setAttribute('data-garage-pip', `${category}:${String(tier)}`);
        if (tier <= installed[category]) pip.classList.add('is-filled');
        pip.textContent = '●';
        pips.appendChild(pip);
      }
      tab.appendChild(pips);

      tab.addEventListener?.('click', () => this.setCategory(category));
      strip.appendChild(tab);
    }
  }

  private paintPanel(installed: InstalledUpgrades): void {
    const panel = this.els.get('panel');
    if (panel === undefined) return;
    this.clearChildren(panel);
    const baseStats = calculateBuggyStats(installed);
    const tiers = UPGRADE_CATALOG[this.activeCategory];
    for (const def of tiers) {
      panel.appendChild(this.buildTierCard(def, installed, baseStats));
    }
  }

  private buildTierCard(
    def: BuggyUpgradeTier,
    installed: InstalledUpgrades,
    baseStats: BuggyStats,
  ): Elementish {
    const state = tierStateFor(installed, this.activeCategory, def.tier);
    const card = this.make('div', undefined, 'garage-tier-card');
    card.setAttribute('data-garage-card', `${this.activeCategory}:${String(def.tier)}`);
    card.setAttribute('data-garage-state', state);
    card.setAttribute('data-testid', `garage-tier-card-${this.activeCategory}-${String(def.tier)}`);
    if (def.tier === this.selectedTier) card.classList.add('is-selected');
    card.classList.add(`is-${state}`);

    const head = this.make('div', undefined, 'garage-tier-head');
    const name = this.make('span', undefined, 'garage-tier-name');
    name.textContent = `T${String(def.tier)} · ${def.name}`;
    head.appendChild(name);
    const status = this.make('span', undefined, 'garage-tier-status');
    status.setAttribute('data-garage-tier-status', `${this.activeCategory}:${String(def.tier)}`);
    status.textContent =
      state === 'installed'
        ? 'INSTALLED'
        : state === 'available'
          ? `${def.cost.toLocaleString('en-US')} CR`
          : 'LOCKED — PREV TIER REQ';
    if (state === 'installed') status.classList.add('is-good');
    if (state === 'locked') status.classList.add('is-bad');
    head.appendChild(status);
    card.appendChild(head);

    const desc = this.make('div', undefined, 'garage-tier-desc');
    desc.textContent = def.description;
    card.appendChild(desc);

    // Delta meters: installed build vs build WITH this tier applied
    // (capped at the installed level so owned-higher cards show no phantom).
    const effectiveTier = Math.max(installed[this.activeCategory], def.tier);
    const targetStats = calculateBuggyStats({
      ...installed,
      [this.activeCategory]: effectiveTier,
    });
    const rows =
      def.tier <= installed[this.activeCategory] && state === 'installed'
        ? []
        : computeStatDeltaRows(baseStats, targetStats);
    for (const row of rows) {
      card.appendChild(this.buildDeltaRow(row));
    }

    card.addEventListener?.('click', () => this.selectTier(def.tier));
    return card;
  }

  private buildDeltaRow(row: StatDeltaRow): Elementish {
    const line = this.make('div', undefined, 'garage-stat-delta');
    line.setAttribute('data-garage-delta', row.label);
    line.setAttribute('data-testid', `garage-delta-${row.label.replace(/\s+/g, '-').toLowerCase()}`);
    if (row.improved) line.classList.add('is-positive');
    line.textContent = `${row.label}: ${row.fromText} -> ${row.toText}${
      row.deltaText.length > 0 ? ` ${row.deltaText}` : ''
    }`;
    return line;
  }

  private paintFooter(installed: InstalledUpgrades): void {
    const balance = this.els.get('balance');
    if (balance !== undefined) {
      balance.textContent = this.getBalance().toLocaleString('en-US');
    }
    const buy = this.els.get('buy-btn');
    const costEl = this.els.get('cost');
    if (buy === undefined) return;
    const def = UPGRADE_CATALOG[this.activeCategory].find((t) => this.selectedTier === t.tier);
    const state = def === undefined ? 'locked' : tierStateFor(installed, this.activeCategory, def.tier);
    buy.setAttribute('data-garage-buy-state', state);
    if (costEl !== undefined) {
      costEl.textContent =
        def === undefined || state === 'installed'
          ? '—'
          : `${(def.cost).toLocaleString('en-US')} CR`;
    }
    if (state === 'available' && def !== undefined) {
      buy.textContent = `PURCHASE — ${def.cost.toLocaleString('en-US')} CR`;
      buy.classList.remove('is-disabled');
    } else {
      buy.textContent = state === 'installed' ? 'INSTALLED' : 'LOCKED';
      buy.classList.add('is-disabled');
    }
  }

  /** Fire one injected audio cue (no-op when the host wired none). */
  private cue(name: keyof GarageAudioCues): void {
    if (this.audio === undefined) return;
    try {
      this.audio[name]?.();
    } catch {
      // Audio engines may reject calls after their own dispose — never
      // let a cue failure abort a completed transaction.
    }
  }

  private setFeedback(text: string, kind: 'success' | 'error' | 'info'): void {
    const el = this.els.get('feedback');
    if (el === undefined) return;
    el.textContent = text;
    el.classList.remove('is-good');
    el.classList.remove('is-bad');
    if (kind === 'success') el.classList.add('is-good');
    if (kind === 'error') el.classList.add('is-bad');
  }

  // -- DOM plumbing ------------------------------------------------------------

  private buildHeader(): void {
    const head = this.make('div', undefined, 'garage-head');
    const title = this.make('h2', undefined, 'garage-title');
    title.textContent = 'BUGGY WORKSHOP — HOLOGRAPHIC TERMINAL';
    head.appendChild(title);

    const balField = this.make('div', undefined, 'garage-balance-field');
    const balLabel = this.make('span', undefined, 'garage-balance-label');
    balLabel.textContent = 'CREDITS';
    balField.appendChild(balLabel);
    const balance = this.make('span', 'garage-balance', 'garage-balance-value');
    balance.setAttribute('data-testid', 'garage-balance');
    balance.textContent = '0';
    this.els.set('balance', balance);
    balField.appendChild(balance);
    head.appendChild(balField);

    const close = this.make('button', 'garage-close-btn', 'garage-close-btn');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Close garage terminal');
    close.setAttribute('data-testid', 'garage-close');
    close.textContent = '✕';
    close.addEventListener?.('click', () => this.hide());
    head.appendChild(close);

    this.root.appendChild(head);
  }

  private buildTabs(): void {
    const strip = this.make('div', 'garage-category-tabs', 'garage-category-tabs');
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('data-testid', 'garage-category-tabs');
    this.els.set('tabs', strip);
    this.root.appendChild(strip);
  }

  private buildPanel(): void {
    const panel = this.make('div', 'garage-tier-panel', 'garage-tier-panel');
    panel.setAttribute('data-testid', 'garage-tier-panel');
    this.els.set('panel', panel);
    this.root.appendChild(panel);
  }

  private buildFooter(): void {
    const foot = this.make('div', undefined, 'garage-foot');

    const costField = this.make('div', undefined, 'garage-cost-field');
    const costLabel = this.make('span', undefined, 'garage-cost-label');
    costLabel.textContent = 'COST';
    costField.appendChild(costLabel);
    const cost = this.make('span', 'garage-cost', 'garage-cost-value');
    cost.setAttribute('data-testid', 'garage-cost');
    cost.textContent = '—';
    this.els.set('cost', cost);
    costField.appendChild(cost);
    foot.appendChild(costField);

    const buy = this.make('button', 'garage-buy-btn', 'garage-buy-btn is-disabled');
    buy.setAttribute('type', 'button');
    buy.setAttribute('data-testid', 'garage-buy');
    buy.textContent = 'LOCKED';
    buy.addEventListener?.('click', () => this.buySelected());
    this.els.set('buy-btn', buy);
    foot.appendChild(buy);

    const feedback = this.make('div', 'garage-feedback', 'garage-feedback');
    feedback.setAttribute('data-testid', 'garage-feedback');
    feedback.textContent = 'TAB switch branch · ↑↓ select tier · ENTER purchase · ESC close';
    this.els.set('feedback', feedback);
    foot.appendChild(feedback);

    this.root.appendChild(foot);
  }

  private bindTo(target: Documentish, type: string, listener: (event: unknown) => void): void {
    target.addEventListener?.(type, listener);
    this.bound.push({ target, type, listener });
  }

  /** Remove every child of a node (works on real and synthetic DOMs). */
  private clearChildren(node: Elementish): void {
    while (node.children.length > 0) {
      const child = node.children[0];
      try {
        child.remove();
      } catch {
        /* hostile synthetic DOM — fall through to manual detach */
      }
      // A synthetic `remove()` may succeed without detaching the child from
      // the parent array — guarantee forward progress so the loop can never
      // spin on a stub DOM implementation.
      if (node.children.length > 0 && node.children[0] === child) {
        node.children.shift();
      }
    }
  }

  /** Create an element; `id` becomes the DOM id (styled by hud.css). */
  private make(tag: string, id?: string, className?: string): Elementish {
    const el = this.doc.createElement(tag) as Elementish;
    if (id !== undefined) el.setAttribute('id', id);
    if (className !== undefined) {
      for (const part of className.split(' ')) {
        if (part.length > 0) el.classList.add(part);
      }
    }
    return el;
  }

  /** Drop a stale modal left behind by a previous instance (HMR / re-init). */
  private disposeExisting(id: string): void {
    const body = this.doc.body;
    if (body === undefined || typeof body.children === 'undefined') return;
    for (const child of [...body.children]) {
      if (child.id === id) {
        try {
          child.remove();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export default GarageTerminalUI;
