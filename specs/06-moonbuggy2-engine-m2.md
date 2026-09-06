# Spec 06: Moonbuggy2 Engine Milestone 2 (GLTF Runtime Integration & Gameplay Mechanics)

> Target Hardware: GPD Win Max 2 (`chubbs` — AMD Ryzen 7 7840U/8840U, Radeon 780M, Bazzite Linux)
> Complementary Profile: WebGL2/WebGPU via Three.js over Tailscale (`http://100.99.188.15:8088/`)
> Prerequisite: Spec 05 (`public/models/*.glb` produced via Blender 4.2 pipeline)

---

## 1. Executive Summary & Goals
This specification upgrades the Moonbuggy2 game engine and scene runtime to:
1. Load genuine binary glTF (`.glb`) models created by the Blender 4.2 pipeline with graceful procedural fallback.
2. Bind scene kinematics to animated sub-nodes: wheel spin, 4-wheel independent steering, and articulated robotic sample arm.
3. Implement high-speed lunar dynamics: rapid acceleration to $25.0\,\text{km/h}$ ($6.94\,\text{m/s}$), variable downforce, and analog RT throttle curve.
4. Implement the dynamic mass collection loop: +35 kg per collected rock, mass dampening on acceleration and bounce.
5. Implement the Science Drop Station at $(0, 0)$: cargo unload, weight reset, and battery/power recharge loop.
6. Upgrade the cockpit HUD: analog speedometer, fuel/battery bar, cargo mass display, and waypoint guidance compass.

---

## 2. Technical Contracts & Component Specifications

### 2.1 Asset Loader Pipeline (`GLTFAssetLoader.ts`)
- Utilizes Three.js `GLTFLoader` with `DRACOLoader` support.
- Preloads:
  - `public/models/apollo_lrv.glb`
  - `public/models/lunar_rocks.glb`
  - `public/models/lunar_drop_station.glb`
  - `public/models/lunar_terrain_tile.glb`
- Fallback Contract: If network or asset load encounters an error, automatically construct procedural visual primitives to prevent crashes.

### 2.2 Physics & Mass Dynamics (`LRVPhysics.ts`)
- **Base Mass:** $360.0\,\text{kg}$ ($210\,\text{kg}$ vehicle + $150\,\text{kg}$ crew).
- **Rock Mass:** $+35.0\,\text{kg}$ per rock (up to 8 rocks = $+280\,\text{kg}$ max cargo).
- **Drive Torque:** 4x $1.2\,\text{kW}$ independent electric hub motors ($T_{\max} = 360\,\text{N}\cdot\text{m}$).
- **Acceleration Curve:** $0 \to 20\,\text{km/h}$ in $< 2.5\,\text{s}$ unladen; top speed capped at $25.0\,\text{km/h}$.
- **Gravity:** Standard Apollo lunar gravity $g = 1.62\,\text{m/s}^2$.
- **Suspension:** 4-wheel independent double-wishbone with spring constant $k_s = 7500\,\text{N/m}$ and damping $c = 950\,\text{N}\cdot\text{s/m}$.

### 2.3 Robotic Arm Kinematics & Rock Collection (`RoboticArmController.ts`)
- Articulated 3-joint kinematics:
  - Joint 1 (Base Yaw): $\pm 45^\circ$
  - Joint 2 (Boom Pitch): $0^\circ \to -55^\circ$
  - Joint 3 (Claw Pitch & Grasp): $0^\circ \to -40^\circ$
- Collection Trigger: When rover is within $3.5\,\text{m}$ of a rock and moving $< 3.0\,\text{km/h}$, pressing Button A / Space initiates the 1.2s grab cycle.
- Consumes $1.5\%$ battery power per collection.

### 2.4 Science Drop Station & Base Hub (`ScienceDropStation.ts`)
- Located at coordinates $(x=0, z=0)$.
- Docking Beacon radius: $6.0\,\text{m}$.
- On entry:
  - Cargo rocks unload into the science hopper.
  - Cargo weight drops to $0\,\text{kg}$.
  - Battery/power charges at $+15\%/\text{s}$.
  - HUD displays "CARGO UNLOADED + SCIENTIFIC POINTS AWARDED".

### 2.5 Telemetry Cockpit HUD (`Moonbuggy2HUD.ts`)
- Digital/Analog Speedometer with km/h display and 25 km/h redline indicator.
- Power / Battery Gauge (0–100%).
- Cargo Bay indicator (0/8 rocks, current vehicle weight in kg).
- Directional Nav-Compass indicating heading back to the Drop Station at $(0, 0)$.
