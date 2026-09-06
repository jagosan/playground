# Architecture Blueprint: Artemis Lunar Terrain Vehicle (LTV) & Dynamic Robotic Arm Rig

**Document ID:** `docs/architecture/08-artemis-ltv-and-robotic-arm.md`  
**Status:** Approved  
**Author:** 🦉 Owl (System Architect & Outer Loop Orchestrator)  
**Date:** 2026-09-06  

---

## 1. Executive Summary & Design Vision

This architecture defines the transformation of the Moonbuggy 2 vehicle from the rudimentary 720-vertex primitive Apollo LRV into a photorealistic, next-generation **Artemis Lunar Terrain Vehicle (LTV)** inspired by NASA Artemis LTV reference designs (Lunar Outpost *Lunar Dawn*, Intuitive Machines *Moon RACER*, and Venturi Astrolab *FLEX*). 

In addition to exterior aesthetics, this blueprint specifies an end-to-end visual overhaul of the **geological sample retrieval sequence**:
1. Directed robotic arm kinematics targeting the actual ground rock position.
2. Animated 3-finger mechanical claw clamp with laser targeting emitter.
3. Regolith surface dust puff on sample extraction.
4. Physical rock specimen carried by the claw and deposited into visible rear cargo deck slots.

---

## 2. Artemis LTV Model Hierarchy & PBR Materials

### 2.1 Blender 4.2 Asset Hierarchy (`public/models/apollo_lrv.glb`)
```
LRV_Root [Empty]
├── Chassis [Mesh: Aerospace composite hull, front fascia, skid plate]
│   ├── BodyPanels_White [Mesh: Artemis white thermal composite]
│   ├── BodyPanels_Carbon [Mesh: Matte carbon fiber aero cowlings]
│   ├── Avionics_KaptonBay [Mesh: Multi-layer gold/copper insulation]
│   ├── Bullbar_Bumper [Mesh: Titanium tubular front recovery cage]
│   ├── LED_Lightbar [Mesh + Emissive: High-intensity lunar headlights]
│   ├── SensorMast [Mesh: LiDAR scanner turret + stereo navigation optics]
│   ├── HighGain_Dish [Mesh: Parabolic carbon-mesh telemetry dish]
│   ├── Cockpit_Console [Mesh: Center joystick, digital telemetry screens]
│   ├── Seat_Left / Seat_Right [Mesh: Ergonomic flight seats w/ harness detail]
│   ├── CargoBed [Mesh: Rear scientific payload rack with 8 sample canisters]
│   ├── Suspension_FL / FR / RL / RR [Mesh: Double-wishbone A-arms & coilovers]
│   │   └── SteeringKnuckle_* [Empty]
│   │       └── Wheel_* [Mesh: Compliant airless lattice tweels w/ chevron treads]
│   └── RoboticArm_Base [Mesh: Azimuth turret with optical encoder ring]
│       └── RoboticArm_Boom [Mesh: Telescoping shoulder & bicep boom]
│           └── RoboticArm_Forearm [Mesh: Elbow actuator & forearm spar]
│               └── RoboticArm_Claw [Mesh: 3-finger motorized grabber & laser guide]
└── LRV_Collision_Box [Wireframe bounding proxy]
```

### 2.2 PBR Materials Table
| Material Name | Base Color | Roughness | Metallic | Emissive | Target Feature |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `ArtemisWhiteComposite` | `(0.92, 0.93, 0.94)` | 0.28 | 0.05 | None | Outer aerodynamic panels & cowlings |
| `MatteCarbonFiber` | `(0.12, 0.12, 0.14)` | 0.45 | 0.20 | None | Cockpit tub, chassis structural beams |
| `KaptonGoldThermal` | `(0.96, 0.68, 0.12)` | 0.22 | 0.92 | None | Avionics insulation, sensor shrouds |
| `TitaniumAlloy` | `(0.45, 0.46, 0.48)` | 0.35 | 0.85 | None | Suspension wishbones, robotic arm spars |
| `LatticeAirlessTire` | `(0.18, 0.19, 0.20)` | 0.60 | 0.70 | None | Compliant titanium-mesh open lattice wheels |
| `HeadlightEmissive` | `(0.95, 0.98, 1.00)` | 0.10 | 0.00 | `(1.0, 1.0, 1.0)` x 5.0 | Front LED lightbars & navigation LiDAR |
| `LaserTargetingBeam` | `(0.10, 0.95, 0.30)` | 0.10 | 0.00 | `(0.2, 1.0, 0.3)` x 8.0 | End-effector green alignment laser |

---

## 3. Dynamic Robotic Arm Retrieval Visuals

### 3.1 Kinematic Sequence
When rock retrieval is triggered within 3.8m range at $< 10\,\text{km/h}$:
1. **Targeting Phase ($0.0 \to 0.35\,\text{s}$):**
   - Laser targeting guide illuminates the ground specimen.
   - Base turret rotates toward the relative rock azimuth angle $\theta_{\text{rock}}$.
   - Bicep and forearm extend downward toward the rock surface.
2. **Capture & Particle Phase ($0.35 \to 0.55\,\text{s}$):**
   - 3-finger claw closes around the rock geometry.
   - Regolith particle disturbance system emits a localized micro-gravity dust burst ($g=1.62\,\text{m/s}^2$).
   - The world rock is hidden from the terrain, and an active specimen mesh is dynamically attached to `RoboticArm_Claw`.
3. **Stow Phase ($0.55 \to 1.10\,\text{s}$):**
   - Arm curls upward and swings backward toward the rover rear cargo deck.
   - Claw opens over the next open sample slot ($1 \dots 8$).
   - Physical rock canister / boulder appears firmly seated in the cargo bay bed.
4. **Return Phase ($1.10 \to 1.30\,\text{s}$):**
   - Arm smoothly returns to aerodynamic stow position along the chassis starboard rail.

---

## 4. ADR: Procedural High-Detail Mesh Generation vs External Assets

### Status
Accepted

### Context
Moonbuggy 2 runs in a self-contained web environment and headless CI pipeline. Models must be generated deterministically via Blender 4.2 (`bpy`) without depending on external proprietary model downloads.

### Decision
Generate multi-part geometry using Blender's procedural modeling operators:
- Airless lattice tires: Cylindrical wheel hub + radial arrayed curved spring blades + cleated rim.
- Chassis: Beveled composite panels, tubular rollcage with corner fillets, recessed cockpit, and faceted aerospace nose.
- Robotic arm: Articulated hierarchical parent-child nodes with local rotation pivot anchors for seamless real-time Three.js rotation control.

---

## 5. 💡 Note to Future Self: Hosting Portability
The generated glTF 2.0 binary (`apollo_lrv.glb`) adheres strictly to the Khronos glTF 2.0 specification with embedded PBR materials and standard node transforms. No custom Blender-specific shader graphs or non-standard extensions are used. The asset loads identically in Three.js, BabylonJS, PlayCanvas, or Unreal Engine/Godot WebGL exports without translation.
