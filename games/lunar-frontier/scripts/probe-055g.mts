// Probe 7: drive line y=604 positivity + settled mount + drive + brake.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { ClientApp } from '../src/client/ClientApp.ts';

const app = new ClientApp({ seed: 'task-play-055-frontier', silent: true, terrainResolution: 33, autoConnect: false, spawn: { x: 1040, y: 600 } });
await app.init(new NullEngine());
const g = app.world.getGroundHeightAt.bind(app.world);
let min = Infinity;
for (let x = 1046; x <= 1064; x += 0.25) min = Math.min(min, g(x, 604));
console.log('min ground along y=604, x 1046..1064:', min.toFixed(3));

// settle buggy z, then mount like the suite does
for (let i = 0; i < 5; i++) app.update();
const bp = app.getBuggy().getPosition();
console.log('settled buggy pos', JSON.stringify({ x: bp.x, y: bp.y, z: bp.z }), 'ground', g(bp.x, bp.y).toFixed(3));
app.getSuit().teleport(bp.x - 1.5, bp.y);
app.update();
console.log('canMount after settle:', app.getBuggy().canMount(app.getSuit()));
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
app.handleKeyInput('KeyW', 'up');
const posAfterDrive = app.getBuggy().getPosition();
console.log('drive: minMoveZ', minZ.toFixed(3), 'topSpeed', top.toFixed(2), 'end pos', JSON.stringify({ x: posAfterDrive.x.toFixed(1), y: posAfterDrive.y.toFixed(1) }));

app.handleKeyInput('KeyS', 'down');
const t1 = Date.now();
while (Date.now() - t1 < 4000 && app.getBuggy().getSpeed() > 0.25) app.update();
app.handleKeyInput('KeyS', 'up');
console.log('braked to', app.getBuggy().getSpeed().toFixed(3), 'in', Date.now() - t1, 'ms');
const parked = app.getBuggy().getPosition();
app.getSuit().teleport(parked.x - 1.0, parked.y);
console.log('dismount:', app.toggleMount(), 'mode', app.getMode());
app.dispose();
process.exit(0);
