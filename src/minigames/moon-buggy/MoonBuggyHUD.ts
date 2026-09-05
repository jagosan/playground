import { MoonRover } from './MoonRover';

export class MoonBuggyHUD {
  private container: HTMLDivElement;
  private speedEl: HTMLElement;
  private statusEl: HTMLElement;
  private onExitCallback: () => void;
  private rover: MoonRover;

  constructor(rover: MoonRover, onExit: () => void) {
    this.rover = rover;
    this.onExitCallback = onExit;
    this.container = document.createElement('div');
    this.container.id = 'moon-buggy-hud';
    this.container.style.position = 'fixed';
    this.container.style.inset = '0';
    this.container.style.pointerEvents = 'none';
    this.container.style.fontFamily = '"Courier New", Courier, monospace';
    this.container.style.color = '#38bdf8'; // NASA Apollo cyan/blue telemetry
    this.container.style.textShadow = '0 0 4px rgba(56, 189, 248, 0.6)';
    this.container.style.zIndex = '50';
    this.container.style.userSelect = 'none';
    (this.container.style as any).webkitUserSelect = 'none';

    this.container.innerHTML = `
      <!-- Cockpit Telemetry Box -->
      <div style="position: absolute; top: 12px; left: 12px; background: rgba(15, 23, 42, 0.9); border: 2px solid #0284c7; padding: 10px 14px; border-radius: 6px; pointer-events: auto; max-width: 90vw;">
        <div style="font-size: 13px; font-weight: bold; letter-spacing: 1.5px; color: #bae6fd; margin-bottom: 4px;">
          LUNAR ROVER LRV-01
        </div>
        <div style="font-size: 11px; color: #94a3b8;">
          LOCATION: <span style="color: #f8fafc;">MARE TRANQUILLITATIS</span>
        </div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">
          GRAVITY: <span id="lrv-grav" style="color: #4ade80;">1.62 m/s² (0.166G)</span>
        </div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">
          SPEED: <span id="lrv-speed" style="color: #fbbf24; font-size: 14px; font-weight: bold;">0 KM/H</span>
        </div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">
          STATUS: <span id="lrv-status" style="color: #38bdf8;">GROUND CONTACT</span>
        </div>
        <button id="lrv-exit-btn" style="margin-top: 8px; background: #dc2626; color: #ffffff; border: 1px solid #ef4444; padding: 6px 12px; font-size: 11px; cursor: pointer; font-family: inherit; font-weight: bold; border-radius: 4px; pointer-events: auto;">
          [ESC] RETURN TO LOBBY
        </button>
      </div>

      <!-- Desktop Controls Guide (hidden on small phones) -->
      <div id="desktop-controls-hint" style="position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); background: rgba(15, 23, 42, 0.85); border: 1px solid #334155; padding: 6px 14px; border-radius: 4px; font-size: 11px; color: #cbd5e1; text-align: center; white-space: nowrap;">
        [W / ↑] ACCEL &nbsp;|&nbsp; [S / ↓] REVERSE &nbsp;|&nbsp; [A / D / ← / →] STEER &nbsp;|&nbsp; [SPACE] BRAKE
      </div>

      <!-- Mobile Touch Controls Overlay -->
      <div id="mobile-buggy-controls" style="position: absolute; bottom: 16px; left: 0; right: 0; display: flex; justify-content: space-between; padding: 0 16px; pointer-events: none;">
        <!-- Steering Left / Right -->
        <div style="display: flex; gap: 12px; pointer-events: auto;">
          <button id="btn-steer-left" style="width: 58px; height: 58px; background: rgba(15, 23, 42, 0.85); border: 2px solid #0284c7; color: #bae6fd; font-size: 24px; font-weight: bold; border-radius: 12px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">
            ◀
          </button>
          <button id="btn-steer-right" style="width: 58px; height: 58px; background: rgba(15, 23, 42, 0.85); border: 2px solid #0284c7; color: #bae6fd; font-size: 24px; font-weight: bold; border-radius: 12px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">
            ▶
          </button>
        </div>

        <!-- Throttle / Reverse / Brake -->
        <div style="display: flex; gap: 10px; align-items: flex-end; pointer-events: auto;">
          <button id="btn-handbrake" style="width: 52px; height: 52px; background: rgba(185, 28, 28, 0.85); border: 2px solid #ef4444; color: #ffffff; font-size: 11px; font-weight: bold; border-radius: 12px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">
            STOP
          </button>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <button id="btn-forward" style="width: 58px; height: 54px; background: rgba(16, 185, 129, 0.85); border: 2px solid #34d399; color: #ffffff; font-size: 22px; font-weight: bold; border-radius: 12px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">
              ▲
            </button>
            <button id="btn-backward" style="width: 58px; height: 54px; background: rgba(15, 23, 42, 0.85); border: 2px solid #0284c7; color: #bae6fd; font-size: 22px; font-weight: bold; border-radius: 12px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">
              ▼
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(this.container);

    this.speedEl = this.container.querySelector('#lrv-speed') as HTMLElement;
    this.statusEl = this.container.querySelector('#lrv-status') as HTMLElement;

    const exitBtn = this.container.querySelector('#lrv-exit-btn') as HTMLButtonElement;
    exitBtn?.addEventListener('click', () => {
      this.onExitCallback();
    });

    this.setupTouchButtons();
  }

  private setupTouchButtons(): void {
    const bindTouch = (btnId: string, onDown: () => void, onUp: () => void) => {
      const el = this.container.querySelector(btnId) as HTMLElement | null;
      if (!el) return;

      const handlePress = (e: Event) => {
        e.preventDefault();
        onDown();
        el.style.opacity = '0.6';
        el.style.transform = 'scale(0.95)';
      };

      const handleRelease = (e: Event) => {
        e.preventDefault();
        onUp();
        el.style.opacity = '1.0';
        el.style.transform = 'scale(1.0)';
      };

      el.addEventListener('touchstart', handlePress, { passive: false });
      el.addEventListener('touchend', handleRelease, { passive: false });
      el.addEventListener('touchcancel', handleRelease, { passive: false });
      el.addEventListener('mousedown', handlePress);
      el.addEventListener('mouseup', handleRelease);
      el.addEventListener('mouseleave', handleRelease);
    };

    bindTouch(
      '#btn-steer-left',
      () => this.rover.setControl('left', true),
      () => this.rover.setControl('left', false)
    );
    bindTouch(
      '#btn-steer-right',
      () => this.rover.setControl('right', true),
      () => this.rover.setControl('right', false)
    );
    bindTouch(
      '#btn-forward',
      () => this.rover.setControl('forward', true),
      () => this.rover.setControl('forward', false)
    );
    bindTouch(
      '#btn-backward',
      () => this.rover.setControl('backward', true),
      () => this.rover.setControl('backward', false)
    );
    bindTouch(
      '#btn-handbrake',
      () => this.rover.setControl('handbrake', true),
      () => this.rover.setControl('handbrake', false)
    );
  }

  public update(rover: MoonRover): void {
    if (this.speedEl) {
      this.speedEl.textContent = `${rover.getSpeedKmh()} KM/H`;
    }
    if (this.statusEl) {
      if (rover.isGrounded) {
        this.statusEl.textContent = 'GROUND CONTACT';
        this.statusEl.style.color = '#38bdf8';
      } else {
        this.statusEl.textContent = 'LOW-G FLIGHT (AIRBORNE)';
        this.statusEl.style.color = '#f43f5e';
      }
    }
  }

  public destroy(): void {
    this.container.remove();
  }
}
