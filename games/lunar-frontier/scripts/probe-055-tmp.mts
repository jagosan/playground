// Probe: find a vein the client can actually drill from the surface, plus
// spawn/ground facts, for the Phase 8d E2E fixture. Throwaway.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { ClientApp } from '../src/client/ClientApp.ts';

const app = new ClientApp({ seed: 'task-play-055-frontier', silent: true, terrainResolution: 33 });
await app.init(new NullEngine({ renderWidth: 160, renderHeight: 120 } as never));
const snap = app.world.getSnapshot()!;
const spawn = app.world.getSpawnPoint();
console.log('spawn', JSON.stringify(spawn));
console.log('veins', snap.veins.length, 'tunnels', snap.tunnels.length);

const rows: Array<{ id: string; kind: string; d: number; cx: number; cy: number; cz: number; r: number; rem: number }> = [];
for (const v of snap.veins) {
  const gz = app.world.getGroundHeightAt(v.center.x, v.center.y);
  const d = Math.hypot(0, 0, v.center.z - gz) - v.radius; // standing directly above
  const spawnD = Math.hypot(v.center.x - spawn.x, v.center.y - spawn.y);
  rows.push({ id: v.id, kind: v.kind, d, cx: v.center.x, cy: v.center.y, cz: v.center.z, r: v.radius, rem: v.remaining });
}
rows.sort((a, b) => a.d - b.d);
console.log('closest-to-surface veins (standing-above surface distance):');
for (const r of rows.slice(0, 12)) console.log(JSON.stringify(r));
const good = rows.filter((r) => r.d <= 20 && r.rem > 300 && (r.kind === 'water_ice' || r.kind === 'helium_3'));
console.log('drillable premium candidates:', JSON.stringify(good.slice(0, 5)));
const goodAny = rows.filter((r) => r.d <= 20 && r.rem > 300);
console.log('drillable any-kind candidates:', JSON.stringify(goodAny.slice(0, 5)));
app.dispose();
process.exit(0);
