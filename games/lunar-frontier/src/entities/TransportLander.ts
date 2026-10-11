/**
 * Lunar Frontier — procedural CEC Ore-Hauler transport lander (Spec 24 Phase 1).
 *
 * The dropship that carries the player to the frontier. Built entirely from
 * Babylon.js primitives (zero GLB assets) so it boots instantly and headless: a
 * heavy octagonal fuselage, faceted heat-shield base, observation viewport, four
 * telescopic landing struts with dish footpads, a stern hydraulic cargo ramp that
 * lowers to the regolith, and four retro-thruster bells with emissive throats
 * and dynamic point lights.
 *
 * Geometry (Babylon y-up metres; regolith datum at y = 0):
 *   - Octagonal fuselage Ø8.5 m, height 20 m (Spec 24 §4.1 "heavy
 *     cylindrical octagonal fuselage"), tessellation 8 → eight flat armor facets.
 *   - Faceted heat-shield tiling on the bottom base; high-gain antenna mast.
 *   - 4 landing struts at the diagonal corners, each a hydraulic piston + dish
 *     footpad (Spec §4.1: "wide dish footpads Ø 2.2 m").
 *   - Stern cargo ramp: 6 m slab + safety side railings on a stern-floor pivot
 *     that rotates from 0° (sealed horizontal) to −35° (−0.6108 rad, resting
 *     on regolith). `setRampDeployment(progress)` maps [0,1] onto that sweep.
 *   - 4 gimballed descent engine bells with emissive throat interiors and a
 *     PointLight each; `setThrusterIntensity` drives both together.
 *
 * Frame convention matches CameraRig / every other entity: the caller passes a
 * Babylon-frame `position` (y-up) directly; heading (radians, 0 = +x world)
 * maps to Babylon `rotation.y = PI/2 + heading`, so lander, camera and physics
 * never disagree about which way the nose points. World-space spawn/exit anchors
 * are returned by transforming local anchor points through the root's world matrix.
 *
 * Headless-safe: takes an existing `Scene` (a NullEngine scene works — no DOM,
 * no render loop). `dispose()` is idempotent and never throws; it clears the
 * gear-rebound timer, disposes every mesh/light/material and both transform
 * nodes. After disposal all mutators are silent no-ops.
 */

import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';

// ---------------------------------------------------------------------------
// Geometry contract (Spec 24 §4.1)
// ---------------------------------------------------------------------------

/** Octagonal fuselage diameter, metres (Ø8.5 m). */
export const HULL_DIAMETER_M = 8.5;
/** Fuselage height, metres (the hull proper, below the nose cone). */
export const HULL_HEIGHT_M = 20;
/** Hull radius, metres. */
export const HULL_RADIUS_M = HULL_DIAMETER_M / 2;
/** Fuselage centre elevation, metres (hull spans 2 … 22). */
export const HULL_CENTER_Y = 12;

/** Heat-shield base disc diameter, metres (slightly proud of the hull). */
export const HEAT_SHIELD_DIAMETER_M = 9.1;
/** Heat-shield slab thickness, metres. */
export const HEAT_SHIELD_THICKNESS_M = 0.35;
/** Heat-shield centre elevation (bottom cap of the hull). */
export const HEAT_SHIELD_Y = 2.05;

/** Nose-cone height, metres (tapers to a point above the hull). */
export const NOSE_HEIGHT_M = 4;
/** Antenna mast height above the nose tip, metres. */
export const ANTENNA_HEIGHT_M = 3.5;

/** Landing-strut radial offset from the hull axis, metres. */
export const STRUT_RADIUS_M = 2.6;
/** Strut piston diameter, metres. */
export const STRUT_PISTON_DIAMETER_M = 0.8;
/** Dish footpad diameter, metres (Spec §4.1: Ø 2.2 m). */
export const FOOTPAD_DIAMETER_M = 2.3;
/** Footpad centre elevation above datum, metres. */
export const FOOTPAD_Y = 0.18;
/** Metres each footpad sinks during `triggerGearCompression`. */
export const GEAR_COMPRESSION_M = 0.32;
/** Default gear-compression rebound duration, ms. */
export const GEAR_REBOUND_MS = 900;

/** Engine-bell radial offset from the hull axis, metres. */
export const ENGINE_RADIUS_M = 2.9;
/** Engine-bell top (throat) / bottom (mouth) diameters, metres. */
export const ENGINE_BELL_TOP_DIAMETER_M = 1.5;
export const ENGINE_BELL_BOTTOM_DIAMETER_M = 2.3;
/** Engine-bell height, metres. */
export const ENGINE_BELL_HEIGHT_M = 2.0;
/** Engine-bell centre elevation (bells hang below the hull base). */
export const ENGINE_BELL_Y = 1.05;

/** Retro-thruster PointLight peak intensity at full burn. */
export const THRUSTER_LIGHT_INTENSITY = 6.5;
/** Thruster PointLight throw range, metres. */
export const THRUSTER_LIGHT_RANGE_M = 26;

/** Cargo-ramp slab length along −z from the stern pivot, metres (6 m). */
export const RAMP_LENGTH_M = 6;
/** Cargo-ramp slab width across x, metres. */
export const RAMP_WIDTH_M = 4.2;
/** Full deployment ramp angle below horizontal, radians (−35°). */
export const RAMP_FULL_ANGLE_RAD = (35 * Math.PI) / 180;

/**
 * Cargo-deck elevation: the stern ramp pivot sits high enough that, fully
 * deployed at −35°, the 6 m slab tip lands exactly on the regolith datum.
 */
const DECK_Y_M = RAMP_LENGTH_M * Math.sin(RAMP_FULL_ANGLE_RAD);

/** Local (root-frame) anchor for the passenger cabin spawn point. */
const CABIN_SPAWN_LOCAL = new Vector3(0, 18, 1.4);
/**
 * Local (root-frame) anchor where the fully-deployed ramp tip rests on regolith:
 * stern offset + slab reach at full angle.
 */
const RAMP_EXIT_LOCAL = new Vector3(
  0,
  DECK_Y_M - RAMP_LENGTH_M * Math.sin(RAMP_FULL_ANGLE_RAD),
  -(HULL_RADIUS_M + RAMP_LENGTH_M * Math.cos(RAMP_FULL_ANGLE_RAD)),
);

/** Emissive base of the engine throats at full burn (cyan-white plasma). */
const THROAT_EMISSIVE_BASE = new Color3(0.9, 1.15, 1.35);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TransportLanderOptions {
  /** The scene to build into (a NullEngine scene is fine). */
  scene: Scene;
  /** Position of the lander root in Babylon y-up frame, metres. */
  position: Vector3;
  /** Heading, radians in the world x-y plane (0 = +x). Default 0. */
  headingRad?: number;
  /**
   * Initial stern-ramp angle, radians (clamped to [−RAMP_FULL_ANGLE_RAD, 0];
   * negative lowers toward the regolith). Default 0 (sealed horizontal).
   */
  rampAngleRad?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/**
 * CEC Ore-Hauler transport lander. Owns its procedural kit; see the file header
 * for the geometry contract and frame convention.
 */
export class TransportLander {
  /** Root transform node of the whole lander (world pose lives here). */
  readonly rootNode: TransformNode;
  /** Stern cargo-ramp pivot node — rotate about x to deploy. */
  readonly rampNode: TransformNode;
  /** Four retro-thruster PointLights at the engine-bell throats. */
  readonly thrusterLights: PointLight[];

  private readonly scene: Scene;
  private readonly prefix = 'transport';

  private meshes: Mesh[] = [];
  private materials: PBRMaterial[] = [];

  /** Emissive throat materials driven by `setThrusterIntensity`. */
  private throatMats: PBRMaterial[] = [];
  /** Strut footpad + piston meshes (per strut) for gear compression. */
  private gearFootpads: Mesh[] = [];
  private gearPistons: Mesh[] = [];

  private disposed = false;
  private rampAngleRad = 0;
  private thrusterIntensity = 0;

  /** Pending gear-rebound timer (cleared on dispose). */
  private reboundTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TransportLanderOptions) {
    if (options.scene === null || options.scene === undefined) {
      throw new Error('TransportLander: scene is required');
    }
    this.scene = options.scene;
    const headingRad = Number.isFinite(options.headingRad)
      ? (options.headingRad as number)
      : 0;

    // -- root + ramp pivot -----------------------------------------------------
    this.rootNode = new TransformNode(`${this.prefix}-root`, this.scene);
    this.rootNode.position.copyFrom(options.position);
    // Shared heading map (CameraRig / LoadingDockMech): world heading 0 = +x.
    this.rootNode.rotation.set(0, Math.PI / 2 + headingRad, 0);

    // Stern pivot at the cargo-deck datum on the −z face of the hull.
    this.rampNode = new TransformNode(`${this.prefix}-ramp-hinge`, this.scene);
    this.rampNode.parent = this.rootNode;
    this.rampNode.position.set(0, DECK_Y_M, -HULL_RADIUS_M);

    // Thruster lights are parented to the root (static lander, no render loop).
    this.thrusterLights = [];

    this.buildMaterials();
    this.buildFuselage();
    this.buildLandingGear();
    this.buildEngines();
    this.buildCargoRamp();

    // Apply the optional initial ramp angle (clamped to the mechanical stop).
    if (Number.isFinite(options.rampAngleRad)) {
      this.setRampAngleRad(options.rampAngleRad as number);
    }

    // Force a truthful world matrix so headless anchor queries read correctly
    // without an intervening render().
    this.rootNode.computeWorldMatrix(true);
  }

  // -- ramp kinematics ---------------------------------------------------------

  /**
   * Set the stern cargo-ramp deployment, `progress` ∈ [0,1]:
   * 0 = sealed horizontal (0°), 1 = fully deployed resting on regolith (−35°).
   * The ramp pivot rotates about local x so the far end sweeps down toward the
   * lunar surface. Clamped; safe before/after dispose.
   */
  setRampDeployment(progress: number): void {
    if (this.disposed) return;
    const p = clamp01(Number.isFinite(progress) ? progress : 0);
    this.setRampAngleRad(-RAMP_FULL_ANGLE_RAD * p);
  }

  /** Current ramp pivot angle, radians (≤ 0; −0.6108 at full deploy). */
  getRampAngleRad(): number {
    return this.rampAngleRad;
  }

  /**
   * Apply an absolute stern-ramp pivot angle in radians, clamped to
   * [−RAMP_FULL_ANGLE_RAD, 0]. Safe before/after dispose.
   */
  setRampAngleRad(angleRad: number): void {
    if (this.disposed) return;
    this.rampAngleRad = clamp(
      Number.isFinite(angleRad) ? angleRad : 0,
      -RAMP_FULL_ANGLE_RAD,
      0,
    );
    this.rampNode.rotation.x = this.rampAngleRad;
  }

  // -- thruster lighting -------------------------------------------------------

  /**
   * Drive the retro-thruster glow: `intensity` ∈ [0,1] scales every
   * thruster PointLight and the emissive throat materials together. Clamped;
   * safe before/after dispose.
   */
  setThrusterIntensity(intensity: number): void {
    if (this.disposed) return;
    const i = clamp01(Number.isFinite(intensity) ? intensity : 0);
    this.thrusterIntensity = i;
    for (const light of this.thrusterLights) {
      light.intensity = THRUSTER_LIGHT_INTENSITY * i;
    }
    for (const mat of this.throatMats) {
      mat.emissiveColor.set(
        THROAT_EMISSIVE_BASE.r * i,
        THROAT_EMISSIVE_BASE.g * i,
        THROAT_EMISSIVE_BASE.b * i,
      );
    }
  }

  /** Current thruster intensity in [0,1]. */
  getThrusterIntensity(): number {
    return this.thrusterIntensity;
  }

  // -- landing gear ------------------------------------------------------------

  /**
   * Trigger the touchdown shock-compression animation: every strut footpad sinks
   * `GEAR_COMPRESSION_M` and its piston telescopes, then rebounds rigid after
   * `durationMs` (default 900 ms). Headless-safe — the rebound is a wall-clock
   * timer, no render loop required. Safe before/after dispose.
   */
  triggerGearCompression(durationMs = GEAR_REBOUND_MS): void {
    if (this.disposed) return;
    const dur = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : GEAR_REBOUND_MS;

    // Compress every strut.
    for (let i = 0; i < this.gearFootpads.length; i++) {
      const foot = this.gearFootpads[i];
      const piston = this.gearPistons[i];
      if (foot.isDisposed() || piston.isDisposed()) continue;
      foot.position.y -= GEAR_COMPRESSION_M;
      piston.scaling.y = 0.9;
    }

    // Schedule the rigid rebound.
    if (this.reboundTimer !== null) clearTimeout(this.reboundTimer);
    const timer = setTimeout(() => this.reboundGear(), dur);
    // `unref()` keeps a headless Node process from hanging on the timer.
    const unrefable = timer as unknown as { unref?: () => void };
    if (typeof unrefable?.unref === 'function') unrefable.unref();
    this.reboundTimer = timer;
  }

  /** Restore struts to their rest pose. */
  private reboundGear(): void {
    this.reboundTimer = null;
    if (this.disposed) return;
    for (let i = 0; i < this.gearFootpads.length; i++) {
      const foot = this.gearFootpads[i];
      const piston = this.gearPistons[i];
      if (foot.isDisposed() || piston.isDisposed()) continue;
      foot.position.y += GEAR_COMPRESSION_M;
      piston.scaling.y = 1;
    }
  }

  // -- world anchors -----------------------------------------------------------

  /**
   * World coordinate inside the passenger cabin (the local anchor transformed
   * through the root's world matrix) — where the player spawns seated.
   */
  getCabinSpawnPoint(): Vector3 {
    return this.toWorld(CABIN_SPAWN_LOCAL);
  }

  /**
   * World coordinate at the base of the fully-deployed ramp on regolith — where
   * the player's boots touch lunar dust. Reflects full deployment (the walkout
   * anchor), independent of the current ramp angle.
   */
  getRampExitPoint(): Vector3 {
    return this.toWorld(RAMP_EXIT_LOCAL);
  }

  /** Transform a local anchor point into world space via the root matrix. */
  private toWorld(local: Vector3): Vector3 {
    if (this.disposed || this.rootNode.isDisposed()) {
      return new Vector3(Number.NaN, Number.NaN, Number.NaN);
    }
    const m = this.rootNode.getWorldMatrix();
    return Vector3.TransformCoordinates(local.clone(), m);
  }

  // -- lifecycle --------------------------------------------------------------

  /** Every lander mesh (shadow casters / picking registration). */
  getMeshes(): Mesh[] {
    return [...this.meshes];
  }

  /** Root transform node of the lander. */
  getRootNode(): TransformNode {
    return this.rootNode;
  }

  /** The scene the lander lives in. */
  getScene(): Scene {
    return this.scene;
  }

  /**
   * Tear down every mesh, light, material and both transform nodes. Idempotent,
   * never throws; clears the gear-rebound timer.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.reboundTimer !== null) {
      try {
        clearTimeout(this.reboundTimer);
      } catch {
        /* already fired */
      }
      this.reboundTimer = null;
    }

    for (const light of this.thrusterLights) TransportLander.disposeQuietly(light);
    // `thrusterLights` is readonly — clear in place so post-dispose readback
    // sees an empty list (matches the smoke contract).
    this.thrusterLights.length = 0;
    for (const mesh of this.meshes) TransportLander.disposeQuietly(mesh);
    this.meshes = [];
    this.gearFootpads = [];
    this.gearPistons = [];
    for (const material of this.materials) TransportLander.disposeQuietly(material);
    this.materials = [];
    this.throatMats = [];

    TransportLander.disposeQuietly(this.rampNode);
    TransportLander.disposeQuietly(this.rootNode);
  }

  // -- construction ------------------------------------------------------------

  /** Build the shared PBR material set (armor, heat shield, steel, throat…). */
  private buildMaterials(): void {
    const p = this.prefix;
    const m = (
      name: string,
      albedo: [number, number, number],
      metallic: number,
      roughness: number,
    ): PBRMaterial => {
      const mat = new PBRMaterial(`${p}-${name}`, this.scene);
      mat.albedoColor = new Color3(albedo[0], albedo[1], albedo[2]);
      mat.metallic = metallic;
      mat.roughness = roughness;
      mat.environmentIntensity = 0.04; // vacuum: almost nothing to reflect
      this.materials.push(mat);
      return mat;
    };

    m('armor', [0.72, 0.74, 0.78], 0.8, 0.3);        // faceted armor plating
    m('heat-shield', [0.16, 0.15, 0.17], 0.35, 0.82); // re-entry soot tile
    m('steel', [0.58, 0.59, 0.62], 0.9, 0.32);      // struts / pistons
    m('footpad', [0.1, 0.11, 0.12], 0.5, 0.6);      // dish footpads
    m('bell', [0.22, 0.2, 0.19], 0.55, 0.72);        // soot-stained bells
    m('railing', [0.9, 0.62, 0.14], 0.3, 0.6);       // hazard-amber railings

    // Emissive thruster throat: starts black (no burn), driven by intensity.
    const throat = new PBRMaterial(`${p}-throat`, this.scene);
    throat.albedoColor = new Color3(1, 1, 1);
    throat.metallic = 0;
    throat.roughness = 0.2;
    throat.emissiveColor = new Color3(0, 0, 0);
    throat.environmentIntensity = 0;
    this.materials.push(throat);

    // Translucent observation viewport glass with emissive trim.
    const glass = new PBRMaterial(`${p}-viewport`, this.scene);
    glass.albedoColor = new Color3(0.25, 0.55, 0.7);
    glass.metallic = 0;
    glass.roughness = 0.15;
    glass.emissiveColor = new Color3(0.12, 0.32, 0.4);
    glass.environmentIntensity = 0.04;
    glass.alpha = 0.45;
    this.materials.push(glass);

    // Emissive green phosphor vector trim (cabin / viewport frame).
    const trim = new PBRMaterial(`${p}-trim`, this.scene);
    trim.albedoColor = new Color3(0.35, 0.9, 0.55);
    trim.metallic = 0;
    trim.roughness = 0.4;
    trim.emissiveColor = new Color3(0.2, 0.75, 0.45);
    trim.environmentIntensity = 0;
    this.materials.push(trim);

    // Cache the throat material for `setThrusterIntensity`.
    this.throatMats = [throat];
  }

  /** Octagonal fuselage + heat shield + nose cone + antenna + viewport. */
  private buildFuselage(): void {
    const scene = this.scene;
    const p = this.prefix;
    const armor = this.mat('armor');
    const shield = this.mat('heat-shield');
    const steel = this.mat('steel');
    const glass = this.mat('viewport');
    const trim = this.mat('trim');

    // Octagonal hull cylinder (tessellation 8 → eight flat facets).
    const hull = MeshBuilder.CreateCylinder(
      `${p}-hull`,
      { diameter: HULL_DIAMETER_M, height: HULL_HEIGHT_M, tessellation: 8 },
      scene,
    );
    hull.position.set(0, HULL_CENTER_Y, 0);
    this.track(hull, armor);

    // Faceted heat-shield base cap (slightly proud of the hull).
    const shieldMesh = MeshBuilder.CreateCylinder(
      `${p}-heat-shield`,
      { diameter: HEAT_SHIELD_DIAMETER_M, height: HEAT_SHIELD_THICKNESS_M, tessellation: 8 },
      scene,
    );
    shieldMesh.position.set(0, HEAT_SHIELD_Y, 0);
    this.track(shieldMesh, shield);

    // Tapered octagonal nose cone.
    const nose = MeshBuilder.CreateCylinder(
      `${p}-nose`,
      {
        diameterTop: 1.2,
        diameterBottom: HULL_DIAMETER_M * 0.72,
        height: NOSE_HEIGHT_M,
        tessellation: 8,
      },
      scene,
    );
    nose.position.set(0, HULL_CENTER_Y + HULL_HEIGHT_M / 2 + NOSE_HEIGHT_M / 2 - 0.4, 0);
    this.track(nose, armor);

    // High-gain antenna mast on the nose tip.
    const antenna = MeshBuilder.CreateCylinder(
      `${p}-antenna`,
      { diameter: 0.16, height: ANTENNA_HEIGHT_M, tessellation: 6 },
      scene,
    );
    antenna.position.set(0, HULL_CENTER_Y + HULL_HEIGHT_M / 2 + NOSE_HEIGHT_M + ANTENNA_HEIGHT_M / 2 - 1.4, 0);
    this.track(antenna, steel);

    // Observation viewport: recessed glass window on the upper hull (+z face).
    const viewport = MeshBuilder.CreateBox(
      `${p}-viewport`,
      { width: 3.2, height: 1.6, depth: 0.28 },
      scene,
    );
    viewport.position.set(0, 20, HULL_RADIUS_M - 0.05);
    this.track(viewport, glass);

    // Emissive trim ring framing the window.
    const trimRing = MeshBuilder.CreateBox(
      `${p}-viewport-trim`,
      { width: 3.6, height: 2.1, depth: 0.12 },
      scene,
    );
    trimRing.position.set(0, 20, HULL_RADIUS_M - 0.02);
    this.track(trimRing, trim);
  }

  /** Four telescopic landing struts with dish footpads at the diagonal corners. */
  private buildLandingGear(): void {
    const scene = this.scene;
    const p = this.prefix;
    const steel = this.mat('steel');
    const footpadMat = this.mat('footpad');

    // Diagonal corner azimuths (45°, 135°, 225°, 315°).
    for (let i = 0; i < 4; i++) {
      const ang = Math.PI / 4 + i * (Math.PI / 2);
      const x = STRUT_RADIUS_M * Math.cos(ang);
      const z = STRUT_RADIUS_M * Math.sin(ang);

      // Piston cylinder from the hull base down to the footpad.
      const pistonHeight = HULL_CENTER_Y - HULL_HEIGHT_M / 2 - FOOTPAD_Y;
      const pistonY = (HULL_CENTER_Y - HULL_HEIGHT_M / 2 + FOOTPAD_Y) / 2;
      const piston = MeshBuilder.CreateCylinder(
        `${p}-strut-${i}`,
        { diameter: STRUT_PISTON_DIAMETER_M, height: pistonHeight, tessellation: 10 },
        scene,
      );
      piston.position.set(x, pistonY, z);
      this.track(piston, steel);

      // Wide dish footpad.
      const foot = MeshBuilder.CreateCylinder(
        `${p}-footpad-${i}`,
        {
          diameterTop: FOOTPAD_DIAMETER_M * 0.55,
          diameterBottom: FOOTPAD_DIAMETER_M,
          height: 0.3,
          tessellation: 12,
        },
        scene,
      );
      foot.position.set(x, FOOTPAD_Y, z);
      this.track(foot, footpadMat);

      this.gearFootpads.push(foot);
      this.gearPistons.push(piston);
    }
  }

  /** Four retro-thruster bells with emissive throats + dynamic PointLights. */
  private buildEngines(): void {
    const scene = this.scene;
    const p = this.prefix;
    const bellMat = this.mat('bell');
    const throatMat = this.throatMats[0];

    // Cardinal azimuths (0°, 90°, 180°, 270°) — offset from the struts.
    for (let i = 0; i < 4; i++) {
      const ang = i * (Math.PI / 2);
      const x = ENGINE_RADIUS_M * Math.cos(ang);
      const z = ENGINE_RADIUS_M * Math.sin(ang);

      // Gimballed descent bell: narrow throat, flared mouth.
      const bell = MeshBuilder.CreateCylinder(
        `${p}-bell-${i}`,
        {
          diameterTop: ENGINE_BELL_TOP_DIAMETER_M,
          diameterBottom: ENGINE_BELL_BOTTOM_DIAMETER_M,
          height: ENGINE_BELL_HEIGHT_M,
          tessellation: 10,
        },
        scene,
      );
      bell.position.set(x, ENGINE_BELL_Y, z);
      this.track(bell, bellMat);

      // Emissive throat interior at the bell mouth.
      const throat = MeshBuilder.CreateCylinder(
        `${p}-throat-${i}`,
        { diameter: ENGINE_BELL_BOTTOM_DIAMETER_M * 0.72, height: 0.22, tessellation: 10 },
        scene,
      );
      throat.position.set(x, ENGINE_BELL_Y - ENGINE_BELL_HEIGHT_M / 2 + 0.12, z);
      this.track(throat, throatMat);

      // Dynamic retro-thruster PointLight at the bell mouth.
      const light = new PointLight(
        `${p}-thruster-light-${i}`,
        new Vector3(x, ENGINE_BELL_Y - ENGINE_BELL_HEIGHT_M / 2 + 0.4, z),
        scene,
      );
      light.parent = this.rootNode;
      light.intensity = 0; // off until setThrusterIntensity
      light.diffuse = new Color3(1.15, 1.35, 1.6);
      light.range = THRUSTER_LIGHT_RANGE_M;
      this.thrusterLights.push(light);
    }
  }

  /** Stern cargo ramp: ribbed slab + railings + actuators on the stern pivot. */
  private buildCargoRamp(): void {
    const scene = this.scene;
    const p = this.prefix;
    const steel = this.mat('steel');
    const railingMat = this.mat('railing');

    // Ribbed slab: a thin box extending from the pivot toward −z.
    const slab = MeshBuilder.CreateBox(
      `${p}-ramp-slab`,
      { width: RAMP_WIDTH_M, height: 0.2, depth: RAMP_LENGTH_M },
      scene,
    );
    slab.parent = this.rampNode;
    // Centre the slab so it spans z 0 … −RAMP_LENGTH in pivot-local space.
    slab.position.set(0, 0, -RAMP_LENGTH_M / 2);
    slab.material = steel;
    this.meshes.push(slab);

    // Ribbed tread plates: thin cross-boxes across the slab width.
    for (let i = 0; i < 7; i++) {
      const rib = MeshBuilder.CreateBox(
        `${p}-ramp-rib-${i}`,
        { width: RAMP_WIDTH_M, height: 0.22, depth: 0.14 },
        scene,
      );
      rib.parent = this.rampNode;
      rib.position.set(0, 0.02, -((i + 1) * RAMP_LENGTH_M) / 8);
      rib.material = steel;
      this.meshes.push(rib);
    }

    // Safety side railings: two tubes along the slab edges.
    for (const side of [-1, 1]) {
      const railing = MeshBuilder.CreateCylinder(
        `${p}-ramp-railing-${side > 0 ? 'l' : 'r'}`,
        { diameter: 0.14, height: RAMP_LENGTH_M - 0.4, tessellation: 8 },
        scene,
      );
      railing.parent = this.rampNode;
      railing.position.set((RAMP_WIDTH_M / 2 - 0.18) * side, 0.55, -(RAMP_LENGTH_M / 2));
      railing.rotation.x = Math.PI / 2; // lay the cylinder along local z
      railing.material = railingMat;
      this.meshes.push(railing);
    }

    // Hydraulic actuator cylinders flanking the ramp (two).
    for (const side of [-1, 1]) {
      const actuator = MeshBuilder.CreateCylinder(
        `${p}-ramp-actuator-${side > 0 ? 'l' : 'r'}`,
        { diameter: 0.22, height: RAMP_LENGTH_M * 0.62, tessellation: 8 },
        scene,
      );
      actuator.parent = this.rampNode;
      actuator.position.set((RAMP_WIDTH_M / 2 - 0.45) * side, -0.3, -(RAMP_LENGTH_M * 0.55));
      actuator.material = railingMat;
      this.meshes.push(actuator);
    }
  }

  /** Look up a built material by its suffix name. */
  private mat(suffix: string): PBRMaterial {
    const found = this.materials.find((m) => m.name === `${this.prefix}-${suffix}`);
    if (found === undefined) throw new Error(`TransportLander: missing material ${suffix}`);
    return found;
  }

  /** Parent a mesh to the root, assign material, register for teardown. */
  private track(mesh: Mesh, material: PBRMaterial): Mesh {
    mesh.parent = this.rootNode;
    mesh.material = material;
    mesh.isPickable = true;
    mesh.receiveShadows = false;
    this.meshes.push(mesh);
    return mesh;
  }

  private static disposeQuietly(target: { dispose: () => unknown } | null): void {
    if (target === null) return;
    try {
      target.dispose();
    } catch {
      /* Node already gone or scene torn down first — never propagate. */
    }
  }
}

export default TransportLander;
