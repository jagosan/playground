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
 * Panels (spec 13 §3, spec 14 §3.4/§3.5):
 *   • Compass        — top-centre bearing tape (0°–360° + cardinals) with
 *                      tracking pins for 🚗 rover, 🏛️ faction base, 💎 vein.
 *   • Tutorial       — top-right `MISSION ONBOARDING` checklist (5 steps).
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
export const HUD_COMPASS_ID = 'lunar-hud-compass';
export const HUD_TUTORIAL_ID = 'lunar-hud-tutorial';
export const HUD_LAP_ID = 'lunar-hud-lap';
/** Spec 18 §6.2 — narrative comms terminal (glassmorphic CRT panel). */
export const HUD_COMMS_ID = 'lunar-hud-comms';
/** Spec 18 §6.1 — 2D screen-edge clamped hint arrow element. */
export const HUD_HINT_ARROW_ID = 'lunar-hud-hint-arrow';
/**
 * Spec 19 §2.2.2 / ADR-3 — floating operational toast banner. Every gameplay
 * feedback message (mining, mount, capacity rejections) surfaces here at
 * top-centre instead of hiding inside the trade terminal's feedback line.
 */
export const HUD_TOAST_ID = 'lunar-hud-toast';
/** Auto-dismiss window for the toast banner (spec 19 §2.2.2: 3.5 s). */
export const HUD_TOAST_DISMISS_MS = 3500;

/** Sector split slots on the proving-grounds lap panel (S1/S2 + total). */
export const HUD_LAP_SECTOR_SLOTS = 3;

/**
 * A structural clone of Spec 17's `LapTelemetry` (from
 * `engine/ProvingGroundsScene.ts`) declared locally so the HUD keeps its
 * zero-import contract — `import type` from the engine barrel would drag
 * Babylon into HUD-only harnesses. Structurally identical; the scene type
 * is assignable to this one.
 */
export interface HudLapTelemetry {
  /** Lap in progress (1-based; 0 = post-dispose/idle). */
  currentLap: number;
  /** Elapsed time on the current lap, seconds. */
  currentLapTimeS: number;
  /** Best completed lap, seconds; null until the first valid lap. */
  bestLapTimeS: number | null;
  /** Most recent completed lap, seconds; null before the first. */
  lastLapTimeS: number | null;
  /** Completed sector splits of the current lap, seconds (in order). */
  sectorTimesS: number[];
  /** Instantaneous road speed, km/h. */
  currentSpeedKmh: number;
  /** Top speed since reset, km/h. */
  topSpeedKmh: number;
  /** Best speed-trap capture, km/h; null until captured. */
  speedTrapKmh: number | null;
  /** Last sector split minus the same sector of the previous lap (s). */
  sectorDeltaS: number | null;
}

/** Compass tape: 8 major ticks (every 45° = 360/8), window ±90° of heading. */
export const HUD_COMPASS_TAPE_TICKS = 8;
export const HUD_COMPASS_TAPE_SPAN_DEG = 45;
export const HUD_COMPASS_WINDOW_DEG = 90;

/** The five guided-onboarding steps, in canonical order (spec 14 §3.5). */
export const HUD_TUTORIAL_STEPS: readonly string[] = [
  'Move & Low-g Hop (WASD / Space)',
  'Locate Mineral Deposit (follow compass 💎)',
  'Extract Mineral Ore (Press [M])',
  'Rover Operations (Approach 🚗 & press [E])',
  'Station Exchange (Press [T] to trade)',
];

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
  /** Spec 19 §2.3.3: transfer backpack haul to the parked rover's flatbed. */
  stow: { label: 'Stow Cargo to Buggy', order: 12 },
  mine: { label: 'Mine Vein', order: 20 },
  claim: { label: 'Stake Claim', order: 30 },
  trade: { label: 'Trade', order: 40 },
} as const;

export type HudPromptKind = keyof typeof HUD_PROMPT_KINDS;

/**
 * Spec 19 §2.1.6: which device produced the last input. The prompt strip
 * re-glyphs itself — `[E]`/`[M]`/`[T]` on keyboard, `(X)`/`(RB)`/`(B)` on a
 * live gamepad — so a controller driver never chases keys they cannot press.
 */
export type HudInputSource = 'keyboard' | 'gamepad';

/**
 * Canonical gamepad glyphs per prompt kind (Spec 19 §2.1.5 action sheet).
 * Kinds without a pad binding (claim) keep their keyboard glyph in either
 * source mode.
 */
export const HUD_GAMEPAD_GLYPHS: Readonly<Partial<Record<HudPromptKind, string>>> = {
  drive: 'X',
  dismount: 'X',
  stow: 'X',
  mine: 'RB',
  trade: 'B',
};

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
  /** Spec 19 §2.3.4: backpack load in kg (paints the CARGO field + bar). */
  cargoMass?: number;
  /** Backpack ceiling in kg (spec: 50). */
  cargoCapacity?: number;
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

/** A tracked landmark pin on the compass tape (spec 14 §3.4). */
export interface HudCompassBearing {
  /** Bearing from the local player to the landmark, degrees (0 = N, clockwise). */
  bearing: number;
  /** Slant distance in metres. */
  dist: number;
}

export interface HudCompassBaseBearing extends HudCompassBearing {
  /** Faction / base name shown beside the 🏛️ pin. */
  name: string;
}

export interface HudCompassVeinBearing extends HudCompassBearing {
  /** Vein resource kind shown beside the 💎 pin (e.g. `ilmenite`). */
  kind: string;
  /** Bearing minus heading, wrapped to (-180, 180] (TASK-PLAY-063c). */
  relBearing?: number;
  /** Guidance arrow prefixed to the readout: '◀' | '▲' | '▶' (TASK-PLAY-063c). */
  arrow?: string;
}

/** Everything `updateCompass()` can pin at once — any subset may be absent. */
export interface HudCompassTargets {
  buggy?: HudCompassBearing;
  base?: HudCompassBaseBearing;
  vein?: HudCompassVeinBearing;
}

// -- Spec 18: comms terminal & hint arrow payloads -------------------------

/** Audio burst tone shown by the comms status pip (spec 18 §6.2). */
export type HudCommsTone = 'burst' | 'alert' | 'success' | 'static';

/**
 * Structural clone of QuestEngine's `CommsDialogue` (spec 18 §4.1) declared
 * locally so the HUD keeps its zero-import contract — importing from
 * `client/QuestEngine.ts` would couple HUD-only harnesses to the quest
 * module. Field-for-field compatible; a QuestEngine dialogue assigns here.
 */
export interface HudCommsDialogue {
  sender: string;
  callsign: string;
  transmission: string;
  audioTone?: HudCommsTone;
  /** Hide automatically this many ms after reveal (0/absent = sticky). */
  autoDismissMs?: number;
}

/**
 * Frame payload for the screen-edge clamped hint arrow (spec 18 §6.1,
 * ADR-18-2). Emitted by `HintArrowSystem.update()` every frame; `null`
 * hides the element entirely.
 */
export interface HudHintArrowData {
  visible: boolean;
  /** Screen px (CSS left/top semantics: origin top-left, y down). */
  screenX?: number;
  screenY?: number;
  /** Compass-style rotation of the arrow glyph, degrees. */
  angleDeg?: number;
  /** Slant range to the waypoint, metres. */
  distanceM?: number;
  /** Waypoint display label ("Ilmenite outcrop"). */
  label?: string;
  /** True when the target is off-screen and this is a perimeter clamp. */
  isOffScreen?: boolean;
}

/**
 * Dynamic quest overlay for `updateTutorial()` (spec 18 Phase 3): when a
 * QuestEngine-backed stage is passed, the panel re-titles itself and renders
 * that stage's objectives instead of the legacy static checklist rows.
 */
export interface HudQuestStageDisplay {
  /** Quest title shown as the panel heading context line. */
  questTitle?: string;
  /** Active stage title ("Boots on the Ground"). */
  stageTitle?: string;
  /** 1-based stage number (progress readout becomes `2 / 5`-style). */
  stageNumber?: number;
  /** Total stage count of the active quest. */
  stageTotal?: number;
  /** Objectives of the active stage (multi-objective rendering). */
  objectives?: readonly {
    id: string;
    description: string;
    completed?: boolean;
  }[];
}


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
  /** Width plus free-form CSS custom props (`left`, `transform`, `opacity`). */
  style: { width: string; [key: string]: string };
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

/** Wrap any angle to [0, 360). */
function wrap360(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return ((deg % 360) + 360) % 360;
}

/** Signed shortest signed offset of `deg` from `from`, in [-180, 180). */
function angleDelta(deg: number, from: number): number {
  return ((wrap360(deg) - wrap360(from) + 540) % 360) - 180;
}

const COMPASS_CARDINALS: readonly string[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Lap-clock formatter: seconds → `MM:SS.mmm` (Spec 17 Phase 4 HUD).
 * Negative times keep a leading `−`; non-finite renders as an em dash.
 */
export function formatLapTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const sign = seconds < 0 ? '−' : '';
  const total = Math.abs(seconds);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  // Round (not floor): binary fractions land just BELOW their decimal value
  // (24.9 → 24.8999…), and floor would render 00:24.899 on the HUD clock.
  const millis = Math.round((total - Math.floor(total)) * 1000) % 1000;
  return `${sign}${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** Signed signed-time delta formatter: `+1.234` / `−0.045` seconds. */
export function formatLapDelta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const sign = seconds < 0 ? '−' : '+';
  return `${sign}${Math.abs(seconds).toFixed(3)}`;
}

/** 8-wind cardinal label for a bearing (0° → N, 45° → NE, …). */
function cardinal(bearingDeg: number): string {
  return COMPASS_CARDINALS[Math.round(wrap360(bearingDeg) / 45) % 8];
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
  /** Compass tape tick marks (fixed count, repositioned every frame). */
  private compassTicks: Elementish[] = [];
  /** Per-pin readout spans (built once; `updateCompass` only rewrites text). */
  private readonly compassPinReadouts = new Map<string, Elementish>();
  /** Tutorial checklist rows + their ✔/□ glyph cells. */
  private tutorialSteps: Elementish[] = [];
  private tutorialMarks: Elementish[] = [];
  /** Dynamic QuestEngine objective rows + marks (spec 18 Phase 3). */
  private questObjectiveRows: Elementish[] = [];
  private questObjectiveMarks: Elementish[] = [];
  private questBodyEl: Elementish | null = null;
  private marketTable: Elementish | null = null;
  /** Proving-grounds sector split cells (S1 / S2 / running remainder). */
  private lapSectorEls: Elementish[] = [];
  private lapPanelVisible = false;
  private readonly tradeRows = new Map<
    string,
    { row: Elementish; base: Elementish; buy: Elementish; sell: Elementish; reserve: Elementish; holding: Elementish }
  >();
  private readonly tradeOptions = new Set<string>();

  private tradeOpen = false;
  private hudHidden = false;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Spec 19 §2.2.2 — toast auto-dismiss timer (independent of trade line). */
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /**
   * Spec 19 §2.1.6 — last-active input device. `setInputSource()` repaints
   * the prompt strip (and the key-sheet legend) when it flips.
   */
  private inputSource: HudInputSource = 'keyboard';
  /** Last prompts handed to `setPrompts` (re-rendered on source flip). */
  private lastPrompts: readonly HudPrompt[] = [];
  /** The key-sheet whisper under the prompts (source-dependent text). */
  private legendEl: Elementish | null = null;

  /** Spec 18 §6.2 — comms terminal state. */
  private commsVisible = false;
  private commsDismissTimer: ReturnType<typeof setTimeout> | null = null;
  private commsTypeTimer: ReturnType<typeof setInterval> | null = null;
  private commsFullText = '';
  private commsCharsShown = 0;
  /** Last hint-arrow payload painted (harness / integration readback). */
  private hintArrowData: HudHintArrowData | null = null;

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
    this.buildCompass();
    this.buildToast();
    this.buildLifeSupport();
    this.buildBuggyPanel();
    this.buildLapPanel();
    this.buildScanner();
    this.buildPrompts();
    this.buildTutorial();
    this.buildCommsPanel();
    this.buildHintArrow();
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
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.clearCommsTimers();
    this.tradeRows.clear();
    this.tradeOptions.clear();
    this.promptEls = [];
    this.compassTicks = [];
    this.compassPinReadouts.clear();
    this.tutorialSteps = [];
    this.tutorialMarks = [];
    this.questObjectiveRows = [];
    this.questObjectiveMarks = [];
    this.lapSectorEls = [];
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

  /**
   * Spec 19 §2.2.2 / ADR-3 — float the operational toast banner at top
   * centre (glassmorphic pill). This is the VISIBLE gameplay feedback
   * channel: mining results, mount/dismount, capacity rejections. Distinct
   * from {@link showFeedback}, which paints the trade terminal's own line
   * (only legible with the modal open). Re-arms the 3.5 s auto-dismiss on
   * every message; `kind` paints the pill (`toast-success` / `toast-error`).
   */
  showToast(message: string, kind: HudFeedbackKind = 'info'): void {
    if (this.disposed) return;
    const toast = this.els.get('toast');
    if (toast === undefined) return;
    toast.textContent = message;
    // Mirror into an attribute: headless DOMs without CSS cadence (and
    // screen readers) read the finished toast immediately.
    toast.setAttribute('data-toast', message);
    toast.setAttribute('data-toast-kind', kind);
    this.setClassEl(toast, 'toast-success', kind === 'success');
    this.setClassEl(toast, 'toast-error', kind === 'error');
    this.setClassEl(toast, 'is-hidden', message.length === 0);
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    if (message.length > 0) {
      this.toastTimer = setTimeout(() => {
        this.toastTimer = null;
        if (!this.disposed) this.clearToast();
      }, HUD_TOAST_DISMISS_MS);
      const handle = this.toastTimer as unknown as { unref?: () => void };
      if (typeof handle.unref === 'function') handle.unref();
    }
  }

  /** Retract the toast banner (cancels its auto-dismiss timer). */
  clearToast(): void {
    if (this.disposed) return;
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    const toast = this.els.get('toast');
    if (toast === undefined) return;
    toast.textContent = '';
    toast.setAttribute('data-toast', '');
    this.setClassEl(toast, 'is-hidden', true);
    this.setClassEl(toast, 'toast-success', false);
    this.setClassEl(toast, 'toast-error', false);
  }

  /** Current toast text ('' when retracted) — harness readback. */
  toastText(): string {
    return this.textOf('toast');
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
    // Spec 19 §2.3.4: backpack cargo — `CARGO: XX / 50 kg` + fill bar, using
    // the same `is-full` treatment as the buggy flatbed meter (the on-foot
    // mirror of the dash readout).
    if (t.cargoMass !== undefined) {
      const suitCapacity = t.cargoCapacity ?? 50;
      const haul = clamp(t.cargoMass, 0, suitCapacity);
      this.setText('suit-cargo-value', `${num(haul, 0)} / ${num(suitCapacity, 0)} kg`);
      this.setBar(
        'suit-cargo-bar',
        (haul / suitCapacity) * 100,
        haul >= suitCapacity ? 'is-full' : '',
      );
    }
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

  // -- proving grounds lap timing (Spec 17 Phase 4) --------------------------------

  /** Show or hide the proving-grounds lap-timing panel (track mode only). */
  setLapPanelVisible(visible: boolean): void {
    if (this.disposed) return;
    this.lapPanelVisible = visible;
    this.setClass('lap-panel', 'is-hidden', !visible);
  }

  isLapPanelVisible(): boolean {
    return this.lapPanelVisible && !this.disposed;
  }

  /**
   * Paint the proving-grounds lap-timing overlay (Spec 17 §3.3): lap counter,
   * current lap clock (MM:SS.mmm), best lap, per-sector splits with delta
   * against the previous lap, speed-trap and top-speed readouts.
   */
  updateLapTelemetry(t: HudLapTelemetry): void {
    if (this.disposed) return;

    this.setText('lap-count-value', t.currentLap > 0 ? `LAP ${t.currentLap}` : '—');
    this.setText('lap-current-value', formatLapTime(t.currentLapTimeS));
    this.setText('lap-best-value', formatLapTime(t.bestLapTimeS));
    this.setText('lap-last-value', formatLapTime(t.lastLapTimeS));

    // Sector splits: slot 0 = S1, slot 1 = S2, slot 2 = the running remainder
    // of the lap once both gates are behind the driver (S3 completes on the
    // finish crossing, which also clears the slots).
    const splits = Array.isArray(t.sectorTimesS) ? t.sectorTimesS : [];
    for (let i = 0; i < this.lapSectorEls.length; i++) {
      const el = this.lapSectorEls[i];
      if (i < 2) {
        el.textContent = i < splits.length ? formatLapTime(splits[i]) : '—';
      } else {
        let done = 0;
        for (const v of splits) done += Number.isFinite(v) ? v : 0;
        el.textContent =
          splits.length >= 2 ? formatLapTime(Math.max(0, t.currentLapTimeS - done)) : '—';
      }
    }

    const delta = t.sectorDeltaS;
    const deltaEl = this.els.get('lap-delta-value');
    if (deltaEl !== undefined) {
      deltaEl.textContent = formatLapDelta(delta);
      this.setClassEl(deltaEl, 'is-faster', delta !== null && delta < 0);
      this.setClassEl(deltaEl, 'is-slower', delta !== null && delta !== 0 && delta >= 0);
    }

    this.setText(
      'speed-trap-value',
      t.speedTrapKmh === null || t.speedTrapKmh === undefined
        ? '—'
        : `${num(t.speedTrapKmh, 1)} km/h`,
    );
    this.setText('top-speed-value', `${num(t.topSpeedKmh, 1)} km/h`);
    this.setLamp('speed-trap-lamp', t.speedTrapKmh !== null && t.speedTrapKmh !== undefined);
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
   * Glyphs render per the active input source (Spec 19 §2.1.6): keyboard
   * shows `[E]`-style brackets, gamepad shows the console-style `(X)`/`(RB)`
   * binding for that prompt kind (falling back to brackets for kinds with
   * no pad binding, e.g. claim).
   */
  setPrompts(prompts: readonly HudPrompt[]): void {
    if (this.disposed) return;
    this.lastPrompts = prompts;
    const sorted = [...prompts].sort((a, b) => this.orderOf(a) - this.orderOf(b));
    for (let i = 0; i < this.promptEls.length; i++) {
      const slot = this.promptEls[i];
      const prompt = sorted[i];
      if (prompt === undefined) {
        this.setClassEl(slot, 'is-hidden', true);
        continue;
      }
      const kind = (prompt.kind ?? 'trade') as HudPromptKind;
      const label = prompt.label ?? HUD_PROMPT_KINDS[kind]?.label ?? 'Interact';
      // Gamepad source swaps in the console glyph when the kind has one;
      // kinds without a pad binding (claim) keep their keyboard bracket.
      const padGlyph = this.inputSource === 'gamepad' ? HUD_GAMEPAD_GLYPHS[kind] : undefined;
      slot.textContent = '';
      const key = this.make('span', undefined, 'hud-key');
      key.textContent = padGlyph !== undefined ? `(${padGlyph})` : `[${prompt.key}]`;
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

  /**
   * Spec 19 §2.1.6 — declare which device produced the last input. Flipping
   * the source repaints the live prompt strip and swaps the key-sheet
   * legend to the pad sheet. Idempotent for repeats of the same source.
   */
  setInputSource(source: HudInputSource): void {
    if (this.disposed) return;
    if (this.inputSource === source) return;
    this.inputSource = source;
    this.setPrompts(this.lastPrompts);
    this.paintLegend();
  }

  /** Currently-active input source for the prompt glyphs. */
  getInputSource(): HudInputSource {
    return this.inputSource;
  }

  private paintLegend(): void {
    if (this.legendEl === null) return;
    this.legendEl.textContent =
      this.inputSource === 'gamepad'
        ? '(L-Stick) move · (A) hop / handbrake · (LB) sprint · (X) buggy · (Y) lamps · ' +
          '(R3) camera · (RB) mine · (C) claim · (B) trade · (D-Up) comms · (LT) brake / reverse'
        : '[WASD] move · [Space] hop · [Shift] sprint · [E] buggy · [F] lamps · ' +
          '[V] camera · [M] mine · [C] claim · [T] trade · [Esc] close UI';
  }

  private orderOf(prompt: HudPrompt): number {
    if (prompt.order !== undefined) return prompt.order;
    return HUD_PROMPT_KINDS[(prompt.kind ?? 'trade') as HudPromptKind]?.order ?? 50;
  }

  /** Cancel both comms timers (typewriter + auto-dismiss). Idempotent. */
  private clearCommsTimers(): void {
    this.clearCommsTypeTimer();
    if (this.commsDismissTimer !== null) {
      clearTimeout(this.commsDismissTimer);
      this.commsDismissTimer = null;
    }
  }

  private clearCommsTypeTimer(): void {
    if (this.commsTypeTimer !== null) {
      clearInterval(this.commsTypeTimer);
      this.commsTypeTimer = null;
    }
  }

  // -- compass (spec 14 §3.4) --------------------------------------------------------

  /**
   * Paint the top-centre bearing tape: the current heading readout
   * (`123° NE`), eight sliding tape ticks (N/NE/E/… every 45°, each at
   * `(bearing − heading + 180) / 360` of the tape width so the heading you
   * face sits dead centre), and the landmark tracking pins 🚗 / 🏛️ / 💎
   * with bearing + distance. Absent targets hide their pin; targets outside
   * the ±90° window clamp to the tape edge and gain an `is-edge` class so
   * CSS can dim them behind the frame gradient.
   */
  updateCompass(
    headingDeg: number,
    targets: HudCompassTargets = {},
  ): void {
    if (this.disposed) return;
    const heading = wrap360(headingDeg);

    this.setText('compass-value', `${Math.round(heading)}° ${cardinal(heading)}`);
    this.setText('compass-heading', `${Math.round(heading)}°`);

    // Tape ticks slide so the faced bearing is always centred.
    for (const tick of this.compassTicks) {
      const tickDeg = Number(tick.getAttribute('data-deg') ?? 0);
      const delta = angleDelta(tickDeg, heading);
      const inside = Math.abs(delta) <= HUD_COMPASS_WINDOW_DEG;
      const leftPct = ((delta / HUD_COMPASS_WINDOW_DEG) * 0.5 + 0.5) * 100;
      tick.style['left'] = `${leftPct.toFixed(2)}%`;
      tick.style['opacity'] = inside ? '1' : '0';
    }

    this.setCompassPin('compass-pin-buggy', heading, targets.buggy);
    this.setCompassPin('compass-pin-base', heading, targets.base, targets.base?.name);
    this.setCompassPin('compass-pin-vein', heading, targets.vein, targets.vein?.kind);
  }

  private setCompassPin(
    key: string,
    heading: number,
    target: HudCompassBearing | undefined,
    name?: string,
  ): void {
    const pin = this.els.get(key);
    if (pin === undefined) return;
    if (target === undefined || !Number.isFinite(target.bearing)) {
      this.setClassEl(pin, 'is-hidden', true);
      return;
    }
    const delta = angleDelta(target.bearing, heading);
    const clamped = clamp(delta, -HUD_COMPASS_WINDOW_DEG, HUD_COMPASS_WINDOW_DEG);
    const leftPct = ((clamped / HUD_COMPASS_WINDOW_DEG) * 0.5 + 0.5) * 100;
    pin.style['left'] = `${leftPct.toFixed(2)}%`;
    const label = name !== undefined && name.length > 0 ? String(name).toUpperCase() : '';
    const readout = this.compassPinReadouts.get(key);
    if (readout !== undefined) {
      const arrow = (target as HudCompassVeinBearing).arrow;
      const arrowPrefix = arrow !== undefined && arrow.length > 0 ? `${arrow} ` : '';
      readout.textContent =
        `${arrowPrefix}${label.length > 0 ? `${label} ` : ''}${Math.round(wrap360(target.bearing))}° · ${num(target.dist, 0)} m`;
    }
    pin.setAttribute('data-arrow', (target as HudCompassVeinBearing).arrow ?? '');
    this.setClassEl(pin, 'is-hidden', false);
    this.setClassEl(pin, 'is-edge', Math.abs(delta) > HUD_COMPASS_WINDOW_DEG);
  }

  // -- onboarding tutorial (spec 14 §3.5) ---------------------------------------------

  /**
   * Paint the top-right `MISSION ONBOARDING` checklist. `stepIndex` is the
   * first *incomplete* step (0-based); every step before it renders done,
   * the step itself renders active/pulsing, later steps render pending.
   * `completed` is the authoritative per-step flag array from ClientApp's
   * state machine (it wins over `stepIndex` when the two disagree). Passing
   * `stepIndex >= 5` or an all-true `completed` marks the whole run done and
   * adds `tutorial-complete` to the widget.
   */
  updateTutorial(stepIndex: number, completed: boolean[]): void {
    if (this.disposed) return;
    for (let i = 0; i < this.tutorialSteps.length; i++) {
      const row = this.tutorialSteps[i];
      const mark = this.tutorialMarks[i];
      const done = completed[i] === true || i < stepIndex;
      const active = !done && i === stepIndex;
      mark.textContent = done ? '✔' : '□';
      this.setClassEl(row, 'is-done', done);
      this.setClassEl(row, 'is-active', active);
      this.setClassEl(row, 'is-pending', !done && !active);
    }
    const allDone = stepIndex >= this.tutorialSteps.length ||
      this.tutorialSteps.every((_row, i) => completed[i] === true);
    this.setClass('tutorial-panel', 'tutorial-complete', allDone);
    this.setText('tutorial-progress', allDone ? 'COMPLETE' : `${stepIndex + 1} / ${this.tutorialSteps.length}`);
  }

  /** Hide / show the whole onboarding widget (e.g. after completion + delay). */
  setTutorialVisible(visible: boolean): void {
    if (this.disposed) return;
    this.setClass('tutorial-panel', 'is-hidden', !visible);
  }

  /**
   * Quest-aware tutorial paint (Spec 18 Phase 3). The legacy
   * `updateTutorial(stepIndex, completed)` call shape keeps working; passing
   * the optional third argument overlays the active QuestEngine stage: the
   * panel heading gains the quest title, a stage-title line renders below the
   * progress readout, and the body re-renders as the stage's (possibly
   * multiple) objectives instead of the static 5-step checklist. Omitting
   * `quest` (or passing one with no objectives) restores the legacy rows.
   */
  setQuestStage(
    stepIndex: number,
    completed: boolean[],
    quest?: HudQuestStageDisplay,
  ): void {
    if (this.disposed) return;
    const objectives = quest?.objectives ?? [];
    if (objectives.length === 0) {
      // Legacy mode: hide the dynamic body, repaint the static checklist.
      if (this.questBodyEl !== null) this.setClassEl(this.questBodyEl, 'is-hidden', true);
      this.setClassEl(this.els.get('tutorial-stage-title') ?? this.root, 'is-hidden', true);
      for (const row of this.tutorialSteps) this.setClassEl(row, 'is-hidden', false);
      this.setClass('tutorial-panel', 'quest-mode', false);
      this.updateTutorial(stepIndex, completed);
      return;
    }

    // Dynamic quest mode: the static 5-step checklist yields to the live
    // objective rows so the panel never renders two competing lists.
    for (const row of this.tutorialSteps) this.setClassEl(row, 'is-hidden', true);
    this.setClass('tutorial-panel', 'quest-mode', true);
    if (this.questBodyEl !== null) this.setClassEl(this.questBodyEl, 'is-hidden', false);
    const questTitle = quest?.questTitle;
    this.setText(
      'tutorial-heading',
      questTitle !== undefined && questTitle.length > 0
        ? `MISSION · ${questTitle.toUpperCase()}`
        : 'MISSION ONBOARDING',
    );
    const stageTitleEl = this.els.get('tutorial-stage-title');
    if (stageTitleEl !== undefined) {
      stageTitleEl.textContent = quest?.stageTitle ?? '';
      this.setClassEl(stageTitleEl, 'is-hidden', (quest?.stageTitle ?? '').length === 0);
    }
    if (quest?.stageNumber !== undefined && quest?.stageTotal !== undefined) {
      this.setText(
        'tutorial-progress',
        `${quest.stageNumber} / ${quest.stageTotal}`,
      );
    }

    // Objective rows: reuse pooled rows, rebuild labels, stamp done/active.
    for (let i = 0; i < objectives.length; i++) {
      let row = this.questObjectiveRows[i];
      if (row === undefined) {
        row = this.make(
          'div',
          undefined,
          'tutorial-step tutorial-objective is-pending',
          `quest-objective-row-${i}`,
        );
        const mark = this.make('span', undefined, 'tutorial-mark', `quest-objective-mark-${i}`);
        mark.textContent = '□';
        const label = this.make('span', undefined, 'tutorial-label');
        row.appendChild(mark);
        row.appendChild(label);
        this.questObjectiveRows[i] = row;
        this.questObjectiveMarks[i] = mark;
        this.questBodyEl?.appendChild(row);
      }
      const objective = objectives[i];
      row.setAttribute('data-objective-id', objective.id);
      const labelEl = row.children[1];
      if (labelEl !== undefined) labelEl.textContent = objective.description;
      const done = objective.completed === true;
      const active = !done && i === 0;
      this.questObjectiveMarks[i].textContent = done ? '✔' : '□';
      this.setClassEl(row, 'is-done', done);
      this.setClassEl(row, 'is-active', active);
      this.setClassEl(row, 'is-pending', !done && !active);
    }
    for (let i = objectives.length; i < this.questObjectiveRows.length; i++) {
      this.setClassEl(this.questObjectiveRows[i], 'is-hidden', true);
    }
  }

  // -- narrative comms terminal (spec 18 §6.2) ---------------------------------

  /**
   * Reveal a corporate burst transmission in the comms terminal: header
   * (dispatcher callsign + sender + faction insignia pip), typewriter body
   * (full text always mirrored into `data-full` for headless assertions),
   * and a tone pip (`burst`/`alert`/`success`/`static`). Schedules
   * {@link hideComms} after `autoDismissMs` when provided.
   */
  showComms(dialogue: HudCommsDialogue): void {
    if (this.disposed) return;
    this.clearCommsTimers();

    this.setText('comms-sender', String(dialogue.callsign ?? 'UNKNOWN'));
    this.setText('comms-origin', String(dialogue.sender ?? ''));
    const tone: HudCommsTone = dialogue.audioTone ?? 'static';
    this.setText('comms-tone', tone.toUpperCase());
    for (const candidate of ['burst', 'alert', 'success', 'static'] as const) {
      this.setClass('comms-tone-pulse', `tone-${candidate}`, candidate === tone);
    }

    // Typewriter reveal. The DOM text animates; `data-full` is authoritative
    // immediately so smoke harnesses (and screen readers) see the finished
    // transmission without waiting on interval scheduling.
    this.commsFullText = String(dialogue.transmission ?? '');
    this.commsCharsShown = 0;
    const body = this.els.get('comms-body');
    if (body !== undefined) {
      body.setAttribute('data-full', this.commsFullText);
      body.setAttribute('data-tone', tone);
      body.textContent = '';
    }
    const step = Math.max(1, Math.ceil(this.commsFullText.length / 48));
    this.commsTypeTimer = setInterval(() => {
      if (this.disposed) return;
      this.commsCharsShown = Math.min(this.commsCharsShown + step, this.commsFullText.length);
      this.setText('comms-text', this.commsFullText.slice(0, this.commsCharsShown));
      if (this.commsCharsShown >= this.commsFullText.length) {
        this.clearCommsTypeTimer();
      }
    }, 28);
    const typeHandle = this.commsTypeTimer as unknown as { unref?: () => void };
    if (typeof typeHandle.unref === 'function') typeHandle.unref();

    this.setClass('comms-panel', 'is-hidden', false);
    this.commsVisible = true;

    const dismissMs = dialogue.autoDismissMs;
    if (dismissMs !== undefined && Number.isFinite(dismissMs) && dismissMs > 0) {
      this.commsDismissTimer = setTimeout(() => {
        this.commsDismissTimer = null;
        if (!this.disposed) this.hideComms();
      }, dismissMs);
      const handle = this.commsDismissTimer as unknown as { unref?: () => void };
      if (typeof handle.unref === 'function') handle.unref();
    }
  }

  /** Dismiss the comms terminal (cancels typewriter + auto-dismiss timers). */
  hideComms(): void {
    if (this.disposed) return;
    this.clearCommsTimers();
    this.commsVisible = false;
    this.setClass('comms-panel', 'is-hidden', true);
  }

  /** True while a transmission is on screen. */
  isCommsVisible(): boolean {
    return this.commsVisible && !this.disposed;
  }

  // -- 2D screen-edge hint arrow (spec 18 §6.1, ADR-18-2) -----------------------

  /**
   * Paint the perimeter hint arrow from a `HintArrowSystem` frame payload.
   * `null` / `{visible:false}` hides the widget. When off-screen the element
   * snaps to the clamped border coordinates and its glyph rotates to
   * `angleDeg`; when in-view it trails the 3D chevron showing only the
   * distance chip.
   */
  updateHintArrow(data: HudHintArrowData | null): void {
    if (this.disposed) return;
    this.hintArrowData = data;
    const arrow = this.els.get('hint-arrow');
    if (arrow === undefined) return;

    if (data === null || data.visible !== true) {
      this.setClassEl(arrow, 'is-hidden', true);
      return;
    }

    const x = Number.isFinite(data.screenX) ? (data.screenX as number) : 0;
    const y = Number.isFinite(data.screenY) ? (data.screenY as number) : 0;
    const angle = Number.isFinite(data.angleDeg) ? (data.angleDeg as number) : 0;
    arrow.style['left'] = `${x.toFixed(1)}px`;
    arrow.style['top'] = `${y.toFixed(1)}px`;

    const glyph = this.els.get('hint-arrow-glyph');
    if (glyph !== undefined) {
      glyph.style['transform'] = `rotate(${angle.toFixed(1)}deg)`;
    }
    this.setText(
      'hint-arrow-distance',
      data.distanceM !== undefined && Number.isFinite(data.distanceM)
        ? `${Math.round(data.distanceM)}m`
        : '',
    );
    this.setText('hint-arrow-label', data.label ?? '');

    this.setClassEl(arrow, 'is-offscreen', data.isOffScreen === true);
    this.setClassEl(arrow, 'is-inview', data.isOffScreen !== true);
    this.setClassEl(arrow, 'is-hidden', false);
  }

  /** Last payload handed to {@link updateHintArrow} (harness readback). */
  getHintArrowData(): HudHintArrowData | null {
    return this.hintArrowData;
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

  /**
   * Top-centre bearing tape (spec 14 §3.4): heading readout, a sliding tick
   * strip (one tick per 45° of bearing, cardinal-labelled), and three
   * landmark pins repositioned by `updateCompass()`.
   */
  private buildCompass(): void {
    const band = this.make('div', HUD_COMPASS_ID, 'hud-compass', 'compass-panel');
    this.root.appendChild(band);

    const heading = this.make('div', 'lunar-hud-compass-heading', 'compass-heading-value', 'compass-heading');
    heading.textContent = '0°';
    band.appendChild(heading);
    const readout = this.make('div', 'lunar-hud-compass-value', 'compass-readout', 'compass-value');
    readout.textContent = '0° N';
    band.appendChild(readout);

    const tape = this.make('div', 'lunar-hud-compass-tape', 'compass-tape', 'compass-tape');
    this.compassTicks = [];
    for (let i = 0; i < HUD_COMPASS_TAPE_TICKS; i++) {
      const deg = i * HUD_COMPASS_TAPE_SPAN_DEG;
      const tick = this.make('div', `hud-compass-tick-${deg}`, 'compass-tick');
      tick.setAttribute('data-deg', String(deg));
      const mark = this.make('span', undefined, 'compass-tick-mark');
      mark.textContent = '|';
      const label = this.make('span', undefined, 'compass-tick-label');
      label.textContent = COMPASS_CARDINALS[i % COMPASS_CARDINALS.length];
      tick.appendChild(mark);
      tick.appendChild(label);
      tape.appendChild(tick);
      this.compassTicks.push(tick);
    }
    band.appendChild(tape);

    // Centre caret over the tape — the "you are facing here" hairline.
    const caret = this.make('div', 'lunar-hud-compass-caret', 'compass-caret');
    caret.textContent = '▼';
    band.appendChild(caret);

    for (const [key, icon] of [
      ['compass-pin-buggy', '🚗'],
      ['compass-pin-base', '🏛️'],
      ['compass-pin-vein', '💎'],
    ] as const) {
      const pin = this.make('div', `lunar-hud-${key}`, 'compass-pin is-hidden', key);
      pin.setAttribute('data-target', key.replace('compass-pin-', ''));
      const glyphEl = this.make('span', undefined, 'compass-pin-icon');
      glyphEl.textContent = icon;
      const readoutEl = this.make('span', undefined, 'compass-pin-readout');
      readoutEl.textContent = '';
      pin.appendChild(glyphEl);
      pin.appendChild(readoutEl);
      this.compassPinReadouts.set(key, readoutEl);
      band.appendChild(pin);
    }
  }

  /**
   * Floating operational toast (Spec 19 §2.2.2 / ADR-3): top-centre
   * glassmorphic pill, hidden until `showToast()`. Text mirrors into the
   * `data-toast` attribute for headless assertions (fake DOMs have no CSS
   * cadence).
   */
  private buildToast(): void {
    const toast = this.make('div', HUD_TOAST_ID, 'hud-toast is-hidden', 'toast');
    toast.setAttribute('data-toast', '');
    this.root.appendChild(toast);
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
    // Spec 19 §2.3.4: backpack haul readout — `CARGO: XX / 50 kg` + fill bar,
    // the on-foot mirror of the buggy dash's 500 kg flatbed meter.
    panel.appendChild(this.labeledField('suit-cargo', 'CARGO', '0 / 50 kg'));
    panel.appendChild(this.bar('suit-cargo-bar'));
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

  /**
   * Proving-grounds lap-timing overlay (Spec 17 Phase 4): lap counter, big
   * current-lap clock (MM:SS.mmm), best/last lap, S1/S2 splits with running
   * remainder, sector delta, and the speed-trap / top-speed readouts.
   * Hidden until `setLapPanelVisible(true)` (track mode only).
   */
  private buildLapPanel(): void {
    const panel = this.make(
      'section',
      HUD_LAP_ID,
      'hud-panel lap-timing is-hidden',
      'lap-panel',
    );
    this.root.appendChild(panel);
    panel.appendChild(this.heading('PROVING GROUNDS'));

    panel.appendChild(this.labeledField('lap-count', 'LAP', '—'));

    const clock = this.make('div', 'lunar-hud-lap-current', 'hud-speed-row', 'lap-current-row');
    const big = this.make('span', 'hud-lap-current-value', 'hud-speed-big', 'lap-current-value');
    big.textContent = '00:00.000';
    clock.appendChild(big);
    panel.appendChild(clock);

    panel.appendChild(this.labeledField('lap-best', 'BEST LAP', '—'));
    panel.appendChild(this.labeledField('lap-last', 'LAST LAP', '—'));

    // Sector split row: S1, S2, running S3 remainder.
    const sectors = this.make('div', 'lunar-hud-lap-sectors', 'hud-lap-sectors', 'lap-sectors');
    this.lapSectorEls = [];
    const slotLabels = ['S1', 'S2', 'S3'].slice(0, HUD_LAP_SECTOR_SLOTS);
    for (const label of slotLabels) {
      const cell = this.make('span', `hud-lap-split-${label.toLowerCase()}`, 'hud-lap-split', `lap-split-${label.toLowerCase()}`);
      cell.textContent = '—';
      const wrap = this.make('span', undefined, 'hud-lap-split-cell');
      const cap = this.make('span', undefined, 'hud-lap-split-label');
      cap.textContent = label;
      wrap.appendChild(cap);
      wrap.appendChild(cell);
      sectors.appendChild(wrap);
      this.lapSectorEls.push(cell);
    }
    panel.appendChild(sectors);

    panel.appendChild(this.labeledField('lap-delta', 'SECTOR Δ', '—'));
    panel.appendChild(this.labeledField('speed-trap', 'SPEED TRAP', '—'));
    panel.appendChild(this.labeledField('top-speed', 'TOP SPEED', '0.0 km/h'));
    panel.appendChild(this.lamp('hud-speed-trap-lamp', 'TRAP ARMED', 'speed-trap-lamp'));
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
    // The full key sheet always sits under the prompts as a whisper
    // (re-painted by `setInputSource` when the gamepad takes over).
    const legend = this.make('div', 'lunar-hud-legend', 'hud-legend', 'key-legend');
    this.legendEl = legend;
    this.paintLegend();
    strip.appendChild(legend);
  }

  /**
   * Top-right `MISSION ONBOARDING` checklist (spec 14 §3.5): five rows driven
   * by `updateTutorial()`, each rendered as a ✔/□ glyph + step text.
   */
  private buildTutorial(): void {
    const panel = this.make('section', HUD_TUTORIAL_ID, 'hud-panel tutorial-panel', 'tutorial-panel');
    this.root.appendChild(panel);
    // Heading carries a logical key: `setQuestStage` re-titles it with the
    // active quest name while the legacy flow leaves "MISSION ONBOARDING".
    const head = this.make('div', undefined, 'hud-heading', 'tutorial-heading');
    head.textContent = 'MISSION ONBOARDING';
    panel.appendChild(head);

    const progress = this.make('div', 'lunar-hud-tutorial-progress', 'tutorial-progress', 'tutorial-progress');
    progress.textContent = `1 / ${HUD_TUTORIAL_STEPS.length}`;
    panel.appendChild(progress);

    // Dynamic stage-title line (spec 18 Phase 3) — hidden until a quest paints it.
    const stageTitle = this.make(
      'div',
      'lunar-hud-tutorial-stage',
      'tutorial-stage-title is-hidden',
      'tutorial-stage-title',
    );
    stageTitle.textContent = '';
    panel.appendChild(stageTitle);

    this.tutorialSteps = [];
    this.tutorialMarks = [];
    for (let i = 0; i < HUD_TUTORIAL_STEPS.length; i++) {
      const row = this.make('div', `lunar-hud-tutorial-step-${i + 1}`, 'tutorial-step is-pending', `tutorial-step-${i}`);
      row.setAttribute('data-step', String(i));
      const mark = this.make('span', undefined, 'tutorial-mark', `tutorial-mark-${i}`);
      mark.textContent = '□';
      const label = this.make('span', undefined, 'tutorial-label');
      label.textContent = HUD_TUTORIAL_STEPS[i];
      row.appendChild(mark);
      row.appendChild(label);
      panel.appendChild(row);
      this.tutorialSteps.push(row);
      this.tutorialMarks.push(mark);
    }

    // QuestEngine objective body (multi-objective stages). Rows are pooled
    // lazily by `setQuestStage`; the container hides with the legacy rows.
    this.questObjectiveRows = [];
    this.questObjectiveMarks = [];
    this.questBodyEl = this.make(
      'div',
      'lunar-hud-tutorial-quest',
      'tutorial-quest-body is-hidden',
      'tutorial-quest-body',
    );
    panel.appendChild(this.questBodyEl);
  }

  /**
   * Narrative comms terminal (Spec 18 §6.2): glassmorphic CRT panel docked
   * left-centre with scanline overlay, dispatcher header (callsign + sender
   * insignia pip), tone pip (`burst`/`alert`/`success`/`static`), and the
   * typewriter transmission body. Hidden until `showComms()`.
   */
  private buildCommsPanel(): void {
    const panel = this.make(
      'section',
      HUD_COMMS_ID,
      'hud-panel comms-terminal is-hidden',
      'comms-panel',
    );
    this.root.appendChild(panel);

    // CRT scanline veil (decorative, pointer-events: none via CSS).
    panel.appendChild(this.make('div', 'lunar-hud-comms-scanlines', 'comms-scanlines'));

    const head = this.make('div', 'lunar-hud-comms-head', 'comms-head');
    const insignia = this.make('span', 'lunar-hud-comms-insignia', 'comms-insignia', 'comms-insignia');
    insignia.textContent = '◈';
    head.appendChild(insignia);
    const sender = this.make('span', 'lunar-hud-comms-sender', 'comms-sender', 'comms-sender');
    sender.textContent = '——';
    head.appendChild(sender);
    const toneWrap = this.make('span', 'lunar-hud-comms-tone', 'comms-tone-wrap');
    const pip = this.make('span', 'lunar-hud-comms-tone-pip', 'comms-tone-pip', 'comms-tone-pulse');
    toneWrap.appendChild(pip);
    const tone = this.make('span', 'lunar-hud-comms-tone-label', 'comms-tone-label', 'comms-tone');
    tone.textContent = 'STANDBY';
    toneWrap.appendChild(tone);
    head.appendChild(toneWrap);
    panel.appendChild(head);

    // Sender org line ("Caelus Extraction Corp — Corporate Dispatch").
    const origin = this.make('div', 'lunar-hud-comms-origin', 'comms-origin', 'comms-origin');
    origin.textContent = '';
    panel.appendChild(origin);

    const body = this.make('div', 'lunar-hud-comms-body', 'comms-body', 'comms-body');
    body.textContent = '';
    const text = this.make('span', 'lunar-hud-comms-text', 'comms-text', 'comms-text');
    text.textContent = '';
    body.appendChild(text);
    const caret = this.make('span', 'lunar-hud-comms-caret', 'comms-cursor');
    caret.textContent = '▌';
    body.appendChild(caret);
    panel.appendChild(body);
  }

  /**
   * 2D screen-edge clamped hint arrow (Spec 18 §6.1, ADR-18-2): a rotated
   * glyph + distance chip + label that `updateHintArrow()` positions either
   * over the in-view chevron or clamped to the viewport perimeter.
   */
  private buildHintArrow(): void {
    const arrow = this.make(
      'div',
      HUD_HINT_ARROW_ID,
      'hint-arrow is-hidden',
      'hint-arrow',
    );
    this.root.appendChild(arrow);
    const glyph = this.make('span', 'lunar-hud-hint-arrow-glyph', 'hint-arrow-glyph', 'hint-arrow-glyph');
    glyph.textContent = '➤';
    arrow.appendChild(glyph);
    const distance = this.make('span', 'lunar-hud-hint-arrow-distance', 'hint-arrow-distance', 'hint-arrow-distance');
    distance.textContent = '';
    arrow.appendChild(distance);
    const label = this.make('span', 'lunar-hud-hint-arrow-label', 'hint-arrow-label', 'hint-arrow-label');
    label.textContent = '';
    arrow.appendChild(label);
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
