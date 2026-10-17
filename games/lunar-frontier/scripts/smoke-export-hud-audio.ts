/**
 * Spec 27 Phase 5 verification probe: Ballistic HUD Reticle, Capacitor
 * Telemetry & Procedural Audio.
 * Run: `npx tsx scripts/smoke-export-hud-audio.ts`  (exit code 0 == all green)
 *
 * Covers Spec 27 §3.5 end to end, headless (fake DOM + mock Web Audio):
 *
 *  A.   `LunarHUD` gunner fire-control suite (`#lunar-hud-gunner`): DOM
 *        construction, hidden start, radar slot count, canonical constants.
 *  B.   Visibility law: null retracts, live frames reveal, the public
 *        `hideExportGunnerOverlay()` + telemetry mirror.
 *  C.   Ballistic crosshair (0.1° AZ/EL readouts, reticle slide) and the
 *        dynamic Lead Reticle ("Ghost Target"): ±1.5° inclusive lock snap on
 *        BOTH axes, wrap-around delta, NaN degradation, status lines.
 *  D.   Capacitor charge bar: 180..420 m/s mapping, clamps, green optimal
 *        bracket geometry, `.is-optimal`, integer charge mirror.
 *  E.   Orbital sky-track radar: hemisphere projection (azimuth around the
 *        rim, elevation inward), ◀/▲/▶ phase glyphs, class classes, slot
 *        overflow, clear law.
 *  F.   USP heat banner: amber (hot cargo) vs crimson blink (<15 s), strict
 *        T-15.0 boundary, clamp, retraction class wash.
 *  G–H. `LunarAudioSystem` voices: capacitor spool whine (80→880 Hz sweep,
 *        sub-octave twin, 13 Hz AM jitter, gain law, gate) and the USP
 *        klaxon (440 ↔ 587 Hz = 513.5 ± 73.5 saw + 1.25 Hz square LFO,
 *        zero wall-clock timers, pre-init arming).
 *  I.   Lorentz discharge blast / vacuum whistle / capture chime one-shots:
 *        canonical frequency constants, cue timestamping, autoplay safety.
 *  J.   Clean disposal: every owned voice stopped, flags cleared, no
 *        post-dispose throws on HUD or audio surfaces.
 *  K.   Integration: a REAL `MassAccelerator` + `OrbitalTransportSystem` +
 *        `ExportMinigameDirector` drive the HUD + audio exactly the way
 *        `ClientApp.stepExportMinigameDirector` does (state-driven, per
 *        frame): dock → targeting → charge → fire → resolve → contraband
 *        siphon → klaxon → cancel.
 */
import {
  LunarHUD,
  HUD_GUNNER_ID,
  HUD_GUNNER_LOCK_TOL_DEG,
  HUD_GUNNER_RADAR_SLOTS,
  HUD_CAP_MIN_MPS,
  HUD_CAP_MAX_MPS,
  HUD_EXPORT_USP_FULL_S,
  HUD_EXPORT_USP_CRITICAL_S,
  type HudExportGunnerTelemetry,
  type HudRadarContact,
} from '../src/ui/LunarHUD.ts';
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
import { BallisticTrajectoryEngine } from '../src/physics/BallisticTrajectoryEngine.ts';
import { MassAccelerator } from '../src/infrastructure/MassAccelerator.ts';
import { OrbitalTransportSystem } from '../src/infrastructure/OrbitalTransportSystem.ts';
import { ExportMinigameDirector } from '../src/quests/ExportMinigameDirector.ts';

// ---------------------------------------------------------------------------
// Fake DOM (structural subset the HUD uses; same pattern as smoke-heist-hud-audio)
// ---------------------------------------------------------------------------

interface FakeElement {
  id: string;
  className: string;
  textContent: string | null;
  style: Record<string, string>;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  };
  children: FakeElement[];
  parent: FakeElement | null;
  attributes: Map<string, string>;
  appendChild<T>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
}

function makeFakeElement(tag: string, registry: Map<string, FakeElement>): FakeElement {
  const attributes = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    id: '',
    className: '',
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
const hFrame = () => 1 / 60;

/** Synthetic gunner frame builder (contract shape of §3.5.1). */
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

// ---------------------------------------------------------------------------
const doc = makeFakeDocument();
const hud = new LunarHUD({ document: doc as unknown as Document });
const txt = (key: string): string => hud.textOf(key);
const has = (key: string, cls: string): boolean => hud.hasClass(key, cls);
const attr = (key: string, name: string): string | null =>
  hud.getElement(key)?.getAttribute(name) ?? null;
const height = (key: string): string => hud.getElement(key)?.style['height'] ?? '';
const leftOf = (key: string): string => hud.getElement(key)?.style['left'] ?? '';
const topOf = (key: string): string => hud.getElement(key)?.style['top'] ?? '';

// ---------------------------------------------------------------------------
section('A. gunner overlay DOM construction');

check('HUD_GUNNER_ID is #lunar-hud-gunner', HUD_GUNNER_ID === 'lunar-hud-gunner');
check('gunner-panel exists in the logical element map', hud.getElement('gunner-panel') !== undefined);
check('panel carries the gunner-overlay class', has('gunner-panel', 'gunner-overlay'));
check('panel starts hidden (is-hidden)', has('gunner-panel', 'is-hidden'));
check('panel data-phase starts INACTIVE', attr('gunner-panel', 'data-phase') === 'INACTIVE');
check('panel data-lock starts 0', attr('gunner-panel', 'data-lock') === '0');
check(
  'document registry has the suite + widget ids',
  doc.getElementById(HUD_GUNNER_ID) !== null &&
    doc.getElementById('lunar-hud-gunner-usp') !== null &&
    doc.getElementById('lunar-hud-gunner-sight') !== null &&
    doc.getElementById('lunar-hud-gunner-crosshair') !== null &&
    doc.getElementById('lunar-hud-gunner-lead') !== null &&
    doc.getElementById('lunar-hud-gunner-radar') !== null &&
    doc.getElementById('lunar-hud-gunner-capacitor') !== null,
);
check(
  `registry has all ${HUD_GUNNER_RADAR_SLOTS} radar pips`,
  (() => {
    for (let i = 0; i < HUD_GUNNER_RADAR_SLOTS; i++)
      if (doc.getElementById(`lunar-hud-gunner-pip-${i}`) === null) return false;
    return true;
  })(),
);
check('lead diamond starts hidden', has('gunner-lead', 'is-hidden'));
check('USP banner starts hidden', has('gunner-usp', 'is-hidden'));
check('capacitor fill starts at 0%', height('gunner-cap-fill') === '0%');
check('bracket starts hidden', has('gunner-cap-bracket', 'is-hidden'));
check(
  'constants mirror Spec 27 §3.5 (±1.5° lock, 180–420 m/s, 45/15 s USP)',
  HUD_GUNNER_LOCK_TOL_DEG === 1.5 &&
    HUD_CAP_MIN_MPS === 180 &&
    HUD_CAP_MAX_MPS === 420 &&
    HUD_EXPORT_USP_FULL_S === 45.0 &&
    HUD_EXPORT_USP_CRITICAL_S === 15.0,
);

// ---------------------------------------------------------------------------
section('B. visibility law + telemetry mirror');

hud.renderExportGunnerOverlay(null);
check('null telemetry keeps the suite retracted', has('gunner-panel', 'is-hidden'));
hud.renderExportGunnerOverlay(gun());
check('live frame reveals the suite', !has('gunner-panel', 'is-hidden'));
check('data-phase follows the phase machine', attr('gunner-panel', 'data-phase') === 'TARGETING_ACTIVE');
const mirror = hud.getExportGunnerTelemetry();
check('telemetry mirror returns the last painted frame', mirror !== null && mirror.phase === 'TARGETING_ACTIVE');
hud.hideExportGunnerOverlay();
check('hideExportGunnerOverlay() retracts the live suite', has('gunner-panel', 'is-hidden'));
check('hide clears the telemetry mirror', hud.getExportGunnerTelemetry() === null);

// ---------------------------------------------------------------------------
section('C. ballistic crosshair + Ghost Target lock law');

hud.renderExportGunnerOverlay(
  gun({ azimuthDeg: 214.0, elevationDeg: 62.5, muzzleVelocityMps: 240 }),
);
check('azimuth reads 0.1° (AZ 214.0°)', txt('gunner-az-value') === 'AZ 214.0°', `got "${txt('gunner-az-value')}"`);
check('elevation reads 0.1° (EL 62.5°)', txt('gunner-el-value') === 'EL 62.5°', `got "${txt('gunner-el-value')}"`);
check('crosshair slides with the barrel (left 59.44%)', leftOf('gunner-crosshair') === '59.44%',
  `got "${leftOf('gunner-crosshair')}"`);
check('crosshair vertical slide (top 15.28%)', topOf('gunner-crosshair') === '15.28%',
  `got "${topOf('gunner-crosshair')}"`);
check('panel mirrors data-az / data-el', attr('gunner-panel', 'data-az') === '214.0' && attr('gunner-panel', 'data-el') === '62.5');

hud.renderExportGunnerOverlay(
  gun({
    azimuthDeg: 214.0,
    elevationDeg: 62.5,
    leadAzimuthDeg: 215.4,
    leadElevationDeg: 63.9,
    solutionAvailable: true,
  }),
);
check('lead pip inside ±1.5° on BOTH axes → .is-locked', has('gunner-lead', 'is-locked'));
check('locked frame: panel data-lock=1', attr('gunner-panel', 'data-lock') === '1');
check('locked frame: ON TARGET status', txt('gunner-lock-status') === 'LEAD LOCK // ON TARGET');
check('lead readout toFixed(1)', txt('gunner-lead-value') === 'LEAD 215.4° / 63.9°',
  `got "${txt('gunner-lead-value')}"`);
check('az delta mirror (1.40)', attr('gunner-panel', 'data-lock-az-delta') === '1.40',
  `got "${attr('gunner-panel', 'data-lock-az-delta')}"`);
check('el delta mirror (1.40)', attr('gunner-panel', 'data-lock-el-delta') === '1.40');

hud.renderExportGunnerOverlay(
  gun({ azimuthDeg: 214.0, elevationDeg: 62.5, leadAzimuthDeg: 215.5, leadElevationDeg: 62.5, solutionAvailable: true }),
);
check('exactly +1.5° azimuth is INCLUSIVE (locked)', has('gunner-lead', 'is-locked'));
hud.renderExportGunnerOverlay(
  gun({ azimuthDeg: 214.0, elevationDeg: 62.5, leadAzimuthDeg: 215.6, leadElevationDeg: 62.5, solutionAvailable: true }),
);
check('+1.6° azimuth breaks the lock', !has('gunner-lead', 'is-locked'));
check('unlocked frame: SLEW status', txt('gunner-lock-status') === 'SLEW TO LEAD PIP');
check('unlocked frame: panel data-lock=0', attr('gunner-panel', 'data-lock') === '0');
hud.renderExportGunnerOverlay(
  gun({ azimuthDeg: 214.0, elevationDeg: 62.5, leadAzimuthDeg: 214.0, leadElevationDeg: 64.5, solutionAvailable: true }),
);
check('elevation-only miss (+2.0°) breaks the lock', !has('gunner-lead', 'is-locked'));

hud.renderExportGunnerOverlay(
  gun({ azimuthDeg: 0.2, elevationDeg: 62.5, leadAzimuthDeg: 359.4, leadElevationDeg: 62.5, solutionAvailable: true }),
);
check('wrap-around lead (0.2° vs 359.4° → 0.8°) locks', has('gunner-lead', 'is-locked'));

hud.renderExportGunnerOverlay(gun({ azimuthDeg: 214.0, elevationDeg: 62.5 }));
check('no solution: lead widget hidden', has('gunner-lead', 'is-hidden'));
check('no solution: NO FIRING SOLUTION status', txt('gunner-lock-status') === 'NO FIRING SOLUTION');
check('no solution: data-lead-az is emptied', attr('gunner-panel', 'data-lead-az') === '');

hud.renderExportGunnerOverlay(
  gun({ azimuthDeg: 214.0, elevationDeg: 62.5, leadAzimuthDeg: Number.NaN, leadElevationDeg: Number.NaN, solutionAvailable: true }),
);
check('NaN lead degrades to no-pip, never throws', has('gunner-lead', 'is-hidden'));
hud.renderExportGunnerOverlay(gun({ azimuthDeg: Number.NaN, elevationDeg: Number.NaN }));
check('NaN angles degrade to AZ 0.0° / EL 0.0° (no NaN text)',
  txt('gunner-az-value') === 'AZ 0.0°' && txt('gunner-el-value') === 'EL 0.0°');
check('NaN azimuth wraps through wrap360 (data-az 0.0)', attr('gunner-panel', 'data-az') === '0.0');

// Target strip.
hud.renderExportGunnerOverlay(
  gun({ targetName: 'kestrel hauler', targetClass: 'SYNDICATE_RUNNER', targetRangeM: 2400, timeToTargetS: 12.34 }),
);
check('target strip: name·class·range·T+',
  txt('gunner-target-value') === 'KESTREL HAULER · SYNDICATE RUNNER · 2,400 m · T+12.3s',
  `got "${txt('gunner-target-value')}"`);
hud.renderExportGunnerOverlay(gun());
check('empty sky: strip reads SKY EMPTY', txt('gunner-target-value') === 'SKY EMPTY — NO ACTIVE FREIGHTER');

// ---------------------------------------------------------------------------
section('D. capacitor charge bar (180..420 m/s + optimal bracket)');

const capCases: Array<[number, string]> = [
  [HUD_CAP_MIN_MPS, '0.0%'],
  [300, '50.0%'],
  [HUD_CAP_MAX_MPS, '100.0%'],
  [100, '0.0%'],   // clamped up
  [500, '100.0%'], // clamped down
];
for (const [v, want] of capCases) {
  hud.renderExportGunnerOverlay(gun({ muzzleVelocityMps: v }));
  check(`v=${v} m/s → fill ${want}`, height('gunner-cap-fill') === want, `got "${height('gunner-cap-fill')}"`);
}
hud.renderExportGunnerOverlay(gun({ muzzleVelocityMps: 300, capacitorChargeRatio: 0.65 }));
check('velocity readout num(…,1) → 300.0 m/s', txt('gunner-velocity-value') === '300.0 m/s',
  `got "${txt('gunner-velocity-value')}"`);
check('charge readout is INTEGER percent (65%)', txt('gunner-charge-value') === '65%',
  `got "${txt('gunner-charge-value')}"`);
check('fill mirrors data-mps toFixed(2)', attr('gunner-cap-fill', 'data-mps') === '300.00');
check('panel mirrors data-velocity-mps / data-charge-ratio',
  attr('gunner-panel', 'data-velocity-mps') === '300.00' && attr('gunner-panel', 'data-charge-ratio') === '0.650');

hud.renderExportGunnerOverlay(gun({ muzzleVelocityMps: 300, optimalMinMps: 0, optimalMaxMps: 0 }));
check('degenerate bracket (min>=max) hides the overlay bracket', has('gunner-cap-bracket', 'is-hidden'));
check('bracket inactive: no is-optimal', !has('gunner-cap-fill', 'is-optimal'));
hud.renderExportGunnerOverlay(gun({ muzzleVelocityMps: 375, optimalMinMps: 360, optimalMaxMps: 390 }));
check('bracket 360..390 revealed', !has('gunner-cap-bracket', 'is-hidden'));
check('bracket top edge = (420−optMax)/240 → 12.5%', height('gunner-cap-bracket') === '12.5%' && topOf('gunner-cap-bracket') === '12.5%',
  `got top "${topOf('gunner-cap-bracket')}" h "${height('gunner-cap-bracket')}"`);
check('bracket mirrors data-optimal-min/max', attr('gunner-cap-bracket', 'data-optimal-min') === '360' &&
  attr('gunner-cap-bracket', 'data-optimal-max') === '390');
check('v=375 inside 360..390 → .is-optimal', has('gunner-cap-fill', 'is-optimal'));
hud.renderExportGunnerOverlay(gun({ muzzleVelocityMps: 300, optimalMinMps: 360, optimalMaxMps: 390 }));
check('v=300 below the bracket → no .is-optimal', !has('gunner-cap-fill', 'is-optimal'));

// ---------------------------------------------------------------------------
section('E. orbital sky-track radar (hemisphere projection)');

const radarContacts: HudRadarContact[] = [
  { id: 'c1', label: 'Kestrel Hauler', transportClass: 'SYNDICATE_RUNNER', phase: 'approaching', azimuthDeg: 120, elevationDeg: 30, rangeM: 2400 },
  { id: 'c2', label: 'CisLuna Horizon', transportClass: 'BULK_FREIGHTER', phase: 'overhead', azimuthDeg: 0, elevationDeg: 90, rangeM: 1500 },
  { id: 'c3', label: 'USP Sirocco', transportClass: 'USP_PATROL', phase: 'departing', azimuthDeg: 270, elevationDeg: 0, rangeM: 3200 },
];
hud.renderExportGunnerOverlay(gun({ contacts: radarContacts }));
const pip0 = hud.getElement('gunner-radar-pip-0');
check('pip 0 visible with approaching glyph ◀', pip0 !== undefined && !pip0.classList.contains('is-hidden') && (pip0.textContent ?? '').startsWith('◀'),
  `got "${pip0?.textContent ?? ''}"`);
check('pip 0 label uppercased + range', (pip0?.textContent ?? '') === '◀ KESTREL HAULER · 2,400 m',
  `got "${pip0?.textContent ?? ''}"`);
check('pip 0 hemisphere position (az 120 el 30 → 78.87/66.67)',
  pip0?.style['left'] === '78.87%' && pip0?.style['top'] === '66.67%',
  `got "${pip0?.style['left']}/${pip0?.style['top']}"`);
check('pip 0 class colours by vessel class', pip0 !== undefined && pip0.classList.contains('contact-syndicate_runner'));
const pip1 = hud.getElement('gunner-radar-pip-1');
check('pip 1 zenith projects to dome centre (50/50) with ▲',
  pip1?.style['left'] === '50.00%' && pip1?.style['top'] === '50.00%' && (pip1.textContent ?? '').startsWith('▲'),
  `got "${pip1?.style['left']}/${pip1?.style['top']} ${pip1?.textContent ?? ''}"`);
const pip2 = hud.getElement('gunner-radar-pip-2');
check('pip 2 horizon az 270 → rim left (0.00/50.00) with ▶',
  pip2?.style['left'] === '0.00%' && pip2?.style['top'] === '50.00%' && (pip2.textContent ?? '').startsWith('▶'),
  `got "${pip2?.style['left']}/${pip2?.style['top']} ${pip2?.textContent ?? ''}"`);
check('pip 2 carries usp_patrol class', pip2 !== undefined && pip2.classList.contains('contact-usp_patrol'));
check('readout counts 3 contacts', txt('gunner-radar-readout') === 'SKY-TRACK: 3 contacts',
  `got "${txt('gunner-radar-readout')}"`);
check('pip mirrors data-contact-id/phase', attr('gunner-radar-pip-2', 'data-contact-id') === 'c3' &&
  attr('gunner-radar-pip-2', 'data-contact-phase') === 'departing');

hud.renderExportGunnerOverlay(gun({ contacts: radarContacts.concat(radarContacts, radarContacts[0] ? [radarContacts[0]] : []) }));
check('7 contacts fill all 6 slots, extras drop silently',
  hud.getElement(`gunner-radar-pip-${HUD_GUNNER_RADAR_SLOTS - 1}`) !== undefined &&
    txt('gunner-radar-readout') === 'SKY-TRACK: 7 contacts');

hud.renderExportGunnerOverlay(gun({ contacts: [] }));
check('empty contacts hide every pip and read clear', (() => {
  for (let i = 0; i < HUD_GUNNER_RADAR_SLOTS; i++)
    if (!has(`gunner-radar-pip-${i}`, 'is-hidden')) return false;
  return txt('gunner-radar-readout') === 'SKY-TRACK: clear';
})());

// In-flight chip.
hud.renderExportGunnerOverlay(gun({ canisterInFlight: true }));
check('in-flight chip shows on canisterInFlight', !has('gunner-inflight-chip', 'is-hidden'));
hud.renderExportGunnerOverlay(gun({ canisterInFlight: false }));
check('in-flight chip hides when the arc resolves', has('gunner-inflight-chip', 'is-hidden'));

// ---------------------------------------------------------------------------
section('F. USP heat / detection banner');

hud.renderExportGunnerOverlay(gun());
check('clean cargo: banner retracted', has('gunner-usp', 'is-hidden'));
hud.renderExportGunnerOverlay(gun({ contraband: true }));
check('hot cargo (no countdown yet): banner shows', !has('gunner-usp', 'is-hidden'));
check('hot cargo: amber is-hot, not crimson', has('gunner-usp', 'is-hot') && !has('gunner-usp', 'is-critical'));
check('hot cargo text is the siphon line', txt('gunner-usp-value') === 'CARGO HOT — SIPHON ARMED ON CHARGE',
  `got "${txt('gunner-usp-value')}"`);
hud.renderExportGunnerOverlay(gun({ contraband: true, uspAlertActive: true, uspCountdownRemainingS: 20 }));
check('intercept T-20.0 readout', txt('gunner-usp-value') === 'USP INTERCEPT T-20.0s',
  `got "${txt('gunner-usp-value')}"`);
check('T-20 stays amber (is-hot)', has('gunner-usp', 'is-hot') && !has('gunner-usp', 'is-critical'));
hud.renderExportGunnerOverlay(gun({ contraband: true, uspAlertActive: true, uspCountdownRemainingS: 15.0 }));
check('exactly T-15.0 is NOT critical (strict <)', !has('gunner-usp', 'is-critical'));
hud.renderExportGunnerOverlay(gun({ contraband: true, uspAlertActive: true, uspCountdownRemainingS: 14.9 }));
check('T-14.9 crosses into crimson blink (is-critical, no is-hot)',
  has('gunner-usp', 'is-critical') && !has('gunner-usp', 'is-hot'));
hud.renderExportGunnerOverlay(gun({ contraband: true, uspAlertActive: true, uspCountdownRemainingS: 99 }));
check('out-of-range clock clamps to T-45.0s', txt('gunner-usp-value') === 'USP INTERCEPT T-45.0s',
  `got "${txt('gunner-usp-value')}"`);
check('countdown mirror data-usp-countdown-s', attr('gunner-panel', 'data-usp-countdown-s') === '45.0');
hud.renderExportGunnerOverlay(gun());
check('retraction washes both alert classes', has('gunner-usp', 'is-hidden') && !has('gunner-usp', 'is-critical') && !has('gunner-usp', 'is-hot'));
check('retraction empties the countdown mirror', attr('gunner-panel', 'data-usp-countdown-s') === '');

// ---------------------------------------------------------------------------
section('G. capacitor spool whine (80 → 880 Hz dual-osc sweep)');

check('canonical band is 80 / 880 Hz', CAPACITOR_WHINE_FLOOR_HZ === 80 && CAPACITOR_WHINE_CEILING_HZ === 880);
const audio = new LunarAudioSystem();
check('whine is cold at rest', audio.isCapacitorWhineActive() === false);
audio.setCapacitorSpoolWhine(0.5);
check('pre-init ratio is remembered (mid-band 480 Hz)', approx(audio.getCapacitorWhineFrequencyHz(), 480),
  `got ${audio.getCapacitorWhineFrequencyHz()}`);
void audio.init(); // async fn, sync body — graph is built on this line
check('audio engine initialized headless (mock context)', audio.isInitialized() && audio.isHeadless());
check('graph built the carrier at the remembered 480 Hz', approx(audio.getCapacitorWhineFrequencyHz(), 480));

const internals = audio as unknown as {
  ownedVoices: { stop(): unknown; type?: string; frequency?: { value: number }; stopped?: boolean }[];
  capWhineGain: { gain: { value: number } } | null;
  capWhineSubOsc: { frequency: { value: number } } | null;
  uspKlaxonGain: { gain: { value: number } } | null;
  uspKlaxonOsc: { type: string; frequency: { value: number } } | null;
};
check('sub-octave twin sits at freq/2 (240 Hz)',
  internals.capWhineSubOsc !== null && approx(internals.capWhineSubOsc.frequency.value, 240),
  `got ${internals.capWhineSubOsc?.frequency.value}`);
check('13 Hz AM jitter LFO exists in the owned voices',
  internals.ownedVoices.some((v) => v.type === 'sine' && v.frequency !== undefined && approx(v.frequency.value, 13)));
check('whine gain node rides 0.12 × sfx(0.9) × drive(1) = 0.108',
  internals.capWhineGain !== null && approx(internals.capWhineGain.gain.value, 0.12 * 0.9, 1e-9),
  `got ${internals.capWhineGain?.gain.value}`);

audio.setCapacitorSpoolWhine(0);
check('cold bank: carrier parks at the 80 Hz floor', approx(audio.getCapacitorWhineFrequencyHz(), CAPACITOR_WHINE_FLOOR_HZ));
check('cold bank: drive gate is 0 and voice reports inactive',
  audio.getCapacitorWhineLevel() === 0 && audio.isCapacitorWhineActive() === false);
check('cold bank: gain node closed', internals.capWhineGain !== null && internals.capWhineGain.gain.value === 0);
audio.setCapacitorSpoolWhine(1);
check('full charge pegs the 880 Hz ceiling', approx(audio.getCapacitorWhineFrequencyHz(), CAPACITOR_WHINE_CEILING_HZ));
check('full charge drive envelope = 1.0', approx(audio.getCapacitorWhineLevel(), 1));
audio.setCapacitorSpoolWhine(7);
check('over-range ratio clamps to the ceiling', approx(audio.getCapacitorWhineFrequencyHz(), CAPACITOR_WHINE_CEILING_HZ));
audio.setCapacitorSpoolWhine(Number.NaN);
check('NaN ratio clamps to 0 (floor, silent)',
  approx(audio.getCapacitorWhineFrequencyHz(), CAPACITOR_WHINE_FLOOR_HZ) && audio.getCapacitorWhineLevel() === 0);
audio.setCapacitorSpoolWhine(0.25);
audio.setCapacitorSpoolWhine(0.25);
check('re-setting the same ratio is idempotent', approx(audio.getCapacitorWhineFrequencyHz(), 280));

// ---------------------------------------------------------------------------
section('H. USP klaxon (440 ↔ 587 Hz via square LFO, zero timers)');

check('klaxon starts silent', audio.isUspKlaxonAlertActive() === false);
const tones = audio.getUspKlaxonTones();
check('canonical tone pair 440 / 587 Hz', tones.lowHz === USP_KLAXON_LOW_HZ && tones.highHz === USP_KLAXON_HIGH_HZ);
check('513.5 Hz carrier ± 73.5 Hz swing reproduces the pair',
  tones.baseHz === 513.5 && tones.swingHz === 73.5 &&
    tones.baseHz - tones.swingHz === USP_KLAXON_LOW_HZ && tones.baseHz + tones.swingHz === USP_KLAXON_HIGH_HZ);
check('1.25 Hz alternation ⇒ 0.4 s per tone (spec cadence)',
  approx(tones.alternationHz, 1.25) && approx(1 / (2 * tones.alternationHz), 0.4));
audio.setUspKlaxonAlert(true);
check('armed klaxon reports active', audio.isUspKlaxonAlertActive() === true);
check('klaxon gain opens to 0.17 × sfx(0.9) = 0.153',
  internals.uspKlaxonGain !== null && approx(internals.uspKlaxonGain.gain.value, 0.17 * 0.9, 1e-9),
  `got ${internals.uspKlaxonGain?.gain.value}`);
audio.setUspKlaxonAlert(true);
check('re-arming is idempotent', audio.isUspKlaxonAlertActive() === true);
check('carrier oscillator is a 513.5 Hz sawtooth',
  internals.uspKlaxonOsc !== null && internals.uspKlaxonOsc.type === 'sawtooth' && approx(internals.uspKlaxonOsc.frequency.value, 513.5));
check('square alternation LFO @ 1.25 Hz exists in the owned voices',
  internals.ownedVoices.some((v) => v.type === 'square' && v.frequency !== undefined && approx(v.frequency.value, 1.25)));
audio.setUspKlaxonAlert(false);
check('disarm silences the siren',
  audio.isUspKlaxonAlertActive() === false && internals.uspKlaxonGain !== null && internals.uspKlaxonGain.gain.value === 0);

// Pre-init arming edge (buildGraph starts the gain at 0 — init() re-applies).
const early = new LunarAudioSystem();
early.setUspKlaxonAlert(true);
early.setCapacitorSpoolWhine(0.75);
check('pre-init arm reports active', early.isUspKlaxonAlertActive() === true);
void early.init();
const earlyKlaxon = (early as unknown as { uspKlaxonGain: { gain: { value: number } } | null }).uspKlaxonGain;
const earlyWhine = (early as unknown as { capWhineOsc: { frequency: { value: number } } | null }).capWhineOsc;
check('init() opens a pre-armed USP klaxon gain', earlyKlaxon !== null && earlyKlaxon.gain.value > 0);
check('init() builds the whine at the pre-init ratio (680 Hz)',
  earlyWhine !== null && approx(earlyWhine.frequency.value, 680), `got ${earlyWhine?.frequency.value}`);
early.dispose();

// ---------------------------------------------------------------------------
section('I. Lorentz blast / vacuum whistle / capture chime');

check('Lorentz constants: 45 Hz sub drop, 2 400 Hz snap, 320 Hz ring',
  LORENTZ_SUBBASS_HZ === 45 && LORENTZ_SNAP_HZ === 2400 && LORENTZ_RING_HZ === 320);
check('whistle Doppler band edges 4 200 → 1 500 Hz', VACUUM_WHISTLE_HIGH_HZ === 4200 && VACUUM_WHISTLE_LOW_HZ === 1500);
check('capture chime is the ascending major 523 → 659 Hz', CAPTURE_CHIME_LOW_HZ === 523 && CAPTURE_CHIME_HIGH_HZ === 659);

const cues0 = audio.getLastExportCueTimes();
check('no export cues before the first', cues0.dischargeAt === Number.NEGATIVE_INFINITY &&
  cues0.whistleAt === Number.NEGATIVE_INFINITY && cues0.chimeAt === Number.NEGATIVE_INFINITY);
audio.playLorentzDischargeBlast();
const cues1 = audio.getLastExportCueTimes();
check('discharge blast stamps a finite context time', Number.isFinite(cues1.dischargeAt));
audio.playCanisterVacuumWhistle();
audio.playMagneticCaptureChime();
const cues2 = audio.getLastExportCueTimes();
check('whistle + chime stamp their own cue times',
  Number.isFinite(cues2.whistleAt) && Number.isFinite(cues2.chimeAt) && cues2.chimeAt > cues1.dischargeAt);

// Autoplay / pre-init safety: every new surface is callable on a bare system.
const bare = new LunarAudioSystem();
let bareThrow = false;
try {
  bare.setCapacitorSpoolWhine(0.6);
  bare.setUspKlaxonAlert(true);
  bare.playLorentzDischargeBlast();
  bare.playCanisterVacuumWhistle();
  bare.playMagneticCaptureChime();
} catch {
  bareThrow = true;
}
check('pre-init calls never throw (autoplay-safe)', bareThrow === false);
check('pre-init one-shots record nothing',
  bare.getLastExportCueTimes().dischargeAt === Number.NEGATIVE_INFINITY &&
    bare.getLastExportCueTimes().chimeAt === Number.NEGATIVE_INFINITY);
bare.dispose();

// ---------------------------------------------------------------------------
section('J. clean disposal — no leaked voices, no post-dispose throws');

check('engine owns a full persistent voice pool', internals.ownedVoices.length >= 16,
  `pool=${internals.ownedVoices.length}`);
const wrapped = internals.ownedVoices.slice();
for (const v of wrapped) {
  const orig = v.stop.bind(v);
  v.stopped = false;
  v.stop = () => {
    v.stopped = true;
    return orig();
  };
}
audio.dispose();
check('dispose() stopped EVERY owned voice (whine + USP klaxon included)',
  wrapped.every((v) => v.stopped === true));
check('owned-voice pool drained to zero', internals.ownedVoices.length === 0);
check('USP klaxon disarms itself on teardown', audio.isUspKlaxonAlertActive() === false);
check('capacitor whine gates out on teardown', audio.isCapacitorWhineActive() === false);
check('cue timestamps reset on teardown', (() => {
  const c = audio.getLastExportCueTimes();
  return c.dischargeAt === Number.NEGATIVE_INFINITY && c.whistleAt === Number.NEGATIVE_INFINITY && c.chimeAt === Number.NEGATIVE_INFINITY;
})());
check('isDisposed flag flips', audio.isDisposed() === true);
let audioThrow = false;
try {
  audio.setCapacitorSpoolWhine(0.5);
  audio.setUspKlaxonAlert(true);
  audio.playLorentzDischargeBlast();
  audio.playCanisterVacuumWhistle();
  audio.playMagneticCaptureChime();
  void audio.getCapacitorWhineFrequencyHz();
  void audio.getCapacitorWhineLevel();
  void audio.getUspKlaxonTones();
  void audio.init();
} catch {
  audioThrow = true;
}
check('post-dispose audio surface never throws', audioThrow === false);
check('post-dispose whine readback stays finite', Number.isFinite(audio.getCapacitorWhineFrequencyHz()));

// HUD teardown (registry keys by setAttribute('id'), not tree membership).
check('HUD is mounted in the fake body before dispose', doc.getElementById(HUD_GUNNER_ID) !== null);
const mountsBefore = doc.body.children.length;
hud.dispose();
check('HUD dispose flips isDisposed', hud.isDisposed() === true);
check('HUD root (with the gunner suite) detached from the body',
  mountsBefore > 0 && doc.body.children.length === 0 && doc.getElementById('lunar-hud') === null);
check('gunner panel keys are unreachable after dispose', hud.getElement('gunner-panel') === undefined);
let hudThrow = false;
try {
  hud.renderExportGunnerOverlay(gun());
  hud.hideExportGunnerOverlay();
  void hud.getExportGunnerTelemetry();
  hud.dispose();
} catch {
  hudThrow = true;
}
check('post-dispose HUD calls never throw (double-dispose safe)', hudThrow === false);
check('post-dispose gunner mirror stays cleared', hud.getExportGunnerTelemetry() === null);

// ---------------------------------------------------------------------------
section('K. integration: real subsystems → HUD + audio (ClientApp law)');

// Headless-safe by construction (no scenes): the EXACT trio ClientApp wires
// in enableExportMinigameDirector, driven by the same state law it uses in
// stepExportMinigameDirector / syncExportGunnerHud / syncExportGunnerAudio.
const accel = new MassAccelerator();
const ots = new OrbitalTransportSystem({ seed: 'gauss-needle-probe' });
const director = new ExportMinigameDirector(accel, ots);
const hud3 = new LunarHUD({ document: makeFakeDocument() as unknown as Document });
const audio3 = new LunarAudioSystem();
void audio3.init();
const txt3 = (key: string): string => hud3.textOf(key);
const has3 = (key: string, cls: string): boolean => hud3.hasClass(key, cls);
const attr3 = (key: string, name: string): string | null =>
  hud3.getElement(key)?.getAttribute(name) ?? null;

let aim = { azimuth: 90, elevation: 62 };
let fireWas = false;
let chimeResultWas = 'NONE';

/** Mirror of ClientApp.buildExportGunnerTelemetry (same math, same sources). */
function buildTele(state: ReturnType<ExportMinigameDirector['getSessionState']>): HudExportGunnerTelemetry {
  const muzzle = accel.getMuzzleWorldPosition();
  const gantry = accel.getState();
  const contacts: HudRadarContact[] = [];
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
    const radial = range > 1e-9
      ? (active.velocity.x * dx + active.velocity.y * dy + active.velocity.z * dz) / range
      : 0;
    const phaseBucket = el > 75 ? 'overhead' : radial < 0 ? 'approaching' : 'departing';
    targetName = active.name;
    targetClass = active.transportClass;
    targetRangeM = range;
    contacts.push({
      id: active.id,
      label: active.name,
      transportClass: active.transportClass,
      phase: phaseBucket,
      azimuthDeg: az,
      elevationDeg: el,
      rangeM: range,
    });
    if (state.isActive) {
      const sol = BallisticTrajectoryEngine.calculateLead(muzzle, active.position, active.velocity, accel.getMuzzleVelocityMps());
      if (sol.hasSolution && Number.isFinite(sol.leadAzimuthDeg) && Number.isFinite(sol.leadElevationDeg)) {
        solutionAvailable = true;
        leadAzimuthDeg = sol.leadAzimuthDeg;
        leadElevationDeg = sol.leadElevationDeg;
        timeToTargetS = sol.estimatedFlightTimeS;
        if (Number.isFinite(sol.recommendedMuzzleSpeedMps) && sol.recommendedMuzzleSpeedMps > 0) {
          const rec = sol.recommendedMuzzleSpeedMps;
          optimalMinMps = Math.min(420, Math.max(180, rec * 0.92));
          optimalMaxMps = Math.min(420, Math.max(180, rec * 1.08));
        }
      }
    }
  }
  return {
    phase: director.getPhase(),
    azimuthDeg: gantry.azimuthDeg,
    elevationDeg: gantry.elevationDeg,
    leadAzimuthDeg,
    leadElevationDeg,
    solutionAvailable,
    muzzleVelocityMps: director.getMuzzleVelocityMps(),
    capacitorChargeRatio: accel.getCapacitorChargeRatio(),
    optimalMinMps,
    optimalMaxMps,
    targetName,
    targetClass,
    targetRangeM,
    timeToTargetS,
    contacts,
    contraband: state.isContraband,
    uspAlertActive: state.uspAlertActive,
    uspCountdownRemainingS: state.uspCountdownRemainingS,
    canisterInFlight: state.canisterInFlight,
  };
}

/** Mirror of the ClientApp per-frame law (mounted=true while at console). */
function exportFrame(dt: number, chargeHeld: boolean, mounted = true) {
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

check('session docks (HELIUM3 100 kg)', director.startSession('HELIUM3', 100) === true);
let s = exportFrame(hFrame(), false);
check('first frame: AWAITING_ORBITAL_PASS painted on the HUD',
  attr3('gunner-panel', 'data-phase') === 'AWAITING_ORBITAL_PASS' && !has3('gunner-panel', 'is-hidden'));

// Coast the transport clock until a vessel clears the 20° elevation window.
let guard = 0;
while (director.getPhase() !== 'TARGETING_ACTIVE' && guard++ < 800) s = exportFrame(0.25, false);
check('transport window opens → TARGETING_ACTIVE (within 200 s sim)',
  director.getPhase() === 'TARGETING_ACTIVE', `phase=${director.getPhase()} guard=${guard}`);
check('radar pip tracks the live freighter', !has3('gunner-radar-pip-0', 'is-hidden'));
check('target strip names the live freighter', txt3('gunner-target-value').length > 'SKY EMPTY — NO ACTIVE FREIGHTER'.length);

// Aim at the contact and spool the coils.
{
  const pip = hud3.getElement('gunner-radar-pip-0');
  const caz = Number.parseFloat(pip?.getAttribute('data-contact-az') ?? '90');
  const cel = Number.parseFloat(pip?.getAttribute('data-contact-el') ?? '60');
  aim = { azimuth: caz, elevation: Math.min(85, Math.max(15, cel)) };
}
guard = 0;
exportFrame(hFrame(), false); // push the fresh aim into the director first
while (accel.getState().isSlewing && guard++ < 1200) exportFrame(hFrame(), false); // slew settle
check('crosshair tracks the articulated gantry (slew lag included)',
  Math.abs(Number.parseFloat(attr3('gunner-panel', 'data-az') ?? 'NaN') - aim.azimuth) < 0.05,
  `got ${attr3('gunner-panel', 'data-az')} want ${aim.azimuth} guard=${guard}`);

for (let i = 0; i < 90; i++) s = exportFrame(hFrame(), true); // ~1.5 s spool
check('held trigger → COIL_CHARGING', attr3('gunner-panel', 'data-phase') === 'COIL_CHARGING',
  `phase=${director.getPhase()}`);
const spooled = accel.getMuzzleVelocityMps();
check('capacitor spooled above floor (v > 240 m/s)', spooled > 240, `v=${spooled}`);
check('charge bar rose above mid-scale', Number.parseFloat(hud3.getElement('gunner-cap-fill')?.style['height'] ?? '0') > 40,
  `h=${hud3.getElement('gunner-cap-fill')?.style['height']}`);
check('whine woke with the coils (drive 1, freq > 80 Hz)',
  audio3.isCapacitorWhineActive() && audio3.getCapacitorWhineFrequencyHz() > CAPACITOR_WHINE_FLOOR_HZ);

// Trigger release fires (Spec §3.4.1). Legal cargo: klaxon must stay cold.
s = exportFrame(hFrame(), false);
check('trigger release launched the canister', s.canisterInFlight && s.lastResult === 'NONE');
check('phase → IN_FLIGHT_TRACKING', director.getPhase() === 'IN_FLIGHT_TRACKING');
check('HUD in-flight chip lit', !has3('gunner-inflight-chip', 'is-hidden'));
check('Lorentz blast + whistle fired on the rising edge',
  Number.isFinite(audio3.getLastExportCueTimes().dischargeAt) && Number.isFinite(audio3.getLastExportCueTimes().whistleAt));
check('legal export never arms the USP klaxon', audio3.isUspKlaxonAlertActive() === false);

// Run the arc out (crash / capture / timeout at the director's own laws).
guard = 0;
while (s.lastResult === 'NONE' && s.canisterInFlight && guard++ < 3000) s = exportFrame(0.25, false);
check('arc resolves to a terminal outcome', s.lastResult !== 'NONE',
  `result=${s.lastResult} guard=${guard}`);
check('outcome is SUCCESS or MISSED (no USP on legal cargo)',
  s.lastResult === 'SUCCESS' || s.lastResult === 'MISSED', `result=${s.lastResult}`);
check('capture chime only on SUCCESS (edge law)',
  audio3.getLastExportCueTimes().chimeAt !== Number.NEGATIVE_INFINITY === (s.lastResult === 'SUCCESS'));

// Wind the console down and walk away: suite retracts.
guard = 0;
while (director.getPhase() !== 'INACTIVE' && guard++ < 40) s = exportFrame(0.25, false);
exportFrame(0.25, false, false); // unmounted law
check('resolved + unmounted → suite retracts', has3('gunner-panel', 'is-hidden'));
check('whine gates out with the session', audio3.isCapacitorWhineActive() === false);

// Contraband siphon: the 45 s USP clock + klaxon, then a clean walk-off.
check('contraband session docks', director.startSession('STOLEN_CONTRABAND', 50) === true);
guard = 0;
let sp = exportFrame(hFrame(), false);
while (director.getPhase() !== 'TARGETING_ACTIVE' && guard++ < 800) sp = exportFrame(0.25, false);
check('contraband run reaches TARGETING_ACTIVE', director.getPhase() === 'TARGETING_ACTIVE',
  `phase=${director.getPhase()}`);
sp = exportFrame(hFrame(), true); // first spool == radar signature (Spec §3.4.3)
check('first contraband spool trips the siphon', sp.uspAlertActive === true);
check('USP klaxon armed by the siphon', audio3.isUspKlaxonAlertActive() === true);
check('HUD banner is hot (amber) at T-45', !has3('gunner-usp', 'is-hidden') && has3('gunner-usp', 'is-hot'));
check('banner counts down from the canonical 45 s',
  (txt3('gunner-usp-value') ?? '').startsWith('USP INTERCEPT T-4'), `got "${txt3('gunner-usp-value')}"`);
sp = exportFrame(hFrame(), false, false); // cancel law: walk off the console
director.cancelSession();
sp = exportFrame(hFrame(), false, false);
check('cancel drops the alert + disarms the klaxon',
  sp.uspAlertActive === false && audio3.isUspKlaxonAlertActive() === false);
check('cancel retracts the banner', has3('gunner-usp', 'is-hidden'));

audio3.dispose();
director.dispose();
hud3.dispose();
ots.dispose?.();
accel.dispose?.();

// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log(`\nALL ${passed} CHECKS PASSED ✔  (Spec 27 Phase 5: gunner HUD + capacitor telemetry + procedural audio)`);
  process.exit(0);
} else {
  console.error(`\n${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  ✘ ${f}`);
  process.exit(1);
}
