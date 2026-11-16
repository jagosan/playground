/**
 * Spec 38 Phase 3 probe — Rotary Core Drill Machine & Excavation Minigame.
 *
 * Headless NullEngine verification exercising {@link CoreMiningRig}:
 *  1. 3D procedural rig construction under NullEngine (zero DOM/canvas/GLB).
 *  2. Mesh hierarchy: base collar, outriggers, vertical mast, carriage,
 *     outer carbide cutter head, inner counter-rotating core bit, operator
 *     console, buggy docking bay, and pneumatic spoils chute.
 *  3. Target depth tier floor positioning (Z = −15, −45, −95 m).
 *  4. Counter-rotating carbide drill head kinematics (outer CW vs inner CCW).
 *  5. Interactive drilling loop: player mounting, buggy docking, Tier 4 Deep
 *     Core Resonator detection, and high-torque pulse triggering.
 *  6. Audio synthesis & telemetry: low-frequency seismic rumble (35--65 Hz),
 *     metallic stone shearing, and pneumatic spoils discharge.
 *  7. Excavation yields: Basalt Rubble accrual in {@link SubterraneanExcavator}
 *     and procedural mineral vein exposure in chamber rock walls.
 *  8. Occlusion culling: surface vs subterranean visibility transitions.
 *  9. Clean disposal hygiene and double-dispose safety.
 * 10. WorldScene integration: build, update tick, and teardown.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import {
  CoreMiningRig,
  DRILL_RIG_NAME_PREFIX,
  DRILL_BASE_TORQUE_NM,
  DEEP_RESONATOR_TORQUE_MULTIPLIER,
  SEISMIC_RUMBLE_MIN_HZ,
  SEISMIC_RUMBLE_MAX_HZ,
  DRILL_PULSE_DURATION_S,
} from '../src/base/CoreMiningRig.ts';
import { SubterraneanExcavator, InMemoryExcavationStorage } from '../src/base/SubterraneanExcavator.ts';
import { LunarAudioSystem } from '../src/audio/LunarAudioSystem.ts';
import { WorldScene } from '../src/engine/WorldScene.ts';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (!cond) {
    failures += 1;
    console.error(`FAIL  ${label}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

/** Approx numeric equality within tolerance. */
const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) <= eps;

async function main(): Promise<void> {
  const engine = new NullEngine();
  const scene = new Scene(engine);

  // =========================================================================
  // 1. Rig Construction & NullEngine Safety (Spec 38 §3 Phase 3)
  // =========================================================================
  console.log('--- 1. Testing CoreMiningRig 3D Assembly & Placement ---');
  const rig = new CoreMiningRig(scene, { tier: 1 });
  check('rig instantiated', rig !== null);
  check('isBuilt() false before build', !rig.isBuilt());

  rig.build(1);
  check('isBuilt() true after build(1)', rig.isBuilt());
  check('root node present', rig.getRootNode() !== null);

  const root = rig.getRootNode()!;
  check('seated at Tier 1 floor datum (y = −15 m)', near(root.position.y, -15));

  const meshes = rig.getMeshes();
  check(`rig created meshes (found ${meshes.length})`, meshes.length >= 20);

  // Verify key structural part tags
  const collars = rig.getPartMeshes('base-collar');
  check('base collar present', collars.length === 1);

  const outriggers = rig.getPartMeshes('outrigger');
  check('4 hydraulic outriggers present', outriggers.length === 4);

  const mastPillars = rig.getPartMeshes('mast-pillar');
  check('twin vertical mast pillars present', mastPillars.length === 2);

  const carriage = rig.getPartMeshes('carriage');
  check('vertical drive carriage present', carriage.length === 1);

  const headOuter = rig.getPartMeshes('head-outer');
  check('outer carbide cutter head present', headOuter.length === 1);

  const headInner = rig.getPartMeshes('head-inner');
  check('inner core bit present', headInner.length === 1);

  const teeth = rig.getPartMeshes('carbide-tooth');
  check('carbide cutter teeth present on heads (8 outer + 4 inner = 12)', teeth.length === 12);

  const consoleScreen = rig.getPartMeshes('console-screen');
  check('operator console terminal screen present', consoleScreen.length === 1);

  const dockRails = rig.getPartMeshes('dock-rail');
  check('twin buggy guide rails present', dockRails.length === 2);

  const spoilsChute = rig.getPartMeshes('spoils-chute');
  check('pneumatic spoils discharge chute present', spoilsChute.length === 1);

  // =========================================================================
  // 2. Interactive Mounting & Buggy Docking States
  // =========================================================================
  console.log('--- 2. Testing Interactive Loop: Mounting & Docking ---');
  check('initial state is IDLE', rig.getState() === 'IDLE');
  check('isMounted() false', !rig.isMounted());
  check('isBuggyDocked() false', !rig.isBuggyDocked());

  // Mount player
  const mountSuccess = rig.mountPlayer('player-eva-1');
  check('mountPlayer() succeeds', mountSuccess);
  check('state transitions to MOUNTED', rig.getState() === 'MOUNTED');
  check('isMounted() true', rig.isMounted());

  // Dismount
  rig.dismountPlayer();
  check('state reverts to IDLE after dismount', rig.getState() === 'IDLE');
  check('isMounted() false after dismount', !rig.isMounted());

  // Dock stock buggy (no resonator)
  rig.dockBuggy(false);
  check('state transitions to BUGGY_DOCKED', rig.getState() === 'BUGGY_DOCKED');
  check('isBuggyDocked() true', rig.isBuggyDocked());
  check('hasDeepResonator() false for stock buggy', !rig.hasDeepResonator());

  // Dock Tier 4 Deep Resonator buggy
  rig.dockBuggy({ hasDeepResonator: true });
  check('dock with hasDeepResonator true', rig.hasDeepResonator());

  // =========================================================================
  // 3. Counter-Rotating Kinematics & High-Torque Drilling Pulse
  // =========================================================================
  console.log('--- 3. Testing Counter-Rotating Kinematics & Drilling Pulse ---');
  const pose0 = rig.getHeadPose();
  check('initial outer heading = 0', pose0.headingOuterRad === 0);
  check('initial inner heading = 0', pose0.headingInnerRad === 0);
  check('initial penetration = 0', pose0.penetrationM === 0);

  // Trigger high-torque drilling pulse with Deep Resonator docked
  const pulseRes = rig.triggerDrillPulse();
  check('pulse succeeds', pulseRes.success);
  check('state is DRILLING_PULSE', rig.getState() === 'DRILLING_PULSE');
  check('resonance multiplier = 2.5 with Tier 4 Deep Resonator', pulseRes.resonanceMultiplier === DEEP_RESONATOR_TORQUE_MULTIPLIER);
  check(`applied torque (${pulseRes.appliedTorqueNm} Nm) >= 90,000 Nm`, pulseRes.appliedTorqueNm >= DRILL_BASE_TORQUE_NM * 2.0);
  check('basalt rubble yield > 0', pulseRes.basaltRubbleYieldKg > 0);

  // Step simulation frame by frame during active pulse
  rig.update(0.5); // dt = 0.5s into pulse
  const poseActive = rig.getHeadPose();
  check('outer head rotating clockwise (omega > 0)', poseActive.omegaOuterRadPerS > 0);
  check('inner head rotating counter-clockwise (omega < 0)', poseActive.omegaInnerRadPerS < 0);
  check('outer heading increased (rad > 0)', poseActive.headingOuterRad > 0);
  check('inner heading decreased (rad < 0)', poseActive.headingInnerRad < 0);
  check('carriage penetration extended into bedrock (> 0m)', poseActive.penetrationM > 0);

  // Advance through remaining pulse duration (1.8s total)
  rig.update(1.4);
  check('pulse concludes, transitions to COOLDOWN', rig.getState() === 'COOLDOWN');

  // Advance through cooldown (0.5s)
  rig.update(0.6);
  check('cooldown completes, returns to BUGGY_DOCKED', rig.getState() === 'BUGGY_DOCKED');
  const poseDone = rig.getHeadPose();
  check('heads stop rotating in stowed state (omegaOuter = 0)', poseDone.omegaOuterRadPerS === 0);
  check('heads stop rotating in stowed state (omegaInner = 0)', poseDone.omegaInnerRadPerS === 0);
  check('carriage penetration retracted to 0', near(poseDone.penetrationM, 0, 0.05));

  // =========================================================================
  // 4. Audio Synthesis Telemetry & Web Audio Integration
  // =========================================================================
  console.log('--- 4. Testing Procedural Audio Telemetry ---');
  const audioHistory = rig.getAudioHistory();
  const rumbleEvt = audioHistory.find((e) => e.type === 'seismic_rumble');
  check('seismic rumble audio event recorded', rumbleEvt !== undefined);
  if (rumbleEvt !== undefined) {
    check(`seismic low bound == ${SEISMIC_RUMBLE_MIN_HZ} Hz`, rumbleEvt.frequencyRangeHz?.[0] === SEISMIC_RUMBLE_MIN_HZ);
    check(`seismic high bound == ${SEISMIC_RUMBLE_MAX_HZ} Hz`, rumbleEvt.frequencyRangeHz?.[1] === SEISMIC_RUMBLE_MAX_HZ);
  }

  const shearEvt = audioHistory.find((e) => e.type === 'stone_shearing');
  check('metallic stone shearing event recorded', shearEvt !== undefined);

  const spoilsEvt = audioHistory.find((e) => e.type === 'spoils_discharge');
  check('pneumatic spoils discharge event recorded', spoilsEvt !== undefined);

  // Exercise real LunarAudioSystem drill methods in headless environment
  const audio = new LunarAudioSystem();
  audio.init();
  audio.playDrillSeismicRumble();
  audio.playDrillStoneShearing();
  audio.playDrillSpoilsDischarge();
  audio.playDrillPulse(DRILL_PULSE_DURATION_S);
  check('LunarAudioSystem drill methods execute headlessly without error', true);
  audio.dispose();

  // Attach audio system to rig
  rig.setAudioSystem(audio);
  check('audio system attached to rig', rig.getAudioSystem() === audio);

  // =========================================================================
  // 5. Excavator Integration & Mineral Vein Discovery
  // =========================================================================
  console.log('--- 5. Testing SubterraneanExcavator Integration & Mineral Veins ---');
  const storage = new InMemoryExcavationStorage();
  const excavator = new SubterraneanExcavator({ storage });
  const rigWithExcavator = new CoreMiningRig(scene, { tier: 2, excavator });
  rigWithExcavator.build(2);
  check('rig stationed at Tier 2 floor datum (y = −45 m)', near(rigWithExcavator.getRootNode()!.position.y, -45));

  const startBasalt = excavator.getExcavationState().basaltRubbleKg;
  rigWithExcavator.mountPlayer();
  const p1 = rigWithExcavator.triggerDrillPulse();
  check('pulse adds basalt to SubterraneanExcavator', excavator.getExcavationState().basaltRubbleKg === startBasalt + p1.basaltRubbleYieldKg);

  // Advance simulation and trigger repeated pulses to expose mineral veins
  rigWithExcavator.update(2.5); // finish pulse & cooldown
  const p2 = rigWithExcavator.triggerDrillPulse();
  rigWithExcavator.update(2.5);
  const p3 = rigWithExcavator.triggerDrillPulse();

  const exposedVeins = rigWithExcavator.getExposedVeins();
  check(`mineral veins exposed in rock walls (found ${exposedVeins.length})`, exposedVeins.length > 0);
  if (exposedVeins.length > 0) {
    const v0 = exposedVeins[0]!;
    check('vein has valid kind', ['helium3', 'titanium', 'platinum', 'water_ice'].includes(v0.kind));
    check('vein has positive abundance', v0.abundance > 0);
    check('vein has high purity (>= 0.85)', v0.purity >= 0.85);
    check('vein mesh instantiated in scene', v0.mesh !== undefined);
  }

  // =========================================================================
  // 6. Occlusion Culling (Surface vs Underground)
  // =========================================================================
  console.log('--- 6. Testing Occlusion Culling ---');
  rigWithExcavator.updateVisibility(0); // Surface datum (Z >= −2.0 m)
  const rigMeshes = rigWithExcavator.getMeshes().filter((m) => m.metadata?.rig === DRILL_RIG_NAME_PREFIX);
  check('all rig meshes culled on surface', rigMeshes.every((m) => !m.isVisible));

  rigWithExcavator.updateVisibility(-30); // Underground (Z < −2.0 m)
  check('all rig meshes revealed underground', rigMeshes.every((m) => m.isVisible));

  // =========================================================================
  // 7. Clean Disposal Hygiene
  // =========================================================================
  console.log('--- 7. Testing Clean Disposal Hygiene ---');
  rigWithExcavator.dispose();
  check('isBuilt() false after dispose', !rigWithExcavator.isBuilt());
  check('root node nulled after dispose', rigWithExcavator.getRootNode() === null);
  check('meshes drained after dispose', rigWithExcavator.getMeshes().length === 0);
  // Double dispose safe
  rigWithExcavator.dispose();
  check('idempotent double-dispose does not throw', true);

  // =========================================================================
  // 8. WorldScene Integration Gate
  // =========================================================================
  console.log('--- 8. Testing WorldScene Integration ---');
  const worldScene = new WorldScene();
  worldScene.init(engine);

  const worldRig = worldScene.buildCoreMiningRig(1);
  check('WorldScene.buildCoreMiningRig returns CoreMiningRig', worldRig !== null);
  check('WorldScene.getCoreMiningRig returns active instance', worldScene.getCoreMiningRig() === worldRig);
  check('world rig parented to terrain root', worldRig.getRootNode()?.parent !== null);

  // WorldScene update loop steps rig
  worldScene.update(100, { x: 0, y: 0, z: -20 });
  check('WorldScene.update executes cleanly with coreMiningRig', true);

  // WorldScene teardown cleans up rig
  worldScene.dispose();
  check('WorldScene.dispose tears down coreMiningRig', worldScene.getCoreMiningRig() === null);
  check('worldRig isBuilt() false after WorldScene dispose', !worldRig.isBuilt());

  // Teardown first rig & scene
  rig.dispose();
  scene.dispose();
  engine.dispose();

  console.log('===========================================================');
  if (failures > 0) {
    console.error(`TOTAL FAILURES: ${failures}`);
    process.exit(1);
  } else {
    console.log('ALL SPEC 38 PHASE 3 CHECKS PASSED CLEANLY');
  }
}

void main();
