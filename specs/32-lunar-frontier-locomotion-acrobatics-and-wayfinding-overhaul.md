# Spec 32: Lunar Frontier Locomotion Acrobatics, True 3D Rover Ballistics & Nav System

## 1. Executive Summary & Problem Statement

Following the rollout of Spec 31 (Olympic triple-jump mid-air cycling and hydraulic assist boots), player feedback identified six critical operational, kinematic, and systemic issues that impair gameplay, navigation, and physical plausibility:

1. **Inverted Elbow Articulation in Third-Person Camera:**
   - In `AstronautSuit.ts`, elbow flexion was authored with positive rotation values (e.g. `ELBOW_REST_RAD = +0.18`, `HURRY_ARM_ELBOW_FWD_FLEX_RAD = +0.5`).
   - In Babylon.js's left-handed coordinate system (Y-up, X-right, Z-forward), a positive rotation around local X swings a hanging forearm toward negative Z (aft / rearward).
   - From the standard third-person behind-the-avatar chase camera, the astronaut's elbows visibly bent backward like avian/flamingo joints instead of human arms.

2. **Absence of Mid-Air Acrobatic Agility (Tuck & Flip):**
   - While airborne during a low-gravity ballistic bound ($\tau \approx 1.9\,\text{s}$), the player cannot perform acrobatic rotational maneuvers.
   - Players want an intuitive mechanism to tuck their limbs and perform a forward gymnastic somersault/flip while sailing through lunar vacuum.

3. **Absence of Tactical PLSS Compressed-Air Boost:**
   - In emergency situations or to extend a ballistic leap, astronauts require a burst of RCS cold-gas thruster authority from their backpack.
   - This boost must provide controlled upward and forward thrust, but at a tangible metabolic cost: tapping into the accessible breathing oxygen supply, restricting it to tactical short bursts.

4. **Inverted Compass Heading on the HUD Tape:**
   - When driving the rover or running on foot, heading west ($270^\circ$) and turning right produces a reading of $225^\circ$ (SW) and then $180^\circ$ (South).
   - On a real compass, turning right from West is a clockwise rotation toward North ($315^\circ\,\text{NW} \to 360^\circ/0^\circ\,\text{N}$).
   - Root Cause: `ClientApp.ts` computed `headingDeg = wrap360(90 - headingRad * 180 / Math.PI)`. Because physics yaw increases clockwise in this frame, subtracting it caused the compass tape to rotate counter-clockwise.

5. **Rover Ground Clipping & Inability to Catch Air on Crater Lips:**
   - In `TraversalPhysics.ts`, `LunarBuggy.step()` pinned the buggy's world elevation $s.z$ directly to `this.ground(s.x, s.y)` on every frame.
   - When driving up the steep interior lip of a crater, sampling only at $(s.x, s.y)$ caused the front nose and suspension to plunge through the crest before the center reached the peak.
   - Furthermore, because $s.z$ was statically clamped to the terrain, driving off a crater rim or berm caused the rover to instantly snap down to the crater floor without any ballistic hangtime, preventing players from jumping craters.

6. **Missing POI Nav System & Corporate HQ Discovery:**
   - Players struggle to locate key planetary installations (notably the X-Corp Citadel monolith at $(-1850, 2400)$, the Frontier Radio Tower at $(-1550, 2320)$, and the Mare Mass Accelerator at $(-320, -1450)$).
   - The game lacks an on-demand POI targeting and waypoint selection interface on the HUD compass tape.

---

## 2. Architectural Contracts & Mathematical Formulations

```
                          [ ClientApp.ts ]
                 (Input Dispatch & Command Routing)
                   │                       │
      ┌────────────┴────────────┐          └─────────────┐
      ▼                         ▼                        ▼
[ TraversalPhysics.ts ]   [ AstronautSuit.ts ]     [ LunarHUD.ts ]
• 3D Ballistic Rover z    • Forward-Flex Elbows   • Clockwise Tape (90+θ)
• True Crater Hangtime    • Mid-Air Tuck & Flip   • POI Target Selector
• PLSS RCS O2 Draw        • Dual PLSS Gas Jets    • Persistent Gold Pin
```

---

### 2.1 Forward-Flexing Anatomical Elbow Kinematics (`AstronautSuit.ts`)

In Babylon.js, with the upper arm hanging along $-Y$, the elbow joint rotation matrix $R_x(\theta)$ produces forearm displacement:
$$y' = -h \cos(\theta), \quad z' = -h \sin(\theta)$$
To produce forward flexion ($z' > 0$ toward the visor/chest):
$$\theta < 0$$
All elbow rotation constants and pose generators must enforce negative signs:
- `ELBOW_REST_RAD = -0.18` (relaxed forward hang).
- `HURRY_ARM_ELBOW_FWD_FLEX_RAD = -0.50` (flexion on forward drive).
- `HURRY_ARM_ELBOW_AFT_FLEX_RAD = -0.25` (flexion on rear swing).
- `HURRY_PUMP_ELBOW_STANCE_RAD = -0.50`.
- `HURRY_PUMP_ELBOW_RECOVERY_RAD = -0.40`.

---

### 2.2 Mid-Air Acrobatic Tuck-and-Flip Cycle (`AstronautSuit.ts`, `TraversalPhysics.ts`)

When airborne in the bounding gait (`!s.isGrounded && s.gaitMode === 'bounding'`):
1. **Trigger Condition:** Player presses or holds Crouch/Roll (`[KeyC]` / `[ControlLeft]` / Gamepad `[B]` or `[LB]` while airborne).
2. **Kinematic Tuck Envelope:**
   - Torso pitches forward aggressively: $\theta_\text{torso} \to 0.85\,\text{rad}$.
   - Bilateral hip flexion: $\theta_\text{hip,L} = \theta_\text{hip,R} = -1.25\,\text{rad}$ (knees pulled up tight to chest).
   - Bilateral knee flexion: $\theta_\text{knee,L} = \theta_\text{knee,R} = 1.85\,\text{rad}$ (shins folded against hamstrings).
   - Bilateral elbow flexion: $\theta_\text{elbow,L} = \theta_\text{elbow,R} = -1.40\,\text{rad}$ (arms tucked around shins).
3. **Full Rotational Flip:**
   - Over the flight arc $u \in [0.1, 0.9]$, the avatar root mesh executes a continuous $360^\circ$ pitch rotation:
     $$\Delta \theta_\text{flip} = 2\pi \cdot \left(\frac{u - 0.1}{0.8}\right)$$
   - At $u \ge 0.90$, the avatar uncurls smoothly back into the Phase C pre-landing claw pose to absorb touchdown shock.

---

### 2.3 Compressed-Air RCS Jump Boost & Metabolic O2 Depletion (`TraversalPhysics.ts`, `ClientApp.ts`)

1. **Trigger Condition:** Hitting Jump (`[Space]` / Gamepad `[A]`) while airborne (`!s.isGrounded`).
2. **Pneumatic Impulse:**
   - Applies an upward vertical acceleration $a_z = 2.8\,\text{m/s}^2$ and forward boost $a_\text{fwd} = 1.5\,\text{m/s}^2$.
   - Arrests excessive descent rate ($v_z < 0$) to cushion high-altitude drops.
3. **Breathing Oxygen Depletion:**
   - The PLSS cold-gas thrusters draw directly from the high-pressure oxygen reservoir.
   - Depletion rate: $\Delta \text{O}_2 = 12.0\,\text{units/s}$ (active burst consumes $\approx 3\%\text{--}5\%$ of total tank per second).
   - Triggers twin high-pressure gas vapor plume particle emitters at the backpack upper exhaust ports.
   - Fires procedural acoustic cold-gas thruster burst in `LunarAudioSystem.ts`.

---

### 2.4 Clockwise Compass Tape & Wayfinding Angle Rectification (`ClientApp.ts`, `LunarHUD.ts`)

1. **Azimuth Transformation:**
   To align with the world coordinate frame ($+X$ East, $+Y$ South, $-Y$ North in Babylon $Z$-forward):
   $$\text{headingDeg} = \text{wrap360}\left(90 + \frac{\theta_\text{heading} \cdot 180}{\pi}\right)$$
   - West ($\theta = \pi$): $90 + 180 = 270^\circ$ (W).
   - Turning Right (Clockwise, $\theta \to 3\pi/2$): $90 + 270 = 360^\circ / 0^\circ$ (N).
   - Turning Right toward East ($\theta \to 2\pi$): $90 + 360 = 90^\circ$ (E).
2. **Compass Bearing Formula:**
   For any target from $(x_1, y_1)$ to $(x_2, y_2)$:
   $$\theta_\text{bearing} = \text{atan2}(y_2 - y_1, x_2 - x_1)$$
   $$\text{bearingDeg} = \text{wrap360}\left(90 + \frac{\theta_\text{bearing} \cdot 180}{\pi}\right)$$

---

### 2.5 True 3D Rover Ballistics & Low-G Crater Launch Kinematics (`TraversalPhysics.ts`, `OpenBuggy.ts`)

1. **Untethered Vertical Heave:**
   The buggy's vertical elevation $s.z$ must not be hardcoded to `ground(x, y)`. Instead:
   $$s.v_\text{body} \mathrel{+}= \left(\frac{\sum F_{z,i} - m \cdot g}{m}\right) \cdot \Delta t$$
   $$s.z \mathrel{+}= s.v_\text{body} \cdot \Delta t$$
2. **Ground Contact & Rigid Floor Restitution:**
   Let $z_\text{floor} = \text{ground}(s.x, s.y)$.
   - When all four suspension springs are uncompressed ($x_i \le -0.25\,\text{m}$), $\sum F_{z,i} = 0$. The rover is in free ballistic flight under lunar gravity ($g = 1.62\,\text{m/s}^2$).
   - Rigid terrain barrier: if $s.z < z_\text{floor}$, enforce ground collision:
     $$s.z = z_\text{floor}, \quad s.v_\text{body} = \max(0, s.v_\text{body})$$
3. **Visual Wheel Suspension Decoupling (`OpenBuggy.ts`):**
   - In `OpenBuggy.ts`, `root.position.y` reflects the true world elevation $s.z$.
   - Road wheels are anchored to the chassis body and hang at maximum droop travel when airborne, rather than projecting from the terrain floor below.

---

### 2.6 POI Navigation Directory & HUD Target Pinning (`ClientApp.ts`, `LunarHUD.ts`)

1. **Authoritative POI Directory:**
   - **X-Corp Citadel Monolith (Evil Space Corp HQ):** $(-1850, 2400)$
   - **Frontier Radio Tower ("Relay 04"):** $(-1550, 2320)$
   - **Mare Mass Accelerator ("The Gauss Needle"):** $(-320, -1450)$
   - **Touchdown Alpha (Lander Landing Site):** $(0, 0)$
   - **Canyon Extraction Outpost:** $(-920, 1150)$
2. **Text / Console Selection:**
   - Expose `setNavTarget(nameOrQuery: string)` in `ClientApp.ts`.
   - Fuzzy match against POI directory (e.g. "citadel", "corp", "hq", "tower", "radio", "mass accelerator", "gauss").
3. **HUD Compass Pin:**
   - Renders a prominent persistent gold navigation chevron `▼ [TARGET_NAME]` on the top-centre compass tape with real-time distance in metres and bearing arrow indicators (`◀`, `▲`, `▶`).

---

## 3. Phased Implementation Breakdown

### Phase 1: Architectural Blueprint, Symbol Map Registration & Task Queue
- Author `docs/architecture/32-lunar-frontier-locomotion-acrobatics-and-wayfinding-overhaul.md`.
- Register Spec 32 in `docs/MAP.md`.
- Enroll `[TASK-PLAY-079]` with subtasks `a` through `f` on `/home/jagosan/obsidian/vault/boards/Kanban-Playground.md`.
- Register `SPEC-PLAY-032` in `/home/jagosan/obsidian/vault/boards/Kanban-Spec-Queue.md`.

### Phase 2: Forward-Flexing Elbow Kinematics & Acrobatics (`AstronautSuit.ts`)
- Invert elbow pivot rotation signs across `AstronautSuit.ts`.
- Implement `acrobaticTuckPose(u)` and $360^\circ$ pitch roll rotation logic.

### Phase 3: PLSS Pneumatic Boost & Oxygen Drain (`TraversalPhysics.ts`, `ClientApp.ts`)
- Wire mid-air `jump` input to vertical/forward RCS impulse.
- Add oxygen depletion rate and backpack dual-exhaust gas particle emitters.

### Phase 4: Clockwise Compass & POI Navigation Engine (`ClientApp.ts`, `LunarHUD.ts`)
- Rectify compass tape azimuth transform to `wrap360(90 + heading)`.
- Register landmark database and implement target search and persistent compass pin rendering.

### Phase 5: True 3D Rover Ballistics & Crater Lip Leaps (`TraversalPhysics.ts`, `OpenBuggy.ts`)
- Decouple rover $s.z$ from ground clamping; integrate ballistic heave and crater launches.
- Decouple visual wheels in `OpenBuggy.ts` to suspend from the airborne chassis.

### Phase 6: Headless Smoke Verification Suite & Build Gate (`smoke-acrobatics-nav-ballistics.ts`)
- Author `scripts/smoke-acrobatics-nav-ballistics.ts` verifying:
  - Elbow flexion angles are negative (forward).
  - Compass rotates clockwise when turning right.
  - Rover catches air ($s.z - \text{ground} > 1.0\,\text{m}$) when launching off berms.
  - O2 decreases when firing airborne RCS boost.
- Run `npm run build` and pass all contract gates.

---

## 4. Acceptance Criteria & Contract Gates

- [ ] **Gate 1: Forward Anatomical Elbow Flexion:**
  - All elbow angles in resting, pumping, and climbing poses evaluate to negative radians ($z' > 0$).
  - Zero backward hyperextension from behind-the-avatar camera view.
- [ ] **Gate 2: Mid-Air Acrobatic Tuck & Flip:**
  - Airborne sprint/crouch engages bilateral hip/knee tuck ($>1.2\,\text{rad}$) and $360^\circ$ forward somersault.
- [ ] **Gate 3: PLSS Cold-Gas Jump Boost & Oxygen Consumption:**
  - Mid-air jump pulses vertical thrusters and consumes oxygen at $\ge 10\,\text{units/s}$.
- [ ] **Gate 4: Real-Clockwise Compass Navigation:**
  - Turning right from West ($270^\circ$) transitions to NW ($315^\circ$) and North ($0^\circ$).
  - Target pins for X-Corp Citadel $(-1850, 2400)$ and Radio Tower $(-1550, 2320)$ point accurately.
- [ ] **Gate 5: Untethered Rover Ballistics & Crater Jumping:**
  - Buggy launched up a $25^\circ$ crater lip becomes airborne with $s.z > z_\text{floor} + 0.5\,\text{m}$.
  - Driving off crater rims preserves horizontal momentum while dropping ballistically.
  - Zero chassis clipping through ground on steep approach slopes.
- [ ] **Gate 6: Headless Smoke Suite & Production Build:**
  - 100% pass on `scripts/smoke-acrobatics-nav-ballistics.ts`.
  - Clean `npm run build` with zero TypeScript errors.
