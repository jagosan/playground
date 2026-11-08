/**
 * Lunar Frontier — mobile touch input deck (Spec 33 §2.2 / §2.3, Phase 3,
 * TASK-PLAY-080c).
 *
 * `TouchInputController` decouples multi-touch gesture processing from the
 * render loop and feeds normalized frames into `ClientApp.sampleInput()`:
 *
 *   • Floating dynamic LEFT virtual stick (movement). Anchor zone is the
 *     bottom-left quadrant (X ≤ 42 % of width, Y ≥ 35 % of height); the stick
 *     origin (x̄, ȳ) snaps to the initial `touchstart` inside the zone so the
 *     player never looks down at thumb placement. Deflection is dead-zoned at
 *     {@link STICK_DEAD_RADIUS_PX} and clamped at {@link STICK_MAX_RADIUS_PX},
 *     producing `strafe = û_x · r_norm` and `forward = −û_y · r_norm` in
 *     [−1, 1]. Sprint auto-latches at r_norm ≥ 0.90 held for 300 ms or on an
 *     outward double-flick, and releases when the thumb returns to centre or
 *     lifts.
 *
 *   • Floating dynamic RIGHT LOOK STICK (Spec 34 §2.1, twin-stick
 *     architecture). Active zone is the right half of the viewport
 *     (X ≥ 45 % of width, Y ≥ 20 % of height), excluding action-button hit
 *     rects. The origin (x̄_look, ȳ_look) anchors to the initial
 *     `touchstart` inside the zone; deflection is dead-zoned at
 *     {@link LOOK_STICK_DEAD_RADIUS_PX} and clamped at
 *     {@link LOOK_STICK_MAX_RADIUS_PX}, producing CONTINUOUS angular
 *     velocities ω_yaw = û_x·r_norm·2.4 rad/s and
 *     ω_pitch = −û_y·r_norm·1.8 rad/s which the per-frame pump integrates
 *     into yaw/pitch deltas (Δθ = ω·Δt). On `touchend` the angular
 *     velocities drop to EXACTLY zero — no residual flick coast or drift.
 *
 *   • Glassmorphic DOM feedback: a translucent outer ring
 *     (`.lf-touch-stick-base`) and a glowing cyan thumb (`.lf-touch-stick-nub`)
 *     — both `pointer-events: none` so gestures never fight the canvas, styled
 *     from `src/ui/hud.css`. The thumb trails the deflection with a damped
 *     spring return to origin on `touchend`.
 *
 *   • ACTION BUTTON CLUSTER (Spec 33 §2.2.4, Phase 3): a glassmorphic
 *     bottom-right cluster with `[JUMP / RCS BOOST]` (`#btn-touch-jump`,
 *     live hold latch feeding `jump` — physics edge-detects the hop and the
 *     airborne PLSS boost), `[AIRBORNE TUCK]` (`#btn-touch-tuck`, Spec 35
 *     Phase 3 — the fluid low-G leg tuck, formerly the acrobatic roll), a dynamic
 *     `[CONTEXTUAL ACTION]` smart button (`#btn-touch-action`, label/icon/
 *     glow driven by {@link TouchInputController.setContextualAction}), and
 *     `[MAP]` / `[UI]` utility toggles. Every button keeps a ≥ 52 px hit
 *     target; touches landing on a button rect are CLAIMED by the cluster
 *     and never leak into the free-look trackpad (Spec 33 §2.2.3 zone
 *     exclusion). Discrete taps queue for the host via
 *     {@link TouchInputController.consumeActions}.
 *
 *   • Gamepad co-existence (§2.3): {@link TouchInputController.setVisible}
 *     fades the whole cluster out (`opacity: 0`, `pointer-events: none`,
 *     300 ms) while a Bluetooth pad drives; any screen touch fires the
 *     `onTouchActivity` callback so `ClientApp` flips the tri-state input
 *     source back to `'touch'` and re-illuminates the deck.
 *
 * Headless-resilient by construction: no `window` / `document` reference is
 * ever taken un-guarded, listeners only attach when a real event target
 * exists, and the whole gesture lifecycle is drivable through the public
 * synthetic-injection hooks ({@link handleTouchStart},
 * {@link handleTouchMove}, {@link handleTouchEnd}, {@link handleTouchCancel})
 * with plain structural objects — exactly what the Spec 33 §2.2 smoke harness
 * needs to verify normalized [−1, 1] output frames, dead-zone clipping and
 * inertial decay without a browser.
 */

// ---------------------------------------------------------------------------
// Tunables (Spec 33 §2.2.2 / §2.2.3) — exported for the smoke suite.
// ---------------------------------------------------------------------------

/** Left stick anchor zone: X ≤ this fraction of viewport width. */
export const STICK_ZONE_MAX_X_RATIO = 0.42;
/** Left stick anchor zone: Y ≥ this fraction of viewport height. */
export const STICK_ZONE_MIN_Y_RATIO = 0.35;
/** Right free-look look-stick zone: X ≥ this fraction of viewport width. */
export const LOOK_ZONE_MIN_X_RATIO = 0.45;
/** Spec 34 §2.1: right look-stick zone: Y ≥ this fraction of viewport height. */
export const LOOK_ZONE_MIN_Y_RATIO = 0.2;

/** Stick deflection inside this radius (px) reads exactly (0, 0). */
export const STICK_DEAD_RADIUS_PX = 8;
/** Stick deflection beyond this radius (px) clamps to the rim. */
export const STICK_MAX_RADIUS_PX = 54;

/** Right look-stick inner deadzone radius (px) — spec 34 §2.1 mirrors the left. */
export const LOOK_STICK_DEAD_RADIUS_PX = 8;
/** Right look-stick max deflection clamp radius (px) — spec 34 §2.1. */
export const LOOK_STICK_MAX_RADIUS_PX = 54;
/** Full-deflection yaw angular velocity Ω_max,yaw (rad/s, spec 34 §2.1). */
export const LOOK_YAW_MAX_RAD_PER_S = 2.4;
/** Full-deflection pitch angular velocity Ω_max,pitch (rad/s, spec 34 §2.1). */
export const LOOK_PITCH_MAX_RAD_PER_S = 1.8;

/** r_norm at/above which the sprint timer / outward-flick counter arms. */
export const SPRINT_NORM_THRESHOLD = 0.9;
/** Continuous hold time (ms) at r_norm ≥ threshold that latches sprint. */
export const SPRINT_LATCH_MS = 300;
/** Two outward rim-flicks inside this window (ms) also latch sprint. */
export const SPRINT_DOUBLE_FLICK_WINDOW_MS = 400;
/**
 * Per-`touchmove` r_norm jump that qualifies an outward sweep as a FLICK
 * (vs a slow drag onto the rim — a held press is covered by the 300 ms
 * hold latch instead, so drag jitter can never double-count as flicks).
 */
export const SPRINT_FLICK_NORM_JUMP = 0.5;
/** r_norm below which a latched sprint releases (thumb back to centre). */
export const SPRINT_RELEASE_NORM = 0.3;

/** Damped-spring visual return: stiffness (1/s²) and damping (1/s). */
export const STICK_SPRING_STIFFNESS = 260;
export const STICK_SPRING_DAMPING = 20;

// ---------------------------------------------------------------------------
// Action button cluster (Spec 33 §2.2.4, Phase 3) — exported for the smoke
// suite; `hud.css` keeps the visual sizes in lockstep with these values.
// ---------------------------------------------------------------------------

/** Every action button maintains at least this hit target on both axes. */
export const ACTION_BUTTON_MIN_PX = 52;
/** Extra slop (px) added around each hit rect when claiming a touch. */
export const ACTION_HIT_SLOP_PX = 6;
/** `[JUMP]` / `[ROLL]` button diameter (px). */
export const JUMP_BUTTON_PX = 64;
export const ROLL_BUTTON_PX = 64;
/** `[CONTEXTUAL ACTION]` smart-button diameter (px). */
export const CONTEXT_BUTTON_PX = 76;
/** `[MAP]` / `[UI]` utility-button diameter (px). */
export const UTILITY_BUTTON_PX = 52;
/** Gap (px) between neighbouring cluster buttons. */
export const ACTION_CLUSTER_GAP_PX = 12;
/** Cluster margin (px) from the viewport edges (CSS adds safe-area inset). */
export const ACTION_CLUSTER_MARGIN_PX = 24;
/** Utility-button top anchor (px, viewport space) below the HUD card row. */
export const UTILITY_BUTTON_TOP_PX = 88;
/** Cap on the one-shot tap queue when the host never drains. */
export const ACTION_TAP_QUEUE_CAP = 16;

// ---------------------------------------------------------------------------
// Structural event shapes (duck-typed: real TouchEvents AND headless fakes).
// ---------------------------------------------------------------------------

/** Minimal slice of a Touch: identity + viewport coordinates. */
export interface TouchLike {
  identifier: number;
  clientX: number;
  clientY: number;
}

/** Minimal slice of a TouchEvent. `preventDefault` optional for fakes. */
export interface TouchEventLike {
  touches: readonly TouchLike[];
  changedTouches: readonly TouchLike[];
  preventDefault?: () => void;
  /** Optional explicit clock (ms) for deterministic headless injection. */
  time?: number;
}

/** Identifiers for the Phase 3 action button cluster (Spec 33 §2.2.4).
 *  `'camera'` (Spec 34 §2.2) is the discrete `[🎥 VIEW]` utility tap. */
export type TouchActionId = 'jump' | 'roll' | 'action' | 'map' | 'ui' | 'camera';

/**
 * DOM element id an action button mounts under. The Spec 34 `'camera'` verb
 * mounts as `#btn-touch-cam` (§2.2.2) and the Spec 35 Phase 3 `'roll'` verb
 * (fluid airborne leg tuck) mounts as `#btn-touch-tuck`; every other verb
 * uses its own name.
 */
export function touchButtonDomId(id: TouchActionId): string {
  if (id === 'camera') return 'btn-touch-cam';
  if (id === 'roll') return 'btn-touch-tuck';
  return `btn-touch-${id}`;
}

/** Every action id, in cluster iteration order. */
export const TOUCH_ACTION_IDS: readonly TouchActionId[] = [
  'jump',
  'roll',
  'action',
  'map',
  'ui',
  'camera',
];

/**
 * Dynamic state of the `[CONTEXTUAL ACTION]` smart button (Spec 33 §2.2.4
 * item 3). `ClientApp` recomputes the top proximity target every HUD frame
 * and mirrors it here: the button relabels itself (`⛏ MINE …`, `🚗 BOARD`,
 * `🪜 CLIMB`, `📊 TRADE`…) and glows while `active` is true. `null` parks
 * the button in its dimmed no-target state.
 */
export interface ContextualAction {
  /** Text label, e.g. `MINE IRON ORE`. */
  label: string;
  /** Optional leading icon / emoji, e.g. `⛏`. */
  icon?: string;
  /** True while an interaction target sits inside the active radius. */
  active: boolean;
}

/** Viewport-space rectangle occupied by one action button. */
export interface ActionHitRect {
  id: TouchActionId;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One normalized poll frame handed to `ClientApp`. */
export interface TouchInputState {
  /** -1..1 forward demand from the left stick (screen-up is forward). */
  forward: number;
  /** -1..1 strafe demand from the left stick (screen-right is positive). */
  strafe: number;
  /** Sprint latch (hold ≥ 300 ms at r_norm ≥ 0.90, or outward double-flick). */
  sprint: boolean;
  /** Camera yaw delta (rad) accumulated since the previous poll. */
  yawDelta: number;
  /** Camera pitch delta (rad) accumulated since the previous poll. */
  pitchDelta: number;
  /** Any finger down, or a thumb spring still settling home. */
  isActive: boolean;
  /**
   * Spec 33 §2.2.4: `[JUMP / RCS BOOST]` button held (raw live latch — the
   * physics valve edge-detects the ground hop and the airborne PLSS boost,
   * exactly like keyboard Space).
   */
  jump: boolean;
  /**
   * Spec 33 §2.2.4 / Spec 35 Phase 3: `[AIRBORNE TUCK]` button held (raw live
   * latch; folded into the Spec 35 fluid low-G leg tuck while airborne — the
   * Spec 32 360° somersault is rectified away. No-op on the ground).
   */
  roll: boolean;
}

export interface TouchInputControllerOptions {
  /** Viewport width (px). Browsers pass `window.innerWidth`; default 1280. */
  viewportWidth?: number;
  /** Viewport height (px). Browsers pass `window.innerHeight`; default 800. */
  viewportHeight?: number;
  /** Injectable clock (ms). Defaults to `performance.now()`/`Date.now()`. */
  now?: () => number;
  /** Set false to never create the glassmorphic DOM visuals. */
  visuals?: boolean;
  /**
   * Spec 33 §2.3: fired on EVERY processed `touchstart` (stick, look pad and
   * action buttons alike — including taps on a hidden cluster). `ClientApp`
   * wires this to flip the tri-state input source to `'touch'` instantly and
   * re-illuminate the deck. Exceptions from the callback are swallowed.
   */
  onTouchActivity?: () => void;
}

interface Spring2D {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Minimal duck-typed DOM element for the action cluster: real browsers hand
 * full `HTMLElement`s; headless harnesses inject stripped-down fakes, so
 * every member beyond `style` / `className` is optional and called via `?.`.
 */
interface LooseDomEl {
  style: { [k: string]: string };
  className: string;
  textContent?: string;
  setAttribute?: (name: string, value: string) => void;
  appendChild?: (child: unknown) => unknown;
}

// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function defaultNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

/**
 * Multi-touch gesture manager for the mobile deck (Spec 33 §2.2). Owns at
 * most one stick finger and one look finger at a time; every other touch is
 * ignored (Phase 3 hands action-button targets to the contextual cluster).
 */
export class TouchInputController {
  // -- viewport & clock -----------------------------------------------------
  private viewportWidth: number;
  private viewportHeight: number;
  private readonly now: () => number;
  private readonly visualsEnabled: boolean;

  // -- left stick -------------------------------------------------------------
  /** Touch identifier driving the stick, or null when released. */
  private stickTouchId: number | null = null;
  /** Floating origin (x̄, ȳ) captured on the stick's `touchstart`. */
  private stickOriginX = 0;
  private stickOriginY = 0;
  /** Current thumb coordinates (viewport px). */
  private stickX = 0;
  private stickY = 0;
  /** Normalized deflection outputs recomputed on every move. */
  private stickStrafe = 0;
  private stickForward = 0;
  private stickRawRadius = 0;
  private stickNorm = 0;
  /** Previous-frame r_norm (rising-edge detection for rim flicks). */
  private stickPrevNorm = 0;
  /** Timestamp when r_norm first crossed ≥ {@link SPRINT_NORM_THRESHOLD}. */
  private sprintArmedAtMs: number | null = null;
  /** Last outward rim-flick timestamp (double-flick sprint latch). */
  private lastFlickAtMs = Number.NEGATIVE_INFINITY;
  /** Latched sprint output (sticky until release / centre / lift). */
  private sprintLatched = false;
  /** Damped-spring visual state (thumb offset relative to origin). */
  private readonly spring: Spring2D = { x: 0, y: 0, vx: 0, vy: 0 };

  // -- right look stick (Spec 34 §2.1 twin-stick) --------------------------------
  /** Touch identifier driving the look stick, or null when released. */
  private lookTouchId: number | null = null;
  /** Floating origin (x̄_look, ȳ_look) captured on the look stick's `touchstart`. */
  private lookOriginX = 0;
  private lookOriginY = 0;
  /** Current look-thumb coordinates (viewport px). */
  private lookX = 0;
  private lookY = 0;
  /** Live deflection geometry recomputed on every move. */
  private lookRawRadius = 0;
  private lookNorm = 0;
  /** Continuous angular velocities (rad/s) from the Spec 34 §2.1 law. */
  private lookOmegaYawRadPerS = 0;
  private lookOmegaPitchRadPerS = 0;
  /** Damped-spring visual state (look-thumb offset relative to origin). */
  private readonly lookSpring: Spring2D = { x: 0, y: 0, vx: 0, vy: 0 };

  // -- accumulated look deltas (consumed by poll()) ---------------------------
  private accYawRad = 0;
  private accPitchRad = 0;

  // -- action button cluster (Spec 33 §2.2.4, Phase 3) -------------------------
  /** Live hold state per action button (true while a finger covers it). */
  private readonly actionHeld: Record<TouchActionId, boolean> = {
    jump: false,
    roll: false,
    action: false,
    map: false,
    ui: false,
    camera: false,
  };
  /** Fingers claimed by an action button — isolated from the look trackpad. */
  private readonly buttonTouchIds = new Map<number, TouchActionId>();
  /** One-shot discrete taps (action / map / ui) awaiting the host drain. */
  private actionTapQueue: TouchActionId[] = [];
  /** Contextual smart-button state painted by `setContextualAction()`. */
  private contextualAction: ContextualAction | null = null;
  /** Deck visibility (gamepad co-existence fades the cluster out, §2.3). */
  private deckVisible = true;
  /** Headless override for the action hit rects (smoke harness). */
  private actionRectsOverride: ActionHitRect[] | null = null;

  /** Spec 33 §2.3: tri-state flip hook (assigned by `ClientApp`). */
  onTouchActivity: (() => void) | null;

  // -- DOM visuals --------------------------------------------------------------
  private baseEl: { style: { [k: string]: string }; className: string } | null = null;
  private nubEl: { style: { [k: string]: string }; className: string } | null = null;
  /** Spec 34 §2.1 right look-stick ring / nub (`.lf-touch-look-*`). */
  private lookBaseEl: { style: { [k: string]: string }; className: string } | null = null;
  private lookNubEl: { style: { [k: string]: string }; className: string } | null = null;
  /** `#lf-touch-actions` cluster container + contextual-button handles. */
  private clusterEl: LooseDomEl | null = null;
  private contextBtnEl: LooseDomEl | null = null;
  private contextIconEl: LooseDomEl | null = null;
  private contextLabelEl: LooseDomEl | null = null;

  // -- listener plumbing ---------------------------------------------------------
  private attached = false;
  private boundStart: ((ev: TouchEventLike) => void) | null = null;
  private boundMove: ((ev: TouchEventLike) => void) | null = null;
  private boundEnd: ((ev: TouchEventLike) => void) | null = null;

  constructor(options: TouchInputControllerOptions = {}) {
    this.viewportWidth = Math.max(1, options.viewportWidth ?? 1280);
    this.viewportHeight = Math.max(1, options.viewportHeight ?? 800);
    this.now = options.now ?? defaultNow;
    this.visualsEnabled = options.visuals !== false;
    this.onTouchActivity = options.onTouchActivity ?? null;
  }

  // -- lifecycle -----------------------------------------------------------------

  /**
   * Bind `touchstart` / `touchmove` / `touchend` / `touchcancel` with
   * `{ passive: false }` (pitfall #50: passive listeners let Safari/Chrome
   * steal the drag for pinch-zoom / swipe-nav). Target defaults to `window`
   * (the deck is viewport-anchored, not canvas-anchored). No-op headless.
   * Returns true when this call performed the attachment.
   */
  attach(target?: unknown): boolean {
    if (this.attached) return false;
    const t =
      target !== undefined
        ? target
        : (globalThis as { window?: unknown }).window;
    const host = t as {
      addEventListener?: (type: string, fn: (ev: TouchEventLike) => void, opts?: unknown) => void;
    } | null | undefined;
    if (
      host === null ||
      host === undefined ||
      typeof host.addEventListener !== 'function'
    ) {
      return false;
    }
    this.boundStart = (ev: TouchEventLike) => this.handleTouchStart(ev);
    this.boundMove = (ev: TouchEventLike) => this.handleTouchMove(ev);
    this.boundEnd = (ev: TouchEventLike) => this.handleTouchEnd(ev);
    const opts = { passive: false } as const;
    host.addEventListener('touchstart', this.boundStart, opts);
    host.addEventListener('touchmove', this.boundMove, opts);
    host.addEventListener('touchend', this.boundEnd, opts);
    host.addEventListener('touchcancel', this.boundEnd, opts);
    this.attached = true;
    if (this.visualsEnabled) {
      this.ensureVisuals();
      this.ensureActionCluster();
    }
    return true;
  }

  /** Detach the DOM listeners (visuals stay in the DOM until `dispose()`). */
  detach(): void {
    if (!this.attached) return;
    const win = (globalThis as {
      window?: {
        removeEventListener?: (type: string, fn: unknown, opts?: unknown) => void;
      };
    }).window;
    const opts = { passive: false } as const;
    try {
      if (this.boundStart !== null) win?.removeEventListener?.('touchstart', this.boundStart, opts);
      if (this.boundMove !== null) win?.removeEventListener?.('touchmove', this.boundMove, opts);
      if (this.boundEnd !== null) {
        win?.removeEventListener?.('touchend', this.boundEnd, opts);
        win?.removeEventListener?.('touchcancel', this.boundEnd, opts);
      }
    } catch {
      /* page already torn down */
    }
    this.boundStart = null;
    this.boundMove = null;
    this.boundEnd = null;
    this.attached = false;
  }

  /** Full teardown: listeners + synthetic state + DOM visuals. Idempotent. */
  dispose(): void {
    this.detach();
    this.reset();
    this.removeVisuals();
  }

  /** Zero every gesture/latch/coast/accumulator state (visuals hidden). */
  reset(): void {
    this.releaseStick(this.now());
    this.releaseLook();
    this.spring.x = 0;
    this.spring.y = 0;
    this.spring.vx = 0;
    this.spring.vy = 0;
    this.lookSpring.x = 0;
    this.lookSpring.y = 0;
    this.lookSpring.vx = 0;
    this.lookSpring.vy = 0;
    this.accYawRad = 0;
    this.accPitchRad = 0;
    this.lastFlickAtMs = Number.NEGATIVE_INFINITY;
    this.stickPrevNorm = 0;
    // Phase 3: drop every cluster latch, claim and pending tap.
    this.buttonTouchIds.clear();
    this.actionTapQueue.length = 0;
    for (const id of TOUCH_ACTION_IDS) this.actionHeld[id] = false;
  }

  /** Live viewport (browsers push this on resize / orientation change). */
  setViewport(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
  }

  // -- synthetic injection hooks (headless smoke harness) -------------------------

  /** `touchstart` handler — public so tests can inject synthetic events. */
  handleTouchStart(event: TouchEventLike): void {
    const t = event.time ?? this.now();
    let handled = false;
    const starts = event.changedTouches.length > 0
      ? event.changedTouches
      : event.touches;
    // Pass 1 (Spec 33 §2.2.4): action-button claims. A finger landing on a
    // cluster button's hit rect belongs to the cluster — it must NEVER leak
    // into the free-look trackpad underneath (the cluster sits inside the
    // right look zone). Runs before the zone routing, on every device.
    for (const touch of starts) {
      if (this.buttonTouchIds.has(touch.identifier)) continue;
      const hit = this.hitTestActionAt(touch.clientX, touch.clientY);
      if (hit !== null) {
        this.claimActionButton(hit, touch.identifier);
        handled = true;
      }
    }
    // Pass 2: movement / look zone routing for the remaining fingers.
    for (const touch of starts) {
      if (this.buttonTouchIds.has(touch.identifier)) continue;
      if (this.stickTouchId === null && this.isInStickZone(touch.clientX, touch.clientY)) {
        // Floating origin anchors exactly at the initial contact point.
        this.stickTouchId = touch.identifier;
        this.stickOriginX = touch.clientX;
        this.stickOriginY = touch.clientY;
        this.stickX = touch.clientX;
        this.stickY = touch.clientY;
        this.updateStickDeflection(t);
        this.showStickVisuals(touch.clientX, touch.clientY);
        handled = true;
      } else if (this.lookTouchId === null && this.isInLookZone(touch.clientX, touch.clientY)) {
        // Spec 34 §2.1: floating dynamic RIGHT look stick — the anchor
        // (x̄_look, ȳ_look) snaps exactly to the initial contact point and
        // the angular-velocity law reads deflection RELATIVE to that anchor.
        this.lookTouchId = touch.identifier;
        this.lookOriginX = touch.clientX;
        this.lookOriginY = touch.clientY;
        this.lookX = touch.clientX;
        this.lookY = touch.clientY;
        // Fresh grab starts dead still: no inherited velocity.
        this.updateLookVelocity();
        this.showLookVisuals(touch.clientX, touch.clientY);
        handled = true;
      }
    }
    if (handled) {
      event.preventDefault?.();
      // Spec 33 §2.3: ANY processed touch claims the tri-state input source.
      this.fireTouchActivity();
    }
  }

  /** `touchmove` handler — routes each claimed finger to its deck. */
  handleTouchMove(event: TouchEventLike): void {
    const t = event.time ?? this.now();
    let handled = false;
    const moves = event.changedTouches.length > 0 ? event.changedTouches : event.touches;
    for (const touch of moves) {
      if (this.stickTouchId !== null && touch.identifier === this.stickTouchId) {
        this.stickX = touch.clientX;
        this.stickY = touch.clientY;
        this.updateStickDeflection(t);
        handled = true;
      } else if (this.lookTouchId !== null && touch.identifier === this.lookTouchId) {
        // Spec 34 §2.1: the look stick is POSITIONAL — thumb coordinates
        // update, the continuous angular-velocity law recomputes, and the
        // per-frame update() integrates ω into this frame's deltas.
        this.lookX = touch.clientX;
        this.lookY = touch.clientY;
        this.updateLookVelocity();
        handled = true;
      } else if (this.buttonTouchIds.has(touch.identifier)) {
        // Cluster finger: swallow the move (hold stays latched until the
        // lift) so a sliding thumb never paints the camera around.
        handled = true;
      }
    }
    if (handled) event.preventDefault?.();
  }

  /** `touchend` / `touchcancel` handler — releases the matching finger. */
  handleTouchEnd(event: TouchEventLike): void {
    const t = event.time ?? this.now();
    let handled = false;
    const ended = event.changedTouches.length > 0 ? event.changedTouches : event.touches;
    for (const touch of ended) {
      const claimed = this.buttonTouchIds.get(touch.identifier);
      if (claimed !== undefined) {
        // Cluster lift: drop the hold latch (the jump/roll edges physics
        // edge-detects live in the poll state).
        this.buttonTouchIds.delete(touch.identifier);
        this.actionHeld[claimed] = false;
        handled = true;
      } else if (this.stickTouchId !== null && touch.identifier === this.stickTouchId) {
        this.releaseStick(t);
        this.hideStickVisuals();
        handled = true;
      } else if (this.lookTouchId !== null && touch.identifier === this.lookTouchId) {
        this.releaseLook();
        this.hideLookVisuals();
        handled = true;
      }
    }
    if (handled) event.preventDefault?.();
  }

  /** Alias of {@link handleTouchEnd} for explicit `touchcancel` injection. */
  handleTouchCancel(event: TouchEventLike): void {
    this.handleTouchEnd(event);
  }

  // -- per-frame pump --------------------------------------------------------------

  /**
   * Advance the two damped-spring thumb returns and integrate the Spec 34
   * §2.1 continuous angular velocity into this frame's look deltas
   * (Δθ = ω·Δt). Call once per rendered frame (ClientApp feeds `dt * 1000`).
   * Idempotent across zero-dt calls; dt clamped to [0, 100] ms for
   * tab-switch safety.
   */
  update(dtMs: number): void {
    const dt = clamp(dtMs, 0, 100);
    const dtS = dt / 1000;

    // Damped spring: thumb eases back toward the origin after release
    // (target = live deflection while the finger is down).
    const targetX = this.stickTouchId !== null ? this.stickX - this.stickOriginX : 0;
    const targetY = this.stickTouchId !== null ? this.stickY - this.stickOriginY : 0;
    if (dtS > 0) {
      this.spring.vx += (-STICK_SPRING_STIFFNESS * (this.spring.x - targetX) -
        STICK_SPRING_DAMPING * this.spring.vx) * dtS;
      this.spring.vy += (-STICK_SPRING_STIFFNESS * (this.spring.y - targetY) -
        STICK_SPRING_DAMPING * this.spring.vy) * dtS;
      this.spring.x += this.spring.vx * dtS;
      this.spring.y += this.spring.vy * dtS;
    }

    // Spec 34 §2.1 continuous look law: while the right stick is deflected
    // the camera rotates at a CONSTANT angular velocity; every frame emits
    // its share ω·Δt into the accumulator poll() consumes. ω is exactly
    // zero inside the deadzone and drops to zero the instant the finger
    // lifts — no residual coast or drift.
    if (dtS > 0 && (this.lookOmegaYawRadPerS !== 0 || this.lookOmegaPitchRadPerS !== 0)) {
      this.accYawRad += this.lookOmegaYawRadPerS * dtS;
      this.accPitchRad += this.lookOmegaPitchRadPerS * dtS;
    }

    // Look-thumb damped spring (mirrors the left stick, k = 260, c = 20).
    const lookTargetX = this.lookTouchId !== null ? this.lookX - this.lookOriginX : 0;
    const lookTargetY = this.lookTouchId !== null ? this.lookY - this.lookOriginY : 0;
    if (dtS > 0) {
      this.lookSpring.vx += (-STICK_SPRING_STIFFNESS * (this.lookSpring.x - lookTargetX) -
        STICK_SPRING_DAMPING * this.lookSpring.vx) * dtS;
      this.lookSpring.vy += (-STICK_SPRING_STIFFNESS * (this.lookSpring.y - lookTargetY) -
        STICK_SPRING_DAMPING * this.lookSpring.vy) * dtS;
      this.lookSpring.x += this.lookSpring.vx * dtS;
      this.lookSpring.y += this.lookSpring.vy * dtS;
    }

    this.syncVisuals();
    this.syncLookVisuals();
  }

  // -- output -----------------------------------------------------------------------

  /**
   * Consume this frame's normalized state (Spec 33 §2.2): movement + sprint
   * come from the live stick pose; `yawDelta` / `pitchDelta` are the look
   * radians accumulated since the PREVIOUS poll (Spec 34 §2.1 ω·Δt
   * integration) and are zeroed by this call.
   */
  poll(): TouchInputState {
    const state: TouchInputState = {
      forward: this.stickForward,
      strafe: this.stickStrafe,
      sprint: this.sprintLatched,
      yawDelta: this.accYawRad,
      pitchDelta: this.accPitchRad,
      isActive: this.isActive(),
      jump: this.actionHeld.jump,
      roll: this.actionHeld.roll,
    };
    this.accYawRad = 0;
    this.accPitchRad = 0;
    return state;
  }

  /** Non-consuming snapshot with the same shape as {@link poll}. */
  peek(): TouchInputState {
    return {
      forward: this.stickForward,
      strafe: this.stickStrafe,
      sprint: this.sprintLatched,
      yawDelta: this.accYawRad,
      pitchDelta: this.accPitchRad,
      isActive: this.isActive(),
      jump: this.actionHeld.jump,
      roll: this.actionHeld.roll,
    };
  }

  /** True while any finger owns a deck surface or a spring still settles. */
  isActive(): boolean {
    return (
      this.stickTouchId !== null ||
      this.lookTouchId !== null ||
      this.buttonTouchIds.size > 0 ||
      this.anyActionHeld() ||
      Math.abs(this.spring.x) + Math.abs(this.spring.y) > 0.05 ||
      Math.abs(this.spring.vx) + Math.abs(this.spring.vy) > 0.05 ||
      Math.abs(this.lookSpring.x) + Math.abs(this.lookSpring.y) > 0.05 ||
      Math.abs(this.lookSpring.vx) + Math.abs(this.lookSpring.vy) > 0.05
    );
  }

  /** Raw left-stick geometry (diagnostics / smoke gates). */
  getStickGeometry(): {
    active: boolean;
    originX: number;
    originY: number;
    radiusPx: number;
    radiusNorm: number;
    strafe: number;
    forward: number;
    sprint: boolean;
  } {
    return {
      active: this.stickTouchId !== null,
      originX: this.stickOriginX,
      originY: this.stickOriginY,
      radiusPx: this.stickRawRadius,
      radiusNorm: this.stickNorm,
      strafe: this.stickStrafe,
      forward: this.stickForward,
      sprint: this.sprintLatched,
    };
  }

  /**
   * Raw right look-stick geometry (diagnostics / Spec 34 §2.1 smoke gates).
   * `omegaYaw` / `omegaPitch` are the LIVE continuous angular velocities
   * (rad/s) the per-frame pump integrates into the poll deltas.
   */
  getLookGeometry(): {
    active: boolean;
    originX: number;
    originY: number;
    radiusPx: number;
    radiusNorm: number;
    omegaYaw: number;
    omegaPitch: number;
  } {
    return {
      active: this.lookTouchId !== null,
      originX: this.lookOriginX,
      originY: this.lookOriginY,
      radiusPx: this.lookRawRadius,
      radiusNorm: this.lookNorm,
      omegaYaw: this.lookOmegaYawRadPerS,
      omegaPitch: this.lookOmegaPitchRadPerS,
    };
  }

  /** True while a real finger owns a deck surface (stick, look, button). */
  hasFingerDown(): boolean {
    return (
      this.stickTouchId !== null ||
      this.lookTouchId !== null ||
      this.buttonTouchIds.size > 0
    );
  }

  // -- action button cluster API (Spec 33 §2.2.4 / §2.3, Phase 3) ----------------

  /**
   * Mirror the current interactive target onto the `[CONTEXTUAL ACTION]`
   * smart button. `ClientApp` calls this from its HUD refresh with the top
   * proximity action (`⛏ MINE …`, `🚗 BOARD` / `🚶 DISMOUNT`, `🪜 CLIMB`,
   * `📊 TRADE`…); `null` parks the button in its dimmed no-target state.
   * Taps are queued regardless of the label — the host re-derives the
   * action at execution time, so a stale label can never fire a stale verb.
   */
  setContextualAction(action: ContextualAction | null): void {
    this.contextualAction =
      action === null
        ? null
        : { label: action.label, icon: action.icon, active: action.active === true };
    this.syncContextButton();
  }

  /** The last label/icon/glow handed to {@link setContextualAction}. */
  getContextualAction(): ContextualAction | null {
    return this.contextualAction;
  }

  /**
   * Show / hide the whole touch deck for tri-state co-existence
   * (Spec 33 §2.3): hiding fades `#lf-touch-actions` out via the
   * `.is-gamepad-hidden` class (300 ms CSS transition,
   * `pointer-events: none`) and drops every pending hold / pending tap so
   * the deck never re-illuminates mid-gesture. Idempotent.
   */
  setVisible(visible: boolean): void {
    const next = visible === true;
    if (this.deckVisible === next) return;
    this.deckVisible = next;
    if (!next) {
      this.buttonTouchIds.clear();
      this.actionTapQueue.length = 0;
      for (const id of TOUCH_ACTION_IDS) this.actionHeld[id] = false;
    }
    if (this.clusterEl !== null) {
      this.clusterEl.className = next
        ? 'lf-touch-actions'
        : 'lf-touch-actions is-gamepad-hidden';
    }
  }

  /** Current deck visibility (hidden = gamepad drives, cluster faded). */
  isVisible(): boolean {
    return this.deckVisible;
  }

  /**
   * Drain the one-shot discrete tap queue (`action` / `map` / `ui` presses,
   * fired on touch-down for zero-latency response). The host dispatches
   * each id exactly once — jump / roll ride the live `poll()` hold state
   * instead and never appear here.
   */
  consumeActions(): TouchActionId[] {
    if (this.actionTapQueue.length === 0) return [];
    const drained = this.actionTapQueue;
    this.actionTapQueue = [];
    return drained;
  }

  /** True while the named action button is under a finger. */
  isActionHeld(id: TouchActionId): boolean {
    return this.actionHeld[id] === true;
  }

  /**
   * Override the action hit rects (headless smoke harness injects explicit
   * geometry; `null` restores the DOM/default resolution order of
   * {@link getActionHitRects}).
   */
  registerActionHitRects(rects: readonly ActionHitRect[] | null): void {
    this.actionRectsOverride = rects === null ? null : rects.map((r) => ({ ...r }));
  }

  /**
   * Live hit rects, resolved in order: harness override → real DOM
   * `getBoundingClientRect()` of the mounted buttons → the analytic layout
   * mirrored from `hud.css` ({@link defaultActionRects}).
   */
  getActionHitRects(): ActionHitRect[] {
    if (this.actionRectsOverride !== null) return this.actionRectsOverride;
    const domRects = this.actionRectsFromDom();
    return domRects.length > 0 ? domRects : this.defaultActionRects();
  }

  /**
   * Which action button (if any) owns this viewport point. Rects grow by
   * {@link ACTION_HIT_SLOP_PX} so the ≥ 52 px target reads forgiving under
   * a thumb, per Spec 33 §2.2.4's high-contrast / high-precision mandate.
   */
  hitTestActionAt(x: number, y: number): TouchActionId | null {
    const slop = ACTION_HIT_SLOP_PX;
    for (const r of this.getActionHitRects()) {
      if (
        x >= r.x - slop &&
        x <= r.x + r.width + slop &&
        y >= r.y - slop &&
        y <= r.y + r.height + slop
      ) {
        return r.id;
      }
    }
    return null;
  }

  /**
   * Analytic cluster layout mirrored 1:1 from `hud.css` (bottom-right
   * JUMP / ACTION / ROL cluster + top-corner MAP / UI utility corners).
   * Used headless, and as the browser fallback before the buttons mount.
   */
  defaultActionRects(): ActionHitRect[] {
    const w = this.viewportWidth;
    const h = this.viewportHeight;
    const m = ACTION_CLUSTER_MARGIN_PX;
    const g = ACTION_CLUSTER_GAP_PX;
    const a = CONTEXT_BUTTON_PX;
    const j = JUMP_BUTTON_PX;
    const r = ROLL_BUTTON_PX;
    const u = UTILITY_BUTTON_PX;
    return [
      { id: 'action', x: w - m - a, y: h - m - a, width: a, height: a },
      { id: 'jump', x: w - m - j, y: h - m - a - g - j, width: j, height: j },
      { id: 'roll', x: w - m - a - g - r, y: h - m - r, width: r, height: r },
      { id: 'map', x: m, y: UTILITY_BUTTON_TOP_PX, width: u, height: u },
      { id: 'ui', x: w - m - u, y: UTILITY_BUTTON_TOP_PX, width: u, height: u },
      // Spec 34 §2.2.2: `[🎥 VIEW]` sits left of `[UI]` in the utility row.
      { id: 'camera', x: w - m - u - g - u, y: UTILITY_BUTTON_TOP_PX, width: u, height: u },
    ];
  }

  // -- zone maths ---------------------------------------------------------------------

  /** Bottom-left quadrant test (X ≤ 42 vw, Y ≥ 35 vh). */
  isInStickZone(x: number, y: number): boolean {
    return (
      x <= this.viewportWidth * STICK_ZONE_MAX_X_RATIO &&
      y >= this.viewportHeight * STICK_ZONE_MIN_Y_RATIO
    );
  }

  /** Right-half look-stick test (X ≥ 45 vw, Y ≥ 20 vh — Spec 34 §2.1). */
  isInLookZone(x: number, y: number): boolean {
    return (
      x >= this.viewportWidth * LOOK_ZONE_MIN_X_RATIO &&
      y >= this.viewportHeight * LOOK_ZONE_MIN_Y_RATIO
    );
  }

  // -- internals ------------------------------------------------------------------------

  /**
   * Recompute the Spec 33 §2.2.2 deflection law from the current thumb
   * position, plus the sprint arming: continuous ≥300 ms hold at
   * r_norm ≥ 0.90, or two OUTWARD rim-crossing flicks inside 400 ms.
   */
  private updateStickDeflection(nowMs: number): void {
    const dx = this.stickX - this.stickOriginX;
    const dy = this.stickY - this.stickOriginY;
    const r = Math.hypot(dx, dy);
    this.stickRawRadius = r;

    if (r < STICK_DEAD_RADIUS_PX) {
      this.stickStrafe = 0;
      this.stickForward = 0;
      this.stickNorm = 0;
    } else {
      const ux = dx / r;
      const uy = dy / r;
      const rNorm = clamp((r - STICK_DEAD_RADIUS_PX) / (STICK_MAX_RADIUS_PX - STICK_DEAD_RADIUS_PX), 0, 1);
      this.stickNorm = rNorm;
      this.stickStrafe = ux * rNorm;
      this.stickForward = -uy * rNorm;
    }

    // Sprint arming / latching.
    if (this.stickNorm >= SPRINT_NORM_THRESHOLD) {
      if (this.sprintArmedAtMs === null) this.sprintArmedAtMs = nowMs;
      // Outward rim-flick: a FAST outward sweep onto the outer band (large
      // per-event r_norm jump). A slow drag never jumps, and the resulting
      // hold is covered by the timed latch below.
      if (
        this.stickNorm - this.stickPrevNorm >= SPRINT_FLICK_NORM_JUMP
      ) {
        if (nowMs - this.lastFlickAtMs <= SPRINT_DOUBLE_FLICK_WINDOW_MS) {
          this.sprintLatched = true;
        }
        this.lastFlickAtMs = nowMs;
      }
      if (nowMs - this.sprintArmedAtMs >= SPRINT_LATCH_MS) {
        this.sprintLatched = true;
      }
    } else {
      this.sprintArmedAtMs = null;
      if (this.stickNorm < SPRINT_RELEASE_NORM) this.sprintLatched = false;
    }
    this.stickPrevNorm = this.stickNorm;
  }

  /** Stick release: deflection zeroes, sprint unlatches, spring targets 0. */
  private releaseStick(nowMs: number): void {
    if (this.stickTouchId === null) return;
    // Visual continuity: the thumb spring picks up exactly where the finger
    // lifted (updates() may not have run since the last move, so seed from
    // the live deflection) and damps home from there.
    this.spring.x = clamp(this.stickX - this.stickOriginX, -STICK_MAX_RADIUS_PX, STICK_MAX_RADIUS_PX);
    this.spring.y = clamp(this.stickY - this.stickOriginY, -STICK_MAX_RADIUS_PX, STICK_MAX_RADIUS_PX);
    this.spring.vx = 0;
    this.spring.vy = 0;
    this.stickTouchId = null;
    this.stickX = this.stickOriginX;
    this.stickY = this.stickOriginY;
    this.updateStickDeflection(nowMs);
    this.sprintArmedAtMs = null;
    this.sprintLatched = false;
  }

  /**
   * Recompute the Spec 34 §2.1 continuous angular-velocity law from the
   * current look-thumb deflection relative to the floating anchor:
   *
   *   r ≤ R_dead               → ω_yaw = ω_pitch = 0 (deadzone)
   *   r_norm = clamp((min(r, R_max) − R_dead) / (R_max − R_dead), 0, 1)
   *   ω_yaw   =  û_x · r_norm · 2.4 rad/s
   *   ω_pitch = −û_y · r_norm · 1.8 rad/s   (screen y grows downward, so
   *                                            dragging UP looks UP)
   */
  private updateLookVelocity(): void {
    const dx = this.lookX - this.lookOriginX;
    const dy = this.lookY - this.lookOriginY;
    const r = Math.hypot(dx, dy);
    this.lookRawRadius = r;
    if (r <= LOOK_STICK_DEAD_RADIUS_PX) {
      this.lookNorm = 0;
      this.lookOmegaYawRadPerS = 0;
      this.lookOmegaPitchRadPerS = 0;
      return;
    }
    const ux = dx / r;
    const uy = dy / r;
    this.lookNorm = clamp(
      (Math.min(r, LOOK_STICK_MAX_RADIUS_PX) - LOOK_STICK_DEAD_RADIUS_PX) /
        (LOOK_STICK_MAX_RADIUS_PX - LOOK_STICK_DEAD_RADIUS_PX),
      0,
      1,
    );
    this.lookOmegaYawRadPerS = ux * this.lookNorm * LOOK_YAW_MAX_RAD_PER_S;
    this.lookOmegaPitchRadPerS = -uy * this.lookNorm * LOOK_PITCH_MAX_RAD_PER_S;
  }

  /**
   * Look release (Spec 34 §2.1): angular velocities drop to EXACTLY zero
   * the instant the finger lifts — no residual flick coast or drift. The
   * visual spring picks up exactly where the thumb lifted and damps home.
   */
  private releaseLook(): void {
    this.lookOmegaYawRadPerS = 0;
    this.lookOmegaPitchRadPerS = 0;
    if (this.lookTouchId === null) return;
    // Visual continuity: seed the spring from the live deflection (update()
    // may not have run since the last move) and let it settle to centre.
    this.lookSpring.x = clamp(
      this.lookX - this.lookOriginX,
      -LOOK_STICK_MAX_RADIUS_PX,
      LOOK_STICK_MAX_RADIUS_PX,
    );
    this.lookSpring.y = clamp(
      this.lookY - this.lookOriginY,
      -LOOK_STICK_MAX_RADIUS_PX,
      LOOK_STICK_MAX_RADIUS_PX,
    );
    this.lookSpring.vx = 0;
    this.lookSpring.vy = 0;
    this.lookTouchId = null;
    this.lookX = this.lookOriginX;
    this.lookY = this.lookOriginY;
    this.updateLookVelocity();
  }

  // -- action button cluster internals -----------------------------------------

  /**
   * Claim a finger for an action button (Spec 33 §2.2.4). While the deck is
   * visible: hold channels (jump / roll) latch until the lift, discrete
   * verbs (action / map / ui) enter the one-shot queue consumed by
   * {@link consumeActions}. Taps landing on a HIDDEN cluster are swallowed
   * as-is — they never fire an action, they only re-illuminate the deck via
   * the activity callback (Spec 33 §2.3 "touching the screen instantly
   * restores virtual controls").
   */
  private claimActionButton(id: TouchActionId, identifier: number): void {
    this.buttonTouchIds.set(identifier, id);
    if (this.deckVisible) {
      this.actionHeld[id] = true;
      if (id !== 'jump' && id !== 'roll') {
        if (this.actionTapQueue.length < ACTION_TAP_QUEUE_CAP) {
          this.actionTapQueue.push(id);
        }
      }
    }
  }

  /** Fire the host tri-state flip hook; host exceptions never kill touch. */
  private fireTouchActivity(): void {
    const cb = this.onTouchActivity;
    if (cb === null) return;
    try {
      cb();
    } catch {
      /* the host owns its failures */
    }
  }

  /** True while any action button sits under a finger. */
  private anyActionHeld(): boolean {
    for (const id of TOUCH_ACTION_IDS) {
      if (this.actionHeld[id] === true) return true;
    }
    return false;
  }

  /**
   * Resolve action hit rects from the mounted DOM buttons. Defensive: fake
   * headless documents without `getElementById` / `getBoundingClientRect`,
   * and zero-size (unstyled / unmounted) buttons yield nothing, so the
   * caller falls back to {@link defaultActionRects}.
   */
  private actionRectsFromDom(): ActionHitRect[] {
    const doc = (globalThis as {
      document?: {
        getElementById?: (id: string) =>
          | { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } }
          | null;
      };
    }).document;
    if (doc === undefined || typeof doc.getElementById !== 'function') return [];
    const out: ActionHitRect[] = [];
    for (const id of TOUCH_ACTION_IDS) {
      const el = doc.getElementById(touchButtonDomId(id));
      if (el === null || el === undefined || typeof el.getBoundingClientRect !== 'function') {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) continue;
      out.push({ id, x: r.left, y: r.top, width: r.width, height: r.height });
    }
    return out;
  }

  // -- glassmorphic DOM visuals ---------------------------------------------------------

  /**
   * Lazily create `.lf-touch-stick-base` / `.lf-touch-stick-nub` and the
   * Spec 34 §2.1 right look-stick pair `.lf-touch-look-base` /
   * `.lf-touch-look-nub`. No-op headless.
   */
  private ensureVisuals(): void {
    if (!this.visualsEnabled || this.baseEl !== null) return;
    const doc = (globalThis as { document?: Document }).document;
    if (doc === undefined || doc === null || typeof doc.createElement !== 'function') return;
    const base = doc.createElement('div');
    base.className = 'lf-touch-stick-base is-hidden';
    const nub = doc.createElement('div');
    nub.className = 'lf-touch-stick-nub is-hidden';
    const lookBase = doc.createElement('div');
    lookBase.className = 'lf-touch-look-base is-hidden';
    const lookNub = doc.createElement('div');
    lookNub.className = 'lf-touch-look-nub is-hidden';
    doc.body.appendChild(base);
    doc.body.appendChild(nub);
    doc.body.appendChild(lookBase);
    doc.body.appendChild(lookNub);
    this.baseEl = base as unknown as { style: { [k: string]: string }; className: string };
    this.nubEl = nub as unknown as { style: { [k: string]: string }; className: string };
    this.lookBaseEl = lookBase as unknown as { style: { [k: string]: string }; className: string };
    this.lookNubEl = lookNub as unknown as { style: { [k: string]: string }; className: string };
  }

  private showStickVisuals(originX: number, originY: number): void {
    this.ensureVisuals();
    if (this.baseEl === null || this.nubEl === null) return;
    const r = STICK_MAX_RADIUS_PX;
    // Base ring centres on the floating origin; thumb centred at origin too
    // (translation applied via transform during the spring animation).
    this.baseEl.style.left = `${originX - r}px`;
    this.baseEl.style.top = `${originY - r}px`;
    this.nubEl.style.left = `${originX}px`;
    this.nubEl.style.top = `${originY}px`;
    this.baseEl.className = 'lf-touch-stick-base';
    this.nubEl.className = 'lf-touch-stick-nub';
  }

  private hideStickVisuals(): void {
    if (this.baseEl !== null) this.baseEl.className = 'lf-touch-stick-base is-hidden';
    // The nub stays visible while the spring settles, then hides in
    // syncVisuals() once it converges back on the origin.
  }

  private syncVisuals(): void {
    if (this.nubEl === null) return;
    if (this.stickTouchId === null && !this.isActive()) {
      this.nubEl.className = 'lf-touch-stick-nub is-hidden';
    }
    // Sprint-latch rim flare (hud.css `.is-sprint`).
    if (this.baseEl !== null && this.stickTouchId !== null) {
      this.baseEl.className = this.sprintLatched
        ? 'lf-touch-stick-base is-sprint'
        : 'lf-touch-stick-base';
    }
    const clampedX = clamp(
      this.spring.x,
      -STICK_MAX_RADIUS_PX,
      STICK_MAX_RADIUS_PX,
    );
    const clampedY = clamp(
      this.spring.y,
      -STICK_MAX_RADIUS_PX,
      STICK_MAX_RADIUS_PX,
    );
    this.nubEl.style.transform = `translate(calc(-50% + ${clampedX.toFixed(2)}px), calc(-50% + ${clampedY.toFixed(2)}px))`;
  }

  /** Anchor the look-stick ring/nub at the floating origin on grab. */
  private showLookVisuals(originX: number, originY: number): void {
    this.ensureLookHandles();
    if (this.lookBaseEl === null || this.lookNubEl === null) return;
    const r = LOOK_STICK_MAX_RADIUS_PX;
    this.lookBaseEl.style.left = `${originX - r}px`;
    this.lookBaseEl.style.top = `${originY - r}px`;
    this.lookNubEl.style.left = `${originX}px`;
    this.lookNubEl.style.top = `${originY}px`;
    this.lookBaseEl.className = 'lf-touch-look-base';
    this.lookNubEl.className = 'lf-touch-look-nub';
  }

  private hideLookVisuals(): void {
    if (this.lookBaseEl !== null) this.lookBaseEl.className = 'lf-touch-look-base is-hidden';
    // The nub stays visible while the spring settles, then hides in
    // syncLookVisuals() once it converges back on the origin.
  }

  private syncLookVisuals(): void {
    if (this.lookNubEl === null) return;
    if (this.lookTouchId === null && !this.isActive()) {
      this.lookNubEl.className = 'lf-touch-look-nub is-hidden';
    }
    const clampedX = clamp(
      this.lookSpring.x,
      -LOOK_STICK_MAX_RADIUS_PX,
      LOOK_STICK_MAX_RADIUS_PX,
    );
    const clampedY = clamp(
      this.lookSpring.y,
      -LOOK_STICK_MAX_RADIUS_PX,
      LOOK_STICK_MAX_RADIUS_PX,
    );
    this.lookNubEl.style.transform = `translate(calc(-50% + ${clampedX.toFixed(2)}px), calc(-50% + ${clampedY.toFixed(2)}px))`;
  }

  /**
   * Late-bind the look visuals when a synthetic grab arrives before
   * `attach()` (headless harnesses with `visuals: true` on a fake DOM).
   */
  private ensureLookHandles(): void {
    if (this.lookBaseEl !== null || !this.visualsEnabled) return;
    this.ensureVisuals();
  }

  /**
   * Lazily build the Spec 33 §2.2.4 action cluster:
   *
   * ```text
   *   #lf-touch-actions                 (fixed overlay, pointer-events: none)
   *     #btn-touch-jump   ⤒ JUMP        (bottom-right, above the smart key)
   *     #btn-touch-action ✋ ACTION      (dynamic label/icon/glow)
   *     #btn-touch-tuck   ⟳ TUCK        (left of the smart key, Spec 35)
   *     #btn-touch-map    🗺 MAP         (top-left utility corner)
   *     #btn-touch-ui     👁 UI          (top-right utility corner)
   *     #btn-touch-cam    🎥 VIEW        (utility row, left of UI, Spec 34)
   * ```
   *
   * Buttons are pure feedback surfaces — the controller claims touches at
   * the window level (pass 1 of `handleTouchStart`), so no per-button DOM
   * listeners exist and hidden buttons can never eat a gesture. No-op
   * headless (fake documents without `createElement` are declined).
   */
  private ensureActionCluster(): void {
    if (!this.visualsEnabled || this.clusterEl !== null) return;
    const doc = (globalThis as { document?: Document }).document;
    if (doc === undefined || doc === null || typeof doc.createElement !== 'function') {
      return;
    }
    const container = doc.createElement('div');
    container.id = 'lf-touch-actions';
    container.className = this.deckVisible
      ? 'lf-touch-actions'
      : 'lf-touch-actions is-gamepad-hidden';
    const makeButton = (
      id: TouchActionId,
      icon: string,
      label: string,
    ): { btn: LooseDomEl; iconEl: LooseDomEl; labelEl: LooseDomEl } => {
      const btn = doc.createElement('button');
      btn.id = touchButtonDomId(id);
      btn.className = `lf-touch-action-btn lf-touch-action-${id}`;
      btn.setAttribute?.('type', 'button');
      btn.setAttribute?.('aria-label', label);
      const iconEl = doc.createElement('span');
      iconEl.className = 'lf-touch-action-icon';
      iconEl.textContent = icon;
      const labelEl = doc.createElement('span');
      labelEl.className = 'lf-touch-action-label';
      labelEl.textContent = label;
      btn.appendChild(iconEl);
      btn.appendChild(labelEl);
      container.appendChild(btn);
      return {
        btn: btn as unknown as LooseDomEl,
        iconEl: iconEl as unknown as LooseDomEl,
        labelEl: labelEl as unknown as LooseDomEl,
      };
    };
    makeButton('jump', '⤒', 'JUMP');
    const ctx = makeButton(
      'action',
      this.contextualAction?.icon ?? '✋',
      this.contextualAction?.label ?? 'NO TARGET',
    );
    this.contextBtnEl = ctx.btn;
    this.contextIconEl = ctx.iconEl;
    this.contextLabelEl = ctx.labelEl;
    makeButton('roll', '⟳', 'TUCK');
    makeButton('map', '🗺', 'MAP');
    makeButton('ui', '👁', 'UI');
    makeButton('camera', '🎥', 'VIEW');
    doc.body.appendChild(container);
    this.clusterEl = container as unknown as LooseDomEl;
    this.syncContextButton();
  }

  /** Repaint the `[CONTEXTUAL ACTION]` label / icon / active glow. */
  private syncContextButton(): void {
    const btn = this.contextBtnEl;
    if (btn === null) return;
    const a = this.contextualAction;
    if (a === null) {
      btn.className = 'lf-touch-action-btn lf-touch-action-action is-empty';
      btn.setAttribute?.('data-active', '0');
      if (this.contextIconEl !== null) this.contextIconEl.textContent = '✋';
      if (this.contextLabelEl !== null) this.contextLabelEl.textContent = 'NO TARGET';
      return;
    }
    btn.className = a.active
      ? 'lf-touch-action-btn lf-touch-action-action is-active'
      : 'lf-touch-action-btn lf-touch-action-action';
    btn.setAttribute?.('data-active', a.active ? '1' : '0');
    btn.setAttribute?.('aria-label', a.label);
    if (this.contextIconEl !== null) this.contextIconEl.textContent = a.icon ?? '✋';
    if (this.contextLabelEl !== null) this.contextLabelEl.textContent = a.label;
  }

  private removeVisuals(): void {
    const doc = (globalThis as { document?: Document }).document;
    for (const el of [this.baseEl, this.nubEl, this.lookBaseEl, this.lookNubEl]) {
      if (el === null || doc === undefined || doc === null) continue;
      try {
        doc.body.removeChild(el as unknown as Node);
      } catch {
        /* already gone */
      }
    }
    this.baseEl = null;
    this.nubEl = null;
    this.lookBaseEl = null;
    this.lookNubEl = null;
    if (this.clusterEl !== null && doc !== undefined && doc !== null) {
      try {
        doc.body.removeChild(this.clusterEl as unknown as Node);
      } catch {
        /* already gone */
      }
    }
    this.clusterEl = null;
    this.contextBtnEl = null;
    this.contextIconEl = null;
    this.contextLabelEl = null;
  }
}
