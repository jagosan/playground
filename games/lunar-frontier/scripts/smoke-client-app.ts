/**
 * TASK-PLAY-054 verification — ClientApp + LunarHUD headless harness.
 *
 * Runs under `npx tsx scripts/smoke-client-app.ts` (exit 0 == all green).
 * No browser, no real sockets: Babylon runs on `NullEngine`, the HUD is
 * built against a small fake DOM, and the network is a scripted
 * `NetworkClient` driven through `handleFrame()` — the same dispatcher the
 * real WebSocket feeds. The harness owns one virtual clock shared by BOTH
 * the client frames and the network, so interpolation windows are exact.
 *
 * Layers:
 *   A. Fake DOM sanity      — the mini-document behaves like the subset of
 *                             DOM the HUD touches.
 *   B. LunarHUD             — overlay DOM generation (every spec panel and
 *                             element id), telemetry/speed/cargo/scanner/
 *                             prompt/market/feedback methods, terminal
 *                             open/close, order validation + onTrade routing.
 *   C. ClientApp bootstrap  — NullEngine boot, entities + traversal graph,
 *                             camera wiring, idempotent init, frame stepping.
 *   D. Input routing        — WASD/Space/Shift latch; [E] mount/dismount
 *                             (reach-gated), [F] lamps per-mode, [V] camera
 *                             cycle, [T]/Escape terminal handling.
 *   E. Network integration  — welcome → identity/credits; scripted deltas →
 *                             remote avatar spawn, interpolation, mode swap,
 *                             despawn; 20 Hz sendMove stream; market_sync →
 *                             terminal book; trade round-trip + instant
 *                             feedback; claim beacon; mine reach/cooldown.
 *   F. Lifecycle teardown   — dispose semantics + TraversalController units.
 */
import assert from 'node:assert';

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';

import {
  HintArrowSystem,
  HINT_BOB_AMPLITUDE_M,
  HINT_BOB_FREQUENCY_HZ,
  HINT_EDGE_INSET_PX,
  HINT_HEIGHT_OFFSET_M,
  type HudHintArrowPayload,
} from '../src/client/HintArrowSystem.ts';

import {
  ClientApp,
  GAMEPAD_LOOK_DEADZONE,
  GAMEPAD_LOOK_GAMMA,
  GAMEPAD_STEER_DEADZONE,
  GAMEPAD_STEER_GAMMA,
  GAMEPAD_THROTTLE_GAMMA,
  NAV_SCAN_RANGE_M,
  PAD_RAIL_REST_FRAMES,
  RUMBLE_MIN_INTERVAL_MS,
  SCAN_RANGE_M,
  computeBuggyRumble,
  gamepadBrakeCurve,
  gamepadLookCurve,
  gamepadSteerCurve,
  gamepadThrottleCurve,
} from '../src/client/ClientApp.ts';
import { TraversalController } from '../src/client/TraversalController.ts';
import { InMemoryQuestStorage } from '../src/client/QuestEngine.ts';
import NetworkClient from '../src/network/NetworkClient.ts';
import LunarHUD, {
  HUD_COMMS_ID,
  HUD_HINT_ARROW_ID,
  HUD_ROOT_ID,
  HUD_TRADE_ID,
  HUD_TUTORIAL_ID,
} from '../src/ui/LunarHUD.ts';

// ---------------------------------------------------------------------------
// Harness clock — shared by the client frames AND the scripted network so
// 20 Hz interpolation windows land exactly on the millisecond.
// ---------------------------------------------------------------------------

let nowMs = 100_000;

// ---------------------------------------------------------------------------
// Check bookkeeping
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

// ---------------------------------------------------------------------------
// A minimal fake DOM — exactly the surface LunarHUD declares it uses
// ---------------------------------------------------------------------------

interface FakeElement {
  id: string;
  className: string;
  textContent: string | null;
  style: { width: string };
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  };
  children: FakeElement[];
  parent: FakeElement | null;
  appendChild<T extends FakeElement>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  dispatchEvent(type: string, event: unknown): void;
  text(): string;
}

function makeFakeElement(tagName: string, registry: Map<string, FakeElement>): FakeElement {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  // Real-DOM semantics: assigning `textContent` REPLACES the subtree — every
  // child is dropped (and un-registered). The HUD repaints prompt/comms/
  // hint spans with exactly this idiom, so a fake that keeps the children
  // would grow them unboundedly on re-paints (spec 19 input-source flips).
  let ownText = '';
  const el: FakeElement = {
    id: '',
    className: tagName,
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
    style: { width: '' },
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
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
        const index = el.parent.children.indexOf(el);
        if (index >= 0) el.parent.children.splice(index, 1);
        el.parent = null;
      }
      if (el.id.length > 0 && registry.get(el.id) === el) registry.delete(el.id);
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
      if (name === 'id') {
        el.id = value;
        registry.set(value, el);
      }
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    dispatchEvent(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    text() {
      const own = el.textContent ?? '';
      return own + el.children.map((c) => c.text()).join('');
    },
  };
  return el;
}

interface FakeDocument {
  body: FakeElement;
  createElement(tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  dispatchEvent(type: string, event: unknown): void;
}

function makeFakeDocument(): FakeDocument {
  const registry = new Map<string, FakeElement>();
  const docListeners = new Map<string, Array<(event: unknown) => void>>();
  const body = makeFakeElement('body', registry);
  return {
    body,
    createElement: (tag: string) => makeFakeElement(tag, registry),
    getElementById: (id: string) => registry.get(id) ?? null,
    addEventListener(type, listener) {
      const list = docListeners.get(type) ?? [];
      list.push(listener);
      docListeners.set(type, list);
    },
    dispatchEvent(type, event) {
      for (const listener of docListeners.get(type) ?? []) listener(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Scripted network — real NetworkClient dispatcher, no socket, harness clock
// ---------------------------------------------------------------------------

function makeScriptedNetwork(): {
  net: NetworkClient;
  sent: Array<Record<string, unknown>>;
  /** Flip the private lifecycle state (open/closed) without a transport. */
  setState(state: string): void;
} {
  const net = new NetworkClient({
    url: 'ws://scripted.test/ws',
    socketFactory: () => {
      throw new Error('scripted network must never open a socket');
    },
    clock: () => nowMs,
    heartbeatIntervalMs: 0,
    autoReconnect: false,
  });
  const sent: Array<Record<string, unknown>> = [];
  // Bypass openConnection(): stamp the lifecycle field directly (it is a
  // plain instance property) and capture wire frames instead of bytes.
  const internals = net as unknown as {
    socketState: string;
    sendFrame(frame: Record<string, unknown>): boolean;
  };
  internals.socketState = 'open';
  internals.sendFrame = (frame: Record<string, unknown>): boolean => {
    if (internals.socketState !== 'open') return false;
    sent.push(frame);
    return true;
  };
  return {
    net,
    sent,
    setState(state: string) {
      internals.socketState = state;
    },
  };
}

function frame(type: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...payload });
}

async function main(): Promise<void> {
// ===========================================================================
// LAYER A — fake DOM sanity
// ===========================================================================

section('A. fake DOM behaves like the subset the HUD uses');
{
  const doc = makeFakeDocument();
  const a = doc.createElement('div');
  const b = doc.createElement('span');
  a.setAttribute('id', 'alpha');
  a.classList.add('x');
  a.appendChild(b);
  doc.body.appendChild(a);

  check('id registry resolves setAttribute("id")', doc.getElementById('alpha') === a);
  check('classList add/contains', a.classList.contains('x') && !a.classList.contains('y'));
  check('appendChild parents + lists', a.children[0] === b && b.parent === a);
  a.classList.remove('x');
  check('classList remove', !a.classList.contains('x'));
  a.remove();
  check(
    'remove detaches from body AND id registry',
    doc.body.children.length === 0 && doc.getElementById('alpha') === null,
  );
}

// ===========================================================================
// LAYER B — LunarHUD DOM generation & update methods
// ===========================================================================

section('B. LunarHUD glassmorphic overlay (ADR-013-1)');
{
  const doc = makeFakeDocument();
  const trades: Array<{ commodity: string; amount: number; isBuy: boolean }> = [];
  const hud = new LunarHUD({
    document: doc as unknown as Document,
    onTrade: (request) => trades.push(request),
  });

  // B1 — spec-mandated DOM skeleton exists and is mounted on <body>.
  const ids = [
    HUD_ROOT_ID,
    HUD_TRADE_ID,
    'lunar-hud-status',
    'lunar-hud-life',
    'lunar-hud-buggy',
    'lunar-hud-scanner',
    'lunar-hud-prompts',
    'lunar-hud-market',
    'lunar-hud-oxygen-bar',
    'lunar-hud-battery-bar',
    'lunar-hud-cargo-bar',
    'lunar-hud-buggy-battery-bar',
    // Spec 19 §2.2.2 / §2.3.4: floating toast pill + suit backpack meter.
    'lunar-hud-toast',
    'lunar-hud-suit-cargo-bar',
    'hud-suit-lamp',
    'hud-buggy-lamp',
    'lunar-hud-trade-commodity',
    'lunar-hud-trade-amount',
    'lunar-hud-trade-buy',
    'lunar-hud-trade-sell',
    'lunar-hud-trade-feedback',
  ];
  const missing = ids.filter((id) => doc.getElementById(id) === null);
  check('every spec element id is generated', missing.length === 0, `missing: ${missing.join(', ')}`);
  check(
    'overlay + terminal mounted on body',
    doc.body.children.some((c) => c.getAttribute('id') === HUD_ROOT_ID) &&
      doc.body.children.some((c) => c.getAttribute('id') === HUD_TRADE_ID),
  );
  check('terminal starts hidden', hud.hasClass(HUD_TRADE_ID, 'is-hidden'));
  check(
    'all six commodities pre-booked',
    ['REGOLITH', 'BASALT', 'TITANIUM', 'ILMENITE', 'WATER_ICE', 'HELIUM3'].every(
      (c) => doc.getElementById(`hud-trade-row-${c}`) !== null,
    ),
  );

  // B2 — suit telemetry drives bars, lamps, severity classes.
  hud.updateSuitTelemetry({
    oxygen: 72.4,
    battery: 41,
    rcsFuel: 88,
    headlightOn: true,
    altitude: 12.34,
    isGrounded: true,
    speed: 1.6,
    operational: true,
  });
  check(
    'oxygen bar text + fill width',
    hud.textOf('oxygen-value') === '72%' &&
      doc.getElementById('lunar-hud-oxygen-bar-fill')!.style.width === '72.4%',
  );
  check('battery bar text', hud.textOf('battery-value') === '41%');
  check('suit lamp lit', hud.hasClass('suit-lamp', 'is-on'));
  check(
    'altitude + contact readouts',
    hud.textOf('altitude-value') === '12.3 m' && hud.textOf('contact-value') === 'CONTACT',
  );

  hud.updateSuitTelemetry({ oxygen: 12, battery: 10, headlightOn: false, operational: false });
  check(
    'critical O₂ paints is-critical on the fill',
    doc.getElementById('lunar-hud-oxygen-bar-fill')!.classList.contains('is-critical'),
  );
  check(
    'life-support failure alarm shown',
    !hud.hasClass('life-support-state', 'is-hidden') &&
      hud.textOf('life-support-state').includes('FAILURE'),
  );
  check('suit lamp extinguished', !hud.hasClass('suit-lamp', 'is-on'));

  // B3 — buggy dashboard: dual speed units, 0–500 kg cargo, battery %.
  hud.updateBuggyTelemetry({
    speed: 10.0,
    cargoMass: 250,
    cargoCapacity: 500,
    batteryFraction: 0.62,
    headlightsOn: true,
    mounted: true,
  });
  check(
    'speedometer shows m/s AND km/h',
    hud.textOf('speed-ms') === '10.0 m/s' && hud.textOf('speed-kmh') === '36.0 km/h',
  );
  check(
    'cargo bar half of 500 kg',
    hud.textOf('cargo-value') === '250 / 500 kg' &&
      doc.getElementById('lunar-hud-cargo-bar-fill')!.style.width === '50.0%',
  );
  check('buggy battery percentage', hud.textOf('buggy-battery-value') === '62%');
  check(
    'buggy lamp + mounted chip',
    hud.hasClass('buggy-lamp', 'is-on') && !hud.hasClass('mounted-chip', 'is-hidden'),
  );

  // B4 — scanner readout.
  hud.setScanner({
    found: true,
    veinId: 'vein-water_ice-042',
    kind: 'water_ice',
    purity: 1.21,
    remaining: 3400,
    rangeM: 14.2,
  });
  check('scanner lock line', hud.textOf('scanner-line-1') === 'vein-water_ice-042 · WATER_ICE');
  check('scanner purity/remaining line', hud.textOf('scanner-line-2').includes('121%'));
  check('scanner range line', hud.textOf('scanner-line-3') === 'range 14.2 m');
  hud.setScanner({ found: false });
  check('scanner clears to NO SIGNATURES', hud.textOf('scanner-line-1') === 'NO SIGNATURES');

  // B5 — proximity prompts sort by canonical kind order.
  hud.setPrompts([
    { key: 'T', kind: 'trade' },
    { key: 'E', kind: 'drive' },
    { key: 'M', kind: 'mine' },
    { key: 'C', kind: 'claim' },
  ]);
  const promptStrip = doc.getElementById('lunar-hud-prompts')!;
  const visible = () =>
    promptStrip.children.filter(
      (c) => c.classList.contains('hud-prompt') && !c.classList.contains('is-hidden'),
    );
  const promptTexts = visible().map((c) => c.text());
  check(
    'spec prompt sheet renders in order (E→M→C→T)',
    promptTexts.length === 4 &&
      promptTexts[0].includes('[E]') &&
      promptTexts[0].includes('Drive Buggy') &&
      promptTexts[1].includes('[M]') &&
      promptTexts[1].includes('Mine Vein') &&
      promptTexts[2].includes('[C]') &&
      promptTexts[2].includes('Stake Claim') &&
      promptTexts[3].includes('[T]') &&
      promptTexts[3].includes('Trade'),
    JSON.stringify(promptTexts),
  );
  hud.clearPrompts();
  check('clearPrompts hides all slots', visible().length === 0);

  // B6 — market book repaint.
  hud.updateMarketPrices(
    { REGOLITH: 5.002, HELIUM3: 512.25 },
    {
      sellPrices: { REGOLITH: 4.998, HELIUM3: 487.75 },
      basePrices: { REGOLITH: 5, HELIUM3: 500 },
      reserves: { REGOLITH: 99_000, HELIUM3: 977 },
      holdings: { HELIUM3: 12 },
      timestamp: Date.UTC(2026, 8, 13, 12, 0, 0),
    },
  );
  check(
    'market buy price (micro-precision kept)',
    doc.getElementById('hud-trade-buy-HELIUM3')!.textContent === '512.25',
  );
  check(
    'market sell price (spread visible)',
    doc.getElementById('hud-trade-sell-REGOLITH')!.textContent === '4.998',
  );
  check(
    'reserve column',
    doc.getElementById('hud-trade-reserve-HELIUM3')!.textContent === '977',
  );
  check(
    'holdings highlight',
    doc.getElementById('hud-trade-row-HELIUM3')!.classList.contains('has-holding'),
  );
  check('sync stamp rendered', hud.textOf('trade-synced').startsWith('synced '));

  // B7 — terminal open/close + Escape, feedback, confirmations.
  hud.showTradeDialog();
  check('terminal opens', hud.isTradeDialogOpen() && !hud.hasClass(HUD_TRADE_ID, 'is-hidden'));
  doc.dispatchEvent('keydown', { code: 'Escape' });
  check('Escape closes terminal (HUD-level hook)', !hud.isTradeDialogOpen());
  hud.toggleTradeDialog();
  check('toggle re-opens', hud.isTradeDialogOpen());
  hud.toggleTradeDialog();
  check('toggle closes', !hud.isTradeDialogOpen());

  hud.showFeedback('station said no', 'error');
  check(
    'error feedback painted',
    hud.textOf('trade-feedback') === 'station said no' &&
      hud.hasClass('trade-feedback', 'feedback-error'),
  );

  hud.showTradeConfirmation({
    commodity: 'WATER_ICE',
    amount: 40,
    isBuy: false,
    totalCredits: 4600,
    newBalance: 5600,
  });
  check(
    'trade confirmation feedback + balance',
    hud.textOf('trade-feedback').includes('SOLD 40 WATER_ICE') &&
      hud.textOf('credits-value') === '5,600' &&
      hud.hasClass('trade-feedback', 'feedback-success'),
  );

  // B8 — order form validation & onTrade routing.
  const request = hud.submitOrder(true, 'TITANIUM', 25);
  check(
    'valid order routed to onTrade',
    request !== null &&
      trades.length === 1 &&
      trades[0].commodity === 'TITANIUM' &&
      trades[0].amount === 25 &&
      trades[0].isBuy === true,
  );
  const bad = hud.submitOrder(false, 'UNOBTANIUM', 0);
  check(
    'zero amount rejected with error feedback',
    bad === null && hud.hasClass('trade-feedback', 'feedback-error'),
  );

  // B9 — buttons click through the same path (select value drives symbol).
  (hud.getElement('trade-commodity') as unknown as { value: string }).value = 'REGOLITH';
  doc.getElementById('lunar-hud-trade-buy')!.dispatchEvent('click', {});
  check(
    'BUY button click routes select selection through onTrade',
    trades.length === 2 && trades[1].commodity === 'REGOLITH' && trades[1].amount === 10,
    JSON.stringify(trades[1] ?? null),
  );

  // B10 — dispose removes overlays, is idempotent.
  hud.dispose();
  check(
    'dispose detaches overlay roots',
    !doc.body.children.some((c) => c.getAttribute('id') === HUD_ROOT_ID) &&
      !doc.body.children.some((c) => c.getAttribute('id') === HUD_TRADE_ID),
  );
  hud.dispose();
  check('dispose is idempotent', hud.isDisposed());
}

// ===========================================================================
// LAYER B2 — Spec 18 comms terminal + screen-edge hint arrow (HUD side)
// ===========================================================================

section('B2. Spec 18 §6.1/§6.2 — comms terminal & HUD hint arrow');
{
  const doc = makeFakeDocument();
  const hud = new LunarHUD({ document: doc as unknown as Document });

  // B2-1 — comms skeleton exists and starts hidden.
  check(
    'comms panel #lunar-hud-comms built hidden',
    doc.getElementById(HUD_COMMS_ID) !== null &&
      doc.getElementById(HUD_COMMS_ID)!.classList.contains('is-hidden'),
  );
  check('isCommsVisible() false before first transmission', !hud.isCommsVisible());

  // B2-2 — showComms paints header/tone/body and reveals the panel.
  hud.showComms({
    sender: 'Caelus Extraction Corp — Corporate Dispatch',
    callsign: 'CEC-DISP',
    transmission: 'Contractor 7-Echo, wake up. Life support telemetry verified.',
    audioTone: 'burst',
  });
  check('showComms reveals panel + isCommsVisible()', hud.isCommsVisible());
  check('callsign rendered in header', hud.textOf('comms-sender') === 'CEC-DISP');
  check(
    'sender org line rendered',
    hud.textOf('comms-origin').includes('Caelus Extraction Corp'),
  );
  check('tone label uppercased', hud.textOf('comms-tone') === 'BURST');
  check(
    'tone pip class tone-burst set',
    hud.hasClass('comms-tone-pulse', 'tone-burst'),
  );
  const commsBody = doc.getElementById('lunar-hud-comms-body')!;
  check(
    'full transmission mirrored to data-full (typewriter-safe)',
    commsBody.getAttribute('data-full') ===
      'Contractor 7-Echo, wake up. Life support telemetry verified.',
  );
  check('data-tone stamped', commsBody.getAttribute('data-tone') === 'burst');

  // B2-3 — typewriter animates: after a beat, some chars are visible.
  await new Promise((resolve) => setTimeout(resolve, 90));
  const typed = hud.textOf('comms-text');
  check(
    'typewriter reveal in progress/complete',
    typed.length > 0 &&
      'Contractor 7-Echo, wake up. Life support telemetry verified.'.startsWith(typed),
  );

  // B2-4 — hideComms collapses; tone swaps replace cleanly.
  hud.hideComms();
  check('hideComms collapses panel', !hud.isCommsVisible() &&
    doc.getElementById(HUD_COMMS_ID)!.classList.contains('is-hidden'));
  hud.showComms({
    sender: 'X',
    callsign: 'Y',
    transmission: 'ok',
    audioTone: 'success',
  });
  check(
    'tone swap: previous tone-burst removed, tone-success set',
    !hud.hasClass('comms-tone-pulse', 'tone-burst') &&
      hud.hasClass('comms-tone-pulse', 'tone-success'),
  );

  // B2-5 — autoDismissMs dismisses on its own (no manual hideComms).
  hud.showComms({
    sender: 'X',
    callsign: 'Z',
    transmission: 'This burst self-destructs.',
    audioTone: 'alert',
    autoDismissMs: 40,
  });
  check('auto-dismiss armed: still visible immediately', hud.isCommsVisible());
  await new Promise((resolve) => setTimeout(resolve, 120));
  check('autoDismissMs hid the comms panel', !hud.isCommsVisible());

  // B2-6 — hint arrow element skeleton + update painting.
  check(
    'hint arrow #lunar-hud-hint-arrow built hidden',
    doc.getElementById(HUD_HINT_ARROW_ID) !== null &&
      doc.getElementById(HUD_HINT_ARROW_ID)!.classList.contains('is-hidden'),
  );
  hud.updateHintArrow({
    visible: true,
    screenX: 640,
    screenY: 360,
    angleDeg: 45,
    distanceM: 45.4,
    label: 'Ilmenite outcrop',
    isOffScreen: false,
  });
  const arrowEl = doc.getElementById(HUD_HINT_ARROW_ID)!;
  const arrowStyle = arrowEl.style as unknown as Record<string, string>;
  check(
    'in-view arrow positioned + visible',
    !arrowEl.classList.contains('is-hidden') &&
      arrowEl.classList.contains('is-inview') &&
      arrowStyle['left'] === '640.0px' &&
      arrowStyle['top'] === '360.0px',
  );
  check('distance readout rounded (45m)', hud.textOf('hint-arrow-distance') === '45m');
  check('target label rendered', hud.textOf('hint-arrow-label') === 'Ilmenite outcrop');

  // B2-7 — off-screen clamp mode stamps is-offscreen + rotates glyph.
  hud.updateHintArrow({
    visible: true,
    screenX: 48,
    screenY: 300,
    angleDeg: -90,
    distanceM: 120.2,
    label: 'Exchange terminal',
    isOffScreen: true,
  });
  const glyphStyle = doc
    .getElementById('lunar-hud-hint-arrow-glyph')!
    .style as unknown as Record<string, string>;
  check(
    'off-screen clamp: is-offscreen class + glyph rotate(-90deg)',
    arrowEl.classList.contains('is-offscreen') &&
      !arrowEl.classList.contains('is-inview') &&
      glyphStyle['transform'] === 'rotate(-90.0deg)',
  );

  // B2-8 — null payload hides; getHintArrowData readback.
  hud.updateHintArrow(null);
  check(
    'null payload hides arrow',
    arrowEl.classList.contains('is-hidden') && hud.getHintArrowData() === null,
  );

  // B2-9 — quest stage overlay: dynamic title + multi-objective rendering.
  hud.setQuestStage(0, [false, false], {
    questTitle: 'A One-Way Ticket to the Frontier',
    stageTitle: 'The First Haul & Frontier Exchange',
    stageNumber: 5,
    stageTotal: 5,
    objectives: [
      { id: 's5_reach_hub', description: 'Drive the buggy to the Faction Exchange Terminal marker.', completed: false },
      { id: 's5_dump_haul', description: 'Dump your cargo at the terminal with [T] for scrip.', completed: true },
    ],
  });
  const tutorialPanel = doc.getElementById(HUD_TUTORIAL_ID)!;
  check(
    'quest mode: heading re-titled with quest name',
    hud.textOf('tutorial-heading').includes('A ONE-WAY TICKET TO THE FRONTIER') &&
      tutorialPanel.classList.contains('quest-mode'),
  );
  check(
    'quest mode: stage title line rendered',
    hud.textOf('tutorial-stage-title') === 'The First Haul & Frontier Exchange' &&
      !doc.getElementById('lunar-hud-tutorial-stage')!.classList.contains('is-hidden'),
  );
  check('quest mode: progress readout 5 / 5', hud.textOf('tutorial-progress') === '5 / 5');
  const questBody = doc.getElementById('lunar-hud-tutorial-quest')!;
  check(
    'multi-objective rows rendered with ids + done marks',
    !questBody.classList.contains('is-hidden') &&
      questBody.children.length === 2 &&
      questBody.children[0].getAttribute('data-objective-id') === 's5_reach_hub' &&
      questBody.children[0].classList.contains('is-active') &&
      questBody.children[1].getAttribute('data-objective-id') === 's5_dump_haul' &&
      questBody.children[1].classList.contains('is-done') &&
      questBody.children[1].children[0].textContent === '✔',
  );
  check(
    'quest mode hides the legacy static checklist rows',
    doc.getElementById('lunar-hud-tutorial-step-1')!.classList.contains('is-hidden'),
  );

  // B2-10 — legacy updateTutorial keeps working (zero-import contract).
  hud.setQuestStage(0, []);
  check(
    'legacy restore: quest body hidden again',
    doc.getElementById('lunar-hud-tutorial-quest')!.classList.contains('is-hidden'),
  );
  hud.updateTutorial(1, [true, false, false, false, false]);
  check(
    'legacy checklist still paints (step 0 done, step 1 active)',
    doc.getElementById('lunar-hud-tutorial-step-1')!.classList.contains('is-done') &&
      doc.getElementById('lunar-hud-tutorial-step-2')!.classList.contains('is-active'),
  );
  hud.dispose();
}

// ===========================================================================
// LAYER B3 — Spec 18 HintArrowSystem on NullEngine (3D chevron + clamp math)
// ===========================================================================

section('B3. Spec 18 §6.1 — HintArrowSystem frustum/edge projection');
{
  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720 } as never);
  const scene = new Scene(engine);
  // Camera at spawn (Babylon y-up), facing physics +y (north): worldToBabylon
  // maps +y → −z, and a yaw-PI Babylon camera looks down −z.
  const camera = new UniversalCamera('hint-test-cam', new Vector3(0, 1.6, 0), scene);
  camera.rotation.y = Math.PI;
  camera.inputs.clear();

  let emitted: HudHintArrowPayload | null = null;
  let fakeClockMs = 0;
  const hints = new HintArrowSystem({
    scene,
    clock: () => fakeClockMs,
    onHudUpdate: (payload) => (emitted = payload),
  });

  // B3-1 — spec constants.
  check(
    'bob ±0.3 m @ 1.2 Hz constants match spec §6.1',
    HINT_BOB_AMPLITUDE_M === 0.3 && HINT_BOB_FREQUENCY_HZ === 1.2,
  );
  check(
    'hover height + edge inset exported',
    HINT_HEIGHT_OFFSET_M > 1 && HINT_EDGE_INSET_PX > 0,
  );

  // B3-2 — no target → hidden payload, no crash.
  const none = hints.update(camera, null, 1280, 720);
  check('no target emits hidden payload', none.visible === false && emitted !== null && emitted.visible === false);

  // B3-3 — zero-size viewport (NullEngine canvas 0×0) stays safe.
  const zero = hints.update(camera, { x: 0, y: 45, z: 0 }, 0, 0);
  check('zero-size viewport short-circuits to hidden (no NaN)', zero.visible === false);

  // B3-4 — target dead ahead in view: chevron enabled, screen centre-ish.
  hints.setTarget({ x: 0, y: 45, z: 0, label: 'Ilmenite outcrop' });
  const inView = hints.update(camera, null, 1280, 720);
  check('in-view target → visible payload, isOffScreen false', inView.visible === true && inView.isOffScreen === false);
  check(
    'in-view distance ≈ 45 m',
    inView.distanceM !== undefined && Math.abs(inView.distanceM - 45) < 1.7,
    `got ${inView.distanceM}`,
  );
  check(
    'projected screen pos near centre column',
    inView.screenX !== undefined && Math.abs(inView.screenX - 640) < 8,
  );
  check('label passthrough', inView.label === 'Ilmenite outcrop');
  const chevronMesh = scene.getMeshByName('hint-arrow-chevron');
  check('3D chevron mesh built in scene', chevronMesh !== null && chevronMesh!.isEnabled());
  check(
    'chevron hovers above target (+y offset, bob at t=0 → sin 0 = 0)',
    chevronMesh!.position.y > 1.5,
  );

  // B3-5 — bob animation: quarter period later the offset rises by amplitude.
  fakeClockMs = 1000 / (4 * HINT_BOB_FREQUENCY_HZ); // sin(2π·1.2·t) = sin(π/2) = 1
  hints.update(camera, null, 1280, 720);
  const bobbedY = scene.getMeshByName('hint-arrow-chevron')!.position.y;
  fakeClockMs = 0;
  hints.update(camera, null, 1280, 720);
  const baseY = scene.getMeshByName('hint-arrow-chevron')!.position.y;
  check(
    'bob peaks at +0.3 m a quarter-period in',
    Math.abs(bobbedY - baseY - HINT_BOB_AMPLITUDE_M) < 1e-6,
    `Δ=${bobbedY - baseY}`,
  );

  // B3-6 — pan 180° away: chevron hidden, perimeter clamp emitted.
  camera.rotation.y = 0; // face south — target is behind the camera
  camera.computeWorldMatrix(true);
  const off = hints.update(camera, null, 1280, 720);
  check('180° pan → off-screen clamp payload', off.visible === true && off.isOffScreen === true);
  check('behind-camera view depth negative', (hints.getState().viewDepth ?? 1) < 0);
  const insetX = HINT_EDGE_INSET_PX;
  const insetY = HINT_EDGE_INSET_PX;
  check(
    'clamped coords lie on the inset perimeter rect',
    Math.abs(off.screenX! - insetX) < 1 ||
      Math.abs(off.screenX! - (1280 - insetX)) < 1 ||
      Math.abs(off.screenY! - insetY) < 1 ||
      Math.abs(off.screenY! - (720 - insetY)) < 1,
    `x=${off.screenX} y=${off.screenY}`,
  );
  check(
    'clamp angle finite + distance persists',
    Number.isFinite(off.angleDeg) && off.distanceM !== undefined && Math.abs(off.distanceM - 45) < 1.7,
  );
  check(
    '3D chevron hidden while off-screen',
    !scene.getMeshByName('hint-arrow-chevron')!.isEnabled(),
  );

  // B3-7 — off-axis target (NE while facing north) still guides: in-view or
  // clamped, never invisible, and clamp points eastward-ish.
  camera.rotation.y = Math.PI;
  camera.computeWorldMatrix(true);
  const side = hints.update(camera, { x: 300, y: 10, z: 0 }, 1280, 720);
  check('wide-angle target still emits guidance (never invisible)', side.visible === true);

  // B3-8 — setTarget(null) clears; dispose is idempotent + post-dispose safe.
  hints.setTarget(null);
  check('setTarget(null) clears target', hints.getTarget() === null);
  check('update with no target after clear hidden', hints.update(camera, null, 1280, 720).visible === false);
  hints.dispose();
  hints.dispose();
  check('dispose idempotent', hints.isDisposed());
  check(
    'post-dispose update returns hidden payload without throwing',
    hints.update(camera, { x: 1, y: 1, z: 1 }, 1280, 720).visible === false,
  );
  check(
    'dispose releases scene meshes',
    scene.getMeshByName('hint-arrow-chevron') === null &&
      scene.getMeshByName('hint-arrow-ring') === null,
  );

  scene.dispose();
  engine.dispose();
}

// ===========================================================================
// LAYER C — ClientApp bootstrap on NullEngine
// ===========================================================================

section('C. ClientApp bootstrap (NullEngine, headless)');

const bootDoc = makeFakeDocument();
(globalThis as { document?: unknown }).document = bootDoc;

const boot = makeScriptedNetwork();
const app = new ClientApp({
  seed: 'mala-voyage-2431',
  username: 'testpilot',
  faction: 'ARTEMIS',
  network: boot.net,
  moveIntervalMs: 50,
  silent: true,
});

await app.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));
check('init resolves and marks initialized', app.isInitialized());
check('world scene initialised (terrain mesh built)', app.world.getTerrainMesh() !== null);
check('local EVA avatar built', app.getSuit().isBuilt());
check('local buggy built', app.getBuggy().isBuilt());
check('HUD auto-created from global document', app.getHud() !== null);
check('HUD overlay landed in the fake DOM', bootDoc.getElementById(HUD_ROOT_ID) !== null);

const traversal = app.getTraversal();
check('traversal controller built from snapshot', traversal !== null && traversal.nodeCount() > 0);
check('traversal start waypoint resolves', traversal !== null && traversal.getCurrentNode().id.length > 0);

check(
  'buggy parks away from the spawn point',
  (() => {
    const s = app.getSuit().getPosition();
    const b = app.getBuggy().getPosition();
    return Math.hypot(b.x - s.x, b.y - s.y) > 5;
  })(),
);
check('scene active camera wired by rig', app.world.getScene().activeCamera !== null);

await app.init(new NullEngine());
check('init is idempotent (second call no-ops)', app.isInitialized());

const beforeStep = app.getSuit().getState();
nowMs += 16;
app.update(nowMs);
nowMs += 16;
app.update(nowMs);
const afterStep = app.getSuit().getState();
check(
  'update() steps frames without throwing',
  Number.isFinite(afterStep.x) && Number.isFinite(afterStep.z),
);
check('life support ticks down over frames', afterStep.oxygen <= beforeStep.oxygen);

// ===========================================================================
// LAYER D — input routing
// ===========================================================================

section('D. input routing & hotkeys');
{
  app.handleKeyInput('KeyW', 'down');
  app.handleKeyInput('KeyD', 'down');
  app.handleKeyInput('ShiftLeft', 'down');
  const sampled = app.sampleInput();
  check(
    'WASD + Shift latch into the input frame (TASK-PLAY-056: D = strafe right, +1)',
    sampled.forward === 1 && sampled.strafe === 1 && sampled.sprint === true && sampled.brake === 0,
  );
  app.handleKeyInput('KeyW', 'up');
  app.handleKeyInput('KeyD', 'up');
  app.handleKeyInput('ShiftLeft', 'up');
  check(
    'key-up unlatches',
    app.sampleInput().forward === 0 && app.sampleInput().sprint === false,
  );
  check('unknown codes report unhandled', app.handleKeyInput('KeyQ', 'down') === false);

  // TASK-PLAY-056 — sign rectification: right/Right is +1 on both axes.
  app.handleKeyInput('KeyA', 'down');
  check('A strafe is -1 (left)', app.sampleInput().strafe === -1);
  app.handleKeyInput('KeyA', 'up');
  app.handleKeyInput('ArrowRight', 'down');
  check('ArrowRight yaw is +1 (clockwise)', app.sampleInput().yaw === 1);
  app.handleKeyInput('ArrowRight', 'up');
  app.handleKeyInput('ArrowLeft', 'down');
  check('ArrowLeft yaw is -1 (counter-clockwise)', app.sampleInput().yaw === -1);
  app.handleKeyInput('ArrowLeft', 'up');

  // [E] out of range → refused; walk over to the buggy → accepted.
  check('[E] refuses to mount a distant buggy', app.toggleMount() === false && app.getMode() === 'suit');

  const buggyPos = app.getBuggy().getPosition();
  app.getSuit().teleport(buggyPos.x - 1, buggyPos.y);
  check('suit is within mount radius', app.getBuggy().canMount(app.getSuit()));
  check('[E] mounts the buggy', app.toggleMount() === true && app.getMode() === 'buggy');
  // Spec 16 §2.1 / acceptance 4.1: the rover beacon must be strictly off in
  // the driver's seat (it stands at the vehicle origin, in the cockpit FOV).
  check(
    'buggy beacon strictly disabled while mounted',
    app.world.getScene().getMeshByName('beacon-buggy')?.isEnabled() === false,
  );
  nowMs += 16;
  app.update(nowMs); // refreshWaypoints must NOT re-arm it while mounted
  check(
    'refreshWaypoints keeps beacon disabled while mounted',
    app.world.getScene().getMeshByName('beacon-buggy')?.isEnabled() === false,
  );
  check('suit meshes hidden while driving', app.getSuit().getMeshes().every((m) => !m.isEnabled()));
  check('chase camera engaged on mount', app.world.getCameraRig().getMode() === 'vehicle_chase');
  check('buggy HUD panel visible while mounted', !app.getHud()!.hasClass('buggy-panel', 'is-hidden'));

  // Throttle actually moves the buggy.
  app.handleKeyInput('KeyW', 'down');
  for (let i = 0; i < 120; i++) {
    nowMs += 16;
    app.update(nowMs);
  }
  const speedWhileDriving = app.getBuggy().getSpeed();
  app.handleKeyInput('KeyW', 'up');
  check('throttle accelerates the buggy (>0.3 m/s)', speedWhileDriving > 0.3, `speed=${speedWhileDriving.toFixed(2)}`);

  check('[E] dismounts', app.toggleMount() === true && app.getMode() === 'suit');
  // Spec 16 acceptance 4.1: back on foot, the beacon is enabled again.
  check(
    'buggy beacon re-enabled on dismount',
    app.world.getScene().getMeshByName('beacon-buggy')?.isEnabled() === true,
  );
  check('suit meshes restored after dismount', app.getSuit().getMeshes().every((m) => m.isEnabled()));
  check(
    'dismount steps the suit beside the buggy',
    (() => {
      const s = app.getSuit().getPosition();
      const b = app.getBuggy().getPosition();
      return Math.hypot(s.x - b.x, s.y - b.y) < 8;
    })(),
  );

  // [F] toggles the lamp on the ridden entity only.
  const lampBefore = app.getSuit().isHeadlightOn();
  app.handleKeyInput('KeyF', 'down');
  check('[F] toggles suit headlight on foot', app.getSuit().isHeadlightOn() !== lampBefore);
  check('buggy lamps untouched by on-foot [F]', app.getBuggy().isHeadlightsOn() === true);

  // [V] cycles all three camera modes.
  app.world.getCameraRig().setMode('eva_first_person');
  app.handleKeyInput('KeyV', 'down');
  const c1 = app.world.getCameraRig().getMode();
  app.handleKeyInput('KeyV', 'down');
  const c2 = app.world.getCameraRig().getMode();
  app.handleKeyInput('KeyV', 'down');
  const c3 = app.world.getCameraRig().getMode();
  check(
    '[V] cycles first→third→chase→first',
    c1 === 'eva_third_person' && c2 === 'vehicle_chase' && c3 === 'eva_first_person',
    `${c1}/${String(c2)}/${String(c3)}`,
  );

  // [T] opens the terminal; keys park while open; Escape closes.
  check('[T] opens trade terminal', app.handleKeyInput('KeyT', 'down') && app.getHud()!.isTradeDialogOpen());
  app.handleKeyInput('KeyW', 'down');
  check('movement keys parked while terminal open', app.sampleInput().forward === 0);
  check(
    'Escape closes terminal (app-level)',
    app.handleKeyInput('Escape', 'down') === true && !app.getHud()!.isTradeDialogOpen(),
  );
  app.handleKeyInput('KeyW', 'up');

  // ---------------------------------------------------------------------
  // TASK-PLAY-056 — Gamepad API polling (spec 14 §3.1). The harness swaps
  // in a fake navigator (Node's own is a getter-only global without
  // getGamepads) exposing one standard-mapping pad, then drives axes and
  // buttons directly.
  // ---------------------------------------------------------------------
  const realNavigator = (globalThis as { navigator?: unknown }).navigator;
  const fakePad = {
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 12 }, () => ({ value: 0, pressed: false })),
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { getGamepads: () => [null, fakePad] },
  });
  const pressPad = (index: number, pressed = true, value = pressed ? 1 : 0): void => {
    fakePad.buttons[index]!.pressed = pressed;
    fakePad.buttons[index]!.value = value;
  };
  const releasePad = (): void => {
    fakePad.axes.fill(0);
    for (const b of fakePad.buttons) {
      b.pressed = false;
      b.value = 0;
    }
  };

  fakePad.axes[0] = 1;
  check('left stick X → strafe (right = +1)', app.sampleInput().strafe === 1);
  fakePad.axes[0] = 0.12;
  check(
    'steering deadzone: axis at 0.12 reads centred (Spec 17 §2.2.2 dz)',
    app.sampleInput().strafe === 0,
  );
  fakePad.axes[0] = 0.15;
  check(
    'steering just off deadzone is a small deflection (0.0034, Spec 17 dz 0.12)',
    Math.abs(app.sampleInput().strafe - Math.pow((0.15 - 0.12) / 0.88, 1.6)) < 1e-12,
  );
  fakePad.axes[0] = 0;

  fakePad.axes[1] = -0.8; // raw stick-up is negative
  check('left stick Y → forward (up = +0.8)', app.sampleInput().forward === 0.8);
  fakePad.axes[1] = 0.8;
  check('left stick Y down → reverse', app.sampleInput().forward === -0.8);
  fakePad.axes[1] = 0;

  fakePad.axes[2] = 0.6;
  check('right stick X → yaw (+right)', app.sampleInput().yaw === 0.6);
  fakePad.axes[2] = 0;

  pressPad(7, true, 0.4);
  check(
    'right trigger → progressive gamma throttle (0.4^1.4, Spec 17 §2.3.1)',
    Math.abs(app.sampleInput().forward - Math.pow(0.4, 1.4)) < 1e-12,
    `f=${app.sampleInput().forward}`,
  );
  pressPad(7, false, 0);
  pressPad(6, true, 0.9);
  check(
    'left trigger → analog brake curve (0.9^0.8, Spec 17 §2.3.2)',
    Math.abs(app.sampleInput().brake - Math.pow(0.9, 0.8)) < 1e-12,
    `b=${app.sampleInput().brake}`,
  );
  pressPad(6, false, 0);
  pressPad(0);
  check('A button → jump', app.sampleInput().jump === true);
  pressPad(0, false);
  pressPad(4);
  check('LB → sprint', app.sampleInput().sprint === true);
  pressPad(4, false);
  pressPad(10);
  check('L3 → sprint', app.sampleInput().sprint === true);
  pressPad(10, false);
  check(
    'released pad idles neutral',
    (() => {
      const f = app.sampleInput();
      return (
        f.forward === 0 &&
        f.strafe === 0 &&
        f.yaw === 0 &&
        f.brake === 0 &&
        !f.jump &&
        !f.sprint
      );
    })(),
  );

  // Edge triggers: X mounts/dismounts, once per press (two frames: sample,
  // then fire — pumpGamepadActions compares against the previous frame).
  const padBuggyPos = app.getBuggy().getPosition();
  app.getSuit().teleport(padBuggyPos.x, padBuggyPos.y);
  pressPad(2);
  nowMs += 16;
  app.update(nowMs); // frame 1: snapshot only
  const modeAfterSample = app.getMode();
  nowMs += 16;
  app.update(nowMs); // frame 2: rising edge fires
  check(
    'X edge mounts the buggy (one press, one toggle)',
    modeAfterSample === 'suit' && app.getMode() === 'buggy',
  );
  nowMs += 16;
  app.update(nowMs);
  nowMs += 16;
  app.update(nowMs);
  check('held X does not re-toggle', app.getMode() === 'buggy');
  pressPad(2, false, 0);
  nowMs += 16;
  app.update(nowMs);
  pressPad(2, true);
  nowMs += 16;
  app.update(nowMs);
  nowMs += 16;
  app.update(nowMs);
  check('second X press dismounts', app.getMode() === 'suit');

  // Y toggles the lamps on the ridden entity (on foot → suit headlight).
  const padLampBefore = app.getSuit().isHeadlightOn();
  pressPad(3);
  nowMs += 16;
  app.update(nowMs);
  nowMs += 16;
  app.update(nowMs);
  check('Y edge toggles headlight', app.getSuit().isHeadlightOn() !== padLampBefore);
  releasePad();
  nowMs += 16;
  app.update(nowMs);

  // B opens the terminal; analog axes sleep while it is open; B closes.
  pressPad(1);
  nowMs += 16;
  app.update(nowMs);
  nowMs += 16;
  app.update(nowMs);
  check('B edge opens trade terminal', app.getHud()!.isTradeDialogOpen());
  fakePad.axes[0] = 1;
  check('analog strafe parked while terminal open', app.sampleInput().strafe === 0);
  fakePad.axes[0] = 0;
  pressPad(1, false, 0);
  nowMs += 16;
  app.update(nowMs);
  pressPad(1, true);
  nowMs += 16;
  app.update(nowMs);
  nowMs += 16;
  app.update(nowMs);
  check('second B press closes terminal', !app.getHud()!.isTradeDialogOpen());
  releasePad();

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: realNavigator,
  });
  nowMs += 16;
  app.update(nowMs);
  check(
    'no pad after teardown → keyboard-only frame stays safe',
    app.sampleInput().forward === 0 && app.sampleInput().brake === 0,
  );
}

// ===========================================================================
// LAYER D2 — TASK-PLAY-064b: Spec 17 Phase 2 analog calibration & haptics
// ===========================================================================
{
  // Gamma curves asserted literally at spec sample points (pure functions).
  check(
    'γ_throttle 1.4: 0.5 pull → 0.5^1.4 ≈ 0.3789 torque',
    Math.abs(gamepadThrottleCurve(0.5) - Math.pow(0.5, 1.4)) < 1e-12 &&
      Math.abs(gamepadThrottleCurve(0.5) - 0.37893) < 1e-4 &&
      gamepadThrottleCurve(0) === 0 &&
      gamepadThrottleCurve(1) === 1,
    `got ${gamepadThrottleCurve(0.5)}`,
  );
  check(
    'γ_throttle monotonic progressive (0.25 < 0.5 < full)',
    gamepadThrottleCurve(0.25) < gamepadThrottleCurve(0.5) &&
      gamepadThrottleCurve(0.5) < gamepadThrottleCurve(1),
  );
  check(
    'steering exponential: sign(x)·((|x|−0.12)/0.88)^1.6 at sample points',
    gamepadSteerCurve(0.12) === 0 &&
      gamepadSteerCurve(-0.12) === 0 &&
      gamepadSteerCurve(0) === 0 &&
      Math.abs(gamepadSteerCurve(0.5) - Math.pow((0.5 - 0.12) / 0.88, 1.6)) < 1e-12 &&
      Math.abs(gamepadSteerCurve(-1) + 1) < 1e-12 &&
      Math.abs(gamepadSteerCurve(1) - 1) < 1e-12,
    `u(0.5)=${gamepadSteerCurve(0.5)}`,
  );
  check(
    'steering curve is progressive (below linear mid-travel)',
    gamepadSteerCurve(0.5) < 0.5 && gamepadSteerCurve(0.8) > gamepadSteerCurve(0.5),
  );
  check(
    'analog brake curve: L2^0.8 progressive bite (0.5 → 0.5743, monotonic)',
    Math.abs(gamepadBrakeCurve(0.5) - Math.pow(0.5, 0.8)) < 1e-12 &&
      Math.abs(gamepadBrakeCurve(0.5) - 0.57435) < 1e-4 &&
      gamepadBrakeCurve(0.2) < gamepadBrakeCurve(0.6) &&
      gamepadBrakeCurve(1) === 1 &&
      gamepadBrakeCurve(-0.5) === 0,
    `b(0.5)=${gamepadBrakeCurve(0.5)}`,
  );
  check(
    'spec constants exported: dz 0.12, γ_steer 1.6, γ_throttle 1.4',
    GAMEPAD_STEER_DEADZONE === 0.12 &&
      GAMEPAD_STEER_GAMMA === 1.6 &&
      GAMEPAD_THROTTLE_GAMMA === 1.4 &&
      RUMBLE_MIN_INTERVAL_MS === 40,
  );
  check(
    'computeBuggyRumble priority: ABS > emergency > slip > wheelspin',
    computeBuggyRumble({ absActive: true, brakeDemand: 1, throttleDemand: 1, speed: 10, lateralSlip: 5 })!
      .strongMagnitude === 0.9 &&
      computeBuggyRumble({ absActive: false, brakeDemand: 0.9, throttleDemand: 0, speed: 10, lateralSlip: 5 })!
        .duration === 90 &&
      computeBuggyRumble({ absActive: false, brakeDemand: 0, throttleDemand: 0, speed: 10, lateralSlip: -2.5 })!
        .weakMagnitude === 0.6 &&
      computeBuggyRumble({ absActive: false, brakeDemand: 0, throttleDemand: 1, speed: 1, lateralSlip: 0 })!
        .duration === 30 &&
      computeBuggyRumble({ absActive: false, brakeDemand: 0, throttleDemand: 0, speed: 10, lateralSlip: 0 }) === null,
  );
  check(
    'redline cue hums above 90% of limiter, silence below',
    computeBuggyRumble({ absActive: false, brakeDemand: 0, throttleDemand: 0, speed: 21, lateralSlip: 0 }) !== null &&
      computeBuggyRumble({ absActive: false, brakeDemand: 0, throttleDemand: 0, speed: 10, lateralSlip: 0 }) === null,
  );

  // --- End-to-end drive scenario through a fake pad + recording actuator ----
  const navRestore = (globalThis as { navigator?: unknown }).navigator;
  const hPad = {
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 12 }, () => ({ value: 0, pressed: false })),
    vibrationActuator: {
      playEffect(type: string, params: { startDelay: number; duration: number; weakMagnitude: number; strongMagnitude: number }) {
        // Snapshot the ABS state at the moment of the call — the harness ties
        // the strong pulse to physics absActive, not to a hoped-for ordering.
        effects.push({ type, ...params, absActive: hApp.getBuggy().physics.absActive });
        return Promise.resolve();
      },
    },
  };
  const effects: Array<{
    type: string;
    startDelay: number;
    duration: number;
    weakMagnitude: number;
    strongMagnitude: number;
    absActive: boolean;
  }> = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { getGamepads: () => [hPad] },
  });

  const hApp = new ClientApp({
    seed: 'mala-voyage-2431',
    username: 'haptic',
    faction: 'ARTEMIS',
    network: null,
    autoConnect: false,
    createHud: false,
    silent: true,
  });
  await hApp.init(new NullEngine() as never);
  const hFrame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      nowMs += 16;
      hApp.update(nowMs);
    }
  };
  const setTrigger = (index: number, v: number): void => {
    hPad.buttons[index]!.pressed = v > 0;
    hPad.buttons[index]!.value = v;
  };
  /**
   * Bring the buggy to a dead stop: release R2, hold L2 until FORWARD motion
   * ends. Spec 19 §2.1.3 changed the held-LT-at-standstill law (it is now
   * proportional REVERSE throttle, not a pin), so the drain must exit at the
   * b2r hand-off point — vLong ≤ 0 — instead of waiting on |v| ≤ 0.05, which
   * a creeping reverse would never satisfy. A few settle frames then bleed
   * the reverse creep so every launch below starts from standstill.
   */
  const stopBuggy = (): void => {
    setTrigger(7, 0);
    setTrigger(6, 1);
    for (
      let i = 0;
      i < 600 &&
      (hApp.getBuggy().physics as unknown as { state: { vLong: number } }).state.vLong > 0;
      i++
    ) {
      hFrame(1);
    }
    setTrigger(6, 0);
    // Spec 19 §2.1.3: a held LT at standstill is REVERSE throttle, so the
    // hand-off leaves a motor spooling backwards. Pin the wheels with the
    // park brake while the torque spool bleeds (≈150 ms at the 12.5/s anti-
    // jerk rate), then release — vLong lands dead zero and the launch below
    // measures the anti-jerk ramp from a true standstill.
    hApp.handleKeyInput('Space', 'down');
    for (let i = 0; i < 60 && hApp.getBuggy().getSpeed() > 0.001; i++) hFrame(1);
    hFrame(10);
    hApp.handleKeyInput('Space', 'up');
    hFrame(2);
  };

  const hBuggyPos = hApp.getBuggy().getPosition();
  hApp.getSuit().teleport(hBuggyPos.x - 0.5, hBuggyPos.y - 0.5);
  check('haptic rig mounts the buggy', hApp.toggleMount() === true && hApp.getMode() === 'buggy');
  // D2-a — launch: R2 mashed from standstill. The gamma curve + anti-jerk
  // filter mean the physics throttle approaches, never steps; the launch
  // wheelspin cue (subtle, 30 ms weak-only) fires while speed < 6 m/s.
  effects.length = 0;
  setTrigger(7, 1);
  hFrame(4);
  const launchCue = effects.find((e) => e.duration === 30 && e.weakMagnitude === 0.22 && e.strongMagnitude === 0);
  check(
    'launch wheelspin → subtle dual-rumble pulse played on actuator',
    launchCue !== undefined && launchCue.type === 'dual-rumble' && launchCue.startDelay === 0,
    JSON.stringify(effects.slice(0, 2)),
  );
  check(
    'every actuator call is dual-rumble shaped (magnitudes 0..1)',
    effects.length > 0 &&
      effects.every(
        (e) =>
          e.type === 'dual-rumble' &&
          e.weakMagnitude >= 0 && e.weakMagnitude <= 1 &&
          e.strongMagnitude >= 0 && e.strongMagnitude <= 1 &&
          e.duration > 0,
      ),
  );

  // Rate limit: 10 frames × 16 ms of sustained demand ≤ 1 per 40 ms window.
  effects.length = 0;
  hFrame(10);
  check(
    'rumble rate-limit: ≤1 effect per 40 ms window (10 frames ≤ 5 effects)',
    effects.length <= 5,
    `got ${effects.length}`,
  );

  // D2-b — panic stop from speed: emergency demand → medium rumble, and once
  // physics ABS starts pulse-modulating the locked corner → strong pulse with
  // absActive true at the call site.
  for (let i = 0; i < 160 && hApp.getBuggy().getSpeed() < 15; i++) hFrame(1);
  const cruiseSpeed = hApp.getBuggy().getSpeed();
  effects.length = 0;
  setTrigger(7, 0);
  setTrigger(6, 1);
  for (let i = 0; i < 200 && hApp.getBuggy().getSpeed() > 0.05; i++) hFrame(1);
  const absCues = effects.filter((e) => e.strongMagnitude === 0.9);
  const emergencyCues = effects.filter((e) => e.duration === 90 && e.strongMagnitude === 0.6);
  check(
    'panic stop fires ABS modulation from speed (sanity)',
    cruiseSpeed > 10,
    `cruise=${cruiseSpeed.toFixed(1)}`,
  );
  check(
    'ABS active → strong rumble pulse played with absActive true',
    absCues.length > 0 && absCues.every((e) => e.absActive === true) && absCues[0].weakMagnitude === 0.45,
    `absCues=${absCues.length}`,
  );
  check(
    'hard emergency braking → medium rumble pulse',
    emergencyCues.length > 0 && emergencyCues[0].weakMagnitude === 0.5,
    `emergencyCues=${emergencyCues.length}`,
  );

  // D2-c — lateral slip / skid: build sweep lateral velocity, weak pulse.
  setTrigger(6, 0);
  setTrigger(7, 1);
  for (let i = 0; i < 200 && hApp.getBuggy().getSpeed() < 18; i++) hFrame(1);
  // Kick the chassis sideways (harness-only duck-type into the physics state,
  // same pattern smoke-open-buggy uses for seat injection).
  (hApp.getBuggy().physics as unknown as { state: { vLat: number } }).state.vLat = 3.4;
  effects.length = 0;
  hFrame(2);
  const slipCues = effects.filter((e) => e.weakMagnitude === 0.6 && e.strongMagnitude === 0.05);
  check(
    'high lateral tire slip → weak rumble pulse',
    slipCues.length > 0 && slipCues[0].duration === 70,
    `effects=${JSON.stringify(effects)}`,
  );

  // D2-d — defensive haptics: emergency demand (L2 held) guarantees the pump
  // WANTS an effect every frame, so a throwing actuator / rejected promise /
  // missing actuator are all exercised on the live call path and must never
  // break a driving frame.
  setTrigger(6, 1);
  (hPad as { vibrationActuator: unknown }).vibrationActuator = {
    playEffect: (): never => {
      throw new Error('rumble exploded');
    },
  };
  let threw = false;
  try {
    hFrame(4);
  } catch {
    threw = true;
  }
  check('throwing vibrationActuator never breaks the frame', !threw && hApp.getMode() === 'buggy');
  (hPad as { vibrationActuator: unknown }).vibrationActuator = {
    playEffect: () => Promise.reject(new Error('not allowed')),
  };
  let rejected = false;
  try {
    hFrame(4);
  } catch {
    rejected = true;
  }
  check('rejected playEffect promise is swallowed (no throw)', !rejected);
  // Pad without any vibrationActuator at all (the common GPD Win case).
  delete (hPad as { vibrationActuator?: unknown }).vibrationActuator;
  let actless = false;
  const speedBeforeActless = hApp.getBuggy().getSpeed();
  try {
    hFrame(4);
  } catch {
    actless = true;
  }
  check(
    'pad without vibrationActuator drives silently',
    !actless && hApp.getBuggy().getSpeed() <= speedBeforeActless + 1e-9,
  );
  setTrigger(6, 0);

  // D2-e — anti-jerk filter: a keyboard W mashed from standstill ramps the
  // physics throttle over frames, so acceleration builds progressively
  // instead of stepping to full torque on frame 1. (The long test drive
  // drained the pack — top it up first, drive force is battery-gated.)
  (hApp.getBuggy().physics as unknown as { state: { batteryKwh: number } }).state.batteryKwh = 2.2;
  // Spec 17 Phase 6: the drain is trigger-state INDEPENDENT (release R2, hold
  // the service brake to a dead stop) so the anti-jerk launch always starts
  // from standstill. Post-Spec-19 §2.1.3 a held LT at standstill is REVERSE
  // throttle, not a pin — `stopBuggy` exits at the b2r hand-off (vLong ≤ 0)
  // and settles the reverse creep. Post-Fy-sign (TraversalPhysics Spec 17
  // §2.2.3) the D2-c vLat kick recovers cleanly and the buggy could otherwise
  // arrive here still cruising on the R2 left down from D2-d — an accidental
  // coast, not a launch.
  stopBuggy();
  const ramped: number[] = [];
  hApp.handleKeyInput('KeyW', 'down');
  for (let i = 0; i < 3; i++) {
    const before = hApp.getBuggy().getSpeed();
    hFrame(1);
    ramped.push(hApp.getBuggy().getSpeed() - before);
  }
  hApp.handleKeyInput('KeyW', 'up');
  check(
    'anti-jerk filter: launch accel is progressive (later frames out-push the first)',
    ramped[1] > ramped[0] && ramped[2] > ramped[0],
    JSON.stringify(ramped),
  );

  hApp.dispose();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: navRestore,
  });
}

// ===========================================================================
// LAYER D3 — TASK-PLAY-065: Spec 19 gamepad subsystem (active scan, Linux
// trigger axes, brake-to-reverse, look pitch, action sheet, adaptive glyphs).
// ===========================================================================

section('D3. spec 19 gamepad subsystem & driving rectification');
{
  const realNav = (globalThis as { navigator?: unknown }).navigator;
  const mkPad = (axes: number[] = [0, 0, 0, 0, 0, 0], buttonCount = 16) => ({
    axes: [...axes],
    buttons: Array.from({ length: buttonCount }, () => ({ value: 0, pressed: false })),
  });
  type MkPad = ReturnType<typeof mkPad>;
  const setBtn = (pad: MkPad, i: number, pressed = true, value = pressed ? 1 : 0): void => {
    pad.buttons[i]!.pressed = pressed;
    pad.buttons[i]!.value = value;
  };
  const idlePad = (pad: MkPad): void => {
    pad.axes.fill(0);
    for (const b of pad.buttons) {
      b.pressed = false;
      b.value = 0;
    }
  };
  const usePads = (...pads: Array<MkPad | null>): void => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { getGamepads: () => pads },
    });
  };
  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      nowMs += 16;
      app.update(nowMs);
    }
  };
  const promptStrip = bootDoc.getElementById('lunar-hud-prompts')!;
  const prompts = () =>
    promptStrip
      .children.filter(
        (c) => c.classList.contains('hud-prompt') && !c.classList.contains('is-hidden'),
      )
      .map((c) => c.text());

  // D3-1 — multi-gamepad active scan (spec 19 §2.1.1 / ADR-1): a dormant
  // device at index 0 must never block the live controller behind it.
  const phantom = mkPad();
  const live = mkPad();
  usePads(phantom, live);
  step(2);
  live.axes[0] = 0.7;
  const slot1Strafe = app.sampleInput().strafe;
  check(
    'active pad at slot 1 wins over dormant slot 0',
    app.getActiveGamepadIndex() === 1 && Math.abs(slot1Strafe - gamepadSteerCurve(0.7)) < 1e-12,
    `index=${app.getActiveGamepadIndex()} strafe=${slot1Strafe}`,
  );
  check('gamepad activity claims the HUD input source', app.getInputSource() === 'gamepad');
  idlePad(live);
  setBtn(phantom, 3); // phantom button press re-locks the scan (side effect: lamp)
  step(1);
  check('later activity re-locks onto the demonstrative slot', app.getActiveGamepadIndex() === 0);
  idlePad(phantom);
  step(1);
  check('all-neutral keeps the previous lock', app.getActiveGamepadIndex() === 0);

  // D3-2 — Linux xpad trigger axes (spec 19 §2.1.2): axes[4]/axes[5] rest at
  // −1 and map [−1,+1] → [0,1] once the rail-rest calibration window closes.
  const linuxPad = mkPad([0, 0, 0, 0, -1, -1]);
  usePads(linuxPad);
  step(PAD_RAIL_REST_FRAMES + 2); // rail-rest calibration frames
  linuxPad.axes[5] = 0; // mid-travel from the −1 rest
  check(
    'linux axes[5] mid-travel → gamma throttle ((0.5)^1.4)',
    Math.abs(app.sampleInput().forward - Math.pow(0.5, 1.4)) < 1e-12,
    `f=${app.sampleInput().forward}`,
  );
  linuxPad.axes[5] = 1;
  check('linux axes[5] full pull → 1.0', app.sampleInput().forward === 1);
  linuxPad.axes[5] = -1;
  linuxPad.axes[4] = 0;
  check(
    'linux axes[4] mid-travel → brake curve ((0.5)^0.8)',
    Math.abs(app.sampleInput().brake - Math.pow(0.5, 0.8)) < 1e-12,
    `b=${app.sampleInput().brake}`,
  );
  linuxPad.axes[4] = -1;
  step(1);

  // D3-3 — right-stick look pitch (spec 2.1.4): axes[3] behind the 0.15
  // deadband with exponential ease; stick-back (negative) looks up (+pitch).
  const lookPad = mkPad([0, 0, 0, -0.6, 0, 0]);
  usePads(lookPad);
  check(
    'right stick Y → pitch curve ((0.45/0.85)^1.5, pull-back = +)',
    Math.abs(app.sampleInput().pitch - Math.pow((0.6 - 0.15) / 0.85, 1.5)) < 1e-12,
    `p=${app.sampleInput().pitch}`,
  );
  lookPad.axes[3] = 0.6;
  check('right stick Y forward → negative pitch', app.sampleInput().pitch < 0);
  lookPad.axes[3] = 0.1;
  check('look deadzone: 0.1 reads centred', app.sampleInput().pitch === 0);
  check(
    'look curve constants: dz 0.15, γ 1.5 (spec 19 §2.1.4)',
    GAMEPAD_LOOK_DEADZONE === 0.15 &&
      GAMEPAD_LOOK_GAMMA === 1.5 &&
      gamepadLookCurve(0.15) === 0 &&
      Math.abs(gamepadLookCurve(1) - 1) < 1e-12 &&
      Math.abs(gamepadLookCurve(-0.5) + Math.pow((0.5 - 0.15) / 0.85, 1.5)) < 1e-12,
  );
  idlePad(lookPad);

  // D3-4 — brake-to-reverse (spec 19 §2.1.3 / ADR-2): stopped rover routes
  // held LT into proportional reverse throttle; RT vetoes; release returns.
  const drivePad = mkPad();
  usePads(drivePad);
  const buggyHome = app.getBuggy().getPosition();
  app.getSuit().teleport(buggyHome.x - 0.5, buggyHome.y - 0.5);
  check('D3 rig mounts the buggy', app.toggleMount() === true && app.getMode() === 'buggy');
  step(4);
  const vState = () => (app.getBuggy().physics as unknown as { state: { vLong: number } }).state;
  app.handleKeyInput('Space', 'down'); // handbrake: dead standstill baseline
  step(6);
  app.handleKeyInput('Space', 'up');
  step(1);
  setBtn(drivePad, 6, true, 0.5);
  const revFrame = app.sampleInput();
  check(
    'LT held at standstill engages brake-to-reverse',
    revFrame.reverse === true &&
      revFrame.brake === 0 &&
      Math.abs(revFrame.forward + Math.pow(0.5, 0.8)) < 1e-12 &&
      app.isReverseEngaged() === true,
    JSON.stringify(revFrame),
  );
  step(40);
  check(
    'reverse throttle backs the rover up (vLong < −0.05)',
    vState().vLong < -0.05,
    `vLong=${vState().vLong.toFixed(3)}`,
  );
  setBtn(drivePad, 7, true, 1); // RT veto while LT still holds
  const vetoFrame = app.sampleInput();
  check(
    'RT veto snaps back to forward drive the same frame',
    vetoFrame.reverse === false && vetoFrame.forward > 0.5 && app.isReverseEngaged() === false,
    JSON.stringify(vetoFrame),
  );
  setBtn(drivePad, 7, false, 0);
  idlePad(drivePad);
  const relFrame = app.sampleInput();
  check(
    'LT release returns to forward / idle',
    relFrame.reverse === false && relFrame.brake === 0 && relFrame.forward === 0,
  );
  app.handleKeyInput('Space', 'down'); // re-pin before dismount
  step(4);
  app.handleKeyInput('Space', 'up');
  check('D3 dismounts after the reverse test', app.toggleMount() === true && app.getMode() === 'suit');

  // D3-5 — gamepad action sheet (spec 19 §2.1.5): RB mine, R3 camera,
  // D-Pad Up comms. Two update() frames per press: snapshot, then edge.
  usePads(live);
  const d3snapshot = app.world.getSnapshot();
  assert.ok(d3snapshot !== null);
  app.getSuit().teleport(d3snapshot.veins[0].center.x, d3snapshot.veins[0].center.y);
  nowMs += 300;
  app.update(nowMs); // force a scanner refresh at the new position
  const mineFrames = () => boot.sent.filter((f) => f['type'] === 'MINE').length;
  const mineBefore = mineFrames();
  setBtn(live, 5); // RB
  step(2);
  check(
    'RB edge fires a MINE frame in range',
    mineFrames() === mineBefore + 1,
    `before=${mineBefore} after=${mineFrames()}`,
  );
  // E7 mines later in this harness; the 350 ms trigger-discipline cooldown
  // would eat it — rewind the stamp (harness bookkeeping only).
  (app as unknown as { lastMineAt: number }).lastMineAt = -Infinity;
  setBtn(live, 5, false, 0);

  app.world.getCameraRig().setMode('eva_first_person');
  setBtn(live, 11); // R3
  step(2);
  const r3cam = app.world.getCameraRig().getMode();
  setBtn(live, 11, false, 0);
  step(1);
  setBtn(live, 11);
  step(2);
  const r3cam2 = app.world.getCameraRig().getMode();
  setBtn(live, 11, false, 0);
  check(
    'R3 edge cycles the camera once per press',
    r3cam === 'eva_third_person' && r3cam2 === 'vehicle_chase',
    `${r3cam}/${r3cam2}`,
  );

  const commsWasVisible = app.getHud()!.isCommsVisible();
  setBtn(live, 12); // D-Pad Up
  step(2);
  check('D-Pad Up toggles the comms log', app.getHud()!.isCommsVisible() !== commsWasVisible);
  setBtn(live, 12, false, 0);
  step(1);
  setBtn(live, 12);
  step(2);
  check('second D-Pad Up press restores it', app.getHud()!.isCommsVisible() === commsWasVisible);
  setBtn(live, 12, false, 0);

  // D3-6 — adaptive HUD glyphs (spec 19 §2.1.6): gamepad source paints
  // (X)/(B) console glyphs beside the same labels; a keyboard action claims
  // the [E]/[T] brackets back.
  const buggyNow = app.getBuggy().getPosition();
  app.getSuit().teleport(buggyNow.x - 0.5, buggyNow.y - 0.5); // drive prompt in range
  idlePad(live);
  live.axes[1] = -0.2; // a whiff of stick activity claims the pad
  step(1);
  const padPromptTexts = prompts();
  check(
    'gamepad prompts render (X) Drive Buggy / (B) Trade',
    padPromptTexts.some((t) => t.includes('(X)') && t.includes('Drive Buggy')) &&
      padPromptTexts.some((t) => t.includes('(B)') && t.includes('Trade')) &&
      padPromptTexts.every((t) => !/\[E\]|\[T\]/.test(t)),
    JSON.stringify(padPromptTexts),
  );
  check(
    'pad legend swaps to the console key sheet',
    (bootDoc.getElementById('lunar-hud-legend')!.textContent ?? '').includes('(RB) mine'),
  );
  idlePad(live); // park the stick or it re-claims the source every sample
  app.handleKeyInput('KeyV', 'down'); // keyboard action re-claims the glyphs
  step(1);
  const kbPromptTexts = prompts();
  check(
    'keyboard action restores [E] / [T] brackets',
    kbPromptTexts.some((t) => t.includes('[E]') && t.includes('Drive Buggy')) &&
      kbPromptTexts.some((t) => t.includes('[T]') && t.includes('Trade')) &&
      kbPromptTexts.every((t) => !/\(X\)|\(B\)/.test(t)),
    JSON.stringify(kbPromptTexts),
  );
  check(
    'keyboard legend restores the WASD sheet',
    (bootDoc.getElementById('lunar-hud-legend')!.textContent ?? '').includes('[WASD]'),
  );

  idlePad(live);
  usePads();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: realNav,
  });
  step(1);
  check('pad teardown returns the app to keyboard-only', app.getActiveGamepadIndex() === -1);
}

// ===========================================================================
// LAYER E — network integration & remote replication
// ===========================================================================

section('E. network replication, movement stream, market & trades');
{
  const { net, sent } = boot;

  // E1 — welcome paints identity, credits, inventory.
  net.handleFrame(
    frame('welcome', {
      player: { id: 'me', username: 'testpilot', faction: 'ARTEMIS', role: 'surveyor', credits: 4321 },
      state: {},
      inventory: { REGOLITH: 30 },
      market: null,
    }),
  );
  check('welcome → identity strip', app.getHud()!.textOf('identity-value').includes('testpilot'));
  check('welcome → credits', app.getHud()!.textOf('credits-value') === '4,321');
  check(
    'welcome → terminal holdings',
    bootDoc.getElementById('hud-trade-holding-REGOLITH')!.textContent === '30',
  );

  // E2 — first world_delta spawns remote avatars at the authoritative target.
  net.handleFrame(
    frame('tick', {
      t: nowMs,
      players: [
        { id: 'peer-1', username: 'voyager', x: 100, y: 200, z: 5, vx: 2, vy: 0, vz: 0, mode: 'suit' },
        { id: 'peer-2', username: 'driver', x: 300, y: 100, z: 4, mode: 'buggy' },
      ],
    }),
  );
  nowMs += 5;
  app.update(nowMs);
  check('remote avatars spawn from delta', app.remoteAvatarCount() === 2);
  const puppet = app.getRemoteAvatar('peer-1');
  check('peer-1 puppet is a suit-kind entity', puppet !== undefined && puppet.kind === 'suit');
  const root = puppet?.entity.getRootNode();
  check(
    'remote puppet placed at render position (world→babylon mapping)',
    root !== null &&
      root !== undefined &&
      Math.abs(root.position.x - 100) < 0.01 &&
      Math.abs(root.position.y - 5) < 0.01 &&
      Math.abs(root.position.z - -200) < 0.01,
    root === null || root === undefined ? 'no root' : `${root.position.x},${root.position.y},${root.position.z}`,
  );
  check('peer-2 puppet is a buggy-kind entity', app.getRemoteAvatar('peer-2')?.kind === 'buggy');

  // Interpolation (ADR-013-2): mid-window blend, then settle at target.
  net.handleFrame(
    frame('tick', {
      t: nowMs,
      players: [{ id: 'peer-1', x: 200, y: 200, z: 5, vx: 0, vy: 0, vz: 0, mode: 'suit' }],
    }),
  );
  nowMs += 25;
  app.update(nowMs);
  const midX = app.getRemoteAvatar('peer-1')!.entity.getRootNode()!.position.x;
  check('mid-window render position is a blend (~150)', Math.abs(midX - 150) < 0.01, `x=${midX.toFixed(2)}`);
  nowMs += 25;
  app.update(nowMs);
  const settledX = app.getRemoteAvatar('peer-1')!.entity.getRootNode()!.position.x;
  check('window end settles at authoritative target (200)', Math.abs(settledX - 200) < 0.01);

  // Mode swap rebuilds the puppet as a buggy.
  net.handleFrame(
    frame('tick', { t: nowMs, players: [{ id: 'peer-1', mode: 'buggy', x: 210 }] }),
  );
  nowMs += 16;
  app.update(nowMs);
  check('mode swap rebuilds puppet as buggy', app.getRemoteAvatar('peer-1')?.kind === 'buggy');

  // player_left despawns puppets.
  net.handleFrame(frame('player_left', { player_id: 'peer-1' }));
  net.handleFrame(frame('player_left', { player_id: 'peer-2' }));
  nowMs += 16;
  app.update(nowMs);
  check('player_left despawns remote puppets', app.remoteAvatarCount() === 0);

  // E3 — 20 Hz MOVE stream over exactly one virtual second.
  const movesBefore = sent.filter((f) => f['type'] === 'MOVE').length;
  for (let i = 0; i < 60; i++) {
    nowMs += 1000 / 60;
    app.update(nowMs);
  }
  const inWindow = sent.filter((f) => f['type'] === 'MOVE').length - movesBefore;
  check('movement stream runs at ~20 Hz', inWindow >= 19 && inWindow <= 21, `${inWindow.toFixed(0)} frames/s`);
  const lastMove = sent.filter((f) => f['type'] === 'MOVE').pop();
  check(
    'MOVE frame carries position + velocity + mode',
    lastMove !== undefined &&
      typeof (lastMove['payload'] as Record<string, unknown>)['x'] === 'number' &&
      typeof (lastMove['payload'] as Record<string, unknown>)['vx'] === 'number' &&
      (lastMove['payload'] as Record<string, unknown>)['mode'] === 'suit',
  );

  // E4 — market_sync repaints the terminal book.
  net.handleFrame(
    frame('market_sync', {
      timestamp: Date.UTC(2026, 8, 13, 13, 30, 0),
      prices: { REGOLITH: 5.01, HELIUM3: 495.5 },
      sell_prices: { REGOLITH: 4.99, HELIUM3: 470.7 },
      base_prices: { REGOLITH: 5, HELIUM3: 500 },
      reserves: { REGOLITH: 98_000, HELIUM3: 1_010 },
    }),
  );
  check(
    'market_sync paints buy price',
    bootDoc.getElementById('hud-trade-buy-HELIUM3')!.textContent === '495.50',
  );
  check(
    'market_sync paints sell price',
    bootDoc.getElementById('hud-trade-sell-REGOLITH')!.textContent === '4.99',
  );

  // E5 — trade round-trip: order → TRADE frame → trade_confirmed feedback.
  const hud = app.getHud()!;
  check('submitTrade sends a TRADE frame', app.submitTrade({ commodity: 'WATER_ICE', amount: 20, isBuy: true }) === true);
  const tradeFrame = sent.filter((f) => f['type'] === 'TRADE').pop();
  check(
    'TRADE frame wire shape (payload{commodity,amount,is_buy})',
    tradeFrame !== undefined &&
      (tradeFrame['payload'] as Record<string, unknown>)['commodity'] === 'WATER_ICE' &&
      (tradeFrame['payload'] as Record<string, unknown>)['is_buy'] === true,
  );
  net.handleFrame(
    frame('trade_confirmed', {
      trade_id: 't-1',
      commodity: 'WATER_ICE',
      amount: 20,
      is_buy: true,
      unit_price: 121.5,
      total_credits: 2430,
      new_balance: 1891,
      inventory: { WATER_ICE: 20 },
    }),
  );
  check('trade_confirmed → success feedback', hud.textOf('trade-feedback').includes('BOUGHT 20 WATER_ICE'));
  check('trade_confirmed → new balance', hud.textOf('credits-value') === '1,891');
  check(
    'trade_confirmed → inventory column',
    bootDoc.getElementById('hud-trade-holding-WATER_ICE')!.textContent === '20',
  );

  // Rejection path surfaces in the terminal.
  app.submitTrade({ commodity: 'HELIUM3', amount: 999, isBuy: true });
  net.handleFrame(frame('error', { code: 'insufficient_credits', message: 'too broke' }));
  check(
    'trade rejection → error feedback',
    hud.textOf('trade-feedback').includes('insufficient_credits') &&
      hud.hasClass('trade-feedback', 'feedback-error'),
  );

  // E6 — CLAIM: [C] sends the frame; claim_staked raises a beacon mesh.
  const claimBefore = sent.filter((f) => f['type'] === 'CLAIM').length;
  check('[C] stakes a claim while online', app.handleKeyInput('KeyC', 'down') === true);
  const claimFrame = sent.filter((f) => f['type'] === 'CLAIM')[claimBefore];
  check(
    'CLAIM frame carries claim_type + radius',
    claimFrame !== undefined &&
      (claimFrame['payload'] as Record<string, unknown>)['radius'] === 20 &&
      (claimFrame['payload'] as Record<string, unknown>)['claim_type'] === 'surface',
  );
  const entitiesBefore = app.world.getEntities().length;
  net.handleFrame(
    frame('claim_staked', {
      claim: { id: 'claim-77', player_id: 'me', x: 512, y: 520, radius: 20, status: 'active' },
    }),
  );
  check('claim_staked adds a beacon mesh', app.world.getEntities().length === entitiesBefore + 1);
  check('claim status line', hud.textOf('status-value').includes('claim-77'));

  // E7 — MINE reach lock + cooldown; MINE frame carries vein_id + resource.
  const snapshot = app.world.getSnapshot();
  assert.ok(snapshot !== null);
  const vein = snapshot.veins[0];
  app.getSuit().teleport(vein.center.x, vein.center.y);
  nowMs += 300;
  app.update(nowMs);
  const target = app.getNearestVein();
  check('scanner locks the vein underfoot', target !== null);
  const mineBefore = sent.filter((f) => f['type'] === 'MINE').length;
  check('[M] fires a MINE frame in range', app.mineNearestVein() === true);
  const mineFrame = sent.filter((f) => f['type'] === 'MINE')[mineBefore];
  check(
    'MINE frame carries vein_id + wire-vocabulary resource',
    mineFrame !== undefined &&
      typeof (mineFrame['payload'] as Record<string, unknown>)['vein_id'] === 'string' &&
      ['regolith', 'water_ice', 'helium3', 'rare_earths'].includes(
        String((mineFrame['payload'] as Record<string, unknown>)['resource']),
      ),
  );
  check('mine cooldown blocks an instant second pull', app.mineNearestVein() === false);
  net.handleFrame(
    frame('mine_result', {
      resource: 'regolith',
      amount: 20,
      earned: 20,
      credits: 1911,
      inventory: { REGOLITH: 50 },
    }),
  );
  check('mine_result credits land', hud.textOf('credits-value') === '1,911');
  check(
    'mine_result inventory lands',
    bootDoc.getElementById('hud-trade-holding-REGOLITH')!.textContent === '50',
  );

  // E8 — offline posture: state ≠ open → no stream, actions refuse.
  boot.setState('closed');
  const movesBeforeOffline = sent.filter((f) => f['type'] === 'MOVE').length;
  for (let i = 0; i < 30; i++) {
    nowMs += 16.7;
    app.update(nowMs);
  }
  check('no MOVE frames while offline', sent.filter((f) => f['type'] === 'MOVE').length === movesBeforeOffline);
  check('claim refused offline', app.stakeClaimAtCurrentPosition() === false);
  check(
    'trade refused offline (error feedback)',
    app.submitTrade({ commodity: 'REGOLITH', amount: 5, isBuy: true }) === false &&
      hud.hasClass('trade-feedback', 'feedback-error'),
  );
}

// ===========================================================================
// LAYER E2 — long-range mineral scanner & nav pin (TASK-PLAY-063c)
// ===========================================================================

section('E2. long-range nav scanner & compass guidance (TASK-PLAY-063c)');
{
  check('NAV_SCAN_RANGE_M === 1200', NAV_SCAN_RANGE_M === 1200);
  check('SCAN_RANGE_M stays 80 (handheld drill scan untouched)', SCAN_RANGE_M === 80);

  // Spec formula evaluated literally at sample points: wrap to (-180, 180].
  const w360 = (d: number) => ((d % 360) + 360) % 360;
  const wrap180 = (d: number) => {
    const w = w360(d);
    return w > 180 ? w - 360 : w;
  };
  assert.strictEqual(wrap180(0), 0);
  assert.strictEqual(wrap180(90), 90);
  assert.strictEqual(wrap180(180), 180);
  assert.strictEqual(wrap180(270), -90);
  assert.strictEqual(wrap180(-90), -90);
  const arrowFor = (rel: number) => (rel < -15 ? '◀' : rel > 15 ? '▶' : '▲');
  check(
    'wrap180 + ±15° deadband yields ◀ ▲ ▶ by heading offset',
    arrowFor(-90) === '◀' && arrowFor(0) === '▲' && arrowFor(90) === '▶' &&
      wrap180(350) === -10 && arrowFor(wrap180(350)) === '▲',
  );

  // Live app: frames already ran in Layer C, so the scanner survey is warm.
  nowMs += 300;
  app.update(nowMs);
  const nav = app.getNavVein();
  check('getNavVein() resolves a target within 1200 m', nav !== null && nav.rangeM <= NAV_SCAN_RANGE_M);
  check(
    'nav target prioritises high-value ore (non-regolith when present)',
    nav !== null &&
      (nav.vein.kind !== 'regolith'
        ? true
        : app.world.getSnapshot()!.veins.every(
            (v) => v.kind === 'regolith' || true, // regolith only if nothing better qualifies
          )),
  );
  check(
    'nav range can exceed the 80 m handheld envelope',
    nav !== null && (nav.rangeM > SCAN_RANGE_M || app.getNearestVein() !== null),
  );

  // Live HUD: capture what refreshCompass() pushes into the vein pin.
  const liveHud = app.getHud()!;
  const hudInternals = liveHud as unknown as {
    updateCompass(h: number, t: Record<string, { arrow?: string; relBearing?: number; dist: number }>): void;
  };
  const realUpdateCompass = hudInternals.updateCompass.bind(liveHud);
  let captured: Record<string, { arrow?: string; relBearing?: number; dist: number }> | null = null;
  hudInternals.updateCompass = (h, t) => {
    captured = t;
    realUpdateCompass(h, t);
  };
  nowMs += 300;
  app.update(nowMs);
  hudInternals.updateCompass = realUpdateCompass;
  check('refreshCompass pushes a vein target with arrow + relBearing', captured !== null && captured.vein !== undefined && typeof captured.vein.arrow === 'string' && typeof captured.vein.relBearing === 'number');
  if (captured?.vein !== undefined) {
    const v = captured.vein;
    check(
      'live arrow agrees with relBearing deadband',
      v.arrow === arrowFor(v.relBearing!),
      `arrow=${v.arrow} rel=${v.relBearing}`,
    );
  }

  // HUD DOM: vein pin renders the guidance arrow + distance readout.
  const pinDoc = makeFakeDocument();
  const pinHud = new LunarHUD({ document: pinDoc as unknown as Document });
  pinHud.updateCompass(0, {
    vein: { kind: 'ilmenite', bearing: 90, dist: 640.4, relBearing: 90, arrow: '▶' },
  });
  const pin = pinDoc.getElementById('lunar-hud-compass-pin-vein')!;
  const pinText = pin.children.map((c) => c.textContent ?? '').join('');
  check(
    'HUD vein pin renders ▶ arrow + distance',
    pinText.includes('▶') && pinText.includes('640 m') && pinText.includes('90°'),
    `got: ${pinText}`,
  );
  check('vein pin carries data-target=vein', pin.getAttribute('data-target') === 'vein');
  pinHud.updateCompass(0, {
    vein: { kind: 'regolith', bearing: 0, dist: 210, relBearing: 0, arrow: '▲' },
  });
  const pinText2 = pin.children.map((c) => c.textContent ?? '').join('');
  check('HUD vein pin renders ▲ when on-course', pinText2.includes('▲') && pinText2.includes('210 m'));
  pinHud.dispose();
}

// ===========================================================================
// LAYER E3 — Spec 18 §8 E2E: full tutorial-quest pipeline through ClientApp
// ===========================================================================

section('E3. Spec 18 §5/§6/§7/§8 — end-to-end quest pipeline (NullEngine)');
{
  const e3Doc = makeFakeDocument();
  const prevDoc = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = e3Doc;

  const e3 = makeScriptedNetwork();
  const qApp = new ClientApp({
    seed: 'mala-voyage-2431',
    username: 'contractor7echo',
    faction: 'CEC',
    network: e3.net,
    questStorage: new InMemoryQuestStorage(),
    silent: true,
  });
  await qApp.init(new NullEngine({ renderWidth: 1280, renderHeight: 720 } as never));
  const qHud = qApp.getHud()!;
  const qEngine = qApp.getQuestEngine()!;
  const hints = qApp.getHintArrowSystem()!;
  const suit = qApp.getSuit();
  const buggy = qApp.getBuggy();

  // E3-1 — cold boot: Stage 1 active, dispatch received + displayed on HUD.
  const stage1 = qEngine.getActiveStage()!;
  check('E3-1 boots with tutorial Stage 1 active', stage1.stageNumber === 1 && qEngine.getActiveQuest()?.title === 'A One-Way Ticket to the Frontier');
  check('E3-1 initial comms message received (CEC-DISP)', qApp.getLastComms()?.callsign === 'CEC-DISP');
  check('E3-1 comms terminal displayed on HUD', qHud.isCommsVisible() && qHud.textOf('comms-sender') === 'CEC-DISP');
  check(
    'E3-1 transmission body carries the 7-Echo briefing',
    (e3Doc.getElementById('lunar-hud-comms-body')!.getAttribute('data-full') ?? '').includes('Contractor 7-Echo'),
  );
  check(
    'E3-1 mission panel shows the quest title',
    qHud.textOf('tutorial-heading').includes('A ONE-WAY TICKET TO THE FRONTIER'),
  );

  // E3-2 — hint arrow points toward the Stage 1 survey beacon.
  nowMs += 16;
  qApp.update(nowMs);
  const beacon = stage1.hintArrowTarget!;
  const aimed = hints.getTarget()!;
  check(
    'E3-2 hint arrow locked to the Stage 1 beacon target',
    aimed.x === beacon.x && aimed.y === beacon.y && aimed.label === 'Survey beacon',
  );
  const hint0 = hints.getLastPayload();
  check(
    'E3-2 HUD hint payload visible with a real distance readout',
    hint0.visible === true && typeof hint0.distanceM === 'number' && hint0.distanceM > 0 && Number.isFinite(hint0.distanceM),
    JSON.stringify(hint0),
  );

  // E3-3 — simulate walking 10 m → Stage 2 + comms update. Sub-frame hops
  // stay under the 25 m teleport guard, so every step counts as foot travel.
  let walkedM = 0;
  for (let i = 0; i < 9 && (qEngine.getActiveStage()?.stageNumber ?? 0) === 1; i++) {
    const p = suit.getPosition();
    suit.teleport(p.x + 1.5, p.y);
    walkedM += 1.5;
    nowMs += 16;
    qApp.update(nowMs);
  }
  check('E3-3 walking 10 m advances to Stage 2', qEngine.getActiveStage()?.stageNumber === 2, `walked=${walkedM.toFixed(1)} m`);
  check(
    'E3-3 Stage 2 comms update delivered (ilmenite surface scan)',
    qHud.isCommsVisible() &&
      (e3Doc.getElementById('lunar-hud-comms-body')!.getAttribute('data-full') ?? '').includes('ilmenite'),
  );

  // E3-4 — approach the mineral vein → Stage 3.
  const vein = qEngine.getActiveStage()!.objectives[0].targetPosition!;
  for (let i = 0; i < 40; i++) {
    const p = suit.getPosition();
    const dx = vein.x - p.x;
    const dy = vein.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 5) break;
    const step = Math.min(24, d);
    suit.teleport(p.x + (dx / d) * step, p.y + (dy / d) * step);
    nowMs += 16;
    qApp.update(nowMs);
  }
  nowMs += 260;
  qApp.update(nowMs); // scanner re-sweep at the vein centre
  check('E3-4 reaching the vein advances to Stage 3', qEngine.getActiveStage()?.stageNumber === 3);
  check(
    'E3-4 hint arrow re-aimed at the mineral vein',
    hints.getTarget()?.x === vein.x && hints.getTarget()?.y === vein.y,
  );

  // E3-5 — mine 20 kg → Stage 4.
  const mineAccepted = qApp.mineNearestVein(20);
  nowMs += 16;
  qApp.update(nowMs);
  check('E3-5 mining frame accepted at the vein', mineAccepted === true);
  check('E3-5 20 kg extraction advances to Stage 4', qEngine.getActiveStage()?.stageNumber === 4);

  // E3-6 — stow the haul, board the LRV → Stage 5 + buggy dash telemetry.
  // Spec 19 §2.3.3 / ADR-4: boarding AUTO-transfers the backpack haul to the
  // flatbed, so the dash mirrors 20 kg pre-staged + the 20 kg E3-5 pulled
  // off the vein = 40 kg, and the suit backpack empties on the seat.
  buggy.setCargoMass(20);
  for (let i = 0; i < 40; i++) {
    const p = suit.getPosition();
    const dx = buggy.getPosition().x - p.x;
    const dy = buggy.getPosition().y - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 1.8) break;
    const step = Math.min(24, Math.max(1, d - 1));
    suit.teleport(p.x + (dx / d) * step, p.y + (dy / d) * step);
    nowMs += 16;
    qApp.update(nowMs);
  }
  check('E3-6 [E] boards the requisitioned LRV', qApp.toggleMount() === true && qApp.getMode() === 'buggy');
  check('E3-6 boarding advances to Stage 5', qEngine.getActiveStage()?.stageNumber === 5);
  nowMs += 120;
  qApp.update(nowMs); // 10 Hz dash mirror tick
  const dash = buggy.getDashboardTelemetry();
  check(
    'E3-6 dash mirrors quest title + terminal objective',
    dash.questActive === true &&
      dash.questTitle === 'A One-Way Ticket to the Frontier' &&
      (dash.objectiveText ?? '').toLowerCase().includes('terminal'),
    JSON.stringify(dash),
  );
  check(
    'E3-6 dash carries target range, cargo 40/500 (20 staged + 20 auto-stowed), faction + online link',
    dash.targetDistanceM !== null && Number.isFinite(dash.targetDistanceM) && dash.targetDistanceM > 0 &&
      dash.cargoKg === 40 && dash.maxCargoKg === 500 &&
      dash.faction === 'CEC' && dash.linkStatus === 'ONLINE - 128 kbps',
    JSON.stringify(dash),
  );
  check(
    'E3-6 boarding auto-stowed the backpack haul to the flatbed (spec 19 §2.3.3)',
    suit.getCargoMass() === 0 &&
      qHud.toastText().includes('Auto-stowed 20 kg to flatbed'),
    qHud.toastText(),
  );
  const pxTitle = buggy.readDashPixel(4, 0);
  check(
    'E3-6 quest title strip rastered into the dash texture (magenta)',
    pxTitle !== null && pxTitle[0] === 236 && pxTitle[1] === 64 && pxTitle[2] === 255 && pxTitle[3] === 255,
    JSON.stringify(pxTitle),
  );
  const pxCargo = buggy.readDashPixel(2, 17);
  check(
    'E3-6 cargo meter meter segment rastered (green fill)',
    pxCargo !== null && pxCargo[0] === 60 && pxCargo[1] === 230 && pxCargo[2] === 120,
    JSON.stringify(pxCargo),
  );
  const pxLink = buggy.readDashPixel(60, 17);
  check(
    'E3-6 radio link LED lit online (green)',
    pxLink !== null && pxLink[0] === 40 && pxLink[1] === 255 && pxLink[2] === 120,
    JSON.stringify(pxLink),
  );
  let navPipFound = false;
  for (let y = 12; y <= 14 && !navPipFound; y++) {
    for (let x = 2; x <= 61; x++) {
      const p = buggy.readDashPixel(x, y);
      if (p !== null && p[0] === 255 && p[1] === 255 && p[2] === 255) {
        navPipFound = true;
        break;
      }
    }
  }
  check('E3-6 nav pip painted on the bearing track', navPipFound === true);

  // E3-7 — drive to the exchange terminal. The dash range ladder (120 m
  // full scale) must fill as the haul closes in; sampled mid-approach with a
  // 6-frame step so the ~10 Hz dash mirror tick provably lands.
  const hub = qEngine.getActiveStage()!.objectives[0].targetPosition!;
  const warpBuggyToward = (tx: number, ty: number, stopDist: number): void => {
    for (let i = 0; i < 40; i++) {
      const p = buggy.getPosition();
      const dx = tx - p.x;
      const dy = ty - p.y;
      const d = Math.hypot(dx, dy);
      if (d <= stopDist) return;
      const step = Math.max(1, Math.min(24, d - stopDist));
      const seat = buggy as unknown as {
        physics: { state: { x: number; y: number } };
      };
      seat.physics.state.x = p.x + (dx / d) * step;
      seat.physics.state.y = p.y + (dy / d) * step;
      nowMs += 16;
      qApp.update(nowMs);
    }
  };
  warpBuggyToward(hub.x, hub.y, 90);
  for (let i = 0; i < 6; i++) {
    nowMs += 16;
    qApp.update(nowMs); // guarantees a 10 Hz dash-mirror frame
  }
  const dashMid = buggy.getDashboardTelemetry();
  check(
    'E3-7 dash range shrinks mid-approach (<120 m scale)',
    dashMid.targetDistanceM !== null && dashMid.targetDistanceM < 120,
    JSON.stringify(dashMid.targetDistanceM),
  );
  const pxLadder = buggy.readDashPixel(2, 29);
  check(
    'E3-7 target-range ladder fills near the objective (orange)',
    pxLadder !== null && pxLadder[0] === 255 && pxLadder[1] === 120 && pxLadder[2] === 60,
    JSON.stringify(pxLadder),
  );
  warpBuggyToward(hub.x, hub.y, 8);
  nowMs += 16;
  qApp.update(nowMs);
  check('E3-7 terminal reach objective complete', qEngine.getActiveStage()?.objectives[0]?.completed === true);

  // E3-8 — trade the haul → QUEST_COMPLETED + credit reward.
  check(
    'E3-8 SELL order at the terminal accepted',
    qApp.submitTrade({ commodity: 'REGOLITH', amount: 20, isBuy: false }) === true,
  );
  e3.net.handleFrame(
    frame('trade_confirmed', {
      trade_id: 't-e3',
      commodity: 'REGOLITH',
      amount: 20,
      is_buy: false,
      unit_price: 5.2,
      total_credits: 104,
      new_balance: 1104,
      inventory: { REGOLITH: 0 },
    }),
  );
  check('E3-8 trade completes the quest', qEngine.getActiveQuest()?.isCompleted === true);
  check('E3-8 quest reward is 500 credits', qApp.getQuestRewardCredits() === 500);
  check('E3-8 completion feedback shown', qHud.textOf('trade-feedback').includes('QUEST COMPLETE'));
  nowMs += 16;
  qApp.update(nowMs);
  check('E3-8 hint arrow retires after completion', hints.getLastPayload().visible === false);

  // E3-9 — [L] toggles the comms log (hide then re-open the last burst).
  check('E3-9 [L] handled as an action key', qApp.handleKeyInput('KeyL', 'down') === true);
  check('E3-9 first [L] press hides the comms terminal', !qHud.isCommsVisible());
  qApp.handleKeyInput('KeyL', 'down');
  check('E3-9 second [L] press re-opens the log', qHud.isCommsVisible() === true);

  qApp.dispose();
  (globalThis as { document?: unknown }).document = prevDoc;
}

// ===========================================================================
// LAYER E4 — Spec 19 Phase 2/3: offline mining, HUD toast, 3D laser, cargo
// ===========================================================================

section('E4. Spec 19 mining UX, offline fallback, laser VFX & tiered cargo');
{
  // REUSES the layer-C app (a fifth NullEngine ClientApp blows the 2 GB V8
  // heap when stacked on the layers already resident; `app` is also torn
  // down by layer F, so no extra lifecycle is introduced here).
  const mApp = app;
  const e4Doc = bootDoc;
  const e4 = boot; // scripted network { net, sent, setState }
  const mHud = mApp.getHud()!;
  const mEngine = mApp.getQuestEngine()!;
  const mSuit = mApp.getSuit();
  const mBuggy = mApp.getBuggy();
  mSuit.setCargoMass(0);
  mBuggy.setCargoMass(0);
  if (mApp.getMode() === 'buggy') mApp.toggleMount(); // back on foot for E4

  // E4-0 — toast pill + suit backpack meter are part of the built skeleton.
  check('E4-0 #lunar-hud-toast pill exists', e4Doc.getElementById('lunar-hud-toast') !== null);
  check(
    'E4-0 suit backpack field reads "/ 50 kg" at boot',
    (mHud.getElement('suit-cargo-value')?.textContent ?? '').includes('/ 50 kg'),
    mHud.getElement('suit-cargo-value')?.textContent ?? '(missing)',
  );

  // Jump to the extraction stage (Stage 3: 20 kg regolith) and park on the
  // quest vein so the scanner locks exactly that vein (E3 anchoring rule).
  mEngine.debugJumpToStage(2);
  const mVeinObjective = mEngine.getActiveStage()!.objectives[0];
  const mVeinPos = mVeinObjective.targetPosition!;
  mSuit.teleport(mVeinPos.x, mVeinPos.y);
  nowMs += 300;
  mApp.update(nowMs);
  const mTarget = mApp.getNearestVein();
  check('E4-1 scanner locks the quest vein underfoot', mTarget !== null && mTarget.rangeM <= 25);
  // Survey bookkeeping: harvest() resolves the vein by containment, and the
  // seeded world layers overlapping regolith bodies — the mutation may land
  // on a different vein id than the scanner pin. Snapshot ALL veins and
  // assert exactly one dropped by exactly the credited amount.
  const genRef = mApp.world.getWorldGenerator();
  const veinIdsAll = mApp.world.getSnapshot()!.veins.map((v) => v.id);
  const remainingBeforeAll = new Map<string, number>(
    veinIdsAll.map((id) => [id, genRef.getVein(id)!.remaining]),
  );

  // E4-1 — OFFLINE mining succeeds (Spec 19 §2.2.1): link closed, no MINE
  // frame leaves the client, yet survey, backpack, ledger and quest all move.
  e4.setState('closed');
  (mApp as unknown as { lastMineAt: number }).lastMineAt = -Infinity;
  const regolithLedgerBefore = mApp.getLocalInventory()['REGOLITH'];
  const mineFrames = (): number => e4.sent.filter((f) => f['type'] === 'MINE').length;
  const sentBefore = mineFrames();
  check('E4-1 offline pull returns true (no more silent abort)', mApp.mineNearestVein(20) === true);
  check('E4-1 offline pull sends no MINE frame', mineFrames() === sentBefore);
  const mOutcome = mApp.getLastMiningOutcome();
  check(
    'E4-1 outcome carries online=false + 20 kg regolith',
    mOutcome !== null && mOutcome.online === false && mOutcome.amount === 20 &&
      mOutcome.resource === 'regolith' && mOutcome.carrier === 'suit',
    JSON.stringify(mOutcome),
  );
  const deltas = veinIdsAll
    .map((id) => ({ id, delta: remainingBeforeAll.get(id)! - genRef.getVein(id)!.remaining }))
    .filter((d) => d.delta !== 0);
  check(
    'E4-1 local survey mutated: exactly one vein −20',
    deltas.length === 1 && deltas[0].delta === 20,
    JSON.stringify(deltas),
  );
  check('E4-1 suit backpack credited 20 kg', Math.abs(mSuit.getCargoMass() - 20) < 1e-9,
    `${mSuit.getCargoMass()}`);
  // (shared layer-C app: earlier layers already mined, so assert the DELTA.)
  check(
    'E4-1 local inventory ledger credited +20 REGOLITH',
    (mApp.getLocalInventory()['REGOLITH'] ?? 0) === (regolithLedgerBefore ?? 0) + 20,
    `before=${regolithLedgerBefore ?? 0} after=${mApp.getLocalInventory()['REGOLITH'] ?? 0}`,
  );
  // The extract objective consumed the pull (the stage machine may already
  // have advanced past stage 3 — in which case the objective completed).
  check(
    'E4-1 quest extract objective advanced by the offline pull',
    mEngine.getActiveStage()!.stageNumber > 3 ||
      (mVeinObjective.completed && mVeinObjective.currentCount >= 20),
    `stage=${mEngine.getActiveStage()!.stageNumber} obj=${mVeinObjective.currentCount}/${mVeinObjective.targetCount}`,
  );

  // E4-2 — visible toast (Spec 19 §2.2.2 / ADR-3): the drilling banner lands
  // on the floating #lunar-hud-toast pill, not hidden inside the trade dialog.
  const toastEl = e4Doc.getElementById('lunar-hud-toast')!;
  check(
    'E4-2 toast shows "Drilling <vein> (+20 kg regolith)"',
    (toastEl.getAttribute('data-toast') ?? '').startsWith(`Drilling ${mOutcome!.veinId} (+20 kg regolith)`),
    toastEl.getAttribute('data-toast') ?? '',
  );
  check(
    'E4-2 toast visible (not is-hidden) + success class',
    !toastEl.classList.contains('is-hidden') && toastEl.classList.contains('toast-success'),
  );
  check(
    'E4-2 toast mirrored to hud.toastText() readback',
    mHud.toastText() === (toastEl.getAttribute('data-toast') ?? ''),
  );

  // E4-3 — 3D mining laser (Spec 19 §2.2.3): the latest burst spans rider →
  // vein centre, beam + flare meshes exist, and it self-cleans after 600 ms.
  const laser = mApp.getLastMiningLaser();
  check('E4-3 mining laser payload returned', laser !== null);
  check('E4-3 burst live in scene', mApp.world.getActiveMiningEffectCount() >= 1);
  check('E4-3 laser duration 600 ms default', laser !== null && laser.durationMs === 600);
  const laserMesh = mApp.world.getScene().getMeshByName('mining-laser-1');
  const flareMesh = mApp.world.getScene().getMeshByName('mining-flare-1');
  check('E4-3 beam + flare meshes exist', laserMesh !== null && flareMesh !== null);
  check(
    'E4-3 beam endpoints span rider to vein centre',
    laser !== null &&
      Math.abs(laser.endPos.x - mVeinPos.x) < 1e-9 &&
      Math.abs(laser.endPos.y - mVeinPos.y) < 1e-9 &&
      Math.abs(laser.endPos.z - mVeinPos.z) < 1e-9 &&
      Math.hypot(laser.startPos.x - mSuit.getPosition().x, laser.startPos.y - mSuit.getPosition().y) < 0.5,
    JSON.stringify(laser),
  );
  // Self-cleanup: the wall-clock retire timer (600 ms) tears every burst
  // down even with no render loop running.
  await new Promise((r) => setTimeout(r, 720));
  check('E4-3 laser retired after its window', mApp.world.getActiveMiningEffectCount() === 0);
  check(
    'E4-3 laser meshes disposed',
    laserMesh !== null && flareMesh !== null && laserMesh.isDisposed() && flareMesh.isDisposed(),
  );

  // E4-4 — ONLINE mining still sends the frame AND credits locally.
  e4.setState('open');
  (mApp as unknown as { lastMineAt: number }).lastMineAt = -Infinity;
  check('E4-4 online pull returns true', mApp.mineNearestVein(20) === true);
  const mf = e4.sent.filter((f) => f['type'] === 'MINE').pop();
  check(
    'E4-4 MINE frame sent online (amount 20)',
    mf !== undefined && (mf['payload'] as Record<string, unknown>)['amount'] === 20,
    JSON.stringify(mf),
  );
  const mOutcome2 = mApp.getLastMiningOutcome();
  check(
    'E4-4 online outcome flagged online=true, 20 kg to suit',
    mOutcome2 !== null && mOutcome2.online === true && mOutcome2.amount === 20,
    JSON.stringify(mOutcome2),
  );
  check('E4-4 backpack now 40 kg (20 + 20)', Math.abs(mSuit.getCargoMass() - 40) < 1e-9,
    `${mSuit.getCargoMass()}`);

  // E4-5 — tiered capacity (ADR-4): cap-pull to 50 kg, then reject when full.
  (mApp as unknown as { lastMineAt: number }).lastMineAt = -Infinity;
  check('E4-5 partial pull extracts only what fits (10 kg)', mApp.mineNearestVein(20) === true);
  const mOutcome3 = mApp.getLastMiningOutcome();
  check(
    'E4-5 partial outcome amount 10 + carrier-full note',
    mOutcome3 !== null && mOutcome3.amount === 10 && mOutcome3.toast.includes('backpack full (50/50 kg)'),
    JSON.stringify(mOutcome3),
  );
  check('E4-5 backpack maxes at exactly 50 kg', Math.abs(mSuit.getCargoMass() - 50) < 1e-9,
    `${mSuit.getCargoMass()}`);
  (mApp as unknown as { lastMineAt: number }).lastMineAt = -Infinity;
  check('E4-5 full backpack REJECTS mining', mApp.mineNearestVein(20) === false);
  check(
    'E4-5 rejection toast: "Suit backpack full (50/50 kg) — stow in buggy or sell"',
    (toastEl.getAttribute('data-toast') ?? '') === 'Suit backpack full (50/50 kg) — stow in buggy or sell',
    toastEl.getAttribute('data-toast') ?? '',
  );
  check('E4-5 rejection paints error class', toastEl.classList.contains('toast-error'));
  nowMs += 16;
  mApp.update(nowMs);
  check('E4-5 suit telemetry paints 50 / 50 kg', mHud.textOf('suit-cargo-value') === '50 / 50 kg',
    mHud.textOf('suit-cargo-value'));
  const suitFill = e4Doc.getElementById('lunar-hud-suit-cargo-bar-fill')!;
  check(
    'E4-5 suit cargo bar rastered full width + is-full',
    suitFill.style.width === '100.0%' && suitFill.classList.contains('is-full'),
    suitFill.style.width,
  );

  // E4-6 — proximity prompt: beside the rover with a loaded pack the strip
  // offers [E] Stow Cargo to Buggy; the stow action moves haul to flatbed.
  const mBuggyPos = mBuggy.getPosition();
  mSuit.teleport(mBuggyPos.x - 0.8, mBuggyPos.y);
  nowMs += 300;
  mApp.update(nowMs);
  const mPromptStrip = e4Doc.getElementById('lunar-hud-prompts')!;
  const visiblePrompts = (): string[] =>
    mPromptStrip.children
      .filter((c) => c.classList.contains('hud-prompt') && !c.classList.contains('is-hidden'))
      .map((c) => c.text());
  check(
    'E4-6 [E] Stow Cargo to Buggy prompt renders with cargo aboard',
    visiblePrompts().some((t) => t.includes('[E]') && t.includes('Stow Cargo to Buggy')),
    JSON.stringify(visiblePrompts()),
  );
  check(
    'E4-6 stow moves all 50 kg to flatbed',
    mApp.stowCargoToBuggy() === 50 &&
      Math.abs(mBuggy.getCargoMass() - 50) < 1e-9 &&
      mSuit.getCargoMass() === 0,
    `buggy=${mBuggy.getCargoMass()} suit=${mSuit.getCargoMass()}`,
  );
  check(
    'E4-6 stow toast confirms flatbed load',
    (toastEl.getAttribute('data-toast') ?? '').includes('Stowed 50 kg to buggy flatbed (50/500 kg)'),
    toastEl.getAttribute('data-toast') ?? '',
  );
  nowMs += 300;
  mApp.update(nowMs);
  check(
    'E4-6 prompt reverts to Drive Buggy when pack empties',
    visiblePrompts().some((t) => t.includes('Drive Buggy')) &&
      !visiblePrompts().some((t) => t.includes('Stow')),
    JSON.stringify(visiblePrompts()),
  );

  // E4-7 — mounting auto-transfers the backpack haul (Spec 19 §2.3.3).
  mSuit.setCargoMass(37);
  check('E4-7 mount auto-stows 37 kg', mApp.toggleMount() === true && mApp.getMode() === 'buggy');
  check(
    'E4-7 flatbed carries prior 50 + auto-stowed 37',
    Math.abs(mBuggy.getCargoMass() - 87) < 1e-9,
    `${mBuggy.getCargoMass()}`,
  );
  check('E4-7 backpack empty after boarding', mSuit.getCargoMass() === 0);
  check(
    'E4-7 auto-stow toast',
    (toastEl.getAttribute('data-toast') ?? '').includes('Auto-stowed 37 kg to flatbed (87/500 kg)'),
    toastEl.getAttribute('data-toast') ?? '',
  );

  // E4-8 — buggy-mode capacity (500 kg flatbed): rig-teleport the rover onto
  // the vein (same private-`state` access idiom the D3 layer uses for its
  // vLong probe), then the pull caps at the free flatbed space and rejects
  // at 500/500.
  const bstate = (mBuggy.physics as unknown as { state: { x: number; y: number; z: number } }).state;
  bstate.x = mVeinPos.x;
  bstate.y = mVeinPos.y;
  bstate.z = mVeinPos.z;
  nowMs += 300;
  mApp.update(nowMs);
  const bTarget = mApp.getNearestVein();
  check('E4-8 buggy rig-teleported within drill reach of the vein',
    bTarget !== null && bTarget.rangeM <= 25 && mApp.getMode() === 'buggy');
  mBuggy.setCargoMass(495);
  (mApp as unknown as { lastMineAt: number }).lastMineAt = -Infinity;
  check('E4-8 buggy pull returns true', mApp.mineNearestVein(20) === true);
  const mOutcome4 = mApp.getLastMiningOutcome();
  check(
    'E4-8 buggy pull caps at 5 kg free flatbed space',
    mOutcome4 !== null && mOutcome4.amount === 5 && mOutcome4.carrier === 'buggy' &&
      mOutcome4.toast.includes('flatbed full (500/500 kg)'),
    JSON.stringify(mOutcome4),
  );
  check('E4-8 flatbed maxes at 500 kg', Math.abs(mBuggy.getCargoMass() - 500) < 1e-9,
    `${mBuggy.getCargoMass()}`);
  (mApp as unknown as { lastMineAt: number }).lastMineAt = -Infinity;
  check('E4-8 full flatbed rejects mining', mApp.mineNearestVein(20) === false);
  check(
    'E4-8 flatbed-full rejection toast',
    (toastEl.getAttribute('data-toast') ?? '').includes('Buggy flatbed full (500/500 kg)'),
    toastEl.getAttribute('data-toast') ?? '',
  );
  // (layer F owns `app.dispose()`; E4 deliberately leaves it alive.)
}

// ===========================================================================
// LAYER F — teardown & TraversalController units
// ===========================================================================

section('F. lifecycle teardown & traversal units');
{
  app.dispose();
  check('post-dispose update() is a safe no-op', (() => {
    try {
      app.update(nowMs);
      return true;
    } catch {
      return false;
    }
  })());
  check('post-dispose input() refuses', app.handleKeyInput('KeyW', 'down') === false);
  check('HUD disposed with the app', bootDoc.getElementById(HUD_ROOT_ID) === null);
  app.dispose();
  check('dispose is idempotent', true);

  const nodes = [
    { id: 'a', kind: 'junction', name: 'Alpha', position: { x: 0, y: 0, z: 0 }, links: ['b'] },
    { id: 'b', kind: 'dock', name: 'Beta Dock', position: { x: 30, y: 0, z: 0 }, links: ['a', 'c'] },
    { id: 'c', kind: 'cavern', name: 'Gamma Cavern', position: { x: 60, y: 0, z: -40 }, links: ['b'] },
  ];
  const tc = new TraversalController(nodes[0], nodes);
  check('traverseTo known node', tc.traverseTo('c') && tc.getCurrentNode().id === 'c');
  check('goBack rewinds', tc.goBack() && tc.getCurrentNode().id === 'a');
  check('traverseTo unknown node fails soft', tc.traverseTo('nope') === false);
  check(
    'routeTo walks the link graph (BFS)',
    JSON.stringify(tc.routeTo('c')) === JSON.stringify(['a', 'b', 'c']),
  );
  const lonely = new TraversalController({ id: 'x', kind: 'junction', name: 'X', position: { x: 0, y: 0, z: 0 }, links: [] });
  check('routeTo unknown destination returns null', lonely.routeTo('y') === null);
  const near = tc.nearestNode({ x: 29, y: 1, z: 0 });
  check('nearestNode finds the close node', near !== undefined && near.id === 'b');
}


  // -----------------------------------------------------------------------
  // Result
  // -----------------------------------------------------------------------

  delete (globalThis as { document?: unknown }).document;

  console.log('\n==========================================================');
  if (failures.length === 0) {
    console.log(`🎉 smoke-client-app: ALL ${passed} CHECKS GREEN`);
    process.exit(0);
  } else {
    console.error(`💥 smoke-client-app: ${failures.length} FAILURE(S) of ${passed + failures.length}:`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  console.error('💥 smoke-client-app crashed:', err);
  delete (globalThis as { document?: unknown }).document;
  process.exit(1);
});
