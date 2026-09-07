#!/usr/bin/env python3
"""Next-Generation Artemis Lunar Terrain Vehicle (LTV) Master Rig Builder for Blender 4.2.

Phase 1 / Artemis LTV Blender Rig Overhaul & Kinematics Rectification
====================================================================
Photorealistic next-gen Artemis LTV inspired by Astrolab FLEX and Lunar Outpost
Lunar Dawn concepts:

- Sleek aerodynamic composite spaceframe with Artemis White & Matte Carbon bodywork
- Coordinate system aligned with Khronos glTF 2.0 / Three.js standards:
    Blender +Y = Forward (glTF -Z)
    Blender -Y = Rear (glTF +Z)
    Blender -X = Port / Left (glTF -X)
    Blender +X = Starboard / Right (glTF +X)
    Blender +Z = Up (glTF +Y)
- Kapton gold/copper thermal multi-layer insulation (MLI) avionics bay
- Dual high-back astronaut flight seats with 5-point harness relief and center control yoke
- Heavy-duty front bullbar with high-intensity LED lightbars
- Autonomous navigation sensor mast (LiDAR dome, stereo nav-cams, high-gain dish)
- Rear modular science deck with 8 dedicated sample container docks
- 4-wheel independent double-wishbone suspension with coilover dampers
- Compliant airless lattice tweels with titanium chevron traction grousers:
    Axle geometry baked along local X axis.
    Each Wheel_* has origin at (0, 0, 0) inside SteeringKnuckle_*, so
    Three.js knuckle.rotation.y = steer and wheel.rotation.x = forward roll.
    Zero lateral floating displacement.
- 4-DOF articulated robotic arm with identity rest poses and physical joint centers:
    RoboticArm_Base (azimuth yaw, Y) @ chassis (0.78, 0.35, 0.29)
      -> RoboticArm_Boom (shoulder pitch, X) @ base (0, 0, 0.13)
        -> RoboticArm_Forearm (elbow pitch, X) @ boom (0, 0.92, 0)
          -> RoboticArm_Claw (wrist pitch, X) @ forearm (0, 0.82, 0)
            -> RoboticArm_LaserEmitter @ (0, 0.17, 0)
            -> RoboticArm_HeldRock @ (0, 0.10, 0)
- Low-poly collision proxy box for Three.js broadphase.

Exports binary glTF 2.0 to public/models/apollo_lrv.glb.

Backward-compatible node names (required by ApolloRoverModel.ts / RoboticArmController.ts / verify_m3_assets.py):
    LRV_Root, Chassis, Wheel_{FL,FR,RL,RR}, SteeringKnuckle_{FL,FR,RL,RR},
    RoboticArm_Base, RoboticArm_Boom, RoboticArm_Forearm, RoboticArm_Claw,
    RoboticArm_LaserEmitter, RoboticArm_HeldRock, HighGain_Dish,
    Cargo_Rock_{1..8}, Cargo_Ring_{1..8}, LRV_Collision_Box
"""

import math
import os
import sys
from pathlib import Path

import bpy


# ---------------------------------------------------------------------------
# Shared geometry helpers (work on freshly-created primitive objects)
# ---------------------------------------------------------------------------

def _set_pivot(obj, pivot_local: tuple[float, float, float]):
    """Shift the object's local origin to the given local-space point."""
    dx, dy, dz = pivot_local
    for v in obj.data.vertices:
        v.co.x -= dx
        v.co.y -= dy
        v.co.z -= dz
    obj.location.x += dx
    obj.location.y += dy
    obj.location.z += dz


def add_box(name, loc, scale, mat, parent, rot=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    if mat:
        o.data.materials.append(mat)
    if parent:
        o.parent = parent
    return o


def add_cyl(name, loc, radius, depth, mat, parent, rot=(0.0, 0.0, 0.0), verts=24):
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius, depth=depth, vertices=verts, location=loc, rotation=rot
    )
    o = bpy.context.active_object
    o.name = name
    if mat:
        o.data.materials.append(mat)
    if parent:
        o.parent = parent
    return o


def add_empty(name, loc, parent, scale=1.0):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = (scale, scale, scale)
    if parent:
        o.parent = parent
    return o


def add_rock(name, loc, radius, mat, parent, seed):
    """Deterministic, jagged basalt specimen (displaced icosphere)."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=radius, location=loc)
    o = bpy.context.active_object
    o.name = name
    rng = 12345 + seed * 777
    while True:
        rng = (rng * 1103515245 + 12345) & 0x7FFFFFFF
        if rng % 1000 < 900:
            break
    for v in o.data.vertices:
        n = abs(hash((seed, round(v.co.x, 3), round(v.co.y, 3), round(v.co.z, 3)))
                % 997) / 997.0
        f = 0.78 + 0.45 * n
        v.co.x *= f
        v.co.y *= (0.78 + 0.45 * (abs(hash((seed, round(v.co.y, 3))) % 991) / 991.0))
        v.co.z *= 0.72 + 0.38 * n
    if mat:
        o.data.materials.append(mat)
    if parent:
        o.parent = parent
    return o


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------

def create_pbr_material(
    name,
    base_color,
    metallic,
    roughness,
    emissive_color=None,
    emissive_strength=1.0,
):
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

    # 1. High-Fidelity PBR Materials -----------------------------------------
    mat_white = create_pbr_material("ArtemisWhiteComposite", (0.92, 0.93, 0.95, 1.0), 0.15, 0.28)
    mat_carbon = create_pbr_material("MatteCarbonFiber", (0.12, 0.12, 0.14, 1.0), 0.25, 0.42)
    mat_gold = create_pbr_material("KaptonGoldFoil", (0.96, 0.68, 0.10, 1.0), 0.92, 0.20)
    mat_titanium = create_pbr_material("TitaniumDark", (0.42, 0.43, 0.45, 1.0), 0.88, 0.35)
    mat_tire = create_pbr_material("WovenZincWireTire", (0.22, 0.23, 0.25, 1.0), 0.70, 0.60)
    mat_cleat = create_pbr_material("TitaniumCleat", (0.75, 0.76, 0.78, 1.0), 0.90, 0.25)
    mat_seat = create_pbr_material("AstronautSeatFabric", (0.18, 0.20, 0.24, 1.0), 0.05, 0.75)
    mat_harness = create_pbr_material("HarnessOrange", (0.95, 0.35, 0.05, 1.0), 0.10, 0.65)
    mat_led = create_pbr_material(
        "HeadlightEmissive", (1.0, 1.0, 1.0, 1.0), 0.1, 0.1, (1.0, 1.0, 1.0, 1.0), 5.0
    )
    mat_laser = create_pbr_material(
        "LaserEmitter", (0.2, 1.0, 0.3, 1.0), 0.0, 0.1, (0.2, 1.0, 0.3, 1.0), 8.0
    )
    mat_rock = create_pbr_material("LunarBasaltCargo", (0.20, 0.21, 0.22, 1.0), 0.05, 0.92)
    mat_glass = create_pbr_material("NavCamGlass", (0.02, 0.03, 0.05, 1.0), 0.4, 0.08)

    # Master Root Empty -------------------------------------------------------
    root = add_empty("LRV_Root", (0.0, 0.0, 0.0), None)

    # 2. Main Chassis Spaceframe & Underbody Skid Plate -----------------------
    # Center chassis origin at z = 0.26 (axle height z = 0.12 relative to chassis)
    chassis = add_box("Chassis", (0, 0, 0.26), (1.56, 2.75, 0.24), mat_carbon, root)
    add_box("Chassis_SkidPlate", (0, 0, -0.14), (1.35, 2.60, 0.04), mat_titanium, chassis)

    # 3. Aerodynamic White Composite Cowlings & Front Nose Fascia -------------
    # Forward is Blender +Y
    add_box(
        "Body_FrontHood",
        (0, 1.05, 0.22),
        (1.45, 0.85, 0.25),
        mat_white,
        chassis,
        rot=(-math.radians(12), 0, 0),
    )
    # Nose tip wedge (pointed forward snout)
    add_box("Body_NoseTip", (0, 1.48, 0.06), (0.90, 0.30, 0.14), mat_white, chassis)

    for side, x in (("L", -0.72), ("R", 0.72)):
        add_box(f"Body_SidePod_{side}", (x, 0, 0.16), (0.24, 2.40, 0.28), mat_white, chassis)
        # Wheel arch fairings (+Y = Front, -Y = Rear)
        for wy, wl in ((1.05, 0.95), (-1.05, 0.95)):
            add_box(
                f"Body_Arch_{side}_{'F' if wy > 0 else 'R'}",
                (x * 1.06, wy, 0.06),
                (0.16, 0.98, 0.34),
                mat_carbon,
                chassis,
            )

    # Gold Thermal MLI Avionics Bay (between hood and cockpit)
    add_box("Avionics_GoldBay", (0, 0.65, 0.12), (1.20, 0.75, 0.30), mat_gold, chassis)

    # 4. Heavy-Duty Front Bullbar & High-Intensity LED Lightbars ---------------
    add_cyl(
        "Bullbar_Bumper", (0, 1.74, 0.22), 0.032, 1.58, mat_titanium, chassis,
        rot=(0, math.radians(90), 0),
    )
    add_cyl(
        "Bullbar_LowerGuard", (0, 1.74, -0.06), 0.024, 1.30, mat_titanium, chassis,
        rot=(0, math.radians(90), 0),
    )
    for x in (-0.55, 0.55):
        add_cyl(
            f"Bullbar_Upright_{'L' if x < 0 else 'R'}",
            (x, 1.72, 0.06), 0.028, 0.45, mat_titanium, chassis,
        )
    for x in (-0.48, 0.48):
        add_box(
            f"LED_Lightbar_{'L' if x < 0 else 'R'}",
            (x, 1.68, 0.22), (0.32, 0.08, 0.09), mat_led, chassis,
        )
    for x in (-0.55, 0.55):
        add_cyl(
            f"Bullbar_WorkLamp_{'L' if x < 0 else 'R'}",
            (x, 1.72, 0.26), 0.035, 0.05, mat_led, chassis,
        )

    # 5. Integrated Artemis Roll Cage (local to chassis) ----------------------
    cage_tubes = [
        ("Rollbar_Left", -0.68, -0.15, 0.79, 1.45, 0),
        ("Rollbar_Right", 0.68, -0.15, 0.79, 1.45, 0),
        ("Rollbar_Front_L", -0.68, 0.45, 0.59, 1.15, -math.radians(18)),
        ("Rollbar_Front_R", 0.68, 0.45, 0.59, 1.15, -math.radians(18)),
        ("Rollbar_Rear_L", -0.68, -0.85, 0.59, 1.15, math.radians(18)),
        ("Rollbar_Rear_R", 0.68, -0.85, 0.59, 1.15, math.radians(18)),
    ]
    for name, x, y, z, depth, rot_x in cage_tubes:
        add_cyl(name, (x, y, z), 0.035, depth, mat_titanium, chassis, rot=(rot_x, 0, 0))
    add_cyl("Rollbar_Cross", (0, -0.15, 1.46), 0.032, 1.40, mat_titanium, chassis,
            rot=(0, math.radians(90), 0))
    add_cyl("Rollbar_Cross_Rear", (0, -0.85, 1.10), 0.028, 1.36, mat_titanium, chassis,
            rot=(0, math.radians(90), 0))

    # 6. Autonomous Navigation Mast & High-Gain Dish ---------------------------
    mast = add_cyl("SensorMast", (0.45, 0.92, 0.89), 0.03, 0.85, mat_carbon, chassis)
    add_cyl("SensorMast_LiDAR", (0, 0, 0.48), 0.09, 0.12, mat_titanium, mast)
    add_cyl("SensorMast_LiDAR_Dome", (0, 0, 0.56), 0.06, 0.05, mat_glass, mast)
    for side, sx in (("L", -0.12), ("R", 0.12)):
        cam = add_box(f"SensorMast_NavCam_{side}", (sx, 0.06, 0.36), (0.09, 0.10, 0.07),
                      mat_carbon, mast)
        add_cyl(f"SensorMast_NavCam_Lens_{side}", (sx, 0.12, 0.36), 0.025, 0.02,
                mat_glass, cam, rot=(0, math.radians(90), 0))

    bpy.ops.mesh.primitive_cone_add(radius1=0.48, radius2=0.06, depth=0.16,
                                    location=(-0.45, 0.92, 1.19),
                                    rotation=(math.radians(55), math.radians(15), 0))
    dish = bpy.context.active_object
    dish.name = "HighGain_Dish"
    dish.data.materials.append(mat_gold)
    dish.parent = chassis
    add_cyl("HighGain_Feed", (-0.20, 0.85, 1.30), 0.02, 0.22, mat_titanium, chassis,
            rot=(-math.radians(35), 0, 0))

    # 7. Ergonomic Flight Seats & Cockpit Center Console -----------------------
    console = add_box("Cockpit_Console", (0, -0.05, 0.32), (0.20, 0.45, 0.35), mat_carbon, chassis)
    add_box("Cockpit_Screen", (0, 0.02, 0.48), (0.16, 0.02, 0.12), mat_led, console)
    add_cyl("Cockpit_Yoke", (0, 0.12, 0.54), 0.02, 0.18, mat_titanium, console)
    add_cyl("Cockpit_Yoke_Grip", (0, 0.12, 0.64), 0.05, 0.04, mat_carbon, console,
            rot=(0, math.radians(90), 0))

    for name, x in (("Seat_Commander", -0.38), ("Seat_Pilot", 0.38)):
        seat_pan = add_box(f"{name}_Pan", (x, -0.12, 0.22), (0.45, 0.48, 0.12), mat_seat, chassis)
        seat_back = add_box(
            f"{name}_Back", (x, -0.34, 0.56), (0.44, 0.10, 0.62), mat_seat, seat_pan,
            rot=(math.radians(14), 0, 0),
        )
        add_box(
            f"{name}_Harness", (x, -0.32, 0.56), (0.34, 0.11, 0.48), mat_harness, seat_back,
            rot=(math.radians(14), 0, 0),
        )
        for dx in (-0.14, 0.14):
            add_box(
                f"{name}_Harness_Shoulder_{'L' if dx < 0 else 'R'}",
                (x + dx, -0.28, 0.80), (0.05, 0.10, 0.26), mat_harness, seat_back,
                rot=(math.radians(14), 0, 0),
            )

    # 8. Rear Scientific Payload Bed & 8 Rock Canister Docks --------------------
    cargo_bed = add_box("CargoBed", (0, -0.88, 0.20), (1.30, 0.95, 0.16), mat_titanium, chassis)
    cargo_rock_coords = [
        (-0.42, -0.58), (-0.14, -0.58), (0.14, -0.58), (0.42, -0.58),
        (-0.42, -1.05), (-0.14, -1.05), (0.14, -1.05), (0.42, -1.05),
    ]
    for idx, (rx, ry) in enumerate(cargo_rock_coords):
        add_cyl(f"Cargo_Ring_{idx + 1}", (rx, ry, 0.09), 0.10, 0.06, mat_carbon, cargo_bed)
        add_rock(f"Cargo_Rock_{idx + 1}", (rx, ry, 0.16), 0.085, mat_rock, cargo_bed, idx)

    # 9. Next-Gen 4-DOF Articulated Robotic Arm & Gripper ----------------------
    # Joint hierarchy:
    #   RoboticArm_Base (turret yaw, Y) @ chassis (0.78, 0.35, 0.29)
    #     -> RoboticArm_Boom (shoulder pitch, X) @ (0, 0, 0.13)
    #       -> RoboticArm_Forearm (elbow pitch, X) @ (0, 0.92, 0)
    #         -> RoboticArm_Claw (wrist pitch, X) @ (0, 0.82, 0)
    #           -> RoboticArm_LaserEmitter @ (0, 0.17, 0)
    #           -> RoboticArm_HeldRock @ (0, 0.10, 0)
    # Every joint has origin at its pivot center and identity rest rotation.
    # Spars extend forward along Blender +Y (glTF -Z).
    arm_base = add_cyl("RoboticArm_Base", (0.78, 0.35, 0.29), 0.12, 0.22, mat_titanium, chassis)
    add_cyl("RoboticArm_TurretCap", (0, 0, 0.18), 0.09, 0.14, mat_carbon, arm_base)
    add_cyl("RoboticArm_Shoulder", (0, 0, 0.13), 0.06, 0.16, mat_titanium, arm_base,
            rot=(0, math.radians(90), 0))

    # Boom: origin at shoulder joint (0, 0, 0.13) on arm_base; extends along +Y by 0.92m
    bpy.ops.mesh.primitive_cylinder_add(
        radius=0.045, depth=0.92, location=(0, 0.46, 0), rotation=(math.radians(90), 0, 0)
    )
    boom = bpy.context.active_object
    boom.name = "RoboticArm_Boom"
    boom.data.materials.append(mat_carbon)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    boom.location = (0, 0, 0.13)
    boom.parent = arm_base

    # Elbow joint visual on boom
    add_cyl("RoboticArm_Elbow", (0, 0.92, 0), 0.05, 0.14, mat_titanium, boom,
            rot=(0, math.radians(90), 0))

    # Forearm: origin at elbow joint (0, 0.92, 0) on boom; extends along +Y by 0.82m
    bpy.ops.mesh.primitive_cylinder_add(
        radius=0.038, depth=0.82, location=(0, 0.41, 0), rotation=(math.radians(90), 0, 0)
    )
    forearm = bpy.context.active_object
    forearm.name = "RoboticArm_Forearm"
    forearm.data.materials.append(mat_titanium)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    forearm.location = (0, 0.92, 0)
    forearm.parent = boom

    # Wrist visual on forearm
    add_box("RoboticArm_Wrist", (0, 0.82, 0), (0.10, 0.10, 0.12), mat_carbon, forearm)

    # Claw: origin at wrist joint (0, 0.82, 0) on forearm
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0.10, 0))
    claw = bpy.context.active_object
    claw.name = "RoboticArm_Claw"
    claw.scale = (0.18, 0.22, 0.14)
    claw.data.materials.append(mat_titanium)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
    claw.location = (0, 0.82, 0)
    claw.parent = forearm

    # 3 articulated gripper fingers (local to claw, fanned around grasp axis +Y)
    for f_idx, fa in enumerate((0, 120, 240)):
        rad = math.radians(fa)
        fx = math.cos(rad) * 0.07
        fz = math.sin(rad) * 0.07
        add_box(f"RoboticArm_Finger_{f_idx + 1}", (fx, 0.10, fz), (0.025, 0.15, 0.035),
                mat_carbon, claw, rot=(-math.radians(15), 0, 0))

    # Alignment laser emitter along +Y
    add_cyl("RoboticArm_LaserEmitter", (0, 0.17, 0), 0.015, 0.06, mat_laser, claw,
            rot=(math.radians(90), 0, 0))
    # Held rock specimen node inside grip
    add_rock("RoboticArm_HeldRock", (0, 0.10, 0), 0.075, mat_rock, claw, 99)

    # 10. Next-Gen Airless Compliant Lattice Wheels & Suspension ----------------
    wheel_configs = [
        ("FL", -1.02, 1.05),
        ("FR", 1.02, 1.05),
        ("RL", -1.02, -1.05),
        ("RR", 1.02, -1.05),
    ]
    axle_z = 0.12  # chassis-local axle height

    for label, x, y in wheel_configs:
        is_left = x < 0

        # Double-wishbone A-arms (lower + upper)
        add_box(f"Suspension_{label}", (x * 0.58, y, -0.04), (0.42, 0.14, 0.08), mat_titanium,
                chassis)
        add_box(f"Suspension_{label}_Upper", (x * 0.52, y, 0.18), (0.36, 0.10, 0.06),
                mat_titanium, chassis)
        # Coilover damper strut with reservoir
        shock = add_cyl(f"Shock_{label}", (x * 0.65, y, 0.09), 0.035, 0.45, mat_carbon, chassis,
                        rot=(0, math.radians(25 if is_left else -25), 0))
        add_cyl(f"Shock_{label}_Reservoir", (x * 0.58, y, 0.30), 0.05, 0.10, mat_gold,
                shock, rot=(0, 0, 0))

        # Steering knuckle pivot empty at the axle center
        knuckle = add_empty(f"SteeringKnuckle_{label}", (x, y, axle_z), chassis)

        # Wheel assembly: origin at (0, 0, 0) inside knuckle.
        # Cylinder axis oriented along X axle so Three.js rotation.x = forward roll.
        bpy.ops.mesh.primitive_cylinder_add(
            radius=0.42, depth=0.32, vertices=28, location=(0, 0, 0), rotation=(0, math.radians(90), 0)
        )
        wheel = bpy.context.active_object
        wheel.name = f"Wheel_{label}"
        wheel.data.materials.append(mat_tire)
        wheel.parent = knuckle
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)

        # Central motor hub
        bpy.ops.mesh.primitive_cylinder_add(
            radius=0.18, depth=0.34, vertices=20, location=(0, 0, 0), rotation=(0, math.radians(90), 0)
        )
        hub = bpy.context.active_object
        hub.name = f"WheelHub_{label}"
        hub.data.materials.append(mat_titanium)
        hub.parent = wheel
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)

        # Radial compliant spring lattice blades (8 arching spokes in Y-Z plane around X)
        for blade_idx in range(8):
            blade_ang = blade_idx * (360.0 / 8.0)
            rad = math.radians(blade_ang)
            add_box(f"LatticeBlade_{label}_{blade_idx + 1}",
                    (0, math.cos(rad) * 0.28, math.sin(rad) * 0.28),
                    (0.26, 0.02, 0.14), mat_tire, wheel,
                    rot=(-math.radians(blade_ang + 25), 0, 0))

        # Titanium chevron traction cleats (12 grousers on outer rim)
        for cleat_idx in range(12):
            cleat_ang = cleat_idx * (360.0 / 12.0)
            rad = math.radians(cleat_ang)
            cx = 0.16 if is_left else -0.16
            add_box(f"Cleat_{label}_{cleat_idx + 1}",
                    (cx, math.cos(rad) * 0.425, math.sin(rad) * 0.425),
                    (0.04, 0.08, 0.035), mat_cleat, wheel,
                    rot=(-math.radians(cleat_ang), 0, 0))

    # 11. Low-Poly Collision Proxy Box (wire display) ---------------------------
    col_box = add_box("LRV_Collision_Box", (0, 0, 0.35), (2.25, 3.45, 0.95), None, root)
    col_box.display_type = "WIRE"
    if col_box.data.materials:
        col_box.data.materials.clear()

    # 12. Export glTF 2.0 Binary (GLB) ------------------------------------------
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
    sys.stdout.flush()
    os._exit(0)
