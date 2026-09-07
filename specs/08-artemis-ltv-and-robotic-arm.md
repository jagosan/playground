# Spec 08: Artemis Lunar Terrain Vehicle (LTV) & Dynamic Robotic Arm Retrieval Rig

> Target Hardware: GPD Win Max 2 (`chubbs` — AMD Ryzen 7 7840U/8840U, Radeon 780M, Bazzite Linux)
> Complementary Profile: WebGL2/WebGPU via Three.js over Tailscale (`http://100.99.188.15:8088/`)
> Prerequisite: Spec 05 (`scripts/lunar_assets/rover_builder.py`), Spec 06 (`GLTFAssetLoader.ts`)
> Architectural Blueprint: `docs/architecture/08-artemis-ltv-and-robotic-arm.md`

---

## 1. Executive Summary & Objectives
Spec 08 transforms the Moonbuggy 2 vehicle from a rudimentary low-poly mesh into a photorealistic, next-generation **Artemis Lunar Terrain Vehicle (LTV)**:
1. **Procedural Artemis LTV Model:** Sculpted aerodynamic composite bodywork, high-intensity front LED lightbars, sensor mast with LiDAR dome and stereo NavCams, gold MLI avionics bay, dual astronaut flight cockpit with orange safety harnesses, and compliant airless lattice wheels with radial spring blades and chevron traction cleats.
2. **Articulated 4-DOF Robotic Arm:** Azimuth base turret, boom spar, forearm spar, motorized 3-finger claw with targeting laser emitter, and sample rock pickup node.
3. **Directed Sample Retrieval Kinematics:** Inverse kinematics targeting detected ground rocks, claw clamping, regolith micro-gravity dust disturbance, dynamic attachment to claw, and rear cargo deck stowage into sample slots (0–8 rocks).
4. **Runtime Pivot Compensation:** Client-side pivot re-anchoring in `ApolloRoverModel.ts` to ensure unskinned Blender glTF nodes rotate around authored joint centers rather than vehicle origin.

---

## 2. Technical Contracts & Node Hierarchy

### 2.1 Model Hierarchy (`public/models/apollo_lrv.glb`)
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

### 2.2 Material Palette
- `ArtemisWhiteComposite`: High-albedo composite hull (Roughness 0.28, Metallic 0.05).
- `MatteCarbonFiber`: Structural chassis and cockpit floor (Roughness 0.45, Metallic 0.20).
- `KaptonGoldThermal`: Multi-layer insulation blanket (Roughness 0.22, Metallic 0.92).
- `TitaniumAlloy`: Suspension wishbones and arm spars (Roughness 0.35, Metallic 0.85).
- `LatticeAirlessTire`: Compliant titanium mesh tire with cleated tread (Roughness 0.60, Metallic 0.70).
- `HeadlightEmissive` / `LaserTargetingBeam`: High-lux LED and green laser targeting illumination.

---

## 3. Kinematic Sequence
When rock retrieval is triggered within 3.8m range at $< 10\,\text{km/h}$:
1. **Targeting Phase ($0.0 \to 0.35\,\text{s}$):** Laser beam illuminates specimen; turret rotates to rock azimuth $\theta_{\text{rock}}$; boom extends downward.
2. **Capture Phase ($0.35 \to 0.55\,\text{s}$):** 3-finger claw closes; micro-gravity regolith dust puff triggers; rock attaches to claw.
3. **Stow Phase ($0.55 \to 1.10\,\text{s}$):** Arm swings backward to cargo bay and deposits rock into the designated slot.
4. **Return Phase ($1.10 \to 1.30\,\text{s}$):** Arm resets to aerodynamic rest pose along starboard rail.
