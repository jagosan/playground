/**
 * Spec 24 Phase 4 — Walkout Locomotion & Quest Engine Handoff headless smoke test.
 *
 * Boots a real `ClientApp` over a NullEngine scene with a wired `IntroDirector`
 * and `TransportLander`, then verifies the boots-on-regolith handoff (§2.6):
 *
 *   1. Pre-walkout cinematic beats (orbit → ramp): player input is LOCKED and
 *      the EVA suit is tethered to the lander's cabin interior
 *      (`lander.getCabinSpawnPoint()`), so it rides down with the hull instead
 *      of walking off.
 *   2. Walkout phase: movement unlocks — `isIntroCinematic()` is false and the
 *      suit responds to locomotion input (down the ramp).
 *   3. Advancing the avatar onto regolith (reaching `lander.getRampExitPoint()`)
 *      completes the intro: `onComplete` fires, the director flips to
 *      `completed`, and ClientApp bridges to QuestEngine — Spec 18 Stage 1
 *      ("Boots on the Ground") starts with the corporate dispatch comms.
 *   4. The handoff runs exactly once (no double-initialization).
 *
 * Run: `npx tsx scripts/smoke-intro-walkout.ts` (exit 0 == all green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import { ClientApp } from '../src/client/ClientApp.ts';
import { IntroDirector, PHASE_DURATIONS } from '../src/client/IntroDirector.ts';
import { TransportLander } from '../src/entities/TransportLander.ts';
import { babylonToWorld } from '../src/engine/CameraRig.ts';

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

const approx = (a: number, b: number, eps = 1e-3): boolean =>
  Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// Fake DOM (structural subset the HUD uses; see smoke-client-app for the pattern)
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
  addEventListener?(): void;
  removeEventListener?(): void;
} {
  const registry = new Map<string, FakeElement>();
  const body = makeFakeElement('body', registry);
  return {
    body,
    createElement: (tag: string) => makeFakeElement(tag, registry),
    getElementById: (id: string) => registry.get(id) ?? null,
    addEventListener() {},
    removeEventListener() {},
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
section('0. headless harness (NullEngine + ClientApp)');

const doc = makeFakeDocument();
(globalThis as { document?: unknown }).document = doc;

const engine = new NullEngine({ renderWidth: 320, renderHeight: 240 } as never);

const app = new ClientApp({
  seed: 'mala-voyage-2431',
  username: 'testpilot',
  faction: 'CEC',
  silent: true,
  // Spec 24 Phase 4 §2.6: the tutorial quest must NOT pre-start — it waits
  // for the boots-on-regolith handoff so we can assert the bridge fires.
  deferQuestUntilIntroComplete: true,
});

await app.init(engine);

/** Manual monotonic clock feeding `app.update()` (mirrors smoke-client-app). */
let nowMs = 100_000;
const tick = (ms = 16): void => {
  nowMs += ms;
  app.update(nowMs);
};

const scene = app.world.getScene();
const rig = app.world.getCameraRig();

// The transport lander lives in the SAME world scene as the avatar.
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
check(
  'avatar position reader wired to the director',
  // ClientApp sets a live reader so walkout completes on regolith contact.
  (director as unknown as { getAvatarPosition?: unknown }).getAvatarPosition !== undefined,
);

// ---------------------------------------------------------------------------
// 1. Pre-walkout: input locked + avatar tethered to cabin interior
// ---------------------------------------------------------------------------

section('1. cinematic beats lock input & tether the avatar to the cabin');

const cabinSpawn = babylonToWorld(lander.getCabinSpawnPoint());

director.start('orbit');
director.update(PHASE_DURATIONS.orbit); // → burn
tick();
const suitDuringBurn = app.getSuit().getPosition();
check(
  'burn: avatar pinned at cabin spawn (input locked)',
  approx(suitDuringBurn.x, cabinSpawn.x, 1.5) &&
    approx(suitDuringBurn.y, cabinSpawn.y, 1.5),
  `suit=(${suitDuringBurn.x.toFixed(2)},${suitDuringBurn.y.toFixed(2)}) cabin=(${cabinSpawn.x.toFixed(2)},${cabinSpawn.y.toFixed(2)})`,
);

// Step through the remaining cinematic beats to ramp.
director.update(PHASE_DURATIONS.burn); // → touchdown
tick();
director.update(PHASE_DURATIONS.touchdown); // → depressurize
director.update(PHASE_DURATIONS.depressurize); // → ramp
tick();

const suitDuringRamp = app.getSuit().getPosition();
check(
  'ramp: avatar still tethered at cabin spawn',
  approx(suitDuringRamp.x, cabinSpawn.x, 1.5) &&
    approx(suitDuringRamp.y, cabinSpawn.y, 1.5),
  `suit=(${suitDuringRamp.x.toFixed(2)},${suitDuringRamp.y.toFixed(2)})`,
);

// ---------------------------------------------------------------------------
// 2. Walkout: movement unlocks
// ---------------------------------------------------------------------------

section('2. walkout unlocks locomotion down the ramp');

director.update(PHASE_DURATIONS.ramp); // → walkout
tick();
check(
  'walkout phase reached',
  director.getPhase() === 'walkout',
  `got ${director.getPhase()}`,
);

// With input unlocked, forward locomotion must move the suit (down the ramp).
app.handleKeyInput('KeyW', 'down');
const beforeWalk = app.getSuit().getPosition();
tick();
const afterWalk = app.getSuit().getPosition();
app.handleKeyInput('KeyW', 'up');
const movedDuringWalkout =
  Math.hypot(afterWalk.x - beforeWalk.x, afterWalk.y - beforeWalk.y) > 1e-4;
check(
  'walkout: suit moves under locomotion input (unlocked)',
  movedDuringWalkout,
  `before=(${beforeWalk.x.toFixed(2)},${beforeWalk.y.toFixed(2)}) after=(${afterWalk.x.toFixed(2)},${afterWalk.y.toFixed(2)})`,
);

// ---------------------------------------------------------------------------
// 3. Boots-on-regolith: advancing to the ramp exit completes + bridges
// ---------------------------------------------------------------------------

section('3. regolith contact → intro completion + QuestEngine bridge');

const rampExit = babylonToWorld(lander.getRampExitPoint());

// Teleport the avatar onto the lunar surface at the ramp foot (regolith).
app.getSuit().teleport(rampExit.x, rampExit.y);
check(
  'avatar advanced to regolith contact point',
  approx(app.getSuit().getPosition().x, rampExit.x, 1.5) &&
    approx(app.getSuit().getPosition().y, rampExit.y, 1.5),
);

// A single frame tick lets the director detect boots-on-regolith and complete.
tick();
check(
  'director completes on regolith contact',
  director.getPhase() === 'completed',
  `got ${director.getPhase()}`,
);
check('onComplete fired once', onCompleteFired === 1, `got ${onCompleteFired}`);
check('director stops running at completed', director.isRunning() === false);

// QuestEngine bridge: Spec 18 Stage 1 ("Boots on the Ground") is active.
const quest = app.getQuestEngine();
const activeQuest = quest?.getActiveQuest() ?? null;
check(
  'quest engine bridged — tutorial quest active',
  activeQuest !== null,
);
check(
  'bridged quest is the canonical tutorial (Spec 18 §5)',
  activeQuest !== null && activeQuest.title === 'A One-Way Ticket to the Frontier',
  `got ${activeQuest?.title}`,
);
// Stage 1 is defined by the quest blueprint ("Boots on the Ground"); assert it
// regardless of live auto-advance (the avatar teleport may already progress it).
const firstStage = activeQuest?.stages[0] ?? null;
check(
  'stage 1 "Boots on the Ground" objectives present',
  firstStage !== null &&
    firstStage.stageTitle === 'Boots on the Ground' &&
    Array.isArray(firstStage.objectives) &&
    firstStage.objectives.length > 0,
);

// Corporate dispatch comms reached the app (ClientApp.lastComms).
const lastComms = app.getLastComms();
check(
  'corporate dispatch comms delivered',
  lastComms !== null &&
    /CEC-DISP|7-Echo/.test(`${lastComms.sender} ${lastComms.callsign}`),
  `got ${lastComms?.sender}/${lastComms?.callsign}`,
);

// ---------------------------------------------------------------------------
// 4. No double-initialization
// ---------------------------------------------------------------------------

section('4. handoff runs exactly once');

tick();
check(
  'onComplete not re-fired on subsequent frames',
  onCompleteFired === 1,
  `got ${onCompleteFired}`,
);

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED ✔  (walkout + quest handoff, Spec 24 Phase 4)`);
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
  console.error('smoke-intro-walkout crashed:', err);
  process.exit(1);
});
