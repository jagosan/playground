/**
 * Spec 24 Phase 3 — Vacuum Ejecta + Atmospheric Audio Transition +
 * Intro HUD Telemetry Overlay headless smoke test.
 *
 * Boots `IntroDirector` over a NullEngine scene with a real `CameraRig`,
 * a `TransportLander`, and a real `LunarHUD` (driven through a fake DOM),
 * then verifies:
 *
 *   1. Telemetry shape across every phase: `getTelemetry()` returns the
 *      IntroTelemetry contract (§2.2–§2.4) for orbit / burn / touchdown /
 *      depressurize / ramp / walkout.
 *   2. Descent down-counts: altitude 12,400 → ~50 m and velocity 160 →
 *      ~10 m/s across the burn; touchdown closes to 0 m / 0 m/s.
 *   3. Cabin pressure vents 101.3 kPa → 0.0 kPa during depressurize, and
 *      audioMode flips 'cabin' → 'vacuum' once pressure drops below 5.0 kPa
 *      (the suit-conducted acoustic cut, §2.4).
 *   4. Vacuum ejecta particle burst fires on touchdown without throwing under the
 *      NullEngine (§2.3 / §4.4 — GPU system swapped for a fallback node).
 *   5. LunarHUD.updateIntroTelemetry renders altitude / descent / pressure /
 *      skip-progress DOM and retracts on null (Spec 24 Phase 3 overlay).
 *   6. The director pushes telemetry to the HUD every frame automatically and
 *      passes `null` when idle / completed.
 *
 * Run: `npx tsx scripts/smoke-intro-hud-fx.ts` (exit 0 == all green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Scene } from '@babylonjs/core/scene.js';

import { CameraRig } from '../src/engine/CameraRig.ts';
import { TransportLander } from '../src/entities/TransportLander.ts';
import {
  IntroDirector,
  PHASE_DURATIONS,
  SKIP_HOLD_THRESHOLD_S,
  type IntroPhase,
} from '../src/client/IntroDirector.ts';
import { LunarHUD } from '../src/ui/LunarHUD.ts';

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
  };
  return el;
}

function makeFakeDocument(): {
  body: FakeElement;
  createElement(tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
} {
  const registry = new Map<string, FakeElement>();
  const body = makeFakeElement('body', registry);
  return {
    body,
    createElement: (tag: string) => makeFakeElement(tag, registry),
    getElementById: (id: string) => registry.get(id) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Harness helpers
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
// Headless scene + lander + camera rig + real LunarHUD (fake DOM)
// ---------------------------------------------------------------------------
section('0. headless harness (NullEngine)');

const engine = new NullEngine({ renderWidth: 1600, renderHeight: 900 });
const scene = new Scene(engine);

const lander = new TransportLander({
  scene,
  position: new Vector3(0, 28, -40),
  headingRad: 0.35,
});
const rig = new CameraRig(scene);

const doc = makeFakeDocument();
const hud = new LunarHUD({ document: doc as unknown as Document });

// ---------------------------------------------------------------------------
// 1. Telemetry shape across every phase
// ---------------------------------------------------------------------------
section('1. getTelemetry() contract across phases');

const director = new IntroDirector({
  scene,
  cameraRig: rig,
  lander,
  hud,
});

director.start('orbit');
let tele = director.getTelemetry();
check(
  'orbit telemetry carries the full IntroTelemetry shape',
  typeof tele.phase === 'string' &&
    typeof tele.phaseElapsedSeconds === 'number' &&
    typeof tele.altitudeMeters === 'number' &&
    typeof tele.descentVelocityMps === 'number' &&
    typeof tele.cabinPressureKPa === 'number' &&
    (tele.audioMode === 'cabin' || tele.audioMode === 'vacuum') &&
    typeof tele.skipHoldProgress === 'number',
);
check(
  'orbit: cabin pressure at seal, cabin acoustics',
  approx(tele.cabinPressureKPa, 100) && tele.audioMode === 'cabin',
  `pressure=${tele.cabinPressureKPa} audio=${tele.audioMode}`,
);

// ---------------------------------------------------------------------------
// 2. Descent down-counts during burn / touchdown
// ---------------------------------------------------------------------------
section('2. altitude + velocity down-counts');

director.jumpToPhase('burn');
const burnStart = director.getTelemetry();
check(
  'burn: altitude starts at the 12,400 m datum',
  approx(burnStart.altitudeMeters, 12400, 1),
  `got ${burnStart.altitudeMeters}`,
);
director.update(0.5);
const burnMid = director.getTelemetry();
director.update(11.4); // stay inside the 12 s phase
const burnLate = director.getTelemetry();

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

// Touchdown closes to 0 m / 0 m/s.
director.jumpToPhase('touchdown');
const tdStart = director.getTelemetry();
director.update(3.49); // inside the 3.5 s phase
const tdEnd = director.getTelemetry();
check(
  'touchdown: altitude closes toward 0 m',
  tdStart.altitudeMeters > tdEnd.altitudeMeters && tdEnd.altitudeMeters < 2,
  `start=${tdStart.altitudeMeters} end=${tdEnd.altitudeMeters}`,
);
check(
  'touchdown: descent rate closes toward 0 m/s',
  tdStart.descentVelocityMps > tdEnd.descentVelocityMps &&
    tdEnd.descentVelocityMps < 0.06,
  `start=${tdStart.descentVelocityMps} end=${tdEnd.descentVelocityMps}`,
);

// ---------------------------------------------------------------------------
// 3. Depressurize: pressure vents + audioMode flips to vacuum
// ---------------------------------------------------------------------------
section('3. cabin pressure vent → vacuum acoustic cut');

director.jumpToPhase('depressurize');
const depStart = director.getTelemetry();
director.update(0.4); // still above the 5 kPa threshold
const depMid = director.getTelemetry();
director.update(3.6); // vents to ~0 (0.4 + 3.6 < 4 s)
const depEnd = director.getTelemetry();

check(
  'depressurize: pressure starts at cabin seal',
  approx(depStart.cabinPressureKPa, 100),
  `got ${depStart.cabinPressureKPa}`,
);
check(
  'depressurize: pressure vents toward 0.0 kPa',
  depMid.cabinPressureKPa < depStart.cabinPressureKPa &&
    depEnd.cabinPressureKPa < 1,
  `start=${depStart.cabinPressureKPa} mid=${depMid.cabinPressureKPa} end=${depEnd.cabinPressureKPa}`,
);
check(
  'audioMode flips cabin → vacuum below the 5 kPa threshold',
  depMid.audioMode === 'cabin' && depEnd.audioMode === 'vacuum',
  `mid=${depMid.audioMode} end=${depEnd.audioMode}`,
);

// Ramp / walkout: on the surface, full vacuum acoustics (§2.5–§2.6).
director.jumpToPhase('ramp');
const rampTele = director.getTelemetry();
check(
  'ramp: altitude 0 m, velocity 0 m/s, pressure 0 kPa, vacuum',
  approx(rampTele.altitudeMeters, 0) &&
    approx(rampTele.descentVelocityMps, 0) &&
    approx(rampTele.cabinPressureKPa, 0) &&
    rampTele.audioMode === 'vacuum',
);
director.jumpToPhase('walkout');
const walkTele = director.getTelemetry();
check(
  'walkout: still on the surface with vacuum acoustics',
  approx(walkTele.altitudeMeters, 0) && walkTele.audioMode === 'vacuum',
);

// ---------------------------------------------------------------------------
// 4. Vacuum ejecta burst on touchdown (NullEngine-safe)
// ---------------------------------------------------------------------------
section('4. vacuum ejecta particle burst (§2.3 / §4.4)');

// Reset clears the one-shot ejecta flag (Spec 24 §5.2 clean teardown), so a
// fresh run starts un-triggered.
director.reset();
director.jumpToPhase('orbit');
check(
  'ejecta not yet triggered before touchdown',
  director.getEjectaTriggered() === false,
);
director.jumpToPhase('touchdown');
check(
  'touchdown fires the ejecta burst without throwing under NullEngine',
  director.getEjectaTriggered() === true,
);

// ---------------------------------------------------------------------------
// 5. LunarHUD intro overlay renders + retracts
// ---------------------------------------------------------------------------
section('5. HUD intro telemetry overlay');

director.jumpToPhase('burn');
director.update(0.01);
const hudTele = hud.getIntroTelemetry();
check(
  'HUD received a live intro frame',
  hudTele !== null && hudTele.phase === 'burn',
);
check(
  'altitude readout painted in DOM',
  doc.getElementById('hud-intro-altitude-value')?.textContent?.includes(' m'),
  `got ${doc.getElementById('hud-intro-altitude-value')?.textContent}`,
);
check(
  'descent-rate readout painted in DOM',
  doc.getElementById('hud-intro-descent-value')?.textContent?.includes(' m/s'),
  `got ${doc.getElementById('hud-intro-descent-value')?.textContent}`,
);
check(
  'cabin-pressure readout painted in DOM',
  doc.getElementById('hud-intro-pressure-value')?.textContent?.includes(' kPa'),
  `got ${doc.getElementById('hud-intro-pressure-value')?.textContent}`,
);

// Hold-to-skip progress flows into the ring. updateSkipInput accumulates; a
// follow-up update() flushes telemetry to the HUD overlay.
director.updateSkipInput(true, SKIP_HOLD_THRESHOLD_S / 2);
director.update(0.001);
const skipEl = hud.getElement('intro-skip');
check(
  'skip-hold progress reaches the DOM ring',
  skipEl !== undefined &&
    Number(skipEl.getAttribute('data-progress')) > 0,
  `progress=${skipEl?.getAttribute('data-progress')}`,
);

// Retract on completed.
director.skipToFinish();
hud.updateIntroTelemetry(null);
check(
  'HUD retracts the intro panel on null',
  hud.getIntroTelemetry() === null &&
    doc.getElementById('lunar-hud-intro')?.className.includes('is-hidden'),
);

// ---------------------------------------------------------------------------
// 6. Director auto-pushes telemetry; passes null when idle/completed
// ---------------------------------------------------------------------------
section('6. auto telemetry push');

director.reset();
check(
  'reset retracts the HUD intro panel (null)',
  hud.getIntroTelemetry() === null,
);
check(
  'ejecta burst cleared on reset',
  director.getEjectaTriggered() === false,
);

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED ✔  (intro HUD + ejecta, Spec 24 Phase 3)`);
  director.dispose();
  hud.dispose();
  lander.dispose();
  engine.dispose();
  process.exit(0);
} else {
  console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  - ${f}`);
  director.dispose();
  hud.dispose();
  lander.dispose();
  engine.dispose();
  process.exit(1);
}
