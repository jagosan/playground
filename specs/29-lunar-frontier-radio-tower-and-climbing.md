# Spec 29: Lunar Frontier Radio Tower Landmark, Vertical Ladder Kinematics & High-Altitude Observation Deck

## 1. Executive Summary & Narrative Vision

As Lunar Frontier expands its surface infrastructure beyond isolated facilities, recognizable spatial landmarks are required to anchor player navigation across the rugged regolith. While Spec 26 established the imposing central X-Corp Citadel monolith and high-speed maglev guideway, players exploring on foot (EVA) or in the open buggy currently lack vertical traversal opportunities and elevated vantage points outside of vehicle cockpits.

This specification introduces the **Frontier Radio Tower** (designated *X-Corp Transmission Relay 04*), a prominent 52-metre open-lattice titanium communication spire positioned adjacent to the high-speed maglev rail line within sight of the X-Corp Citadel megacorp headquarters.

Key deliverables include:
1. **Prominent Navigational Landmark:** A 52m tapered four-leg triangular/quad lattice steel tower located at world coordinates $(x: -1550, y: 2320)$, approximately 330m east of the Citadel monolith and 35m lateral to the maglev tracks. Features dual microwave transceivers, dish arrays, and pulsed dual-strobe red/white aviation warning beacons visible from >3km across the lunar horizon.
2. **Vertical Ladder Kinematics Subsystem:** A responsive, physics-grounded ladder climbing mechanic in `TraversalPhysics.ts` and `ClientApp.ts`. When an astronaut on foot approaches the ladder base within interaction radius, pressing `[E]` (or Gamepad `(X)`) latches onto the ladder rungs into a dedicated `CLIMBING` locomotion mode with vertical ascent/descent, zero lateral slip, low-g impulse dismounts, and procedural magnetic boot-clamp audio.
3. **High-Altitude Observation Deck:** A 5m wide hexagonal steel-grate gantry platform situated at $+48.0\text{m}$ elevation featuring safety toe-boards, perimeter railings ($1.1\text{m}$ high), a ladder hatch opening, a dormant broadcast telemetry console, and an unobstructed 360-degree panoramic vista overlooking the X-Corp Citadel, kinetic shield dome, passing Apex Express maglev train, and surrounding cratered mare.
4. **Headless Smoke Acceptance Suite:** Deterministic verification suite (`scripts/smoke-radio-tower.ts`) exercising procedural mesh assembly, mathematical bounds, ladder proximity volumes, ascent/descent state transitions, dismount ballistics, and idempotent disposal on `NullEngine`.

---

## 2. Mathematical, Spatial & Physical Foundations

### 2.1 Spatial World Placement & Coordinates
The Radio Tower is placed in the highland basin transitional plain between the primary mining territory and the X-Corp Citadel:

```
                          [ X-Corp Citadel Monolith ]
                               (-1850, 2400)
                                     │
                     ◄── 330m ───────┼──────────────►
                                     │
                                     ▼
                            [ RADIO TOWER ]
                            (-1550, 2320)
                                 │   ▲
                                 │   │ ~35m offset
                                 ▼   │
   ══════════════════════════════════════════════════════════════► (To Canyon Outpost)
                   [ High-Speed Maglev Guideway ]
```

- **Tower Base World Position:**
  $$\vec{P}_\text{tower} = (-1550.0, 2320.0, z_\text{terrain})$$
  Where $z_\text{terrain}$ is sampled directly from `WorldScene.getTerrainHeight(-1550, 2320)` to ensure rigid ground anchoring without floating.
- **Citadel Clearance:** At a 2D Euclidean distance of $d = \sqrt{(-1550 - (-1850))^2 + (2320 - 2400)^2} = \sqrt{300^2 + (-80)^2} \approx 310.5\text{m}$, the tower sits safely outside the Citadel CIWS lethal radius ($180\text{m}$) and kinetic shield dome ($220\text{m}$), and just outside the primary warning zone ($260\text{m}$), allowing safe un-harassed approach and climbing.
- **Track Clearance:** Positioned approximately 35m north of the maglev track spline, providing a dramatic down-look angle at passing freight consists and the high-speed Apex Express.

### 2.2 Structural Dimensions & Geometry
- **Total Tower Height ($H_\text{total}$):** $52.0\text{m}$ from foundation pads to the tip of the lightning arrestor / antenna mast.
- **Base Footprint:** Square footprint of $6.0\text{m} \times 6.0\text{m}$ tapering linearly to $2.2\text{m} \times 2.2\text{m}$ at the base of the top observation gantry ($z = +47.5\text{m}$).
- **Truss Construction:** 4 main corner tubular struts ($r = 0.08\text{m}$) braced with alternating diagonal X-lattices ($r = 0.03\text{m}$) divided into 8 vertical bays of $\approx 6.0\text{m}$ each.
- **Top Platform Deck:** Hexagonal catwalk platform:
  - Deck Elevation: $z_\text{deck} = z_\text{terrain} + 48.0\text{m}$.
  - Deck Span: $5.0\text{m}$ outer diameter, perforated industrial steel grating material.
  - Safety Railings: Perimeter tubular handrail ($h = 1.1\text{m}$) with mid-rail ($h = 0.55\text{m}$) and kick-plate ($h = 0.15\text{m}$).
  - Trapdoor / Access Hatch: $0.9\text{m} \times 0.9\text{m}$ clear opening on the ladder entry face allowing direct walkout onto the deck.
- **Antenna Spire & Microwave Relays:**
  - Center mast extending from $+48.0\text{m}$ to $+52.0\text{m}$ topped by an omnidirectional dipole array and an anti-collision aviation strobe beacon.
  - Dual parabolic microwave dishes ($d = 1.6\text{m}$, depth $0.4\text{m}$) mounted at $+38.0\text{m}$ and $+46.0\text{m}$, aimed toward the orbital trajectory axis and the Citadel comms receiver.

### 2.3 Ladder Geometry & Interaction Envelope
- **Placement Face:** Mounted flush against the South-East face (facing the maglev tracks for optimal spectator sightlines during climbing).
- **Rung Specifications:**
  - Width: $0.60\text{m}$ wide horizontal rungs ($r = 0.02\text{m}$).
  - Spacing: Uniform pitch $\Delta z_\text{rung} = 0.35\text{m}$.
  - Total Rungs: 137 rungs extending from $z = z_\text{terrain} + 0.35\text{m}$ to $z = z_\text{terrain} + 48.0\text{m}$.
  - Offset: Projecting $0.25\text{m}$ outward from the main truss face.
- **Safety Cages / Hoops:** Circular safety hoops ($r = 0.45\text{m}$) spaced every $2.1\text{m}$ vertically starting at $+3.0\text{m}$ above ground level to the top platform deck.
- **Interaction Zone:**
  - Base Proximity Cylinder: Radius $r_\text{detect} = 1.8\text{m}$ centered at the ladder base, height $2.5\text{m}$.
  - Angular Alignment: Player yaw facing within $\pm 75^\circ$ of the ladder normal vector.

---

## 3. Ladder & Climbing Kinematics Engine

### 3.1 Locomotion State Machine Integration
In `TraversalPhysics.ts`, introduce an explicit `CLIMBING` locomotion state into `LocomotionMode`:
```typescript
export type LocomotionMode = 'WALK' | 'SPRINT' | 'BOUND' | 'AIRBORNE' | 'CLIMBING';
```

```
           [ EVA Walk / Sprint / Bound ]
                        │
      (Within 1.8m & [E] / Pad X pressed)
                        │
                        ▼
                [ MOUNT_LADDER ]
          (Snap avatar to ladder axis)
                        │
                        ▼
                 [ CLIMBING ] ◄──────────────────┐
                 │          │                    │
          (Move W / Up) (Move S / Down)     (Ascend / Descend)
                 │          │                    │
                 ▼          ▼                    │
      [ Reach Summit ]  [ Reach Base ]           │
      (z >= z_deck)     (z <= z_ground)          │
            │                  │                 │
            ▼                  ▼                 │
   [ STEP_TO_DECK ]     [ STEP_TO_GROUND ]       │
            │                  │                 │
            ▼                  ▼                 │
     [ EVA on Deck ]    [ EVA on Regolith ]      │
            │                                    │
    (Walk into hatch) ───────────────────────────┘
```

### 3.2 Climbing Kinematics & Input Constraints
When `locomotionMode === 'CLIMBING'`:
1. **Lateral Axis Locking:**
   - The avatar's horizontal coordinates $(x, y)$ are rigidly clamped to the ladder climbing rail offset:
     $$\vec{P}_{xy}(t) = \vec{P}_\text{ladder\_base} + \vec{n}_\text{ladder} \cdot 0.30\text{m}$$
   - Lateral movement inputs (strafe `A`/`D` or Left Stick X) are muted during standard climbing to prevent slipping off the ladder rail.
2. **Vertical Velocity Integration:**
   - Forward/Backward inputs (`W`/`S` or Left Stick Y) drive vertical translation:
     $$v_z = \text{input}_y \cdot v_\text{climb\_speed}$$
     Where standard climbing speed is $v_\text{climb\_speed} = 2.2\,\text{m/s}$.
   - Holding Sprint (`Shift` / Gamepad `LB`) accelerates vertical ascent:
     $$v_\text{fast\_climb} = 3.6\,\text{m/s}$$
   - When no vertical input is applied, vertical velocity immediately drops to zero ($v_z = 0$) with mechanical hold; the suit does not slide down under gravity while latched to rungs.
3. **Lunar Low-G Hop / Push-Off:**
   - Pressing Jump (`Space` / Gamepad `A`) while climbing executes an explosive low-g rung hop:
     $$v_{z,\text{hop}} = +3.2\,\text{m/s}$$
     Carrying the player up $\approx 3.0\text{m}$ in a buoyant ballistic hop before re-latching to rungs or entering free-fall.
4. **Emergency Dismount / Fall Release:**
   - Pressing Cancel (`[C]` / Gamepad `(B)`) or tapping Mount (`[E]` / Gamepad `(X)`) while on the ladder immediately releases the magnetic latch:
     - State transitions to `AIRBORNE`.
     - An outward push velocity of $0.8\,\text{m/s}$ along $\vec{n}_\text{ladder}$ is imparted to clear the ladder rungs.
     - The astronaut enters normal low-g lunar parabolic descent ($g = 1.62\,\text{m/s}^2$) subject to standard terrain/deck collision restitution.
5. **Deck Summit Transition:**
   - When $z \ge z_\text{deck} - 0.1\text{m}$ with positive vertical climb velocity ($v_z > 0$):
     - Trigger automatic summit step-off sequence.
     - Move avatar forward by $1.2\text{m}$ along $-\vec{n}_\text{ladder}$ onto the observation platform deck.
     - Set $z = z_\text{deck}$, clear climbing mode, and restore standard grounded `WALK` state.
6. **Deck-to-Ladder Mounting:**
   - When the player is on the observation deck and steps into the hatch perimeter ($r \le 0.8\text{m}$ from hatch center) facing the ladder, an on-screen prompt displays `[E] Descend Ladder`. Pressing `[E]` latches the player at $z = z_\text{deck} - 0.2\text{m}$ facing the tower.

---

## 4. Architectural Integration & Component Interfaces

### 4.1 Structural Architecture & Module Roles

```
┌────────────────────────────────────────────────────────────────────────┐
│                        WorldScene.ts (Babylon.js)                      │
│   • buildRadioTower(options: Partial<RadioTowerOptions>): RadioTower   │
│   • getRadioTower(): RadioTower | null                                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ mounts
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   src/infrastructure/RadioTower.ts                     │
│   • Tower structural lattice mesh generation                           │
│   • Rungs & safety hoops procedural geometry                           │
│   • Observation deck platform & railings                               │
│   • Microwave dishes, aviation strobe beacon animation                 │
│   • Pure mathematical queries: getLadderBounds(), isNearLadder(),      │
│     getClimbPositionAtHeight(), isNearTopHatch(), getDeckElevation()   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ queried by
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 src/physics/TraversalPhysics.ts                        │
│   • LocomotionMode 'CLIMBING' state handling                           │
│   • Pure vertical translation and ladder kinematic lock                │
│   • Step-to-deck and step-to-ground transitions                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ driven by
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     src/client/ClientApp.ts                            │
│   • Edge detection for [E] / Gamepad (X) mount/dismount                │
│   • HUD prompt registration and altitude display                       │
│   • Sound event dispatches to LunarAudioSystem                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ visualizes via
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      src/ui/LunarHUD.ts & hud.css                      │
│   • Proximity prompt: "[E] Climb Ladder" / "[E] Descend Ladder"        │
│   • Climbing altimeter tape: "ALT +42.5m [DECK: 48m]"                  │
│   • Landmark notification: "FRONTENIER RELAY 04"                       │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Module Contracts & Interfaces

#### 4.2.1 `src/infrastructure/RadioTower.ts`
```typescript
export interface RadioTowerOptions {
  worldPosition: { x: number; y: number; z: number };
  towerHeightM: number;
  deckElevationM: number;
  baseWidthM: number;
  topWidthM: number;
  ladderFacingRad: number;
}

export interface LadderBounds {
  basePosition: { x: number; y: number; z: number };
  topPosition: { x: number; y: number; z: number };
  facingNormal: { x: number; y: number };
  rungWidthM: number;
  totalRungs: number;
  climbHeightM: number;
}

export class RadioTower {
  constructor(options?: Partial<RadioTowerOptions>);
  init(scene: Scene): this;
  dispose(): void;

  // Pure mathematical queries (functional without WebGL / on NullEngine)
  getLadderBounds(): LadderBounds;
  isNearLadderBase(pos: { x: number; y: number; z: number }, radiusM?: number): boolean;
  isNearTopHatch(pos: { x: number; y: number; z: number }, radiusM?: number): boolean;
  isWithinClimbEnvelope(pos: { x: number; y: number; z: number }): boolean;
  getDeckElevation(): number;
  getWorldPosition(): { x: number; y: number; z: number };

  // Frame tick for beacon pulse animation
  update(deltaS: number): void;
}
```

#### 4.2.2 `src/physics/TraversalPhysics.ts`
Extend `TraversalPhysicsState` and `TraversalPhysicsOptions` to support the ladder climbing regime:
```typescript
export interface TraversalPhysicsState {
  // Existing fields...
  locomotionMode: 'WALK' | 'SPRINT' | 'BOUND' | 'AIRBORNE' | 'CLIMBING';
  climbProgressM: number; // Vertical metres climbed along active ladder
  climbRate: number;      // m/s (+ climbing up, - climbing down)
  ladderLatchActive: boolean;
}
```

#### 4.2.3 `src/audio/LunarAudioSystem.ts`
Procedural Web Audio additions for vertical traversal:
- `playLadderLatch()`: Heavy metallic magnetic boot clamp latch sound ($180\,\text{Hz}$ damped clang with ceramic click).
- `playLadderStep()`: Periodic boot contact click ($240\,\text{Hz}$, rhythmic $0.35\,\text{s}$ cadence during climb).
- `playSummitChime()`: Subtle high-frequency atmospheric chime ($880\,\text{Hz} \to 1320\,\text{Hz}$) upon reaching the observation deck.

---

## 5. Phased Implementation Plan

### Phase 1: Mathematical Foundations & Symbol Map Registration
- **Task:** Define `RadioTowerOptions`, `LadderBounds`, and coordinate contracts in `RadioTower.ts`.
- **Files:** `src/infrastructure/RadioTower.ts`, `docs/architecture/29-lunar-frontier-radio-tower-and-climbing.md`, `docs/MAP.md`.
- **Verification:** Unit assertions on pure coordinate transforms, distances from X-Corp Citadel and maglev tracks, and ladder collision boundaries.

### Phase 2: Procedural Radio Tower 3D Asset & Summit Platform Assembly
- **Task:** Build procedural lattice steel tower meshes, corner pillars, horizontal crossbeams, ladder rungs, safety hoops, top hexagonal catwalk platform, perimeter handrails, microwave dish antennas, and blinking beacon strobe.
- **Files:** `src/infrastructure/RadioTower.ts`, `src/engine/WorldScene.ts`.
- **Verification:** Headless `NullEngine` instantiation testing: verify mesh hierarchy, material bindings, PBR rough metallic shaders, and zero memory leaks upon `dispose()`.

### Phase 3: Ladder Interaction Volume & Climbing Kinematics Engine
- **Task:** Implement `CLIMBING` locomotion mode in `TraversalPhysics.ts`. Support axis locking, vertical climb velocity with sprint boost, mechanical zero-slide hold, and low-g impulse hop.
- **Files:** `src/physics/TraversalPhysics.ts`, `src/client/ClientApp.ts`.
- **Verification:** Headless kinematics simulation validating vertical progression, boundary clamping, and low-g push-off ballistics.

### Phase 4: Avatar Climbing Visuals, Top Platform Collision & Viewpoint Polish
- **Task:** Align `AstronautSuit.ts` climbing posture and alternating limb movement during vertical ascent. Implement rigid deck collision and hatch pass-through on the top platform. Tune `CameraRig.ts` framing during high-altitude elevation.
- **Files:** `src/entities/AstronautSuit.ts`, `src/engine/CameraRig.ts`, `src/client/ClientApp.ts`.
- **Verification:** Avatar height tracking at $z = +48.0\text{m}$, deck walk boundary bounds, camera pitch freedom while clinging to rungs.

### Phase 5: Procedural Audio, Comms Landmark Telemetry & HUD Elevation Meter
- **Task:** Wire procedural Web Audio cues for magnetic rung clamps and summit chime. Add HUD prompt for ladder mount/dismount and dynamic vertical altimeter tape.
- **Files:** `src/audio/LunarAudioSystem.ts`, `src/ui/LunarHUD.ts`, `src/ui/hud.css`.
- **Verification:** HUD prompt transitions on proximity, audio synthesizer trigger verification without browser audio hardware crashes.

### Phase 6: Headless Smoke Verification Suite & Central Build Gate
- **Task:** Author comprehensive smoke test harness `scripts/smoke-radio-tower.ts` (aiming for $\ge 60$ distinct checks) validating tower geometry, ladder climbing transitions, dismount ballistics, and memory cleanup. Verify production Vite build.
- **Files:** `scripts/smoke-radio-tower.ts`, `package.json`.
- **Verification:** `npx tsx scripts/smoke-radio-tower.ts` passes 100% green; `npm run build` exits 0.

---

## 6. Acceptance Gates & Verification Criteria

1. **Procedural Assembly & Geometry Gate:**
   - Radio Tower instantiates with base at $(-1550, 2320)$ and summit deck at $+48.0\text{m}$.
   - Ladder rungs count $\ge 120$ spaced uniformly at $\Delta z \le 0.40\text{m}$.
   - Mesh hierarchy cleans up completely on `tower.dispose()` with zero orphaned nodes or materials.
2. **Proximity & Detection Envelope Gate:**
   - Approaching within $1.8\text{m}$ of ladder base triggers `isNearLadderBase() === true`.
   - Approaching within $1.0\text{m}$ of top platform hatch triggers `isNearTopHatch() === true`.
   - Outside envelope yields `false`.
3. **Climbing Kinematics Gate:**
   - Latching onto ladder locks horizontal $(x, y)$ coordinates to the ladder rail plane ($\Delta xy \le 0.05\text{m}$).
   - Vertical climb speed reaches $2.2 \pm 0.3\,\text{m/s}$ in standard mode and $3.6 \pm 0.4\,\text{m/s}$ in sprint climb mode.
   - Releasing throttle maintains altitude ($v_z = 0$) without downward drift.
   - Jump impulse while climbing initiates ballistic ascent of $\ge 2.5\text{m}$ apex.
   - Crossing $z \ge 48.0\text{m}$ smoothly steps the player onto the observation deck and restores grounded locomotion.
4. **Headless Execution & Build Gate:**
   - Smoke suite `scripts/smoke-radio-tower.ts` executes deterministically in Node.js on `NullEngine` without WebGL or audio hardware dependencies.
   - `npm run build` passes with zero TypeScript diagnostics or bundling errors.
