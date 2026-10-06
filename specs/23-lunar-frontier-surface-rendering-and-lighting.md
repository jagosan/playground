# Spec 23: Lunar Frontier — Surface Rendering Overhaul, Multi-Scale Regolith Detail, Supercharged Headlights & Visor Exposure Compensation

> **Target Systems:** `games/lunar-frontier/src/engine/WorldScene.ts`, `games/lunar-frontier/src/world/LunarWorldGenerator.ts`, `games/lunar-frontier/src/entities/OpenBuggy.ts`, `games/lunar-frontier/src/entities/AstronautSuit.ts`, `games/lunar-frontier/src/client/ClientApp.ts`, `games/lunar-frontier/src/engine/CameraRig.ts`, `games/lunar-frontier/scripts/smoke-worldscene.ts`, `games/lunar-frontier/scripts/smoke-open-buggy.ts`, `tests/verify-surface-rendering.ts`.  
> **Platforms:** WebGL2/WebGPU Desktop (Chrome, Firefox, Safari), Steam Deck & Handhelds (GPD Win Max 2, Linux Gamepad API).  
> **Preceding Specs:** Spec 12 (Core Economy & Infra), Spec 14 (Visual Infrastructure), Spec 16/17 (Rover Kinematics & Proving Grounds), Spec 20 (Hill-Hold & Decoupled Stick Layout), Spec 21 (World Building & Atmospheric Lighting), Spec 22 (Playground Lobby Integration).

---

## 1. Executive Summary & Photographic Reference Analysis

In field evaluations of Lunar Frontier across desktop and handheld platforms, the lunar terrain remains visually flat, synthetic, and immersion-breaking compared to authentic Apollo lunar surface photography and modern high-fidelity space art. Two primary shortcomings degrade the experience:

1. **Lack of Fine Surface Texture & Micro-Detail:**
   - Currently, the terrain patch in `WorldScene.ts` uses a single $128 \times 128$ procedural normal map tiled $64\times$ over a $1024\,\text{m}$ grid with a flat, uniform albedo `(0.20, 0.19, 0.18)` and no albedo/roughness textures.
   - At ground level, the terrain looks like smooth, painted grey plastic. It completely lacks the multi-scale texture evident in NASA Apollo photographs (e.g. Apollo 15 Hadley Rille, Apollo 17 Station 6 boulder fields):
     - **Micro-Scale ($< 10\,\text{cm}$):** Footprint ridges, tire tread cuts, crumbly agglutinate dust, and micro-cratering catching harsh raking sunlight.
     - **Meso-Scale ($0.5\,\text{m} - 10\,\text{m}$):** Dense scattering of rocks, pebbles, ejecta clasts, and shallow craterlet swales.
     - **Macro-Scale ($10\,\text{m} - 1000\,\text{m}$):** Albedo variegation between dark basalt mare lowlands and lighter anorthositic highland ejecta rays.

2. **Crushed, Unusable "Dark Side" and Weak Vehicle Illumination:**
   - Despite previous adjustments in Spec 21, the shadowed faces of crater walls and unlit areas outside direct sunlight frequently crush into near-black voids, rendering night driving and shadowed exploration disorienting and unplayable.
   - Real lunar regolith exhibits optical backscattering, and human astronauts on EVA rely on active gold-tinted helmet visors and high-gain digital optics that automatically compensate for extreme dynamic range.
   - The buggy headlights (`OpenBuggy.ts`), while dual-stage, lack the immense luminous punch, throw distance, and peripheral flood required of heavy industrial off-world exploration vehicles. In shadows, they feel like weak consumer car headlamps rather than massive stadium-grade LED projectors.

### Photographic Reference Breakdown:
- **Reference 1 (`moon-landscape-view-stockcake.jpg`):** Shows prominent bootprints carved into powdery dust with sharp raking light accentuating crumbly ridges and micro-clasts; stark sun starburst in a jet-black sky, with the Earth hovering over gentle, textured highland dunes.
- **Reference 2 (`moon-base-phase-01-v08-1.webp`):** Large-scale lunar industrial base showing heavy tire track ruts, surface scuffs, scattered modules, and long, well-defined shadows that nonetheless preserve visible terrain geometry across all shadowed zones.
- **Reference 3 (`apollo-15-lunar-surface-exploration-nasascience-photo-library.jpg`):** Apollo 15 LRV parked on the edge of Hadley Rille; extreme textural depth on foreground regolith with thousands of small pebbles and sharp, crisp shadows, contrasting against smooth distant slopes.
- **Reference 4 (`c0268356-800px-wm.jpg`):** Expansive boulder and pebble field on the lunar surface; multi-frequency rock distribution ranging from fine gravel to massive fractured boulders, set against rolling, powdery hills with velvety contrast.

**Spec 23 delivers a comprehensive overhaul of the lunar surface material, multi-tier procedural texture synthesis, GPU rock/pebble field instancing, stadium-grade buggy lighting, and helmet visor dynamic range compensation.**

---

## 2. Technical Architecture & Core Pillars

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SPEC 23 RENDERING ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   [WorldScene: Lighting & Optics]                                           │
│   ├── Stark Key Sunlight (DirectionalLight, hard PCF shadows)               │
│   ├── Earthshine Secondary Fill (HemisphericLight, blue-tinted)             │
│   └── Visor Dynamic Range Compensation (Tone-curve shadow lift)             │
│       └── Unlit areas lifted to clear, washed-out low-light contrast        │
│                                                                             │
│   [Terrain Surface Shading: Multi-Scale Regolith PBR]                       │
│   ├── Macro Albedo Variegation (Mare basalt vs highland ejecta rays)        │
│   ├── Meso Craterlet & Rut Detail Map (16m tiling: bumps, ruts, clasts)     │
│   ├── Micro-Grit Normal & Roughness Map (2m tiling: agglutinates, dust)     │
│   └── Hapke Retroreflective Opposition Surge (Zero-phase backscatter)       │
│                                                                             │
│   [GPU Surface Scatter: Pebble & Rock Field Instancer]                      │
│   ├── ThinInstance Rock Mesh Cluster (0 extra draw calls)                   │
│   ├── Multi-scale: 5cm pebbles, 30cm rocks, 1.5m boulder clasts             │
│   └── Deterministic Poisson/Voronoi scatter keyed to world seed             │
│                                                                             │
│   [Buggy & Suit Illumination: Stadium Projector Rig]                        │
│   ├── Buggy Mega-Flood Array: 110° wide beam, 85m throw, 8.5 intensity      │
│   ├── Buggy Piercing Spot Projector: 30° narrow beam, 250m throw, 15.0 int  │
│   ├── Headlight Volumetric Beam Cones & Lens Projector Glow                 │
│   └── Suit EVA Helmet Projector: 85° beam, 50m throw, 6.0 intensity         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Pillar 1: Multi-Frequency Procedural Regolith Texturing & Surface Shading

To eliminate the uniform grey appearance and match the photographic references, the terrain surface material is upgraded to a three-frequency procedural PBR stack:

1. **Macro Albedo & Variegation Layer ($1024\,\text{m}$ Patch Level):**
   - Synthesizes a high-contrast albedo map distinguishing between:
     - **Mare Basalt Lowlands:** Darker, slightly warmer charcoal-grey (`albedo = (0.13, 0.13, 0.14)`).
     - **Highland Anorthosite & Crater Ejecta:** Lighter, reflective silvery-tan (`albedo = (0.28, 0.27, 0.26)`).
     - **Crater Ray Splatters:** Radial streaks of high-albedo ejecta originating from crater rims (using distance and directional angular noise from `LunarWorldGenerator` crater coordinates).
   - Generates subtle macro albedo variation across rolling hills, giving wide vistas the authentic mottled appearance seen in Apollo orbital and surface photography.

2. **Meso-Scale Detail Map ($16\,\text{m} - 32\,\text{m}$ Tiling):**
   - A dedicated $256 \times 256$ texture containing:
     - Shallow impact craterlet depressions ($0.5\,\text{m} - 3\,\text{m}$ diameter).
     - Clast mounds and crumbly ejecta blankets.
     - Subtle tire rut / vehicle tracks imprinted into the regolith in industrial zones.
   - Bound to the Babylon.js `PBRMaterial.detailMap` or blended into the primary albedo/normal pipeline.

3. **Micro-Grit Normal & Roughness Map ($1.5\,\text{m} - 2\,\text{m}$ Tiling):**
   - High-resolution procedural grit normal map ($256 \times 256$ baked from 5-octave multi-scale simplex/fbm noise).
   - Captures sub-decimeter surface roughness:
     - Sharp angular grains (agglutinates formed by micrometeorite impacts).
     - Powder micro-ridges resembling rake marks and bootprint edges.
     - Roughness channel variation: fine dust has extreme roughness ($0.96$), while exposed agglutinate glass facets provide subtle specular glitter ($0.75$) under low sun angles.
   - Normal map strength calibrated to catch raking sunlight with razor-sharp micro-shadows.

4. **Hapke Photometric Backscatter & Opposition Surge:**
   - Lunar regolith displays a pronounced retroreflective property ("Heiligenschein" / opposition surge), where surfaces viewed along the incident sun vector brighten significantly because particles hide their own shadows.
   - Implemented via a custom Fresnel / specular backscatter term or PBR direct-intensity response that peaks at zero phase angle ($\cos(\alpha) \to 1$ between view vector and sun vector), giving lunar ridges their distinctive velvety, luminous fringe.

---

### 2.2 Pillar 2: Micro-Scatter & Procedural Rock/Pebble Field Instancing

As seen in References 3 and 4, true lunar terrain is strewn with loose fragments of all sizes:

1. **Deterministic Scatter Distribution:**
   - Procedurally generates rock and pebble clusters seeded by `LunarWorldGenerator`:
     - **Pebbles ($5\,\text{cm} - 20\,\text{cm}$):** Dense clusters concentrated near crater rims and ejecta zones ($> 1200$ instances per active sector).
     - **Medium Rocks ($25\,\text{cm} - 80\,\text{cm}$):** Random field scatter across plains and slopes ($> 300$ instances).
     - **Boulder Clasts ($1.0\,\text{m} - 3.0\,\text{m}$):** Scattered fracture blocks near crater lips and rille walls.

2. **Babylon.js Thin Instance Architecture:**
   - All rocks and pebbles are rendered using **Thin Instances** on low-poly procedural rock geometries (`MeshBuilder.CreatePolyhedron` with random vertex displacement).
   - **Zero Draw-Call Overhead:** Over $2000$ rocks and pebbles batched into a single draw call per mesh archetype.
   - Transforms are computed once during terrain initialization based on ground height queries (`getGroundHeightAt(x, y)`), with random yaw and scale variations.
   - Rocks receive and cast shadows from the sun and vehicle headlights, creating the intricate shadow fields seen in Apollo 15 and 17 imagery.
   - Full headless compatibility: in `NullEngine`, thin instance matrices are stored in memory without invoking GPU buffer allocations, preserving existing CI test performance.

---

### 2.3 Pillar 3: "Visor Compensation" & Washed-Out Low-Light Optical Mode

The user identified a crucial experiential flaw: the "dark side" and shadowed crater interiors are too dark, obscuring terrain geometry and making traversal frustrating. Real astronaut visors and vehicle optical sensors actively adjust exposure:

1. **Helmet Visor Active Dynamic Range Compensation:**
   - Model the helmet visor as an active digital optics suite with automatic dynamic range compression and low-light gain.
   - When entering unlit terrain, deep crater basins, or during lunar night, the ambient illumination is actively lifted:
     - Minimum ambient shadow floor elevated from `(0.035, 0.035, 0.038)` to an intelligible, washed-out slate grey `(0.12, 0.12, 0.14)`.
     - Earthshine fill calibrated to `0.45` intensity with a diffuse ground bounce of `Color3(0.14, 0.14, 0.16)`.
     - The dark side is never pitch black; instead, it appears like an amplified high-gain camera image or low-light optical visor—slightly washed out, desaturated, but with completely clear elevation contours, crater lips, and boulder silhouettes.

2. **Visor Tone-Mapping & Exposure Adaptation:**
   - In browser environments, introduce a lightweight exposure adaptation pass via Babylon.js `DefaultRenderingPipeline`:
     - Tone mapping curve tuned to prevent sunlight blowouts while lifting deep shadows.
     - Visor HUD micro-grain: subtle low-light sensor grain overlay when in deep shadow, reinforcing the in-fiction explanation that the astronaut's visor is digitally amplifying the faint starlight and earthshine.

---

### 2.4 Pillar 4: Stadium-Grade Buggy Headlights & Projector Arrays

In low-light and shadowed terrain, the visual contrast should be driven by the buggy's lighting system. The existing headlights are underpowered; they must be upgraded to industrial, high-lumen mining projectors:

1. **Dual-Stage Stadium Projector Rig (`OpenBuggy.ts`):**
   - **Stage 1: Ultra-Wide Mega-Flood (Perimeter Work Flood):**
     - Cone angle: $110^\circ$ (increased from $85^\circ$).
     - Throw range: $85\,\text{m}$ (increased from $45\,\text{m}$).
     - Intensity: $8.5$ (increased from $2.8$).
     - Purpose: Washes the entire foreground and peripheral terrain with crisp, raking light, turning the washed-out shadow floor into punchy, high-contrast relief with long micro-shadows behind pebbles and tire ruts.
   - **Stage 2: Hyper-Piercing Long-Range Projector (High-Beam Spot):**
     - Cone angle: $30^\circ$ (tightened from $42^\circ$ for maximum throw concentration).
     - Throw range: $250\,\text{m}$ (increased from $120\,\text{m}$).
     - Intensity: $16.0$ (increased from $4.5$).
     - Color temperature: Crisp daylight-white `Color3(1.0, 0.98, 0.95)` with high color rendering.
     - Purpose: Pierces deep into distant crater bottoms, illuminating navigation targets, rail tracks, and scrap sites hundreds of meters ahead.

2. **Volumetric Beam Glow & Lens Flare Geometry:**
   - Procedural translucent light cones (`MeshBuilder.CreateCylinder` with additive blend material) extending from the lightbar fixtures.
   - Simulates forward scattering of light against microscopic levitating lunar dust particles (a well-documented phenomenon caused by solar UV photoelectric charging of regolith).
   - High-emissive LED lens caps that flare brightly when viewed from the front.

3. **EVA Suit Helmet Searchlight Upgrade (`AstronautSuit.ts`):**
   - Cone angle: $85^\circ$, throw range: $50\,\text{m}$, intensity: $6.0$.
   - Tracks the player's first-person or third-person gaze direction, allowing on-foot exploration of shadowed crater bottoms and caves with crisp local contrast.

---

## 3. Architecture Decision Records (ADRs)

### ADR-023-1: Multi-Frequency Procedural Terrain Textures
- **Context:** The single $128 \times 128$ normal map tiled $64\times$ leaves the ground looking flat and plastic-like at eye level. External image textures would increase bundle size and cause headless `NullEngine` failures in CI.
- **Decision:** Generate multi-frequency textures procedurally in memory via `RawTexture`:
  1. A $256 \times 256$ multi-octave normal map with micro-cratering and angular grit.
  2. A $256 \times 256$ meso-detail map for surface crumbly clasts and roughness variation.
  3. A $512 \times 512$ macro albedo texture representing mare basalt vs highland ejecta rays.
- **Consequences:** Near-zero bundle size increase; complete determinism across seeds; 100% headless `NullEngine` safety; drastic improvement in surface realism.

### ADR-023-2: Thin-Instance Pebble and Boulder Field Scatter
- **Context:** Apollo imagery features thousands of small rocks and clasts scattered across the regolith. Creating separate meshes would crush draw-call budgets and CPU transform overhead.
- **Decision:** Implement procedural rock and pebble fields using Babylon.js Thin Instances attached to a unified root polyhedron mesh.
- **Consequences:** Thousands of rocks rendered in 1–2 draw calls. Shadow casting on high-end hardware; seamless fallback in headless tests.

### ADR-023-3: Active Helmet Visor Exposure & Washed-Out Shadow Compensation
- **Context:** Complete physical darkness in craters and night zones creates frustrating gameplay where players drive blind.
- **Decision:** Establish an in-fiction "Active Optical Visor" mode. The unlit/shadow floor is boosted to a washed-out, high-gain tone (`emissiveColor = (0.12, 0.12, 0.14)` and earthshine fill `0.45`). Darkness becomes a distinct photographic aesthetic (washed-out, desaturated, high-gain grey) rather than an impenetrable black void.
- **Consequences:** Eliminates navigation frustration; terrain features remain readable everywhere; buggy headlights punch through with dramatic local contrast.

### ADR-023-4: Stadium-Grade High-Lumen Headlight Projectors
- **Context:** The existing $2.8 / 4.5$ intensity headlights feel like weak flashlights when traversing vast lunar plains.
- **Decision:** Supercharge headlights to industrial exploration grade: $8.5$ intensity wide flood + $16.0$ intensity long-throw spot, coupled with additive dust-scattering volumetric cones.
- **Consequences:** Buggy traversal at night becomes a showcase of raking light and high-contrast shadows.

---

## 4. Implementation Phases

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SPEC 23 IMPLEMENTATION PHASES                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Phase 1: Multi-Frequency Procedural Surface Shader & Texture Engine        │
│           (WorldScene.ts, procedural normal, detail, and albedo maps)       │
│                                                                             │
│  Phase 2: Hapke Retroreflective Opposition Surge & Visor Compensation Fill   │
│           (WorldScene.ts, shadow lift, washed-out low-light tone tuning)    │
│                                                                             │
│  Phase 3: Thin-Instance Pebble & Boulder Field Scatter System               │
│           (WorldScene.ts, LunarWorldGenerator.ts, rock geometry instancing) │
│                                                                             │
│  Phase 4: Stadium-Grade Buggy Headlights & Volumetric Beam Cones            │
│           (OpenBuggy.ts, AstronautSuit.ts, high-lumen dual projectors)      │
│                                                                             │
│  Phase 5: Traversal, Footstep & Rut Interaction Polish                      │
│           (CameraRig.ts, ClientApp.ts, raking light alignment, telemetry)   │
│                                                                             │
│  Phase 6: Automated Headless Verification & Production Build                │
│           (tests/verify-surface-rendering.ts, smoke test updates)           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 1: Multi-Frequency Procedural Surface Shader & Texture Engine
- **Files:** `games/lunar-frontier/src/engine/WorldScene.ts`.
- **Tasks:**
  - Build multi-octave normal map generator ($256 \times 256$, RGBA `RawTexture`) synthesizing fine grit, craterlet ridges, and sharp facet normals.
  - Implement macro albedo generator ($512 \times 512$, `RawTexture`) combining mare basalt lowlands (`#222326`) and highland ejecta rays (`#484542`).
  - Wire meso-detail map into `PBRMaterial.detailMap` with independent UV tiling ($16\times$ across patch).
  - Ensure all textures instantiate cleanly in `NullEngine` without WebGL DOM requirements.

### Phase 2: Hapke Opposition Surge & Visor Compensation Fill
- **Files:** `games/lunar-frontier/src/engine/WorldScene.ts`.
- **Tasks:**
  - Elevate regolith material minimum emissive floor to `Color3(0.12, 0.12, 0.14)` for the washed-out optical visor effect.
  - Tune earthshine `HemisphericLight` intensity to `0.45` with ground bounce `Color3(0.14, 0.14, 0.16)`.
  - Add opposition surge retroreflective brightening approximation (elevated direct intensity and specular curve when camera view aligns with sun vector).
  - Add optional visor post-processing tone mapping in browser environments.

### Phase 3: Thin-Instance Pebble & Boulder Field Scatter System
- **Files:** `games/lunar-frontier/src/world/LunarWorldGenerator.ts`, `games/lunar-frontier/src/engine/WorldScene.ts`.
- **Tasks:**
  - Generate rock distribution tables in `LunarWorldGenerator` (pebbles $0.1\,\text{m}$, rocks $0.4\,\text{m}$, boulders $1.5\,\text{m}$).
  - Construct low-poly base rock geometries with faceted normals.
  - Populate Babylon.js Thin Instances on the rock meshes positioned at terrain elevation.
  - Enable shadow casting for medium rocks and boulders under sunlight and buggy headlights.

### Phase 4: Stadium-Grade Buggy Headlights & Volumetric Beam Cones
- **Files:** `games/lunar-frontier/src/entities/OpenBuggy.ts`, `games/lunar-frontier/src/entities/AstronautSuit.ts`.
- **Tasks:**
  - Upgrade buggy floodlights: low-beam flood to $8.5$ intensity ($110^\circ$, $85\,\text{m}$), high-beam spot to $16.0$ intensity ($30^\circ$, $250\,\text{m}$).
  - Upgrade astronaut suit headlight to $6.0$ intensity ($85^\circ$, $50\,\text{m}$).
  - Add procedural forward volumetric light cones to buggy lightbars with additive alpha material.
  - Verify headlights track chassis pitch and roll dynamics accurately.

### Phase 5: Traversal, Footstep & Rut Interaction Polish
- **Files:** `games/lunar-frontier/src/client/ClientApp.ts`, `games/lunar-frontier/src/engine/CameraRig.ts`.
- **Tasks:**
  - Verify first-person and third-person camera modes correctly render near-field terrain textures without clipping or shimmering.
  - Ensure shadow map focus box dynamically follows camera rig across high-detail rock fields.
  - Validate gamepad toggle controls (`KeyF` / Gamepad `Y`) for headlights across suit and buggy modes.

### Phase 6: Automated Headless Verification & Production Build
- **Files:** `games/lunar-frontier/scripts/smoke-worldscene.ts`, `games/lunar-frontier/scripts/smoke-open-buggy.ts`, `tests/verify-surface-rendering.ts`.
- **Tasks:**
  - Update `smoke-worldscene.ts` to assert multi-frequency textures, raised visor emissive floor, and rock thin-instance counts.
  - Update `smoke-open-buggy.ts` to assert stadium-grade headlight intensity and throw ranges.
  - Create comprehensive integration test `tests/verify-surface-rendering.ts`.
  - Validate all smoke test suites pass (`npm run smoke:world`, `npm run smoke:client`).
  - Run full repository build (`npm run build`) ensuring zero TypeScript or bundler errors.

---

## 5. Acceptance Criteria & Quality Gates

| # | Subsystem | Acceptance Criteria |
|---|---|---|
| **1** | **Multi-Scale Regolith Texture** | Terrain uses multi-frequency textures: $\ge 256 \times 256$ micro-normal map tiled $\ge 32\times$, macro albedo map distinguishing mare vs highland, and meso detail map. No untextured plastic look at ground level. |
| **2** | **Visor Optical Compensation** | Shadowed crater walls and night faces retain visible geometric relief with minimum emissive floor $\ge 0.10$. No crushed pitch-black voids. Dark areas appear washed out and clear like amplified camera view. |
| **3** | **Stadium Buggy Headlights** | Low-beam flood intensity $\ge 8.0$ (throw $\ge 80\,\text{m}$, angle $\ge 100^\circ$); high-beam spot intensity $\ge 15.0$ (throw $\ge 200\,\text{m}$, angle $\le 35^\circ$). Headlights cast crisp raking light revealing ground texture. |
| **4** | **Suit Helmet Floodlight** | Suit headlight intensity $\ge 5.0$, throw $\ge 45\,\text{m}$, angle $\ge 80^\circ$, illuminating the foreground during EVA exploration. |
| **5** | **Rock & Pebble Scatter** | $\ge 1000$ thin-instanced rocks and pebbles spawned across the active terrain patch using $\le 3$ draw calls. Rocks correctly clamped to terrain surface elevation. |
| **6** | **Headless & CI Compatibility** | All new materials, textures, and thin instances instantiate cleanly under Babylon.js `NullEngine` without DOM/WebGL errors. |
| **7** | **Performance & Build** | Headless smoke tests pass 100%; production bundle builds (`npm run build`) with zero TypeScript diagnostics. |

---

## 6. Swarm Delegation Manifest (for `/pantheon-swarm`)

When executing this spec via `/pantheon-swarm` in a subsequent session, work will be partitioned into three concurrent agent streams:

1. **Subagent 1: Surface Shaders, Procedural Textures & Visor Compensation (`WorldScene.ts`)**
   - Implements multi-frequency procedural normal, albedo, and detail textures.
   - Tunes Hapke retroreflective opposition surge and visor dynamic range shadow lift.
2. **Subagent 2: Pebble & Rock Field Instancer (`LunarWorldGenerator.ts`, `WorldScene.ts`)**
   - Implements procedural rock generation, low-poly geometries, and Babylon.js Thin Instance scattering.
3. **Subagent 3: Stadium Headlights, Volumetric Cones & Verification (`OpenBuggy.ts`, `AstronautSuit.ts`, smoke tests)**
   - Implements high-lumen dual-stage buggy headlights, volumetric light cones, suit searchlight, and updates automated smoke tests.
