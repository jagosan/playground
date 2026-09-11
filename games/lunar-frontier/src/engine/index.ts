/**
 * Lunar Frontier — 3D engine module surface.
 *
 * Re-exports the Babylon.js world engine (`WorldScene`), the EVA/vehicle
 * camera rig (`CameraRig`), and the shared physics↔Babylon frame helpers.
 *
 * NOTE: importing this barrel pulls `@babylonjs/core` into the module graph —
 * server-side code should not import it.
 */

export {
  WorldScene,
  type WorldSceneOptions,
} from './WorldScene.ts';

export {
  CameraRig,
  CAMERA_MODES,
  DEFAULT_MODE_CONFIGS,
  angleDelta,
  worldToBabylon,
  babylonToWorld,
  type CameraMode,
  type CameraModeConfig,
  type CameraRigOptions,
} from './CameraRig.ts';

export { WorldScene as default } from './WorldScene.ts';
