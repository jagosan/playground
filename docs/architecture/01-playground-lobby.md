# Architectural Blueprint: Playground Lobby (Spec 01)

## 1. Overview & Context
The Playground Lobby serves as the central hub and interactive selection space for all minigames within the Playground ecosystem. Modeled as a stylized, retro low-poly playground, players navigate the 3D space in either third-person or first-person perspective. Approaching a piece of playground equipment prompts the player to enter the corresponding minigame (e.g., approaching the Lunar Lander / Moon Buggy ride triggers Spec 02).

## 2. Technical Stack Decision & Evaluation (ADR-001)
- **Selected Stack:** Three.js + Vite (TypeScript).
- **Rationale:** 
  - Three.js provides lightweight, unopinionated primitives and rapid bundling with Vite.
  - Zero heavy engine runtime overhead compared to Babylon.js or Godot/Wasm exports.
  - Effortless procedural placeholder creation (geometries & materials) while Blender GLTF pipeline assets are being modeled.
  - Native integration with standard DOM UI overlays for quest trackers, HUD, and minigame transitions.

## 3. Component Architecture & System Flow

```mermaid
graph TD
    A[GameEngine / GameLoop] --> B[SceneManager]
    B --> C[LobbyScene]
    B --> D[Minigame Scenes (e.g. MoonBuggyScene)]
    C --> E[PlayerController (First/Third-Person)]
    C --> F[EquipmentRegistry & Interactors]
    F --> G[ProximityDetector]
    G --> H[HUD / Interaction Prompt]
    H -->|Input 'E' / Touch| B
```

## 4. Interfaces & Contract Specifications

### 4.1 Equipment Entity
```typescript
export interface EquipmentConfig {
  id: string;
  name: string;
  description: string;
  minigameId: string;
  position: [number, number, number];
  interactionRadius: number;
  modelType: 'procedural' | 'gltf';
  proceduralMeshGenerator?: () => THREE.Group;
}
```

### 4.2 Proximity & Interaction System
- `ProximityDetector`: Calculates distance between `PlayerController.position` and registered `EquipmentConfig.position`.
- When distance $< \text{interactionRadius}$, broadcasts event `EQUIPMENT_FOCUSED` with prompt banner: *"Press [E] to play {name}"*.
- Triggering interaction emits `TRANSITION_TO_MINIGAME({ minigameId })`.

### 4.3 Progression & Quest State
- `QuestManager`: Tracks completed minigame milestones stored in `localStorage` (decoupled from backend auth).
- Levels and badges displayed on the HUD.

## 5. 💡 Note to Future Self: Hosting Portability
- **Client-Only Decoupling:** The entire 3D lobby and minigame bundle compiles to pure static HTML/JS/CSS assets via Vite (`npm run build` -> `dist/`).
- **Hosting Versatility:** Deployable to any static host (Cloudflare Pages, S3, Nginx on `beehive`, or local offline filesystems) with zero server-side state requirements.
- **Minigame Modularity:** Future minigames are dynamically imported chunks (`import('./minigames/moon-buggy')`), preventing initial bundle bloat.
