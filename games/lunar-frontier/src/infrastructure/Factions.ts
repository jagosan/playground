/**
 * Lunar Frontier — faction base architecture: nation-state domes vs scrappy
 * startup outposts (TASK-PLAY-050).
 *
 * Dresses the EXISTING world generator output (`LunarWorldGenerator` →
 * `WorldSnapshot`) in four faction forward bases anchored on surface crater
 * rims / sector nodes. No world-gen logic lives here: nodes, craters and
 * veins are consumed verbatim as `LunarNode` / `Crater` / `ResourceVein`
 * records and every spatial query runs on that source data, so it answers
 * before `init()`, after `dispose()`, and with no scene at all.
 *
 * Faction asymmetry (procedural only, no GLB):
 *  - Nation-states ARTEMIS + POLAR_STAR get pressurised infrastructure: a
 *    geodesic-style pressurised dome (high-spec dielectric glass PBR shell on
 *    a structural ring beam + habitable inner module + airlock), a
 *    communications radar dish (shallow parabolic cap + rim ring + feed
 *    horn), an automated sorting silo (drum + hopper cap + discharge chute)
 *    and a nuclear kilopower reactor (shielded core + radial radiator fin
 *    array dumping the kilowatts to space).
 *  - Startups HELIOS + RUSTBELT get bolted-together kit: stacks of
 *    corrugated shipping containers (weathered rust / hazard-orange /
 *    blue-paint PBR, ribs merged into each shell), lattice floodlight towers
 *    carrying real `SpotLight` lamps, a diesel/solar auxiliary power skid
 *    (frame + genset + fuel tank + tilted photovoltaic array) and a fenced
 *    excavation perimeter around a dug test pit with a spoil heap.
 *
 * Coordinates: world metres (x, y lateral, z up) map to Babylon (x, z↑, -y)
 * via the shared `worldToBabylon` from CameraRig — bases, camera, rails and
 * physics cannot disagree about where a claim sits. Each base root sits ON
 * its site point with model frame +z = nose (heading radians in the x-y
 * plane, 0 = +x → Babylon yaw `PI/2 + heading`, the OpenBuggy convention).
 *
 * Headless-safe: `init()` accepts a Scene, a raw engine (a scene is created
 * around it), or nothing (self-owned NullEngine fallback). `dispose()` is
 * idempotent and never throws; after disposal every query answers
 * empty/null and `init()` refuses with a clear error.
 *
 * Usage:
 *   const world = new LunarWorldGenerator('mala-voyage-2431').generate();
 *   const factions = new FactionBases(world).init(scene);
 *   if (factions.isNearBase(prospectorPos)) raiseTheAlarm();
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';

import { worldToBabylon } from '../engine/CameraRig.ts';
import type {
  Crater,
  LunarNode,
  ResourceKind,
  ResourceVein,
  Vec3,
  WorldSnapshot,
} from '../world/LunarWorldGenerator.ts';

// -- canonical factions --------------------------------------------------------

/** Faction allegiance class — decides which kit table a base is issued. */
export type FactionAllegiance = 'nation-state' | 'startup';

export type FactionId = 'ARTEMIS' | 'POLAR_STAR' | 'HELIOS' | 'RUSTBELT';

/** Canonical roster, in planning order. */
export const FACTION_IDS: readonly FactionId[] = ['ARTEMIS', 'POLAR_STAR', 'HELIOS', 'RUSTBELT'];

/** Static identity of one faction (lore, kit class, signature colours). */
export interface FactionDefinition {
  id: FactionId;
  name: string;
  allegiance: FactionAllegiance;
  /** Resource this faction's crews prioritise (claim-board filter). */
  focusKind: ResourceKind;
  /** Signature trim colour (linear RGB 0..1). */
  accent: [number, number, number];
  /** Perimeter radius of the works (m) — the `isNearBase` default reach. */
  perimeterM: number;
  lore: string;
}

export const FACTION_DEFS: Record<FactionId, FactionDefinition> = {
  ARTEMIS: {
    id: 'ARTEMIS', name: 'Artemis Coalition', allegiance: 'nation-state', focusKind: 'titanium',
    accent: [0.42, 0.56, 0.86], perimeterM: 42,
    lore: 'Treaty charter, triple-redundant airlocks and a hull-plating habit.',
  },
  POLAR_STAR: {
    id: 'POLAR_STAR', name: 'Polar Star', allegiance: 'nation-state', focusKind: 'water_ice',
    accent: [0.44, 0.78, 0.84], perimeterM: 42,
    lore: 'Permanent polar programme. Ice is oxygen, water and rocket fuel.',
  },
  HELIOS: {
    id: 'HELIOS', name: 'Helios Extraction', allegiance: 'startup', focusKind: 'helium_3',
    accent: [0.88, 0.48, 0.12], perimeterM: 30,
    lore: 'Seed round closed, He-3 seam claimed, safety review pending.',
  },
  RUSTBELT: {
    id: 'RUSTBELT', name: 'RustBelt Dockworks', allegiance: 'startup', focusKind: 'rare_earth',
    accent: [0.52, 0.21, 0.09], perimeterM: 30,
    lore: 'Two tugs, one breaker mech and a very optimistic KREEP assay.',
  },
};

/** Root/material name prefix when none is supplied (mesh families are fixed). */
export const DEFAULT_NAME_PREFIX = 'faction';
/** Floodlight intensity on startup lattice towers. */
export const FLOODLIGHT_INTENSITY = 6.5;
/** Floodlight cone full angle, degrees. */
export const FLOODLIGHT_ANGLE_DEG = 96;
/** Floodlight beam range, metres. */
export const FLOODLIGHT_RANGE_M = 58;
/** A node farther from a crater's rim circle than this is not a rim site. */
export const CRATER_RIM_SNAP_TOL_M = 1_200;

// -- geometry (metres; model frame: +z nose, +x left, +y up) --------------------

const GEO = {
  pad: { diameter: 40, height: 0.4 },
  dome: { x: -4.5, z: -1.5, diameter: 18.5, segments: 12, innerDiameter: 13,
    ringDiameter: 19.4, ringThickness: 1.5, ringY: 0.55, airlockZ: 8.6 },
  dish: { x: 9.5, z: 4.4, diameter: 9.5, capSlice: 0.22, mastHeight: 5.6, hornDiameter: 0.55, tilt: -0.62 },
  silo: { x: 8.4, z: -6.8, diameter: 5.2, height: 12.5, capHeight: 2.8,
    chute: { width: 0.9, height: 0.7, depth: 4.2, pitch: 0.34 } },
  reactor: { x: 14.5, z: 12.5, coreDiameter: 4.4, coreHeight: 6.2, shieldDiameter: 6.4,
    finCount: 8, finLength: 5.6, finWidth: 1.9, finThickness: 0.2 },
  container: { width: 2.7, height: 2.8, depth: 6.2, ribCount: 6, ribDepth: 0.16 },
  tower: { height: 11.5, legOffset: 0.95, legDiameter: 0.24, braceLevels: 4,
    head: { width: 1.7, height: 0.5, depth: 0.9, pitch: 0.5 } },
  skid: { x: -13.5, z: 6.5, frame: { width: 4.2, height: 0.35, depth: 7.6 },
    genset: { diameter: 1.7, length: 3.1, z: 4.4 }, tank: { diameter: 1.4, height: 2.2, z: 8.6 },
    panel: { width: 5.2, depth: 3.4, thickness: 0.12, tilt: 0.42, y: 1.6, z: 12.4 } },
  fence: { posts: 18, height: 2.3, postDiameter: 0.16, railY: 0.82, radius: 7.4 },
  pit: { diameter: 13, depth: 1.1, spoilDiameter: 6.5, spoilX: 5.6, spoilZ: 4.2 },
} as const;

/** Corrugated container yard layout (level 1 stacks on level 0). */
const CONTAINER_SLOTS: ReadonlyArray<{ x: number; z: number; level: number; yaw: number; paint: number }> = [
  { x: -7.4, z: 5.6, level: 0, yaw: 0.18, paint: 0 },
  { x: -7.6, z: -1.4, level: 0, yaw: -0.12, paint: 1 },
  { x: -7.2, z: -8.2, level: 0, yaw: 0.05, paint: 2 },
  { x: -7.5, z: 2.0, level: 1, yaw: 0.31, paint: 1 },
  { x: 6.9, z: 3.4, level: 0, yaw: 1.42, paint: 2 },
  { x: 7.2, z: -4.6, level: 0, yaw: 1.28, paint: 0 },
];

/** Startup floodlight tower slots (model frame). */
const TOWER_SLOTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -10.5, z: -11.5 },
  { x: 10.5, z: -9.5 },
];

/** Anything carrying the records a base needs — a `WorldSnapshot` fits. */
export interface FactionBasesSource {
  nodes?: LunarNode[];
  craters?: Crater[];
  veins?: ResourceVein[];
}

/** Options for the faction base builder. */
export interface FactionBasesOptions {
  /** Root/material name prefix (default `faction`). */
  namePrefix?: string;
  /** Multiplier on every faction perimeter radius (default 1). */
  perimeterScale?: number;
  /** Build the startup floodlight SpotLights (default true). */
  floodlights?: boolean;
  /** Restrict the roster to a subset of the canonical four (default all). */
  roster?: readonly FactionId[];
}

/** One faction's forward base: plain, serialisable claim record. */
export interface FactionBaseInfo {
  readonly factionId: FactionId;
  readonly factionName: string;
  readonly allegiance: FactionAllegiance;
  readonly focusKind: ResourceKind;
  /** Sector node this base was anchored to (never invented). */
  readonly nodeId: string;
  readonly sectorId: string;
  /** World-frame site (x, y lateral, z elevation), metres. */
  readonly position: Vec3;
  /** Model nose direction, radians in the x-y plane (0 = +x). */
  readonly heading: number;
  /** Perimeter radius (m) — the default `isNearBase` reach. */
  readonly radiusM: number;
  /** Crater whose rim the base sits on (null for a plain sector-node site). */
  readonly craterId: string | null;
  readonly onCraterRim: boolean;
  readonly rootName: string;
  /** Meshes built for this base (0 before `init()`, patched after). */
  readonly meshCount: number;
}

/** `nearestBase` result: world-frame straight-line distance. */
export interface BaseProximity {
  base: FactionBaseInfo;
  distance: number;
}

/** Shared PBR set, built once per system. */
interface BaseMaterials {
  glass: PBRMaterial;
  hull: PBRMaterial;
  steel: PBRMaterial;
  dark: PBRMaterial;
  radiator: PBRMaterial;
  rust: PBRMaterial;
  orange: PBRMaterial;
  blue: PBRMaterial;
  panel: PBRMaterial;
  lamp: PBRMaterial;
  grit: PBRMaterial;
  accent: PBRMaterial;
}

/** Per-faction built scene objects. */
interface BaseSceneKit {
  root: TransformNode;
  meshes: Mesh[];
  lights: SpotLight[];
}

/**
 * One base's kit construction surface: primitive helpers that create, place,
 * parent and metadata-tag in a single call, closing over the base root so
 * every mesh carries its faction identity without name-string archaeology.
 */
interface KitBuilder {
  root(): TransformNode;
  /** Adopt an externally-built mesh into this base's tracked, tagged set. */
  adopt(mesh: Mesh, part: string): Mesh;
  box(name: string, part: string, w: number, h: number, d: number, x: number, y: number, z: number, mat: PBRMaterial): Mesh;
  cyl(name: string, part: string, dTop: number, dBottom: number, h: number, x: number, y: number, z: number, mat: PBRMaterial, tess?: number): Mesh;
  sph(name: string, part: string, diameter: number, x: number, y: number, z: number, mat: PBRMaterial, segments?: number, slice?: number): Mesh;
  torus(name: string, part: string, diameter: number, thickness: number, x: number, y: number, z: number, mat: PBRMaterial): Mesh;
  merged(name: string, part: string, sources: Mesh[], mat: PBRMaterial): Mesh;
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Is this node plausible surface infrastructure (a base host)? */
function isSurfaceHost(node: LunarNode): boolean {
  return (node.kind === 'refinery' || node.kind === 'dock' || node.kind === 'outpost')
    && node.position.z >= -1
    && Number.isFinite(node.position.x)
    && Number.isFinite(node.position.y);
}

/** Rotate a model-frame (x, z) offset by the base heading into world x/y. */
function rotateByHeading(x: number, z: number, heading: number): { x: number; y: number } {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  // Model +z = nose = world heading direction; model +x = world left.
  return { x: x * c - z * s, y: x * s + z * c };
}

export class FactionBases {
  // -- source records (queries run on these, never on meshes) -------------------
  private nodes: LunarNode[] = [];
  private craters: Crater[] = [];
  private veins: ResourceVein[] = [];
  private nodeIndex = new Map<string, LunarNode>();
  private bases: FactionBaseInfo[] = [];

  private readonly prefix: string;
  private readonly perimeterScale: number;
  private readonly wantFloodlights: boolean;
  private readonly roster: readonly FactionId[];

  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;

  private root: TransformNode | null = null;
  private kits = new Map<string, BaseSceneKit>();
  private meshList: Mesh[] = [];
  private lightList: SpotLight[] = [];
  private materials: BaseMaterials | null = null;
  private materialList: PBRMaterial[] = [];

  private built = false;
  private disposed = false;

  /**
   * Accepts a `WorldSnapshot` (or anything exposing `nodes` / `craters` /
   * `veins`), or nothing for an empty roster filled later by `load()`.
   * References are held, not cloned — `generate()` already hands out clones.
   */
  constructor(source?: WorldSnapshot | FactionBasesSource | null, options: FactionBasesOptions = {}) {
    this.prefix = options.namePrefix ?? DEFAULT_NAME_PREFIX;
    this.perimeterScale = Number.isFinite(options.perimeterScale) && (options.perimeterScale ?? 0) > 0
      ? (options.perimeterScale as number)
      : 1;
    this.wantFloodlights = options.floodlights ?? true;
    this.roster = options.roster ?? FACTION_IDS;
    if (source !== null && source !== undefined) this.load(source);
  }

  // -- data ----------------------------------------------------------------------

  /** Replace the source records and re-plan every base site. */
  load(source: WorldSnapshot | FactionBasesSource): this {
    this.nodes = Array.isArray(source.nodes) ? [...source.nodes] : [];
    this.craters = Array.isArray(source.craters) ? [...source.craters] : [];
    this.veins = Array.isArray(source.veins) ? [...source.veins] : [];
    this.nodeIndex = new Map(this.nodes.map((n) => [n.id, n]));
    this.planSites();
    return this;
  }

  /** Canonical roster in planning order (read-only view). */
  getRoster(): ReadonlyArray<FactionId> {
    return this.roster;
  }

  /** Static identity/kit class of a faction id (null when unknown). */
  getFactionDefinition(factionId: string): FactionDefinition | null {
    return (FACTION_DEFS as Record<string, FactionDefinition | undefined>)[factionId] ?? null;
  }

  /** Sector node record a base is anchored to (null when unknown). */
  getHostNode(factionId: string): LunarNode | null {
    const base = this.getBase(factionId);
    return base === null ? null : this.nodeIndex.get(base.nodeId) ?? null;
  }

  // -- spatial API (world frame, scene-independent) --------------------------------

  /** One base claim by canonical faction id; null when absent. */
  getBase(factionId: string): FactionBaseInfo | null {
    return this.bases.find((b) => b.factionId === factionId) ?? null;
  }

  /** Every planned base (read-only view, roster order). */
  getBases(): ReadonlyArray<FactionBaseInfo> {
    return this.bases;
  }

  /**
   * Nearest base whose perimeter contains the world-frame point, or null.
   * `radiusM` overrides EVERY base's own perimeter (a uniform scanner
   * sweep); omit it and each base is tested against its own `radiusM`.
   * Ties resolve to the closest base. Safe before init / after dispose.
   */
  isNearBase(p: Vec3, radiusM?: number): FactionBaseInfo | null {
    const hit = this.nearestBase(p, radiusM);
    return hit === null ? null : hit.base;
  }

  /** Nearest base within reach, with the straight-line world distance. */
  nearestBase(p: Vec3, radiusM?: number): BaseProximity | null {
    if (this.disposed) return null;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
    const override = Number.isFinite(radiusM) && (radiusM as number) > 0 ? (radiusM as number) : null;
    let best: BaseProximity | null = null;
    for (const base of this.bases) {
      const reach = override ?? base.radiusM;
      const distance = dist3(p, base.position);
      if (distance <= reach && (best === null || distance < best.distance)) {
        best = { base, distance };
      }
    }
    return best;
  }

  /**
   * Veins inside the base's own sector (optionally narrowed to one
   * `ResourceKind`), nearest-first — the faction's claim board.
   */
  getClaimedVeins(factionId: string, kind?: ResourceKind): ResourceVein[] {
    const base = this.getBase(factionId);
    if (base === null) return [];
    return this.veins
      .filter((v) => v.sectorId === base.sectorId)
      .filter((v) => kind === undefined || v.kind === kind)
      .map((vein) => ({ vein, d: dist3(base.position, vein.center) }))
      .sort((a, b) => a.d - b.d || a.vein.id.localeCompare(b.vein.id))
      .map((entry) => entry.vein);
  }

  // -- lifecycle ---------------------------------------------------------------------

  /**
   * Build the base structures. Accepts an existing `Scene`, a raw engine (a
   * scene is created around it), or nothing — falling back to a self-owned
   * `NullEngine`, exactly what CI wants. Idempotent; refuses after `dispose()`.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('FactionBases: init() after dispose()');
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
      throw new Error('FactionBases.init: browser needs a Scene or Engine');
    }

    this.root = new TransformNode(`${this.prefix}-system`, this.scene);
    this.materials = this.buildMaterials(this.scene);
    for (const base of this.bases) this.buildBase(base);
    this.built = true;
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /** Tear down every base kit, materials, root and any self-owned engine. Never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;

    for (const kit of this.kits.values()) {
      for (const light of kit.lights) FactionBases.disposeQuietly(light);
      for (const mesh of kit.meshes) FactionBases.disposeQuietly(mesh);
      FactionBases.disposeQuietly(kit.root);
    }
    this.kits.clear();
    this.meshList = [];
    this.lightList = [];
    for (const material of this.materialList) FactionBases.disposeQuietly(material);
    this.materialList = [];
    this.materials = null;
    FactionBases.disposeQuietly(this.root);
    this.root = null;

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) FactionBases.disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- accessors ------------------------------------------------------------------------

  /** System root transform (`faction-system`; null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every base mesh across all factions (shadow/picking registration). */
  getMeshes(): ReadonlyArray<AbstractMesh> {
    return [...this.meshList];
  }

  /** Every floodlight SpotLight built (startup towers only). */
  getLights(): ReadonlyArray<SpotLight> {
    return [...this.lightList];
  }

  /** One faction's meshes ([] when unknown or not built). */
  getBaseMeshes(factionId: string): Mesh[] {
    const kit = this.kits.get(factionId);
    return kit === undefined ? [] : [...kit.meshes];
  }

  /** One faction's floodlights ([] for nation-states, unknowns, after dispose). */
  getBaseLights(factionId: string): SpotLight[] {
    const kit = this.kits.get(factionId);
    return kit === undefined ? [] : [...kit.lights];
  }

  /** Base root transform for one faction (null before init / after dispose). */
  getBaseRoot(factionId: string): TransformNode | null {
    const kit = this.kits.get(factionId);
    return kit === undefined ? null : kit.root;
  }

  /**
   * Meshes tagged with a kit part id — 'pad' | 'dome' | 'dish' | 'silo' |
   * 'reactor' | 'radiator' | 'container' | 'tower' | 'skid' | 'fence' |
   * 'excavation' — optionally within one faction. This is how the smoke
   * suite asserts asymmetry without name-string archaeology.
   */
  getPartMeshes(part: string, factionId?: string): Mesh[] {
    const pool: Mesh[] = factionId === undefined ? this.meshList : this.getBaseMeshes(factionId);
    return pool.filter((m) => (m.metadata?.part as string | undefined) === part);
  }

  // -- site planning ---------------------------------------------------------------------

  /**
   * Anchor each faction deterministically: nation-states take sector hubs
   * (refinery → dock → outpost preference), startups take freight/outpost
   * kit (dock → outpost → refinery), always on distinct nodes and spread as
   * far apart from already-planned bases as the map allows. Each site then
   * snaps to the nearest crater's rim circle within tolerance, nose pointed
   * inward over the crater floor (the excavation digs into the pit).
   */
  private planSites(): void {
    const hosts = this.nodes.filter(isSurfaceHost);
    const planned: FactionBaseInfo[] = [];
    const taken = new Set<string>();

    for (const factionId of this.roster) {
      const def = this.getFactionDefinition(factionId);
      if (def === null) continue;
      const anchor = FactionBases.pickAnchorNode(def, hosts, taken, planned);
      if (anchor === null) continue;
      taken.add(anchor.id);

      const site = this.snapToCraterRim(anchor);
      planned.push({
        factionId,
        factionName: def.name,
        allegiance: def.allegiance,
        focusKind: def.focusKind,
        nodeId: anchor.id,
        sectorId: anchor.sectorId,
        position: site.position,
        heading: site.heading,
        radiusM: def.perimeterM * this.perimeterScale,
        craterId: site.craterId,
        onCraterRim: site.craterId !== null,
        rootName: `${this.prefix}-base-${factionId.toLowerCase()}`,
        meshCount: 0,
      });
    }
    this.bases = planned;
  }

  /** Best free host node for a faction: kind preference first, then spread. */
  private static pickAnchorNode(
    def: FactionDefinition,
    hosts: LunarNode[],
    taken: Set<string>,
    planned: ReadonlyArray<FactionBaseInfo>,
  ): LunarNode | null {
    const preference: LunarNode['kind'][] = def.allegiance === 'nation-state'
      ? ['refinery', 'dock', 'outpost']
      : ['dock', 'outpost', 'refinery'];

    for (const kind of preference) {
      const candidates = hosts.filter((n) => n.kind === kind && !taken.has(n.id));
      if (candidates.length === 0) continue;
      if (planned.length === 0) return candidates[0];
      // Spread: take the candidate maximising its minimum distance to the
      // already-planned bases — deterministic, no RNG, map-scaled separation.
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
    position: Vec3;
    heading: number;
    craterId: string | null;
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
      return { position: { ...anchor.position }, heading: 0, craterId: null };
    }
    const dx = anchor.position.x - crater.center.x;
    const dy = anchor.position.y - crater.center.y;
    const d = Math.hypot(dx, dy);
    const ux = d > 1e-6 ? dx / d : 1;
    const uy = d > 1e-6 ? dy / d : 0;
    return {
      position: { x: crater.center.x + ux * crater.radius, y: crater.center.y + uy * crater.radius, z: anchor.position.z },
      // Nose faces inward over the crater floor: startups dig into the pit,
      // nation domes look down onto their claim.
      heading: Math.atan2(-uy, -ux),
      craterId: crater.id,
    };
  }

  // -- mesh construction --------------------------------------------------------------------

  /** Vacuum-lunar PBR shorthand; environment stays near zero, nothing to reflect. */
  private static mk(
    name: string,
    scene: Scene,
    albedo: [number, number, number],
    metallic: number,
    roughness: number,
    emissive?: [number, number, number],
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

  /** Structural white, dielectric dome glass, steel, radiator and yard paints. */
  private buildMaterials(scene: Scene): BaseMaterials {
    const p = `${this.prefix}-`;
    const glass = FactionBases.mk(`${p}glass`, scene, [0.72, 0.86, 0.93], 0.02, 0.08, [0.05, 0.09, 0.12], 0.35);
    glass.alpha = 0.55; // translucent pressure shell, habitation glow inside

    const materials: BaseMaterials = {
      glass,
      hull: FactionBases.mk(`${p}hull`, scene, [0.8, 0.81, 0.82], 0.3, 0.42),
      steel: FactionBases.mk(`${p}steel`, scene, [0.6, 0.61, 0.64], 0.9, 0.32, undefined, 0.1),
      dark: FactionBases.mk(`${p}dark`, scene, [0.11, 0.11, 0.12], 0.45, 0.6, undefined, 0.04),
      // White-washed heat dump, faintly warm: the kilopower is running.
      radiator: FactionBases.mk(`${p}radiator`, scene, [0.72, 0.73, 0.75], 0.6, 0.28, [0.14, 0.05, 0.03], 0.1),
      rust: FactionBases.mk(`${p}rust`, scene, [0.4, 0.17, 0.08], 0.25, 0.92, undefined, 0.03),
      orange: FactionBases.mk(`${p}orange`, scene, [0.76, 0.34, 0.1], 0.2, 0.72, undefined, 0.05),
      blue: FactionBases.mk(`${p}blue`, scene, [0.13, 0.27, 0.44], 0.22, 0.68, undefined, 0.05),
      panel: FactionBases.mk(`${p}panel`, scene, [0.06, 0.09, 0.2], 0.55, 0.24, [0.02, 0.03, 0.07], 0.18),
      lamp: FactionBases.mk(`${p}lamp`, scene, [0.9, 0.88, 0.8], 0.1, 0.35, [1, 0.93, 0.76], 0.2),
      grit: FactionBases.mk(`${p}grit`, scene, [0.24, 0.22, 0.21], 0.02, 0.98, undefined, 0.02),
      accent: FactionBases.mk(`${p}accent`, scene, [0.42, 0.56, 0.86], 0.4, 0.4, undefined, 0.08),
    };
    this.materialList = Object.values(materials);
    return materials;
  }

  /** Build one base's kit under the system root and register its meshes. */
  private buildBase(info: FactionBaseInfo): void {
    const scene = this.scene as Scene;
    const mats = this.materials as BaseMaterials;

    const root = new TransformNode(info.rootName, scene);
    const b = worldToBabylon(info.position);
    root.position.set(b.x, b.y, b.z);
    root.rotation.y = Math.PI / 2 + info.heading; // shared heading convention
    root.computeWorldMatrix(true);

    const kit: BaseSceneKit = { root, meshes: [], lights: [] };
    const tag = info.factionId.toLowerCase();
    const track = (mesh: Mesh, part: string): Mesh => {
      mesh.parent = root;
      mesh.isPickable = true;
      mesh.receiveShadows = false;
      mesh.metadata = { factionId: info.factionId, allegiance: info.allegiance, part, nodeId: info.nodeId };
      kit.meshes.push(mesh);
      return mesh;
    };
    const kitBuilder: KitBuilder = {
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
        const m = FactionBases.mergeInto(`${this.prefix}-${n}-${tag}`, sources, scene);
        m.material = mat;
        return track(m, part);
      },
    };

    const g = GEO.pad;
    kitBuilder.cyl('pad', 'pad', g.diameter, g.diameter, g.height, 0, -g.height / 2, 0, mats.grit, 28);
    if (info.allegiance === 'nation-state') this.buildNationKit(scene, mats, kitBuilder);
    else this.buildStartupKit(info, scene, mats, kitBuilder, kit);

    this.kits.set(info.factionId, kit);
    this.meshList.push(...kit.meshes);
    this.lightList.push(...kit.lights);
    // Patch the plain record with the truth about what got built.
    const index = this.bases.indexOf(info);
    if (index >= 0) this.bases[index] = { ...info, meshCount: kit.meshes.length };
  }

  /** Pressurised dome + radar dish + sorting silo + reactor radiator array. */
  private buildNationKit(scene: Scene, mats: BaseMaterials, k: KitBuilder): void {
    const d = GEO.dome;
    // Pressure shell: high-spec dielectric hemisphere on a ring beam, with a
    // habitable inner module so the dome reads as a volume, not a tent.
    k.sph('dome', 'dome', d.diameter, d.x, 0, d.z, mats.glass, d.segments, 0.5);
    k.torus('dome-ring', 'dome', d.ringDiameter, d.ringThickness, d.x, d.ringY, d.z, mats.hull);
    k.sph('dome-inner', 'dome', d.innerDiameter, d.x, 0.1, d.z, mats.hull, 8, 0.5);
    k.box('airlock', 'dome', 2.2, 2.4, 3.2, d.x, 1.2, d.airlockZ, mats.hull);

    // Communications radar: shallow parabolic cap, rim ring, feed horn + head.
    const r = GEO.dish;
    const dish = k.sph('dish', 'dish', r.diameter, r.x, r.mastHeight + 0.8, r.z, mats.hull, 16, r.capSlice);
    dish.rotation.x = r.tilt;
    const rim = k.torus('dish-rim', 'dish', r.diameter * 0.98, 0.28, r.x, r.mastHeight + 0.8, r.z, mats.steel);
    rim.rotation.x = r.tilt;
    k.cyl('dish-horn', 'dish', r.hornDiameter, 0.14, r.mastHeight, r.x, r.mastHeight / 2, r.z, mats.steel, 10);
    k.sph('dish-feed', 'dish', r.hornDiameter * 1.6, r.x, r.mastHeight + 0.2, r.z, mats.lamp, 8);

    // Automated sorting silo: drum, hopper cap, discharge chute.
    const s = GEO.silo;
    k.cyl('silo', 'silo', s.diameter, s.diameter, s.height, s.x, s.height / 2, s.z, mats.hull, 18);
    k.cyl('silo-cap', 'silo', 0.4, s.diameter, s.capHeight, s.x, s.height + s.capHeight / 2, s.z, mats.accent, 18);
    const chute = k.box('silo-chute', 'silo', s.chute.width, s.chute.height, s.chute.depth,
      s.x, 3.1, s.z + s.diameter / 2 + s.chute.depth / 2, mats.steel);
    chute.rotation.x = s.chute.pitch;

    // Nuclear kilopower: shielded core + radial radiator fin array (fins
    // merged into one heat-dump mesh around the core).
    const n = GEO.reactor;
    k.cyl('reactor', 'reactor', n.coreDiameter, n.coreDiameter, n.coreHeight, n.x, n.coreHeight / 2, n.z, mats.steel, 16);
    k.cyl('reactor-shield', 'reactor', n.shieldDiameter, n.shieldDiameter, n.coreHeight * 0.7,
      n.x, n.coreHeight * 0.35, n.z, mats.dark, 16);
    const fins: Mesh[] = [];
    for (let i = 0; i < n.finCount; i++) {
      const angle = (i / n.finCount) * Math.PI * 2;
      const radius = n.coreDiameter / 2 + n.finLength / 2;
      const fin = MeshBuilder.CreateBox(`fin-src-${i}`,
        { width: n.finThickness, height: n.finLength, depth: n.finWidth }, scene);
      fin.position.set(n.x + Math.cos(angle) * radius, n.coreHeight * 0.75, n.z + Math.sin(angle) * radius);
      fin.rotation.y = -angle;
      fins.push(fin);
    }
    k.merged('radiator', 'radiator', fins, mats.radiator);
  }

  /** Container stacks + lattice floodlight towers + power skid + fenced pit. */
  private buildStartupKit(
    info: FactionBaseInfo,
    scene: Scene,
    mats: BaseMaterials,
    k: KitBuilder,
    kit: BaseSceneKit,
  ): void {
    const paints = [mats.rust, mats.orange, mats.blue];
    const c = GEO.container;

    // Corrugated containers: shell + transverse ribs merged into one
    // weathered mesh per unit, stacked two high on the yard pad.
    CONTAINER_SLOTS.forEach((slot, index) => {
      const parts = [MeshBuilder.CreateBox(`container-src-${index}`,
        { width: c.width, height: c.height, depth: c.depth }, scene)];
      for (let rib = 1; rib < c.ribCount; rib++) {
        const z = (rib / c.ribCount) * c.depth - c.depth / 2;
        const ribber = MeshBuilder.CreateBox(`container-rib-src-${index}-${rib}`,
          { width: c.width + 0.14, height: c.height * 0.92, depth: c.ribDepth }, scene);
        ribber.position.set(0, 0, z); // corrugation band proud of both walls
        parts.push(ribber);
      }
      const unit = k.merged(`container-${index}`, 'container', parts, paints[slot.paint % paints.length]);
      unit.position.set(slot.x, slot.level * (c.height + 0.12) + c.height / 2 + 0.06, slot.z);
      unit.rotation.y = slot.yaw;
    });

    // Lattice floodlight towers; each yoke carries one real SpotLight whose
    // world position runs through the SAME heading rotation as the tower
    // parent uses, so beam and lattice cannot drift apart.
    TOWER_SLOTS.forEach((slot, index) => {
      const tower = FactionBases.buildLatticeTower(`${this.prefix}-tower-${info.factionId.toLowerCase()}-${index}`, scene, mats);
      tower.position.set(slot.x, 0, slot.z);
      k.adopt(tower, 'tower');

      if (!this.wantFloodlights) return;
      const world = rotateByHeading(slot.x, slot.z, info.heading);
      const flood = new SpotLight(
        `${this.prefix}-flood-${info.factionId.toLowerCase()}-${index === 0 ? 'l' : 'r'}`,
        worldToBabylon({ x: info.position.x + world.x, y: info.position.y + world.y, z: info.position.z + GEO.tower.height }),
        // Beam rakes down into the yard (Babylon -y) and slightly inward.
        new Vector3(0, -0.82, 0.57),
        (FLOODLIGHT_ANGLE_DEG * Math.PI) / 180,
        1.4,
        scene,
      );
      flood.range = FLOODLIGHT_RANGE_M;
      flood.diffuse = new Color3(1, 0.92, 0.74);
      flood.intensity = FLOODLIGHT_INTENSITY;
      flood.metadata = { factionId: info.factionId, allegiance: info.allegiance, part: 'floodlight' };
      kit.lights.push(flood);
    });

    // Diesel/solar auxiliary power skid: frame, genset, fuel tank, PV array.
    const g = GEO.skid;
    k.box('skid-frame', 'skid', g.frame.width, g.frame.height, g.frame.depth, g.x, g.frame.height / 2, g.z, mats.orange);
    const genset = k.cyl('skid-genset', 'skid', g.genset.diameter, g.genset.diameter, g.genset.length,
      g.x, g.frame.height + g.genset.diameter / 2, g.genset.z, mats.dark, 14);
    genset.rotation.z = Math.PI / 2; // horizontal diesel genset on the skid
    k.cyl('skid-tank', 'skid', g.tank.diameter, g.tank.diameter, g.tank.height,
      g.x, g.frame.height + g.tank.height / 2, g.tank.z, mats.rust, 14);
    const panel = k.box('skid-panel', 'skid', g.panel.width, g.panel.thickness, g.panel.depth, g.x, g.panel.y, g.panel.z, mats.panel);
    panel.rotation.x = g.panel.tilt; // sun-angle array

    // Fenced excavation perimeter: merged post ring, top rail, dug test pit.
    const f = GEO.fence;
    const posts: Mesh[] = [];
    for (let i = 0; i < f.posts; i++) {
      const angle = (i / f.posts) * Math.PI * 2;
      const post = MeshBuilder.CreateCylinder(`fence-post-src-${i}`,
        { diameter: f.postDiameter, height: f.height, tessellation: 6 }, scene);
      post.position.set(Math.cos(angle) * f.radius, f.height / 2, Math.sin(angle) * f.radius);
      posts.push(post);
    }
    k.merged('fence', 'fence', posts, mats.orange);
    k.torus('fence-rail', 'fence', f.radius * 2, 0.09, 0, f.height * f.railY, 0, mats.steel);

    k.cyl('excavation', 'excavation', GEO.pit.diameter, GEO.pit.diameter * 0.68, GEO.pit.depth,
      0, -GEO.pit.depth * 0.45, 0, mats.grit, 20);
    k.sph('excavation-spoil', 'excavation', GEO.pit.spoilDiameter, GEO.pit.spoilX, 0, GEO.pit.spoilZ, mats.grit, 6, 0.4);
  }

  /** Four legs + horizontal brace lattice + lamp head, merged into one mesh. */
  private static buildLatticeTower(name: string, scene: Scene, mats: BaseMaterials): Mesh {
    const g = GEO.tower;
    const parts: Mesh[] = [];
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        const leg = MeshBuilder.CreateCylinder(`${name}-leg-${sx > 0 ? 'a' : 'b'}${sz > 0 ? 'c' : 'd'}`,
          { diameter: g.legDiameter, height: g.height, tessellation: 6 }, scene);
        leg.position.set(sx * g.legOffset, g.height / 2, sz * g.legOffset);
        parts.push(leg);
      }
    }
    for (let level = 0; level < g.braceLevels; level++) {
      const y = ((level + 0.5) / g.braceLevels) * g.height;
      for (const axis of [0, 1]) {
        const brace = MeshBuilder.CreateCylinder(`${name}-brace-${level}${axis}`,
          { diameter: g.legDiameter * 0.6, height: g.legOffset * 2, tessellation: 6 }, scene);
        brace.position.set(0, y, 0);
        brace.rotation.z = Math.PI / 2; // lay across model x
        if (axis === 1) brace.rotation.y = Math.PI / 2; // ...then swing to z
        parts.push(brace);
      }
    }
    const head = MeshBuilder.CreateBox(`${name}-head`,
      { width: g.head.width, height: g.head.height, depth: g.head.depth }, scene);
    head.position.set(0, g.height + g.head.height / 2, 0);
    head.rotation.x = g.head.pitch; // lamp angled down over the yard
    parts.push(head);

    const tower = FactionBases.mergeInto(name, parts, scene);
    tower.material = mats.steel;
    return tower;
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
    for (const extra of parts.slice(1)) FactionBases.disposeQuietly(extra);
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

export default FactionBases;
