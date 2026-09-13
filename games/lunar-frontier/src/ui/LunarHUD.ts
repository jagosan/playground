/**
 * Lunar Frontier — glassmorphic DOM telemetry HUD & commodity trade terminal
 * (Spec 13 §3, ADR-013-1, TASK-PLAY-054).
 *
 * Per ADR-013-1 the HUD is an HTML/CSS overlay (`#lunar-hud`) floating over
 * the Babylon `<canvas>` — crisp text on high-DPI screens, zero texture-draw
 * overhead, and a real keyboard/pointer-navigable market dialog. Nothing in
 * this file touches WebGL: it is pure DOM, so it renders in a browser and is
 * equally inspectable by a headless harness that injects a minimal
 * `Document`-shaped object.
 *
 * Panels (spec 13 §3):
 *   • Life support   — Oxygen % bar, EVA battery % bar, suit headlight lamp,
 *                      RCS fuel, altitude / ground-contact readouts.
 *   • Buggy dashboard— speedometer (m/s AND km/h), cargo bar (0–500 kg),
 *                      traction-battery %, headlight lamp, status chips.
 *   • Scanner        — Handheld Mineral Scanner: nearest vein id, kind,
 *                      purity, remaining units, range.
 *   • Prompts        — proximity prompts: `[E] Drive Buggy`, `[M] Mine Vein`,
 *                      `[C] Stake Claim`, `[T] Trade`.
 *   • Trade terminal — live market book (base/buy/sell/reserve/held per
 *                      commodity) + order form with instant feedback.
 *
 * All mutation flows through explicit, idempotent update methods so
 * `ClientApp` can drive every panel from entity telemetry or network frames,
 * and the smoke harness can assert on DOM text without any renderer.
 */

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export const HUD_ROOT_ID = 'lunar-hud';
export const HUD_TRADE_ID = 'lunar-hud-trade';

/** Fallback book when the terminal opens before the first `market_sync`. */
export const HUD_DEFAULT_COMMODITIES: readonly string[] = [
  'REGOLITH',
  'BASALT',
  'TITANIUM',
  'ILMENITE',
  'WATER_ICE',
  'HELIUM3',
];

/** Proximity prompt kinds recognised by the HUD (spec 13 §3 key sheet). */
export const HUD_PROMPT_KINDS = {
  drive: { label: 'Drive Buggy', order: 10 },
  dismount: { label: 'Exit Buggy', order: 10 },
  mine: { label: 'Mine Vein', order: 20 },
  claim: { label: 'Stake Claim', order: 30 },
  trade: { label: 'Trade', order: 40 },
} as const;

export type HudPromptKind = keyof typeof HUD_PROMPT_KINDS;

export interface HudPrompt {
  /** Hotkey glyph shown in brackets, e.g. `E`. */
  key: string;
  kind?: HudPromptKind;
  /** Overrides the canonical kind label. */
  label?: string;
  /** Sort weight; defaults to the kind's canonical order. */
  order?: number;
}

export interface HudSuitTelemetry {
  oxygen: number;
  battery: number;
  rcsFuel?: number;
  headlightOn: boolean;
  altitude?: number;
  isGrounded?: boolean;
  speed?: number;
  /** False once O₂ or battery bottoms out. */
  operational?: boolean;
}

export interface HudBuggyTelemetry {
  /** Road speed in m/s (km/h is derived for display). */
  speed: number;
  cargoMass: number;
  /** Cargo ceiling in kg (spec: 500). */
  cargoCapacity?: number;
  /** Traction battery state of charge, 0..1. */
  batteryFraction: number;
  headlightsOn: boolean;
  mounted?: boolean;
  rolled?: boolean;
  airborne?: boolean;
}

export interface HudScannerReadout {
  found: boolean;
  veinId?: string;
  kind?: string;
  /** 0..~1.5 grade multiplier. */
  purity?: number;
  remaining?: number;
  rangeM?: number;
  message?: string;
}

export interface HudTradeConfirmation {
  commodity: string;
  amount: number;
  isBuy: boolean;
  totalCredits: number;
  newBalance?: number;
}

/** Payload handed to `onTrade` when the order form is submitted. */
export interface HudTradeRequest {
  commodity: string;
  amount: number;
  isBuy: boolean;
}

export type HudFeedbackKind = 'info' | 'success' | 'error';

export interface LunarHUDOptions {
  /** Document to build into (injected by headless harnesses). */
  document?: Document;
  /** Mount element; defaults to `document.body`. */
  mount?: HTMLElement;
  /** Fired on order-form submit — `ClientApp` forwards to `NetworkClient.trade`. */
  onTrade?: (request: HudTradeRequest) => void;
  /** Commodity rows to pre-build while the book is still unknown. */
  commodities?: readonly string[];
  /** Number of simultaneous prompt slots. */
  promptSlots?: number;
}

// ---------------------------------------------------------------------------
// Structural DOM surface
// ---------------------------------------------------------------------------

/**
 * The exact DOM surface this file uses, declared structurally so the module
 * imports nothing (no Babylon, no Node) and a harness can hand in a fake.
 * Browsers satisfy it directly.
 */
interface Elementish {
  id: string;
  className: string;
  textContent: string | null;
  style: { width: string };
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  };
  children: Elementish[];
  appendChild<T>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
}

interface Documentish {
  createElement(tag: string): Elementish;
  body?: Elementish;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function num(value: number | undefined | null, digits = 0): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Unit prices keep micro-precision: MarketEngine spreads can be ~0.006 cr. */
function price(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function pct(percent: number): string {
  const v = Number.isFinite(percent) ? percent : 0;
  return `${Math.round(Math.max(0, Math.min(100, v)))}%`;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function severityBar(percent: number): '' | 'is-low' | 'is-critical' {
  return percent <= 15 ? 'is-critical' : percent <= 35 ? 'is-low' : '';
}

// ---------------------------------------------------------------------------
// LunarHUD
// ---------------------------------------------------------------------------

export class LunarHUD {
  /** Overlay root (`#lunar-hud`). */
  readonly root: Elementish;
  /** Trade terminal root (`#lunar-hud-trade`). */
  readonly tradeRoot: Elementish;

  private readonly doc: Documentish;
  private readonly promptSlots: number;
  private readonly onTrade: ((request: HudTradeRequest) => void) | undefined;

  /** Every interesting element, addressed by a stable logical key. */
  private readonly els = new Map<string, Elementish>();

  private promptEls: Elementish[] = [];
  private marketTable: Elementish | null = null;
  private readonly tradeRows = new Map<
    string,
    { row: Elementish; base: Elementish; buy: Elementish; sell: Elementish; reserve: Elementish; holding: Elementish }
  >();
  private readonly tradeOptions = new Set<string>();

  private tradeOpen = false;
  private hudHidden = false;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: LunarHUDOptions = {}) {
    const doc = (options.document ?? (globalThis as { document?: unknown }).document) as
      | Documentish
      | undefined;
    if (doc === undefined || doc === null || typeof doc.createElement !== 'function') {
      throw new Error(
        'LunarHUD: no DOM available — pass options.document (headless) or run in a browser',
      );
    }
    this.doc = doc;
    this.promptSlots = Math.max(1, options.promptSlots ?? 5);
    this.onTrade = options.onTrade;

    // A fresh HUD always wins: drop any previous overlay (HMR / re-init).
    this.disposeExisting(HUD_ROOT_ID);
    this.disposeExisting(HUD_TRADE_ID);

    this.root = this.make('div', HUD_ROOT_ID, 'lunar-hud', HUD_ROOT_ID);
    this.tradeRoot = this.make('div', HUD_TRADE_ID, 'lunar-hud trade-terminal is-hidden', HUD_TRADE_ID);

    const mount = (options.mount ?? doc.body ?? null) as Elementish | null;
    if (mount !== null && typeof mount.appendChild === 'function') {
      mount.appendChild(this.root);
      mount.appendChild(this.tradeRoot);
    }

    this.buildStatusStrip();
    this.buildLifeSupport();
    this.buildBuggyPanel();
    this.buildScanner();
    this.buildPrompts();
    this.buildTradeTerminal(options.commodities ?? HUD_DEFAULT_COMMODITIES);

    // Escape closes the terminal even if ClientApp's own listener is absent.
    if (typeof doc.addEventListener === 'function') {
      doc.addEventListener('keydown', (event) => {
        if (this.disposed) return;
        const code = (event as { code?: string } | null)?.code;
        if (code === 'Escape' && this.tradeOpen) this.hideTradeDialog();
      });
    }
  }

  // -- lifecycle ----------------------------------------------------------------

  /** Idempotent teardown: removes both overlays, clears timers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.feedbackTimer !== null) {
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = null;
    }
    this.tradeRows.clear();
    this.tradeOptions.clear();
    this.promptEls = [];
    this.els.clear();
    this.tradeRoot.remove();
    this.root.remove();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** Hide / show the telemetry overlay wholesale. */
  setHidden(hidden: boolean): void {
    this.hudHidden = hidden;
    this.setClass(HUD_ROOT_ID, 'is-hidden', hidden);
  }

  isHidden(): boolean {
    return this.hudHidden;
  }

  /** Live lookup of a logical element key (test / integration affordance). */
  getElement(key: string): Elementish | undefined {
    return this.els.get(key);
  }

  /** Text content of a logical element ('' when absent). */
  textOf(key: string): string {
    return this.els.get(key)?.textContent ?? '';
  }

  hasClass(key: string, className: string): boolean {
    return this.els.get(key)?.classList.contains(className) ?? false;
  }

  // -- life support ---------------------------------------------------------------

  /** Paint the EVA life-support panel (O₂, battery, lamp, RCS, altitude). */
  updateSuitTelemetry(t: HudSuitTelemetry): void {
    if (this.disposed) return;
    const oxygen = clamp(t.oxygen, 0, 100);
    const battery = clamp(t.battery, 0, 100);

    this.setText('oxygen-value', pct(oxygen));
    this.setBar('oxygen-bar', oxygen, severityBar(oxygen));
    this.setText('battery-value', pct(battery));
    this.setBar('battery-bar', battery, severityBar(battery));
    if (t.rcsFuel !== undefined) this.setText('rcs-value', pct(clamp(t.rcsFuel, 0, 100)));
    if (t.speed !== undefined) this.setText('suit-speed-value', `${num(t.speed, 1)} m/s`);
    if (t.altitude !== undefined) this.setText('altitude-value', `${num(t.altitude, 1)} m`);
    if (t.isGrounded !== undefined) {
      this.setText('contact-value', t.isGrounded ? 'CONTACT' : 'AIRBORNE');
    }
    this.setLamp('suit-lamp', t.headlightOn);

    if (t.operational === false) {
      this.setText('life-support-state', 'LIFE SUPPORT FAILURE');
      this.setClass('life-support-state', 'is-hidden', false);
      this.setClass(HUD_ROOT_ID, 'life-critical', true);
    } else if (this.hasClass('life-support-state', 'is-hidden') === false) {
      this.setClass('life-support-state', 'is-hidden', true);
      this.setClass(HUD_ROOT_ID, 'life-critical', false);
    }
  }

  /** Direct headlight override (also driven from telemetry). */
  setSuitHeadlight(on: boolean): void {
    if (this.disposed) return;
    this.setLamp('suit-lamp', on);
  }

  /** Show or hide the buggy dashboard (shown while mounted). */
  setBuggyPanelVisible(visible: boolean): void {
    if (this.disposed) return;
    this.setClass('buggy-panel', 'is-hidden', !visible);
  }

  // -- buggy dashboard --------------------------------------------------------------

  /** Paint the cockpit dash: speed (m/s + km/h), cargo bar, battery, lamps. */
  updateBuggyTelemetry(t: HudBuggyTelemetry): void {
    if (this.disposed) return;
    const capacity = t.cargoCapacity ?? 500;
    const speed = Number.isFinite(t.speed) ? Math.abs(t.speed) : 0;

    this.setText('speed-ms', `${num(speed, 1)} m/s`);
    this.setText('speed-kmh', `${num(speed * 3.6, 1)} km/h`);

    const cargo = clamp(t.cargoMass, 0, capacity);
    this.setText('cargo-value', `${num(cargo, 0)} / ${num(capacity, 0)} kg`);
    this.setBar('cargo-bar', (cargo / capacity) * 100, cargo >= capacity ? 'is-full' : '');

    const battery = clamp(t.batteryFraction * 100, 0, 100);
    this.setText('buggy-battery-value', pct(battery));
    this.setBar('buggy-battery-bar', battery, severityBar(battery));
    this.setLamp('buggy-lamp', t.headlightsOn);

    this.setChip('mounted-chip', t.mounted === true);
    this.setChip('rolled-chip', t.rolled === true);
    this.setChip('airborne-chip', t.airborne === true);
  }

  // -- mineral scanner -----------------------------------------------------------------

  /** Paint the Handheld Mineral Scanner readout. */
  setScanner(readout: HudScannerReadout): void {
    if (this.disposed) return;
    if (readout.found) {
      this.setText(
        'scanner-line-1',
        `${readout.veinId ?? 'UNKNOWN'} · ${String(readout.kind ?? '').toUpperCase()}`,
      );
      this.setText(
        'scanner-line-2',
        `purity ${num((readout.purity ?? 1) * 100, 0)}% · ${num(readout.remaining, 0)} u left`,
      );
      this.setText(
        'scanner-line-3',
        readout.rangeM !== undefined ? `range ${num(readout.rangeM, 1)} m` : 'on target',
      );
      this.setClass('scanner-panel', 'scanner-hot', true);
    } else {
      this.setText('scanner-line-1', readout.message ?? 'NO SIGNATURES');
      this.setText('scanner-line-2', '');
      this.setText('scanner-line-3', '');
      this.setClass('scanner-panel', 'scanner-hot', false);
    }
  }

  // -- proximity prompts ------------------------------------------------------------------

  /**
   * Replace the prompt strip. Prompts sort by `order` (falling back to the
   * canonical kind order) and cap at `promptSlots`; spare slots hide.
   */
  setPrompts(prompts: readonly HudPrompt[]): void {
    if (this.disposed) return;
    const sorted = [...prompts].sort((a, b) => this.orderOf(a) - this.orderOf(b));
    for (let i = 0; i < this.promptEls.length; i++) {
      const slot = this.promptEls[i];
      const prompt = sorted[i];
      if (prompt === undefined) {
        this.setClassEl(slot, 'is-hidden', true);
        continue;
      }
      const label = prompt.label ?? HUD_PROMPT_KINDS[(prompt.kind ?? 'trade') as HudPromptKind]?.label ?? 'Interact';
      slot.textContent = '';
      const key = this.make('span', undefined, 'hud-key');
      key.textContent = `[${prompt.key}]`;
      const text = this.make('span', undefined, 'hud-prompt-label');
      text.textContent = label;
      slot.appendChild(key);
      slot.appendChild(text);
      slot.setAttribute('data-kind', prompt.kind ?? 'custom');
      this.setClassEl(slot, 'is-hidden', false);
    }
  }

  /** Clear every prompt slot. */
  clearPrompts(): void {
    this.setPrompts([]);
  }

  private orderOf(prompt: HudPrompt): number {
    if (prompt.order !== undefined) return prompt.order;
    return HUD_PROMPT_KINDS[(prompt.kind ?? 'trade') as HudPromptKind]?.order ?? 50;
  }

  // -- status strip --------------------------------------------------------------------------

  /** Connection strip: `setConnection('open', 42)`. */
  setConnection(state: string, pingMs?: number | null): void {
    if (this.disposed) return;
    const ping = pingMs === undefined || pingMs === null ? '' : ` · ${num(pingMs, 0)} ms`;
    this.setText('net-value', `${String(state).toUpperCase()}${ping}`);
  }

  setCredits(credits: number): void {
    if (this.disposed) return;
    this.setText('credits-value', num(credits, 0));
    this.setText('trade-balance', num(credits, 0));
  }

  setUsername(username: string, faction?: string): void {
    if (this.disposed) return;
    this.setText('identity-value', faction && faction.length > 0 ? `${username} · ${faction}` : username);
  }

  setStatusMessage(message: string): void {
    if (this.disposed) return;
    this.setText('status-value', message);
  }

  // -- trade terminal ---------------------------------------------------------------------------

  /**
   * Repaint the book from the shapes `NetworkClient` normalises out of
   * `market_sync` (`prices` = station ask, `sellPrices` = station bid).
   */
  updateMarketPrices(
    prices: Record<string, number>,
    options: {
      sellPrices?: Record<string, number>;
      basePrices?: Record<string, number>;
      reserves?: Record<string, number>;
      holdings?: Record<string, number>;
      timestamp?: number;
    } = {},
  ): void {
    if (this.disposed) return;
    const symbols = new Set<string>([
      ...this.tradeRows.keys(),
      ...Object.keys(prices),
      ...Object.keys(options.sellPrices ?? {}),
      ...Object.keys(options.basePrices ?? {}),
      ...Object.keys(options.reserves ?? {}),
    ]);

    for (const symbol of symbols) {
      const row = this.ensureTradeRow(symbol);
      row.buy.textContent = price(prices[symbol]);
      row.sell.textContent = price(options.sellPrices?.[symbol]);
      row.base.textContent = price(options.basePrices?.[symbol]);
      row.reserve.textContent = num(options.reserves?.[symbol], 0);
      const held = options.holdings?.[symbol] ?? 0;
      row.holding.textContent = num(held, 0);
      this.setClassEl(row.row, 'has-holding', held > 0);
    }

    const ts = options.timestamp;
    if (ts !== undefined && Number.isFinite(ts) && ts > 0) {
      const clock = new Date(ts).toLocaleTimeString('en-US', { hour12: false });
      this.setText('trade-synced', `synced ${clock}`);
    }
  }

  /** Pre-select the order-form commodity (e.g. what the scanner just found). */
  selectTradeCommodity(symbol: string): void {
    if (this.disposed) return;
    this.ensureTradeRow(symbol);
    const select = this.els.get('trade-commodity');
    if (select !== undefined) (select as unknown as { value: string }).value = symbol;
  }

  showTradeDialog(): void {
    if (this.disposed) return;
    this.tradeOpen = true;
    this.setClass(HUD_TRADE_ID, 'is-hidden', false);
  }

  hideTradeDialog(): void {
    if (this.disposed) return;
    this.tradeOpen = false;
    this.setClass(HUD_TRADE_ID, 'is-hidden', true);
  }

  toggleTradeDialog(): boolean {
    if (this.tradeOpen) this.hideTradeDialog();
    else this.showTradeDialog();
    return this.tradeOpen;
  }

  isTradeDialogOpen(): boolean {
    return this.tradeOpen;
  }

  /**
   * Instant feedback line in the terminal — `success` for a server
   * `trade_confirmed`, `error` for a rejection. Auto-clears after 6 s.
   */
  showFeedback(message: string, kind: HudFeedbackKind = 'info'): void {
    if (this.disposed) return;
    this.setText('trade-feedback', message);
    this.setClass('trade-feedback', 'feedback-success', kind === 'success');
    this.setClass('trade-feedback', 'feedback-error', kind === 'error');
    if (this.feedbackTimer !== null) clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = null;
      if (!this.disposed) this.setText('trade-feedback', '');
    }, 6000);
    const handle = this.feedbackTimer as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') handle.unref();
  }

  /** Feed one server `trade_confirmed` into the terminal (feedback + balance). */
  showTradeConfirmation(confirm: HudTradeConfirmation): void {
    if (this.disposed) return;
    const verb = confirm.isBuy ? 'BOUGHT' : 'SOLD';
    const balance =
      confirm.newBalance === undefined ? '' : ` · balance ${num(confirm.newBalance, 0)} cr`;
    this.showFeedback(
      `${verb} ${num(confirm.amount, 0)} ${confirm.commodity} — ${num(confirm.totalCredits, 2)} cr${balance}`,
      'success',
    );
    if (confirm.newBalance !== undefined) this.setCredits(confirm.newBalance);
  }

  /** Reflect authoritative inventory into the terminal holdings column. */
  updateInventory(inventory: Record<string, number>): void {
    if (this.disposed) return;
    for (const [symbol, amount] of Object.entries(inventory)) {
      const row = this.ensureTradeRow(symbol);
      row.holding.textContent = num(amount, 0);
      this.setClassEl(row.row, 'has-holding', amount > 0);
    }
  }

  /**
   * Programmatic order entry (used by the harness and by any future hotkey
   * flow) — validates exactly like the buttons, then fires `onTrade`.
   */
  submitOrder(isBuy: boolean, commodity?: string, amount?: number): HudTradeRequest | null {
    if (this.disposed) return null;
    const select = this.els.get('trade-commodity') as unknown as { value?: string } | undefined;
    const amountInput = this.els.get('trade-amount') as unknown as { value?: string } | undefined;
    const symbol = String(commodity ?? select?.value ?? '').trim();
    const raw = amount !== undefined ? amount : Number(amountInput?.value);
    const quantity = Number.isFinite(raw) ? Math.floor(raw as number) : NaN;

    if (symbol.length === 0) {
      this.showFeedback('pick a commodity first', 'error');
      return null;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      this.showFeedback('amount must be a whole number greater than 0', 'error');
      return null;
    }
    const request: HudTradeRequest = { commodity: symbol, amount: quantity, isBuy };
    this.onTrade?.(request);
    return request;
  }

  // -- build stages -----------------------------------------------------------------------------

  private buildStatusStrip(): void {
    const strip = this.make('div', 'lunar-hud-status', 'hud-strip');
    this.root.appendChild(strip);
    strip.appendChild(this.labeledField('identity', 'PROSPECTOR', '—'));
    strip.appendChild(this.labeledField('credits', 'CREDITS', '0'));
    strip.appendChild(this.labeledField('net', 'LINK', 'OFFLINE'));
    strip.appendChild(this.labeledField('status', 'STATUS', 'booting'));
  }

  private buildLifeSupport(): void {
    const panel = this.make('section', 'lunar-hud-life', 'hud-panel life-support', 'life-panel');
    this.root.appendChild(panel);
    panel.appendChild(this.heading('LIFE SUPPORT'));

    const alarm = this.make('div', 'lunar-hud-life-state', 'hud-alarm is-hidden', 'life-support-state');
    alarm.textContent = '';
    panel.appendChild(alarm);

    panel.appendChild(this.labeledField('oxygen', 'O₂', '100%'));
    panel.appendChild(this.bar('oxygen-bar'));
    panel.appendChild(this.labeledField('battery', 'SUIT BAT', '100%'));
    panel.appendChild(this.bar('battery-bar'));
    panel.appendChild(this.labeledField('rcs', 'RCS', '100%'));
    panel.appendChild(this.labeledField('suit-speed', 'EVA SPD', '0.0 m/s'));
    panel.appendChild(this.lamp('hud-suit-lamp', 'SUIT LAMP', 'suit-lamp'));
    panel.appendChild(this.labeledField('altitude', 'ALT', '—'));
    panel.appendChild(this.labeledField('contact', 'GND', '—'));
  }

  private buildBuggyPanel(): void {
    const panel = this.make(
      'section',
      'lunar-hud-buggy',
      'hud-panel buggy-dash is-hidden',
      'buggy-panel',
    );
    this.root.appendChild(panel);
    panel.appendChild(this.heading('BUGGY DASH'));

    const speedRow = this.make('div', 'lunar-hud-speed', 'hud-speed-row');
    const ms = this.make('span', 'hud-speed-ms', 'hud-speed-big', 'speed-ms');
    ms.textContent = '0.0 m/s';
    const kmh = this.make('span', 'hud-speed-kmh', 'hud-speed-small', 'speed-kmh');
    kmh.textContent = '0.0 km/h';
    speedRow.appendChild(ms);
    speedRow.appendChild(kmh);
    panel.appendChild(speedRow);

    panel.appendChild(this.labeledField('cargo', 'CARGO', '0 / 500 kg'));
    panel.appendChild(this.bar('cargo-bar'));
    panel.appendChild(this.labeledField('buggy-battery', 'TRAC BAT', '100%'));
    panel.appendChild(this.bar('buggy-battery-bar'));
    panel.appendChild(this.lamp('hud-buggy-lamp', 'BUGGY LAMPS', 'buggy-lamp'));

    const chips = this.make('div', 'lunar-hud-chips', 'hud-chips');
    for (const [chipKey, label] of [
      ['mounted-chip', 'MOUNTED'],
      ['rolled-chip', 'ROLLED'],
      ['airborne-chip', 'AIRBORNE'],
    ] as const) {
      const chip = this.make('span', `hud-${chipKey}`, 'hud-chip is-hidden', chipKey);
      chip.textContent = label;
      chips.appendChild(chip);
    }
    panel.appendChild(chips);
  }

  private buildScanner(): void {
    const panel = this.make('section', 'lunar-hud-scanner', 'hud-panel scanner-panel', 'scanner-panel');
    this.root.appendChild(panel);
    panel.appendChild(this.heading('MINERAL SCANNER'));
    for (const lineKey of ['scanner-line-1', 'scanner-line-2', 'scanner-line-3'] as const) {
      const line = this.make('div', `hud-${lineKey}`, 'hud-scanner-line', lineKey);
      line.textContent = lineKey === 'scanner-line-1' ? 'NO SIGNATURES' : '';
      panel.appendChild(line);
    }
  }

  private buildPrompts(): void {
    const strip = this.make('div', 'lunar-hud-prompts', 'hud-prompts', 'prompt-strip');
    this.root.appendChild(strip);
    this.promptEls = [];
    for (let i = 0; i < this.promptSlots; i++) {
      const slot = this.make('div', i === 0 ? 'lunar-hud-prompt' : undefined, 'hud-prompt is-hidden');
      strip.appendChild(slot);
      this.promptEls.push(slot);
    }
    // The full key sheet always sits under the prompts as a whisper.
    const legend = this.make('div', 'lunar-hud-legend', 'hud-legend', 'key-legend');
    legend.textContent =
      '[WASD] move · [Space] hop · [Shift] sprint · [E] buggy · [F] lamps · ' +
      '[V] camera · [M] mine · [C] claim · [T] trade · [Esc] close UI';
    strip.appendChild(legend);
  }

  private buildTradeTerminal(commodities: readonly string[]): void {
    const head = this.make('div', undefined, 'trade-head');
    const title = this.make('h2', undefined, 'trade-title');
    title.textContent = 'STATION EXCHANGE';
    head.appendChild(title);
    head.appendChild(this.labeledField('trade-balance', 'BALANCE', '0'));
    const synced = this.make('span', 'hud-trade-synced', 'trade-synced', 'trade-synced');
    synced.textContent = 'awaiting market_sync';
    head.appendChild(synced);
    const close = this.make('button', 'lunar-hud-trade-close', 'trade-close', 'trade-close');
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close trade terminal');
    close.addEventListener?.('click', () => this.hideTradeDialog());
    head.appendChild(close);
    this.tradeRoot.appendChild(head);

    // The order form (esp. its commodity <select>) is built BEFORE the book
    // rows: `ensureTradeRow` mirrors every symbol into that select, so the
    // select must already exist when the pre-booked rows are generated.
    const form = this.make('div', undefined, 'trade-form');
    const commoditySelect = this.make('select', 'lunar-hud-trade-commodity', 'trade-input', 'trade-commodity');
    commoditySelect.setAttribute('aria-label', 'Commodity');
    form.appendChild(commoditySelect);

    const amountInput = this.make('input', 'lunar-hud-trade-amount', 'trade-input', 'trade-amount');
    Object.assign(amountInput as unknown as Record<string, unknown>, {
      type: 'number',
      min: '1',
      step: '1',
      value: '10',
      'aria-label': 'Amount (kg)',
    });
    form.appendChild(amountInput);

    const buy = this.make('button', 'lunar-hud-trade-buy', 'trade-button trade-button-buy', 'trade-buy');
    buy.textContent = 'BUY';
    buy.addEventListener?.('click', () => this.submitOrder(true));
    form.appendChild(buy);

    const sell = this.make('button', 'lunar-hud-trade-sell', 'trade-button trade-button-sell', 'trade-sell');
    sell.textContent = 'SELL';
    sell.addEventListener?.('click', () => this.submitOrder(false));
    form.appendChild(sell);

    this.tradeRoot.appendChild(form);

    const feedback = this.make('div', 'lunar-hud-trade-feedback', 'trade-feedback', 'trade-feedback');
    feedback.textContent = '';
    this.tradeRoot.appendChild(feedback);

    const table = this.make('div', 'lunar-hud-market', 'trade-book', 'trade-book');
    const header = this.make('div', undefined, 'trade-row trade-row-head');
    for (const label of ['COMMODITY', 'BASE', 'BUY', 'SELL', 'RESERVE', 'HELD']) {
      const cell = this.make('span', undefined, 'trade-cell');
      cell.textContent = label;
      header.appendChild(cell);
    }
    table.appendChild(header);
    this.tradeRoot.appendChild(table);
    this.marketTable = table;
    for (const symbol of commodities) this.ensureTradeRow(symbol);
  }

  private appendTradeOption(select: Elementish | undefined, symbol: string): void {
    if (select === undefined || select === null) return;
    if (this.tradeOptions.has(symbol)) return;
    const option = this.make('option', `hud-trade-option-${symbol}`, undefined, `trade-option-${symbol}`);
    option.textContent = symbol;
    Object.assign(option as unknown as Record<string, unknown>, { value: symbol });
    select.appendChild(option);
    this.tradeOptions.add(symbol);
  }

  private ensureTradeRow(symbol: string) {
    const existing = this.tradeRows.get(symbol);
    if (existing !== undefined) return existing;

    const row = this.make('div', `hud-trade-row-${symbol}`, 'trade-row');
    row.setAttribute('data-commodity', symbol);
    const cells: Elementish[] = [];

    const name = this.make('span', undefined, 'trade-cell trade-cell-symbol');
    name.textContent = symbol;
    cells.push(name);
    for (const cellKey of ['base', 'buy', 'sell', 'reserve', 'holding'] as const) {
      const cell = this.make('span', `hud-trade-${cellKey}-${symbol}`, 'trade-cell');
      cell.textContent = '—';
      this.els.set(`${symbol.toLowerCase()}-${cellKey}`, cell);
      cells.push(cell);
    }
    for (const cell of cells) row.appendChild(cell);
    if (this.marketTable !== null) this.marketTable.appendChild(row);

    const entry = {
      row,
      base: cells[1],
      buy: cells[2],
      sell: cells[3],
      reserve: cells[4],
      holding: cells[5],
    };
    this.tradeRows.set(symbol, entry);
    this.appendTradeOption(this.els.get('trade-commodity'), symbol);
    return entry;
  }

  // -- element helpers ---------------------------------------------------------------

  /**
   * Create an element. `id` becomes the DOM id (styled by hud.css); `key` is
   * the stable logical handle used by every update method — keeping the two
   * namespaces separate means CSS can be restyled without touching logic.
   */
  private make(tag: string, id?: string, className?: string, key?: string): Elementish {
    const el = this.doc.createElement(tag) as Elementish;
    if (id !== undefined) {
      el.setAttribute('id', id);
    }
    if (className !== undefined) {
      for (const part of className.split(' ')) {
        if (part.length > 0) el.classList.add(part);
      }
    }
    if (key !== undefined) this.els.set(key, el);
    return el;
  }

  private heading(text: string): Elementish {
    const h = this.make('div', undefined, 'hud-heading');
    h.textContent = text;
    return h;
  }

  private labeledField(key: string, label: string, value: string): Elementish {
    const wrap = this.make('div', `lunar-hud-${key}`, 'hud-field');
    const lab = this.make('span', undefined, 'hud-field-label');
    lab.textContent = label;
    const val = this.make('span', `hud-${key}-value`, 'hud-field-value', `${key}-value`);
    val.textContent = value;
    wrap.appendChild(lab);
    wrap.appendChild(val);
    return wrap;
  }

  private bar(key: string): Elementish {
    const track = this.make('div', `lunar-hud-${key}`, 'hud-bar', `${key}-track`);
    const fill = this.make('div', `lunar-hud-${key}-fill`, 'hud-bar-fill', `${key}-fill`);
    fill.style.width = '100%';
    track.appendChild(fill);
    return track;
  }

  private lamp(id: string, caption: string, key: string): Elementish {
    const lamp = this.make('div', id, 'hud-lamp', key);
    lamp.appendChild(this.make('span', undefined, 'hud-lamp-dot'));
    const text = this.make('span', undefined, 'hud-lamp-label');
    text.textContent = caption;
    lamp.appendChild(text);
    return lamp;
  }

  private setText(key: string, text: string): void {
    const el = this.els.get(key);
    if (el !== undefined) el.textContent = text;
  }

  private setBar(key: string, percent: number, extra: '' | 'is-low' | 'is-critical' | 'is-full'): void {
    const fill = this.els.get(`${key}-fill`);
    if (fill === undefined) return;
    fill.style.width = `${clamp(percent, 0, 100).toFixed(1)}%`;
    this.setClassEl(fill, 'is-low', extra === 'is-low');
    this.setClassEl(fill, 'is-critical', extra === 'is-critical');
    this.setClassEl(fill, 'is-full', extra === 'is-full');
  }

  private setLamp(key: string, on: boolean): void {
    const lamp = this.els.get(key);
    if (lamp === undefined) return;
    this.setClassEl(lamp, 'is-on', on);
  }

  private setChip(key: string, active: boolean): void {
    const chip = this.els.get(key);
    if (chip === undefined) return;
    this.setClassEl(chip, 'is-hidden', !active);
  }

  private setClass(key: string, className: string, on: boolean): void {
    const el = this.els.get(key);
    if (el !== undefined) this.setClassEl(el, className, on);
  }

  private setClassEl(el: Elementish, className: string, on: boolean): void {
    if (on) el.classList.add(className);
    else el.classList.remove(className);
  }

  /** Remove a pre-existing element with this id (idempotent re-init). */
  private disposeExisting(id: string): void {
    const doc = this.doc as unknown as { getElementById?: (id: string) => Elementish | null };
    if (typeof doc.getElementById !== 'function') return;
    const stale = doc.getElementById(id);
    if (stale !== null && stale !== undefined && typeof stale.remove === 'function') {
      stale.remove();
    }
  }
}

export default LunarHUD;
