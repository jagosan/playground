/**
 * Lunar Frontier — 3D Dynamic Hint Arrow System (Spec 18 §6.1, ADR-18-2).
 *
 * Dual-mode spatial guidance for the active quest objective:
 *
 *   1. **In-frustum** — a holographic neon chevron (cone + ring) hovers
 *      `heightOffsetM` above the target, bobbing ±0.3 m at 1.2 Hz (spec
 *      §6.1.1), while the HUD hint-arrow element shows a distance readout at
 *      the chevron's projected screen position.
 *   2. **Off-screen** (behind the camera or outside the viewport) — the 3D
 *      mesh is hidden and a screen-edge clamp is computed: the ray from the
 *      screen centre through the (pinhole-inverted) target direction is
 *      intersected with the inset viewport rectangle, yielding perimeter
 *      coordinates + angle that `LunarHUD.updateHintArrow()` renders as a
 *      rotated perimeter chevron.
 *
 * Coordinate convention: targets are expressed in the **physics world frame**
 * (x east, y north, z up — identical to `QuestEngine.getHintArrowTarget()`
 * output) and converted internally through the shared `worldToBabylon`
 * mapping, exactly like `ClientApp`'s beacon columns.
 *
 * NullEngine safety: mesh/material construction, `Vector3.Project`, and
 * `update()` all tolerate a headless engine; a zero-size viewport (canvas
 * width/height 0) short-circuits to a hidden payload instead of dividing by
 * zero. `dispose()` releases meshes, materials, and scene references and is
 * idempotent.
 */

import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';

import { worldToBabylon } from '../engine/CameraRig.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A quest waypoint in the physics world frame (z up). */
export interface HintArrowTarget {
  x: number;
  y: number;
  z: number;
  label?: string;
}

/**
 * Frame payload describing what the 2D HUD hint-arrow element should render.
 * This is exactly the argument shape `LunarHUD.updateHintArrow()` accepts.
 *
 * - `visible: false` → hide the HUD element entirely.
 * - `isOffScreen: false` → in-frustum: `screenX/screenY` track the chevron
 *   projection (HUD shows a distance chip there, no perimeter clamp).
 * - `isOffScreen: true` → perimeter clamp: `screenX/screenY` lie ON the
 *   (inset) screen border, `angleDeg` points toward the target.
 */
export interface HudHintArrowPayload {
  visible: boolean;
  screenX?: number;
  screenY?: number;
  angleDeg?: number;
  distanceM?: number;
  label?: string;
  isOffScreen?: boolean;
}

export interface HintArrowSystemOptions {
  /** Babylon scene the chevron visual is built into. */
  scene: Scene;
  /** Called every `update()` with the payload for the HUD (or null→hidden). */
  onHudUpdate?: (payload: HudHintArrowPayload) => void;
  /** Clock in milliseconds (deterministic bob in tests). */
  clock?: () => number;
  /** Bob amplitude above/below the hover height, metres (spec: ±0.3). */
  bobAmplitudeM?: number;
  /** Bob frequency in Hz (spec: 1.2). */
  bobFrequencyHz?: number;
  /** Hover height above the target point, metres (spec: "+y offset"). */
  heightOffsetM?: number;
  /** Perimeter clamp inset from the screen edge, pixels. */
  edgeInsetPx?: number;
  /** Emissive neon colour [r, g, b] in 0..1 (default cyan). */
  color?: readonly [number, number, number];
}

/** Forensics snapshot — what the last `update()` decided. */
export interface HintArrowState {
  hasTarget: boolean;
  inView: boolean;
  offScreen: boolean;
  distanceM: number | null;
  angleDeg: number | null;
  /** View-space depth of the target (negative = behind the camera plane). */
  viewDepth: number | null;
}

// ---------------------------------------------------------------------------
// Constants (Spec 18 §6.1.1)
// ---------------------------------------------------------------------------

export const HINT_BOB_AMPLITUDE_M = 0.3;
export const HINT_BOB_FREQUENCY_HZ = 1.2;
export const HINT_HEIGHT_OFFSET_M = 2.2;
export const HINT_EDGE_INSET_PX = 48;

/** Depth band treated as "on the camera plane" (radial clamp degenerates). */
const DEGENERATE_DEPTH = 1e-6;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function defaultClock(): number {
  const g = globalThis as { performance?: { now?: () => number } };
  if (g.performance !== undefined && typeof g.performance.now === 'function') {
    return g.performance.now();
  }
  return Date.now();
}

// ---------------------------------------------------------------------------
// HintArrowSystem
// ---------------------------------------------------------------------------

export class HintArrowSystem {
  private readonly scene: Scene;
  private readonly onHudUpdate: ((payload: HudHintArrowPayload) => void) | undefined;
  private readonly clock: () => number;
  private readonly bobAmplitudeM: number;
  private readonly bobFrequencyHz: number;
  private readonly heightOffsetM: number;
  private readonly edgeInsetPx: number;

  private readonly chevron: Mesh;
  private readonly ring: Mesh;
  private readonly material: StandardMaterial;

  private target: HintArrowTarget | null = null;
  private lastPayload: HudHintArrowPayload = { visible: false };
  private lastState: HintArrowState = {
    hasTarget: false,
    inView: false,
    offScreen: false,
    distanceM: null,
    angleDeg: null,
    viewDepth: null,
  };
  private disposed = false;

  constructor(options: HintArrowSystemOptions) {
    if (options === null || options === undefined) {
      throw new Error('HintArrowSystem: options with a Babylon scene are required');
    }
    const scene = options.scene as Scene | null | undefined;
    if (scene === null || scene === undefined || typeof scene.addMesh !== 'function') {
      throw new Error('HintArrowSystem: a Babylon Scene is required');
    }
    this.scene = scene;
    this.onHudUpdate = options.onHudUpdate;
    this.clock = options.clock ?? defaultClock;
    this.bobAmplitudeM = options.bobAmplitudeM ?? HINT_BOB_AMPLITUDE_M;
    this.bobFrequencyHz = options.bobFrequencyHz ?? HINT_BOB_FREQUENCY_HZ;
    this.heightOffsetM = options.heightOffsetM ?? HINT_HEIGHT_OFFSET_M;
    this.edgeInsetPx = Math.max(0, options.edgeInsetPx ?? HINT_EDGE_INSET_PX);

    // Neon hologram material: emissive-only, unlit, semi-transparent, and
    // never rendered into the depth buffer so it floats over regolith.
    const [r, g, b] = options.color ?? [0.34, 0.88, 1.0];
    this.material = new StandardMaterial('hint-arrow-mat', scene);
    this.material.diffuseColor = new Color3(0, 0, 0);
    this.material.emissiveColor = new Color3(r, g, b);
    this.material.alpha = 0.85;
    this.material.disableLighting = true;

    // Chevron: a 4-sided cone with the apex pointing DOWN at the waypoint
    // (Babylon cones point +y, so tilt -90° about x… apex-down = +90°? The
    // cylinder builder puts the top (diameterTop) at +y; collapsing the top
    // leaves the apex at +y, so rotation.x = PI flips it to point -y).
    this.chevron = MeshBuilder.CreateCylinder(
      'hint-arrow-chevron',
      { diameterTop: 0, diameterBottom: 1.05, height: 1.15, tessellation: 4 },
      scene,
    );
    this.chevron.rotation.x = Math.PI;
    this.chevron.isPickable = false;
    this.chevron.material = this.material;

    this.ring = MeshBuilder.CreateTorus(
      'hint-arrow-ring',
      { diameter: 1.7, thickness: 0.06, tessellation: 18 },
      scene,
    );
    this.ring.isPickable = false;
    this.ring.material = this.material;

    this.setMeshesVisible(false);
  }

  // -- target management -------------------------------------------------------

  /** Install (or clear, with null) the active waypoint. */
  setTarget(target: HintArrowTarget | null): void {
    if (this.disposed) return;
    if (target === null || target === undefined) {
      this.target = null;
      this.setMeshesVisible(false);
      return;
    }
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
      this.target = null;
      this.setMeshesVisible(false);
      return;
    }
    this.target = { x: target.x, y: target.y, z: target.z, label: target.label };
  }

  getTarget(): HintArrowTarget | null {
    return this.disposed ? null : this.target;
  }

  /** Payload emitted by the most recent `update()` (never undefined). */
  getLastPayload(): HudHintArrowPayload {
    return this.lastPayload;
  }

  /** Forensics snapshot of the most recent projection decision. */
  getState(): HintArrowState {
    return this.lastState;
  }

  // -- per-frame update ----------------------------------------------------------

  /**
   * Project `targetWorldPos` (physics frame; falls back to {@link setTarget})
   * through `camera` into a `screenWidth × screenHeight` viewport.
   *
   * Uses `Vector3.Project`: the target is in front of the camera when the
   * view-space depth is positive AND the projected z lands inside the
   * viewport depth band (0..1) with x/y inside the pixel rectangle. Any
   * other case (z outside 0..1, degenerate side-of-plane projection, NaN)
   * routes to the screen-edge clamp math (ADR-18-2).
   *
   * Returns the emitted HUD payload and also pushes it to `onHudUpdate`.
   */
  update(
    camera: Camera | null | undefined,
    targetWorldPos: HintArrowTarget | null = null,
    screenWidth = 0,
    screenHeight = 0,
  ): HudHintArrowPayload {
    if (this.disposed) {
      return this.emit({ visible: false });
    }
    const target = targetWorldPos ?? this.target;
    if (
      target === null ||
      target === undefined ||
      camera === null ||
      camera === undefined ||
      !Number.isFinite(target.x) ||
      !Number.isFinite(target.y) ||
      !Number.isFinite(target.z)
    ) {
      this.setMeshesVisible(false);
      this.lastState = {
        hasTarget: target !== null && target !== undefined,
        inView: false,
        offScreen: false,
        distanceM: null,
        angleDeg: null,
        viewDepth: null,
      };
      return this.emit({ visible: false });
    }

    // NullEngine / uninitialised canvas: no projection surface exists — hide
    // rather than divide by zero.
    if (!(screenWidth > 0) || !(screenHeight > 0)) {
      this.setMeshesVisible(false);
      this.lastState = {
        hasTarget: true,
        inView: false,
        offScreen: false,
        distanceM: null,
        angleDeg: null,
        viewDepth: null,
      };
      return this.emit({ visible: false });
    }

    // Physics frame → Babylon frame, matching ClientApp beacons/CameraRig.
    const p = worldToBabylon(target);
    const camPos = camera.globalPosition;
    const distanceM = Vector3.Distance(p, camPos);

    // Force the freshest world matrix before projecting. Babylon v9's
    // shipped .d.ts drifts `Camera.computeWorldMatrix` to a 0-arg signature
    // (the same drift behind the pre-existing CameraRig.ts tsc errors), so
    // the one-arg runtime contract is invoked structurally.
    const forceWorld = camera as unknown as { computeWorldMatrix?: (force: boolean) => unknown };
    if (typeof forceWorld.computeWorldMatrix === 'function') {
      forceWorld.computeWorldMatrix(true);
    }
    const view = camera.getViewMatrix();
    // Row-major view matrix rows: view-space coords of the world point are
    // row·p + translation column — cheap, allocation-free depth test.
    const viewX = view.m[0] * p.x + view.m[1] * p.y + view.m[2] * p.z + view.m[3];
    const viewY = view.m[4] * p.x + view.m[5] * p.y + view.m[6] * p.z + view.m[7];
    const viewZ = view.m[8] * p.x + view.m[9] * p.y + view.m[10] * p.z + view.m[11];

    const projection = camera.getProjectionMatrix();
    const xform = view.multiply(projection);
    const projected = Vector3.Project(
      p,
      Matrix.Identity(),
      xform,
      camera.viewport.toGlobal(screenWidth, screenHeight),
    );

    // In front of the camera plane AND inside the projected frustum band
    // (z 0..1) AND inside the pixel rectangle (with a hair of slop for
    // antialiased edge pixels)?
    const depthOk = viewZ > DEGENERATE_DEPTH;
    const zBandOk = Number.isFinite(projected.z) && projected.z >= 0 && projected.z <= 1;
    const rectOk =
      Number.isFinite(projected.x) &&
      Number.isFinite(projected.y) &&
      projected.x >= -2 &&
      projected.x <= screenWidth + 2 &&
      projected.y >= -2 &&
      projected.y <= screenHeight + 2;

    const label = target.label;

    if (depthOk && zBandOk && rectOk) {
      // --- MODE 1: in-frustum holographic chevron ----------------------------
      const bob = this.bobOffsetM();
      const hover = p.clone();
      hover.y += this.heightOffsetM + bob;
      this.chevron.position.copyFrom(hover);
      this.ring.position.copyFrom(hover);
      // Slow spin sells the hologram without needing a billboard.
      const spin = (this.clock() / 1000) * 0.9;
      this.chevron.rotation.y = spin;
      this.ring.rotation.y = -spin * 0.6;
      this.setMeshesVisible(true);

      this.lastState = {
        hasTarget: true,
        inView: true,
        offScreen: false,
        distanceM,
        angleDeg: null,
        viewDepth: viewZ,
      };
      return this.emit({
        visible: true,
        screenX: projected.x,
        screenY: projected.y,
        distanceM,
        label,
        isOffScreen: false,
      });
    }

    // --- MODE 2: screen-edge clamped perimeter chevron ------------------------
    // Direction from screen centre toward the target. In front but outside
    // the rect: use the raw projection. Behind (or on) the camera plane: the
    // pinhole-inverted direction — negate x, flip y (screen y is down while
    // view y is up), which is what a 360° guidance arrow must point to.
    let dirX: number;
    let dirY: number;
    if (depthOk && Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
      dirX = projected.x - screenWidth / 2;
      dirY = projected.y - screenHeight / 2;
    } else {
      dirX = -viewX;
      dirY = viewY;
    }
    // Dead-ahead-on-plane target: no radial direction — pin to top centre.
    if (!Number.isFinite(dirX) || !Number.isFinite(dirY) || (Math.abs(dirX) < 1e-9 && Math.abs(dirY) < 1e-9)) {
      dirX = 0;
      dirY = -1;
    }

    const angleDeg = (Math.atan2(dirY, dirX) * 180) / Math.PI;

    // Radial intersection with the inset screen rectangle:
    // t = min(halfW/|dx|, halfH/|dy|) over the non-degenerate axes.
    const halfW = Math.max(1, screenWidth / 2 - this.edgeInsetPx);
    const halfH = Math.max(1, screenHeight / 2 - this.edgeInsetPx);
    const adx = Math.abs(dirX);
    const ady = Math.abs(dirY);
    let t = Number.POSITIVE_INFINITY;
    if (adx > 1e-9) t = Math.min(t, halfW / adx);
    if (ady > 1e-9) t = Math.min(t, halfH / ady);
    if (!Number.isFinite(t)) t = 0;

    const screenX = clamp(screenWidth / 2 + dirX * t, 0, screenWidth);
    const screenY = clamp(screenHeight / 2 + dirY * t, 0, screenHeight);

    this.setMeshesVisible(false);
    this.lastState = {
      hasTarget: true,
      inView: false,
      offScreen: true,
      distanceM,
      angleDeg,
      viewDepth: viewZ,
    };
    return this.emit({
      visible: true,
      screenX,
      screenY,
      angleDeg,
      distanceM,
      label,
      isOffScreen: true,
    });
  }

  // -- lifecycle -------------------------------------------------------------------

  /** Tear down visuals; idempotent and safe to call after a bare construct. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target = null;
    try {
      this.chevron.dispose();
      this.ring.dispose();
      this.material.dispose();
    } catch {
      /* headless engines with partial meshes — best effort */
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  // -- internals ---------------------------------------------------------------------

  /** ±amplitude sine at the spec frequency (1.2 Hz), phase-continuous. */
  private bobOffsetM(): number {
    const tSeconds = this.clock() / 1000;
    return this.bobAmplitudeM * Math.sin(2 * Math.PI * this.bobFrequencyHz * tSeconds);
  }

  private setMeshesVisible(visible: boolean): void {
    this.chevron.setEnabled(visible);
    this.ring.setEnabled(visible);
  }

  private emit(payload: HudHintArrowPayload): HudHintArrowPayload {
    this.lastPayload = payload;
    this.onHudUpdate?.(payload);
    return payload;
  }
}

export default HintArrowSystem;
