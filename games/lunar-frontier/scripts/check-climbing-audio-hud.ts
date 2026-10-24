/**
 * Spec 29 Phase 5 verification: Procedural Audio, Comms Landmark Telemetry &
 * HUD Elevation Meter.
 * Run: `npx tsx scripts/check-climbing-audio-hud.ts`  (exit code 0 == all green)
 *
 * Headless (fake DOM + mock Web Audio + NullEngine), three layers:
 *
 *   A. `LunarAudioSystem` climbing voices — pre-init safety, latch clang /
 *      rung-step click / summit chime execute without throwing, cue counts
 *      and timestamps book-keep, post-dispose silences.
 *   B. `LunarHUD` climbing altimeter — `#lunar-hud-climb` DOM creation,
 *      `ClimbingTelemetry` formatting law ("ALT +42.5m [DECK 48m]",
 *      "+2.2 m/s", HOLD band), latch chip, near-deck band, hide/show
 *      transitions on null, landmark banner + clear, post-dispose safety.
 *   C. `ClientApp` integration — a REAL NullEngine app with a built radio
 *      tower: proximity altimeter frames, "FRONTIER RELAY 04" landmark
 *      recognition (once per approach, hysteresis re-arm), [E] latch clang,
 *      0.35 s rung-step cadence while climbing with |vz| > 0.1, mechanical
 *      HOLD, deck-summit step-off → summit chime + observation-deck banner,
 *      ladder release clang, telemetry retraction on walk-away, clean
 *      disposal.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';

import {
  LunarAudioSystem,
  LADDER_LATCH_CLANG_HZ,
  LADDER_STEP_CLICK_HZ,
  LADDER_STEP_CADENCE_S,
  SUMMIT_CHIME_LOW_HZ,
  SUMMIT_CHIME_HIGH_HZ,
} from '../src/audio/LunarAudioSystem.ts';
import {
  LunarHUD,
  HUD_CLIMB_ID,
  HUD_LANDMARK_ID,
  HUD_CLIMB_HOLD_EPS,
  formatClimbAltitude,
  formatClimbRate,
} from '../src/ui/LunarHUD.ts';
import { ClientApp } from '../src/client/ClientApp.ts';

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
const section = (t: string): void => console.log(`\n=== ${t} ===`);

// ---------------------------------------------------------------------------
// Fake DOM (same structural subset as smoke-heist-hud-audio / smoke-client-app)
// ---------------------------------------------------------------------------

interface FakeElement {
  id: string;
  className: string;
  textContent: string | null;
  style: Record<string, string>;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  };
  children: FakeElement[];
  parent: FakeElement | null;
  attributes: Map<string, string>;
  listeners: Map<string, Array<(event: unknown) => void>>;
  appendChild<T>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  dispatchEvent(type: string, event: unknown): void;
}

function makeFakeElement(tag: string, registry: Map<string, FakeElement>): FakeElement {
  const attributes = new Map<string, string>();
  const children: FakeElement[] = [];
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const el: FakeElement = {
    id: '',
    className: '',
    textContent: null,
    style: {},
    classList: {
      add(name) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        set.add(name);
        el.className = [...set].join(' ');
      },
      remove(name) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        set.delete(name);
        el.className = [...set].join(' ');
      },
      contains(name) {
        return el.className.split(/\s+/).includes(name);
      },
    },
    children,
    parent: null,
    attributes,
    listeners,
    appendChild(child) {
      (child as FakeElement).parent = el;
      children.push(child as FakeElement);
      return child;
    },
    remove() {
      if (el.parent !== null) {
        const idx = el.parent.children.indexOf(el);
        if (idx >= 0) el.parent.children.splice(idx, 1);
      }
      registry.delete(el.id);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
      if (name === 'id') {
        el.id = value;
        registry.set(value, el);
      }
    },
    addEventListener(type, listener) {
      const arr = listeners.get(type) ?? [];
      arr.push(listener);
      listeners.set(type, arr);
    },
    dispatchEvent(type, event) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
  void tag;
  return el;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  const body = makeFakeElement('body', registry);
  return {
    body,
    registry,
    createElement: (tag: string) => makeFakeElement(tag, registry),
    getElementById: (id: string) => registry.get(id) ?? null,
    addEventListener: (_type: string, _fn: unknown) => {
      /* page-level keys parked — ClientApp drives handleKeyInput directly */
    },
  };
}

type FakeDoc = ReturnType<typeof makeFakeDocument>;

/** Element text via the id registry (headless DOMs have no CSS). */
function textOfDoc(doc: FakeDoc, id: string): string {
  return doc.getElementById(id)?.textContent ?? '';
}
function hasClassDoc(doc: FakeDoc, id: string, cls: string): boolean {
  return doc.getElementById(id)?.classList.contains(cls) ?? false;
}
function attrOfDoc(doc: FakeDoc, id: string, name: string): string {
  return doc.getElementById(id)?.getAttribute(name) ?? '';
}

// ===========================================================================
// A. LunarAudioSystem — Spec 29 climbing voices
// ===========================================================================

async function sectionA(): Promise<void> {
  section('A. LunarAudioSystem — ladder latch / rung step / summit chime (mock ctx)');
  {
  const audio = new LunarAudioSystem();

  // Pre-init: every climbing voice is a silent, throw-free no-op.
  let preInitThrew = false;
  try {
    audio.playLadderLatch();
    audio.playLadderStep();
    audio.playSummitChime();
  } catch {
    preInitThrew = true;
  }
  const pre = audio.getClimbingCueTimes();
  check('pre-init climbing voices are silent no-ops (no throw, zero counts)',
    !preInitThrew && pre.latchCount === 0 && pre.stepCount === 0 && pre.chimeCount === 0);

  await audio.init();
  check('audio graph initialised headless on the mock context',
    audio.isInitialized() && audio.isHeadless());

  // Fire the three voices twice each — must never throw, must book-keep.
  let threw = false;
  try {
    audio.playLadderLatch();
    audio.playLadderStep();
    audio.playSummitChime();
    audio.playLadderLatch();
    audio.playLadderStep();
    audio.playSummitChime();
  } catch {
    threw = true;
  }
  const cues = audio.getClimbingCueTimes();
  check('playLadderLatch / playLadderStep / playSummitChime execute without throwing', !threw);
  check('cue counters book-keep every call (2 latch, 2 step, 2 chime)',
    cues.latchCount === 2 && cues.stepCount === 2 && cues.chimeCount === 2,
    JSON.stringify(cues));
  check('cue timestamps stamped (past the −∞ before-first sentinel)',
    cues.latchAt > Number.NEGATIVE_INFINITY &&
    cues.stepAt > Number.NEGATIVE_INFINITY &&
    cues.chimeAt > Number.NEGATIVE_INFINITY);

  // Canonical Spec 29 §4.2.3 tone law exposed for harnesses.
  check('canonical tone law: 180 Hz clang, 240 Hz click, 0.35 s cadence, 880→1320 chime',
    LADDER_LATCH_CLANG_HZ === 180 &&
    LADDER_STEP_CLICK_HZ === 240 &&
    LADDER_STEP_CADENCE_S === 0.35 &&
    SUMMIT_CHIME_LOW_HZ === 880 &&
    SUMMIT_CHIME_HIGH_HZ === 1320);

  audio.dispose();
  let postThrew = false;
  try {
    audio.playLadderLatch();
    audio.playLadderStep();
    audio.playSummitChime();
  } catch {
    postThrew = true;
  }
  const post = audio.getClimbingCueTimes();
  check('post-dispose climbing voices silence without throwing',
    !postThrew && post.latchCount === 0 && post.stepCount === 0 && post.chimeCount === 0);
  audio.dispose();
  check('dispose idempotent', audio.isDisposed());
}

}

// ===========================================================================
// B. LunarHUD — climbing altimeter + landmark banner
// ===========================================================================

async function sectionB(): Promise<void> {
  section('B. LunarHUD — altimeter panel, formatting law, hide/show transitions');
  {
  const doc = makeFakeDocument();
  const hud = new LunarHUD({ document: doc as never });

  check(`altimeter panel #${HUD_CLIMB_ID} built in the DOM`,
    doc.getElementById(HUD_CLIMB_ID) !== null);
  check(`landmark banner #${HUD_LANDMARK_ID} built in the DOM`,
    doc.getElementById(HUD_LANDMARK_ID) !== null);
  check('altimeter starts retracted (is-hidden)', hasClassDoc(doc, HUD_CLIMB_ID, 'is-hidden'));
  check('landmark banner starts retracted (is-hidden)', hasClassDoc(doc, HUD_LANDMARK_ID, 'is-hidden'));

  // -- formatting law (Spec 29 §4.2) ------------------------------------------
  check('formatClimbAltitude(42.5, 48) == "ALT +42.5m [DECK 48m]"',
    formatClimbAltitude(42.5, 48) === 'ALT +42.5m [DECK 48m]',
    formatClimbAltitude(42.5, 48));
  check('formatClimbAltitude(-3.24, 48) == "ALT -3.2m [DECK 48m]"',
    formatClimbAltitude(-3.24, 48) === 'ALT -3.2m [DECK 48m]',
    formatClimbAltitude(-3.24, 48));
  check('formatClimbAltitude(NaN, NaN) collapses to zero datum',
    formatClimbAltitude(Number.NaN, Number.NaN) === 'ALT +0.0m [DECK 0m]',
    formatClimbAltitude(Number.NaN, Number.NaN));
  check('formatClimbRate(2.2) == "+2.2 m/s"', formatClimbRate(2.2) === '+2.2 m/s', formatClimbRate(2.2));
  check('formatClimbRate(-1.5) == "-1.5 m/s"', formatClimbRate(-1.5) === '-1.5 m/s', formatClimbRate(-1.5));
  check(`formatClimbRate(0) and (±eps) collapse to HOLD (band ${HUD_CLIMB_HOLD_EPS})`,
    formatClimbRate(0) === 'HOLD' &&
    formatClimbRate(HUD_CLIMB_HOLD_EPS) === 'HOLD' &&
    formatClimbRate(-HUD_CLIMB_HOLD_EPS) === 'HOLD');

  // -- setClimbingTelemetry transitions ---------------------------------------
  hud.setClimbingTelemetry({ altitudeM: 42.5, deckElevationM: 48, climbRateMps: 2.2, isLatched: true });
  check('telemetry frame reveals the panel (is-hidden removed)',
    !hasClassDoc(doc, HUD_CLIMB_ID, 'is-hidden'));
  check('altimeter text reads "ALT +42.5m [DECK 48m]"',
    textOfDoc(doc, 'hud-climb-alt-value') === 'ALT +42.5m [DECK 48m]',
    textOfDoc(doc, 'hud-climb-alt-value'));
  check('vertical speed reads "+2.2 m/s" without the HOLD class',
    textOfDoc(doc, 'hud-climb-vs-value') === '+2.2 m/s' &&
    !hasClassDoc(doc, 'hud-climb-vs-value', 'is-hold'),
    textOfDoc(doc, 'hud-climb-vs-value'));
  check('latch chip reads LATCHED with is-latched class',
    textOfDoc(doc, 'hud-climb-latch') === 'LATCHED' &&
    hasClassDoc(doc, 'hud-climb-latch', 'is-latched'));
  check('data-* mirrors mirror the frame (alt/deck/vs/latched)',
    attrOfDoc(doc, HUD_CLIMB_ID, 'data-alt') === '42.5' &&
    attrOfDoc(doc, HUD_CLIMB_ID, 'data-deck') === '48.0' &&
    attrOfDoc(doc, HUD_CLIMB_ID, 'data-vs') === '2.2' &&
    attrOfDoc(doc, HUD_CLIMB_ID, 'data-latched') === '1',
    `${attrOfDoc(doc, HUD_CLIMB_ID, 'data-alt')}/${attrOfDoc(doc, HUD_CLIMB_ID, 'data-deck')}`);
  check('readback getClimbingTelemetry returns the painted frame',
    hud.getClimbingTelemetry()?.altitudeM === 42.5);

  hud.setClimbingTelemetry({ altitudeM: 47.2, deckElevationM: 48, climbRateMps: 0, isLatched: false });
  check('zero rate renders HOLD with is-hold class',
    textOfDoc(doc, 'hud-climb-vs-value') === 'HOLD' &&
    hasClassDoc(doc, 'hud-climb-vs-value', 'is-hold'));
  check('near-deck band (within 2 m) lights is-near-deck',
    hasClassDoc(doc, HUD_CLIMB_ID, 'is-near-deck'));
  check('unlatched chip falls back to FREE', textOfDoc(doc, 'hud-climb-latch') === 'FREE' &&
    !hasClassDoc(doc, 'hud-climb-latch', 'is-latched'));

  hud.setClimbingTelemetry(null);
  check('null telemetry cleanly hides the panel via is-hidden',
    hasClassDoc(doc, HUD_CLIMB_ID, 'is-hidden') && hud.getClimbingTelemetry() === null);
  check('null telemetry clears the data-* mirrors',
    attrOfDoc(doc, HUD_CLIMB_ID, 'data-alt') === '' &&
    attrOfDoc(doc, HUD_CLIMB_ID, 'data-latched') === '');

  // Re-show after a hide: transition is idempotent both directions.
  hud.setClimbingTelemetry({ altitudeM: 10, deckElevationM: 48, climbRateMps: -2.2, isLatched: true });
  check('panel re-shows after a hide (descending frame, "-2.2 m/s")',
    !hasClassDoc(doc, HUD_CLIMB_ID, 'is-hidden') &&
    textOfDoc(doc, 'hud-climb-vs-value') === '-2.2 m/s');

  // -- landmark banner ----------------------------------------------------------
  hud.showLandmarkArrival('Frontier Relay 04');
  check('showLandmarkArrival floats the banner with upper-cased title',
    textOfDoc(doc, 'hud-landmark-title') === 'FRONTIER RELAY 04' &&
    !hasClassDoc(doc, HUD_LANDMARK_ID, 'is-hidden'));
  check('banner mirrors into data-landmark + landmarkText() readback',
    attrOfDoc(doc, HUD_LANDMARK_ID, 'data-landmark') === 'FRONTIER RELAY 04' &&
    hud.landmarkText() === 'FRONTIER RELAY 04');
  hud.clearLandmarkArrival();
  check('clearLandmarkArrival retracts the banner',
    hasClassDoc(doc, HUD_LANDMARK_ID, 'is-hidden') && hud.landmarkText() === '');

  hud.dispose();
  let postThrew = false;
  try {
    hud.setClimbingTelemetry({ altitudeM: 1, deckElevationM: 48, climbRateMps: 0, isLatched: false });
    hud.showLandmarkArrival('ghost');
    hud.clearLandmarkArrival();
  } catch {
    postThrew = true;
  }
  check('post-dispose HUD surface is throw-free', postThrew === false && hud.isDisposed());
}

}

// ===========================================================================
// C. ClientApp integration — real NullEngine app, real radio tower
// ===========================================================================

async function sectionC(): Promise<void> {
  section('C. ClientApp — climb simulation: latch clang, cadence, HOLD, summit chime');
  {
  const doc = makeFakeDocument();
  (globalThis as { document?: unknown }).document = doc;

  const app = new ClientApp({
    seed: 'spec29-phase5-hunt',
    username: 'rungjockey',
    faction: 'ARTEMIS',
    silent: true,
    autoConnect: false,
  });
  await app.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));
  check('ClientApp initialised (NullEngine, no network)', app.isInitialized());

  const tower = app.world.buildRadioTower();
  check('radio tower built into the world scene', tower !== null);

  const hud = app.getHud();
  const audio = app.getAudio();
  check('HUD + audio engine injected on the app', hud !== null && audio !== null);
  if (hud === null || audio === null || tower === null) {
    failures.push('C-layer bootstrap incomplete — aborting integration checks');
  } else {
    // Spy on the comms chirp (landmark recognition jingle).
    let chirps = 0;
    const origChirp = audio.playCommsChirp.bind(audio);
    (audio as unknown as { playCommsChirp: (t: 'alert' | 'incoming' | 'burst') => void }).playCommsChirp = (
      t: 'alert' | 'incoming' | 'burst',
    ) => {
      chirps++;
      origChirp(t);
    };

    let nowMs = 100_000;
    const tick = (ms = 16): void => {
      nowMs += ms;
      app.update(nowMs);
    };
    const cues = () => audio.getClimbingCueTimes();
    const suit = app.getSuit();
    const B = tower.getLadderBounds();
    const seat = tower.getWorldPosition();
    const deckZ = tower.getDeckElevation();
    // Stand 0.5 m out from the ladder rung line at the base (inside the
    // 1.8 m detection cylinder, which centres on the rungs, not the seat).
    const basePoint = {
      x: B.basePosition.x + B.facingNormal.x * 0.5,
      y: B.basePosition.y + B.facingNormal.y * 0.5,
      z: B.basePosition.z,
    };
    const teleport = (x: number, y: number, z: number): void => {
      suit.setState({ x, y, z, vx: 0, vy: 0, vz: 0, isGrounded: true, locomotionMode: 'WALK' });
    };

    // -- far from the tower: altimeter retracts --------------------------------
    tick();
    tick();
    check('spawn far from the tower keeps the altimeter frame null',
      hud.getClimbingTelemetry() === null);

    // -- landmark recognition: first arrival at Relay 04 ------------------------
    teleport(basePoint.x, basePoint.y, basePoint.z);
    tick();
    const tele1 = hud.getClimbingTelemetry();
    check('arrival near the ladder base pushes a live altimeter frame',
      tele1 !== null && tele1.isLatched === false,
      JSON.stringify(tele1));
    check('altitude frames use the tower-ground datum (≈ 0 at the base)',
      tele1 !== null && Math.abs(tele1.altitudeM) < 0.7,
      `alt=${tele1?.altitudeM.toFixed(2)}`);
    check('deck readout carries the 48 m canonical elevation',
      tele1 !== null && Math.abs(tele1.deckElevationM - 48.0) < 1e-9);
    check('landmark banner announces "FRONTIER RELAY 04" on arrival',
      hud.landmarkText() === 'FRONTIER RELAY 04' &&
      !hasClassDoc(doc, HUD_LANDMARK_ID, 'is-hidden'),
      hud.landmarkText());
    check('landmark announcement chirped through the helmet comms', chirps >= 1);
    check('banner does not re-fire on subsequent frames (once per approach)',
      (() => {
        const before = chirps;
        tick();
        tick();
        return hud.landmarkText() === 'FRONTIER RELAY 04' && chirps === before;
      })());

    // -- [E] mount: magnetic boot-clamp latch clang ----------------------------
    const latchBefore = cues().latchCount;
    app.handleKeyInput('KeyE', 'down');
    app.handleKeyInput('KeyE', 'up');
    tick();
    check('[E] at the base latches the ladder',
      suit.getState().ladderLatchActive === true);
    check('latch fires playLadderLatch() exactly once',
      cues().latchCount === latchBefore + 1,
      `before=${latchBefore} after=${cues().latchCount}`);

    // -- rung-step cadence: 0.35 s while climbing with |vz| > 0.1 --------------
    app.handleKeyInput('KeyW', 'down');
    const stepBefore = cues().stepCount;
    for (let i = 0; i < 30; i++) tick(); // 0.48 s
    const stepMid = cues().stepCount - stepBefore;
    check(`~0.35 s cadence: ≥1 rung-step click in 0.48 s (got ${stepMid})`, stepMid >= 1);
    for (let i = 0; i < 45; i++) tick(); // 0.75 s more (≈1.2 s total)
    const stepTotal = cues().stepCount - stepBefore;
    check(`cadence keeps ticking: ≥3 rung-step clicks in ≈1.2 s of climb (got ${stepTotal})`,
      stepTotal >= 3);
    const st = suit.getState();
    check('climber gained altitude on the rail (z above base + 1 m)',
      st.z > B.basePosition.z + 1.0, `z=${st.z.toFixed(2)}`);

    const teleClimb = hud.getClimbingTelemetry();
    check('climbing frame: latched chip + "+2.2 m/s" tape painted on the HUD',
      teleClimb !== null &&
      teleClimb.isLatched === true &&
      textOfDoc(doc, 'hud-climb-vs-value') === '+2.2 m/s' &&
      textOfDoc(doc, 'hud-climb-alt-value') === formatClimbAltitude(teleClimb.altitudeM, 48),
      `${textOfDoc(doc, 'hud-climb-alt-value')} | ${textOfDoc(doc, 'hud-climb-vs-value')}`);

    // -- mechanical hold: neutral throttle → HOLD, cadence silent --------------
    app.handleKeyInput('KeyW', 'up');
    tick();
    tick();
    const holdTele = hud.getClimbingTelemetry();
    check('neutral throttle paints HOLD (rate 0, is-hold class)',
      holdTele !== null && Math.abs(holdTele.climbRateMps) <= 1e-9 &&
      textOfDoc(doc, 'hud-climb-vs-value') === 'HOLD' &&
      hasClassDoc(doc, 'hud-climb-vs-value', 'is-hold'));
    const stepAtHold = cues().stepCount;
    for (let i = 0; i < 30; i++) tick();
    check('holding still keeps the cadence silent (no machine-gun clicks)',
      cues().stepCount === stepAtHold);

    // -- deck summit: step-off → summit chime + observation-deck banner --------
    suit.setState({ z: deckZ - 0.6 });
    app.handleKeyInput('KeyW', 'down');
    let summitFrame = -1;
    for (let i = 0; i < 60; i++) {
      tick();
      if (!suit.getState().ladderLatchActive && suit.getState().isGrounded) {
        summitFrame = i;
        break;
      }
    }
    check('summit step-off onto the observation deck (grounded, unlatched)',
      summitFrame >= 0, `frame=${summitFrame}`);
    tick();
    const summitState = suit.getState();
    check('deck hand-off parks the suit at the deck elevation',
      Math.abs(summitState.z - deckZ) < 0.05, `z=${summitState.z.toFixed(2)} deck=${deckZ.toFixed(2)}`);
    check('deck summit rings playSummitChime()', cues().chimeCount >= 1);
    check('observation-deck landmark banner floats',
      hud.landmarkText() === 'FRONTIER RELAY 04 — OBSERVATION DECK',
      hud.landmarkText());
    const deckTele = hud.getClimbingTelemetry();
    check('deck altimeter reads "ALT +48.0m [DECK 48m]" (unlatched, HOLD)',
      deckTele !== null &&
      deckTele.isLatched === false &&
      textOfDoc(doc, 'hud-climb-alt-value') === 'ALT +48.0m [DECK 48m]' &&
      hasClassDoc(doc, HUD_CLIMB_ID, 'is-near-deck'),
      textOfDoc(doc, 'hud-climb-alt-value'));
    app.handleKeyInput('KeyW', 'up');

    // -- ladder release: release clang via [E] at the hatch --------------------
    const latchAtDeck = cues().latchCount;
    app.handleKeyInput('KeyE', 'down'); // deck-to-ladder mount (clang #1)
    app.handleKeyInput('KeyE', 'up');
    tick();
    check('deck hatch [E] re-mounts the ladder (descending)',
      suit.getState().ladderLatchActive === true && cues().latchCount === latchAtDeck + 1);
    app.handleKeyInput('KeyE', 'down'); // release (clang #2)
    app.handleKeyInput('KeyE', 'up');
    tick();
    check('ladder release also sounds the boot-clamp clang',
      suit.getState().ladderLatchActive === false && cues().latchCount === latchAtDeck + 2);

    // -- walk away: altimeter retracts, landmark re-arms ------------------------
    hud.clearLandmarkArrival();
    teleport(seat.x + 200, seat.y + 200, seat.z);
    tick();
    tick();
    check('walking away retracts the altimeter (null frame + is-hidden)',
      hud.getClimbingTelemetry() === null && hasClassDoc(doc, HUD_CLIMB_ID, 'is-hidden'));

    // Re-approach: the hysteresis re-arm announces Relay 04 a second visit.
    teleport(basePoint.x, basePoint.y, basePoint.z);
    tick();
    check('re-approach past the re-arm radius announces "FRONTIER RELAY 04" again',
      hud.landmarkText() === 'FRONTIER RELAY 04',
      hud.landmarkText());

    // -- teardown ----------------------------------------------------------------
    app.dispose();
    let postThrew = false;
    try {
      tick();
    } catch {
      postThrew = true;
    }
    check('post-dispose update() is throw-free; HUD + audio disposed',
      !postThrew && hud.isDisposed() && audio.isDisposed());
  }
}

}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await sectionA();
  await sectionB();
  await sectionC();
  console.log(`\n${failures.length === 0 ? '✅' : '❌'} ${passed}/${passed + failures.length} checks green`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`   ✘ ${f}`);
    process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  console.error('harness crashed:', err);
  process.exitCode = 1;
});
