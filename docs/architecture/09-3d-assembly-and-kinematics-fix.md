# Architecture Blueprint: Artemis LTV 3D Assembly & Kinematics Rectification

**Document ID:** `docs/architecture/09-3d-assembly-and-kinematics-fix.md`  
**Status:** Approved  
**Author:** 🦉 Owl (System Architect & Outer Loop Orchestrator)  
**Date:** 2026-09-07  

---

## 1. Root Cause Analysis (Forensic Diagnostic)

Inspection of `scripts/lunar_assets/rover_builder.py`, `ApolloRoverModel.ts`, `RoboticArmController.ts`, and the binary glTF node graph of `apollo_lrv.glb` revealed three interrelated structural and kinematic defects:

### 1.1 Inverted Longitudinal Coordinates (Vehicle Facing Backwards)
- **Defect:** In `rover_builder.py`, the vehicle was authored with its front at Blender $-Y$ (e.g. `Bullbar_Bumper` at $y = -1.74$) and rear at Blender $+Y$ (e.g. `CargoBed` at $y = +0.88$).
- **glTF Transformation:** Blender's Khronos glTF exporter maps Blender $(X, Y, Z)$ to glTF $(X, Z, -Y)$ (where $Z_{\text{gltf}} = -Y_{\text{blender}}$). Consequently, the front ended up at glTF $z = +1.74$ (Three.js rear) and rear at glTF $z = -0.88$ (Three.js front).
- **Impact:** The 3D model was facing $180^\circ$ backwards relative to the physics forward vector (Three.js $-Z$), camera chase orientation, and steering geometry.

### 1.2 Wheel Orientation & Double-Offset Lateral Translation ("Floating Wheels")
- **Wheel Geometry Defect:** In `rover_builder.py`, wheels were added via `add_cyl(..., rot=(0, 0, math.radians(90)))`. In Blender, a cylinder primitive defaults to the $Z$ axis. Rotating around $Z$ leaves its axis along $Z$ ($Y$ in glTF). Consequently, the wheel cylinder was lying flat horizontally like a coin, rather than standing vertically on its $X$ axle.
- **Hierarchy Misconception & Double Offset:** The author of `ApolloRoverModel.ts` assumed that Blender's glTF exporter flattened the node hierarchy and wrote:
  ```typescript
  gltfWheel.position.copy(wheelPositions[i]);
  ```
  However, the glTF exporter preserved the full parent-child hierarchy: `LRV_Root -> Chassis -> SteeringKnuckle_* -> Wheel_*`.
  `SteeringKnuckle_*` was already placed at $(x_{\text{axle}}, y_{\text{axle}}, z_{\text{axle}})$. Copying the absolute vehicle wheel offset into `Wheel_*` displaced it by double the track width and wheelbase ($x = \pm 1.02 + \pm 1.02 = \pm 2.04\text{m}$), causing all 4 wheels to float $\sim 1\text{m}$ outside the vehicle hull!
- **Rotation Misalignment:** In Three.js, setting `gltfWheel.rotation.x = roll` and `gltfWheel.rotation.y = steer` directly on the wheel mesh overwrote the authored quaternion and mixed rolling with steering in a single node, causing erratic tumbling.

### 1.3 Robotic Arm Spar Misalignment & Broken Pivot Shifts
- **Defect in Blender:** `RoboticArm_Boom` and `RoboticArm_Forearm` cylinders were created with `rot=(0, 0, math.radians(90))` and then offset with `_set_pivot` along $Y$, even though cylinder depth was along $Z$. This resulted in the spars extending vertically along glTF $Y$ while child joints were attached along glTF $-Z$.
- **Runtime Pivot Hack Failure:** In `ApolloRoverModel.ts`, `applyGltfPivotCompensation()` applied hardcoded translation offsets to `armBaseNode`, `armBoomNode`, `armForearmNode`, and `armClawNode` under the false assumption that the hierarchy was flattened. Because the hierarchy was intact, translations cascaded down the branch, completely dislocating the arm into jagged, detached floating fragments.

---

## 2. Corrected Technical Contracts & Mathematical Specification

```
LRV_Root [Identity]
└── Chassis [Identity at (0, 0.26, 0)]
    ├── Suspension_FL / FR / RL / RR & Shocks [Chassis-local static geometry]
    ├── SteeringKnuckle_FL [Yaw pivot at (-1.02, 0.12, -1.05)]
    │   └── Wheel_FL [Roll pivot at (0, 0, 0), axle on local X]
    ├── SteeringKnuckle_FR [Yaw pivot at (+1.02, 0.12, -1.05)]
    │   └── Wheel_FR [Roll pivot at (0, 0, 0), axle on local X]
    ├── SteeringKnuckle_RL [Yaw pivot at (-1.02, 0.12, +1.05)]
    │   └── Wheel_RL [Roll pivot at (0, 0, 0), axle on local X]
    ├── SteeringKnuckle_RR [Yaw pivot at (+1.02, 0.12, +1.05)]
    │   └── Wheel_RR [Roll pivot at (0, 0, 0), axle on local X]
    └── RoboticArm_Base [Azimuth yaw pivot at (+0.78, 0.29, -0.35)]
        └── RoboticArm_Boom [Shoulder pitch pivot at (0, 0.13, 0)]
            └── RoboticArm_Forearm [Elbow pitch pivot at (0, 0, -0.92)]
                └── RoboticArm_Claw [Wrist pitch pivot at (0, 0, -0.82)]
                    ├── RoboticArm_LaserEmitter [At (0, 0, -0.17)]
                    └── RoboticArm_HeldRock [At (0, 0, -0.10)]
```

### 2.1 Coordinate Invariants (Blender to Three.js)
1. **Front / Forward:** Blender $+Y \implies$ glTF $-Z$ (Three.js standard forward).
2. **Rear / Backward:** Blender $-Y \implies$ glTF $+Z$ (Three.js standard rear).
3. **Left (Port):** Blender $-X \implies$ glTF $-X$ (Three.js standard left).
4. **Right (Starboard):** Blender $+X \implies$ glTF $+X$ (Three.js standard right).
5. **Up / Elevation:** Blender $+Z \implies$ glTF $+Y$ (Three.js standard up).

### 2.2 Wheel Assembly Kinematics
- `SteeringKnuckle_*`: Located at axle center $(x, y, z)$. Responsible solely for steering yaw:
  $$\text{knuckle.rotation.y} = \begin{cases} \delta_{\text{steer}} & \text{front (FL, FR)} \\ -0.7 \cdot \delta_{\text{steer}} & \text{rear (RL, RR)} \end{cases}$$
- `Wheel_*`: Located at $(0, 0, 0)$ relative to `SteeringKnuckle_*`. Axle geometry aligned with local $X$ axis. Responsible solely for rolling pitch:
  $$\text{wheel.rotation.x} = \theta_{\text{roll}}$$
  $$\text{wheel.position.set}(0, 0, 0)$$

### 2.3 4-DOF Robotic Arm Kinematics
Every arm joint is authored with an identity rest pose (`[0, 0, 0, 1]`) at its physical rotation axis:
- `RoboticArm_Base`: Rotates around $Y$ (azimuth yaw $\theta_{\text{azimuth}}$).
- `RoboticArm_Boom`: Rotates around $X$ (shoulder pitch $\theta_{\text{shoulder}}$).
  - Spar extends from $(0, 0, 0)$ to $(0, 0, -0.92)$ along $-Z$.
- `RoboticArm_Forearm`: Rotates around $X$ (elbow pitch $\theta_{\text{elbow}}$).
  - Spar extends from $(0, 0, 0)$ to $(0, 0, -0.82)$ along $-Z$.
- `RoboticArm_Claw`: Rotates around $X$ (wrist pitch $\theta_{\text{wrist}}$).
  - Gripper fingers fan radially around $-Z$.

---

## 3. Implementation Plan & Persona Routing

| Phase | Milestone | Persona | Scope |
| :--- | :--- | :--- | :--- |
| **M1** | **Blender Rig Rectification** | `@tigger` / local | Update `scripts/lunar_assets/rover_builder.py` with corrected coordinates, wheel X-axle alignment, and boom/forearm joint hierarchy. |
| **M2** | **Asset Export & Validation** | `@tigger` / local | Execute `build_lunar_assets.py --rover` and verify GLB magic, sizes, and node transforms with `verify_m3_assets.py`. |
| **M3** | **Three.js Kinematics Alignment** | `@tigger` / local | Strip broken pivot compensation from `ApolloRoverModel.ts`. Wire `SteeringKnuckle` yaw and `Wheel` roll in `ApolloRoverModel.updateWheelTransforms`. Align `RoboticArmController` angles. |
| **M4** | **Verification & QA** | `@piglet` | Run 13/13 M2 contract tests, cargo mass dynamics benchmark, and production build check. |
| **M5** | **Runbook & Handoff** | `@pooh` | Update `docs/MAP.md`, `homelab/handoffs/playground-handoff.md`, and `boards/Kanban-Playground.md`. |

---

## 4. 💡 Note to Future Self: Hosting Portability
All glTF node transforms maintain identity scale and standard Euler/quaternion hierarchies. The vehicle model can be ingested by any standard WebGL / WebGPU engine (Three.js, Babylon.js, PlayCanvas) or native game engines (Godot, Unreal) without bespoke matrix unwrapping or coordinate inversions.
