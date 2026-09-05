// Typed event bus shared by all lobby systems.
// One-directional imports only: Events -> Equipment (types). No cycles.

export interface EquipmentRef {
  id: string;
  name: string;
  minigameId: string;
}

export type GameEventMap = {
  EQUIPMENT_FOCUSED: { id: string; name: string; minigameId: string; distance: number };
  EQUIPMENT_UNFOCUSED: { id: string };
  TRANSITION_TO_MINIGAME: { minigameId: string; equipmentId: string; name: string };
  TRANSITION_TO_LOBBY: { reason: string };
  VIEW_MODE_CHANGED: { mode: 'first' | 'third' };
  QUEST_UPDATED: { objective: string; level: number; completed: number; total: number };
};

type Handler<K extends keyof GameEventMap> = (payload: GameEventMap[K]) => void;

export class EventBus {
  private listeners: Map<keyof GameEventMap, Set<Handler<keyof GameEventMap>>> = new Map();

  on<K extends keyof GameEventMap>(event: K, handler: Handler<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as Handler<keyof GameEventMap>);
    return () => this.off(event, handler);
  }

  off<K extends keyof GameEventMap>(event: K, handler: Handler<K>): void {
    this.listeners.get(event)?.delete(handler as Handler<keyof GameEventMap>);
  }

  emit<K extends keyof GameEventMap>(event: K, payload: GameEventMap[K]): void {
    this.listeners.get(event)?.forEach((h) => (h as Handler<K>)(payload));
  }

  clear(): void {
    this.listeners.clear();
  }
}
