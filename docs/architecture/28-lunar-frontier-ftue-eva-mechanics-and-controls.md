# Architectural Blueprint: Spec 28 — FTUE, Retro-Modern EVA Suit, Low-G Bounding Mechanics & Controller Rectification

## 1. System Topology & Event Flow

```mermaid
flowchart TD
    subgraph Browser["Browser Client (Vite / Babylon.js)"]
        Boot["main.ts (boot)"] --> Decision{"Intro Completed?<br/>(localStorage / ?intro=1)"}
        Decision -->|No / ?intro=1| FTUE["IntroDirector & TransportLander"]
        Decision -->|Yes| Surface["Spawn on Surface"]
        
        FTUE --> Orbit["Orbit (6s)"]
        Orbit --> Burn["Retro-burn (12s)"]
        Burn --> Touchdown["Touchdown & Plume (3.5s)"]
        Touchdown --> Vent["Depressurize (4s, audio cut)"]
        Vent --> Ramp["Ramp Deploy (8s)"]
        Ramp --> Walkout["Walkout down ramp"]
        Walkout --> Boots["Boots on Regolith (Ramp Foot)"]
        
        Boots --> QuestInit["QuestEngine.startQuest('quest_one_way_ticket')"]
        QuestInit --> HUD["LunarHUD Comms Briefing & 3D Hint Arrow"]
        
        subgraph InputSubsystem["Input & Locomotion Pipeline"]
            PadPoll["Navigator.getGamepads()"] --> StandardCheck{"pad.mapping === 'standard'"}
            StandardCheck -->|Yes| DirectMapping["Direct Axes 0,1,2,3 & Buttons 6,7"]
            StandardCheck -->|No| LinuxFilter["Heuristic Trigger Isolation (Axes 4,5 ONLY)"]
            DirectMapping --> RadialDZ["Radial Deadzone (0.12) & Re-normalization"]
            LinuxFilter --> RadialDZ
            
            RadialDZ --> Traversal["TraversalPhysics (LunarEvaSuit)"]
            KeyInput["WASD / Space / Shift"] --> Traversal
            
            Traversal --> GaitCheck{"Speed > 1.8 m/s OR Sprint Held?"}
            GaitCheck -->|No| WalkMode["Ground Walk Mode (v <= 1.8 m/s)"]
            GaitCheck -->|Yes| BoundingMode["Lunar Bounding Arc (vz = +1.35 m/s, vz²/(2g) = 0.56m)"]
            
            BoundingMode --> Air["Ballistic Flight Arc (~0.8s hangtime)"]
            Air --> Contact["Regolith Landing & Boot Dust Puff"]
            Contact --> BoundRebound["Conserve Forward Momentum & Launch Next Bound"]
        end
        
        subgraph AvatarSubsystem["Retro-Modern EVA Suit Avatar"]
            Traversal --> SuitSync["AstronautSuit.syncTransform()"]
            SuitSync --> Torso["Tapered Composite Torso (r = 0.20m)"]
            SuitSync --> Arms["Dual Articulated Arms & Gauntlets"]
            SuitSync --> Visor["Panoramic Gold Visor (d = 0.36m, m = 0.98)"]
            SuitSync --> PLSS["Twin-Cylinder Contour PLSS Backpack"]
            SuitSync --> DynamicAnim["Bounding Leg & Arm Kinematics"]
        end
    end
```

---

## 2. Component Interfaces & Data Contracts

### 2.1 FTUE Client Configuration Contract (`ClientAppOptions`)
```typescript
export interface ClientAppOptions {
  username?: string;
  faction?: string;
  role?: string;
  wsUrl?: string;
  seed?: string;
  /** Force FTUE intro playback or suppression */
  introQuery?: string;
  /** Storage backend for intro completion persistence */
  introStorage?: Storage;
  /** When true, automatically mount TransportLander and IntroDirector at startup */
  autoAttachIntroDirector?: boolean;
}
```

### 2.2 Locomotion Bounding Kinematics (`SuitState` & `TraversalPhysics`)
```typescript
export type SuitGaitMode = 'idle' | 'walk' | 'bounding_launch' | 'bounding_flight' | 'bounding_land';

export interface SuitState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  heading: number;
  pitch: number;
  isGrounded: boolean;
  gaitMode: SuitGaitMode;
  boundCycleTimer: number;
  hangTime: number;
  // ... existing telemetry fields
}

export const SUIT_BOUND_LAUNCH_VZ = 1.35; // m/s upwards impulse
export const SUIT_BOUND_FORWARD_SPEED = 5.0; // m/s forward sprint velocity
export const SUIT_BOUND_RESTITUTION = 0.88; // forward momentum retention on contact
```

### 2.3 Gamepad Stick Protection Contract (`ClientApp.ts`)
```typescript
export interface GamepadProfile {
  ltBipolar: boolean;
  rtBipolar: boolean;
  /** Never allow axes[2] or axes[3] to be classified as sliders */
  isStandardMapping: boolean;
}
```

---

## 3. Note to Future Self: Hosting Portability

- The FTUE arrival sequence and lander asset are 100% procedurally synthesized in Babylon.js and require zero external GLB downloads or network calls.
- Gamepad handling strictly respects W3C Gamepad API conventions across Chrome, Firefox, Safari, and Steam Deck / Linux XInput drivers.
- Offline and single-player modes operate identically to multi-player network shards.
