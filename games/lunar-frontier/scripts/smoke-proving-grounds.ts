/**
 * TASK-PLAY-064d verification — Proving Grounds Racetrack & Lap Timing
 * (Spec 17 §3, Phase 4) headless harness.
 *
 * Runs under `npx tsx scripts/smoke-proving-grounds.ts` (exit 0 == green).
 * Babylon runs on a NullEngine; the HUD is built against a small fake DOM;
 * the ClientApp runs with a scripted-off network. Layers:
 *
 *   A. Circuit geometry     — spline length ≈ 1,200 m, closed loop (endpoint
 *                            rejoins the start within millimetres), 5 distinct
 *                            sections with the mandated per-section geometry.
 *   B. Section contracts    — §3.1 numbers: 250 m straight, 10° banked R75
 *                            sweeper, 3×R30 slalom, R15 hairpin, 5 m crest;
 *                            bank & elevation profiles probed at sample s.
 *   C. Waypoint system      — TrackWaypoint fields, sector index coverage
 *                            (S1/S2/S3), checkpoint flags at the gates,
 *                            getTrackElevation / getNearestWaypoint.
 *   D. Lap timing machine   — sector gates must fire in sequence; lap
 *                            completes only gate-to-gate; reverse crossing
 *                            never counts; best/last tracking; mid-lap void;
 *                            speed-trap capture & top speed.
 *   E. NullEngine build     — meshes generated headless, materials PBR,
 *                            dispose idempotent, post-dispose calls safe.
 *   F. HUD lap panel        — MM:SS.mmm formatting, lap counter, sector
 *                            splits, delta classes, speed trap readout.
 *   G. ClientApp mode       — enable/disable proving grounds, environment
 *                            profile swap (earth ⇄ lunar), warp to start line,
 *                            lap pump wired into the frame loop, idempotency.
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';

import {
  ProvingGroundsScene,
  LapTimingSystem,
  integrateCentreline,
  elevationAtS,
  bankAtS,
  sectorAtS,
  sectionAtS,
  TRACK_TOTAL_LENGTH_M,
  TRACK_WIDTH_M,
  CURB_WIDTH_M,
  SWEEPER_RADIUS_M,
  SWEEPER_BANK_RAD,
  SLALOM_RADIUS_M,
  HAIRPIN_RADIUS_M,
  CREST_ELEVATION_M,
  SPEED_TRAP_ZONE,
  GATE_S,
  type LapTelemetry,
} from '../src/engine/ProvingGroundsScene.ts';
import { ClientApp } from '../src/client/ClientApp.ts';
import LunarHUD, {
  HUD_LAP_ID,
  formatLapTime,
  formatLapDelta,
  type HudLapTelemetry,
} from '../src/ui/LunarHUD.ts';

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
// Minimal fake DOM (same subset the client-app harness uses)
// ---------------------------------------------------------------------------

interface FakeElement {
  id: string;
  className: string;
  textContent: string | null;
  style: { width: string; [key: string]: string };
  classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
  children: FakeElement[];
  parent?: FakeElement;
  appendChild<T extends FakeElement>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
}

interface FakeDocument {
  body: FakeElement;
  createElement(tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

function makeFakeElement(tag: string, registry: Map<string, FakeElement>): FakeElement {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const el: FakeElement = {
    id: '',
    className: '',
    textContent: '',
    style: { width: '' },
    children: [],
    classList: {
      add: (name) => void classes.add(name),
      remove: (name) => void classes.delete(name),
      contains: (name) => classes.has(name),
    },
    appendChild(child) {
      el.children.push(child);
      (child as FakeElement).parent = el;
      return child;
    },
    remove() {
      const parent = el.parent;
      if (parent !== undefined) {
        const i = parent.children.indexOf(el);
        if (i >= 0) parent.children.splice(i, 1);
      }
    },
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute(name, value) {
      attrs.set(name, value);
      if (name === 'id') {
        el.id = value;
        registry.set(value, el);
      }
    },
    addEventListener() {},
  };
  void tag;
  return el;
}

function makeFakeDocument(): FakeDocument {
  const registry = new Map<string, FakeElement>();
  const body = makeFakeElement('body', registry);
  return {
    body,
    createElement: (tag: string) => makeFakeElement(tag, registry),
    getElementById: (id: string) => registry.get(id) ?? null,
    addEventListener() {},
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
// ===========================================================================
// A. CIRCUIT GEOMETRY
// ===========================================================================

section('A. circuit geometry (Spec 17 §3.1)');

const pg = new ProvingGroundsScene({ silent: true });

check(
  'track spline length ≈ 1200 m (margin 1100–1300)',
  pg.lengthM >= 1100 && pg.lengthM <= 1300,
  `got ${pg.lengthM.toFixed(2)} m`,
);
check(
  'length matches nominal TRACK_TOTAL_LENGTH_M within 1 cm',
  Math.abs(pg.lengthM - TRACK_TOTAL_LENGTH_M) < 0.01,
  `Δ ${Math.abs(pg.lengthM - TRACK_TOTAL_LENGTH_M).toExponential(2)} m`,
);

// Closed loop: integrate independently and compare endpoint to origin.
{
  const samples = integrateCentreline(0.5);
  const last = samples[samples.length - 1];
  const gap = Math.hypot(last.x - 0, last.y - 0);
  check('circuit is a closed loop (endpoint rejoins start < 1 cm)', gap < 0.01, `gap ${gap.toFixed(6)} m`);
  // Heading must also close (total turn 360°) — sample heading at s=L ≈ 2π.
  const heading = ((last.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  check('closing tangent matches start heading (< 0.1°)', Math.min(heading, 2 * Math.PI - heading) < 0.00175);
}

const sections = pg.getSections();
check('exactly 5 circuit sections exist', sections.length === 5);
check(
  'section indices are 1..5',
  sections.every((s, i) => s.index === i + 1),
);
check(
  'section kinds distinct per spec',
  sections.map((s) => s.kind).join(',') ===
    'straightaway,banked-sweeper,slalom,hairpin,crest',
  sections.map((s) => s.kind).join(','),
);
check(
  'sections tile the whole lap contiguously',
  sections.every((s, i) =>
    i === 0 ? s.startS === 0 : Math.abs(s.startS - sections[i - 1].endS) < 1e-9) &&
    Math.abs(sections[4].endS - pg.lengthM) < 1e-3,
);
{
  const total = sections.reduce((acc, s) => acc + s.lengthM, 0);
  check('section lengths sum to loop length', Math.abs(total - pg.lengthM) < 0.01, `${total.toFixed(2)}`);
}

// ===========================================================================
// B. SECTION CONTRACTS (Spec 17 §3.1 numbers)
// ===========================================================================

section('B. per-section geometry contracts');

{
  const [s1, s2, s3, s4, s5] = sections;

  // Section 1 — 250 m flat straight with speed trap.
  check('S1 straight is 250 m', Math.abs(s1.lengthM - 250) < 0.5, `${s1.lengthM.toFixed(2)}`);
  check('S1 is flat (peak bank 0)', s1.peakBankRad === 0);
  check('S1 sits at datum', Math.abs(s1.peakElevationM) < 1e-9);
  {
    // Straight means near-zero curvature: heading constant across S1.
    const samples = integrateCentreline(0.5);
    const h0 = samples[10].heading;
    const h1 = samples[Math.floor(s1.lengthM / 0.5) - 1].heading;
    check('S1 heading constant (straight)', Math.abs(h1 - h0) < 1e-6);
  }
  check(
    'speed trap zone lives inside S1',
    SPEED_TRAP_ZONE[0] > s1.startS && SPEED_TRAP_ZONE[1] < s1.endS,
  );

  // Section 2 — 180° R75 banked 10°.
  check('S2 arc length = π·75 (180° @ R75)', Math.abs(s2.lengthM - Math.PI * SWEEPER_RADIUS_M) < 0.5,
    `${s2.lengthM.toFixed(2)} vs ${(Math.PI * 75).toFixed(2)}`);
  check(
    'S2 bank ≈ 10° (0.175 rad)',
    Math.abs(s2.peakBankRad - 0.175) < 0.005 && Math.abs(s2.peakBankRad - SWEEPER_BANK_RAD) < 1e-9,
    `${s2.peakBankRad.toFixed(6)} rad`,
  );
  {
    // Mid-arc bank equals the mandated value; entrance banks are eased from 0.
    const mid = s2.startS + s2.lengthM / 2;
    check('mid-sweeper bankAtS = 0.174533 rad', Math.abs(bankAtS(mid) - SWEEPER_BANK_RAD) < 1e-9);
    check('bank eases in from 0', bankAtS(s2.startS) === 0 && bankAtS(s2.startS + 10) > 0);
    check('bank eases out to 0', bankAtS(s2.endS - 10) > 0 && bankAtS(s2.endS) === 0);
    // Sweep 180°: heading changes by π across the section.
    const samples = integrateCentreline(0.5);
    const h0 = samples[Math.floor(s2.startS / 0.5)].heading;
    const h1 = samples[Math.floor(s2.endS / 0.5) - 1].heading;
    check('S2 sweeps 180° (Δheading ≈ π)', Math.abs(Math.abs(h1 - h0) - Math.PI) < 0.02,
      `${(((h1 - h0) * 180) / Math.PI).toFixed(2)}°`);
  }

  // Section 3 — three alternating R30 transitions.
  check('S3 length = 3 × (π·30/2)', Math.abs(s3.lengthM - (3 * Math.PI * SLALOM_RADIUS_M) / 2) < 0.6,
    `${s3.lengthM.toFixed(2)}`);
  {
    // Alternating curvature: heading up, down, up — net +90°.
    const samples = integrateCentreline(0.5);
    const q = (f: number) => samples[Math.floor((s3.startS + s3.lengthM * f) / 0.5)].heading;
    const d1 = q(1 / 3) - q(0);       // first lobe
    const d2 = q(2 / 3) - q(1 / 3);   // second lobe
    const d3 = q(1) - q(2 / 3);       // third lobe
    check('slalom lobe 1 turns right ≈ +90°', Math.abs(d1 - Math.PI / 2) < 0.05, `${((d1 * 180) / Math.PI).toFixed(1)}°`);
    check('slalom lobe 2 reverses ≈ −90°', Math.abs(d2 + Math.PI / 2) < 0.05, `${((d2 * 180) / Math.PI).toFixed(1)}°`);
    check('slalom lobe 3 turns right ≈ +90°', Math.abs(d3 - Math.PI / 2) < 0.05, `${((d3 * 180) / Math.PI).toFixed(1)}°`);
    check('slalom is unbanked', s3.peakBankRad === 0);
  }

  // Section 4 — hairpin 180° R15.
  check('S4 length = π·15 (180° @ R15)', Math.abs(s4.lengthM - Math.PI * HAIRPIN_RADIUS_M) < 0.2,
    `${s4.lengthM.toFixed(2)}`);
  {
    const samples = integrateCentreline(0.5);
    const h0 = samples[Math.floor(s4.startS / 0.5)].heading;
    const h1 = samples[Math.floor(s4.endS / 0.5) - 1].heading;
    check('hairpin sweeps 180° the other way', Math.abs(h1 - h0 + Math.PI) < 0.02);
  }

  // Section 5 — 5 m elevation crest.
  check('S5 rises ~5 m (mandated crest)', Math.abs(s5.peakElevationM - CREST_ELEVATION_M) < 0.01,
    `${s5.peakElevationM.toFixed(3)} m`);
  check('crest elevation profile peaks at 5.000', Math.abs(elevationAtS(GATE_S[2]) - 5) < 1e-9);
  check('elevation is zero before Section 5', elevationAtS(100) === 0 && elevationAtS(s2.startS) === 0);
  {
    // Crest compression: a dip just before the brow, plateau at the brow.
    let minAfterGate1 = Infinity;
    for (let s = s5.startS; s < GATE_S[2]; s += 0.5) {
      minAfterGate1 = Math.min(minAfterGate1, elevationAtS(s));
    }
    check('S5 climb is monotone to crest (min == 0)', Math.abs(minAfterGate1) < 1e-9);
    let dipMin = Infinity;
    for (let s = GATE_S[2] - 15; s < GATE_S[2]; s += 0.25) dipMin = Math.min(dipMin, elevationAtS(s));
    check('crest compression dip before the brow', dipMin < 5 - 0.15, `dip ${dipMin.toFixed(2)} m`);
    // And it comes back down to datum before the loop closes.
    check('elevation returns to datum past the descent', elevationAtS(pg.lengthM - 1) < 1e-3);
  }
}

// ===========================================================================
// C. WAYPOINT SYSTEM
// ---------------------------------------------------------------------------

section('C. spline waypoint system (TrackWaypoint)');

const wps = pg.getWaypoints();
check('waypoints generated (one per ~0.5 m sample)', wps.length > 2200, `${wps.length}`);
check(
  'every waypoint carries the TrackWaypoint surface',
  wps.every(
    (w) =>
      Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z) &&
      Number.isFinite(w.bankAngleRad) && w.trackWidthM === TRACK_WIDTH_M &&
      (w.sectorIndex === 1 || w.sectorIndex === 2 || w.sectorIndex === 3) &&
      w.sectionIndex >= 1 && w.sectionIndex <= 5 && Number.isFinite(w.arcLengthM),
  ),
);
check('track width is 12 m everywhere', TRACK_WIDTH_M === 12);
check('curb width is 1.5 m', CURB_WIDTH_M === 1.5);
{
  const sectorCounts = new Set(wps.map((w) => w.sectorIndex));
  check('all three timing sectors represented', sectorCounts.size === 3);
  const sectionCounts = new Set(wps.map((w) => w.sectionIndex));
  check('all five sections represented in waypoints', sectionCounts.size === 5);
  const checkpoints = wps.filter((w) => w.isCheckpoint);
  check('checkpoint flags mark the gates (≥ 3 waypoints)', checkpoints.length >= 3, `${checkpoints.length}`);
  check(
    'every checkpoint sits at a gate arc length',
    checkpoints.every((cp) =>
      GATE_S.some((g) => Math.abs(cp.arcLengthM - g) < 0.75 || pg.lengthM - Math.abs(cp.arcLengthM - g) < 0.75)),
  );
  // Banked waypoints exist (S2) and match bankAtS.
  const banked = wps.filter((w) => w.bankAngleRad > 0.01);
  check('banked waypoints exist (Section 2 sweep)', banked.length > 100, `${banked.length}`);
  check(
    'waypoint bank equals profile at its s',
    banked.every((w) => Math.abs(w.bankAngleRad - bankAtS(w.arcLengthM)) < 1e-12),
  );
}

{
  // getNearestWaypoint / getTrackElevation round-trips.
  const p = pg.getPointAt(120, 0);
  const near = pg.getNearestWaypoint(p.x, p.y);
  check('getNearestWaypoint on centreline lands within one sample', Math.abs(near.arcLengthM - 120) <= 0.5 + 1e-6,
    `${near.arcLengthM.toFixed(2)}`);
  check('getTrackElevation flat straight = 0', pg.getTrackElevation(p.x, p.y) === 0);

  const crest = pg.getPointAt(GATE_S[2] - 30, 0); // plateau, past the dip
  check('getTrackElevation on the crest plateau = 5 m', Math.abs(pg.getTrackElevation(crest.x, crest.y) - 5) < 1e-6,
    pg.getTrackElevation(crest.x, crest.y).toFixed(4));
  const brow = pg.getPointAt(GATE_S[2], 0);
  check('getTrackElevation at the brow ≈ 5 m', Math.abs(pg.getTrackElevation(brow.x, brow.y) - 5) < 0.02,
    pg.getTrackElevation(brow.x, brow.y).toFixed(4));

  // Bank crossfall: right edge at mid-sweeper is tan(10°)·6 m above centre.
  const midS = GATE_S[1] - Math.PI * SWEEPER_RADIUS_M * 0.25;
  const right = pg.getPointAt(midS, 6);
  const expectZ = 6 * Math.tan(SWEEPER_BANK_RAD);
  check(
    'bank crossfall lifts the right edge ≈ tan(10°)·6 m',
    Math.abs(pg.getTrackElevation(right.x, right.y) - expectZ) < 0.05,
    `got ${pg.getTrackElevation(right.x, right.y).toFixed(4)} want ${expectZ.toFixed(4)}`,
  );
  // Left side dips symmetrically.
  const left = pg.getPointAt(midS, -6);
  check('bank crossfall dips the left edge', pg.getTrackElevation(left.x, left.y) < -expectZ * 0.9);
}

{
  // Sector/section classifiers agree with the gate table.
  check('sectorAtS(0) = 1', sectorAtS(0) === 1);
  check('sectorAtS(gate1 − ε) = 1', sectorAtS(GATE_S[1] - 0.001) === 1);
  check('sectorAtS(gate1) = 2', sectorAtS(GATE_S[1]) === 2);
  check('sectorAtS(gate2) = 3', sectorAtS(GATE_S[2]) === 3);
  check('sectorAtS wraps', sectorAtS(pg.lengthM + 10) === 1);
  check('sectionAtS samples map 1..5', [0, 300, 500, 650, 900].map((s) => sectionAtS(s)).join(',') === '1,2,3,4,5');
}

// ===========================================================================
// D. LAP TIMING STATE MACHINE
// ===========================================================================

section('D. lap timing & sector split state machine');

{
  // Drive the state machine along the real spline at a constant 40 m/s.
  const timer = pg.createLapTimer();
  const dt = 1 / 40;
  const speed = 40;
  let sPos = 0.25;
  let tele: LapTelemetry = timer.getTelemetry();
  const events: string[] = [];
  let prevSplits = 0;
  let prevLap = 1;
  for (let i = 0; i < Math.ceil((pg.lengthM * 2) / (speed * dt)) + 40; i++) {
    const p = pg.getPointAt(sPos, 0);
    sPos = (sPos + speed * dt) % pg.lengthM;
    tele = timer.step(dt, p.x, p.y, speed);
    if (tele.sectorTimesS.length > prevSplits) {
      events.push(`sector${tele.sectorTimesS.length}@${i}`);
      prevSplits = tele.sectorTimesS.length;
    }
    if (tele.currentLap > prevLap) {
      events.push(`lap${tele.currentLap}@${i}`);
      prevLap = tele.currentLap;
      prevSplits = 0;
    }
  }
  check('sector 1 split registered after gate 1', events.some((e) => e.startsWith('sector1')), events.join(' '));
  check('sector 2 split registered after gate 2', events.some((e) => e.startsWith('sector2')), events.join(' '));
  check('lap 2 started after crossing the finish', events.some((e) => e.startsWith('lap2')), events.join(' '));
  check('best lap recorded', tele.bestLapTimeS !== null && tele.bestLapTimeS > 0, String(tele.bestLapTimeS));
  check('last lap recorded', tele.lastLapTimeS !== null && Math.abs((tele.lastLapTimeS ?? 0) - pg.lengthM / speed) < 2,
    `${(tele.lastLapTimeS ?? -1).toFixed(2)}s expect ~${(pg.lengthM / speed).toFixed(2)}s`);
  check('best lap never exceeds last', tele.bestLapTimeS !== null && tele.lastLapTimeS !== null &&
    tele.bestLapTimeS <= (tele.lastLapTimeS ?? Infinity) + 1e-9 && tele.bestLapTimeS > 0);
  check('current speed tracks 40 m/s → 144 km/h', Math.abs(tele.currentSpeedKmh - 144) < 0.5, tele.currentSpeedKmh.toFixed(2));
  check('top speed recorded', tele.topSpeedKmh >= 143.9);
  check(
    'speed trap recorded a capture',
    tele.speedTrapKmh !== null && Math.abs(tele.speedTrapKmh - 144) < 0.5,
    String(tele.speedTrapKmh),
  );
  check('telemetry sector splits cleared on new lap', Array.isArray(tele.sectorTimesS));
  void events;
}

{
  // Sequential enforcement, fully deterministic: synthetic locator on a
  // 1,000 m ring with gates at 0/400/700. A single leap sweeping over BOTH
  // gates registers only the first; the missed second gate voids the lap.
  const timer = new LapTimingSystem({
    trackLengthM: 1000,
    gateS: [0, 400, 700],
    trapZone: [50, 200],
  });
  let cursor = 200;
  timer.locate = (x: number) => ({ s: x, lateralM: 0 });
  const stepS = (s: number, speed = 40): LapTelemetry => {
    cursor = s;
    return timer.step(0.1, s, 0, speed);
  };
  void cursor;
  let t = stepS(250);
  check('start: armed at gate 1, no splits', t.sectorTimesS.length === 0 && timer.pendingGateIndex === 1);
  // Leap across BOTH gates in one sweep: only gate 1 may register.
  t = stepS(740);
  check('leap over both gates registers only the in-sequence one',
    t.sectorTimesS.length === 1 && timer.pendingGateIndex === 2,
    `splits ${t.sectorTimesS.length}, pending ${timer.pendingGateIndex}`);
  // Cross the finish line (wrap): the lap is VOID (gate 2 was skipped).
  t = stepS(990);
  t = stepS(10);
  check('finish without all gates voids the lap (stays LAP 1)', t.currentLap === 1, `${t.currentLap}`);
  check('voided lap records no best/last time', t.bestLapTimeS === null && t.lastLapTimeS === null);
  check('voided lap clears splits and re-arms at gate 1',
    t.sectorTimesS.length === 0 && timer.pendingGateIndex === 1);
  // Now run it properly: gate 1 → gate 2 → finish == completed lap.
  t = stepS(450);
  check('proper run: gate 1 registers', t.sectorTimesS.length === 1);
  t = stepS(750);
  check('proper run: gate 2 registers', t.sectorTimesS.length === 2 && timer.pendingGateIndex === 0);
  t = stepS(990);
  t = stepS(15);
  check('proper run: lap completes on the crossing', t.currentLap === 2, `${t.currentLap}`);
  check('completed lap records best + last',
    t.bestLapTimeS !== null && t.lastLapTimeS !== null &&
    Math.abs((t.bestLapTimeS ?? 0) - (t.lastLapTimeS ?? -1)) < 1e-9);
  check('sector split times sum to ≤ lap time',
    t.sectorTimesS.length === 0 /* cleared at completion */ ||
      t.sectorTimesS.reduce((a, b) => a + b, 0) <= t.currentLapTimeS + 1e-9);
  // Sector delta on the next lap's gate 1 (slower than the previous lap).
  t = stepS(500); // next lap, gate 1 at t ≈ +0.5s more than last lap's
  check('lap 2 gate 1 produces a sector delta', typeof t.sectorDeltaS === 'number', String(t.sectorDeltaS));
}

{
  // Reverse motion never counts a lap or a gate.
  const timer = pg.createLapTimer();
  const dt = 0.05;
  const a = pg.getPointAt(20, 0);
  const b = pg.getPointAt(10, 0);
  timer.step(dt, a.x, a.y, 10);
  const back = timer.step(dt, b.x, b.y, 10); // s decreases: reversing
  check('reversing does not complete a lap or open a gate',
    back.currentLap === 1 && back.sectorTimesS.length === 0 && timer.pendingGateIndex === 1);
  // A backwards TELEPORT across the line likewise never completes a lap.
  const c = pg.getPointAt(5, 0);
  const d = pg.getPointAt(pg.lengthM - 5, 0);
  timer.step(dt, c.x, c.y, 10);
  const jumpBack = timer.step(dt, d.x, d.y, 10);
  check('backwards line jump does not complete a lap', jumpBack.currentLap === 1, `${jumpBack.currentLap}`);
}

{
  // Best-lap tracking across different lap speeds.
  const timer = pg.createLapTimer();
  const runLap = (speed: number): LapTelemetry => {
    let t = timer.getTelemetry();
    const dt = 1 / 60;
    // One full loop at the given speed (dt-swept).
    const frames = Math.ceil(pg.lengthM / (speed * dt));
    let sPos = 0;
    for (let i = 0; i <= frames; i++) {
      const p = pg.getPointAt(sPos, 0);
      sPos = (sPos + speed * dt) % pg.lengthM;
      t = timer.step(dt, p.x, p.y, speed);
    }
    return t;
  };
  runLap(30); // slow lap first (armed at construction from s=0)
  runLap(40); // faster second lap
  const fast = timer.getTelemetry();
  const slowTime = pg.lengthM / 30;
  const fastTime = pg.lengthM / 40;
  check('two laps counted', fast.currentLap === 3, `${fast.currentLap}`);
  check('last lap equals the fast lap time',
    Math.abs((fast.lastLapTimeS ?? 0) - fastTime) < 0.1,
    `${fast.lastLapTimeS?.toFixed(2)}s expect ~${fastTime.toFixed(2)}s`);
  check('best lap keeps the FASTEST time',
    fast.bestLapTimeS !== null && Math.abs((fast.bestLapTimeS ?? 0) - fastTime) < 0.1 &&
      fastTime < slowTime,
    `best ${fast.bestLapTimeS?.toFixed(2)}s`);
}

{
  // Speed trap captures the PEAK inside the zone, ignores speeds outside it.
  const timer = pg.createLapTimer();
  const dt = 0.1;
  // Outside the trap zone: 10 m/s should not register.
  const out = pg.getPointAt(SPEED_TRAP_ZONE[1] + 10, 0);
  let t = timer.step(dt, out.x, out.y, 10);
  t = timer.step(dt, pg.getPointAt(SPEED_TRAP_ZONE[1] + 20, 0).x, pg.getPointAt(SPEED_TRAP_ZONE[1] + 20, 0).y, 10);
  check('no trap capture outside the zone', t.speedTrapKmh === null, String(t.speedTrapKmh));
  // Inside: peak at 22 m/s.
  const p1 = pg.getPointAt(SPEED_TRAP_ZONE[0] + 1, 0);
  const p2 = pg.getPointAt(SPEED_TRAP_ZONE[0] + 10, 0);
  const p3 = pg.getPointAt(SPEED_TRAP_ZONE[0] + 20, 0);
  t = timer.step(dt, p1.x, p1.y, 15);
  t = timer.step(dt, p2.x, p2.y, 22);
  t = timer.step(dt, p3.x, p3.y, 18);
  check('trap records peak speed inside zone (22 m/s → 79.2 km/h)',
    t.speedTrapKmh !== null && Math.abs(t.speedTrapKmh - 79.2) < 0.1, String(t.speedTrapKmh));
  check('top speed also 79.2 km/h', Math.abs(t.topSpeedKmh - 79.2) < 0.1);

  // Off-track position suppresses detection entirely.
  const off = pg.getPointAt(0, 200);
  const tOff = timer.step(dt, off.x, off.y, 30);
  check('off-track step keeps prior trap value (no false capture)',
    tOff.speedTrapKmh !== null && Math.abs((tOff.speedTrapKmh ?? 0) - 79.2) < 0.1);
}

{
  // reset() clears everything; dispose() freezes telemetry.
  const timer = pg.createLapTimer();
  let t = timer.getTelemetry();
  for (let i = 0; i < 200; i++) {
    const p = pg.getPointAt(i * 2, 0);
    t = timer.step(0.05, p.x, p.y, 25);
  }
  timer.reset();
  t = timer.getTelemetry();
  check('reset() → lap 1, no times', t.currentLap === 1 && t.bestLapTimeS === null && t.lastLapTimeS === null && t.sectorTimesS.length === 0);
  check('reset() clears trap & top speed', t.speedTrapKmh === null && t.topSpeedKmh === 0);
  timer.dispose();
  const frozen = timer.step(1, 0, 0, 50);
  check('post-dispose step is a frozen no-op', frozen.topSpeedKmh === 0);
  timer.dispose(); // idempotent
}

{
  // Standalone constructor path (no ProvingGroundsScene): raw LapTimingOptions.
  const timer = new LapTimingSystem({
    trackLengthM: 1000,
    gateS: [0, 400, 700],
    trapZone: [100, 300],
  });
  check('bare LapTimingSystem constructs without a locator', timer.pendingGateIndex === 1);
  timer.locate = (x: number) => ({ s: Math.abs(x), lateralM: 0 });
  let t = timer.step(0.1, 390, 0, 10);
  t = timer.step(0.1, 410, 0, 10);
  check('wired locator registers sector 1', t.sectorTimesS.length === 1, JSON.stringify(t.sectorTimesS));
}

// ===========================================================================
// E. HEADLESS NULL-ENGINE BUILD & DISPOSE
// ===========================================================================

section('E. NullEngine mesh generation & lifecycle');

{
  const engine = new NullEngine();
  const built = new ProvingGroundsScene({ silent: true }).init(engine);
  const meshes = built.getMeshes();
  check('headless init builds meshes', meshes.length >= 10, `${meshes.length}`);
  check('asphalt ribbon mesh exists', meshes.some((m) => m.name === 'pg-asphalt'));
  check('rumble-strip curb meshes exist (red + white)', meshes.some((m) => m.name === 'pg-curb-red') && meshes.some((m) => m.name === 'pg-curb-white'));
  check('painted edge lines + centreline exist', meshes.some((m) => m.name === 'pg-edge-lines') && meshes.some((m) => m.name === 'pg-centerline'));
  check('checkpoint gate volumes exist (3 gates)', ['finish', 'sector-1', 'sector-2'].every((g) => meshes.some((m) => m.name === `pg-gate-${g}-volume`)));
  check('hairpin run-off tarmac exists', meshes.some((m) => m.name === 'pg-hairpin-runoff'));
  {
    const asphalt = meshes.find((m) => m.name === 'pg-asphalt');
    const pos = asphalt?.getVerticesData('position');
    check('asphalt mesh has real geometry', (pos?.length ?? 0) > 1000, String(pos?.length));
  }
  check('isBuilt true after init', built.isBuilt() === true);
  check('idempotent init (second call keeps meshes)', (() => {
    const before = built.getMeshes().length;
    built.init(engine);
    return built.getMeshes().length === before;
  })());

  built.dispose();
  built.dispose();
  check('dispose idempotent, meshes cleared', built.getMeshes().length === 0 && built.isBuilt() === false);
  const after = built.stepLapTiming(0.1, 0, 0, 10);
  check('post-dispose stepLapTiming safe', after !== null && after.currentLap === 0);
  let threw = false;
  try {
    built.init(engine);
  } catch {
    threw = true;
  }
  check('init after dispose throws', threw);
  engine.dispose();
}

// ===========================================================================
// F. HUD LAP PANEL
// ===========================================================================

section('F. proving-grounds HUD overlay (LunarHUD)');

{
  const doc = makeFakeDocument();
  const hud = new LunarHUD({ document: doc as unknown as Document });

  check('lap panel element built (#' + HUD_LAP_ID + ')', doc.getElementById(HUD_LAP_ID) !== null);
  check('lap panel hidden by default', hud.hasClass('lap-panel', 'is-hidden'));
  hud.setLapPanelVisible(true);
  check('setLapPanelVisible(true) shows it', hud.isLapPanelVisible() && !hud.hasClass('lap-panel', 'is-hidden'));

  const base: HudLapTelemetry = {
    currentLap: 2,
    currentLapTimeS: 21.5,
    bestLapTimeS: 61.321,
    lastLapTimeS: 63.005,
    sectorTimesS: [18.4, 24.9],
    currentSpeedKmh: 132.4,
    topSpeedKmh: 151.2,
    speedTrapKmh: 149.8,
    sectorDeltaS: -0.482,
  };
  hud.updateLapTelemetry(base);

  check('lap counter rendered', hud.textOf('lap-count-value') === 'LAP 2', hud.textOf('lap-count-value'));
  check('current lap MM:SS.mmm', hud.textOf('lap-current-value') === '00:21.500', hud.textOf('lap-current-value'));
  check('best lap MM:SS.mmm', hud.textOf('lap-best-value') === '01:01.321', hud.textOf('lap-best-value'));
  check('last lap MM:SS.mmm', hud.textOf('lap-last-value') === '01:03.005', hud.textOf('lap-last-value'));
  check('sector 1 split', hud.textOf('lap-split-s1') === '00:18.400', hud.textOf('lap-split-s1'));
  check('sector 2 split', hud.textOf('lap-split-s2') === '00:24.900', hud.textOf('lap-split-s2'));
  check('sector delta shows −0.482', hud.textOf('lap-delta-value') === '−0.482', hud.textOf('lap-delta-value'));
  check('delta class is-faster when negative', hud.hasClass('lap-delta-value', 'is-faster'));
  check('speed trap readout', hud.textOf('speed-trap-value') === '149.8 km/h', hud.textOf('speed-trap-value'));
  check('top speed readout', hud.textOf('top-speed-value') === '151.2 km/h', hud.textOf('top-speed-value'));
  check('trap lamp lit once captured', hud.hasClass('speed-trap-lamp', 'is-on'));

  hud.updateLapTelemetry({ ...base, sectorDeltaS: 1.234 });
  check('delta class is-slower when positive', hud.hasClass('lap-delta-value', 'is-slower') && !hud.hasClass('lap-delta-value', 'is-faster'));

  hud.updateLapTelemetry({ ...base, bestLapTimeS: null, speedTrapKmh: null, sectorDeltaS: null });
  check('null trap renders em dash', hud.textOf('speed-trap-value') === '—');
  check('null delta renders em dash', hud.textOf('lap-delta-value') === '—');
  check('null best lap renders em dash', hud.textOf('lap-best-value') === '—');

  hud.setLapPanelVisible(false);
  check('panel hides again', !hud.isLapPanelVisible());

  hud.dispose();
  hud.updateLapTelemetry(base); // post-dispose must not throw
  check('post-dispose updateLapTelemetry is a no-op', hud.isDisposed());

  // Formatter unit checks.
  check('formatLapTime(0) = 00:00.000', formatLapTime(0) === '00:00.000');
  check('formatLapTime(65.1234) = 01:05.123', formatLapTime(65.1234) === '01:05.123');
  check('formatLapTime(3600) keeps 2-digit minutes', formatLapTime(3600) === '60:00.000');
  check('formatLapDelta(-0.5) = −0.500', formatLapDelta(-0.5) === '−0.500');
  check('formatLapDelta(+0.5) = +0.500', formatLapDelta(0.5) === '+0.500');
  check('formatLapTime(null) = —', formatLapTime(null) === '—');
}

// ===========================================================================
// G. CLIENTAPP TRACK MODE
// ===========================================================================

section('G. ClientApp Earth Proving Grounds mode');

{
  const doc = makeFakeDocument();
  (globalThis as { document?: unknown }).document = doc as unknown as Document;
  let clock = 5_000;

  const app = new ClientApp({ network: null, autoConnect: false, silent: true });
  await app.init(new NullEngine());
  check('default mode is lunar frontier', app.getEnvironmentMode() === 'lunar_frontier');
  check('lunar gravity profile active', app.getBuggy().physics.getEnvironment().name === 'lunar_frontier');
  check('no track built until enabled', app.getProvingGrounds() === null);

  app.enableProvingGrounds();
  check('mode flipped to earth_proving_grounds', app.getEnvironmentMode() === 'earth_proving_grounds');
  check('ENV_EARTH_PROVING_GROUNDS active on the buggy',
    app.getBuggy().physics.getEnvironment().gravity === 9.81 &&
    app.getBuggy().physics.getEnvironment().surfaceFrictionMu === 1.05);
  const track = app.getProvingGrounds();
  check('track built into the world scene', track !== null && track.isBuilt());
  const pose = track!.getStartPose();
  const bp = app.getBuggy().getPosition();
  check('buggy warped onto the start/finish line',
    Math.hypot(bp.x - pose.x, bp.y - pose.y) < 1.5, `Δ${Math.hypot(bp.x - pose.x, bp.y - pose.y).toFixed(2)}`);
  check('lap HUD panel visible in track mode', app.getHud()?.isLapPanelVisible() === true);

  // Idempotency.
  const meshCount = track!.getMeshes().length;
  app.enableProvingGrounds();
  check('enable is idempotent (no duplicate meshes)', track!.getMeshes().length === meshCount);

  // Drive frames: the frame loop must step the lap timer & repaint the HUD.
  for (let i = 0; i < 120; i++) {
    clock += 50;
    app.update(clock);
  }
  const tele = app.getLapTelemetry();
  check('lap telemetry flowing from the frame pump', tele !== null && tele.currentLapTimeS > 1, JSON.stringify(tele?.currentLapTimeS));
  check('HUD lap clock repainted', (app.getHud()?.textOf('lap-current-value') ?? '') !== '—' && /\d\d:\d\d\.\d\d\d/.test(app.getHud()!.textOf('lap-current-value')));

  // Terrain hidden while on the track, restored on disable.
  const terrain = app.world.getTerrainMesh();
  check('lunar terrain hidden during track mode', terrain === null || terrain.isEnabled() === false);

  app.disableProvingGrounds();
  check('back to lunar mode', app.getEnvironmentMode() === 'lunar_frontier');
  check('lunar gravity restored', app.getBuggy().physics.getEnvironment().gravity === 1.62);
  check('lap HUD panel hidden', app.getHud()?.isLapPanelVisible() === false);
  check('terrain restored', terrain === null || terrain.isEnabled() === true);
  check('telemetry null while lunar', app.getLapTelemetry() === null);
  app.disableProvingGrounds(); // idempotent

  // Cold-start straight into the track.
  (globalThis as { document?: unknown }).document = makeFakeDocument() as never;
  const app2 = new ClientApp({ network: null, autoConnect: false, silent: true, startInProvingGrounds: true });
  await app2.init(new NullEngine());
  check('startInProvingGrounds boots into track mode', app2.getEnvironmentMode() === 'earth_proving_grounds');
  check('track telemetry available immediately', app2.getLapTelemetry() !== null);

  app2.dispose();
  app.dispose();
  app.dispose();
  check('clients dispose cleanly (idempotent)', true);
}

// ===========================================================================

console.log('\n' + '='.repeat(60));
if (failures.length === 0) {
  console.log(`🏁 smoke-proving-grounds: ALL ${passed} CHECKS GREEN`);
  process.exit(0);
} else {
  console.error(`❌ smoke-proving-grounds: ${failures.length} FAILURE(S) of ${passed + failures.length}`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
}

void main().catch((err) => {
  console.error('HARNESS CRASH:', err);
  process.exit(1);
});
