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
  // Spec 19 §2.2.3: mining-laser burst payload.
  type MiningBeamEffect,
} from './WorldScene.ts';

export {
  CameraRig,
  CAMERA_MODES,
  DEFAULT_MODE_CONFIGS,
  angleDelta,
  worldToBabylon,
  babylonToWorld,
  // Spec 17 §2.4 chase-camera constants & velocity-vector lookahead.
  CHASE_PITCH_TILT_RAD,
  CHASE_FOV_BASE_DEG,
  CHASE_FOV_MAX_DEG,
  CHASE_SPEED_REF_MPS,
  CHASE_LOOKAHEAD_BETA,
  CHASE_LOOKAHEAD_MIN_SPEED,
  velocityLookaheadTheta,
  type CameraMode,
  type CameraModeConfig,
  type CameraRigOptions,
} from './CameraRig.ts';

export {
  ProvingGroundsScene,
  LapTimingSystem,
  buildKappaProfile,
  integrateCentreline,
  elevationAtS,
  bankAtS,
  sectorAtS,
  sectionAtS,
  wrapTrackS,
  TRACK_TOTAL_LENGTH_M,
  TRACK_WIDTH_M,
  CURB_WIDTH_M,
  SWEEPER_RADIUS_M,
  SWEEPER_BANK_RAD,
  BANK_EASE_M,
  SLALOM_RADIUS_M,
  HAIRPIN_RADIUS_M,
  CREST_ELEVATION_M,
  SPEED_TRAP_ZONE,
  GATE_S,
  type TrackWaypoint,
  type TrackLocator,
  type CircuitSectionInfo,
  type LapTelemetry,
  type LapTimingOptions,
  type ProvingGroundsSceneOptions,
} from './ProvingGroundsScene.ts';

export { WorldScene as default } from './WorldScene.ts';
