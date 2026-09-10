/**
 * Runtime smoke test for LunarServer (not part of the shipped server).
 * Bundled with esbuild (sqlite3 kept external) and run under plain node.
 *
 * Message frames are recorded by a listener attached at socket-creation time,
 * so nothing can slip through the open->listen microtask gap.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import WebSocket from 'ws';

import LunarServer, { DEFAULT_PORT } from '../src/server/LunarServer';

const DB_PATH = './.smoke-lunarfrontier.db';

interface FrameRecorder {
  inbox: any[];
  waitFor: (predicate: (m: any) => boolean, label: string, timeoutMs?: number) => Promise<any>;
}

function record(ws: WebSocket): FrameRecorder {
  const inbox: any[] = [];
  let waiter: (() => void) | null = null;
  ws.on('message', (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString());
      msg.__seen = false;
      inbox.push(msg);
      if (waiter !== null) waiter();
    } catch {
      /* ignore non-JSON test frames */
    }
  });
  const waitFor = async (
    predicate: (m: any) => boolean,
    label: string,
    timeoutMs = 4000,
  ): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = inbox.find((m) => !m.__seen && predicate(m));
      if (hit !== undefined) {
        hit.__seen = true;
        return hit;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out waiting for: ${label} — inbox: ` +
            JSON.stringify(inbox.map((m) => ({ type: m.type, code: m.code, message: m.message }))),
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiter = null;
          resolve();
        }, remaining);
        waiter = () => {
          clearTimeout(timer);
          waiter = null;
          resolve();
        };
      });
    }
  };
  return { inbox, waitFor };
}

async function main(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }

  const port = DEFAULT_PORT + 731; // 3731 — avoid clashing with a live 3000
  const server = new LunarServer({ port, dbPath: DB_PATH });

  // 1. start() + HTTP ------------------------------------------------------
  const address = await server.start();
  console.log('start() ->', address);

  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  console.log('GET /health ->', JSON.stringify(health));
  assert.equal(health.status, 'ok');
  assert.equal(typeof health.players, 'number');
  assert.equal(typeof health.uptime, 'number');

  const world0 = await (await fetch(`http://127.0.0.1:${port}/api/world`)).json();
  console.log('GET /api/world ->', JSON.stringify(world0).slice(0, 120));
  assert.ok(Array.isArray(world0.claims));
  assert.ok(Array.isArray(world0.infrastructure));

  // 2. WebSocket JOIN -------------------------------------------------------
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const { waitFor } = record(ws); // listener attached before 'open'
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  const hello = await waitFor((m) => m.type === 'hello', 'hello');
  assert.equal(hello.path, '/ws');
  console.log('WS <- hello ok (path ' + hello.path + ')');

  ws.send(JSON.stringify({ type: 'JOIN', payload: { username: 'jag', faction: 'esa' } }));
  const welcome = await waitFor((m) => m.type === 'welcome', 'welcome');
  assert.equal(welcome.player.username, 'jag');
  assert.equal(welcome.player.credits, 1000);
  assert.ok(Array.isArray(welcome.world.claims));
  assert.ok(Array.isArray(welcome.world.infrastructure));
  console.log('JOIN ok — credits', welcome.player.credits, 'state', JSON.stringify(welcome.state));

  // 3. MOVE + 20 Hz delta tick ----------------------------------------------
  ws.send(
    JSON.stringify({
      type: 'MOVE',
      payload: { x: 42, y: -7, z: 0, vx: 1, vy: 0, vz: 0, mode: 'buggy' },
    }),
  );
  const tick = await waitFor(
    (m) => m.type === 'tick' && m.players?.some((p: any) => p.x === 42),
    'tick delta with x=42',
  );
  const d = tick.players.find((p: any) => p.x === 42);
  assert.equal(d.y, -7);
  assert.equal(d.mode, 'buggy');
  console.log('MOVE -> 20Hz delta tick:', JSON.stringify(d));

  // tick-rate sanity: keep moving so every tick has a delta, then count
  // delta frames over ~310 ms (20 Hz => ~6 ticks; assert >=4).
  let tickCount = 0;
  const counter = (raw: WebSocket.RawData): void => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'tick') tickCount++;
    } catch {
      /* ignore */
    }
  };
  ws.on('message', counter);
  let xoff = 0;
  const mover = setInterval(() => {
    xoff += 1;
    ws.send(JSON.stringify({ type: 'MOVE', payload: { x: 42 + xoff, y: -7, z: 0 } }));
  }, 40);
  await new Promise((r) => setTimeout(r, 310));
  clearInterval(mover);
  ws.off('message', counter);
  console.log('delta ticks observed in ~310ms of movement:', tickCount);
  assert.ok(tickCount >= 4, `expected >=4 ticks in 310ms, got ${tickCount}`);

  // 4. MINE on unclaimed ground ----------------------------------------------
  ws.send(JSON.stringify({ type: 'MINE', payload: { resource: 'regolith', amount: 10 } }));
  const mined = await waitFor((m) => m.type === 'mine_result' && m.resource === 'regolith', 'regolith mine_result');
  assert.equal(mined.amount, 10);
  assert.equal(mined.earned, 10);
  console.log('MINE regolith ok — earned', mined.earned, 'credits ->', mined.credits);

  ws.send(JSON.stringify({ type: 'MINE', payload: { resource: 'water_ice', amount: 5 } }));
  const denied = await waitFor(
    (m) => m.type === 'error' && m.code === 'claim_required',
    'claim_required error',
  );
  console.log('MINE water_ice on unclaimed ground correctly denied:', denied.code);

  // 5. CLAIM then mine premium resource inside own claim -----------------------
  ws.send(JSON.stringify({ type: 'CLAIM', payload: { claim_type: 'surface', x: 42, y: -7, radius: 20 } }));
  const claimed = await waitFor((m) => m.type === 'claim_result', 'claim_result');
  assert.equal(claimed.ok, true);
  assert.equal(claimed.claim.claim_type, 'surface');
  assert.equal(claimed.credits, 1010 - 500); // start 1000 + 10 mined - 500 claim
  console.log('CLAIM ok — new balance', claimed.credits);

  ws.send(JSON.stringify({ type: 'MINE', payload: { resource: 'water_ice', amount: 5 } }));
  const ice = await waitFor(
    (m) => m.type === 'mine_result' && m.resource === 'water_ice',
    'water_ice mine_result',
  );
  assert.equal(ice.earned, 20);
  assert.equal(ice.resources.water_ice, 5);
  assert.equal(ice.credits, 510 + 20);
  console.log('MINE water_ice inside own claim ok — earned', ice.earned, 'credits ->', ice.credits);

  // 6. /api/world now reflects the claim ---------------------------------------
  const world1 = await (await fetch(`http://127.0.0.1:${port}/api/world`)).json();
  assert.equal(world1.claims.length, 1);
  assert.equal(world1.claims[0].claim_type, 'surface');
  console.log('GET /api/world now lists 1 claim:', String(world1.claims[0].id).slice(0, 8));

  // 7. overlap rejection ---------------------------------------------------------
  ws.send(JSON.stringify({ type: 'CLAIM', payload: { claim_type: 'surface', x: 43, y: -7, radius: 10 } }));
  const overlap = await waitFor((m) => m.type === 'error' && m.code === 'claim_overlap', 'claim_overlap');
  console.log('overlapping CLAIM correctly rejected:', overlap.code);

  // 8. PING / bad input ------------------------------------------------------------
  ws.send(JSON.stringify({ type: 'PING' }));
  const pong = await waitFor((m) => m.type === 'PONG', 'PONG');
  assert.equal(typeof pong.t, 'number');
  ws.send('{not json');
  const bad = await waitFor((m) => m.type === 'error' && m.code === 'bad_json', 'bad_json');
  console.log('PING->PONG ok; malformed frame ->', bad.code);

  // 9. stop() -----------------------------------------------------------------------
  await server.stop();
  const healthAfter = await fetch(`http://127.0.0.1:${port}/health`).then(
    () => 'still-up',
    () => 'down',
  );
  assert.equal(healthAfter, 'down');
  await server.stop(); // idempotent — must not throw
  console.log('stop() ok (idempotent, HTTP closed)');

  ws.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
  console.log('\nALL SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
