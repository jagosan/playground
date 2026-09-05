import { EventBus } from '../engine/Events';

export interface QuestState {
  level: number;
  objective: string;
  completedQuests: string[];
}

const STORAGE_KEY = 'playground_quests';

export class QuestManager {
  private eventBus: EventBus;
  private state: QuestState;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.state = this.loadState();

    this.bindEvents();
    this.emitUpdate();
  }

  private loadState(): QuestState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch {
      // LocalStorage fallback
    }

    return {
      level: 1,
      objective: 'Explore the playground and inspect the Moon Buggy ride',
      completedQuests: [],
    };
  }

  private saveState(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // ignore
    }
  }

  private bindEvents(): void {
    this.eventBus.on('TRANSITION_TO_MINIGAME', ({ minigameId, name }) => {
      if (!this.state.completedQuests.includes(minigameId)) {
        this.state.completedQuests.push(minigameId);
        this.state.level += 1;
        this.state.objective = `Tried ${name}! Continue discovering remaining rides.`;
        this.saveState();
        this.emitUpdate();
      }
    });
  }

  private emitUpdate(): void {
    this.eventBus.emit('QUEST_UPDATED', {
      objective: this.state.objective,
      level: this.state.level,
      completed: this.state.completedQuests.length,
      total: 4, // 4 total equipment pieces
    });
  }

  public getState(): QuestState {
    return { ...this.state };
  }
}
