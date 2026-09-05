# Spec 03: Moonbuggy 2 (High-Fidelity Lunar Rover Simulation)

> Target Hardware: GPD Win Max 2 (`chubbs` — AMD Ryzen 7 7840U/8840U, Radeon 780M gfx1103, 32GB RAM, Bazzite Linux / Steam Deck Gamepad)  
> Co-existence Policy: Preserve `src/minigames/moon-buggy` as the retro arcade prototype; `Moonbuggy2` is an isolated high-fidelity standalone module and desktop runtime.

---

## 1. Executive Summary & Vision
`Moonbuggy2` transforms the prototype lunar excursion into an ultra-realistic, physically grounded Apollo Lunar Roving Vehicle (LRV) simulation. Operating on the GPD Win Max 2's Radeon 780M RDNA3 architecture, the system balances photorealistic lunar regolith rendering (PBR, micro-cratering, harsh vacuum sunlight, Earth shine) with analytical multi-body chassis dynamics running under authentic lunar gravity ($g \approx 1.62\,\text{m/s}^2$).

---

## 2. Platform & Target Hardware Constraints
- **Primary Node:** `chubbs` (GPD Win Max 2)
  - **SoC:** AMD Ryzen 7 7840U/8840U (8 Cores, 16 Threads @ 28W TDP).
  - **iGPU:** AMD Radeon 780M (12 Compute Units RDNA3, Vulkan 1.3 / OpenGL 4.6 / WebGPU native).
  - **RAM:** 32 GB LPDDR5X-7500 (Unified VRAM up to 16GB allocatable).
  - **Display:** 10.1" 1600p / 1200p landscape IPS display with native hardware gamepad controls (XInput / Dual-stick standard).
- **Secondary Deployment:** Standalone desktop runtime (Electron/Tauri/Node-Native or Vulkan/Vite WebGPU) executable both directly on Linux desktop and cross-streamable over Tailscale.

---

## 3. Physics Engine Architecture (High-Fidelity Dynamics)
The physics model departs from simple kinematic raycasts to an analytical multi-body spring-damper tire model:
1. **Lunar Gravity:** Fixed continuous integration at $g = 1.622\,\text{m/s}^2$.
2. **Double-Wishbone Suspension System:**
   - 4 independent suspension struts with non-linear spring rates:
     $$F_{\text{spring}} = -k \Delta x - c \dot{x} | \dot{x} |^{0.2}$$
   - Authentic LRV damper rebound curve preventing high-frequency jitter while allowing authentic low-G lunar bouncing upon crater rim departures.
3. **Pacejka 'Magic Formula' Tire-Regolith Friction:**
   - Apollo wire-mesh zinc-coated tires modeled with longitudinal slip ratio ($\kappa$) and lateral slip angle ($\alpha$).
   - Regolith shear-deformation factor: Loose surface slippage on steep crater inclines ($>15^\circ$), requiring momentum management and four-wheel differential torque vectoring.
4. **Four-Wheel Independent Steering & Drive:**
   - Authentic Apollo LRV Ackermann dual-axle steering (front and rear counter-steer at low speeds for zero-radius turning, locked rear at high speeds).
   - Independent 0.25 HP traction electric motors per wheel with regenerative braking and realistic torque curves.
5. **Center of Mass & Inertia Tensor:**
   - Vehicle mass: $210\,\text{kg}$ empty, $490\,\text{kg}$ with astronaut crew + science payload.
   - Low center of gravity ($h_{\text{cg}} = 0.42\,\text{m}$) reducing rollover tendency on lunar slopes.

---

## 4. Photorealistic Lunar Rendering Pipeline
1. **Harsh Vacuum Lighting Model:**
   - Direct Sun: Unfiltered high-intensity collimated directional light (Color temperature ~5800K, Lux ~135,000 equivalent).
   - Shadow Penumbra: Pin-sharp shadow edges (zero atmospheric rayleigh/mie scattering).
   - Lunar Regolith Hapke Photometric Function: Retro-reflective backscattering effect (the "opposition surge" / Heiligenschein around the camera's shadow).
   - Secondary Bounce & Earthshine: Earth as a bright blue marble ($~4\times$ the angular diameter of the moon seen from Earth) casting soft, low-lux cerulean ambient bounce into sunlit crater shadows.
2. **PBR Regolith Shading & Micro-Displacement:**
   - Multi-layer Triplanar mapping for crater walls to prevent UV texture stretching.
   - Normal/Roughness/AO maps derived from high-resolution Lunar Reconnaissance Orbiter (LRO) elevation datasets and photogrammetric scans.
3. **Apollo LRV PBR Model:**
   - High-fidelity GLTF/GLB asset modeled in Blender:
     - Foldable aluminum chassis with tubular roll bar framework.
     - 50-mesh woven zinc-coated steel wire tires with chevron titanium tread cleats.
     - Gold aluminized mylar / Kapton thermal blankets with realistic micro-wrinkle normal maps and metallic Fresnel reflectivity.
     - Parabolic High-Gain Antenna (dish), color TV camera, 70mm Hasselblad camera bracket, sample containment bags.
4. **Post-Processing & Atmosphere Emulation:**
   - Subtle camera lens chromatic aberration, Bloom on solar glints, ACES tone mapping, optional Apollo 16mm film grain pass.

---

## 5. Blender Pipeline & Asset Workflow
1. **Asset Pipeline:**
   - `models/blender/lrv_apollo.blend`: Parametric master model with non-destructive modifier stack (Subdivision, Bevel, Mirror).
   - Material assignments: PBR Principled BSDF materials mapped to standard metallic-roughness channels.
   - Export pipeline: Automated headless export script (`scripts/export_lrv.py`) baking textures and compiling compressed GLB via Draco/Meshopt.
2. **Terrain Procedural Pipeline:**
   - Displacement heightmap generator combining Perlin/Simplex noise with analytic impact craters (rim uplift, ejecta blankets, central peaks for craters $>50\,\text{m}$).

---

## 6. Controls & GPD Win Max 2 Hardware Integration
1. **Built-in Gamepad Integration (HTML5 Gamepad API / SDL2):**
   - **Left Stick (X-axis):** Dual-axle proportional steering.
   - **Right Trigger (RT):** Analog throttle (0–100% torque).
   - **Left Trigger (LT):** Proportional braking.
   - **Right Stick:** 360° orbital chase / cockpit camera look.
   - **Button A:** Handbrake / Park.
   - **Button Y:** Toggle Cockpit / Chase / Cinematic Camera.
   - **Button X:** Reverse gear toggle.
   - **D-Pad:** Telemetry mode toggle / Map navigation.
2. **Keyboard / Touch Fallback:**
   - Physical QWERTY keyboard support on Win Max 2.
   - Full touch telemetry HUD with gesture look/drive fallback.

---

## 7. Deliverables & Acceptance Criteria
- [ ] Isolated codebase under `src/minigames/moonbuggy2/` (preserving `moon-buggy` intact).
- [ ] Physics simulation running at a deterministic 60Hz tick rate with double-wishbone suspension and Pacejka tire slip.
- [ ] Photorealistic PBR shaders for lunar regolith (Hapke approximation, triplanar textures, sharp vacuum shadows, Earthshine).
- [ ] Highly detailed Apollo LRV 3D asset with gold foil, wire-mesh wheels, and telemetry instruments.
- [ ] Native gamepad input mapping for GPD Win Max 2 built-in controller.
- [ ] Automated verification test suite validating spring resonance, friction slip, and gravity invariants.
