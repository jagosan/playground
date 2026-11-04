/**
 * Spec 32 Phase 4 probe — clockwise compass rectification + POI nav engine.
 *
 * Runs under `npx tsx scripts/smoke-spec32-nav.ts` (exit 0 == all green).
 * Verifies:
 *   1. NAV_POI_DIRECTORY exact coordinates (Spec 32 §2.6).
 *   2. setNavTarget / getNavTarget fuzzy matching, clear semantics,
 *      no-match rejection, and the `window.setNavTarget` dev hook.
 *   3. Clockwise azimuth: heading = wrap360(90 + θ) — a right (clockwise)
 *      turn strictly increases the reading (W→NW→N→NE→E), Spec 32 §2.4.
 *   4. targets.nav payload fed to the HUD while a POI target is armed
 *      (bearing wrap360(90 + θ), live distance in metres, guidance arrow).
 *   5. Gold `compass-pin-nav` chevron rendering + hide-on-clear in the HUD.
 */
import assert from 'node:assert';

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';

import { ClientApp, NAV_POI_DIRECTORY } from '../src/client/ClientApp.ts';
import LunarHUD from '../src/ui/LunarHUD.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  \u2714 ${label}`);
  } else {
    failures.push(label);
    console.error(`  \u2718 ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}

const wrap360 = (d: number): number => ((d % 360) + 360) % 360;

// ---------------------------------------------------------------------------
// Minimal fake DOM (same subset smoke-client-app.ts gives the HUD)
// ---------------------------------------------------------------------------

interface FakeEl {
  id: string;
  className: string;
  textContent: string | null;
  style: Record<string, string>;
  classList: { add(n: string): void; remove(n: string): void; contains(n: string): boolean };
  children: FakeEl[];
  parent: FakeEl | null;
  appendChild<T extends FakeEl>(c: T): T;
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  addEventListener(): void;
  text(): string;
}

function fakeEl(reg: Map<string, FakeEl>): FakeEl {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  let own = '';
  const el: FakeEl = {
    id: '',
    className: '',
    get textContent() {
      return own;
    },
    set textContent(v: string | null) {
      own = v ?? '';
      el.children.length = 0;
    },
    style: {},
    classList: {
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
      contains: (n) => classes.has(n),
    },
    children: [],
    parent: null,
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    getAttribute: (n) => attrs.get(n) ?? null,
    setAttribute(n, v) {
      attrs.set(n, v);
      if (n === 'id') {
        el.id = v;
        reg.set(v, el);
      }
    },
    addEventListener() {},
    text() {
      return own + el.children.map((c) => c.text()).join('');
    },
  };
  return el;
}

function fakeDoc(): { body: FakeEl; createElement: () => FakeEl; getElementById: (id: string) => FakeEl | null } {
  const reg = new Map<string, FakeEl>();
  const body = fakeEl(reg);
  return {
    body,
    createElement: () => fakeEl(reg),
    getElementById: (id: string) => reg.get(id) ?? null,
  };
}

type CapturedTargets = { heading: number; nav?: { name: string; bearing: number; dist: number; arrow?: string } };

// ===========================================================================
section('1. NAV_POI_DIRECTORY \u2014 exact coordinates (Spec 32 \u00a72.6)');
{
  const by = Object.fromEntries(NAV_POI_DIRECTORY.map((p) => [p.id, p]));
  check('citadel (-1850, 2400)', by['citadel']?.position.x === -1850 && by['citadel'].position.y === 2400);
  check('tower (-1550, 2320)', by['tower']?.position.x === -1550 && by['tower'].position.y === 2320);
  check('accelerator (-320, -1450)', by['accelerator']?.position.x === -320 && by['accelerator'].position.y === -1450);
  check('touchdown (0, 0)', by['touchdown']?.position.x === 0 && by['touchdown'].position.y === 0);
  check('outpost (-920, 1150)', by['outpost']?.position.x === -920 && by['outpost'].position.y === 1150);
  check('display names', by['citadel']?.name === 'X-Corp Citadel Monolith' &&
    by['tower']?.name === 'Frontier Radio Tower' &&
    by['accelerator']?.name === 'Mare Mass Accelerator' &&
    by['touchdown']?.name === 'Touchdown Alpha' &&
    by['outpost']?.name === 'Canyon Extraction Outpost');
}

// ===========================================================================
section('2. setNavTarget / getNavTarget \u2014 fuzzy match + clear semantics');
{
  const app = new ClientApp({ seed: 'spec32-probe', autoConnect: false, silent: true });
  const cases: Array<[string, string]> = [
    ['citadel', 'citadel'], ['corp', 'citadel'], ['hq', 'citadel'], ['x-corp', 'citadel'],
    ['X-Corp Citadel Monolith', 'citadel'],
    ['tower', 'tower'], ['radio', 'tower'], ['relay', 'tower'],
    ['mass accelerator', 'accelerator'], ['gauss', 'accelerator'], ['needle', 'accelerator'],
    ['landing', 'touchdown'], ['touchdown', 'touchdown'], ['lander', 'touchdown'],
    ['outpost', 'outpost'], ['canyon', 'outpost'], ['extraction', 'outpost'],
  ];
  let allMatch = true;
  for (const [q, want] of cases) {
    const ok = app.setNavTarget(q) && app.getNavTarget()?.id === want;
    if (!ok) {
      allMatch = false;
      console.error(`    \u2022 query "${q}" \u2192 got ${app.getNavTarget()?.id ?? 'null'}, want ${want}`);
    }
  }
  check('17 fuzzy queries resolve to the right POI', allMatch);

  check('getNavTarget shape {id,name,position}', (() => {
    app.setNavTarget('citadel');
    const t = app.getNavTarget();
    return t !== null && t.id === 'citadel' && t.name === 'X-Corp Citadel Monolith' &&
      t.position.x === -1850 && t.position.y === 2400;
  })());

  check('nonsense query refused (false, target kept)', (() => {
    app.setNavTarget('citadel');
    const refused = app.setNavTarget('zzz-no-such-place') === false;
    return refused && app.getNavTarget()?.id === 'citadel';
  })());

  for (const q of [null, '', '   ', 'clear', 'CLEAR']) {
    check(`clear via ${JSON.stringify(q)}`, app.setNavTarget(q) === true && app.getNavTarget() === null);
  }
}

section('2b. window.setNavTarget dev-console hook');
{
  const g = globalThis as unknown as { window?: Record<string, unknown> };
  g['window'] = {};
  try {
    const app = new ClientApp({ seed: 'spec32-probe-hook', autoConnect: false, silent: true });
    const hook = g['window']['setNavTarget'] as ((q: string | null) => boolean) | undefined;
    check('window.setNavTarget installed by constructor', typeof hook === 'function');
    check('hook selects + reflects via getNavTarget',
      hook?.('gauss') === true && app.getNavTarget()?.id === 'accelerator');
    check('hook clears with null', hook?.(null) === true && app.getNavTarget() === null);
  } finally {
    delete g['window'];
  }
}

// ===========================================================================
async function main(): Promise<void> {
  section('3+3b+4+4b. Clockwise azimuth + targets.nav payload (NullEngine e2e)');
  {
    const doc = fakeDoc();
    const hud = new LunarHUD({ document: doc as unknown as Document });
    const captured: CapturedTargets[] = [];
    const realUpdateCompass = hud.updateCompass.bind(hud);
    hud.updateCompass = (h: number, t: Parameters<LunarHUD['updateCompass']>[1] = {}): void => {
      captured.push({ heading: h, nav: t.nav });
      realUpdateCompass(h, t);
    };

    const app = new ClientApp({ seed: 'mala-voyage-2431', autoConnect: false, silent: true, hud });
    await app.init(new NullEngine() as never);

    const suit = app.getSuit();
    let now = 100_000;
    const step = (headingRad: number): CapturedTargets => {
      suit.setState({ heading: headingRad, vx: 0, vy: 0 });
      now += 100;
      app.update(now);
      return captured[captured.length - 1]!;
    };

    // \u03b8 = \u03c0 reads W(270\u00b0); right turns (\u03b8 increasing) step +45\u00b0 clockwise.
    const seq: Array<[number, number]> = [
      [Math.PI, 270],           // W
      [Math.PI + Math.PI / 4, 315], // NW
      [Math.PI + Math.PI / 2, 0],   // N (360 wraps to 0)
      [Math.PI + (3 * Math.PI) / 4, 45], // NE
      [Math.PI + Math.PI, 90],  // E
    ];
    const readings: number[] = [];
    for (const [theta, want] of seq) {
      const c = step(theta);
      readings.push(c.heading);
      const d = wrap360(c.heading - want + 180) - 180; // signed shortest offset
      check(`heading \u03b8=${((theta * 180) / Math.PI).toFixed(0)}\u00b0 reads ${want}\u00b0`,
        Math.abs(d) < 1e-6, `got ${c.heading}`);
    }
    let monotone = true;
    for (let i = 1; i < readings.length; i++) {
      if (Math.abs(wrap360(readings[i]! - readings[i - 1]!) - 45) > 1e-6) monotone = false;
    }
    check('right (clockwise) turn strictly increases heading +45\u00b0/step W\u2192NW\u2192N\u2192NE\u2192E', monotone);

    const readout = doc.getElementById('lunar-hud-compass-value')?.textContent ?? '';
    check('compass-value text reads 90\u00b0 E at East', readout.includes('90\u00b0') && readout.includes('E'), readout);

    // POI nav payload.
    check('setNavTarget("citadel") arms target', app.setNavTarget('citadel') === true);
    const p = suit.getPosition();
    const expectedBearing = wrap360(90 + (Math.atan2(2400 - p.y, -1850 - p.x) * 180) / Math.PI);
    const expectedDist = Math.hypot(-1850 - p.x, 2400 - p.y);
    const cNav = step(Math.PI); // face W, POI capture again
    check('targets.nav present while armed', cNav.nav !== undefined);
    check('targets.nav.bearing = wrap360(90 + \u03b8)',
      cNav.nav !== undefined && Math.abs(cNav.nav.bearing - expectedBearing) < 1e-6,
      cNav.nav === undefined ? 'missing' : `got ${cNav.nav.bearing}, want ${expectedBearing}`);
    check('targets.nav.dist = live metres',
      cNav.nav !== undefined && Math.abs(cNav.nav.dist - expectedDist) < 1e-6);
    check('guidance arrow is one of \u25c0 \u25b2 \u25b6',
      cNav.nav !== undefined && ['\u25c0', '\u25b2', '\u25b6'].includes(cNav.nav.arrow ?? ''));

    // HUD gold pin DOM.
    const pin = doc.getElementById('lunar-hud-compass-pin-nav');
    check('compass-pin-nav element exists', pin !== null);
    check('chevron glyph is \u25bc', pin !== null && pin.children[0]?.textContent === '\u25bc');
    check('gold pin visible while armed', pin !== null && !pin.classList.contains('is-hidden'));
    const pinText = pin?.text() ?? '';
    check('pin readout shows name + [Nm] distance',
      pinText.includes('Citadel') && pinText.includes(`[${Math.round(expectedDist)}m]`), pinText);

    // Clear hides the pin.
    app.setNavTarget('clear');
    const cCleared = step(Math.PI);
    check('targets.nav undefined after clear', cCleared.nav === undefined);
    check('gold pin hidden after clear', pin !== null && pin.classList.contains('is-hidden'));

    // Tick alignment: the tick you face sits dead-centre (left = 50%).
    realUpdateCompass(90, {});
    const tickE = doc.getElementById('hud-compass-tick-90');
    check('faced tick (90\u00b0) centred at 50%', tickE !== null &&
      Math.abs(Number((tickE.style['left'] ?? '').replace('%', '')) - 50) < 0.01,
      tickE === null ? 'missing' : `left=${tickE.style['left']}`);
    const tickW = doc.getElementById('hud-compass-tick-270');
    check('opposite tick (270\u00b0) faded out', tickW !== null && tickW.style['opacity'] === '0');
  }

  section('5. LunarHUD updateCompass nav contract (unit)');
  {
    const doc = fakeDoc();
    const hud = new LunarHUD({ document: doc as unknown as Document });
    const pin = doc.getElementById('lunar-hud-compass-pin-nav')!;
    hud.updateCompass(0, { nav: { name: 'Citadel', bearing: 0, dist: 2410, arrow: '\u25b2' } });
    const t = pin.text();
    check('nav readout renders "\u25b2 Citadel [2410m]" shape',
      !pin.classList.contains('is-hidden') && t.includes('Citadel') && t.includes('[2410m]'), t);
    hud.updateCompass(0, { nav: undefined });
    check('undefined nav hides pin', pin.classList.contains('is-hidden'));
    hud.updateCompass(45, { nav: { name: 'Radio Tower', bearing: 90, dist: 300, arrow: '\u25b6' } });
    const t2 = pin.text();
    check('relative-bearing arrow prefixed', t2.includes('\u25b6') && t2.includes('Radio Tower'), t2);
  }

  console.log('\n' + '='.repeat(58));
  if (failures.length > 0) {
    console.error(`\u{1f6d1} smoke-spec32-nav: ${failures.length}/${passed + failures.length} FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\u{1f389} smoke-spec32-nav: ALL ${passed} CHECKS GREEN`);
  }
}

void main().catch((err: unknown) => {
  console.error('\ud83d\udca5 smoke-spec32-nav crashed:', err);
  process.exit(1);
});
