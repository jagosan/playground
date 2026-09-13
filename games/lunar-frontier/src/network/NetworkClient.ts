/**
 * Lunar Frontier — isomorphic WebSocket network client with remote-avatar
 * replication (Spec 13 §2/§3, ADR-013-2, TASK-PLAY-053).
 *
 * Responsibilities
 *  1. Connection lifecycle — `connect()` with exponential-backoff reconnect,
 *     graceful `disconnect()`, and a PING/PONG heartbeat that measures
 *     round-trip latency (last / average / jitter).
 *  2. Outbound protocol — `join`, `sendMove`, `stakeClaim`, `mine`, `trade`,
 *     `layRail` (+ `marketQuery`, `ping`) emitting JSON frames shaped exactly
 *     like `src/server/LunarServer.ts` expects. Frames sent while the socket
 *     is still opening are buffered and flushed on `open`.
 *  3. Inbound typed event dispatcher — `welcome`, `world_delta`,
 *     `market_sync`, `trade_confirmed`, `claim_staked`, `rail_placed` and
 *     `error`, plus supporting `hello`, `pong`, `player_joined`,
 *     `player_left`, `mine_result`, `claim_result`, `rail_laid`, `connected`,
 *     `reconnecting`, `disconnected` and a raw `message` passthrough.
 *  4. Remote entity tracking (ADR-013-2) — every peer lives in
 *     `remotePlayers`. The server's 20 Hz delta frames set interpolation
 *     targets; `update()` (call once per 60 fps render frame) lerps toward
 *     them over one tick window and, when frames fall silent, dead-reckons
 *     forward along the last velocity vector.
 *  5. Isomorphism — browsers use the global `WebSocket`; Node ≥22 also has
 *     one, and the `ws` package is supported via dynamic import or an
 *     injected `socketFactory` (used by the test harness). No `node:*`
 *     imports anywhere, so Vite can bundle this file for static hosting.
 *
 * Usage (browser):
 *   const net = new NetworkClient({ url: 'wss://beehive.example/ws' });
 *   net.on('welcome', (w) => hud.show(w.player));
 *   await net.connect();
 *   net.join('jagosan', 'esa', 'surveyor');
 *   renderLoop: net.update(); placeAvatar(net.getRenderPosition(id));
 */

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TravelMode = 'suit' | 'buggy';
/** Client-side spelling of the server's resource-ledger columns. */
export type MiningResource = 'regolith' | 'water_ice' | 'helium3' | 'rare_earths';
export type Vec3 = [number, number, number];

/** Local player's outbound movement state (spec 13 §3.1 MOVE). */
export interface MoveState {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  mode?: TravelMode;
  yaw?: number;
  pitch?: number;
}

/** Coords for a CLAIM frame. `kind` maps to the server's `claim_type`. */
export interface ClaimCoords {
  x: number;
  y: number;
  z?: number;
  radius?: number;
  kind?: 'surface' | 'subterranean';
}

/** One peer's changed fields inside a `world_delta` (all fields optional — it is a delta). */
export interface RemotePlayerState {
  username?: string;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  mode?: TravelMode;
  credits?: number;
}

/**
 * A tracked remote avatar. `x/y/z` hold the latest *authoritative target*
 * (server truth); `renderX/Y/Z` hold the interpolated/extrapolated position
 * the renderer should use this frame (ADR-013-2).
 */
export interface RemotePlayer {
  id: string;
  username: string;
  faction?: string;
  mode: TravelMode;
  credits?: number;

  // Authoritative target (last snapshot the server told us).
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;

  // Interpolation bookkeeping — mutated by update().
  originX: number;
  originY: number;
  originZ: number;
  /** Client clock (ms) of the snapshot that set the current target. */
  lastSnapshotAt: number;
  /** True once any server frame reported explicit vx/vy/vz (authoritative). */
  hasVelocity: boolean;
  /** Velocity inferred from position-only deltas (fallback, capped). */
  lastVx: number;
  lastVy: number;
  lastVz: number;
  /** True when the current render position is a dead-reckoned projection. */
  deadReckoned: boolean;
  renderX: number;
  renderY: number;
  renderZ: number;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface PlayerIdentity {
  id: string;
  username: string;
  faction: string;
  role: string;
  credits: number;
}

export interface WelcomeEvent {
  player: PlayerIdentity;
  state: Record<string, unknown>;
  resources: Record<string, unknown>;
  inventory: Record<string, number>;
  world: { claims: unknown[]; infrastructure: unknown[]; rail_tracks: unknown[] };
  ownClaims: unknown[];
  market: Record<string, unknown> | null;
  uptime: number;
}

export interface WorldDeltaEvent {
  /** Monotonic client-side counter of world_delta frames since connect. */
  tick: number;
  /** Server wall-clock from the tick frame, when present. */
  serverTime: number | null;
  /** Changed fields per player id (self excluded — you are not your own remote). */
  players: Record<string, RemotePlayerState>;
}

export interface MarketSyncEvent {
  timestamp: number;
  prices: Record<string, number>;
  sellPrices: Record<string, number>;
  basePrices: Record<string, number>;
  reserves: Record<string, number>;
  raw: Record<string, unknown>;
}

export interface TradeConfirmedEvent {
  tradeId: string;
  commodity: string;
  amount: number;
  isBuy: boolean;
  unitPrice: number;
  totalCredits: number;
  newBalance: number;
  inventory: Record<string, number>;
  quote: Record<string, number> | null;
  raw: Record<string, unknown>;
}

export interface ClaimStakedEvent {
  claimId: string;
  playerId: string;
  x: number;
  y: number;
  radius: number;
  claim: Record<string, unknown>;
}

export interface RailPlacedEvent {
  railId: string;
  p0: Vec3;
  p1: Vec3;
  length: number;
  gauge: number;
  builtBy: string | null;
}

export interface ClientErrorEvent {
  code: string;
  message: string;
  raw: Record<string, unknown> | null;
}

export interface ConnectionEvent {
  url: string;
  attempt?: number;
  delayMs?: number;
  code?: number;
  reason?: string;
  intentional?: boolean;
}

/** Typed event catalogue emitted by NetworkClient. */
export interface ClientEventMap {
  hello: Record<string, unknown>;
  connected: ConnectionEvent;
  reconnecting: ConnectionEvent;
  disconnected: ConnectionEvent;
  welcome: WelcomeEvent;
  world_delta: WorldDeltaEvent;
  market_sync: MarketSyncEvent;
  trade_confirmed: TradeConfirmedEvent;
  claim_staked: ClaimStakedEvent;
  rail_placed: RailPlacedEvent;
  error: ClientErrorEvent;
  pong: Record<string, unknown>;
  player_joined: Record<string, unknown>;
  player_left: Record<string, unknown>;
  mine_result: Record<string, unknown>;
  claim_result: Record<string, unknown>;
  rail_laid: Record<string, unknown>;
  /** Raw passthrough of every successfully parsed inbound frame. */
  message: Record<string, unknown>;
}

type EventHandler<K extends keyof ClientEventMap> = (payload: ClientEventMap[K]) => void;

// ---------------------------------------------------------------------------
// Isomorphic socket plumbing
// ---------------------------------------------------------------------------

/**
 * Minimal transport contract satisfied by the browser `WebSocket`, the `ws`
 * package, and the harness's fake sockets (all via the `on*` property style,
 * which both real implementations support).
 */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen?: (() => void) | null;
  onmessage?: ((data: unknown) => void) | null;
  onerror?: ((err: unknown) => void) | null;
  onclose?: ((info: { code: number; reason: string }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export const SOCKET_OPEN = 1;

/** Resolve a socket factory: injected factory > global WebSocket > `ws` package. */
async function resolveSocketFactory(
  injected?: SocketFactory,
): Promise<SocketFactory> {
  if (injected !== undefined) return injected;
  const g = globalThis as { WebSocket?: unknown };
  if (typeof g.WebSocket === 'function') {
    const Impl = g.WebSocket as new (url: string) => unknown;
    return (url: string) => new Impl(url) as unknown as SocketLike;
  }
  try {
    // `@vite-ignore` keeps browser bundlers from statically resolving `ws`
    // (which drags in node:stream); browsers never reach this tier anyway.
    const mod = (await import(/* @vite-ignore */ 'ws')) as unknown as Record<string, unknown>;
    const impl = (mod['default'] ?? mod['WebSocket'] ?? mod) as unknown;
    if (typeof impl === 'function') {
      return (url: string) => new (impl as new (u: string) => unknown)(url) as unknown as SocketLike;
    }
  } catch {
    /* no `ws` module (browser bundle) — fall through to the error below */
  }
  throw new Error(
    'NetworkClient: no WebSocket implementation available — pass options.socketFactory, ' +
      'run on Node >= 22 (global WebSocket) or install `ws`.',
  );
}

/** Both `onmessage` call styles in the wild: browser passes MessageEvent, `ws` passes raw data. */
function decodeFrameData(data: unknown): string | null {
  if (typeof data === 'string') return data;
  const maybe = data as { data?: unknown } | null;
  if (maybe !== null && typeof maybe === 'object' && 'data' in maybe) {
    const inner = maybe.data;
    if (typeof inner === 'string') return inner;
    if (inner instanceof Uint8Array) return new TextDecoder().decode(inner);
  }
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return data === undefined || data === null ? null : String(data);
}

// ---------------------------------------------------------------------------
// Small maths helpers
// ---------------------------------------------------------------------------

/**
 * Isomorphic timer unref: Node timers carry `.unref()` (so a pending poll or
 * backoff never keeps the process alive); browser timers are plain numbers.
 */
function unrefTimer(handle: unknown): void {
  const maybe = handle as { unref?: () => void } | undefined | null;
  if (maybe !== undefined && maybe !== null && typeof maybe.unref === 'function') {
    maybe.unref();
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clampFinite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const parts: number[] = [];
  for (const part of value) {
    const n = finiteOrNull(part);
    if (n === null) return null;
    parts.push(n);
  }
  return [parts[0], parts[1], parts[2]];
}

/** `vein-water_ice-042` → 'water_ice' (spec-13 vein ids carry the resource). */
const VEIN_ID_RE = /^vein-([a-z0-9_]+)-\d+$/i;
const MINING_RESOURCES: readonly MiningResource[] = [
  'regolith',
  'water_ice',
  'helium3',
  'rare_earths',
];

function resourceFromVeinId(veinId: string): MiningResource | undefined {
  const m = VEIN_ID_RE.exec(veinId);
  if (m === null) return undefined;
  const candidate = m[1].toLowerCase();
  return MINING_RESOURCES.find((r) => r === candidate);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const DEFAULT_RECONNECT_BASE_MS = 250;
export const DEFAULT_RECONNECT_MAX_MS = 8_000;
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 12;
export const DEFAULT_HEARTBEAT_MS = 5_000;
export const DEFAULT_PONG_TIMEOUT_MS = 2_000;

export const TICK_HZ = 20;
export const TICK_INTERVAL_MS = 1000 / TICK_HZ;
/** ADR-013-2: lerp remote avatars over one 20 Hz frame window (50 ms). */
export const DEFAULT_INTERPOLATION_WINDOW_MS = TICK_INTERVAL_MS;
/** Tolerate this much 20 Hz arrival jitter before extrapolating. */
export const DEFAULT_DEAD_RECKONING_GRACE_MS = 25;
/** …and never project further than this past the last snapshot. */
export const MAX_EXTRAPOLATION_MS = 1_000;
/**
 * Per-axis cap on velocity *inferred* from position-only deltas, in m/s. A
 * 57 m jump inside one 50 ms tick is a teleport (spawn, server correction),
 * not an 1140 m/s sprint — uncapped inference makes avatars fly past their
 * own targets. Server-reported velocities are never clamped. (Buggy tops out
 * at 12 m/s, suit at 3 — 30 leaves generous headroom.)
 */
export const MAX_INFERRED_SPEED_M = 30;

export const DEFAULT_CLAIM_RADIUS = 20;

export interface NetworkClientOptions {
  /** ws(s):// endpoint. Defaults to WS_URL env, then `location.host`, then ws://127.0.0.1:3000/ws. */
  url?: string;
  /** Transport injection (browser global is auto-detected; Node tests pass a `ws` factory). */
  socketFactory?: SocketFactory;
  /** Reconnect after unplanned drops (default true). */
  autoReconnect?: boolean;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxReconnectAttempts?: number;
  /** 0 disables the heartbeat. */
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  interpolationWindowMs?: number;
  deadReckoningGraceMs?: number;
  /** Inject a deterministic clock (tests); defaults to Date.now. */
  clock?: () => number;
}

export type NetworkClientState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closing'
  | 'closed';

interface HistoryEntry {
  type: string;
  payload: unknown;
  seen: boolean;
}

// ---------------------------------------------------------------------------
// NetworkClient
// ---------------------------------------------------------------------------

export class NetworkClient {
  /** Live remote avatars keyed by player id (ADR-013-2). */
  public readonly remotePlayers = new Map<string, RemotePlayer>();

  public readonly url: string;

  private readonly socketFactory: SocketFactory | undefined;
  private readonly autoReconnectEnabled: boolean;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly heartbeatMs: number;
  private readonly pongTimeoutMs: number;
  private readonly interpolationWindowMs: number;
  private readonly deadReckoningGraceMs: number;
  private readonly clock: () => number;

  private ws: SocketLike | null = null;
  private socketState = 'idle' as NetworkClientState;
  private manuallyClosed = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectPromise: Promise<void> | null = null;

  /** FIFO of pings awaiting their pong (server does not echo client `t`). */
  private pendingPings: Array<{ sentAt: number }> = [];
  private pongCount = 0;
  private lastPingSentAt: number | null = null;
  private lastPongReceivedAt: number | null = null;
  private latencies: number[] = [];

  private joined: { username: string; faction: string; role: string } | null = null;
  private identity: PlayerIdentity | null = null;
  private inventory: Record<string, number> = {};
  private latestMarket: Record<string, unknown> | null = null;
  private worldClaims: unknown[] = [];
  private worldRails: unknown[] = [];
  private worldTick = 0;

  private readonly handlers = new Map<string, Set<(payload: never) => void>>();
  private readonly history: HistoryEntry[] = [];
  private static readonly HISTORY_LIMIT = 512;

  constructor(options: NetworkClientOptions = {}) {
    this.url = options.url ?? NetworkClient.detectServerUrl();
    this.socketFactory = options.socketFactory;
    this.autoReconnectEnabled = options.autoReconnect ?? true;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.heartbeatMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.interpolationWindowMs = options.interpolationWindowMs ?? DEFAULT_INTERPOLATION_WINDOW_MS;
    this.deadReckoningGraceMs = options.deadReckoningGraceMs ?? DEFAULT_DEAD_RECKONING_GRACE_MS;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Endpoint discovery per spec 13 §6: explicit option > WS_URL env var >
   * the page's own host (`wss://` on https) > loopback dev default.
   */
  static detectServerUrl(): string {
    const env =
      typeof process !== 'undefined' && process.env ? process.env['WS_URL'] : undefined;
    if (typeof env === 'string' && env.length > 0) return env;
    if (typeof location !== 'undefined' && typeof location.host === 'string' && location.host.length > 0) {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      return `${scheme}://${location.host}/ws`;
    }
    return 'ws://127.0.0.1:3000/ws';
  }

  // -- lifecycle ---------------------------------------------------------------

  /** Current lifecycle state. */
  get state(): NetworkClientState {
    return this.socketState;
  }

  /**
   * Opens the socket (resolving the transport first). Resolves once OPEN —
   * the `welcome` event follows after `join()`. Safe to call while already
   * reconnecting: it cancels the backoff timer and retries immediately.
   */
  async connect(): Promise<void> {
    if (this.socketState === 'open') return;
    if (this.connectPromise !== null) return this.connectPromise;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const p = this.openConnection();
    this.connectPromise = p;
    try {
      await p;
    } finally {
      if (this.connectPromise === p) this.connectPromise = null;
    }
  }

  private async openConnection(): Promise<void> {
    this.manuallyClosed = false;
    this.socketState = 'connecting';
    const factory = await resolveSocketFactory(this.socketFactory);
    const ws = factory(this.url);
    this.ws = ws;

    let opened = false;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      ws.onopen = () => {
        opened = true;
        settled = true;
        resolve();
      };
      ws.onmessage = (data: unknown) => {
        this.handleFrame(data);
      };
      ws.onerror = (err: unknown) => {
        if (!opened) fail(new Error(`NetworkClient: websocket connect failed: ${String(err)}`));
      };
      ws.onclose = (info: { code: number; reason: string }) => {
        if (!opened) {
          fail(new Error(`NetworkClient: socket closed before opening (code ${info?.code})`));
        } else {
          this.handleClose(info);
        }
      };
    }).catch((err: Error) => {
      this.ws = null;
      this.socketState = this.autoReconnectEnabled ? 'reconnecting' : 'closed';
      this.dispatchLocal('error', { code: 'connect_failed', message: err.message, raw: null });
      this.scheduleReconnect();
      throw err;
    });

    this.socketState = 'open';
    this.reconnectAttempts = 0;
    this.pendingPings = [];
    this.pingsSentCount = 0;
    this.startHeartbeat();
    this.dispatchLocal('connected', { url: this.url });
    this.flushPending();
    // Session continuity: an auto-reconnect re-presents the last JOIN.
    if (this.joined !== null) {
      const { username, faction, role } = this.joined;
      this.join(username, faction, role);
    }
  }

  /**
   * Graceful disconnect — no reconnect is scheduled. Idempotent.
   */
  disconnect(code = 1000, reason = 'client disconnect'): void {
    this.manuallyClosed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.ws === null) {
      this.socketState = 'closed';
      this.dispatchLocal('disconnected', { url: this.url, intentional: true, code, reason });
      return;
    }
    this.socketState = 'closing';
    try {
      this.ws.close(code, reason);
    } catch {
      /* already gone — the close handler (if any) finishes the job */
    }
  }

  /** Disconnect and drop all event handlers (teardown for tests / HMR). */
  destroy(): void {
    this.disconnect();
    this.handlers.clear();
    this.history.length = 0;
    this.remotePlayers.clear();
  }

  private handleClose(info: { code: number; reason: string } | undefined): void {
    this.stopHeartbeat();
    this.pendingPings = [];
    const wasIntentional = this.manuallyClosed;
    this.ws = null;
    this.dispatchLocal('disconnected', {
      url: this.url,
      intentional: wasIntentional,
      code: info?.code,
      reason: info?.reason,
    });
    if (wasIntentional) {
      this.socketState = 'closed';
      return;
    }
    this.socketState = 'reconnecting';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnectEnabled || this.manuallyClosed) {
      this.socketState = 'closed';
      return;
    }
    if (this.reconnectTimer !== null) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.socketState = 'closed';
      this.dispatchLocal('error', {
        code: 'reconnect_exhausted',
        message: `gave up after ${this.reconnectAttempts} reconnect attempts`,
        raw: null,
      });
      return;
    }
    const attempt = this.reconnectAttempts + 1;
    this.reconnectAttempts = attempt;
    const exponential = Math.min(
      this.reconnectBaseMs * 2 ** (attempt - 1),
      this.reconnectMaxMs,
    );
    // ±15 % jitter so a server restart doesn't stampede every client.
    const jitter = 0.85 + Math.random() * 0.3;
    const delayMs = Math.round(exponential * jitter);
    this.dispatchLocal('reconnecting', { url: this.url, attempt, delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, delayMs);
  }

  // -- heartbeat -----------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (!(this.heartbeatMs > 0)) return;
    this.heartbeatTimer = setInterval(() => this.ping(), this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Sends a heartbeat PING. The server answers with `{ type:'PONG', t }`
   * (its own clock — the client `t` is not echoed), so RTT is measured
   * FIFO: the next PONG closes out the oldest outstanding ping.
   */
  ping(): boolean {
    if (this.socketState !== 'open' || this.ws === null) return false;
    const sentAt = this.clock();
    this.lastPingSentAt = sentAt;
    this.pingsSentCount++;
    this.pendingPings.push({ sentAt });
    if (this.pendingPings.length > 16) this.pendingPings.shift();
    this.sendFrame({ type: 'PING', payload: { t: sentAt } });

    // Dead-link detection: no PONG within the timeout tears the socket down
    // and the normal close path reconnects.
    const pongsBefore = this.pongCount;
    unrefTimer(
      setTimeout(() => {
        if (this.socketState === 'open' && this.pongCount === pongsBefore) {
          try {
            this.ws?.close(4000, 'heartbeat timeout');
          } catch {
            /* socket already gone */
          }
        }
      }, this.pongTimeoutMs),
    );
    return true;
  }

  /** RTT (ms) of the most recent completed PING, or null. */
  get latencyMs(): number | null {
    return this.latencies.length > 0 ? this.latencies[this.latencies.length - 1] : null;
  }

  /** Rolling average RTT (ms) over the last 20 samples, or null. */
  get averageLatencyMs(): number | null {
    if (this.latencies.length === 0) return null;
    const sum = this.latencies.reduce((a, b) => a + b, 0);
    return sum / this.latencies.length;
  }

  /** Mean absolute deviation of RTT (ms) — a cheap jitter estimate. */
  get jitterMs(): number | null {
    const avg = this.averageLatencyMs;
    if (avg === null) return null;
    const dev = this.latencies.reduce((a, b) => a + Math.abs(b - avg), 0);
    return dev / this.latencies.length;
  }

  /** Total PING frames sent since connect() — tracked via sent-timestamps. */
  private pingsSentCount = 0;

  get pingsSent(): number {
    return this.pingsSentCount;
  }

  get pongsReceived(): number {
    return this.pongCount;
  }

  private recordPong(): void {
    this.pongCount++;
    this.lastPongReceivedAt = this.clock();
    const pending = this.pendingPings.shift();
    if (pending !== undefined) {
      const rtt = this.lastPongReceivedAt - pending.sentAt;
      this.latencies.push(rtt);
      if (this.latencies.length > 20) this.latencies.shift();
    }
  }

  // -- outbound protocol ----------------------------------------------------------

  /**
   * Register/register with the server. Must precede MOVE/MINE/CLAIM/TRADE.
   * Repeated calls (including the automatic re-JOIN after a reconnect) are
   * legal — the server rebinds the session by username.
   */
  join(username: string, faction = 'unaffiliated', role = 'surveyor'): void {
    if (typeof username !== 'string' || username.trim().length < 1 || username.length > 32) {
      throw new TypeError('NetworkClient.join: username must be 1-32 characters');
    }
    this.joined = { username, faction, role };
    this.sendFrame({ type: 'JOIN', payload: { username, faction, role } });
  }

  /** Replicate local movement (position + velocity + traversal mode). */
  sendMove(state: MoveState): void {
    if (state === null || typeof state !== 'object') {
      throw new TypeError('NetworkClient.sendMove: MoveState object required');
    }
    for (const key of ['x', 'y', 'z'] as const) {
      if (!Number.isFinite(state[key])) {
        throw new TypeError(`NetworkClient.sendMove: ${key} must be a finite number`);
      }
    }
    const payload: Record<string, unknown> = { x: state.x, y: state.y, z: state.z };
    for (const key of ['vx', 'vy', 'vz', 'yaw', 'pitch'] as const) {
      const v = state[key];
      if (v !== undefined) {
        if (!Number.isFinite(v)) throw new TypeError(`NetworkClient.sendMove: ${key} must be finite`);
        payload[key] = v;
      }
    }
    if (state.mode !== undefined) {
      if (state.mode !== 'suit' && state.mode !== 'buggy') {
        throw new TypeError("NetworkClient.sendMove: mode must be 'suit' or 'buggy'");
      }
      payload.mode = state.mode;
    }
    this.sendFrame({ type: 'MOVE', payload });
  }

  /** Stake a claim (server debits credits; `claim_result` acks, `claim_staked` fans out). */
  stakeClaim(coords: ClaimCoords): void {
    if (coords === null || typeof coords !== 'object') {
      throw new TypeError('NetworkClient.stakeClaim: coords object required');
    }
    if (!Number.isFinite(coords.x) || !Number.isFinite(coords.y)) {
      throw new TypeError('NetworkClient.stakeClaim: x and y must be finite numbers');
    }
    const radius = coords.radius ?? DEFAULT_CLAIM_RADIUS;
    if (!Number.isFinite(radius) || radius < 1 || radius > 500) {
      throw new TypeError('NetworkClient.stakeClaim: radius must be 1-500');
    }
    const payload: Record<string, unknown> = {
      claim_type: coords.kind ?? 'surface',
      x: coords.x,
      y: coords.y,
      radius,
    };
    if (coords.z !== undefined) payload.z = coords.z;
    this.sendFrame({ type: 'CLAIM', payload });
  }

  /**
   * Mine from a vein. Spec 13 spells the request `{ vein_id, amount }` while
   * the authoritative server keys permission checks on `resource` — so the
   * frame carries both: `vein_id` verbatim and `resource` either given
   * explicitly or derived from a `vein-<kind>-<n>` id (else 'regolith',
   * the only resource legal on unclaimed ground).
   */
  mine(veinId: string, amount = 10, resource?: MiningResource): void {
    if (typeof veinId !== 'string' || veinId.length === 0) {
      throw new TypeError('NetworkClient.mine: vein_id must be a non-empty string');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new TypeError('NetworkClient.mine: amount must be > 0');
    }
    const resolved = resource ?? resourceFromVeinId(veinId) ?? 'regolith';
    this.sendFrame({ type: 'MINE', payload: { vein_id: veinId, resource: resolved, amount } });
  }

  /** Station market order against the bonding curve (server acks `trade_confirmed`). */
  trade(commodity: string, amount: number, isBuy: boolean): void {
    if (typeof commodity !== 'string' || commodity.trim().length === 0) {
      throw new TypeError('NetworkClient.trade: commodity must be a non-empty string');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new TypeError('NetworkClient.trade: amount must be a finite number > 0');
    }
    if (typeof isBuy !== 'boolean') {
      throw new TypeError('NetworkClient.trade: is_buy must be a boolean');
    }
    this.sendFrame({ type: 'TRADE', payload: { commodity, amount, is_buy: isBuy } });
  }

  /** Lay a rail segment p0→p1 (1–100 m, may not straddle the surface line). */
  layRail(p0: Vec3, p1: Vec3): void {
    const a = asVec3(p0);
    const b = asVec3(p1);
    if (a === null || b === null) {
      throw new TypeError('NetworkClient.layRail: p0 and p1 must each be [x, y, z] finite numbers');
    }
    this.sendFrame({ type: 'LAY_RAIL', payload: { p0: a, p1: b } });
  }

  /** Ask the server to push a fresh `market_sync` right now. */
  marketQuery(): void {
    this.sendFrame({ type: 'MARKET_QUERY', payload: {} });
  }

  /** Escape hatch for protocol extensions / tests: send a raw JSON-serialisable frame. */
  sendRaw(frame: Record<string, unknown>): void {
    this.sendFrame(frame);
  }

  /**
   * Serialises + sends (or buffers, while opening) one frame.
   * Returns false when the frame was dropped (closed socket).
   */
  private pendingFrames: string[] = [];

  private sendFrame(frame: Record<string, unknown>): boolean {
    const data = JSON.stringify(frame);
    if (this.ws !== null && this.ws.readyState === SOCKET_OPEN) {
      this.ws.send(data);
      return true;
    }
    if (this.socketState === 'connecting' || this.socketState === 'open') {
      // Opening gap (or a race between close detection and state flip):
      // buffer so a JOIN issued right after connect() is never lost.
      this.pendingFrames.push(data);
      if (this.pendingFrames.length > 256) this.pendingFrames.shift();
      return true;
    }
    return false;
  }

  private flushPending(): void {
    if (this.ws === null || this.ws.readyState !== SOCKET_OPEN) return;
    const queued = this.pendingFrames;
    this.pendingFrames = [];
    for (const data of queued) this.ws.send(data);
  }

  // -- inbound dispatch -------------------------------------------------------------

  /**
   * Ingest one raw wire frame (string / Buffer / MessageEvent). Public so
   * tests and alternative transports can drive the dispatcher without a
   * socket. Never throws on malformed input — it dispatches `error` instead.
   */
  handleFrame(raw: unknown): void {
    const text = decodeFrameData(raw);
    if (text === null) {
      this.dispatchLocal('error', { code: 'empty_frame', message: 'received an empty frame', raw: null });
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      this.dispatchLocal('error', {
        code: 'bad_json',
        message: (err as Error).message,
        raw: null,
      });
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      this.dispatchLocal('error', {
        code: 'bad_frame',
        message: 'frame must be a JSON object',
        raw: null,
      });
      return;
    }
    const frame = msg as Record<string, unknown>;
    const type = typeof frame['type'] === 'string' ? (frame['type'] as string) : '';
    this.dispatchLocal('message', frame);

    switch (type) {
      case 'hello':
        this.dispatchLocal('hello', frame);
        break;
      case 'welcome':
        this.dispatchLocal('welcome', this.applyWelcome(frame));
        break;
      case 'tick':
        // Spec 13 §3.2 calls these world_delta frames; the server's wire
        // name is `tick`. One event, both vocabularies.
        this.dispatchLocal('world_delta', this.applyTick(frame));
        break;
      case 'market_sync':
        this.dispatchLocal('market_sync', this.applyMarketSync(frame));
        break;
      case 'trade_confirmed':
        this.dispatchLocal('trade_confirmed', this.normalizeTrade(frame));
        break;
      case 'claim_staked':
        this.dispatchLocal('claim_staked', this.applyClaimStaked(frame));
        break;
      case 'rail_placed':
        this.dispatchLocal('rail_placed', this.applyRailPlaced(frame));
        break;
      case 'claim_result': {
        const rec = asRecord(frame);
        const credits = finiteOrNull(rec['credits']);
        if (credits !== null && this.identity !== null) this.identity.credits = credits;
        this.dispatchLocal('claim_result', rec);
        break;
      }
      case 'mine_result': {
        const rec = asRecord(frame);
        const credits = finiteOrNull(rec['credits']);
        if (credits !== null && this.identity !== null) this.identity.credits = credits;
        const inv = rec['inventory'];
        if (typeof inv === 'object' && inv !== null) {
          this.inventory = inv as Record<string, number>;
        }
        this.dispatchLocal('mine_result', rec);
        break;
      }
      case 'rail_laid':
        this.dispatchLocal('rail_laid', asRecord(frame));
        break;
      case 'player_joined': {
        const rec = asRecord(frame);
        const id = typeof rec['player_id'] === 'string' ? (rec['player_id'] as string) : '';
        const state = asRecord(rec['state']);
        if (id.length > 0 && id !== this.playerId) {
          this.applyDeltaToRemote(id, state as RemotePlayerState, this.clock());
        }
        this.dispatchLocal('player_joined', rec);
        break;
      }
      case 'player_left': {
        const rec = asRecord(frame);
        const id = typeof rec['player_id'] === 'string' ? (rec['player_id'] as string) : '';
        this.remotePlayers.delete(id);
        this.dispatchLocal('player_left', rec);
        break;
      }
      case 'PONG':
        this.recordPong();
        this.dispatchLocal('pong', frame);
        break;
      case 'error': {
        const rec = asRecord(frame);
        this.dispatchLocal('error', {
          code: typeof rec['code'] === 'string' ? (rec['code'] as string) : 'server_error',
          message: typeof rec['message'] === 'string' ? (rec['message'] as string) : 'unspecified server error',
          raw: rec,
        });
        break;
      }
      default:
        // Unknown-but-valid frames arrive on `message` only; forward
        // compatibility beats error spam.
        break;
    }
  }

  private applyWelcome(frame: Record<string, unknown>): WelcomeEvent {
    const p = asRecord(frame['player']);
    const identity: PlayerIdentity = {
      id: typeof p['id'] === 'string' ? (p['id'] as string) : '',
      username: typeof p['username'] === 'string' ? (p['username'] as string) : '',
      faction: typeof p['faction'] === 'string' ? (p['faction'] as string) : 'unaffiliated',
      role: typeof p['role'] === 'string' ? (p['role'] as string) : 'surveyor',
      credits: finiteOrNull(p['credits']) ?? 0,
    };
    this.identity = identity;

    const inv = asRecord(frame['inventory']);
    this.inventory = inv as Record<string, number>;
    this.latestMarket = frame['market'] !== undefined ? asRecord(frame['market']) : null;

    const world = asRecord(frame['world']);
    this.worldClaims = Array.isArray(world['claims']) ? world['claims'] : [];
    this.worldRails = Array.isArray(world['rail_tracks']) ? world['rail_tracks'] : [];

    return {
      player: identity,
      state: asRecord(frame['state']),
      resources: asRecord(frame['resources']),
      inventory: this.inventory,
      world: {
        claims: this.worldClaims,
        infrastructure: Array.isArray(world['infrastructure']) ? world['infrastructure'] : [],
        rail_tracks: this.worldRails,
      },
      ownClaims: Array.isArray(frame['own_claims']) ? frame['own_claims'] : [],
      market: this.latestMarket,
      uptime: finiteOrNull(frame['uptime']) ?? 0,
    };
  }

  /** Server tick frame → normalized world_delta + remote-avatar target updates. */
  private applyTick(frame: Record<string, unknown>): WorldDeltaEvent {
    this.worldTick++;
    const players: Record<string, RemotePlayerState> = {};
    const list = frame['players'];
    const now = this.clock();
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (typeof entry !== 'object' || entry === null) continue;
        const rec = entry as Record<string, unknown>;
        const id = typeof rec['id'] === 'string' ? (rec['id'] as string) : '';
        if (id.length === 0 || id === this.playerId) continue; // never your own remote
        const delta: RemotePlayerState = {};
        if (typeof rec['username'] === 'string') delta.username = rec['username'];
        for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'credits'] as const) {
          const n = finiteOrNull(rec[key]);
          if (n !== null) delta[key] = n;
        }
        if (rec['mode'] === 'suit' || rec['mode'] === 'buggy') delta.mode = rec['mode'];
        players[id] = delta;
        this.applyDeltaToRemote(id, delta, now);
      }
    }
    return { tick: this.worldTick, serverTime: finiteOrNull(frame['t']), players };
  }

  private applyMarketSync(frame: Record<string, unknown>): MarketSyncEvent {
    const prices: Record<string, number> = {};
    const sellPrices: Record<string, number> = {};
    const basePrices: Record<string, number> = {};
    const reserves: Record<string, number> = {};
    const collect = (src: unknown, into: Record<string, number>): void => {
      if (typeof src !== 'object' || src === null) return;
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        const n = finiteOrNull(v);
        if (n !== null) into[k] = n;
      }
    };
    collect(frame['prices'], prices);
    collect(frame['sell_prices'], sellPrices);
    collect(frame['base_prices'], basePrices);
    collect(frame['reserves'], reserves);
    this.latestMarket = {
      timestamp: frame['timestamp'],
      prices,
      sellPrices,
      basePrices,
      reserves,
    };
    return {
      timestamp: finiteOrNull(frame['timestamp']) ?? 0,
      prices,
      sellPrices,
      basePrices,
      reserves,
      raw: frame,
    };
  }

  private normalizeTrade(frame: Record<string, unknown>): TradeConfirmedEvent {
    const quoteRaw = frame['quote'];
    const quote: Record<string, number> | null =
      typeof quoteRaw === 'object' && quoteRaw !== null
        ? (quoteRaw as Record<string, number>)
        : null;
    const inv = asRecord(frame['inventory']);
    this.inventory = inv as Record<string, number>;
    const newBalance = finiteOrNull(frame['new_balance']) ?? finiteOrNull(frame['credits']) ?? 0;
    if (this.identity !== null) this.identity.credits = newBalance;
    return {
      tradeId: typeof frame['trade_id'] === 'string' ? (frame['trade_id'] as string) : '',
      commodity: typeof frame['commodity'] === 'string' ? (frame['commodity'] as string) : '',
      amount: finiteOrNull(frame['amount']) ?? 0,
      isBuy: frame['is_buy'] === true,
      unitPrice: finiteOrNull(frame['unit_price']) ?? 0,
      totalCredits: finiteOrNull(frame['total_credits']) ?? 0,
      newBalance,
      inventory: this.inventory,
      quote,
      raw: frame,
    };
  }

  private applyClaimStaked(frame: Record<string, unknown>): ClaimStakedEvent {
    const claim = asRecord(frame['claim']);
    const event: ClaimStakedEvent = {
      claimId: typeof claim['id'] === 'string' ? (claim['id'] as string) : '',
      playerId: typeof claim['player_id'] === 'string' ? (claim['player_id'] as string) : '',
      x: finiteOrNull(claim['x']) ?? 0,
      y: finiteOrNull(claim['y']) ?? 0,
      radius: finiteOrNull(claim['radius']) ?? 0,
      claim,
    };
    if (event.claimId.length > 0) this.worldClaims.push(claim);
    return event;
  }

  private applyRailPlaced(frame: Record<string, unknown>): RailPlacedEvent {
    const event: RailPlacedEvent = {
      railId: typeof frame['rail_id'] === 'string' ? (frame['rail_id'] as string) : '',
      p0: asVec3(frame['p0']) ?? [0, 0, 0],
      p1: asVec3(frame['p1']) ?? [0, 0, 0],
      length: finiteOrNull(frame['length']) ?? 0,
      gauge: finiteOrNull(frame['gauge']) ?? 0,
      builtBy: typeof frame['built_by'] === 'string' ? (frame['built_by'] as string) : null,
    };
    if (event.railId.length > 0) {
      this.worldRails.push({
        id: event.railId,
        x0: event.p0[0], y0: event.p0[1], z0: event.p0[2],
        x1: event.p1[0], y1: event.p1[1], z1: event.p1[2],
        length: event.length,
        gauge: event.gauge,
        built_by: event.builtBy,
      });
    }
    return event;
  }

  // -- remote entity tracking & interpolation (ADR-013-2) ------------------------------

  /**
   * Feed one peer delta into the tracker. Partial frames only overwrite the
   * fields they carry; velocity, when absent, keeps its last non-zero value
   * for dead reckoning. Origin for the next lerp is the *current render
   * position*, which keeps avatar motion C0-continuous (no snap-back).
   */
  applyDeltaToRemote(id: string, delta: RemotePlayerState, now = this.clock()): RemotePlayer {
    let p = this.remotePlayers.get(id);
    if (p === undefined) {
      const x = clampFinite(delta.x ?? 0, 0);
      const y = clampFinite(delta.y ?? 0, 0);
      const z = clampFinite(delta.z ?? 0, 0);
      p = {
        id,
        username: delta.username ?? '',
        mode: delta.mode ?? 'suit',
        credits: delta.credits,
        x, y, z,
        vx: clampFinite(delta.vx ?? 0, 0),
        vy: clampFinite(delta.vy ?? 0, 0),
        vz: clampFinite(delta.vz ?? 0, 0),
        originX: x, originY: y, originZ: z,
        lastSnapshotAt: now,
        hasVelocity: delta.vx !== undefined || delta.vy !== undefined || delta.vz !== undefined,
        lastVx: delta.vx ?? 0, lastVy: delta.vy ?? 0, lastVz: delta.vz ?? 0,
        deadReckoned: false,
        renderX: x, renderY: y, renderZ: z,
      };
      this.remotePlayers.set(id, p);
      return p;
    }

    // Re-anchor the interpolation start at wherever we are *rendering* now.
    p.originX = p.renderX;
    p.originY = p.renderY;
    p.originZ = p.renderZ;

    if (delta.username !== undefined) p.username = delta.username;
    if (delta.mode !== undefined) p.mode = delta.mode;
    if (delta.credits !== undefined) p.credits = delta.credits;
    if (delta.x !== undefined) p.x = clampFinite(delta.x, p.x);
    if (delta.y !== undefined) p.y = clampFinite(delta.y, p.y);
    if (delta.z !== undefined) p.z = clampFinite(delta.z, p.z);

    let sawVelocity = false;
    if (delta.vx !== undefined) { p.vx = clampFinite(delta.vx, p.vx); sawVelocity = true; }
    if (delta.vy !== undefined) { p.vy = clampFinite(delta.vy, p.vy); sawVelocity = true; }
    if (delta.vz !== undefined) { p.vz = clampFinite(delta.vz, p.vz); sawVelocity = true; }
    if (sawVelocity) {
      // Server-reported velocity is authoritative — even an explicit zero.
      p.hasVelocity = true;
      p.lastVx = p.vx;
      p.lastVy = p.vy;
      p.lastVz = p.vz;
    } else if (!p.hasVelocity) {
      // The server has never reported velocity for this peer (e.g. it joined
      // mid-sprint and velocity is delta-suppressed): infer it from the
      // position step so dead reckoning has a heading, capped so a teleport
      // cannot mint a lightspeed vector.
      const dt = Math.max(now - p.lastSnapshotAt, 1);
      const cap = MAX_INFERRED_SPEED_M;
      const implied = (target: number, origin: number): number =>
        Math.min(cap, Math.max(-cap, ((target - origin) / dt) * 1000));
      p.lastVx = implied(p.x, p.originX);
      p.lastVy = implied(p.y, p.originY);
      p.lastVz = implied(p.z, p.originZ);
    }

    p.lastSnapshotAt = now;
    p.deadReckoned = false;
    return p;
  }

  /**
   * Advance interpolation for every remote avatar. Call once per render
   * frame (60 fps): positions lerp toward the authoritative target over one
   * 50 ms tick window; snapshots arriving slightly late (within the grace
   * band) hold at the target instead of stuttering; once an avatar ages past
   * window + grace it dead-reckons along its velocity vector until
   * MAX_EXTRAPOLATION_MS.
   */
  update(now = this.clock()): void {
    const windowMs = Math.max(this.interpolationWindowMs, 1);
    const gateMs = windowMs + Math.max(this.deadReckoningGraceMs, 0);
    for (const p of this.remotePlayers.values()) {
      const since = now - p.lastSnapshotAt;
      if (since <= gateMs) {
        const t = Math.min(since / windowMs, 1);
        p.renderX = lerp(p.originX, p.x, t);
        p.renderY = lerp(p.originY, p.y, t);
        p.renderZ = lerp(p.originZ, p.z, t);
        p.deadReckoned = false;
      } else {
        const extrapolateMs = Math.min(since - gateMs, MAX_EXTRAPOLATION_MS);
        // Authoritative velocity (server-reported, sticky) wins — including
        // an explicit zero, which must NOT fall through to inferred motion.
        const vx = p.hasVelocity ? p.vx : p.lastVx;
        const vy = p.hasVelocity ? p.vy : p.lastVy;
        const vz = p.hasVelocity ? p.vz : p.lastVz;
        p.renderX = clampFinite(p.x + (vx * extrapolateMs) / 1000, p.x);
        p.renderY = clampFinite(p.y + (vy * extrapolateMs) / 1000, p.y);
        p.renderZ = clampFinite(p.z + (vz * extrapolateMs) / 1000, p.z);
        p.deadReckoned = extrapolateMs > 0;
      }
    }
  }

  getRemote(id: string): RemotePlayer | undefined {
    return this.remotePlayers.get(id);
  }

  /** Where the renderer should draw this peer right now (null if unknown). */
  getRenderPosition(id: string): { x: number; y: number; z: number } | null {
    const p = this.remotePlayers.get(id);
    if (p === undefined) return null;
    return { x: p.renderX, y: p.renderY, z: p.renderZ };
  }

  get remoteCount(): number {
    return this.remotePlayers.size;
  }

  // -- local state accessors -----------------------------------------------------------

  get playerId(): string | null {
    return this.identity?.id ?? null;
  }

  get username(): string | null {
    return this.identity?.username ?? null;
  }

  get credits(): number {
    return this.identity?.credits ?? 0;
  }

  get inventoryView(): Record<string, number> {
    return this.inventory;
  }

  get marketView(): Record<string, unknown> | null {
    return this.latestMarket;
  }

  get claimsView(): readonly unknown[] {
    return this.worldClaims;
  }

  get railsView(): readonly unknown[] {
    return this.worldRails;
  }

  get lastHeartbeatAt(): number | null {
    return this.lastPingSentAt;
  }

  get lastPongAt(): number | null {
    return this.lastPongReceivedAt;
  }

  // -- event emitter -------------------------------------------------------------------

  on<K extends keyof ClientEventMap>(type: K, handler: EventHandler<K>): this {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as (payload: never) => void);
    return this;
  }

  once<K extends keyof ClientEventMap>(type: K, handler: EventHandler<K>): this {
    const wrapped: EventHandler<K> = (payload) => {
      this.off(type, wrapped);
      handler(payload);
    };
    return this.on(type, wrapped);
  }

  off<K extends keyof ClientEventMap>(type: K, handler: EventHandler<K>): this {
    const set = this.handlers.get(type);
    if (set !== undefined) {
      set.delete(handler as (payload: never) => void);
      if (set.size === 0) this.handlers.delete(type);
    }
    return this;
  }

  /**
   * Await the next (or a specific, by predicate) event. Scans the bounded
   * event history first — with consumption marks, so sequential waiters never
   * re-consume the same frame — then polls until the deadline.
   */
  waitFor<K extends keyof ClientEventMap>(
    type: K,
    labelOrOptions?: string | { label?: string; timeoutMs?: number; filter?: (payload: ClientEventMap[K]) => boolean },
    timeoutMs = 5000,
  ): Promise<ClientEventMap[K]> {
    const filter =
      typeof labelOrOptions === 'object' && labelOrOptions !== null
        ? labelOrOptions.filter
        : undefined;
    const innerTimeout =
      typeof labelOrOptions === 'object' && labelOrOptions !== null && labelOrOptions.timeoutMs !== undefined
        ? labelOrOptions.timeoutMs
        : timeoutMs;
    const label =
      typeof labelOrOptions === 'string'
        ? labelOrOptions
        : (typeof labelOrOptions === 'object' && labelOrOptions !== null && labelOrOptions.label) || String(type);

    return new Promise<ClientEventMap[K]>((resolve, reject) => {
      const matches = (entry: HistoryEntry): boolean => {
        if (entry.type !== type || entry.seen) return false;
        if (filter === undefined) return true;
        try {
          return filter(entry.payload as ClientEventMap[K]);
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + innerTimeout;
      const poll = (): void => {
        const hit = this.history.find(matches);
        if (hit !== undefined) {
          hit.seen = true;
          resolve(hit.payload as ClientEventMap[K]);
          return;
        }
        if (Date.now() >= deadline) {
          reject(
            new Error(
              `NetworkClient: timed out after ${innerTimeout}ms waiting for "${label}" — recent types: ` +
                JSON.stringify(this.history.slice(-12).map((h) => ({ type: h.type, code: (h.payload as { code?: string })?.code }))),
            ),
          );
          return;
        }
        unrefTimer(setTimeout(poll, 10));
      };
      poll();
    });
  }

  private dispatchLocal<K extends keyof ClientEventMap>(type: K, payload: ClientEventMap[K]): void {
    this.history.push({ type, payload, seen: false });
    if (this.history.length > NetworkClient.HISTORY_LIMIT) {
      this.history.shift();
    }
    const set = this.handlers.get(type);
    if (set === undefined) return;
    for (const handler of [...set]) {
      try {
        (handler as (p: ClientEventMap[K]) => void)(payload);
      } catch {
        /* a throwing listener must not break the dispatch chain */
      }
    }
  }
}

export default NetworkClient;
