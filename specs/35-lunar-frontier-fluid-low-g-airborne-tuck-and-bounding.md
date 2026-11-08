# Spec 35: Lunar Frontier — Fluid Low-G Airborne Leg Tuck & Kinematic Bounding Rectification

> **Target Systems:** `games/lunar-frontier/src/entities/AstronautSuit.ts`, `games/lunar-frontier/src/physics/TraversalPhysics.ts`, `games/lunar-frontier/src/client/ClientApp.ts`, `games/lunar-frontier/src/ui/LunarHUD.ts`, `games/lunar-frontier/src/audio/LunarAudioSystem.ts`.  
> **Platforms:** WebGL2/WebGPU Desktop (Chrome/Firefox/Brave), Mobile Touch (PWA landscape), Gamepad (Linux XInput/Steam Deck).  
> **Preceding Specs:** Spec 28 (FTUE EVA Mechanics), Spec 30 (Stormtrooper Suit & Bounding), Spec 31 (Olympic Triple-Jump Cycling), Spec 32 (Elbow Sign Laws & Locomotion Acrobatics), Spec 33/34 (Mobile Controls & Dual-Sticks).  
> **Verification Suite:** `games/lunar-frontier/scripts/smoke-spec35-airborne-tuck.ts` (100% headless under `NullEngine`).

---

## 1. Executive Summary & Problem Statement

In Spec 32 §2.2, an acrobatic maneuver was introduced during low-G bounding flight arcs ($\tau_\text{flight} \approx 1.5\text{--}2.2\,\text{s}$). While airborne, pressing Crouch/Roll triggered an extra 360° pitch rotation on the avatar root mesh (`pose.flipPitchRad = 2π · (u - 0.1)/0.8`).

### Critical Playability & Kinematic Deficiencies
1. **Unnatural Full-Body Root Spinning (Terrible Aesthetic):**
   - In third-person chase camera, watching an armored astronaut somersault 360° through the air looked comical, rigid, and disconnected from low-G physics. The camera struggled to maintain smooth horizon stabilization while the root spun, inducing visual jitter.
2. **Missing Anatomical Fluidity:**
   - Rather than rolling the entire body in a somersault, real low-G athletic maneuvering and freefall acrobatics (such as astronauts aboard Skylab or freestyle skiers) involve an upright torso with **fluid bilateral folding of the lower limbs up into the torso/pelvis**—forming a compact, aerodynamic posture before extending back into a landing stride.
3. **Discontinuous Landing Transitions:**
   - When the 360° somersault completed, the avatar popped abruptly back to the running pose if ground contact occurred slightly off-nominal, producing visual hitching.

### The Rectified Architectural Solution
Spec 35 completely removes the 360° root mesh pitch somersault (`flipPitchRad = 0`) and replaces it with the **Fluid Low-G Airborne Leg Tuck**:
- **Torso Stability:** The avatar root mesh remains upright, aligned with flight velocity and applying a stable forward flight rake angle ($\theta_\text{rake} \approx 8^\circ\text{--}12^\circ$). The head/visor tracks forward toward the descent horizon.
- **Single Fluid Leg Fold:** Upon tuck input while airborne, both legs smoothly fold up into the pelvis/torso in a single synchronized kinematic envelope:
  - Bilateral hips flex smoothly upward: $\theta_\text{hip} \to -1.20\,\text{rad}$ (knees pulled up tight to the lower chest).
  - Bilateral knees fold tightly: $\theta_\text{knee} \to +1.80\,\text{rad}$ (shins folded cleanly against hamstrings).
  - Ankle boots tuck neatly beneath the pelvic datum ($\Delta y_\text{boot} \approx +0.42\,\text{m}$).
  - Forearms and elbows tuck compactly around the knees ($\theta_\text{elbow} \to -1.35\,\text{rad}$).
- **Aerodynamic Glide Phase:** The compact tuck holds an effortless, aerodynamic glide during mid-hangtime ($u \in [0.25, 0.70]$).
- **Smooth Deceleration & Landing Reach:** At $u > 0.70$, the legs uncurl smoothly and reach forward along a continuous ease-in/ease-out trajectory into the Phase C landing claw pre-touchdown pose, seamlessly transitioning into the stance compression and reactive bounding launch without a single jarring frame.

---

## 2. Mathematical Formulations & Kinematic Laws

```
                         [ Airborne Flight Arc ]
                            u = t_air / τ_flight
                                    │
       Takeoff Launch               ▼                Touchdown Prep
       u ∈ [0.0, 0.20]       u ∈ [0.20, 0.70]        u ∈ [0.70, 1.00]
     ┌─────────────────┐   ┌──────────────────┐    ┌──────────────────┐
     │ Explosive Stride│──►│ FLUID LEG TUCK   │───►│ Smooth Unfold to │──► [ Touchdown ]
     │ Push-Off & Lift │   │ • Hips Flex -1.2 │    │ Landing Claw &   │    Grounded Bounding
     └─────────────────┘   │ • Knees Fold +1.8│    │ Stance Shock Abs │
                           │ • Torso Stable   │    └──────────────────┘
                           │ • Root NO FLIP   │
                           └──────────────────┘
```

### 2.1 Airborne Tuck Phase Parameterization
Let $u = \text{clamp}(t_\text{air} / \tau_\text{flight}, 0, 1)$ be the normalized flight phase.
When acrobatic tuck input is active (`input.crouch` / `input.roll` while `!isGrounded`):

The tuck blending weight $W_\text{tuck}(u)$ follows a $C^1$-continuous quintic smoothstep:
$$W_\text{tuck}(u) = \begin{cases}
0 & u < 0.15 \\
S\left(\frac{u - 0.15}{0.15}\right) & 0.15 \le u < 0.30 \\
1.0 & 0.30 \le u \le 0.70 \\
1.0 - S\left(\frac{u - 0.70}{0.20}\right) & 0.70 < u \le 0.90 \\
0 & u > 0.90
\end{cases}$$
where $S(x) = 6x^5 - 15x^4 + 10x^3$ (standard smoothstep with zero first and second derivatives at boundaries).

### 2.2 Joint Angle Blending Laws
Let $\Theta_\text{base}(u)$ be the baseline Olympic triple-jump cycling angles from Spec 31. The live joint angles blend smoothly as:

$$\theta_j(u) = (1 - W_\text{tuck}(u)) \cdot \theta_{j,\text{base}}(u) + W_\text{tuck}(u) \cdot \theta_{j,\text{tuck}}$$

Target Tuck Constants (`AstronautSuit.ts`):
- `TUCK_HIP_FLEXION_RAD = -1.20` (bilateral hip flexion, swinging thighs forward/up toward chest).
- `TUCK_KNEE_FLEXION_RAD = +1.80` (bilateral knee flexion, swinging calves back against hamstrings).
- `TUCK_ANKLE_PITCH_RAD = -0.35` (toes pointed down/aft in streamlined profile).
- `TUCK_ELBOW_FLEXION_RAD = -1.35` (forearms bent forward around knees, maintaining negative sign convention per Spec 32 §2.1).
- `TUCK_SHOULDER_PITCH_RAD = -0.65` (upper arms angled forward to bracket knees).
- `TUCK_TORSO_PITCH_RAD = 0.22` (stable forward athletic pitch, $\approx 12.6^\circ$, no somersault).
- `TUCK_ROOT_FLIP_RAD = 0.0` (STRICT ZERO: Somesault flip pitch is completely eliminated).

### 2.3 Acoustic Synthesis
- **Tuck Compression:** Procedural pneumatic hiss / suit valve adjustment ($440\,\text{Hz} \to 220\,\text{Hz}$ downward frequency sweep, $0.15\,\text{s}$ duration, low amplitude $-18\,\text{dB}$).
- **Extension Pre-Touchdown:** Hydraulic latch engagement click ($1.2\,\text{kHz}$ short transient, $15\,\text{ms}$) as boots lock into landing prep.

---

## 3. Implementation Phasing & Task Breakdown

### Phase 1: Kinematic Rectification & Pose Generation (`AstronautSuit.ts`)
- Update `hurryStridePose()` and `acrobaticTuckEnvelope()` in `AstronautSuit.ts`.
- Set `flipPitchRad` to strictly return `0` under all conditions.
- Implement the quintic smoothstep $W_\text{tuck}(u)$ blending for bilateral hips, knees, ankles, and elbows.
- Ensure torso pitch is clamped to a stable athletic forward rake ($12^\circ\text{--}14^\circ$).

### Phase 2: Traversal Physics & State Transitions (`TraversalPhysics.ts`)
- Verify airborne gait transitions: entering tuck does not interrupt forward horizontal momentum $\vec{v}_{xy}$.
- Ensure landing detection at $u \ge 0.90$ cleanly triggers the grounded stance compression state (`Δz ≈ -0.08m`) without state hitching.
- Allow tactical PLSS RCS oxygen burst (Spec 32 §2.3) to operate concurrently with the leg tuck.

### Phase 3: Client App & HUD Action Feedback (`ClientApp.ts`, `LunarHUD.ts`)
- Wire touch button `#btn-touch-tuck` and Gamepad `[B]` / `[LB]` / Keyboard `[C]` to smoothly toggle the tuck envelope.
- Update HUD telemetry: display `AERODYNAMIC TUCK` status pill when $W_\text{tuck} > 0.5$.
- Update controller key legends to reflect "Airborne Tuck" rather than "Airborne Somersault/Flip".

### Phase 4: Headless Smoke Verification Suite (`smoke-spec35-airborne-tuck.ts`)
- Author comprehensive headless test script covering:
  1. Root mesh pitch stays strictly bounded ($\le 0.35\,\text{rad}$, zero 360° flip rotation).
  2. Bilateral hip and knee angles achieve $\ge 85\%$ of target tuck envelope at mid-arc ($u = 0.50$).
  3. Smoothness continuity check: $\max |d\theta / du| < \infty$, zero NaN values across entire flight phase $u \in [0, 1]$.
  4. Clean landing handoff: ground contact resets tuck weight to 0 within 1 frame.
  5. 100% pass rate under Babylon.js `NullEngine`.

---

## 4. Acceptance Criteria & Quality Gates

1. **Root Pitch Zero-Flip Gate:** Across the entire flight arc $u \in [0, 1]$, `pose.flipPitchRad === 0` and avatar root pitch never exceeds $20^\circ$ ($0.35\,\text{rad}$).
2. **Bilateral Symmetry Gate:** During tuck ($W_\text{tuck} > 0.8$), left and right hip angles are identical within $0.01\,\text{rad}$, and left and right knee angles are identical within $0.01\,\text{rad}$.
3. **Elbow Sign Convention Gate:** All elbow rotations maintain negative pitch ($\theta_\text{elbow} \le -0.15\,\text{rad}$) throughout the maneuver.
4. **Smoke Suite Gate:** `npx tsx scripts/smoke-spec35-airborne-tuck.ts` passes all $\ge 50$ assertions cleanly.
5. **Production Build Gate:** `npm run build` succeeds with zero TypeScript errors.
