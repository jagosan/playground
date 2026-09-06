# Spec 04: Moonbuggy2 Milestone 2 (High-Speed Physics, Dynamic Mass, Robotic Arm & Blender Pipeline)

> Target Hardware: GPD Win Max 2 (`chubbs` — AMD Ryzen 7 7840U/8840U, Radeon 780M gfx1103, 32GB RAM, Bazzite Linux / Handheld Gamepad)
> Complementary Profile: WebGL2/WebGPU on Beehive / Tailscale (`http://100.99.188.15:8088/`)

---

## 1. Executive Summary & Feedback Requirements
Spec 04 directly addresses feedback on Moonbuggy2:
1. **Responsive Acceleration to 25 km/h:** High initial motor torque tapering smoothly to a 25.0 km/h (6.94 m/s) speed governor with analog RT trigger precision.
2. **Moon Rock Sampling & Dynamic Mass Influx:** Sample collection adds +35 kg per rock. Higher payload mass increases wheel downforce, reduces lunar bounce, and moderately damps acceleration.
3. **Apollo Science Drop Station:** Landing site drop station at coordinates (0, 0) with landing platform beacon. Unloading rocks resets cargo weight, restores maximum acceleration, and replenishes rover power/fuel.
4. **Articulated Robotic Arm & Fuel/Power System:** Forward-mounted 3-segment robotic sampling arm with kinematics that animate when picking up rocks. Dynamic battery/fuel gauge draining on throttle and replenishing at the station.
5. **Blender 4.2 Headless Asset & Export Pipeline:** Genuine Blender 4.2 execution exporting high-poly GLB assets with PBR Principled BSDF shaders, metallic Kapton insulation, and high-frequency lunar rock photogrammetry models.

---

## 2. Technical Contracts & Mechanics

### 2.1 Dynamic Mass & Physics Parameters
- **Base Empty Mass:** 210 kg (chassis + batteries) + 150 kg (astronaut + suit) = **360 kg**.
- **Rock Weight:** Each sample rock adds **+35 kg** (up to 8 rocks = +280 kg payload).
- **Drive Torque:** 4x 1.2 kW independent wheel hub motors with variable low-end torque ($T_{\max} = 340\,\text{N}\cdot\text{m}$), tuned so 0–20 km/h takes ~2.8s unladen.
- **Speed Governor:** Hard cap at $25.0\,\text{km/h}$ ($6.944\,\text{m/s}$).
- **Fuel/Battery System:** 100% capacity. Normal driving drains ~0.35%/s. Robotic arm action consumes 1.5%. Drop station charges at 15%/s.

### 2.2 Robotic Arm Kinematics
- 3-segment robotic boom mounted at rover front-right:
  - Base turret (yaw $\pm 45^\circ$)
  - Bicep boom (pitch $0$ to $-60^\circ$)
  - Forearm & end-effector claw (sample grabber)
- Automatically triggers when within 3.5m of a target rock and pressing Button A (gamepad) or Space/E.

### 2.3 Drop Station & Base Hub
- Circular beacon platform at origin $(0, 0)$ with glowing radio telemetry dish and navigation beacons.
- When the buggy enters the 6-meter landing radius:
  - Collected rocks transfer to the scientific sample hopper.
  - Cargo weight clears.
  - Battery/fuel gauge recharges to 100%.
  - Audio and visual HUD confirmation.
