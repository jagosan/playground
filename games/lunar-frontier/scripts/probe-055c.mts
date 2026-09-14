// Probe 3: pick (seed, drive heading) with buggy z>0 through a 1.5 s drive,
// and a regolith scanner lock where suit harvest succeeds.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { ClientApp } from '../src/client/ClientApp.ts';

type Row = { seed: string; heading: number; minMoveZ: number; topSpeed: number; ok: boolean };
const results: Row[] = [];

async function tryDrive(seed: string, headingDeg: number): Promise<Row> {
  const app = new ClientApp({ seed, silent: true, terrainResolution: 33, autoConnect: false });
  await app.init(new NullEngine());
  const buggyPos = app.getBuggy().getPosition();
  const rad = (headingDeg * Math.PI) / 180;
  // Face the buggy down the corridor: park the suit just behind the bow so
  // mount geometry is valid, then mount.
  const bx = buggyPos.x + Math.cos(rad) * 1.0;
  const by = buggyPos.y + Math.sin(rad) * 1.0;
  app.getBuggy().setStateFromMount?.(0, 0);
  app.getSuit().teleport(bx, by);
  let minMoveZ = Infinity;
  const mounted = app.toggleMount();
  if (!mounted) {
    app.dispose();
    return { seed, heading: headingDeg, minMoveZ: NaN, topSpeed: 0, ok: false };
  }
  app.handleKeyInput('KeyW', 'down');
  const t0 = Date.now();
  let topSpeed = 0;
  while (Date.now() - t0 < 1500) {
    app.update();
    const ms = app.currentMoveState();
    minMoveZ = Math.min(minMoveZ, ms.z);
    topSpeed = Math.max(topSpeed, app.getBuggy().getSpeed());
  }
  app.handleKeyInput('KeyW', 'up');
  app.dispose();
  return { seed, heading: headingDeg, minMoveZ, topSpeed, ok: minMoveZ > 0.05 && topSpeed > 0.3 };
}

for (const seed of ['task-play-055-frontier', 'phase8d-mare-7', 'phase8d-collar-12']) {
  for (const heading of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const r = await tryDrive(seed, heading);
    results.push(r);
    console.log(`${r.ok ? 'OK ' : '   '} seed=${seed} hdg=${heading} minMoveZ=${r.minMoveZ.toFixed(3)} top=${r.topSpeed.toFixed(2)}`);
  }
}
const good = results.filter((r) => r.ok);
console.log('BEST:', JSON.stringify(good[0] ?? null));

// Regolith lock hunt on the first seed that drives (or the default).
const driveSeed = good[0]?.seed ?? 'task-play-055-frontier';
console.log('\n--- regolith scanner-lock hunt on', driveSeed, '---');
const app = new ClientApp({ seed: driveSeed, silent: true, terrainResolution: 33, autoConnect: false });
await app.init(new NullEngine());
const spawn = app.world.getSpawnPoint();
outer: for (let dx = -400; dx <= 400; dx += 100) {
  for (let dy = -400; dy <= 400; dy += 100) {
    const x = spawn.x + dx;
    const y = spawn.y + dy;
    app.getSuit().teleport(x, y);
    app.update();
    const lock = app.getNearestVein();
    if (lock === null || lock.rangeM > 20 || lock.vein.kind !== 'regolith') continue;
    const gen = app.world.getWorldGenerator();
    const can = gen.canExtract('regolith', x, y, lock.vein.center.z, 'suit');
    const canAtGround = gen.canExtract('regolith', x, y, app.world.getGroundHeightAt(x, y), 'suit');
    if (can.ok || canAtGround.ok) {
      console.log('HIT', JSON.stringify({ x, y, vein: lock.vein.id, range: lock.rangeM, remaining: lock.vein.remaining, canVeinZ: can.ok, canGroundZ: canAtGround.ok, reason: can.reason, reasonG: canAtGround.reason }));
      // dry-run harvest at the winning stance
      const h = gen.harvest('regolith', x, y, lock.vein.center.z, 40, 'suit');
      console.log('harvest@veinZ ->', JSON.stringify(h));
      const h2 = gen.harvest('regolith', x, y, app.world.getGroundHeightAt(x, y), 40, 'suit');
      console.log('harvest@groundZ ->', JSON.stringify(h2));
      break outer;
    }
  }
}
app.dispose();
process.exit(0);
