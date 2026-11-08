# Spec 37: Lunar Frontier — Buggy Workshop & Modular Upgrades: Cargo Beds, High-Torque Powertrain & Magnetic Catchers

> **Target Systems:** `games/lunar-frontier/src/entities/OpenBuggy.ts`, `games/lunar-frontier/src/garage/BuggyUpgradeSystem.ts` (new), `games/lunar-frontier/src/ui/GarageTerminalUI.ts` (new), `games/lunar-frontier/src/economy/MarketEngine.ts`, `games/lunar-frontier/src/physics/TraversalPhysics.ts`, `games/lunar-frontier/src/client/ClientApp.ts`, `games/lunar-frontier/src/ui/LunarHUD.ts`, `games/lunar-frontier/src/audio/LunarAudioSystem.ts`.  
> **Platforms:** WebGL2/WebGPU Desktop (Chrome/Firefox/Brave), Mobile Touch (PWA landscape), Gamepad (Linux XInput/Steam Deck).  
> **Preceding Specs:** Spec 15/17 (Buggy Baseline & Handling), Spec 20/25 (Hill-Hold & Traversal Physics), Spec 32 (3D Crater Ballistics), Spec 36 (Train Heist Cargo Toss).  
> **Verification Suite:** `games/lunar-frontier/scripts/smoke-spec37-buggy-upgrades.ts` (100% headless under `NullEngine`).

---

## 1. Executive Summary & Narrative Context

A central pillar of the **Grand Frontier Loop** is turning raw profit into exponential capability:
$$\text{Mine / Farm / Steal} \longrightarrow \text{Trade for Credits} \longrightarrow \text{Upgrade Vehicle} \longrightarrow \text{Higher-Value Targets}$$

Before Spec 37, the rover was a static, monolithic vehicle: every player drove the identical open-frame buggy with fixed top speed ($18\,\text{m/s}$), baseline cargo capacity ($200\,\text{kg}$), and standard suspension.

### The Outpost Garage Experience
Spec 37 introduces the **Frontier Outpost Garage & Customization Bay**:
- Located at $(X = 240\,\text{m}, Y = -160\,\text{m})$ adjacent to the Frontier Trading Post.
- Features a hydraulic drive-on vehicle lift pad with dynamic lighting and an interactive holographic terminal.
- Players pull their buggy into the bay to inspect technical telemetry, review upgrade branches, purchase modular attachments with earned credits, and immediately see new components physically mounted to their 3D buggy chassis.
- Upgrades transform the buggy from a fragile scout into a high-capacity freight hauler, an apex train-heist pursuit interceptor, or an agile crater-jumping exploration rig!

---

## 2. Upgrade Trees & Modular Component Topology

```
                       [ Buggy Upgrade Architecture ]
                                      │
     ┌─────────────────┬──────────────┴───┬─────────────────┐
     ▼                 ▼                  ▼                 ▼
[ Flatbed & Cargo ] [ Powertrain ]   [ Suspension ]    [ Mining & Salvage ]
• Extended Bed      • High-Torque    • Heavy Nitro     • Thermal Beam
• Mag Cargo Net     • Quad Hyper     • Variable Stance • Auto-Scraper
• Tractor Winch     • Nitro Boost    • RCS Jump Jets   • Deep Core Drill
```

### 2.1 Tree 1: Flatbed & Cargo Systems (`cargo_bed`)
1. **Tier 1 (Stock Hopper):** 6 canister capacity ($200\,\text{kg}$ max payload, capture radius $1.8\,\text{m}$). Cost: $0$ credits.
2. **Tier 2 (Extended Freight Flatbed):** 12 canister capacity ($500\,\text{kg}$ max payload, extended rear subframe $+0.6\,\text{m}$, double-tiered side rails). Cost: $3,500$ credits.
3. **Tier 3 (Electromagnetic Cargo Net):** Adds pulsing blue energy webbing over the bed; expands dynamic throw capture radius from $1.8\,\text{m} \to 3.5\,\text{m}$, capturing errant tosses during high-speed train heists. Cost: $8,500$ credits.
4. **Tier 4 (Tractor Beam Harpoon):** Integrated rear gantry projector that automatically reels in free-floating canisters and mined ore chunks within $12\,\text{m}$ at $8.0\,\text{m/s}$. Cost: $22,000$ credits.

### 2.2 Tree 2: Powertrain & Motors (`powertrain`)
1. **Tier 1 (Stock Dual Motors):** Top speed $18.0\,\text{m/s}$ ($65\,\text{km/h}$), max wheel torque $1,400\,\text{N}\cdot\text{m}$.
2. **Tier 2 (High-Torque Brushless Motors):** Top speed $26.0\,\text{m/s}$ ($94\,\text{km/h}$), wheel torque $2,400\,\text{N}\cdot\text{m}$ ($+71\%$ hill climb authority up $35^\circ$ crater walls). Cost: $4,500$ credits.
3. **Tier 3 (Quad Hyper-Induction Motors):** All-wheel independent drive, top speed $35.0\,\text{m/s}$ ($126\,\text{km/h}$), wheel torque $3,800\,\text{N}\cdot\text{m}$, capable of cleanly overtaking the $25\,\text{m/s}$ Apex Express. Cost: $14,000$ credits.
4. **Tier 4 (Superconducting Overdrive Capacitor):** Adds emergency nitro sprint button (`[Left Shift]` / Gamepad `(A)`). Discharges stored capacitor to deliver $45.0\,\text{m/s}$ ($162\,\text{km/h}$) sprint velocity for $4.0\,\text{s}$ ($15.0\,\text{s}$ recharge). Cost: $32,000$ credits.

### 2.3 Tree 3: Suspension & Crater Ballistics (`suspension`)
1. **Tier 1 (Stock Leaf & Coils):** Travel $0.35\,\text{m}$, baseline damping, bottom-out shock on leaps $>6\,\text{m}$.
2. **Tier 2 (Heavy-Duty Nitrogen Reservoir Dampers):** Travel $0.55\,\text{m}$, progressive secondary bump-stops; absorbs $15\,\text{m}$ crater lip ballistic landings with zero chassis bottoming. Cost: $5,000$ credits.
3. **Tier 3 (Hydraulic Active Ride-Height):** Dynamic clearance selector (Slammed mode for $35\,\text{m/s}$ track stability; High-Clearance mode $+0.25\,\text{m}$ for jagged boulder fields). Cost: $11,000$ credits.
4. **Tier 4 (PLSS Chassis RCS Jump Thrusters):** 4 downward cold-gas thruster pods mounted to chassis outriggers. Pressing Jump while driving fires a vertical reactive impulse ($v_z \to +8.0\,\text{m/s}$), allowing the buggy to leap over rail tracks and yawning ravines. Cost: $28,000$ credits.

### 2.4 Tree 4: Mining & Extraction Suite (`mining_suite`)
1. **Tier 1 (Survey Pulse Laser):** $1.0\times$ extraction rate, single-target lock.
2. **Tier 2 (Thermal Resonance Drill):** $2.5\times$ extraction speed, fractures basalt veins in $<2.5\,\text{s}$. Cost: $4,000$ credits.
3. **Tier 3 (Wide-Angle Regolith Collector):** Front-mounted scoop array that automatically harvests all surface minerals within $4.5\,\text{m}$ frontal swath as the rover drives over deposits. Cost: $12,500$ credits.
4. **Tier 4 (Deep Core Resonator):** Seismic emitter unlocking deep subsurface bedrock seams for rare isotopes and titanium. Cost: $25,000$ credits.

---

## 3. Subsystem Specifications & Phased Implementation

### Phase 1: Buggy Upgrade Data Model & Persistence (`BuggyUpgradeSystem.ts`)
- Define typed interfaces for `BuggyUpgradeTier`, `BuggyStats`, and `InstalledUpgrades`.
- Save/load installed upgrades to persistent `localStorage` and authoritative SQLite database (`buggy_upgrades` table).
- Provide deterministic getter `calculateBuggyStats(installed)` evaluating compound physical attributes.

### Phase 2: Dynamic 3D Mesh Attachments & Visual Upgrades (`OpenBuggy.ts`)
- Implement procedural component mounting on the `OpenBuggy` Babylon mesh hierarchy:
  - Extended flatbed geometry and secondary roll-cage bars.
  - Anodized gold nitrogen damper reservoirs on suspension wishbones.
  - Cyan emissive hub motor caps on wheel assemblies.
  - Quad RCS thruster nozzles with particle plume emitters on chassis corners.
- When upgrades change, update active mesh visibilities without recreating the entire vehicle root.

### Phase 3: Traversal Physics Integration (`TraversalPhysics.ts`)
- Bind dynamic powertrain parameters into `LunarBuggy.step()`:
  - Top speed ceiling $v_\text{max}$, drive torque $T_\text{drive}$, and brake regen $T_\text{regen}$.
  - Suspension travel bounds and bottom-out velocity dissipation.
  - Nitro overdrive velocity multiplier and countdown drain.
  - Chassis RCS jump thrust impulse $\vec{J}_\text{jump}$.

### Phase 4: Holographic Garage Terminal UI (`GarageTerminalUI.ts`, `hud.css`)
- Interactive modal UI displaying:
  - 4 upgrade category tabs with icons and visual tier pips.
  - Technical telemetry delta meters (Green positive deltas, e.g. `Top Speed: 18 m/s -> 26 m/s (+44%)`).
  - Credit cost, current player balance, and purchase/equip action buttons.
  - Sound effects for transaction completion, installation welding sparks, and hydraulic lift cycling.

### Phase 5: Outpost Maintenance Bay Environment (`WorldScene.ts`)
- Construct the 3D garage bay at $(240, -160)$:
  - Steel diamond-plate lift platform with yellow caution stripes.
  - 4 overhead halogen floodlights casting crisp local shadows.
  - Proximity interaction trigger: parking inside bay displays `[G] OPEN GARAGE TERMINAL`.

### Phase 6: Headless Smoke Verification Suite (`smoke-spec37-buggy-upgrades.ts`)
- Author comprehensive headless test script covering:
  1. Default baseline stats evaluation.
  2. Sequential upgrade purchasing, credit balance debiting, and insufficient-funds rejection.
  3. Physical parameter scaling: Quad Motors top speed reaches $35\,\text{m/s}$; Extended Bed holds 12 canisters.
  4. Dynamic mesh attachment instantiation and visibility toggling.
  5. Persistence round-trip serialization (JSON export/import).
  6. 100% pass under Babylon.js `NullEngine`.

---

## 4. Acceptance Criteria & Quality Gates

1. **Stat Scaling Gate:** Installing Tier 3 Quad Motors increases buggy top speed from $18.0\,\text{m/s}$ to exactly $35.0\,\text{m/s}$ in `calculateBuggyStats()`.
2. **Economic Debit Gate:** Purchasing an upgrade debits the player's credit balance by the exact catalog cost; attempts with insufficient funds fail cleanly without mutating state.
3. **Chassis RCS Jump Gate:** Engaging the Tier 4 jump jet while driving on ground delivers $\ge 7.5\,\text{m/s}$ upward vertical velocity and triggers cold-gas nozzle plumes.
4. **Smoke Suite Gate:** `npx tsx scripts/smoke-spec37-buggy-upgrades.ts` passes all $\ge 65$ assertions cleanly.
5. **Production Build Gate:** `npm run build` succeeds with zero TypeScript errors.
