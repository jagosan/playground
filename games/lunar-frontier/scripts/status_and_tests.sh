#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=========================================================="
echo "      LUNAR FRONTIER — REPOSITORY & SYSTEM STATUS"
echo "=========================================================="
echo "Working directory: ${ROOT_DIR}"
echo "Timestamp: $(date -u)"

echo ""
echo "--- [1/4] Checking Chunkito Hardware & Model Server ---"
if curl -s --max-time 3 http://100.71.183.123:11434/health | grep -q '"status":"ok"'; then
  OCCUPANT=$(python3 /home/jagosan/hermes-config/scripts/jagular_woods_gate.py status 2>/dev/null || echo "UNKNOWN")
  echo "✓ Chunkito (100.71.183.123:11434) is healthy and answering."
  echo "  Gate Status: ${OCCUPANT}"
  SLOTS_BUSY=$(curl -s http://100.71.183.123:11434/slots 2>/dev/null | jq '[.[] | select(.is_processing==true)] | length' 2>/dev/null || echo "0")
  echo "  Active processing slots: ${SLOTS_BUSY}"
else
  echo "⚠ Warning: Chunkito (100.71.183.123:11434) did not respond with 200 OK within 3s."
fi

echo ""
echo "--- [2/4] Verifying LunarServer & SQLite Engine ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-lunarserver.ts

echo ""
echo "--- [3/4] Verifying LunarWorldGenerator (60 Seeds & Dijkstra) ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-lunarworld.ts

echo ""
echo "--- [4/4] Verifying TraversalPhysics (Suit, Buggy, Rail) ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-traversal.ts

echo ""
echo "=========================================================="
echo "🎉 ALL VERIFIED CORE SYSTEMS ARE GREEN!"
echo "=========================================================="
echo "Next tasks for incoming session:"
echo "1. Client Engine & Renderer (Babylon.js 3D world scene, vacuum lighting, camera rig)"
echo "2. Faction Outposts & Loading-Dock Mechs (Nation-State domes vs Scrappy Startup pads)"
echo "3. Multi-client End-to-End WebSocket simulation integration test"
echo "=========================================================="
