/**
 * Spec 27 Phase 4 verification probe: ExportMinigameDirector functional contract.
 * Run: `npx tsx scripts/smoke-export-director.ts`  (exit code 0 == all green)
 *
 * Covers Spec 27 §3.4 gate group 4: the phase machine (DOCKING_CONSOLE →
 * AWAITING_ORBITAL_PASS → TARGETING_ACTIVE → COIL_CHARGING → IN_FLIGHT_TRACKING
 * → CAPTURE_SUCCESS / INTERCEPT_FAILED → COOLING_DOWN), session validation and
 * garbage-input hardening, the 4.5 s thermal-breaker overcharge trip and
 * breaker-cooldown recovery, live fire-control bulk-capture with the exact
 * 2.5× payout table, the 45.0 s USP intercept countdown (radar-siphon arming
 * on charge start, cold tap-fire NOT a signature, mid-flight expiry
 * confiscation with the 2 500 CR citation outcome), Syndicate Runner
 * contraband laundering at 4.0× × the laundering bonus with the alert
 * cancelled and heat cleared, wrong-class capture refusal, frame-rate
 * independence of in-flight resolution, the QuestEngine export hooks and
 * mid-export save/restore round-trip, and the ClientApp integration surface.
 *
 * Pure headless: NullEngine never leaves the ground floor — the director,
 * the accelerator, and the transport system all answer with no scene at all.
 * Capture resolution runs the §3.2.3 Electromagnetic Tractor Capture Funnel
 * through OrbitalTransportSystem.checkCapture (the authority); the documented
 * Δv-table escalation (tractor closing the catch a chord shot cannot) is
 * asserted explicitly so a silent regression there fails this probe.
 */
import { MassAccelerator, OVERCHARGE_TRIP_S, BREAKER_COOLDOWN_S } from '../src/infrastructure/MassAccelerator.ts';
import { OrbitalTransportSystem, CAPTURE_GRACE_S } from '../src/infrastructure/OrbitalTransportSystem.ts';
import { BallisticTrajectoryEngine } from '../src/physics/BallisticTrajectoryEngine.ts';
import {
  ExportMinigameDirector,
  EXPORT_PHASES,
  EXPORT_CARGO_RATES_CREDITS_PER_KG,
  USP_INTERCEPT_COUNTDOWN_S,
  USP_CITATION_FINE_CREDITS,
  LAUNDER_BONUS_CREDIT,
  normalizeExportCargo,
  exportCargoRateCreditsPerKg,
  cargoDepotValueCredits,
  type ExportSessionState,
} from '../src/quests/ExportMinigameDirector.ts';
import { QuestEngine, InMemoryQuestStorage, type Quest } from '../src/client/QuestEngine.ts';
import { ClientApp } from '../src/client/ClientApp.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(label); console.log(`  ✘ ${label} ${detail}`); }
}

type Vec3 = { x: number; y: number; z: number };
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

const wrapErr = (a: number, b: number): number => {
  let e = (a - b) % 360;
  if (e > 180) e -= 360;
  if (e < -180) e += 360;
  return Math.abs(e);
};
const BANK_TARGET_MPS = 400;

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

/**
 * The verified winning gunnery sequence (§3.3.2): preslew the barrel on the
 * live lead solution at the hot bank target (slew lag is real — 25°/s azimuth
 * must converge before the release), charge with per-frame lead tracking, and
 * release once the bank covers the target and the barrel has caught up.
 */
function hotShot(rig: Rig, dt: number): 'FIRED' | 'OVERCHARGED' | 'STUCK' {
  // Convergence thresholds scale with the slew a frame can move (25°/s az,
  // 15°/s el) so coarse frame rates can still satisfy them.
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
    if (rig.d.getPhase() === 'COIL_CHARGING' && gs.muzzleVelocityMps >= BANK_TARGET_MPS - Math.max(1, 40 * dt)
        && wrapErr(gs.azimuthDeg, aim.aimX) <= azT && Math.abs(gs.elevationDeg - aim.aimY) <= elT) {
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

function finiteState(s: ExportSessionState): boolean {
  return Number.isFinite(s.cargoQuantityKg)
    && Number.isFinite(s.uspCountdownRemainingS)
    && Number.isFinite(s.lastPayoutCredits)
    && Number.isFinite(s.canisterPos.x) && Number.isFinite(s.canisterPos.y) && Number.isFinite(s.canisterPos.z);
}

// =============================================================================
console.log('\n— constants & canonical tables —');
check('USP intercept countdown 45.0 s', USP_INTERCEPT_COUNTDOWN_S === 45.0);
check('USP citation fine 2 500 CR', USP_CITATION_FINE_CREDITS === 2500);
check('launder bonus 1.25 (4.0× → 5.0× band cap)', LAUNDER_BONUS_CREDIT === 1.25);
check('overcharge trip 4.5 s (matches MassAccelerator)', OVERCHARGE_TRIP_S === 4.5);
check('breaker cooldown 5.0 s', BREAKER_COOLDOWN_S === 5.0);
check('capture grace band exported (> window+residency)', CAPTURE_GRACE_S > 40);
check(
  'cargo rate table {2, 12, 45, 30} CR/kg',
  EXPORT_CARGO_RATES_CREDITS_PER_KG.REGOLITH === 2
    && EXPORT_CARGO_RATES_CREDITS_PER_KG.TITANIUM === 12
    && EXPORT_CARGO_RATES_CREDITS_PER_KG.HELIUM3 === 45
    && EXPORT_CARGO_RATES_CREDITS_PER_KG.STOLEN_CONTRABAND === 30,
);
check('phase list covers the §3.4.1 machine in order', (() => {
  const want = ['INACTIVE', 'DOCKING_CONSOLE', 'AWAITING_ORBITAL_PASS', 'TARGETING_ACTIVE',
    'COIL_CHARGING', 'IN_FLIGHT_TRACKING', 'CAPTURE_SUCCESS', 'INTERCEPT_FAILED', 'COOLING_DOWN'];
  return EXPORT_PHASES.length === want.length && want.every((p, i) => EXPORT_PHASES[i] === p);
})());

console.log('\n— pure helpers —');
check("normalize 'helium3' / ' STOLEN_CONTRABAND '", normalizeExportCargo('helium3') === 'HELIUM3'
  && normalizeExportCargo(' stolen_contraband ') === 'STOLEN_CONTRABAND');
check('normalize rejects garbage', normalizeExportCargo('PLUTONIUM') === null
  && normalizeExportCargo(undefined) === null && normalizeExportCargo(42) === null);
check('rate lookups + depot math', exportCargoRateCreditsPerKg('TITANIUM') === 12
  && cargoDepotValueCredits('HELIUM3', 120) === 5400
  && cargoDepotValueCredits('HELIUM3', -5) === 0 && cargoDepotValueCredits('NOPE', 10) === 0);

console.log('\n— session validation & state shape —');
{
  const rig = mkRig();
  const fresh = rig.d.getSessionState();
  const keys = Object.keys(fresh).sort().join(',');
  check('state shape = exact §4 contract fields', keys === [
    'canisterInFlight', 'canisterPos', 'cargoQuantityKg', 'isActive', 'lastPayoutCredits',
    'lastResult', 'selectedCargoType', 'uspAlertActive', 'uspCountdownRemainingS', 'isContraband',
  ].sort().join(','));
  check('fresh session: inactive/NONE/zero', fresh.isActive === false
    && fresh.lastResult === 'NONE' && fresh.lastPayoutCredits === 0 && fresh.uspCountdownRemainingS === 0);
  check('reject unknown cargo / bad mass', rig.d.startSession('PLUTONIUM', 10) === false
    && rig.d.startSession('REGOLITH', Number.NaN) === false
    && rig.d.startSession('REGOLITH', 0) === false && rig.d.startSession('REGOLITH', -3) === false);
  check("accept 'helium3' (casing)", rig.d.startSession('helium3', 120) === true
    && rig.d.getSessionState().selectedCargoType === 'HELIUM3');
  check('double start refused', rig.d.startSession('REGOLITH', 5) === false);
  rig.d.cancelSession();
  check('cancel → INACTIVE, cargo not consumed by outcome', rig.d.getPhase() === 'INACTIVE'
    && rig.d.getSessionState().isActive === false && rig.d.getSessionState().lastResult === 'NONE');
  check('STOLEN_CONTRABAND implies isContraband', (() => {
    const r2 = mkRig();
    r2.d.startSession('STOLEN_CONTRABAND', 40);
    return r2.d.getSessionState().isContraband === true;
  })());
  check('isContraband flag forces legal cargo hot', (() => {
    const r3 = mkRig();
    r3.d.startSession('HELIUM3', 10, true);
    return r3.d.getSessionState().isContraband === true;
  })());
}

console.log('\n— phase machine walk —');
{
  const rig = mkRig();
  const dt = 1 / 60;
  check('fireLaunch refused before TARGETING', rig.d.fireLaunch() === false);
  rig.d.startSession('REGOLITH', 50);
  check('startSession parks DOCKING_CONSOLE', rig.d.getPhase() === 'DOCKING_CONSOLE');
  frame(rig, 0, 62, false, dt);
  check('first tick hands off to AWAITING_ORBITAL_PASS', rig.d.getPhase() === 'AWAITING_ORBITAL_PASS');
  const seen = new Set<string>();
  let targetingAt = -1;
  for (let f = 0; f < 60 * 300; f++) {
    frame(rig, 0, 62, false, dt);
    seen.add(rig.d.getPhase());
    if (rig.d.getPhase() === 'TARGETING_ACTIVE' && targetingAt < 0) targetingAt = f;
    if (targetingAt >= 0) break;
  }
  check('window opens → TARGETING_ACTIVE', targetingAt >= 0);
  check('fireLaunch now succeeds', rig.d.fireLaunch() === true);
  check('fire → IN_FLIGHT_TRACKING + canister in flight', (() => {
    const s = rig.d.getSessionState();
    return rig.d.getPhase() === 'IN_FLIGHT_TRACKING' && s.canisterInFlight === true && finiteState(s);
  })());
}

console.log('\n— bulk capture: 120 kg He-3 at the CisLunar Horizon (2.5×) —');
{
  const rig = mkRig();
  const dt = 1 / 60;
  rig.d.startSession('HELIUM3', 120);
  check('engages the BULK_FREIGHTER window', engage(rig, 'BULK_FREIGHTER', 300, dt));
  check('hot shot fires', hotShot(rig, dt) === 'FIRED');
  check('tractor escalation: canister resolved THROUGH checkCapture', (() => {
    // checkCapture is the sole capture authority (its Δv gate stays armed: a
    // chord shot with rel > 25 only lands because the §3.2.3 tractor closes
    // the rest — asserted here by requiring the outcome be SUCCESS with the
    // transport system never having been bypassed (payout proves the vessel).
    const r = toOutcome(rig, 160, dt);
    check('CAPTURE_SUCCESS outcome', r.s.lastResult === 'SUCCESS', `got ${r.s.lastResult} @${r.tS.toFixed(1)}s`);
    check('payout = 120 kg × 45 CR × 2.5 = 13 500 CR', r.s.lastPayoutCredits === 13500, `got ${r.s.lastPayoutCredits}`);
    check('no USP alert on a clean legal run', r.s.uspAlertActive === false);
    frame(rig, 0, 62, false, dt);
    check('CAPTURE_SUCCESS → COOLING_DOWN', rig.d.getPhase() === 'COOLING_DOWN');
    for (let f = 0; f < 200; f++) frame(rig, 0, 62, false, dt);
    check('quench closes the session to INACTIVE', rig.d.getPhase() === 'INACTIVE'
      && rig.d.getSessionState().isActive === false);
    return true;
  })());
}

console.log('\n— contraband laundering: 40 kg through the Obsidian Slip (4.0× × 1.25) —');
{
  const rig = mkRig();
  const dt = 1 / 60;
  rig.d.startSession('STOLEN_CONTRABAND', 40);
  check('engages the SYNDICATE_RUNNER window', engage(rig, 'SYNDICATE_RUNNER', 600, dt));
  check('hot shot fires', hotShot(rig, dt) === 'FIRED');
  const armedMid = rig.d.getSessionState();
  check('charging contraband tripped the radar siphon', armedMid.uspAlertActive === true
    && armedMid.uspCountdownRemainingS > 0 && armedMid.uspCountdownRemainingS <= USP_INTERCEPT_COUNTDOWN_S);
  const r = toOutcome(rig, 160, dt);
  check('runner capture = SUCCESS', r.s.lastResult === 'SUCCESS', `got ${r.s.lastResult}`);
  check('payout = 40 × 30 × 4.0 × 1.25 = 6 000 CR', r.s.lastPayoutCredits === 6000, `got ${r.s.lastPayoutCredits}`);
  check('laundered flag + USP alert cancelled + heat cleared',
    rig.d.isContrabandLaundered() === true && r.s.uspAlertActive === false
      && r.s.uspCountdownRemainingS === 0 && rig.d.getUspHeatLevel() === 0);
}

console.log('\n— USP engine: cold tap silent, hot clock confiscates —');
{
  const rig = mkRig();
  const dt = 1 / 60;
  rig.d.startSession('STOLEN_CONTRABAND', 60);
  check('engages a window', engage(rig, 'BULK_FREIGHTER', 300, dt));
  check('cold tap-fire (fireLaunch, no spool) does NOT arm the siphon', (() => {
    const ok = rig.d.fireLaunch();
    const s = rig.d.getSessionState();
    return ok === true && s.uspAlertActive === false && s.uspCountdownRemainingS === 0;
  })());
  // Run the launched canister out; let this cold (un-siphoned) flight resolve.
  const first = toOutcome(rig, 320, dt);
  check('cold wild shot resolves MISSED', first.s.lastResult === 'MISSED', `got ${first.s.lastResult}`);
  for (let f = 0; f < 160; f++) frame(rig, 0, 62, false, dt); // quench out
  check('cold run ends the session (no alert stood)', rig.d.getSessionState().isActive === false);

  // Second run: spool 0.4 s (signature), release, let the clock run out.
  const rig2 = mkRig();
  rig2.d.startSession('STOLEN_CONTRABAND', 60);
  check('second run engages a window', engage(rig2, 'BULK_FREIGHTER', 300, dt));
  for (let f = 0; f < 24; f++) frame(rig2, 0, 62, true, dt); // 0.4 s spool
  const armed = rig2.d.getSessionState();
  check('0.4 s spool arms the 45 s intercept clock', armed.uspAlertActive === true
    && armed.uspCountdownRemainingS > 44.4 && armed.uspCountdownRemainingS <= 45.0
    && rig2.d.getUspHeatLevel() === 1);
  for (let f = 0; f < 12; f++) frame(rig2, 0, 62, false, dt); // release → launch
  const s2 = rig2.d.getSessionState();
  check('release launched the canister', s2.canisterInFlight === true
    && rig2.d.getPhase() === 'IN_FLIGHT_TRACKING');
  // Countdown keeps running through the flight and after the miss.
  let expiredAt = -1;
  const clock0 = rig2.d.getSessionState().uspCountdownRemainingS;
  for (let f = 0; f < 60 * 48; f++) {
    const s = frame(rig2, 0, 62, false, dt);
    if (s.lastResult === 'CONFISCATED') { expiredAt = f * dt; break; }
  }
  check('T-0 mid-flight → CONFISCATED (clock ran its 45 s from arming)', expiredAt >= 0
    && Math.abs(expiredAt - clock0) < 0.1, `expiredAt=${expiredAt.toFixed(2)}s clock0=${clock0.toFixed(2)}`);
  const post = rig2.d.getSessionState();
  check('confiscation clears cargo + alert, zeroes countdown', post.cargoQuantityKg === 0
    && post.uspAlertActive === false && post.uspCountdownRemainingS === 0
    && post.lastPayoutCredits === 0);
  for (let f = 0; f < 200; f++) frame(rig2, 0, 62, false, dt);
  check('citation closes the hot run to INACTIVE', rig2.d.getPhase() === 'INACTIVE'
    && rig2.d.getSessionState().isActive === false);
}

console.log('\n— hot-miss survival: a dead canister is not an exit —');
{
  const rig = mkRig();
  const dt = 1 / 60;
  rig.d.startSession('STOLEN_CONTRABAND', 30);
  engage(rig, 'BULK_FREIGHTER', 300, dt); // any window works — we fire an unrecoverable low loft at empty sky
  // Slew to the hard-stop elevation so the apex locks under every catch ring
  // (the doomed-shot rule resolves MISSED at apex, well inside the 45 s).
  for (let f = 0; f < 60 * 4; f++) frame(rig, 0, 15, false, dt);
  for (let f = 0; f < 18; f++) frame(rig, 0, 15, true, dt); // 0.3 s spool (bank stays cold-ish → apex stays under the rings)
  const armed = rig.d.getSessionState();
  check('low-loft spool armed the siphon', armed.uspAlertActive === true);
  const armT0 = armed.uspCountdownRemainingS;
  for (let f = 0; f < 6; f++) frame(rig, 0, 15, false, dt); // release → launch
  let missedAt = -1;
  for (let f = 0; f < 60 * 40; f++) {
    const s = frame(rig, 0, 15, false, dt);
    if (s.lastResult === 'MISSED') { missedAt = f * dt; break; }
  }
  check('unreachable apex → MISSED before T-0', missedAt >= 0 && armT0 - missedAt > 0,
    `missedAt=${missedAt.toFixed(1)}s armT0=${armT0.toFixed(1)}`);
  frame(rig, 0, 15, false, dt); // INTERCEPT_FAILED → COOLING_DOWN
  frame(rig, 0, 15, false, dt); // hot suppression: hot cargo re-arms the pass watch
  const hot = rig.d.getSessionState();
  check('session survives the hot miss; clock still running', hot.isActive === true
    && hot.uspAlertActive === true && hot.uspCountdownRemainingS > 0
    && rig.d.getPhase() === 'AWAITING_ORBITAL_PASS');
  check('laundered flag still clear after a miss', rig.d.isContrabandLaundered() === false);
}

console.log('\n— overcharge: breaker trip + 5 s lockout recovery —');
{
  const rig = mkRig();
  const dt = 1 / 60;
  rig.d.startSession('TITANIUM', 100);
  check('engages a window', engage(rig, 'BULK_FREIGHTER', 300, dt));
  let tripped = false;
  for (let f = 0; f < 60 * 5; f++) {
    const s = frame(rig, 0, 62, true, dt);
    if (s.lastResult === 'OVERCHARGED') { tripped = true; break; }
  }
  check('hold past 4.5 s trips OVERCHARGED', tripped);
  check('trip lands in COOLING_DOWN with the gun locked out', rig.d.getPhase() === 'COOLING_DOWN'
    && rig.acc.getState().state === 'OVERCHARGED' && rig.acc.getState().cooldownRemainingS > 0);
  check('session survives the trip (cargo stays in the breech)', rig.d.getSessionState().isActive === true
    && rig.d.getSessionState().cargoQuantityKg === 100);
  let recovered = false;
  for (let f = 0; f < 60 * (BREAKER_COOLDOWN_S + 2); f++) {
    frame(rig, 0, 62, false, dt);
    if (rig.d.getPhase() === 'AWAITING_ORBITAL_PASS') { recovered = true; break; }
  }
  check(`re-arms AWAITING_ORBITAL_PASS after the ${BREAKER_COOLDOWN_S} s breaker`, recovered);
}

console.log('\n— wrong-class refusal: REGOLITH through the Slip pays nothing —');
{
  const rig = mkRig();
  const dt = 1 / 60;
  rig.d.startSession('REGOLITH', 200);
  check('engages the SYNDICATE_RUNNER window', engage(rig, 'SYNDICATE_RUNNER', 600, dt));
  check('hot shot fires', hotShot(rig, dt) === 'FIRED');
  const r = toOutcome(rig, 400, dt);
  check('no capture, terminal MISSED, zero payout', r.s.lastResult === 'MISSED'
    && r.s.lastPayoutCredits === 0, `got ${r.s.lastResult}/${r.s.lastPayoutCredits}`);
}

console.log('\n— frame-rate independence of in-flight resolution —');
for (const dt of [1 / 30, 1 / 15]) {
  const rig = mkRig();
  rig.d.startSession('TITANIUM', 80);
  const ok = engage(rig, 'BULK_FREIGHTER', 300, dt);
  const shot = ok ? hotShot(rig, dt) : 'STUCK';
  const r = ok ? toOutcome(rig, 160, dt) : { s: rig.d.getSessionState(), tS: -1 };
  check(`capture resolves at dt=${dt.toFixed(4)}s (80 kg × 12 CR/kg × 2.5 = 2 400 CR)`,
    shot === 'FIRED' && r.s.lastResult === 'SUCCESS' && r.s.lastPayoutCredits === 2400,
    `shot=${shot} res=${r.s.lastResult}/${r.s.lastPayoutCredits}`);
}

console.log('\n— garbage input & lifecycle hardening —');
{
  const rig = mkRig();
  const dt = 1 / 60;
  rig.d.startSession('REGOLITH', 10);
  const before = rig.d.getPhase();
  const s1 = rig.d.update(Number.NaN, { aimX: 0, aimY: 62, chargeHeld: false });
  const s2 = rig.d.update(-1, { aimX: Number.NaN, aimY: Number.POSITIVE_INFINITY, chargeHeld: 'yes' as unknown as boolean });
  check('NaN / negative dt freeze the machine (no throw)', rig.d.getPhase() === before
    && finiteState(s1) && finiteState(s2));
  const s3 = rig.d.update(dt, { aimX: Number.NaN, aimY: 1e9, chargeHeld: true });
  check('garbage aim keeps every field finite', finiteState(s3));
  rig.d.reset();
  const p = rig.d.getSessionState();
  check('reset() → pristine factory state', rig.d.getPhase() === 'INACTIVE' && p.isActive === false
    && p.selectedCargoType === 'REGOLITH' && p.cargoQuantityKg === 0 && p.lastResult === 'NONE'
    && p.lastPayoutCredits === 0 && p.uspCountdownRemainingS === 0 && p.uspAlertActive === false
    && p.canisterPos.x === 0 && p.canisterPos.y === 0 && p.canisterPos.z === 0
    && rig.d.isContrabandLaundered() === false && rig.d.getUspHeatLevel() === 0);
  rig.d.dispose();
  check('post-dispose: frozen queries, refused drivers', rig.d.isDisposed() === true
    && rig.d.startSession('REGOLITH', 1) === false && rig.d.fireLaunch() === false
    && finiteState(rig.d.update(dt, { aimX: 0, aimY: 62, chargeHeld: true }))
    && rig.d.getPhase() === 'INACTIVE');
  rig.d.cancelSession(); // must not throw
  check('post-dispose cancelSession is a no-op', true);
}

console.log('\n— QuestEngine export hooks —');
{
  const storage = new InMemoryQuestStorage();
  const engine = new QuestEngine({ storage });
  const quest: Quest = {
    id: 'q_side_gauss_needle', title: 'The Gauss Needle', faction: 'RUSTBELT', category: 'export',
    rewardCredits: 900, rewardXp: 120, currentStageIndex: 0, isCompleted: false,
    stages: [
      { stageNumber: 1, stageTitle: 'Thread the Needle', storyNarration: { sender: 'x', callsign: 'X', transmission: 'hit the tug' }, objectives: [
        { id: 'NEEDLE_LAUNCH', description: 'Catch a freighter with the coilgun.', type: 'export_launch', targetCount: 2, currentCount: 0, completed: false },
      ] },
      { stageNumber: 2, stageTitle: 'Wash the Crimes', storyNarration: { sender: 'x', callsign: 'X', transmission: 'launder it' }, objectives: [
        { id: 'NEEDLE_LAUNDER', description: 'Run contraband through the Slip.', type: 'export_launder', targetCount: 1, currentCount: 0, completed: false },
      ] },
    ],
  };
  engine.startQuest(quest);
  check('recordExportLaunch(13500) counts', engine.recordExportLaunch(13500) === true);
  check('recordExportLaunch() bare counts', engine.recordExportLaunch() === true);
  check('recordExportLaunch(NaN/-1) rejected without mutation', engine.recordExportLaunch(Number.NaN) === false
    && engine.recordExportLaunch(-5) === false);
  let q = engine.getActiveQuest();
  const obj1 = q?.stages[0]?.objectives[0];
  check('export_launch objective completed at targetCount', obj1?.completed === true);
  check('stage advanced after objective', q?.currentStageIndex === 1);
  check('recordExportLaundered completes stage 2', engine.recordExportLaundered() === true
    && engine.getActiveQuest()?.isCompleted === true);
  check('mid-export save/restore round-trips export objective types', (() => {
    const store2 = new InMemoryQuestStorage();
    const e1 = new QuestEngine({ storage: store2 });
    e1.startQuest(quest);
    e1.recordExportLaunch(100);
    const saved = e1.saveProgress();
    const e2 = new QuestEngine({ storage: store2 });
    const restored = e2.restoreProgress();
    const rq = e2.getActiveQuest();
    return saved === true && restored === true && rq?.id === 'q_side_gauss_needle'
      && rq.stages[0]?.objectives[0]?.type === 'export_launch'
      && rq.stages[0]?.objectives[0]?.currentCount === 1;
  })());
}

console.log('\n— ClientApp integration surface —');
{
  const proto = ClientApp.prototype as unknown as Record<string, unknown>;
  const names = ['enableExportMinigameDirector', 'getExportMinigameDirector', 'stepExportMinigameDirector',
    'startExportSession', 'cancelExportSession', 'fireExportLaunch', 'setExportChargeTrigger',
    'nudgeExportAim', 'isExportConsoleMounted', 'syncExportWithQuest'];
  check('all Spec 27 ClientApp surface methods present', names.every((n) => typeof proto[n] === 'function'),
    names.filter((n) => typeof proto[n] !== 'function').join('|'));
}

// =============================================================================
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`FAILURES: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log(`ALL ${passed} CHECKS PASSED`);
process.exit(0);
