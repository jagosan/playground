# Structural Symbol Map (Playground)

## Architecture & Subsystems
- `docs/architecture/01-playground-lobby.md`: 3D lobby architecture, Three.js engine ADR, equipment contracts.
- `specs/`:
  - `specs/00-system-overview.md`: Project vision, minigame architecture, rendering stack.
  - `specs/01-playground-lobby.md`: 3D retro playground hub, equipment-to-minigame selector.
  - `specs/02-moon-buggy.md`: 1/6th gravity lunar rover physics, controls, rock collection loop.

## Core Modules & Entities
- `src/main.ts`: Application bootstrap, scene loop, lighting, and container mounting.
- `src/engine/Events.ts`: Typed event bus (`EventBus`, `GameEventMap`, `EquipmentRef`).
- `src/engine/SceneManager.ts`: Retro pixelated canvas setup (`PIXEL_SCALE = 0.5`), render loop, and scene lifecycle.
- `src/entities/Player.ts`: First-person and third-person character controller, WASD/arrows, camera pitch/yaw, avatar mesh.
- `src/entities/Equipment.ts`: Procedural playground objects (Swing Set, Tower Slide, Merry-Go-Round, Moon Buggy Ride).
- `src/systems/ProximitySystem.ts`: Distance checking against interaction radius and HUD prompt triggers.
- `src/systems/QuestManager.ts`: Local persistent progression (`localStorage`), badges, and exploration objectives.
- `src/ui/HUD.ts`: Retro pixelated HUD overlay, crosshair, objective box, controls guide, and interaction banner.
