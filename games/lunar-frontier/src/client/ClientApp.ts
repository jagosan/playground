/**
 * Lunar Frontier — interactive Babylon.js client application
 * (Spec 13 §1/§2/§3, ADR-013-1/2, TASK-PLAY-054).
 *
 * `ClientApp` is the conductor that owns the whole browser-side stack:
 *
 *   • `WorldScene` (Babylon engine + scene + terrain + lights + `CameraRig`)
 *   • local `EvaSuitAvatar` and `OpenBuggy` entities (physics from
 *     `TraversalPhysics`, meshes from the entity modules — no duplication)
 *   • `TraversalController` — the prospect-node navigator built from the
 *     generated world snapshot (docks, outposts, shaft heads, junctions)
 *   • `NetworkClient` — 20 Hz `sendMove` stream, remote-avatar replication
 *     with ADR-013-2 dead reckoning, market/trade/claim/mine round-trips
 *   • `LunarHUD` — the glassmorphic DOM overlay (ADR-013-1)
 *
 * Frame convention follows the whole codebase: physics metres (x, y lateral,
 * z up) map to Babylon (x, z↑, -y) through the shared `worldToBabylon`; the
 * client never re-derives gravity, speeds, or cargo limits locally.
 *
 * Headless-resilient by construction:
 *   `init(new NullEngine())` runs the full loop with no DOM at all — input
 *   injection goes through `handleKeyInput()`, the HUD is either injected
 *   (`options.hud`) or skipped, and the network is either injected
 *   (`options.network`) or skipped. That is exactly what
 *   `scripts/smoke-client-app.ts` drives.
 *
 * Usage (browser — see main.ts):
 *   const app = new ClientApp({ username: 'jagosan', faction: 'ARTEMIS' });
 *   await app.init(document.querySelector('canvas')!);
 *   app.run();
 * Usage (headless):
 *   const app = new ClientApp({ network: net, hud: fakeHud });
 *   app.init(new NullEngine());
 *   app.handleKeyInput('KeyD', 'down');
 *   app.update(t0 + 50);
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';

import { WorldScene, worldToBabylon, type CameraMode } from '../engine/index.ts';
import { ProvingGroundsScene, type LapTelemetry } from '../engine/ProvingGroundsScene.ts';
import { EvaSuitAvatar } from '../entities/AstronautSuit.ts';
import { OpenBuggy, MOUNT_RADIUS_M, type BuggyDashTelemetry } from '../entities/OpenBuggy.ts';
import { TraversalController } from './TraversalController.ts';
import {
  QuestEngine,
  createTutorialQuest,
  type CommsDialogue,
  type QuestCompletedPayload,
  type QuestStorage,
} from './QuestEngine.ts';
import { HintArrowSystem, type HintArrowTarget } from './HintArrowSystem.ts';
import { FactionBases } from '../infrastructure/Factions.ts';
import { TunnelNetwork } from '../infrastructure/TunnelNetwork.ts';
import { RailSystem } from '../infrastructure/RailSystem.ts';
import {
  BUGGY_MAX_CARGO,
  BUGGY_SPEED_LIMIT,
  ENV_EARTH_PROVING_GROUNDS,
  ENV_LUNAR_FRONTIER,
  IDLE_BUGGY_INPUT,
  type BuggyInput,
  type GroundElevationFn,
  type SuitInput,
} from '../physics/TraversalPhysics.ts';
import NetworkClient, {
  type ClaimStakedEvent,
  type ClientErrorEvent,
  type ConnectionEvent,
  type MarketSyncEvent,
  type MiningResource,
  type TradeConfirmedEvent,
  type TravelMode,
  type WelcomeEvent,
  type WorldDeltaEvent,
} from '../network/NetworkClient.ts';
import LunarHUD, {
  type HudCompassTargets,
  type HudPrompt,
  type HudScannerReadout,
  type HudTradeRequest,
} from '../ui/LunarHUD.ts';
import type { ResourceVein } from '../world/LunarWorldGenerator.ts';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Outbound movement stream cadence — matches the server's 20 Hz tick. */
export const MOVE_INTERVAL_MS = 50;

/** Handheld scanner sweep radius (vein surface distance), metres. */
export const SCAN_RANGE_M = 80;

/**
 * Long-range mineral scanner envelope for the compass nav pin
 * (TASK-PLAY-063c): the HUD steers toward the best qualified vein within
 * this slant distance, not only the handheld-reachable ones.
 */
export const NAV_SCAN_RANGE_M = 1200;

/** Vein surface distance within which the geo-drill reaches, metres. */
export const MINE_RANGE_M = 25;

/** Units pulled from the vein per trigger pull. */
export const MINE_AMOUNT = 20;

/** Minimum spacing between two MINE frames (trigger discipline). */
export const MINE_COOLDOWN_MS = 350;

/** Scanner re-scan period while running (Hz-wise: 4/s). */
export const SCAN_INTERVAL_MS = 250;

/** Claim radius staked by the [C] hotkey, metres. */
export const CLAIM_RADIUS_M = 20;

/**
 * Analog stick deadzone (spec 14 §3.1). Axis magnitudes at or below this read
 * as centred, so a pad with drift/wander never creeps the suit or the buggy.
 */
export const GAMEPAD_DEADZONE = 0.15;

/**
 * Steering deadzone for the exponential stick curve (Spec 17 §2.2.2). Axis
 * magnitudes at or below this read as centred; beyond it the response is
 * re-normalised to (0..1) before the exponent, so a slightly-drifting pad
 * never creeps the buggy and the curve still reaches full lock at |x| = 1.
 */
export const GAMEPAD_STEER_DEADZONE = 0.12;

/** Exponential steering exponent γ_steer (Spec 17 §2.2.2): 1.6. */
export const GAMEPAD_STEER_GAMMA = 1.6;

/**
 * Right-stick look-pitch deadband (Spec 19 §2.1.4): |axes[3]| at or below
 * this reads as centred so a drifting stick never creeps the view.
 */
export const GAMEPAD_LOOK_DEADZONE = 0.15;

/** Look-pitch exponent γ_look (Spec 19 §2.1.4 "exponential smoothing"). */
export const GAMEPAD_LOOK_GAMMA = 1.5;

/**
 * Throttle trigger exponent γ_throttle (Spec 17 §2.3.1):
 * `T_throttle = R2^1.4 · T_max`. The γ > 1 shape spends less travel near
 * zero (0.5 pull → 0.379 torque) killing launch wheelspin, while the last
 * 10 % of travel still hands over full torque when the trigger is mashed.
 */
export const GAMEPAD_THROTTLE_GAMMA = 1.4;

/**
 * Service-brake trigger exponent (Spec 17 §2.3.2 dual-stage progressive
 * braking). γ < 1 front-loads the bite point so the first millimetres of L2
 * modulate the pad gently, then the pedal firms toward full demand.
 */
export const GAMEPAD_BRAKE_GAMMA = 0.8;

/**
 * Anti-jerk smoothing rate (1/s) applied to the analog triggers after the
 * gamma curves (Spec 17 Phase 2 "anti-jerk filter"): a mashed trigger ramps
 * to full in ~1/(rate·dt) frames instead of a discontinuous step, taking the
 * jolt out of launches and panic modulations while staying transparently
 * fast at frame rates (≈125 ms to full at 60 fps).
 */
export const GAMEPAD_TRIGGER_FILTER_RATE = 12.5;

/**
 * Brake-to-reverse stationary threshold (Spec 19 §2.1.3 / ADR-2): with the
 * rover's longitudinal speed at or below this many m/s, a held brake trigger
 * routes LT pressure into proportional REVERSE throttle instead of the
 * service brake. Releasing LT (or pressing RT) returns to forward instantly.
 */
export const B2R_STATIONARY_V_MPS = 0.3;

/**
 * Raw LT demand (0..1, pre-gamma) at or above which brake-to-reverse engages
 * while stationary (Spec 19 §2.1.3: LT ≥ 0.15).
 */
export const B2R_ENGAGE_LT = 0.15;

/**
 * RT demand (0..1, pre-gamma) that vetoes brake-to-reverse while it is
 * engaged: a competing right-foot command means the driver wants forward.
 */
export const B2R_VETO_RT = 0.15;

/**
 * Consecutive idle frames a trigger axis must rest on its negative rail
 * (≤ −0.9 with buttons up and the left stick centred) before the client
 * latches it as a bipolar Linux/DirectInput trigger slider rather than a
 * misbehaving stick (Spec 19 §2.1.2).
 */
export const PAD_RAIL_REST_FRAMES = 8;

/** Emergency-brake haptic threshold: L2 demand at/above this reads as a panic stop. */
export const RUMBLE_EMERGENCY_BRAKE = 0.85;
/** Lateral slip haptic threshold (m/s of body-frame lateral velocity). */
export const RUMBLE_SLIP_VLAT = 2.0;
/** Launch/redline wheelspin cue: throttle demand at/above this low speed (m/s). */
export const RUMBLE_WHEELSPIN_THROTTLE = 0.6;
export const RUMBLE_WHEELSPIN_MAX_V = 6.0;
/** Throttle speed-fraction above which the redline hum hums (90 % of the limiter). */
export const RUMBLE_REDLINE_FRAC = 0.9;
/**
 * Minimum spacing between `playEffect` calls per pad (ms) — ABS pulses at
 * 15 Hz physically, and 40 ms is the shortest window the Gamepad Haptics API
 * guarantees, so the pump never floods the browser event loop.
 */
export const RUMBLE_MIN_INTERVAL_MS = 40;

/**
 * Standard-mapping axis slots (spec 14 §3.1): left stick X → strafe/steer,
 * left stick Y → throttle (inverted: raw up is negative), right stick X → yaw,
 * right stick Y → look pitch (Spec 19 §2.1.4).
 *
 * Spec 19 §2.1.2 adds the Linux/XInput/DirectInput trigger slots: on Linux
 * (xpad) and DirectInput pads the analog triggers report on `axes[4]` (LT)
 * and `axes[5]` (RT) — and some DirectInput pads double-map RT to `axes[2]`,
 * the standard right-stick-X slot. Axis 2 is therefore only trusted as a
 * trigger once rest-calibration has seen it parked off-centre.
 */
export const GAMEPAD_AXES: Readonly<{
  strafe: number;
  throttle: number;
  yaw: number;
  pitch: number;
  linuxLtTrigger: number;
  linuxRtTrigger: number;
  altTrigger: number;
}> = {
  strafe: 0,
  throttle: 1,
  yaw: 2,
  pitch: 3,
  linuxLtTrigger: 4,
  linuxRtTrigger: 5,
  altTrigger: 2,
};

/**
 * Standard-mapping button slots. `sprintLeft`/`sprintRight` are LB and L3 —
 * either thumb-spare button runs, since handhelds (GPD Win Max 2, Steam Deck)
 * differ on which is most reachable. Spec 19 §2.1.5 completes the action
 * sheet: RB mines, R3 cycles the camera, D-Pad Up toggles the comms log.
 */
export const GAMEPAD_BUTTONS: Readonly<{
  jump: number;
  trade: number;
  mount: number;
  headlight: number;
  mine: number;
  camera: number;
  brake: number;
  throttle: number;
  sprintLeft: number;
  sprintLeftAlt: number;
  comms: number;
}> = {
  jump: 0, // A (jump on foot / handbrake in the buggy)
  trade: 1, // B
  mount: 2, // X
  headlight: 3, // Y
  mine: 5, // RB (spec 19)
  brake: 6, // LT (analog value)
  throttle: 7, // RT (analog value)
  sprintLeft: 4, // LB
  sprintLeftAlt: 10, // L3
  camera: 11, // R3 (spec 19)
  comms: 12, // D-Pad Up (spec 19)
};

/** Buggy parks this far from the spawn collar, metres. */
export const BUGGY_PARK_OFFSET: readonly [number, number] = [9, 4];

/** Waypoint beacon column height (m) — tall enough to spot over crater rims. */
export const BEACON_HEIGHT_M = 18;

/** Beacon alpha pulse period (ms) — the "pulsing" in pulsing beacon. */
export const BEACON_PULSE_MS = 1400;

/**
 * Ordered onboarding progression (spec 14 §3.5). The HUD checklist row at
 * index *i* tracks `TUTORIAL_ORDER[i]`; `complete` is the terminal state
 * once every entry has fired.
 */
export const TUTORIAL_ORDER = ['move', 'scan', 'mine', 'buggy', 'trade'] as const;
export type TutorialProgressStep = (typeof TUTORIAL_ORDER)[number];
export type TutorialStep = TutorialProgressStep | 'complete';

/** Ground distance (m) that satisfies the locomotion step. */
export const TUTORIAL_MOVE_DISTANCE_M = 8;

/**
 * Single-frame displacements above this are teleports (server-authoritative
 * welcome spawn), not footsteps — they never count toward the move step.
 */
export const TUTORIAL_TELEPORT_GUARD_M = 25;

/** Key-sheet actions that fire once per key-down (spec 13 §1). */
export const ACTION_KEYS: Readonly<Record<string, string>> = {
  KeyE: 'mount',
  KeyF: 'headlight',
  KeyV: 'camera',
  KeyM: 'mine',
  KeyC: 'claim',
  KeyT: 'trade',
  // Spec 17 Phase 4: environment toggle — Earth Proving Grounds ⇄ Lunar.
  KeyR: 'track',
  // Spec 18 §6.2: comms log toggle — hide/re-open the last transmission.
  KeyL: 'comms',
  Escape: 'close-ui',
};

const EVA_CAMERA_CYCLE: readonly CameraMode[] = [
  'eva_first_person',
  'eva_third_person',
  'vehicle_chase',
];

/**
 * Generator vein kinds → the server's `ResourceType` vocabulary. The server
 * rejects unknown resources outright, so the client only ever asks for what
 * the wire supports (titanium ore is sold through the commodity market, not
 * the legacy resource ledger).
 */
const VEIN_KIND_TO_RESOURCE: Record<string, MiningResource> = {
  regolith: 'regolith',
  water_ice: 'water_ice',
  helium_3: 'helium3',
  rare_earth: 'rare_earths',
  titanium: 'regolith',
};

// ---------------------------------------------------------------------------
// Options & shapes
// ---------------------------------------------------------------------------

export type EnvironmentMode = 'lunar_frontier' | 'earth_proving_grounds';

export interface ClientAppOptions {
  /** World seed handed to `WorldScene`/`LunarWorldGenerator`. */
  seed?: string | number;
  /** Join identity (used when this app owns its NetworkClient). */
  username?: string;
  faction?: string;
  role?: string;
  /** Inject a prepared NetworkClient (tests / custom transports). */
  network?: NetworkClient | null;
  /** Explicit ws(s):// endpoint for an owned NetworkClient (spec 13 §6). */
  wsUrl?: string;
  /** Inject a prepared HUD (headless harnesses hand in a fake document). */
  hud?: LunarHUD | null;
  /** Set false to never build a HUD (even with a DOM present). */
  createHud?: boolean;
  /** Set false to skip connecting/joining an owned NetworkClient. */
  autoConnect?: boolean;
  /** Override the movement stream interval (ms). */
  moveIntervalMs?: number;
  /** Explicit spawn (physics frame); defaults to the world spawn point. */
  spawn?: { x: number; y: number };
  /** Skip console chatter in CI. */
  silent?: boolean;
  /** Terrain tuning passthrough. */
  terrainSize?: number;
  terrainResolution?: number;
  /**
   * Spec 17 Phase 4: start in Earth Proving Grounds track mode instead of
   * the Lunar Frontier surface (equivalent to calling
   * {@link ClientApp.enableProvingGrounds} right after `init()`).
   */
  startInProvingGrounds?: boolean;
  /**
   * Spec 18 §5: explicit quest storage backend (headless harnesses inject an
   * `InMemoryQuestStorage`; omitting it auto-detects localStorage with an
   * in-memory fallback).
   */
  questStorage?: QuestStorage;
  /**
   * Spec 18 §5: set false to boot WITHOUT the tutorial quest auto-starting
   * (the QuestEngine is still constructed and wired; QA can `startQuest()`
   * manually or restore a saved run).
   */
  startQuest?: boolean;
}

export interface ClientInputFrame {
  /** -1..1 forward (W/S, gamepad left-stick Y, or right trigger). */
  forward: number;
  /**
   * -1..1 strafe (A/D, gamepad left stick X). `+` is the ridden entity's
   * **right** — physics `strafe` drives the body-frame +y axis, which the
   * `worldToBabylon` + `rotation.y = PI/2 + heading` mapping puts on the
   * right side of the screen.
   */
  strafe: number;
  /**
   * -1..1 yaw steer (Arrow keys, gamepad right stick X). `+` increases
   * `heading`, i.e. turns clockwise / to the right as rendered.
   */
  yaw: number;
  /** -1..1 look pitch (Arrow up/down, gamepad right stick Y). */
  pitch: number;
  /** Shift held — run instead of walk on foot. */
  sprint: boolean;
  /** Space held — hop (physics tracks its own rising edge). */
  jump: boolean;
  /** 0..1 analog service brake (gamepad left trigger); 0 from the keyboard. */
  brake: number;
  /**
   * Spec 19 §2.1.3 brake-to-reverse: true while the rover is stopped/reversing
   * on a held LT — the LT pressure has been routed into `forward` as negative
   * demand and `brake` reads 0.
   */
  reverse: boolean;
}

/**
 * The structural slice of the Gamepad API this client consumes. Declaring it
 * locally (rather than leaning on lib.dom's `Gamepad`) keeps the headless
 * harness honest: `scripts/smoke-client-app.ts` hands in a plain object of
 * axes + buttons and the code below never touches a browser-only member.
 */
export interface GamepadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly value: number; readonly pressed: boolean }[];
  /**
   * Dual-rumble haptics (Spec 17 Phase 2): the structural slice of
   * `GamepadHapticActuator` the client calls. Optional and duck-typed — the
   * harness hands in a recorder, real pads hand in the browser actuator, and
   * pads without one (or a locked-down browser) simply never rumble.
   */
  readonly vibrationActuator?: {
    playEffect?(
      type: string,
      params: { startDelay: number; duration: number; weakMagnitude: number; strongMagnitude: number },
    ): unknown;
  } | null;
}

/** One dual-rumble frame handed to `GamepadHapticActuator.playEffect`. */
export interface RumbleEffect {
  startDelay: number;
  duration: number;
  weakMagnitude: number;
  strongMagnitude: number;
}

// ---------------------------------------------------------------------------
// Spec 17 Phase 2 — input shaping curves (pure, exported for the harness)
// ---------------------------------------------------------------------------

/**
 * Progressive analog throttle trigger (Spec 17 §2.3.1):
 * `f = R2^γ` with γ = 1.4. 0.5 → 0.3789 — torque builds progressively off
 * the bite instead of shocking the regolith into wheelspin.
 */
export function gamepadThrottleCurve(raw: number): number {
  const v = clamp(raw, 0, 1);
  return Math.pow(v, GAMEPAD_THROTTLE_GAMMA);
}

/**
 * Progressive service-brake trigger (Spec 17 §2.3.2 dual-stage):
 * `f = L2^γ` with γ = 0.8 — a soft bite stage for threshold modulation,
 * firming to full demand for the emergency stage.
 */
export function gamepadBrakeCurve(raw: number): number {
  const v = clamp(raw, 0, 1);
  return Math.pow(v, GAMEPAD_BRAKE_GAMMA);
}

/**
 * Exponential steering curve (Spec 17 §2.2.2):
 * `u = sign(x) · ((|x| − dz) / (1 − dz))^γ`, dz = 0.12, γ = 1.6. Dead-band
 * first, re-normalised to full scale, then eased so the centre feels precise
 * and the lock region progressive.
 */
export function gamepadSteerCurve(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  const sign = Math.sign(raw);
  const abs = clamp(Math.abs(raw), 0, 1);
  if (abs <= GAMEPAD_STEER_DEADZONE) return 0;
  const norm = (abs - GAMEPAD_STEER_DEADZONE) / (1 - GAMEPAD_STEER_DEADZONE);
  return sign * Math.pow(norm, GAMEPAD_STEER_GAMMA);
}

/**
 * Right-stick look curve (Spec 19 §2.1.4):
 * `u = sign(x) · ((|x| − 0.15) / (1 − 0.15))^1.5` — dead-band, re-normalise,
 * exponential ease so the neutral band never creeps the camera and full
 * deflection still reaches full pitch rate.
 */
export function gamepadLookCurve(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  const sign = Math.sign(raw);
  const abs = clamp(Math.abs(raw), 0, 1);
  if (abs <= GAMEPAD_LOOK_DEADZONE) return 0;
  const norm = (abs - GAMEPAD_LOOK_DEADZONE) / (1 - GAMEPAD_LOOK_DEADZONE);
  return sign * Math.pow(norm, GAMEPAD_LOOK_GAMMA);
}

/**
 * Map one physics frame of buggy telemetry to a dual-rumble effect, or null
 * for silence. Priority order (one effect per frame keeps the haptics API
 * from stacking over itself):
 *   1. ABS modulating          → strong pulse   (the pedal-kick the driver expects)
 *   2. emergency brake demand  → medium rumble  (panic stop building)
 *   3. lateral slip / skid     → weak pulse     (traction budget warning)
 *   4. launch wheelspin / redline → subtle short rumble (motor-overspeed tick)
 */
export function computeBuggyRumble(t: {
  absActive: boolean;
  brakeDemand: number;
  throttleDemand: number;
  speed: number;
  lateralSlip: number;
  speedLimit?: number;
}): RumbleEffect | null {
  const limit = t.speedLimit ?? BUGGY_SPEED_LIMIT;
  const speed = Math.abs(t.speed);
  if (t.absActive) {
    return { startDelay: 0, duration: 45, weakMagnitude: 0.45, strongMagnitude: 0.9 };
  }
  if (t.brakeDemand >= RUMBLE_EMERGENCY_BRAKE) {
    return { startDelay: 0, duration: 90, weakMagnitude: 0.5, strongMagnitude: 0.6 };
  }
  if (Math.abs(t.lateralSlip) >= RUMBLE_SLIP_VLAT) {
    return { startDelay: 0, duration: 70, weakMagnitude: 0.6, strongMagnitude: 0.05 };
  }
  const launching = t.throttleDemand >= RUMBLE_WHEELSPIN_THROTTLE && speed < RUMBLE_WHEELSPIN_MAX_V;
  const redline = speed >= limit * RUMBLE_REDLINE_FRAC;
  if (launching || redline) {
    return { startDelay: 0, duration: 30, weakMagnitude: 0.22, strongMagnitude: 0.0 };
  }
  return null;
}

/** Live remote puppet: physics is network-driven, meshes follow the render pos. */
export interface RemoteAvatar {
  id: string;
  kind: TravelMode;
  entity: EvaSuitAvatar | OpenBuggy;
  /** Last heading applied to the mesh (kept when velocity is ~zero). */
  heading: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Wrap degrees to [0, 360). */
function wrap360(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return ((deg % 360) + 360) % 360;
}

/** Wrap degrees to (-180, 180] — a relative bearing offset from heading. */
function wrap180(deg: number): number {
  const w = wrap360(deg);
  return w > 180 ? w - 360 : w;
}

/**
 * Compass bearing (degrees, 0 = North, clockwise) from one world-frame point
 * to another. World +y is North and physics heading θ runs counter-clockwise
 * from +x, so bearing = 90° − θ (planar delta only — the z component is
 * irrelevant to a bearing tape).
 */
function compassBearingDeg(
  from: { x: number; y: number },
  to: { x: number; y: number },
): number {
  const theta = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  return wrap360(90 - theta);
}

// ---------------------------------------------------------------------------
// ClientApp
// ---------------------------------------------------------------------------

export class ClientApp {
  /** The 3D world (constructed eagerly, initialised in `init()`). */
  readonly world: WorldScene;

  private readonly options: ClientAppOptions;
  private readonly moveInterval: number;

  private network: NetworkClient | null;
  private hud: LunarHUD | null;
  private readonly ownsNetwork: boolean;

  /**
   * Spec 18 §5/§7 — narrative quest layer: the staged quest state machine,
   * the 3D hint-arrow visual, and the last comms burst (for the [L] log
   * toggle). Built in `init()`; the quest ships with populated world
   * coordinates (perimeter beacon, mineral vein, buggy spawn, trade
   * terminal) resolved from the live world snapshot.
   */
  private questEngine: QuestEngine | null = null;
  private hintArrowSystem: HintArrowSystem | null = null;
  private lastComms: CommsDialogue | null = null;
  /** Quest reward credited (Spec 18 §5 Stage 5: 500 cr) — harness readback. */
  private questRewardCredits = 0;
  /** Per-frame locomotion accumulators feeding `recordMoveDistance` (m). */
  private questFootPrev: { x: number; y: number } | null = null;
  private questBuggyPrev: { x: number; y: number } | null = null;
  /** Frame counter for the ~10 Hz buggy-dash quest mirror (60 Hz / 6). */
  private questDashFrame = 0;
  /** Teleport guard (same rule as the legacy tutorial): >25 m ≠ footstep. */
  private static readonly QUEST_TELEPORT_GUARD_M = 25;

  private suit: EvaSuitAvatar | null = null;
  private buggy: OpenBuggy | null = null;
  private traversal: TraversalController | null = null;

  private mode: TravelMode = 'suit';
  /** EVA camera mode to restore when dismounting the buggy. */
  private lastEvaCamera: CameraMode = 'eva_first_person';

  private readonly pressed = new Set<string>();

  /**
   * Gamepad rising-edge bookkeeping (spec 14 §3.1): `sampleInput()` stashes
   * the raw frame snapshot, `pumpGamepadActions()` compares it against the
   * previous frame and fires X/Y/B once per press.
   */
  private prevGamepadButtons: boolean[] = [];
  private lastGamepadButtons: boolean[] = [];

  /**
   * Spec 19 §2.1.1 / ADR-1 active-pad slot: the pad demonstrator of the most
   * recent above-deadband activity. `pollGamepad()` scans every connected
   * device each frame and re-locks onto whichever one is moving, so phantom
   * or virtual devices parked at index 0 never swallow the real controller's
   * input. Falls back to this slot while every pad reads neutral.
   */
  private activeGamepadIndex = -1;

  /**
   * Per-pad trigger rest calibration (Spec 19 §2.1.2): Linux xpad and
   * DirectInput report analog triggers on bipolar axes resting at −1
   * (xpad's axes[4]/axes[5]; some DirectInput pads park RT on axes[2]).
   * An axis observed parked on its negative rail is flagged and remapped
   * [−1, +1] → [0, 1]; unflagged axes read standard unipolar (negative
   * travel = released). `altRt` additionally suppresses the right-stick-yaw
   * reading of axes[2] — it is a trigger slider on that pad, not a stick —
   * and `pitchRail` suppresses look-pitch on axes[3]. Keyed by pad OBJECT
   * (WeakMap), not slot index: a driver hot-swapping controllers mid-run
   * keeps calibration on the device that earned it, and a phantom device
   * re-appearing in a slot never inherits its predecessor's profile.
   */
  private readonly padProfiles = new WeakMap<
    object,
    { ltBipolar: boolean; rtBipolar: boolean; altRt: boolean; pitchRail: boolean }
  >();

  /**
   * Per-pad, per-axis consecutive idle-rail frames driving the latch above
   * (slot order: axes 2, 3, 4, 5). {@link PAD_RAIL_REST_FRAMES} frames of
   * rail rest (with buttons up and the left stick centred) confirm a slider.
   */
  private readonly padRailStreaks = new WeakMap<object, number[]>();

  /**
   * Spec 19 §2.1.6: which device last produced input. `sampleInput()` flips
   * this to `'gamepad'` on any above-deadband pad activity and `'keyboard'`
   * on any latched key; the HUD prompt glyphs follow it.
   */
  private inputSource: 'keyboard' | 'gamepad' = 'keyboard';

  /**
   * Spec 19 §2.1.3 / ADR-2 brake-to-reverse latched state (buggy only).
   * Engaged at |v| ≤ {@link B2R_STATIONARY_V_MPS} with LT ≥
   * {@link B2R_ENGAGE_LT}; released the moment LT falls away or RT competes.
   */
  private reverseEngaged = false;

  /**
   * Spec 17 Phase 2 anti-jerk trigger filter: the gamma-shaped R2/L2 demand
   * smoothed per physics frame so launches and panic modulations ramp
   * continuously instead of stepping. Owned by `stepEntities()` (one advance
   * per frame — `sampleInput()` stays a stateless query).
   */
  private filteredThrottle = 0;
  private filteredBrake = 0;

  /** Frame-driven haptic clock (ms) + last `playEffect` timestamp (rate limit). */
  private rumbleClockMs = 0;
  private lastRumbleAt = Number.NEGATIVE_INFINITY;

  /**
   * Gamma-shaped trigger demands from the latest `sampleInput()` (pre-filter
   * driver intent). The haptic pump reads the emergency-brake and launch
   * thresholds off these; physics consumes the anti-jerk-filtered copies.
   */
  private lastThrottleDemand = 0;
  private lastBrakeDemand = 0;

  private lastFrameAt: number | null = null;
  private moveAccumulatorMs = 0;
  private lastScanAt: number | null = null;
  private lastMineAt = -Infinity;
  private pendingTrades = 0;

  private readonly remotes = new Map<string, RemoteAvatar>();
  private readonly claimMarkers = new Map<string, Mesh>();
  private factionBases: FactionBases | null = null;
  private tunnelNetwork: TunnelNetwork | null = null;
  private railSystem: RailSystem | null = null;
  /** Spec 17 Phase 4: Earth track environment (built on first enable). */
  private provingGrounds: ProvingGroundsScene | null = null;
  /** Active environment: lunar surface vs. Earth proving grounds. */
  private envMode: EnvironmentMode = 'lunar_frontier';
  /** Terrain mesh hidden (not disposed) while the track mode is active. */
  private lunarTerrainHidden = false;
  private buggyBeacon: Mesh | null = null;
  private baseBeacon: Mesh | null = null;
  private veinBeacon: Mesh | null = null;
  /** Beacon materials, pulsed every frame (alpha sine — spec 14 §3.4). */
  private readonly beaconMaterials = new Map<string, StandardMaterial>();

  /**
   * Onboarding state machine (spec 14 §3.5): a step is done once its trigger
   * has fired; `firstIncomplete()` is the active step shown by the HUD.
   */
  private readonly tutorialDone = new Set<TutorialProgressStep>();
  private tutorialWasAirborne = false;
  private tutorialHopped = false;
  private tutorialTravelM = 0;
  private tutorialPrevPos: { x: number; y: number } = { x: 0, y: 0 };

  private scannerReadout: HudScannerReadout = { found: false, message: 'SCANNING…' };
  private nearestVein: ResourceVein | null = null;
  private nearestVeinRangeM: number | null = null;
  /** Long-range nav target (TASK-PLAY-063c) — best vein within NAV_SCAN_RANGE_M. */
  private navVein: ResourceVein | null = null;
  private navVeinRangeM: number | null = null;

  private started = false;
  private initialized = false;
  private disposed = false;
  private domAttached = false;

  /** Scratch vector for remote-avatar placement (no per-frame allocation). */
  private readonly scratch = new Vector3(0, 0, 0);

  constructor(options: ClientAppOptions = {}) {
    this.options = options;
    this.moveInterval = Math.max(10, options.moveIntervalMs ?? MOVE_INTERVAL_MS);
    this.world = new WorldScene({
      seed: options.seed ?? 'mala-voyage-2431',
      ...(options.terrainSize !== undefined ? { terrainSize: options.terrainSize } : {}),
      ...(options.terrainResolution !== undefined
        ? { terrainResolution: options.terrainResolution }
        : {}),
      silent: options.silent ?? false,
    });
    this.network = options.network ?? null;
    this.ownsNetwork = options.network === undefined && options.autoConnect !== false;
    if (this.network === null && this.ownsNetwork) {
      // Owned client: constructed here, connected in `init()` (endpoint comes
      // from options.wsUrl, else WS_URL / location.host per spec 13 §6).
      this.network =
        options.wsUrl !== undefined && options.wsUrl.length > 0
          ? new NetworkClient({ url: options.wsUrl })
          : new NetworkClient();
    }
    this.hud = options.hud ?? null;
  }

  // -- lifecycle ----------------------------------------------------------------

  /**
   * Boot the stack: engine + scene, local entities, traversal graph, HUD,
   * network wiring, DOM input. `canvasOrEngine` accepts a canvas (browser)
   * or a raw Babylon engine such as `NullEngine` (CI); omitted falls through
   * to WorldScene's own headless fallback.
   */
  async init(canvasOrEngine?: unknown): Promise<this> {
    if (this.disposed) throw new Error('ClientApp: init() after dispose()');
    if (this.initialized) return this;

    this.world.init(canvasOrEngine as never);

    const ground: GroundElevationFn = (x, y) => this.groundAt(x, y);
    const scene = this.world.getScene();
    const spawn = this.resolveSpawn();
    this.tutorialPrevPos = { x: spawn.x, y: spawn.y };

    this.suit = new EvaSuitAvatar({
      groundElevation: ground,
      headlight: true,
      namePrefix: 'eva-local',
      initial: { x: spawn.x, y: spawn.y, z: ground(spawn.x, spawn.y) },
    }).init(scene);

    const [bx, by] = BUGGY_PARK_OFFSET;
    this.buggy = new OpenBuggy({
      groundElevation: ground,
      namePrefix: 'buggy-local',
      x: spawn.x + bx,
      y: spawn.y + by,
      heading: 0,
      headlights: true,
    }).init(scene);

    const snapshot = this.world.getSnapshot();
    if (snapshot !== null) {
      // Infrastructure layer (spec 14 §3.3): faction bases, tunnel network,
      // and rail system are built from the generated world snapshot — never
      // invented client-side.
      this.factionBases = new FactionBases(snapshot).init(scene);
      this.tunnelNetwork = new TunnelNetwork(snapshot).init(scene);
      this.railSystem = new RailSystem(snapshot).init(scene);
    }
    this.traversal =
      snapshot !== null
        ? TraversalController.fromSnapshot(snapshot, { startAt: { x: spawn.x, y: spawn.y } })
        : new TraversalController({
            id: 'origin',
            kind: 'junction',
            name: 'Origin',
            position: { x: spawn.x, y: spawn.y, z: 0 },
            links: [],
          });

    // Shadow casters (spec 14 §3.3): local entities and base furniture drop
    // crisp vacuum shadows; registration is idempotent and a no-op when the
    // shadow generator is disabled.
    this.world.registerShadowCasters(this.suit.getMeshes());
    this.world.registerShadowCasters(this.buggy.getMeshes());
    if (this.factionBases !== null) {
      this.world.registerShadowCasters(this.factionBases.getMeshes());
    }

    // Waypoint beacons (spec 14 §3.4): translucent pulsing columns over the
    // three navigation targets. The vein beacon starts disabled — it lights
    // only while the scanner holds a lock.
    this.buggyBeacon = this.buildBeacon('buggy', 0x56 / 255, 0xe0 / 255, 1, this.buggy.getPosition());
    const homeBase = this.nearestBaseTo({ x: spawn.x, y: spawn.y });
    if (homeBase !== null) {
      this.baseBeacon = this.buildBeacon('base', 1, 0xcc / 255, 0x55 / 255, homeBase.position);
    }
    this.veinBeacon = this.buildBeacon('vein', 0x5c / 255, 0xe6 / 255, 0xa4 / 255, { x: spawn.x, y: spawn.y, z: 0 });
    this.veinBeacon.setEnabled(false);

    if (this.hud === null && this.options.createHud !== false) {
      // Browser (or harness with an injected global document) gets the DOM
      // overlay; a headless run without any document simply runs bare.
      const doc = (globalThis as { document?: Document }).document;
      if (doc !== undefined && doc !== null) {
        this.hud = new LunarHUD({
          document: doc,
          onTrade: (request) => this.submitTrade(request),
        });
      }
    }

    // Spec 18 §5/§7 — narrative quest layer. The tutorial quest ships with
    // populated world coordinates: the survey-beacon perimeter (spawn), the
    // nearest surveyed mineral vein, the parked buggy, and the faction
    // exchange terminal (nearest faction base). The hint arrow renders the
    // active objective in 3D / on the screen edge; quest callbacks drive the
    // comms terminal and the mission checklist.
    this.questEngine = new QuestEngine({
      ...(this.options.questStorage !== undefined
        ? { storage: this.options.questStorage }
        : {}),
      ...(this.options.startQuest === false ? { autosave: false } : {}),
    });
    this.questEngine.onCommsReceived((dialogue) => {
      this.lastComms = dialogue;
      this.hud?.showComms(dialogue);
    });
    this.questEngine.onObjectiveUpdated(() => this.pushQuestStageToHud());
    this.questEngine.onStageAdvanced(() => {
      this.pushQuestStageToHud();
      this.syncQuestDashboardTelemetry();
    });
    this.questEngine.onQuestCompleted((payload: QuestCompletedPayload) => {
      this.questRewardCredits = payload.rewardCredits;
      this.hud?.showFeedback(
        `QUEST COMPLETE · +${payload.rewardCredits} cr · +${payload.rewardXp} xp`,
        'success',
      );
      this.pushQuestStageToHud();
    });
    this.hintArrowSystem = new HintArrowSystem({
      scene: this.world.getScene(),
      onHudUpdate: (payload) => this.hud?.updateHintArrow(payload),
    });
    if (this.options.startQuest !== false) {
      this.questEngine.startQuest(
        createTutorialQuest({
          faction: this.options.faction ?? 'CEC',
          spawnPosition: { x: spawn.x, y: spawn.y, z: this.groundAt(spawn.x, spawn.y) },
          veinPosition: this.veinAnchorFor(spawn.x, spawn.y) ?? {
            x: spawn.x,
            y: spawn.y + 45,
            z: this.groundAt(spawn.x, spawn.y + 45),
          },
          buggyPosition: (() => {
            const b = this.buggy?.getPosition() ?? { x: spawn.x + 9, y: spawn.y + 4, z: 0 };
            return { x: b.x, y: b.y, z: b.z };
          })(),
          terminalPosition: this.nearestBaseTo({ x: spawn.x, y: spawn.y })?.position ?? {
            x: spawn.x - 60,
            y: spawn.y - 80,
            z: this.groundAt(spawn.x - 60, spawn.y - 80),
          },
          buggyEntityId: 'buggy-local',
        }),
      );
    }
    this.questFootPrev = { x: spawn.x, y: spawn.y };
    this.questBuggyPrev = null;
    this.pushQuestStageToHud();

    this.wireNetwork();
    this.attachDomInput();

    if (this.ownsNetwork && this.network !== null) {
      // Fire-and-forget: the `connected` handler performs the JOIN. A failed
      // first connect leaves the client's own backoff retrying.
      void this.network.connect().catch(() => undefined);
    }

    this.initialized = true;
    if (this.options.startInProvingGrounds === true) {
      // Spec 17 Phase 4: cold-start straight into the Earth track environment.
      this.enableProvingGrounds();
    }
    this.hudSay('surface suit');
    this.hud?.setConnection(this.network?.state ?? 'offline');
    this.refreshTutorialHud();
    if (this.network === null && !this.ownsNetwork) {
      this.log('no NetworkClient injected or owned — running single-player');
    }
    return this;
  }

  /**
   * Drive the app from `requestAnimationFrame` (browser) or a manual clock
   * (headless). One call == one frame: physics → camera → move-stream →
   * network interpolation → remote meshes → HUD.
   */
  update(timestamp: number = this.nowMs()): void {
    if (this.disposed || !this.initialized) return;
    if (this.lastFrameAt === null) this.lastFrameAt = timestamp;
    const dt = clamp((timestamp - this.lastFrameAt) / 1000, 0, 0.25);
    this.lastFrameAt = timestamp;

    // Gamepad hotkey edges run before the physics step so an X-press mounts
    // this frame rather than the next (stepEntities → sampleInput refreshes
    // the button snapshot for the following frame).
    this.pumpGamepadActions();
    this.stepEntities(dt);
    // Spec 17 Phase 4: step the circuit lap-timing state machine with the
    // freshly stepped buggy pose and repaint the lap HUD panel.
    this.pumpLapTiming(dt);
    this.syncCamera(dt);
    this.pumpMoveStream(dt);
    // Clock-domain rule (ADR-013-2): NetworkClient interpolates against the
    // SAME clock it stamps snapshots with (its own `options.clock`, default
    // Date.now). Passing this frame's timestamp here would mix domains —
    // `nowMs()` is performance.now()-based in browsers — and the resulting
    // negative `since` extrapolates remote avatars to astronomical positions.
    this.network?.update();
    this.syncRemoteAvatars();
    this.refreshScanner(timestamp);
    this.updateTutorialSensors();
    // Spec 18 §7 — quest sensors (foot/drive odometers + reach probes) run
    // after physics & camera sync so positions, positions-of-record and the
    // hint-arrow projection all consume this frame's state.
    this.updateQuestSensors();
    this.refreshHintArrow(timestamp);
    this.refreshWaypoints(timestamp);
    this.refreshHud();
    this.world.render();
  }

  /** Start the engine render loop feeding `update()`. Idempotent. */
  run(): this {
    if (this.disposed || !this.initialized || this.started) return this;
    this.started = true;
    this.world.getEngine().runRenderLoop(() => this.update(this.nowMs()));
    this.log('client render loop running');
    return this;
  }

  /** Stop the render loop (keeping everything else alive; `run()` resumes). */
  stop(): this {
    if (this.disposed || !this.initialized) return this;
    this.started = false;
    try {
      this.world.getEngine().stopRenderLoop();
    } catch {
      /* engine already gone */
    }
    return this;
  }

  /** Resize the engine backbuffer to its canvas (browser window-resize hook). */
  resize(): void {
    if (this.disposed || !this.initialized) return;
    try {
      this.world.getEngine().resize();
    } catch {
      /* headless engines have nothing to resize */
    }
  }

  // -- proving grounds track mode (Spec 17 Phase 4) --------------------------------

  /**
   * Switch into the Earth Proving Grounds environment (Spec 17 §3/§5):
   * builds the ~1,200 m circuit (lazily, once), hides the lunar terrain,
   * warps the buggy onto the start/finish line, flips the physics profile
   * to `ENV_EARTH_PROVING_GROUNDS` (1 g asphalt), and shows the lap-timing
   * HUD. Idempotent. The reverse is {@link disableProvingGrounds}.
   */
  enableProvingGrounds(): this {
    if (this.disposed || !this.initialized) return this;
    if (this.envMode === 'earth_proving_grounds') return this;

    if (this.provingGrounds === null) {
      this.provingGrounds = new ProvingGroundsScene({
        standaloneAtmosphere: false,
        silent: this.options.silent ?? false,
      }).init(this.world.getScene());
    }

    // Hide (not dispose) the lunar terrain + sky furniture so the track
    // reads as a self-contained Earth site; restoring restores them.
    const terrain = this.world.getTerrainMesh();
    if (terrain !== null) {
      terrain.setEnabled(false);
      this.lunarTerrainHidden = true;
    }

    // Warp the buggy onto the start/finish line, at rest, facing forward —
    // through the physics state itself (the single source of truth), using
    // the duck-typed access pattern established by the smoke harnesses.
    const seat = this.requireBuggy().physics as unknown as {
      state: {
        x: number; y: number; z: number; heading: number;
        vLong: number; vLat: number; vBody: number; yawRate: number;
        roll: number; pitch: number; airborne: boolean; rolled: boolean;
      };
    };
    const pose = this.provingGrounds.getStartPose();
    const st = seat.state;
    st.x = pose.x;
    st.y = pose.y;
    st.z = pose.z + 0.45;
    st.heading = pose.headingRad;
    st.vLong = 0;
    st.vLat = 0;
    st.vBody = 0;
    st.yawRate = 0;
    st.roll = 0;
    st.pitch = 0;
    st.airborne = false;
    st.rolled = false;

    // Terrestrial gravity + asphalt (Spec 17 §2.1) from the next substep.
    this.requireBuggy().physics.setEnvironment(ENV_EARTH_PROVING_GROUNDS);
    // Zero-dt update: refreshes the entity's cached state snapshot + mesh
    // transform without stepping physics (dt 0 executes no substeps).
    this.requireBuggy().update(0);

    this.provingGrounds.resetLapTiming();
    this.envMode = 'earth_proving_grounds';
    this.hud?.setLapPanelVisible(true);
    this.log('proving grounds: track mode live (earth gravity, lap timer armed)');
    return this;
  }

  /**
   * Switch back to the Lunar Frontier surface environment: restore the
   * terrain, put the buggy back on the lunar datum under lunar gravity, and
   * hide the lap-timing HUD. The circuit itself stays built (cheap toggle).
   */
  disableProvingGrounds(): this {
    if (this.disposed || !this.initialized) return this;
    if (this.envMode !== 'earth_proving_grounds') return this;
    this.envMode = 'lunar_frontier';

    const terrain = this.world.getTerrainMesh();
    if (terrain !== null && this.lunarTerrainHidden) {
      terrain.setEnabled(true);
      this.lunarTerrainHidden = false;
    }

    const spawn = this.resolveSpawn();
    const seat = this.requireBuggy().physics as unknown as {
      state: {
        x: number; y: number; z: number; heading: number;
        vLong: number; vLat: number; vBody: number; yawRate: number;
        roll: number; pitch: number; airborne: boolean; rolled: boolean;
      };
    };
    const st = seat.state;
    const [bx, by] = BUGGY_PARK_OFFSET;
    st.x = spawn.x + bx;
    st.y = spawn.y + by;
    st.z = this.world.getGroundHeightAt(st.x, st.y) + 0.45;
    st.heading = 0;
    st.vLong = 0;
    st.vLat = 0;
    st.vBody = 0;
    st.yawRate = 0;
    st.roll = 0;
    st.pitch = 0;
    st.airborne = false;
    st.rolled = false;

    // Restore the lunar preset (gravity 1.62, regolith μ, vacuum).
    this.requireBuggy().physics.setEnvironment(ENV_LUNAR_FRONTIER);
    this.requireBuggy().update(0);
    this.hud?.setLapPanelVisible(false);
    this.log('proving grounds: back on the lunar surface');
    return this;
  }

  /** Which environment the buggy is currently simulated in. */
  getEnvironmentMode(): EnvironmentMode {
    return this.envMode;
  }

  /** The track mode telemetry stream (null while lunar mode is active). */
  getLapTelemetry(): LapTelemetry | null {
    return this.envMode === 'earth_proving_grounds'
      ? this.provingGrounds?.getLapTelemetry() ?? null
      : null;
  }

  /** The built circuit (null until either mode method has built it). */
  getProvingGrounds(): ProvingGroundsScene | null {
    return this.provingGrounds;
  }

  /**
   * Ground the entities ride: the track surface in proving-grounds mode,
   * the lunar heightfield otherwise. Both buggy and suit read elevation
   * through this single seam.
   */
  private groundAt(x: number, y: number): number {
    if (this.envMode === 'earth_proving_grounds' && this.provingGrounds !== null) {
      return this.provingGrounds.getTrackElevation(x, y);
    }
    return this.world.getGroundHeightAt(x, y);
  }

  /**
   * Per-frame lap-timing pump: step the circuit's state machine with the
   * buggy's live pose/speed and push the snapshot to the HUD.
   */
  private pumpLapTiming(dt: number): void {
    if (this.envMode !== 'earth_proving_grounds' || this.provingGrounds === null) return;
    const buggy = this.requireBuggy();
    const p = buggy.getPosition();
    const telemetry = this.provingGrounds.stepLapTiming(dt, p.x, p.y, buggy.getSpeed());
    this.hud?.updateLapTelemetry(telemetry);
  }

  /** Full teardown: entities, world, network, HUD, DOM listeners. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.detachDomInput();

    for (const remote of this.remotes.values()) remote.entity.dispose();
    this.remotes.clear();

    if (this.network !== null) {
      if (this.ownsNetwork) this.network.destroy();
    }
    this.network = null;

    for (const marker of this.claimMarkers.values()) {
      try {
        marker.material?.dispose();
        marker.dispose();
      } catch {
        /* world already gone */
      }
    }
    this.claimMarkers.clear();

    for (const beacon of [this.buggyBeacon, this.baseBeacon, this.veinBeacon]) {
      try {
        beacon?.material?.dispose();
        beacon?.dispose();
      } catch {
        /* world already gone */
      }
    }
    this.buggyBeacon = null;
    this.baseBeacon = null;
    this.veinBeacon = null;
    this.beaconMaterials.clear();

    this.suit?.dispose();
    this.buggy?.dispose();
    this.suit = null;
    this.buggy = null;
    // Spec 18 quest layer teardown: the hint-arrow meshes live in the world
    // scene; the engine is pure state. Both idempotent.
    this.hintArrowSystem?.dispose();
    this.hintArrowSystem = null;
    this.questEngine = null;
    this.lastComms = null;
    // Infrastructure teardown before the world itself goes away (their meshes
    // live in the world scene; dispose() unparents and releases materials).
    this.factionBases?.dispose();
    this.tunnelNetwork?.dispose();
    this.railSystem?.dispose();
    this.factionBases = null;
    this.tunnelNetwork = null;
    this.railSystem = null;
    // Track mode teardown (meshes live in the world scene; its own dispose
    // unparents them — idempotent even after the world is gone).
    this.provingGrounds?.dispose();
    this.provingGrounds = null;
    this.world.dispose();
    this.hud?.dispose();
    this.hud = null;
  }

  // -- accessors ------------------------------------------------------------------

  getSuit(): EvaSuitAvatar {
    return this.requireSuit();
  }

  getBuggy(): OpenBuggy {
    return this.requireBuggy();
  }

  getHud(): LunarHUD | null {
    return this.hud;
  }

  getNetwork(): NetworkClient | null {
    return this.network;
  }

  getTraversal(): TraversalController | null {
    return this.traversal;
  }

  /** Faction base assemblies, or null before `init()`/without a snapshot. */
  getFactionBases(): FactionBases | null {
    return this.factionBases;
  }

  /** Tunnel network assembly, or null before `init()`/without a snapshot. */
  getTunnelNetwork(): TunnelNetwork | null {
    return this.tunnelNetwork;
  }

  /** Rail system assembly, or null before `init()`/without a snapshot. */
  getRailSystem(): RailSystem | null {
    return this.railSystem;
  }

  isMounted(): boolean {
    return this.mode === 'buggy';
  }

  /** Which entity the local player currently drives. */
  getMode(): TravelMode {
    return this.mode;
  }

  isRunning(): boolean {
    return this.started;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  remoteAvatarCount(): number {
    return this.remotes.size;
  }

  getRemoteAvatar(id: string): RemoteAvatar | undefined {
    return this.remotes.get(id);
  }

  /** Current scanner panel content (last computed readout). */
  getScannerReadout(): HudScannerReadout {
    return this.scannerReadout;
  }

  /** Closest vein to the active entity, or null when nothing is in range. */
  getNearestVein(): { vein: ResourceVein; rangeM: number } | null {
    if (this.nearestVein === null || this.nearestVeinRangeM === null) return null;
    return { vein: this.nearestVein, rangeM: this.nearestVeinRangeM };
  }

  /**
   * Long-range nav target (TASK-PLAY-063c): nearest non-regolith vein within
   * NAV_SCAN_RANGE_M, falling back to the nearest regolith; null when nothing
   * qualifies.
   */
  getNavVein(): { vein: ResourceVein; rangeM: number } | null {
    return this.navVein !== null && this.navVeinRangeM !== null
      ? { vein: this.navVein, rangeM: this.navVeinRangeM }
      : null;
  }

  /** The frame the movement stream would send right now. */
  currentMoveState() {
    return this.buildMoveState();
  }

  /**
   * Spec 19 §2.1.6: the device that produced the most recent input — drives
   * the HUD's `[E]` vs `(X)` prompt glyph choice.
   */
  getInputSource(): 'keyboard' | 'gamepad' {
    return this.inputSource;
  }

  /** Active gamepad slot from the last scan (−1 = none). */
  getActiveGamepadIndex(): number {
    return this.activeGamepadIndex;
  }

  /** Spec 19 §2.1.3: whether brake-to-reverse currently drives the buggy. */
  isReverseEngaged(): boolean {
    return this.reverseEngaged;
  }

  // -- input ------------------------------------------------------------------------

  /**
   * Inject one key event (also what the DOM listeners call). Movement keys
   * latch into the held set; action keys fire once on down. Returns true
   * when the key belongs to the client (useful for `preventDefault`).
   */
  handleKeyInput(code: string, phase: 'down' | 'up'): boolean {
    if (this.disposed || typeof code !== 'string') return false;
    if (!this.initialized) return false;
    const tradeOpen = this.hud?.isTradeDialogOpen() ?? false;

    if (code === 'Escape') {
      if (phase === 'down') {
        if (tradeOpen) this.hud?.hideTradeDialog();
        else this.hud?.clearPrompts();
      }
      return true;
    }

    // While the trade terminal is open the page-level keys are parked —
    // typing "REGOLITH" into the commodity select must not drive the suit.
    if (tradeOpen) return false;

    if (phase === 'up') {
      this.pressed.delete(code);
      return true;
    }

    const action = ACTION_KEYS[code];
    if (action !== undefined) {
      this.runAction(action);
      return true;
    }

    switch (code) {
      case 'KeyW':
      case 'KeyS':
      case 'KeyA':
      case 'KeyD':
      case 'Space':
      case 'ShiftLeft':
      case 'ShiftRight':
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        this.pressed.add(code);
        return true;
      default:
        return false;
    }
  }

  /**
   * Poll held keys + gamepad into one movement frame (public for tests).
   * Keyboard is digital; the gamepad adds analog axes on top (a stick inside
   * {@link GAMEPAD_DEADZONE} reads as centred, so the two never fight). The
   * pad's raw button snapshot is stashed for {@link pumpGamepadActions},
   * which owns rising-edge detection.
   *
   * Spec 19 additions (all idempotent — calling twice in a frame with the
   * same pad state yields the same result, so the harness may still sample
   * freely): active-pad re-locking + trigger rest-calibration (per-pad),
   * right-stick look pitch, brake-to-reverse latch (buggy), and the
   * keyboard-vs-gamepad input-source flip.
   */
  sampleInput(): ClientInputFrame {
    const p = this.pressed;
    // Right = +1, left = -1: physics `strafe` drives body-frame +y, which the
    // render mapping (worldToBabylon + rotation.y = PI/2 + heading) shows on
    // the right (spec 14 §3.1 — rectifies the old inverted A/D).
    // In buggy mode, ArrowUp/ArrowDown drive forward/reverse and ArrowLeft/ArrowRight steer.
    const keyForward = this.mode === 'buggy'
      ? (p.has('KeyW') || p.has('ArrowUp') ? 1 : 0) - (p.has('KeyS') || p.has('ArrowDown') ? 1 : 0)
      : (p.has('KeyW') ? 1 : 0) - (p.has('KeyS') ? 1 : 0);
    const keyStrafe = this.mode === 'buggy'
      ? (p.has('KeyD') || p.has('ArrowRight') ? 1 : 0) - (p.has('KeyA') || p.has('ArrowLeft') ? 1 : 0)
      : (p.has('KeyD') ? 1 : 0) - (p.has('KeyA') ? 1 : 0);
    // Right/ArrowRight increases heading = clockwise turn (spec 14 §3.1).
    const keyYaw = (p.has('ArrowRight') ? 1 : 0) - (p.has('ArrowLeft') ? 1 : 0);
    const keyPitch = (p.has('ArrowUp') ? 1 : 0) - (p.has('ArrowDown') ? 1 : 0);
    if (p.size > 0) this.inputSource = 'keyboard';

    const frame: ClientInputFrame = {
      forward: keyForward,
      strafe: keyStrafe,
      yaw: keyYaw,
      pitch: keyPitch,
      sprint: p.has('ShiftLeft') || p.has('ShiftRight'),
      jump: p.has('Space'),
      brake: 0,
      reverse: false,
    };

    // Poll the pad unconditionally so `pumpGamepadActions()` always has this
    // frame's button snapshot; while the trade terminal is parked the analog
    // axes sleep with the page keys (B still closes via the edge pump).
    const pad = this.pollGamepad();
    this.lastGamepadButtons = pad === null ? [] : pad.buttons.map((b) => b.pressed);
    if (pad === null || (this.hud?.isTradeDialogOpen() ?? false)) {
      // Pad asleep (or absent): no driver demand, no haptic cue, no reverse.
      this.lastThrottleDemand = 0;
      this.lastBrakeDemand = 0;
      this.reverseEngaged = false;
      return frame;
    }
    // Spec 19 §2.1.2 rest-calibration runs before this frame's profile read
    // so a slider that completed its rail streak on the previous frame takes
    // effect immediately.
    this.calibratePadTriggers(pad);
    const profile = this.padProfiles.get(pad);

    const rawAxis = (index: number): number => {
      const v = pad.axes[index];
      if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
      return clamp(v, -1, 1);
    };
    const axis = (index: number): number => {
      const v = rawAxis(index);
      return Math.abs(v) <= GAMEPAD_DEADZONE ? 0 : v;
    };
    const buttonValue = (index: number): number => {
      const v = pad.buttons[index]?.value;
      if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
      return clamp(v, 0, 1);
    };
    // Spec 19 §2.1.2 normalisation: a trigger axis whose rest was calibrated
    // on the negative rail (Linux xpad parks LT/RT at −1 when released) is
    // remapped [−1, +1] → [0, 1]; otherwise standard unipolar travel applies.
    const triggerFromAxis = (index: number, bipolar: boolean | undefined): number => {
      const v = rawAxis(index);
      return bipolar ? clamp((v + 1) / 2, 0, 1) : clamp(v, 0, 1);
    };

    // Spec 19 §2.1.2: RT spans buttons[7].value, axes[5] AND (calibrated
    // DirectInput pads) axes[2]; LT spans buttons[6].value and axes[4].
    const rawThrottleTrigger = Math.max(
      buttonValue(GAMEPAD_BUTTONS.throttle),
      triggerFromAxis(GAMEPAD_AXES.linuxRtTrigger, profile?.rtBipolar),
      profile?.altRt === true ? triggerFromAxis(GAMEPAD_AXES.altTrigger, true) : 0,
    );
    const rawBrakeTrigger = Math.max(
      buttonValue(GAMEPAD_BUTTONS.brake),
      triggerFromAxis(GAMEPAD_AXES.linuxLtTrigger, profile?.ltBipolar),
    );

    // Spec 19 §2.1.6: any above-deadband pad command claims the HUD glyphs.
    // Rail-parked pseudo-axes (calibrated sliders) never count as activity.
    const stickActivity =
      Math.abs(rawAxis(GAMEPAD_AXES.strafe)) > GAMEPAD_DEADZONE ||
      Math.abs(rawAxis(GAMEPAD_AXES.throttle)) > GAMEPAD_DEADZONE ||
      (profile?.altRt !== true && Math.abs(rawAxis(GAMEPAD_AXES.yaw)) > GAMEPAD_DEADZONE) ||
      (profile?.pitchRail !== true && Math.abs(rawAxis(GAMEPAD_AXES.pitch)) > GAMEPAD_DEADZONE);
    const anyButton = pad.buttons.some((b) => b.pressed === true || b.value > GAMEPAD_DEADZONE);
    if (stickActivity || anyButton) this.inputSource = 'gamepad';

    // Spec 17 §2.3.1 progressive trigger curves: T = R2^1.4, L2^0.8. The
    // shaped demand is stashed for the haptic pump (driver-intent threshold,
    // e.g. L2 ≥ 0.85 = emergency stop) while stepEntities() runs it through
    // the anti-jerk filter before the physics sees it.
    this.lastThrottleDemand = gamepadThrottleCurve(rawThrottleTrigger);
    this.lastBrakeDemand = gamepadBrakeCurve(rawBrakeTrigger);

    const baseForward = frame.forward + axis(GAMEPAD_AXES.throttle) * -1;

    // Spec 19 §2.1.3 / ADR-2 — brake-to-reverse (buggy only): stopped with a
    // held LT, LT pressure becomes proportional REVERSE throttle instead of
    // the service brake. It latches while LT is held (a rolling-back rover
    // keeps its throttle); LT release or a competing RT snaps back forward.
    if (this.mode === 'buggy') {
      const speed = this.buggy !== null ? this.buggy.getSpeed() : Number.POSITIVE_INFINITY;
      if (this.reverseEngaged) {
        if (rawBrakeTrigger < B2R_ENGAGE_LT || rawThrottleTrigger >= B2R_VETO_RT) {
          this.reverseEngaged = false;
        }
      } else if (
        rawBrakeTrigger >= B2R_ENGAGE_LT &&
        rawThrottleTrigger < B2R_VETO_RT &&
        speed <= B2R_STATIONARY_V_MPS
      ) {
        this.reverseEngaged = true;
      }
    } else {
      this.reverseEngaged = false;
    }

    if (this.reverseEngaged) {
      // The service brake reads 0 (physics would otherwise brake-veto the
      // drive torque at demand ≥ 0.5) and the haptic pump stops reading the
      // reverse pressure as an emergency stop.
      frame.forward = clamp(baseForward - gamepadBrakeCurve(rawBrakeTrigger), -1, 1);
      frame.brake = 0;
      frame.reverse = true;
      this.lastBrakeDemand = 0;
    } else {
      frame.forward = clamp(baseForward + this.lastThrottleDemand, -1, 1);
      frame.brake = this.lastBrakeDemand;
    }

    // Spec 17 §2.2.2: exponential steering curve (dz 0.12, γ 1.6) on the
    // left stick — dead-band, re-normalise, ease. The curve carries its OWN
    // (tighter) deadzone, so it reads the raw clamped axis rather than the
    // 0.15-cut generic one; keyboard steering is digital and never passes
    // through it.
    frame.strafe = clamp(
      frame.strafe + (keyStrafe === 0 ? gamepadSteerCurve(rawAxis(GAMEPAD_AXES.strafe)) : 0),
      -1,
      1,
    );
    // On a calibrated DirectInput pad axes[2] is the RT slider, not the
    // right-stick X — its yaw reading would be pure trigger leakage.
    frame.yaw = clamp(
      frame.yaw + (profile?.altRt === true ? 0 : axis(GAMEPAD_AXES.yaw)),
      -1,
      1,
    );
    // Spec 19 §2.1.4 — right-stick look pitch: exponential curve behind a
    // 0.15 deadband; stick-back (axes[3] negative) looks UP (+pitch), the
    // same sign ArrowUp produces. A rail-parked axes[3] (calibrated slider)
    // never contributes.
    frame.pitch = clamp(
      frame.pitch + (profile?.pitchRail === true ? 0 : -gamepadLookCurve(rawAxis(GAMEPAD_AXES.pitch))),
      -1,
      1,
    );
    frame.sprint =
      frame.sprint ||
      (pad.buttons[GAMEPAD_BUTTONS.sprintLeft]?.pressed ?? false) ||
      (pad.buttons[GAMEPAD_BUTTONS.sprintLeftAlt]?.pressed ?? false);
    frame.jump = frame.jump || (pad.buttons[GAMEPAD_BUTTONS.jump]?.pressed ?? false);
    return frame;
  }

  /**
   * Active gamepad (Spec 19 §2.1.1 / ADR-1): scans every connected device
   * each frame and locks onto whichever one demonstrates above-deadband
   * stick or button activity, so phantom/virtual devices parked at index 0
   * never swallow the real controller. While everything reads neutral the
   * lock sticks to its slot (and degrades to the first valid pad when the
   * locked device vanished). Defensive against Node (navigator without
   * `getGamepads`), locked-down browsers (getter throws), and null holes.
   */
  private pollGamepad(): GamepadLike | null {
    const nav = (globalThis as {
      navigator?: { getGamepads?: () => (GamepadLike | null)[] | undefined };
    }).navigator;
    if (nav === undefined || typeof nav.getGamepads !== 'function') {
      this.activeGamepadIndex = -1;
      return null;
    }
    let pads: (GamepadLike | null)[] | undefined;
    try {
      pads = nav.getGamepads();
    } catch {
      this.activeGamepadIndex = -1;
      return null;
    }
    if (!Array.isArray(pads)) {
      this.activeGamepadIndex = -1;
      return null;
    }
    const valid = (pad: GamepadLike | null | undefined): pad is GamepadLike =>
      pad !== null && pad !== undefined && Array.isArray(pad.axes) && Array.isArray(pad.buttons);

    let firstValid: GamepadLike | null = null;
    let firstValidIndex = -1;
    let activeIndex = -1;
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!valid(pad)) continue;
      if (firstValid === null) {
        firstValid = pad;
        firstValidIndex = i;
      }
      if (this.gamepadHasActivity(pad)) {
        activeIndex = i;
        break;
      }
    }
    if (activeIndex >= 0) {
      this.activeGamepadIndex = activeIndex;
      return pads[activeIndex];
    }
    // Everything neutral: keep the lock if its device is still present.
    if (
      this.activeGamepadIndex >= 0 &&
      this.activeGamepadIndex < pads.length &&
      valid(pads[this.activeGamepadIndex])
    ) {
      return pads[this.activeGamepadIndex];
    }
    this.activeGamepadIndex = firstValidIndex;
    return firstValid;
  }

  /**
   * Above-deadband activity on a pad (Spec 19 §2.1.1). Only the four stick
   * axes are magnitude-checked — bipolar trigger rails (xpad rests at −1)
   * would read as permanent activity, so an axis already calibrated to a
   * slider (alt-RT on axes[2], rail-pitch on axes[3]) is skipped: a parked
   * Linux pad must never out-shout a genuinely moving controller for the
   * active-slot lock. Trigger pulls still surface through `buttons[6/7]`
   * pressed/value on the same frame.
   */
  private gamepadHasActivity(pad: GamepadLike): boolean {
    const profile = this.padProfiles.get(pad);
    for (let i = 0; i <= GAMEPAD_AXES.pitch; i++) {
      if (i === GAMEPAD_AXES.yaw && profile?.altRt === true) continue;
      if (i === GAMEPAD_AXES.pitch && profile?.pitchRail === true) continue;
      const v = pad.axes[i];
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) > GAMEPAD_DEADZONE) {
        return true;
      }
    }
    return pad.buttons.some((b) => b.pressed === true || b.value > GAMEPAD_DEADZONE);
  }

  /**
   * Trigger rest rest-calibration (Spec 19 §2.1.2). On a frame with no
   * button presses and the left stick centred, any of axes[2..5] parked on
   * its negative rail for {@link PAD_RAIL_REST_FRAMES} consecutive idle
   * frames is a bipolar trigger slider, not a stick: axes[4]→LT, axes[5]→RT,
   * axes[2]→alt-RT (DirectInput) and axes[3]→rail (suppress look pitch).
   * Left stick only — it is the one axis guaranteed to rest centred on every
   * pad class, so a slider at −1 can never block its own detection.
   */
  private calibratePadTriggers(pad: GamepadLike): void {
    const buttonsUp = pad.buttons.every((b) => !b.pressed && b.value <= 0.2);
    const leftStickCentred =
      Math.abs(this.rawAxisAt(pad, GAMEPAD_AXES.strafe)) <= 0.2 &&
      Math.abs(this.rawAxisAt(pad, GAMEPAD_AXES.throttle)) <= 0.2;
    const entry = this.padProfiles.get(pad) ?? {
      ltBipolar: false,
      rtBipolar: false,
      altRt: false,
      pitchRail: false,
    };
    const railStreak = (this.padRailStreaks.get(pad) ?? [0, 0, 0, 0]).slice();
    if (buttonsUp && leftStickCentred) {
      const checks = [
        { axis: GAMEPAD_AXES.yaw, latch: (): void => { entry.altRt = true; } },
        { axis: GAMEPAD_AXES.pitch, latch: (): void => { entry.pitchRail = true; } },
        { axis: GAMEPAD_AXES.linuxLtTrigger, latch: (): void => { entry.ltBipolar = true; } },
        { axis: GAMEPAD_AXES.linuxRtTrigger, latch: (): void => { entry.rtBipolar = true; } },
      ];
      for (let i = 0; i < checks.length; i++) {
        const v = this.rawAxisAt(pad, checks[i].axis);
        if (v <= -0.9) {
          railStreak[i] += 1;
          if (railStreak[i] >= PAD_RAIL_REST_FRAMES) checks[i].latch();
        } else {
          railStreak[i] = 0;
        }
      }
    } else {
      railStreak.fill(0);
    }
    this.padRailStreaks.set(pad, railStreak);
    this.padProfiles.set(pad, entry);
  }

  private rawAxisAt(pad: GamepadLike, index: number): number {
    const v = pad.axes[index];
    if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
    return clamp(v, -1, 1);
  }

  /**
   * Rising-edge gamepad actions (spec 14 §3.1 + spec 19 §2.1.5): X mounts,
   * Y toggles lamps, B toggles the trade terminal, RB mines, R3 cycles the
   * camera, D-Pad Up toggles the comms log. Runs once per `update()` frame
   * against the snapshot stashed by `sampleInput()`. While the terminal is
   * open only B responds (it closes) — the console "back" convention,
   * mirroring how the keyboard parks every key except Escape.
   */
  private pumpGamepadActions(): void {
    const now = this.lastGamepadButtons;
    const prev = this.prevGamepadButtons;
    const rising = (index: number): boolean =>
      now[index] === true && prev[index] !== true;
    const tradeOpen = this.hud?.isTradeDialogOpen() ?? false;
    try {
      if (tradeOpen) {
        if (rising(GAMEPAD_BUTTONS.trade)) {
          this.inputSource = 'gamepad';
          this.toggleTradeTerminal();
        }
      } else {
        const padAction =
          rising(GAMEPAD_BUTTONS.mount) ||
          rising(GAMEPAD_BUTTONS.headlight) ||
          rising(GAMEPAD_BUTTONS.trade) ||
          rising(GAMEPAD_BUTTONS.mine) ||
          rising(GAMEPAD_BUTTONS.camera) ||
          rising(GAMEPAD_BUTTONS.comms);
        if (padAction) this.inputSource = 'gamepad';
        if (rising(GAMEPAD_BUTTONS.mount)) this.toggleMount();
        if (rising(GAMEPAD_BUTTONS.headlight)) this.toggleHeadlights();
        if (rising(GAMEPAD_BUTTONS.trade)) this.toggleTradeTerminal();
        if (rising(GAMEPAD_BUTTONS.mine)) this.mineNearestVein();
        if (rising(GAMEPAD_BUTTONS.camera)) this.cycleCamera();
        if (rising(GAMEPAD_BUTTONS.comms)) this.toggleCommsLog();
      }
    } finally {
      this.prevGamepadButtons = now.slice();
    }
  }

  private runAction(action: string): void {
    // Spec 19 §2.1.6: a hotkey press claims the prompt-glyph domain for the
    // keyboard (pad actions flip it back to the controller).
    this.inputSource = 'keyboard';
    switch (action) {
      case 'mount':
        this.toggleMount();
        break;
      case 'headlight':
        this.toggleHeadlights();
        break;
      case 'camera':
        this.cycleCamera();
        break;
      case 'mine':
        this.mineNearestVein();
        break;
      case 'claim':
        this.stakeClaimAtCurrentPosition();
        break;
      case 'trade':
        this.toggleTradeTerminal();
        break;
      case 'track':
        // Spec 17 Phase 4: R toggles Earth Proving Grounds ⇄ Lunar surface.
        if (this.envMode === 'earth_proving_grounds') this.disableProvingGrounds();
        else this.enableProvingGrounds();
        break;
      case 'comms':
        // Spec 18 §6.2: [L] toggles the narrative comms terminal.
        this.toggleCommsLog();
        break;
      case 'close-ui':
        this.hud?.hideTradeDialog();
        break;
      default:
        break;
    }
  }

  // -- gameplay actions ----------------------------------------------------------------

  /** `[E]` — climb into the buggy when near it, climb out when mounted. */
  toggleMount(): boolean {
    if (this.disposed) return false;
    const suit = this.requireSuit();
    const buggy = this.requireBuggy();

    if (this.mode === 'suit') {
      if (!buggy.canMount(suit)) {
        this.hudFeedback(`buggy is out of reach (>${MOUNT_RADIUS_M} m)`, 'error');
        return false;
      }
      if (!buggy.mount(suit)) return false;
      this.mode = 'buggy';
      this.lastEvaCamera = this.world.getCameraRig().getMode();
      // Spec 18 §7: the board event feeds `board_buggy` objectives, and the
      // dash lights up with the current quest telemetry the instant the
      // driver sits down (Spec 18 §6.3 / ADR-18-3).
      this.questEngine?.recordBuggyBoarded();
      this.syncQuestDashboardTelemetry();
      // Spec 16 §2.1: the rover beacon guides the EVA astronaut on foot — it
      // must never shine up into the driver's field of view from the roof.
      this.buggyBeacon?.setEnabled(false);
      for (const mesh of suit.getMeshes()) mesh.setEnabled(false);
      this.hud?.setBuggyPanelVisible(true);
      this.world.getCameraRig().setMode('vehicle_chase');
      // Onboarding: boarding the rover completes the vehicle step.
      this.tutorialTrigger('buggy');
      this.hudSay('buggy engaged');
      return true;
    }

    if (!buggy.dismount(suit)) return false;
    this.mode = 'suit';
    // Spec 16 §2.1: back on foot, the beacon re-arms to guide the astronaut
    // home to the rover (placement/refresh happens in refreshWaypoints).
    this.buggyBeacon?.setEnabled(true);
    for (const mesh of suit.getMeshes()) mesh.setEnabled(true);
    this.hud?.setBuggyPanelVisible(false);
    const rig = this.world.getCameraRig();
    rig.setMode(this.lastEvaCamera === 'vehicle_chase' ? 'eva_third_person' : this.lastEvaCamera);
    this.hudSay('on foot');
    return true;
  }

  /** `[F]` — lamps on the entity you are riding (suit or buggy). */
  toggleHeadlights(): boolean {
    if (this.disposed) return false;
    if (this.mode === 'buggy') return this.requireBuggy().setHeadlights();
    return this.requireSuit().setHeadlight();
  }

  /** `[V]` — first person → third person → chase → first person. */
  cycleCamera(): CameraMode {
    if (this.disposed) return 'eva_first_person';
    const rig = this.world.getCameraRig();
    const index = EVA_CAMERA_CYCLE.indexOf(rig.getMode());
    const next = EVA_CAMERA_CYCLE[(index + 1) % EVA_CAMERA_CYCLE.length];
    rig.setMode(next);
    if (this.mode === 'suit') this.lastEvaCamera = next;
    return next;
  }

  /** `[M]` — fire a MINE frame at the closest vein the drill can reach. */
  mineNearestVein(amount: number = MINE_AMOUNT): boolean {
    if (this.disposed) return false;
    const now = this.nowMs();
    if (now - this.lastMineAt < MINE_COOLDOWN_MS) return false;

    const target = this.getNearestVein();
    if (target === null) {
      this.hudFeedback('no vein in scanner range', 'error');
      return false;
    }
    if (target.rangeM > MINE_RANGE_M) {
      this.hudFeedback(`vein out of drill reach (${Math.round(target.rangeM)} m)`, 'error');
      return false;
    }

    const net = this.network;
    if (net === null || net.state !== 'open') {
      this.hudFeedback('offline — cannot mine', 'error');
      return false;
    }

    const resource = VEIN_KIND_TO_RESOURCE[target.vein.kind] ?? 'regolith';
    try {
      net.mine(target.vein.id, amount, resource);
    } catch (err) {
      this.hudFeedback(`mine failed: ${(err as Error).message}`, 'error');
      return false;
    }
    this.lastMineAt = now;

    // Spec 18 §7: extraction success feeds the quest engine's
    // `extract_mineral` objectives (kind-matched; the tutorial vein is
    // regolith-grade by construction).
    this.questEngine?.recordMineralMined(resource, amount);

    // Onboarding: a fired drill frame completes the extraction step.
    this.tutorialTrigger('mine');

    // Local survey bookkeeping only — the server remains authoritative and
    // the next `mine_result` replaces inventory/credits wholesale.
    try {
      this.world.getWorldGenerator().harvest(target.vein.kind, target.vein.center.x, target.vein.center.y, target.vein.center.z, amount, this.mode === 'buggy' ? 'buggy' : 'suit');
    } catch {
      /* survey model may reject the rig/kind pair; server result still rules */
    }
    this.hudSay(`drilling ${target.vein.id} …`);
    return true;
  }

  /** `[C]` — stake a claim where the player stands (server debits credits). */
  stakeClaimAtCurrentPosition(radius: number = CLAIM_RADIUS_M): boolean {
    if (this.disposed) return false;
    const net = this.network;
    if (net === null || net.state !== 'open') {
      this.hudFeedback('offline — cannot stake a claim', 'error');
      return false;
    }
    const p = this.activePosition();
    try {
      net.stakeClaim({
        x: p.x,
        y: p.y,
        z: p.z,
        radius,
        kind: p.z < 0 ? 'subterranean' : 'surface',
      });
    } catch (err) {
      this.hudFeedback(`claim failed: ${(err as Error).message}`, 'error');
      return false;
    }
    this.hudSay('staking claim …');
    return true;
  }

  /** `[T]` — open/close the commodity terminal (book refreshes on open). */
  toggleTradeTerminal(): boolean {
    if (this.disposed) return false;
    if (this.hud === null) return false;
    const open = this.hud.toggleTradeDialog();
    if (open) {
      // Onboarding: cracking the terminal open completes the commerce step.
      this.tutorialTrigger('trade');
      this.network?.marketQuery();
      const market = this.network?.marketView as
        | { prices?: Record<string, number>; sellPrices?: Record<string, number>; basePrices?: Record<string, number>; reserves?: Record<string, number> }
        | null
        | undefined;
      if (market !== null && market !== undefined) {
        const book = (market.prices ?? {}) as Record<string, number>;
        this.hud.updateMarketPrices(book, {
          sellPrices: market.sellPrices,
          basePrices: market.basePrices,
          reserves: market.reserves,
          holdings: this.network?.inventoryView,
        });
      }
    }
    return open;
  }

  /** Order form submit (HUD `onTrade`) → `TRADE` frame + instant feedback. */
  submitTrade(request: HudTradeRequest): boolean {
    if (this.disposed) return false;
    const net = this.network;
    if (net === null || net.state !== 'open') {
      this.hud?.showFeedback('offline — station exchange unreachable', 'error');
      return false;
    }
    try {
      net.trade(request.commodity, request.amount, request.isBuy);
    } catch (err) {
      this.hud?.showFeedback(`order rejected: ${(err as Error).message}`, 'error');
      return false;
    }
    this.pendingTrades++;
    this.hud?.showFeedback(
      `${request.isBuy ? 'BUY' : 'SELL'} ${request.amount} ${request.commodity} sent — awaiting fill`,
      'info',
    );
    return true;
  }

  // -- render internals -----------------------------------------------------------------

  private stepEntities(dt: number): void {
    const frame = this.sampleInput();
    // Spec 17 Phase 2 anti-jerk filter: one exponential approach per frame on
    // the shaped trigger demands (rate-limited slew, never a step). Advanced
    // here — the single physics-step site — so repeated sampleInput() calls
    // cannot double-filter.
    const slew = clamp(GAMEPAD_TRIGGER_FILTER_RATE * dt, 0, 1);
    this.filteredThrottle += (frame.forward - this.filteredThrottle) * slew;
    this.filteredBrake += (frame.brake - this.filteredBrake) * slew;
    if (Math.abs(this.filteredThrottle) < 1e-4) this.filteredThrottle = 0;
    if (Math.abs(this.filteredBrake) < 1e-4) this.filteredBrake = 0;
    if (this.mode === 'buggy') {
      const buggy = this.requireBuggy();
      const steerInput = frame.strafe !== 0 ? frame.strafe : frame.yaw;
      const handbrake = frame.jump; // Space on keyboard, Button A on pad
      const physicsThrottle = clamp(this.filteredThrottle, -1, 1);
      const input: BuggyInput = {
        throttle: physicsThrottle,
        brake: clamp(this.filteredBrake, 0, 1),
        // Regen bleeds speed when the driver lifts off — but NOT while
        // brake-to-reverse is driving the pack backwards (Spec 19 §2.1.3):
        // regen would point against the intentional reverse torque.
        regen: physicsThrottle < 0 && buggy.getSpeed() > 0.5 && !frame.reverse ? 1 : 0,
        steer: clamp(steerInput, -1, 1),
        parkBrake: handbrake,
      };
      buggy.update(dt, input);
      if (buggy.getState().rolled) buggy.getPhysics().right();
      this.pumpHaptics(dt, buggy);
    } else {
      // EVA path is untouched by the trigger filter (no analog triggers on
      // foot — keep the legacy digital keyboard feel byte-for-byte).
      const speedScale = frame.sprint ? 1 : 0.55;
      const suit = this.requireSuit();
      const input: SuitInput = {
        forward: clamp(frame.forward, -1, 1) * speedScale,
        strafe: clamp(frame.strafe, -1, 1) * speedScale,
        yaw: clamp(frame.yaw, -1, 1),
        pitch: clamp(frame.pitch, -1, 1),
        jump: frame.jump,
        rcs: frame.jump && !suit.getState().isGrounded,
        rcsForward: 0,
        rcsStrafe: 0,
        rcsUp: frame.jump ? 0.5 : 0,
      };
      suit.update(dt, input);
      // Parked buggy still settles on its suspension while abandoned.
      this.buggy?.update(dt, { ...IDLE_BUGGY_INPUT, parkBrake: true });
      this.rumbleClockMs += dt * 1000;
    }
  }

  // -- haptics --------------------------------------------------------------------

  /**
   * Frame-rate haptic pump (Spec 17 Phase 2): reads the buggy telemetry
   * (ABS modulation, brake demand, lateral slip, launch/redline), decides on
   * one dual-rumble effect via {@link computeBuggyRumble}, and hands it to
   * the pad's `GamepadHapticActuator`.
   *
   * Defensive by construction — a pad without `vibrationActuator`, an
   * actuator without `playEffect`, a synchronous throw, or a rejected
   * promise are all swallowed: haptics must never break a driving frame.
   * Effects are rate-limited to one per {@link RUMBLE_MIN_INTERVAL_MS} per
   * pad so a 15 Hz ABS pulse cannot flood the browser event loop.
   */
  private pumpHaptics(dt: number, buggy: OpenBuggy): void {
    this.rumbleClockMs += dt * 1000;
    const state = buggy.getState();
    const effect = computeBuggyRumble({
      absActive: buggy.physics.absActive,
      brakeDemand: this.lastBrakeDemand,
      throttleDemand: this.lastThrottleDemand,
      speed: state.vLong,
      lateralSlip: state.vLat,
    });
    if (effect === null) return;
    if (this.rumbleClockMs - this.lastRumbleAt < RUMBLE_MIN_INTERVAL_MS) return;
    const pad = this.pollGamepad();
    const actuator = pad?.vibrationActuator;
    if (actuator === undefined || actuator === null || typeof actuator.playEffect !== 'function') return;
    this.lastRumbleAt = this.rumbleClockMs;
    try {
      const result = actuator.playEffect('dual-rumble', effect);
      if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      /* haptics are advisory — a pad that refuses to rumble still drives */
    }
  }

  private syncCamera(dt: number): void {
    const rig = this.world.getCameraRig();
    if (this.mode === 'buggy') {
      const buggy = this.requireBuggy();
      // Spec 17 §2.4: v/22 drives the 60°→78° FOV band; the body-frame
      // velocity pair engages the chase camera's velocity-vector lookahead so
      // the view swings into drifts instead of locking to chassis yaw.
      const speedFrac = buggy.getSpeed() / 22;
      rig.update(
        buggy.getPosition(),
        buggy.getHeading(),
        dt,
        buggy.getPitch(),
        speedFrac,
        buggy.getVelocity(),
      );
    } else {
      const suit = this.requireSuit();
      rig.update(suit.getPosition(), suit.getHeading(), dt, suit.getPitch(), 0);
    }
  }

  /** 20 Hz `MOVE` stream while connected (deterministic accumulator). */
  private pumpMoveStream(dt: number): void {
    const net = this.network;
    if (net === null || net.state !== 'open') {
      this.moveAccumulatorMs = 0;
      return;
    }
    this.moveAccumulatorMs += dt * 1000;
    let budget = 4;
    while (this.moveAccumulatorMs >= this.moveInterval && budget-- > 0) {
      this.moveAccumulatorMs -= this.moveInterval;
      try {
        net.sendMove(this.buildMoveState());
      } catch (err) {
        this.log(`sendMove dropped: ${(err as Error).message}`);
        this.moveAccumulatorMs = 0;
      }
    }
  }

  private buildMoveState() {
    if (this.mode === 'buggy') {
      const buggy = this.requireBuggy();
      const s = buggy.getState();
      const ch = Math.cos(s.heading);
      const sh = Math.sin(s.heading);
      return {
        x: s.x,
        y: s.y,
        z: s.z,
        vx: s.vLong * ch - s.vLat * sh,
        vy: s.vLong * sh + s.vLat * ch,
        vz: s.vBody,
        yaw: s.heading,
        mode: 'buggy' as const,
      };
    }
    const suit = this.requireSuit();
    const s = suit.getState();
    return {
      x: s.x,
      y: s.y,
      z: s.z,
      vx: s.vx,
      vy: s.vy,
      vz: s.vz,
      yaw: s.heading,
      pitch: s.pitch,
      mode: 'suit' as const,
    };
  }

  // -- remote avatars (ADR-013-2) ----------------------------------------------------------

  /**
   * Materialise / steer remote puppets from `NetworkClient`'s interpolated
   * render positions. Remote entities are pure kinematic meshes — physics is
   * server-side; the client never re-simulates them.
   */
  private syncRemoteAvatars(): void {
    const net = this.network;
    if (net === null) return;
    const scene = this.world.getScene();

    for (const [id] of net.remotePlayers) {
      const render = net.getRenderPosition(id);
      const remote = net.getRemote(id);
      if (render === null || remote === undefined) continue;

      let puppet = this.remotes.get(id);
      if (puppet !== undefined && puppet.kind !== remote.mode) {
        // Peer switched suit ↔ buggy — rebuild its puppet.
        puppet.entity.dispose();
        this.remotes.delete(id);
        puppet = undefined;
      }
      if (puppet === undefined) {
        const namePrefix = `remote-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const entity =
          remote.mode === 'buggy'
            ? new OpenBuggy({ namePrefix, headlights: true }).init(scene)
            : new EvaSuitAvatar({ namePrefix, headlight: false }).init(scene);
        puppet = { id, kind: remote.mode, entity, heading: 0 };
        this.remotes.set(id, puppet);
      }

      const root = puppet.entity.getRootNode();
      if (root === null) continue;
      const b = worldToBabylon(render);
      this.scratch.copyFrom(b);
      root.position.copyFrom(this.scratch);

      const speed = Math.hypot(remote.vx, remote.vy);
      if (speed > 0.08) puppet.heading = Math.atan2(remote.vy, remote.vx);
      root.rotation.set(0, Math.PI / 2 + puppet.heading, 0);
      root.computeWorldMatrix(true);
    }

    // Sweep puppets whose peers vanished (covers frames that raced the
    // `player_left` event).
    for (const [id, puppet] of this.remotes) {
      if (!net.remotePlayers.has(id)) {
        puppet.entity.dispose();
        this.remotes.delete(id);
      }
    }
  }

  // -- scanner & HUD ------------------------------------------------------------------------

  /** Nearest-vein survey over the generated snapshot (throttled while running). */
  private refreshScanner(now: number): void {
    if (this.lastScanAt !== null && now - this.lastScanAt < SCAN_INTERVAL_MS) return;
    this.lastScanAt = now;

    const snapshot = this.world.getSnapshot();
    if (snapshot === null) return;
    const p = this.activePosition();

    let best: ResourceVein | null = null;
    let bestRange = Number.POSITIVE_INFINITY;
    // Long-range nav survey (TASK-PLAY-063c): nearest non-regolith within
    // NAV_SCAN_RANGE_M wins the compass pin; nearest regolith is fallback.
    let nav: ResourceVein | null = null;
    let navRange = Number.POSITIVE_INFINITY;
    let regolith: ResourceVein | null = null;
    let regolithRange = Number.POSITIVE_INFINITY;
    for (const vein of snapshot.veins) {
      const d =
        Math.sqrt(
          (vein.center.x - p.x) ** 2 + (vein.center.y - p.y) ** 2 + (vein.center.z - p.z) ** 2,
        ) - vein.radius;
      if (d < bestRange) {
        bestRange = d;
        best = vein;
      }
      if (d <= NAV_SCAN_RANGE_M) {
        if (vein.kind !== 'regolith') {
          if (d < navRange) {
            navRange = d;
            nav = vein;
          }
        } else if (d < regolithRange) {
          regolithRange = d;
          regolith = vein;
        }
      }
    }
    const navTarget = nav ?? regolith;
    this.navVein = navTarget;
    this.navVeinRangeM =
      navTarget !== null ? Math.max(0, nav !== null ? navRange : regolithRange) : null;

    if (best !== null && bestRange <= SCAN_RANGE_M) {
      this.nearestVein = best;
      this.nearestVeinRangeM = Math.max(0, bestRange);
      this.scannerReadout = {
        found: true,
        veinId: best.id,
        kind: best.kind,
        purity: best.purity,
        remaining: best.remaining,
        rangeM: Math.max(0, bestRange),
      };
      // Onboarding: scanner lock on a deposit completes the recon step.
      this.tutorialTrigger('scan');
    } else {
      this.nearestVein = null;
      this.nearestVeinRangeM = null;
      this.scannerReadout = { found: false, message: 'NO SIGNATURES' };
    }
    this.hud?.setScanner(this.scannerReadout);
  }

  /** Repaint telemetry panels + proximity prompts from live state. */
  private refreshHud(): void {
    const hud = this.hud;
    if (hud === null || this.disposed) return;

    // Spec 19 §2.1.6: prompt glyphs follow the last-active device.
    hud.setInputSource(this.inputSource);

    const suit = this.requireSuit();
    const buggy = this.requireBuggy();
    hud.updateSuitTelemetry({
      ...suit.getTelemetry(),
      speed: suit.getSpeed(),
    });

    const buggyTelemetry = buggy.getTelemetry();
    hud.updateBuggyTelemetry({
      speed: buggyTelemetry.speed,
      cargoMass: buggyTelemetry.cargoMass,
      cargoCapacity: 500,
      batteryFraction: buggyTelemetry.batteryFraction,
      headlightsOn: buggyTelemetry.headlightsOn,
      mounted: this.mode === 'buggy',
      rolled: buggyTelemetry.rolled,
      airborne: buggyTelemetry.airborne,
    });

    hud.setConnection(this.network?.state ?? 'offline', this.network?.latencyMs ?? null);
    if (this.network?.credits !== undefined) hud.setCredits(this.network.credits);

    const prompts: HudPrompt[] = [];
    if (this.mode === 'buggy') {
      prompts.push({ key: 'E', kind: 'dismount' });
    } else {
      const d = this.suitBuggyDistance();
      if (d <= MOUNT_RADIUS_M) prompts.push({ key: 'E', kind: 'drive' });
    }
    const target = this.getNearestVein();
    if (target !== null && target.rangeM <= MINE_RANGE_M) {
      prompts.push({ key: 'M', kind: 'mine', label: `Mine ${target.vein.kind.replace(/_/g, ' ')}` });
    }
    if (this.network !== null) {
      prompts.push({ key: 'C', kind: 'claim' });
      prompts.push({ key: 'T', kind: 'trade' });
    }
    hud.setPrompts(prompts);

    // Bearing tape last — it reads the freshest scanner lock + entity poses.
    this.refreshCompass();

    const node = this.traversal?.nearestNode(this.activePosition());
    if (node !== undefined) {
      this.hudSay(`${node.name} · ${Math.round(node.distance)} m`);
    }
  }

  private suitBuggyDistance(): number {
    const a = this.requireSuit().getPosition();
    const b = this.requireBuggy().getPosition();
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  // -- waypoint beacons & compass (spec 14 §3.4) -----------------------------------

  /**
   * Build one translucent pulsing waypoint column at a world-frame site.
   * Columns are emissive/emissive-only, never shadow casters (they're light,
   * not furniture), and ride above the terrain by half their height.
   */
  private buildBeacon(
    kind: string,
    r: number,
    g: number,
    b: number,
    at: { x: number; y: number; z?: number },
  ): Mesh {
    const scene = this.world.getScene();
    const mesh = MeshBuilder.CreateCylinder(
      `beacon-${kind}`,
      { diameter: 1.4, height: BEACON_HEIGHT_M, tessellation: 12 },
      scene,
    );
    const material = new StandardMaterial(`beacon-mat-${kind}`, scene);
    material.diffuseColor = new Color3(r, g, b);
    material.emissiveColor = new Color3(r, g, b);
    material.alpha = 0.4;
    material.disableLighting = true;
    mesh.material = material;
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    this.beaconMaterials.set(kind, material);
    const groundZ = at.z ?? this.world.getGroundHeightAt(at.x, at.y);
    mesh.position.copyFrom(worldToBabylon({ x: at.x, y: at.y, z: groundZ + BEACON_HEIGHT_M / 2 }));
    this.world.addEntity(mesh);
    return mesh;
  }

  /** Reposition an existing beacon column (base of the column on the terrain). */
  private placeBeacon(mesh: Mesh, x: number, y: number): void {
    const groundZ = this.world.getGroundHeightAt(x, y);
    mesh.position.copyFrom(worldToBabylon({ x, y, z: groundZ + BEACON_HEIGHT_M / 2 }));
  }

  /** Nearest faction base to a world-frame point, or null without bases. */
  private nearestBaseTo(p: { x: number; y: number }) {
    const bases = this.factionBases?.getBases() ?? [];
    let best: (typeof bases)[number] | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const base of bases) {
      const d = Math.hypot(base.position.x - p.x, base.position.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = base;
      }
    }
    return best;
  }

  /**
   * Per-frame beacon book: the green vein beacon snaps to (and hides with)
   * the scanner lock, the cyan rover beacon trails the parked/driven buggy,
   * and every beacon material breathes on the shared pulse clock.
   */
  private refreshWaypoints(now: number): void {
    if (this.disposed) return;
    const vein = this.getNearestVein();
    if (this.veinBeacon !== null) {
      if (vein !== null) {
        this.placeBeacon(this.veinBeacon, vein.vein.center.x, vein.vein.center.y);
        this.veinBeacon.setEnabled(true);
      } else {
        this.veinBeacon.setEnabled(false);
      }
    }
    if (this.buggyBeacon !== null) {
      if (this.mode === 'buggy') {
        // Spec 16 §2.1: never light the beacon while mounted — the column sits
        // at the vehicle origin, straight into the driver's field of view.
        this.buggyBeacon.setEnabled(false);
      } else {
        const b = this.requireBuggy().getPosition();
        this.placeBeacon(this.buggyBeacon, b.x, b.y);
        this.buggyBeacon.setEnabled(true);
      }
    }
    // Alpha sine, phase-offset per beacon so triple-pulses never sync flat.
    let phaseIndex = 0;
    for (const material of this.beaconMaterials.values()) {
      const phase = (phaseIndex++ * Math.PI) / 3;
      material.alpha =
        0.42 + 0.28 * Math.sin((2 * Math.PI * now) / BEACON_PULSE_MS + phase);
    }
  }

  /**
   * Feed the HUD compass tape: heading of the ridden entity (physics θ runs
   * counter-clockwise from +x; compass bearing = 90° − θ) plus relative pins
   * for the rover (on foot only), nearest faction base, and scanner-locked
   * vein.
   */
  private refreshCompass(): void {
    const hud = this.hud;
    if (hud === null || this.disposed) return;

    const headingRad =
      this.mode === 'buggy' ? this.requireBuggy().getHeading() : this.requireSuit().getHeading();
    const headingDeg = wrap360(90 - (headingRad * 180) / Math.PI);

    const p = this.activePosition();
    const targets: HudCompassTargets = {};

    if (this.mode !== 'buggy') {
      const b = this.requireBuggy().getPosition();
      targets.buggy = { bearing: compassBearingDeg(p, b), dist: this.suitBuggyDistance() };
    }

    const base = this.nearestBaseTo(p);
    if (base !== null) {
      targets.base = {
        name: base.factionName,
        bearing: compassBearingDeg(p, base.position),
        dist: Math.hypot(base.position.x - p.x, base.position.y - p.y),
      };
    }

    const nav = this.getNavVein() ?? this.getNearestVein();
    if (nav !== null) {
      const bearingDeg = compassBearingDeg(p, nav.vein.center);
      const relBearing = wrap180(bearingDeg - headingDeg);
      let arrow = '▲';
      if (relBearing < -15) arrow = '◀';
      else if (relBearing > 15) arrow = '▶';
      targets.vein = {
        kind: nav.vein.kind,
        bearing: bearingDeg,
        dist: nav.rangeM,
        relBearing,
        arrow,
      };
    }

    hud.updateCompass(headingDeg, targets);
  }

  // -- onboarding state machine (spec 14 §3.5) --------------------------------------

  /** Current onboarding state: first incomplete step, or `'complete'`. */
  getTutorialStep(): TutorialStep {
    for (const step of TUTORIAL_ORDER) {
      if (!this.tutorialDone.has(step)) return step;
    }
    return 'complete';
  }

  /** Authoritative per-step flags + first-incomplete index (0-based). */
  getTutorialProgress(): { step: TutorialStep; index: number; completed: boolean[] } {
    const completed = TUTORIAL_ORDER.map((step) => this.tutorialDone.has(step));
    const firstOpen = completed.indexOf(false);
    const index = firstOpen < 0 ? TUTORIAL_ORDER.length : firstOpen;
    return { step: this.getTutorialStep(), index, completed };
  }

  /** Fire a step trigger (idempotent) and repaint the checklist when it lands. */
  private tutorialTrigger(step: TutorialProgressStep): void {
    if (this.tutorialDone.has(step)) return;
    this.tutorialDone.add(step);
    this.refreshTutorialHud();
  }

  /** Push the state machine into the HUD checklist. */
  private refreshTutorialHud(): void {
    const { index, completed } = this.getTutorialProgress();
    this.hud?.updateTutorial(index, completed);
  }

  /**
   * Passive triggers polled every frame: enough ground distance walked AND
   * at least one low-g hop complete the locomotion step. The remaining
   * triggers (scan lock, mine, mount, trade-open) fire from their action
   * sites directly.
   */
  private updateTutorialSensors(): void {
    if (this.disposed || this.mode !== 'suit') return;
    const suit = this.requireSuit();
    if (this.tutorialDone.has('move')) return;

    const p = suit.getPosition();
    const step = Math.hypot(p.x - this.tutorialPrevPos.x, p.y - this.tutorialPrevPos.y);
    // Guard the teleport teleport-jump (welcome spawn) from counting as foot
    // travel: displacements over a render frame can only be a teleport.
    if (step < TUTORIAL_TELEPORT_GUARD_M) this.tutorialTravelM += step;
    this.tutorialPrevPos = { x: p.x, y: p.y };

    const airborne = !suit.getState().isGrounded;
    if (airborne && !this.tutorialWasAirborne) this.tutorialHopped = true;
    this.tutorialWasAirborne = airborne;

    if (this.tutorialTravelM >= TUTORIAL_MOVE_DISTANCE_M && this.tutorialHopped) {
      this.tutorialTrigger('move');
    }
  }

  // -- narrative quest layer (spec 18 §5/§7, ADR-18-1/2/3) ------------------------

  /** The wired quest state machine (null before `init()` / after dispose). */
  getQuestEngine(): QuestEngine | null {
    return this.questEngine;
  }

  /** The wired 3D hint-arrow system (null before `init()` / after dispose). */
  getHintArrowSystem(): HintArrowSystem | null {
    return this.hintArrowSystem;
  }

  /** Credits awarded by the last `QUEST_COMPLETED` (Spec 18 §5: 500 cr). */
  getQuestRewardCredits(): number {
    return this.questRewardCredits;
  }

  /** Last comms burst delivered by the quest engine (for the [L] log). */
  getLastComms(): CommsDialogue | null {
    return this.lastComms;
  }

  /**
   * `[L]` — toggle the narrative comms terminal (Spec 18 §6.2: the comms log
   * stays accessible after the auto-dismiss collapse). Re-shows the last
   * transmission verbatim; returns the post-toggle visibility.
   */
  toggleCommsLog(): boolean {
    const hud = this.hud;
    if (hud === null || this.disposed) return false;
    if (hud.isCommsVisible()) {
      hud.hideComms();
      return false;
    }
    if (this.lastComms !== null) {
      hud.showComms(this.lastComms);
      return true;
    }
    return false;
  }

  /**
   * Per-frame quest sensors (Spec 18 §7): accumulate foot vs buggy-drive
   * odometers into `recordMoveDistance(meters, isBuggy)`, feed the live
   * position into `recordPosition` (drives `reach_target` objectives), and
   * keep the buggy dash telemetry warm at ~10 Hz. The teleport guard mirrors
   * the legacy tutorial rule — a single-frame displacement larger than 25 m
   * is a server spawn correction, not a footstep.
   */
  private updateQuestSensors(): void {
    const engine = this.questEngine;
    if (engine === null || this.disposed) return;

    const suitPos = this.requireSuit().getPosition();
    const buggyPos = this.requireBuggy().getPosition();

    if (this.questFootPrev !== null && this.mode === 'suit') {
      const step = Math.hypot(suitPos.x - this.questFootPrev.x, suitPos.y - this.questFootPrev.y);
      if (step > 0 && step < ClientApp.QUEST_TELEPORT_GUARD_M) {
        engine.recordMoveDistance(step, false);
      }
    }
    this.questFootPrev = { x: suitPos.x, y: suitPos.y };

    if (this.questBuggyPrev !== null && this.mode === 'buggy') {
      const roll = Math.hypot(buggyPos.x - this.questBuggyPrev.x, buggyPos.y - this.questBuggyPrev.y);
      if (roll > 0 && roll < ClientApp.QUEST_TELEPORT_GUARD_M) {
        engine.recordMoveDistance(roll, true);
      }
    }
    this.questBuggyPrev = { x: buggyPos.x, y: buggyPos.y };

    engine.recordPosition(this.activePosition());

    // Dash telemetry mirror: ~10 Hz while mounted (frame-counted so it is
    // deterministic under virtual-clock harnesses — no wall clock involved).
    if (this.mode === 'buggy' && ++this.questDashFrame % 6 === 0) {
      this.syncQuestDashboardTelemetry();
    }
  }

  /**
   * Spec 18 §6.1 / §7 — steer the hint arrow from the active objective and
   * emit the screen-space payload into `hud.updateHintArrow()`. The camera is
   * the scene's active camera (already pose-synced this frame by
   * `syncCamera`); the viewport is the live backbuffer size, so NullEngine
   * harnesses with an explicit render size get real projection results.
   */
  private refreshHintArrow(_now: number): void {
    const hints = this.hintArrowSystem;
    const engine = this.questEngine;
    if (hints === null || engine === null || this.disposed) return;
    const target: HintArrowTarget | null = engine.getHintArrowTarget();
    hints.setTarget(target);
    const camera = this.world.getScene().activeCamera;
    const engineGfx = this.world.getEngine();
    hints.update(camera, target, engineGfx.getRenderWidth(), engineGfx.getRenderHeight());
  }

  /**
   * Push the active QuestEngine stage into the LunarHUD mission panel
   * (Spec 18 §6.2 / Phase 3 contract): quest title, stage title, stage
   * counter and the live objective rows. With no active quest the legacy
   * checklist is restored unchanged.
   */
  private pushQuestStageToHud(): void {
    const hud = this.hud;
    if (hud === null || this.disposed) return;
    const quest = this.questEngine?.getActiveQuest() ?? null;
    const stage = this.questEngine?.getActiveStage() ?? null;
    const legacy = this.getTutorialProgress();
    if (quest === null || stage === null || quest.isCompleted) {
      hud.setQuestStage(legacy.index, legacy.completed);
      return;
    }
    hud.setQuestStage(legacy.index, legacy.completed, {
      questTitle: quest.title,
      stageTitle: stage.stageTitle,
      stageNumber: stage.stageNumber,
      stageTotal: quest.stages.length,
      objectives: stage.objectives.map((o) => ({
        id: o.id,
        description: o.description,
        completed: o.completed,
      })),
    });
  }

  /**
   * Mirror quest + contractor telemetry onto the buggy cockpit dash
   * (Spec 18 §6.3, ADR-18-3): quest title/objective strip, nav pip bearing,
   * target range, cargo capacity, faction insignia tag and radio link state.
   * Safe on NullEngine — the raster is pure RGBA.
   */
  private syncQuestDashboardTelemetry(): void {
    const engine = this.questEngine;
    if (engine === null || this.disposed) return;
    const quest = engine.getActiveQuest();
    const stage = engine.getActiveStage();
    const pendingObjective = stage?.objectives.find((o) => !o.completed) ?? null;
    const reading = engine.computeHintReading(this.activePosition());
    const net = this.network;
    const data: BuggyDashTelemetry = {
      ...(quest !== null && !quest.isCompleted
        ? { questTitle: quest.title }
        : {}),
      objectiveText:
        stage !== null && quest !== null && !quest.isCompleted
          ? pendingObjective?.description ?? stage.stageTitle
          : 'ALL OBJECTIVES COMPLETE',
      ...(reading !== null
        ? { targetDistanceM: reading.distanceM, targetBearingDeg: reading.bearingDeg }
        : {}),
      cargoKg: this.requireBuggy().getCargoMass(),
      maxCargoKg: BUGGY_MAX_CARGO,
      faction: quest?.faction ?? this.options.faction ?? 'CEC',
      linkStatus: net !== null && net.state === 'open' ? 'ONLINE - 128 kbps' : 'OFFLINE',
    };
    this.requireBuggy().setQuestDashboardTelemetry(data);
  }

  /**
   * Pick the tutorial quest's mineral-vein anchor from the generated world:
   * a regolith-grade vein that is provably the nearest vein AT ITS OWN
   * centre (so a contractor standing on it always sees exactly this vein in
   * the scanner and the mining hook records a quest-matching resource).
   * Falls back to null when the snapshot carries no veins.
   */
  private veinAnchorFor(
    fromX: number,
    fromY: number,
  ): { x: number; y: number; z: number } | null {
    const veins = this.world.getSnapshot()?.veins ?? null;
    if (veins === null || veins.length === 0) return null;
    const surfaceDistance = (v: { center: { x: number; y: number; z: number }; radius: number }) =>
      Math.hypot(v.center.x - fromX, v.center.y - fromY) - v.radius;
    const candidates = [...veins]
      .filter((v) => (VEIN_KIND_TO_RESOURCE[v.kind] ?? v.kind) === 'regolith')
      .sort((a, b) => surfaceDistance(a) - surfaceDistance(b));
    for (const candidate of candidates) {
      // Nearest-at-own-centre test: every OTHER vein must sit shallower
      // (strictly) at this point than the candidate's own −radius.
      let anchorHolds = true;
      for (const other of veins) {
        if (other === candidate) continue;
        const d =
          Math.hypot(candidate.center.x - other.center.x, candidate.center.y - other.center.y) -
          other.radius;
        if (d < -candidate.radius) {
          anchorHolds = false;
          break;
        }
      }
      if (anchorHolds) {
        return { x: candidate.center.x, y: candidate.center.y, z: candidate.center.z };
      }
    }
    // No self-dominant regolith vein: take the closest vein of any kind.
    const best = [...veins].sort((a, b) => surfaceDistance(a) - surfaceDistance(b))[0];
    return best ? { x: best.center.x, y: best.center.y, z: best.center.z } : null;
  }

  // -- network wiring -----------------------------------------------------------------------

  private wireNetwork(): void {
    const net = this.network;
    if (net === null) return;

    net.on('connected', (ev: ConnectionEvent) => {
      this.hud?.setConnection('open');
      this.log(`connected to ${ev.url}`);
      if (this.ownsNetwork) {
        net.join(
          this.options.username ?? 'prospector',
          this.options.faction ?? 'unaffiliated',
          this.options.role ?? 'surveyor',
        );
      }
    });
    net.on('reconnecting', (ev: ConnectionEvent) => {
      this.hud?.setConnection('reconnecting');
      this.hudSay(`reconnecting (attempt ${ev.attempt ?? 1})`);
    });
    net.on('disconnected', (ev: ConnectionEvent) => {
      this.hud?.setConnection('disconnected');
      if (ev.intentional !== true) this.hudSay('link dropped');
    });

    net.on('welcome', (ev: WelcomeEvent) => this.onWelcome(ev));
    net.on('world_delta', (ev: WorldDeltaEvent) => this.onWorldDelta(ev));

    net.on('player_left', (frame) => {
      const id = typeof frame['player_id'] === 'string' ? (frame['player_id'] as string) : '';
      const puppet = this.remotes.get(id);
      if (puppet !== undefined) {
        puppet.entity.dispose();
        this.remotes.delete(id);
      }
    });

    net.on('market_sync', (ev: MarketSyncEvent) => {
      this.hud?.updateMarketPrices(ev.prices, {
        sellPrices: ev.sellPrices,
        basePrices: ev.basePrices,
        reserves: ev.reserves,
        holdings: this.network?.inventoryView,
        timestamp: ev.timestamp,
      });
    });

    net.on('trade_confirmed', (ev: TradeConfirmedEvent) => {
      if (this.pendingTrades > 0) this.pendingTrades--;
      this.hud?.showTradeConfirmation({
        commodity: ev.commodity,
        amount: ev.amount,
        isBuy: ev.isBuy,
        totalCredits: ev.totalCredits,
        newBalance: ev.newBalance,
      });
      this.hud?.updateInventory(ev.inventory);
      // Spec 18 §7: a confirmed exchange feeds `trade_commodity` objectives
      // (engine filters by commodity — the tutorial wants a regolith dump).
      // Runs AFTER the terminal confirmation so a quest-completion banner is
      // the final word in the feedback line.
      if (!ev.isBuy) {
        this.questEngine?.recordTrade(ev.commodity.toLowerCase(), ev.amount);
      }
    });

    net.on('claim_staked', (ev: ClaimStakedEvent) => {
      this.hudSay(`claim ${ev.claimId} staked`);
      this.addClaimMarker(ev);
    });

    net.on('claim_result', (frame) => {
      if (frame['ok'] === false) {
        this.hudFeedback(`claim rejected: ${String(frame['reason'] ?? 'server declined')}`, 'error');
      }
    });

    net.on('mine_result', (frame) => {
      const amount = finite(frame['amount']) ?? 0;
      const earned = finite(frame['earned']) ?? 0;
      const credits = finite(frame['credits']);
      if (credits !== null) this.hud?.setCredits(credits);
      this.hudSay(`drew ${amount} u · +${earned} cr`);
      const inventory = frame['inventory'];
      if (typeof inventory === 'object' && inventory !== null) {
        this.hud?.updateInventory(inventory as Record<string, number>);
      }
    });

    net.on('rail_placed', () => this.hudSay('rail segment laid'));

    net.on('error', (ev: ClientErrorEvent) => {
      if (this.pendingTrades > 0) {
        this.pendingTrades--;
        this.hud?.showFeedback(`station: ${ev.code} — ${ev.message}`, 'error');
      } else {
        this.hudSay(`station error: ${ev.code}`);
      }
    });
  }

  private onWelcome(ev: WelcomeEvent): void {
    this.hud?.setUsername(ev.player.username, ev.player.faction);
    this.hud?.setCredits(ev.player.credits);
    this.hud?.updateInventory(ev.inventory);
    const market = ev.market as
      | { prices?: Record<string, number>; sellPrices?: Record<string, number>; basePrices?: Record<string, number>; reserves?: Record<string, number> }
      | null
      | undefined;
    if (market?.prices !== undefined) {
      this.hud?.updateMarketPrices(market.prices, {
        sellPrices: market.sellPrices,
        basePrices: market.basePrices,
        reserves: market.reserves,
        holdings: ev.inventory,
      });
    }
    // Server-authoritative spawn (state carries x/y/z once the session exists).
    // If the server sent (0, 0) (uninitialized origin), preserve the world's
    // resolved spawn point (512, 512) where the base and buggy are parked.
    const sx = finite(ev.state['x']);
    const sy = finite(ev.state['y']);
    if (sx !== null && sy !== null && (sx !== 0 || sy !== 0) && this.mode === 'suit') {
      this.suit?.teleport(sx, sy);
    }
    this.hudSay(`welcome to the frontier, ${ev.player.username}`);
  }

  private onWorldDelta(_ev: WorldDeltaEvent): void {
    // NetworkClient already folded the delta into its interpolation targets;
    // meshes are steered from `syncRemoteAvatars()` every render frame.
  }

  private addClaimMarker(ev: ClaimStakedEvent): void {
    if (this.disposed || ev.claimId.length === 0) return;
    const scene = this.world.getScene();
    const ground = this.world.getGroundHeightAt(ev.x, ev.y);
    const marker = MeshBuilder.CreateCylinder(
      `claim-${ev.claimId}`,
      { diameter: ev.radius * 2, height: 0.6, tessellation: 48 },
      scene,
    );
    const material = new StandardMaterial(`claim-mat-${ev.claimId}`, scene);
    material.diffuseColor = new Color3(0.35, 0.9, 1);
    material.emissiveColor = new Color3(0.05, 0.35, 0.42);
    material.alpha = 0.18;
    marker.material = material;
    const b = worldToBabylon({ x: ev.x, y: ev.y, z: ground + 0.3 });
    marker.position.copyFrom(b);
    this.world.addEntity(marker);
    this.claimMarkers.set(ev.claimId, marker);
  }

  // -- DOM input ---------------------------------------------------------------------------

  private attachDomInput(): void {
    if (this.domAttached) return;
    const win = (globalThis as { window?: { addEventListener?: unknown } }).window;
    if (win === undefined || typeof win.addEventListener !== 'function') return;
    const target = win as unknown as {
      addEventListener: (type: string, fn: (ev: { code?: string }) => void) => void;
    };
    this.domKeyDown = (ev) => {
      if (ev.code !== undefined && this.handleKeyInput(ev.code, 'down')) ev.preventDefault?.();
    };
    this.domKeyUp = (ev) => {
      if (ev.code !== undefined) this.handleKeyInput(ev.code, 'up');
    };
    target.addEventListener('keydown', this.domKeyDown);
    target.addEventListener('keyup', this.domKeyUp);
    this.domAttached = true;
  }

  private detachDomInput(): void {
    if (!this.domAttached) return;
    const win = (globalThis as {
      window?: { removeEventListener?: (t: string, fn: unknown) => void };
    }).window;
    try {
      win?.removeEventListener?.('keydown', this.domKeyDown);
      win?.removeEventListener?.('keyup', this.domKeyUp);
    } catch {
      /* headless teardown — nothing was attached anyway */
    }
    this.domAttached = false;
  }

  private domKeyDown: (ev: { code?: string; preventDefault?: () => void }) => void = () => {};
  private domKeyUp: (ev: { code?: string }) => void = () => {};

  // -- helpers --------------------------------------------------------------------------------

  private resolveSpawn(): { x: number; y: number } {
    if (this.options.spawn !== undefined) return this.options.spawn;
    const spawn = this.world.getSpawnPoint();
    return { x: spawn.x, y: spawn.y };
  }

  private activePosition(): { x: number; y: number; z: number } {
    return this.mode === 'buggy'
      ? this.requireBuggy().getPosition()
      : this.requireSuit().getPosition();
  }

  private requireSuit(): EvaSuitAvatar {
    if (this.suit === null) throw new Error('ClientApp: not initialised — call init()');
    return this.suit;
  }

  private requireBuggy(): OpenBuggy {
    if (this.buggy === null) throw new Error('ClientApp: not initialised — call init()');
    return this.buggy;
  }

  private nowMs(): number {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    if (perf !== undefined && typeof perf.now === 'function') return perf.now();
    return Date.now();
  }

  private hudSay(message: string): void {
    this.hud?.setStatusMessage(message);
  }

  private hudFeedback(message: string, kind: 'info' | 'success' | 'error'): void {
    this.hud?.showFeedback(message, kind);
  }

  private log(message: string): void {
    if (this.options.silent === true) return;
    if (typeof console !== 'undefined') console.log(`[ClientApp] ${message}`);
  }
}

export default ClientApp;
