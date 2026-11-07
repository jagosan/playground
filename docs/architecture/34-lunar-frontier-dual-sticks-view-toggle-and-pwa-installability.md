# Architecture Blueprint 34: Lunar Frontier Virtual Dual-Sticks, Dedicated View Touch Toggle, Default Behind-Camera & PWA Installability Harness

## 1. Context & Architectural Overview

Spec 34 evolves `games/lunar-frontier`'s mobile input and camera architecture following real-device playtesting on Google Pixel 9.

```mermaid
graph TD
    subgraph Mobile Viewport & PWA Shell
        TS[Tailscale Serve: https://beehive.tail1ab408.ts.net] --> SecureOrigin[Secure HTTPS Context]
        SecureOrigin --> SW[Service Worker: public/sw.js]
        SW --> PWA[Chromium BeforeInstallPrompt: Installable PWA]
    end

    subgraph Dual-Stick Input Engine [TouchInputController.ts]
        TouchStart[Multi-Touch Events] --> ZoneCheck{Touch Screen Half}
        ZoneCheck -->|Left Half: X <= 42vw| LStick[Floating Left Stick: Strafe / Forward / Sprint]
        ZoneCheck -->|Right Half: X >= 45vw| RCheck{Hit Action Button?}
        RCheck -->|Yes: Action Cluster| Buttons[Jump, Roll, ContextAction, View, Map, UI]
        RCheck -->|No: Empty Screen| RStick[Floating Right Stick: Pitch / Yaw Angular Velocity]
        RStick --> RMath[Dynamic Origin, Rdead=8px, Rmax=54px]
        RMath --> RateCalc[Continuous Angular Velocity: Yaw 2.4 rad/s, Pitch 1.8 rad/s]
        RateCalc --> DeltaInt[yawDelta = w_yaw * dt, pitchDelta = w_pitch * dt]
    end

    subgraph Camera & Perspective Pipeline [CameraRig.ts & ClientApp.ts]
        Buttons -->|Tap [VIEW]| Cycle[app.cycleCamera: 3rd-Person -> Chase -> 1st-Person]
        Boot[Game Boot] --> DefaultCam[Default: eva_third_person @ 3.2m Over-Shoulder]
        DeltaInt --> ApplyRot[Apply Yaw & Pitch Radian Rotations]
    end
```

---

## 2. Key Architectural Decisions (ADR)

### ADR-034-1: Symmetrical Virtual Dual-Sticks over Differential Drag
- **Context:** Spec 33 used a free-look drag trackpad on the right half of the screen. In field testing, continuous camera panning felt tedious because players had to repetitively swipe, lift, and reset their thumb, and release flick-coasting introduced unpredictable drift.
- **Decision:** Implement symmetrical floating virtual dual-sticks. Both left (movement) and right (look) sticks use dynamic floating origins that anchor wherever the player rests their thumb. Holding the right stick deflected provides continuous rotational velocity proportional to radial deflection ($r_\text{norm}$); releasing immediately stops rotation with a damped spring return.
- **Consequence:** Look rotation becomes consistent, ergonomic, and identical in feel to a console gamepad right analog stick.

### ADR-034-2: Default to Close Third-Person Perspective (`eva_third_person`)
- **Context:** The simulation previously defaulted to `eva_first_person`. On mobile screens, third-person perspective provides vital spatial awareness of the terrain, buggy proximity, and character locomotion kinematics.
- **Decision:** Change default `initialMode` to `eva_third_person`.
- **Consequence:** New sessions spawn directly into over-the-shoulder third-person view showing the astronaut avatar and immediate surroundings.

### ADR-034-3: Chromium Android PWA Installability through Service Worker & Tailscale HTTPS
- **Context:** Pixel 9 Chrome showed "Cannot be installed" when accessing plain HTTP on LAN/Tailscale IP.
- **Decision:** Add `public/sw.js` and register it in `src/client/main.ts`. Run `tailscale serve --bg 5174` to provide a trusted HTTPS origin at `https://beehive.tail1ab408.ts.net/`.
- **Consequence:** Satisfies all Chromium PWA installation criteria with 0 console warnings.

---

## 3. Structural Symbol Map Addition

- `TouchInputController.ts`:
  - `lookStick`: Floating dynamic right stick geometry, deadzone, and spring return.
  - `btnTouchCam`: Dedicated `[VIEW]` touch button element.
- `CameraRig.ts`: Default mode set to `eva_third_person`.
- `public/sw.js`: Service worker asset cache and fetch routing.
