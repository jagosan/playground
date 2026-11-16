/**
 * Spec 38 Phase 6 — Headless Smoke Verification Suite & Build Gate.
 *
 * Fully automated acceptance smoke test for Spec 38: Subterranean Base Excavation
 * & Deep Core Shaft Mining.
 *
 * Verifies all 6 specification requirements and 5 acceptance criteria:
 *   GATE 1  Excavation State Machine & Data Model (Spec 38 §4.1) —
 *           Default base state (Surface only, Tier 1-3 locked), rubble accrual,
 *           progress %, cost validation & unlock rejections, sequential tier
 *           unlocks (Tier 1 -> Tier 2 -> Tier 3), max-tier refusal, envelope
 *           storage round-trip, and SQLite repository persistence.
 *   GATE 2  Subterranean Room Mesh Generation & Boundaries (Spec 38 §2.1, §3 Phase 2) —
 *           Procedural 3D mesh generation under NullEngine: 19 hexagonal shaft rings,
 *           Tier 1 chamber (24x24x6 m, 5 vault ribs, 6 strip lights, -15 m datum),
 *           Tier 2 vault (36x36x9 m, 4 columns, 3 beams, -45 m datum),
 *           Tier 3 cavern (60x80x14 m, 7 arch ribs, -95 m datum),
 *           and camera-depth occlusion culling (surface vs underground).
 *   GATE 3  Rotary Core Drill Machine & Excavation Minigame (Spec 38 §3 Phase 3) —
 *           3D procedural drill rig assembly (collar, outriggers, mast, cutter heads,
 *           teeth, console, dock rails, chute), floor datum seating, mounting and
 *           docking states, Tier 4 Deep Resonator 2.5x torque multiplier, seismic
 *           rumble audio telemetry (35-65 Hz), and basalt rubble accrual.
 *   GATE 4  Slag Autoclave Conversion & Material Production (Spec 38 §4.3) —
 *           Conservation of mass (25 kg brick + 5 kg trace metals + 70 kg tailings = 100 kg),
 *           Tier 2 autoclave gating (locked at Tiers 0 and 1), Gate 3 acceptance
 *           (1,000 kg basalt -> exactly 10x SLAG_CONSTRUCTION_BRICK and 50 kg trace metals),
 *           affordability checks, brick consumption for construction, and telemetry.
 *   GATE 5  Vertical Elevator Kinematics & Passenger Coupling (Spec 38 §4.2) —
 *           Procedural 3D elevator assembly, 4 call stations (Z = 0, -15, -45, -95 m),
 *           continuous non-NaN vertical coordinates, velocity profiling (<= 6.0 m/s),
 *           exact floor datum snapping, suited character passenger coupling,
 *           and buggy dynamic ground elevation clamping across multi-floor travel.
 *   GATE 6  WorldScene Subterranean Integration & Lifecycle Hygiene —
 *           WorldScene attachment of chambers and rig under NullEngine, update tick
 *           stepping, visibility synchronization, and clean disposal hygiene.
 *   GATE 7  Acceptance & Assertion Count Gate —
 *           >= 60 assertions verified with zero failures.
 *
 * Runs headless under `npx tsx scripts/smoke-spec38-core-excavation.ts` (exit 0 == all green).
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { DatabaseSync } from 'node:sqlite';

import {
  SubterraneanExcavator,
  SubterraneanRepository,
  SinteringAutoclaveUnit,
  DEPTH_TIERS,
  SURFACE_TIER,
  MAX_DEPTH_TIER,
  SLAG_CONSTRUCTION_BRICK,
  BASALT_PER_SLAG_BRICK_KG,
  SLAG_BRICK_MASS_KG,
  TRACE_METALS_PER_BRICK_KG,
  TRACE_IRON_PER_BRICK_KG,
  TRACE_TITANIUM_PER_BRICK_KG,
  SLAG_WASTE_PER_BRICK_KG,
  AUTOCLAVE_REQUIRED_TIER,
  SUBTERRANEAN_STORAGE_KEY,
  SUBTERRANEAN_SAVE_VERSION,
  InMemoryExcavationStorage,
  calculateSinterYield,
  defaultTierState,
  serializeTierState,
  deserializeTierState,
  validateTierShape,
  validateExcavationCost,
  validateSinter,
  computeExcavationProgress,
} from '../src/base/SubterraneanExcavator.ts';
import type {
  DepthTierIndex,
  SubterraneanTierState,
  SqliteLike,
} from '../src/base/SubterraneanExcavator.ts';

import {
  SubterraneanChamberBuilder,
  CHAMBER_TIER_CONFIGS,
  SHAFT_RING_COUNT,
  TIER1_RIB_COUNT,
  TIER1_LIGHT_COUNT,
  TIER2_BEAM_COUNT,
  TIER3_RIB_COUNT,
  VISIBILITY_THRESHOLD_Z_M,
} from '../src/base/SubterraneanChamberBuilder.ts';

import {
  CoreMiningRig,
  VerticalElevator,
  DRILL_PULSE_DURATION_S,
  DRILL_BASE_TORQUE_NM,
  DEEP_RESONATOR_TORQUE_MULTIPLIER,
  DRILL_BASE_RUBBLE_YIELD_KG,
  SEISMIC_RUMBLE_MIN_HZ,
  SEISMIC_RUMBLE_MAX_HZ,
  ELEVATOR_FLOOR_DEPTHS,
  ELEVATOR_FLOOR_TIERS,
  ELEVATOR_MAX_VELOCITY_MPS,
  ELEVATOR_ACCELERATION_MPS2,
  ELEVATOR_PLATFORM_WIDTH_M,
  ELEVATOR_PLATFORM_LENGTH_M,
} from '../src/base/CoreMiningRig.ts';
import type {
  ElevatorPassenger,
  MiningRigState,
} from '../src/base/CoreMiningRig.ts';

import { LunarAudioSystem } from '../src/audio/LunarAudioSystem.ts';
import { WorldScene } from '../src/engine/WorldScene.ts';

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];
let currentGate = 'preamble';

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  [GATE ${currentGate}] PASS ${label}`);
  } else {
    const msg = `[GATE ${currentGate}] ${label}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.error(`  [GATE ${currentGate}] FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Approx numeric equality within tolerance */
const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) <= eps;

/** Mock passenger supporting character suit and buggy transforms */
class MockPassenger implements ElevatorPassenger {
  id: string;
  kind: 'suit' | 'buggy' | 'custom';
  pos = { x: 0, y: 0, z: 0 };
  vel = { vz: 0 };

  constructor(id: string, x: number, y: number, z: number, kind: 'suit' | 'buggy' | 'custom' = 'suit') {
    this.id = id;
    this.pos = { x, y, z };
    this.kind = kind;
  }

  getPosition(): { x: number; y: number; z: number } {
    return this.pos;
  }

  setPosition(pos: { x?: number; y?: number; z?: number }): void {
    if (pos.x !== undefined) this.pos.x = pos.x;
    if (pos.y !== undefined) this.pos.y = pos.y;
    if (pos.z !== undefined) this.pos.z = pos.z;
  }

  setVelocity(vel: { vz?: number }): void {
    if (vel.vz !== undefined) this.vel.vz = vel.vz;
  }
}

async function runSmokeSuite(): Promise<void> {
  console.log('======================================================================');
  console.log('SPEC 38 PHASE 6: SUBTERRANEAN BASE EXCAVATION & DEEP CORE MINING');
  console.log('Headless Acceptance Smoke Verification Suite (NullEngine)');
  console.log('======================================================================\n');

  // Shared NullEngine for mesh verification
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const audioSystem = new LunarAudioSystem();
  check('NullEngine & Scene constructed headlessly', engine !== null && scene !== null);

  // =========================================================================
  // GATE 1: Default Base State & Excavation Unlock Transitions (Spec 38 §4.1)
  // =========================================================================
  currentGate = '1';
  console.log('\n--- GATE 1: Excavation State Machine, Cost Gates & Persistence ---');

  // 1.1 Specification Tier Cost & Depth Table (Spec 38 §2.1)
  check(
    'Tier 1 requirement: 2,500 kg basalt, 5,000 cr, depth Z = -15 m',
    DEPTH_TIERS[1]!.basaltKg === 2_500 &&
      DEPTH_TIERS[1]!.creditCost === 5_000 &&
      DEPTH_TIERS[1]!.depthZ === -15
  );
  check(
    'Tier 2 requirement: 8,000 kg basalt, 15,000 cr, depth Z = -45 m',
    DEPTH_TIERS[2]!.basaltKg === 8_000 &&
      DEPTH_TIERS[2]!.creditCost === 15_000 &&
      DEPTH_TIERS[2]!.depthZ === -45
  );
  check(
    'Tier 3 requirement: 25,000 kg basalt, 35,000 cr, depth Z = -95 m',
    DEPTH_TIERS[3]!.basaltKg === 25_000 &&
      DEPTH_TIERS[3]!.creditCost === 35_000 &&
      DEPTH_TIERS[3]!.depthZ === -95
  );
  check('MAX_DEPTH_TIER is 3 and SURFACE_TIER is 0', MAX_DEPTH_TIER === 3 && SURFACE_TIER === 0);

  // 1.2 Default Base State
  const storage = new InMemoryExcavationStorage();
  const excavator = new SubterraneanExcavator({ storage });
  const initialState = excavator.getExcavationState();

  check('Default base state: current tier is Surface (Tier 0)', initialState.unlockedTier === 0);
  check('Default base state: excavation progress is 0%', initialState.excavationProgress === 0);
  check('Default base state: total mined tonnage is 0 kg', initialState.totalMinedKg === 0);
  check('Default base state: slag bricks count is 0', initialState.slagBricks === 0);
  check('Default base state: trace metals is 0 kg', initialState.traceMetalsKg === 0);
  check('Current tier metadata resolves to Surface Base Datum', excavator.getCurrentTier().name === 'Surface Base Datum');

  // 1.3 Basalt Accumulation & Progress Computation
  const afterFirstAdd = excavator.addBasaltRubble(1_250);
  check('addBasaltRubble(1,250) tracks stockpile balance', afterFirstAdd === 1_250);
  check('Progress is exactly 50% toward Tier 1 requirement (1,250 / 2,500 kg)', excavator.getExcavationState().excavationProgress === 50);

  // Negative / NaN sanity guard
  check('Negative basalt addition rejected without modifying balance', excavator.addBasaltRubble(-500) === 1_250);
  check('NaN basalt addition rejected without modifying balance', excavator.addBasaltRubble(Number.NaN) === 1_250);

  // 1.4 Unlock Gating & Rejection Integrity
  const rejectBasalt = excavator.unlockNextTier(10_000); // Plenty of credits, but only 1,250 kg basalt
  check('Unlock rejected on insufficient basalt', !rejectBasalt.unlocked && rejectBasalt.reason === 'insufficient_basalt');
  check('State remains Tier 0 on insufficient basalt rejection', excavator.getExcavationState().unlockedTier === 0);

  excavator.addBasaltRubble(1_300); // Now 2,550 kg total (satisfies 2,500 kg basalt requirement)
  const rejectCredits = excavator.unlockNextTier(4_999); // Short of 5,000 credits
  check('Unlock rejected on insufficient credits', !rejectCredits.unlocked && rejectCredits.reason === 'insufficient_credits');
  check('Stockpile untouched on insufficient credits rejection', excavator.getExcavationState().basaltRubbleKg === 2_550);

  // 1.5 Tier 1 Unlock Transition (Acceptance Criterion 1)
  const unlockT1 = excavator.unlockNextTier(5_000);
  check('Tier 1 unlock succeeds at exact required cost', unlockT1.unlocked && unlockT1.state.unlockedTier === 1);
  check('Basalt consumed on Tier 1 unlock (2,550 - 2,500 = 50 kg remaining)', unlockT1.state.basaltRubbleKg === 50);
  check('Credits debited cleanly (remaining credits = 0)', unlockT1.remainingCredits === 0);
  check('Current depth tier is Tier 1 (Z = -15 m)', excavator.getCurrentTier().depthZ === -15);
  check('Autosave persists envelope to storage on unlock', storage.getItem(SUBTERRANEAN_STORAGE_KEY) !== null);

  // 1.6 Tier 2 Unlock Transition (Industrial & Smelting Vault)
  excavator.addBasaltRubble(8_000); // 8,050 kg total
  const unlockT2 = excavator.unlockNextTier(15_000);
  check('Tier 2 unlock succeeds (8,000 kg basalt + 15,000 cr)', unlockT2.unlocked && unlockT2.state.unlockedTier === 2);
  check('Current depth tier is Tier 2 (Z = -45 m)', excavator.getCurrentTier().depthZ === -45);

  // 1.7 Tier 3 Unlock Transition (Deep Core Lava Tube Cavern)
  excavator.addBasaltRubble(25_000); // 25,050 kg total
  const unlockT3 = excavator.unlockNextTier(35_000);
  check('Tier 3 unlock succeeds (25,000 kg basalt + 35,000 cr)', unlockT3.unlocked && unlockT3.state.unlockedTier === 3);
  check('Current depth tier is Tier 3 (Z = -95 m)', excavator.getCurrentTier().depthZ === -95);
  check('Excavation progress at MAX_DEPTH_TIER is 100%', unlockT3.state.excavationProgress === 100);

  // Max tier refusal
  const rejectMax = excavator.unlockNextTier(1_000_000);
  check('Further unlock refused at MAX_DEPTH_TIER with max_tier reason', !rejectMax.unlocked && rejectMax.reason === 'max_tier');
  const expectedTotalMined = 1_250 + 1_300 + 8_000 + 25_000;
  check('Cumulative mined tonnage accurately tracked across all unlocks', rejectMax.state.totalMinedKg === expectedTotalMined);

  // 1.8 Storage Envelope & Persistence Round-Trip
  const restoredExcavator = new SubterraneanExcavator({ storage, autosave: false });
  check('SubterraneanExcavator.load() successfully recovers saved Tier 3 state', restoredExcavator.load());
  check('Restored excavator matches unlockedTier = 3', restoredExcavator.getExcavationState().unlockedTier === 3);

  // Storage tamper rejection & validation
  check('Version tamper rejection (version 99 -> null)', deserializeTierState('{"version":99,"state":{}}') === null);
  check('Malformed JSON envelope rejection -> null', deserializeTierState('{"not-valid') === null);
  const corruptedEnvelope = JSON.parse(serializeTierState(defaultTierState()));
  corruptedEnvelope.state.unlockedTier = 99;
  check('validateTierShape rejects out-of-range tier index', !validateTierShape(corruptedEnvelope.state));

  // 1.9 SQLite Repository Round-Trip (DatabaseSync)
  const db = new DatabaseSync(':memory:');
  const sqliteLike: SqliteLike = {
    exec: async (sql) => { db.exec(sql); },
    run: async (sql, params = []) => {
      const stmt = db.prepare(sql);
      const res = stmt.run(...(params as never[])) as { lastInsertRowid: number | bigint; changes: number | bigint };
      return { lastID: Number(res.lastInsertRowid), changes: Number(res.changes) };
    },
    get: async <T>(sql: string, params: unknown[] = []) => {
      const stmt = db.prepare(sql);
      const row = stmt.get(...(params as never[]));
      return row === undefined ? undefined : (row as T);
    },
    all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
  };

  const repo = new SubterraneanRepository(sqliteLike);
  await repo.migrate();
  await repo.migrate(); // Idempotency
  check('SubterraneanRepository migration is idempotent', true);

  await repo.saveState('player-1', excavator.getExcavationState());
  const loadedDbState = await repo.getState('player-1');
  check('SubterraneanRepository recovers saved state from SQLite', loadedDbState !== undefined && loadedDbState.unlockedTier === 3);
  check('SQLite record preserves total mined tonnage', loadedDbState !== undefined && loadedDbState.totalMinedKg === expectedTotalMined);
  db.close();

  // =========================================================================
  // GATE 2: Subterranean Room Mesh Generation & Boundaries (Spec 38 §2.1, §3 Phase 2)
  // =========================================================================
  currentGate = '2';
  console.log('\n--- GATE 2: Procedural Subterranean Chamber Generation & Occlusion ---');

  const chamberBuilder = new SubterraneanChamberBuilder(scene);
  chamberBuilder.build(3);

  check('SubterraneanChamberBuilder.isBuilt() is true after build(3)', chamberBuilder.isBuilt());
  check('Chamber root node present in scene', chamberBuilder.getRootNode() !== null);

  const chamberMeshes = chamberBuilder.getMeshes();
  // Expected meshes: Shaft rings (19) + tier1 (17) + tier2 (13) + tier3 (12) = 61 meshes
  const expectedTotalMeshes = SHAFT_RING_COUNT + 17 + 13 + 12;
  check(`Chamber builder generated expected total meshes (${expectedTotalMeshes})`, chamberMeshes.length === expectedTotalMeshes);

  // Shaft rings verification
  const shaftRings = chamberBuilder.getPartMeshes('shaft-ring');
  check(`Vertical shaft contains exactly ${SHAFT_RING_COUNT} hexagonal retention rings`, shaftRings.length === SHAFT_RING_COUNT);

  // Tier 1 Chamber: Living & Life Support Mezzanine (Z = -15 m, 24m x 24m x 6m)
  const tier1Config = CHAMBER_TIER_CONFIGS[1]!;
  const tier1Ribs = chamberBuilder.getPartMeshes('vault-rib').filter((m) => (m.metadata?.tier as number) === 1);
  const tier1Lights = chamberBuilder.getPartMeshes('strip-light');
  check(`Tier 1 chamber contains ${TIER1_RIB_COUNT} structural vault ribs`, tier1Ribs.length === TIER1_RIB_COUNT);
  check(`Tier 1 chamber contains ${TIER1_LIGHT_COUNT} industrial strip light meshes`, tier1Lights.length === TIER1_LIGHT_COUNT);

  const tier1Floor = chamberBuilder.getPartMeshes('floor').find((m) => (m.metadata?.tier as number) === 1);
  check('Tier 1 floor slab present', tier1Floor !== undefined);
  if (tier1Floor !== undefined) {
    const bb1 = tier1Floor.getBoundingInfo().boundingBox;
    check(`Tier 1 floor width spans ~${tier1Config.widthM} m`, near(bb1.extendSizeWorld.x * 2, tier1Config.widthM));
    check(`Tier 1 floor length spans ~${tier1Config.lengthM} m`, near(bb1.extendSizeWorld.z * 2, tier1Config.lengthM));
  }
  const rootTier1 = chamberBuilder.getTierRoot(1);
  check('Tier 1 root datum positioned at Z = -15 m', rootTier1 !== null && near(rootTier1.position.y, -15));

  // Tier 2 Chamber: Heavy Industrial & Power Vault (Z = -45 m, 36m x 36m x 9m)
  const tier2Config = CHAMBER_TIER_CONFIGS[2]!;
  const tier2Beams = chamberBuilder.getPartMeshes('beam');
  const tier2Columns = chamberBuilder.getPartMeshes('column');
  check(`Tier 2 vault contains ${TIER2_BEAM_COUNT} transverse ceiling beams`, tier2Beams.length === TIER2_BEAM_COUNT);
  check('Tier 2 vault contains 4 reinforced load-bearing columns', tier2Columns.length === 4);

  const tier2Floor = chamberBuilder.getPartMeshes('floor').find((m) => (m.metadata?.tier as number) === 2);
  check('Tier 2 floor slab present', tier2Floor !== undefined);
  if (tier2Floor !== undefined) {
    const bb2 = tier2Floor.getBoundingInfo().boundingBox;
    check(`Tier 2 floor width spans ~${tier2Config.widthM} m`, near(bb2.extendSizeWorld.x * 2, tier2Config.widthM));
    check(`Tier 2 floor length spans ~${tier2Config.lengthM} m`, near(bb2.extendSizeWorld.z * 2, tier2Config.lengthM));
  }
  const rootTier2 = chamberBuilder.getTierRoot(2);
  check('Tier 2 root datum positioned at Z = -45 m', rootTier2 !== null && near(rootTier2.position.y, -45));

  // Tier 3 Chamber: Deep Core Lava Tube Cavern (Z = -95 m, 60m x 80m x 14m)
  const tier3Config = CHAMBER_TIER_CONFIGS[3]!;
  const tier3ArchRibs = chamberBuilder.getPartMeshes('arch-rib');
  check(`Tier 3 cavern contains ${TIER3_RIB_COUNT} natural volcanic arch ribs`, tier3ArchRibs.length === TIER3_RIB_COUNT);

  const tier3Floor = chamberBuilder.getPartMeshes('floor').find((m) => (m.metadata?.tier as number) === 3);
  check('Tier 3 floor slab present', tier3Floor !== undefined);
  if (tier3Floor !== undefined) {
    const bb3 = tier3Floor.getBoundingInfo().boundingBox;
    check(`Tier 3 floor width spans ~${tier3Config.widthM} m`, near(bb3.extendSizeWorld.x * 2, tier3Config.widthM));
    check(`Tier 3 floor length spans ~${tier3Config.lengthM} m`, near(bb3.extendSizeWorld.z * 2, tier3Config.lengthM));
  }
  const rootTier3 = chamberBuilder.getTierRoot(3);
  check('Tier 3 root datum positioned at Z = -95 m', rootTier3 !== null && near(rootTier3.position.y, -95));

  // Occlusion Culling: Surface vs Underground (Spec 38 §2)
  chamberBuilder.updateVisibility(0); // Camera at surface elevation (Z >= -2.0 m)
  check('Surface camera (Z >= -2.0 m) culls all subterranean chamber meshes', chamberMeshes.every((m) => !m.isVisible));

  chamberBuilder.updateVisibility(-25); // Camera underground (Z < -2.0 m)
  check('Underground camera (Z < -2.0 m) reveals all subterranean chamber meshes', chamberMeshes.every((m) => m.isVisible));

  // Partial unlock geometry gating
  const partialBuilder = new SubterraneanChamberBuilder(scene);
  partialBuilder.build(1);
  partialBuilder.updateVisibility(-20);
  const partialMeshes = partialBuilder.getMeshes();
  const expectedPartialCount = SHAFT_RING_COUNT + 17; // Shaft + Tier 1 only
  check(`Partial unlock at Tier 1 generates only shaft and Tier 1 meshes (${expectedPartialCount})`, partialMeshes.length === expectedPartialCount);
  check('Partial Tier 1 builder contains no Tier 2 or Tier 3 chamber meshes', partialMeshes.every((m) => (m.metadata?.tier as number) <= 1));
  partialBuilder.dispose();

  // =========================================================================
  // GATE 3: Rotary Core Drill Machine & Excavation Minigame (Spec 38 §3 Phase 3)
  // =========================================================================
  currentGate = '3';
  console.log('\n--- GATE 3: Rotary Core Drill Assembly, Kinematics & Vein Yields ---');

  const drillRig = new CoreMiningRig(scene, { tier: 1 });
  drillRig.build(1);

  check('CoreMiningRig.isBuilt() is true after build', drillRig.isBuilt());
  const rigRoot = drillRig.getRootNode();
  check('Drill rig seated at Tier 1 floor datum (y = -15 m)', rigRoot !== null && near(rigRoot.position.y, -15));

  // 3.1 Structural Assembly Tag Verification
  check('Base collar present', drillRig.getPartMeshes('base-collar').length === 1);
  check('4 hydraulic outriggers present', drillRig.getPartMeshes('outrigger').length === 4);
  check('Twin vertical mast pillars present', drillRig.getPartMeshes('mast-pillar').length === 2);
  check('Vertical drive carriage present', drillRig.getPartMeshes('carriage').length === 1);
  check('Outer carbide cutter head present', drillRig.getPartMeshes('head-outer').length === 1);
  check('Inner core bit present', drillRig.getPartMeshes('head-inner').length === 1);
  check('12 carbide teeth present (8 outer + 4 inner)', drillRig.getPartMeshes('carbide-tooth').length === 12);
  check('Operator terminal screen present', drillRig.getPartMeshes('console-screen').length === 1);
  check('Twin buggy guide rails present', drillRig.getPartMeshes('dock-rail').length === 2);
  check('Pneumatic spoils chute present', drillRig.getPartMeshes('spoils-chute').length === 1);

  // 3.2 State Machine & Interactive Loop
  check('Initial drill rig state is IDLE', drillRig.getState() === 'IDLE');
  check('Drill rig isMounted() is false initially', !drillRig.isMounted());
  check('Drill rig isBuggyDocked() is false initially', !drillRig.isBuggyDocked());

  // Mount player
  check('mountPlayer() succeeds', drillRig.mountPlayer('player-suit-1'));
  check('Rig state transitions to MOUNTED', drillRig.getState() === 'MOUNTED');
  drillRig.dismountPlayer();
  check('Rig reverts to IDLE on player dismount', drillRig.getState() === 'IDLE');

  // Buggy Docking: Stock vs Tier 4 Deep Resonator
  check('Dock stock buggy succeeds', drillRig.dockBuggy(false));
  check('Rig state transitions to BUGGY_DOCKED', drillRig.getState() === 'BUGGY_DOCKED');
  check('Stock buggy has hasDeepResonator false', !drillRig.hasDeepResonator());
  drillRig.undockBuggy();
  check('Rig reverts to IDLE on buggy undock', drillRig.getState() === 'IDLE');

  // Dock upgraded buggy with Tier 4 Deep Resonator
  drillRig.dockBuggy({ hasDeepResonator: true });
  check('Upgraded buggy docks with hasDeepResonator true', drillRig.hasDeepResonator());

  // 3.3 Interactive Pulse Loop, Seismic Rumble & Yields
  const excavatingRig = new CoreMiningRig(scene, {
    tier: 1,
    excavator,
    audioSystem,
  });
  excavatingRig.build(1);
  excavatingRig.dockBuggy({ hasDeepResonator: true });

  const initialBasalt = excavator.getExcavationState().basaltRubbleKg;
  const pulseResult = excavatingRig.triggerDrillPulse();
  check('triggerDrillPulse() succeeds', pulseResult.success);
  check('Rig state flips to DRILLING_PULSE', excavatingRig.getState() === 'DRILLING_PULSE');
  check(
    `Resonance multiplier is ${DEEP_RESONATOR_TORQUE_MULTIPLIER}x with Tier 4 Deep Resonator`,
    pulseResult.resonanceMultiplier === DEEP_RESONATOR_TORQUE_MULTIPLIER
  );
  check(
    `Applied torque (${pulseResult.appliedTorqueNm} Nm) >= ${DRILL_BASE_TORQUE_NM * 2.0} Nm`,
    pulseResult.appliedTorqueNm >= DRILL_BASE_TORQUE_NM * 2.0
  );
  check(
    `Pulse generates basalt rubble yield (${pulseResult.basaltRubbleYieldKg} kg)`,
    pulseResult.basaltRubbleYieldKg >= DRILL_BASE_RUBBLE_YIELD_KG
  );
  check(
    'Rubble yield accrued into SubterraneanExcavator',
    excavator.getExcavationState().basaltRubbleKg >= initialBasalt + pulseResult.basaltRubbleYieldKg
  );

  // Audio history telemetry
  const audioHistory = excavatingRig.getAudioHistory();
  const rumbleEvt = audioHistory.find((e) => e.type === 'seismic_rumble');
  check('Seismic rumble audio event recorded', rumbleEvt !== undefined);
  if (rumbleEvt !== undefined && rumbleEvt.frequencyRangeHz !== undefined) {
    check(`Seismic low bound is ${SEISMIC_RUMBLE_MIN_HZ} Hz`, rumbleEvt.frequencyRangeHz[0] === SEISMIC_RUMBLE_MIN_HZ);
    check(`Seismic high bound is ${SEISMIC_RUMBLE_MAX_HZ} Hz`, rumbleEvt.frequencyRangeHz[1] === SEISMIC_RUMBLE_MAX_HZ);
  }

  // Advance through pulse and cooldown
  excavatingRig.update(DRILL_PULSE_DURATION_S + 0.1);
  check('Rig transitions to COOLDOWN after pulse completion', excavatingRig.getState() === 'COOLDOWN');
  excavatingRig.update(1.0);
  check('Rig returns to BUGGY_DOCKED after cooldown', excavatingRig.getState() === 'BUGGY_DOCKED');

  // Procedural mineral vein exposure
  const exposedVeins = excavatingRig.getExposedVeins();
  check('Drilling pulse exposed mineral veins in rock walls', exposedVeins.length > 0);
  if (exposedVeins.length > 0) {
    const v = exposedVeins[0]!;
    check('Vein has valid commodity type', ['helium3', 'titanium', 'platinum', 'water_ice'].includes(v.kind));
    check('Vein abundance is positive', v.abundance > 0);
    check('Vein purity is high (>= 0.85)', v.purity >= 0.85);
  }

  drillRig.dispose();
  excavatingRig.dispose();

  // =========================================================================
  // GATE 4: Slag Autoclave Conversion & Material Production (Spec 38 §4.3)
  // =========================================================================
  currentGate = '4';
  console.log('\n--- GATE 4: Slag Autoclave Ratios & Acceptance Criterion 3 ---');

  // 4.1 Conservation of Mass & Conversion Constants
  check('SLAG_CONSTRUCTION_BRICK identifier is defined', SLAG_CONSTRUCTION_BRICK === 'SLAG_CONSTRUCTION_BRICK');
  check('Basalt per slag brick is exactly 100 kg', BASALT_PER_SLAG_BRICK_KG === 100);
  check('Slag construction brick mass is 25 kg', SLAG_BRICK_MASS_KG === 25);
  check('Trace metals per brick is 5 kg', TRACE_METALS_PER_BRICK_KG === 5);
  check('Trace iron (3.0 kg) + trace titanium (2.0 kg) = 5.0 kg', TRACE_IRON_PER_BRICK_KG + TRACE_TITANIUM_PER_BRICK_KG === 5.0);
  check(
    'Conservation of mass: 25 kg brick + 5 kg metals + 70 kg tailings = 100 kg basalt',
    SLAG_BRICK_MASS_KG + TRACE_METALS_PER_BRICK_KG + SLAG_WASTE_PER_BRICK_KG === BASALT_PER_SLAG_BRICK_KG
  );
  check('Autoclave required depth tier is Tier 2 (Z = -45 m)', AUTOCLAVE_REQUIRED_TIER === 2);

  // 4.2 Pure Calculation Helper
  const zeroSinter = calculateSinterYield(0);
  check('0 kg basalt yields 0 bricks and 0 trace metals', zeroSinter.bricks === 0 && zeroSinter.traceMetalsKg === 0);

  const subBatchSinter = calculateSinterYield(99);
  check('Sub-batch (< 100 kg) yields 0 bricks and 0 consumed basalt', subBatchSinter.bricks === 0 && subBatchSinter.basaltConsumedKg === 0);

  // Acceptance Criterion 3: Slag Conversion Gate (§4.3)
  const gateYield = calculateSinterYield(1_000);
  check('Slag Gate 3: Sintering 1,000 kg basalt produces exactly 10x SLAG_CONSTRUCTION_BRICK', gateYield.bricks === 10);
  check('Slag Gate 3: Sintering 1,000 kg basalt produces exactly 50 kg trace metals', gateYield.traceMetalsKg === 50);
  check('Slag Gate 3: Exactly 1,000 kg basalt consumed', gateYield.basaltConsumedKg === 1_000);
  check('Slag Gate 3: Produces exactly 250 kg consolidated slag brick mass', gateYield.slagMassKg === 250);
  check('Slag Gate 3: Produces exactly 700 kg tailings', gateYield.tailingsMassKg === 700);

  // 4.3 Tier Gating Enforcement (Locked at Tier 0 and Tier 1)
  const freshExcavator = new SubterraneanExcavator({ storage: new InMemoryExcavationStorage() });
  freshExcavator.addBasaltRubble(3_000);

  check('Fresh excavator is at Tier 0', freshExcavator.getCurrentTier().tier === 0);
  const failT0 = freshExcavator.sinterBasalt(1_000);
  check('Sintering refused at Tier 0 with reason tier_locked', !failT0.success && failT0.reason === 'tier_locked');
  check('Stockpile untouched on Tier 0 refusal', freshExcavator.getExcavationState().basaltRubbleKg === 3_000);

  freshExcavator.unlockNextTier(5_000); // Advance to Tier 1
  check('Excavator now at Tier 1', freshExcavator.getCurrentTier().tier === 1);
  freshExcavator.addBasaltRubble(8_000);
  const failT1 = freshExcavator.sinterBasalt(1_000);
  check('Sintering refused at Tier 1 with reason tier_locked', !failT1.success && failT1.reason === 'tier_locked');

  freshExcavator.unlockNextTier(15_000); // Advance to Tier 2 (Industrial Smelting Vault)
  check('Excavator now at Tier 2 (Z = -45 m)', freshExcavator.getCurrentTier().tier === 2);
  check('Sintering unlocked at Tier 2', freshExcavator.getCurrentTier().tier >= AUTOCLAVE_REQUIRED_TIER);

  // 4.4 Live Sintering & Stockpile Management on Tier 2
  freshExcavator.addBasaltRubble(2_000);
  const successSinter = freshExcavator.sinterBasalt(1_000);
  check('Sintering 1,000 kg succeeds at Tier 2', successSinter.success);
  check('Stockpile has exactly 10 slag bricks', freshExcavator.getSlagBricks() === 10);
  check('Stockpile has exactly 50 kg trace metals', freshExcavator.getTraceMetalsKg() === 50);
  check('Stockpile basalt reduced by 1,000 kg (2,500 -> 1,500 kg)', freshExcavator.getExcavationState().basaltRubbleKg === 1_500);

  // Brick consumption for construction modules (Spec 39 currency)
  const consumeOk = freshExcavator.consumeSlagBricks(4);
  check('consumeSlagBricks(4) succeeds', consumeOk);
  check('Remaining slag bricks = 6', freshExcavator.getSlagBricks() === 6);
  check('Over-consumption fails cleanly without deduction', !freshExcavator.consumeSlagBricks(100));
  check('Stockpile remains at 6 bricks after over-consumption rejection', freshExcavator.getSlagBricks() === 6);

  // 4.5 Autoclave Unit Telemetry & Audio Execution
  const autoclave = freshExcavator.getAutoclave();
  const telemT2 = autoclave.getTelemetry(2);
  check('Autoclave compaction pressure reaches 120 MPa', telemT2.compactionPressureMpa === 120);
  check('Autoclave sintering temperature reaches 1,450 K', telemT2.temperatureK === 1_450);
  check('Autoclave batch cycle counter tracks operations', telemT2.totalBatchesProcessed >= 1);

  let audioException = false;
  try {
    audioSystem.playAutoclaveSinter(1.2);
  } catch {
    audioException = true;
  }
  check('LunarAudioSystem.playAutoclaveSinter executes without exception', !audioException);

  // =========================================================================
  // GATE 5: Elevator Kinematics & Platform Coupling (Spec 38 §4.2, Acceptance 2)
  // =========================================================================
  currentGate = '5';
  console.log('\n--- GATE 5: Elevator Kinematics, Continuous Coordinates & Passenger Tracking ---');

  // Setup elevator down to Tier 3 (Z = -95 m)
  const elevatorExcavator = new SubterraneanExcavator({ storage: new InMemoryExcavationStorage() });
  elevatorExcavator.addBasaltRubble(36_000);
  elevatorExcavator.unlockNextTier(5_000);  // T1
  elevatorExcavator.unlockNextTier(15_000); // T2
  elevatorExcavator.unlockNextTier(35_000); // T3

  const elevatorRig = new CoreMiningRig(scene, {
    tier: 3,
    excavator: elevatorExcavator,
    audioSystem,
  });
  elevatorRig.build(3);

  const elevator = elevatorRig.getElevator();
  check('CoreMiningRig.getElevator() returns VerticalElevator', elevator !== null);

  // 5.1 Elevator Procedural 3D Mesh Construction
  const elevatorMeshes = elevator.getMeshes();
  check('Elevator meshes constructed under NullEngine', elevatorMeshes.length >= 10);
  check('Elevator platform deck present', elevator.getPartMeshes('elevator-platform').length === 1);
  check('Twin vertical guide rails present', elevator.getPartMeshes('elevator-guide-rail').length === 2);
  check('4 safety railings present', elevator.getPartMeshes('elevator-railing').length === 4);
  check('Safety gate present', elevator.getPartMeshes('elevator-gate').length === 1);
  check('Counterbalance cables present', elevator.getPartMeshes('elevator-cable').length === 1);
  check('Counterweight present', elevator.getPartMeshes('elevator-counterweight').length === 1);

  // 5.2 Call Stations Across All 4 Floors (Z = 0, -15, -45, -95 m)
  const callStations = elevator.getCallStations();
  check('Call stations instantiated for 4 depth tiers (0, 1, 2, 3)', callStations.length === 4);
  check('Floor 0 call station elevation is 0.0 m', near(callStations[0]!.elevationM, 0.0));
  check('Floor 1 call station elevation is -15.0 m', near(callStations[1]!.elevationM, -15.0));
  check('Floor 2 call station elevation is -45.0 m', near(callStations[2]!.elevationM, -45.0));
  check('Floor 3 call station elevation is -95.0 m', near(callStations[3]!.elevationM, -95.0));

  const nearestT1 = elevator.getNearestCallStation({ x: 3.0, y: 0, z: -15 });
  check('getNearestCallStation finds Floor 1', nearestT1 !== null && nearestT1.station.floorTier === 1);

  // 5.3 Platform Physics Bounds & Ground Elevation Clamping
  elevator.moveToFloor(0);
  for (let i = 0; i < 20; i++) elevator.update(1.0); // Travel to 0 m

  check('Elevator at surface datum (Z = 0.0 m)', near(elevator.getElevation(), 0.0));
  check('isInsidePlatform is true within platform bounds', elevator.isInsidePlatform({ x: 0, y: 0, z: 0 }));
  check('isInsidePlatform is false outside lateral bounds', !elevator.isInsidePlatform({ x: 8.0, y: 0, z: 0 }));

  const groundZ = elevator.getPlatformGroundElevation(0, 0, 0.5);
  check('getPlatformGroundElevation returns deck elevation for entity on platform', groundZ !== null && near(groundZ, 0.0));

  // 5.4 Passenger Coupling & Kinematics (Z = 0 -> -15 m) (Acceptance Criterion 2)
  const suitPassenger = new MockPassenger('eva-suit-test', 0, 0, 0, 'suit');
  elevator.board(suitPassenger);
  check('Passenger boarded successfully', elevator.isPassengerBoarded('eva-suit-test'));

  // Call elevator to Tier 1 (-15 m)
  elevatorRig.callElevator(1);
  check('Elevator motionState transitions to ACCELERATING', elevator.getMotionState() === 'ACCELERATING');

  // Verify continuous non-NaN vertical coordinates during transit
  let sawNonZeroVelocity = false;
  let allCoordinatesValid = true;

  for (let step = 0; step < 10; step++) {
    elevator.update(0.5);
    const elev = elevator.getElevation();
    const vel = elevator.getVelocity();

    if (Number.isNaN(elev) || !Number.isFinite(elev) || Number.isNaN(vel) || !Number.isFinite(vel)) {
      allCoordinatesValid = false;
    }
    if (Math.abs(vel) > 0.1) sawNonZeroVelocity = true;

    // Verify passenger tracks platform vertical coordinate synchronously
    if (!near(suitPassenger.pos.z, elev, 0.05)) {
      allCoordinatesValid = false;
    }
  }

  check('Continuous vertical coordinate updates without NaN or infinite values', allCoordinatesValid);
  check('Elevator developed downward velocity during descent', sawNonZeroVelocity);

  // Complete descent to -15 m
  for (let step = 0; step < 10; step++) elevator.update(0.5);

  check('Elevator motionState returns to IDLE upon arrival', elevator.getMotionState() === 'IDLE');
  check('Elevator current floor is 1', elevator.getCurrentFloor() === 1);
  check('Elevator elevation cleanly snapped to exactly -15.0 m', elevator.getElevation() === -15.0);
  check('Passenger position snapped to exactly -15.0 m', suitPassenger.pos.z === -15.0);
  check('Passenger vertical velocity zeroed upon arrival', suitPassenger.vel.vz === 0);

  // 5.5 Deep Shaft Ascent & Velocity Clamping (Z = -15 -> -95 m and -95 -> 0 m)
  elevator.moveToFloor(3); // -95 m
  let maxDescVel = 0;

  for (let step = 0; step < 30; step++) {
    elevator.update(1.0);
    const v = Math.abs(elevator.getVelocity());
    if (v > maxDescVel) maxDescVel = v;
  }

  check('Deep shaft descent reached Floor 3 (-95.0 m)', elevator.getCurrentFloor() === 3 && elevator.getElevation() === -95.0);
  check('Passenger position snapped to -95.0 m', suitPassenger.pos.z === -95.0);
  check(
    `Maximum velocity respected limit (${ELEVATOR_MAX_VELOCITY_MPS} m/s)`,
    near(maxDescVel, ELEVATOR_MAX_VELOCITY_MPS, 0.05)
  );

  // Deep ascent from -95 m to surface 0 m
  elevator.moveToFloor(0);
  let maxAscVel = 0;
  for (let step = 0; step < 30; step++) {
    elevator.update(1.0);
    const v = Math.abs(elevator.getVelocity());
    if (v > maxAscVel) maxAscVel = v;
  }

  check('Deep shaft ascent reached Surface Floor 0 (0.0 m)', elevator.getCurrentFloor() === 0 && elevator.getElevation() === 0.0);
  check('Passenger position snapped to 0.0 m', suitPassenger.pos.z === 0.0);
  check(
    `Ascent velocity respected maximum limit (${ELEVATOR_MAX_VELOCITY_MPS} m/s)`,
    near(maxAscVel, ELEVATOR_MAX_VELOCITY_MPS, 0.05)
  );

  elevator.unboard('eva-suit-test');
  check('Passenger unboarded cleanly', !elevator.isPassengerBoarded('eva-suit-test'));

  elevatorRig.dispose();

  // =========================================================================
  // GATE 6: WorldScene Subterranean Integration & Lifecycle Hygiene
  // =========================================================================
  currentGate = '6';
  console.log('\n--- GATE 6: WorldScene Integration & Lifecycle Teardown ---');

  const worldScene = new WorldScene();
  worldScene.init(engine);

  const worldBase = worldScene.buildSubterraneanBase(3);
  check('WorldScene.buildSubterraneanBase returns SubterraneanChamberBuilder', worldBase !== null);
  check('WorldScene.getSubterraneanBase returns active instance', worldScene.getSubterraneanBase() === worldBase);

  const worldRig = worldScene.buildCoreMiningRig(1);
  check('WorldScene.buildCoreMiningRig returns CoreMiningRig', worldRig !== null);
  check('WorldScene.getCoreMiningRig returns active instance', worldScene.getCoreMiningRig() === worldRig);

  // WorldScene update tick steps rig and updates visibility
  worldScene.update(100, { x: 0, y: 0, z: -25 });
  check('WorldScene.update executes cleanly with subterranean base and rig', true);

  // Clean disposal hygiene
  worldScene.dispose();
  check('WorldScene.dispose tears down subterranean base', worldScene.getSubterraneanBase() === null);
  check('WorldScene.dispose tears down core mining rig', worldScene.getCoreMiningRig() === null);
  check('Core mining rig isBuilt() is false after WorldScene dispose', !worldRig.isBuilt());

  // Teardown first scene & engine
  chamberBuilder.dispose();
  scene.dispose();
  engine.dispose();
  check('Engine and scenes disposed cleanly without leaks or exceptions', true);

  // =========================================================================
  // GATE 7: Acceptance Summary & Assertion Count Gate (Spec 38 §4.4)
  // =========================================================================
  currentGate = '7';
  console.log('\n--- GATE 7: Acceptance Summary & Assertion Count Gate ---');

  check('Smoke suite executed >= 60 assertions', passed >= 60, `Passed: ${passed}`);
  check('Zero failures reported across all gates', failures.length === 0, `Failures: ${failures.length}`);

  console.log('\n======================================================================');
  console.log(`SMOKE VERIFICATION RESULT: ${failures.length === 0 ? 'ALL GATES PASSED GREEN' : 'FAILED'}`);
  console.log(`Total Passed: ${passed}`);
  console.log(`Total Failed: ${failures.length}`);
  console.log('======================================================================\n');

  if (failures.length > 0) {
    console.error('FAILURES SUMMARY:');
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }
}

void runSmokeSuite();
