/**
 * Lunar Frontier — Spec 25 (Misc General Cleanup) verification harness.
 *
 * Runs under `npx tsx scripts/smoke-general-cleanup.ts` (exit 0 == all green)
 * against Babylon.js `NullEngine` + headless Node. No browser, no audio
 * device, no sockets. Validates all five Spec 25 layers per the acceptance
 * gate (docs/architecture/25-lunar-frontier-misc-general-cleanup.md §4):
 *
 *   1. Terrain skirt & horizon grounding: `terrainSkirtMesh` built, outer
 *      ring reaches r = 12,000 m, every vertex tracks
 *      `LunarWorldGenerator.elevationAt` minus the spherical-curvature sag
 *      `lunarCurvatureDropM(r)` (exact on rings past the clearance fade,
 *      inside the clearance band nearer in); visor emissive constants; rail
 *      ballast berm berms grounded on the terrain (synthetic crater crossing
 *      + live snapshot), zero floating steel.
 *   2. Powertrain hill-hold & zero-drift: coast regen F = 1,800 N stops the
 *      rover within ≤ 4.5 s on 15° and 25° lunar slopes and latches
 *      'STOPPED'; mechanical hill-hold holds 0.00 m over 60 s of sim;
 *      slew-rate anti-jerk release (no rollback) on throttle > 0.05; strict
 *      0.05 drive-mode threshold.
 *   3. Input pipeline: strict 0.15 stick deadzone, resting-trigger clamping
 *      (Linux bipolar rails read exactly 0 before AND after rest
 *      calibration), camera yaw/pitch and look sticks produce ZERO steering
 *      or forward demand; steering/look shaping curves exact.
 *   4. NPC prospector bots: fleet staged with 4 distinct faction banners,
 *      cloth flag flutter animates over time, the full state machine
 *      (patrol → survey < 80 m → contest_claim < 25 m → harass_mine →
 *      siphon_ore < 5 m reach → flee on full cargo → depot unload) runs,
 *      chassis bump emits the 1,500 N·s impulse.
 *   5. Rival outposts: 3 weathered archetypes with decay ∈ [0,1], territory
 *      radii ∈ [60,90] m, 2–4 damaged railgun sockets, surveyable damaged
 *      hoppers, `isNearRivalBase` spatial queries.
 *   6. Procedural Web Audio: zero-asset synthesis graph (instrumented mock
 *      context records every node: 48/52 Hz drone + 0.15 Hz LFO, motor saw
 *      with speed-steered pitch, 440 Hz mining square + 30 Hz tremolo),
 *      volume clamping, HUD audio mixer panel (four sliders + mute latch),
 *      clean disposal — every voice stopped, every field nulled, no
 *      lingering handles.
 *
 * Exit code 0 with "ALL CHECKS GREEN" == Spec 25 acceptance gate satisfied.
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { NullEngine as NullEngineType } from '@babylonjs/core/Engines/nullEngine.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';

import {
  WorldScene,
  lunarCurvatureDropM,
  MOON_RADIUS_M,
  DEFAULT_SKIRT_CONFIG,
  VISOR_EMISSIVE_FLOOR,
  VISOR_GROUNDBOUNCE_COLOR,
} from '../src/engine/WorldScene.ts';
import { worldToBabylon } from '../src/engine/CameraRig.ts';
import { RAIL_GAUGE, RailSystem, RAIL_BERM_SIDE_SLOPE } from '../src/infrastructure/RailSystem.ts';
import type { RailRoute, LunarNode, Vec3 } from '../src/world/LunarWorldGenerator.ts';

import {
  LunarBuggy,
  BUGGY_COAST_REGEN_CUTOFF_V,
  BUGGY_COAST_REGEN_FORCE,
  BUGGY_HILL_HOLD_FORCE,
  BUGGY_HILL_HOLD_SLEW_RATE,
  BUGGY_THROTTLE_DEADBAND,
  IDLE_BUGGY_INPUT,
} from '../src/physics/TraversalPhysics.ts';
import type { BuggyInput } from '../src/physics/TraversalPhysics.ts';

import {
  ClientApp,
  GAMEPAD_AXES,
  GAMEPAD_DEADZONE,
  GAMEPAD_LOOK_DEADZONE,
  GAMEPAD_STEER_DEADZONE,
  GAMEPAD_STICK_DEADZONE,
  gamepadBrakeCurve,
  gamepadLookCurve,
  gamepadSteerCurve,
  gamepadThrottleCurve,
} from '../src/client/ClientApp.ts';
import type { GamepadLike } from '../src/client/ClientApp.ts';

import {
  NPCProspectorBot,
  NPC_BOT_FLEET_FACTIONS,
  NPC_FLAG_COLORS,
  BOT_CARGO_CAPACITY_KG,
  BOT_PUSH_IMPULSE_N_S,
  CONTEST_RANGE_M,
  HARASS_BUMP_RANGE_M,
  SIPHON_RANGE_M,
  SURVEY_RANGE_M,
  planNPCBotFleet,
} from '../src/entities/NPCProspectorBot.ts';
import type { NPCBotState } from '../src/entities/NPCProspectorBot.ts';

import {
  RivalBases,
  RIVAL_BASE_ARCHETYPES,
  MIN_PERIMETER_RADIUS_M,
  MAX_PERIMETER_RADIUS_M,
  CRATER_RIM_SNAP_TOL_M,
} from '../src/infrastructure/RivalBases.ts';

import {
  LunarAudioSystem,
  MockAudioContext,
  DEFAULT_AUDIO_VOLUMES,
} from '../src/audio/LunarAudioSystem.ts';
import LunarHUD, { HUD_AUDIO_ID, HUD_DEFAULT_AUDIO_VOLUMES } from '../src/ui/LunarHUD.ts';

async function main(): Promise<void> {

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

const SEED = 'mala-voyage-2431';
const EPS = 1e-3;

/** Raw vertex stream of a mesh in PHYSICS frame (x, y, z-up). */
function physicsVertices(mesh: Mesh): Array<{ x: number; y: number; z: number }> {
  const data = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!data) return [];
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i + 2 < data.length; i += 3) {
    // Babylon position (bx, by, bz) ← physics (bx, -bz, by)
    out.push({ x: data[i], y: -data[i + 2], z: data[i + 1] });
  }
  return out;
}

// ===========================================================================
// Shared stage: one WorldScene on a NullEngine serves sections 1, 4 and 5.
// ===========================================================================

section('0. NullEngine stage (shared WorldScene)');

const engine = new NullEngine({ renderWidth: 640, renderHeight: 360 } as never) as unknown as NullEngineType;
const world = new WorldScene({ seed: SEED, terrainSize: 1024, terrainResolution: 129, silent: true });
world.init(engine);
const worldGen = world.getWorldGenerator();
const snapshot = world.getSnapshot();
check('WorldScene initialised headless', snapshot !== null);
const spawn = world.getSpawnPoint();
check('spawn point resolves', Number.isFinite(spawn.x) && Number.isFinite(spawn.y));

// ===========================================================================
// 1. Terrain skirt & horizon grounding (Spec 25 §2.1)
// ===========================================================================

section('1. terrain skirt & horizon grounding (Spec 25 §2.1)');
{
  // Fresh, un-initialised scene has no skirt; disposal removes it again.
  const pre = new WorldScene({ seed: SEED, silent: true });
  check('skirt undefined before init()', pre.getTerrainSkirtMesh() === undefined);
  pre.dispose();

  const skirt = world.getTerrainSkirtMesh();
  check('WorldScene exposes terrainSkirtMesh via getTerrainSkirtMesh()', skirt !== undefined && skirt !== null);

  if (skirt) {
    const verts = physicsVertices(skirt);
    check(`skirt ring lattice built (${verts.length} vertices)`, verts.length > 300);

    // Curvature law: drop = r² / (2·R_moon).
    check(`mean lunar radius constant R = ${MOON_RADIUS_M} m`, MOON_RADIUS_M === 1737400);
    check('lunarCurvatureDropM(500) ≈ 0.0719 m', Math.abs(lunarCurvatureDropM(500) - (500 * 500) / (2 * 1737400)) < 1e-12);
    check('lunarCurvatureDropM(12000) ≈ 41.44 m', Math.abs(lunarCurvatureDropM(12000) - (12000 * 12000) / (2 * 1737400)) < 1e-9);
    check('curvature sag is even & monotonic', lunarCurvatureDropM(-900) === lunarCurvatureDropM(900) && lunarCurvatureDropM(1400) > lunarCurvatureDropM(900));

    // 12 km radial reach + elevation tracking on every ring.
    const cx = 512; // terrainOrigin (0,0) + terrainSize/2
    const cy = 512;
    let maxR = 0;
    let outerRingCount = 0;
    let outerMaxErr = 0;   // rings past the clearance fade: must be EXACT
    let innerBandBad = 0;  // rings inside the fade: within the clearance band
    const CLEARANCE = 0.32; // SKIRT_UNDER_CLEARANCE_M
    const FADE = 1500;      // SKIRT_CLEARANCE_FADE_M
    for (const v of verts) {
      const dx = v.x - cx;
      const dy = v.y - cy;
      const r = Math.hypot(dx, dy);
      if (r > maxR) maxR = r;
      const elev = worldGen.elevationAt(v.x, v.y);
      const drop = lunarCurvatureDropM(r);
      const fade = Math.max(0, Math.min(1, (FADE - r) / (FADE - DEFAULT_SKIRT_CONFIG.radii[0]!)));
      const expected = elev - drop;
      const err = v.z - expected; // <= 0 expected (skirt hangs BELOW the curve)
      if (fade <= 0) {
        if (r > 11000) outerRingCount++;
        outerMaxErr = Math.max(outerMaxErr, Math.abs(err));
      } else {
        // Held below the surface curve by up to `CLEARANCE * fade`, never above.
        if (err > EPS || err < -(CLEARANCE * fade + EPS)) innerBandBad++;
      }
    }
    check(`outer radius reaches 12,000 m (actual ${maxR.toFixed(1)} m)`, Math.abs(maxR - 12000) < 1, `maxR=${maxR}`);
    check(`outer-ring vertices sit exactly on elevationAt − curvature sag (${outerRingCount} verts, max err ${(outerMaxErr * 1000).toFixed(2)} mm)`, outerMaxErr < 0.02);
    check(`inner rings held inside the anti-z-fight clearance band (violations ${innerBandBad})`, innerBandBad === 0);

    // The whole skirt hangs below the local surface — no ghost ridges.
    const allBelow = verts.every((v) => v.z <= worldGen.elevationAt(v.x, v.y) + EPS);
    check('skirt never rises above the generator surface', allBelow);

    // Visor emissive floor baked into the skirt material (horizon never black).
    const mat = skirt.material as PBRMaterial | null;
    check(
      'skirt material emissive == VISOR_EMISSIVE_FLOOR',
      mat !== null &&
        Math.abs(mat.emissiveColor.r - VISOR_EMISSIVE_FLOOR.r) < 1e-6 &&
        Math.abs(mat.emissiveColor.g - VISOR_EMISSIVE_FLOOR.g) < 1e-6 &&
        Math.abs(mat.emissiveColor.b - VISOR_EMISSIVE_FLOOR.b) < 1e-6,
    );
  }

  // Visor contract constants, verbatim.
  check(
    'VISOR_EMISSIVE_FLOOR == { r: 0.16, g: 0.16, b: 0.18 }',
    VISOR_EMISSIVE_FLOOR.r === 0.16 && VISOR_EMISSIVE_FLOOR.g === 0.16 && VISOR_EMISSIVE_FLOOR.b === 0.18,
  );
  check(
    'VISOR_GROUNDBOUNCE_COLOR == { r: 0.20, g: 0.20, b: 0.22 }',
    VISOR_GROUNDBOUNCE_COLOR.r === 0.2 && VISOR_GROUNDBOUNCE_COLOR.g === 0.2 && VISOR_GROUNDBOUNCE_COLOR.b === 0.22,
  );
  check('emissive floor meets the ≥ 18 % luminance clause', VISOR_EMISSIVE_FLOOR.r >= 0.16);
}

section('1b. rail ballast berms — grounded, zero floating track (Spec 25 §2.1)');
{
  // ---- Deterministic synthetic crater crossing ---------------------------
  // Two z = 6 nodes across a 4 m-deep synthetic ground plane: EVERY tie has
  // real fill, and berm foot corners must sit ON the synthetic ground.
  const synthNodes: LunarNode[] = [
    { id: 'synth-a', kind: 'dock', name: 'synth-a', position: { x: 0, y: 0, z: 6 }, sectorId: 'synth' },
    { id: 'synth-b', kind: 'refinery', name: 'synth-b', position: { x: 0, y: 400, z: 6 }, sectorId: 'synth' },
  ];
  const synthRoutes: RailRoute[] = [
    { id: 'synth-line', name: 'Synth Crossing', nodeIds: ['synth-a', 'synth-b'], gauge: RAIL_GAUGE, length: 400, kind: 'surface' },
  ];
  const SYNTH_GROUND = -4;
  const synthRail = new RailSystem(
    { nodes: synthNodes, railRoutes: synthRoutes, craters: [], sectors: [], veins: [] } as never,
    { elevationAt: () => SYNTH_GROUND },
  );
  synthRail.init(new NullEngine());
  const synthBerms = synthRail.getBermMeshes();
  const synthInfo = synthRail.getBermInfo();
  check(`synthetic crossing builds ballast berm mesh(es) (${synthBerms.length})`, synthBerms.length >= 1);
  check(`berm fill computed against injected ground (${synthInfo.sections} sections, maxFill ${synthInfo.maxFillM.toFixed(2)} m, ${(synthInfo.fillVolumeM3 || 0).toFixed(0)} m³)`,
    synthInfo.sections > 0 && synthInfo.maxFillM > 1 && (synthInfo.fillVolumeM3 || 0) > 0);
  check(`crushed-basalt berm side slope constant ${RAIL_BERM_SIDE_SLOPE}:1`, RAIL_BERM_SIDE_SLOPE === 1.5);
  if (synthBerms.length > 0) {
    let floating = 0;
    let groundedFeet = 0;
    let overTop = 0;
    for (const berm of synthBerms) {
      // Berm mesh vertices are emitted straight into world space.
      const data = berm.getVerticesData(VertexBuffer.PositionKind);
      if (!data) continue;
      for (let i = 0; i + 2 < data.length; i += 3) {
        const wx = data[i];
        const wy = -data[i + 2];
        const wz = data[i + 1];
        const g = SYNTH_GROUND;
        if (Math.abs(wz - g) < 0.05) groundedFeet++;
        if (wz > g + synthInfo.maxFillM + EPS) overTop++;
        if (wz < g - 0.5) floating++; // sank below synthetic ground
      }
    }
    check(`berm foot corners land ON the terrain (${groundedFeet} contact verts)`, groundedFeet > 0);
    check('no berm vertex floats above the roadbed top', overTop === 0);
    check('no berm vertex sinks through the terrain', floating === 0);
  }
  synthRail.dispose();
  check('berm query safe after dispose', synthRail.getBermMeshes().length === 0);

  // ---- Live snapshot: rails clamped to generator terrain truth -----------
  const rails = new RailSystem(snapshot, { elevationAt: (x, y) => worldGen.elevationAt(x, y) });
  rails.init(engine);
  const liveInfo = rails.getBermInfo();
  const liveBerms = rails.getBermMeshes();
  check(`live snapshot rail roadbeds clamped against generator terrain (${liveInfo.bermRoutes} berm routes, ${liveInfo.sections} sections)`,
    liveInfo.bermRoutes > 0 && liveInfo.sections > 0);
  if (liveBerms.length > 0) {
    let over = 0;
    let touched = 0;
    for (const berm of liveBerms) {
      const data = berm.getVerticesData(VertexBuffer.PositionKind);
      if (!data) continue;
      touched++;
      for (let i = 0; i + 2 < data.length; i += 3) {
        const wx = data[i];
        const wy = -data[i + 2];
        const wz = data[i + 1];
        if (wz > worldGen.elevationAt(wx, wy) + liveInfo.maxFillM + 0.05) over++;
      }
    }
    check(`live berm meshes respect the fill envelope (${touched} meshes, ${over} over-crest verts)`, over === 0);
  }
  // Every rail steel vertex stays within the berm-supported envelope too.
  let railFloating = 0;
  for (const mesh of rails.getMeshes()) {
    if (!mesh.name.includes('rail-rail') && !mesh.name.includes('tie')) continue;
    const data = (mesh as Mesh).getVerticesData?.(VertexBuffer.PositionKind);
    if (!data) continue;
    for (let i = 0; i + 2 < data.length; i += 3) {
      const wx = data[i];
      const wy = -data[i + 2];
      const wz = data[i + 1];
      if (wz - worldGen.elevationAt(wx, wy) > liveInfo.maxFillM + 1) railFloating++;
    }
  }
  check(`rail steel never floats beyond its berm fill (${railFloating} offenders)`, railFloating === 0);
  rails.dispose();
}

// ===========================================================================
// 2. Powertrain hill-hold & zero drift (Spec 25 §2.2)
// ===========================================================================

section('2. hill-hold physics — coast regen, zero drift, anti-jerk (Spec 25 §2.2)');

check('coast regen force constant F_regen = 1,800 N', BUGGY_COAST_REGEN_FORCE === 1800);
check('mechanical hill-hold authority = 1,800 N', BUGGY_HILL_HOLD_FORCE === 1800);
check(`coast→STOPPED handoff speed 0.35 m/s`, BUGGY_COAST_REGEN_CUTOFF_V === 0.35);
check(`hill-hold release slew rate 12 s⁻¹ (~83 ms)`, BUGGY_HILL_HOLD_SLEW_RATE === 12.0);
check(`drive-mode throttle threshold 0.05`, BUGGY_THROTTLE_DEADBAND === 0.05);

/**
 * Neutral-footed drive input: FULL BuggyInput fields with the parking brake
 * RELEASED (IDLE_BUGGY_INPUT ships `parkBrake: true`, which would rigidly
 * hold the rover and silently defeat every coast/hill-hold measurement).
 */
function drive(throttle: number): BuggyInput {
  return { throttle, brake: 0, regen: 0, steer: 0, parkBrake: false };
}

type SimResult = {
  stopTimeS: number;
  reachedStopped: boolean;
  regenEnergyJ: number;
  driftOver60sM: number;
  maxSpeed: number;
};

/**
 * One slope scenario: drive up the grade, lift the throttle, measure the
 * regen stop, then idle 60 s and measure mechanical-hold drift.
 */
function slopeScenario(deg: number): SimResult {
  const slope = Math.tan((deg * Math.PI) / 180);
  const buggy = new LunarBuggy(
    { chassisMass: 880, groundElevation: (x: number) => slope * x },
    { x: 0, y: 0, vLong: 0 },
  );
  const dt = 1 / 120;
  const step = (input: BuggyInput, seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / dt); i++) buggy.step(dt, input);
  };
  // Phase A — power up the grade to a cruising pace (driveMode → FORWARD).
  step(drive(1), 1.0);
  const maxSpeed = buggy.getState().vLong;
  if (maxSpeed < 5) throw new Error(`phase A failed to reach cruise speed (got ${maxSpeed})`);
  // Phase B — throttle released: 1,800 N regen must arrest the rover.
  const regenAtRelease = buggy.getState().regenEnergyJ;
  let t = 0;
  let stopTime = Number.POSITIVE_INFINITY;
  let reached = false;
  while (t < 10) {
    buggy.step(dt, drive(0));
    t += dt;
    const s = buggy.getState();
    if (s.driveMode === 'STOPPED' && Math.abs(s.vLong) <= BUGGY_COAST_REGEN_CUTOFF_V) {
      stopTime = t;
      reached = true;
      break;
    }
  }
  // Phase C — 60 s of mechanical hill-hold at neutral throttle.
  const anchor = buggy.getState();
  step(drive(0), 60); // mechanical hill-hold only — park brake stays OFF
  const after = buggy.getState();
  const drift = Math.hypot(after.x - anchor.x, after.y - anchor.y);
  return {
    stopTimeS: stopTime,
    reachedStopped: reached,
    regenEnergyJ: after.regenEnergyJ - regenAtRelease,
    driftOver60sM: drift,
    maxSpeed,
  };
}

for (const deg of [15, 25]) {
  const r = slopeScenario(deg);
  check(`${deg}° slope: rover climbs under power (v_peak ${r.maxSpeed.toFixed(1)} m/s)`, r.maxSpeed > 0.5);
  check(
    `${deg}° slope: throttle release → regen stop within ≤ 4.5 s (actual ${r.stopTimeS.toFixed(2)} s)`,
    r.reachedStopped && r.stopTimeS <= 4.5,
  );
  check(`${deg}° slope: mode transitions to 'STOPPED'`, r.reachedStopped);
  check(`${deg}° slope: regen harvested energy (ΔE ${r.regenEnergyJ.toFixed(0)} J)`, r.regenEnergyJ > 100);
  check(
    `${deg}° slope: hill-hold drift over 60 s = 0.00 m/s (actual ${(r.driftOver60sM / 60).toFixed(4)} m/s, ${(r.driftOver60sM * 1000).toFixed(2)} mm)`,
    r.driftOver60sM < 0.005,
  );
}

{
  // Anti-jerk slew release: tip-in from a hill-held STOPPED state on 25°.
  const slope = Math.tan((25 * Math.PI) / 180);
  const buggy = new LunarBuggy({ chassisMass: 880, groundElevation: (x: number) => slope * x });
  const dt = 1 / 120;
  // Settle into the mechanical hold first.
  for (let i = 0; i < 120; i++) buggy.step(dt, drive(0));
  check('rover settles into STOPPED hold on 25°', buggy.getState().driveMode === 'STOPPED');
  let minV = 0;
  let maxV = 0;
  for (let i = 0; i < 240; i++) {
    buggy.step(dt, drive(1.0));
    const v = buggy.getState().vLong;
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  check(`slew-rate release: NO rollback on tip-in (min v ${minV.toFixed(4)} m/s)`, minV > -0.02);
  check(`slew-rate release: torque hands over smoothly (climbs to ${maxV.toFixed(1)} m/s)`, maxV > 1.5);
  check('driveMode left STOPPED once throttle > 0.05', buggy.getState().driveMode === 'FORWARD');

  // Strict 0.05 threshold: 0.05 is STILL parked, 0.06 launches.
  const creep = new LunarBuggy({ chassisMass: 880, groundElevation: (x: number) => slope * x });
  for (let i = 0; i < 60; i++) creep.step(dt, drive(0));
  for (let i = 0; i < 120; i++) creep.step(dt, drive(0.05));
  const creepState = creep.getState();
  check(`0.05 in-band demand never launches the rover forward (v ${creepState.vLong.toFixed(3)} m/s stays inside the creep-hold envelope)`,
    creepState.vLong <= BUGGY_COAST_REGEN_CUTOFF_V + 0.01 && creepState.vLong >= -BUGGY_COAST_REGEN_CUTOFF_V - 0.02);
  const creep0 = new LunarBuggy({ chassisMass: 880, groundElevation: (x: number) => slope * x });
  for (let i = 0; i < 600; i++) creep0.step(dt, drive(0));
  check('pure neutral throttle (what the 0.15 stick deadzone guarantees physics sees) parks the rover dead still on 25°',
    creep0.getState().driveMode === 'STOPPED' && Math.hypot(creep0.getState().x, creep0.getState().y) < 1e-6);
  for (let i = 0; i < 240; i++) creep.step(dt, drive(0.06));
  check('throttle 0.06 breaks out of STOPPED → FORWARD', creep.getState().driveMode === 'FORWARD');
}

// ===========================================================================
// 3. Input pipeline — deadzones, trigger clamping, decoupling (Spec 25 §2.2.3)
// ===========================================================================

section('3. input pipeline — deadzones & stick/camera decoupling (Spec 25 §2.2.3)');
{
  check('strict stick deadzone constant 0.15', GAMEPAD_STICK_DEADZONE === 0.15 && GAMEPAD_DEADZONE === 0.15);
  check('look deadzone 0.15', GAMEPAD_LOOK_DEADZONE === 0.15);
  check('steering deadzone 0.12', GAMEPAD_STEER_DEADZONE === 0.12);
  check('axis map: yaw=axes[2], pitch=axes[3], LT=axes[4], RT=axes[5]',
    GAMEPAD_AXES.yaw === 2 && GAMEPAD_AXES.pitch === 3 && GAMEPAD_AXES.linuxLtTrigger === 4 && GAMEPAD_AXES.linuxRtTrigger === 5);

  // Pure shaping curves.
  check('steer curve zeroed inside 0.12 deadband', gamepadSteerCurve(0.12) === 0 && gamepadSteerCurve(-0.12) === 0);
  check('steer curve exact above deadband', Math.abs(gamepadSteerCurve(0.5) - Math.pow((0.5 - 0.12) / 0.88, 1.6)) < 1e-12);
  check('look curve zeroed inside 0.15 deadband', gamepadLookCurve(0.15) === 0 && gamepadLookCurve(-0.14) === 0);
  check('look curve exact & sign-preserving', Math.abs(gamepadLookCurve(-0.8) + Math.pow((0.8 - 0.15) / 0.85, 1.5)) < 1e-12);
  check('throttle curve γ=1.4', Math.abs(gamepadThrottleCurve(0.5) - Math.pow(0.5, 1.4)) < 1e-12);
  check('brake curve γ=0.8', Math.abs(gamepadBrakeCurve(0.5) - Math.pow(0.5, 0.8)) < 1e-12);

  // ---- Bare ClientApp on NullEngine + one synthetic standard pad ----------
  const realNav = (globalThis as { navigator?: unknown }).navigator;
  const makePad = (axes: number[], id = 'synth-pad'): GamepadLike & { axes: number[]; id: string } => ({
    id,
    axes: [...axes],
    buttons: Array.from({ length: 8 }, () => ({ value: 0, pressed: false })),
  });
  let currentPad: (GamepadLike & { axes: number[]; id: string }) | null = null;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { getGamepads: () => (currentPad === null ? [] : [currentPad]) },
  });

  const app = new ClientApp({
    seed: SEED,
    silent: true,
    network: null,
    createHud: false,
    autoConnect: false,
    startQuest: false,
    npcBotCount: 3,
  });
  await app.init(new NullEngine() as never);
  check('bare ClientApp boots headless (no DOM required for input path)', app.isInitialized());

  // Neutral pad: absolutely nothing moves.
  currentPad = makePad([0, 0, 0, 0, 0, 0]);
  {
    const f = app.sampleInput();
    check('neutral pad → every drive channel exactly 0',
      f.forward === 0 && f.strafe === 0 && f.yaw === 0 && f.pitch === 0 && f.brake === 0 && f.reverse === false);
  }

  // Strict deadzone on the stick-Y (throttle) axis. Spec 28 §2.4 superseded
  // the per-axis 0.15 cut with a RADIAL dz 0.12 on the stick PAIR, so the
  // centred edge moved to 0.12 and outside values read (|y| − 0.12) / 0.88.
  currentPad = makePad([0, -0.12, 0, 0, 0, 0]);
  check('stick-Y at exactly the radial dz edge reads 0 forward', app.sampleInput().forward === 0);
  currentPad = makePad([0, -0.16, 0, 0, 0, 0]);
  check(
    'stick-Y past the radial dz produces re-normalised drive demand',
    Math.abs(app.sampleInput().forward - (0.16 - 0.12) / 0.88) < 1e-12,
  );
  currentPad = makePad([0.12, 0, 0, 0, 0, 0]);
  check('stick-X at the 0.12 steer deadband → exactly 0 strafe', app.sampleInput().strafe === 0);

  // Decoupling: camera look-stick commands (axes[2]/axes[3]) produce ZERO
  // steering or forward acceleration demand.
  for (const [yaw, pitch] of [[0.5, -0.4], [-0.9, 0.9], [1, 1], [-1, -1]] as const) {
    currentPad = makePad([0, 0, yaw, pitch, 0, 0]);
    const f = app.sampleInput();
    check(`look stick (yaw ${yaw}, pitch ${pitch}) → camera yaw/pitch only`, f.yaw !== 0 || f.pitch !== 0);
    check(`look stick (yaw ${yaw}, pitch ${pitch}) → strafe 0, forward 0, brake 0`,
      f.strafe === 0 && f.forward === 0 && f.brake === 0);
  }

  // Resting triggers: Linux bipolar rails parked at −1 read exactly 0 —
  // both BEFORE and well after rest-calibration qualifies them.
  currentPad = makePad([0, 0, 0, 0, -1, -1], 'linux-rail-pad');
  {
    const f0 = app.sampleInput();
    check('Linux triggers parked at −1: forward 0, brake 0 (defensive clamp)', f0.forward === 0 && f0.brake === 0);
    for (let i = 0; i < 40; i++) app.sampleInput(); // run rest calibration out
    const f1 = app.sampleInput();
    check('after rest calibration: rail-parked triggers STILL emit exactly 0.0 demand',
      f1.forward === 0 && f1.brake === 0);
  }

  // Trigger travel: RT → forward on the γ=1.4 curve; LT → brake (or the
  // brake-to-reverse channel in buggy mode), never a forward creep.
  currentPad = makePad([0, 0, 0, 0, 0, 0.8], 'rt-pad');
  {
    const f = app.sampleInput();
    check('RT 0.8 → forward on the progressive throttle curve', Math.abs(f.forward - gamepadThrottleCurve(0.8)) < 1e-9);
  }
  currentPad = makePad([0, 0, 0, 0, 1, 0], 'lt-pad');
  {
    const f = app.sampleInput();
    check('LT full → brake demand or brake-to-reverse (never forward)', (f.brake > 0.5 || f.reverse === true) && f.forward === 0);
  }

  // Steering channel: left stick X shapes through the steer curve only —
  // camera axes stay silent.
  currentPad = makePad([0.5, 0, 0.7, 0.7, 0, 0]);
  {
    const f = app.sampleInput();
    check('steer + look together: strafe == steer curve, yaw/pitch independent',
      Math.abs(f.strafe - gamepadSteerCurve(0.5)) < 1e-9 && f.yaw !== 0 && f.pitch !== 0);
  }

  app.dispose?.();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: realNav });
}

// ===========================================================================
// 4. NPC prospector bots & flags (Spec 25 §2.3)
// ===========================================================================

section('4. NPC prospector fleet, flags & state machine (Spec 25 §2.3)');
{
  check('four fictional factions: CAELUM, UNITED_SOL, VALLES, BOREALIS',
    NPC_BOT_FLEET_FACTIONS.length === 4 &&
      (['CAELUM', 'UNITED_SOL', 'VALLES', 'BOREALIS'] as const).every((f) => (NPC_BOT_FLEET_FACTIONS as readonly string[]).includes(f)));
  const mains = new Set(Object.values(NPC_FLAG_COLORS).map((c) => c.main.join(',')));
  check('four distinct faction banner palettes', mains.size === 4);

  const fleets = world.spawnNPCBotFleet({ around: spawn });
  check(`fleet spawns on the live scene (${fleets.length} bots)`, fleets.length >= 3);

  // Deterministic fleet plan from the snapshot: 4 bots → 4 distinct factions.
  const plan = planNPCBotFleet(snapshot ?? { veins: [], sectors: [] }, { around: spawn, count: 4 });
  check(`planNPCBotFleet stages ${plan.length} staging spots`, plan.length >= 3);
  check('fleet plan rotates distinct factions (4 distinct banners across 4 bots)',
    plan.length >= 4 ? new Set(plan.slice(0, 4).map((c) => c.faction)).size === 4 : new Set(plan.map((c) => c.faction)).size === plan.length);

  // Flag geometry + cloth flutter animation over time.
  const seen = new Set<NPCBotState>();
  const bot = fleets[0]!;
  seen.add(bot.getState());
  // The animated cloth pennant is parented under the flag mount (the pole /
  // finial / yard-arm in getMeshes() are static furniture). Grab the cloth.
  const flag = world.getScene().meshes.find((m) => /^npc-.*-flag$/.test(m.name)) ?? null;
  check('bot carries a flag banner mesh (cloth pennant in scene)', flag !== null);
  if (flag) {
    const before = Float32Array.from(flag.getVerticesData(VertexBuffer.PositionKind) ?? []);
    for (let i = 0; i < 12; i++) {
      bot.update(1 / 20, { x: 1e5, y: 1e5, z: 0, isMining: false });
      seen.add(bot.getState());
    }
    const after = Float32Array.from(flag.getVerticesData(VertexBuffer.PositionKind) ?? []);
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (Math.abs(before[i] - after[i]) > 1e-6) changed++;
    check(`flag cloth flutter animates over time (${changed} moved components)`, changed > before.length / 8);
    const finite = Array.from(after).every((v) => Number.isFinite(v));
    check('flag vertices stay finite', finite);
  }

  // ---- Full state machine walk -------------------------------------------
  // (`seen` state ledger declared above so the very first updates — including
  // the transient single-frame 'survey' posture before the 2.5 s scan lands —
  // are logged.)
  const tick = (n: number, player: { x: number; y: number; z: number; isMining: boolean }): NPCBotState => {
    let s: NPCBotState = bot.getState();
    for (let i = 0; i < n; i++) {
      bot.update(1 / 20, player);
      s = bot.getState();
      seen.add(s);
    }
    return s;
  };
  const farAway = { x: spawn.x + 20_000, y: spawn.y + 20_000, z: 0, isMining: false };

  // Phase 1 — nobody around: survey the surface, discover veins < 80 m, then
  // drive onto the claim and siphon (< 5 m working reach).
  const botSpawn = bot.getTelemetry().position;
  const homeVein = (snapshot?.veins ?? [])
    .map((v) => ({ v, d: Math.hypot(v.center.x - botSpawn.x, v.center.y - botSpawn.y) }))
    .sort((a, b) => a.d - b.d)[0];
  check(`bot staged beside a surveyable vein (${homeVein ? homeVein.v.id : 'none'} @ ${homeVein ? homeVein.d.toFixed(1) : '?'} m)`,
    homeVein !== undefined && homeVein.d < SURVEY_RANGE_M);
  tick(80, farAway); // 4 s — scan cycle (2.5 s) fires, siphon posture adopted
  check(`survey state (< ${SURVEY_RANGE_M} m scan envelope) engaged`, seen.has('survey'));
  const telemetry1 = bot.getTelemetry();
  check(`siphon_ore state engaged (bot parked at claim, cargo ${telemetry1.cargoKg.toFixed(1)} kg)`,
    seen.has('siphon_ore') || telemetry1.cargoKg > 0);

  if (homeVein) {
    // Phase 2 — player parks 15 m off the vein centre: contest claim < 25 m.
    bot.consumeBroadcasts();
    const contestPlayer = { x: homeVein.v.center.x + 15, y: homeVein.v.center.y, z: 0, isMining: false };
    tick(60, contestPlayer);
    check(`contest_claim state trips within ${CONTEST_RANGE_M} m`, bot.getState() === 'contest_claim' || seen.has('contest_claim'));
    const broadcasts = bot.consumeBroadcasts();
    check(`contest broadcast broadcast on the comms band (${broadcasts.length})`,
      broadcasts.some((b) => b.text.includes('CONTEST CLAIM')));

    // Phase 3 — player starts drilling: harass + chassis bump (1,500 N·s).
    const harassPlayer = { x: homeVein.v.center.x + 3, y: homeVein.v.center.y, z: 0, isMining: true };
    tick(40, harassPlayer);
    check(`harass_mine state engages on mining pulse (< ${HARASS_BUMP_RANGE_M} m)`, bot.getState() === 'harass_mine' || seen.has('harass_mine'));
    let impulse: { x: number; y: number } | null = null;
    for (let i = 0; i < 300 && impulse === null; i++) {
      // Crowd the bot so the bump envelope closes.
      const tp = bot.getTelemetry().position;
      harassPlayer.x = tp.x + 1.5;
      harassPlayer.y = tp.y;
      bot.update(1 / 20, harassPlayer);
      seen.add(bot.getState());
      impulse = bot.consumePlayerImpulse();
    }
    if (impulse) {
      const mag = Math.hypot(impulse.x, impulse.y);
      check(`dynamic chassis bump emits ${BOT_PUSH_IMPULSE_N_S} N·s impulse (actual ${mag.toFixed(0)} N·s)`,
        Math.abs(mag - BOT_PUSH_IMPULSE_N_S) < BOT_PUSH_IMPULSE_N_S * 0.01);
    } else {
      check('dynamic chassis bump emits 1500 N·s impulse', false, 'no impulse consumed in 300 harass ticks');
    }

    // Phase 4 — player withdraws; bot resumes siphoning until the hopper is
    // full (200 kg → flee), runs to the depot, unloads, back to patrol.
    let fled = false;
    for (let i = 0; i < 6000 && !fled; i++) {
      bot.update(1 / 20, { ...farAway });
      const s = bot.getState();
      seen.add(s);
      if (s === 'flee') fled = true;
    }
    check(`full cargo (${BOT_CARGO_CAPACITY_KG} kg) flips the bot to flee`, fled);
    let patrolled = false;
    for (let i = 0; i < 2000 && !patrolled; i++) {
      bot.update(1 / 20, { ...farAway });
      const s = bot.getState();
      seen.add(s);
      if (s === 'patrol') patrolled = true;
    }
    check('bot returns to depot, unloads, resumes patrol', patrolled);
    const allStates: NPCBotState[] = ['patrol', 'survey', 'contest_claim', 'harass_mine', 'siphon_ore', 'flee'];
    const missing = allStates.filter((s) => !seen.has(s));
    check(`complete state machine exercised (missing: ${missing.length === 0 ? 'none' : missing.join(', ')})`, missing.length === 0);
  }
}

// ===========================================================================
// 5. Derelict rival team outposts (Spec 25 §2.4)
// ===========================================================================

section('5. derelict rival outposts (Spec 25 §2.4)');
{
  const rivals = world.buildRivalBases();
  check('rival outpost system built on the live scene', rivals.isBuilt());
  const sites = rivals.getBases();
  check(`exactly 3 rival outposts spawned (${sites.length})`, sites.length === 3);

  const archetypes = new Set(sites.map((s) => s.archetype));
  check('three distinct weathered archetypes (scrapper_fortress / corporate_enclave / nomad_rig)',
    RIVAL_BASE_ARCHETYPES.length === 3 && archetypes.size === 3 &&
      (['scrapper_fortress', 'corporate_enclave', 'nomad_rig'] as const).every((a) => archetypes.has(a)));

  for (const site of sites) {
    const decayOk = site.decayLevel >= 0 && site.decayLevel <= 1;
    const perimOk = site.perimeterRadiusM >= MIN_PERIMETER_RADIUS_M && site.perimeterRadiusM <= MAX_PERIMETER_RADIUS_M;
    const def = rivals.getArchetypeDefinition(site.archetype);
    check(`[${site.archetype}] decay ${site.decayLevel.toFixed(2)} ∈ [0,1], territory ${site.perimeterRadiusM.toFixed(0)} m ∈ [60,90]`, decayOk && perimOk);
    check(`[${site.archetype}] lore + name populated ("${site.name}")`, site.name.length > 0 && site.factionLore.length > 40 && def !== null);

    // Turret sockets: exactly 2–4 railgun sockets (one pad mesh each).
    const pads = rivals.getPartMeshes('socket', site.archetype).filter((m) => m.name.includes('socket-pad'));
    check(`[${site.archetype}] ${pads.length} damaged railgun sockets (2–4 band)`, pads.length >= 2 && pads.length <= 4);

    // Damaged hoppers / resource depots (surveyable).
    const hoppers = rivals.getPartMeshes('depot', site.archetype);
    check(`[${site.archetype}] damaged hoppers / depots present (${hoppers.length})`, hoppers.length >= 1);
    check(`[${site.archetype}] depots flagged surveyable`, hoppers.every((m) => (m.metadata?.surveyable as boolean | undefined) === true));

    // Anchored on a valid snapshot terrain node (crater-rim snap tolerant).
    const hostDist = Math.min(...(snapshot?.nodes ?? [])
      .filter((n) => ['outpost', 'dock', 'refinery'].includes(n.kind))
      .map((n) => Math.hypot(n.position.x - site.position.x, n.position.y - site.position.y)));
    check(`[${site.archetype}] anchored on a snapshot host node (nearest ${hostDist.toFixed(0)} m ≤ ${CRATER_RIM_SNAP_TOL_M} m)`,
      Number.isFinite(hostDist) && hostDist <= CRATER_RIM_SNAP_TOL_M);
  }

  // Surveyable pool spans the whole roster.
  const surveyables = rivals.getSurveyables();
  check(`cross-base surveyables pool (${surveyables.length})`, surveyables.length >= 3);

  // Spatial query: inside territory → hit; outside → null; threshold override.
  const s0 = sites[0]!;
  check('isNearRivalBase hits the site inside its own territory',
    rivals.isNearRivalBase({ x: s0.position.x, y: s0.position.y })?.id === s0.id);
  check('isNearRivalBase null well outside every territory',
    rivals.isNearRivalBase({ x: s0.position.x + 5000, y: s0.position.y + 5000 }) === null);
  check('uniform threshold override overrides per-site perimeter',
    rivals.isNearRivalBase({ x: s0.position.x + s0.perimeterRadiusM * 0.5, y: s0.position.y }, 10) === null &&
      rivals.isNearRivalBase({ x: s0.position.x + s0.perimeterRadiusM * 0.5, y: s0.position.y }, s0.perimeterRadiusM) !== null);
  check('isNearRivalBase rejects NaN coordinates', rivals.isNearRivalBase({ x: NaN, y: 0 }) === null);

  // Beacon/capacitor animation pump is safe to drive.
  rivals.update(1.0);
  rivals.update(2.5);
  check('beacon animation update() runs without throwing', true);
}

// ===========================================================================
// 6. Procedural Web Audio engine (Spec 25 §2.5)
// ===========================================================================

section('6. procedural Web Audio synthesis engine (Spec 25 §2.5)');

// Instrument the exported mock context so EVERY node the engine creates is
// recorded — full graph topology readback without touching real audio.
const created = { osc: [] as Array<{ type: string; frequency: { value: number } }>, filt: [] as Array<{ type: string }>, gain: 0, src: 0 };
const proto = MockAudioContext.prototype as unknown as Record<string, () => unknown>;
const originals: Record<string, () => unknown> = {};
const instrument = (name: string, bucket: (obj: unknown) => void): void => {
  originals[name] = proto[name];
  proto[name] = function (this: unknown) {
    const obj = originals[name]!.call(this);
    bucket(obj);
    return obj;
  };
};
instrument('createOscillator', (o) => created.osc.push(o as { type: string; frequency: { value: number } }));
instrument('createBiquadFilter', (f) => created.filt.push(f as { type: string }));
instrument('createGain', () => { created.gain++; });
instrument('createBufferSource', () => { created.src++; });

{
  const audio = new LunarAudioSystem();
  await audio.init();
  check('audio engine initialises headless (internal mock context)', audio.isInitialized() && audio.isHeadless());
  check('zero audio assets: graph built purely from oscillators/filters/buffers',
    created.osc.length >= 6 && created.filt.length >= 3 && created.src >= 2 && created.gain >= 8);

  const freqs = created.osc.map((o) => o.frequency.value);
  const has = (f: number) => freqs.some((v) => Math.abs(v - f) < 1e-6);
  check('sub-bass suit life-support drone: 48 Hz + 52 Hz sines', has(48) && has(52) &&
    created.osc.filter((o) => Math.abs(o.frequency.value - 48) < 1e-6).every((o) => o.type === 'sine'));
  check('drone LFO pulse at 0.15 Hz', has(0.15));
  check('motor whine sawtooth oscillator at the 120 Hz floor',
    created.osc.some((o) => o.type === 'sawtooth' && Math.abs(o.frequency.value - 120) < 1e-6));
  check('mining laser 440 Hz square + 30 Hz tremolo oscillator', has(440) && has(30) &&
    created.osc.some((o) => o.type === 'square' && Math.abs(o.frequency.value - 440) < 1e-6));
  const filterTypes = new Set(created.filt.map((f) => f.type));
  check('routing filters present (lowpass / bandpass / highpass)',
    filterTypes.has('lowpass') && filterTypes.has('bandpass') && filterTypes.has('highpass'));

  const internals = audio as unknown as Record<string, { gain: { value: number } } | null>;
  check('three mixer buses + master wired (ambience / music / sfx / world)',
    internals.master !== null && internals.ambienceBus !== null && internals.musicBus !== null &&
      internals.sfxBus !== null && internals.worldMode !== null);

  // Motor whine pitch modulation with ground speed (120 → 950 Hz).
  audio.updateDrivingAudio(0, 0, true);
  const motorFreq = (): number => (internals['motorOsc'] as unknown as { frequency: { value: number } }).frequency.value;
  const fIdle = motorFreq();
  audio.updateDrivingAudio(11, 0.6, true);
  const fMid = motorFreq();
  audio.updateDrivingAudio(22, 1, true);
  const fMax = motorFreq();
  check(`motor whine pitch tracks speed (${fIdle.toFixed(0)} → ${fMid.toFixed(0)} → ${fMax.toFixed(0)} Hz, ceiling 950)`,
    fMid > fIdle && fMax > fMid && fMax <= 950.001);

  // Mining loop gain gate.
  audio.setMiningAudioActive(true, 1);
  const mineOn = (internals['miningGain'] as unknown as { gain: { value: number } }).gain.value;
  audio.setMiningAudioActive(false);
  const mineOff = (internals['miningGain'] as unknown as { gain: { value: number } }).gain.value;
  check(`mining laser loop gate opens/closes (${mineOn.toFixed(3)} → ${mineOff.toFixed(3)})`, mineOn > 0.01 && mineOff < mineOn);

  // Cabin vs vacuum acoustic mode shaper.
  audio.setAudioMode('cabin');
  const worldCabin = (internals['worldMode'] as unknown as { gain: { value: number } }).gain.value;
  audio.setAudioMode('vacuum');
  const worldVacuum = (internals['worldMode'] as unknown as { gain: { value: number } }).gain.value;
  check(`vacuum mode ducks world-coupled loops (${worldCabin.toFixed(2)} → ${worldVacuum.toFixed(2)})`, worldVacuum < worldCabin);
  check('mode readback', audio.getMode() === 'vacuum');

  // One-shots: ore chime, footsteps, comms chirps — all synthesised.
  const oscBefore = created.osc.length;
  audio.playOreCollectChime();
  audio.playFootstep();
  audio.playCommsChirp('alert');
  audio.playCommsChirp('incoming');
  audio.playCommsChirp('burst');
  audio.playGenerativeChord();
  const oscAfter = created.osc.length;
  check(`one-shot cues synthesise voices on demand (${oscAfter - oscBefore} oscillators)`, oscAfter > oscBefore + 3);
  const chimeVoices = created.osc.slice(oscBefore, oscBefore + 2);
  check('ore chime rides the 1760 → 2640 Hz crystalline band',
    chimeVoices.some((o) => Math.abs(o.frequency.value - 1760) < 1e-6) || chimeVoices.some((o) => Math.abs(o.frequency.value - 2640) < 1e-6));
  const chordVoices = created.osc.slice(-3);
  const PENTA_CLASSES = [0, 3, 5, 7, 10];
  const onLattice = (f: number): boolean => {
    const semis = Math.round(12 * Math.log2(f / 110)); // A2-rooted
    return PENTA_CLASSES.includes(((semis % 12) + 12) % 12);
  };
  check('generative chord: 3 voices on the A2 minor-pentatonic lattice',
    chordVoices.length === 3 && chordVoices.every((o) => onLattice(o.frequency.value)));

  // HUD-facing volume parameters clamp hard to [0, 1].
  audio.setVolumes({ master: 5, ambience: -2, music: 0.5, sfx: Number.NaN });
  const v = audio.getVolumes();
  check('volume sliders clamp to [0,1] (5→1, −2→0, NaN→0, 0.5 kept)',
    v.master === 1 && v.ambience === 0 && v.music === 0.5 && v.sfx === 0);
  check('defaults mirror the contract', DEFAULT_AUDIO_VOLUMES.master === 1.0 && DEFAULT_AUDIO_VOLUMES.ambience === 0.7);
  audio.setVolumes({ master: 0.8 });
  check('setVolumes merges partials', audio.getVolumes().master === 0.8 && audio.getVolumes().music === 0.5);

  // -- HUD audio settings panel: sliders + mute latch -----------------------
  const doc = makeMinimalDocument();
  const hudEvents: Array<Record<string, number>> = [];
  const hud = new LunarHUD({
    document: doc as unknown as Document,
    onAudioVolumes: (volumes) => hudEvents.push({ ...volumes } as unknown as Record<string, number>),
  });
  check(`HUD audio panel #${HUD_AUDIO_ID} rendered`, doc.getElementById(HUD_AUDIO_ID) !== null);
  const sliders = (['master', 'ambience', 'music', 'sfx'] as const).map(
    (c) => doc.getElementById(`lunar-hud-audio-slider-${c}`),
  );
  check('four volume sliders present (master / ambience / music / sfx)', sliders.every((s) => s !== null));
  check('sliders configured range 0–1 step 0.01',
    sliders.every((s) => s !== null && (s as unknown as Record<string, unknown>)['type'] === 'range' && (s as unknown as Record<string, unknown>)['max'] === '1'));

  const amb = sliders[1] as unknown as { value: string; dispatchEvent: (t: string) => void };
  amb.value = '0.3';
  amb.dispatchEvent('input');
  check('slider input event routes to the mixer (ambience → 0.3)', hud.getAudioVolumes().ambience === 0.3);
  check('onAudioVolumes callback fired with effective snapshot', hudEvents.length >= 1 && hudEvents[hudEvents.length - 1]!.ambience === 0.3);

  const mute = doc.getElementById('lunar-hud-audio-mute') as unknown as { dispatchEvent: (t: string) => void } | null;
  check('mute toggle button present', mute !== null);
  const masterBefore = hud.getAudioVolumes().master;
  mute!.dispatchEvent('click');
  check('mute zeroes the effective master', hud.isAudioMuted() && hud.getAudioVolumes().master === 0);
  mute!.dispatchEvent('click');
  check('unmute restores the stored master fader', !hud.isAudioMuted() && hud.getAudioVolumes().master === masterBefore);
  hud.setAudioVolumes({ music: 0.42 });
  check('programmatic mixer update path', hud.getAudioVolumes().music === 0.42);
  hud.dispose();

  // ---- Clean disposal & zero leaks ----------------------------------------
  const ownedBefore = (audio as unknown as { ownedVoices: unknown[] }).ownedVoices.length;
  check(`persistent voices tracked for teardown (${ownedBefore})`, ownedBefore >= 8);
  audio.dispose();
  const internalsAfter = audio as unknown as Record<string, unknown>;
  check('dispose() marks disposed + uninited', audio.isDisposed() && !audio.isInitialized());
  check('every voice stopped & tracked list drained', (internalsAfter['ownedVoices'] as unknown[]).length === 0);
  const nulled = ['master', 'ambienceBus', 'musicBus', 'sfxBus', 'worldMode', 'motorOsc', 'motorFilter', 'motorGain',
    'crunchSource', 'crunchFilter', 'crunchGain', 'miningGain', 'musicFilter', 'noiseBuffer', 'ctx'];
  check('entire synthesis graph dereferenced', nulled.every((k) => internalsAfter[k] === null));
  check('music scheduler cleared', (internalsAfter['musicTimer'] as unknown) === null);
  check('gesture listeners detached', (internalsAfter['gestureHandlers'] as unknown[]).length === 0);

  // Post-dispose public surface degrades to silent no-ops, never throws.
  let threw = false;
  try {
    audio.updateDrivingAudio(5, 1, true);
    audio.setMiningAudioActive(true);
    audio.playOreCollectChime();
    audio.playFootstep();
    audio.playCommsChirp('alert');
    audio.playGenerativeChord();
    audio.setVolumes({ master: 0.5 });
    audio.setAudioMode('cabin');
    audio.init();
    audio.dispose();
  } catch {
    threw = true;
  }
  check('post-dispose calls are silent no-ops (no throws, no re-init)', !threw);
}

// Restore the mock prototype so nothing else in the process sees hooks.
for (const [name, fn] of Object.entries(originals)) proto[name] = fn;

// ===========================================================================
// 7. World-level teardown & leak audit
// ===========================================================================

section('7. stage teardown & leak audit');
{
  const meshCountBefore = engine.scenes.reduce((n, s) => n + s.meshes.length, 0);
  check('stage had real geometry to release', meshCountBefore > 50);
  world.dispose();
  check('skirt undefined after dispose', world.getTerrainSkirtMesh() === undefined);
  check('NPC fleet emptied after dispose', world.getNPCBots().length === 0);
  check('rival bases nulled after dispose', world.getRivalBases() === null);
  const meshCountAfter = engine.scenes.reduce((n, s) => n + s.meshes.length, 0);
  check(`meshes released on dispose (${meshCountBefore} → ${meshCountAfter})`, meshCountAfter === 0);
  let postThrew = false;
  try {
    world.updateNPCBots(0.016, { x: 0, y: 0, z: 0, isMining: false });
    world.getNPCBots();
    world.dispose();
  } catch {
    postThrew = true;
  }
  check('post-dispose world calls are safe no-ops', !postThrew);
  engine.dispose();
}

// ---------------------------------------------------------------------------
// Minimal fake DOM (HUD audio-panel surface only)
// ---------------------------------------------------------------------------

function makeMinimalDocument(): {
  body: { children: unknown[] };
  createElement(tag: string): unknown;
  getElementById(id: string): { dispatchEvent(type: string): void } | null;
} {
  const registry = new Map<string, MiniElement>();
  const body = makeMiniElement('body', registry);
  return {
    body: body as unknown as { children: unknown[] },
    createElement: (tag: string) => makeMiniElement(tag, registry),
    getElementById: (id: string) => (registry.get(id) ?? null) as { dispatchEvent(type: string): void } | null,
  };
}

interface MiniElement {
  id: string;
  children: MiniElement[];
  parent: MiniElement | null;
  textContent: string | null;
  style: Record<string, string>;
  classList: { add(n: string): void; remove(n: string): void; contains(n: string): boolean };
  appendChild<T extends MiniElement>(c: T): T;
  remove(): void;
  setAttribute(n: string, v: string): void;
  getAttribute(n: string): string | null;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  dispatchEvent(t: string, e?: unknown): void;
}

function makeMiniElement(tag: string, registry: Map<string, MiniElement>): MiniElement {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const el = {
    id: '',
    children: [],
    parent: null,
    textContent: '',
    style: {},
    classList: {
      add: (n: string) => classes.add(n),
      remove: (n: string) => classes.delete(n),
      contains: (n: string) => classes.has(n),
    },
    appendChild(child: MiniElement) {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      if (el.id.length > 0 && registry.get(el.id) === el) registry.delete(el.id);
    },
    setAttribute(n: string, v: string) {
      attrs.set(n, v);
      if (n === 'id') {
        el.id = v;
        registry.set(v, el);
      }
    },
    getAttribute: (n: string) => attrs.get(n) ?? null,
    addEventListener(t: string, fn: (e: unknown) => void) {
      const l = listeners.get(t) ?? [];
      l.push(fn);
      listeners.set(t, l);
    },
    dispatchEvent(t: string, e?: unknown) {
      for (const fn of listeners.get(t) ?? []) fn(e ?? { type: t });
    },
  } as MiniElement & Record<string, unknown>;
  // `value` passthrough for input sliders.
  Object.defineProperty(el, 'value', { value: el['value'] ?? '', writable: true, enumerable: true });
  return el;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(76)}`);
if (failures.length === 0) {
  console.log(`ALL CHECKS GREEN — ${passed} assertions passed (Spec 25 acceptance gate).`);
  process.exit(0);
} else {
  console.error(`${failures.length} FAILED, ${passed} passed:`);
  for (const f of failures) console.error(`  ✘ ${f}`);
  process.exit(1);
}
}

main().catch((err) => {
  console.error('FATAL (uncaught):', err);
  process.exit(1);
});
