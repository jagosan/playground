# Spec 39: Lunar Frontier — Colony Life-Support Infrastructure: Tracking Solar Arrays, Closed-Loop Hydroponics & Water Refining

> **Target Systems:** `games/lunar-frontier/src/base/BasePowerGrid.ts` (new), `games/lunar-frontier/src/base/WaterPurifier.ts` (new), `games/lunar-frontier/src/base/LifeSupportHydroponics.ts` (new), `games/lunar-frontier/src/entities/OpenBuggy.ts`, `games/lunar-frontier/src/economy/MarketEngine.ts`, `games/lunar-frontier/src/engine/WorldScene.ts`, `games/lunar-frontier/src/client/ClientApp.ts`, `games/lunar-frontier/src/ui/LunarHUD.ts`, `games/lunar-frontier/src/audio/LunarAudioSystem.ts`.  
> **Platforms:** WebGL2/WebGPU Desktop (Chrome/Firefox/Brave), Mobile Touch (PWA landscape), Gamepad (Linux XInput/Steam Deck).  
> **Preceding Specs:** Spec 12 (Economy Baseline), Spec 36 (Train Heist Cargo), Spec 37 (Buggy Workshop), Spec 38 (Subterranean Excavation).  
> **Verification Suite:** `games/lunar-frontier/scripts/smoke-spec39-base-infrastructure.ts` (100% headless under `NullEngine`).

---

## 1. Executive Summary & Narrative Context

With subterranean core chambers excavated down to $Z = -95\,\text{m}$ (Spec 38) and heavy freight buggies outfitted with expanded flatbeds (Spec 37), the home base is primed to transform from a barren bunker into a thriving, self-sustaining industrial colony.

### The Colony Production Engine
Spec 39 implements the fundamental colony life-support, power, and farming loops inspired by established industrial colony mechanics (*Satisfactory*, *Subnautica*, *Surviving Mars*):
1. **Dual-Axis Sun-Tracking Solar Arrays:** Motorized photovoltaic gantries on the surface that dynamically swivel to track the lunar sun vector, maximizing peak kilowatt harvest.
2. **Subterranean Molten-Salt Energy Storage:** High-capacity thermal and electrochemical battery banks placed in Tier 2 vaults, storing hundreds of megawatt-hours to power base life support through the 354-hour lunar night.
3. **Closed-Loop Water Purification & Electrolysis:** Sintering units and ice melters that refine mined permafrost chunks and stolen train canisters into high-purity potable $\text{H}_2\text{O}$ and pressurized $\text{O}_2$ suit cylinders.
4. **Subterranean Hydroponic Algae Bioreactors:** Glowing magenta/cyan cultivation columns in Tier 1 producing synthetic nutrient rations, scrubbing carbon dioxide, and generating renewable bio-resins.
5. **Colony Export Hauling & Grand Loop Closure:** The player packs surplus water, oxygen, and food rations onto their buggy flatbed, drives to the Frontier Trading Post or the Mare Mass Accelerator, and sells them for lucrative profits, fueling further expansion!

---

## 2. System Architecture & Resource Flows

```
  ┌──────────────────────────────────────────────────────────────┐
  │                    COLONY RESOURCE CONDUIT                   │
  │                                                              │
  │   [ Tracking Solar Arrays ] ──► [ Power Bus (kW) ]           │
  │                                        │                     │
  │   [ Ice / Stolen Train Water ] ──► [ Water Purifier (L) ]    │
  │                                        │                     │
  │   [ Power + Pure Water ] ─────────► [ Hydroponic Vats ]      │
  │                                        │                     │
  │                                        ▼                     │
  │                     [ Food Rations & O2 Canisters ]          │
  │                                        │                     │
  │                                        ▼                     │
  │                       [ Buggy Flatbed Hauler ]               │
  │                                        │                     │
  │                                        ▼                     │
  │                       [ Trading Post / Credits ]             │
  └──────────────────────────────────────────────────────────────┘
```

### 2.1 Power Grid Mechanics (`BasePowerGrid.ts`)
- **Sun-Tracking Solar Arrays:**
  - Base array geometry: $12\,\text{m} \times 6\,\text{m}$ dual-axis motorized truss.
  - Tracking math: On every game tick, the array normal vector $\vec{n}$ aligns with the live scene directional sun vector $\vec{L}$:
    $$\vec{n}(t) = \text{slerp}(\vec{n}(t-1), \vec{L}_\text{sun}, \omega_\text{track} \cdot \Delta t)$$
  - Electrical generation:
    $$P_\text{gen} = P_\text{peak} \cdot \max(0, \vec{n} \cdot \vec{L}_\text{sun}) \cdot \eta_\text{array}$$
    where $P_\text{peak} = 45.0\,\text{kW}$, $\eta_\text{array} = 0.94$ (gallium-arsenide cells).
- **Subterranean Battery Storage Vault:**
  - Installed in Tier 2 mezzanine ($Z = -45\,\text{m}$).
  - Battery capacity scales with modular cells: $E_\text{cap} = N_\text{cells} \times 250\,\text{kW}\cdot\text{h}$.
  - State of Charge integration:
    $$\frac{dE}{dt} = P_\text{gen}(t) - P_\text{load}(t)$$
  - When $P_\text{load} > P_\text{gen}$ (lunar sunset / shadows), the battery discharges smoothly. If $E(t) = 0$, base enters emergency blackout mode (lights dim, non-essential systems halt).

### 2.2 Water Refining & Closed-Loop Electrolysis (`WaterPurifier.ts`)
- **Raw Inputs:** Accepts raw permafrost ice chunks ($1.0\,\text{kg} \to 0.75\,\text{L}$ water) or stolen X-Corp Cryo-Water Cells ($10.0\,\text{kg} \to 9.8\,\text{L}$ water).
- **Thermal Sublimation Unit:** Melts ice under vacuum, passes vapor through multi-stage catalytic micro-filters to produce `PURIFIED_WATER`.
- **Electrolysis Splitter:** Splits $1.0\,\text{L}$ water into $0.88\,\text{kg}$ Liquid Oxygen (`LOX_CYLINDER`) + $0.12\,\text{kg}$ Hydrogen fuel, providing endless suit oxygen refills.

### 2.3 Hydroponic Algae Bioreactors (`LifeSupportHydroponics.ts`)
- Mounted in Tier 1 subterranean chamber ($Z = -15\,\text{m}$).
- Procedural asset: 4 illuminated cylindrical glass columns filled with swirling emerald-green *Spirulina* algae cultures.
- Consumption: Draws $2.5\,\text{kW}$ electrical load and $0.5\,\text{L/h}$ purified water per column.
- Production: Automatically yields $1\times$ `SYNTHETIC_FOOD_PACK` every $180.0\,\text{s}$ of real-time operation.
- Bioreactors serve as biological carbon scrubbers, maintaining habitat air freshness.

---

## 3. Subsystem Specifications & Phased Implementation

### Phase 1: Base Power Bus & Tracking Solar Array Mechanics (`BasePowerGrid.ts`)
- Implement `BasePowerGrid` managing generators, loads, and battery storage.
- Create procedural 3D Tracking Solar Array with rotating pitch/yaw gimbal nodes in `WorldScene.ts`.
- Calculate live solar incidence angle $\theta = \arccos(\vec{n} \cdot \vec{L})$ and power yield.
- Provide persistence: Store energy level, installed arrays, and battery cells in database.

### Phase 2: Water Refining & Electrolysis Engine (`WaterPurifier.ts`)
- Implement `WaterPurifier` managing raw ice hopper, distillation coils, and output water reservoir ($0\dots 1,000\,\text{L}$).
- Add suit PLSS refill interaction trigger: standing near the water/oxygen gantry refills suit oxygen reserves instantly.
- Unload stolen water canisters from the train heist directly into the water purification hopper.

### Phase 3: Subterranean Hydroponic Vats & Growth Cycling (`LifeSupportHydroponics.ts`)
- Construct 3D procedural bioreactor columns in Tier 1 habitat:
  - Transparent glass shaders with internal swirling bubble particles.
  - Magenta/cyan illumination casting soft ambient bounce on basalt chamber walls.
- Growth cycle state machine: handles water consumption, growth accumulation, and automated item spawning into the colony pantry crate.

### Phase 4: Buggy Freight Integration & Commodity Trading (`OpenBuggy.ts`, `MarketEngine.ts`)
- Connect base storage silos to the Buggy flatbed loading dock:
  - Interaction prompt: `[F] Transfer Surplus Commodities to Buggy Bed`.
  - Buggy flatbed automatically packs crates of Food Rations, Water Flasks, and Oxygen Cylinders.
- Haul cargo to Frontier Trading Post or Mare Mass Accelerator:
  - Market prices reflect local supply/demand (e.g. water sells for $450$ credits/canister; food sells for $350$ credits/pack).
  - Completes the macro loop: revenue funds more solar arrays, deeper core mining, and apex buggy gear!

### Phase 5: Base Overview HUD Panel & Audio Ambience (`LunarHUD.ts`, `LunarAudioSystem.ts`)
- HUD Base Management Card (toggle via `[B]` or base terminal):
  - Displays Power Grid status ($P_\text{gen}$, $P_\text{load}$, Battery $\%$ with time-to-empty estimation).
  - Water buffer levels and daily consumption rates.
  - Hydroponic growth progress bars.
- Procedural Web Audio:
  - Gentle hydro-pump hum and bubbling water filtration in Tier 1.
  - High-voltage inverter whine ($60\,\text{Hz} / 120\,\text{Hz}$) near battery vaults.
  - Solar servo motor rotation clicks when arrays adjust alignment.

### Phase 6: Headless Smoke Verification Suite (`smoke-spec39-base-infrastructure.ts`)
- Author comprehensive headless test script covering:
  1. Sun tracking vector alignment and cosine solar power generation.
  2. Battery charge/discharge dynamics and blackout transition.
  3. Ice melting conversion ratios and water reservoir accumulation.
  4. Hydroponic growth ticking and synthetic food pack production.
  5. Freight loading onto buggy and credit sale at trading post.
  6. 100% pass under Babylon.js `NullEngine`.

---

## 4. Acceptance Criteria & Quality Gates

1. **Sun-Tracking Alignment Gate:** As sun direction rotates, solar array normal aligns within $\le 2^\circ$ of the sun vector, yielding $\ge 98\%$ of theoretical peak power ($P_\text{gen} \ge 44.0\,\text{kW}$ per array at normal incidence).
2. **Day/Night Battery Gate:** Disconnecting solar generation drains battery storage at $P_\text{load}$; state of charge tracks continuous integration without mathematical overflow or negative energy.
3. **Food Production Gate:** Running hydroponics for 1 full growth cycle ($180\,\text{s}$) consumes specified water and increments `foodPackCount` by 1.
4. **Smoke Suite Gate:** `npx tsx scripts/smoke-spec39-base-infrastructure.ts` passes all $\ge 60$ assertions cleanly.
5. **Production Build Gate:** `npm run build` succeeds with zero TypeScript errors.
