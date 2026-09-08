# Architecture Blueprint: Bulldozed Road Network, Camera Perspective & Visual Depth Overhaul

**Document ID:** `docs/architecture/10-road-network-and-dynamics-overhaul.md`  
**Status:** Approved  
**Author:** 🦉 Owl (System Architect & Outer Loop Orchestrator)  
**Date:** 2026-09-07  

---

## 1. Executive Summary & Design Vision

This specification overhauls the visual depth, perspective, vehicle dynamics, and environment for **Moonbuggy 2**:
1. **Camera Perspective Correction:** Move chase camera back and up by another buggy-length ($+3.3\text{m}$ back to $10.8\text{m}$, $+2.5\text{m}$ up to $5.7\text{m}$) and tune FOV to $55^\circ$ to eliminate wide-angle flattening and provide natural 3D depth perception.
2. **Volumetric Shadow & Contact Shading ("Unflattening" the Rig):**
   - Enable `castShadow = true` and `receiveShadow = true` across all glTF meshes in `ApolloRoverModel`.
   - Reorient solar key light to an oblique side-lit angle ($[-75, 55, -45]$) with real-time shadow camera tracking the rover position, casting dramatic long lunar shadows.
   - Configure ACESFilmic tone mapping (`exposure = 1.15`) and PCF soft shadow maps to avoid highlight clipping.
   - Add a chassis ground-contact ambient occlusion disc grounding the buggy onto the regolith.
3. **High-Authority Powertrain & Braking Dynamics:**
   - Boost nominal traction to $920.0\,\text{N}$ with flat low-end torque ($0 \to 20\,\text{km/h}$ in $3.47\,\text{s}$, down from $7.12\,\text{s}$).
   - Quadruple braking authority to $2400\,\text{N}$ (service brake) and $4200\,\text{N}$ (handbrake) for crisp, responsive stopping.
4. **Bulldozed Dirt Road Circuit with Banked Curves:**
   - A $590\,\text{m}$ graded dirt road circuit carved into the cratered terrain using a closed Catmull-Rom spline.
   - **Graded Roadbed:** The road centerline elevation filters out rough micro-craters while preserving broad lunar topography.
   - **Banked Curves (Superelevation):** Inward banking up to $14^\circ$ ($0.24\,\text{rad}$) proportional to local curve curvature ($\kappa$), allowing high-speed cornering without rollover.
   - **Cross-section & Berms:** Flat-crowned roadbed with pushed-regolith berm shoulders ($+0.12\,\text{m}$).
   - **Visual Ribbon:** A high-resolution 3D road ribbon mesh ($1,806$ vertices) textured with compacted regolith and grader blade markings.
   - **Microsecond Spatial Index:** A 2D spatial hash ensures 120Hz physics sub-stepping height queries resolve in $< 1\,\mu\text{s}$.

---

## 2. Technical Contracts & Parameters

### 2.1 Camera Rig Specifications
| Parameter | Previous Value | New Rectified Value | Rationale |
| :--- | :--- | :--- | :--- |
| **Chase Distance ($Z$)** | $7.5\,\text{m}$ | $10.8\,\text{m}$ ($+3.3\,\text{m}$ buggy-length) | Eliminates model crowding and wide-angle distortion |
| **Chase Elevation ($Y$)** | $3.2\,\text{m}$ | $5.7\,\text{m}$ ($+2.5\,\text{m}$ buggy-length) | High three-quarter perspective reveals 3D vehicle contours |
| **Look Target Offset** | $[0, 1.2, -4.5]$ | $[0, 1.0, -5.5]$ | Looks down at rover and focuses ahead on the road |
| **Camera Field of View** | $70^\circ$ | $55^\circ$ | Telephoto perspective compression restores volumetric depth |

### 2.2 Lighting & Shading Pipeline
- **Directional Key Sun:** Positioned at $[-75, 55, -45]$ relative to rover; cast shadow frustum $70\text{m} \times 70\text{m}$ at $2048 \times 2048$ resolution.
- **Tone Mapping:** `THREE.ACESFilmicToneMapping` with exposure $1.15$.
- **Shadow Map Type:** `THREE.PCFSoftShadowMap` with bias $-0.0004$, normalBias $0.025$.
- **Chassis Contact AO:** Soft radial shadow decal parented to rover base at $y = 0.02$.

### 2.3 Road Geometry & Physics Integration
- **Centerline Waypoints:** 12-point closed loop spanning $X \in [-86, 106]$, $Z \in [-68, 96]$.
- **Road Width:** $8.0\,\text{m}$ ($4.0\,\text{m}$ half-width) with $4.5\,\text{m}$ smoothstep transition margin to natural terrain.
- **Superelevation Formula:**
  $$\phi(s) = \text{clamp}(\kappa(s) \cdot 18.0, -0.24, 0.24)\,\text{rad}$$
  $$\Delta h(u) = -u \cdot \sin(\phi(s)) + \left(1 - \left(\frac{u}{R}\right)^2\right) \cdot 0.08\,\text{m}$$
- **Physics Normal:** `getNormalAt(x, z)` computes analytical normal vector reflecting both slope and banking.

---

## 3. 💡 Note to Future Self: Hosting Portability
The road network is purely analytical and computed deterministically at scene initialization from mathematical Catmull-Rom splines. No large pre-baked road meshes or external heightmap textures are required in the repository, maintaining zero asset bloat and instant load times.
