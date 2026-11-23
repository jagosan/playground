/**
 * Mandalorian: Nevarro Frontier — Vite configuration (Spec 40 §2).
 *
 * This is a smoke-test-only project. The browser app is not implemented yet.
 * Build passes with an empty dist directory for verification.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const PACKAGE_ROOT = import.meta.dirname;

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: resolve(PACKAGE_ROOT, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      external: ['three', '@babylonjs/core'],
      output: {
        sourcemap: false,
      },
    },
  },
  resolve: {
    alias: {
      '@lunar': resolve(PACKAGE_ROOT, '../lunar-frontier/src'),
    },
  },
  optimizeDeps: {
    exclude: ['@lunar'],
  },
});
