# Spec 34: Lunar Frontier Virtual Dual-Sticks, Dedicated View Touch Toggle, Default Behind-Camera & PWA Installability Harness

## 1. Executive Summary & Problem Statement

Following the initial delivery of Spec 33 mobile client capabilities, field playtesting on a Google Pixel 9 highlighted three specific friction points and ergonomic opportunities:

1. **Camera Look Ergonomics (Trackpad vs Virtual Stick):**
   - While the dynamic floating left virtual stick feels natural and responsive for low-g bounding and strafing, the right-side free-look trackpad (differential swipe deltas with flick coasting) feels loose and requires repetitive swipe-lifting across the screen to turn.
   - Mobile 3D action games (e.g., twin-stick shooters, mobile battle royales) standardize on **symmetrical virtual dual sticks**: holding the right stick deflected continuously rotates the camera at a predictable angular velocity, while releasing instantly halts rotation via damped spring centering.
   - The right side needs a floating dynamic look stick with identical visual styling, spring return, deadzone, and radial clamping to the left stick.

2. **Camera Perspective Selection & Default View:**
   - The game currently boots into `eva_first_person` (interior visor cockpit).
   - In third person, the player can see their articulated Stormtrooper armor, asymmetric Mistborn Steelpush bounding strides, Olympic triple-jump airborne tucks, and PLSS cold-gas RCS thruster bursts.
   - The default camera perspective should boot into **above and behind** (`eva_third_person`, the closer of the two chase modes at 3.2m radius).
   - Furthermore, mobile players need a dedicated **`[🎥 VIEW]`** touch button in the utility cluster to cycle between first-person, third-person, and vehicle chase cameras with a single thumb tap, eliminating reliance on keyboard `[V]` or gamepad `R3`.

3. **PWA Standalone Installation Rejection:**
   - When attempting to "Install app" on Chromium on Android (Pixel 9), Chrome reports that the app cannot be installed.
   - Chromium's strict PWA install criteria on Android require:
     1. A valid registered **Service Worker** (`navigator.serviceWorker.register`) with a functional fetch/lifecycle handler.
     2. A **Secure Origin** (HTTPS or localhost). Accessing via plain LAN HTTP (`http://192.168.86.118:5174/` or `http://100.99.188.15:5174/`) is flagged as an insecure origin, blocking Service Worker registration and suppressing the `BeforeInstallPromptEvent`.
   - The client requires a lightweight Service Worker (`sw.js`) and a secure Tailscale HTTPS endpoint (`https://beehive.tail1ab408.ts.net/`) via Tailscale Serve.

---

## 2. Architectural Contracts & System Specifications

### 2.1 Floating Dynamic Right Virtual Stick (Twin-Stick Architecture)

Update `TouchInputController.ts` to replace the free-look differential trackpad with a floating dynamic right virtual stick:

1. **Active Zone:**
   - Right half of the screen ($X \in [0.45 \cdot W, W], Y \in [0.20 \cdot H, H]$), excluding touch bounding boxes of action and utility buttons.
2. **Dynamic Origin & Symmetrical Geometry:**
   - Dynamic anchor: $(\bar{x}_\text{look}, \bar{y}_\text{look})$ anchors dynamically to initial `touchstart` coordinate within the zone.
   - Deadzone: $R_\text{dead} = 8\,\text{px}$.
   - Max deflection clamp: $R_\text{max} = 54\,\text{px}$.
   - Visual ring and nub: `.lf-touch-look-base` and `.lf-touch-look-nub` (mirrored from the left stick, with cyan/amber accent glow).
3. **Continuous Angular Velocity Law:**
   - For deflection $\vec{d} = (x - \bar{x}, y - \bar{y})$ and $r = \|\vec{d}\|$:
     If $r \le R_\text{dead}$: $\omega_\text{yaw} = 0, \omega_\text{pitch} = 0$.
     If $r > R_\text{dead}$:
     $$r_\text{norm} = \text{clamp}\left(\frac{\min(r, R_\text{max}) - R_\text{dead}}{R_\text{max} - R_\text{dead}}, 0, 1\right)$$
     $$\hat{u} = \frac{\vec{d}}{r}$$
     $$\omega_\text{yaw} = \hat{u}_x \cdot r_\text{norm} \cdot \Omega_\text{max,yaw} \quad (\Omega_\text{max,yaw} = 2.4\,\text{rad/s})$$
     $$\omega_\text{pitch} = -\hat{u}_y \cdot r_\text{norm} \cdot \Omega_\text{max,pitch} \quad (\Omega_\text{max,pitch} = 1.8\,\text{rad/s})$$
   - Each frame with delta time $\Delta t$:
     $$\Delta \theta_\text{yaw} = \omega_\text{yaw} \cdot \Delta t, \quad \Delta \theta_\text{pitch} = \omega_\text{pitch} \cdot \Delta t$$
4. **Immediate Zeroing & Spring Return on Release:**
   - On `touchend`, angular velocities immediately drop to zero (no residual coast or drift).
   - Visual nub returns to center via damped spring ($k = 260, c = 20$).

---

### 2.2 Dedicated `[🎥 VIEW]` Touch Button & Default Perspective

1. **Dedicated View Button (`#btn-touch-cam`):**
   - Mounted in `#lf-touch-actions` utility cluster alongside `#btn-touch-map` and `#btn-touch-ui`.
   - Minimum $44\text{px} \times 44\text{px}$ hit target (styled to $52\text{px} \times 52\text{px}$ with safe padding).
   - Icon: `🎥`, Label: `VIEW`.
   - Tap action: calls `app.cycleCamera()`.
   - Triggers a crisp $15\,\text{ms}$ tactile haptic pulse on tap.
2. **Default Camera Perspective:**
   - Update `initialMode` default in `WorldScene.ts`:
     `initialMode: this.options.cameraMode ?? 'eva_third_person'`
   - Update `CameraRig.ts`:
     `this.mode = options.initialMode ?? 'eva_third_person'`
   - Update `ClientApp.ts`:
     `private lastEvaCamera: CameraMode = 'eva_third_person'`

---

### 2.3 Service Worker & PWA Installability Harness

1. **Service Worker (`public/sw.js`):**
   - Install event: pre-caches shell assets (`./index.html`, `./manifest.webmanifest`, icons).
   - Activate event: claims clients immediately via `clients.claim()`.
   - Fetch event: network-first with cache fallback for navigation and static bundles.
2. **Registration in `src/client/main.ts`:**
   - Register `sw.js` upon DOM load if `'serviceWorker' in navigator`.
   - Log clean diagnostics (`[pwa] Service Worker registered`).
3. **Tailscale Secure HTTPS Origin:**
   - Enable Tailscale Serve background proxy:
     `tailscale serve --bg 5174`
   - Maps `https://beehive.tail1ab408.ts.net/` $\to$ `http://127.0.0.1:5174/` with automatic valid Let's Encrypt TLS certificate.
   - Satisfies Chromium Android's strict secure-origin requirement for PWA installation.

---

## 3. Phased Implementation Roadmap

```
Phase 1: Default Behind-Camera & Dedicated [🎥 VIEW] Touch Button
Phase 2: Floating Dynamic Virtual Right Stick (Twin-Stick Architecture)
Phase 3: Service Worker Registration & Tailscale HTTPS PWA Harness
Phase 4: Headless Smoke Verification Suite & Build Gate
```

---

### Phase 1: Default Behind-Camera & Dedicated [🎥 VIEW] Touch Button
- **Target Files:**
  - `games/lunar-frontier/src/engine/WorldScene.ts`
  - `games/lunar-frontier/src/engine/CameraRig.ts`
  - `games/lunar-frontier/src/client/ClientApp.ts`
  - `games/lunar-frontier/src/client/TouchInputController.ts`
  - `games/lunar-frontier/src/ui/hud.css`
- **Deliverables:**
  1. Set default camera mode to `eva_third_person` across `WorldScene`, `CameraRig`, and `ClientApp`.
  2. Add `#btn-touch-cam` to `TouchInputController.ts` with touch claim isolation and click dispatch calling `cycleCamera()`.
  3. Style `#btn-touch-cam` in `hud.css` to match glassmorphic utility buttons.
- **Verification:** Unit tests confirming default camera is `eva_third_person` and synthetic tap on `#btn-touch-cam` cycles camera mode.

---

### Phase 2: Floating Dynamic Virtual Right Stick (Twin-Stick Architecture)
- **Target Files:**
  - `games/lunar-frontier/src/client/TouchInputController.ts`
  - `games/lunar-frontier/src/client/ClientApp.ts`
  - `games/lunar-frontier/src/ui/hud.css`
- **Deliverables:**
  1. Replace trackpad drag deltas in `TouchInputController.ts` with a dynamic floating Right Virtual Stick:
     - Dynamic origin anchor on `touchstart`.
     - Inner deadzone ($8\text{px}$) and outer clamp ($54\text{px}$).
     - Continuous angular velocity law ($\Omega_\text{yaw} = \hat{u}_x \cdot r_\text{norm} \cdot 2.4\,\text{rad/s}$, $\Omega_\text{pitch} = -\hat{u}_y \cdot r_\text{norm} \cdot 1.8\,\text{rad/s}$).
     - Symmetrical DOM elements (`.lf-touch-look-base`, `.lf-touch-look-nub`) with damped spring return on `touchend`.
     - Immediate zeroing of angular velocity on finger release (no residual drift).
  2. Update `ClientApp.ts` to integrate angular velocity over $\Delta t$.
  3. Add look stick DOM styles in `hud.css`.
- **Verification:** Headless tests asserting stick deflection produces continuous angular velocity proportional to deflection, zero velocity inside deadzone, and zero velocity on release.

---

### Phase 3: Service Worker Registration & Tailscale HTTPS PWA Harness
- **Target Files:**
  - `games/lunar-frontier/public/sw.js` (new)
  - `games/lunar-frontier/src/client/main.ts`
  - `games/lunar-frontier/src/client/index.html`
- **Deliverables:**
  1. Author `public/sw.js` with install, activate, and fetch handlers.
  2. Register Service Worker in `main.ts`.
  3. Verify `vite.config.ts` bundles/copies `sw.js` into `dist/`.
  4. Configure `tailscale serve --bg 5174` to establish valid HTTPS origin on `https://beehive.tail1ab408.ts.net/`.
- **Verification:** Service worker registration script test and HTTPS curl verification.

---

### Phase 4: Headless Smoke Verification Suite & Build Gate
- **Target Files:**
  - `games/lunar-frontier/scripts/smoke-spec34-dual-sticks-view.ts` (new)
  - `games/lunar-frontier/package.json`
- **Deliverables:**
  1. Comprehensive smoke test script asserting:
     - Default camera mode is `eva_third_person`.
     - `#btn-touch-cam` cycles camera modes and triggers haptics.
     - Right virtual stick kinematics (deadzone, clamp, angular velocity proportionality, release stop).
     - Service worker file exists and validates.
     - Production Vite build succeeds with 0 errors.
  2. Register `"smoke:spec34"` in `package.json`.
- **Verification:** `npm run smoke:spec34` passes 100%, and `npm run build` succeeds.
