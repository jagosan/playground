/**
 * Ad-hoc verification of Spec 37 Phase 2 (OpenBuggy dynamic upgrade
 * attachments). Headless NullEngine. Not part of the npm gate suite.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { OpenBuggy } from '../src/entities/OpenBuggy.ts';
import type { InstalledUpgrades } from '../src/garage/BuggyUpgradeSystem.ts';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
  if (ok) { pass++; console.log(`  ✔ ${name}`); } else { fail++; console.log(`  ✘ ${name}`); }
}

const engine = new NullEngine();
const scene = new Scene(engine);

// 1. Stock build: no upgrade attachments, physics root stable.
const buggy = new OpenBuggy().init(scene);
check('stock: zero upgrade attachments', buggy.getUpgradeMeshes().length === 0);
const root = buggy.getRootNode();
const physics = buggy.getPhysics();
check('hopper defaults to 6 slots', buggy.getCargoHopper()?.getCapacity() === 6);

// 2. Apply a full max build dynamically.
const maxed: InstalledUpgrades = { cargo_bed: 4, powertrain: 4, suspension: 4, mining_suite: 4 };
const stats = buggy.applyUpgrades(maxed);
check('stats: canisterCapacity 12', stats.canisterCapacity === 12);
check('stats: topSpeedMs 45-tier path keeps 35 base + nitro', stats.nitro?.sprintSpeedMs === 45);
check('hopper raised to 12', buggy.getCargoHopper()?.getCapacity() === 12);
const ups = buggy.getUpgradeMeshes().map((m) => m.name);
check('flatbed deck + subframe mounted', ups.some((n) => n.includes('flatbed-deck')) && ups.some((n) => n.includes('subframe-beam')));
check('double-tier side rails', ups.some((n) => n.includes('side-rail-lower')) && ups.some((n) => n.includes('side-rail-upper')));
check('upper deck for 12-slot stack', ups.some((n) => n.includes('upper-deck')));
check('mag-net holo webbing', ups.some((n) => n.includes('mag-net')));
check('tractor gantry + lens', ups.some((n) => n.includes('gantry-crossbar')) && ups.some((n) => n.includes('tractor-lens')));
check('4 cyan hub caps', ups.filter((n) => n.includes('hubcap')).length === 4);
check('4 nitro canisters', ups.filter((n) => n.includes('nitro-canister-') && !n.includes('cap')).length === 4);
check('4 RCS nozzles', ups.filter((n) => n.includes('rcs-nozzle')).length === 4);
check('4 RCS plume emitters', buggy.getRcsPlumes().length === 4);
check('mining thermal emitter', ups.some((n) => n.includes('thermal-barrel')));
check('mining wide scoop', ups.some((n) => n.includes('scoop-plate')));
check('deep-core resonator', ups.some((n) => n.includes('resonator-dish')));
check('physics root NOT rebuilt', buggy.getRootNode() === root && buggy.getPhysics() === physics);
check('base 69-mesh contract intact', buggy.getMeshes().length === 69);

// 3. Stepping frames animates without throwing; positions finite.
const drive = { throttle: 0.8, brake: 0, regen: 0, steer: 0.3, parkBrake: false };
let ok = true;
for (let i = 0; i < 30; i++) {
  const s = buggy.update(1 / 60, drive);
  ok = ok && Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z);
}
check('30 frames of update() finite', ok);

// 4. Dynamic downgrade mid-session: attachments re-mount, root stays.
buggy.applyUpgrades({ cargo_bed: 2, powertrain: 1, suspension: 1, mining_suite: 1 });
const ups2 = buggy.getUpgradeMeshes().map((m) => m.name);
check('downgrade: hub caps gone', !ups2.some((n) => n.includes('hubcap')));
check('downgrade: plumes gone', buggy.getRcsPlumes().length === 0);
check('downgrade: flatbed kept', ups2.some((n) => n.includes('flatbed-deck')));
check('downgrade: root still identity', buggy.getRootNode() === root);

// 5. Hopper double-tier: latch 12 canisters, upper deck used, 13th refused.
buggy.clearHopperCargo();
let latched = 0;
for (let i = 0; i < 13; i++) if (buggy.addHopperCargo('WATER_CRYO_CELL') !== null) latched++;
check('12 canisters latch, 13th refused', latched === 12);
const items = buggy.getHopperCargoItems();
const upper = items.filter((it) => items.indexOf(it) >= 6);
check('upper-deck items raised (y > 0.8)', upper.every((it) => it.localOffset.y > 0.8));
check('upper deck does not collide lower deck', items[6]!.localOffset.y > items[0]!.localOffset.y + 0.4);
buggy.clearHopperCargo();

// 6. Re-apply is idempotent, no mesh leak across churn.
buggy.applyUpgrades(maxed);
const before = buggy.getUpgradeMeshes().length;
for (let i = 0; i < 5; i++) buggy.applyUpgrades(maxed);
const after = buggy.getUpgradeMeshes().length;
check('churn does not accumulate meshes', after === before && before > 0);

// 7. Dispose drains everything.
buggy.dispose();
check('dispose: upgrade meshes drained', buggy.getUpgradeMeshes().length === 0);
check('dispose: plumes drained', buggy.getRcsPlumes().length === 0);
check('dispose: update() still steps', Number.isFinite(buggy.update(0.016).x));

// 8. Scene-less (NullEngine fallback, never init'd with a Scene): bookkeeping works.
const headless = new OpenBuggy({ namePrefix: 'hl' });
const hs = headless.applyUpgrades(maxed);
check('sceneless: applyUpgrades returns stats', hs.canisterCapacity === 12);
check('sceneless: zero attachments, no throw', headless.getUpgradeMeshes().length === 0);
check('sceneless: hopper capacity raised', headless.getCargoHopper()?.getCapacity() === 12);
headless.dispose();

// 9. Invalid shape rejected.
let threw = false;
try { buggy.applyUpgrades({ cargo_bed: 9 } as never); } catch { threw = true; }
check('invalid shape throws', threw);

console.log(`\n${pass} passed, ${fail} failed`);
engine.dispose();
process.exit(fail === 0 ? 0 : 1);
