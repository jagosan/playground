/**
 * Spec 29 Phase 2 verification: WorldScene ↔ RadioTower wiring.
 * Run: `npx tsx scripts/check-worldscene-radio-tower.ts`  (exit code 0 == all green)
 *
 * Exercises the WorldScene integration layer on Babylon NullEngine:
 *   1. buildRadioTower(): default canonical seat (-1550, 2320), terrain z
 *      clamp, scene parenting, procedural mesh assembly, idempotence.
 *   2. getRadioTower(): null before build, instance while built, null after
 *      dispose.
 *   3. Beacon advance: WorldScene.render() (engine delta clock) and
 *      WorldScene.update(dtMs, playerWorldPos) both drive tower.update().
 *   4. Shadow casters land in the sun's shadow render list (tower meshes
 *      cast; tower meshes never become tracked entities).
 *   5. Teardown: WorldScene.dispose() tears the tower down cleanly (no
 *      orphaned meshes/nodes), idempotently, and post-dispose calls no-op.
 *   6. Custom seat overrides: explicit worldPosition honoured; explicit z
 *      may raise the seat, never bury it.
 *
 * No top-level await (tsx CJS); everything here is synchronous.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';

import { WorldScene } from '../src/engine/index.ts';
import { RadioTower, RADIO_TOWER_DEFAULTS } from '../src/infrastructure/RadioTower.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(label); console.log(`  ✘ ${label} ${detail}`); }
}
function section(title: string): void {
  console.log(`\n[${title}]`);
}
/** Sun shadow-generator render list (mirrors smoke-worldscene.ts). */
function shadowRenderList(scene: ReturnType<WorldScene['getScene']>): unknown[] {
  const sun = scene.lights.find((l) => l.name === 'sun');
  if (sun === undefined) return [];
  const maps = sun.getShadowGenerators();
  if (maps === null || maps.size === 0) return [];
  const sg = maps.entries().next().value?.[1] as { getShadowMap?: () => { renderList?: unknown[] } };
  return sg.getShadowMap?.()?.renderList ?? [];
}

const SEED = 'relay-04-check';
const PLAYER = { x: 0, y: 0, z: 0 };

// --- 1. boot + build -----------------------------------------------------------
section('1. buildRadioTower on NullEngine');

const engine = new NullEngine({ renderWidth: 640, renderHeight: 360 });
const world = new WorldScene({ seed: SEED, terrainSize: 1024, terrainResolution: 129 });
world.init(engine);
const scene = world.getScene();

check('getRadioTower() is null before build', world.getRadioTower() === null);

const entitiesBefore = world.getEntities().length;
const tower = world.buildRadioTower();
check('buildRadioTower() returns a RadioTower', tower instanceof RadioTower);
check('tower reports built', tower.isBuilt() === true);
check('getRadioTower() returns the built instance', world.getRadioTower() === tower);

const seat = tower.getWorldPosition();
check('canonical seat defaults to (-1550, 2320)',
  seat.x === RADIO_TOWER_DEFAULTS.worldPosition.x && seat.y === RADIO_TOWER_DEFAULTS.worldPosition.y,
  `got (${seat.x}, ${seat.y})`);
const ground = world.getGroundHeightAt(seat.x, seat.y);
check('foundation z clamped to ground elevation',
  Math.abs(seat.z - ground) < 1e-6 && Number.isFinite(ground),
  `seat.z=${seat.z} ground=${ground}`);
check('deck rides the clamped foundation (+48 m)',
  Math.abs(tower.getDeckElevation() - (ground + 48.0)) < 1e-6);

const root = tower.getRootNode();
check('root node exists and is parented to world-root',
  root !== null && root.parent !== null && root.parent.name === 'world-root');

const meshes = tower.getMeshes();
check(`procedural assembly produced meshes (${meshes.length})`, meshes.length > 100);
check('ladder rungs >= 120', tower.getPartMeshes('rung').length >= 120,
  `got ${tower.getPartMeshes('rung').length}`);
for (const part of ['foundation', 'pillar', 'tie-beam', 'diagonal', 'hoop', 'deck', 'railing', 'hatch', 'dish', 'spire', 'beacon']) {
  check(`part '${part}' present`, tower.getPartMeshes(part).length > 0);
}

const again = world.buildRadioTower();
check('buildRadioTower() is idempotent (same instance)', again === tower);
check('idempotent rebuild does not duplicate entities', world.getEntities().length === entitiesBefore);

// --- 2. shadow casters -----------------------------------------------------------
section('2. shadow caster registration');

const casters = tower.getShadowCasterMeshes();
check('getShadowCasterMeshes non-empty and subset of tower meshes',
  casters.length > 0 && casters.every((m) => meshes.includes(m)));
const renderList = shadowRenderList(scene);
check('sun shadow render list found', renderList.length > 0);
const missing = casters.filter((m) => !renderList.includes(m));
check(`every tower shadow caster in the sun render list (${casters.length - missing.length}/${casters.length})`,
  missing.length === 0, missing.length > 0 ? `first missing: ${String(missing[0])}` : '');
check('tower meshes did not become tracked entities', world.getEntities().length === entitiesBefore);

// --- 3. beacon advance through both clocks ----------------------------------------
section('3. beacon pulse advance (render + update)');

const e0 = tower.getBeaconPulseState().elapsedS;
world.update(16.7, PLAYER);
const e1 = tower.getBeaconPulseState().elapsedS;
check('WorldScene.update(dtMs) advances the strobe clock',
  Math.abs(e1 - (e0 + 0.0167)) < 1e-9, `${e0} -> ${e1}`);
check('update() still answers null with no citadel at (0,0) or reports status',
  world.update(16.7, PLAYER) !== undefined);

// render() must drive the tower every frame. On NullEngine the engine delta
// clock reports 0 for synchronous renders (same contract as the maglev /
// mass-accelerator render paths), so assert the CALL happens with a sane
// dtMs instead of wall-clock advance; the strobe law itself is proven above
// and in scripts/check-radio-tower.ts.
const calls: number[] = [];
const realUpdate = tower.update.bind(tower);
tower.update = (deltaS: number): void => { calls.push(deltaS); realUpdate(deltaS); };
world.render();
tower.update = realUpdate;
check('WorldScene.render() drives tower.update() each frame',
  calls.length >= 1 && calls.every((d) => Number.isFinite(d) && d >= 0),
  `calls=${JSON.stringify(calls)}`);
check('render() remains chainable with the tower built', world.render() === world);
const pulse = tower.getBeaconPulseState();
check('beacon state is finite', Number.isFinite(pulse.redIntensity) && Number.isFinite(pulse.whiteIntensity)
  && pulse.redIntensity >= 0 && pulse.redIntensity <= 1);

// --- 4. teardown ---------------------------------------------------------------------
section('4. WorldScene.dispose teardown');

const elapsedAtDispose = tower.getBeaconPulseState().elapsedS;
world.dispose();
check('getRadioTower() null after world dispose', world.getRadioTower() === null);
check('tower torn down (isBuilt false)', tower.isBuilt() === false);
check('tower mesh list emptied', tower.getMeshes().length === 0);
check('tower root node detached (null)', tower.getRootNode() === null);
check('pure beacon law still answers after dispose',
  tower.getBeaconPulseState().elapsedS === elapsedAtDispose);
check('post-dispose world.update no-ops (returns null, tower untouched)', (() => {
  try {
    const r = world.update(50, PLAYER);
    return r === null && tower.getBeaconPulseState().elapsedS === elapsedAtDispose;
  } catch {
    return false;
  }
})());
check('post-dispose render is a no-op', (() => {
  try {
    world.render();
    return true;
  } catch {
    return false;
  }
})());
check('double dispose is idempotent', (() => {
  try {
    world.dispose();
    return true;
  } catch {
    return false;
  }
})());
check('buildRadioTower after dispose throws (requireScene)', (() => {
  try {
    world.buildRadioTower();
    return false;
  } catch {
    return true;
  }
})());
// Caller-owned engine survives scene dispose.
check('caller-owned engine survives scene dispose', !engine.isDisposed);
engine.dispose();

// --- 5. custom seat overrides ---------------------------------------------------------
section('5. custom worldPosition overrides + z clamp law');

{
  const eng = new NullEngine({ renderWidth: 320, renderHeight: 240 });
  const w2 = new WorldScene({ seed: 'relay-04-raise', terrainSize: 1024, terrainResolution: 129 });
  w2.init(eng);
  const g = w2.getGroundHeightAt(120, -80);
  const t2 = w2.buildRadioTower({ worldPosition: { x: 120, y: -80, z: g + 100 } });
  const s2 = t2.getWorldPosition();
  check('explicit z above ground is honoured (seat raised)',
    s2.x === 120 && s2.y === -80 && Math.abs(s2.z - (g + 100)) < 1e-6,
    `seat=${JSON.stringify(s2)} ground=${g}`);
  w2.dispose();
  check('raised tower torn down with its world', t2.getMeshes().length === 0 && t2.isBuilt() === false);
  if (!eng.isDisposed) eng.dispose();
}
{
  const eng = new NullEngine({ renderWidth: 320, renderHeight: 240 });
  const w3 = new WorldScene({ seed: 'relay-04-bury', terrainSize: 1024, terrainResolution: 129 });
  w3.init(eng);
  const g = w3.getGroundHeightAt(-400, 600);
  const t3 = w3.buildRadioTower({ worldPosition: { x: -400, y: 600, z: g - 999 } });
  const s3 = t3.getWorldPosition();
  check('explicit z below ground is clamped up to terrain (never buried)',
    s3.x === -400 && s3.y === 600 && Math.abs(s3.z - g) < 1e-6,
    `seat=${JSON.stringify(s3)} ground=${g}`);
  w3.dispose();
  if (!eng.isDisposed) eng.dispose();
}

// --- verdict -----------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED ✔  (Spec 29 Phase 2 WorldScene wiring)`);
  process.exit(0);
} else {
  console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
