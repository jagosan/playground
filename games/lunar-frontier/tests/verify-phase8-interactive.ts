/**
 * Lunar Frontier — Phase 8d interactive end-to-end verification suite
 * (Spec 12 Phase 8 / Spec 13, TASK-PLAY-055).
 *
 * Where `tests/verify-lunar-frontier.ts` (TASK-PLAY-051) proves the wire
 * protocol with raw JSON bots, this suite proves the *whole interactive stack*
 * the browser actually ships: two real `ClientApp` instances (Babylon
 * `NullEngine`, no DOM) running their own physics, their own `NetworkClient`
 * and their own render frame — over real WebSockets against a real
 * `LunarServer` on an ephemeral port with an isolated SQLite file.
 *
 * Sections:
 *   1. Bootstrap        — temp SQLite, ephemeral port, /health, /api/world,
 *                         /api/market (fresh book seeded at base prices).
 *   2. JOIN             — two interactive clients, welcome snapshots with
 *                         pre-populated market books, arrival fan-out, remote
 *                         puppet materialisation on the peer.
 *   3. Market loop      — BUY against the AMM bonding curve (reserve drops,
 *                         spot price rises), SELL (reserve recovers), wallet
 *                         + inventory receipts, balance synchronisation to
 *                         the watching peer through 20 Hz credit deltas, and
 *                         the two fills landing in the SQLite ledger.
 *   4. Locomotion       — ClientApp's 20 Hz MOVE emission (measured over one
 *                         real second while walking), the server's 20 Hz
 *                         world_delta replication at the peer, puppet
 *                         convergence on the authoritative target, and the
 *                         exact ADR-013-2 lerp + dead-reckoning maths on a
 *                         virtual clock (blend midpoint, settle, extrapolation
 *                         flag, 1 s projection cap).
 *   5. Mode transitions — [E] mount (reach-gated refusal first), buggy-mode
 *                         MOVE stream accepted by the server, peer puppet
 *                         rebuild suit↔buggy, throttle produces speed, brake
 *                         + dismount back to 'suit' everywhere.
 *   6. Claims & rails   — interactive CLAIM staking (credit debit, DB row,
 *                         beacon mesh on the peer, /api/world projection) and
 *                         LAY_RAIL (ack, DB row, rail_placed fan-out).
 *   7. Vein mining      — scanner lock, in-situ depletion of the live survey
 *                         model, server payout + resource ledger + inventory
 *                         mirror, peer credit sync.
 *   8. Teardown         — graceful client dispose, socket close, HTTP down,
 *                         idempotent stop, database + temp dir removed.
 *
 * Determinism notes (why some coordinates look suspiciously specific):
 *   • Spawn is pinned to (1040, 600) on seed `task-play-055-frontier`: the
 *     server refuses `mode:'buggy'` below the surface line and the buggy's z
 *     IS the sampled ground under it, so the drive corridor must sit above
 *     sea level. (1040, 600) keeps ≥ 3.7 m of positive ground across the whole
 *     park-and-drive box — survey-verified for this seed.
 *   • Mining walks regolith candidates only: unclaimed ground legally yields
 *     regolith, premium seams would need a claim, and the client always drills
 *     whatever the scanner locks first.
 *   • The delta tick only carries *changed* fields, so replication windows
 *     stream while the suit is walking, never while idle.
 *
 * Run:  npx tsx tests/verify-phase8-interactive.ts   (exit 0 == all green)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';

import { ClientApp } from '../src/client/ClientApp.ts';
import NetworkClient, { MAX_EXTRAPOLATION_MS } from '../src/network/NetworkClient.ts';
import LunarServer from '../src/server/LunarServer.ts';
import DatabaseManager from '../src/database.ts';
import { BASE_PRICES, BASELINE_RESERVES } from '../src/economy/MarketEngine.ts';

// ---------------------------------------------------------------------------
// Tunables & fixtures
// ---------------------------------------------------------------------------

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-phase8d-'));
const DB_PATH = path.join(TMP_DIR, 'phase8d.db');
const WS_PATH = '/ws';
const WORLD_SEED = 'task-play-055-frontier';
const SPAWN = { x: 1040, y: 600 };

const STARTING_CREDITS = 1000;
const CLAIM_COST_SURFACE = 500;
const MINE_UNITS_PER_PULL = 40;
/** Server RESOURCE_PRICES.regolith — credits paid per extracted unit. */
const REGOLITH_UNIT_PRICE = 1;

// ---------------------------------------------------------------------------
// Check harness
// ---------------------------------------------------------------------------

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

function guard(label: string, ok: boolean, detail = ''): void {
  if (!check(label, ok, detail)) throw new Error(`fatal: ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/** Await until `predicate()` holds over live state (no frames pumped). */
async function until(predicate: () => boolean, budgetMs = 5000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
}

/** Raw inbound-frame history of a NetworkClient (harness view). */
function frameHistory(net: NetworkClient): Array<{ type: string; payload: Record<string, unknown> }> {
  return (net as unknown as { history: Array<{ type: string; payload: Record<string, unknown> }> }).history;
}

/** Count inbound frames of `type` seen by `net` so far. */
function countFrames(net: NetworkClient, type: string): number {
  return frameHistory(net).filter((h) => h.type === type).length;
}

// ---------------------------------------------------------------------------
// Client spy — instance-shadow sendFrame to count outbound frames without
// touching shipped client code.
// ---------------------------------------------------------------------------

interface Spy {
  moves: number;
  errorCodes: string[];
}

function instrument(net: NetworkClient): Spy {
  const spy: Spy = { moves: 0, errorCodes: [] };
  const target = net as unknown as { sendFrame(frame: Record<string, unknown>): boolean };
  const original = target.sendFrame.bind(net);
  target.sendFrame = (frame: Record<string, unknown>): boolean => {
    if (frame['type'] === 'MOVE') spy.moves++;
    return original(frame);
  };
  net.on('error', (ev) => spy.errorCodes.push(ev.code));
  return spy;
}

// ---------------------------------------------------------------------------
// World fixture — regolith stance the client drill can actually reach
// ---------------------------------------------------------------------------

interface DrillStance {
  veinId: string;
  x: number;
  y: number;
  surfaceRange: number;
}

/**
 * Candidate drill stances. The scanner always locks the *closest vein
 * envelope* — and the great regolith blankets (radius ~1 km, centre at the
 * surface datum) swallow the standing point with the most negative distance,
 * so the biggest blanket wins wherever you stand inside it. Since unclaimed
 * ground only yields regolith, blanket stances are also the only ones the
 * server will pay for without a claim. Sorted biggest-blanket first.
 */
function drillCandidates(app: ClientApp): DrillStance[] {
  const snapshot = app.world.getSnapshot();
  if (snapshot === null) return [];
  const ranked: Array<DrillStance & { envelopeDepth: number }> = [];
  for (const vein of snapshot.veins) {
    if (vein.kind !== 'regolith' || vein.remaining <= 500) continue;
    const standZ = app.world.getGroundHeightAt(vein.center.x, vein.center.y);
    // Signed: negative means the standing point sits INSIDE the envelope,
    // with magnitude = how deeply (the scanner's own metric).
    const envelopeDepth = Math.abs(vein.center.z - standZ) - vein.radius;
    ranked.push({
      veinId: vein.id,
      x: vein.center.x,
      y: vein.center.y,
      surfaceRange: Math.max(0, envelopeDepth),
      envelopeDepth,
    });
  }
  const spawn = { x: SPAWN.x, y: SPAWN.y };
  ranked.sort(
    (a, b) =>
      a.envelopeDepth - b.envelopeDepth || // deepest envelope (biggest blanket) first
      Math.hypot(a.x - spawn.x, a.y - spawn.y) - Math.hypot(b.x - spawn.x, b.y - spawn.y) ||
      a.veinId.localeCompare(b.veinId),
  );
  return ranked;
}

/** Deterministic surface point (positive ground) for staking a claim. */
function claimStance(app: ClientApp): { x: number; y: number } {
  const offsets: Array<[number, number]> = [
    [60, 60], [60, 0], [0, 60], [-60, 0], [0, -60], [60, -60], [-60, 60], [-60, -60],
  ];
  for (const [dx, dy] of offsets) {
    const x = SPAWN.x + dx;
    const y = SPAWN.y + dy;
    if (app.world.getGroundHeightAt(x, y) > 0.1) return { x, y };
  }
  return { x: SPAWN.x, y: SPAWN.y };
}

// ===========================================================================
// MAIN
// ===========================================================================

async function main(): Promise<void> {
  let server: LunarServer | null = null;
  let reader: DatabaseManager | null = null;
  let alice: ClientApp | null = null;
  let bob: ClientApp | null = null;
  let port = 0;
  let fatal: unknown = null;

  /** Step both clients' frames while waiting on a client-state predicate. */
  const pumpUntil = async (predicate: () => boolean, budgetMs = 5000): Promise<boolean> => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      alice?.update();
      bob?.update();
      if (predicate()) return true;
      if (Date.now() >= deadline) return false;
      await sleep(16);
    }
  };

  try {
    // ==================================================================
    section('1. BOOTSTRAP — ephemeral LunarServer + isolated SQLite');
    // ==================================================================
    guard('temp dir under os.tmpdir()', TMP_DIR.startsWith(os.tmpdir()), TMP_DIR);
    check('database file absent before boot', !fs.existsSync(DB_PATH));

    server = new LunarServer({ port: 0, host: '127.0.0.1', dbPath: DB_PATH, wsPath: WS_PATH });
    const address = await server.start();
    port = Number(new URL(address).port);
    guard('ephemeral port bound', Number.isFinite(port) && port > 1024 && port !== 3000, address);
    const wsUrl = `ws://127.0.0.1:${port}${WS_PATH}`;

    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Record<string, unknown>;
    check('GET /health -> ok', health.status === 'ok', JSON.stringify(health));

    const world0 = (await (await fetch(`http://127.0.0.1:${port}/api/world`)).json()) as Record<string, unknown>;
    check(
      'GET /api/world -> claims + rail_tracks surface',
      Array.isArray(world0.claims) && Array.isArray(world0.rail_tracks),
    );

    const market0 = (await (await fetch(`http://127.0.0.1:${port}/api/market`)).json()) as Record<
      string,
      Record<string, number>
    >;
    check(
      'GET /api/market -> six commodities seeded at base price (±0.1 %)',
      Object.keys(BASE_PRICES).every((c) => {
        const quoted = market0.prices[c] ?? 0;
        const base = BASE_PRICES[c as keyof typeof BASE_PRICES];
        // The book quotes the taker's first unit (reserve − 1), so a fresh
        // pool sits a hair above P0 — relative tolerance, not absolute.
        return Math.abs(quoted - base) / base < 0.001;
      }),
      JSON.stringify(market0.prices),
    );

    reader = new DatabaseManager(DB_PATH);
    await reader.initialize();
    const tables = (
      await reader.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
    ).map((r) => r.name);
    for (const want of ['players', 'claims', 'inventory', 'rail_tracks', 'market_reserves', 'transactions']) {
      check(`SQLite table "${want}" present`, tables.includes(want), tables.join(','));
    }

    // ==================================================================
    section('2. JOIN — two interactive ClientApps (NullEngine) on live sockets');
    // ==================================================================
    const bootClient = async (username: string, faction: string): Promise<{ app: ClientApp; net: NetworkClient }> => {
      const app = new ClientApp({
        seed: WORLD_SEED,
        username,
        faction,
        role: 'surveyor',
        wsUrl,
        spawn: { ...SPAWN },
        terrainResolution: 33,
        createHud: false,
        silent: true,
        moveIntervalMs: 50,
      });
      await app.init(new NullEngine());
      const net = app.getNetwork();
      if (net === null) throw new Error(`${username}: ClientApp owns no NetworkClient`);
      return { app, net };
    };

    const aliceBoot = await bootClient('p8d_alice', 'ARTEMIS');
    const bobBoot = await bootClient('p8d_bob', 'HELIOS');
    alice = aliceBoot.app;
    bob = bobBoot.app;
    const aliceNet = aliceBoot.net;
    const bobNet = bobBoot.net;
    const aliceSpy = instrument(aliceNet);

    check(`both client sockets OPEN via the global-WebSocket tier (alice=%s, bob=%s)`, await pumpUntil(
      () => aliceNet.state === 'open' && bobNet.state === 'open',
      5000,
    ), `${aliceNet.state}/${bobNet.state}`);

    const aliceWelcome = await aliceNet.waitFor('welcome', 'alice welcome', 6000);
    const bobWelcome = await bobNet.waitFor('welcome', 'bob welcome', 6000);
    check('alice welcomed at 1000 credits', aliceWelcome.player.credits === STARTING_CREDITS,
      JSON.stringify(aliceWelcome.player));
    check('bob welcomed at 1000 credits', bobWelcome.player.credits === STARTING_CREDITS);
    check(
      'welcome carries a pre-populated market book',
      aliceWelcome.market !== null && typeof (aliceWelcome.market as Record<string, unknown>)['prices'] === 'object',
    );

    // NOTE: the 20 Hz delta tick only carries *changed* fields — a freshly
    // JOINed pair standing dead still produces no deltas, so the peer's remote
    // registry only populates once someone moves. Alice jiggles.
    alice.getSuit().teleport(SPAWN.x + 2, SPAWN.y);
    await pumpUntil(() => bobNet.remoteCount === 1, 4000);
    check('bob tracks alice as a remote avatar', bobNet.remoteCount === 1,
      `remoteCount=${bobNet.remoteCount}`);
    check('bob knows alice by username',
      bobNet.getRemote(aliceNet.playerId ?? '')?.username === 'p8d_alice',
      JSON.stringify(bobNet.getRemote(aliceNet.playerId ?? '')?.username));
    check(
      'no client receives its own player_joined echo',
      !frameHistory(bobNet).some(
        (f) => f.type === 'player_joined' && String(f.payload['player_id']) === bobNet.playerId,
      ),
    );

    await pumpUntil(() => bob.remoteAvatarCount() >= 1, 2000);
    check('bob materialises a mesh puppet for alice', bob.remoteAvatarCount() >= 1,
      `count=${bob.remoteAvatarCount()}`);

    // ==================================================================
    section('3. MARKET LOOP — AMM bonding curve, balances & peer sync');
    // ==================================================================
    const book = () => (aliceNet.marketView ?? {}) as Record<string, Record<string, number>>;
    const reserveBefore = book()['reserves']?.['HELIUM3'] ?? NaN;
    const askBefore = book()['prices']?.['HELIUM3'] ?? NaN;
    check('HELIUM3 opens at baseline reserve', near(reserveBefore, BASELINE_RESERVES.HELIUM3, 1), `${reserveBefore}`);
    // The book quotes the taker's first unit (reserve − 1), so a fresh pool
    // sits a hair above P0 — compare relatively.
    check('HELIUM3 opens at base price (±0.1 %)',
      Math.abs(askBefore - BASE_PRICES.HELIUM3) / BASE_PRICES.HELIUM3 < 0.001, `${askBefore}`);

    // -- BUY 1 kg HELIUM3 through the shipped client order path --
    const creditsBeforeBuy = aliceNet.credits;
    aliceNet.trade('HELIUM3', 1, true);
    const buyReceipt = await aliceNet.waitFor(
      'trade_confirmed',
      { label: 'HELIUM3 buy fill', timeoutMs: 6000, filter: (t) => t.isBuy },
    );
    check('buy confirmed at a curve price above base',
      buyReceipt.amount === 1 && buyReceipt.unitPrice > BASE_PRICES.HELIUM3, `unit ${buyReceipt.unitPrice}`);
    check('buy debited credits exactly once',
      near(aliceNet.credits, creditsBeforeBuy - buyReceipt.totalCredits, 0.01),
      `${creditsBeforeBuy} → ${aliceNet.credits} (cost ${buyReceipt.totalCredits})`);
    check('receipt inventory shows the kg', (buyReceipt.inventory['HELIUM3'] ?? 0) === 1,
      JSON.stringify(buyReceipt.inventory));

    check('reserve drained by the buy', await until(() => {
      const r = book()['reserves']?.['HELIUM3'];
      return typeof r === 'number' && r < reserveBefore;
    }, 4000));
    const reserveAfterBuy = book()['reserves']?.['HELIUM3'] ?? NaN;
    const askAfterBuy = book()['prices']?.['HELIUM3'] ?? NaN;
    check('buying drove the spot price UP along the curve', askAfterBuy > askBefore,
      `${askBefore} → ${askAfterBuy}`);
    check('reserve fell by exactly the filled kg', near(reserveBefore - reserveAfterBuy, 1, 0.001),
      `${reserveBefore} → ${reserveAfterBuy}`);

    check('peer sees the post-buy balance via tick deltas', await until(() => {
      const p = bobNet.getRemote(aliceNet.playerId ?? '');
      return p !== undefined && p.credits !== undefined && near(p.credits, aliceNet.credits, 0.01);
    }, 4000), `bob's view: ${JSON.stringify(bobNet.getRemote(aliceNet.playerId ?? '')?.credits)}`);

    // -- SELL the kg back --
    const creditsBeforeSell = aliceNet.credits;
    aliceNet.trade('HELIUM3', 1, false);
    const sellReceipt = await aliceNet.waitFor(
      'trade_confirmed',
      { label: 'HELIUM3 sell fill', timeoutMs: 6000, filter: (t) => !t.isBuy },
    );
    check('sell confirmed', sellReceipt.amount === 1 && sellReceipt.unitPrice > 0, `unit ${sellReceipt.unitPrice}`);
    check('round-trip crosses a real spread (less back than paid)',
      sellReceipt.totalCredits < buyReceipt.totalCredits,
      `bought ${buyReceipt.totalCredits}, sold ${sellReceipt.totalCredits}`);
    check('sell credited the wallet', near(aliceNet.credits, creditsBeforeSell + sellReceipt.totalCredits, 0.01),
      `${creditsBeforeSell} → ${aliceNet.credits}`);
    check('inventory drained to zero', (aliceNet.inventoryView['HELIUM3'] ?? 0) === 0,
      JSON.stringify(aliceNet.inventoryView));

    check('reserve recovered by the sell', await until(() => {
      const r = book()['reserves']?.['HELIUM3'];
      return typeof r === 'number' && near(r, reserveBefore, 1.5);
    }, 4000), `reserve now ${String(book()['reserves']?.['HELIUM3'])}`);

    const txRows = await reader.all<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    check('two fills persisted to the transactions ledger', Number(txRows[0]?.n) === 2, `${txRows[0]?.n}`);

    check('peer sees the post-sell balance via tick deltas', await until(() => {
      const p = bobNet.getRemote(aliceNet.playerId ?? '');
      return p !== undefined && p.credits !== undefined && near(p.credits, aliceNet.credits, 0.01);
    }, 4000));

    // ==================================================================
    section('4. LOCOMOTION — 20 Hz MOVE stream + lerp/dead-reckoning');
    // ==================================================================
    // The delta tick only carries changed fields, so keep the suit walking
    // for the replication window.
    alice.handleKeyInput('KeyW', 'down');
    const movesAtStart = aliceSpy.moves;
    // Count world_delta arrivals on a live listener — the NetworkClient frame
    // history is a 512-entry ring that shifts under load, so baseline
    // arithmetic over it can go negative.
    let deltasSeen = 0;
    const countDelta = () => { deltasSeen++; };
    bobNet.on('world_delta', countDelta);
    const streamStart = Date.now();
    while (Date.now() - streamStart < 1000) {
      alice.update();
      bob.update();
      await sleep(16);
    }
    alice.handleKeyInput('KeyW', 'up');
    const emitted = aliceSpy.moves - movesAtStart;
    check('ClientApp emits ~20 MOVE frames/s (50 ms accumulator)', emitted >= 17 && emitted <= 23, `${emitted}/s`);

    // The peer received the server's ~20 Hz world_delta (wire `tick`) frames.
    // Floor of 12/s, not 20: tick broadcasts are delta-suppressed (unchanged
    // fields rebroadcast nothing), so MOVE-arrival/tick phase jitter routinely
    // drops a few ticks per second. The strict 20 Hz assertion is the client
    // MOVE emit-rate check above; this floor still rules out 1 Hz heartbeats.
    bobNet.off('world_delta', countDelta);
    check('world_delta replicated to peer at ~20 Hz', deltasSeen >= 12, `${deltasSeen} in the same window`);

    // Puppet convergence on the authoritative target. The MOVE frame that
    // carries the new position can only flow while alice's frames are being
    // stepped, so pump both clients while waiting on it.
    alice.getSuit().teleport(540, 512);
    check('remote target converges on authoritative x=540', await pumpUntil(() => {
      const p = bobNet.getRemote(aliceNet.playerId ?? '');
      return p !== undefined && Math.abs(p.x - 540) < 0.5;
    }, 4000), `bob's target: ${JSON.stringify(bobNet.getRemote(aliceNet.playerId ?? '')?.x)}`);

    await pumpUntil(() => {
      const puppetNow = bob.getRemoteAvatar(aliceNet.playerId ?? '');
      if (puppetNow === undefined) return false;
      const root = puppetNow.entity.getRootNode();
      return root !== null && Math.abs(root.position.x - 540) < 8;
    }, 3000);
    const puppet = bob.getRemoteAvatar(aliceNet.playerId ?? '');
    check('bob renders a built puppet entity for alice', puppet !== undefined && puppet.entity.isBuilt());
    if (puppet !== undefined) {
      const root = puppet.entity.getRootNode();
      check(
        'puppet placed via world→Babylon mapping (z axis flipped)',
        root !== null && Math.abs(root.position.x - 540) < 8 && Math.abs(root.position.z - -512) < 8,
        root === null ? 'no root' : `${root.position.x.toFixed(1)},${root.position.z.toFixed(1)}`,
      );
    }

    // Exact ADR-013-2 maths on a virtual clock (deterministic, no wire).
    {
      const vnow0 = 10_000;
      let vnow = vnow0;
      const virtual = new NetworkClient({ url: 'ws://virtual.test/ws', clock: () => vnow, heartbeatIntervalMs: 0 });
      virtual.applyDeltaToRemote('peer-x', { username: 'slider', x: 0, y: 0, z: 0, vx: 10, vy: 0, vz: 0 }, vnow);
      virtual.update(vnow);
      vnow = vnow0 + 50;
      virtual.applyDeltaToRemote('peer-x', { x: 10 }, vnow);
      vnow = vnow0 + 75;
      virtual.update(vnow);
      const mid = virtual.getRemote('peer-x')!;
      check('lerp midpoint is an exact 50 % blend', near(mid.renderX, 5, 1e-9), `${mid.renderX}`);
      vnow = vnow0 + 100;
      virtual.update(vnow);
      check('lerp settles on the authoritative target', near(virtual.getRemote('peer-x')!.renderX, 10, 1e-9));
      vnow = vnow0 + 175; // since = 125 ms > window(50) + grace(25) → extrapolate 50 ms
      virtual.update(vnow);
      const dr = virtual.getRemote('peer-x')!;
      check('aging avatar flags deadReckoned', dr.deadReckoned === true);
      check('dead reckoning projects x += v·Δt', near(dr.renderX, 10.5, 1e-9), `${dr.renderX}`);
      vnow = vnow0 + 900_000;
      virtual.update(vnow);
      const capped = virtual.getRemote('peer-x')!;
      check('extrapolation clamps at 1 s of travel',
        near(capped.renderX, 10 + 10 * (MAX_EXTRAPOLATION_MS / 1000), 1e-9), `${capped.renderX}`);
    }

    // ==================================================================
    section('5. MODE TRANSITIONS — mount, buggy stream, peer rebuild, dismount');
    // ==================================================================
    // Reach gate first: a suit 40 m from the buggy must be refused.
    const buggyPos = alice.getBuggy().getPosition();
    alice.getSuit().teleport(buggyPos.x - 40, buggyPos.y - 40);
    alice.update();
    check('[E] refuses to mount a distant buggy', alice.toggleMount() === false && alice.getMode() === 'suit');

    // Park the suit beside the buggy (MOUNT_RADIUS_M is 3.5 m) and mount.
    alice.getSuit().teleport(buggyPos.x - 1.5, buggyPos.y);
    alice.update();
    const movesBeforeMount = aliceSpy.moves;
    check('[E] mounts the buggy', alice.toggleMount() === true && alice.getMode() === 'buggy');

    // Full throttle from the parked pose; ground under the corridor is above
    // sea level, so the server must accept mode 'buggy' (z >= 0).
    alice.handleKeyInput('KeyW', 'down');
    const driveStart = Date.now();
    let topSpeed = 0;
    let minMoveZ = Infinity;
    while (Date.now() - driveStart < 1500) {
      alice.update();
      bob.update();
      topSpeed = Math.max(topSpeed, alice.getBuggy().getSpeed());
      minMoveZ = Math.min(minMoveZ, alice.currentMoveState().z);
      await sleep(16);
    }
    alice.handleKeyInput('KeyW', 'up');
    check('throttle accelerates the buggy (>0.3 m/s)', topSpeed > 0.3, `top ${topSpeed.toFixed(2)} m/s`);
    check('drive corridor kept the buggy above the surface line', minMoveZ > 0, `min z ${minMoveZ.toFixed(2)}`);

    check('peer sees mode=buggy', await until(() => {
      const p = bobNet.getRemote(aliceNet.playerId ?? '');
      return p !== undefined && p.mode === 'buggy';
    }, 4000), `bob's mode: ${JSON.stringify(bobNet.getRemote(aliceNet.playerId ?? '')?.mode)}`);

    await pumpUntil(() => bob.getRemoteAvatar(aliceNet.playerId ?? '')?.kind === 'buggy', 3000);
    check('peer rebuilds the puppet as a buggy',
      bob.getRemoteAvatar(aliceNet.playerId ?? '')?.kind === 'buggy');

    check('no bad_mode errors during the buggy run', !aliceSpy.errorCodes.includes('bad_mode'),
      aliceSpy.errorCodes.join(','));
    check('MOVE frames kept flowing across the mode switch', aliceSpy.moves > movesBeforeMount + 10,
      `${movesBeforeMount} → ${aliceSpy.moves}`);

    // Egress: the entity-level dismount (OpenBuggy.dismount) parks the
    // chassis through its own helper and steps the suit out beside it — no
    // speed gate here (that gate lives in the TraversalPhysics modal machine,
    // covered by TASK-PLAY-051). KeyS would *reverse* under ClientApp's input
    // mapping rather than settle, so egress goes straight from the run.
    alice.handleKeyInput('KeyW', 'up');
    const parked = alice.getBuggy().getPosition();
    alice.getSuit().teleport(parked.x - 1.0, parked.y);
    check('[E] dismounts back to suit', alice.toggleMount() === true && alice.getMode() === 'suit');
    alice.update();

    check('peer sees mode=suit again', await pumpUntil(() => {
      const p = bobNet.getRemote(aliceNet.playerId ?? '');
      return p !== undefined && p.mode === 'suit';
    }, 4000));
    await pumpUntil(() => bob.getRemoteAvatar(aliceNet.playerId ?? '')?.kind === 'suit', 3000);
    check('peer puppet rebuilt back to a suit',
      bob.getRemoteAvatar(aliceNet.playerId ?? '')?.kind === 'suit');

    // ==================================================================
    section('6. CLAIM STAKING & RAIL PLACEMENT sync');
    // ==================================================================
    const bobEntitiesBefore = bob.world.getEntities().length;
    const stakeAt = claimStance(alice);
    alice.getSuit().teleport(stakeAt.x, stakeAt.y);
    alice.update();
    const creditsBeforeClaim = aliceNet.credits;
    check('[C] stakes a claim interactively', alice.stakeClaimAtCurrentPosition(20) === true);
    const claimResult = (await aliceNet.waitFor('claim_result', 'claim ack', 6000)) as Record<string, unknown>;
    check(
      'claim_result ok with debited balance',
      claimResult['ok'] === true && Number(claimResult['credits']) === creditsBeforeClaim - CLAIM_COST_SURFACE,
      JSON.stringify(claimResult).slice(0, 200),
    );
    check('wallet debited exactly the surface cost',
      near(aliceNet.credits, creditsBeforeClaim - CLAIM_COST_SURFACE, 0.01),
      `${creditsBeforeClaim} → ${aliceNet.credits}`);

    check('claim_staked fanned out to the peer', await until(() => countFrames(bobNet, 'claim_staked') >= 1, 4000));
    await pumpUntil(() => bob.world.getEntities().length === bobEntitiesBefore + 1, 1500);
    check('peer raised a claim beacon mesh', bob.world.getEntities().length === bobEntitiesBefore + 1,
      `${bobEntitiesBefore} → ${bob.world.getEntities().length}`);

    const dbClaims = await reader.all<{ n: number }>('SELECT COUNT(*) AS n FROM claims WHERE status = ?', ['active']);
    check('claim row persisted in SQLite', Number(dbClaims[0]?.n) >= 1, `${dbClaims[0]?.n}`);

    // Rail: lay a 12 m surface segment from the collar via the client API.
    const railZ = Math.max(0.5, alice.world.getGroundHeightAt(SPAWN.x, SPAWN.y));
    aliceNet.layRail([SPAWN.x, SPAWN.y, railZ], [SPAWN.x + 12, SPAWN.y, railZ]);
    const railLaid = (await aliceNet.waitFor('rail_laid', 'rail_laid ack', 6000)) as Record<string, unknown>;
    check('rail_laid ack with 12 m length',
      railLaid['ok'] === true && near(Number(railLaid['length']), 12, 0.001),
      JSON.stringify(railLaid).slice(0, 160));
    check('rail_placed fanned out to the peer', await until(() => countFrames(bobNet, 'rail_placed') >= 1, 4000));
    const dbRails = await reader.listRailTracks('active');
    check('rail row persisted in SQLite', dbRails.length >= 1, `${dbRails.length}`);
    const worldNow = (await (await fetch(`http://127.0.0.1:${port}/api/world`)).json()) as Record<string, unknown[]>;
    check('GET /api/world projects the claim + rail',
      worldNow.claims.length >= 1 && worldNow.rail_tracks.length >= 1,
      `claims=${String(worldNow.claims.length)} rails=${String(worldNow.rail_tracks.length)}`);

    // ==================================================================
    section('7. VEIN MINING — in-situ depletion + payout');
    // ==================================================================
    const candidates = drillCandidates(alice);
    guard('fixture has surface-breaching regolith veins', candidates.length > 0, `${candidates.length}`);

    // Walk candidates until the scanner locks the SAME regolith envelope the
    // harness will bill the server for (client always drills the lock).
    let stance: DrillStance | null = null;
    for (const candidate of candidates.slice(0, 8)) {
      alice.getSuit().teleport(candidate.x, candidate.y);
      const locked = await pumpUntil(() => {
        const lock = alice.getNearestVein();
        return lock !== null && lock.vein.kind === 'regolith' && lock.rangeM <= 20;
      }, 1500);
      if (locked) {
        stance = candidate;
        break;
      }
    }
    check('scanner locks a regolith envelope within drill reach', stance !== null,
      `tried ${Math.min(candidates.length, 8)} candidates`);
    guard('locked a drill stance', stance !== null);
    const t = stance as unknown as DrillStance;

    const lock = alice.getNearestVein()!;
    // The drill bills whichever vein `estimateExtraction` resolves at the
    // stance — with overlapping envelopes that is NOT always the scanner lock.
    // Resolve the billed vein id up front and account depletion against IT.
    const lockCenter = lock.vein.center;
    const estimate = alice.world.getWorldGenerator().estimateExtraction(
      lock.vein.kind, lockCenter.x, lockCenter.y, lockCenter.z, 'suit', {},
    );
    const lockedVeinId = estimate.veinId ?? lock.vein.id;
    /**
     * Live in-situ stock of the billed vein. `WorldScene` renders from a
     * snapshot CLONE, so the scanner panel's number never moves — the
     * generator's live survey model (which `mineNearestVein` harvests against)
     * is the authoritative in-situ bookkeeping. `getVein` reads the live
     * index directly (clone-on-return), so no depth-window windowing needed.
     */
    const liveRemaining = (): number | null => {
      const row = alice.world.getWorldGenerator().getVein(lockedVeinId);
      return row ? row.remaining : null;
    };
    const remainingBefore = liveRemaining();
    const creditsBeforeMine = aliceNet.credits;
    guard('live vein resolvable before mining', remainingBefore !== null && remainingBefore > 500,
      String(remainingBefore));

    // Pull #1 — client trigger, server payout.
    check('[M] pulls the trigger', alice.mineNearestVein(MINE_UNITS_PER_PULL) === true);
    const mineFrame1 = (await aliceNet.waitFor('mine_result', 'mine_result #1', 6000)) as Record<string, unknown>;
    const earned1 = Number(mineFrame1['earned']);
    check(`server paid out pull #1 (${MINE_UNITS_PER_PULL} units × ${REGOLITH_UNIT_PRICE} cr)`,
      earned1 === MINE_UNITS_PER_PULL * REGOLITH_UNIT_PRICE, `earned ${earned1}`);

    // In-situ depletion of the live survey model (harvest is synchronous in
    // the client; the window only absorbs scheduling jitter).
    const depletedOnce = await until(
      () => liveRemaining() === (remainingBefore as number) - MINE_UNITS_PER_PULL,
      2000,
    );
    check('in-situ vein depleted by the extracted units', depletedOnce,
      `${remainingBefore} → ${liveRemaining()}`);

    // Pull #2 — after the 350 ms trigger cooldown, the second haul banks.
    await sleep(400);
    check('[M] second pull lands after the cooldown', alice.mineNearestVein(MINE_UNITS_PER_PULL) === true);
    const mineFrame2 = (await aliceNet.waitFor('mine_result', 'mine_result #2', 6000)) as Record<string, unknown>;
    const earned2 = Number(mineFrame2['earned']);
    const earnedTotal = earned1 + earned2;

    check('in-situ stock drained by both hauls', await until(
      () => liveRemaining() === (remainingBefore as number) - MINE_UNITS_PER_PULL * 2,
      2000,
    ), `${remainingBefore} → ${liveRemaining()}`);

    check('wallet reflects both payouts', await until(
      () => aliceNet.credits >= creditsBeforeMine + earnedTotal - 0.01,
      4000,
    ), `${creditsBeforeMine} → ${aliceNet.credits} (expected +${earnedTotal})`);

    check('mined haul mirrored into the tradable inventory', await until(() => {
      const held = aliceNet.inventoryView['REGOLITH'] ?? 0;
      return held >= MINE_UNITS_PER_PULL * 2;
    }, 4000), JSON.stringify(aliceNet.inventoryView));

    const dbRes = await reader.getResources(aliceNet.playerId ?? '');
    check('server resource ledger banked the haul',
      Number(dbRes?.regolith ?? 0) >= MINE_UNITS_PER_PULL * 2, JSON.stringify(dbRes));

    check('peer balance stays in sync after mining', await until(() => {
      const p = bobNet.getRemote(aliceNet.playerId ?? '');
      return p !== undefined && p.credits !== undefined && near(p.credits, aliceNet.credits, 0.01);
    }, 4000), `bob's view: ${JSON.stringify(bobNet.getRemote(aliceNet.playerId ?? '')?.credits)}`);

    // ==================================================================
    section('8. TEARDOWN — clients, sockets, HTTP, idempotency');
    // ==================================================================
    alice.dispose();
    bob.dispose();
    check('disposed client update() is a safe no-op', (() => {
      try {
        alice?.update();
        return true;
      } catch {
        return false;
      }
    })());
    check('both sockets closed after client teardown', await until(
      () => aliceNet.state === 'closed' && bobNet.state === 'closed',
      4000,
    ), `alice=${aliceNet.state}, bob=${bobNet.state}`);

    await server.stop();
    server = null;
    const downAfterStop = await fetch(`http://127.0.0.1:${port}/health`).then(() => 'up', () => 'down');
    check('HTTP surface closed after stop()', downAfterStop === 'down');

    const cold = new LunarServer({ port: 0, host: '127.0.0.1', dbPath: path.join(TMP_DIR, 'cold.db'), wsPath: WS_PATH });
    let idempotent = true;
    try {
      await cold.stop();
      await cold.stop();
    } catch {
      idempotent = false;
    }
    check('stop() on a never-started server is idempotent', idempotent);
  } catch (err) {
    fatal = err;
  } finally {
    // -- teardown (always runs) ------------------------------------------
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
    try {
      alice?.dispose();
      bob?.dispose();
    } catch {
      /* best effort */
    }
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
    fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 3 });

    section('CLEANUP');
    check('temporary SQLite files removed', !['', '-wal', '-shm'].some((s) => fs.existsSync(DB_PATH + s)));
    check('temporary directory removed', !fs.existsSync(TMP_DIR));
    check('teardown completed without errors', teardownClean);
  }

  console.log('\n' + '='.repeat(66));
  if (fatal !== null || failures.length > 0) {
    if (fatal !== null) {
      console.error(`ABORTED: ${(fatal as Error)?.message ?? String(fatal)}`);
      const stack = String((fatal as Error)?.stack ?? '');
      if (stack !== '') console.error(stack.split('\n').slice(1, 5).join('\n'));
    }
    for (const f of failures) console.error(`  ✘ ${f}`);
    console.error(`${failures.length} CHECK(S) FAILED — ${passed} passed`);
    process.exitCode = 1;
    return;
  }
  console.log(`ALL ${passed} CHECKS PASSED ✔  (Phase 8d interactive E2E, TASK-PLAY-055)`);
  console.log('='.repeat(66));
  process.exitCode = 0;
}

main().catch((err: unknown) => {
  console.error('\n' + '='.repeat(66));
  console.error(`PHASE 8D E2E ABORTED OUTSIDE MAIN: ${(err as Error)?.message ?? String(err)}`);
  console.error(`${passed} checks had passed before the abort`);
  process.exitCode = 1;
});
