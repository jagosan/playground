# Architectural Blueprint: Spec 29 — Lunar Frontier Radio Tower Landmark, Vertical Ladder Kinematics & High-Altitude Observation Deck

## 1. System Topology & Event Flow

```mermaid
flowchart TD
    subgraph WorldSubsystem["WorldScene Subsystem"]
        SceneInit["WorldScene.init()"] --> BuildTower["WorldScene.buildRadioTower(options)"]
        BuildTower --> RadioTowerInit["RadioTower.init(scene)"]
        RadioTowerInit --> LatticeMesh["Lattice Steel Truss (52m, 4 Pillars, X-Bracing)"]
        RadioTowerInit --> LadderRungs["137 Rungs (Pitch 0.35m) + Safety Cages"]
        RadioTowerInit --> TopDeck["Hexagonal Deck (+48.0m) & Safety Railings"]
        RadioTowerInit --> BeaconStrobe["Dual Red/White Pulse Beacons & Microwave Dishes"]
    end

    subgraph ClientLoop["ClientApp Frame Tick (60Hz)"]
        AvatarPos["Avatar Position (x, y, z)"] --> ProxCheck{"RadioTower.isNearLadderBase(pos)?<br/>OR isNearTopHatch(pos)?"}
        
        ProxCheck -->|No| ClearPrompt["Clear HUD Ladder Prompt"]
        ProxCheck -->|Yes (Near Base)| PromptClimb["LunarHUD: '[E] Climb Ladder'"]
        ProxCheck -->|Yes (Near Hatch)| PromptDescend["LunarHUD: '[E] Descend Ladder'"]
        
        PromptClimb --> KeyEdge{"[E] or Gamepad (X) Pressed?"}
        PromptDescend --> KeyEdge
        
        KeyEdge -->|Yes| MountTrigger["ClientApp: Mount Ladder Event"]
        MountTrigger --> SnapAvatar["Clamp XY to Ladder Rail + Offset"]
        SnapAvatar --> SetMode["TraversalPhysics: locomotionMode = 'CLIMBING'"]
        SetMode --> AudioLatch["LunarAudioSystem.playLadderLatch()"]
    end

    subgraph Kinematics["TraversalPhysics Climbing Engine"]
        SetMode --> ClimbLoop["Climb Tick: Input Y (W/S or Stick Y)"]
        ClimbLoop --> UpDown{"Input Direction?"}
        UpDown -->|W / Up| Ascend["vz = +2.2 m/s (Fast: +3.6 m/s)"]
        UpDown -->|S / Down| Descend["vz = -2.2 m/s"]
        UpDown -->|Neutral| Hold["vz = 0 m/s (Mechanical Hold, Zero Slide)"]
        
        Ascend --> CadenceCheck{"Step Cadence Met?"}
        Descend --> CadenceCheck
        CadenceCheck -->|Yes| AudioStep["LunarAudioSystem.playLadderStep()"]
        
        Ascend --> SummitCheck{"z >= z_deck (48.0m)?"}
        SummitCheck -->|Yes| StepOffDeck["Step 1.2m Forward onto Deck<br/>locomotionMode = 'WALK'"]
        StepOffDeck --> AudioSummit["LunarAudioSystem.playSummitChime()"]
        
        Descend --> GroundCheck{"z <= z_ground?"}
        GroundCheck -->|Yes| StepOffGround["Step 1.0m Back onto Regolith<br/>locomotionMode = 'WALK'"]
        
        ClimbLoop --> JumpEdge{"Space or Gamepad (A) Pressed?"}
        JumpEdge -->|Yes| HopImpulse["vz = +3.2 m/s Low-G Ladder Hop"]
        
        ClimbLoop --> DismountEdge{"[C] / Gamepad (B) / [E] Pressed?"}
        DismountEdge -->|Yes| DropFreefall["locomotionMode = 'AIRBORNE'<br/>Push vx,vy = 0.8 m/s off ladder<br/>Free low-g lunar fall"]
    end
```

---

## 2. Component Interfaces & Data Contracts

### 2.1 Radio Tower Configuration Contract (`RadioTowerOptions`)

```typescript
export interface RadioTowerOptions {
  /** Tower foundation world position (default: { x: -1550, y: 2320, z: 0 }). */
  worldPosition: { x: number; y: number; z: number };
  /** Total structural height including antenna mast (default: 52.0m). */
  towerHeightM: number;
  /** Observation deck elevation above base ground (default: 48.0m). */
  deckElevationM: number;
  /** Foundation footprint width at ground (default: 6.0m). */
  baseWidthM: number;
  /** Footprint width at summit neck (default: 2.2m). */
  topWidthM: number;
  /** Facing angle of the access ladder in world radians (default: pointing South-East toward tracks). */
  ladderFacingRad: number;
  /** Color theme for warning beacons and corporate accents. */
  beaconColor: { r: number; g: number; b: number };
}

export const RADIO_TOWER_DEFAULTS: Readonly<RadioTowerOptions> = Object.freeze({
  worldPosition: Object.freeze({ x: -1550, y: 2320, z: 0 }),
  towerHeightM: 52.0,
  deckElevationM: 48.0,
  baseWidthM: 6.0,
  topWidthM: 2.2,
  ladderFacingRad: -Math.PI / 4, // 315 deg, facing south-east
  beaconColor: Object.freeze({ r: 1.0, g: 0.15, b: 0.1 }),
});
```

### 2.2 Ladder Bounds & Proximity Envelope Contract (`LadderBounds`)

```typescript
export interface LadderBounds {
  /** Foundation base coordinate of the ladder rungs. */
  basePosition: { x: number; y: number; z: number };
  /** Summit deck threshold coordinate where ladder reaches platform trapdoor. */
  topPosition: { x: number; y: number; z: number };
  /** Outward normal vector perpendicular to ladder rungs (pointing away from tower core). */
  facingNormal: { x: number; y: number };
  /** Transverse width of each rung (default: 0.60m). */
  rungWidthM: number;
  /** Total rung count from base to top deck. */
  totalRungs: number;
  /** Total climbable height span (m). */
  climbHeightM: number;
}
```

### 2.3 Traversal Physics Mode Contract

```typescript
export type LocomotionMode = 'WALK' | 'SPRINT' | 'BOUND' | 'AIRBORNE' | 'CLIMBING';

export interface LadderClimbCommand {
  /** Vertical throttle: +1 (ascend), -1 (descend), 0 (stationary hold). */
  verticalThrottle: number;
  /** Sprint modifier active for fast ascent. */
  fastClimb: boolean;
  /** Jump input edge for low-g ladder hop. */
  hopImpulse: boolean;
  /** Dismount input edge to let go and drop. */
  dismountRelease: boolean;
}
```

---

## 3. Spatial & Geometric Coordination

### 3.1 Citadel & Maglev Spatial Buffer Verification
- **Citadel Monolith Seat:** $(-1850, 2400)$
- **Tower Seat:** $(-1550, 2320)$
- **Vector Difference:** $(\Delta x = +300\text{m}, \Delta y = -80\text{m})$
- **Euclidean Separation:**
  $$d_\text{citadel} = \sqrt{300^2 + (-80)^2} = \sqrt{90000 + 6400} = \sqrt{96400} \approx 310.48\,\text{m}$$
- **Safety Margin:**
  - $d_\text{citadel} - R_\text{shield} = 310.48 - 220.0 = +90.48\,\text{m}$ (well clear of forcefield bounce)
  - $d_\text{citadel} - R_\text{warning} = 310.48 - 260.0 = +50.48\,\text{m}$ (no false intruder alerts during climbing)
- **Maglev Clearance:** The maglev track spline passes south of the tower at approximately $y \approx 2285\text{m}$, creating a $35\text{m}$ horizontal clearance envelope ensuring no physical collision between passing train geometry and the tower structure.

### 3.2 Observation Deck Viewport Angles
From the top platform at $z = +48.0\text{m}$:
- **Citadel View (Bearing $\approx 285^\circ$):** Pitch angle to Citadel summit ($85\text{m}$ high at $310\text{m}$):
  $$\theta_\text{citadel\_apex} = \arctan\left(\frac{85 - 48}{310.5}\right) = \arctan\left(\frac{37}{310.5}\right) \approx +6.8^\circ$$
  The massive monolith fills approximately $15^\circ$ of vertical field-of-view, framed by the blue kinetic shield shimmer.
- **Maglev Guideway View (Bearing $\approx 195^\circ$):** Pitch angle down to elevated track ($6\text{m}$ high at $35\text{m}$ horizontal):
  $$\theta_\text{track} = \arctan\left(\frac{6 - 48}{35}\right) = \arctan\left(\frac{-42}{35}\right) \approx -50.2^\circ$$
  Provides a dramatic raking down-angle as the Apex Express rushes beneath the tower.

---

## 4. Headless Smoke Test Verification Architecture

The test harness `scripts/smoke-radio-tower.ts` runs on `NullEngine` and evaluates four primary assertion blocks:
1. **Structural Assembly & Memory Safety:**
   - Construct `RadioTower` with default and custom options.
   - Assert $\ge 80$ procedural mesh nodes instantiated.
   - Verify materials (`lattice-titanium`, `grate-deck`, `beacon-strobe`, `dish-composite`).
   - Call `dispose()` and assert all meshes, materials, and root nodes are freed with zero memory leaks.
2. **Mathematical Ladder Invariants:**
   - Verify `getLadderBounds()` returns exact base, top, normal, and rung count.
   - Assert `isNearLadderBase()` returns `true` within $1.8\text{m}$ and `false` at $2.5\text{m}$.
   - Assert `isNearTopHatch()` returns `true` within $1.0\text{m}$ of platform trapdoor.
3. **Climbing Kinematics Simulation:**
   - Mount ladder at base ($z = 0$).
   - Step forward throttle for $5.0\,\text{s}$ at standard climb rate ($2.2\,\text{m/s}$): assert $z \approx 11.0\text{m}$.
   - Neutral throttle for $2.0\,\text{s}$: assert $z$ remains strictly unchanged ($v_z = 0$, zero downward slide).
   - Sprint throttle to summit ($z \ge 48.0\text{m}$): assert automatic transition to `STEP_TO_DECK` and grounded `WALK` mode at deck elevation.
   - Test jump impulse and dismount release ballistics into parabolic lunar arc ($g = 1.62\,\text{m/s}^2$).
4. **Vite Bundle Build Gate:**
   - Execute `npm run build` in `games/lunar-frontier` and assert 0 exit code with zero type diagnostics.
