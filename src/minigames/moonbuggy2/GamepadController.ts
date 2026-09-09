export interface GamepadState {
  connected: boolean;
  gamepadName: string;
  steer: number;        // -1.0 to 1.0 (Left Stick X or D-Pad Left/Right)
  throttle: number;     // 0.0 to 1.0 (RT, RB, D-Pad Up, or Axis 5/2)
  brake: number;        // 0.0 to 1.0 (LT, LB, D-Pad Down, or Axis 4/2)
  handbrake: boolean;   // Button B (East)
  reverse: boolean;     // Button X (West)
  toggleCamera: boolean;// Button Y (North)
  actionSample: boolean;// Button A (South) - Retrieve rock / interact
  lookX: number;        // Right Stick X
  lookY: number;        // Right Stick Y
  rawDebug: string;     // Short telemetry string for HUD diagnostics
}

export class GamepadController {
  private lastCameraToggle = false;
  private onCameraToggleCallback?: () => void;
  private connectedGamepadIndex: number | null = null;

  constructor(onCameraToggle?: () => void) {
    this.onCameraToggleCallback = onCameraToggle;

    if (typeof window !== 'undefined') {
      window.addEventListener('gamepadconnected', (e: GamepadEvent) => {
        console.log(`[Gamepad] Connected: ${e.gamepad.id} (index ${e.gamepad.index}, ${e.gamepad.buttons.length} buttons, ${e.gamepad.axes.length} axes)`);
        if (this.connectedGamepadIndex === null && (e.gamepad.buttons.length >= 4 || e.gamepad.axes.length >= 2)) {
          this.connectedGamepadIndex = e.gamepad.index;
        }
      });

      window.addEventListener('gamepaddisconnected', (e: GamepadEvent) => {
        console.log(`[Gamepad] Disconnected: index ${e.gamepad.index}`);
        if (this.connectedGamepadIndex === e.gamepad.index) {
          this.connectedGamepadIndex = null;
        }
      });
    }
  }

  public poll(): GamepadState {
    const defaultState: GamepadState = {
      connected: false,
      gamepadName: '',
      steer: 0,
      throttle: 0,
      brake: 0,
      handbrake: false,
      reverse: false,
      toggleCamera: false,
      actionSample: false,
      lookX: 0,
      lookY: 0,
      rawDebug: 'NO CONTROLLER DETECTED',
    };

    if (typeof navigator === 'undefined' || !navigator.getGamepads) {
      return defaultState;
    }

    const gamepads = navigator.getGamepads();
    if (!gamepads) return defaultState;

    // 1. Check all connected gamepads for active input
    let gp: Gamepad | null = null;
    for (let i = 0; i < gamepads.length; i++) {
      const cand = gamepads[i];
      if (!cand || !cand.connected) continue;
      const isAnyBtnPressed = cand.buttons?.some((b) => b.pressed || (typeof b.value === 'number' && b.value > 0.15));
      const isAnyAxisActive = cand.axes?.some((a, idx) => {
        // Exclude trigger axes that may rest at -1 or 1
        if (idx === 2 || idx === 4 || idx === 5) return false;
        return Math.abs(a) > 0.25;
      });
      if (isAnyBtnPressed || isAnyAxisActive) {
        gp = cand;
        this.connectedGamepadIndex = i;
        break;
      }
    }

    // 2. If no active inputs right now, use previously active or first valid gamepad
    if (!gp) {
      if (this.connectedGamepadIndex !== null && gamepads[this.connectedGamepadIndex]?.connected) {
        gp = gamepads[this.connectedGamepadIndex];
      } else {
        for (let i = 0; i < gamepads.length; i++) {
          const cand = gamepads[i];
          if (cand && cand.connected && cand.buttons && cand.buttons.length >= 4) {
            gp = cand;
            this.connectedGamepadIndex = i;
            break;
          }
        }
      }
    }

    if (!gp) return defaultState;

    // Apply deadzone to analog sticks
    const applyDeadzone = (val: number, threshold = 0.12): number => {
      if (Math.abs(val) < threshold) return 0;
      const sign = Math.sign(val);
      return sign * ((Math.abs(val) - threshold) / (1 - threshold));
    };

    const isBtnPressed = (index: number): boolean => {
      const btn = gp.buttons[index];
      if (!btn) return false;
      return Boolean(btn.pressed || (typeof btn.value === 'number' && btn.value > 0.4));
    };

    // -------------------------------------------------------------------------
    // 1. STEERING: Left Stick X (axes[0]) + D-Pad Left/Right (buttons 14/15)
    // -------------------------------------------------------------------------
    let steer = applyDeadzone(gp.axes[0] || 0);
    if (isBtnPressed(14)) steer = -1.0; // D-Pad Left
    if (isBtnPressed(15)) steer = 1.0;  // D-Pad Right

    // -------------------------------------------------------------------------
    // 2. THROTTLE (RT):
    //    - Button 7 (Standard RT trigger)
    //    - Axis 5 (Linux XInput RT)
    //    - Axis 2 (DirectInput / Alternative RT)
    //    - Button 5 (RB - Right Bumper fallback)
    //    - Button 12 (D-Pad Up fallback)
    // -------------------------------------------------------------------------
    let throttle = 0;
    const btn7 = gp.buttons[7];
    if (btn7) {
      if (typeof btn7.value === 'number' && btn7.value > 0.05) {
        throttle = btn7.value;
      } else if (btn7.pressed) {
        throttle = 1.0;
      }
    }

    // Check Axis 5 (Linux XInput RT trigger: rests at -1.0, max at 1.0)
    if (throttle < 0.05 && gp.axes[5] !== undefined && gp.axes[5] > -0.80) {
      throttle = Math.max(throttle, (gp.axes[5] + 1) / 2);
    }

    // Check Axis 2 (Alternative RT axis)
    if (throttle < 0.05 && gp.axes[2] !== undefined && gp.axes[2] > -0.80 && gp.axes.length >= 4) {
      throttle = Math.max(throttle, (gp.axes[2] + 1) / 2);
    }

    // Bumpers & D-Pad Up
    if (throttle < 0.05) {
      if (isBtnPressed(5)) throttle = 1.0;       // RB
      else if (isBtnPressed(12)) throttle = 1.0; // D-Pad Up
    }
    throttle = THREE_clamp01(throttle);

    // -------------------------------------------------------------------------
    // 3. BRAKE (LT):
    //    - Button 6 (Standard LT trigger)
    //    - Axis 4 (Linux XInput LT)
    //    - Button 4 (LB - Left Bumper fallback)
    //    - Button 13 (D-Pad Down fallback)
    // -------------------------------------------------------------------------
    let brake = 0;
    const btn6 = gp.buttons[6];
    if (btn6) {
      if (typeof btn6.value === 'number' && btn6.value > 0.05) {
        brake = btn6.value;
      } else if (btn6.pressed) {
        brake = 1.0;
      }
    }

    // Check Axis 4 (Linux XInput LT trigger: rests at -1.0, max at 1.0)
    if (brake < 0.05 && gp.axes[4] !== undefined && gp.axes[4] > -0.80) {
      brake = Math.max(brake, (gp.axes[4] + 1) / 2);
    }

    // Bumpers & D-Pad Down
    if (brake < 0.05) {
      if (isBtnPressed(4)) brake = 1.0;       // LB
      else if (isBtnPressed(13)) brake = 1.0; // D-Pad Down
    }
    brake = THREE_clamp01(brake);

    // -------------------------------------------------------------------------
    // 4. FACE BUTTONS:
    //    - Button 0 (A / South): Primary Action / Sample Rock / Dock
    //    - Button 1 (B / East): Handbrake / Drift
    //    - Button 2 (X / West): Reverse Gear
    //    - Button 3 (Y / North): Camera Toggle
    // -------------------------------------------------------------------------
    const actionSample = isBtnPressed(0); // Button A
    const handbrake = isBtnPressed(1);    // Button B
    const reverse = isBtnPressed(2);      // Button X
    const toggleCamera = isBtnPressed(3); // Button Y

    const lookX = applyDeadzone(gp.axes[2] || 0);
    const lookY = applyDeadzone(gp.axes[3] || 0);

    if (toggleCamera && !this.lastCameraToggle) {
      this.onCameraToggleCallback?.();
    }
    this.lastCameraToggle = toggleCamera;

    const rawDebug = `RT:${(throttle * 100).toFixed(0)}% LT:${(brake * 100).toFixed(0)}% ST:${(steer * 100).toFixed(0)}%`;

    return {
      connected: true,
      gamepadName: gp.id || 'Standard Gamepad',
      steer,
      throttle,
      brake,
      handbrake,
      reverse,
      toggleCamera,
      actionSample,
      lookX,
      lookY,
      rawDebug,
    };
  }
}

function THREE_clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
