# Architecture 17: Lunar Buggy Terrestrial Proving Grounds & Driving Simulation Refinement

> **Spec Reference:** `specs/17-lunar-buggy-simulation-track-and-control-refinement.md`  
> **Target Subsystems:** `games/lunar-frontier/src/engine/ProvingGroundsScene.ts`, `physics/TraversalPhysics.ts`, `entities/OpenBuggy.ts`, `engine/CameraRig.ts`, `client/ClientApp.ts`, `ui/LunarHUD.ts`.

---

## 1. System Architecture & Component Interaction

```mermaid
graph TD
    subgraph Input & UX Layer
        GP[Gamepad API / Analog Triggers] -->|Filtered & Exponential| CTRL[ClientApp Input Sampler]
        KB[Keyboard & Mouse] --> CTRL
        HAPTIC[GamepadHapticActuator] <--|Slip & Curb Rumble| CTRL
    end

    subgraph Simulation & Core Physics
        CTRL -->|BuggyInput| TP[TraversalPhysics: LunarBuggy]
        ENV[EnvironmentProfile: Earth vs Lunar] --> TP
        TP -->|Pacejka Lateral Slip & Steering Lock| DYN[Vehicle Dynamic Solver]
        DYN -->|ABS & Torque Vectoring| DYN
    end

    subgraph 3D Presentation & Camera
        DYN -->|Telemetry & Transform| BUGGY[OpenBuggy 3D Assembly]
        DYN -->|Position, Yaw, Velocity Vector| CR[CameraRig: vehicle_chase]
        CR -->|Above-and-Behind Viewport| CAM[Babylon.js Camera]
    end

    subgraph Environment & Track
        PGS[ProvingGroundsScene] -->|Track Spline & Curbs| TRACK[Asphalt Ribbon & Checkpoints]
        TRACK -->|Checkpoints & Lap Splits| HUD[LunarHUD Telemetry Overlay]
    end
```

---

## 2. Interface Contracts & Schemas

### 2.1 Environmental Profile & Physics Config (`TraversalPhysics.ts`)

```typescript
export interface EnvironmentProfile {
  name: 'earth_proving_grounds' | 'lunar_frontier';
  gravity: number;             // m/s² (Earth: 9.81, Moon: 1.62)
  surfaceFrictionMu: number;   // Coefficient of friction (Asphalt: 1.05, Regolith: 0.68)
  airResistanceCdA: number;    // Aerodynamic drag area (m²)
  tireRollingResistance: number;
}

export interface BuggyDynamicTuning {
  speedSteerHalfMps: number;   // Speed at which steering lock is halved (default 10.0 m/s)
  steerLockLowDeg: number;     // Low-speed steering lock (default 45 deg)
  steerLockHighDeg: number;    // High-speed steering lock (default 14 deg)
  absPulsingHz: number;        // ABS pulse frequency (default 15 Hz)
  frontBrakeBias: number;      // Front axle brake proportion (default 0.62)
  yawAssistTorque: number;     // Low-speed torque vectoring authority
}
```

### 2.2 Proving Grounds Track & Lap System (`ProvingGroundsScene.ts`)

```typescript
export interface TrackWaypoint {
  x: number;
  y: number;
  z: number;
  bankAngleRad: number;
  trackWidthM: number;
  isCheckpoint: boolean;
  sectorIndex?: number;
}

export interface LapTelemetry {
  currentLap: number;
  currentLapTimeS: number;
  bestLapTimeS: number | null;
  lastLapTimeS: number | null;
  sectorTimesS: number[];
  currentSpeedKmh: number;
  topSpeedKmh: number;
}
```

---

## 3. Architectural Decision Records (ADRs)

### ADR 1: Isolated Terrestrial Proving Grounds vs Modifying Lunar World
- **Context:** Tuning buggy kinematics directly on low-gravity, bumpy lunar heightfields creates feedback ambiguity between suspension bounces, low-g liftoff, and tire slip.
- **Decision:** Build a standalone, clean-room asphalt racetrack scene (`ProvingGroundsScene.ts`) operating under Earth gravity ($9.81\,\text{m/s}^2$). Provide an instant mode-switch in the client (`Proving Grounds` vs `Lunar Surface`).
- **Consequence:** Allows isolated, objective tuning of steering response, brake feel, controller deadzones, and camera tracking. Once perfected, calibrated values are ported to lunar conditions by adapting gravity and suspension stiffness.

### ADR 2: Velocity-Vector Lookahead Camera vs Pure Yaw Locking
- **Context:** Rigid chase cameras aligned strictly to vehicle chassis yaw cause disorientation during high-speed drifts, hiding the road ahead and making counter-steering difficult.
- **Decision:** Blend camera target azimuth toward the vehicle's instantaneous velocity vector ($\mathbf{v}_{\text{long}} + \mathbf{v}_{\text{lat}}$). Elevate camera height to $3.8\,\text{m}$ with a downward pitch of $-18^\circ$.
- **Consequence:** The camera intuitively anticipates drifts and corner exits, framing apexes in the upper third of the screen and providing an immersive, controllable driving perspective.

---

## 4. 💡 Note to Future Self: Hosting Portability

The `ProvingGroundsScene` and `OpenBuggy` visual upgrades operate completely client-side in Babylon.js with pure TypeScript physics in `TraversalPhysics.ts`. No Node-specific or native binaries are required. The driving simulation runs identically in standard WebGL2/WebGPU browsers on desktop, Steam Deck, or mobile handhelds, and requires zero cloud infrastructure.

---
