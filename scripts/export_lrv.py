import bpy
import math
import os

# Headless Blender Export Pipeline for Apollo Lunar Roving Vehicle (LRV)
# Generates high-fidelity PBR GLB with Kapton foil, chassis tub, and wire-mesh wheels

def create_apollo_lrv():
    # Clear default scene
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Collection setup
    col = bpy.data.collections.new("ApolloLRV")
    bpy.context.scene.collection.children.link(col)

    # 1. Materials
    # Gold Kapton / Aluminized Mylar thermal insulation
    mat_gold = bpy.data.materials.new(name="KaptonGoldFoil")
    mat_gold.use_nodes = True
    nodes = mat_gold.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.96, 0.62, 0.07, 1.0)
        bsdf.inputs["Metallic"].default_value = 0.90
        bsdf.inputs["Roughness"].default_value = 0.28

    # Chassis Aluminum
    mat_alum = bpy.data.materials.new(name="ChassisAluminum")
    mat_alum.use_nodes = True
    bsdf_alum = mat_alum.node_tree.nodes.get("Principled BSDF")
    if bsdf_alum:
        bsdf_alum.inputs["Base Color"].default_value = (0.83, 0.83, 0.85, 1.0)
        bsdf_alum.inputs["Metallic"].default_value = 0.75
        bsdf_alum.inputs["Roughness"].default_value = 0.45

    # Wire-Mesh Zinc Wheels
    mat_tire = bpy.data.materials.new(name="WireMeshTire")
    mat_tire.use_nodes = True
    bsdf_tire = mat_tire.node_tree.nodes.get("Principled BSDF")
    if bsdf_tire:
        bsdf_tire.inputs["Base Color"].default_value = (0.15, 0.15, 0.17, 1.0)
        bsdf_tire.inputs["Metallic"].default_value = 0.70
        bsdf_tire.inputs["Roughness"].default_value = 0.80

    # 2. Chassis Hull
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.25))
    chassis = bpy.context.active_object
    chassis.name = "Chassis_Tub"
    chassis.scale = (1.5, 2.6, 0.3)
    chassis.data.materials.append(mat_alum)

    # Forward Kapton Electronics Bay
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, -0.7, 0.45))
    foil = bpy.context.active_object
    foil.name = "Kapton_Electronics_Bay"
    foil.scale = (1.42, 1.1, 0.35)
    foil.data.materials.append(mat_gold)

    # 3. Parabolic High-Gain Dish Antenna
    bpy.ops.mesh.primitive_cone_add(radius1=0.55, radius2=0.12, depth=0.18, location=(0.45, -1.05, 1.25))
    dish = bpy.context.active_object
    dish.name = "HighGain_Dish"
    dish.rotation_euler = (math.radians(-38), 0, math.radians(12))
    dish.data.materials.append(mat_gold)

    # 4. 4 Woven Wheels
    wheel_coords = [
        (-1.02, -1.15, 0),
        (1.02, -1.15, 0),
        (-1.02, 1.15, 0),
        (1.02, 1.15, 0),
    ]
    for idx, (x, y, z) in enumerate(wheel_coords):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.41, depth=0.28, location=(x, y, z))
        wheel = bpy.context.active_object
        wheel.name = f"Wheel_{idx+1}"
        wheel.rotation_euler = (0, math.radians(90), 0)
        wheel.data.materials.append(mat_tire)

    # 5. Export to GLB
    output_path = os.path.abspath("public/models/apollo_lrv.glb")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=output_path, export_format='GLB')
    print(f"Exported Apollo LRV master GLB to: {output_path}")

if __name__ == "__main__":
    create_apollo_lrv()
