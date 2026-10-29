# Spec 31: Lunar Frontier High-Speed Steelpush Locomotion: Organic Ambient Hustle, Triple-Jump Mid-Air Stutter Cycle & Hydraulic Assist Boots

## 1. Executive Summary & Problem Statement

In Spec 30, Lunar Frontier introduced unilateral alternating bounding locomotion with Mistborn "Steelpush" physics: an explosive single-leg push-off launching the EVA avatar into a low-g ballistic arc, alternating between left and right legs.

However, recent playtesting and critical evaluation revealed that while the underlying physical impulse and trajectory are sound, the avatar's airborne locomotion still lacks vitality, organic athleticism, and the visceral sensation of an astronaut running flat-out in a high-tech suit:
1. **Frozen Mid-Air Statuesque Pose:** During the low-g ballistic flight arc ($\tau_\text{flight} \approx 0.95\text{--}1.9\,\text{s}$ under $g = 1.62\,\text{m/s}^2$), the limb articulation in `AstronautSuit.ts` is 100% static. Once launched, the legs and arms remain frozen in fixed angles until touchdown. This gives the avatar a stiff, plastic, doll-like appearance while sailing through the lunar sky.
2. **Missing Athletic Stride Cycling & Hustle:** Real human sprinting and elite track mechanics (specifically the **Olympic Triple Jump** and long jump hitch-kick) rely on continuous dynamic limb cycling in the air. In the triple jump's flight phase, an athlete performs a signature **"mid-air stutter step" / cycling hitch**: the takeoff leg doesn't just hang aft—it whips forward in a tight tuck under the pelvis while the lead leg cycles downward and backward in an aggressive, pre-tensioned "pawing/clawing" action to match ground velocity before touchdown. Furthermore, the avatar lacks dynamic upper-body urgency: static torso lean, static shoulders, and motionless arms fail to convey an astronaut sprinting with urgency.
3. **Absence of Mechanical/Hydraulic Feedback:** The player noted the inspiration of powered gas-piston / hydraulic assist boots (reminiscent of experimental Russian "boots of speed" / Ufa Saiga pneumatic jump boots and jumping exoskeletons). When the suit strikes the surface, high-pressure hydraulic cylinders should audibly compress to absorb the shock, and upon the explosive push-off, they should fire with an audible pneumatic hiss and twin directional gas-exhaust vapor jets alongside the regolith dust puff.

Spec 31 establishes the kinematic laws, phase-dependent articulation curves, procedural audio synthesis, and visual exhaust FX to transform lunar bounding into an intensely kinetic, organic, high-speed athletic sprint.

---

## 2. Architectural Contracts & Kinematic Specifications

```
                          [ TraversalPhysics.ts ]
                     (Unilateral Ballistic Hangtime)
                                    │
                                    ▼
                          [ Normalized Phase u ]
                         u = hurryAirTime / τ_flight
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
        [ AstronautSuit.ts ]                [ LunarAudioSystem.ts ]
   • Triple-Jump 3-Phase Cycle         • Hydraulic Touchdown Compression
     - Drive (u: 0.0 -> 0.28)            (1200 -> 380 Hz fluid sweep)
     - Stutter Step (u: 0.28 -> 0.72)  • Pneumatic Push-Off Vent
     - Claw Prep (u: 0.72 -> 1.0)        (2200 -> 500 Hz high-pressure crack)
   • Dynamic Sprint Rake (7° -> 14°)                  │
   • Shoulder Counter-Yaw (±4°)                       ▼
   • Arm Sprint Pumping Cycles               [ ClientApp.ts ]
   • Hydraulic Jet Exhaust Puffs       • Audio cadence & trigger hooks
```

---

### 2.1 The Olympic Triple-Jump 3-Phase Airborne Cycle (`AstronautSuit.ts`)

Let $u \in [0.0, 1.0]$ be the normalized flight phase computed from the ballistic hangtime:
$$u = \text{clamp}\left(\frac{t_\text{air}}{\tau_\text{flight}}, 0, 1\right)$$
where $\tau_\text{flight} = \frac{2 v_{z,\text{launch}}}{g} \approx 1.91\,\text{s}$ (with $v_{z,\text{launch}} = 1.55\,\text{m/s}$ and $g = 1.62\,\text{m/s}^2$).

Instead of a static pose, the stride kinematics are parameterized across three distinct biomechanical phases:

#### Phase A: Takeoff Drive & Hyperextension ($u \in [0.0, 0.28]$)
- **Pushing Leg (Power Leg):** Achieves maximum rearward extension ($\theta_\text{hip} = +0.62\,\text{rad}$ aft), with the knee locked straight ($\theta_\text{knee} = 0.04\,\text{rad}$) in full plantarflexion follow-through.
- **Leading Leg (Drive Leg):** High knee drive punches forward and upward ($\theta_\text{hip} = -0.58\,\text{rad}$ forward, $\theta_\text{knee} = 1.05\,\text{rad}$ deep flexion), generating upward momentum.
- **Arms:** Stance arm drives forward ($\theta_\text{shoulder} = -0.55\,\text{rad}$), recovery arm swings aft ($\theta_\text{shoulder} = +0.45\,\text{rad}$).

#### Phase B: Mid-Air Cycling & Stutter Step ($u \in [0.28, 0.72]$) — The Triple Jump Hitch
In Olympic triple jumping and long jumping, this is the hitch-kick/cycling motion that preserves angular momentum and prepares for the next explosive plant:
- **Trailing Leg (formerly pushing leg):** Rapidly breaks from rearward extension and sweeps forward with aggressive knee tuck ($\theta_\text{hip}$ transitions from $+0.62\,\text{rad}$ aft to $-0.32\,\text{rad}$ forward; knee flexes up to $1.15\,\text{rad}$), tucking tight under the pelvis to accelerate recovery.
- **Leading Leg:** Reaches the apex of forward extension, then begins its downward and backward cycling arc ("pawing" the air), with hip rotating from $-0.58\,\text{rad}$ back toward $+0.12\,\text{rad}$ and knee extending from $1.05\,\text{rad}$ to $0.50\,\text{rad}$.
- **Stutter Step Modulation:** A smooth sinusoidal stutter perturbation $s(u) = \sin\left(\frac{u - 0.28}{0.44} \cdot \pi\right)$ modulates the limb angular velocities, creating the distinct athletic hitch in mid-air.

#### Phase C: Pre-Landing Claw & Hydraulic Priming ($u \in [0.72, 1.0]$)
- **Landing Leg (Stride Leg):** Sweeps downward and backward in an active ground-speed matching claw stroke ($\theta_\text{hip} = -0.42\,\text{rad}$, $\theta_\text{knee} = 0.35\,\text{rad}$), pre-tensioned to absorb touchdown shock.
- **Opposite Leg:** Flexes upward and holds high knee recovery ($\theta_\text{hip} = -0.50\,\text{rad}$, $\theta_\text{knee} = 0.90\,\text{rad}$) primed to violently drive forward the instant the landing foot touches down.
- **Boot Hydraulic Actuators:** Extend to full readiness length to receive ground load.

---

### 2.2 Upper-Body Ambient Hustle & Kinetic Coordination

To ensure the avatar feels like it is "really trying to hustle":
1. **Dynamic Sprint Rake (Pitch):**
   - At walk/jog speeds ($v \le 1.8\,\text{m/s}$), torso rake is modest ($7^\circ \approx 0.12\,\text{rad}$).
   - As speed accelerates toward sprint cruise ($5.2\,\text{m/s}$), torso pitch deepens dynamically to **$14^\circ$ ($0.24\,\text{rad}$)** forward, putting the helmet down and chest over the center of thrust.
   - During the ballistic arc, an organic spinal breathing heave of $\pm 1.5^\circ$ ($\pm 0.026\,\text{rad}$) oscillates with the flight apex.
2. **Pelvic & Shoulder Counter-Yaw:**
   - As the legs cycle in opposition, the thoracic spine and shoulder girdle counter-yaw against the pelvis by $\pm 4^\circ$ ($\pm 0.07\,\text{rad}$): when the right leg drives forward, the left shoulder twists forward to balance the angular torque.
3. **Active Arm Sprint Pumping:**
   - Arms do NOT lock in mid-air. They pump dynamically in rhythm with the hitch-kick cycle:
     $$\theta_\text{shoulder}(u) = \theta_\text{base} \cdot \cos(\pi u) \pm \theta_\text{pump}$$
   - Elbows actively flex during forward drive ($0.85\,\text{rad}$) and extend slightly during rear swing ($0.25\,\text{rad}$).
4. **Head Horizon Stabilization:**
   - The helmet dome tilts slightly counter to the deep torso rake (pitching up by $4^\circ \dots 6^\circ$ relative to torso) so the astronaut's gold visor remains trained directly forward on the lunar horizon rather than staring at the ground.

---

### 2.3 Hydraulic Assist Boots Mechanics, Emitters & Procedural Audio

#### 2.3.1 Visual Mechanical Articulation & Dual Cold-Gas Vapor Vents
- **Piston Compression:** During the $0.12\,\text{s}$ grounded brace window, the boot heel piston assemblies compress by $\Delta z = -0.08\,\text{m}$.
- **Directed Pneumatic Vent Plumes:** Upon the explosive Steelpush push-off launch, twin high-velocity directional vapor plumes vent from the aft heel exhaust ports:
  - Vent direction: $45^\circ$ downward and rearward relative to avatar heading.
  - Plume lifespan: $0.22\,\text{s}$, velocity $v_\text{vent} \approx 4.0\,\text{m/s}$.
  - Color: White/cyan pressurized nitrogen gas (`Color4(0.85, 0.95, 1.0, 0.7)` fading to transparent).
  - Accompanies the existing regolith footfall dust puff.

#### 2.3.2 Procedural Web Audio Synthesis (`LunarAudioSystem.ts`)
Two new deterministic Web Audio procedural synthesizers are added to the audio engine (headless-safe via mock nodes):
1. **`playHydraulicCompression()`:**
   - Triggered upon footfall touchdown when entering `ground_brace`.
   - Acoustic signature: Heavy mechanical fluid valve hiss: band-pass filtered noise swept from $1200\,\text{Hz}$ down to $380\,\text{Hz}$ ($Q = 3.5$) over $90\,\text{ms}$, layered over a muffled $60\,\text{Hz}$ mechanical damper thud.
2. **`playPneumaticLaunch()`:**
   - Triggered upon the Steelpush push-off launch when transitioning to `flight_arc`.
   - Acoustic signature: Crisp, high-pressure pneumatic release crack: noise swept from $2400\,\text{Hz}$ down to $550\,\text{Hz}$ over $110\,\text{ms}$, layered over an explosive $110\,\text{Hz}$ kinetic pop.

---

## 3. Phased Implementation Breakdown

### Phase 1: Architectural Blueprint, Symbol Map Registration & Task Queue
- Author `docs/architecture/31-lunar-frontier-steelpush-locomotion-athletic-hustle-and-hydraulic-assist.md`.
- Register Spec 31 in `docs/MAP.md`.
- Enroll `[TASK-PLAY-078]` with subtasks `a` through `f` on `/home/jagosan/obsidian/vault/boards/Kanban-Playground.md`.
- Register `SPEC-PLAY-031` in `/home/jagosan/obsidian/vault/boards/Kanban-Spec-Queue.md` under `## 🚧 Running`.

### Phase 2: Traversal Physics Flight Phase & Dynamic Stride Clock (`TraversalPhysics.ts`)
- Track normalized flight phase $u = \text{clamp}(t_\text{air} / \tau_\text{flight}, 0, 1)$ inside `LunarEvaSuit`.
- Expose `hurryAirPhase` ($0.0 \dots 1.0$) and dynamic expected hangtime on `SuitState`.
- Maintain exact momentum restitution ($\eta \ge 0.88$) and push-off velocity boosts.

### Phase 3: Triple-Jump Airborne Cycling Kinematics & Organic Hustle (`AstronautSuit.ts`)
- Rewrite `hurryStridePose` to accept normalized flight phase $u$, current horizontal velocity, and stance leg.
- Implement Phase A (Drive), Phase B (Triple-jump stutter step / cycling hitch-kick), and Phase C (Pre-landing claw).
- Implement dynamic sprint rake ($7^\circ \to 14^\circ$ scaling with forward speed), thoracic counter-yaw ($\pm 4^\circ$), active arm sprint pump, and head horizon stabilization.

### Phase 4: Hydraulic Assist Boots FX, Dual Vapor Vents & Procedural Audio (`LunarAudioSystem.ts`, `AstronautSuit.ts`, `ClientApp.ts`)
- Implement procedural `playHydraulicCompression()` and `playPneumaticLaunch()` in `LunarAudioSystem.ts` with full headless mock support.
- Add twin heel exhaust vent particle nozzles to `AstronautSuit.ts`, triggering directed white-cyan gas plumes on push-off.
- Hook audio events in `ClientApp.ts` / `AstronautSuit.ts` on touchdown brace and Steelpush launch edges.

### Phase 5: Headless Smoke Verification Suite & Build Gate (`smoke-steelpush-hustle.ts`)
- Author `scripts/smoke-steelpush-hustle.ts` under `NullEngine`:
  - Assert non-static airborne articulation: sample poses across $u \in [0.1, 0.5, 0.85]$ and verify distinct kinematic angles.
  - Assert Olympic triple-jump stutter step: trailing leg swings forward ($>0.5\,\text{rad}$ sweep) while leading leg cycles into claw position.
  - Assert dynamic sprint rake scaling with velocity ($7^\circ$ at $2.0\,\text{m/s}$ to $14^\circ$ at $5.2\,\text{m/s}$).
  - Assert thoracic counter-yaw and dynamic arm pump oscillation.
  - Assert procedural audio triggers and dual pneumatic vapor vent emitter execution.
- Register `npm run smoke:steelpush` in `package.json`.
- Execute full `npm run build` verification gate.

---

## 4. Acceptance Criteria & Contract Gates

- [ ] **Gate 1: Dynamic Non-Static Airborne Flight Kinematics:**
  - Airborne articulation is continuous and phase-dependent across $u \in [0, 1]$.
  - Hip and knee angles at $u = 0.50$ differ by $\ge 0.35\,\text{rad}$ from $u = 0.10$ (proving zero frozen statue behavior).
- [ ] **Gate 2: Olympic Triple-Jump Hitch-Kick & Stutter Step:**
  - During mid-flight ($u \in [0.28, 0.72]$), the trailing leg flexes knee to $\ge 0.90\,\text{rad}$ and sweeps forward by $\ge 0.45\,\text{rad}$.
  - The leading leg cycles downward from its high-knee apex into a claw prep angle ($\theta_\text{hip} \le -0.20\,\text{rad}$).
  - Touchdown prep at $u \ge 0.85$ places the landing leg in an active pre-tensioned posture with knee flexed between $0.25$ and $0.50\,\text{rad}$.
- [ ] **Gate 3: Ambient Upper-Body Hustle & Rake:**
  - Torso forward rake scales dynamically with speed from $0.12\,\text{rad}$ ($7^\circ$) up to $\ge 0.22\,\text{rad}$ ($13^\circ\text{--}14^\circ$) at sprint cruise ($v \ge 5.0\,\text{m/s}$).
  - Shoulders counter-yaw against the hips by $\ge 0.05\,\text{rad}$ ($\approx 3^\circ\text{--}4^\circ$) in phase with the active leg drive.
  - Arms actively pump across the flight arc, varying shoulder flexion by $\ge 0.30\,\text{rad}$ between launch and mid-flight.
- [ ] **Gate 4: Hydraulic/Pneumatic Assist Boots FX & Audio:**
  - `playHydraulicCompression` and `playPneumaticLaunch` execute deterministically on Web Audio (and mock nodes in headless CI).
  - Push-off launch triggers twin directional gas exhaust vent plumes from the heel ports alongside regolith dust.
- [ ] **Gate 5: Headless Test Suite & Production Build:**
  - `scripts/smoke-steelpush-hustle.ts` passes 100% of checks in `NullEngine`.
  - `npm run build` succeeds cleanly with zero TypeScript errors.
