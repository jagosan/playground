/**
 * Lunar Frontier — autonomous NPC prospector bots & fictional faction flags
 * (Spec 25 §2.3 / §3.1).
 *
 * Rival corporate prospectors that patrol the resource sectors, survey surface
 * deposits, contest the player's claims, harass the mining drill (chassis
 * bumps + ore siphoning) and waddle home to the depot when their cargo hopper
 * fills. Every bot is 100% procedural geometry — chassis, four road wheels,
 * front drill arm, antenna mast, rear cargo hopper, and a carbon-composite
 * flagpole flying a dynamically fluttering faction pennant (vertex-wave cloth:
 * amplitude and frequency scale with ground speed and `dt`).
 *
 * Frame convention matches every other entity (CameraRig / TransportLander):
 * physics frame (x, y lateral, z up); heading radians, 0 = +x world, mapping to
 * Babylon `rotation.y = PI/2 + heading` via `worldToBabylon`. Surface adhesion
 * samples `worldGen.elevationAt(x, y)` each frame (lightweight analytic raycast
 * against the generator's crater bowls/rims) and tilts the chassis onto the
 * local surface normal (slope attitude, smoothed).
 *
 * AI state machine (Spec 25 §2.3):
 *   patrol        wander between mineral nodes / waypoints inside `patrolRadiusM`
 *   survey        scan surface deposits within {@link SURVEY_RANGE_M}
 *   contest_claim player entered {@link CONTEST_RANGE_M} of the contested vein →
 *                 plant the flag posture + warning broadcast
 *   harass_mine   player fires the mining laser → bot wedges between player and
 *                 vein, fires its own beam, bumps the player at close range
 *                 ({@link BOT_PUSH_IMPULSE_N_S} per chassis pushback, consumed
 *                 via {@link NPCProspectorBot.consumePlayerImpulse}) and siphons
 *                 loose ore within {@link SIPHON_RANGE_M}
 *   flee          cargo hopper full ({@link BOT_CARGO_CAPACITY_KG}) → run for
 *                 the depot (spawn anchor) and unload
 *
 * Headless-safe: takes an existing `Scene` (a NullEngine scene works — no DOM,
 * no render loop). All meshes parent to a single root TransformNode;
 * `dispose()` is idempotent and never throws; after disposal `update()` is a
 * silent no-op and `getTelemetry()` keeps returning the last snapshot.
 */

import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';

/** Babylon basis constants (frame shared with worldToBabylon). */
const BABYLON_UP = new Vector3(0, 1, 0);
const BABYLON_RIGHT = new Vector3(1, 0, 0);
const BABYLON_FORWARD = new Vector3(0, 0, 1);

import { worldToBabylon } from '../engine/CameraRig.ts';
import type { LunarWorldGenerator, ResourceVein } from '../world/LunarWorldGenerator.ts';

// ---------------------------------------------------------------------------
// Contract types (Spec 25 §2.3 — exact interface surface)
// ---------------------------------------------------------------------------

export type NPCBotFaction = 'CAELUM' | 'UNITED_SOL' | 'VALLES' | 'BOREALIS';

export type NPCBotState =
  | 'patrol'
  | 'survey'
  | 'contest_claim'
  | 'harass_mine'
  | 'siphon_ore'
  | 'flee';

export interface NPCBotConfig {
  id: string;
  faction: NPCBotFaction;
  callsign: string;
  spawnPosition: { x: number; y: number };
  patrolRadiusM: number;
}

export interface NPCBotTelemetry {
  id: string;
  position: { x: number; y: number; z: number };
  heading: number;
  speed: number;
  state: NPCBotState;
  targetVeinId: string | null;
  cargoKg: number;
  flagColor: [number, number, number];
}

// ---------------------------------------------------------------------------
// Behaviour tuning constants (Spec 25 §2.3)
// ---------------------------------------------------------------------------

/** Surface-deposit survey envelope, metres. */
export const SURVEY_RANGE_M = 80;
/** Player proximity that trips a contest claim on the bot's active vein, metres. */
export const CONTEST_RANGE_M = 25;
/** Chassis-bump envelope while harassing the drill, metres. */
export const HARASS_BUMP_RANGE_M = 8;
/** Loose-ore siphon reach, metres. */
export const SIPHON_RANGE_M = 5;
/**
 * Claim working radius, metres: how close to a deposit centre the bot must
 * park to work it. Vein spheres are continent-scale ore bodies, so proximity
 * is measured to the centre, never by sphere containment.
 */
export const CLAIM_WORK_RADIUS_M = 10;
/** Cargo hopper ceiling, kg — full hopper flips the bot into `flee`. */
export const BOT_CARGO_CAPACITY_KG = 200;
/** Impulse imparted to the player per chassis bump, newton-seconds. */
export const BOT_PUSH_IMPULSE_N_S = 1500;
/**
 * Effective stabilised mass used to convert the 1 500 N·s bump into a Δv for
 * the player avatar (1 m/s — a shoving "low-speed bump", not a launch).
 */
export const BOT_PUSH_EFFECTIVE_MASS_KG = 1500;
/** Ore siphoned per second while working a vein inside siphon reach, kg. */
export const BOT_SIPHON_RATE_KG_S = 6;
/** Slow passive sampling gain while surveying, kg/s. */
export const BOT_SURVEY_GAIN_KG_S = 0.6;
/** Depot unload rate, kg/s. */
export const BOT_UNLOAD_RATE_KG_S = 40;
/** How long a mining pulse keeps the bot in harass posture after the pulse, s. */
export const HARASS_LINGER_S = 3.5;
/** Contest claim broadcast re-arm / release hysteresis, s / metres. */
export const CONTEST_HOLD_S = 12;
export const CONTEST_RELEASE_M = 35;

/** Cruise speeds per state, m/s. */
export const BOT_STATE_SPEEDS: Record<NPCBotState, number> = {
  patrol: 2.0,
  survey: 0.6,
  contest_claim: 3.2,
  harass_mine: 4.2,
  siphon_ore: 3.6,
  flee: 5.2,
};

/** Flag palette per fictional faction (Spec 25 §2.3: main field + accent). */
export const NPC_FLAG_COLORS: Record<
  NPCBotFaction,
  { main: [number, number, number]; accent: [number, number, number] }
> = {
  CAELUM: { main: [0x0d / 255, 0x1b / 255, 0x2a / 255], accent: [0xd4 / 255, 0xaf / 255, 0x37 / 255] },
  UNITED_SOL: { main: [0x8b / 255, 0, 0], accent: [0x2b / 255, 0x2b / 255, 0x2b / 255] },
  VALLES: { main: [0xc8 / 255, 0x5a / 255, 0x17 / 255], accent: [1, 1, 1] },
  BOREALIS: { main: [0x1b / 255, 0x4d / 255, 0x3e / 255], accent: [0xc0 / 255, 0xc0 / 255, 0xc0 / 255] },
};

/** A warning broadcast emitted when a claim is contested (consumed by the HUD). */
export interface NPCBotBroadcast {
  text: string;
  /** Bot-internal sim clock at emission, seconds. */
  atSimS: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Deterministic mulberry32 PRNG (bot-local; no global state). */
class BotRandom {
  private s: number;
  constructor(seed: string) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    this.s = h >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

/**
 * Vertex-wave flutter applied to a flag mesh's local positions. The wave runs
 * from the hoist edge (u = 0, pinned) to the free edge (u = 1): displacement
 * grows with u^1.4, amplitude scales with ground speed, phase advances with
 * dt so the pennant whips harder the faster the bot rolls.
 */
function flutterFlag(
  mesh: Mesh,
  basePositions: Float32Array,
  widthM: number,
  amplitudeBase: number,
  phase: number,
): void {
  const raw = mesh.getVerticesData('position');
  if (raw === null) return;
  const pos = raw instanceof Float32Array ? raw : new Float32Array(raw);
  const w = Math.max(widthM, 1e-4);
  for (let i = 0; i < pos.length; i += 3) {
    const bx = basePositions[i] ?? 0;
    const by = basePositions[i + 1] ?? 0;
    const u = clamp(bx / w, 0, 1);
    pos[i] = bx;
    pos[i + 1] = by;
    pos[i + 2] =
      (basePositions[i + 2] ?? 0) +
      Math.sin(phase + u * 7.5 + by * 2.2) * amplitudeBase * Math.pow(u, 1.4);
  }
  mesh.updateVerticesData('position', pos);
  // Cheap re-light of the deformed cloth (≤ ~100 verts — noise on the budget).
  const nrm = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, mesh.getIndices(), nrm);
  mesh.updateVerticesData('normal', nrm);
}

/**
 * Hand-rolled cloth grid for the faction pennant: (nx+1)×(ny+1) vertices with
 * the hoist edge at local x = 0, both facings indexed (double-sided vacuum
 * cloth). Deterministic, NullEngine-safe, and subdivided exactly where the
 * flutter formula needs it.
 */
function buildFlagGrid(
  name: string,
  widthM: number,
  heightM: number,
  nx: number,
  ny: number,
  scene: Scene,
): Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let iy = 0; iy <= ny; iy++) {
    for (let ix = 0; ix <= nx; ix++) {
      positions.push((ix / nx) * widthM, (iy / ny) * heightM - heightM / 2, 0);
      uvs.push(ix / nx, iy / ny);
    }
  }
  const doubleSidedIndices: number[] = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iy * (nx + 1) + ix;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      doubleSidedIndices.push(a, b, c, b, d, c);
    }
  }
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = doubleSidedIndices;
  vertexData.uvs = uvs;
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, doubleSidedIndices, normals);
  vertexData.normals = normals;
  const mesh = new Mesh(name, scene);
  vertexData.applyToMesh(mesh, true);
  return mesh;
}

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

export class NPCProspectorBot {
  // -- contract inputs ---------------------------------------------------------
  private readonly scene: Scene;
  private readonly config: NPCBotConfig;
  private readonly worldGen: LunarWorldGenerator;
  private readonly rng: BotRandom;

  // -- kinematic state (physics frame) ------------------------------------------
  private px: number;
  private py: number;
  private pz: number;
  private heading: number;
  private speed = 0;
  private state: NPCBotState = 'patrol';
  private targetVeinId: string | null = null;
  private cargoKg = 0;
  private simS = 0;

  // -- AI bookkeeping -------------------------------------------------------------
  private knownVeins: ResourceVein[] = [];
  private targetIndex = 0;
  private waypoint: { x: number; y: number } | null = null;
  private waypointArrivedAtS: number | null = null;
  private scanTimerS = 0;
  private harassTimerS = 0;
  private contestTimerS = 0;
  private contestBroadcastArmed = true;
  private bumpCooldownS = 0;
  private pendingPush = { x: 0, y: 0 };
  private hasPendingPush = false;
  private broadcasts: NPCBotBroadcast[] = [];

  // -- scene graph ------------------------------------------------------------------
  private disposed = false;
  private readonly root: TransformNode;
  private readonly meshes: Mesh[] = [];
  private readonly materials: StandardMaterial[] = [];
  private readonly wheels: Mesh[] = [];
  private readonly wheelBases: Quaternion[] = [];
  private wheelSpin = 0;
  private readonly drillPivot: TransformNode;
  private readonly flagMesh: Mesh;
  private readonly flagStripe: Mesh;
  private readonly flagBasePos: Float32Array;
  private readonly stripeBasePos: Float32Array;
  private readonly flagColorRGB: [number, number, number];
  private readonly antennaTipMat: StandardMaterial;
  private readonly beamMesh: Mesh;
  private flutterPhase = 0;
  private blinkPhase = 0;

  // -- scratch (no per-frame allocation) -----------------------------------------
  private readonly scratchVecA = new Vector3(0, 0, 0);
  private readonly scratchVecC = new Vector3(0, 0, 0);
  private readonly scratchMat = new Matrix();
  private readonly scratchQuat = new Quaternion();
  private readonly scratchQuat2 = new Quaternion();
  private readonly scratchQuat3 = new Quaternion();
  private readonly smoothedNormal = new Vector3(0, 1, 0);

  private lastTelemetry: NPCBotTelemetry;

  constructor(scene: Scene, config: NPCBotConfig, worldGen: LunarWorldGenerator) {
    this.scene = scene;
    this.config = config;
    this.worldGen = worldGen;
    this.rng = new BotRandom(`npc-bot:${config.id}`);
    this.px = config.spawnPosition.x;
    this.py = config.spawnPosition.y;
    this.pz = this.groundAt(config.spawnPosition.x, config.spawnPosition.y);
    this.heading = this.rng.range(-Math.PI, Math.PI);

    const palette = NPC_FLAG_COLORS[config.faction];
    this.flagColorRGB = [...palette.main] as [number, number, number];

    // ---- root + chassis ---------------------------------------------------------
    this.root = new TransformNode(`npc-${config.id}-root`, scene);
    this.buildChassis();

    // ---- drill arm (front, tilts) --------------------------------------------
    this.drillPivot = new TransformNode(`npc-${config.id}-drill-pivot`, scene);
    this.drillPivot.parent = this.root;
    this.drillPivot.position.set(0, 0.82, 1.1);
    this.drillPivot.rotation.x = 0.95;
    {
      const arm = this.mesh('cyl', `npc-${config.id}-drill-arm`, {
        diameter: 0.17,
        height: 0.9,
      });
      arm.position.set(0, 0.45, 0);
      arm.material = this.mat('hull', 0.32, 0.33, 0.36, 0.02, 0.02, 0.02);
      arm.parent = this.drillPivot;
      const bit = this.mesh('cyl', `npc-${config.id}-drill-bit`, {
        diameterTop: 0.02,
        diameterBottom: 0.2,
        height: 0.5,
        tessellation: 8,
      });
      bit.position.set(0, 1.05, 0);
      bit.material = this.mat('bit', 0.7, 0.55, 0.2, 0.08, 0.05, 0.01);
      bit.parent = this.drillPivot;
    }

    // ---- antenna mast + blinking tip ------------------------------------------
    {
      const mast = this.mesh('cyl', `npc-${config.id}-antenna`, {
        diameter: 0.045,
        height: 1.0,
      });
      mast.position.set(-0.45, 1.3, -0.35);
      mast.material = this.mat('hull', 0.32, 0.33, 0.36, 0.02, 0.02, 0.02);
      this.antennaTipMat = this.mat('tip', 0.9, 0.35, 0.12, 0.9, 0.3, 0.08);
      const tip = this.mesh('sph', `npc-${config.id}-antenna-tip`, { diameter: 0.11 });
      tip.position.set(-0.45, 1.84, -0.35);
      tip.material = this.antennaTipMat;
    }

    // ---- rear cargo hopper -------------------------------------------------------
    {
      const hopper = this.mesh('box', `npc-${config.id}-hopper`, {
        width: 1.05,
        height: 0.6,
        depth: 0.75,
      });
      hopper.position.set(0, 0.92, -0.9);
      hopper.material = this.mat('hull', 0.3, 0.31, 0.34, 0.02, 0.02, 0.02);
      const mouth = this.mesh('box', `npc-${config.id}-hopper-mouth`, {
        width: 0.9,
        height: 0.06,
        depth: 0.6,
      });
      mouth.position.set(0, 1.24, -0.9);
      mouth.material = this.mat('ore', 0.12, 0.1, 0.1, 0.05, 0.03, 0.0);
    }

    // ---- carbon-composite flagpole + dynamic faction pennant --------------------
    let flagMesh: Mesh;
    let flagStripe: Mesh;
    {
      const pole = this.mesh('cyl', `npc-${config.id}-flagpole`, {
        diameter: 0.05,
        height: 1.5,
      });
      pole.position.set(0.58, 1.55, -1.05);
      pole.material = this.mat('carbon', 0.12, 0.12, 0.13, 0.01, 0.01, 0.01);
      const finial = this.mesh('sph', `npc-${config.id}-flag-finial`, { diameter: 0.09 });
      finial.position.set(0.58, 2.33, -1.05);
      finial.material = this.mat('accent', ...palette.accent, 0.25, 0.2, 0.1);
      const yard = this.mesh('cyl', `npc-${config.id}-flag-yard`, {
        diameter: 0.03,
        height: 0.95,
      });
      yard.rotation.x = Math.PI / 2;
      yard.position.set(0.58, 2.28, -1.05 - 0.475);
      yard.material = this.mat('carbon', 0.12, 0.12, 0.13, 0.01, 0.01, 0.01);

      // Pennant: cloth grid in local XY (x = hoist→free edge, y = vertical),
      // hung from the yard arm; the mount yaws so the cloth trails outboard.
      const flagMount = new TransformNode(`npc-${config.id}-flag-mount`, scene);
      flagMount.parent = this.root;
      flagMount.position.set(0.585, 2.02, -1.08);
      flagMount.rotation.y = -Math.PI / 2;

      flagMesh = buildFlagGrid(`npc-${config.id}-flag`, 0.9, 0.5, 8, 5, scene);
      const flagMainMat = this.mat('flag-main', ...palette.main, 0.55, 0.55, 0.55);
      flagMainMat.backFaceCulling = false;
      flagMesh.material = flagMainMat;
      flagMesh.parent = flagMount;

      flagStripe = buildFlagGrid(`npc-${config.id}-flag-stripe`, 0.9, 0.16, 8, 2, scene);
      flagStripe.position.set(0, -0.1, 0.012);
      const flagAccentMat = this.mat('flag-accent', ...palette.accent, 0.55, 0.55, 0.55);
      flagAccentMat.backFaceCulling = false;
      flagStripe.material = flagAccentMat;
      flagStripe.parent = flagMount;
    }
    this.flagMesh = flagMesh;
    this.flagStripe = flagStripe;
    this.flagBasePos = Float32Array.from(flagMesh.getVerticesData('position') ?? []);
    this.stripeBasePos = Float32Array.from(flagStripe.getVerticesData('position') ?? []);

    // ---- harass mining beam (hidden until fired) -------------------------------
    this.beamMesh = this.mesh('cyl', `npc-${config.id}-beam`, {
      diameterTop: 0.05,
      diameterBottom: 0.1,
      height: 1,
      tessellation: 6,
    });
    const beamMat = this.mat('beam', 1.0, 0.45, 0.08, 1.0, 0.4, 0.05);
    beamMat.alpha = 0.65;
    beamMat.disableLighting = true;
    this.beamMesh.material = beamMat;
    this.beamMesh.setEnabled(false);
    this.beamMesh.isPickable = false;

    // ---- initial placement -------------------------------------------------------
    this.lastTelemetry = this.buildTelemetry();
    this.placeOnSurface(this.smoothedNormal);
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * One AI + kinematics tick. `playerState` is the active player avatar in the
   * physics frame with `isMining` true while a mining-laser pulse is live.
   * Safe after `dispose()` (no-op).
   */
  update(dt: number, playerState: { x: number; y: number; z: number; isMining: boolean }): void {
    if (this.disposed) return;
    const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);
    if (step <= 0) return;
    this.simS += step;
    this.bumpCooldownS = Math.max(0, this.bumpCooldownS - step);

    // 1. Resolve behaviour state (priority: flee > harass > contest > survey > patrol)
    this.decideState(playerState, step);

    // 2. Pick a movement goal and steer.
    const goal = this.pickGoal(playerState);
    if (goal !== null) this.steerTowards(goal.x, goal.y, BOT_STATE_SPEEDS[this.state], step);

    // 3. Surface adhesion + slope attitude.
    this.pz = this.groundAt(this.px, this.py);
    const normal = this.surfaceNormalBabylon();
    this.smoothedNormal.set(
      this.smoothedNormal.x + (normal.x - this.smoothedNormal.x) * clamp(6 * step, 0, 1),
      this.smoothedNormal.y + (normal.y - this.smoothedNormal.y) * clamp(6 * step, 0, 1),
      this.smoothedNormal.z + (normal.z - this.smoothedNormal.z) * clamp(6 * step, 0, 1),
    );
    this.placeOnSurface(this.smoothedNormal);

    // 4. Per-state mechanics: siphon / bump / unload.
    this.applyStateMechanics(playerState, step);

    // 5. Animation: wheels, flag flutter, beacon blink, beam.
    this.animate(step);
    this.updateBeam();

    this.lastTelemetry = this.buildTelemetry();
  }

  /** Telemetry snapshot for HUD / network fan-out (Spec 25 §2.3). */
  getTelemetry(): NPCBotTelemetry {
    return { ...this.lastTelemetry, position: { ...this.lastTelemetry.position } };
  }

  /** Every mesh owned by this bot (all descendants of the single root). */
  getMeshes(): Mesh[] {
    if (this.disposed) return [];
    return [...this.meshes];
  }

  /** The single root node all meshes are parented to. */
  getRootNode(): TransformNode | null {
    return this.disposed ? null : this.root;
  }

  /** Id for fleet bookkeeping. */
  getId(): string {
    return this.config.id;
  }

  /** Current AI state. */
  getState(): NPCBotState {
    return this.state;
  }

  /**
   * Take the accumulated chassis-bump impulse (N·s, physics-frame horizontal)
   * that should be imparted to the player avatar; returns null when nothing is
   * pending. The caller converts with {@link BOT_PUSH_EFFECTIVE_MASS_KG}.
   */
  consumePlayerImpulse(): { x: number; y: number } | null {
    if (!this.hasPendingPush) return null;
    this.hasPendingPush = false;
    const out = { ...this.pendingPush };
    this.pendingPush = { x: 0, y: 0 };
    return out;
  }

  /** Drain pending warning broadcasts (contest claims). */
  consumeBroadcasts(): NPCBotBroadcast[] {
    if (this.broadcasts.length === 0) return [];
    const out = this.broadcasts;
    this.broadcasts = [];
    return out;
  }

  /** Tear down every mesh/material/node. Idempotent, never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of this.meshes) NPCProspectorBot.disposeQuietly(m);
    for (const m of this.materials) NPCProspectorBot.disposeQuietly(m);
    NPCProspectorBot.disposeQuietly(this.drillPivot);
    // Flag mount + children (children already covered by this.meshes).
    const flagMount = this.flagMesh.parent;
    NPCProspectorBot.disposeQuietly(flagMount);
    NPCProspectorBot.disposeQuietly(this.root);
    this.meshes.length = 0;
    this.wheels.length = 0;
    this.broadcasts.length = 0;
  }

  // ===========================================================================
  // State machine
  // ===========================================================================

  /**
   * Is the bot parked at a deposit (claim working distance)? Vein spheres are
   * huge subsurface ore bodies (r can exceed 800 m), so "at the deposit"
   * means horizontal proximity to the centre, not containment in the sphere.
   */
  private atClaim(vein: ResourceVein): boolean {
    return dist2({ x: this.px, y: this.py }, vein.center) <= CLAIM_WORK_RADIUS_M;
  }

  private decideState(
    playerState: { x: number; y: number; z: number; isMining: boolean },
    dt: number,
  ): void {
    // Full hopper → run for the depot. Nothing overrides it.
    if (this.cargoKg >= BOT_CARGO_CAPACITY_KG) {
      this.state = 'flee';
      this.targetVeinId = null;
      return;
    }
    if (this.state === 'flee') {
      // Only leaves flee once the hopper is actually empty.
      return;
    }

    // A mining pulse near any surveyed deposit adopts that deposit as the
    // contested target (the vein the player is drilling).
    if (playerState.isMining) {
      for (const v of this.knownVeins) {
        if (v.remaining > 0 && dist2(playerState, v.center) < CONTEST_RANGE_M) {
          this.targetVeinId = v.id;
          this.harassTimerS = HARASS_LINGER_S;
          break;
        }
      }
    }
    this.harassTimerS = Math.max(0, this.harassTimerS - dt);
    if (this.harassTimerS > 0 && this.activeVein() !== null) {
      this.state = 'harass_mine';
      return;
    }

    // Contest claim: player inside CONTEST_RANGE_M of any claimed deposit
    // (outranks siphon/survey/patrol — the bot drives off whatever it was
    // hoovering and plants itself against the intruder).
    let contestedVein: ResourceVein | null = null;
    let contestedDist = Infinity;
    for (const v of this.knownVeins) {
      const d = dist2(playerState, v.center);
      if (d < contestedDist) {
        contestedDist = d;
        contestedVein = v;
      }
    }
    if (contestedVein !== null && contestedDist < CONTEST_RANGE_M) {
      this.targetVeinId = contestedVein.id;
      if (this.state !== 'contest_claim') {
        this.state = 'contest_claim';
        this.contestTimerS = CONTEST_HOLD_S;
        this.contestBroadcastArmed = true;
      }
      this.contestTimerS = Math.max(0, this.contestTimerS - dt);
      if (this.contestBroadcastArmed) {
        this.contestBroadcastArmed = false;
        this.emitBroadcast(
          `⚠ CONTEST CLAIM — ${this.config.callsign} (${this.config.faction}) disputes claim on ` +
            `${contestedVein.id} (${contestedVein.kind.replace(/_/g, ' ')}). Back off the deposit.`,
        );
      }
      if (this.contestTimerS > 0) return;
    }
    if (
      this.state === 'contest_claim' &&
      contestedVein !== null &&
      contestedDist < CONTEST_RELEASE_M
    ) {
      return; // stay planted until the intruder leaves the hysteresis band
    }

    // Siphon: parked on a known claim, hoovering loose ore chunks. Terminal
    // (until harass/contest/flee take over or the hopper fills).
    const vein = this.activeVein();
    if (vein !== null && this.knownVeins.length > 0) {
      if (this.state === 'siphon_ore' || this.atClaim(vein)) {
        this.state = 'siphon_ore';
        return;
      }
    }

    // No known mineral targets → survey the surface.
    if (this.knownVeins.length === 0) {
      this.state = 'survey';
      this.scanTimerS -= dt;
      if (this.scanTimerS <= 0) {
        this.scanTimerS = 2.5;
        const found = this.queryVeins(this.px, this.py, SURVEY_RANGE_M);
        if (found.length > 0) {
          this.knownVeins = found;
          this.targetIndex = 0;
          const first = found[0];
          if (first !== undefined) this.targetVeinId = first.id;
        }
      }
      return;
    }

    this.state = 'patrol';
  }

  private activeVein(): ResourceVein | null {
    if (this.targetVeinId === null) return null;
    for (const v of this.knownVeins) {
      if (v.id === this.targetVeinId) return v;
    }
    return null;
  }

  /** Movement goal per state, or null to hold station. */
  private pickGoal(
    playerState: { x: number; y: number; z: number },
  ): { x: number; y: number } | null {
    switch (this.state) {
      case 'flee':
        // Depot == spawn anchor (fleet placement parks bots on dock nodes).
        return { x: this.config.spawnPosition.x, y: this.config.spawnPosition.y };
      case 'harass_mine': {
        const vein = this.activeVein();
        if (vein === null) return null;
        const dPlayer = dist2(playerState, vein.center);
        if (dPlayer < HARASS_BUMP_RANGE_M * 0.35) {
          // Point-blank: crowd the player directly so the bump lands.
          return { x: playerState.x, y: playerState.y };
        }
        // Wedge between player and vein: 1.8 m proud of the deposit on the
        // vein→player line.
        const tx = vein.center.x;
        const ty = vein.center.y;
        const dx = playerState.x - tx;
        const dy = playerState.y - ty;
        const len = Math.hypot(dx, dy) || 1;
        const stand = Math.min(1.8, len * 0.5);
        return { x: tx + (dx / len) * stand, y: ty + (dy / len) * stand };
      }
      case 'contest_claim': {
        const vein = this.activeVein();
        if (vein === null) return null;
        // Plant the flag beside the deposit (hold station once there).
        const d = dist2({ x: this.px, y: this.py }, vein.center);
        return d < 8 ? null : { x: vein.center.x + 2.2, y: vein.center.y };
      }
      case 'survey':
        // Drift slowly while scanning.
        return this.patrolWaypoint();
      case 'patrol':
      case 'siphon_ore':
      default: {
        const vein = this.activeVein();
        if (vein !== null && this.state === 'siphon_ore') {
          return { x: vein.center.x, y: vein.center.y };
        }
        return this.patrolWaypoint();
      }
    }
  }

  private patrolWaypoint(): { x: number; y: number } {
    // Wander between mineral nodes / waypoints (Spec 25 §2.3): hold the
    // current waypoint until reached, dwell briefly, then rotate to the next
    // candidate (known claims first, random in-radius points otherwise).
    if (this.waypoint !== null) {
      const d = dist2({ x: this.px, y: this.py }, this.waypoint);
      if (d > 6) {
        this.waypointArrivedAtS = null;
        return this.waypoint;
      }
      if (this.waypointArrivedAtS === null) this.waypointArrivedAtS = this.simS;
      if (this.simS - this.waypointArrivedAtS < 2.5) return this.waypoint; // dwell
    }
    this.waypointArrivedAtS = null;
    this.waypoint = this.pickWaypointCandidate();
    return this.waypoint;
  }

  private pickWaypointCandidate(): { x: number; y: number } {
    // Surveyed claims first, rotating through the roster (oldest-deposit
    // discipline beats random teleports across the sector); random in-radius
    // waypoints only when the map book is empty.
    this.knownVeins = this.knownVeins.filter((v) => v.remaining > 0);
    if (this.knownVeins.length > 0) {
      const idx = this.targetIndex % this.knownVeins.length;
      const v = this.knownVeins[idx];
      this.targetIndex = idx + 1;
      if (v !== undefined) {
        this.targetVeinId = v.id;
        return { x: v.center.x, y: v.center.y };
      }
    }
    // Random heading point inside the patrol radius around spawn.
    const r = this.config.patrolRadiusM;
    const a = this.rng.range(-Math.PI, Math.PI);
    const d = this.rng.range(r * 0.25, r);
    return {
      x: this.config.spawnPosition.x + Math.cos(a) * d,
      y: this.config.spawnPosition.y + Math.sin(a) * d,
    };
  }

  /** Siphon / bump / unload mechanics for the active state. */
  private applyStateMechanics(
    playerState: { x: number; y: number; z: number; isMining: boolean },
    dt: number,
  ): void {
    const vein = this.activeVein();
    switch (this.state) {
      case 'harass_mine': {
        if (vein === null) break;
        // Siphon loose ore chunks within reach (bot-side bookkeeping — the
        // shared survey ledger is deliberately untouched so rival extraction
        // never mutates the player's authoritative harvest).
        if (this.atClaim(vein)) {
          this.cargoKg = Math.min(
            BOT_CARGO_CAPACITY_KG,
            this.cargoKg + BOT_SIPHON_RATE_KG_S * dt,
          );
        }
        // Low-speed chassis bumps: inside 8 m, close the gap and shove.
        const dPlayer = dist2(playerState, { x: this.px, y: this.py });
        if (dPlayer < HARASS_BUMP_RANGE_M && this.bumpCooldownS <= 0) {
          if (dPlayer < 3.2) {
            const dx = playerState.x - this.px;
            const dy = playerState.y - this.py;
            const len = Math.hypot(dx, dy) || 1;
            this.pendingPush.x += (dx / len) * BOT_PUSH_IMPULSE_N_S;
            this.pendingPush.y += (dy / len) * BOT_PUSH_IMPULSE_N_S;
            this.hasPendingPush = true;
            this.bumpCooldownS = 3;
          }
        }
        break;
      }
      case 'siphon_ore': {
        // Parked on the claimed deposit, hoovering loose ore chunks.
        if (vein !== null && this.atClaim(vein)) {
          this.cargoKg = Math.min(
            BOT_CARGO_CAPACITY_KG,
            this.cargoKg + BOT_SIPHON_RATE_KG_S * dt,
          );
        }
        break;
      }
      case 'contest_claim': {
        if (vein !== null && this.atClaim(vein)) {
          this.cargoKg = Math.min(BOT_CARGO_CAPACITY_KG, this.cargoKg + BOT_SURVEY_GAIN_KG_S * dt);
        }
        break;
      }
      case 'survey': {
        this.cargoKg = Math.min(BOT_CARGO_CAPACITY_KG, this.cargoKg + BOT_SURVEY_GAIN_KG_S * dt);
        break;
      }
      case 'flee': {
        const dDepot = dist2({ x: this.px, y: this.py }, this.config.spawnPosition);
        if (dDepot < 8) {
          this.cargoKg = Math.max(0, this.cargoKg - BOT_UNLOAD_RATE_KG_S * dt);
          if (this.cargoKg <= 0.01) {
            this.cargoKg = 0;
            this.state = 'patrol';
            this.emitBroadcast(`${this.config.callsign}: hopper cleared at depot, resuming survey grid.`);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // ===========================================================================
  // Kinematics
  // ===========================================================================

  /** Analytic surface elevation (physics-frame metres) at (x, y). */
  private groundAt(x: number, y: number): number {
    try {
      const z = this.worldGen.elevationAt(x, y);
      return Number.isFinite(z) ? z : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Lightweight "raycast": central differences of `elevationAt` give the
   * surface normal, returned in Babylon frame (x, z-up component, -y).
   */
  private surfaceNormalBabylon(): Vector3 {
    const e = 2; // sample half-step, metres
    let nx = 0;
    let ny = 0;
    try {
      const dzdx = (this.groundAt(this.px + e, this.py) - this.groundAt(this.px - e, this.py)) / (2 * e);
      const dzdy = (this.groundAt(this.px, this.py + e) - this.groundAt(this.px, this.py - e)) / (2 * e);
      nx = -dzdx;
      ny = -dzdy;
    } catch {
      /* flat datum */
    }
    const nz = 1;
    const len = Math.hypot(nx, ny, nz) || 1;
    // physics normal (nx, ny, nz↑) → Babylon (x, z, -y)
    return this.scratchVecC.set(nx / len, nz / len, -ny / len);
  }

  /** Place the root on the surface with yaw + smoothed slope attitude. */
  private placeOnSurface(normalBabylon: Vector3): void {
    if (this.disposed) return;
    const body = worldToBabylon({ x: this.px, y: this.py, z: this.pz });
    this.root.position.set(body.x, body.y, body.z);
    // Align local up to the surface normal (minimum-rotation arc), then yaw
    // about the aligned axis so heading stays true on slopes.
    Quaternion.FromUnitVectorsToRef(BABYLON_UP, normalBabylon, this.scratchQuat);
    Quaternion.RotationAxisToRef(BABYLON_UP, Math.PI / 2 + this.heading, this.scratchQuat2);
    this.scratchQuat.multiplyToRef(this.scratchQuat2, this.scratchQuat3);
    this.root.rotationQuaternion = this.scratchQuat3.clone();
  }

  /** Slew heading toward a world target and advance the kinematic position. */
  private steerTowards(tx: number, ty: number, maxSpeed: number, dt: number): void {
    const dx = tx - this.px;
    const dy = ty - this.py;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.35) {
      this.speed = Math.max(0, this.speed - 6 * dt);
    } else {
      const desired = Math.atan2(dy, dx);
      let delta = desired - this.heading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const turnRate = 1.6; // rad/s
      const maxTurn = turnRate * dt;
      this.heading += clamp(delta, -maxTurn, maxTurn);
      // Ease off inside the last few metres, hard cap at state speed.
      const target = maxSpeed * clamp(dist / 6, 0.15, 1);
      this.speed += (target - this.speed) * clamp(3 * dt, 0, 1);
      this.px += Math.cos(this.heading) * this.speed * dt;
      this.py += Math.sin(this.heading) * this.speed * dt;
    }
    this.speed = clamp(this.speed, 0, maxSpeed);
  }

  // ===========================================================================
  // Animation
  // ===========================================================================

  private animate(dt: number): void {
    // Wheels roll with ground speed (axle = local x).
    this.wheelSpin += (this.speed / 0.31) * dt;
    const spin = Quaternion.RotationAxis(BABYLON_RIGHT, this.wheelSpin);
    for (let i = 0; i < this.wheels.length; i++) {
      const wheel = this.wheels[i];
      const base = this.wheelBases[i];
      if (wheel === undefined || base === undefined) continue;
      wheel.rotationQuaternion = spin.multiply(base);
    }
    // Drill arm idles level in patrol, digs in while harassing/contesting.
    const digTarget =
      this.state === 'harass_mine' ? 1.25 : this.state === 'contest_claim' ? 0.75 : 0.95;
    this.drillPivot.rotation.x +=
      (digTarget - this.drillPivot.rotation.x) * clamp(4 * dt, 0, 1);
    if (this.state === 'harass_mine') {
      this.drillPivot.rotation.x += Math.sin(this.simS * 24) * 0.015;
    }

    // Dynamic flag flutter — amplitude & frequency ride the ground speed.
    const speedFrac = clamp(this.speed / BOT_STATE_SPEEDS.flee, 0, 1);
    this.flutterPhase += dt * (3.2 + speedFrac * 11.5);
    const amp = 0.018 + speedFrac * 0.075;
    flutterFlag(this.flagMesh, this.flagBasePos, 0.9, amp, this.flutterPhase);
    flutterFlag(this.flagStripe, this.stripeBasePos, 0.9, amp, this.flutterPhase);

    // Antenna beacon: calm green pulse, urgent strobe while contesting/harassing.
    this.blinkPhase += dt * (this.state === 'harass_mine' || this.state === 'contest_claim' ? 10 : 3);
    const pulse = 0.5 + 0.5 * Math.sin(this.blinkPhase);
    if (this.state === 'harass_mine' || this.state === 'contest_claim') {
      this.antennaTipMat.emissiveColor.set(1, 0.25 * pulse, 0.05);
    } else {
      this.antennaTipMat.emissiveColor.set(0.1 + 0.5 * pulse, 0.9 * (0.4 + 0.6 * pulse), 0.2);
    }
  }

  /** Aim the harass mining beam at the contested vein (world-space aim). */
  private updateBeam(): void {
    const vein = this.activeVein();
    const firing = this.state === 'harass_mine' && vein !== null;
    this.beamMesh.setEnabled(firing);
    if (!firing || vein === null) return;

    // Muzzle = drill bit tip, in world (Babylon frame).
    const muzzleLocal = this.scratchVecA.set(0, 1.3, 0);
    const rootWorld = this.root.getWorldMatrix();
    const muzzleWorld = Vector3.TransformCoordinates(muzzleLocal, rootWorld);
    const target = worldToBabylon({ x: vein.center.x, y: vein.center.y, z: vein.center.z });

    const dir = target.subtract(muzzleWorld);
    const len = dir.length();
    if (len < 0.3) return;
    dir.scaleInPlace(1 / len);

    // Beam lives under the bot root; express the world aim in root-local terms.
    Matrix.FromQuaternionToRef(this.root.rotationQuaternion ?? Quaternion.Identity(), this.scratchMat);
    this.scratchMat.invertToRef(this.scratchMat);
    const midWorld = muzzleWorld.addInPlace(target).scaleInPlace(0.5);
    midWorld.subtractInPlace(this.root.position);
    const localMid = Vector3.TransformCoordinates(midWorld, this.scratchMat);
    const localDir = Vector3.TransformNormal(dir, this.scratchMat).normalize();
    Quaternion.FromUnitVectorsToRef(BABYLON_UP, localDir, this.scratchQuat);
    this.beamMesh.position.copyFrom(localMid);
    this.beamMesh.rotationQuaternion = this.scratchQuat.clone();
    const stretch = clamp(len, 0.5, 400);
    this.beamMesh.scaling.set(1, stretch, 1);
  }

  // ===========================================================================
  // Build helpers
  // ===========================================================================

  private queryVeins(x: number, y: number, radiusM: number): ResourceVein[] {
    try {
      const z = this.groundAt(x, y);
      return this.worldGen.veinsAt(x, y, z + 2, radiusM);
    } catch {
      return [];
    }
  }

  private emitBroadcast(text: string): void {
    this.broadcasts.push({ text, atSimS: this.simS });
    if (this.broadcasts.length > 8) this.broadcasts.shift();
  }

  private buildChassis(): void {
    const palette = NPC_FLAG_COLORS[this.config.faction];
    const hull = this.mat('hull', 0.34, 0.35, 0.38, 0.02, 0.02, 0.02);
    const rubber = this.mat('rubber', 0.08, 0.08, 0.09, 0, 0, 0);

    const body = this.mesh('box', `npc-${this.config.id}-chassis`, {
      width: 1.5,
      height: 0.45,
      depth: 2.4,
    });
    body.position.set(0, 0.6, 0);
    body.material = hull;

    const cabin = this.mesh('box', `npc-${this.config.id}-cabin`, {
      width: 1.05,
      height: 0.5,
      depth: 0.85,
    });
    cabin.position.set(0, 1.05, 0.35);
    cabin.material = this.mat('cabin', 0.2, 0.22, 0.26, 0.01, 0.02, 0.03);

    // Faction livery band across the flanks.
    const livery = this.mesh('box', `npc-${this.config.id}-livery`, {
      width: 1.54,
      height: 0.09,
      depth: 2.42,
    });
    livery.position.set(0, 0.72, 0);
    livery.material = this.mat('livery', ...palette.main, 0.12, 0.12, 0.12);

    // Four road wheels (axle along local x).
    const wheelBase = Quaternion.RotationAxis(BABYLON_FORWARD, Math.PI / 2);
    const corners: Array<[number, number]> = [
      [0.84, 0.88],
      [-0.84, 0.88],
      [0.84, -0.88],
      [-0.84, -0.88],
    ];
    for (let i = 0; i < corners.length; i++) {
      const [wx, wz] = corners[i] as [number, number];
      const wheel = this.mesh('cyl', `npc-${this.config.id}-wheel-${i}`, {
        diameter: 0.62,
        height: 0.24,
        tessellation: 14,
      });
      wheel.position.set(wx, 0.31, wz);
      wheel.rotationQuaternion = wheelBase.clone();
      this.wheelBases.push(wheelBase.clone());
      wheel.material = rubber;
      this.wheels.push(wheel);
    }
  }

  private buildTelemetry(): NPCBotTelemetry {
    return {
      id: this.config.id,
      position: { x: this.px, y: this.py, z: this.pz },
      heading: this.heading,
      speed: this.speed,
      state: this.state,
      targetVeinId: this.targetVeinId,
      cargoKg: this.cargoKg,
      flagColor: [this.flagColorRGB[0], this.flagColorRGB[1], this.flagColorRGB[2]],
    };
  }

  private mesh(kind: string, name: string, options: Record<string, unknown>): Mesh {
    const m =
      kind === 'box'
        ? MeshBuilder.CreateBox(name, options as never, this.scene)
        : kind === 'cyl'
          ? MeshBuilder.CreateCylinder(name, options as never, this.scene)
          : kind === 'sph'
            ? MeshBuilder.CreateSphere(name, options as never, this.scene)
            : MeshBuilder.CreatePlane(name, options as never, this.scene);
    m.isPickable = false;
    this.meshes.push(m);
    return m;
  }

  private mat(
    suffix: string,
    r: number,
    g: number,
    b: number,
    er: number,
    eg: number,
    eb: number,
  ): StandardMaterial {
    const m = new StandardMaterial(`npc-${this.config.id}-${suffix}`, this.scene);
    m.diffuseColor = new Color3(r, g, b);
    m.emissiveColor = new Color3(er, eg, eb);
    m.specularColor = new Color3(0.08, 0.08, 0.08);
    this.materials.push(m);
    return m;
  }

  private static disposeQuietly(target: { dispose: () => unknown } | null | undefined): void {
    if (target === null || target === undefined) return;
    try {
      target.dispose();
    } catch {
      /* Node already gone or scene torn down first — never propagate. */
    }
  }
}

/** Squared planar distance helper (physics frame). */
function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

// ---------------------------------------------------------------------------
// Fleet planning (Spec 25 §2.3 / §3.1: spawn 3–6 autonomous bots across
// resource sectors). Pure function over the world snapshot — headless-safe,
// deterministic per seed, no scene access.
// ---------------------------------------------------------------------------

/** Faction deployment order for the autonomous prospecting fleet. */
export const NPC_BOT_FLEET_FACTIONS: readonly NPCBotFaction[] = [
  'CAELUM',
  'UNITED_SOL',
  'VALLES',
  'BOREALIS',
];

/** Callsign pools per fictional faction (Spec 25 §3.1 fictional-fiction layer). */
export const NPC_BOT_CALLSIGNS: Record<NPCBotFaction, readonly string[]> = {
  CAELUM: ['AUREL-7', 'GILDED-1', 'VESPER-4', 'SUNWARD-9'],
  UNITED_SOL: ['CRIMSON-3', 'IRON-2', 'MERIDIAN-8', 'VIGIL-5'],
  VALLES: ['RUSTLER-6', 'CANYON-1', 'EMBER-3', 'DUSTJAW-7'],
  BOREALIS: ['EVERGREEN-2', 'SHADE-9', 'GLACIER-4', 'FERN-6'],
};

export interface NPCBotFleetPlanOptions {
  /** Spawn anchor (terrain-patch centre) bots are staged around, metres. */
  around: { x: number; y: number };
  /** Only stage near veins within this radius of `around`, metres (default 520). */
  maxStageRadiusM?: number;
  /** Desired bot count; clamped to [3, 6] and to available staging spots. */
  count?: number;
  /** Patrol radius stamped on every config, metres (default 140). */
  patrolRadiusM?: number;
  /** Minimum separation between staged bots, metres (default 60). */
  minBotSpacingM?: number;
}

/**
 * Plan an autonomous prospector fleet from the generated world snapshot:
 * ranks vein deposits by (closeness to the player staging area + remaining
 * abundance + sector claim pressure), keeps the top spots separated by
 * `minBotSpacingM`, stages each bot a few metres off the deposit centre and
 * rotates the four factions + their callsign pool across the fleet.
 */
export function planNPCBotFleet(
  snapshot: {
    veins: Array<{
      id: string;
      kind: string;
      center: { x: number; y: number; z: number };
      remaining: number;
      sectorId: string;
    }>;
    sectors: Array<{ id: string; claimPressure: number }>;
  },
  options: NPCBotFleetPlanOptions,
): NPCBotConfig[] {
  const around = options.around;
  const maxStage = options.maxStageRadiusM ?? 1400;
  const want = clamp(Math.floor(options.count ?? 4), 3, 6);
  const patrolRadiusM = options.patrolRadiusM ?? 140;
  const minSpacing = options.minBotSpacingM ?? 60;

  const pressure = new Map<string, number>();
  for (const s of snapshot.sectors) pressure.set(s.id, s.claimPressure);

  // Score candidate deposits: proximity dominates (bots must be reachable on
  // the local terrain patch), abundance + claim pressure break ties.
  type Candidate = { x: number; y: number; score: number };
  const stage = (radius: number): NPCBotConfig[] => {
    const candidates: Candidate[] = [];
    for (const v of snapshot.veins) {
      const d = dist2(around, v.center);
      if (d > radius) continue;
      const p = pressure.get(v.sectorId) ?? 0;
      const score = 10_000 / (10 + d) + Math.min(v.remaining, 20_000) / 4_000 + p * 3;
      // Stage off the deposit centre toward `around` so bots never sit inside
      // the excavation zone on spawn.
      const len = d || 1;
      const ux = (around.x - v.center.x) / len;
      const uy = (around.y - v.center.y) / len;
      candidates.push({ x: v.center.x + ux * 6, y: v.center.y + uy * 6, score });
    }
    candidates.sort((a, b) => b.score - a.score);

    const configs: NPCBotConfig[] = [];
    for (const c of candidates) {
      if (configs.length >= want) break;
      let tooClose = false;
      for (const placed of configs) {
        if (dist2(placed.spawnPosition, c) < minSpacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      const i = configs.length;
      const faction = NPC_BOT_FLEET_FACTIONS[i % NPC_BOT_FLEET_FACTIONS.length] ?? 'VALLES';
      const pool = NPC_BOT_CALLSIGNS[faction];
      const callsign = pool[Math.floor(i / NPC_BOT_FLEET_FACTIONS.length) % pool.length] ?? `PROSP-${i}`;
      configs.push({
        id: `npc-bot-${i}`,
        faction,
        callsign,
        spawnPosition: { x: c.x, y: c.y },
        patrolRadiusM,
      });
    }
    return configs;
  };

  // Progressively widen the staging envelope until the fleet fills (sparse
  // sectors must still field 3–6 autonomous prospectors).
  const rings =
    options.maxStageRadiusM !== undefined
      ? [maxStage]
      : [520, 760, 1000, 1400].filter((r) => r <= maxStage);
  let best: NPCBotConfig[] = [];
  for (const r of rings) {
    best = stage(r);
    if (best.length >= want) break;
  }
  if (best.length < want && rings.length > 0 && rings[rings.length - 1] !== maxStage) {
    const wider = stage(maxStage);
    if (wider.length > best.length) best = wider;
  }
  return best;
}

export default NPCProspectorBot;
