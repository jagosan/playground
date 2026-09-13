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
import { EvaSuitAvatar } from '../entities/AstronautSuit.ts';
import { OpenBuggy, MOUNT_RADIUS_M } from '../entities/OpenBuggy.ts';
import { TraversalController } from './TraversalController.ts';
import {
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

/** Buggy parks this far from the spawn collar, metres. */
export const BUGGY_PARK_OFFSET: readonly [number, number] = [9, 4];

/** Key-sheet actions that fire once per key-down (spec 13 §1). */
export const ACTION_KEYS: Readonly<Record<string, string>> = {
  KeyE: 'mount',
  KeyF: 'headlight',
  KeyV: 'camera',
  KeyM: 'mine',
  KeyC: 'claim',
  KeyT: 'trade',
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
}

export interface ClientInputFrame {
  /** -1..1 forward (W/S). */
  forward: number;
  /** -1..1 strafe (A/D; + = left, matching `SuitInput.strafe`). */
  strafe: number;
  /** -1..1 yaw steer (Arrow keys). */
  yaw: number;
  /** -1..1 look pitch (Arrow up/down). */
  pitch: number;
  /** Shift held — run instead of walk on foot. */
  sprint: boolean;
  /** Space held — hop (physics tracks its own rising edge). */
  jump: boolean;
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

  private suit: EvaSuitAvatar | null = null;
  private buggy: OpenBuggy | null = null;
  private traversal: TraversalController | null = null;

  private mode: TravelMode = 'suit';
  /** EVA camera mode to restore when dismounting the buggy. */
  private lastEvaCamera: CameraMode = 'eva_first_person';

  private readonly pressed = new Set<string>();

  private lastFrameAt: number | null = null;
  private moveAccumulatorMs = 0;
  private lastScanAt: number | null = null;
  private lastMineAt = -Infinity;
  private pendingTrades = 0;

  private readonly remotes = new Map<string, RemoteAvatar>();
  private readonly claimMarkers = new Map<string, Mesh>();

  private scannerReadout: HudScannerReadout = { found: false, message: 'SCANNING…' };
  private nearestVein: ResourceVein | null = null;
  private nearestVeinRangeM: number | null = null;

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

    const ground: GroundElevationFn = (x, y) => this.world.getGroundHeightAt(x, y);
    const scene = this.world.getScene();
    const spawn = this.resolveSpawn();

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

    this.wireNetwork();
    this.attachDomInput();

    if (this.ownsNetwork && this.network !== null) {
      // Fire-and-forget: the `connected` handler performs the JOIN. A failed
      // first connect leaves the client's own backoff retrying.
      void this.network.connect().catch(() => undefined);
    }

    this.initialized = true;
    this.hudSay('surface suit');
    this.hud?.setConnection(this.network?.state ?? 'offline');
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

    this.stepEntities(dt);
    this.syncCamera(dt);
    this.pumpMoveStream(dt);
    this.network?.update(timestamp);
    this.syncRemoteAvatars();
    this.refreshScanner(timestamp);
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

    this.suit?.dispose();
    this.buggy?.dispose();
    this.suit = null;
    this.buggy = null;
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

  /** The frame the movement stream would send right now. */
  currentMoveState() {
    return this.buildMoveState();
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

  /** Poll the held-key set into a movement frame (public for tests). */
  sampleInput(): ClientInputFrame {
    const p = this.pressed;
    const forward = (p.has('KeyW') ? 1 : 0) - (p.has('KeyS') ? 1 : 0);
    const strafe = (p.has('KeyA') ? 1 : 0) - (p.has('KeyD') ? 1 : 0);
    const yaw = (p.has('ArrowLeft') ? 1 : 0) - (p.has('ArrowRight') ? 1 : 0);
    const pitch = (p.has('ArrowUp') ? 1 : 0) - (p.has('ArrowDown') ? 1 : 0);
    const frame: ClientInputFrame = {
      forward,
      strafe,
      yaw,
      pitch,
      sprint: p.has('ShiftLeft') || p.has('ShiftRight'),
      jump: p.has('Space'),
    };
    return frame;
  }

  private runAction(action: string): void {
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
      for (const mesh of suit.getMeshes()) mesh.setEnabled(false);
      this.hud?.setBuggyPanelVisible(true);
      this.world.getCameraRig().setMode('vehicle_chase');
      this.hudSay('buggy engaged');
      return true;
    }

    if (!buggy.dismount(suit)) return false;
    this.mode = 'suit';
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
    if (this.mode === 'buggy') {
      const buggy = this.requireBuggy();
      const input: BuggyInput = {
        throttle: clamp(frame.forward, -1, 1),
        brake: frame.forward < 0 && buggy.getSpeed() > 0.5 ? 1 : 0,
        regen: frame.forward < 0 ? 1 : 0,
        steer: clamp(frame.strafe, -1, 1),
        parkBrake: false,
      };
      buggy.update(dt, input);
      if (buggy.getState().rolled) buggy.getPhysics().right();
    } else {
      const suit = this.requireSuit();
      const speedScale = frame.sprint ? 1 : 0.55;
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
    }
  }

  private syncCamera(dt: number): void {
    const rig = this.world.getCameraRig();
    if (this.mode === 'buggy') {
      const buggy = this.requireBuggy();
      rig.update(buggy.getPosition(), buggy.getHeading(), dt, buggy.getPitch());
    } else {
      const suit = this.requireSuit();
      rig.update(suit.getPosition(), suit.getHeading(), dt, suit.getPitch());
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
    for (const vein of snapshot.veins) {
      const d =
        Math.sqrt(
          (vein.center.x - p.x) ** 2 + (vein.center.y - p.y) ** 2 + (vein.center.z - p.z) ** 2,
        ) - vein.radius;
      if (d < bestRange) {
        bestRange = d;
        best = vein;
      }
    }

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
    const sx = finite(ev.state['x']);
    const sy = finite(ev.state['y']);
    if (sx !== null && sy !== null && this.mode === 'suit') {
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
