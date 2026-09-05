# Playground & Moon Buggy Operations

## Overview
Playground is a retro 3D low-poly web game built with Three.js and Vite. It features a central playground lobby hub and modular minigames, including the Moon Buggy lunar rover driving simulator (Spec 02).

## Live Access (Tailscale)
- **Direct URL:** `http://100.99.188.15:8088/` (or `http://beehive:8088/` across Tailscale)
- **Local Host:** `http://127.0.0.1:8088/`
- **Systemd User Service:** `playground.service`
  ```bash
  # Check status
  XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user status playground.service
  # Restart service
  XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart playground.service
  ```

## Controls Matrix

### 1. Playground Lobby
| Action | Desktop / Laptop | Phone / Tablet (Touch) |
|---|---|---|
| **Walk / Move** | `W`/`A`/`S`/`D` or Arrows | On-screen Virtual D-Pad (`▲` `▼` `◀` `▶`) |
| **Look / Rotate** | Click canvas to lock mouse, drag | Touch swipe / drag anywhere on screen |
| **Jump** | `Spacebar` | `JUMP` touch button |
| **View Toggle** | `V` (1st / 3rd Person) | `VIEW` touch button |
| **Play Minigame** | `E` when near equipment | Tap the yellow interaction banner or `PLAY` button |

### 2. Moon Buggy Minigame (Spec 02)
| Action | Desktop / Laptop | Phone / Tablet (Touch) |
|---|---|---|
| **Accelerate** | `W` or `Up Arrow` | `▲` button (Right thumb) |
| **Reverse** | `S` or `Down Arrow` | `▼` button (Right thumb) |
| **Steer Left / Right** | `A` / `D` or Left / Right Arrows | `◀` / `▶` buttons (Left thumb) |
| **Brake / Stop** | `Spacebar` | `STOP` button |
| **Return to Lobby** | `Escape` key | `[ESC] RETURN TO LOBBY` button |

## Repository & Documentation
- Codebase: `/home/jagosan/repos/playground`
- Specs: `/home/jagosan/repos/playground/specs/`
- Architecture Blueprints: `/home/jagosan/repos/playground/docs/architecture/`
- Symbol Map: `/home/jagosan/repos/playground/docs/MAP.md`
- Kanban Board: `[[boards/Kanban-Playground|Kanban-Playground]]`
