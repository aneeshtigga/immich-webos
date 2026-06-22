import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// webOS apps load from file:// inside the .ipk container, so all asset
// paths must be relative (base: './'). Targeting chrome58 keeps output
// compatible with webOS 5.0+ (Chromium 68) without unnecessary polyfills.
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: {
    target: 'chrome58',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // single bundle keeps the .ipk small and load simple on TV
        manualChunks: undefined,
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
