# Spec 28: Lunar Frontier First-Time User Experience (FTUE), Retro-Modern EVA Suit, Low-G Bounding Mechanics & Controller Rectification

## 1. Executive Summary & Problem Statement

Player playtesting of Lunar Frontier revealed four critical gaps in the onboarding and traversal experience:
1. **Missing First-Time User Experience (FTUE):** Although Spec 24 defined an orbital arrival sequence (`IntroDirector`, `TransportLander`), it was never wired into the production client entry point (`main.ts` / `ClientApp.init()`). New players loading `http://<host>:5174/` spawned directly on regolith without the atmospheric descent, cabin depressurization, ramp deployment, or clear tutorial orientation.
2. **Suit Aesthetics:** The existing EVA suit avatar (`AstronautSuit.ts`) uses oversized, blocky geometric primitives ($0.58\text{m}$ wide torso, monolithic rectangular backpack box, square chest console) with no arms, producing a chunky, dated visual read. The player requested a slimmer, retro-modern aerospace aesthetic.
3. **EVA Locomotion & Lunar Physics:** In lunar vacuum ($g = 1.62\,\text{m/s}^2$), continuous terrestrial sprinting is unnatural. In real lunar EVAs (Apollo 11–17), astronauts universally adopted low-g kangaroo bounding and loping to cover ground efficiently. Locomotion currently feels like standard flat-ground running without the floaty ballistic bounding cadence of the Moon.
4. **Gamepad Controller Unreliability:** A latent bug in `ClientApp.calibratePadTriggers()` misidentifies extreme stick deflections on axes 2 and 3 as resting trigger rails, permanently muting camera yaw and pitch after holding a stick for $\ge 5$ frames. Furthermore, stick deadzones and trigger curves lack standard W3C Gamepad mapping isolation.

Spec 28 provides the architectural contract and implementation plan to resolve these four domains cleanly.

---

## 2. Architectural Contracts & Technical Specifications

### 2.1 First-Time User Experience (FTUE) & Arrival Pipeline
- **Auto-Boot Discovery:** In `ClientApp.init()` / `main.ts`, inspect `localStorage['lunar_frontier_intro_completed']` and URL search parameters (`?intro=1`, `?skip_intro=1`).
- **Production Lander & Director Instantiation:** When uncompleted or when `?intro=1` is passed, automatically instantiate `TransportLander` in `WorldScene` at the landing site, instantiate `IntroDirector` wired to the lander and `CameraRig`, and initiate the cinematic sequence (`orbit` $\to$ `burn` $\to$ `touchdown` $\to$ `depressurize` $\to$ `ramp` $\to$ `walkout`).
- **Quest Engine Synchronization:** Defer `QuestEngine`'s "A One-Way Ticket to the Frontier" until the player reaches the bottom of the ramp onto regolith (`WALKOUT_REACHED_REGOLITH_M = 1.2\text{m}`). At that instant:
  - Mark intro completed in storage.
  - Retract the intro HUD overlay and restore the glassmorphic tactical HUD.
  - Play the corporate dispatch comms chime and display the narrative briefing.
  - Engage the 3D Hint Arrow locked onto the survey beacon 10m ahead.
- **HUD Replay & Reset:** Always surface an accessible `[🔄 Replay Intro]` button in the HUD settings/status area and support the `[F8]` hotkey to wipe completion storage and re-trigger the descent sequence cleanly.

### 2.2 Retro-Modern Slimmer EVA Suit Model & Materials
- **Proportional Redesign:** Re-architect `AstronautSuit.ts` body geometry into a tailored, sleek retro-modern aerospace silhouette:
  - **Torso:** Slender, tapered capsule ($r = 0.20\text{m}$, height $0.92\text{m}$, y-offset $0.84\text{m}$) with articulated chest plate and waist compression band.
  - **Arms & Gauntlets:** Add left and right upper arm ($r = 0.07\text{m}$, $h = 0.32\text{m}$), forearm ($r = 0.065\text{m}$, $h = 0.28\text{m}$), and glove gauntlet meshes with procedural swing synchronized with locomotion.
  - **Helmet & Visor:** Sculpted aerodynamic bubble helmet ($d = 0.38\text{m}$) featuring a panoramic gold-sputtered visor ($d = 0.36\text{m}$, $s_x = 0.92, s_y = 0.65, s_z = 0.95$) with high-reflectivity PBR metallic finish ($m = 0.96, r = 0.10$) and subtle amber interior glow.
  - **Life Support Backpack (PLSS):** Sculpted contour pack with twin cylindrical oxygen cryo-tanks ($r = 0.08\text{m}$, $h = 0.52\text{m}$), central heat-exchanger radiator cowl, and lower thruster nozzles replacing the monolithic box.
  - **Chest Interface Pad:** Low-profile flush telemetry slate ($0.16\text{m} \times 0.12\text{m} \times 0.03\text{m}$) integrated into the breastplate.
  - **Legs & Boots:** Form-fitting thigh and calf capsules with armored knee articulators and treaded lunar boots ($0.11\text{m} \times 0.22\text{m}$).
- **Material System:** Three distinct PBR materials:
  - `fabric-white`: High-density ballistic composite weave (Albedo: `(0.88, 0.88, 0.86)`, Roughness: `0.65`, Metallic: `0.02`).
  - `trim-hardware`: Matte slate & mission safety orange anodized titanium fittings (Albedo: `(0.25, 0.26, 0.28)` with accent `(0.92, 0.42, 0.12)`).
  - `visor-gold`: Sputtered gold optical shield (Albedo: `(0.95, 0.78, 0.25)`, Metallic: `0.98`, Roughness: `0.08`, Emissive: `(0.12, 0.08, 0.02)`).

### 2.3 Lunar Low-G Bounding Mechanics (`TraversalPhysics.ts` & `AstronautSuit.ts`)
- **Locomotion Modalities:**
  - **Walk Mode ($v \le 1.8\,\text{m/s}$):** Stable surface stride with minimal vertical oscillation ($h_\text{bob} \approx 0.025\,\text{m}$, frequency $1.8\,\text{Hz}$).
  - **Lunar Bounding Sprint ($v > 1.8\,\text{m/s}$ or sprint input active):**
    - When grounded and moving forward at sprint threshold, each footfall triggers a rhythmic vertical leap impulse:
      $$v_{z,\text{launch}} = \text{SUIT\_BOUND\_IMPULSE} \approx 1.35\,\text{m/s}$$
    - Under lunar gravity ($g = 1.62\,\text{m/s}^2$), this creates a parabolic ballistic flight arc lasting $\tau_\text{flight} = \frac{2 v_z}{g} \approx 0.83\,\text{s}$ and reaching a peak apex of $\Delta z \approx 0.56\,\text{m}$.
    - Horizontal forward velocity during bounding increases progressively to $v_\text{bound} \approx 4.8\text{--}5.5\,\text{m/s}$.
    - Upon landing ($z \le z_\text{ground}$), forward momentum is conserved (restitution $\eta \approx 0.88$), triggering a localized regolith dust puff (`triggerBootDustPuff()`) before immediately rebounding into the next bounding leap if forward throttle is maintained.
- **Visual Articulation in `AstronautSuit.ts`:**
  - Flight phase: Legs trailing in slight knee flexion, arms spread slightly outward for balance.
  - Landing phase: Brief compression crouch ($\Delta y \approx -0.06\,\text{m}$) transitioning smoothly into launch extension.
  - Camera integration: Camera rig absorbs high-frequency vertical jolt with damped low-pass smoothing, conveying floaty lunar hangtime without nausea-inducing screen shake.

### 2.4 Gamepad Controller Rectification (`ClientApp.ts`)
- **Stick Rail Latch Defect Fix:** In `calibratePadTriggers()`, strictly restrict negative-rail trigger calibration to axes 4 and 5 (Linux LT/RT). **Never** latch `axes[2]` (Right Stick X / Yaw) or `axes[3]` (Right Stick Y / Pitch) as trigger sliders.
- **W3C Standard Mapping Protection:** If `pad.mapping === 'standard'`, skip heuristic trigger axis scanning entirely—standard controllers guarantee LT on `buttons[6]`, RT on `buttons[7]`, Left Stick on `axes[0, 1]`, and Right Stick on `axes[2, 3]`.
- **Radial Deadzone & Re-normalization:** Apply radial deadzone ($dz = 0.12$) to stick pairs:
  $$\vec{a}_\text{norm} = \frac{\max(0, \|\vec{a}\| - dz)}{1 - dz} \cdot \frac{\vec{a}}{\|\vec{a}\|}$$
  Eliminates dead-zone popping and guarantees full $1.0$ deflection along diagonals.
- **Consistent Control Layout:**
  - Left Stick: Analog horizontal movement / strafe.
  - Right Stick: Dual-axis look (Yaw on X, Pitch on Y with inverted/non-inverted options).
  - Left Bumper (`LB`): Sprint / initiate Lunar Bounding.
  - Button `A`: Low-G Hop / Jump.
  - Button `X`: Mount / Dismount / Interact.
  - Button `RB`: Fire Mining Laser.
  - Button `B`: Cancel / Close Dialog / Trade.

---

## 3. Phased Implementation Breakdown

- **Phase 1: Architecture Blueprint & Symbol Map Registration**
  - Author `docs/architecture/28-lunar-frontier-ftue-eva-mechanics-and-controls.md`.
  - Update `docs/MAP.md` and enroll in `boards/Kanban-Playground.md` (`TASK-PLAY-075`).
  - Register in `boards/Kanban-Spec-Queue.md` via `spec_queue_runner.py`.

- **Phase 2: First-Time User Experience (FTUE) Production Boot Pipeline**
  - Wire `TransportLander` and `IntroDirector` into `ClientApp.init()` and `src/client/main.ts`.
  - Integrate storage checks (`lunar_frontier_intro_completed`) and URL flag overrides (`?intro=1`).
  - Wire landing ramp walkout transition directly to `QuestEngine` tutorial launch.
  - Surface HUD Replay button and `[F8]` hotkey.

- **Phase 3: Retro-Modern Slimmer EVA Suit Asset & Materials**
  - Refactor `AstronautSuit.ts` mesh builder: slender torso, dual arms with articulated gauntlets, panoramic bubble helmet with gold visor, contour twin-tank PLSS.
  - Define three-tier PBR material set (`fabric-white`, `trim-hardware`, `visor-gold`).
  - Add arm swinging kinematics to walk and bounding cycles.

- **Phase 4: Lunar Low-G Bounding Mechanics & Ballistic Looping**
  - Implement bounding state machine in `TraversalPhysics.ts` (`walk`, `bound_launch`, `bound_flight`, `bound_land`).
  - Tune impulse parameters: $v_{z,\text{launch}} = 1.35\,\text{m/s}$, $v_\text{bound} = 5.0\,\text{m/s}$, restitution $0.88$.
  - Wire footfall dust puff events into particle system on landing.

- **Phase 5: Gamepad Stick Rectification & W3C Standard Mapping**
  - Fix `calibratePadTriggers()` in `ClientApp.ts` to protect axes 2 & 3.
  - Implement radial deadzone re-normalization for left and right sticks.
  - Verify look pitch and yaw responsiveness on standard and Linux gamepads.

- **Phase 6: Automated Headless Smoke Verification Suite & Build Gate**
  - Author `scripts/smoke-ftue-eva-controls.ts` verifying FTUE state transitions, suit mesh hierarchy, bounding ballistics, and stick input isolation.
  - Run regression pass across all 20+ existing smoke test suites.
  - Verify production client build (`npm run build`).

---

## 4. Acceptance Criteria & Verification Gates

1. **FTUE Boot Gate:** Opening `http://localhost:5174/?intro=1` launches the cinematic descent from orbit; walking down the ramp onto regolith automatically starts Quest 1 and displays corporate comms.
2. **Suit Aesthetic Gate:** Visual inspection and mesh tests confirm suit torso radius $\le 0.22\text{m}$, articulated left and right arms present, panoramic visor diameter $\ge 0.34\text{m}$, and twin-tank PLSS backpack present.
3. **Bounding Locomotion Gate:** Stepping `LunarEvaSuit` forward with sprint active produces alternating airborne ballistic arcs ($z - z_\text{floor} \ge 0.35\text{m}$) with hangtime $\ge 0.6\text{s}$ and forward speed $\ge 4.5\,\text{m/s}$.
4. **Stick Reliability Gate:** Deflecting Right Stick to extreme rails ($x = -1.0, y = -1.0$) for $\ge 30$ frames never mutes camera yaw or pitch.
5. **Headless & Build Gate:** `npx tsx scripts/smoke-ftue-eva-controls.ts` passes 100% green; `npm run build` succeeds with zero errors.
