/**
 * Spec 34 Phase 4 acceptance (TASK-PLAY-081d) — Headless Smoke Verification
 * Suite & Build Gate. Runs under `npx tsx scripts/smoke-spec34-dual-sticks-view.ts`
 * (exit 0 == all green).
 *
 * Sections:
 *   A — Default camera perspective: `CameraRig` / `WorldScene` / `ClientApp`
 *       source defaults are `eva_third_person`, and the ClientApp boots the
 *       live rig in `eva_third_person` (Spec 34 §2.2).
 *   B — Dedicated `[🎥 VIEW]` touch button: `#btn-touch-cam` mounts in the
 *       utility cluster with a ≥ 44 px hit target, taps cycle
 *       eva_third_person → vehicle_chase → eva_first_person →
 *       eva_third_person, every tap fires the 15 ms `uiTap()` haptic pulse,
 *       and a camera-button finger is CLAIMED by the cluster (never paints
 *       the look stick).
 *   C — Floating dynamic RIGHT virtual stick kinematics (Spec 34 §2.1):
 *       active zone (X ≥ 0.45 W, Y ≥ 0.20 H), dynamic origin anchoring,
 *       8 px deadzone, 54 px outer clamp, the proportional ω law
 *       (Ω_yaw = 2.4, Ω_pitch = 1.8 rad/s), ω·Δt frame integration, the
 *       instant zero on release (no coast / drift), and the damped-spring
 *       visual return (k = 260, c = 20).
 *   D — Service Worker & PWA manifest (Spec 34 §2.3): `sw.js` parses and
 *       carries install/activate/fetch + claim/precache law, the manifest is
 *       valid installable JSON, and `main.ts` registers the SW.
 *   E — ClientApp integration on NullEngine: left stick movement + right
 *       stick look + `[🎥 VIEW]` cycling all live CONCURRENTLY, and every
 *       channel falls silent after the lift.
 *
 * Synthetic events carry an EXPLICIT `time` clock (pitfall #53) and every
 * injection is followed by at least one `app.update(t)` before sampling.
 */
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';

import { ClientApp } from '../src/client/ClientApp.ts';
import {
  LOOK_PITCH_MAX_RAD_PER_S,
  LOOK_STICK_DEAD_RADIUS_PX,
  LOOK_STICK_MAX_RADIUS_PX,
  LOOK_YAW_MAX_RAD_PER_S,
  LOOK_ZONE_MIN_X_RATIO,
  LOOK_ZONE_MIN_Y_RATIO,
  STICK_SPRING_DAMPING,
  STICK_SPRING_STIFFNESS,
  TOUCH_ACTION_IDS,
  TouchInputController,
  UTILITY_BUTTON_PX,
  touchButtonDomId,
  type ActionHitRect,
  type TouchEventLike,
} from '../src/client/TouchInputController.ts';
import { UI_TAP_PULSE_MS } from '../src/audio/TactileHaptics.ts';
import NetworkClient from '../src/network/NetworkClient.ts';

// ---------------------------------------------------------------------------
// Check bookkeeping (same idiom as the other smoke suites)
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const src = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const VIEW_W = 1280;
const VIEW_H = 800;

let clockMs = 1_000;

/** Synthetic single-finger touch event with an explicit scripted clock. */
function tev(id: number, x: number, y: number): TouchEventLike {
  clockMs += 8;
  return {
    touches: [],
    changedTouches: [{ identifier: id, clientX: x, clientY: y }],
    time: clockMs,
  };
}

function rectOf(rects: ActionHitRect[], id: string): ActionHitRect {
  const r = rects.find((x) => x.id === id);
  assert.ok(r !== undefined, `missing rect for ${id}`);
  return r;
}

function centerOf(r: ActionHitRect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function makeController(visuals = false): TouchInputController {
  return new TouchInputController({
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    visuals,
    now: () => clockMs,
  });
}

/** Spec 34 §2.1 angular-velocity law, re-derived independently here. */
function omegaLaw(dx: number, dy: number): { yaw: number; pitch: number } {
  const r = Math.hypot(dx, dy);
  if (r <= LOOK_STICK_DEAD_RADIUS_PX) return { yaw: 0, pitch: 0 };
  const ux = dx / r;
  const uy = dy / r;
  const norm = Math.min(
    1,
    Math.max(
      0,
      (Math.min(r, LOOK_STICK_MAX_RADIUS_PX) - LOOK_STICK_DEAD_RADIUS_PX) /
        (LOOK_STICK_MAX_RADIUS_PX - LOOK_STICK_DEAD_RADIUS_PX),
    ),
  );
  return {
    yaw: ux * norm * LOOK_YAW_MAX_RAD_PER_S,
    pitch: -uy * norm * LOOK_PITCH_MAX_RAD_PER_S,
  };
}

const approx = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// Minimal fake DOM (the HUD / touch-deck subset only) — same idiom as
// smoke-touch-actions-phase3.
// ---------------------------------------------------------------------------

interface FakeElement {
  id: string;
  className: string;
  textContent: string | null;
  style: { [k: string]: string };
  classList: { add(n: string): void; remove(n: string): void; contains(n: string): boolean };
  children: FakeElement[];
  parent: FakeElement | null;
  appendChild<T extends FakeElement>(child: T): T;
  remove(): void;
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  addEventListener(t: string, l: (e: unknown) => void): void;
  text(): string;
}

function makeFakeElement(tag: string, registry: Map<string, FakeElement>): FakeElement {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  let ownText = '';
  let ownId = '';
  const el: FakeElement = {
    get id(): string {
      return ownId;
    },
    set id(value: string) {
      // Real DOM law: assigning `.id` registers the element for getElementById.
      ownId = value;
      if (value.length > 0) registry.set(value, el);
    },
    className: tag,
    get textContent(): string {
      return ownText;
    },
    set textContent(value: string | null) {
      ownText = value ?? '';
      for (const child of el.children) {
        if (child.id.length > 0 && registry.get(child.id) === child) registry.delete(child.id);
        child.parent = null;
      }
      el.children.length = 0;
    },
    style: {},
    classList: {
      add: (n: string) => classes.add(n),
      remove: (n: string) => classes.delete(n),
      contains: (n: string) => classes.has(n),
    },
    children: [],
    parent: null,
    appendChild(child) {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (el.parent !== null) {
        const i = el.parent.children.indexOf(el);
        if (i >= 0) el.parent.children.splice(i, 1);
        el.parent = null;
      }
      if (el.id.length > 0 && registry.get(el.id) === el) registry.delete(el.id);
    },
    getAttribute: (n: string) => attributes.get(n) ?? null,
    setAttribute(n: string, v: string) {
      attributes.set(n, v);
      if (n === 'id') {
        el.id = v;
        registry.set(v, el);
      }
    },
    addEventListener(t, l) {
      const list = listeners.get(t) ?? [];
      list.push(l);
      listeners.set(t, list);
    },
    text() {
      return (el.textContent ?? '') + el.children.map((c) => c.text()).join('');
    },
  };
  return el;
}

function makeFakeDocument(): {
  body: FakeElement;
  createElement(tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
} {
  const registry = new Map<string, FakeElement>();
  return {
    body: makeFakeElement('body', registry),
    createElement: (tag: string) => {
      const el = makeFakeElement(tag, registry);
      if (tag === 'canvas') {
        (el as unknown as Record<string, unknown>)['getContext'] = () => null;
      }
      return el;
    },
    getElementById: (id: string) => registry.get(id) ?? null,
  };
}

let netNowMs = 10_000;

function makeScriptedNetwork(): NetworkClient {
  const net = new NetworkClient({
    url: 'ws://scripted.test/ws',
    socketFactory: () => {
      throw new Error('scripted network must never open a socket');
    },
    clock: () => netNowMs,
    heartbeatIntervalMs: 0,
    autoReconnect: false,
  });
  const internals = net as unknown as {
    socketState: string;
    sendFrame(frame: Record<string, unknown>): boolean;
  };
  internals.socketState = 'open';
  internals.sendFrame = () => true;
  return net;
}

let frameAt = 100_000;

// Camera-rig handle via structural cast (ClientApp keeps `world` private).
interface RigLike {
  getMode(): string;
}
function rigOf(app: ClientApp): RigLike {
  return (
    app as unknown as { world: { getCameraRig(): RigLike } }
  ).world.getCameraRig();
}

async function main(): Promise<void> {
  (globalThis as { document?: unknown }).document = makeFakeDocument();

  // ---------------------------------------------------------------------
  // Fake Vibration API: capture every pattern the haptics engine dispatches
  // (uiTap = 15 ms crisp tick — distinct from footfall 12 / mining 25 /
  // collision 60 / RCS [15,30,20]).
  // ---------------------------------------------------------------------
  const vibratePatterns: Array<number | readonly number[]> = [];
  const vibrateFn = (pattern: number | readonly number[]): boolean => {
    vibratePatterns.push(pattern);
    return true;
  };
  const prevNavigator = (globalThis as { navigator?: unknown }).navigator;
  const navTarget: Record<string, unknown> =
    prevNavigator !== undefined && prevNavigator !== null
      ? (prevNavigator as Record<string, unknown>)
      : {};
  Object.defineProperty(navTarget, 'vibrate', {
    configurable: true,
    writable: true,
    value: vibrateFn,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: navTarget,
  });

  // ---------------------------------------------------------------------
  // Boot the integration app FIRST (NullEngine + injected touch deck) so
  // Sections A/B/E can share one live world.
  // ---------------------------------------------------------------------
  const deck = makeController(true);
  const app = new ClientApp({
    seed: 'spec34-phase4-dual-sticks',
    username: 'viewpilot',
    faction: 'ARTEMIS',
    network: makeScriptedNetwork(),
    moveIntervalMs: 50,
    silent: true,
    touchInput: deck,
  });
  await app.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));

  const step = (n: number): void => {
    for (let i = 0; i < n; i++) {
      frameAt += 16;
      app.update(frameAt);
      netNowMs += 16;
    }
  };
  step(2);

  // Headless: ClientApp's own `touchInput.attach()` declined (no window), so
  // mount the glassmorphic cluster against a bare event-target to exercise
  // the real DOM build path (creates #btn-touch-cam in the fake document).
  const mounted = deck.attach({ addEventListener: () => undefined });

  // =====================================================================
  // SECTION A — Default camera perspective (Spec 34 §2.2)
  // =====================================================================
  section('A. default camera perspective: eva_third_person');
  {
    const rigSrc = src('src/engine/CameraRig.ts');
    check(
      "CameraRig defaults to 'eva_third_person' (options.initialMode ?? 'eva_third_person')",
      rigSrc.includes("options.initialMode ?? 'eva_third_person'"),
    );
    const wsSrc = src('src/engine/WorldScene.ts');
    check(
      "WorldScene passes cameraMode ?? 'eva_third_person' into the rig",
      wsSrc.includes("this.options.cameraMode ?? 'eva_third_person'"),
    );
    const appSrc = src('src/client/ClientApp.ts');
    check(
      "ClientApp.lastEvaCamera starts as 'eva_third_person'",
      appSrc.includes("lastEvaCamera: CameraMode = 'eva_third_person'"),
    );
    check('ClientApp boots the live rig in eva_third_person', rigOf(app).getMode() === 'eva_third_person');
    check('boot travel mode is on foot (suit)', app.getMode() === 'suit');
  }

  // =====================================================================
  // SECTION B — Dedicated [🎥 VIEW] touch button (Spec 34 §2.2)
  // =====================================================================
  section('B. [🎥 VIEW] touch button: mount, size, cycle, haptics, isolation');
  {
    const doc = (globalThis as { document: { getElementById(id: string): FakeElement | null } }).document;
    const camBtn = doc.getElementById(touchButtonDomId('camera'));
    check('deck.attach() mounted the action cluster', mounted === true);
    check('#btn-touch-cam exists in the mounted DOM', camBtn !== null);
    check(
      '#btn-touch-cam carries the utility-button glass class + VIEW label',
      camBtn !== null &&
        camBtn.className.includes('lf-touch-action-btn') &&
        camBtn.className.includes('lf-touch-action-camera') &&
        camBtn.getAttribute('aria-label') === 'VIEW',
      camBtn === null ? 'button missing' : `class=${camBtn.className} aria=${camBtn.getAttribute('aria-label')}`,
    );
    check('button content includes the 🎥 icon and VIEW text', (camBtn?.text() ?? '').includes('\u{1F3A5}') && (camBtn?.text() ?? '').includes('VIEW'));

    // Hit-target law: resolved rect (analytic layout mirror of hud.css) is
    // 52 px — comfortably above the 44 px Chromium floor.
    const rects = deck.getActionHitRects();
    const camRect = rectOf(rects, 'camera');
    check('camera button resolves a hit rect in the utility row', camRect.width > 0 && camRect.height > 0);
    check(
      '#btn-touch-cam hit target ≥ 44 px × 44 px',
      camRect.width >= 44 && camRect.height >= 44,
      `${camRect.width}×${camRect.height}`,
    );
    check('UTILITY_BUTTON_PX constant ≥ 44 px law (52 px styled)', UTILITY_BUTTON_PX >= 44 && UTILITY_BUTTON_PX === 52);
    const hudCss = src('src/ui/hud.css');
    check('#btn-touch-cam is styled in hud.css', hudCss.includes('#btn-touch-cam'));

    // Cycle law on the live app: third → chase → first → third.
    const tapCam = (id: number): void => {
      const c = centerOf(camRect);
      deck.handleTouchStart(tev(id, c.x, c.y));
      step(1);
      deck.handleTouchEnd(tev(id, c.x, c.y));
      step(1);
    };
    check('boot mode before cycling', rigOf(app).getMode() === 'eva_third_person');
    tapCam(61);
    check('tap 1: eva_third_person → vehicle_chase', rigOf(app).getMode() === 'vehicle_chase', rigOf(app).getMode());
    tapCam(62);
    check('tap 2: vehicle_chase → eva_first_person', rigOf(app).getMode() === 'eva_first_person', rigOf(app).getMode());
    tapCam(63);
    check('tap 3: eva_first_person → eva_third_person (full circle)', rigOf(app).getMode() === 'eva_third_person', rigOf(app).getMode());

    // Haptics: every VIEW tap fired exactly one uiTap() AND dispatched the
    // crisp 15 ms navigator.vibrate pattern.
    const uiTicks = vibratePatterns.filter((p) => p === UI_TAP_PULSE_MS).length;
    check(`each VIEW tap fired a ${UI_TAP_PULSE_MS} ms haptic pulse (3 expected)`, uiTicks >= 3, `patterns=${JSON.stringify(vibratePatterns)}`);
    check('UI_TAP_PULSE_MS is 15 ms per Spec 34 §2.2.1', UI_TAP_PULSE_MS === 15);

    // Spy the uiTap lane directly (dispatch-path proof, pattern-independent).
    let uiTapCalls = 0;
    const haptics = app.haptics as unknown as { uiTap(): boolean };
    const realUiTap = haptics.uiTap.bind(app.haptics);
    haptics.uiTap = (): boolean => {
      uiTapCalls++;
      return realUiTap();
    };
    tapCam(64);
    check('tap triggers exactly one uiTap() call (spy)', uiTapCalls === 1, `spy count = ${uiTapCalls}`);
    haptics.uiTap = realUiTap;

    // Touch isolation: a finger on #btn-touch-cam is CLAIMED by the cluster
    // — it never claims the look stick and paints zero look delta.
    const c = centerOf(camRect);
    deck.handleTouchStart(tev(70, c.x, c.y));
    check('camera-button finger claims a touch id (hasFingerDown)', deck.hasFingerDown() === true);
    check('camera-button finger does NOT claim the look stick', deck.getLookGeometry().active === false);
    deck.handleTouchMove(tev(70, c.x - 220, c.y + 180));
    deck.update(16);
    const iso = deck.poll();
    check('dragging off the button paints 0 look delta', iso.yawDelta === 0 && iso.pitchDelta === 0);
    check('dragging off the button paints 0 movement', iso.forward === 0 && iso.strafe === 0);
    const drained = deck.consumeActions();
    check(
      'the press queued exactly one discrete "camera" tap',
      drained.length === 1 && drained[0] === 'camera',
      JSON.stringify(drained),
    );
    deck.handleTouchEnd(tev(70, c.x - 220, c.y + 180));
    step(1);
    check('all buttons (incl. camera) resolve ≥ 44 px rects', rects.every((r) => r.width >= 44 && r.height >= 44));
    check('cluster contains the camera id in iteration order', TOUCH_ACTION_IDS.includes('camera'));
  }

  // =====================================================================
  // SECTION C — Floating dynamic right virtual stick (Spec 34 §2.1)
  // =====================================================================
  section('C. right look stick: zone, origin, deadzone, clamp, ω law, integration, release, spring');
  {
    const c = makeController();

    // Exported tunables match the spec sheet exactly.
    check('LOOK_ZONE_MIN_X_RATIO = 0.45', LOOK_ZONE_MIN_X_RATIO === 0.45);
    check('LOOK_ZONE_MIN_Y_RATIO = 0.20', LOOK_ZONE_MIN_Y_RATIO === 0.2);
    check('LOOK_STICK_DEAD_RADIUS_PX = 8', LOOK_STICK_DEAD_RADIUS_PX === 8);
    check('LOOK_STICK_MAX_RADIUS_PX = 54', LOOK_STICK_MAX_RADIUS_PX === 54);
    check('Ω_max,yaw = 2.4 rad/s', LOOK_YAW_MAX_RAD_PER_S === 2.4);
    check('Ω_max,pitch = 1.8 rad/s', LOOK_PITCH_MAX_RAD_PER_S === 1.8);
    check('spring k = 260, c = 20', STICK_SPRING_STIFFNESS === 260 && STICK_SPRING_DAMPING === 20);

    // Active zone: X ≥ 0.45·W (576 px) AND Y ≥ 0.20·H (160 px).
    check('zone: (0.45W, 0.20H) boundary is INSIDE', c.isInLookZone(0.45 * VIEW_W, 0.2 * VIEW_H));
    check('zone: x just below 0.45W is OUTSIDE', !c.isInLookZone(0.45 * VIEW_W - 0.1, 0.2 * VIEW_H));
    check('zone: y just below 0.20H is OUTSIDE', !c.isInLookZone(0.45 * VIEW_W, 0.2 * VIEW_H - 0.1));
    check('zone: bottom-right corner is INSIDE', c.isInLookZone(VIEW_W - 1, VIEW_H - 1));
    check('zone: left half is OUTSIDE', !c.isInLookZone(0.3 * VIEW_W, 0.6 * VIEW_H));

    // Dynamic origin anchors to the initial touchstart coordinate.
    const ox = 700;
    const oy = 400;
    c.handleTouchStart(tev(1, ox, oy));
    let g = c.getLookGeometry();
    check('grab anchors the floating origin exactly at the contact point', g.active && g.originX === ox && g.originY === oy);
    check('fresh grab starts dead still (ω = 0)', g.omegaYaw === 0 && g.omegaPitch === 0);
    c.handleTouchEnd(tev(1, ox, oy));

    // Re-anchor at a second point proves the origin is dynamic, not fixed.
    c.handleTouchStart(tev(2, 900, 620));
    g = c.getLookGeometry();
    check('second grab re-anchors the origin (dynamic, not fixed)', g.originX === 900 && g.originY === 620);
    c.handleTouchEnd(tev(2, 900, 620));
    c.reset();

    // Deadzone: deflections ≤ 8 px read exactly zero.
    c.handleTouchStart(tev(3, ox, oy));
    for (const [dx, dy] of [[0, 0], [4, 0], [0, -4], [5, 5], [8, 0], [0, 8]] as const) {
      c.handleTouchMove(tev(3, ox + dx, oy + dy));
      const dg = c.getLookGeometry();
      check(
        `deadzone r=${Math.hypot(dx, dy).toFixed(1)}px → ω = (0, 0)`,
        dg.omegaYaw === 0 && dg.omegaPitch === 0 && dg.radiusNorm === 0,
        JSON.stringify(dg),
      );
    }

    // Proportional angular-velocity law vs the independently-derived replica.
    const lawCases: Array<readonly [number, number]> = [
      [30, 0], // pure right
      [0, -40], // pure up  → positive pitch
      [0, 40], // pure down → negative pitch
      [-34, 0], // pure left
      [22, -18], // diagonal
      [54, 0], // exactly at the rim
      [200, 0], // beyond the rim → clamped
      [0, -500], // beyond the rim, vertical → clamped
    ];
    for (const [dx, dy] of lawCases) {
      c.handleTouchMove(tev(3, ox + dx, oy + dy));
      const dg = c.getLookGeometry();
      const want = omegaLaw(dx, dy);
      check(
        `ω law replica at deflection (${dx}, ${dy}): yaw ${want.yaw.toFixed(4)} pitch ${want.pitch.toFixed(4)}`,
        approx(dg.omegaYaw, want.yaw, 1e-9) && approx(dg.omegaPitch, want.pitch, 1e-9),
        `got yaw=${dg.omegaYaw} pitch=${dg.omegaPitch}`,
      );
    }

    // Sign conventions spelled out: right = +yaw, UP = +pitch.
    c.handleTouchMove(tev(3, ox + 40, oy));
    check('right deflection → positive ω_yaw', c.getLookGeometry().omegaYaw > 0);
    c.handleTouchMove(tev(3, ox, oy - 40));
    check('up deflection → positive ω_pitch (drag up looks up)', c.getLookGeometry().omegaPitch > 0);
    c.handleTouchMove(tev(3, ox, oy + 40));
    check('down deflection → negative ω_pitch', c.getLookGeometry().omegaPitch < 0);

    // Outer clamp: r = 200 px saturates at r_norm = 1 → ω_yaw exactly Ω_max.
    c.handleTouchMove(tev(3, ox + 200, oy));
    g = c.getLookGeometry();
    check('beyond-rim deflection clamps r_norm to 1', g.radiusNorm === 1 && g.radiusPx === 200);
    check('clamped ω_yaw saturates at exactly 2.4 rad/s', g.omegaYaw === LOOK_YAW_MAX_RAD_PER_S);

    // Frame integration Δθ = ω·Δt.
    c.handleTouchMove(tev(3, ox + 30, oy));
    const held = c.getLookGeometry();
    c.update(16);
    const frame1 = c.poll();
    check(
      'integration: yawDelta = ω·16 ms',
      approx(frame1.yawDelta, held.omegaYaw * 0.016, 1e-12),
      `${frame1.yawDelta} vs ${held.omegaYaw * 0.016}`,
    );
    c.update(16);
    const frame2 = c.poll();
    check('continuous hold keeps a CONSTANT ω (frame2 ≈ frame1)', approx(frame2.yawDelta, frame1.yawDelta, 1e-12));
    c.update(32);
    const frame3 = c.poll();
    check('longer dt integrates proportionally more (32 ms = 2 × 16 ms)', approx(frame3.yawDelta, frame1.yawDelta * 2, 1e-12));
    c.update(0);
    check('zero-dt pump adds no rotation (tab-switch safety)', c.poll().yawDelta === 0);

    // Release: ω drops to EXACTLY zero — no residual coast, no drift.
    c.handleTouchEnd(tev(3, ox + 30, oy));
    g = c.getLookGeometry();
    check('release zeroes ω instantly', g.active === false && g.omegaYaw === 0 && g.omegaPitch === 0);

    // Damped-spring visual return (k = 260, c = 20): the nub was seeded at
    // the lift deflection and damps home. Validate the trajectory against an
    // exact replica of the SAME semi-implicit Euler integration the
    // controller runs (an underdamped spring is NOT per-frame monotone, so
    // replica equality is the honest law check — and it doubles as proof of
    // zero look drift across the entire return).
    const spring = (c as unknown as { lookSpring: { x: number; y: number; vx: number; vy: number } }).lookSpring;
    check('spring seeded at the lift deflection (30 px)', Math.abs(spring.x - 30) < 1e-9 && spring.y === 0, `x=${spring.x}`);
    const dtS = 0.016;
    let sx = spring.x;
    let sv = spring.vx;
    let sy = spring.y;
    let sw = spring.vy;
    let trajectoryMatches = true;
    let driftAcrossReturn = 0;
    for (let i = 0; i < 120; i++) {
      c.update(16);
      sv += (-STICK_SPRING_STIFFNESS * sx - STICK_SPRING_DAMPING * sv) * dtS;
      sx += sv * dtS;
      sw += (-STICK_SPRING_STIFFNESS * sy - STICK_SPRING_DAMPING * sw) * dtS;
      sy += sw * dtS;
      if (Math.abs(sx - spring.x) > 1e-9 || Math.abs(sv - spring.vx) > 1e-9) {
        trajectoryMatches = false;
      }
      driftAcrossReturn += c.poll().yawDelta;
    }
    check('nub follows the damped spring (k = 260, c = 20) exactly over 120 frames', trajectoryMatches,
      `replica x=${sx.toFixed(6)} vs live x=${spring.x.toFixed(6)}`);
    check('zero look drift across the whole spring return', driftAcrossReturn === 0, `${driftAcrossReturn}`);
    check(
      'spring converges home (|x|+|vx| < 0.05)',
      Math.abs(spring.x) + Math.abs(spring.vx) < 0.05,
      `x=${spring.x} vx=${spring.vx}`,
    );

    // Visual clamp: a 200 px hold paints the nub pinned at the 54 px rim.
    const cv = makeController(true); // visuals on, fake DOM present
    cv.attach({ addEventListener: () => undefined });
    cv.handleTouchStart(tev(4, ox, oy));
    cv.handleTouchMove(tev(4, ox + 200, oy));
    for (let i = 0; i < 10; i++) cv.update(16);
    const nubStyle = (cv as unknown as { lookNubEl: { style: { [k: string]: string } } | null }).lookNubEl?.style;
    check(
      'nub visual pinned at the 54 px rim rim-clamp',
      (nubStyle?.['transform'] ?? '').includes('54.00px'),
      `transform = ${nubStyle?.['transform'] ?? '(none)'}`,
    );
    cv.handleTouchEnd(tev(4, ox + 200, oy));
    cv.dispose();
  }

  // =====================================================================
  // SECTION D — Service Worker & PWA manifest (Spec 34 §2.3)
  // =====================================================================
  section('D. Service Worker + PWA manifest + registration');
  {
    // -- sw.js: exists, parses, carries the lifecycle law ------------------
    const swPath = path.join(ROOT, 'public/sw.js');
    check('public/sw.js exists on disk', existsSync(swPath));
    const swSrc = readFileSync(swPath, 'utf8');
    let parses = true;
    try {
      // Syntax-only validation (vm.Script compiles without executing).
      new vm.Script(swSrc, { filename: 'sw.js' });
    } catch (err) {
      parses = false;
      check('sw.js compiles cleanly', false, String(err));
    }
    if (parses) check('sw.js compiles cleanly (valid JS syntax)', true);
    check("sw.js handles 'install'", /addEventListener\(\s*['"]install['"]/.test(swSrc));
    check("sw.js handles 'activate'", /addEventListener\(\s*['"]activate['"]/.test(swSrc));
    check("sw.js handles 'fetch'", /addEventListener\(\s*['"]fetch['"]/.test(swSrc));
    check('sw.js claims clients immediately (clients.claim)', swSrc.includes('clients.claim()'));
    check('sw.js pre-caches the app shell (index.html + manifest)', swSrc.includes('./index.html') && swSrc.includes('./manifest.webmanifest'));
    check('sw.js bypasses /ws and /api traffic (no stale realtime)', swSrc.includes('/ws') && swSrc.includes('/api'));

    // -- manifest.webmanifest: valid installable JSON ----------------------
    const mfPath = path.join(ROOT, 'public/manifest.webmanifest');
    check('public/manifest.webmanifest exists on disk', existsSync(mfPath));
    const mf = JSON.parse(readFileSync(mfPath, 'utf8')) as {
      name?: string;
      short_name?: string;
      display?: string;
      start_url?: string;
      scope?: string;
      icons?: Array<{ src?: string; sizes?: string; type?: string }>;
    };
    check('manifest parses as JSON with a name', typeof mf.name === 'string' && mf.name.length > 0);
    check('manifest declares display: standalone', mf.display === 'standalone');
    check('manifest declares start_url and scope', typeof mf.start_url === 'string' && typeof mf.scope === 'string');
    check(
      'manifest ships ≥ 1 icon with sizes (192/512 law)',
      Array.isArray(mf.icons) && mf.icons.length >= 1 && mf.icons.every((i) => typeof i.sizes === 'string' && /x/.test(i.sizes)),
    );
    const iconFiles = ['icons/icon-192.png', 'icons/icon-512.png'].every((f) => existsSync(path.join(ROOT, 'public', f)));
    check('icon files referenced by the manifest exist on disk', iconFiles);

    // -- registration in main.ts ------------------------------------------
    const mainSrc = src('src/client/main.ts');
    check('main.ts defines registerServiceWorker()', mainSrc.includes('function registerServiceWorker()'));
    check('main.ts invokes registerServiceWorker() at boot', /\nregisterServiceWorker\(\);/.test(mainSrc));
    check("main.ts registers './sw.js'", mainSrc.includes("'./sw.js'"));
    check("main.ts logs '[pwa] Service Worker registered'", mainSrc.includes('[pwa] Service Worker registered'));
    check("main.ts guards on 'serviceWorker' in navigator", mainSrc.includes("'serviceWorker' in nav"));
    const htmlSrc = src('src/client/index.html');
    check('index.html links the manifest', htmlSrc.includes('rel="manifest"') && htmlSrc.includes('manifest.webmanifest'));
  }

  // =====================================================================
  // SECTION E — ClientApp integration: dual sticks + view concurrently
  // =====================================================================
  section('E. ClientApp integration: movement + look + VIEW cycle, concurrently');
  {
    const rects = deck.getActionHitRects();
    const camC = centerOf(rectOf(rects, 'camera'));

    const modeBefore = rigOf(app).getMode();
    const headingBefore = app.getSuit().getState().heading;

    // Finger 1: left movement stick, held forward.
    deck.handleTouchStart(tev(80, 300, 600));
    deck.handleTouchMove(tev(80, 300, 540));
    // Finger 2: right look stick, held right.
    deck.handleTouchStart(tev(81, 700, 300));
    deck.handleTouchMove(tev(81, 760, 300));
    // Finger 3: VIEW button tap while BOTH sticks are live.
    deck.handleTouchStart(tev(82, camC.x, camC.y));
    step(2);

    const frame = app.sampleInput();
    check('left stick lands as forward > 0 in the input frame', frame.forward > 0, JSON.stringify(frame));
    check('right stick claims the look stick concurrently', deck.getLookGeometry().active === true);
    check('VIEW tap cycled the camera (concurrent with both sticks)', rigOf(app).getMode() !== modeBefore, `${modeBefore} → ${rigOf(app).getMode()}`);

    deck.handleTouchEnd(tev(82, camC.x, camC.y));
    step(3);
    const midHeading = app.getSuit().getState().heading;
    check('right stick yaw rotated the suit heading', midHeading !== headingBefore, `${headingBefore} → ${midHeading}`);

    // Release everything: both channels fall instantly silent.
    deck.handleTouchEnd(tev(80, 300, 540));
    deck.handleTouchEnd(tev(81, 760, 300));
    step(1);
    const idleFrame = app.sampleInput();
    check('lift clears the movement channels', idleFrame.forward === 0 && idleFrame.strafe === 0);
    const settleHeading = app.getSuit().getState().heading;
    step(10);
    check('look drifts 0 after release (heading frozen)', app.getSuit().getState().heading === settleHeading,
      `${settleHeading} → ${app.getSuit().getState().heading}`);

    check('tri-state source is touch after the screen session', app.getInputSource() === 'touch');
  }

  app.dispose();
  deck.dispose();
  check('dispose tears the integration app down cleanly', true);

  (globalThis as { navigator?: unknown }).navigator = prevNavigator;
  delete (globalThis as { document?: unknown }).document;

  console.log(`\n${'='.repeat(58)}`);
  if (failures.length > 0) {
    console.error(`💥 smoke-spec34-dual-sticks-view: ${failures.length} FAILURE(S):`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log(`🎉 smoke-spec34-dual-sticks-view: ALL ${passed} CHECKS GREEN`);
}

void main().catch((err: unknown) => {
  console.error('💥 smoke-spec34-dual-sticks-view crashed:', err);
  delete (globalThis as { document?: unknown }).document;
  process.exit(1);
});
