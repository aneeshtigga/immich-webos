import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// webOS loads the packaged app over file:// (inside the .ipk container).
// Chromium refuses to fetch a `type="module"` script over file:// — the origin
// is "null", so the module request is blocked by CORS and the app never boots
// (native splash, then black). Same trap for any `crossorigin` subresource.
//
// So we ship a single self-executing (IIFE) bundle and rewrite the emitted tags
// to plain, classic ones. `type="module"` becomes `defer` (NOT just dropped):
// a module script is implicitly deferred, but a classic script in <head> runs
// before <body> is parsed — getElementById('app') would be null and render()
// would crash. `defer` restores run-after-parse.
function webosClassicScript() {
  return {
    name: 'webos-classic-script',
    // build only: in dev the entry is /src/main.tsx served as a real ES module,
    // so stripping type="module" there breaks the dev server (white page).
    apply: 'build' as const,
    enforce: 'post' as const,
    transformIndexHtml(html: string) {
      return html
        .replace(/\stype="module"/g, ' defer')
        .replace(/\scrossorigin/g, '');
    },
  };
}

export default defineConfig({
  // base: './' keeps every asset path relative, required for file:// in the .ipk.
  base: './',
  plugins: [preact(), webosClassicScript()],
  build: {
    // chrome58 keeps JS syntax compatible with webOS 5.0+ (Chromium 68); webOS
    // 6.x is Chromium 79. (CSS feature support is handled in global.css.)
    target: 'chrome58',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    // no module-preload polyfill — it injects modulepreload <link>s a classic
    // build doesn't need.
    modulePreload: false,
    rollupOptions: {
      output: {
        // one classic IIFE bundle: no import/export, so it loads over file://
        // with a plain <script>. inlineDynamicImports guarantees a single file.
        format: 'iife',
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
