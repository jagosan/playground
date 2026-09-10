/**
 * Lunar Frontier — authoritative multiplayer server.
 *
 * Fastify HTTP surface (/health, /api/world) plus a WebSocket layer on /ws,
 * attached to Fastify's underlying Node HTTP server through the raw `upgrade`
 * event. Inbound protocol (JSON frames `{ type, payload? }`):
 *
 *   JOIN  — register/login a player; replies `welcome` with the world
 *           snapshot (claims + infrastructure) and the player's own state
 *   MOVE  — update position / velocity / traversal mode ('suit' | 'buggy')
 *   MINE  — extract resources with claim-permission validation
 *   CLAIM — stake a surface or subterranean claim for credits
 *   PING  — connectivity probe (answered with PONG)
 *
 * A 20 Hz tick broadcasts per-player *delta* state — only the fields that
 * changed since the previous tick — to every connected client. Players,
 * claims, and resource ledgers persist through DatabaseManager ('../database').
 *
 * Usage:
 *   const server = new LunarServer();
 *   await server.start();   // -> "http://0.0.0.0:3000"
 *   await server.stop();
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { WebSocketServer } from 'ws';

import DatabaseManager, {
  type ClaimRow,
  type PlayerRow,
  type ResourceRow,
} from '../database';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type TravelMode = 'suit' | 'buggy';
export type ClaimKind = 'surface' | 'subterranean';
/** One of the resource-ledger columns: regolith | water_ice | helium3 | rare_earths. */
export type ResourceType = keyof Omit<ResourceRow, 'player_id'>;

/** Authoritative live simulation state for one player. */
export interface PlayerSimState {
  playerId: string;
  username: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mode: TravelMode;
  credits: number;
}

export interface LunarServerOptions {
  /** TCP port (default: PORT env var, else 3000). */
  port?: number;
  /** Bind address (default: HOST env var, else '0.0.0.0'). */
  host?: string;
  /** WebSocket endpoint path (default '/ws'). */
  wsPath?: string;
  /** SQLite path when no DatabaseManager is injected (default './lunarfrontier.db'). */
  dbPath?: string;
  /** Inject a prepared DatabaseManager (tests / shared pools). Takes over its lifecycle. */
  database?: DatabaseManager;
  /** Enable Fastify's pino logger (default: false). */
  logger?: boolean;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 3000;
export const DEFAULT_WS_PATH = '/ws';
export const TICK_RATE_HZ = 20;

export const STARTING_CREDITS = 1000;
/** Credit cost of staking a claim of each kind. */
export const CLAIM_COSTS: Record<ClaimKind, number> = {
  surface: 500,
  subterranean: 1250,
};
/** Credits paid per unit of resource extracted. */
export const RESOURCE_PRICES: Record<ResourceType, number> = {
  regolith: 1,
  water_ice: 4,
  helium3: 50,
  rare_earths: 25,
};

export const MAX_POSITION = 1_000_000;
export const SUIT_MAX_SPEED = 3;
export const BUGGY_MAX_SPEED = 12;
export const MAX_MINE_AMOUNT = 1000;
export const MIN_CLAIM_RADIUS = 1;
export const MAX_CLAIM_RADIUS = 500;

const RESOURCE_TYPES: readonly ResourceType[] = [
  'regolith',
  'water_ice',
  'helium3',
  'rare_earths',
];

// ---------------------------------------------------------------------------
// Wire-protocol helpers — client input is `unknown` until proven otherwise
// ---------------------------------------------------------------------------

/** Any JSON object frame the server puts on the wire. */
type Outbound = Record<string, unknown> & { type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Finite number or `undefined` — never NaN/Infinity from the wire. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(lo, value), hi);
}

function asTravelMode(value: unknown): TravelMode | undefined {
  return value === 'suit' || value === 'buggy' ? value : undefined;
}

function asClaimKind(value: unknown): ClaimKind | undefined {
  return value === 'surface' || value === 'subterranean' ? value : undefined;
}

function asResourceType(value: unknown): ResourceType | undefined {
  return RESOURCE_TYPES.includes(value as ResourceType)
    ? (value as ResourceType)
    : undefined;
}

// ---------------------------------------------------------------------------
// LunarServer
// ---------------------------------------------------------------------------

export class LunarServer {
  /** The Fastify application (routes registered at construction). */
  public readonly app: FastifyInstance;

  /** Live WebSocket clients keyed by player id. */
  public readonly clients = new Map<string, WebSocket>();

  /** Authoritative sim state keyed by player id. */
  public readonly states = new Map<string, PlayerSimState>();

  private readonly db: DatabaseManager;
  private readonly ownsDatabase: boolean;
  private readonly port: number;
  private readonly host: string;
  private readonly wsPath: string;

  /** Which player each socket is acting as (bound by JOIN). */
  private readonly playerBySocket = new Map<WebSocket, string>();
  /** Field values last broadcast per player, for delta computation. */
  private readonly lastSent = new Map<string, Record<string, unknown>>();

  private wss: WebSocketServer | null = null;
  private upgradeHandler:
    | ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)
    | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Serialises async message handling: the DatabaseManager runs every
   * transaction on one shared sqlite handle (BEGIN/COMMIT), so two
   * concurrently-handled frames would collide with
   * "cannot start a transaction within a transaction".
   */
  private inboundChain: Promise<void> = Promise.resolve();

  private startedAt = 0;
  private running = false;

  constructor(options: LunarServerOptions = {}) {
    const envPort = Number(process.env.PORT);
    this.port =
      options.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT);
    this.host = options.host ?? process.env.HOST ?? '0.0.0.0';
    this.wsPath = options.wsPath ?? DEFAULT_WS_PATH;
    // An injected manager is left in whatever state its owner expects; we
    // only open/close the database when we created it.
    this.ownsDatabase = options.database === undefined;
    this.db =
      options.database ??
      new DatabaseManager(options.dbPath ?? './lunarfrontier.db');

    this.app = Fastify({ logger: options.logger ?? false });
    this.registerRoutes();
  }

  // -- lifecycle ---------------------------------------------------------------

  /**
   * Opens the database, boots HTTP + WebSocket servers, and starts the
   * 20 Hz delta tick. Resolves with the listening address.
   */
  async start(): Promise<string> {
    if (this.running) {
      throw new Error('LunarServer: already started');
    }
    this.running = true;

    try {
      if (this.ownsDatabase) await this.db.initialize();
      await this.app.ready();
      this.attachWebSocketServer();

      const address = await this.app.listen({ port: this.port, host: this.host });
      this.startedAt = Date.now();
      this.startTick();
      return address;
    } catch (err) {
      // Never leave a half-open server behind.
      this.running = false;
      await this.app.close().catch(() => undefined);
      if (this.ownsDatabase) await this.db.close().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Stops the tick, disconnects clients, closes WS/HTTP/DB.
   * Idempotent — safe when never started or already stopped.
   */
  async stop(): Promise<void> {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.running = false;

    for (const ws of this.clients.values()) {
      try {
        ws.close(1001, 'server shutting down');
      } catch {
        /* socket may already be gone */
      }
    }
    this.clients.clear();
    this.playerBySocket.clear();
    this.states.clear();
    this.lastSent.clear();

    const wss = this.wss;
    this.wss = null;
    if (wss !== null) {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }

    if (this.upgradeHandler !== null) {
      this.app.server.removeListener('upgrade', this.upgradeHandler);
      this.upgradeHandler = null;
    }

    await this.app.close().catch(() => undefined);

    if (this.ownsDatabase) {
      await this.db.close().catch(() => undefined);
    }
    this.startedAt = 0;
  }

  /** Seconds since start() (0 when stopped). */
  uptimeSeconds(): number {
    if (this.startedAt === 0) return 0;
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  // -- HTTP routes -------------------------------------------------------------

  private registerRoutes(): void {
    this.app.get('/health', async () => ({
      status: 'ok',
      players: this.clients.size,
      uptime: this.uptimeSeconds(),
    }));

    this.app.get('/api/world', async () => {
      const [claims, infrastructure] = await Promise.all([
        this.db.listClaims(),
        this.db.listInfrastructure(),
      ]);
      return { claims, infrastructure };
    });
  }

  // -- WebSocket plumbing --------------------------------------------------------

  private attachWebSocketServer(): void {
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.onClientConnection(ws, req);
    });

    // Route only `wsPath` upgrades through the WS server; destroy anything
    // else so unrelated upgrade requests cannot wedge the HTTP server.
    const upgradeHandler = (
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ): void => {
      let pathname = '/';
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== this.wsPath) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client: WebSocket) => {
        wss.emit('connection', client, req);
      });
    };

    this.app.server.on('upgrade', upgradeHandler);
    this.wss = wss;
    this.upgradeHandler = upgradeHandler;
  }

  private onClientConnection(ws: WebSocket, req: IncomingMessage): void {
    ws.on('error', () => {
      /* per-socket errors are non-fatal; cleanup happens on close */
    });
    ws.on('message', (raw: WebSocket.RawData) => {
      // One handler at a time per server — see `inboundChain`.
      this.inboundChain = this.inboundChain
        .then(() => this.onSocketMessage(ws, raw))
        .catch(() => undefined);
    });
    ws.on('close', () => {
      this.onClientDisconnect(ws);
    });

    this.send(ws, {
      type: 'hello',
      path: this.wsPath,
      remote: req.socket.remoteAddress ?? null,
      server_time: Date.now(),
    });
  }

  private onClientDisconnect(ws: WebSocket): void {
    const playerId = this.playerBySocket.get(ws);
    if (playerId === undefined) return;
    this.playerBySocket.delete(ws);

    // Only evict if the map still points at *this* socket — a re-JOIN from
    // the same account replaces the socket, and the stale close event must
    // not delete the fresh binding.
    if (this.clients.get(playerId) === ws) {
      this.clients.delete(playerId);
      this.states.delete(playerId);
      this.lastSent.delete(playerId);
      this.broadcast({ type: 'player_left', player_id: playerId });
    }
  }

  // -- inbound dispatch ----------------------------------------------------------

  private async onSocketMessage(ws: WebSocket, raw: WebSocket.RawData): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      this.sendError(ws, 'bad_json', (err as Error).message);
      return;
    }
    if (!isRecord(msg)) {
      this.sendError(ws, 'bad_json', 'frame must be a JSON object');
      return;
    }

    const kind = typeof msg.type === 'string' ? msg.type.toUpperCase() : '';
    const payload = isRecord(msg.payload) ? msg.payload : {};

    try {
      switch (kind) {
        case 'JOIN':
          await this.handleJoin(ws, payload);
          break;
        case 'MOVE':
          this.handleMove(ws, payload);
          break;
        case 'MINE':
          await this.handleMine(ws, payload);
          break;
        case 'CLAIM':
          await this.handleClaim(ws, payload);
          break;
        case 'PING':
          this.send(ws, { type: 'PONG', t: Date.now() });
          break;
        default:
          this.sendError(ws, 'unknown_type', `unsupported message type: "${kind}"`);
      }
    } catch (err) {
      this.sendError(ws, 'handler_failed', (err as Error).message);
    }
  }

  /** Resolves the bound player id, replying `not_joined` when absent. */
  private requirePlayerId(ws: WebSocket): string | null {
    const playerId = this.playerBySocket.get(ws);
    if (playerId === undefined) {
      this.sendError(ws, 'not_joined', 'send JOIN before acting');
      return null;
    }
    return playerId;
  }

  // -- JOIN ------------------------------------------------------------------------

  private async handleJoin(ws: WebSocket, payload: Record<string, unknown>): Promise<void> {
    const username =
      typeof payload.username === 'string' ? payload.username.trim() : '';
    if (username.length < 1 || username.length > 32) {
      this.sendError(ws, 'bad_username', 'username must be 1-32 characters');
      return;
    }
    const faction = typeof payload.faction === 'string' ? payload.faction : 'unaffiliated';
    const role = typeof payload.role === 'string' ? payload.role : 'surveyor';

    // Register-or-login by username. New accounts start at zero credits,
    // topped up to STARTING_CREDITS once the row exists.
    let player: PlayerRow;
    const existing = await this.db.getPlayerByUsername(username);
    if (existing !== undefined) {
      player = existing;
    } else {
      const candidate: PlayerRow = {
        id: randomUUID(),
        username,
        faction,
        credits: 0,
        role,
        created_at: new Date().toISOString(),
      };
      try {
        player = await this.db.createPlayer(candidate);
        await this.db.adjustCredits(player.id, STARTING_CREDITS);
        player = { ...player, credits: STARTING_CREDITS };
      } catch (err) {
        // Lost the unique-username race to a concurrent JOIN — read back.
        const raced = await this.db.getPlayerByUsername(username);
        if (raced === undefined) {
          this.sendError(ws, 'join_failed', `could not register player: ${(err as Error).message}`);
          return;
        }
        player = raced;
      }
    }

    // A re-JOIN on the same account replaces the previous socket.
    const previous = this.clients.get(player.id);
    if (previous !== undefined && previous !== ws) {
      try {
        previous.close(4009, 'session replaced');
      } catch {
        /* already closed */
      }
    }

    this.clients.set(player.id, ws);
    this.playerBySocket.set(ws, player.id);

    const state: PlayerSimState = {
      playerId: player.id,
      username: player.username,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      mode: 'suit',
      credits: player.credits,
    };
    this.states.set(player.id, state);
    this.lastSent.delete(player.id); // force a full snapshot on the first tick

    const [claims, infrastructure, resources] = await Promise.all([
      this.db.listClaims(),
      this.db.listInfrastructure(),
      this.db.getResources(player.id),
    ]);
    const ownClaims = claims.filter((c) => c.player_id === player.id);

    this.send(ws, {
      type: 'welcome',
      player: {
        id: player.id,
        username: player.username,
        faction: player.faction,
        role: player.role,
        credits: player.credits,
      },
      state: { ...state },
      resources:
        resources ?? {
          player_id: player.id,
          regolith: 0,
          water_ice: 0,
          helium3: 0,
          rare_earths: 0,
        },
      world: { claims, infrastructure },
      own_claims: ownClaims,
      uptime: this.uptimeSeconds(),
    });

    this.broadcast(
      { type: 'player_joined', player_id: player.id, state: { ...state } },
      player.id,
    );
  }

  // -- MOVE --------------------------------------------------------------------------

  private handleMove(ws: WebSocket, payload: Record<string, unknown>): void {
    const playerId = this.requirePlayerId(ws);
    if (playerId === null) return;
    const state = this.states.get(playerId);
    if (state === undefined) return;

    const x = num(payload.x);
    const y = num(payload.y);
    const z = num(payload.z);
    if (x === undefined || y === undefined || z === undefined) {
      this.sendError(ws, 'bad_move', 'x, y and z must be finite numbers');
      return;
    }
    if (
      Math.abs(x) > MAX_POSITION ||
      Math.abs(y) > MAX_POSITION ||
      Math.abs(z) > MAX_POSITION
    ) {
      this.sendError(ws, 'bad_move', `position out of bounds (|axis| <= ${MAX_POSITION})`);
      return;
    }

    // Mode is sticky: omitting payload.mode keeps the current one. Buggies
    // are unpressurised — they cannot operate below the surface line.
    const mode = payload.mode === undefined ? state.mode : asTravelMode(payload.mode);
    if (mode === undefined) {
      this.sendError(ws, 'bad_mode', "mode must be 'suit' or 'buggy'");
      return;
    }
    if (mode === 'buggy' && z < 0) {
      this.sendError(ws, 'bad_mode', 'a buggy cannot operate below the surface (z >= 0)');
      return;
    }

    const maxSpeed = mode === 'buggy' ? BUGGY_MAX_SPEED : SUIT_MAX_SPEED;
    state.x = x;
    state.y = y;
    state.z = z;
    state.vx = clamp(num(payload.vx) ?? 0, -maxSpeed, maxSpeed);
    state.vy = clamp(num(payload.vy) ?? 0, -maxSpeed, maxSpeed);
    state.vz = clamp(num(payload.vz) ?? 0, -maxSpeed, maxSpeed);
    state.mode = mode;
    // Position changes propagate to peers through the 20 Hz delta tick.
  }

  // -- MINE ----------------------------------------------------------------------------

  private async handleMine(ws: WebSocket, payload: Record<string, unknown>): Promise<void> {
    const playerId = this.requirePlayerId(ws);
    if (playerId === null) return;
    const state = this.states.get(playerId);
    if (state === undefined) return;

    const resource = asResourceType(payload.resource);
    if (resource === undefined) {
      this.sendError(
        ws,
        'bad_resource',
        `resource must be one of: ${RESOURCE_TYPES.join(', ')}`,
      );
      return;
    }
    const amount = clamp(num(payload.amount) ?? 1, 1, MAX_MINE_AMOUNT);

    // Claim permission at the player's current position:
    //  - another player's active claim blocks extraction outright
    //  - unclaimed ground yields only raw regolith
    //  - inside your own active claim any resource may be extracted
    const claimsHere = await this.db.claimsContaining(state.x, state.y);
    const activeHere = claimsHere.filter((c) => c.status === 'active');
    const hostile = activeHere.filter((c) => c.player_id !== playerId);
    if (hostile.length > 0) {
      this.sendError(ws, 'claim_denied', 'this ground belongs to another player claim');
      return;
    }
    const mineOwn = activeHere.some((c) => c.player_id === playerId);
    if (!mineOwn && resource !== 'regolith') {
      this.sendError(ws, 'claim_required', 'unclaimed ground yields only regolith');
      return;
    }

    const earned = Math.round(amount * RESOURCE_PRICES[resource]);
    // Sequential on purpose: adjustResources and adjustCredits each open a
    // transaction on the shared sqlite handle and must not interleave.
    const updated = await this.db.adjustResources(playerId, { [resource]: amount });
    const balance = await this.db.adjustCredits(playerId, earned);
    if (balance !== null) state.credits = balance;

    this.send(ws, {
      type: 'mine_result',
      resource,
      amount,
      earned,
      resources: updated,
      credits: state.credits,
    });
  }

  // -- CLAIM ----------------------------------------------------------------------------

  private async handleClaim(ws: WebSocket, payload: Record<string, unknown>): Promise<void> {
    const playerId = this.requirePlayerId(ws);
    if (playerId === null) return;
    const state = this.states.get(playerId);
    if (state === undefined) return;

    const kind = asClaimKind(payload.claim_type);
    if (kind === undefined) {
      this.sendError(ws, 'bad_claim', "claim_type must be 'surface' or 'subterranean'");
      return;
    }
    const x = num(payload.x);
    const y = num(payload.y);
    const radius = num(payload.radius);
    if (
      x === undefined ||
      y === undefined ||
      radius === undefined ||
      radius < MIN_CLAIM_RADIUS ||
      radius > MAX_CLAIM_RADIUS
    ) {
      this.sendError(
        ws,
        'bad_claim',
        `x and y are required; radius must be ${MIN_CLAIM_RADIUS}-${MAX_CLAIM_RADIUS}`,
      );
      return;
    }

    const cost = CLAIM_COSTS[kind];
    if (state.credits < cost) {
      this.sendError(
        ws,
        'insufficient_credits',
        `a ${kind} claim costs ${cost} credits (balance ${state.credits})`,
      );
      return;
    }

    // Refuse to stack a duplicate claim over ground anyone already holds.
    const allClaims = await this.db.listClaims();
    const overlap = allClaims.some((c) => {
      if (c.status !== 'active') return false;
      const dx = c.x - x;
      const dy = c.y - y;
      return Math.sqrt(dx * dx + dy * dy) < c.radius + radius;
    });
    if (overlap) {
      this.sendError(ws, 'claim_overlap', 'this area overlaps an existing claim');
      return;
    }

    const claim: ClaimRow = {
      id: randomUUID(),
      player_id: playerId,
      x,
      y,
      radius,
      claim_type: kind,
      status: 'active',
    };

    // Atomic debit (adjustCredits refuses overdrafts and returns the new
    // balance) — a refused debit never inserts the claim, and an insert
    // failure refunds cleanly so credits never leak.
    const debited = await this.db.adjustCredits(playerId, -cost);
    if (debited === null) {
      this.sendError(
        ws,
        'insufficient_credits',
        `a ${kind} claim costs ${cost} credits and your balance is too low`,
      );
      return;
    }
    try {
      await this.db.createClaim(claim);
    } catch (err) {
      await this.db.adjustCredits(playerId, cost).catch(() => undefined);
      this.sendError(ws, 'claim_failed', (err as Error).message);
      return;
    }

    state.credits = debited;
    this.send(ws, { type: 'claim_result', ok: true, claim, credits: debited });
    this.broadcast({ type: 'claim_staked', claim }, playerId);
  }

  // -- 20 Hz delta tick ---------------------------------------------------------------------

  private startTick(): void {
    this.tickTimer = setInterval(() => {
      try {
        this.tick();
      } catch {
        /* a failing tick must never kill the process */
      }
    }, 1000 / TICK_RATE_HZ);
  }

  /**
   * Broadcasts only the fields that changed since the previous tick
   * (`{ id, ...changedFields }`), keeping 20 Hz traffic cheap.
   */
  private tick(): void {
    if (this.clients.size === 0) return;

    const deltas: Array<Record<string, unknown>> = [];
    for (const [playerId, state] of this.states) {
      const current = this.snapshotFields(state);
      const previous = this.lastSent.get(playerId) ?? {};
      const changed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(current)) {
        if (!Object.is(previous[key], value)) changed[key] = value;
      }
      if (Object.keys(changed).length > 0) {
        deltas.push({ id: playerId, ...changed });
        this.lastSent.set(playerId, current);
      }
    }

    if (deltas.length === 0) return;
    this.broadcast({ type: 'tick', t: Date.now(), players: deltas });
  }

  private snapshotFields(state: PlayerSimState): Record<string, unknown> {
    return {
      username: state.username,
      x: state.x,
      y: state.y,
      z: state.z,
      vx: state.vx,
      vy: state.vy,
      vz: state.vz,
      mode: state.mode,
      credits: state.credits,
    };
  }

  // -- send helpers ----------------------------------------------------------------------------

  /** Sends one JSON frame to a single client (no-op unless OPEN). */
  send(ws: WebSocket, message: Outbound): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.send(ws, { type: 'error', code, message });
  }

  /** Sends a JSON frame to every connected client (optionally skipping one). */
  broadcast(message: Outbound, exceptPlayerId?: string): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(message);
    for (const [playerId, ws] of this.clients) {
      if (playerId === exceptPlayerId) continue;
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }
}

export default LunarServer;
