/**
 * Spec 29 Phase 6 — Headless Smoke Acceptance Suite: Frontier Radio Tower,
 * Ladder Kinematics & Observation Deck.
 * Run: `npx tsx scripts/smoke-radio-tower.ts`  (exit code 0 == all green)
 *
 * Exercises every acceptance gate of Spec 29 §6 end to end, fully headless
 * (Babylon `NullEngine`, fake DOM, mock Web Audio — no WebGL, no audio
 * hardware, no network):
 *
 *   GATE 1  Procedural Assembly & Geometry: canonical seat (-1550, 2320),
 *           summit deck +48.0 m, ≥ 120 rungs at Δz ≤ 0.40 m uniform pitch,
 *           WorldScene terrain anchoring + idempotent build, complete
 *           idempotent dispose with zero orphaned nodes / materials,
 *           deterministic re-instantiation.
 *   GATE 2  Proximity & Detection Envelope: 1.8 m ladder-base cylinder,
 *           1.0 m summit-hatch envelope, out-of-envelope answers false,
 *           NaN-hardened.
 *   GATE 3  Climbing Kinematics: rail lock Δxy ≤ 0.05 m, 2.2 ± 0.3 m/s
 *           standard climb, 3.6 ± 0.4 m/s sprint climb, mechanical hold
 *           vz = 0 (no gravity slide), low-g rung hop apex ≥ 2.5 m, summit
 *           step-off onto the deck → WALK, base step-off onto regolith →
 *           WALK.
 *   GATE 4  Audio / HUD / Visuals / Lifecycle Integration: REAL ClientApp
 *           on NullEngine driving a built radio tower — latch clang, 0.35 s
 *           rung-step cadence, HOLD band, summit chime, altimeter tape law
 *           ("ALT +42.5m [DECK 48m]"), "FRONTIER RELAY 04" landmark banners
 *           with hysteresis, climb grip articulation law, deck-perimeter
 *           railing containment with the hatch gap, aviation beacon pulse,
 *           and clean throw-free disposal.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';

import {
  RadioTower,
  RADIO_TOWER_DEFAULTS,
  RADIO_TOWER_NAME_PREFIX,
  LADDER_RUNG_PITCH_M,
  LADDER_BASE_DETECT_RADIUS_M,
  HATCH_DETECT_RADIUS_M,
} from '../src/infrastructure/RadioTower.ts';
import { WorldScene } from '../src/engine/index.ts';
import {
  LunarEvaSuit,
  IDLE_SUIT_INPUT,
  LUNAR_GRAVITY,
  LADDER_CLIMB_SPEED,
  LADDER_CLIMB_SPRINT_SPEED,
  LADDER_HOP_VZ,
  LADDER_BODY_RAIL_OFFSET_M,
  type LadderBounds,
  type SuitInput,
  type GroundElevationFn,
} from '../src/physics/TraversalPhysics';
import {
  climbGripPose,
  climbInwardHeadingRad,
  CLIMB_SHOULDER_FLEX_RAD,
  CLIMB_ELBOW_FLEX_RAD,
  CLIMB_KNEE_HOLD_RAD,
  CLIMB_CYCLE_WAVELENGTH_M,
} from '../src/entities/AstronautSuit.ts';
import { deckPerimeterClamp, DECK_EDGE_RADIUS_M } from '../src/client/ClientApp.ts';
import {
  LunarHUD,
  HUD_CLIMB_ID,
  HUD_LANDMARK_ID,
  HUD_CLIMB_HOLD_EPS,
  formatClimbAltitude,
  formatClimbRate,
} from '../src/ui/LunarHUD.ts';
import {
  LunarAudioSystem,
  LADDER_LATCH_CLANG_HZ,
  LADDER_STEP_CADENCE_S,
} from '../src/audio/LunarAudioSystem.ts';
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
const section = (t: string): void => console.log(`\n${t}`);
function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

const DT = 1 / 60;
function input(patch: Partial<SuitInput> = {}): SuitInput {
  return { ...IDLE_SUIT_INPUT, ...patch };
}

// Canonical tower datum (physics-frame math, mirroring the law proven in
// check-ladder-kinematics: linear lerp of the tapered rung-line endpoints
// plus the 0.30 m body-rail offset along the outward normal).
const tower0 = new RadioTower();
const B: LadderBounds = tower0.getLadderBounds();
const NX = B.facingNormal.x;
const NY = B.facingNormal.y;
const SEAT_X = RADIO_TOWER_DEFAULTS.worldPosition.x; // -1550
const SEAT_Y = RADIO_TOWER_DEFAULTS.worldPosition.y; // 2320
const DECK_Z = tower0.getDeckElevation(); // 48.0
function railAt(z: number): { x: number; y: number } {
  const t = Math.min(Math.max((z - B.basePosition.z) / (B.topPosition.z - B.basePosition.z), 0), 1);
  return {
    x: B.basePosition.x + (B.topPosition.x - B.basePosition.x) * t + NX * LADDER_BODY_RAIL_OFFSET_M,
    y: B.basePosition.y + (B.topPosition.y - B.basePosition.y) * t + NY * LADDER_BODY_RAIL_OFFSET_M,
  };
}
const FLAT: GroundElevationFn = () => 0;
// Deck-aware ground mirror of ClientApp.groundAt (5 m hex deck → r 2.6 zone).
const deckGround: GroundElevationFn = (x, y) =>
  Math.hypot(x - SEAT_X, y - SEAT_Y) <= 2.6 ? DECK_Z : 0;

// ===========================================================================
// GATE 1 — Procedural Assembly & Geometry (NullEngine)
// ===========================================================================

function gate1(): void {
  section('=== GATE 1: Procedural Assembly & Geometry ===');

  const engine = new NullEngine({ renderWidth: 320, renderHeight: 240 } as never);
  const scene = new Scene(engine);
  const meshBaseline = scene.meshes.length;
  const matBaseline = scene.materials.length;

  const tower = new RadioTower();
  tower.init(scene);
  check('G1.01 RadioTower instantiates + builds on NullEngine (no WebGL)',
    tower.isBuilt() === true);
  const seat = tower.getWorldPosition();
  check('G1.02 canonical base seat (-1550, 2320)',
    seat.x === -1550 && seat.y === 2320, `(${seat.x}, ${seat.y})`);
  check('G1.03 summit deck at +48.0 m above the foundation',
    tower.getDeckElevation() === 48.0, `deck=${tower.getDeckElevation()}`);
  const root = tower.getRootNode();
  check('G1.04 root node exists under the scene', root !== null);
  const meshes = tower.getMeshes();
  check(`G1.05 procedural assembly produced the full lattice (${meshes.length} meshes)`,
    meshes.length > 100);
  const rungs = tower.getPartMeshes('rung');
  check(`G1.06 ladder rung count ≥ 120 (gate) — got ${rungs.length}`, rungs.length >= 120);
  check('G1.07 rung count matches the 137-rung contract (floor(48 / 0.35))',
    rungs.length === Math.floor(48.0 / LADDER_RUNG_PITCH_M));
  check('G1.08 all structural part classes present',
    ['foundation', 'pillar', 'tie-beam', 'diagonal', 'hoop', 'deck', 'railing', 'hatch', 'dish', 'spire', 'beacon']
      .every((p) => tower.getPartMeshes(p).length > 0));

  // Rung pitch measured from the ASSEMBLED world-space meshes, not just
  // constants. Babylon stores absolute positions in float32, so the uniform
  // 0.35 m pitch carries a ~2e-6 rounding drift.
  const rungHeights = rungs.map((m) => m.getAbsolutePosition().y).sort((a, b) => a - b);
  const diffs: number[] = [];
  for (let i = 1; i < rungHeights.length; i++) diffs.push(rungHeights[i] - rungHeights[i - 1]);
  check('G1.09 rung Δz ≤ 0.40 m on every consecutive pair (assembled meshes)',
    diffs.length === rungs.length - 1 && diffs.every((d) => d <= 0.4 + 1e-6));
  check('G1.10 pitch uniform at 0.35 m along the full 48 m climb',
    diffs.every((d) => Math.abs(d - LADDER_RUNG_PITCH_M) < 1e-4));
  check('G1.11 top rung reaches the deck datum (≤ 0.35 m below +48.0 m)',
    rungHeights.length > 0 && DECK_Z - rungHeights[rungHeights.length - 1] <= LADDER_RUNG_PITCH_M + 1e-6);

  const lb = tower.getLadderBounds();
  check('G1.12 ladder bounds: base z = ground datum, top z = deck +48.0',
    lb.basePosition.z === 0 && lb.topPosition.z === 48.0);
  check('G1.13 facing normal is unit-length south-east (+x, −y)',
    near(Math.hypot(lb.facingNormal.x, lb.facingNormal.y), 1) && lb.facingNormal.x > 0 && lb.facingNormal.y < 0);

  // Deterministic re-instantiation: same blueprint, same answers.
  const twin = new RadioTower();
  twin.init();
  const tb = twin.getLadderBounds();
  check('G1.14 re-instantiation is deterministic (identical rung count + rail bounds)',
    twin.getMeshes().length === meshes.length &&
    tb.totalRungs === lb.totalRungs &&
    near(tb.basePosition.x, lb.basePosition.x) && near(tb.basePosition.y, lb.basePosition.y));
  twin.dispose();

  // WorldScene wiring: terrain-anchored canonical build, idempotent.
  const engine2 = new NullEngine({ renderWidth: 320, renderHeight: 240 } as never);
  const world = new WorldScene({ seed: 'relay-04-smoke', terrainSize: 1024, terrainResolution: 129 });
  world.init(engine2);
  check('G1.15 WorldScene.getRadioTower() null before build', world.getRadioTower() === null);
  const wired = world.buildRadioTower();
  check('G1.16 buildRadioTower() returns the wired instance', wired instanceof RadioTower);
  check('G1.17 buildRadioTower() idempotent (same instance, no duplicates)',
    world.buildRadioTower() === wired && world.getRadioTower() === wired);
  const groundZ = world.getGroundHeightAt(SEAT_X, SEAT_Y);
  const wiredSeat = wired.getWorldPosition();
  check('G1.18 foundation z clamped to sampled terrain elevation',
    Math.abs(wiredSeat.z - groundZ) < 1e-6 && Number.isFinite(groundZ),
    `seat.z=${wiredSeat.z} ground=${groundZ}`);
  check('G1.19 deck rides the sampled terrain (+48.0 m)',
    Math.abs(wired.getDeckElevation() - (groundZ + 48.0)) < 1e-6);
  world.dispose();
  check('G1.20 WorldScene teardown releases the tower (getRadioTower null)',
    world.getRadioTower() === null);

  // Complete idempotent dispose on the bare scene.
  const snapshot = tower.getMeshes();
  tower.dispose();
  check('G1.21 dispose() frees every owned mesh (isDisposed on all sampled)',
    snapshot.every((m) => m.isDisposed()));
  check('G1.22 getMeshes() empty after dispose', tower.getMeshes().length === 0);
  check('G1.23 root node released', tower.getRootNode() === null);
  check('G1.24 zero orphaned radio-tower meshes left in the scene',
    scene.meshes.filter((m) => (m.metadata as { system?: string } | null)?.system === RADIO_TOWER_NAME_PREFIX).length === 0,
    `${scene.meshes.length} meshes remain`);
  check('G1.25 scene mesh count returns to pre-build baseline',
    scene.meshes.length === meshBaseline, `${scene.meshes.length} vs ${meshBaseline}`);
  check('G1.26 scene material count returns to pre-build baseline',
    scene.materials.length <= matBaseline,
    `${scene.materials.filter((m) => m.name.startsWith(RADIO_TOWER_NAME_PREFIX)).length} tower mats remain`);
  let doubleThrew = false;
  try {
    tower.dispose();
  } catch {
    doubleThrew = true;
  }
  check('G1.27 dispose() twice is idempotent (never throws)', !doubleThrew);
  let initThrew = false;
  try {
    tower.init(scene);
  } catch {
    initThrew = true;
  }
  check('G1.28 init() after dispose() refuses (throws)', initThrew);
  check('G1.29 pure math queries still answer after dispose',
    tower.getLadderBounds().totalRungs === 137 && tower.getDeckElevation() === 48.0);

  scene.dispose();
  engine.dispose();
  engine2.dispose();
}

// ===========================================================================
// GATE 2 — Proximity & Detection Envelope
// ===========================================================================

function gate2(): void {
  section('=== GATE 2: Proximity & Detection Envelope ===');
  const t = tower0;
  const atBase = (offsetM: number, dz = 0) => ({
    x: B.basePosition.x + NX * offsetM,
    y: B.basePosition.y + NY * offsetM,
    z: B.basePosition.z + dz,
  });
  const atHatch = (offsetM: number, dz = 0) => ({
    x: B.topPosition.x + NX * offsetM,
    y: B.topPosition.y + NY * offsetM,
    z: DECK_Z + dz,
  });

  check('G2.01 canonical envelopes: base 1.8 m, hatch 1.0 m',
    LADDER_BASE_DETECT_RADIUS_M === 1.8 && HATCH_DETECT_RADIUS_M === 1.0);
  check('G2.02 approaching to 0.5 m of the ladder rungs → isNearLadderBase true',
    t.isNearLadderBase(atBase(0.5)) === true);
  check('G2.03 1.79 m from the ladder base → true (inside the 1.8 m gate)',
    t.isNearLadderBase(atBase(1.79)) === true);
  check('G2.04 2.0 m from the ladder base → false (outside the envelope)',
    t.isNearLadderBase(atBase(2.0)) === false);
  check('G2.05 standing 100 m away on the regolith → false',
    t.isNearLadderBase({ x: SEAT_X + 100, y: SEAT_Y + 100, z: 0 }) === false);
  check('G2.06 base envelope is 2.5 m tall: +2.4 m true, +3.0 m false',
    t.isNearLadderBase(atBase(0.5, 2.4)) === true && t.isNearLadderBase(atBase(0.5, 3.0)) === false);
  check('G2.07 at the hatch on the deck → isNearTopHatch true (gate 1.0 m)',
    t.isNearTopHatch(atHatch(0.5)) === true);
  check('G2.08 1.4 m off the hatch centre → false',
    t.isNearTopHatch(atHatch(1.4)) === false);
  check('G2.09 hatch envelope is 1.5 m tall: +1.4 m true, +2.0 m false',
    t.isNearTopHatch(atHatch(0.5, 1.4)) === true && t.isNearTopHatch(atHatch(0.5, 2.0)) === false);
  check('G2.10 on the ladder mid-span the hatch reads false (deck far below)',
    t.isNearTopHatch(atBase(0.3, 24.0)) === false);
  check('G2.11 NaN input is hardened (both envelopes answer false, never throw)',
    t.isNearLadderBase({ x: Number.NaN, y: 2320, z: 0 }) === false &&
    t.isNearTopHatch({ x: -1550, y: Number.NaN, z: 48 }) === false);
  check('G2.12 custom radius override honoured (5 m radius catches a 3 m point)',
    t.isNearLadderBase(atBase(3.0), 5.0) === true);
  check('G2.13 the two envelopes do not overlap mid-climb (base ≠ summit)',
    t.isNearLadderBase(atHatch(0.2)) === false);
  check('G2.14 proximity answers after dispose (pure-math layer survives)',
    (() => {
      const doomed = new RadioTower();
      doomed.dispose();
      return doomed.isNearLadderBase(atBase(0.5)) === true && doomed.isNearTopHatch(atHatch(0.5)) === true;
    })());
}

// ===========================================================================
// GATE 3 — Climbing Kinematics (pure physics, framework-free)
// ===========================================================================

function gate3(): void {
  section('=== GATE 3: Climbing Kinematics ===');

  // -- Latch + rail lock -------------------------------------------------------
  const suit = new LunarEvaSuit({ x: B.basePosition.x + NX, y: B.basePosition.y + NY, z: 0, isGrounded: true });
  check('G3.01 mountLadder() at the base latches the boots',
    suit.mountLadder(B, B.basePosition.z) === true && suit.getState().ladderLatchActive === true);
  check('G3.02 locomotion mode enters CLIMBING',
    suit.getState().locomotionMode === 'CLIMBING');
  check('G3.03 re-mount while latched refuses (no double-clamp)',
    suit.mountLadder(B, 10) === false);
  check('G3.04 garbage ladder contract refuses the mount',
    new LunarEvaSuit().mountLadder(null as unknown as LadderBounds) === false);

  // Rail lock across a real 2 s ascent (120 frames @ 60 Hz).
  let maxRailError = 0;
  let z0 = suit.getState().z;
  for (let i = 0; i < 120; i++) {
    const s = suit.step(DT, input({ forward: 1 }), FLAT);
    const r = railAt(s.z);
    maxRailError = Math.max(maxRailError, Math.hypot(s.x - r.x, s.y - r.y));
  }
  const afterClimb = suit.getState();
  check(`G3.05 rail lock: max Δxy = ${maxRailError.toExponential(2)} m ≤ 0.05 m over 2 s climb`,
    maxRailError <= 0.05);
  check('G3.06 lateral strafe inputs are muted on the rail (still locked)',
    (() => {
      for (let i = 0; i < 30; i++) suit.step(DT, input({ forward: 1, strafe: 1 }), FLAT);
      const s = suit.getState();
      const r = railAt(s.z);
      return Math.hypot(s.x - r.x, s.y - r.y) <= 0.05;
    })());

  // -- Climb speeds --------------------------------------------------------------
  const measuredClimb = (afterClimb.z - z0) / (120 * DT);
  check(`G3.07 standard climb speed ${measuredClimb.toFixed(2)} m/s within 2.2 ± 0.3`,
    Math.abs(measuredClimb - LADDER_CLIMB_SPEED) <= 0.3);
  const sprinter = new LunarEvaSuit({ x: B.basePosition.x + NX, y: B.basePosition.y + NY, z: 0, isGrounded: true });
  sprinter.mountLadder(B, B.basePosition.z);
  const zs0 = sprinter.getState().z;
  for (let i = 0; i < 60; i++) sprinter.step(DT, input({ forward: 1, sprint: true }), FLAT);
  const measuredSprint = (sprinter.getState().z - zs0) / (60 * DT);
  check(`G3.08 sprint climb speed ${measuredSprint.toFixed(2)} m/s within 3.6 ± 0.4`,
    Math.abs(measuredSprint - LADDER_CLIMB_SPRINT_SPEED) <= 0.4);
  check('G3.09 canonical speeds: 2.2 / 3.6 m/s constants',
    LADDER_CLIMB_SPEED === 2.2 && LADDER_CLIMB_SPRINT_SPEED === 3.6);

  // -- Mechanical hold -----------------------------------------------------------
  const zsHold = suit.getState().z;
  for (let i = 0; i < 120; i++) suit.step(DT, IDLE_SUIT_INPUT, FLAT);
  const held = suit.getState();
  check('G3.10 neutral throttle → vz = 0 immediately (mechanical rung brake)',
    held.vz === 0 && held.locomotionMode === 'CLIMBING');
  check(`G3.11 no gravity slide: altitude held over 2 s (Δz ${Math.abs(held.z - zsHold).toExponential(1)} m)`,
    Math.abs(held.z - zsHold) < 1e-6);

  // -- Low-g rung hop --------------------------------------------------------------
  const zBeforeHop = held.z;
  const hopFrame = suit.step(DT, input({ jump: true }), FLAT);
  check('G3.12 jump on the ladder unlatches into a ballistic AIRBORNE frame',
    hopFrame.ladderLatchActive === false && hopFrame.locomotionMode === 'AIRBORNE');
  check(`G3.13 hop impulse vz = +${LADDER_HOP_VZ} m/s on the hop frame`,
    hopFrame.vz === LADDER_HOP_VZ);
  let apex = suit.getState().z;
  for (let i = 0; i < 240; i++) {
    const s = suit.step(DT, IDLE_SUIT_INPUT, FLAT);
    if (s.z > apex) apex = s.z;
  }
  const apexGain = apex - zBeforeHop;
  check(`G3.14 rung hop apex ${apexGain.toFixed(2)} m ≥ 2.5 m (spec gate)`, apexGain >= 2.5);
  check(`G3.15 apex matches v²/2g on lunar gravity (expected ≈ ${((LADDER_HOP_VZ * LADDER_HOP_VZ) / (2 * LUNAR_GRAVITY)).toFixed(2)} m)`,
    Math.abs(apexGain - (LADDER_HOP_VZ * LADDER_HOP_VZ) / (2 * LUNAR_GRAVITY)) < 0.1);
  check('G3.16 re-latch answers true while inside the climb envelope after the hop',
    suit.mountLadder(B, suit.getState().z) === true && suit.getState().ladderLatchActive === true);

  // -- Summit step-off onto the observation deck -------------------------------------
  const climber = new LunarEvaSuit({ x: B.basePosition.x + NX, y: B.basePosition.y + NY, z: DECK_Z - 1.0, isGrounded: true });
  check('G3.17 mid-span mount near the hatch latches (deck-to-ladder hand-off)',
    climber.mountLadder(B, DECK_Z - 1.0) === true);
  let summitFrame = -1;
  for (let i = 0; i < 240; i++) {
    const s = climber.step(DT, input({ forward: 1 }), deckGround);
    if (!s.ladderLatchActive && s.isGrounded) {
      summitFrame = i;
      break;
    }
  }
  check(`G3.18 crossing z ≥ 48.0 m steps off onto the observation deck (frame ${summitFrame})`,
    summitFrame >= 0);
  const onDeck = climber.getState();
  check('G3.19 deck hand-off: grounded, unlatched, locomotion restored to WALK',
    onDeck.isGrounded === true && onDeck.ladderLatchActive === false && onDeck.locomotionMode === 'WALK',
    JSON.stringify({ g: onDeck.isGrounded, l: onDeck.ladderLatchActive, m: onDeck.locomotionMode }));
  check(`G3.20 climber parked at deck elevation z=${onDeck.z.toFixed(2)} (|Δ| < 0.05 m)`,
    Math.abs(onDeck.z - DECK_Z) < 0.05);
  check('G3.21 climber stepped inward onto the deck plate (inside the railing radius)',
    Math.hypot(onDeck.x - SEAT_X, onDeck.y - SEAT_Y) <= DECK_EDGE_RADIUS_M + 1e-9);
  check('G3.22 deck walking is supported (forward step gains ground position, stays grounded)',
    (() => {
      const s = climber.step(DT, input({ forward: 1 }), deckGround);
      return s.isGrounded === true && s.locomotionMode !== 'CLIMBING';
    })());

  // -- Base step-off back onto the regolith --------------------------------------------
  const descender = new LunarEvaSuit({ x: B.basePosition.x + NX, y: B.basePosition.y + NY, z: 2.0, isGrounded: true });
  descender.mountLadder(B, 2.0);
  let baseFrame = -1;
  for (let i = 0; i < 240; i++) {
    const s = descender.step(DT, input({ forward: -1 }), FLAT);
    if (!s.ladderLatchActive && s.isGrounded) {
      baseFrame = i;
      break;
    }
  }
  check(`G3.23 descending to the base steps off onto the regolith (frame ${baseFrame})`,
    baseFrame >= 0);
  const onGround = descender.getState();
  check('G3.24 base hand-off: grounded, unlatched, locomotion restored to WALK',
    onGround.isGrounded === true && onGround.ladderLatchActive === false && onGround.locomotionMode === 'WALK');
  check(`G3.25 parked on the regolith datum z=${onGround.z.toFixed(2)} (|Δ| < 0.05 m)`,
    Math.abs(onGround.z) < 0.05);
  const baseDist = Math.hypot(onGround.x - B.basePosition.x, onGround.y - B.basePosition.y);
  check(`G3.26 stepped clear of the rung line (dist ${baseDist.toFixed(2)} m ≥ 0.6 m)`,
    baseDist >= 0.6);

  // -- Manual release -------------------------------------------------------------------
  check('G3.27 dismountLadder() releases with an outward push',
    (() => {
      const s = new LunarEvaSuit({ x: B.basePosition.x + NX, y: B.basePosition.y + NY, z: 0, isGrounded: true });
      s.mountLadder(B, 0);
      if (!s.dismountLadder()) return false;
      const st = s.getState();
      const outward = st.vx * NX + st.vy * NY;
      return st.ladderLatchActive === false && outward > 0.4;
    })());
  check('G3.28 dismountLadder() off-ladder answers false',
    new LunarEvaSuit().dismountLadder() === false);
}

// ===========================================================================
// GATE 4 — Audio / HUD / Visuals / Lifecycle Integration
// ===========================================================================

// -- Fake DOM (structural subset proven by smoke-client-app / smoke-heist-hud-audio) --
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
function textOfDoc(doc: FakeDoc, id: string): string {
  return doc.getElementById(id)?.textContent ?? '';
}
function hasClassDoc(doc: FakeDoc, id: string, cls: string): boolean {
  return doc.getElementById(id)?.classList.contains(cls) ?? false;
}

async function gate4(): Promise<void> {
  section('=== GATE 4: Audio, HUD, Visuals & Lifecycle Integration ===');

  // -- Pure visual / HUD laws ------------------------------------------------------
  const hold = climbGripPose(12.34, 0);
  check('G4.01 grip law at vz = 0: frozen symmetric hold (no time term, moving false)',
    hold.moving === false &&
    hold.shoulderLx === CLIMB_SHOULDER_FLEX_RAD && hold.shoulderRx === CLIMB_SHOULDER_FLEX_RAD &&
    hold.elbowLx === CLIMB_ELBOW_FLEX_RAD && hold.elbowRx === CLIMB_ELBOW_FLEX_RAD &&
    hold.kneeLx === CLIMB_KNEE_HOLD_RAD && hold.kneeRx === CLIMB_KNEE_HOLD_RAD);
  const strokeA = climbGripPose(0.5, 2.2);
  const strokeB = climbGripPose(0.5 + CLIMB_CYCLE_WAVELENGTH_M / 2, 2.2);
  check('G4.02 climbing stroke alternates limbs (L-arm high ↔ R-arm high after half a cycle)',
    strokeA.moving === true &&
    strokeA.shoulderLx > CLIMB_SHOULDER_FLEX_RAD && strokeA.shoulderRx < CLIMB_SHOULDER_FLEX_RAD &&
    strokeB.shoulderLx < CLIMB_SHOULDER_FLEX_RAD && strokeB.shoulderRx > CLIMB_SHOULDER_FLEX_RAD);
  check('G4.03 legs never swing aft of the ladder face (hip flex ≤ 0 on both legs, all phases)',
    (() => {
      for (let p = 0; p < CLIMB_CYCLE_WAVELENGTH_M; p += 0.05) {
        const g = climbGripPose(p, 2.2);
        if (g.hipLx > 1e-12 || g.hipRx > 1e-12) return false;
      }
      return true;
    })());
  check('G4.04 climbInwardHeadingRad faces the climber opposite the ladder normal',
    (() => {
      const h = climbInwardHeadingRad({ x: NX, y: NY });
      return near(Math.cos(h), -NX, 1e-9) && near(Math.sin(h), -NY, 1e-9);
    })());
  check('G4.05 altimeter tape law "ALT +42.5m [DECK 48m]"; rate law +2.2 m/s / HOLD',
    formatClimbAltitude(42.5, 48) === 'ALT +42.5m [DECK 48m]' &&
    formatClimbRate(2.2) === '+2.2 m/s' &&
    formatClimbRate(-1.5) === '-1.5 m/s' &&
    formatClimbRate(0) === 'HOLD' &&
    formatClimbRate(HUD_CLIMB_HOLD_EPS) === 'HOLD');

  // Deck perimeter railing containment (with the ladder-hatch gap law).
  const seatPt = { x: SEAT_X, y: SEAT_Y, z: DECK_Z };
  const nrm = { x: NX, y: NY };
  const outsidePoint = { x: SEAT_X + 10, y: SEAT_Y, z: DECK_Z };
  const clamped = deckPerimeterClamp(outsidePoint, seatPt, nrm);
  check('G4.06 railing contains a walker heading off the deck edge (clamped to 2.5 m radius)',
    Math.hypot(clamped.x - SEAT_X, clamped.y - SEAT_Y) <= DECK_EDGE_RADIUS_M + 1e-9);
  const insidePoint = { x: SEAT_X + 1.0, y: SEAT_Y + 0.5, z: DECK_Z };
  const untouched = deckPerimeterClamp(insidePoint, seatPt, nrm);
  check('G4.07 a walker mid-deck passes the clamp untouched',
    near(untouched.x, insidePoint.x, 1e-12) && near(untouched.y, insidePoint.y, 1e-12));
  const hatchPoint = { x: SEAT_X + NX * 10, y: SEAT_Y + NY * 10, z: DECK_Z };
  const hatchFree = deckPerimeterClamp(hatchPoint, seatPt, nrm);
  check('G4.08 ladder-hatch sector is the railing gap (approach to the ladder passes free)',
    near(hatchFree.x, hatchPoint.x, 1e-12) && near(hatchFree.y, hatchPoint.y, 1e-12));
  const belowDeck = { x: SEAT_X + 10, y: SEAT_Y, z: DECK_Z - 20 };
  const belowFree = deckPerimeterClamp(belowDeck, seatPt, nrm);
  check('G4.09 clamp ignores climbers far below the deck elevation band',
    near(belowFree.x, belowDeck.x, 1e-12));

  // Aviation beacon pulse law.
  const bt = new RadioTower();
  bt.init();
  const p0 = bt.getBeaconPulseState();
  bt.update(0.5);
  const p1 = bt.getBeaconPulseState();
  check('G4.10 beacon clock advances with update(deltaS)',
    near(p1.elapsedS, 0.5, 1e-9) && p0.elapsedS === 0);
  let redPeak = 0;
  let whitePeak = 0;
  let redSilent = false;
  for (let i = 0; i < 240; i++) {
    bt.update(1 / 60);
    const p = bt.getBeaconPulseState();
    redPeak = Math.max(redPeak, p.redIntensity);
    whitePeak = Math.max(whitePeak, p.whiteIntensity);
    // The pulse law bottoms out near zero between strobes (~5e-3 floor).
    if (p.redIntensity < 0.01) redSilent = true;
    if (!(p.redIntensity >= 0 && p.redIntensity <= 1 && p.whiteIntensity >= 0 && p.whiteIntensity <= 1)) break;
  }
  check('G4.11 dual-strobe law pulses red AND white (both peak > 0.5, red dark between pulses)',
    redPeak > 0.5 && whitePeak > 0.5 && redSilent);
  bt.dispose();

  // Standalone audio lifecycle (pre-init safety + post-dispose silence).
  {
    const audio = new LunarAudioSystem();
    let preThrew = false;
    try {
      audio.playLadderLatch();
      audio.playLadderStep();
      audio.playSummitChime();
    } catch {
      preThrew = true;
    }
    const pre = audio.getClimbingCueTimes();
    check('G4.12 pre-init climbing voices are silent no-ops (no throw, zero counts)',
      !preThrew && pre.latchCount === 0 && pre.stepCount === 0 && pre.chimeCount === 0);
    await audio.init();
    audio.playLadderLatch();
    audio.playSummitChime();
    const mid = audio.getClimbingCueTimes();
    check('G4.13 cue counters book-keep on the headless mock context (1 latch, 1 chime)',
      mid.latchCount === 1 && mid.chimeCount === 1 && mid.latchAt > Number.NEGATIVE_INFINITY);
    check('G4.14 canonical audio law: 180 Hz boot-clamp clang, 0.35 s rung cadence',
      LADDER_LATCH_CLANG_HZ === 180 && LADDER_STEP_CADENCE_S === 0.35);
    audio.dispose();
    let postThrew = false;
    try {
      audio.playLadderLatch();
      audio.playLadderStep();
      audio.playSummitChime();
    } catch {
      postThrew = true;
    }
    check('G4.15 post-dispose voices silence without throwing', !postThrew && audio.isDisposed());
  }

  // -- Full ClientApp integration on NullEngine -----------------------------------
  const doc = makeFakeDocument();
  (globalThis as { document?: unknown }).document = doc;

  const app = new ClientApp({
    seed: 'spec29-phase6-smoke',
    username: 'smokejockey',
    faction: 'ARTEMIS',
    silent: true,
    autoConnect: false,
  });
  await app.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));
  check('G4.16 REAL ClientApp initialised headless (NullEngine, no network)', app.isInitialized());

  const tower = app.world.buildRadioTower();
  const hud = app.getHud();
  const audio = app.getAudio();
  check('G4.17 radio tower + HUD + audio engine all live in the app',
    tower !== null && hud !== null && audio !== null);
  if (tower === null || hud === null || audio === null) {
    failures.push('G4 integration bootstrap failed — remaining G4 checks skipped');
    return;
  }

  let chirps = 0;
  const origChirp = audio.playCommsChirp.bind(audio);
  (audio as unknown as { playCommsChirp: (t: 'alert' | 'incoming' | 'burst') => void }).playCommsChirp = (
    t: 'alert' | 'incoming' | 'burst',
  ) => {
    chirps++;
    origChirp(t);
  };

  let nowMs = 500_000;
  const tick = (ms = 16): void => {
    nowMs += ms;
    app.update(nowMs);
  };
  const cues = () => audio.getClimbingCueTimes();
  const suit = app.getSuit();
  const seat2 = tower.getWorldPosition();
  const LB = tower.getLadderBounds();
  const basePoint = {
    x: LB.basePosition.x + LB.facingNormal.x * 0.5,
    y: LB.basePosition.y + LB.facingNormal.y * 0.5,
    z: LB.basePosition.z,
  };
  const teleport = (x: number, y: number, z: number): void => {
    suit.setState({ x, y, z, vx: 0, vy: 0, vz: 0, isGrounded: true, locomotionMode: 'WALK' });
  };

  tick();
  tick();
  check('G4.18 spawn far from the tower keeps the altimeter retracted',
    hud.getClimbingTelemetry() === null && hasClassDoc(doc, HUD_CLIMB_ID, 'is-hidden'));

  teleport(basePoint.x, basePoint.y, basePoint.z);
  tick();
  const tele1 = hud.getClimbingTelemetry();
  check('G4.19 arrival at the ladder base pushes a live unlatched altimeter frame',
    tele1 !== null && tele1.isLatched === false, JSON.stringify(tele1));
  check('G4.20 "FRONTIER RELAY 04" landmark banner floats with a comms chirp',
    hud.landmarkText() === 'FRONTIER RELAY 04' &&
    !hasClassDoc(doc, HUD_LANDMARK_ID, 'is-hidden') && chirps >= 1, hud.landmarkText());
  check('G4.21 banner does not re-fire on lingering frames (once per approach)',
    (() => {
      const before = chirps;
      tick();
      tick();
      return hud.landmarkText() === 'FRONTIER RELAY 04' && chirps === before;
    })());

  const latchBefore = cues().latchCount;
  app.handleKeyInput('KeyE', 'down');
  app.handleKeyInput('KeyE', 'up');
  tick();
  check('G4.22 [E] at the base latches the ladder', suit.getState().ladderLatchActive === true);
  check('G4.23 magnetic boot-clamp latch clang sounds exactly once per latch',
    cues().latchCount === latchBefore + 1);
  check('G4.24 latched HUD chip reads LATCHED',
    textOfDoc(doc, 'hud-climb-latch') === 'LATCHED' &&
    hasClassDoc(doc, 'hud-climb-latch', 'is-latched'));

  app.handleKeyInput('KeyW', 'down');
  const stepBefore = cues().stepCount;
  for (let i = 0; i < 30; i++) tick(); // ≈ 0.48 s
  check(`G4.25 rung-step cadence fires within a 0.35 s window (got ${cues().stepCount - stepBefore} in 0.48 s)`,
    cues().stepCount - stepBefore >= 1);
  for (let i = 0; i < 45; i++) tick(); // ≈ 1.2 s total
  check(`G4.26 cadence keeps ticking through the climb (≥3 clicks in ≈1.2 s, got ${cues().stepCount - stepBefore})`,
    cues().stepCount - stepBefore >= 3);
  const teleClimb = hud.getClimbingTelemetry();
  check('G4.27 climbing tape paints "+2.2 m/s" and the ALT law matches formatClimbAltitude',
    teleClimb !== null && teleClimb.isLatched === true &&
    textOfDoc(doc, 'hud-climb-vs-value') === '+2.2 m/s' &&
    textOfDoc(doc, 'hud-climb-alt-value') === formatClimbAltitude(teleClimb.altitudeM, 48),
    `${textOfDoc(doc, 'hud-climb-alt-value')} | ${textOfDoc(doc, 'hud-climb-vs-value')}`);
  check('G4.28 client-side climber is actually gaining altitude on the rail',
    suit.getState().z > basePoint.z + 1.0, `z=${suit.getState().z.toFixed(2)}`);

  app.handleKeyInput('KeyW', 'up');
  tick();
  tick();
  const holdTele = hud.getClimbingTelemetry();
  check('G4.29 neutral throttle paints HOLD with the is-hold class (rate 0)',
    holdTele !== null && Math.abs(holdTele.climbRateMps) <= 1e-9 &&
    textOfDoc(doc, 'hud-climb-vs-value') === 'HOLD' &&
    hasClassDoc(doc, 'hud-climb-vs-value', 'is-hold'));
  const stepAtHold = cues().stepCount;
  for (let i = 0; i < 30; i++) tick();
  check('G4.30 cadence falls silent while holding still (no machine-gun clicks)',
    cues().stepCount === stepAtHold);

  suit.setState({ z: tower.getDeckElevation() - 0.6 });
  app.handleKeyInput('KeyW', 'down');
  let summitOk = false;
  for (let i = 0; i < 60; i++) {
    tick();
    if (!suit.getState().ladderLatchActive && suit.getState().isGrounded) {
      summitOk = true;
      break;
    }
  }
  tick();
  check('G4.31 client summit step-off onto the observation deck (grounded, unlatched)', summitOk);
  check('G4.32 summit rings playSummitChime()', cues().chimeCount >= 1);
  check('G4.33 observation-deck landmark banner floats',
    hud.landmarkText() === 'FRONTIER RELAY 04 — OBSERVATION DECK', hud.landmarkText());
  const deckTele = hud.getClimbingTelemetry();
  check('G4.34 deck altimeter reads "ALT +48.0m [DECK 48m]" with the near-deck band lit',
    deckTele !== null && deckTele.isLatched === false &&
    textOfDoc(doc, 'hud-climb-alt-value') === 'ALT +48.0m [DECK 48m]' &&
    hasClassDoc(doc, HUD_CLIMB_ID, 'is-near-deck'), textOfDoc(doc, 'hud-climb-alt-value'));

  hud.clearLandmarkArrival();
  teleport(seat2.x + 300, seat2.y + 300, seat2.z);
  tick();
  tick();
  check('G4.35 walking away retracts the altimeter cleanly (null + is-hidden)',
    hud.getClimbingTelemetry() === null && hasClassDoc(doc, HUD_CLIMB_ID, 'is-hidden'));
  teleport(basePoint.x, basePoint.y, basePoint.z);
  tick();
  check('G4.36 hysteresis re-arm re-announces "FRONTIER RELAY 04" on re-approach',
    hud.landmarkText() === 'FRONTIER RELAY 04', hud.landmarkText());

  app.dispose();
  let postUpdateThrew = false;
  try {
    tick();
  } catch {
    postUpdateThrew = true;
  }
  check('G4.37 full-app dispose is clean: post-dispose update throw-free, HUD + audio disposed',
    !postUpdateThrew && hud.isDisposed() && audio.isDisposed());
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('SPEC 29 — FRONTIER RADIO TOWER HEADLESS SMOKE SUITE (NullEngine)');
  gate1();
  gate2();
  gate3();
  await gate4();
  const total = passed + failures.length;
  const pct = total === 0 ? 0 : Math.round((passed / total) * 100);
  console.log(`\n${failures.length === 0 ? '✅' : '❌'} ${passed}/${total} checks green (${pct}%)`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`   ✘ ${f}`);
    process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  console.error('harness crashed:', err);
  process.exitCode = 1;
});
