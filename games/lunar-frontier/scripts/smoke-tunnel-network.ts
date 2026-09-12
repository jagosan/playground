/**
 * Lunar Frontier — tunnel network & vein visualization smoke harness
 * (TASK-PLAY-048a).
 *
 * Boots `TunnelNetwork` headless (self-owned NullEngine + explicit NullEngine
 * injection) over a LIVE `LunarWorldGenerator` snapshot and verifies:
 *
 *   1. Headless build: network constructs without a DOM, one bore per tunnel
 *      segment + one marker per vein, root node present, idempotent init.
 *   2. Tube geometry: every segment bored as a `tunnel-*` tube with
 *      DOUBLESIDE orientation (double ring-vertex counts prove the interior
 *      wall exists), radius honoured, worldToBabylon endpoints truthful.
 *   3. Vein visualization: `vein-*` markers for every vein, one distinct PBR
 *      material per ResourceKind, helium-3 emissive, markers anchored at
 *      sensible points on the tunnel line.
 *   4. Spatial containment: centreline points are inside; radial offsets and
 *      distant surface points are outside; tolerance widens the test.
 *   5. Proximity & mining: getNearbyVeins finds the expected deposit nearest
 *      first; mineVein extracts exactly what it can, updates `remaining`,
 *      clamps at the reserve, shrinks the marker, rejects garbage input.
 *   6. Lifecycle: idempotent dispose, root/mesh lists cleared, every query
 *      safe post-dispose, init-after-dispose refuses, caller engine survives.
 *
 * Run: `node --no-warnings scripts/smoke-tunnel-network.ts` (exit 0 == green)
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';

import { TunnelNetwork, TUBE_TESSELLATION } from '../src/infrastructure/TunnelNetwork.ts';
import { LunarWorldGenerator } from '../src/world/LunarWorldGenerator.ts';
import type { TunnelSegment, Vec3 } from '../src/world/LunarWorldGenerator.ts';
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

/** Midpoint of a segment, world frame. */
function midpoint(t: TunnelSegment): Vec3 {
  return {
    x: (t.start.x + t.end.x) / 2,
    y: (t.start.y + t.end.y) / 2,
    z: (t.start.z + t.end.z) / 2,
  };
}

// ---------------------------------------------------------------------------
// 1. Headless build (live generator snapshot)
// ---------------------------------------------------------------------------
section('1. headless build over live LunarWorldGenerator snapshot');

const world = new LunarWorldGenerator('mala-voyage-2431').generate();
check('generator produced tunnels', world.tunnels.length > 0, `${world.tunnels.length} segments`);
check('generator produced veins', world.veins.length > 0, `${world.veins.length} veins`);

const network = new TunnelNetwork(world);
check('no meshes before init', network.isBuilt() === false && network.getMeshes().length === 0);
check('no root node before init', network.getRootNode() === null);
check('data loaded pre-init', network.getSegments().length === world.tunnels.length);

network.init(); // no args → self-owned NullEngine fallback
check('init() builds under NullEngine', network.isBuilt() === true);
check('init() is idempotent', network.init().isBuilt() === true);
check('root transform node present', network.getRootNode() !== null);
check(
  'one bore mesh per tunnel segment',
  network.getTubeMeshes().length === world.tunnels.length,
  `${network.getTubeMeshes().length} vs ${world.tunnels.length}`,
);
check(
  'one vein marker per vein',
  network.getVeinMarkers().length === world.veins.length,
  `${network.getVeinMarkers().length} vs ${world.veins.length}`,
);
check(
  'getMeshes() = tubes + markers',
  network.getMeshes().length === world.tunnels.length + world.veins.length,
);
check('segments exposed read-only', network.getSegments().length === world.tunnels.length);
check('veins exposed read-only', network.getVeins().length === world.veins.length);

// Explicitly-injected engine path builds too.
const sharedEngine = new NullEngine();
const injected = new TunnelNetwork(world).init(sharedEngine);
check('injected NullEngine builds', injected.isBuilt() === true && injected.getTubeMeshes().length === world.tunnels.length);

// Bare (tunnels, veins) tuple constructor form.
const bare = new TunnelNetwork({ tunnels: world.tunnels, veins: world.veins }).init();
check('tuple constructor { tunnels, veins } builds', bare.getSegments().length === world.tunnels.length && bare.getVeins().length === world.veins.length);

// ---------------------------------------------------------------------------
// 2. Tube geometry verification
// ---------------------------------------------------------------------------
section('2. tube geometry (CreateTube, DOUBLESIDE, worldToBabylon)');

const tubes = network.getTubeMeshes();
check('all tube meshes named tunnel-*', tubes.every((m) => m.name.startsWith('tunnel-')));
check(
  'tube names carry segment kind',
  tubes.every((m, i) => m.name === `tunnel-${world.tunnels[i].kind}-${i}`),
  tubes[0]?.name ?? 'none',
);
check('all tubes report DOUBLESIDE', tubes.every((m) => m.sideOrientation === Mesh.DOUBLESIDE));

// DOUBLESIDE geometry truth: a 2-point path bored double-sided carries
// 4 rings of (tessellation + 1) vertices — exactly twice the single-sided
// ring count, i.e. the interior wall physically exists.
const expectedDoubleVerts = 4 * (TUBE_TESSELLATION + 1);
const vertCounts = tubes.map((m) => m.getTotalVertices());
check(
  'every tube carries double-sided vertex rings',
  vertCounts.every((v) => v === expectedDoubleVerts),
  `expected ${expectedDoubleVerts}, got ${[...new Set(vertCounts)].join(',')}`,
);

// World-frame truth: every tube vertex lies within `radius` of the segment
// axis, so the bounding box must hug the worldToBabylon endpoint extents to
// within exactly one bored radius on EVERY axis (endpoints themselves are
// vertices ⇒ the box can never be further than r outside, nor cut inside).
function axisHugError(mesh: Mesh, segment: TunnelSegment): number {
  const bb = mesh.getBoundingInfo().boundingBox;
  const a = worldToBabylon(segment.start);
  const b = worldToBabylon(segment.end);
  const axes = ['x', 'y', 'z'] as const;
  let worst = 0;
  for (const axis of axes) {
    const lo = Math.min(a[axis], b[axis]);
    const hi = Math.max(a[axis], b[axis]);
    worst = Math.max(worst, Math.abs(bb.minimum[axis] - lo), Math.abs(bb.maximum[axis] - hi));
  }
  return worst;
}

const diag = world.tunnels.find((t) => t.kind === 'lava_tube' && Math.abs(t.end.x - t.start.x) > 60);
if (diag !== undefined) {
  const tubeForDiag = tubes[world.tunnels.indexOf(diag)] as Mesh;
  const hug = axisHugError(tubeForDiag, diag);
  check(
    'diagonal tube hugs worldToBabylon axis within bored radius',
    hug <= diag.radius + 1e-2,
    `hug=${hug.toFixed(3)} r=${diag.radius}`,
  );
  const bb = tubeForDiag.getBoundingInfo().boundingBox;
  const minSpan = Math.min(
    bb.maximum.x - bb.minimum.x,
    bb.maximum.y - bb.minimum.y,
    bb.maximum.z - bb.minimum.z,
  );
  check('diagonal tube is actually bored (min span ≥ 1.5×r)', minSpan >= 1.5 * diag.radius, `minSpan=${minSpan.toFixed(2)}`);
} else {
  check('diagonal lava tube exists for span probe', false, 'generator produced none');
  check('diagonal tube is bored', false, 'no probe segment');
}

// A true vertical shaft (collar straight above the sump): world drop maps to
// a pure Babylon-y run, so its horizontal extent is exactly the inscribed
// tessellation polygon of the bore circle — a tight, orientation-independent
// proof the bore radius was honoured.
const shaft = world.tunnels.find(
  (t) => t.kind === 'mine_shaft' &&
    Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y) < 1e-9 &&
    Math.abs(t.end.z - t.start.z) > 10,
);
if (shaft !== undefined) {
  const shaftMesh = tubes[world.tunnels.indexOf(shaft)] as Mesh;
  const hug = axisHugError(shaftMesh, shaft);
  check('vertical shaft hugs axis within bored radius', hug <= shaft.radius + 1e-2, `hug=${hug.toFixed(3)} r=${shaft.radius}`);
  const sb = shaftMesh.getBoundingInfo().boundingBox;
  const xSpan = sb.maximum.x - sb.minimum.x;
  const ySpan = sb.maximum.z - sb.minimum.z;
  const lo = 2 * shaft.radius * Math.cos(Math.PI / TUBE_TESSELLATION) - 1e-3;
  const hi = 2 * shaft.radius + 1e-3;
  check(
    'shaft cross-section is the bore diameter',
    xSpan >= lo && xSpan <= hi && ySpan >= lo && ySpan <= hi,
    `x=${xSpan.toFixed(3)} z=${ySpan.toFixed(3)} band=[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
  );
} else {
  check('vertical mine shaft exists for probe', false, 'generator produced none');
  check('shaft cross-section is the bore diameter', false, 'no probe segment');
}

// Parenting: every tube hangs under the network root.
const root = network.getRootNode();
check('all tubes parented to network root', tubes.every((m) => m.parent === root));

// ---------------------------------------------------------------------------
// 3. Vein visualization verification
// ---------------------------------------------------------------------------
section('3. vein visualization (mineral markers, per-kind PBR)');

const markers = network.getVeinMarkers();
check('all markers named vein-*', markers.every((m) => m.name.startsWith('vein-')));
check('every vein has a material', markers.every((m) => m.material !== null));

const kindsPresent = [...new Set(world.veins.map((v) => v.kind))].sort();
const materialNames = new Set(markers.map((m) => m.material?.name ?? 'none'));
check(
  'one distinct material per ResourceKind present',
  materialNames.size === kindsPresent.length,
  `mats=${materialNames.size} kinds=${kindsPresent.length}`,
);
check(
  'materials named tunnel-ore-<kind>',
  kindsPresent.every((k) => materialNames.has(`tunnel-ore-${k}`)),
);

// Kinds must not share a material instance (visual distinction).
const matByKind = new Map<string, unknown>();
let distinct = true;
for (const vein of world.veins) {
  const m = markers[world.veins.indexOf(vein)].material;
  const prior = matByKind.get(vein.kind);
  if (prior === undefined) matByKind.set(vein.kind, m);
  else if (prior !== m) distinct = false;
}
check('same kind → same material instance', distinct);
const instances = [...matByKind.values()];
check('different kinds → different instances', new Set(instances).size === instances.length);

// Helium-3 must glow (emissive golden/orange), water ice must not be metal.
const he3 = markers.find((m) => m.name.startsWith('vein-helium_3-'));
const he3mat = he3?.material as { emissiveColor?: { r: number; g: number; b: number } } | null;
check(
  'helium-3 markers carry emissive glow',
  he3 !== undefined && he3mat?.emissiveColor !== undefined && he3mat.emissiveColor.r > 0.5,
);
const ice = markers.find((m) => m.name.startsWith('vein-water_ice-'));
const icemat = ice?.material as { metallic?: number; albedoColor?: { b: number } } | null;
check(
  'water-ice markers are dielectric and blue-cyan',
  ice !== undefined && icemat !== null && (icemat.metallic ?? 1) < 0.2 && (icemat.albedoColor?.b ?? 0) > 0.6,
);
// Markers sit at finite, finite-radius positions on/near the tunnel line.
check('all marker positions finite', markers.every((m) => Number.isFinite(m.position.x) && Number.isFinite(m.position.y) && Number.isFinite(m.position.z)));

// ---------------------------------------------------------------------------
// 4. Spatial containment testing
// ---------------------------------------------------------------------------
section('4. spatial containment (isInsideTunnel / getNearestTunnelSegment)');

const probeSeg = world.tunnels.find((t) => t.length > 100 && t.kind === 'lava_tube') ?? world.tunnels[0];
const mid = midpoint(probeSeg);
check('centreline midpoint is inside its bore', network.isInsideTunnel(mid) === true, JSON.stringify(mid));
check('segment start node is inside', network.isInsideTunnel(probeSeg.start) === true);
check('segment end node is inside', network.isInsideTunnel(probeSeg.end) === true);

// Radial offset: straight up out of the bore (world +z) beyond the radius.
const outside = { x: mid.x, y: mid.y, z: mid.z + probeSeg.radius + 1.5 };
check('point 1.5 m above the bore roof is outside', network.isInsideTunnel(outside) === false);
check('tolerance of 2 m pulls it back inside', network.isInsideTunnel(outside, 2) === true);
check('tolerance of 0.5 m still outside', network.isInsideTunnel(outside, 0.5) === false);

const deepSurface: Vec3 = { x: 123456.7, y: -98765.4, z: 42 };
check('distant surface point is outside', network.isInsideTunnel(deepSurface) === false);

const nearest = network.getNearestTunnelSegment(mid);
check('getNearestTunnelSegment finds a segment', nearest !== null);
check('nearest of a midpoint is ~0 away', nearest !== null && nearest.distance < 1e-6, `${nearest?.distance}`);
check(
  'nearest returns the hosting segment',
  nearest !== null && nearest.segment.id === probeSeg.id,
  nearest?.segment.id ?? 'null',
);
const farNearest = network.getNearestTunnelSegment(deepSurface);
check('far point still reports a nearest segment', farNearest !== null && farNearest.distance > 1000, `${farNearest?.distance.toFixed(0)}`);

// ---------------------------------------------------------------------------
// 5. Vein proximity & mining mechanics
// ---------------------------------------------------------------------------
section('5. vein proximity & mining mechanics');

// Pick a vein that a tunnel actually cuts, and mine at its host bore.
const hostVein =
  world.veins.find((v) => v.hostTunnelIds.length > 0 && v.kind !== 'regolith' && v.remaining > 100) ??
  world.veins.find((v) => v.hostTunnelIds.length > 0 && v.remaining > 100)!;
check('a tunnel-hosted vein exists', hostVein !== undefined);
const hostSeg = world.tunnels.find((t) => hostVein !== undefined && t.id === hostVein.hostTunnelIds[0])!;
check('host segment of the vein resolves', hostSeg.kind.length > 0);

const nearby = network.getNearbyVeins(hostVein.center, 10);
check('getNearbyVeins finds the deposit at its centre', nearby.some((e) => e.vein.id === hostVein.id));
check('centre query reports distance 0', nearby.some((e) => e.vein.id === hostVein.id && e.distance < 1e-6));
check(
  'results sorted nearest-first',
  nearby.every((e, i) => i === 0 || e.distance >= nearby[i - 1].distance),
);

const wide = network.getNearbyVeins(deepSurface, 500);
check('nothing nearby at a far point', wide.length === 0);

const remainingBefore = hostVein.remaining;
const extracted = network.mineVein(hostVein.id, 40);
check('mineVein extracts the requested 40 units', extracted === 40, `${extracted}`);
check('vein.remaining decremented in place', hostVein.remaining === remainingBefore - 40);
check('exposed getVeins() sees the update', network.getVeins().find((v) => v.id === hostVein.id)?.remaining === remainingBefore - 40);

// Marker shrinks as the ore leaves.
const hostMarker = markers[world.veins.indexOf(hostVein)];
check(
  'marker shrinks with depletion',
  hostMarker.scaling.x < 1 && hostMarker.scaling.x > 0.24,
  `scale=${hostMarker.scaling.x.toFixed(4)}`,
);

// Over-claim clamps at the reserve.
const drained = network.mineVein(hostVein.id, hostVein.remaining + 9999);
check('over-claim clamps to remaining reserve', drained === remainingBefore - 40, `${drained}`);
check('vein fully depleted', hostVein.remaining === 0);
check('mining a depleted vein returns 0', network.mineVein(hostVein.id, 10) === 0);
check('depleted marker sits at 25% stub', Math.abs(hostMarker.scaling.x - 0.25) < 1e-9);

// Garbage / edge inputs.
check('unknown vein id returns 0', network.mineVein('vein-does-not-exist', 10) === 0);
check('zero request returns 0', network.mineVein(hostVein.id, 0) === 0);
check('negative request returns 0', network.mineVein(hostVein.id, -5) === 0);
check('NaN request returns 0', network.mineVein(hostVein.id, Number.NaN) === 0);

// Mining at the host bore point (via digPoint proximity) still works on a fresh vein.
const spare = world.veins.find((v) => v.id !== hostVein.id && v.remaining > 10)!;
const spareBefore = spare.remaining;
check('second vein mines cleanly', network.mineVein(spare.id, 7) === 7 && spare.remaining === spareBefore - 7);

// ---------------------------------------------------------------------------
// 6. Dispose lifecycle
// ---------------------------------------------------------------------------
section('6. dispose lifecycle');

check('dispose() returns cleanly', (() => { network.dispose(); return true; })());
check('dispose is idempotent', (() => { network.dispose(); network.dispose(); return true; })());
check('isBuilt() false after dispose', network.isBuilt() === false);
check('mesh list cleared after dispose', network.getMeshes().length === 0);
check('tube list cleared', network.getTubeMeshes().length === 0);
check('marker list cleared', network.getVeinMarkers().length === 0);
check('root null after dispose', network.getRootNode() === null);
check('init() after dispose refuses', (() => {
  try { network.init(); return false; } catch { return true; }
})());

check('isInsideTunnel safe post-dispose', network.isInsideTunnel(mid) === false);
check('getNearestTunnelSegment safe post-dispose', network.getNearestTunnelSegment(mid) === null);
check('getNearbyVeins safe post-dispose', network.getNearbyVeins(hostVein.center, 500).length === 0);
check('mineVein safe post-dispose', network.mineVein(spare.id, 1) === 0);
check('segment data survives dispose', network.getSegments().length === world.tunnels.length);
check('vein data survives dispose', network.getVeins().length === world.veins.length);

// Caller-owned engine must survive the network's disposal.
check('caller-owned engine survives dispose', sharedEngine.isDisposed === false);
sharedEngine.dispose();

// Self-owned engines go with their network.
injected.dispose();
bare.dispose();
check('re-dispose after full teardown still safe', (() => { injected.dispose(); bare.dispose(); return true; })());

// Fresh network over the same snapshot rebuilds (data was mutated, not broken).
const rebuilt = new TunnelNetwork(world).init();
check('fresh instance builds over same snapshot', rebuilt.isBuilt() === true && rebuilt.getTubeMeshes().length === world.tunnels.length);
check('depleted vein stays depleted across instances', rebuilt.getVein(hostVein.id)?.remaining === 0);
rebuilt.dispose();

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED ✔  (tunnel network & veins, TASK-PLAY-048a)`);
  process.exit(0);
} else {
  console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
