# Spec 12: Lunar Frontier (Persistent Multiplayer Moon Economy & Subterranean Exploration)

> Target Platforms: WebGL2/WebGPU Desktop & Handhelds (`chubbs`, modern browsers)  
> Tech Stack Differentiation: **Babylon.js v7** 3D client + **Node.js/Fastify WebSocket** authoritative server + **SQLite** persistent moon economy database.

---

## 1. Executive Summary & Game Vision
`Lunar Frontier` is a persistent multiplayer lunar economy and exploration game. Set during the second great lunar rush, rival nation-states and scrappy private startups compete to construct the dominant industrial base on the Moon. 

Unlike single-player surface-only rover simulations, `Lunar Frontier` combines:
1. **Multi-Modal Exploration:** Seamless transition between on-foot astronaut EVA suit locomotion (low-G jumps, suit RCS jetpack, handheld geo-drill) and driving open-top exploration buggies with haulage beds.
2. **Subterranean Infrastructure & Mining:** Deep tunnel excavation into lunar lava tubes and crater floors. Players and automated teams dig shafts, discover mineral veins (Regolith, Basalt, Titanium, Ilmenite, Helium-3, Water Ice), and lay narrow-gauge rail lines for automated ore carts.
3. **Faction Asymmetry:**
   - **Nation-States (Artemis Coalition & Polar Star):** Pristine pressurized geodesic domes, standardized mag-rails, nuclear kilopower reactors, high-spec telemetry.
   - **Scrappy Startups (Helios Extraction & RustBelt Dockworks):** Repurposed shipping container habitats, modified hydraulic loading-dock mechs with jury-rigged excavator arms, diesel/solar auxiliary rigs.
4. **Persistent Multiplayer Moon Economy:** Centralized WebSocket server tracking player avatars, vehicles, tunnel voxels/splines, rail tracks, mineral stockpiles, and dynamic market trading.

---

## 2. Tech Stack Architecture
- **Client 3D Engine:** **Babylon.js v7** (`@babylonjs/core`, `@babylonjs/gui`, `@babylonjs/materials`).
  - High-performance PBR materials with bloom, glow layers, vacuum directional shadows, and Earthshine ambient lighting.
  - Dual camera rigs: 1st/3rd person astronaut EVA suit controller with head bob and low-G physics; chase/cockpit vehicle camera.
  - Procedural 3D tunnel mesh generator (ribbon/tube extrusion with volumetric rock walls).
  - Spline-based rail line rendering and animated ore cart followers.
- **Server & Persistence:**
  - **Fastify HTTP + `ws` WebSocket Server:** Real-time state replication at 20Hz with delta compression and spatial culling.
  - **SQLite Engine (`better-sqlite3` / `sqlite3`):** ACID storage for player profiles, inventories, base claim territories, tunnel shaft segments, rail lines, and market trade logs.
- **Protocol:**
  - Compact JSON/Binary message frames: `C2S_MOVE`, `C2S_ENTER_VEHICLE`, `C2S_EXIT_VEHICLE`, `C2S_MINE_VOXEL`, `C2S_LAY_RAIL`, `C2S_TRADE`, `S2C_WORLD_SNAPSHOT`, `S2C_ENTITY_UPDATE`.

---

## 3. Subsystem Breakdown

### 3.1 Astronaut EVA Suit & Buggy Controller
- **Suit Locomotion:**
  - Lunar gravity ($1.62\,\text{m/s}^2$) with long floaty stride, low-G jump, and short-burst RCS thrusters (Spacebar / Gamepad A).
  - Life support HUD: Oxygen supply, EVA suit battery, suit headlight toggle (`F`), handheld mineral scanner (`Q`).
- **Open-Top Buggy:**
  - 4-wheel independent physics, spring-damper suspension, directional headlights.
  - Proximity mount/dismount (`E` key): Astronaut enters driver seat; camera smoothly transfers to chase camera; vehicle controls engage.
  - Cargo bed capacity (up to 500 kg of mineral crates).

### 3.2 Subterranean Mines & Tunnel Network
- **Excavation Mechanics:**
  - Players or excavation mechs dig into designated mine heads on crater rims.
  - Tunnels generate as connected 3D parametric segments (`TunnelNode` with radius, heading, pitch, depth).
  - Exposed mineral veins inside tunnels sparkle and can be excavated for raw ore.
- **Rail Line Infrastructure:**
  - Players lay modular narrow-gauge rail tracks (`RailTrack` spline) along surface roads and down tunnel ramps.
  - Automated Ore Carts travel on rails between the mine face and the base refinery depot.

### 3.3 Factions & World Entities
- **Nation-State Base:** High-tech dome hub, radar dishes, launchpad, automated sorting bins.
- **Startup Outpost:** Makeshift habitat modules, floodlight towers, modified loading-dock mechs standing at excavation pits.
- **Loading-Dock Mechs:** Bipedal/hexapod industrial mechs with twin pneumatic breaker claws and regolith scoops.

### 3.4 Persistence & Multiplayer Synchronization
- Database Tables:
  - `players` (id, callsign, faction, suit_state, x, y, z, yaw, current_vehicle_id, inventory_json, credits)
  - `vehicles` (id, type, owner_id, x, y, z, rot_y, speed, cargo_json)
  - `tunnel_segments` (id, parent_id, start_x, start_y, start_z, end_x, end_y, end_z, radius, ore_type, depleted)
  - `rail_tracks` (id, network_id, p0_x, p0_y, p0_z, p1_x, p1_y, p1_z, length)
  - `market_orders` (id, faction, resource_type, quantity, price_per_unit, order_type)

---

## 4. Verification & Contract Criteria
1. **Server Test Suite:** Standalone test verifying database initialization, user auth, vehicle mount/dismount persistence, tunnel creation, and rail line serialization.
2. **Client Build:** Clean TypeScript compilation with Vite/Babylon.js bundle.
3. **Autonomous End-to-End Simulation:** Verification script running headless client bots connecting via WebSocket, moving suit, mounting buggy, digging tunnel segment, and logging persisted transactions in SQLite.
