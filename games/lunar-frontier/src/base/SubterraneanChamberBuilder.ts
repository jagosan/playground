/**
 * Lunar Frontier — Spec 38 Phase 2: Procedural Subterranean Mesh Generation.
 *
 * Builds the three-tier underground base (Spec 38 §2.1 / §3 Phase 2) with
 * pure Babylon.js `MeshBuilder` geometry so it runs headless under a
 * `NullEngine` — zero DOM, canvas or GLB dependencies:
 *
 *  - **Central Vertical Shaft** — hexagonal concrete-composite retention rings
 *    lining the shaft from Z = −2.5 m down to Z = −92.5 m (Spec 38 §2:
 *    surface datum Z = 0 m → Tier 3 floor at Z = −95 m).
 *  - **Tier 1 — Living & Life Support Mezzanine** at Z = −15 m, a
 *    24 m × 24 m × 6.0 m vaulted-ceiling chamber with curved ceiling ribs,
 *    warm 3,200 K industrial strip lights (emissive) and rough-hewn basalt
 *    walls.
 *  - **Tier 2 — Heavy Industrial & Power Vault** at Z = −45 m, a
 *    36 m × 36 m × 9.0 m high-ceiling bay with steel columns and gantry
 *    beams.
 *  - **Tier 3 — Deep Core Lava Tube Cavern** at Z = −95 m, a
 *    60 m × 80 m × 14.0 m arched cavern with curved arch ribs over the roof.
 *
 * Coordinate contract mirrors {@link CameraRig.worldToBabylon}: world metres
 * (x, y lateral, z↑ elevation) map to Babylon left-handed y-up
 * (x, z↑, −y). The builder works entirely in the Babylon-local frame where
 * local +y == upward; each tier root sits at its chamber-floor datum
 * (−15 / −45 / −95 m).
 *
 * Visibility / occlusion culling (§3 Phase 2): {@link updateVisibility}
 * disables every subterranean mesh while the camera/player is on the surface
 * (cameraZ ≥ −2.0 m) and reveals the unlocked tiers' meshes once the camera
 * descends below −2.0 m.
 *
 * Usage:
 *   const builder = new SubterraneanChamberBuilder(scene);
 *   builder.build(3);                        // shaft + tiers 1..3
 *   builder.updateVisibility(playerZ);          // per-frame culling
 *   builder.dispose();                        // tear down everything
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

import { MAX_DEPTH_TIER, type DepthTierIndex } from './SubterraneanExcavator.ts';

// ---------------------------------------------------------------------------
// Spec 38 §2.1 — canonical depth-tier chamber geometry
// ---------------------------------------------------------------------------

/** Babylon-local elevation of the surface datum (m). */
export const SURFACE_ELEVATION_M = 0;

/**
 * Occlusion-culling threshold (Spec 38 §3 Phase 2): every subterranean mesh is
 * hidden while cameraZ ≥ −2.0 m (player on the surface); revealed below it.
 */
export const VISIBILITY_THRESHOLD_Z_M = -2.0;

/** Vertical pitch between hexagonal shaft retention rings (m). */
export const SHAFT_RING_SPACING_M = 5.0;

/** Depth of the first (shallowest) retention ring below the datum (m). */
export const SHAFT_RING_START_DEPTH_M = -2.5;

/** Hexagonal retention-ring outer diameter (m). */
export const SHAFT_RING_DIAMETER_M = 10.0;

/** Retention-ring wall thickness (m). */
export const SHAFT_RING_THICKNESS_M = 1.4;

/**
 * Number of hexagonal rings lining the shaft from −2.5 m to −92.5 m
 * (Spec 38 §2: Z = 0 → −95 m) at {@link SHAFT_RING_SPACING_M} pitch.
 */
export const SHAFT_RING_COUNT =
  Math.floor((92.5 - -SHAFT_RING_START_DEPTH_M) / SHAFT_RING_SPACING_M) + 1; // 19

/** Curved ceiling-rib sweep resolution (segments per arch). */
export const ARCH_SEGMENTS = 8;

/** Tier 1 vaulted-ceiling rib count. */
export const TIER1_RIB_COUNT = 5;

/** Tier 1 warm industrial strip-light fixture count (3,200 K emissive). */
export const TIER1_LIGHT_COUNT = 6;

/** Tier 2 power-vault gantry beam count. */
export const TIER2_BEAM_COUNT = 3;

/** Tier 3 arched-cavern roof rib count. */
export const TIER3_RIB_COUNT = 7;

/**
 * Static chamber dimensions per tier (Spec 38 §2.1): width × length × height,
 * plus the vaulted/arched ceiling rise above the wall tops.
 */
export interface ChamberTierConfig {
  tier: DepthTierIndex;
  /** Chamber floor datum (Babylon-local y, negative below surface). */
  floorY: number;
  /** Interior width along local x (m). */
  widthM: number;
  /** Interior length along local z (m). */
  lengthM: number;
  /** Interior wall height along local y (m). */
  heightM: number;
  /** Ceiling arch rise above the wall tops (0 = flat; m). */
  archRiseM: number;
}

/** Canonical tier chambers (Spec 38 §2.1), indexable by {@link DepthTierIndex}. */
export const CHAMBER_TIER_CONFIGS: Readonly<Record<DepthTierIndex, ChamberTierConfig>> = {
  0: { tier: 0, floorY: SURFACE_ELEVATION_M, widthM: 24, lengthM: 12, heightM: 4.0, archRiseM: 1.2 },
  1: { tier: 1, floorY: -15, widthM: 24, lengthM: 24, heightM: 6.0, archRiseM: 2.4 },
  2: { tier: 2, floorY: -45, widthM: 36, lengthM: 36, heightM: 9.0, archRiseM: 1.5 },
  3: { tier: 3, floorY: -95, widthM: 60, lengthM: 80, heightM: 14.0, archRiseM: 6.0 },
};

/** Root name prefix for every subterranean mesh / node / material. */
export const SUBTERRANEAN_NAME_PREFIX = 'subterranean';

// ---------------------------------------------------------------------------
// Materials (PBR — NullEngine-safe typed colours only)
// ---------------------------------------------------------------------------

interface SubterraneanMaterials {
  /** Rough-hewn basalt rock walls (Tier 1 & cavern). */
  basalt: PBRMaterial;
  /** Hexagonal concrete-composite shaft retention rings. */
  concreteComposite: PBRMaterial;
  /** High-ceiling industrial steel (Tier 2 bay). */
  industrialSteel: PBRMaterial;
  /** Vaulted / arched ceiling ribs. */
  vaultRib: PBRMaterial;
  /** Lava-tube basalt floor (Tier 3). */
  cavernFloor: PBRMaterial;
  /** Warm 3,200 K industrial strip light (emissive, unlit). */
  stripLight: StandardMaterial;
}

/**
 * Build the shared subterranean material set. Every colour is a literal RGB
 * triple — no texture uploads, safe on `NullEngine`.
 */
function buildMaterials(scene: Scene): SubterraneanMaterials {
  const pbr = (
    name: string,
    albedo: readonly [number, number, number],
    metallic: number,
    roughness: number,
  ): PBRMaterial => {
    const m = new PBRMaterial(`${SUBTERRANEAN_NAME_PREFIX}-${name}`, scene);
    m.albedoColor = Color3.FromArray(albedo);
    m.metallic = metallic;
    m.roughness = roughness;
    m.environmentIntensity = 0.05;
    return m;
  };

  const stripLight = new StandardMaterial(`${SUBTERRANEAN_NAME_PREFIX}-strip-light`, scene);
  // 3,200 K warm white (Spec 38 §2 / §3 Phase 2) — unlit emissive glow.
  stripLight.emissiveColor = new Color3(1.0, 0.83, 0.62);
  stripLight.disableLighting = true;

  return {
    basalt: pbr('basalt', [0.15, 0.14, 0.12], 0.04, 0.9),
    concreteComposite: pbr('concrete-composite', [0.21, 0.2, 0.19], 0.08, 0.82),
    industrialSteel: pbr('industrial-steel', [0.5, 0.52, 0.55], 0.85, 0.4),
    vaultRib: pbr('vault-rib', [0.28, 0.27, 0.26], 0.6, 0.7),
    cavernFloor: pbr('cavern-floor', [0.13, 0.12, 0.11], 0.05, 0.95),
    stripLight,
  };
}

// ---------------------------------------------------------------------------
// Arch-path helper (curved ceiling ribs / arched cavern roof)
// ---------------------------------------------------------------------------

/**
 * Produce `segs`+1 points tracing a semicircular arch of horizontal span
 * `spanX` and vertical rise `riseY`, centred at local origin, in the x-y
 * plane (Babylon local). Used to sweep curved ribs via `CreateTube`.
 */
function archPath(spanX: number, riseY: number, segs: number): Vector3[] {
  const pts: Vector3[] = [];
  const half = spanX / 2;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs; // 0..1
    const ang = Math.PI * t; // π..0 → left..right over the crown
    const x = -half * Math.cos(ang);
    const y = riseY * Math.sin(ang);
    pts.push(new Vector3(x, y, 0));
  }
  return pts;
}

// ---------------------------------------------------------------------------
// SubterraneanChamberBuilder
// ---------------------------------------------------------------------------

/**
 * Procedural subterranean base generator (Spec 38 §3 Phase 2). Builds the
 * central vertical shaft plus unlocked depth-tier chambers from pure `MeshBuilder`
 * geometry; culls everything while the camera is on the surface.
 */
export class SubterraneanChamberBuilder {
  private readonly scene: Scene;
  private root: TransformNode | null = null;
  /** One tier-root TransformNode per built tier (index by tier). */
  private readonly tierRoots: (TransformNode | null)[] = [null, null, null, null];
  private meshList: Mesh[] = [];
  private materialList: PBRMaterial[] = [];
  private stripLightMat: StandardMaterial | null = null;
  /** Deepest tier whose meshes were built. */
  private unlockedTier: DepthTierIndex = 0;
  private built = false;
  private disposed = false;

  constructor(scene: Scene) {
    if (scene === null || scene === undefined) {
      throw new Error('SubterraneanChamberBuilder: a Scene is required');
    }
    this.scene = scene;
  }

  // -- lifecycle --------------------------------------------------------------

  /**
   * Build the shaft plus every chamber tier up to `unlockedTier`. Idempotent
   * (a second call returns immediately); refuses after {@link dispose}.
   */
  build(unlockedTier: DepthTierIndex): this {
    if (this.disposed) throw new Error('SubterraneanChamberBuilder: build() after dispose()');
    if (this.built) return this;
    const target = Math.max(0, Math.min(MAX_DEPTH_TIER, Math.trunc(unlockedTier))) as DepthTierIndex;
    this.unlockedTier = target;

    this.root = new TransformNode(`${SUBTERRANEAN_NAME_PREFIX}-system`, this.scene);
    this.root.position.set(SURFACE_ELEVATION_M, SURFACE_ELEVATION_M, 0);

    const mats = buildMaterials(this.scene);
    for (const m of Object.values(mats)) {
      if (m instanceof PBRMaterial) this.materialList.push(m);
    }
    this.stripLightMat = mats.stripLight;

    this.buildShaft(mats);
    for (let t = 1; t <= target; t++) {
      const tier = t as DepthTierIndex;
      if (tier === 1) this.buildTier1(mats);
      else if (tier === 2) this.buildTier2(mats);
      else this.buildTier3(mats);
    }

    this.built = true;
    return this;
  }

  /**
   * Occlusion culling (§3 Phase 2): while the camera/player is on the
   * surface (cameraZ ≥ −2.0 m) every subterranean mesh is disabled; once
   * below −2.0 m the unlocked tiers' meshes are revealed.
   */
  updateVisibility(cameraZ: number): void {
    if (!this.built || this.disposed) return;
    const underground = Number.isFinite(cameraZ) && cameraZ < VISIBILITY_THRESHOLD_Z_M;
    for (const mesh of this.meshList) {
      const tier = (mesh.metadata?.tier as number | undefined) ?? 0;
      // Shaft rings carry tier 0 → always visible underground; chamber meshes
      // show only when their tier is unlocked.
      mesh.isVisible = underground && tier <= this.unlockedTier;
    }
  }

  /** Tear down every mesh, material and node. Idempotent; never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const mesh of this.meshList) {
      try {
        mesh.dispose();
      } catch {
        /* already gone */
      }
    }
    this.meshList = [];
    for (const mat of this.materialList) {
      try {
        mat.dispose();
      } catch {
        /* already gone */
      }
    }
    this.materialList = [];
    try {
      this.stripLightMat?.dispose();
    } catch {
      /* already gone */
    }
    this.stripLightMat = null;
    try {
      this.root?.dispose(false, true);
    } catch {
      /* already gone */
    }
    this.root = null;
    for (let i = 0; i < this.tierRoots.length; i++) this.tierRoots[i] = null;
    this.built = false;
  }

  // -- accessors --------------------------------------------------------------

  /** System root TransformNode (null before build / after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every subterranean mesh (copy; empty before build / after dispose). */
  getMeshes(): Mesh[] {
    return [...this.meshList];
  }

  /** Meshes tagged with a given part id — harness assertion handle. */
  getPartMeshes(part: string): Mesh[] {
    return this.meshList.filter((m) => (m.metadata?.part as string | undefined) === part);
  }

  /** Tier root TransformNode for `tier`, or null before build / after dispose. */
  getTierRoot(tier: DepthTierIndex): TransformNode | null {
    return this.tierRoots[tier];
  }

  /** True once {@link build} has created meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  // -- internal helpers --------------------------------------------------------

  /** Create + place + parent + tag a mesh; registers it in the mesh list. */
  private part(
    name: string,
    partId: string,
    tier: DepthTierIndex,
    mesh: Mesh,
    mat: PBRMaterial | StandardMaterial,
    x: number,
    y: number,
    z: number,
    parent: TransformNode,
  ): Mesh {
    mesh.material = mat;
    mesh.position.set(x, y, z);
    mesh.parent = parent;
    mesh.metadata = { part: partId, tier, system: SUBTERRANEAN_NAME_PREFIX };
    this.meshList.push(mesh);
    return mesh;
  }

  // -- shaft -----------------------------------------------------------------

  /** Hexagonal concrete-composite retention rings lining the central vertical shaft. */
  private buildShaft(mats: SubterraneanMaterials): void {
    const root = this.root as TransformNode;
    for (let i = 0; i < SHAFT_RING_COUNT; i++) {
      // Ring depths run −2.5 m → −92.5 m at 5 m pitch.
      const y = SHAFT_RING_START_DEPTH_M - i * SHAFT_RING_SPACING_M;
      const ring = MeshBuilder.CreateCylinder(
        `${SUBTERRANEAN_NAME_PREFIX}-shaft-ring-${i}`,
        {
          diameter: SHAFT_RING_DIAMETER_M,
          height: SHAFT_RING_THICKNESS_M,
          tessellation: 6, // hexagon cross-section
        },
        this.scene,
      );
      this.part(`shaft-ring-${i}`, 'shaft-ring', 0, ring, mats.concreteComposite, 0, y, 0, root);
    }
  }

  // -- Tier 1: Living & Life Support Mezzanine (Z = −15 m) --------------------

  /** Vaulted-ceiling chamber with curved ribs + warm strip lights + basalt walls. */
  private buildTier1(mats: SubterraneanMaterials): void {
    const cfg = CHAMBER_TIER_CONFIGS[1] as ChamberTierConfig;
    const root = this.tierRoot(cfg);
    const w = cfg.widthM; // 24
    const l = cfg.lengthM; // 24
    const h = cfg.heightM; // 6.0
    const rise = cfg.archRiseM; // 2.4 vault
    const wallT = 1.0;
    const slabT = 0.5;

    // Floor slab.
    this.part(
      'tier1-floor', 'floor', 1,
      MeshBuilder.CreateBox(`${SUBTERRANEAN_NAME_PREFIX}-tier1-floor`, { width: w, depth: l, height: slabT }, this.scene),
      mats.basalt, 0, -slabT / 2, 0, root,
    );
    // Ceiling slab above the vault crown.
    this.part(
      'tier1-ceiling', 'ceiling', 1,
      MeshBuilder.CreateBox(`${SUBTERRANEAN_NAME_PREFIX}-tier1-ceiling`, { width: w + 2, depth: l + 2, height: slabT }, this.scene),
      mats.concreteComposite, 0, h + rise - slabT / 2, 0, root,
    );
    // Four rough-hewn basalt walls.
    const wallY = h / 2;
    for (const [sx, sz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      this.part(
        `tier1-wall-${sx}_${sz}`, 'wall', 1,
        MeshBuilder.CreateBox(
          `${SUBTERRANEAN_NAME_PREFIX}-tier1-wall-${sx}_${sz}`,
          sx !== 0
            ? { width: wallT, depth: l + wallT * 2, height: h }
            : { width: w + wallT * 2, depth: wallT, height: h },
          this.scene,
        ),
        mats.basalt, (sx as number) * ((w + wallT) / 2), wallY, (sz as number) * ((l + wallT) / 2),
        root,
      );
    }
    // Vaulted ceiling ribs — curved tubes swept along the arch.
    for (let r = 0; r < TIER1_RIB_COUNT; r++) {
      const z = -l / 2 + ((r + 0.5) / TIER1_RIB_COUNT) * l;
      const pts = archPath(w, rise, ARCH_SEGMENTS).map((p) => new Vector3(p.x, h + p.y, z));
      const rib = MeshBuilder.CreateTube(
        `${SUBTERRANEAN_NAME_PREFIX}-tier1-rib-${r}`,
        { path: pts, radius: 0.18, tessellation: 6 },
        this.scene,
      );
      this.part(`tier1-rib-${r}`, 'vault-rib', 1, rib, mats.vaultRib, 0, 0, 0, root);
    }
    // Warm 3,200 K industrial strip lights under the ceiling.
    for (let i = 0; i < TIER1_LIGHT_COUNT; i++) {
      const x = -w / 2 + ((i + 0.5) / TIER1_LIGHT_COUNT) * w;
      this.part(
        `tier1-light-${i}`, 'strip-light', 1,
        MeshBuilder.CreateBox(`${SUBTERRANEAN_NAME_PREFIX}-tier1-light-${i}`, { width: w / TIER1_LIGHT_COUNT - 0.4, depth: 0.35, height: 0.08 }, this.scene),
        mats.stripLight, x, h + rise * 0.55, 0, root,
      );
    }
  }

  // -- Tier 2: Heavy Industrial & Power Vault (Z = −45 m) ---------------------

  /** High-ceiling industrial bay with steel columns and gantry beams. */
  private buildTier2(mats: SubterraneanMaterials): void {
    const cfg = CHAMBER_TIER_CONFIGS[2] as ChamberTierConfig;
    const root = this.tierRoot(cfg);
    const w = cfg.widthM; // 36
    const l = cfg.lengthM; // 36
    const h = cfg.heightM; // 9.0
    const rise = cfg.archRiseM; // 1.5 vault
    const wallT = 1.2;
    const slabT = 0.6;

    this.part(
      'tier2-floor', 'floor', 2,
      MeshBuilder.CreateBox(`${SUBTERRANEAN_NAME_PREFIX}-tier2-floor`, { width: w, depth: l, height: slabT }, this.scene),
      mats.cavernFloor, 0, -slabT / 2, 0, root,
    );
    this.part(
      'tier2-ceiling', 'ceiling', 2,
      MeshBuilder.CreateBox(`${SUBTERRANEAN_NAME_PREFIX}-tier2-ceiling`, { width: w + 2, depth: l + 2, height: slabT }, this.scene),
      mats.concreteComposite, 0, h + rise - slabT / 2, 0, root,
    );
    const wallY = h / 2;
    for (const [sx, sz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      this.part(
        `tier2-wall-${sx}_${sz}`, 'wall', 2,
        MeshBuilder.CreateBox(
          `${SUBTERRANEAN_NAME_PREFIX}-tier2-wall-${sx}_${sz}`,
          sx !== 0
            ? { width: wallT, depth: l + wallT * 2, height: h }
            : { width: w + wallT * 2, depth: wallT, height: h },
          this.scene,
        ),
        mats.industrialSteel, (sx as number) * ((w + wallT) / 2), wallY, (sz as number) * ((l + wallT) / 2),
        root,
      );
    }
    // Steel columns at the four interior corners.
    const colX = w / 4;
    const colZ = l / 4;
    for (const [cx, cz] of [
      [-colX, -colZ],
      [colX, -colZ],
      [-colX, colZ],
      [colX, colZ],
    ] as const) {
      this.part(
        `tier2-column-${cx}_${cz}`, 'column', 2,
        MeshBuilder.CreateBox(`${SUBTERRANEAN_NAME_PREFIX}-tier2-column-${cx}_${cz}`, { width: 1.0, depth: 1.0, height: h }, this.scene),
        mats.industrialSteel, cx, wallY, cz, root,
      );
    }
    // Gantry beams spanning the bay near the ceiling.
    for (let b = 0; b < TIER2_BEAM_COUNT; b++) {
      const z = -l / 2 + ((b + 1) / (TIER2_BEAM_COUNT + 1)) * l;
      this.part(
        `tier2-beam-${b}`, 'beam', 2,
        MeshBuilder.CreateBox(`${SUBTERRANEAN_NAME_PREFIX}-tier2-beam-${b}`, { width: w - 4, depth: 0.5, height: 0.9 }, this.scene),
        mats.industrialSteel, 0, h - 1.6, z, root,
      );
    }
  }

  // -- Tier 3: Deep Core Lava Tube Cavern (Z = −95 m) ------------------------

  /** Arched lava-tube cavern with curved roof ribs over the 60 × 80 m floor. */
  private buildTier3(mats: SubterraneanMaterials): void {
    const cfg = CHAMBER_TIER_CONFIGS[3] as ChamberTierConfig;
    const root = this.tierRoot(cfg);
    const w = cfg.widthM; // 60 (x)
    const l = cfg.lengthM; // 80 (z)
    const h = cfg.heightM; // 14.0
    const rise = cfg.archRiseM; // 6.0 arch
    const wallT = 2.5;
    const slabT = 1.0;

    this.part(
      'tier3-floor', 'floor', 3,
      MeshBuilder.CreateBox(`${SUBTERRANEAN_NAME_PREFIX}-tier3-floor`, { width: w, depth: l, height: slabT }, this.scene),
      mats.cavernFloor, 0, -slabT / 2, 0, root,
    );
    // Two long side walls (along z).
    for (const sx of [1, -1]) {
      this.part(
        `tier3-sidewall-${sx}`, 'wall', 3,
        MeshBuilder.CreateBox(`${SUBTERRANEAN_NAME_PREFIX}-tier3-sidewall-${sx}`, { width: wallT, depth: l + wallT * 2, height: h }, this.scene),
        mats.basalt, sx * ((w + wallT) / 2), h / 2, 0, root,
      );
    }
    // Two end caps (along x).
    for (const sz of [1, -1]) {
      this.part(
        `tier3-endcap-${sz}`, 'wall', 3,
        MeshBuilder.CreateBox(`${SUBTERRANEAN_NAME_PREFIX}-tier3-endcap-${sz}`, { width: w + wallT * 2, depth: wallT, height: h }, this.scene),
        mats.basalt, 0, h / 2, sz * ((l + wallT) / 2), root,
      );
    }
    // Arched roof ribs — curved tubes sweeping the cavern crown along z.
    for (let r = 0; r < TIER3_RIB_COUNT; r++) {
      const z = -l / 2 + ((r + 0.5) / TIER3_RIB_COUNT) * l;
      const pts = archPath(w, rise, ARCH_SEGMENTS).map((p) => new Vector3(p.x, h + p.y, z));
      const rib = MeshBuilder.CreateTube(
        `${SUBTERRANEAN_NAME_PREFIX}-tier3-rib-${r}`,
        { path: pts, radius: 0.5, tessellation: 6 },
        this.scene,
      );
      this.part(`tier3-rib-${r}`, 'arch-rib', 3, rib, mats.vaultRib, 0, 0, 0, root);
    }
  }

  // -- shared tier-root helper --------------------------------------------------

  /** Create (once) + return the tier root TransformNode at the chamber floor datum. */
  private tierRoot(cfg: ChamberTierConfig): TransformNode {
    const existing = this.tierRoots[cfg.tier];
    if (existing !== null) return existing;
    const node = new TransformNode(`${SUBTERRANEAN_NAME_PREFIX}-tier${cfg.tier}`, this.scene);
    node.position.set(0, cfg.floorY, 0);
    node.parent = this.root ?? null;
    this.tierRoots[cfg.tier] = node;
    return node;
  }
}

export type { AbstractMesh };
