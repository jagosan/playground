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
 *    three-frequency procedural PBR material (Spec 23 §2.1, ADR-023-1):
 *      • macro albedo (512²) — mare basalt lowlands vs highland anorthosite
 *        & crater ejecta rays, tiled 1× across the patch;
 *      • meso detail map (256²) — craterlet depressions & clasts,
 *        `detailMap` at 16× tiling;
 *      • micro-grit normal (256²) — multi-octave facets & craterlet ridges,
 *        UV-tiled 64× (spec 14 §3.2) so texels stay ~6 cm.
 *    All three are pure typed-array `RawTexture`s — NullEngine-safe, no DOM.
 *  - **Active optical visor (Spec 23 §2.3, ADR-023-3)** — the shadow floor is
 *    lifted to a washed-out slate grey (regolith emissive 0.12/0.12/0.14)
 *    under 0.45-intensity earthshine, and a Hapke retroreflective opposition
 *    surge raises `directIntensity`/`specularIntensity` when the camera view
 *    aligns with the sun vector (zero phase angle).
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
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { Scene } from '@babylonjs/core/scene.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Material } from '@babylonjs/core/Materials/material.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
// Babylon v9 side-effect module: registers the thin-instance members
// (thinInstanceSetBuffer / thinInstanceCount / thinInstanceRefreshBoundingInfo)
// on Mesh.prototype. Without it the tree-shaken build leaves them missing.
import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';

import {
  LunarWorldGenerator,
  ROCK_ARCHETYPE_SIZES,
  type WorldSnapshot,
  type ScrapSite,
  type ScrapComponent,
  type Vec3,
  type RockArchetype,
  type RockFieldSnapshot,
} from '../world/LunarWorldGenerator.ts';
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
  /** Sun light intensity (default 2.2 — balanced natural sunlight per Spec 21 §2.2). */
  sunIntensity?: number;
  /** Earthshine fill intensity (default 0.45 — active optical visor fill per Spec 23 §2.3). */
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
 * Spec 23 §2.2 / ADR-023-2: vertical flattening per clast archetype applied
 * to the base polyhedron (and mirrored by the instance placement so the
 * clast straddles the terrain surface). Pebbles stay nearly spherical;
 * boulders settle into wide talus blocks. Exported for harness assertions.
 */
export const ROCK_HEIGHT_FLATTEN: Record<RockArchetype, number> = {
  pebble: 0.72,
  rock: 0.78,
  boulder: 0.85,
};

/**
 * Spec 23 Phase 3: fraction of its own diameter a clast centre is pushed
 * BELOW the local ground line, so every instance visibly straddles the
 * surface — never floats on the heightmap, never sinks out of frame.
 * Exported so headless harnesses can assert elevation clamping exactly.
 */
export const ROCK_SINK_RATIO = 0.3;

/**
 * Spec 16 §2.3 / ADR-016-3: metres the sun's shadow origin is pulled *back*
 * along −d̂ from the focus target, keeping the tight 120 m ortho box centred
 * on the player (≈ 5.9 cm shadow texels at a 2048 map — razor vacuum shadows
 * instead of the old 4000 m box's ~2 m blur blobs).
 */
const SUN_FOCUS_DISTANCE = 80;

/** Spec 16 §2.3: tight shadow box around the focus target, metres. */
const SUN_SHADOW_FRUSTUM_SIZE = 120;

/**
 * Spec 19 §2.2.3 / Architecture §2.3: payload for one 3D mining-laser burst
 * (emissive beam between the drill emitter and the vein centre + an impact
 * spark flare). Coordinates are physics-frame metres; the scene converts
 * them to Babylon internally.
 */
export interface MiningBeamEffect {
  startPos: { x: number; y: number; z: number };
  endPos: { x: number; y: number; z: number };
  durationMs: number;
  colorHex: string;
}

/** Live bookkeeping record for one spawned laser burst. */
interface MiningEffectRecord extends MiningBeamEffect {
  beam: Mesh;
  flare: Mesh;
  beamMaterial: StandardMaterial;
  flareMaterial: StandardMaterial;
  /** Wall-clock ms at which the burst fades out (also drives the pulse). */
  expiresAt: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Default laser-drill beam colour (HUD cyan, spec 19 §2.2.3). */
const MINING_LASER_COLOR_HEX = '#56e0ff';

/** Default drill burst length in ms (spec 19 §2.2.3). */
const MINING_LASER_DEFAULT_MS = 600;

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
// Seamless periodic noise (Spec 23 §2.1 / ADR-023-1)
// ---------------------------------------------------------------------------

/**
 * Value noise on a *wrapping* integer lattice of side `period`. Sampling
 * `q ∈ [0, period)` covers exactly one lattice period, so any texture built
 * from it tiles without seams; octave stacks may double the sample rate
 * (`q·2^k`) and stay seamless because the doubled span is still an integer
 * number of periods.
 */
function pnoisePeriodic(x: number, y: number, seed: number, period: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = (n: number): number => ((n % period) + period) % period;
  const x0 = w(xi);
  const x1 = w(xi + 1);
  const y0 = w(yi);
  const y1 = w(yi + 1);
  const a = hash2i(x0, y0, seed);
  const b = hash2i(x1, y0, seed);
  const c = hash2i(x0, y1, seed);
  const d = hash2i(x1, y1, seed);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/**
 * Seamless multi-octave fBm over a tile whose noise-space side is `lattice`
 * (`q ∈ [0, lattice)`). Octave k samples at `q·2^k` — still an exact whole
 * number of lattice periods — so the tile wraps cleanly on all four edges.
 * Returned range is ~[-1, 1].
 */
function fbmSeamless(
  x: number,
  y: number,
  seed: number,
  lattice: number,
  octaves = 5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const f = 1 << o;
    sum += amp * pnoisePeriodic(x * f, y * f, seed + o * 101, lattice);
    norm += amp;
    amp *= 0.5;
  }
  return (sum / norm) * 2 - 1;
}

/** Gaussian falloff helper: exp(−((v−centre)/width)²). */
function gaussian(v: number, centre: number, width: number): number {
  const t = (v - centre) / width;
  return Math.exp(-t * t);
}

/**
 * Craterlet height contribution at tile-space point (x, y): a shallow bowl
 * (`−(1−(d/r)²)`) ringed by a raised ejecta ridge (Gaussian at d = r). Used
 * by the micro-grit normal and the meso detail map.
 */
function craterletField(
  x: number,
  y: number,
  craters: ReadonlyArray<{ cx: number; cy: number; r: number }>,
): number {
  let h = 0;
  for (const c of craters) {
    const dx = x - c.cx;
    const dy = y - c.cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > c.r * 1.9) continue;
    if (d < c.r) {
      const t = d / c.r;
      h -= 0.55 * (1 - t * t) * (1 - t * t);
    }
    h += 0.85 * gaussian(d, c.r, c.r * 0.32);
  }
  return h;
}

/** Deterministic interior craterlet layout for a `lattice`-sided tile. */
function tileCraterlets(
  seed: number,
  lattice: number,
  count: number,
  rMin: number,
  rMax: number,
): { cx: number; cy: number; r: number }[] {
  let s = (seed ^ 0x9651ee9) >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: { cx: number; cy: number; r: number }[] = [];
  for (let i = 0; i < count; i++) {
    const r = rMin + rnd() * (rMax - rMin);
    // Keep every craterlet (plus its ridge halo) fully inside the tile so
    // the wrap never has to reproduce partial rims.
    const m = r * 1.9 + lattice * 0.02;
    out.push({
      cx: m + rnd() * (lattice - 2 * m),
      cy: m + rnd() * (lattice - 2 * m),
      r,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spec 23 §2.3 / ADR-023-3 — visor & Hapke opposition-surge constants
// ---------------------------------------------------------------------------

/**
 * Washed-out slate-grey emissive floor of the regolith under the active
 * optical visor (Spec 23 §2.3): shadows never crush to black.
 */
export const VISOR_EMISSIVE_FLOOR = { r: 0.12, g: 0.12, b: 0.14 } as const;

/** Earthshine ground-bounce tint under visor compensation (Spec 23 §2.3). */
export const VISOR_GROUNDBOUNCE_COLOR = { r: 0.14, g: 0.14, b: 0.16 } as const;

/**
 * Hapke retroreflective opposition-surge model (Spec 23 §2.1.4). At zero
 * phase angle (camera looking straight along the sun vector) the regolith's
 * self-shadow-hiding backscatter brightens the surface; approximated as a
 * `dot^exponent` lobe lifting `directIntensity` from `baseDirect` up to
 * `baseDirect + directGain` and `specularIntensity` from `baseSpecular` up
 * to `baseSpecular + specularGain`.
 */
export const OPPOSITION_SURGE = {
  baseDirect: 1.0,
  directGain: 0.35,
  baseSpecular: 0.25,
  specularGain: 0.45,
  exponent: 6,
} as const;

/**
 * Pure opposition-surge response for a dot product between the camera
 * forward vector and the (normalised) sun direction. `dot = 1` is zero
 * phase angle (backlit, surge peak); `dot ≤ 0` means the sun is behind the
 * camera (no surge). Returns the normalised surge amount in [0, 1].
 */
export function hapkeOppositionSurge(dotForwardSun: number): number {
  if (!Number.isFinite(dotForwardSun) || dotForwardSun <= 0) return 0;
  const d = dotForwardSun > 1 ? 1 : dotForwardSun;
  return Math.pow(d, OPPOSITION_SURGE.exponent);
}

// ---------------------------------------------------------------------------
// Spec 23 §2.1 — procedural texture synthesis (pure typed arrays, no DOM)
// ---------------------------------------------------------------------------

/** Micro-grit grit normal map side (Spec 23 §2.1.3: 256², tiled 64×). */
export const MICRO_GRIT_TEX_SIZE = 256;

/** Meso craterlet/clast detail map side (Spec 23 §2.1.2: 256², tiled 16×). */
export const MESO_DETAIL_TEX_SIZE = 256;

/** Macro mare/highland albedo map side (Spec 23 §2.1.1 / ADR-023-1: 512², 1×). */
export const MACRO_ALBEDO_TEX_SIZE = 512;

/** Mare basalt lowland linear albedo (Spec 23 §2.1.1). */
const MARE_BASALT_ALBEDO = { r: 0.13, g: 0.13, b: 0.14 } as const;

/** Highland anorthosite & ejecta-ray linear albedo (Spec 23 §2.1.1). */
const HIGHLAND_ANORTHITE_ALBEDO = { r: 0.28, g: 0.27, b: 0.26 } as const;

/** Clamp helper for colour bytes. */
function clamp0to1(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * sRGB transfer encode (IEC 61966-2-1). Babylon uploads `gammaSpace` RGBA8
 * textures as `SRGB8_ALPHA8`, so colour textures must carry sRGB-encoded
 * bytes for the *linear* albedos the spec quotes.
 */
function srgbEncode(v: number): number {
  const c = clamp0to1(v);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Macro albedo variegation map (Spec 23 §2.1.1): 512×512 RGBA, sampled once
 * across the terrain patch (u,v ∈ [0,1) ↔ patch world extents). Mare basalt
 * lowlands (0.13, 0.13, 0.14) transition to highland anorthosite
 * (0.28, 0.27, 0.26) under a smooth FBM gate; every `LunarWorldGenerator`
 * crater throws radial, angularly-noisy ejecta rays (brighter streaks
 * decaying with rim distance) that lighten the terrain downrange. Alpha is
 * opaque; bytes are sRGB-encoded. Deterministic in `seed`.
 */
export function buildMacroAlbedoData(
  seed: number,
  craters: ReadonlyArray<{ center: { x: number; y: number }; radius: number }>,
  origin: { x: number; y: number },
  terrainSize: number,
): Uint8Array {
  const size = MACRO_ALBEDO_TEX_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let iy = 0; iy < size; iy++) {
    const wy = origin.y + ((iy + 0.5) / size) * terrainSize;
    for (let ix = 0; ix < size; ix++) {
      const wx = origin.x + ((ix + 0.5) / size) * terrainSize;

      // Mare ↔ highland gate: ~550 m FBM blobs, smoothstepped to avoid hard
      // albedo seams across the plains.
      const mare = fbm2(wx * 0.0018, wy * 0.0018, seed);
      const gate = mare * 0.5 + 0.5;
      let highland = clamp0to1((gate - 0.34) / 0.32) * 0.85;

      // Crater ejecta rays: `ARMS` broad streaks per crater, angularly
      // wobbled by low-frequency noise, brightest just past the rim and
      // fading as 1/sqrt(d) out to 6·R.
      for (const c of craters) {
        const dx = wx - c.center.x;
        const dy = wy - c.center.y;
        const d2 = dx * dx + dy * dy;
        const R = c.radius;
        if (d2 > 36 * R * R || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        if (d < R * 0.55) continue; // rays start beyond the bowl floor
        const ang = Math.atan2(dy, dx);
        const wobble = fbm2(wx * 0.012, wy * 0.012, seed + 913) * 2.2;
        const streak = Math.pow(Math.abs(Math.cos(2.5 * ang + wobble)), 3);
        const near = clamp0to1((d / R - 0.55) / 0.6); // fade in across the rim
        const decay = near / Math.sqrt(d / R);
        highland += streak * decay * 0.42;
      }

      // Fine mottling so the units never read as flat paint.
      highland = clamp0to1(highland + fbm2(wx * 0.02, wy * 0.02, seed + 31) * 0.08);

      const t = highland;
      const o = (iy * size + ix) * 4;
      data[o] = Math.round(
        srgbEncode(MARE_BASALT_ALBEDO.r + (HIGHLAND_ANORTHITE_ALBEDO.r - MARE_BASALT_ALBEDO.r) * t) * 255,
      );
      data[o + 1] = Math.round(
        srgbEncode(MARE_BASALT_ALBEDO.g + (HIGHLAND_ANORTHITE_ALBEDO.g - MARE_BASALT_ALBEDO.g) * t) * 255,
      );
      data[o + 2] = Math.round(
        srgbEncode(MARE_BASALT_ALBEDO.b + (HIGHLAND_ANORTHITE_ALBEDO.b - MARE_BASALT_ALBEDO.b) * t) * 255,
      );
      data[o + 3] = 255;
    }
  }
  return data;
}

/**
 * Micro-grit normal map (Spec 23 §2.1.3): 256×256 RGBA raw normal texels
 * (RG = xy slope, B = z, A opaque) baked from a seamless 5-octave FBM base,
 * interior craterlet depressions with raised ejecta ridges, and sharp
 * angular agglutinate facets. Tiles 64× across the patch (16 m/tile →
 * ~6.25 cm per texel). Deterministic in `seed`; no DOM/WebGL requirements.
 */
export function buildMicroGritNormalData(seed: number): Uint8Array {
  const size = MICRO_GRIT_TEX_SIZE;
  const lattice = 32; // noise-space tile side; wraps seamlessly
  const step = lattice / size;
  const data = new Uint8Array(size * size * 4);
  const lets = tileCraterlets(seed, lattice, 14, lattice * 0.045, lattice * 0.16);

  // Height field first (wrap-safe central differences need neighbours).
  const heights = new Float32Array(size * size);
  for (let iy = 0; iy < size; iy++) {
    const y = (iy + 0.5) * step;
    for (let ix = 0; ix < size; ix++) {
      const x = (ix + 0.5) * step;
      const base = fbmSeamless(x, y, seed, lattice, 5) * 0.55;
      const craters = craterletField(x, y, lets) * 0.35;
      // Sharp facet term: folded high-frequency band yields angular grains
      // and powder micro-ridges (rake/bootprint-edge feel).
      const fold = fbmSeamless(x, y, seed ^ 0xfa2, lattice, 4);
      const facets = (1 - Math.abs(fold)) * 0.34;
      heights[iy * size + ix] = base + craters + facets;
    }
  }

  for (let iy = 0; iy < size; iy++) {
    const ym = ((iy - 1 + size) % size) * size;
    const yp = ((iy + 1) % size) * size;
    for (let ix = 0; ix < size; ix++) {
      const xm = (ix - 1 + size) % size;
      const xp = (ix + 1) % size;
      const row = iy * size;
      // Height-field normal: n = normalize(−∂h/∂x, −∂h/∂y, nz). The
      // exaggerated xy gain (raking vacuum sunlight) is applied downstream
      // via `bump.level`, matching the spec-14 contract.
      const nx = -(heights[row + xp] - heights[row + xm]) * 4.2;
      const ny = -(heights[yp + ix] - heights[ym + ix]) * 4.2;
      const nz = 1.6;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const o = (row + ix) * 4;
      data[o] = Math.round((nx / len) * 0.5 * 255 + 127.5);
      data[o + 1] = Math.round((ny / len) * 0.5 * 255 + 127.5);
      data[o + 2] = Math.round((nz / len) * 255);
      data[o + 3] = 255;
    }
  }
  return data;
}

/**
 * Meso detail map (Spec 23 §2.1.2): 256×256 RGBA packed for Babylon's PBR
 * detail shader — `R` albedo detail (0.5 = neutral, clast mounds brighter),
 * `G`/`A` normal xy (the shader reads `.wy`), `B` roughness (0.5 = keep
 * base; craterlet dust rougher, glassy clast mounds smoother). Contains
 * 0.5–3 m craterlet depressions, clast mounds and crumbly ejecta blankets;
 * tiles 16× across the patch. Deterministic in `seed`; NullEngine-safe.
 */
export function buildMesoDetailData(seed: number): Uint8Array {
  const size = MESO_DETAIL_TEX_SIZE;
  const lattice = 16; // 64 m tile / 4 m per lattice unit
  const step = lattice / size;
  const data = new Uint8Array(size * size * 4);
  const lets = tileCraterlets(seed, lattice, 10, 0.12, 0.75); // 0.5–3 m craters

  const heights = new Float32Array(size * size);
  const clast = new Float32Array(size * size);
  for (let iy = 0; iy < size; iy++) {
    const y = (iy + 0.5) * step;
    for (let ix = 0; ix < size; ix++) {
      const x = (ix + 0.5) * step;
      const i = iy * size + ix;
      heights[i] = craterletField(x, y, lets) + fbmSeamless(x, y, seed + 7, lattice, 4) * 0.22;
      // Clast mounds: thresholded mid-frequency noise → crumbly boulder
      // clusters & ejecta blankets (sharp edges, then softly feathered).
      const n = fbmSeamless(x, y, seed ^ 0xc1a57, lattice, 4) * 0.5 + 0.5;
      clast[i] = clamp0to1((n - 0.56) / 0.22);
    }
  }

  for (let iy = 0; iy < size; iy++) {
    const ym = ((iy - 1 + size) % size) * size;
    const yp = ((iy + 1) % size) * size;
    for (let ix = 0; ix < size; ix++) {
      const xm = (ix - 1 + size) % size;
      const xp = (ix + 1) % size;
      const i = iy * size + ix;
      // h + clast mounds lift the surface: steeper slopes on the mounds.
      const h = (v: number) => v + clast[i] * 0.2;
      const nx = -(h(heights[iy * size + xp]) - h(heights[iy * size + xm])) * 2.6;
      const ny = -(h(heights[yp + ix]) - h(heights[ym + ix])) * 2.6;
      const nz = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      // Channel packing per openpbr detail blend (see material.detailMap
      // shader: detailNormalRG = detailColor.wy, roughness from .b, albedo
      // from .r — 0.5 is the neutral value in every non-normal channel).
      // Roughness stays neutral except where it matters: glassy clast
      // mounds smooth (specular glitter under raking sun), craterlet-floor
      // dust (negative heights) rougher.
      const albedo = clamp0to1(0.5 + clast[i] * 0.22 + heights[i] * 0.06);
      const dustRough = Math.min(0, heights[i]) * -0.5;
      const roughness = clamp0to1(0.5 - clast[i] * 0.3 + dustRough);
      data[i * 4] = Math.round(albedo * 255);
      data[i * 4 + 1] = Math.round((nx / len) * 0.5 * 255 + 127.5);
      data[i * 4 + 2] = Math.round(roughness * 255);
      data[i * 4 + 3] = Math.round((ny / len) * 0.5 * 255 + 127.5);
    }
  }
  return data;
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
  /** Spec 23 §2.1.1 — 512² mare/highland macro albedo (1× across the patch). */
  private albedoTexture: RawTexture | null = null;
  /** Spec 23 §2.1.2 — 256² meso craterlet/clast detail map (16× tiling). */
  private mesoDetailTexture: RawTexture | null = null;

  private terrainRoot: TransformNode | null = null;
  private terrainMesh: Mesh | null = null;
  private starDome: Mesh | null = null;

  /** Heightmap cache [row-major (iy * res + ix)] in world metres. */
  private heightCache: Float32Array | null = null;

  private rig: CameraRig | null = null;
  /** Scratch vector for the opposition-surge dot product (no per-frame alloc). */
  private readonly scratchSurge = new Vector3(0, 0, 0);
  private entities = new Set<AbstractMesh>();
  private renderLoopStarted = false;
  /**
   * Spec 19 §2.2.3: live mining-laser bursts (beam + impact flare). Each
   * self-destructs on its own wall-clock timer and fades via `render()`.
   */
  private miningEffects: MiningEffectRecord[] = [];
  /** Procedural scrap sites (Spec 21 §2.1). */
  private scrapRoots = new Map<string, { root: TransformNode; beacon?: Mesh; meshes: Mesh[] }>();

  // -- Spec 23 §2.2 / ADR-023-2: thin-instance clast fields ------------------
  /** Root container for all three rock archetype meshes (one TransformNode). */
  private rockFieldRoot: TransformNode | null = null;
  /**
   * One Mesh per archetype (pebble / rock / boulder). Each carries all its
   * instances via `thinInstanceSetBuffer("matrix", …)` → 3 draw calls total.
   */
  private rockMeshes: Partial<Record<RockArchetype, Mesh>> = {};
  /** Raw float matrix buffers (kept alive so NullEngine never GC's them). */
  private rockMatrixBuffers: Partial<Record<RockArchetype, Float32Array>> = {};
  /** Shared faceted-clast PBR material for all three archetype meshes. */
  private rockMaterial: PBRMaterial | null = null;
  /** Generator snapshot used to build the current clast field (harness readback). */
  private rockFieldSnapshot: RockFieldSnapshot | null = null;
  /** Total thin instances spawned across all archetypes (harness readback). */
  private rockTotalInstances = 0;

  constructor(options: WorldSceneOptions = {}) {
    this.options = {
      ...options,
      terrainSize: options.terrainSize ?? 1024,
      terrainResolution: Math.max(9, Math.min(1025, options.terrainResolution ?? 193)),
      microRelief: options.microRelief ?? 0.22,
      shadowMapSize: options.shadowMapSize ?? 1024,
      sunIntensity: options.sunIntensity ?? 2.2,
      earthshineIntensity: options.earthshineIntensity ?? 0.45,
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
    this.buildRockFields();
    this.buildScrapSites();

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
    this.updateMiningEffects();
    // Spec 23 §2.1.4: re-evaluate the Hapke opposition surge against the
    // current camera view before every frame is submitted.
    this.updateOppositionSurge();
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

    this.disposeMiningEffects();

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

    // Spec 23 §2.2: clast meshes, shared material, root node & CPU matrices.
    this.disposeRockFields();

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
      this.albedoTexture?.dispose();
    } catch {
      /* noop */
    }
    this.albedoTexture = null;
    try {
      this.mesoDetailTexture?.dispose();
    } catch {
      /* noop */
    }
    this.mesoDetailTexture = null;
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

  // -- surface detritus & salvage (Spec 21 §2.1) -------------------------------

  /** Get all scrap sites from the world snapshot. */
  getScrapSites(): ScrapSite[] {
    return this.snapshot?.scrapSites ?? [];
  }

  /** Harvest a scrap site by id, updating visual appearance and returning components. */
  salvageScrapSite(siteId: string): ScrapComponent[] | null {
    const res = this.worldGen.salvageScrapSite(siteId);
    if (res !== null) {
      this.markScrapHarvested(siteId);
      const site = this.snapshot?.scrapSites.find((s) => s.id === siteId);
      if (site) {
        site.harvested = true;
        this.spawnSalvageSparks(site.position);
      }
    }
    return res;
  }

  /** Visually mark a scrap site as harvested (shrink frame and disable beacon). */
  markScrapHarvested(siteId: string): void {
    const entry = this.scrapRoots.get(siteId);
    if (!entry) return;
    if (entry.beacon) {
      entry.beacon.setEnabled(false);
    }
    entry.root.scaling.set(0.7, 0.35, 0.7);
  }

  /** Spawn procedural spark/dust effect at salvage position (headless safe). */
  spawnSalvageSparks(pos: Vec3): void {
    if (this.disposed || this.scene === null) return;
    const bPos = worldToBabylon(pos);
    const scene = this.scene;
    const sparkRoot = new TransformNode(`sparks-${Date.now()}`, scene);
    sparkRoot.position.copyFrom(bPos);
    sparkRoot.position.y += 0.8;

    const sparkMat = new StandardMaterial(`spark-mat-${Date.now()}`, scene);
    sparkMat.emissiveColor = new Color3(1.0, 0.9, 0.4);
    sparkMat.disableLighting = true;

    const sparks: Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const sp = MeshBuilder.CreateSphere(`sp-${i}`, { diameter: 0.12 }, scene);
      sp.material = sparkMat;
      sp.parent = sparkRoot;
      const ang = (i / 6) * Math.PI * 2;
      sp.position.set(Math.cos(ang) * 0.4, (i % 2) * 0.3, Math.sin(ang) * 0.4);
      sparks.push(sp);
    }

    setTimeout(() => {
      try {
        for (const sp of sparks) sp.dispose();
        sparkMat.dispose();
        sparkRoot.dispose();
      } catch {
        // safe ignore
      }
    }, 500);
  }

  /** Procedural composite scrap geometry (Spec 21 §2.1 / ADR-021-1). */
  private buildScrapSites(): void {
    const scene = this.requireScene();
    const sites = this.snapshot?.scrapSites ?? [];

    for (const site of sites) {
      const root = new TransformNode(`scrap-root-${site.id}`, scene);
      const bPos = worldToBabylon(site.position);
      root.position.copyFrom(bPos);
      const meshes: Mesh[] = [];
      let beacon: Mesh | undefined;

      switch (site.archetype) {
        case 'lander_wreck': {
          const foilMat = new PBRMaterial(`foil-${site.id}`, scene);
          foilMat.albedoColor = new Color3(0.92, 0.78, 0.25);
          foilMat.metallic = 0.85;
          foilMat.roughness = 0.25;

          const frame = MeshBuilder.CreateCylinder(
            `lander-frame-${site.id}`,
            { diameter: 3.2, height: 1.0, tessellation: 8 },
            scene,
          );
          frame.material = foilMat;
          frame.parent = root;
          frame.position.y = 0.5;
          meshes.push(frame);

          const tankMat = new PBRMaterial(`tank-${site.id}`, scene);
          tankMat.albedoColor = new Color3(0.8, 0.82, 0.85);
          tankMat.metallic = 0.9;
          tankMat.roughness = 0.2;

          const tank1 = MeshBuilder.CreateSphere(`tank1-${site.id}`, { diameter: 1.1 }, scene);
          tank1.material = tankMat;
          tank1.parent = root;
          tank1.position.set(0.9, 0.9, 0);
          meshes.push(tank1);

          const tank2 = MeshBuilder.CreateSphere(`tank2-${site.id}`, { diameter: 0.9 }, scene);
          tank2.material = tankMat;
          tank2.parent = root;
          tank2.position.set(-0.8, 0.8, 0.4);
          meshes.push(tank2);

          const strut = MeshBuilder.CreateCylinder(`strut-${site.id}`, { diameter: 0.15, height: 2.2 }, scene);
          strut.parent = root;
          strut.position.set(1.4, 0.4, 1.2);
          strut.rotation.z = 0.7;
          strut.material = foilMat;
          meshes.push(strut);

          const beaconMat = new StandardMaterial(`beacon-mat-${site.id}`, scene);
          beaconMat.emissiveColor = new Color3(1.0, 0.6, 0.1);
          beaconMat.disableLighting = true;
          beacon = MeshBuilder.CreateSphere(`beacon-${site.id}`, { diameter: 0.3 }, scene);
          beacon.material = beaconMat;
          beacon.parent = root;
          beacon.position.set(0, 1.3, 0);
          meshes.push(beacon);
          break;
        }
        case 'mining_rig': {
          const rustMat = new PBRMaterial(`rust-${site.id}`, scene);
          rustMat.albedoColor = new Color3(0.72, 0.35, 0.15);
          rustMat.metallic = 0.1;
          rustMat.roughness = 0.9;

          const derrickL = MeshBuilder.CreateBox(
            `derrick-l-${site.id}`,
            { width: 0.3, height: 3.5, depth: 0.3 },
            scene,
          );
          derrickL.material = rustMat;
          derrickL.parent = root;
          derrickL.position.set(-0.9, 1.7, 0);
          derrickL.rotation.z = -0.22;
          meshes.push(derrickL);

          const derrickR = MeshBuilder.CreateBox(
            `derrick-r-${site.id}`,
            { width: 0.3, height: 3.5, depth: 0.3 },
            scene,
          );
          derrickR.material = rustMat;
          derrickR.parent = root;
          derrickR.position.set(0.9, 1.7, 0);
          derrickR.rotation.z = 0.22;
          meshes.push(derrickR);

          const motor = MeshBuilder.CreateCylinder(`motor-${site.id}`, { diameter: 0.9, height: 1.4 }, scene);
          motor.material = rustMat;
          motor.parent = root;
          motor.position.set(0, 1.8, 0);
          meshes.push(motor);

          const hopper = MeshBuilder.CreateBox(`hopper-${site.id}`, { width: 1.8, height: 0.8, depth: 1.4 }, scene);
          hopper.material = rustMat;
          hopper.parent = root;
          hopper.position.set(0, 0.4, 0);
          meshes.push(hopper);

          const beaconMat = new StandardMaterial(`beacon-mat-${site.id}`, scene);
          beaconMat.emissiveColor = new Color3(1.0, 0.7, 0.2);
          beaconMat.disableLighting = true;
          beacon = MeshBuilder.CreateSphere(`beacon-${site.id}`, { diameter: 0.35 }, scene);
          beacon.material = beaconMat;
          beacon.parent = root;
          beacon.position.set(0, 3.4, 0);
          meshes.push(beacon);
          break;
        }
        case 'junk_pile': {
          const junkMat = new PBRMaterial(`junk-${site.id}`, scene);
          junkMat.albedoColor = new Color3(0.5, 0.52, 0.55);
          junkMat.metallic = 0.75;
          junkMat.roughness = 0.45;

          const girder = MeshBuilder.CreateBox(`girder-${site.id}`, { width: 0.4, height: 2.8, depth: 0.4 }, scene);
          girder.material = junkMat;
          girder.parent = root;
          girder.position.set(0.3, 0.5, 0);
          girder.rotation.set(0.3, 0.5, 0.9);
          meshes.push(girder);

          const cyl = MeshBuilder.CreateCylinder(`cyl-${site.id}`, { diameter: 0.7, height: 1.5 }, scene);
          cyl.material = junkMat;
          cyl.parent = root;
          cyl.position.set(-0.5, 0.4, 0.3);
          cyl.rotation.z = 1.2;
          meshes.push(cyl);

          const box = MeshBuilder.CreateBox(`box-${site.id}`, { width: 0.9, height: 0.6, depth: 0.9 }, scene);
          box.material = junkMat;
          box.parent = root;
          box.position.set(0.2, 0.3, -0.4);
          meshes.push(box);

          const beaconMat = new StandardMaterial(`beacon-mat-${site.id}`, scene);
          beaconMat.emissiveColor = new Color3(0.8, 0.4, 1.0);
          beaconMat.disableLighting = true;
          beacon = MeshBuilder.CreateSphere(`beacon-${site.id}`, { diameter: 0.25 }, scene);
          beacon.material = beaconMat;
          beacon.parent = root;
          beacon.position.set(0, 1.1, 0);
          meshes.push(beacon);
          break;
        }
      }

      this.scrapRoots.set(site.id, { root, beacon, meshes });
      for (const m of meshes) {
        this.addEntity(m);
      }
    }
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

  // -- mining laser VFX (spec 19 §2.2.3) ------------------------------------------

  /**
   * Fire one emissive mining-laser burst between two world-frame points
   * (drill emitter → vein centre): a pulsing beam cylinder plus a spark/dust
   * flare sphere at the impact end. Both meshes are unlit emissive, never
   * shadow casters, and self-destruct after `durationMs` (wall-clock — the
   * burst is a cosmetic effect, not a simulation object). Headless-safe:
   * builds fine on a `NullEngine`, and a silent no-op before `init()` or
   * after `dispose()` so callers never need to guard.
   */
  spawnMiningLaser(
    startPos: { x: number; y: number; z: number },
    endPos: { x: number; y: number; z: number },
    durationMs: number = MINING_LASER_DEFAULT_MS,
    colorHex: string = MINING_LASER_COLOR_HEX,
  ): MiningBeamEffect | null {
    if (this.disposed || this.scene === null) return null;
    const scene = this.scene;

    const start = worldToBabylon(startPos);
    const end = worldToBabylon(endPos);
    const delta = end.subtract(start);
    const length = delta.length();
    // Degenerate burst (emitter on top of the target): skip the beam, keep
    // the flare so the drill still visibly "hit".
    const beamLength = Math.max(0.15, length);

    const color = parseHexColor(colorHex);
    const beam = MeshBuilder.CreateCylinder(
      `mining-laser-${this.miningEffects.length + 1}`,
      { diameter: 0.16, height: beamLength, tessellation: 8 },
      scene,
    );
    const beamMaterial = new StandardMaterial(`${beam.name}-mat`, scene);
    beamMaterial.disableLighting = true;
    beamMaterial.emissiveColor = color;
    beamMaterial.diffuseColor = new Color3(0, 0, 0);
    beamMaterial.specularColor = new Color3(0, 0, 0);
    beamMaterial.alpha = 0.9;
    beam.material = beamMaterial;
    beam.isPickable = false;
    beam.receiveShadows = false;
    // Babylon cylinders run along local +Y; rotate that axis onto the beam
    // direction and park the cylinder mid-span.
    const dirN = delta.scale(length > 1e-9 ? 1 / length : 0);
    if (length > 1e-9) {
      const q = new Quaternion();
      Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, dirN, q);
      beam.rotationQuaternion = q;
    }
    beam.position.set(
      (start.x + end.x) / 2,
      (start.y + end.y) / 2,
      (start.z + end.z) / 2,
    );

    const flare = MeshBuilder.CreateSphere(
      `mining-flare-${this.miningEffects.length + 1}`,
      { diameter: 0.9, segments: 8 },
      scene,
    );
    const flareMaterial = new StandardMaterial(`${flare.name}-mat`, scene);
    flareMaterial.disableLighting = true;
    // Spark is a white-hot core of the beam colour.
    flareMaterial.emissiveColor = new Color3(
      Math.min(1, color.r + 0.45),
      Math.min(1, color.g + 0.35),
      Math.min(1, color.b + 0.25),
    );
    flareMaterial.diffuseColor = new Color3(0, 0, 0);
    flareMaterial.specularColor = new Color3(0, 0, 0);
    flareMaterial.alpha = 0.85;
    flare.material = flareMaterial;
    flare.isPickable = false;
    flare.receiveShadows = false;
    flare.position.copyFrom(end);

    const now = miningClockMs();
    const duration = Math.max(80, Math.min(5000, Number.isFinite(durationMs) ? durationMs : MINING_LASER_DEFAULT_MS));
    const record: MiningEffectRecord = {
      startPos: { ...startPos },
      endPos: { ...endPos },
      durationMs: duration,
      colorHex,
      beam,
      flare,
      beamMaterial,
      flareMaterial,
      startedAt: now,
      expiresAt: now + duration,
      timer: null,
    };
    // Belt-and-braces cleanup: `updateMiningEffects()` fades on frames while
    // a render loop runs; this timer guarantees teardown even when nobody
    // renders (headless, tab backgrounded).
    const schedule = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown })
      .setTimeout;
    if (typeof schedule === 'function') {
      const handle = schedule(() => this.retireMiningEffect(record), duration);
      record.timer = (handle as ReturnType<typeof setTimeout>) ?? null;
      const unrefable = record.timer as unknown as { unref?: () => void };
      if (typeof unrefable?.unref === 'function') unrefable.unref();
    }
    this.miningEffects.push(record);
    return {
      startPos: record.startPos,
      endPos: record.endPos,
      durationMs: record.durationMs,
      colorHex: record.colorHex,
    };
  }

  /** Live mining-laser bursts right now (harness readback). */
  getActiveMiningEffectCount(): number {
    return this.miningEffects.length;
  }

  /** Per-frame pulse/fade pass over live bursts; retires expired ones. */
  private updateMiningEffects(): void {
    if (this.miningEffects.length === 0) return;
    const now = miningClockMs();
    for (const record of [...this.miningEffects]) {
      const elapsed = now - record.startedAt;
      const progress = clamp01(elapsed / Math.max(1, record.durationMs));
      // Hard edge: retired expired bursts never linger past their window.
      if (now >= record.expiresAt) {
        this.retireMiningEffect(record);
        continue;
      }
      // Pulse the beam fast (≈8 Hz emissive flicker), then fade the last 30 %.
      const pulse = 0.75 + 0.25 * Math.sin(elapsed * 0.05);
      const fade = progress < 0.7 ? 1 : 1 - (progress - 0.7) / 0.3;
      record.beamMaterial.alpha = 0.9 * pulse * fade;
      // Flare flares UP at impact, then burns off faster than the beam.
      const flareScale = (0.7 + 0.6 * Math.min(1, progress * 3)) * fade;
      record.flare.scaling.setAll(Math.max(0.05, flareScale));
      record.flareMaterial.alpha = 0.85 * fade;
    }
  }

  /** Tear one burst down (idempotent; safe after scene/engine teardown). */
  private retireMiningEffect(record: MiningEffectRecord): void {
    const index = this.miningEffects.indexOf(record);
    if (index >= 0) this.miningEffects.splice(index, 1);
    if (record.timer !== null) {
      try {
        clearTimeout(record.timer);
      } catch {
        /* already fired */
      }
      record.timer = null;
    }
    try {
      record.beam.dispose();
      record.flare.dispose();
      record.beamMaterial.dispose();
      record.flareMaterial.dispose();
    } catch {
      /* scene torn down first — Babylon GC follows the engine */
    }
  }

  /** Retire every live burst (dispose path). */
  private disposeMiningEffects(): void {
    for (const record of [...this.miningEffects]) this.retireMiningEffect(record);
    this.miningEffects = [];
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
    sun.diffuse = new Color3(1.0, 0.98, 0.92); // balanced natural sunlight (Spec 21 §2.2)
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
    // Spec 23 §2.3 (ADR-023-3): the active optical visor lifts the fill to
    // 0.45 with a brighter dust-bounce ground colour so shadowed crater
    // interiors read like an amplified high-gain camera image, never a
    // pitch-black void.
    const hemi = new HemisphericLight('earthshine', new Vector3(0, 1, 0), scene);
    hemi.intensity = this.options.earthshineIntensity;
    hemi.diffuse = new Color3(0.45, 0.6, 0.85); // earth-lit blue cast
    hemi.groundColor = new Color3(
      VISOR_GROUNDBOUNCE_COLOR.r,
      VISOR_GROUNDBOUNCE_COLOR.g,
      VISOR_GROUNDBOUNCE_COLOR.b,
    ); // deep lunar dust bounce, visor-compensated (Spec 23 §2.3)
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

  // -- Spec 23 §2.2 / ADR-023-2: thin-instance pebble & boulder fields --------

  /**
   * Build the surface clast fields (Spec 23 §2.2, ADR-023-2): three low-poly
   * base meshes — pebble / medium rock / boulder clast — each with faceted
   * (flat-shaded) displaced polyhedron geometry, carrying every scatter
   * placement of its archetype as Babylon **thin instances** in one flat
   * `Float32Array` matrix buffer (`thinInstanceSetBuffer("matrix", …, 16)`).
   * Total draw-call cost: ≤ 3 (one per archetype), regardless of instance
   * count.
   *
   * Placement comes from `LunarWorldGenerator.getRockInstances()` (fully
   * deterministic from the world seed: grid-jitter base field + extra
   * clusters in crater-lip/ejecta-blanket annuli). Each instance is elevated
   * onto the terrain via `getGroundHeightAt(x, y)` and sunk by
   * `ROCK_SINK_RATIO` of its own diameter so it straddles the surface —
   * never floats, never buries — with random yaw, slight tilt, and scale
   * variation.
   *
   * Medium rocks and boulders join the sun's shadow-map render list
   * (receiver + caster); pebbles are receiver-only (too small to earn a
   * shadow texel). Under `NullEngine` the matrices live purely in CPU typed
   * arrays — Babylon's buffer calls are no-ops, so CI never touches WebGL.
   */
  private buildRockFields(): void {
    const scene = this.requireScene();
    const origin = this.options.terrainOrigin ?? { x: 0, y: 0 };
    const size = this.options.terrainSize;
    const seedHash = seedStringToNumber(this.worldGen.seed);

    const field = this.worldGen.getRockInstances(origin.x, origin.y, size);
    this.rockFieldSnapshot = field;

    const root = new TransformNode('rock-fields', scene);
    this.rockFieldRoot = root;

    // One shared faceted-rock PBR: dark basalt clast, matte, non-metallic.
    // Faceted normals from the base geometry carry the raking-sun shading,
    // so no bump texture is needed (keeps the material lifecycle trivial).
    const rockMat = new PBRMaterial('rock-clast', scene);
    rockMat.albedoColor = new Color3(0.34, 0.30, 0.27); // darker than lit regolith highlight side
    rockMat.metallic = 0.0;
    rockMat.roughness = 0.9;
    rockMat.environmentIntensity = 0.02; // vacuum: nothing to reflect
    // Shadow faces of clasts get the same washed-out visor floor (ADR-023-3)
    // so boulder silhouettes stay readable in crater darks.
    rockMat.emissiveColor = new Color3(
      VISOR_EMISSIVE_FLOOR.r * 0.6,
      VISOR_EMISSIVE_FLOOR.g * 0.6,
      VISOR_EMISSIVE_FLOOR.b * 0.6,
    );
    this.rockMaterial = rockMat;

    // Base geometries (diameter 1, flattened to lunar clast proportions).
    const pebbleBase = this.buildClastGeometry(scene, 'rock-base-pebble', 2, 0.06, 0.72, seedHash ^ 0x9e11);
    const rockBase = this.buildClastGeometry(scene, 'rock-base-rock', 12, 0.16, 0.78, seedHash ^ 0x51a2);
    const boulderBase = this.buildClastGeometry(scene, 'rock-base-boulder', 13, 0.22, 0.85, seedHash ^ 0xb0a2);

    const scratchMatrix = new Matrix();
    const scratchScale = new Vector3(1, 1, 1);
    const scratchRot = new Quaternion();
    const scratchPos = new Vector3(0, 0, 0);

    const archetypeMeshes: Array<{
      archetype: RockArchetype;
      base: Mesh;
      instances: typeof field.pebbles;
      castsShadow: boolean;
    }> = [
      { archetype: 'pebble', base: pebbleBase, instances: field.pebbles, castsShadow: false },
      { archetype: 'rock', base: rockBase, instances: field.rocks, castsShadow: true },
      { archetype: 'boulder', base: boulderBase, instances: field.boulders, castsShadow: true },
    ];

    let total = 0;
    for (const { archetype, base, instances, castsShadow } of archetypeMeshes) {
      const buffer = new Float32Array(Math.max(1, instances.length) * 16);
      let n = 0;
      for (const inst of instances) {
        // Ground elevation under the clast, in the physics frame; the centre
        // sits at half the flattened clast height, sunk by SINK_RATIO of its
        // diameter so it straddles the surface line.
        const ground = this.getGroundHeightAt(inst.x, inst.y);
        const s = inst.size * inst.scale; // diameter in metres
        const centreZ = ground + s * (ROCK_HEIGHT_FLATTEN[archetype] * 0.5) - s * ROCK_SINK_RATIO;
        const bPos = worldToBabylon({ x: inst.x, y: inst.y, z: centreZ });
        scratchScale.setAll(s);
        // Random yaw + a slight settle tilt so clasts don't stand at attention.
        const tiltSeed = hash2i(Math.round(inst.x * 8), Math.round(inst.y * 8), seedHash);
        Quaternion.FromEulerAnglesToRef(
          (tiltSeed - 0.5) * 0.22,
          inst.yaw,
          (hash2i(Math.round(inst.y * 8), Math.round(inst.x * 8), seedHash) - 0.5) * 0.22,
          scratchRot,
        );
        scratchPos.copyFrom(bPos);
        Matrix.ComposeToRef(scratchScale, scratchRot, scratchPos, scratchMatrix);
        scratchMatrix.copyToArray(buffer, n * 16);
        n++;
      }
      total += n;

      base.material = rockMat;
      base.isPickable = false;
      base.receiveShadows = this.shadowGen !== null;
      base.parent = root;
      // One flat matrix buffer → one draw call for the whole archetype.
      base.thinInstanceSetBuffer('matrix', buffer, 16, true);
      // Bounding boxes must enclose the instances for frustum culling;
      // `alwaysSelectAsActiveMesh` additionally sidesteps NullEngine culling
      // edge cases so CI renders always include the fields.
      base.thinInstanceRefreshBoundingInfo(true);
      base.alwaysSelectAsActiveMesh = true;
      if (castsShadow && this.shadowGen !== null) {
        this.shadowGen.addShadowCaster(base);
      }
      this.rockMeshes[archetype] = base;
      this.rockMatrixBuffers[archetype] = buffer;
    }
    this.rockTotalInstances = total;
  }

  /**
   * Low-poly faceted clast geometry (Spec 23 Phase 3): a `CreatePolyhedron`
   * shell (unit diameter) whose vertices are displaced radially by a
   * hash-noise fracture field, flattened on the vertical axis to lunar
   * talus proportions, then re-cut with flat per-facet normals so each face
   * catches the raking sun as a distinct plane. Deterministic in `seedHash`
   * (polyhedron vertex order is stable); NullEngine-safe (CPU vertex data).
   */
  private buildClastGeometry(
    scene: Scene,
    name: string,
    polyType: number,
    fractureAmp: number,
    heightFlatten: number,
    seedHash: number,
  ): Mesh {
    const mesh = MeshBuilder.CreatePolyhedron(name, { type: polyType, size: 0.5 }, scene);
    const positions = mesh.getVerticesData('position');
    if (positions !== undefined && positions !== null) {
      for (let i = 0; i < positions.length; i += 3) {
        const vx = positions[i];
        const vy = positions[i + 1];
        const vz = positions[i + 2];
        // Radial fracture displacement keyed to the vertex direction, so the
        // two duplicated verts of a shared corner move identically (no tears).
        const n = hash2i(
          Math.round(vx * 37) + 64,
          Math.round(vy * 37) + Math.round(vz * 53) * 7 + 64,
          seedHash,
        );
        const f = 1 + (n - 0.5) * 2 * fractureAmp;
        positions[i] = vx * f;
        positions[i + 1] = vy * f;
        positions[i + 2] = vz * f;
      }
      // Flatten to a settled-clast profile (wider than tall, like Apollo talus).
      for (let i = 0; i < positions.length; i += 3) {
        positions[i + 1] *= heightFlatten;
      }
      mesh.updateVerticesData('position', positions);
    }
    // Faceted normals: duplicate verts per face with per-face normals.
    mesh.convertToFlatShadedMesh();
    mesh.refreshBoundingInfo();
    return mesh;
  }

  /** The three clast archetype meshes built by `buildRockFields()`. */
  getRockFieldMeshes(): Mesh[] {
    return Object.values(this.rockMeshes).filter((m): m is Mesh => m !== undefined);
  }

  /**
   * Thin-instance clast field summary (harness readback, Spec 23 §5 gate 5):
   * per-archetype instance counts, total count, and base geometry vertex
   * counts. Zeros before `init()` / after `dispose()`.
   */
  getRockFieldInfo(): {
    pebbles: number;
    rocks: number;
    boulders: number;
    total: number;
    meshCount: number;
    thinInstanceMatrixStride: number;
  } {
    const countOf = (a: RockArchetype): number => {
      const mesh = this.rockMeshes[a];
      return mesh !== undefined ? (mesh.thinInstanceCount ?? 0) : 0;
    };
    return {
      pebbles: countOf('pebble'),
      rocks: countOf('rock'),
      boulders: countOf('boulder'),
      total: this.rockTotalInstances,
      meshCount: this.getRockFieldMeshes().length,
      thinInstanceMatrixStride: 16,
    };
  }

  /**
   * The live CPU-side thin-instance matrix buffer for one archetype (16
   * floats, column-major, per instance; translation at offsets 12–14).
   * Exposed for headless verification — under NullEngine this typed array
   * *is* the instance storage. Null before init / after dispose.
   */
  getRockMatrixBuffer(archetype: RockArchetype): Float32Array | null {
    if (this.disposed) return null;
    return this.rockMatrixBuffers[archetype] ?? null;
  }

  /** The generator clast snapshot backing the current fields (harness readback). */
  getRockFieldSnapshot(): RockFieldSnapshot | null {
    return this.rockFieldSnapshot;
  }

  /** Tear down clast meshes, materials, root node, and matrix buffers. */
  private disposeRockFields(): void {
    for (const key of Object.keys(this.rockMeshes) as RockArchetype[]) {
      const mesh = this.rockMeshes[key];
      if (mesh !== undefined) {
        try {
          mesh.dispose();
        } catch {
          /* scene torn down first */
        }
      }
      delete this.rockMeshes[key];
      delete this.rockMatrixBuffers[key];
    }
    try {
      this.rockMaterial?.dispose();
    } catch {
      /* noop */
    }
    this.rockMaterial = null;
    try {
      this.rockFieldRoot?.dispose();
    } catch {
      /* noop */
    }
    this.rockFieldRoot = null;
    this.rockFieldSnapshot = null;
    this.rockTotalInstances = 0;
  }

  /**
   * Regolith PBR — Spec 23 §2.1 three-frequency procedural stack (ADR-023-1):
   *
   *  1. **Macro albedo (512², 1× across the patch)** — mare basalt lowlands
   *     (0.13, 0.13, 0.14) blending into highland anorthosite & crater ejecta
   *     rays (0.28, 0.27, 0.26), keyed to `LunarWorldGenerator` crater
   *     coordinates with radial streak noise. `albedoColor` stays a white
   *     multiplier so the texture carries the physical albedo.
   *  2. **Meso detail map (256², 16× tiling)** — craterlet depressions,
   *     clast mounds and roughness variation through
   *     `PBRMaterial.detailMap` (RNM normal blend).
   *  3. **Micro-grit normal (256², 64× tiling)** — seamless five-octave
   *     multi-scale fbm with craterlet ridges and sharp angular facets;
   *     1024 m / 64 tiles / 256 texels ≈ 6.25 cm per normal texel.
   *
   * Hapke-like backscatter is approximated by keeping base specular low but
   * present (`specularIntensity` 0.25) and lifting it — together with
   * `directIntensity` — toward the sun via `updateOppositionSurge()` at zero
   * phase angle (Spec 23 §2.1.4). The shadow floor sits at the washed-out
   * visor emissive (0.12, 0.12, 0.14) so night faces never crush to black
   * (Spec 23 §2.3 / ADR-023-3).
   */
  private buildRegolithMaterial(): PBRMaterial {
    const scene = this.requireScene();
    const mat = new PBRMaterial('regolith', scene);
    // Physical albedo lives in `albedoTexture` (1× across the patch); the
    // constant is a neutral multiplier — Spec 23 §2.1.1 supersedes the old
    // flat (0.20, 0.19, 0.18) tint criticised in Spec 23 §1.
    mat.albedoColor = new Color3(1, 1, 1);
    mat.metallic = 0.0;
    mat.roughness = 0.94;
    mat.environmentIntensity = 0.02; // vacuum: nothing to reflect

    // --- Spec 23 §2.3 / ADR-023-3: active optical visor shadow lift -------
    // Washed-out slate grey floor instead of the old (0.035, 0.035, 0.038):
    // deep crater basins read like a high-gain camera image, not a void.
    mat.emissiveColor = new Color3(
      VISOR_EMISSIVE_FLOOR.r,
      VISOR_EMISSIVE_FLOOR.g,
      VISOR_EMISSIVE_FLOOR.b,
    );

    // --- Spec 23 §2.1.4: Hapke opposition surge base state ----------------
    // Calibrated so zero-phase viewing peaks directIntensity at 1.35 and
    // specularIntensity at 0.70: velvety ridge fringes without washing out
    // the sunlit-to-shadow transition.
    mat.directIntensity = OPPOSITION_SURGE.baseDirect;
    mat.specularIntensity = OPPOSITION_SURGE.baseSpecular;

    const seedHash = seedStringToNumber(this.worldGen.seed);

    // --- Frequency 1: macro albedo variegation (512², mare vs highland) --
    const albedo = new RawTexture(
      buildMacroAlbedoData(seedHash, this.snapshot?.craters ?? [], this.options.terrainOrigin ?? { x: 0, y: 0 }, this.options.terrainSize),
      MACRO_ALBEDO_TEX_SIZE,
      MACRO_ALBEDO_TEX_SIZE,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      true,
      false,
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    );
    albedo.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE; // 1× across the patch — no wrap
    albedo.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    // Bytes are sRGB-encoded linear albedos → Babylon's default gammaSpace
    // colour path (same convention as a PNG albedo map).
    albedo.uScale = 1;
    albedo.vScale = 1;
    this.albedoTexture = albedo;
    mat.albedoTexture = albedo;

    // --- Frequency 2: meso craterlet/clast detail map (256², 16×) ---------
    const meso = new RawTexture(
      buildMesoDetailData(seedHash ^ 0x0de7),
      MESO_DETAIL_TEX_SIZE,
      MESO_DETAIL_TEX_SIZE,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      true,
      false,
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    );
    meso.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
    meso.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    // Spec 23 §2.1.2: 16× across the patch UVs (0..1) → one detail tile per
    // 64 m of ground; craterlet & clast features land at ~0.25–3 m.
    meso.uScale = 16;
    meso.vScale = 16;
    // Data map (normals + packed masks) — linear upload, no sRGB decode on
    // the normal channels in the browser.
    meso.gammaSpace = false;
    this.mesoDetailTexture = meso;
    mat.detailMap.texture = meso;
    mat.detailMap.isEnabled = true;
    mat.detailMap.normalBlendMethod = Material.MATERIAL_NORMALBLENDMETHOD_RNM;
    mat.detailMap.diffuseBlendLevel = 0.55; // clast mounds visibly mottle the albedo
    mat.detailMap.roughnessBlendLevel = 0.35; // dust-vs-clast roughness variation
    mat.detailMap.bumpLevel = 1.6; // crisp raking-light micro-relief from depressions

    // --- Frequency 3: micro-grit normal (256², 64× tiling) ----------------
    const bump = new RawTexture(
      buildMicroGritNormalData(seedHash ^ 0x5eed),
      MICRO_GRIT_TEX_SIZE,
      MICRO_GRIT_TEX_SIZE,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      true,
      false,
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    );
    bump.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
    bump.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    // Spec 14 §3.2 (kept) — tile the 256² grit map 64× across the patch.
    // With mesh UVs spanning 0..1 this lands one tile on every 1024/64 = 16 m
    // of ground (~6.25 cm per normal texel).
    bump.uScale = 64;
    bump.vScale = 64;
    bump.gammaSpace = false; // raw normal texels — linear upload
    this.bumpTexture = bump;
    mat.bumpTexture = bump;
    bump.level = 2.4; // coarse, airless grit catches the sun harshly
    // Store for `getRegolithMaterial()` readback, the opposition-surge
    // per-frame update, and dispose teardown (Spec 23).
    this.regolithMaterial = mat;
    return mat;
  }

  /**
   * Spec 23 §2.1.4 — per-frame Hapke retroreflective opposition surge. The
   * regolith brightens as the camera view aligns with the sun vector (zero
   * phase angle: particles hide their own shadows). Lifts `directIntensity`
   * and `specularIntensity` on the regolith material by
   * `OPPOSITION_SURGE` gains scaled through `hapkeOppositionSurge()`. No-op
   * before `init()`, after `dispose()`, or without a sun/active camera.
   */
  updateOppositionSurge(): void {
    if (this.disposed || this.scene === null || this.sun === null) return;
    if (this.regolithMaterial === null) return;
    const cam = this.scene.activeCamera;
    if (cam === null || cam === undefined) return;
    const ref = this.scratchSurge;
    // Duck-typed: UniversalCamera / ArcRotateCamera both ship it, but the
    // bare Camera base type in Babylon v9's .d.ts drifts on the signature.
    const getDir = (cam as unknown as {
      getDirectionToRef?: (local: Vector3, result: Vector3) => Vector3;
    }).getDirectionToRef;
    if (typeof getDir !== 'function') return;
    getDir.call(cam, Vector3.Forward(), ref);
    const sunLen = this.sun.direction.length();
    if (sunLen < 1e-9) return;
    // Zero phase angle = looking *toward* the sun, i.e. forward ≈ −d̂_sun.
    const dot =
      -(ref.x * this.sun.direction.x + ref.y * this.sun.direction.y + ref.z * this.sun.direction.z) / sunLen;
    const surge = hapkeOppositionSurge(dot);
    this.regolithMaterial.directIntensity =
      OPPOSITION_SURGE.baseDirect + OPPOSITION_SURGE.directGain * surge;
    this.regolithMaterial.specularIntensity =
      OPPOSITION_SURGE.baseSpecular + OPPOSITION_SURGE.specularGain * surge;
  }

  /** The regolith PBR material (harness readback; null before init). */
  getRegolithMaterial(): PBRMaterial | null {
    return this.regolithMaterial;
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

/** Wall-clock ms for VFX timing (performance.now when present). */
function miningClockMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Parse `#rrggbb` (garbage falls back to HUD cyan); alpha always opaque. */
function parseHexColor(hex: string): Color3 {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (m === null) return new Color3(0.34, 0.88, 1);
  const n = parseInt(m[1], 16);
  return new Color3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default WorldScene;
