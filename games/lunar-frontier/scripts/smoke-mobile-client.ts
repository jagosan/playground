/**
 * Spec 33 Phase 6 acceptance (TASK-PLAY-080f) — mobile touch client &
 * responsive HUD headless smoke suite. Runs under
 * `npx tsx scripts/smoke-mobile-client.ts` (exit 0 == all green) and is
 * registered in package.json as `npm run smoke:mobile-client`.
 *
 * Covers every Spec 33 §4 acceptance category:
 *
 *   A. PWA & mobile shell — manifest schema, viewport/apple tags, portrait
 *      orientation-guard CSS, audio-unlock banner markup (static analysis).
 *   B. Touch input kinematics — floating stick origin, 8 px deadzone, 54 px
 *      rim clamp, normalized [−1,1] output, 300 ms / double-flick sprint
 *      latches, differential yaw/pitch look scaling, exponential flick coast
 *      (τ = 120 ms), damped-spring thumb return, button isolation.
 *   C. MobileSettings — DPR clamp maths per profile, hardware scaling pins,
 *      frame gates, UA sniff, profile/haptics localStorage persistence.
 *   D. TactileHaptics — footfall / RCS / mining / collision pulse patterns,
 *      throttles, enable toggle, hostile-platform safe no-ops.
 *   E. ClientApp integration (NullEngine + fake DOM) — tri-state
 *      keyboard → touch → gamepad → touch → keyboard with deck auto-hide,
 *      ground hop + airborne PLSS RCS (O₂ draw + [15,30,20] haptic), airborne
 *      roll, smart-button proximity (BOARD / DISMOUNT / MINE / TRADE / CLIMB),
 *      utility taps, [👆 TAP] prompt re-glyphing, matchMedia mobile-compact
 *      breakpoint, desktop audio-unlock no-op.
 *   F. ClientApp mobile app (mobileProfile forced) — battery-saver scaling
 *      pin 1.5 on the live engine, profile switch persistence, first-touch
 *      audio-unlock banner + once-only gesture → audio.resume() wiring.
 *
 * Synthetic touch events carry an EXPLICIT `time` clock (the wall clock
 * barely advances between back-to-back injections, which would explode the
 * flick-velocity estimator), and every injection is followed by at least one
 * `app.update(t)` before sampling.
 */
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';

import { ClientApp } from '../src/client/ClientApp.ts';
import {
  HUD_MOBILE_BREAKPOINT_PX,
  HUD_MOBILE_COMPACT_CLASS,
  HUD_MOBILE_MEDIA_QUERY,
} from '../src/ui/LunarHUD.ts';
import {
  ACTION_BUTTON_MIN_PX,
  CONTEXT_BUTTON_PX,
  JUMP_BUTTON_PX,
  ROLL_BUTTON_PX,
  TOUCH_LOOK_PITCH_RAD_PER_PX,
  TOUCH_LOOK_YAW_RAD_PER_PX,
  TOUCH_ACTION_IDS,
  touchButtonDomId,
  TouchInputController,
  UTILITY_BUTTON_PX,
  type ActionHitRect,
  type TouchEventLike,
} from '../src/client/TouchInputController.ts';
import MobileSettingsNamespace from '../src/client/MobileSettings.ts';
import {
  COLLISION_IMPACT_INTERVAL_MS,
  COLLISION_IMPACT_MS,
  FOOTFALL_PULSE_MS,
  MINING_PULSE_INTERVAL_MS,
  MINING_PULSE_MS,
  RCS_BOOST_PATTERN,
  UI_TAP_PULSE_MS,
  TactileHaptics,
} from '../src/audio/TactileHaptics.ts';
import NetworkClient from '../src/network/NetworkClient.ts';

// ---------------------------------------------------------------------------
// Check bookkeeping (same idiom as the other smoke suites)
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

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

// ===========================================================================
// A. PWA & MOBILE APP SHELL — static asset / CSS analysis (Spec 33 §4.1/§4.5)
// ===========================================================================

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

section('A1. manifest.webmanifest schema (Spec 33 §2.1.1)');
interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  name: string;
  short_name: string;
  description?: string;
  id?: string;
  start_url: string;
  scope?: string;
  display: string;
  orientation: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}
let manifest: Manifest;
{
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(read('public/manifest.webmanifest'));
    check('manifest.webmanifest parses as strict JSON', true);
  } catch (err) {
    check('manifest.webmanifest parses as strict JSON', false, String(err));
  }
  manifest = parsed as Manifest;
  check('name is "Lunar Frontier"', manifest.name === 'Lunar Frontier');
  check('short_name is "LunarFrontier"', manifest.short_name === 'LunarFrontier');
  check('id is present', typeof manifest.id === 'string' && manifest.id.length > 0);
  check('display is standalone (Add-to-Home-Screen fullscreen)', manifest.display === 'standalone');
  check('orientation is landscape', manifest.orientation === 'landscape');
  check('theme_color #000000', manifest.theme_color === '#000000');
  check('background_color #000000', manifest.background_color === '#000000');
  check('start_url carries the ?pwa=1 launch marker', manifest.start_url.includes('pwa=1'));
  check('scope is the client root (./)', manifest.scope === './');
  check('two icons declared (192 + 512)', manifest.icons.length === 2);
  const sizes = manifest.icons.map((i) => i.sizes).sort().join(',');
  check('icon sizes are exactly 192x192 + 512x512', sizes === '192x192,512x512', sizes);
  check(
    'every icon is image/png',
    manifest.icons.every((i) => i.type === 'image/png'),
  );
  const purposes = manifest.icons.map((i) => i.purpose).sort().join('|');
  check(
    'purposes cover "any" and "any maskable"',
    purposes === 'any|any maskable',
    purposes,
  );
  check(
    'every declared icon file exists under public/',
    manifest.icons.every((i) => existsSync(path.resolve(ROOT, 'public', i.src))),
  );
}

section('A2. index.html mobile app-shell meta (Spec 33 §2.1.2)');
{
  const html = read('src/client/index.html');
  const viewportTag = /<meta[^>]*name="viewport"[^>]*content="([^"]*)"/s.exec(html);
  check('viewport meta tag present', viewportTag !== null);
  const content = viewportTag?.[1] ?? '';
  check('viewport locks pinch-zoom (user-scalable=no, maximum-scale=1.0)',
    content.includes('user-scalable=no') && content.includes('maximum-scale=1.0'));
  check('viewport feeds safe-area insets (viewport-fit=cover)', content.includes('viewport-fit=cover'));
  check('apple-mobile-web-app-capable = yes',
    /name="apple-mobile-web-app-capable"\s+content="yes"/.test(html));
  check('apple status bar style black-translucent',
    /name="apple-mobile-web-app-status-bar-style"\s+content="black-translucent"/.test(html));
  check('apple-mobile-web-app-title LunarFrontier',
    /name="apple-mobile-web-app-title"\s+content="LunarFrontier"/.test(html));
  check('apple-touch-icon link resolves to a real file under public/',
    /rel="apple-touch-icon"\s+href="([^"]+)"/.test(html) &&
      existsSync(path.resolve(ROOT, 'public',
        /rel="apple-touch-icon"\s+href="([^"]+)"/.exec(html)![1])));
  check('manifest link wired (Vite serves .webmanifest as application/manifest+json)',
    /rel="manifest"\s+href="[^"]*manifest\.webmanifest"/.test(html) &&
      existsSync(path.join(ROOT, 'public/manifest.webmanifest')));
  check('canvas keeps touch-action: none (no browser gesture theft)',
    /#scene\s*{[^}]*touch-action:\s*none/s.test(html));
  check('portrait orientation guard #orientation-guard mounted (alertdialog)',
    /id="orientation-guard"[^>]*role="alertdialog"/.test(html) &&
      html.includes('og-title') && html.includes('Rotate device to landscape'));
  check('audio unlock banner #audio-unlock mounted hidden',
    /id="audio-unlock"[\s\S]{0,160}class="audio-unlock-hint"/.test(html) &&
      /\bid="audio-unlock"[\s\S]{0,240}?hidden/.test(html));
}

section('A3. hud.css orientation guard, safe areas & breakpoints (Spec 33 §2.1.3 / §2.4)');
{
  const css = read('src/ui/hud.css');
  // Per-selector probes slice the FIRST rule body following the selector.
  const ruleOf = (selector: string, from = 0): string => {
    const i = css.indexOf(selector, from);
    if (i < 0) return '';
    const open = css.indexOf('{', i);
    const close = css.indexOf('}', open);
    return css.slice(open, close + 1).replace(/\s+/g, ' ');
  };
  const lastRuleOf = (selector: string): string => ruleOf(selector, css.lastIndexOf(selector));

  check('guard base rule hidden by default',
    /display:\s*none/.test(ruleOf('#orientation-guard')) &&
      /position:\s*fixed/.test(ruleOf('#orientation-guard')) &&
      /z-index:\s*9999/.test(ruleOf('#orientation-guard')));
  const portraitIdx = css.indexOf('@media (orientation: portrait)');
  const landscapeIdx = css.indexOf('@media (orientation: landscape)');
  const guardAt = css.indexOf('#orientation-guard {');
  check('portrait media query reveals the guard (display:flex !important)',
    portraitIdx >= 0 &&
      css.slice(portraitIdx, portraitIdx + 220).includes('#orientation-guard') &&
      /display:\s*flex !important/.test(css.slice(portraitIdx, portraitIdx + 220)));
  check('landscape media query force-hides the guard (gameplay restored)',
    landscapeIdx >= 0 &&
      css.slice(landscapeIdx, landscapeIdx + 220).includes('#orientation-guard') &&
      /display:\s*none !important/.test(css.slice(landscapeIdx, landscapeIdx + 220)));
  check('guard padding respects notch/home-indicator insets',
    /env\(safe-area-inset-top\)/.test(ruleOf('#orientation-guard')) &&
      /env\(safe-area-inset-bottom\)/.test(ruleOf('#orientation-guard')));
  void guardAt;

  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    check(`safe-area token --lf-safe-${side} defined from env()`,
      new RegExp(`--lf-safe-${side}:\\s*env\\(safe-area-inset-${side}, 0px\\)`).test(css));
  }
  const varUses = (css.match(/var\(--lf-safe-/g) ?? []).length;
  const envUses = (css.match(/env\(safe-area-inset-/g) ?? []).length;
  check(`safe-area insets consumed on fixed HUD anchors (${varUses} var() + ${envUses} env() uses)`,
    varUses >= 30 && envUses >= 12);
  check('touch action cluster anchors add safe-area to the 24px margin',
    /right:\s*calc\(24px \+ env\(safe-area-inset-right\)\)/.test(css) &&
      /bottom:\s*calc\(24px \+ env\(safe-area-inset-bottom\)\)/.test(css));

  check(`mobile breakpoint media block @media (max-width: ${HUD_MOBILE_BREAKPOINT_PX}px) present`,
    css.includes(`@media (max-width: ${HUD_MOBILE_BREAKPOINT_PX}px)`));
  check('landscape-refinement block present',
    css.includes(`@media (max-width: ${HUD_MOBILE_BREAKPOINT_PX}px) and (orientation: landscape)`));

  // Tap-target law inside the ≤960px block (last occurrence == override).
  check('mobile trade rows ≥ 48 px tall',
    /min-height:\s*48px/.test(lastRuleOf('.trade-row')));
  check('trade buy/sell buttons ≥ 44×44 px',
    /min-width:\s*44px/.test(lastRuleOf('.trade-button')) &&
      /min-height:\s*44px/.test(lastRuleOf('.trade-button')));
  check('trade close button ≥ 44×44 px',
    /min-width:\s*44px/.test(lastRuleOf('.trade-close')) &&
      /min-height:\s*44px/.test(lastRuleOf('.trade-close')));
  check('map close button ≥ 44 px tall', /min-height:\s*44px/.test(lastRuleOf('.hud-map-close')));
  check('audio mute button ≥ 44×44 px',
    /min-width:\s*44px/.test(lastRuleOf('.audio-mute-button')) &&
      /min-height:\s*44px/.test(lastRuleOf('.audio-mute-button')));
  check('trade sheet is a scroll-fit 92vw × 88vh modal with bottom inset',
    /width:\s*92vw/.test(lastRuleOf('#lunar-hud-trade {')) &&
      /max-height:\s*88vh/.test(lastRuleOf('#lunar-hud-trade {')) &&
      /var\(--lf-safe-bottom\)/.test(lastRuleOf('#lunar-hud-trade {')));
  check('topographic map console scrolls by touch',
    /overflow-y:\s*auto/.test(lastRuleOf('.hud-map-frame {')) &&
      /-webkit-overflow-scrolling:\s*touch/.test(lastRuleOf('.hud-map-frame {')));
  // The pill's safe-corner anchor lives in the portrait ≤960 block; the
  // landscape refinement re-opens `#lunar-hud-life {` later, so scan every
  // occurrence and require the anchors on any of them.
  const lifeRules: string[] = [];
  for (let i = css.indexOf('#lunar-hud-life {'); i >= 0; i = css.indexOf('#lunar-hud-life {', i + 1)) {
    lifeRules.push(ruleOf('#lunar-hud-life {', i));
  }
  check('life-support pill docks into the safe top-right corner on mobile',
    lifeRules.some((r) => /top:\s*calc\(8px \+ var\(--lf-safe-top\)\)/.test(r)) &&
      lifeRules.some((r) => /right:\s*calc\(8px \+ var\(--lf-safe-right\)\)/.test(r)));
  check('audio unlock pill is thumb-sized (≥48 px) with tap-highlight killed',
    /min-height:\s*48px/.test(ruleOf('.audio-unlock-hint')) &&
      /touch-action:\s*manipulation/.test(ruleOf('.audio-unlock-hint')));
}

// ===========================================================================
// Shared synthetic-touch plumbing
// ===========================================================================

const VIEW_W = 1280;
const VIEW_H = 800;

/** Explicit-clock synthetic single-finger touch event. */
function tev(id: number, x: number, y: number, time: number): TouchEventLike {
  return {
    touches: [],
    changedTouches: [{ identifier: id, clientX: x, clientY: y }],
    time,
  };
}

function rectOf(rects: ActionHitRect[], id: string): ActionHitRect {
  const r = rects.find((x) => x.id === id);
  assert.ok(r !== undefined, `missing rect for ${id}`);
  return r;
}

function centerOf(r: ActionHitRect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

// ===========================================================================
// B. TOUCH INPUT KINEMATICS — pure TouchInputController unit (Spec 33 §4.2)
// ===========================================================================

let clockMs = 1_000;

function makeController(visuals = false): TouchInputController {
  return new TouchInputController({
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    visuals,
    now: () => clockMs,
  });
}

section('B1. zone routing + floating dynamic origin');
{
  const c = makeController();
  check('bottom-left quadrant claims the movement stick', c.isInStickZone(300, 500));
  check('stick quadrant EXCLUDES the right look half', !c.isInStickZone(700, 300));
  check('right half claims the free-look trackpad', c.isInLookZone(700, 300));
  // x=550 sits in the dead band between 42 vw (537.6) and 45 vw (576).
  check('dead band between quadrants claims neither deck',
    !c.isInStickZone(550, 400) && !c.isInLookZone(550, 400));

  c.handleTouchStart(tev(1, 300, 500, 1_000));
  const g = c.getStickGeometry();
  check('floating origin anchors EXACTLY at first contact', g.originX === 300 && g.originY === 500);
  check('stick active while anchored', g.active === true);
  const fresh = makeController();
  const idle = fresh.peek();
  check('untouched stick reads exactly (0, 0)', idle.forward === 0 && idle.strafe === 0);
}

section('B2. deadzone clamp, rim clamp & normalized output law');
{
  const c = makeController();
  c.handleTouchStart(tev(1, 300, 500, 1_000));
  c.handleTouchMove(tev(1, 305, 495, 1_008)); // r = 7.07 < 8 px deadzone
  let s = c.peek();
  check('deflection inside the 8 px deadzone reads exactly 0.0',
    s.forward === 0 && s.strafe === 0);
  c.handleTouchMove(tev(1, 300, 489, 1_016)); // r = 11 → out of deadzone
  s = c.peek();
  check('screen-up drag yields POSITIVE forward demand', s.forward > 0);
  c.handleTouchMove(tev(1, 300, 300, 1_024)); // r = 200 → far past the 54 px rim
  s = c.peek();
  const g = c.getStickGeometry();
  check('rim clamp: raw radius 200 px normalizes to exactly 1.0', g.radiusPx === 200 && near(g.radiusNorm, 1));
  check('forward saturates at exactly +1.0, strafe 0', near(s.forward, 1) && near(s.strafe, 0));
  c.handleTouchMove(tev(1, 300, 700, 1_032)); // drag DOWN
  s = c.peek();
  check('screen-down drag saturates forward at exactly −1.0', near(s.forward, -1));

  // Diagonal directional preservation.
  const d = makeController();
  d.handleTouchStart(tev(2, 300, 500, 1_000));
  d.handleTouchMove(tev(2, 338, 462, 1_008)); // up-right diagonal, r ≈ 53.7
  const ds = d.peek();
  check('diagonal keeps direction (forward ≈ strafe ≈ 0.70)',
    ds.forward > 0.6 && ds.strafe > 0.6 && Math.abs(ds.forward - ds.strafe) < 0.02,
    `f=${ds.forward} s=${ds.strafe}`);
  check('poll() frame mirrors the live geometry', (() => {
    const p = d.poll();
    return near(p.forward, ds.forward) && near(p.strafe, ds.strafe);
  })());
}

section('B3. sprint latches (300 ms hold + outward double-flick)');
{
  const c = makeController();
  c.handleTouchStart(tev(1, 300, 500, 1_000));
  c.handleTouchMove(tev(1, 300, 446, 1_016)); // rim (r_norm = 1) — arms the timer
  check('rim hold NOT latched instantly (arms at t0)', c.peek().sprint === false);
  c.handleTouchMove(tev(1, 300, 447, 1_150)); // 134 ms at the rim
  check('still unarmed below the 300 ms hold window', c.peek().sprint === false);
  c.handleTouchMove(tev(1, 300, 446, 1_321)); // 305 ms at the rim
  check('r_norm ≥ 0.90 held ≥ 300 ms latches sprint', c.peek().sprint === true);
  c.handleTouchMove(tev(1, 300, 497, 1_340)); // thumb back to centre (< 0.3 norm)
  check('centre return releases the sprint latch', c.peek().sprint === false);
  c.handleTouchEnd(tev(1, 300, 497, 1_348));

  // Outward double-flick: two rim-crossing sweeps inside 400 ms.
  const d = makeController();
  d.handleTouchStart(tev(2, 300, 500, 2_000));
  d.handleTouchMove(tev(2, 300, 446, 2_016)); // flick #1 (norm jump 0 → 1)
  check('single flick does NOT latch', d.peek().sprint === false);
  d.handleTouchMove(tev(2, 300, 497, 2_060)); // back to centre
  d.handleTouchMove(tev(2, 300, 446, 2_100)); // flick #2 inside 400 ms of #1
  check('outward double-flick inside 400 ms latches sprint', d.peek().sprint === true);
  d.handleTouchEnd(tev(2, 300, 446, 2_108));
  check('lift clears sprint + stick', d.peek().sprint === false && d.getStickGeometry().active === false);
}

section('B4. free-look trackpad — differential yaw/pitch scaling');
{
  const c = makeController();
  c.handleTouchStart(tev(1, 700, 300, 1));
  c.handleTouchMove(tev(1, 800, 350, 17)); // right 100 px, DOWN 50 px
  const s = c.peek();
  check(`rightward drag scales by ${TOUCH_LOOK_YAW_RAD_PER_PX} rad/px`, near(s.yawDelta, 100 * TOUCH_LOOK_YAW_RAD_PER_PX, 1e-12));
  check(`downward drag INVERTS pitch (${TOUCH_LOOK_PITCH_RAD_PER_PX} rad/px)`,
    near(s.pitchDelta, -50 * TOUCH_LOOK_PITCH_RAD_PER_PX, 1e-12));
  const peeked = c.peek();
  check('peek() is non-consuming', near(peeked.yawDelta, s.yawDelta, 1e-12));
  const consumed = c.poll();
  check('poll() hands out the accumulated radians', near(consumed.yawDelta, s.yawDelta, 1e-12));
  const next = c.poll();
  check('poll() zeroes the accumulator', next.yawDelta === 0 && next.pitchDelta === 0);
  c.handleTouchEnd(tev(1, 800, 350, 25));
}

section('B5. release-flick inertial coast (exponential decay, τ = 120 ms)');
{
  const c = makeController();
  c.handleTouchStart(tev(1, 700, 300, 1));
  c.handleTouchMove(tev(1, 760, 300, 17)); // 3.75 px/ms → way over the 0.4 flick gate
  c.poll(); // drain the drag delta; only coast should remain
  c.handleTouchEnd(tev(1, 760, 300, 17));
  check('fast flick release keeps the deck alive on coast alone',
    c.isActive() === true && c.hasFingerDown() === false);

  c.update(16);
  const d1 = c.poll().yawDelta;
  c.update(16);
  const d2 = c.poll().yawDelta;
  const expectedRatio = Math.exp(-16 / 120);
  check('coast emits positive yaw each frame and decays exponentially (ratio ≈ e^−16/120)',
    d1 > 0 && d2 > 0 && Math.abs(d2 / d1 - expectedRatio) < 0.05,
    `d1=${d1} d2=${d2} ratio=${d2 / d1} expected≈${expectedRatio}`);

  let frames = 0;
  while (frames < 200 && c.isActive()) {
    c.update(16);
    c.poll();
    frames++;
  }
  check(`coast dies out to exactly zero (${frames} frames)`, c.isActive() === false && c.poll().yawDelta === 0);

  // Slow drag never arms the coast.
  const d = makeController();
  d.handleTouchStart(tev(2, 700, 300, 1));
  d.handleTouchMove(tev(2, 705, 300, 51)); // 100 px/s < 0.4 px/ms gate
  d.handleTouchEnd(tev(2, 705, 300, 51));
  d.poll();
  d.update(16);
  check('sub-threshold drag release coasts NOTHING', d.poll().yawDelta === 0 && d.isActive() === false);

  // A fresh grab kills an in-flight coast mid-flight.
  const e = makeController();
  e.handleTouchStart(tev(3, 700, 300, 1));
  e.handleTouchMove(tev(3, 760, 300, 17));
  e.poll();
  e.handleTouchEnd(tev(3, 760, 300, 17));
  e.update(16);
  const mid = e.poll().yawDelta;
  e.handleTouchStart(tev(4, 700, 300, 40));
  e.update(16);
  check('new look grab cancels the running coast', mid > 0 && e.poll().yawDelta === 0);
}

section('B6. damped-spring thumb return on release');
{
  const c = makeController();
  c.handleTouchStart(tev(1, 300, 500, 3_000));
  c.handleTouchMove(tev(1, 354, 500, 3_016)); // full right deflection
  c.handleTouchEnd(tev(1, 354, 500, 3_032));
  check('output zeroes instantly on lift (physics sees no ghost drag)',
    c.peek().forward === 0 && c.peek().strafe === 0);
  check('deck stays active right after lift (spring still settling)', c.isActive() === true);
  let ms = 3_048;
  let frames = 0;
  while (frames < 300 && c.isActive()) {
    c.update(16);
    frames++;
    ms += 16;
  }
  const settleMs = ms - 3_032;
  check(`spring damps home within 1.2 s (${settleMs} ms, ${frames} frames)`,
    c.isActive() === false && settleMs < 1_200);
  const before = c.peek();
  c.update(0);
  const after = c.peek();
  check('update(0) is a stable no-op', JSON.stringify(before) === JSON.stringify(after));
}

section('B7. action cluster geometry (≥ 52 px hit-target law) + isolation');
{
  const c = makeController();
  const rects = c.getActionHitRects();
  check('all five cluster buttons resolve hit rects', rects.length === TOUCH_ACTION_IDS.length);
  check('every hit target ≥ 52 px on both axes (≥ 44 px tap law with slop margin)',
    rects.every((r) => r.width >= ACTION_BUTTON_MIN_PX && r.height >= ACTION_BUTTON_MIN_PX));
  check('rect sizes mirror the exported JUMP/ROLL/CONTEXT/utility constants',
    rectOf(rects, 'jump').width === JUMP_BUTTON_PX &&
      rectOf(rects, 'roll').width === ROLL_BUTTON_PX &&
      rectOf(rects, 'action').width === CONTEXT_BUTTON_PX &&
      rectOf(rects, 'map').width === UTILITY_BUTTON_PX &&
      rectOf(rects, 'ui').width === UTILITY_BUTTON_PX);
  const a = rectOf(rects, 'action');
  check('smart ACTION sits in the bottom-right thumb zone',
    a.x + a.width > VIEW_W * 0.5 && a.y + a.height > VIEW_H * 0.5);
  check('hit-test resolves each button center + open field null',
    c.hitTestActionAt(...(Object.values(centerOf(rectOf(rects, 'jump')) ) as [number, number])) === 'jump' &&
      c.hitTestActionAt(...(Object.values(centerOf(rectOf(rects, 'roll'))) as [number, number])) === 'roll' &&
      c.hitTestActionAt(...(Object.values(centerOf(a)) as [number, number])) === 'action' &&
      c.hitTestActionAt(640, 400) === null);
  const ac = centerOf(a);
  check('6 px forgiveness slop widens the hit box', c.hitTestActionAt(a.x - 5, ac.y) === 'action');

  // Isolation: the smart button lives INSIDE the look zone; its finger must
  // never paint the camera.
  check('smart button center is inside the look zone (isolation matters)', c.isInLookZone(ac.x, ac.y));
  c.handleTouchStart(tev(1, ac.x, ac.y, 1_000));
  c.handleTouchMove(tev(1, ac.x - 140, ac.y - 90, 1_010));
  const st = c.peek();
  check('cluster finger produces ZERO look deltas', st.yawDelta === 0 && st.pitchDelta === 0);
  check('cluster finger never claims the movement stick', st.forward === 0 && st.strafe === 0);
  check('cluster finger keeps its own hold latch', st.isActive === true);
  c.handleTouchEnd(tev(1, ac.x - 140, ac.y - 90, 1_018));
  c.consumeActions();

  // Stick + jump co-ownership.
  const jc = centerOf(rectOf(rects, 'jump'));
  c.handleTouchStart(tev(2, 300, 500, 1_030));
  c.handleTouchStart(tev(3, jc.x, jc.y, 1_038));
  c.handleTouchMove(tev(2, 300, 440, 1_046));
  const both = c.peek();
  check('stick + JUMP coexist (forward > 0 while jump held)', both.forward > 0 && both.jump === true);
  c.handleTouchEnd(tev(2, 300, 440, 1_054));
  c.handleTouchEnd(tev(3, jc.x, jc.y, 1_062));
}

section('B8. hold channels, one-shot tap queue & contextual state');
{
  const c = makeController();
  const jc = centerOf(rectOf(c.getActionHitRects(), 'jump'));
  c.handleTouchStart(tev(1, jc.x, jc.y, 1_000));
  check('JUMP rides the live hold channel (peek + poll)', c.peek().jump === true && c.poll().jump === true);
  check('JUMP never enters the discrete tap queue', c.consumeActions().length === 0);
  c.handleTouchEnd(tev(1, jc.x, jc.y, 1_010));
  check('lift drops the JUMP latch (clean re-tap edge for RCS boost)', c.poll().jump === false);

  const mc = centerOf(rectOf(c.getActionHitRects(), 'map'));
  const uc = centerOf(rectOf(c.getActionHitRects(), 'ui'));
  c.handleTouchStart(tev(2, mc.x, mc.y, 1_020));
  c.handleTouchStart(tev(3, uc.x, uc.y, 1_028));
  const taps = c.consumeActions();
  check('utility taps queue once, in press order [map, ui]',
    taps.length === 2 && taps[0] === 'map' && taps[1] === 'ui');
  check('tap queue drains idempotently', c.consumeActions().length === 0);

  let activity = 0;
  const d = new TouchInputController({
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    visuals: false,
    now: () => clockMs,
    onTouchActivity: () => {
      activity++;
    },
  });
  d.setContextualAction({ label: 'MINE IRON ORE', icon: '⛏', active: true });
  const ctx = d.getContextualAction();
  check('setContextualAction round-trips label/icon/active',
    ctx !== null && ctx.label === 'MINE IRON ORE' && ctx.icon === '⛏' && ctx.active === true);
  d.setContextualAction(null);
  check('null parks the contextual button', d.getContextualAction() === null);
  d.setVisible(false);
  d.handleTouchStart(tev(4, jc.x, jc.y, 1_100));
  check('hidden deck swallows the tap but still fires the activity callback',
    d.peek().jump === false && d.consumeActions().length === 0 && activity === 1);
  d.handleTouchEnd(tev(4, jc.x, jc.y, 1_108));
  d.setVisible(true);
  d.handleTouchStart(tev(5, jc.x, jc.y, 1_116));
  check('re-illuminated deck latches again', d.peek().jump === true);
  d.handleTouchEnd(tev(5, jc.x, jc.y, 1_124));
  d.reset();
  check('reset drops every latch/claim/tap', d.isActive() === false && d.consumeActions().length === 0);
}

// ===========================================================================
// C. MOBILE PERFORMANCE PROFILES — pure maths + persistence (Spec 33 §4.6)
// ===========================================================================

const MS = MobileSettingsNamespace;

interface FakeStorage {
  getItem(item: string): string | null;
  setItem(item: string, value: string): void;
}

section('C1. profile specs, DPR clamping & hardware scaling maths');
{
  check('exactly three profiles: battery-saver / balanced / high-fidelity',
    MS.MOBILE_PERFORMANCE_PROFILES.join(',') === 'battery-saver,balanced,high-fidelity');
  check('default tier is Balanced', MS.DEFAULT_MOBILE_PROFILE === 'balanced');
  const bat = MS.MOBILE_PERFORMANCE_SPECS['battery-saver'];
  const bal = MS.MOBILE_PERFORMANCE_SPECS.balanced;
  const hifi = MS.MOBILE_PERFORMANCE_SPECS['high-fidelity'];
  check('battery-saver: DPR ≤ 1.0, 30 FPS, explicit 1.5 scaling pin',
    bat.maxDpr === 1.0 && bat.fpsTarget === 30 && bat.hardwareScalingPin === 1.5);
  check('balanced: DPR ≤ 1.5, 60 FPS, derived scaling', bal.maxDpr === 1.5 && bal.fpsTarget === 60 && bal.hardwareScalingPin === null);
  check('high-fidelity: DPR ≤ 2.0, 120 FPS, derived scaling', hifi.maxDpr === 2.0 && hifi.fpsTarget === 120 && hifi.hardwareScalingPin === null);

  check('flagship DPR 3.0 → balanced clamps to 1.5', MS.effectiveDpr('balanced', 3.0) === 1.5);
  check('flagship DPR 3.0 → battery-saver clamps to 1.0', MS.effectiveDpr('battery-saver', 3.0) === 1.0);
  check('flagship DPR 3.0 → high-fidelity clamps to 2.0', MS.effectiveDpr('high-fidelity', 3.0) === 2.0);
  check('native DPR under the cap passes through untouched', MS.effectiveDpr('high-fidelity', 1.0) === 1.0);
  check('non-finite/zero DPR degrades to 1.0', MS.effectiveDpr('balanced', 0) === 1 && MS.effectiveDpr('balanced', NaN) === 1);
  check('balanced scaling level = 1 / DPR_effective', MS.computeHardwareScalingLevel('balanced', 3.0) === 1 / 1.5);
  check('battery-saver PINS 1.5 regardless of native DPR', MS.computeHardwareScalingLevel('battery-saver', 3.0) === 1.5);
  check('frame gates: 30/60/120 Hz',
    MS.frameGateMs('battery-saver') === 1000 / 30 &&
      MS.frameGateMs('balanced') === 1000 / 60 &&
      MS.frameGateMs('high-fidelity') === 1000 / 120);
  check('isMobilePerformanceProfile narrows junk values out',
    MS.isMobilePerformanceProfile('balanced') === true &&
      MS.isMobilePerformanceProfile('ludicrous') === false &&
      MS.isMobilePerformanceProfile(42) === false);
  check('UA sniff: iPhone / Android mobile, X11 desktop, undefined safe',
    MS.isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)') &&
      MS.isMobileUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 9)') &&
      !MS.isMobileUserAgent('Mozilla/5.0 (X11; Linux x86_64)') &&
      !MS.isMobileUserAgent(undefined));
  check('headless Node reports NOT a mobile device', MS.isMobileDevice() === false);

  // applyHardwareScaling plumbing.
  const levels: number[] = [];
  const engine = { setHardwareScalingLevel: (l: number) => levels.push(l) };
  const forced = MS.applyHardwareScaling(engine, 'battery-saver', 3.0);
  check('forced profile applies: battery-saver @ DPR 3 → level 1.5, gate 30 Hz',
    forced.applied === true && forced.scalingLevel === 1.5 &&
      forced.effectiveDpr === 1.0 && forced.frameGateMs === 1000 / 30 &&
      levels.length === 1 && levels[0] === 1.5);
  const desktop = MS.applyHardwareScaling(engine, null, 2.0);
  check('desktop without a forced profile is a no-op (engine untouched)',
    desktop.applied === false && desktop.frameGateMs === 0 && levels.length === 1);

  // Storage-driven resolution (explicit wins over storage).
  const store = new Map<string, string>();
  (globalThis as { localStorage?: FakeStorage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
  store.set(MS.MOBILE_PROFILE_STORAGE, 'high-fidelity');
  const stored = MS.readMobileProfile();
  const resolved = MS.applyHardwareScaling(engine, 'battery-saver', 3.0);
  check('explicit override wins over the persisted profile',
    stored === 'high-fidelity' && resolved.profile === 'battery-saver');
  delete (globalThis as { localStorage?: FakeStorage }).localStorage;
}

section('C2. profile + haptics persistence in localStorage');
{
  const store = new Map<string, string>();
  (globalThis as { localStorage?: FakeStorage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
  check('no stored profile reads Balanced', MS.readMobileProfile() === 'balanced');
  MS.writeMobileProfile('battery-saver');
  check('writeMobileProfile persists to LF_MOBILE_PROFILE', store.get(MS.MOBILE_PROFILE_STORAGE) === 'battery-saver');
  check('profile reads back after write', MS.readMobileProfile() === 'battery-saver');
  store.set(MS.MOBILE_PROFILE_STORAGE, 'garbage');
  check('corrupt storage value degrades to the default, no throw', MS.readMobileProfile() === 'balanced');
  check('haptics default ON when nothing is stored', MS.readHapticsEnabled() === true);
  MS.writeHapticsEnabled(false);
  check('writeHapticsEnabled(false) persists "0" to LF_HAPTICS', store.get(MS.HAPTICS_STORAGE) === '0');
  check('haptics read-back honours the stored "0"', MS.readHapticsEnabled() === false);
  MS.writeHapticsEnabled(true);
  check('re-enabling haptics persists "1"', store.get(MS.HAPTICS_STORAGE) === '1' && MS.readHapticsEnabled() === true);

  // Hostile storage: getItem throwing must never kill the settings layer.
  (globalThis as { localStorage?: FakeStorage }).localStorage = {
    getItem: () => {
      throw new Error('SecurityError: storage disabled');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  let hostileOk = true;
  try {
    MS.writeMobileProfile('balanced');
    MS.writeHapticsEnabled(false);
    hostileOk = MS.readMobileProfile() === 'balanced' && MS.readHapticsEnabled() === true;
  } catch {
    hostileOk = false;
  }
  check('hostile/private-mode storage fails soft to defaults', hostileOk);
  delete (globalThis as { localStorage?: FakeStorage }).localStorage;
}

// ===========================================================================
// D. TACTILE HAPTICS — pulse patterns, throttles, safe no-ops (Spec 33 §4.6)
// ===========================================================================

section('D1. headless / iOS-Safari-style platforms: every pulse is a safe no-op');
{
  check('TactileHaptics.isSupported() false without navigator.vibrate',
    TactileHaptics.isSupported() === false);
  const h = new TactileHaptics();
  check('enabled by default', h.isEnabled() === true);
  check('footfall() no-ops false', h.footfall() === false);
  check('rcsBoost() no-ops false', h.rcsBoost() === false);
  check('miningPulse() no-ops false', h.miningPulse() === false);
  check('collisionImpact() no-ops false', h.collisionImpact() === false);
  let threw = false;
  try {
    h.setEnabled(false);
    h.setEnabled(true);
  } catch {
    threw = true;
  }
  check('setEnabled round-trip never throws headless', !threw);
}

section('D2. vibrator-backed platform: patterns, throttles & toggle');
{
  const realNav = (globalThis as { navigator?: unknown }).navigator;
  const vibLog: Array<number | readonly number[]> = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { vibrate: (pattern: number | readonly number[]) => vibLog.push(pattern) && true },
  });
  try {
    check('isSupported() true with navigator.vibrate', TactileHaptics.isSupported() === true);
    let ht = 10_000;
    const h = new TactileHaptics({ now: () => ht });

    check('footfall dispatches the 12 ms micro-tap', h.footfall() === true && vibLog.length === 1);
    assert.deepStrictEqual(vibLog[0], FOOTFALL_PULSE_MS);

    check('rcsBoost dispatches the crisp [15, 30, 20] double tap', h.rcsBoost() === true);
    assert.deepStrictEqual(vibLog[1], [...RCS_BOOST_PATTERN]);

    check('miningPulse: first latched pulse fires (25 ms)', h.miningPulse() === true);
    assert.deepStrictEqual(vibLog[2], MINING_PULSE_MS);
    check(`miningPulse throttled inside ${MINING_PULSE_INTERVAL_MS} ms`, h.miningPulse() === false);
    ht += MINING_PULSE_INTERVAL_MS + 10;
    check('miningPulse re-fires past the throttle window', h.miningPulse() === true);

    check('collisionImpact dispatches the heavy 60 ms thump', h.collisionImpact() === true);
    assert.deepStrictEqual(vibLog[vibLog.length - 1], COLLISION_IMPACT_MS);
    check(`collisionImpact throttled inside ${COLLISION_IMPACT_INTERVAL_MS} ms`, h.collisionImpact() === false);
    ht += COLLISION_IMPACT_INTERVAL_MS + 10;
    check('collisionImpact re-fires past its throttle', h.collisionImpact() === true);

    // Storage-backed toggle.
    const store = new Map<string, string>();
    (globalThis as { localStorage?: FakeStorage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    const before = vibLog.length;
    check('setEnabled(false) returns false-state AND cancels mid-pulse with vibrate(0)',
      h.setEnabled(false) === false && vibLog[vibLog.length - 1] === 0);
    const pulsesAfterDisable = h.footfall();
    check('disabled engine dispatches NO new pattern', pulsesAfterDisable === false && vibLog.length === before + 1);
    check('toggle persisted to LF_HAPTICS', store.get(MS.HAPTICS_STORAGE) === '0');
    check('constructor `enabled:false` option outranks persisted ON',
      new TactileHaptics({ enabled: false, now: () => ht }).footfall() === false);
    delete (globalThis as { localStorage?: FakeStorage }).localStorage;

    // Hostile vibrator that throws.
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        vibrate: () => {
          throw new Error('Vibration refused');
        },
      },
    });
    check('throwing vibrator degrades to false without killing the frame',
      new TactileHaptics({ now: () => ht }).footfall() === false);
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: realNav,
    });
  }
}

// ===========================================================================
// E/F. ClientApp INTEGRATION — fake DOM + NullEngine (Spec 33 §4.1–4.6)
// ===========================================================================

interface FakeElement {
  id: string;
  className: string;
  textContent: string | null;
  style: { [k: string]: string };
  classList: { add(n: string): void; remove(n: string): void; contains(n: string): boolean };
  children: FakeElement[];
  parent: FakeElement | null;
  appendChild<T extends FakeElement>(child: T): T;
  remove(): void;
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  removeAttribute(n: string): void;
}

interface FakeMediaQueryList {
  matches: boolean;
  addEventListener(type: string, listener: (ev: { matches: boolean }) => void): void;
  fire(matches: boolean): void;
}

function makeFakeEnvironment(): {
  document: FakeElement & {
    createElement(tag: string): FakeElement;
    getElementById(id: string): FakeElement | null;
    addEventListener(type: string, l: (ev: unknown) => void, opts?: { once?: boolean }): void;
    removeEventListener(type: string, l: (ev: unknown) => void): void;
    fire(type: string): void;
    listenerCount(type: string): number;
  };
  window: {
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    matchMedia(query: string): FakeMediaQueryList;
    lastQuery: string | null;
    mediaLists: FakeMediaQueryList[];
  };
  registry: Map<string, FakeElement>;
} {
  const registry = new Map<string, FakeElement>();

  const makeElement = (tag: string): FakeElement => {
    const classes = new Set<string>();
    const attributes = new Map<string, string>();
    let ownText = '';
    let idValue = '';
    const el: FakeElement = {
      get id(): string {
        return idValue;
      },
      set id(v: string) {
        idValue = v;
        registry.set(v, el);
      },
      className: tag,
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
        add: (n: string) => classes.add(n),
        remove: (n: string) => classes.delete(n),
        contains: (n: string) => classes.has(n),
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
          const i = el.parent.children.indexOf(el);
          if (i >= 0) el.parent.children.splice(i, 1);
          el.parent = null;
        }
        if (el.id.length > 0 && registry.get(el.id) === el) registry.delete(el.id);
      },
      getAttribute: (n: string) => attributes.get(n) ?? null,
      setAttribute(n: string, v: string) {
        attributes.set(n, v);
        if (n === 'id') el.id = v;
      },
      removeAttribute(n: string) {
        attributes.delete(n);
      },
    };
    if (tag === 'canvas') {
      (el as unknown as Record<string, unknown>)['getContext'] = () => null;
    }
    return el;
  };

  const docListeners = new Map<string, Array<{ fn: (ev: unknown) => void; once: boolean }>>();
  const doc = makeElement('body') as FakeElement & {
    createElement(tag: string): FakeElement;
    getElementById(id: string): FakeElement | null;
    listeners: Map<string, Array<(ev: unknown) => void>>;
    addEventListener(type: string, l: (ev: unknown) => void, opts?: { once?: boolean }): void;
    removeEventListener(type: string, l: (ev: unknown) => void): void;
    fire(type: string): void;
    listenerCount(type: string): number;
  };
  doc.createElement = makeElement;
  doc.getElementById = (id: string) => registry.get(id) ?? null;
  // The deck mounts visuals via `document.body` — our fake doc IS the body.
  (doc as unknown as { body: FakeElement }).body = doc;
  doc.addEventListener = (type, l, opts) => {
    const list = docListeners.get(type) ?? [];
    list.push({ fn: l, once: opts?.once === true });
    docListeners.set(type, list);
  };
  doc.removeEventListener = (type, l) => {
    const list = docListeners.get(type) ?? [];
    const i = list.findIndex((entry) => entry.fn === l);
    if (i >= 0) list.splice(i, 1);
  };
  doc.fire = (type: string) => {
    const list = docListeners.get(type) ?? [];
    const keep = list.filter((entry) => !entry.once);
    docListeners.set(type, keep);
    for (const entry of list) entry.fn({ type });
  };
  doc.listenerCount = (type: string) => (docListeners.get(type) ?? []).length;

  // index.html mounts the audio-unlock banner hidden — mirror that.
  const banner = makeElement('div');
  banner.id = 'audio-unlock';
  banner.className = 'audio-unlock-hint';
  banner.setAttribute('hidden', '');
  doc.appendChild(banner);

  const mediaLists: FakeMediaQueryList[] = [];
  const windowEvents: Array<{ type: string; fn: unknown }> = [];
  const fakeWindow = {
    innerWidth: VIEW_W,
    innerHeight: VIEW_H,
    devicePixelRatio: 1,
    lastQuery: null as string | null,
    mediaLists,
    windowEvents,
    addEventListener: (type: string, fn: unknown) => {
      windowEvents.push({ type, fn });
    },
    removeEventListener: (type: string, fn: unknown) => {
      const i = windowEvents.findIndex((e) => e.type === type && e.fn === fn);
      if (i >= 0) windowEvents.splice(i, 1);
    },
    matchMedia(query: string): FakeMediaQueryList {
      fakeWindow.lastQuery = query;
      const handlers: Array<(ev: { matches: boolean }) => void> = [];
      const mql: FakeMediaQueryList = {
        // Boot the HUD as a phone: the ≤960px query matches.
        matches: query === HUD_MOBILE_MEDIA_QUERY,
        addEventListener: (_type, listener) => {
          handlers.push(listener);
        },
        fire: (matches: boolean) => {
          mql.matches = matches;
          for (const h of handlers) h({ matches });
        },
      };
      mediaLists.push(mql);
      return mql;
    },
  };
  return { document: doc, window: fakeWindow, registry };
}

let netNowMs = 10_000;

function makeScriptedNetwork(): { net: NetworkClient; frames: Record<string, unknown>[] } {
  const frames: Record<string, unknown>[] = [];
  const net = new NetworkClient({
    url: 'ws://scripted.test/ws',
    socketFactory: () => {
      throw new Error('scripted network must never open a socket');
    },
    clock: () => netNowMs,
    heartbeatIntervalMs: 0,
    autoReconnect: false,
  });
  const internals = net as unknown as {
    socketState: string;
    sendFrame(frame: Record<string, unknown>): boolean;
  };
  internals.socketState = 'open';
  internals.sendFrame = (frame: Record<string, unknown>) => {
    frames.push(frame);
    return true;
  };
  return { net, frames };
}

let frameAt = 100_000;

const realNav = (globalThis as { navigator?: unknown }).navigator;

interface VibRecorder {
  log: Array<number | readonly number[]>;
  navigatorValue: {
    getGamepads(): unknown[];
    vibrate(pattern: number | readonly number[]): boolean;
  };
  pad: { axes: number[]; buttons: Array<{ value: number; pressed: boolean }> };
}

/** navigator fake: gamepad polling + a recording `vibrate` sink. */
function makeNavigatorWithPad(): VibRecorder {
  const log: Array<number | readonly number[]> = [];
  const pad = {
    axes: [0, 0, 0, 0, 0, 0],
    buttons: Array.from({ length: 12 }, () => ({ value: 0, pressed: false })),
  };
  return {
    log,
    pad,
    navigatorValue: {
      getGamepads: () => [null, pad],
      vibrate: (pattern: number | readonly number[]) => {
        log.push(pattern);
        return true;
      },
    },
  };
}

async function main(): Promise<void> {
  const env = makeFakeEnvironment();
  (globalThis as { document?: unknown }).document = env.document;
  (globalThis as { window?: unknown }).window = env.window;

  const vib = makeNavigatorWithPad();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: vib.navigatorValue,
  });

  const { net, frames } = makeScriptedNetwork();
  const deck = new TouchInputController({
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    visuals: true, // mount the glassmorphic cluster on the fake DOM
    now: () => clockMs,
  });
  const app = new ClientApp({
    seed: 'spec33-phase6-mobile-smoke',
    username: 'mobilesmoke',
    faction: 'ARTEMIS',
    network: net,
    moveIntervalMs: 50,
    silent: true,
    touchInput: deck,
  });
  await app.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));

  const step = (n: number): void => {
    for (let i = 0; i < n; i++) {
      clockMs += 16;
      frameAt += 16;
      app.update(frameAt);
      netNowMs += 16;
    }
  };
  step(2);

  section('E1. boot + DOM-mounted touch deck (Spec 33 §4.1)');
  check('ClientApp boots with the injected touch deck', app.isInitialized());
  check('deck visible at boot (touch not yet displaced)', deck.isVisible() === true);
  check('cluster + every button mounted on the DOM (Spec 34: #btn-touch-cam included)',
    env.registry.has('lf-touch-actions') &&
      TOUCH_ACTION_IDS.every((id) => env.registry.has(touchButtonDomId(id))));
  check('Spec 34 default boots behind the suit (eva_third_person)',
    app.world.getCameraRig().getMode() === 'eva_third_person');
  check('mobile audio-unlock stays hidden on non-mobile hosts (desktop no-op)',
    env.registry.get('audio-unlock')?.getAttribute('hidden') === '' &&
      app.attachMobileAudioUnlock() === false);

  section('E2. matchMedia mobile-compact breakpoint (Spec 33 §2.4 / §4.5)');
  {
    const hud = app.getHud();
    assert.ok(hud !== null);
    check('breakpoint constant + media query wire together',
      HUD_MOBILE_BREAKPOINT_PX === 960 && HUD_MOBILE_MEDIA_QUERY === '(max-width: 960px)');
    check('HUD bound matchMedia to the mobile query', env.window.lastQuery === HUD_MOBILE_MEDIA_QUERY);
    check('phone viewport boots the HUD in compact mode', hud.isMobileCompact() === true);
    const hudRoot = env.registry.get('lunar-hud');
    const tradeRoot = env.registry.get('lunar-hud-trade');
    check(`compact class mounted on #lunar-hud + #${HUD_TRADE_ID_HINT}`,
      hudRoot !== undefined && tradeRoot !== undefined &&
        hudRoot.classList.contains(HUD_MOBILE_COMPACT_CLASS) &&
        tradeRoot.classList.contains(HUD_MOBILE_COMPACT_CLASS));
    const mql = env.window.mediaLists[env.window.mediaLists.length - 1];
    mql.fire(false);
    check('widening past the breakpoint clears the compact class',
      hud.isMobileCompact() === false &&
        hudRoot?.classList.contains(HUD_MOBILE_COMPACT_CLASS) === false);
    mql.fire(true);
    check('narrowing again restores compact mode', hud.isMobileCompact() === true);
  }

  section('E3. tri-state dispatch keyboard → touch → gamepad → touch → keyboard (Spec 33 §4.4)');
  {
    check('idle boot source is keyboard', app.getInputSource() === 'keyboard');

    deck.handleTouchStart(tev(10, 700, 300, clockMs + 8));
    deck.handleTouchMove(tev(10, 760, 300, clockMs + 16));
    step(1);
    check('screen drag flips source to touch', app.getInputSource() === 'touch');
    deck.handleTouchEnd(tev(10, 760, 300, clockMs + 24));
    step(3);

    vib.pad.buttons[3]!.pressed = true;
    vib.pad.buttons[3]!.value = 1;
    step(4); // accumulator may need the frame after the pad flips the source
    check('pad button flips source to gamepad', app.getInputSource() === 'gamepad');
    const cluster = env.registry.get('lf-touch-actions');
    check('gamepad fades the on-screen deck (.is-gamepad-hidden)',
      deck.isVisible() === false && (cluster?.className ?? '').includes('is-gamepad-hidden'));
    vib.pad.buttons[3]!.pressed = false;
    vib.pad.buttons[3]!.value = 0;

    deck.handleTouchStart(tev(11, 700, 300, clockMs + 8));
    check('screen touch wins the deck back instantly', app.getInputSource() === 'touch');
    check('deck re-illuminates (class stripped)',
      deck.isVisible() === true && (cluster?.className ?? '').includes('is-gamepad-hidden') === false);
    deck.handleTouchEnd(tev(11, 700, 300, clockMs + 16));
    step(1);

    app.handleKeyInput('KeyW', 'down');
    step(1);
    check('keyboard press flips source back to keyboard', app.getInputSource() === 'keyboard');
    app.handleKeyInput('KeyW', 'up');
    step(1);
  }

  section('E4. [JUMP] touch: ground hop then airborne PLSS RCS boost (Spec 33 §4.3)');
  {
    const rects = deck.getActionHitRects();
    const jc = centerOf(rectOf(rects, 'jump'));

    const grounded = app.getSuit().getState().isGrounded;
    deck.handleTouchStart(tev(20, jc.x, jc.y, clockMs + 8));
    step(2);
    check('held JUMP lands as jump:true in ClientInputFrame', app.sampleInput().jump === true);
    const hop = app.getSuit().getState();
    check('ground hop left the regolith',
      grounded === true && (hop.isGrounded === false || (hop.vz ?? 0) > 0),
      `grounded=${grounded} vz=${hop.vz ?? 0}`);

    // Airborne re-press opens the PLSS valve (valve edge, keyboard-identical).
    const o2Before = app.getSuit().getOxygen();
    vib.log.length = 0;
    deck.handleTouchEnd(tev(20, jc.x, jc.y, clockMs + 8));
    step(1);
    check('JUMP unlatch clears the frame channel mid-air', app.sampleInput().jump === false);
    deck.handleTouchStart(tev(21, jc.x, jc.y, clockMs + 8));
    step(3);
    const rcs = app.getSuit().getState();
    check('airborne JUMP opens the PLSS RCS valve (rcsBoostActive)', rcs.rcsBoostActive === true);
    check('RCS ignition fired the crisp [15,30,20] haptic double tap',
      vib.log.some((p) => Array.isArray(p) && p.length === 3 &&
        p[0] === RCS_BOOST_PATTERN[0] && p[1] === RCS_BOOST_PATTERN[1] && p[2] === RCS_BOOST_PATTERN[2]),
      JSON.stringify(vib.log));
    step(2);
    const o2After = app.getSuit().getOxygen();
    check('RCS burn draws suit oxygen', o2After < o2Before, `o2 ${o2Before} → ${o2After}`);
    deck.handleTouchEnd(tev(21, jc.x, jc.y, clockMs + 8));
    step(10); // let the astronaut fall back to the regolith
    check('valve closes on the JUMP release (no free O₂ bleed mid-coast)',
      app.getSuit().getState().rcsBoostActive === false);
  }

  section('E5. [ROLL / TUCK] mid-air acrobatics (Spec 33 §4.3)');
  {
    const rects = deck.getActionHitRects();
    const jc = centerOf(rectOf(rects, 'jump'));
    const ro = centerOf(rectOf(rects, 'roll'));
    deck.handleTouchStart(tev(22, jc.x, jc.y, clockMs + 8));
    step(3);
    deck.handleTouchStart(tev(23, ro.x, ro.y, clockMs + 8));
    step(2);
    check('held ROLL lands as roll:true mid-flight (somersault/tuck channel)',
      app.sampleInput().roll === true);
    deck.handleTouchEnd(tev(23, ro.x, ro.y, clockMs + 8));
    deck.handleTouchEnd(tev(22, jc.x, jc.y, clockMs + 8));
    step(8);
  }

  section('E6. smart ACTION proximity: BOARD → DISMOUNT → MINE → TRADE (Spec 33 §4.3)');
  {
    const rects = deck.getActionHitRects();
    const ac = centerOf(rectOf(rects, 'action'));

    const buggyPos = app.getBuggy().getPosition();
    app.getSuit().teleport(buggyPos.x + 1.0, buggyPos.y + 0.5);
    step(2);
    const ctxBoard = deck.getContextualAction();
    check('rover proximity relabels the smart button 🚗 BOARD',
      ctxBoard !== null && ctxBoard.label === 'BOARD' && ctxBoard.active === true,
      JSON.stringify(ctxBoard));
    check('mode is on foot before the tap', app.getMode() === 'suit');
    deck.handleTouchStart(tev(30, ac.x, ac.y, clockMs + 8));
    step(1);
    check('smart tap boards the rover', app.getMode() === 'buggy');
    deck.handleTouchEnd(tev(30, ac.x, ac.y, clockMs + 8));
    step(2);
    check('driving relabels DISMOUNT',
      deck.getContextualAction()?.label === 'DISMOUNT');
    deck.handleTouchStart(tev(31, ac.x, ac.y, clockMs + 8));
    step(1);
    check('second smart tap dismounts back to the suit', app.getMode() === 'suit');
    deck.handleTouchEnd(tev(31, ac.x, ac.y, clockMs + 8));
    step(1);

    // MINE: walk onto the nav-directory vein and tap.
    const navVein = app.getNavVein();
    assert.ok(navVein !== null, 'world must expose at least one vein');
    app.getSuit().teleport(navVein.vein.center.x, navVein.vein.center.y);
    step(2);
    const ctxMine = deck.getContextualAction();
    check('vein proximity relabels the smart button ⛏ MINE <kind>',
      ctxMine !== null && ctxMine.label.startsWith('MINE') && ctxMine.active === true,
      JSON.stringify(ctxMine));
    const cargoBefore = app.getSuit().getCargoMass();
    const framesBefore = frames.length;
    deck.handleTouchStart(tev(32, ac.x, ac.y, clockMs + 8));
    step(1);
    deck.handleTouchEnd(tev(32, ac.x, ac.y, clockMs + 8));
    step(2);
    const minedFrames = frames.slice(framesBefore).filter((f) => f['type'] === 'MINE');
    const cargoAfter = app.getSuit().getCargoMass();
    check('smart tap at the vein fires the MINE action (frame + suit cargo)',
      minedFrames.length >= 1 && cargoAfter > cargoBefore,
      `frames=${JSON.stringify(frames.slice(framesBefore).map((f) => f['type']))} cargo ${cargoBefore}→${cargoAfter}`);

    // On plain regolith (rover out of reach) the MINE branch wins the chain.
    app.getSuit().teleport(navVein.vein.center.x + 500, navVein.vein.center.y + 500);
    step(2);
    check('regolith underfoot + rover out of reach → MINE outranks BOARD',
      deck.getContextualAction()?.label.startsWith('MINE') === true,
      JSON.stringify(deck.getContextualAction()));

    // TRADE promotion: on this map the regolith blanket keeps a vein inside
    // drill range at every surface coordinate, so the proximity chain's
    // final TRADE rung is exercised at the deck mirror level (ClientApp
    // paints it onto the very same button object every HUD frame).
    deck.setContextualAction({ label: 'TRADE', icon: '\u{1F4CA}', active: true });
    const ctxTrade = deck.getContextualAction();
    const tradeBtn = env.registry.get('btn-touch-action');
    check('smart button mirrors the 📊 TRADE promotion (label + active glow)',
      ctxTrade !== null && ctxTrade.label === 'TRADE' && ctxTrade.active === true &&
        tradeBtn !== undefined && tradeBtn.className.includes('is-active') &&
        tradeBtn.getAttribute('data-active') === '1');
    deck.setContextualAction(null);
  }

  section('E7. smart ACTION proximity: 🪜 CLIMB at the radio-tower ladder');
  {
    const rects = deck.getActionHitRects();
    const ac = centerOf(rectOf(rects, 'action'));
    const tower = app.world.buildRadioTower();
    const bounds = tower.getLadderBounds();
    app.getSuit().teleport(bounds.basePosition.x, bounds.basePosition.y);
    step(2);
    const ctxClimb = deck.getContextualAction();
    check('ladder-base proximity relabels the smart button 🪜 CLIMB',
      ctxClimb !== null && ctxClimb.label === 'CLIMB' && ctxClimb.active === true,
      JSON.stringify(ctxClimb));
    deck.handleTouchStart(tev(40, ac.x, ac.y, clockMs + 8));
    step(1);
    deck.handleTouchEnd(tev(40, ac.x, ac.y, clockMs + 8));
    step(2);
    check('CLIMB tap latches the ladder (suit on the rungs)',
      app.getSuit().getState().ladderLatchActive === true);
    check('latched state relabels the smart button RELEASE',
      deck.getContextualAction()?.label === 'RELEASE');
    deck.handleTouchStart(tev(41, ac.x, ac.y, clockMs + 8));
    step(1);
    deck.handleTouchEnd(tev(41, ac.x, ac.y, clockMs + 8));
    step(2);
    check('RELEASE tap drops the ladder latch',
      app.getSuit().getState().ladderLatchActive === false);
  }

  section('E8. utility taps + [👆 TAP …] HUD prompt re-glyphing (Spec 33 §4.4)');
  {
    const hud = app.getHud();
    assert.ok(hud !== null);
    const rects = deck.getActionHitRects();

    const mapWasVisible = hud.isMapVisible();
    const mc = centerOf(rectOf(rects, 'map'));
    deck.handleTouchStart(tev(50, mc.x, mc.y, clockMs + 8));
    step(1);
    check('MAP utility tap toggles the holographic overlay',
      hud.isMapVisible() !== mapWasVisible);
    deck.handleTouchEnd(tev(50, mc.x, mc.y, clockMs + 8));
    step(1);

    const modeBefore = hud.getHUDMode?.() ?? null;
    const uc = centerOf(rectOf(rects, 'ui'));
    deck.handleTouchStart(tev(51, uc.x, uc.y, clockMs + 8));
    step(1);
    check('UI utility tap cycles the HUD visibility mode',
      (hud.getHUDMode?.() ?? null) !== modeBefore);
    deck.handleTouchEnd(tev(51, uc.x, uc.y, clockMs + 8));
    step(1);
    deck.consumeActions();

    // Spec 34 §2.2: dedicated [🎥 VIEW] utility button — tap cycles the
    // camera perspective with a crisp 15 ms haptic confirmation tick.
    const camRect = rectOf(rects, 'camera');
    check('[🎥 VIEW] mounted at #btn-touch-cam with ≥ 44 px hit target',
      env.registry.get('btn-touch-cam') !== undefined &&
        camRect.width >= 44 && camRect.height >= 44);
    const camModeBefore = app.world.getCameraRig().getMode();
    vib.log.length = 0;
    const vc = centerOf(camRect);
    deck.handleTouchStart(tev(54, vc.x, vc.y, clockMs + 8));
    step(1);
    deck.handleTouchEnd(tev(54, vc.x, vc.y, clockMs + 8));
    step(1);
    const camModeAfter = app.world.getCameraRig().getMode();
    check('VIEW tap cycles the camera perspective',
      camModeAfter !== camModeBefore,
      `${camModeBefore} → ${camModeAfter}`);
    check('VIEW tap fires the crisp 15 ms haptic tick',
      vib.log.some((p) => p === UI_TAP_PULSE_MS), JSON.stringify(vib.log));
    deck.consumeActions();

    // Make touch the live device again and park at the rover for a prompt.
    deck.handleTouchStart(tev(52, 700, 300, clockMs + 8));
    deck.handleTouchMove(tev(52, 705, 300, clockMs + 16));
    step(1);
    deck.handleTouchEnd(tev(52, 705, 300, clockMs + 24));
    const buggyPos = app.getBuggy().getPosition();
    app.getSuit().teleport(buggyPos.x + 1.0, buggyPos.y + 0.5);
    step(2);
    check('HUD input source followed to touch', hud.getInputSource() === 'touch');
    const slot = env.registry.get('lunar-hud-prompt');
    check('prompt slot exists in the fake DOM', slot !== null);
    const promptText = (slot?.textContent ?? '') + (slot ? '' : '');
    const fullPrompt = collectText(slot);
    check('prompt re-glyphs to the tactile badge [👆] TAP …',
      fullPrompt.includes('\u{1F446}') && fullPrompt.includes('TAP'),
      `slot text = "${fullPrompt || promptText}"`);
  }

  section('F. forced mobile app: DPR scaling on the engine + first-touch audio unlock');
  {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: FakeStorage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };

    // Battery-saver on the LIVE engine (device DPR 1 headless; the 1.5 pin
    // renders BELOW canvas size — spec §2.5 "≈720p"). NullEngine discards
    // the scaling value internally, so the wiring is asserted on the
    // setHardwareScalingLevel call itself.
    const engineObj = app.world.getEngine() as unknown as {
      setHardwareScalingLevel(level: number): void;
    };
    const engineSpy: number[] = [];
    const origScaling = engineObj.setHardwareScalingLevel.bind(engineObj);
    engineObj.setHardwareScalingLevel = (level: number) => {
      engineSpy.push(level);
      origScaling(level);
    };
    const battery = app.applyMobilePerformance('battery-saver');
    assert.ok(battery !== null);
    check('battery-saver applies to the live engine',
      battery.applied === true && battery.profile === 'battery-saver');
    check('battery-saver PINS hardwareScalingLevel 1.5 onto the engine',
      battery.scalingLevel === 1.5 && engineSpy[engineSpy.length - 1] === 1.5,
      `spy = ${JSON.stringify(engineSpy)}`);
    check('battery-saver arms the 30 FPS render gate', battery.frameGateMs === 1000 / 30);

    const hifi = app.setMobilePerformanceProfile('high-fidelity');
    assert.ok(hifi !== null);
    check('profile switch: high-fidelity at DPR 1 → level 1.0 (native passes under the 2.0 cap)',
      hifi.profile === 'high-fidelity' && near(hifi.scalingLevel, 1.0) && near(hifi.effectiveDpr, 1.0) &&
        engineSpy[engineSpy.length - 1] === 1.0);
    check('switch persisted to localStorage (survives PWA relaunch)',
      store.get(MS.MOBILE_PROFILE_STORAGE) === 'high-fidelity');
    check('120 FPS gate armed for high-fidelity', hifi.frameGateMs === 1000 / 120);

    const back = app.setMobilePerformanceProfile('battery-saver');
    check('switch back re-pins 1.5 + persists',
      back !== null && back.scalingLevel === 1.5 &&
        store.get(MS.MOBILE_PROFILE_STORAGE) === 'battery-saver');
    delete (globalThis as { localStorage?: FakeStorage }).localStorage;

    // Second client instance launched AS a mobile app (mobileProfile set) —
    // its init reveals the audio-unlock banner and arms the first-touch
    // gesture that calls audio.resume().
    const env2 = makeFakeEnvironment();
    (globalThis as { document?: unknown }).document = env2.document;
    (globalThis as { window?: unknown }).window = env2.window;
    const net2 = makeScriptedNetwork();
    const app2 = new ClientApp({
      seed: 'spec33-phase6-mobile-app',
      username: 'phonepilot',
      faction: 'ARTEMIS',
      network: net2.net,
      moveIntervalMs: 50,
      silent: true,
      mobileProfile: 'battery-saver',
    });
    await app2.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));
    step(1);

    const banner2 = env2.registry.get('audio-unlock');
    check('mobile app reveals the "⏻ TAP TO ENGAGE" banner on boot',
      banner2 !== undefined && banner2.getAttribute('hidden') === null);
    check('once-only touchstart + pointerdown unlock listeners armed',
      env2.document.listenerCount('touchstart') >= 1 &&
        env2.document.listenerCount('pointerdown') >= 1);

    // Wire a resume spy in place of the audio system, then fire the gesture.
    let resumeCalls = 0;
    const audioLike = { resume: () => { resumeCalls += 1; return Promise.resolve(); } };
    const internals2 = app2 as unknown as { audio: unknown };
    const realAudio = internals2.audio;
    internals2.audio = audioLike;
    env2.document.fire('touchstart');
    check('first touch gesture calls audio.resume() exactly once', resumeCalls === 1);
    check('banner hides itself after the unlock gesture',
      banner2?.getAttribute('hidden') === '');
    check('touchstart unlock listener is once-only (dropped after firing)',
      env2.document.listenerCount('touchstart') === 0);
    // A real touch produces BOTH channels; each channel unlocks once.
    env2.document.fire('pointerdown');
    const afterBoth = resumeCalls;
    check('pointerdown channel unlocks once too (audio.resume is idempotent)',
      afterBoth === 2 && env2.document.listenerCount('pointerdown') === 0);
    env2.document.fire('touchstart');
    env2.document.fire('pointerdown');
    check('re-fired gestures hit no listeners (no duplicate resumes / rejections)',
      resumeCalls === afterBoth);
    internals2.audio = realAudio;

    const baselineTs = env2.document.listenerCount('touchstart');
    app2.dispose();
    check('dispose releases the unlock gesture listeners',
      env2.document.listenerCount('touchstart') < baselineTs || baselineTs === 0);
  }

  app.dispose();
  check('dispose tears the integration app down cleanly', true);

  // Restore globals.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: realNav,
  });
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;

  console.log(`\n${'='.repeat(58)}`);
  if (failures.length > 0) {
    console.error(`💥 smoke-mobile-client: ${failures.length} FAILURE(S):`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log(`🎉 smoke-mobile-client: ALL ${passed} CHECKS GREEN`);
}

/** Recursively concatenate an element subtree's textContent (fake DOM). */
function collectText(el: FakeElement | null | undefined): string {
  if (el === null || el === undefined) return '';
  return (el.textContent ?? '') + el.children.map((c) => collectText(c)).join('');
}

const HUD_TRADE_ID_HINT = 'lunar-hud-trade';

void main().catch((err: unknown) => {
  console.error('💥 smoke-mobile-client crashed:', err);
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
  process.exit(1);
});
