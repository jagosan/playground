/**
 * Mandalorian: Nevarro Frontier — Vite configuration (Spec 40 §2).
 *
 * Maps `@lunar` -> `../lunar-frontier/src` so `games/mandalorian` can directly
 * reuse `LunarWorldGenerator` without duplicating terrain heightfield logic.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const PACKAGE_ROOT = import.meta.dirname;
const CLIENT_ROOT = resolve(PACKAGE_ROOT, 'src/client');
const LUNAR_ROOT = resolve(PACKAGE_ROOT, '../lunar-frontier');
const LUNAR_SRC = resolve(LUNAR_ROOT, 'src');

export default defineConfig({
  base: './',
  root: CLIENT_ROOT,
  resolve: {
    alias: {
      '@lunar': LUNAR_SRC,
    },
    extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'],
  },
  server: {
    port: 5175,
    open: false,
    fs: {
      allow: [PACKAGE_ROOT, LUNAR_ROOT],
    },
  },
  build: {
    target: 'es2022',
    outDir: resolve(PACKAGE_ROOT, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
