# Architecture Blueprint 36: High-Speed Train Heist Overhaul — Moving Cargo Toss & Dynamic Buggy Boarding

## System Topology & Event Flow

```mermaid
sequenceDiagram
    autonumber
    actor Player
    participant Buggy as OpenBuggy / Autopilot
    participant Train as HighSpeedMaglev
    participant Heist as TrainHeistDirector
    participant Cargo as BallisticCargo
    participant Post as TradingPost / Economy

    Player->>Buggy: Drive parallel at 25 m/s (Δv ≤ 3.5 m/s)
    Heist-->>Player: CanBoard = true
    Player->>Train: Leap to Catwalk (P_world -> M_vault * P_local)
    Buggy->>Buggy: Engage Tethered Autopilot (4.5m starboard offset)
    Player->>Train: Unclamp Water / Air Canisters
    Player->>Cargo: Aim & Throw (v_cargo = v_train + v_throw)
    Cargo->>Buggy: Enter Magnetic Envelope (1.8m)
    Buggy->>Cargo: Attract & Latch (stack in flatbed, +mass)
    Heist-->>Player: Warning: 44s Citadel Shield Impact!
    Player->>Buggy: Leap back to moving driver seat (R ≤ 2.2m)
    Buggy->>Player: Resume manual steering, disengage tether
    Player->>Post: Haul haul to Trading Post & unload for credits
```

## Physical Capture & Ballistic Envelopes
- **Cargo Ballistics:** $\vec{r}(t) = \vec{r}_0 + (\vec{v}_\text{train} + \vec{v}_\text{throw})t + \frac{1}{2}\vec{g}t^2$ in vacuum ($C_d = 0$, $g = 1.62\,\text{m/s}^2$).
- **Electromagnetic Hopper Attractor:** $\vec{F}_\text{mag} = -k_\text{mag}\hat{r} - c_\text{damp}\Delta\vec{v}$ within $R_\text{catch} = 1.8\,\text{m}$.
- **Moving Driver Seat Capture:** Kinematic handoff from airborne avatar to buggy chassis coordinate frame within $R_\text{board} \le 2.2\,\text{m}$.

## File Manifest & Responsibility Map
- `games/lunar-frontier/src/quests/TrainHeistDirector.ts`: Heist state machine, cargo unclamp triggers, throw aim logic, re-boarding arbiter.
- `games/lunar-frontier/src/entities/OpenBuggy.ts`: Cargo hopper bounds, physical canister mesh instantiation, dynamic mass loading.
- `games/lunar-frontier/src/client/ClientApp.ts`: User input routing, throw projection HUD, seat transition dispatch.
- `games/lunar-frontier/scripts/smoke-spec36-heist-overhaul.ts`: Complete headless NullEngine verification suite.
