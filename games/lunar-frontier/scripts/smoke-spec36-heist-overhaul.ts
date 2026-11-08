/**
 * Spec 36 Phase 6 — headless acceptance smoke suite for the High-Speed
 * Train Heist Overhaul: Moving Cargo Toss & Dynamic Buggy Boarding.
 *
 * Runs fully headless under `npx tsx scripts/smoke-spec36-heist-overhaul.ts`
 * (exit 0 == all green). One shared `NullEngine` for the process; the
 * minimal fake DOM the HUD harness needs (same subset smoke-client-app.ts
 * uses); no network, no audio device (the LunarAudioSystem graph is a
 * synchronous mock under Node).
 *
 * Acceptance gates (Spec 36 §4, blueprint 36 §5):
 *   GATE 1  Parabolic Cargo Trajectory — the moving-frame throw law
 *           v_cargo = v_train + v_throw holds to 1e-6, the 25 m/s forward
 *           velocity is preserved, the impulse stays inside [8.0, 14.0]
 *           m/s (clamp included), the ≈25° pitch elevates the arc, and the
 *           clean vacuum track crosses the 4.5 m lateral gap inside the
 *           0.45–0.55 s window with the intercept on the buggy bed plane.
 *   GATE 2  Magnetic Hopper Latch — canisters inside R_catch = 1.8 m with
 *           ‖v_rel‖ ≤ 6 m/s feel F_mag = −k_mag·r̂ − c_damp·Δv (exactly
 *           120 N at any envelope range), integrate through the attractor
 *           and HARD-LATCH into the 2×3 bed grid within ±0.05 m of the
 *           computed rest pose, scaling M_total = M_chassis + Σ M_cargo;
 *           a full bed (6) refuses more; missed canisters age out unweighed.
 *   GATE 3  Moving Re-Boarding — the catwalk leap v_launch = v_train +
 *           v_jump·n̂_buggy (+ 2.4 m/s clearing lift) resolves to a seat
 *           capture inside R_board ≤ 2.2 m via the guidance law, flipping
 *           the player to DRIVING_BUGGY with the tether released; a missed
 *           leap books the regolith rollout and the buggy auto-stop.
 *   GATE 4  Pursuit Threat — siphoning 3+ volatile canisters arms the
 *           corporate pursuit-drone alert (telemetry + USP 440↔587 Hz
 *           klaxon law) alongside the retained 44.0 s Citadel countdown;
 *           2 canisters stay dark, and ESCAPE_COMPLETE stands the drones
 *           down.
 *   GATE 5  Economic Payout — arriving loaded at the Frontier Trading Post
 *           (220, −180): ClientApp.settleCargoAtTradingPost() empties the
 *           flatbed, credits ≥ 5,000 cr at the canonical fence table
 *           (water 1,200 / LOX 950 / He-3 4,500), banks the physical mass
 *           into market liquidity (WATER_ICE +20 kg, HELIUM3 +8 kg, LOX
 *           value-only) and shows the canonical
 *           `FUNDS CREDITED // VISIT GARAGE TERMINAL FOR VEHICLE UPGRADES`
 *           terminal prompt.
 *   GATE 6  NullEngine Gate — maglev + buggy + hopper meshes assemble and
 *           dispose cleanly on a Babylon NullEngine scene; total suite
 *           ≥ 60 assertions, zero failures.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';

import {
  HighSpeedMaglev,
  DEFAULT_CRUISE_SPEED_MPS,
  SERVICE_ROAD_OFFSET_M,
} from '../src/infrastructure/HighSpeedMaglev.ts';
import type { MaglevCarState } from '../src/infrastructure/HighSpeedMaglev.ts';
import {
  TrainHeistDirector,
  heistMoonCargoValueCredits,
  HEIST_MOON_CARGO,
  HEIST_MOON_CARGO_TYPES,
  MAX_RELATIVE_SPEED_MPS,
  BOARDING_LATERAL_MIN_M,
  BOARDING_LATERAL_MAX_M,
  TETHER_STANDBOFF_M,
  CARGO_THROW_MIN_MPS,
  CARGO_THROW_MAX_MPS,
  CARGO_THROW_STANDARD_MPS,
  CARGO_THROW_PITCH_RAD,
  CARGO_CATCH_RADIUS_M,
  CARGO_CATCH_RELATIVE_MAX_MPS,
  CARGO_CAPTURE_WINDOW_S,
  CARGO_PICKUP_RADIUS_M,
  BUGGY_BED_CENTRE_HEIGHT_M,
  DEPOT_COUNTDOWN_S,
  PURSUIT_DRONE_ALERT_CANISTERS,
  REBOARD_CATCH_RADIUS_M,
  REBOARD_JUMP_MPS,
  REBOARD_JUMP_LIFT_MPS,
  SECURE_HAUL_OBJECTIVE_KEY,
} from '../src/quests/TrainHeistDirector.ts';
import type { HeistLootPayload, TrainHeistOptions } from '../src/quests/TrainHeistDirector.ts';
import {
  OpenBuggy,
  HOPPER_CAPACITY,
  HOPPER_K_MAG_N,
  HOPPER_C_DAMP_NS_M,
  HOPPER_CATCH_RADIUS_M,
  HOPPER_RELATIVE_MAX_MPS,
  HOPPER_GRID_SLOTS,
} from '../src/entities/OpenBuggy.ts';
import type { BuggyCargoItem } from '../src/entities/OpenBuggy.ts';
import { LUNAR_GRAVITY } from '../src/physics/TraversalPhysics.ts';
import {
  MarketEngine,
  COMMODITIES,
  fencedVolatilePoolDeposits,
} from '../src/economy/MarketEngine.ts';
import { ClientApp } from '../src/client/ClientApp.ts';
import type { TradingPostSettlement } from '../src/client/ClientApp.ts';
import {
  InMemoryQuestStorage,
  FRONTIER_TRADING_POST_POSITION,
  TRADING_POST_DELIVERY_RADIUS_M,
  TRADING_POST_FUNDS_PROMPT,
} from '../src/client/QuestEngine.ts';
import {
  LunarAudioSystem,
  USP_KLAXON_LOW_HZ,
  USP_KLAXON_HIGH_HZ,
} from '../src/audio/LunarAudioSystem.ts';

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];
const gateCounts: Record<string, number> = {};
let currentGate = 'preamble';

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  \u2714 ${label}`);
  } else {
    failures.push(label);
    console.error(`  \u2718 ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}
function section(title: string): void {
  if (gateCounts[currentGate] === undefined) gateCounts[currentGate] = 0;
  console.log(`\n=== ${title} ===`);
}
function gate(name: string): void {
  currentGate = name;
}
function markGate(): void {
  gateCounts[currentGate] = passed;
}

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;
const DT = 1 / 60;

type V3 = { x: number; y: number; z: number };
const vAdd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vScale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const vLen = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const dot3 = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Rover stand point: `lat` metres off the vault heading line, `long` along it. */
function roverInEnvelope(vault: MaglevCarState, lat: number, long = 0): V3 {
  const f = vault.worldForward;
  const raw: V3 = { x: 3, y: 3, z: 0 };
  const along = dot3(raw, f);
  const perp: V3 = { x: raw.x - along * f.x, y: raw.y - along * f.y, z: raw.z - along * f.z };
  const pl = vLen(perp);
  const latVec = vScale(perp, lat / (pl || 1));
  return vAdd(vAdd(vault.worldPosition, latVec), vScale(f, long));
}

/** Fresh director on a cruising maglev, boarded and cracked, parked in
 *  DEPOT_COUNTDOWN with the (optionally overridden) loot booked. */
function boardAndCrack(
  mag: HighSpeedMaglev,
  options: Partial<TrainHeistOptions> = {},
): TrainHeistDirector {
  for (let i = 0; i < 30; i++) mag.update(DT);
  const director = new TrainHeistDirector(mag, null, options);
  director.startHeist();
  const vault = mag.getVaultCarState();
  if (vault === null) throw new Error('no vault car state — cannot board');
  const rover = roverInEnvelope(vault, 4.5);
  director.update(DT, rover, vault.speedMps);
  if (!director.executeBoardingJump()) throw new Error('boarding jump refused in envelope');
  // Hold-to-hack: the bypass timer drains at min(dt, 0.25) per call, so the
  // 6.0 s crack lands on its 24th quarter-second tick.
  let cracked = false;
  for (let i = 0; i < 60 && !cracked; i++) cracked = director.interactVaultLock(0.25);
  if (!cracked) throw new Error('vault crack refused');
  director.update(DT, rover, vault.speedMps); // LOOT_SECURED → DEPOT_COUNTDOWN
  return director;
}

// Shared NullEngine — one for every Babylon surface in this process.
const sharedEngine = new NullEngine();
void sharedEngine;

// -- minimal fake DOM (subset from smoke-client-app.ts) ---------------------

interface FakeElement {
  id: string;
  className: string;
  textContent: string | null;
  style: Record<string, string>;
  classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
  children: FakeElement[];
  parent: FakeElement | null;
  appendChild<T extends FakeElement>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  dispatchEvent(type: string, event: unknown): void;
  text(): string;
}

function makeFakeElement(tagName: string, registry: Map<string, FakeElement>): FakeElement {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  let ownText = '';
  const el: FakeElement = {
    id: '',
    className: tagName,
    get textContent(): string {
      return ownText;
    },
    set textContent(value: string | null) {
      ownText = value ?? '';
      for (const child of el.children) {
        if (child.id.length > 0 && registry.get(child.id) === child) registry.delete(child.id);
        child.parent = null;
      }
      el.children.length = 0;
    },
    style: {},
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
    children: [],
    parent: null,
    appendChild(child) {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (el.parent !== null) {
        const index = el.parent.children.indexOf(el);
        if (index >= 0) el.parent.children.splice(index, 1);
        el.parent = null;
      }
      if (el.id.length > 0 && registry.get(el.id) === el) registry.delete(el.id);
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
      if (name === 'id') {
        el.id = value;
        registry.set(value, el);
      }
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    dispatchEvent(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    text() {
      const own = el.textContent ?? '';
      return own + el.children.map((c) => c.text()).join('');
    },
  };
  return el;
}

function makeFakeDocument(): {
  body: FakeElement;
  createElement(tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
} {
  const registry = new Map<string, FakeElement>();
  const body = makeFakeElement('body', registry);
  return {
    body,
    createElement: (tag: string) => makeFakeElement(tag, registry),
    getElementById: (id: string) => registry.get(id) ?? null,
    // Babylon's engine.common dispose reaches for these on any document.
    addEventListener: (_type: string, _listener: (event: unknown) => void) => {},
    removeEventListener: (_type: string, _listener: (event: unknown) => void) => {},
  };
}

async function main(): Promise<void> {
  // =========================================================================
  // GATE 0 · velocity matching & boarding window (Spec 36 §3 Phase 6 item 1)
  // =========================================================================
  gate('gate0');
  section('GATE 0 · Velocity Matching & Boarding Window');
  {
    const mag = new HighSpeedMaglev();
    for (let i = 0; i < 60 * 40; i++) mag.update(DT); // cruise, mid-badlands
    const vault = mag.getVaultCarState();
    if (vault === null) {
      check('vault car available', false);
    } else {
      check('G0.01 Apex Express cruises at the canonical 25.0 m/s',
        near(vault.speedMps, DEFAULT_CRUISE_SPEED_MPS, 1e-9) && DEFAULT_CRUISE_SPEED_MPS === 25.0);
      check('G0.02 tether standoff is the 4.5 m parallel-roads gap',
        TETHER_STANDBOFF_M === 4.5 && SERVICE_ROAD_OFFSET_M === 4.0);

      const director = new TrainHeistDirector(mag, null);
      check('G0.03 startHeist opens INTERCEPTING', director.startHeist() && director.getPhase() === 'INTERCEPTING');
      const farOut = director.update(DT, { x: 0, y: 0, z: 0 }, 35);
      check('G0.04 outside envelope: canBoard false, stays INTERCEPTING',
        !farOut.canBoard && director.getPhase() === 'INTERCEPTING');
      const rover = roverInEnvelope(vault, 4.5);
      const matched = director.update(DT, rover, vault.speedMps);
      check('G0.05 velocity-matched pace → BOARDING_WINDOW',
        matched.canBoard && director.getPhase() === 'BOARDING_WINDOW');
      check('G0.06 envelope reads Δv ≈ 0 at the 4.5 m lateral stand-off',
        near(matched.relativeSpeedMps, 0, 1e-9) && near(matched.lateralDistanceM, 4.5, 1e-3));

      let dvOk = true;
      for (let dv = 0; dv <= 5.001; dv += 0.25) {
        const t = director.update(DT, rover, vault.speedMps - dv);
        if (t.canBoard !== dv <= MAX_RELATIVE_SPEED_MPS + 1e-9) {
          dvOk = false;
          break;
        }
      }
      check('G0.07 Δv fuzz [0,5]: lock ⇔ Δv ≤ 3.5 m/s', dvOk && MAX_RELATIVE_SPEED_MPS === 3.5);
      let latOk = true;
      for (let lat = BOARDING_LATERAL_MIN_M; lat <= BOARDING_LATERAL_MAX_M; lat += 0.5) {
        if (!director.update(DT, roverInEnvelope(vault, lat), vault.speedMps).canBoard) {
          latOk = false;
          break;
        }
      }
      check('G0.08 lateral band [2.5, 5.5] m keeps the boarding lock', latOk);
      check('G0.09 executeBoardingJump succeeds inside the window',
        director.executeBoardingJump() && director.getPhase() === 'ON_BOARD_CRACKING');
      check('G0.10 rover tethered-autopilot engages on boarding', director.isAutopilotTetherActive());
      director.dispose();
    }
    mag.dispose();
  }
  markGate();

  // =========================================================================
  // GATE 1 · Parabolic cargo trajectory (Spec 36 §2.1 / §4.1)
  // =========================================================================
  gate('gate1');
  section('GATE 1 · Parabolic Cargo Trajectory (v_cargo = v_train + v_throw)');
  {
    const mag = new HighSpeedMaglev();
    for (let i = 0; i < 60 * 40; i++) mag.update(DT);
    const director = new TrainHeistDirector(mag, null);
    director.startHeist();
    const vault = mag.getVaultCarState();
    if (vault === null) throw new Error('no vault car — gate 1 aborted');
    const rover = roverInEnvelope(vault, 4.5);
    director.update(DT, rover, vault.speedMps);
    director.executeBoardingJump();

    check('G1.01 canonical throw constants 8.0 / 14.0 / 10.0 m/s @ 0.44 rad',
      CARGO_THROW_MIN_MPS === 8.0 && CARGO_THROW_MAX_MPS === 14.0 &&
        CARGO_THROW_STANDARD_MPS === 10.0 && near(CARGO_THROW_PITCH_RAD, 0.44, 1e-12));
    check('G1.02 capture constants: R_catch 1.8 m, v_rel ≤ 6.0 m/s, window 2.5 s',
      CARGO_CATCH_RADIUS_M === 1.8 && CARGO_CATCH_RELATIVE_MAX_MPS === 6.0 &&
        CARGO_CAPTURE_WINDOW_S === 2.5);

    check('G1.03 hands free before the first unclamp', !director.isCarryingCargo());
    const contact = director.nearestCargoPickup();
    check('G1.04 roof cradle in reach on the catwalk ([E] prompt source)',
      contact !== null && contact.distanceM <= CARGO_PICKUP_RADIUS_M + 1e-6);
    const picked = director.interactCargoPickUp();
    check('G1.05 unclamp & pick up hands the canister to the avatar',
      picked === 'LOX_CYLINDER' && director.getCarriedCargoType() === 'LOX_CYLINDER');
    check('G1.06 roof cradle stock decremented (2 → 1 LOX)',
      director.getRoofCargoRemaining().LOX_CYLINDER === 1);

    const aim = director.getCargoThrowAim();
    check('G1.07 predictive lead reticle solves toward the tracking buggy',
      aim !== null && aim.willCatch === true && aim.missDistanceM < 0.5);
    check('G1.08 clean track crosses the 4.5 m lateral gap in 0.45–0.55 s',
      aim !== null && aim.gapCrossTimeS >= 0.45 && aim.gapCrossTimeS <= 0.55,
      `gapCross=${aim?.gapCrossTimeS.toFixed(3)}s`);

    // The throw itself — moving-frame law checked against a fresh train read.
    const vTrainNow = mag.getVaultCarState();
    if (vTrainNow === null) throw new Error('vault car lost mid-throw');
    const vTrain = vScale(vTrainNow.worldForward, vTrainNow.speedMps);
    const thrown = director.executeCargoThrow();
    const rel = thrown === null ? null : vAdd(thrown.launchVelocity, vScale(vTrain, -1));
    check('G1.09 executeCargoThrow releases the canister (hands free after)',
      thrown !== null && !director.isCarryingCargo());
    check('G1.10 moving-frame law ‖v_cargo − v_train‖ = 10.0 m/s exactly (1e-6)',
      rel !== null && near(vLen(rel), CARGO_THROW_STANDARD_MPS, 1e-6));
    check('G1.11 launch preserves the 25 m/s forward velocity (train frame)',
      thrown !== null &&
        near(dot3(thrown.launchVelocity, vTrainNow.worldForward), DEFAULT_CRUISE_SPEED_MPS, 0.5),
      `fwd=${thrown ? dot3(thrown.launchVelocity, vTrainNow.worldForward).toFixed(2) : 'n/a'}`);
    check('G1.12 ≈25° pitch elevation: v_z = v_throw·sin φ',
      thrown !== null &&
        near(
          thrown.launchVelocity.z - vTrain.z,
          CARGO_THROW_STANDARD_MPS * Math.sin(CARGO_THROW_PITCH_RAD),
          1e-6,
        ));
    check('G1.13 vacuum arc lands on the buggy bed plane (intercept z = bed datum)',
      thrown !== null &&
        near(
          thrown.interceptPoint.z,
          director.getTetheredRoverTargetPos().z + BUGGY_BED_CENTRE_HEIGHT_M,
          1e-9,
        ));
    check('G1.14 intercept is ballistic: r = r₀ + v·t (no drag, C_d = 0)',
      thrown !== null &&
        near(thrown.releasePoint.x + thrown.launchVelocity.x * thrown.flightTimeS, thrown.interceptPoint.x, 1e-9) &&
        near(thrown.releasePoint.y + thrown.launchVelocity.y * thrown.flightTimeS, thrown.interceptPoint.y, 1e-9));
    check('G1.15 magnetic hopper takes the clean gap cross (caught)',
      thrown !== null && thrown.caught === true && thrown.missDistanceM <= CARGO_CATCH_RADIUS_M);
    check('G1.16 caught canister credited to the payload + hopper counter',
      director.getCargoCaughtCount() === 1 &&
        heistMoonCargoValueCredits(director.getLootPayload()) >= 950);

    // Impulse clamp band [8.0, 14.0] m/s.
    director.interactCargoPickUp();
    const vT2 = mag.getVaultCarState();
    if (vT2 === null) throw new Error('vault car lost');
    const vTrain2 = vScale(vT2.worldForward, vT2.speedMps);
    const over = director.executeCargoThrow(20);
    check('G1.17 overpowered throw clamps to 14.0 m/s',
      over !== null && near(vLen(vAdd(over.launchVelocity, vScale(vTrain2, -1))), CARGO_THROW_MAX_MPS, 1e-6));
    // Second LOX cradle is now empty — walk (deck dz) to the He-3 cradle.
    for (let i = 0; i < 6; i++) director.update(DT, rover, vault.speedMps, { dz: 40 });
    const he3Pick = director.interactCargoPickUp();
    const vT3 = mag.getVaultCarState();
    const vTrain3 = vT3 === null ? { x: 0, y: 0, z: 0 } : vScale(vT3.worldForward, vT3.speedMps);
    const soft = director.executeCargoThrow(3);
    check('G1.18 He-3 cradle reachable down the catwalk; under-power clamps to 8.0 m/s',
      he3Pick === 'HE3_FLASK' && soft !== null &&
        near(vLen(vAdd(soft.launchVelocity, vScale(vTrain3, -1))), CARGO_THROW_MIN_MPS, 1e-6));

    // A bad aim throws wide: no credit, hopper count frozen (whatever the
    // clean auto-tracked canisters above banked must not move).
    const caughtBefore = director.getCargoCaughtCount();
    const he3Pick2 = director.interactCargoPickUp();
    director.setCargoAimHeading(vT3 === null ? 0 : Math.atan2(vT3.worldForward.y, vT3.worldForward.x));
    const wide = director.executeCargoThrow();
    check('G1.19 off-aim throw misses the envelope and credits nothing',
      he3Pick2 === 'HE3_FLASK' && wide !== null && wide.caught === false &&
        wide.missDistanceM > CARGO_CATCH_RADIUS_M && director.getCargoCaughtCount() === caughtBefore);
    director.setCargoAimHeading(null);
    check('G1.20 hands free → aim readout null, throw refuses',
      director.getCargoThrowAim() === null && director.executeCargoThrow() === null);
    check('G1.21 moon-cargo value table 1,200 / 950 / 4,500 cr',
      HEIST_MOON_CARGO.WATER_CRYO_CELL.unitValueCredits === 1200 &&
        HEIST_MOON_CARGO.LOX_CYLINDER.unitValueCredits === 950 &&
        HEIST_MOON_CARGO.HE3_FLASK.unitValueCredits === 4500 &&
        HEIST_MOON_CARGO_TYPES.length === 3);
    director.dispose();
    mag.dispose();
  }
  markGate();

  // =========================================================================
  // GATE 2 · Magnetic hopper latch (Spec 36 §2.2 / §4.2)
  // =========================================================================
  gate('gate2');
  section('GATE 2 · Buggy Magnetic Hopper Catch & 2×3 Hard Latch');
  {
    check('G2.01 hopper constants: capacity 6, k_mag 120 N, c_damp 35 N·s/m',
      HOPPER_CAPACITY === 6 && HOPPER_K_MAG_N === 120 && HOPPER_C_DAMP_NS_M === 35);
    check('G2.02 hopper aliases the director capture envelope (no drift)',
      HOPPER_CATCH_RADIUS_M === CARGO_CATCH_RADIUS_M && HOPPER_RELATIVE_MAX_MPS === CARGO_CATCH_RELATIVE_MAX_MPS);
    check('G2.03 stacking grid is 2 columns × 3 rows of distinct slots',
      HOPPER_GRID_SLOTS.length === 6 &&
        new Set(HOPPER_GRID_SLOTS.map((s) => `${s.x.toFixed(2)}/${s.z.toFixed(2)}`)).size === 6 &&
        new Set(HOPPER_GRID_SLOTS.map((s) => s.x)).size === 2);

    const buggy = new OpenBuggy();
    const hopper = buggy.getCargoHopper();
    check('G2.04 sceneless hopper constructs lazily off the rover', hopper !== null);
    if (hopper === null) throw new Error('hopper missing — gate 2 aborted');

    const grossBase = hopper.getGrossVehicleMassKg();
    const cargoBase = buggy.getCargoMass();
    check('G2.05 gross vehicle mass starts at the chassis + base-cargo loader read',
      Number.isFinite(grossBase) && grossBase > 0 && Number.isFinite(cargoBase));

    const centre = hopper.bedCentreWorld();
    check('G2.06 bed-centre datum sits 0.55 m above the chassis plane',
      near(centre.z, buggy.getPosition().z + 0.55, 1e-9));

    // Attractor field law.
    const above = { x: centre.x, y: centre.y, z: centre.z + 1.2 };
    const fieldIn = hopper.evaluateCapture(above, { x: 0, y: 0, z: 0 });
    check('G2.07 inside R_catch the field engages (1.2 m, v_rel 0)',
      fieldIn.withinCatchEnvelope === true && near(fieldIn.distanceToBedCentreM, 1.2, 1e-9));
    check('G2.08 F_mag magnitude = k_mag = 120 N pulling toward the bed centre',
      near(vLen(fieldIn.force), HOPPER_K_MAG_N, 1e-6) &&
        dot3(fieldIn.force, vAdd(centre, vScale(above, -1))) > 0);
    const fieldOut = hopper.evaluateCapture({ x: centre.x, y: centre.y, z: centre.z + 2.5 }, { x: 0, y: 0, z: 0 });
    check('G2.09 outside R_catch (2.5 m) the field is dead',
      fieldOut.withinCatchEnvelope === false && vLen(fieldOut.force) === 0);
    const fieldFast = hopper.evaluateCapture({ x: centre.x, y: centre.y, z: centre.z + 1.0 }, { x: 0, y: 0, z: -7 });
    check('G2.10 relative-velocity ceiling: 7 m/s over the bed refuses capture',
      fieldFast.withinCatchEnvelope === false && near(fieldFast.relativeSpeedMps, 7, 1e-9));

    // Live attractor catch: launch 1.5 m above the bed, integrate, latch.
    const launched = hopper.launchCargo(
      'WATER_CRYO_CELL',
      { x: centre.x, y: centre.y, z: centre.z + 1.5 },
      { x: 0, y: 0, z: -0.5 },
    );
    let caught: BuggyCargoItem | null = null;
    for (let i = 0; i < 3 * 60 && caught === null; i++) {
      const latched = hopper.step(DT);
      if (latched.length > 0) caught = latched[0]!;
    }
    check('G2.11 inbound canister integrates through the attractor and latches < 3 s',
      launched !== null && caught !== null);
    if (caught !== null) {
      check('G2.12 latched state flips to LATCHED in slot 0 of the 2×3 grid',
        caught.state === 'LATCHED' && caught.slot === 0 && caught.massKg === 10.0);
      // Independent rest-pose solve: grid slot + floor(0.34) + half-height.
      const grid = HOPPER_GRID_SLOTS[0]!;
      const rest = buggy.pointAt(grid.z, grid.x, 0.34 + 0.34 / 2);
      check('G2.13 latch lands within ±0.05 m of the computed grid rest pose',
        near(caught.position.x, rest.x, 0.05) &&
          near(caught.position.y, rest.y, 0.05) &&
          near(caught.position.z, rest.z, 0.05));
    }
    check('G2.14 caught mass rides the physics loader: +10.0 kg cargo, +10.0 kg gross',
      near(hopper.getCargoMassKg(), 10.0, 1e-9) &&
        near(buggy.getCargoMass(), cargoBase + 10.0, 1e-9) &&
        near(hopper.getGrossVehicleMassKg(), grossBase + 10.0, 1e-9));

    // Fill the bed: 2×3 = 6, then refuse more.
    const extras: Array<'LOX_CYLINDER' | 'HE3_FLASK' | 'WATER_CRYO_CELL'> = [
      'LOX_CYLINDER', 'HE3_FLASK', 'WATER_CRYO_CELL', 'LOX_CYLINDER', 'HE3_FLASK',
    ];
    for (const type of extras) hopper.addCargo(type);
    const items = hopper.getCargoItems();
    check('G2.15 six canisters fill the bed (slots 0..5 all occupied)',
      hopper.isFull() && items.length === 6 &&
        new Set(items.map((it) => it.slot)).size === 6);
    const expectedMass = 10 + 8 + 4 + 10 + 8 + 4;
    check('G2.16 M_total = M_chassis + Σ M_cargo with the full bed',
      near(hopper.getCargoMassKg(), expectedMass, 1e-9) &&
        near(hopper.getGrossVehicleMassKg(), grossBase + expectedMass, 1e-9));
    check('G2.17 a full hopper refuses addCargo and launchCargo',
      hopper.addCargo('HE3_FLASK') === null &&
        hopper.launchCargo('WATER_CRYO_CELL', centre, { x: 0, y: 0, z: 0 }) === null);

    // Unload returns the bed and the mass.
    hopper.clearCargo();
    check('G2.18 clearCargo unloads the flatbed and lifts the mass back off',
      hopper.getCargoItems().length === 0 && hopper.getCargoMassKg() === 0 &&
        near(buggy.getCargoMass(), cargoBase, 1e-9) &&
        near(hopper.getGrossVehicleMassKg(), grossBase, 1e-9));

    // A canister that misses ages out of tracking unweighed: launched fast
    // (25 m/s ≫ the 6 m/s capture ceiling) no attractor ever owns it.
    const miss = hopper.launchCargo('WATER_CRYO_CELL', { x: centre.x, y: centre.y, z: centre.z + 0.5 }, { x: 25, y: 0, z: 0 });
    for (let i = 0; i < Math.ceil(5.6 * 60); i++) hopper.step(DT);
    check('G2.19 a wide launch ages out (> 5 s) and is never weighed',
      miss !== null && hopper.getCargoItems().length === 0 && hopper.getCargoMassKg() === 0);

    // addHopperCargo / clearHopperCargo convenience on the entity.
    const conv = buggy.addHopperCargo('HE3_FLASK');
    check('G2.20 OpenBuggy.addHopperCargo convenience latches + weighs 4.0 kg',
      conv !== null && buggy.getHopperCargoMassKg() === 4.0);
    buggy.clearHopperCargo();
    check('G2.21 OpenBuggy.clearHopperCargo empties the bed', buggy.getHopperCargoItems().length === 0);
    buggy.dispose();
  }
  markGate();

  // =========================================================================
  // GATE 3 · Moving re-boarding leap (Spec 36 §2.3 / §4.3)
  // =========================================================================
  gate('gate3');
  section('GATE 3 · Dynamic Moving Re-Boarding (R_board ≤ 2.2 m seat capture)');
  {
    check('G3.01 canonical re-boarding constants R_board 2.2, v_jump 4.5, lift 2.4',
      REBOARD_CATCH_RADIUS_M === 2.2 && REBOARD_JUMP_MPS === 4.5 && REBOARD_JUMP_LIFT_MPS === 2.4);

    // Refusals first: no train hold, no tether, no leap.
    const idleMag = new HighSpeedMaglev();
    const idleDir = new TrainHeistDirector(idleMag, null);
    check('G3.02 re-boarding refuses off the train / without the tether',
      !idleDir.canReboardBuggy() && idleDir.executeReboardingJump() === null &&
        idleDir.resolveReboardingCatch({ x: 0, y: 0, z: 0 }) === null);
    idleDir.dispose();
    idleMag.dispose();

    const mag = new HighSpeedMaglev();
    const director = boardAndCrack(mag);
    check('G3.03 catwalk can launch the leap while the tether holds the buggy parallel',
      director.getPhase() === 'DEPOT_COUNTDOWN' && director.canReboardBuggy());

    const seat = director.getBuggySeatDatum();
    const launch = director.executeReboardingJump();
    if (launch === null) throw new Error('re-boarding launch refused on the catwalk');
    const vNow = mag.getVaultCarState();
    if (vNow === null) throw new Error('vault car lost');
    const vTrain = vScale(vNow.worldForward, vNow.speedMps);
    check('G3.04 launch snapshot records launch point at the avatar anchor',
      near(launch.launchPoint.x, director.getPlayerWorldPos().x, 1e-9) &&
        near(launch.launchPoint.z, director.getPlayerWorldPos().z, 1e-9));
    const dxh = seat.x - launch.launchPoint.x;
    const dyh = seat.y - launch.launchPoint.y;
    const hl = Math.hypot(dxh, dyh);
    check('G3.05 v_launch = v_train + 4.5·n̂_buggy (+2.4 m/s clearing lift)',
      near(launch.launchVelocity.x, vTrain.x + (dxh / hl) * REBOARD_JUMP_MPS, 1e-6) &&
        near(launch.launchVelocity.y, vTrain.y + (dyh / hl) * REBOARD_JUMP_MPS, 1e-6) &&
        near(launch.launchVelocity.z, vTrain.z + REBOARD_JUMP_LIFT_MPS, 1e-6));
    check('G3.06 leap goes airborne; NaN positions never resolve it',
      director.isReboardLeapActive() &&
        director.resolveReboardingCatch({ x: NaN, y: 0, z: 0 }, { z: -1 }) === null);
    check('G3.07 guidance velocity answers while the leap is in flight',
      director.getReboardGuidanceVelocity(seat) !== null);

    // Catch run: guidance law steers the avatar into R_board while falling.
    let pos = { ...launch.launchPoint };
    let result: ReturnType<TrainHeistDirector['resolveReboardingCatch']> | null = null;
    for (let i = 0; i < 8 * 60 && (result === null || !result.caught); i++) {
      const guide = director.getReboardGuidanceVelocity(pos);
      if (guide === null) break;
      pos = { x: pos.x + guide.x * DT, y: pos.y + guide.y * DT, z: pos.z + guide.z * DT };
      mag.update(DT); // the seat datum tracks the parallel autopilot
      result = director.resolveReboardingCatch(pos, guide);
    }
    check('G3.08 guidance law delivers the avatar inside R_board = 2.2 m while falling',
      result !== null && result.caught === true && result.distanceToSeatM <= REBOARD_CATCH_RADIUS_M,
      `d=${result?.distanceToSeatM.toFixed(2)}m`);
    check('G3.09 seat capture snaps control: DRIVING_BUGGY, tether released',
      director.isPlayerDrivingBuggy() && !director.isAutopilotTetherActive() &&
        !director.isReboardLeapActive() && director.getReboardOutcome() === 'CAUGHT');
    check('G3.10 capture books BAILOUT_SUCCESS + SECURE_HAUL_TO_TRADING_POST bridge',
      director.getPhase() === 'BAILOUT_SUCCESS' &&
        result !== null && result.objectiveKey === SECURE_HAUL_OBJECTIVE_KEY &&
        SECURE_HAUL_OBJECTIVE_KEY === 'SECURE_HAUL_TO_TRADING_POST');
    check('G3.11 resolved seat datum matches the tracked autopilot seat plane',
      result !== null && near(result.seatPosition.z, director.getBuggySeatDatum().z, 1e-6));
    check('G3.12 finishEscape hands off to the delivery stage',
      director.finishEscape() && director.getPhase() === 'ESCAPE_COMPLETE');
    director.dispose();

    // Miss run: pure ballistic leap with no guidance never reaches the seat.
    const mag2 = new HighSpeedMaglev();
    const missDir = boardAndCrack(mag2);
    const missLaunch = missDir.executeReboardingJump();
    if (missLaunch === null) throw new Error('miss-run launch refused');
    let mpos = { ...missLaunch.launchPoint };
    const mvel = { ...missLaunch.launchVelocity };
    let missRes: ReturnType<TrainHeistDirector['resolveReboardingCatch']> | null = null;
    for (let i = 0; i < 12 * 60 && missDir.getReboardOutcome() === null; i++) {
      mvel.z -= LUNAR_GRAVITY * DT;
      mpos = { x: mpos.x + mvel.x * DT, y: mpos.y + mvel.y * DT, z: mpos.z + mvel.z * DT };
      mag2.update(DT);
      missRes = missDir.resolveReboardingCatch(mpos, mvel);
    }
    check('G3.13 an unguided leap books the regolith rollout (MISSED)',
      missRes !== null && missRes.caught === false && missDir.getReboardOutcome() === 'MISSED' &&
        missRes.distanceToSeatM > REBOARD_CATCH_RADIUS_M);
    check('G3.14 a miss drops the tether and arms the buggy service-road auto-stop',
      missDir.isBuggyAutoStopActive() && !missDir.isAutopilotTetherActive() &&
        missDir.getPhase() === 'BAILOUT_SUCCESS');
    check('G3.15 auto-stop books once (complete → true, repeat → false)',
      missDir.completeBuggyAutoStop() === true && missDir.completeBuggyAutoStop() === false);
    missDir.dispose();
    mag2.dispose();
  }
  markGate();

  // =========================================================================
  // GATE 4 · Pursuit threat + 44 s Citadel countdown (Phase 4 / §4)
  // =========================================================================
  gate('gate4');
  section('GATE 4 · Pursuit-Drone Alert @ 3+ Canisters + 44.0 s Countdown');
  {
    check('G4.01 canonical constants: 3-canister threshold, 44.0 s depot clock',
      PURSUIT_DRONE_ALERT_CANISTERS === 3 && DEPOT_COUNTDOWN_S === 44.0);

    const mag = new HighSpeedMaglev();
    const loot: Partial<HeistLootPayload> = {
      he3CryoFlasks: 0,
      quantumCipherSlates: 0,
      superconductingCoils: 0,
      waterCryoCells: 2,
      loxCylinders: 1,
    };
    const director = boardAndCrack(mag, { loot });
    check('G4.02 crack pop arms the 44.0 s Citadel countdown exactly',
      director.getCountdownRemainingS() === DEPOT_COUNTDOWN_S);
    check('G4.03 three volatile canisters siphoned → pursuit-drone alert live',
      director.getVolatileCanistersSiphoned() === 3 && director.isPursuitDroneAlertActive() === true);
    const vault = mag.getVaultCarState();
    const rover = vault === null ? { x: 0, y: 0, z: 0 } : roverInEnvelope(vault, 4.5);
    const tele = director.update(DT, rover, 25);
    check('G4.04 telemetry carries pursuitDroneAlert + siphoned count (bridge dark until clear)',
      tele.pursuitDroneAlert === true && tele.volatileCanistersSiphoned === 3 &&
        tele.objectiveKey === null);

    // The alert persists alongside the draining countdown.
    let t2 = tele;
    for (let i = 0; i < 600; i++) t2 = director.update(DT, rover, 25);
    check('G4.05 alert stays live while the countdown drains 44 → ~34 s',
      director.isPursuitDroneAlertActive() === true &&
        t2.countdownRemainingS > 33 && t2.countdownRemainingS < 35);

    // Audio law: the USP 440↔587 Hz klaxon the client pump arms with the alert.
    const audio = new LunarAudioSystem();
    audio.setUspKlaxonAlert(director.isPursuitDroneAlertActive());
    const tones = audio.getUspKlaxonTones();
    check('G4.06 pursuit siren arms on the canonical 440 ↔ 587 Hz USP law',
      audio.isUspKlaxonAlertActive() === true && tones.lowHz === USP_KLAXON_LOW_HZ &&
        tones.highHz === USP_KLAXON_HIGH_HZ && USP_KLAXON_LOW_HZ === 440 && USP_KLAXON_HIGH_HZ === 587);
    audio.setUspKlaxonAlert(false);
    check('G4.07 siren stands down cleanly', audio.isUspKlaxonAlertActive() === false);
    audio.dispose();
    director.dispose();

    // Under threshold: 2 canisters stay dark.
    const mag2 = new HighSpeedMaglev();
    const dark = boardAndCrack(mag2, {
      loot: {
        he3CryoFlasks: 0,
        quantumCipherSlates: 0,
        superconductingCoils: 0,
        waterCryoCells: 2,
      },
    });
    check('G4.08 two canisters siphoned stay below the pursuit threshold',
      dark.getVolatileCanistersSiphoned() === 2 && dark.isPursuitDroneAlertActive() === false);

    // Escape stands the drones down: bailout → ESCAPE_COMPLETE.
    dark.executeBailoutJump();
    dark.finishEscape();
    check('G4.09 ESCAPE_COMPLETE stands the pursuit drones down',
      dark.getPhase() === 'ESCAPE_COMPLETE' && dark.isPursuitDroneAlertActive() === false);
    dark.dispose();
    mag2.dispose();
    mag.dispose();
  }
  markGate();

  // =========================================================================
  // GATE 5 · Trading-post delivery & economy fencing (Phase 5 / §4.4)
  // =========================================================================
  gate('gate5');
  section('GATE 5 · Economic Payout at the Frontier Trading Post (220, −180)');
  {
    check('G5.01 trading post seat (220, −180), 15 m delivery envelope',
      FRONTIER_TRADING_POST_POSITION.x === 220 && FRONTIER_TRADING_POST_POSITION.y === -180 &&
        TRADING_POST_DELIVERY_RADIUS_M === 15);
    check('G5.02 canonical terminal prompt text (verbatim)',
      TRADING_POST_FUNDS_PROMPT === 'FUNDS CREDITED // VISIT GARAGE TERMINAL FOR VEHICLE UPGRADES');
    check('G5.03 fence valuation table: 1,200 / 950 / 4,500 cr per canister',
      heistMoonCargoValueCredits({ waterCryoCells: 1 }) === 1200 &&
        heistMoonCargoValueCredits({ loxCylinders: 1 }) === 950 &&
        heistMoonCargoValueCredits({ he3Flasks: 1 }) === 4500 &&
        heistMoonCargoValueCredits({}) === 0);
    check('G5.04 liquidity mapping: water→WATER_ICE ×10, He-3→HELIUM3 ×4, LOX value-only',
      JSON.stringify(fencedVolatilePoolDeposits({ waterCryoCells: 2, loxCylinders: 1, he3Flasks: 2 })) ===
        JSON.stringify({ WATER_ICE: 20, HELIUM3: 8 }) &&
        !COMMODITIES.includes('OXYGEN' as (typeof COMMODITIES)[number]));

    // Full-stack ClientApp run: load the flatbed, settle the haul.
    (globalThis as { document?: unknown }).document = makeFakeDocument();
    const app = new ClientApp({
      seed: 'spec36-heist-smoke',
      username: 'smoke-runner',
      faction: 'RUSTBELT',
      network: null,
      autoConnect: false,
      createHud: true,
      questStorage: new InMemoryQuestStorage(),
      silent: true,
    });
    await app.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));
    check('G5.05 ClientApp boots headless with HUD (NullEngine, no network)',
      app.isInitialized() && app.getHud() !== null && app.getBuggy().isBuilt());

    const toasts: string[] = [];
    const hud = app.getHud() as { showToast(message: string, kind: string): void } | null;
    if (hud !== null) {
      const original = hud.showToast.bind(hud);
      (hud as { showToast(message: string, kind: string): void }).showToast = (message, kind) => {
        toasts.push(message);
        original(message, kind);
      };
    }

    const buggy = app.getBuggy();
    const hopper = buggy.getCargoHopper();
    if (hopper === null) throw new Error('client buggy hopper missing');
    const grossBase = hopper.getGrossVehicleMassKg();
    buggy.addHopperCargo('HE3_FLASK');
    buggy.addHopperCargo('HE3_FLASK');
    buggy.addHopperCargo('WATER_CRYO_CELL');
    buggy.addHopperCargo('WATER_CRYO_CELL');
    buggy.addHopperCargo('LOX_CYLINDER');
    check('G5.06 flatbed rides 5 canisters, +36.0 kg on the gross vehicle mass',
      buggy.getHopperCargoItems().length === 5 &&
        near(hopper.getGrossVehicleMassKg(), grossBase + 36.0, 1e-9));

    const nearPost = Math.hypot(
      buggy.getPosition().x - FRONTIER_TRADING_POST_POSITION.x,
      buggy.getPosition().y - FRONTIER_TRADING_POST_POSITION.y,
    );
    check('G5.07 delivery envelope arbiter agrees with the (220, −180)/15 m geometry',
      app.isNearTradingPost() === (nearPost <= TRADING_POST_DELIVERY_RADIUS_M) &&
        app.isNearTradingPost(1e6) === true);

    const settlement: TradingPostSettlement | null = app.settleCargoAtTradingPost();
    check('G5.08 settleCargoAtTradingPost takes the haul (5 canisters)',
      settlement !== null && settlement.canisterCount === 5 &&
        settlement.waterCryoCells === 2 && settlement.loxCylinders === 1 &&
        settlement.he3Flasks === 2 && settlement.legacyLootFenced === false);
    check('G5.09 payout ≥ 5,000 cr at the canonical table (2×4,500 + 2×1,200 + 950)',
      settlement !== null && settlement.creditsCredited === 12350 && settlement.creditsCredited >= 5000);
    check('G5.10 physical mass banks into market liquidity (WATER_ICE 20, HELIUM3 8)',
      settlement !== null &&
        near(settlement.depositedKg['WATER_ICE'] ?? 0, 20, 1e-9) &&
        near(settlement.depositedKg['HELIUM3'] ?? 0, 8, 1e-9) &&
        settlement.depositedKg['OXYGEN'] === undefined &&
        (settlement.reservesAfter['WATER_ICE'] ?? 0) >= 20);
    check('G5.11 flatbed empties and the mass comes off the rover',
      buggy.getHopperCargoItems().length === 0 && buggy.getHopperCargoMassKg() === 0 &&
        near(hopper.getGrossVehicleMassKg(), grossBase, 1e-9));
    check('G5.12 terminal shows the payout toast + canonical FUNDS CREDITED prompt',
      toasts.some((t) => t.includes('+12350 CR') && t.includes('Frontier Trading Post')) &&
        toasts.includes(TRADING_POST_FUNDS_PROMPT));
    check('G5.13 empty-bed settle settles nothing (state untouched)',
      app.settleCargoAtTradingPost() === null);

    await app.dispose();

    // MarketEngine law: fenced supply moves the pool and the spot curve.
    const mkt = new MarketEngine();
    const waterBefore = mkt.reserveOf('WATER_ICE');
    const he3Before = mkt.reserveOf('HELIUM3');
    const priceBefore = mkt.spotPrice('WATER_ICE');
    const reserves = mkt.depositFencedCargo({ waterCryoCells: 2, loxCylinders: 1, he3Flasks: 2 });
    check('G5.14 depositFencedCargo raises reserves (+20 WATER_ICE, +8 HELIUM3)',
      near(reserves['WATER_ICE'] ?? 0, waterBefore + 20, 1e-9) &&
        near(reserves['HELIUM3'] ?? 0, he3Before + 8, 1e-9));
    check('G5.15 supply onto the curve drives the WATER_ICE spot price down',
      mkt.spotPrice('WATER_ICE') < priceBefore);
    mkt.dispose();
  }
  markGate();

  // =========================================================================
  // GATE 6 · NullEngine assembly & disposal (Spec 36 Phase 6 item 6)
  // =========================================================================
  gate('gate6');
  section('GATE 6 · Babylon NullEngine Assembly, Meshes & Disposal');
  {
    const engine = new NullEngine({ renderWidth: 640, renderHeight: 360 } as never);
    const scene = new Scene(engine);
    check('G6.01 NullEngine scene stands up (never rasterizes, always computes)',
      scene.getEngine() === engine && !engine.isDisposed);

    const mag = new HighSpeedMaglev().init(scene);
    check('G6.02 Apex Express procedural assembly builds on NullEngine',
      mag.isBuilt() && mag.getMeshes().length > 0);

    const buggy = new OpenBuggy().init(scene);
    check('G6.03 rover procedural assembly builds on NullEngine',
      buggy.isBuilt() && buggy.getMeshes().length > 0);

    buggy.addHopperCargo('WATER_CRYO_CELL');
    buggy.addHopperCargo('LOX_CYLINDER');
    buggy.addHopperCargo('HE3_FLASK');
    const hopper = buggy.getCargoHopper();
    check('G6.04 latched canisters render as procedural child meshes in the bed',
      hopper !== null && hopper.getMeshes().length === 3 &&
        buggy.getHopperCargoMassKg() === 22.0);
    buggy.clearHopperCargo();
    check('G6.05 unloading disposes the canister meshes cleanly',
      hopper !== null && hopper.getMeshes().length === 0);

    const st = mag.update(DT);
    check('G6.06 maglev kinematics stay finite on the NullEngine clock',
      Number.isFinite(st.speedMps) && Number.isFinite(mag.getHeadDistanceM()));

    buggy.dispose();
    mag.dispose();
    check('G6.07 dispose drains the stage (no meshes, not built)',
      !buggy.isBuilt() && !mag.isBuilt() && mag.getMeshes().length === 0);
    scene.dispose();
    engine.dispose();
  }
  markGate();

  // -- final gates ---------------------------------------------------------
  section('FINAL');
  check(`G9.01 suite carries ≥ 60 assertions (Spec 36 §4.5) — got ${passed}`, passed >= 60);
  check(`G9.02 100% headless pass under Babylon.js NullEngine — ${failures.length} failure(s)`,
    failures.length === 0);

  const gateSummary = Object.entries(gateCounts)
    .map(([g, n]) => `${g}:${n}`)
    .join('  ');
  console.log(`\n${passed} assertions passed, ${failures.length} failed (${gateSummary})`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAILED: ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error('smoke-spec36-heist-overhaul crashed:', err);
  delete (globalThis as { document?: unknown }).document;
  process.exit(1);
});
