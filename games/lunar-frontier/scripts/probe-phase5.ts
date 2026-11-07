/**
 * Phase 5 behavior probe (throwaway): DPR clamp maths, profile persistence,
 * haptic patterns/throttles, audio resume hook — with mocked platform.
 */
import {
  applyHardwareScaling,
  computeHardwareScalingLevel,
  effectiveDpr,
  frameGateMs,
  isMobileUserAgent,
  readHapticsEnabled,
  readMobileProfile,
  writeMobileProfile,
  MOBILE_PROFILE_STORAGE,
} from '../src/client/MobileSettings.ts';
import {
  TactileHaptics,
  FOOTFALL_PULSE_MS,
  RCS_BOOST_PATTERN,
  MINING_PULSE_MS,
  MINING_PULSE_INTERVAL_MS,
  COLLISION_IMPACT_MS,
} from '../src/audio/TactileHaptics.ts';

let pass = 0;
const fail: string[] = [];
const ok = (cond: boolean, msg: string): void => {
  if (cond) pass += 1;
  else fail.push(msg);
};

// -- platform mocks ---------------------------------------------------------
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
};

// UA sniff
ok(isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone UA mobile');
ok(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 9)'), 'Android UA mobile');
ok(!isMobileUserAgent('Mozilla/5.0 (X11; Linux x86_64)'), 'desktop UA not mobile');
ok(!isMobileUserAgent(undefined), 'undefined UA not mobile');

// DPR clamp maths (balanced / battery / hi-fi at device DPR 3.0)
ok(effectiveDpr('balanced', 3.0) === 1.5, 'balanced caps DPR at 1.5');
ok(computeHardwareScalingLevel('balanced', 3.0) === 1 / 1.5, 'balanced scaling 1/1.5');
ok(effectiveDpr('battery-saver', 3.0) === 1.0, 'battery-saver DPR 1.0');
ok(computeHardwareScalingLevel('battery-saver', 3.0) === 1.5, 'battery-saver pin 1.5');
ok(effectiveDpr('high-fidelity', 3.0) === 2.0, 'hi-fi caps DPR at 2.0');
ok(effectiveDpr('high-fidelity', 1.0) === 1.0, 'hi-fi native DPR below cap');
ok(frameGateMs('battery-saver') === 1000 / 30, 'battery gate 30fps');
ok(frameGateMs('balanced') === 1000 / 60, 'balanced gate 60fps');

// persistence
ok(readMobileProfile() === 'balanced', 'default profile balanced');
writeMobileProfile('battery-saver');
ok(store.get(MOBILE_PROFILE_STORAGE) === 'battery-saver', 'persisted to LF_MOBILE_PROFILE');
ok(readMobileProfile() === 'battery-saver', 'read-back battery-saver');
store.set(MOBILE_PROFILE_STORAGE, 'garbage');
ok(readMobileProfile() === 'balanced', 'garbage read falls back to balanced');

// applyHardwareScaling on a fake engine
let engineLevel = -1;
const engine = { setHardwareScalingLevel: (l: number) => { engineLevel = l; } };
const forced = applyHardwareScaling(engine, 'balanced', 3.0);
ok(forced.applied && engineLevel === 1 / 1.5, 'forced scaling applied');
ok(forced.frameGateMs === 1000 / 60, 'forced gate 60fps');
const noForce = applyHardwareScaling(engine, null, 3.0); // headless UA → not mobile
// storage currently says 'garbage'→balanced; headless → applied false
ok(!noForce.applied && engineLevel === 1 / 1.5, 'desktop/headless untouched');

// -- haptics ----------------------------------------------------------------
const pulses: (number | number[])[] = [];
let clock = 0;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 9)',
    vibrate: (p: number | number[]) => { pulses.push(p); return true; },
  },
});
(globalThis as { performance?: unknown }).performance = { now: () => clock };

const h = new TactileHaptics();
ok(h.isEnabled(), 'haptics default enabled');
ok(h.footfall() && pulses.at(-1) === FOOTFALL_PULSE_MS, 'footfall 12ms');
ok(h.rcsBoost() && JSON.stringify(pulses.at(-1)) === JSON.stringify(RCS_BOOST_PATTERN), 'rcs [15,30,20]');
clock = 0;
ok(h.miningPulse() && pulses.at(-1) === MINING_PULSE_MS, 'mining 25ms');
clock = 50;
ok(!h.miningPulse(), 'mining throttled at 50ms');
clock = MINING_PULSE_INTERVAL_MS + 1;
ok(h.miningPulse(), 'mining re-armed after 150ms');
ok(h.collisionImpact() && pulses.at(-1) === COLLISION_IMPACT_MS, 'impact 60ms');
ok(!h.collisionImpact(), 'impact throttled back-to-back');
h.setEnabled(false);
const beforeOff = pulses.length;
ok(!h.footfall() && !h.rcsBoost() && pulses.length === beforeOff, 'disabled = no-op');
ok(store.get('LF_HAPTICS') === '0', 'haptics toggle persisted');
h.setEnabled(true);
ok(readHapticsEnabled() === true, 're-enable read-back');

// iOS Safari: no vibrate → all no-ops
delete (globalThis.navigator as { vibrate?: unknown }).vibrate;
ok(!TactileHaptics.isSupported(), 'iOS: unsupported');
ok(!h.footfall() && !h.rcsBoost() && !h.miningPulse() && !h.collisionImpact(), 'iOS: all no-op');

// -- audio resume hook ------------------------------------------------------
import { LunarAudioSystem } from '../src/audio/LunarAudioSystem.ts';

void (async () => {
  const audio = new LunarAudioSystem();
  await audio.init();
  await audio.resume(); // must not reject pre/post init, headless mock ctx
  ok(true, 'audio.resume() never rejects');

  console.log(`PASS ${pass}/${pass + fail.length}`);
  if (fail.length > 0) {
    console.log('FAILURES:\n' + fail.map((f) => `  ✗ ${f}`).join('\n'));
    process.exit(1);
  }
})();
