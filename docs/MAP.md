# Structural Symbol Map (Playground)

## Architecture & Subsystems
- `docs/architecture/01-playground-lobby.md`: 3D lobby architecture, Three.js engine ADR, equipment contracts.
- `docs/architecture/02-moon-buggy.md`: Lunar rover raycast suspension, 1/6th gravity, procedural terrain.
- `docs/architecture/03-moonbuggy2.md`: High-fidelity Apollo LRV simulation, Pacejka slip, PBR regolith, Win Max 2 gamepad.
- `specs/`:
  - `specs/00-system-overview.md`: Project vision, minigame architecture, rendering stack.
  - `specs/01-playground-lobby.md`: 3D retro playground hub, equipment-to-minigame selector.
  - `specs/02-moon-buggy.md`: 1/6th gravity lunar rover physics, controls, rock collection loop.
  - `specs/03-moonbuggy2.md`: Realistic Apollo LRV physics, photorealistic rendering, GPD Win Max 2.

## Core Modules & Entities
- `src/main.ts`: Application bootstrap, scene loop, minigame transition switching.
- `src/engine/Events.ts`: Typed event bus (`EventBus`, `GameEventMap`, `EquipmentRef`).
- `src/engine/SceneManager.ts`: Retro pixelated canvas setup (`PIXEL_SCALE = 0.5`), render loop, scene lifecycle.
- `src/entities/Player.ts`: First-person and third-person character controller, WASD/arrows, camera pitch/yaw.
- `src/entities/Equipment.ts`: Procedural playground objects (Swing Set, Tower Slide, Merry-Go-Round, Moon Buggy Ride).
- `src/systems/ProximitySystem.ts`: Distance checking against interaction radius and HUD prompt triggers.
- `src/systems/QuestManager.ts`: Local persistent progression (`localStorage`), badges, exploration objectives.
- `src/ui/HUD.ts`: Retro pixelated HUD overlay, crosshair, objective box, controls guide.

## Moon Buggy Minigame Modules (Spec 02)
- `src/minigames/moon-buggy/LunarTerrain.ts`: Procedural cratered lunar surface heightfield (`getHeightAt`, `getNormalAt`).
- `src/minigames/moon-buggy/MoonRover.ts`: 1/6th gravity vehicle physics body, suspension raycasting, 4 wheels, mesh rig.
- `src/minigames/moon-buggy/ChaseCamera.ts`: Damped follow camera tracking rover trajectory and orientation.
- `src/minigames/moon-buggy/MoonBuggyHUD.ts`: Cockpit instruments (speedometer, lunar gravity readout, pitch/roll, exit button).
- `src/minigames/moon-buggy/MoonBuggyScene.ts`: Full minigame scene container, lighting, starfield, game loop integration.

## Moonbuggy 2 High-Fidelity Modules (Spec 03)
- `src/minigames/moonbuggy2/LRVPhysics.ts`: 120Hz sub-stepped analytical multi-body dynamics, Pacejka slip, double-wishbone suspension.
- `src/minigames/moonbuggy2/PhotorealisticTerrain.ts`: PBR lunar regolith terrain with Hapke retro-reflection, micro-craters, normal map generation.
- `src/minigames/moonbuggy2/ApolloRoverModel.ts`: High-detail Apollo 15/16/17 LRV geometry (Kapton foil, wire-mesh zinc tires, dish antenna).
- `src/minigames/moonbuggy2/GamepadController.ts`: GPD Win Max 2 / Xbox gamepad polling with analog trigger throttle/braking.
- `src/minigames/moonbuggy2/Moonbuggy2Scene.ts`: Photorealistic vacuum lighting, Earthshine bounce, dual camera modes (chase/cockpit).
- `src/minigames/moonbuggy2/Moonbuggy2HUD.ts`: Advanced Apollo LRV digital/analog glass cockpit telemetry.
