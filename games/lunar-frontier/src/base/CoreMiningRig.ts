/**
 * Lunar Frontier — Spec 38 Phase 3: Rotary Core Drill Machine & Excavation Minigame.
 *
 * Implements the heavy 3D Rotary Drill Rig positioned at the base of the active
 * depth tier (Spec 38 §2.2 / §3 Phase 3):
 *
 *  - **Counter-Rotating Carbide Drill Heads**: Heavy outer carbide cutter head
 *    rotating clockwise, differential counter-rotating inner core bit rotating
 *    counter-clockwise, driven by high-torque hydraulic motors.
 *  - **Interactive Drilling Loop**: Suited astronaut mounts the drill console,
 *    or docks their upgraded Tier 4 Deep Resonator buggy (`mining_suite_t4_deep_core_resonator`),
 *    initiating high-torque drilling pulses ($T \ge 35,000\text{--}95,000\,\text{N}\cdot\text{m}$).
 *  - **Audio Synthesis**: Low-frequency seismic rumble ($35\text{--}65\,\text{Hz}$),
 *    metallic stone shearing, and pneumatic spoils discharge.
 *  - **Excavation Yields & Mineral Veins**: Generates Basalt Rubble ($kg$) deposited
 *    into {@link SubterraneanExcavator}, and exposes deep mineral veins
 *    (Helium-3, Ilmenite Titanium, Platinum, Volcanic Ice) directly in the
 *    rock walls with procedurally instantiated emissive crystal seam meshes.
 *  - **Grinding & Spoils Particles**: Radial rock grinding dust/sparks and
 *    pneumatic spoils ejector particles (100% NullEngine-safe via fallback nodes).
 *  - **Occlusion Culling**: Rig and exposed vein meshes auto-culled when the
 *    camera is on the lunar surface (cameraZ ≥ −2.0 m).
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';

import {
  MAX_DEPTH_TIER,
  type DepthTierIndex,
  type SubterraneanExcavator,
} from './SubterraneanExcavator.ts';
import {
  CHAMBER_TIER_CONFIGS,
  VISIBILITY_THRESHOLD_Z_M,
  type ChamberTierConfig,
} from './SubterraneanChamberBuilder.ts';
import type { LunarAudioSystem } from '../audio/LunarAudioSystem.ts';

// ---------------------------------------------------------------------------
// Constants & Configuration (Spec 38 §3 Phase 3)
// ---------------------------------------------------------------------------

export const DRILL_RIG_NAME_PREFIX = 'core-mining-rig';

/** Baseline pulse duration in seconds. */
export const DRILL_PULSE_DURATION_S = 1.8;

/** Post-pulse cooldown duration in seconds before next pulse can fire. */
export const DRILL_COOLDOWN_DURATION_S = 0.5;

/** Maximum carriage penetration stroke into bedrock during pulse (m). */
export const DRILL_MAX_PENETRATION_M = 0.42;

/** Baseline drilling torque in Newton-metres. */
export const DRILL_BASE_TORQUE_NM = 38_000;

/** Resonance torque multiplier when docked with Tier 4 Deep Core Resonator buggy. */
export const DEEP_RESONATOR_TORQUE_MULTIPLIER = 2.5;

/** Outer drill head target angular speed (RPM) during active pulse. */
export const DRILL_OUTER_HEAD_MAX_RPM = 280;

/** Inner core bit target angular speed (RPM, counter-rotating) during active pulse. */
export const DRILL_INNER_HEAD_MAX_RPM = -420;

/** Baseline basalt rubble yield per drilling pulse (kg). */
export const DRILL_BASE_RUBBLE_YIELD_KG = 240;

/** Low-frequency seismic rumble frequency bounds in Hz (Spec 38 §3 Phase 3). */
export const SEISMIC_RUMBLE_MIN_HZ = 35;
export const SEISMIC_RUMBLE_MAX_HZ = 65;

/** Kinds of mineral veins exposed in deep bedrock fissures. */
export type MineralVeinKind = 'helium3' | 'titanium' | 'platinum' | 'water_ice';

export interface MineralVeinProfile {
  kind: MineralVeinKind;
  name: string;
  baseAbundance: number;
  purity: number;
  emissiveColor: [number, number, number];
  metallic: number;
  roughness: number;
}

export const MINERAL_VEIN_PROFILES: Readonly<Record<MineralVeinKind, MineralVeinProfile>> = {
  helium3: {
    kind: 'helium3',
    name: 'Primordial Helium-3 Seam',
    baseAbundance: 45,
    purity: 0.94,
    emissiveColor: [0.15, 0.75, 1.0], // Electric cyan
    metallic: 0.2,
    roughness: 0.3,
  },
  titanium: {
    kind: 'titanium',
    name: 'Ilmenite Titanium Bed',
    baseAbundance: 120,
    purity: 0.88,
    emissiveColor: [0.85, 0.65, 0.25], // Golden bronze
    metallic: 0.9,
    roughness: 0.35,
  },
  platinum: {
    kind: 'platinum',
    name: 'Native Platinum Fissure',
    baseAbundance: 30,
    purity: 0.98,
    emissiveColor: [0.92, 0.95, 1.0], // Lustrous silver-white
    metallic: 0.95,
    roughness: 0.15,
  },
  water_ice: {
    kind: 'water_ice',
    name: 'Deep Volcanic Ice Lens',
    baseAbundance: 200,
    purity: 0.91,
    emissiveColor: [0.45, 0.85, 0.98], // Glacial azure
    metallic: 0.1,
    roughness: 0.2,
  },
};

// ---------------------------------------------------------------------------
// State & Result Interfaces
// ---------------------------------------------------------------------------

export type MiningRigState = 'IDLE' | 'MOUNTED' | 'BUGGY_DOCKED' | 'DRILLING_PULSE' | 'COOLDOWN';

export interface DrillHeadPose {
  /** Outer carbide cutter head angle in radians. */
  headingOuterRad: number;
  /** Inner counter-rotating core bit angle in radians. */
  headingInnerRad: number;
  /** Current angular velocity of outer head (rad/s). */
  omegaOuterRadPerS: number;
  /** Current angular velocity of inner bit (rad/s). */
  omegaInnerRadPerS: number;
  /** Vertical bedrock penetration depth in metres (0 = stowed). */
  penetrationM: number;
}

export interface ExposedVein {
  id: string;
  kind: MineralVeinKind;
  name: string;
  abundance: number;
  purity: number;
  tier: DepthTierIndex;
  /** World position on chamber wall {x, y, z}. */
  worldPosition: { x: number; y: number; z: number };
  /** Babylon local position. */
  babylonPosition: Vector3;
  mesh?: Mesh;
}

export interface AudioTriggerEvent {
  type: 'seismic_rumble' | 'stone_shearing' | 'spoils_discharge' | 'pulse';
  timestampMs: number;
  frequencyRangeHz?: [number, number];
  durationS?: number;
}

export interface DrillPulseResult {
  success: boolean;
  reason?: string;
  rigState: MiningRigState;
  basaltRubbleYieldKg: number;
  resonanceMultiplier: number;
  totalMinedKg: number;
  appliedTorqueNm: number;
  pulseDurationS: number;
  exposedVeins: readonly ExposedVein[];
  newVeinExposed?: ExposedVein;
  audioCue: {
    seismicHz: [number, number];
    shearing: boolean;
    pneumaticDischarge: boolean;
  };
}

export interface CoreMiningRigOptions {
  /** Target depth tier to seat the rig (defaults to 1 = living mezzanine at −15m). */
  tier?: DepthTierIndex;
  /** Optional custom position in Babylon local coordinates. */
  position?: Vector3;
  /** Optional attached SubterraneanExcavator state machine. */
  excavator?: SubterraneanExcavator;
  /** Optional attached procedural audio system. */
  audioSystem?: LunarAudioSystem;
}

// ---------------------------------------------------------------------------
// Procedural Materials
// ---------------------------------------------------------------------------

interface MiningRigMaterials {
  chassisSteel: PBRMaterial;
  carbideTeeth: PBRMaterial;
  hydraulicChrome: PBRMaterial;
  safetyHazard: StandardMaterial;
  operatorConsole: StandardMaterial;
  spoilsDuct: PBRMaterial;
}

function buildRigMaterials(scene: Scene): MiningRigMaterials {
  const pbr = (
    name: string,
    albedo: readonly [number, number, number],
    metallic: number,
    roughness: number,
  ): PBRMaterial => {
    const m = new PBRMaterial(`${DRILL_RIG_NAME_PREFIX}-${name}`, scene);
    m.albedoColor = Color3.FromArray(albedo);
    m.metallic = metallic;
    m.roughness = roughness;
    m.environmentIntensity = 0.08;
    return m;
  };

  const hazard = new StandardMaterial(`${DRILL_RIG_NAME_PREFIX}-hazard`, scene);
  hazard.diffuseColor = new Color3(0.95, 0.78, 0.1); // Industrial caution yellow
  hazard.emissiveColor = new Color3(0.18, 0.14, 0.02);

  const consoleMat = new StandardMaterial(`${DRILL_RIG_NAME_PREFIX}-console`, scene);
  consoleMat.diffuseColor = new Color3(0.1, 0.15, 0.2);
  consoleMat.emissiveColor = new Color3(0.12, 0.45, 0.65); // Holographic terminal glow

  return {
    chassisSteel: pbr('chassis-steel', [0.28, 0.3, 0.32], 0.85, 0.45),
    carbideTeeth: pbr('carbide-teeth', [0.12, 0.13, 0.14], 0.95, 0.2),
    hydraulicChrome: pbr('hydraulic-chrome', [0.82, 0.84, 0.88], 0.98, 0.1),
    safetyHazard: hazard,
    operatorConsole: consoleMat,
    spoilsDuct: pbr('spoils-duct', [0.35, 0.32, 0.28], 0.7, 0.6),
  };
}

// ---------------------------------------------------------------------------
// CoreMiningRig Class
// ---------------------------------------------------------------------------

export class CoreMiningRig {
  private readonly scene: Scene;
  private tier: DepthTierIndex;
  private excavator: SubterraneanExcavator | null = null;
  private audioSystem: LunarAudioSystem | null = null;

  // Scene Graph Hierarchy
  private root: TransformNode | null = null;
  private mastNode: TransformNode | null = null;
  private carriageNode: TransformNode | null = null;
  private headOuterNode: TransformNode | null = null;
  private headInnerNode: TransformNode | null = null;
  private consoleNode: TransformNode | null = null;
  private dockingBayNode: TransformNode | null = null;
  private spoilsChuteNode: TransformNode | null = null;

  // Grinding particles & dust fallbacks (NullEngine safe)
  private grindingParticlesNode: TransformNode | null = null;
  private spoilsParticlesNode: TransformNode | null = null;

  // Mesh & Material Tracking
  private meshList: Mesh[] = [];
  private materialList: (PBRMaterial | StandardMaterial)[] = [];
  private veinMaterials: Map<MineralVeinKind, PBRMaterial> = new Map();

  // Kinematic & Drilling State
  private state: MiningRigState = 'IDLE';
  private mountedPlayerId: string | null = null;
  private buggyDocked = false;
  private buggyHasDeepResonator = false;

  private headingOuterRad = 0;
  private headingInnerRad = 0;
  private currentRpmOuter = 0;
  private currentRpmInner = 0;
  private currentPenetrationM = 0;

  private pulseRemainingS = 0;
  private cooldownRemainingS = 0;
  private cumulativeMinedRubbleKg = 0;
  private pulseCount = 0;

  // Exposed Veins
  private exposedVeinList: ExposedVein[] = [];

  // Audio Telemetry & Trigger History
  private audioHistory: AudioTriggerEvent[] = [];

  private built = false;
  private disposed = false;

  constructor(scene: Scene, options: CoreMiningRigOptions = {}) {
    if (scene === null || scene === undefined) {
      throw new Error('CoreMiningRig: a Scene is required');
    }
    this.scene = scene;
    this.tier = (options.tier !== undefined ? Math.max(0, Math.min(MAX_DEPTH_TIER, options.tier)) : 1) as DepthTierIndex;
    this.excavator = options.excavator ?? null;
    this.audioSystem = options.audioSystem ?? null;
  }

  // -- lifecycle --------------------------------------------------------------

  /**
   * Build the 3D Rotary Drill Rig assembly and seat it at the floor of `tier`.
   * NullEngine-safe with zero DOM or GLB dependencies. Idempotent.
   */
  build(tier?: DepthTierIndex): this {
    if (this.disposed) throw new Error('CoreMiningRig: build() after dispose()');
    if (this.built) return this;

    if (tier !== undefined) {
      this.tier = Math.max(0, Math.min(MAX_DEPTH_TIER, tier)) as DepthTierIndex;
    }

    const tierCfg: ChamberTierConfig = CHAMBER_TIER_CONFIGS[this.tier] ?? CHAMBER_TIER_CONFIGS[1];
    const floorY = tierCfg.floorY;

    this.root = new TransformNode(`${DRILL_RIG_NAME_PREFIX}-root`, this.scene);
    this.root.position.set(0, floorY, 0);

    const mats = buildRigMaterials(this.scene);
    for (const m of Object.values(mats)) {
      this.materialList.push(m);
    }

    this.buildBaseAndOutriggers(mats);
    this.buildVerticalMast(mats);
    this.buildDrillCarriageAndHeads(mats);
    this.buildOperatorConsole(mats);
    this.buildBuggyDock(mats);
    this.buildSpoilsSystem(mats);
    this.buildParticleEmitters();

    this.built = true;
    return this;
  }

  /**
   * Occlusion culling: hide rig and exposed vein meshes when camera is on the
   * lunar surface (cameraZ >= -2.0m).
   */
  updateVisibility(cameraZ: number): void {
    if (!this.built || this.disposed) return;
    const underground = Number.isFinite(cameraZ) && cameraZ < VISIBILITY_THRESHOLD_Z_M;
    for (const mesh of this.meshList) {
      mesh.isVisible = underground;
    }
  }

  /** Tear down every mesh, material, particle emitter, and node. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const mesh of this.meshList) {
      try {
        mesh.dispose();
      } catch {
        /* already disposed */
      }
    }
    this.meshList = [];

    for (const mat of this.materialList) {
      try {
        mat.dispose();
      } catch {
        /* already disposed */
      }
    }
    this.materialList = [];

    for (const mat of this.veinMaterials.values()) {
      try {
        mat.dispose();
      } catch {
        /* already disposed */
      }
    }
    this.veinMaterials.clear();

    try {
      this.root?.dispose(false, true);
    } catch {
      /* already disposed */
    }

    this.root = null;
    this.mastNode = null;
    this.carriageNode = null;
    this.headOuterNode = null;
    this.headInnerNode = null;
    this.consoleNode = null;
    this.dockingBayNode = null;
    this.spoilsChuteNode = null;
    this.grindingParticlesNode = null;
    this.spoilsParticlesNode = null;

    this.built = false;
  }

  // -- procedural mesh assembly -----------------------------------------------

  private registerPart(
    name: string,
    partId: string,
    mesh: Mesh,
    mat: PBRMaterial | StandardMaterial,
    pos: Vector3,
    parent: TransformNode,
  ): Mesh {
    mesh.material = mat;
    mesh.position.copyFrom(pos);
    mesh.parent = parent;
    mesh.metadata = { part: partId, rig: DRILL_RIG_NAME_PREFIX, tier: this.tier };
    this.meshList.push(mesh);
    return mesh;
  }

  private buildBaseAndOutriggers(mats: MiningRigMaterials): void {
    const root = this.root as TransformNode;

    // Heavy octagonal base collar plate anchored to bedrock
    const baseCollar = MeshBuilder.CreateCylinder(
      `${DRILL_RIG_NAME_PREFIX}-base-collar`,
      { diameter: 4.8, height: 0.35, tessellation: 8 },
      this.scene,
    );
    this.registerPart('base-collar', 'base-collar', baseCollar, mats.chassisSteel, new Vector3(0, 0.175, 0), root);

    // 4 heavy hydraulic stabilizer outriggers
    const outriggerRadius = 2.4;
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 2 + Math.PI / 4;
      const ox = Math.cos(angle) * outriggerRadius;
      const oz = Math.sin(angle) * outriggerRadius;

      const foot = MeshBuilder.CreateBox(
        `${DRILL_RIG_NAME_PREFIX}-outrigger-foot-${i}`,
        { width: 0.8, depth: 0.8, height: 0.25 },
        this.scene,
      );
      this.registerPart(`outrigger-foot-${i}`, 'outrigger', foot, mats.safetyHazard, new Vector3(ox, 0.125, oz), root);

      const strut = MeshBuilder.CreateCylinder(
        `${DRILL_RIG_NAME_PREFIX}-outrigger-strut-${i}`,
        { diameter: 0.24, height: 1.4 },
        this.scene,
      );
      strut.rotation.z = Math.PI / 6 * (Math.cos(angle) > 0 ? -1 : 1);
      strut.rotation.x = Math.PI / 6 * (Math.sin(angle) > 0 ? 1 : -1);
      this.registerPart(`outrigger-strut-${i}`, 'outrigger-strut', strut, mats.hydraulicChrome, new Vector3(ox * 0.65, 0.7, oz * 0.65), root);
    }
  }

  private buildVerticalMast(mats: MiningRigMaterials): void {
    const root = this.root as TransformNode;
    this.mastNode = new TransformNode(`${DRILL_RIG_NAME_PREFIX}-mast-node`, this.scene);
    this.mastNode.parent = root;

    // Twin structural mast pillars
    const mastHeight = 5.2;
    const mastSpacing = 1.6;
    for (const sx of [-mastSpacing / 2, mastSpacing / 2]) {
      const pillar = MeshBuilder.CreateBox(
        `${DRILL_RIG_NAME_PREFIX}-mast-pillar-${sx > 0 ? 'right' : 'left'}`,
        { width: 0.35, depth: 0.35, height: mastHeight },
        this.scene,
      );
      this.registerPart(`mast-pillar-${sx > 0 ? 'right' : 'left'}`, 'mast-pillar', pillar, mats.chassisSteel, new Vector3(sx, mastHeight / 2, 0), this.mastNode);
    }

    // Gantry top crown header with hydraulic spool housing
    const header = MeshBuilder.CreateBox(
      `${DRILL_RIG_NAME_PREFIX}-mast-header`,
      { width: mastSpacing + 0.6, depth: 0.9, height: 0.45 },
      this.scene,
    );
    this.registerPart('mast-header', 'mast-header', header, mats.safetyHazard, new Vector3(0, mastHeight, 0), this.mastNode);

    // Twin hydraulic feed rams
    for (const sx of [-mastSpacing / 3, mastSpacing / 3]) {
      const ram = MeshBuilder.CreateCylinder(
        `${DRILL_RIG_NAME_PREFIX}-feed-ram-${sx > 0 ? 'right' : 'left'}`,
        { diameter: 0.16, height: mastHeight - 0.6 },
        this.scene,
      );
      this.registerPart(`feed-ram-${sx > 0 ? 'right' : 'left'}`, 'feed-ram', ram, mats.hydraulicChrome, new Vector3(sx, mastHeight / 2, 0), this.mastNode);
    }
  }

  private buildDrillCarriageAndHeads(mats: MiningRigMaterials): void {
    const root = this.root as TransformNode;

    // Vertical drive carriage (translates down during drilling pulse)
    this.carriageNode = new TransformNode(`${DRILL_RIG_NAME_PREFIX}-carriage`, this.scene);
    this.carriageNode.position.set(0, 2.4, 0); // Stowed height above floor
    this.carriageNode.parent = root;

    const carriageBox = MeshBuilder.CreateBox(
      `${DRILL_RIG_NAME_PREFIX}-carriage-block`,
      { width: 1.4, depth: 1.2, height: 0.6 },
      this.scene,
    );
    this.registerPart('carriage-block', 'carriage', carriageBox, mats.chassisSteel, new Vector3(0, 0, 0), this.carriageNode);

    // Hydraulic rotary motor housings on top of carriage
    const motorHousing = MeshBuilder.CreateCylinder(
      `${DRILL_RIG_NAME_PREFIX}-rotary-motor`,
      { diameter: 0.7, height: 0.5 },
      this.scene,
    );
    this.registerPart('rotary-motor', 'motor', motorHousing, mats.chassisSteel, new Vector3(0, 0.45, 0), this.carriageNode);

    // Outer Carbide Cutter Head (CW rotation)
    this.headOuterNode = new TransformNode(`${DRILL_RIG_NAME_PREFIX}-head-outer`, this.scene);
    this.headOuterNode.position.set(0, -0.4, 0);
    this.headOuterNode.parent = this.carriageNode;

    const outerRing = MeshBuilder.CreateCylinder(
      `${DRILL_RIG_NAME_PREFIX}-outer-cutter-ring`,
      { diameter: 1.8, height: 0.45, tessellation: 12 },
      this.scene,
    );
    this.registerPart('outer-ring', 'head-outer', outerRing, mats.chassisSteel, new Vector3(0, 0, 0), this.headOuterNode);

    // 8 carbide cutter teeth around outer circumference
    const teethCount = 8;
    for (let t = 0; t < teethCount; t++) {
      const theta = (t * 2 * Math.PI) / teethCount;
      const tx = Math.cos(theta) * 0.88;
      const tz = Math.sin(theta) * 0.88;
      const tooth = MeshBuilder.CreateBox(
        `${DRILL_RIG_NAME_PREFIX}-outer-tooth-${t}`,
        { width: 0.12, depth: 0.12, height: 0.2 },
        this.scene,
      );
      this.registerPart(`outer-tooth-${t}`, 'carbide-tooth', tooth, mats.carbideTeeth, new Vector3(tx, -0.25, tz), this.headOuterNode);
    }

    // Inner Counter-Rotating Core Bit (CCW rotation)
    this.headInnerNode = new TransformNode(`${DRILL_RIG_NAME_PREFIX}-head-inner`, this.scene);
    this.headInnerNode.position.set(0, -0.6, 0);
    this.headInnerNode.parent = this.carriageNode;

    const innerCoreBit = MeshBuilder.CreateCylinder(
      `${DRILL_RIG_NAME_PREFIX}-inner-core-bit`,
      { diameterTop: 0.8, diameterBottom: 0.25, height: 0.75, tessellation: 10 },
      this.scene,
    );
    this.registerPart('inner-bit', 'head-inner', innerCoreBit, mats.chassisSteel, new Vector3(0, 0, 0), this.headInnerNode);

    // 4 central carbide coring teeth
    for (let c = 0; c < 4; c++) {
      const cTheta = (c * 2 * Math.PI) / 4;
      const cx = Math.cos(cTheta) * 0.28;
      const cz = Math.sin(cTheta) * 0.28;
      const cTooth = MeshBuilder.CreateBox(
        `${DRILL_RIG_NAME_PREFIX}-inner-tooth-${c}`,
        { width: 0.09, depth: 0.09, height: 0.18 },
        this.scene,
      );
      this.registerPart(`inner-tooth-${c}`, 'carbide-tooth', cTooth, mats.carbideTeeth, new Vector3(cx, -0.4, cz), this.headInnerNode);
    }
  }

  private buildOperatorConsole(mats: MiningRigMaterials): void {
    const root = this.root as TransformNode;
    this.consoleNode = new TransformNode(`${DRILL_RIG_NAME_PREFIX}-console-node`, this.scene);
    this.consoleNode.position.set(0, 0, 2.2); // Positioned forward on user platform
    this.consoleNode.parent = root;

    // Platform grating for player stand
    const platform = MeshBuilder.CreateBox(
      `${DRILL_RIG_NAME_PREFIX}-operator-platform`,
      { width: 1.8, depth: 1.6, height: 0.15 },
      this.scene,
    );
    this.registerPart('operator-platform', 'console-platform', platform, mats.chassisSteel, new Vector3(0, 0.075, 0), this.consoleNode);

    // Console stand and tilted holographic display terminal
    const stand = MeshBuilder.CreateBox(
      `${DRILL_RIG_NAME_PREFIX}-console-stand`,
      { width: 0.6, depth: 0.35, height: 1.1 },
      this.scene,
    );
    this.registerPart('console-stand', 'console-stand', stand, mats.chassisSteel, new Vector3(0, 0.65, 0.6), this.consoleNode);

    const terminalScreen = MeshBuilder.CreateBox(
      `${DRILL_RIG_NAME_PREFIX}-terminal-screen`,
      { width: 0.7, depth: 0.45, height: 0.06 },
      this.scene,
    );
    terminalScreen.rotation.x = -Math.PI / 6;
    this.registerPart('terminal-screen', 'console-screen', terminalScreen, mats.operatorConsole, new Vector3(0, 1.25, 0.55), this.consoleNode);
  }

  private buildBuggyDock(mats: MiningRigMaterials): void {
    const root = this.root as TransformNode;
    this.dockingBayNode = new TransformNode(`${DRILL_RIG_NAME_PREFIX}-docking-bay`, this.scene);
    this.dockingBayNode.position.set(0, 0, -2.4); // Aft docking slip
    this.dockingBayNode.parent = root;

    // Twin vehicle guide rails
    for (const rx of [-1.1, 1.1]) {
      const rail = MeshBuilder.CreateBox(
        `${DRILL_RIG_NAME_PREFIX}-dock-rail-${rx > 0 ? 'right' : 'left'}`,
        { width: 0.22, depth: 2.8, height: 0.18 },
        this.scene,
      );
      this.registerPart(`dock-rail-${rx > 0 ? 'right' : 'left'}`, 'dock-rail', rail, mats.safetyHazard, new Vector3(rx, 0.09, 0), this.dockingBayNode);
    }

    // Heavy magnetic docking clamp collar
    const clamp = MeshBuilder.CreateBox(
      `${DRILL_RIG_NAME_PREFIX}-dock-clamp`,
      { width: 1.4, depth: 0.35, height: 0.4 },
      this.scene,
    );
    this.registerPart('dock-clamp', 'dock-clamp', clamp, mats.chassisSteel, new Vector3(0, 0.25, 1.1), this.dockingBayNode);
  }

  private buildSpoilsSystem(mats: MiningRigMaterials): void {
    const root = this.root as TransformNode;
    this.spoilsChuteNode = new TransformNode(`${DRILL_RIG_NAME_PREFIX}-spoils-system`, this.scene);
    this.spoilsChuteNode.parent = root;

    // Angled spoils discharge chute
    const chute = MeshBuilder.CreateCylinder(
      `${DRILL_RIG_NAME_PREFIX}-spoils-chute`,
      { diameter: 0.38, height: 2.2 },
      this.scene,
    );
    chute.rotation.z = Math.PI / 4;
    this.registerPart('spoils-chute', 'spoils-chute', chute, mats.spoilsDuct, new Vector3(1.4, 1.5, 0), this.spoilsChuteNode);

    // Pneumatic pressure relief valve collar
    const valve = MeshBuilder.CreateCylinder(
      `${DRILL_RIG_NAME_PREFIX}-spoils-valve`,
      { diameter: 0.48, height: 0.3 },
      this.scene,
    );
    this.registerPart('spoils-valve', 'spoils-valve', valve, mats.safetyHazard, new Vector3(0.7, 1.8, 0), this.spoilsChuteNode);
  }

  private buildParticleEmitters(): void {
    const isNull = this.scene.getEngine().name === 'NullEngine';
    // Fallback nodes for NullEngine assertion handles
    this.grindingParticlesNode = new TransformNode(`${DRILL_RIG_NAME_PREFIX}-grinding-dust-fallback`, this.scene);
    this.grindingParticlesNode.parent = this.headOuterNode ?? this.root;

    this.spoilsParticlesNode = new TransformNode(`${DRILL_RIG_NAME_PREFIX}-spoils-dust-fallback`, this.scene);
    this.spoilsParticlesNode.parent = this.spoilsChuteNode ?? this.root;

    if (!isNull) {
      // In WebGL environments, particles can be bound to these anchor nodes
    }
  }

  // -- interactive drilling loop & state machine -------------------------------

  /** Current operational state. */
  getState(): MiningRigState {
    return this.state;
  }

  /** Current tier where the rig is stationed. */
  getTier(): DepthTierIndex {
    return this.tier;
  }

  /** Mount the suited player to the drill operator console. */
  mountPlayer(playerId = 'player-local'): boolean {
    if (this.disposed || !this.built) return false;
    if (this.state === 'DRILLING_PULSE') return false;

    this.mountedPlayerId = playerId;
    if (this.state !== 'BUGGY_DOCKED') {
      this.state = 'MOUNTED';
    }
    return true;
  }

  /** Dismount player from console. */
  dismountPlayer(): void {
    this.mountedPlayerId = null;
    if (this.state === 'MOUNTED') {
      this.state = 'IDLE';
    }
  }

  /** True when a suited player is currently at the controls. */
  isMounted(): boolean {
    return this.mountedPlayerId !== null;
  }

  /**
   * Dock a buggy into the guide rail clamp.
   * If `hasDeepResonator` is true (Tier 4 Buggy upgrade), high-torque seismic
   * pulses receive a 2.5x resonance multiplier.
   */
  dockBuggy(options: { hasDeepResonator?: boolean } | boolean = false): boolean {
    if (this.disposed || !this.built) return false;
    if (this.state === 'DRILLING_PULSE') return false;

    const hasResonator = typeof options === 'boolean' ? options : (options.hasDeepResonator ?? false);
    this.buggyDocked = true;
    this.buggyHasDeepResonator = hasResonator;
    this.state = 'BUGGY_DOCKED';
    return true;
  }

  /** Undock buggy from the clamp. */
  undockBuggy(): void {
    this.buggyDocked = false;
    this.buggyHasDeepResonator = false;
    this.state = this.mountedPlayerId !== null ? 'MOUNTED' : 'IDLE';
  }

  /** True when a buggy is locked into the dock. */
  isBuggyDocked(): boolean {
    return this.buggyDocked;
  }

  /** True when the docked buggy features the Tier 4 Deep Core Resonator. */
  hasDeepResonator(): boolean {
    return this.buggyDocked && this.buggyHasDeepResonator;
  }

  /**
   * Initiate a high-torque drilling pulse.
   *
   * Drives counter-rotating carbide drill heads into the bedrock floor, emits
   * grinding particles, discharges pneumatic spoils, synthesizes seismic rumble
   * (35--65 Hz) & stone shearing, adds Basalt Rubble yield to the excavator,
   * and potentially exposes rich mineral veins in the chamber rock walls.
   */
  triggerDrillPulse(): DrillPulseResult {
    if (this.disposed || !this.built) {
      return this.failureResult('Rig disposed or not built');
    }
    if (this.state === 'DRILLING_PULSE') {
      return this.failureResult('Drilling pulse already in progress');
    }
    if (this.cooldownRemainingS > 0) {
      return this.failureResult('Rig in hydraulic thermal cooldown');
    }

    // Determine torque and resonance multiplier
    const hasResonator = this.hasDeepResonator();
    const resonanceMultiplier = hasResonator ? DEEP_RESONATOR_TORQUE_MULTIPLIER : 1.0;
    const appliedTorqueNm = DRILL_BASE_TORQUE_NM * resonanceMultiplier;

    // Transition to DRILLING_PULSE
    this.state = 'DRILLING_PULSE';
    this.pulseRemainingS = DRILL_PULSE_DURATION_S;
    this.pulseCount += 1;

    // Spin up counter-rotating heads
    this.currentRpmOuter = DRILL_OUTER_HEAD_MAX_RPM * (hasResonator ? 1.3 : 1.0);
    this.currentRpmInner = DRILL_INNER_HEAD_MAX_RPM * (hasResonator ? 1.3 : 1.0);

    // Compute Basalt Rubble yield
    const rawYield = DRILL_BASE_RUBBLE_YIELD_KG + (this.pulseCount % 5) * 20;
    const basaltRubbleYieldKg = Math.round(rawYield * resonanceMultiplier);
    this.cumulativeMinedRubbleKg += basaltRubbleYieldKg;

    // If attached to SubterraneanExcavator, add yield
    if (this.excavator !== null) {
      this.excavator.addBasaltRubble(basaltRubbleYieldKg);
    }

    // Mineral Vein Exposure:
    // With Deep Resonator or on every 2nd pulse, expose a deep mineral seam in rock walls
    let newVeinExposed: ExposedVein | undefined;
    const shouldExposeVein = hasResonator || this.pulseCount % 2 === 1;
    if (shouldExposeVein && this.exposedVeinList.length < 8) {
      newVeinExposed = this.exposeMineralVein();
    }

    // Trigger procedural audio synthesis if attached
    this.audioSystem?.playDrillPulse(DRILL_PULSE_DURATION_S);

    // Record Audio Cue Telemetry
    const seismicHz: [number, number] = [SEISMIC_RUMBLE_MIN_HZ, SEISMIC_RUMBLE_MAX_HZ];
    this.recordAudioEvent('seismic_rumble', seismicHz, DRILL_PULSE_DURATION_S);
    this.recordAudioEvent('stone_shearing', undefined, DRILL_PULSE_DURATION_S * 0.8);
    this.recordAudioEvent('spoils_discharge', undefined, 0.4);
    this.recordAudioEvent('pulse', seismicHz, DRILL_PULSE_DURATION_S);

    return {
      success: true,
      rigState: this.state,
      basaltRubbleYieldKg,
      resonanceMultiplier,
      totalMinedKg: this.cumulativeMinedRubbleKg,
      appliedTorqueNm,
      pulseDurationS: DRILL_PULSE_DURATION_S,
      exposedVeins: [...this.exposedVeinList],
      newVeinExposed,
      audioCue: {
        seismicHz,
        shearing: true,
        pneumaticDischarge: true,
      },
    };
  }

  private failureResult(reason: string): DrillPulseResult {
    return {
      success: false,
      reason,
      rigState: this.state,
      basaltRubbleYieldKg: 0,
      resonanceMultiplier: 1.0,
      totalMinedKg: this.cumulativeMinedRubbleKg,
      appliedTorqueNm: 0,
      pulseDurationS: 0,
      exposedVeins: [...this.exposedVeinList],
      audioCue: {
        seismicHz: [SEISMIC_RUMBLE_MIN_HZ, SEISMIC_RUMBLE_MAX_HZ],
        shearing: false,
        pneumaticDischarge: false,
      },
    };
  }

  // -- procedural mineral vein exposure in rock walls -------------------------

  /**
   * Expose a deep mineral seam directly on the surrounding rock walls.
   * Generates procedural crystal cluster geometry with emissive PBR materials.
   */
  private exposeMineralVein(): ExposedVein {
    const tierCfg = CHAMBER_TIER_CONFIGS[this.tier] ?? CHAMBER_TIER_CONFIGS[1];
    const w = tierCfg.widthM;
    const l = tierCfg.lengthM;
    const h = tierCfg.heightM;

    // Pick vein kind based on tier depth
    const kinds: MineralVeinKind[] = ['titanium', 'water_ice', 'helium3', 'platinum'];
    // Deeper tiers favor rarer minerals
    const kindIndex = Math.min(kinds.length - 1, Math.floor(Math.random() * (this.tier + 1)));
    const kind = kinds[kindIndex] ?? 'titanium';
    const profile = MINERAL_VEIN_PROFILES[kind];

    const veinIndex = this.exposedVeinList.length;
    const veinId = `vein-t${this.tier}-${kind}-${veinIndex}`;

    // Place vein on rock walls (x = +/- w/2 or z = +/- l/2)
    const wallSide = veinIndex % 4;
    let localX = 0;
    let localZ = 0;
    const wallOffset = 0.35; // slightly proud of wall surface
    if (wallSide === 0) {
      localX = w / 2 - wallOffset;
      localZ = ((Math.random() - 0.5) * l * 0.7);
    } else if (wallSide === 1) {
      localX = -w / 2 + wallOffset;
      localZ = ((Math.random() - 0.5) * l * 0.7);
    } else if (wallSide === 2) {
      localX = ((Math.random() - 0.5) * w * 0.7);
      localZ = l / 2 - wallOffset;
    } else {
      localX = ((Math.random() - 0.5) * w * 0.7);
      localZ = -l / 2 + wallOffset;
    }
    const localY = 1.2 + Math.random() * (h * 0.55);

    // Get or build vein material
    let mat = this.veinMaterials.get(kind);
    if (mat === undefined) {
      mat = new PBRMaterial(`${DRILL_RIG_NAME_PREFIX}-mat-${kind}`, this.scene);
      mat.albedoColor = Color3.FromArray(profile.emissiveColor);
      mat.emissiveColor = Color3.FromArray(profile.emissiveColor).scale(0.85);
      mat.metallic = profile.metallic;
      mat.roughness = profile.roughness;
      this.veinMaterials.set(kind, mat);
      this.materialList.push(mat);
    }

    // Procedural mineral crystal cluster
    const veinMesh = MeshBuilder.CreateCylinder(
      `${DRILL_RIG_NAME_PREFIX}-${veinId}`,
      { diameterTop: 0.2, diameterBottom: 1.1, height: 1.6, tessellation: 6 },
      this.scene,
    );
    veinMesh.rotation.x = Math.PI / 2;
    if (wallSide === 0) veinMesh.rotation.z = Math.PI / 2;
    else if (wallSide === 1) veinMesh.rotation.z = -Math.PI / 2;
    else if (wallSide === 2) veinMesh.rotation.y = Math.PI;

    const parentNode = this.root ?? this.scene;
    this.registerPart(veinId, 'mineral-vein', veinMesh, mat, new Vector3(localX, localY, localZ), parentNode as TransformNode);

    const vein: ExposedVein = {
      id: veinId,
      kind,
      name: profile.name,
      abundance: profile.baseAbundance * (1 + Math.random() * 0.5),
      purity: profile.purity,
      tier: this.tier,
      worldPosition: {
        x: localX,
        y: localZ,
        z: tierCfg.floorY + localY,
      },
      babylonPosition: new Vector3(localX, tierCfg.floorY + localY, localZ),
      mesh: veinMesh,
    };

    this.exposedVeinList.push(vein);
    return vein;
  }

  // -- frame update & kinematic simulation ------------------------------------

  /**
   * Per-frame kinematic simulation tick:
   * Advances counter-rotating head yaw angles, carriage stroke, pulse timer,
   * and cooldown states. Sub-steps for numerical stability across variable frame rates.
   */
  update(dtS: number): void {
    if (!this.built || this.disposed) return;
    if (!Number.isFinite(dtS) || dtS <= 0) return;
    const totalDt = Math.min(dtS, 10.0);
    const maxSubStep = 0.05;
    let remaining = totalDt;
    while (remaining > 0) {
      const step = Math.min(remaining, maxSubStep);
      this.stepSimulation(step);
      remaining -= step;
    }
  }

  private stepSimulation(safeDt: number): void {
    // Handle drilling pulse state
    if (this.state === 'DRILLING_PULSE') {
      this.pulseRemainingS -= safeDt;

      // Carriage penetration plunge
      const progress = 1 - Math.max(0, this.pulseRemainingS / DRILL_PULSE_DURATION_S);
      // Sinusoidal plunge-and-grind stroke
      this.currentPenetrationM = Math.sin(progress * Math.PI) * DRILL_MAX_PENETRATION_M;

      if (this.pulseRemainingS <= 0) {
        this.pulseRemainingS = 0;
        this.state = 'COOLDOWN';
        this.cooldownRemainingS = DRILL_COOLDOWN_DURATION_S;
      }
    } else if (this.state === 'COOLDOWN') {
      this.cooldownRemainingS -= safeDt;
      // Exponential decay of RPM to stop
      this.currentRpmOuter *= Math.exp(-safeDt * 6);
      this.currentRpmInner *= Math.exp(-safeDt * 6);
      this.currentPenetrationM *= Math.exp(-safeDt * 8);

      if (this.cooldownRemainingS <= 0) {
        this.cooldownRemainingS = 0;
        this.currentRpmOuter = 0;
        this.currentRpmInner = 0;
        this.currentPenetrationM = 0;
        // Return to mounted or docked state
        if (this.buggyDocked) {
          this.state = 'BUGGY_DOCKED';
        } else if (this.mountedPlayerId !== null) {
          this.state = 'MOUNTED';
        } else {
          this.state = 'IDLE';
        }
      }
    } else {
      // Idle / stowed state
      this.currentRpmOuter = 0;
      this.currentRpmInner = 0;
      this.currentPenetrationM = 0;
    }

    // Update kinematic rotations (RPM -> rad/s -> angle)
    const omegaOuter = (this.currentRpmOuter * 2 * Math.PI) / 60;
    const omegaInner = (this.currentRpmInner * 2 * Math.PI) / 60;

    this.headingOuterRad += omegaOuter * safeDt;
    this.headingInnerRad += omegaInner * safeDt;

    // Apply rotations to Babylon nodes
    if (this.headOuterNode !== null) {
      this.headOuterNode.rotation.y = this.headingOuterRad;
    }
    if (this.headInnerNode !== null) {
      this.headInnerNode.rotation.y = this.headingInnerRad;
    }

    // Apply penetration stroke to carriage
    if (this.carriageNode !== null) {
      this.carriageNode.position.y = 2.4 - this.currentPenetrationM;
    }
  }

  // -- accessors & queries ----------------------------------------------------

  /** Attached audio system, or null if unattached. */
  getAudioSystem(): LunarAudioSystem | null {
    return this.audioSystem;
  }

  /** Attach or detach the procedural audio system. */
  setAudioSystem(audio: LunarAudioSystem | null): void {
    this.audioSystem = audio;
  }

  /** Current kinematic pose of the counter-rotating cutter heads. */
  getHeadPose(): DrillHeadPose {
    return {
      headingOuterRad: this.headingOuterRad,
      headingInnerRad: this.headingInnerRad,
      omegaOuterRadPerS: (this.currentRpmOuter * 2 * Math.PI) / 60,
      omegaInnerRadPerS: (this.currentRpmInner * 2 * Math.PI) / 60,
      penetrationM: this.currentPenetrationM,
    };
  }

  /** Cumulative basalt rubble mined by this rig (kg). */
  getTotalMinedKg(): number {
    return this.cumulativeMinedRubbleKg;
  }

  /** Read-only list of mineral veins exposed by drilling pulses. */
  getExposedVeins(): readonly ExposedVein[] {
    return this.exposedVeinList;
  }

  /** Complete list of all meshes created by the rig. */
  getMeshes(): Mesh[] {
    return [...this.meshList];
  }

  /** Filter meshes by metadata part identifier. */
  getPartMeshes(part: string): Mesh[] {
    return this.meshList.filter((m) => (m.metadata?.part as string | undefined) === part);
  }

  /** Root transform node. */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** True once build() has completed and rig is undisposed. */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  // -- audio telemetry & verification hooks -----------------------------------

  private recordAudioEvent(
    type: AudioTriggerEvent['type'],
    frequencyRangeHz?: [number, number],
    durationS?: number,
  ): void {
    this.audioHistory.push({
      type,
      timestampMs: Date.now(),
      frequencyRangeHz,
      durationS,
    });
  }

  /** Query audio trigger events recorded by the rig (smoke assertion readback). */
  getAudioHistory(): readonly AudioTriggerEvent[] {
    return this.audioHistory;
  }

  /** Clear recorded audio telemetry history. */
  clearAudioHistory(): void {
    this.audioHistory = [];
  }
}
