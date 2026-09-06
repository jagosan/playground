# Architecture Blueprint 06: Moonbuggy2 Engine Milestone 2 (GLTF Integration & Dynamics)

## 1. Engine Architecture & Scene Hierarchy

```mermaid
flowchart TD
    subgraph Assets["Blender Binary Assets (public/models/*.glb)"]
        LRV_GLB["apollo_lrv.glb"]
        ROCKS_GLB["lunar_rocks.glb"]
        STATION_GLB["lunar_drop_station.glb"]
    end

    subgraph Runtime["Moonbuggy2Scene Runtime"]
        LOADER["GLTFAssetLoader<br>(Three.js GLTFLoader + DRACOLoader)"]
        
        subgraph Kinematics["Articulated Mesh Binding"]
            WHEELS["Wheel Mesh Nodes (4x)<br>Spin: rot_x += v/r * dt<br>Steer: rot_y = steer_angle"]
            ARM["Robotic Arm Nodes<br>Base Yaw + Boom Pitch + Claw Grasp"]
        end

        subgraph Dynamics["LRVPhysics Engine (120Hz Sub-Stepped)"]
            TORQUE["High-Speed Motor Torque Curve<br>0 -> 25 km/h in 2.8s"]
            MASS["Dynamic Payload Mass<br>m_total = 360kg + n_rocks * 35kg"]
            STATION_SYS["Drop Station Zone (0, 0)<br>Radius 6m: Unload Cargo + Charge Battery"]
        end

        subgraph Telemetry["Cockpit Glass HUD"]
            SPEEDO["Speedometer (km/h)"]
            FUEL["Battery/Fuel Gauge (%)"]
            CARGO["Payload Mass Counter (kg)"]
            COMPASS["Nav Compass to (0, 0)"]
        end
    end

    Assets --> LOADER
    LOADER --> Kinematics
    Dynamics --> Kinematics
    Dynamics --> Telemetry
```

## 2. Dynamic Mass & Velocity Equations
$$\mathbf{a}_{\text{thrust}} = \frac{\mathbf{F}_{\text{motor}}}{m_{\text{base}} + N_{\text{rocks}} \cdot m_{\text{rock}}}$$
$$\mathbf{F}_{\text{downforce}} = (m_{\text{base}} + N_{\text{rocks}} \cdot m_{\text{rock}}) \cdot g_{\text{moon}}$$
Where:
- $m_{\text{base}} = 360.0\,\text{kg}$
- $m_{\text{rock}} = 35.0\,\text{kg}$
- $g_{\text{moon}} = 1.62\,\text{m/s}^2$
- Maximum speed governed at $v_{\max} = 25.0\,\text{km/h} = 6.944\,\text{m/s}$.

---

## 💡 Note to Future Self: Hosting Portability
- All gameplay and physics logic is decoupled from Three.js scene graphs via clean state interfaces (`VehicleState`, `PayloadState`, `StationState`).
- The sub-stepped physics math is 100% deterministic and pure TypeScript with zero DOM/WebGL dependencies, enabling seamless export to a WebWorker or a headless server authoritative simulation.
