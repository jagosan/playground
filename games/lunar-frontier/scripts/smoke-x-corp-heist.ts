/**
 * Spec 26 Phase 6 master verification suite: X-Corp Citadel, High-Speed
 * Maglev, Train Heist Director, bailout extraction, HUD & audio.
 * Run: `npx tsx scripts/smoke-x-corp-heist.ts`  (exit code 0 == all green)
 *
 * Full Spec 26 acceptance gate on NullEngine, structured into the four
 * blueprint §4 verification domains:
 *
 *   DOMAIN 1 — Citadel Geometry & Defense Bounds (≥ 25 assertions):
 *     procedural mesh hierarchy (Monolith, Penthouse, VIADUCT, Spires,
 *     Geodesic Shield Dome) + perimeter potential field at r = 300 m
 *     (0 N), r = 260 m (warn), r = 200 m (F > 1500 N, exactly 18,000 N
 *     outward) and r ≤ 180 m (lethal strike Infinity).
 *   DOMAIN 2 — High-Speed Maglev Guideway & Kinematics (≥ 30 assertions):
 *     continuous 3,500 m Catmull-Rom arc-length parameterization, spline
 *     curvature, 4-car consist spacing (L_car = 14 m), forward orientation
 *     alignment, steady-state velocity (25.0 m/s), starboard service road
 *     offset (4.0 m) and the continuous transit loop.
 *   DOMAIN 3 — Train Heist Director & Platform Physics (≥ 35 assertions):
 *     velocity-matching envelope fuzzing (Δv ≤ 3.5 m/s, d_lat ∈ [2.5, 5.5] m,
 *     |d_long| ≤ 3.0 m), relative coordinate transform P_world = M_vault ·
 *     P_local with zero relative deck slide, the 6.0 s vault hacking timer,
 *     loot generation (3 He-3, 1 slate, 2 coils) and the 44.0 s countdown.
 *   DOMAIN 4 — Bailout Kinematics, Extraction & Audio-Visuals (≥ 20
 *     assertions): ballistic launch impulse v_exit = v_train + v_lateral,
 *     landing envelope outside the lethal threshold, tethered rover
 *     autopilot tracking, HUD telemetry, intrusion klaxon + procedural
 *     audio cues and clean NullEngine stage disposal.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import {
  XCorpCitadel,
  CITADEL_DEFAULT_WORLD_CENTER,
  DEFAULT_SHIELD_RADIUS_M,
  DEFAULT_LETHAL_RADIUS_M,
  DEFAULT_WARNING_RADIUS_M,
  SHIELD_REPULSION_K,
  MONOLITH_HEIGHT_M,
  SPIRE_HEIGHT_M,
  SPIRE_RING_RADIUS_M,
  CITADEL_TERMINAL_HEADING_RAD,
  CANYON_EXTRACTION_OUTPOST,
} from '../src/infrastructure/XCorpCitadel.ts';
import {
  HighSpeedMaglev,
  maglevTerrainElevationAt,
  MAGLEV_CAR_TYPES,
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
} from '../src/infrastructure/HighSpeedMaglev.ts';
import type { MaglevCarState, MaglevTrainState } from '../src/infrastructure/HighSpeedMaglev.ts';
import {
  TrainHeistDirector,
  heistLootCargoKg,
  MAX_RELATIVE_SPEED_MPS,
  BOARDING_LATERAL_MIN_M,
  BOARDING_LATERAL_MAX_M,
  BOARDING_LONGITUDINAL_MAX_M,
  TETHER_STANDBOFF_M,
  VAULT_HACK_DURATION_S,
  LOOT_HE3_CRYO_FLASKS,
  LOOT_QUANTUM_CIPHER_SLATES,
  LOOT_SUPERCONDUCTING_COILS,
  DEPOT_COUNTDOWN_S,
  BAILOUT_WARNING_S,
  BAILOUT_LATERAL_MPS,
  BAILOUT_DECK_HEIGHT_M,
  VAULT_DECK_LENGTH_M,
  VAULT_DECK_WIDTH_M,
  BOARDING_APEX_HEIGHT_M,
} from '../src/quests/TrainHeistDirector.ts';
import type { HeistPhase, HeistTelemetry } from '../src/quests/TrainHeistDirector.ts';
import {
  LunarHUD,
  HUD_HEIST_ID,
  HUD_HEIST_COUNTDOWN_FULL_S,
  HUD_HEIST_CRITICAL_S,
  HUD_HEIST_LOOT_SLOTS,
} from '../src/ui/LunarHUD.ts';
import {
  LunarAudioSystem,
  MAGLEV_HUM_FLOOR_HZ,
  MAGLEV_HUM_CEILING_HZ,
  KLAXON_LOW_HZ,
  KLAXON_HIGH_HZ,
  MAGLOCK_THUD_HZ,
} from '../src/audio/LunarAudioSystem.ts';
import { worldToBabylon, babylonToWorld } from '../src/engine/CameraRig.ts';

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

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
const section = (t: string): void => console.log(`\n=== ${t} ===`);
const approx = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;
const hFrame = (): number => 1 / 60;
type V3 = { x: number; y: number; z: number };
const vAdd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vScale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const vLen = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const dot3 = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** v' = v + 2w·(q_vec × v) + 2·q_vec × (q_vec × v) — Babylon Quaternion math. */
function qRotate(q: Quaternion, x: number, y: number, z: number): V3 {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return {
    x: x + q.w * tx + (q.y * tz - q.z * ty),
    y: y + q.w * ty + (q.z * tx - q.x * tz),
    z: z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Lunar-gravity ballistic solve: step to the regolith, return the landing. */
function ballisticLanding(p0: V3, v0: V3, g = 1.62, dt = 1 / 120, maxT = 40): V3 | null {
  const p: V3 = { ...p0 };
  const v: V3 = { ...v0 };
  for (let t = 0; t < maxT; t += dt) {
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;
    v.z -= g * dt;
    if (p.z <= maglevTerrainElevationAt(p.x, p.y)) return p;
  }
  return null;
}

/** Fake DOM (same structural subset as smoke-heist-hud-audio). */
interface FakeElement {
  id: string;
  className: string;
  style: Record<string, string>;
  classList: { add(n: string): void; remove(n: string): void; contains(n: string): boolean };
  children: FakeElement[];
  parent: FakeElement | null;
  attributes: Map<string, string>;
  appendChild<T>(c: T): T;
  remove(): void;
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
}
function makeFakeElement(registry: Map<string, FakeElement>): FakeElement {
  const attributes = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    id: '',
    className: '',
    style: {},
    classList: {
      add(n) {
        const s = new Set(el.className.split(/\s+/).filter(Boolean));
        s.add(n);
        el.className = [...s].join(' ');
      },
      remove(n) {
        const s = new Set(el.className.split(/\s+/).filter(Boolean));
        s.delete(n);
        el.className = [...s].join(' ');
      },
      contains(n) {
        return el.className.split(/\s+/).includes(n);
      },
    },
    children,
    parent: null,
    attributes,
    appendChild(c) {
      (c as FakeElement).parent = el;
      children.push(c as FakeElement);
      return c;
    },
    remove() {
      if (el.parent !== null) {
        const i = el.parent.children.indexOf(el);
        if (i >= 0) el.parent.children.splice(i, 1);
      }
      registry.delete(el.id);
    },
    getAttribute(n) {
      return attributes.get(n) ?? null;
    },
    setAttribute(n, v) {
      attributes.set(n, v);
      if (n === 'id') {
        el.id = v;
        registry.set(v, el);
      }
    },
  };
  return el;
}
function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  return {
    body: makeFakeElement(registry),
    createElement: () => makeFakeElement(registry),
    getElementById: (id: string) => registry.get(id) ?? null,
  };
}

/** Place a point `lat` metres off the vault heading line (true perpendicular). */
function roverInEnvelope(vault: MaglevCarState, lat: number, long = 0): V3 {
  const f = vault.worldForward;
  const raw: V3 = { x: 3, y: 3, z: 0 };
  const along = dot3(raw, f);
  const perp: V3 = { x: raw.x - along * f.x, y: raw.y - along * f.y, z: raw.z - along * f.z };
  const pl = vLen(perp);
  const latVec = vScale(perp, lat / (pl || 1));
  return vAdd(vAdd(vault.worldPosition, latVec), vScale(f, long));
}

const domainCounts: Record<string, number> = {};
const markDomain = (name: string): void => {
  domainCounts[name] = passed;
};

// ===========================================================================
section('DOMAIN 1 · Citadel Geometry & Defense Bounds (blueprint §4 group 1)');
markDomain('start');
const d1Start = passed;
// ===========================================================================

const citadel = new XCorpCitadel();
const radii = citadel.getDefenseRadii();
check('D1.01 default lethal radius 180 m', radii.lethalM === DEFAULT_LETHAL_RADIUS_M && DEFAULT_LETHAL_RADIUS_M === 180);
check('D1.02 default shield radius 220 m', radii.shieldM === DEFAULT_SHIELD_RADIUS_M && DEFAULT_SHIELD_RADIUS_M === 220);
check('D1.03 default warning radius 260 m', radii.warningM === DEFAULT_WARNING_RADIUS_M && DEFAULT_WARNING_RADIUS_M === 260);
const seat = citadel.getWorldCenter();
check('D1.04 canonical seat (-1850, 2400, 0)', seat.x === -1850 && seat.y === 2400 && seat.z === 0);
check('D1.05 k_shield = 45.0 N/m²', SHIELD_REPULSION_K === 45.0);
check('D1.06 monolith height constant 85 m', MONOLITH_HEIGHT_M === 85);
check('D1.07 spire height 35 m on the 200 m ring', SPIRE_HEIGHT_M === 35 && SPIRE_RING_RADIUS_M === 200);
check(
  'D1.08 terminal heading points at the canyon outpost',
  approx(CITADEL_TERMINAL_HEADING_RAD, Math.atan2(CANYON_EXTRACTION_OUTPOST.y - seat.y, CANYON_EXTRACTION_OUTPOST.x - seat.x), 1e-12),
);

// -- perimeter potential field (blueprint §3.3) --------------------------------
const at = (r: number) => citadel.getPerimeterStatus({ x: seat.x + r, y: seat.y, z: seat.z });
const s300 = at(300);
check('D1.09 r=300: outside all three rings', !s300.inWarningZone && !s300.inShieldPerimeter && !s300.inLethalZone);
check('D1.10 r=300: zero repulsion force', s300.repulsionForceN === 0);
const s260 = at(260);
check('D1.11 r=260: warning perimeter edge (warn, not shielded)', s260.inWarningZone && !s260.inShieldPerimeter);
check('D1.12 r=260: warning is broadcast-only (0 N)', s260.repulsionForceN === 0);
const s220 = at(220);
check('D1.13 r=220: shield dome edge engages, force ramps from 0', s220.inShieldPerimeter && s220.repulsionForceN === 0);
const s200 = at(200);
check('D1.14 r=200: repulsion F > 1500 N', s200.repulsionForceN > 1500, `${s200.repulsionForceN}`);
check('D1.15 r=200: exactly 45·(220−200)² = 18,000 N', Math.abs(s200.repulsionForceN - 18000) < 1e-9, `${s200.repulsionForceN}`);
check('D1.16 r=200: not yet in the lethal zone', !s200.inLethalZone);
// Outward direction semantics: applied force J = +F · r̂_out (away from seat).
const intruder = { x: seat.x + 200, y: seat.y + 30, z: 0 };
const rOut: V3 = { x: intruder.x - seat.x, y: intruder.y - seat.y, z: 0 };
const jOut = vScale(rOut, s200.repulsionForceN / (vLen(rOut) || 1));
check('D1.17 r=200: impulse vector J points outward, |J| = F', vLen(jOut) === s200.repulsionForceN && dot3(jOut, rOut) > 0);
const s180 = at(180);
check('D1.18 r=180: lethal threshold crossing = Infinity strike', s180.inLethalZone && s180.repulsionForceN === Infinity);
const s0 = at(0);
check('D1.19 r=0 (seat): lethal strike Infinity', s0.inLethalZone && s0.repulsionForceN === Infinity);
check('D1.20 force monotone increasing as intruder closes in', at(210).repulsionForceN < s200.repulsionForceN && s200.repulsionForceN < at(190).repulsionForceN);
const sNaN = citadel.getPerimeterStatus({ x: NaN, y: NaN, z: 0 });
check('D1.21 NaN position degrades to far-outside, never flickers', sNaN.distanceM === Infinity && sNaN.repulsionForceN === 0 && !sNaN.inWarningZone);
check('D1.22 perimeter queries answer BEFORE init()', citadel.isBuilt() === false && s200.inShieldPerimeter === true);
const custom = new XCorpCitadel({ worldCenter: { x: 10, y: 20, z: 0 }, shieldRadiusM: 100, lethalRadiusM: 300, warningRadiusM: 50 });
const cr = custom.getDefenseRadii();
check('D1.23 custom rings clamp to lethal ≤ shield ≤ warning', cr.lethalM <= cr.shieldM && cr.shieldM <= cr.warningM, JSON.stringify(cr));

// -- headless NullEngine build ---------------------------------------------------
const engine = new NullEngine();
const scene = new Scene(engine);
const built = new XCorpCitadel().init(scene);
check('D1.24 init(scene) builds; idempotent', built.isBuilt() && built.init(scene) === built);
const cMeshes = built.getMeshes();
check('D1.25 procedural mesh hierarchy > 60 meshes', cMeshes.length > 60, `${cMeshes.length}`);
for (const p of ['monolith', 'penthouse', 'viaduct', 'spire', 'shield']) {
  const n = built.getPartMeshes(p).length;
  check(`D1.26 part '${p}' present in hierarchy`, n > 0, `${n}`);
}
const monolith = built.getPartMeshes('monolith')[0];
const monoH = monolith !== undefined ? monolith.getBoundingInfo().maximum.y - monolith.getBoundingInfo().minimum.y : 0;
check('D1.27 monolith hex tower is 85 m tall', monoH > MONOLITH_HEIGHT_M - 1 && monoH < MONOLITH_HEIGHT_M + 1, `${monoH}`);
check('D1.28 executive penthouse: 3 cantilevered pod bodies', built.getPartMeshes('penthouse').filter((m) => m.name.includes('pod-body')).length === 3);
check('D1.29 grand terminal viaduct (deck + portal + 6 pylons)', built.getPartMeshes('viaduct').length === 8, `${built.getPartMeshes('viaduct').length}`);
check('D1.30 twin hydraulic blast gates seal the throat', built.getPartMeshes('blast_gate').length === 2);
const dome = built.getPartMeshes('shield')[0];
const domeOk = dome !== undefined && (() => {
  const bb = dome.getBoundingInfo();
  return Math.abs(bb.maximum.x - DEFAULT_SHIELD_RADIUS_M) < 1 && Math.abs(bb.maximum.z - DEFAULT_SHIELD_RADIUS_M) < 1;
})();
check('D1.31 geodesic shield dome spans ±220 m at R_shield', domeOk);
if (dome !== undefined) {
  const sm = dome.material as { emissiveColor?: { g: number }; alpha?: number; backFaceCulling?: boolean } | null;
  check(
    'D1.32 dome emissive neon-cyan, translucent, two-sided',
    sm !== null && sm.emissiveColor !== undefined && Math.abs(sm.emissiveColor.g - 0.85) < 0.2 &&
      sm.alpha !== undefined && sm.alpha < 0.5 && sm.backFaceCulling === false,
  );
}
const spires = built.getPartMeshes('spire').filter((m) => /-spire-\d$/.test(m.name));
const spireRingOk = spires.every((m) => {
  const p = m.getAbsolutePosition();
  return Math.abs(Math.hypot(p.x - seat.x, -(p.z) - seat.y) - SPIRE_RING_RADIUS_M) < 2;
});
check('D1.33 three CIWS spires stand on the 200 m ring', spires.length === 3 && spireRingOk);
// CIWS turret tracks an intruder inside the warning perimeter.
// (NullEngine never renders, so force the world matrix before each read.)
const eye = built.getPartMeshes('turret').find((m) => m.name.includes('turret-eye'));
const eyePos = (): V3 | null => {
  if (eye === undefined) return null;
  eye.computeWorldMatrix(true);
  const p = eye.getAbsolutePosition();
  return { x: p.x, y: p.y, z: p.z };
};
const eyeBefore = eyePos();
for (let i = 0; i < 60; i++) built.update(hFrame(), { x: seat.x - 180, y: seat.y + 120, z: 0 });
const eyeAfter = eyePos();
check('D1.34 CIWS turret head tracks the intruder', eyeBefore !== null && eyeAfter !== null && vLen({
  x: eyeAfter.x - eyeBefore.x, y: eyeAfter.y - eyeBefore.y, z: eyeAfter.z - eyeBefore.z,
}) > 0.5);
const stLethal = built.update(hFrame(), { x: seat.x + 90, y: seat.y, z: 0 });
check('D1.35 update() answers Infinity inside the lethal zone', stLethal.inLethalZone && stLethal.repulsionForceN === Infinity);
const casters = built.getShadowCasterMeshes();
check('D1.36 shadow casters exclude the energy barrier', casters.length === cMeshes.length - built.getPartMeshes('shield').length && !casters.some((m) => (m.metadata?.part as string) === 'shield'));
const cRoot = built.getRootNode();
check('D1.37 system root sits on the world seat (x, z=−y)', cRoot !== null && Math.abs(cRoot.position.x - seat.x) < 0.01 && Math.abs(cRoot.position.z + seat.y) < 0.01);
built.dispose();
check('D1.38 dispose drains meshes + root, is idempotent', (built.dispose(), built.getMeshes().length === 0 && built.getRootNode() === null && !built.isBuilt()));
check('D1.39 perimeter still answers after dispose', built.getPerimeterStatus({ x: seat.x + 180, y: seat.y, z: 0 }).inLethalZone);
let citInitThrew = false;
try { built.init(scene); } catch { citInitThrew = true; }
check('D1.40 init() after dispose refuses', citInitThrew);
markDomain('citadel');
console.log(`  — domain 1 subtotal: ${passed - d1Start} assertions —`);

// ===========================================================================
section('DOMAIN 2 · High-Speed Maglev Guideway & Kinematics (blueprint §4 group 2)');
const d2Start = passed;
// ===========================================================================

const mag = new HighSpeedMaglev();
const total = mag.getTotalSplineLengthM();
check('D2.01 guideway target constant 3,500 m', GUIDEWAY_TARGET_LENGTH_M === 3500);
check('D2.02 Catmull-Rom arc length hits 3,500 m (Δ < 0.05 m)', Math.abs(total - 3500) < 0.05, `total=${total}`);
const pStart = mag.getPointAtDistance(0);
const pEnd = mag.getPointAtDistance(total);
check('D2.03 spline starts at the canyon outpost dock', approx(pStart.x, 1200, 1e-6) && approx(pStart.y, 800, 1e-6));
check('D2.04 spline ends at the citadel grand terminal', approx(pEnd.x, -1850, 1e-6) && approx(pEnd.y, 2400, 1e-6));
let maxStep = 0;
let prevP = mag.getPointAtDistance(0);
for (let s = 1; s <= total; s += 1) {
  const p = mag.getPointAtDistance(s);
  maxStep = Math.max(maxStep, Math.hypot(p.x - prevP.x, p.y - prevP.y, p.z - prevP.z));
  prevP = p;
}
check('D2.05 parameterization continuous: 1 m steps never jump', maxStep < 1.05, `max chord=${maxStep}`);
let unitErr = 0;
let bendMax = 0;
let prevT = mag.getForwardAtDistance(0);
for (let s = 0; s <= total; s += 10) {
  const f = mag.getForwardAtDistance(s);
  unitErr = Math.max(unitErr, Math.abs(vLen(f) - 1));
  bendMax = Math.max(bendMax, Math.acos(Math.min(1, Math.max(-1, dot3(f, prevT)))));
  prevT = f;
}
check('D2.06 forward tangents are unit vectors (err < 1e-9)', unitErr < 1e-9, `err=${unitErr}`);
check('D2.07 curvature continuous: no kink > 0.06 rad per 10 m', bendMax < 0.06, `max bend=${bendMax}`);
check('D2.08 arc distance clamps below 0 and above total', mag.getPointAtDistance(-500).x === pStart.x && mag.getPointAtDistance(total + 500).x === pEnd.x);
let clrMin = Infinity;
let clrMax = -Infinity;
for (let s = 0; s <= total; s += 4) {
  const c = mag.getGuidewayClearanceAtDistance(s);
  clrMin = Math.min(clrMin, c);
  clrMax = Math.max(clrMax, c);
}
check(
  'D2.09 elevation band stays inside 2.5–6.0 m',
  clrMin >= GUIDEWAY_ELEVATION_MIN_M - 1e-12 && clrMax <= GUIDEWAY_ELEVATION_MAX_M + 1e-12,
  `band=[${clrMin}, ${clrMax}]`,
);
// steady-state cruise
const cruise = new HighSpeedMaglev();
check('D2.10 cruise constant 25.0 m/s, accel constant 2.0 m/s²', DEFAULT_CRUISE_SPEED_MPS === 25.0 && DEFAULT_ACCELERATION_MPS2 === 2.0);
for (let i = 0; i < 60; i++) cruise.update(hFrame());
check('D2.11 speed ramps v(t) = a·t: ≈2.0 m/s after 1 s', approx(cruise.getTrainState().speedMps, 2.0, 1e-6));
for (let i = 0; i < 240; i++) cruise.update(hFrame());
check('D2.12 ≈10.0 m/s after 5 s', approx(cruise.getTrainState().speedMps, 10.0, 1e-5));
for (let i = 0; i < 60 * 8; i++) cruise.update(hFrame());
const steady = cruise.getTrainState();
check('D2.13 steady-state velocity is exactly 25.0 m/s', steady.speedMps === 25.0);
check('D2.14 4-car consist: locomotive, vault, executive, escort', MAGLEV_CAR_TYPES.length === 4 &&
  steady.cars.map((c) => c.type).join(',') === 'locomotive,vault,executive,escort');
check('D2.15 consist length 4 × L_car = 56 m', DEFAULT_CAR_LENGTH_M === 14.0 && steady.totalLengthM === 56);
const spacingOk = steady.cars.every((c, i) => approx(c.distanceAlongSplineM, steady.cars[0]!.distanceAlongSplineM - i * 14.0, 1e-9));
check('D2.16 articulation law s_i = s − i·14 m exact', spacingOk);
let worstChord = 0;
for (let s = 500; s <= 3000; s += 37) {
  const a = mag.getPointAtDistance(s);
  const b = mag.getPointAtDistance(s - 14);
  worstChord = Math.max(worstChord, Math.abs(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - 14));
}
check('D2.17 world chord spacing stays ≈14 m over the meander (|Δ| < 0.15)', worstChord < 0.15, `worst=${worstChord}`);
const carsUnitOk = steady.cars.every((c) => Math.abs(vLen(c.worldForward) - 1) < 1e-9);
check('D2.18 per-car world forward vectors are unit', carsUnitOk);
const vt = mag.getVaultCarTransform();
const modelFwd = qRotate(vt.rotationQuaternion, 0, 0, 1);
const vaultState = mag.getVaultCarState();
const tanBab = worldToBabylon(vaultState === null ? { x: 1, y: 0, z: 0 } : vaultState.worldForward);
const tanLen = vLen(tanBab) || 1;
check('D2.19 vault quaternion aligns model +z with the guideway tangent', dot3(modelFwd, vScale(tanBab, 1 / tanLen)) > 0.999999);
check('D2.20 vault floats 0.4 m above the deck (unbuilt: no bob)', vaultState !== null && approx(vt.position.y, vaultState.worldPosition.z + CARRIAGE_FLOAT_M, 1e-9));
check('D2.21 suspension bob constant ±0.04 m', SUSPENSION_BOB_M === 0.04);
// service road: 4.0 m starboard, crowned +0.15 m
let roadOffMax = 0;
let roadSideOk = true;
for (const s of [100, 500, 1000, 2000, 3000]) {
  const road = mag.getServiceRoadPointAtDistance(s);
  const track = mag.getPointAtDistance(s);
  const f = mag.getForwardAtDistance(s);
  roadOffMax = Math.max(roadOffMax, Math.abs(Math.hypot(road.x - track.x, road.y - track.y) - SERVICE_ROAD_OFFSET_M));
  const rHat: V3 = { x: f.y, y: -f.x, z: 0 };
  const rl = vLen(rHat) || 1;
  const off2: V3 = { x: road.x - track.x, y: road.y - track.y, z: 0 };
  if (dot3(off2, vScale(rHat, 1 / rl)) < 0.999) roadSideOk = false;
  if (!approx(road.z, maglevTerrainElevationAt(road.x, road.y) + 0.15, 1e-9)) roadSideOk = false;
}
check('D2.22 service road offset exactly 4.0 m starboard', SERVICE_ROAD_OFFSET_M === 4.0 && roadOffMax < 1e-9, `dev=${roadOffMax}`);
check('D2.23 road sits on the starboard ray, crowned +0.15 m over terrain', roadSideOk);
// continuous transit loop
const looper = new HighSpeedMaglev();
looper.update(0.1);
let headPrev = 0;
let wrapped = false;
let postWrap = 0;
for (let i = 0; i < 60 * 220 && !wrapped; i++) {
  const h = looper.getHeadDistanceM();
  if (h < headPrev - 1) { wrapped = true; postWrap = h; }
  headPrev = h;
  looper.update(hFrame());
}
check('D2.24 continuous transit: head wraps at the depot terminal', wrapped);
check('D2.25 wrap returns the consist to the outpost dock (standby s ≈ 42)', postWrap >= 42 && postWrap <= 43, `${postWrap}`);
// depot bookkeeping + dt guards
const book = mag.getTrainState();
check('D2.26 distanceToDepot = total − headS exact', book.distanceToDepotM === total - mag.getHeadDistanceM());
check('D2.27 timeToDepot = distance / max(speed, 1)', approx(book.timeToDepotS, book.distanceToDepotM / Math.max(book.speedMps, 1), 1e-9));
const headBefore = mag.getHeadDistanceM();
mag.update(Number.NaN);
mag.update(-5);
check('D2.28 NaN / negative dt freeze the clock (no teleport)', mag.getHeadDistanceM() === headBefore);
mag.update(10);
check('D2.29 dt clamped to 0.25 s (advance ≤ 25 × 0.25 m)', mag.getHeadDistanceM() - headBefore <= 25 * 0.25 + 1e-9);
// built guideway mesh hierarchy
const builtMag = new HighSpeedMaglev();
builtMag.init();
check('D2.30 init() NullEngine fallback builds the guideway', builtMag.isBuilt() && builtMag.getMeshes().length > 300, `${builtMag.getMeshes().length}`);
check('D2.31 pylons every 24 m: 145 stations × (shaft + capital)', builtMag.getPartMeshes('pylon').length === 290, `${builtMag.getPartMeshes('pylon').length} (spacing const ${PYLON_SPACING_M})`);
check('D2.32 deck + twin stator rails + service road ribbons', builtMag.getPartMeshes('deck').length === 1 && builtMag.getPartMeshes('stator_rail').length === 2 && builtMag.getPartMeshes('road').length === 1);
check('D2.33 terminal pads at dock and depot mouth', builtMag.getPartMeshes('terminal_pad').length === 2);
check('D2.34 consist bodies: loco, vault, executive, escort car meshes', builtMag.getPartMeshes('locomotive').length >= 5 && builtMag.getPartMeshes('vault').length === 1 && builtMag.getPartMeshes('executive').length === 1 && builtMag.getPartMeshes('escort').length >= 2);
check('D2.35 heist target: Cyber-Lock container + lock plate, 3 magnetic couplers', builtMag.getPartMeshes('vault_container').length === 1 && builtMag.getPartMeshes('vault_lock').length === 1 && builtMag.getPartMeshes('coupler').length === 3);
check('D2.36 flank catwalks (10 meshes) with hazard trim + barcode', builtMag.getPartMeshes('catwalk').length === 10 && builtMag.getPartMeshes('trim').length === 2 && builtMag.getPartMeshes('barcode').length === 1);
// suspension bob actually animates once built (measured per frame against the
// same-frame deck line: the consist itself travels while we sample)
let bobMin = Infinity;
let bobMax = -Infinity;
for (let i = 0; i < 200; i++) {
  builtMag.update(hFrame());
  const vNow = builtMag.getVaultCarState();
  if (vNow === null) continue;
  const y = builtMag.getVaultCarTransform().position.y - (vNow.worldPosition.z + CARRIAGE_FLOAT_M);
  bobMin = Math.min(bobMin, y);
  bobMax = Math.max(bobMax, y);
}
check('D2.37 live suspension bob spans the ±0.04 m envelope', bobMax - bobMin > 0.06 && bobMax <= SUSPENSION_BOB_M + 1e-9 && bobMin >= -SUSPENSION_BOB_M - 1e-9, `[${bobMin}, ${bobMax}]`);
const node = builtMag.getVaultCarNode();
const nodeOk = (() => {
  if (node === null) return false;
  const v = builtMag.getVaultCarState();
  if (v === null) return false;
  // The render node rides the deck line inside the bob envelope (its own
  // per-car bob phase, ±0.04 m, may differ from the vault transform readout).
  const dy = node.position.y - (v.worldPosition.z + CARRIAGE_FLOAT_M);
  const dtf = Math.abs(node.position.y - builtMag.getVaultCarTransform().position.y);
  const wb = worldToBabylon(v.worldPosition);
  return Math.abs(dy) <= SUSPENSION_BOB_M + 1e-9 && dtf <= 2 * SUSPENSION_BOB_M + 1e-9 &&
    approx(node.position.x, wb.x, 1e-6) && approx(node.position.z, wb.z, 1e-6);
})();
check('D2.38 vault car root node is the live render anchor on the deck line', nodeOk);
builtMag.dispose();
check('D2.39 guideway dispose drains everything', builtMag.getMeshes().length === 0 && !builtMag.isBuilt());
const lastState: MaglevTrainState = builtMag.getLastState();
check('D2.40 kinematics answer after dispose (scene-independent)', Number.isFinite(lastState.speedMps) && Number.isFinite(builtMag.getTotalSplineLengthM()));
markDomain('maglev');
console.log(`  — domain 2 subtotal: ${passed - d2Start} assertions —`);

// ===========================================================================
section('DOMAIN 3 · Train Heist Director & Platform Physics (blueprint §4 group 3)');
const d3Start = passed;
// ===========================================================================

const dirMag = new HighSpeedMaglev();
for (let i = 0; i < 60 * 40; i++) dirMag.update(hFrame()); // cruise, mid-badlands
const director = new TrainHeistDirector(dirMag, null);
check('D3.01 director opens INACTIVE', director.getPhase() === 'INACTIVE');
check('D3.02 startHeist transitions INACTIVE → INTERCEPTING', director.startHeist() === true && director.getPhase() === 'INTERCEPTING');
check('D3.03 second startHeist refuses', director.startHeist() === false);
const vault3 = dirMag.getVaultCarState();
if (vault3 === null) {
  check('D3 vault car available', false);
  console.error('cannot continue domain 3 without a vault car');
  process.exit(1);
}
const vCruise = vault3; // narrowed non-null
const roverMatch = roverInEnvelope(vCruise, 4.0);
const tOut = director.update(hFrame(), { x: 0, y: 0, z: 0 }, 35);
check('D3.04 outside envelope: canBoard false, stays INTERCEPTING', !tOut.canBoard && director.getPhase() === 'INTERCEPTING');
const tIn = director.update(hFrame(), roverMatch, vCruise.speedMps);
check('D3.05 inside envelope: canBoard true → BOARDING_WINDOW', tIn.canBoard && director.getPhase() === 'BOARDING_WINDOW');
check('D3.06 telemetry reads the true lateral 4.0 m / Δv 0 m/s', approx(tIn.lateralDistanceM, 4.0, 1e-3) && approx(tIn.relativeSpeedMps, 0, 1e-9));

// -- tolerance-envelope fuzzing ----------------------------------------------
const fuzz = new TrainHeistDirector(dirMag, null);
fuzz.startHeist();
let dvFuzzOk = true;
for (let dv = 0; dv <= 5.001; dv += 0.05) {
  const t = fuzz.update(hFrame(), roverMatch, 25 - dv);
  if (t.canBoard !== dv <= MAX_RELATIVE_SPEED_MPS + 1e-9) { dvFuzzOk = false; break; }
}
check('D3.07 fuzz Δv ∈ [0, 5]: canBoard ⇔ Δv ≤ 3.5 m/s', dvFuzzOk && MAX_RELATIVE_SPEED_MPS === 3.5);
check('D3.08 boundary Δv = 3.5 exactly boards (inclusive)', fuzz.update(hFrame(), roverMatch, 25 - 3.5).canBoard);
check('D3.09 Δv = 3.51 m/s breaks the lock', !fuzz.update(hFrame(), roverMatch, 25 - 3.51).canBoard);
let latFuzzOk = true;
for (let lat = 1.5; lat <= 6.5001; lat += 0.05) {
  const t = fuzz.update(hFrame(), roverInEnvelope(vCruise, lat), 25);
  if (t.canBoard !== (lat >= BOARDING_LATERAL_MIN_M - 1e-5 && lat <= BOARDING_LATERAL_MAX_M + 1e-5)) { latFuzzOk = false; break; }
}
check('D3.10 fuzz lateral ∈ [1.5, 6.5]: canBoard ⇔ d_lat ∈ [2.5, 5.5] m', latFuzzOk && BOARDING_LATERAL_MIN_M === 2.5 && BOARDING_LATERAL_MAX_M === 5.5);
check('D3.11 lateral boundaries 2.5 and 5.5 are inclusive', fuzz.update(hFrame(), roverInEnvelope(vCruise, 2.5), 25).canBoard && fuzz.update(hFrame(), roverInEnvelope(vCruise, 5.5), 25).canBoard);
check('D3.12 d_lat 2.4 and 5.6 fall outside the band', !fuzz.update(hFrame(), roverInEnvelope(vCruise, 2.4), 25).canBoard && !fuzz.update(hFrame(), roverInEnvelope(vCruise, 5.6), 25).canBoard);
let lonFuzzOk = true;
for (let lng = -4; lng <= 3.5001; lng += 0.05) {
  const t = fuzz.update(hFrame(), roverInEnvelope(vCruise, 4.0, lng), 25);
  if (t.canBoard !== Math.abs(lng) <= BOARDING_LONGITUDINAL_MAX_M + 1e-5) { lonFuzzOk = false; break; }
}
check('D3.13 fuzz longitudinal: canBoard ⇔ |d_long| ≤ 3.0 m', lonFuzzOk && BOARDING_LONGITUDINAL_MAX_M === 3.0);
check('D3.14 d_long = ±3.0 inclusive; 3.01 refuses', fuzz.update(hFrame(), roverInEnvelope(vCruise, 4, 3), 25).canBoard && fuzz.update(hFrame(), roverInEnvelope(vCruise, 4, -3), 25).canBoard && !fuzz.update(hFrame(), roverInEnvelope(vCruise, 4, 3.01), 25).canBoard);
// envelope break falls back out of BOARDING_WINDOW
fuzz.update(hFrame(), roverMatch, 35);
check('D3.15 falling out of the envelope returns to INTERCEPTING', fuzz.getPhase() === 'INTERCEPTING');
check('D3.16 executeBoardingJump outside a match refuses', fuzz.executeBoardingJump() === false);

// -- boarding + relative platform kinematics -----------------------------------
check('D3.17 executeBoardingJump succeeds inside the envelope', director.executeBoardingJump() === true && director.getPhase() === 'ON_BOARD_CRACKING');
const anchored = director.getPlayerLocalPos();
check('D3.18 player anchored to vault-car local frame at deck height', approx(anchored.x, 0, 1e-12) && approx(anchored.y, BAILOUT_DECK_HEIGHT_M, 1e-12) && approx(anchored.z, 0, 1e-12));
check('D3.19 deck geometry: 14 m × 3.2 m catwalk span', VAULT_DECK_LENGTH_M === 14.0 && VAULT_DECK_WIDTH_M === 3.2);
check('D3.20 isPlayerOnBoard true while cracking', director.isPlayerOnBoard());
const apex = director.getLastBoardingApex();
check('D3.21 boarding apex recorded at deck + 0.5 m', apex !== null && apex.y > vault3.worldPosition.z + BOARDING_APEX_HEIGHT_M - 1e-6);
check('D3.22 rover tethered-autopilot engages on boarding', director.isAutopilotTetherActive());
// P_world = M_vault · P_local, exact against an independent transform
const pw = director.getPlayerWorldPos();
const mVault = director.getVaultCarTransform();
const localY = qRotate(mVault.rotationQuaternion, anchored.x, anchored.y, anchored.z);
const manual = babylonToWorld(new Vector3(localY.x + mVault.position.x, localY.y + mVault.position.y, localY.z + mVault.position.z));
check('D3.23 P_world = M_vault·P_local matches an independent transform', approx(pw.x, manual.x, 1e-9) && approx(pw.y, manual.y, 1e-9) && approx(pw.z, manual.z, 1e-9));
// zero relative deck slide while the train runs at 25 m/s
const anchorBefore = director.getPlayerLocalPos();
const worldBefore = director.getPlayerWorldPos();
for (let i = 0; i < 120; i++) {
  dirMag.update(hFrame());
  director.update(hFrame(), roverMatch, 25);
}
const anchorAfter = director.getPlayerLocalPos();
const worldAfter = director.getPlayerWorldPos();
check('D3.24 zero relative slide: local anchor frozen while train covers ~50 m',
  approx(anchorAfter.x, anchorBefore.x, 1e-12) && approx(anchorAfter.z, anchorBefore.z, 1e-12) && vLen(vAdd(worldAfter, vScale(worldBefore, -1))) > 40);
const vaultNow = dirMag.getVaultCarState();
const relSlide = vaultNow === null || vLen(vAdd(director.getPlayerWorldPos(), vScale(vaultNow.worldPosition, -1))) < BAILOUT_DECK_HEIGHT_M + 2;
check('D3.25 avatar stays within arm’s reach of the vault car centre', relSlide);
// deck locomotion with walls
for (let i = 0; i < 60; i++) director.update(hFrame(), roverMatch, 25, { dz: 6 });
check('D3.26 deck locomotion walks +z in the car frame (6 m/s × 1 s)', approx(director.getPlayerLocalPos().z, 6.0, 1e-6));
for (let i = 0; i < 10; i++) director.update(hFrame(), roverMatch, 25, { dz: 100 });
check('D3.27 deck wall clamps z at +L/2 = 7.0 m', director.getPlayerLocalPos().z === 7.0);
for (let i = 0; i < 10; i++) director.update(hFrame(), roverMatch, 25, { x: 100, dz: -100 });
const walled = director.getPlayerLocalPos();
check('D3.28 deck walls clamp |x| ≤ W/2 = 1.6 and z ≥ −7.0', walled.x === 1.6 && walled.z === -7.0);
const clamped = director.clampLocalToDeck({ x: 100, y: 3, z: 100 });
check('D3.29 clampLocalToDeck(±100) → (±1.6, 3, ±7.0)', clamped.x === 1.6 && clamped.z === 7.0 && clamped.y === 3);
const lw = director.localToWorld({ x: 100, y: 2.9, z: 100 });
const lwClamped = director.localToWorld({ x: 1.6, y: 2.9, z: 7 });
check('D3.30 localToWorld clamps off-deck points onto the deck edge', approx(lw.x, lwClamped.x, 1e-9) && approx(lw.z, lwClamped.z, 1e-9));

// -- vault hacking: 6.0 s hold-to-hack ------------------------------------------
const fresh = new TrainHeistDirector(dirMag, null);
check('D3.31 interactVaultLock refuses before boarding', fresh.interactVaultLock(hFrame()) === false);
check('D3.32 hack duration constant 6.0 s', VAULT_HACK_DURATION_S === 6.0);
let popFrame = -1;
for (let i = 0; i < 60 * 7 && popFrame < 0; i++) {
  if (director.interactVaultLock(hFrame())) popFrame = i;
}
check('D3.33 clamshell pops on the 6.0 s frame (360th tick)', popFrame >= 355 && popFrame <= 359, `frame=${popFrame}`);
check('D3.34 hack progress reads 1.0 at the pop', director.getHackProgress() === 1);
check('D3.35 pop lands the phase in LOOT_SECURED', director.getPhase() === 'LOOT_SECURED');
check('D3.36 loot table is the canonical 3 He-3 / 1 slate / 2 coils', LOOT_HE3_CRYO_FLASKS === 3 && LOOT_QUANTUM_CIPHER_SLATES === 1 && LOOT_SUPERCONDUCTING_COILS === 2 && JSON.stringify(director.getLootPayload()) === JSON.stringify({ he3CryoFlasks: 3, quantumCipherSlates: 1, superconductingCoils: 2 }));
check('D3.37 stolen cargo count reads 6', director.getStolenCargoCount() === 6 && director.getTelemetry().stolenCargoCount === 6);
check('D3.38 loot cargo mass 3·4.0 + 1·1.0 + 2·5.5 = 24 kg', heistLootCargoKg(director.getLootPayload()) === 24);
check('D3.39 alarm arms the depot countdown at exactly T-44.0 s', DEPOT_COUNTDOWN_S === 44.0 && director.getCountdownRemainingS() === 44.0 && director.getTelemetry().countdownRemainingS === 44.0);

// -- 44.0 s depot countdown -------------------------------------------------------
const tHand = director.update(hFrame(), roverMatch, 25);
check('D3.40 next tick hands LOOT_SECURED → DEPOT_COUNTDOWN', tHand.phase === 'DEPOT_COUNTDOWN' && director.getPhase() === 'DEPOT_COUNTDOWN');
for (let i = 0; i < 60; i++) director.update(hFrame(), roverMatch, 25);
check('D3.41 countdown drains at 1 s/s (T-43 after one second)', approx(director.getCountdownRemainingS(), 43.0, 1e-6));
check('D3.42 T-43 is not urgent; urgency starts at T-30', !director.isBailoutUrgent() && BAILOUT_WARNING_S === 30.0);
let t = director.getTelemetry();
for (let i = 0; i < 60 * 14 && t.countdownRemainingS > 29; i++) t = director.update(hFrame(), roverMatch, 25);
check('D3.43 past T-30 the red banner flag lights', director.isBailoutUrgent() && t.countdownRemainingS < 30);
// never bailing out vaporizes: expiry → FAILED
for (let i = 0; i < 60 * 40 && director.getPhase() !== 'FAILED'; i++) director.update(hFrame(), roverMatch, 25);
check('D3.44 countdown expiry = perimeter vaporization (FAILED)', director.getPhase() === 'FAILED' && director.getCountdownRemainingS() === 0);
check('D3.45 FAILED releases the tether and de-trains the avatar', !director.isAutopilotTetherActive() && !director.isPlayerOnBoard());
// NaN-garbage resilience
const nanDir = new TrainHeistDirector(dirMag, null);
nanDir.startHeist();
const phaseBefore = nanDir.getPhase();
let nanThrew = false;
try {
  nanDir.update(Number.NaN, { x: NaN, y: NaN, z: NaN }, { x: Number.NaN });
  nanDir.update(-1, roverMatch, Number.NaN);
  nanDir.interactVaultLock(Number.NaN);
} catch { nanThrew = true; }
check('D3.46 garbage input never throws, never transitions', !nanThrew && nanDir.getPhase() === phaseBefore);
const nanTele = nanDir.getTelemetry();
check('D3.47 telemetry fields stay finite under garbage input', Number.isFinite(nanTele.relativeSpeedMps) && Number.isFinite(nanTele.lateralDistanceM) && Number.isFinite(nanTele.countdownRemainingS));
// custom timing + loot overrides
const customMag = new HighSpeedMaglev();
for (let i = 0; i < 60 * 13; i++) customMag.update(hFrame());
const customDir = new TrainHeistDirector(customMag, null, { hackDurationS: 1.0, countdownS: 10.0, loot: { he3CryoFlasks: 1, quantumCipherSlates: 0, superconductingCoils: 0 } });
customDir.startHeist();
const customVault = customMag.getVaultCarState();
if (customVault !== null) {
  customDir.update(hFrame(), roverInEnvelope(customVault, 4.0), 25);
  customDir.executeBoardingJump();
}
let customPop = -1;
for (let i = 0; i < 120 && customPop < 0; i++) if (customDir.interactVaultLock(hFrame())) customPop = i;
check('D3.48 custom options honoured: 1 s hack, 1-item loot, T-10 clock', customPop >= 55 && customPop <= 59 && customDir.getStolenCargoCount() === 1 && customDir.getCountdownRemainingS() === 10.0);
customDir.dispose();
check('D3.49 disposed director refuses drivers but still answers queries', (() => {
  customDir.startHeist();
  return customDir.getPhase() === 'INACTIVE' && customDir.isDisposed() && Number.isFinite(customDir.getHackProgress());
})());
markDomain('director');
console.log(`  — domain 3 subtotal: ${passed - d3Start} assertions —`);

// ===========================================================================
section('DOMAIN 4 · Bailout Kinematics, Extraction & Audio-Visuals (blueprint §4 group 4)');
const d4Start = passed;
// ===========================================================================

// Fresh full stage: real citadel + maglev on a shared NullEngine scene.
const stageEngine = new NullEngine();
const stageScene = new Scene(stageEngine);
const sCitadel = new XCorpCitadel().init(stageScene);
const sMaglev = new HighSpeedMaglev().init(stageScene);
const sDirector = new TrainHeistDirector(sMaglev, sCitadel);
const doc4 = makeFakeDocument();
const hud4 = new LunarHUD({ document: doc4 as unknown as Document });
const attr4 = (k: string, n: string): string | null => hud4.getElement(k)?.getAttribute(n) ?? null;
const txt4 = (k: string): string => hud4.textOf(k);
const has4 = (k: string, c: string): boolean => hud4.hasClass(k, c);
const audio4 = new LunarAudioSystem();
void audio4.init();
check('D4.01 headless audio graph live (mock context)', audio4.isInitialized() && audio4.isHeadless());

sDirector.startHeist();
// run the train out to the interception corridor (40 s at the ramp law)
for (let i = 0; i < 60 * 40; i++) sMaglev.update(hFrame());
// ClientApp per-frame law: director → HUD → klaxon state
let phase: HeistPhase = sDirector.getPhase();
let boarded = false;
let popped = false;
let klaxonArmedAtPop = false;
for (let i = 0; i < 60 * 10 && !popped; i++) {
  const v = sMaglev.getVaultCarState();
  const rover = v === null ? { x: 0, y: 0, z: 0 } : roverInEnvelope(v, 4.0);
  const t4 = sDirector.update(hFrame(), rover, v === null ? 0 : v.speedMps);
  sMaglev.update(hFrame());
  hud4.updateHeistTelemetry(t4);
  audio4.setCitadelAlarmActive(t4.phase === 'DEPOT_COUNTDOWN');
  phase = t4.phase;
  if (!boarded && t4.canBoard) {
    boarded = sDirector.executeBoardingJump();
  }
  if (boarded && sDirector.interactVaultLock(hFrame())) {
    popped = true;
    // Pop-frame repaint: the director refreshes its telemetry snapshot the
    // instant the clamshell opens, exactly how ClientApp drives the HUD.
    hud4.updateHeistTelemetry(sDirector.getTelemetry());
    audio4.playMagLockDisengage();
    klaxonArmedAtPop = false; // klaxon only arms once DEPOT_COUNTDOWN ticks
  }
  void phase;
}
check('D4.02 full stage: intercept + board + crack complete', boarded && popped);
check('D4.03 contraband pill mirrors the 6-item haul on the HUD', txt4('heist-loot-count') === '×6' && !has4('heist-loot', 'is-hidden') && HUD_HEIST_LOOT_SLOTS === 6);
const tCD = sDirector.update(hFrame(), roverInEnvelope(sMaglev.getVaultCarState() ?? ({ worldForward: { x: 1, y: 0, z: 0 }, worldPosition: { x: 0, y: 0, z: 0 } } as unknown as MaglevCarState), 4.0), 25);
hud4.updateHeistTelemetry(tCD);
audio4.setCitadelAlarmActive(tCD.phase === 'DEPOT_COUNTDOWN');
check('D4.04 HUD shows the depot breach clock at T-44.0s', txt4('heist-countdown-value') === `T-${HUD_HEIST_COUNTDOWN_FULL_S.toFixed(1)}s` && HUD_HEIST_COUNTDOWN_FULL_S === 44.0 && HUD_HEIST_CRITICAL_S === 30.0);
check('D4.05 intrusion klaxon arms with DEPOT_COUNTDOWN (660↔880 Hz)', audio4.isCitadelAlarmActive() && !klaxonArmedAtPop);
const klTones = audio4.getCitadelAlarmTones();
check('D4.06 klaxon tone law: 770 ± 110 reproduces 660/880', klTones.lowHz === KLAXON_LOW_HZ && klTones.highHz === KLAXON_HIGH_HZ && KLAXON_LOW_HZ === 660 && KLAXON_HIGH_HZ === 880);
check('D4.07 mag-lock disengage timestamped (40 Hz sub-bass law)', Number.isFinite(audio4.getLastMagLockDisengageAt()) && MAGLOCK_THUD_HZ === 40);
// induction hum tracks the 25 m/s cruise
audio4.setMaglevInductionHum(1.0);
check('D4.08 guideway hum carrier pegs 280 Hz at full cruise', approx(audio4.getMaglevHumFrequencyHz(), MAGLEV_HUM_CEILING_HZ, 1e-6) && MAGLEV_HUM_FLOOR_HZ === 120 && MAGLEV_HUM_CEILING_HZ === 280);
audio4.playMaglevFlyby(25);
check('D4.09 Doppler flyby recorded for the 90 km/h serpent', (() => { const fb = audio4.getLastMaglevFlyby(); return fb !== null && approx(fb.speedMps, 25) && fb.dopplerRatio > 1; })());
check('D4.10 HUD data-phase mirrors the director machine', attr4('heist-panel', 'data-phase') === tCD.phase && tCD.phase === 'DEPOT_COUNTDOWN');

// tethered rover autopilot
const tether1 = sDirector.getTetheredRoverTargetPos();
const vaultNow4 = sMaglev.getVaultCarState();
if (vaultNow4 === null) { check('D4 vault present', false); process.exit(1); }
const vault4 = vaultNow4;
const tetherLat = Math.hypot(tether1.x - sMaglev.getPointAtDistance(vault4.distanceAlongSplineM).x, tether1.y - sMaglev.getPointAtDistance(vault4.distanceAlongSplineM).y);
check('D4.11 tether target stands 4.5 m starboard on the service road', approx(tetherLat, TETHER_STANDBOFF_M, 1e-6) && TETHER_STANDBOFF_M === 4.5 && approx(tether1.z, sMaglev.getServiceRoadPointAtDistance(vault4.distanceAlongSplineM).z, 1e-9));
for (let i = 0; i < 30; i++) sMaglev.update(hFrame());
const tether2 = sDirector.getTetheredRoverTargetPos();
check('D4.12 autopilot target recomputes with the moving train', vLen(vAdd(tether2, vScale(tether1, -1))) > 5 && sDirector.isAutopilotTetherActive());

// Freeze the maglev clock: read the vault frame and jump WITHOUT advancing
// the train, so v_train here is exactly what the director's jump solver saw.
const vaultB = sMaglev.getVaultCarState();
if (vaultB === null) {
  check('D4 bailout vault present', false);
  process.exit(1);
}
const fTan = vaultB.worldForward;
const trainSpeed = vaultB.speedMps;
check('D4.13 bailout refuses outside the escape window (fresh director)', (() => { const d5 = new TrainHeistDirector(sMaglev, null); d5.startHeist(); const r = d5.executeBailoutJump(); d5.dispose(); return r === false; })());
check('D4.14 Leap of Faith succeeds inside DEPOT_COUNTDOWN', sDirector.executeBailoutJump() === true && sDirector.getPhase() === 'BAILOUT_SUCCESS');
const vExit = sDirector.getBailoutExitVelocity();
const vTrain: V3 = { x: fTan.x * trainSpeed, y: fTan.y * trainSpeed, z: fTan.z * trainSpeed };
const lateralVec = vAdd(vExit, vScale(vTrain, -1));
check('D4.15 v_exit = v_train + v_lateral, exactly 4.0 m/s starboard', approx(vLen(lateralVec), BAILOUT_LATERAL_MPS, 1e-6) && BAILOUT_LATERAL_MPS === 4.0);
const starboard: V3 = (() => { const rl = Math.hypot(fTan.y, fTan.x) || 1; return { x: fTan.y / rl, y: -fTan.x / rl, z: 0 }; })();
check('D4.16 lateral launch vector points away from the guideway', dot3(lateralVec, starboard) > 3.999);
check('D4.17 launch keeps the train’s vertical component (no free-fall kick)', approx(vExit.z, vTrain.z, 1e-9) && vLen(vExit) > vLen(vTrain));
const tBailed = sDirector.update(hFrame(), tether1, 0);
hud4.updateHeistTelemetry(tBailed);
audio4.setCitadelAlarmActive(tBailed.phase === 'DEPOT_COUNTDOWN');
check('D4.18 BAILOUT_SUCCESS disarms the klaxon and retracts the countdown', !audio4.isCitadelAlarmActive() && has4('heist-countdown', 'is-hidden'));
// ballistic landing under lunar g: envelope outside the lethal threshold
const launchPoint = sDirector.getPlayerWorldPos();
const landing = ballisticLanding(launchPoint, vExit);
check('D4.19 ballistic arc lands on the regolith (lunar g = 1.62)', landing !== null && landing.z <= maglevTerrainElevationAt(landing.x, landing.y) + 1e-6);
if (landing !== null) {
  const travel = Math.hypot(landing.x - launchPoint.x, landing.y - launchPoint.y);
  check('D4.20 landing clears the consist by > 40 m of badlands', travel > 40, `${travel.toFixed(1)} m`);
  const seat4 = sCitadel.getWorldCenter();
  const landDist = Math.hypot(landing.x - seat4.x, landing.y - seat4.y);
  check('D4.21 landing envelope sits outside the 180 m lethal threshold', landDist > DEFAULT_LETHAL_RADIUS_M, `${landDist.toFixed(0)} m from the apex`);
  const landPerp = sCitadel.getPerimeterStatus(landing);
  check('D4.22 citadel perimeter answers ZERO force at the landing site', landPerp.repulsionForceN === 0 && !landPerp.inLethalZone);
}
check('D4.23 finishEscape hands off to ESCAPE_COMPLETE and releases the tether', sDirector.finishEscape() === true && sDirector.getPhase() === 'ESCAPE_COMPLETE' && !sDirector.isAutopilotTetherActive());
check('D4.24 reset() returns the stage to a pristine INACTIVE run', (() => { sDirector.reset(); const l = sDirector.getPlayerLocalPos(); return sDirector.getPhase() === 'INACTIVE' && sDirector.getStolenCargoCount() === 0 && l.x === 0 && l.y === 0 && l.z === 0; })());

// -- clean NullEngine stage disposal -------------------------------------------
check('D4.25 stage ran on NullEngine meshes (citadel + guideway built)', sCitadel.isBuilt() && sMaglev.isBuilt() && sCitadel.getMeshes().length + sMaglev.getMeshes().length > 380);
sCitadel.dispose();
sMaglev.dispose();
sDirector.dispose();
check('D4.26 stage dispose drains every mesh', sCitadel.getMeshes().length === 0 && sMaglev.getMeshes().length === 0 && !sCitadel.isBuilt() && !sMaglev.isBuilt());
let stageThrow = false;
try {
  sMaglev.update(hFrame());
  sCitadel.update(hFrame(), { x: 0, y: 0, z: 0 });
  void sDirector.getTetheredRoverTargetPos();
  void sDirector.getTelemetry();
  hud4.updateHeistTelemetry(tBailed);
  audio4.setCitadelAlarmActive(false);
  audio4.setMaglevInductionHum(0.5);
} catch { stageThrow = true; }
check('D4.27 post-dispose surfaces never throw (queries still answer)', !stageThrow && sDirector.isDisposed() && Number.isFinite(sMaglev.getTotalSplineLengthM()));
hud4.dispose();
audio4.dispose();
check('D4.28 HUD + audio teardown clean (isDisposed, no leaks)', hud4.isDisposed() && audio4.isDisposed() && hud4.getHeistTelemetry() === null);
engine.dispose();
stageEngine.dispose();
markDomain('bailout');
console.log(`  — domain 4 subtotal: ${passed - d4Start} assertions —`);

// ===========================================================================
// Verdict
// ===========================================================================
const d1 = domainCounts['citadel'] !== undefined ? domainCounts['citadel'] - d1Start : 0;
const d2 = domainCounts['maglev'] !== undefined ? domainCounts['maglev'] - d2Start : 0;
const d3 = domainCounts['director'] !== undefined ? domainCounts['director'] - d3Start : 0;
const d4 = domainCounts['bailout'] !== undefined ? domainCounts['bailout'] - d4Start : 0;
console.log(`\nDomain tallies — D1 citadel: ${d1} (≥25) · D2 maglev: ${d2} (≥30) · D3 director: ${d3} (≥35) · D4 bailout: ${d4} (≥20)`);
const budgetOk = d1 >= 25 && d2 >= 30 && d3 >= 35 && d4 >= 20 && passed >= 110;
if (!budgetOk) {
  console.error('ASSERTION BUDGET NOT MET (blueprint §4 per-domain minimums)');
}
if (failures.length === 0 && budgetOk) {
  console.log(`\nALL ${passed} CHECKS PASSED ✔  (Spec 26 Phase 6: X-Corp citadel & rail heist master gate)`);
  process.exit(0);
} else {
  console.error(`\n${failures.length} FAILURE(S) of ${passed}:`);
  for (const f of failures) console.error(`  ✘ ${f}`);
  process.exit(1);
}
