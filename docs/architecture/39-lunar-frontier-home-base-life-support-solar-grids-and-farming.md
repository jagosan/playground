# Architecture Blueprint 39: Colony Life-Support Infrastructure — Tracking Solar Arrays, Closed-Loop Hydroponics & Water Refining

## System Topology & Grid Mechanics

```mermaid
flowchart TD
    subgraph PowerSystem [BasePowerGrid.ts]
        SUN[Scene Sun Vector L_sun]
        SOLAR[Deployable Tracking Solar Array\nDual-Axis Gimbal: n · L_sun]
        BUS[Power Bus: P_gen - P_load]
        BATT[Molten-Salt Thermal Battery Banks\nTier 2 Vault: E_cap = N * 250 kWh]
    end

    subgraph LifeSupport [WaterPurifier.ts & Hydroponics]
        ICE[Ice Hopper / Stolen Train Water]
        PUR[Water Purifier & Condenser\n1000L Reservoir Buffer]
        OXY[Electrolysis Oxygen Splitter\nPLSS Suit Refill Gantry]
        HYD[LifeSupportHydroponics.ts\nTier 1 Spirulina Algae Columns\nYield: Synthetic Food Packs]
    end

    subgraph EconomyExport [Freight & Trading]
        BUGGY[OpenBuggy Flatbed Cargo Dock]
        MKT[MarketEngine.ts / Trading Post\nPurified Water + Food + Oxygen Sales]
    end

    SUN --> SOLAR
    SOLAR --> BUS
    BUS <--> BATT
    BUS --> PUR
    BUS --> HYD
    ICE --> PUR
    PUR --> OXY
    PUR --> HYD
    HYD --> BUGGY
    PUR --> BUGGY
    BUGGY --> MKT
```

## Physical Energy & Material Equations
- **Solar Power Generation:** $P_\text{gen} = P_\text{peak} \cdot \max(0, \vec{n} \cdot \vec{L}_\text{sun}) \cdot \eta$ with $P_\text{peak} = 45\,\text{kW}$.
- **Closed-Loop Water Balance:** $\Delta V_\text{water} = \dot{V}_\text{melt} - \dot{V}_\text{hydro} - \dot{V}_\text{electrolysis}$.
- **Algae Food Cultivation Cycle:** 1 food pack per $180.0\,\text{s}$ at nominal power ($2.5\,\text{kW}$) and water ($0.5\,\text{L/h}$).

## File Manifest & Responsibility Map
- `games/lunar-frontier/src/base/BasePowerGrid.ts`: Solar tracking math, battery charge/discharge differential solver, blackout triggers.
- `games/lunar-frontier/src/base/WaterPurifier.ts`: Ice sublimation, condenser tank buffers, suit oxygen dispenser.
- `games/lunar-frontier/src/base/LifeSupportHydroponics.ts`: Algae growth timing, ration packaging, ambient chamber lighting.
- `games/lunar-frontier/scripts/smoke-spec39-base-infrastructure.ts`: Headless NullEngine assertion test harness.
