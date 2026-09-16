# Spec 16: Lunar Frontier — Dramatic Rover Experience, Terrain Texture & Navigation Overhaul

> **Target Systems:** `OpenBuggy.ts`, `TraversalPhysics.ts`, `WorldScene.ts`, `LunarWorldGenerator.ts`, `ClientApp.ts`, `LunarHUD.ts`, `CameraRig.ts`.  
> **Platforms:** WebGL2/WebGPU Desktop (Chrome/Firefox) & Handhelds (GPD Win Max 2, Steam Deck, standard Gamepad API).  
> **Preceding Specs:** Spec 12 (Lunar Frontier Architecture), Spec 14 (UX, Infrastructure & Navigation), Spec 15 (Rover Visual Overhaul & Unified Kinematics).

---

## 1. Executive Summary & Root Cause Analysis

Extensive dogfooding revealed 7 critical deficiencies impairing the lunar buggy experience:

1. **Distracting Cockpit Beacon Light:**
   - *Symptom:* A vertical cyan/blue beam emerges from the buggy roof directly into the driver's field of view when the astronaut enters the vehicle.
   - *Root Cause:* `this.buggyBeacon` in `ClientApp.ts` (designed to guide an EVA astronaut on foot back to the rover) remains enabled and placed at the vehicle origin while mounted.
   - *Fix:* Explicitly disable `this.buggyBeacon` when `this.mode === 'buggy'`, re-enabling it only when on foot (`this.mode !== 'buggy'`).

2. **Chassis-to-Wheel Bouncing & Lack of Realism:**
   - *Symptom:* The chassis vibrates and bounces erratically up and down relative to the wheels like an unweighted pogo stick.
   - *Root Cause:* In `TraversalPhysics.ts`, heave damping evaluated to zero (`BUGGY_DAMPER * (vCorner - s.vBody)` where `vCorner === s.vBody`). Furthermore, pitch and roll attitudes failed to track ground slopes, and wheel suspension mounts did not sample individual per-corner ground heights ($z_{\text{ground},i} = \text{ground}(x_i, y_i)$).
   - *Fix:* Implement true per-corner suspension raycasting and critically damped spring-damper equations ($\zeta \approx 0.707$) with physical travel stops ($\pm 0.15\,\text{m}$), and align body pitch/roll to ground slope gradients.

3. **Surface Texture, Crater Legibility & Vacuum Shadows:**
   - *Symptom:* Regolith appears flat and featureless; craters lack visible depth cues or distinct lips; the rover passes through terrain irregularities without shadows.
   - *Root Cause:* The sun's `shadowFrustumSize` is fixed at $4000\,\text{m}$ with `autoUpdateExtends = false`, spreading shadow map resolution across 4 kilometers and causing contact shadows to vanish. Surface PBR lacks crater ejecta albedo modulation, slope normals, and micro-crater shadows.
   - *Fix:* Implement a camera/vehicle-focused shadow frustum ($120\,\text{m} \times 120\,\text{m}$ cascade with high-quality PCF), enhanced multi-scale normal tiling, and ejecta contrast around crater perimeters. Exact height alignment prevents rover wheels from sinking.

4. **Terrain Flatness & Bouncing Irregularities:**
   - *Symptom:* Continuous erratic shaking and bouncing across open plains.
   - *Root Cause:* `microRelief` in `WorldScene.ts` was set to $1.1\,\text{m}$ using high-frequency noise `fbm2(wx * 0.09, wy * 0.09)`, turning open plains into dense mogul fields. Craters also feature sharp $15\%$ conical depth cliffs.
   - *Fix:* Tame plain `microRelief` to $\le 0.20\,\text{m}$ for smooth cruising, and reshape crater profiles using smoothstep polynomial curves with gentle ejecta rims.

5. **Mineral Deposit Navigation (HUD Arrow & Radar):**
   - *Symptom:* Driver is blind to mineral locations across the $1024\,\text{m}$ map due to restrictive $80\,\text{m}$ scanner range.
   - *Root Cause:* `SCAN_RANGE_M = 80` in `ClientApp.ts`; vein beacon only activates within $80\,\text{m}$; no permanent 3D directional arrow or HUD radar.
   - *Fix:* Add a 3D navigational waypoint arrow / HUD compass pointer tracking the nearest high-value mineral deposit (Water Ice, Titanium, Platinum, Helium-3, Rare Earths), display target name, distance, and bearing, and expand search radius to map-wide ($\ge 1000\,\text{m}$).

6. **Snappy Powertrain Acceleration:**
   - *Symptom:* Sluggish ramp-up to top speed ($22\,\text{m/s}$).
   - *Root Cause:* Throttle rate `approach` is limited to $4.0\,\text{s}^{-1}$, and peak motor power was throttled at higher speeds.
   - *Fix:* Triple throttle rise rate to $12.0\,\text{s}^{-1}$, increase per-wheel peak tractive force to $3,800\,\text{N}$, and boost quad-motor power to $72\,\text{kW}$ total, providing brisk $0 \to 20\,\text{m/s}$ acceleration in under $4.0\,\text{s}$.

7. **Rapid Deceleration & Agile Low-Speed Turnaround:**
   - *Symptom:* Hard to stop quickly, sluggish reverse transitions, and wide, cumbersome turning radius at low speeds.
   - *Root Cause:* Max steering angle was capped at $0.55\,\text{rad}$ ($31^\circ$), braking force was weak ($6,000\,\text{N}$), and reverse required dropping under $0.2\,\text{m/s}$ before engaging.
   - *Fix:* Increase friction braking to $14,000\,\text{N}$ + $8,000\,\text{N}$ regen; increase low-speed steering lock to $0.78\,\text{rad}$ ($45^\circ$); implement active differential torque-vectoring / skid-steer assist at low speeds ($|v_{\text{long}}| < 4\,\text{m/s}$) for snappy $180^\circ$ turnaround spins; provide instant zero-threshold brake-to-reverse when held at standstill.

---

## 2. Architectural & Mathematical Specifications

### 2.1 Cockpit Beacon Control (`ClientApp.ts`)
```typescript
// Buggy beacon must only illuminate when on foot to guide the astronaut back
this.buggyBeacon.setEnabled(this.mode !== 'buggy');
```
- In `refreshWaypoints(now)`:
  - If `this.mode === 'buggy'`, force `this.buggyBeacon.setEnabled(false)`.
  - If `this.mode !== 'buggy'`, enable `this.buggyBeacon` and place at `buggy.getPosition()`.

### 2.2 Suspension & Chassis Kinematics (`TraversalPhysics.ts`, `OpenBuggy.ts`)
- **Per-Corner Ground Sampling:**
  $$z_{\text{contact}, i} = \text{ground}(x_{\text{corner}, i}, y_{\text{corner}, i})$$
- **Suspension Deflection & Damped Normal Force:**
  $$x_i = z_{\text{contact}, i} + R_{\text{wheel}} - z_{\text{mount}, i}$$
  $$F_{z, i} = \max\left(0, k_s \cdot x_i - c_d \cdot v_{z, \text{mount}, i}\right)$$
  Where $k_s = 5,200\,\text{N/m}$ and $c_d = 2 \cdot \zeta \cdot \sqrt{k_s \cdot m_{\text{corner}}} \approx 1,850\,\text{N}\cdot\text{s/m}$ ($\zeta = 0.707$).
- **Slope-Aligned Body Attitude:**
  $$\theta_{\text{slope\_pitch}} = \arctan\left(\frac{z_{\text{front}} - z_{\text{rear}}}{L}\right), \quad \phi_{\text{slope\_roll}} = \arctan\left(\frac{z_{\text{left}} - z_{\text{right}}}{W}\right)$$
  Body pitch and roll smoothly interpolate toward dynamic target $(\theta_{\text{slope\_pitch}} + \theta_{\text{accel}}, \phi_{\text{slope\_roll}} + \phi_{\text{accel}})$.

### 2.3 Photorealistic Regolith & Focused Vacuum Shadows (`WorldScene.ts`)
- **Sun Directional Shadow Box:**
  - Adjust `sun.position` to track camera/buggy position:
    $$\mathbf{p}_{\text{sun}} = \mathbf{p}_{\text{buggy}} - 80 \cdot \hat{\mathbf{d}}_{\text{sun}}$$
  - Set `sun.shadowFrustumSize = 120` (tight $120\,\text{m}$ box around player) with `autoUpdateExtends = false`, giving sub-decimeter shadow texels with 2048 shadow map.
- **Micro-Relief & Plain Smoothing:**
  - Tame plain `microRelief`: default reduced from $1.1\,\text{m}$ to $0.22\,\text{m}$.
  - Smooth crater lip formula:
    $$z_{\text{crater}}(d) = -D \cdot \left(1 - \left(\frac{d}{R}\right)^2\right)^2 \quad \text{for } d < R$$
    $$z_{\text{rim}}(d) = 0.12 \cdot D \cdot \exp\left(-\left(\frac{d - R}{0.2 \cdot R}\right)^2\right) \quad \text{for } d \ge R$$

### 2.4 Mineral Guidance Navigation (`ClientApp.ts`, `LunarHUD.ts`)
- **Long-Range Mineral Scanner:**
  - `NAV_SCAN_RANGE_M = 1200` (global sector awareness).
  - Finds closest mineral vein across all types, prioritizing high-value ores.
- **HUD Nav Pointer / Waypoint Needle:**
  - Compute relative bearing $\Delta \psi = \text{wrap180}(\theta_{\text{vein}} - \theta_{\text{heading}})$.
  - Render directional guidance arrow (`◀ [VEIN]`, `▲ [VEIN]`, `▶ [VEIN]`) on HUD and compass tape with live range readout.

### 2.5 Brisk Powertrain & High-Speed Performance (`TraversalPhysics.ts`)
- `BUGGY_WHEEL_FORCE = 3_800\,\text{N}` (total $15.2\,\text{kN}$ launch traction).
- `BUGGY_MOTOR_POWER = 18_000\,\text{W}` per motor ($72\,\text{kW}$ AWD).
- Throttle torque rise rate: $12.0\,\text{s}^{-1}$.
- Acceleration performance: $0 \to 20\,\text{m/s}$ in $\approx 3.2\,\text{s}$.

### 2.6 Deceleration & Agile Turnaround Dynamics (`TraversalPhysics.ts`)
- `BUGGY_BRAKE_FORCE = 14_000\,\text{N}` (friction) + $8,000\,\text{N}$ (regen).
- Low-speed steering angle $\delta_{\text{max}} = 0.78\,\text{rad}$ ($45^\circ$) for $|v| < 3\,\text{m/s}$.
- Low-speed torque vectoring / skid-steer assist:
  $$M_{\text{yaw\_assist}} = \text{sign}(\delta) \cdot \tau_{\text{assist}} \cdot (1 - |v| / 4.0)$$
  Enables snappy $180^\circ$ U-turns in $< 2.5\,\text{s}$ within a $3\,\text{m}$ turning radius.
- Instant zero-speed reverse engagement from brake hold.

---

## 3. Implementation Plan & Phases

| Phase | Description | Components |
|:---|:---|:---|
| **Phase 1** | **Cockpit Beacon & Suspension Kinematics** | `ClientApp.ts`, `OpenBuggy.ts`, `TraversalPhysics.ts` |
| **Phase 2** | **Terrain Smoothing, Craters & Shadow Frustum** | `WorldScene.ts`, `LunarWorldGenerator.ts` |
| **Phase 3** | **Mineral Navigation Arrow & Long-Range Scanner** | `ClientApp.ts`, `LunarHUD.ts`, `hud.css` |
| **Phase 4** | **Powertrain Acceleration & Agile Turnaround Tuning**| `TraversalPhysics.ts`, `OpenBuggy.ts` |
| **Phase 5** | **Smoke Verification & Regression Testing** | `smoke-open-buggy.ts`, `smoke-client-app.ts` |

---

## 4. Verification & Acceptance Gate

1. **Beacon Suppression:** In buggy mode, `buggyBeacon.isEnabled()` is strictly `false`. On dismount, `buggyBeacon.isEnabled()` is `true`.
2. **Smooth Suspension:** No chassis bouncing oscillation when resting or driving over flat terrain; heave damping verified.
3. **Terrain Legibility:** Visible crisp vacuum shadows under rover and crater rims; open plain roughness $\le 0.25\,\text{m}$; zero rover-terrain clipping.
4. **Mineral Navigation:** Directional nav arrow and distance indicator displayed for mineral deposits $\le 1200\,\text{m}$.
5. **Acceleration:** Reaches $\ge 15\,\text{m/s}$ in $\le 3.0\,\text{s}$ from standstill.
6. **Braking & Turnaround:** Halts from $15\,\text{m/s}$ to $0$ in $\le 1.8\,\text{s}$; executes a $180^\circ$ turn in $< 3.0\,\text{s}$ at low speed.
7. **Regression Gate:** Standalone smoke tests pass with 100% green checks; `npm run build` succeeds.
