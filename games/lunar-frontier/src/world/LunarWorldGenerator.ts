/**
 * Lunar Frontier — procedural world, tunnel network, and resource vein generator.
 *
 * Generates a deterministic (seed-reproducible) snapshot of the Second Lunar
 * Rush map:
 *
 *  - **Sectors & craters** — a grid of mining sectors over mare basalt,
 *    highland terrane, and the permanently-shadowed polar crater belt.
 *  - **Tunnel network** — meandering lava tubes at depth, drilled mine shafts
 *    dropping from surface shaft heads, and underground outpost caverns.
 *  - **Resource veins** — regolith (surface), water ice (shadowed polar
 *    crater floors & deep tubes), titanium/ilménite (mare basalt),
 *    helium-3 (solar-wind-exposed surfaces), rare earths (deep KREEP terrane).
 *  - **Rail network** — narrow-gauge (0.75 m) routes chaining mining outposts,
 *    freight loading docks, refinery hubs, and down-shaft deep freight lines.
 *
 * Coordinate system: `(x, y, z)` metres in a local tangent frame. `x`/`y`
 * are lateral; `z` is elevation — **z >= 0 is lunar surface terrain height
 * (relative to the datum plain) and z < 0 is subterranean depth**. Crater
 * floors sit below datum (negative z) but are open sky; anything enclosed by
 * rock lives strictly at z < 0.
 *
 * The generator is pure: no clocks, no Math.random, no iteration order
 * surprises. The same seed yields a byte-identical snapshot (see `digest()`).
 *
 * Usage:
 *   const gen = new LunarWorldGenerator('mala-voyage-2431');
 *   const world = gen.generate();                 // WorldSnapshot
 *   const avail = gen.resourceAvailable('water_ice', x, y, z);
 *   const est   = gen.estimateExtraction('water_ice', x, y, z, 'buggy', { drillTier: 2 });
 *   const path  = gen.findTunnelPath('node-12', 'node-34');
 */

// ---------------------------------------------------------------------------
// Geometry & domain primitives
// ---------------------------------------------------------------------------

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Terrain class of a sector. */
export type Terrane = 'mare' | 'highland' | 'polar';

/** What a node *is*, functionally, in the frontier. */
export type NodeKind =
  | 'refinery' // refinery hub (ore sorting, smelters)
  | 'dock' // freight loading dock
  | 'outpost' // mining outpost
  | 'shaft_head' // surface collar of a drilled mine shaft
  | 'cavern' // underground outpost cavern
  | 'junction'; // tunnel junction / vent / shaft bottom

/** How a tunnel segment was made. */
export type TunnelKind =
  | 'lava_tube' // natural void
  | 'mine_shaft' // drilled from the surface
  | 'cavern_adit' // hand-mined drift off a tube into a cavern
  | 'ramp'; // wheeled access ramp (buggy-gauge)

export type ResourceKind =
  | 'regolith'
  | 'water_ice'
  | 'titanium'
  | 'helium_3'
  | 'rare_earth';

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'regolith',
  'water_ice',
  'titanium',
  'helium_3',
  'rare_earth',
];

/** Extraction rigs: EVA hand-drill, buggy-mounted loader, rail freight hopper. */
export type ExtractionMode = 'suit' | 'buggy' | 'freight';

export interface LunarNode {
  id: string;
  kind: NodeKind;
  name: string;
  position: Vec3;
  /** Sector whose bounds contain the node's (x, y). */
  sectorId: string;
}

export interface TunnelSegment {
  id: string;
  kind: TunnelKind;
  /** Endpoint node ids (segment is bidirectional for traversal). */
  fromId: string;
  toId: string;
  start: Vec3;
  end: Vec3;
  /** Bored radius in metres. */
  radius: number;
  length: number;
}

export interface ResourceVein {
  id: string;
  kind: ResourceKind;
  /** Spherical centre of the ore body. */
  center: Vec3;
  radius: number;
  /** Depth below datum in metres (positive number; 0 == surface deposit). */
  depth: number;
  /** Original in-situ units. */
  abundance: number;
  /** Units still in place (mutated by `harvest`). */
  remaining: number;
  /** Ore grade multiplier ~0.55–1.45 applied to yield and price. */
  purity: number;
  sectorId: string;
  /** Node ids whose proximity exposes this vein to miners. */
  hostNodeIds: string[];
  /** Tunnel segment ids that cut through this vein. */
  hostTunnelIds: string[];
}

export interface RailRoute {
  id: string;
  name: string;
  /** Ordered node ids from origin terminal to destination terminal. */
  nodeIds: string[];
  /** Track gauge in metres (narrow gauge, spec 12). */
  gauge: number;
  length: number;
  kind: 'surface' | 'tunnel' | 'mixed';
}

export interface WorldSector {
  id: string;
  name: string;
  terrane: Terrane;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  center: { x: number; y: number };
  craterIds: string[];
  /** Mining claim pressure assigned by survey: 0 (quiet) .. 1 (hot). */
  claimPressure: number;
}

export interface Crater {
  id: string;
  name: string;
  center: { x: number; y: number };
  radius: number;
  /** Rim-to-floor relief in metres (floor sits at -depth). */
  depth: number;
  /** Floor never sees direct sun (polar belt, steep walls). */
  permanentlyShadowed: boolean;
  sectorId: string;
}

export interface WorldStats {
  sectors: number;
  craters: number;
  shadowedCraters: number;
  nodes: number;
  tunnels: number;
  railRoutes: number;
  railServedNodes: number;
  veins: Record<ResourceKind, number>;
  unitsInGround: Record<ResourceKind, number>;
  deepestTunnelZ: number;
}

export interface WorldSnapshot {
  seed: string;
  /** Lateral world extents in metres. */
  width: number;
  height: number;
  sectorSize: number;
  sectors: WorldSector[];
  craters: Crater[];
  nodes: LunarNode[];
  tunnels: TunnelSegment[];
  veins: ResourceVein[];
  railRoutes: RailRoute[];
  stats: WorldStats;
}

// ---------------------------------------------------------------------------
// Extraction / validation result shapes
// ---------------------------------------------------------------------------

export interface MiningEquipment {
  /** 0 = hand geo-drill .. 3 = dock-mech pneumatic breaker. Default 0. */
  drillTier?: number;
  /** Mineral scanner overlay: reveals exact purity/remaining on estimates. */
  scanner?: boolean;
}

export interface ExtractionEstimate {
  kind: ResourceKind;
  mode: ExtractionMode;
  feasible: boolean;
  /** Why an infeasible rig cannot work here. */
  reason?: string;
  /** Raw rig throughput in units per mining cycle. */
  baseRate: number;
  /** Combined purity / drill-tier / depletion multiplier. */
  multiplier: number;
  /** Expected units per cycle (`baseRate * multiplier`). */
  yieldUnits: number;
  /** Expected credits per cycle at profile value × purity. */
  creditsPerCycle: number;
  veinId?: string;
}

export interface ResourceAvailability {
  available: boolean;
  reason?: 'no_vein' | 'depleted' | 'wrong_depth';
  vein?: ResourceVein;
  /** Distance from query point to vein surface (0 when inside). */
  distanceToVein?: number;
}

export interface HarvestResult {
  harvested: number;
  credits: number;
  remaining: number;
  veinId: string;
}

export type EdgeKind = 'tunnel' | 'surface' | 'rail';

export interface TravelEdge {
  kind: EdgeKind;
  tunnelId?: string;
  routeId?: string;
  length: number;
  to: string;
}

export interface TravelPath {
  nodeIds: string[];
  edges: TravelEdge[];
  totalLength: number;
}

// ---------------------------------------------------------------------------
// Tunables & lore tables
// ---------------------------------------------------------------------------

export interface LunarWorldOptions {
  /** Sectors across x (default 4). */
  sectorsX?: number;
  /** Sectors across y (default 3). */
  sectorsY?: number;
  /** Sector edge length in metres (default 2000). */
  sectorSize?: number;
  /** Bored radius of natural lava tubes (default 6 m). */
  tubeRadius?: number;
  /** Bored radius of drilled shafts (default 2.5 m). */
  shaftRadius?: number;
  /** Narrow-gauge track width (default 0.75 m). */
  railGauge?: number;
}

export const RESOURCE_PROFILES: Record<
  ResourceKind,
  {
    valuePerUnit: number;
    baseAbundance: number;
    /** [shallowest z, deepest z] the vein type may occupy. */
    depthBand: [number, number];
    lore: string;
  }
> = {
  regolith: {
    valuePerUnit: 1,
    baseAbundance: 12000,
    depthBand: [0, -4],
    lore: 'Blown-off surface grit. Everywhere, cheap, dull — the ballast of the frontier.',
  },
  water_ice: {
    valuePerUnit: 40,
    baseAbundance: 900,
    depthBand: [0, -200],
    lore: 'Comet grit frozen in permanently-shadowed polar crater floors and deep cold tubes. Water, oxygen, rocket fuel.',
  },
  titanium: {
    valuePerUnit: 25,
    baseAbundance: 600,
    depthBand: [-10, -100],
    lore: 'Ilmenite-rich mare basalt seams. The nation-states pay well for hull plate.',
  },
  helium_3: {
    valuePerUnit: 120,
    baseAbundance: 240,
    depthBand: [0, -2],
    lore: 'Solar-wind-loaded grains in sunlit, mature regolith. Thin seams, fusion fortunes.',
  },
  rare_earth: {
    valuePerUnit: 80,
    baseAbundance: 520,
    depthBand: [-130, -260],
    lore: 'KREEP terrane — the last dregs of the magma ocean, deep under the great basins. For the brave and the insolvent.',
  },
};

/** Units per mining cycle for each rig (before purity/tier multipliers). */
export const MODE_BASE_RATES: Record<ExtractionMode, number> = {
  suit: 2,
  buggy: 12,
  freight: 60,
};

/** A buggy rig cannot work below this depth (no pressurised ramp access). */
export const MIN_BUGGY_Z = -45;
/** Freight hoppers must sit within this radius of a rail-served node. */
export const FREIGHT_REACH_M = 140;
/** Surface nodes within this lateral range are traversable on foot/rover. */
export const SURFACE_LINK_MAX_M = 1500;
/** Rail freight is unloaded within this radius of a dock/refinery for value. */
/** Chance a non-polar sector is mare basalt (vs. highland terrane). */
export const MARE_PROBABILITY = 0.55;
const DEEP_ICE_MIN_Z = -65; // tubes deeper than this host cold-trapped ice
const KREEP_POOL_COUNT = 2;

const HIGHLAND_TAGS = [
  'Highlands', 'Ridge', 'Scarp', 'Downs', 'Wolds', 'Massif', 'Tor', 'Knoll',
  'Bancs', 'Dorsum',
];

const CRATER_NAMES = [
  'Shackleton', 'Shoemaker', 'Faustini', 'Cabeus', 'Haworth', 'Zeeman',
  'Sverdrup', 'Peary', 'Nobile', 'Slater', 'Carnot', 'Amundsen', 'Rosenberger',
  'Haskin', 'Cherfan', 'Zeno', 'Baillaude', 'Lasserwitz', 'Purkyně', 'Oterma',
];
const MARE_NAMES = [
  'Imbrium', 'Serenitatis', 'Tranquillitatis', 'Procellarum', 'Crisium',
  'Humorum', 'Frigoris', 'Nubium', 'Aestuum', 'Foecunditatis', 'Nectaris',
  'Vaporum', 'Smaragdi', 'Ingenii', 'Australe', 'Spumans', 'Malae', 'Dryda',
];
const OUTPOST_PREFIX = [
  'Dust', 'Ice', 'Rille', 'Mesa', 'Beacon', 'Gantry', 'Core', 'Shaft', 'Rim',
  'Polar', 'Sunlit', 'Cold', 'Deep', 'Lucky', 'Rust', 'Copper', 'Basalt',
  'Ilmenite', 'Krähen', 'Vulcan',
];
const OUTPOST_SUFFIX = [
  'Reach', 'Hollow', 'Flats', 'Camp', 'Station', 'Drift', 'Hook', 'Well',
  'Fold', 'Hold', 'Vane', 'Pan', 'Basin', 'Col', 'Gate',
];

// ---------------------------------------------------------------------------
// Deterministic PRNG + hashing helpers
// ---------------------------------------------------------------------------

/** Murmur-ish 32-bit string hash → seeded integer (xmur3). */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hex digest — used for the snapshot fingerprint. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

class Random {
  private readonly source: () => number;

  constructor(seed: string | number) {
    if (typeof seed === 'number') {
      this.source = mulberry32(Math.floor(seed) >>> 0);
    } else {
      this.source = mulberry32(xmur3(seed)());
    }
  }

  /** [0, 1) */
  next(): number {
    return this.source();
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.source();
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.min(max, Math.floor(min + (max - min + 1) * this.source()));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.source() * arr.length)];
  }

  chance(p: number): boolean {
    return this.source() < p;
  }

  /** Normal-ish deviate (clamped so log() can never blow up). */
  gaussian(mu = 0, sigma = 1): number {
    const u = Math.max(this.source(), 1e-12);
    const v = this.source();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

// ---------------------------------------------------------------------------
// Small geometry utilities
// ---------------------------------------------------------------------------

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Distance from point p to segment ab in 3D. */
function pointSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  if (len2 === 0) return dist3(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist3(p, { x: a.x + t * abx, y: a.y + t * aby, z: a.z + t * abz });
}

// ---------------------------------------------------------------------------
// Internal graph container
// ---------------------------------------------------------------------------

interface MutableEdge {
  to: string;
  length: number;
  kind: EdgeKind;
  tunnelId?: string;
  routeId?: string;
}

class Graph {
  private readonly adj = new Map<string, MutableEdge[]>();

  addNode(id: string): void {
    if (!this.adj.has(id)) this.adj.set(id, []);
  }

  addEdge(a: string, b: string, length: number, kind: EdgeKind, via?: string): void {
    this.addNode(a);
    this.addNode(b);
    const link = (from: string, to: string): void => {
      const list = this.adj.get(from) as MutableEdge[];
      const edge: MutableEdge = { to, length, kind };
      if (kind === 'tunnel') edge.tunnelId = via;
      if (kind === 'rail') edge.routeId = via;
      list.push(edge);
    };
    link(a, b);
    link(b, a);
  }

  neighbors(id: string): MutableEdge[] {
    return this.adj.get(id) ?? [];
  }

  /** Dijkstra with an edge filter. Deterministic tie-breaking by node id. */
  shortestPath(
    from: string,
    to: string,
    allow: (kind: EdgeKind) => boolean,
  ): TravelPath | null {
    if (!this.adj.has(from) || !this.adj.has(to)) return null;
    const best = new Map<string, number>();
    const prev = new Map<string, { node: string; edge: MutableEdge }>();
    const done = new Set<string>();
    best.set(from, 0);

    for (;;) {
      // Linear-scan frontier with (distance, id) tie-break — small graphs.
      let u: string | null = null;
      let uDist = Infinity;
      for (const [node, d] of best) {
        if (!done.has(node) && (d < uDist || (d === uDist && u !== null && node < u))) {
          u = node;
          uDist = d;
        }
      }
      if (u === null) break;
      if (u === to) break;
      done.add(u);
      for (const edge of this.neighbors(u)) {
        if (!allow(edge.kind)) continue;
        const nd = uDist + edge.length;
        const known = best.get(edge.to);
        if (known === undefined || nd < known) {
          best.set(edge.to, nd);
          prev.set(edge.to, { node: u, edge });
        }
      }
    }

    if (!best.has(to)) return null;
    const nodeIds: string[] = [to];
    const edges: TravelEdge[] = [];
    let cursor = to;
    while (cursor !== from) {
      const step = prev.get(cursor);
      if (step === undefined) return null;
      edges.unshift({
        kind: step.edge.kind,
        tunnelId: step.edge.tunnelId,
        routeId: step.edge.routeId,
        length: step.edge.length,
        to: step.edge.to,
      });
      nodeIds.unshift(step.node);
      cursor = step.node;
    }
    return { nodeIds, edges, totalLength: best.get(to) as number };
  }
}

// ---------------------------------------------------------------------------
// LunarWorldGenerator
// ---------------------------------------------------------------------------

export class LunarWorldGenerator {
  readonly seed: string;
  private readonly sectorsX: number;
  private readonly sectorsY: number;
  private readonly sectorSize: number;
  private readonly tubeRadius: number;
  private readonly shaftRadius: number;
  private readonly railGauge: number;

  private snapshot: WorldSnapshot | null = null;
  private nodeIndex = new Map<string, LunarNode>();
  private veinIndex = new Map<string, ResourceVein>();
  private tunnelIndex = new Map<string, TunnelSegment>();
  private sectorIndex = new Map<string, WorldSector>();
  private craterIndex = new Map<string, Crater>();
  private routeIndex = new Map<string, RailRoute>();

  /** Combined traversal graph (tunnel + open-surface links). */
  private transport = new Graph();
  /** Tunnels-only graph. */
  private tunnelGraph = new Graph();
  /** Rail-only graph. */
  private railGraph = new Graph();
  private railServed = new Set<string>();

  private nameCounter = 0;
  private idCounter = 0;
  private deepDiveDone = false;

  constructor(seed: string | number, options: LunarWorldOptions = {}) {
    this.seed = String(seed);
    this.sectorsX = Math.max(1, Math.floor(options.sectorsX ?? 4));
    this.sectorsY = Math.max(1, Math.floor(options.sectorsY ?? 3));
    this.sectorSize = Math.max(500, options.sectorSize ?? 2000);
    this.tubeRadius = options.tubeRadius ?? 6;
    this.shaftRadius = options.shaftRadius ?? 2.5;
    this.railGauge = options.railGauge ?? 0.75;
  }

  /** Convenience: one-shot deterministic snapshot. */
  static generateFrom(seed: string | number, options: LunarWorldOptions = {}): WorldSnapshot {
    return new LunarWorldGenerator(seed, options).generate();
  }

  // -- generation pipeline ---------------------------------------------------

  /** Build (or return cached) world snapshot. Idempotent. */
  generate(): WorldSnapshot {
    if (this.snapshot !== null) return structuredClone(this.snapshot);

    const rng = new Random(this.seed);
    const width = this.sectorsX * this.sectorSize;
    const height = this.sectorsY * this.sectorSize;
    this.nameCounter = 0;
    this.idCounter = 0;
    this.deepDiveDone = false;
    this.tunnelKindCounters.clear();

    const sectors = this.buildSectors(rng);
    const craters = this.buildCraters(rng, sectors);
    const nodes: LunarNode[] = [];
    const cratersBySector = new Map<string, Crater[]>();
    for (const c of craters) {
      const list = cratersBySector.get(c.sectorId) ?? [];
      list.push(c);
      cratersBySector.set(c.sectorId, list);
    }

    const elev = (x: number, y: number): number => this.elevationAt(x, y, craters);

    // Surface industry: one refinery hub per sector, docks, outposts.
    for (const sector of sectors) {
      const cx = sector.center.x;
      const cy = sector.center.y;
      const refSpot = this.findFlatSpot(rng, cx, cy, this.sectorSize * 0.32, elev);
      nodes.push(
        this.makeNode(
          'refinery',
          `Refinery Hub ${this.pickName(MARE_NAMES)}`,
          refSpot.x,
          refSpot.y,
          Math.max(0, elev(refSpot.x, refSpot.y)),
          sector.id,
        ),
      );

      if (rng.chance(0.75)) {
        const dockSpot = this.findFlatSpot(rng, cx, cy, this.sectorSize * 0.45, elev);
        nodes.push(
          this.makeNode(
          'dock',
          `Freight Dock ${this.nextNameTag()}`,
          dockSpot.x,
          dockSpot.y,
          Math.max(0, elev(dockSpot.x, dockSpot.y)),
          sector.id,
        ),
        );
      }

      const outposts = rng.int(1, 2);
      for (let i = 0; i < outposts; i++) {
        const spot = this.findFlatSpot(rng, cx, cy, this.sectorSize * 0.48, elev);
        nodes.push(
          this.makeNode(
          'outpost',
          this.makeOutpostName(),
          spot.x,
          spot.y,
          Math.max(0, elev(spot.x, spot.y)),
          sector.id,
        ),
        );
      }
    }

    // Lava tubes: wandering subsurface chains with occasional caverns.
    const tunnels: TunnelSegment[] = [];
    const tubeNodes: LunarNode[] = [];
    for (const sector of sectors) {
      if (!rng.chance(0.8)) continue;
      const tubesHere = rng.int(1, 2);
      for (let t = 0; t < tubesHere; t++) {
        this.buildLavaTube(rng, sector, tubeNodes, nodes, tunnels, width, height);
      }
    }

    // Drilled mine shafts: collars on crater rims / near outposts.
    const shaftHeads: LunarNode[] = [];
    for (const sector of sectors) {
      const shafts = rng.int(1, 2);
      for (let s = 0; s < shafts; s++) {
        const rimCrater = (cratersBySector.get(sector.id) ?? [])[0];
        let sx: number;
        let sy: number;
        if (rimCrater !== undefined && rng.chance(0.6)) {
          const a = rng.range(0, Math.PI * 2);
          sx = rimCrater.center.x + Math.cos(a) * rimCrater.radius;
          sy = rimCrater.center.y + Math.sin(a) * rimCrater.radius;
        } else {
          const spot = this.findFlatSpot(rng, sector.center.x, sector.center.y, this.sectorSize * 0.4, elev);
          sx = spot.x;
          sy = spot.y;
        }
        const head = this.makeNode(
          'shaft_head',
          `Shaft Collar ${this.nextNameTag()}`,
          sx,
          sy,
          Math.max(0, elev(sx, sy)),
          sector.id,
        );
        nodes.push(head);
        shaftHeads.push(head);
      }
    }

    // Connect each shaft collar straight down to the nearest tube node.
    for (const head of shaftHeads) {
      let bestNode: LunarNode | null = null;
      let bestD = Infinity;
      for (const n of tubeNodes) {
        const d = dist2(head.position, n.position);
        if (d < bestD) {
          bestD = d;
          bestNode = n;
        }
      }
      if (bestNode !== null && bestD <= (this.sectorSize * 1.4) ** 2) {
        tunnels.push(this.makeTunnel('mine_shaft', head, bestNode, this.shaftRadius));
      } else {
        // Barren exploratory hole: dead-end sump below the collar.
        const bottom = this.makeNode(
          'junction',
          `Sump ${this.nextNameTag()}`,
          head.position.x,
          head.position.y,
          -rng.range(120, 200),
          head.sectorId,
        );
        nodes.push(bottom);
        tunnels.push(this.makeTunnel('mine_shaft', head, bottom, this.shaftRadius));
      }
    }

    // Underground outpost caverns: some deep tube nodes get claimed.
    for (const n of tubeNodes) {
      if (n.position.z <= -40 && rng.chance(0.15)) {
        n.kind = 'cavern';
        n.name = `${this.pickName(OUTPOST_PREFIX)} Cavern ${this.nextNameTag()}`;
        // Short adit stub so the cavern reads as a worked room, not a void.
        const stub = this.makeNode(
          'junction',
          `Cavern Stope ${this.nextNameTag()}`,
          n.position.x + rng.range(-25, 25),
          n.position.y + rng.range(-25, 25),
          n.position.z + rng.range(-6, 6),
          n.sectorId,
        );
        nodes.push(stub);
        tunnels.push(this.makeTunnel('cavern_adit', n, stub, this.tubeRadius * 0.6));
      }
    }

    // Wheeled ramps from shallow tube voids up to a nearby shaft collar.
    for (const n of tubeNodes) {
      if (n.position.z >= -35 && rng.chance(0.35)) {
        const anchor = this.nearestNodeBy(
          n,
          nodes,
          (m) =>
            m.kind === 'shaft_head' ||
            (m.kind === 'junction' && m.position.z >= -30),
        );
        if (anchor !== null && anchor.id !== n.id) {
          const span = Math.hypot(
            anchor.position.x - n.position.x,
            anchor.position.y - n.position.y,
          );
          if (span <= 550) {
            tunnels.push(this.makeTunnel('ramp', anchor, n, this.tubeRadius * 0.8));
          }
        }
      }
    }

    const veins = this.buildVeins(rng, sectors, craters, nodes, tunnels);

    // Populate indexes before rail routing (routes resolve node positions).
    this.nodeIndex = new Map(nodes.map((n) => [n.id, n]));
    this.veinIndex = new Map(veins.map((v) => [v.id, v]));
    this.tunnelIndex = new Map(tunnels.map((t) => [t.id, t]));
    this.sectorIndex = new Map(sectors.map((s) => [s.id, s]));
    this.craterIndex = new Map(craters.map((c) => [c.id, c]));

    // Rail lines: build transport graph first (tunnels + surface links).
    this.tunnelGraph = new Graph();
    this.transport = new Graph();
    this.railGraph = new Graph();
    this.railServed = new Set();
    for (const n of nodes) this.tunnelGraph.addNode(n.id);
    for (const t of tunnels) {
      this.tunnelGraph.addEdge(t.fromId, t.toId, t.length, 'tunnel', t.id);
    }
    const surfaceNodes = nodes.filter((n) => n.position.z >= 0);
    for (const n of surfaceNodes) this.transport.addNode(n.id);
    for (const t of tunnels) {
      this.transport.addEdge(t.fromId, t.toId, t.length, 'tunnel', t.id);
    }
    this.linkSurfaceNodes(surfaceNodes);

    const railRoutes = this.buildRailRoutes(nodes);
    this.routeIndex = new Map(railRoutes.map((r) => [r.id, r]));

    // --- snapshot -----------------------------------------------------------
    const veinsByKind = (): Record<ResourceKind, number> => {
      const out = {} as Record<ResourceKind, number>;
      for (const k of RESOURCE_KINDS) out[k] = 0;
      for (const v of veins) out[v.kind]++;
      return out;
    };
    const unitsByKind = (): Record<ResourceKind, number> => {
      const out = {} as Record<ResourceKind, number>;
      for (const k of RESOURCE_KINDS) out[k] = 0;
      for (const v of veins) out[v.kind] += v.remaining;
      return out;
    };
    let deepest = 0;
    for (const t of tunnels) deepest = Math.min(deepest, t.start.z, t.end.z);

    const stats: WorldStats = {
      sectors: sectors.length,
      craters: craters.length,
      shadowedCraters: craters.filter((c) => c.permanentlyShadowed).length,
      nodes: nodes.length,
      tunnels: tunnels.length,
      railRoutes: railRoutes.length,
      railServedNodes: this.railServed.size,
      veins: veinsByKind(),
      unitsInGround: unitsByKind(),
      deepestTunnelZ: deepest,
    };

    this.snapshot = {
      seed: this.seed,
      width,
      height,
      sectorSize: this.sectorSize,
      sectors,
      craters,
      nodes,
      tunnels,
      veins,
      railRoutes,
      stats,
    };

    return structuredClone(this.snapshot);
  }

  /** Ensure the world exists and hand back the live (non-cloned) snapshot. */
  private world(): WorldSnapshot {
    if (this.snapshot === null) this.generate();
    const snap = this.snapshot;
    if (snap === null) {
      throw new Error('LunarWorldGenerator: generate() failed to produce a snapshot');
    }
    return snap;
  }

  /** Drop the cached world so `generate()` rebuilds (keeps seed). */
  reset(): void {
    this.snapshot = null;
    this.nodeIndex.clear();
    this.veinIndex.clear();
    this.tunnelIndex.clear();
    this.sectorIndex.clear();
    this.craterIndex.clear();
    this.routeIndex.clear();
    this.transport = new Graph();
    this.tunnelGraph = new Graph();
    this.railGraph = new Graph();
    this.railServed = new Set();
  }

  /** FNV-1a fingerprint of the snapshot — compare across instances for reproducibility. */
  digest(): string {
    const snap = this.snapshot ?? this.generate();
    return fnv1a(JSON.stringify(snap));
  }

  // -- static terrain queries ------------------------------------------------

  /** Open-sky terrain height at (x, y): 0 on the datum plain, negative inside craters, small rim bumps. */
  elevationAt(x: number, y: number, craters?: Crater[]): number {
    const list = craters ?? Array.from(this.craterIndex.values());
    let z = 0;
    for (const c of list) {
      const dx = x - c.center.x;
      const dy = y - c.center.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < c.radius) {
        z = Math.min(z, -c.depth * (1 - d / c.radius));
      } else if (d < c.radius * 1.15) {
        z = Math.max(z, c.depth * 0.15 * (1 - (d - c.radius) / (c.radius * 0.15)));
      }
    }
    return z;
  }

  sectorAt(x: number, y: number): WorldSector | null {
    this.world();
    for (const s of this.sectorIndex.values()) {
      if (x >= s.bounds.minX && x <= s.bounds.maxX && y >= s.bounds.minY && y <= s.bounds.maxY) {
        return structuredClone(s);
      }
    }
    return null;
  }

  // -- entity lookups ----------------------------------------------------------

  getNode(id: string): LunarNode | null {
    const n = this.nodeIndex.get(id);
    return n ? structuredClone(n) : null;
  }

  getTunnel(id: string): TunnelSegment | null {
    const t = this.tunnelIndex.get(id);
    return t ? structuredClone(t) : null;
  }

  getVein(id: string): ResourceVein | null {
    const v = this.veinIndex.get(id);
    return v ? structuredClone(v) : null;
  }

  getSector(id: string): WorldSector | null {
    const s = this.sectorIndex.get(id);
    return s ? structuredClone(s) : null;
  }

  getCrater(id: string): Crater | null {
    const c = this.craterIndex.get(id);
    return c ? structuredClone(c) : null;
  }

  getRailRoute(id: string): RailRoute | null {
    const r = this.routeIndex.get(id);
    return r ? structuredClone(r) : null;
  }

  /** All nodes within `radius` metres (3D) of the query point. */
  nodesNear(x: number, y: number, z: number, radius: number): LunarNode[] {
    return this.world().nodes
      .filter((n) => dist3(n.position, { x, y, z }) <= radius)
      .map((n) => structuredClone(n));
  }

  /** Tunnel segments whose midpoint lies within `radius` of the query point. */
  tunnelsNear(x: number, y: number, z: number, radius: number): TunnelSegment[] {
    const p: Vec3 = { x, y, z };
    return this.world().tunnels
      .filter((t) => pointSegmentDistance(p, t.start, t.end) <= radius)
      .map((t) => structuredClone(t));
  }

  // -- graph queries -----------------------------------------------------------

  /** Neighbouring node ids connected by an open tunnel segment. */
  tunnelNeighbors(nodeId: string): LunarNode[] {
    if (this.snapshot === null) this.generate();
    return this.tunnelGraph
      .neighbors(nodeId)
      .filter((e) => e.kind === 'tunnel')
      .map((e) => this.nodeIndex.get(e.to))
      .filter((n): n is LunarNode => n !== undefined)
      .map((n) => structuredClone(n));
  }

  /** Shortest path using only excavated tunnel segments (no open-surface walking). */
  findTunnelPath(fromId: string, toId: string): TravelPath | null {
    if (this.snapshot === null) this.generate();
    return this.tunnelGraph.shortestPath(fromId, toId, (k) => k === 'tunnel');
  }

  /** Shortest path over the combined transit graph (tunnels + traversable surface). */
  findPath(fromId: string, toId: string): TravelPath | null {
    if (this.snapshot === null) this.generate();
    return this.transport.shortestPath(fromId, toId, () => true);
  }

  /** Shortest path over laid rail only. */
  findRailPath(fromId: string, toId: string): TravelPath | null {
    if (this.snapshot === null) this.generate();
    return this.railGraph.shortestPath(fromId, toId, (k) => k === 'rail');
  }

  /** Rail routes that touch a node. */
  routesForNode(nodeId: string): RailRoute[] {
    return this.world().railRoutes
      .filter((r) => r.nodeIds.includes(nodeId))
      .map((r) => structuredClone(r));
  }

  isRailServed(nodeId: string): boolean {
    if (this.snapshot === null) this.generate();
    return this.railServed.has(nodeId);
  }

  // -- resource availability & claims validation --------------------------------

  /** All veins whose sphere contains (x, y, z) — sorted by distance to centre. */
  veinsAt(x: number, y: number, z: number, radius = 0): ResourceVein[] {
    const p: Vec3 = { x, y, z };
    return this.world().veins
      .map((v) => ({ v, d: dist3(p, v.center) }))
      .filter(({ v, d }) => d <= v.radius + radius)
      .sort((a, b) => a.d - b.d || a.v.id.localeCompare(b.v.id))
      .map(({ v }) => structuredClone(v));
  }

  /**
   * Is `kind` extractable at (x, y, z)? Checks vein presence, remaining
   * stock, and the kind's depth band for the query point.
   */
  resourceAvailable(kind: ResourceKind, x: number, y: number, z: number): ResourceAvailability {
    const p: Vec3 = { x, y, z };
    let nearest: { v: ResourceVein; d: number } | null = null;

    for (const v of this.world().veins) {
      if (v.kind !== kind) continue;
      const d = dist3(p, v.center);
      if (nearest === null || d < nearest.d) nearest = { v, d };
      if (d <= v.radius) {
        if (v.remaining <= 0) {
          return { available: false, reason: 'depleted', vein: structuredClone(v), distanceToVein: 0 };
        }
        return { available: true, vein: structuredClone(v), distanceToVein: 0 };
      }
    }

    // No body of this kind contains the point. Outside the kind's depth
    // regime it can never be there; inside it, the survey just found nothing.
    const [shallow, deep] = RESOURCE_PROFILES[kind].depthBand;
    if (z > shallow || z < deep) {
      return {
        available: false,
        reason: 'wrong_depth',
        ...(nearest !== null ? { distanceToVein: nearest.d } : {}),
      };
    }
    return nearest === null
      ? { available: false, reason: 'no_vein' }
      : { available: false, reason: 'no_vein', distanceToVein: nearest.d };
  }

  /**
   * Estimated extraction yield for a rig at a point, before claims accounting.
   * Yield = baseRate(mode) × purity × drill-tier × depletion factor.
   */
  estimateExtraction(
    kind: ResourceKind,
    x: number,
    y: number,
    z: number,
    mode: ExtractionMode,
    equipment: MiningEquipment = {},
  ): ExtractionEstimate {
    if (this.snapshot === null) this.generate();
    const baseRate = MODE_BASE_RATES[mode];
    const availability = this.resourceAvailable(kind, x, y, z);

    const fail = (reason: string): ExtractionEstimate => ({
      kind,
      mode,
      feasible: false,
      reason,
      baseRate,
      multiplier: 0,
      yieldUnits: 0,
      creditsPerCycle: 0,
    });

    if (!availability.available || availability.vein === undefined) {
      return fail(availability.reason ?? 'no_vein');
    }
    const vein = availability.vein;

    if (mode === 'buggy' && z < MIN_BUGGY_Z) {
      return fail(`buggy_rig_too_deep (min z ${MIN_BUGGY_Z} m — no ramp service below)`);
    }
    if (mode === 'freight') {
      const reach = this.nearestRailServedDistance(x, y, z);
      if (reach > FREIGHT_REACH_M) {
        return fail(`no_rail_siding_within_${FREIGHT_REACH_M}m (nearest ${Math.round(reach)} m)`);
      }
    }

    const tier = Math.max(0, Math.min(3, equipment.drillTier ?? 0));
    const tierMult = 0.8 + tier * 0.35; // 0.8 .. 1.85
    const depletion = Math.max(0.25, vein.remaining / Math.max(1, vein.abundance));
    const multiplier = vein.purity * tierMult * depletion;
    const yieldUnits = baseRate * multiplier;
    const creditsPerCycle = yieldUnits * RESOURCE_PROFILES[kind].valuePerUnit * vein.purity;

    const est: ExtractionEstimate = {
      kind,
      mode,
      feasible: true,
      baseRate,
      multiplier,
      yieldUnits,
      creditsPerCycle,
      veinId: vein.id,
    };
    if (!equipment.scanner) {
      // Without a mineral scanner the HUD only reports rough purity bands.
      est.multiplier = Math.round(est.multiplier * 10) / 10;
      est.yieldUnits = Math.round(est.yieldUnits * 10) / 10;
      est.creditsPerCycle = Math.round(est.creditsPerCycle);
    }
    return est;
  }

  /**
   * Claims-side validation hook: can `mode` dig at (x, y, z) for `kind`?
   * (Ownership/ledger enforcement stays in the server + DatabaseManager;
   * this is the world-side geology + rig-feasibility half.)
   */
  canExtract(
    kind: ResourceKind,
    x: number,
    y: number,
    z: number,
    mode: ExtractionMode = 'suit',
    equipment: MiningEquipment = {},
  ): { ok: boolean; reason?: string; estimate?: ExtractionEstimate } {
    const estimate = this.estimateExtraction(kind, x, y, z, mode, equipment);
    return estimate.feasible
      ? { ok: true, estimate }
      : { ok: false, reason: estimate.reason, estimate };
  }

  /**
   * Mutate the in-memory vein by extracting `requested` units. Returns what
   * was actually taken (capped by remaining stock); 0 when unavailable.
   */
  harvest(
    kind: ResourceKind,
    x: number,
    y: number,
    z: number,
    requested: number,
    mode: ExtractionMode = 'suit',
    equipment: MiningEquipment = {},
  ): HarvestResult {
    const check = this.canExtract(kind, x, y, z, mode, equipment);
    const veinId = check.estimate?.veinId ?? 'none';
    if (!check.ok || check.estimate?.veinId === undefined) {
      return { harvested: 0, credits: 0, remaining: 0, veinId };
    }
    const vein = this.veinIndex.get(check.estimate.veinId);
    if (vein === undefined) {
      return { harvested: 0, credits: 0, remaining: 0, veinId };
    }
    const harvested = Math.max(0, Math.min(Math.floor(requested), vein.remaining));
    vein.remaining -= harvested;
    const credits = Math.round(harvested * RESOURCE_PROFILES[kind].valuePerUnit * vein.purity);
    return { harvested, credits, remaining: vein.remaining, veinId: vein.id };
  }

  /** Depth-sorted listing of everything a surveyor could log in a depth window. */
  veinsInDepthWindow(minZ: number, maxZ: number): ResourceVein[] {
    return this.world().veins
      .filter((v) => v.center.z >= minZ && v.center.z <= maxZ)
      .sort((a, b) => a.center.z - b.center.z || a.id.localeCompare(b.id))
      .map((v) => structuredClone(v));
  }

  // -- internal builders ---------------------------------------------------------

  private buildSectors(rng: Random): WorldSector[] {
    const sectors: WorldSector[] = [];
    for (let row = 0; row < this.sectorsY; row++) {
      for (let col = 0; col < this.sectorsX; col++) {
        const minY = row * this.sectorSize;
        const maxY = (row + 1) * this.sectorSize;
        const centerX = col * this.sectorSize + this.sectorSize / 2;
        const centerY = minY + this.sectorSize / 2;
        // The top and bottom sector rows form the polar crater belt.
        const terrane: Terrane =
          row === 0 || row === this.sectorsY - 1
            ? 'polar'
            : rng.chance(MARE_PROBABILITY)
              ? 'mare'
              : 'highland';
        sectors.push({
          id: `sector-${col}-${row}`,
          name: `${this.sectorLabel(col)}-${row + 1} ${this.pickName(
            terrane === 'mare' ? MARE_NAMES : terrane === 'polar' ? CRATER_NAMES : HIGHLAND_TAGS,
          )}`,
          terrane,
          bounds: {
            minX: col * this.sectorSize,
            maxX: (col + 1) * this.sectorSize,
            minY,
            maxY,
          },
          center: { x: centerX, y: centerY },
          craterIds: [],
          claimPressure: rng.range(0.05, 0.95),
        });
      }
    }
    return sectors;
  }

  private buildCraters(rng: Random, sectors: WorldSector[]): Crater[] {
    const craters: Crater[] = [];
    const usedNames = new Set<string>();
    const nameFor = (): string => {
      for (let i = 0; i < 24; i++) {
        const n = this.pickName(CRATER_NAMES);
        if (!usedNames.has(n)) {
          usedNames.add(n);
          return n;
        }
      }
      return `Unnamed ${this.nextNameTag()}`;
    };

    for (const sector of sectors) {
      const count = rng.int(1, 3);
      for (let i = 0; i < count; i++) {
        const radius = rng.range(60, 360);
        const x = rng.range(sector.bounds.minX + radius * 0.2, sector.bounds.maxX - radius * 0.2);
        const y = rng.range(sector.bounds.minY + radius * 0.2, sector.bounds.maxY - radius * 0.2);
        const depth = radius * rng.range(0.12, 0.22);
        const shadowed =
          sector.terrane === 'polar' && radius > 150 && rng.chance(0.75);
        const crater: Crater = {
          id: `crater-${craters.length.toString().padStart(3, '0')}`,
          name: nameFor(),
          center: { x, y },
          radius,
          depth,
          permanentlyShadowed: shadowed,
          sectorId: sector.id,
        };
        craters.push(crater);
        sector.craterIds.push(crater.id);
      }
    }
    return craters;
  }

  private buildLavaTube(
    rng: Random,
    sector: WorldSector,
    tubeNodes: LunarNode[],
    allNodes: LunarNode[],
    tunnels: TunnelSegment[],
    width: number,
    height: number,
  ): void {
    const steps = rng.int(5, 9);
    let x = rng.range(sector.bounds.minX, sector.bounds.maxX);
    let y = rng.range(sector.bounds.minY, sector.bounds.maxY);
    let z = -rng.range(25, 45);
    let heading = rng.range(0, Math.PI * 2);

    let prev: LunarNode | null = null;
    const deepDive = this.deepDiveDone ? 0 : 2; // one guaranteed deep tube per world
    this.deepDiveDone = true;
    for (let i = 0; i < steps + deepDive; i++) {
      const finalLeg = i >= steps;
      heading += rng.gaussian(0, 0.55);
      const stepLen = rng.range(90, 180);
      x = Math.max(20, Math.min(width - 20, x + Math.cos(heading) * stepLen));
      y = Math.max(20, Math.min(height - 20, y + Math.sin(heading) * stepLen));
      z = finalLeg
        ? Math.max(-150, Math.min(z, -95) - rng.range(5, 25))
        : Math.max(-150, Math.min(-22, z + rng.range(-14, 5)));
      const node = this.makeNode(
        'junction',
        `Tube Void ${this.nextNameTag()}`,
        x,
        y,
        z,
        this.sectorIdFor(x, y),
      );
      allNodes.push(node);
      tubeNodes.push(node);
      if (prev !== null) {
        tunnels.push(this.makeTunnel('lava_tube', prev, node, this.tubeRadius));
      }
      prev = node;
    }
  }

  private buildVeins(
    rng: Random,
    sectors: WorldSector[],
    craters: Crater[],
    nodes: LunarNode[],
    tunnels: TunnelSegment[],
  ): ResourceVein[] {
    const veins: ResourceVein[] = [];
    const push = (
      kind: ResourceKind,
      x: number,
      y: number,
      z: number,
      radius: number,
      abundance: number,
      purity: number,
    ): void => {
      const vein: ResourceVein = {
        id: `vein-${kind}-${veins.length.toString().padStart(3, '0')}`,
        kind,
        center: { x, y, z },
        radius,
        depth: Math.max(0, -z),
        abundance,
        remaining: abundance,
        purity,
        sectorId: this.sectorIdFor(x, y),
        hostNodeIds: [],
        hostTunnelIds: [],
      };
      // Host nodes within (radius + 60) — these crews can see the outcrop.
      for (const n of nodes) {
        if (dist3(n.position, vein.center) <= radius + 60) vein.hostNodeIds.push(n.id);
      }
      // Tunnels that physically cut the ore body.
      for (const t of tunnels) {
        if (pointSegmentDistance(vein.center, t.start, t.end) <= radius) {
          vein.hostTunnelIds.push(t.id);
        }
      }
      veins.push(vein);
    };

    // Regolith: a near-continuous sheet blanket — jittered 3x3 grid of wide,
    // shallow blankets per sector so *any* surface probe finds grit.
    for (const sector of sectors) {
      const cell = this.sectorSize / 3;
      const radius = this.sectorSize * 0.44; // guarantees full coverage
      for (let gy = 0; gy < 3; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          push(
            'regolith',
            sector.bounds.minX + cell * (gx + 0.5) + rng.gaussian(0, cell * 0.18),
            sector.bounds.minY + cell * (gy + 0.5) + rng.gaussian(0, cell * 0.18),
            -rng.range(0, 2),
            radius + rng.range(-40, 80),
            Math.floor(RESOURCE_PROFILES.regolith.baseAbundance * rng.range(0.6, 1.8)),
            rng.range(0.95, 1.05),
          );
        }
      }
    }

    // Helium-3: sunlit (non-polar) surfaces only — solar wind needs sunshine.
    for (const sector of sectors) {
      if (sector.terrane === 'polar') continue;
      if (!rng.chance(0.7)) continue;
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        push(
          'helium_3',
          rng.range(sector.bounds.minX, sector.bounds.maxX),
          rng.range(sector.bounds.minY, sector.bounds.maxY),
          -rng.range(0, 0.6),
          rng.range(25, 55),
          Math.floor(RESOURCE_PROFILES.helium_3.baseAbundance * rng.range(0.4, 1.6)),
          rng.range(0.6, 1.4),
        );
      }
    }

    // Water ice: shadowed polar crater floors + deep cold-trap tubes.
    for (const c of craters) {
      if (!c.permanentlyShadowed) continue;
      push(
        'water_ice',
        c.center.x,
        c.center.y,
        -c.depth - 4,
        Math.max(18, c.radius * 0.4),
        Math.floor(RESOURCE_PROFILES.water_ice.baseAbundance * rng.range(0.8, 2.2)),
        rng.range(0.9, 1.45),
      );
    }
    const deepestVoid = nodes
      .filter((n) => n.kind === 'junction' || n.kind === 'cavern')
      .reduce<(LunarNode | null)>((acc, n) => (acc === null || n.position.z < acc.position.z ? n : acc), null);
    for (const n of nodes) {
      if (n.kind !== 'junction' && n.kind !== 'cavern') continue;
      if (n.position.z > DEEP_ICE_MIN_Z) continue;
      // The deepest worked void always cold-traps a cold ice lens.
      if (deepestVoid !== null && n.id === deepestVoid.id) {
        push(
          'water_ice',
          n.position.x,
          n.position.y,
          n.position.z,
          rng.range(22, 48),
          Math.floor(RESOURCE_PROFILES.water_ice.baseAbundance * rng.range(0.8, 1.6)),
          rng.range(0.9, 1.4),
        );
        continue;
      }
      if (!rng.chance(0.3)) continue;
      push(
        'water_ice',
        n.position.x,
        n.position.y,
        n.position.z,
        rng.range(18, 45),
        Math.floor(RESOURCE_PROFILES.water_ice.baseAbundance * rng.range(0.3, 1.1)),
        rng.range(0.85, 1.3),
      );
    }

    // Titanium / ilmenite: mare basalt seams.
    for (const sector of sectors) {
      if (sector.terrane !== 'mare') continue;
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        push(
          'titanium',
          rng.range(sector.bounds.minX, sector.bounds.maxX),
          rng.range(sector.bounds.minY, sector.bounds.maxY),
          -rng.range(12, 95),
          rng.range(20, 60),
          Math.floor(RESOURCE_PROFILES.titanium.baseAbundance * rng.range(0.5, 1.7)),
          rng.range(0.7, 1.4),
        );
      }
    }

    // Guarantee the headline deposits exist somewhere surveyable: if every
    // per-sector chance missed, force one seam into the first suitable sector.
    const has = (kind: ResourceKind): boolean => veins.some((v) => v.kind === kind);
    if (!has('helium_3')) {
      const sunlit = sectors.find((s) => s.terrane !== 'polar') ?? sectors[0];
      push(
        'helium_3',
        sunlit.center.x,
        sunlit.center.y,
        -rng.range(0, 0.4),
        rng.range(30, 55),
        Math.floor(RESOURCE_PROFILES.helium_3.baseAbundance * rng.range(0.8, 1.4)),
        rng.range(0.8, 1.3),
      );
    }
    if (!has('titanium')) {
      const mare = sectors.find((s) => s.terrane === 'mare') ?? sectors[0];
      push(
        'titanium',
        mare.center.x,
        mare.center.y,
        -rng.range(12, 95),
        rng.range(25, 55),
        Math.floor(RESOURCE_PROFILES.titanium.baseAbundance * rng.range(0.8, 1.5)),
        rng.range(0.8, 1.3),
      );
    }

    // Rare earths: KREEP pools under the deepest big craters, deep crust.
    const sortedBySize = [...craters].sort((a, b) => b.radius - a.radius || a.id.localeCompare(b.id));
    const pools = sortedBySize.slice(0, Math.min(KREEP_POOL_COUNT, sortedBySize.length));
    for (const c of pools) {
      const n = rng.int(1, 2);
      for (let i = 0; i < n; i++) {
        push(
          'rare_earth',
          c.center.x + rng.range(-60, 60),
          c.center.y + rng.range(-60, 60),
          -rng.range(150, 240),
          rng.range(25, 70),
          Math.floor(RESOURCE_PROFILES.rare_earth.baseAbundance * rng.range(0.5, 1.9)),
          rng.range(0.75, 1.45),
        );
      }
    }

    return veins;
  }

  /** k-nearest surface links + union-find component stitching so the
   *  surface graph is one connected, planar-ish web. */
  private linkSurfaceNodes(surfaceNodes: LunarNode[]): void {
    const K = 4;
    const parent = new Map<string, string>();
    const find = (a: string): string => {
      let root = a;
      while (parent.get(root) !== root) root = parent.get(root) as string;
      let cursor = a;
      while (parent.get(cursor) !== cursor) {
        const next = parent.get(cursor) as string;
        parent.set(cursor, root);
        cursor = next;
      }
      return root;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const n of surfaceNodes) parent.set(n.id, n.id);

    const linked = new Set<string>(); // "a|b" sorted
    const link = (a: LunarNode, b: LunarNode, cap: number): void => {
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const d = Math.sqrt(dist2(a.position, b.position));
      if (d > cap) return;
      if (!linked.has(key)) {
        linked.add(key);
        this.transport.addEdge(a.id, b.id, d, 'surface');
      }
      union(a.id, b.id);
    };

    for (const a of surfaceNodes) {
      const neighbours = surfaceNodes
        .filter((b) => b.id !== a.id)
        .sort(
          (b, c) =>
            dist2(a.position, b.position) - dist2(a.position, c.position) ||
            b.id.localeCompare(c.id),
        )
        .slice(0, K);
      for (const b of neighbours) link(a, b, SURFACE_LINK_MAX_M);
    }

    // Stitch any leftover components with their closest cross pair.
    for (;;) {
      const roots = new Map<string, LunarNode[]>();
      for (const n of surfaceNodes) {
        const r = find(n.id);
        const list = roots.get(r) ?? [];
        list.push(n);
        roots.set(r, list);
      }
      if (roots.size <= 1) break;
      const groups = Array.from(roots.values());
      let bestPair: { a: LunarNode; b: LunarNode; d: number } | null = null;
      for (let g = 0; g < groups.length; g++) {
        for (let h = g + 1; h < groups.length; h++) {
          for (const a of groups[g]) {
            for (const b of groups[h]) {
              const d = Math.sqrt(dist2(a.position, b.position));
              if (bestPair === null || d < bestPair.d) bestPair = { a, b, d };
            }
          }
        }
      }
      if (bestPair === null) break;
      const key =
        bestPair.a.id < bestPair.b.id
          ? `${bestPair.a.id}|${bestPair.b.id}`
          : `${bestPair.b.id}|${bestPair.a.id}`;
      if (linked.has(key)) break; // defensive: no progress possible
      linked.add(key);
      this.transport.addEdge(bestPair.a.id, bestPair.b.id, bestPair.d, 'surface');
      union(bestPair.a.id, bestPair.b.id);
    }
  }

  private buildRailRoutes(nodes: LunarNode[]): RailRoute[] {
    const routes: RailRoute[] = [];
    const refineries = nodes.filter((n) => n.kind === 'refinery');
    const docks = nodes.filter((n) => n.kind === 'dock');
    const outposts = nodes.filter((n) => n.kind === 'outpost');
    let routeSeq = 0;

    const markRoute = (
      name: string,
      nodeIds: string[],
      length: number,
      kind: RailRoute['kind'],
    ): void => {
      const route: RailRoute = {
        id: `rail-${(++routeSeq).toString().padStart(3, '0')}`,
        name,
        nodeIds,
        gauge: this.railGauge,
        length,
        kind,
      };
      routes.push(route);
      for (const id of nodeIds) this.railServed.add(id);
      for (let i = 0; i + 1 < nodeIds.length; i++) {
        const a = this.nodeIndex.get(nodeIds[i]);
        const b = this.nodeIndex.get(nodeIds[i + 1]);
        if (a === undefined || b === undefined) continue;
        this.railGraph.addEdge(nodeIds[i], nodeIds[i + 1], dist3(a.position, b.position), 'rail', route.id);
      }
    };

    const routeKind = (path: TravelPath): RailRoute['kind'] => {
      const hasSurface = path.edges.some((e) => e.kind === 'surface');
      const hasTunnel = path.edges.some((e) => e.kind === 'tunnel');
      return hasSurface && hasTunnel ? 'mixed' : hasTunnel ? 'tunnel' : 'surface';
    };

    // Each outpost hauls to its nearest refinery.
    for (const outpost of outposts) {
      const target = this.nearestNodeBy(outpost, refineries);
      if (target === null) continue;
      const path = this.transport.shortestPath(outpost.id, target.id, () => true);
      if (path === null || path.nodeIds.length < 2) continue;
      markRoute(
        `${outpost.name} Haul Line`,
        path.nodeIds,
        Math.round(path.totalLength * 100) / 100,
        routeKind(path),
      );
    }

    // Each dock shuttles to its nearest refinery.
    for (const dock of docks) {
      const target = this.nearestNodeBy(dock, refineries);
      if (target === null || this.railServed.has(dock.id)) continue;
      const path = this.transport.shortestPath(dock.id, target.id, () => true);
      if (path === null || path.nodeIds.length < 2) continue;
      markRoute(
        `${dock.name} Shuttle`,
        path.nodeIds,
        Math.round(path.totalLength * 100) / 100,
        routeKind(path),
      );
    }

    // Deep freight lines: dock/refinery → deepest reachable shaft-served cavern.
    const deepTargets = nodes
      .filter((n) => n.position.z < -60)
      .sort((a, b) => a.position.z - b.position.z || a.id.localeCompare(b.id))
      .slice(0, 6);
    for (const target of deepTargets) {
      const station = this.nearestNodeBy(
        target,
        nodes.filter((n) => (n.kind === 'dock' || n.kind === 'refinery') && n.position.z >= 0),
      );
      if (station === null) continue;
      const path = this.transport.shortestPath(station.id, target.id, (k) => k === 'tunnel' || k === 'surface');
      if (path === null || path.nodeIds.length < 3) continue;
      markRoute(
        `Deep Freight Line → ${target.name}`,
        path.nodeIds,
        Math.round(path.totalLength * 100) / 100,
        routeKind(path),
      );
    }

    return routes;
  }

  // -- tiny helpers ---------------------------------------------------------------

  private makeNode(kind: NodeKind, name: string, x: number, y: number, z: number, sectorId: string): LunarNode {
    this.idCounter++;
    return {
      id: `node-${this.idCounter.toString().padStart(4, '0')}`,
      kind,
      name,
      position: { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100 },
      sectorId,
    };
  }

  private makeTunnel(kind: TunnelKind, from: LunarNode, to: LunarNode, radius: number): TunnelSegment {
    return {
      id: `tun-${kind}-${this.tunnelSeq(kind)}`,
      kind,
      fromId: from.id,
      toId: to.id,
      start: { ...from.position },
      end: { ...to.position },
      radius,
      length: Math.round(dist3(from.position, to.position) * 100) / 100,
    };
  }

  private tunnelKindCounters = new Map<string, number>();
  private tunnelSeq(kind: string): string {
    const n = (this.tunnelKindCounters.get(kind) ?? 0) + 1;
    this.tunnelKindCounters.set(kind, n);
    return n.toString().padStart(3, '0');
  }

  private sectorIdFor(x: number, y: number): string {
    const col = Math.max(0, Math.min(this.sectorsX - 1, Math.floor(x / this.sectorSize)));
    const row = Math.max(0, Math.min(this.sectorsY - 1, Math.floor(y / this.sectorSize)));
    return `sector-${col}-${row}`;
  }

  private nearestNodeBy(
    from: { position: Vec3 } | LunarNode,
    candidates: LunarNode[],
    filter?: (n: LunarNode) => boolean,
  ): LunarNode | null {
    let best: LunarNode | null = null;
    let bestD = Infinity;
    for (const n of candidates) {
      if (n.id === (from as LunarNode).id) continue;
      if (filter !== undefined && !filter(n)) continue;
      const d = dist3(from.position, n.position);
      if (d < bestD || (d === bestD && best !== null && n.id < best.id)) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private nearestRailServedDistance(x: number, y: number, z: number): number {
    if (this.snapshot === null) this.generate();
    let best = Infinity;
    for (const id of this.railServed) {
      const n = this.nodeIndex.get(id);
      if (n === undefined) continue;
      const d = dist3({ x, y, z }, n.position);
      if (d < best) best = d;
    }
    return best;
  }

  private findFlatSpot(
    rng: Random,
    cx: number,
    cy: number,
    spread: number,
    elev: (x: number, y: number) => number,
  ): { x: number; y: number } {
    for (let attempt = 0; attempt < 14; attempt++) {
      const x = cx + rng.gaussian(0, spread / 2.5);
      const y = cy + rng.gaussian(0, spread / 2.5);
      if (Math.abs(elev(x, y)) < 8) return { x, y };
    }
    return { x: cx, y: cy };
  }

  /**
   * Deterministic name-table pick from an independent naming stream (derived
   * from seed + counter, so naming never disturbs the gameplay RNG sequence).
   */
  private pickName(table: readonly string[]): string {
    return table[this.nameStream(table.length)];
  }

  private nameStream(mod: number): number {
    this.nameCounter++;
    return parseInt(fnv1a(`${this.seed}#${this.nameCounter}`), 16) % mod;
  }

  private makeOutpostName(): string {
    return `${this.pickName(OUTPOST_PREFIX)} ${this.pickName(OUTPOST_SUFFIX)} ${this.nextNameTag()}`;
  }

  private nextNameTag(): string {
    return String.fromCharCode(65 + (this.nameCounter % 26)) + Math.floor(this.nameCounter / 26);
  }

  private sectorLabel(col: number): string {
    return String.fromCharCode(65 + (col % 26));
  }
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default LunarWorldGenerator;
