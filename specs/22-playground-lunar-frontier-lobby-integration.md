# Spec 22: Playground Lobby — Lunar Frontier Integration

> **Target Systems:** `src/entities/Equipment.ts`, `src/systems/QuestManager.ts`, `src/ui/HUD.ts`, `src/main.ts`, `src/ui/LunarFrontierOverlay.ts`, `vite.config.ts`, `package.json`, `tests/verify-lunar-frontier-lobby.ts`.  
> **Platforms:** WebGL2/WebGPU Desktop (Chrome, Firefox, Safari), Steam Deck & Handhelds (GPD Win Max 2, Mobile Touch).  
> **Preceding Specs:** Spec 01 (Playground Lobby Hub), Spec 02 (Moon Buggy Arcade), Spec 03 (Moonbuggy 2 Simulator), Spec 12 (Lunar Frontier Architecture).

---

## 1. Executive Summary & Objective

The **Playground Lobby** (Spec 01) is the core 3D retro hub where players explore equipment and choose from minigames across the repository. Currently, the lobby hosts five equipment portals:
1. `eq_swings`: Swing Set
2. `eq_slide`: Tower Slide
3. `eq_roundabout`: Merry-Go-Round
4. `eq_moon_buggy`: Moon Buggy Arcade (Spec 02, Three.js)
5. `eq_moonbuggy2`: Moonbuggy 2 Simulator (Spec 03, Three.js)

**Lunar Frontier** (`games/lunar-frontier`), developed under Specs 12–21, is a persistent multiplayer lunar economy, mining, and rail simulation built on Babylon.js with an authoritative Fastify + WebSocket + SQLite backend. To date, Lunar Frontier has operated as an isolated sub-project with its own client dev server (`port 5174`) and backend shard (`port 3030`), disconnected from the playground lobby.

**Objective:** Wire Lunar Frontier directly into the Playground Lobby as an in-world interactive destination, featuring:
1. A distinct, high-detail **3D Lunar Frontier Gateway Complex** on the playground perimeter.
2. An integrated **in-lobby launcher and viewport bridge overlay** (`LunarFrontierOverlay.ts`) with top navigation chrome ("Return to Lobby", server status telemetry, standalone window launcher).
3. **Engine context switching and resource management** (pausing Three.js render loop during Babylon.js simulation to conserve GPU memory).
4. Deep linking via URL query parameters (`?game=lunar-frontier`).
5. **Quest & discovery progression** in `QuestManager` acknowledging the lunar colony portal.
6. A verified headless smoke test suite validating equipment contracts, quest mechanics, and transition event integrity.

---

## 2. Technical Architecture & Component Contracts

### 2.1 3D Equipment Entity (`src/entities/Equipment.ts`)
- **ID:** `eq_lunar_frontier`
- **Name:** `Lunar Frontier (Persistent Sim)`
- **Description:** `Persistent multiplayer lunar economy, subterranean rail lines, and 3D exploration simulation.`
- **Minigame ID:** `lunar-frontier`
- **World Position:** `[8, 0, 14]` (balanced symmetrically with Moonbuggy 2 at `[-8, 0, 14]`).
- **Interaction Radius:** `4.5` meters.
- **Procedural 3D Mesh Hierarchy:**
  - **Launch Base:** Heavy hexagonal reinforced concrete launch pad (`color: 0x334155`) with hazard perimeter banding (`0xf59e0b` / `0x1e293b`).
  - **Lander Fuselage:** Cylindrical pressurized titanium hull (`0x94a3b8`) with faceted gold Kapton foil thermal wraps (`0xf59e0b`, `metalness: 0.85`).
  - **Airlock Portal:** Recessed illuminated ingress airlock door with cyan border glow (`0x06b6d4`, emissive).
  - **Avionics & Comms:** High-gain parabolic communications dish tilted toward Earth, dual RCS quad thruster blocks, and twin flashing navigation beacon masts (red port, green starboard).
  - **Rotating Holographic Badge:** Floating billboard text/ring geometry indicating active frontier shard link.

### 2.2 Quest Manager Updates (`src/systems/QuestManager.ts`)
- Increase total trackable equipment count from hardcoded `4` to `5` (or dynamically calculate from equipment registry length).
- Register `lunar-frontier` in quest completion state upon first transition.
- Update progression messaging: `"Discovered: X / 5"`.

### 2.3 Lunar Frontier In-Lobby Bridge Overlay (`src/ui/LunarFrontierOverlay.ts`)
- **Container:** Absolute fixed container covering 100% viewport (`z-index: 100`).
- **Top Navigation Bar:**
  - **Return Button:** `◄ RETURN TO PLAYGROUND LOBBY` — triggers clean teardown and emits `TRANSITION_TO_LOBBY`.
  - **Shard Telemetry Pill:** Probes backend shard health (`http://127.0.0.1:3030/health` or `/api/health`). Surfaces real-time status:
    - `🟢 SHARD ONLINE (3030)` if reachable.
    - `🟡 LOCAL SIMULATION (5174)` if client is reachable but server is offline.
    - `🔴 CLIENT OFFLINE` with inline hint: `Run npm run lunar:client (port 5174)`.
  - **External Tab Launcher:** `Launch Standalone ↗` (`http://${window.location.hostname}:5174`).
  - **Reload Button:** `⟳ Reload Viewport`.
- **Viewport Frame:**
  - High-performance `<iframe>` pointing to the Lunar Frontier client endpoint (`http://${window.location.hostname}:5174/` or relative path `/games/lunar-frontier/`).
  - Graceful connection fallback screen if dev server is warming up or unstarted, with automatic retry polling every 3 seconds.
  - Keyboard/gamepad focus transfer into iframe on mount.

### 2.4 Application Lifecycle & Transitions (`src/main.ts`)
- On `TRANSITION_TO_MINIGAME` with `minigameId === 'lunar-frontier'`:
  1. Destroy lobby HUD and player controllers.
  2. Pause Three.js render clock and loop (`sceneManager.stop()`).
  3. Mount `LunarFrontierOverlay`.
- On `TRANSITION_TO_LOBBY`:
  1. Unmount and destroy `LunarFrontierOverlay`.
  2. Re-instantiate lobby environment, player, and HUD.
  3. Resume Three.js render loop (`sceneManager.start()`).
- On page bootstrap:
  - Check `window.location.search` for `?game=lunar-frontier`; if present, trigger direct transition immediately.

### 2.5 Vite Dev Server & Proxy Integration (`vite.config.ts`)
- Add development reverse proxy for `/games/lunar-frontier` and `/lunar-frontier` forwarding to `http://127.0.0.1:5174`.
- Proxy WebSocket `/ws` and HTTP `/api` if needed for direct in-lobby routing.

---

## 3. Phased Implementation Plan

- **Phase 1 (Scaffolding & Models):** Implement 3D `eq_lunar_frontier` equipment geometry, materials, and positioning in `src/entities/Equipment.ts`.
- **Phase 2 (Quest & Lobby Systems):** Update `src/systems/QuestManager.ts` to support dynamic or 5-item discovery tracking.
- **Phase 3 (Bridge Overlay Component):** Author `src/ui/LunarFrontierOverlay.ts` with top navigation bar, shard telemetry ping, iframe embedding, and auto-retry logic.
- **Phase 4 (Main Loop & Transitions):** Wire minigame transitions, engine pause/resume, and URL parameter handling in `src/main.ts`.
- **Phase 5 (Vite & Config):** Configure proxy rules in `vite.config.ts` and add run scripts in `package.json`.
- **Phase 6 (Verification & Smoke Tests):** Author `tests/verify-lunar-frontier-lobby.ts` covering equipment configs, quest tracking, and transition events. Run type checks and build gates.

---

## 4. Acceptance Criteria & Contract Gates

1. `createDefaultPlaygroundEquipment()` includes `eq_lunar_frontier` with valid 3D mesh, position `[8, 0, 14]`, and interaction radius `4.5`.
2. Walking within 4.5m of the launch complex displays the interaction prompt banner.
3. Activating the portal pauses Three.js rendering and mounts the `LunarFrontierOverlay`.
4. Overlay provides a functional "◄ RETURN TO PLAYGROUND LOBBY" action that restores the lobby cleanly without memory leaks or duplicate canvases.
5. Visiting `http://localhost:5173/?game=lunar-frontier` automatically launches the overlay.
6. `npm run build` (`tsc --noEmit && vite build`) passes with zero errors.
7. `npx tsx tests/verify-lunar-frontier-lobby.ts` executes and passes all assertions.
