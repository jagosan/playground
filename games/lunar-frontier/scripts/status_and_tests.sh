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
echo "--- [1/13] Checking Chunkito Hardware & Model Server ---"
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
echo "--- [2/13] Verifying LunarServer & SQLite Engine ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-lunarserver.ts

echo ""
echo "--- [3/13] Verifying LunarWorldGenerator (60 Seeds & Dijkstra) ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-lunarworld.ts

echo ""
echo "--- [4/13] Verifying TraversalPhysics (Suit, Buggy, Rail) ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-traversal.ts

echo ""
echo "--- [5/13] Verifying Babylon.js WorldScene & CameraRig ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-worldscene.ts

echo ""
echo "--- [6/13] Verifying AstronautSuit Avatar Entity (TASK-PLAY-049a) ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-eva-suit.ts

echo ""
echo "--- [7/13] Verifying OpenBuggy Vehicle Entity (TASK-PLAY-049b) ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-open-buggy.ts

echo ""
echo "--- [8/13] Verifying TunnelNetwork Subterranean Mesh & Veins (TASK-PLAY-048a) ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-tunnel-network.ts

echo ""
echo "--- [9/13] Verifying RailSystem Dual Rails, Ties & Ore Carts (TASK-PLAY-048b) ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-rail-system.ts

echo ""
echo "--- [10/13] Verifying Faction Bases & Loading-Dock Mechs (TASK-PLAY-050) ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-factions-and-mechs.ts

echo ""
echo "--- [11/13] Verifying Multi-Client E2E Shard Simulation & SQLite ACID (TASK-PLAY-051) ---"
cd "${ROOT_DIR}"
node --no-warnings tests/verify-lunar-frontier.ts

echo ""
echo "--- [12/13] Verifying MarketEngine, TRADE & LAY_RAIL Handlers (Phase 8a) ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-market-and-rails.ts

echo ""
echo "--- [13/13] Verifying NetworkClient, Remote Avatar Replication & Reconnect (TASK-PLAY-053) ---"
cd "${ROOT_DIR}"
npx tsx scripts/smoke-network-client.ts

echo ""
echo "=========================================================="
echo "🎉 ALL 13 VERIFIED SUBSYSTEMS ARE GREEN (SPEC 12 + PHASE 8b)!"
echo "=========================================================="
