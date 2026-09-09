# Architecture Blueprint: NPC Competitors, Dedicated Science Stations, Rover Collisions & Wave Runs

**Document ID:** `docs/architecture/11-npc-competitors-and-collision-physics.md`  
**Status:** Approved  
**Author:** 🦉 Owl (System Architect & Swarm Orchestrator)  
**Date:** 2026-09-08  

---

## 1. Executive Summary & Design Vision

This specification introduces dynamic autonomous competition and physical hazard mechanics into **Moonbuggy 2**:
1. **NPC Autonomous Competitors:**
   - Autonomous rover agents (e.g. Rival Artemis LTV / Commercial Mining Drones: *Apollo-Rival*, *Valkyrie-01*).
   - Each NPC operates an autonomous state machine (Patrol $\to$ Seek Nearest Moonrock $\to$ Sample & Harvest $\to$ Return to Home Base $\to$ Deposit Cargo & Recharge).
   - Obstacle avoidance using raycasting and terrain gradient awareness.
2. **Dedicated NPC Science Centers:**
   - Each competitor has a distinct designated Science Drop Station base placed at coordinates away from the player origin base (e.g., *Outpost Alpha* at $(-80, 45)$, *Outpost Beta* at $(85, -60)$).
   - Visually distinct colored beacon strobes and telemetry markers.
3. **Vehicle-to-Vehicle Collision Physics & Damage Model:**
   - Elastic/inelastic impulse collision physics between player rover and NPC rovers based on mass and relative velocities.
   - Hull structural integrity and subsystem damage: front bumper crumple, wheel misalignment, steering torque pull, battery short-circuit risk upon high-speed impacts.
4. **Timed Wave System & Economy Hook:**
   - Timed runs structured into progressive waves (e.g., Wave 1: 1 competitor, standard rock density; Wave 2: 2 aggressive competitors, scarcer high-value basalt; Wave 3: high-speed retrieval blitz).
   - Post-run resource tally (rocks collected, base expansion credits, future fuel reserve tracking).

---

## 2. Technical Architecture & Component Interfaces

### 2.1 NPC Competitor Controller (`NPCCompetitorController.ts`)
```typescript
export interface NPCConfig {
  id: string;
  name: string;
  basePosition: THREE.Vector3;
  baseColor: number;
  maxSpeed: number; // m/s
  steerAuthority: number;
  harvestTime: number; // seconds to drill/grab
}

export type NPCState = 'SEEKING_ROCK' | 'HARVESTING' | 'RETURNING_BASE' | 'DEPOSITING' | 'STALLED';
```
- Navigation logic: Evaluates available rocks from `LunarRockField`, selects closest uncollected rock, steers toward it using heading error proportional control.
- Avoidance: Casts whiskers ahead ($35^\circ$ left/right) to detect terrain craters, boulders, and rovers, applying evasive steering bias.

### 2.2 Collision & Damage System (`RoverCollisionSystem.ts`)
- Bounding volumes: Oriented Bounding Boxes (OBB) or dual-sphere capsules matching vehicle dimensions ($L = 3.3\text{m}, W = 2.0\text{m}, H = 1.6\text{m}$).
- Impact impulse:
  $$J = \frac{-(1 + e)(\mathbf{v}_{\text{rel}} \cdot \mathbf{n})}{\frac{1}{m_1} + \frac{1}{m_2}}$$
  Where restitution $e \approx 0.25$ (inelastic composite lunar chassis).
- Damage calculation:
  $$\Delta \text{Damage} = \max\left(0, \frac{\|\mathbf{v}_{\text{rel}}\| - v_{\text{threshold}}}{v_{\text{max\_impact}}}\right) \times 100$$
  Damage impacts handling (increased steering drift, reduced top speed, degraded battery efficiency).

### 2.3 Wave Manager (`LunarWaveManager.ts`)
```typescript
export interface WaveConfig {
  waveNumber: number;
  timeLimitSec: number;
  npcCount: number;
  rockSpawnCount: number;
  targetQuota: number;
}
```
- Manages round timer, spawns new rock deposits when a wave begins, tracks player vs NPC scores, displays round summary, and banks moonrocks for future base expansion.

---

## 3. 💡 Note to Future Self: Hosting Portability
All NPC steering calculations and physics collisions use lightweight analytical math with zero external heavy physics engine dependencies, maintaining compatibility with headless CI runners and low-end target hardware.
