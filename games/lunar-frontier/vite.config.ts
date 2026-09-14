/**
 * Lunar Frontier — Vite configuration (Spec 13 §1.5 / §6, TASK-PLAY-055).
 *
 * The browser client lives entirely under `src/client` (+ `src/ui`, `src/engine`,
 * `src/entities`, `src/physics`, `src/network`, `src/world`). The Node-only
 * subsystems — `src/server`, `src/database`, `src/economy` — are *never*
 * reachable from `src/client/main.ts`, so they stay out of the bundle and the
 * production artifact is a pure static site droppable on any CDN.
 *
 * `root` is `src/client` so the entry HTML lands at `dist/index.html` (a
 * static host serves it as the site root); the HUD stylesheet outside the root
 * (`../ui/hud.css`) is whitelisted through `server.fs.allow`, and the Node-only
 * `../../dist` output directory through `emptyOutDir`'s safety check.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const CLIENT_ROOT = resolve(import.meta.dirname, 'src/client');
const PACKAGE_ROOT = import.meta.dirname;

export default defineConfig({
  // Relative asset URLs → the build is host-path agnostic (Cloudflare Pages,
  // Nginx sub-folder, GitHub Pages project pages).
  base: './',
  root: CLIENT_ROOT,
  publicDir: false,
  resolve: {
    // The workspace uses `allowImportingTsExtensions` (tsc -p tsconfig.client.json);
    // Vite resolves those specifiers natively.
    extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'],
  },
  server: {
    port: 5174,
    open: false,
    // Dev server must also serve src/ui/hud.css (outside the client root).
    fs: { allow: [PACKAGE_ROOT] },
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:3030',
        ws: true,
      },
      '/api': {
        target: 'http://127.0.0.1:3030',
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: resolve(PACKAGE_ROOT, 'dist'),
    emptyOutDir: true,
    // Babylon is one large dependency; keep chunking predictable rather than
    // failing the build on the default 500 kB warning threshold.
    chunkSizeWarningLimit: 4096,
    sourcemap: false,
    rollupOptions: {
      output: {
        // Stable-ish names so a static host can long-cache the engine chunk.
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
