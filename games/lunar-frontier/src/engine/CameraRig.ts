/**
 * Lunar Frontier — EVA & vehicle camera rig.
 *
 * Wraps three Babylon.js camera archetypes behind one interpolation surface:
 *
 *  - `eva_first_person`  — `UniversalCamera` locked to the suit's eye point
 *    (helmet just above the physics body centre), yaw/pitch driven directly
 *    from the TraversalPhysics heading with damped smoothing.
 *  - `eva_third_person`  — `ArcRotateCamera` orbiting the suit at a fixed
 *    radius/behind-the-back azimuth, slowly trailing the target.
 *  - `vehicle_chase`     — `ArcRotateCamera` locked behind the rover heading
 *    at a longer, lower orbit so the cargo bed and terrain ahead stay framed.
 *
 * World-frame convention matches `LunarWorldGenerator` / `TraversalPhysics`:
 * metres, **z up**, yaw radians in the x-y plane with 0 = +x. Babylon's
 * default left-handed y-up frame is remapped here as:
 *
 *   world (x, y, z↑)  →  babylon (x, z↑, -y)
 *
 * so `targetPos` keeps its physics meaning and the ground plane renders
 * horizontal. Yaw is likewise negated into Babylon azimuth space.
 *
 * The rig is headless-resilient: it works against a `NullEngine` scene (no
 * window/document) and `attachControl()` no-ops with a warning when the
 * canvas or DOM is unavailable.
 *
 * Usage:
 *   const rig = new CameraRig(scene);
 *   rig.attachControl(canvas);            // browser only
 *   rig.setMode('vehicle_chase');
 *   rig.update({ x: 10, y: 20, z: 3 }, Math.PI / 2, 1 / 60);
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { FollowCamera } from '@babylonjs/core/Cameras/followCamera.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Scene } from '@babylonjs/core/scene.js';

export type CameraMode = 'eva_first_person' | 'eva_third_person' | 'vehicle_chase';

/**
 * Physics frame (x, y lateral, z = elevation up) → Babylon left-handed y-up
 * frame. Shared by the rig and `WorldScene` so meshes, camera and physics
 * never disagree about where "up" is.
 */
export function worldToBabylon(p: { x: number; y: number; z: number }): Vector3 {
  return new Vector3(p.x, p.z, -p.y);
}

/** Babylon y-up frame → physics frame (inverse of {@link worldToBabylon}). */
export function babylonToWorld(v: Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: -v.z, z: v.y };
}

export const CAMERA_MODES: readonly CameraMode[] = [
  'eva_first_person',
  'eva_third_person',
  'vehicle_chase',
];

/** Per-mode tuning. FOV is degrees (converted to Babylon radians internally). */
export interface CameraModeConfig {
  /** Vertical field of view in degrees (spec band 55–65). */
  fovDegrees: number;
  /** Third-person / chase orbit radius in metres. */
  distance: number;
  /** Camera height above the target point, metres. */
  heightOffset: number;
  /** Position lerp rate (1/s, frame-rate independent exponential smoothing). */
  positionSmoothing: number;
  /** Angle lerp rate (1/s) for yaw/pitch/orbit drift. */
  rotationSmoothing: number;
  /** Minimum metres the camera keeps above local ground. */
  groundClearance: number;
}

export interface CameraRigOptions {
  /** Override the per-mode table wholesale or partially. */
  modes?: Partial<Record<CameraMode, Partial<CameraModeConfig>>>;
  /** Starting mode (default `eva_first_person`). */
  initialMode?: CameraMode;
  /** Near clip. */
  minZ?: number;
  /** Far clip (mare horizon + Earth orbit visibility). */
  maxZ?: number;
  /** Height sampler used to keep the camera above regolith; optional. */
  groundHeightAt?: (x: number, y: number) => number;
  /** Suppress console warnings when DOM input cannot attach (CI/headless). */
  silent?: boolean;
}

export const DEFAULT_MODE_CONFIGS: Record<CameraMode, CameraModeConfig> = {
  eva_first_person: {
    fovDegrees: 62,
    distance: 0,
    heightOffset: 1.62, // helmet eye point above suit centre
    positionSmoothing: 14,
    rotationSmoothing: 11,
    groundClearance: 0.35,
  },
  eva_third_person: {
    fovDegrees: 58,
    distance: 6.5,
    heightOffset: 2.6,
    positionSmoothing: 6.5,
    rotationSmoothing: 5.5,
    groundClearance: 0.9,
  },
  vehicle_chase: {
    fovDegrees: 55,
    distance: 11.5,
    heightOffset: 3.8,
    positionSmoothing: 4.5,
    rotationSmoothing: 4.0,
    groundClearance: 1.1,
  },
};

/** Frame-rate independent exponential approach: k = 1 - exp(-rate * dt). */
function smoothFactor(ratePerSec: number, dt: number): number {
  if (dt <= 0) return 1;
  return 1 - Math.exp(-Math.max(0, ratePerSec) * dt);
}

function approach(current: number, goal: number, t: number): number {
  return current + (goal - current) * t;
}

/** Shortest signed delta between two angles, wrapped to (-pi, pi]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function approachAngle(current: number, goal: number, t: number): number {
  return current + angleDelta(current, goal) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class CameraRig {
  private readonly scene: Scene;
  private readonly options: CameraRigOptions;
  private readonly configs: Record<CameraMode, CameraModeConfig>;

  private readonly firstPerson: UniversalCamera;
  private readonly thirdPerson: ArcRotateCamera;
  private readonly chase: ArcRotateCamera;
  /** Constructed but unused without a FollowCamera lock target; kept for
   *  attach/getActiveCamera symmetry and future cockpit work. */
  private readonly follow: FollowCamera;

  private mode: CameraMode;
  private attached = false;
  private disposed = false;

  // Interpolation state (Babylon-frame positions + yaw/pitch goals).
  private readonly currentPos = new Vector3(0, 0, 0);
  private currentYaw = 0;
  private currentPitch = 0;
  private currentOrbitAzimuth = Math.PI; // behind-target azimuth for arcs
  private hasState = false;

  constructor(scene: Scene, options: CameraRigOptions = {}) {
    if (scene === null || scene === undefined) {
      throw new Error('CameraRig: a Babylon Scene is required');
    }
    this.scene = scene;
    this.options = options;

    const minZ = options.minZ ?? 0.05;
    const maxZ = options.maxZ ?? 12000;

    // Merge per-mode overrides over the defaults.
    const merged = {} as Record<CameraMode, CameraModeConfig>;
    for (const mode of CAMERA_MODES) {
      merged[mode] = {
        ...DEFAULT_MODE_CONFIGS[mode],
        ...(options.modes?.[mode] ?? {}),
      };
    }
    this.configs = merged;

    this.firstPerson = new UniversalCamera('rig_eva_fp', this.currentPos.clone(), scene);
    this.firstPerson.rotation = new Vector3(0, 0, 0);
    this.applyCommonSettings(this.firstPerson, minZ, maxZ);
    this.applyFov(this.firstPerson, merged.eva_first_person.fovDegrees);

    const tpCfg = merged.eva_third_person;
    this.thirdPerson = new ArcRotateCamera(
      'rig_eva_tp',
      Math.PI, // alpha: behind
      Math.PI / 2.35, // beta: slight downward look
      tpCfg.distance,
      new Vector3(0, 0, 0),
      scene,
    );
    this.applyCommonSettings(this.thirdPerson, minZ, maxZ);
    this.applyFov(this.thirdPerson, tpCfg.fovDegrees);
    this.thirdPerson.lowerRadiusLimit = 3;
    this.thirdPerson.upperRadiusLimit = 18;
    this.thirdPerson.panningSensibility = 0; // no panning; target follows the suit

    const chaseCfg = merged.vehicle_chase;
    this.chase = new ArcRotateCamera(
      'rig_vehicle_chase',
      Math.PI,
      Math.PI / 2.15,
      chaseCfg.distance,
      new Vector3(0, 0, 0),
      scene,
    );
    this.applyCommonSettings(this.chase, minZ, maxZ);
    this.applyFov(this.chase, chaseCfg.fovDegrees);
    this.chase.lowerRadiusLimit = 6;
    this.chase.upperRadiusLimit = 40;
    this.chase.panningSensibility = 0;

    this.follow = new FollowCamera('rig_follow', new Vector3(0, 5, -10), scene);
    this.applyCommonSettings(this.follow, minZ, maxZ);
    this.follow.heightOffset = 3.8;
    this.follow.rotationOffset = Math.PI;
    this.follow.cameraAcceleration = 0.08;
    this.follow.maxCameraSpeed = 40;

    this.mode = options.initialMode ?? 'eva_first_person';
    this.activateMode(this.mode);
  }

  // -- public API -------------------------------------------------------------

  /** Current mode. */
  getMode(): CameraMode {
    return this.mode;
  }

  /** Effective (post-override) config for a mode. */
  getConfig(mode: CameraMode = this.mode): CameraModeConfig {
    return { ...this.configs[mode] };
  }

  /**
   * Switch camera modes. The new camera inherits the current interpolation
   * state, so transitions read as a smooth pull-back/push-in rather than a
   * hard cut (first update after the switch lerps from the shared position).
   */
  setMode(mode: CameraMode): boolean {
    if (this.disposed) return false;
    if (!CAMERA_MODES.includes(mode)) return false;
    if (mode === this.mode) return true;
    // Seed the incoming mode with the exit state of the outgoing one.
    if (this.hasState) {
      this.currentOrbitAzimuth = Math.PI - this.wrapTargetYaw(this.currentYaw);
    }
    this.mode = mode;
    this.activateMode(mode);
    // Push the shared interpolation state into the newly-active camera so the
    // switch itself never teleports: the outgoing camera held the state, and
    // the incoming one must inherit it before the next update lerps onward.
    this.seedActiveCamera();
    return true;
  }

  /** FOV of the active camera, degrees. */
  getFovDegrees(): number {
    return (this.getActiveCamera().fov * 180) / Math.PI;
  }

  /** Set FOV (degrees, clamped to a sane 30–110) on the active camera. */
  setFovDegrees(degrees: number): void {
    this.applyFov(this.getActiveCamera(), degrees);
  }

  /**
   * Advance the rig one frame.
   *
   * @param targetPos physics-frame position (x, y lateral, z = elevation up)
   *                  of the suit / rover being filmed.
   * @param targetYaw yaw radians in the x-y plane (0 = +x), matching
   *                  `SuitState.heading`.
   * @param dt        seconds since last update.
   * @param targetPitch optional look pitch (radians, + = up).
   */
  update(
    targetPos: { x: number; y: number; z: number },
    targetYaw: number,
    dt: number,
    targetPitch = 0,
  ): void {
    if (this.disposed) return;
    const cfg = this.configs[this.mode];

    // Physics frame → Babylon frame: (x, y, z↑) → (x, z↑, -y).
    const bx = targetPos.x;
    const by = targetPos.z;
    const bz = -targetPos.y;

    if (!this.hasState) {
      this.currentPos.set(bx, by + cfg.heightOffset, bz);
      this.currentYaw = targetYaw;
      this.currentPitch = targetPitch;
      this.currentOrbitAzimuth = targetYaw + Math.PI;
      this.hasState = true;
    }

    const posT = smoothFactor(cfg.positionSmoothing, dt);
    const rotT = smoothFactor(cfg.rotationSmoothing, dt);

    this.currentYaw = approachAngle(this.currentYaw, targetYaw, rotT);
    this.currentPitch = approach(this.currentPitch, clamp(targetPitch, -1.35, 1.35), rotT);

    if (this.mode === 'eva_first_person') {
      this.currentPos.set(
        approach(this.currentPos.x, bx, posT),
        approach(this.currentPos.y, by + cfg.heightOffset, posT),
        approach(this.currentPos.z, bz, posT),
      );
      this.keepAboveGround(cfg);
      this.firstPerson.position.copyFrom(this.currentPos);
      // Babylon left-handed y-up: a camera facing physics-forward
      // (cos yaw, sin yaw, 0) → (cos yaw, 0, -sin yaw) has rotation.y =
      // π/2 + yaw. Pitch + (up) is negative rotation.x.
      this.firstPerson.rotation.y = Math.PI / 2 + this.currentYaw;
      this.firstPerson.rotation.x = -this.currentPitch;
      this.firstPerson.rotation.z = 0;
    } else {
      const arc = this.mode === 'vehicle_chase' ? this.chase : this.thirdPerson;
      // Orbit azimuth places the camera behind the moving target: offset dir
      // (−cos yaw, 0, sin yaw) ⇒ α = π − yaw (Babylon: pos ∝ (cos α, ·, sin α)).
      const goalAzimuth = Math.PI - this.wrapTargetYaw(targetYaw);
      this.currentOrbitAzimuth = approachAngle(this.currentOrbitAzimuth, goalAzimuth, rotT);
      arc.alpha = this.currentOrbitAzimuth;
      arc.beta = clamp(Math.PI / 2 - 0.32 - this.currentPitch * 0.35, 0.35, 1.5);

      const pivotX = approach(arc.target.x, bx, posT);
      const pivotY = approach(arc.target.y, by + cfg.heightOffset * 0.6, posT);
      const pivotZ = approach(arc.target.z, bz, posT);
      arc.target.set(pivotX, pivotY, pivotZ);
      // Mirror the pivot into currentPos so mode switches inherit continuity.
      this.currentPos.set(pivotX, pivotY, pivotZ);
      // Refresh pose first so the ground check sees this frame's camera
      // position rather than last frame's stale globalPosition.
      arc.computeWorldMatrix(true);
      if (this.keepArcAboveGround(arc, cfg)) {
        arc.computeWorldMatrix(true);
      }
      return;
    }

    // First person: position applied directly; refresh world matrix so
    // headless consumers stepping the rig see truthful globalPosition.
    this.getActiveCamera().computeWorldMatrix(true);
  }

  /**
   * Wire pointer/keyboard input to the active camera. In a headless Node run
   * (no canvas, no window) this warns once and returns false instead of
   * throwing, so smoke tests can drive `update()` directly.
   */
  attachControl(canvas?: HTMLCanvasElement | null): boolean {
    if (this.disposed) return false;
    const el = (canvas ??
      (typeof document !== 'undefined' ? document.querySelector('canvas') : null)) as
      | HTMLCanvasElement
      | null;
    if (el === null || typeof window === 'undefined') {
      if (this.options.silent !== true && typeof console !== 'undefined') {
        console.warn('[CameraRig] no canvas/DOM available — input attach skipped (headless mode)');
      }
      return false;
    }
    try {
      const cam = this.getActiveCamera();
      cam.attachControl(el, true);
      this.attached = true;
      return true;
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[CameraRig] attachControl failed:', (err as Error).message);
      }
      return false;
    }
  }

  /** Detach DOM input (safe to call even if never attached). */
  detachControl(): void {
    if (this.disposed || !this.attached) return;
    try {
      for (const cam of this.allCameras()) cam.detachControl();
    } catch {
      /* headless or already detached — ignore */
    }
    this.attached = false;
  }

  /** The Babylon camera currently rendering. */
  getActiveCamera(): Camera {
    if (this.mode === 'eva_first_person') return this.firstPerson;
    if (this.mode === 'vehicle_chase') return this.chase;
    return this.thirdPerson;
  }

  /** Named handle to the underlying FollowCamera (cockpit/cockpit-chase work). */
  getFollowCamera(): FollowCamera {
    return this.follow;
  }

  /** True once DOM input is attached. */
  isAttached(): boolean {
    return this.attached;
  }

  /** Current interpolated camera position in the physics frame. */
  getPhysicsPosition(): { x: number; y: number; z: number } {
    const p = this.getActiveCamera().globalPosition;
    return { x: p.x, y: -p.z, z: p.y };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachControl();
    for (const cam of this.allCameras()) {
      try {
        cam.dispose();
      } catch {
        /* already gone */
      }
    }
    if (this.scene.activeCamera !== null) {
      this.scene.activeCamera = null;
    }
  }

  // -- internals ----------------------------------------------------------------

  private allCameras(): Camera[] {
    return [this.firstPerson, this.thirdPerson, this.chase, this.follow];
  }

  /**
   * Push the shared interpolation state into the currently-active camera.
   * ArcRotate targets and UniversalCamera positions are per-camera storage;
   * without this seed the incoming camera's stale pose (e.g. an orbit target
   * that never moved while first-person was active) makes the first frame
   * after a mode switch read as a teleport.
   */
  private seedActiveCamera(): void {
    if (!this.hasState) return;
    if (this.mode === 'eva_first_person') {
      this.firstPerson.position.copyFrom(this.currentPos);
      this.firstPerson.rotation.y = Math.PI / 2 + this.currentYaw;
      this.firstPerson.rotation.x = -this.currentPitch;
    } else {
      const arc = this.mode === 'vehicle_chase' ? this.chase : this.thirdPerson;
      arc.target.copyFrom(this.currentPos);
      arc.alpha = this.currentOrbitAzimuth;
    }
    // Force a matrix rebuild so globalPosition is truthful immediately after
    // the switch (headless consumers read it without a render() in between).
    this.getActiveCamera().computeWorldMatrix(true);
  }

  private activateMode(mode: CameraMode): void {
    // Deactivate the others so their _checkInputs never fights the rig.
    for (const cam of this.allCameras()) {
      if (cam !== this.cameraForMode(mode)) {
        cam.detachControl();
      }
    }
    const cam = this.cameraForMode(mode);
    this.scene.activeCamera = cam;
    if (this.attached) {
      try {
        cam.attachControl(undefined, true);
      } catch {
        /* headless */
      }
    }
  }

  private cameraForMode(mode: CameraMode): Camera {
    if (mode === 'eva_first_person') return this.firstPerson;
    if (mode === 'vehicle_chase') return this.chase;
    return this.thirdPerson;
  }

  private applyCommonSettings(cam: Camera, minZ: number, maxZ: number): void {
    cam.minZ = minZ;
    cam.maxZ = maxZ;
    cam.inertia = 0; // the rig does its own smoothing
  }

  private applyFov(cam: Camera, degrees: number): void {
    const d = clamp(degrees, 30, 110);
    cam.fov = (d * Math.PI) / 180;
  }

  /** Negated-yaw wrap helper so goal azimuth stays in (-pi, pi] territory. */
  private wrapTargetYaw(yaw: number): number {
    let y = yaw % (Math.PI * 2);
    if (y > Math.PI) y -= Math.PI * 2;
    if (y < -Math.PI) y += Math.PI * 2;
    return y;
  }

  private keepAboveGround(cfg: CameraModeConfig): void {
    if (this.options.groundHeightAt === undefined) return;
    const gx = this.currentPos.x;
    const gy = -this.currentPos.z;
    const floor = this.options.groundHeightAt(gx, gy) + cfg.groundClearance;
    if (this.currentPos.y < floor) this.currentPos.y = floor;
  }

  /** Lifts the orbit pivot so the camera never clips regolith. True if lifted. */
  private keepArcAboveGround(arc: ArcRotateCamera, cfg: CameraModeConfig): boolean {
    if (this.options.groundHeightAt === undefined) return false;
    const p = arc.globalPosition;
    const floor = this.options.groundHeightAt(p.x, -p.z) + cfg.groundClearance;
    if (p.y < floor) {
      arc.target.y += floor - p.y;
      return true;
    }
    return false;
  }
}

export default CameraRig;
