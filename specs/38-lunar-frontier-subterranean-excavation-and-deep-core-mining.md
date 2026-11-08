# Spec 38: Lunar Frontier — Subterranean Base Excavation & Deep Core Shaft Mining

> **Target Systems:** `games/lunar-frontier/src/base/SubterraneanExcavator.ts` (new), `games/lunar-frontier/src/base/CoreMiningRig.ts` (new), `games/lunar-frontier/src/infrastructure/TunnelNetwork.ts`, `games/lunar-frontier/src/engine/WorldScene.ts`, `games/lunar-frontier/src/client/ClientApp.ts`, `games/lunar-frontier/src/ui/LunarHUD.ts`, `games/lunar-frontier/src/audio/LunarAudioSystem.ts`.  
> **Platforms:** WebGL2/WebGPU Desktop (Chrome/Firefox/Brave), Mobile Touch (PWA landscape), Gamepad (Linux XInput/Steam Deck).  
> **Preceding Specs:** Spec 14 (Tunnel Infrastructure Baseline), Spec 19 (Mining UX), Spec 32 (Crater Ballistics), Spec 37 (Buggy Workshop).  
> **Verification Suite:** `games/lunar-frontier/scripts/smoke-spec38-core-excavation.ts` (100% headless under `NullEngine`).

---

## 1. Executive Summary & Narrative Context

Surface colonization on the Moon is brutally hostile: unshielded solar cosmic radiation, solar flare storms, continuous micrometeorite bombardment, and savage thermal swings between $+120^\circ\text{C}$ (lunar noon) and $-130^\circ\text{C}$ (lunar night).

### The Subterranean Expansion Imperative
To build a thriving, permanent home base, humanity must burrow into the core. Beneath the loose surface regolith lie billions of years of compressed basalt bedrock, primordial lava tubes, and rich mineral fissures. 

Excavating vertically into the lunar core delivers:
1. **Radiation & Thermal Shielding:** At depth $Z \le -15\,\text{m}$, regolith overburden provides complete radiation immunity and a stable ambient temperature of $-20^\circ\text{C}$, dropping habitat life-support heating energy by $80\%$.
2. **Volumetric Expansion for Heavy Base Modules:** Deep underground chambers provide expansive floor space for closed-loop bioreactors, smelting autoclaves, high-capacity battery capacitor vaults, and vehicle garages without cluttering the surface.
3. **Deep Core Fissure Mining:** Excavating deeper uncovers high-grade mineral seams—volcanic ice lenses, ilmenite titanium, and pristine Helium-3 pockets trapped in unweathered basalt bedrock.
4. **Compressed Slag Construction Material:** Mined basalt rubble is pulverized and sintered into **Compressed Slag Bricks**, the fundamental structural commodity used to build surface domes, walls, and foundations.

---

## 2. Structural Architecture & Depth Hierarchy

```
                    [ Surface Base Datum: Z = 0 m ]
                 Surface Airlock, Solar Masts & Pad
                                  │
                                  ▼ (Central Industrial Lift)
    ═══════════════════════════════════════════════════════════
    [ Tier 1: Living & Life Support Mezzanine (Z = -15 m) ]
    • Radiation-shielded habitat pod & crew quarters
    • Oxygen scrubber & personal storage vault
    ═══════════════════════════════════════════════════════════
                                  │
                                  ▼ (Vertical Core Shaft)
    ═══════════════════════════════════════════════════════════
    [ Tier 2: Heavy Industrial & Power Vault (Z = -45 m) ]
    • Basalt slag autoclave & alloy smelter
    • Molten-salt thermal battery banks & power bus
    ═══════════════════════════════════════════════════════════
                                  │
                                  ▼ (Deep Rotary Drill Gantry)
    ═══════════════════════════════════════════════════════════
    [ Tier 3: Deep Core Lava Tube & Primordial Seam (Z = -95 m) ]
    • Volcanic lava tube cavern & geothermal heat well
    • Rare-earth fissures: Platinum, Thorium, Deep Ice lenses
    ═══════════════════════════════════════════════════════════
```

### 2.1 Depth Tiers & Environmental Attributes
- **Surface Level ($Z = 0.0\,\text{m}$):** High radiation ($1.2\,\text{mSv/h}$), vacuum ($0.0\,\text{kPa}$), extreme lighting contrast, exposed to dust abrasion.
- **Tier 1 — Shielded Habitation ($Z = -15.0\,\text{m}$):**
  - Chamber volume: $24\,\text{m} \times 24\,\text{m} \times 6.0\,\text{m}$.
  - Zero radiation ($0.0\,\text{mSv/h}$), ambient temp stable $-20^\circ\text{C}$.
  - Unlocked by: Mined excavation requirement $2,500\,\text{kg}$ basalt + $5,000$ credits.
- **Tier 2 — Industrial Smelting & Battery Vault ($Z = -45.0\,\text{m}$):**
  - Chamber volume: $36\,\text{m} \times 36\,\text{m} \times 9.0\,\text{m}$.
  - High ceiling accommodating heavy basalt centrifuges and smelting vats.
  - Unlocked by: Mined excavation requirement $8,000\,\text{kg}$ basalt + $15,000$ credits.
- **Tier 3 — Deep Core Lava Tube Cavern ($Z = -95.0\,\text{m}$):**
  - Natural arched subterranean cavern: $60\,\text{m} \times 80\,\text{m} \times 14.0\,\text{m}$.
  - Houses the geothermal core tap and active deep mineral extraction nodes.
  - Unlocked by: Mined excavation requirement $25,000\,\text{kg}$ basalt + $35,000$ credits.

### 2.2 Central Vertical Elevator & Gantry (`CoreMiningRig.ts`)
- Spans $Z = 0.0\,\text{m}$ down to $Z = -95.0\,\text{m}$.
- Open industrial elevator cage with yellow safety interlocks and hydraulic counterbalance cables.
- Traversal velocity: $v_\text{lift} = 6.0\,\text{m/s}$ with smooth S-curve acceleration and floor snapping.
- Transports both suited avatars and loaded buggies between surface and subterranean tiers!

---

## 3. Subsystem Specifications & Phased Implementation

### Phase 1: Subterranean Excavation State Machine & Data Model (`SubterraneanExcavator.ts`)
- Define `SubterraneanTierState` tracking unlocked depth tiers, excavation progress (0…100%), and mined rubble tonnage.
- Persistence: Store excavation states in local storage and SQLite shard tables (`subterranean_base`).
- Provide excavation cost validation and level-up transition triggers.

### Phase 2: Procedural 3D Subterranean Mesh Generation (`TunnelNetwork.ts`, `WorldScene.ts`)
- Dynamically instantiate subterranean room meshes as depth tiers unlock:
  - Hexagonal concrete-composite retention rings lining the central vertical shaft.
  - Reinforced vaulted ceiling ribs with embedded warm industrial strip lighting ($3,200\,\text{K}$).
  - Rough-hewn basalt rock wall textures with procedurally generated mineral glitter specular highlights.
- Implement floor collision boundaries and seamless occlusion culling so subterranean rooms do not render while the player is on the surface.

### Phase 3: Rotary Core Drill Machine & Excavation Minigame (`CoreMiningRig.ts`)
- Construct the 3D Rotary Drill Rig positioned at the base of the lowest unlocked tier:
  - Counter-rotating carbide drill heads with grinding particles.
  - Interactive drilling loop: Player mounts the drill rig (or docks their upgraded Tier 4 Deep Resonator buggy) to initiate high-torque drilling pulses.
  - Audio: Low-frequency seismic rumble ($35\text{--}65\,\text{Hz}$), metallic stone shearing, and pneumatic spoils discharge.
  - Yields: Generates Basalt Rubble and exposes deep mineral veins directly in the rock walls.

### Phase 4: Mineral Processing & Compressed Slag Production (`SubterraneanExcavator.ts`)
- Autoclave / Sintering Unit on Tier 2:
  - Converts $100\,\text{kg}$ raw Basalt Rubble into $1\times$ `SLAG_CONSTRUCTION_BRICK` ($25\,\text{kg}$) + trace metals ($5\,\text{kg}$ iron/titanium).
  - Slag bricks serve as the primary currency/material for Spec 39 base construction modules.

### Phase 5: Vertical Elevator Kinematics & Buggy Transport (`CoreMiningRig.ts`, `ClientApp.ts`)
- Implement platform physics for the vertical elevator:
  - Supports moving character and vehicle transforms without jitter or falling through floors.
  - Elevator call stations on every floor with call-button interaction prompts and illuminated floor indicators.

### Phase 6: Headless Smoke Verification Suite (`smoke-spec38-core-excavation.ts`)
- Author comprehensive headless test script covering:
  1. Default base state (Surface only, Tier 1–3 locked).
  2. Basalt accumulation and tier unlock transitions (Tier 1 $\to$ Tier 2 $\to$ Tier 3).
  3. Slag autoclave conversion ratios and inventory output.
  4. Elevator elevation kinematics ($Z = 0 \to -15 \to -45 \to -95$) and floor snapping.
  5. Subterranean room mesh generation and bounds verification.
  6. 100% pass under Babylon.js `NullEngine`.

---

## 4. Acceptance Criteria & Quality Gates

1. **Excavation Unlock Gate:** Accumulating required basalt and credits successfully transitions `currentTier` from $0 \to 1 \to 2 \to 3$, instantiating corresponding subterranean chamber geometries.
2. **Elevator Platform Kinematics Gate:** Moving elevator maintains continuous vertical coordinate updates without NaN values, correctly positioning passengers at target floor datums ($Z = 0, -15, -45, -95\,\text{m}$).
3. **Slag Conversion Gate:** Sintering $1,000\,\text{kg}$ basalt rubble produces exactly $10\times$ `SLAG_CONSTRUCTION_BRICK` and $50\,\text{kg}$ trace metals.
4. **Smoke Suite Gate:** `npx tsx scripts/smoke-spec38-core-excavation.ts` passes all $\ge 60$ assertions cleanly.
5. **Production Build Gate:** `npm run build` succeeds with zero TypeScript errors.
