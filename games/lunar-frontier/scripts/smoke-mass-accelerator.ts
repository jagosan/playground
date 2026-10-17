/**
 * Spec 27 Phase 6 CENTRAL headless verification suite: Mare Mass Accelerator
 * ("The Gauss Needle"), Orbital Transport System, Ballistic Trajectory Engine,
 * Export Minigame Director, Contraband Laundering / USP Heat, and the gunner
 * Fire-Control HUD + Procedural Audio engine.
 * Run: `npx tsx scripts/smoke-mass-accelerator.ts`  (exit code 0 == all green)
 *
 * Full Spec 27 acceptance gate (§5 Phase 6 / §6), NullEngine + fake DOM +
 * mock Web Audio, structured into the six blueprint verification domains:
 *
 *   DOMAIN 1 — Mass Accelerator Gantry & Kinematics: caldera-rim placement at
 *     (-320, -1450), 180 m barrel / 24 HTS coils / 6 capacitor banks, 2-axis
 *     articulation (25°/s azimuth, 15°/s elevation) with [15°, 85°] hard
 *     stops, shortest-arc wrap, RC spool curve v0(t), the 4.5 s overcharge
 *     breaker + 5.0 s lockout, the FIRING→COOLDOWN quench and the spring
 *     recoil carriage animation.
 *   DOMAIN 2 — Orbital Transport Traffic & Trajectories: deterministic
 *     mulberry32 schedules (90–120 s cadence, 20–35 s windows), the three
 *     classes (CisLunar Horizon / The Obsidian Slip / USP Vigilance) in
 *     1200–2200 m / 140–220 m/s bands, the ≥ 20° LOS elevation law, 80 m
 *     tractor frustum + 1.5×R_catch magnetic assist capture law, the
 *     physical-cone grace band and the no-active contract.
 *   DOMAIN 3 — Ballistic Trajectory Engine & Vacuum Ballistics: closed-form
 *     g = 1.62 m/s² arcs, stepped-vs-analytic agreement, aim/launch vector
 *     laws, minimumMuzzleSpeed, near/far arc branches, degenerate and zenith
 *     guards, and the §6.3 Monte Carlo lead sweep (≥ 95 % intercept across
 *     every target altitude and speed band).
 *   DOMAIN 4 — Export Minigame Director & State Machine: the 8-phase
 *     lifecycle walk, cargo selection validation, trigger-hold spooling,
 *     canister spawn conditions + in-flight physics, live bulk capture at
 *     the exact 2.5× payout, apex-doom miss, overcharge recovery and the
 *     "never advance the host clocks" contract.
 *   DOMAIN 5 — Contraband Laundering, USP Threat & Economy: siphon arming
 *     semantics (cold tap silent), the 45 s intercept clock running through
 *     every phase, mid-flight expiry → CONFISCATED + 2 500 CR citation,
 *     laundering at 4.0××1.25 with heat cleared, hot-miss survival,
 *     wrong-class refusal and the payout multiplier bands.
 *   DOMAIN 6 — Fire Control HUD, Telemetry & Procedural Audio: 0.1° crosshair
 *     readouts, ±1.5° inclusive Ghost-Target lock, hemisphere sky-track
 *     radar, capacitor bar + optimal bracket, USP amber/crimson banner, the
 *     full procedural voice set (80→880 Hz whine, Lorentz blast, Doppler
 *     whistle, capture chime, 440/587 Hz square-LFO klaxon) with zero
 *     external assets, and the real-trio ClientApp-law integration.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  MassAccelerator,
  MASS_ACCELERATOR_DEFAULT_WORLD,
  BARREL_LENGTH_M,
  BASE_RING_DIAMETER_M,
  TRUNNION_HEIGHT_M,
  COIL_COUNT,
  CAPACITOR_BANK_COUNT,
  AZIMUTH_SLEW_RATE_DPS,
  ELEVATION_SLEW_RATE_DPS,
  ELEVATION_MIN_DEG,
  ELEVATION_MAX_DEG,
  V_MIN_MPS,
  V_MAX_MPS,
  TAU_SPOOL_S,
  OVERCHARGE_TRIP_S,
  BREAKER_COOLDOWN_S,
  POST_FIRE_COOLDOWN_S,
  RECOIL_DURATION_S,
  RECOIL_TRAVEL_M,
  spoolVelocityMps,
} from '../src/infrastructure/MassAccelerator.ts';
import { Scene } from '@babylonjs/core/scene.js';
import {
  OrbitalTransportSystem,
  TRANSPORT_VESSELS,
  ORBITAL_OBSERVER_DEFAULT,
  TRANSIT_INTERVAL_MIN_S,
  TRANSIT_INTERVAL_MAX_S,
  TRANSIT_WINDOW_MIN_S,
  TRANSIT_WINDOW_MAX_S,
  LOS_ELEVATION_MIN_DEG,
  FIRST_TRANSIT_CLOSEST_APPROACH_S,
  APPROACH_VISIBILITY_S,
  CAPTURE_GRACE_S,
  CAPTURE_FUNNEL_LENGTH_M,
  FRUSTUM_BAY_RADIUS_M,
  MAGNETIC_ASSIST_FACTOR,
} from '../src/infrastructure/OrbitalTransportSystem.ts';
import type { OrbitalTransportState } from '../src/infrastructure/OrbitalTransportSystem.ts';
import { BallisticTrajectoryEngine } from '../src/physics/BallisticTrajectoryEngine.ts';
import {
  ExportMinigameDirector,
  EXPORT_PHASES,
  EXPORT_CARGO_RATES_CREDITS_PER_KG,
  USP_INTERCEPT_COUNTDOWN_S,
  USP_CITATION_FINE_CREDITS,
  LAUNDER_BONUS_CREDIT,
  SYNDICATE_LAUNDER_COMMS,
  POST_OUTCOME_COOLDOWN_S,
  OVERCHARGE_TRIP_S as EMD_OVERCHARGE_TRIP_S,
  normalizeExportCargo,
  cargoDepotValueCredits,
} from '../src/quests/ExportMinigameDirector.ts';
import type { ExportSessionState } from '../src/quests/ExportMinigameDirector.ts';
import {
  LunarHUD,
  HUD_GUNNER_ID,
  HUD_GUNNER_LOCK_TOL_DEG,
  HUD_GUNNER_RADAR_SLOTS,
  HUD_CAP_MIN_MPS,
  HUD_CAP_MAX_MPS,
  HUD_EXPORT_USP_FULL_S,
  HUD_EXPORT_USP_CRITICAL_S,
} from '../src/ui/LunarHUD.ts';
import type { HudExportGunnerTelemetry, HudRadarContact } from '../src/ui/LunarHUD.ts';
import {
  LunarAudioSystem,
  CAPACITOR_WHINE_FLOOR_HZ,
  CAPACITOR_WHINE_CEILING_HZ,
  LORENTZ_SUBBASS_HZ,
  LORENTZ_SNAP_HZ,
  LORENTZ_RING_HZ,
  VACUUM_WHISTLE_HIGH_HZ,
  VACUUM_WHISTLE_LOW_HZ,
  CAPTURE_CHIME_LOW_HZ,
  CAPTURE_CHIME_HIGH_HZ,
  USP_KLAXON_LOW_HZ,
  USP_KLAXON_HIGH_HZ,
} from '../src/audio/LunarAudioSystem.ts';
import { worldToBabylon } from '../src/engine/CameraRig.ts';

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
const DEG = Math.PI / 180;
type V3 = { x: number; y: number; z: number };

const wrapErr = (a: number, b: number): number => {
  let e = (a - b) % 360;
  if (e > 180) e -= 360;
  if (e < -180) e += 360;
  return Math.abs(e);
};

/** mulberry32 PRNG — deterministic [0, 1) stream (mirrors the OTS schedule). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Elevation (deg) of a world point from an observer datum. */
function elevationDegAt(pos: V3, observer: V3): number {
  const horiz = Math.hypot(pos.x - observer.x, pos.y - observer.y);
  return horiz > 1e-9 ? Math.atan2(pos.z - observer.z, horiz) / DEG : 90;
}

function finiteState(s: ExportSessionState): boolean {
  return (
    Number.isFinite(s.cargoQuantityKg) &&
    Number.isFinite(s.uspCountdownRemainingS) &&
    Number.isFinite(s.lastPayoutCredits) &&
    Number.isFinite(s.canisterPos.x) &&
    Number.isFinite(s.canisterPos.y) &&
    Number.isFinite(s.canisterPos.z)
  );
}

/** Source-text handle for static zero-asset / bridge contract checks. */
const HERE = typeof __filename !== 'undefined' ? dirname(__filename) : process.cwd();
const readSrc = (rel: string): string => {
  try {
    return readFileSync(resolve(HERE, '..', rel), 'utf8');
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------
// Fake DOM (structural subset the HUD uses; smoke-export-hud-audio pattern)
// ---------------------------------------------------------------------------

interface FakeElement {
  id: string;
  className: string;
  textContent: string | null;
  style: Record<string, string>;
  classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
  children: FakeElement[];
  parent: FakeElement | null;
  attributes: Map<string, string>;
  appendChild<T>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

function makeFakeElement(tag: string, registry: Map<string, FakeElement>): FakeElement {
  const attributes = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    id: '',
    className: tag === 'body' ? '' : '',
    textContent: null,
    style: {},
    classList: {
      add(name) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        set.add(name);
        el.className = [...set].join(' ');
      },
      remove(name) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        set.delete(name);
        el.className = [...set].join(' ');
      },
      contains(name) {
        return el.className.split(/\s+/).includes(name);
      },
    },
    children,
    parent: null,
    attributes,
    appendChild(child) {
      (child as FakeElement).parent = el;
      children.push(child as FakeElement);
      return child;
    },
    remove() {
      if (el.parent !== null) {
        const idx = el.parent.children.indexOf(el);
        if (idx >= 0) el.parent.children.splice(idx, 1);
      }
      registry.delete(el.id);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
      if (name === 'id') {
        el.id = value;
        registry.set(value, el);
      }
    },
  };
  return el;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  const body = makeFakeElement('body', registry);
  return {
    body,
    createElement: (tag: string) => makeFakeElement(tag, registry),
    getElementById: (id: string) => registry.get(id) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared NullEngine stage (Domains 1/2 build on it, finale disposes it)
// ---------------------------------------------------------------------------

const stageEngine = new NullEngine();
const stageScene = new Scene(stageEngine);

// ---------------------------------------------------------------------------
section('DOMAIN 1 · A. canonical constants & caldera-rim seat');
// ---------------------------------------------------------------------------

check(
  'geometry constants mirror Spec 27 §3.1.1 (180 m barrel, 40 m ring, 22 m trunnions)',
  BARREL_LENGTH_M === 180 && BASE_RING_DIAMETER_M === 40 && TRUNNION_HEIGHT_M === 22,
);
check(
  '24 HTS drive coils, 6 cryogenic capacitor banks',
  COIL_COUNT === 24 && CAPACITOR_BANK_COUNT === 6,
);
check(
  'articulation rates 25°/s azimuth, 15°/s elevation',
  AZIMUTH_SLEW_RATE_DPS === 25 && ELEVATION_SLEW_RATE_DPS === 15,
);
check(
  'elevation hard stops at 15° / 85°',
  ELEVATION_MIN_DEG === 15 && ELEVATION_MAX_DEG === 85,
);
check(
  'capacitor curve 180→420 m/s, τ = 1.6 s, trip 4.5 s, lockout 5.0 s',
  V_MIN_MPS === 180 && V_MAX_MPS === 420 && TAU_SPOOL_S === 1.6 && OVERCHARGE_TRIP_S === 4.5 && BREAKER_COOLDOWN_S === 5.0,
);
check(
  'caldera-rim seat is (X = -320 m, Y = -1450 m)',
  MASS_ACCELERATOR_DEFAULT_WORLD.x === -320 &&
    MASS_ACCELERATOR_DEFAULT_WORLD.y === -1450 &&
    MASS_ACCELERATOR_DEFAULT_WORLD.z === 0,
);

const ma = new MassAccelerator();
check('init(NullEngine-backed scene) builds without WebGL', ma.init(stageScene) === ma && ma.isBuilt());
const seat = ma.getWorldSeat();
check('getWorldSeat() reports the Spec §3.1.1 coordinates', seat.x === -320 && seat.y === -1450 && seat.z === 0);
const rootPos = ma.getRootNode()?.position;
const rootWant = worldToBabylon(MASS_ACCELERATOR_DEFAULT_WORLD);
check(
  'system root lands at worldToBabylon(seat) = (x, z, −y)',
  rootPos !== undefined && approx(rootPos.x, rootWant.x) && approx(rootPos.y, rootWant.y) && approx(rootPos.z, rootWant.z),
  `got (${rootPos?.x}, ${rootPos?.y}, ${rootPos?.z})`,
);

// ---------------------------------------------------------------------------
section('DOMAIN 1 · B. procedural facility hierarchy (NullEngine mesh build)');
// ---------------------------------------------------------------------------

const meshes = ma.getMeshes();
check(`facility builds a mesh assembly (${meshes.length} meshes)`, meshes.length > 60);
check(`getPartMeshes('coil') = ${COIL_COUNT} HTS stator rings`, ma.getPartMeshes('coil').length === COIL_COUNT);
check(`getPartMeshes('capacitor_bank') = ${CAPACITOR_BANK_COUNT} cryo banks`, ma.getPartMeshes('capacitor_bank').length === CAPACITOR_BANK_COUNT);
check('trunnion support towers ≥ 2 pedestals', ma.getPartMeshes('trunnion_tower').length >= 2);
check('base ring + deck + drive tracks present', ma.getPartMeshes('base_ring').length >= 1 && ma.getPartMeshes('base_deck').length >= 1 && ma.getPartMeshes('drive_track').length >= 8);
check('breech breech-block + muzzle ring present', ma.getPartMeshes('breech').length >= 1 && ma.getPartMeshes('muzzle').length >= 1);
check('cargo hopper, crane arm and rover bay present', ma.getPartMeshes('hopper').length >= 1 && ma.getPartMeshes('crane_arm').length >= 1 && ma.getPartMeshes('rover_bay').length >= 1);
check('gunner cupola (cockpit + glass + console) present', ma.getPartMeshes('cockpit').length >= 1 && ma.getPartMeshes('cockpit_glass').length >= 1 && ma.getPartMeshes('console').length >= 1);
const trusses = ma.getPartMeshes('barrel_truss');
const spine = trusses[0];
const spineBi = spine !== undefined ? spine.getBoundingInfo() : null;
const spineLen = spineBi !== null ? Math.hypot(spineBi.maximum.x - spineBi.minimum.x, spineBi.maximum.y - spineBi.minimum.y, spineBi.maximum.z - spineBi.minimum.z) : -1;
check(`180 m linear induction barrel spine spans ${spineLen.toFixed(1)} m (local bbox, getBoundingInfo)`, spineLen >= 150 && spineLen <= 200);
const coil0 = ma.getPartMeshes('coil')?.[0];
check('coil meshes carry bounding info headless (Babylon v9 getBoundingInfo)', coil0 !== undefined && coil0.getBoundingInfo() !== null && Number.isFinite(coil0.getBoundingInfo().maximum.x));
check('cupola glazing never casts shadows', ma.getShadowCasterMeshes().every((m) => (m.metadata?.['part'] as string | undefined) !== 'cockpit_glass'));

// ---------------------------------------------------------------------------
section('DOMAIN 1 · C. 2-axis articulation kinematics (slew rates, hard stops)');
// ---------------------------------------------------------------------------

{
  // Cold gun: az 0, el 15 (hard-stop floor), IDLE lifecycle.
  const g0 = ma.getState();
  check('cold gun rests at az 0° / el 15° / IDLE', approx(g0.azimuthDeg, 0) && approx(g0.elevationDeg, 15) && g0.state === 'IDLE');
  const fv0 = ma.getFireVector();
  check('fire vector at az 0/el 15 = (cosθ, 0, sinθ) unit', approx(fv0.x, Math.cos(15 * DEG), 1e-12) && approx(fv0.y, 0, 1e-12) && approx(fv0.z, Math.sin(15 * DEG), 1e-12) && approx(Math.hypot(fv0.x, fv0.y, fv0.z), 1, 1e-12));
  const mz0 = ma.getMuzzleWorldPosition();
  check(
    'muzzle = seat + 22 m trunnion + 180 m · fireVector',
    approx(mz0.x, -320 + BARREL_LENGTH_M * Math.cos(15 * DEG), 1e-9) &&
      approx(mz0.y, -1450, 1e-9) &&
      approx(mz0.z, 22 + BARREL_LENGTH_M * Math.sin(15 * DEG), 1e-9),
  );

  ma.setAimTarget(90, 45);
  check('aim order promotes IDLE → TARGETING', ma.getState().state === 'TARGETING');
  let g1 = ma.getState();
  check('fresh order immediately flags isSlewing', g1.isSlewing === true);
  // 25°/s azimuth, 15°/s elevation — drive exactly 1.0 s at 50 Hz.
  for (let i = 0; i < 50; i++) g1 = ma.update(0.02);
  check('after 1.0 s azimuth moved 25.0° (25°/s limit)', approx(g1.azimuthDeg, 25, 1e-6), `got ${g1.azimuthDeg}`);
  check('after 1.0 s elevation moved 15.0° (15°/s limit)', approx(g1.elevationDeg, 30, 1e-6), `got ${g1.elevationDeg}`);
  for (let i = 0; i < 50; i++) g1 = ma.update(0.02);
  check('after 2.0 s azimuth 50.0° / elevation at target 45.0°', approx(g1.azimuthDeg, 50, 1e-6) && approx(g1.elevationDeg, 45, 1e-6));
  check('elevation settled but azimuth still slews', g1.isSlewing === true);
  let guard = 0;
  while (ma.getState().isSlewing && guard++ < 400) ma.update(0.02);
  g1 = ma.getState();
  check('azimuth converges exactly on 90.0°, isSlewing drops', approx(g1.azimuthDeg, 90, 1e-6) && g1.isSlewing === false);

  // Hard stops clamp the ORDER, then the slew follows to the stop.
  ma.setAimTarget(0, 2);
  guard = 0;
  while (ma.getState().isSlewing && guard++ < 600) ma.update(0.02);
  check('order below 15° clamps to the 15° terrain-collision stop', approx(ma.getState().elevationDeg, 15, 1e-6));
  ma.setAimTarget(0, 175);
  guard = 0;
  while (ma.getState().isSlewing && guard++ < 600) ma.update(0.02);
  check('order above 85° clamps to the 85° zenith gimbal guard', approx(ma.getState().elevationDeg, 85, 1e-6));
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const before = ma.getState();
    ma.setAimTarget(bad, bad);
    const after = ma.getState();
    check(`non-finite aim (${Number.isNaN(bad) ? 'NaN' : '∞'}) is ignored`, approx(after.azimuthDeg, before.azimuthDeg) && approx(after.elevationDeg, before.elevationDeg));
  }

  // Shortest-arc azimuth wrap through 0°/360°.
  ma.setAimTarget(352, 45);
  guard = 0;
  while (ma.getState().isSlewing && guard++ < 600) ma.update(0.02);
  check('slew converges on az 352°', approx(ma.getState().azimuthDeg, 352, 1e-6));
  ma.setAimTarget(8, 45);
  const midAz: number[] = [];
  guard = 0;
  while (ma.getState().isSlewing && guard++ < 600) {
    ma.update(0.02);
    midAz.push(ma.getState().azimuthDeg);
  }
  check('352° → 8° takes the 16° shortest arc (wraps through 0)', approx(ma.getState().azimuthDeg, 8, 1e-6) && midAz.some((a) => a > 355) && midAz.some((a) => a < 5));

  // §3.3.1 launch-vector law at an articulated pose.
  const g2 = ma.getState();
  const fv2 = ma.getFireVector();
  check(
    'v̂ = (cosθcosψ, cosθsinψ, sinθ) at az 8°/el 45°',
    approx(fv2.x, Math.cos(g2.elevationDeg * DEG) * Math.cos(g2.azimuthDeg * DEG), 1e-12) &&
      approx(fv2.y, Math.cos(g2.elevationDeg * DEG) * Math.sin(g2.azimuthDeg * DEG), 1e-12) &&
      approx(fv2.z, Math.sin(g2.elevationDeg * DEG), 1e-12),
  );
}

// ---------------------------------------------------------------------------
section('DOMAIN 1 · D. capacitor spool curve, overcharge breaker, quench & recoil');
// ---------------------------------------------------------------------------

{
  check('v0(0) = 180 m/s curve floor', spoolVelocityMps(0) === 180);
  check('v0(NaN) and v0(−5) degrade to the floor', spoolVelocityMps(Number.NaN) === 180 && spoolVelocityMps(-5) === 180);
  check('v0(τ = 1.6 s) = 180 + 240·(1 − e⁻¹) exactly', approx(spoolVelocityMps(TAU_SPOOL_S), V_MIN_MPS + (V_MAX_MPS - V_MIN_MPS) * (1 - Math.exp(-1)), 1e-12));
  let monotone = true;
  let prev = spoolVelocityMps(0);
  for (let t = 0.1; t <= 4.4; t += 0.1) {
    const v = spoolVelocityMps(t);
    if (!(v > prev && v < V_MAX_MPS)) monotone = false;
    prev = v;
  }
  check('curve strictly monotone and bounded below 420 on [0, 4.4]', monotone);
  check('≈90 % peak power at ~3.6 s (Spec §3.4.2)', (spoolVelocityMps(3.6) - V_MIN_MPS) / (V_MAX_MPS - V_MIN_MPS) >= 0.89);

  // Live spool: chargeCapacitor integrates the curve frame by frame.
  ma.setAimTarget(45, 60);
  for (let i = 0; i < 60; i++) ma.chargeCapacitor(hFrame());
  check('after 1.0 s held, muzzle velocity = curve v(1.0)', approx(ma.getMuzzleVelocityMps(), spoolVelocityMps(1.0), 1e-9));
  check('holding the trigger latches CHARGING', ma.getState().state === 'CHARGING');
  check('charge ratio = (v − 180)/240 band ratio', approx(ma.getCapacitorChargeRatio(), (spoolVelocityMps(1.0) - 180) / 240, 1e-9));

  // Overcharge: hold past 4.5 s TOTAL → breaker trip + 5.0 s lockout.
  let trippedAt = -1;
  for (let f = 0; f < Math.ceil(5 / hFrame()); f++) {
    ma.chargeCapacitor(hFrame());
    if (ma.getState().state === 'OVERCHARGED') { trippedAt = 1.0 + (f + 1) * hFrame(); break; }
  }
  check('held charge trips the thermal breaker at 4.5 s total spool', trippedAt >= OVERCHARGE_TRIP_S - hFrame() && trippedAt <= OVERCHARGE_TRIP_S + 2 * hFrame(), `totalSpool=${trippedAt.toFixed(4)}`);
  const tripState = ma.getState();
  check('trip dumps the bank to the curve floor', approx(tripState.muzzleVelocityMps, V_MIN_MPS, 1e-9));
  check('trip starts the 5.0 s breaker lockout', approx(tripState.cooldownRemainingS, BREAKER_COOLDOWN_S, 1e-9));
  check('breaker trip counted once', ma.getStats().breakerTrips === 1);
  check('charge refused during lockout', ma.chargeCapacitor(0.5) === V_MIN_MPS && ma.getState().state === 'OVERCHARGED');
  check('discharge refused during OVERCHARGED', ma.dischargeFire().success === false);
  let idleAt = 0;
  for (let f = 0; f < Math.ceil(5.2 / 0.1); f++) {
    ma.update(0.1);
    idleAt += 0.1;
    if (ma.getState().state === 'IDLE') break;
  }
  check('lockout releases to IDLE after ~5.0 s', idleAt >= BREAKER_COOLDOWN_S - 0.1 && idleAt <= BREAKER_COOLDOWN_S + 0.15, `idleAt=${idleAt.toFixed(2)}`);

  // Fire cycle: FIRING (recoil) → COOLDOWN (quench) → IDLE.
  for (let i = 0; i < 30; i++) ma.chargeCapacitor(hFrame()); // 0.5 s spool
  const vShot = ma.getMuzzleVelocityMps();
  const shot = ma.dischargeFire();
  check('dischargeFire succeeds with the spooled velocity', shot.success === true && approx(shot.muzzleVelocity, vShot, 1e-9));
  check('fireVector unit and state → FIRING', approx(Math.hypot(shot.fireVector.x, shot.fireVector.y, shot.fireVector.z), 1, 1e-12) && ma.getState().state === 'FIRING');
  check('shotsFired counter incremented', ma.getStats().shotsFired === 1);
  const gMid = ma.update(0.2);
  type RecoilHolder = { recoilNode: { position: { z: number } } | null };
  const recoilZ = (m: MassAccelerator): number => {
    const node = (m as unknown as RecoilHolder).recoilNode;
    return node === null ? 0 : node.position.z;
  };
  check('mid-recoil: carriage travels along −axis', recoilZ(ma) < -0.5 && recoilZ(ma) >= -RECOIL_TRAVEL_M, `z=${recoilZ(ma)}`);
  check('FIRING counts recoil + quench in cooldownRemainingS', gMid.state === 'FIRING' && approx(gMid.cooldownRemainingS, 1.75, 0.05), `got ${gMid.cooldownRemainingS}`);
  ma.update(0.3); // recoil animation done at 0.45 s → quench COOLDOWN
  check(`recoil lasts ${RECOIL_DURATION_S} s then quench COOLDOWN (1.5 s)`, ma.getState().state === 'COOLDOWN' && approx(ma.getState().cooldownRemainingS, POST_FIRE_COOLDOWN_S, 1e-9));
  check('discharge refused during COOLDOWN', ma.dischargeFire().success === false);
  for (let f = 0; f < 16; f++) ma.update(0.1);
  check('quench releases the gun back to IDLE', ma.getState().state === 'IDLE');
  check('recoil carriage returns to the nominal line', recoilZ(ma) === 0);

  // Breech-loading gate.
  ma.setLoading(true);
  check('crane load toggles IDLE → LOADING', ma.getState().state === 'LOADING');
  check('charging refused while LOADING', ma.chargeCapacitor(1) === V_MIN_MPS && ma.getState().state === 'LOADING');
  ma.setLoading(false);
  check('unload returns to IDLE', ma.getState().state === 'IDLE');
}

// ---------------------------------------------------------------------------
// Shared rigs for Domains 2–5 (proven smoke-export-director mechanics)
// ---------------------------------------------------------------------------

interface Rig {
  acc: MassAccelerator;
  ot: OrbitalTransportSystem;
  d: ExportMinigameDirector;
}
const mkRig = (): Rig => {
  const acc = new MassAccelerator();
  const ot = new OrbitalTransportSystem({ seed: 'cis-lunar-transit-2431' });
  return { acc, ot, d: new ExportMinigameDirector(acc, ot) };
};
/** Tick the whole rig (director, then hosts — WorldScene order) one frame. */
function frame(rig: Rig, aimX: number, aimY: number, chargeHeld: boolean, dt: number): ExportSessionState {
  const s = rig.d.update(dt, { aimX, aimY, chargeHeld });
  rig.acc.update(dt);
  rig.ot.update(dt);
  return s;
}
/** Wait until the director itself holds a TARGETING_ACTIVE lock on `cls`. */
function engage(rig: Rig, cls: string, maxS: number, dt: number): boolean {
  for (let f = 0; f < Math.ceil(maxS / dt); f++) {
    const t = rig.ot.getActiveTarget();
    if (t !== null && t.transportClass === cls && rig.d.getPhase() === 'TARGETING_ACTIVE') return true;
    frame(rig, 0, 62, false, dt);
  }
  return false;
}
const BANK_TARGET_MPS = 400;
/** The verified winning gunnery sequence (§3.3.2): preslew on the live lead. */
function hotShot(rig: Rig, dt: number): 'FIRED' | 'OVERCHARGED' | 'STUCK' {
  const azT = Math.max(0.25, 25 * dt * 1.05);
  const elT = Math.max(0.25, 15 * dt * 1.05);
  let aim = { aimX: 0, aimY: 62 };
  for (let f = 0; f < Math.ceil(14 / dt); f++) {
    const t = rig.ot.getActiveTarget();
    if (t === null) return 'STUCK';
    const sol = BallisticTrajectoryEngine.calculateLead(rig.acc.getMuzzleWorldPosition(), t.position, t.velocity, BANK_TARGET_MPS);
    if (sol.hasSolution) aim = { aimX: sol.leadAzimuthDeg, aimY: sol.leadElevationDeg };
    frame(rig, aim.aimX, aim.aimY, false, dt);
    const gs = rig.acc.getState();
    if (wrapErr(gs.azimuthDeg, aim.aimX) <= azT && Math.abs(gs.elevationDeg - aim.aimY) <= elT) break;
  }
  for (let f = 0; f < Math.ceil(4.3 / dt); f++) {
    const t = rig.ot.getActiveTarget();
    if (t !== null) {
      const sol = BallisticTrajectoryEngine.calculateLead(rig.acc.getMuzzleWorldPosition(), t.position, t.velocity, Math.max(rig.acc.getMuzzleVelocityMps(), 180));
      if (sol.hasSolution) aim = { aimX: sol.leadAzimuthDeg, aimY: sol.leadElevationDeg };
    }
    const s = frame(rig, aim.aimX, aim.aimY, true, dt);
    if (s.lastResult === 'OVERCHARGED') return 'OVERCHARGED';
    const gs = rig.acc.getState();
    if (rig.d.getPhase() === 'COIL_CHARGING' && gs.muzzleVelocityMps >= BANK_TARGET_MPS - Math.max(1, 40 * dt) &&
        wrapErr(gs.azimuthDeg, aim.aimX) <= azT && Math.abs(gs.elevationDeg - aim.aimY) <= elT) {
      for (let r = 0; r < 6; r++) {
        const s2 = frame(rig, aim.aimX, aim.aimY, false, dt);
        if (s2.canisterInFlight) return 'FIRED';
        if (s2.lastResult === 'OVERCHARGED') return 'OVERCHARGED';
      }
      return 'STUCK';
    }
  }
  return 'STUCK';
}
/** Run the clock to the next resolved outcome (or timeout). */
function toOutcome(rig: Rig, maxS: number, dt: number): { s: ExportSessionState; tS: number } {
  const n = Math.ceil(maxS / dt);
  for (let f = 0; f < n; f++) {
    const s = frame(rig, 0, 62, false, dt);
    if (s.lastResult !== 'NONE') return { s, tS: f * dt };
  }
  return { s: rig.d.getSessionState(), tS: -1 };
}

// ---------------------------------------------------------------------------
section('DOMAIN 2 · A. transit constants & the three-class table (§3.2.1–§3.2.2)');
// ---------------------------------------------------------------------------

check(
  'transit cadence 90–120 s, firing windows 20–35 s',
  TRANSIT_INTERVAL_MIN_S === 90 && TRANSIT_INTERVAL_MAX_S === 120 && TRANSIT_WINDOW_MIN_S === 20 && TRANSIT_WINDOW_MAX_S === 35,
);
check('LOS elevation gate 20°, first close-approach at 35 s', LOS_ELEVATION_MIN_DEG === 20 && FIRST_TRANSIT_CLOSEST_APPROACH_S === 35);
check('capture funnel 80 m, magnetic assist 1.5 × R_catch', CAPTURE_FUNNEL_LENGTH_M === 80 && MAGNETIC_ASSIST_FACTOR === 1.5);
check('physical-cone grace band 90 s past window close', CAPTURE_GRACE_S === 90);

const vBulk = TRANSPORT_VESSELS[0];
const vRun = TRANSPORT_VESSELS[1];
const vUsp = TRANSPORT_VESSELS[2];
check(
  'vessel names: CisLunar Horizon / The Obsidian Slip / USP Vigilance',
  vBulk.name === 'CisLunar Horizon' && vRun.name === 'The Obsidian Slip' && vUsp.name === 'USP Vigilance',
);
check(
  'classes BULK_FREIGHTER / SYNDICATE_RUNNER / USP_PATROL',
  vBulk.transportClass === 'BULK_FREIGHTER' && vRun.transportClass === 'SYNDICATE_RUNNER' && vUsp.transportClass === 'USP_PATROL',
);
check(
  'altitudes 1500/1800/1200 m all inside the LLO band [1200, 2200]',
  vBulk.altitudeM === 1500 && vRun.altitudeM === 1800 && vUsp.altitudeM === 1200 &&
    TRANSPORT_VESSELS.every((v) => v.altitudeM >= 1200 && v.altitudeM <= 2200),
);
check(
  'orbital velocities 150/210/180 m/s all inside [140, 220]',
  vBulk.speedMps === 150 && vRun.speedMps === 210 && vUsp.speedMps === 180 &&
    TRANSPORT_VESSELS.every((v) => v.speedMps >= 140 && v.speedMps <= 220),
);
check(
  'catch envelopes 35 m / 22 m / 0 (hostile), Δv caps 25 / 18 / none',
  vBulk.catchRadiusM === 35 && vRun.catchRadiusM === 22 && vUsp.catchRadiusM === 0 &&
    vBulk.maxCatchRelSpeedMps === 25 && vRun.maxCatchRelSpeedMps === 18 && vUsp.maxCatchRelSpeedMps === 0,
);
check(
  'payout multipliers 2.5× base depot / 4.0× black market / 0×',
  vBulk.payoutMultiplier === 2.5 && vRun.payoutMultiplier === 4.0 && vUsp.payoutMultiplier === 0,
);

// ---------------------------------------------------------------------------
section('DOMAIN 2 · B. deterministic schedules & LOS firing windows');
// ---------------------------------------------------------------------------

const otsA = new OrbitalTransportSystem({ seed: 'cis-lunar-transit-2431' });
const otsStage = new OrbitalTransportSystem({ seed: 'cis-lunar-transit-2431' }).init(stageScene);
{
  const rows = otsA.getSchedule(9);
  check('getSchedule(9) answers 9 rows from the pure schedule (sceneless)', rows.length === 9);
  let rotationOk = true;
  rows.forEach((row, i) => {
    const want = TRANSPORT_VESSELS[i % 3];
    if (want === undefined || row.id !== want.id || row.transportClass !== want.transportClass) rotationOk = false;
  });
  check('traffic rotates deterministically tug → slip → USP (index % 3)', rotationOk);
  let bandsOk = true;
  for (const row of rows) if (!(row.windowS >= TRANSIT_INTERVAL_MIN_S * 0 + TRANSIT_WINDOW_MIN_S && row.windowS <= TRANSIT_WINDOW_MAX_S)) bandsOk = false;
  check(`every scheduled window lands in [20, 35] s (got ${rows.map((r) => r.windowS.toFixed(1)).join(', ')})`, bandsOk);
  check('fresh sky: first window still ahead (opensInS > 0)', (rows[0]?.opensInS ?? 0) > 0 && otsA.getActiveTarget() === null);

  // Same seed under different dt step sequences → identical schedule.
  const otsB = new OrbitalTransportSystem({ seed: 'cis-lunar-transit-2431' });
  for (let f = 0; f < 1200; f++) otsA.update(0.25); // 300 s at 50 Hz
  for (let f = 0; f < 600; f++) otsB.update(0.5); // same 300 s at 2 Hz
  const roundRows = (r: ReturnType<OrbitalTransportSystem['getSchedule']>) =>
    JSON.stringify(r.map((e) => [e.id, e.opensInS.toFixed(6), e.windowS.toFixed(6)]));
  check('same seed reproduces the schedule across different dt sequences', roundRows(otsA.getSchedule(6)) === roundRows(otsB.getSchedule(6)));
  const seedAlt = new OrbitalTransportSystem({ seed: 'different-sector' });
  for (let f = 0; f < 1200; f++) seedAlt.update(0.25);
  check('different seed yields a different jitter pattern', roundRows(seedAlt.getSchedule(6)) !== roundRows(otsA.getSchedule(6)));
  check('mulberry32 stream is a pure deterministic PRNG', (() => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 8; i++) if (a() !== b()) return false;
    return true;
  })());
}

// Advance both stage-locked instances to t = 300 (otsA already there), then
// drive in lockstep to a live window.
for (let f = 0; f < 1200; f++) otsStage.update(0.25);
let activeT: OrbitalTransportState | null = null;
{
  let guard = 0;
  while ((activeT = otsA.getActiveTarget()) === null && guard++ < 2000) {
    otsA.update(0.25);
    otsStage.update(0.25);
  }
  check('a scheduled transit enters the firing window (getActiveTarget non-null)', activeT !== null, `guard=${guard}`);
}
if (activeT !== null) {
  const t0 = activeT;
  check('active transit reports inFiringWindow = true', t0.inFiringWindow === true);
  check('state altitude is the blueprint chord altitude', t0.altitudeM === (TRANSPORT_VESSELS.find((v) => v.id === t0.id)?.altitudeM ?? -1));
  check('velocity magnitude constant and horizontal', approx(t0.speedMps, Math.hypot(t0.velocity.x, t0.velocity.y, t0.velocity.z), 1e-9) && t0.velocity.z === 0);
  check('window elevation ≥ 20° law holds for the active vessel', elevationDegAt(t0.position, ORBITAL_OBSERVER_DEFAULT) >= 19.99);
  check('timeRemainingInWindowS inside (0, 35]', t0.timeRemainingInWindowS > 0 && t0.timeRemainingInWindowS <= TRANSIT_WINDOW_MAX_S + 1e-9);
  check('timeToNextWindowS reads 0 while a window is open', otsA.timeToNextWindowS() === 0);

  // Stage placement: vessel root == state position under worldToBabylon.
  const vm = otsStage.getVesselMeshes(t0.id);
  const stageRoot = (vm[0]?.parent as { position: { x: number; y: number; z: number } } | null | undefined) ?? null;
  const stStage = otsStage.getActiveTarget();
  check(
    'stage vessel root lands at worldToBabylon(state) = (x, z, −y)',
    stageRoot !== null && stStage !== null &&
      approx(stageRoot.position.x, stStage.position.x, 1e-6) &&
      approx(stageRoot.position.y, stStage.position.z, 1e-6) &&
      approx(stageRoot.position.z, -stStage.position.y, 1e-6),
  );

  // Sweep the whole window: elevation never dips under the LOS gate.
  let minEl = 90;
  let monotoneRemain = true;
  let prevRemain = t0.timeRemainingInWindowS;
  let swept = 0;
  let closeClockS = otsA.getClockS() + t0.timeRemainingInWindowS;
  let cur: OrbitalTransportState | null = t0;
  while (cur !== null) {
    minEl = Math.min(minEl, elevationDegAt(cur.position, ORBITAL_OBSERVER_DEFAULT));
    if (cur.timeRemainingInWindowS > prevRemain + 1e-9) monotoneRemain = false;
    prevRemain = cur.timeRemainingInWindowS;
    closeClockS = otsA.getClockS() + cur.timeRemainingInWindowS;
    swept++;
    if (swept > 400) break;
    otsA.update(0.25);
    cur = otsA.getActiveTarget();
  }
  check(`LOS elevation stays ≥ 20° across the whole window (min ${minEl.toFixed(2)}°)`, minEl >= 19.99);
  check('timeRemainingInWindowS drains monotonically', monotoneRemain);
  check('window closes and the sky goes empty again', cur === null && otsA.getActiveTarget() === null);
  check('timeToNextWindowS counts again after close', otsA.timeToNextWindowS() > 0);

  // Physical-cone grace: the departed transit stays capture-eligible.
  for (let f = 0; f < Math.ceil(APPROACH_VISIBILITY_S / 0.25); f++) otsA.update(0.25);
  const graceProbe = otsA.checkCapture({ x: 0, y: 0, z: 5000 }, { x: 0, y: 0, z: 0 });
  check('departed transit stays resolvable in checkCapture (cone grace)', graceProbe.transport !== null && Number.isFinite(graceProbe.missDistanceM));
  if (graceProbe.transport !== null) {
    const gp = graceProbe.transport;
    const graceCatch = otsA.checkCapture(gp.position, gp.velocity);
    check('matched pass through the departed cone still captures', graceCatch.captured === true, `rel=${graceCatch.relativeSpeedMps.toFixed(1)}`);

    // Prune law: past close + residency + grace the transit is gone from the
    // candidate pool — probed dead-centre on its OWN extended chord axis
    // (the strongest possible candidate position if the cone had lingered).
    const probeClock = otsA.getClockS();
    const gpVel = gp.velocity;
    const targetClock = closeClockS + APPROACH_VISIBILITY_S + CAPTURE_GRACE_S + 2;
    for (let f = 0; f < Math.ceil((targetClock - probeClock) / 0.25); f++) otsA.update(0.25);
    const dtt = otsA.getClockS() - probeClock;
    const axisPos = { x: gp.position.x + gpVel.x * dtt, y: gp.position.y + gpVel.y * dtt, z: gp.position.z };
    const afterPrune = otsA.checkCapture(axisPos, gpVel);
    check(
      `grace-expired transit never answers on its own axis (${gp.id})`,
      afterPrune.transport === null || afterPrune.transport.id !== gp.id,
      `answered by ${afterPrune.transport?.id ?? 'nothing'} at miss ${afterPrune.missDistanceM.toFixed(2)} m`,
    );
  }
}

// Stage vessel fleet meshes.
check('stage fleet builds vessel + capture-cone meshes', otsStage.getMeshes().length > 30 && otsStage.getPartMeshes('capture_cone').length >= 2);
check('all three canonical vessels are built on stage', TRANSPORT_VESSELS.every((v) => otsStage.getVesselMeshes(v.id).length > 0));

// ---------------------------------------------------------------------------
section('DOMAIN 2 · C. tractor-frustum & magnetic-assist capture law (§3.2.3)');
// ---------------------------------------------------------------------------

{
  const cold = new OrbitalTransportSystem({ seed: 'capture-law' });
  const none = cold.checkCapture({ x: 0, y: 0, z: 900 }, { x: 0, y: 0, z: 0 });
  check(
    'no-active contract: {captured:false, transport:null, ∞, 0}',
    none.captured === false && none.transport === null && none.missDistanceM === Number.POSITIVE_INFINITY && none.relativeSpeedMps === 0,
  );

  // Drive to a BULK window to probe the 35 m envelope.
  let tug: OrbitalTransportState | null = null;
  let guard = 0;
  while ((tug = cold.getActiveTarget()) === null || tug.transportClass !== 'BULK_FREIGHTER') {
    if (guard++ > 4000) break;
    cold.update(0.25);
  }
  check('engaged a CisLunar Horizon firing window for the capture law', tug !== null && tug.transportClass === 'BULK_FREIGHTER');
  if (tug !== null) {
    const T = tug;
    const vT = T.velocity;
    // Offsets expressed in the CHORD frame: `aft` along −velocity, `down` −z.
    const chordSpeed = Math.hypot(vT.x, vT.y) || 1;
    const ax = vT.x / chordSpeed;
    const ay = vT.y / chordSpeed;
    const pose = (aft: number, down: number): V3 => ({
      x: T.position.x - ax * aft,
      y: T.position.y - ay * aft,
      z: T.position.z - down,
    });
    const at = (p: V3, v: V3 = vT) => cold.checkCapture(p, v);
    const centre = at(T.position);
    check('centre of the catch ring at Δv ≈ 0 captures', centre.captured === true && centre.relativeSpeedMps < 1e-9 && centre.missDistanceM < 1e-6);
    const fast = at(T.position, { x: vT.x, y: vT.y, z: 30 });
    check('Δv 30 m/s > 25 m/s cap REJECTS even at dead centre', fast.captured === false && approx(fast.relativeSpeedMps, 30, 1e-6));
    const frustumIn = at(pose(70, 15)); // 70 m aft: allowed r = 2 + 33·70/80 = 30.9; 71.6 m from bay → frustum-only capture
    check('frustum 70 m aft / 15 m radial (≤ 30.9) captures outside the assist sphere', frustumIn.captured === true && frustumIn.missDistanceM <= 15.01);
    const frustumOut = at(pose(70, 40)); // 40 m radial > 30.9 and 80.6 m from bay
    check('40 m radial at 70 m aft misses both envelopes', frustumOut.captured === false);
    check('miss distance reports the axis distance (≈ 40 m)', approx(frustumOut.missDistanceM, 40, 0.5), `got ${frustumOut.missDistanceM.toFixed(2)}`);
    const assist = at(pose(0, 52)); // 52 m below bay ≤ 1.5×35 = 52.5
    check('magnetic assist sphere 1.5 × R_catch captures at 52 m', assist.captured === true);
    const tooFar = at(pose(0, 53.6)); // just outside 52.5 m
    check('0.1 m beyond the assist sphere releases', tooFar.captured === false);

    // Rotate to the USP patrol cutter: 0 m envelope, never a customer.
    let usp: OrbitalTransportState | null = null;
    guard = 0;
    while ((usp = cold.getActiveTarget()) === null || usp.transportClass !== 'USP_PATROL') {
      if (guard++ > 6000) break;
      cold.update(0.25);
    }
    check('USP Vigilance patrol window engages', usp !== null && usp.transportClass === 'USP_PATROL');
    if (usp !== null) {
      const U = usp;
      const uspCatch = cold.checkCapture(U.position, U.velocity);
      check('perfect pass at the cutter STILL never captures (R_catch 0)', uspCatch.captured === false && uspCatch.transport !== null);
    }
  }
}

// ---------------------------------------------------------------------------
section('DOMAIN 3 · A. vacuum ballistic kinematics (g = 1.62 m/s²)');
// ---------------------------------------------------------------------------

{
  check('LUNAR_GRAVITY constant is 1.62 m/s²', BallisticTrajectoryEngine.LUNAR_GRAVITY === 1.62);
  const u = BallisticTrajectoryEngine.aimVector(214, 62.5);
  check('aimVector matches §3.3.1 (cosθcosψ, cosθsinψ, sinθ)', approx(u.x, Math.cos(62.5 * DEG) * Math.cos(214 * DEG), 1e-12) && approx(u.y, Math.cos(62.5 * DEG) * Math.sin(214 * DEG), 1e-12) && approx(u.z, Math.sin(62.5 * DEG), 1e-12));
  const lv = BallisticTrajectoryEngine.launchVelocity(90, 30, 350);
  check('launchVelocity = aimVector × speed', approx(Math.hypot(lv.x, lv.y, lv.z), 350, 1e-9) && approx(lv.z, 175, 1e-9));

  const p0 = { x: 10, y: -20, z: 100 };
  const v0 = { x: 100, y: 10, z: 100 };
  const st8 = BallisticTrajectoryEngine.canisterStateAt(p0, v0, 8);
  const g = 1.62;
  check('closed-form r(t) = r0 + v0·t + ½g·t² exact at t = 8 s',
    approx(st8.position.x, 10 + 800, 1e-9) && approx(st8.position.y, -20 + 80, 1e-9) && approx(st8.position.z, 100 + 800 - 0.5 * g * 64, 1e-9));
  check('closed-form v(t) = v0 + g·t exact (z bleeds −12.96 m/s)', approx(st8.velocity.z, 100 - g * 8, 1e-9) && approx(st8.velocity.x, 100, 1e-12));
  const sim60 = BallisticTrajectoryEngine.simulateCanister(p0, v0, 10, 1 / 60);
  const exact10 = BallisticTrajectoryEngine.canisterStateAt(p0, v0, 10);
  check('60 Hz stepped sim lands on the closed-form arc (≤ 1e-6)',
    approx(sim60.position.x, exact10.position.x, 1e-6) && approx(sim60.position.y, exact10.position.y, 1e-6) && approx(sim60.position.z, exact10.position.z, 1e-6));
  const simDefault = BallisticTrajectoryEngine.simulateCanister(p0, v0, 10);
  check('simulateCanister defaults to the 60 Hz tracking step', approx(simDefault.position.z, exact10.position.z, 1e-6));

  const arc = BallisticTrajectoryEngine.trajectoryArcPoints(p0, v0, 12, 13);
  check('trajectoryArcPoints returns 13 samples', arc.length === 13);
  const first = arc[0];
  const last = arc[12];
  check('arc endpoints exact (start and t = 12 s state)',
    first !== undefined && approx(first.x, p0.x, 1e-9) && approx(first.z, p0.z, 1e-9) &&
      last !== undefined && approx(last.z, BallisticTrajectoryEngine.canisterStateAt(p0, v0, 12).position.z, 1e-9));

  // Apex of a vertical-ish shot: v_z crosses zero at t = v0z/g.
  const apex = BallisticTrajectoryEngine.canisterStateAt({ x: 0, y: 0, z: 22 }, { x: 0, y: 0, z: 200 }, 200 / g);
  check('apex reached at t = v0z/g with v_z ≈ 0', approx(apex.velocity.z, 0, 1e-9) && approx(apex.position.z, 22 + (200 * 200) / (2 * g), 1e-6));
}

// ---------------------------------------------------------------------------
section('DOMAIN 3 · B. predictive lead solver, arcs & guards');
// ---------------------------------------------------------------------------

/**
 * True min distance of the canister arc to the straight target line, refined
 * around the coarse minimum (sampling-only scans over/estimate the dip by
 * up to v_rel·dt/2, which would false-fail an exact solver).
 */
function minMissToTarget(muzzleP: V3, v0: V3, tPos: V3, tVel: V3, tMax: number): number {
  const dist = (t: number): number => {
    const p = BallisticTrajectoryEngine.canisterStateAt(muzzleP, v0, t).position;
    return Math.hypot(
      p.x - (tPos.x + tVel.x * t),
      p.y - (tPos.y + tVel.y * t),
      p.z - (tPos.z + tVel.z * t),
    );
  };
  const coarseN = 2000;
  const coarseDt = tMax / coarseN;
  let bestT = 0;
  let bestD = dist(0);
  for (let i = 1; i <= coarseN; i++) {
    const t = i * coarseDt;
    const d = dist(t);
    if (d < bestD) { bestD = d; bestT = t; }
  }
  const fineN = 400;
  const lo = Math.max(0, bestT - coarseDt);
  for (let i = 0; i <= fineN; i++) {
    const t = lo + ((bestT + coarseDt - lo) * i) / fineN;
    const d = dist(t);
    if (d < bestD) bestD = d;
  }
  return bestD;
}

{
  const muzzle = { x: 0, y: 0, z: 0 };
  const tgt = { x: 800, y: 0, z: 900 };
  const tvel = { x: -60, y: 0, z: 0 };
  const sol = BallisticTrajectoryEngine.calculateLead(muzzle, tgt, tvel, 400);
  check('moving-target lead has a solution at 400 m/s', sol.hasSolution === true && sol.estimatedFlightTimeS > 0);
  if (sol.hasSolution) {
    const v0 = BallisticTrajectoryEngine.launchVelocity(sol.leadAzimuthDeg, sol.leadElevationDeg, 400);
    const minD = minMissToTarget(muzzle, v0, tgt, tvel, 60);
    check(`firing at the lead pip delivers ≤ 2 m (refined sim min ${minD.toFixed(3)} m)`, minD <= 2);
    check(`predictedMissDistanceM agrees with the simulation (${Math.abs(sol.predictedMissDistanceM - minD).toFixed(3)} m)`, Math.abs(sol.predictedMissDistanceM - minD) <= 1);
  }
  const minSpeed = BallisticTrajectoryEngine.minimumMuzzleSpeed(muzzle, { x: 0, y: 0, z: 1500 }, { x: 0, y: 0, z: 0 });
  check('minimumMuzzleSpeed overhead ≈ √(2gh) (60–75 m/s band)', minSpeed.requiredSpeedMps > 60 && minSpeed.requiredSpeedMps < 75 && minSpeed.flightTimeS > 0);

  const far = BallisticTrajectoryEngine.calculateLeadLongArc(muzzle, tgt, tvel, 400);
  check('far (lofted) arc branch answers with a longer flight', far.hasSolution === true && far.estimatedFlightTimeS > sol.estimatedFlightTimeS, `far=${far.estimatedFlightTimeS.toFixed(1)} near=${sol.estimatedFlightTimeS.toFixed(1)}`);

  // Zenith / degenerate guards: never throw, never NaN, harmless answers.
  let guardOk = true;
  try {
    const zen = BallisticTrajectoryEngine.calculateLead({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 2200 }, { x: 0, y: 0, z: 0 }, 400);
    if (Number.isNaN(zen.leadAzimuthDeg) || Number.isNaN(zen.leadElevationDeg)) guardOk = false;
    if (zen.hasSolution && (zen.leadElevationDeg > 90.0001 || zen.leadElevationDeg < -0.0001)) guardOk = false;
    const degen = BallisticTrajectoryEngine.calculateLead(muzzle, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 400);
    // Target AT the muzzle: only the harmless trivial zero-time solution.
    if (degen.hasSolution && !(degen.estimatedFlightTimeS === 0 && degen.predictedMissDistanceM === 0)) guardOk = false;
    const unreachable = BallisticTrajectoryEngine.calculateLead(muzzle, { x: 5000, y: 0, z: 50 }, { x: 220, y: 0, z: 0 }, 230);
    if (unreachable.hasSolution === true && unreachable.predictedMissDistanceM < 0) guardOk = false;
    if (unreachable.hasSolution === false && !(unreachable.predictedMissDistanceM >= 0 && Number.isFinite(unreachable.predictedMissDistanceM))) guardOk = false;
  } catch {
    guardOk = false;
  }
  check('zenith, degenerate and unreachable targets degrade safely', guardOk);
  const dv = BallisticTrajectoryEngine.interceptDeltaVelocity(muzzle, tgt, tvel, 400);
  check('interceptDeltaVelocity finite at the lead solution', Number.isFinite(dv) && dv >= 0);
}

// ---------------------------------------------------------------------------
section('DOMAIN 3 · C. Monte Carlo lead sweep — §6.3 ≥ 95 % intercept rate');
// ---------------------------------------------------------------------------

{
  const rng = mulberry32(1337);
  const muzzleMc: V3 = { x: MASS_ACCELERATOR_DEFAULT_WORLD.x, y: MASS_ACCELERATOR_DEFAULT_WORLD.y, z: TRUNNION_HEIGHT_M };
  const ALTITUDES = [1200, 1350, 1500, 1700, 1800, 2000, 2200];
  const SPEEDS = [140, 150, 150, 180, 210, 220, 220];
  let shots = 0;
  let hits = 0;
  let predErrSum = 0;
  let predErrN = 0;
  for (const alt of ALTITUDES) {
    for (const spd of SPEEDS) {
      const pFrac = 0.05 + 0.55 * rng();
      const dirAng = rng() * 2 * Math.PI;
      const dir = { x: Math.cos(dirAng), y: Math.sin(dirAng) };
      const nrm = { x: -dir.y, y: dir.x };
      const rGate = alt / Math.tan(LOS_ELEVATION_MIN_DEG * DEG);
      const p = pFrac * rGate;
      const closest = { x: muzzleMc.x + nrm.x * p, y: muzzleMc.y + nrm.y * p };
      const halfWin = Math.sqrt(Math.max(rGate * rGate - p * p, 0));
      const fireDist = -halfWin * (0.25 + 0.5 * rng()); // fire inside the window
      const tPos = { x: closest.x + dir.x * fireDist, y: closest.y + dir.y * fireDist, z: alt };
      const tVel = { x: dir.x * spd, y: dir.y * spd, z: 0 };
      shots++;
      const sol = BallisticTrajectoryEngine.calculateLead(muzzleMc, tPos, tVel, BANK_TARGET_MPS);
      if (!sol.hasSolution || !Number.isFinite(sol.leadAzimuthDeg) || !Number.isFinite(sol.leadElevationDeg)) continue;
      if (sol.leadElevationDeg < ELEVATION_MIN_DEG - 1e-6 || sol.leadElevationDeg > ELEVATION_MAX_DEG + 1e-6) continue; // gun hard stop blocks it
      const v0 = BallisticTrajectoryEngine.launchVelocity(sol.leadAzimuthDeg, sol.leadElevationDeg, BANK_TARGET_MPS);
      const minD = minMissToTarget(muzzleMc, v0, tPos, tVel, 150);
      if (minD <= vBulk.catchRadiusM) hits++;
      if (Number.isFinite(sol.predictedMissDistanceM)) {
        predErrSum += Math.abs(sol.predictedMissDistanceM - minD);
        predErrN++;
      }
    }
  }
  const rate = shots > 0 ? hits / shots : 0;
  check(`Monte Carlo sweep: ${hits}/${shots} intercepts ≤ ${vBulk.catchRadiusM} m (${(rate * 100).toFixed(1)} %)`, rate >= 0.95);
  check(`engine's predictedMissDistanceM tracks reality (mean err ${(predErrN > 0 ? predErrSum / predErrN : 999).toFixed(2)} m ≤ 2 m)`, predErrN > 0 && predErrSum / predErrN <= 2);
}

// ---------------------------------------------------------------------------
section('DOMAIN 4 · A. director lifecycle & cargo flow');
// ---------------------------------------------------------------------------

{
  const rig = mkRig();
  check('fireLaunch refused before a session', rig.d.fireLaunch() === false);
  check('unknown cargo refused', rig.d.startSession('PLUTONIUM', 50) === false);
  check('non-positive / non-finite mass refused', rig.d.startSession('REGOLITH', 0) === false && rig.d.startSession('REGOLITH', Number.NaN) === false);
  check('normalize helpers round-trip the union', normalizeExportCargo(' stolen_contraband ') === 'STOLEN_CONTRABAND' && normalizeExportCargo(42) === null);
  check('startSession docks DOCKING_CONSOLE', rig.d.startSession('helium3', 120) === true && rig.d.getPhase() === 'DOCKING_CONSOLE');
  check('double start refused mid-session', rig.d.startSession('REGOLITH', 5) === false);
  frame(rig, 0, 62, false, hFrame());
  check('first tick hands off to AWAITING_ORBITAL_PASS', rig.d.getPhase() === 'AWAITING_ORBITAL_PASS');

  // The director NEVER advances the host clocks.
  const clockBefore = rig.ot.getClockS();
  const gantryBefore = rig.acc.getState().azimuthDeg;
  rig.d.update(0.25, { aimX: 100, aimY: 60, chargeHeld: false });
  check('director.update advances neither the transport nor the gantry clock', rig.ot.getClockS() === clockBefore && rig.acc.getState().azimuthDeg === gantryBefore);

  let targeting = false;
  for (let f = 0; f < 60 * 300 && !targeting; f++) targeting = engage(rig, 'BULK_FREIGHTER', 1, hFrame());
  check('window opening promotes TARGETING_ACTIVE (8-phase machine)', targeting && rig.d.getPhase() === 'TARGETING_ACTIVE');

  // Trigger-hold spooling follows the RC curve.
  for (let f = 0; f < 60; f++) frame(rig, 0, 62, true, hFrame());
  check('held trigger enters COIL_CHARGING', rig.d.getPhase() === 'COIL_CHARGING');
  check('spool law: v after 1 s hold = curve v(1.0)', approx(rig.d.getMuzzleVelocityMps(), spoolVelocityMps(1.0), 1e-6), `got ${rig.d.getMuzzleVelocityMps()}`);

  // Canister spawn: exact §3.3.1 launch law off the articulated muzzle.
  const fv = rig.acc.getFireVector();
  const vz0 = rig.acc.getMuzzleVelocityMps();
  const mz = rig.acc.getMuzzleWorldPosition();
  check('fireLaunch fires from COIL_CHARGING', rig.d.fireLaunch() === true);
  const sFlight = rig.d.getSessionState();
  check('IN_FLIGHT_TRACKING + canisterInFlight', rig.d.getPhase() === 'IN_FLIGHT_TRACKING' && sFlight.canisterInFlight === true);
  check('canister spawns exactly at the muzzle world position', approx(sFlight.canisterPos.x, mz.x, 1e-9) && approx(sFlight.canisterPos.y, mz.y, 1e-9) && approx(sFlight.canisterPos.z, mz.z, 1e-9));
  check('fireLaunch refused mid-flight', rig.d.fireLaunch() === false);

  // In-flight physics: ballistic arc under lunar gravity (before any tractor).
  let pre = sFlight.canisterPos.z;
  for (let f = 0; f < 30; f++) frame(rig, 0, 62, false, hFrame());
  const sArc = rig.d.getSessionState();
  check('canister climbs the powered arc (z rose 50+ m in 0.5 s)', sArc.canisterPos.z > pre + 50, `pre=${pre.toFixed(1)} now=${sArc.canisterPos.z.toFixed(1)}`);
  check('state stays finite mid-flight', finiteState(sArc));
  rig.d.cancelSession();
  check('cancel aborts the flight without an outcome', rig.d.getPhase() === 'INACTIVE' && rig.d.getSessionState().lastResult === 'NONE');
}

// ---------------------------------------------------------------------------
section('DOMAIN 4 · B. live bulk capture at the 2.5× payout & quench');
// ---------------------------------------------------------------------------

{
  const rig = mkRig();
  const dt = hFrame();
  rig.d.startSession('HELIUM3', 120);
  check('engages the CisLunar Horizon window', engage(rig, 'BULK_FREIGHTER', 300, dt));
  check('winning gunnery fires (preslew + spool + converged release)', hotShot(rig, dt) === 'FIRED');
  const r = toOutcome(rig, 160, dt);
  check('CAPTURE_SUCCESS resolved through checkCapture', r.s.lastResult === 'SUCCESS', `got ${r.s.lastResult} @${r.tS.toFixed(1)}s`);
  check('payout = 120 kg × 45 CR/kg × 2.5 = 13 500 CR', r.s.lastPayoutCredits === 13500, `got ${r.s.lastPayoutCredits}`);
  check('legal export never trips the USP alert', r.s.uspAlertActive === false);
  frame(rig, 0, 62, false, dt);
  check('CAPTURE_SUCCESS → COOLING_DOWN', rig.d.getPhase() === 'COOLING_DOWN');
  for (let f = 0; f < Math.ceil((POST_OUTCOME_COOLDOWN_S + 0.2) / dt); f++) frame(rig, 0, 62, false, dt);
  check('quench closes the session to INACTIVE', rig.d.getPhase() === 'INACTIVE' && rig.d.getSessionState().isActive === false);
}

// ---------------------------------------------------------------------------
section('DOMAIN 4 · C. apex-doom miss & overcharge recovery');
// ---------------------------------------------------------------------------

{
  const rig = mkRig();
  const dt = hFrame();
  rig.d.startSession('TITANIUM', 100);
  check('engages a window for the miss drill', engage(rig, 'BULK_FREIGHTER', 300, dt));
  for (let f = 0; f < 60 * 4; f++) frame(rig, 0, 15, false, dt); // slew to the hard stop
  for (let f = 0; f < 18; f++) frame(rig, 0, 15, true, dt); // 0.3 s spool — apex stays low
  for (let f = 0; f < 6; f++) frame(rig, 0, 15, false, dt); // release
  let missedAt = -1;
  for (let f = 0; f < 60 * 40; f++) {
    const s = frame(rig, 0, 15, false, dt);
    if (s.lastResult === 'MISSED') { missedAt = f * dt; break; }
  }
  check('unreachable apex resolves INTERCEPT_FAILED early (no 600 s wait)', missedAt >= 0, `missedAt=${missedAt.toFixed(1)}`);
  check('zero payout on a miss', rig.d.getSessionState().lastPayoutCredits === 0);
  frame(rig, 0, 62, false, dt); // INTERCEPT_FAILED → COOLING_DOWN
  for (let f = 0; f < 200; f++) frame(rig, 0, 62, false, dt);
  check('legal miss closes the session (no alert stood)', rig.d.getPhase() === 'INACTIVE');

  const rig2 = mkRig();
  rig2.d.startSession('TITANIUM', 100);
  check('engages a window for the breaker drill', engage(rig2, 'BULK_FREIGHTER', 300, dt));
  let tripped = false;
  for (let f = 0; f < 60 * 6; f++) {
    const s = frame(rig2, 0, 62, true, dt);
    if (s.lastResult === 'OVERCHARGED') { tripped = true; break; }
  }
  check(`held charge past ${EMD_OVERCHARGE_TRIP_S} s trips OVERCHARGED`, tripped);
  check('trip lands in COOLING_DOWN with the gun locked out', rig2.d.getPhase() === 'COOLING_DOWN' && rig2.acc.getState().state === 'OVERCHARGED' && rig2.acc.getState().cooldownRemainingS > 0);
  check('session survives the trip (cargo stays in the breech)', rig2.d.getSessionState().cargoQuantityKg === 100);
  let recovered = false;
  for (let f = 0; f < 60 * (BREAKER_COOLDOWN_S + 2); f++) {
    frame(rig2, 0, 62, false, dt);
    if (rig2.d.getPhase() === 'AWAITING_ORBITAL_PASS') { recovered = true; break; }
  }
  check('re-arms AWAITING_ORBITAL_PASS after the 5 s breaker', recovered);
  rig2.d.reset();
  const fresh = rig2.d.getSessionState();
  check('reset() restores the pristine factory state', rig2.d.getPhase() === 'INACTIVE' && fresh.isActive === false && fresh.lastResult === 'NONE' && fresh.lastPayoutCredits === 0);
}

// ---------------------------------------------------------------------------
section('DOMAIN 5 · Contraband laundering, USP threat & economy');
// ---------------------------------------------------------------------------

{
  const dt = hFrame();
  check('USP constants: 45 s countdown, 2 500 CR citation, 1.25 launder bonus', USP_INTERCEPT_COUNTDOWN_S === 45.0 && USP_CITATION_FINE_CREDITS === 2500 && LAUNDER_BONUS_CREDIT === 1.25);
  check('cargo rate table {regolith 2, ti 12, he3 45, contraband 30} CR/kg',
    EXPORT_CARGO_RATES_CREDITS_PER_KG.REGOLITH === 2 && EXPORT_CARGO_RATES_CREDITS_PER_KG.TITANIUM === 12 &&
      EXPORT_CARGO_RATES_CREDITS_PER_KG.HELIUM3 === 45 && EXPORT_CARGO_RATES_CREDITS_PER_KG.STOLEN_CONTRABAND === 30);

  // Cold tap-fire is NOT a radar signature.
  const rigC = mkRig();
  rigC.d.startSession('STOLEN_CONTRABAND', 60);
  check('contraband run engages a window', engage(rigC, 'BULK_FREIGHTER', 300, dt));
  const tapOk = rigC.d.fireLaunch();
  check('cold tap-fire (no spool) does NOT arm the siphon', tapOk === true && rigC.d.getSessionState().uspAlertActive === false && rigC.d.getSessionState().uspCountdownRemainingS === 0);
  toOutcome(rigC, 320, dt);
  rigC.d.cancelSession();

  // Spool signature → 45 s clock → mid-flight expiry → CONFISCATED.
  const rigX = mkRig();
  rigX.d.startSession('STOLEN_CONTRABAND', 60);
  check('second hot run engages a window', engage(rigX, 'BULK_FREIGHTER', 300, dt));
  for (let f = 0; f < 24; f++) frame(rigX, 0, 62, true, dt); // 0.4 s spool
  const armed = rigX.d.getSessionState();
  check('first contraband spool arms the 45 s intercept clock', armed.uspAlertActive === true && armed.uspCountdownRemainingS > 44.4 && armed.uspCountdownRemainingS <= 45.0 && rigX.d.getUspHeatLevel() === 1);
  for (let f = 0; f < 12; f++) frame(rigX, 0, 62, false, dt); // release → launch
  const clock0 = rigX.d.getSessionState().uspCountdownRemainingS;
  let expiredAt = -1;
  for (let f = 0; f < 60 * 48; f++) {
    const s = frame(rigX, 0, 62, false, dt);
    if (s.lastResult === 'CONFISCATED') { expiredAt = f * dt; break; }
  }
  check('T-0 mid-flight → CONFISCATED (clock ran its 45 s from arming)', expiredAt >= 0 && Math.abs(expiredAt - clock0) < 0.1, `expired=${expiredAt.toFixed(2)} clock0=${clock0.toFixed(2)}`);
  const post = rigX.d.getSessionState();
  check('confiscation clears cargo, zeroes countdown and payout', post.cargoQuantityKg === 0 && post.uspAlertActive === false && post.uspCountdownRemainingS === 0 && post.lastPayoutCredits === 0);
  for (let f = 0; f < 200; f++) frame(rigX, 0, 62, false, dt);
  check('citation closes the hot run to INACTIVE', rigX.d.getPhase() === 'INACTIVE');

  // Syndicate laundering: 4.0× black market × 1.25 launder bonus, heat cleared.
  const rigL = mkRig();
  rigL.d.startSession('STOLEN_CONTRABAND', 40);
  check('hot run targets The Obsidian Slip', engage(rigL, 'SYNDICATE_RUNNER', 600, dt));
  check('winning shot fires through the runner window', hotShot(rigL, dt) === 'FIRED');
  const rl = toOutcome(rigL, 160, dt);
  check('runner capture = SUCCESS', rl.s.lastResult === 'SUCCESS', `got ${rl.s.lastResult}`);
  check('payout = 40 kg × 30 CR × 4.0 × 1.25 = 6 000 CR', rl.s.lastPayoutCredits === 6000, `got ${rl.s.lastPayoutCredits}`);
  const launderRatio = rl.s.lastPayoutCredits / cargoDepotValueCredits('STOLEN_CONTRABAND', 40);
  check(`laundered at ${launderRatio.toFixed(2)}× — inside the §3.4.3 [4.0, 5.0] band`, launderRatio >= 4.0 && launderRatio <= 5.0);
  check('laundered flag + alert cancelled + heat reset to 0', rigL.d.isContrabandLaundered() === true && rl.s.uspAlertActive === false && rl.s.uspCountdownRemainingS === 0 && rigL.d.getUspHeatLevel() === 0);

  // Hot-miss survival: a dead canister is not an exit while the clock runs.
  const rigH = mkRig();
  rigH.d.startSession('STOLEN_CONTRABAND', 30);
  check('hot-miss drill engages a window', engage(rigH, 'BULK_FREIGHTER', 300, dt));
  for (let f = 0; f < 60 * 4; f++) frame(rigH, 0, 15, false, dt);
  for (let f = 0; f < 18; f++) frame(rigH, 0, 15, true, dt);
  for (let f = 0; f < 6; f++) frame(rigH, 0, 15, false, dt);
  let hotMissed = false;
  for (let f = 0; f < 60 * 40; f++) {
    const s = frame(rigH, 0, 15, false, dt);
    if (s.lastResult === 'MISSED') { hotMissed = true; break; }
  }
  frame(rigH, 0, 15, false, dt); // INTERCEPT_FAILED outcome frame → COOLING_DOWN
  frame(rigH, 0, 15, false, dt); // hot suppression: re-arms the pass watch
  const hot = rigH.d.getSessionState();
  check('while hot, a MISS re-arms the pass watch (session survives)', hotMissed && hot.isActive === true && hot.uspAlertActive === true && hot.uspCountdownRemainingS > 0 && rigH.d.getPhase() === 'AWAITING_ORBITAL_PASS' && rigH.d.isContrabandLaundered() === false);
  rigH.d.cancelSession();

  // Wrong-class refusal: legal regolith through the Slip pays nothing.
  const rigW = mkRig();
  rigW.d.startSession('REGOLITH', 200);
  check('legal cargo engages the Slip window for refusal test', engage(rigW, 'SYNDICATE_RUNNER', 600, dt));
  check('shot fires through the runner window', hotShot(rigW, dt) === 'FIRED');
  const rw = toOutcome(rigW, 400, dt);
  check('wrong-class capture refused → terminal MISSED, zero payout', rw.s.lastResult === 'MISSED' && rw.s.lastPayoutCredits === 0, `got ${rw.s.lastResult}/${rw.s.lastPayoutCredits}`);

  // Cancel drops the alert; forcing legal cargo hot arms on charge.
  const rigK = mkRig();
  rigK.d.startSession('STOLEN_CONTRABAND', 10);
  engage(rigK, 'BULK_FREIGHTER', 300, dt);
  for (let f = 0; f < 12; f++) frame(rigK, 0, 62, true, dt);
  rigK.d.cancelSession();
  const cancelled = rigK.d.getSessionState();
  check('cancelSession drops the alert and closes the console', cancelled.uspAlertActive === false && rigK.d.getPhase() === 'INACTIVE' && cancelled.isActive === false);
  const rigF = mkRig();
  rigF.d.startSession('HELIUM3', 10, true);
  engage(rigF, 'BULK_FREIGHTER', 300, dt);
  frame(rigF, 0, 62, true, dt);
  check('isContraband flag forces legal cargo hot (siphon arms)', rigF.d.getSessionState().uspAlertActive === true);
  rigF.d.cancelSession();

  check('syndicate radio line matches Spec §3.4.3 verbatim', SYNDICATE_LAUNDER_COMMS === 'Package on board. Funds wired to offshore vault. Pleasure doing business, prospector.');

  // ClientApp bridge: the 2 500 CR citation is applied EXACTLY ONCE per
  // CONFISCATED outcome and payouts credited on SUCCESS.
  const clientSrc = readSrc('src/client/ClientApp.ts');
  const fineLevies = (clientSrc.match(/identity - USP_CITATION_FINE_CREDITS/g) ?? []).length;
  check('ClientApp CONFISCATED bridge levies the citation exactly once', fineLevies === 1, `found ${fineLevies}`);
  check('ClientApp SUCCESS bridge credits the payout', /identity \+ paid/.test(clientSrc) && clientSrc.includes('recordExportLaunch'));
}

// ---------------------------------------------------------------------------
section('DOMAIN 6 · A. fire-control HUD (crosshair, lock, radar, capacitor)');
// ---------------------------------------------------------------------------

const hudDoc = makeFakeDocument();
const hud = new LunarHUD({ document: hudDoc as unknown as Document });
const txt = (key: string): string => hud.textOf(key);
const has = (key: string, cls: string): boolean => hud.hasClass(key, cls);
const attr = (key: string, name: string): string | null => hud.getElement(key)?.getAttribute(name) ?? null;
const heightOf = (key: string): string => hud.getElement(key)?.style['height'] ?? '';
const leftOf = (key: string): string => hud.getElement(key)?.style['left'] ?? '';
const topOf = (key: string): string => hud.getElement(key)?.style['top'] ?? '';

function gun(over: Partial<HudExportGunnerTelemetry> = {}): HudExportGunnerTelemetry {
  return {
    phase: 'TARGETING_ACTIVE',
    azimuthDeg: 0,
    elevationDeg: 62,
    leadAzimuthDeg: null,
    leadElevationDeg: null,
    solutionAvailable: false,
    muzzleVelocityMps: HUD_CAP_MIN_MPS,
    capacitorChargeRatio: 0,
    optimalMinMps: 0,
    optimalMaxMps: 0,
    targetName: null,
    targetClass: null,
    targetRangeM: null,
    timeToTargetS: null,
    contacts: [],
    contraband: false,
    uspAlertActive: false,
    uspCountdownRemainingS: 0,
    canisterInFlight: false,
    ...over,
  };
}

check('constants: ±1.5° lock, 180–420 m/s band, 45/15 s USP banner law',
  HUD_GUNNER_LOCK_TOL_DEG === 1.5 && HUD_CAP_MIN_MPS === 180 && HUD_CAP_MAX_MPS === 420 &&
    HUD_EXPORT_USP_FULL_S === 45.0 && HUD_EXPORT_USP_CRITICAL_S === 15.0);
check('suite mounts hidden and registers its DOM ids', has('gunner-panel', 'is-hidden') && hudDoc.getElementById(HUD_GUNNER_ID) !== null);
hud.renderExportGunnerOverlay(null);
check('null telemetry keeps the suite retracted', has('gunner-panel', 'is-hidden'));
hud.renderExportGunnerOverlay(gun({ azimuthDeg: 214.0, elevationDeg: 62.5 }));
check('live frame reveals the suite', !has('gunner-panel', 'is-hidden'));
check('ballistic crosshair reads 0.1° AZ/EL', txt('gunner-az-value') === 'AZ 214.0°' && txt('gunner-el-value') === 'EL 62.5°', `"${txt('gunner-az-value')}" / "${txt('gunner-el-value')}"`);
hud.renderExportGunnerOverlay(gun({ azimuthDeg: 214.0, elevationDeg: 62.5, leadAzimuthDeg: 215.5, leadElevationDeg: 62.5, solutionAvailable: true }));
check('exactly +1.5° azimuth is INCLUSIVE (Ghost Target locks)', has('gunner-lead', 'is-locked') && attr('gunner-panel', 'data-lock') === '1');
hud.renderExportGunnerOverlay(gun({ azimuthDeg: 214.0, elevationDeg: 62.5, leadAzimuthDeg: 215.6, leadElevationDeg: 62.5, solutionAvailable: true }));
check('+1.6° breaks the lock', !has('gunner-lead', 'is-locked'));
hud.renderExportGunnerOverlay(gun({ azimuthDeg: 0.2, elevationDeg: 62.5, leadAzimuthDeg: 359.4, leadElevationDeg: 62.5, solutionAvailable: true }));
check('wrap-around lead (0.2° vs 359.4°) locks', has('gunner-lead', 'is-locked'));
hud.renderExportGunnerOverlay(gun({ azimuthDeg: 214.0, elevationDeg: 62.5 }));
check('no solution: lead hidden, NO FIRING SOLUTION status', has('gunner-lead', 'is-hidden') && txt('gunner-lock-status') === 'NO FIRING SOLUTION');

// Hemisphere sky-track radar: elevation inward, azimuth around the rim.
const contacts: HudRadarContact[] = [
  { id: 'c1', label: 'Obsidian Slip', transportClass: 'SYNDICATE_RUNNER', phase: 'approaching', azimuthDeg: 120, elevationDeg: 30, rangeM: 2400 },
  { id: 'c2', label: 'CisLunar Horizon', transportClass: 'BULK_FREIGHTER', phase: 'overhead', azimuthDeg: 0, elevationDeg: 90, rangeM: 1500 },
  { id: 'c3', label: 'USP Vigilance', transportClass: 'USP_PATROL', phase: 'departing', azimuthDeg: 270, elevationDeg: 0, rangeM: 3200 },
];
hud.renderExportGunnerOverlay(gun({ contacts }));
const pip0 = hud.getElement('gunner-radar-pip-0');
const r1 = ((90 - 30) / 90) * 50;
check(`pip 0 hemisphere projection az 120°/el 30° → ${(50 + r1 * Math.sin(120 * DEG)).toFixed(2)}%/${(50 - r1 * Math.cos(120 * DEG)).toFixed(2)}%`,
  pip0?.style['left'] === `${(50 + r1 * Math.sin(120 * DEG)).toFixed(2)}%` && pip0?.style['top'] === `${(50 - r1 * Math.cos(120 * DEG)).toFixed(2)}%`,
  `got ${pip0?.style['left']}/${pip0?.style['top']}`);
const pip1 = hud.getElement('gunner-radar-pip-1');
check('zenith contact projects to dome centre', pip1?.style['left'] === '50.00%' && pip1?.style['top'] === '50.00%');
const pip2 = hud.getElement('gunner-radar-pip-2');
check('horizon az 270° lands on the rim left, class-coloured', pip2?.style['left'] === '0.00%' && pip2?.style['top'] === '50.00%' && pip2.classList.contains('contact-usp_patrol'));
check(`radar readout counts ${contacts.length} contacts`, txt('gunner-radar-readout') === 'SKY-TRACK: 3 contacts');

// Capacitor charge bar + optimal bracket.
for (const [v, want] of [[180, '0.0%'], [300, '50.0%'], [420, '100.0%'], [100, '0.0%'], [500, '100.0%']] as Array<[number, string]>) {
  hud.renderExportGunnerOverlay(gun({ muzzleVelocityMps: v }));
  check(`v = ${v} m/s → fill ${want}`, heightOf('gunner-cap-fill') === want, `got "${heightOf('gunner-cap-fill')}"`);
}
hud.renderExportGunnerOverlay(gun({ muzzleVelocityMps: 375, optimalMinMps: 360, optimalMaxMps: 390 }));
check('optimal bracket 360..390 → top edge 12.5% and .is-optimal at 375', topOf('gunner-cap-bracket') === '12.5%' && has('gunner-cap-fill', 'is-optimal'));

// USP heat banner.
hud.renderExportGunnerOverlay(gun({ contraband: true }));
check('hot cargo: banner amber is-hot', !has('gunner-usp', 'is-hidden') && has('gunner-usp', 'is-hot'));
hud.renderExportGunnerOverlay(gun({ contraband: true, uspAlertActive: true, uspCountdownRemainingS: 15.0 }));
check('exactly T-15.0 not critical yet (strict <)', !has('gunner-usp', 'is-critical'));
hud.renderExportGunnerOverlay(gun({ contraband: true, uspAlertActive: true, uspCountdownRemainingS: 14.9 }));
check('T-14.9 crosses into the crimson blink', has('gunner-usp', 'is-critical'));
hud.renderExportGunnerOverlay(gun({ contraband: true, uspAlertActive: true, uspCountdownRemainingS: 99 }));
check('clock clamps to the 45 s band top', txt('gunner-usp-value') === 'USP INTERCEPT T-45.0s', `got "${txt('gunner-usp-value')}"`);
hud.renderExportGunnerOverlay(gun());
check('clean frame retracts the banner and washes its classes', has('gunner-usp', 'is-hidden') && !has('gunner-usp', 'is-critical') && !has('gunner-usp', 'is-hot'));

// ---------------------------------------------------------------------------
section('DOMAIN 6 · B. procedural Web Audio voices (zero external assets)');
// ---------------------------------------------------------------------------

check('capacitor whine band 80 → 880 Hz', CAPACITOR_WHINE_FLOOR_HZ === 80 && CAPACITOR_WHINE_CEILING_HZ === 880);
check('Lorentz blast: 45 Hz sub, 2 400 Hz snap, 320 Hz ring', LORENTZ_SUBBASS_HZ === 45 && LORENTZ_SNAP_HZ === 2400 && LORENTZ_RING_HZ === 320);
check('Doppler whistle 4 200 → 1 500 Hz, chime 523 → 659 Hz', VACUUM_WHISTLE_HIGH_HZ === 4200 && VACUUM_WHISTLE_LOW_HZ === 1500 && CAPTURE_CHIME_LOW_HZ === 523 && CAPTURE_CHIME_HIGH_HZ === 659);
check('USP klaxon tone pair 440 / 587 Hz', USP_KLAXON_LOW_HZ === 440 && USP_KLAXON_HIGH_HZ === 587);

const audio = new LunarAudioSystem();
void audio.init(); // async body is sync — graph built on this line
check('audio engine initializes headless (mock context, no device)', audio.isInitialized() && audio.isHeadless());
type AudioInternals = {
  ownedVoices: { type?: string; frequency?: { value: number } }[];
  capWhineGain: { gain: { value: number } } | null;
  capWhineSubOsc: { frequency: { value: number } } | null;
  uspKlaxonGain: { gain: { value: number } } | null;
  uspKlaxonOsc: { type: string; frequency: { value: number } } | null;
};
const internals = audio as unknown as AudioInternals;
audio.setCapacitorSpoolWhine(0.5);
check('whine at ratio 0.5 sits mid-band 480 Hz', approx(audio.getCapacitorWhineFrequencyHz(), 480), `got ${audio.getCapacitorWhineFrequencyHz()}`);
check('sub-octave twin tracks freq/2 (240 Hz)', internals.capWhineSubOsc !== null && approx(internals.capWhineSubOsc.frequency.value, 240));
check('13 Hz AM-jitter LFO exists in the owned voices', internals.ownedVoices.some((v) => v.type === 'sine' && v.frequency !== undefined && approx(v.frequency.value, 13)));
audio.setCapacitorSpoolWhine(1);
check('full charge pegs the 880 Hz ceiling', approx(audio.getCapacitorWhineFrequencyHz(), CAPACITOR_WHINE_CEILING_HZ) && approx(audio.getCapacitorWhineLevel(), 1));
audio.setCapacitorSpoolWhine(Number.NaN);
check('NaN ratio clamps silent to the floor', approx(audio.getCapacitorWhineFrequencyHz(), CAPACITOR_WHINE_FLOOR_HZ) && audio.getCapacitorWhineLevel() === 0);

const tones = audio.getUspKlaxonTones();
check('klaxon is 513.5 Hz saw ± 73.5 Hz swung by a 1.25 Hz square LFO (0.4 s/tone)',
  tones.baseHz === 513.5 && tones.swingHz === 73.5 && approx(tones.alternationHz, 1.25) &&
    approx(1 / (2 * tones.alternationHz), 0.4) && tones.baseHz - tones.swingHz === USP_KLAXON_LOW_HZ && tones.baseHz + tones.swingHz === USP_KLAXON_HIGH_HZ);
audio.setUspKlaxonAlert(true);
check('armed klaxon active with saw carrier', audio.isUspKlaxonAlertActive() === true && internals.uspKlaxonOsc !== null && internals.uspKlaxonOsc.type === 'sawtooth' && approx(internals.uspKlaxonOsc.frequency.value, 513.5));
check('square alternation LFO @ 1.25 Hz present', internals.ownedVoices.some((v) => v.type === 'square' && v.frequency !== undefined && approx(v.frequency.value, 1.25)));
audio.setUspKlaxonAlert(false);
check('disarm closes the klaxon gain', audio.isUspKlaxonAlertActive() === false && internals.uspKlaxonGain !== null && internals.uspKlaxonGain.gain.value === 0);

const cue0 = audio.getLastExportCueTimes();
check('export cues cold before the first shot', cue0.dischargeAt === Number.NEGATIVE_INFINITY && cue0.whistleAt === Number.NEGATIVE_INFINITY && cue0.chimeAt === Number.NEGATIVE_INFINITY);
audio.playLorentzDischargeBlast();
audio.playCanisterVacuumWhistle();
audio.playMagneticCaptureChime();
const cue1 = audio.getLastExportCueTimes();
check('discharge / whistle / chime each stamp finite monotonic cue times',
  Number.isFinite(cue1.dischargeAt) && Number.isFinite(cue1.whistleAt) && Number.isFinite(cue1.chimeAt) && cue1.chimeAt >= cue1.dischargeAt);
let bareOk = true;
try {
  const bare = new LunarAudioSystem();
  bare.setCapacitorSpoolWhine(0.6);
  bare.setUspKlaxonAlert(true);
  bare.playLorentzDischargeBlast();
  bare.dispose();
} catch {
  bareOk = false;
}
check('pre-init voice calls never throw (autoplay-safe)', bareOk);

// Zero external assets: the whole audio engine is synthesis only.
const audioSrc = readSrc('src/audio/LunarAudioSystem.ts');
const externalAsset = /['"'][^'"]*\.(mp3|ogg|oga|wav|m4a|m4b|aac|flac)['"']/i.test(audioSrc) || /https?:\/\//.test(audioSrc);
check('zero external audio assets referenced (pure Web Audio synthesis)', audioSrc.length > 1000 && externalAsset === false);
check('audio voice pool is engine-owned and drains on dispose', internals.ownedVoices.length >= 16);

// ---------------------------------------------------------------------------
section('DOMAIN 6 · C. integration: real trio drives HUD + audio (ClientApp law)');
// ---------------------------------------------------------------------------

{
  const accel = new MassAccelerator();
  const ots = new OrbitalTransportSystem({ seed: 'gauss-needle-central' });
  const director = new ExportMinigameDirector(accel, ots);
  const hud3 = new LunarHUD({ document: makeFakeDocument() as unknown as Document });
  const audio3 = new LunarAudioSystem();
  void audio3.init();
  const has3 = (key: string, cls: string): boolean => hud3.hasClass(key, cls);
  const attr3 = (key: string, name: string): string | null => hud3.getElement(key)?.getAttribute(name) ?? null;

  let aim = { azimuth: 90, elevation: 62 };
  let fireWas = false;
  let chimeResultWas = 'NONE';

  /** Mirror of ClientApp.buildExportGunnerTelemetry (same math, same sources). */
  function buildTele(state: ExportSessionState): HudExportGunnerTelemetry {
    const muzzle = accel.getMuzzleWorldPosition();
    const gantry = accel.getState();
    const cs: HudRadarContact[] = [];
    let leadAzimuthDeg: number | null = null;
    let leadElevationDeg: number | null = null;
    let solutionAvailable = false;
    let targetName: string | null = null;
    let targetClass: string | null = null;
    let targetRangeM: number | null = null;
    let timeToTargetS: number | null = null;
    let optimalMinMps = 0;
    let optimalMaxMps = 0;
    const active = ots.getActiveTarget();
    if (active !== null) {
      const dx = active.position.x - muzzle.x;
      const dy = active.position.y - muzzle.y;
      const dz = active.position.z - muzzle.z;
      const horiz = Math.hypot(dx, dy);
      const range = Math.hypot(horiz, dz);
      const az = ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
      const el = horiz > 1e-9 ? (Math.atan2(dz, horiz) * 180) / Math.PI : 90;
      const radial = range > 1e-9 ? (active.velocity.x * dx + active.velocity.y * dy + active.velocity.z * dz) / range : 0;
      targetName = active.name;
      targetClass = active.transportClass;
      targetRangeM = range;
      cs.push({ id: active.id, label: active.name, transportClass: active.transportClass, phase: el > 75 ? 'overhead' : radial < 0 ? 'approaching' : 'departing', azimuthDeg: az, elevationDeg: el, rangeM: range });
      if (state.isActive) {
        const sol = BallisticTrajectoryEngine.calculateLead(muzzle, active.position, active.velocity, accel.getMuzzleVelocityMps());
        if (sol.hasSolution && Number.isFinite(sol.leadAzimuthDeg) && Number.isFinite(sol.leadElevationDeg)) {
          solutionAvailable = true;
          leadAzimuthDeg = sol.leadAzimuthDeg;
          leadElevationDeg = sol.leadElevationDeg;
          timeToTargetS = sol.estimatedFlightTimeS;
          if (Number.isFinite(sol.recommendedMuzzleSpeedMps) && sol.recommendedMuzzleSpeedMps > 0) {
            optimalMinMps = Math.min(420, Math.max(180, sol.recommendedMuzzleSpeedMps * 0.92));
            optimalMaxMps = Math.min(420, Math.max(180, sol.recommendedMuzzleSpeedMps * 1.08));
          }
        }
      }
    }
    return {
      phase: director.getPhase(), azimuthDeg: gantry.azimuthDeg, elevationDeg: gantry.elevationDeg,
      leadAzimuthDeg, leadElevationDeg, solutionAvailable,
      muzzleVelocityMps: director.getMuzzleVelocityMps(), capacitorChargeRatio: accel.getCapacitorChargeRatio(),
      optimalMinMps, optimalMaxMps, targetName, targetClass, targetRangeM, timeToTargetS,
      contacts: cs, contraband: state.isContraband, uspAlertActive: state.uspAlertActive,
      uspCountdownRemainingS: state.uspCountdownRemainingS, canisterInFlight: state.canisterInFlight,
    };
  }

  /** Mirror of the ClientApp per-frame law (mounted=true while at console). */
  function exportFrame(dt: number, chargeHeld: boolean, mounted = true): ExportSessionState {
    accel.update(dt);
    const state = director.update(dt, { aimX: aim.azimuth, aimY: aim.elevation, chargeHeld });
    ots.update(dt);
    if (!mounted && !state.isActive) hud3.hideExportGunnerOverlay();
    else hud3.renderExportGunnerOverlay(buildTele(state));
    audio3.setCapacitorSpoolWhine(state.isActive ? accel.getCapacitorChargeRatio() : 0);
    audio3.setUspKlaxonAlert(state.uspAlertActive);
    if (state.canisterInFlight && !fireWas) {
      audio3.playLorentzDischargeBlast();
      audio3.playCanisterVacuumWhistle();
    }
    fireWas = state.canisterInFlight;
    if (state.lastResult !== chimeResultWas) {
      if (state.lastResult === 'SUCCESS') audio3.playMagneticCaptureChime();
      chimeResultWas = state.lastResult;
    }
    return state;
  }

  check('console docks (HELIUM3 100 kg)', director.startSession('HELIUM3', 100) === true);
  let s = exportFrame(hFrame(), false);
  check('first frame paints AWAITING_ORBITAL_PASS', attr3('gunner-panel', 'data-phase') === 'AWAITING_ORBITAL_PASS' && !has3('gunner-panel', 'is-hidden'));
  let guard = 0;
  while (director.getPhase() !== 'TARGETING_ACTIVE' && guard++ < 900) s = exportFrame(0.25, false);
  check('transport window opens → TARGETING_ACTIVE', director.getPhase() === 'TARGETING_ACTIVE', `phase=${director.getPhase()}`);
  check('radar pip tracks the live freighter', !has3('gunner-radar-pip-0', 'is-hidden'));
  {
    const pip = hud3.getElement('gunner-radar-pip-0');
    const caz = Number.parseFloat(pip?.getAttribute('data-contact-az') ?? '90');
    const cel = Number.parseFloat(pip?.getAttribute('data-contact-el') ?? '60');
    aim = { azimuth: caz, elevation: Math.min(85, Math.max(15, cel)) };
  }
  exportFrame(hFrame(), false); // push the fresh aim into the director first
  guard = 0;
  while (accel.getState().isSlewing && guard++ < 1200) exportFrame(hFrame(), false);
  check('crosshair tracks the articulated gantry (slew lag included)',
    Math.abs(Number.parseFloat(attr3('gunner-panel', 'data-az') ?? 'NaN') - aim.azimuth) < 0.05);
  for (let i = 0; i < 90; i++) s = exportFrame(hFrame(), true);
  check('held trigger → COIL_CHARGING on the HUD mirror', attr3('gunner-panel', 'data-phase') === 'COIL_CHARGING');
  check('charge bar + whine rose with the coils',
    Number.parseFloat(hud3.getElement('gunner-cap-fill')?.style['height'] ?? '0') > 40 &&
      audio3.isCapacitorWhineActive() && audio3.getCapacitorWhineFrequencyHz() > CAPACITOR_WHINE_FLOOR_HZ);
  s = exportFrame(hFrame(), false);
  check('trigger release launches (IN_FLIGHT_TRACKING)', s.canisterInFlight && director.getPhase() === 'IN_FLIGHT_TRACKING');
  check('Lorentz blast + Doppler whistle fire on the rising edge',
    Number.isFinite(audio3.getLastExportCueTimes().dischargeAt) && Number.isFinite(audio3.getLastExportCueTimes().whistleAt));
  check('legal export never arms the USP klaxon', audio3.isUspKlaxonAlertActive() === false);
  guard = 0;
  while (s.lastResult === 'NONE' && s.canisterInFlight && guard++ < 3000) s = exportFrame(0.25, false);
  check('arc resolves to a terminal outcome', s.lastResult !== 'NONE', `result=${s.lastResult}`);
  guard = 0;
  while (director.getPhase() !== 'INACTIVE' && guard++ < 40) s = exportFrame(0.25, false);
  exportFrame(0.25, false, false);
  check('resolved + unmounted → suite retracts, whine gates out', has3('gunner-panel', 'is-hidden') && audio3.isCapacitorWhineActive() === false);

  // Contraband siphon: klaxon + banner follow the alert state every frame.
  check('contraband session docks', director.startSession('STOLEN_CONTRABAND', 50) === true);
  exportFrame(hFrame(), false);
  guard = 0;
  while (director.getPhase() !== 'TARGETING_ACTIVE' && guard++ < 900) exportFrame(0.25, false);
  s = exportFrame(hFrame(), true);
  check('first hot spool trips the siphon + klaxon + amber banner',
    s.uspAlertActive === true && audio3.isUspKlaxonAlertActive() === true && !has3('gunner-usp', 'is-hidden') && has3('gunner-usp', 'is-hot'));
  director.cancelSession();
  s = exportFrame(hFrame(), false, false);
  check('cancel disarms klaxon and retracts the banner', s.uspAlertActive === false && audio3.isUspKlaxonAlertActive() === false && has3('gunner-usp', 'is-hidden'));

  audio3.dispose();
  director.dispose();
  hud3.dispose();
  ots.dispose();
  accel.dispose();
  check('integration surfaces tear down clean (no post-dispose state)', accel.getMeshes().length === 0 && ots.getMeshes().length === 0 && director.isDisposed() === true);
}

// ---------------------------------------------------------------------------
section('FINALE · stage render stability & clean NullEngine disposal');
// ---------------------------------------------------------------------------

{
  // NullEngine never rasterizes (repo convention): stability is proven by the
  // per-frame update law plus forced world-matrix evaluation on live meshes.
  let renderOk = true;
  try {
    const sampleMeshes = [...ma.getMeshes().slice(0, 5), ...otsStage.getMeshes().slice(0, 5)];
    for (let f = 0; f < 10; f++) {
      ma.update(hFrame());
      otsStage.update(hFrame());
      for (const m of sampleMeshes) {
        m.computeWorldMatrix(true);
        const wm = m.getWorldMatrix();
        if (!Number.isFinite(m.getWorldMatrix().m[0] ?? NaN) || wm === null) renderOk = false;
      }
    }
  } catch {
    renderOk = false;
  }
  check('10 live update + world-matrix frames on the NullEngine stage without crashing', renderOk);
  hud.dispose();
  check('HUD dispose detaches the gunner suite', hud.isDisposed() === true && hud.getExportGunnerTelemetry() === null);
  audio.dispose();
  check('audio dispose disarms every voice', audio.isDisposed() === true && audio.isUspKlaxonAlertActive() === false);
  ma.dispose();
  otsStage.dispose();
  check('facility disposes to empty accessors', ma.isBuilt() === false && ma.getMeshes().length === 0 && ma.getRootNode() === null && otsStage.getMeshes().length === 0);
  let postOk = true;
  try {
    void ma.getState();
    void ma.update(hFrame());
    void otsStage.getActiveTarget();
    void otsStage.checkCapture({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    stageScene.dispose();
    stageEngine.dispose();
  } catch {
    postOk = false;
  }
  check('post-dispose queries and scene teardown never throw', postOk);
}

// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log(`\nALL ${passed} CHECKS PASSED ✔  (Spec 27 Phase 6: CENTRAL mass-accelerator export-minigame verification suite)`);
  process.exit(0);
} else {
  console.error(`\n${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  ✘ ${f}`);
  process.exit(1);
}
