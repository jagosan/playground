/**
 * Lunar Frontier — Narrative Quest Engine (Spec 18 §4 & §5, ADR-18-1).
 *
 * `QuestEngine` is the client-side staged state machine that drives the
 * "A One-Way Ticket to the Frontier" tutorial and every future quest:
 *
 *   • Tracks the active quest, its current stage, and per-objective progress.
 *   • Consumes discrete world telemetry through action hooks
 *     (`recordMoveDistance`, `recordPosition`, `recordMineralMined`,
 *     `recordBuggyBoarded`, `recordTrade`, `recordStructureBuilt`) — it never
 *     re-derives physics; `ClientApp` pushes what already happened.
 *   • Emits `OBJECTIVE_UPDATED` / `QUEST_STAGE_ADVANCED` / `QUEST_COMPLETED`
 *     through typed callbacks *and* (optionally) the client event bus.
 *   • Delivers narrative comms (`CommsDialogue`) on quest start and stage
 *     advance for the Spec 18 §6.2 comms terminal.
 *   • Computes the active hint-arrow target vector for the Spec 18 §6.1
 *     3D Hint Arrow System and the dashboard nav readout.
 *   • Serializes progress to `localStorage['lunar_frontier_quest_progress']`
 *     with autosave, and falls back to an in-memory store when `window` /
 *     `localStorage` are undefined (headless tsx, NullEngine smoke tests).
 *   • Exposes `resetProgress()` and debug overrides for QA (Spec 18 ADR-1).
 *
 * Coordinate convention matches the rest of the codebase: physics metres,
 * x/y horizontal plane, z up. `reach_target` proximity uses *horizontal*
 * distance so crater elevation noise never blocks a walking contractor.
 *
 * Usage (browser):
 *   const quests = new QuestEngine({ bus: clientEventBus });
 *   quests.onCommsReceived(d => hud.showComms(d));
 *   quests.startQuest(createTutorialQuest());
 *   // ... later, after a page refresh:
 *   quests.restoreProgress();
 * Usage (headless): identical — no DOM required, storage auto-falls back.
 */

// ---------------------------------------------------------------------------
// §4.1 Data models & interfaces
// ---------------------------------------------------------------------------

export type QuestId = string;

export type ObjectiveType =
  | 'move_distance'
  | 'reach_target'
  | 'extract_mineral'
  | 'board_buggy'
  | 'drive_distance'
  | 'trade_commodity'
  | 'build_structure';

/** Minimal structural world position (physics metres, z up). */
export interface WorldPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * One measurable goal inside a stage. The required fields are fixed by
 * Spec 18 §4.1; the optional tail carries the *matching metadata* the engine
 * uses to decide which action-hook events feed this objective:
 *  - `proximityM`   — arrival radius for `reach_target` (default 6 m).
 *  - `mineralKind`  — restricts `extract_mineral` to one commodity kind.
 *  - `commodity`    — restricts `trade_commodity` to one traded good.
 *  - `structureKind`— restricts `build_structure` to one blueprint id.
 */
export interface QuestObjective {
  id: string;
  description: string;
  type: ObjectiveType;
  targetCount: number;
  currentCount: number;
  completed: boolean;
  targetPosition?: WorldPosition;
  targetEntityId?: string;
  proximityM?: number;
  mineralKind?: string;
  commodity?: string;
  structureKind?: string;
}

/** Encrypted low-bandwidth corporate burst (Spec 18 §2.2 / §6.2). */
export interface CommsDialogue {
  sender: string;
  callsign: string;
  transmission: string;
  audioTone?: 'burst' | 'alert' | 'success' | 'static';
  autoDismissMs?: number;
}

/** One narrative beat of a quest: comms + objectives + hint target. */
export interface QuestStage {
  stageNumber: number; // 1-based display number
  stageTitle: string;
  storyNarration: CommsDialogue;
  objectives: QuestObjective[];
  hintArrowTarget?: { x: number; y: number; z: number; label: string };
}

export interface Quest {
  id: QuestId;
  title: string;
  faction: string;
  category: 'tutorial' | 'survival' | 'industry' | 'export';
  stages: QuestStage[];
  currentStageIndex: number;
  isCompleted: boolean;
  rewardCredits: number;
  rewardXp: number;
}

// ---------------------------------------------------------------------------
// Event vocabulary & payloads
// ---------------------------------------------------------------------------

export const QUEST_EVENTS = {
  objectiveUpdated: 'OBJECTIVE_UPDATED',
  stageAdvanced: 'QUEST_STAGE_ADVANCED',
  questCompleted: 'QUEST_COMPLETED',
  commsReceived: 'COMMS_RECEIVED',
} as const;

export type QuestEventName = (typeof QUEST_EVENTS)[keyof typeof QUEST_EVENTS];

export interface ObjectiveUpdatedPayload {
  questId: QuestId;
  stageNumber: number;
  objective: QuestObjective;
  /** Normalised objective progress, 0..1. */
  progress: number;
}

export interface StageAdvancedPayload {
  questId: QuestId;
  fromStageIndex: number;
  /** Index of the newly-active stage, or `stages.length` when the quest ended. */
  toStageIndex: number;
  /** The newly-active stage, or null when the quest completed. */
  stage: QuestStage | null;
  questCompleted: boolean;
}

export interface QuestCompletedPayload {
  quest: Quest;
  rewardCredits: number;
  rewardXp: number;
}

// ---------------------------------------------------------------------------
// Storage abstraction (ADR-18-1) with safe headless fallback
// ---------------------------------------------------------------------------

export const QUEST_PROGRESS_STORAGE_KEY = 'lunar_frontier_quest_progress';

/** Minimal storage contract — a structural subset of the DOM `Storage` API. */
export interface QuestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Fallback used whenever `window.localStorage` is unavailable (headless). */
export class InMemoryQuestStorage implements QuestStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/**
 * Resolve a usable {@link QuestStorage}: prefer the real `localStorage` when
 * it exists *and* survives a probe write (Safari private mode throws on
 * `setItem` even when `getItem` is fine); otherwise return a shared
 * in-memory instance so headless runs never crash.
 */
export function detectStorage(): QuestStorage {
  const candidate = (globalThis as { localStorage?: QuestStorage }).localStorage;
  if (candidate !== undefined && candidate !== null) {
    try {
      const probeKey = `${QUEST_PROGRESS_STORAGE_KEY}.__probe__`;
      candidate.setItem(probeKey, '1');
      candidate.removeItem(probeKey);
      return candidate;
    } catch {
      /* fall through to memory */
    }
  }
  return new InMemoryQuestStorage();
}

// ---------------------------------------------------------------------------
// Save envelope (versioned, validated)
// ---------------------------------------------------------------------------

export const QUEST_SAVE_VERSION = 1;

export interface QuestSaveEnvelope {
  version: number;
  savedAt: number;
  quest: Quest;
}

/** Structural shape check — guards restore against corrupted/hostile saves. */
export function validateQuestShape(quest: unknown): quest is Quest {
  if (typeof quest !== 'object' || quest === null) return false;
  const q = quest as Partial<Quest>;
  if (typeof q.id !== 'string' || typeof q.title !== 'string') return false;
  if (typeof q.faction !== 'string') return false;
  if (!['tutorial', 'survival', 'industry', 'export'].includes(String(q.category))) return false;
  if (typeof q.currentStageIndex !== 'number' || q.currentStageIndex < 0) return false;
  if (typeof q.isCompleted !== 'boolean') return false;
  if (typeof q.rewardCredits !== 'number' || typeof q.rewardXp !== 'number') return false;
  if (!Array.isArray(q.stages) || q.stages.length === 0) return false;
  for (const stage of q.stages) {
    if (typeof stage.stageNumber !== 'number' || typeof stage.stageTitle !== 'string') return false;
    const narration = stage.storyNarration;
    if (
      typeof narration !== 'object' ||
      narration === null ||
      typeof narration.sender !== 'string' ||
      typeof narration.callsign !== 'string' ||
      typeof narration.transmission !== 'string'
    ) {
      return false;
    }
    if (!Array.isArray(stage.objectives)) return false;
    for (const obj of stage.objectives) {
      if (typeof obj.id !== 'string' || typeof obj.description !== 'string') return false;
      if (!isObjectiveType(obj.type)) return false;
      if (typeof obj.targetCount !== 'number' || typeof obj.currentCount !== 'number') return false;
      if (typeof obj.completed !== 'boolean') return false;
    }
  }
  return true;
}

const OBJECTIVE_TYPES: readonly string[] = [
  'move_distance',
  'reach_target',
  'extract_mineral',
  'board_buggy',
  'drive_distance',
  'trade_commodity',
  'build_structure',
];

function isObjectiveType(value: unknown): value is ObjectiveType {
  return typeof value === 'string' && OBJECTIVE_TYPES.includes(value);
}

// ---------------------------------------------------------------------------
// Engine options
// ---------------------------------------------------------------------------

export interface QuestEngineOptions {
  /** Explicit storage backend; defaults to {@link detectStorage}. */
  storage?: QuestStorage;
  /** Persist after every mutation (default true — ADR-18-1 reload resilience). */
  autosave?: boolean;
  /** Optional client event bus receiving the same payloads as callbacks. */
  bus?: { emit(event: string, payload?: unknown): void };
}

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

export class QuestEngine {
  private quest: Quest | null = null;

  private readonly objectiveListeners = new Set<(p: ObjectiveUpdatedPayload) => void>();
  private readonly stageListeners = new Set<(p: StageAdvancedPayload) => void>();
  private readonly completedListeners = new Set<(p: QuestCompletedPayload) => void>();
  private readonly commsListeners = new Set<(d: CommsDialogue) => void>();

  readonly storage: QuestStorage;
  readonly autosave: boolean;
  private readonly bus?: { emit(event: string, payload?: unknown): void };

  constructor(options: QuestEngineOptions = {}) {
    this.storage = options.storage ?? detectStorage();
    this.autosave = options.autosave ?? true;
    this.bus = options.bus;
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Install `quest` as the active quest (deep-cloned; the caller keeps its
   * copy) and deliver the opening stage's narration. A quest restored from a
   * mid-stage snapshot replays *that* stage's comms, never stage 1's.
   */
  startQuest(quest: Quest = createTutorialQuest()): Quest {
    this.quest = cloneQuest(quest);
    const stage = this.getActiveStage();
    if (stage !== null && !stage.objectives.every((o) => o.completed)) {
      this.deliverComms(stage.storyNarration);
    }
    this.persist();
    return this.quest;
  }

  getActiveQuest(): Quest | null {
    return this.quest;
  }

  getActiveStage(): QuestStage | null {
    if (this.quest === null) return null;
    return this.quest.stages[this.quest.currentStageIndex] ?? null;
  }

  /** Overall quest completion 0..1 across every objective of every stage. */
  getProgress(): number {
    if (this.quest === null) return 0;
    let done = 0;
    let total = 0;
    for (const stage of this.quest.stages) {
      for (const obj of stage.objectives) {
        total += 1;
        if (obj.completed) done += 1;
      }
    }
    return total === 0 ? 0 : done / total;
  }

  // -- event registration ----------------------------------------------------

  onObjectiveUpdated(cb: (p: ObjectiveUpdatedPayload) => void): Unsubscribe {
    this.objectiveListeners.add(cb);
    return () => this.objectiveListeners.delete(cb);
  }

  onStageAdvanced(cb: (p: StageAdvancedPayload) => void): Unsubscribe {
    this.stageListeners.add(cb);
    return () => this.stageListeners.delete(cb);
  }

  onQuestCompleted(cb: (p: QuestCompletedPayload) => void): Unsubscribe {
    this.completedListeners.add(cb);
    return () => this.completedListeners.delete(cb);
  }

  onCommsReceived(cb: (d: CommsDialogue) => void): Unsubscribe {
    this.commsListeners.add(cb);
    return () => this.commsListeners.delete(cb);
  }

  // -- action hooks (pushed by ClientApp as world events happen) --------------

  /**
   * Accumulate locomotion. `isBuggy === true` feeds `drive_distance`
   * objectives; on-foot movement feeds `move_distance` objectives. The two
   * families never cross-contaminate.
   */
  recordMoveDistance(meters: number, isBuggy = false): boolean {
    if (!Number.isFinite(meters) || meters <= 0 || this.quest === null) return false;
    return this.accumulate(
      isBuggy ? 'drive_distance' : 'move_distance',
      () => true,
      meters,
    );
  }

  /**
   * Feed the player's live position: completes every incomplete `reach_target`
   * objective in the active stage whose horizontal distance
   * (`proximityM`, default {@link DEFAULT_REACH_RADIUS_M}) is satisfied.
   */
  recordPosition(pos: WorldPosition): boolean {
    if (
      this.quest === null ||
      !Number.isFinite(pos.x) ||
      !Number.isFinite(pos.y) ||
      !Number.isFinite(pos.z)
    ) {
      return false;
    }
    const stage = this.getActiveStage();
    if (stage === null) return false;

    let changed = false;
    for (const objective of stage.objectives) {
      if (objective.completed || objective.type !== 'reach_target') continue;
      if (objective.targetPosition === undefined) continue;
      const dx = pos.x - objective.targetPosition.x;
      const dy = pos.y - objective.targetPosition.y;
      const horizontal = Math.sqrt(dx * dx + dy * dy);
      const radius = objective.proximityM ?? DEFAULT_REACH_RADIUS_M;
      if (horizontal > radius) continue;
      objective.currentCount = Math.min(objective.currentCount + 1, objective.targetCount);
      objective.completed = objective.currentCount >= objective.targetCount;
      changed = true;
      this.emitObjectiveUpdated(objective);
    }
    if (changed) this.afterStageMutation();
    return changed;
  }

  /** Accumulate extracted mass (kg) toward `extract_mineral` objectives. */
  recordMineralMined(kind: string, amountKg: number): boolean {
    if (!Number.isFinite(amountKg) || amountKg <= 0 || this.quest === null) return false;
    return this.accumulate(
      'extract_mineral',
      (objective) => objective.mineralKind === undefined || objective.mineralKind === kind,
      amountKg,
    );
  }

  /** One increment toward `board_buggy` objectives (the [E] mount event). */
  recordBuggyBoarded(): boolean {
    return this.accumulate('board_buggy', () => true, 1);
  }

  /** Accumulate traded quantity toward `trade_commodity` objectives. */
  recordTrade(commodity: string, amount = 1): boolean {
    if (!Number.isFinite(amount) || amount <= 0 || this.quest === null) return false;
    return this.accumulate(
      'trade_commodity',
      (objective) => objective.commodity === undefined || objective.commodity === commodity,
      amount,
    );
  }

  /** Accumulate toward `build_structure` objectives (future-specs hook). */
  recordStructureBuilt(structureKind?: string, amount = 1): boolean {
    if (!Number.isFinite(amount) || amount <= 0 || this.quest === null) return false;
    return this.accumulate(
      'build_structure',
      (objective) =>
        objective.structureKind === undefined || objective.structureKind === structureKind,
      amount,
    );
  }

  // -- hint arrow / dashboard support (Spec 18 §6.1 / §6.3) --------------------

  /**
   * Current 3D hint-arrow target: the active stage's `hintArrowTarget` when
   * present, else the first incomplete objective carrying a `targetPosition`.
   */
  getHintArrowTarget(): { x: number; y: number; z: number; label: string } | null {
    const stage = this.getActiveStage();
    if (stage === null || (this.quest !== null && this.quest.isCompleted)) return null;
    if (stage.hintArrowTarget !== undefined) return { ...stage.hintArrowTarget };
    const pending = stage.objectives.find((o) => !o.completed && o.targetPosition !== undefined);
    if (pending?.targetPosition !== undefined) {
      return { ...pending.targetPosition, label: pending.description };
    }
    return null;
  }

  /** Range + compass bearing from `from` to the active hint target. */
  computeHintReading(from: WorldPosition): {
    target: { x: number; y: number; z: number; label: string };
    distanceM: number;
    bearingDeg: number;
  } | null {
    const target = this.getHintArrowTarget();
    if (target === null) return null;
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dz = target.z - from.z;
    // Bearing convention: x = east, y = north, 0° = north, clockwise.
    const bearingDeg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    return { target, distanceM: Math.sqrt(dx * dx + dy * dy + dz * dz), bearingDeg };
  }

  // -- persistence (Spec 18 §4.2) ---------------------------------------------

  /** Serialize the active quest to `localStorage['lunar_frontier_quest_progress']`. */
  saveProgress(): boolean {
    if (this.quest === null) return false;
    try {
      const envelope: QuestSaveEnvelope = {
        version: QUEST_SAVE_VERSION,
        savedAt: Date.now(),
        quest: cloneQuest(this.quest),
      };
      this.storage.setItem(QUEST_PROGRESS_STORAGE_KEY, JSON.stringify(envelope));
      return true;
    } catch {
      return false; // quota / private-mode write failure — never crash the game
    }
  }

  /**
   * Rehydrate the active quest from storage. Returns true when a valid,
   * version-compatible save was restored (and that quest is now active).
   * Corrupted, foreign-version, or shape-invalid payloads fail closed.
   */
  restoreProgress(): boolean {
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(QUEST_PROGRESS_STORAGE_KEY);
    } catch {
      return false;
    }
    if (raw === null) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;
    const envelope = parsed as Partial<QuestSaveEnvelope>;
    if (envelope.version !== QUEST_SAVE_VERSION) return false;
    if (!validateQuestShape(envelope.quest)) return false;

    this.quest = cloneQuest(envelope.quest);
    return true;
  }

  /**
   * QA helper (ADR-18-1): wipe persisted progress *and* the active quest —
   * the next `startQuest()` begins a virgin tutorial.
   */
  resetProgress(): void {
    this.quest = null;
    try {
      this.storage.removeItem(QUEST_PROGRESS_STORAGE_KEY);
    } catch {
      /* best effort */
    }
  }

  // -- debug overrides (Spec 18 ADR-1: "Expose reset and debug overrides") ----

  /** Force-complete the active stage's objectives and advance one stage. */
  debugAdvanceStage(): boolean {
    const stage = this.getActiveStage();
    if (stage === null || this.quest === null || this.quest.isCompleted) return false;
    for (const objective of stage.objectives) {
      if (objective.completed) continue;
      objective.currentCount = objective.targetCount;
      objective.completed = true;
      this.emitObjectiveUpdated(objective);
    }
    this.advanceStage();
    return true;
  }

  /** Force-complete the whole quest (fires `QUEST_COMPLETED` exactly once). */
  debugCompleteQuest(): boolean {
    if (this.quest === null || this.quest.isCompleted) return false;
    for (const stage of this.quest.stages) {
      for (const objective of stage.objectives) {
        if (objective.completed) continue;
        objective.currentCount = objective.targetCount;
        objective.completed = true;
        this.emitObjectiveUpdated(objective);
      }
    }
    // One advance cascades stage-by-stage via afterStageMutation (every stage
    // is already satisfied), ending in completion through the normal path.
    this.advanceStage();
    return this.quest !== null && this.quest.isCompleted;
  }

  /** Jump directly to a stage index (clamped; keeps earlier progress as-is). */
  debugJumpToStage(stageIndex: number): boolean {
    if (this.quest === null) return false;
    const clamped = Math.max(0, Math.min(this.quest.stages.length - 1, stageIndex));
    if (clamped === this.quest.currentStageIndex) return false;
    this.quest.currentStageIndex = clamped;
    this.persist();
    return true;
  }

  /** Deep copy of engine state for test assertions / debug overlays. */
  debugGetState(): { active: Quest | null; storageRaw: string | null } {
    let storageRaw: string | null = null;
    try {
      storageRaw = this.storage.getItem(QUEST_PROGRESS_STORAGE_KEY);
    } catch {
      storageRaw = null;
    }
    return { active: this.quest === null ? null : cloneQuest(this.quest), storageRaw };
  }

  // -- internals ---------------------------------------------------------------

  /**
   * Shared accumulator: bumps matching, incomplete objectives of `type` in
   * the active stage, clamps at `targetCount`, emits updates, then lets the
   * stage machine decide whether it has advanced.
   */
  private accumulate(
    type: ObjectiveType,
    matches: (objective: QuestObjective) => boolean,
    increment: number,
  ): boolean {
    const stage = this.getActiveStage();
    if (stage === null || (this.quest !== null && this.quest.isCompleted)) return false;

    let changed = false;
    for (const objective of stage.objectives) {
      if (objective.completed || objective.type !== type) continue;
      if (!matches(objective)) continue;
      objective.currentCount = Math.min(objective.currentCount + increment, objective.targetCount);
      objective.completed = objective.currentCount >= objective.targetCount;
      changed = true;
      this.emitObjectiveUpdated(objective);
    }
    if (changed) this.afterStageMutation();
    return changed;
  }

  /** Advance the stage machine after objective mutation; returns true if moved. */
  private afterStageMutation(): void {
    if (this.quest === null || this.quest.isCompleted) return;
    const stage = this.getActiveStage();
    if (stage === null) return;
    if (stage.objectives.length > 0 && stage.objectives.every((o) => o.completed)) {
      this.advanceStage();
    } else {
      this.persist();
    }
  }

  private advanceStage(): void {
    if (this.quest === null || this.quest.isCompleted) return;
    const fromIndex = this.quest.currentStageIndex;
    this.quest.currentStageIndex = fromIndex + 1;

    const nextStage = this.quest.stages[this.quest.currentStageIndex] ?? null;
    if (nextStage !== null) {
      this.emit(QUEST_EVENTS.stageAdvanced, {
        questId: this.quest.id,
        fromStageIndex: fromIndex,
        toStageIndex: this.quest.currentStageIndex,
        stage: nextStage,
        questCompleted: false,
      } satisfies StageAdvancedPayload);
      this.deliverComms(nextStage.storyNarration);
      this.persist();
      // Chained stages (debug-complete or pre-satisfied objectives): keep
      // rolling until a live stage or completion is reached.
      this.afterStageMutation();
      return;
    }

    // Past the final stage — the quest is done.
    this.quest.currentStageIndex = fromIndex; // pin display at last stage
    this.quest.isCompleted = true;
    this.emit(QUEST_EVENTS.stageAdvanced, {
      questId: this.quest.id,
      fromStageIndex: fromIndex,
      toStageIndex: this.quest.stages.length,
      stage: null,
      questCompleted: true,
    } satisfies StageAdvancedPayload);
    this.emit(QUEST_EVENTS.questCompleted, {
      quest: this.quest,
      rewardCredits: this.quest.rewardCredits,
      rewardXp: this.quest.rewardXp,
    } satisfies QuestCompletedPayload);
    this.persist();
  }

  private emitObjectiveUpdated(objective: QuestObjective): void {
    const stage = this.getActiveStage();
    this.emit(QUEST_EVENTS.objectiveUpdated, {
      questId: this.quest?.id ?? '',
      stageNumber: stage?.stageNumber ?? 0,
      objective,
      progress: objective.targetCount > 0 ? Math.min(1, objective.currentCount / objective.targetCount) : 1,
    } satisfies ObjectiveUpdatedPayload);
  }

  private deliverComms(dialogue: CommsDialogue): void {
    const copy = { ...dialogue };
    this.emit(QUEST_EVENTS.commsReceived, copy);
  }

  private emit(event: QuestEventName, payload?: unknown): void {
    switch (event) {
      case QUEST_EVENTS.objectiveUpdated: {
        const p = payload as ObjectiveUpdatedPayload;
        for (const cb of [...this.objectiveListeners]) cb(p);
        break;
      }
      case QUEST_EVENTS.stageAdvanced: {
        const p = payload as StageAdvancedPayload;
        for (const cb of [...this.stageListeners]) cb(p);
        break;
      }
      case QUEST_EVENTS.questCompleted: {
        const p = payload as QuestCompletedPayload;
        for (const cb of [...this.completedListeners]) cb(p);
        break;
      }
      case QUEST_EVENTS.commsReceived: {
        const d = payload as CommsDialogue;
        for (const cb of [...this.commsListeners]) cb(d);
        break;
      }
    }
    this.bus?.emit(event, payload);
  }

  private persist(): void {
    if (this.autosave) this.saveProgress();
  }
}

/** Arrival radius for `reach_target` objectives without an explicit one. */
export const DEFAULT_REACH_RADIUS_M = 6;

// ---------------------------------------------------------------------------
// §5 Canonical tutorial quest — "A One-Way Ticket to the Frontier"
// ---------------------------------------------------------------------------

export interface TutorialQuestOptions {
  faction?: string;
  /** Where the drop-pod left the contractor (default origin). */
  spawnPosition?: WorldPosition;
  /** Ilmenite outcrop surveyed in stage 2 (default 45 m due "north"). */
  veinPosition?: WorldPosition;
  /** Parked LRV position for stage 4 (default 30 m NE of the vein). */
  buggyPosition?: WorldPosition;
  /** Sector trade hub for stage 5 (default 120 m back toward base). */
  terminalPosition?: WorldPosition;
  buggyEntityId?: string;
}

const DISPATCH_CALLSIGN = 'CEC-DISP';
const DISPATCH_SENDER = 'Caelus Extraction Corp — Corporate Dispatch';

function comms(
  callsign: string,
  transmission: string,
  audioTone: CommsDialogue['audioTone'],
  autoDismissMs = 14_000,
): CommsDialogue {
  return { sender: DISPATCH_SENDER, callsign, transmission, audioTone, autoDismissMs };
}

/**
 * Factory for the canonical Spec 18 §5 tutorial: five stages, corporate
 * dispatcher comms verbatim from the spec brief, objective text carrying the
 * exact button mappings, hint-arrow targets wired to live world coordinates.
 */
export function createTutorialQuest(options: TutorialQuestOptions = {}): Quest {
  const faction = options.faction ?? 'CEC';
  const spawn = options.spawnPosition ?? { x: 0, y: 0, z: 0 };
  const vein = options.veinPosition ?? { x: 0, y: 45, z: spawn.z - 0.8 };
  const buggy = options.buggyPosition ?? { x: 28, y: 62, z: spawn.z - 0.6 };
  const terminal = options.terminalPosition ?? { x: -60, y: -80, z: spawn.z };
  const buggyId = options.buggyEntityId ?? 'lrv-requisition-01';

  return {
    id: 'quest_one_way_ticket',
    title: 'A One-Way Ticket to the Frontier',
    faction,
    category: 'tutorial',
    currentStageIndex: 0,
    isCompleted: false,
    rewardCredits: 500,
    rewardXp: 250,
    stages: [
      {
        stageNumber: 1,
        stageTitle: 'Boots on the Ground',
        storyNarration: comms(
          DISPATCH_CALLSIGN,
          'Contractor 7-Echo, wake up. Life support telemetry verified. Transport ' +
            'dropped you at the perimeter. Check your helmet seals and move 10 meters ' +
            'toward the survey beacon. Don\'t touch the visor seals unless you fancy ' +
            'suffocating.',
          'burst',
        ),
        objectives: [
          objective(
            's1_move_10m',
            'Move 10 m [WASD / Left Stick] — leap with [Space / A] to cross regolith faster.',
            'move_distance',
            10,
          ),
        ],
        hintArrowTarget: { x: spawn.x, y: spawn.y + 12, z: spawn.z + 1.5, label: 'Survey beacon' },
      },
      {
        stageNumber: 2,
        stageTitle: 'Scanner Calibration & Mineral Prospecting',
        storyNarration: comms(
          DISPATCH_CALLSIGN,
          'Surface scan shows a rich outcrop of regolith rich in ilmenite 45 meters ' +
            'ahead. Look for the HUD indicator. Corporate wants a baseline spectrometer ' +
            'read before you start digging.',
          'alert',
        ),
        objectives: [
          objective(
            's2_reach_vein',
            'Approach the ilmenite outcrop — get within 6 m of the marker.',
            'reach_target',
            1,
            { targetPosition: vein, proximityM: DEFAULT_REACH_RADIUS_M },
          ),
        ],
        hintArrowTarget: { x: vein.x, y: vein.y, z: vein.z + 2, label: 'Ilmenite outcrop' },
      },
      {
        stageNumber: 3,
        stageTitle: 'Surface Extraction & Ilmenite Harvesting',
        storyNarration: comms(
          DISPATCH_CALLSIGN,
          'That\'s high-grade silicate right there. 45% oxygen by weight, with enough ' +
            'titanium to build a small refinery if you melt it hot enough. Fire up your ' +
            'mining laser with [M] and extract at least 20 kg.',
          'alert',
        ),
        objectives: [
          objective(
            's3_mine_20kg',
            'Hold [M / X] near the vein and extract 20 kg of Regolith.',
            'extract_mineral',
            20,
            { mineralKind: 'regolith', targetPosition: vein },
          ),
        ],
        hintArrowTarget: { x: vein.x, y: vein.y, z: vein.z + 1, label: 'Extraction reticle' },
      },
      {
        stageNumber: 4,
        stageTitle: 'Vehicle Requisition & Cockpit Familiarization',
        storyNarration: comms(
          DISPATCH_CALLSIGN,
          'Manual hauling will burn your O2 in ten minutes flat. We left a battered ' +
            'LRV buggy parked on the ridge. Head to the waypoint, mount the chassis ' +
            'with [E], and turn the dash on.',
          'alert',
        ),
        objectives: [
          objective(
            's4_board_lrv',
            'Reach the parked LRV and press [E / Y] to mount the driver\'s seat.',
            'board_buggy',
            1,
            { targetPosition: buggy, targetEntityId: buggyId, proximityM: MOUNT_APPROACH_RADIUS_M },
          ),
        ],
        hintArrowTarget: { x: buggy.x, y: buggy.y, z: buggy.z + 3, label: 'LRV requisition' },
      },
      {
        stageNumber: 5,
        stageTitle: 'The First Haul & Frontier Exchange',
        storyNarration: comms(
          DISPATCH_CALLSIGN,
          'Good, you didn\'t roll it. Haul that payload back to the sector trade hub. ' +
            'Hit [T] at the terminal to dump your haul for cold hard scrip. Welcome to ' +
            'the Moon, contractor.',
          'success',
        ),
        objectives: [
          objective(
            's5_reach_hub',
            'Drive the buggy to the Faction Exchange Terminal marker.',
            'reach_target',
            1,
            { targetPosition: terminal, proximityM: 12 },
          ),
          objective(
            's5_dump_haul',
            'Dump your cargo at the terminal with [T] for scrip.',
            'trade_commodity',
            1,
            { commodity: 'regolith' },
          ),
        ],
        hintArrowTarget: { x: terminal.x, y: terminal.y, z: terminal.z + 4, label: 'Exchange terminal' },
      },
    ],
  };
}

/** Approach radius for the stage-4 LRV (board event itself is triggered by ClientApp). */
export const MOUNT_APPROACH_RADIUS_M = 4;

/** Objective literal helper — new objectives always start uncompleted. */
function objective(
  id: string,
  description: string,
  type: ObjectiveType,
  targetCount: number,
  extra: Partial<QuestObjective> = {},
): QuestObjective {
  return {
    id,
    description,
    type,
    targetCount,
    currentCount: 0,
    completed: targetCount <= 0,
    ...extra,
  };
}

function cloneQuest(quest: Quest): Quest {
  // structuredClone exists on Node ≥17 and every target browser; JSON is the
  // belt-and-braces fallback for exotic runtimes (quests are pure data).
  if (typeof structuredClone === 'function') return structuredClone(quest);
  return JSON.parse(JSON.stringify(quest)) as Quest;
}
