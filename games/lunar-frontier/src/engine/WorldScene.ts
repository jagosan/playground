/**
 * Lunar Frontier — Babylon.js 3D world engine.
 *
 * Boots an engine + scene and dresses it as the airless, high-contrast lunar
 * surface of the Second Lunar Rush:
 *
 *  - **Stark sunlight** — a `DirectionalLight` with hard PCF shadows
 *    (`ShadowGenerator`) and no atmospheric scattering to soften it.
 *  - **Earthshine** — a whisper of `HemisphericLight` (~0.08 intensity,
 *    earth-blue) standing in for the sunlit Earth's reflected glow.
 *  - **Deep-space sky** — pure black clear colour plus a procedural star dome
 *    (unlit emissive quads on a giant sphere shell; no points cloud needed).
 *  - **Regolith terrain** — a heightmap mesh whose macro relief comes from
 *    `LunarWorldGenerator.elevationAt()` (datum plain, crater bowls, rim
 *    bumps) with deterministic fbm micro-texturing on top, wearing a
 *    low-albedo (0.20, 0.19, 0.18), near-dielectric, Hapke-ish rough PBR
 *    material. The procedural micro-grit normal map is UV-tiled 64× across
 *    the patch (spec 14 §3.2) so texels stay ~12 cm instead of stretching to
 *    8 m and reading as uniform smoothness.
 *  - **Camera rig** — the EVA/vehicle `CameraRig` (first person, third
 *    person, vehicle chase) wired to the scene.
 *
 * Frame convention (shared with `CameraRig`, `TraversalPhysics`,
 * `LunarWorldGenerator`): world metres `(x, y, z↑)` map to Babylon
 * `(x, z↑, -y)`. `getGroundHeightAt(x, y)` answers in the *world* frame.
 *
 * Headless-resilient: `init()` accepts a raw engine (e.g. `NullEngine`), a
 * canvas, or nothing at all (falls back to `NullEngine` when no DOM exists),
 * so CI smoke tests run without a browser.
 *
 * Usage (browser):
 *   const world = new WorldScene({ seed: 'mala-voyage-2431' });
 *   world.init(document.querySelector('canvas')!);
 *   world.runRenderLoop();
 * Usage (headless test):
 *   const world = new WorldScene();
 *   world.init(new NullEngine());
 *   world.render();
 */

import '@babylonjs/core/Shaders/default.vertex.js';
import '@babylonjs/core/Shaders/default.fragment.js';
import '@babylonjs/core/Shaders/pbr.vertex.js';
import '@babylonjs/core/Shaders/pbr.fragment.js';
import '@babylonjs/core/Shaders/shadowMap.vertex.js';
import '@babylonjs/core/Shaders/shadowMap.fragment.js';

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { Scene } from '@babylonjs/core/scene.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';

import { LunarWorldGenerator, type WorldSnapshot } from '../world/LunarWorldGenerator.ts';
import { CameraRig, worldToBabylon, type CameraMode } from './CameraRig.ts';

// ---------------------------------------------------------------------------
// Options & tuning
// ---------------------------------------------------------------------------

export interface WorldSceneOptions {
  /** World seed for `LunarWorldGenerator` (default `mala-voyage-2431`). */
  seed?: string | number;
  /** Terrain patch side length in metres (default 1024). */
  terrainSize?: number;
  /** Terrain grid resolution per side (default 193 → ~5.4 m/vertex). */
  terrainResolution?: number;
  /** Terrain patch origin (world x, y) — generator coords (default 0, 0). */
  terrainOrigin?: { x: number; y: number };
  /**
   * Amplitude of the fbm micro-relief in metres (default 0.22). Spec 16 §2.3
   * tames the old 1.1 m amplitude: at 1.1 m the high-frequency fbm turned open
   * plains into a dense mogul field that shook the buggy continuously.
   */
  microRelief?: number;
  /** Sun shadow map size (default 1024; 0 disables shadows entirely). */
  shadowMapSize?: number;
  /** Sun light intensity (default 3.1 — overexposed against 0.08 fill). */
  sunIntensity?: number;
  /** Earthshine fill intensity (default 0.08). */
  earthshineIntensity?: number;
  /** Star dome radius in metres (default 6000; keep < camera maxZ). */
  starDomeRadius?: number;
  /** Number of stars (default 900). */
  starCount?: number;
  /** Initial camera mode for the rig (default `eva_first_person`). */
  cameraMode?: CameraMode;
  /** Extra metres above ground the camera spawns at (default 1.7). */
  spawnClearance?: number;
  /** Skip console chatter in CI. */
  silent?: boolean;
}

/** Sun azimuth/elevation of the frontier site, radians (low, harsh light). */
const SUN_DIRECTION = { azimuth: -2.4, elevation: 0.42 };

/**
 * Spec 16 §2.3 / ADR-016-3: metres the sun's shadow origin is pulled *back*
 * along −d̂ from the focus target, keeping the tight 120 m ortho box centred
 * on the player (≈ 5.9 cm shadow texels at a 2048 map — razor vacuum shadows
 * instead of the old 4000 m box's ~2 m blur blobs).
 */
const SUN_FOCUS_DISTANCE = 80;

/** Spec 16 §2.3: tight shadow box around the focus target, metres. */
const SUN_SHADOW_FRUSTUM_SIZE = 120;

// ---------------------------------------------------------------------------
// Deterministic value noise (same seed family as the world generator)
// ---------------------------------------------------------------------------

function hash2i(x: number, y: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + seed * 1442260339;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep-interpolated value noise, period-free. */
function valueNoise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2i(xi, yi, seed);
  const b = hash2i(xi + 1, yi, seed);
  const c = hash2i(xi, yi + 1, seed);
  const d = hash2i(xi + 1, yi + 1, seed);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/** Fractal Brownian motion, 4 octaves, normalised to ~[-1, 1]. */
function fbm2(x: number, y: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return (sum / norm) * 2 - 1;
}

// ---------------------------------------------------------------------------
// WorldScene
// ---------------------------------------------------------------------------

export class WorldScene {
  readonly options: Required<
    Pick<
      WorldSceneOptions,
      | 'terrainSize'
      | 'terrainResolution'
      | 'microRelief'
      | 'shadowMapSize'
      | 'sunIntensity'
      | 'earthshineIntensity'
      | 'starDomeRadius'
      | 'starCount'
      | 'spawnClearance'
    >
  > &
    WorldSceneOptions;

  private engine: AbstractEngine | null = null;
  private scene: Scene | null = null;
  private ownsEngine = false;
  private disposed = false;

  private worldGen: LunarWorldGenerator;
  private snapshot: WorldSnapshot | null = null;

  private sun: DirectionalLight | null = null;
  private earthshine: HemisphericLight | null = null;
  private shadowGen: ShadowGenerator | null = null;

  private regolithMaterial: PBRMaterial | null = null;
  private starMaterial: StandardMaterial | null = null;
  private bumpTexture: RawTexture | null = null;

  private terrainRoot: TransformNode | null = null;
  private terrainMesh: Mesh | null = null;
  private starDome: Mesh | null = null;

  /** Heightmap cache [row-major (iy * res + ix)] in world metres. */
  private heightCache: Float32Array | null = null;

  private rig: CameraRig | null = null;
  private entities = new Set<AbstractMesh>();
  private renderLoopStarted = false;

  constructor(options: WorldSceneOptions = {}) {
    this.options = {
      ...options,
      terrainSize: options.terrainSize ?? 1024,
      terrainResolution: Math.max(9, Math.min(1025, options.terrainResolution ?? 193)),
      microRelief: options.microRelief ?? 0.22,
      shadowMapSize: options.shadowMapSize ?? 1024,
      sunIntensity: options.sunIntensity ?? 3.1,
      earthshineIntensity: options.earthshineIntensity ?? 0.08,
      starDomeRadius: options.starDomeRadius ?? 6000,
      starCount: options.starCount ?? 900,
      spawnClearance: options.spawnClearance ?? 1.7,
    };
    this.worldGen = new LunarWorldGenerator(options.seed ?? 'mala-voyage-2431');
  }

  // -- lifecycle ---------------------------------------------------------------

  /**
   * Boot engine + scene + world. Accepts a Babylon engine (e.g. `NullEngine`
   * for headless tests), an `HTMLCanvasElement` (creates a WebGL engine), or
   * nothing — falling back to `NullEngine` when the platform has no DOM.
   */
  init(canvasOrEngine?: AbstractEngine | HTMLCanvasElement | null): this {
    if (this.disposed) throw new Error('WorldScene: init() after dispose()');
    if (this.scene !== null) return this; // idempotent

    const engine = this.resolveEngine(canvasOrEngine);
    this.engine = engine;
    this.scene = new Scene(engine);
    // Airless sky: pure black, no fog, no ambience beyond Earthshine.
    this.scene.clearColor = new Color4(0, 0, 0, 1);
    this.scene.fogMode = Scene.FOGMODE_NONE;
    this.scene.ambientColor = new Color3(0, 0, 0);
    this.scene.ambientTexture = null;

    // Deterministic world data (populates generator indexes for elevationAt).
    this.snapshot = this.worldGen.generate();

    this.buildLighting();
    this.buildStarfield();
    this.buildTerrain();

    this.rig = new CameraRig(this.scene, {
      initialMode: this.options.cameraMode ?? 'eva_first_person',
      groundHeightAt: (x, y) => this.getGroundHeightAt(x, y),
      // Spec 16 §2.3 / ADR-016-3: the shadow box chases whatever the rig is
      // filming (suit on foot, rover in chase mode) every frame.
      onUpdate: (pos) => this.updateShadowFocus(pos),
      ...(this.options.silent !== undefined ? { silent: this.options.silent } : {}),
    });
    const canvas = this.canvasFromInput(canvasOrEngine);
    if (canvas !== null) this.rig.attachControl(canvas);

    this.spawnAtDefault();
    return this;
  }

  /** One frame. Safe before init (no-op). */
  render(): this {
    if (this.scene === null || this.disposed) return this;
    this.scene.render();
    return this;
  }

  /** Start the engine render loop (browser convenience; headless stays manual). */
  runRenderLoop(): this {
    if (this.engine === null || this.disposed || this.renderLoopStarted) return this;
    this.engine.runRenderLoop(() => this.render());
    this.renderLoopStarted = true;
    return this;
  }

  /**
   * Register an entity mesh with the world (parented to the terrain root so
   * the scene graph stays tidy and bulk-hide is cheap). Meshes keep their
   * physics-frame placement: (x, y, z↑) → (x, z↑, -y).
   */
  addEntity(mesh: AbstractMesh): AbstractMesh {
    this.requireScene();
    if (this.disposed) return mesh;
    if (mesh === null || mesh === undefined) {
      throw new Error('WorldScene.addEntity: mesh required');
    }
    if (this.entities.has(mesh)) return mesh;
    this.entities.add(mesh);
    if (this.terrainRoot !== null) mesh.parent = this.terrainRoot;
    if (this.shadowGen !== null) {
      try {
        this.shadowGen.addShadowCaster(mesh);
      } catch {
        /* non-castable mesh (e.g. camera) — ignore */
      }
    }
    return mesh;
  }

  /** Un-register an entity (does not dispose the mesh). */
  removeEntity(mesh: AbstractMesh): boolean {
    if (this.disposed || this.entities.has(mesh) === false) return false;
    this.entities.delete(mesh);
    if (this.shadowGen !== null) {
      try {
        this.shadowGen.removeShadowCaster(mesh);
      } catch {
        /* wasn't a caster */
      }
    }
    mesh.parent = null;
    return true;
  }

  /** Registered entity meshes. */
  getEntities(): AbstractMesh[] {
    return Array.from(this.entities);
  }

  /**
   * Add meshes to the sun's shadow-map render list **without** registering them
   * as world entities (spec 14 §3.3). For static or externally-owned scene
   * furniture — faction base assemblies, rail splines, ore carts — that must
   * cast crisp vacuum shadows but is parented/built elsewhere.
   *
   * Descendants are included (Babylon's `includeDescendants`), so a base root
   * node registers its whole mesh tree. Idempotent (Babylon de-dupes the render
   * list) and a no-op before `init()` or when shadows are disabled
   * (`shadowMapSize: 0`).
   */
  registerShadowCasters(meshes: ReadonlyArray<AbstractMesh>): void {
    if (this.shadowGen === null) return;
    for (const m of meshes) {
      this.shadowGen.addShadowCaster(m, true);
    }
  }

  /**
   * Open-sky ground elevation at world (x, y) in **physics-frame metres**
   * (0 = datum plain, negative inside craters), sampled from the built
   * heightmap with bilinear interpolation. Outside the terrain patch falls
   * back to the analytic generator elevation + micro relief.
   */
  getGroundHeightAt(x: number, y: number): number {
    const origin = this.options.terrainOrigin ?? { x: 0, y: 0 };
    const res = this.options.terrainResolution;
    const size = this.options.terrainSize;
    if (this.heightCache === null) return this.analyticGroundHeight(x, y);

    const gx = (x - origin.x) / size * (res - 1);
    const gy = (y - origin.y) / size * (res - 1);
    if (gx < 0 || gy < 0 || gx > res - 1 || gy > res - 1) {
      return this.analyticGroundHeight(x, y);
    }
    const x0 = Math.min(res - 1, Math.floor(gx));
    const y0 = Math.min(res - 1, Math.floor(gy));
    const x1 = Math.min(res - 1, x0 + 1);
    const y1 = Math.min(res - 1, y0 + 1);
    const fx = gx - x0;
    const fy = gy - y0;
    const h = this.heightCache;
    const top = h[y0 * res + x0] * (1 - fx) + h[y0 * res + x1] * fx;
    const bot = h[y1 * res + x0] * (1 - fx) + h[y1 * res + x1] * fx;
    return top * (1 - fy) + bot * fy;
  }

  /** Tear down everything this object created. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    try {
      this.rig?.dispose();
    } catch {
      /* already gone */
    }
    this.rig = null;

    try {
      this.scene && (this.scene.activeCamera = null);
    } catch {
      /* noop */
    }
    try {
      this.terrainMesh?.dispose();
    } catch {
      /* noop */
    }
    try {
      this.starDome?.dispose();
    } catch {
      /* noop */
    }
    this.terrainMesh = null;
    this.starDome = null;

    for (const mesh of this.entities) mesh.parent = null;
    this.entities.clear();

    try {
      this.shadowGen?.dispose();
    } catch {
      /* noop */
    }
    this.shadowGen = null;
    try {
      this.sun?.dispose();
    } catch {
      /* noop */
    }
    try {
      this.earthshine?.dispose();
    } catch {
      /* noop */
    }
    this.sun = null;
    this.earthshine = null;

    try {
      this.bumpTexture?.dispose();
    } catch {
      /* noop */
    }
    this.bumpTexture = null;
    try {
      this.regolithMaterial?.dispose();
    } catch {
      /* noop */
    }
    try {
      this.starMaterial?.dispose();
    } catch {
      /* noop */
    }
    this.regolithMaterial = null;
    this.starMaterial = null;

    try {
      this.terrainRoot?.dispose();
    } catch {
      /* noop */
    }
    this.terrainRoot = null;
    this.heightCache = null;

    try {
      this.scene?.dispose();
    } catch {
      /* noop */
    }
    this.scene = null;
    if (this.ownsEngine) {
      try {
        this.engine?.dispose();
      } catch {
        /* noop */
      }
    }
    this.engine = null;
  }

  // -- accessors -----------------------------------------------------------------

  getScene(): Scene {
    return this.requireScene();
  }

  getEngine(): AbstractEngine {
    if (this.engine === null) throw new Error('WorldScene: not initialised — call init()');
    return this.engine;
  }

  getCameraRig(): CameraRig {
    if (this.rig === null) throw new Error('WorldScene: not initialised — call init()');
    return this.rig;
  }

  getTerrainMesh(): Mesh | null {
    return this.terrainMesh;
  }

  getSnapshot(): WorldSnapshot | null {
    return this.snapshot;
  }

  getWorldGenerator(): LunarWorldGenerator {
    return this.worldGen;
  }

  /** Default spawn point (flat datum spot) in the physics frame. */
  getSpawnPoint(): { x: number; y: number; z: number } {
    const origin = this.options.terrainOrigin ?? { x: 0, y: 0 };
    const cx = origin.x + this.options.terrainSize / 2;
    const cy = origin.y + this.options.terrainSize / 2;
    return { x: cx, y: cy, z: this.getGroundHeightAt(cx, cy) + this.options.spawnClearance };
  }

  // -- dynamic shadow tracking (spec 16 §2.3 / ADR-016-3) ----------------------

  /**
   * Re-centre the sun's tight 120 m shadow box on a world-frame target (the
   * rover / active camera subject). The light *direction* is untouched — only
   * its position slides, dragging the ortho projection box with it:
   *
   *   p_sun = worldToBabylon(target) − 80 · d̂_sun
   *
   * so the target always sits `SUN_FOCUS_DISTANCE` metres down-range of the
   * light origin, inside the frustum. Idempotent per target and safe before
   * `init()` / after `dispose()` (no-op).
   */
  updateShadowFocus(target: { x: number; y: number; z: number }): void {
    if (this.sun === null || this.disposed) return;
    const dir = this.sun.direction;
    const len = dir.length();
    // A zero-length direction would NaN the light matrix; guard and bail.
    if (len < 1e-9) return;
    const back = dir.scale(-SUN_FOCUS_DISTANCE / len);
    this.sun.position = worldToBabylon(target).add(back);
  }

  // -- build stages ---------------------------------------------------------------

  private resolveEngine(input?: AbstractEngine | HTMLCanvasElement | null): AbstractEngine {
    if (input instanceof AbstractEngine) return input;
    if (this.isCanvasLike(input)) {
      this.ownsEngine = true;
      return new Engine(input as HTMLCanvasElement, {
        antialias: true,
        stencil: true,
        powerPreference: 'high-performance',
      });
    }
    // No DOM at all → headless NullEngine we own and must dispose.
    if (typeof window === 'undefined') {
      this.ownsEngine = true;
      return new NullEngine({ renderWidth: 1600, renderHeight: 900 });
    }
    throw new Error('WorldScene.init: no canvas, engine, or DOM available');
  }

  private isCanvasLike(input: unknown): boolean {
    return (
      typeof input === 'object' &&
      input !== null &&
      (input as HTMLCanvasElement).tagName === 'CANVAS'
    );
  }

  private canvasFromInput(input?: AbstractEngine | HTMLCanvasElement | null): HTMLCanvasElement | null {
    return this.isCanvasLike(input) ? (input as HTMLCanvasElement) : null;
  }

  private buildLighting(): void {
    const scene = this.requireScene();

    // Sun: single hard key light, low on the horizon for long vacuum shadows.
    const sun = new DirectionalLight(
      'sun',
      new Vector3(
        Math.cos(SUN_DIRECTION.elevation) * Math.cos(SUN_DIRECTION.azimuth),
        -Math.sin(SUN_DIRECTION.elevation),
        Math.cos(SUN_DIRECTION.elevation) * Math.sin(SUN_DIRECTION.azimuth),
      ),
      scene,
    );
    sun.intensity = this.options.sunIntensity;
    sun.diffuse = new Color3(1.0, 0.985, 0.95); // unfiltered F0-ish sunlight
    sun.specular = new Color3(1, 1, 1);
    this.sun = sun;

    if (this.options.shadowMapSize > 0) {
      const sg = new ShadowGenerator(this.options.shadowMapSize, sun, undefined);
      sg.usePercentageCloserFiltering = true;
      sg.filteringQuality = ShadowGenerator.QUALITY_HIGH;
      // Spec 16 §2.3 / ADR-016-3: tight 120 m ortho box re-centred on the
      // player by `updateShadowFocus()` (driven from `CameraRig.onUpdate`),
      // with `autoUpdateExtends` off so nothing but our explicit focus moves
      // it. Replaces the static 4000 m box that smeared shadow texels to ~2 m.
      sun.shadowFrustumSize = SUN_SHADOW_FRUSTUM_SIZE;
      sun.autoUpdateExtends = false;
      sg.bias = 0.0006;
      sg.normalBias = 0.02;
      this.shadowGen = sg;
    }

    // Earthshine: the only fill. Faint earth-blue from the "up" hemisphere.
    const hemi = new HemisphericLight('earthshine', new Vector3(0, 1, 0), scene);
    hemi.intensity = this.options.earthshineIntensity;
    hemi.diffuse = new Color3(0.45, 0.6, 0.85); // earth-lit blue cast
    hemi.groundColor = new Color3(0.03, 0.032, 0.04); // barely-there bounce
    this.earthshine = hemi;
  }

  private buildStarfield(): void {
    const scene = this.requireScene();
    const radius = this.options.starDomeRadius;
    const count = this.options.starCount;

    // Deterministic LCG so stars are identical every boot.
    let s = 0x2f6e2b1;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };

    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    const quad = 0.9; // apparent star size (metres at dome radius)

    for (let i = 0; i < count; i++) {
      // Uniform sphere directions, but only keep the sky hemisphere above the
      // local horizon plane (y > -0.05 in Babylon frame keeps everything visible
      // while hiding the under-plane seam).
      const u = rnd() * 2 - 1;
      const theta = rnd() * Math.PI * 2;
      const y = u;
      const rxy = Math.sqrt(Math.max(0, 1 - y * y));
      const cx = rxy * Math.cos(theta) * radius;
      const cz = rxy * Math.sin(theta) * radius;
      const cy = y * radius;

      // Brightness varies; a few bright beacons, most faint.
      const mag = 0.15 + Math.pow(rnd(), 2.2) * 0.85;
      // Slight colour temperature drift (blue-white to warm white).
      const tint = 0.85 + rnd() * 0.15;
      const c = [mag * tint, mag * (0.9 + rnd() * 0.1), mag];

      // Tangent basis for a dome-facing quad.
      const n = new Vector3(cx, cy, cz).normalize();
      const upRef = Math.abs(n.y) > 0.98 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
      const t1 = Vector3.Cross(upRef, n).normalize();
      const t2 = Vector3.Cross(n, t1).normalize();
      const base = positions.length / 3;
      const p = new Vector3(cx, cy, cz);
      for (const [du, dv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const v = p
          .add(t1.scale((du * quad) / 2))
          .add(t2.scale((dv * quad) / 2))
          .subtract(n.scale(quad / 2)); // face the dome centre
        positions.push(v.x, v.y, v.z);
        colors.push(c[0], c[1], c[2]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    const material = new StandardMaterial('starfield_unlit', scene);
    material.disableLighting = true;
    material.emissiveColor = new Color3(1, 1, 1);
    material.diffuseColor = new Color3(0, 0, 0);
    material.specularColor = new Color3(0, 0, 0);
    material.backFaceCulling = true;
    this.starMaterial = material;

    const mesh = new Mesh('starfield', scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.colors = colors;
    vd.applyToMesh(mesh, false);
    mesh.material = material;
    mesh.applyFog = false;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.alwaysSelectAsActiveMesh = true;
    this.starDome = mesh;
  }

  private buildTerrain(): void {
    const scene = this.requireScene();
    const origin = this.options.terrainOrigin ?? { x: 0, y: 0 };
    const size = this.options.terrainSize;
    const res = this.options.terrainResolution;
    const seedHash = seedStringToNumber(this.worldGen.seed);

    const vertexCount = res * res;
    const positions = new Float32Array(vertexCount * 3);
    const heights = new Float32Array(vertexCount);

    for (let iy = 0; iy < res; iy++) {
      for (let ix = 0; ix < res; ix++) {
        const wx = origin.x + (ix / (res - 1)) * size;
        const wy = origin.y + (iy / (res - 1)) * size;
        const macro = this.worldGen.elevationAt(wx, wy);
        const micro = fbm2(wx * 0.09, wy * 0.09, seedHash) * this.options.microRelief;
        // Micro relief fades out inside deep crater shadow zones to keep
        // surveyable floors smooth, and near patch edges to avoid seams.
        const fade = Math.min(1, Math.max(0, 1 + macro / 12)) *
          Math.min(1, Math.min(ix, iy, res - 1 - ix, res - 1 - iy) / 6);
        const z = macro + micro * fade;
        heights[iy * res + ix] = z;
        const b = worldToBabylon({ x: wx, y: wy, z });
        const o = (iy * res + ix) * 3;
        positions[o] = b.x;
        positions[o + 1] = b.y;
        positions[o + 2] = b.z;
      }
    }

    const indices: number[] = [];
    for (let iy = 0; iy < res - 1; iy++) {
      for (let ix = 0; ix < res - 1; ix++) {
        const a = iy * res + ix;
        const b = a + 1;
        const c = a + res;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    // UVs span the patch exactly once (0..1); all tiling lives on the bump
    // texture's own uScale/vScale (spec 14 §3.2 = 64× across `terrainSize`),
    // so the grit density is independent of patch size and stays at
    // 1024 m / 64 tiles / 128 texels ≈ 12.5 cm per normal texel.
    const uvs = new Float32Array(vertexCount * 2);
    for (let iy = 0; iy < res; iy++) {
      for (let ix = 0; ix < res; ix++) {
        const o = (iy * res + ix) * 2;
        uvs[o] = ix / (res - 1);
        uvs[o + 1] = iy / (res - 1);
      }
    }

    const normals = new Array<number>(vertexCount * 3);
    VertexData.ComputeNormals(indices.slice(), positions, normals);

    const mesh = new Mesh('lunar-terrain', scene);
    const vd = new VertexData();
    vd.positions = Array.from(positions);
    vd.indices = indices;
    vd.normals = normals;
    vd.uvs = Array.from(uvs);
    vd.applyToMesh(mesh, false);

    mesh.material = this.buildRegolithMaterial();
    mesh.receiveShadows = this.shadowGen !== null;
    if (this.shadowGen !== null) this.shadowGen.addShadowCaster(mesh);
    mesh.isPickable = true;
    mesh.freezeWorldMatrix();

    this.terrainRoot = new TransformNode('world-root', scene);
    mesh.parent = this.terrainRoot;
    this.terrainMesh = mesh;
    this.heightCache = heights;
  }

  /**
   * Regolith PBR: albedo ~0.12 (fresh mare dust is barely brighter than
   * charcoal), dielectric (metallic 0), very high roughness — Hapke-like
   * backscatter opposition surge is approximated by keeping specular low but
   * present, and letting the procedural normal map do the angular scattering.
   */
  private buildRegolithMaterial(): PBRMaterial {
    const scene = this.requireScene();
    const mat = new PBRMaterial('regolith', scene);
    mat.albedoColor = new Color3(0.20, 0.19, 0.18); // low-albedo grey-tan regolith (spec 14 §3.2)
    // Bare-minimum non-zero lift so pure-vacuum shadowed texels don't crush to
    // 0/NaN — the sun/earthshine contrast does the real work (spec 14 §3.2
    // removes the old flat 0.12 ambient emissive).
    mat.emissiveColor = new Color3(0.015, 0.015, 0.018);
    mat.metallic = 0.0;
    mat.roughness = 0.94;
    mat.environmentIntensity = 0.02; // vacuum: nothing to reflect
    mat.directIntensity = 1.0;

    // Deterministic grit normal map (RG = xy slope, B = z) baked from fbm.
    const texSize = 128;
    const data = new Uint8Array(texSize * texSize * 4);
    const seedHash = seedStringToNumber(this.worldGen.seed) ^ 0x5eed;
    for (let y = 0; y < texSize; y++) {
      for (let x = 0; x < texSize; x++) {
        const s = 0.35;
        const hL = fbm2((x - 1) * s, y * s, seedHash);
        const hR = fbm2((x + 1) * s, y * s, seedHash);
        const hD = fbm2(x * s, (y - 1) * s, seedHash);
        const hU = fbm2(x * s, (y + 1) * s, seedHash);
        let nx = hL - hR;
        let ny = hD - hU;
        const nz = 1.6;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= len;
        ny /= len;
        const o = (y * texSize + x) * 4;
        data[o] = Math.round((nx * 0.5 + 0.5) * 255);
        data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        data[o + 2] = Math.round((nz / len) * 255);
        data[o + 3] = 255;
      }
    }
    const bump = new RawTexture(
      data,
      texSize,
      texSize,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      true,
      false,
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    );
    bump.wrapU = Constants.WRAP_ADDRESSMODE;
    bump.wrapV = Constants.WRAP_ADDRESSMODE;
    // Spec 14 §3.2 — tile the 128² grit map 64× across the patch. With mesh UVs
    // spanning 0..1 this lands one tile on every 1024/64 = 16 m of ground
    // (~12.5 cm per normal texel) instead of stretching the map to 8 m/texel.
    bump.uScale = 64;
    bump.vScale = 64;
    this.bumpTexture = bump;
    mat.bumpTexture = bump;
    bump.level = 2.4; // coarse, airless grit catches the sun harshly
    return mat;
  }

  // -- helpers -----------------------------------------------------------------

  private analyticGroundHeight(x: number, y: number): number {
    const macro = this.worldGen.elevationAt(x, y);
    const seedHash = seedStringToNumber(this.worldGen.seed);
    return macro + fbm2(x * 0.09, y * 0.09, seedHash) * this.options.microRelief;
  }

  private spawnAtDefault(): void {
    if (this.rig === null) return;
    const spawn = this.getSpawnPoint();
    // Spec 16 §2.3: shadow box starts locked on the spawn point (the rig loop
    // below re-fires it via onUpdate every seeded frame; this makes the intent
    // explicit and survives changes to the seeding loop).
    this.updateShadowFocus(spawn);
    // Seed the rig with a few frames so the first render is already settled.
    for (let i = 0; i < 20; i++) {
      this.rig.update(spawn, 0, 1 / 30);
    }
  }

  private requireScene(): Scene {
    if (this.scene === null || this.disposed) {
      throw new Error('WorldScene: not initialised — call init() first');
    }
    return this.scene;
  }
}

function seedStringToNumber(seed: string | number): number {
  if (typeof seed === 'number') return Math.floor(seed) >>> 0;
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  return (h >>> 0) ^ 0x9e3779b9;
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default WorldScene;
