import { MoonRover } from './MoonRover';

export class MoonBuggyHUD {
  private container: HTMLDivElement;
  private speedEl: HTMLElement;
  private statusEl: HTMLElement;
  private onExitCallback: () => void;

  constructor(onExit: () => void) {
    this.onExitCallback = onExit;
    this.container = document.createElement('div');
    this.container.id = 'moon-buggy-hud';
    this.container.style.position = 'absolute';
    this.container.style.top = '0';
    this.container.style.left = '0';
    this.container.style.width = '100%';
    this.container.style.height = '100%';
    this.container.style.pointerEvents = 'none';
    this.container.style.fontFamily = '"Courier New", Courier, monospace';
    this.container.style.color = '#38bdf8'; // NASA Apollo cyan/blue telemetry
    this.container.style.textShadow = '0 0 4px rgba(56, 189, 248, 0.6)';
    this.container.style.zIndex = '50';

    this.container.innerHTML = `
      <div style="position: absolute; top: 16px; left: 16px; background: rgba(15, 23, 42, 0.85); border: 2px solid #0284c7; padding: 12px 18px; border-radius: 4px; pointer-events: auto;">
        <div style="font-size: 14px; font-weight: bold; letter-spacing: 2px; color: #bae6fd; margin-bottom: 6px;">
          LUNAR ROVER LRV-01
        </div>
        <div style="font-size: 12px; color: #94a3b8;">
          LOCATION: <span style="color: #f8fafc;">MARE TRANQUILLITATIS</span>
        </div>
        <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">
          GRAVITY: <span id="lrv-grav" style="color: #4ade80;">1.62 m/s² (0.166G)</span>
        </div>
        <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">
          SPEED: <span id="lrv-speed" style="color: #fbbf24; font-size: 15px; font-weight: bold;">0 KM/H</span>
        </div>
        <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">
          STATUS: <span id="lrv-status" style="color: #38bdf8;">GROUND CONTACT</span>
        </div>
        <button id="lrv-exit-btn" style="margin-top: 10px; background: #dc2626; color: #ffffff; border: 1px solid #ef4444; padding: 4px 10px; font-size: 11px; cursor: pointer; font-family: inherit; font-weight: bold; border-radius: 2px;">
          [ESC] RETURN TO LOBBY
        </button>
      </div>

      <div style="position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); background: rgba(15, 23, 42, 0.8); border: 1px solid #334155; padding: 8px 16px; border-radius: 4px; font-size: 12px; color: #cbd5e1; text-align: center;">
        [W / ↑] ACCELERATE &nbsp;|&nbsp; [S / ↓] REVERSE &nbsp;|&nbsp; [A / D / ← / →] STEER &nbsp;|&nbsp; [SPACE] BRAKE
      </div>
    `;

    document.body.appendChild(this.container);

    this.speedEl = this.container.querySelector('#lrv-speed') as HTMLElement;
    this.statusEl = this.container.querySelector('#lrv-status') as HTMLElement;

    const exitBtn = this.container.querySelector('#lrv-exit-btn') as HTMLButtonElement;
    exitBtn?.addEventListener('click', () => {
      this.onExitCallback();
    });
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
