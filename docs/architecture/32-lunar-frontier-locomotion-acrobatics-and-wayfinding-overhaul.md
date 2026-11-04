# Architecture Blueprint 32: Lunar Frontier Locomotion Acrobatics, True 3D Rover Ballistics & Nav System

## 1. Context & Architectural Overview

Following the rollout of Spec 31 (Olympic triple-jump mid-air cycling and hydraulic assist boots), player feedback identified six systemic and physical limitations:
1. **Inverted Elbow Articulation:** Elbow flexion in `AstronautSuit.ts` evaluated to positive radians, swinging the forearm toward $-Z$ (rearward/aft) in Babylon.js's left-handed coordinate system, creating avian/flamingo-like backward bends in behind-the-avatar chase cameras.
2. **Absence of Mid-Air Acrobatic Agility:** During low-gravity flight arcs ($\tau \approx 1.9\,\text{s}$), the suited astronaut could not perform gymnastic rolls or somersaults.
3. **Absence of Tactical PLSS Compressed-Air Boost:** Lack of RCS cold-gas thruster authority to arrest falls or extend bounds, and lack of metabolic oxygen cost mechanics.
4. **Inverted Compass Heading:** Compass tape azimuth calculation subtracted physics heading (`90 - θ`), causing clockwise right-turns from West ($270^\circ$) to falsely register as counter-clockwise turns toward South ($180^\circ$).
5. **Rover Terrain Clamping & Missing Crater Hangtime:** `LunarBuggy.step()` pinned $s.z$ directly to ground elevation at the vehicle center on every frame, eliminating crater lip launches, berm jumping, and causing front-bumper ground clipping on steep approaches.
6. **Missing POI Nav System:** Inability to locate or track major installations (X-Corp Citadel, Radio Tower, Mass Accelerator) on the HUD.

Blueprint 32 rectifies these domains through unified kinematic, ballistic, and navigation contracts.

```mermaid
graph TD
    subgraph Input Dispatch [ClientApp.ts]
        In_Move[WASD / Left Stick] --> In_Dispatch{State?}
        In_Jump[Jump / Space / A] --> In_Dispatch
        In_Crouch[Crouch / Roll / C / B] --> In_Dispatch
        In_Nav[setNavTarget CLI / Query] --> In_Dispatch
    end

    subgraph Biomechanical Locomotion [AstronautSuit.ts]
        In_Dispatch -->|Airborne + Crouch| AS_Tuck[Acrobatic Tuck & 360° Flip]
        AS_Tuck --> AS_Angles[Torso: 0.85 rad, Hips: -1.25 rad, Knees: 1.85 rad]
        AS_Tuck --> AS_Roll[Mesh 360° Pitch Rotation over u in 0.1..0.9]
        In_Dispatch -->|Locomotion Cycles| AS_Elbows[Forward-Flexing Anatomical Elbows]
        AS_Elbows --> AS_Sign[Enforce theta < 0 for vis-forward flexion]
    end

    subgraph Traversal Physics & PLSS [TraversalPhysics.ts]
        In_Dispatch -->|Airborne + Jump| TP_Boost[Pneumatic RCS Jump Boost]
        TP_Boost -->|az = +2.8 m/s², afwd = +1.5 m/s²| TP_Ballistics[Ballistic Flight Integrator]
        TP_Boost -->|O2 Draw: 12.0 units/s| TP_O2[Metabolic Oxygen Reserve]
        TP_Ballistics --> TP_Vapor[Twin PLSS Backpack Exhaust Jets]
    end

    subgraph 3D Rover Dynamics [TraversalPhysics.ts & OpenBuggy.ts]
        In_Dispatch -->|Drive off Berm / Crater| RB_Heave[Untethered Ballistic Vertical Heave]
        RB_Heave -->|vz += (Fn - mg)/m * dt| RB_Int[Integrate s.z ballistically]
        RB_Int --> RB_FloorCheck{s.z < z_floor?}
        RB_FloorCheck -->|Yes: Touchdown| RB_Clamp[s.z = z_floor, vz = max 0, vz]
        RB_FloorCheck -->|No: Airborne| RB_Airborne[Catch Air: s.z > z_floor + 0.5m]
        RB_Airborne --> OB_Droop[Road Wheels Suspend at Max Droop]
    end

    subgraph Wayfinding & Telemetry [ClientApp.ts & LunarHUD.ts]
        In_Dispatch -->|Heading theta| HUD_Tape[Clockwise Compass Tape: 90 + theta]
        In_Nav --> HUD_POI[POI Registry & Fuzzy Selector]
        HUD_POI -->|Target Vector| HUD_Pin[Persistent Gold Chevron Pin & Distance]
    end
```

---

## 2. Mathematical Formulations & Physical Laws

### 2.1 Forward-Flexing Anatomical Elbow Kinematics (`AstronautSuit.ts`)

In Babylon.js (Y-up, X-right, Z-forward), a hanging limb along $-Y$ undergoing local pitch rotation $R_x(\theta)$ yields:
$$y' = -h \cos(\theta), \quad z' = -h \sin(\theta)$$
To displace the forearm forward toward $+Z$ (toward visor and chest), $\sin(\theta) < 0 \implies \theta < 0$.
The canonical resting, pumping, and climbing angles are:
- `ELBOW_REST_RAD = -0.18` (natural relaxed forward bend).
- `HURRY_ARM_ELBOW_FWD_FLEX_RAD = -0.50` (anterior drive flexion).
- `HURRY_ARM_ELBOW_AFT_FLEX_RAD = -0.25` (posterior swing relief).
- `HURRY_PUMP_ELBOW_STANCE_RAD = -0.50`.
- `HURRY_PUMP_ELBOW_RECOVERY_RAD = -0.40`.
- `CLIMB_ELBOW_FLEX_RAD = -0.85` (ladder rung hold flexion).
- `CLIMB_REACH_ELBOW_RELIEF_RAD = -0.20`.

### 2.2 Mid-Air Acrobatic Tuck & Roll Cycle (`AstronautSuit.ts`)

When airborne in bounding gait (`!s.isGrounded && s.gaitMode === 'bounding'`):
1. **Trigger Condition:** Crouch/Roll key/button active while aloft.
2. **Kinematic Tuck Envelope:**
   - Torso forward pitch: $\theta_\text{torso} = 0.85\,\text{rad}$.
   - Bilateral hip flexion: $\theta_\text{hip,L} = \theta_\text{hip,R} = -1.25\,\text{rad}$.
   - Bilateral knee flexion: $\theta_\text{knee,L} = \theta_\text{knee,R} = 1.85\,\text{rad}$.
   - Bilateral elbow flexion: $\theta_\text{elbow,L} = \theta_\text{elbow,R} = -1.40\,\text{rad}$.
3. **Continuous Rotational Somersault:**
   - Over flight arc $u \in [0.10, 0.90]$, avatar root mesh pitches forward by a full revolution:
     $$\Delta \theta_\text{flip}(u) = 2\pi \cdot \left(\frac{u - 0.10}{0.80}\right)$$
   - At $u \ge 0.90$, limbs smoothly interpolate back into Phase C pre-landing touchdown posture.

### 2.3 PLSS Compressed-Air Boost & Oxygen Depletion (`TraversalPhysics.ts`)

1. **Airborne Boost Integration:**
   When `!s.isGrounded` and `input.jump` is held:
   $$v_z \mathrel{+}= a_{z,\text{rcs}} \cdot \Delta t \quad (a_{z,\text{rcs}} = 2.8\,\text{m/s}^2)$$
   $$v_\text{fwd} \mathrel{+}= a_{\text{fwd},\text{rcs}} \cdot \Delta t \quad (a_{\text{fwd},\text{rcs}} = 1.5\,\text{m/s}^2)$$
2. **Oxygen Draw:**
   $$\Delta \text{O}_2 = \text{SUIT\_O2\_RCS\_BOOST} \cdot \Delta t = 12.0\,\text{units/s} \cdot \Delta t$$
   If $\text{O}_2 \le 0$, pneumatic thrusters cut out, falling back to unassisted ballistics.

### 2.4 Clockwise Compass Azimuth & Bearing Rectification (`ClientApp.ts`)

1. **Azimuth Mapping:**
   With world $+X$ East, $+Y$ South, and heading $\theta$ increasing clockwise:
   $$\text{headingDeg} = \text{wrap360}\left(90 + \frac{\theta \cdot 180}{\pi}\right)$$
   - West ($\theta = \pi$): $90 + 180 = 270^\circ$ (W).
   - Turning Right Clockwise ($\theta \to 3\pi/2$): $90 + 270 = 360^\circ / 0^\circ$ (N).
   - East ($\theta = 2\pi$): $90 + 360 = 90^\circ$ (E).
2. **POI Bearing Calculation:**
   For player position $\vec{P} = (x_1, y_1)$ and target $\vec{T} = (x_2, y_2)$:
   $$\theta_\text{target} = \text{atan2}(y_2 - y_1, x_2 - x_1)$$
   $$\text{bearingDeg} = \text{wrap360}\left(90 + \frac{\theta_\text{target} \cdot 180}{\pi}\right)$$

### 2.5 True 3D Rover Ballistics & Crater Lips (`TraversalPhysics.ts`, `OpenBuggy.ts`)

1. **Untethered Vertical Integration:**
   $$s.v_\text{body} \mathrel{+}= \left(\frac{\sum F_{z,i} - m \cdot g}{m}\right) \cdot \Delta t$$
   $$s.z \mathrel{+}= s.v_\text{body} \cdot \Delta t$$
2. **Inequality Terrain Restitution:**
   Let $z_\text{floor} = \text{ground}(s.x, s.y)$.
   $$\text{if } s.z < z_\text{floor}: \quad s.z = z_\text{floor}, \quad s.v_\text{body} = \max(0, s.v_\text{body})$$
   When launching over berms or crater rims, $s.z$ ascends ballistically with $s.z > z_\text{floor} + 0.5\,\text{m}$, catching genuine airtime.

---

## 3. Authoritative POI Directory

| Identifier | Landmark Name | Coordinates $(x, y)$ | Description |
| :--- | :--- | :--- | :--- |
| `citadel` | X-Corp Citadel Monolith | $(-1850, 2400)$ | Megastructure headquarters, kinetic shield grid, high-speed rail terminal |
| `tower` | Frontier Radio Tower | $(-1550, 2320)$ | 52m titanium communications relay mast with ladder & observation deck |
| `accelerator` | Mare Mass Accelerator | $(-320, -1450)$ | 180m electromagnetic coilgun & contraband export console |
| `touchdown` | Touchdown Alpha | $(0, 0)$ | Transport lander arrival and disembarkation site |
| `outpost` | Canyon Extraction Outpost | $(-920, 1150)$ | Remote mineral processing hub & derelict station |

---

## 4. Architectural Decision Records (ADRs)

### ADR 1: Local Sign Inversion for Forward Elbow Flexion
- **Decision:** Enforce negative signs ($\theta < 0$) on all elbow pitch rotations in `AstronautSuit.ts`.
- **Rationale:** Babylon.js's coordinate system orients local $+X$ rotation backward for upper arms hanging along $-Y$. Avian elbow hyperextension broke visual immersion in chase cameras; negative angles swing the forearms toward $+Z$ (forward).

### ADR 2: Metabolic Oxygen Tradeoff for Tactical RCS Thrusters
- **Decision:** RCS airborne boosts draw directly from the player's life support oxygen at $12.0\,\text{units/s}$.
- **Rationale:** Prevents infinite jetpack flying and introduces high-stakes tactical decision-making during crater leaps and falls.

### ADR 3: Additive Clockwise Compass Transformation
- **Decision:** Transform physics yaw to compass azimuth via $\text{wrap360}(90 + \theta)$ instead of subtracting $\theta$.
- **Rationale:** Subtracting yaw caused right turns to rotate counter-clockwise (West $\to$ South). The additive transform preserves nautical compass clockwise standards.

### ADR 4: Inequality Terrain Restitution Over Equality Clamping
- **Decision:** Replace $s.z = \text{ground}(s.x, s.y)$ with continuous vertical velocity integration $s.z \mathrel{+}= s.v_\text{body} \cdot \Delta t$ and inequality floor clamping $s.z \ge z_\text{floor}$.
- **Rationale:** Equality clamping prevented rovers from catching airtime off crater crests and caused front-end clipping on steep inclines.

---

## 💡 Note to Future Self: Hosting Portability

All ballistic calculations, kinematic envelopes, and navigation trigonometry operate purely in analytical mathematics without DOM, WebGL, or Canvas dependencies. This design enables the identical traversal and vehicle simulation engine to run deterministically on headless servers (`NullEngine`, Fastify server authoritative tick) and client browsers.
