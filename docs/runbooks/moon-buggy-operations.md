# Runbook: Moon Buggy Minigame Operations (Spec 02)

## 1. Overview
The Moon Buggy minigame (`src/minigames/moon-buggy/`) implements a 1/6th Earth gravity ($1.62\,\text{m/s}^2$) physics simulation and procedural lunar crater navigation inside the 3D Playground.

## 2. Controls & Telemetry
- **Throttle / Acceleration:** `W` or `Up Arrow`
- **Reverse / Deceleration:** `S` or `Down Arrow`
- **Steering:** `A` (Left) / `D` (Right) or Arrow keys
- **Emergency Handbrake:** `Spacebar`
- **Exit to Lobby:** `Escape` key or click red `[ESC] RETURN TO LOBBY` HUD button

## 3. Physics & Atmosphere Specifications
- **Gravity:** Set to lunar gravity $-1.62\,\text{m/s}^2$ ($0.166\,g$).
- **Suspension:** 4-point raycast suspension with independent spring stiffness ($k=38.0$) and damping coefficients ($c=6.0$).
- **Skybox:** Pitch-black deep-space background with a 1,200-node hemispherical starfield and distant Earth marble.
- **Lighting:** Harsh directional sunlight ($2.2\times$ intensity) with zero atmospheric scattering and high-contrast regolith shadows.

## 4. Verification & Testing
To execute the automated physics verification test suite:
```bash
npx --prefix /home/jagosan/repos/playground tsx /home/jagosan/repos/playground/tests/verify-moon-buggy.ts
```

To build production static artifacts:
```bash
npm --prefix /home/jagosan/repos/playground run build
```
Production assets are generated into `/home/jagosan/repos/playground/dist/` and can be served statically from any static host or web server.
