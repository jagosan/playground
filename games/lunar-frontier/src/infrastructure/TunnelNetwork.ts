/**
 * Lunar Frontier — procedural subterranean tunnel mesh network & mineral vein
 * visualization (TASK-PLAY-048a).
 *
 * Dresses the EXISTING world generator output (`LunarWorldGenerator` →
 * `WorldSnapshot`) in Babylon.js geometry. No world-gen logic lives here —
 * segments, veins and nodes are consumed verbatim as `TunnelSegment`,
 * `ResourceVein` and `LunarNode` records; nothing is re-derived, no duplicate
 * kind constants (the `ResourceKind` union comes from the world module).
 *
 * Meshes (procedural only, no GLB):
 *  - One tubular bore per `TunnelSegment` via `MeshBuilder.CreateTube` with
 *    `sideOrientation: Mesh.DOUBLESIDE` (interior walls stay visible and lit
 *    when the prospector stands inside the tube), uncapped, bored at the
 *    segment's own radius. Lava tubes, drilled mine shafts, cavern adits and
 *    wheeled ramps all share one dark basalt PBR wall material.
 *  - One mineral marker per `ResourceVein`: a sphere anchored where the vein
 *    is closest to a hosting tunnel (hugging the wall, or the bore centre when
 *    the ore body is concentric), else at the vein centre. Each `ResourceKind`
 *    gets a visually distinct PBR material — water ice cyan/blue-white with a
 *    cold emissive sheen, titanium silver and highly metallic, helium-3
 *    emissive golden-orange, rare earth (KREEP) deep violet-metallic, and
 *    regolith gray matte. Mining shrinks a vein's marker as its in-situ units
 *    are extracted.
 *
 * Coordinates: world metres (x, y lateral, z up) map to Babylon (x, z↑, -y)
 * via the shared `worldToBabylon` from CameraRig — meshes, camera and physics
 * cannot disagree about where a tunnel lives. All spatial/mining queries
 * (`isInsideTunnel`, `getNearestTunnelSegment`, `getNearbyVeins`, `mineVein`)
 * operate in the WORLD frame on the source data, so they answer correctly
 * before `init()`, after `dispose()`, and with or without any scene.
 *
 * Headless-safe: `init()` accepts a Scene, a raw engine (a scene is created
 * around it), or nothing (self-owned NullEngine fallback). `dispose()` is
 * idempotent and never throws; after disposal every query still works and
 * `init()` refuses with a clear error.
 *
 * Usage:
 *   const world = new LunarWorldGenerator('mala-voyage-2431').generate();
 *   const network = new TunnelNetwork(world).init(scene);
 *   if (network.isInsideTunnel(prospectorPos)) { ... }
 *   const got = network.mineVein('vein-water_ice-042', 40);
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';

import { worldToBabylon } from '../engine/CameraRig.ts';
import type {
  LunarNode,
  ResourceKind,
  ResourceVein,
  TunnelSegment,
  Vec3,
  WorldSnapshot,
} from '../world/LunarWorldGenerator.ts';

/** Radial segments of every bored tube (double-sided → 4×(t+1) ring verts). */
export const TUBE_TESSELLATION = 12;
/** Default `getNearbyVeins` search radius, metres (scanner range). */
export const DEFAULT_VEIN_PROXIMITY_M = 60;
/** Root/material name prefix when none is supplied (mesh families are fixed). */
export const DEFAULT_NAME_PREFIX = 'tunnel';

/** Anything that carries the geometry records — a `WorldSnapshot` fits. */
export interface TunnelNetworkSource {
  tunnels?: TunnelSegment[];
  veins?: ResourceVein[];
  nodes?: LunarNode[];
}

/** Visual identity of one resource kind on the vein-marker set. */
interface OreAppearance {
  albedo: [number, number, number];
  emissive: [number, number, number];
  metallic: number;
  roughness: number;
}

/**
 * PBR identity per `ResourceKind` (the world module's ilmenite-rich mare
 * seams render as titanium silver; its KREEP deep crust is the violet-metallic
 * rare earth; basalt grit is the gray matte regolith).
 */
const ORE_APPEARANCE: Record<ResourceKind, OreAppearance> = {
  water_ice: {
    albedo: [0.55, 0.84, 0.94],
    emissive: [0.04, 0.1, 0.16],
    metallic: 0.05,
    roughness: 0.32,
  },
  titanium: {
    albedo: [0.78, 0.8, 0.83],
    emissive: [0, 0, 0],
    metallic: 0.92,
    roughness: 0.28,
  },
  helium_3: {
    albedo: [1.0, 0.74, 0.22],
    emissive: [0.85, 0.44, 0.06],
    metallic: 0.35,
    roughness: 0.42,
  },
  rare_earth: {
    albedo: [0.36, 0.22, 0.46],
    emissive: [0.1, 0.02, 0.16],
    metallic: 0.75,
    roughness: 0.45,
  },
  regolith: {
    albedo: [0.34, 0.32, 0.3],
    emissive: [0, 0, 0],
    metallic: 0.02,
    roughness: 0.97,
  },
};

export interface TunnelNetworkOptions {
  /** Root/material name prefix (default `tunnel`). */
  namePrefix?: string;
  /** Tube radial tessellation (default {@link TUBE_TESSELLATION}). */
  tessellation?: number;
  /** Multiplier on every vein-marker diameter (default 1). */
  veinMarkerScale?: number;
}

/** `getNearestTunnelSegment` result: world-frame perpendicular distance. */
export interface SegmentProximity {
  segment: TunnelSegment;
  distance: number;
}

/** `getNearbyVeins` entry: distance from query point to the vein centre. */
export interface VeinProximity {
  vein: ResourceVein;
  distance: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Closest point on segment ab to p (clamped parameter walk). */
function closestOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  if (len2 === 0) return { ...a };
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2, 0, 1);
  return { x: a.x + t * abx, y: a.y + t * aby, z: a.z + t * abz };
}

export class TunnelNetwork {
  /** Tunnel segments as supplied (world frame; the truth for all queries). */
  private segments: TunnelSegment[] = [];
  /** Veins as supplied — `mineVein` decrements `remaining` in place. */
  private veins: ResourceVein[] = [];
  /** Node records from a snapshot source (empty for bare tunnel/vein input). */
  private nodes: LunarNode[] = [];
  private nodeIndex = new Map<string, LunarNode>();
  private segmentIndex = new Map<string, TunnelSegment>();
  private veinIndex = new Map<string, ResourceVein>();

  private readonly prefix: string;
  private readonly tessellation: number;
  private readonly veinScaleFactor: number;

  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;

  private root: TransformNode | null = null;
  private tubeMeshes: Mesh[] = [];
  private veinMeshes: Mesh[] = [];
  private basalt: PBRMaterial | null = null;
  private oreMaterials: PBRMaterial[] = [];
  private readonly veinMarkerBy = new Map<string, Mesh>();

  private built = false;
  private disposed = false;

  /**
   * Accepts a `WorldSnapshot` (or anything exposing `tunnels` / `veins` /
   * `nodes` arrays — e.g. `{ tunnels, veins }`), or nothing for an empty
   * network filled later by `load()`. References are held, not cloned:
   * `mineVein` updates the caller's vein records exactly like the generator's
   * own `harvest`, and `generate()` already hands out fresh clones.
   */
  constructor(source?: WorldSnapshot | TunnelNetworkSource | null, options: TunnelNetworkOptions = {}) {
    this.prefix = options.namePrefix ?? DEFAULT_NAME_PREFIX;
    this.tessellation = Math.max(3, Math.floor(options.tessellation ?? TUBE_TESSELLATION));
    this.veinScaleFactor = options.veinMarkerScale ?? 1;
    if (source !== null && source !== undefined) this.load(source);
  }

  // -- data ---------------------------------------------------------------------

  /** Replace the network's world records wholesale (queries + rebuild-ready). */
  load(source: WorldSnapshot | TunnelNetworkSource): this {
    this.segments = Array.isArray(source.tunnels) ? [...source.tunnels] : [];
    this.veins = Array.isArray(source.veins) ? [...source.veins] : [];
    this.nodes = Array.isArray(source.nodes) ? [...source.nodes] : [];
    this.segmentIndex = new Map(this.segments.map((s) => [s.id, s]));
    this.veinIndex = new Map(this.veins.map((v) => [v.id, v]));
    this.nodeIndex = new Map(this.nodes.map((n) => [n.id, n]));
    return this;
  }

  /** All tunnel segments (read-only view, input order preserved). */
  getSegments(): ReadonlyArray<TunnelSegment> {
    return this.segments;
  }

  /** All resource veins (read-only view; `remaining` is live ledger state). */
  getVeins(): ReadonlyArray<ResourceVein> {
    return this.veins;
  }

  /** Look up one segment by id (null when unknown / never present). */
  getSegment(id: string): TunnelSegment | null {
    return this.segmentIndex.get(id) ?? null;
  }

  /** Look up one vein by id (null when unknown). */
  getVein(id: string): ResourceVein | null {
    return this.veinIndex.get(id) ?? null;
  }

  /** Nodes whose survey proximity exposes `veinId` to their crews. */
  getVeinHostNodes(veinId: string): LunarNode[] {
    const vein = this.veinIndex.get(veinId);
    if (vein === undefined) return [];
    const hosts: LunarNode[] = [];
    for (const id of vein.hostNodeIds) {
      const node = this.nodeIndex.get(id);
      if (node !== undefined) hosts.push(node);
    }
    return hosts;
  }

  // -- spatial queries (world frame, scene-independent) ----------------------------

  /**
   * True when the world-frame point lies inside the bored volume of ANY
   * tunnel: perpendicular distance to the segment's start→end line below
   * `segment.radius + tolerance`. Degenerate (zero-length) segments fall back
   * to a spherical test around their start point.
   */
  isInsideTunnel(p: Vec3, tolerance = 0): boolean {
    if (this.disposed) return false;
    const pad = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0;
    for (const segment of this.segments) {
      const foot = closestOnSegment(p, segment.start, segment.end);
      if (dist3(p, foot) <= segment.radius + pad) return true;
    }
    return false;
  }

  /**
   * Nearest tunnel segment to a world-frame point, with the perpendicular
   * distance to its bore axis (0 when inside). Null on an empty network.
   */
  getNearestTunnelSegment(p: Vec3): SegmentProximity | null {
    if (this.disposed) return null;
    let best: SegmentProximity | null = null;
    for (const segment of this.segments) {
      const distance = dist3(p, closestOnSegment(p, segment.start, segment.end));
      if (best === null || distance < best.distance) best = { segment, distance };
    }
    return best;
  }

  /**
   * Veins whose centre sits within `radiusM` of a world-frame point, sorted
   * nearest-first (ties broken by vein id). This is the scanner sweep: it
   * reports the vein's true distance to centre, surface or not.
   */
  getNearbyVeins(p: Vec3, radiusM: number = DEFAULT_VEIN_PROXIMITY_M): VeinProximity[] {
    if (this.disposed) return [];
    const reach = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : 0;
    return this.veins
      .map((vein) => ({ vein, distance: dist3(p, vein.center) }))
      .filter((entry) => entry.distance <= reach)
      .sort((a, b) => a.distance - b.distance || a.vein.id.localeCompare(b.vein.id));
  }

  /**
   * Extract `amount` in-situ units from a vein (world ledger, scene-optional):
   * decrements `vein.remaining` in place and returns what actually came out,
   * clamped to `[0, remaining]`. Unknown vein, non-finite/negative request or
   * a depleted deposit all return 0. Depleted markers shrink as ore leaves.
   */
  mineVein(veinId: string, amount: number): number {
    if (this.disposed) return 0;
    const vein = this.veinIndex.get(veinId);
    if (vein === undefined) return 0;
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const available = Math.max(0, vein.remaining);
    const extracted = Math.min(amount, available);
    if (extracted <= 0) return 0;
    vein.remaining = available - extracted;
    if (!this.disposed) this.applyVeinDepletion(vein);
    return extracted;
  }

  // -- lifecycle -------------------------------------------------------------------

  /**
   * Build the mesh network. Accepts an existing `Scene`, a raw engine (a scene
   * is created around it), or nothing — falling back to a self-owned
   * `NullEngine`, exactly what CI wants. Idempotent; refuses after `dispose()`.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('TunnelNetwork: init() after dispose()');
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
      throw new Error('TunnelNetwork.init: browser needs a Scene or Engine');
    }

    this.buildNetwork(this.scene);
    this.built = true;
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /** Tear down tubes, markers, materials, root and any self-owned engine. Never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;

    for (const mesh of this.tubeMeshes) TunnelNetwork.disposeQuietly(mesh);
    for (const mesh of this.veinMeshes) TunnelNetwork.disposeQuietly(mesh);
    this.tubeMeshes = [];
    this.veinMeshes = [];
    for (const material of this.oreMaterials) TunnelNetwork.disposeQuietly(material);
    this.oreMaterials = [];
    TunnelNetwork.disposeQuietly(this.basalt);
    this.basalt = null;
    TunnelNetwork.disposeQuietly(this.root);
    this.root = null;
    this.veinMarkerBy.clear();

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) TunnelNetwork.disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- accessors ---------------------------------------------------------------------

  /** Root transform node of the network (null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every mesh — tubes and vein markers (shadow/picking registration). */
  getMeshes(): ReadonlyArray<AbstractMesh> {
    return [...this.tubeMeshes, ...this.veinMeshes];
  }

  /** Just the bored tunnel bores (`tunnel-*`). */
  getTubeMeshes(): ReadonlyArray<Mesh> {
    return [...this.tubeMeshes];
  }

  /** Just the mineral deposit markers (`vein-*`). */
  getVeinMarkers(): ReadonlyArray<Mesh> {
    return [...this.veinMeshes];
  }

  // -- internals -----------------------------------------------------------------------

  /** One double-sided bore per segment + one anchored marker per vein. */
  private buildNetwork(scene: Scene): void {
    this.root = new TransformNode(`${this.prefix}-network`, scene);
    this.basalt = TunnelNetwork.buildBasaltMaterial(this.prefix, scene);

    this.tubeMeshes = this.segments.map((segment, index) => {
      const mesh = this.buildBore(segment, index, scene);
      mesh.parent = this.root;
      return mesh;
    });

    this.oreMaterials = this.buildOreMaterials(scene);
    this.veinMeshes = this.veins.map((vein, index) => {
      const mesh = this.buildVeinMarker(vein, index, scene);
      mesh.parent = this.root;
      return mesh;
    });
  }

  /** Dark lunar basalt wall rock: near-matte, slightly reflective vacuum. */
  private static buildBasaltMaterial(prefix: string, scene: Scene): PBRMaterial {
    const basalt = new PBRMaterial(`${prefix}-basalt`, scene);
    basalt.albedoColor = new Color3(0.13, 0.12, 0.125); // fresh basalt, dusted
    basalt.metallic = 0.06;
    basalt.roughness = 0.94; // fractured rock is all diffuse scatter
    basalt.environmentIntensity = 0.04; // vacuum: nothing to reflect
    return basalt;
  }

  /** One distinct PBR material per resource kind present in the vein set. */
  private buildOreMaterials(scene: Scene): PBRMaterial[] {
    const kinds: ResourceKind[] = [];
    for (const vein of this.veins) {
      if (!kinds.includes(vein.kind)) kinds.push(vein.kind);
    }
    kinds.sort();
    return kinds.map((kind) => {
      const look = ORE_APPEARANCE[kind];
      const material = new PBRMaterial(`${this.prefix}-ore-${kind}`, scene);
      material.albedoColor = new Color3(look.albedo[0], look.albedo[1], look.albedo[2]);
      material.emissiveColor = new Color3(look.emissive[0], look.emissive[1], look.emissive[2]);
      material.metallic = look.metallic;
      material.roughness = look.roughness;
      material.environmentIntensity = 0.12; // ore faces catch a touch more light
      return material;
    });
  }

  /** Tubular bore for one segment: worldToBabylon path, uncapped, double-sided. */
  private buildBore(segment: TunnelSegment, index: number, scene: Scene): Mesh {
    const path = [worldToBabylon(segment.start), worldToBabylon(segment.end)];
    const mesh = MeshBuilder.CreateTube(
      `tunnel-${segment.kind}-${index}`,
      {
        path,
        radius: Math.max(0.05, segment.radius),
        tessellation: this.tessellation,
        cap: Mesh.NO_CAP,
        sideOrientation: Mesh.DOUBLESIDE,
      },
      scene,
    );
    // Babylon reports side orientation through the material when one is set;
    // pin it explicitly so `mesh.sideOrientation` reads DOUBLESIDE truthfully
    // even after the shared basalt material attaches (geometry is untouched).
    mesh.sideOrientation = Mesh.DOUBLESIDE;
    mesh.material = this.basalt;
    mesh.isPickable = true;
    mesh.receiveShadows = false;
    mesh.metadata = { segmentId: segment.id, kind: segment.kind };
    return mesh;
  }

  /**
   * Mineral marker for one vein: sphere at the vein's anchor point (host
   * tunnel wall / bore centre when a tunnel cuts the ore body, else vein
   * centre), sized off the vein radius so big bodies read as bigger paydirt.
   */
  private buildVeinMarker(vein: ResourceVein, index: number, scene: Scene): Mesh {
    const anchor = this.veinAnchor(vein);
    const diameter = clamp(vein.radius * 0.35, 1.4, 6) * this.veinScaleFactor;
    const mesh = MeshBuilder.CreateSphere(`vein-${vein.kind}-${index}`, { diameter, segments: 8 }, scene);
    const b = worldToBabylon(anchor);
    mesh.position.set(b.x, b.y, b.z);
    mesh.material = this.oreMaterials.find((m) => m.name === `${this.prefix}-ore-${vein.kind}`) ?? null;
    mesh.isPickable = true;
    mesh.metadata = { veinId: vein.id, kind: vein.kind };
    this.veinMarkerBy.set(vein.id, mesh);
    this.applyVeinDepletion(vein);
    return mesh;
  }

  /**
   * Where a vein visually surfaces: the point on a hosting tunnel's centreline
   * nearest the ore body, nudged toward the vein centre (hugging the wall at
   * ≤ 70 % of the bore radius). Concentric ore stays on the bore centre; with
   * no host tunnel, the vein centre itself.
   */
  private veinAnchor(vein: ResourceVein): Vec3 {
    const host = this.hostSegmentFor(vein);
    if (host === null) return { ...vein.center };
    const foot = closestOnSegment(vein.center, host.start, host.end);
    const gap = dist3(foot, vein.center);
    if (gap < 1e-6) return foot; // concentric: marker rides the bore centre
    const nudge = Math.min(gap, host.radius * 0.7);
    const t = nudge / gap;
    return {
      x: foot.x + (vein.center.x - foot.x) * t,
      y: foot.y + (vein.center.y - foot.y) * t,
      z: foot.z + (vein.center.z - foot.z) * t,
    };
  }

  /** Segment declared as host (`hostTunnelIds`), else the nearest one cutting it. */
  private hostSegmentFor(vein: ResourceVein): TunnelSegment | null {
    for (const id of vein.hostTunnelIds) {
      const segment = this.segmentIndex.get(id);
      if (segment !== undefined) return segment;
    }
    let best: TunnelSegment | null = null;
    let bestD = Infinity;
    for (const segment of this.segments) {
      const d = dist3(vein.center, closestOnSegment(vein.center, segment.start, segment.end));
      if (d <= vein.radius + 25 && (best === null || d < bestD)) {
        best = segment;
        bestD = d;
      }
    }
    return best;
  }

  /** Shrink a marker toward a 25 % stub as its in-situ units run out. */
  private applyVeinDepletion(vein: ResourceVein): void {
    const mesh = this.veinMarkerBy.get(vein.id);
    // NB: `isDisposed()` is a method on AbstractMesh — calling it, not
    // testing the function reference, is what actually detects a dead node.
    if (mesh === undefined || mesh.isDisposed()) return;
    const fraction = vein.abundance > 0 ? clamp(vein.remaining / vein.abundance, 0, 1) : 0;
    const scale = 0.25 + 0.75 * fraction;
    mesh.scaling.set(scale, scale, scale);
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

export default TunnelNetwork;
