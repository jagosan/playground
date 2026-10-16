/**
 * Lunar Frontier — X-Corp Citadel "The Obsidian Apex" (Spec 26 §3.1).
 *
 * The apex predator of the lunar economy parks its headquarters in a highland
 * basin at (-1850, 2400): an 85 m obsidian carbon-composite monolith banded
 * with brushed gold mullions, cantilevered executive penthouse pods, a grand
 * maglev terminal viaduct sealed behind hydraulic blast gates, dual VIP
 * landing pads, and an impenetrable three-ring defense perimeter — warning
 * (260 m), kinetic forcefield dome (220 m), CIWS lethal zone (180 m) patrolled
 * by three 35 m sentry spires.
 *
 * The perimeter is a pure potential field over world metres, answered from
 * constructor options alone: `getPerimeterStatus()` and `update()` work
 * before `init()`, after `dispose()`, and with no scene at all, so quests,
 * HUD zones and the TrainHeistDirector (Spec 26 Phase 3) can never race the
 * mesh build.
 *
 * Repulsion model (Spec 26 §3.3 of the blueprint, k_shield = 45.0 N/m²):
 *   F(r) = 0                          if r > R_shield
 *   F(r) = k · (R_shield - r)²        if R_lethal < r ≤ R_shield
 *   F(r) = Infinity (destruction)     if r ≤ R_lethal
 * At the dome contact (r = 220) the force ramps in smoothly; by r = 200 it
 * already answers 18,000 N outward, and crossing the lethal threshold is
 * answered Infinity — the CIWS vaporization strike.
 *
 * Coordinates: world metres (x, y lateral, z up) map to Babylon (x, z↑, -y)
 * via the shared `worldToBabylon` from CameraRig — the citadel root sits ON
 * its world point; every child is placed in the Babylon-local y-up frame.
 * The maglev terminal faces the canonical Canyon Extraction Outpost bearing
 * (1200, 800) so the Phase 2 guideway terminates where the blast gates are.
 *
 * Headless-safe: `init()` accepts a Scene, a raw engine (a scene is created
 * around it), or nothing (self-owned NullEngine fallback). `dispose()` is
 * idempotent and never throws; after disposal every query still answers and
 * every accessor returns empty/null.
 *
 * Usage:
 *   const citadel = new XCorpCitadel().init(scene);
 *   const status = citadel.update(dt, playerPos); // per frame
 *   if (status.inLethalZone) vaporize(playerPos);
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

// -- canonical constants ------------------------------------------------------

/** Spec 26 §3.1.1: highland-basin citadel seat (world metres). */
export const CITADEL_DEFAULT_WORLD_CENTER: Readonly<{ x: number; y: number; z: number }> = {
  x: -1850,
  y: 2400,
  z: 0,
};

/** Spec 26 §3.1.2: active kinetic forcefield dome radius (m). */
export const DEFAULT_SHIELD_RADIUS_M = 220;
/** Spec 26 §3.1.2: CIWS lethal threshold radius (m). */
export const DEFAULT_LETHAL_RADIUS_M = 180;
/** Spec 26 §3.1.2: outer warning perimeter radius (m). */
export const DEFAULT_WARNING_RADIUS_M = 260;

/** Blueprint §3.3: shield potential-field stiffness k (N/m²). */
export const SHIELD_REPULSION_K = 45.0;

/** Answered instead of a finite force once the lethal threshold is crossed. */
export const LETHAL_STRIKE_FORCE_N = Infinity;

/** Spec 26 §3.1.1: central monolith height (m). */
export const MONOLITH_HEIGHT_M = 85;
/** Spec 26 §3.1.2: CIWS sentry spire height (m). */
export const SPIRE_HEIGHT_M = 35;
/** CIWS spires stand just inside the shield dome. */
export const SPIRE_RING_RADIUS_M = 200;
/** Spec 26 §3.1.1: dual VIP landing pads. */
export const VIP_PAD_COUNT = 2;

/** Canyon Extraction Outpost (Spec 26 §3.2.1) — the terminal faces it. */
export const CANYON_EXTRACTION_OUTPOST: Readonly<{ x: number; y: number }> = { x: 1200, y: 800 };

/**
 * World-frame bearing from the citadel centre to the canyon outpost: the
 * maglev viaduct leaves the blast gates along this heading so the Phase 2
 * guideway and the Phase 1 portal can never disagree.
 */
export const CITADEL_TERMINAL_HEADING_RAD = Math.atan2(
  CANYON_EXTRACTION_OUTPOST.y - CITADEL_DEFAULT_WORLD_CENTER.y,
  CANYON_EXTRACTION_OUTPOST.x - CITADEL_DEFAULT_WORLD_CENTER.x,
);

/** Root/material name prefix. */
export const CITADEL_NAME_PREFIX = 'xcorp-citadel';

// -- public shapes ------------------------------------------------------------

/** Construction options; every field falls back to the Spec 26 canonical. */
export interface CitadelOptions {
  /** Citadel seat in world metres (default { x: -1850, y: 2400, z: 0 }). */
  worldCenter: { x: number; y: number; z: number };
  /** Kinetic forcefield dome radius (default 220 m). */
  shieldRadiusM: number;
  /** CIWS lethal threshold radius (default 180 m). */
  lethalRadiusM: number;
  /** Outer warning perimeter radius (default 260 m). */
  warningRadiusM: number;
}

/** One perimeter evaluation for a world-frame point (Spec 26 contract). */
export interface CitadelPerimeterStatus {
  /** Horizontal (2D) distance to the citadel centre (m). */
  distanceM: number;
  /** Inside the broadcast warning perimeter (comms warning / HUD zone). */
  inWarningZone: boolean;
  /** Inside the kinetic forcefield dome (repulsion active). */
  inShieldPerimeter: boolean;
  /** Inside the CIWS lethal zone (destruction strike). */
  inLethalZone: boolean;
  /** Radial repulsion magnitude (N); 0 outside, Infinity on lethal strike. */
  repulsionForceN: number;
}

/** Shared PBR set, built once per citadel. */
interface CitadelMaterials {
  /** Obsidian carbon-composite shell (metallic 0.95, roughness 0.08). */
  obsidian: PBRMaterial;
  /** Brushed gold structural mullions. */
  gold: PBRMaterial;
  /** Tinted dielectric penthouse glass. */
  glass: PBRMaterial;
  /** Warm executive interior illumination (emissive). */
  interior: PBRMaterial;
  /** Neon-cyan kinetic barrier (emissive 0, 0.85, 1.0, translucent). */
  shield: PBRMaterial;
  /** Induction-coil chevron blue (emissive). */
  coil: PBRMaterial;
  /** CIWS targeting eye (red emissive). */
  target: PBRMaterial;
  /** Deck / plaza composite. */
  deck: PBRMaterial;
}

/** Turret head + bookkeeping for the CIWS tracking lerp. */
interface SentryTurret {
  head: TransformNode;
  yaw: number;
}

// -- helpers --------------------------------------------------------------------

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

/**
 * Radial repulsion magnitude per the blueprint potential field (force sign is
 * implicitly "-outward" — the caller applies -F·r̂; magnitude only here).
 */
function repulsionAt(r: number, shieldR: number, lethalR: number): number {
  if (r > shieldR) return 0;
  if (r <= lethalR) return LETHAL_STRIKE_FORCE_N;
  const d = shieldR - r;
  return SHIELD_REPULSION_K * d * d;
}

// ================================================================================

export class XCorpCitadel {
  // -- perimeter source of truth (pure math; scene-independent) ----------------
  private readonly center: { x: number; y: number; z: number };
  private readonly shieldRadiusM: number;
  private readonly lethalRadiusM: number;
  private readonly warningRadiusM: number;

  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;

  private root: TransformNode | null = null;
  private meshList: Mesh[] = [];
  private materials: CitadelMaterials | null = null;
  private materialList: PBRMaterial[] = [];
  private turrets: SentryTurret[] = [];
  /** Shield dome mesh handle for the shimmer pulse. */
  private shieldDome: Mesh | null = null;

  private elapsed = 0;
  private built = false;
  private disposed = false;

  constructor(options: Partial<CitadelOptions> = {}) {
    const wc = options.worldCenter ?? CITADEL_DEFAULT_WORLD_CENTER;
    this.center = {
      x: finiteOr(wc.x, CITADEL_DEFAULT_WORLD_CENTER.x),
      y: finiteOr(wc.y, CITADEL_DEFAULT_WORLD_CENTER.y),
      z: finiteOr(wc.z, CITADEL_DEFAULT_WORLD_CENTER.z),
    };
    let shield = finiteOr(options.shieldRadiusM, DEFAULT_SHIELD_RADIUS_M);
    let lethal = finiteOr(options.lethalRadiusM, DEFAULT_LETHAL_RADIUS_M);
    let warning = finiteOr(options.warningRadiusM, DEFAULT_WARNING_RADIUS_M);
    if (shield <= 0) shield = DEFAULT_SHIELD_RADIUS_M;
    if (lethal <= 0) lethal = DEFAULT_LETHAL_RADIUS_M;
    if (warning <= 0) warning = DEFAULT_WARNING_RADIUS_M;
    // Ring ordering is an invariant of the defense doctrine: lethal ≤ shield ≤ warn.
    lethal = Math.min(lethal, shield);
    warning = Math.max(warning, shield);
    this.shieldRadiusM = shield;
    this.lethalRadiusM = lethal;
    this.warningRadiusM = warning;
  }

  // -- spatial API (world frame, scene-independent) ------------------------------

  /**
   * Evaluate the defense perimeter at a world-frame point. Pure math over the
   * constructor options: answers before `init()`, after `dispose()`, and with
   * no scene. Non-finite input is answered as "far outside" (distance
   * Infinity, all zones false, zero force) so the HUD never flickers on a NaN.
   */
  getPerimeterStatus(pos: { x: number; y: number; z: number }): CitadelPerimeterStatus {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      return {
        distanceM: Infinity,
        inWarningZone: false,
        inShieldPerimeter: false,
        inLethalZone: false,
        repulsionForceN: 0,
      };
    }
    return this.statusAtDistance(Math.hypot(pos.x - this.center.x, pos.y - this.center.y));
  }

  /** Same evaluation from a precomputed horizontal distance (m). */
  statusAtDistance(distanceM: number): CitadelPerimeterStatus {
    const r = Number.isFinite(distanceM) ? distanceM : Infinity;
    return {
      distanceM: r,
      inWarningZone: r <= this.warningRadiusM,
      inShieldPerimeter: r <= this.shieldRadiusM,
      inLethalZone: r <= this.lethalRadiusM,
      repulsionForceN: repulsionAt(r, this.shieldRadiusM, this.lethalRadiusM),
    };
  }

  /** Citadel seat in world metres (copy). */
  getWorldCenter(): { x: number; y: number; z: number } {
    return { ...this.center };
  }

  /** Defense ring radii (m) as actually configured (post-clamp). */
  getDefenseRadii(): { lethalM: number; shieldM: number; warningM: number } {
    return { lethalM: this.lethalRadiusM, shieldM: this.shieldRadiusM, warningM: this.warningRadiusM };
  }

  // -- lifecycle -------------------------------------------------------------------

  /**
   * Build the citadel. Accepts an existing `Scene`, a raw engine (a scene is
   * created around it), or nothing — falling back to a self-owned
   * `NullEngine`, exactly what CI wants. Idempotent; refuses after `dispose()`.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('XCorpCitadel: init() after dispose()');
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
      throw new Error('XCorpCitadel.init: browser needs a Scene or Engine');
    }

    const scene = this.scene;
    this.root = new TransformNode(`${CITADEL_NAME_PREFIX}-system`, scene);
    this.root.position.copyFrom(worldToBabylon(this.center));
    this.materials = this.buildMaterials(scene);
    this.buildCitadel(scene);
    this.built = true;
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /**
   * One frame: shimmer the kinetic barrier, snap the CIWS turrets onto the
   * intruder while inside the warning perimeter, and return the perimeter
   * evaluation for the player position. Safe before init / after dispose
   * (pure query still answers; no mesh animation).
   */
  update(dt: number, playerPos: { x: number; y: number; z: number }): CitadelPerimeterStatus {
    const status = this.getPerimeterStatus(playerPos);
    if (this.disposed || !this.built || this.materials === null) return status;
    if (Number.isFinite(dt) && dt > 0) this.elapsed += dt;
    const t = this.elapsed;

    // Kinetic barrier shimmer: fast ion-current ripple over a slow breathe.
    const shimmer = 0.82 + 0.18 * Math.sin(t * 2.1) * Math.sin(t * 9.7);
    const intruderBoost = status.inShieldPerimeter ? 1.25 : status.inWarningZone ? 1.1 : 1;
    const s = this.materials.shield;
    s.emissiveColor.set(0, 0.85 * shimmer * intruderBoost, 1.0 * shimmer * intruderBoost);
    s.alpha = 0.12 + 0.05 * (0.5 + 0.5 * Math.sin(t * 1.3)) + (status.inShieldPerimeter ? 0.06 : 0);

    // CIWS tracking: heads lerp onto the intruder once it is worth looking at.
    if (Number.isFinite(status.distanceM) && status.inWarningZone) {
      const dx = playerPos.x - this.center.x;
      const dy = playerPos.y - this.center.y;
      // World (x, y) → Babylon local (x, -y): left-handed yaw about +y.
      const targetYaw = Math.atan2(dx, -dy);
      for (const turret of this.turrets) {
        let delta = targetYaw - turret.yaw;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        // 1.2 s lock-on spec → aggressive but smooth exponential chase.
        const k = Math.min(1, dt * 3.5);
        turret.yaw += delta * (Number.isFinite(k) ? k : 0);
        turret.head.rotation.y = turret.yaw;
      }
      const lock = Math.min(1, 0.6 + 0.4 * Math.sin(t * 12.9));
      this.materials.target.emissiveColor.set(1 * lock, 0.06 * lock, 0.04 * lock);
    }
    return status;
  }

  /** Tear down every mesh, material, root and any self-owned engine. Never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;

    for (const mesh of this.meshList) XCorpCitadel.disposeQuietly(mesh);
    this.meshList = [];
    for (const material of this.materialList) XCorpCitadel.disposeQuietly(material);
    this.materialList = [];
    this.materials = null;
    this.turrets = [];
    this.shieldDome = null;
    XCorpCitadel.disposeQuietly(this.root);
    this.root = null;

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) XCorpCitadel.disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- accessors -------------------------------------------------------------------

  /** System root transform (null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every citadel mesh including the shield dome (shadow/picking registration). */
  getMeshes(): AbstractMesh[] {
    return [...this.meshList];
  }

  /**
   * Shadow-casting subset of `getMeshes()`: the energy barrier is light, not
   * matter, and never occludes the sun.
   */
  getShadowCasterMeshes(): AbstractMesh[] {
    return this.meshList.filter((m) => {
      const part = m.metadata?.part as string | undefined;
      return part !== 'shield';
    });
  }

  /**
   * Meshes tagged with a part id — 'monolith' | 'crown' | 'antenna' |
   * 'mullion' | 'penthouse' | 'glass' | 'viaduct' | 'tunnel_arch' |
   * 'blast_gate' | 'landing_pad' | 'chevron' | 'shield' | 'spire' |
   * 'turret' | 'plaza' — the smoke suite's structural assertion handle.
   */
  getPartMeshes(part: string): Mesh[] {
    return this.meshList.filter((m) => (m.metadata?.part as string | undefined) === part);
  }

  // -- materials -------------------------------------------------------------------

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
    material.albedoColor = Color3.FromArray(albedo);
    material.metallic = metallic;
    material.roughness = roughness;
    if (emissive !== undefined) material.emissiveColor = Color3.FromArray(emissive);
    material.environmentIntensity = environmentIntensity;
    return material;
  }

  private buildMaterials(scene: Scene): CitadelMaterials {
    const materials: CitadelMaterials = {
      // Spec 26 §3.1.1: obsidian carbon-composite tiles, metallic 0.95,
      // roughness 0.08, deep obsidian black [0.02, 0.02, 0.03].
      obsidian: XCorpCitadel.mk(`${CITADEL_NAME_PREFIX}-obsidian`, scene, [0.02, 0.02, 0.03], 0.95, 0.08, undefined, 0.22),
      // Brushed gold mullions [0.85, 0.68, 0.22].
      gold: XCorpCitadel.mk(`${CITADEL_NAME_PREFIX}-gold`, scene, [0.85, 0.68, 0.22], 0.9, 0.35, undefined, 0.25),
      glass: XCorpCitadel.mk(`${CITADEL_NAME_PREFIX}-glass`, scene, [0.08, 0.14, 0.2], 0.6, 0.05, undefined, 0.5),
      interior: XCorpCitadel.mk(`${CITADEL_NAME_PREFIX}-interior`, scene, [0.1, 0.08, 0.04], 0.2, 0.6, [0.95, 0.66, 0.28], 0.1),
      // Spec 26 §3.1.2: emissive neon-cyan fresnel barrier Color3(0, 0.85, 1).
      shield: XCorpCitadel.mk(`${CITADEL_NAME_PREFIX}-shield`, scene, [0, 0.05, 0.08], 0, 0.2, [0, 0.85, 1.0], 0),
      coil: XCorpCitadel.mk(`${CITADEL_NAME_PREFIX}-coil`, scene, [0.02, 0.04, 0.1], 0.3, 0.4, [0.15, 0.5, 1.0], 0),
      target: XCorpCitadel.mk(`${CITADEL_NAME_PREFIX}-target`, scene, [0.1, 0.01, 0.01], 0.3, 0.4, [1.0, 0.06, 0.04], 0),
      deck: XCorpCitadel.mk(`${CITADEL_NAME_PREFIX}-deck`, scene, [0.09, 0.09, 0.1], 0.5, 0.55, undefined, 0.1),
    };
    // The barrier is translucent light: no lighting response, both faces.
    materials.shield.disableLighting = true;
    materials.shield.alpha = 0.14;
    materials.shield.backFaceCulling = false;
    materials.glass.alpha = 0.45;
    for (const material of Object.values(materials)) this.materialList.push(material);
    return materials;
  }

  // -- mesh construction --------------------------------------------------------------

  /** Create + place + parent + metadata-tag in one call (Babylon-local frame). */
  private part(
    name: string,
    partId: string,
    mesh: Mesh,
    mat: PBRMaterial,
    x: number,
    y: number,
    z: number,
    parent?: TransformNode,
  ): Mesh {
    mesh.material = mat;
    mesh.position.set(x, y, z);
    mesh.parent = parent ?? this.root;
    mesh.metadata = { part: partId, system: CITADEL_NAME_PREFIX };
    this.meshList.push(mesh);
    return mesh;
  }

  private buildCitadel(scene: Scene): void {
    const m = this.materials as CitadelMaterials; // set by init() before this call

    // -- central plaza ------------------------------------------------------------
    this.part('plaza', 'plaza',
      MeshBuilder.CreateCylinder(`${CITADEL_NAME_PREFIX}-plaza`, { diameter: 130, height: 1.6, tessellation: 32 }, scene),
      m.deck, 0, 0.8, 0);
    this.part('plaza-ring', 'plaza',
      MeshBuilder.CreateTorus(`${CITADEL_NAME_PREFIX}-plaza-ring`, { diameter: 130, thickness: 0.6, tessellation: 48 }, scene),
      m.gold, 0, 1.7, 0);

    // -- central monolith tower (Spec 26 §3.1.1) ------------------------------------
    // Hexagonal skyscraper, 85 m, obsidian tiles; hexagon corners carry the gold.
    this.part('monolith', 'monolith',
      MeshBuilder.CreateCylinder(`${CITADEL_NAME_PREFIX}-monolith`,
        { diameterTop: 20, diameterBottom: 30, height: MONOLITH_HEIGHT_M, tessellation: 6 }, scene),
      m.obsidian, 0, MONOLITH_HEIGHT_M / 2 + 1.6, 0);
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3; // hex corners at 60° steps
      this.part(`mullion-${i}`, 'mullion',
        MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-mullion-${i}`, { width: 1.1, depth: 1.1, height: MONOLITH_HEIGHT_M + 2 }, scene),
        m.gold, Math.cos(a) * 14.2, MONOLITH_HEIGHT_M / 2 + 1.6, Math.sin(a) * 14.2);
    }
    // Stepped setback crown + corporate antenna mast.
    this.part('crown', 'crown',
      MeshBuilder.CreateCylinder(`${CITADEL_NAME_PREFIX}-crown`, { diameterTop: 12, diameterBottom: 20, height: 9, tessellation: 6 }, scene),
      m.obsidian, 0, MONOLITH_HEIGHT_M + 9 / 2 + 1.6, 0);
    this.part('crown-band', 'crown',
      MeshBuilder.CreateTorus(`${CITADEL_NAME_PREFIX}-crown-band`, { diameter: 16, thickness: 0.8, tessellation: 24 }, scene),
      m.gold, 0, MONOLITH_HEIGHT_M + 1.6, 0);
    this.part('antenna', 'antenna',
      MeshBuilder.CreateCylinder(`${CITADEL_NAME_PREFIX}-antenna`, { diameterTop: 0.15, diameterBottom: 0.7, height: 16, tessellation: 8 }, scene),
      m.gold, 0, MONOLITH_HEIGHT_M + 9 + 8 + 1.6, 0);

    // -- executive penthouse pods (cantilevered, 3× around the shaft at 64 m) -------
    const PODS = [0.9, 2.99, 5.08]; // bearings (rad) — asymmetric on purpose
    PODS.forEach((bearing, i) => {
      const pod = new TransformNode(`${CITADEL_NAME_PREFIX}-pod-${i}`, scene);
      pod.parent = this.root;
      pod.rotation.y = -bearing;
      const podY = 64 + i * 4.5;
      this.part(`pod-body-${i}`, 'penthouse',
        MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-pod-body-${i}`, { width: 12, height: 6, depth: 9 }, scene),
        m.obsidian, 0, podY, 24, pod);
      // Panoramic panoramic bay window strip (tinted dielectric glass).
      this.part(`pod-glass-${i}`, 'glass',
        MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-pod-glass-${i}`, { width: 10.4, height: 3.4, depth: 0.3 }, scene),
        m.glass, 0, podY + 0.6, 28.6, pod);
      // Warm executive interior glow behind the glass.
      this.part(`pod-glow-${i}`, 'interior',
        MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-pod-glow-${i}`, { width: 9.6, height: 2.8, depth: 0.2 }, scene),
        m.interior, 0, podY + 0.6, 28.4, pod);
      // Cantilever support strut back to the shaft.
      this.part(`pod-strut-${i}`, 'penthouse',
        MeshBuilder.CreateCylinder(`${CITADEL_NAME_PREFIX}-pod-strut-${i}`, { diameter: 1.3, height: 14, tessellation: 8 }, scene),
        m.gold, 0, podY - 4.2, 17, pod);
    });

    // -- grand maglev terminal viaduct + blast gates (Spec 26 §3.1.1.3) --------------
    // Leaves the blast gates along the canonical canyon bearing; the Phase 2
    // HighSpeedMaglev guideway terminates on this deck.
    const terminal = new TransformNode(`${CITADEL_NAME_PREFIX}-terminal`, scene);
    terminal.parent = this.root;
    // World bearing → Babylon left-handed yaw about +y (y_world = -z_babylon).
    terminal.rotation.y = -CITADEL_TERMINAL_HEADING_RAD;
    // Monolithic portal portal penetrating the plaza toward the shaft.
    this.part('portal-block', 'viaduct',
      MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-portal-block`, { width: 26, height: 22, depth: 26 }, scene),
      m.obsidian, 0, 11, 44, terminal);
    // Arch axis lies along the approach (Babylon z); sunk to datum so the
    // buried half reads as the vaulted tunnel mouth.
    const portalArch = this.part('portal-arch', 'tunnel_arch',
      MeshBuilder.CreateCylinder(`${CITADEL_NAME_PREFIX}-portal-arch`,
        { diameter: 17, height: 27, tessellation: 24 }, scene),
      m.deck, 0, 0.4, 44, terminal);
    portalArch.rotation.x = Math.PI / 2;
    // Tunnel throat beyond the portal.
    const throat = this.part('tunnel-throat', 'tunnel_arch',
      MeshBuilder.CreateCylinder(`${CITADEL_NAME_PREFIX}-tunnel-throat`,
        { diameter: 15, height: 24, tessellation: 16 }, scene),
      m.deck, 0, 0.4, 68, terminal);
    throat.rotation.x = Math.PI / 2;
    // Twin hydraulic blast gates sealing the throat (zero external interfaces).
    this.part('blast-gate-l', 'blast_gate',
      MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-blast-gate-l`, { width: 7.2, height: 15, depth: 1.2 }, scene),
      m.gold, -3.7, 7.6, 60, terminal);
    this.part('blast-gate-r', 'blast_gate',
      MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-blast-gate-r`, { width: 7.2, height: 15, depth: 1.2 }, scene),
      m.gold, 3.7, 7.6, 60, terminal);
    // Elevated approach deck + pylons every 18 m out to the shield line.
    this.part('viaduct-deck', 'viaduct',
      MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-viaduct-deck`, { width: 14, height: 2.2, depth: 130 }, scene),
      m.deck, 0, 3.2, 143, terminal);
    for (let p = 0; p < 6; p++) {
      this.part(`viaduct-pylon-${p}`, 'viaduct',
        MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-viaduct-pylon-${p}`, { width: 3, height: 6.5, depth: 3 }, scene),
        m.obsidian, 0, 1.1, 88 + p * 22, terminal);
    }
    // Linear-induction guide rails pulsing along the deck.
    for (const side of [-1, 1]) {
      this.part(`viaduct-rail-${side}`, 'coil',
        MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-viaduct-rail-${side}`, { width: 0.6, height: 0.35, depth: 128 }, scene),
        m.coil, side * 4.4, 4.45, 143, terminal);
    }

    // -- dual VIP landing pads (Spec 26 §3.1.1.4) -------------------------------------
    const PAD_SLOTS = [
      { x: 62, z: -52, yaw: 0.6 },
      { x: -58, z: -60, yaw: -0.8 },
    ];
    PAD_SLOTS.forEach((slot, i) => {
      const pad = new TransformNode(`${CITADEL_NAME_PREFIX}-pad-${i}`, scene);
      pad.parent = this.root;
      pad.rotation.y = slot.yaw;
      this.part(`pad-deck-${i}`, 'landing_pad',
        MeshBuilder.CreateCylinder(`${CITADEL_NAME_PREFIX}-pad-deck-${i}`, { diameter: 26, height: 1.2, tessellation: 24 }, scene),
        m.deck, slot.x, 2.2, slot.z, pad);
      this.part(`pad-ring-${i}`, 'landing_pad',
        MeshBuilder.CreateTorus(`${CITADEL_NAME_PREFIX}-pad-ring-${i}`, { diameter: 24, thickness: 0.5, tessellation: 32 }, scene),
        m.coil, slot.x, 2.9, slot.z, pad);
      // Holographic guidance chevrons: three stacked V's on the approach axis.
      for (let c = 0; c < 3; c++) {
        const cd = 7 + c * 5.5;
        for (const sgn of [-1, 1]) {
          const chevron = this.part(`pad-chev-${i}-${c}-${sgn}`, 'chevron',
            MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-pad-chev-${i}-${c}-${sgn}`, { width: 3.4, height: 0.12, depth: 0.5 }, scene),
            m.coil, slot.x + sgn * 1.55, 2.95, slot.z + cd + c * 0.4, pad);
          chevron.rotation.y = sgn * 0.6;
        }
      }
    });

    // -- kinetic forcefield dome (Spec 26 §3.1.2) --------------------------------------
    // Geodesic (icosahedral) hemisphere at exactly R_shield; the barrier's lower
    // half is sub-regolith, the visible curtain reads as a hexagonal shimmer.
    const dome = this.part('shield-dome', 'shield',
      MeshBuilder.CreateIcoSphere(`${CITADEL_NAME_PREFIX}-shield`,
        { radius: this.shieldRadiusM, subdivisions: 2 }, scene),
      m.shield, 0, 0, 0);
    dome.isPickable = false;
    dome.receiveShadows = false;
    this.shieldDome = dome;

    // -- CIWS sentry spires ×3 (Spec 26 §3.1.2) ------------------------------------------
    for (let i = 0; i < 3; i++) {
      const bearing = (i * 2 * Math.PI) / 3 + Math.PI / 6;
      const sx = Math.cos(bearing) * SPIRE_RING_RADIUS_M;
      const sz = -Math.sin(bearing) * SPIRE_RING_RADIUS_M; // world y → babylon -z
      this.part(`spire-${i}`, 'spire',
        MeshBuilder.CreateCylinder(`${CITADEL_NAME_PREFIX}-spire-${i}`,
          { diameterTop: 1.4, diameterBottom: 4.4, height: SPIRE_HEIGHT_M, tessellation: 8 }, scene),
        m.obsidian, sx, SPIRE_HEIGHT_M / 2 + 1.6, sz);
      this.part(`spire-platform-${i}`, 'spire',
        MeshBuilder.CreateCylinder(`${CITADEL_NAME_PREFIX}-spire-platform-${i}`, { diameter: 6, height: 1, tessellation: 12 }, scene),
        m.deck, sx, SPIRE_HEIGHT_M + 1.6, sz);
      this.part(`spire-band-${i}`, 'spire',
        MeshBuilder.CreateTorus(`${CITADEL_NAME_PREFIX}-spire-band-${i}`, { diameter: 4.2, thickness: 0.4, tessellation: 16 }, scene),
        m.gold, sx, SPIRE_HEIGHT_M - 6, sz);
      // Rapid-traverse turret head (tracks the intruder in `update()`).
      const head = new TransformNode(`${CITADEL_NAME_PREFIX}-turret-${i}`, scene);
      head.parent = this.root;
      head.position.set(sx, SPIRE_HEIGHT_M + 3.2, sz);
      this.part(`turret-housing-${i}`, 'turret',
        MeshBuilder.CreateBox(`${CITADEL_NAME_PREFIX}-turret-housing-${i}`, { width: 2.6, height: 2, depth: 3.2 }, scene),
        m.deck, 0, 0, 0.6, head);
      this.part(`turret-eye-${i}`, 'turret',
        MeshBuilder.CreateSphere(`${CITADEL_NAME_PREFIX}-turret-eye-${i}`, { diameter: 0.7, segments: 8 }, scene),
        m.target, 0, 0.5, 2.3, head);
      for (const sgn of [-1, 1]) {
        this.part(`turret-barrel-${i}-${sgn}`, 'turret',
          MeshBuilder.CreateCylinder(`${CITADEL_NAME_PREFIX}-turret-barrel-${i}-${sgn}`,
            { diameter: 0.28, height: 4.6, tessellation: 6 }, scene),
          m.gold, sgn * 0.6, 0, 3.6, head);
      }
      this.turrets.push({ head, yaw: Math.atan2(sx, -sz) });
    }
  }

  // -- teardown helper -------------------------------------------------------------------

  private static disposeQuietly(target: { dispose(): unknown } | null): void {
    if (target === null) return;
    try {
      target.dispose();
    } catch {
      /* already gone */
    }
  }
}
