#!/usr/bin/env python3
"""Next-Generation Artemis Lunar Terrain Vehicle (LTV) Master Rig Builder for Blender 4.2.

Builds a photorealistic, next-gen Artemis LTV inspired by NASA Artemis LTV concepts
(Lunar Outpost Lunar Dawn, Intuitive Machines Moon RACER, Venturi Astrolab FLEX):
- Sleek aerodynamic composite spaceframe with Artemis White & Matte Carbon bodywork
- Kapton gold/copper thermal multi-layer insulation (MLI) avionics bay
- Dual high-back astronaut flight seats with 5-point harness relief and center control yoke
- Heavy-duty front bullbar with high-intensity LED lightbars
- Autonomous navigation sensor mast (LiDAR dome, stereo nav-cams, high-gain parabolic dish)
- Rear modular science deck with 8 dedicated sample container docks
- 4-wheel independent double-wishbone suspension with coilover dampers
- Compliant airless lattice tweels with titanium chevron traction grousers
- 4-DOF articulated robotic arm (turret, shoulder boom, forearm, 3-finger claw, laser guide)
- Embedded sample holding node and 8 cargo bay rock specimen meshes
Exports binary glTF 2.0 to public/models/apollo_lrv.glb.
"""

import math
import os
import sys
from pathlib import Path
import bpy


def create_pbr_material(name, base_color, metallic, roughness, emissive_color=None, emissive_strength=1.0):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = base_color
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = roughness
        if emissive_color:
            bsdf.inputs["Emission Color"].default_value = emissive_color
            if "Emission Strength" in bsdf.inputs:
                bsdf.inputs["Emission Strength"].default_value = emissive_strength
    return mat


def build_apollo_lrv(out_path: str):
    print(f"[Blender 4.2] Building Artemis LTV Master Rig -> {out_path}")
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # 1. High-Fidelity PBR Materials
    mat_white = create_pbr_material("ArtemisWhiteComposite", (0.92, 0.93, 0.95, 1.0), 0.15, 0.28)
    mat_carbon = create_pbr_material("MatteCarbonFiber", (0.12, 0.12, 0.14, 1.0), 0.25, 0.42)
    mat_gold = create_pbr_material("KaptonGoldFoil", (0.96, 0.68, 0.10, 1.0), 0.92, 0.20)
    mat_titanium = create_pbr_material("TitaniumDark", (0.42, 0.43, 0.45, 1.0), 0.88, 0.35)
    mat_tire = create_pbr_material("WovenZincWireTire", (0.22, 0.23, 0.25, 1.0), 0.70, 0.60)
    mat_cleat = create_pbr_material("TitaniumCleat", (0.75, 0.76, 0.78, 1.0), 0.90, 0.25)
    mat_seat = create_pbr_material("AstronautSeatFabric", (0.18, 0.20, 0.24, 1.0), 0.05, 0.75)
    mat_harness = create_pbr_material("HarnessOrange", (0.95, 0.35, 0.05, 1.0), 0.10, 0.65)
    mat_led = create_pbr_material("HeadlightEmissive", (1.0, 1.0, 1.0, 1.0), 0.1, 0.1, (1.0, 1.0, 1.0, 1.0), 5.0)
    mat_laser = create_pbr_material("LaserEmitter", (0.2, 1.0, 0.3, 1.0), 0.0, 0.1, (0.2, 1.0, 0.3, 1.0), 8.0)
    mat_rock = create_pbr_material("LunarBasaltCargo", (0.20, 0.21, 0.22, 1.0), 0.05, 0.92)

    # Master Root Empty
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    root = bpy.context.active_object
    root.name = "LRV_Root"

    # 2. Main Chassis Spaceframe & Underbody Skid Plate
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.26))
    chassis = bpy.context.active_object
    chassis.name = "Chassis"
    chassis.scale = (1.56, 2.75, 0.24)
    chassis.data.materials.append(mat_carbon)
    chassis.parent = root

    # Titanium Skid Plate Underbelly
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.12))
    skid = bpy.context.active_object
    skid.name = "Chassis_SkidPlate"
    skid.scale = (1.35, 2.60, 0.04)
    skid.data.materials.append(mat_titanium)
    skid.parent = chassis

    # 3. Aerodynamic White Composite Cowlings & Front Nose Fascia
    # Front Wedge Hood
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, -1.05, 0.48))
    hood = bpy.context.active_object
    hood.name = "Body_FrontHood"
    hood.scale = (1.45, 0.85, 0.25)
    hood.rotation_euler = (math.radians(12), 0, 0)
    hood.data.materials.append(mat_white)
    hood.parent = chassis

    # Flank Aerodynamic Side Pods
    for side, x in [("L", -0.72), ("R", 0.72)]:
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x, 0, 0.42))
        pod = bpy.context.active_object
        pod.name = f"Body_SidePod_{side}"
        pod.scale = (0.24, 2.40, 0.28)
        pod.data.materials.append(mat_white)
        pod.parent = chassis

    # Gold Thermal MLI Avionics Bay
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, -0.65, 0.38))
    avionics = bpy.context.active_object
    avionics.name = "Avionics_GoldBay"
    avionics.scale = (1.20, 0.75, 0.30)
    avionics.data.materials.append(mat_gold)
    avionics.parent = chassis

    # 4. Heavy-Duty Front Bullbar & High-Intensity LED Lightbars
    # Bullbar Outer Loop
    bpy.ops.mesh.primitive_cylinder_add(radius=0.032, depth=1.58, location=(0, -1.48, 0.48))
    bullbar_main = bpy.context.active_object
    bullbar_main.name = "Bullbar_Bumper"
    bullbar_main.rotation_euler = (0, math.radians(90), 0)
    bullbar_main.data.materials.append(mat_titanium)
    bullbar_main.parent = chassis

    # Bullbar Vertical Uprights
    for x in [-0.55, 0.55]:
        bpy.ops.mesh.primitive_cylinder_add(radius=0.028, depth=0.45, location=(x, -1.46, 0.32))
        upright = bpy.context.active_object
        upright.name = f"Bullbar_Upright_{'L' if x < 0 else 'R'}"
        upright.data.materials.append(mat_titanium)
        upright.parent = chassis

    # Dual High-Intensity LED Headlight Pods
    for x in [-0.48, 0.48]:
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x, -1.42, 0.48))
        light = bpy.context.active_object
        light.name = f"LED_Lightbar_{'L' if x < 0 else 'R'}"
        light.scale = (0.32, 0.08, 0.09)
        light.data.materials.append(mat_led)
        light.parent = chassis

    # 5. Integrated Artemis Roll Cage
    # Left & Right A-Pillars / B-Pillars
    cage_tubes = [
        ("Rollbar_Left", -0.68, 0.15, 1.05, 1.45, 0),
        ("Rollbar_Right", 0.68, 0.15, 1.05, 1.45, 0),
        ("Rollbar_Front_L", -0.68, -0.45, 0.85, 1.15, math.radians(18)),
        ("Rollbar_Front_R", 0.68, -0.45, 0.85, 1.15, math.radians(18)),
        ("Rollbar_Rear_L", -0.68, 0.85, 0.85, 1.15, math.radians(-18)),
        ("Rollbar_Rear_R", 0.68, 0.85, 0.85, 1.15, math.radians(-18)),
    ]
    for name, x, y, z, depth, rot_x in cage_tubes:
        bpy.ops.mesh.primitive_cylinder_add(radius=0.035, depth=depth, location=(x, y, z))
        bar = bpy.context.active_object
        bar.name = name
        bar.rotation_euler = (rot_x, 0, 0)
        bar.data.materials.append(mat_titanium)
        bar.parent = chassis

    # Cross Beams
    bpy.ops.mesh.primitive_cylinder_add(radius=0.032, depth=1.40, location=(0, 0.15, 1.72))
    bar_top = bpy.context.active_object
    bar_top.name = "Rollbar_Cross"
    bar_top.rotation_euler = (0, math.radians(90), 0)
    bar_top.data.materials.append(mat_titanium)
    bar_top.parent = chassis

    # 6. Autonomous Navigation Mast & High-Gain Dish
    # Sensor Mast Strut
    bpy.ops.mesh.primitive_cylinder_add(radius=0.03, depth=0.85, location=(0.45, -0.92, 1.15))
    mast = bpy.context.active_object
    mast.name = "SensorMast"
    mast.data.materials.append(mat_carbon)
    mast.parent = chassis

    # LiDAR Turret Dome
    bpy.ops.mesh.primitive_cylinder_add(radius=0.09, depth=0.12, location=(0.45, -0.92, 1.60))
    lidar = bpy.context.active_object
    lidar.name = "SensorMast_LiDAR"
    lidar.data.materials.append(mat_titanium)
    lidar.parent = mast

    # High-Gain Telemetry Dish
    bpy.ops.mesh.primitive_cone_add(radius1=0.48, radius2=0.06, depth=0.16, location=(-0.45, -0.92, 1.45))
    dish = bpy.context.active_object
    dish.name = "HighGain_Dish"
    dish.rotation_euler = (math.radians(-32), math.radians(15), math.radians(25))
    dish.data.materials.append(mat_gold)
    dish.parent = chassis

    # 7. Ergonomic Flight Seats & Cockpit Center Console
    # Center Console with Telemetry Display
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0.05, 0.58))
    console = bpy.context.active_object
    console.name = "Cockpit_Console"
    console.scale = (0.20, 0.45, 0.35)
    console.data.materials.append(mat_carbon)
    console.parent = chassis

    # Astronaut Seats
    for name, x in [("Seat_Commander", -0.38), ("Seat_Pilot", 0.38)]:
        # Seat Pan
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x, 0.12, 0.48))
        seat_pan = bpy.context.active_object
        seat_pan.name = f"{name}_Pan"
        seat_pan.scale = (0.45, 0.48, 0.12)
        seat_pan.data.materials.append(mat_seat)
        seat_pan.parent = chassis

        # Ergonomic High Backrest
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x, 0.34, 0.82))
        seat_back = bpy.context.active_object
        seat_back.name = f"{name}_Back"
        seat_back.scale = (0.44, 0.10, 0.62)
        seat_back.rotation_euler = (math.radians(-14), 0, 0)
        seat_back.data.materials.append(mat_seat)
        seat_back.parent = seat_pan

        # Safety Harness Belts
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x, 0.32, 0.82))
        harness = bpy.context.active_object
        harness.name = f"{name}_Harness"
        harness.scale = (0.34, 0.11, 0.48)
        harness.rotation_euler = (math.radians(-14), 0, 0)
        harness.data.materials.append(mat_harness)
        harness.parent = seat_back

    # 8. Rear Scientific Payload Bed & 8 Dedicated Rock Canister Receptacles
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0.88, 0.46))
    cargo_bed = bpy.context.active_object
    cargo_bed.name = "CargoBed"
    cargo_bed.scale = (1.30, 0.95, 0.16)
    cargo_bed.data.materials.append(mat_titanium)
    cargo_bed.parent = chassis

    # 8 Physical Cargo Bay Specimen Slots (4 pairs)
    cargo_rock_coords = [
        (-0.42, 0.58), (-0.14, 0.58), (0.14, 0.58), (0.42, 0.58),
        (-0.42, 1.05), (-0.14, 1.05), (0.14, 1.05), (0.42, 1.05),
    ]
    for idx, (rx, ry) in enumerate(cargo_rock_coords):
        # Specimen Retention Ring / Collar
        bpy.ops.mesh.primitive_cylinder_add(radius=0.10, depth=0.06, location=(rx, ry, 0.55))
        collar = bpy.context.active_object
        collar.name = f"Cargo_Ring_{idx+1}"
        collar.data.materials.append(mat_carbon)
        collar.parent = cargo_bed

        # Cargo Rock Mesh (hidden/shown dynamically via Three.js)
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.085, location=(rx, ry, 0.62))
        cargo_rock = bpy.context.active_object
        cargo_rock.name = f"Cargo_Rock_{idx+1}"
        cargo_rock.data.materials.append(mat_rock)
        cargo_rock.parent = cargo_bed

    # 9. Next-Gen 4-DOF Articulated Robotic Arm & Gripper
    # Base Azimuth Turret (Starboard Front Quarter)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.12, depth=0.22, location=(0.78, -0.35, 0.55))
    arm_base = bpy.context.active_object
    arm_base.name = "RoboticArm_Base"
    arm_base.data.materials.append(mat_titanium)
    arm_base.parent = chassis

    # Turret Housing Cap
    bpy.ops.mesh.primitive_cylinder_add(radius=0.09, depth=0.14, location=(0.78, -0.35, 0.70))
    arm_turret = bpy.context.active_object
    arm_turret.name = "RoboticArm_TurretCap"
    arm_turret.data.materials.append(mat_carbon)
    arm_turret.parent = arm_base

    # Shoulder Joint & Telescoping Carbon Bicep Boom
    # Pivot located at shoulder rotation center
    bpy.ops.mesh.primitive_cylinder_add(radius=0.06, depth=0.16, location=(0.78, -0.35, 0.78))
    shoulder = bpy.context.active_object
    shoulder.name = "RoboticArm_Shoulder"
    shoulder.rotation_euler = (0, math.radians(90), 0)
    shoulder.data.materials.append(mat_titanium)
    shoulder.parent = arm_base

    # Bicep Boom Spar (named RoboticArm_Boom for backward compat, and RoboticArm_Bicep alias)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.045, depth=0.92, location=(0.78, -0.35 + 0.42, 0.78 + 0.15))
    arm_boom = bpy.context.active_object
    arm_boom.name = "RoboticArm_Boom"
    arm_boom.rotation_euler = (math.radians(35), 0, 0)
    arm_boom.data.materials.append(mat_carbon)
    arm_boom.parent = arm_base

    # Elbow Actuator Joint
    bpy.ops.mesh.primitive_cylinder_add(radius=0.05, depth=0.14, location=(0.78, 0.42, 1.25))
    elbow = bpy.context.active_object
    elbow.name = "RoboticArm_Elbow"
    elbow.rotation_euler = (0, math.radians(90), 0)
    elbow.data.materials.append(mat_titanium)
    elbow.parent = arm_boom

    # Forearm Spar
    bpy.ops.mesh.primitive_cylinder_add(radius=0.038, depth=0.82, location=(0.78, 0.65, 0.95))
    forearm = bpy.context.active_object
    forearm.name = "RoboticArm_Forearm"
    forearm.rotation_euler = (math.radians(-42), 0, 0)
    forearm.data.materials.append(mat_titanium)
    forearm.parent = arm_boom

    # Wrist Gimbal
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.78, 0.85, 0.65))
    wrist = bpy.context.active_object
    wrist.name = "RoboticArm_Wrist"
    wrist.scale = (0.10, 0.10, 0.12)
    wrist.data.materials.append(mat_carbon)
    wrist.parent = forearm

    # 3-Finger Motorized Mechanical Claw Effector
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.78, 0.95, 0.55))
    arm_claw = bpy.context.active_object
    arm_claw.name = "RoboticArm_Claw"
    arm_claw.scale = (0.18, 0.22, 0.14)
    arm_claw.data.materials.append(mat_titanium)
    arm_claw.parent = wrist

    # 3 Articulated Gripper Fingers
    finger_angles = [0, 120, 240]
    for f_idx, fa in enumerate(finger_angles):
        rad = math.radians(fa)
        fx = 0.78 + math.cos(rad) * 0.07
        fz = 0.55 + math.sin(rad) * 0.07
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(fx, 1.05, fz))
        finger = bpy.context.active_object
        finger.name = f"RoboticArm_Finger_{f_idx+1}"
        finger.scale = (0.025, 0.15, 0.035)
        finger.rotation_euler = (math.radians(-15), 0, 0)
        finger.data.materials.append(mat_carbon)
        finger.parent = arm_claw

    # Green Alignment Laser Pointer Guide
    bpy.ops.mesh.primitive_cylinder_add(radius=0.015, depth=0.06, location=(0.78, 1.02, 0.55))
    laser = bpy.context.active_object
    laser.name = "RoboticArm_LaserEmitter"
    laser.rotation_euler = (math.radians(90), 0, 0)
    laser.data.materials.append(mat_laser)
    laser.parent = arm_claw

    # Held Sample Node inside Claw (toggled visible during retrieve flight)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.075, location=(0.78, 1.05, 0.55))
    held_rock = bpy.context.active_object
    held_rock.name = "RoboticArm_HeldRock"
    held_rock.data.materials.append(mat_rock)
    held_rock.parent = arm_claw

    # 10. Next-Gen Airless Compliant Lattice Wheels & Suspension
    wheel_configs = [
        ("FL", -1.02, -1.05, 0.0),
        ("FR", 1.02, -1.05, 0.0),
        ("RL", -1.02, 1.05, 0.0),
        ("RR", 1.02, 1.05, 0.0),
    ]

    for label, x, y, z in wheel_configs:
        is_left = x < 0

        # Double-Wishbone Suspension A-Arms
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x * 0.58, y, 0.22))
        susp = bpy.context.active_object
        susp.name = f"Suspension_{label}"
        susp.scale = (0.42, 0.14, 0.08)
        susp.data.materials.append(mat_titanium)
        susp.parent = chassis

        # Coilover Damper Strut with Reservoir
        bpy.ops.mesh.primitive_cylinder_add(radius=0.035, depth=0.45, location=(x * 0.65, y, 0.35))
        shock = bpy.context.active_object
        shock.name = f"Shock_{label}"
        shock.rotation_euler = (0, math.radians(25 if is_left else -25), 0)
        shock.data.materials.append(mat_carbon)
        shock.parent = susp

        # Steering Knuckle Pivot Empty
        bpy.ops.object.empty_add(type="PLAIN_AXES", location=(x * 0.88, y, z + 0.12))
        knuckle = bpy.context.active_object
        knuckle.name = f"SteeringKnuckle_{label}"
        knuckle.parent = susp

        # Wheel Assembly Group (Center Hub + Open Airless Compliant Lattice Blades + Outer Cleat Ring)
        # 1. Main Wheel Mesh (Tire Cylinder for kinematics & bounding)
        bpy.ops.mesh.primitive_cylinder_add(
            radius=0.42,
            depth=0.32,
            location=(x, y, z + 0.12),
            rotation=(0, math.radians(90), 0)
        )
        wheel = bpy.context.active_object
        wheel.name = f"Wheel_{label}"
        wheel.data.materials.append(mat_tire)
        wheel.parent = knuckle

        # 2. Central Titanium Motor Hub
        bpy.ops.mesh.primitive_cylinder_add(
            radius=0.18,
            depth=0.34,
            location=(x, y, z + 0.12),
            rotation=(0, math.radians(90), 0)
        )
        hub = bpy.context.active_object
        hub.name = f"WheelHub_{label}"
        hub.data.materials.append(mat_titanium)
        hub.parent = wheel

        # 3. Radial Compliant Spring Lattice Blades (8 arching blades)
        for blade_idx in range(8):
            blade_ang = blade_idx * (360.0 / 8.0)
            rad = math.radians(blade_ang)
            bx = x
            by = y + math.cos(rad) * 0.28
            bz = (z + 0.12) + math.sin(rad) * 0.28
            bpy.ops.mesh.primitive_cube_add(size=1.0, location=(bx, by, bz))
            blade = bpy.context.active_object
            blade.name = f"LatticeBlade_{label}_{blade_idx+1}"
            blade.scale = (0.26, 0.02, 0.14)
            blade.rotation_euler = (math.radians(-blade_ang + 25), 0, 0)
            blade.data.materials.append(mat_tire)
            blade.parent = wheel

        # 4. Titanium Chevron Traction Cleats (12 cleat grousers on circumference)
        for cleat_idx in range(12):
            cleat_ang = cleat_idx * (360.0 / 12.0)
            rad = math.radians(cleat_ang)
            cx = x + (0.16 if is_left else -0.16)
            cy = y + math.cos(rad) * 0.425
            cz = (z + 0.12) + math.sin(rad) * 0.425
            bpy.ops.mesh.primitive_cube_add(size=1.0, location=(cx, cy, cz))
            cleat = bpy.context.active_object
            cleat.name = f"Cleat_{label}_{cleat_idx+1}"
            cleat.scale = (0.04, 0.08, 0.035)
            cleat.rotation_euler = (math.radians(-cleat_ang), 0, 0)
            cleat.data.materials.append(mat_cleat)
            cleat.parent = wheel

    # 11. Low-Poly Collision Proxy Box
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.35))
    col_box = bpy.context.active_object
    col_box.name = "LRV_Collision_Box"
    col_box.scale = (2.25, 3.45, 0.95)
    col_box.display_type = "WIRE"
    col_box.parent = root

    # 12. Export glTF 2.0 Binary (GLB)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
    )
    print(f"[Blender 4.2] Artemis LTV export complete: {os.path.getsize(out_path):,} bytes")


if __name__ == "__main__":
    out_file = sys.argv[1] if len(sys.argv) > 1 else "/home/jagosan/repos/playground/public/models/apollo_lrv.glb"
    build_apollo_lrv(out_file)
    os._exit(0)
