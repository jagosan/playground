// Probe 5: exact ground over the strip the buggy ever occupies.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { ClientApp } from '../src/client/ClientApp.ts';

const app = new ClientApp({ seed: 'task-play-055-frontier', silent: true, terrainResolution: 33, autoConnect: false, spawn: { x: 1040, y: 600 } });
await app.init(new NullEngine());
const g = (x: number, y: number) => app.world.getGroundHeightAt(x, y);
let min = Infinity;
let at = '';
for (let x = 1036; x <= 1066; x += 0.5) {
  for (let y = 596; y <= 608; y += 0.5) {
    const v = g(x, y);
    if (v < min) { min = v; at = `${x},${y}`; }
  }
}
console.log('strip min ground', min.toFixed(3), 'at', at);
const bp = app.getBuggy().getPosition();
console.log('buggy parked at', JSON.stringify(bp), 'ground', g(bp.x, bp.y).toFixed(3));
// suit walk forward from spawn 2s heading
app.handleKeyInput('KeyW', 'down');
for (let i = 0; i < 120; i++) app.update();
const sp = app.getSuit().getPosition();
console.log('suit after 2s of frames at', JSON.stringify({ x: sp.x, y: sp.y, z: sp.z }), 'ground', g(sp.x, sp.y).toFixed(3));
app.dispose();
process.exit(0);
