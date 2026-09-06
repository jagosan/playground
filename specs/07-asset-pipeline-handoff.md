# Spec 07: Moonbuggy2 M2 — Remaining Asset Pipeline Milestones (Handoff Plan)

> Status: **Execution-ready handoff** — written 2026-09-05 by the M2 planning session
> (Hermes session `0d985a9c5351`, model `qwen3.8-flash-next:262k` on chunkito).
> A fresh session should work through **M1 → M4 in order**, one milestone at a time.
> Every milestone lists exact commands, acceptance criteria, and the subagent
> dispatch protocol (see §0 for why the first swarm attempt failed and the rules
> that fixed it).

---

## 0. Context, Root Causes, and Dispatch Protocol

### 0.1 What already works (verified 2026-09-05)
The three standalone asset builders were authored, executed, and verified in the
planning session. Real artifacts on disk in `/home/jagosan/repos/playground`:

| File | Size | Status |
|---|---|---|
| `public/models/apollo_lrv.glb` | 86 KB | ✅ exported (target < 4 MB) |
| `public/models/lunar_rocks.glb` | 45 KB | ✅ exported (target < 2 MB) |
| `public/models/lunar_terrain_tile.glb` | 562 KB | ✅ exported (target < 5 MB) |
| `public/models/lunar_drop_station.glb` | 84 KB | ✅ exported (target < 3 MB) |

Builder scripts (all `os._exit(0)`-guarded behind `if __name__ == "__main__":`, so
they are safe to import from the orchestrator):
- `scripts/lunar_assets/rover_builder.py` — `build_apollo_lrv(out_path)`
- `scripts/lunar_assets/rocks_builder.py` — `build_lunar_rocks(out_path)`
- `scripts/lunar_assets/terrain_station_builder.py` — `build_terrain(out_path)`, `build_station(out_path)`

Standalone re-run (each takes ~5–20 s, must finish with exit code 0):
```bash
/home/jagosan/.hermes/toolchains/bpy_env/bin/python scripts/lunar_assets/rover_builder.py
/home/jagosan/.hermes/toolchains/bpy_env/bin/python scripts/lunar_assets/rocks_builder.py
/home/jagosan/.hermes/toolchains/bpy_env/bin/python scripts/lunar_assets/terrain_station_builder.py
```

The orchestrator `scripts/build_lunar_assets.py` was drafted in the planning session
(syntax-checked with `py_compile`, **not yet executed**). It imports the three
builders, runs each phase, renders a headless Cycles/CPU PNG preview into
`public/models/previews/<name>_preview.png`, and writes `public/models/manifest.json`
(asset bytes, size vs. Spec 05 §2.3 targets, object/vertex counts, material slots,
total payload vs. 15 MB target, exit non-zero on any target miss).

### 0.2 Why the first swarm batch (deleg_9364045d) failed — root causes
1. **Chunkito inference timeout (tasks 1–3):** four concurrent `@tigger`
   (qwen3.8-27b @ `http://100.71.183.123:11434/v1`) requests saturated the single
   llama-server; client `request_timeout_seconds: 900` was exceeded (runs hit
   2064–2557 s). **Rule: max 1–2 concurrent @tigger children.**
2. **SQLite session-storage collision (task 4):** concurrent sibling subagents
   opened separate `SessionDB` handles on the same profile `state.db` → write
   failure → turn aborted ("session storage could not be written").
   **FIXED in the planning session:** `~/.hermes/hermes-agent/tools/delegate_tool.py`
   now routes sibling profile subagents through a shared, thread-safe
   `_get_shared_profile_session_db()` cache (one `SessionDB` per resolved db path).
   Unit tests `tests/tools/test_delegate_profile_routing.py` pass (8/8).
   **Requires `hermes gateway restart` to activate in the running gateway.**
3. **Ollama 500 chat-template parse error (task 5, @eeyore):** the beehive ollama
   `ERNIE-4.5-Thinking` template failed parsing a long multi-line prompt
   ("Failed to parse input at pos 30"). **Rule: keep prompts to @eeyore under
   ~1500 chars, one short paragraph each; never embed giant code blocks in the
   delegation prompt — point the child at the files on disk instead.**

### 0.3 Dispatch protocol (Pantheon)
- **Use the full Pantheon** (user directive): @tigger on chunkito for code build,
  @eeyore on beehive ollama for audit, @piglet for verification, @pooh for
  runbook/commit. Delegate via `delegate_task` with `profile` per child.
- **Concurrency:** 1–2 `@tigger` children max (chunkito VRAM/single-server limit).
  `@eeyore`/`@piglet`/`@pooh` (beehive ollama, small 30B-A3B) can run alongside.
  Never run @pooh/@jagular concurrently with @tigger (chunkito mutual exclusion).
- **Prompts:** self-contained, reference on-disk files by absolute path, keep each
  under ~2000 chars, and end with an explicit "verify execution and report
  exit code + artifact sizes" instruction.
- **Verify child claims independently** (read the artifacts yourself) — child
  summaries are self-reports.

### 0.4 Environment facts
- Repo: `/home/jagosan/repos/playground`, branch `feat/moonbuggy2-engine-m2`.
- Blender toolchain: `/home/jagosan/.hermes/toolchains/bpy_env/bin/python` (bpy 4.2.0).
- Repo map for subagent context: `/home/jagosan/repos/playground/docs/MAP.md`
  (keep chunkito prompt eval < 1k tokens — pass the path, not the content).
- Spec 05 (source of the material/size contracts): `specs/05-blender-asset-pipeline.md`.
- Runbook: `docs/runbook/moonbuggy2-operations.md` (add a new section for M3/M4).

---

## M1 — Run the pipeline: previews + manifest

**Goal:** execute `scripts/build_lunar_assets.py --all` end-to-end and produce
`public/models/previews/*.png` (4 PNGs) + `public/models/manifest.json`.

**Owner:** @tigger (chunkito) — single child, no parallel @tigger.

**Steps:**
1. Sanity check orchestrator:
   ```bash
   /home/jagosan/.hermes/toolchains/bpy_env/bin/python -m py_compile \
     /home/jagosan/repos/playground/scripts/build_lunar_assets.py
   ```
2. Run (timeout 600 s is generous; expect 1–4 min with 4 Cycles CPU previews):
   ```bash
   /home/jagosan/.hermes/toolchains/bpy_env/bin/python \
     /home/jagosan/repos/playground/scripts/build_lunar_assets.py --all
   ```
3. If it crashes, debug in-place (typical suspects: Cycles device init in headless
   mode, `bpy.ops` context, preview camera framing). Fix, re-run, until exit 0.
4. If a preview is pitch-black, adjust world background/sun energy in
   `render_preview()` and re-run.

**Acceptance criteria (verify yourself, don't trust the child):**
- `echo $?` == 0 from the pipeline run.
- `public/models/previews/` contains 4 non-empty PNGs (each > 10 KB).
- `public/models/manifest.json` parses as JSON, lists all 4 GLBs with
  `total_vertices > 0`, and `within_total_target: true`.
- All four GLBs still < Spec 05 §2.3 targets.

**Fallback if @tigger times out again:** run step 2 yourself in this session's
terminal (it is a plain script) and patch whatever breaks — do not re-dispatch
without changing the batch shape.

---

## M2 — Runner wrapper + audit (@eeyore, beehive ollama)

**Goal:** `scripts/run_blender_pipeline.sh` — hardened wrapper with timeout,
process isolation, memory audit, and guaranteed clean exit; plus written audit
findings.

**Owner:** @eeyore (beehive ollama). **Keep the prompt short** (see §0.2 rule 3) —
describe the contract in ≤ 10 bullets, point at `specs/05-blender-asset-pipeline.md`
§2.1 and `scripts/build_lunar_assets.py` for details.

**Contract for the wrapper script:**
- Shebang `#!/usr/bin/env bash`, `set -Eeuo pipefail`, executable bit set.
- Run the pipeline under `timeout 900` (overridable via `PIPELINE_TIMEOUT_S`).
- Isolate with a fresh `setsid` process group; on timeout/kill, `kill -TERM` the
  whole group, wait 10 s, then `kill -KILL` stragglers (match
  `bpy_env/bin/python`), so no orphan Blender worker threads survive.
- Memory audit: before/after `free -m` snapshot printed to stderr; also
  `ps -o rss= -p <pid>` peak if `watch`/sampling is used (sample every 5 s in a
  background loop, append to a temp file, print peak RSS line at the end).
- Cleanup trap (`EXIT`/`INT`/`TERM`) removes temp files.
- Final stdout line exactly: `PIPELINE_STATUS=OK` (or `PIPELINE_STATUS=FAIL:<reason>`),
  exit code 0 only on OK.
- **Exit-code semantics to audit and report:** `os._exit(0)` in the Python
  builders skips normal interpreter teardown (documented Blender 4.2 C++ worker
  thread persistence, Spec 05 §2.1); the wrapper must therefore verify no
  surviving `bpy_env` processes after success and treat that as part of the audit.

**Acceptance criteria (verify yourself):**
- `bash -n scripts/run_blender_pipeline.sh` passes; `shellcheck` clean if installed.
- Full run through the wrapper exits 0 and prints `PIPELINE_STATUS=OK`.
- Audit report (child's final summary) lists: peak RSS, pre/post available memory,
  orphan-process check result, and any warnings.

---

## M3 — Verification pass (@piglet, beehive ollama)

**Goal:** independent verification that the pipeline outputs meet Spec 05 contracts.

**Owner:** @piglet. Prompt: point at `specs/05-blender-asset-pipeline.md`,
`public/models/`, and `manifest.json`; ask for a structured verdict.

**Checks to run (piglet should execute these, not eyeball):**
1. All 4 GLBs exist, are valid binary glTF (magic bytes `glTF`), and sizes are
   under the Spec 05 §2.3 targets; total payload < 15 MB.
2. Each GLB parses (e.g. via `bpy` import in the toolchain python, or a small
   `glTF-SDK`/`trimesh` check) and reports node names containing the Spec 05 §1.2
   hierarchy (`Chassis`, `Wheel_FL`…`Wheel_RR`, `RoboticArm_*`, `HighGain_Dish`
   for the rover).
3. `manifest.json` fields are internally consistent (bytes match `stat`,
   `total_payload_bytes` equals sum).
4. 4 preview PNGs exist, each > 10 KB, valid PNG (magic bytes).
5. Re-run one builder standalone (rover) to confirm determinism of the workflow:
   exit 0, file regenerated.

**Acceptance criteria:** piglet's summary returns an explicit PASS/FAIL per check
with the command evidence; you (the orchestrating session) re-verify any FAIL
yourself before declaring M3 done.

---

## M4 — Runbook, docs sync, and git commit (@pooh, beehive ollama)

**Goal:** document operations and land everything on the branch.

**Owner:** @pooh (never concurrent with @tigger on chunkito — run this after M3).

**Steps:**
1. Add a `## Headless Blender Asset Pipeline (Spec 05)` section to
   `docs/runbook/moonbuggy2-operations.md`:
   - toolchain location + one-liner standalone builder commands,
   - `scripts/run_blender_pipeline.sh` usage + timeout env var,
   - manifest/preview locations + how to regenerate previews only,
   - troubleshooting: the three failure modes from §0.2 (timeout, session DB,
     ollama template) and the §0.3 dispatch rules.
2. Update `docs/MAP.md` with the new `scripts/lunar_assets/` modules and
   `scripts/build_lunar_assets.py` (keep the map terse — it feeds subagent prompts).
3. Stage and commit on `feat/moonbuggy2-engine-m2`:
   `feat(moonbuggy2): add headless Blender 4.2 lunar asset pipeline (Spec 05/07)`.
   Include `scripts/lunar_assets/`, `scripts/build_lunar_assets.py`,
   `scripts/run_blender_pipeline.sh`, `public/models/` (4 GLBs + previews +
   manifest.json), spec 05/07, runbook + MAP.md updates.
   Do **not** commit `public/models/lunar_rock.glb` (legacy single-rock artifact
   from earlier work — confirm with the user before deleting or committing it).
4. Report the commit SHA. Push is separate — only if `GITHUB_TOKEN` is present in
   the environment (it was missing in the planning session); otherwise leave the
   branch local and say so.

**Acceptance criteria:** commit exists on `feat/moonbuggy2-engine-m2` with the
files above; `git status` clean except intentional untracked leftovers; runbook
section renders correctly in Obsidian/VS Code.

---

## M5 (optional, follow-up session) — Game runtime integration

Wire `public/models/*.glb` into Moonbuggy2 M3 (Spec 06) runtime: Draco-enabled
GLTFLoader, collision from `LRV_Collision_Box`, terrain height sampling, and
sample-drop interaction at the station hopper. Out of scope for this handoff;
spec it separately once M1–M4 are green.

---

## Session-start checklist for the fresh session
1. `cd /home/jagosan/repos/playground && git status --short` (expect the untracked
   files listed in M4 step 3).
2. `ls -lh public/models/` — confirm the 4 GLBs are present (M1 can skip re-building
   if you only want previews+manifest — the orchestrator rebuilds by default; if
   that's undesirable, pass individual phase flags).
3. `hermes gateway restart` — activates the `delegate_tool.py` shared-SessionDB fix.
4. Read §0.3, then dispatch M1's @tigger child (single, no parallel tiggers).
