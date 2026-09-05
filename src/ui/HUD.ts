import { EventBus } from '../engine/Events';

export class HUD {
  private container: HTMLElement;
  private promptBanner: HTMLElement;
  private questBox: HTMLElement;
  private controlsBox: HTMLElement;
  private crosshair: HTMLElement;
  private transitionModal: HTMLElement;

  constructor(eventBus: EventBus) {
    this.container = document.createElement('div');
    this.container.id = 'hud-container';
    this.container.style.position = 'fixed';
    this.container.style.inset = '0';
    this.container.style.pointerEvents = 'none';
    this.container.style.userSelect = 'none';
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
    this.questBox.style.top = '16px';
    this.questBox.style.left = '16px';
    this.questBox.style.padding = '10px 14px';
    this.questBox.style.backgroundColor = 'rgba(15, 23, 42, 0.85)';
    this.questBox.style.border = '2px solid #3b82f6';
    this.questBox.style.borderRadius = '4px';
    this.questBox.style.fontSize = '14px';
    this.questBox.style.lineHeight = '1.4';
    this.questBox.innerHTML = `
      <div style="font-weight: bold; color: #60a5fa; margin-bottom: 4px;">🎮 PLAYGROUND LOBBY</div>
      <div id="quest-level" style="color: #fbbf24;">Level: 1</div>
      <div id="quest-objective" style="color: #e2e8f0; font-size: 13px; margin-top: 2px;">Exploring the grounds...</div>
      <div id="quest-progress" style="color: #94a3b8; font-size: 11px; margin-top: 4px;">Discovered: 0 / 4</div>
    `;
    this.container.appendChild(this.questBox);

    // Top-right: Controls
    this.controlsBox = document.createElement('div');
    this.controlsBox.style.position = 'absolute';
    this.controlsBox.style.top = '16px';
    this.controlsBox.style.right = '16px';
    this.controlsBox.style.padding = '10px 14px';
    this.controlsBox.style.backgroundColor = 'rgba(15, 23, 42, 0.85)';
    this.controlsBox.style.border = '2px solid #64748b';
    this.controlsBox.style.borderRadius = '4px';
    this.controlsBox.style.fontSize = '12px';
    this.controlsBox.style.lineHeight = '1.5';
    this.controlsBox.innerHTML = `
      <div style="font-weight: bold; color: #94a3b8; margin-bottom: 4px;">CONTROLS</div>
      <div><span style="color: #38bdf8;">WASD / Arrows</span> : Move</div>
      <div><span style="color: #38bdf8;">Mouse Look</span> : Click to Lock</div>
      <div><span style="color: #38bdf8;">Space</span> : Jump | <span style="color: #38bdf8;">Shift</span> : Sprint</div>
      <div><span style="color: #38bdf8;">V</span> : Toggle 1st / 3rd Person</div>
      <div><span style="color: #eab308;">E</span> : Play Selected Minigame</div>
    `;
    this.container.appendChild(this.controlsBox);

    // Bottom banner: Interaction prompt
    this.promptBanner = document.createElement('div');
    this.promptBanner.style.position = 'absolute';
    this.promptBanner.style.bottom = '40px';
    this.promptBanner.style.left = '50%';
    this.promptBanner.style.transform = 'translateX(-50%)';
    this.promptBanner.style.padding = '12px 24px';
    this.promptBanner.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
    this.promptBanner.style.border = '2px solid #eab308';
    this.promptBanner.style.borderRadius = '6px';
    this.promptBanner.style.fontSize = '16px';
    this.promptBanner.style.fontWeight = 'bold';
    this.promptBanner.style.color = '#fef08a';
    this.promptBanner.style.textAlign = 'center';
    this.promptBanner.style.display = 'none';
    this.container.appendChild(this.promptBanner);

    // Minigame modal placeholder
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

    this.bindEvents(eventBus);
  }

  private bindEvents(eventBus: EventBus): void {
    eventBus.on('EQUIPMENT_FOCUSED', ({ name, distance }) => {
      this.promptBanner.innerHTML = `Press <span style="background: #eab308; color: #000; padding: 2px 6px; border-radius: 3px;">[E]</span> to play <strong>${name}</strong> (${distance.toFixed(1)}m)`;
      this.promptBanner.style.display = 'block';
    });

    eventBus.on('EQUIPMENT_UNFOCUSED', () => {
      this.promptBanner.style.display = 'none';
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
}
