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

# 6. Spec 25 General Cleanup & World Expansion smoke suite (162 assertions):
npx tsx scripts/smoke-general-cleanup.ts

# 7. Derelict rival outposts smoke suite (59 assertions):
npx tsx scripts/smoke-rival-bases.ts

# 8. Typecheck and production bundle build:
npm run typecheck:server
npm run build

# 9. Spec 26 X-Corp Citadel & Rail Heist master acceptance suite (161 assertions):
npm run smoke:xcorp-heist
```

## 5. Frontier Systems & Operational Notes (Spec 25)
- **12 km Planetary Crust Skirt & Ballast Berms:** Concentric ring lattice extends horizon out to 12 km following lunar spherical curvature ($R = 1,737.4\,\text{km}$), eliminating black void pop-in. All rail lines grounded with crushed-basalt ballast berm prisms.
- **Powertrain Hill-Hold & Zero-Drift:** Automatic $1,800\,\text{N}$ regenerative coast deceleration below neutral throttle deadband ($|\text{throttle}| \le 0.05$). Rigid mechanical slope gravity cancellation up to $35^\circ$ regolith angle of repose ($0.00\,\text{m/s}$ drift). Slew-rate anti-jerk release ($12\,\text{s}^{-1}$).
- **Autonomous NPC Prospector Bots:** Autonomous roving bots flying waving cloth pennants from 4 factions (Republic of Caelum, United Sol Syndicate, Valles Marineris Conglomerate, New Borealis Commonwealth). AI state machine (patrol, survey, contest claim, harass mine, $1,500\,\text{N}\cdot\text{s}$ dynamic collision nudge, ore siphoning, flee/unload).
- **Derelict Rival Bases:** 3 distinct decayed archetypes (The Scrapper Syndicate Fortress, The Derelict Corporate Enclave, The Nomad Drilling Rig) with territory boundaries ($60\text{--}90\,\text{m}$), damaged defense turret sockets, and surveyable depots.
- **Procedural Web Audio Engine:** $100\%$ zero-asset Web Audio API synthesis engine (sub-bass life-support drone, generative pentatonic synth pads, speed-modulated motor whine, regolith tyre crunch, mining laser hum, crystalline ore chimes, comms chirps) with dedicated HUD audio mixer panel.

## 6. X-Corp Citadel & Great Train Heist Operations (Spec 26)
- **The Obsidian Apex Monolith (`XCorpCitadel.ts`):** 85m tall hexagonal skyscraper positioned at $(X = -1,850\,\text{m}, Y = 2,400\,\text{m})$, flanked by cantilevered executive penthouse pods, grand rail terminal viaduct, dual illuminated VIP landing pads, and a multi-tier perimeter defense system.
  - *Warning Zone ($R \le 260\,\text{m}$):* Comms alert warning intrusion and tracking beacon spotlights.
  - *Kinetic Shield Barrier ($R \le 220\,\text{m}$):* Shimmering geodesic cyan energy curtain enforcing outward repulsion force ($F = 18,000\,\text{N}$ at $r = 200\,\text{m}$).
  - *Lethal CIWS Sentry Zone ($R \le 180\,\text{m}$):* Triple 35m perimeter spires firing continuous laser beams delivering fatal damage ($150\,\text{HP/s}$ / `Infinity` strike).
- **High-Speed Maglev Rail Line (`HighSpeedMaglev.ts`):** $3,500\,\text{m}$ elevated linear induction guideway connecting Canyon Extraction Outpost $(X = 1,200\,\text{m}, Y = 800\,\text{m})$ to Citadel Grand Terminal, supported by concrete pylons every $24\,\text{m}$, pulsing forward blue stator coils, and a parallel $4.0\,\text{m}$ starboard service road.
- **The "Apex Express" Consist:** 4 articulated low-drag cars cruising at $25.0\,\text{m/s}$ ($90\,\text{km/h}$):
  1. *Locomotive (`apex-loco`):* Streamlined wedge prow with twin searchlights and maglev skirts.
  2. *Armored Vault Car (`apex-vault`):* Heavy titanium armor with hazard trim, external catwalk with safety grab rails, and roof Cyber-Lock container.
  3. *Executive Courier (`apex-luxe`):* Luxury passenger cabin with translucent carbon-glass roof.
  4. *Escort Flatbed (`apex-escort`):* Carrying defense drone and comms uplink dish.
- **Train Heist Mechanics (`TrainHeistDirector.ts`):**
  - *Velocity Matching Pocket:* Boarding window triggers when $\Delta v \le 3.5\,\text{m/s}$, lateral offset $d_\text{lat} \in [2.5, 5.5]\,\text{m}$, longitudinal offset $|d_\text{long}| \le 3.0\,\text{m}$.
  - *Catwalk Deck Traversal:* Relative transform anchoring ($P_\text{world} = M_\text{vault} \cdot P_\text{local}$) with zero relative slip while the rover locks into automated parallel tether tracking on the service road.
  - *Vault Cracking & Loot:* 6.0s mag-lock bypass yields 3 Enriched He-3 Flasks, 1 Quantum Cipher Slate, and 2 Superconducting Coils (total 24 kg cargo).
  - *Depot Countdown & Bailout:* Clamshell opening arms a 44.0s countdown as the train speeds toward the Citadel shield barrier. Leaping off deck before the lethal threshold delivers the player safely into the badlands to fence the haul at RustBelt Dockworks.
- **Narrative Quest ("Operation Gilded Serpent"):** 6-stage quest chain (`MEET_FIXER`, `INTERCEPT_CONVOY`, `BOARD_TRANSPORT`, `CRACK_VAULT`, `LEAP_TO_SAFETY`, `DELIVER_CONTRABAND`).
- **Heist HUD & Procedural Audio:** Intercept radar with target reticle, segmented depot countdown bar, 3-ring alignment dial, gold contraband pill, 120–280 Hz guideway hum, Doppler flyby whoosh, 40 Hz magnetic disengage thud, and 660/880 Hz alternating klaxon alarm.

## 7. Production Build & Deployment
```bash
cd games/lunar-frontier
npm run build
```
Build output lands in `dist/`, served statically by Vite or reverse-proxied behind Caddy/Nginx.
