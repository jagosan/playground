# Runbook: Moonbuggy 2 High-Fidelity Simulator Operations (Spec 03)

## 1. Overview
`Moonbuggy2` is an ultra-realistic Apollo Lunar Roving Vehicle (LRV) simulation tuned for the GPD Win Max 2 (`chubbs`, AMD Radeon 780M). It features 120Hz sub-stepped multi-body suspension dynamics, Pacejka tire slip, PBR regolith with Hapke retro-reflection, and dual camera modes (chase and first-person cockpit).

## 2. GPD Win Max 2 Hardware & Gamepad Controls
The built-in gamepad on `chubbs` maps automatically via the W3C Gamepad API (XInput):

| Action | GPD Win Max 2 Gamepad | Keyboard / Mouse Fallback |
|---|---|---|
| **Steering** | **Left Analog Stick** (proportional dual-axle) | `A` (Left) / `D` (Right) or Arrows |
| **Throttle** | **Right Trigger (RT)** (analog 0–100%) | `W` or `Up Arrow` |
| **Brakes** | **Left Trigger (LT)** (analog deceleration) | `S` or `Down Arrow` |
| **Handbrake** | **Button A** | `Spacebar` |
| **Reverse Gear** | **Button X** | `R` key |
| **Toggle Camera** | **Button Y** (Chase / Cockpit) | `C` key or `[C] CAMERA` button |
| **Exit to Lobby**| — | `Escape` key or `[ESC] LOBBY` button |

## 3. Entering the Simulation from Playground
1. Launch `http://100.99.188.15:8088/` (Tailscale) or `http://localhost:8088/`.
2. In the 3D Playground Lobby, approach the **Moonbuggy 2 Simulator** pedestal (located at coordinates `X=-8, Z=14`, decorated with Apollo blue curb and gold foil chassis).
3. Press **`E`** or click/tap the golden **`PLAY`** prompt banner.
4. The simulation instantly mounts the Hadley Rille lunar environment with 1.622 m/s² lunar gravity and Apollo cockpit telemetry.

## 4. Blender Asset Pipeline
The master Apollo LRV model can be regenerated or customized headlessly in Blender via:
```bash
blender --background --python scripts/export_lrv.py
```
This bakes the PBR Principled BSDF materials (Gold Kapton foil, aluminum tub, zinc wire tires) into `public/models/apollo_lrv.glb`.

## 5. Automated Physics & Regression Testing
Run the 120Hz dynamics benchmark suite:
```bash
npx --prefix /home/jagosan/repos/playground tsx /home/jagosan/repos/playground/tests/verify-moonbuggy2.ts
```

Compile and package static distribution:
```bash
npm --prefix /home/jagosan/repos/playground run build
```
The active `playground.service` on `beehive` serves the updated assets immediately.
