#!/usr/bin/env python3
"""Spec 05 Headless Blender 4.2 Lunar Asset Pipeline Orchestrator.

Orchestrates all three asset builders, renders headless PNG previews, and
generates the asset metadata manifest at public/models/manifest.json.

Invocation (per Spec 05 Section 2.1):
    /home/jagosan/.hermes/toolchains/bpy_env/bin/python scripts/build_lunar_assets.py --all

Phase flags:
    --rover      Apollo LRV master model          -> public/models/apollo_lrv.glb
    --rocks      Vesicular basalt boulders        -> public/models/lunar_rocks.glb
    --terrain    Cratered terrain tile            -> public/models/lunar_terrain_tile.glb
    --station    Apollo drop station              -> public/models/lunar_drop_station.glb
    --all        All four phases (default)

Exit contract:
    Exits 0 on full success, non-zero on the first failed phase.
    Blender 4.2 C++ worker threads outlive Python interpreter teardown, so the
    script terminates with os._exit() (per Spec 05 process exit guarantee).
"""

import argparse
import importlib.util
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = REPO_ROOT / "public" / "models"
PREVIEW_DIR = MODELS_DIR / "previews"
MANIFEST_PATH = MODELS_DIR / "manifest.json"
BUILDER_DIR = REPO_ROOT / "scripts" / "lunar_assets"

sys.path.insert(0, str(BUILDER_DIR))
import bpy  # noqa: E402

# Size targets from Spec 05 Section 2.3 (MB)
SIZE_TARGETS_MB = {
    "apollo_lrv.glb": 4.0,
    "lunar_rocks.glb": 2.0,
    "lunar_terrain_tile.glb": 5.0,
    "lunar_drop_station.glb": 3.0,
}
TOTAL_TARGET_MB = 15.0

# Phase -> (builder module, builder function, output glb)
PHASES = {
    "rover": ("rover_builder", "build_apollo_lrv", "apollo_lrv.glb"),
    "rocks": ("rocks_builder", "build_lunar_rocks", "lunar_rocks.glb"),
    "terrain": ("terrain_station_builder", "build_terrain", "lunar_terrain_tile.glb"),
    "station": ("terrain_station_builder", "build_station", "lunar_drop_station.glb"),
}


def load_builder_module(module_name: str):
    mod_path = BUILDER_DIR / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(module_name, mod_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_phase(phase: str) -> Path:
    module_name, func_name, glb_name = PHASES[phase]
    out_path = MODELS_DIR / glb_name
    module = load_builder_module(module_name)
    builder_fn = getattr(module, func_name)
    print(f"\n{'=' * 64}\n[PIPELINE] Phase: {phase} -> {out_path}\n{'=' * 64}")
    started = time.time()
    builder_fn(str(out_path))
    print(f"[PIPELINE] Phase '{phase}' completed in {time.time() - started:.1f}s")
    return out_path


def _scene_bounds():
    """Return (center, max_dim) across all mesh objects in the scene."""
    import mathutils

    corners = []
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            for corner in obj.bound_box:
                corners.append(obj.matrix_world @ mathutils.Vector(corner))
    if not corners:
        return mathutils.Vector((0, 0, 0)), 1.0
    min_v = mathutils.Vector(
        (min(c[i] for c in corners) for i in range(3))
    )
    max_v = mathutils.Vector(
        (max(c[i] for c in corners) for i in range(3))
    )
    center = (min_v + max_v) / 2.0
    max_dim = max(max((max_v - min_v)[i] for i in range(3)), 0.5)
    return center, max_dim


def render_preview(glb_name: str) -> Path:
    """Headless Cycles/CPU PNG preview of the current in-memory scene."""
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    preview_path = PREVIEW_DIR / f"{glb_name.replace('.glb', '')}_preview.png"

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(preview_path)

    # World: deep space
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.002, 0.002, 0.004, 1.0)
        bg.inputs[1].default_value = 1.0

    # Framing
    center, max_dim = _scene_bounds()
    dist = max_dim * 1.9

    # Sun key light (lunar: harsh, unfiltered)
    bpy.ops.object.light_add(type="SUN", location=center + mathutils_vec((dist * 0.6, dist * 0.4, dist * 0.8)))
    sun = bpy.context.active_object
    sun.name = "Preview_Sun"
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(48), 0, math.radians(35))
    # Aim sun at center
    bpy.ops.object.empty_add(location=tuple(center))
    target = bpy.context.active_object
    target.name = "Preview_Target"
    constraint = sun.constraints.new("TRACK_TO")
    constraint.target = target
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"

    # Camera
    cam_offset = mathutils_vec((dist * 0.72, -dist * 0.95, dist * 0.52))
    bpy.ops.object.camera_add(location=tuple(center + cam_offset))
    camera = bpy.context.active_object
    camera.name = "Preview_Camera"
    cam_constraint = camera.constraints.new("TRACK_TO")
    cam_constraint.target = target
    cam_constraint.track_axis = "TRACK_NEGATIVE_Z"
    cam_constraint.up_axis = "UP_Y"
    scene.camera = camera

    bpy.ops.render.render(write_still=True)
    print(f"[PREVIEW] {preview_path} ({os.path.getsize(preview_path):,} bytes)")
    return preview_path


def mathutils_vec(v):
    import mathutils

    return mathutils.Vector(v)


def collect_scene_stats(glb_path: Path) -> dict:
    """Vertex count, object count, and material slots of the current scene."""
    objects = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    total_vertices = sum(len(o.data.vertices) for o in objects)
    materials = sorted(
        {m.name for o in objects for m in o.data.materials if m}
    )
    return {
        "file": glb_path.name,
        "path": str(glb_path.relative_to(REPO_ROOT)),
        "bytes": glb_path.stat().st_size,
        "size_mb": round(glb_path.stat().st_size / (1024 * 1024), 3),
        "size_target_mb": SIZE_TARGETS_MB.get(glb_path.name),
        "objects": len(objects),
        "total_vertices": total_vertices,
        "materials": materials,
    }


def write_manifest(assets: list, started_at: float) -> None:
    payload = sum(a["bytes"] for a in assets)
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "pipeline_duration_s": round(time.time() - started_at, 1),
        "blender_version": bpy.app.version_string,
        "toolchain": str(Path(bpy.app.binary_path)),
        "assets": assets,
        "total_payload_bytes": payload,
        "total_payload_mb": round(payload / (1024 * 1024), 3),
        "total_target_mb": TOTAL_TARGET_MB,
        "within_total_target": payload < TOTAL_TARGET_MB * 1024 * 1024,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"\n[MANIFEST] {MANIFEST_PATH}")
    print(f"[MANIFEST] Total payload: {manifest['total_payload_mb']} MB / {TOTAL_TARGET_MB} MB target")


def main() -> int:
    parser = argparse.ArgumentParser(description="Spec 05 Lunar Asset Pipeline Orchestrator")
    parser.add_argument("--all", action="store_true", help="Run all four phases (default)")
    for flag in ("rover", "rocks", "terrain", "station"):
        parser.add_argument(f"--{flag}", action="store_true", dest=flag, help=f"Build {flag} phase only")
    args = parser.parse_args()

    requested = [p for p in ("rover", "rocks", "terrain", "station") if getattr(args, p)]
    if not requested:
        requested = list(PHASES.keys())

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    started_at = time.time()
    manifest_assets = []
    existing_manifest = (
        json.loads(MANIFEST_PATH.read_text()) if MANIFEST_PATH.exists() else None
    )

    for phase in requested:
        glb_path = run_phase(phase)
        if not glb_path.exists():
            print(f"[PIPELINE][ERROR] Phase '{phase}' did not produce {glb_path}")
            return 1
        stats = collect_scene_stats(glb_path)
        stats["preview"] = ""
        stats["preview_bytes"] = 0
        try:
            preview_path = render_phase_preview(glb_path.name)
            stats["preview"] = str(preview_path.relative_to(REPO_ROOT))
            stats["preview_bytes"] = preview_path.stat().st_size
        except Exception as exc:  # noqa: BLE001
            print(f"[PIPELINE][WARN] Preview render failed for {glb_path.name}: {exc}")
        manifest_assets.append(stats)

    # Merge with existing manifest entries for phases not requested this run
    if existing_manifest and len(manifest_assets) < len(PHASES):
        have = {a["file"] for a in manifest_assets}
        for prev in existing_manifest.get("assets", []):
            if prev["file"] not in have:
                manifest_assets.append(prev)
        manifest_assets.sort(key=lambda a: list(SIZE_TARGETS_MB).index(a["file"])
                             if a["file"] in SIZE_TARGETS_MB else 99)

    write_manifest(manifest_assets, started_at)

    # Validate size targets
    failures = 0
    for asset in manifest_assets:
        target = asset.get("size_target_mb")
        if target and asset["size_mb"] >= target:
            print(f"[PIPELINE][FAIL] {asset['file']} exceeds target: "
                  f"{asset['size_mb']} MB >= {target} MB")
            failures += 1
    if failures:
        return 1

    print("\n[PIPELINE] ALL PHASES PASSED")
    os._exit(0)


def render_phase_preview(glb_name: str) -> Path:
    return render_preview(glb_name)


if __name__ == "__main__":
    try:
        rc = main()
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        print(f"[PIPELINE][ERROR] {exc}")
        rc = 1
    os._exit(rc)
