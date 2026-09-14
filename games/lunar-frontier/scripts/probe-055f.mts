// Probe 6: ground positivity over the strip the buggy actually occupies.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { ClientApp } from '../src/client/ClientApp.ts';

const app = new ClientApp({ seed: 'task-play-055-frontier', silent: true, terrainResolution: 33, autoConnect: false, spawn: { x: 1040, y: 600 } });
await app.init(new NullEngine());
const g = app.world.getGroundHeightAt.bind(app.world);
let min = Infinity;
let at = '';
for (let x = 1046; x <= 1062; x += 0.25) {
  for (let y = 601; y <= 607; y += 0.25) {
    const v = g(x, y);
    if (v < min) { min = v; at = `${x},${y}`; }
  }
}
console.log('buggy strip min ground:', min.toFixed(3), 'at', at);

// Mount and drive for 1.5 s; record min MOVE z and top speed.
const bp = app.getBuggy().getPosition();
app.getSuit().teleport(bp.x - 1.5, bp.y);
app.update();
console.log('mount:', app.toggleMount(), 'mode', app.getMode());
app.handleKeyInput('KeyW', 'down');
let minZ = Infinity, top = 0;
const t0 = Date.now();
while (Date.now() - t0 < 1500) {
  app.update();
  const ms = app.currentMoveState();
  minZ = Math.min(minZ, ms.z);
  top = Math.max(top, app.getBuggy().getSpeed());
}
console.log('drive: minMoveZ', minZ.toFixed(3), 'topSpeed', top.toFixed(2));

// Brake behavior
app.handleKeyInput('KeyS', 'down');
const t1 = Date.now();
while (Date.now() - t1 < 4000 && app.getBuggy().getSpeed() > 0.25) {
  app.update();
}
console.log('braked to', app.getBuggy().getSpeed().toFixed(3), 'in', Date.now() - t1, 'ms');

// In-situ vein observation via veinsInDepthWindow (live model).
const gen = app.world.getWorldGenerator();
const win = gen.veinsInDepthWindow(-2, 2).filter((v) => v.kind === 'regolith' && v.remaining > 500);
console.log('live regolith veins in z[-2,2]:', win.length, 'first rem', win[0]?.remaining);
app.dispose();
process.exit(0);
