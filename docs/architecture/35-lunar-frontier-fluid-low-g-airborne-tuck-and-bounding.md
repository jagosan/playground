# Architecture Blueprint 35: Fluid Low-G Airborne Leg Tuck & Kinematic Bounding Rectification

## System Topology & Component Interactions

```mermaid
flowchart TD
    subgraph InputLayer [Input & Triggers]
        KB[Keyboard: KeyC / Ctrl]
        GP[Gamepad: B / LB]
        TC[Touch UI: #btn-touch-tuck]
    end

    subgraph StateMachine [TraversalPhysics.ts]
        TP[Airborne Gait State Machine]
        AIR{isGrounded == false\ngaitMode == bounding}
        PHASE[Normalized Air Phase: u = t_air / τ_flight]
    end

    subgraph Kinematics [AstronautSuit.ts]
        TUCK[Acrobatic Tuck Envelope]
        SMOOTH[Quintic Smoothstep Blending: W_tuck]
        JOINTS[Bilateral Joint Articulation\n• Hips flex forward/up: -1.20 rad\n• Knees fold tight: +1.80 rad\n• Elbows tuck: -1.35 rad\n• Root flip: STRICT ZERO]
        POSE[hurryStridePose Execution]
    end

    subgraph Rendering [Babylon.js WorldScene & Rig]
        ROOT[Avatar Root Mesh\nPitch clamped to 8°-12° rake]
        MESH[Suit Bones & Meshes]
    end

    InputLayer --> TP
    TP --> AIR
    AIR --> PHASE
    PHASE --> TUCK
    TUCK --> SMOOTH
    SMOOTH --> JOINTS
    JOINTS --> POSE
    POSE --> ROOT
    POSE --> MESH
```

## Mathematical Formulations
- **Tuck Blending Curve:** $W_\text{tuck}(u)$ parameterized by quintic smoothstep $S(x) = 6x^5 - 15x^4 + 10x^3$ across $u \in [0.15, 0.90]$.
- **Root Pitch Decoupling:** Somersault pitch $\Delta\theta_\text{flip} \equiv 0$. Root orientation strictly driven by camera heading and velocity rake vector.
- **Continuous Velocity Preservation:** Forward momentum is completely conserved during tuck, guaranteeing ballistic parabolic trajectories are unperturbed by limb kinematics.

## File Manifest & Responsibility Map
- `games/lunar-frontier/src/entities/AstronautSuit.ts`: Pose generation, tuck envelope constants, smoothstep blending functions.
- `games/lunar-frontier/src/physics/TraversalPhysics.ts`: State management and airborne phase tracking.
- `games/lunar-frontier/scripts/smoke-spec35-airborne-tuck.ts`: Headless NullEngine assertion test harness.
