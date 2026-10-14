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
  // Spec 23 §2.1/§2.3: Hapke opposition surge, visor constants & procedural
  // texture synthesis (exported for headless verification harnesses).
  VISOR_EMISSIVE_FLOOR,
  VISOR_GROUNDBOUNCE_COLOR,
  OPPOSITION_SURGE,
  hapkeOppositionSurge,
  MICRO_GRIT_TEX_SIZE,
  MESO_DETAIL_TEX_SIZE,
  MACRO_ALBEDO_TEX_SIZE,
  buildMacroAlbedoData,
  buildMicroGritNormalData,
  buildMesoDetailData,
} from './WorldScene.ts';

// Spec 23 §2.2 / ADR-023-2: clast-field archetypes (re-exported for harnesses).
export {
  ROCK_ARCHETYPE_SIZES,
  type RockArchetype,
  type RockInstance,
  type RockFieldSnapshot,
} from '../world/LunarWorldGenerator.ts';
export { ROCK_HEIGHT_FLATTEN, ROCK_SINK_RATIO } from './WorldScene.ts';

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
  // Spec 23 Phase 5: jitter-relaxed dynamic shadow-focus smoothing law.
  SHADOW_FOCUS_RATE_PER_S,
  SHADOW_FOCUS_SNAP_M,
  smoothShadowFocus,
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

// Spec 25 §2.3: autonomous NPC prospector bots + fictional faction flags
// (re-exported through the engine barrel for harnesses and client wiring).
export {
  NPCProspectorBot,
  planNPCBotFleet,
  NPC_FLAG_COLORS,
  NPC_BOT_FLEET_FACTIONS,
  NPC_BOT_CALLSIGNS,
  SURVEY_RANGE_M as NPC_SURVEY_RANGE_M,
  CONTEST_RANGE_M as NPC_CONTEST_RANGE_M,
  HARASS_BUMP_RANGE_M as NPC_HARASS_BUMP_RANGE_M,
  SIPHON_RANGE_M as NPC_SIPHON_RANGE_M,
  BOT_CARGO_CAPACITY_KG,
  BOT_PUSH_IMPULSE_N_S,
  BOT_PUSH_EFFECTIVE_MASS_KG,
  BOT_STATE_SPEEDS,
  type NPCBotFaction,
  type NPCBotState,
  type NPCBotConfig,
  type NPCBotTelemetry,
  type NPCBotBroadcast,
  type NPCBotFleetPlanOptions,
} from '../entities/NPCProspectorBot.ts';

export { WorldScene as default } from './WorldScene.ts';
