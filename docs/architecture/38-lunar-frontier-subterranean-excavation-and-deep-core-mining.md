# Architecture Blueprint 38: Subterranean Base Excavation & Deep Core Shaft Mining

## System Topology & Spatial Hierarchy

```mermaid
flowchart TD
    subgraph Surface [Surface Base: Z = 0m]
        PAD[Surface Airlock & Buggy Garage Pad]
        MAST[Central Rotary Drill Mast & Umbilical]
    end

    subgraph Shaft [Vertical Transit & Lift]
        LIFT[CoreMiningRig.ts Central Lift\n• 6.0 m/s S-curve vertical travel\n• Supports player and buggy]
    end

    subgraph Tier1 [Tier 1 Habitation: Z = -15m]
        HAB[Crew Habitat Pod\n• 0.0 mSv/h Radiation Shield\n• -20°C Thermal Stability]
    end

    subgraph Tier2 [Tier 2 Heavy Industry: Z = -45m]
        SMELT[Basalt Slag Autoclave\n100kg Rubble -> 1 Slag Brick]
        BATT[Molten-Salt Thermal Battery Banks]
    end

    subgraph Tier3 [Tier 3 Deep Core: Z = -95m]
        LAVA[Volcanic Lava Tube Cavern]
        SEAMS[Deep Fissure Mineral Seams\n• Primordial He-3\n• Platinum Nuggets\n• Deep Volcanic Ice]
    end

    Surface --> LIFT
    LIFT --> Tier1
    LIFT --> Tier2
    LIFT --> Tier3
    SMELT --> SubterraneanExcavator[SubterraneanExcavator.ts Engine]
    SubterraneanExcavator --> TunnelNetwork[TunnelNetwork.ts Procedural Mesh]
```

## Depth & Environmental Attributes
- **Tier 0 ($Z = 0\,\text{m}$):** Vacuum $0.0\,\text{kPa}$, solar radiation $1.2\,\text{mSv/h}$, temp range $-130^\circ\text{C} \dots +120^\circ\text{C}$.
- **Tier 1 ($Z = -15\,\text{m}$):** Pressurized $101.3\,\text{kPa}$ in habitat, radiation $0.0\,\text{mSv/h}$, temp $-20^\circ\text{C}$.
- **Tier 2 ($Z = -45\,\text{m}$):** Industrial volume $36\,\text{m} \times 36\,\text{m} \times 9\,\text{m}$, slag production and energy routing.
- **Tier 3 ($Z = -95\,\text{m}$):** Massive arched cavern $60\,\text{m} \times 80\,\text{m} \times 14\,\text{m}$, geothermal core tap and rare mineral nodes.

## File Manifest & Responsibility Map
- `games/lunar-frontier/src/base/SubterraneanExcavator.ts`: Tier unlocking rules, rubble accumulation, slag sintering formulas, state serialization.
- `games/lunar-frontier/src/base/CoreMiningRig.ts`: Rotary drill asset rig, particle emitters, elevator platform kinematics.
- `games/lunar-frontier/src/infrastructure/TunnelNetwork.ts`: Procedural 3D mesh generation for shafts, rings, and cavern walls.
- `games/lunar-frontier/scripts/smoke-spec38-core-excavation.ts`: Headless NullEngine assertion test harness.
