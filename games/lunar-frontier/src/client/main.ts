/**
 * Lunar Frontier — browser entry point (Spec 13 §1/§5, TASK-PLAY-054).
 *
 * Wires the `#scene` canvas + `#lunar-hud` overlay declared by
 * `src/client/index.html` into a running `ClientApp`, plus the Vite-friendly
 * niceties: loading overlay, resize handling, and HMR teardown so editing
 * the client in dev does not stack render loops.
 *
 * Identity resolution (all optional, in precedence order):
 *   1. `window.LF_CONFIG = { username, faction, role, wsUrl }` in index.html
 *   2. `?user=…&faction=` query string
 *   3. `prospect-<4 hex>` / 'unaffiliated'
 *
 * Run (dev):   npx vite --root games/lunar-frontier   →  /src/client/index.html
 * Build:       npx vite build --root games/lunar-frontier
 */

import '../ui/hud.css';
import { ClientApp } from './ClientApp.ts';

interface LunarFrontierConfig {
  username?: string;
  faction?: string;
  role?: string;
  /** Explicit ws(s):// endpoint; else NetworkClient auto-detects (§6). */
  wsUrl?: string;
  seed?: string;
}

function readConfig(): LunarFrontierConfig {
  const injected = (globalThis as { LF_CONFIG?: LunarFrontierConfig }).LF_CONFIG ?? {};
  const params =
    typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  return {
    username: injected.username ?? params?.get('user') ?? undefined,
    faction: injected.faction ?? params?.get('faction') ?? undefined,
    role: injected.role ?? params?.get('role') ?? undefined,
    wsUrl: injected.wsUrl ?? params?.get('ws') ?? undefined,
    seed: injected.seed ?? params?.get('seed') ?? undefined,
  };
}

function boot(): ClientApp | null {
  const doc = document;
  const canvas = doc.getElementById('scene') as HTMLCanvasElement | null;
  if (canvas === null) {
    failToPage('index.html is missing its <canvas id="scene">');
    return null;
  }

  const config = readConfig();
  const app = new ClientApp({
    username: config.username ?? `prospect-${Math.random().toString(16).slice(2, 6)}`,
    faction: config.faction ?? 'unaffiliated',
    role: config.role ?? 'surveyor',
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    ...(config.wsUrl !== undefined && config.wsUrl.length > 0
      ? { wsUrl: config.wsUrl }
      : {}),
  });

  let booted = false;
  void app
    .init(canvas)
    .then(() => {
      booted = true;
      app.run();
      doc.dispatchEvent(new CustomEvent('lunar-frontier:ready', { detail: { app } }));
      const loader = doc.getElementById('loading');
      if (loader !== null) loader.classList.add('is-hidden');
    })
    .catch((err: unknown) => {
      failToPage((err as Error)?.message ?? String(err));
    });

  // Resize: keep the engine backbuffer glued to the canvas box.
  const onResize = (): void => {
    if (!booted) return;
    app.resize();
  };
  globalThis.addEventListener?.('resize', onResize);

  return app;
}

function failToPage(message: string): void {
  const loader = document.getElementById('loading');
  if (loader !== null) {
    loader.classList.remove('is-complete');
    loader.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'boot-error';
    pre.textContent = `Lunar Frontier failed to boot:\n${message}`;
    loader.appendChild(pre);
  }
  // eslint-disable-next-line no-console
  console.error('[lunar-frontier] boot failed:', message);
}

// HMR teardown (Vite): stop the old loop before the module re-executes.
const hot = (import.meta as unknown as { hot?: { dispose(cb: () => void): void } }).hot;
if (hot !== undefined && typeof hot.dispose === 'function') {
  hot.dispose(() => {
    const app = (globalThis as { __lunarFrontierApp?: ClientApp }).__lunarFrontierApp;
    app?.dispose();
    (globalThis as { __lunarFrontierApp?: ClientApp }).__lunarFrontierApp = undefined;
  });
}

const app = boot();
(globalThis as { __lunarFrontierApp?: ClientApp }).__lunarFrontierApp = app ?? undefined;
