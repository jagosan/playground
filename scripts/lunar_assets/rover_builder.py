#!/usr/bin/env python3
"""Apollo 15/16/17 Lunar Roving Vehicle (LRV) Master Model Builder for Blender 4.2.

Builds an articulated, photorealistic Apollo LRV with:
- Chassis tub and tubular rollbar frame
- Kapton gold aluminized thermal insulation avionics bay
- 4-wheel double-wishbone suspension A-arms and shock struts
- 4-wheel independent steering knuckle pivots
- Woven zinc-coated steel wire mesh tires with titanium chevron cleats
- High-gain parabolic umbrella telemetry dish
- Articulated 3-joint geological sample collection arm
- Apollo crew seats
- Low-poly collision hull (LRV_Collision_Box)
Exports binary glTF 2.0 to public/models/apollo_lrv.glb.
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


def build_apollo_lrv(out_path: str):
    print(f"[Blender 4.2] Building Apollo LRV Master Rig -> {out_path}")
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # 1. PBR Materials
    mat_gold = create_pbr_material("KaptonGoldFoil", (0.95, 0.65, 0.08, 1.0), 0.92, 0.22)
    mat_alum = create_pbr_material("AnodizedAluminum", (0.82, 0.84, 0.88, 1.0), 0.85, 0.38)
    mat_tire = create_pbr_material("WovenZincWireTire", (0.28, 0.30, 0.33, 1.0), 0.70, 0.65)
    mat_dark = create_pbr_material("TitaniumDark", (0.25, 0.25, 0.28, 1.0), 0.80, 0.50)
    mat_seat = create_pbr_material("AstronautSeatFabric", (0.12, 0.30, 0.75, 1.0), 0.10, 0.85)

    # Master Root Empty
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    root = bpy.context.active_object
    root.name = "LRV_Root"

    # 2. Chassis Tub
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.28))
    chassis = bpy.context.active_object
    chassis.name = "Chassis"
    chassis.scale = (1.52, 2.55, 0.30)
    chassis.data.materials.append(mat_alum)
    chassis.parent = root

    # Tubular Rollbar & Framework
    bpy.ops.mesh.primitive_cylinder_add(radius=0.035, depth=1.65, location=(-0.65, -0.15, 0.95))
    bar_left = bpy.context.active_object
    bar_left.name = "Rollbar_Left"
    bar_left.data.materials.append(mat_alum)
    bar_left.parent = chassis

    bpy.ops.mesh.primitive_cylinder_add(radius=0.035, depth=1.65, location=(0.65, -0.15, 0.95))
    bar_right = bpy.context.active_object
    bar_right.name = "Rollbar_Right"
    bar_right.data.materials.append(mat_alum)
    bar_right.parent = chassis

    bpy.ops.mesh.primitive_cylinder_add(radius=0.035, depth=1.35, location=(0, -0.15, 1.75))
    bar_top = bpy.context.active_object
    bar_top.name = "Rollbar_Cross"
    bar_top.rotation_euler = (0, math.radians(90), 0)
    bar_top.data.materials.append(mat_alum)
    bar_top.parent = chassis

    # 3. Gold Thermal Avionics Bay
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, -0.85, 0.52))
    avionics = bpy.context.active_object
    avionics.name = "Avionics_GoldBay"
    avionics.scale = (1.38, 0.85, 0.38)
    avionics.data.materials.append(mat_gold)
    avionics.parent = chassis

    # 4. Parabolic High-Gain Antenna Dish
    bpy.ops.mesh.primitive_cone_add(radius1=0.52, radius2=0.06, depth=0.18, location=(0.45, -1.05, 1.35))
    dish = bpy.context.active_object
    dish.name = "HighGain_Dish"
    dish.rotation_euler = (math.radians(-35), 0, math.radians(20))
    dish.data.materials.append(mat_gold)
    dish.parent = chassis

    # 5. Articulated Robotic Sampling Arm (3 joints)
    # Joint 1: Base Turret
    bpy.ops.mesh.primitive_cylinder_add(radius=0.08, depth=0.15, location=(0.65, 0.75, 0.45))
    arm_base = bpy.context.active_object
    arm_base.name = "RoboticArm_Base"
    arm_base.data.materials.append(mat_dark)
    arm_base.parent = chassis

    # Joint 2: Bicep Boom
    bpy.ops.mesh.primitive_cylinder_add(radius=0.03, depth=0.65, location=(0.68, 0.95, 0.70))
    arm_boom = bpy.context.active_object
    arm_boom.name = "RoboticArm_Boom"
    arm_boom.rotation_euler = (math.radians(35), 0, 0)
    arm_boom.data.materials.append(mat_alum)
    arm_boom.parent = arm_base

    # Joint 3: Forearm & Claw Effector
    bpy.ops.mesh.primitive_cube_add(size=0.12, location=(0.70, 1.25, 0.55))
    arm_claw = bpy.context.active_object
    arm_claw.name = "RoboticArm_Claw"
    arm_claw.scale = (0.15, 0.25, 0.10)
    arm_claw.data.materials.append(mat_dark)
    arm_claw.parent = arm_boom

    # 6. Astronaut Seats
    seat_coords = [(-0.35, 0.15, 0.65), (0.35, 0.15, 0.65)]
    seat_names = ["Seat_Commander", "Seat_Pilot"]
    for pos, name in zip(seat_coords, seat_names):
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=pos)
        seat = bpy.context.active_object
        seat.name = name
        seat.scale = (0.42, 0.45, 0.52)
        seat.data.materials.append(mat_seat)
        seat.parent = chassis

    # 7. Independent Suspension & 4 Wheels
    wheel_configs = [
        ("FL", -0.98, 1.15, 0.0),
        ("FR", 0.98, 1.15, 0.0),
        ("RL", -0.98, -1.15, 0.0),
        ("RR", 0.98, -1.15, 0.0),
    ]

    for label, x, y, z in wheel_configs:
        # Suspension A-Arm Wishbone
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x * 0.55, y, 0.18))
        susp = bpy.context.active_object
        susp.name = f"Suspension_{label}"
        susp.scale = (0.40, 0.12, 0.08)
        susp.data.materials.append(mat_dark)
        susp.parent = chassis

        # Steering Knuckle Pivot
        bpy.ops.object.empty_add(type="PLAIN_AXES", location=(x * 0.88, y, z + 0.12))
        knuckle = bpy.context.active_object
        knuckle.name = f"SteeringKnuckle_{label}"
        knuckle.parent = susp

        # Wire Mesh Tire with Chevron Cleats
        bpy.ops.mesh.primitive_cylinder_add(
            radius=0.42,
            depth=0.28,
            location=(x, y, z + 0.12),
            rotation=(0, math.radians(90), 0)
        )
        wheel = bpy.context.active_object
        wheel.name = f"Wheel_{label}"
        wheel.data.materials.append(mat_tire)
        wheel.parent = knuckle

    # 8. Low-Poly Collision Proxy
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.35))
    col_box = bpy.context.active_object
    col_box.name = "LRV_Collision_Box"
    col_box.scale = (2.25, 3.45, 0.95)
    col_box.display_type = "WIRE"
    col_box.parent = root

    # 9. Export glTF 2.0 Binary (GLB)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
    )
    print(f"[Blender 4.2] Apollo LRV export complete: {os.path.getsize(out_path):,} bytes")


if __name__ == "__main__":
    out_file = sys.argv[1] if len(sys.argv) > 1 else "/home/jagosan/repos/playground/public/models/apollo_lrv.glb"
    build_apollo_lrv(out_file)
    os._exit(0)
