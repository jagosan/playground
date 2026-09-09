import { LRVPhysics } from './LRVPhysics';
import { GamepadState } from './GamepadController';

export interface HUDNotificationState {
  rockPrompt: boolean;
  dockingPrompt: boolean;
  dockingText?: string;
  compassDegrees: number;
  distanceToBase: number;
  hullDamage?: number;
  waveInfo?: string;
}

export class Moonbuggy2HUD {
  private container: HTMLDivElement;
  private speedEl: HTMLElement;
  private statusEl: HTMLElement;
  private gamepadIndicator: HTMLElement;
  private cameraModeEl: HTMLElement;
  private batteryBarEl: HTMLElement;
  private batteryPctEl: HTMLElement;
  private cargoEl: HTMLElement;
  private compassEl: HTMLElement;
  private damageEl!: HTMLElement;
  private waveEl!: HTMLElement;
  private promptBannerEl: HTMLElement;
  private dockingBannerEl: HTMLElement;
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
          <span style="font-size: 13px; font-weight: bold; letter-spacing: 2px; color: #bae6fd;">APOLLO LRV-02 SIM (SPEC 06)</span>
          <span id="lrv2-gp-tag" style="font-size: 10px; background: #334155; color: #94a3b8; padding: 2px 6px; border-radius: 3px; font-weight: bold;">KB/TOUCH</span>
        </div>
        <div style="font-size: 11px; color: #94a3b8;">
          SITE: <span style="color: #f8fafc;">HADLEY RILLE / APENNINES</span>
        </div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 3px;">
          SPEED: <span id="lrv2-speed" style="color: #fbbf24; font-size: 15px; font-weight: bold;">0.0 KM/H</span>
          <span style="font-size: 9px; color: #64748b; margin-left: 4px;">(25 KM/H MAX)</span>
        </div>
        
        <!-- Battery Gauge -->
        <div style="font-size: 11px; color: #94a3b8; margin-top: 5px;">
          POWER: <span id="lrv2-battery-pct" style="color: #4ade80; font-weight: bold;">100%</span>
          <div style="background: #1e293b; border: 1px solid #334155; border-radius: 3px; height: 7px; width: 140px; margin-top: 2px; overflow: hidden;">
            <div id="lrv2-battery-bar" style="background: #22c55e; height: 100%; width: 100%; transition: width 0.15s ease, background 0.3s ease;"></div>
          </div>
        </div>

        <!-- Cargo Payload Mass -->
        <div style="font-size: 11px; color: #94a3b8; margin-top: 5px;">
          CARGO: <span id="lrv2-cargo" style="color: #38bdf8; font-weight: bold;">0/8 ROCKS (+0 kg)</span>
        </div>

        <!-- Hull Damage -->
        <div style="font-size: 11px; color: #94a3b8; margin-top: 3px;">
          HULL DAMAGE: <span id="lrv2-damage" style="color: #4ade80; font-weight: bold;">0%</span>
        </div>

        <!-- Wave / Rivals -->
        <div style="font-size: 11px; color: #94a3b8; margin-top: 3px;">
          RUN: <span id="lrv2-wave" style="color: #f59e0b; font-weight: bold;">WAVE 1 (2 RIVALS ACTIVE)</span>
        </div>

        <!-- Base Compass -->
        <div style="font-size: 11px; color: #94a3b8; margin-top: 3px;">
          NAV BASE: <span id="lrv2-compass" style="color: #f472b6; font-weight: bold;">0m ▲ [0°]</span>
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

      <!-- Center Bottom Prompts -->
      <div id="lrv2-prompt-banner" style="display: none; position: absolute; bottom: 38px; left: 50%; transform: translateX(-50%); background: rgba(15, 23, 42, 0.95); border: 2px solid #38bdf8; padding: 10px 24px; border-radius: 6px; font-size: 14px; font-weight: bold; color: #f8fafc; text-align: center; box-shadow: 0 4px 20px rgba(56, 189, 248, 0.4);">
        [SPACE / BUTTON A] DEPLOY ROBOTIC ARM TO SAMPLE BASALT
      </div>

      <div id="lrv2-docking-banner" style="display: none; position: absolute; top: 72px; left: 50%; transform: translateX(-50%); background: rgba(6, 78, 59, 0.95); border: 2px solid #10b981; padding: 10px 24px; border-radius: 6px; font-size: 13px; font-weight: bold; color: #6ee7b7; text-align: center; box-shadow: 0 4px 20px rgba(16, 185, 129, 0.4);">
        SCIENCE DROP STATION: CHARGING POWER & UNLOADING CARGO
      </div>

      <!-- Top Right: GPD Win Max 2 / Gamepad Mapping Legend -->
      <div id="lrv2-controls-legend" style="position: absolute; top: 14px; right: 14px; background: rgba(10, 15, 29, 0.88); border: 1px solid #334155; padding: 10px 14px; border-radius: 6px; font-size: 10px; line-height: 1.5; color: #94a3b8; text-align: right;">
        <div style="font-weight: bold; color: #38bdf8; margin-bottom: 2px;">GPD WIN MAX 2 CONTROLS</div>
        <div><strong style="color: #e2e8f0;">RT / W</strong> : Throttle &nbsp;|&nbsp; <strong style="color: #e2e8f0;">LT / S</strong> : Brake</div>
        <div><strong style="color: #e2e8f0;">Left Stick / A-D</strong> : Proportional Steer</div>
        <div><strong style="color: #e2e8f0;">Button A / Space</strong> : Handbrake / Sample Rock</div>
        <div><strong style="color: #e2e8f0;">Button X / R</strong> : Reverse Gear</div>
        <div><strong style="color: #e2e8f0;">Button Y / C</strong> : Toggle Cockpit Cam</div>
      </div>
    `;

    document.body.appendChild(this.container);

    this.speedEl = this.container.querySelector('#lrv2-speed') as HTMLElement;
    this.statusEl = this.container.querySelector('#lrv2-status') as HTMLElement;
    this.gamepadIndicator = this.container.querySelector('#lrv2-gp-tag') as HTMLElement;
    this.cameraModeEl = this.container.querySelector('#lrv2-cam-mode') as HTMLElement;
    this.batteryBarEl = this.container.querySelector('#lrv2-battery-bar') as HTMLElement;
    this.batteryPctEl = this.container.querySelector('#lrv2-battery-pct') as HTMLElement;
    this.cargoEl = this.container.querySelector('#lrv2-cargo') as HTMLElement;
    this.damageEl = this.container.querySelector('#lrv2-damage') as HTMLElement;
    this.waveEl = this.container.querySelector('#lrv2-wave') as HTMLElement;
    this.compassEl = this.container.querySelector('#lrv2-compass') as HTMLElement;
    this.promptBannerEl = this.container.querySelector('#lrv2-prompt-banner') as HTMLElement;
    this.dockingBannerEl = this.container.querySelector('#lrv2-docking-banner') as HTMLElement;

    const exitBtn = this.container.querySelector('#lrv2-exit-btn') as HTMLButtonElement;
    exitBtn?.addEventListener('click', () => this.onExitCallback());

    const camBtn = this.container.querySelector('#lrv2-cam-btn') as HTMLButtonElement;
    camBtn?.addEventListener('click', () => this.onToggleCamCallback());
  }

  public update(
    physics: LRVPhysics,
    gamepad: GamepadState,
    cameraMode: 'chase' | 'cockpit',
    navState?: HUDNotificationState
  ): void {
    // 1. Speed
    if (this.speedEl) {
      const kmh = (Math.abs(physics.forwardSpeed) * 3.6).toFixed(1);
      this.speedEl.textContent = `${kmh} KM/H`;
    }

    // 2. Battery Bar
    if (this.batteryBarEl && this.batteryPctEl) {
      const pct = Math.round(physics.batteryLevel * 100);
      this.batteryPctEl.textContent = `${pct}%`;
      this.batteryBarEl.style.width = `${pct}%`;

      if (pct > 50) {
        this.batteryBarEl.style.background = '#22c55e';
        this.batteryPctEl.style.color = '#4ade80';
      } else if (pct > 20) {
        this.batteryBarEl.style.background = '#eab308';
        this.batteryPctEl.style.color = '#fde047';
      } else {
        this.batteryBarEl.style.background = '#ef4444';
        this.batteryPctEl.style.color = '#f87171';
      }
    }

    // 3. Cargo Rocks
    if (this.cargoEl) {
      const addedMass = physics.rockCount * physics.rockMass;
      this.cargoEl.textContent = `${physics.rockCount}/${physics.maxRocks} ROCKS (+${addedMass} kg)`;
    }

    // 3b. Hull Damage
    if (this.damageEl && navState && navState.hullDamage !== undefined) {
      const dmg = Math.round(navState.hullDamage);
      this.damageEl.textContent = `${dmg}%`;
      if (dmg < 25) {
        this.damageEl.style.color = '#4ade80';
      } else if (dmg < 65) {
        this.damageEl.style.color = '#facc15';
      } else {
        this.damageEl.style.color = '#ef4444';
      }
    }

    // 3c. Wave / Competitor status
    if (this.waveEl && navState && navState.waveInfo) {
      this.waveEl.textContent = navState.waveInfo;
    }

    // 4. Navigation Compass to Base (0, 0)
    if (this.compassEl && navState) {
      const dist = Math.round(navState.distanceToBase);
      const deg = Math.round(navState.compassDegrees);
      this.compassEl.textContent = `${dist}m ▲ [${deg}°]`;
    }

    // 5. Flight status
    if (this.statusEl) {
      if (physics.isAirborne) {
        this.statusEl.textContent = 'LOW-G FLIGHT (AIRBORNE)';
        this.statusEl.style.color = '#f43f5e';
      } else {
        this.statusEl.textContent = 'SURFACE CONTACT';
        this.statusEl.style.color = '#38bdf8';
      }
    }

    // 6. Gamepad tag
    if (this.gamepadIndicator) {
      if (gamepad.connected) {
        this.gamepadIndicator.textContent = `GAMEPAD: ${gamepad.rawDebug}`;
        this.gamepadIndicator.style.background = '#15803d';
        this.gamepadIndicator.style.color = '#ffffff';
      } else {
        this.gamepadIndicator.textContent = 'KB/TOUCH (PRESS ANY GP BTN)';
        this.gamepadIndicator.style.background = '#334155';
        this.gamepadIndicator.style.color = '#94a3b8';
      }
    }

    // 7. Camera mode
    if (this.cameraModeEl) {
      this.cameraModeEl.textContent = cameraMode === 'chase' ? 'CHASE CAMERA' : 'COCKPIT CAM';
    }

    // 8. Notifications
    if (this.promptBannerEl && navState) {
      this.promptBannerEl.style.display = navState.rockPrompt ? 'block' : 'none';
    }

    if (this.dockingBannerEl && navState) {
      this.dockingBannerEl.style.display = navState.dockingPrompt ? 'block' : 'none';
      if (navState.dockingText) {
        this.dockingBannerEl.textContent = navState.dockingText;
      }
    }
  }

  public destroy(): void {
    this.container.remove();
  }

  public dispose(): void {
    this.destroy();
  }
}
