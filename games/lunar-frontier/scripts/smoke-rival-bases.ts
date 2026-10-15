/**
 * Spec 25 §2.4 verification probe: RivalBases functional contract.
 * Run: `npx tsx scripts/smoke-rival-bases.ts`  (exit code 0 == all green)
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import {
  RivalBases,
  RIVAL_BASE_ARCHETYPES,
  MIN_PERIMETER_RADIUS_M,
  MAX_PERIMETER_RADIUS_M,
} from '../src/infrastructure/RivalBases.ts';
import { LunarWorldGenerator } from '../src/world/LunarWorldGenerator.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(label); console.log(`  ✘ ${label} ${detail}`); }
}

const snapshot = new LunarWorldGenerator('mala-voyage-2431').generate();

// --- scene-independent planning ---
const rivals = new RivalBases(snapshot);
const sites = rivals.getBases();
check('3 archetypes planned', sites.length === 3, `got ${sites.length}`);
check('roster matches', sites.map((s) => s.archetype).join(',') === RIVAL_BASE_ARCHETYPES.join(','));
for (const s of sites) {
  check(`${s.archetype}: perimeter in [60,90]`, s.perimeterRadiusM >= MIN_PERIMETER_RADIUS_M && s.perimeterRadiusM <= MAX_PERIMETER_RADIUS_M, `${s.perimeterRadiusM}`);
  check(`${s.archetype}: decay in [0,1]`, s.decayLevel >= 0 && s.decayLevel <= 1, `${s.decayLevel}`);
  check(`${s.archetype}: finite pos + heading`, Number.isFinite(s.position.x) && Number.isFinite(s.position.y) && Number.isFinite(s.position.z) && Number.isFinite(s.heading));
  check(`${s.archetype}: lore present`, s.factionLore.length > 20 && s.name.length > 3);
}
// distinct sites, distinct anchor nodes
const ids = new Set(sites.map((s) => s.id));
check('unique ids', ids.size === 3);

// --- spatial query pre-init ---
const s0 = sites[0];
const hit = rivals.isNearRivalBase({ x: s0.position.x + 30, y: s0.position.y + 10 });
check('isNearRivalBase hits inside territory (pre-init)', hit?.id === s0.id, JSON.stringify(hit?.id));
const miss = rivals.isNearRivalBase({ x: s0.position.x + 100_000, y: s0.position.y + 100_000 });
check('isNearRivalBase null far away', miss === null);
const just = Math.hypot(s0.position.x - (s0.position.x + 200), s0.position.y) ;
void just;
const override = rivals.isNearRivalBase({ x: s0.position.x + 200, y: s0.position.y }, 250);
check('thresholdM override extends reach', override?.id === s0.id);
const noOverride = rivals.isNearRivalBase({ x: s0.position.x + 200, y: s0.position.y });
check('default perimeter rejects at 200 m', noOverride === null);
check('NaN pos answered null', rivals.isNearRivalBase({ x: NaN, y: 0 }) === null);

// --- headless build (NullEngine) ---
const engine = new NullEngine();
const scene = new Scene(engine);
const built = new RivalBases(snapshot).init(scene);
check('isBuilt after init', built.isBuilt());
check('idempotent init', built.init(scene) === built);
const meshes = built.getMeshes();
check('meshes built', meshes.length > 80, `${meshes.length}`);
check('root node present', built.getRootNode() !== null);
check('all meshes parented', meshes.every((m) => m.parent !== null));
check('all meshes pickable', meshes.every((m) => m.isPickable));
check('all meshes tagged rivalBaseId', meshes.every((m) => typeof m.metadata?.rivalBaseId === 'string'));

for (const arch of RIVAL_BASE_ARCHETYPES) {
  const hub = built.getPartMeshes('hub', arch);
  const banner = built.getPartMeshes('banner', arch);
  const pylons = built.getPartMeshes('pylon', arch);
  const razor = built.getPartMeshes('razor', arch);
  const sockets = built.getPartMeshes('socket', arch);
  const depots = built.getPartMeshes('depot', arch);
  check(`${arch}: hub + banner`, hub.length >= 2 && banner.length >= 2, `hub=${hub.length} banner=${banner.length}`);
  check(`${arch}: pylon ring`, pylons.length >= 8, `${pylons.length}`);
  check(`${arch}: razor rings`, razor.length === 3, `${razor.length}`);
  const socketGroups = new Set(sockets.map((m) => (m.name.match(/socket-([a-z]+)-(\d+)/) ?? [])[2]));
  check(`${arch}: 2-4 railgun sockets`, socketGroups.size >= 2 && socketGroups.size <= 4, `${socketGroups.size}`);
  check(`${arch}: spark + target indicators`,
    sockets.some((m) => m.name.includes('spark')) && sockets.some((m) => m.name.includes('target')));
  check(`${arch}: surveyable depots`, depots.length >= 2 && depots.every((m) => m.metadata?.surveyable === true), `${depots.length}`);
}
check('scrapper: casings/shields/scaffold/stacks', ['casing', 'shield', 'scaffold', 'stack'].every((p) => built.getPartMeshes(p, 'scrapper_fortress').length > 0));
check('corporate: dome/foam/mast/pod/scorch', ['dome', 'foam', 'mast', 'pod', 'scorch'].every((p) => built.getPartMeshes(p, 'corporate_enclave').length > 0));
check('nomad: tread/excavator/fuel/catwalk/beacon', ['tread', 'excavator', 'fuel', 'catwalk', 'beacon'].every((p) => built.getPartMeshes(p, 'nomad_rig').length > 0));
check('nomad beacon PointLight built', built.getLights().length === 1);
check('shadow-caster subset excludes decals', built.getShadowCasterMeshes().length < meshes.length
  && !built.getShadowCasterMeshes().some((m) => m.metadata?.part === 'stain' || m.metadata?.part === 'scorch'));

// beacon flicker animates
const headMesh = built.getPartMeshes('beacon', 'nomad_rig').find((m) => m.name.includes('beacon-head'));
const headMat = headMesh?.material as { emissiveColor: { r: number } } | undefined;
built.update(0.1);
const e1 = headMat?.emissiveColor.r ?? -1;
built.update(0.9);
const e2 = headMat?.emissiveColor.r ?? -1;
check('beacon flickers over time', e1 !== e2, `e1=${e1} e2=${e2}`);
built.update(NaN); built.update(1.5); // must not throw

// --- dispose contract ---
built.dispose();
check('isBuilt false after dispose', !built.isBuilt());
check('dispose idempotent', (built.dispose(), true));
check('post-dispose queries answer null/empty', built.isNearRivalBase({ x: s0.position.x, y: s0.position.y }) === null
  && built.getMeshes().length === 0 && built.getSurveyables().length === 0 && built.getLights().length === 0);
let threw = false;
try { built.init(scene); } catch { threw = true; }
check('init after dispose throws', threw);

// caller-owned engine survives system dispose
check('caller engine alive after dispose', !engine.isDisposed);

// self-owned NullEngine fallback (no window in tsx/node)
const fallback = new RivalBases(snapshot).init();
check('NullEngine fallback init works', fallback.isBuilt() && fallback.getMeshes().length > 80);
fallback.dispose();

// empty source: empty roster but queries still answer
const empty = new RivalBases({ nodes: [], craters: [] });
check('empty snapshot → empty roster', empty.getBases().length === 0 && empty.isNearRivalBase({ x: 0, y: 0 }) === null);
const nullCtor = new RivalBases(null);
check('null ctor safe', nullCtor.getBases().length === 0);

scene.dispose();
engine.dispose();

console.log('\n' + '='.repeat(60));
if (failures.length === 0) console.log(`ALL ${passed} CHECKS PASSED ✔`);
else { console.log(`${failures.length} FAILURES of ${passed + failures.length}:`, failures); process.exit(1); }
