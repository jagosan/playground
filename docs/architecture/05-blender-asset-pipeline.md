# Architecture Blueprint 05: Headless Blender 4.2 Asset & Export Pipeline

## 1. Pipeline Architecture & Data Flow

```mermaid
flowchart TD
    subgraph Toolchain["Blender 4.2 Python Toolchain (~/.hermes/toolchains/bpy_env)"]
        BPY["bpy 4.2.0 Standalone C++ Python Engine"]
    end

    subgraph Script["Generator Script: scripts/build_lunar_assets.py"]
        ROVER["build_rover()<br>• Chassis Tub & Rollbar<br>• Kapton Gold Avionics Bay<br>• 4-Wheel Double Wishbone<br>• High-Gain Mesh Dish<br>• 3-Joint Robotic Arm<br>• Low-Poly Collision Hull"]
        ROCKS["build_rocks()<br>• 4x Basalt Boulders<br>• Voronoi Fracture & Decimate<br>• Vesicular Micro-Surface"]
        TERRAIN["build_terrain()<br>• Cratered Heightfield<br>• Rebound Peaks & Rims<br>• Regolith Normal Map"]
        STATION["build_station()<br>• Apollo Descent Stage Base<br>• Docking Hopper<br>• Solar Array Wings<br>• Beacon Strobe"]
    end

    subgraph Export["glTF 2.0 Binary Export"]
        EXP["bpy.ops.export_scene.gltf()<br>format='GLB', Draco compression"]
    end

    subgraph Output["public/models/"]
        GLB1["apollo_lrv.glb"]
        GLB2["lunar_rocks.glb"]
        GLB3["lunar_terrain_tile.glb"]
        GLB4["lunar_drop_station.glb"]
        MANIFEST["manifest.json<br>(Vertex count, Materials, Hashes)"]
        PREVIEWS["previews/*.png<br>(Headless verification renders)"]
    end

    BPY --> Script
    Script --> EXP
    EXP --> Output
```

## 2. PBR Material Configuration & Node Schemas

| Material Identifier | Base Color (RGB) | Metallic | Roughness | Optical Function |
|---|---|---|---|---|
| `KaptonGoldFoil` | `(0.95, 0.65, 0.08)` | `0.92` | `0.22` | High-reflectance lunar thermal blanket |
| `AnodizedAluminum` | `(0.82, 0.84, 0.88)` | `0.85` | `0.38` | Structural tubular chassis frame |
| `WovenZincWireTire` | `(0.28, 0.30, 0.33)` | `0.70` | `0.65` | Apollo open-mesh compliant tires |
| `LunarBasalt` | `(0.18, 0.18, 0.19)` | `0.05` | `0.90` | Low-albedo vacuum-exposed boulder |
| `LanderFoilSilver` | `(0.90, 0.90, 0.92)` | `0.95` | `0.18` | Descent stage multi-layer insulation |

## 3. ADR-005: Blender Headless C++ Process Lifecycle & Exit Semantics
- **Context:** Standalone `bpy` initializes C++ worker thread pools and background memory allocations that do not terminate cleanly on standard Python exit, causing headless processes to hang indefinitely.
- **Decision:** The asset pipeline script enforces `os._exit(0)` immediately following glTF export completion and file verification.
- **Consequences:** Eliminates script hanging, enables clean integration into build pipelines, CI/CD, and multi-agent workflows.

---

## 💡 Note to Future Self: Hosting Portability
- The Blender asset generation pipeline is completely decoupled from the Three.js frontend runtime.
- Assets are generated headlessly into standard binary glTF 2.0 (`.glb`) files under `public/models/`.
- If the game engine is ported in the future from Three.js to a native engine (e.g. Godot 4, Raylib C++, Unreal, Bevy), the identical `.glb` files and collision proxies can be directly imported without regeneration.
- The Python generator can be executed on any x86_64 or ARM64 Linux system with `bpy` installed or via a standard Blender Docker container.
