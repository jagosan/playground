# Spec 21: Lunar Frontier — World Building, Atmospheric Lighting, Rail Traffic, Tunnel Facilities, Topographic Map & Gamepad Rectification

> **Target Systems:** `games/lunar-frontier/src/world/LunarWorldGenerator.ts`, `games/lunar-frontier/src/engine/WorldScene.ts`, `games/lunar-frontier/src/infrastructure/TunnelNetwork.ts`, `games/lunar-frontier/src/infrastructure/RailSystem.ts`, `games/lunar-frontier/src/ui/LunarHUD.ts`, `games/lunar-frontier/src/ui/hud.css`, `games/lunar-frontier/src/client/ClientApp.ts`, `games/lunar-frontier/src/entities/OpenBuggy.ts`.  
> **Platforms:** WebGL2/WebGPU Desktop (Chrome, Firefox, Safari), Steam Deck & Handhelds (GPD Win Max 2, Linux Gamepad API).  
> **Preceding Specs:** Spec 12 (Core Economy & Infra), Spec 14 (Visual Infrastructure), Spec 16/17 (Rover Kinematics & Proving Grounds), Spec 18 (Quest Framework), Spec 19 (Gamepad & Mining UX), Spec 20 (Hill-Hold & Decoupled Stick Layout).

---

## 1. Executive Summary & Problem Analysis

Player telemetry and field evaluations on the lunar surface revealed six critical world-building and usability shortcomings that degrade immersion, spatial orientation, and gameplay coherence:

1. **Barren, Monotonous World Detritus:**
   - The lunar surface currently contains only procedurally placed smooth craters, raw mineral veins, and faction bases. There is zero evidence of the historic lunar exploration rush or decades of abandoned industrial prospecting.
   - The environment lacks frontier atmosphere: crashed exploration landers, discarded drill derricks, oxidized solar panel wings, tangled cable reels, and salvageable scrap piles.
   - Players have nothing to discover or scavenge outside of raw ore veins, leaving the world feeling synthetic rather than lived-in.

2. **Harsh, Confusing Surface Lighting & Weak Buggy Headlights:**
   - The sun light intensity ($3.1$) vs earthshine ($0.08$) creates an extreme $\approx 40:1$ luminance ratio. Surfaces angled toward the sun are blinding chalk-white, while craters and slopes facing away plunge into impenetrable void-black shadows.
   - Players cannot tell whether dark regions represent the lunar night side, permanent shadow regions (PSRs), or merely local micro-slopes, making navigation disorienting and exhausting.
   - Buggy headlights (`HEADLIGHT_INTENSITY: 3.2`, range $65\,\text{m}$, angle $58^\circ$) are clamped horizontally to $y = 0$, failing to track chassis pitch and roll when driving up or down crater walls. In deep shadows, players drive blind.

3. **Dead Railroad Infrastructure:**
   - The narrow-gauge ($0.75\,\text{m}$) steel tracks generated across the terrain and tunnel descents are completely static.
   - While `RailSystem.ts` provides ore cart models and physics wrappers, `ClientApp.ts` never calls `spawnCart()` or `update()`.
   - Players encounter empty rails with no automated trains, no ore movements, and no kinetic world life.

4. **Abstract, Disorienting Tunnels & Absence of Facilities:**
   - Tunnels are rendered as raw basalt cylinders punching blindly into the ground, lacking entrance portals, hazard striping, or operational context.
   - Tunnels lead to abstract coordinate points rather than recognizable underground facilities (abandoned stopes, control bunkers, ore vaults).
   - There are no interior partitions, bulkheads, locked doors, or high-value objectives, leaving players wondering why the tunnels exist.

5. **Lack of Macro Spatial Orientation (Missing Topographic Map):**
   - The lunar regolith surface exhibits subtle elevation changes that are difficult to interpret from first-person or third-person ground perspectives.
   - Players have no overhead representation of crater boundaries, trading posts, mining claims, tunnel shaft heads, or rail routes.
   - Without an overhead map, players cannot plan travel routes or understand the macro layout of the mining sectors.

6. **Dormant and Mis-Indexed Gamepad Input:**
   - The HTML5 Gamepad API remains dormant until a physical button is pressed inside an active window, yet no connection prompt or listener guides the player.
   - Handheld gaming PCs (GPD Win Max 2, Steam Deck) present virtual gyros or sensor hubs at `gamepads[0]` with 0 buttons and 0 axes. The client latched onto these dead virtual devices, ignoring the real physical controller at index 1.
   - The decoupled `drive_right_look_left` layout specified in Spec 20 remained unmerged in the client, causing camera yaw commands to bleed into steering.

Spec 21 delivers an end-to-end world-building overhaul resolving all six pillars.

---

## 2. Detailed Technical Specifications

### 2.1 Pillar 1: Surface Detritus, Frontier Scrap & Salvage Economy

1. **Detritus Generator & Classification (`LunarWorldGenerator.ts`, `WorldScene.ts`):**
   - Add procedural scrap scatter generation within a $500\,\text{m}$ radius of old mine shafts, crater rims, and historical crash sites.
   - Define three distinct visual scrap archetypes:
     - **Crashed Lander Wreckage (`lander_wreck`):** Octagonal descent stage frame, crumpled gold Kapton thermal foil panels, spherical helium/oxidizer tanks, bent landing struts, and fractured RCS thruster bells.
     - **Abandoned Mining Rig (`mining_rig`):** Heavy steel A-frame derrick, rusted core-drill motor housing, discarded conveyor chutes, and battered ore hoppers.
     - **Wild-West Frontier Junk (`junk_pile`):** Crushed pressurized fuel cylinders, tangled pneumatic hose coils, jury-rigged avionics chassis, and sheared structural titanium girders.
   - Each site contains $1 \dots 4$ interactable salvage nodes.

2. **Procedural Assembly & Materials:**
   - Constructed entirely via procedural Babylon.js geometry (`MeshBuilder.CreateBox`, `CreateCylinder`, `CreatePolyhedron`) with zero external GLB dependencies, maintaining instant loading and headless test compatibility.
   - PBR Materials: weathered oxidized titanium, flaked gold Kapton foil (`metallic: 0.85, roughness: 0.25`), and dust-covered rusted industrial orange steel (`metallic: 0.1, roughness: 0.9`).

3. **Scavenging & Jury-Rigging Interaction Loop:**
   - Proximity query: when an EVA astronaut (within $3.5\,\text{m}$) or buggy (within $4.5\,\text{m}$) approaches an unharvested scrap site, display HUD prompt:
     `[E] / (X) Salvage Scrap Component`.
   - On salvage:
     - Play a 3D visual particle/spark effect (`spawnSalvageSparks`).
     - Grant $1 \dots 2$ salvage items to inventory:
       - `Titanium Structural Strut` (mass: $12\,\text{kg}$, value: $150\,\text{cr}$)
       - `Jury-Rigged Fluid Coupler` (mass: $5\,\text{kg}$, value: $220\,\text{cr}$)
       - `Auxiliary Solar Wafer` (mass: $2\,\text{kg}$, value: $340\,\text{cr}$)
       - `Depleted Fuel Cell Core` (mass: $18\,\text{kg}$, value: $450\,\text{cr}$)
       - `Scrap Avionics PCB` (mass: $1\,\text{kg}$, value: $500\,\text{cr}$)
     - The scrap node visibly transforms into a picked-over skeleton (reduced scale / disabled emissive blinker).

---

### 2.2 Pillar 2: Balanced Lunar Lighting & High-Authority Buggy Floodlights

1. **Balanced Airless Lighting Rig (`WorldScene.ts`):**
   - Tame extreme specular and diffuse blowouts:
     - Set `sunIntensity = 2.2` (reduced from $3.1$).
     - Calibrate sun diffuse color to balanced natural sunlight `Color3(1.0, 0.98, 0.92)`.
   - Enhance secondary bounce fill (Earthshine + Regolith Ambient):
     - Increase `earthshineIntensity = 0.24` (elevated from $0.08$).
     - Set hemispheric ground color to deep lunar dust bounce `Color3(0.08, 0.08, 0.09)`.
     - In regolith PBR material, elevate minimum emissive floor to `Color3(0.035, 0.035, 0.038)`, ensuring crater floors facing away from the sun retain discernible geometric relief rather than crushing to pitch black.

2. **Chassis-Aligned Dual-Stage Buggy Floodlights (`OpenBuggy.ts`):**
   - Recompute spotlight beam directions dynamically from the buggy chassis orientation matrix (`chassis.getWorldMatrix()`), incorporating true vehicle pitch and roll:
     $$\mathbf{d}_\text{beam} = \mathbf{R}_\text{chassis} \cdot \begin{pmatrix} 0 \\ -0.07 \\ 1 \end{pmatrix}$$
     (providing a natural $4^\circ$ downward depression to illuminate approaching terrain dips).
   - Implement dual-stage lighting:
     - **Low-Beam Flood (Always on with lights):** Wide $85^\circ$ cone, $45\,\text{m}$ throw, $2.8$ intensity.
     - **High-Beam Long Range Spot:** Narrow $42^\circ$ piercing beam, $120\,\text{m}$ throw, $4.5$ intensity.
   - Add EVA Astronaut Helmet Flood:
     - When exploring on foot, mount a forward-facing spotlight (`angle: 70^\circ`, range: $30\,\text{m}$, intensity: $2.0$) aligned with the camera look vector.

---

### 2.3 Pillar 3: Automated Freight Train System (`RailSystem.ts`, `ClientApp.ts`)

1. **Continuous Freight Loop Scheduling:**
   - In `ClientApp.ts`, initialize and maintain an automated train consist on primary rail routes (e.g. `route-001` connecting the central mare refinery to the deep crater adit).
   - Consist composition:
     - 1 Heavy Automated Electric Locomotive (`ore-loco-1`) with high-intensity forward headlight beam and amber roof beacon.
     - 2 Automated Ore Hopper Carts (`ore-cart-1`, `ore-cart-2`) loaded with mineral rock chunks.
   - Stepping dynamic:
     - In `ClientApp.update(dt)`, step `RailSystem.update(dt, commands)`.
     - Automated state machine: accelerates along route polyline at $1.5\,\text{m/s}^2$ up to cruising velocity ($12\,\text{m/s}$), cruises across surface and ramps, slows smoothly before terminal buffers, dwells for $15\,\text{s}$ loading/unloading, and reverses direction.

2. **Kinetic Audio-Visual Presence & Cargo Siphoning:**
   - Train casts dynamic shadows and emits rhythmic wheel-rail contact sounds.
   - **Cargo Siphoning Foundation:**
     - If the player buggy pulls alongside a moving or stopped hopper within $4.0\,\text{m}$ matching speed ($|\Delta v| < 3\,\text{m/s}$), HUD surfaces:
       `[E] / (X) Intercept Freight Cargo`.
     - Siphoning transfers $250\,\text{kg}$ of refined ore into the buggy flatbed, triggering an automated security alarm beacon on the locomotive.

---

### 2.4 Pillar 4: Structural Tunnel Portals, Bunker Facilities & Locked Vaults

1. **Surface Shaft Heads & Concrete Portal Architecture (`TunnelNetwork.ts`):**
   - Every tunnel entrance where $z \ge -2\,\text{m}$ is framed with a heavy reinforced portal arch:
     - Concrete collar abutment with high-visibility yellow-and-black hazard chevron striping.
     - Overhead gantry with illuminated neon identification beacon (`"SHAFT 04 // DEEP SECTOR ADIT"`).
     - Heavy structural twin steel bore rings extending $12\,\text{m}$ into the rock.

2. **Underground Control Bunkers & Mining Caverns:**
   - At terminal tunnel nodes (`kind === 'cavern'`), generate a wide subterranean bunker chamber ($30\,\text{m} \times 20\,\text{m} \times 8\,\text{m}$):
     - Arched ceiling rib trusses.
     - Industrial wall cable trays and low-intensity amber emergency bulkhead strip lights.
     - Modular computer consoles with flickering green vector CRTs.

3. **Locked Security Bulkheads & High-Value Vaults:**
   - Place a reinforced steel vault door (`vault-door-01`) sealing the inner sanctum of underground caverns.
   - Door State Machine: `LOCKED` (red beacon) $\to$ `UNLOCKED` (green beacon) $\to$ `OPEN` (slid into recess).
   - Terminal Keypad Console:
     - Proximity interaction: `[E] / (X) Interface Security Terminal`.
     - Unlocks with a Security Keycard or jury-rigged bypass wire salvaged from surface detritus.
   - High-Value Vault Loot:
     - **Auxiliary Buggy Fuel Cell:** Restores $100\%$ buggy battery and permanently expands battery capacity by $+15\,\text{kWh}$.
     - **Advanced Prospector EVA Suit:** Upgraded oxygen rebreather ($+100\%$ duration) and expanded cargo backpack ($160\,\text{kg}$).
     - **Refined Cryo-Fuel Canister:** High-value trade commodity ($1,200\,\text{cr}$).

---

### 2.5 Pillar 5: Topographic Holographic Surface Map (`LunarHUD.ts`, `hud.css`, `ClientApp.ts`)

1. **Tactical Holographic Map Overlay (`#lunar-map-overlay`):**
   - Full-screen glassmorphic tactical navigation display toggled via:
     - Keyboard: `[M]`
     - Gamepad: `View / Back / Select` (button 8 or 9) or D-Pad Down.
     - HUD clickable button: `[MAP]` in top-right status bar.
   - Map Visual Elements:
     - **Topographic Heightfield Canvas:** $512 \times 512$ canvas rendering elevation contour lines and shaded relief computed directly from `LunarWorldGenerator.elevationAt()`.
     - **Crater Rims:** Distinct circular relief rings marking named craters.
     - **Resource Vein Icons:** Color-coded pips (Cyan = Water Ice, Orange = Helium-3, Silver = Titanium, Violet = Rare Earths, Grey = Regolith).
     - **Infrastructure Layers:**
       - Faction Bases & Trading Terminals (Gold/Faction crests with labels).
       - Tunnel Portals & Shaft Heads (Diamond icons).
       - Rail lines (Dotted steel lines with live pulsing train position marker).
     - **Player Location & Heading:** High-visibility pulsing arrowhead showing current position and yaw heading in real-time.
   - Dismissal: Pressing `[M]`, `Escape`, Gamepad `(B) / Back`, or clicking `[CLOSE MAP]` immediately dismisses the map and restores gameplay control.

---

### 2.6 Pillar 6: Resilient Gamepad Latching & Decoupled Controls

1. **Active Handheld Device Latching (`ClientApp.ts`):**
   - Listen to window `gamepadconnected` and `gamepaddisconnected` events.
   - Filter out dead virtual/sensor devices: require candidate gamepads to have $\ge 6$ buttons and $\ge 2$ axes before qualifying as a valid controller.
   - Scan all connected devices each tick; latch onto whichever device demonstrates above-deadband stick or button activity.
   - Display dynamic HUD status prompt:
     - If no controller active: `PRESS ANY BUTTON ON CONTROLLER TO ACTIVATE`.
     - Once latched: brief toast `GAMEPAD ACTIVE: [ID]`.

2. **Decoupled Dual-Stick Architecture (Spec 20 Integration):**
   - Implement `drive_right_look_left` as the primary layout:
     - **Left Stick X/Y:** Look Yaw & Look Pitch (zero influence on steering).
     - **Right Stick X:** Vehicle Steer (progressive exponential curve $\gamma = 1.6$).
     - **Right Stick Y:** Forward Throttle / Reverse Drive.
   - Preserve Analog Triggers: RT = Forward Throttle, LT = Progressive Brake & Brake-to-Reverse.
   - Runtime toggle between `Drive Right / Look Left` and `Standard Twin-Stick` via hotkey `[J]` or gamepad combo `L3 + R3`.

---

## 3. Subsystem Architecture & Interface Contracts

```
┌────────────────────────────────────────────────────────────────────────┐
│                        World & Infrastructure Layer                    │
│                                                                        │
│   LunarWorldGenerator ────────► WorldScene ────────► TunnelNetwork     │
│   • Detritus Placement          • Balanced Light      • Portals        │
│   • Bunker Nodes                • Regolith Albedo     • Bunkers        │
│   • Vault Locations             • Starfield           • Locked Doors   │
│                                                       • Vault Loot     │
└──────────────────┬───────────────────┬─────────────────────────────────┘
                   │                   │
                   ▼                   ▼
┌───────────────────────────────┐ ┌──────────────────────────────────────┐
│      RailSystem Engine        │ │        Entities & Controls           │
│  • Automated Consist          │ │  • OpenBuggy (Chassis Spotlights)    │
│  • Continuous Loop            │ │  • AstronautSuit (Helmet Flood)      │
│  • Cargo Siphoning            │ │  • TraversalPhysics (Hill-Hold)      │
└──────────────┬────────────────┘ └──────────────────┬───────────────────┘
               │                                     │
               ▼                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        ClientApp & HUD Orchestration                   │
│                                                                        │
│   ClientApp.ts                                                         │
│   • Multi-Device Gamepad Latching                                      │
│   • Automated Train Stepping                                           │
│   • Salvage & Vault Interaction Bus                                    │
│   • Topographic Map Generator & State Machine                          │
│                                                                        │
│   LunarHUD.ts & hud.css                                                │
│   • Topographic Map Modal Canvas & POI Markers                         │
│   • Salvage & Locked Door Proximity Prompts                            │
│   • Gamepad Activation & Stick Layout Badges                           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Phase-by-Phase Implementation Plan

### Phase 1: Surface Detritus, Salvage System & Balanced Surface Lighting
- **Files:** `LunarWorldGenerator.ts`, `WorldScene.ts`, `OpenBuggy.ts`, `ClientApp.ts`.
- **Tasks:**
  - Generate procedural scrap sites and detritus wreckage across the surface.
  - Implement PBR materials for scrap, Kapton foil, and rusted industrial frames.
  - Rebalance sun intensity ($2.2$) and earthshine fill ($0.24$), raising regolith shadow floor.
  - Upgrade buggy headlights to chassis-matrix aligned dual-stage floodlights.
  - Implement proximity salvage mechanics yielding crafting components.

### Phase 2: Automated Freight Train & Subterranean/Surface Rail Loop
- **Files:** `RailSystem.ts`, `ClientApp.ts`.
- **Tasks:**
  - Spawn automated locomotive + ore hopper consist on primary freight line.
  - Step train kinematics in `ClientApp.update(dt)` with terminal deceleration and reverse loop.
  - Implement cargo siphoning interaction alongside moving/docked train.

### Phase 3: Tunnel Portals, Underground Bunkers & Locked Vaults
- **Files:** `TunnelNetwork.ts`, `ClientApp.ts`, `LunarHUD.ts`.
- **Tasks:**
  - Construct reinforced hazard-striped entrance portals at surface shaft heads.
  - Build underground control bunker chambers with rib trusses and emergency lighting.
  - Add locked security bulkhead doors with terminal interactions and high-value vault loot.

### Phase 4: Holographic Topographic Map & Tactical Navigation Overlay
- **Files:** `LunarHUD.ts`, `hud.css`, `ClientApp.ts`.
- **Tasks:**
  - Build 2D elevation contour & shaded relief generator from world heightfield.
  - Render POI markers for mining sites, bases, portals, rail routes, and live player/train pips.
  - Wire toggle controls (`[M]`, Gamepad `View/Back`, HUD button) and dismiss handlers.

### Phase 5: Resilient Gamepad Controller Latching & Decoupled Stick Controls
- **Files:** `ClientApp.ts`, `LunarHUD.ts`.
- **Tasks:**
  - Implement dynamic multi-gamepad scanning with handheld filtering ($\ge 6$ buttons).
  - Add `gamepadconnected` listener and activation status prompt.
  - Wire decoupled `drive_right_look_left` layout and trigger brake-to-reverse.

### Phase 6: Headless Verification & Production Build
- **Files:** `tests/verify-world-building.ts`, `scripts/smoke-client-app.ts`.
- **Tasks:**
  - Author automated smoke test covering detritus salvage, train updates, bunker portals, vault doors, map canvas rendering, and gamepad latching.
  - Verify all 329+ existing client checks pass.
  - Validate production build (`npm run build`).

---

## 5. Acceptance Criteria & Quality Gates

1. **Surface Detritus:**
   - $\ge 15$ scrap sites spawned across the $1024\,\text{m}$ world patch.
   - Proximity prompt triggers on foot and in buggy; salvage successfully deposits items to inventory.
2. **Surface Lighting:**
   - Unlit crater slopes maintain visible texture detail ($E \ge 0.035$); sunlit slopes do not saturate to blown-out white.
   - Buggy headlights pitch and roll with the chassis, illuminating slopes and dips up to $100\,\text{m}$ ahead.
3. **Automated Train:**
   - Active train consist continuously patrols the track, reversing at route ends without jumping or stalling.
   - Siphoning cargo within $4\,\text{m}$ transfers mineral mass to the player flatbed.
4. **Tunnel Facilities:**
   - Every surface tunnel head features a visible portal arch with hazard markings.
   - Caverns feature control room consoles and locked bulkhead doors with salvageable vault loot.
5. **Topographic Map:**
   - Pressing `[M]` or Gamepad `Back` toggles the topographic map overlay within $<50\,\text{ms}$.
   - Map accurately displays player position, crater contours, mining veins, and train location.
6. **Gamepad Controls:**
   - Connecting or pressing a button on any standard XInput/DirectInput controller instantly activates control.
   - Handheld devices at index 0 without buttons are bypassed in favor of valid gamepads.
7. **Verification & Build:**
   - Full automated headless test suite passes with zero regressions.
   - `npm run build` completes with zero TypeScript or bundling errors.
