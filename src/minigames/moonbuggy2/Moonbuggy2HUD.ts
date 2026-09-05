import { LRVPhysics } from './LRVPhysics';
import { GamepadState } from './GamepadController';

export class Moonbuggy2HUD {
  private container: HTMLDivElement;
  private speedEl: HTMLElement;
  private statusEl: HTMLElement;
  private gamepadIndicator: HTMLElement;
  private cameraModeEl: HTMLElement;
  private onExitCallback: () => void;
  private onToggleCamCallback: () => void;

  constructor(onExit: () => void, onToggleCamera: () => void) {
    this.onExitCallback = onExit;
    this.onToggleCamCallback = onToggleCamera;

    this.container = document.createElement('div');
    this.container.id = 'moonbuggy2-hud';
    this.container.style.position = 'fixed';
    this.container.style.inset = '0';
    this.container.style.pointerEvents = 'none';
    this.container.style.fontFamily = '"Courier New", Courier, monospace';
    this.container.style.color = '#38bdf8';
    this.container.style.textShadow = '0 0 5px rgba(56, 189, 248, 0.65)';
    this.container.style.zIndex = '60';
    this.container.style.userSelect = 'none';
    (this.container.style as any).webkitUserSelect = 'none';

    this.container.innerHTML = `
      <!-- Top Left: High-Fidelity LRV Cockpit Telemetry -->
      <div style="position: absolute; top: 14px; left: 14px; background: rgba(10, 15, 29, 0.92); border: 2px solid #0284c7; padding: 12px 18px; border-radius: 6px; pointer-events: auto; max-width: 88vw; box-shadow: 0 4px 16px rgba(0,0,0,0.8);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="font-size: 13px; font-weight: bold; letter-spacing: 2px; color: #bae6fd;">APOLLO LRV-02 SIM</span>
          <span id="lrv2-gp-tag" style="font-size: 10px; background: #334155; color: #94a3b8; padding: 2px 6px; border-radius: 3px; font-weight: bold;">KB/TOUCH</span>
        </div>
        <div style="font-size: 11px; color: #94a3b8;">
          SITE: <span style="color: #f8fafc;">HADLEY RILLE / APENNINES</span>
        </div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 3px;">
          GRAVITY: <span style="color: #4ade80;">1.622 m/s² (0.166 G)</span>
        </div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 3px;">
          SPEED: <span id="lrv2-speed" style="color: #fbbf24; font-size: 15px; font-weight: bold;">0 KM/H</span>
        </div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 3px;">
          FLIGHT: <span id="lrv2-status" style="color: #38bdf8;">SURFACE CONTACT</span>
        </div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 3px;">
          CAM: <span id="lrv2-cam-mode" style="color: #c084fc;">CHASE CAMERA</span>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 10px;">
          <button id="lrv2-cam-btn" style="background: #1e293b; color: #bae6fd; border: 1px solid #0284c7; padding: 5px 10px; font-size: 10px; cursor: pointer; font-family: inherit; font-weight: bold; border-radius: 4px;">
            [C] CAMERA
          </button>
          <button id="lrv2-exit-btn" style="background: #dc2626; color: #ffffff; border: 1px solid #ef4444; padding: 5px 10px; font-size: 10px; cursor: pointer; font-family: inherit; font-weight: bold; border-radius: 4px;">
            [ESC] LOBBY
          </button>
        </div>
      </div>

      <!-- Top Right: GPD Win Max 2 / Gamepad Mapping Legend -->
      <div id="lrv2-controls-legend" style="position: absolute; top: 14px; right: 14px; background: rgba(10, 15, 29, 0.88); border: 1px solid #334155; padding: 10px 14px; border-radius: 6px; font-size: 10px; line-height: 1.5; color: #94a3b8; text-align: right;">
        <div style="font-weight: bold; color: #38bdf8; margin-bottom: 2px;">GPD WIN MAX 2 CONTROLS</div>
        <div><strong style="color: #e2e8f0;">RT / W</strong> : Throttle &nbsp;|&nbsp; <strong style="color: #e2e8f0;">LT / S</strong> : Brake</div>
        <div><strong style="color: #e2e8f0;">Left Stick / A-D</strong> : Proportional Steer</div>
        <div><strong style="color: #e2e8f0;">Button A / Space</strong> : Handbrake</div>
        <div><strong style="color: #e2e8f0;">Button X / R</strong> : Reverse Gear</div>
        <div><strong style="color: #e2e8f0;">Button Y / C</strong> : Toggle Cockpit Cam</div>
      </div>
    `;

    document.body.appendChild(this.container);

    this.speedEl = this.container.querySelector('#lrv2-speed') as HTMLElement;
    this.statusEl = this.container.querySelector('#lrv2-status') as HTMLElement;
    this.gamepadIndicator = this.container.querySelector('#lrv2-gp-tag') as HTMLElement;
    this.cameraModeEl = this.container.querySelector('#lrv2-cam-mode') as HTMLElement;

    const exitBtn = this.container.querySelector('#lrv2-exit-btn') as HTMLButtonElement;
    exitBtn?.addEventListener('click', () => this.onExitCallback());

    const camBtn = this.container.querySelector('#lrv2-cam-btn') as HTMLButtonElement;
    camBtn?.addEventListener('click', () => this.onToggleCamCallback());
  }

  public update(physics: LRVPhysics, gamepad: GamepadState, cameraMode: 'chase' | 'cockpit'): void {
    if (this.speedEl) {
      this.speedEl.textContent = `${physics.getSpeedKmh()} KM/H`;
    }

    if (this.statusEl) {
      if (physics.isAirborne) {
        this.statusEl.textContent = 'LOW-G FLIGHT (AIRBORNE)';
        this.statusEl.style.color = '#f43f5e';
      } else {
        this.statusEl.textContent = 'SURFACE CONTACT';
        this.statusEl.style.color = '#38bdf8';
      }
    }

    if (this.gamepadIndicator) {
      if (gamepad.connected) {
        this.gamepadIndicator.textContent = 'GAMEPAD (XINPUT)';
        this.gamepadIndicator.style.background = '#15803d';
        this.gamepadIndicator.style.color = '#ffffff';
      } else {
        this.gamepadIndicator.textContent = 'KB/TOUCH';
        this.gamepadIndicator.style.background = '#334155';
        this.gamepadIndicator.style.color = '#94a3b8';
      }
    }

    if (this.cameraModeEl) {
      this.cameraModeEl.textContent = cameraMode === 'chase' ? 'CHASE CAMERA' : 'COCKPIT CAM';
    }
  }

  public destroy(): void {
    this.container.remove();
  }
}
