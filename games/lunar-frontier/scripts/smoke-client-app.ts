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

import { ClientApp } from '../src/client/ClientApp.ts';
import { TraversalController } from '../src/client/TraversalController.ts';
import NetworkClient from '../src/network/NetworkClient.ts';
import LunarHUD, { HUD_ROOT_ID, HUD_TRADE_ID } from '../src/ui/LunarHUD.ts';

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
  const el: FakeElement = {
    id: '',
    className: tagName,
    textContent: '',
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
    'WASD + Shift latch into the input frame',
    sampled.forward === 1 && sampled.strafe === -1 && sampled.sprint === true,
  );
  app.handleKeyInput('KeyW', 'up');
  app.handleKeyInput('KeyD', 'up');
  app.handleKeyInput('ShiftLeft', 'up');
  check(
    'key-up unlatches',
    app.sampleInput().forward === 0 && app.sampleInput().sprint === false,
  );
  check('unknown codes report unhandled', app.handleKeyInput('KeyQ', 'down') === false);

  // [E] out of range → refused; walk over to the buggy → accepted.
  check('[E] refuses to mount a distant buggy', app.toggleMount() === false && app.getMode() === 'suit');

  const buggyPos = app.getBuggy().getPosition();
  app.getSuit().teleport(buggyPos.x - 1, buggyPos.y);
  check('suit is within mount radius', app.getBuggy().canMount(app.getSuit()));
  check('[E] mounts the buggy', app.toggleMount() === true && app.getMode() === 'buggy');
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
