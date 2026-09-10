/**
 * Smoke / unit test for src/world/LunarWorldGenerator.ts.
 *
 * Run (Node >= 22.6 with type stripping, e.g. `node --no-warnings scripts/smoke-lunarworld.ts`)
 * or via esbuild bundle like the server smoke test. Not part of the shipped
 * server; asserts:
 *   1. seed reproducibility (byte-identical digests, differing across seeds)
 *   2. world invariants (sector grid, crater floors, node/vein/tunnel sanity)
 *   3. tunnel-graph queries (adjacency, Dijkstra path, rail routing)
 *   4. resource queries at depth (availability, rig feasibility, harvest)
 */
import assert from 'node:assert';

import LunarWorldGenerator, {
  FREIGHT_REACH_M,
  MIN_BUGGY_Z,
  RESOURCE_KINDS,
  RESOURCE_PROFILES,
  type ExtractionMode,
  type ResourceKind,
  type TunnelKind,
  type WorldSnapshot,
} from '../src/world/LunarWorldGenerator.ts';

function section(label: string): void {
  console.log(`\n=== ${label} ===`);
}

// ---------------------------------------------------------------------------
// 1. Seed reproducibility
// ---------------------------------------------------------------------------
section('1. seed reproducibility');

const genA = new LunarWorldGenerator('mala-voyage-2431');
const genB = new LunarWorldGenerator('mala-voyage-2431');
const genC = new LunarWorldGenerator('artemis-coalition');

const snapA = genA.generate();
const snapB2 = genB.generate();
const snapA2 = genA.generate(); // cached path
const snapC = genC.generate();

assert.equal(genA.digest(), genB.digest(), 'same seed must produce identical digest');
assert.equal(JSON.stringify(snapA), JSON.stringify(snapA2), 'cached generate() must be stable');
assert.notEqual(genA.digest(), genC.digest(), 'different seeds must diverge');
assert.notEqual(snapC.stats, snapA.stats); // rough divergence check
console.log('digest(mala-voyage-2431) =', genA.digest());
console.log('digest(artemis-coalition) =', genC.digest());
console.log('stats:', JSON.stringify(snapA.stats));

// numeric seed also works + is self-consistent
const genN1 = new LunarWorldGenerator(424242);
const genN2 = new LunarWorldGenerator(424242);
assert.equal(genN1.digest(), genN2.digest());
console.log('numeric seed reproducible ✔');

// ---------------------------------------------------------------------------
// 2. World invariants
// ---------------------------------------------------------------------------
section('2. world invariants');

const world: WorldSnapshot = snapA;

// Sector grid covers the full extent, unique ids.
assert.equal(world.sectors.length, 12, 'default grid 4x3 sectors');
const sectorIds = new Set(world.sectors.map((s) => s.id));
assert.equal(sectorIds.size, world.sectors.length);
assert.ok(world.sectors.some((s) => s.terrane === 'polar'), 'polar belt must exist');
assert.ok(world.sectors.some((s) => s.terrane === 'mare'), 'mare terrane must exist');
assert.ok(world.sectors.some((s) => s.terrane === 'highland'), 'highland terrane must exist');

// Every crater belongs to a sector and sits inside its bounds.
for (const c of world.craters) {
  const s = world.sectors.find((x) => x.id === c.sectorId);
  assert.ok(s, `crater ${c.id} sector exists`);
  assert.ok(
    c.center.x >= s!.bounds.minX && c.center.x <= s!.bounds.maxX &&
    c.center.y >= s!.bounds.minY && c.center.y <= s!.bounds.maxY,
    `crater ${c.id} inside sector bounds`,
  );
}
assert.ok(world.stats.shadowedCraters >= 1, 'expect at least one shadowed polar crater');
console.log(`sectors=${world.sectors.length} craters=${world.craters.length} shadowed=${world.stats.shadowedCraters}`);

// Nodes: unique ids, surface nodes have z >= 0, subsurface strictly z < 0.
const nodeIds = new Set(world.nodes.map((n) => n.id));
assert.equal(nodeIds.size, world.nodes.length, 'unique node ids');
for (const n of world.nodes) {
  if (n.kind === 'refinery' || n.kind === 'dock' || n.kind === 'outpost' || n.kind === 'shaft_head') {
    assert.ok(n.position.z >= 0, `${n.name} (${n.kind}) must be at z >= 0, got ${n.position.z}`);
  } else {
    assert.ok(n.position.z < 0, `${n.name} (${n.kind}) is subsurface, must be z < 0, got ${n.position.z}`);
  }
  assert.ok(sectorIds.has(n.sectorId), 'node sector ref valid');
}
assert.ok(world.nodes.some((n) => n.kind === 'cavern'), 'underground outpost caverns must exist');
assert.ok(world.nodes.some((n) => n.kind === 'shaft_head'), 'drilled shaft collars must exist');
assert.ok(world.stats.deepestTunnelZ < -100, `deepest tunnel should be > 100 m down, got ${world.stats.deepestTunnelZ}`);
console.log(`nodes=${world.nodes.length} deepestTunnelZ=${world.stats.deepestTunnelZ}`);

// Tunnels: unique ids, endpoints resolve, length consistent, kinds are real.
const tunnelKinds = new Set<TunnelKind>();
for (const t of world.tunnels) {
  tunnelKinds.add(t.kind);
  assert.ok(nodeIds.has(t.fromId) && nodeIds.has(t.toId), `tunnel ${t.id} endpoints exist`);
  const a = world.nodes.find((n) => n.id === t.fromId)!;
  const b = world.nodes.find((n) => n.id === t.toId)!;
  const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
  assert.ok(Math.abs(d - t.length) < 0.05, `tunnel ${t.id} length consistent`);
}
for (const k of ['lava_tube', 'mine_shaft', 'cavern_adit'] as TunnelKind[]) {
  assert.ok(tunnelKinds.has(k), `expected tunnel kind ${k} present`);
}
console.log('tunnel kinds:', Array.from(tunnelKinds).join(', '));

// Veins: every lore resource present, depth bands respected, host refs valid.
for (const kind of RESOURCE_KINDS) {
  assert.ok(world.stats.veins[kind] > 0, `vein kind ${kind} must be generated (got ${world.stats.veins[kind]})`);
}
for (const v of world.veins) {
  const [shallow, deep] = RESOURCE_PROFILES[v.kind].depthBand;
  assert.ok(v.center.z <= shallow && v.center.z >= deep, `vein ${v.id} (${v.kind}) z=${v.center.z} within band [${shallow}, ${deep}]`);
  assert.equal(v.remaining, v.abundance, 'fresh veins untouched at generation');
  assert.ok(v.depth >= 0, 'depth recorded below datum as positive');
  for (const hostId of v.hostNodeIds) assert.ok(nodeIds.has(hostId), 'vein host node ref valid');
  for (const hostT of v.hostTunnelIds) assert.ok(world.tunnels.some((t) => t.id === hostT), 'vein host tunnel ref valid');
}
// Water ice must show up in shadowed polar crater floors (lore anchor).
const shadowed = world.craters.filter((c) => c.permanentlyShadowed);
for (const c of shadowed) {
  const iceHere = world.veins.some(
    (v) => v.kind === 'water_ice' && Math.hypot(v.center.x - c.center.x, v.center.y - c.center.y) <= c.radius,
  );
  assert.ok(iceHere, `shadowed crater ${c.name} should host water ice`);
}
// Deep-tube ice anchor: some ice strictly underground (z <= -65).
assert.ok(
  world.veins.some((v) => v.kind === 'water_ice' && v.center.z <= -65),
  'deep cold-trap tubes must host water ice',
);
// KREEP rare earths are the deepest bodies.
const reVeins = world.veins.filter((v) => v.kind === 'rare_earth');
assert.ok(reVeins.every((v) => v.center.z <= -130), 'rare earths are deep KREEP terrane');
console.log('veins per kind:', JSON.stringify(world.stats.veins));

// ---------------------------------------------------------------------------
// 3. Graph queries — tunnels, transit, rail
// ---------------------------------------------------------------------------
section('3. tunnel / transit / rail graph');

const tubeNode = world.nodes.find((n) => n.name.startsWith('Tube Void'))!;
const neigh = genA.tunnelNeighbors(tubeNode.id);
assert.ok(neigh.length >= 1, 'tube node has tunnel neighbours');
assert.ok(
  neigh.some((m) => m.position.z < 0),
  'tube node reaches at least one subsurface void',
);
// Every neighbour must be joined by a real tunnel segment.
for (const m of neigh) {
  assert.ok(
    world.tunnels.some(
      (t) =>
        (t.fromId === tubeNode.id && t.toId === m.id) ||
        (t.toId === tubeNode.id && t.fromId === m.id),
    ),
    `neighbour ${m.name} joined by a tunnel`,
  );
}
console.log(`tunnelNeighbors(${tubeNode.name}) -> ${neigh.length} neighbours`);

// A lava tube chain gives a multi-hop tunnel-only path.
const tubeChain = world.tunnels.filter((t) => t.kind === 'lava_tube');
const first = tubeChain[0];
let last = first;
for (const t of tubeChain) if (t.id > last.id) last = t;
// Walk the chain via neighbours to reach a node >= 2 hops away.
const hop2 = genA.tunnelNeighbors(neigh[0].id).find((n) => n.id !== tubeNode.id);
assert.ok(hop2, 'tube chain has a second hop');
const tp = genA.findTunnelPath(tubeNode.id, hop2!.id);
assert.ok(tp, 'tunnel-only path exists along the chain');
assert.ok(tp!.nodeIds.length >= 3, `expected >=3 hop path, got ${tp!.nodeIds.length}`);
assert.ok(tp!.edges.every((e) => e.kind === 'tunnel'), 'tunnel path uses only tunnel edges');
assert.ok(tp!.totalLength > 0);
console.log(`findTunnelPath(${tp!.nodeIds.length} nodes, ${Math.round(tp!.totalLength)} m)`, tp!.nodeIds.join(' -> '));

// Graph is undirected: reverse path costs the same.
const tpRev = genA.findTunnelPath(hop2!.id, tubeNode.id);
assert.ok(tpRev && Math.abs(tpRev.totalLength - tp!.totalLength) < 1e-6, 'tunnel graph undirected');

// No path when the target is unknown.
assert.equal(genA.findTunnelPath(tubeNode.id, 'node-9999'), null);
assert.equal(genA.findPath(tubeNode.id, 'node-nope'), null);

// Combined transit: from a surface refinery down into the tube network.
const refinery = world.nodes.find((n) => n.kind === 'refinery')!;
const deepJunction = world.nodes
  .filter((n) => n.position.z < -80)
  .sort((a, b) => a.id.localeCompare(b.id))[0];
const transit = genA.findPath(refinery.id, deepJunction.id);
if (transit !== null) {
  assert.ok(transit.nodeIds[0] === refinery.id && transit.nodeIds.at(-1) === deepJunction.id);
  console.log(`findPath(refinery -> ${deepJunction.name}) = ${Math.round(transit.totalLength)} m`);
} else {
  console.log('(refinery → deep junction not yet connected — frontier conditions apply)');
}

// Rail: routes exist, endpoints are rail-served, rail graph answers for them.
assert.ok(world.railRoutes.length >= 4, 'expect several rail routes');
assert.ok(world.stats.railServedNodes >= 4);
for (const r of world.railRoutes) {
  assert.ok(r.nodeIds.length >= 2, `route ${r.id} has terminals`);
  assert.equal(r.gauge, 0.75, 'narrow gauge 0.75 m');
  assert.ok(r.length > 0);
  assert.ok(['surface', 'tunnel', 'mixed'].includes(r.kind));
  for (const id of r.nodeIds) assert.ok(genA.isRailServed(id), `route node ${id} rail-served`);
}
const rp = genA.findRailPath(world.railRoutes[0].nodeIds[0], world.railRoutes[0].nodeIds.at(-1)!);
assert.ok(rp, 'rail path exists along a laid route');
console.log(`railRoutes=${world.railRoutes.length} served=${world.stats.railServedNodes} sampleRoute="${world.railRoutes[0].name}" (${Math.round(world.railRoutes[0].length)} m, ${world.railRoutes[0].kind})`);

// routesForNode on a terminal.
const terminalRouteNode = world.railRoutes[0].nodeIds[0];
assert.ok(genA.routesForNode(terminalRouteNode).length >= 1);

// ---------------------------------------------------------------------------
// 4. Resource availability & extraction at depth
// ---------------------------------------------------------------------------
section('4. resource queries & extraction yields');

// Surface regolith query on the datum plain.
const surf = genA.resourceAvailable('regolith', 50, 1500, 0);
assert.ok(surf.available && surf.vein, 'regolith available at surface probe');
assert.ok(surf.vein!.center.z >= -4 && surf.vein!.center.z <= 0, 'regolith is a surface deposit');
console.log('regolith@surface ->', surf.vein!.id, 'abundance', surf.vein!.abundance);

// Deep probe: query the exact centre of a deep rare-earth vein.
const deepVein = reVeins[0];
const deepProbe = genA.resourceAvailable('rare_earth', deepVein.center.x, deepVein.center.y, deepVein.center.z);
assert.ok(deepProbe.available, 'rare earth available at its own centre, deep underground');
assert.equal(deepProbe.distanceToVein, 0);
console.log(`rare_earth@z=${Math.round(deepVein.center.z)}m ->`, deepProbe.vein!.id, 'abundance', deepProbe.vein!.abundance);

// Wrong-depth negative: helium-3 cannot exist 150 m down.
const he3Deep = genA.resourceAvailable('helium_3', deepVein.center.x, deepVein.center.y, -150);
assert.equal(he3Deep.available, false);
assert.equal(he3Deep.reason, 'wrong_depth');
// And rare earth cannot exist on the sunlit surface.
const reSurface = genA.resourceAvailable('rare_earth', deepVein.center.x, deepVein.center.y, 5);
assert.equal(reSurface.available, false);
console.log('wrong-depth guards: he3@-150m ->', he3Deep.reason, '| rare_earth@+5m ->', reSurface.reason);

// veinsInDepthWindow spans the deep crust only.
const deepWindow = genA.veinsInDepthWindow(-260, -130);
assert.ok(deepWindow.length > 0);
assert.ok(deepWindow.every((v) => v.center.z >= -260 && v.center.z <= -130));
console.log('veinsInDepthWindow(-260..-130):', deepWindow.map((v) => v.kind).join(','));

// Extraction modes: suit vs buggy vs freight on the SAME deposit.
const iceVein = world.veins.find((v) => v.kind === 'water_ice' && v.center.z <= -65)!;
const q = { x: iceVein.center.x, y: iceVein.center.y, z: iceVein.center.z };
const modes: ExtractionMode[] = ['suit', 'buggy', 'freight'];
const yields: Record<string, number> = {};
for (const mode of modes) {
  const est = genA.estimateExtraction('water_ice', q.x, q.y, q.z, mode, { drillTier: 1, scanner: true });
  yields[mode] = est.yieldUnits;
  console.log(`water_ice@${Math.round(q.z)}m [${mode}] feasible=${est.feasible} reason=${est.reason ?? '-'} yield=${est.yieldUnits.toFixed(2)} cr/cycle=${Math.round(est.creditsPerCycle)}`);
}
// Buggy rig is locked out of the deep cold traps.
assert.equal(genA.estimateExtraction('water_ice', q.x, q.y, q.z, 'buggy').feasible, false);
const buggyFail = genA.estimateExtraction('water_ice', q.x, q.y, q.z, 'buggy');
assert.ok(buggyFail.reason!.includes('buggy_rig_too_deep'));
assert.ok(MIN_BUGGY_Z < 0);
// Freight needs a rail siding within reach.
const freightEst = genA.estimateExtraction('water_ice', q.x, q.y, q.z, 'freight');
if (freightEst.feasible) {
  console.log(`(freight siding within ${FREIGHT_REACH_M} m of the deep vein — boomtown!)`);
} else {
  assert.ok(freightEst.reason!.includes('no_rail_siding'));
}
// Suit always works on an available vein; suit < buggy throughput when both work.
const suitEst = genA.estimateExtraction('water_ice', q.x, q.y, q.z, 'suit', { scanner: true });
assert.ok(suitEst.feasible && suitEst.yieldUnits > 0);

// Strict cross-rig ordering on a guaranteed-shallow deposit (regolith).
const rego = world.veins.find((v) => v.kind === 'regolith')!;
{
  const s = genA.estimateExtraction('regolith', rego.center.x, rego.center.y, rego.center.z, 'suit', { scanner: true });
  const b = genA.estimateExtraction('regolith', rego.center.x, rego.center.y, rego.center.z, 'buggy', { scanner: true });
  const f = genA.estimateExtraction('regolith', rego.center.x, rego.center.y, rego.center.z, 'freight', { scanner: true });
  assert.ok(s.feasible && b.feasible, 'surface regolith workable by suit+buggy');
  assert.ok(b.yieldUnits > s.yieldUnits, 'buggy out-digs suit');
  if (f.feasible) assert.ok(f.yieldUnits > b.yieldUnits, 'freight out-digs buggy');
  // Higher drill tier strictly improves yield on the same body.
  const t3 = genA.estimateExtraction('regolith', rego.center.x, rego.center.y, rego.center.z, 'suit', { drillTier: 3, scanner: true });
  const t0 = genA.estimateExtraction('regolith', rego.center.x, rego.center.y, rego.center.z, 'suit', { drillTier: 0, scanner: true });
  assert.ok(t3.yieldUnits > t0.yieldUnits, 'drill tier improves yield');
  console.log(`regolith yields: suit=${s.yieldUnits.toFixed(2)} buggy=${b.yieldUnits.toFixed(2)} freight=${f.feasible ? f.yieldUnits.toFixed(2) : 'no siding'}`);
}

// Titanium seams: value ordering vs regolith at the same rig.
const titaniumVein = world.veins.find((v) => v.kind === 'titanium')!;
{
  const t = genA.estimateExtraction('titanium', titaniumVein.center.x, titaniumVein.center.y, titaniumVein.center.z, 'suit', { scanner: true });
  const r = genA.estimateExtraction('regolith', rego.center.x, rego.center.y, rego.center.z, 'suit', { scanner: true });
  assert.ok(t.feasible);
  assert.ok(t.creditsPerCycle > r.creditsPerCycle, 'ilmenite beats regolith per cycle');
  if (titaniumVein.center.z < MIN_BUGGY_Z) {
    assert.equal(genA.estimateExtraction('titanium', titaniumVein.center.x, titaniumVein.center.y, titaniumVein.center.z, 'buggy').feasible, false);
  } else {
    assert.ok(
      genA.estimateExtraction('titanium', titaniumVein.center.x, titaniumVein.center.y, titaniumVein.center.z, 'buggy').feasible,
      'shallow titanium is buggy-workable',
    );
  }
}

// canExtract wrapper.
const can = genA.canExtract('water_ice', q.x, q.y, q.z, 'suit');
assert.ok(can.ok && can.estimate?.veinId === iceVein.id);
const cannot = genA.canExtract('water_ice', q.x, q.y, q.z, 'buggy');
assert.ok(!cannot.ok && cannot.reason !== undefined);

// Harvest mutates the live vein, caps at remaining, zeroes out when drained.
const drained = genA.harvest('water_ice', q.x, q.y, q.z, 1_000_000, 'suit');
assert.ok(drained.harvested === iceVein.abundance, `harvest caps at abundance (${drained.harvested} vs ${iceVein.abundance})`);
assert.equal(drained.remaining, 0);
assert.ok(drained.credits > 0);
const after = genA.resourceAvailable('water_ice', q.x, q.y, q.z);
assert.equal(after.available, false);
assert.equal(after.reason, 'depleted');
const again = genA.harvest('water_ice', q.x, q.y, q.z, 10, 'suit');
assert.equal(again.harvested, 0);
console.log(`harvest drained ${drained.harvested} units for ${drained.credits} credits; re-query -> ${after.reason}`);

// Harvest on a totally absent resource is a no-op, not a throw.
const nope = genA.harvest('helium_3', q.x, q.y, q.z, 10, 'suit');
assert.equal(nope.harvested, 0);

// Lookups by id round-trip (and are defensive copies).
const nodeCopy = genA.getNode(iceVein.hostNodeIds[0] ?? world.railRoutes[0].nodeIds[0]);
assert.ok(nodeCopy === null || nodeCopy.id.length > 0);
const veinCopy = genA.getVein(iceVein.id)!;
veinCopy.remaining = -999;
assert.notEqual(genA.getVein(iceVein.id)!.remaining, -999, 'getters return clones');

// Reset + regenerate reproduces the pristine world (compare against the
// untouched same-seed twin — genA's own digest is now dirtied by the harvest).
genA.reset();
const digestAfter = genA.digest();
assert.equal(digestAfter, genB.digest(), 'reset + regenerate reproduces identical world');
assert.equal(genA.resourceAvailable('water_ice', q.x, q.y, q.z).available, true, 'fresh world re-fills the drained vein');
console.log('reset() → identical digest, veins re-filled ✔');

// Every resource kind is queryable without throwing.
for (const kind of RESOURCE_KINDS as ResourceKind[]) {
  const r = genA.resourceAvailable(kind, 1000, 1000, -50);
  assert.ok(typeof r.available === 'boolean');
}

console.log('\nALL LUNAR WORLD SMOKE CHECKS PASSED');
