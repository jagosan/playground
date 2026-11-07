/**
 * Spec 33 Phase 3 acceptance (TASK-PLAY-080c) — Contextual Action Buttons &
 * Tri-State Input Dispatch. Runs under `npx tsx scripts/smoke-touch-actions-
 * phase3.ts` (exit 0 == all green).
 *
 * Layer 1 — TouchInputController unit (pure, no DOM): hit-target geometry
 *   (≥ 52 px law), jump/roll hold latches, one-shot tap queue, touch
 *   isolation (cluster fingers never paint the look trackpad), hidden-deck
 *   swallowing, contextual state, reset semantics.
 * Layer 2 — ClientApp integration on NullEngine + fake DOM: tri-state
 *   keyboard → touch → gamepad → touch transitions, deck auto-hide via
 *   `.is-gamepad-hidden` / setVisible, button press latches landing in
 *   `ClientInputFrame`, proximity-proxied smart ACTION firing (BOARD →
 *   DISMOUNT round-trip) under synthetic touches, and the `[👆] TAP …` HUD
 *   prompt re-glyphing.
 *
 * Synthetic events carry an EXPLICIT `time` clock (pitfall #53: the wall
 * clock barely advances between back-to-back injected touchmoves, which
 * would explode the flick-velocity estimator), and every injection is
 * followed by at least one `app.update(t)` before sampling.
 */
import assert from 'node:assert';

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';

import { ClientApp } from '../src/client/ClientApp.ts';
import {
  ACTION_BUTTON_MIN_PX,
  CONTEXT_BUTTON_PX,
  JUMP_BUTTON_PX,
  ROLL_BUTTON_PX,
  TOUCH_ACTION_IDS,
  TouchInputController,
  UTILITY_BUTTON_PX,
  type ActionHitRect,
  type TouchEventLike,
} from '../src/client/TouchInputController.ts';
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

function makeController(): TouchInputController {
  return new TouchInputController({
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    visuals: false,
    now: () => clockMs,
  });
}

// ===========================================================================
// LAYER 1 — TouchInputController unit
// ===========================================================================

section('1a. action cluster geometry (Spec 33 §2.2.4 hit-target law)');
{
  const c = makeController();
  const rects = c.getActionHitRects();
  check('all five cluster buttons resolve hit rects', rects.length === TOUCH_ACTION_IDS.length);
  check(
    'every hit target ≥ 52 px × 52 px minimum',
    rects.every((r) => r.width >= ACTION_BUTTON_MIN_PX && r.height >= ACTION_BUTTON_MIN_PX),
  );
  check(
    'rect sizes mirror the exported constants (JUMP/ROLL/CONTEXT/utility)',
    rectOf(rects, 'jump').width === JUMP_BUTTON_PX &&
      rectOf(rects, 'roll').width === ROLL_BUTTON_PX &&
      rectOf(rects, 'action').width === CONTEXT_BUTTON_PX &&
      rectOf(rects, 'map').width === UTILITY_BUTTON_PX &&
      rectOf(rects, 'ui').width === UTILITY_BUTTON_PX,
  );
  const a = rectOf(rects, 'action');
  check(
    'smart ACTION sits in the bottom-right thumb zone',
    a.x + a.width > VIEW_W * 0.5 && a.y + a.height > VIEW_H * 0.5,
  );
  const j = centerOf(rectOf(rects, 'jump'));
  const ro = centerOf(rectOf(rects, 'roll'));
  const ac = centerOf(a);
  check('hit-test: JUMP center → jump', c.hitTestActionAt(j.x, j.y) === 'jump');
  check('hit-test: ROLL center → roll', c.hitTestActionAt(ro.x, ro.y) === 'roll');
  check('hit-test: smart center → action', c.hitTestActionAt(ac.x, ac.y) === 'action');
  check('hit-test: open field → null', c.hitTestActionAt(640, 400) === null);

  // Harness override plumbing.
  c.registerActionHitRects([{ id: 'ui', x: 10, y: 10, width: 60, height: 60 }]);
  check('registerActionHitRects override takes precedence', c.hitTestActionAt(40, 40) === 'ui');
  c.registerActionHitRects(null);
  check('null override restores the default layout', c.hitTestActionAt(40, 40) === null);
}

section('1b. hold latches + one-shot tap queue');
{
  const c = makeController();
  const rects = c.getActionHitRects();
  const jc = centerOf(rectOf(rects, 'jump'));

  c.handleTouchStart(tev(1, jc.x, jc.y));
  check('jump press latches while held (peek)', c.peek().jump === true);
  check('jump press reads through poll()', c.poll().jump === true);
  check('jump press never enters the tap queue', c.consumeActions().length === 0);
  c.handleTouchEnd(tev(1, jc.x, jc.y));
  check('jump unlatches on lift (clean re-tap edge for PLSS boost)', c.poll().jump === false);

  const ac = centerOf(rectOf(rects, 'action'));
  c.handleTouchStart(tev(2, ac.x, ac.y));
  const taps1 = c.consumeActions();
  check('smart ACTION press queues exactly one tap', taps1.length === 1 && taps1[0] === 'action');
  check('tap queue drains idempotently', c.consumeActions().length === 0);

  const mc = centerOf(rectOf(rects, 'map'));
  const uc = centerOf(rectOf(rects, 'ui'));
  c.handleTouchStart(tev(3, mc.x, mc.y));
  c.handleTouchStart(tev(4, uc.x, uc.y));
  const taps2 = c.consumeActions();
  check(
    'utility taps queue in press order [map, ui]',
    taps2.length === 2 && taps2[0] === 'map' && taps2[1] === 'ui',
  );

  // reset semantics.
  c.handleTouchStart(tev(5, jc.x, jc.y));
  c.handleTouchStart(tev(6, mc.x, mc.y));
  c.reset();
  check(
    'reset drops holds, claims and pending taps',
    c.peek().jump === false && c.consumeActions().length === 0 && c.isActive() === false,
  );
}

section('1c. touch isolation (buttons never leak into the look trackpad)');
{
  const c = makeController();
  const rects = c.getActionHitRects();
  const ac = centerOf(rectOf(rects, 'action'));

  // The smart button sits deep inside the right look zone (x ≥ 45 vw); a
  // finger there must be claimed by the cluster, and dragging it must not
  // rotate the camera.
  check('smart button center is inside the look zone', c.isInLookZone(ac.x, ac.y));
  c.handleTouchStart(tev(1, ac.x, ac.y));
  c.handleTouchMove(tev(1, ac.x - 140, ac.y - 90));
  const st = c.peek();
  check('cluster finger produces zero look deltas', st.yawDelta === 0 && st.pitchDelta === 0);
  check('cluster finger never claims the movement stick', st.forward === 0 && st.strafe === 0);
  check('cluster finger keeps its hold + queued tap', st.isActive === true);
  c.handleTouchEnd(tev(1, ac.x - 140, ac.y - 90));

  // A second finger on the open look field STILL steers the camera while a
  // button finger is held (multi-touch co-ownership).
  c.handleTouchStart(tev(2, ac.x, ac.y));
  c.handleTouchStart(tev(3, 700, 300));
  c.handleTouchMove(tev(3, 760, 300));
  const multi = c.peek();
  check('open-field look finger works alongside a held button', multi.yawDelta > 0);
  c.handleTouchEnd(tev(2, ac.x, ac.y));
  c.handleTouchEnd(tev(3, 760, 300));
  check(
    'open-field release flick coasts (isActive) with no finger down (pad co-existence law)',
    c.isActive() === true && c.hasFingerDown() === false,
  );
  c.consumeActions();

  // Stick + button simultaneously.
  c.handleTouchStart(tev(4, 300, 500));
  c.handleTouchStart(tev(5, centerOf(rectOf(rects, 'jump')).x, centerOf(rectOf(rects, 'jump')).y));
  c.handleTouchMove(tev(4, 300, 440));
  const both = c.peek();
  check(
    'stick + jump finger coexist (forward > 0 while jump held)',
    both.forward > 0 && both.jump === true,
  );
  c.handleTouchEnd(tev(4, 300, 440));
  c.handleTouchEnd(tev(5, 0, 0));
}

section('1d. visibility law + contextual state + activity callback');
{
  let activity = 0;
  const c = new TouchInputController({
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    visuals: false,
    now: () => clockMs,
    onTouchActivity: () => {
      activity++;
    },
  });
  const rects = c.getActionHitRects();
  const jc = centerOf(rectOf(rects, 'jump'));

  check('deck starts visible', c.isVisible() === true);
  c.setVisible(false);
  check('setVisible(false) hides the deck (gamepad co-existence)', c.isVisible() === false);
  // A tap on the HIDDEN cluster: swallowed — no latch, no tap, but the
  // activity callback still fires so the host can re-illuminate.
  c.handleTouchStart(tev(1, jc.x, jc.y));
  check('hidden-deck tap fires NO hold latch', c.peek().jump === false);
  check('hidden-deck tap queues NO action', c.consumeActions().length === 0);
  check('hidden-deck tap still fires the activity callback', activity === 1);
  c.handleTouchEnd(tev(1, jc.x, jc.y));
  c.setVisible(true);
  c.handleTouchStart(tev(2, jc.x, jc.y));
  check('visible-deck tap latches again', c.peek().jump === true);
  c.handleTouchEnd(tev(2, jc.x, jc.y));
  check('setVisible is idempotent (repeat hide keeps state)', (c.setVisible(false), c.setVisible(false), c.isVisible() === false));
  c.setVisible(true);

  const look0 = activity;
  c.handleTouchStart(tev(3, 700, 300));
  check('open-field touch fires the activity callback too', activity === look0 + 1);
  c.handleTouchEnd(tev(3, 700, 300));

  c.setContextualAction({ label: 'MINE IRON ORE', icon: '⛏', active: true });
  const ctx = c.getContextualAction();
  check(
    'setContextualAction round-trips label/icon/active',
    ctx !== null && ctx.label === 'MINE IRON ORE' && ctx.icon === '⛏' && ctx.active === true,
  );
  c.setContextualAction(null);
  check('null parks the contextual button', c.getContextualAction() === null);
}

// ===========================================================================
// LAYER 2 — ClientApp integration (NullEngine + fake DOM)
// ===========================================================================

// -- minimal fake DOM (the HUD/controller subset only) ----------------------

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
  const el: FakeElement = {
    id: '',
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

async function main(): Promise<void> {
  (globalThis as { document?: unknown }).document = makeFakeDocument();

  const deck = makeController();
  const app = new ClientApp({
    seed: 'spec33-phase3-thumb-deck',
    username: 'thumbpilot',
    faction: 'ARTEMIS',
    network: makeScriptedNetwork(),
    moveIntervalMs: 50,
    silent: true,
    touchInput: deck,
  });
  await app.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));
  check('ClientApp boots with the injected touch deck', app.isInitialized());

  const step = (n: number): void => {
    for (let i = 0; i < n; i++) {
      frameAt += 16;
      app.update(frameAt);
      netNowMs += 16;
    }
  };
  step(2);

  section('2a. tri-state transitions (keyboard → touch → gamepad → touch)');
  {
    check('idle boot source is keyboard', app.getInputSource() === 'keyboard');

    app.handleKeyInput('KeyW', 'down');
    step(1);
    check('held key claims keyboard source', app.getInputSource() === 'keyboard');
    app.handleKeyInput('KeyW', 'up');

    // Look drag on the open right field → touch.
    deck.handleTouchStart(tev(10, 700, 300));
    deck.handleTouchMove(tev(10, 760, 300));
    step(1);
    check('screen drag flips source to touch', app.getInputSource() === 'touch');
    check('deck stays visible under touch', deck.isVisible() === true);
    deck.handleTouchEnd(tev(10, 760, 300));
    step(3);

    // Bluetooth pad press → gamepad source + deck auto-hide.
    const realNav = (globalThis as { navigator?: unknown }).navigator;
    const fakePad = {
      axes: [0, 0, 0, 0, 0, 0],
      buttons: Array.from({ length: 12 }, () => ({ value: 0, pressed: false })),
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { getGamepads: () => [null, fakePad] },
    });
    fakePad.buttons[3]!.pressed = true;
    fakePad.buttons[3]!.value = 1;
    // ≥ 3 render frames: the fixed-timestep accumulator may run one physics
    // step every ~1–2 frames, and the auto-hide lands on the frame AFTER
    // the pad flips the source (pump precedes sampleInput).
    step(4);
    check('pad button flips source to gamepad', app.getInputSource() === 'gamepad');
    check(
      'on-screen controls fade out (.is-gamepad-hidden law)',
      deck.isVisible() === false,
    );
    fakePad.buttons[3]!.pressed = false;
    fakePad.buttons[3]!.value = 0;

    // Touching the screen instantly wins the deck back.
    deck.handleTouchStart(tev(11, 700, 300));
    check(
      'screen touch flips back to touch immediately (pre-pump callback)',
      app.getInputSource() === 'touch',
    );
    check('deck re-illuminates on screen touch', deck.isVisible() === true);
    deck.handleTouchEnd(tev(11, 700, 300));
    step(1);
    (globalThis as { navigator?: unknown }).navigator = realNav;
  }

  section('2b. action button press latches into ClientInputFrame');
  {
    const rects = deck.getActionHitRects();
    const jc = centerOf(rectOf(rects, 'jump'));
    const ro = centerOf(rectOf(rects, 'roll'));

    const ground = app.getSuit().getState().isGrounded;
    deck.handleTouchStart(tev(20, jc.x, jc.y));
    step(2);
    const jumpFrame = app.sampleInput();
    check('held JUMP button lands as jump:true in the input frame', jumpFrame.jump === true);
    check('JUMP is not queued as a discrete tap', deck.consumeActions().length === 0);
    step(4);
    const airborne = app.getSuit().getState();
    check(
      'ground hop fired through the touch frame (left the regolith)',
      ground === true && (airborne.isGrounded === false || (airborne.vz ?? 0) > 0),
      `ground=${ground} vz=${airborne.vz ?? 0}`,
    );
    deck.handleTouchEnd(tev(20, jc.x, jc.y));
    step(1);
    check('JUMP unlatch clears the frame channel', app.sampleInput().jump === false);

    // Mid-air roll: hold JUMP to launch, then press ROLL aloft.
    deck.handleTouchStart(tev(21, jc.x, jc.y));
    step(3);
    deck.handleTouchStart(tev(22, ro.x, ro.y));
    step(2);
    const rollFrame = app.sampleInput();
    check(
      'held ROLL button lands as roll:true in the input frame',
      rollFrame.roll === true,
    );
    deck.handleTouchEnd(tev(22, ro.x, ro.y));
    deck.handleTouchEnd(tev(21, jc.x, jc.y));
    step(8);
  }

  section('2c. proximity-proxied smart ACTION under synthetic touch');
  {
    const rects = deck.getActionHitRects();
    const ac = centerOf(rectOf(rects, 'action'));

    // Park the smart button label on the rover: teleport boots to the buggy.
    const buggyPos = app.getBuggy().getPosition();
    app.getSuit().teleport(buggyPos.x + 1.0, buggyPos.y + 0.5);
    step(2);
    const ctxBoard = deck.getContextualAction();
    check(
      'proximity mirrors the smart label (🚗 BOARD at the rover)',
      ctxBoard !== null && ctxBoard.label === 'BOARD' && ctxBoard.active === true,
      JSON.stringify(ctxBoard),
    );
    check('mode is on foot before the tap', app.getMode() === 'suit');

    deck.handleTouchStart(tev(30, ac.x, ac.y));
    step(1);
    check('smart tap boards the rover (proximity action fired)', app.getMode() === 'buggy');
    deck.handleTouchEnd(tev(30, ac.x, ac.y));
    step(2);

    const ctxDismount = deck.getContextualAction();
    check(
      'driving relabels the smart button DISMOUNT',
      ctxDismount !== null && ctxDismount.label === 'DISMOUNT' && ctxDismount.active === true,
      JSON.stringify(ctxDismount),
    );
    deck.handleTouchStart(tev(31, ac.x, ac.y));
    step(1);
    check('second smart tap dismounts back to suit', app.getMode() === 'suit');
    deck.handleTouchEnd(tev(31, ac.x, ac.y));
    step(1);

    // MAP utility tap toggles the topo overlay.
    const hud = app.getHud();
    const mapWasVisible = hud?.isMapVisible() ?? false;
    const mc = centerOf(rectOf(rects, 'map'));
    deck.handleTouchStart(tev(32, mc.x, mc.y));
    step(1);
    check(
      'MAP utility tap toggles the holographic overlay',
      (hud?.isMapVisible() ?? false) !== mapWasVisible,
    );
    deck.handleTouchEnd(tev(32, mc.x, mc.y));
    step(1);

    // UI utility tap cycles the HUD mode.
    const modeBefore = hud?.getHUDMode?.() ?? null;
    const uc = centerOf(rectOf(rects, 'ui'));
    deck.handleTouchStart(tev(33, uc.x, uc.y));
    step(1);
    check(
      'UI utility tap cycles the HUD visibility mode',
      (hud?.getHUDMode?.() ?? null) !== modeBefore,
    );
    deck.handleTouchEnd(tev(33, uc.x, uc.y));
    step(1);
    deck.consumeActions();
  }

  section('2d. HUD re-glyphs to tactile [👆 TAP …] prompts in touch mode');
  {
    const hud = app.getHud();
    assert.ok(hud !== null);
    // Make touch the live device and force a prompt-carrying frame.
    const deck2 = deck;
    deck2.handleTouchStart(tev(40, 700, 300));
    deck2.handleTouchMove(tev(40, 705, 300));
    step(1);
    deck2.handleTouchEnd(tev(40, 705, 300));
    check('HUD input source followed to touch', hud.getInputSource() === 'touch');

    // Walk back to the rover so a prompt is guaranteed live.
    const buggyPos = app.getBuggy().getPosition();
    app.getSuit().teleport(buggyPos.x + 1.0, buggyPos.y + 0.5);
    step(2);

    const slot = (globalThis as {
      document: { getElementById(id: string): { text(): string } | null };
    }).document.getElementById('lunar-hud-prompt');
    check('prompt slot exists in the fake DOM', slot !== null);
    const text = slot?.text() ?? '';
    check(
      'prompt re-glyphs to the tactile badge [👆] TAP …',
      text.includes('\u{1F446}') && text.includes('TAP'),
      `slot text = "${text}"`,
    );
  }

  app.dispose();
  check('dispose tears the integration app down cleanly', true);

  console.log(`\n${'='.repeat(58)}`);
  if (failures.length > 0) {
    console.error(`💥 smoke-touch-actions-phase3: ${failures.length} FAILURE(S):`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log(`🎉 smoke-touch-actions-phase3: ALL ${passed} CHECKS GREEN`);
}

void main().catch((err: unknown) => {
  console.error('💥 smoke-touch-actions-phase3 crashed:', err);
  delete (globalThis as { document?: unknown }).document;
  process.exit(1);
});
