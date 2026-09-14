// Probe 4: find a client spawn whose buggy park corridor (park + drive along
// heading 0) keeps ground z > 0, and confirm a regolith drill stance works.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { ClientApp } from '../src/client/ClientApp.ts';

const app = new ClientApp({ seed: 'task-play-055-frontier', silent: true, terrainResolution: 33, autoConnect: false });
await app.init(new NullEngine());
const g = (x: number, y: number) => app.world.getGroundHeightAt(x, y);

// Candidate spawns on a coarse grid; score = min ground over the corridor the
// buggy travels: x in [sx+6, sx+16], y in [sy, sy+5] (park offset is 9,4).
const rows: Array<{ sx: number; sy: number; min: number; parkG: number }> = [];
for (let sx = 200; sx <= 1800; sx += 40) {
  for (let sy = 200; sy <= 1800; sy += 40) {
    let min = Infinity;
    for (let x = sx + 6; x <= sx + 16; x += 2) {
      for (let y = sy; y <= sy + 5; y += 2.5) min = Math.min(min, g(x, y));
    }
    rows.push({ sx, sy, min, parkG: g(sx + 9, sy + 4) });
  }
}
rows.sort((a, b) => b.min - a.min);
console.log('top spawn corridors:');
for (const r of rows.slice(0, 8)) console.log(JSON.stringify(r));
const pos = rows.filter((r) => r.min > 0.15 && r.parkG > 0.15);
console.log('positive-corridor candidates:', pos.length);

// Regolith drill stance near the chosen spawn (prefer closest).
const best = pos[0] ?? rows[0];
console.log('chosen spawn:', JSON.stringify(best));
const snapshot = app.world.getSnapshot()!;
let regoHit: unknown = null;
for (const v of snapshot.veins) {
  if (v.kind !== 'regolith' || v.remaining <= 500) continue;
  const standZ = g(v.center.x, v.center.y);
  const range = Math.max(0, Math.abs(v.center.z - standZ) - v.radius);
  if (range > 20) continue;
  const d = Math.hypot(v.center.x - best.sx, v.center.y - best.sy);
  const can = app.world.getWorldGenerator().canExtract('regolith', v.center.x, v.center.y, v.center.z, 'suit');
  regoHit = { vein: v.id, d: d.toFixed(0), range: range.toFixed(2), rem: v.remaining, can: can.ok, reason: can.reason };
  if (d < 900) console.log('rego near spawn:', JSON.stringify(regoHit));
}
app.dispose();
process.exit(0);
