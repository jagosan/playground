# Spec 40: Mandalorian — Nevarro Frontier (Milestone 1: Town Traversal & Jetpack)

- **ID:** `SPEC-PLAY-040` / `TASK-PLAY-087`
- **Project:** Playground (`games/mandalorian` + Playground 3D Lobby entry)
- **Status:** Draft — Ready for Review
- **Recommended Engine:** `jagular` (with parallel `tigger` fan-out for independent modules)

---

## 1. Vision & Scope

Create a dedicated, standalone 3D game entry in the **Playground** monorepo (`games/mandalorian/`) inspired by Season 1 of *The Mandalorian*, built for the user's godson.

**Milestone 1** focuses exclusively on **exploring a Nevarro-inspired frontier town on foot and flying with a rocket pack (jetpack)**:
- **Reuse Lunar Frontier Environment:** Reuse `LunarWorldGenerator` (seeded heightfield, craters, rock scatter) and Babylon.js rendering patterns from `games/lunar-frontier`, re-themed from airless vacuum to a warm, dusty volcanic/basalt **Nevarro** frontier atmosphere (ochre-amber sky, distance haze, warm sunlight, dark basalt/sandstone regolith).
- **The Mandalorian Avatar:** Procedural Babylon.js Beskar-armored character with T-visor helmet, pauldrons, chestplate, cape, and twin-nozzle **Z-6 Jetpack** with active thruster flame/smoke plumes.
- **Terrestrial Walking (No Lunar Bounding):** Unlike Lunar Frontier's low-G `1.62 m/s²` "Steelpush" bounding/leaping gait, Mando walks and sprints under standard `9.81 m/s²` gravity with grounded, planted two-foot locomotion.
- **Rocket Pack Flight:** Holding Jump (`Space`, Gamepad `A`, or Touch `[🚀 JET]`) ignites the jetpack for smooth vertical climb, hover, and directional flight, complete with fuel gauge, ground recharge, rooftop landings, and procedural thruster audio.
- **Nevarro Frontier Town:** A walkable/flyable Season 1 frontier town centered at `(0, 0)` featuring The Cantina, Bounty Hunters' Guild Hall, The Armorer's Forge, Market Bazaar, Moisture Vaporators, and a Durasteel Landing Pad with a Razor-Crest-style gunship silhouette.
- **Separate Playground Game Entry:** Standalone Vite + Babylon.js app (`games/mandalorian/` on port `5175`) AND integrated into the 3D Playground Lobby (`src/entities/Equipment.ts`, `src/main.ts`, `src/ui/MandalorianOverlay.ts`) as its own selectable equipment station.

**Out of Scope for Milestone 1:** Combat, blasters, enemies, NPC dialogue trees, quests/economy, or multiplayer server sync (client-only standalone experience).

---

## 2. Architecture & Module Layout

```
repos/playground/
├── package.json                          # Add mando:client / mando:dev scripts
├── src/
│   ├── main.ts                           # Wire 'mandalorian' minigameId -> MandalorianOverlay
│   ├── entities/Equipment.ts             # Add Playground lobby equipment: "Mandalorian: Nevarro"
│   └── ui/MandalorianOverlay.ts          # Full-viewport iframe overlay (:5175) + Esc/Return
└── games/
    └── mandalorian/
        ├── package.json                  # Standalone scripts (dev/client on 5175, build, smoke)
        ├── tsconfig.json                 # TypeScript config referencing @lunar/* and local src
        ├── vite.config.ts                # Root src/client, port 5175, alias @lunar -> ../lunar-frontier/src
        ├── index.html                    # Entry HTML (or src/client/index.html)
        ├── scripts/
        │   └── smoke-mandalorian-m1.ts   # Headless NullEngine + physics + town + avatar smoke suite
        └── src/
            ├── physics/
            │   └── MandoPhysics.ts       # 9.81 m/s² walk/sprint + jetpack thrust/fuel + building/roof collision
            ├── entities/
            │   └── MandalorianAvatar.ts  # Procedural Beskar armor, T-visor, cape, Z-6 jetpack + thruster FX
            ├── world/
            │   ├── NevarroTown.ts        # Procedural Nevarro buildings, landing pad, gunship, collider registry
            │   └── NevarroWorldScene.ts  # Reuses LunarWorldGenerator + Babylon.js scene, lighting, rock scatter
            ├── audio/
            │   └── MandoAudioSystem.ts   # Procedural Web Audio: footsteps, jetpack ignition/roar, forge/town ambience
            ├── ui/
            │   ├── MandoHUD.ts           # Minimal Beskar HUD: Jetpack Fuel, Altitude, Landmark Tracker, [U] hide UI
            │   └── mando-hud.css         # Responsive Beskar-themed glassmorphic styling + touch buttons
            └── client/
                ├── index.html            # Game viewport HTML
                ├── main.ts               # Browser bootstrap
                └── MandoApp.ts           # Main loop, camera rig, keyboard/mouse/gamepad/touch input arbiter
```

### Shared Dependency Strategy (`@lunar/*`)
- `games/mandalorian/vite.config.ts` maps `@lunar` $\to$ `../lunar-frontier/src` and adds `games/lunar-frontier` to `server.fs.allow`.
- `games/mandalorian` reuses `LunarWorldGenerator` (`@lunar/world/LunarWorldGenerator.ts`) directly for deterministic terrain heightfields (`groundAt(x, y)`), craters, and rock scatter without duplicating terrain generation code.
- `games/mandalorian` uses `@babylonjs/core` (`^9.26.0`) matching `games/lunar-frontier`.

---

## 3. Subsystem Contracts

### 3.1 `MandoPhysics.ts` — Grounded Walking & Jetpack Flight
- **Constants:**
  - `MANDO_GRAVITY = 9.81` ($\text{m/s}^2$, terrestrial/Nevarro gravity — **never** `1.62`).
  - `WALK_SPEED = 4.5` ($\text{m/s}$), `SPRINT_SPEED = 7.8` ($\text{m/s}$).
  - `JETPACK_THRUST = 18.5` ($\text{m/s}^2$ upward acceleration, net $+8.69\,\text{m/s}^2$ climb).
  - `JETPACK_AIR_ACCEL = 14.0` ($\text{m/s}^2$ horizontal steering while airborne).
  - `JETPACK_MAX_SPEED_XY = 13.5` ($\text{m/s}$), `JETPACK_MAX_CLIMB_VZ = 9.0` ($\text{m/s}$).
  - `JETPACK_FUEL_MAX = 100.0`, `JETPACK_BURN_RATE = 22.0` (units/s, $\sim 4.5\,\text{s}$ continuous burn), `JETPACK_RECHARGE_RATE = 35.0` (units/s while grounded, after `0.35s` cooldown).
  - `JETPACK_MAX_ALTITUDE_M = 65.0` (soft ceiling damper above local terrain so kids don't fly infinitely into skybox).
- **State (`MandoPhysicsState`):**
  - `x, y, z` (meters, `z` is vertical elevation), `vx, vy, vz`, `heading` (rad), `isGrounded: boolean`, `isJetpacking: boolean`, `jetpackFuel: number`, `stridePhase: number`, `speedRatio: number`, `standingOnStructureId: string | null`.
- **Invariants:**
  - **Zero Lunar Bounding:** `stepMandoPhysics(state, input, dt, surfaceQuery)` must **never** apply Lunar Frontier's `hurry` / Steelpush jump-launch impulses. Walking/sprinting keeps `z` clamped to `surfaceZ` when `vz <= 0` and `jetpack` is not active.
  - **Surface & Rooftop Query (`SurfaceQuery`):** Accepts `(x, y, currentZ) => { floorZ: number; structureId: string | null }` plus horizontal AABB/cylinder push-out for building walls so Mando collides cleanly with walls while walking, yet can land and walk on flat rooftops, balconies, and the landing pad deck!

### 3.2 `MandalorianAvatar.ts` — Beskar Armor, Cape & Jetpack
- **Procedural Mesh Hierarchy (`root` -> `pelvis`, `torso`, `head`, `cape`, `jetpack`, `leftArm`/`rightArm`, `leftLeg`/`rightLeg`):**
  - **Helmet:** Rounded dome + flared cheek/mandible guards + dark recessed **T-visor** (`#090d14`, low roughness) + brushed chrome **Beskar** PBR (`#b8c2cc`, metallic `0.9`, roughness `0.25`) + rangefinder stalk on right earcap.
  - **Armor:** Beskar chestplate, flared left/right pauldrons (with Mudhorn-inspired emblem accent on right pauldron), dark flight-suit undersuit (`#2b2623`), brown leather bandolier/belt (`#5c3a21`), vambraces, and armored greaves/boots.
  - **Cape:** Multi-segment articulated cloth/plane cape attached to upper back; trails backward proportionally to horizontal speed and flutters dynamically during jetpack flight.
  - **Z-6 Jetpack:** Back-mounted silver/slate rocket pack with central thruster bell + twin angled side nozzles.
  - **Thruster FX:** Emissive orange-cyan flame cones (`thrusterLeft`, `thrusterRight`) + Babylon `ParticleSystem` (guarded for `NullEngine` compatibility) that ignite smoothly when `state.isJetpacking === true`.
- **Articulation (`updateAnimation(state, dt)`):**
  - **Idle:** Subtle breathing + cape settle.
  - **Walk / Sprint:** Classic grounded alternating two-leg stride (`sin(stridePhase)`) and counter-swinging arms; boots plant cleanly on the ground.
  - **Jetpack Flight:** Slight forward pitch (`~12°`), knees slightly bent (`0.25 rad`) in heroic flight posture, arms balanced outward/aft, cape streaming behind.

### 3.3 `NevarroTown.ts` & `NevarroWorldScene.ts` — Environment & Season 1 Frontier Town
- **Terrain & Atmosphere (`NevarroWorldScene.ts`):**
  - Uses `LunarWorldGenerator` (`seed: 'nevarro-season1'`) for outer craters, ridges, and basalt rock scatter (`ThinInstance`), with a **graded town basin** (`R <= 85m` around `(0, 0)`) smoothly flattened to `z ≈ 0.0m` so town streets and buildings sit flush without floating or clipping.
  - **Atmosphere:** Warm dusty dusk/daylight sky (`#c98a5b` horizon fading to `#5c3b2e` zenith), `Fog` (`FOGMODE_EXP2`), warm directional sun (`#ffd4a3`) + cool fill hemisphere light (`#7c8fa6` / `#4a3222`).
  - **Ground Material:** Procedural `RawTexture` basalt/sandstone dust texture (Headless `NullEngine` safe — no external PNGs required).
- **Nevarro Town Layout (`NevarroTown.ts`):**
  - **Central Plaza (`(0, 0)`):** Packed-earth/stone plaza with central glowing brazier/beacon and radial street paths.
  - **The Cantina (`(24, 18)`):** Iconic curved adobe/mudbrick dome building, recessed archway entrance, warm amber interior glow (`PointLight` + emissive doorway), exterior fabric awning, and **walkable flat rooftop terrace** (`z = 5.2m`) with parapet.
  - **Bounty Hunters' Guild Hall (`(-26, 16)`):** Heavy stepped stone hall with arched columns, Guild banner/emblem, and **walkable upper balcony/roof** (`z = 6.5m`).
  - **The Armorer's Forge (`(-22, -24)`):** Basalt covert alcove with glowing orange crucible/anvil, heat-shimmer point light, and Beskar ingot stacks.
  - **Market Bazaar & Vaporators (`(18, -22)`, `(6, 26)`, `(-8, -28)`):** Clustered sandstone stalls with terracotta/ochre canopies, crates, speeder hitching posts, and 3 tall moisture vaporator spires (`z = 9m`) with blinking beacons.
  - **Durasteel Landing Pad & Gunship (`(58, -10)`):** Elevated circular landing pad (`R = 14m`, `z = 1.2m`) with perimeter landing lights and a **Razor-Crest-inspired twin-engine gunship** (stubby fuselage, twin oversized outboard nacelle engines, cockpit canopy, boarding ramp) parked on struts — walkable on deck & wings!
- **Landmark Registry:** Exports `NEVARRO_LANDMARKS` (`id`, `name`, `x`, `y`, `z`, `radius`) for HUD wayfinding and the Milestone 1 exploration checklist.

### 3.4 `MandoApp.ts`, `MandoHUD.ts`, `MandoAudioSystem.ts`
- **Camera:** Third-person chase camera behind Mando (`CameraRig`-style smooth follow, mouse-look / pointer-lock or drag-look, right-stick gamepad look, and mobile virtual right-stick). `[V]` cycles `chase` / `wide` / `close`.
- **Controls:**
  - Keyboard: `WASD` / Arrows to walk, `Shift` to sprint, `Space` to ignite Jetpack, `V` camera view, `U` toggle HUD, `Esc` release pointer lock / return prompt.
  - Gamepad: Left Stick move, Right Stick camera look, `A` / `LT` Jetpack, `L3`/`B` sprint.
  - Mobile Touch: Virtual left move stick, right look stick, `[🚀 JET]` hold button, `[🎥 VIEW]` button.
- **HUD (`MandoHUD.ts`):**
  - Top-left: **Beskar Crest & Town Compass** + Landmarks Visited (`0/5` — Cantina, Guild Hall, Armorer's Forge, Market Bazaar, Landing Pad).
  - Bottom-center: **Jetpack Fuel Bar** (amber-orange gradient, flashes red when <20%, smooth recharge fill) + **Altitude (`ALT: X.Xm`)**.
  - Bottom-right: Compact controls hint (`WASD Walk · Shift Sprint · Space Jetpack · V View · U Hide UI`).
- **Audio (`MandoAudioSystem.ts`):** Procedural Web Audio API (no external audio files; safely no-ops in `NullEngine` Node tests): soft dusty footsteps synced to `stridePhase`, roaring filtered-noise + sub-bass jetpack thrust while `isJetpacking`, and subtle warm wind/forge crackle ambience.

### 3.5 Playground Lobby Integration
- Add `"Mandalorian: Nevarro"` equipment station in `src/entities/Equipment.ts` (e.g., at `(0, 0, 12)` — a miniature Beskar helmet & rocket-pack launch pad pedestal).
- Wire `minigameId === 'mandalorian'` in `src/main.ts` to stop the lobby `SceneManager` and mount `MandalorianOverlay` (`src/ui/MandalorianOverlay.ts`), pointing to `http://${hostname}:5175/` with `◄ RETURN TO PLAYGROUND LOBBY` button and `[Esc]` exit.

---

## 4. Phased Implementation Plan

1. **Phase 1 — Subproject Scaffold & `MandoPhysics.ts`:**
   - Create `games/mandalorian/` (`package.json`, `tsconfig.json`, `vite.config.ts`, `src/client/index.html`) with `@lunar/*` alias.
   - Implement `MandoPhysics.ts` (`9.81 m/s²` grounded walk/sprint, zero lunar bounding, jetpack thrust/fuel/recharge, AABB/cylinder wall + rooftop collision).
2. **Phase 2 — `MandalorianAvatar.ts` & `NevarroTown.ts`:**
   - Build procedural Beskar Mando mesh (T-visor helmet, pauldrons, cape, Z-6 jetpack + thruster cones/particles) and grounded/flight animations.
   - Build `NevarroTown.ts` (Cantina, Guild Hall, Armorer's Forge, Bazaar, Vaporators, Landing Pad + Gunship, colliders, landmarks).
3. **Phase 3 — `NevarroWorldScene.ts`, `MandoAudioSystem.ts` & `MandoHUD.ts`:**
   - Reuse `LunarWorldGenerator` for outer terrain + graded town basin, warm Nevarro lighting/sky/fog, procedural basalt textures.
   - Implement `MandoAudioSystem.ts` (footsteps, jetpack roar) and `MandoHUD.ts` + `mando-hud.css` (fuel gauge, altitude, landmark checklist, touch buttons).
4. **Phase 4 — `MandoApp.ts` & Playground Lobby Integration:**
   - Wire `MandoApp.ts` (third-person camera, keyboard/mouse/gamepad/touch input, `main.ts` bootstrap).
   - Register `mando:client` / `mando:dev` in root `package.json`, add Playground Lobby equipment in `src/entities/Equipment.ts`, `MandalorianOverlay.ts`, and `src/main.ts`.
5. **Phase 5 — Headless Smoke Verification & Build Gate:**
   - Author `games/mandalorian/scripts/smoke-mandalorian-m1.ts` verifying:
     1. `MandoPhysics` terrestrial `9.81 m/s²` walk/sprint (no lunar bounding), jetpack climb/hover, fuel burn & ground recharge, wall & rooftop collision.
     2. `MandalorianAvatar` mesh hierarchy (helmet, T-visor, cape, jetpack, thrusters) and animation states.
     3. `NevarroTown` landmarks, colliders, rooftop floor queries, and `NevarroWorldScene` `NullEngine` boot + `LunarWorldGenerator` reuse.
     4. `MandoApp` headless update loop & `npm run build` clean exit in both `games/mandalorian` and root `playground`.

---

## 5. Acceptance Criteria

- [ ] `games/mandalorian` runs standalone via `npm run mando:client` on port `5175` and builds cleanly via `npm run build`.
- [ ] Playground 3D lobby (`npm run dev`) displays the new Mandalorian station and launches/exits `MandalorianOverlay` cleanly.
- [ ] Mando walks and sprints on Nevarro with `9.81 m/s²` gravity (no lunar bounding/Steelpush leaps).
- [ ] Holding Jump/Jetpack ignites twin thrusters, lifts Mando smoothly onto Cantina/Guild rooftops and the Landing Pad gunship, burns fuel, and recharges when grounded.
- [ ] `npx tsx scripts/smoke-mandalorian-m1.ts` passes all assertions in headless `NullEngine` with zero errors.
