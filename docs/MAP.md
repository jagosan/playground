# Structural Symbol Map (Playground)

## Architecture & Subsystems
- `docs/architecture/01-playground-lobby.md`: 3D lobby architecture, Three.js engine ADR, equipment contracts.
- `docs/architecture/02-moon-buggy.md`: Lunar rover raycast suspension, 1/6th gravity, procedural terrain.
- `docs/architecture/03-moonbuggy2.md`: High-fidelity Apollo LRV simulation, Pacejka slip, PBR regolith, Win Max 2 gamepad.
- `docs/architecture/08-artemis-ltv-and-robotic-arm.md`: Next-gen Artemis LTV skin, airless lattice wheels, directed robotic arm retrieval rig.
- `specs/`:
  - `specs/00-system-overview.md`: Project vision, minigame architecture, rendering stack.
  - `specs/01-playground-lobby.md`: 3D retro playground hub, equipment-to-minigame selector.
  - `specs/02-moon-buggy.md`: 1/6th gravity lunar rover physics, controls, rock collection loop.
  - `specs/03-moonbuggy2.md`: Realistic Apollo LRV physics, photorealistic rendering, GPD Win Max 2.
  - `specs/04-moonbuggy2-m2.md`: Milestone 2 feedback: 25 km/h speed, dynamic mass, robotic arm, drop station.
  - `specs/05-blender-asset-pipeline.md`: Headless Blender 4.2 asset generator (bpy), PBR materials, GLB export.
  - `specs/06-moonbuggy2-engine-m2.md`: Three.js GLTF loader integration, articulated kinematics, HUD telemetry.

## Blender Asset Pipeline (Spec 05)
- `scripts/build_lunar_assets.py`: Standalone Blender 4.2 headless asset generator (`--all` / per-phase flags; previews + `manifest.json`).
- `scripts/lunar_assets/`: bpy builders — `rover_builder.build_apollo_lrv(out)`, `rocks_builder.build_lunar_rocks(out)`, `terrain_station_builder.build_terrain(out)`/`build_station(out)`; each main `os._exit(0)`-guarded (Blender 4.2 teardown).
- `scripts/run_blender_pipeline.sh`: hardened wrapper (setsid process group, `PIPELINE_TIMEOUT_S`, RSS sampling, orphan check, `PIPELINE_STATUS=OK|FAIL:<reason>`).
- `tests/verify_m3_assets.py`: Spec 05 contract verification (glTF magic, node hierarchy, manifest consistency, PNG previews, re-run determinism).
- `public/models/`: Exported binary glTF assets (`apollo_lrv.glb`, `lunar_rocks.glb`, `lunar_terrain_tile.glb`, `lunar_drop_station.glb`).
- `public/models/manifest.json`: Asset metadata, polygon counts, material slots, file sizes.

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

## Moonbuggy 2 High-Fidelity Modules (Spec 03 / 06)
- `src/minigames/moonbuggy2/GLTFAssetLoader.ts`: Async loader with Three.js `GLTFLoader` + fallback for `/models/*.glb`.
- `src/minigames/moonbuggy2/LRVPhysics.ts`: 120Hz sub-stepped dynamics, Pacejka slip, double-wishbone suspension, dynamic cargo mass (+35kg/rock), 25km/h governor, battery gauge.
- `src/minigames/moonbuggy2/PhotorealisticTerrain.ts`: PBR lunar regolith terrain with Hapke retro-reflection, micro-craters, normal map generation.
- `src/minigames/moonbuggy2/LunarRockField.ts`: Instanced lunar boulder scatter from `lunar_rocks.glb`, proximity spatial query.
- `src/minigames/moonbuggy2/RoboticArmController.ts`: 3-joint boom kinematics (`RoboticArm_Base`, `RoboticArm_Bicep`, `RoboticArm_Claw`), rock pickup trigger.
- `src/minigames/moonbuggy2/ScienceDropStation.ts`: Drop station at (0, 0) from `lunar_drop_station.glb`, 6m docking beacon, cargo unload & battery recharge loop.
- `src/minigames/moonbuggy2/ApolloRoverModel.ts`: High-detail Apollo 15/16/17 LRV geometry + asynchronous GLB hierarchy binding (`apollo_lrv.glb`).
- `src/minigames/moonbuggy2/GamepadController.ts`: GPD Win Max 2 / Xbox gamepad polling with analog trigger throttle/braking.
- `src/minigames/moonbuggy2/Moonbuggy2Scene.ts`: Photorealistic vacuum lighting, Earthshine bounce, dual camera modes (chase/cockpit), game loop coordinator.
- `src/minigames/moonbuggy2/Moonbuggy2HUD.ts`: Advanced Apollo LRV digital/analog glass cockpit telemetry (speedometer, battery bar, rock payload, station compass).
