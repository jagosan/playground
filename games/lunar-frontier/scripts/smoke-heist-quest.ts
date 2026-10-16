/**
 * Spec 26 Phase 4 verification probe: "Operation Gilded Serpent" quest flow.
 * Run: `npx tsx scripts/smoke-heist-quest.ts`  (exit code 0 == all green)
 *
 * Covers the Phase 4 task contract end to end:
 *
 *   A. Factory & Spec 26 §3.4 contract — 6 stages, verbatim Zero-Six briefings,
 *      spec Objective Keys, canonical anchors/rewards, option overrides.
 *   B. Heist ObjectiveType vocabulary + mid-heist save/restore legality.
 *   C. Hook unit progression — recordHeistTelemetry / recordHeistBoarded /
 *      recordHeistVaultCracked / recordHeistBailout /
 *      recordHeistContrabandDelivered advancing exactly the right stages,
 *      with garbage-input rejection and post-completion inertness.
 *   D. Comms + event stream — six narrations in order, stage/completion events.
 *   E. Live integration — a real TrainHeistDirector + HighSpeedMaglev pumped
 *      ClientApp-style (telemetry feed, boarding jump, 6 s hack, bailout,
 *      fence delivery) driving the quest end-to-end, plus loot cargo mass.
 *   F. Serialization — mid-heist autosave envelope, fresh-engine restore,
 *      current-stage comms replay, continuation to completion.
 *   G. Failure reset & re-attempt — director countdown-expiry FAILED never
 *      advances the quest, and after director.reset() the retry completes
 *      without double-firing already-earned objectives.
 *
 * Scene-free by contract: a bare `new HighSpeedMaglev()` (pure spline math)
 * drives every envelope; no Babylon engine is ever constructed.
 */
import { HighSpeedMaglev } from '../src/infrastructure/HighSpeedMaglev.ts';
import {
  QuestEngine,
  InMemoryQuestStorage,
  createOperationGildedSerpentQuest,
  validateQuestShape,
  GILDED_SERPENT_QUEST_ID,
  GILDED_SERPENT_REWARD_CREDITS,
  GILDED_SERPENT_REWARD_XP,
  CANYON_OVERLOOK_POSITION,
  CANYON_OVERLOOK_PROXIMITY_M,
  RUSTBELT_DOCKWORKS_ANCHOR,
  RUSTBELT_DOCKWORKS_PROXIMITY_M,
  HEIST_INTERCEPT_PROVEN_PHASES,
  QUEST_EVENTS,
  QUEST_PROGRESS_STORAGE_KEY,
  QUEST_SAVE_VERSION,
  type CommsDialogue,
  type QuestCompletedPayload,
  type StageAdvancedPayload,
} from '../src/client/QuestEngine.ts';
import {
  TrainHeistDirector,
  heistLootCargoKg,
  type HeistTelemetry,
} from '../src/quests/TrainHeistDirector.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(label); console.log(`  ✘ ${label} ${detail}`); }
}
const hFrame = () => 1 / 60;
type V3 = { x: number; y: number; z: number };
const vAdd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vSub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vScale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const vLen = (a: V3): number => Math.hypot(a.x, a.y, a.z);

/** Exact Spec 26 §3.4 comms briefings, verbatim. */
const SPEC_TRANSMISSIONS: readonly string[] = [
  'The Apex Express runs loaded tonight. Meet me at the canyon overlook.',
  'Train is inbound on Guideway 1. Match its speed on the service road!',
  "Now! Jump while you're in the pocket!",
  'Bypass the mag-locks and get the He-3 before they hit the terminal gate!',
  "Jump off! The Citadel's defense shield will vaporize you!",
  'You pulled it off! Bring the haul to RustBelt Dockworks before X-Corp locks down the sector.',
];
/** Spec 26 §3.4 Objective Keys (stage 6 carries REACH_DOCKWORKS as well). */
const SPEC_KEYS: readonly string[] = [
  'MEET_FIXER', 'INTERCEPT_CONVOY', 'BOARD_TRANSPORT', 'CRACK_VAULT',
  'LEAP_TO_SAFETY', 'DELIVER_CONTRABAND',
];

/** Synthetic director telemetry frame (outside the envelope by default). */
type TelemetryOverrides = Partial<Omit<HeistTelemetry, 'phase'>> & { phase?: string };
const tele = (over: TelemetryOverrides): HeistTelemetry => ({
  relativeSpeedMps: 25,
  lateralDistanceM: 100,
  longitudinalOffsetM: 0,
  canBoard: false,
  hackProgressFraction: 0,
  countdownRemainingS: 0,
  stolenCargoCount: 0,
  ...over,
  phase: (over.phase ?? 'INTERCEPTING') as HeistTelemetry['phase'],
});

/** Exact-magnitude lateral offset vector at the vault car (⊥ T̂). */
function trueLateral(v: { worldForward: V3 }, magnitude = 4): V3 {
  const f = v.worldForward;
  const raw = { x: 3, y: 3, z: 0 };
  const perp = vSub(raw, vScale(f, raw.x * f.x + raw.y * f.y + raw.z * f.z));
  return vScale(perp, magnitude / vLen(perp));
}

/** Board + crack a fresh director at the current (frozen) train state. */
function boardAndCrack(d: TrainHeistDirector, m: HighSpeedMaglev): boolean {
  const v = m.getVaultCarState()!;
  const rover = vAdd(v.worldPosition, trueLateral(v, 4));
  d.update(hFrame(), rover, v.speedMps);
  if (!d.executeBoardingJump()) return false;
  let cracked = false;
  for (let i = 0; i < 400 && !cracked; i++) cracked = d.interactVaultLock(hFrame());
  return cracked;
}

// ---------------------------------------------------------------------------
console.log('\n· A. factory & Spec 26 §3.4 contract');
{
  const quest = createOperationGildedSerpentQuest();
  check('quest id is operation-gilded-serpent',
    quest.id === GILDED_SERPENT_QUEST_ID && GILDED_SERPENT_QUEST_ID === 'operation-gilded-serpent');
  check('title is "Operation Gilded Serpent"', quest.title === 'Operation Gilded Serpent');
  check('six stages', quest.stages.length === 6, `${quest.stages.length}`);
  check('faction RUSTBELT / category export (fence economics)',
    quest.faction === 'RUSTBELT' && quest.category === 'export');
  check('factory quest passes the shape validator', validateQuestShape(quest));
  check('reward 70,000 cr (3×15k He-3 + 25k slate) / 2,500 xp',
    quest.rewardCredits === GILDED_SERPENT_REWARD_CREDITS &&
    GILDED_SERPENT_REWARD_CREDITS === 70_000 &&
    quest.rewardXp === GILDED_SERPENT_REWARD_XP && GILDED_SERPENT_REWARD_XP === 2_500);
  check('stage numbers are 1..6 sequential, none completed',
    quest.stages.every((s, i) => s.stageNumber === i + 1) && !quest.isCompleted);

  SPEC_TRANSMISSIONS.forEach((t, i) => {
    const n = quest.stages[i].storyNarration;
    check(`stage ${i + 1} comms briefing verbatim`, n.transmission === t, `got: ${n.transmission}`);
  });
  check('every narration is Zero-Six / RustBelt Fixer',
    quest.stages.every((s) =>
      s.storyNarration.sender === 'Zero-Six' && s.storyNarration.callsign === 'RustBelt Fixer'));

  const meet = quest.stages[0].objectives[0];
  check('stage 1 MEET_FIXER: reach_target @ (850, 620, 0), proximity 25 m',
    meet.id === SPEC_KEYS[0] && meet.type === 'reach_target' &&
    meet.targetPosition !== undefined &&
    meet.targetPosition.x === CANYON_OVERLOOK_POSITION.x && meet.targetPosition.x === 850 &&
    meet.targetPosition.y === CANYON_OVERLOOK_POSITION.y && meet.targetPosition.y === 620 &&
    meet.targetPosition.z === 0 &&
    meet.proximityM === CANYON_OVERLOOK_PROXIMITY_M && meet.proximityM === 25);

  check('stage 2–5 objective keys + heist types',
    quest.stages[1].objectives[0].id === SPEC_KEYS[1] && quest.stages[1].objectives[0].type === 'heist_intercept' &&
    quest.stages[2].objectives[0].id === SPEC_KEYS[2] && quest.stages[2].objectives[0].type === 'heist_board' &&
    quest.stages[3].objectives[0].id === SPEC_KEYS[3] && quest.stages[3].objectives[0].type === 'heist_crack_vault' &&
    quest.stages[4].objectives[0].id === SPEC_KEYS[4] && quest.stages[4].objectives[0].type === 'heist_bailout');
  const s6 = quest.stages[5].objectives;
  check('stage 6 = REACH_DOCKWORKS (reach_target @ dock) + DELIVER_CONTRABAND (heist_deliver)',
    s6.length === 2 &&
    s6[0].id === 'REACH_DOCKWORKS' && s6[0].type === 'reach_target' &&
    s6[0].targetPosition !== undefined &&
    s6[0].targetPosition.x === RUSTBELT_DOCKWORKS_ANCHOR.x &&
    s6[0].targetPosition.y === RUSTBELT_DOCKWORKS_ANCHOR.y &&
    s6[0].proximityM === RUSTBELT_DOCKWORKS_PROXIMITY_M &&
    s6[1].id === SPEC_KEYS[5] && s6[1].type === 'heist_deliver');
  check('every objective carries description/targetCount 1/fresh state',
    quest.stages.every((s) => s.objectives.every((o) =>
      o.description.length > 10 && o.targetCount === 1 && o.currentCount === 0 && !o.completed)));
  check('hint targets on stage 1 (overlook) + stage 6 (dockworks)',
    quest.stages[0].hintArrowTarget?.label === 'Canyon overlook' &&
    quest.stages[5].hintArrowTarget?.label === 'RustBelt Dockworks');

  const custom = createOperationGildedSerpentQuest({
    faction: 'HELIOS',
    overlookPosition: { x: 10, y: 20, z: 3 },
    overlookProximityM: 40,
    dockworksPosition: { x: -1, y: -2, z: 0 },
  });
  check('option overrides: faction, overlook (+radius), dockworks seat',
    custom.faction === 'HELIOS' &&
    custom.stages[0].objectives[0].targetPosition!.x === 10 &&
    custom.stages[0].objectives[0].proximityM === 40 &&
    custom.stages[5].objectives[0].targetPosition!.x === -1 &&
    custom.stages[5].objectives[0].targetPosition!.y === -2);
  const junk = createOperationGildedSerpentQuest({ overlookProximityM: NaN });
  check('junk overlookProximityM falls back to 25 m',
    junk.stages[0].objectives[0].proximityM === 25);
}

// ---------------------------------------------------------------------------
console.log('\n· B. heist ObjectiveType vocabulary & mid-heist save legality');
{
  const quest = createOperationGildedSerpentQuest();
  check('validateQuestShape accepts every heist objective type',
    quest.stages.every((s) => s.objectives.every((o) => validateQuestShape({
      ...quest, stages: [{ ...s, stageNumber: 1 }],
    }))));
  const proven =
    HEIST_INTERCEPT_PROVEN_PHASES.has('BOARDING_WINDOW') &&
    HEIST_INTERCEPT_PROVEN_PHASES.has('ON_BOARD_CRACKING') &&
    HEIST_INTERCEPT_PROVEN_PHASES.has('LOOT_SECURED') &&
    HEIST_INTERCEPT_PROVEN_PHASES.has('DEPOT_COUNTDOWN') &&
    HEIST_INTERCEPT_PROVEN_PHASES.has('BAILOUT_SUCCESS') &&
    HEIST_INTERCEPT_PROVEN_PHASES.has('ESCAPE_COMPLETE');
  check('proven-phase set covers BOARDING_WINDOW…ESCAPE_COMPLETE', proven);
  check('proven-phase set excludes FAILED / INTERCEPTING / INACTIVE',
    !HEIST_INTERCEPT_PROVEN_PHASES.has('FAILED') &&
    !HEIST_INTERCEPT_PROVEN_PHASES.has('INTERCEPTING') &&
    !HEIST_INTERCEPT_PROVEN_PHASES.has('INACTIVE'));

  // Heist-flavoured objective types survive a JSON round-trip validation.
  const round = JSON.parse(JSON.stringify(quest));
  check('JSON round-trip still passes the shape validator', validateQuestShape(round));
}

// ---------------------------------------------------------------------------
console.log('\n· C. action-hook progression (unit level)');
{
  const engine = new QuestEngine({ storage: new InMemoryQuestStorage(), autosave: false });
  engine.startQuest(createOperationGildedSerpentQuest());

  // Stage 1: every heist hook is inert (no matching objective yet).
  check('stage 1: recordHeistTelemetry(canBoard) inert',
    engine.recordHeistTelemetry(tele({ canBoard: true, phase: 'BOARDING_WINDOW' })) === false);
  check('stage 1: recordHeistBoarded inert', engine.recordHeistBoarded() === false);
  check('stage 1: recordHeistVaultCracked inert', engine.recordHeistVaultCracked(6) === false);
  check('stage 1: recordHeistBailout inert', engine.recordHeistBailout() === false);
  check('stage 1: recordHeistContrabandDelivered inert',
    engine.recordHeistContrabandDelivered() === false);
  check('stage 1 still active after inert hooks', engine.getActiveStage()!.stageNumber === 1);

  // Stage 1 completion: 26 m outside / exactly 25 m at the overlook.
  check('overlook: 26 m away ignored',
    engine.recordPosition({ x: 876, y: 620, z: 0 }) === false &&
    engine.getActiveStage()!.stageNumber === 1);
  check('overlook: exactly 25 m (inclusive) arrives → stage 2',
    engine.recordPosition({ x: 875, y: 620, z: 0 }) === true &&
    engine.getActiveStage()!.stageNumber === 2);

  // Stage 2: only matched telemetry completes INTERCEPT_CONVOY.
  check('stage 2: unmatched frame ignored',
    engine.recordHeistTelemetry(tele({ phase: 'INTERCEPTING', canBoard: false })) === false &&
    engine.getActiveStage()!.stageNumber === 2);
  check('stage 2: FAILED phase never completes (depot beat us)',
    engine.recordHeistTelemetry(tele({ phase: 'FAILED', canBoard: false })) === false &&
    engine.getActiveStage()!.stageNumber === 2);
  check('stage 2: null / undefined telemetry rejected',
    engine.recordHeistTelemetry(null) === false &&
    engine.recordHeistTelemetry(undefined) === false);
  check('stage 2: garbage phase string ignored',
    engine.recordHeistTelemetry(tele({ phase: 'WET_PAINT' })) === false &&
    engine.getActiveStage()!.stageNumber === 2);
  check('stage 2: canBoard → INTERCEPT_CONVOY completes → stage 3',
    engine.recordHeistTelemetry(tele({ canBoard: true, phase: 'BOARDING_WINDOW' })) === true &&
    engine.getActiveStage()!.stageNumber === 3);

  // Stage 3: the boarding jump.
  check('stage 3: recordHeistBoarded → stage 4',
    engine.recordHeistBoarded() === true && engine.getActiveStage()!.stageNumber === 4);
  check('stage 3: second boarding event is a no-op', engine.recordHeistBoarded() === false);

  // Stage 4: crack with stolenCount validation.
  check('stage 4: NaN stolenCount rejected', engine.recordHeistVaultCracked(NaN) === false);
  check('stage 4: negative stolenCount rejected', engine.recordHeistVaultCracked(-2) === false);
  check('stage 4 still CRACK_VAULT after rejects',
    engine.getActiveStage()!.objectives[0].id === 'CRACK_VAULT');
  check('stage 4: recordHeistVaultCracked() → stage 5',
    engine.recordHeistVaultCracked() === true && engine.getActiveStage()!.stageNumber === 5);
  check('stage 4: repeat crack (count 6) is a no-op', engine.recordHeistVaultCracked(6) === false);

  // Stage 5: the bailout.
  check('stage 5: recordHeistBailout → stage 6',
    engine.recordHeistBailout() === true && engine.getActiveStage()!.stageNumber === 6);

  // Stage 6: the fence event alone does NOT complete (dock reach pending)…
  check('stage 6: delivery completes DELIVER_CONTRABAND, stage still live',
    engine.recordHeistContrabandDelivered() === true &&
    engine.getActiveStage()!.stageNumber === 6 &&
    engine.getActiveQuest()!.isCompleted === false);
  check('stage 6: second delivery is a no-op', engine.recordHeistContrabandDelivered() === false);
  check('stage 6: dockworks 31 m away ignored',
    engine.recordPosition({ x: RUSTBELT_DOCKWORKS_ANCHOR.x + 31, y: RUSTBELT_DOCKWORKS_ANCHOR.y, z: 0 }) === false);
  check('stage 6: dock reach completes the quest',
    engine.recordPosition({ ...RUSTBELT_DOCKWORKS_ANCHOR }) === true &&
    engine.getActiveQuest()!.isCompleted === true);

  // Post-completion: every heist hook is inert.
  check('post-completion: all five heist hooks inert',
    engine.recordHeistTelemetry(tele({ canBoard: true })) === false &&
    engine.recordHeistBoarded() === false &&
    engine.recordHeistVaultCracked(6) === false &&
    engine.recordHeistBailout() === false &&
    engine.recordHeistContrabandDelivered() === false);
}

// ---------------------------------------------------------------------------
console.log('\n· D. comms & event stream');
{
  const busEvents: string[] = [];
  const engine = new QuestEngine({
    storage: new InMemoryQuestStorage(),
    autosave: false,
    bus: { emit: (e) => busEvents.push(e) },
  });
  const comms: CommsDialogue[] = [];
  const advances: StageAdvancedPayload[] = [];
  let completed: QuestCompletedPayload | null = null;
  engine.onCommsReceived((d) => comms.push(d));
  engine.onStageAdvanced((p) => advances.push(p));
  engine.onQuestCompleted((p) => { completed = p; });

  engine.startQuest(createOperationGildedSerpentQuest());
  check('opening comms = stage-1 Zero-Six briefing',
    comms.length === 1 && comms[0].transmission === SPEC_TRANSMISSIONS[0] && comms[0].audioTone === 'burst');

  engine.recordPosition({ x: 875, y: 620, z: 0 });
  engine.recordHeistTelemetry(tele({ canBoard: true }));
  engine.recordHeistBoarded();
  engine.recordHeistVaultCracked(6);
  engine.recordHeistBailout();
  check('five stage comms delivered in spec order',
    comms.length === 6 &&
    SPEC_TRANSMISSIONS.every((t, i) => comms[i].transmission === t));
  check('stage 6 comms tone is success ("You pulled it off!")',
    comms[5].audioTone === 'success');

  engine.recordPosition({ ...RUSTBELT_DOCKWORKS_ANCHOR });
  engine.recordHeistContrabandDelivered();
  check('six stageAdvanced events, last is completion (stage null, toIndex 6)',
    advances.length === 6 && advances[5].questCompleted === true && advances[5].stage === null &&
    advances[5].toStageIndex === 6);
  const done = completed as QuestCompletedPayload | null;
  check('QUEST_COMPLETED fired once with the 70k bounty',
    done !== null && done.rewardCredits === 70_000 && done.rewardXp === 2_500);
  check('bus saw OBJECTIVE_UPDATED / STAGE_ADVANCED / QUEST_COMPLETED / COMMS',
    busEvents.includes(QUEST_EVENTS.objectiveUpdated) &&
    busEvents.includes(QUEST_EVENTS.stageAdvanced) &&
    busEvents.includes(QUEST_EVENTS.questCompleted) &&
    busEvents.includes(QUEST_EVENTS.commsReceived));
}

// ---------------------------------------------------------------------------
console.log('\n· E. live TrainHeistDirector + maglev integration (ClientApp-style pump)');
{
  const maglev = new HighSpeedMaglev();
  for (let i = 0; i < 750; i++) maglev.update(hFrame()); // 12.5 s → cruise 25.0 m/s
  const d = new TrainHeistDirector(maglev, null); // no citadel: isolate the clock law
  check('director starts INTERCEPTING', d.startHeist() === true && d.getPhase() === 'INTERCEPTING');

  const engine = new QuestEngine({ storage: new InMemoryQuestStorage(), autosave: false });
  engine.startQuest(createOperationGildedSerpentQuest());
  engine.recordPosition({ x: 875, y: 620, z: 0 }); // meet the fixer
  check('meet-fixer stage cleared before the chase', engine.getActiveStage()!.stageNumber === 2);

  // Pump frames outside the envelope: the intercept objective holds.
  for (let i = 0; i < 30; i++) {
    engine.recordHeistTelemetry(d.update(hFrame(), { x: 0, y: 0, z: 0 }, 0));
  }
  check('30 far frames: intercept objective holds at stage 2',
    engine.getActiveStage()!.stageNumber === 2);

  // Envelope frame → stage 2 completes; then the High-Speed Jump lands.
  const v = maglev.getVaultCarState()!;
  const tPocket = d.update(hFrame(), vAdd(v.worldPosition, trueLateral(v, 4)), v.speedMps);
  check('pocket frame: director canBoard', tPocket.canBoard === true);
  engine.recordHeistTelemetry(tPocket);
  check('stage 2 → 3 via live telemetry', engine.getActiveStage()!.stageNumber === 3);
  check('executeBoardingJump lands', d.executeBoardingJump() === true);
  engine.recordHeistBoarded();
  check('stage 3 → 4 via recordHeistBoarded', engine.getActiveStage()!.stageNumber === 4);
  const tDeck = d.update(hFrame(), d.getPlayerWorldPos(), d.getBailoutExitVelocity());
  check('canBoard suppressed while riding the deck', tDeck.canBoard === false);

  // Mag-Lock bypass: canonical 6.0 s hold-to-hack at 60 Hz.
  let cracked = false;
  let frames = 0;
  while (!cracked && frames < 1000) { cracked = d.interactVaultLock(hFrame()); frames++; }
  check('hack pops on frame 360 (6.0 s @ 60 Hz)', cracked && frames === 360, `frames=${frames}`);
  check('loot payload = 6 items', d.getStolenCargoCount() === 6);
  engine.recordHeistVaultCracked(d.getStolenCargoCount());
  check('stage 4 → 5 via recordHeistVaultCracked(6)', engine.getActiveStage()!.stageNumber === 5);

  // LOOT_SECURED hands off to DEPOT_COUNTDOWN on the next director tick
  // (Phase 3 law); only the countdown state accepts the Leap of Faith.
  const tArmed = d.update(hFrame(), d.getPlayerWorldPos(), d.getBailoutExitVelocity());
  check('alarm handoff: DEPOT_COUNTDOWN armed at T-44.0',
    d.getPhase() === 'DEPOT_COUNTDOWN' && tArmed.countdownRemainingS === 44.0);
  // The Leap of Faith.
  check('bailout fires inside the countdown window', d.executeBailoutJump() === true);
  engine.recordHeistBailout();
  check('stage 5 → 6 via recordHeistBailout', engine.getActiveStage()!.stageNumber === 6);

  // Loot cargo mass (Phase 4 handoff law): canonical table totals 24 kg.
  const kg = heistLootCargoKg(d.getLootPayload());
  check('canonical payload cargo mass is exactly 24 kg', kg === 24, `${kg}`);
  check('empty payload weighs 0 kg',
    heistLootCargoKg({ he3CryoFlasks: 0, quantumCipherSlates: 0, superconductingCoils: 0 }) === 0);
  check('NaN/negative counts hardened (1 coil = 5.5 kg)',
    heistLootCargoKg({ he3CryoFlasks: NaN, quantumCipherSlates: -3, superconductingCoils: 1 }) === 5.5);

  // Delivery: fence event, then the dockworks marker completes the run.
  engine.recordHeistContrabandDelivered();
  check('stage 6 delivery event accepted (reach still pending)',
    engine.getActiveStage()!.stageNumber === 6 && engine.getActiveQuest()!.isCompleted === false);
  engine.recordPosition({ x: RUSTBELT_DOCKWORKS_ANCHOR.x + 5, y: RUSTBELT_DOCKWORKS_ANCHOR.y, z: 0 });
  check('live-run quest completes at the fence', engine.getActiveQuest()!.isCompleted === true);
  check('finishEscape closes the director (ESCAPE_COMPLETE)',
    d.finishEscape() === true && d.getPhase() === 'ESCAPE_COMPLETE');
}

// ---------------------------------------------------------------------------
console.log('\n· F. mid-heist serialization, restore & replay');
{
  const store = new InMemoryQuestStorage();
  const dock = { x: 1000, y: -1500, z: 0 };
  const engine1 = new QuestEngine({ storage: store });
  engine1.startQuest(createOperationGildedSerpentQuest({ dockworksPosition: dock }));
  engine1.recordPosition({ x: 875, y: 620, z: 0 });
  engine1.recordHeistTelemetry(tele({ canBoard: true }));
  engine1.recordHeistBoarded();
  // Now stage 4 (CRACK_VAULT) is live; autosave has been writing all along.
  const raw = store.getItem(QUEST_PROGRESS_STORAGE_KEY);
  check('autosave envelope exists under the canonical key', raw !== null);
  const env = JSON.parse(raw ?? '{}');
  check('envelope version + quest id + stage index 3 (CRACK live)',
    env.version === QUEST_SAVE_VERSION &&
    env.quest?.id === GILDED_SERPENT_QUEST_ID &&
    env.quest?.currentStageIndex === 3);
  check('heist objective types survive JSON (shape-valid save)', validateQuestShape(env.quest));
  const savedCrack = env.quest.stages[3].objectives[0];
  check('saved CRACK_VAULT objective is still open', savedCrack.completed === false);

  const engine2 = new QuestEngine({ storage: store });
  check('fresh engine restores the mid-heist save', engine2.restoreProgress() === true);
  check('restored quest sits at stage 4', engine2.getActiveStage()!.stageNumber === 4);
  const replay: CommsDialogue[] = [];
  engine2.onCommsReceived((d2) => replay.push(d2));
  engine2.startQuest(engine2.getActiveQuest()!);
  check('reload replays the CURRENT stage comms (mag-locks), not stage 1',
    replay.length === 1 && replay[0].transmission === SPEC_TRANSMISSIONS[3]);

  // Continue the heist on the restored engine through to the fence.
  engine2.recordHeistVaultCracked(6);
  engine2.recordHeistBailout();
  check('restored run reaches stage 6', engine2.getActiveStage()!.stageNumber === 6);
  check('custom dockworks seat survived the save',
    engine2.getActiveStage()!.objectives[0].targetPosition!.x === 1000);
  engine2.recordPosition({ ...dock });
  engine2.recordHeistContrabandDelivered();
  check('restored run completes at the custom fence', engine2.getActiveQuest()!.isCompleted === true);
}

// ---------------------------------------------------------------------------
console.log('\n· G. failure reset & re-attempt');
{
  const maglev2 = new HighSpeedMaglev();
  for (let i = 0; i < 750; i++) maglev2.update(hFrame());
  const d = new TrainHeistDirector(maglev2, null);
  const engine = new QuestEngine({ storage: new InMemoryQuestStorage(), autosave: false });
  engine.startQuest(createOperationGildedSerpentQuest());
  d.startHeist();

  engine.recordPosition({ x: 875, y: 620, z: 0 });
  engine.recordHeistTelemetry(tele({ canBoard: true }));
  check('pre-failure run sits at stage 3', engine.getActiveStage()!.stageNumber === 3);
  engine.recordHeistBoarded();
  check('pre-failure run sits at stage 4', engine.getActiveStage()!.stageNumber === 4);
  check('crack succeeds pre-failure', boardAndCrack(d, maglev2) === true);
  engine.recordHeistVaultCracked(d.getStolenCargoCount());
  check('stage 4 objective survives the coming failure',
    engine.getActiveStage()!.stageNumber === 5 &&
    engine.getActiveQuest()!.stages[3].objectives[0].completed === true);

  // Vaporization: drain the 44 s countdown (citadel-less: only the clock kills).
  let ticks = 0;
  while ((d.getPhase() === 'LOOT_SECURED' || d.getPhase() === 'DEPOT_COUNTDOWN') && ticks < 3000) {
    d.update(hFrame(), { x: 0, y: 0, z: 0 }, 0);
    ticks++;
  }
  check('countdown expiry FAILED the director run', d.getPhase() === 'FAILED');
  check('quest never advanced past LEAP_TO_SAFETY on failure',
    engine.getActiveStage()!.stageNumber === 5 && engine.getActiveQuest()!.isCompleted === false);
  check('FAILED telemetry never completes pending objectives',
    engine.recordHeistTelemetry(tele({ phase: 'FAILED', canBoard: true })) === false);

  // Re-attempt: director resets; already-earned objectives never re-fire.
  d.reset();
  check('director.reset() returns to INACTIVE', d.getPhase() === 'INACTIVE');
  check('retry: startHeist re-arms', d.startHeist() === true);
  const v2 = maglev2.getVaultCarState()!;
  d.update(hFrame(), vAdd(v2.worldPosition, trueLateral(v2, 4)), v2.speedMps);
  check('retry: boarding jump lands again', d.executeBoardingJump() === true);
  check('retry: recordHeistBoarded no longer re-fires (already earned)',
    engine.recordHeistBoarded() === false);
  let cracked2 = false;
  for (let i = 0; i < 400 && !cracked2; i++) cracked2 = d.interactVaultLock(hFrame());
  check('retry: vault re-cracks from scratch (loot re-armed)', cracked2 === true);
  check('retry: recordHeistVaultCracked no longer re-fires',
    engine.recordHeistVaultCracked(6) === false);
  d.update(hFrame(), { x: 0, y: 0, z: 0 }, 0); // LOOT_SECURED → DEPOT_COUNTDOWN handoff
  check('retry: bailout completes stage 5 → 6',
    d.executeBailoutJump() === true &&
    engine.recordHeistBailout() === true &&
    engine.getActiveStage()!.stageNumber === 6);
  engine.recordPosition({ ...RUSTBELT_DOCKWORKS_ANCHOR });
  engine.recordHeistContrabandDelivered();
  check('retry run completes the whole operation', engine.getActiveQuest()!.isCompleted === true);
  check('retry closes out the director escape',
    d.finishEscape() === true && d.getPhase() === 'ESCAPE_COMPLETE');
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED`);
  process.exit(0);
} else {
  console.log(`${failures.length} FAILURES of ${passed + failures.length}:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
