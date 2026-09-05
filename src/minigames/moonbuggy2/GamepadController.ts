export interface GamepadState {
  connected: boolean;
  steer: number;        // -1.0 to 1.0 (Left Stick X)
  throttle: number;     // 0.0 to 1.0 (Right Trigger RT)
  brake: number;        // 0.0 to 1.0 (Left Trigger LT)
  handbrake: boolean;   // Button A / South
  reverse: boolean;     // Button X / West
  toggleCamera: boolean;// Button Y / North
  lookX: number;        // Right Stick X
  lookY: number;        // Right Stick Y
}

export class GamepadController {
  private lastCameraToggle = false;
  private onCameraToggleCallback?: () => void;

  constructor(onCameraToggle?: () => void) {
    this.onCameraToggleCallback = onCameraToggle;
  }

  public poll(): GamepadState {
    const defaultState: GamepadState = {
      connected: false,
      steer: 0,
      throttle: 0,
      brake: 0,
      handbrake: false,
      reverse: false,
      toggleCamera: false,
      lookX: 0,
      lookY: 0,
    };

    if (typeof navigator === 'undefined' || !navigator.getGamepads) {
      return defaultState;
    }

    const gamepads = navigator.getGamepads();
    if (!gamepads) return defaultState;

    // Look for connected gamepad (GPD Win Max 2 / Xbox 360 controller)
    let gp: Gamepad | null = null;
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i] && gamepads[i]!.connected) {
        gp = gamepads[i];
        break;
      }
    }

    if (!gp) return defaultState;

    // Apply deadzone to analog sticks
    const applyDeadzone = (val: number, threshold = 0.12): number => {
      if (Math.abs(val) < threshold) return 0;
      const sign = Math.sign(val);
      return sign * ((Math.abs(val) - threshold) / (1 - threshold));
    };

    // Standard W3C Gamepad Mapping:
    // Axes: 0: Left Stick X, 1: Left Stick Y, 2: Right Stick X, 3: Right Stick Y
    // Buttons: 0: A, 1: B, 2: X, 3: Y, 4: LB, 5: RB, 6: LT, 7: RT
    const steer = applyDeadzone(gp.axes[0] || 0);
    const lookX = applyDeadzone(gp.axes[2] || 0);
    const lookY = applyDeadzone(gp.axes[3] || 0);

    // Triggers (LT: axis or button 6, RT: axis or button 7)
    let throttle = 0;
    if (gp.buttons[7]) {
      throttle = gp.buttons[7].value;
    } else if (gp.axes[5] !== undefined) {
      // Direct raw axis fallback
      throttle = (gp.axes[5] + 1) / 2;
    }

    let brake = 0;
    if (gp.buttons[6]) {
      brake = gp.buttons[6].value;
    } else if (gp.axes[4] !== undefined) {
      brake = (gp.axes[4] + 1) / 2;
    }

    const handbrake = Boolean(gp.buttons[0]?.pressed);
    const reverse = Boolean(gp.buttons[2]?.pressed);
    const toggleCamera = Boolean(gp.buttons[3]?.pressed);

    if (toggleCamera && !this.lastCameraToggle) {
      this.onCameraToggleCallback?.();
    }
    this.lastCameraToggle = toggleCamera;

    return {
      connected: true,
      steer,
      throttle,
      brake,
      handbrake,
      reverse,
      toggleCamera,
      lookX,
      lookY,
    };
  }
}
