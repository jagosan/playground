// Probe 2: terrain profile + mount choreography facts for the Phase 8d suite.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { ClientApp } from '../src/client/ClientApp.ts';
import { BUGGY_PARK_OFFSET } from '../src/client/ClientApp.ts';

const app = new ClientApp({ seed: 'task-play-055-frontier', silent: true, terrainResolution: 33 });
await app.init(new NullEngine());
const spawn = app.world.getSpawnPoint();
const [bx, by] = BUGGY_PARK_OFFSET;
let minZ = Infinity;
let maxZ = -Infinity;
for (let i = 0; i <= 60; i++) {
  const x = spawn.x - 1 + i * 0.5; // drive heading ~+x after mount
  const h = app.world.getGroundHeightAt(x, spawn.y);
  minZ = Math.min(minZ, h); maxZ = Math.max(maxZ, h);
}
console.log('spawn', JSON.stringify(spawn), 'buggy park offset', bx, by);
console.log('ground along +x 0..30m from mount point: min', minZ.toFixed(3), 'max', maxZ.toFixed(3));
let minZy = Infinity, maxZy = -Infinity;
for (let i = 0; i <= 60; i++) {
  const y = spawn.y - 1 + i * 0.5;
  const h = app.world.getGroundHeightAt(spawn.x, y);
  minZy = Math.min(minZy, h); maxZy = Math.max(maxZy, h);
}
console.log('ground along +y: min', minZy.toFixed(3), 'max', maxZy.toFixed(3));
const bg = app.getBuggy().getPosition();
console.log('buggy pos', JSON.stringify(bg), 'ground under buggy', app.world.getGroundHeightAt(bg.x, bg.y).toFixed(3));
app.dispose();
process.exit(0);
