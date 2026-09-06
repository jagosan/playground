#!/usr/bin/env python3
"""Lunar Basalt Boulders Asset Builder for Blender 4.2.

Generates 4 distinct vesicular basalt rock variations:
- Rock_A: Large angular impact breccia boulder (1.8m)
- Rock_B: Vesicular pitted basalt cluster (1.2m)
- Rock_C: Tabular slab with fractured edges (0.9m)
- Rock_D: Small rounded micro-cratered specimen (0.6m)
Uses procedural displace noise, Voronoi pitting, and decimation.
Exports binary glTF 2.0 to public/models/lunar_rocks.glb.
"""

import math
import os
import sys
from pathlib import Path
import bpy


def create_pbr_material(name, base_color, metallic, roughness):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = base_color
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = roughness
    return mat


def build_lunar_rocks(out_path: str):
    print(f"[Blender 4.2] Building Lunar Basalt Rocks -> {out_path}")
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # PBR Basalt Material
    mat_basalt = create_pbr_material("LunarBasalt", (0.18, 0.18, 0.19, 1.0), 0.05, 0.90)

    # Master Root
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    root = bpy.context.active_object
    root.name = "Rocks_Root"

    rock_configs = [
        ("Rock_A_Breccia", (-3.0, 0, 0.65), (1.4, 1.1, 0.9), 3),
        ("Rock_B_Vesicular", (-1.0, 0, 0.50), (1.1, 1.0, 0.8), 2),
        ("Rock_C_Tabular", (1.0, 0, 0.35), (1.3, 0.9, 0.5), 2),
        ("Rock_D_Specimen", (2.8, 0, 0.28), (0.7, 0.7, 0.6), 2),
    ]

    for name, pos, scale, subdiv_level in rock_configs:
        # Generate base icosphere
        bpy.ops.mesh.primitive_ico_sphere_add(
            subdivisions=subdiv_level,
            radius=0.5,
            location=pos
        )
        rock = bpy.context.active_object
        rock.name = name
        rock.scale = scale
        rock.data.materials.append(mat_basalt)
        rock.parent = root

        # Add Displace modifier with procedural Voronoi/Clouds texture
        tex = bpy.data.textures.new(name=f"Tex_{name}", type="VORONOI")
        tex.noise_scale = 0.45

        mod_disp = rock.modifiers.new(name="PittingDisplace", type="DISPLACE")
        mod_disp.texture = tex
        mod_disp.strength = 0.18

        # Add Decimate modifier for low-overhead game performance
        mod_dec = rock.modifiers.new(name="GameDecimate", type="DECIMATE")
        mod_dec.ratio = 0.75

    # Export glTF 2.0 Binary (GLB)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
    )
    print(f"[Blender 4.2] Lunar Rocks export complete: {os.path.getsize(out_path):,} bytes")


if __name__ == "__main__":
    out_file = sys.argv[1] if len(sys.argv) > 1 else "/home/jagosan/repos/playground/public/models/lunar_rocks.glb"
    build_lunar_rocks(out_file)
    os._exit(0)
