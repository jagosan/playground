export interface MandoHUDData {
  jetpackFuel: number;
  altitudeM: number;
  isJetpacking: boolean;
  visitedLandmarks: Readonly<Set<string>>;
  landmarks: readonly { id: string; name: string }[];
}

type MandoHUDCallbacks = {
  onJetpackStart?: () => void;
  onJetpackEnd?: () => void;
  onViewToggle?: () => void;
};

export class MandoHUD {
  private container: HTMLElement | null;
  private root: HTMLElement | null = null;
  private fuelBar: HTMLElement | null = null;
  private altitudeReadout: HTMLElement | null = null;
  private landmarkList: HTMLElement | null = null;
  private jetpackBtn: HTMLElement | null = null;
  private viewBtn: HTMLElement | null = null;
  private callbacks?: MandoHUDCallbacks;

  constructor(
    container: HTMLElement | null,
    callbacks?: MandoHUDCallbacks
  ) {
    this.container = container;
    this.callbacks = callbacks;

    if (typeof document === 'undefined' || !this.container) {
      return;
    }

    this.createRoot();
    this.createJetpackPanel();
    this.createLandmarks();
    this.createControlsHint();
    this.createTouchCluster();
  }

  private createRoot(): void {
    const root = document.createElement('div');
    root.id = 'mando-hud';
    root.className = '';
    this.container?.appendChild(root);
    this.root = root;
  }

  private createJetpackPanel(): void {
    if (!this.root) return;

    const panel = document.createElement('div');
    panel.className = 'mando-jetpack-panel';

    const fuelContainer = document.createElement('div');
    fuelContainer.className = 'mando-fuel-bar-container';

    this.fuelBar = document.createElement('div');
    this.fuelBar.className = 'mando-fuel-bar';
    this.fuelBar.style.width = '100%';
    fuelContainer.appendChild(this.fuelBar);

    this.altitudeReadout = document.createElement('div');
    this.altitudeReadout.className = 'mando-altitude-readout';
    this.altitudeReadout.textContent = 'ALT: 0.0m';

    panel.appendChild(fuelContainer);
    panel.appendChild(this.altitudeReadout);
    this.root.appendChild(panel);
  }

  private createLandmarks(): void {
    if (!this.root) return;

    const container = document.createElement('div');
    container.className = 'mando-landmarks';

    const title = document.createElement('h3');
    title.textContent = 'Landmarks';

    this.landmarkList = document.createElement('ul');

    container.appendChild(title);
    container.appendChild(this.landmarkList);
    this.root.appendChild(container);
  }

  private createControlsHint(): void {
    if (!this.root) return;

    const hint = document.createElement('div');
    hint.className = 'mando-controls-hint';

    hint.innerHTML = `
      <div><strong>SPACE</strong>: Jetpack</div>
      <div><strong>V</strong>: Toggle View</div>
    `;

    this.root.appendChild(hint);
  }

  private createTouchCluster(): void {
    if (!this.root) return;

    const cluster = document.createElement('div');
    cluster.className = 'mando-touch-cluster right';

    this.jetpackBtn = this.createTouchButton('[🚀 JET]', () => {
      this.callbacks?.onJetpackStart?.();
    });
    this.viewBtn = this.createTouchButton('[🎥 VIEW]', () => {
      this.callbacks?.onViewToggle?.();
    });

    cluster.appendChild(this.jetpackBtn);
    cluster.appendChild(this.viewBtn);
    this.root.appendChild(cluster);
  }

  private createTouchButton(label: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'mando-touch-btn';
    btn.textContent = label;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      onClick();
    });
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      onClick();
    });
    return btn;
  }

  public update(data: MandoHUDData): void {
    if (!this.root || typeof document === 'undefined') return;

    // Update fuel bar
    if (this.fuelBar) {
      const fuelPercent = Math.max(0, Math.min(100, data.jetpackFuel));
      this.fuelBar.style.width = `${fuelPercent}%`;
      
      // Low fuel warning (<20%)
      if (fuelPercent < 20) {
        this.fuelBar.classList.add('low-fuel');
      } else {
        this.fuelBar.classList.remove('low-fuel');
      }
    }

    // Update altitude readout
    if (this.altitudeReadout) {
      const altStr = `ALT: ${data.altitudeM.toFixed(1)}m`;
      this.altitudeReadout.textContent = altStr;

      // Warning class for very low altitude
      if (data.altitudeM < 5) {
        this.altitudeReadout.classList.add('warning');
      } else {
        this.altitudeReadout.classList.remove('warning');
      }
    }

    // Update landmark checklist
    if (this.landmarkList && data.landmarks.length > 0) {
      this.landmarkList.innerHTML = '';

      const visitedCount = data.visitedLandmarks.size;
      const totalCount = data.landmarks.length;

      for (const landmark of data.landmarks) {
        const li = document.createElement('li');
        li.textContent = landmark.name;
        
        if (data.visitedLandmarks.has(landmark.id)) {
          li.classList.add('mando-landmark-checked');
        }

        this.landmarkList.appendChild(li);
      }
    }
  }

  public toggleVisibility(): boolean {
    if (!this.root) return false;

    const isHidden = this.root.classList.toggle('is-hidden');
    return !isHidden;
  }

  public dispose(): void {
    if (this.root && this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.root = null;
    this.fuelBar = null;
    this.altitudeReadout = null;
    this.landmarkList = null;
    this.jetpackBtn = null;
    this.viewBtn = null;
  }
}
