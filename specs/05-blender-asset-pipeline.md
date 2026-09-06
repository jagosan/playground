# Spec 05: Headless Blender 4.2 Photorealistic Lunar Asset Pipeline

> Target Environment: Headless Linux Server (`beehive` / x86_64, Ubuntu 24.04 LTS)
> Toolchain: Python 3.11 with standalone `bpy` 4.2.0 (`~/.hermes/toolchains/bpy_env`)
> Output Assets: `public/models/*.glb` with Draco/binary packaging and headless PNG previews

---

## 1. Executive Summary & Goals
To deliver a true photorealistic 3D environment for Moonbuggy2, this specification establishes an automated, headless Blender 4.2 asset generation and export pipeline. The game runtime will load genuine binary glTF 2.0 (`.glb`) models with physically-based materials (PBR) rather than relying on hardcoded procedural Three.js primitives.

Key Deliverables:
1. **Permanent Blender Toolchain:** Move and standardize the standalone `bpy==4.2.0` Python environment from temporary storage to `/home/jagosan/.hermes/toolchains/bpy_env`.
2. **Apollo LRV Master Model (`public/models/apollo_lrv.glb`):**
   - Structural mesh hierarchy with distinct nodes:
     - `Chassis`: tubular anodized aluminum frame and lower tub.
     - `Avionics_GoldBay`: thermal electronics enclosure wrapped in crinkled Kapton aluminized gold foil.
     - `Suspension_FL`, `Suspension_FR`, `Suspension_RL`, `Suspension_RR`: double-wishbone A-arms and shock struts.
     - `SteeringKnuckle_FL`, `SteeringKnuckle_FR`, `SteeringKnuckle_RL`, `SteeringKnuckle_RR`: 4-wheel independent steering pivots.
     - `Wheel_FL`, `Wheel_FR`, `Wheel_RL`, `Wheel_RR`: open woven zinc-coated steel wire mesh tires with titanium chevron tread cleats.
     - `HighGain_Dish`: parabolic high-gain umbrella antenna dish angled toward Earth.
     - `RoboticArm_Base`, `RoboticArm_Boom`, `RoboticArm_Claw`: articulated 3-axis geological sample collection arm.
     - `Seat_Commander`, `Seat_Pilot`: Apollo crew seating.
     - `LRV_Collision_Box`: invisible low-poly bounding proxy for fast raycast and hull collision.
3. **Lunar Basalt Rocks (`public/models/lunar_rocks.glb`):**
   - 4 distinct vesicular basalt boulder variations generated procedurally via Voronoi cell fracture, displacement noise, and decimation.
4. **Lunar Crater Terrain Tile (`public/models/lunar_terrain_tile.glb`):**
   - High-density cratered terrain mesh featuring multi-octave impact craters (crater rims, bowl depression, central rebound peaks) with baked micro-regolith normal maps.
5. **Apollo Lunar Drop Station (`public/models/lunar_drop_station.glb`):**
   - Modular scientific lander base at $(0, 0)$ featuring a docking hopper platform, solar array wings, and navigation beacon strobes.
6. **Headless Visual Audit & Preview Generation:**
   - Headless render pass generating PNG previews in `public/models/previews/` and an asset metadata manifest (`public/models/manifest.json`) recording vertex counts, material slots, and file sizes.

---

## 2. Technical Contracts & Script Specification

### 2.1 Toolchain Location & Invocation
- The toolchain lives at `/home/jagosan/.hermes/toolchains/bpy_env/bin/python`.
- Asset build script: `/home/jagosan/repos/playground/scripts/build_lunar_assets.py`.
- Invocation command:
  ```bash
  /home/jagosan/.hermes/toolchains/bpy_env/bin/python scripts/build_lunar_assets.py --all
  ```
- **Process Exit Guarantee:** Due to Blender 4.2 C++ background worker thread persistence in Python modules, the script MUST call `os._exit(0)` upon completion to prevent CLI hanging.

### 2.2 Material Shading Contracts (PBR Principled BSDF)
All materials must use standard Blender Principled BSDF nodes compatible with the glTF 2.0 PBR Metallic-Roughness exporter:
- `KaptonGoldFoil`: BaseColor `(0.95, 0.65, 0.08, 1.0)`, Metallic `0.92`, Roughness `0.22`.
- `AnodizedAluminum`: BaseColor `(0.82, 0.84, 0.88, 1.0)`, Metallic `0.85`, Roughness `0.38`.
- `WovenZincWireTire`: BaseColor `(0.28, 0.30, 0.33, 1.0)`, Metallic `0.70`, Roughness `0.65`.
- `LunarBasalt`: BaseColor `(0.18, 0.18, 0.19, 1.0)`, Metallic `0.05`, Roughness `0.90`.
- `LanderFoilSilver`: BaseColor `(0.90, 0.90, 0.92, 1.0)`, Metallic `0.95`, Roughness `0.18`.

### 2.3 File Manifest & Sizes
- Target file sizes:
  - `apollo_lrv.glb`: $< 4.0\,\text{MB}$
  - `lunar_rocks.glb`: $< 2.0\,\text{MB}$
  - `lunar_terrain_tile.glb`: $< 5.0\,\text{MB}$
  - `lunar_drop_station.glb`: $< 3.0\,\text{MB}$
- Total asset payload: $< 15\,\text{MB}$ for instant loading over Tailscale.
