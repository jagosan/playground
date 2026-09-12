/**
 * Lunar Frontier — rail line & automated ore cart smoke harness
 * (TASK-PLAY-048b).
 *
 * Boots `RailSystem` headless (self-owned NullEngine + explicit NullEngine
 * injection) over a LIVE `LunarWorldGenerator` snapshot and verifies:
 *
 *   1. Headless build: system constructs without a DOM, one merged tie mesh +
 *      two rail tubes per route, root node 'rail-system', idempotent init.
 *   2. Track geometry: `rail-rail-*` dual tubes and `rail-tie-*` sleepers for
 *      every route, metallic PBR steel, hugging the route polyline through
 *      worldToBabylon, ties counted from route length / 1.2 m, subterranean
 *      rails descending with their shaft.
 *   3. Ore cart spawning & hierarchy: `spawnCart` returns an `ore-cart-*`
 *      entity with hopper, frame, 4 flanged wheels and payload meshes under a
 *      root transform parented to the rail-system root.
 *   4. Kinematics: advancing update(dt) moves the cart along the route
 *      polyline BIT-IDENTICALLY to a standalone `RailCar` reference instance
 *      stepped with the same commands (zero duplicate physics).
 *   5. Grade dynamics: a cart on an inclined shaft descent (z decreasing)
 *      accelerates under gravity with an idle command and decelerates under
 *      the pneumatic brake; a level surface line stays parked when idle; a
 *      throttled cart finally flags its terminal.
 *   6. Cargo scaling: setCargoMass updates total mass (tare + cargo) and
 *      scales the payload mesh height up to RAIL_CAR_MAX_PAYLOAD_KG, clamped.
 *   7. Multi-cart: carts on different routes advance independently under
 *      commands keyed by cart id (Map) or route id (plain record).
 *   8. Lifecycle: idempotent dispose, track/cart/root lists cleared, update +
 *      every query safe post-dispose, init-after-dispose refuses.
 *
 * Run: `node --no-warnings scripts/smoke-rail-system.ts` (exit 0 == green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';

import {
  RailSystem,
  OreCartEntity,
  RAIL_GAUGE,
  RAIL_LEVEL_M,
  RAIL_CAR_TARE_KG,
  RAIL_CAR_MAX_PAYLOAD_KG,
  RAIL_TIE_SPACING_M,
} from '../src/infrastructure/RailSystem.ts';
import {
  IDLE_RAIL_COMMAND,
  RailCar,
  type RailCarCommand,
} from '../src/physics/TraversalPhysics.ts';
import { LunarWorldGenerator } from '../src/world/LunarWorldGenerator.ts';
import type { LunarNode, RailRoute, Vec3 } from '../src/world/LunarWorldGenerator.ts';
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

function node(id: string, x: number, y: number, z: number): LunarNode {
  return { id, kind: 'junction', name: id, position: { x, y, z }, sectorId: 'synth' };
}

/** Synthetic rail world: one level surface triangle + one deep shaft descent. */
function synthWorld(): { routes: RailRoute[]; nodes: LunarNode[] } {
  const nodes: LunarNode[] = [
    node('n-dock', 0, 0, 0),
    node('n-mid', 0, 300, 0),
    node('n-ref', 200, 300, 0),
    node('n-collar', 0, 0, 0),
    node('n-mid-shaft', 40, 0, -80),
    node('n-sump', 40, 0, -160),
    node('n-siding', 20, 0, 0),
  ];
  const routes: RailRoute[] = [
    { id: 'rail-synth-surface', name: 'Synth Surface', nodeIds: ['n-dock', 'n-mid', 'n-ref'], gauge: RAIL_GAUGE, length: 500, kind: 'surface' },
    { id: 'rail-synth-shaft', name: 'Synth Shaft', nodeIds: ['n-collar', 'n-mid-shaft', 'n-sump'], gauge: RAIL_GAUGE, length: 184, kind: 'tunnel' },
    { id: 'rail-synth-siding', name: 'Synth Siding', nodeIds: ['n-dock', 'n-siding'], gauge: RAIL_GAUGE, length: 20, kind: 'surface' },
  ];
  return { routes, nodes };
}

const world = new LunarWorldGenerator('mala-voyage-2431').generate();

/** Node positions of a live-snapshot route, in chain order. */
function worldStops(route: RailRoute): Vec3[] {
  return route.nodeIds
    .map((id) => world.nodes.find((n) => n.id === id)?.position)
    .filter((p): p is Vec3 => p !== undefined);
}

const RUN: RailCarCommand = { throttle: 4, dynamicBrake: 0, pneumaticBrake: 0, stopAtTerminal: false };
const BRAKE: RailCarCommand = { throttle: 0, dynamicBrake: 0, pneumaticBrake: 1, stopAtTerminal: false };
const DT = 1 / 60;

/** World-axis AABB of a mesh (mesh-space == world for root-parented children). */
function bbOf(mesh: AbstractMesh): {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
} {
  mesh.computeWorldMatrix(true); // fresh AABB even mid-frame / headless
  const bb = mesh.getBoundingInfo().boundingBox;
  return { min: bb.minimumWorld, max: bb.maximumWorld };
}

// ---------------------------------------------------------------------------
// 1. Headless build (live generator snapshot)
// ---------------------------------------------------------------------------
section('1. headless build over live LunarWorldGenerator snapshot');

check('generator produced rail routes', world.railRoutes.length > 0, `${world.railRoutes.length} routes`);
check('generator produced nodes', world.nodes.length > 0, `${world.nodes.length} nodes`);

const rails = new RailSystem(world);
check('no meshes before init', rails.isBuilt() === false && rails.getMeshes().length === 0);
check('no root node before init', rails.getRootNode() === null);
check('routes exposed pre-init', rails.getRoutes().length === world.railRoutes.length);
check('carts empty pre-init', rails.getCarts().length === 0);

rails.init(); // no args → self-owned NullEngine fallback
check('init() builds under NullEngine', rails.isBuilt() === true);
check('init() is idempotent', rails.init().isBuilt() === true);
const root = rails.getRootNode();
check("root transform node named 'rail-system'", root !== null && root.name === 'rail-system');

// Explicitly-injected engine path builds too.
const sharedEngine = new NullEngine();
const injected = new RailSystem(world).init(sharedEngine);
check('injected NullEngine builds', injected.isBuilt() === true && injected.getRailMeshes().length === rails.getRailMeshes().length);

// Bare (routes, nodes) constructor form over synthetic geometry — array nodes.
const synth = synthWorld();
const synthRails = new RailSystem({ routes: synth.routes, nodes: synth.nodes }).init();
check('bare { routes, nodes:[] } constructor builds', synthRails.isBuilt() === true && synthRails.getRoutes().length === 3);
// ...and the Map-node form.
const mapRails = new RailSystem({ routes: synth.routes, nodes: new Map(synth.nodes.map((n) => [n.id, n])) }).init();
check('bare { routes, nodes:Map } constructor builds', mapRails.getRailMeshes().length === 6);

// ---------------------------------------------------------------------------
// 2. Track geometry verification
// ---------------------------------------------------------------------------
section('2. track geometry (dual rails, ties, PBR steel, worldToBabylon)');

const railMeshes = rails.getRailMeshes();
const tieMeshes = rails.getTieMeshes();
const buildable = world.railRoutes.filter((r) => worldStops(r).length >= 2);
check('every live route resolves to ≥2 node positions', buildable.length === world.railRoutes.length);
check('two rail tubes per route', railMeshes.length === 2 * buildable.length, `${railMeshes.length} vs ${2 * buildable.length}`);
check('one merged tie mesh per route', tieMeshes.length === buildable.length, `${tieMeshes.length} vs ${buildable.length}`);
check('all rails named rail-rail-*', railMeshes.every((m) => m.name.startsWith('rail-rail-')));
check('all ties named rail-tie-*', tieMeshes.every((m) => m.name.startsWith('rail-tie-')));
check('rails form L/R pairs per route', buildable.every((r) => railMeshes.filter((m) => m.name.startsWith(`rail-rail-${r.id}-`)).length === 2));
check('rail meshes parented to rail-system root', railMeshes.every((m) => m.parent === root));
check('tie meshes parented to rail-system root', tieMeshes.every((m) => m.parent === root));

const steelNames = new Set(railMeshes.map((m) => m.material?.name ?? 'none'));
check('rails share one steel material', steelNames.size === 1 && [...steelNames][0].includes('steel'));
const steelMat = railMeshes[0].material as { metallic?: number } | null;
check('steel material is metallic', (steelMat?.metallic ?? 0) > 0.8);
const tieMat = tieMeshes[0].material as { metallic?: number; roughness?: number } | null;
check('tie material is weathered dielectric composite', (tieMat?.metallic ?? 1) < 0.2 && (tieMat?.roughness ?? 0) > 0.8);

// World-frame truth, alignment-independent: EVERY vertex of both rail tubes
// of a probe route lies within [gauge/2 − head, gauge/2 + head] of the
// route's world-frame node polyline (rails are ±gauge/2 offset tubes of
// radius `head` bored along it). Babylon AABB → world via the inverse of
// worldToBabylon: world = (x, −z, y).
const probeRoute = world.railRoutes.find((r) => worldStops(r).length === 2) ?? world.railRoutes[0];
const probeStops = worldStops(probeRoute);
const probeRails = railMeshes.filter((m) => m.name.startsWith(`rail-rail-${probeRoute.id}-`));
check('probe route found (2-node route)', probeStops.length >= 2 && probeRails.length === 2);

/** Distance from a world-frame point to the polyline through `pts`. */
function distToPolyline(p: Vec3, pts: Vec3[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const len2 = abx * abx + aby * aby + abz * abz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby), p.z - (a.z + t * abz)));
  }
  return best;
}
/** Mesh vertex positions in the WORLD frame (worldToBabylon inverse). */
function worldVertices(mesh: AbstractMesh): Vec3[] {
  mesh.computeWorldMatrix(true);
  const data = mesh.getVerticesData(VertexBuffer.PositionKind);
  const out: Vec3[] = [];
  if (data === null || data === undefined) return out;
  for (let i = 0; i < data.length; i += 3) {
    out.push({ x: data[i], y: -data[i + 2], z: data[i + 1] });
  }
  return out;
}
const HEAD = 0.045; // RAIL_HEAD_RADIUS as built
const railPlane = probeStops.map((q) => ({ x: q.x, y: q.y, z: q.z + RAIL_LEVEL_M }));
let hugWorst = 0;
let hugVerts = 0;
const thinH = (list: Vec3[]): Vec3[] => {
  const step = Math.max(1, Math.floor(list.length / 200));
  return list.filter((_, i) => i % step === 0);
};
for (const tube of probeRails) {
  for (const v of thinH(worldVertices(tube))) {
    const d = distToPolyline(v, railPlane);
    hugWorst = Math.max(hugWorst, Math.abs(d - RAIL_GAUGE / 2));
    hugVerts++;
  }
}
check('every rail vertex hugs the node polyline within rail head', hugVerts > 24 && hugWorst <= HEAD + 0.01, `worst=${hugWorst.toFixed(4)} n=${hugVerts}`);
const leftTube = probeRails.find((m) => m.name.endsWith('-l'))!;
const rightTube = probeRails.find((m) => m.name.endsWith('-r'))!;
// L and R rails occupy opposite sides: their closest-vertex separation is
// ≈ gauge − 2·head·(1−cos 30°), comfortably distinct from a single rail.
const thin = (list: Vec3[]): Vec3[] => {
  const step = Math.max(1, Math.floor(list.length / 160)); // keep it O(few·10²)
  return list.filter((_, i) => i % step === 0);
};
const leftV = thin(worldVertices(leftTube));
const rightV = thin(worldVertices(rightTube));
let minSep = Infinity;
for (const a of leftV) for (const b of rightV) {
  const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  if (d < minSep) minSep = d;
}
check('dual rails spaced by RAIL_GAUGE (0.75 m)', minSep > RAIL_GAUGE - 2 * HEAD - 0.02 && minSep <= RAIL_GAUGE + 0.01, `sep=${minSep.toFixed(4)}`);

// Tie count truth: one sleeper every ~1.2 m along every route.
// Independent recomputation from node positions (the system uses the same
// re-derived polyline length, not the generator's rounded bookkeeping).
let expectedTies = 0;
for (const r of buildable) {
  const p = worldStops(r);
  let len = 0;
  for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y, p[i].z - p[i - 1].z);
  expectedTies += Math.floor(len / RAIL_TIE_SPACING_M) + 1;
}
const reportedTies = tieMeshes.reduce((acc, m) => acc + ((m.metadata?.count as number) ?? 0), 0);
check('tie count = Σ floor(route_len / 1.2) + 1', reportedTies === expectedTies, `${reportedTies} vs ${expectedTies}`);
check('every tie mesh carries merged sleeper geometry', tieMeshes.every((m) => m.getTotalVertices() >= 24));

// Subterranean truth: the deepest non-surface route's rails must follow its z
// drop — the lowest rail vertex in Babylon y equals the lowest node z.
const deep = world.railRoutes
  .filter((r) => r.kind !== 'surface')
  .sort((x, y) =>
    Math.min(...worldStops(y).map((p) => p.z)) - Math.min(...worldStops(x).map((p) => p.z)))[0];
check('a subterranean/mixed route exists', deep !== undefined);
const deepRails = railMeshes.filter((m) => m.name.startsWith(`rail-rail-${deep.id}-`));
const zLoWorld = Math.min(...worldStops(deep).map((p) => p.z));
const zLoBabylon = Math.min(...deepRails.flatMap((m) => bbOf(m).min.y));
check('subterranean rails descend with the shaft (world z → babylon y)', Math.abs(zLoBabylon - zLoWorld) <= 0.5, `lo=${zLoBabylon.toFixed(1)} vs ${zLoWorld.toFixed(1)}`);
const zHiWorld = Math.max(...worldStops(deep).map((p) => p.z));
const zHiBabylon = Math.max(...deepRails.flatMap((m) => bbOf(m).max.y));
check('shaft rails span the full descent', Math.abs(zHiBabylon - zHiWorld) <= 0.5, `hi=${zHiBabylon.toFixed(1)} vs ${zHiWorld.toFixed(1)}`);

// ---------------------------------------------------------------------------
// 3. Ore cart spawning & procedural mesh hierarchy
// ---------------------------------------------------------------------------
section('3. ore cart spawn + mesh hierarchy (hopper, 4 wheels, payload)');

const cart = rails.spawnCart(probeRoute.id);
check('spawnCart returns an entity', cart !== null);
check('entity is an OreCartEntity', cart instanceof OreCartEntity);
check('cart id matches ore-cart-*', cart !== null && /^ore-cart-\d+$/.test(cart.cartId), cart?.cartId);
check('cart route id = spawn route', cart?.routeId === probeRoute.id);
check('cart attached to scene', cart?.isAttached() === true);
const cartRoot = cart?.getRootNode() ?? null;
check('cart root transform node present', cartRoot !== null && cartRoot.name === cart?.cartId);
check('cart root parented to rail-system root', cartRoot?.parent === root);

const cartMeshes = cart?.getMeshes() ?? [];
const named = (suffix: string) => cartMeshes.filter((m) => m.name === `${cart!.cartId}-${suffix}`);
check('all cart meshes named ore-cart-*', cartMeshes.every((m) => m.name.startsWith(`${cart!.cartId}-`)));
check('one hopper body mesh', named('hopper').length === 1);
check('one frame skid mesh', named('frame').length === 1);
check('one payload mesh', named('payload').length === 1);
check('four flanged wheel meshes', [0, 1, 2, 3].every((i) => named(`wheel-${i}`).length === 1));
// A flanged wheel is tread + 2 flanges merged: (16+2)·2 verts tread ≥ 36.
check('wheels carry merged flange geometry', [0, 1, 2, 3].every((i) => named(`wheel-${i}`)[0].getTotalVertices() >= 36));
check('all cart meshes parented to cart root', cartMeshes.every((m) => m.parent === cartRoot));
check('system getMeshes = rails + ties + cart', rails.getMeshes().length === railMeshes.length + tieMeshes.length + cartMeshes.length);
check('cart starts at route origin terminal', cart !== null && cart.getDistance() === 0 && cart.getSpeed() === 0);
const startPos = cart?.getPosition();
const expectStart = probeStops[0];
check('spawn position = first node position', startPos !== undefined && Math.hypot(startPos.x - expectStart.x, startPos.y - expectStart.y, startPos.z - expectStart.z) < 1e-9);
check('cart parked at spawn', cart?.getState().parked === true);
check('unknown route spawn returns null', rails.spawnCart('rail-nonexistent') === null);

check('getCarts lists the fleet', rails.getCarts().length === 1 && rails.getCarts()[0] === cart);
check('getCart by cart id', rails.getCart(cart!.cartId) === cart);
check('getCart by route id', rails.getCart(probeRoute.id) === cart);

const wantBab0 = worldToBabylon(cart!.getPosition());
const gotBab0 = cartRoot!.position;
check('cart root sits at worldToBabylon(position)', Math.hypot(gotBab0.x - wantBab0.x, gotBab0.y - wantBab0.y, gotBab0.z - wantBab0.z) < 1e-9);

// ---------------------------------------------------------------------------
// 4. Ore cart kinematics — bit-identical to a standalone RailCar
// ---------------------------------------------------------------------------
section('4. kinematics: update(dt) ≡ standalone RailCar (zero duplicate physics)');

// Reference instance built exactly the way RailSystem builds its carts.
const reference = new RailCar(probeRoute, probeStops.map((p) => ({ ...p })), {});

function stepBoth(n: number, command: RailCarCommand): void {
  const cmdMap = new Map<string, RailCarCommand>([[cart!.cartId, command]]);
  for (let i = 0; i < n; i++) {
    rails.update(DT, cmdMap);
    reference.step(DT, command);
  }
}

stepBoth(120, RUN);
const sCart = cart!.getState();
const sRef = reference.getState();
check('throttled run advanced the cart', sCart.distance > 0.2, `d=${sCart.distance.toFixed(3)}`);
check('distance bit-identical to RailCar', sCart.distance === sRef.distance, `${sCart.distance} vs ${sRef.distance}`);
check('speed bit-identical to RailCar', sCart.speed === sRef.speed, `${sCart.speed} vs ${sRef.speed}`);
check('getSpeed() mirrors physics state', cart!.getSpeed() === sRef.speed);
const refPos = reference.position();
const entPos = cart!.getPosition();
check('position bit-identical to RailCar.position()', entPos.x === refPos.x && entPos.y === refPos.y && entPos.z === refPos.z);
const meshBab = cartRoot!.position;
const refBab = worldToBabylon(refPos);
check('mesh rides polyline via worldToBabylon', Math.hypot(meshBab.x - refBab.x, meshBab.y - refBab.y, meshBab.z - refBab.z) < 1e-9);
check('cart moved forward in world space', Math.hypot(entPos.x - expectStart.x, entPos.y - expectStart.y, entPos.z - expectStart.z) > 0.2);

stepBoth(60, IDLE_RAIL_COMMAND);
check('idle coasting stays bit-identical', cart!.getDistance() === reference.getState().distance);
const wheel0 = named('wheel-0')[0];
check('wheels roll (spin ≠ 0 after run)', Math.abs(wheel0.rotation.x) > 0.5, `${wheel0.rotation.x}`);

// ---------------------------------------------------------------------------
// 5. Grade dynamics & shaft descent (synthetic world)
// ---------------------------------------------------------------------------
section('5. grade dynamics: gravity down inclined shaft + brake deceleration');

const shaftRoute = synth.routes[1]; // n-collar → n-mid-shaft → n-sump (z: 0 → -160)
const shaftStops = synth.nodes.filter((n) => shaftRoute.nodeIds.includes(n.id)).map((n) => n.position);
const shaftCart = synthRails.spawnCart(shaftRoute.id);
check('shaft cart spawned', shaftCart !== null);
check('shaft route descends monotonically (z decreasing)', (() => {
  const zs = shaftStops.map((p) => p.z);
  return zs.length === 3 && zs[1] < zs[0] && zs[2] < zs[1];
})());

// Idle on the incline: gravity pulls the consist down the shaft.
const shaftRef = new RailCar(shaftRoute, shaftStops.map((p) => ({ ...p })), {});
const shaftMap = new Map<string, RailCarCommand>([[shaftCart!.cartId, IDLE_RAIL_COMMAND]]);
for (let i = 0; i < 300; i++) { synthRails.update(DT, shaftMap); shaftRef.step(DT, IDLE_RAIL_COMMAND); }
const descended = shaftCart!.getPosition();
check('gravity moves idle cart down the shaft', shaftCart!.getDistance() > 1, `d=${shaftCart!.getDistance().toFixed(2)}`);
check('shaft cart z strictly below the collar', descended.z < -1, `z=${descended.z.toFixed(2)}`);
check('descent bit-identical to RailCar', shaftCart!.getDistance() === shaftRef.getState().distance && descended.z === shaftRef.position().z);
const speedIdle = shaftCart!.getSpeed();
check('gravity accelerates the descent', speedIdle > 0.3, `v=${speedIdle.toFixed(3)}`);

// Pneumatic brake decelerates the rolling consist.
const brakeMap = new Map<string, RailCarCommand>([[shaftCart!.cartId, BRAKE]]);
for (let i = 0; i < 180; i++) synthRails.update(DT, brakeMap);
const speedBraked = shaftCart!.getSpeed();
check('brake decelerates the cart', speedBraked < speedIdle, `${speedBraked.toFixed(3)} < ${speedIdle.toFixed(3)}`);
check('brake pipe closes under command', shaftCart!.getState().brakePipe < 0.2);

// Level surface line stays parked under an idle command (holding brake).
const flatCart = synthRails.spawnCart(synth.routes[2].id); // 8 m siding
for (let i = 0; i < 120; i++) synthRails.update(DT); // no commands → idle
check('idle cart on level line stays parked', flatCart!.getDistance() === 0 && flatCart!.getState().parked === true);

// Terminal behaviour: run the short siding to its end and watch the flag.
const runMap = new Map<string, RailCarCommand>([[flatCart!.cartId, RUN]]);
for (let i = 0; i < 1_500; i++) synthRails.update(DT, runMap);
check('throttled cart eventually flags terminal', flatCart!.isAtTerminal() === true, `d=${flatCart!.getDistance().toFixed(2)} len=8`);
check('terminal cart stops at route end', flatCart!.getSpeed() === 0 && flatCart!.getDistance() > 7.9);

// ---------------------------------------------------------------------------
// 6. Cargo load scaling
// ---------------------------------------------------------------------------
section('6. cargo load scaling (mass + payload mesh height)');

const payload = named('payload')[0];
const payloadBoxHeight = 0.7 - 0.08; // hopper height − payload inset (module geometry)
check('empty cart cargo = 0', cart!.getCargoMass() === 0);
check('empty cart total mass = tare', cart!.getTotalMass() === RAIL_CAR_TARE_KG, `${cart!.getTotalMass()}`);

const half = cart!.setCargoMass(RAIL_CAR_MAX_PAYLOAD_KG / 2);
check('setCargoMass returns clamped value', half === RAIL_CAR_MAX_PAYLOAD_KG / 2);
check('cargo ledger updated', cart!.getCargoMass() === RAIL_CAR_MAX_PAYLOAD_KG / 2);
check('physics total mass = tare + cargo', cart!.getTotalMass() === RAIL_CAR_TARE_KG + RAIL_CAR_MAX_PAYLOAD_KG / 2);
check('payload height scales to 50 % at half load', Math.abs(payload.scaling.y - 0.5) < 1e-9, `scaleY=${payload.scaling.y}`);
const payloadBB = bbOf(payload);
const worldSpanHalf = payloadBB.max.y - payloadBB.min.y;
check('payload world height = 50 % of box', Math.abs(worldSpanHalf - payloadBoxHeight * 0.5) < 1e-6, `${worldSpanHalf.toFixed(4)} vs ${(payloadBoxHeight * 0.5).toFixed(4)}`);

const full = cart!.setCargoMass(RAIL_CAR_MAX_PAYLOAD_KG);
check('full 2,400 kg load accepted', full === RAIL_CAR_MAX_PAYLOAD_KG);
check('payload at full height', Math.abs(payload.scaling.y - 1) < 1e-9);
check('full-load total mass', cart!.getTotalMass() === RAIL_CAR_TARE_KG + RAIL_CAR_MAX_PAYLOAD_KG);
const payloadBBFull = bbOf(payload);
check('full payload world height = box height', Math.abs(payloadBBFull.max.y - payloadBBFull.min.y - payloadBoxHeight) < 1e-6);

const over = cart!.setCargoMass(RAIL_CAR_MAX_PAYLOAD_KG + 5_000);
check('over-capacity clamps to max payload', over === RAIL_CAR_MAX_PAYLOAD_KG);
check('negative cargo clamps to 0', cart!.setCargoMass(-42) === 0);
check('payload collapses to floor stub at 0', payload.scaling.y < 0.1 && payload.scaling.y > 0);
check('NaN cargo rejected to 0', cart!.setCargoMass(Number.NaN) === 0);

// Spawn-time load through the spec.
const loaded = rails.spawnCart(probeRoute.id, { load: 1_200 });
check('spec load spawns cargo', loaded !== null && loaded.getCargoMass() === 1_200);
const loadedPayload = loaded!.getMeshes().find((m) => m.name.endsWith('payload'))!;
check('spec-loaded payload scaled to 50 %', Math.abs(loadedPayload.scaling.y - 0.5) < 1e-9);
check('fleet now two carts', rails.getCarts().length === 2);

// ---------------------------------------------------------------------------
// 7. Multi-cart tracking (independent routes, map + record commands)
// ---------------------------------------------------------------------------
section('7. multi-cart independent tracking');

const multiSystem = new RailSystem({ routes: synth.routes, nodes: synth.nodes }).init();
const cA = multiSystem.spawnCart(synth.routes[0].id)!; // level surface line
const cB = multiSystem.spawnCart(synth.routes[1].id)!; // descending shaft
const cC = multiSystem.spawnCart(synth.routes[1].id)!; // second cart, same shaft
check('three carts spawned on two routes', multiSystem.getCarts().length === 3);
check('carts on same route are distinct entities', cB !== cC && cB.cartId !== cC.cartId);

const dA0 = cA.getDistance();
// Map commands: only cart B throttled; cart C idles; cart A idles.
const mixedMap = new Map<string, RailCarCommand>([[cB.cartId, RUN]]);
for (let i = 0; i < 120; i++) multiSystem.update(DT, mixedMap);
check('un-commanded surface cart stays parked', cA.getDistance() === dA0 && cA.getState().parked);
check('commanded shaft cart advanced', cB.getDistance() > 1);
check('idle shaft cart coasts under gravity only', cC.getDistance() > 0);
check('per-cart independence (B faster than C)', cB.getSpeed() > cC.getSpeed() + 0.1 && cB.getDistance() !== cC.getDistance());
check('both shaft carts descend', cB.getPosition().z < 0 && cC.getPosition().z < 0);
check('carts report their own route ids', cA.getState().routeId === synth.routes[0].id && cB.getState().routeId === synth.routes[1].id);

// Plain-record commands keyed by ROUTE id.
const dA1 = cA.getDistance();
const recCommands: Record<string, RailCarCommand> = { [synth.routes[0].id]: RUN };
for (let i = 0; i < 120; i++) multiSystem.update(DT, recCommands);
check('record command keyed by route id drives its cart', cA.getDistance() > dA1 + 0.2, `d=${cA.getDistance().toFixed(2)}`);
check('route-keyed run left other routes idle', cC.getState().throttle === 0);

// ---------------------------------------------------------------------------
// 8. Dispose lifecycle
// ---------------------------------------------------------------------------
section('8. dispose lifecycle');

check('dispose() returns cleanly', (() => { rails.dispose(); return true; })());
check('dispose is idempotent', (() => { rails.dispose(); rails.dispose(); return true; })());
check('isBuilt() false after dispose', rails.isBuilt() === false);
check('rail mesh list cleared', rails.getRailMeshes().length === 0);
check('tie mesh list cleared', rails.getTieMeshes().length === 0);
check('cart fleet cleared', rails.getCarts().length === 0);
check('root null after dispose', rails.getRootNode() === null);
check('system getMeshes cleared', rails.getMeshes().length === 0);
check('cart detached (meshes gone, root null)', cart!.getMeshes().length === 0 && cart!.getRootNode() === null);
check('track meshes really disposed', railMeshes[0].isDisposed() === true && tieMeshes[0].isDisposed() === true);
check('cart meshes really disposed', cartMeshes.every((m) => m.isDisposed()));
check('init() after dispose refuses', (() => { try { rails.init(); return false; } catch { return true; } })());

check('update() safe post-dispose', (() => { rails.update(DT); rails.update(DT, new Map()); rails.update(DT, {}); return true; })());
check('spawnCart safe post-dispose', rails.spawnCart(probeRoute.id) === null);
check('getCart safe post-dispose', rails.getCart(cart!.cartId) === null);
check('routes data survives dispose', rails.getRoutes().length === world.railRoutes.length);
check('sampleRoute survives dispose (pure geometry)', rails.sampleRoute(deep.id, 0) !== null);

// Entity-level queries keep answering from physics after teardown.
check('cart getState safe post-detach', cart!.getState().routeId === probeRoute.id);
check('cart getPosition finite post-detach', Number.isFinite(cart!.getPosition().x) && Number.isFinite(cart!.getPosition().z));
check('cart getSpeed/getCargoMass safe post-detach', cart!.getSpeed() >= 0 && cart!.getCargoMass() >= 0);
check('cart setCargoMass safe post-detach', cart!.setCargoMass(100) === 100);
check('cart isAtTerminal safe post-detach', typeof cart!.isAtTerminal() === 'boolean');

// Caller-owned engine must survive the system's disposal.
check('caller-owned engine survives dispose', sharedEngine.isDisposed === false);
sharedEngine.dispose();
injected.dispose();
synthRails.dispose();
mapRails.dispose();
multiSystem.dispose();
check('re-dispose after full teardown still safe', (() => { injected.dispose(); synthRails.dispose(); mapRails.dispose(); multiSystem.dispose(); return true; })());

// Fresh system over the same snapshot rebuilds clean.
const rebuilt = new RailSystem(world).init();
check('fresh instance rebuilds over same snapshot', rebuilt.isBuilt() === true && rebuilt.getRailMeshes().length === 2 * buildable.length);
rebuilt.dispose();

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED ✔  (rail system & ore carts, TASK-PLAY-048b)`);
  process.exit(0);
} else {
  console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
