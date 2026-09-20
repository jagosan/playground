/**
 * Spec 18 Phase 1 smoke test — QuestEngine core & state machine.
 *
 * Runs headless under tsx (`npx tsx scripts/smoke-quest-engine.ts`) and
 * exits 0 only when every assertion passes. Exercises:
 *
 *   A. Data-model factory      — canonical 5-stage tutorial shape (Spec 18 §5)
 *   B. Objective evaluation    — move/drive/mine/board/trade/reach accumulation
 *   C. Stage machine & events  — OBJECTIVE_UPDATED, STAGE_ADVANCED, COMPLETED, comms
 *   D. Persistence             — save/restore round-trip, corrupt-save rejection,
 *                                headless in-memory fallback (no window/localStorage)
 *   E. Hint arrow support      — target resolution + bearing/distance readout
 *   F. Debug helpers & reset   — jump, force-complete, wipe
 */

import assert from 'node:assert';

import {
  QuestEngine,
  InMemoryQuestStorage,
  QUEST_EVENTS,
  QUEST_PROGRESS_STORAGE_KEY,
  QUEST_SAVE_VERSION,
  DEFAULT_REACH_RADIUS_M,
  createTutorialQuest,
  validateQuestShape,
  type CommsDialogue,
  type Quest,
  type QuestCompletedPayload,
  type StageAdvancedPayload,
  type ObjectiveUpdatedPayload,
} from '../src/client/QuestEngine.ts';

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ✓ ${label}`);
}

// ---------------------------------------------------------------------------
console.log('--- A. Tutorial quest factory (Spec 18 §5) ---');
{
  const quest = createTutorialQuest();
  assert.strictEqual(quest.title, 'A One-Way Ticket to the Frontier');
  assert.strictEqual(quest.category, 'tutorial');
  assert.strictEqual(quest.stages.length, 5);
  assert.strictEqual(quest.rewardCredits, 500);
  assert.strictEqual(quest.isCompleted, false);
  assert.strictEqual(quest.currentStageIndex, 0);
  assert.ok(validateQuestShape(quest), 'factory quest passes shape validator');

  const titles = quest.stages.map((s) => s.stageTitle);
  assert.deepStrictEqual(titles, [
    'Boots on the Ground',
    'Scanner Calibration & Mineral Prospecting',
    'Surface Extraction & Ilmenite Harvesting',
    'Vehicle Requisition & Cockpit Familiarization',
    'The First Haul & Frontier Exchange',
  ]);
  // Stage numbers are 1-based sequential; every stage narrates + has a hint.
  quest.stages.forEach((s, i) => {
    assert.strictEqual(s.stageNumber, i + 1);
    assert.ok(s.storyNarration.transmission.length > 20);
    assert.ok(s.storyNarration.callsign.length > 0);
    assert.ok(s.hintArrowTarget !== undefined, `stage ${i + 1} has hint target`);
    assert.ok(s.objectives.length >= 1);
  });
  // Objective types used map to the spec vocabulary.
  const types = new Set(quest.stages.flatMap((s) => s.objectives.map((o) => o.type)));
  for (const t of ['move_distance', 'reach_target', 'extract_mineral', 'board_buggy', 'trade_commodity']) {
    assert.ok(types.has(t as never), `objective type ${t} present in tutorial`);
  }
  ok('canonical quest shape, titles, comms, hints, reward');
}

// ---------------------------------------------------------------------------
console.log('--- B. Objective evaluation & action hooks ---');
{
  const engine = new QuestEngine({ storage: new InMemoryQuestStorage(), autosave: false });
  engine.startQuest(createTutorialQuest());

  // Stage 1: move_distance accumulates, partial progress does NOT advance.
  assert.strictEqual(engine.recordMoveDistance(4), true);
  assert.strictEqual(engine.getActiveStage()!.stageNumber, 1);
  const obj = engine.getActiveStage()!.objectives[0];
  assert.ok(Math.abs(obj.currentCount - 4) < 1e-9);
  assert.strictEqual(obj.completed, false);
  assert.strictEqual(engine.recordMoveDistance(-3), false, 'negative distance ignored');
  assert.strictEqual(engine.recordMoveDistance(0), false, 'zero distance ignored');
  assert.strictEqual(engine.recordMoveDistance(NaN), false, 'NaN ignored');

  // Buggy distance must NOT feed the on-foot move objective.
  assert.strictEqual(engine.recordMoveDistance(50, true), false, 'drive distance ignored by move objective');
  assert.ok(Math.abs(obj.currentCount - 4) < 1e-9);

  // Finish stage 1 in 6 more metres.
  engine.recordMoveDistance(3);
  engine.recordMoveDistance(3);
  assert.strictEqual(engine.getActiveStage()!.stageNumber, 2);
  ok('move_distance accumulation, clamping, buggy/foot separation');

  // Stage 2: reach_target with 6 m radius — near-miss then arrival.
  const vein = createTutorialQuest().stages[1].objectives[0].targetPosition!;
  assert.strictEqual(vein.y - 0 > 0, true);
  assert.strictEqual(engine.recordPosition({ x: vein.x + 20, y: vein.y, z: 0 }), false, 'far position ignored');
  assert.strictEqual(engine.recordPosition({ x: vein.x + 7, y: vein.y, z: 0 }), false, '7m outside 6m radius');
  assert.strictEqual(engine.getActiveStage()!.stageNumber, 2);
  assert.strictEqual(engine.recordPosition({ x: vein.x + 5, y: vein.y + 2, z: 50 }), true, 'horizontal distance ignores z');
  assert.strictEqual(engine.getActiveStage()!.stageNumber, 3);
  ok(`reach_target proximity (${DEFAULT_REACH_RADIUS_M} m, horizontal)`);

  // Stage 3: extract_mineral with kind filter + fractional kg accumulation.
  assert.strictEqual(engine.recordMineralMined('water_ice', 10), false, 'wrong kind ignored');
  assert.strictEqual(engine.recordMineralMined('regolith', 7.5), true);
  const mine = engine.getActiveStage()!.objectives[0];
  assert.ok(Math.abs(mine.currentCount - 7.5) < 1e-9);
  engine.recordMineralMined('regolith', 100); // overshoot clamps to target
  assert.strictEqual(engine.getActiveStage()!.stageNumber, 4);
  ok('extract_mineral kind filter, fractional kg, overshoot clamp');

  // Stage 4: board_buggy.
  assert.strictEqual(engine.recordBuggyBoarded(), true);
  assert.strictEqual(engine.getActiveStage()!.stageNumber, 5);
  ok('board_buggy advances');

  // Stage 5: reach terminal, then kind-filtered trade.
  const term = createTutorialQuest().stages[4].objectives[0].targetPosition!;
  assert.strictEqual(engine.recordPosition({ x: term.x, y: term.y, z: term.z }), true);
  assert.strictEqual(engine.getActiveStage()!.stageNumber, 5, 'still stage 5 — trade pending');
  assert.strictEqual(engine.recordTrade('helium_3', 5), false, 'wrong commodity ignored');
  assert.strictEqual(engine.recordTrade('regolith', 20), true);
  assert.strictEqual(engine.getActiveQuest()!.isCompleted, true);
  ok('trade_commodity completion completes quest');

  // Post-completion hooks are inert.
  assert.strictEqual(engine.recordMoveDistance(100), false);
  assert.strictEqual(engine.recordBuggyBoarded(), false);
  ok('action hooks inert after completion');
}

// ---------------------------------------------------------------------------
console.log('--- C. Event bus & callbacks ---');
{
  const busEvents: string[] = [];
  const engine = new QuestEngine({
    storage: new InMemoryQuestStorage(),
    bus: { emit: (e) => busEvents.push(e) },
  });
  const commsLog: CommsDialogue[] = [];
  const stageAdvances: StageAdvancedPayload[] = [];
  let completed: QuestCompletedPayload | null = null;
  let objectiveUpdates = 0;

  engine.onCommsReceived((d) => commsLog.push(d));
  engine.onStageAdvanced((p) => stageAdvances.push(p));
  engine.onQuestCompleted((p) => (completed = p));
  engine.onObjectiveUpdated((p: ObjectiveUpdatedPayload) => {
    assert.ok(p.progress > 0 && p.progress <= 1);
    objectiveUpdates++;
  });

  engine.startQuest(createTutorialQuest());
  assert.strictEqual(commsLog.length, 1, 'opening comms delivered on start');
  assert.ok(commsLog[0].transmission.includes('Contractor 7-Echo'));
  assert.strictEqual(commsLog[0].audioTone, 'burst');

  engine.debugAdvanceStage(); // stage 1 -> 2
  assert.strictEqual(stageAdvances.length, 1);
  assert.strictEqual(stageAdvances[0].fromStageIndex, 0);
  assert.strictEqual(stageAdvances[0].toStageIndex, 1);
  assert.strictEqual(commsLog.length, 2, 'stage-2 comms delivered on advance');

  engine.debugCompleteQuest();
  assert.ok(completed !== null, 'completion event fired');
  assert.strictEqual(completed!.rewardCredits, 500);
  assert.strictEqual(engine.getActiveQuest()!.isCompleted, true);
  assert.ok(objectiveUpdates > 0, 'objective updates emitted');

  assert.ok(busEvents.includes(QUEST_EVENTS.objectiveUpdated));
  assert.ok(busEvents.includes(QUEST_EVENTS.stageAdvanced));
  assert.ok(busEvents.includes(QUEST_EVENTS.questCompleted));
  assert.ok(busEvents.includes(QUEST_EVENTS.commsReceived));
  ok('typed callbacks + bus events (OBJECTIVE_UPDATED / STAGE_ADVANCED / COMPLETED / COMMS)');

  // Unsubscribe works.
  const off = engine.onCommsReceived(() => assert.fail('unsubscribed listener fired'));
  off();
  engine.resetProgress();
  engine.startQuest(createTutorialQuest());
  ok('listener unsubscribe');
}

// ---------------------------------------------------------------------------
console.log('--- D. Persistence (lunar_frontier_quest_progress) ---');
{
  const store = new InMemoryQuestStorage();
  const engine = new QuestEngine({ storage: store }); // autosave on
  engine.startQuest(createTutorialQuest());
  engine.recordMoveDistance(6);
  engine.debugAdvanceStage(); // into stage 2 with saved state

  const raw = store.getItem(QUEST_PROGRESS_STORAGE_KEY);
  assert.ok(raw !== null, 'save exists under canonical key');
  const envelope = JSON.parse(raw!);
  assert.strictEqual(envelope.version, QUEST_SAVE_VERSION);
  assert.ok(envelope.quest.stages.length === 5);
  ok(`autosave to localStorage key '${QUEST_PROGRESS_STORAGE_KEY}'`);

  // Fresh engine (simulated page refresh) restores mid-quest state.
  const engine2 = new QuestEngine({ storage: store });
  assert.strictEqual(engine2.getActiveQuest(), null);
  assert.strictEqual(engine2.restoreProgress(), true);
  const restored = engine2.getActiveQuest()!;
  assert.strictEqual(restored.id, 'quest_one_way_ticket');
  assert.strictEqual(restored.currentStageIndex, 1);
  assert.strictEqual(restored.stages[0].objectives[0].completed, true);
  assert.strictEqual(engine2.getActiveStage()!.stageNumber, 2);

  // Restored state is a deep copy — mutating it must not alias the raw save.
  restored.stages[1].objectives[0].currentCount = 999;
  assert.notStrictEqual(JSON.parse(store.getItem(QUEST_PROGRESS_STORAGE_KEY)!).quest.stages[1].objectives[0].currentCount, 999);
  ok('restore round-trip + deep-copy isolation');

  // Corrupt save fails closed.
  const store3 = new InMemoryQuestStorage();
  store3.setItem(QUEST_PROGRESS_STORAGE_KEY, '{not json!!');
  assert.strictEqual(new QuestEngine({ storage: store3 }).restoreProgress(), false);

  // Shape-invalid but valid JSON fails closed.
  store3.setItem(QUEST_PROGRESS_STORAGE_KEY, JSON.stringify({ version: QUEST_SAVE_VERSION, quest: { id: 'x' } }));
  assert.strictEqual(new QuestEngine({ storage: store3 }).restoreProgress(), false);

  // Foreign version fails closed.
  store3.setItem(QUEST_PROGRESS_STORAGE_KEY, JSON.stringify({ version: 999, quest: createTutorialQuest() }));
  assert.strictEqual(new QuestEngine({ storage: store3 }).restoreProgress(), false);
  ok('corrupt / shape-invalid / foreign-version saves rejected');

  // resetProgress wipes both memory and storage.
  const engine4 = new QuestEngine({ storage: store });
  engine4.restoreProgress();
  engine4.resetProgress();
  assert.strictEqual(engine4.getActiveQuest(), null);
  assert.strictEqual(store.getItem(QUEST_PROGRESS_STORAGE_KEY), null);
  ok('resetProgress clears storage');
}

// ---------------------------------------------------------------------------
console.log('--- D2. Headless fallback (no window / localStorage) ---');
{
  // This smoke run itself has no DOM, but simulate a runtime that DOES expose
  // a throwing localStorage (Safari private mode) and one that is undefined.
  const g = globalThis as { localStorage?: unknown };
  const hadLocalStorage = 'localStorage' in g;
  const original = g.localStorage;

  // Case 1: localStorage undefined -> in-memory fallback, no throw.
  delete g.localStorage;
  {
    const engine = new QuestEngine(); // detectStorage path
    engine.startQuest(createTutorialQuest());
    assert.strictEqual(engine.saveProgress(), true, 'headless save via fallback');
    engine.debugAdvanceStage();
    const engine2 = new QuestEngine();
    // NOTE: separate fallback instances are independent (per-engine memory),
    // which is the documented headless contract — restore on a NEW engine with
    // a NEW fallback finds nothing, but the SAME engine round-trips:
    assert.strictEqual(engine.restoreProgress(), true, 'same-engine headless round-trip');
    void engine2;
    ok('undefined localStorage -> silent in-memory fallback');
  }

  // Case 2: localStorage throws on write -> probe fails -> fallback used.
  g.localStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  {
    const engine = new QuestEngine();
    engine.startQuest(createTutorialQuest());
    assert.strictEqual(engine.saveProgress(), true, 'throws bypassed via probe fallback');
    ok('throwing localStorage -> probe rejects it, engine survives');
  }

  if (hadLocalStorage) g.localStorage = original; else delete g.localStorage;
}

// ---------------------------------------------------------------------------
console.log('--- E. Hint arrow target & nav readout ---');
{
  const engine = new QuestEngine({ storage: new InMemoryQuestStorage() });
  engine.startQuest(createTutorialQuest());
  const hint1 = engine.getHintArrowTarget();
  assert.ok(hint1 !== null);
  assert.ok(hint1!.label.length > 0);

  // Bearing: target due north (+y) of origin => 0°; due east (+x) => 90°.
  const reading = engine.computeHintReading({ x: 0, y: 0, z: 0 })!;
  assert.ok(Number.isFinite(reading.bearingDeg) && reading.bearingDeg >= 0 && reading.bearingDeg < 360);
  const north = engine.computeHintReading({ x: 0, y: -100, z: 0 })!;
  assert.ok(Math.abs(north.bearingDeg) < 1e-6, `due-north bearing ~0°, got ${north.bearingDeg}`);

  // Distance grows as you walk away.
  const far = engine.computeHintReading({ x: 0, y: -1000, z: 0 })!;
  assert.ok(far.distanceM > reading.distanceM);

  // Hint target follows stage advances.
  engine.debugAdvanceStage();
  const hint2 = engine.getHintArrowTarget();
  assert.notStrictEqual(hint2!.label, hint1!.label);
  ok('hint target + bearing/distance readout track stages');
}

// ---------------------------------------------------------------------------
console.log('--- F. Debug overrides ---');
{
  const engine = new QuestEngine({ storage: new InMemoryQuestStorage() });
  engine.startQuest(createTutorialQuest());

  assert.strictEqual(engine.debugJumpToStage(3), true);
  assert.strictEqual(engine.getActiveStage()!.stageNumber, 4);
  assert.strictEqual(engine.debugJumpToStage(42), true, 'clamped to last stage');
  assert.strictEqual(engine.getActiveStage()!.stageNumber, 5);
  assert.strictEqual(engine.debugJumpToStage(4), false, 'same index is a no-op');

  assert.strictEqual(engine.debugCompleteQuest(), true);
  assert.strictEqual(engine.debugCompleteQuest(), false, 'second completion is a no-op');
  assert.ok(engine.getProgress() === 1);
  ok('debugJumpToStage / debugCompleteQuest / progress');

  // debugGetState exposes engine + storage snapshot.
  const snap = engine.debugGetState();
  assert.ok(snap.active !== null && snap.active.isCompleted);
  assert.ok(snap.storageRaw !== null);
  ok('debugGetState snapshot');
}

// ---------------------------------------------------------------------------
console.log('--- G. Mid-stage restore replays current stage comms, not stage 1 ---');
{
  const store = new InMemoryQuestStorage();
  const engine = new QuestEngine({ storage: store });
  engine.startQuest(createTutorialQuest());
  engine.debugAdvanceStage();
  engine.debugAdvanceStage(); // now stage 3

  const engine2 = new QuestEngine({ storage: store });
  const comms: CommsDialogue[] = [];
  engine2.onCommsReceived((d) => comms.push(d));
  assert.strictEqual(engine2.restoreProgress(), true);
  engine2.startQuest(engine2.getActiveQuest()!);
  assert.strictEqual(comms.length, 1);
  assert.ok(comms[0].transmission.includes('high-grade silicate'), 'stage-3 narration replayed');
  ok('mid-stage restore replays the current stage narration');
}

// ---------------------------------------------------------------------------
console.log('--- H. No active quest is safe everywhere ---');
{
  const engine = new QuestEngine({ storage: new InMemoryQuestStorage() });
  assert.strictEqual(engine.getActiveStage(), null);
  assert.strictEqual(engine.getHintArrowTarget(), null);
  assert.strictEqual(engine.computeHintReading({ x: 0, y: 0, z: 0 }), null);
  assert.strictEqual(engine.getProgress(), 0);
  assert.strictEqual(engine.saveProgress(), false);
  assert.strictEqual(engine.restoreProgress(), false);
  assert.strictEqual(engine.recordMoveDistance(5), false);
  assert.strictEqual(engine.recordPosition({ x: 1, y: 1, z: 1 }), false);
  assert.strictEqual(engine.recordMineralMined('regolith', 5), false);
  assert.strictEqual(engine.recordBuggyBoarded(), false);
  assert.strictEqual(engine.recordTrade('regolith', 5), false);
  assert.strictEqual(engine.debugAdvanceStage(), false);
  assert.strictEqual(engine.debugCompleteQuest(), false);
  assert.strictEqual(engine.debugJumpToStage(0), false);
  ok('every method safe with no active quest');
}

console.log(`\n✅ QuestEngine smoke suite: ${passed}/${passed} checks passed (100%).`);
