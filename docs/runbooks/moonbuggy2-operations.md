# Runbook: Moonbuggy 2 High-Fidelity Simulator Operations (Spec 03 + Milestone 2 / Spec 04)

## 1. Overview
`Moonbuggy2` is an ultra-realistic Apollo Lunar Roving Vehicle (LRV) simulation tuned for the GPD Win Max 2 (`chubbs`, AMD Radeon 780M). It features 120Hz sub-stepped multi-body suspension dynamics, Pacejka tire slip, PBR regolith with Hapke retro-reflection, and dual camera modes (chase and first-person cockpit).

**Milestone 2 (Spec 04)** extends the simulator with high-speed drive control (25 km/h governor), a dynamic-mass moon-rock sampling loop, an articulated 3-segment robotic arm, an Apollo science drop station, a draining/rechargeable fuel-battery gauge, and a Blender 4.2 headless asset & export pipeline.

## 2. GPD Win Max 2 Hardware & Gamepad Controls
The built-in gamepad on `chubbs` maps automatically via the W3C Gamepad API (XInput):

| Action | GPD Win Max 2 Gamepad | Keyboard / Mouse Fallback |
|---|---|---|
| **Steering** | **Left Analog Stick** (proportional dual-axle) | `A` (Left) / `D` (Right) or Arrows |
| **Throttle** | **Right Trigger (RT)** (analog 0–100%) | `W` or `Up Arrow` |
| **Brakes** | **Left Trigger (LT)** (analog deceleration) | `S` or `Down Arrow` |
| **Handbrake / Arm Pickup** | **Button A** (handbrake; arm grab when near a rock) | `Spacebar` or `E` |
| **Reverse Gear** | **Button X** | `R` key |
| **Toggle Camera** | **Button Y** (Chase / Cockpit) | `C` key or `[C] CAMERA` button |
| **Exit to Lobby**| — | `Escape` key or `[ESC] LOBBY` button |

## 3. Entering the Simulation from Playground
1. Launch `http://100.99.188.15:8088/` (Tailscale) or `http://localhost:8088/`.
2. In the 3D Playground Lobby, approach the **Moonbuggy 2 Simulator** pedestal (located at coordinates `X=-8, Z=14`, decorated with Apollo blue curb and gold foil chassis).
3. Press **`E`** or click/tap the golden **`PLAY`** prompt banner.
4. The simulation mounts the Hadley Rille lunar environment with 1.622 m/s² lunar gravity and Apollo cockpit telemetry.

## 4. Milestone 2 (Spec 04) Mechanics

### 4.1 Top-Speed Control & Drive Dynamics
- **Speed governor:** hard cap at **25.0 km/h** (`6.944 m/s`). High initial motor torque tapers smoothly into the governor; the RT trigger remains fully analog for fine throttle precision.
- **Drive train:** 4× independent 1.2 kW wheel hub motors, variable low-end torque (`T_max = 340 N·m`), tuned so **0–20 km/h ≈ 2.8 s** unladen.
- **Dynamic mass:** each collected rock adds **+35 kg** of payload (up to 8 rocks = **+280 kg**). Increased downforce reduces lunar bounce and moderately damps acceleration.

### 4.2 Moon-Rock Robotic Arm (Pickup)
- Forward-mounted **3-segment robotic boom** (rover front-right):
  - Base turret — yaw `±45°`
  - Bicep boom — pitch `0 → −60°`
  - Forearm + end-effector **sample-grab claw**
- **Trigger:** automatically engages when the rover is **within 3.5 m of a target rock** while holding **Button A** (gamepad) or **Space / E**.
- On a successful grab the arm kinematics animate the reach-and-claw cycle, the rock is added to cargo (**+35 kg**), and the battery gauge takes a **1.5%** action cost.

### 4.3 Apollo Science Drop Station
- Circular **beacon platform at origin `(0, 0)`** with a glowing radio-telemetry dish and navigation beacons.
- When the buggy enters the **6-meter landing radius**:
  - Collected rocks transfer to the scientific **sample hopper**.
  - **Cargo weight clears** (restores full acceleration).
  - **Battery/fuel gauge recharges to 100%** at **15 %/s**.
  - Audio + visual HUD confirmation plays.

### 4.4 Fuel / Battery Management
- **Gauge capacity:** 100 %.
- **Drain:** normal driving drains **~0.35 %/s** (proportional to throttle); a robotic-arm action costs a flat **1.5 %**.
- **Recharge:** the drop station restores the gauge at **15 %/s** (reaches 100 % in ~6.7 s).
- Plan sample runs around the `(0, 0)` station: drive to a rock field, grab up to 8 rocks, then return to the station to dump payload and fully recharge.

## 5. Headless Blender Asset Pipeline (Spec 05)
The master Apollo LRV, rock field, terrain tile, and drop-station GLBs are generated headlessly with the bundled **Blender 4.2** toolchain (`/home/jagosan/.hermes/toolchains/bpy_env/bin/python`, bpy 4.2.0 — no system `blender` binary required):

```bash
# Full pipeline: 4 GLBs + Cycles previews + manifest.json (~2 min)
bash scripts/run_blender_pipeline.sh            # hardened wrapper (timeout, process group, memory audit)

# Standalone one-liner builders (each ~5-20 s)
/home/jagosan/.hermes/toolchains/bpy_env/bin/python scripts/lunar_assets/rover_builder.py
/home/jagosan/.hermes/toolchains/bpy_env/bin/python scripts/lunar_assets/rocks_builder.py
/home/jagosan/.hermes/toolchains/bpy_env/bin/python scripts/lunar_assets/terrain_station_builder.py

# Orchestrator with individual phases (re-export one GLB + re-render its preview)
/home/jagosan/.hermes/toolchains/bpy_env/bin/python scripts/build_lunar_assets.py --rover
```

- Wrapper timeout is overridable: `PIPELINE_TIMEOUT_S=1800 bash scripts/run_blender_pipeline.sh` (default 900 s). Prints `PIPELINE_STATUS=OK` on success and audits peak RSS, pre/post memory, and orphan `bpy_env` processes (isolation via `setsid` process group; `kill -TERM` then `kill -KILL` on timeout).
- Outputs: `public/models/*.glb` (4 assets, ~0.76 MB total vs 15 MB target), `public/models/previews/*_preview.png` (Cycles/CPU 1024x768, 24 samples), `public/models/manifest.json` (bytes vs size budget, vertex counts, material slots).
- **Regenerate previews only:** run the orchestrator with a phase flag (e.g. `--rover`) — builders are idempotent: re-export GLB, re-render preview, rewrite manifest.
- Verification pass (Spec 05 §2.3 contracts): `/home/jagosan/.hermes/toolchains/bpy_env/bin/python tests/verify_m3_assets.py` (5 checks: glTF magic + size budget, node hierarchy, manifest consistency, PNG previews, standalone re-run determinism).

### 5.1 Troubleshooting (failure modes observed, Spec 07 §0.2)
1. **Chunkito inference timeout** — parallel `@tigger` children saturated the single llama-server (runs hit 2000+ s, > 900 s client timeout). Rule: max 1-2 concurrent `@tigger` children.
2. **Session storage write failures** — concurrent sibling subagents opened competing `SessionDB` handles on the same profile `state.db` ("session storage could not be written"). Fixed in `delegate_tool.py` (shared SessionDB cache); requires `hermes gateway restart` to activate.
3. **Ollama 500 chat-template parse errors** (`Failed to parse input at pos 30`) — beehive `ERNIE-4.5-Thinking` chokes on long multi-line prompts. Rule: keep prompts under ~1500 chars, one short paragraph each; point children at files on disk instead of embedding code blocks.
4. **Blender 4.2 segfault on interpreter teardown** — builders finish with `os._exit(0)` (Spec 05 §2.1); never `sys.exit()` in bpy scripts (C++ worker threads outlive the interpreter).

Dispatch rules (Spec 07 §0.3): `@tigger` for code build, `@eeyore` for audit (short prompts only), `@piglet` for verification, `@pooh` for runbook/commit. Never run `@pooh`/`@jagular` concurrently with `@tigger` (chunkito VRAM mutual exclusion).

> Legacy exporters (pre-Spec 05): `scripts/generate_blender_assets.py` and `scripts/export_lrv.py` — superseded, kept for reference. `public/models/lunar_rock.glb` is a legacy single-rock artifact (not part of the pipeline output).

## 6. Next-Gen Artemis LTV & Robotic Arm Rig (Spec 08)
- **Blueprint:** [`docs/architecture/08-artemis-ltv-and-robotic-arm.md`](../architecture/08-artemis-ltv-and-robotic-arm.md)
- **Asset Source:** Procedural Blender builder in `scripts/lunar_assets/rover_builder.py` (`build_apollo_lrv()`).
- **Hierarchy & Features:**
  - White thermal composite aerodynamic hood and contoured wheel fenders.
  - Airless lattice titanium mesh tweels with radial curved spring blades and chevron cleats.
  - Avionics bay with gold MLI Kapton foil, sensor mast with LiDAR dome and NavCams.
  - Dual astronaut cockpit with bucket seats and safety harnesses.
  - 4-DOF robotic arm: base azimuth turret, boom spar, forearm spar, 3-finger claw, targeting laser, and rock pickup node.
- **GLTF Runtime Pivot Compensation:** `ApolloRoverModel.ts` executes `applyGltfPivotCompensation()` to re-center flattened glTF arm spar pivots to their authored joint centers, resolving origin-rotation bugs in Three.js.

## 7. Automated Physics & Regression Testing
Run the 120Hz dynamics benchmark suite:
```bash
npx --prefix /home/jagosan/repos/playground tsx /home/jagosan/repos/playground/tests/verify-moonbuggy2-m2.ts
npx --prefix /home/jagosan/repos/playground tsx /home/jagosan/repos/playground/tests/verify-moonbuggy2.ts
```

Compile and package static distribution:
```bash
npm --prefix /home/jagosan/repos/playground run build
```
The active `playground.service` on `beehive` serves the updated assets immediately.
