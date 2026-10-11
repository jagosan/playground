/**
 * Spec 24 Phase 6 — consolidated headless smoke verification suite for the
 * first-time arrival experience (transport flight, orbital descent & landing).
 *
 * Runs entirely on a NullEngine (no DOM canvas, no WebGL) and consolidates the
 * per-phase harnesses (intro-director / hud-fx / walkout / replay) into one
 * end-to-end suite. Verifies:
 *
 *   a) State Machine Integrity: full natural timeline progression across every beat
 *      (orbit → burn → touchdown → depressurize → ramp → walkout → completed),
 *      with the onComplete callback firing exactly once.
 *   b) Telemetry & Atmospheric Audio: altimeter down-count during burn, ejecta
 *      burst trigger on touchdown, cabin depressurization venting 101.3 kPa →
 *      0.0 kPa and audioMode flipping 'cabin' → 'vacuum'.
 *   c) Camera Mode Switching: intro_cabin → intro_cinematic → intro_cabin →
 *      eva_first_person tracks each phase.
 *   d) Hold-to-Skip & Escape Key: 1.2 s hold advances phases; Escape skips
 *      straight to completion (director-level + ClientApp key routing).
 *   e) URL Parameter Handling: ?intro=1, ?skip_intro=1, ?intro_phase=…,
 *      ?intro_speed=… via parseIntroLaunch / launchIntroFromUrl.
 *   f) Replay Reset Lifecycle: replay resets the director, closes the ramp, kills
 *      thrusters and returns the avatar to the cabin spawn without mesh leaks or
 *      matrix NaNs.
 *   g) Walkout & QuestEngine Bridge: boots-on-regolith contact triggers completion
 *      and initializes Spec 18 Stage 1 ("Boots on the Ground") with corporate
 *      comms (CEC-DISP / 7-Echo).
 *
 * Run: `npx tsx scripts/smoke-intro-experience.ts` (exit 0 == all green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Scene } from '@babylonjs/core/scene.js';

import {
  CameraRig,
  CAMERA_MODES,
  babylonToWorld,
} from '../src/engine/CameraRig.ts';
import { TransportLander } from '../src/entities/TransportLander.ts';
import {
  IntroDirector,
  PHASE_DURATIONS,
  SKIP_HOLD_THRESHOLD_S,
  type IntroPhase,
} from '../src/client/IntroDirector.ts';
import { LunarHUD } from '../src/ui/LunarHUD.ts';
import {
  ClientApp,
  INTRO_COMPLETED_KEY,
} from '../src/client/ClientApp.ts';

// ---------------------------------------------------------------------------
// Harness bookkeeping
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

const approx = (a: number, b: number, eps = 1e-6): boolean =>
  Math.abs(a - b) <= eps;

/** In-memory Storage backend (headless persistence harness). */
class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

// ---------------------------------------------------------------------------
// Fake DOM (structural subset the HUD uses; see smoke-intro-walkout)
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
  appendChild<T>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

function makeFakeElement(tag: string, registry: Map<string, FakeElement>): FakeElement {
  const attributes = new Map<string, string>();
  const children: FakeElement[] = [];
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
    addEventListener() {},
    removeEventListener() {},
  };
  return el;
}

function makeFakeDocument(): {
  body: FakeElement;
  createElement(tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
} {
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
    removeEventListener() {},
  };
}

/** Scan a scene for any NaN in mesh world matrices (replay leak guard). */
function sceneHasNaNMesh(scene: Scene): boolean {
  for (const m of scene.meshes) {
    const wm = m.getWorldMatrix();
    if (!Number.isFinite(wm.m[0]) || !Number.isFinite(wm.m[15])) return true;
    if (!Number.isFinite(m.position.x)) return true;
  }
  return false;
}

/** Advance the director phase-by-phase to a target phase via update(). */
function advanceTo(director: IntroDirector, target: IntroPhase): void {
  if (!director.isRunning()) director.start('orbit');
  let guard = 0;
  while (director.getPhase() !== target && guard < 40) {
    const dur = PHASE_DURATIONS[director.getPhase()];
    director.update(dur > 0 ? dur + 1e-3 : 1);
    guard++;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ONE shared NullEngine for the whole suite (heap discipline: Babylon keeps
  // global registries that do not fully release on dispose, so we never stack
  // engines — the director block and the ClientApp block reuse this engine).
  const engine = new NullEngine({ renderWidth: 320, renderHeight: 240 } as never);

  // =========================================================================
  // A. DIRECTOR-LEVEL SUITE (state machine / telemetry / camera / skip)
  // =========================================================================

  section('A0. headless director harness (NullEngine)');

  const sceneA = new Scene(engine);
  const landerA = new TransportLander({
    scene: sceneA,
    position: new Vector3(0, 28, -40),
    headingRad: 0.35,
  });
  const rigA = new CameraRig(sceneA);

  const docA = makeFakeDocument();
  (globalThis as { document?: unknown }).document = docA;
  const hudA = new LunarHUD({ document: docA as unknown as Document });

  check('CAMERA_MODES includes intro_cabin', CAMERA_MODES.includes('intro_cabin'));
  check('CAMERA_MODES includes intro_cinematic', CAMERA_MODES.includes('intro_cinematic'));

  // -------------------------------------------------------------------------
  // a) State machine integrity: full natural timeline
  // -------------------------------------------------------------------------
  section('a. state machine (orbit → … → completed)');

  const phasesSeenA: IntroPhase[] = [];
  let completeCountA = 0;
  const directorA = new IntroDirector({
    scene: sceneA,
    cameraRig: rigA,
    lander: landerA,
    hud: hudA,
    onPhaseChange: (p) => phasesSeenA.push(p),
    onComplete: () => completeCountA++,
  });

  check('initial phase is idle', directorA.getPhase() === 'idle');
  check('not running before start', directorA.isRunning() === false);

  directorA.start('orbit');
  check('start("orbit") sets phase to orbit', directorA.getPhase() === 'orbit');
  check('running after start', directorA.isRunning() === true);
  check('orbit → intro_cabin camera mode', rigA.getMode() === 'intro_cabin');

  // Step through each duration boundary (natural timeline).
  directorA.update(PHASE_DURATIONS.orbit); // 6s → burn
  check('after orbit duration → burn', directorA.getPhase() === 'burn');
  check('burn → intro_cinematic camera mode', rigA.getMode() === 'intro_cinematic');

  directorA.update(0.01);
  check('burn lights thrusters at full', landerA.getThrusterIntensity() === 1);

  directorA.update(PHASE_DURATIONS.burn); // 12s → touchdown
  check('after burn duration → touchdown', directorA.getPhase() === 'touchdown');

  directorA.update(PHASE_DURATIONS.touchdown); // 3.5s → depressurize
  check('after touchdown duration → depressurize', directorA.getPhase() === 'depressurize');
  check('depressurize → intro_cabin camera mode', rigA.getMode() === 'intro_cabin');

  directorA.update(PHASE_DURATIONS.depressurize); // 4s → ramp
  check('after depressurize duration → ramp', directorA.getPhase() === 'ramp');

  directorA.update(PHASE_DURATIONS.ramp); // 8s → walkout
  check('after ramp duration → walkout', directorA.getPhase() === 'walkout');
  check('walkout hands back to eva_first_person', rigA.getMode() === 'eva_first_person');

  directorA.update(PHASE_DURATIONS.walkout); // 10s → completed
  check('after walkout duration → completed', directorA.getPhase() === 'completed');
  check('onComplete fired exactly once on natural completion', completeCountA === 1);
  check('running stops at completed', directorA.isRunning() === false);

  // `start('orbit')` enters orbit directly — idle is never emitted via
  // onPhaseChange, so the canonical run starts at orbit.
  const canonical: IntroPhase[] = [
    'orbit',
    'burn',
    'touchdown',
    'depressurize',
    'ramp',
    'walkout',
    'completed',
  ];
  check(
    'phasesSeen follow the canonical order',
    phasesSeenA.length === canonical.length &&
      phasesSeenA.every((p, i) => p === canonical[i]),
    `got ${phasesSeenA.join(' → ')}`,
  );

  // -------------------------------------------------------------------------
  // b) Telemetry & atmospheric audio
  // -------------------------------------------------------------------------
  section('b. telemetry + vacuum acoustic shift');

  directorA.jumpToPhase('burn');
  const burnStart = directorA.getTelemetry();
  check(
    'burn: altitude starts at the 12,400 m datum',
    approx(burnStart.altitudeMeters, 12400, 1),
    `got ${burnStart.altitudeMeters}`,
  );
  directorA.update(0.5);
  const burnMid = directorA.getTelemetry();
  directorA.update(11.4); // stay inside the 12 s phase
  const burnLate = directorA.getTelemetry();

  check(
    'burn: altitude strictly down-counts (12,400 → ~50 m)',
    burnStart.altitudeMeters > burnMid.altitudeMeters &&
      burnMid.altitudeMeters > burnLate.altitudeMeters,
    `start=${burnStart.altitudeMeters} mid=${burnMid.altitudeMeters} late=${burnLate.altitudeMeters}`,
  );
  check(
    'burn: descent rate down-counts (160 → ~10 m/s)',
    burnStart.descentVelocityMps > burnMid.descentVelocityMps &&
      burnMid.descentVelocityMps > burnLate.descentVelocityMps,
    `start=${burnStart.descentVelocityMps} mid=${burnMid.descentVelocityMps} late=${burnLate.descentVelocityMps}`,
  );
  check(
    'burn: cabin stays pressurized',
    approx(burnMid.cabinPressureKPa, 100) && burnMid.audioMode === 'cabin',
  );

  // Ejecta burst fires on touchdown.
  directorA.reset();
  directorA.jumpToPhase('orbit');
  check('ejecta not triggered before touchdown', directorA.getEjectaTriggered() === false);
  directorA.jumpToPhase('touchdown');
  check(
    'touchdown fires the ejecta burst (NullEngine-safe)',
    directorA.getEjectaTriggered() === true,
  );

  // Depressurize: pressure vents 101.3 → 0 kPa; audioMode flips to vacuum.
  directorA.jumpToPhase('depressurize');
  const depStart = directorA.getTelemetry();
  directorA.update(0.4);
  const depMid = directorA.getTelemetry();
  directorA.update(3.6);
  const depEnd = directorA.getTelemetry();

  check(
    'depressurize: pressure starts at cabin seal',
    approx(depStart.cabinPressureKPa, 100),
    `got ${depStart.cabinPressureKPa}`,
  );
  check(
    'depressurize: pressure vents toward 0.0 kPa',
    depMid.cabinPressureKPa < depStart.cabinPressureKPa && depEnd.cabinPressureKPa < 1,
    `start=${depStart.cabinPressureKPa} mid=${depMid.cabinPressureKPa} end=${depEnd.cabinPressureKPa}`,
  );
  check(
    'audioMode flips cabin → vacuum below the threshold',
    depMid.audioMode === 'cabin' && depEnd.audioMode === 'vacuum',
    `mid=${depMid.audioMode} end=${depEnd.audioMode}`,
  );

  // Ramp / walkout: on the surface, full vacuum acoustics.
  directorA.jumpToPhase('ramp');
  const rampTele = directorA.getTelemetry();
  check(
    'ramp: altitude 0 m, velocity 0 m/s, pressure 0 kPa, vacuum',
    approx(rampTele.altitudeMeters, 0) &&
      approx(rampTele.descentVelocityMps, 0) &&
      approx(rampTele.cabinPressureKPa, 0) &&
      rampTele.audioMode === 'vacuum',
  );

  // -------------------------------------------------------------------------
  // c) Camera mode switching across phases
  // -------------------------------------------------------------------------
  section('c. camera modes track each phase');

  directorA.jumpToPhase('orbit');
  check('orbit → intro_cabin', rigA.getMode() === 'intro_cabin');
  directorA.jumpToPhase('burn');
  check('burn → intro_cinematic', rigA.getMode() === 'intro_cinematic');
  directorA.jumpToPhase('touchdown');
  check('touchdown → intro_cinematic', rigA.getMode() === 'intro_cinematic');
  directorA.jumpToPhase('depressurize');
  check('depressurize → intro_cabin', rigA.getMode() === 'intro_cabin');
  directorA.jumpToPhase('ramp');
  check('ramp → intro_cabin', rigA.getMode() === 'intro_cabin');
  directorA.jumpToPhase('walkout');
  check('walkout → eva_first_person', rigA.getMode() === 'eva_first_person');

  // -------------------------------------------------------------------------
  // d) Hold-to-skip & Escape (director-level)
  // -------------------------------------------------------------------------
  section('d. hold-to-skip + skipCurrentPhase/skipToFinish (director)');

  directorA.jumpToPhase('burn');
  let held = false;
  const step = 0.4; // 40 ms frames → threshold at 3 × 0.4 = 1.2 s
  for (let i = 1; i <= 5; i++) {
    if (directorA.updateSkipInput(true, step)) {
      held = true;
      break;
    }
  }
  check('updateSkipInput returns true at ≥ 1.2 s hold', held);
  check('hold-to-skip advances burn → touchdown', directorA.getPhase() === 'touchdown');
  directorA.updateSkipInput(false, step);
  check(
    'releasing resets the skip accumulator',
    approx(directorA.getSkipHoldProgress(), 0),
    `got ${directorA.getSkipHoldProgress().toFixed(3)}`,
  );

  directorA.skipCurrentPhase();
  check(
    'skipCurrentPhase advances touchdown → depressurize',
    directorA.getPhase() === 'depressurize',
  );

  const beforeFinish = completeCountA;
  directorA.skipToFinish();
  check('skipToFinish transitions to completed', directorA.getPhase() === 'completed');
  check('skipToFinish fires onComplete', completeCountA === beforeFinish + 1);

  // -------------------------------------------------------------------------
  // f) reset(): closes ramp, kills thrusters, returns to idle (director-level)
  // -------------------------------------------------------------------------
  section('f. reset() clean teardown (director)');

  directorA.reset();
  check('reset returns to idle', directorA.getPhase() === 'idle');
  check(
    'reset closes the ramp (sealed horizontal)',
    Math.abs(landerA.getRampAngleRad()) < 1e-9,
  );
  check('reset kills thrusters', landerA.getThrusterIntensity() === 0);
  check('reset stops running', directorA.isRunning() === false);
  check('ejecta burst cleared on reset', directorA.getEjectaTriggered() === false);

  // Director block teardown (keep the shared engine for section B).
  directorA.dispose();
  hudA.dispose();
  landerA.dispose();

  // =========================================================================
  // B. CLIENT-LEVEL SUITE (URL params / replay lifecycle / walkout bridge)
  // =========================================================================

  section('B0. headless ClientApp harness');

  const docB = makeFakeDocument();
  (globalThis as { document?: unknown }).document = docB;
  const storage = new MemoryStorage();

  const app = new ClientApp({
    seed: 'mala-voyage-2431',
    username: 'testpilot',
    faction: 'CEC',
    silent: true,
    deferQuestUntilIntroComplete: true,
    devMode: true,
    introStorage: storage,
    introQuery: 'intro=1&intro_phase=touchdown&intro_speed=2.0',
  });

  await app.init(engine);

  let nowMs = 100_000;
  const tick = (ms = 16): void => {
    nowMs += ms;
    app.update(nowMs);
  };

  const sceneB = app.world.getScene();
  const rigB = app.world.getCameraRig();

  const landerB = new TransportLander({
    scene: sceneB,
    position: new Vector3(0, 28, -40),
    headingRad: 0.35,
  });

  let onCompleteFired = 0;
  const directorB = new IntroDirector({
    scene: sceneB,
    cameraRig: rigB,
    lander: landerB,
    hud: app.getHud() ?? undefined,
    onComplete: () => {
      onCompleteFired++;
    },
  });

  app.setIntroDirector(directorB);

  check('ClientApp initialized', app.isInitialized());
  check('intro director attached', app.getIntroDirector() === directorB);
  check(
    'avatar position reader wired to the director',
    (directorB as unknown as { getAvatarPosition?: unknown }).getAvatarPosition !== undefined,
  );

  // -------------------------------------------------------------------------
  // e) URL parameter handling
  // -------------------------------------------------------------------------
  section('e. URL query parameters');

  const decision = app.parseIntroLaunch();
  check(
    'intro=1 → play forced true',
    decision.play === true,
    `play=${decision.play}`,
  );
  check(
    'intro_phase=touchdown → phase touchdown',
    decision.phase === 'touchdown',
    `phase=${String(decision.phase)}`,
  );
  check(
    'intro_speed=2.0 → speed 2.0',
    decision.speed === 2.0,
    `speed=${decision.speed}`,
  );

  const started = app.launchIntroFromUrl();
  check('launchIntroFromUrl returns "intro"', started === 'intro');
  check(
    'director begins at touchdown (intro_phase honoured)',
    directorB.getPhase() === 'touchdown',
    `got ${directorB.getPhase()}`,
  );
  check('timeScale applied from intro_speed=2.0', directorB.timeScale === 2.0);

  // Parse-only scenarios never call init() — they read the injected query +
  // storage without building a WorldScene, so they cost almost nothing.
  function parseApp(query: string): ClientApp {
    return new ClientApp({
      seed: 'mala-voyage-2431',
      username: 'scoped',
      faction: 'CEC',
      silent: true,
      deferQuestUntilIntroComplete: true,
      devMode: true,
      introStorage: storage,
      introQuery: query,
    });
  }

  const skipApp = parseApp('skip_intro=1');
  check(
    'skip_intro=1 → play false',
    skipApp.parseIntroLaunch().play === false,
  );

  const zeroApp = parseApp('intro=0');
  check(
    'intro=0 → play false (alias for skip_intro)',
    zeroApp.parseIntroLaunch().play === false,
  );

  // -------------------------------------------------------------------------
  // d) Hold-to-skip & Escape (ClientApp key routing)
  // -------------------------------------------------------------------------
  section('d. hold-to-skip + Escape (ClientApp)');

  directorB.jumpToPhase('burn');
  check('seeded at burn', directorB.getPhase() === 'burn');

  app.handleKeyInput('Space', 'down');
  tick(16);
  const beforeSkip = directorB.getPhase();
  check(
    'short Space hold does not skip',
    beforeSkip === 'burn',
    `got ${beforeSkip}`,
  );
  app.handleKeyInput('Space', 'up');

  app.handleKeyInput('Space', 'down');
  let skipped = false;
  for (let i = 0; i < 90; i++) {
    tick(16); // 90 × 16 ms ≈ 1.44 s ≥ 1.2 s
    if (directorB.getPhase() !== 'burn') {
      skipped = true;
      break;
    }
  }
  app.handleKeyInput('Space', 'up');
  check(
    'hold-to-skip advanced past burn',
    skipped && directorB.getPhase() !== 'burn',
    `got ${directorB.getPhase()}`,
  );

  directorB.jumpToPhase('orbit');
  const beforeEscape = onCompleteFired;
  app.handleKeyInput('Escape', 'down');
  check(
    'Escape skips directly to completed',
    directorB.getPhase() === 'completed',
    `got ${directorB.getPhase()}`,
  );
  check('Escape fires completion', onCompleteFired >= beforeEscape + 1);
  app.handleKeyInput('Escape', 'up');

  // -------------------------------------------------------------------------
  // g) Walkout & QuestEngine bridge (boots-on-regolith handoff)
  // -------------------------------------------------------------------------
  section('g. walkout → regolith contact → quest bridge');

  directorB.jumpToPhase('orbit');
  check('reset to orbit for a full run', directorB.getPhase() === 'orbit');
  directorB.update(PHASE_DURATIONS.orbit); // → burn
  tick();
  directorB.update(PHASE_DURATIONS.burn); // → touchdown
  tick();
  directorB.update(PHASE_DURATIONS.touchdown); // → depressurize
  directorB.update(PHASE_DURATIONS.depressurize); // → ramp
  tick();
  directorB.update(PHASE_DURATIONS.ramp); // → walkout
  tick();
  check(
    'walkout phase reached',
    directorB.getPhase() === 'walkout',
    `got ${directorB.getPhase()}`,
  );

  const rampExit = babylonToWorld(landerB.getRampExitPoint());
  app.getSuit().teleport(rampExit.x, rampExit.y);
  check(
    'avatar advanced to regolith contact point',
    approx(app.getSuit().getPosition().x, rampExit.x, 1.5) &&
      approx(app.getSuit().getPosition().y, rampExit.y, 1.5),
  );

  tick();
  check(
    'director completes on regolith contact',
    directorB.getPhase() === 'completed',
    `got ${directorB.getPhase()}`,
  );
  check('onComplete fired once', onCompleteFired >= 1);
  check('director stops running at completed', directorB.isRunning() === false);

  const quest = app.getQuestEngine();
  const activeQuest = quest?.getActiveQuest() ?? null;
  check('quest engine bridged — tutorial quest active', activeQuest !== null);
  check(
    'bridged quest is the canonical tutorial (Spec 18 §5)',
    activeQuest !== null && activeQuest.title === 'A One-Way Ticket to the Frontier',
    `got ${activeQuest?.title}`,
  );
  const firstStage = activeQuest?.stages[0] ?? null;
  check(
    'stage 1 "Boots on the Ground" objectives present',
    firstStage !== null &&
      firstStage.stageTitle === 'Boots on the Ground' &&
      Array.isArray(firstStage.objectives) &&
      firstStage.objectives.length > 0,
  );

  const lastComms = app.getLastComms();
  check(
    'corporate dispatch comms delivered',
    lastComms !== null && /CEC-DISP|7-Echo/.test(`${lastComms.sender} ${lastComms.callsign}`),
    `got ${lastComms?.sender}/${lastComms?.callsign}`,
  );

  // Storage flag written on completion.
  check(
    'completion wrote "1" to storage',
    storage.getItem(INTRO_COMPLETED_KEY) === '1',
    `got ${storage.getItem(INTRO_COMPLETED_KEY)}`,
  );
  check('isIntroCompleted() true after completion', app.isIntroCompleted() === true);

  // -------------------------------------------------------------------------
  // f) Replay reset lifecycle (mesh-leak / NaN guard)
  // -------------------------------------------------------------------------
  section('f. replay reset lifecycle (ClientApp)');

  const meshCountBefore = landerB.getMeshes().length;
  const cabinSpawn = babylonToWorld(landerB.getCabinSpawnPoint());

  check('replayIntro returns true (director attached)', app.replayIntro() === true);
  check(
    'replay resets director to orbit',
    directorB.getPhase() === 'orbit',
    `got ${directorB.getPhase()}`,
  );
  check('replay marks the director running', directorB.isRunning() === true);

  const afterReplay = app.getSuit().getPosition();
  check(
    'avatar returned to cabin spawn',
    Math.hypot(afterReplay.x - cabinSpawn.x, afterReplay.y - cabinSpawn.y) < 1.5,
    `suit=(${afterReplay.x.toFixed(2)},${afterReplay.y.toFixed(2)}) cabin=(${cabinSpawn.x.toFixed(2)},${cabinSpawn.y.toFixed(2)})`,
  );

  const meshCountAfter = landerB.getMeshes().length;
  check(
    'no mesh leak across replay (count stable)',
    meshCountAfter === meshCountBefore,
    `${meshCountBefore} → ${meshCountAfter}`,
  );
  check('no NaN in scene world matrices after replay', sceneHasNaNMesh(sceneB) === false);

  // HUD replay button path fires the same replay.
  const hud = app.getHud();
  check('triggerReplayIntro() wired', hud?.triggerReplayIntro() === true);
  check(
    'HUD-triggered replay restarts from orbit',
    directorB.getPhase() === 'orbit',
    `got ${directorB.getPhase()}`,
  );

  // -------------------------------------------------------------------------
  // Verdict
  // -------------------------------------------------------------------------

  console.log(`\n${'='.repeat(60)}`);
  if (failures.length === 0) {
    console.log(
      `ALL ${passed} CHECKS PASSED ✔  (consolidated intro experience, Spec 24 Phase 6)`,
    );
    directorB.dispose();
    landerB.dispose();
    app.dispose();
    engine.dispose();
    process.exit(0);
  } else {
    console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
    for (const f of failures) console.error(`  - ${f}`);
    directorB.dispose();
    landerB.dispose();
    app.dispose();
    engine.dispose();
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  console.error('smoke-intro-experience crashed:', err);
  process.exit(1);
});
