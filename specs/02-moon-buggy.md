# Spec 02: Moon Buggy Minigame

> Source: Transcribed from reMarkable notebook `Playground.pdf`

## Objective & Gameplay Loop
- Drive a lunar rover across the Moon's surface, navigation through craters and uneven terrain.
- Core objective: Collect moon rocks and safely return to base before running out of fuel or oxygen.
- Engine: Low-res retro 3D using Blender + Three.js / Babylon.js / Rogue Engine.

## Milestone 1: Basic Driving & Lunar Physics
- **Physics Fidelity:** Critical requirement — Moon gravity (~1/6th Earth gravity, $1.62\,\text{m/s}^2$) with authentic suspension, bounce, and crater navigation.
- **Camera Perspective:** Slightly above and behind the buggy (chase camera).
- **Controls:** Acceleration, braking, reverse, steering.
- **Resource Constraints (Upcoming):** Fuel and oxygen meters.
