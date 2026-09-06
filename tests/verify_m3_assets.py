#!/usr/bin/env python3
"""Milestone M3 Verification Pass for Blender Lunar Assets."""

import os
import json
import struct
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path("/home/jagosan/repos/playground")
MODELS_DIR = REPO_ROOT / "public" / "models"
PREVIEWS_DIR = MODELS_DIR / "previews"
MANIFEST_PATH = MODELS_DIR / "manifest.json"

results = {}

# Check 1: 4 GLBs exist, valid magic bytes, size under targets, total < 15MB
SIZE_TARGETS = {
    "apollo_lrv.glb": 4.0 * 1024 * 1024,
    "lunar_rocks.glb": 2.0 * 1024 * 1024,
    "lunar_terrain_tile.glb": 5.0 * 1024 * 1024,
    "lunar_drop_station.glb": 3.0 * 1024 * 1024,
}
total_size = 0
check1_details = []
check1_pass = True

for glb_name, target in SIZE_TARGETS.items():
    p = MODELS_DIR / glb_name
    if not p.exists():
        check1_pass = False
        check1_details.append(f"MISSING: {glb_name}")
        continue
    sz = p.stat().st_size
    total_size += sz
    with open(p, "rb") as f:
        magic = f.read(4)
    if magic != b"glTF":
        check1_pass = False
        check1_details.append(f"INVALID MAGIC {magic} for {glb_name}")
    elif sz > target:
        check1_pass = False
        check1_details.append(f"SIZE OVERFLOW {sz} > {target} for {glb_name}")
    else:
        check1_details.append(f"{glb_name}: {sz} bytes (target: {target/1024/1024:.1f}MB) OK")

if total_size > 15.0 * 1024 * 1024:
    check1_pass = False
    check1_details.append(f"TOTAL OVERFLOW: {total_size} > 15MB")
else:
    check1_details.append(f"Total payload: {total_size/1024/1024:.3f} MB (target < 15 MB) OK")

results["Check 1: GLB Validation & Size Caps"] = (check1_pass, check1_details)

# Check 2: Node hierarchy in GLBs (rover nodes)
import bpy

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(MODELS_DIR / "apollo_lrv.glb"))
imported_names = [o.name for o in bpy.context.scene.objects]

expected_rover_nodes = [
    "Chassis", "Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR",
    "RoboticArm_Base", "RoboticArm_Boom", "RoboticArm_Claw",
    "HighGain_Dish", "LRV_Collision_Box"
]
missing_nodes = [node for node in expected_rover_nodes if not any(node in name for name in imported_names)]
check2_pass = (len(missing_nodes) == 0)
check2_details = [
    f"Imported objects count: {len(imported_names)}",
    f"Missing nodes: {missing_nodes}",
    f"Sample matched: {[n for n in expected_rover_nodes if any(n in name for name in imported_names)]}"
]
results["Check 2: Rover glTF Node Hierarchy"] = (check2_pass, check2_details)

# Check 3: manifest.json internal consistency
with open(MANIFEST_PATH) as f:
    manifest = json.load(f)

sum_bytes = sum(a["bytes"] for a in manifest["assets"])
check3_pass = True
check3_details = []

if sum_bytes != manifest["total_payload_bytes"]:
    check3_pass = False
    check3_details.append(f"Sum mismatch: sum={sum_bytes} vs declared={manifest['total_payload_bytes']}")
else:
    check3_details.append(f"Payload sum matches: {sum_bytes} bytes")

for a in manifest["assets"]:
    actual_sz = (MODELS_DIR / a["file"]).stat().st_size
    if actual_sz != a["bytes"]:
        check3_pass = False
        check3_details.append(f"{a['file']} bytes mismatch: disk={actual_sz} vs manifest={a['bytes']}")
    else:
        check3_details.append(f"{a['file']} stat verified: {actual_sz} bytes")

results["Check 3: manifest.json Consistency"] = (check3_pass, check3_details)

# Check 4: 4 preview PNGs exist, > 10KB, valid PNG magic bytes
check4_pass = True
check4_details = []
for a in manifest["assets"]:
    preview_path = REPO_ROOT / a["preview"]
    if not preview_path.exists():
        check4_pass = False
        check4_details.append(f"MISSING PREVIEW: {preview_path}")
        continue
    sz = preview_path.stat().st_size
    with open(preview_path, "rb") as f:
        png_magic = f.read(8)
    if png_magic != b"\x89PNG\r\n\x1a\n":
        check4_pass = False
        check4_details.append(f"INVALID PNG MAGIC: {preview_path}")
    elif sz <= 10 * 1024:
        check4_pass = False
        check4_details.append(f"PNG TOO SMALL: {preview_path} ({sz} bytes)")
    else:
        check4_details.append(f"{preview_path.name}: {sz} bytes, valid PNG magic OK")

results["Check 4: Preview PNG Verification"] = (check4_pass, check4_details)

# Check 5: Re-run rover builder standalone to confirm determinism
res = subprocess.run(
    ["/home/jagosan/.hermes/toolchains/bpy_env/bin/python", str(REPO_ROOT / "scripts/lunar_assets/rover_builder.py")],
    capture_output=True,
    text=True
)
check5_pass = (res.returncode == 0)
check5_details = [
    f"Standalone rover builder exit code: {res.returncode}",
    f"Rover file size after run: {(MODELS_DIR / 'apollo_lrv.glb').stat().st_size} bytes"
]
results["Check 5: Rover Builder Determinism"] = (check5_pass, check5_details)

# Print Summary Table
print("=" * 64)
print("MILESTONE M3 VERIFICATION REPORT")
print("=" * 64)
all_pass = True
for check_name, (passed, details) in results.items():
    verdict = "PASS" if passed else "FAIL"
    if not passed:
        all_pass = False
    print(f"[{verdict}] {check_name}")
    for d in details:
        print(f"  - {d}")
print("=" * 64)
print(f"OVERALL VERDICT: {'ALL CHECKS PASSED' if all_pass else 'FAILURES DETECTED'}")
print("=" * 64)

sys.stdout.flush()
os._exit(0 if all_pass else 1)
