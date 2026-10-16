/**
 * Spec 26 Phase 2 verification probe: HighSpeedMaglev functional contract.
 * Run: `npx tsx scripts/smoke-high-speed-maglev.ts`  (exit code 0 == all green)
 *
 * Covers blueprint §4 gate group 2 (maglev guideway & kinematics: 3,500 m
 * Catmull-Rom arc-length evaluation, 4-car consist spacing L_car = 14 m,
 * forward orientation, steady-state 25.0 m/s cruise) plus the service-road
 * interception corridor, the NullEngine lifecycle, and the WorldScene
 * integration surface (buildHighSpeedMaglev / getHighSpeedMaglev /
 * update(dtMs) / dispose).
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { VertexBuffer } from '@babylonjs/core/Meshes/buffer.js';

import {
  HighSpeedMaglev,
  maglevTerrainElevationAt,
  GUIDEWAY_TARGET_LENGTH_M,
  DEFAULT_CRUISE_SPEED_MPS,
  DEFAULT_ACCELERATION_MPS2,
  DEFAULT_CAR_LENGTH_M,
  SERVICE_ROAD_OFFSET_M,
  PYLON_SPACING_M,
  GUIDEWAY_ELEVATION_MIN_M,
  GUIDEWAY_ELEVATION_MAX_M,
  CARRIAGE_FLOAT_M,
  SUSPENSION_BOB_M,
  MAGLEV_CAR_TYPES,
} from '../src/infrastructure/HighSpeedMaglev.ts';
import { CANYON_EXTRACTION_OUTPOST, CITADEL_DEFAULT_WORLD_CENTER } from '../src/infrastructure/XCorpCitadel.ts';
import { worldToBabylon } from '../src/engine/CameraRig.ts';
import { WorldScene } from '../src/engine/WorldScene.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(label); console.log(`  ✘ ${label} ${detail}`); }
}
const hFrame = () => 1 / 60;

// --- constants & canonical anchors -------------------------------------------
check('cruise speed 25.0 m/s', DEFAULT_CRUISE_SPEED_MPS === 25.0);
check('acceleration 2.0 m/s²', DEFAULT_ACCELERATION_MPS2 === 2.0);
check('car length 14.0 m', DEFAULT_CAR_LENGTH_M === 14.0);
check('service road offset 4.0 m', SERVICE_ROAD_OFFSET_M === 4.0);
check('pylon spacing 24 m', PYLON_SPACING_M === 24);
check('elevation band 2.5–6.0 m', GUIDEWAY_ELEVATION_MIN_M === 2.5 && GUIDEWAY_ELEVATION_MAX_M === 6.0);
check('carriage float 0.4 m', CARRIAGE_FLOAT_M === 0.4);
check('suspension bob ±0.04 m', SUSPENSION_BOB_M === 0.04);
check('target line length 3500 m', GUIDEWAY_TARGET_LENGTH_M === 3500);
check('consist order loco/vault/exec/escort', MAGLEV_CAR_TYPES.length === 4
  && MAGLEV_CAR_TYPES[0] === 'locomotive' && MAGLEV_CAR_TYPES[1] === 'vault'
  && MAGLEV_CAR_TYPES[2] === 'executive' && MAGLEV_CAR_TYPES[3] === 'escort');
check('terrain model NaN-safe', maglevTerrainElevationAt(NaN, 5) === 0
  && Number.isFinite(maglevTerrainElevationAt(1200, 800)));

// Custom options honoured (update clamps dt to 0.25 s per step).
const custom = new HighSpeedMaglev({ cruiseSpeedMps: 10, accelerationMps2: 5, carLengthM: 20 });
for (let i = 0; i < 4; i++) custom.update(0.25); // t = 1 s
const customState = custom.getTrainState();
check('custom speed ramp a·t = 5 m/s at t=1 s', customState.speedMps === 5, `${customState.speedMps}`);
check('custom consist length 4×20 = 80', customState.totalLengthM === 80);
for (let i = 0; i < 4; i++) custom.update(0.25); // t = 2 s
check('custom cruise cap caps at 10 m/s', custom.getTrainState().speedMps === 10,
  `${custom.getTrainState().speedMps}`);
// Garbage options fall back to canonical.
const junk = new HighSpeedMaglev({ cruiseSpeedMps: -1, accelerationMps2: NaN, carLengthM: 0 });
for (let i = 0; i < 4; i++) junk.update(0.25); // t = 1 s
const junkState = junk.getTrainState();
check('junk options fall back (speed 2 after 1 s)', junkState.speedMps === 2 && junkState.totalLengthM === 56,
  `${junkState.speedMps}`);

// --- scene-independent kinematics ---------------------------------------------
const m = new HighSpeedMaglev();
const total = m.getTotalSplineLengthM();
check('answers before init: total ≈ 3500 m', Math.abs(total - 3500) < 1, `${total}`);
const s0 = m.getTrainState();
check('initial speed 0', s0.speedMps === 0);
check('4 cars in state', s0.cars.length === 4);
check('car types in consist order', s0.cars.map((c) => c.type).join(',') === 'locomotive,vault,executive,escort');
check('initial s_i = 42/28/14/0 (s − i·L)', s0.cars[0]!.distanceAlongSplineM === 42
  && s0.cars[1]!.distanceAlongSplineM === 28 && s0.cars[2]!.distanceAlongSplineM === 14
  && s0.cars[3]!.distanceAlongSplineM === 0);
check('distanceToDepot = total − 42', Math.abs(s0.distanceToDepotM - (total - 42)) < 1e-9);
check('timeToDepot = d / max(v,1) at rest', s0.timeToDepotS === s0.distanceToDepotM / Math.max(s0.speedMps, 1));
check('initial car states all finite', s0.cars.every((c) =>
  [c.worldPosition.x, c.worldPosition.y, c.worldPosition.z,
    c.worldForward.x, c.worldForward.y, c.worldForward.z].every(Number.isFinite)));
check('car speedMps mirrors train speed', s0.cars.every((c) => c.speedMps === s0.speedMps));
const vault0 = m.getVaultCarState();
check('getVaultCarState is index 1 vault', vault0 !== null && vault0.index === 1 && vault0.type === 'vault');
const headBefore = m.getHeadDistanceM();
m.getTrainState(); m.getTrainState();
check('getTrainState does not advance time', m.getHeadDistanceM() === headBefore);
m.update(Number.NaN); m.update(-5); m.update(0);
check('NaN/neg/zero dt are no-ops', m.getHeadDistanceM() === headBefore && m.getTrainState().speedMps === 0);

// Velocity ramp: v(t) = a·t exactly until cruise at t = 12.5 s.
for (let i = 0; i < 60; i++) m.update(hFrame());
const v1 = m.getTrainState().speedMps;
check('v(1 s) = 2.0 m/s (linear ramp)', Math.abs(v1 - 2.0) < 1e-6, `${v1}`);
for (let i = 0; i < 240; i++) m.update(hFrame());
const v5 = m.getTrainState().speedMps;
check('v(5 s) = 10.0 m/s', Math.abs(v5 - 10.0) < 1e-5, `${v5}`);
const ttdState = m.getTrainState();
check('timeToDepot formula at v=10', ttdState.timeToDepotS === ttdState.distanceToDepotM / Math.max(ttdState.speedMps, 1));
for (let i = 0; i < 450; i++) m.update(hFrame());
const v125 = m.getTrainState().speedMps;
check('reaches cruise exactly at t = 12.5 s', v125 === 25.0, `${v125}`);
const headAtCruise = m.getHeadDistanceM();
check('ramp distance ≈ ½at² + standby (156.25+42 m)', Math.abs(headAtCruise - 198.25) < 0.6, `${headAtCruise}`);
for (let i = 0; i < 600; i++) m.update(hFrame());
const cruise = m.getTrainState();
check('cruise holds 25.0 m/s (no drift)', cruise.speedMps === 25.0);
check('cruise advanced 600 frames × dt ≈ 250 m', Math.abs(m.getHeadDistanceM() - headAtCruise - 250) < 0.1,
  `${m.getHeadDistanceM() - headAtCruise}`);
const d1 = m.getTrainState().distanceToDepotM;
m.update(hFrame());
const d2 = m.getTrainState().distanceToDepotM;
check('depot distance shrinks at v·dt', Math.abs(d1 - d2 - 25 / 60) < 1e-9, `${d1 - d2}`);
check('car spacing holds under cruise', m.getTrainState().cars[0]!.distanceAlongSplineM
  - m.getTrainState().cars[1]!.distanceAlongSplineM === 14);

// Continuous transit: the consist loops back to the outpost dock at the depot.
const m3 = new HighSpeedMaglev();
let wrapped = false;
for (let i = 0; i < 12000 && !wrapped; i++) {
  const before = m3.getHeadDistanceM();
  m3.update(hFrame());
  if (m3.getHeadDistanceM() < before - 1) wrapped = true;
}
check('reaches depot terminal and loops (continuous transit)', wrapped);
check('post-loop head back at dock window [42, 44)', (() => {
  const h = m3.getHeadDistanceM();
  return h >= 42 - 1e-9 && h < 44;
})(), `${m3.getHeadDistanceM()}`);
check('post-loop distance formula intact', Math.abs(m3.getTrainState().distanceToDepotM - (total - m3.getHeadDistanceM())) < 1e-9);
check('post-loop cruise speed preserved', m3.getTrainState().speedMps === 25.0);

// --- spline math -----------------------------------------------------------------
const p0 = m.getPointAtDistance(0);
const pE = m.getPointAtDistance(total);
check('spline starts at Canyon Extraction Outpost (1200, 800)',
  Math.abs(p0.x - CANYON_EXTRACTION_OUTPOST.x) < 1e-6 && Math.abs(p0.y - CANYON_EXTRACTION_OUTPOST.y) < 1e-6);
check('spline terminates at Citadel Grand Terminal (−1850, 2400)',
  Math.abs(pE.x - CITADEL_DEFAULT_WORLD_CENTER.x) < 1e-6 && Math.abs(pE.y - CITADEL_DEFAULT_WORLD_CENTER.y) < 1e-6);
check('out-of-range s clamps: p(−100) = p(0)', p0.x === m.getPointAtDistance(-100).x && p0.y === m.getPointAtDistance(-100).y);
check('out-of-range s clamps: p(total+100) = p(total)', pE.x === m.getPointAtDistance(total + 100).x);
check('NaN s answers p(0), forward finite', m.getPointAtDistance(NaN).x === p0.x
  && Number.isFinite(m.getForwardAtDistance(NaN).x));
{
  // Continuous arc-length evaluation: unit chord per metre of arc, unit and
  // smooth tangents, elevation inside the spec band over the whole 3.5 km.
  let maxChord = 0;
  let minClear = Infinity;
  let maxClear = -Infinity;
  let minFwdErr = 0;
  let maxTurn = 0;
  let prev = m.getPointAtDistance(0);
  let prevF = m.getForwardAtDistance(0);
  let midLateral = 0;
  for (let s = 1; s <= total; s += 1) {
    const p = m.getPointAtDistance(s);
    maxChord = Math.max(maxChord, Math.hypot(p.x - prev.x, p.y - prev.y));
    const c = p.z - maglevTerrainElevationAt(p.x, p.y);
    minClear = Math.min(minClear, c);
    maxClear = Math.max(maxClear, c);
    const f = m.getForwardAtDistance(s);
    minFwdErr = Math.max(minFwdErr, Math.abs(Math.hypot(f.x, f.y, f.z) - 1));
    maxTurn = Math.max(maxTurn, Math.acos(Math.min(1, f.x * prevF.x + f.y * prevF.y)));
    prev = p;
    prevF = f;
    if (s === Math.round(total / 2)) {
      const chordMidX = (p0.x + pE.x) / 2;
      const chordMidY = (p0.y + pE.y) / 2;
      midLateral = Math.hypot(p.x - chordMidX, p.y - chordMidY);
    }
  }
  check('chord ≤ 1.005 m per 1 m of arc (arc-length parameterized)', maxChord < 1.005, `${maxChord}`);
  check('forward tangent unit over full line', minFwdErr < 1e-9, `${minFwdErr}`);
  check('forward tangent continuous (< 0.05 rad / m)', maxTurn < 0.05, `${maxTurn}`);
  check('guideway elevation inside 2.5–6.0 m band', minClear >= 2.5 - 1e-6 && maxClear <= 6.0 + 1e-6,
    `${minClear}..${maxClear}`);
  check('elevation band actually traversed (swell 2.5→6.0)', minClear < 2.5001 && maxClear > 5.9999);
  check('clearance query matches deck elevation exactly',
    Math.abs(m.getGuidewayClearanceAtDistance(1234.5)
      - (m.getPointAtDistance(1234.5).z - maglevTerrainElevationAt(m.getPointAtDistance(1234.5).x, m.getPointAtDistance(1234.5).y))) < 1e-9);
  check('guideway meanders through the badlands (> 10 m off chord mid)', midLateral > 10, `${midLateral}`);
}

// --- headless build (NullEngine) ---------------------------------------------------
const engine = new NullEngine();
const scene = new Scene(engine);
const built = new HighSpeedMaglev().init(scene);
check('isBuilt after init', built.isBuilt());
check('idempotent init', built.init(scene) === built);
const meshes = built.getMeshes();
check('meshes built (> 150)', meshes.length > 150, `${meshes.length}`);
const parts = ['pylon', 'deck', 'stator_rail', 'road', 'terminal_pad', 'locomotive', 'vault',
  'executive', 'escort', 'coupler', 'catwalk', 'vault_container', 'vault_lock', 'glass',
  'interior', 'searchlight', 'drone', 'dish', 'trim', 'barcode'];
for (const p of parts) {
  check(`part '${p}' present`, built.getPartMeshes(p).length > 0, `${built.getPartMeshes(p).length}`);
}
check('coupler triple (3 articulation links)', built.getPartMeshes('coupler').length === 3);
check('single roof Cyber-Lock vault + lock', built.getPartMeshes('vault_container').length === 1
  && built.getPartMeshes('vault_lock').length === 1);
check('catwalk furniture: 2 walks + 2 rails + 6 posts', built.getPartMeshes('catwalk').length === 10);
const pylons = built.getPartMeshes('pylon').filter((mesh) => mesh.name.includes('pylon-') && !mesh.name.includes('cap'));
check('pylons every ~24 m (145 on 3.5 km)', pylons.length >= 144 && pylons.length <= 146, `${pylons.length}`);
{
  // Every pylon stands under the guideway centreline.
  const samples: { x: number; y: number }[] = [];
  for (let s = 0; s <= total; s += 6) samples.push(m.getPointAtDistance(s));
  let maxOff = 0;
  for (const pylon of pylons) {
    const ap = pylon.getAbsolutePosition();
    let best = Infinity;
    for (const sp of samples) best = Math.min(best, Math.hypot(ap.x - sp.x, -ap.z - sp.y));
    maxOff = Math.max(maxOff, best);
  }
  check('pylons under the guideway (< 5 m)', maxOff < 5, `${maxOff}`);
  // Consecutive pylon spacing reads ~24 m horizontally.
  const sorted = [...pylons].sort((a, b) => {
    const sa = Number(a.name.split('-').pop());
    const sb = Number(b.name.split('-').pop());
    return sa - sb;
  });
  let spacingOk = sorted.length > 140;
  for (let i = 1; i < Math.min(sorted.length, 60); i++) {
    const a = sorted[i - 1]!.getAbsolutePosition();
    const b = sorted[i]!.getAbsolutePosition();
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < 23.5 || d > 24.05) spacingOk = false;
  }
  check('consecutive pylon spacing ≈ 24 m', spacingOk);
}
{
  // Stator rails carry the animated chevron vertex-colour wave.
  const rails = built.getPartMeshes('stator_rail');
  const colorData = rails.map((r) => r.getVerticesData(VertexBuffer.ColorKind));
  check('twin stator rails with chevron vertex colours', rails.length === 2
    && colorData.every((c) => c != null && c.length > 8 * 100), `${rails.length}`);
  const snap = Array.from(colorData[0]!);
  for (let i = 0; i < 30; i++) built.update(hFrame());
  const after = built.getPartMeshes('stator_rail')[0]!.getVerticesData(VertexBuffer.ColorKind)!;
  let changed = false;
  for (let i = 0; i < after.length; i += 4) if (Math.abs(after[i]! - snap[i]!) > 1e-4) { changed = true; break; }
  check('chevron chevrons pulse over time', changed);
  let minR = 1;
  for (let i = 0; i < after.length; i += 4) minR = Math.min(minR, after[i]!);
  check('chevron crest/valley contrast present', minR < 0.5, `${minR}`);
}
const casters = built.getShadowCasterMeshes();
const thin = meshes.filter((mesh) => {
  const part = mesh.metadata?.part as string | undefined;
  return part === 'deck' || part === 'stator_rail' || part === 'road';
}).length;
check('shadow casters exclude paper-thin ribbons', casters.length === meshes.length - thin
  && !casters.some((cm) => {
    const part = cm.metadata?.part as string | undefined;
    return part === 'deck' || part === 'stator_rail' || part === 'road';
  }));
const root = built.getRootNode();
check('system root at origin (absolute spline coords)', root !== null
  && Math.abs(root.position.x) < 1e-9 && Math.abs(root.position.y) < 1e-9 && Math.abs(root.position.z) < 1e-9);

// --- consist follows the spline -----------------------------------------------------
for (let i = 0; i < 750; i++) built.update(hFrame()); // ramp to cruise
const cruiseState = built.getTrainState();
check('built consist reached cruise 25 m/s', cruiseState.speedMps === 25.0);
{
  // Every car root sits on the state position (±bob) and points along the tangent.
  const state = built.getTrainState();
  const sysRoot = built.getRootNode();
  const roots = sysRoot !== null ? sysRoot.getChildTransformNodes(true) : [];
  let posOk = true;
  let orientOk = true;
  for (let i = 0; i < state.cars.length; i++) {
    const car = state.cars[i]!;
    const node = roots.find((n) => n.name.includes(car.type));
    if (node === undefined) { posOk = false; orientOk = false; break; }
    const ap = node.getAbsolutePosition();
    const want = worldToBabylon(car.worldPosition);
    if (Math.abs(ap.x - want.x) > 1e-3 || Math.abs(ap.z - want.z) > 1e-3) posOk = false;
    if (Math.abs(ap.y - (want.y + CARRIAGE_FLOAT_M)) > SUSPENSION_BOB_M + 0.005) posOk = false;
    const fwd = car.worldForward;
    const local = new Vector3(fwd.x, fwd.z, -fwd.y);
    const len = Math.hypot(local.x, local.y, local.z);
    const rotated = Vector3.TransformNormal(new Vector3(0, 0, 1), node.getWorldMatrix());
    const dot = (rotated.x * local.x + rotated.y * local.y + rotated.z * local.z) / (len || 1);
    if (dot < 0.999) orientOk = false;
  }
  check('car roots sit on spline positions (±bob)', posOk);
  check('car roots oriented with local forward tangent', orientOk);
}
{
  // Vault car tracking: one cruise second ≈ 25 m of ground covered.
  const vA = built.getVaultCarState()!;
  for (let i = 0; i < 60; i++) built.update(hFrame());
  const vB = built.getVaultCarState()!;
  const moved = Math.hypot(vB.worldPosition.x - vA.worldPosition.x, vB.worldPosition.y - vA.worldPosition.y);
  check('vault car tracks the train at 25 m/s', moved > 24 && moved < 25.5, `${moved}`);
  check('vault distance advances 25 m over a cruise second', Math.abs(vB.distanceAlongSplineM - vA.distanceAlongSplineM - 25) < 1e-6,
    `${vB.distanceAlongSplineM - vA.distanceAlongSplineM}`);
}
{
  // getVaultCarTransform: Babylon-space anchor for Phase 3 reparenting.
  const t = built.getVaultCarTransform();
  const vs = built.getVaultCarState()!;
  const want = worldToBabylon(vs.worldPosition);
  check('vault transform x/z match state', Math.abs(t.position.x - want.x) < 1e-3 && Math.abs(t.position.z - want.z) < 1e-3);
  check('vault transform floats 0.4 m ± bob',
    t.position.y >= want.y + CARRIAGE_FLOAT_M - SUSPENSION_BOB_M - 0.001
    && t.position.y <= want.y + CARRIAGE_FLOAT_M + SUSPENSION_BOB_M + 0.001);
  check('vault transform quaternion unit', Math.abs(t.rotationQuaternion.length() - 1) < 1e-6);
  check('getVaultCarNode live node', built.getVaultCarNode() !== null
    && built.getVaultCarNode()!.name.includes('vault'));
}
// Pre-init vault transform answers from pure math (no scene).
const preTransform = m.getVaultCarTransform();
check('pre-init vault transform answers', Number.isFinite(preTransform.position.x)
  && Math.abs(preTransform.rotationQuaternion.length() - 1) < 1e-6);

// --- service road (rover interception corridor) ---------------------------------------
for (const s of [50, 900, 1750, 2600, 3450]) {
  const road = m.getServiceRoadPointAtDistance(s);
  const track = m.getPointAtDistance(s);
  const lat = Math.hypot(road.x - track.x, road.y - track.y);
  check(`service road ${s} m: lateral offset exactly 4.0 m`, Math.abs(lat - SERVICE_ROAD_OFFSET_M) < 1e-6, `${lat}`);
}
{
  const s = 1234;
  const road = m.getServiceRoadPointAtDistance(s);
  const f = m.getForwardAtDistance(s);
  // Starboard = right of heading: offset vector parallel to r̂ = (fy, −fx).
  const rx = road.x - m.getPointAtDistance(s).x;
  const ry = road.y - m.getPointAtDistance(s).y;
  const rLen = Math.hypot(f.y, -f.x);
  const dot = (rx * f.y + ry * -f.x) / rLen;
  check('service road on the STARBOARD side', dot > 3.9, `${dot}`);
  check('road forward mirrors guideway tangent', road.forward.x === f.x && road.forward.y === f.y && road.forward.z === f.z);
  check('road crown +0.15 m over terrain', Math.abs(road.z - (maglevTerrainElevationAt(road.x, road.y) + 0.15)) < 1e-9);
  const nanRoad = m.getServiceRoadPointAtDistance(NaN);
  check('NaN s road answer finite', Number.isFinite(nanRoad.x) && Number.isFinite(nanRoad.z));
  let belowDeck = true;
  for (let ss = 0; ss <= total; ss += 100) {
    const r = m.getServiceRoadPointAtDistance(ss);
    const t2 = m.getPointAtDistance(ss);
    if (r.z >= t2.z) belowDeck = false;
  }
  check('road runs below the elevated deck the whole line', belowDeck);
}

// --- dispose -----------------------------------------------------------------------------
built.dispose();
check('isBuilt false after dispose', !built.isBuilt());
check('idempotent dispose', (built.dispose(), true));
check('meshes empty after dispose', built.getMeshes().length === 0);
check('root null after dispose', built.getRootNode() === null);
check('vault node null after dispose', built.getVaultCarNode() === null);
check('part/shadow queries answer empty after dispose', built.getPartMeshes('vault').length === 0
  && built.getShadowCasterMeshes().length === 0);
{
  // Kinematics keep running headless-without-meshes: Phase 3 can query a
  // disposed instance mid-heist without a throw.
  const st = built.update(hFrame());
  check('update after dispose still answers (speed preserved)', st.speedMps === 25.0 && Number.isFinite(st.distanceToDepotM));
  check('spline query after dispose', Number.isFinite(built.getPointAtDistance(100).x));
  check('service road query after dispose', Number.isFinite(built.getServiceRoadPointAtDistance(100).z));
}
let threw = false;
try { built.init(scene); } catch { threw = true; }
check('init after dispose refuses', threw);

// NullEngine fallback with NO scene argument at all.
const fallback = new HighSpeedMaglev();
fallback.init();
check('NullEngine fallback init() with no args', fallback.isBuilt() && fallback.getMeshes().length > 150);
fallback.dispose();
// Raw shared engine argument (wraps its own Scene, never owns the engine).
const engineWrapped = new HighSpeedMaglev();
engineWrapped.init(engine);
check('raw-engine init wraps a Scene', engineWrapped.isBuilt() && engineWrapped.getMeshes().length > 150);
engineWrapped.dispose();
check('shared engine still usable after wrapped dispose', new HighSpeedMaglev().init(engine).isBuilt());

// --- WorldScene integration ----------------------------------------------------------------
const world = new WorldScene({ seed: 'gilded-serpent-26' });
world.init(new NullEngine());
check('no maglev before build', world.getHighSpeedMaglev() === null);
const wsMaglev = world.buildHighSpeedMaglev();
check('buildHighSpeedMaglev returns system', wsMaglev.isBuilt());
check('getHighSpeedMaglev returns built system', world.getHighSpeedMaglev() === wsMaglev);
check('buildHighSpeedMaglev idempotent', world.buildHighSpeedMaglev() === wsMaglev);
check('system root parented under world-root', wsMaglev.getRootNode()?.parent?.name === 'world-root');
{
  const before = wsMaglev.getHeadDistanceM();
  const noCitadel = world.update(1000 / 60, { x: 0, y: 0, z: 0 });
  for (let i = 0; i < 10; i++) world.update(1000 / 60, { x: 0, y: 0, z: 0 });
  const after = wsMaglev.getHeadDistanceM();
  check('WorldScene.update drives the maglev', after > before, `${before} → ${after}`);
  check('WorldScene.update returns null without citadel', noCitadel === null);
  const wsCitadel = world.buildXCorpCitadel();
  const both = world.update(1000 / 60, { x: CITADEL_DEFAULT_WORLD_CENTER.x + 210, y: CITADEL_DEFAULT_WORLD_CENTER.y, z: 0 });
  check('maglev + citadel coexist: perimeter answers', both !== null && both.inShieldPerimeter === true);
  void wsCitadel;
  world.render(); // must not throw with maglev + citadel present
  check('render() with maglev built', true);
}
world.dispose();
check('maglev nulled after world dispose', world.getHighSpeedMaglev() === null);
check('update after world dispose returns null', world.update(16.7, { x: 0, y: 0, z: 0 }) === null);

// Verdict
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`FAILURES: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('ALL CHECKS GREEN');
process.exit(0);
