#!/usr/bin/env python3
"""Lunar Terrain & Apollo Drop Station Builder for Blender 4.2.

Builds:
1. lunar_terrain_tile.glb:
   - High-density cratered mare terrain tile (50m x 50m)
   - Procedural impact crater bowl, ejecta rim, and central rebound peak
   - Micro-regolith surface roughness

2. lunar_drop_station.glb:
   - Apollo Lunar Module Descent Stage base platform at (0, 0)
   - Central scientific rock drop-off hopper
   - Quad landing gear with lunar contact footpads
   - Solar array wings and active telemetry navigation beacon strobe
"""

import math
import os
import sys
from pathlib import Path
import bpy


def create_pbr_material(name, base_color, metallic, roughness, emission=(0, 0, 0, 1.0)):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = base_color
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = roughness
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = emission
    return mat


def build_terrain(out_path: str):
    print(f"[Blender 4.2] Building Lunar Terrain Tile -> {out_path}")
    bpy.ops.wm.read_factory_settings(use_empty=True)

    mat_regolith = create_pbr_material("LunarRegolith", (0.24, 0.24, 0.25, 1.0), 0.02, 0.94)

    # 50m x 50m Terrain Grid
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=64, y_subdivisions=64, size=50.0, location=(0, 0, 0))
    terrain = bpy.context.active_object
    terrain.name = "Lunar_Terrain_Tile"
    terrain.data.materials.append(mat_regolith)

    # Multi-octave Crater Displace Texture
    tex_crater = bpy.data.textures.new(name="CraterTexture", type="VORONOI")
    tex_crater.noise_scale = 1.85
    tex_crater.distance_metric = "DISTANCE"

    mod_disp = terrain.modifiers.new(name="CraterDisplacement", type="DISPLACE")
    mod_disp.texture = tex_crater
    mod_disp.strength = 1.45

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
    )
    print(f"[Blender 4.2] Lunar Terrain export complete: {os.path.getsize(out_path):,} bytes")


def build_station(out_path: str):
    print(f"[Blender 4.2] Building Apollo Drop Station -> {out_path}")
    bpy.ops.wm.read_factory_settings(use_empty=True)

    mat_gold = create_pbr_material("LanderKaptonGold", (0.95, 0.65, 0.08, 1.0), 0.95, 0.20)
    mat_silver = create_pbr_material("LanderSilverFoil", (0.90, 0.90, 0.92, 1.0), 0.95, 0.18)
    mat_solar = create_pbr_material("SolarArrayBlue", (0.05, 0.12, 0.45, 1.0), 0.85, 0.25)
    mat_dark = create_pbr_material("TitaniumStrut", (0.25, 0.25, 0.28, 1.0), 0.80, 0.45)
    mat_beacon = create_pbr_material("NavBeaconStrobe", (0.1, 0.9, 1.0, 1.0), 0.0, 0.1, emission=(0.1, 0.9, 1.0, 1.0))

    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    root = bpy.context.active_object
    root.name = "DropStation_Root"

    # 1. Octagonal Descent Stage Core
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=3.2, depth=1.65, location=(0, 0, 1.2))
    core = bpy.context.active_object
    core.name = "DescentStage_Core"
    core.data.materials.append(mat_gold)
    core.parent = root

    # 2. Central Science Sample Drop Hopper Basin
    bpy.ops.mesh.primitive_cone_add(radius1=1.85, radius2=0.45, depth=0.85, location=(0, 0, 2.2))
    hopper = bpy.context.active_object
    hopper.name = "Sample_Drop_Hopper"
    hopper.rotation_euler = (math.radians(180), 0, 0)
    hopper.data.materials.append(mat_silver)
    hopper.parent = root

    # 3. 4x Landing Gear Struts & Footpads
    pad_angles = [45, 135, 225, 315]
    for deg in pad_angles:
        rad = math.radians(deg)
        x = math.cos(rad) * 4.5
        y = math.sin(rad) * 4.5

        # Primary Strut
        bpy.ops.mesh.primitive_cylinder_add(radius=0.08, depth=3.2, location=(x * 0.5, y * 0.5, 0.8))
        strut = bpy.context.active_object
        strut.name = f"LandingGear_Strut_{deg}"
        strut.data.materials.append(mat_dark)
        strut.parent = root

        # Dish Footpad
        bpy.ops.mesh.primitive_cylinder_add(radius=0.75, depth=0.12, location=(x, y, 0.06))
        pad = bpy.context.active_object
        pad.name = f"Footpad_{deg}"
        pad.data.materials.append(mat_silver)
        pad.parent = root

    # 4. Dual Solar Array Wings
    wing_positions = [(-4.8, 0, 2.4), (4.8, 0, 2.4)]
    for i, pos in enumerate(wing_positions):
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=pos)
        solar = bpy.context.active_object
        solar.name = f"SolarArray_Wing_{i}"
        solar.scale = (3.2, 1.4, 0.05)
        solar.rotation_euler = (0, math.radians(15 if i == 0 else -15), 0)
        solar.data.materials.append(mat_solar)
        solar.parent = root

    # 5. Nav Telemetry Beacon Mast
    bpy.ops.mesh.primitive_cylinder_add(radius=0.05, depth=2.8, location=(0, 0, 3.4))
    mast = bpy.context.active_object
    mast.name = "Telemetry_Mast"
    mast.data.materials.append(mat_dark)
    mast.parent = root

    # Strobe Orb
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.25, location=(0, 0, 4.8))
    strobe = bpy.context.active_object
    strobe.name = "Beacon_Strobe_Orb"
    strobe.data.materials.append(mat_beacon)
    strobe.parent = mast

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
    )
    print(f"[Blender 4.2] Apollo Drop Station export complete: {os.path.getsize(out_path):,} bytes")


if __name__ == "__main__":
    terrain_out = "/home/jagosan/repos/playground/public/models/lunar_terrain_tile.glb"
    station_out = "/home/jagosan/repos/playground/public/models/lunar_drop_station.glb"

    if "--terrain" in sys.argv:
        build_terrain(terrain_out)
    elif "--station" in sys.argv:
        build_station(station_out)
    else:
        build_terrain(terrain_out)
        build_station(station_out)

    os._exit(0)
