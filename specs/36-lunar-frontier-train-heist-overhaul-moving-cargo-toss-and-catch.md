# Spec 36: Lunar Frontier — High-Speed Train Heist Overhaul: Moving Cargo Toss & Dynamic Buggy Boarding

> **Target Systems:** `games/lunar-frontier/src/quests/TrainHeistDirector.ts`, `games/lunar-frontier/src/entities/OpenBuggy.ts`, `games/lunar-frontier/src/infrastructure/HighSpeedMaglev.ts`, `games/lunar-frontier/src/physics/BallisticTrajectoryEngine.ts`, `games/lunar-frontier/src/quests/QuestEngine.ts`, `games/lunar-frontier/src/ui/LunarHUD.ts`, `games/lunar-frontier/src/audio/LunarAudioSystem.ts`, `games/lunar-frontier/src/client/ClientApp.ts`.  
> **Platforms:** WebGL2/WebGPU Desktop (Chrome/Firefox/Brave), Mobile Touch (PWA landscape), Gamepad (Linux XInput/Steam Deck).  
> **Preceding Specs:** Spec 26 (Citadel & Train Heist Baseline), Spec 32 (3D Ballistics), Spec 33/34 (Touch & Symmetrical Dual-Sticks), Spec 35 (Fluid Airborne Tuck).  
> **Verification Suite:** `games/lunar-frontier/scripts/smoke-spec36-heist-overhaul.ts` (100% headless under `NullEngine`).

---

## 1. Executive Summary & Narrative Context

In Spec 26, the Great Train Heist introduced velocity matching and on-deck train boarding. However, the execution was static: the player boarded the train, stood in place holding an interaction key for 6 seconds to unlock a cyber-terminal, deposited items directly into virtual suit inventory, and bailed into empty regolith.

### Player Feedback & Core Loop Evolution
Players want an active, physical, movie-caliber heist sequence:
1. **Drive Alongside the Speeding Train:** Pace the $25.0\,\text{m/s}$ ($90\,\text{km/h}$) Apex Express on the parallel service road.
2. **Leap onto the Moving Consist:** Jump across the vacuum gap from the driver's cockpit onto the train's vibrating catwalk.
3. **Plunder Vital Moon Cargo:** The train transports the most valuable survival commodities on the moon—**Pressurized Liquid Water Ice Cells** (`WATER_CRYO_CELL`) and **Liquid Oxygen Cylinders** (`LOX_CYLINDER`), alongside enriched Helium-3 canisters.
4. **Throw Cargo from the Train onto the Moving Buggy:** While the rover tracks alongside on autonomous tethered autopilot, the player unlatches canisters, aims, and **throws them across the moving gap into the buggy's flatbed cargo bed**!
5. **Dynamic Hopper Catch & Magnetic Clamp:** The buggy's flatbed features an active electromagnetic catch envelope that draws in thrown canisters, locking them into physical 3D stacks in the truck bed with satisfying mechanical clangs.
6. **Leap Back onto the Moving Buggy:** With the cargo secured and the 45-second Citadel defense countdown sounding, the player leaps off the train directly back into the moving rover cockpit, grabs the wheel, breaks off from the tracks, and escapes to the Frontier Trading Post to sell the haul and fund vehicle upgrades!

---

## 2. Mathematical Formulations & Physical Laws

```
         [ Speeding Maglev Train (25 m/s) ]
         ┌────────────────────────────────┐
         │ Catwalk: Player tosses canister│
         └───────────────┬────────────────┘
                         │   v_cargo = v_train + v_throw
                         ▼   (Parabolic trajectory in vacuum, Cd = 0)
         ┌────────────────────────────────┐
         │ Buggy Flatbed Magnetic Hopper  │
         │ (Tracks parallel at 4.5m offset│
         │  Electromagnetic clamp: F_mag) │
         └────────────────────────────────┘
         [ Tethered Autopilot Buggy (25 m/s) ]
```

### 2.1 Moving Frame Ballistic Cargo Throw
Because both the maglev train and the tracking buggy travel at velocity $\vec{v}_\text{train} \approx 25\,\text{m/s}$ along track tangent $\hat{T}$, the initial world launch velocity of a thrown cargo container is:

$$\vec{v}_\text{cargo}(0) = \vec{v}_\text{train} + \vec{v}_\text{throw}$$

where $\vec{v}_\text{throw}$ is the player's directed throw impulse:
$$\vec{v}_\text{throw} = v_\text{throw} \cdot \left(\cos(\phi)\hat{u}_\text{aim} + \sin(\phi)\hat{k}\right)$$
- $v_\text{throw} \in [8.0, 14.0]\,\text{m/s}$ (scalable with charge hold or standard impulse $10.0\,\text{m/s}$).
- Pitch elevation $\phi \approx 25^\circ$ ($0.44\,\text{rad}$) above the local horizontal plane.
- In lunar vacuum ($C_d = 0$, $g = 1.62\,\text{m/s}^2$), horizontal relative motion simplifies elegantly: the canister traverses the $4.5\,\text{m}$ lateral gap in $\approx 0.45\text{--}0.55\,\text{seconds}$, maintaining parallel forward velocity with the buggy.

### 2.2 Buggy Flatbed Cargo Catch Envelope & Magnetic Attractor
The rover flatbed hopper defines an interaction envelope in buggy local space:
- **Physical Bed Bounds:** $X \in [-0.75, +0.75]\,\text{m}$ (width), $Y \in [-1.20, -0.10]\,\text{m}$ (aft bed), $Z \in [0.20, 0.90]\,\text{m}$ (height above chassis datum).
- **Soft Electromagnetic Capture Gradient ($R_\text{catch} = 1.8\,\text{m}$):**
  When a falling canister enters within $1.8\,\text{m}$ of the bed center with relative velocity $\|\vec{v}_\text{cargo} - \vec{v}_\text{buggy}\| \le 6.0\,\text{m/s}$:
  $$\vec{F}_\text{mag} = -k_\text{mag} \cdot \frac{\vec{P}_\text{cargo} - \vec{P}_\text{bed}}{\|\vec{P}_\text{cargo} - \vec{P}_\text{bed}\|} - c_\text{damp}(\vec{v}_\text{cargo} - \vec{v}_\text{buggy})$$
  with $k_\text{mag} = 120\,\text{N}$, $c_\text{damp} = 35\,\text{N}\cdot\text{s/m}$.
- **Hard Latch:** Once inside bed bounds, the canister locks to the buggy chassis hierarchy, transitions to `LATCHED` state, increments buggy cargo weight, and renders as an aligned physical mesh in the bed.

### 2.3 Dynamic Moving Re-Boarding Leap
When the player leaps from the train catwalk toward the parallel buggy:
- Player launch: $\vec{v}_\text{launch} = \vec{v}_\text{train} + v_\text{jump}\hat{n}_\text{buggy}$.
- **Cockpit Catch Radius ($R_\text{board} = 2.2\,\text{m}$):**
  When the player avatar enters within $2.2\,\text{m}$ of the buggy driver seat datum while falling, the boarding arbiter captures the avatar:
  1. Cancels relative kinetic impulse.
  2. Snaps avatar smoothly to driver seat transform.
  3. Transitions player state to `DRIVING_BUGGY`.
  4. Releases autopilot override to full player manual steering instantly.

---

## 3. Subsystem Specifications & Phased Implementation

### Phase 1: High-Value Moon Cargo Definitions & Models (`TrainHeistDirector.ts`)
- Define new physical cargo types:
  - `WATER_CRYO_CELL`: Liquid water ice container, $10\,\text{kg}$, base value $1,200$ credits.
  - `LOX_CYLINDER`: High-pressure oxygen cylinder, $8\,\text{kg}$, base value $950$ credits.
  - `HE3_FLASK`: Enriched Helium-3 flask, $4\,\text{kg}$, base value $4,500$ credits.
- Attach procedural PBR cargo models to the Vault Car and Cryo Tanker Car with flashing clamp LED indicators.

### Phase 2: Active Cargo Pick-Up, Aiming & Ballistic Throwing (`ClientApp.ts`, `TrainHeistDirector.ts`)
- Add interaction prompt on catwalk: `[E] / (X) Unclamp & Pick Up Cargo`.
- Avatar holds canister in two-handed carry stance (`carryingCargo = true`).
- HUD projects predictive vacuum trajectory arc and target lead reticle toward the tracking buggy.
- Fire button (`[Left Click]` / `RT` / `#btn-touch-fire`) releases throw impulse $\vec{v}_\text{cargo}$.

### Phase 3: Buggy Hopper Catch Geometry & 3D Stacking (`OpenBuggy.ts`)
- Implement `BuggyCargoHopper` in `OpenBuggy.ts`:
  - Maintains capacity for up to 6 physical canisters.
  - Evaluates magnetic attractor $\vec{F}_\text{mag}$ and discrete bounding box containment.
  - Dynamically creates procedural child meshes in the flatbed arranged in a 2x3 grid.
  - Adjusts buggy total mass: $M_\text{total} = M_\text{chassis} + \sum M_\text{cargo}$, affecting suspension compression and inertia.

### Phase 4: Dynamic Moving Re-Boarding & Escape Countdown (`TrainHeistDirector.ts`, `ClientApp.ts`)
- Implement moving re-boarding leap from catwalk to buggy driver seat.
- Retain the 44.0s Citadel lethal shield proximity countdown.
- Trigger corporate pursuit drone alert when 3+ canisters are siphoned.
- Update Quest Engine objective: `SECURE_HAUL_TO_TRADING_POST`.

### Phase 5: Trading Post Delivery & Economy Fencing (`QuestEngine.ts`, `MarketEngine.ts`)
- Create delivery interaction volume at Frontier Trading Post $(X = 220, Y = -180)$.
- Arriving with stolen water/air/He-3 unlocks trading terminal:
  - Automated cargo transfer from buggy flatbed to trading post liquidity pool.
  - Player credited with earned currency ($5,000\text{--}20,000$ credits).
  - Terminal displays prompt: `FUNDS CREDITED // VISIT GARAGE TERMINAL FOR VEHICLE UPGRADES`.

### Phase 6: Headless Smoke Verification Suite (`smoke-spec36-heist-overhaul.ts`)
- Author comprehensive headless test script covering:
  1. Velocity matching and boarding window verification.
  2. Cargo throw parabolic trajectory in lunar vacuum with train base velocity.
  3. Buggy hopper magnetic attraction and hard latch within $\pm 0.05\,\text{m}$ tolerance.
  4. Moving re-boarding seat capture when avatar lands within $R_\text{board} \le 2.2\,\text{m}$.
  5. Mass accumulation and cargo unloading at trading post.
  6. 100% pass under Babylon.js `NullEngine`.

---

## 4. Acceptance Criteria & Quality Gates

1. **Parabolic Cargo Trajectory Gate:** A thrown canister preserves train forward velocity ($25\,\text{m/s}$) plus throw impulse, traveling cleanly into the parallel buggy hopper without clipping through rails.
2. **Magnetic Hopper Latch Gate:** Canisters landing within $1.8\,\text{m}$ of the hopper center lock into the flatbed with $100\%$ capture reliability.
3. **Moving Re-Boarding Gate:** Leaping toward the buggy within $R_\text{board} \le 2.2\,\text{m}$ seamlessly transitions player to driver control without physics desync or camera snapping.
4. **Economic Payout Gate:** Unloading 4+ canisters at the Frontier Trading Post awards $\ge 5,000$ credits and advances the quest state.
5. **Headless Test Gate:** `npx tsx scripts/smoke-spec36-heist-overhaul.ts` passes all $\ge 60$ assertions cleanly.
6. **Production Build Gate:** `npm run build` succeeds with zero TypeScript errors.
