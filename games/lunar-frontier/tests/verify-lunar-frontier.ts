/**
 * Lunar Frontier — multi-client end-to-end integration suite (TASK-PLAY-051).
 *
 * Boots a REAL `LunarServer` (Fastify HTTP + `ws` WebSocket + SQLite through
 * `DatabaseManager`) on an ephemeral port backed by an isolated temporary
 * database file, then drives it with three concurrent WebSocket bots from three
 * different factions — spec 12 §4: "headless client bots connecting via
 * WebSocket, moving suit, mounting buggy … and logging persisted transactions
 * in SQLite".
 *
 * Verified end to end:
 *
 *   1. Bootstrap — temp SQLite file, schema created, ephemeral port, /health,
 *      /api/world, WebSocket handshake.
 *   2. Multi-client JOIN — ARTEMIS / HELIOS / RUSTBELT on one shard, welcome
 *      snapshots, join fan-out to the clients already on the shard.
 *   3. EVA locomotion — a real `LunarEvaSuit` route (1/6-g ballistics, hop apex
 *      vs v²/2g, free-flight Δv == g per frame, exertion drain) streamed over
 *      MOVE, with 20 Hz delta-tick replication observed by both peers and delta
 *      compression asserted.
 *   4. Buggy — real `OpenBuggy` mount/dismount + the `TraversalPhysics` modal
 *      state machine: out-of-range refused, proximity mount, drive, mode
 *      'buggy' replication, sticky-mode persistence, sub-surface refusal,
 *      speed-gated egress, cargo persisted across the whole cycle.
 *   5. Mining — unclaimed regolith payout, `claim_required` gate, subterranean
 *      CLAIM debit, and the in-situ ore reserve (`TunnelNetwork.mineVein`)
 *      draining in lockstep with the SQLite resource ledger.
 *   6. Broadcast topology — `claim_staked` fan-out, hostile `claim_denied`,
 *      overlap rejection without credit leak, malformed-frame handling,
 *      `player_left`.
 *   7. SQLite ACID — WAL/foreign_keys/busy_timeout pragmas, second live
 *      connection, atomic rollback, UNIQUE + overdraft enforcement.
 *   8. Durability — accounts, credits, claim anchors and mined tonnes survive a
 *      full stop/reopen; the miner re-authenticates to the same account id and
 *      the claim gate still bites.
 *   9. Shutdown — sockets closed, HTTP down, stop() idempotent, temp DB gone.
 *
 * Run:
 *   node --no-warnings tests/verify-lunar-frontier.ts
 *   npx tsx tests/verify-lunar-frontier.ts
 *
 * Exit code 0 == every check green. Nothing outside os.tmpdir() is written.
 */

// -- loader bootstrap ---------------------------------------------------------
// `src/server/LunarServer.ts` imports `../database` with no extension, which
// Node 22's built-in type-stripping loader will not resolve. Arm a minimal
// resolve hook (before the dynamic imports at the bottom of this file) that
// appends `.ts` to a relative specifier when that file exists on disk. `npx
// tsx` resolves those natively, so the hook is a harmless no-op there.
import { register } from 'node:module';

const RESOLVE_HOOK = `
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\\\.[A-Za-z0-9]+$/.test(specifier)) {
    try {
      const url = new URL(specifier, context.parentURL);
      if (existsSync(url.pathname + ".ts")) {
        return { url: pathToFileURL(url.pathname + ".ts").href, shortCircuit: true };
      }
    } catch { /* fall through to the default resolver */ }
  }
  return nextResolve(specifier, context);
}
`;

register('data:text/javascript,' + encodeURIComponent(RESOLVE_HOOK), import.meta.url);

// -- imports ------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';

import {
  BUGGY_MAX_CARGO,
  DISMOUNT_MAX_SPEED,
  EARTH_GRAVITY,
  IDLE_BUGGY_INPUT,
  IDLE_SUIT_INPUT,
  LUNAR_GRAVITY,
  MOUNT_DURATION_S,
  MOUNT_RANGE_M,
  SUIT_JUMP_VELOCITY,
  SUIT_RUN_SPEED,
  TraversalPhysics,
  LunarEvaSuit,
  type BuggyInput,
  type SuitInput,
  type SuitState,
} from '../src/physics/TraversalPhysics.ts';
import { MOUNT_RADIUS_M, OpenBuggy } from '../src/entities/OpenBuggy.ts';
import { DEFAULT_VEIN_PROXIMITY_M, TunnelNetwork } from '../src/infrastructure/TunnelNetwork.ts';
import { FACTION_DEFS, FACTION_IDS, type FactionId } from '../src/infrastructure/Factions.ts';
import {
  LunarWorldGenerator,
  type ResourceVein,
  type TunnelSegment,
  type WorldSnapshot,
} from '../src/world/LunarWorldGenerator.ts';

// -- narrow structural views of the dynamically-imported classes ---------------
interface ServerLike {
  start(): Promise<string>;
  stop(): Promise<void>;
}
interface DbLike {
  initialize(): Promise<void>;
  close(): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ lastID: number; changes: number }>;
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
  count(table: string, conditions?: Record<string, unknown>): Promise<number>;
}
/**
 * Structural view of the buggy the traversal engine owns. `TraversalPhysics`
 * extends `LunarBuggy` through a non-exported interface merge, which the
 * checker models as a broken merged type; this view names only the fields the
 * suite actually reads (the same ones scripts/smoke-traversal.ts touches).
 */
interface BuggyLike {
  getState(): { x: number; y: number; z: number; vLong: number; cargoMass: number };
  loadCargo(kg: number): number;
}
/** Resource columns the server ledger actually owns. */
type LedgerResource = 'regolith' | 'water_ice' | 'helium3' | 'rare_earths';

/** The world module and the server ledger spell some ores differently. */
const WORLD_KIND_TO_LEDGER: Record<string, LedgerResource | undefined> = {
  regolith: 'regolith',
  water_ice: 'water_ice',
  titanium: undefined, // the server ledger has no titanium column
  helium_3: 'helium3',
  rare_earth: 'rare_earths',
};

// -- tunables -----------------------------------------------------------------
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-e2e-'));
const DB_PATH = path.join(TMP_DIR, 'verify.db');
const WS_PATH = '/ws';
const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
/** Client-side physics step for the streamed suit route. */
const SIM_DT = 1 / 12;
const STARTING_CREDITS = 1000;
const GRIT_AMOUNT = 400;
const MINE_AMOUNT = 60;
const MINE_CYCLES = 2;

/** One decoded server frame. */
type Frame = Record<string, any>;

// -- world fixture ------------------------------------------------------------
const world: WorldSnapshot = new LunarWorldGenerator('task-play-051-rustbelt-assay').generate();
const tunnelNetwork = new TunnelNetwork(world);

/** First bored segment actually recorded as hosting this vein. */
function hostBore(vein: ResourceVein): TunnelSegment | null {
  for (const id of vein.hostTunnelIds) {
    const found = world.tunnels.find((t) => t.id === id);
    if (found !== undefined) return found;
  }
  return null;
}

const boreMid = (bore: TunnelSegment): { x: number; y: number; z: number } => ({
  x: (bore.start.x + bore.end.x) / 2,
  y: (bore.start.y + bore.end.y) / 2,
  z: (bore.start.z + bore.end.z) / 2,
});

interface MineTarget {
  vein: ResourceVein;
  ledger: LedgerResource;
  bore: TunnelSegment;
  station: { x: number; y: number; z: number };
  boreDistance: number;
}

/**
 * The mining target: a vein that (a) maps onto a server ledger column, (b)
 * still holds >500 in-situ units, (c) is genuinely cut by a SUBTERRANEAN bore
 * within scanner range, and (d) is a premium seam if the fixture has one —
 * regolith only wins when nothing better is hosted (its ledger score is
 * deliberately buried under the premium bonus).
 */
function pickMineTarget(): MineTarget {
  const PREMIUM_BONUS = 1_000_000;
  const scored: Array<MineTarget & { score: number }> = [];
  for (const vein of world.veins) {
    const ledger = WORLD_KIND_TO_LEDGER[vein.kind];
    if (ledger === undefined || vein.remaining <= 500) continue;
    const bore = hostBore(vein);
    if (bore === null || bore.start.z >= 0 || bore.end.z >= 0) continue;
    const station = boreMid(bore);
    const d = Math.hypot(station.x - vein.center.x, station.y - vein.center.y, station.z - vein.center.z);
    if (d > DEFAULT_VEIN_PROXIMITY_M) continue;
    scored.push({
      vein,
      ledger,
      bore,
      station,
      boreDistance: d,
      score: (vein.kind === 'regolith' ? 0 : PREMIUM_BONUS) + vein.remaining - d,
    });
  }
  if (scored.length === 0) throw new Error('world fixture has no subterranean bore-hosted vein');
  scored.sort((a, b) => b.score - a.score || a.vein.id.localeCompare(b.vein.id));
  return scored[0];
}

// -- check harness ------------------------------------------------------------
let passed = 0;
const failures: string[] = [];

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function check(label: string, ok: boolean, detail = ''): boolean {
  if (ok) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

/** Records the check, then aborts the run when it fails (dependents follow). */
function guard(label: string, ok: boolean, detail = ''): void {
  if (!check(label, ok, detail)) throw new Error(`fatal: ${label}${detail ? ` — ${detail}` : ''}`);
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const planarDist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);

// -- frame recorder -----------------------------------------------------------
/**
 * Records every JSON frame received on a socket from the moment of attachment
 * (before 'open', so nothing slips through the open→listen microtask gap — the
 * same trick as scripts/smoke-lunarserver.ts) and hands out independent
 * cursors, so each section waits on its own predicate without stealing frames
 * from another section.
 */
class Bus {
  readonly frames: Frame[] = [];
  private readonly waiters = new Set<() => void>();

  attach(ws: WebSocket): void {
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        this.frames.push(JSON.parse(raw.toString()) as Frame);
        for (const wake of [...this.waiters]) wake();
      } catch {
        /* ignore non-JSON frames */
      }
    });
  }

  cursor(): Cursor {
    return new Cursor(this, this.frames.length);
  }

  /**
   * Cursor that also sees every frame recorded so far — for frames that can
   * land before the caller gets a chance to arm a cursor (the `hello` handshake
   * arrives the instant the socket opens).
   */
  cursorFromStart(): Cursor {
    return new Cursor(this, 0);
  }

  /** Everything received so far (fresh array; safe to scan repeatedly). */
  all(): Frame[] {
    return [...this.frames];
  }

  addWaiter(wake: () => void): void {
    this.waiters.add(wake);
  }

  removeWaiter(wake: () => void): void {
    this.waiters.delete(wake);
  }
}

class Cursor {
  private index: number;
  private readonly bus: Bus;

  constructor(bus: Bus, startAt: number) {
    this.bus = bus;
    this.index = startAt;
  }

  /** Await the next unread matching frame. Throws on timeout. */
  async waitFor(predicate: (f: Frame) => boolean, label: string, timeoutMs = 6000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.index; i < this.bus.frames.length; i++) {
        if (predicate(this.bus.frames[i])) {
          this.index = i + 1;
          return this.bus.frames[i];
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out waiting for: ${label} — recent types: ` +
            JSON.stringify(this.bus.frames.slice(-6).map((f) => f.type)),
        );
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.bus.removeWaiter(wake);
          resolve();
        };
        const timer = setTimeout(() => {
          this.bus.removeWaiter(wake);
          resolve();
        }, Math.min(remaining, 50));
        this.bus.addWaiter(wake);
      });
    }
  }

  /** Non-consuming count of matching frames still unread by this cursor. */
  count(predicate: (f: Frame) => boolean): number {
    let n = 0;
    for (let i = this.index; i < this.bus.frames.length; i++) {
      if (predicate(this.bus.frames[i])) n++;
    }
    return n;
  }
}

// -- bot ----------------------------------------------------------------------
interface BotSpec {
  username: string;
  faction: FactionId;
  role: string;
}

class Bot {
  readonly bus = new Bus();
  readonly ws: WebSocket;
  readonly spec: BotSpec;
  playerId = '';
  credits = 0;

  constructor(spec: BotSpec, url: string) {
    this.spec = spec;
    this.ws = new WebSocket(url);
    this.bus.attach(this.ws);
    this.ws.on('error', () => {
      /* surfaced through waitFor timeouts and close codes */
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Send raw, deliberately unparseable wire text. */
  sendRaw(text: string): void {
    this.ws.send(text);
  }

  move(payload: Record<string, unknown>): void {
    this.send({ type: 'MOVE', payload });
  }

  /** Resolves true once the socket reaches CLOSED (false on timeout). */
  closed(timeoutMs = 4000): Promise<boolean> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

// -- protocol helpers -----------------------------------------------------------
const suitPayload = (s: SuitState, mode: string): Record<string, unknown> => ({
  x: s.x,
  y: s.y,
  z: s.z,
  vx: s.vx,
  vy: s.vy,
  vz: s.vz,
  mode,
});

const deltaOf = (f: Frame, playerId: string): Frame | undefined =>
  f.type === 'tick' && Array.isArray(f.players)
    ? f.players.find((p: Frame) => p.id === playerId)
    : undefined;

const isTickOf = (f: Frame, playerId: string): boolean => deltaOf(f, playerId) !== undefined;

async function fetchHealth(port: number): Promise<Record<string, unknown>> {
  return (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Record<string, unknown>;
}

/** Poll /health until `players` equals `want` (or the budget runs out). */
async function waitForPlayerCount(port: number, want: number, budgetMs = 2500): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let seen = -1;
  while (Date.now() < deadline) {
    try {
      seen = Number((await fetchHealth(port)).players);
      if (seen === want) return seen;
    } catch {
      /* server may be mid-stop */
    }
    await sleep(50);
  }
  return seen;
}

/** Newest tick delta for `playerId` that carries a credits field. */
function lastCreditsDelta(frames: Frame[], playerId: string): Frame | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const d = deltaOf(frames[i], playerId);
    if (d !== undefined && d.credits !== undefined) return d;
  }
  return undefined;
}

// ===========================================================================
//  MAIN
// ===========================================================================
async function main(): Promise<void> {
  const serverModule = await import('../src/server/LunarServer.ts');
  const LunarServer = serverModule.default;
  const CLAIM_COSTS = serverModule.CLAIM_COSTS;
  const RESOURCE_PRICES = serverModule.RESOURCE_PRICES;
  const dbModule = await import('../src/database.ts');
  const DatabaseManager = dbModule.default;

  let server: ServerLike | null = null;
  let reader: DbLike | null = null;
  const bots: Bot[] = [];
  let fatal: unknown = null;

  try {
    // ==================================================================
    section('1. BOOTSTRAP — isolated SQLite, ephemeral port, HTTP + WS surface');
    // ==================================================================
    guard('isolated temporary directory created under os.tmpdir()', TMP_DIR.startsWith(os.tmpdir()), TMP_DIR);
    check('temporary database file absent before boot', !fs.existsSync(DB_PATH), DB_PATH);

    server = new LunarServer({ port: 0, host: '127.0.0.1', dbPath: DB_PATH, wsPath: WS_PATH });
    const address = await server.start();
    const port = Number(new URL(address).port);
    guard('start() bound an ephemeral non-default port', Number.isFinite(port) && port > 1024 && port !== 3000, address);

    const health0 = await fetchHealth(port);
    check('GET /health -> status ok', health0.status === 'ok', JSON.stringify(health0));
    check(
      'GET /health -> numeric players + uptime',
      typeof health0.players === 'number' && typeof health0.uptime === 'number',
    );

    const world0 = (await (await fetch(`http://127.0.0.1:${port}/api/world`)).json()) as Record<string, unknown>;
    check('GET /api/world -> empty claims + infrastructure', Array.isArray(world0.claims) && Array.isArray(world0.infrastructure));

    reader = new DatabaseManager(DB_PATH);
    const db: DbLike = reader;
    await db.initialize();
    const tables = (
      await db.all<{ name: string }>('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name', ['table'])
    )
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_'));
    for (const want of ['players', 'claims', 'resources', 'factions', 'infrastructure', 'transactions']) {
      check(`SQLite table "${want}" created`, tables.includes(want), tables.join(','));
    }
    check('fresh database holds zero players', (await db.count('players')) === 0);

    // ==================================================================
    section('2. MULTI-CLIENT JOIN — three factions on one shard');
    // ==================================================================
    check(`faction roster exposes all four powers (${FACTION_IDS.join('/')})`, FACTION_IDS.length === 4);

    const specs: BotSpec[] = [
      { username: 'apollo_surveyor', faction: 'ARTEMIS', role: 'surveyor' },
      { username: 'helios_driller', faction: 'HELIOS', role: 'rig_operator' },
      { username: 'rustbelt_miner', faction: 'RUSTBELT', role: 'driller' },
    ];
    const wsUrl = `ws://127.0.0.1:${port}${WS_PATH}`;
    for (const spec of specs) bots.push(new Bot(spec, wsUrl));

    // All three sockets open concurrently — the shard has not seen anyone yet.
    await Promise.all(bots.map((b) => b.open()));
    check('three concurrent WebSocket clients connected', bots.every((b) => b.ws.readyState === WebSocket.OPEN));

    const hellos = await Promise.all(
      bots.map((b) => b.bus.cursorFromStart().waitFor((f) => f.type === 'hello', `${b.spec.username} hello`)),
    );
    check(`every client handshook on ${WS_PATH}`, hellos.every((h) => h.path === WS_PATH && typeof h.server_time === 'number'));

    // JOINs go out one at a time so the witness assertions below are
    // ordering-deterministic (all three SOCKETS are open concurrently anyway).
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      bot.send({ type: 'JOIN', payload: { username: bot.spec.username, faction: bot.spec.faction, role: bot.spec.role } });
      const w = await bot.bus.cursor().waitFor((f) => f.type === 'welcome', `${bot.spec.username} welcome`);
      bot.playerId = String(w.player?.id ?? '');
      bot.credits = Number(w.player?.credits ?? -1);
      check(
        `${bot.spec.username} joined ${bot.spec.faction} at ${STARTING_CREDITS} credits`,
        w.player?.faction === bot.spec.faction && bot.credits === STARTING_CREDITS,
        JSON.stringify(w.player),
      );
      check(
        `${bot.spec.username} welcome snapshot: world claims + own suit state`,
        Array.isArray(w.world?.claims) && w.state?.mode === 'suit' && w.state?.username === bot.spec.username,
        JSON.stringify(w.state),
      );
      // The shard broadcasts the arrival only to clients already on it.
      const alreadyOnShard = bots.slice(0, i);
      if (alreadyOnShard.length > 0) {
        let witnessed = 0;
        for (const witness of alreadyOnShard) {
          try {
            await witness.bus.cursorFromStart().waitFor(
              (f) => f.type === 'player_joined' && f.player_id === bot.playerId,
              `${witness.spec.username} saw ${bot.spec.username} join`,
            );
            witnessed++;
          } catch {
            /* counted as a failed check below */
          }
        }
        check(
          `${bot.spec.username} arrival broadcast to all ${alreadyOnShard.length} client(s) already on the shard`,
          witnessed === alreadyOnShard.length,
          `witnessed by ${witnessed}`,
        );
      }
    }
    check('three joins produced three distinct account ids', new Set(bots.map((b) => b.playerId)).size === 3);
    check('GET /health reports 3 concurrent players', (await waitForPlayerCount(port, 3)) === 3);
    check(
      'no client ever received its own player_joined echo',
      bots.every((b) => !b.bus.all().some((f) => f.type === 'player_joined' && f.player_id === b.playerId)),
    );
    check(
      'faction focus kinds wired to the economy (HELIOS→helium_3, RUSTBELT→rare_earth)',
      FACTION_DEFS.HELIOS.focusKind === 'helium_3' && FACTION_DEFS.RUSTBELT.focusKind === 'rare_earth',
    );

    const [apollo, helios, rustbelt] = bots;

    // ==================================================================
    section('3. EVA LOCOMOTION — 1/6-g suit route + 20 Hz delta replication');
    // ==================================================================
    check(
      `lunar gravity ${LUNAR_GRAVITY} m/s² is one sixth of earth ${EARTH_GRAVITY} m/s²`,
      near(EARTH_GRAVITY / LUNAR_GRAVITY, 6, 0.1),
      `ratio ${(EARTH_GRAVITY / LUNAR_GRAVITY).toFixed(3)}`,
    );

    const suit = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true });
    const idle: SuitInput = { ...IDLE_SUIT_INPUT };
    const peerWatchers = [helios, rustbelt].map((b) => ({ bot: b, cur: b.bus.cursor() }));

    // Walk, hop into a ballistic arc, keep walking — every pose streamed.
    const route: SuitState[] = [];
    let apex = 0;
    let airborneDeltaSum = 0;
    let airborneFrames = 0;
    let relanded = false;
    const JUMP_FRAME = 36;

    for (let i = 0; i < 190; i++) {
      const beforeVz = suit.getState().vz;
      const wasAirborne = !suit.getState().isGrounded;
      const state = suit.step(SIM_DT, { ...idle, forward: 1, jump: i === JUMP_FRAME });
      route.push(state);
      apex = Math.max(apex, state.z);
      if (i > JUMP_FRAME && wasAirborne && !state.isGrounded) {
        airborneDeltaSum += state.vz - beforeVz;
        airborneFrames++;
      }
      if (i > JUMP_FRAME && state.isGrounded && apex > 0.5) relanded = true;
      apollo.move(suitPayload(state, 'suit'));
      if (i % 5 === 0) await sleep(5); // let the 20 Hz loop get the wire in
    }
    const finalPose = route[route.length - 1];
    const theoreticalApex = (SUIT_JUMP_VELOCITY * SUIT_JUMP_VELOCITY) / (2 * LUNAR_GRAVITY);
    const measuredG = airborneFrames > 0 ? -airborneDeltaSum / (airborneFrames * SIM_DT) : Number.NaN;

    check(
      `low-g hop apex ${apex.toFixed(2)} m tracks v²/2g = ${theoreticalApex.toFixed(2)} m`,
      apex > theoreticalApex * 0.8 && apex <= theoreticalApex * 1.02,
    );
    check(
      `free-flight deceleration measured ${measuredG.toFixed(3)} m/s² == lunar g ${LUNAR_GRAVITY} (${airborneFrames} airborne frames)`,
      near(measuredG, LUNAR_GRAVITY, 0.02),
    );
    check('suit relanded under 1/6-g gravity', relanded);
    check(
      `run gait saturated at SUIT_RUN_SPEED ${SUIT_RUN_SPEED} m/s`,
      near(finalPose.vx, SUIT_RUN_SPEED, 0.25),
      `vx ${finalPose.vx}`,
    );
    check(
      `surface route streamed to the shard (${route.length} poses, x → ${finalPose.x.toFixed(1)} m)`,
      route.length === 190 && finalPose.x > 60,
    );
    check(
      `exertion drained life support (O₂ ${finalPose.oxygen.toFixed(1)}, battery ${finalPose.battery.toFixed(1)})`,
      finalPose.oxygen < 99.5 && finalPose.battery < 100,
    );

    for (const { bot, cur } of peerWatchers) {
      const first = await cur.waitFor((f) => isTickOf(f, apollo.playerId), `${bot.spec.username} sees an apollo tick`);
      check(`${bot.spec.username} replicated apollo's position delta (x=${deltaOf(first, apollo.playerId)?.x})`, Number.isFinite(deltaOf(first, apollo.playerId)?.x));
    }

    // Rate window: apollo keeps moving (each frame a fresh position, so every
    // tick carries a delta); the other two bots sit perfectly still.
    const rateStart = Date.now();
    let nudge = 0;
    const mover = setInterval(() => {
      nudge += 1;
      const s = suit.getState();
      apollo.move({ x: s.x + nudge, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: 0, mode: 'suit' });
    }, 20);
    await sleep(700);
    clearInterval(mover);
    const windowMs = Date.now() - rateStart;

    for (const { bot } of peerWatchers) {
      const ticks = bot.bus.all().filter((f) => f.type === 'tick' && Number(f.t) >= rateStart);
      const stamps = ticks.map((f) => Number(f.t));
      const gaps: number[] = [];
      for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1]);
      const median = gaps.length > 0 ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : -1;
      check(`${bot.spec.username}: ${ticks.length} delta ticks across the ${windowMs} ms window (>= 8)`, ticks.length >= 8);
      check(`${bot.spec.username}: tick cadence ~${TICK_HZ} Hz (median gap ${median} ms vs ${TICK_MS} ms target)`, median >= 30 && median <= 100);
    }

    // Delta compression: while apollo keeps moving (ticks keep flowing), the
    // idle bot must be absent from every delta.
    const nudgeIdle = setInterval(() => {
      nudge += 25;
      const s = suit.getState();
      apollo.move({ x: s.x + nudge, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: 0, mode: 'suit' });
    }, 20);
    await sleep(TICK_MS * 4);
    const idleTicks = rustbelt.bus.all().filter(
      (f) => f.type === 'tick' && Number(f.t) > rateStart + windowMs,
    );
    clearInterval(nudgeIdle);
    check(
      `delta compression: idle ${rustbelt.spec.username} absent from all ${idleTicks.length} ticks while apollo moved`,
      idleTicks.length > 0 && idleTicks.every((f) => deltaOf(f, rustbelt.playerId) === undefined),
    );

    // Convergence: the newest replicated state matches the authoritative pose.
    let replicated: Frame | undefined;
    for (const { bot } of peerWatchers) {
      for (const f of bot.bus.all()) {
        const d = deltaOf(f, apollo.playerId);
        if (d !== undefined && Number.isFinite(d.x)) replicated = d;
      }
    }
    // Delta compression means the newest delta may carry only x — look for the
    // newest delta that actually *carried* a mode field to prove convergence.
    let lastModeSeen: string | undefined;
    for (const { bot } of peerWatchers) {
      for (const f of bot.bus.all()) {
        const d = deltaOf(f, apollo.playerId);
        if (d !== undefined && typeof d.mode === 'string') lastModeSeen = d.mode;
      }
    }
    check('peers converged on apollo mode "suit"', lastModeSeen === 'suit', String(lastModeSeen));
    check('peers replicated apollo across the surface (x > 60 m)', replicated !== undefined && replicated.x > 60, JSON.stringify(replicated));

    const badCur = apollo.bus.cursorFromStart();
    apollo.move({ x: Number.POSITIVE_INFINITY, y: 0, z: 0 });
    const badMove = await badCur.waitFor((f) => f.type === 'error' && f.code === 'bad_move', 'bad_move rejection');
    check('non-finite MOVE rejected (bad_move)', badMove.code === 'bad_move');
    apollo.move(suitPayload(finalPose, 'suit'));

    // ==================================================================
    section('4. BUGGY — proximity mount, drive, dismount, mode persistence');
    // ==================================================================
    const spawn = { x: 2_400, y: 1_180, z: 0 };
    const buggy = new OpenBuggy({ x: spawn.x, y: spawn.y, heading: Math.PI / 4 });
    check('OpenBuggy steps physics headless without any scene', buggy.isBuilt() === false && Number.isFinite(buggy.getPosition().x));

    const farSuit = { x: spawn.x + 40, y: spawn.y, z: 0 };
    check(
      `mount refused at 40 m (MOUNT_RADIUS_M = ${MOUNT_RADIUS_M})`,
      buggy.canMount(farSuit) === false && buggy.mount(farSuit) === false && buggy.isMounted() === false,
    );

    // Walk the suit the last stretch to the driver seat, streaming MOVE.
    const walker = new LunarEvaSuit({ x: spawn.x + 30, y: spawn.y, z: 0, isGrounded: true });
    let walkedIn = false;
    for (let i = 0; i < 400; i++) {
      const s = walker.getState();
      if (buggy.canMount(s)) {
        walkedIn = true;
        break;
      }
      walker.setState({ heading: Math.atan2(spawn.y - s.y, spawn.x - s.x) });
      walker.step(SIM_DT, { ...idle, forward: 1 });
      helios.move(suitPayload(walker.getState(), 'suit'));
    }
    check(`suit walked into mount range (< ${MOUNT_RADIUS_M} m)`, walkedIn);

    const atSeat = walker.getState();
    check('canMount true inside the mount radius', buggy.canMount(atSeat) === true);
    check('proximity mount accepted', buggy.mount(atSeat) === true && buggy.isMounted() === true);
    check('double mount refused', buggy.mount(atSeat) === false && buggy.isMounted() === true);

    // Load the flatbed and drive it, streaming MOVE with mode 'buggy'.
    const cargo = 180;
    buggy.setCargoMass(cargo);
    check(`cargo locked to ${cargo} kg (${((cargo / BUGGY_MAX_CARGO) * 100).toFixed(0)}% of ${BUGGY_MAX_CARGO})`, buggy.getCargoMass() === cargo);

    const driveCursors = [apollo, rustbelt].map((b) => b.bus.cursor());
    const driveInput: BuggyInput = { ...IDLE_BUGGY_INPUT, parkBrake: false, throttle: 0.9 };
    for (let i = 0; i < 600; i++) {
      const st = buggy.update(1 / 60, driveInput);
      helios.move({ x: st.x, y: st.y, z: Math.max(0, st.z), vx: st.vLong, vy: st.vLat, vz: 0, mode: 'buggy' });
      if (i % 40 === 0) await sleep(3);
    }
    const telemetry = buggy.getTelemetry();
    const drove = planarDist(buggy.getPosition().x, buggy.getPosition().y, spawn.x, spawn.y);
    check(`buggy drove ${drove.toFixed(1)} m under throttle (road speed ${telemetry.speed.toFixed(1)} m/s)`, drove > 30 && telemetry.speed > 1);
    check(`drivetrain drew from the traction battery (${telemetry.battery.toFixed(3)} kWh)`, telemetry.battery < 2.2);
    check('buggy stayed upright', telemetry.rolled === false);
    check('cargo stayed aboard the whole drive', telemetry.cargoMass === cargo && telemetry.mounted === true);

    const buggyTick = await driveCursors[0].waitFor(
      (f) => isTickOf(f, helios.playerId) && deltaOf(f, helios.playerId)?.mode === 'buggy',
      'replicated buggy mode',
    );
    check('peers replicated helios in mode "buggy"', deltaOf(buggyTick, helios.playerId)?.mode === 'buggy');

    // Server-side mode persistence, proven through delta compression: a mode
    // switch must re-appear in the delta, while an omitted mode must NOT (the
    // server held it — had it reset to the 'suit' default, compression would
    // have emitted the changed field again).
    const modeCur = helios.bus.cursorFromStart();
    helios.move({ x: buggy.getPosition().x, y: buggy.getPosition().y, z: Math.max(0, buggy.getPosition().z), mode: 'suit' });
    const suitDelta = await driveCursors[1].waitFor(
      (f) => deltaOf(f, helios.playerId)?.mode === 'suit',
      'explicit mode switch to suit',
    );
    check('explicit MOVE mode "suit" replicated to peers', deltaOf(suitDelta, helios.playerId)?.mode === 'suit');

    const stickyX = buggy.getPosition().x + 0.25;
    helios.move({ x: stickyX, y: buggy.getPosition().y, z: Math.max(0, buggy.getPosition().z) });
    const sticky = await driveCursors[1].waitFor(
      (f) => deltaOf(f, helios.playerId)?.x === stickyX,
      'sticky-mode position tick',
    );
    check(
      'mode omitted from MOVE is sticky — delta carried x but no mode field',
      deltaOf(sticky, helios.playerId)?.mode === undefined && deltaOf(sticky, helios.playerId)?.x === stickyX,
      JSON.stringify(deltaOf(sticky, helios.playerId)),
    );

    // And back into the seat for the sub-surface probe below.
    helios.move({ x: stickyX, y: buggy.getPosition().y, z: Math.max(0, buggy.getPosition().z), mode: 'buggy' });
    const backInBuggy = await modeCur.waitFor((f) => deltaOf(f, helios.playerId)?.mode === 'buggy', 'mode buggy again');
    check('re-mount replicated as mode "buggy"', deltaOf(backInBuggy, helios.playerId)?.mode === 'buggy');

    const subCur = helios.bus.cursorFromStart();
    helios.move({ x: buggy.getPosition().x, y: buggy.getPosition().y, z: -12 });
    const subErr = await subCur.waitFor((f) => f.type === 'error' && f.code === 'bad_mode', 'sub-surface buggy refusal');
    check('unpressurised buggy refused below the surface line (bad_mode)', subErr.code === 'bad_mode');

    // The real modal state machine: timed transitions + speed-gated egress.
    const traversal = new TraversalPhysics({
      groundElevation: () => 0,
      suit: { x: 12, y: 0, z: 0, isGrounded: true },
      buggy: { x: 0, y: 0, heading: 0 },
    });
    const placedBuggy = traversal.getBuggy() as unknown as BuggyLike | null;
    guard('TraversalPhysics owns a buggy for the mount machine', placedBuggy !== null);
    if (placedBuggy === null) throw new Error('fatal: no buggy to mount');
    const ownedBuggy: BuggyLike = placedBuggy;
    ownedBuggy.loadCargo(250);
    check(`mount refused outside MOUNT_RANGE_M ${MOUNT_RANGE_M}`, traversal.tryMount() === false);

    traversal.getSuite().setState({ x: 0, y: 0, z: 0, isGrounded: true });
    check('mount accepted once in range', traversal.tryMount() === true && traversal.getMode() === 'mounting');
    let mountFrames = 0;
    while (traversal.getMode() === 'mounting' && mountFrames < 300) {
      traversal.step(1 / 60);
      mountFrames++;
    }
    check(`mount transition resolved to "buggy" in ${mountFrames} frames (MOUNT_DURATION_S ${MOUNT_DURATION_S})`, traversal.getMode() === 'buggy');

    for (let i = 0; i < 240; i++) traversal.step(1 / 60, { buggy: { throttle: 0.9, parkBrake: false } });
    const rollingSpeed = Math.abs(ownedBuggy.getState().vLong);
    check(
      `egress refused while rolling at ${rollingSpeed.toFixed(1)} m/s (> DISMOUNT_MAX_SPEED ${DISMOUNT_MAX_SPEED})`,
      rollingSpeed > DISMOUNT_MAX_SPEED && traversal.tryDismount() === false && traversal.getMode() === 'buggy',
    );
    let brakedFrames = 0;
    while (brakedFrames < 900 && Math.abs(ownedBuggy.getState().vLong) > DISMOUNT_MAX_SPEED * 0.9) {
      traversal.step(1 / 60, { buggy: { brake: 1, parkBrake: false } });
      brakedFrames++;
    }
    const parkedSpeed = Math.abs(ownedBuggy.getState().vLong);
    const egress = traversal.tryDismount();
    let egressFrames = 0;
    while (traversal.getMode() === 'dismounting' && egressFrames < 300) {
      traversal.step(1 / 60);
      egressFrames++;
    }
    check(`dismount allowed once slowed to ${parkedSpeed.toFixed(2)} m/s (${brakedFrames} brake frames)`, egress === true);
    check('dismount transition settled back to "suit"', traversal.getMode() === 'suit');
    check('cargo persisted through the mount/dismount state machine', ownedBuggy.getState().cargoMass === 250);
    check(
      'dismounted suit handed out beside the rover',
      planarDist(traversal.getSuite().getState().x, traversal.getSuite().getState().y, ownedBuggy.getState().x, ownedBuggy.getState().y) < 4,
    );

    // Wire-level dismount: mode flips back to 'suit' for the peers.
    buggy.dismount(walker);
    helios.move(suitPayload(walker.getState(), 'suit'));
    const backOnFoot = await driveCursors[0].waitFor((f) => deltaOf(f, helios.playerId)?.mode === 'suit', 'mode back to suit');
    check('server replicated the dismount (mode "suit")', deltaOf(backOnFoot, helios.playerId)?.mode === 'suit');
    buggy.dispose();

    // ==================================================================
    section('5. SUBTERRANEAN MINING — claim gate, payout, ore-reserve ledger');
    // ==================================================================
    const target = pickMineTarget();
    const netVein = tunnelNetwork.getVein(target.vein.id);
    guard('TunnelNetwork indexed the target vein', netVein !== null, target.vein.id);
    const ledger = target.ledger;
    const inSituBefore = netVein!.remaining;
    check(
      `target ${target.vein.id} (${ledger}) lies subterranean at z ${target.station.z.toFixed(0)} m with ${inSituBefore} units in situ`,
      target.station.z < 0 && inSituBefore > 500,
    );
    check(
      `vein is cut by bore ${target.bore.id} (${target.bore.kind}) at ${target.boreDistance.toFixed(0)} m — inside the ${DEFAULT_VEIN_PROXIMITY_M} m scanner`,
      target.boreDistance <= DEFAULT_VEIN_PROXIMITY_M,
    );
    check(
      'scanner sweep from the bore station sees the vein',
      tunnelNetwork.getNearbyVeins(target.station, DEFAULT_VEIN_PROXIMITY_M).some((e) => e.vein.id === target.vein.id),
    );
    const deepestKind = (kind: string): number =>
      Math.max(...world.veins.filter((v) => v.kind === kind).map((v) => v.depth));
    check(
      `KREEP is the deepest prize (rare_earth ${deepestKind('rare_earth').toFixed(0)} m below water_ice's ${deepestKind('water_ice').toFixed(0)} m)`,
      deepestKind('rare_earth') > deepestKind('water_ice'),
    );

    const rbCur = rustbelt.bus.cursorFromStart();
    // Bankroll the subterranean claim by stripping regolith off unclaimed grit.
    rustbelt.move({ x: 200, y: 200, z: 0, vx: 0, vy: 0, vz: 0, mode: 'suit' });
    rustbelt.send({ type: 'MINE', payload: { resource: 'regolith', amount: GRIT_AMOUNT } });
    const grit = await rbCur.waitFor((f) => f.type === 'mine_result' && f.resource === 'regolith', 'regolith mine_result');
    check(
      `unclaimed regolith paid ${grit.earned} credits (${GRIT_AMOUNT} × ${RESOURCE_PRICES.regolith})`,
      grit.earned === GRIT_AMOUNT * RESOURCE_PRICES.regolith,
    );
    const banked = STARTING_CREDITS + GRIT_AMOUNT * RESOURCE_PRICES.regolith;
    check(`rustbelt_miner bankroll now ${grit.credits} credits`, Number(grit.credits) === banked, `expected ${banked}`);

    // Move into the bore and try to drill before staking anything.
    rustbelt.move({ x: target.station.x, y: target.station.y, z: target.station.z, vx: 0, vy: 0, vz: 0, mode: 'suit' });
    rustbelt.send({ type: 'MINE', payload: { resource: ledger, amount: 10 } });
    const gated = await rbCur.waitFor((f) => f.type === 'error' && f.code === 'claim_required', 'claim_required gate');
    check(`premium ${ledger} on unclaimed ground refused (${gated.code})`, gated.code === 'claim_required');
    rustbelt.send({ type: 'MINE', payload: { resource: 'unobtainium', amount: 5 } });
    const badRes = await rbCur.waitFor((f) => f.type === 'error' && f.code === 'bad_resource', 'bad_resource');
    check('unknown resource rejected (bad_resource)', badRes.code === 'bad_resource');

    // Stake the subterranean claim over the vein mouth.
    const rustbeltClaimCursor = rustbelt.bus.cursor();
    rustbelt.send({ type: 'CLAIM', payload: { claim_type: 'subterranean', x: target.station.x, y: target.station.y, radius: 40 } });
    const claimFrame = await rbCur.waitFor((f) => f.type === 'claim_result' && f.ok === true, 'claim_result');
    const claimId = String(claimFrame.claim?.id ?? '');
    check('subterranean claim staked and active', claimFrame.claim?.claim_type === 'subterranean' && claimFrame.claim?.status === 'active');
    check(
      `claim debited exactly ${CLAIM_COSTS.subterranean} credits -> balance ${claimFrame.credits}`,
      Number(claimFrame.credits) === banked - CLAIM_COSTS.subterranean,
      `got ${claimFrame.credits}`,
    );

    // Extraction cycles: in-situ reserve and server ledger drain in lockstep.
    let minedTotal = 0;
    let expectedStockpile = 0;
    let lastMine: Frame | undefined;
    for (let cycle = 1; cycle <= MINE_CYCLES; cycle++) {
      const before = tunnelNetwork.getVein(target.vein.id)!.remaining;
      rustbelt.send({ type: 'MINE', payload: { resource: ledger, amount: MINE_AMOUNT } });
      const result = await rbCur.waitFor((f) => f.type === 'mine_result' && f.resource === ledger, `mine cycle ${cycle}`);
      lastMine = result;
      const extracted = tunnelNetwork.mineVein(target.vein.id, MINE_AMOUNT);
      minedTotal += extracted;
      expectedStockpile += MINE_AMOUNT;
      check(
        `cycle ${cycle}: extracted ${result.amount} ${ledger} for ${result.earned} credits`,
        result.amount === MINE_AMOUNT && result.earned === MINE_AMOUNT * RESOURCE_PRICES[ledger],
      );
      check(
        `cycle ${cycle}: server stockpile ${ledger} = ${result.resources?.[ledger]}`,
        Number(result.resources?.[ledger]) === expectedStockpile,
        JSON.stringify(result.resources),
      );
      check(
        `cycle ${cycle}: in-situ reserve ${before} -> ${netVein!.remaining} (${extracted} out)`,
        netVein!.remaining === before - extracted,
      );
    }
    check(
      `ore reserve drained ${minedTotal} units total (${inSituBefore} -> ${netVein!.remaining})`,
      inSituBefore - netVein!.remaining === minedTotal,
    );
    check('reserve never went negative', netVein!.remaining > 0);
    check(
      'depleted/unknown veins yield nothing (no negative mining)',
      tunnelNetwork.mineVein(target.vein.id, -5) === 0 && tunnelNetwork.mineVein('vein-does-not-exist', 10) === 0,
    );

    const creditsFromServer = Number(lastMine?.credits);
    const expectedCredits = banked - CLAIM_COSTS.subterranean + MINE_CYCLES * MINE_AMOUNT * RESOURCE_PRICES[ledger];
    check(`server credits balance ${creditsFromServer}`, creditsFromServer === expectedCredits, `expected ${expectedCredits}`);

    // The same ledger, persisted in SQLite.
    const stockpile = await db.get<Record<string, unknown>>('SELECT * FROM resources WHERE player_id = ?', [rustbelt.playerId]);
    check(`SQLite resources row holds ${minedTotal} ${ledger} for rustbelt_miner`, Number(stockpile?.[ledger]) === minedTotal, JSON.stringify(stockpile));
    check('SQLite resources row holds the 400 regolith too', Number(stockpile?.regolith) === GRIT_AMOUNT);
    const playerRow = await db.get<Record<string, unknown>>('SELECT * FROM players WHERE id = ?', [rustbelt.playerId]);
    check(`SQLite credits persisted (${playerRow?.credits})`, Number(playerRow?.credits) === creditsFromServer, `server ${creditsFromServer}`);
    const claimRow = await db.get<Record<string, unknown>>('SELECT * FROM claims WHERE id = ?', [claimId]);
    check(
      'SQLite claims row persisted with owner, type and anchor coordinates',
      claimRow?.player_id === rustbelt.playerId &&
        claimRow?.claim_type === 'subterranean' &&
        Number(claimRow?.x) === target.station.x &&
        Number(claimRow?.y) === target.station.y &&
        Number(claimRow?.radius) === 40,
      JSON.stringify(claimRow),
    );

    // ==================================================================
    section('6. BROADCAST TOPOLOGY — fan-out, hostile claims, disconnect');
    // ==================================================================
    const artemisAt = { x: target.station.x + 2_500, y: target.station.y + 2_500 };
    const apCur = apollo.bus.cursorFromStart();
    apollo.move({ x: artemisAt.x, y: artemisAt.y, z: 5, vx: 0, vy: 0, vz: 0, mode: 'suit' });
    apollo.send({ type: 'CLAIM', payload: { claim_type: 'surface', x: artemisAt.x, y: artemisAt.y, radius: 30 } });
    const apClaim = await apCur.waitFor((f) => f.type === 'claim_result' && f.ok === true, 'artemis claim_result');
    check('ARTEMIS staked a surface claim far from the rustbelt ground', apClaim.claim?.claim_type === 'surface');
    const apolloCredits = Number(apClaim.credits);
    check(
      `ARTEMIS debited ${CLAIM_COSTS.surface} credits for it`,
      apolloCredits === STARTING_CREDITS - CLAIM_COSTS.surface,
      `got ${apClaim.credits}`,
    );

    // The ARTEMIS claim is broadcast to the clients that did NOT stake it.
    const heliosClaimCursor = helios.bus.cursor();
    for (const [name, peer] of [['rustbelt_miner', rustbeltClaimCursor], ['helios_driller', heliosClaimCursor]] as const) {
      const seen = await peer.waitFor((f) => f.type === 'claim_staked' && f.claim?.id === apClaim.claim?.id, `claim_staked fan-out to ${name}`);
      check(`claim_staked fanned out to ${name}`, seen.type === 'claim_staked');
    }
    check(
      'claim_staked not echoed back to the staker',
      apCur.count((f) => f.type === 'claim_staked' && f.claim?.id === apClaim.claim?.id) === 0,
    );

    // Overlapping claim: rejected, and no credit leaks out of the attempt.
    // First let the SUCCESSFUL claim's new balance replicate through a tick, so
    // the "balance unchanged" comparison below compares like with like.
    await apollo.bus
      .cursor()
      .waitFor(
        (f) => deltaOf(f, apollo.playerId)?.credits === apolloCredits,
        `apollo's post-claim balance (${apolloCredits}) replicated in a tick`,
      );
    apollo.send({ type: 'CLAIM', payload: { claim_type: 'surface', x: artemisAt.x + 10, y: artemisAt.y, radius: 20 } });
    const overlap = await apCur.waitFor((f) => f.type === 'error' && f.code === 'claim_overlap', 'claim_overlap');
    check(`overlapping claim rejected (${overlap.code})`, overlap.code === 'claim_overlap');
    await sleep(TICK_MS * 3); // let any (hypothetical) debit replicate
    const apolloBalanceAfter = Number(lastCreditsDelta(apollo.bus.all(), apollo.playerId)?.credits ?? Number.NaN);
    check('no credit leaked on the rejected claim (tick-replicated balance)', apolloBalanceAfter === apolloCredits, `saw ${apolloBalanceAfter}`);
    const dbApolloCredits = await db.get<Record<string, unknown>>('SELECT credits FROM players WHERE id = ?', [apollo.playerId]);
    check(
      'no credit leaked on the rejected claim (SQLite balance)',
      Number(dbApolloCredits?.credits) === apolloCredits,
      `db ${String(dbApolloCredits?.credits)}`,
    );

    // HELIOS drilling inside RUSTBELT's ground is refused outright.
    const helCur = helios.bus.cursorFromStart();
    helios.move({ x: target.station.x, y: target.station.y, z: 0, vx: 0, vy: 0, vz: 0, mode: 'suit' });
    helios.send({ type: 'MINE', payload: { resource: ledger, amount: 5 } });
    const hostile = await helCur.waitFor((f) => f.type === 'error' && f.code === 'claim_denied', 'claim_denied (premium)');
    check('hostile extraction inside another faction claim denied', hostile.code === 'claim_denied');
    helios.send({ type: 'MINE', payload: { resource: 'regolith', amount: 5 } });
    const hostileGrit = await helCur.waitFor((f) => f.type === 'error' && f.code === 'claim_denied', 'claim_denied (regolith)');
    check('even regolith is blocked inside a hostile claim', hostileGrit.code === 'claim_denied');

    const pongCursors = bots.map((b) => b.bus.cursor());
    for (const b of bots) b.send({ type: 'PING' });
    const pongs = await Promise.all(pongCursors.map((c, i) => c.waitFor((f) => f.type === 'PONG', `${bots[i].spec.username} PONG`)));
    check('PING -> PONG on all three sockets concurrently', pongs.every((p) => typeof p.t === 'number'));

    apollo.sendRaw('{not json');
    const badJson = await pongCursors[0].waitFor((f) => f.type === 'error' && f.code === 'bad_json', 'bad_json');
    check('malformed frame rejected without killing the socket (bad_json)', badJson.code === 'bad_json');
    apollo.send({ type: 'TELEPORT', payload: { x: 1 } });
    const unknownType = await pongCursors[0].waitFor((f) => f.type === 'error' && f.code === 'unknown_type', 'unknown_type');
    check('unsupported message type rejected (unknown_type)', unknownType.code === 'unknown_type');

    const world1 = (await (await fetch(`http://127.0.0.1:${port}/api/world`)).json()) as { claims: unknown[] };
    check('GET /api/world now lists both claims', world1.claims.length === 2, `claims ${world1.claims.length}`);

    // Disconnect: shard evicts, peers notified, ticks stop mentioning him.
    const leftCursors = [apollo, rustbelt].map((b) => b.bus.cursor());
    helios.ws.close(1000, 'driller off shift');
    check('helios_driller socket closed cleanly', (await helios.closed()) === true);
    for (const peer of leftCursors) {
      const gone = await peer.waitFor((f) => f.type === 'player_left' && f.player_id === helios.playerId, 'player_left broadcast');
      check('player_left broadcast to the remaining clients', gone.type === 'player_left');
    }
    check('GET /health drops to 2 players after the disconnect', (await waitForPlayerCount(port, 2)) === 2);
    // Arm the cursor AFTER the eviction landed, so only post-leave frames count.
    const postLeaveCursor = rustbelt.bus.cursor();
    await sleep(TICK_MS * 3);
    check(
      'departed player no longer appears in delta ticks',
      postLeaveCursor.count((f) => isTickOf(f, helios.playerId)) === 0,
    );

    // ==================================================================
    section('7. SQLITE ACID — pragmas, second connection, atomic rollback');
    // ==================================================================
    for (const [key, want] of [
      ['journal_mode', 'wal'],
      ['foreign_keys', '1'],
      ['busy_timeout', '5000'],
    ] as const) {
      // sqlite returns pragmas under their own column names (busy_timeout is
      // reported as `timeout`), so read the first value of the single row.
      const row = await db.get<Record<string, unknown>>(`PRAGMA ${key}`);
      const value = row === undefined ? '' : String(Object.values(row)[0] ?? '').toLowerCase();
      check(`PRAGMA ${key} = ${want}`, value === want, `got ${JSON.stringify(row)}`);
    }
    check('second live connection sees 2 persisted claims', (await db.count('claims')) === 2);
    check('second live connection sees 3 registered accounts', (await db.count('players')) === 3);

    const doomed = 'doomed-claim-' + Math.random().toString(36).slice(2, 10);
    let rolledBackThrew = false;
    try {
      await db.withTransaction(async () => {
        await db.run(
          'INSERT INTO claims (id, player_id, x, y, radius, claim_type, status) VALUES (?,?,?,?,?,?,?)',
          [doomed, rustbelt.playerId, 1, 1, 5, 'surface', 'active'],
        );
        await db.run('UPDATE players SET credits = credits - 99999 WHERE id = ?', [rustbelt.playerId]);
        throw new Error('simulated mid-transaction failure');
      });
    } catch (err) {
      rolledBackThrew = String((err as Error).message).includes('simulated mid-transaction failure');
    }
    check('mid-transaction failure propagated to the caller', rolledBackThrew);
    check('rollback removed the half-written claim row', (await db.get('SELECT id FROM claims WHERE id = ?', [doomed])) === undefined);
    check('rollback undid the credit mutation', Number((await db.get<Record<string, unknown>>('SELECT credits FROM players WHERE id = ?', [rustbelt.playerId]))?.credits) === creditsFromServer);
    check('rollback left the claims count untouched', (await db.count('claims')) === 2);

    const dupe = await db
      .run(
        'INSERT INTO players (id, username, faction, credits, role, created_at) VALUES (?,?,?,?,?,?)',
        ['dupe-id', 'rustbelt_miner', 'RUSTBELT', 1, 'driller', new Date().toISOString()],
      )
      .then(() => 'inserted')
      .catch(() => 'rejected');
    check('UNIQUE username constraint enforced against duplicate accounts', dupe === 'rejected', dupe);

    const minCredits = await db.get<Record<string, unknown>>('SELECT MIN(credits) AS lo FROM players');
    check('no account balance went negative', Number(minCredits?.lo) >= 0, JSON.stringify(minCredits));
    const spatialCols = await db.all<{ name: string; type: string }>(
      "SELECT name, type FROM pragma_table_info('claims') WHERE name IN ('x','y','radius')",
    );
    check('claim anchors persisted as typed REAL columns', spatialCols.length === 3 && spatialCols.every((c) => c.type === 'REAL'), JSON.stringify(spatialCols));

    // ==================================================================
    section('8. DURABILITY — everything survives a full restart');
    // ==================================================================
    await server.stop();
    server = null;
    const downAfterStop = await fetch(`http://127.0.0.1:${port}/health`).then(() => 'still-up', () => 'down');
    check('HTTP surface closed after stop()', downAfterStop === 'down');

    // Independent post-mortem read of the very same file.
    const reopened = new DatabaseManager(DB_PATH);
    await reopened.initialize();
    const durPlayers = await reopened.all<Record<string, unknown>>('SELECT * FROM players ORDER BY username');
    check('3 player accounts survived the restart', durPlayers.length === 3, `rows ${durPlayers.length}`);
    const durMiner = durPlayers.find((p) => p.username === 'rustbelt_miner');
    check(
      `rustbelt_miner's faction + credits survived (${durMiner?.credits})`,
      durMiner?.faction === 'RUSTBELT' && Number(durMiner?.credits) === creditsFromServer,
      JSON.stringify(durMiner),
    );
    check('both claims survived the restart', (await reopened.all('SELECT id FROM claims')).length === 2);
    const durRes = await reopened.get<Record<string, unknown>>('SELECT * FROM resources WHERE player_id = ?', [rustbelt.playerId]);
    check(
      `mined tonnage survived (${ledger}=${durRes?.[ledger]}, regolith=${durRes?.regolith})`,
      Number(durRes?.[ledger]) === minedTotal && Number(durRes?.regolith) === GRIT_AMOUNT,
    );

    // A fresh shard boots on the same file; the miner logs straight back in.
    server = new LunarServer({ port: 0, host: '127.0.0.1', dbPath: DB_PATH, wsPath: WS_PATH });
    const addr2 = await server.start();
    const port2 = Number(new URL(addr2).port);
    const returner = new Bot({ username: 'rustbelt_miner', faction: 'RUSTBELT', role: 'driller' }, `ws://127.0.0.1:${port2}${WS_PATH}`);
    bots.push(returner);
    await returner.open();
    const rCur = returner.bus.cursor();
    returner.send({ type: 'JOIN', payload: { username: 'rustbelt_miner', faction: 'RUSTBELT', role: 'driller' } });
    const reJoin = await rCur.waitFor((f) => f.type === 'welcome', 'returning miner welcome');
    check('returning miner re-authenticated to the SAME account id', reJoin.player?.id === rustbelt.playerId, JSON.stringify(reJoin.player));
    check(`returning miner's persisted balance restored (${reJoin.player?.credits})`, Number(reJoin.player?.credits) === creditsFromServer);
    check('returning miner sees exactly his 1 own claim', Array.isArray(reJoin.own_claims) && reJoin.own_claims.length === 1, `${reJoin.own_claims?.length}`);
    check('returning miner sees both claims in the world snapshot', Array.isArray(reJoin.world?.claims) && reJoin.world.claims.length === 2);

    // Position continuity on the rebuilt shard.
    returner.move({ x: target.station.x, y: target.station.y, z: target.station.z, vx: 0, vy: 0, vz: 0, mode: 'suit' });
    const echoed = await rCur.waitFor(
      (f) => isTickOf(f, rustbelt.playerId) && deltaOf(f, rustbelt.playerId)?.x === target.station.x,
      'position echo after restart',
    );
    check('authoritative position replicated on the rebuilt shard', echoed.type === 'tick');

    // Claim gate still bites after the restart (far from the owned claim).
    returner.move({ x: 300, y: 300, z: 0, vx: 0, vy: 0, vz: 0, mode: 'suit' });
    returner.send({ type: 'MINE', payload: { resource: 'water_ice', amount: 3 } });
    const stillGated = await rCur.waitFor((f) => f.type === 'error' && f.code === 'claim_required', 'post-restart claim gate');
    check('claim permission logic intact after restart', stillGated.code === 'claim_required');

    await reopened.close();

    // ==================================================================
    section('9. SHUTDOWN — sockets, HTTP, idempotency');
    // ==================================================================
    for (const b of bots) if (b.ws.readyState !== WebSocket.CLOSED) b.ws.close(1000, 'e2e complete');
    const closedFlags = await Promise.all(bots.map((b) => b.closed()));
    check(`all ${bots.length} client sockets closed`, closedFlags.every(Boolean), JSON.stringify(closedFlags));

    await server.stop();
    server = null;
    const downFinally = await fetch(`http://127.0.0.1:${port2}/health`).then(() => 'still-up', () => 'down');
    check('HTTP surface closed after final stop()', downFinally === 'down');

    const cold = new LunarServer({ port: 0, host: '127.0.0.1', dbPath: path.join(TMP_DIR, 'cold.db'), wsPath: WS_PATH });
    let idempotent = true;
    try {
      await cold.stop();
      await cold.stop();
    } catch {
      idempotent = false;
    }
    check('stop() on a never-started server is idempotent and throws nothing', idempotent);
  } catch (err) {
    fatal = err;
  } finally {
    // -- teardown (always runs) --------------------------------------------
    let teardownClean = true;
    try {
      if (server !== null) await server.stop();
    } catch {
      teardownClean = false;
    }
    try {
      if (reader !== null) await reader.close();
    } catch {
      teardownClean = false;
    }
    for (const b of bots) {
      try {
        if (b.ws.readyState !== WebSocket.CLOSED) b.ws.terminate();
      } catch {
        /* already gone */
      }
    }
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
    fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 3 });

    section('CLEANUP');
    check('temporary SQLite files removed', !['', '-wal', '-shm'].some((s) => fs.existsSync(DB_PATH + s)));
    check('temporary database directory removed', !fs.existsSync(TMP_DIR));
    check('teardown completed without errors', teardownClean);
  }

  // -- verdict ------------------------------------------------------------
  console.log('\n' + '='.repeat(66));
  if (fatal !== null || failures.length > 0) {
    if (fatal !== null) {
      console.error(`ABORTED: ${(fatal as Error)?.message ?? String(fatal)}`);
      const stack = String((fatal as Error)?.stack ?? '');
      if (stack !== '') console.error(stack.split('\n').slice(1, 4).join('\n'));
    }
    for (const f of failures) console.error(`  ✘ ${f}`);
    console.error(`${failures.length} CHECK(S) FAILED — ${passed} passed`);
    process.exitCode = 1;
    return;
  }
  console.log(`ALL ${passed} CHECKS PASSED ✔  (multi-client E2E, TASK-PLAY-051)`);
  console.log('='.repeat(66));
  process.exitCode = 0;
}

main().catch((err: unknown) => {
  console.error('\n' + '='.repeat(66));
  console.error(`E2E ABORTED OUTSIDE MAIN: ${(err as Error)?.message ?? String(err)}`);
  console.error(`${passed} checks had passed before the abort`);
  process.exitCode = 1;
});
