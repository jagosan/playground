/**
 * Lunar Frontier — derelict rival-team outposts (Spec 25 §2.4 / §3.2).
 *
 * Three weathered, clash-ready ruins of outposts that rival crews abandoned
 * before the player ever reached the map: a Scrapper Syndicate fortress, a
 * derelict Corporate Enclave, and a grounded Nomad Drilling Rig. Each is
 * anchored deterministically on real generator output — surface sector nodes
 * / crater rims from `WorldSnapshot` — never invented coordinates, so every
 * spatial query answers before `init()`, after `dispose()`, and with no
 * scene at all (same contract as `FactionBases`).
 *
 * Archetype asymmetry (procedural primitives only, no GLB):
 *  - `scrapper_fortress` — brutalist scrap redoubt: welded rocket-casing
 *    segments on saddles, corrugated blast shields, leaning scaffolding,
 *    exhaust stacks, razor-wire rings and decaying perimeter pylons. Heavy
 *    decay: rust palette, dented/leaning plates, oil stains.
 *  - `corporate_enclave` — former high-tech station: pressurised geodesic
 *    dome with cracked glass patched in emergency sealant foam, tilted dish
 *    mast on guy wires, executive habitat pods, scorch marks. Mid decay.
 *  - `nomad_rig` — mega-scale mobile planetary crawler grounded permanently:
 *    multi-track tread assemblies, heavy rotary excavator arm (boom + stick
 *    + bucket wheel), fuel storage spheres, rusted catwalks, and a real
 *    flickering emergency `PointLight` beacon.
 *
 * Clash-ready interactive foundation (all three): territory perimeter of
 * 60–90 m marked by decaying boundary pylons, a core command hub flying the
 * faction banner, 2–4 damaged point-defense railgun sockets (broken mount,
 * capacitor spark crackle, red targeting indicator), and surveyable resource
 * depots / damaged hoppers. `isNearRivalBase(pos, thresholdM)` answers the
 * territory question for quests, HUD zones and combat triggers.
 *
 * Coordinates: world metres (x, y lateral, z up) map to Babylon (x, z↑, -y)
 * via the shared `worldToBabylon` from CameraRig — camera, physics, rails
 * and these ruins cannot disagree about where a claim sits. Each site root
 * sits ON its point with model frame +z = nose (heading radians, 0 = +x →
 * Babylon yaw `PI/2 + heading`, the OpenBuggy convention).
 *
 * Headless-safe: `init()` accepts a Scene, a raw engine (a scene is created
 * around it), or nothing (self-owned NullEngine fallback). `dispose()` is
 * idempotent and never throws; after disposal every query answers empty/null
 * and `init()` refuses with a clear error.
 *
 * Usage:
 *   const world = new LunarWorldGenerator('mala-voyage-2431').generate();
 *   const rivals = new RivalBases(world).init(scene);
 *   const site = rivals.isNearRivalBase(playerPos); // RivalBaseSite | null
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';

import { worldToBabylon } from '../engine/CameraRig.ts';
import type { Crater, LunarNode, WorldSnapshot } from '../world/LunarWorldGenerator.ts';

// -- canonical archetypes ------------------------------------------------------

/** Which rival crew left this ruin behind. */
export type RivalBaseArchetype = 'scrapper_fortress' | 'corporate_enclave' | 'nomad_rig';

/** Canonical roster, in planning order. */
export const RIVAL_BASE_ARCHETYPES: readonly RivalBaseArchetype[] = [
  'scrapper_fortress',
  'corporate_enclave',
  'nomad_rig',
];

/** Spec 25 §2.4: territory perimeter bounds (m) for every rival site. */
export const MIN_PERIMETER_RADIUS_M = 60;
export const MAX_PERIMETER_RADIUS_M = 90;

/** Root/material name prefix when none is supplied. */
export const DEFAULT_NAME_PREFIX = 'rival-base';

/** A node farther from a crater's rim circle than this is not a rim site. */
export const CRATER_RIM_SNAP_TOL_M = 1_200;

/** Static identity of one archetype (lore, palette, site preference). */
export interface RivalArchetypeDefinition {
  id: RivalBaseArchetype;
  name: string;
  factionLore: string;
  /** Banner cloth colour (linear RGB 0..1). */
  accent: readonly [number, number, number];
  /** Nominal territory perimeter before `perimeterScale` (m). */
  perimeterM: number;
  /** Nominal decay 0.0 (pristine) .. 1.0 (heavily degraded). */
  decay: number;
  /** Host-node kind preference when picking the anchor node. */
  preference: readonly LunarNode['kind'][];
}

const ARCHETYPE_DEFS: Record<RivalBaseArchetype, RivalArchetypeDefinition> = {
  scrapper_fortress: {
    id: 'scrapper_fortress',
    name: 'Scrapper Syndicate Fortress',
    factionLore:
      'The Syndicate welded their redoubt from dead rocket casings in a single ' +
      'salty month, then salted it again when the assay went dry. Every plate ' +
      'is rusted, every pylon leans, and the razor wire still bites.',
    accent: [0.72, 0.24, 0.08],
    perimeterM: 78,
    decay: 0.78,
    preference: ['outpost', 'dock', 'refinery'],
  },
  corporate_enclave: {
    id: 'corporate_enclave',
    name: 'Derelict Corporate Enclave',
    factionLore:
      'Helion Dynamics spent nine hundred million credits on this enclave and ' +
      'evacuated it in eleven minutes. The sealant foam held the dome; the ' +
      'share price did not. Executive pods still smell faintly of lavender.',
    accent: [0.3, 0.52, 0.62],
    perimeterM: 66,
    decay: 0.52,
    preference: ['refinery', 'dock', 'outpost'],
  },
  nomad_rig: {
    id: 'nomad_rig',
    name: 'Nomad Drilling Rig',
    factionLore:
      'The Nomads drove this crawler-plant across four sectors until track ' +
      'three finally threw a gear. They lived on it, drilled from it, and left ' +
      'on foot — beacon still burning for a crew that is never coming back.',
    accent: [0.86, 0.62, 0.12],
    perimeterM: 88,
    decay: 0.66,
    preference: ['dock', 'refinery', 'outpost'],
  },
};

// -- public shapes ---------------------------------------------------------------

/** One rival outpost: plain, serialisable claim/ruin record. */
export interface RivalBaseSite {
  id: string;
  archetype: RivalBaseArchetype;
  name: string;
  factionLore: string;
  position: { x: number; y: number; z: number };
  heading: number;
  perimeterRadiusM: number;
  decayLevel: number; // 0.0 (pristine) to 1.0 (heavily degraded)
}

/** Anything carrying the records the system needs — a `WorldSnapshot` fits. */
export interface RivalBasesSource {
  nodes?: LunarNode[];
  craters?: Crater[];
}

/** Options for the rival outpost builder. */
export interface RivalBasesOptions {
  /** Root/material name prefix (default `rival-base`). */
  namePrefix?: string;
  /** Multiplier on every perimeter radius (default 1, clamped 60–90 m). */
  perimeterScale?: number;
  /** Build the nomad beacon PointLight (default true; emissive head always). */
  beaconLight?: boolean;
  /** Restrict the roster to a subset of the canonical three (default all). */
  roster?: readonly RivalBaseArchetype[];
}

/** Shared PBR set, built once per system. */
interface RivalMaterials {
  rust: PBRMaterial;
  darkRust: PBRMaterial;
  steel: PBRMaterial;
  dark: PBRMaterial;
  glass: PBRMaterial;
  foam: PBRMaterial;
  scorch: PBRMaterial;
  grit: PBRMaterial;
  beacon: PBRMaterial;
  spark: PBRMaterial;
  target: PBRMaterial;
}

/** Per-site built scene objects. */
interface SiteSceneKit {
  root: TransformNode;
  meshes: Mesh[];
  lights: PointLight[];
}

/**
 * One site's kit construction surface: primitive helpers that create, place,
 * parent and metadata-tag in a single call, closing over the site root so
 * every mesh carries its archetype identity without name-string archaeology.
 */
interface KitBuilder {
  root(): TransformNode;
  /** Adopt an externally-built mesh into this site's tracked, tagged set. */
  adopt(mesh: Mesh, part: string): Mesh;
  box(name: string, part: string, w: number, h: number, d: number, x: number, y: number, z: number, mat: PBRMaterial): Mesh;
  cyl(name: string, part: string, dTop: number, dBottom: number, h: number, x: number, y: number, z: number, mat: PBRMaterial, tess?: number): Mesh;
  sph(name: string, part: string, diameter: number, x: number, y: number, z: number, mat: PBRMaterial, segments?: number, slice?: number): Mesh;
  torus(name: string, part: string, diameter: number, thickness: number, x: number, y: number, z: number, mat: PBRMaterial): Mesh;
  merged(name: string, part: string, sources: Mesh[], mat: PBRMaterial): Mesh;
  /** Straight strut from (x1,y1,z1) to (x2,y2,z2), model frame. */
  strut(name: string, part: string, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, diameter: number, mat: PBRMaterial): Mesh;
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Deterministic integer hash (fnv-ish) over a string. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Is this node plausible surface infrastructure (a ruin host)? */
function isSurfaceHost(node: LunarNode): boolean {
  return (node.kind === 'refinery' || node.kind === 'dock' || node.kind === 'outpost')
    && node.position.z >= -1
    && Number.isFinite(node.position.x)
    && Number.isFinite(node.position.y);
}

/** Clamp helper (finite numbers only). */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// -- shared kit geometry (metres; model frame: +z nose, +x left, +y up) ---------

const GEO = {
  hub: { diameter: 8.4, height: 5.4, poleHeight: 9.5, poleDiameter: 0.22,
    cloth: { w: 3.4, h: 2.4, ribDepth: 0.06 } },
  pylon: { count: 12, height: 3.4, diameter: 0.42, wireHeights: [1.1, 1.9, 2.7] },
  socket: { count: 4, baseDiameter: 2.4, baseHeight: 0.55, yokeDiameter: 1.1, yokeHeight: 1.5,
    barrelDiameter: 0.34, barrelLength: 4.2, capacitor: { w: 0.8, h: 1.0, d: 0.6 },
    spark: 0.16, indicator: 0.24 },
  hopper: { topDiameter: 3.4, bottomDiameter: 1.2, height: 3.0, spoutLength: 2.2 },
  scrapper: {
    casing: { diameter: 3.2, length: 11.5, saddleHeight: 1.0 },
    shield: { width: 7.5, height: 4.8, thickness: 0.22, ribCount: 7, ribDepth: 0.16 },
    stack: { diameter: 1.1, height: 7.2 },
    scaffold: { height: 6.8, legOffset: 1.1, legDiameter: 0.2 },
    stain: { diameter: 5.5 },
  },
  corporate: {
    dome: { diameter: 15.5, segments: 12, innerDiameter: 10.5, ringDiameter: 16.2,
      ringThickness: 1.2, ringY: 0.5, z: -3.5 },
    mast: { x: 8.5, z: 4.5, height: 10.5, diameter: 0.5, tilt: 0.24, dishDiameter: 6.5,
      capSlice: 0.24, guyDiameter: 0.07, guyAnchors: 3, guyRadius: 7.5 },
    pod: { length: 5.2, diameter: 2.6, linkWidth: 1.2 },
  },
  nomad: {
    chassis: { width: 15, height: 3.6, length: 30, deckY: 3.6, z: -4 },
    tread: { width: 3.2, height: 3.4, length: 9, wheelDiameter: 2.6, wheelCount: 3 },
    boom: { width: 1.4, run: 9, rise: 7.5 },
    stick: { width: 1.0 },
    wheel: { diameter: 4.2, thickness: 2.0, teeth: 8 },
    fuel: { diameter: 4.6 },
    catwalk: { width: 1.8, length: 6, thickness: 0.16, railHeight: 1.0 },
    beacon: { mastHeight: 3.2, mastDiameter: 0.26, headDiameter: 0.7, x: -8.3, z: 2.0 },
  },
} as const;

/** Scrapper blast-shield slots (model frame). */
const SCRAP_SHIELD_SLOTS: ReadonlyArray<{ x: number; z: number; yaw: number; lean: number }> = [
  { x: -9.5, z: 7.5, yaw: 0.5, lean: 0.09 },
  { x: 9.0, z: 7.0, yaw: -0.45, lean: -0.07 },
  { x: -10.5, z: -6.5, yaw: 1.1, lean: 0.12 },
  { x: 10.0, z: -7.5, yaw: -1.05, lean: -0.1 },
  { x: 0, z: -11.5, yaw: 0.06, lean: 0.05 },
];

/** Scrapper rocket-casing slots (model frame). */
const SCRAP_CASING_SLOTS: ReadonlyArray<{ x: number; z: number; yaw: number }> = [
  { x: -4.5, z: 3.5, yaw: 0.22 },
  { x: 4.5, z: 1.5, yaw: -0.35 },
  { x: -1.5, z: -5.5, yaw: 0.9 },
];

/** Corporate executive habitat pod slots (model frame). */
const CORP_POD_SLOTS: ReadonlyArray<{ x: number; z: number; yaw: number }> = [
  { x: -13.5, z: 6.5, yaw: 0.4 },
  { x: -14.0, z: -1.5, yaw: 0.15 },
  { x: -12.5, z: -9.0, yaw: -0.25 },
];

/** Damaged hopper slots (model frame; shared by all archetypes). */
const DEPOT_SLOTS: ReadonlyArray<{ x: number; z: number; yaw: number; slump: number }> = [
  { x: 7.0, z: 12.0, yaw: 0.3, slump: 0.12 },
  { x: 11.5, z: -11.0, yaw: -0.7, slump: 0.2 },
  { x: -9.0, z: 14.0, yaw: 0.9, slump: 0.08 },
];

/** Damaged railgun socket bearings around the perimeter (radians, model frame). */
const SOCKET_BEARINGS: readonly number[] = [0.62, 1.95, 3.9, 5.5];

/** Corporate dome fracture patches (angle around dome, height, blob size). */
const FOAM_PATCHES: ReadonlyArray<{ a: number; y: number; s: number }> = [
  { a: 0.5, y: 3.2, s: 1.7 },
  { a: 1.9, y: 2.4, s: 2.2 },
  { a: 2.9, y: 4.4, s: 1.4 },
  { a: 4.4, y: 2.0, s: 1.9 },
  { a: 5.5, y: 3.6, s: 1.5 },
];

/** Nomad fuel-sphere deck slots (model frame). */
const FUEL_SLOTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -4, z: -13 }, { x: 4, z: -13 }, { x: -4, z: -18 }, { x: 4, z: -18 },
];

export class RivalBases {
  // -- source records (queries run on these, never on meshes) -------------------
  private nodes: LunarNode[] = [];
  private craters: Crater[] = [];
  private sites: RivalBaseSite[] = [];

  private readonly prefix: string;
  private readonly perimeterScale: number;
  private readonly wantBeaconLight: boolean;
  private readonly roster: readonly RivalBaseArchetype[];

  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;

  private root: TransformNode | null = null;
  private kits = new Map<string, SiteSceneKit>();
  private meshList: Mesh[] = [];
  private lightList: PointLight[] = [];
  private materials: RivalMaterials | null = null;
  private materialList: PBRMaterial[] = [];
  /** Per-archetype banner materials (accents stay distinct per crew). */
  private bannerMats = new Map<string, PBRMaterial>();

  private beaconBaseIntensity = 14;
  private built = false;
  private disposed = false;

  /**
   * Accepts a `WorldSnapshot` (or anything exposing `nodes` / `craters`).
   * References are held, not cloned — `generate()` already hands out clones.
   */
  constructor(worldSnapshot: WorldSnapshot | RivalBasesSource | null, options: RivalBasesOptions = {}) {
    this.prefix = options.namePrefix ?? DEFAULT_NAME_PREFIX;
    this.perimeterScale = Number.isFinite(options.perimeterScale) && (options.perimeterScale ?? 0) > 0
      ? (options.perimeterScale as number)
      : 1;
    this.wantBeaconLight = options.beaconLight ?? true;
    this.roster = options.roster ?? RIVAL_BASE_ARCHETYPES;
    if (worldSnapshot !== null && worldSnapshot !== undefined) this.load(worldSnapshot);
  }

  // -- data ----------------------------------------------------------------------

  /** Replace the source records and re-plan every rival site. */
  load(source: WorldSnapshot | RivalBasesSource): this {
    this.nodes = Array.isArray(source.nodes) ? [...source.nodes] : [];
    this.craters = Array.isArray(source.craters) ? [...source.craters] : [];
    this.planSites();
    return this;
  }

  /** Static identity of one archetype (null when unknown). */
  getArchetypeDefinition(archetype: string): RivalArchetypeDefinition | null {
    return (ARCHETYPE_DEFS as Record<string, RivalArchetypeDefinition | undefined>)[archetype] ?? null;
  }

  // -- spatial API (world frame, scene-independent) --------------------------------

  /** One rival site by id or archetype (null when absent). */
  getSite(idOrArchetype: string): RivalBaseSite | null {
    return this.sites.find((s) => s.id === idOrArchetype || s.archetype === idOrArchetype) ?? null;
  }

  /** Every planned rival site (read-only view, roster order). */
  getBases(): readonly RivalBaseSite[] {
    return this.sites;
  }

  /**
   * Nearest rival site whose territory contains the world-frame point, or
   * null. `thresholdM` overrides EVERY site's own perimeter (a uniform
   * scanner sweep); omit it and each site is tested against its own
   * `perimeterRadiusM`. Ties resolve to the closest site. Safe before
   * `init()` / after `dispose()`.
   */
  isNearRivalBase(pos: { x: number; y: number }, thresholdM?: number): RivalBaseSite | null {
    if (this.disposed) return null;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
    const override = Number.isFinite(thresholdM) && (thresholdM as number) > 0 ? (thresholdM as number) : null;
    let best: RivalBaseSite | null = null;
    let bestDist = Infinity;
    for (const site of this.sites) {
      const reach = override ?? site.perimeterRadiusM;
      const distance = dist2(pos, site.position);
      if (distance <= reach && distance < bestDist) {
        best = site;
        bestDist = distance;
      }
    }
    return best;
  }

  // -- lifecycle ---------------------------------------------------------------------

  /**
   * Build the ruins. Accepts an existing `Scene`, a raw engine (a scene is
   * created around it), or nothing — falling back to a self-owned
   * `NullEngine`, exactly what CI wants. Idempotent; refuses after `dispose()`.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('RivalBases: init() after dispose()');
    if (this.built) return this;

    if (sceneOrEngine instanceof Scene) {
      this.scene = sceneOrEngine;
    } else if (sceneOrEngine !== null && sceneOrEngine !== undefined) {
      // Bare engine (typically a shared NullEngine): wrap it, never own it.
      this.scene = new Scene(sceneOrEngine);
    } else if (typeof window === 'undefined') {
      const engine = new NullEngine();
      this.ownedEngine = engine;
      this.scene = new Scene(engine);
    } else {
      throw new Error('RivalBases.init: browser needs a Scene or Engine');
    }

    this.root = new TransformNode(`${this.prefix}-system`, this.scene);
    this.materials = this.buildMaterials(this.scene);
    for (const site of this.sites) this.buildSite(site);
    this.built = true;
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /**
   * Animate the ruins: flickering beacon beacons and capacitor sparks. Drive
   * from the world render loop with elapsed seconds. Safe before init /
   * after dispose (no-op).
   */
  update(elapsedSeconds: number): void {
    if (this.materials === null || this.disposed) return;
    if (!Number.isFinite(elapsedSeconds)) return;
    const t = elapsedSeconds;
    // Sawtooth flash with a dark gap, plus jitter on top.
    const phase = t % 1.6;
    const flash = phase < 0.42 ? 1 : 0.12;
    const jitter = 0.85 + 0.15 * Math.sin(t * 31.7);
    const b = flash * jitter;
    this.materials.beacon.emissiveColor.set(1 * b, 0.14 * b, 0.08 * b);
    for (const light of this.lightList) light.intensity = this.beaconBaseIntensity * b;
    // Capacitor sparks: fast irregular crackle; targeting eye: slow dead pulse.
    const crackle = Math.max(0, Math.sin(t * 19.3) * Math.sin(t * 47.9));
    const s = 0.25 + 1.1 * crackle;
    this.materials.spark.emissiveColor.set(0.75 * s, 0.9 * s, 1 * s);
    const tgt = 0.55 + 0.45 * Math.max(0, Math.sin(t * 6.1));
    this.materials.target.emissiveColor.set(1 * tgt, 0.06 * tgt, 0.04 * tgt);
  }

  /** Tear down every site kit, materials, root and any self-owned engine. Never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;

    for (const kit of this.kits.values()) {
      for (const light of kit.lights) RivalBases.disposeQuietly(light);
      for (const mesh of kit.meshes) RivalBases.disposeQuietly(mesh);
      RivalBases.disposeQuietly(kit.root);
    }
    this.kits.clear();
    this.meshList = [];
    this.lightList = [];
    for (const material of this.materialList) RivalBases.disposeQuietly(material);
    this.materialList = [];
    this.materials = null;
    this.bannerMats.clear();
    RivalBases.disposeQuietly(this.root);
    this.root = null;

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) RivalBases.disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- accessors ------------------------------------------------------------------------

  /** System root transform (`rival-base-system`; null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every ruin mesh across all sites (shadow/picking registration). */
  getMeshes(): AbstractMesh[] {
    return [...this.meshList];
  }

  /**
   * Shadow-casting subset of `getMeshes()`: everything except flat ground
   * decals (oil stains, scorch marks) which would smear the shadow map for
   * no visual gain.
   */
  getShadowCasterMeshes(): AbstractMesh[] {
    return this.meshList.filter((m) => {
      const part = m.metadata?.part as string | undefined;
      return part !== 'stain' && part !== 'scorch';
    });
  }

  /** Every beacon PointLight built (nomad rig; [] with `beaconLight: false`). */
  getLights(): PointLight[] {
    return [...this.lightList];
  }

  /** One site's meshes ([] when unknown or not built). */
  getSiteMeshes(idOrArchetype: string): Mesh[] {
    const kit = this.kits.get(idOrArchetype);
    return kit === undefined ? [] : [...kit.meshes];
  }

  /** Site root transform (null before init / after dispose / unknown id). */
  getSiteRoot(idOrArchetype: string): TransformNode | null {
    const kit = this.kits.get(idOrArchetype);
    return kit === undefined ? null : kit.root;
  }

  /**
   * Meshes tagged with a kit part id — 'hub' | 'banner' | 'pylon' | 'razor'
   * | 'socket' | 'depot' | 'casing' | 'shield' | 'scaffold' | 'stack' |
   * 'stain' | 'dome' | 'foam' | 'mast' | 'pod' | 'scorch' | 'tread'
   * | 'excavator' | 'fuel' | 'catwalk' | 'beacon' — optionally within one
   * site. This is how the smoke suite asserts the foundation without
   * name-string archaeology.
   */
  getPartMeshes(part: string, idOrArchetype?: string): Mesh[] {
    const pool: Mesh[] = idOrArchetype === undefined ? this.meshList : this.getSiteMeshes(idOrArchetype);
    return pool.filter((m) => (m.metadata?.part as string | undefined) === part);
  }

  /**
   * Surveyable resource depots / damaged hoppers (Spec 25 §2.4): meshes
   * carrying `{ part: 'depot', surveyable: true, baseId }` metadata for the
   * survey interaction layer.
   */
  getSurveyables(): Mesh[] {
    return this.meshList.filter((m) => m.metadata?.surveyable === true);
  }

  // -- site planning ---------------------------------------------------------------------

  /**
   * Anchor each rival crew deterministically: each archetype takes a free
   * surface host node (kind preference per archetype, rotated start offset
   * for variety), spread as far apart from already-planned sites as the map
   * allows, then the site snaps to the nearest crater's rim circle within
   * tolerance, nose pointed inward over the crater floor.
   */
  private planSites(): void {
    const hosts = this.nodes.filter(isSurfaceHost);
    const planned: RivalBaseSite[] = [];
    const taken = new Set<string>();

    this.roster.forEach((archetypeId, rosterIndex) => {
      const def = this.getArchetypeDefinition(archetypeId);
      if (def === null) return;
      const anchor = RivalBases.pickAnchorNode(def, hosts, taken, planned, rosterIndex);
      if (anchor === null) return;
      taken.add(anchor.id);

      const site = this.snapToCraterRim(anchor);
      // Deterministic per-site jitter (hash of identity): perimeter lands
      // inside 60–90 m, decay within a band of the archetype nominal.
      const h = hashString(`${archetypeId}:${anchor.id}`);
      const perimeter = Math.round(
        Math.min(MAX_PERIMETER_RADIUS_M,
          Math.max(MIN_PERIMETER_RADIUS_M, def.perimeterM * this.perimeterScale + (h % 13) - 6)),
      );
      const decay = clamp01(def.decay + ((h >>> 8) % 17 - 4) / 100);

      planned.push({
        id: `rival-${archetypeId}`,
        archetype: archetypeId,
        name: def.name,
        factionLore: def.factionLore,
        position: site.position,
        heading: site.heading,
        perimeterRadiusM: perimeter,
        decayLevel: decay,
      });
    });
    this.sites = planned;
  }

  /** Best free host node for an archetype: kind preference first, then spread. */
  private static pickAnchorNode(
    def: RivalArchetypeDefinition,
    hosts: LunarNode[],
    taken: Set<string>,
    planned: ReadonlyArray<RivalBaseSite>,
    rosterIndex: number,
  ): LunarNode | null {
    for (const kind of def.preference) {
      const candidates = hosts.filter((n) => n.kind === kind && !taken.has(n.id));
      if (candidates.length === 0) continue;
      if (planned.length === 0) {
        // Rotate the starting candidate per roster slot so the three crews
        // don't all grab the same preference tier's first node.
        return candidates[rosterIndex % candidates.length];
      }
      // Spread: take the candidate maximising its minimum distance to the
      // already-planned sites — deterministic, no RNG, map-scaled separation.
      let best = candidates[0];
      let bestScore = -Infinity;
      for (const c of candidates) {
        let score = Infinity;
        for (const p of planned) score = Math.min(score, dist2(c.position, p.position));
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      return best;
    }
    return hosts.find((n) => !taken.has(n.id)) ?? null;
  }

  /** Snap an anchor to the nearest crater rim circle when within tolerance. */
  private snapToCraterRim(anchor: LunarNode): {
    position: { x: number; y: number; z: number };
    heading: number;
  } {
    let crater: Crater | null = null;
    let bestOffset = Infinity;
    for (const c of this.craters) {
      if (!Number.isFinite(c.radius) || c.radius <= 0) continue;
      const offset = Math.abs(dist2(anchor.position, c.center) - c.radius);
      if (offset < bestOffset) {
        bestOffset = offset;
        crater = c;
      }
    }
    if (crater === null || bestOffset > CRATER_RIM_SNAP_TOL_M) {
      return { position: { ...anchor.position }, heading: 0 };
    }
    const dx = anchor.position.x - crater.center.x;
    const dy = anchor.position.y - crater.center.y;
    const d = Math.hypot(dx, dy);
    const ux = d > 1e-6 ? dx / d : 1;
    const uy = d > 1e-6 ? dy / d : 0;
    return {
      position: {
        x: crater.center.x + ux * crater.radius,
        y: crater.center.y + uy * crater.radius,
        z: anchor.position.z,
      },
      // Nose faces inward over the crater floor.
      heading: Math.atan2(-uy, -ux),
    };
  }

  // -- mesh construction --------------------------------------------------------------------

  /** Vacuum-lunar PBR shorthand; environment stays near zero, nothing to reflect. */
  private static mk(
    name: string,
    scene: Scene,
    albedo: readonly [number, number, number],
    metallic: number,
    roughness: number,
    emissive?: readonly [number, number, number],
    environmentIntensity = 0.05,
  ): PBRMaterial {
    const material = new PBRMaterial(name, scene);
    material.albedoColor = new Color3(albedo[0], albedo[1], albedo[2]);
    material.metallic = metallic;
    material.roughness = roughness;
    if (emissive !== undefined) material.emissiveColor = new Color3(emissive[0], emissive[1], emissive[2]);
    material.environmentIntensity = environmentIntensity;
    return material;
  }

  /** Weathered structural set: rust palettes, cracked glass, sealant, emitters. */
  private buildMaterials(scene: Scene): RivalMaterials {
    const p = `${this.prefix}-`;
    // Cracked pressure glass: hazy, translucent, faint cold glow inside.
    const glass = RivalBases.mk(`${p}glass`, scene, [0.62, 0.78, 0.85], 0.02, 0.3, [0.03, 0.05, 0.06], 0.2);
    glass.alpha = 0.5;

    const materials: RivalMaterials = {
      // Heavy decay palette: oxidised panels and dented plate.
      rust: RivalBases.mk(`${p}rust`, scene, [0.38, 0.16, 0.07], 0.22, 0.94, undefined, 0.03),
      darkRust: RivalBases.mk(`${p}dark-rust`, scene, [0.2, 0.09, 0.06], 0.3, 0.9, undefined, 0.02),
      steel: RivalBases.mk(`${p}steel`, scene, [0.52, 0.53, 0.56], 0.88, 0.44, undefined, 0.08),
      dark: RivalBases.mk(`${p}dark`, scene, [0.1, 0.1, 0.11], 0.45, 0.62, undefined, 0.04),
      glass,
      foam: RivalBases.mk(`${p}sealant`, scene, [0.78, 0.74, 0.52], 0.02, 0.98, undefined, 0.03),
      scorch: RivalBases.mk(`${p}scorch`, scene, [0.04, 0.035, 0.03], 0.05, 1, undefined, 0.01),
      grit: RivalBases.mk(`${p}grit`, scene, [0.23, 0.21, 0.2], 0.02, 0.98, undefined, 0.02),
      // Emergency beacon head: deep red glow (pulsed by `update()`).
      beacon: RivalBases.mk(`${p}beacon`, scene, [0.5, 0.06, 0.04], 0.1, 0.4, [1, 0.14, 0.08], 0.1),
      // Broken capacitor crackle (pulsed by `update()`).
      spark: RivalBases.mk(`${p}spark`, scene, [0.3, 0.35, 0.4], 0.2, 0.4, [0.75, 0.9, 1], 0.1),
      // Dead-red targeting indicator (pulsed by `update()`).
      target: RivalBases.mk(`${p}target`, scene, [0.4, 0.04, 0.03], 0.1, 0.5, [1, 0.06, 0.04], 0.1),
    };
    this.materialList = Object.values(materials);
    return materials;
  }

  /** Build one site's kit under the system root and register its meshes. */
  private buildSite(info: RivalBaseSite): void {
    const scene = this.scene as Scene;
    const mats = this.materials as RivalMaterials;

    const root = new TransformNode(`${this.prefix}-${info.archetype}`, scene);
    const b = worldToBabylon(info.position);
    root.position.set(b.x, b.y, b.z);
    root.rotation.y = Math.PI / 2 + info.heading; // shared heading convention
    root.computeWorldMatrix(true);

    const kit: SiteSceneKit = { root, meshes: [], lights: [] };
    const tag = info.archetype;
    const track = (mesh: Mesh, part: string): Mesh => {
      mesh.parent = root;
      mesh.isPickable = true;
      mesh.receiveShadows = false;
      mesh.metadata = { rivalBaseId: info.id, archetype: info.archetype, part };
      kit.meshes.push(mesh);
      return mesh;
    };
    const k: KitBuilder = {
      root: () => root,
      adopt: track,
      box: (n, part, w, h, d, x, y, z, mat) => {
        const m = MeshBuilder.CreateBox(`${this.prefix}-${n}-${tag}`, { width: w, height: h, depth: d }, scene);
        m.position.set(x, y, z);
        m.material = mat;
        return track(m, part);
      },
      cyl: (n, part, dTop, dBottom, h, x, y, z, mat, tess = 16) => {
        const m = MeshBuilder.CreateCylinder(`${this.prefix}-${n}-${tag}`,
          { diameterTop: dTop, diameterBottom: dBottom, height: h, tessellation: tess }, scene);
        m.position.set(x, y, z);
        m.material = mat;
        return track(m, part);
      },
      sph: (n, part, diameter, x, y, z, mat, segments = 12, slice) => {
        const m = MeshBuilder.CreateSphere(`${this.prefix}-${n}-${tag}`, { diameter, segments, slice }, scene);
        m.position.set(x, y, z);
        m.material = mat;
        return track(m, part);
      },
      torus: (n, part, diameter, thickness, x, y, z, mat) => {
        const m = MeshBuilder.CreateTorus(`${this.prefix}-${n}-${tag}`, { diameter, thickness, tessellation: 24 }, scene);
        m.position.set(x, y, z);
        m.material = mat;
        return track(m, part);
      },
      merged: (n, part, sources, mat) => {
        const m = RivalBases.mergeInto(`${this.prefix}-${n}-${tag}`, sources, scene);
        m.material = mat;
        return track(m, part);
      },
      strut: (n, part, x1, y1, z1, x2, y2, z2, diameter, mat) => {
        const m = RivalBases.makeStrut(`${this.prefix}-${n}-${tag}`,
          { x: x1, y: y1, z: z1 }, { x: x2, y: y2, z: z2 }, diameter, scene);
        m.material = mat;
        return track(m, part);
      },
    };

    // Ground grime: the ruin darkens the regolith under its footprint.
    k.sph(`${tag}-site-stain`, 'stain', info.perimeterRadiusM * 0.28, 0, -0.06, 0, mats.darkRust, 8, 0.4);

    switch (info.archetype) {
      case 'scrapper_fortress':
        this.buildScrapperFortress(mats, k);
        break;
      case 'corporate_enclave':
        this.buildCorporateEnclave(scene, mats, k);
        break;
      case 'nomad_rig':
        this.buildNomadRig(info, scene, mats, k, kit);
        break;
    }

    this.buildTerritoryFoundation(info, mats, k);

    this.kits.set(info.archetype, kit);
    this.meshList.push(...kit.meshes);
    this.lightList.push(...kit.lights);
  }

  // -- shared clash-ready foundation (Spec 25 §2.4) --------------------------------------

  /**
   * Perimeter pylons + razor-wire rings, core command hub with faction
   * banner, 2–4 damaged railgun sockets, surveyable depots / hoppers.
   */
  private buildTerritoryFoundation(
    info: RivalBaseSite,
    mats: RivalMaterials,
    k: KitBuilder,
  ): void {
    // The pylons mark the territory line at exactly `perimeterRadiusM`.
    const r = info.perimeterRadiusM;
    const g = GEO.pylon;
    const standing = Math.max(4, Math.round(g.count * (1 - info.decayLevel * 0.35)));
    const hash = hashString(info.id);

    // Decaying boundary pylons: full, leaning, or crumbled stubs.
    for (let i = 0; i < g.count; i++) {
      const angle = (i / g.count) * Math.PI * 2;
      const px = Math.cos(angle) * r;
      const pz = Math.sin(angle) * r;
      const fate = (hash + i * 977) % 10;
      if (i >= standing) {
        // Crumbled: a low broken stump where the boundary used to stand.
        k.cyl(`pylon-stub-${i}`, 'pylon', g.diameter * 0.9, g.diameter, g.height * 0.22,
          px, g.height * 0.11, pz, mats.darkRust, 8);
        continue;
      }
      if (fate < 3) {
        // Leaning pylon, listing off its corroded footing.
        const pylon = k.cyl(`pylon-${i}`, 'pylon', g.diameter * 0.85, g.diameter, g.height * 0.8,
          px, g.height * 0.4, pz, mats.rust, 8);
        pylon.rotation.x = 0.16;
        pylon.rotation.z = fate % 2 === 0 ? 0.12 : -0.12;
        continue;
      }
      k.cyl(`pylon-${i}`, 'pylon', g.diameter * 0.85, g.diameter, g.height, px, g.height / 2, pz, mats.rust, 8);
      if (fate >= 8) {
        // Intact pylon keeps its razor-wire insulator cap.
        k.sph(`pylon-cap-${i}`, 'pylon', g.diameter * 1.4, px, g.height + 0.1, pz, mats.dark, 6);
      }
    }

    // Razor-wire rings: three thin strands at increasing height, sag implied
    // by slightly varied diameters.
    for (const wy of g.wireHeights) {
      const sag = 1 + (wy % 0.7) * 0.004;
      k.torus(`razor-${wy}`, 'razor', r * 2 * sag, 0.06, 0, wy, 0, mats.dark);
    }

    // Core command hub holding the faction banner.
    const h = GEO.hub;
    k.cyl('hub', 'hub', h.diameter, h.diameter * 1.05, h.height, 0, h.height / 2, 0, mats.steel, 18);
    k.cyl('hub-cap', 'hub', h.diameter * 0.4, h.diameter, 1.0, 0, h.height + 0.5, 0, mats.rust, 18);
    k.box('hub-door', 'hub', 1.8, 2.6, 0.5, 0, 1.3, h.diameter / 2 + 0.1, mats.dark);
    // Banner pole + cloth carrying this crew's colours.
    const bannerMat = this.getOrCreateBannerMat(info, mats);
    k.cyl('banner-pole', 'banner', h.poleDiameter, h.poleDiameter, h.poleHeight,
      h.diameter / 2 - 0.4, h.poleHeight / 2, 0, mats.steel, 8);
    const cloth = k.box('banner-cloth', 'banner', h.cloth.w, h.cloth.h, h.cloth.ribDepth,
      h.diameter / 2 - 0.4 + h.cloth.w / 2, h.poleHeight - h.cloth.h / 2 - 0.3, 0, bannerMat);
    cloth.rotation.y = Math.PI / 2;
    cloth.rotation.z = 0.06; // torn and sagging

    // Damaged point-defense railgun sockets (2–4 per base by decay).
    const socketCount = Math.max(2, Math.min(GEO.socket.count, 4 - Math.round(info.decayLevel * 2)));
    for (let i = 0; i < socketCount; i++) {
      const bearing = SOCKET_BEARINGS[i % SOCKET_BEARINGS.length];
      const sx = Math.cos(bearing) * r * 0.82;
      const sz = Math.sin(bearing) * r * 0.82;
      this.buildRailgunSocket(k, mats, i, sx, sz);
    }

    // Resource depots / damaged hoppers (surveyable — tagged inside
    // `buildHopper` so funnel and spout share one survey handle).
    for (let i = 0; i < DEPOT_SLOTS.length; i++) {
      const slot = DEPOT_SLOTS[i];
      const hopper = this.buildHopper(k, mats, info, i);
      hopper.position.set(slot.x, GEO.hopper.height / 2, slot.z);
      hopper.rotation.y = slot.yaw;
      hopper.rotation.z = slot.slump; // slumped off its legs
    }
  }

  /** One damaged railgun mount: pad, tilted cradle, broken barrel, live capacitor. */
  private buildRailgunSocket(
    k: KitBuilder,
    mats: RivalMaterials,
    index: number,
    x: number,
    z: number,
  ): void {
    const s = GEO.socket;
    k.cyl(`socket-pad-${index}`, 'socket', s.baseDiameter, s.baseDiameter * 1.12, s.baseHeight,
      x, s.baseHeight / 2, z, mats.darkRust, 12);
    const yoke = k.cyl(`socket-yoke-${index}`, 'socket', s.yokeDiameter, s.yokeDiameter, s.yokeHeight,
      x, s.baseHeight + s.yokeHeight / 2, z, mats.rust, 10);
    yoke.rotation.z = 0.13; // jammed elevation axis, listing
    // Barrel snapped mid-length: the mount still points, the gun does not.
    const barrel = k.cyl(`socket-barrel-${index}`, 'socket', s.barrelDiameter * 1.15, s.barrelDiameter,
      s.barrelLength, x, s.baseHeight + s.yokeHeight + 0.35, z + s.barrelLength / 2, mats.steel, 10);
    barrel.rotation.x = -0.18;
    // Broken capacitor box with a live spark crackle + dead-red target eye.
    k.box(`socket-cap-${index}`, 'socket', s.capacitor.w, s.capacitor.h, s.capacitor.d,
      x - s.yokeDiameter, s.baseHeight + s.capacitor.h / 2 + 0.15, z, mats.dark);
    k.sph(`socket-spark-${index}`, 'socket', s.spark, x - s.yokeDiameter,
      s.baseHeight + s.capacitor.h + 0.2, z, mats.spark, 6);
    k.sph(`socket-target-${index}`, 'socket', s.indicator, x, s.baseHeight + s.yokeHeight + 0.9, z - 0.2, mats.target, 6);
  }

  /** Damaged ore hopper: funnel, bent legs, jammed discharge spout. */
  private buildHopper(
    k: KitBuilder,
    mats: RivalMaterials,
    info: RivalBaseSite,
    index: number,
  ): Mesh {
    const scene = this.scene as Scene;
    const g = GEO.hopper;
    const parts: Mesh[] = [];
    for (const sx of [1, -1]) {
      const leg = MeshBuilder.CreateCylinder(`hopper-leg-src-${info.archetype}-${index}-${sx > 0 ? 'a' : 'b'}`,
        { diameter: 0.22, height: g.height, tessellation: 6 }, scene);
      leg.position.set(sx * g.bottomDiameter * 0.6, g.height / 2, 0);
      leg.rotation.z = sx * 0.08; // one leg bent
      parts.push(leg);
    }
    const funnel = MeshBuilder.CreateCylinder(`hopper-funnel-src-${info.archetype}-${index}`,
      { diameterTop: g.topDiameter, diameterBottom: g.bottomDiameter, height: g.height * 0.72, tessellation: 12 },
      scene);
    funnel.position.set(0, g.height * 0.78, 0);
    parts.push(funnel);
    const hopper = k.merged(`depot-hopper-${index}`, 'depot', parts, mats.rust);
    // Jammed spout stays a separate mesh (needs its own rotation).
    const spout = k.cyl(`depot-spout-${index}`, 'depot', 0.5, 0.42, g.spoutLength, 0.4, g.height * 0.55, 0, mats.steel, 10);
    spout.rotation.z = -0.55;
    // Whole depot (funnel + spout) is surveyable for the interaction layer.
    const surveyTag = { surveyable: true, depotIndex: index };
    hopper.metadata = { ...(hopper.metadata as Record<string, unknown>), ...surveyTag };
    spout.metadata = { ...(spout.metadata as Record<string, unknown>), ...surveyTag };
    return hopper;
  }

  // -- archetype kits ----------------------------------------------------------------------

  /** Brutalist scrap redoubt: casings, blast shields, scaffold, stacks, wire. */
  private buildScrapperFortress(mats: RivalMaterials, k: KitBuilder): void {
    const scene = this.scene as Scene;
    const g = GEO.scrapper;

    // Welded rocket-casing segments on support saddles (nose cap per casing),
    // lying on their sides, dented and leaning per slot.
    SCRAP_CASING_SLOTS.forEach((slot, i) => {
      const midY = g.casing.saddleHeight + g.casing.diameter / 2;
      const casing = k.cyl(`casing-${i}`, 'casing', g.casing.diameter * 0.9, g.casing.diameter,
        g.casing.length, slot.x, midY, slot.z, mats.rust, 16);
      casing.rotation.z = Math.PI / 2; // lying on its side
      casing.rotation.y = slot.yaw;
      k.cyl(`casing-saddle-${i}`, 'casing', 0.9, 1.2, g.casing.saddleHeight,
        slot.x, g.casing.saddleHeight / 2, slot.z, mats.darkRust, 8);
      const nose = k.sph(`casing-nose-${i}`, 'casing', g.casing.diameter * 0.9,
        slot.x + Math.cos(slot.yaw) * g.casing.length / 2, midY,
        slot.z + Math.sin(slot.yaw) * g.casing.length / 2, mats.dark, 8, 0.5);
      nose.rotation.y = slot.yaw;
    });

    // Corrugated blast shields: shell + transverse ribs merged into one
    // weathered mesh per unit, leaning off their anchors.
    SCRAP_SHIELD_SLOTS.forEach((slot, i) => {
      const parts: Mesh[] = [MeshBuilder.CreateBox(`shield-src-${i}`,
        { width: g.shield.width, height: g.shield.height, depth: g.shield.thickness }, scene)];
      for (let rib = 1; rib < g.shield.ribCount; rib++) {
        const x = (rib / g.shield.ribCount) * g.shield.width - g.shield.width / 2;
        const ribber = MeshBuilder.CreateBox(`shield-rib-src-${i}-${rib}`,
          { width: g.shield.ribDepth, height: g.shield.height * 0.94, depth: g.shield.thickness + 0.16 }, scene);
        ribber.position.set(x, 0, 0); // corrugation band proud of both faces
        parts.push(ribber);
      }
      const shield = k.merged(`shield-${i}`, 'shield', parts, i % 2 === 0 ? mats.rust : mats.darkRust);
      shield.position.set(slot.x, g.shield.height / 2, slot.z);
      shield.rotation.y = slot.yaw;
      shield.rotation.z = slot.lean; // leaning scaffolding holds it up ... barely
      // Support scaffold: three legs merged, same lean.
      const legs: Mesh[] = [];
      for (const [dx, sz] of [[-1, -1], [1, -1], [0, 1]] as const) {
        const leg = MeshBuilder.CreateCylinder(`scaffold-leg-src-${i}-${dx}-${sz}`,
          { diameter: g.scaffold.legDiameter, height: g.scaffold.height * 0.9, tessellation: 6 }, scene);
        leg.position.set(dx * g.scaffold.legOffset, g.scaffold.height * 0.45, sz * g.scaffold.legOffset);
        legs.push(leg);
      }
      const scaffold = k.merged(`scaffold-${i}`, 'scaffold', legs, mats.steel);
      scaffold.position.set(slot.x, 0, slot.z);
      scaffold.rotation.y = slot.yaw;
      scaffold.rotation.z = slot.lean * 0.8;
    });

    // Exhaust stacks: twin rusted pipes, one fouled with soot.
    k.cyl('stack-a', 'stack', g.stack.diameter, g.stack.diameter * 1.1, g.stack.height,
      2.2, g.stack.height / 2, -2.4, mats.darkRust, 12);
    const stackB = k.cyl('stack-b', 'stack', g.stack.diameter * 0.9, g.stack.diameter, g.stack.height * 0.86,
      -2.6, g.stack.height * 0.43, -2.8, mats.rust, 12);
    stackB.rotation.x = 0.07; // leaning, soot-blackened top
    k.sph('stack-b-foul', 'stack', g.stack.diameter * 1.3, -2.6, g.stack.height * 0.86, -2.8, mats.scorch, 6);

    // Oil stains: flattened dark pancakes under the machinery.
    k.sph('oil-stain-1', 'stain', g.stain.diameter, 1.5, -0.04, 2.0, mats.scorch, 8, 0.4);
    k.sph('oil-stain-2', 'stain', g.stain.diameter * 0.7, -3.5, -0.04, -4.5, mats.darkRust, 8, 0.4);
  }

  /** Former high-tech station: cracked dome + sealant foam, mast, pods, scorch. */
  private buildCorporateEnclave(scene: Scene, mats: RivalMaterials, k: KitBuilder): void {
    void scene;
    const d = GEO.corporate.dome;

    // Pressure shell: cracked geodesic-style glass hemisphere on a ring beam
    // with a habitable inner module — the enclave's old pride, now hazed.
    k.sph('dome', 'dome', d.diameter, 0, 0, d.z, mats.glass, d.segments, 0.5);
    k.torus('dome-ring', 'dome', d.ringDiameter, d.ringThickness, 0, d.ringY, d.z, mats.steel);
    k.sph('dome-inner', 'dome', d.innerDiameter, 0, 0.1, d.z, mats.dark, 8, 0.5);
    k.box('dome-airlock', 'dome', 2.0, 2.3, 2.8, 0, 1.15, d.z + d.diameter / 2 - 0.6, mats.steel);

    // Emergency sealant foam: pale blobs smeared across the fracture lines
    // of the pressure shell (placed on the dome surface, dome-centre local).
    FOAM_PATCHES.forEach((patch, i) => {
      const rr = d.diameter / 2 - patch.s * 0.25;
      const ringR = Math.sqrt(Math.max(0.01, rr * rr - patch.y * patch.y));
      k.sph(`foam-${i}`, 'foam', patch.s,
        Math.cos(patch.a) * ringR, patch.y, d.z + Math.sin(patch.a) * ringR, mats.foam, 6);
    });

    // Tilted dish mast on guy wires — comms array nobody steers any more.
    const m = GEO.corporate.mast;
    const mast = k.cyl('mast', 'mast', m.diameter, m.diameter * 1.25, m.height, m.x, m.height / 2, m.z, mats.steel, 10);
    mast.rotation.z = m.tilt; // permanently tilted
    // Mast top after the tilt rotation about its base.
    const topX = m.x + Math.sin(m.tilt) * m.height;
    const topY = Math.cos(m.tilt) * m.height;
    const dish = k.sph('mast-dish', 'mast', m.dishDiameter, topX, topY + 0.6, m.z, mats.dark, 12, m.capSlice);
    dish.rotation.x = -0.4;
    for (let i = 0; i < m.guyAnchors; i++) {
      const a = (i / m.guyAnchors) * Math.PI * 2 + 0.6;
      k.strut(`mast-guy-${i}`, 'mast', topX * 0.94, topY * 0.94, m.z,
        m.x + Math.cos(a) * m.guyRadius, 0.15, m.z + Math.sin(a) * m.guyRadius, m.guyDiameter, mats.dark);
    }

    // Executive habitat pods: stretched capsule shells, one dark and breached.
    const pod = GEO.corporate.pod;
    CORP_POD_SLOTS.forEach((slot, i) => {
      const shell = k.sph(`pod-${i}`, 'pod', pod.diameter, slot.x, pod.diameter / 2 + 0.15, slot.z,
        i === 1 ? mats.darkRust : mats.steel, 10);
      shell.scaling.set(1, 1, pod.length / pod.diameter); // capsule stretch along nose
      shell.rotation.y = slot.yaw;
      // Umbilical link back toward the hub.
      const linkDepth = Math.max(1, dist2({ x: slot.x, y: slot.z }, { x: 0, y: 0 }) * 0.28);
      k.box(`pod-link-${i}`, 'pod', pod.linkWidth, 0.6, linkDepth, slot.x * 0.62, 1.1, slot.z * 0.62, mats.rust);
    });

    // Scorch marks: whatever blew, burned, and was never cleaned up.
    k.sph('scorch-1', 'scorch', 6.5, 6.0, -0.05, 8.5, mats.scorch, 8, 0.4);
    k.sph('scorch-2', 'scorch', 4.2, -5.0, -0.04, 9.5, mats.scorch, 8, 0.4);
  }

  /** Grounded mega-crawler: treads, excavator arm, fuel spheres, catwalks, beacon. */
  private buildNomadRig(
    info: RivalBaseSite,
    scene: Scene,
    mats: RivalMaterials,
    k: KitBuilder,
    kit: SiteSceneKit,
  ): void {
    const g = GEO.nomad;

    // Chassis deck: the plant's spine, grounded forever.
    k.box('chassis', 'tread', g.chassis.width, g.chassis.height, g.chassis.length,
      0, g.chassis.deckY + g.chassis.height / 2, g.chassis.z, mats.rust);
    k.box('superstructure', 'tread', g.chassis.width * 0.7, 3.4, g.chassis.length * 0.45,
      0, g.chassis.deckY + g.chassis.height + 1.7, g.chassis.z - 8, mats.darkRust);

    // Multi-track tread assemblies: three bogies per side, each a track box
    // with wheel discs merged in.
    for (let side = 0; side < 2; side++) {
      const sx = side === 0 ? 1 : -1;
      const trackX = sx * (g.chassis.width / 2 + g.tread.width / 2 - 0.4);
      for (let b = 0; b < 3; b++) {
        const tz = -g.chassis.length / 2 + 2 + b * 10;
        const track = k.box(`tread-${side}-${b}`, 'tread', g.tread.width, g.tread.height, g.tread.length,
          trackX, g.tread.height / 2 + 0.1, tz, mats.dark);
        if (b === 1 && side === 0) {
          track.rotation.z = 0.04; // the one that threw a gear
        }
        const wheels: Mesh[] = [];
        for (let w = 0; w < g.tread.wheelCount; w++) {
          const wheel = MeshBuilder.CreateCylinder(`tread-wheel-src-${side}-${b}-${w}`,
            { diameter: g.tread.wheelDiameter, height: g.tread.width + 0.1, tessellation: 12 }, scene);
          wheel.position.set(0, 0, (w - (g.tread.wheelCount - 1) / 2) * (g.tread.length / g.tread.wheelCount) * 1.3);
          wheel.rotation.z = Math.PI / 2;
          wheels.push(wheel);
        }
        const wheelMesh = k.merged(`tread-wheels-${side}-${b}`, 'tread', wheels, mats.rust);
        wheelMesh.position.set(trackX, g.tread.height / 2 + 0.1, tz);
      }
    }

    // Heavy rotary excavator arm: boom rises nose-ward from the deck, stick
    // drops from its end, bucket wheel half-buried — the dig it never finished.
    const pivot = { x: 0, y: g.chassis.deckY + g.chassis.height + 1.2, z: 6 };
    const boomEnd = { x: pivot.x, y: pivot.y + g.boom.rise, z: pivot.z + g.boom.run };
    const stickEnd = { x: 2.5, y: 0.6, z: boomEnd.z + 3.5 };
    k.strut('excavator-boom', 'excavator', pivot.x, pivot.y, pivot.z,
      boomEnd.x, boomEnd.y, boomEnd.z, g.boom.width * 1.6, mats.steel);
    k.strut('excavator-stick', 'excavator', boomEnd.x, boomEnd.y, boomEnd.z,
      stickEnd.x, stickEnd.y, stickEnd.z, g.stick.width, mats.rust);
    const teeth: Mesh[] = [];
    for (let i = 0; i < g.wheel.teeth; i++) {
      const a = (i / g.wheel.teeth) * Math.PI * 2;
      const tooth = MeshBuilder.CreateBox(`bucket-tooth-src-${i}`,
        { width: 0.4, height: 0.8, depth: g.wheel.thickness * 0.9 }, scene);
      tooth.position.set(0, Math.cos(a) * g.wheel.diameter / 2, Math.sin(a) * g.wheel.diameter / 2);
      tooth.rotation.x = a;
      teeth.push(tooth);
    }
    const wheelBody = MeshBuilder.CreateCylinder('bucket-body-src',
      { diameter: g.wheel.diameter, height: g.wheel.thickness, tessellation: 16 }, scene);
    wheelBody.rotation.z = Math.PI / 2;
    teeth.push(wheelBody);
    const bucket = k.merged('excavator-bucket', 'excavator', teeth, mats.darkRust);
    bucket.position.set(stickEnd.x, stickEnd.y + 0.4, stickEnd.z);
    bucket.rotation.y = 0.4;

    // Fuel storage spheres: rusted orbs on the aft deck.
    FUEL_SLOTS.forEach((slot, i) => {
      k.sph(`fuel-${i}`, 'fuel', g.fuel.diameter, slot.x, g.fuel.diameter / 2 + 0.2, slot.z,
        i % 2 === 0 ? mats.rust : mats.darkRust, 10);
      k.cyl(`fuel-legs-${i}`, 'fuel', 0.5, 0.7, 0.2, slot.x, 0.1, slot.z, mats.dark, 8);
    });

    // Rusted catwalks along the starboard flank with stub railings.
    for (let i = 0; i < 3; i++) {
      const cz = -16 + i * g.catwalk.length;
      const walkX = g.chassis.width / 2 + g.catwalk.width / 2 + 0.2;
      k.box(`catwalk-${i}`, 'catwalk', g.catwalk.width, g.catwalk.thickness, g.catwalk.length,
        walkX, g.chassis.deckY + 0.3, cz + g.catwalk.length / 2, mats.rust);
      k.box(`catwalk-rail-${i}`, 'catwalk', 0.1, g.catwalk.railHeight, g.catwalk.length,
        walkX + g.catwalk.width / 2 + 0.05, g.chassis.deckY + 0.3 + g.catwalk.railHeight / 2,
        cz + g.catwalk.length / 2, mats.steel);
    }

    // Flickering emergency beacon: mast, deep-red head, real PointLight.
    const beaconY = g.chassis.deckY + g.chassis.height + g.beacon.mastHeight;
    k.cyl('beacon-mast', 'beacon', g.beacon.mastDiameter, g.beacon.mastDiameter, g.beacon.mastHeight,
      g.beacon.x, g.chassis.deckY + g.chassis.height + g.beacon.mastHeight / 2, g.beacon.z, mats.steel, 8);
    k.sph('beacon-head', 'beacon', g.beacon.headDiameter, g.beacon.x, beaconY, g.beacon.z, mats.beacon, 8);

    if (this.wantBeaconLight) {
      // World position runs through the same heading rotation the parent uses
      // (model +z = nose), so light and head cannot drift apart.
      const c = Math.cos(info.heading);
      const s = Math.sin(info.heading);
      const wx = info.position.x + (g.beacon.x * c - g.beacon.z * s);
      const wy = info.position.y + (g.beacon.x * s + g.beacon.z * c);
      const light = new PointLight(
        `${this.prefix}-beacon-light`,
        worldToBabylon({ x: wx, y: wy, z: beaconY }),
        scene,
      );
      light.diffuse = new Color3(1, 0.25, 0.12);
      light.range = 46;
      light.intensity = this.beaconBaseIntensity;
      light.metadata = { rivalBaseId: info.id, archetype: info.archetype, part: 'beacon' };
      kit.lights.push(light);
    }
  }

  // -- helpers --------------------------------------------------------------------------------

  /** Per-archetype banner material (built lazily so accents stay distinct). */
  private getOrCreateBannerMat(info: RivalBaseSite, mats: RivalMaterials): PBRMaterial {
    const existing = this.bannerMats.get(info.archetype);
    if (existing !== undefined) return existing;
    const def = this.getArchetypeDefinition(info.archetype);
    if (def === null) return mats.dark;
    const mat = RivalBases.mk(`${this.prefix}-banner-${info.archetype}`, this.scene as Scene,
      def.accent, 0.05, 0.9, undefined, 0.06);
    this.bannerMats.set(info.archetype, mat);
    this.materialList.push(mat);
    return mat;
  }

  /** Straight cylinder between two model-frame points (guy wires, struts). */
  private static makeStrut(
    name: string,
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    diameter: number,
    scene: Scene,
  ): Mesh {
    const dir = new Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
    const length = dir.length();
    const mesh = MeshBuilder.CreateCylinder(name,
      { diameter, height: Math.max(0.05, length), tessellation: 6 }, scene);
    mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    if (length > 1e-6) {
      // Cylinder's local +y must lie along the strut direction: rotate the
      // shortest arc from +y to dir about the axis perpendicular to both.
      dir.scaleInPlace(1 / length);
      const axis = Vector3.Cross(Vector3.UpReadOnly, dir);
      const angle = Math.acos(Math.min(1, Math.max(-1, dir.y)));
      if (axis.lengthSquared() > 1e-12) {
        mesh.rotate(axis.normalizeToNew() as Vector3, angle);
      }
    }
    return mesh;
  }

  /** Merge primitives, tolerating a refused merge (sources always cleaned). */
  private static mergeInto(name: string, parts: Mesh[], scene: Scene): Mesh {
    const merged = Mesh.MergeMeshes(parts, true, true);
    if (merged !== null) {
      merged.name = name;
      return merged;
    }
    // Merge refused (degenerate source): keep one primitive, drop the rest.
    const survivor = parts[0] ?? MeshBuilder.CreateBox(`${name}-stub`, { size: 0.1 }, scene);
    survivor.name = name;
    for (const extra of parts.slice(1)) RivalBases.disposeQuietly(extra);
    return survivor;
  }

  private static disposeQuietly(target: { dispose: () => unknown } | null): void {
    if (target === null) return;
    try {
      target.dispose();
    } catch {
      // Node already gone or engine torn down first — never propagate.
    }
  }
}

export default RivalBases;
