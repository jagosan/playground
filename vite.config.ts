import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    open: false,
    proxy: {
      '/games/lunar-frontier': {
        target: 'http://127.0.0.1:5174',
        ws: true,
      },
      '/lunar-frontier': {
        target: 'http://127.0.0.1:5174',
        ws: true,
      },
    },
  },
});
