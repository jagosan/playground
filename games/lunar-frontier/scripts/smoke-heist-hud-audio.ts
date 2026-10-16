/**
 * Spec 26 Phase 5 verification probe: Heist HUD Telemetry & Procedural Audio.
 * Run: `npx tsx scripts/smoke-heist-hud-audio.ts`  (exit code 0 == all green)
 *
 * Covers Spec 26 §3.5 end to end, headless (fake DOM + mock Web Audio):
 *
 *   A–F. `LunarHUD` heist overlay (`#lunar-hud-heist`): DOM creation,
 *        phase-driven visibility toggling, intercept radar (Δv m/s + km/h,
 *        lateral bar, `.is-locked` reticle), depot breach countdown bar
 *        (T-seconds readout, 44.0 s progress law, amber→crimson `.is-critical`
 *        below T-30), Mag-Lock decryption dial (3-ring 3-stage alignment),
 *        contraband inventory pill (gold slots + secured count).
 *   G–I. `LunarAudioSystem` procedural voices: induction guideway hum
 *        (120–280 Hz carrier pitch tracking), Doppler flyby trigger + ratio,
 *        mag-lock disengage impulse timestamping, klaxon two-tone law
 *        (660 ↔ 880 Hz) and pre-init arming.
 *   J.   Clean disposal: every owned voice stopped, arrays drained, no
 *        post-dispose throws on HUD or audio surfaces.
 *   K.   Integration: a REAL frozen-clock `TrainHeistDirector` drives the
 *        HUD + alarm exactly the way `ClientApp.stepTrainHeistDirector` does
 *        (state-driven, per frame).
 */
import {
  LunarHUD,
  HUD_HEIST_ID,
  HUD_HEIST_COUNTDOWN_FULL_S,
  HUD_HEIST_CRITICAL_S,
  HUD_HEIST_LOOT_SLOTS,
  HUD_HEIST_LAT_FULL_M,
} from '../src/ui/LunarHUD.ts';
import {
  LunarAudioSystem,
  MAGLEV_HUM_FLOOR_HZ,
  MAGLEV_HUM_CEILING_HZ,
  MAGLOCK_THUD_HZ,
  KLAXON_LOW_HZ,
  KLAXON_HIGH_HZ,
} from '../src/audio/LunarAudioSystem.ts';
import { HighSpeedMaglev } from '../src/infrastructure/HighSpeedMaglev.ts';
import {
  TrainHeistDirector,
  DEPOT_COUNTDOWN_S,
  type HeistPhase,
  type HeistTelemetry,
} from '../src/quests/TrainHeistDirector.ts';

// ---------------------------------------------------------------------------
// Fake DOM (structural subset the HUD uses; same pattern as smoke-intro-hud-fx)
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
type V3 = { x: number; y: number; z: number };
const vAdd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vSub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vScale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

/** Synthetic telemetry frame builder (contract shape from TrainHeistDirector). */
function tele(phase: HeistPhase, over: Partial<HeistTelemetry> = {}): HeistTelemetry {
  return {
    phase,
    relativeSpeedMps: 0,
    lateralDistanceM: 0,
    longitudinalOffsetM: 0,
    canBoard: false,
    hackProgressFraction: 0,
    countdownRemainingS: 0,
    stolenCargoCount: 0,
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
const width = (key: string): string => hud.getElement(key)?.style.width ?? '';

// ---------------------------------------------------------------------------
section('A. heist overlay DOM construction');

check('HUD_HEIST_ID is #lunar-hud-heist', HUD_HEIST_ID === 'lunar-hud-heist');
check('heist-panel exists in the logical element map', hud.getElement('heist-panel') !== undefined);
check('panel carries the heist-overlay class', has('heist-panel', 'heist-overlay'));
check('panel starts hidden (is-hidden)', has('heist-panel', 'is-hidden'));
check('panel data-phase starts INACTIVE', attr('heist-panel', 'data-phase') === 'INACTIVE');
check(
  'document registry has the overlay + widget ids',
  doc.getElementById(HUD_HEIST_ID) !== null &&
    doc.getElementById('lunar-hud-heist-radar') !== null &&
    doc.getElementById('lunar-hud-heist-countdown') !== null &&
    doc.getElementById('lunar-hud-heist-dial') !== null &&
    doc.getElementById('lunar-hud-heist-loot') !== null,
);
check(
  'registry has all 3 dial rings + ' + HUD_HEIST_LOOT_SLOTS + ' loot slots',
  (() => {
    for (let i = 1; i <= 3; i++) if (doc.getElementById(`lunar-hud-heist-ring-${i}`) === null) return false;
    for (let i = 0; i < HUD_HEIST_LOOT_SLOTS; i++)
      if (doc.getElementById(`lunar-hud-heist-loot-slot-${i}`) === null) return false;
    return true;
  })(),
);
check('radar Δv field starts em-dashed', txt('heist-dv-value') === 'Δv: — m/s (— km/h)');
check('countdown starts at the canonical T-44.0s datum', txt('heist-countdown-value') === `T-${HUD_HEIST_COUNTDOWN_FULL_S.toFixed(1)}s`);
check('constants mirror Spec 26 §3.3.4 (44.0 / 30.0 s)', HUD_HEIST_COUNTDOWN_FULL_S === 44.0 && HUD_HEIST_CRITICAL_S === 30.0);
check('loot pill starts at data-loot-count=0', attr('heist-loot', 'data-loot-count') === '0');

// ---------------------------------------------------------------------------
section('B. phase-driven visibility toggling');

hud.updateHeistTelemetry(null);
check('null telemetry keeps the overlay retracted', has('heist-panel', 'is-hidden'));
hud.updateHeistTelemetry(tele('INACTIVE'));
check('INACTIVE keeps the overlay retracted', has('heist-panel', 'is-hidden'));
hud.updateHeistTelemetry(tele('INTERCEPTING', { relativeSpeedMps: 5, lateralDistanceM: 7 }));
check('INTERCEPTING reveals the overlay', !has('heist-panel', 'is-hidden'));
check('data-phase follows the phase machine', attr('heist-panel', 'data-phase') === 'INTERCEPTING');
check('radar visible during intercept', !has('heist-radar', 'is-hidden'));
check('countdown hidden before the alarm arms', has('heist-countdown', 'is-hidden'));
check('dial hidden while off-train', has('heist-dial', 'is-hidden'));
check('pill hidden with empty pockets', has('heist-loot', 'is-hidden'));
hud.updateHeistTelemetry(null);
check('null re-retracts the live overlay', has('heist-panel', 'is-hidden'));

// ---------------------------------------------------------------------------
section('C. high-speed intercept radar');

hud.updateHeistTelemetry(
  tele('INTERCEPTING', { relativeSpeedMps: 1.2, lateralDistanceM: 4.1, canBoard: false }),
);
check('Δv renders m/s AND km/h (1.2 → 4.3)', txt('heist-dv-value') === 'Δv: 1.2 m/s (4.3 km/h)',
  `got "${txt('heist-dv-value')}"`);
check('lateral distance renders in metres', txt('heist-lat-value') === 'LAT: 4.1 m',
  `got "${txt('heist-lat-value')}"`);
const latPct = Math.round((4.1 / HUD_HEIST_LAT_FULL_M) * 100);
check(`lateral bar fill = ${latPct}% of the ${HUD_HEIST_LAT_FULL_M} m scale`, width('heist-lat-fill') === `${latPct}%`,
  `got "${width('heist-lat-fill')}"`);
check('lateral fill mirrors data-lat-m for headless reads', attr('heist-lat-fill', 'data-lat-m') === '4.10');
check('unmatched frame: reticle NOT locked', !has('heist-reticle', 'is-locked'));
check('unmatched frame: scanning status line', txt('heist-lock-status') === 'SCANNING — NO VELOCITY LOCK');
hud.updateHeistTelemetry(
  tele('BOARDING_WINDOW', { relativeSpeedMps: 1.2, lateralDistanceM: 4.1, canBoard: true }),
);
check('matched envelope: reticle gains .is-locked', has('heist-reticle', 'is-locked'));
check('matched envelope: READY TO BOARD banner', txt('heist-lock-status') === 'VELOCITY MATCHED // READY TO BOARD');
hud.updateHeistTelemetry(tele('BOARDING_WINDOW', { relativeSpeedMps: 9, canBoard: false }));
check('envelope break: .is-locked is removed again', !has('heist-reticle', 'is-locked'));
hud.updateHeistTelemetry(
  tele('INTERCEPTING', { relativeSpeedMps: Number.NaN, lateralDistanceM: Number.NaN }),
);
check('NaN telemetry degrades to em dashes, never "NaN"',
  !txt('heist-dv-value').includes('NaN') && !txt('heist-lat-value').includes('NaN'));

// ---------------------------------------------------------------------------
section('D. depot breach countdown bar');

hud.updateHeistTelemetry(
  tele('LOOT_SECURED', { countdownRemainingS: DEPOT_COUNTDOWN_S, stolenCargoCount: 6 }),
);
check('LOOT_SECURED arms the countdown bar', !has('heist-countdown', 'is-hidden'));
check('full clock reads T-44.0s', txt('heist-countdown-value') === 'T-44.0s');
check('full clock: fill at 100%', width('heist-countdown-fill') === '100%',
  `got "${width('heist-countdown-fill')}"`);
check('full clock stays amber (no .is-critical at T-44)', !has('heist-countdown', 'is-critical'));
hud.updateHeistTelemetry(tele('DEPOT_COUNTDOWN', { countdownRemainingS: 29.9 }));
check('T-29.9 crosses the red line (.is-critical)', has('heist-countdown', 'is-critical'));
check('T-29.9 readout', txt('heist-countdown-value') === 'T-29.9s');
check('progress bar drains proportionally (68%)', width('heist-countdown-fill') === '68%',
  `got "${width('heist-countdown-fill')}"`);
hud.updateHeistTelemetry(tele('DEPOT_COUNTDOWN', { countdownRemainingS: 30.0 }));
check('exactly T-30.0 is NOT critical (strict <)', !has('heist-countdown', 'is-critical'));
hud.updateHeistTelemetry(tele('DEPOT_COUNTDOWN', { countdownRemainingS: 0.04 }));
check('near-expiry readout rounds to T-0.0s', txt('heist-countdown-value') === 'T-0.0s');
check('near-expiry is critical', has('heist-countdown', 'is-critical'));
hud.updateHeistTelemetry(tele('BAILOUT_SUCCESS', { countdownRemainingS: 0 }));
check('post-bailout retracts the countdown', has('heist-countdown', 'is-hidden'));
check('retraction clears the stale .is-critical', !has('heist-countdown', 'is-critical'));
hud.updateHeistTelemetry(tele('DEPOT_COUNTDOWN', { countdownRemainingS: 99 }));
check('out-of-range clock clamps to T-44.0s', txt('heist-countdown-value') === 'T-44.0s');

// ---------------------------------------------------------------------------
section('E. Mag-Lock decryption circular dial');

hud.updateHeistTelemetry(tele('ON_BOARD_CRACKING', { hackProgressFraction: 0 }));
check('ON_BOARD_CRACKING reveals the dial', !has('heist-dial', 'is-hidden'));
check('0% bypass reads 0%', txt('heist-dial-value') === '0%');
check('stage 1 ring not aligned at 0%', !has('heist-ring-1', 'is-aligned'));
hud.updateHeistTelemetry(tele('ON_BOARD_CRACKING', { hackProgressFraction: 0.4 }));
check('40% bypass reads 40%', txt('heist-dial-value') === '40%');
check('ring 1 aligned past 1/3', has('heist-ring-1', 'is-aligned'));
check('ring 2 still unaligned at 40%', !has('heist-ring-2', 'is-aligned'));
check('panel mirrors data-hack=0.400', attr('heist-panel', 'data-hack') === '0.400');
hud.updateHeistTelemetry(tele('ON_BOARD_CRACKING', { hackProgressFraction: 2 / 3 }));
check('ring 2 aligns exactly at 2/3', has('heist-ring-2', 'is-aligned'));
hud.updateHeistTelemetry(tele('ON_BOARD_CRACKING', { hackProgressFraction: 1 }));
check('clamshell: 100% + all three rings aligned',
  txt('heist-dial-value') === '100%' &&
    has('heist-ring-1', 'is-aligned') && has('heist-ring-2', 'is-aligned') && has('heist-ring-3', 'is-aligned'));
hud.updateHeistTelemetry(tele('LOOT_SECURED', { countdownRemainingS: 44, stolenCargoCount: 6 }));
check('dial retracts once the vault pops', has('heist-dial', 'is-hidden'));

// ---------------------------------------------------------------------------
section('F. contraband inventory pill');

check('canonical 6-item haul reveals the pill', !has('heist-loot', 'is-hidden'));
check('haul count reads ×6', txt('heist-loot-count') === '×6');
check('pill mirrors data-loot-count=6', attr('heist-loot', 'data-loot-count') === '6');
check('all 6 slots glow gold', (() => {
  for (let i = 0; i < HUD_HEIST_LOOT_SLOTS; i++) if (!has(`heist-loot-slot-${i}`, 'is-secured')) return false;
  return true;
})());
hud.updateHeistTelemetry(tele('DEPOT_COUNTDOWN', { countdownRemainingS: 20, stolenCargoCount: 3 }));
check('partial 3-item haul reads ×3', txt('heist-loot-count') === '×3');
check('slots 0–2 secured, 3–5 dark', (() => {
  for (let i = 0; i < 3; i++) if (!has(`heist-loot-slot-${i}`, 'is-secured')) return false;
  for (let i = 3; i < HUD_HEIST_LOOT_SLOTS; i++) if (has(`heist-loot-slot-${i}`, 'is-secured')) return false;
  return true;
})());
hud.updateHeistTelemetry(tele('INTERCEPTING', { relativeSpeedMps: 4, stolenCargoCount: 0 }));
check('empty pockets retract the pill', has('heist-loot', 'is-hidden'));
hud.updateHeistTelemetry(tele('DEPOT_COUNTDOWN', { countdownRemainingS: 10, stolenCargoCount: 9 }));
check('over-slot haul (9) lights every slot, reads ×9',
  txt('heist-loot-count') === '×9' && (() => {
    for (let i = 0; i < HUD_HEIST_LOOT_SLOTS; i++) if (!has(`heist-loot-slot-${i}`, 'is-secured')) return false;
    return true;
  })());
hud.updateHeistTelemetry(tele('FAILED', { stolenCargoCount: 0 }));
check('FAILED keeps the overlay up (data-phase=FAILED)', attr('heist-panel', 'data-phase') === 'FAILED');
hud.updateHeistTelemetry(tele('INACTIVE'));
check('INACTIVE retracts everything again', has('heist-panel', 'is-hidden'));

// ---------------------------------------------------------------------------
section('G. induction guideway hum (120–280 Hz carrier)');

const audio = new LunarAudioSystem();
// Pre-init: fractions are remembered and answered arithmetically.
audio.setMaglevInductionHum(0.5);
check('pre-init fraction is remembered (mid-band 200 Hz)',
  approx(audio.getMaglevHumFrequencyHz(), MAGLEV_HUM_FLOOR_HZ + 0.5 * (MAGLEV_HUM_CEILING_HZ - MAGLEV_HUM_FLOOR_HZ)),
  `got ${audio.getMaglevHumFrequencyHz()}`);
void audio.init(); // async fn, sync body — graph is built on this line
check('audio engine initialized headless (mock context)', audio.isInitialized() && audio.isHeadless());
check('graph built carrier at the remembered 200 Hz', approx(audio.getMaglevHumFrequencyHz(), 200));
audio.setMaglevInductionHum(0);
check('parked consist: carrier parks at the 120 Hz floor', approx(audio.getMaglevHumFrequencyHz(), MAGLEV_HUM_FLOOR_HZ));
check('parked consist: hum drive gate is 0', audio.getMaglevHumLevel() === 0);
audio.setMaglevInductionHum(0.25);
check('quarter-throttle tracks 160 Hz', approx(audio.getMaglevHumFrequencyHz(), 160));
check('quarter-throttle drive = 0.3 + 0.7·f', approx(audio.getMaglevHumLevel(), 0.3 + 0.7 * 0.25));
audio.setMaglevInductionHum(1);
check('full cruise pegs the 280 Hz ceiling', approx(audio.getMaglevHumFrequencyHz(), MAGLEV_HUM_CEILING_HZ));
check('full cruise drive envelope = 1.0', approx(audio.getMaglevHumLevel(), 1));
audio.setMaglevInductionHum(2);
check('over-range fraction clamps to the ceiling', approx(audio.getMaglevHumFrequencyHz(), MAGLEV_HUM_CEILING_HZ));
audio.setMaglevInductionHum(Number.NaN);
check('NaN fraction clamps to 0 (floor, silent)',
  approx(audio.getMaglevHumFrequencyHz(), MAGLEV_HUM_FLOOR_HZ) && audio.getMaglevHumLevel() === 0);

// Gain law: MAGLEV_HUM_BASE_LEVEL(0.12) × sfx fader × drive — read the node.
const internals = audio as unknown as {
  ownedVoices: { stop(): unknown; type?: string; frequency?: { value: number }; stopped?: boolean }[];
  maglevHumGain: { gain: { value: number } } | null;
  klaxonGain: { gain: { value: number } } | null;
  klaxonOsc: { type: string; frequency: { value: number } } | null;
};
audio.setMaglevInductionHum(1);
check('hum gain node rides 0.12 × sfx(0.9) × drive(1) = 0.108',
  internals.maglevHumGain !== null && approx(internals.maglevHumGain.gain.value, 0.12 * 0.9 * 1, 1e-9),
  `got ${internals.maglevHumGain?.gain.value}`);

// ---------------------------------------------------------------------------
section('H. citadel intrusion klaxon (660 ↔ 880 Hz two-tone)');

check('klaxon starts silent', audio.isCitadelAlarmActive() === false);
const tones = audio.getCitadelAlarmTones();
check('canonical tone pair 660 / 880 Hz', tones.lowHz === KLAXON_LOW_HZ && tones.highHz === KLAXON_HIGH_HZ);
check('770 Hz carrier ± 110 Hz swing reproduces the pair',
  tones.baseHz === 770 && tones.swingHz === 110 &&
    tones.baseHz - tones.swingHz === KLAXON_LOW_HZ && tones.baseHz + tones.swingHz === KLAXON_HIGH_HZ);
check('alternation rate ≈ 1.1 Hz', approx(tones.alternationHz, 1.1));
audio.setCitadelAlarmActive(true);
check('armed klaxon reports active', audio.isCitadelAlarmActive() === true);
check('klaxon gain opens to 0.16 × sfx(0.9) = 0.144',
  internals.klaxonGain !== null && approx(internals.klaxonGain.gain.value, 0.16 * 0.9, 1e-9),
  `got ${internals.klaxonGain?.gain.value}`);
audio.setCitadelAlarmActive(true);
check('re-arming is idempotent', audio.isCitadelAlarmActive() === true);
audio.setCitadelAlarmActive(false);
check('disarm silences the siren',
  audio.isCitadelAlarmActive() === false &&
    internals.klaxonGain !== null && internals.klaxonGain.gain.value === 0);
check('carrier oscillator is a 770 Hz sawtooth',
  internals.klaxonOsc !== null && internals.klaxonOsc.type === 'sawtooth' && approx(internals.klaxonOsc.frequency.value, 770));
check('square siren LFO @ 1.1 Hz exists in the owned voices',
  internals.ownedVoices.some((v) => v.type === 'square' && v.frequency !== undefined && approx(v.frequency.value, 1.1)));
check('stator-slot wobble LFO @ 9 Hz exists in the owned voices',
  internals.ownedVoices.some((v) => v.type === 'sine' && v.frequency !== undefined && approx(v.frequency.value, 9)));

// Pre-init arming edge: the gain must open when init() builds the graph.
const early = new LunarAudioSystem();
early.setCitadelAlarmActive(true);
check('pre-init arm reports active', early.isCitadelAlarmActive() === true);
void early.init();
const earlyGain = (early as unknown as { klaxonGain: { gain: { value: number } } | null }).klaxonGain;
check('init() opens a pre-armed klaxon gain', earlyGain !== null && earlyGain.gain.value > 0);
early.dispose();

// ---------------------------------------------------------------------------
section('I. Doppler flyby & mag-lock disengage');

check('no flyby recorded before the first pass', audio.getLastMaglevFlyby() === null);
audio.playMaglevFlyby(25);
const fb = audio.getLastMaglevFlyby();
check('flyby triggers and records 25 m/s (90 km/h)', fb !== null && approx(fb.speedMps, 25));
const beta = 25 / 343;
check('pass-by pitch ratio matches (1+β)/(1−β)', fb !== null && approx(fb.dopplerRatio, (1 + beta) / (1 - beta), 1e-9),
  `got ${fb?.dopplerRatio}`);
audio.playMaglevFlyby();
check('default flyby speed is the 25 m/s cruise', approx(audio.getLastMaglevFlyby()?.speedMps ?? -1, 25));
audio.playMaglevFlyby(0);
check('stationary pass → unity Doppler ratio', approx(audio.getLastMaglevFlyby()?.dopplerRatio ?? -1, 0 + 1));
audio.playMaglevFlyby(20);
const r20 = audio.getLastMaglevFlyby()?.dopplerRatio ?? 0;
audio.playMaglevFlyby(40);
const r40 = audio.getLastMaglevFlyby()?.dopplerRatio ?? 0;
check('faster train ⇒ bigger Doppler shift', r40 > r20 && r20 > 1);
check('mag-lock disengage starts un-timestamped', audio.getLastMagLockDisengageAt() === Number.NEGATIVE_INFINITY);
audio.playMagLockDisengage();
check('disengage stamps a finite context time', Number.isFinite(audio.getLastMagLockDisengageAt()));
check('sub-bass thud spec is the canonical 40 Hz', MAGLOCK_THUD_HZ === 40);

// Autoplay / pre-init safety: every new surface is callable on a bare system.
const bare = new LunarAudioSystem();
let bareThrow = false;
try {
  bare.setMaglevInductionHum(0.7);
  bare.setCitadelAlarmActive(true);
  bare.playMaglevFlyby(30);
  bare.playMagLockDisengage();
} catch {
  bareThrow = true;
}
check('pre-init calls never throw (autoplay-safe)', bareThrow === false);
check('pre-init one-shots record nothing', bare.getLastMaglevFlyby() === null &&
  bare.getLastMagLockDisengageAt() === Number.NEGATIVE_INFINITY);
bare.dispose();

// ---------------------------------------------------------------------------
section('J. clean disposal — no leaked voices, no post-dispose throws');

check('engine owns a full persistent voice pool', internals.ownedVoices.length >= 12,
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
check('dispose() stopped EVERY owned voice', wrapped.every((v) => v.stopped === true));
check('owned-voice pool drained to zero', internals.ownedVoices.length === 0);
check('klaxon disarms itself on teardown', audio.isCitadelAlarmActive() === false);
check('flyby record dropped on teardown', audio.getLastMaglevFlyby() === null);
check('isDisposed flag flips', audio.isDisposed() === true);
let audioThrow = false;
try {
  audio.setMaglevInductionHum(0.5);
  audio.setCitadelAlarmActive(true);
  audio.playMaglevFlyby();
  audio.playMagLockDisengage();
  void audio.getMaglevHumFrequencyHz();
  void audio.getMaglevHumLevel();
  void audio.init();
} catch {
  audioThrow = true;
}
check('post-dispose audio surface never throws', audioThrow === false);
check('post-dispose hum readback stays finite', Number.isFinite(audio.getMaglevHumFrequencyHz()));

// HUD teardown. The fake registry keys by setAttribute('id'), not by tree
// membership, so "removed from the document" is proven by the HUD root
// detaching from the body (children drained) — the heist panel rides inside
// that root and is unreachable either way (els map is cleared).
check('HUD is mounted in the fake body before dispose', doc.getElementById(HUD_HEIST_ID) !== null);
const mountParent = doc.body;
const mountsBefore = mountParent.children.length;
hud.dispose();
check('HUD dispose flips isDisposed', hud.isDisposed() === true);
check('HUD root (with the heist overlay) detached from the body',
  mountsBefore > 0 && doc.body.children.length === 0 && doc.getElementById('lunar-hud') === null);
check('heist panel keys are unreachable after dispose', hud.getElement('heist-panel') === undefined);
let hudThrow = false;
try {
  hud.updateHeistTelemetry(tele('INTERCEPTING', { canBoard: true }));
  void hud.getHeistTelemetry();
  hud.dispose();
} catch {
  hudThrow = true;
}
check('post-dispose HUD calls never throw (double-dispose safe)', hudThrow === false);
check('post-dispose telemetry mirror is cleared', hud.getHeistTelemetry() === null);

// ---------------------------------------------------------------------------
section('K. integration: live TrainHeistDirector → HUD + alarm (ClientApp law)');

// Frozen-clock maglev (pure spline math, no scene, no citadel): exactly the
// pose/velocity law ClientApp.stepTrainHeistDirector feeds the director.
const maglev = new HighSpeedMaglev();
const director = new TrainHeistDirector(maglev, null);
const hud2 = new LunarHUD({ document: makeFakeDocument() as unknown as Document });
const txt2 = (key: string): string => hud2.textOf(key);
const has2 = (key: string, cls: string): boolean => hud2.hasClass(key, cls);
const attr2 = (key: string, name: string): string | null =>
  hud2.getElement(key)?.getAttribute(name) ?? null;

// The ClientApp per-frame wiring law under test.
function frame(dt: number): HeistTelemetry {
  const vault = maglev.getVaultCarState();
  const rover = vault === null ? { x: 0, y: 0, z: 0 } : vault.worldPosition;
  const t = director.update(dt, rover, vault === null ? 0 : vault.speedMps);
  hud2.updateHeistTelemetry(t);
  audio2.setCitadelAlarmActive(t.phase === 'DEPOT_COUNTDOWN');
  return t;
}
const audio2 = new LunarAudioSystem();
void audio2.init();

check('heist opens into INTERCEPTING on the HUD', (() => {
  director.startHeist();
  frame(hFrame());
  return attr2('heist-panel', 'data-phase') === 'INTERCEPTING';
})());

// Drive inside the envelope: lateral 4 m on the true perpendicular, matched scalar speed.
const v0 = maglev.getVaultCarState()!;
const rawP = { x: 3, y: 3, z: 0 };
const f0 = v0.worldForward;
const perp = vSub(rawP, vScale(f0, rawP.x * f0.x + rawP.y * f0.y + rawP.z * f0.z));
const lateral = vScale(perp, 4 / Math.hypot(perp.x, perp.y, perp.z));
const roverPos = vAdd(v0.worldPosition, lateral);
const tBoard = director.update(hFrame(), roverPos, v0.speedMps);
hud2.updateHeistTelemetry(tBoard);
check('director envelope match lights the HUD reticle', tBoard.canBoard && has2('heist-reticle', 'is-locked'));
check('HUD km/h mirror tracks the director Δv', txt2('heist-dv-value').includes('m/s'));
check('boarding jump lands', director.executeBoardingJump() === true);

// Crack the Mag-Lock on the deck.
let cracked = false;
let hackMidChecked = false;
for (let i = 0; i < 500 && !cracked; i++) {
  cracked = director.interactVaultLock(hFrame());
  if (!hackMidChecked && director.getHackProgress() > 0.5) {
    frame(hFrame());
    hackMidChecked = !has2('heist-dial', 'is-hidden');
  }
}
check('dial tracks live hack progress mid-crack', hackMidChecked);
check('vault cracks after the 6.0 s hold', cracked && director.getHackProgress() === 1);

const tSecured = frame(hFrame()); // LOOT_SECURED → DEPOT_COUNTDOWN handoff tick
check('handoff arms the HUD depot clock', !has2('heist-countdown', 'is-hidden'));
check('clock reads the canonical T-44.0s', txt2('heist-countdown-value') === `T-${DEPOT_COUNTDOWN_S.toFixed(1)}s`,
  `got "${txt2('heist-countdown-value')}"`);
check('contraband pill counts the real 6-item haul', txt2('heist-loot-count') === '×6' && !has2('heist-loot', 'is-hidden'));
check('klaxon arms with DEPOT_COUNTDOWN (alarm law)', audio2.isCitadelAlarmActive() === true);

// Drain past the T-30 red line.
let t = tSecured;
for (let i = 0; i < 60 * 20 && !(t.countdownRemainingS < 30); i++) t = frame(hFrame());
check('countdown drains below T-30 → .is-critical', t.countdownRemainingS < 30 && has2('heist-countdown', 'is-critical'));

// Bail out: klaxon stands down, countdown retracts.
check('bailout jump succeeds', director.executeBailoutJump() === true);
const tBailed = frame(hFrame());
check('BAILOUT_SUCCESS disarms the intrusion klaxon', audio2.isCitadelAlarmActive() === false);
check('escape retracts the depot countdown', has2('heist-countdown', 'is-hidden'));

// Full reset → the next frame retracts the whole overlay.
director.reset();
frame(hFrame());
check('reset frame retracts the heist overlay', has2('heist-panel', 'is-hidden'));

audio2.dispose();
director.dispose();
hud2.dispose();

// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log(`\nALL ${passed} CHECKS PASSED ✔  (Spec 26 Phase 5: heist HUD + procedural audio)`);
  process.exit(0);
} else {
  console.error(`\n${failures.length} FAILURE(S) of ${passed + failures.length}:`);
  for (const f of failures) console.error(`  ✘ ${f}`);
  process.exit(1);
}
