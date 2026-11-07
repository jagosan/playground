# Spec 33: Lunar Frontier Mobile Touch Client, Virtual Dual-Sticks, Safe-Area Responsive HUD & PWA Harness

## 1. Executive Summary & Problem Statement

`games/lunar-frontier` is a persistent multiplayer lunar economy simulation and 3D terrain exploration game built on Babylon.js (WebGL2/WebGPU) with an authoritative Fastify + WebSocket server. While the desktop client features deep keyboard/mouse and gamepad input (including analog trigger curves, dual-stick decoupled rover steering, and Stormtrooper EVA locomotion), players on mobile devices (iOS / iPadOS Safari and Android Chrome) currently face major friction points preventing gameplay:

1. **Complete Absence of Touch Input & Movement Inability:**
   - `ClientApp.ts` samples inputs exclusively from physical keyboards (`this.pressed: Set<string>`) and the W3C Gamepad API (`pollGamepad(): GamepadLike | null`).
   - On touchscreen devices without a connected physical controller, the player cannot move forward/backward, strafe, jump, sprint, mine, climb ladders, or board rovers. The viewport renders the 3D surface, but the avatar remains completely frozen.

2. **Camera Lock & Touch Event Collisions:**
   - The canvas element (`#scene`) uses `touch-action: none`, but touch drag gestures either collide with default browser pinch-to-zoom / swipe-navigation gestures or fail to feed look-pitch/yaw deltas into `CameraRig.ts` and `ClientInputFrame`.
   - Players need a dedicated virtual look surface (or dual-stick configuration) that cleanly translates touch deltas into smooth camera rotation without fighting browser navigation.

3. **Desktop-Bound Glassmorphic HUD & Safe-Area Violations:**
   - The glassmorphic HUD (`LunarHUD.ts`, `hud.css`) is styled for widescreen desktop displays ($1920 \times 1080$).
   - On mobile devices, the HUD spills outside screen boundaries. Crucially, on modern mobile hardware (iPhone Dynamic Island / notch, rounded display corners, Android camera hole-punches, and iOS gesture home indicator bars), crucial telemetry cards and prompt boxes are occluded by hardware cutouts because CSS safe-area insets (`env(safe-area-inset-*)`) are not enforced.
   - Interactive modal windows (Commodity Trading Terminal, Topographic Hologram Map, Mass Accelerator Fire Control) overflow the mobile viewport and lack touch-scrolling and thumb-reachable touch hit targets ($\ge 44\text{px}\times 44\text{px}$).

4. **Browser Chrome Encroachment & Missing PWA Shell:**
   - Mobile Safari and Chrome display persistent navigation bars, search inputs, and bottom tab ribbons that consume up to 35% of the vertical screen real estate.
   - Without a Web App Manifest (`manifest.webmanifest`), Apple mobile web app capability tags, and standalone display configurations, players cannot "Add to Home Screen" to launch a true full-screen, native-feeling client.

5. **Thermal Throttling & Battery Drain from Unconstrained High-DPI Rendering:**
   - Flagship smartphones feature high-density displays (e.g. $2796 \times 1290$ at 3x DPR on iPhone 16 Pro, $3120 \times 1440$ on Galaxy S24 Ultra).
   - Running full-resolution WebGL2/WebGPU rendering with cascaded shadow maps, volumetric light cones, and multi-frequency regolith PBR at native 3x DPR triggers thermal throttling within minutes, crashing frame rates to $<15\,\text{FPS}$ and draining battery rapidly.
   - A hardware scaling limiter and mobile performance preset system is required to clamp DPR to sustainable thresholds (1.0–1.5x) while preserving visual clarity.

6. **Suspended Mobile Web Audio & Missing Haptic Feedback:**
   - Mobile operating systems strictly suspend Web Audio contexts until an explicit user touch gesture occurs.
   - Tactile feedback (touchdown impact, mining laser vibration, rover wheel slip, RCS thruster burst) is completely absent on mobile, missing an opportunity for immersive gameplay via native `navigator.vibrate` / Web Haptics.

7. **Network Fragility across Mobile Sleep / Tab Switching:**
   - When a mobile device locks or switches apps, WebSockets disconnect immediately. The client requires graceful reconnection logic that preserves state, re-syncs world time, and falls back to offline mining without crashing the session.

---

## 2. Architectural Contracts & System Decomposition

```
                                [ Mobile Device ]
                     (Touch Events, Device Orientation, Safe Areas)
                                        │
                         ┌──────────────┴──────────────┐
                         ▼                             ▼
              [ TouchInputController ]        [ PWA / App Shell ]
              • Floating Left Stick           • manifest.webmanifest
              • Free-Look Right Trackpad      • iOS/Android meta tags
              • Action Cluster (Jump, Mine)   • Portrait Orientation Shield
                         │                             │
                         ▼                             │
                  [ ClientApp.ts ]                     ▼
       (Tri-State Input: Touch/Pad/Key)         [ LunarHUD.ts ]
                         │              • Safe-Area Padding (env())
       ┌─────────────────┼────────────────┐     • Responsive Breakpoint (≤960px)
       ▼                 ▼                ▼     • Mobile Trade/Map Sheet
[ TraversalPhysics ] [ CameraRig ] [ LunarAudioSystem ]
• Touch Strafe/Fwd   • Touch Pitch • Touch Audio Unlock
• RCS Boost / Roll   • Touch Yaw   • Tactile Haptics (vibrate)
```

---

### 2.1 PWA Manifest & Mobile App Shell Specification

The web entry point (`src/client/index.html`) and build assets must provide first-class progressive web app configuration:

1. **Web App Manifest (`public/manifest.webmanifest`):**
   ```json
   {
     "name": "Lunar Frontier",
     "short_name": "LunarFrontier",
     "description": "Persistent multiplayer lunar economy and 3D exploration simulation",
     "start_url": "/?pwa=1",
     "display": "standalone",
     "orientation": "landscape",
     "background_color": "#000000",
     "theme_color": "#000000",
     "icons": [
       { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
       { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
     ]
   }
   ```

2. **iOS Standalone & Viewport Meta Tags:**
   - `<meta name="apple-mobile-web-app-capable" content="yes" />`
   - `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`
   - `<meta name="apple-mobile-web-app-title" content="LunarFrontier" />`
   - `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />`
   - `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />`

3. **Orientation Enforcement (Landscape Lock & Guard Shield):**
   - Lunar Frontier is an expansive 3D simulation requiring horizontal field-of-view.
   - Screen Orientation API: On supported browsers, invoke `screen.orientation?.lock?.('landscape')` upon user interaction.
   - **Portrait Orientation Veil:** When viewport height exceeds width ($h > w$), render an elegant glassmorphic overlay `#orientation-guard`:
     - Message: *"LUNAR FRONTIER // ORBITAL TRANSIT LOCK"*
     - Subtext: *"Rotate device to landscape to engage surface telemetry and controls"*
     - Animated 2D vector graphic showing device rotation to landscape.
     - Automatically dismisses with zero lag when `window.matchMedia('(orientation: landscape)')` evaluates true.

---

### 2.2 Touch Input Architecture & Virtual Control Deck (`TouchInputController.ts`)

A dedicated touch controller module `src/client/TouchInputController.ts` decouples mobile gesture processing from the core rendering loop and feeds normalized frames into `ClientApp.ts`.

#### 2.2.1 Virtual Dual-Deck Layout
```
┌────────────────────────────────────────────────────────────────────────┐
│ [MAP]                                                  [UI]  [SETTINGS]│
│                                                                        │
│                                                  [LOOK / PAN AREA]     │
│                                                  (Right Screen Half)   │
│                                                  Touch swipe pan       │
│                                                                        │
│   [LEFT STICK]                                  [ACTION CLUSTER]       │
│   Floating / Dynamic                            ┌───┐                  │
│   Radius: 48px                                  │JMP│ (Jump/RCS Boost) │
│   Forward / Strafe                              └───┘                  │
│   Double-Flick: Sprint                     ┌───┐     ┌───┐             │
│                                            │ACT│     │ROL│ (Roll/Flip) │
│                                            └───┘     └───┘             │
│                                         (Mine/Board)                   │
└────────────────────────────────────────────────────────────────────────┘
```

#### 2.2.2 Floating Dynamic Left Virtual Stick (Movement)
- **Anchor Zone:** Bottom-left quadrant ($X \in [0, 42vw], Y \in [35vh, 100vh]$).
- **Floating Origin:** The stick origin $(\bar{x}, \bar{y})$ anchors dynamically to the player's initial `touchstart` coordinate within the zone, eliminating the need to look down at thumb placement.
- **Deflection & Clamping:**
  $$\vec{d} = (x_\text{touch} - \bar{x}, \; y_\text{touch} - \bar{y})$$
  $$r = \|\vec{d}\|, \quad R_\text{max} = 54\,\text{px}, \quad R_\text{dead} = 8\,\text{px}$$
  If $r < R_\text{dead}$: output is $(0, 0)$.
  If $r \ge R_\text{dead}$:
  $$\hat{u} = \frac{\vec{d}}{r}, \quad r_\text{norm} = \text{clamp}\left(\frac{r - R_\text{dead}}{R_\text{max} - R_\text{dead}}, 0, 1\right)$$
  $$\text{strafeDemand} = \hat{u}_x \cdot r_\text{norm}$$
  $$\text{forwardDemand} = -\hat{u}_y \cdot r_\text{norm}$$
- **Sprint Latch / Outer Threshold:**
  - When $r_\text{norm} \ge 0.90$ for more than $300\,\text{ms}$, or upon an outward double-flick, auto-engage Sprint (`sprint: true`).
- **Visual Feedback:** Glassmorphic outer boundary ring with cyan glowing center nub that tracks thumb position with damped spring return on `touchend`.

#### 2.2.3 Free-Look Right Trackpad (Camera Orientation)
- **Active Zone:** Right half of the screen ($X \in [45vw, 100vw], Y \in [0, 100vh]$), excluding touch bounding boxes of active action buttons.
- **Differential Drag Translation:**
  - Touch moves calculate instantaneous delta per frame $(\Delta x, \Delta y)$.
  - Yaw rate: $\Delta \theta_\text{yaw} = \Delta x \cdot S_\text{yaw}$ (where $S_\text{yaw} \approx 0.0035\,\text{rad/px}$).
  - Pitch rate: $\Delta \theta_\text{pitch} = -\Delta y \cdot S_\text{pitch}$ (where $S_\text{pitch} \approx 0.0028\,\text{rad/px}$).
- **Smooth Inertial Decay:**
  - On `touchend`, if the finger flick velocity $\|\vec{v}_\text{flick}\| > 0.4\,\text{px/ms}$, apply exponential decay damping ($\tau \approx 120\,\text{ms}$) to provide cinematic camera coasting.

#### 2.2.4 Action Button Cluster (Right Thumb Zone)
Every action button maintains a minimum touch hit target of $52\,\text{px} \times 52\,\text{px}$ with high-contrast glassmorphic styling:

1. **`[JUMP / BOOST]` Primary Action Button:**
   - **Grounded State:** Fires ground hop (`jump: true`).
   - **Airborne State:** Triggers Spec 32 PLSS cold-gas RCS jump boost (`jump: true` rising edge) with tactile haptic pulse and visual gas vent.
2. **`[ROLL / TUCK]` Acrobatic Action Button:**
   - **Airborne State:** Triggers Spec 32 mid-air acrobatic somersault tuck and flip (`roll: true`).
   - **Grounded State:** Performs low-profile crouch.
3. **`[CONTEXTUAL ACTION]` Dynamic Smart Button (`#btn-touch-action`):**
   - Automatically illuminates and labels itself based on nearby proximity triggers:
     - Near mineral vein: `[⛏ MINE <ORE>]`
     - Near buggy: `[🚗 BOARD BUGGY]` (or `[🚶 DISMOUNT]` while driving)
     - Near radio tower ladder: `[🪜 CLIMB LADDER]`
     - Near station dock / NPC: `[📊 TRADE]`
   - Glows with bright amber/cyan accent when an interaction target is within active radius.
4. **`[MAP]` & `[UI]` Peripheral Utility Buttons:**
   - Top-right/top-left floating buttons for toggling holographic topographic map, minimal HUD mode (`[U]`), and settings modal without needing keyboard shortcuts.

---

### 2.3 Input Source Tri-State (`'keyboard' | 'gamepad' | 'touch'`) & Auto-Hiding

1. **Tri-State Type Expansion:**
   Update `ClientApp.ts` and `LunarHUD.ts`:
   ```typescript
   export type HudInputSource = 'keyboard' | 'gamepad' | 'touch';
   ```

2. **Intelligent Hardware Switch & Auto-Hiding:**
   - When a physical touch is detected (`touchstart` on canvas or virtual controls), `inputSource` immediately transitions to `'touch'`.
   - On-screen touch controls render at full visibility (`opacity: 1, pointer-events: auto`).
   - Action prompt badges in `LunarHUD` switch from keyboard brackets `[E]` or gamepad glyphs `(X)` to tactile touch icons (e.g. `[👆 TAP MINE]`).
   - **Bluetooth Gamepad Coexistence:**
     - If the player connects a mobile Bluetooth controller (Backbone One, Razer Kishi, Xbox/PlayStation controller), any stick movement or button press transitions `inputSource` to `'gamepad'`.
     - The on-screen virtual touch controls smoothly fade out (`opacity: 0, pointer-events: none`, $300\,\text{ms}$ transition) so the entire display remains uncluttered.
     - Touching the screen instantly restores virtual controls and flips back to `'touch'`.

---

### 2.4 Responsive Glassmorphic HUD & Mobile Safe-Area Layout

1. **CSS Safe-Area Inset Enforcement (`hud.css`):**
   All HUD fixed containers must integrate CSS environment variables:
   ```css
   #lunar-hud {
     padding-top: max(8px, env(safe-area-inset-top));
     padding-bottom: max(8px, env(safe-area-inset-bottom));
     padding-left: max(12px, env(safe-area-inset-left));
     padding-right: max(12px, env(safe-area-inset-right));
   }
   ```
   This ensures that the top compass tape, life-support meters, and bottom action prompts never collide with iPhone Dynamic Island / notch cutouts, rounded display corners, or bottom swipe bars.

2. **Mobile Breakpoint Rules (`@media (max-width: 960px) and (orientation: landscape)`):**
   - **Compass Tape:** Scale width to $50vw$, collapse extraneous degree tick typography, and prioritize active waypoint pins.
   - **Life-Support & Telemetry Card:** Compact into a unified pill ($O_2$, Power, Speed) anchored to the top-right corner with condensed micro-gauges.
   - **Trade Terminal & Modals:**
     - Force modal container to $92vw \times 88vh$, centered with `overflow-y: auto` and `-webkit-overflow-scrolling: touch`.
     - Commodity row heights expanded to $\ge 48\,\text{px}$ to satisfy iOS Human Interface Guidelines and Android Material tap target standards.
     - Quantity stepper buttons enlarged to $44\,\text{px} \times 44\,\text{px}$ with generous spacing.

---

### 2.5 Mobile GPU Performance, Battery & Thermal Management

High-density mobile screens require disciplined rendering budgets to prevent thermal throttling and battery exhaustion:

1. **Device Pixel Ratio (DPR) Clamping:**
   In `ClientApp.ts` during engine initialization:
   ```typescript
   // Default clamping: cap mobile DPR at 1.5x (or 1.0x on low-power profiles)
   const rawDpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
   const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
   const maxAllowedDpr = isMobileDevice ? 1.5 : 2.0;
   const effectiveDpr = Math.min(rawDpr, maxAllowedDpr);
   engine.setHardwareScalingLevel(1 / effectiveDpr);
   ```

2. **Three-Tier Mobile Performance Presets (`src/client/MobileSettings.ts`):**
   - **Battery Saver:** Hardware scaling $1.5$ (effective $\approx 720\text{p}$), 30 FPS render loop cap, contact shadows disabled, terrain normal micro-tiling LOD halved.
   - **Balanced (Default Mobile):** Hardware scaling $1.0$ (effective $\approx 1080\text{p}$), 60 FPS, optimized single-cascade shadow map, standard regolith PBR.
   - **High Fidelity:** Full native resolution (up to 2.0x DPR), 60/120 FPS, full cascaded shadows and volumetric buggy headlights.
   - Presets accessible via the top-bar Settings icon and persisted in `localStorage`.

---

### 2.6 Web Audio Unlock & Tactile Haptic Synthesis

1. **Touch Gesture Audio Unlocking:**
   - Modern mobile browsers refuse audio playback until an explicit user gesture.
   - The boot screen (`#loading`) presents a prominent tactile trigger: *"TAP TO ENGAGE SUIT LIFE SUPPORT & ENTER SIMULATION"*.
   - The initial tap simultaneously calls `audioSystem.resume()` and transitions into the game loop, guaranteeing zero muted intro experiences.

2. **Tactile Haptic Feedback Engine (`src/audio/TactileHaptics.ts`):**
   Expose a lightweight, safely duck-typed haptic synthesizer utilizing `navigator.vibrate` on Android and Gamepad haptics on supported mobile controllers:
   - **Footfall Contact:** Single micro-tap ($12\,\text{ms}$) on alternating stance boot impact.
   - **RCS Boost Activation:** Crisp double-tap ($15\,\text{ms}, 30\,\text{ms}$ delay, $20\,\text{ms}$).
   - **Mining Laser Discharge:** Low-amplitude periodic buzz ($25\,\text{ms}$ pulse every $150\,\text{ms}$) while beam is latched.
   - **Rover Ground Collision / Bottoming Out:** Heavy shock thump ($60\,\text{ms}$).
   - Automatically disabled if `navigator.vibrate` is absent (iOS Safari fallback) or toggled off in settings.

---

### 2.7 Mobile Network Resilience & Session Recovery

1. **Visibility & Background Suspension Handling:**
   - On mobile, switching apps or locking the device immediately puts the JavaScript thread to sleep and closes WebSocket sockets.
   - Implement a `document.addEventListener('visibilitychange', ...)` handler in `NetworkClient.ts`:
     - When `document.hidden` becomes true: gracefully notify server of paused state and park the physics loop.
     - When `document.visibilityState === 'visible'`: ping server health endpoint, re-establish WebSocket session with authentication token, and reconcile authoritative player position without reloading the page.
2. **Offline Mining Sync:**
   - Seamlessly activate offline extraction fallback (Spec 19 §2.3) when cellular or Wi-Fi connectivity drops, queuing harvested mineral credits in local storage until the shard connection is restored.

---

## 3. Phased Implementation Roadmap

```
Phase 1: PWA Manifest, Mobile Viewport & Orientation Shield
Phase 2: TouchInputController & Floating Virtual Dual-Sticks
Phase 3: Contextual Action Buttons & Tri-State Input Dispatch
Phase 4: Responsive Glassmorphic HUD & Mobile Safe-Area Layout
Phase 5: Mobile Performance Profiles, DPR Clamping, Audio & Haptics
Phase 6: Automated Headless Smoke Verification Suite & Build Gate
```

---

### Phase 1: PWA Manifest, Mobile Viewport & Orientation Shield
- **Target Files:**
  - `games/lunar-frontier/public/manifest.webmanifest`
  - `games/lunar-frontier/src/client/index.html`
  - `games/lunar-frontier/src/ui/hud.css`
- **Deliverables:**
  1. Author `manifest.webmanifest` with standalone display, landscape orientation, theme color `#000000`, and mobile icons.
  2. Add iOS meta tags (`apple-mobile-web-app-capable`, `viewport-fit=cover`) and favicon/touch-icon references to `index.html`.
  3. Create `#orientation-guard` overlay in DOM and CSS that activates when `(orientation: portrait)` with sleek rotation animation.
- **Verification:** HTML head validation, PWA manifest syntax parsing, CSS media query orientation tests.

---

### Phase 2: TouchInputController & Floating Virtual Dual-Sticks
- **Target Files:**
  - `games/lunar-frontier/src/client/TouchInputController.ts` (new)
  - `games/lunar-frontier/src/client/ClientApp.ts`
- **Deliverables:**
  1. Implement `TouchInputController` class managing multi-touch lifecycle (`touchstart`, `touchmove`, `touchend`, `touchcancel`).
  2. Create floating dynamic Left Virtual Stick with automatic deadzone ($8\,\text{px}$), clamping radius ($54\,\text{px}$), and forward/strafe normalization.
  3. Create Right Free-Look Trackpad translating touch drag deltas to smooth camera yaw and pitch velocities with inertial flick decay.
  4. Mount visual stick rings and glowing thumbs into DOM with non-blocking pointer events.
- **Verification:** Headless synthetic multi-touch event injection verifying normalized $[-1, 1]$ output frames, deadzone clipping, and inertial decay.

---

### Phase 3: Contextual Action Buttons & Tri-State Input Dispatch
- **Target Files:**
  - `games/lunar-frontier/src/client/TouchInputController.ts`
  - `games/lunar-frontier/src/client/ClientApp.ts`
  - `games/lunar-frontier/src/ui/LunarHUD.ts`
- **Deliverables:**
  1. Implement high-contrast circular action buttons: `[JUMP / RCS BOOST]`, `[ROLL / TUCK]`, and dynamic `[ACTION]`.
  2. Wire contextual action button to proximity checks (mining mineral veins, boarding rovers, mounting ladders, trading).
  3. Expand `inputSource` to `'keyboard' | 'gamepad' | 'touch'`.
  4. Auto-hide on-screen touch controls when gamepad input is detected; re-illuminate on screen touch.
- **Verification:** Assert tri-state transitions, button press latches in `ClientInputFrame`, and proximity action firing under synthetic touches.

---

### Phase 4: Responsive Glassmorphic HUD & Mobile Safe-Area Layout
- **Target Files:**
  - `games/lunar-frontier/src/ui/LunarHUD.ts`
  - `games/lunar-frontier/src/ui/hud.css`
- **Deliverables:**
  1. Enforce CSS safe-area insets (`env(safe-area-inset-*)`) across all HUD containers, toasts, and dialogs.
  2. Implement responsive mobile landscape breakpoint ($\le 960\,\text{px}$): compact compass tape, aggregated suit telemetry pill, and scaled notification cards.
  3. Refactor Trade Terminal, Topographic Map, and Settings modal dialogs for mobile touch-scrolling with $\ge 48\,\text{px}$ tap targets.
- **Verification:** Headless DOM smoke tests validating CSS class toggles, container safe-area styles, and modal element dimension thresholds.

---

### Phase 5: Mobile Performance Profiles, DPR Clamping, Audio & Haptics
- **Target Files:**
  - `games/lunar-frontier/src/client/MobileSettings.ts` (new)
  - `games/lunar-frontier/src/client/ClientApp.ts`
  - `games/lunar-frontier/src/audio/LunarAudioSystem.ts`
  - `games/lunar-frontier/src/audio/TactileHaptics.ts` (new)
- **Deliverables:**
  1. Implement DPR clamping in `ClientApp.ts` (`Math.min(devicePixelRatio, 1.5)` on mobile devices).
  2. Create 3-tier performance preset selector (Battery Saver / Balanced / High Fidelity).
  3. Add one-touch audio unlock banner to boot screen for mobile Safari / Chrome compliance.
  4. Implement `TactileHaptics` synthesizer wrapping `navigator.vibrate` with distinct patterns for footsteps, jump boost, and mining.
- **Verification:** Unit tests verifying DPR clamp limits, performance profile state persistence, and haptic vibration pattern triggers.

---

### Phase 6: Automated Headless Smoke Verification Suite & Build Gate
- **Target Files:**
  - `games/lunar-frontier/scripts/smoke-mobile-client.ts` (new)
  - `games/lunar-frontier/package.json`
- **Deliverables:**
  1. Author comprehensive headless smoke test suite `smoke-mobile-client.ts` exercising:
     - Synthetic multi-touch gesture processing on virtual stick and look trackpad.
     - Contextual button actions and `ClientInputFrame` field mappings.
     - Tri-state input transitions (`keyboard` $\to$ `touch` $\to$ `gamepad` $\to$ `touch`).
     - Safe-area layout styles and portrait orientation guard toggles.
     - Mobile DPR clamping and performance profile transitions.
     - Tactile haptic pulse triggers and Web Audio unlock callbacks.
  2. Register `"smoke:mobile-client"` script in `package.json`.
  3. Ensure production client bundle build (`npm run build`) passes cleanly with zero TypeScript errors.
- **Verification:** Execute `npx tsx scripts/smoke-mobile-client.ts` and `npm run build`.

---

## 4. Acceptance Criteria & Automated Smoke Gates

To satisfy the contract of Spec 33, the implementation must pass the following strict criteria:

1. **PWA & Mobile Shell Compliance:**
   - `manifest.webmanifest` is valid JSON and serves with correct MIME type.
   - `index.html` contains viewport meta tags with `viewport-fit=cover` and iOS standalone tags.
   - Portrait orientation triggers `#orientation-guard` with warning message; landscape restores gameplay.

2. **Touch Input Precision & Kinematic Contracts:**
   - Left virtual stick accurately outputs normalized $(x, y) \in [-1, 1]^2$ with directional preservation.
   - Center deadzone ($8\,\text{px}$) produces exact $0.0$ output when untouched.
   - Deflections past $90\%$ for $\ge 300\,\text{ms}$ latch `sprint: true`.
   - Right look trackpad produces smooth yaw/pitch rates with inertial decay damping.

3. **Contextual Action Integration:**
   - Touching `[JUMP / RCS BOOST]` on the ground initiates low-gravity jump; touching while airborne fires PLSS RCS thrusters and drains oxygen per Spec 32.
   - Touching `[ROLL / TUCK]` while airborne triggers mid-air somersault tuck and flip per Spec 32.
   - Contextual button dynamically lights up and maps to nearby mining veins or vehicle boarding envelopes.

4. **Tri-State Input Coexistence:**
   - Physical touch flips `inputSource` to `'touch'` and displays virtual controls.
   - Connected Bluetooth gamepad input flips `inputSource` to `'gamepad'` and smoothly fades out on-screen controls.
   - Keyboard interaction flips `inputSource` to `'keyboard'`.

5. **Safe-Area HUD Ergonomics:**
   - No HUD telemetry element or interactive button collides with screen perimeter margins ($< env(\text{safe-area-inset}))$ on notched displays.
   - All interactive touch buttons satisfy minimum $44\,\text{px} \times 44\,\text{px}$ tap target bounds.
   - Trade dialog and topographic map are fully scrollable and operable via touch gestures.

6. **Mobile Performance & Audio Integrity:**
   - Mobile hardware scaling caps DPR to $\le 1.5$ in balanced mode and $\le 1.0$ in battery-saver mode.
   - AudioContext cleanly unlocks on the first user touch gesture without unhandled promise rejections.
   - Headless verification script `smoke-mobile-client.ts` completes with 100% passing assertions.
   - Production Vite client bundle builds cleanly with `npm run build`.
