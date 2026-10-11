/**
 * Spec 24 Phase 5 — Intro Replay Suite, URL Flags, Storage Persistence &
 * Hold-to-Skip / Dev Hotkeys headless smoke test.
 *
 * Boots a real `ClientApp` over a NullEngine scene with a wired
 * `IntroDirector` + `TransportLander`, then verifies:
 *
 *   1. URL parameter parsing (`intro=1`, `skip_intro=1`, `intro_phase=touchdown`,
 *      `intro_speed=2.0`) via `parseIntroLaunch()` / `launchIntroFromUrl()`.
 *   2. Storage flag persistence: `lunar_frontier_intro_completed` is absent
 *      before, written `'1'` on completion, and then suppresses a fresh intro
 *      (spawn-direct) unless forced by `intro=1`.
 *   3. In-HUD replay button (`triggerReplayIntro`) resets the IntroDirector,
 *      teleports the avatar back into the cabin spawn, and restarts from 'orbit'.
 *   4. Hold-to-skip: [Space] accumulation over 1.2 s skips to the next beat;
 *      [Escape] immediately skips straight to completion.
 *   5. Dev hotkeys (devMode): [1]–[5] jump phases; [F8] clears storage and
 *      restarts from Beat 1.
 *
 * Run: `npx tsx scripts/smoke-intro-replay.ts` (exit 0 == all green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import {
  ClientApp,
  INTRO_COMPLETED_KEY,
} from '../src/client/ClientApp.ts';
import {
  IntroDirector,
  SKIP_HOLD_THRESHOLD_S,
  type IntroPhase,
} from '../src/client/IntroDirector.ts';
import { TransportLander } from '../src/entities/TransportLander.ts';

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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  section('0. headless harness (NullEngine + ClientApp + injected storage/query)');

  const doc = makeFakeDocument();
  (globalThis as { document?: unknown }).document = doc;
  const storage = new MemoryStorage();

  const engine = new NullEngine({ renderWidth: 320, renderHeight: 240 } as never);

  // intro=1 forces playback regardless of storage; intro_phase=touchdown jumps
  // straight to the landing moment; intro_speed=2.0 doubles the timeline.
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

  const scene = app.world.getScene();
  const rig = app.world.getCameraRig();

  const lander = new TransportLander({
    scene,
    position: new Vector3(0, 28, -40),
    headingRad: 0.35,
  });

  let onCompleteFired = 0;
  const director = new IntroDirector({
    scene,
    cameraRig: rig,
    lander,
    hud: app.getHud() ?? undefined,
    onComplete: () => {
      onCompleteFired++;
    },
  });

  app.setIntroDirector(director);

  check('ClientApp initialized', app.isInitialized());
  check('intro director attached', app.getIntroDirector() === director);

  // -------------------------------------------------------------------------
  // 1. URL parameter parsing
  // -------------------------------------------------------------------------
  section('1. URL query parameters');

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

  // launchIntroFromUrl starts the director at the requested phase.
  const started = app.launchIntroFromUrl();
  check('launchIntroFromUrl returns "intro"', started === 'intro');
  check(
    'director begins at touchdown (intro_phase honoured)',
    director.getPhase() === 'touchdown',
    `got ${director.getPhase()}`,
  );
  check(
    'timeScale applied from intro_speed=2.0',
    director.timeScale === 2.0,
    `got ${director.timeScale}`,
  );

  // Parse-only scenarios never call `init()` — `parseIntroLaunch` reads the
  // injected query + storage without building a WorldScene, so they cost almost
  // nothing (the smoke-client-app harness warns stacking full ClientApps blows the
  // V8 heap). Only launch/deferred-quest scenarios need a real init.
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

  // skip_intro=1 suppresses the intro entirely (parse-only, no WorldScene).
  const skipApp = parseApp('skip_intro=1');
  check(
    'skip_intro=1 → play false',
    skipApp.parseIntroLaunch().play === false,
  );

  // intro=0 is an alias for skip_intro.
  const zeroApp = parseApp('intro=0');
  check(
    'intro=0 → play false (alias for skip_intro)',
    zeroApp.parseIntroLaunch().play === false,
  );

  // -------------------------------------------------------------------------
  // 2. Storage persistence
  // -------------------------------------------------------------------------
  section('2. storage flag persistence');

  check(
    'completion key absent before any completion',
    storage.getItem(INTRO_COMPLETED_KEY) === null,
  );
  check('isIntroCompleted() false initially', app.isIntroCompleted() === false);

  // Drive the director through to completed → storage write.
  director.jumpToPhase('orbit');
  check('jump back to orbit for a full run', director.getPhase() === 'orbit');
  director.update(6); // orbit → burn
  director.update(12); // burn → touchdown
  director.update(3.5); // touchdown → depressurize
  director.update(4); // depressurize → ramp
  director.update(8); // ramp → walkout
  director.update(10); // walkout → completed (duration fallback, no avatar reader)
  tick();
  check(
    'director reached completed',
    director.getPhase() === 'completed',
    `got ${director.getPhase()}`,
  );
  check('onComplete fired', onCompleteFired >= 1);
  check(
    'completion wrote "1" to storage',
    storage.getItem(INTRO_COMPLETED_KEY) === '1',
    `got ${storage.getItem(INTRO_COMPLETED_KEY)}`,
  );
  check('isIntroCompleted() true after completion', app.isIntroCompleted() === true);

  // Full-app scenarios share ONE extra engine so total resident engines stay at
  // two (main + shared) — Babylon keeps global registries that do not fully
  // release on dispose, and the smoke-client-app harness warns a fifth engine
  // blows the V8 heap. Each app is disposed before the next is initialized.
  const sharedEngine = new NullEngine({ renderWidth: 320, renderHeight: 240 } as never);
  async function fullApp(
    query: string,
    run: (a: ClientApp, d: IntroDirector) => void,
  ): Promise<void> {
    const a = new ClientApp({
      seed: 'mala-voyage-2431',
      username: 'scoped',
      faction: 'CEC',
      silent: true,
      deferQuestUntilIntroComplete: true,
      devMode: true,
      introStorage: storage,
      introQuery: query,
    });
    await a.init(sharedEngine);
    const d = new IntroDirector({
      scene: a.world.getScene(),
      cameraRig: a.world.getCameraRig(),
      lander: new TransportLander({
        scene: a.world.getScene(),
        position: new Vector3(0, 28, -40),
        headingRad: 0.35,
      }),
      hud: a.getHud() ?? undefined,
    });
    a.setIntroDirector(d);
    run(a, d);
    d.dispose();
    a.dispose();
  }

  // With the flag set and no force, a fresh launch spawns directly.
  await fullApp('', (repeatApp) => {
    check(
      'completed flag + no force → play false (spawn directly)',
      repeatApp.parseIntroLaunch().play === false,
    );
    check('launch skipped for returning player', repeatApp.launchIntroFromUrl() === 'skipped');
  });

  // intro=1 still forces playback even with the set.
  await fullApp('intro=1', (forcedApp, forcedDirector) => {
    check(
      'intro=1 forces playback despite completed flag',
      forcedApp.parseIntroLaunch().play === true,
    );
    const forcedStart = forcedApp.launchIntroFromUrl();
    check('forced launch starts the intro', forcedStart === 'intro');
    check('forced director running from orbit', forcedDirector.getPhase() === 'orbit');
  });
  sharedEngine.dispose();

  // -------------------------------------------------------------------------
  // 3. Replay button
  // -------------------------------------------------------------------------
  section('3. HUD replay trigger');

  const hud = app.getHud();
  check('HUD present with replay wiring', hud !== null);

  // Reset the avatar into a known surface pose first.
  app.handleKeyInput('KeyW', 'down');
  tick(50);
  app.handleKeyInput('KeyW', 'up');

  const cabinSpawn = lander.getCabinSpawnPoint();
  const beforeReplay = app.getSuit().getPosition();

  check('replayIntro returns true (director attached)', app.replayIntro() === true);
  check(
    'replay resets director to orbit',
    director.getPhase() === 'orbit',
    `got ${director.getPhase()}`,
  );
  check('replay marks the director running', director.isRunning() === true);

  const afterReplay = app.getSuit().getPosition();
  check(
    'avatar teleported back to cabin spawn',
    Math.hypot(afterReplay.x - cabinSpawn.x, afterReplay.y - cabinSpawn.y) <
      Math.hypot(beforeReplay.x - cabinSpawn.x, beforeReplay.y - cabinSpawn.y),
    `before=(${beforeReplay.x.toFixed(2)},${beforeReplay.y.toFixed(2)}) ` +
      `after=(${afterReplay.x.toFixed(2)},${afterReplay.y.toFixed(2)})`,
  );

  // The HUD button path fires the same replay.
  check('triggerReplayIntro() wired', hud?.triggerReplayIntro() === true);
  check(
    'HUD-triggered replay restarts from orbit',
    director.getPhase() === 'orbit',
    `got ${director.getPhase()}`,
  );

  // -------------------------------------------------------------------------
  // 4. Hold-to-skip + Escape
  // -------------------------------------------------------------------------
  section('4. hold-to-skip & Escape');

  director.jumpToPhase('burn');
  check('seeded at burn', director.getPhase() === 'burn');

  // Hold [Space] for just under the threshold → no skip yet.
  app.handleKeyInput('Space', 'down');
  tick(16);
  const beforeSkip = director.getPhase();
  check(
    'short Space hold does not skip',
    beforeSkip === 'burn',
    `got ${beforeSkip}`,
  );
  app.handleKeyInput('Space', 'up');

  // Full 1.2 s hold → skips to the next beat.
  app.handleKeyInput('Space', 'down');
  let skipped = false;
  for (let i = 0; i < 90; i++) {
    tick(16); // 90 × 16 ms ≈ 1.44 s ≥ 1.2 s
    if (director.getPhase() !== 'burn') {
      skipped = true;
      break;
    }
  }
  app.handleKeyInput('Space', 'up');
  check(
    'hold-to-skip advanced past burn',
    skipped && director.getPhase() !== 'burn',
    `got ${director.getPhase()}`,
  );

  // Escape immediately skips straight to completion.
  director.jumpToPhase('orbit');
  const beforeEscape = onCompleteFired;
  app.handleKeyInput('Escape', 'down');
  check(
    'Escape skips directly to completed',
    director.getPhase() === 'completed',
    `got ${director.getPhase()}`,
  );
  check('Escape fires completion', onCompleteFired >= beforeEscape + 1);
  app.handleKeyInput('Escape', 'up');

  // -------------------------------------------------------------------------
  // 5. Dev hotkeys (devMode)
  // -------------------------------------------------------------------------
  section('5. dev hotkeys');

  director.jumpToPhase('orbit');
  for (const [code, expect] of [
    ['Digit2', 'burn'],
    ['Digit3', 'touchdown'],
    ['Digit4', 'depressurize'],
    ['Digit5', 'ramp'],
    ['Digit1', 'orbit'],
  ] as const) {
    app.handleKeyInput(code, 'down');
    check(
      `[${code}] jumps to ${expect}`,
      director.getPhase() === expect,
      `got ${director.getPhase()}`,
    );
    app.handleKeyInput(code, 'up');
  }

  // F8 clears storage + restarts from Beat 1.
  storage.setItem(INTRO_COMPLETED_KEY, '1');
  check('storage primed for F8 wipe', storage.getItem(INTRO_COMPLETED_KEY) === '1');
  app.handleKeyInput('F8', 'down');
  check(
    'F8 clears the completion flag',
    storage.getItem(INTRO_COMPLETED_KEY) === null,
    `got ${storage.getItem(INTRO_COMPLETED_KEY)}`,
  );
  check(
    'F8 restarts from Beat 1 (orbit)',
    director.getPhase() === 'orbit' && director.isRunning(),
    `got ${director.getPhase()}`,
  );
  app.handleKeyInput('F8', 'up');

  // -------------------------------------------------------------------------
  // Verdict
  // -------------------------------------------------------------------------
  console.log(`\n${'='.repeat(60)}`);
  if (failures.length === 0) {
    console.log(
      `ALL ${passed} CHECKS PASSED ✔  (intro replay suite + URL flags + storage, Spec 24 Phase 5)`,
    );
    director.dispose();
    lander.dispose();
    app.dispose();
    engine.dispose();
    process.exit(0);
  } else {
    console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
    for (const f of failures) console.error(`  - ${f}`);
    director.dispose();
    lander.dispose();
    app.dispose();
    engine.dispose();
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  console.error('smoke-intro-replay crashed:', err);
  process.exit(1);
});
