# Spec 20: Lunar Frontier — Buggy Hill-Hold & Zero-Drift Braking, Decoupled Dual-Stick Layout (Drive-Right / Look-Left)

> **Target Systems:** `games/lunar-frontier/src/physics/TraversalPhysics.ts`, `games/lunar-frontier/src/client/ClientApp.ts`, `games/lunar-frontier/src/ui/LunarHUD.ts`, `games/lunar-frontier/src/engine/CameraRig.ts`.  
> **Platforms:** WebGL2/WebGPU Desktop (Chrome/Firefox), Steam Deck & Handhelds (GPD Win Max 2, Linux Gamepad API).  
> **Preceding Specs:** Spec 16/17 (Rover Kinematics & Proving Grounds), Spec 18 (Quest Framework & Telemetry), Spec 19 (Gamepad Controls Overhaul & Mining UX).

---

## 1. Executive Summary & Root-Cause Analysis

Field feedback from operators piloting the open-top lunar buggy on regolith terrain revealed two primary friction points:

1. **Uncontrolled Forward Drift & Inability to Stay Stationary:**
   - **Physics Cause A (Vacuum & Incline Gravity vs Low Rolling Resistance):** In lunar vacuum ($C_d A = 0$, $g = 1.62\,\text{m/s}^2$), normal force is $1/6\text{th}$ of Earth. Tyre rolling resistance is $F_\text{roll} = \mu_\text{roll} \cdot N = 0.035 \cdot m \cdot 1.62 \approx 0.0567 \cdot m\,\text{N}$. Gravitational acceleration along a surface slope is $g_\text{long} = -g \cdot \sin(\theta_\text{slope})$. On any slope $\theta \ge \arcsin(0.035) \approx 2.00^\circ$, gravity exceeds rolling resistance. Because craters and regolith terrain constantly feature $2^\circ \dots 15^\circ$ slopes, releasing the forward throttle without actively jamming the handbrake leaves the rover coasting or accelerating downhill indefinitely.
   - **Physics Cause B (Flawed State Machine Transition to `STOPPED`):** In `LunarBuggy.substep()`, transitioning from `FORWARD` to `STOPPED` required $|v_\text{long}| < 0.2\,\text{m/s}$. Downhill gravitational pull prevents $|v_\text{long}|$ from ever dropping below $0.2\,\text{m/s}$, locking the rover permanently in `FORWARD` mode.
   - **Physics Cause C (Inadequate Park Resistance & Creep Leaks):** When stationary, the hill-hold logic in `TraversalPhysics.ts` applied a soft spring damper ($F_x = -v_\text{long} \cdot 1200$) instead of a rigid mechanical lock, allowing micro-slip and creep down slopes. Furthermore, releasing the analog brake trigger at zero speed cut all brake torque, allowing immediate rollback.

2. **Inverted Stick Usability Expectation (Look Left / Drive Right):**
   - Standard twin-stick controls placed steering and throttle on the left stick (`axes[0]`, `axes[1]`) and camera pitch/yaw on the right stick (`axes[2]`, `axes[3]`).
   - Many pilots (particularly handheld and RC/flight-accustomed operators) require **Drive with Right Stick (Steering X, Throttle Y) and Look with Left Stick (Yaw X, Pitch Y)**.
   - Crucially, `ClientApp.ts` contained a legacy fallback hack (`const steerInput = frame.strafe !== 0 ? frame.strafe : frame.yaw;`), which caused camera yaw commands to bleed directly into vehicle steering whenever the pilot attempted to look around without touching the steering axis.

Spec 20 resolves both defects with an automatic powertrain hill-hold system, coast deceleration, zero-drift wheel lock, and a configurable dual-stick mapping architecture supporting Drive-Right / Look-Left.

---

## 2. Functional Requirements & Specifications

### 2.1 Buggy Powertrain Hill-Hold & Zero-Drift Braking (`TraversalPhysics.ts`)

1. **Automatic Coast-Down Deceleration (Off-Throttle Regen):**
   - When throttle demand is zero ($|\text{throttle}| \le 0.05$) and the buggy is moving ($|v_\text{long}| > 0.35\,\text{m/s}$):
     - Engage automatic powertrain regenerative coast-down braking ($1,800\,\text{N}$ retarding force).
     - In vacuum lunar conditions, this decelerates a coasting buggy from cruise ($10\,\text{m/s}$) to standstill smoothly within $\approx 4\,\text{s}$ rather than rolling indefinitely for minutes.

2. **Robust `STOPPED` State Latch:**
   - Transition `driveMode` from `FORWARD` or `REVERSE` to `STOPPED` when:
     $$|v_\text{long}| \le 0.35\,\text{m/s} \quad \text{AND} \quad |\text{rawThrottle}| \le 0.05$$
     OR whenever the vehicle decelerates to zero speed under active service brake.

3. **Active Hill-Hold & Slope Counter-Torque:**
   - When `driveMode === 'STOPPED'` and throttle is neutral ($|\text{rawThrottle}| \le 0.05$):
     - Engage automatic hill-hold (`parkSlipLock = true`).
     - Cancel out slope gravity components ($g_\text{long}$, $g_\text{lat}$) at the tyre contact patches up to the static friction limit of regolith ($\approx 30^\circ$ slope angle).
     - Hard-clamp velocities and yaw rate:
       $$v_\text{long} = 0, \quad v_\text{lat} = 0, \quad \omega_z = 0$$
     - Ensure position integration ($s.x, s.y, s.z$) accumulates **zero** displacement frame-over-frame while parked.

4. **Smooth Hill-Hold Drive-Away:**
   - The moment driver throttle demand exceeds $|\text{rawThrottle}| > 0.05$:
     - Release hill-hold seamlessly.
     - Hand full torque authority back to the electric motors with anti-jerk ramping, preventing abrupt rollback or torque snap on uphill starts.

---

### 2.2 Dual-Stick Decoupled Input Layout (`ClientApp.ts`)

1. **Stick Layout Modes (`GamepadStickLayout`):**
   - Support two explicit layouts:
     - `'drive_right_look_left'` (User Default):
       - **Left Stick X (`axes[0]`):** Look Yaw (Camera rotate left/right, deadband 0.15, gamma 1.5).
       - **Left Stick Y (`axes[1]`):** Look Pitch (Camera tilt up/down, deadband 0.15, gamma 1.5).
       - **Right Stick X (`axes[2]`):** Steer (Steering left/right, deadband 0.12, gamma 1.6).
       - **Right Stick Y (`axes[3]`):** Throttle / Reverse (Stick up = forward, stick down = reverse, deadband 0.15).
     - `'standard'` (Classic twin-stick):
       - **Left Stick X/Y (`axes[0]`, `axes[1]`):** Steer & Throttle.
       - **Right Stick X/Y (`axes[2]`, `axes[3]`):** Look Yaw & Pitch.
   - Persist user preference in `localStorage` under `lunar_stick_layout`.
   - Provide hotkey toggle `[J]` (and gamepad combo `L3 + R3`) to switch between layouts at runtime, displaying a HUD toast confirmation (`"Controls: Drive Right / Look Left"` vs `"Controls: Standard Twin-Stick"`).

2. **Strict Channel Decoupling:**
   - Eliminate `steerInput = frame.strafe !== 0 ? frame.strafe : frame.yaw`.
   - In vehicle mode:
     - Steering is driven strictly by the designated steering channel (`frame.strafe`).
     - Camera yaw is driven strictly by the look channel (`frame.yaw`).
     - Looking around while driving never imparts lateral force, torque, or steering deflection to the front wheels.

3. **Trigger Coexistence:**
   - Analog triggers (RT throttle, LT brake / brake-to-reverse) remain fully functional in both stick layouts:
     - Drivers can choose between stick throttle (Right Stick Y) or trigger pedals (RT/LT) with zero conflict.
     - If both stick throttle and RT are applied, take the maximal intentional forward demand.

4. **EVA Mode Alignment:**
   - When on foot in EVA suit:
     - Left Stick controls head/camera look (`yaw`, `pitch`).
     - Right Stick controls suit traversal locomotion (`forward`, `strafe`).
     - Maintains muscle-memory consistency between buggy and foot traversal.

---

### 2.3 HUD Telemetry & User Feedback (`LunarHUD.ts`, `hud.css`)

1. **Hill-Hold / Park Indicator:**
   - In the buggy dashboard HUD panel, display an active `[HOLD]` / `PARK` telemetry indicator when automatic hill-hold is engaged.
2. **Stick Layout Badge:**
   - In the controls hint overlay, reflect current stick configuration:
     - `L-Stick: Look | R-Stick: Drive` or `L-Stick: Drive | R-Stick: Look`.
3. **HUD Toast Notification:**
   - Display toast on mode toggle: `"Stick Layout: Drive Right / Look Left (Engaged)"`.

---

## 3. Implementation Plan & Phased Subtasks

### Phase 1: Powertrain Hill-Hold & Zero-Drift Mechanics (`TraversalPhysics.ts`)
- Implement coast-down regenerative torque when throttle is neutral.
- Upgrade `driveMode` state transition to latch `STOPPED` at $|v_\text{long}| \le 0.35\,\text{m/s}$.
- Implement rigid hill-hold clamp against slope gravity in `substep()`.
- Add unit assertions for zero drift on $10^\circ$ lunar slopes over 10 seconds of simulated time.

### Phase 2: Dual-Stick Decoupled Layout Architecture (`ClientApp.ts`)
- Add `GamepadStickLayout` type and state (`'drive_right_look_left' | 'standard'`).
- Map axes according to layout mode with proper deadzones and exponential curves.
- Decouple `frame.strafe` and `frame.yaw` in `stepEntities()`.
- Ensure DirectInput trigger calibration (`calibratePadTriggers`) respects right-stick driving axes.
- Add `[J]` hotkey and `L3 + R3` chord for layout toggling, with `localStorage` persistence.

### Phase 3: HUD Visuals & Controls Sheet Integration (`LunarHUD.ts`, `hud.css`)
- Add `[HOLD]` dashboard indicator in buggy telemetry panel.
- Update gamepad legend sheet to reflect active stick layout.
- Hook layout toggle to HUD toast notifications.

### Phase 4: Headless Smoke Verification Suite
- Extend `scripts/smoke-open-buggy.ts` with slope-drift hold tests (verifying $< 0.001\,\text{m}$ motion on slope after throttle release).
- Extend `scripts/smoke-client-app.ts` to test both stick layout modes and verify camera/steering decoupling.
- Run `verify-driving-sim.ts` and production build `npm run build` to ensure zero regressions across existing driving gates.

---

## 4. Acceptance Criteria & Verification Gates

1. **Zero-Drift Hill-Hold Gate:**
   - Accelerate buggy to $10\,\text{m/s}$ on a $5^\circ$ lunar slope, then release all inputs.
   - Buggy must decelerate to a complete stop and remain at $\Delta x, \Delta y < 0.005\,\text{m}$ indefinitely without creeping.
2. **Decoupled Dual-Stick Gate:**
   - Deflecting Left Stick X/Y in buggy mode rotates camera yaw and pitch without altering buggy heading, steering angle, or velocity.
   - Deflecting Right Stick X/Y turns buggy front wheels and accelerates/reverses vehicle without rotating camera relative to vehicle.
3. **Regression Safety:**
   - All 66 checks in `verify-driving-sim.ts` pass.
   - All checks in `smoke-client-app.ts` pass.
   - `npm run build` produces clean bundle with 0 errors.
