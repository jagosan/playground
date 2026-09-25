import { EventBus } from '../engine/Events';

export class LunarFrontierOverlay {
  private container: HTMLElement;
  private iframe: HTMLIFrameElement | null = null;
  private statusBadge: HTMLElement;
  private pollIntervalId: number | null = null;
  private clientUrl: string;
  private eventBus: EventBus;

  constructor(eventBus: EventBus, config?: { clientUrl?: string }) {
    this.eventBus = eventBus;
    this.clientUrl = config?.clientUrl || `http://${window.location.hostname}:5174/`;

    this.container = document.createElement('div');
    this.container.id = 'lunar-frontier-overlay';
    this.container.style.position = 'fixed';
    this.container.style.inset = '0';
    this.container.style.zIndex = '100';
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';

    // Glassmorphic top navigation bar
    const navBar = document.createElement('div');
    navBar.style.height = '48px';
    navBar.style.background = 'rgba(15, 23, 42, 0.95)';
    navBar.style.borderBottom = '2px solid #06b6d4';
    navBar.style.display = 'flex';
    navBar.style.alignItems = 'center';
    navBar.style.padding = '0 16px';
    navBar.style.gap = '16px';

    // Return button
    const returnBtn = document.createElement('button');
    returnBtn.textContent = '◄ RETURN TO PLAYGROUND LOBBY';
    returnBtn.style.background = '#06b6d4';
    returnBtn.style.color = '#fff';
    returnBtn.style.border = 'none';
    returnBtn.style.padding = '8px 16px';
    returnBtn.style.borderRadius = '4px';
    returnBtn.style.cursor = 'pointer';
    returnBtn.style.fontWeight = 'bold';

    returnBtn.addEventListener('click', () => {
      this.eventBus.emit('TRANSITION_TO_LOBBY', { reason: 'return_button' });
    });

    // Status badge
    this.statusBadge = document.createElement('span');
    this.statusBadge.style.fontSize = '12px';
    this.statusBadge.style.color = '#94a3b8';

    navBar.appendChild(returnBtn);
    navBar.appendChild(this.statusBadge);

    // Iframe container
    const iframeContainer = document.createElement('div');
    iframeContainer.style.flex = '1';
    iframeContainer.style.position = 'relative';

    this.iframe = document.createElement('iframe');
    this.iframe.src = this.clientUrl;
    this.iframe.style.width = '100%';
    this.iframe.style.height = '100%';
    this.iframe.style.border = 'none';
    this.iframe.style.background = '#0f172a';

    iframeContainer.appendChild(this.iframe);

    this.container.appendChild(navBar);
    this.container.appendChild(iframeContainer);
    document.body.appendChild(this.container);

    // Setup keyboard listener
    this.setupKeyboardListener();

    // Start health polling
    this.startHealthPolling();
  }

  private setupKeyboardListener(): void {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.eventBus.emit('TRANSITION_TO_LOBBY', { reason: 'escape_key' });
      }
    };

    window.addEventListener('keydown', handler);

    // Store handler on container for cleanup
    (this.container as any).keyboardHandler = handler;
  }

  private startHealthPolling(): void {
    this.pollIntervalId = window.setInterval(async () => {
      try {
        const shardResponse = await fetch('http://127.0.0.1:3030/health', {
          method: 'GET',
          headers: { 'Cache-Control': 'no-cache' },
        });

        if (shardResponse.ok) {
          this.statusBadge.textContent = '🟢 SHARD ONLINE (3030)';
          return;
        }
      } catch {
        // Shard not reachable, check if client is available
        try {
          const clientResponse = await fetch(this.clientUrl, {
            method: 'HEAD',
            cache: 'no-cache',
          });

          if (clientResponse.ok) {
            this.statusBadge.textContent = '🟡 CLIENT ONLINE';
            return;
          }
        } catch {
          // Both offline
          this.statusBadge.textContent = '🔴 OFFLINE';
        }
      }
    }, 5000);
  }

  public async checkShardHealth(): Promise<{ online: boolean; clientOnline: boolean }> {
    try {
      const shardResponse = await fetch('http://127.0.0.1:3030/health', {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (shardResponse.ok) {
        this.statusBadge.textContent = '🟢 SHARD ONLINE (3030)';
        return { online: true, clientOnline: true };
      }
    } catch {
      // Shard not reachable, check if client is available
      try {
        const clientResponse = await fetch(this.clientUrl, {
          method: 'HEAD',
          cache: 'no-cache',
        });

        if (clientResponse.ok) {
          this.statusBadge.textContent = '🟡 CLIENT ONLINE';
          return { online: false, clientOnline: true };
        }
      } catch {
        // Both offline
        this.statusBadge.textContent = '🔴 OFFLINE';
      }
    }

    return { online: false, clientOnline: false };
  }

  public destroy(): void {
    if (this.pollIntervalId !== null) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }

    // Remove keyboard listener
    const handler = (this.container as any).keyboardHandler;
    if (handler) {
      window.removeEventListener('keydown', handler);
    }

    // Remove iframe and container
    if (this.iframe) {
      this.iframe.src = 'about:blank';
      this.iframe.remove();
      this.iframe = null;
    }

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  }
}
