/**
 * Lunar Frontier — faction bases & loading-dock breaker mech smoke harness
 * (TASK-PLAY-050).
 *
 * Boots `FactionBases` and `LoadingDockMech` headless (self-owned NullEngine
 * + explicit NullEngine injection) over a LIVE `LunarWorldGenerator` snapshot
 * and verifies:
 *
 *   1. Headless build: systems construct without a DOM over the live world,
 *      bases plan from real nodes/craters BEFORE any scene exists, root nodes
 *      named, idempotent init, injected-engine path, roster subsets.
 *   2. Faction asymmetry: nation-state bases (ARTEMIS, POLAR_STAR) spawn
 *      dielectric-glass domes, radar dishes, sorting silos and reactor
 *      radiator fins; startup bases (HELIOS, RUSTBELT) spawn corrugated
 *      container stacks, lattice floodlight towers with real SpotLights,
 *      power skids and fenced excavation pits — and NEVER each other's kit.
 *   3. Mech procedural assembly: cockpit cab + view slits, hydraulic leg
 *      struts, dual pneumatic breaker arms with claws, 2 shoulder flood-
 *      lights, everything named dock-mech-*, PBR hazard materials, world
 *      placement via worldToBabylon, Babylon yaw = PI/2 + heading.
 *   4. Mech animation & excavation: activeDrill hammers the breaker clock
 *      (phase advances, arms recoil with amplitude), idle freezes the phase;
 *      excavate() drains vein reserves through the vein's OWN harvest hook,
 *      clamps at depletion, answers 0 when dry, tracks the total.
 *   5. Spatial base proximity: isNearBase detects points inside every base
 *      perimeter, rejects points beyond it, honours a scanner override
 *      radius, and picks the nearest base when perimeters overlap.
 *   6. Dispose lifecycle: idempotent dispose really disposes meshes,
 *      materials, lights and nodes for BOTH systems; every query answers
 *      empty/null post-dispose; init-after-dispose refuses; caller-owned
 *      engines survive; fresh instances rebuild over the same snapshot.
 *
 * Run: `node --no-warnings scripts/smoke-factions-and-mechs.ts` (exit 0 == green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';

import {
  FactionBases,
  FACTION_IDS,
  FACTION_DEFS,
  FLOODLIGHT_INTENSITY,
  FLOODLIGHT_RANGE_M,
} from '../src/infrastructure/Factions.ts';
import type { FactionBaseInfo, FactionId } from '../src/infrastructure/Factions.ts';
import {
  LoadingDockMech,
  MECH_BREAKER_RATE_HZ,
  MECH_EXCAVATION_RATE,
  MECH_FLOODLIGHT_INTENSITY,
} from '../src/entities/LoadingDockMech.ts';
import type { ExcavatableVein } from '../src/entities/LoadingDockMech.ts';
import { LunarWorldGenerator } from '../src/world/LunarWorldGenerator.ts';
import type { Vec3, WorldSnapshot } from '../src/world/LunarWorldGenerator.ts';
import { worldToBabylon } from '../src/engine/CameraRig.ts';

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/**
 * Babylon `Material` has no `isDisposed()` (verified against the v9.26
 * prototype chain) — arm each material's OWN onDisposeObservable before
 * teardown and read the flags back after. Returns the probe list.
 */
function armMaterialProbes(materials: ReadonlyArray<Material | null | undefined>): Array<{ name: string; fired: () => boolean }> {
  const probes: Array<{ name: string; fired: () => boolean }> = [];
  const seen = new Set<Material>();
  for (const material of materials) {
    if (material === null || material === undefined || seen.has(material)) continue;
    seen.add(material);
    let dead = false;
    material.onDisposeObservable.addOnce(() => { dead = true; });
    probes.push({ name: material.name, fired: () => dead });
  }
  return probes;
}

const world: WorldSnapshot = new LunarWorldGenerator('mala-voyage-2431').generate();
const DT = 1 / 60;

/** PBR read-view without importing the material class at runtime. */
interface PbrView {
  metallic?: number;
  roughness?: number;
  alpha?: number;
  emissiveColor?: { r: number; g: number; b: number };
}
const pbr = (mesh: Mesh): PbrView => (mesh.material ?? {}) as PbrView;
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// 1. Headless build over a live LunarWorldGenerator snapshot
// ---------------------------------------------------------------------------
section('1. headless build over live LunarWorldGenerator snapshot');

check('generator produced surface nodes', world.nodes.filter((n) => (n.kind === 'refinery' || n.kind === 'dock' || n.kind === 'outpost') && n.position.z >= -1).length >= 4);
check('generator produced craters', world.craters.length > 0, `${world.craters.length} craters`);

const factions = new FactionBases(world);
check('bases plan before init (no scene needed)', factions.isBuilt() === false && factions.getBases().length === 4);
check('all four canonical factions present', FACTION_IDS.every((id) => factions.getBase(id) !== null));
check('roster order exposed', factions.getRoster().length === 4 && factions.getRoster()[0] === 'ARTEMIS');
check('no meshes before init', factions.getMeshes().length === 0 && factions.getRootNode() === null);
check('getBase unknown faction → null', factions.getBase('VOID') === null);

// Sites anchor on REAL world nodes and sit on REAL crater rim circles.
const nodeIndex = new Map(world.nodes.map((n) => [n.id, n]));
check('every base anchors an existing sector node', factions.getBases().every((b) => {
  const node = nodeIndex.get(b.nodeId);
  return node !== undefined && node.sectorId === b.sectorId;
}));
check('every base snapped to a crater rim circle', factions.getBases().every((b) => {
  if (!b.onCraterRim || b.craterId === null) return false;
  const crater = world.craters.find((c) => c.id === b.craterId);
  if (crater === undefined) return false;
  const d = Math.hypot(b.position.x - crater.center.x, b.position.y - crater.center.y);
  return near(d, crater.radius, 1e-6);
}));
check('base claim boards list sector veins', factions.getClaimedVeins('ARTEMIS').length > 0);
check('claim board kind filter works', factions.getClaimedVeins('ARTEMIS', 'titanium').every((v) => v.kind === 'titanium'));

factions.init(); // no args → self-owned NullEngine fallback
check('init() builds under NullEngine', factions.isBuilt() === true);
check('init() is idempotent', factions.init().isBuilt() === true);
check("system root named 'faction-system'", factions.getRootNode()?.name === 'faction-system');
const totalMeshes = factions.getMeshes().length;
check('bases built 15+ meshes each', factions.getBases().every((b) => b.meshCount >= 15), `min=${Math.min(...factions.getBases().map((b) => b.meshCount))}`);
check('meshCount patched after build', factions.getMeshes().length === factions.getBases().reduce((s, b) => s + b.meshCount, 0) && totalMeshes >= 60);

// Explicitly-injected engine path builds the same kit.
const sharedEngine = new NullEngine();
const injected = new FactionBases(world).init(sharedEngine as AbstractEngine);
check('injected NullEngine builds same mesh set', injected.isBuilt() === true && injected.getMeshes().length === totalMeshes);

// Roster subset + bare-source tolerance.
const subset = new FactionBases(world, { roster: ['RUSTBELT'] }).init();
check('roster subset builds one base', subset.getBases().length === 1 && subset.getBase('RUSTBELT') !== null);
const emptySystem = new FactionBases().init();
check('empty system constructs headless', emptySystem.isBuilt() === true && emptySystem.getBases().length === 0);

// ---------------------------------------------------------------------------
// 2. Faction asymmetry verification
// ---------------------------------------------------------------------------
section('2. faction asymmetry (nation domes/dishes vs startup containers/towers)');

const nationIds: FactionId[] = ['ARTEMIS', 'POLAR_STAR'];
const startupIds: FactionId[] = ['HELIOS', 'RUSTBELT'];

check('allegiance classes canonical', nationIds.every((id) => factions.getBase(id)?.allegiance === 'nation-state')
  && startupIds.every((id) => factions.getBase(id)?.allegiance === 'startup'));
check('focus resources canonical', factions.getBase('ARTEMIS')?.focusKind === 'titanium'
  && factions.getBase('POLAR_STAR')?.focusKind === 'water_ice'
  && factions.getBase('HELIOS')?.focusKind === 'helium_3'
  && factions.getBase('RUSTBELT')?.focusKind === 'rare_earth');
check('faction display names', factions.getBase('ARTEMIS')?.factionName === FACTION_DEFS.ARTEMIS.name
  && factions.getBase('RUSTBELT')?.factionName === FACTION_DEFS.RUSTBELT.name);

// Nation-state kit: dome, dish, silo, reactor core + radiator fins.
for (const id of nationIds) {
  const domes = factions.getPartMeshes('dome', id);
  const dishes = factions.getPartMeshes('dish', id);
  const silos = factions.getPartMeshes('silo', id);
  const reactor = factions.getPartMeshes('reactor', id);
  const radiators = factions.getPartMeshes('radiator', id);
  check(`${id}: geodesic dome kit (shell + ring + inner + airlock)`, domes.length === 4);
  check(`${id}: radar dish kit (cap + rim + horn + feed)`, dishes.length === 4);
  check(`${id}: sorting silo kit (drum + cap + chute)`, silos.length === 3);
  check(`${id}: reactor core + shield`, reactor.length === 2);
  check(`${id}: radiator fin array merged`, radiators.length === 1 && radiators[0].getTotalVertices() >= 8 * 24,
    `verts=${radiators[0]?.getTotalVertices()}`);
  check(`${id}: NO startup kit`, factions.getPartMeshes('container', id).length === 0
    && factions.getPartMeshes('tower', id).length === 0
    && factions.getPartMeshes('fence', id).length === 0
    && factions.getPartMeshes('skid', id).length === 0);
  check(`${id}: no floodlights (nation sites use dish power)`, factions.getBaseLights(id).length === 0);
}

// Dome glass: high-spec dielectric — near-zero metallic, mirror-smooth,
// translucent with an interior glow.
const glassDome = factions.getPartMeshes('dome', 'ARTEMIS')[0];
const glassMat = pbr(glassDome);
check('dome glass is dielectric (metallic < 0.05)', (glassMat.metallic ?? 1) < 0.05, `m=${glassMat.metallic}`);
check('dome glass is smooth (roughness < 0.2)', (glassMat.roughness ?? 1) < 0.2);
check('dome glass is translucent (0 < alpha < 1)', (glassMat.alpha ?? 1) > 0 && (glassMat.alpha ?? 1) < 1);
check('dome glass carries habitat glow', (glassMat.emissiveColor?.g ?? 0) > 0);

// Startup kit: containers, towers, floodlights, skid, fenced pit.
for (const id of startupIds) {
  const containers = factions.getPartMeshes('container', id);
  const towers = factions.getPartMeshes('tower', id);
  const skid = factions.getPartMeshes('skid', id);
  const fence = factions.getPartMeshes('fence', id);
  const pit = factions.getPartMeshes('excavation', id);
  check(`${id}: 6 corrugated container units`, containers.length === 6);
  check(`${id}: containers carry merged rib geometry`, containers.every((m) => m.getTotalVertices() >= 6 * 24));
  check(`${id}: 2 lattice floodlight towers`, towers.length === 2 && towers.every((m) => m.getTotalVertices() >= 200));
  check(`${id}: power skid (frame + genset + tank + PV panel)`, skid.length === 4);
  check(`${id}: fenced perimeter (post ring + top rail)`, fence.length === 2 && fence[0].getTotalVertices() >= 18 * 12);
  check(`${id}: excavation pit + spoil heap`, pit.length === 2);
  check(`${id}: NO nation-state kit`, factions.getPartMeshes('dome', id).length === 0
    && factions.getPartMeshes('dish', id).length === 0
    && factions.getPartMeshes('reactor', id).length === 0);
  const lights = factions.getBaseLights(id);
  check(`${id}: 2 floodlight SpotLights live`, lights.length === 2 && lights.every((l) => l instanceof SpotLight));
  check(`${id}: floodlights lit at spec intensity/range`, lights.every((l) => near(l.intensity, FLOODLIGHT_INTENSITY) && near(l.range, FLOODLIGHT_RANGE_M)));
}

// Weathered startup paint set: exactly rust / orange / blue PBR, matte-ish.
const heliosContainers = factions.getPartMeshes('container', 'HELIOS');
const paintNames = new Set(heliosContainers.map((m) => String(m.material?.name ?? '')));
check('container paints are exactly 3 weathered PBR materials', paintNames.size === 3);
check('paint identities: rust + orange + blue', ['rust', 'orange', 'blue'].every((t) => [...paintNames].some((n) => n.includes(t))),
  [...paintNames].join(','));
check('paints are weathered dielectric (roughness > 0.5, metallic < 0.5)', heliosContainers.every((m) => {
  const mat = pbr(m);
  return (mat.roughness ?? 0) > 0.5 && (mat.metallic ?? 1) < 0.5;
}));

// Mesh naming & parenting truth per base.
for (const id of FACTION_IDS) {
  const tag = id.toLowerCase();
  const meshes = factions.getBaseMeshes(id);
  const root = factions.getBaseRoot(id);
  check(`${id}: every mesh named faction-*-${tag}`, meshes.every((m) => m.name.startsWith('faction-') && m.name.includes(`-${tag}`)));
  check(`${id}: every mesh parented to its base root`, meshes.every((m) => m.parent === root));
  check(`${id}: every mesh faction-tagged in metadata`, meshes.every((m) => m.metadata?.factionId === id));
}

// Base roots sit ON their world sites via worldToBabylon.
for (const id of FACTION_IDS) {
  const base = factions.getBase(id) as FactionBaseInfo;
  const root = factions.getBaseRoot(id);
  const want = worldToBabylon(base.position);
  check(`${id}: root at worldToBabylon(site)`, root !== null && near(root.position.x, want.x) && near(root.position.y, want.y) && near(root.position.z, want.z));
  check(`${id}: Babylon yaw = PI/2 + heading`, root !== null && near(root.rotation.y, Math.PI / 2 + base.heading));
}

// ---------------------------------------------------------------------------
// 3. Mech procedural assembly
// ---------------------------------------------------------------------------
section('3. dock-mech procedural assembly');

const site = factions.getBase('RUSTBELT') as FactionBaseInfo;
const mech = new LoadingDockMech({ name: 'dock-mech-01', position: site.position, heading: 0.4 }).init();
check('mech builds headless', mech.isBuilt() === true);
check('mech init idempotent', mech.init().isBuilt() === true);
const mechRoot = mech.getRootNode();
check('mech root node named dock-mech-01', mechRoot !== null && mechRoot.name === 'dock-mech-01');
const mechMeshes = mech.getMeshes();
check('28 procedural parts built', mechMeshes.length === 28, `${mechMeshes.length}`);
check('all parts named dock-mech-*', mechMeshes.every((m) => m.name.startsWith('dock-mech-')));
check('all parts parented to mech root', mechMeshes.every((m) => m.parent === mechRoot));
check('all parts tagged to mech id', mechMeshes.every((m) => m.metadata?.mechId === 'dock-mech-01'));

const cabParts = mech.getPartMeshes('cab');
check('reinforced cockpit cab present', cabParts.filter((m) => m.name === 'dock-mech-cockpit-cab').length === 1);
check('3 view slits on the cab', mech.getPartMeshes('cab').filter((m) => m.name.startsWith('dock-mech-view-slit')).length === 3);
check('cab visor + roof beacon', cabParts.filter((m) => m.name.includes('visor')).length === 1
  && cabParts.filter((m) => m.name.includes('beacon')).length === 1);
const slitMat = pbr(mech.getPartMeshes('cab').find((m) => m.name.startsWith('dock-mech-view-slit')) as Mesh);
check('view slits glow (amber emissive)', (slitMat.emissiveColor?.r ?? 0) > 0.5 && (slitMat.emissiveColor?.g ?? 0) > 0.3);

const legParts = mech.getPartMeshes('leg');
check('hydraulic legs mirrored left+right', ['l', 'r'].every((s) =>
  ['hip', 'thigh', 'hydraulic', 'shin', 'foot', 'toe'].every((p) => legParts.filter((m) => m.name === `dock-mech-leg-${p}-${s}`).length === 1)));
check('hydraulic knee actuators exist', legParts.filter((m) => m.name.includes('hydraulic')).length === 2);

const armParts = mech.getPartMeshes('arm');
check('dual pneumatic breaker arms', armParts.filter((m) => /^dock-mech-01-breaker-arm-[lr]$/.test(m.name)).length === 2);
check('breaker arms carry claw+breaker geometry', armParts.filter((m) => m.name.includes('breaker-arm')).every((m) => m.getTotalVertices() >= 3 * 34 + 34));
check('pneumatic piston rods stroke-meshes', armParts.filter((m) => m.name.includes('arm-piston')).length === 2);
check('shoulder yokes', armParts.filter((m) => m.name.includes('arm-yoke')).length === 2);

const floods = mech.getFloodlights();
check('2 shoulder-mount floodlight SpotLights', floods.length === 2 && floods.every((l) => l instanceof SpotLight));
check('floodlights named dock-mech-floodlight-l/r', floods.map((l) => l.name).includes('dock-mech-01-floodlight-l') && floods.map((l) => l.name).includes('dock-mech-01-floodlight-r'));
check('floodlights lit', floods.every((l) => l.intensity > 0.9 * MECH_FLOODLIGHT_INTENSITY - 0.01));

const hazard = pbr(mechMeshes.find((m) => m.name === 'dock-mech-torso') as Mesh);
const rustPart = pbr(mechMeshes.find((m) => m.name === 'dock-mech-chest-plate') as Mesh);
check('hazard-yellow torso PBR', (hazard.metallic ?? 1) < 0.5 && (hazard.roughness ?? 1) < 0.7);
check('oxidised industrial orange plate PBR', (rustPart.metallic ?? 1) < 0.6 && (rustPart.roughness ?? 0) > 0.7);

const wantSite = worldToBabylon(site.position);
check('mech stands on worldToBabylon(site)', mechRoot !== null && near(mechRoot.position.x, wantSite.x) && near(mechRoot.position.y, wantSite.y) && near(mechRoot.position.z, wantSite.z));
check('mech yaw = PI/2 + heading', mechRoot !== null && near(mechRoot.rotation.y, Math.PI / 2 + 0.4));
check('getBabylonYaw mirrors heading bookkeeping', near(mech.getBabylonYaw(), Math.PI / 2 + mech.getTelemetry().heading));

// ---------------------------------------------------------------------------
// 4. Mech animation & excavation
// ---------------------------------------------------------------------------
section('4. breaker animation + vein excavation');

const beforePhase = mech.getTelemetry().breakerPhase;
const armL = mech.getPartMeshes('arm').find((m) => m.name === 'dock-mech-01-breaker-arm-l') as Mesh;
const armX0 = armL.rotation.x;

for (let i = 0; i < 40; i++) mech.update(DT, true);
const drilling = mech.getTelemetry();
check('activeDrill advances the breaker clock', drilling.breakerPhase > beforePhase, `phase=${drilling.breakerPhase.toFixed(3)}`);
check('hammer rate plausible', drilling.breakerPhase <= MECH_BREAKER_RATE_HZ * 2 * Math.PI * 40 * DT + 1e-9);
check('rig reports drilling', drilling.drilling === true && mech.isDrilling() === true);

// Hammer amplitude: track arm recoil across a full hammer run.
let xMin = armX0;
let xMax = armX0;
for (let i = 0; i < 60; i++) {
  mech.update(DT, true);
  xMin = Math.min(xMin, armL.rotation.x);
  xMax = Math.max(xMax, armL.rotation.x);
}
check('breaker arms oscillate while firing', xMax - xMin > 0.1, `amp=${(xMax - xMin).toFixed(3)}`);
const digPitch = mech.getTelemetry().pitch;
check('dig pitch rises when firing', digPitch > 0.2 && digPitch <= Math.PI / 3);

// Piston rods stroke while firing.
const piston = mech.getPartMeshes('arm').find((m) => m.name === 'dock-mech-01-arm-piston-l') as Mesh;
let zMin = Infinity;
let zMax = -Infinity;
for (let i = 0; i < 40; i++) {
  mech.update(DT, true);
  zMin = Math.min(zMin, piston.position.z);
  zMax = Math.max(zMax, piston.position.z);
}
check('pneumatic pistons stroke in/out', zMax - zMin > 0.2, `stroke=${(zMax - zMin).toFixed(3)}`);

const frozenAfter = mech.getTelemetry().breakerPhase;
for (let i = 0; i < 30; i++) mech.update(DT, false);
check('idle freezes the breaker phase', mech.getTelemetry().breakerPhase === frozenAfter);
check('idle drops drilling flag', mech.isDrilling() === false);
check('idle lifts the booms', mech.getTelemetry().pitch < 0.1);

// Heading command + slew.
const h0 = mech.getTelemetry().heading;
mech.faceToward({ x: site.position.x + 100, y: site.position.y + 100, z: 0 });
mech.update(DT);
const h1 = mech.getTelemetry().heading;
check('heading slews toward the target (not snapped)', h1 > h0 && h1 < Math.PI / 4 + 1e-9 && h1 < h0 + 0.2, `h0=${h0.toFixed(3)} h1=${h1.toFixed(3)}`);
for (let i = 0; i < 200; i++) mech.update(DT);
check('heading converges on target bearing', near(mech.getTelemetry().heading, Math.PI / 4, 1e-6));
check('root yaw tracks converged heading', mechRoot !== null && near(mechRoot.rotation.y, Math.PI / 2 + Math.PI / 4, 1e-6));

// Floodlight toggle + ride-the-root behaviour.
const lampPosBefore = floods[0].position.asArray();
mech.setFloodlights(false);
check('setFloodlights(false) kills intensity', floods.every((l) => l.intensity === 0) && mech.getTelemetry().floodlightsOn === false);
mech.setFloodlights(true);
check('setFloodlights(true) relights', floods.every((l) => l.intensity > 0));
check('beams rake downward', floods.every((l) => l.direction.y < 0));
mech.setPosition({ x: site.position.x + 20, y: site.position.y, z: site.position.z });
mech.update(DT);
const lampPosAfter = floods[0].position.asArray();
check('floodlights ride the root when warped', Math.hypot(lampPosAfter[0] - lampPosBefore[0], lampPosAfter[2] - lampPosBefore[2]) > 15);
mech.setPosition(site.position);

// Excavation through a generator-style harvest hook.
const oreVein = { id: 'vein-vein-titanium-synth', remaining: 100, calls: [] as number[], taken: 0 };
const hooked: ExcavatableVein = {
  id: oreVein.id,
  get remaining(): number { return oreVein.remaining; },
  set remaining(v: number) { oreVein.remaining = v; },
  harvest(amt: number): number {
    oreVein.calls.push(amt);
    const got = Math.max(0, Math.min(Math.floor(amt), oreVein.remaining));
    oreVein.remaining -= got;
    oreVein.taken += got;
    return got;
  },
};
const got1 = mech.excavate(hooked, 60, 0.5);
check('excavate() pulls through the vein harvest hook', got1 === 30 && hooked.remaining === 70, `got=${got1} rem=${hooked.remaining}`);
check('request size = rate × dt', oreVein.calls.length === 1 && near(oreVein.calls[0], 30));
const got2 = mech.excavate(hooked, 60, 2);
check('excavate clamps at depletion', got2 === 70 && hooked.remaining === 0);
check('dry vein yields 0', mech.excavate(hooked, 60, 1) === 0);
check('extractedTotal tracks the ledger', mech.getExtractedTotal() === 100, `${mech.getExtractedTotal()}`);

// Plain-record vein (no hook): direct clamp + decrement, generator semantics.
const plainVein = { id: 'vein-regolith-plain', remaining: 5 };
const got3 = mech.excavate(plainVein, MECH_EXCAVATION_RATE, 1);
check('hookless vein drains via clamp', got3 === 5 && plainVein.remaining === 0);
check('non-positive rate falls back to default', mech.excavate({ id: 'v', remaining: 100 }, -5, 1) === MECH_EXCAVATION_RATE);
check('zero dt yields nothing', mech.excavate({ id: 'v', remaining: 100 }, 100, 0) === 0);

// Live-world integration: drain a REAL snapshot vein the way harvest does.
const liveVein = world.veins.find((v) => v.remaining > 500) as { id: string; remaining: number } | undefined;
check('live snapshot vein available', liveVein !== undefined);
if (liveVein !== undefined) {
  const before = liveVein.remaining;
  const pulled = mech.excavate(liveVein, 500, 1);
  check('live vein reserve reduced in place', pulled === 500 && liveVein.remaining === before - 500);
}

// ---------------------------------------------------------------------------
// 5. Spatial base proximity queries
// ---------------------------------------------------------------------------
section('5. isNearBase perimeter detection');

for (const base of factions.getBases()) {
  const hit = factions.isNearBase(base.position);
  check(`${base.factionId}: detected at its own site`, hit !== null && hit.factionId === base.factionId);
  const justInside: Vec3 = { x: base.position.x + base.radiusM * 0.9, y: base.position.y, z: base.position.z };
  check(`${base.factionId}: detected just inside perimeter`, factions.isNearBase(justInside)?.factionId === base.factionId);
  const outside: Vec3 = { x: base.position.x + base.radiusM + 60, y: base.position.y + base.radiusM + 60, z: base.position.z };
  check(`${base.factionId}: rejected beyond perimeter`, factions.isNearBase(outside) === null);
  const elevated: Vec3 = { x: base.position.x, y: base.position.y, z: base.position.z + base.radiusM + 5 };
  check(`${base.factionId}: rejected far overhead (3D radius)`, factions.isNearBase(elevated) === null);
}
check('origin (empty space) finds nothing', factions.isNearBase({ x: -9_999, y: -9_999, z: 0 }) === null);
check('non-finite point rejected', factions.isNearBase({ x: Number.NaN, y: 0, z: 0 }) === null);

// Scanner override: uniform radius beats per-faction perimeters.
const artemis = factions.getBase('ARTEMIS') as FactionBaseInfo;
const at60: Vec3 = { x: artemis.position.x + 60, y: artemis.position.y, z: artemis.position.z };
check('60 m out: own 42 m perimeter rejects', factions.isNearBase(at60) === null);
check('override radius 80 m detects through', factions.isNearBase(at60, 80)?.factionId === 'ARTEMIS');

// Nearest-base tiebreak: inflate every perimeter (perimeterScale) until the
// widely-separated bases overlap, then prove a point closer to the LAST-
// listed base still resolves to that base — nearest wins, not roster order.
const crowded = new FactionBases(world, { perimeterScale: 400 });
const artemisCrowded = crowded.getBase('ARTEMIS') as FactionBaseInfo;
const rustbelt = crowded.getBase('RUSTBELT') as FactionBaseInfo;
const nearRustbelt: Vec3 = { x: rustbelt.position.x + 5, y: rustbelt.position.y, z: rustbelt.position.z };
const gapToArtemis = Math.hypot(nearRustbelt.x - artemisCrowded.position.x, nearRustbelt.y - artemisCrowded.position.y);
check('inflated perimeters overlap the probe point', gapToArtemis <= artemisCrowded.radiusM && gapToArtemis > 5,
  `gap=${gapToArtemis.toFixed(0)} artemis=${artemisCrowded.radiusM}`);
check('overlap resolves to nearest, not first-listed', crowded.isNearBase(nearRustbelt)?.factionId === 'RUSTBELT');
check('own site still resolves correctly under scale', crowded.isNearBase(artemisCrowded.position)?.factionId === 'ARTEMIS');

// Proximity survives having no scene: queries work pre-init too.
const planOnly = new FactionBases(world);
check('pre-init queries answer from plan data', planOnly.isNearBase(artemis.position)?.factionId === 'ARTEMIS');
planOnly.dispose();
crowded.dispose();

// ---------------------------------------------------------------------------
// 6. Dispose lifecycle
// ---------------------------------------------------------------------------
section('6. dispose lifecycle (bases + mechs)');

const factionMeshSnapshot = factions.getMeshes().map((m) => m as Mesh);
const factionMatProbes = armMaterialProbes(factionMeshSnapshot.map((m) => m.material));
const factionLightSnapshot = [...factions.getLights()];
const factionRoots = FACTION_IDS.map((id) => factions.getBaseRoot(id)).filter((r) => r !== null);
const sysRoot = factions.getRootNode();

check('factions.dispose() returns cleanly', (() => { factions.dispose(); return true; })());
check('factions.dispose is idempotent', (() => { factions.dispose(); factions.dispose(); return true; })());
check('factions isBuilt false after dispose', factions.isBuilt() === false);
check('faction mesh list cleared', factions.getMeshes().length === 0);
check('faction light list cleared', factions.getLights().length === 0);
check('faction roots null', factions.getRootNode() === null && FACTION_IDS.every((id) => factions.getBaseRoot(id) === null));
check('all faction meshes really disposed', factionMeshSnapshot.every((m) => m.isDisposed()));
check('faction material set is the full 12-family PBR kit', factionMatProbes.length >= 11,
  `${factionMatProbes.length} unique materials`);
check('all faction materials really disposed (onDispose fired)', factionMatProbes.length >= 11 && factionMatProbes.every((p) => p.fired()));
check('all faction floodlights really disposed', factionLightSnapshot.every((l) => l.isDisposed()));
check('all faction base roots really disposed', factionRoots.every((r) => r?.isDisposed() === true));
void sysRoot;
check('init() after dispose refuses', (() => { try { factions.init(); return false; } catch { return true; } })());
check('faction plan data survives dispose', factions.getBases().length === 4 && factions.getBase('HELIOS') !== null);
check('isNearBase answers null post-dispose', factions.isNearBase(artemis.position) === null);
check('getClaimedVeins post-dispose still answers', Array.isArray(factions.getClaimedVeins('ARTEMIS')));

const mechMeshSnapshot = [...mech.getMeshes()] as Mesh[];
const mechMatProbes = armMaterialProbes(mechMeshSnapshot.map((m) => m.material));
const mechLampSnapshot = [...mech.getFloodlights()];
const mechRootNode = mech.getRootNode();

check('mech.dispose() returns cleanly', (() => { mech.dispose(); return true; })());
check('mech.dispose is idempotent', (() => { mech.dispose(); mech.dispose(); return true; })());
check('mech isBuilt false after dispose', mech.isBuilt() === false);
check('mech mesh list cleared', mech.getMeshes().length === 0 && mech.getFloodlights().length === 0);
check('mech root null', mech.getRootNode() === null);
check('all mech meshes really disposed', mechMeshSnapshot.every((m) => m.isDisposed()));
check('mech material set is the full 6-family PBR kit', mechMatProbes.length === 6, `${mechMatProbes.length}`);
check('all mech materials really disposed (onDispose fired)', mechMatProbes.length === 6 && mechMatProbes.every((p) => p.fired()));
check('all mech floodlights really disposed', mechLampSnapshot.every((l) => l.isDisposed()));
check('mech root really disposed', mechRootNode?.isDisposed() === true);
check('mech init-after-dispose refuses', (() => { try { mech.init(); return false; } catch { return true; } })());
check('mech update() safe post-dispose', (() => { mech.update(DT, true); return true; })());
check('mech excavate() safe post-dispose', mech.excavate({ id: 'v', remaining: 100 }, 50, 1) === 0);
check('mech telemetry safe post-dispose', Number.isFinite(mech.getTelemetry().extractedTotal));
check('mech faceToward safe post-dispose', Number.isFinite(mech.faceToward({ x: 1, y: 1, z: 0 })));
check('mech flood toggle safe post-dispose', typeof mech.setFloodlights() === 'boolean');

// Caller-owned engine must survive both systems' disposal.
check('caller-owned engine survives dispose', injected.isBuilt() === true && sharedEngine.isDisposed === false);
injected.dispose();
subset.dispose();
emptySystem.dispose();
check('re-dispose after full teardown safe', (() => { injected.dispose(); subset.dispose(); emptySystem.dispose(); return true; })());
check('caller engine still alive at teardown', sharedEngine.isDisposed === false);
sharedEngine.dispose();

// Fresh systems over the same snapshot rebuild clean.
const rebuilt = new FactionBases(world).init();
check('fresh FactionBases rebuilds identical kit', rebuilt.getMeshes().length === totalMeshes);
const rebuiltMech = new LoadingDockMech({ name: 'dock-mech-02' }).init();
check('fresh mech rebuilds 28 parts + 2 lamps', rebuiltMech.getMeshes().length === 28 && rebuiltMech.getFloodlights().length === 2);
const liveVein2 = world.veins.find((v) => v.remaining > 10) as { id: string; remaining: number } | undefined;
check('rebuilt mech excavates', liveVein2 !== undefined && rebuiltMech.excavate(liveVein2, 10, 1) === 10);
rebuilt.dispose();
rebuiltMech.dispose();
check('final teardown clean', (() => { rebuilt.dispose(); rebuiltMech.dispose(); return true; })());

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED ✔  (faction bases & dock mechs, TASK-PLAY-050)`);
  process.exit(0);
} else {
  console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
