/** 
 * Mandalorian: Nevarro Frontier — Vite configuration (Spec 40 §2).
 *
 * Library build for `src/MandoPhysics.ts` physics module.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const PACKAGE_ROOT = import.meta.dirname;

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: resolve(PACKAGE_ROOT, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: resolve(PACKAGE_ROOT, 'src/MandoPhysics.ts'),
      name: 'MandalorianPhysics',
      fileName: 'mandalorian-physics',
      formats: ['es'],
    },
    rollupOptions: {
      external: ['three', '@babylonjs/core'],
      output: {
        sourcemap: false,
      },
    },
  },
});
