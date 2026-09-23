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
 *  - Spec 21 §2.4 SURFACE SHAFT PORTALS: every tunnel mouth at z ≥ −2 m is
 *    framed with a concrete collar abutment ringed by alternating yellow /
 *    black hazard chevron blocks, an overhead gantry carrying an illuminated
 *    neon identification beacon (`SHAFT 04 // DEEP SECTOR ADIT`), and twin
 *    steel bore rings lining the first 12 m of rock along the tunnel tangent.
 *  - Spec 21 §2.4 UNDERGROUND CONTROL BUNKERS: each terminal `cavern` node
 *    houses a 30 × 20 × 8 m chamber (arched ceiling rib trusses, wall cable
 *    trays, amber emergency bulkhead strip lights, modular consoles with
 *    green vector CRTs) sealed by a reinforced vault door with a
 *    locked → unlocked → open state machine and a security terminal console.
 *
 * Headless-safe: `init()` accepts a Scene, a raw engine (a scene is created
 * around it), or nothing (self-owned NullEngine fallback). Facility geometry
 * is pure procedural primitives (ADR-021-1 — no GLB, and no canvas/DOM
 * dependency: beacon text lives in `metadata.label`, painted to a texture
 * only where an `OffscreenCanvas` exists). `dispose()` is idempotent and
 * never throws; after disposal every query still works and `init()` refuses
 * with a clear error.
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
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';

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

/**
 * Spec 21 §2.4 — surface shaft portals frame every tunnel mouth whose mouth
 * elevation is at or above this world z (metres). Mouths below it are dark
 * adit throats reached from underground and get no surface architecture.
 */
export const SURFACE_PORTAL_MIN_Z_M = -2;
/** Twin steel bore rings line the first metres of rock behind a portal mouth. */
export const PORTAL_BORE_RING_OFFSETS_M: readonly number[] = [2.5, 8.5];
/** Half-extension of a bunker chamber along its local axes (width × length × height). */
export const BUNKER_DIMENSIONS_M = { width: 30, length: 20, height: 8 } as const;
/** Vault door leaf id (Spec 21 §2.4: `vault-door-01` seals the first sanctum). */
export const VAULT_DOOR_ID_PREFIX = 'vault-door';
/** Reach (m) at which a security terminal answers `[E] Interface Security Terminal`. */
export const VAULT_TERMINAL_RANGE_M = 3.5;

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

/**
 * Spec 21 §2.4 door state machine: `locked` (red beacon) → `unlocked`
 * (green beacon) → `open` (door leaves slid into the wall recess).
 */
export type VaultDoorState = 'locked' | 'unlocked' | 'open';

/**
 * High-value vault loot (Spec 21 §2.4 / blueprint §2.2). Bonuses are applied
 * once, by the client, when the sanctum is opened and the loot is claimed.
 */
export interface VaultLootItem {
  id: string;
  name: string;
  kind: 'fuel_cell' | 'suit_upgrade' | 'cryo_canister' | 'drill_bit';
  description: string;
  batteryKwhBonus?: number;
  cargoCapacityBonusKg?: number;
  creditValue: number;
}

/**
 * The vault inventory every bunker sanctum ships with (Spec 21 §2.4 §3):
 * auxiliary buggy fuel cell (+15 kWh pack, restores 100 %), advanced
 * prospector EVA suit (×2 rebreather, 160 kg backpack) and a refined
 * cryo-fuel canister worth 1,200 cr on the exchange.
 */
export const VAULT_LOOT_TABLE: readonly VaultLootItem[] = [
  {
    id: 'vault-loot-fuel-cell',
    name: 'Auxiliary Buggy Fuel Cell',
    kind: 'fuel_cell',
    description: 'Fresh fuel cell — restores the traction pack to 100 % and permanently adds +15 kWh.',
    batteryKwhBonus: 15,
    creditValue: 900,
  },
  {
    id: 'vault-loot-eva-suit',
    name: 'Advanced Prospector EVA Suit',
    kind: 'suit_upgrade',
    description: 'Upgraded rebreather (double oxygen duration) and a 160 kg cargo backpack.',
    cargoCapacityBonusKg: 110,
    creditValue: 1500,
  },
  {
    id: 'vault-loot-cryo-canister',
    name: 'Refined Cryo-Fuel Canister',
    kind: 'cryo_canister',
    description: 'Sealed refined cryo-fuel — a high-value trade commodity (1,200 cr).',
    creditValue: 1200,
  },
] as const;

/** An openable bunker per terminal cavern node (blueprint §2.2 shape). */
export interface UndergroundBunker {
  nodeId: string;
  name: string;
  center: Vec3;
  dimensions: { width: number; length: number; height: number };
  doorState: VaultDoorState;
  lootItems: VaultLootItem[];
  /** True once the sanctum loot has been claimed (granted exactly once). */
  lootClaimed: boolean;
  /** Door leaf id this bunker's bulkhead answers to (`vault-door-01` …). */
  doorId: string;
}

/** Reinforced bulkhead record returned by {@link TunnelNetwork.getVaultDoors}. */
export interface VaultDoorRecord {
  /** Stable mesh-family id, e.g. `vault-door-01`. */
  id: string;
  /** Cavern node id the door seals. */
  vaultId: string;
  state: VaultDoorState;
  /** World-frame door centre (x, y lateral, z up), metres. */
  position: Vec3;
  /** Human bunker name for prompts / toasts. */
  bunkerName: string;
}

/** Security terminal console record (proximity-interactable keypad). */
export interface VaultTerminalRecord {
  id: string;
  vaultId: string;
  position: Vec3;
  /** Mesh, present only while the network is built. */
  mesh: Mesh | null;
}

/** Surface shaft-head portal record (concrete collar + gantry + bore rings). */
export interface SurfacePortalRecord {
  id: string;
  /** Node id at the mouth (typically a `shaft_head`). */
  nodeId: string;
  /** Neon beacon identification text, e.g. `SHAFT 04 // MINE SHAFT ADIT`. */
  label: string;
  /** World-frame mouth position, metres. */
  position: Vec3;
}

/** Options accepted by the {@link TunnelNetwork} constructor. */
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

// -- Spec 21 §2.4 facility helpers ---------------------------------------------

/** Deterministic 32-bit string hash (FNV-1a) — stable per seed/id, no RNG needed. */
function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Unit WORLD direction → Babylon-frame quaternion aligning a mesh's local +Y
 * with it. `worldToBabylon` is linear (world x,y,z → babylon x,z,−y), so the
 * direction converts without translation and the identity-up quaternion
 * carries the degenerate zero-vector case.
 */
function alignUpToWorld(worldDir: Vec3): Quaternion {
  const dir = new Vector3(worldDir.x, worldDir.z, -worldDir.y);
  if (dir.lengthSquared() < 1e-12) return new Quaternion();
  dir.normalize();
  const q = new Quaternion();
  Quaternion.FromUnitVectorsToRef(Vector3.Up(), dir, q);
  return q;
}

/** Horizontal (x,y-plane) unit vector between two world points; fallback when concentric. */
function horizontalUnit(from: Vec3, to: Vec3, fallbackId: string): Vec3 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len > 1e-6) return { x: dx / len, y: dy / len, z: 0 };
  // Vertical shaft with no horizontal lean: deterministic per-node heading.
  const angle = (hashString(fallbackId) % 3600) / 10 * (Math.PI / 180);
  return { x: Math.cos(angle), y: Math.sin(angle), z: 0 };
}

/** Add world offset (a·u + b·v + c·k) to a base point; k = world up. */
function offsetWorld(base: Vec3, u: Vec3, v: Vec3, a: number, b: number, c: number): Vec3 {
  return { x: base.x + u.x * a + v.x * b, y: base.y + u.y * a + v.y * b, z: base.z + c };
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

  // -- Spec 21 §2.4 facility state (portals, bunkers, vaults) -------------------
  /** Every portal/bunker/vault mesh, disposed with the network. */
  private facilityMeshes: Mesh[] = [];
  /** Facility materials (concrete, hazard, steel, amber, CRT, beacons). */
  private facilityMaterials: (PBRMaterial | StandardMaterial)[] = [];
  /** Facility roots (portal-/bunker- TransformNodes), disposed on teardown. */
  private facilityRoots: TransformNode[] = [];
  /** Dynamic beacon textures (canvas-backed; browser only). */
  private facilityTextures: DynamicTexture[] = [];
  /** Surface shaft portals keyed by portal id. */
  private portals = new Map<string, SurfacePortalRecord>();
  /** Bunker chambers keyed by cavern node id. */
  private bunkers = new Map<string, UndergroundBunker>();
  /** Vault door records keyed by door id (`vault-door-01` …). */
  private vaultDoors = new Map<string, VaultDoorRecord>();
  /** Security terminal records keyed by terminal id. */
  private vaultTerminals = new Map<string, VaultTerminalRecord>();
  /** Door-leaf meshes + slide bookkeeping keyed by door id. */
  private readonly doorMeshes = new Map<
    string,
    { left: Mesh; right: Mesh; closedX: number[]; openOffset: number[] }
  >();
  /** Beacon materials per vault keyed by vault (cavern node) id. */
  private readonly vaultBeaconMaterials = new Map<string, StandardMaterial>();
  private facilitySeq = 0;

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
   * Spec 21 §2.4: walkable interior floor elevation beneath a world-frame
   * point, or null when the point is in open air. Inside a bored bore the
   * floor is the segment's lowest point (`axis z − radius`); inside a bunker
   * chamber (footprint tested in the chamber's own approach frame — the
   * point may stand beside the security terminal where no bore passes) it is
   * the chamber floor slab at `center.z`. The DEEPEST containment wins, so
   * a shaft mouth directly above a chamber never floors you into the wall.
   * This is the seam `ClientApp.groundAt` uses so EVA/buggy poses survive
   * one physics frame underground instead of popping to the surface.
   */
  getInteriorFloor(p: Vec3): number | null {
    if (this.disposed) return null;
    let best: number | null = null;
    for (const segment of this.segments) {
      const foot = closestOnSegment(p, segment.start, segment.end);
      if (dist3(p, foot) <= segment.radius) {
        const floor = Math.min(segment.start.z, segment.end.z) - segment.radius;
        if (best === null || floor < best) best = floor;
      }
    }
    for (const bunker of this.bunkers.values()) {
      const a = this.bunkerApproachBearing(bunker.nodeId);
      const dx = p.x - bunker.center.x;
      const dy = p.y - bunker.center.y;
      const lat = dx * a.y - dy * a.x;
      const along = -(dx * a.x + dy * a.y);
      const vert = p.z - bunker.center.z;
      if (
        Math.abs(lat) <= bunker.dimensions.width / 2 &&
        Math.abs(along) <= bunker.dimensions.length / 2 &&
        vert >= -bunker.dimensions.height &&
        vert <= bunker.dimensions.height
      ) {
        const floor = bunker.center.z;
        if (best === null || floor < best) best = floor;
      }
    }
    return best;
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
    for (const mesh of this.facilityMeshes) TunnelNetwork.disposeQuietly(mesh);
    this.facilityMeshes = [];
    for (const material of this.facilityMaterials) TunnelNetwork.disposeQuietly(material);
    this.facilityMaterials = [];
    for (const texture of this.facilityTextures) TunnelNetwork.disposeQuietly(texture);
    this.facilityTextures = [];
    for (const node of this.facilityRoots) TunnelNetwork.disposeQuietly(node);
    this.facilityRoots = [];
    this.doorMeshes.clear();
    this.vaultBeaconMaterials.clear();
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

  // -- Spec 21 §2.4: surface portals, bunkers & vaults ------------------------------

  /**
   * Ensure portal/bunker/vault records exist even when `init()` never built
   * meshes (headless query-only use): `load()` alone cannot build them, so
   * every facility query calls through this idempotent guard first.
   */
  private facilitiesReady(): void {
    if (!this.disposed && (this.bunkers.size + this.portals.size) === 0) {
      this.ensureFacilityRecords();
    }
  }

  /** Every surface shaft portal (read-only records; z ≥ −2 m mouths only). */
  getSurfacePortals(): ReadonlyArray<SurfacePortalRecord> {
    this.facilitiesReady();
    return [...this.portals.values()];
  }

  /**
   * Locked security bulkheads / vault doors (Spec 21 §2.4). Doors report
   * `locked` → `unlocked` → `open` with the world-frame door centre for
   * proximity prompts and map pips.
   */
  getVaultDoors(): ReadonlyArray<VaultDoorRecord> {
    this.facilitiesReady();
    return [...this.vaultDoors.values()];
  }

  /** Security terminal consoles beside each vault door. */
  getVaultTerminals(): ReadonlyArray<VaultTerminalRecord> {
    this.facilitiesReady();
    return [...this.vaultTerminals.values()];
  }

  /** Bunker chambers keyed per cavern node (dimensions, door state, loot). */
  getBunkers(): ReadonlyArray<UndergroundBunker> {
    this.facilitiesReady();
    return [...this.bunkers.values()];
  }

  /** Door state for one vault (cavern node id); null when unknown. */
  getVaultDoorState(vaultId: string): VaultDoorState | null {
    this.facilitiesReady();
    const bunker = this.bunkers.get(vaultId);
    return bunker === undefined ? null : bunker.doorState;
  }

  /**
   * `locked → unlocked` for a bunker's bulkhead (Spec 21 §2.4 state machine):
   * red beacon switches to green. Accepts either the cavern node id or the
   * door id (`vault-door-01`). Idempotent; `open` doors stay open.
   * Returns the resulting state, or null when the vault is unknown.
   */
  unlockVault(vaultIdOrDoorId: string): VaultDoorState | null {
    this.facilitiesReady();
    const bunker = this.resolveBunker(vaultIdOrDoorId);
    if (bunker === null) return null;
    if (bunker.doorState === 'locked') {
      bunker.doorState = 'unlocked';
      const beacon = this.vaultBeaconMaterials.get(bunker.nodeId);
      if (beacon !== undefined) {
        beacon.emissiveColor = new Color3(0.08, 1.0, 0.25); // green = unlocked
      }
      const doorRecord = this.vaultDoors.get(bunker.doorId);
      if (doorRecord !== undefined) doorRecord.state = 'unlocked';
    }
    return bunker.doorState;
  }

  /**
   * Slide an UNLOCKED door's leaves into the wall recess (`unlocked → open`).
   * A locked door refuses (returns its state); unknown vaults return null.
   * Opening does not grant loot — see {@link claimVaultLoot}.
   */
  openVault(vaultIdOrDoorId: string): VaultDoorState | null {
    this.facilitiesReady();
    const bunker = this.resolveBunker(vaultIdOrDoorId);
    if (bunker === null) return null;
    if (bunker.doorState === 'locked') return bunker.doorState;
    if (bunker.doorState === 'unlocked') {
      bunker.doorState = 'open';
      const leaf = this.doorMeshes.get(bunker.doorId);
      if (leaf !== undefined) {
        // Slide both leaves into the recess along the local X axis.
        leaf.left.position.x = leaf.openOffset[0];
        leaf.right.position.x = leaf.openOffset[1];
      }
      const doorRecord = this.vaultDoors.get(bunker.doorId);
      if (doorRecord !== undefined) doorRecord.state = 'open';
    }
    return bunker.doorState;
  }

  /**
   * Hand the sanctum's high-value loot to the player exactly once (idempotent
   * per bunker): returns the loot items on the first successful claim after
   * the door is open, or null when locked/unknown/already claimed. The caller
   * (ClientApp) converts each item's bonuses into entity/stat updates.
   */
  claimVaultLoot(vaultIdOrDoorId: string): VaultLootItem[] | null {
    this.facilitiesReady();
    const bunker = this.resolveBunker(vaultIdOrDoorId);
    if (bunker === null) return null;
    if (bunker.doorState !== 'open' || bunker.lootClaimed) return null;
    bunker.lootClaimed = true;
    return bunker.lootItems.map((item) => ({ ...item }));
  }

  /**
   * Nearest security terminal to a world-frame point within `radiusM`
   * (default {@link VAULT_TERMINAL_RANGE_M}); null when none is in reach.
   */
  getNearestVaultTerminal(
    p: Vec3,
    radiusM: number = VAULT_TERMINAL_RANGE_M,
  ): (VaultTerminalRecord & { distance: number }) | null {
    this.facilitiesReady();
    const reach = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : 0;
    let best: (VaultTerminalRecord & { distance: number }) | null = null;
    for (const terminal of this.vaultTerminals.values()) {
      const distance = dist3(p, terminal.position);
      if (distance <= reach && (best === null || distance < best.distance)) {
        best = { ...terminal, distance };
      }
    }
    return best;
  }

  /** Resolve a bunker by cavern node id or by vault-door id. */
  private resolveBunker(vaultIdOrDoorId: string): UndergroundBunker | null {
    const direct = this.bunkers.get(vaultIdOrDoorId);
    if (direct !== undefined) return direct;
    for (const bunker of this.bunkers.values()) {
      if (bunker.doorId === vaultIdOrDoorId) return bunker;
    }
    return null;
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

    // Spec 21 §2.4 — surface shaft portals and underground bunker facilities.
    this.buildFacilityMeshes(scene);
  }

  // -- Spec 21 §2.4: facility records (scene-free) --------------------------------

  /**
   * Derive portal / bunker / vault records from the world data alone (no
   * scene, no meshes): every tunnel mouth at z ≥ {@link SURFACE_PORTAL_MIN_Z_M}
   * gets a portal, every `cavern` node a bunker chamber with a locked vault
   * door and a security terminal. Idempotent — records survive `dispose()`
   * so harnesses and prompts keep answering after teardown.
   */
  private ensureFacilityRecords(): void {
    if (this.disposed) return;

    if (this.portals.size === 0) {
      const seenMouths = new Set<string>();
      let shaftSeq = 0;
      for (const segment of this.segments) {
        for (const end of [segment.end, segment.start] as const) {
          if (end.z < SURFACE_PORTAL_MIN_Z_M) continue;
          const key = `${end.x.toFixed(2)},${end.y.toFixed(2)},${end.z.toFixed(2)}`;
          if (seenMouths.has(key)) continue;
          seenMouths.add(key);
          shaftSeq += 1;
          const id = `surface-portal-${shaftSeq}`;
          const kindLabel = segment.kind.toUpperCase().replace(/_/g, ' ');
          const label = `SHAFT ${String(shaftSeq).padStart(2, '0')} // ${kindLabel}`;
          const intoRock = horizontalUnit(end, end === segment.end ? segment.start : segment.end, `${segment.id}#mouth`);
          const tang: Vec3 = {
            x: (end === segment.end ? segment.start.x - end.x : segment.end.x - end.x),
            y: (end === segment.end ? segment.start.y - end.y : segment.end.y - end.y),
            z: (end === segment.end ? segment.start.z - end.z : segment.end.z - end.z),
          };
          const len = Math.hypot(tang.x, tang.y, tang.z);
          const tangent = len > 1e-6 ? { x: tang.x / len, y: tang.y / len, z: tang.z / len } : { x: intoRock.x, y: intoRock.y, z: 0 };
          const node = this.nodes.find((n) => dist3(n.position, end) < 0.01) ?? null;
          const record: SurfacePortalRecord & { tangent: Vec3 } = {
            id,
            nodeId: node?.id ?? segment.id,
            label,
            position: { ...end },
            tangent,
          };
          this.portals.set(id, record);
        }
      }
    }

    if (this.bunkers.size === 0) {
      let bunkerSeq = 0;
      for (const node of this.nodes) {
        if (node.kind !== 'cavern') continue;
        bunkerSeq += 1;
        const doorId = `${VAULT_DOOR_ID_PREFIX}-${String(bunkerSeq).padStart(2, '0')}`;
        this.bunkers.set(node.id, {
          nodeId: node.id,
          name: node.name,
          center: { ...node.position },
          dimensions: { ...BUNKER_DIMENSIONS_M },
          doorState: 'locked',
          lootItems: VAULT_LOOT_TABLE.map((item) => ({ ...item })),
          lootClaimed: false,
          doorId,
        });
        const doorPos: Vec3 = { ...node.position };
        this.vaultDoors.set(doorId, {
          id: doorId,
          vaultId: node.id,
          state: 'locked',
          position: doorPos,
          bunkerName: node.name,
        });
        const terminalId = `security-terminal-${String(bunkerSeq).padStart(2, '0')}`;
        this.vaultTerminals.set(terminalId, {
          id: terminalId,
          vaultId: node.id,
          position: { ...node.position }, // refined once the approach frame is known
          mesh: null,
        });
      }
    }
  }

  // -- Spec 21 §2.4: facility meshes (procedural only, ADR-021-1) -------------------

  /** Build portal + bunker meshes under the network root. */
  private buildFacilityMeshes(scene: Scene): void {
    this.ensureFacilityRecords();
    if (this.root === null) return;

    for (const record of this.portals.values()) {
      this.buildSurfacePortalMesh(scene, record as SurfacePortalRecord & { tangent?: Vec3 });
    }
    for (const bunker of this.bunkers.values()) {
      this.buildBunkerMesh(scene, bunker);
    }
  }

  /** Shared facility material factory (disposed with the network). */
  private facilityMaterial(
    kind: 'concrete' | 'hazardYellow' | 'hazardBlack' | 'steel' | 'amber' | 'crtGreen' | 'neonCyan' | 'beaconRed' | 'beaconGreen',
    scene: Scene,
  ): PBRMaterial | StandardMaterial {
    const existing = this.facilityMaterials.find((m) => m.name === `${this.prefix}-fac-${kind}`);
    if (existing !== undefined) return existing;
    let material: PBRMaterial | StandardMaterial;
    switch (kind) {
      case 'concrete': {
        const m = new PBRMaterial(`${this.prefix}-fac-concrete`, scene);
        m.albedoColor = new Color3(0.52, 0.5, 0.47);
        m.roughness = 0.92;
        m.metallic = 0.02;
        material = m;
        break;
      }
      case 'hazardYellow': {
        const m = new StandardMaterial(`${this.prefix}-fac-hazard-yellow`, scene);
        m.diffuseColor = new Color3(0.95, 0.78, 0.05);
        m.emissiveColor = new Color3(0.22, 0.17, 0.0);
        material = m;
        break;
      }
      case 'hazardBlack': {
        const m = new StandardMaterial(`${this.prefix}-fac-hazard-black`, scene);
        m.diffuseColor = new Color3(0.04, 0.04, 0.045);
        m.emissiveColor = new Color3(0.01, 0.01, 0.01);
        material = m;
        break;
      }
      case 'steel': {
        const m = new PBRMaterial(`${this.prefix}-fac-steel`, scene);
        m.albedoColor = new Color3(0.45, 0.46, 0.5);
        m.roughness = 0.38;
        m.metallic = 0.85;
        material = m;
        break;
      }
      case 'amber': {
        const m = new StandardMaterial(`${this.prefix}-fac-amber`, scene);
        m.diffuseColor = new Color3(0.3, 0.18, 0.02);
        m.emissiveColor = new Color3(1.0, 0.55, 0.06);
        material = m;
        break;
      }
      case 'crtGreen': {
        const m = new StandardMaterial(`${this.prefix}-fac-crt-green`, scene);
        m.diffuseColor = new Color3(0.02, 0.1, 0.02);
        m.emissiveColor = new Color3(0.15, 0.95, 0.3);
        material = m;
        break;
      }
      case 'neonCyan': {
        const m = new StandardMaterial(`${this.prefix}-fac-neon-cyan`, scene);
        m.diffuseColor = new Color3(0.05, 0.3, 0.35);
        m.emissiveColor = new Color3(0.15, 0.9, 1.0);
        material = m;
        break;
      }
      case 'beaconRed': {
        const m = new StandardMaterial(`${this.prefix}-fac-beacon-red`, scene);
        m.diffuseColor = new Color3(0.2, 0.01, 0.01);
        m.emissiveColor = new Color3(1.0, 0.05, 0.05);
        material = m;
        break;
      }
      case 'beaconGreen': {
        const m = new StandardMaterial(`${this.prefix}-fac-beacon-green`, scene);
        m.diffuseColor = new Color3(0.01, 0.2, 0.02);
        m.emissiveColor = new Color3(0.08, 1.0, 0.25);
        material = m;
        break;
      }
    }
    this.facilityMaterials.push(material);
    return material;
  }

  /** Register a facility mesh (parent + bookkeeping for disposal). */
  private facility(
    mesh: Mesh,
    scene: Scene,
    parent: TransformNode | null,
    metadata?: Record<string, unknown>,
  ): Mesh {
    mesh.parent = parent ?? this.root;
    mesh.isPickable = true;
    if (metadata !== undefined) mesh.metadata = metadata;
    this.facilityMeshes.push(mesh);
    void scene;
    return mesh;
  }

  /**
   * Surface shaft portal (Spec 21 §2.4 §1): hazard-striped concrete collar
   * abutment, overhead gantry with an illuminated neon identification
   * beacon, and twin steel bore rings lining the first 12 m of rock.
   */
  private buildSurfacePortalMesh(
    scene: Scene,
    record: SurfacePortalRecord & { tangent?: Vec3 },
  ): void {
    const p = record.position;
    const tangent = record.tangent ?? { x: 0, y: 1, z: 0 };
    // Horizontal frame at the mouth: `into` follows the tunnel bearing,
    // `cross` is the horizontal perpendicular (collar left/right axis).
    const into = horizontalUnit({ x: 0, y: 0, z: 0 }, tangent, record.id);
    const cross: Vec3 = { x: -into.y, y: into.x, z: 0 };
    const root = new TransformNode(record.id, scene);
    root.parent = this.root;
    // Portal children carry absolute worldToBabylon positions, so the portal
    // root deliberately stays at the origin (no double offset).
    this.facilityRoots.push(root);

    const concrete = this.facilityMaterial('concrete', scene);
    const yellow = this.facilityMaterial('hazardYellow', scene);
    const black = this.facilityMaterial('hazardBlack', scene);
    const steel = this.facilityMaterial('steel', scene);

    // Concrete abutment: hazard-striped pillars (stacked alternating blocks)
    // either side of the mouth + a concrete lintel across the collar.
    for (const side of [-1, 1]) {
      for (let level = 0; level < 6; level++) {
        const block = MeshBuilder.CreateBox(
          `${record.id}-collar-${side < 0 ? 'l' : 'r'}-${level}`,
          { width: 1.4, height: 0.8, depth: 1.4 },
          scene,
        );
        block.position.copyFrom(
          worldToBabylon(offsetWorld(p, cross, into, side * 3.6, 0, -0.4 + level * 0.8)),
        );
        block.material = level % 2 === 0 ? yellow : black;
        this.facility(block, scene, root, { facility: 'portal-collar', portalId: record.id });
      }
      const wing = MeshBuilder.CreateBox(
        `${record.id}-collar-wing-${side < 0 ? 'l' : 'r'}`,
        { width: 1.0, height: 5.2, depth: 3.2 },
        scene,
      );
      wing.position.copyFrom(worldToBabylon(offsetWorld(p, cross, into, side * 5.2, 0.6, 2.2)));
      wing.material = concrete;
      this.facility(wing, scene, root, { facility: 'portal-abutment', portalId: record.id });
    }
    const lintel = MeshBuilder.CreateBox(
      `${record.id}-lintel`,
      { width: 9.6, height: 1.3, depth: 2.2 },
      scene,
    );
    lintel.position.copyFrom(worldToBabylon(offsetWorld(p, cross, into, 0, -0.4, 5.0)));
    lintel.material = concrete;
    this.facility(lintel, scene, root, { facility: 'portal-lintel', portalId: record.id });

    // Overhead gantry: steel legs + crossbeam above the lintel.
    for (const side of [-1, 1]) {
      const leg = MeshBuilder.CreateBox(
        `${record.id}-gantry-leg-${side < 0 ? 'l' : 'r'}`,
        { width: 0.35, height: 3.4, depth: 0.35 },
        scene,
      );
      leg.position.copyFrom(worldToBabylon(offsetWorld(p, cross, into, side * 4.2, -0.4, 7.3)));
      leg.material = steel;
      this.facility(leg, scene, root, { facility: 'portal-gantry', portalId: record.id });
    }
    const crossbeam = MeshBuilder.CreateBox(
      `${record.id}-gantry-beam`,
      { width: 9.6, height: 0.45, depth: 0.6 },
      scene,
    );
    crossbeam.position.copyFrom(worldToBabylon(offsetWorld(p, cross, into, 0, -0.4, 9.1)));
    crossbeam.material = steel;
    this.facility(crossbeam, scene, root, { facility: 'portal-gantry', portalId: record.id });

    // Neon identification beacon (spec: `SHAFT 04 // DEEP SECTOR ADIT`).
    const beacon = MeshBuilder.CreateBox(
      `${record.id}-beacon`,
      { width: 6.4, height: 1.5, depth: 0.18 },
      scene,
    );
    beacon.position.copyFrom(worldToBabylon(offsetWorld(p, cross, into, 0, -1.2, 8.1)));
    beacon.material = this.facilityMaterial('neonCyan', scene);
    const beaconText = this.paintBeaconTexture(record.label, scene);
    if (beaconText !== null) {
      const mat = beacon.material as StandardMaterial;
      mat.emissiveTexture = beaconText;
      mat.diffuseTexture = beaconText;
    }
    this.facility(beacon, scene, root, {
      facility: 'portal-beacon',
      portalId: record.id,
      label: record.label,
    });

    // Twin steel bore rings lining the first 12 m into the rock along the
    // true 3D tunnel tangent (a vertical shaft lines them down its barrel).
    const t3 = record.tangent ?? { x: into.x, y: into.y, z: 0 };
    for (let i = 0; i < PORTAL_BORE_RING_OFFSETS_M.length; i++) {
      const ring = MeshBuilder.CreateCylinder(
        `${record.id}-bore-ring-${i + 1}`,
        { height: 0.7, diameter: 6.4, tessellation: 20 },
        scene,
      );
      const off = PORTAL_BORE_RING_OFFSETS_M[i];
      ring.position.copyFrom(
        worldToBabylon({ x: p.x + t3.x * off, y: p.y + t3.y * off, z: p.z + t3.z * off }),
      );
      ring.rotationQuaternion = alignUpToWorld(t3);
      ring.material = steel;
      this.facility(ring, scene, root, {
        facility: 'portal-bore-ring',
        portalId: record.id,
        depthIntoRockM: off,
      });
    }
  }

  /** Paint a neon beacon label; returns null where no canvas backend exists. */
  private paintBeaconTexture(label: string, scene: Scene): DynamicTexture | null {
    try {
      const texture = new DynamicTexture(`${this.prefix}-beacon-text`, { width: 512, height: 128 }, scene, true);
      texture.drawText(label, null, 88, 'bold 56px monospace', '#8ff9ff', '#021016');
      this.facilityTextures.push(texture);
      return texture;
    } catch {
      // NullEngine / no OffscreenCanvas backend: the emissive panel stays,
      // the label lives on mesh.metadata.label for prompts & harnesses.
      return null;
    }
  }

  /**
   * Underground control bunker (Spec 21 §2.4 §2/§3): 30 × 20 × 8 m chamber
   * with arched ceiling rib trusses, wall cable trays, amber emergency
   * bulkhead strip lights, modular consoles with green vector CRTs, a
   * reinforced vault door on the far wall and a security terminal beside it.
   *
   * Local frame (proper right-handed rotation under worldToBabylon):
   * +X = world d = (a.y, −a.x, 0) (right of the approach), +Y = up,
   * +Z = approach bearing a (entry gap on −Z, vault door on +Z).
   */
  private buildBunkerMesh(scene: Scene, bunker: UndergroundBunker): void {
    const { width, length, height } = bunker.dimensions;
    const c = bunker.center;
    const a = this.bunkerApproachBearing(bunker.nodeId);
    const d: Vec3 = { x: a.y, y: -a.x, z: 0 };

    const root = new TransformNode(`bunker-${bunker.nodeId}`, scene);
    root.parent = this.root;
    root.position.copyFrom(worldToBabylon(c));
    // Babylon has no FromXYZAxes in this build — compose the same rotation
    // by hand: columns of the matrix are the BABYLON images of the local
    // axes (d → +X, up → +Y, a → +Z), row-major for Matrix.FromValues.
    const dA = worldToBabylon(d);
    const uA = worldToBabylon({ x: 0, y: 0, z: 1 });
    const aA = worldToBabylon(a);
    root.rotationQuaternion = Quaternion.FromRotationMatrix(
      Matrix.FromValues(
        dA.x, uA.x, aA.x, 0,
        dA.y, uA.y, aA.y, 0,
        dA.z, uA.z, aA.z, 0,
        0, 0, 0, 1,
      ),
    );
    this.facilityRoots.push(root);

    const concrete = this.facilityMaterial('concrete', scene);
    const steel = this.facilityMaterial('steel', scene);
    const amber = this.facilityMaterial('amber', scene);
    const crt = this.facilityMaterial('crtGreen', scene);
    const halfW = width / 2;
    const halfL = length / 2;
    const local = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

    // Floor slab.
    const floor = MeshBuilder.CreateBox(`${bunker.doorId}-floor`, { width, height: 0.4, depth: length }, scene);
    floor.position.copyFrom(local(0, -0.2, 0));
    floor.material = concrete;
    this.facility(floor, scene, root, { facility: 'bunker-floor', vaultId: bunker.nodeId });

    // Entry wall (−Z, facing the arriving tunnel) with a 6 m centre gap.
    for (const side of [-1, 1]) {
      const seg = MeshBuilder.CreateBox(
        `${bunker.doorId}-front-${side < 0 ? 'l' : 'r'}`,
        { width: halfW - 3, height, depth: 0.6 },
        scene,
      );
      seg.position.copyFrom(local(side * (3 + (halfW - 3) / 2), height / 2, -halfL));
      seg.material = concrete;
      this.facility(seg, scene, root, { facility: 'bunker-wall', vaultId: bunker.nodeId });
    }

    // Long side walls (±X): cable trays at 2.5 m, amber strip lights at 7 m.
    for (const side of [-1, 1]) {
      const wall = MeshBuilder.CreateBox(
        `${bunker.doorId}-side-${side < 0 ? 'l' : 'r'}`,
        { width: 0.6, height, depth: length },
        scene,
      );
      wall.position.copyFrom(local(side * halfW, height / 2, 0));
      wall.material = concrete;
      this.facility(wall, scene, root, { facility: 'bunker-wall', vaultId: bunker.nodeId });

      const tray = MeshBuilder.CreateBox(
        `${bunker.doorId}-tray-${side < 0 ? 'l' : 'r'}`,
        { width: 0.5, height: 0.16, depth: length - 2 },
        scene,
      );
      tray.position.copyFrom(local(side * (halfW - 0.65), 2.5, 0));
      tray.material = steel;
      this.facility(tray, scene, root, { facility: 'bunker-cable-tray', vaultId: bunker.nodeId });

      for (let i = 0; i < 6; i++) {
        const strip = MeshBuilder.CreateBox(
          `${bunker.doorId}-amber-${side < 0 ? 'l' : 'r'}-${i}`,
          { width: 0.14, height: 0.28, depth: 2.2 },
          scene,
        );
        strip.position.copyFrom(local(side * (halfW - 0.45), height - 1, -halfL + 2 + i * ((length - 4) / 5)));
        strip.material = amber;
        this.facility(strip, scene, root, { facility: 'bunker-amber-strip', vaultId: bunker.nodeId });
      }
    }

    // Arched ceiling rib trusses: semicircular segment ribs spanning the
    // width (arc in local X–Y), stepped along the chamber length (Z).
    const ribRadius = halfW - 0.8;
    for (let r = 0; r < 5; r++) {
      const along = -halfL + 2 + r * ((length - 4) / 4);
      for (let s = 0; s < 7; s++) {
        const theta = (Math.PI * (s + 0.5)) / 7;
        const rib = MeshBuilder.CreateBox(
          `${bunker.doorId}-rib-${r}-${s}`,
          { width: 0.9, height: 0.32, depth: 0.32 },
          scene,
        );
        rib.position.copyFrom(local(
          Math.cos(theta) * ribRadius,
          height - 0.6 + Math.sin(theta) * ribRadius * 0.55,
          along,
        ));
        rib.rotation.z = theta;
        rib.material = steel;
        this.facility(rib, scene, root, { facility: 'bunker-ceiling-rib', vaultId: bunker.nodeId });
      }
    }

    // Modular computer consoles with flickering green vector CRTs.
    for (const side of [-1, 1]) {
      const desk = MeshBuilder.CreateBox(
        `${bunker.doorId}-console-${side < 0 ? 'l' : 'r'}`,
        { width: 3.4, height: 1.15, depth: 1.3 },
        scene,
      );
      desk.position.copyFrom(local(side * (halfW - 2.4), 0.58, -halfL + 4.2));
      desk.material = steel;
      this.facility(desk, scene, root, { facility: 'bunker-console', vaultId: bunker.nodeId });

      const screen = MeshBuilder.CreateBox(
        `${bunker.doorId}-crt-${side < 0 ? 'l' : 'r'}`,
        { width: 2.4, height: 1.5, depth: 0.12 },
        scene,
      );
      screen.position.copyFrom(local(side * (halfW - 2.4), 2.05, -halfL + 3.7));
      screen.rotation.x = -0.18;
      screen.material = crt;
      this.facility(screen, scene, root, { facility: 'bunker-vector-crt', vaultId: bunker.nodeId });
    }

    // Reinforced vault door (frame + twin sliding leaves + state beacon) on
    // the far (+Z) wall sealing the inner sanctum.
    const doorZ = halfL - 0.35;
    const frame = MeshBuilder.CreateBox(bunker.doorId, { width: 9.4, height: 6.6, depth: 0.8 }, scene);
    frame.position.copyFrom(local(0, 3.2, doorZ));
    frame.material = steel;
    this.facility(frame, scene, root, {
      facility: 'vault-door-frame',
      doorId: bunker.doorId,
      vaultId: bunker.nodeId,
    });

    const leafWidth = 4.2;
    const leaves: Mesh[] = [];
    for (const side of [-1, 1]) {
      const leaf = MeshBuilder.CreateBox(
        `${bunker.doorId}-leaf-${side < 0 ? 'l' : 'r'}`,
        { width: leafWidth, height: 5.6, depth: 0.55 },
        scene,
      );
      leaf.position.copyFrom(local(side * (leafWidth / 2), 2.8, doorZ + 0.15));
      leaf.material = steel;
      this.facility(leaf, scene, root, {
        facility: 'vault-door',
        doorId: bunker.doorId,
        vaultId: bunker.nodeId,
      });
      leaves.push(leaf);
    }
    this.doorMeshes.set(bunker.doorId, {
      left: leaves[0]!,
      right: leaves[1]!,
      closedX: [-leafWidth / 2, leafWidth / 2],
      openOffset: [-leafWidth / 2 - leafWidth, leafWidth / 2 + leafWidth],
    });

    // Door record anchors at the bulkhead face's world centre.
    const doorRecord = this.vaultDoors.get(bunker.doorId);
    if (doorRecord !== undefined) {
      doorRecord.position = {
        x: bunker.center.x + a.x * doorZ,
        y: bunker.center.y + a.y * doorZ,
        z: bunker.center.z + 2.8,
      };
    }

    const beacon = MeshBuilder.CreateSphere(`${bunker.doorId}-beacon`, { diameter: 0.55, segments: 10 }, scene);
    beacon.position.copyFrom(local(0, 6.9, doorZ));
    const beaconMat = new StandardMaterial(`${this.prefix}-vault-beacon-${bunker.nodeId}`, scene);
    beaconMat.diffuseColor = new Color3(0.2, 0.01, 0.01);
    beaconMat.emissiveColor = new Color3(1, 0.05, 0.05); // locked = red
    beacon.material = beaconMat;
    this.vaultBeaconMaterials.set(bunker.nodeId, beaconMat);
    this.facilityMaterials.push(beaconMat);
    this.facility(beacon, scene, root, { facility: 'vault-beacon', vaultId: bunker.nodeId });

    // Security terminal console beside the vault door (world anchor matches
    // the record written in `ensureFacilityRecords`).
    this.buildSecurityTerminalMesh(scene, bunker, root, a, d, doorZ - 1.35);
  }

  /**
   * Pedestal keypad console answering `[E] Interface Security Terminal`
   * (Spec 21 §2.4 §3).
   */
  private buildSecurityTerminalMesh(
    scene: Scene,
    bunker: UndergroundBunker,
    root: TransformNode,
    a: Vec3,
    d: Vec3,
    localZ: number,
  ): Mesh {
    const steel = this.facilityMaterial('steel', scene);
    const crt = this.facilityMaterial('crtGreen', scene);
    const record = [...this.vaultTerminals.values()].find((t) => t.vaultId === bunker.nodeId);
    const terminalId = record?.id ?? `security-terminal-${bunker.doorId}`;
    const localX = 6.2;

    const pedestal = MeshBuilder.CreateCylinder(
      `${terminalId}-pedestal`,
      { height: 1.05, diameterTop: 0.5, diameter: 0.42, tessellation: 12 },
      scene,
    );
    pedestal.position.set(localX, 0.52, localZ);
    pedestal.material = steel;
    this.facility(pedestal, scene, root, { facility: 'security-terminal', terminalId, vaultId: bunker.nodeId });

    const housing = MeshBuilder.CreateBox(
      `${terminalId}-housing`,
      { width: 1.25, height: 0.85, depth: 0.34 },
      scene,
    );
    housing.position.set(localX, 1.5, localZ);
    housing.rotation.x = 0.28;
    housing.material = steel;
    this.facility(housing, scene, root, { facility: 'security-terminal', terminalId, vaultId: bunker.nodeId });

    const screen = MeshBuilder.CreateBox(
      `${terminalId}-screen`,
      { width: 1.0, height: 0.6, depth: 0.05 },
      scene,
    );
    screen.position.set(localX, 1.56, localZ - 0.21);
    screen.rotation.x = 0.28;
    screen.material = crt;
    this.facility(screen, scene, root, { facility: 'security-terminal', terminalId, vaultId: bunker.nodeId });

    // Anchor the record at the pedestal's WORLD position (spec 21 reach test),
    // composed from the same frame the meshes were placed in: world =
    // center + a·localZ + d·localX, console face height +1.2 m.
    if (record !== undefined) {
      record.position = {
        x: bunker.center.x + a.x * localZ + d.x * localX,
        y: bunker.center.y + a.y * localZ + d.y * localX,
        z: bunker.center.z + 1.2,
      };
      record.mesh = housing;
    }
    return housing;
  }

  /**
   * Unit horizontal bearing from which tunnels arrive at a cavern node
   * (average over all incident segments, away from the far endpoint and
   * toward the node). Deterministic scene-free fallback when degenerate.
   */
  private bunkerApproachBearing(nodeId: string): Vec3 {
    let ax = 0;
    let ay = 0;
    for (const segment of this.segments) {
      let far: Vec3 | null = null;
      if (segment.toId === nodeId) far = segment.start;
      else if (segment.fromId === nodeId) far = segment.end;
      if (far === null) continue;
      const node = this.nodeIndex.get(nodeId);
      if (node === undefined) continue;
      const u = horizontalUnit(far, node.position, `${segment.id}#${nodeId}`);
      ax += u.x;
      ay += u.y;
    }
    return horizontalUnit({ x: 0, y: 0, z: 0 }, { x: ax, y: ay, z: 0 }, nodeId);
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
