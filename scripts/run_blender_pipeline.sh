#!/usr/bin/env bash
set -Eeuo pipefail

# Resolve REPO_ROOT from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Default timeout (in seconds)
PIPELINE_TIMEOUT_S="${PIPELINE_TIMEOUT_S:-900}"
PYTHON_TOOLCHAIN="/home/jagosan/.hermes/toolchains/bpy_env/bin/python"

# Temporary files
MEMORY_LOG="$(mktemp /tmp/pipeline_mem_XXXXXX.log)"
PEAK_RSS_FILE="$(mktemp /tmp/pipeline_rss_XXXXXX.log)"
PID_GROUP=""

cleanup() {
    local exit_code=$?
    # Stop sampling loop if running
    if [[ -n "${MONITOR_PID:-}" ]] && kill -0 "$MONITOR_PID" 2>/dev/null; then
        kill "$MONITOR_PID" 2>/dev/null || true
    fi
    # If pipeline process group is still alive, terminate cleanly
    if [[ -n "${PID_GROUP:-}" ]] && kill -0 "$PID_GROUP" 2>/dev/null; then
        echo "[WRAPPER] Terminating pipeline process group -$PID_GROUP..." >&2
        kill -TERM -"$PID_GROUP" 2>/dev/null || true
        sleep 2
        if kill -0 "$PID_GROUP" 2>/dev/null; then
            echo "[WRAPPER] Force killing stragglers in -$PID_GROUP..." >&2
            kill -KILL -"$PID_GROUP" 2>/dev/null || true
        fi
    fi
    rm -f "$MEMORY_LOG" "$PEAK_RSS_FILE"
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "=== Memory Audit: Pre-Execution ===" >&2
free -m >&2

# Start pipeline in its own process group via setsid
setsid "$PYTHON_TOOLCHAIN" "$REPO_ROOT/scripts/build_lunar_assets.py" --all &
PID_GROUP=$!

# Background RSS monitor loop
(
    peak=0
    while kill -0 "$PID_GROUP" 2>/dev/null; do
        # Sample total RSS of the process group
        rss_total=0
        for p in $(pgrep -g "$PID_GROUP" 2>/dev/null || true); do
            rss=$(ps -o rss= -p "$p" 2>/dev/null | tr -d ' ' || echo 0)
            if [[ "$rss" =~ ^[0-9]+$ ]]; then
                rss_total=$((rss_total + rss))
            fi
        done
        if [[ $rss_total -gt $peak ]]; then
            peak=$rss_total
        fi
        echo "$peak" > "$PEAK_RSS_FILE"
        sleep 2
    done
) &
MONITOR_PID=$!

# Wait for pipeline under timeout
timed_out=0
elapsed=0
while kill -0 "$PID_GROUP" 2>/dev/null; do
    if [[ $elapsed -ge $PIPELINE_TIMEOUT_S ]]; then
        echo "[WRAPPER] Pipeline exceeded timeout of ${PIPELINE_TIMEOUT_S}s" >&2
        timed_out=1
        kill -TERM -"$PID_GROUP" 2>/dev/null || true
        sleep 5
        kill -KILL -"$PID_GROUP" 2>/dev/null || true
        break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

wait "$PID_GROUP" 2>/dev/null || PIPELINE_EXIT=$?
PIPELINE_EXIT=${PIPELINE_EXIT:-0}

# Stop RSS monitor
kill "$MONITOR_PID" 2>/dev/null || true
wait "$MONITOR_PID" 2>/dev/null || true

echo "=== Memory Audit: Post-Execution ===" >&2
free -m >&2

PEAK_RSS_KB=$(cat "$PEAK_RSS_FILE" 2>/dev/null || echo 0)
PEAK_RSS_MB=$(awk "BEGIN {printf \"%.2f\", $PEAK_RSS_KB / 1024}")
echo "=== Audit Metrics ===" >&2
echo "Peak RSS: ${PEAK_RSS_KB} KB (~${PEAK_RSS_MB} MB)" >&2
echo "Elapsed Time: ${elapsed}s (Timeout: ${PIPELINE_TIMEOUT_S}s)" >&2

# Audit for orphan bpy_env processes (use bracket regex to ignore pgrep itself; || true for pipefail)
ORPHAN_COUNT=$( (pgrep -f '[b]py_env/bin/python' || true) | wc -l | awk '{print $1}')
echo "Surviving bpy_env processes: ${ORPHAN_COUNT}" >&2

if [[ $timed_out -eq 1 ]]; then
    echo "PIPELINE_STATUS=FAIL:TIMEOUT"
    exit 124
elif [[ $PIPELINE_EXIT -ne 0 ]]; then
    echo "PIPELINE_STATUS=FAIL:EXIT_$PIPELINE_EXIT"
    exit "$PIPELINE_EXIT"
elif [[ $ORPHAN_COUNT -ne 0 ]]; then
    echo "PIPELINE_STATUS=FAIL:ORPHAN_PROCESSES"
    exit 1
else
    echo "PIPELINE_STATUS=OK"
    exit 0
fi
