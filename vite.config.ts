import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { readFileSync, writeFileSync } from 'node:fs';

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

// Single source of truth for the version is the root package.json (the sidebar
// already displays pkg.version). appinfo.json is what the on-device service
// reads as CURRENT_VERSION to compare against the GitHub releases/latest tag,
// and it also names the .ipk — so stamp the built dist/appinfo.json from
// package.json at build time. Keeps the displayed version, the update check,
// and the package filename from drifting apart on a release bump.
function stampAppinfoVersion() {
  return {
    name: 'stamp-appinfo-version',
    apply: 'build' as const,
    closeBundle() {
      const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
      const p = 'dist/appinfo.json';
      const info = JSON.parse(readFileSync(p, 'utf8'));
      if (info.version !== version) {
        info.version = version;
        writeFileSync(p, JSON.stringify(info, null, 2) + '\n');
      }
    },
  };
}

export default defineConfig({
  // base: './' keeps every asset path relative, required for file:// in the .ipk.
  base: './',
  plugins: [preact(), webosClassicScript(), stampAppinfoVersion()],
  build: {
    // chrome53 = webOS 4.0 (LG 2018 OLED, e.g. B8). esbuild down-levels async/
    // await (native only from Chrome 55) into a Promise state machine, so the
    // bundle parses and runs on that Chromium too. webOS 4.5/5.0 = Chromium 68,
    // 6.x = 79. Runtime API gaps (e.g. AbortController, Chrome 66) are handled in
    // code, not by the target. (CSS feature support is handled in global.css.)
    target: 'chrome53',
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
