/**
 * Lunar Frontier — mobile touch input deck (Spec 33 §2.2, Phase 2,
 * TASK-PLAY-080b).
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
 *   • FREE-LOOK RIGHT trackpad. Active zone is the right half of the viewport
 *     (X ≥ 45 % of width). Differential drag translates into camera yaw /
 *     pitch deltas (0.0035 / 0.0028 rad per pixel, pitch inverted), and a
 *     release flick faster than {@link FLICK_MIN_SPEED_PX_PER_MS} coasts with
 *     exponential decay (τ ≈ 120 ms) for cinematic camera glide.
 *
 *   • Glassmorphic DOM feedback: a translucent outer ring
 *     (`.lf-touch-stick-base`) and a glowing cyan thumb (`.lf-touch-stick-nub`)
 *     — both `pointer-events: none` so gestures never fight the canvas, styled
 *     from `src/ui/hud.css`. The thumb trails the deflection with a damped
 *     spring return to origin on `touchend`.
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
/** Right free-look trackpad zone: X ≥ this fraction of viewport width. */
export const LOOK_ZONE_MIN_X_RATIO = 0.45;

/** Stick deflection inside this radius (px) reads exactly (0, 0). */
export const STICK_DEAD_RADIUS_PX = 8;
/** Stick deflection beyond this radius (px) clamps to the rim. */
export const STICK_MAX_RADIUS_PX = 54;

/** Yaw sensitivity of the free-look trackpad (rad per horizontal px). */
export const TOUCH_LOOK_YAW_RAD_PER_PX = 0.0035;
/** Pitch sensitivity of the free-look trackpad (rad per vertical px, inverted). */
export const TOUCH_LOOK_PITCH_RAD_PER_PX = 0.0028;

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

/** Release flick speed (px/ms, vector magnitude) required for camera coast. */
export const FLICK_MIN_SPEED_PX_PER_MS = 0.4;
/** Inertial flick decay time constant (ms). */
export const FLICK_DECAY_TAU_MS = 120;
/** Flick velocity is estimated over this trailing window (ms). */
export const FLICK_SAMPLE_WINDOW_MS = 120;

/** Damped-spring visual return: stiffness (1/s²) and damping (1/s). */
export const STICK_SPRING_STIFFNESS = 260;
export const STICK_SPRING_DAMPING = 20;

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
  /** Any finger down, coast coasting, or spring still settling. */
  isActive: boolean;
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
}

interface Spring2D {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface FlickSample {
  x: number;
  y: number;
  t: number;
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

  // -- right look trackpad -----------------------------------------------------
  /** Touch identifier driving the trackpad, or null when released. */
  private lookTouchId: number | null = null;
  private lookLastX = 0;
  private lookLastY = 0;
  private lookLastT = 0;
  /** Trailing position/time samples for release-flick velocity estimation. */
  private readonly lookSamples: FlickSample[] = [];
  /** Coast velocity (rad per ms) after a fast flick release, both axes. */
  private coastYawRadPerMs = 0;
  private coastPitchRadPerMs = 0;

  // -- accumulated look deltas (consumed by poll()) ---------------------------
  private accYawRad = 0;
  private accPitchRad = 0;

  // -- DOM visuals --------------------------------------------------------------
  private baseEl: { style: { [k: string]: string }; className: string } | null = null;
  private nubEl: { style: { [k: string]: string }; className: string } | null = null;

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
    if (this.visualsEnabled) this.ensureVisuals();
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
    this.releaseLook(this.now(), false);
    this.spring.x = 0;
    this.spring.y = 0;
    this.spring.vx = 0;
    this.spring.vy = 0;
    this.accYawRad = 0;
    this.accPitchRad = 0;
    this.lastFlickAtMs = Number.NEGATIVE_INFINITY;
    this.stickPrevNorm = 0;
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
    for (const touch of event.changedTouches.length > 0
      ? event.changedTouches
      : event.touches) {
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
        this.lookTouchId = touch.identifier;
        this.lookLastX = touch.clientX;
        this.lookLastY = touch.clientY;
        this.lookLastT = t;
        this.lookSamples.length = 0;
        this.lookSamples.push({ x: touch.clientX, y: touch.clientY, t });
        // A fresh look grab kills any in-flight camera coast.
        this.coastYawRadPerMs = 0;
        this.coastPitchRadPerMs = 0;
        handled = true;
      }
    }
    if (handled) event.preventDefault?.();
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
        const dx = touch.clientX - this.lookLastX;
        const dy = touch.clientY - this.lookLastY;
        // Differential drag → yaw/pitch deltas (Spec 33 §2.2.3). Pitch is
        // inverted: dragging DOWN looks DOWN (screen y grows downward).
        this.accYawRad += dx * TOUCH_LOOK_YAW_RAD_PER_PX;
        this.accPitchRad += -dy * TOUCH_LOOK_PITCH_RAD_PER_PX;
        this.lookLastX = touch.clientX;
        this.lookLastY = touch.clientY;
        this.lookLastT = t;
        this.pushLookSample(touch.clientX, touch.clientY, t);
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
      if (this.stickTouchId !== null && touch.identifier === this.stickTouchId) {
        this.releaseStick(t);
        this.hideStickVisuals();
        handled = true;
      } else if (this.lookTouchId !== null && touch.identifier === this.lookTouchId) {
        this.releaseLook(t, true);
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
   * Advance the damped-spring thumb return and the exponential flick coast.
   * Call once per rendered frame (ClientApp feeds `dt * 1000`). Idempotent
   * across zero-dt calls; dt clamped to [0, 100] ms for tab-switch safety.
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

    // Exponential flick coast (Spec 33 §2.2.3): velocity decays with
    // τ = 120 ms; every frame emits its share into the accumulator poll()
    // consumes, so the camera glides to a smooth stop.
    if (dtS > 0 && this.hasCoast()) {
      this.accYawRad += this.coastYawRadPerMs * dt;
      this.accPitchRad += this.coastPitchRadPerMs * dt;
      const decay = Math.exp(-dt / FLICK_DECAY_TAU_MS);
      this.coastYawRadPerMs *= decay;
      this.coastPitchRadPerMs *= decay;
      if (Math.hypot(this.coastYawRadPerMs, this.coastPitchRadPerMs) < 1e-6) {
        this.coastYawRadPerMs = 0;
        this.coastPitchRadPerMs = 0;
      }
    }

    this.syncVisuals();
  }

  // -- output -----------------------------------------------------------------------

  /**
   * Consume this frame's normalized state (Spec 33 §2.2): movement + sprint
   * come from the live stick pose; `yawDelta` / `pitchDelta` are the look
   * radians accumulated since the PREVIOUS poll (including flick coast) and
   * are zeroed by this call.
   */
  poll(): TouchInputState {
    const state: TouchInputState = {
      forward: this.stickForward,
      strafe: this.stickStrafe,
      sprint: this.sprintLatched,
      yawDelta: this.accYawRad,
      pitchDelta: this.accPitchRad,
      isActive: this.isActive(),
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
    };
  }

  /** True while any finger owns a deck, coast runs, or the spring settles. */
  isActive(): boolean {
    return (
      this.stickTouchId !== null ||
      this.lookTouchId !== null ||
      this.hasCoast() ||
      Math.abs(this.spring.x) + Math.abs(this.spring.y) > 0.05 ||
      Math.abs(this.spring.vx) + Math.abs(this.spring.vy) > 0.05
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

  // -- zone maths ---------------------------------------------------------------------

  /** Bottom-left quadrant test (X ≤ 42 vw, Y ≥ 35 vh). */
  isInStickZone(x: number, y: number): boolean {
    return (
      x <= this.viewportWidth * STICK_ZONE_MAX_X_RATIO &&
      y >= this.viewportHeight * STICK_ZONE_MIN_Y_RATIO
    );
  }

  /** Right-half free-look test (X ≥ 45 vw). */
  isInLookZone(x: number, y: number): boolean {
    return x >= this.viewportWidth * LOOK_ZONE_MIN_X_RATIO;
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
   * Look release: estimate flick velocity over the trailing
   * {@link FLICK_SAMPLE_WINDOW_MS} window; above the threshold, arm the
   * exponential coast.
   */
  private releaseLook(nowMs: number, armCoast: boolean): void {
    if (this.lookTouchId === null) {
      this.coastYawRadPerMs = 0;
      this.coastPitchRadPerMs = 0;
      return;
    }
    this.lookTouchId = null;
    if (armCoast) {
      const v = this.estimateFlickVelocity(nowMs);
      if (Math.hypot(v.vx, v.vy) > FLICK_MIN_SPEED_PX_PER_MS) {
        // px/ms → rad/ms through the per-axis sensitivities.
        this.coastYawRadPerMs = v.vx * TOUCH_LOOK_YAW_RAD_PER_PX;
        this.coastPitchRadPerMs = -v.vy * TOUCH_LOOK_PITCH_RAD_PER_PX;
      } else {
        this.coastYawRadPerMs = 0;
        this.coastPitchRadPerMs = 0;
      }
    }
    this.lookSamples.length = 0;
  }

  /** Trailing-window velocity (px/ms) from the look sample ring buffer. */
  private estimateFlickVelocity(nowMs: number): { vx: number; vy: number } {
    const samples = this.lookSamples;
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const newest = samples[samples.length - 1];
    // Oldest sample still inside the estimation window.
    let oldest = samples[0];
    for (let i = samples.length - 1; i >= 0; i--) {
      if (newest.t - samples[i].t <= FLICK_SAMPLE_WINDOW_MS) oldest = samples[i];
      else break;
    }
    const dt = newest.t - oldest.t;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return { vx: (newest.x - oldest.x) / dt, vy: (newest.y - oldest.y) / dt };
  }

  private pushLookSample(x: number, y: number, t: number): void {
    this.lookSamples.push({ x, y, t });
    // Bounded window: drop anything older than the estimation window + slack.
    while (
      this.lookSamples.length > 2 &&
      t - this.lookSamples[0].t > FLICK_SAMPLE_WINDOW_MS * 2
    ) {
      this.lookSamples.shift();
    }
  }

  private hasCoast(): boolean {
    return this.coastYawRadPerMs !== 0 || this.coastPitchRadPerMs !== 0;
  }

  // -- glassmorphic DOM visuals ---------------------------------------------------------

  /** Lazily create `.lf-touch-stick-base` / `.lf-touch-stick-nub`. No-op headless. */
  private ensureVisuals(): void {
    if (!this.visualsEnabled || this.baseEl !== null) return;
    const doc = (globalThis as { document?: Document }).document;
    if (doc === undefined || doc === null || typeof doc.createElement !== 'function') return;
    const base = doc.createElement('div');
    base.className = 'lf-touch-stick-base is-hidden';
    const nub = doc.createElement('div');
    nub.className = 'lf-touch-stick-nub is-hidden';
    doc.body.appendChild(base);
    doc.body.appendChild(nub);
    this.baseEl = base as unknown as { style: { [k: string]: string }; className: string };
    this.nubEl = nub as unknown as { style: { [k: string]: string }; className: string };
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

  private removeVisuals(): void {
    const doc = (globalThis as { document?: Document }).document;
    for (const el of [this.baseEl, this.nubEl]) {
      if (el === null || doc === undefined || doc === null) continue;
      try {
        doc.body.removeChild(el as unknown as Node);
      } catch {
        /* already gone */
      }
    }
    this.baseEl = null;
    this.nubEl = null;
  }
}
