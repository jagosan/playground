# Architecture Blueprint 37: Buggy Workshop & Modular Upgrades — Cargo Beds, High-Torque Powertrain & Magnetic Catchers

## System Topology & Data Flow

```mermaid
flowchart TD
    subgraph UI [User Interface Layer]
        BAY[WorldScene Maintenance Bay (240, -160)]
        GUI[GarageTerminalUI.ts Modal]
        HUD[LunarHUD Telemetry & Stat Deltas]
    end

    subgraph Logic [Upgrade & Economy Engine]
        BUS[BuggyUpgradeSystem.ts]
        MKT[MarketEngine.ts Credit Balance]
        DB[(Persistent SQLite / localStorage)]
    end

    subgraph PhysicsAndMesh [Entities & Simulation]
        BUGGY[OpenBuggy.ts Mesh Hierarchy\n• Extended flatbed geometry\n• Nitrogen reservoirs\n• Cyan hub motors\n• Quad RCS nozzles]
        PHYS[TraversalPhysics.ts\n• Dynamic top speed 18 -> 35 m/s\n• Torque curves\n• Nitro boost & jump thrust]
    end

    BAY --> GUI
    GUI --> BUS
    BUS <--> MKT
    BUS <--> DB
    BUS --> BUGGY
    BUS --> PHYS
    PHYS --> HUD
```

## Modular Upgrade Matrix
- **Category 1 (Cargo Bed):** Stock (6 cans) $\to$ Extended Flatbed (12 cans) $\to$ Magnetic Net ($R = 3.5\,\text{m}$) $\to$ Tractor Beam ($R = 12\,\text{m}$).
- **Category 2 (Powertrain):** Stock ($18\,\text{m/s}$) $\to$ Brushless ($26\,\text{m/s}$) $\to$ Quad Hyper ($35\,\text{m/s}$) $\to$ Nitro Overdrive ($45\,\text{m/s}$).
- **Category 3 (Suspension):** Stock ($0.35\,\text{m}$) $\to$ Nitro Dampers ($0.55\,\text{m}$) $\to$ Active Ride-Height $\to$ Chassis RCS Jump Thrusters.
- **Category 4 (Mining):** Pulse Laser $\to$ Thermal Beam ($2.5\times$) $\to$ Wide Scoop ($4.5\,\text{m}$) $\to$ Deep Core Resonator.

## File Manifest & Responsibility Map
- `games/lunar-frontier/src/garage/BuggyUpgradeSystem.ts`: Data definitions, stat compound calculations, purchase verification, persistence.
- `games/lunar-frontier/src/ui/GarageTerminalUI.ts`: DOM rendering, category switching, live 3D preview updates, purchase actions.
- `games/lunar-frontier/src/entities/OpenBuggy.ts`: Mesh slot attachment, dynamic visual component toggling.
- `games/lunar-frontier/src/physics/TraversalPhysics.ts`: Dynamic parameter consumption in physics step.
- `games/lunar-frontier/scripts/smoke-spec37-buggy-upgrades.ts`: Headless NullEngine assertion test harness.
