# Lunar Frontier Operations Runbook

## 1. Quickstart — Running the Game Server & Client

`games/lunar-frontier` requires two complementary processes to play:
1. **Authoritative Server:** Fastify + WebSocket + SQLite on port `3030`.
2. **Web Client Dev Server:** Vite on port `5174`, which automatically proxies `/ws` and `/api` to port `3030`.

```
Browser Client (http://<IP>:5174) 
   │
   ├─► Assets / HTML ────► Vite Dev Server (port 5174)
   │
   ├─► WebSocket (/ws) ──► Vite Proxy ──► Fastify Server (ws://127.0.0.1:3030/ws)
   └─► HTTP API (/api) ──► Vite Proxy ──► Fastify Server (http://127.0.0.1:3030/api)
```

### One-Line Foreground Commands (from `games/lunar-frontier`):
```bash
# Terminal 1 — Authoritative Shard (Port 3030):
PORT=3030 HOST=0.0.0.0 DB_PATH=./lunarfrontier.db npx tsx src/server/index.ts

# Terminal 2 — Web Client (Port 5174):
npx vite --host 0.0.0.0 --port 5174
```

### Background Service Launch (with log redirection):
```bash
# Start backend shard
cd /home/jagosan/repos/playground/games/lunar-frontier
PORT=3030 HOST=0.0.0.0 DB_PATH=./lunarfrontier.db npx tsx src/server/index.ts > ~/.hermes/logs/lunar-server.log 2>&1 &

# Start Vite client
npx vite --host 0.0.0.0 --port 5174 > ~/.hermes/logs/lunar-vite.log 2>&1 &
```

### Health & URL Endpoints:
- **Tailscale (Remote / In-Flight):** `http://100.99.188.15:5174/`
- **Local LAN:** `http://192.168.86.118:5174/`
- **Localhost:** `http://localhost:5174/`
- **Backend Health Check:** `curl -s http://127.0.0.1:3030/health` (`{"status":"ok","players":N,"uptime":S}`)
- **Logs:** `~/.hermes/logs/lunar-server.log` and `~/.hermes/logs/lunar-vite.log`

---

## 2. Overview
`games/lunar-frontier` is a persistent multiplayer lunar economy simulation and 3D terrain exploration game built on Babylon.js (WebGL2/WebGPU client) and Fastify + WebSocket + SQLite (headless authoritative server).

## 2. Rover Kinematics & Visual Architecture (Spec 15)
- **Visual Structure (`OpenBuggy.ts`):** 27-mesh cohesive lunar rover assembly. All chassis components (tub, frame, cowl, seat, dash, cargo bed, lightbar, taillights) are rigidly parented to `buggy-chassis-body`, guaranteeing zero relative translation under heave or attitude tilt.
- **Suspension Corners:** 4 independent articulated corners with double wishbone A-arms, Ackermann steering knuckles (front), wheel hubs, titanium chevron airless wheels, and curved lunar regolith dust fenders.
- **Kinematics & Dynamics (`TraversalPhysics.ts`):**
  - Symmetric straight-line yaw stabilizer ($M_{\text{damp}} = -k \cdot I_{zz} \cdot \dot{\psi}$) ensures zero drift ($|\Delta y| < 0.05\,\text{m}$ over 10s of full throttle).
  - Speed-sensitive steering derating: $\delta_{\text{max}}(v) = \frac{\delta_0}{1 + 0.08 |v_{\text{long}}|}$.
  - Ackermann steering geometry differential angles between inner and outer wheels.
  - State machine: `FORWARD`, `STOPPED` (hill-hold), `REVERSE` (capped at 5.0 m/s).
  - Critically damped suspension ($\zeta \approx 0.707$) under $1.62\,\text{m/s}^2$ lunar gravity.

## 3. Driving Controls & Calibration
### Keyboard
- `KeyW` or `ArrowUp`: Forward throttle ($0 \to 1$)
- `KeyS` or `ArrowDown`: Brake; reverse from standstill
- `KeyA` or `ArrowLeft`: Steer Left ($\delta < 0$)
- `KeyD` or `ArrowRight`: Steer Right ($\delta > 0$)
- `Space`: Handbrake (4-wheel lockup)
- `KeyE`: Mount / Dismount rover
- `KeyF`: Toggle headlights

### Gamepad (GPD Win Max 2 / Steam Deck / Xbox)
- `Right Trigger (RT)`: Analog forward throttle ($0 \to 1$)
- `Left Trigger (LT)`: Analog brake ($0 \to 1$)
- `Left Stick X`: Smooth proportional steering with 15% inner deadzone and polynomial response ($x^{1.4}$)
- `Left Stick Y` (pull back): Reverse from standstill
- `Button A`: Handbrake slide
- `Button X`: Mount / Dismount rover
- `Button Y`: Toggle headlights

## 4. Verification & Testing
Run the complete automated test suite from `games/lunar-frontier`:

```bash
# 1. Open Buggy smoke suite (102 assertions: 3D assembly, straight-line, reverse, derating, battery):
npx tsx scripts/smoke-open-buggy.ts

# 2. ClientApp input & interaction smoke suite (140 assertions):
npx tsx scripts/smoke-client-app.ts

# 3. Traversal physics engine test suite:
npx tsx scripts/smoke-traversal.ts

# 4. Interactive client E2E test suite (87 assertions):
npx tsx tests/verify-phase8-interactive.ts

# 5. Multi-client persistent server E2E test suite (144 assertions):
npx tsx tests/verify-lunar-frontier.ts

# 6. Typecheck and production bundle build:
npm run typecheck:server
npm run build
```

## 5. Production Build & Deployment
```bash
cd games/lunar-frontier
npm run build
```
Build output lands in `dist/`, served statically by Vite or reverse-proxied behind Caddy/Nginx.
