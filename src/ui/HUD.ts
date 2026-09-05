import { EventBus } from '../engine/Events';

export class HUD {
  private container: HTMLElement;
  private promptBanner: HTMLElement;
  private questBox: HTMLElement;
  private controlsBox: HTMLElement;
  private crosshair: HTMLElement;
  private transitionModal: HTMLElement;
  private focusedEquipment: { id: string; name: string; minigameId: string } | null = null;
  private onVirtualKey?: (code: string, isDown: boolean) => void;

  constructor(eventBus: EventBus, onVirtualKey?: (code: string, isDown: boolean) => void) {
    this.onVirtualKey = onVirtualKey;
    this.container = document.createElement('div');
    this.container.id = 'hud-container';
    this.container.style.position = 'fixed';
    this.container.style.inset = '0';
    this.container.style.pointerEvents = 'none';
    this.container.style.userSelect = 'none';
    (this.container.style as any).webkitUserSelect = 'none';
    this.container.style.fontFamily = '"Courier New", Courier, monospace';
    this.container.style.color = '#ffffff';
    document.body.appendChild(this.container);

    // Crosshair
    this.crosshair = document.createElement('div');
    this.crosshair.style.position = 'absolute';
    this.crosshair.style.top = '50%';
    this.crosshair.style.left = '50%';
    this.crosshair.style.width = '8px';
    this.crosshair.style.height = '8px';
    this.crosshair.style.backgroundColor = '#ffffff';
    this.crosshair.style.borderRadius = '50%';
    this.crosshair.style.transform = 'translate(-50%, -50%)';
    this.crosshair.style.opacity = '0.7';
    this.crosshair.style.boxShadow = '0 0 4px #000';
    this.container.appendChild(this.crosshair);

    // Top-left: Quest & Level
    this.questBox = document.createElement('div');
    this.questBox.style.position = 'absolute';
    this.questBox.style.top = '12px';
    this.questBox.style.left = '12px';
    this.questBox.style.padding = '8px 12px';
    this.questBox.style.backgroundColor = 'rgba(15, 23, 42, 0.85)';
    this.questBox.style.border = '2px solid #3b82f6';
    this.questBox.style.borderRadius = '6px';
    this.questBox.style.fontSize = '12px';
    this.questBox.style.lineHeight = '1.4';
    this.questBox.innerHTML = `
      <div style="font-weight: bold; color: #60a5fa; margin-bottom: 2px;">🎮 PLAYGROUND LOBBY</div>
      <div id="quest-level" style="color: #fbbf24;">Level: 1</div>
      <div id="quest-objective" style="color: #e2e8f0; font-size: 11px;">Exploring the grounds...</div>
      <div id="quest-progress" style="color: #94a3b8; font-size: 10px; margin-top: 2px;">Discovered: 0 / 4</div>
    `;
    this.container.appendChild(this.questBox);

    // Top-right: Controls Box (Desktop)
    this.controlsBox = document.createElement('div');
    this.controlsBox.id = 'lobby-desktop-controls';
    this.controlsBox.style.position = 'absolute';
    this.controlsBox.style.top = '12px';
    this.controlsBox.style.right = '12px';
    this.controlsBox.style.padding = '8px 12px';
    this.controlsBox.style.backgroundColor = 'rgba(15, 23, 42, 0.85)';
    this.controlsBox.style.border = '2px solid #64748b';
    this.controlsBox.style.borderRadius = '6px';
    this.controlsBox.style.fontSize = '11px';
    this.controlsBox.style.lineHeight = '1.4';
    this.controlsBox.innerHTML = `
      <div style="font-weight: bold; color: #94a3b8; margin-bottom: 2px;">CONTROLS</div>
      <div><span style="color: #38bdf8;">WASD / Arrows</span> : Move</div>
      <div><span style="color: #38bdf8;">Drag / Touch</span> : Look</div>
      <div><span style="color: #38bdf8;">Space</span> : Jump | <span style="color: #38bdf8;">V</span> : View</div>
      <div><span style="color: #eab308;">E</span> : Play Minigame</div>
    `;
    this.container.appendChild(this.controlsBox);

    // Bottom banner: Interaction prompt (Clickable / Tappable)
    this.promptBanner = document.createElement('div');
    this.promptBanner.id = 'lobby-prompt-banner';
    this.promptBanner.style.position = 'absolute';
    this.promptBanner.style.bottom = '90px';
    this.promptBanner.style.left = '50%';
    this.promptBanner.style.transform = 'translateX(-50%)';
    this.promptBanner.style.padding = '10px 20px';
    this.promptBanner.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
    this.promptBanner.style.border = '2px solid #eab308';
    this.promptBanner.style.borderRadius = '8px';
    this.promptBanner.style.fontSize = '14px';
    this.promptBanner.style.fontWeight = 'bold';
    this.promptBanner.style.color = '#fef08a';
    this.promptBanner.style.textAlign = 'center';
    this.promptBanner.style.cursor = 'pointer';
    this.promptBanner.style.pointerEvents = 'auto';
    this.promptBanner.style.display = 'none';
    this.promptBanner.style.boxShadow = '0 4px 12px rgba(0,0,0,0.6)';
    this.promptBanner.addEventListener('click', () => {
      if (this.focusedEquipment) {
        eventBus.emit('TRANSITION_TO_MINIGAME', {
          minigameId: this.focusedEquipment.minigameId,
          equipmentId: this.focusedEquipment.id,
          name: this.focusedEquipment.name,
        });
      }
    });
    this.container.appendChild(this.promptBanner);

    // Minigame modal placeholder (for generic / future minigames)
    this.transitionModal = document.createElement('div');
    this.transitionModal.style.position = 'absolute';
    this.transitionModal.style.top = '50%';
    this.transitionModal.style.left = '50%';
    this.transitionModal.style.transform = 'translate(-50%, -50%)';
    this.transitionModal.style.padding = '24px 32px';
    this.transitionModal.style.backgroundColor = '#090d16';
    this.transitionModal.style.border = '3px solid #10b981';
    this.transitionModal.style.borderRadius = '8px';
    this.transitionModal.style.textAlign = 'center';
    this.transitionModal.style.display = 'none';
    this.transitionModal.style.pointerEvents = 'auto';
    this.container.appendChild(this.transitionModal);

    // Mobile Virtual Touch D-Pad & Actions
    this.setupMobileLobbyControls(eventBus);
    this.bindEvents(eventBus);
  }

  private setupMobileLobbyControls(eventBus: EventBus): void {
    const mobileContainer = document.createElement('div');
    mobileContainer.id = 'mobile-lobby-controls';
    mobileContainer.style.position = 'absolute';
    mobileContainer.style.bottom = '16px';
    mobileContainer.style.left = '0';
    mobileContainer.style.right = '0';
    mobileContainer.style.display = 'flex';
    mobileContainer.style.justifyContent = 'space-between';
    mobileContainer.style.padding = '0 16px';
    mobileContainer.style.pointerEvents = 'none';

    mobileContainer.innerHTML = `
      <!-- Virtual D-Pad (Walk) -->
      <div style="display: grid; grid-template-columns: repeat(3, 44px); grid-template-rows: repeat(3, 44px); gap: 4px; pointer-events: auto;">
        <div></div>
        <button id="lobby-dpad-up" style="background: rgba(15, 23, 42, 0.85); border: 2px solid #3b82f6; color: #fff; font-size: 18px; border-radius: 8px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">▲</button>
        <div></div>
        <button id="lobby-dpad-left" style="background: rgba(15, 23, 42, 0.85); border: 2px solid #3b82f6; color: #fff; font-size: 18px; border-radius: 8px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">◀</button>
        <div></div>
        <button id="lobby-dpad-right" style="background: rgba(15, 23, 42, 0.85); border: 2px solid #3b82f6; color: #fff; font-size: 18px; border-radius: 8px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">▶</button>
        <div></div>
        <button id="lobby-dpad-down" style="background: rgba(15, 23, 42, 0.85); border: 2px solid #3b82f6; color: #fff; font-size: 18px; border-radius: 8px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">▼</button>
        <div></div>
      </div>

      <!-- Action Buttons (Jump, View, Play) -->
      <div style="display: flex; gap: 8px; align-items: flex-end; pointer-events: auto;">
        <button id="lobby-btn-view" style="width: 46px; height: 46px; background: rgba(15, 23, 42, 0.85); border: 2px solid #64748b; color: #94a3b8; font-size: 12px; font-weight: bold; border-radius: 23px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">
          VIEW
        </button>
        <button id="lobby-btn-jump" style="width: 52px; height: 52px; background: rgba(30, 58, 138, 0.85); border: 2px solid #3b82f6; color: #ffffff; font-size: 11px; font-weight: bold; border-radius: 26px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">
          JUMP
        </button>
        <button id="lobby-btn-play" style="width: 56px; height: 56px; background: rgba(202, 138, 4, 0.9); border: 2px solid #eab308; color: #000; font-size: 13px; font-weight: bold; border-radius: 28px; cursor: pointer; touch-action: manipulation; display: flex; align-items: center; justify-content: center;">
          PLAY
        </button>
      </div>
    `;

    this.container.appendChild(mobileContainer);

    const bindTouchKey = (id: string, code: string) => {
      const el = mobileContainer.querySelector(id) as HTMLElement | null;
      if (!el || !this.onVirtualKey) return;

      const down = (e: Event) => {
        e.preventDefault();
        this.onVirtualKey!(code, true);
        el.style.opacity = '0.6';
      };
      const up = (e: Event) => {
        e.preventDefault();
        this.onVirtualKey!(code, false);
        el.style.opacity = '1.0';
      };

      el.addEventListener('touchstart', down, { passive: false });
      el.addEventListener('touchend', up, { passive: false });
      el.addEventListener('mousedown', down);
      el.addEventListener('mouseup', up);
      el.addEventListener('mouseleave', up);
    };

    bindTouchKey('#lobby-dpad-up', 'KeyW');
    bindTouchKey('#lobby-dpad-down', 'KeyS');
    bindTouchKey('#lobby-dpad-left', 'KeyA');
    bindTouchKey('#lobby-dpad-right', 'KeyD');
    bindTouchKey('#lobby-btn-jump', 'Space');

    const viewBtn = mobileContainer.querySelector('#lobby-btn-view') as HTMLElement | null;
    viewBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.onVirtualKey) {
        this.onVirtualKey('KeyV', true);
        setTimeout(() => this.onVirtualKey?.('KeyV', false), 50);
      }
    });

    const playBtn = mobileContainer.querySelector('#lobby-btn-play') as HTMLElement | null;
    playBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.focusedEquipment) {
        eventBus.emit('TRANSITION_TO_MINIGAME', {
          minigameId: this.focusedEquipment.minigameId,
          equipmentId: this.focusedEquipment.id,
          name: this.focusedEquipment.name,
        });
      }
    });
  }

  private bindEvents(eventBus: EventBus): void {
    eventBus.on('EQUIPMENT_FOCUSED', ({ id, name, minigameId, distance }) => {
      this.focusedEquipment = { id, name, minigameId };
      this.promptBanner.innerHTML = `
        <span>Press <span style="background: #eab308; color: #000; padding: 2px 6px; border-radius: 3px;">[E]</span> or <strong>TAP HERE</strong> to play <strong>${name}</strong> (${distance.toFixed(1)}m)</span>
      `;
      this.promptBanner.style.display = 'block';

      // Highlight the mobile PLAY button
      const playBtn = document.getElementById('lobby-btn-play');
      if (playBtn) {
        playBtn.style.animation = 'pulse 1s infinite';
        playBtn.style.boxShadow = '0 0 12px #eab308';
      }
    });

    eventBus.on('EQUIPMENT_UNFOCUSED', () => {
      this.focusedEquipment = null;
      this.promptBanner.style.display = 'none';

      const playBtn = document.getElementById('lobby-btn-play');
      if (playBtn) {
        playBtn.style.animation = 'none';
        playBtn.style.boxShadow = 'none';
      }
    });

    eventBus.on('QUEST_UPDATED', ({ objective, level, completed, total }) => {
      const lvl = document.getElementById('quest-level');
      const obj = document.getElementById('quest-objective');
      const prog = document.getElementById('quest-progress');
      if (lvl) lvl.textContent = `Level: ${level}`;
      if (obj) obj.textContent = objective;
      if (prog) prog.textContent = `Discovered: ${completed} / ${total}`;
    });

    eventBus.on('TRANSITION_TO_MINIGAME', ({ name, minigameId }) => {
      if (minigameId === 'moon-buggy') {
        // Direct launch, do not show mock modal
        return;
      }
      this.transitionModal.innerHTML = `
        <h2 style="color: #34d399; margin: 0 0 12px 0;">Entering: ${name}</h2>
        <p style="color: #94a3b8; font-size: 14px; margin-bottom: 20px;">Minigame chunk: <code>${minigameId}</code></p>
        <button id="close-modal" style="background: #10b981; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; font-family: inherit;">Return to Lobby</button>
      `;
      this.transitionModal.style.display = 'block';
      const btn = document.getElementById('close-modal');
      if (btn) {
        btn.onclick = () => {
          this.transitionModal.style.display = 'none';
          eventBus.emit('TRANSITION_TO_LOBBY', { reason: 'player_returned' });
        };
      }
    });

    eventBus.on('TRANSITION_TO_LOBBY', () => {
      this.transitionModal.style.display = 'none';
    });
  }

  public destroy(): void {
    this.container.remove();
  }
}
