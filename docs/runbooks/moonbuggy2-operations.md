# Runbook: Moonbuggy 2 High-Fidelity Simulator Operations (Spec 03 + Milestone 2 / Spec 04)

## 1. Overview
`Moonbuggy2` is an ultra-realistic Apollo Lunar Roving Vehicle (LRV) simulation tuned for the GPD Win Max 2 (`chubbs`, AMD Radeon 780M). It features 120Hz sub-stepped multi-body suspension dynamics, Pacejka tire slip, PBR regolith with Hapke retro-reflection, and dual camera modes (chase and first-person cockpit).

**Milestone 2 (Spec 04)** extends the simulator with high-speed drive control (25 km/h governor), a dynamic-mass moon-rock sampling loop, an articulated 3-segment robotic arm, an Apollo science drop station, a draining/rechargeable fuel-battery gauge, and a Blender 4.2 headless asset & export pipeline.

## 2. GPD Win Max 2 Hardware & Gamepad Controls
The built-in gamepad on `chubbs` maps automatically via the W3C Gamepad API (XInput):

| Action | GPD Win Max 2 Gamepad | Keyboard / Mouse Fallback |
|---|---|---|
| **Steering** | **Left Analog Stick** (proportional dual-axle) | `A` (Left) / `D` (Right) or Arrows |
| **Throttle** | **Right Trigger (RT)** (analog 0–100%) | `W` or `Up Arrow` |
| **Brakes** | **Left Trigger (LT)** (analog deceleration) | `S` or `Down Arrow` |
| **Handbrake / Arm Pickup** | **Button A** (handbrake; arm grab when near a rock) | `Spacebar` or `E` |
| **Reverse Gear** | **Button X** | `R` key |
| **Toggle Camera** | **Button Y** (Chase / Cockpit) | `C` key or `[C] CAMERA` button |
| **Exit to Lobby**| — | `Escape` key or `[ESC] LOBBY` button |

## 3. Entering the Simulation from Playground
1. Launch `http://100.99.188.15:8088/` (Tailscale) or `http://localhost:8088/`.
2. In the 3D Playground Lobby, approach the **Moonbuggy 2 Simulator** pedestal (located at coordinates `X=-8, Z=14`, decorated with Apollo blue curb and gold foil chassis).
3. Press **`E`** or click/tap the golden **`PLAY`** prompt banner.
4. The simulation mounts the Hadley Rille lunar environment with 1.622 m/s² lunar gravity and Apollo cockpit telemetry.

## 4. Milestone 2 (Spec 04) Mechanics

### 4.1 Top-Speed Control & Drive Dynamics
- **Speed governor:** hard cap at **25.0 km/h** (`6.944 m/s`). High initial motor torque tapers smoothly into the governor; the RT trigger remains fully analog for fine throttle precision.
- **Drive train:** 4× independent 1.2 kW wheel hub motors, variable low-end torque (`T_max = 340 N·m`), tuned so **0–20 km/h ≈ 2.8 s** unladen.
- **Dynamic mass:** each collected rock adds **+35 kg** of payload (up to 8 rocks = **+280 kg**). Increased downforce reduces lunar bounce and moderately damps acceleration.

### 4.2 Moon-Rock Robotic Arm (Pickup)
- Forward-mounted **3-segment robotic boom** (rover front-right):
  - Base turret — yaw `±45°`
  - Bicep boom — pitch `0 → −60°`
  - Forearm + end-effector **sample-grab claw**
- **Trigger:** automatically engages when the rover is **within 3.5 m of a target rock** while holding **Button A** (gamepad) or **Space / E**.
- On a successful grab the arm kinematics animate the reach-and-claw cycle, the rock is added to cargo (**+35 kg**), and the battery gauge takes a **1.5%** action cost.

### 4.3 Apollo Science Drop Station
- Circular **beacon platform at origin `(0, 0)`** with a glowing radio-telemetry dish and navigation beacons.
- When the buggy enters the **6-meter landing radius**:
  - Collected rocks transfer to the scientific **sample hopper**.
  - **Cargo weight clears** (restores full acceleration).
  - **Battery/fuel gauge recharges to 100%** at **15 %/s**.
  - Audio + visual HUD confirmation plays.

### 4.4 Fuel / Battery Management
- **Gauge capacity:** 100 %.
- **Drain:** normal driving drains **~0.35 %/s** (proportional to throttle); a robotic-arm action costs a flat **1.5 %**.
- **Recharge:** the drop station restores the gauge at **15 %/s** (reaches 100 % in ~6.7 s).
- Plan sample runs around the `(0, 0)` station: drive to a rock field, grab up to 8 rocks, then return to the station to dump payload and fully recharge.

## 5. Blender 4.2 Asset Pipeline
Master Apollo LRV and lunar-rock models are regenerated headlessly in **Blender 4.2** via `scripts/generate_blender_assets.py`:

```bash
# Full pipeline (rover + rock)
blender --background --python scripts/generate_blender_assets.py all

# Individual assets
blender --background --python scripts/generate_blender_assets.py rover   # -> public/models/apollo_lrv.glb
blender --background --python scripts/generate_blender_assets.py rock    # -> public/models/lunar_rock.glb
```

This bakes the **PBR Principled BSDF** materials (Gold Kapton foil `Metallic 0.95 / Rough 0.22`, anodized aluminum tub, woven zinc-wire tires) and the high-poly lunar rock (high-frequency photogrammetry basalt, `Rough 0.94`) into GLB under `public/models/`. Run on `beehive`/`chunkito` where Blender is installed, then restart `playground.service` to serve the fresh assets.

> Legacy Spec 03 exporter: `blender --background --python scripts/export_lrv.py` (rover GLB only).

## 6. Automated Physics & Regression Testing
Run the 120Hz dynamics benchmark suite:
```bash
npx --prefix /home/jagosan/repos/playground tsx /home/jagosan/repos/playground/tests/verify-moonbuggy2.ts
```

Compile and package static distribution:
```bash
npm --prefix /home/jagosan/repos/playground run build
```
The active `playground.service` on `beehive` serves the updated assets immediately.
