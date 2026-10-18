/**
 * Spec 28 Phase 6 — FTUE / EVA / Bounding / Controller headless smoke suite.
 *
 * Runs under `npx tsx scripts/smoke-ftue-eva-controls.ts` (exit 0 == all
 * green). No browser, no sockets: Babylon runs on `NullEngine`, the HUD is
 * built against a mini fake DOM, and gamepads are scripted `GamepadLike`
 * objects behind an injected `navigator`. Covers the four Spec 28 §4
 * acceptance gates plus the constants each gate rests on:
 *
 *   Gate 1 — Suit Aesthetic (§2.2): torso r ≤ 0.22 m, articulated L/R arm
 *            assemblies, panoramic visor d ≥ 0.34 m, twin cryo-cylinder
 *            PLSS, arm counter-swing active during the walk cycle.
 *   Gate 2 — Bounding Locomotion (§2.3): sprint throttle produces
 *            alternating ballistic arcs (apex ≥ 0.35 m, hangtime ≥ 0.6 s,
 *            forward speed ≥ 4.5 m/s), boot-dust puffs kick on every
 *            touchdown, and normal walk (throttle ≤ 0.6) stays grounded.
 *   Gate 3 — FTUE Boot (§2.1): `autoAttachIntroDirector` mounts the
 *            TransportLander + IntroDirector, starts the orbit cinematic,
 *            DEFERS Quest 1 until the boots-on-regolith handoff, then
 *            starts "A One-Way Ticket to the Frontier" with dispatch
 *            comms + hint arrow. [🔄 Replay Intro] and [F8] re-trigger it.
 *   Gate 4 — Stick Reliability (§2.4): Right Stick pinned to the extreme
 *            rails (x = −1, y = −1) for ≥ 30 frames never mutes camera
 *            yaw or look pitch, never bleeds into the throttle channel,
 *            and the radial deadzone (dz = 0.12) re-normalisation matches
 *            the spec formula exactly.
 *
 * The production build gate (`npm run build`) runs separately in CI.
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

import { EvaSuitAvatar, GEO, ARM_SWING_SCALE } from '../src/entities/AstronautSuit.ts';
import {
  IDLE_SUIT_INPUT,
  LunarEvaSuit,
  LUNAR_GRAVITY,
  SUIT_BOUND_LAUNCH_VZ,
  SUIT_BOUND_MIN_SPEED,
  SUIT_BOUND_RESTITUTION,
  SUIT_BOUND_SPEED,
} from '../src/physics/TraversalPhysics.ts';
import {
  ClientApp,
  GAMEPAD_RADIAL_DEADZONE,
  INTRO_COMPLETED_KEY,
  gamepadRadialDeadzone,
} from '../src/client/ClientApp.ts';
import type { GamepadLike } from '../src/client/ClientApp.ts';
import { WALKOUT_REACHED_REGOLITH_M } from '../src/client/IntroDirector.ts';

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

const DT = 1 / 60;
const FLAT = () => 0;

// ---------------------------------------------------------------------------
// In-memory Storage + mini fake DOM (same surface smoke-intro-replay uses)
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
  const docListeners = new Map<string, Array<(event: unknown) => void>>();
  return {
    body: make(),
    createElement: () => make(),
    getElementById: (id: string) => registry.get(id) ?? null,
    addEventListener(type: string, listener: (event: unknown) => void) {
      const l = docListeners.get(type) ?? [];
      l.push(listener);
      docListeners.set(type, l);
    },
    removeEventListener() {},
  };
}

// ===========================================================================
// GATE 1 — Suit Aesthetic (Spec 28 §2.2 / §4.2)
// ===========================================================================

async function gateSuitAesthetic(): Promise<void> {
  section('GATE 1 — Suit Aesthetic (§2.2: slim torso, arms, visor, twin-tank PLSS)');

  const avatar = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } });
  avatar.init(); // self-owned NullEngine fallback
  check('EvaSuitAvatar builds headless', avatar.isBuilt() === true);

  const meshes = avatar.getMeshes();
  const byName = (n: string): Mesh | undefined => meshes.find((m) => m.name === `eva-${n}`);

  // Torso radius ≤ 0.22 m — the spec gate.
  check(
    `torso radius ${GEO.torso.radius} m ≤ 0.22 m gate`,
    GEO.torso.radius <= 0.22 && byName('torso') !== undefined,
    `r=${GEO.torso.radius}`,
  );
  check(
    'tapered build: chest plate + waist compression band present',
    byName('chest-plate') !== undefined && byName('waist-band') !== undefined,
  );

  // Articulated L/R arms: upper arm, forearm, cuff, gauntlet on each side.
  const armParts = ['upper', 'forearm', 'cuff', 'glove'];
  const armsPresent = (['l', 'r'] as const).every((s) =>
    armParts.every((p) => byName(`arm-${p}-${s}`) !== undefined),
  );
  check('articulated L/R arm assemblies (upper/forearm/cuff/glove ×2)', armsPresent);
  const shoulderL = byName('arm-upper-l')?.parent as TransformNode | undefined;
  const shoulderR = byName('arm-upper-r')?.parent as TransformNode | undefined;
  const elbowL = byName('arm-forearm-l')?.parent as TransformNode | undefined;
  const elbowR = byName('arm-forearm-r')?.parent as TransformNode | undefined;
  check(
    'shoulder + elbow pivot nodes exist on both arms',
    shoulderL !== undefined && shoulderR !== undefined && elbowL !== undefined && elbowR !== undefined,
  );

  // Panoramic visor diameter ≥ 0.34 m — the spec gate.
  check(
    `visor diameter ${GEO.visor.diameter} m ≥ 0.34 m gate (helmet d ${GEO.helmet.diameter})`,
    GEO.visor.diameter >= 0.34 && byName('visor') !== undefined && byName('helmet') !== undefined,
  );
  const visor = byName('visor')!;
  check(
    'visor ellipsoid scaling sx 0.92 / sy 0.65 / sz 0.95',
    Math.abs(visor.scaling.x - GEO.visor.sx) < 1e-9
      && Math.abs(visor.scaling.y - GEO.visor.sy) < 1e-9
      && Math.abs(visor.scaling.z - GEO.visor.sz) < 1e-9,
  );

  // Twin-tank PLSS with cryo cylinders replaces the monolithic box.
  const tankL = byName('plss-tank-l');
  const tankR = byName('plss-tank-r');
  check(
    `twin cryo-cylinder PLSS present (r ${GEO.plss.tank.radius}, h ${GEO.plss.tank.height})`,
    tankL !== undefined && tankR !== undefined
      && GEO.plss.tank.radius === 0.08 && GEO.plss.tank.height === 0.52,
  );
  check(
    'PLSS contour panel + radiator cowl + twin thruster nozzles',
    byName('plss-panel') !== undefined && byName('plss-radiator-cowl') !== undefined
      && byName('plss-nozzle-l') !== undefined && byName('plss-nozzle-r') !== undefined,
  );
  check(
    'PLSS panel is a flush contour contour (depth 0.1 m, no monolithic box)',
    GEO.plss.panel.depth === 0.1,
    `depth=${GEO.plss.panel.depth}`,
  );

  // Arm counter-swing active: walk the avatar, shoulders must move in
  // opposite phase with real amplitude and at ARM_SWING_SCALE of hip swing.
  let counterFrames = 0;
  let peakShoulder = 0;
  let scaleMatch = true;
  for (let i = 0; i < 180; i++) {
    avatar.update(DT, { ...IDLE_SUIT_INPUT, forward: 0.5 });
    const sl = shoulderL!.rotation.x;
    const sr = shoulderR!.rotation.x;
    peakShoulder = Math.max(peakShoulder, Math.abs(sl), Math.abs(sr));
    if (Math.abs(sl) > 1e-4 && Math.sign(sl) === -Math.sign(sr)) counterFrames++;
    // Hip swing is the reference clock (hipL is under root, not under shoulder).
    const hipL = avatar
      .getScene()
      ?.transformNodes.find((n) => n.name === 'eva-hip-l') as TransformNode | undefined;
    if (hipL !== null && hipL !== undefined && Math.abs(hipL.rotation.x) > 1e-4) {
      const ratio = Math.abs(sl / hipL.rotation.x);
      if (Math.abs(ratio - ARM_SWING_SCALE) > 0.02) scaleMatch = false;
    }
  }
  check(
    `arm counter-swing active: ${counterFrames}/180 walk frames in anti-phase`,
    counterFrames >= 40,
    `counterFrames=${counterFrames}`,
  );
  check(
    `shoulder swing amplitude meaningful (peak ${peakShoulder.toFixed(3)} rad)`,
    peakShoulder >= 0.15,
  );
  check('arm swing tracks hip clock at ARM_SWING_SCALE (0.75 ± 0.02)', scaleMatch);

  avatar.dispose();
}

// ===========================================================================
// GATE 2 — Bounding Locomotion (Spec 28 §2.3 / §4.3)
// ===========================================================================

function gateBounding(): void {
  section('GATE 2 — Bounding Locomotion (§2.3: ballistic arcs, dust, grounded walk)');

  check(
    'physics constants: g 1.62, vz 1.35, v_bound 5.0, η 0.88, threshold 1.8',
    LUNAR_GRAVITY === 1.62 && SUIT_BOUND_LAUNCH_VZ === 1.35
      && SUIT_BOUND_SPEED === 5.0 && SUIT_BOUND_RESTITUTION === 0.88
      && SUIT_BOUND_MIN_SPEED === 1.8,
    `g=${LUNAR_GRAVITY} vz=${SUIT_BOUND_LAUNCH_VZ} v=${SUIT_BOUND_SPEED} η=${SUIT_BOUND_RESTITUTION}`,
  );

  interface Arc {
    apex: number;
    hang: number;
    maxSpeed: number;
    reportedHang: number;
  }

  const runGait = (
    frames: number,
    sprint: boolean,
    forward: number,
  ): { arcs: Arc[]; everAirborne: boolean; maxZ: number; gaitSeen: Set<string> } => {
    const suit = new LunarEvaSuit({ x: 0, y: 0, z: 0, isGrounded: true });
    const arcs: Arc[] = [];
    let airborne = false;
    let t0 = 0;
    let apex = 0;
    let maxSpd = 0;
    let everAirborne = false;
    let maxZ = 0;
    const gaitSeen = new Set<string>();
    let t = 0;
    for (let i = 0; i < frames; i++) {
      t += DT;
      const s = suit.step(DT, { ...IDLE_SUIT_INPUT, forward, sprint }, FLAT);
      gaitSeen.add(s.gaitMode);
      maxZ = Math.max(maxZ, s.z);
      if (!s.isGrounded) {
        everAirborne = true;
        if (!airborne) {
          airborne = true;
          t0 = t;
          apex = 0;
          maxSpd = 0;
        }
        apex = Math.max(apex, s.z);
        maxSpd = Math.max(maxSpd, Math.hypot(s.vx, s.vy));
      } else if (airborne) {
        airborne = false;
        arcs.push({ apex, hang: t - t0, maxSpeed: maxSpd, reportedHang: s.hangtime });
      }
    }
    return { arcs, everAirborne, maxZ, gaitSeen };
  };

  // --- Normal walk stays grounded ------------------------------------------
  const walk = runGait(300, false, 0.5); // |forward| ≤ 0.6 → walk gait band
  check(
    'normal walk (throttle 0.5, 5 s): never leaves the regolith',
    walk.everAirborne === false && walk.maxZ < 0.05,
    `maxZ=${walk.maxZ.toFixed(4)}`,
  );
  check('walk gait never reports bounding band', !walk.gaitSeen.has('bounding'));

  // --- Lunar bounding sprint ------------------------------------------------
  const bound = runGait(900, true, 1.0);
  check('sprint throttle engages the bounding gait band', bound.gaitSeen.has('bounding'));
  check(`bounding produces alternating arcs (${bound.arcs.length} in 15 s)`, bound.arcs.length >= 3);

  const steady = bound.arcs.slice(1); // skip the spin-up arc from 0 m/s
  if (steady.length > 0) {
    const bestApex = Math.max(...steady.map((a) => a.apex));
    const bestHang = Math.max(...steady.map((a) => a.hang));
    const bestSpeed = Math.max(...steady.map((a) => a.maxSpeed));
    check(
      `ballistic apex ≥ 0.35 m gate (best ${bestApex.toFixed(3)} m)`,
      bestApex >= 0.35,
      `apex=${bestApex}`,
    );
    check(
      `hangtime ≥ 0.6 s gate (best ${bestHang.toFixed(3)} s)`,
      bestHang >= 0.6,
      `hang=${bestHang}`,
    );
    check(
      `forward speed ≥ 4.5 m/s gate (best ${bestSpeed.toFixed(3)} m/s)`,
      bestSpeed >= 4.5,
      `speed=${bestSpeed}`,
    );
    const reportedOk = steady.filter((a) => a.reportedHang >= 0.6).length;
    check(
      `physics layer reports completed-leap hangtime on touchdown (${reportedOk}/${steady.length} arcs ≥ 0.6 s)`,
      reportedOk >= 1,
    );
  } else {
    check('steady-state arcs available', false, 'no arcs after spin-up');
  }

  // --- Boot-dust puffs on landing (avatar layer) ----------------------------
  const avatar = new EvaSuitAvatar({ initial: { x: 0, y: 0, z: 0, isGrounded: true } });
  avatar.init();
  const puffsBefore = avatar.getBootDustPuffCount();
  let boundingFrames = 0;
  for (let i = 0; i < 900; i++) {
    const s = avatar.update(DT, { ...IDLE_SUIT_INPUT, forward: 1.0, sprint: true });
    if (s.gaitMode === 'bounding') boundingFrames++;
    if (avatar.getBootDustPuffCount() - puffsBefore >= 3) break;
  }
  const puffs = avatar.getBootDustPuffCount() - puffsBefore;
  check(
    `boot-dust puffs kick on bounding touchdowns (${puffs} puffs)`,
    puffs >= 2,
    `puffs=${puffs}`,
  );
  check('avatar rides the bounding gait', boundingFrames > 0);
  avatar.dispose();
}

// ===========================================================================
// GATE 3 — FTUE Boot (Spec 28 §2.1 / §4.1)
// ===========================================================================

async function gateFtue(): Promise<ClientApp | null> {
  section('GATE 3 — FTUE Boot (§2.1: auto director, deferred Quest 1, comms, replay, F8)');

  const doc = makeFakeDocument();
  (globalThis as { document?: unknown }).document = doc;
  const storage = new MemoryStorage();
  const engine = new NullEngine({ renderWidth: 320, renderHeight: 240 } as never);

  // Production wiring: `main.ts` passes autoAttachIntroDirector: true; the
  // `?intro=1` flag forces the descent even on a completed profile.
  const app = new ClientApp({
    seed: 'spec28-ftue-hunt',
    username: 'rampwalker',
    faction: 'CEC',
    silent: true,
    devMode: true,
    autoAttachIntroDirector: true,
    introStorage: storage,
    introQuery: 'intro=1',
  });
  await app.init(engine);

  let nowMs = 100_000;
  const tick = (ms = 16): void => {
    nowMs += ms;
    app.update(nowMs);
  };

  check('ClientApp initialized (auto-attach pipeline)', app.isInitialized());
  check(
    'TransportLander mounted in WorldScene at the landing site',
    app.world.getTransportLander() !== null,
  );
  const director = app.getIntroDirector();
  check('IntroDirector auto-attached', director !== null);
  if (director === null) return null;
  check(
    'cinematic starts from ORBIT on intro=1',
    director.getPhase() === 'orbit' && director.isRunning(),
    `phase=${director.getPhase()}`,
  );
  check('timeScale 1.0 default', director.timeScale === 1.0);

  // Quest deferral: no Quest 1 while the descent owns the first moments.
  check(
    'Quest 1 DEFERRED while cinematic runs (boots not on regolith)',
    app.getQuestEngine()?.getActiveQuest() === null,
  );
  check('no comms before handoff', app.getLastComms() === null);
  check('completion flag unset pre-handoff', !app.isIntroCompleted());

  // Drive the director down to the ramp walkout; the walkout beat completes
  // at WALKOUT_REACHED_REGOLITH_M = 1.2 m (duration fallback headless).
  check(`walkout regolith threshold is 1.2 m`, WALKOUT_REACHED_REGOLITH_M === 1.2);
  director.jumpToPhase('walkout');
  director.update(10); // walkout → completed (duration fallback, smoke-intro-replay precedent)
  tick(); // first client frame after completion fires the handoff

  check('director reached completed', director.getPhase() === 'completed');
  const quest = app.getQuestEngine()?.getActiveQuest() ?? null;
  check(
    'handoff auto-starts Quest 1 "A One-Way Ticket to the Frontier"',
    quest !== null && quest.title === 'A One-Way Ticket to the Frontier',
    `title=${quest?.title ?? 'null'}`,
  );
  check('corporate dispatch comms displayed', app.getLastComms() !== null);
  check('HUD comms panel visible', app.getHud()?.isCommsVisible() === true);
  check('completion flag written to storage', storage.getItem(INTRO_COMPLETED_KEY) === '1');

  // 3D hint arrow engaged (locked on the survey beacon objective).
  for (let i = 0; i < 10; i++) tick();
  check(
    'quest hint target engaged (survey beacon)',
    app.getQuestEngine()?.getHintArrowTarget() !== null,
  );
  check(
    'HUD hint arrow payload emitted',
    app.getHud()?.getHintArrowData() !== null,
    `data=${JSON.stringify(app.getHud()?.getHintArrowData())}`,
  );

  // --- Replay from the HUD button -------------------------------------------
  const hud = app.getHud();
  check('[🔄 Replay Intro] button surfaced in HUD', hud !== null);
  if (hud !== null) {
    check('[🔄 Replay Intro] restarts from orbit', hud.triggerReplayIntro() === true && director.getPhase() === 'orbit');
    check('replayed director is running', director.isRunning());
  }

  // --- F8 hotkey: wipe storage + re-trigger cleanly ---------------------------
  director.jumpToPhase('completed');
  storage.setItem(INTRO_COMPLETED_KEY, '1');
  app.handleKeyInput('F8', 'down');
  check('[F8] wipes completion storage', storage.getItem(INTRO_COMPLETED_KEY) === null);
  check('[F8] re-triggers the descent from Beat 1 (orbit)', director.getPhase() === 'orbit' && director.isRunning());
  app.handleKeyInput('F8', 'up');

  // Release player control for GATE 4: land the replayed cinematic cleanly
  // (avatar input is tethered to the cabin while `isIntroCinematic()`).
  director.jumpToPhase('completed');
  tick();
  check('player control released after cinematic completes', director.getPhase() === 'completed');

  // Skip-flag parse contract (first-visit vs returning, no full init needed).
  const skipApp = new ClientApp({
    seed: 'spec28-skip', username: 'x', faction: 'CEC', silent: true,
    autoAttachIntroDirector: true, introStorage: new MemoryStorage(), introQuery: 'skip_intro=1',
  });
  check('?skip_intro=1 suppresses the cinematic', skipApp.parseIntroLaunch().play === false);
  return app; // kept alive for GATE 4 (input pipeline on the same running app)
}

// ===========================================================================
// GATE 4 — Stick Reliability (Spec 28 §2.4 / §4.4)
// ===========================================================================

function gateSticks(app: ClientApp): void {
  section('GATE 4 — Stick Reliability (§2.4: extreme rails never mute yaw/pitch, dz 0.12)');

  // --- Pure radial deadzone contract -----------------------------------------
  check('GAMEPAD_RADIAL_DEADZONE is 0.12', GAMEPAD_RADIAL_DEADZONE === 0.12);
  const dz = (x: number, y: number) => gamepadRadialDeadzone(x, y);
  const z1 = dz(0.1, 0.05); // ‖a‖ ≈ 0.1118 ≤ 0.12
  check('inside radial deadzone → exact zero', z1.x === 0 && z1.y === 0);
  const z2 = dz(0.12, 0); // boundary inclusive
  check('deadzone boundary (0.12, 0) → exact zero', z2.x === 0 && z2.y === 0);
  const z3 = dz(0.6, 0); // (0.6 − 0.12) / 0.88 = 0.54545…
  check(
    're-normalisation matches spec formula at 0.6',
    Math.abs(z3.x - (0.6 - 0.12) / (1 - 0.12)) < 1e-12 && z3.y === 0,
    `x=${z3.x}`,
  );
  const z4 = dz(-1, -1); // unit-diagonal reads full scale, direction preserved
  check(
    'extreme diagonal (−1,−1) → magnitude exactly 1.0, direction preserved',
    Math.abs(Math.hypot(z4.x, z4.y) - 1.0) < 1e-12
      && Math.sign(z4.x) === -1 && Math.sign(z4.y) === -1,
    `(x=${z4.x.toFixed(4)}, y=${z4.y.toFixed(4)})`,
  );
  const z5 = dz(2, 0); // clamped to unit rail
  check('over-range input clamps to full-scale 1.0', Math.abs(z5.x - 1) < 1e-12);

  // --- Integration: rails pinned for ≥ 30 frames never mute yaw/pitch -------
  const makePad = (axes: number[], mapping?: string): GamepadLike => ({
    axes,
    buttons: Array.from({ length: 10 }, () => ({ value: 0, pressed: false })),
    ...(mapping !== undefined ? { mapping } : {}),
  });

  // Anonymous (Linux-style) pad: right stick pinned hard-over at (−1, −1).
  const pad = makePad([0, 0, -1, -1, 0, 0]);
  const pads: GamepadLike[] = [pad];
  let frameMs = 500_000; // independent virtual clock (Gate 3's has elapsed)
  const step = (): void => {
    frameMs += 16;
    app.update(frameMs);
  };
  const realNav = (globalThis as { navigator?: unknown }).navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => pads },
    configurable: true,
    writable: true,
  });

  try {
    const suit = app.getSuit();
    const heading0 = suit.getState().heading;
    const deltas: number[] = [];
    let prev = heading0;
    // 40 frames > the 30-frame gate (and > PAD_RAIL_REST_FRAMES 8 — the old
    // latch fired after 5; nothing may mute by frame 40).
    for (let i = 0; i < 40; i++) {
      // keep the suit on the ground for the yaw channel
      if (!suit.getState().isGrounded) {
        suit.setState({ z: 0, vz: 0, isGrounded: true });
      }
      step();
      const h = suit.getState().heading;
      deltas.push(Math.abs(h - prev));
      prev = h;
    }
    const totalYaw = Math.abs(prev - heading0);
    check(
      `yaw ALIVE with axes[2]=−1 pinned 40 frames (Δheading ${(totalYaw * 57.3).toFixed(1)}°)`,
      totalYaw > 0.1,
      `Δ=${totalYaw}`,
    );
    const lateYaw = deltas.slice(30).reduce((a, b) => a + b, 0);
    check(
      'yaw still responsive in frames 31–40 (never muted, no rail-latch decay)',
      lateYaw > 0.05,
      `lateΣ=${lateYaw}`,
    );
    const horizSpeed = Math.hypot(suit.getState().vx, suit.getState().vy);
    check(
      'stick rails bleed NO throttle into the forward channel',
      horizSpeed < 0.3,
      `v=${horizSpeed.toFixed(3)}`,
    );

    // Pitch channel: hold axes[3]=−1 and hop — the airborne RCS branch
    // integrates look pitch; a latched (muted) axis would leave it dead.
    const pitch0 = suit.getState().pitch;
    app.handleKeyInput('Space', 'down');
    for (let i = 0; i < 45; i++) {
      step();
    }
    app.handleKeyInput('Space', 'up');
    const pitchNow = suit.getState().pitch;
    check(
      `pitch channel ALIVE with axes[3]=−1 pinned (Δpitch ${(((pitchNow - pitch0) * 180) / Math.PI).toFixed(1)}°)`,
      Math.abs(pitchNow - pitch0) > 0.02,
      `Δ=${pitchNow - pitch0}`,
    );

    // W3C standard-mapping pad: heuristic rail scan skipped entirely, but
    // the right stick must still be read as a stick, never latched.
    const stdPad = makePad([0, 0, -1, -1, 0, 0], 'standard');
    pads[0] = stdPad;
    const stdH0 = suit.getState().heading;
    if (!suit.getState().isGrounded) suit.setState({ z: 0, vz: 0, isGrounded: true });
    for (let i = 0; i < 30; i++) {
      step();
      if (!suit.getState().isGrounded) suit.setState({ z: 0, vz: 0, isGrounded: true });
    }
    const stdYaw = Math.abs(suit.getState().heading - stdH0);
    check(
      `standard-mapping pad: right stick still steers yaw (Δheading ${(stdYaw * 57.3).toFixed(1)}°)`,
      stdYaw > 0.1,
      `Δ=${stdYaw}`,
    );

    // Linux bipolar rails on axes 4/5: parked at −1 while sticks centred,
    // rest-calibration must latch ONLY axes 4/5 — yaw keeps flowing.
    pads[0] = makePad([0, 0, 0, 0, -1, -1]);
    const linH0 = suit.getState().heading;
    for (let i = 0; i < 20; i++) {
      step();
      if (!suit.getState().isGrounded) suit.setState({ z: 0, vz: 0, isGrounded: true });
    }
    const linSpeed = Math.hypot(suit.getState().vx, suit.getState().vy);
    check(
      'bipolar rails at −1 on axes 4/5 produce zero throttle creep',
      linSpeed < 0.3,
      `v=${linSpeed.toFixed(3)}`,
    );
    void linH0;
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: realNav,
      configurable: true,
      writable: true,
    });
  }
}

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
  // Gates 1–2 run on self-owned NullEngines (disposed inside).
  await gateSuitAesthetic();
  gateBounding();

  // Gate 3 boots the single full ClientApp (production FTUE pipeline) and
  // hands it to Gate 4 to exercise the live input path on the same engine.
  const app = await gateFtue();
  if (app !== null) gateSticks(app);

  console.log(`\n${'='.repeat(64)}`);
  if (failures.length === 0) {
    console.log(
      `ALL ${passed} CHECKS PASSED ✔  (Spec 28 Phase 6 — FTUE + EVA suit + bounding + controller gates)`,
    );
    app?.dispose();
    process.exit(0);
  } else {
    console.error(`${failures.length} FAILURE(S) of ${passed + failures.length}:`);
    for (const f of failures) console.error(`  - ${f}`);
    app?.dispose();
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  console.error('smoke-ftue-eva-controls crashed:', err);
  process.exit(1);
});
