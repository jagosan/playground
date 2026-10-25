# Spec 30: Lunar Frontier EVA Locomotion Overhaul, Stormtrooper Suit Aesthetics & Tactical HUD Controls Cleanup

## 1. Executive Summary & Problem Statement

Recent gameplay testing of Lunar Frontier revealed three prominent friction points in on-foot surface exploration and client interface controls:
1. **Stick-Figure EVA Suit Aesthetics:** Following the initial silhouette slimming pass in Spec 28, the EVA avatar (`AstronautSuit.ts`) now reads visually as a fragile, spindly "stick person" composed of bare, narrow cylinders ($r_\text{thigh} = 0.095\text{m}$, $r_\text{arm} = 0.07\text{m}$) without physical bulk, armor silhouette, or commanding presence. The player requested an aesthetic overhaul modeling the avatar after a stylized, muscular, armored sci-fi operative reminiscent of a Stormtrooper—featuring layered composite armor carapaces, prominent flared shoulder bells (pauldrons), armored vambraces and greaves, segmented abdominal gaskets, heavy magnetic boot platforms, and a stylized helmet with chin aerators and an aggressive brow.
2. **Symmetric Locomotion vs. Unilateral Mistborn "Steelpush" Dynamics:** The existing hurried bounding locomotion in `TraversalPhysics.ts` and `AstronautSuit.ts` runs both legs in synchronous, symmetric bunny-hop arcs (`hipL` and `hipR` trailing together in flight). Real low-gravity loping—and the user's explicit design vision—demands **asymmetric, one-leg-at-a-time bounding**. The player described the intended feel as evocative of Brandon Sanderson's *Mistborn* series, where an Allomancer tosses a metal coin beneath them and violently Steelpushes against it: feeling the solid connection of the foot anchoring against the unyielding ground, compressing like a loaded spring, and delivering an explosive kinetic impulse that launches the avatar forward and upward into a soaring low-g glide, before landing on the opposite foot to push off again.
3. **Broken Escape UI Toggle & Key Collision:** The `Escape` key is currently designated in documentation to hide the UI, but fails in practice. In web browsers, pressing `Escape` cancels pointer lock (`document.exitPointerLock()`), exits browser fullscreen, and fails to toggle HUD visibility because `ClientApp.ts` only consumes `Escape` for closing trade dialogs or tactical maps. Furthermore, relying on `Escape` causes severe control disorientation during third-person traversal. The client requires a dedicated, browser-safe UI and HUD toggle mechanism—specifically binding **`[U]`** (UI) and **`[H]`** (HUD) on keyboard, alongside a **double-tap `R3`** (right stick click) on gamepads, supporting seamless cycling between Full HUD, Minimal HUD, and Cinematic Clean mode.

Spec 30 establishes the technical contracts, mathematical foundations, asset hierarchies, and verification suites to resolve all three domains cleanly.

---

## 2. Architectural Contracts & Technical Specifications

```
                       [ Player Input ]
               ┌───────────────┴───────────────┐
               ▼                               ▼
       [ Movement Input ]               [ UI Toggle Input ]
   (WASD / Left Stick / Sprint)      ([U], [H], Double-Tap R3)
               │                               │
               ▼                               ▼
   ┌───────────────────────┐       ┌───────────────────────┐
   │ TraversalPhysics.ts   │       │ ClientApp.ts          │
   │ • Unilateral Stride   │       │ • UI State Machine    │
   │ • Contact & Brace     │       │   (Full / Min / Hide) │
   │ • Steelpush Impulse   │       └───────────┬───────────┘
   │ • Ballistic Low-G Arc │                   ▼
   └───────────┬───────────┘       ┌───────────────────────┐
               ▼                   │ LunarHUD.ts / CSS     │
   ┌───────────────────────┐       │ • Opacity Transitions │
   │ AstronautSuit.ts      │       │ • Pointer-Events Mute │
   │ • Stormtrooper Armor  │       │ • Status Toast Feed   │
   │ • Alternating Limbs   │       └───────────────────────┘
   │ • Footfall Dust Bursts│
   └───────────────────────┘
```

### 2.1 Stormtrooper Stylized EVA Armor Silhouette (`AstronautSuit.ts`)

The procedural avatar mesh hierarchy is overhauled to replace spindly stick-figure cylinders with a muscular, stylized, composite-armored silhouette:

#### 2.1.1 Torso & Core Assembly
- **Pectoral Armor Carapace:** A sculpted, flared chestplate ($w = 0.38\text{m}$, $h = 0.32\text{m}$, $d = 0.16\text{m}$) featuring chiseled pectoral facets and central trapezoidal sternum relief, resting over the thoracic core.
- **Segmented Abdominal Rib Bands:** A four-tier segmented flexible gasket cuirass ($w = 0.32\text{m}$, $h = 0.22\text{m}$) tapering inward toward the waist ($w = 0.28\text{m}$) to create an athletic V-taper.
- **Armored Utility Belt & Codpiece:** A prominent tactical waist belt ($h = 0.08\text{m}$, $d = 0.32\text{m}$) with a front buckle clasp, groin codpiece armor, and twin flank utility canisters ($r = 0.045\text{m}$, $h = 0.14\text{m}$) housing emergency O2 reserves.
- **Integrated PLSS Backpack Cowling:** The life-support backpack pack contours cleanly into the back armor yoke, retaining twin high-pressure cryo-cylinders ($r = 0.085\text{m}$, $h = 0.50\text{m}$) flanking a central heat radiator cowl and dual downward-angled vector nozzles.

#### 2.1.2 Limbs & Articulation
- **Curved Shoulder Bells (Pauldrons):** Distinct flared shoulder armor bells ($r = 0.09\text{m}$, $h = 0.14\text{m}$, flared at $15^\circ$) attached to the upper arm pivots, broadening the shoulder stance to $w_\text{shoulders} \approx 0.52\text{m}$.
- **Armored Vambraces & Gauntlets:** Bicep armor cuffs ($r = 0.08\text{m}$) and contoured forearm vambraces ($r = 0.075\text{m}$) terminating in heavy magnetic gauntlet cuffs ($d = 0.14\text{m}$) and articulated glove meshes.
- **Thigh Cuirasses & Angular Knee Cops:** Flared thigh armor sleeves ($r = 0.115\text{m}$, $h = 0.34\text{m}$) protecting the upper leg, pivoting onto prominent angular knee cops ($w = 0.14\text{m}$, $h = 0.12\text{m}$, $d = 0.12\text{m}$) with forward strike plates.
- **Greaves & Heavy Magnetic Boots:** Sculpted shin greaves ($r = 0.10\text{m}$, $h = 0.26\text{m}$) feeding into chunky, treaded magnetic boot assemblies ($w = 0.14\text{m}$, $h = 0.11\text{m}$, $l = 0.26\text{m}$) with widened ground-contact soles and aft heel spurs.

#### 2.1.3 Stylized Helmet Geometry
- **Aerodynamic Dome & Inset Brow:** Spherical crown ($d = 0.38\text{m}$) with an extended, downward-slanted brow rim ($5^\circ$ forward rake) evoking an aggressive helmet line.
- **Chin Aerators & Mandibles:** Twin cylindrical respirator aerator pods ($r = 0.035\text{m}$, $l = 0.06\text{m}$) mounted at the lower chin flanks beside a central dark vocoder speaker grille.
- **Panoramic Gold Shield:** Panoramic gold-sputtered visor aperture ($w = 0.34\text{m}$, $h = 0.22\text{m}$) recessed beneath the armored brow.

#### 2.1.4 Two-Tone High-Contrast PBR Material Palette
- `armor-white`: High-gloss composite ceramic armor plating. Albedo: `Color3(0.95, 0.95, 0.96)`, Metallic: `0.08`, Roughness: `0.22`.
- `undersuit-gasket`: Matte charcoal ribbed flexible joint seal. Albedo: `Color3(0.12, 0.12, 0.14)`, Metallic: `0.02`, Roughness: `0.85`.
- `trim-hardware`: Dark titanium latches, aerators, and belt hardware. Albedo: `Color3(0.22, 0.23, 0.25)`, Metallic: `0.80`, Roughness: `0.35`.
- `visor-gold`: Apollo mirror gold sputtered visor. Albedo: `Color3(0.96, 0.80, 0.28)`, Metallic: `0.98`, Roughness: `0.06`, Emissive: `Color3(0.12, 0.08, 0.02)`.

---

### 2.2 Unilateral Alternating "Hurry" Locomotion & Mistborn "Steelpush" Dynamics (`TraversalPhysics.ts`)

In low lunar gravity ($g = 1.62\,\text{m/s}^2$), forward sprinting must not be modeled as continuous ground shuffle or symmetric hopping. Locomotion operates on an alternating, unilateral stride state machine where each footfall delivers an explosive kinetic push-off:

```
[ Touchdown / Anchor ]
  - Leading boot contacts regolith
  - Localized dust burst kicks up at sole
  - Knee & ankle compress (Δz ≈ -0.08m)
  - Horizontal momentum conserved (η ≈ 0.90)
           │
           ▼
[ Explosive "Steelpush" Launch ]
  - Stance leg extends violently downward/aft
  - Vertical launch impulse: vz = 1.55 m/s
  - Forward thrust boost: Δv = 1.0 m/s
  - Torso leans forward into thrust vector (7°)
           │
           ▼
[ Ballistic Low-G Glide ]
  - Pushing leg extends aft in full follow-through
  - Opposite leg swings forward, knee flexing for anchor
  - Parabolic ballistic hangtime: τ ≈ 0.95s, apex Δz ≈ 0.65m
  - Arms swing in athletic sprint opposition
           │
           ▼
[ Opposite Touchdown / Anchor ]
  (Repeats on other leg)
```

#### 2.2.1 Kinematic Constants & Parameters
```ts
/** Velocity threshold where ground walk transitions to alternating bounding (m/s). */
export const SUIT_HURRY_MIN_SPEED = 1.8;
/** Target forward velocity achieved during sustained hurry bounding (m/s). */
export const SUIT_HURRY_TARGET_SPEED = 5.2;
/** Vertical launch impulse delivered at each unilateral foot push-off (m/s). */
export const SUIT_HURRY_LAUNCH_VZ = 1.55;
/** Forward kinetic boost imparted per push-off step (m/s). */
export const SUIT_HURRY_STEP_BOOST = 1.0;
/** Momentum restitution retained across footfall touchdown (dimensionless). */
export const SUIT_HURRY_RESTITUTION = 0.90;
/** Knee compression displacement during foot brace phase (metres). */
export const SUIT_HURRY_BRACE_COMPRESSION_M = 0.08;
/** Duration of the grounded brace-and-launch transition window (seconds). */
export const SUIT_HURRY_BRACE_DURATION_S = 0.12;
```

#### 2.2.2 Alternating Stride State Machine
The `LunarEvaSuit` physics engine maintains an explicit stride state:
- `hurryStrideLeg: 'left' | 'right'` (toggles on each successive launch).
- `hurryStepPhase: 'ground_brace' | 'flight_arc'`.
- `hurryAirTime: number` (seconds elapsed in current ballistic flight).
- When `gaitMode === 'bounding'` and speed exceeds `SUIT_HURRY_MIN_SPEED`:
  1. **Touchdown Edge:** When $z \le z_\text{ground}$ from flight, the suit enters `ground_brace`. The current leading foot anchors. The physics engine preserves $\eta \cdot v_{xy}$, applies brief vertical damping, and triggers a localized dust burst at that foot's coordinates.
  2. **Push-Off Launch:** Over `SUIT_HURRY_BRACE_DURATION_S`, the anchored leg extends violently:
     $$v_z \leftarrow v_{z,\text{launch}} = 1.55\,\text{m/s}$$
     $$v_\text{forward} \leftarrow \min(v_\text{forward} + \text{SUIT\_HURRY\_STEP\_BOOST}, \text{SUIT\_HURRY\_TARGET\_SPEED})$$
     The suit transitions to `flight_arc`, and `hurryStrideLeg` flips to the opposite side for the next step.
  3. **Ballistic Flight:** The avatar tracks a pure vacuum ballistic arc under $g = 1.62\,\text{m/s}^2$:
     $$\Delta z(t) = v_{z,0} t - \frac{1}{2} g t^2$$
     $$\tau_\text{flight} = \frac{2 v_{z,0}}{g} = \frac{2 \times 1.55}{1.62} \approx 1.91\,\text{s total cycle} \quad (\approx 0.95\,\text{s single leg})$$
     $$z_\text{apex} = \frac{v_{z,0}^2}{2 g} = \frac{1.55^2}{2 \times 1.62} \approx 0.74\,\text{m}$$

#### 2.2.3 Visual Articulation in `AstronautSuit.ts`
- **Pushing Leg (Stance Leg):** At launch, hip rotates aft ($\theta_\text{hip} \approx -0.55\,\text{rad}$), knee straightens fully ($\theta_\text{knee} \approx 0.05\,\text{rad}$), and ankle points down into toe-off follow-through.
- **Leading Leg (Recovery Leg):** Hip lifts forward ($\theta_\text{hip} \approx +0.48\,\text{rad}$), knee flexes deeply ($\theta_\text{knee} \approx 0.85\,\text{rad}$), positioning the boot sole forward to receive the ground datum.
- **Torso Dynamics:** Torso pitch leans $7^\circ$ ($0.12\,\text{rad}$) forward into the push vector; slight lateral roll sway ($1.5^\circ$) toward the stance side reflects weight transfer.
- **Arms Counter-Balance:** Arm on the stance side drives forward ($\theta_\text{shoulder} \approx -0.45\,\text{rad}$), while arm on the recovery side swings aft ($\theta_\text{shoulder} \approx +0.35\,\text{rad}$), matching natural athletic sprinting counter-torque.
- **Footfall Dust Emitter:** Dust burst is dispatched from the exact world position of the planting boot ($x \pm d_\text{hip} \cos(\text{heading}), y \mp d_\text{hip} \sin(\text{heading}), z$), creating authentic alternating footfall dust trails.

---

### 2.3 Dedicated UI & Minimal HUD Toggle System (`ClientApp.ts`, `LunarHUD.ts`, `hud.css`)

#### 2.3.1 Resolving the Browser Escape Conflict
- **Decoupling `Escape`:** `Escape` is explicitly removed from any HUD toggle duty. In `ClientApp.ts`, `Escape` remains strictly scoped to closing situational modals (e.g. active trade terminal dialog, topographic map overlay, or climbing ladder dismount).
- **Pointer Lock Immunity:** Toggling HUD visibility must never release pointer lock or trigger browser focus shifts.

#### 2.3.2 Keyboard & Controller Mappings
- **Primary Keyboard Key:** **`[U]` key** (`code === 'KeyU'`) — highly intuitive mnemonic for **User Interface**.
- **Secondary Keyboard Key:** **`[H]` key** (`code === 'KeyH'`) — secondary mnemonic for **Heads-Up Display**.
- **Controller Gamepad Mapping:**
  - **Double-Tap `R3` (Right Stick Click):** Two clicks of `buttons[11]` within $350\,\text{ms}$ toggles the HUD mode.
  - **Long-Press `View / Back`:** Holding `buttons[8]` for $\ge 0.5\,\text{s}$ triggers the toggle as an accessible fallback.

#### 2.3.3 HUD Visibility State Machine & CSS Classes
`LunarHUD.ts` implements a tri-state or dual-state visibility lifecycle:
1. `HUDMode = 'standard' | 'minimal' | 'hidden'`
   - **`standard` (Default):** Complete glassmorphic HUD: telemetry bar, life-support gauges (O2, battery, rcs), speed dial, 3D compass bar, mission quest briefing, comms log, hint arrow reticle, interaction prompts.
   - **`minimal`:** Stripped tactical HUD designed for handheld screens and high immersion: suppresses bulky comms cards, mission checklist, and decorative framing; retains compact life-support pills, digital speed readout, and center crosshair reticle.
   - **`hidden` (Cinematic Mode):** Complete visual suppression of all 2D DOM elements and canvas overlays (`opacity: 0`, `pointer-events: none`). Clean canvas rendering ideal for scenic exploration and screenshots.
2. **Smooth Transitions:**
   - Add `.hud-mode-minimal` and `.hud-mode-hidden` classes to the root HUD container (`#lunar-hud`).
   - CSS transition: `transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s ease-out;`.
   - Critical: When `.hud-mode-hidden` is active, apply `pointer-events: none !important` to ensure mouse clicks pass directly into the 3D canvas for camera look and mining laser fire.
3. **Status Toast Notification:**
   - Upon mode switch, trigger a transient, non-intrusive floating toast in the upper-right corner:
     - `"UI: MINIMAL [Press U for Standard]"`
     - `"UI: CINEMATIC HIDDEN [Press U to Restore]"`
     - `"UI: STANDARD"`
   - Toast auto-fades after $1.5\,\text{s}$.
4. **Session Persistence:**
   - Store active mode in `localStorage['lunar_frontier_hud_mode']` so preferred layout persists across browser refreshes.

---

## 3. Phased Implementation Breakdown

### Phase 1: Architectural Blueprint, Symbol Map Registration & Task Queue
- Author `docs/architecture/30-lunar-frontier-eva-locomotion-stormtrooper-suit-and-ui-cleanup.md`.
- Register the new spec and architecture document in `docs/MAP.md`.
- Enroll `[TASK-PLAY-077]` with phases `a` through `f` in `/home/jagosan/obsidian/vault/boards/Kanban-Playground.md`.
- Register `SPEC-PLAY-030` into `boards/Kanban-Spec-Queue.md` via `spec_queue_runner.py`.

### Phase 2: Stormtrooper Stylized EVA Armor Assembly & Materials (`AstronautSuit.ts`)
- Replace bare stick-figure cylinders with flared pectoral chestplate, segmented abdominal rib cuirass, and tactical utility belt with codpiece.
- Add curved shoulder bells (pauldrons), armored bicep cuffs, forearm vambraces, and heavy gauntlet cuffs.
- Sculpt flared thigh cuirasses, angular knee cops with strike plates, greaves, and heavy treaded magnetic boot platforms.
- Overhaul helmet geometry with aggressive brow rake, chin aerator canisters, and mandible grilles.
- Implement two-tone PBR material palette: high-gloss composite `armor-white` over matte `undersuit-gasket` with dark titanium hardware and gold visor.

### Phase 3: Unilateral Alternating "Hurry" Locomotion & Mistborn Steelpush Dynamics (`TraversalPhysics.ts`)
- Implement unilateral alternating stride state machine in `LunarEvaSuit` (`hurryStrideLeg`, `hurryStepPhase`).
- Code the grounded brace and compression window ($\Delta z \approx -0.08\text{m}$, $\tau \approx 0.12\text{s}$) absorbing downward momentum.
- Implement explosive unilateral push-off launch ($v_{z,\text{launch}} = 1.55\,\text{m/s}$, $\Delta v_\text{forward} = 1.0\,\text{m/s}$) with forward thrust vectoring.
- Model momentum restitution ($\eta = 0.90$) across footfalls to maintain continuous, rhythmic low-g bounding leaps.

### Phase 4: Dynamic Articulation, Stance-Foot Dust Trails & Torso Weight Shift (`AstronautSuit.ts`)
- Wire alternating hip/knee kinematics: stance leg extends aft in toe-off follow-through, recovery leg swings forward with flexed knee.
- Connect opposing arm sprint counter-swing to the active stride leg.
- Implement dynamic torso lean ($7^\circ$ forward) and lateral roll weight transfer ($1.5^\circ$ toward stance hip).
- Dispatch localized boot-dust particle bursts from the exact planting sole coordinates on alternating footsteps.

### Phase 5: Resilient UI & Minimal HUD Toggle System (`ClientApp.ts`, `LunarHUD.ts`, `hud.css`)
- Remove UI toggle from `Escape`, preserving `Escape` purely for modal dismissal and ladder dismount.
- Bind `[U]` and `[H]` keys in `ClientApp.onKey()` to cycle HUD visibility modes (`standard` $\to$ `minimal` $\to$ `hidden` $\to$ `standard`).
- Add gamepad double-tap `R3` detection and long-press `View/Back` fallback.
- Update `LunarHUD.ts` and `hud.css` with `.hud-mode-minimal` and `.hud-mode-hidden` rules, smooth opacity transitions, pointer-events pass-through, and transient status toast feedback.
- Persist mode in `localStorage['lunar_frontier_hud_mode']`.

### Phase 6: Headless Smoke Verification Suite & Production Build Gate
- Author `scripts/smoke-eva-cleanup.ts` running in headless `NullEngine`:
  - Verify Stormtrooper suit mesh hierarchy, named plates, pauldrons, codpiece, boot soles, and PBR materials.
  - Verify unilateral alternating stride physics (left/right stride alternation, launch impulses, parabolic flight hangtime $\ge 0.9\text{s}$, and momentum restitution).
  - Verify alternating footfall dust puff coordinate dispatch.
  - Verify `[U]`, `[H]`, and double-tap `R3` keybinds, mode state transitions, DOM class toggles, and pointer-events rules.
- Run complete client build gate (`npm run build` in `games/lunar-frontier`).

---

## 4. Acceptance Criteria & Contract Gates

- [ ] **Gate 1: Stormtrooper Armor Silhouette & Materials:**
  - Suit avatar includes distinct pectoral carapace, segmented abdominal bands, utility belt, pauldrons, vambraces, thigh cuirasses, knee cops, greaves, and heavy boots (total mesh parts $\ge 32$).
  - Shoulder bell width spans $\ge 0.48\text{m}$ (broad athletic silhouette, zero stick-figure appearance).
  - Two-tone PBR material system binds high-gloss white composite armor over dark matte charcoal flexible gasket undersuit.
- [ ] **Gate 2: Mistborn Steelpush Alternating Locomotion:**
  - When moving at sprint speed ($v > 1.8\,\text{m/s}$), bounding operates on an alternating single-leg stride cycle (`left` $\to$ `right` $\to$ `left`).
  - Each push-off imparts vertical launch impulse $v_z \ge 1.50\,\text{m/s}$ and forward thrust boost $\ge 0.8\,\text{m/s}$.
  - Low-g flight arc produces single-leg air hangtime $\tau \ge 0.85\,\text{s}$ and ballistic apex $\Delta z \ge 0.60\,\text{m}$.
  - Ground contact retains $\ge 88\%$ forward momentum into the next push-off.
- [ ] **Gate 3: Kinetic Articulation & Alternating Dust Puffs:**
  - In flight, the pushing leg extends aft ($\theta_\text{hip} \le -0.40\,\text{rad}$) while the leading leg swings forward with flexed knee ($\theta_\text{hip} \ge 0.35\,\text{rad}$, $\theta_\text{knee} \ge 0.60\,\text{rad}$).
  - Arms swing in opposing athletic sprint counter-torque.
  - Boot-dust bursts trigger sequentially at alternating left/right sole coordinates on each footfall.
- [ ] **Gate 4: Clean UI & HUD Toggle System:**
  - Pressing `[U]` or `[H]` cycles cleanly between Standard, Minimal, and Hidden modes without releasing pointer lock.
  - Double-tap gamepad `R3` cycles HUD modes cleanly.
  - In Hidden mode, all HUD elements have `opacity: 0` and `pointer-events: none`.
  - Pressing `Escape` does NOT toggle HUD visibility; it dismisses open dialogs/maps only.
  - Active HUD mode persists across browser reload via `localStorage`.
- [ ] **Gate 5: Automated Verification & Build:**
  - `npx tsx scripts/smoke-eva-cleanup.ts` exits with code 0 and all checks passing.
  - Production build succeeds cleanly via `npm run build` with zero TypeScript or bundling errors.
