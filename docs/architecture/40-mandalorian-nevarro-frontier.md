# Architecture Blueprint: Mandalorian — Nevarro Frontier (Spec 40)

## 1. System Overview & Dual-App Integration

`games/mandalorian` is an independent Babylon.js client subproject inside the `playground` monorepo, sharing procedural world terrain (`LunarWorldGenerator`) from `games/lunar-frontier` via Vite/TypeScript `@lunar/*` path aliasing while maintaining its own isolated runtime loop, physics, character rig, and HUD.

```
Playground Lobby (Three.js, :5173)
  └── Equipment: "Mandalorian: Nevarro"
        └── [E] Interact ──► MandalorianOverlay.ts (iframe :5175)
                                  └── MandoApp.ts (Babylon.js)
                                        ├── NevarroWorldScene.ts ──► @lunar/world/LunarWorldGenerator
                                        ├── NevarroTown.ts (Buildings, Landing Pad, Gunship, Colliders)
                                        ├── MandoPhysics.ts (9.81 m/s² Walk + Z-6 Jetpack)
                                        ├── MandalorianAvatar.ts (Beskar Suit, Cape, Thrusters)
                                        ├── MandoAudioSystem.ts (Web Audio Synthesis)
                                        └── MandoHUD.ts (Fuel, Altitude, Landmarks, Touch Controls)
```

## 2. Frame Update & Data Flow

1. **Input Sampling (`MandoApp`):** Keyboard (`WASD`, `Shift`, `Space`, `V`, `U`), Mouse look, Gamepad axes/buttons, and Touch virtual sticks feed a unified `MandoInputState`.
2. **Physics Step (`MandoPhysics`):**
   - Queries `NevarroTown.querySurface(x, y, z)` and `NevarroWorldScene.groundAt(x, y)` to resolve `floorZ = max(terrainZ, roofZ)`.
   - Resolves horizontal wall push-out against building AABBs/cylinders when `z < roofZ`.
   - Applies `9.81 m/s²` gravity; if `input.jetpack && jetpackFuel > 0`, applies `JETPACK_THRUST` (`18.5 m/s²`) and burns fuel; otherwise clamps grounded walking/sprinting to `floorZ` with zero lunar bounding impulses.
3. **Avatar & FX (`MandalorianAvatar`):** Updates world position/yaw, drives grounded stride or banked jetpack flight pose, animates cape trail, and toggles thruster flame cones + particle emitters.
4. **Camera & HUD (`MandoApp`, `MandoHUD`):** Updates smooth third-person chase camera, checks proximity to `NEVARRO_LANDMARKS`, updates fuel/altitude meters, and triggers `MandoAudioSystem` footsteps and jetpack roar.
