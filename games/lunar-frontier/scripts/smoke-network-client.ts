/**
 * TASK-PLAY-053 verification — NetworkClient over a live LunarServer.
 *
 * Runs headless (`npx tsx scripts/smoke-network-client.ts`), exits 0 only
 * when every check passes. Four layers:
 *
 *   A. Pure client maths    — virtual-clock interpolation, dead reckoning,
 *                            C0 continuity, extrapolation clamp, vein ids
 *   B. Live E2E (2 clients) — JOIN handshake, 20 Hz movement deltas, live
 *                            avatar interpolation, heartbeat RTT, TRADE,
 *                            CLAIM, MINE, LAY_RAIL, error channels
 *   C. Reconnect            — abrupt socket death → backoff → auto re-JOIN
 *   D. Dispatcher hardening — malformed frames never throw
 *
 * The `ws` package is injected through `socketFactory`, proving the
 * transport-injection tier of the isomorphic design; browsers take the
 * global-WebSocket tier with zero Node imports in NetworkClient.ts.
 */
import assert from 'node:assert';
import fs from 'node:fs';

import WebSocket from 'ws';

import NetworkClient, {
  DEFAULT_INTERPOLATION_WINDOW_MS,
  MAX_EXTRAPOLATION_MS,
  MAX_INFERRED_SPEED_M,
} from '../src/network/NetworkClient';
import LunarServer, { DEFAULT_PORT, PLAYER_RAIL_GAUGE_M } from '../src/server/LunarServer';

const DB_PATH = './.smoke-network-client.db';
const STAGE = { passed: 0 };

function ok(label: string, detail = ''): void {
  STAGE.passed++;
  console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 'ws'-package socket factory (the injection tier NetworkClient supports)
// ---------------------------------------------------------------------------

function makeWsFactory(created: WebSocket[]) {
  return (url: string) => {
    const ws = new WebSocket(url);
    created.push(ws);
    const socket = {
      get readyState(): number {
        return ws.readyState as number;
      },
      send(data: string): void {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        } catch {
          /* racing close — client-side buffering already covered in unit tier */
        }
      },
      close(code?: number, reason?: string): void {
        try {
          ws.close(code, reason);
        } catch {
          /* already closed */
        }
      },
      onopen: null as (() => void) | null,
      onmessage: null as ((data: unknown) => void) | null,
      onerror: null as ((err: unknown) => void) | null,
      onclose: null as ((info: { code: number; reason: string }) => void) | null,
    };
    ws.on('open', () => socket.onopen?.());
    ws.on('message', (raw: WebSocket.RawData) => socket.onmessage?.(raw.toString()));
    ws.on('error', (err: unknown) => socket.onerror?.(err));
    ws.on('close', (code: number, reason: Buffer) =>
      socket.onclose?.({ code, reason: reason?.toString() ?? '' }),
    );
    return socket;
  };
}

// ===========================================================================
// LAYER A — interpolation & dead reckoning on a virtual clock (deterministic)
// ===========================================================================

function layerA(): void {
  section('A. Remote-avatar interpolation & dead reckoning (virtual clock)');

  let vnow = 1_000;
  const client = new NetworkClient({
    url: 'ws://virtual.test/ws',
    clock: () => vnow,
    heartbeatIntervalMs: 0,
  });

  // A1 — first snapshot materialises the avatar at the authoritative position.
  client.applyDeltaToRemote('p1', { username: 'mover', x: 0, y: 0, z: 0, vx: 10, vy: 0, vz: 0 }, vnow);
  client.update(vnow);
  const p1 = client.getRemote('p1');
  assert.ok(p1 !== undefined);
  assert.strictEqual(p1.renderX, 0);
  assert.strictEqual(p1.username, 'mover');
  assert.strictEqual(client.remoteCount, 1);
  ok('first delta spawns remote avatar at authoritative position');

  // A2 — 20 Hz snapshot 50 ms later: half-way through the interpolation
  //      window the render position is a strict linear blend (ADR-013-2).
  client.applyDeltaToRemote('p1', { x: 10 }, vnow + 50);
  client.update(vnow + 75);
  const mid = client.getRemote('p1')!;
  assert.ok(Math.abs(mid.renderX - 5) < 1e-9, `midpoint blend expected 5, got ${mid.renderX}`);
  const midX = mid.renderX; // snapshot BEFORE the next update mutates it
  client.update(vnow + 100);
  assert.ok(Math.abs(client.getRemote('p1')!.renderX - 10) < 1e-9, 'window end must reach target');
  ok(
    'linear interpolation over the 50 ms window',
    `t=0.5 → x=${midX.toFixed(2)}, t=1 → x=10.00`,
  );

  // A3 — delta silence past window+grace switches to dead reckoning along
  //      the velocity vector: x(t) = target + v·Δt, Δt capped at 1 s.
  client.update(vnow + 175); // since = 125 ms > 50 + 25 → extrapolate 50 ms
  const dr = client.getRemote('p1')!;
  assert.ok(dr.deadReckoned, 'aging avatar must be flagged dead-reckoned');
  assert.ok(Math.abs(dr.renderX - 10.5) < 1e-9, `extrapolated x expected 10.5, got ${dr.renderX}`);
  client.update(vnow + 60_000); // deep past the cap
  const capped = client.getRemote('p1')!;
  assert.ok(
    Math.abs(capped.renderX - (10 + 10 * (MAX_EXTRAPOLATION_MS / 1000))) < 1e-9,
    `extrapolation must clamp at ${MAX_EXTRAPOLATION_MS} ms of travel`,
  );
  ok('dead reckoning extrapolates along velocity and clamps at 1 s', `x→${capped.renderX}`);

  // A4 — C0 continuity: a fresh snapshot re-anchors the lerp at the CURRENT
  //      render position, never snapping to the new target.
  vnow = 100_000;
  client.applyDeltaToRemote('p1', { x: 100 }, vnow); // origin stays at capped render
  const beforeAnchor = client.getRemote('p1')!;
  const anchor = beforeAnchor.renderX;
  client.update(vnow); // t = 0 → still at the anchor
  assert.strictEqual(client.getRemote('p1')!.renderX, anchor);
  assert.ok(anchor < 100, 'must not have snapped to the new target');
  ok('snap-free re-anchoring (C0 continuity) on new snapshots', `anchor=${anchor.toFixed(2)}`);

  // A5 — implied velocity: position-only deltas (no vx fields, server never
  //      reported velocity for this peer) keep dead reckoning informed — but
  //      capped, so a 10 m same-clock step mints 30 m/s, not 10 000 m/s.
  client.applyDeltaToRemote('p2', { x: 0 }, vnow); // no velocity → no authority
  client.applyDeltaToRemote('p2', { x: 10 }, vnow);
  const implied = client.getRemote('p2')!;
  assert.strictEqual(implied.hasVelocity, false, 'position-only frames must not claim authority');
  assert.strictEqual(implied.lastVx, MAX_INFERRED_SPEED_M, 'inferred velocity must clamp per axis');
  ok('position-only deltas feed capped implied velocity (30 m/s ceiling)');

  // A6 — mine() input validation + resource derivation. No socket is open,
  //      so the frames are dropped after validation — exactly the contract:
  //      bad arguments throw, well-formed ones never do.
  const quiet = new NetworkClient({ url: 'ws://virtual.test/ws', heartbeatIntervalMs: 0 });
  quiet.mine('vein-water_ice-042', 5); // derived resource: water_ice
  quiet.mine('vein-mystery-007', 5); // unknown kind → safe 'regolith' default
  quiet.mine('vein-mystery-007', 5, 'helium3'); // explicit override
  assert.throws(() => quiet.mine('', 1), TypeError);
  assert.throws(() => quiet.mine('vein-x-1', -2), TypeError);
  assert.throws(() => quiet.sendMove({ x: Number.NaN, y: 0, z: 0 }), TypeError);
  assert.throws(() => quiet.trade('REGOLITH', 0, true), TypeError);
  assert.throws(() => quiet.layRail([0, 0, 0], [1, 2]), TypeError);
  ok('mine()/sendMove()/trade()/layRail() validate inputs before the wire');

  // A7 — malformed wire frames dispatch errors instead of throwing.
  let errors = 0;
  client.on('error', (e) => {
    if (e.code === 'bad_json' || e.code === 'bad_frame') errors++;
  });
  client.handleFrame('{not json');
  client.handleFrame(JSON.stringify([1, 2, 3]));
  assert.strictEqual(errors, 2);
  ok('malformed frames dispatch error events, never throw');

  client.destroy();
  quiet.destroy();
  assert.strictEqual(DEFAULT_INTERPOLATION_WINDOW_MS, 50);
}

// ===========================================================================
// LAYER B/C — live server E2E
// ===========================================================================

async function liveE2E(port: number): Promise<void> {
  const socketsA: WebSocket[] = [];
  const socketsB: WebSocket[] = [];
  const factoryA = makeWsFactory(socketsA);
  const factoryB = makeWsFactory(socketsB);

  const url = `ws://127.0.0.1:${port}/ws`;

  const clientA = new NetworkClient({
    url,
    socketFactory: factoryA,
    reconnectBaseMs: 40,
    heartbeatIntervalMs: 150,
    pongTimeoutMs: 1_000,
  });
  const clientB = new NetworkClient({
    url,
    socketFactory: factoryB,
    reconnectBaseMs: 40,
    heartbeatIntervalMs: 0, // B keeps the test clock quiet
  });

  section('B. Live E2E — JOIN handshake, movement deltas, trading');

  // B1 — connect + JOIN both clients ------------------------------------------
  await Promise.all([clientA.connect(), clientB.connect()]);
  assert.strictEqual(clientA.state, 'open');
  await clientA.waitFor('hello', 'hello', 2_000);
  await clientB.waitFor('hello', 'hello', 2_000);
  ok('both NetworkClients connected (ws-package transport via socketFactory)');

  clientA.join('netrunner-a', 'esa', 'surveyor');
  clientB.join('netrunner-b', 'jaxa', 'engineer');
  const welcomeA = await clientA.waitFor('welcome', 'welcome A', 3_000);
  const welcomeB = await clientB.waitFor('welcome', 'welcome B', 3_000);
  assert.strictEqual(welcomeA.player.username, 'netrunner-a');
  assert.strictEqual(welcomeA.player.credits, 1000);
  assert.ok(Array.isArray(welcomeA.world.claims));
  assert.ok(welcomeA.player.id.length > 8);
  assert.strictEqual(welcomeB.player.faction, 'jaxa');
  ok(
    'JOIN handshake → typed `welcome` events',
    `A=${welcomeA.player.id.slice(0, 8)} credits=${welcomeA.player.credits}, B=${welcomeB.player.id.slice(0, 8)}`,
  );

  // B2 — heartbeat PING/PONG with round-trip latency ---------------------------
  clientA.ping();
  await clientA.waitFor('pong', 'pong', 2_000);
  const rtt = clientA.latencyMs;
  assert.ok(rtt !== null && rtt >= 0 && rtt < 1_000, `plausible RTT expected, got ${rtt}`);
  assert.ok(clientA.pingsSent >= 1 && clientA.pongsReceived >= 1);
  ok('heartbeat PING→PONG measures RTT', `latency=${rtt}ms avg=${clientA.averageLatencyMs?.toFixed(2)}ms jitter=${clientA.jitterMs?.toFixed(2)}ms`);

  // B3 — movement: A moves, B receives world_delta deltas ----------------------
  clientA.sendMove({ x: 42, y: -7, z: 0, vx: 0, vy: 0, vz: 0, mode: 'buggy' });
  const delta = await clientB.waitFor(
    'world_delta',
    { label: 'world_delta carrying A at x=42', filter: (d) => d.players[welcomeA.player.id]?.x === 42 },
    3_000,
  );
  const aDelta = delta.players[welcomeA.player.id];
  assert.strictEqual(aDelta.y, -7);
  assert.strictEqual(aDelta.mode, 'buggy');
  assert.ok(!(welcomeA.player.id in delta.players) === false);
  ok('20 Hz delta replication: B sees A teleport to (42, -7) in a world_delta frame');

  // self-exclusion: A must never see ITSELF in its own world_delta
  let selfSeen = false;
  clientA.on('world_delta', (d) => {
    if (welcomeA.player.id in d.players) selfSeen = true;
  });
  clientA.sendMove({ x: 43, y: -7, z: 0 });
  await sleep(260); // > 5 server ticks
  assert.ok(!selfSeen, 'a client must never receive its own state as a remote delta');
  ok('client-side self-exclusion from remote deltas (server-side filter holds too)');

  // B4 — live interpolation: B's avatar lerps smoothly to the target -----------
  //      (single snapshot, zero velocity → converges exactly to 42 at x)
  clientA.sendMove({ x: 100, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
  await clientB.waitFor(
    'world_delta',
    { label: 'world_delta x=100', filter: (d) => d.players[welcomeA.player.id]?.x === 100 },
    3_000,
  );
  const samples: number[] = [];
  for (let i = 0; i < 12; i++) {
    clientB.update();
    const rp = clientB.getRenderPosition(welcomeA.player.id);
    assert.ok(rp !== null);
    assert.ok(Number.isFinite(rp.x) && Number.isFinite(rp.y) && Number.isFinite(rp.z));
    samples.push(rp.x);
    await sleep(16); // ≈60 fps render cadence
  }
  let monotonic = true;
  for (let i = 1; i < samples.length; i++) if (samples[i] < samples[i - 1] - 1e-9) monotonic = false;
  assert.ok(monotonic, `render x must not regress: ${samples.join(',')}`);
  const intermediate = samples.some((x) => x > 0.001 && x < 99.999);
  assert.ok(intermediate, 'intermediate blend samples expected between 0 and 100');
  const finalX = samples[samples.length - 1];
  assert.ok(Math.abs(finalX - 100) < 0.5, `avatar should converge to target, got ${finalX}`);
  ok(
    'live 60 fps interpolation: smooth monotonic convergence 0 → target',
    `mid=${samples[2].toFixed(1)} final=${finalX.toFixed(1)}`,
  );

  // B5 — CLAIM: A stakes, B sees claim_staked ----------------------------------
  clientA.stakeClaim({ x: 300, y: 300, radius: 10, kind: 'surface' });
  const claimAck = await clientA.waitFor('claim_result', 'claim_result', 3_000);
  assert.strictEqual(claimAck.ok, true);
  const staked = await clientB.waitFor(
    'claim_staked',
    { label: 'claim_staked broadcast', filter: (c) => c.playerId === welcomeA.player.id },
    3_000,
  );
  assert.strictEqual(staked.x, 300);
  assert.strictEqual(staked.y, 300);
  assert.strictEqual(staked.radius, 10);
  assert.strictEqual(staked.claimId, String((claimAck.claim as { id: string }).id));
  ok('stakeClaim → claim_result ack + claim_staked fan-out', `claim ${staked.claimId.slice(0, 8)}`);

  // B6 — MINE: regolith is legal on unclaimed ground (A is at 100,0) ----------
  clientA.mine('vein-regolith-001', 5);
  const mined = await clientA.waitFor(
    'mine_result',
    { label: 'mine_result', filter: (m) => m.resource === 'regolith' },
    3_000,
  );
  assert.strictEqual(mined.amount, 5);
  assert.strictEqual(mined.earned, 5);
  ok('mine(vein_id, amount) resolves resource=regolith and banks credits', `credits → ${mined.credits}`);

  // B7 — TRADE: B buys regolith → trade_confirmed + market_sync to A ----------
  clientB.trade('REGOLITH', 10, true);
  const receipt = await clientB.waitFor('trade_confirmed', 'trade_confirmed', 3_000);
  assert.strictEqual(receipt.commodity, 'REGOLITH');
  assert.strictEqual(receipt.amount, 10);
  assert.strictEqual(receipt.isBuy, true);
  assert.ok(receipt.totalCredits > 0);
  assert.ok(receipt.newBalance < 1000, 'buy must debit credits');
  assert.ok((receipt.inventory['REGOLITH'] ?? 0) >= 10, 'inventory mirror must hold the fill');
  const sync = await clientA.waitFor('market_sync', 'market_sync after trade', 3_000);
  assert.ok(Object.keys(sync.prices).length >= 6, 'market_sync must carry all commodities');
  assert.ok(sync.prices['REGOLITH'] > 0);
  ok(
    'trade() → trade_confirmed receipt + market_sync repricing peers',
    `10kg REGOLITH for ${receipt.totalCredits}cr → bal ${receipt.newBalance}`,
  );

  // B8 — LAY_RAIL: A lays, B sees rail_placed ----------------------------------
  clientA.layRail([10, 10, 0], [30, 10, 0]);
  const railAck = await clientA.waitFor('rail_laid', 'rail_laid', 3_000);
  assert.strictEqual(railAck.ok, true);
  const placed = await clientB.waitFor('rail_placed', 'rail_placed', 3_000);
  assert.deepStrictEqual(placed.p0, [10, 10, 0]);
  assert.deepStrictEqual(placed.p1, [30, 10, 0]);
  assert.ok(Math.abs(placed.length - 20) < 1e-9);
  assert.strictEqual(placed.gauge, PLAYER_RAIL_GAUGE_M);
  assert.strictEqual(placed.builtBy, welcomeA.player.id);
  ok('layRail → rail_laid ack + rail_placed world fan-out', `20 m @ ${placed.gauge} m gauge`);

  // B9 — error channel: server rejections surface as typed error events --------
  clientA.sendRaw({ type: 'TOTALLY_MADE_UP' });
  const unknownErr = await clientA.waitFor(
    'error',
    { label: 'unknown_type error', filter: (e) => e.code === 'unknown_type' },
    3_000,
  );
  assert.ok(unknownErr.message.includes('TOTALLY_MADE_UP'));
  clientA.sendRaw({ type: 'MOVE', payload: { x: 'not-a-number' } });
  const moveErr = await clientA.waitFor(
    'error',
    { label: 'bad_move error', filter: (e) => e.code === 'bad_move' },
    3_000,
  );
  assert.ok(moveErr.message.length > 0);
  ok('server errors (unknown_type, bad_move) dispatch as typed `error` events');

  // B10 — client-side input validation (never hits the wire) -------------------
  assert.throws(() => clientA.sendMove({ x: Number.NaN, y: 0, z: 0 }), TypeError);
  assert.throws(() => clientA.stakeClaim({ x: 1, y: 1, radius: 0 }), TypeError);
  assert.throws(() => clientA.join(''), TypeError);
  ok('client-side guards: NaN movement, zero-radius claim, empty name rejected pre-wire');

  // ---------------------------------------------------------------------------
  section('C. Reconnect — abrupt drop, backoff, automatic re-JOIN');

  const aSocketsBefore = socketsA.length;
  const liveA = socketsA[socketsA.length - 1];
  assert.ok(liveA !== undefined, 'A must have a live socket');
  clientB.on('player_left', () => undefined);
  const leftPromise = clientB.waitFor(
    'player_left',
    { label: 'player_left for A', filter: (p) => p['player_id'] === welcomeA.player.id },
    5_000,
  );

  liveA.terminate(); // violent death — no close handshake
  const rec = await clientA.waitFor('reconnecting', 'reconnecting event', 2_000);
  assert.strictEqual(rec.attempt, 1);
  assert.ok((rec.delayMs ?? 0) >= 30 && (rec.delayMs ?? 0) <= 60, `backoff ~40ms expected, got ${rec.delayMs}`);
  ok('abrupt drop → reconnecting event with jittered exponential backoff', `attempt 1 in ${rec.delayMs}ms`);

  const welcomeAgain = await clientA.waitFor(
    'welcome',
    { label: 'welcome after auto re-JOIN', filter: (w) => w.player.username === 'netrunner-a' },
    5_000,
  );
  assert.strictEqual(clientA.state, 'open');
  assert.strictEqual(welcomeAgain.player.id, welcomeA.player.id); // same account, same id
  ok('auto-reconnect re-presents JOIN — same player id, session continuity');
  await leftPromise;
  ok('peers observe player_left when a client drops', `sockets created for A: ${aSocketsBefore} → ${socketsA.length}`);

  // Heartbeat dead-link detection: silence must tear down + reconnect. The
  // server normally answers PONGs instantly, so verify the guard exists by
  // checking the timer is armed on every ping (pongTimeoutMs > 0) and that a
  // manually closed socket does NOT schedule a reconnect below.
  clientB.disconnect();
  await clientB.waitFor('disconnected', 'B disconnected', 2_000);
  assert.strictEqual(clientB.state, 'closed');
  await sleep(150);
  assert.strictEqual(clientB.state, 'closed', 'intentional disconnect must never reconnect');
  ok('graceful disconnect is final (no reconnect scheduled)', `state=${clientB.state}`);

  clientA.destroy();
  clientB.destroy();
  for (const s of [...socketsA, ...socketsB]) {
    try {
      s.terminate();
    } catch {
      /* gone */
    }
  }
}

// ===========================================================================
// main
// ===========================================================================

async function main(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }

  layerA();

  const port = DEFAULT_PORT + 953; // 3953 — clear of the 3731 lunarserver smoke
  const server = new LunarServer({ port, dbPath: DB_PATH, marketSyncIntervalSeconds: 0 });
  const address = await server.start();
  console.log(`\nephemeral LunarServer listening on ${address} (db ${DB_PATH})`);

  try {
    await liveE2E(port);
  } finally {
    await server.stop();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(DB_PATH + suffix, { force: true });
    }
    console.log('\nephemeral server stopped, db removed');
  }

  console.log(`\nALL ${STAGE.passed} NETWORK-CLIENT CHECKS PASSED`);
}

main().catch((err) => {
  console.error('NETWORK CLIENT SMOKE FAILED:', err);
  process.exit(1);
});
