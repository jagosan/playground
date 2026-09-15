# Spec 15: Lunar Frontier — Rover Visual Overhaul, Unified Kinematics & Full Controller Tuning

> **Target Systems:** `OpenBuggy.ts`, `TraversalPhysics.ts`, `ClientApp.ts`, `CameraRig.ts`, and Verification Suites.  
> **Platforms:** WebGL2/WebGPU Desktop (Chrome/Firefox) & Handhelds (GPD Win Max 2, Steam Deck, standard Gamepad API).  
> **Preceding Specs:** Spec 12 (Lunar Frontier Architecture), Spec 13 (Interactive Client & Market), Spec 14 (UX, Infrastructure & Navigation).

---

## 1. Executive Summary & Root Cause Analysis

User dogfooding revealed critical flaws in the lunar rover experience:
1. **Visual Model Degradation:**
   - The buggy is currently assembled from simple, disconnected geometric primitives (`GEO` boxes and cylinders in `OpenBuggy.ts`) that jitter independently because suspension heave and compression offsets are applied without a cohesive chassis frame, roll cage, wheel wishbones, or cockpit assembly.
   - It fails to look or feel like a believable lunar exploration rover.
2. **Broken Keyboard & Gamepad Driving Controls:**
   - In `ClientApp.ts`, keyboard controls route steering through `strafe` (`KeyD - KeyA`), but in vehicle mode `KeyA`/`KeyD` are natural steering keys while arrow keys also emit `yaw`. When driving, the steer mapping is sluggish, unpredictable, or inverted relative to third-person camera chase angles.
   - Left/Right keys and gamepad analog stick inputs do not provide a predictable, direct turning response; the vehicle cannot drive in a clean straight line due to asymmetrical tire lateral friction and unbounded yaw relaxation.
3. **Erratic Acceleration & Braking Dynamics:**
   - Powertrain torque, speed limiting, rolling resistance, and regen braking in `TraversalPhysics.ts` produce extreme jitter, instant stopping, or sudden runaway speeds.
   - Reverse logic is brittle (`throttle < 0 && s.vLong < 0.4`), causing the vehicle to stall, jerk between forward and reverse, or lock wheels abruptly when tapping brakes.
   - The buggy lacks progressive acceleration curves, realistic motor ramp-up, natural coasting, and stable hydraulic/regenerative deceleration.

This specification establishes an architectural blueprint to completely rebuild the rover's visual model, overhaul its driving dynamics and input pipeline, and establish rigorous headless and browser test harnesses.

---

## 2. Rover Visual Architecture (`OpenBuggy.ts`)

### 2.1 Cohesive Lunar Rover Mesh Hierarchy
Replace the crude disjoint boxes with a structurally sound, authentic Apollo/Artemis-inspired lunar exploration rover constructed via Babylon.js procedural geometry and PBR materials:

```
[buggy-root] (Root TransformNode: handles physics world position, heading yaw, pitch & roll)
  ├── [buggy-tub-chassis] (Beveled/trapezoidal structural chassis tub with underside skid plate)
  ├── [buggy-tubular-frame] (Rigid perimeter roll cage & tubular space frame protecting driver & cargo)
  ├── [buggy-front-cowl] (Sloped front nose cone, telemetry dish mast, and dual auxiliary sensor pods)
  ├── [buggy-cockpit]
  │     ├── [buggy-seat-base] & [buggy-seat-back] (Form-fitting astronaut pilot bucket seat with harness straps)
  │     ├── [buggy-steering-t-bar] (T-handle lunar joystick controller mounted on central pedestal)
  │     └── [buggy-dash-display] (Cockpit telemetry console with emissive status screen)
  ├── [buggy-cargo-bay]
  │     ├── [buggy-cargo-bed] (Ribbed high-durability rear cargo tray with side retention rails)
  │     └── [buggy-cargo-crates] (Dynamic mineral containers scaled/visible according to `cargoMass`)
  ├── [buggy-lighting]
  │     ├── [buggy-lightbar] (Front horizontal crossbar housing dual LED projector headlights)
  │     ├── [buggy-headlight-l] & [buggy-headlight-r] (Directional SpotLights with lens flare/glow caps)
  │     └── [buggy-taillights] (Dual rear red emissive LED indicators that brighten during braking)
  └── [buggy-suspension-corners] (4 articulated corner assemblies: FL, FR, RL, RR)
        └── [corner-pivot] (Tracks suspension vertical compression along spring travel)
              ├── [a-arms] (Upper and lower double-wishbone suspension arms)
              ├── [steering-knuckle] (Front corners only: steers around vertical Y-axis with steering angle $\delta$)
              │     └── [wheel-hub] (Axle hub bearing)
              │           └── [road-wheel] (Airless compliant open-mesh rim + high-traction lunar chevron tread)
              └── [mud-flap] (Curved lunar regolith dust fenders mounted over each wheel)
```

### 2.2 Mechanical Integrity & Eliminating "Bouncing In Proximity"
- All chassis components (frame, cockpit, cargo bed, headlights, dash) must share the unified chassis body transform. They must never move or oscillate relative to one another.
- Suspension travel must only displace the wheel hubs, wishbones, and dust fenders relative to the chassis tub:
  $$\Delta y_{\text{wheel}} = (\text{compression}_i - 0.5) \times \text{SPRING\_TRAVEL}$$
- Front wheels must articulate their steering yaw independently from road spin rotation:
  $$\text{WheelRotation} = \mathbf{R}_{\text{steer}}(\delta) \times \mathbf{R}_{\text{spin}}(\theta_i)$$
  eliminating off-axis wobbling.

### 2.3 PBR Material & Aesthetic Palette
- **Spacecraft Gold / Kapton Foil:** Multi-layer insulation (MLI) blankets on avionics containers and battery enclosure (`metallic = 0.85, roughness = 0.25, albedo = Color3(0.92, 0.76, 0.20)`).
- **Hazard Matte Yellow:** High-contrast coated structural roll bars and tubular crash cage (`albedo = Color3(0.82, 0.62, 0.12), roughness = 0.55`).
- **Anodized Matte Aluminum:** Double wishbones, hubs, suspension links, and chassis skid plate (`metallic = 0.90, roughness = 0.35, albedo = Color3(0.75, 0.77, 0.80)`).
- **Airless Open-Lattice Mesh / Rubber:** Compliant wire-mesh tire treads with dark titanium chevron cleats (`metallic = 0.4, roughness = 0.85, albedo = Color3(0.18, 0.18, 0.20)`).

---

## 3. Physics & Powertrain Overhaul (`TraversalPhysics.ts`)

### 3.1 Straight-Line Stability & Neutral Steer Kinematics
- **Symmetric Neutral Steering:** When steering demand is zero ($|\text{steer}| < 10^{-3}$), clamp $\delta = 0$ exactly and apply an active straight-line yaw stabilizer to eliminate numerical yaw drift:
  $$M_{\text{damping}} = -k_{\text{yaw\_damp}} \cdot I_{zz} \cdot \dot{\psi}$$
- **Speed-Sensitive Steering Ratio:** Reduce maximum steering angle at high speed to prevent high-speed oversteer and immediate rollover:
  $$\delta_{\text{max}}(v) = \frac{\delta_0}{1 + 0.08 \cdot |v_{\text{long}}|}$$
- **Ackermann Steering Geometry:** Front wheels turn with differential angles:
  $$\delta_{\text{inner}} = \arctan\left(\frac{L}{\frac{L}{\tan\delta} - \frac{W}{2}}\right), \quad \delta_{\text{outer}} = \arctan\left(\frac{L}{\frac{L}{\tan\delta} + \frac{W}{2}}\right)$$

### 3.2 Smooth Acceleration, Deceleration & Reversing Dynamics
- **Drive Mode State Machine:**
  - `FORWARD`: $v_{\text{long}} \ge -0.2\,\text{m/s}$. Throttle ($>0$) accelerates forward; brake ($>0$) or negative throttle applies blended regen + friction braking down to standstill.
  - `STOPPED`: $|v_{\text{long}}| < 0.2\,\text{m/s}$ and throttle released. Automatic zero-speed hold prevents hill roll-back.
  - `REVERSE`: From `STOPPED`, holding reverse input (throttle $< 0$) transitions into reverse drive with capped speed ($v_{\text{rev\_max}} = 5.0\,\text{m/s}$).
- **Progressive Powertrain Torque Curve:**
  - Replace step-function force with smooth motor torque rise ($T_{\text{rise}} = 0.25\,\text{s}$):
    $$\tau_{\text{motor}} = \text{approach}(\tau_{\text{current}}, \tau_{\text{target}}, 4.0, dt)$$
  - High initial low-speed torque for climbing crater slopes, tapering hyperbolically along continuous motor power curves:
    $$F_{\text{drive}} = \min\left(F_{\text{max}}, \frac{P_{\text{motor}}}{\max(|v_{\text{long}}|, 1.0)}\right)$$
- **Natural Coasting & Rolling Resistance:**
  - Releasing throttle without braking must coast smoothly with subtle regolith resistance ($C_{\text{roll}} \approx 0.04$), not slam to an instant stop.

### 3.3 Low-Gravity Contact & Suspension Damping
- Suspension stiffness ($k_s$) and damping ($c_d$) must be tuned for critical damping under lunar gravity ($1.62\,\text{m/s}^2$):
  $$\zeta = \frac{c_d}{2 \sqrt{k_s \cdot m_{\text{corner}}}} \approx 0.707 \quad (\text{critically damped})$$
  eliminating erratic vertical bouncing while retaining satisfying compliance over crater rims.

---

## 4. Control Pipeline & Input Mapping (`ClientApp.ts`)

### 4.1 Unified Input Handling for Buggy Mode
When `this.mode === 'buggy'`:

| Input Device | Action | Mapping | Semantics |
|---|---|---|---|
| **Keyboard** | Throttle / Forward | `KeyW` or `ArrowUp` | Progressive forward drive ($0 \to 1$) |
| **Keyboard** | Brake / Reverse | `KeyS` or `ArrowDown` | Progressive brake; reverses from stop |
| **Keyboard** | Steer Left | `KeyA` or `ArrowLeft` | Left steering angle ($\delta < 0$) |
| **Keyboard** | Steer Right | `KeyD` or `ArrowRight` | Right steering angle ($\delta > 0$) |
| **Keyboard** | Handbrake | `Space` | Instant 4-wheel lockup & slide |
| **Gamepad** | Analog Throttle | Right Trigger (`RT`) / Axis | Smooth variable forward throttle ($0.0 \to 1.0$) |
| **Gamepad** | Analog Brake | Left Trigger (`LT`) / Axis | Smooth progressive braking ($0.0 \to 1.0$) |
| **Gamepad** | Analog Steer | Left Stick X | Smooth proportional steering with deadzone |
| **Gamepad** | Reverse | Left Stick Y (pull back) | Reverse from standstill |
| **Gamepad** | Handbrake | Button `A` | Handbrake slide |
| **Gamepad** | Mount/Dismount | Button `X` | Exit driver seat to EVA |
| **Gamepad** | Lights Toggle | Button `Y` | Toggle headlights |

### 4.2 Camera Chase Behavior (`CameraRig.ts`)
- In `vehicle_chase` mode, smoothly track behind the buggy's velocity vector with elastic damping:
  - Base distance: $7.5\,\text{m}$, Elevation: $2.8\,\text{m}$, Pitch tilt: $-12^\circ$.
  - Dynamic FOV expansion with speed ($55^\circ \to 68^\circ$ at top speed) to enhance sense of velocity.
  - Camera must never spin wildly when the rover changes direction at low speeds.

---

## 5. Implementation Phases & Task Breakdown

### Phase 1: Powertrain & Kinematics Engine Overhaul (`TraversalPhysics.ts`)
- [ ] Implement Ackermann steering angles and speed-sensitive steering dampener.
- [ ] Implement active straight-line yaw stabilizer for zero-steer input.
- [ ] Build robust `DriveMode` state machine (`FORWARD`, `STOPPED`, `REVERSE`) with seamless transitions.
- [ ] Tune critically damped suspension constants for 1/6th lunar gravity.

### Phase 2: High-Fidelity 3D Buggy Assembly (`OpenBuggy.ts`)
- [ ] Construct structural chassis tub, roll cage, and front cowlings as a rigid unit hierarchy.
- [ ] Add detailed cockpit: bucket seat, harness, lunar joystick T-bar, instrument panel.
- [ ] Build 4 independent suspension corners with double wishbones and chevron airless wheels.
- [ ] Wire dynamic steering knuckle yaw rotation and accurate road spin without wobble.
- [ ] Add dual front LED projector lamps with volumetric glow and reactive rear brake lights.

### Phase 3: Input Pipeline & Controller Calibration (`ClientApp.ts`, `CameraRig.ts`)
- [ ] Unify keyboard drive controls (`W/S` throttle-brake-reverse, `A/D` steering, `Space` handbrake).
- [ ] Bind analog triggers and Left Stick steering with 15% deadzone and progressive polynomial response curve ($x^{1.4}$).
- [ ] Stabilize vehicle chase camera damping and orientation alignment.

### Phase 4: Headless Smoke Harness & Contract Testing
- [ ] Update `games/lunar-frontier/scripts/smoke-open-buggy.ts`:
  - Verify rigid chassis hierarchy (parts share parent root, zero unexpected relative translation).
  - Verify straight-line driving test: 10 seconds of full throttle with zero steering must yield $|\Delta y| < 0.05\,\text{m}$.
  - Verify progressive acceleration: smooth monotonic velocity increase without jerk or spikes.
  - Verify stop & reverse transition: forward throttle $\to$ brake to full stop $\to$ reverse throttle drives backward ($v_{\text{long}} < 0$).
  - Verify steering limits: high-speed steering angle derating and rollover resistance.
- [ ] Run full existing regression suite (`smoke-client-app.ts`, `smoke-traversal.ts`, `verify-phase8-interactive.ts`) to ensure zero regressions across economy, EVA suit, and multiplayer sync.

---

## 6. Verification Criteria & Acceptance Gate

1. **Straight-Line Stability:** Rover driven across flat terrain with zero steer input maintains heading within $\pm 0.5^\circ$ over 100 meters.
2. **Visual Fidelity:** Rover visual structure appears solid, detailed, and realistic; no disconnected or independently floating primitives.
3. **Control Responsiveness:**
   - Keyboard `W/S/A/D` and gamepad analog controls feel intuitive, responsive, and natural.
   - Smooth acceleration from rest, progressive deceleration to a complete standstill, and reliable reverse gear.
4. **All Tests Pass:** Standalone verification script (`node --no-warnings scripts/smoke-open-buggy.ts`) exits with status `0` with 100% green assertions.
5. **Clean Production Build:** `npm run build` succeeds with zero TypeScript or bundler errors.
