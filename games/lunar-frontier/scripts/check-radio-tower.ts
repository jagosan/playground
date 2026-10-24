/**
 * Spec 29 Phase 1 verification: RadioTower mathematical foundation + procedural
 * NullEngine assembly quick-check.
 * Run: `npx tsx scripts/check-radio-tower.ts`  (exit code 0 == all green)
 *
 * Covers blueprint §4 gate groups 1-2 (structural assembly & memory safety,
 * mathematical ladder invariants) ahead of the full Phase 6 smoke suite.
 * No top-level await (tsx CJS); everything here is synchronous.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';

import {
  RadioTower,
  RADIO_TOWER_DEFAULTS,
  RADIO_TOWER_NAME_PREFIX,
  LADDER_RUNG_PITCH_M,
  LADDER_RUNG_WIDTH_M,
  LADDER_PROTRUSION_M,
  LADDER_BODY_OFFSET_M,
  CLIMB_ENVELOPE_RADIUS_M,
  HATCH_SIZE_M,
  RED_BEACON_PULSE_HZ,
  WHITE_STROBE_FLASH_HZ,
} from '../src/infrastructure/RadioTower.ts';
import { worldToBabylon } from '../src/engine/CameraRig.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(label); console.log(`  ✘ ${label} ${detail}`); }
}
function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

const D = RADIO_TOWER_DEFAULTS;
const NX = Math.cos(D.ladderFacingRad); // +0.7071 (south-east)
const NY = Math.sin(D.ladderFacingRad); // -0.7071

// --- 1. contracts & defaults (scene-independent) ------------------------------
console.log('\n[1] Contracts & defaults');
check('RADIO_TOWER_DEFAULTS frozen', Object.isFrozen(D) && Object.isFrozen(D.worldPosition) && Object.isFrozen(D.beaconColor));
check('canonical seat (-1550, 2320, 0)', D.worldPosition.x === -1550 && D.worldPosition.y === 2320 && D.worldPosition.z === 0);
check('heights 52 / deck 48 / base 6 / top 2.2',
  D.towerHeightM === 52 && D.deckElevationM === 48 && D.baseWidthM === 6 && D.topWidthM === 2.2);
check('facing -PI/4 (normal +x,-y)', near(NX, Math.SQRT2 / 2) && near(NY, -Math.SQRT2 / 2));
check('beaconColor (1, 0.15, 0.1)', D.beaconColor.r === 1 && D.beaconColor.g === 0.15 && D.beaconColor.b === 0.1);
check('rung constants 0.35 pitch / 0.60 width', LADDER_RUNG_PITCH_M === 0.35 && LADDER_RUNG_WIDTH_M === 0.6);
check('0.25 m protrusion + 0.30 m body offset', LADDER_PROTRUSION_M === 0.25 && LADDER_BODY_OFFSET_M === 0.3);
check('climb envelope radius 1.0, hatch 0.9', CLIMB_ENVELOPE_RADIUS_M === 1.0 && HATCH_SIZE_M === 0.9);
check('strobe law frequencies 0.85 / 0.5 Hz', RED_BEACON_PULSE_HZ === 0.85 && WHITE_STROBE_FLASH_HZ === 0.5);

const tower = new RadioTower();
const wpn = tower.getWorldPosition();
check('getWorldPosition copy', wpn.x === -1550 && wpn.y === 2320 && wpn.z === 0);
wpn.x = 999;
check('getWorldPosition returns a defensive copy', tower.getWorldPosition().x === -1550);
check('deck elevation 48.0', tower.getDeckElevation() === 48.0);
const lifted = new RadioTower({ worldPosition: { x: 10, y: 20, z: 120 } });
check('deck elevation rides foundation z (120 -> 168)', lifted.getDeckElevation() === 168.0);

// --- 2. ladder bounds -----------------------------------------------------------
console.log('\n[2] Ladder bounds contract');
const b = tower.getLadderBounds();
const baseR = D.baseWidthM / 2 + LADDER_PROTRUSION_M; // 3.25
const topR = D.topWidthM / 2 + LADDER_PROTRUSION_M; // 1.35
check('base z == ground datum', b.basePosition.z === 0);
check('base xy = seat + (6/2 + 0.25)·n',
  near(b.basePosition.x, -1550 + NX * baseR, 1e-9) && near(b.basePosition.y, 2320 + NY * baseR, 1e-9));
check('top z == deck (48.0)', b.topPosition.z === 48.0);
check('top xy = seat + (2.2/2 + 0.25)·n (taper clamped)',
  near(b.topPosition.x, -1550 + NX * topR, 1e-9) && near(b.topPosition.y, 2320 + NY * topR, 1e-9));
check('facingNormal unit (cos f, sin f)', near(b.facingNormal.x, NX) && near(b.facingNormal.y, NY)
  && near(Math.hypot(b.facingNormal.x, b.facingNormal.y), 1));
check('rungWidthM 0.60', b.rungWidthM === 0.6);
check('totalRungs 137 (floor(48 / 0.35))', b.totalRungs === 137);
check('climbHeightM 48.0', b.climbHeightM === 48.0);
check('acceptance gate: rungs >= 120 at pitch <= 0.40', b.totalRungs >= 120 && LADDER_RUNG_PITCH_M <= 0.4);

// --- 3. proximity envelopes -------------------------------------------------------
console.log('\n[3] Proximity envelopes');
const BX = b.basePosition.x;
const BY = b.basePosition.y;
const HX = b.topPosition.x;
const HY = b.topPosition.y;
const atBase = (d: number, z = 0) => ({ x: BX + NX * d, y: BY + NY * d, z });
check('near base at 0.0 m -> true', tower.isNearLadderBase(atBase(0)));
check('near base at 1.0 m -> true', tower.isNearLadderBase(atBase(1.0)));
check('near base at 1.79 m -> true (inside 1.8)', tower.isNearLadderBase(atBase(1.79)));
check('near base at 2.5 m -> false (blueprint §4)', !tower.isNearLadderBase(atBase(2.5)));
check('base vertical envelope: z +2.0 true, z +5.0 false',
  tower.isNearLadderBase(atBase(0.5, 2.0)) && !tower.isNearLadderBase(atBase(0.5, 5.0)));
check('base vertical envelope: z -0.4 true, z -3.0 false',
  tower.isNearLadderBase(atBase(0.5, -0.4)) && !tower.isNearLadderBase(atBase(0.5, -3.0)));
check('custom radius override 4.0 accepts 3.5 m', tower.isNearLadderBase(atBase(3.5), 4.0));
check('NaN position -> false (no HUD flicker)', !tower.isNearLadderBase({ x: NaN, y: 0, z: 0 }));

const atHatch = (d: number, z = 48) => ({ x: HX + NX * d, y: HY + NY * d, z });
check('near hatch at 0.0 m deck z -> true', tower.isNearTopHatch(atHatch(0)));
check('near hatch at 0.99 m -> true (inside 1.0)', tower.isNearTopHatch(atHatch(0.99)));
check('near hatch at 1.5 m -> false', !tower.isNearTopHatch(atHatch(1.5)));
check('hatch z envelope: 47.0 true, 44.0 false',
  tower.isNearTopHatch(atHatch(0.2, 47.0)) && !tower.isNearTopHatch(atHatch(0.2, 44.0)));
check('hatch on lifted tower uses world z', lifted.isNearTopHatch(
  { x: lifted.getLadderBounds().topPosition.x, y: lifted.getLadderBounds().topPosition.y, z: 168.0 }));
check('ground floor is NOT near the top hatch', !tower.isNearTopHatch(atHatch(0, 0)));

const centreAt = (z: number) => {
  const half = 3 + (1.1 - 3) * Math.min(Math.max(z, 0) / 47.5, 1);
  const r = half + 0.25;
  return { x: -1550 + NX * r, y: 2320 + NY * r };
};
const env = (z: number, dOut: number) => {
  const c = centreAt(z);
  return { x: c.x + NX * dOut, y: c.y + NY * dOut, z };
};
check('climb envelope: rung centre at z=24 -> true', tower.isWithinClimbEnvelope(env(24, 0)));
check('climb envelope: 0.5 m off-rung -> true', tower.isWithinClimbEnvelope(env(24, 0.5)));
check('climb envelope: 5 m off-rung -> false', !tower.isWithinClimbEnvelope(env(24, 5)));
check('climb envelope: 3 m above deck -> false', !tower.isWithinClimbEnvelope(env(51, 0)));
check('climb envelope: 3 m under base -> false', !tower.isWithinClimbEnvelope(env(-3, 0)));
check('climb envelope: hatch re-latch margin (deck +0.5) -> true', tower.isWithinClimbEnvelope(env(48.5, 0)));
check('climb envelope: body rail (rung + 0.30) -> true', tower.isWithinClimbEnvelope(env(30, 0.3)));

// --- 4. climb offset rail law ---------------------------------------------------------
console.log('\n[4] Climb offset rail law');
const off0 = tower.getClimbOffsetPosition(0);
check('rail at base z: rung centre + 0.30·n',
  near(off0.x, BX + NX * LADDER_BODY_OFFSET_M, 1e-9) && near(off0.y, BY + NY * LADDER_BODY_OFFSET_M, 1e-9));
const offMid = tower.getClimbOffsetPosition(24);
const c24 = centreAt(24);
check('rail at z=24 follows the taper',
  near(offMid.x, c24.x + NX * 0.3, 1e-9) && near(offMid.y, c24.y + NY * 0.3, 1e-9));
const offTop = tower.getClimbOffsetPosition(48);
check('rail at deck: top rung line + 0.30·n',
  near(offTop.x, HX + NX * 0.3, 1e-9) && near(offTop.y, HY + NY * 0.3, 1e-9));
check('rail clamps below base (z=-100 == z=0)', near(tower.getClimbOffsetPosition(-100).x, off0.x));
check('rail clamps above deck (z=1e6 == z=48)', near(tower.getClimbOffsetPosition(1e6).x, offTop.x));
check('rail NaN z falls back to base datum', near(tower.getClimbOffsetPosition(NaN).x, off0.x));
// Δxy over the whole climb must equal the taper law, monotone inward:
let inward = true;
let prevR = Infinity;
for (let z = 0; z <= 48; z += 4) {
  const p = tower.getClimbOffsetPosition(z);
  const r = Math.hypot(p.x + 1550, p.y - 2320);
  if (r > prevR + 1e-12) inward = false;
  prevR = r;
}
check('rail radius monotone non-increasing (pure taper)', inward);

// --- 5. citadel clearance -------------------------------------------------------------
console.log('\n[5] Citadel / maglev spatial buffer');
const dCitadel = tower.getDistanceToCitadel();
check('citadel separation sqrt(96400) ~ 310.48 m', near(dCitadel, Math.sqrt(96400), 1e-9));
check('clear of warning ring 260', dCitadel > 260);
check('clear of shield dome 220', dCitadel > 220);
check('clear of CIWS lethal 180', dCitadel > 180);

// --- 6. beacon strobe law (pure) --------------------------------------------------------
console.log('\n[6] Beacon strobe law');
const bt = new RadioTower();
const s0 = bt.getBeaconPulseState();
check('at t=0: red pulse exactly 0 (dark start)', s0.redIntensity === 0);
check('at t=0: elapsedS 0', s0.elapsedS === 0);
let redMax = 0, redMin = 1, whiteFrames = 0;
const N = 1200;
for (let i = 0; i < N; i++) {
  bt.update(1 / 60);
  const s = bt.getBeaconPulseState();
  if (s.redIntensity > redMax) redMax = s.redIntensity;
  if (s.redIntensity < redMin) redMin = s.redIntensity;
  if (s.whiteIntensity > 0.5) whiteFrames++;
}
check('red sweeps a sharp full range (max > 0.99, min < 0.02)', redMax > 0.99 && redMin < 0.02,
  `max=${redMax.toFixed(4)} min=${redMin.toFixed(4)}`);
check('white double-flash ~12 frames/period x 10 periods', whiteFrames >= 115 && whiteFrames <= 130, `${whiteFrames}`);
check('elapsed advances under update()', bt.getBeaconPulseState().elapsedS > 19.99);
const dt1 = new RadioTower(); const dt2 = new RadioTower();
let deterministic = true;
for (let i = 0; i < 120; i++) {
  dt1.update(1 / 60); dt2.update(1 / 60);
  deterministic &&= JSON.stringify(dt1.getBeaconPulseState()) === JSON.stringify(dt2.getBeaconPulseState());
}
check('pulse law deterministic', deterministic);
check('garbage dt (NaN/-1) does not advance clock', (() => {
  const g = new RadioTower(); g.update(NaN); g.update(-1);
  return g.getBeaconPulseState().elapsedS === 0;
})());

// --- 7. NullEngine procedural assembly ---------------------------------------------------
console.log('\n[7] NullEngine procedural assembly');
const engine = new NullEngine();
const scene = new Scene(engine);
const built = new RadioTower().init(scene);
check('init(scene) built', built.isBuilt());
check('root node placed at worldToBabylon(seat)', (() => {
  const root = built.getRootNode();
  if (root === null) return false;
  const want = worldToBabylon(D.worldPosition);
  return near(root.position.x, want.x, 1e-6) && near(root.position.y, want.y, 1e-6) && near(root.position.z, want.z, 1e-6);
})());
const meshes = built.getMeshes();
check(`procedural mesh nodes >= 80 (got ${meshes.length})`, meshes.length >= 80);
const parts = (p: string) => built.getPartMeshes(p).length;
check(`rung parts == 137 (got ${parts('rung')})`, parts('rung') === 137);
check(`hoop parts == 22 (got ${parts('hoop')})`, parts('hoop') === 22);
check(`pillar parts == 32 (8 bays x 4 legs, got ${parts('pillar')})`, parts('pillar') === 32);
check(`diagonal parts == 64 (got ${parts('diagonal')})`, parts('diagonal') === 64);
check(`dish parts == 8 (2 x arm+dish+feed+horn, got ${parts('dish')})`, parts('dish') === 8);
check(`beacon parts == 3 (got ${parts('beacon')})`, parts('beacon') === 3);
check(`hatch parts == 6 (void + 4 curbs + panel, got ${parts('hatch')})`, parts('hatch') === 6);
check('deck + railing + spire + foundation present',
  parts('deck') >= 5 && parts('railing') >= 20 && parts('spire') >= 4 && parts('foundation') === 5);
const matNames = new Set(built.getShadowCasterMeshes().map((mm) => mm.material?.name ?? ''));
check('materials lattice-titanium / grate-deck / beacon-strobe / dish-composite',
  [...matNames].some((n) => n.includes('lattice-titanium'))
  && [...matNames].some((n) => n.includes('grate-deck'))
  && [...matNames].some((n) => n.includes('beacon-strobe'))
  && [...matNames].some((n) => n.includes('dish-composite')));
check('all shadow casters, no glow parts filtered out yet', built.getShadowCasterMeshes().length === meshes.length);
check('shadow casters exclude beacons? (they are matter, kept)',
  built.getShadowCasterMeshes().filter((mm) => mm.metadata?.part === 'beacon').length === 3);

// rung geometry (local frame: y == z above foundation)
const rung1 = built.getPartMeshes('rung')[0]!;
const rung137 = built.getPartMeshes('rung')[136]!;
check('rung 1 at local y 0.35', near(rung1.position.y, 0.35, 1e-12));
check('rung 137 at local y 47.95', near(rung137.position.y, 47.95, 1e-12));
const r1r = Math.hypot(rung1.position.x, rung1.position.z);
const r137r = Math.hypot(rung137.position.x, rung137.position.z);
// Rung centres follow the truss taper AT THEIR OWN HEIGHT: half(0.35) + 0.25.
check('rung 1 sits 3.236 m out (taper at z=0.35)', near(r1r, 3 + (1.1 - 3) * (0.35 / 47.5) + 0.25, 1e-9));
check('rung 137 sits 1.35 m out (summit taper clamp)', near(r137r, 1.35, 1e-9));
const ladderNode = built.getRootNode()?.getChildTransformNodes(false).some((n) => n.name.includes('ladder'));
check('ladder sub-node exists under root', ladderNode === true);

// frame ticks + world matrices finite (NullEngine never rasterizes — assert math, not pixels)
for (let i = 0; i < 30; i++) built.update(1 / 60);
const cw = built.getMeshes()[0] as unknown as { computeWorldMatrix: (f: boolean) => unknown };
cw.computeWorldMatrix(true);
let finiteAll = true;
for (let i = 0; i < meshes.length; i += 7) {
  const mm = meshes[i] as unknown as { computeWorldMatrix: (f: boolean) => { m: ArrayLike<number> } };
  const wm = mm.computeWorldMatrix(true);
  for (let k = 0; k < 16; k++) if (!Number.isFinite(wm.m[k] as number)) finiteAll = false;
}
check('sampled world matrices all finite after 30 ticks', finiteAll);

// idempotent init
const before = built.getMeshes().length;
built.init(scene);
check('init() twice is idempotent', built.isBuilt() && built.getMeshes().length === before);

// --- 8. dispose hygiene --------------------------------------------------------------------
console.log('\n[8] Dispose hygiene');
const snapshot = built.getMeshes();
// Babylon v9 drift: Material.isDisposed is not callable at runtime and the
// .scene ref survives dispose; the observable law is removal from
// scene.materials (verified: true before, false after).
check('scene starts with exactly 8 tower materials', scene.materials.length === 8);
const towerMatNames = scene.materials.map((mm) => mm.name).sort();
built.dispose();
check('isBuilt false after dispose', !built.isBuilt());
check('getMeshes empty after dispose', built.getMeshes().length === 0);
check('all previously-sampled meshes disposed', snapshot.every((mm) => mm.isDisposed()));
check('all 8 tower materials removed from scene.materials', scene.materials.length === 0);
check('material name set matches lattice/grate/safety/beacon x2/dish/concrete/void',
  towerMatNames.join(',').includes('lattice-titanium') && towerMatNames.join(',').includes('grate-deck')
  && towerMatNames.join(',').includes('beacon-strobe') && towerMatNames.join(',').includes('dish-composite')
  && towerMatNames.length > 0);
check('root node null after dispose', built.getRootNode() === null);
const after = built.getLadderBounds();
check('pure queries still answer after dispose', after.totalRungs === 137
  && near(after.basePosition.x, b.basePosition.x) && near(after.topPosition.z, 48));
check('proximity still answers after dispose', built.isNearLadderBase(atBase(1.0)) && built.isNearTopHatch(atHatch(0)));
built.dispose();
check('dispose() twice never throws', true);
let threw = false;
try { built.init(scene); } catch { threw = true; }
check('init() after dispose() throws', threw);

// self-owned NullEngine fallback + custom options
const solo = new RadioTower({ deckElevationM: 30, worldPosition: { x: 0, y: 0, z: 5 } });
solo.init();
check('init() no-arg NullEngine fallback builds', solo.isBuilt() && solo.getMeshes().length >= 80);
check('custom deck 30 -> climbHeight 30, rungs 85 (floor(30/0.35))', (() => {
  const cb = solo.getLadderBounds();
  return cb.climbHeightM === 30 && cb.totalRungs === 85;
})());
check('custom deck z = 35 (foundation 5)', solo.getDeckElevation() === 35);
solo.dispose();
check('solo dispose frees meshes', solo.getMeshes().length === 0 && solo.getRootNode() === null);

// sanitiser contract
const junk = new RadioTower({ towerHeightM: 10, baseWidthM: -5, topWidthM: 99, ladderFacingRad: NaN, deckElevationM: 30 });
const jb = junk.getLadderBounds();
check('junk options sanitised (base 6, top 2.2, facing -PI/4 fallback, world-frame rail)',
  jb.climbHeightM === 30 && jb.totalRungs === 85
  && Number.isFinite(jb.facingNormal.x) && Number.isFinite(jb.facingNormal.y)
  && near(jb.facingNormal.x, Math.cos(-Math.PI / 4), 1e-9) && near(jb.facingNormal.y, Math.sin(-Math.PI / 4), 1e-9)
  && near(junk.getClimbOffsetPosition(0).x, -1550 + Math.cos(-Math.PI / 4) * (3.25 + 0.3), 1e-9));

// --- summary -------------------------------------------------------------------------------
scene.dispose();
engine.dispose();
console.log(`\n${failures.length === 0 ? `ALL ${passed} CHECKS PASSED` : `${failures.length} FAILURES of ${passed + failures.length}: ${failures.join(', ')}`}`);
process.exitCode = failures.length === 0 ? 0 : 1;
void RADIO_TOWER_NAME_PREFIX;
