/**
 * Spec 30 Phase 6 — EVA Locomotion / Stormtrooper Suit / UI-Cleanup headless
 * smoke verification suite (TASK-PLAY-077f).
 *
 * Runs under `npx tsx scripts/smoke-eva-cleanup.ts` (exit 0 == all green) on
 * `NullEngine` with a mini fake DOM + scripted gamepads. No browser, no
 * sockets. Validates all five Spec 30 §4 acceptance gates:
 *
 *   Gate 1 — Stormtrooper Armor Silhouette & Materials (§2.1): ≥ 32 mesh
 *            parts (pectoral carapace, 4-tier abdominal cuirass, utility
 *            belt + codpiece, pauldrons, vambraces, thigh cuirasses, knee
 *            cops, greaves, heavy boots), pauldron outer span ≥ 0.48 m, and
 *            the exact two-tone high-contrast PBR palette (armor-white over
 *            undersuit-gasket, trim-hardware, visor-gold).
 *   Gate 2 — Mistborn Steelpush Alternating Locomotion (§2.2): alternating
 *            left ↔ right stride cycle at sprint throttle, launch impulse
 *            vz ≥ 1.50 m/s, forward step boost ≥ 0.8 m/s, single-leg
 *            hangtime ≥ 0.85 s, ballistic apex ≥ 0.60 m, touchdown
 *            restitution ≥ 88 %, and the 0.08 m brace compression window.
 *   Gate 3 — Kinetic Articulation & Alternating Dust Puffs (§2.2.3): pushing
 *            leg hip aft ≤ −0.40 rad-equivalent, leading leg hip forward +
 *            flexed knee, arm sprint opposition, torso 7° lean / 1.5° roll,
 *            and boot-dust puffs dispatched sequentially at alternating
 *            left/right sole coordinates (± d_hip perpendicular to heading).
 *   Gate 4 — Clean UI & HUD Toggle System (§2.3): [U]/[H] tri-state cycle,
 *            double-tap R3 (350 ms) and long-press View (≥ 0.5 s) lanes,
 *            pointer-lock immunity, hidden-mode opacity/pointer-events rules,
 *            Escape demoted to modal-only dismissal, and localStorage
 *            persistence with boot-time restore.
 *   Gate 5 — Automated Verification & Build: this suite exits 0 with every
 *            check green, the `smoke:eva-cleanup` npm script is registered,
 *            and the production `npm run build` gate runs separately.
 *
 * Mesh-pivot sign law note: positive `rotation.x` swings a hanging limb AFT
 * (Spec 30 quotes the opposite convention), so "hip aft 0.55 rad" asserts as
 * `hip ≥ +0.40` and "hip forward 0.48 rad" as `hip ≤ −0.35` in this file.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

import {
  BOOT_DUST_HIP_OFFSET_M,
  EvaSuitAvatar,
  GEO,
  HURRY_ARM_RECOVERY_AFT_RAD,
  HURRY_ARM_STANCE_FWD_RAD,
  HURRY_LEAD_HIP_FWD_RAD,
  HURRY_LEAD_KNEE_RAD,
  HURRY_PUSH_HIP_AFT_RAD,
  HURRY_PUSH_KNEE_RAD,
  HURRY_TORSO_PITCH_FWD_RAD,
  HURRY_TORSO_ROLL_RAD,
  hurryStridePose,
} from '../src/entities/AstronautSuit.ts';
import {
  IDLE_SUIT_INPUT,
  LUNAR_GRAVITY,
  LunarEvaSuit,
  SUIT_HURRY_BRACE_COMPRESSION_M,
  SUIT_HURRY_BRACE_DURATION_S,
  SUIT_HURRY_LAUNCH_VZ,
  SUIT_HURRY_MIN_SPEED,
  SUIT_HURRY_RESTITUTION,
  SUIT_HURRY_STEP_BOOST,
  SUIT_HURRY_TARGET_SPEED,
} from '../src/physics/TraversalPhysics.ts';
import type { SuitState } from '../src/physics/TraversalPhysics.ts';
import {
  ClientApp,
  GAMEPAD_BUTTONS,
  GAMEPAD_HUD_DOUBLE_TAP_MS,
  GAMEPAD_HUD_VIEW_HOLD_MS,
} from '../src/client/ClientApp.ts';
import type { GamepadLike } from '../src/client/ClientApp.ts';
import {
  HUD_MODES,
  HUD_MODE_STORAGE_KEY,
  HUD_MODE_TOAST_ID,
  HUD_MODE_TOAST_MS,
  HUD_MODE_TOAST_TEXT,
  HUD_ROOT_ID,
  isHudMode,
} from '../src/ui/LunarHUD.ts';
import type { HUDMode } from '../src/ui/LunarHUD.ts';

// ---------------------------------------------------------------------------
// Bookkeeping
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

const HERE = typeof __filename !== 'undefined' ? dirname(__filename) : process.cwd();
const DT = 1 / 60;
const FLAT = () => 0;
const SPRINT = { ...IDLE_SUIT_INPUT, forward: 1.0, sprint: true };

/** Signed forward (+) / lateral-projected component of a state velocity. */
const alongOf = (s: SuitState): number =>
  s.vx * Math.cos(s.heading ?? 0) + s.vy * Math.sin(s.heading ?? 0);
const horizOf = (s: SuitState): number => Math.hypot(s.vx, s.vy);

// ---------------------------------------------------------------------------
// In-memory Storage + mini fake DOM (smoke-ftue-eva-controls precedent; the
// document additionally counts exitPointerLock calls for the Gate 4 probe)
// ---------------------------------------------------------------------------

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

interface FakeElement {
  id: string;
  className: string;
  textContent: string | null;
  style: Record<string, string>;
  classList: { add(n: string): void; remove(n: string): void; contains(n: string): boolean };
  children: FakeElement[];
  parent: FakeElement | null;
  attributes: Map<string, string>;
  appendChild<T>(child: T): T;
  remove(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  const make = (): FakeElement => {
    const attributes = new Map<string, string>();
    const children: FakeElement[] = [];
    const el: FakeElement = {
      id: '',
      className: '',
      textContent: null,
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
      appendChild(child) {
        (child as FakeElement).parent = el;
        children.push(child as FakeElement);
        return child;
      },
      remove() {
        if (el.parent !== null) {
          const i = el.parent.children.indexOf(el);
          if (i >= 0) el.parent.children.splice(i, 1);
        }
        registry.delete(el.id);
      },
      getAttribute: (n) => attributes.get(n) ?? null,
      setAttribute(n, v) {
        attributes.set(n, v);
        if (n === 'id') {
          el.id = v;
          registry.set(v, el);
        }
      },
      addEventListener() {},
      removeEventListener() {},
    };
    return el;
  };
  const doc: {
    body: FakeElement;
    createElement: () => FakeElement;
    getElementById: (id: string) => FakeElement | null;
    addEventListener: (type: string, listener: (event: unknown) => void) => void;
    removeEventListener: () => void;
    exitPointerLockCalls: number;
    exitPointerLock: () => void;
  } = {
    body: make(),
    createElement: () => make(),
    getElementById: (id) => registry.get(id) ?? null,
    addEventListener() {},
    removeEventListener() {},
    exitPointerLockCalls: 0,
    exitPointerLock() {
      doc.exitPointerLockCalls++;
    },
  };
  return doc;
}

function makePad(buttons: Record<number, boolean>): GamepadLike {
  return {
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 14 }, (_, i) => ({
      value: buttons[i] ? 1 : 0,
      pressed: buttons[i] === true,
    })),
  };
}

// ===========================================================================
// GATE 1 — Stormtrooper Armor Silhouette & Materials (Spec 30 §2.1 / §4)
// ===========================================================================

function gate1Armor(): void {
  section('GATE 1 — Stormtrooper armor silhouette & two-tone PBR materials (§2.1)');

  const avatar = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } });
  avatar.init(); // self-owned NullEngine fallback
  check('EvaSuitAvatar builds headless (NullEngine)', avatar.isBuilt() === true);

  const meshes = avatar.getMeshes();
  const byName = (n: string): Mesh | undefined => meshes.find((m) => m.name === `eva-${n}`);

  // Gate: total mesh parts ≥ 32 (the Spec 30 composite build is exactly 56).
  check(`mesh parts ${meshes.length} ≥ 32 gate (Spec 30 build = 56)`,
    meshes.length >= 32 && meshes.length === 56, `got ${meshes.length}`);
  check('all meshes named eva-*', meshes.every((m) => m.name.startsWith('eva-')));

  // Distinct armor families from the gate text.
  check('pectoral carapace 0.38 × 0.32 × 0.16 + sternum relief + chiseled facets',
    GEO.pectoralPlate.width === 0.38 && GEO.pectoralPlate.height === 0.32 && GEO.pectoralPlate.depth === 0.16
    && byName('chest-carapace') !== undefined && byName('sternum-plate') !== undefined
    && byName('chest-facet-l') !== undefined && byName('chest-facet-r') !== undefined);
  check('segmented abdominal rib bands: 4 tiers tapering 0.32 → waist 0.28',
    GEO.abdominalRibs.tiers === 4 && GEO.abdominalRibs.width === 0.32
    && GEO.abdominalRibs.waistWidth === 0.28 && GEO.abdominalRibs.height === 0.22
    && [1, 2, 3, 4].every((i) => byName(`abdomen-rib-${i}`) !== undefined));
  check('utility belt h 0.08 d 0.32 + buckle + codpiece + twin O2 canisters r 0.045 h 0.14',
    GEO.utilityBelt.height === 0.08 && GEO.utilityBelt.depth === 0.32
    && byName('belt-buckle') !== undefined && byName('codpiece') !== undefined
    && GEO.beltCanister.radius === 0.045 && GEO.beltCanister.height === 0.14
    && byName('belt-canister-l') !== undefined && byName('belt-canister-r') !== undefined);
  check('pauldron bells r 0.09 h 0.14 flared 15° on 0.52 m shoulder stance',
    GEO.arm.pauldron.radius === 0.09 && GEO.arm.pauldron.height === 0.14 && GEO.arm.pauldron.flareDeg === 15
    && byName('pauldron-l') !== undefined && byName('pauldron-r') !== undefined);
  check('vambraces r 0.075, bicep cuffs r 0.08, gauntlet cuffs d 0.14 + gloves',
    GEO.arm.vambraceRadius === 0.075 && GEO.arm.bicepRadius === 0.08 && GEO.arm.cuffDiameter === 0.14
    && ['bicep', 'vambrace', 'cuff', 'glove'].every((p) => byName(`arm-${p}-l`) !== undefined
      && byName(`arm-${p}-r`) !== undefined));
  check('thigh cuirasses r 0.115 h 0.34 + knee cops 0.14 × 0.12 × 0.12 w/ strike plates',
    GEO.leg.thighRadius === 0.115 && GEO.leg.thighHeight === 0.34
    && GEO.leg.kneeCop.width === 0.14 && GEO.leg.kneeCop.height === 0.12 && GEO.leg.kneeCop.depth === 0.12
    && ['leg-thigh-l', 'leg-kneecop-l', 'leg-strikeplate-l',
      'leg-thigh-r', 'leg-kneecop-r', 'leg-strikeplate-r'].every((n) => byName(n) !== undefined));
  check('greaves r 0.10 h 0.26 + heavy boots 0.14 × 0.11 × 0.26, widened soles + heel spurs',
    GEO.leg.greaveRadius === 0.1 && GEO.leg.greaveHeight === 0.26
    && GEO.leg.boot.width === 0.14 && GEO.leg.boot.height === 0.11 && GEO.leg.boot.depth === 0.26
    && ['leg-greave-l', 'leg-boot-l', 'leg-sole-l', 'leg-spur-l',
      'leg-greave-r', 'leg-boot-r', 'leg-sole-r', 'leg-spur-r'].every((n) => byName(n) !== undefined));
  check('helmet d 0.38 w/ 5° raked brow, chin aerators r 0.035 l 0.06, vocoder grille, gold visor 0.34 × 0.22',
    GEO.helmet.diameter === 0.38 && GEO.helmet.browRakeDeg === 5
    && GEO.chinAerator.radius === 0.035 && GEO.chinAerator.length === 0.06
    && byName('helmet-brow') !== undefined && byName('helmet-aerator-l') !== undefined
    && byName('helmet-aerator-r') !== undefined && byName('helmet-vocoder') !== undefined
    && GEO.visor.width === 0.34 && GEO.visor.height === 0.22 && byName('visor') !== undefined);
  check('PLSS cowling retains twin cryo-cylinders r 0.085 h 0.50 + radiator cowl + nozzles',
    byName('plss-pack') !== undefined && GEO.plss.tank.radius === 0.085 && GEO.plss.tank.height === 0.5
    && byName('plss-tank-l') !== undefined && byName('plss-tank-r') !== undefined
    && byName('plss-radiator-cowl') !== undefined && byName('plss-nozzle-l') !== undefined
    && byName('plss-nozzle-r') !== undefined);

  // Shoulder-bell silhouette gate: measure the pairwise horizontal distance
  // of the two pauldron bells (heading-agnostic — the root yaws to PI/2+h,
  // so a world-X delta would read a false zero at heading 0). Force-compute
  // cascades to parents under NullEngine.
  {
    const pl = byName('pauldron-l')!;
    const pr = byName('pauldron-r')!;
    pl.computeWorldMatrix(true);
    pr.computeWorldMatrix(true);
    const al = pl.getAbsolutePosition();
    const ar = pr.getAbsolutePosition();
    const span = Math.hypot(ar.x - al.x, ar.z - al.z) + 2 * GEO.arm.pauldron.radius;
    check(`pauldron outer silhouette span ${span.toFixed(3)} m ≥ 0.48 m gate`, span >= 0.48);
  }

  // Two-tone high-contrast PBR palette — exact §2.1.4 values.
  const scene = avatar.getScene()!;
  const mat = (n: string): PBRMaterial | null => scene.getMaterialByName(n) as PBRMaterial | null;
  const armorWhite = mat('eva-armor-white');
  const gasket = mat('eva-undersuit-gasket');
  const trim = mat('eva-trim-hardware');
  const gold = mat('eva-visor-gold');
  const c3 = (v: { r: number; g: number; b: number }, r: number, g: number, b: number): boolean =>
    Math.abs(v.r - r) < 1e-6 && Math.abs(v.g - g) < 1e-6 && Math.abs(v.b - b) < 1e-6;
  check('armor-white: albedo (0.95,0.95,0.96), metallic 0.08, roughness 0.22',
    armorWhite !== null && c3(armorWhite.albedoColor, 0.95, 0.95, 0.96)
    && Math.abs(armorWhite.metallic! - 0.08) < 1e-9 && Math.abs(armorWhite.roughness! - 0.22) < 1e-9);
  check('undersuit-gasket: albedo (0.12,0.12,0.14), metallic 0.02, roughness 0.85',
    gasket !== null && c3(gasket.albedoColor, 0.12, 0.12, 0.14)
    && Math.abs(gasket.metallic! - 0.02) < 1e-9 && Math.abs(gasket.roughness! - 0.85) < 1e-9);
  check('trim-hardware: albedo (0.22,0.23,0.25), metallic 0.80, roughness 0.35',
    trim !== null && c3(trim.albedoColor, 0.22, 0.23, 0.25)
    && Math.abs(trim.metallic! - 0.8) < 1e-9 && Math.abs(trim.roughness! - 0.35) < 1e-9);
  check('visor-gold: albedo (0.96,0.80,0.28), metallic 0.98, roughness 0.06, emissive (0.12,0.08,0.02)',
    gold !== null && c3(gold.albedoColor, 0.96, 0.8, 0.28)
    && Math.abs(gold.metallic! - 0.98) < 1e-9 && Math.abs(gold.roughness! - 0.06) < 1e-9
    && c3(gold.emissiveColor, 0.12, 0.08, 0.02));
  check('two-tone binding: carapace/bell/boot = armor-white, core/ribs = gasket, sole = trim, visor = gold',
    byName('chest-carapace')!.material?.name === 'eva-armor-white'
    && byName('pauldron-l')!.material?.name === 'eva-armor-white'
    && byName('leg-boot-l')!.material?.name === 'eva-armor-white'
    && byName('torso')!.material?.name === 'eva-undersuit-gasket'
    && byName('abdomen-rib-1')!.material?.name === 'eva-undersuit-gasket'
    && byName('leg-sole-l')!.material?.name === 'eva-trim-hardware'
    && byName('visor')!.material?.name === 'eva-visor-gold',
    `carapace=${byName('chest-carapace')!.material?.name}`);

  avatar.dispose();
}

// ===========================================================================
// GATE 2 — Mistborn Steelpush Alternating Locomotion (Spec 30 §2.2 / §4)
// ===========================================================================

function gate2Locomotion(): void {
  section('GATE 2 — Mistborn Steelpush alternating locomotion (§2.2)');

  // §2.2.1 kinematic constants — exact.
  check('SUIT_HURRY constants: MIN 1.8, TARGET 5.2, LAUNCH_VZ 1.55, BOOST 1.0',
    SUIT_HURRY_MIN_SPEED === 1.8 && SUIT_HURRY_TARGET_SPEED === 5.2
    && SUIT_HURRY_LAUNCH_VZ === 1.55 && SUIT_HURRY_STEP_BOOST === 1.0);
  check('SUIT_HURRY constants: RESTITUTION 0.90, BRACE_COMPRESSION 0.08 m, BRACE 0.12 s',
    SUIT_HURRY_RESTITUTION === 0.9 && SUIT_HURRY_BRACE_COMPRESSION_M === 0.08
    && SUIT_HURRY_BRACE_DURATION_S === 0.12);

  // Non-throttle control: forward 0.4 (≤ 0.6 walk band, no sprint) never
  // erupts into the bounding stride.
  {
    const walker = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true });
    let boundingFrames = 0;
    for (let i = 0; i < 300; i++) {
      const s = walker.step(DT, { ...IDLE_SUIT_INPUT, forward: 0.4 }, FLAT);
      if (s.gaitMode === 'bounding') boundingFrames++;
    }
    check('non-sprint shuffle (forward 0.4) never triggers bounding', boundingFrames === 0);
  }

  // Sustained sprint run on the bare physics oracle.
  const suit = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true });
  const S: SuitState[] = [];
  for (let i = 0; i < 1440; i++) S.push({ ...suit.step(DT, SPRINT, FLAT) });

  // Launch frames: grounded → airborne edges inside the bounding gait.
  const launches: number[] = [];
  const touchdowns: number[] = [];
  for (let i = 1; i < S.length; i++) {
    const edge = S[i - 1].isGrounded !== S[i].isGrounded;
    if (!edge || S[i].gaitMode !== 'bounding') continue;
    if (!S[i].isGrounded) launches.push(i);
    else touchdowns.push(i);
  }
  check(`≥ 4 Steelpush launches in 24 s sprint (${launches.length} launches)`, launches.length >= 4);
  // A launch still airborne when the 24 s window closes has no touchdown in
  // range — drop that trailing half-episode so edge sets stay paired.
  if (!S[S.length - 1].isGrounded && launches.length > touchdowns.length) launches.pop();
  check(`touchdown count matches launch count (${launches.length})`,
    launches.length === touchdowns.length && launches.length >= 4,
    `td=${touchdowns.length} vs launch=${launches.length}`);

  // Alternating left ↔ right stride cycle (hurryStrideLeg flips each launch).
  {
    const seq = launches.map((i) => S[i].hurryStrideLeg);
    let alternating = seq.length >= 4;
    for (let k = 1; k < seq.length; k++) alternating = alternating && seq[k] !== seq[k - 1];
    check(`stride alternates left ↔ right (${seq.slice(0, 6).join('→')})`, alternating);
  }

  // Launch impulse: vz at every launch (state post-gravity-step) ≥ 1.50 m/s,
  // and the pre-gravity launch arm equals SUIT_HURRY_LAUNCH_VZ exactly.
  {
    let minLaunchVz = Infinity;
    for (const i of launches) minLaunchVz = Math.min(minLaunchVz, S[i].vz);
    check(`launch vz ${minLaunchVz.toFixed(3)} m/s ≥ 1.50 gate (every launch)`, minLaunchVz >= 1.5,
      `min=${minLaunchVz}`);
    check('vz == SUIT_HURRY_LAUNCH_VZ − g·dt on launch frames (impulse exact)',
      launches.every((i) => Math.abs(S[i].vz - (SUIT_HURRY_LAUNCH_VZ - LUNAR_GRAVITY * DT)) < 1e-12),
      `first=${launches.length > 0 ? S[launches[0]].vz : 'n/a'}`);
  }

  // Forward thrust thrust boost per push-off ≥ 0.8 m/s while uncapped; once
  // the stride rides the cruise cap, the launch pins exactly to TARGET.
  {
    let minBoost = Infinity;
    let uncapped = 0;
    let cappedOk = true;
    for (const i of launches) {
      const before = Math.max(alongOf(S[i - 1]), 0);
      const after = alongOf(S[i]);
      if (before + SUIT_HURRY_STEP_BOOST <= SUIT_HURRY_TARGET_SPEED + 1e-9) {
        minBoost = Math.min(minBoost, after - before);
        uncapped++;
      } else {
        cappedOk = cappedOk && Math.abs(after - SUIT_HURRY_TARGET_SPEED) < 1e-9;
      }
    }
    check(`forward step boost ${minBoost.toFixed(3)} m/s ≥ 0.8 gate (${uncapped} uncapped pushes)`,
      uncapped >= 3 && minBoost >= 0.8, `min=${minBoost} uncapped=${uncapped}`);
    check('capped pushes land exactly on SUIT_HURRY_TARGET_SPEED (5.2)', cappedOk);
  }

  // Ballistic flight episodes: hangtime ≥ 0.85 s, apex Δz ≥ 0.60 m.
  {
    const episodes: { frames: number; apex: number }[] = [];
    let runStart = -1;
    let apex = 0;
    for (let i = 0; i < S.length; i++) {
      if (!S[i].isGrounded) {
        if (runStart < 0) {
          runStart = i;
          apex = S[i].z;
        } else apex = Math.max(apex, S[i].z);
      } else if (runStart >= 0) {
        episodes.push({ frames: i - runStart, apex });
        runStart = -1;
      }
    }
    const minHang = Math.min(...episodes.map((e) => e.frames * DT));
    const minApex = Math.min(...episodes.map((e) => e.apex));
    check(`${episodes.length} flight arcs; min hangtime ${minHang.toFixed(3)} s ≥ 0.85 gate`,
      episodes.length >= 4 && minHang >= 0.85, `min=${minHang}`);
    check(`min ballistic apex Δz ${minApex.toFixed(3)} m ≥ 0.60 gate`, minApex >= 0.6,
      `min=${minApex}`);
    // Physics-reported bookkeeping agrees with the measured envelope.
    check('hurryAirTime on touchdown frames matches measured hangtime',
      touchdowns.every((t) => Math.abs(S[t].hurryAirTime! - S[t].hangtime) < 1e-12
        && S[t].hurryAirTime! >= 0.85));
  }

  // Momentum restitution across footfalls ≥ 88 % (law is exactly η = 0.90).
  {
    let minRatio = Infinity;
    for (const t of touchdowns) {
      const before = horizOf(S[t - 1]);
      const after = horizOf(S[t]);
      if (before < 0.5) continue; // ignore launch-adjacent noise, keep real footfalls
      minRatio = Math.min(minRatio, after / before);
    }
    check(`touchdown retains ${(minRatio * 100).toFixed(1)} % momentum ≥ 88 % gate`,
      minRatio >= 0.88, `min ratio=${minRatio}`);
    check('restitution law applies exact SUIT_HURRY_RESTITUTION (0.90)',
      touchdowns.every((t) => horizOf(S[t - 1]) < 0.5
        || Math.abs(horizOf(S[t]) - horizOf(S[t - 1]) * SUIT_HURRY_RESTITUTION) < 1e-9));
  }

  // Brace window: touchdown → next launch lasts SUIT_HURRY_BRACE_DURATION_S
  // (frame-quantised), compression ramps to exactly 0.08 m.
  {
    let maxCompression = 0;
    let minWindow = Infinity;
    let maxWindow = 0;
    for (const t of touchdowns) {
      const nextLaunch = launches.find((l) => l > t);
      if (nextLaunch === undefined) continue;
      const win = (nextLaunch - t) * DT;
      minWindow = Math.min(minWindow, win);
      maxWindow = Math.max(maxWindow, win);
      for (let i = t; i <= nextLaunch; i++) {
        maxCompression = Math.max(maxCompression, S[i].hurryBraceCompression ?? 0);
      }
    }
    check(`brace compression peaks at exactly ${maxCompression.toFixed(3)} m (= 0.08)`,
      Math.abs(maxCompression - SUIT_HURRY_BRACE_COMPRESSION_M) < 1e-12);
    check(`brace window ${minWindow.toFixed(3)}–${maxWindow.toFixed(3)} s ⊂ [0.12, 0.16] s`,
      minWindow >= SUIT_HURRY_BRACE_DURATION_S - 1e-9 && maxWindow <= 0.16 + 1e-9);
  }

  // Stride phase fields always reported; gait cruise at target speed.
  {
    const phaseOk = S.every((s) => s.hurryStepPhase !== undefined
      && s.hurryStepPhase === (s.isGrounded ? 'ground_brace' : 'flight_arc'));
    check('hurryStepPhase = flight_arc aloft / ground_brace grounded, every frame', phaseOk);
    const maxSpeed = Math.max(...S.map(horizOf));
    check(`bounding cruise reaches cruise cap ${maxSpeed.toFixed(3)} m/s (SUIT_HURRY_TARGET_SPEED)`,
      Math.abs(maxSpeed - SUIT_HURRY_TARGET_SPEED) < 1e-6);
    check('bounding sustains above SUIT_HURRY_MIN_SPEED (1.8) throughout stride',
      launches.every((i) => horizOf(S[i]) > SUIT_HURRY_MIN_SPEED));
  }
}

// ===========================================================================
// GATE 3 — Kinetic Articulation & Alternating Dust Puffs (Spec 30 §2.2.3 / §4)
// ===========================================================================

function gate3Articulation(): void {
  section('GATE 3 — Steelpush articulation & alternating footfall dust (§2.2.3)');

  // -- Pure stride law (§2.2.3) ---------------------------------------------
  // Mesh convention: positive rotation.x swings a hanging limb AFT.
  {
    const pf = hurryStridePose('left', true); // stride leg L leading, push on R
    check('flight law: pushing hip aft ≥ 0.40 (code +0.55), knee straightened ≤ 0.10',
      pf.hipRx >= 0.40 && Math.abs(pf.hipRx - HURRY_PUSH_HIP_AFT_RAD) < 1e-12
      && pf.kneeRx <= 0.10 && Math.abs(pf.kneeRx - HURRY_PUSH_KNEE_RAD) < 1e-12);
    check('flight law: leading hip forward ≥ 0.35 (code −0.48), knee flexed ≥ 0.60 (0.85)',
      pf.hipLx <= -0.35 && Math.abs(pf.hipLx + HURRY_LEAD_HIP_FWD_RAD) < 1e-12
      && pf.kneeLx >= 0.60 && Math.abs(pf.kneeLx - HURRY_LEAD_KNEE_RAD) < 1e-12);
    check('arm sprint opposition: stance-side arm forward (−0.45), recovery-side aft (+0.35)',
      pf.shoulderRx < 0 && pf.shoulderLx > 0
      && Math.abs(pf.shoulderRx + HURRY_ARM_STANCE_FWD_RAD) < 1e-12
      && Math.abs(pf.shoulderLx - HURRY_ARM_RECOVERY_AFT_RAD) < 1e-12);
    check('torso: 7° (0.12 rad) pitch into thrust, 1.5° roll toward stance hip',
      Math.abs(pf.torsoPitchRad - HURRY_TORSO_PITCH_FWD_RAD) < 1e-12
      && Math.abs(pf.torsoRollRad - -HURRY_TORSO_ROLL_RAD) < 1e-12
      && !pf.powerIsLeft && pf.strideLegIsLeft);
    const pm = hurryStridePose('right', true); // mirrored side
    check('law mirrors cleanly for right stride (push L aft, lead R flexed, arms oppose, roll +)',
      pm.hipLx >= 0.40 && pm.hipRx <= -0.35 && pm.kneeRx >= 0.60
      && pm.shoulderLx < 0 && pm.shoulderRx > 0 && Math.sign(pm.torsoRollRad) === 1);
    const pb = hurryStridePose('left', false); // grounded brace frame
    check('brace frame: stride leg loads as planted stance spring, recovery reaches forward',
      pb.hipLx === 0.18 && pb.kneeLx === 0.5 && pb.hipRx === -0.32 && pb.kneeRx === 0.55);
  }

  // -- Live avatar run: pivots track the law, dust alternates ----------------
  const avatar = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } });
  avatar.init();
  const nodes = new Map<string, TransformNode>();
  for (const m of avatar.getMeshes()) {
    let n = m.parent as TransformNode | null;
    while (n !== null) {
      if (!nodes.has(n.name)) nodes.set(n.name, n);
      n = n.parent as TransformNode | null;
    }
  }
  const hipL = nodes.get('eva-hip-l')!;
  const hipR = nodes.get('eva-hip-r')!;
  const kneeL = nodes.get('eva-kneejoint-l')!;
  const kneeR = nodes.get('eva-kneejoint-r')!;
  const shoulderL = nodes.get('eva-shoulder-l')!;
  const shoulderR = nodes.get('eva-shoulder-r')!;
  const upper = nodes.get('eva-upper-body')!;

  interface PuffRec { lat: number; side: string; z: number; x: number; y: number }
  const puffs: PuffRec[] = [];
  let puffsSeen = 0;
  let flightSamples = 0;
  let lawOk = 0;
  let oppositionOk = 0;
  let torsoOk = 0;

  for (let i = 0; i < 1500; i++) {
    const s = avatar.update(DT, SPRINT);
    if (s.gaitMode === 'bounding' && !s.isGrounded) {
      flightSamples++;
      const pose = hurryStridePose(s.hurryStrideLeg, true);
      if (Math.abs(hipL.rotation.x - pose.hipLx) < 1e-9
        && Math.abs(hipR.rotation.x - pose.hipRx) < 1e-9
        && Math.abs(kneeL.rotation.x - pose.kneeLx) < 1e-9
        && Math.abs(kneeR.rotation.x - pose.kneeRx) < 1e-9) lawOk++;
      if (shoulderL.rotation.x * shoulderR.rotation.x < 0) oppositionOk++;
      if (Math.abs(upper.rotation.x - HURRY_TORSO_PITCH_FWD_RAD) < 1e-9
        && Math.abs(Math.abs(upper.rotation.z) - HURRY_TORSO_ROLL_RAD) < 1e-9) torsoOk++;
    }
    const c = avatar.getBootDustPuffCount();
    if (c > puffsSeen) {
      puffsSeen = c;
      const p = avatar.getLastBootDustPuffPos()!;
      const h = s.heading ?? 0;
      const lat = (p.x - s.x) * -Math.sin(h) + (p.y - s.y) * Math.cos(h);
      puffs.push({
        lat,
        side: s.hurryStrideLeg ?? '?',
        z: p.z - s.z,
        x: p.x,
        y: p.y,
      });
    }
  }

  check(`flight pivots match hurryStridePose law every airborne frame (${lawOk}/${flightSamples})`,
    flightSamples > 200 && lawOk === flightSamples, `lawOk=${lawOk} of ${flightSamples}`);
  check('arms live in opposing sprint counter-torque (sign flip each side)',
    flightSamples > 0 && oppositionOk === flightSamples, `${oppositionOk}/${flightSamples}`);
  check('torso 0.12 rad lean + 0.026 rad roll sway live on stride frames',
    flightSamples > 0 && torsoOk === flightSamples, `${torsoOk}/${flightSamples}`);

  check(`boot-dust puffs dispatched on footfalls (${puffs.length} puffs ≥ 3)`, puffs.length >= 3);
  check('every puff lands at exactly ±0.13 m d_hip perpendicular to heading, sole z',
    puffs.every((p) => Math.abs(Math.abs(p.lat) - BOOT_DUST_HIP_OFFSET_M) < 1e-9
      && Math.abs(p.z) < 1e-12 && BOOT_DUST_HIP_OFFSET_M === 0.13));
  check('puff side matches the physics hurryStrideLeg receiving the touchdown',
    puffs.every((p) => (p.lat < 0 ? 'left' : 'right') === p.side),
    puffs.slice(0, 4).map((p) => `${p.side}:${p.lat.toFixed(2)}`).join(' '));
  {
    let alternates = puffs.length >= 3;
    for (let k = 1; k < puffs.length; k++) alternates = alternates && puffs[k].side !== puffs[k - 1].side;
    check(`dust puffs alternate left/right sole coordinates (${puffs.slice(0, 6).map((p) => p.side[0]).join('→')})`,
      alternates);
    // Consecutive puffs are distinct world points (a real trail, not one spot).
    let distinct = true;
    for (let k = 1; k < puffs.length; k++) {
      distinct = distinct && Math.hypot(puffs[k].x - puffs[k - 1].x, puffs[k].y - puffs[k - 1].y) > 0.1;
    }
    check('consecutive puffs are spatially distinct (alternating footfall trail)', distinct);
  }

  avatar.dispose();
}

// ===========================================================================
// GATE 4 — Clean UI & HUD Toggle System (Spec 30 §2.3 / §4)
// ===========================================================================

async function gate4Hud(): Promise<void> {
  section('GATE 4 — HUD toggle: [U]/[H], double-tap R3, Escape scope, persistence (§2.3)');

  // Constants + narrowing.
  check('HUD_MODES = [standard, minimal, hidden]; toast auto-fade 1.5 s',
    HUD_MODES.length === 3 && HUD_MODES[0] === 'standard' && HUD_MODES[1] === 'minimal'
    && HUD_MODES[2] === 'hidden' && HUD_MODE_TOAST_MS === 1500);
  check('double-tap R3 window 350 ms; View hold 500 ms; R3=buttons[11], View=buttons[8]',
    GAMEPAD_HUD_DOUBLE_TAP_MS === 350 && GAMEPAD_HUD_VIEW_HOLD_MS === 500
    && GAMEPAD_BUTTONS.camera === 11 && GAMEPAD_BUTTONS.map === 8);
  check('isHudMode narrows only the three mode strings',
    isHudMode('standard') && isHudMode('minimal') && isHudMode('hidden')
    && !isHudMode('bogus') && !isHudMode(null) && !isHudMode(undefined));
  check('toast copy verbatim per Spec 30 §2.3.3',
    HUD_MODE_TOAST_TEXT.standard === 'UI: STANDARD'
    && HUD_MODE_TOAST_TEXT.minimal === 'UI: MINIMAL [Press U for Standard]'
    && HUD_MODE_TOAST_TEXT.hidden === 'UI: CINEMATIC HIDDEN [Press U to Restore]');

  const storage = new MemoryStorage();
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  const realNav = (globalThis as { navigator?: unknown }).navigator;

  // ---- App A: keyboard lanes, Escape scope, gamepad lanes -------------------
  const docA = makeFakeDocument();
  (globalThis as { document?: unknown }).document = docA;
  const appA = new ClientApp({ seed: 'spec30-hud-a', username: 'hud-a', faction: 'CEC', silent: true });
  await appA.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));
  let nowMs = 10_000;
  const tick = (ms = 16): void => {
    nowMs += ms;
    appA.update(nowMs);
  };
  tick();
  tick();

  const rootEl = docA.getElementById(HUD_ROOT_ID);
  const toastEl = docA.getElementById(HUD_MODE_TOAST_ID);
  check('HUD root #lunar-hud + mode toast host present in DOM', rootEl !== null && toastEl !== null);
  check('mode toast is a SIBLING of #lunar-hud (survives root opacity: 0)',
    toastEl !== null && rootEl !== null && toastEl.parent !== rootEl);
  check('App A boots in standard mode with no mode classes', appA.getHudMode() === 'standard'
    && rootEl !== null && !rootEl.classList.contains('hud-mode-minimal')
    && !rootEl.classList.contains('hud-mode-hidden'));

  const epc0 = docA.exitPointerLockCalls;

  appA.handleKeyInput('KeyU', 'down');
  tick();
  check('[U] cycles standard → minimal + .hud-mode-minimal class + toast + storage write',
    appA.getHudMode() === 'minimal'
    && rootEl!.classList.contains('hud-mode-minimal') && !rootEl!.classList.contains('hud-mode-hidden')
    && toastEl!.getAttribute('data-mode-toast') === HUD_MODE_TOAST_TEXT.minimal
    && storage.getItem(HUD_MODE_STORAGE_KEY) === 'minimal');
  appA.handleKeyInput('KeyH', 'down');
  tick();
  check('[H] cycles minimal → hidden + .hud-mode-hidden class + toast + storage write',
    appA.getHudMode() === 'hidden'
    && rootEl!.classList.contains('hud-mode-hidden') && !rootEl!.classList.contains('hud-mode-minimal')
    && toastEl!.getAttribute('data-mode-toast') === HUD_MODE_TOAST_TEXT.hidden
    && storage.getItem(HUD_MODE_STORAGE_KEY) === 'hidden');
  appA.handleKeyInput('KeyU', 'down');
  tick();
  check('[U] cycles hidden → standard (classes cleared)',
    appA.getHudMode() === 'standard' && !rootEl!.classList.contains('hud-mode-hidden')
    && !rootEl!.classList.contains('hud-mode-minimal')
    && storage.getItem(HUD_MODE_STORAGE_KEY) === 'standard');
  check('zero exitPointerLock calls across every keyboard toggle (pointer-lock immune)',
    docA.exitPointerLockCalls === epc0, `delta=${docA.exitPointerLockCalls - epc0}`);

  // Escape: modal-only dismissal, never a HUD toggle.
  appA.handleKeyInput('Escape', 'down');
  tick();
  check('Escape with no modal open does NOT change HUD mode', appA.getHudMode() === 'standard');
  const hudA = appA.getHud()!;
  hudA.showTradeDialog();
  tick();
  appA.handleKeyInput('Escape', 'down');
  tick();
  check('Escape dismisses the open trade dialog, HUD mode untouched',
    hudA.isTradeDialogOpen() === false && appA.getHudMode() === 'standard');
  hudA.showMap();
  tick();
  check('map opens visible', hudA.isMapVisible() === true);
  appA.handleKeyInput('Escape', 'down');
  tick();
  check('Escape dismisses the topo map, HUD mode untouched',
    hudA.isMapVisible() === false && appA.getHudMode() === 'standard');
  check('still zero exitPointerLock calls after Escape lane', docA.exitPointerLockCalls === epc0);

  // Gamepad lanes on the same app.
  const pads: GamepadLike[] = [makePad({})];
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => pads },
    configurable: true,
    writable: true,
  });
  pads[0] = makePad({ 0: true });
  tick();
  pads[0] = makePad({});
  tick();
  check('qualified pad activity latches gamepad control', appA.isGamepadLatched() === true);

  const tapMode0 = appA.getHudMode();
  // Two taps spaced > 350 ms apart are NOT a double-tap (single-tap discipline).
  pads[0] = makePad({ [GAMEPAD_BUTTONS.camera]: true });
  tick();
  pads[0] = makePad({});
  tick();
  for (let i = 0; i < 25; i++) tick(); // 400 ms > the 350 ms window
  pads[0] = makePad({ [GAMEPAD_BUTTONS.camera]: true });
  tick();
  pads[0] = makePad({});
  tick();
  check('two R3 taps 400 ms apart (> 350 ms window) do NOT cycle the mode',
    appA.getHudMode() === tapMode0, `mode=${appA.getHudMode()}`);

  // Rapid double-tap R3 inside the window: one clean cycle.
  const tapMode1 = appA.getHudMode();
  pads[0] = makePad({ [GAMEPAD_BUTTONS.camera]: true });
  tick();
  pads[0] = makePad({});
  tick();
  pads[0] = makePad({ [GAMEPAD_BUTTONS.camera]: true });
  tick();
  pads[0] = makePad({});
  tick();
  const expectedAfterDoubleTap = HUD_MODES[(HUD_MODES.indexOf(tapMode1 as HUDMode) + 1) % 3];
  check(`double-tap R3 within 350 ms cycles ${tapMode1} → ${expectedAfterDoubleTap}`,
    appA.getHudMode() === expectedAfterDoubleTap, `mode=${appA.getHudMode()}`);

  // Long-press View/Back: ≥ 0.5 s fires exactly once per hold.
  const holdMode0 = appA.getHudMode();
  pads[0] = makePad({ [GAMEPAD_BUTTONS.map]: true });
  for (let i = 0; i < 45; i++) tick(); // 720 ms hold
  const cycledDuringHold = appA.getHudMode() !== holdMode0;
  for (let i = 0; i < 60; i++) tick(); // keep holding — must NOT fire again
  check(`long-press View (720 ms) cycles HUD mode once (${holdMode0} → ${appA.getHudMode()})`,
    cycledDuringHold && appA.getHudMode() === HUD_MODES[(HUD_MODES.indexOf(holdMode0 as HUDMode) + 1) % 3],
    `mode=${appA.getHudMode()}`);
  pads[0] = makePad({});
  for (let i = 0; i < 5; i++) tick();
  check('held View never chains a second cycle (once-per-hold latch)',
    appA.getHudMode() === HUD_MODES[(HUD_MODES.indexOf(holdMode0 as HUDMode) + 1) % 3]);
  check('gamepad toggles also never release pointer lock', docA.exitPointerLockCalls === epc0);
  const finalModeA = appA.getHudMode();
  check(`App A final mode ${finalModeA} equals its last localStorage write`,
    storage.getItem(HUD_MODE_STORAGE_KEY) === finalModeA,
    `storage=${storage.getItem(HUD_MODE_STORAGE_KEY)} mode=${finalModeA}`);
  appA.dispose();

  // ---- App B: boot-time restore from localStorage ---------------------------
  storage.setItem(HUD_MODE_STORAGE_KEY, 'minimal');
  const docB = makeFakeDocument();
  (globalThis as { document?: unknown }).document = docB;
  const appB = new ClientApp({ seed: 'spec30-hud-b', username: 'hud-b', faction: 'CEC', silent: true });
  await appB.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));
  check('App B restores persisted mode "minimal" at boot + class applied',
    appB.getHudMode() === 'minimal'
    && docB.getElementById(HUD_ROOT_ID)!.classList.contains('hud-mode-minimal'));
  appB.dispose();

  // ---- App C: hostile storage value falls back to standard ------------------
  storage.setItem(HUD_MODE_STORAGE_KEY, 'not-a-mode');
  const docC = makeFakeDocument();
  (globalThis as { document?: unknown }).document = docC;
  const appC = new ClientApp({ seed: 'spec30-hud-c', username: 'hud-c', faction: 'CEC', silent: true });
  await appC.init(new NullEngine({ renderWidth: 320, renderHeight: 240 } as never));
  check('bogus stored value falls back to standard at boot (guarded restore)',
    appC.getHudMode() === 'standard'
    && !docC.getElementById(HUD_ROOT_ID)!.classList.contains('hud-mode-hidden'));
  appC.dispose();

  // ---- CSS contract (fake DOM has no cascade — assert the stylesheet) -------
  {
    const css = readFileSync(resolve(HERE, '..', 'src/ui/hud.css'), 'utf8');
    const hiddenBlock = /#lunar-hud\.hud-mode-hidden\s*\{([^}]*)\}/.exec(css);
    check('.hud-mode-hidden sets opacity: 0 !important (complete visual suppression)',
      hiddenBlock !== null && /opacity:\s*0\s*!important/.test(hiddenBlock[1]));
    check('.hud-mode-hidden sets pointer-events: none !important (clicks fall to canvas)',
      hiddenBlock !== null && /pointer-events:\s*none\s*!important/.test(hiddenBlock[1]));
    check('.hud-mode-hidden * mutes pointer-events for every child element',
      /#lunar-hud\.hud-mode-hidden\s*\*\s*\{[^}]*pointer-events:\s*none\s*!important/.test(css));
    check('minimal mode suppresses comms card, tutorial panel, and lap timer',
      /#lunar-hud\.hud-mode-minimal\s+#lunar-hud-comms/.test(css)
      && /#lunar-hud\.hud-mode-minimal\s+#lunar-hud-tutorial/.test(css)
      && /#lunar-hud\.hud-mode-minimal\s+#lunar-hud-lap/.test(css));
    check('mode transitions use opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1) + transform ease-out',
      /transition:[^;]*opacity\s+0\.25s\s+cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)[^;]*transform\s+0\.25s\s+ease-out/.test(css));
  }

  // Restore the ambient navigator for any later probes / harness reuse.
  Object.defineProperty(globalThis, 'navigator', {
    value: realNav,
    configurable: true,
    writable: true,
  });
}

// ===========================================================================
// GATE 5 — Automated Verification & Build (Spec 30 §2.3 / §4)
// ===========================================================================

function gate5Build(): void {
  section('GATE 5 — automated verification & build gate registration');

  const pkg = JSON.parse(
    readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  check('npm script smoke:eva-cleanup registered → npx tsx scripts/smoke-eva-cleanup.ts',
    pkg.scripts['smoke:eva-cleanup'] === 'npx tsx scripts/smoke-eva-cleanup.ts',
    `got: ${pkg.scripts['smoke:eva-cleanup']}`);
  check('production build script present (vite build) — gate runs in CI/CI job',
    typeof pkg.scripts.build === 'string' && pkg.scripts.build.includes('vite build'));
}

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
  gate1Armor();
  gate2Locomotion();
  gate3Articulation();
  await gate4Hud();
  gate5Build();

  console.log(`\n${'='.repeat(64)}`);
  if (failures.length === 0) {
    console.log(
      `ALL ${passed} CHECKS PASSED ✔  (Spec 30 Phase 6 — EVA locomotion + stormtrooper suit + UI cleanup gates)`,
    );
    process.exit(0);
  } else {
    console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  console.error('smoke-eva-cleanup crashed:', err);
  process.exit(1);
});
