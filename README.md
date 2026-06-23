# 📺 Immich for webOS

A native [webOS](https://webostv.developer.lge.com/) TV app for browsing your [Immich](https://immich.app/) photo and video server from the couch. Built with [Preact](https://preactjs.com/) + [Vite](https://vitejs.dev/), driven entirely by the LG remote.

> Unofficial — "Immich" and its logo belong to the [Immich project](https://immich.app). 💙

[![Download latest .ipk](https://img.shields.io/github/v/release/aneeshtigga/immich-webos?label=Download%20.ipk&logo=lg&style=for-the-badge)](https://github.com/aneeshtigga/immich-webos/releases/latest/download/com.immich.webos.ipk)

## ✨ Features

- 🔐 Log in to any Immich server with email + password
- 🖼️ Browse your timeline in a justified photo grid
- 📚 Browse albums
- 🔍 Search
- 🎬 Full-screen photo/video viewer with remote playback controls
- 🕹️ D-pad spatial navigation tuned for the 10-foot experience

## 📋 Requirements

- An [Immich](https://immich.app/) server you can reach from the TV
- Node.js 18+
- An LG webOS TV (webOS 5.0+ / Chromium 68+) in [developer mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app), or the webOS emulator
- [`@webos-tools/cli`](https://www.npmjs.com/package/@webos-tools/cli) (installed as a dev dependency) for packaging and deploy

## 📥 Install from a release

Grab the latest `com.immich.webos.ipk` from the [releases page](https://github.com/aneeshtigga/immich-webos/releases/latest) (or the button above), then sideload it onto a TV in [developer mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app):

```bash
ares-install --device <your-device> com.immich.webos.ipk
```

## 🛠️ Development

```bash
npm install        # patch-package runs automatically via postinstall
npm run dev        # Vite dev server at http://localhost:5173
```

In the browser, the remote is emulated: arrow keys = D-pad, Enter = select, **Esc** = Back.

### ⚠️ CORS in the dev browser

Sign-in may fail with **"Could not reach server… (Failed to fetch)"** even when the server is reachable. This is a browser-only quirk: depending on its config, an Immich server may not return an `Access-Control-Allow-Origin` header, so the browser blocks the cross-origin request from `http://localhost:5173`. The packaged TV app is unaffected — webOS loads from a `file://` origin and doesn't enforce CORS the same way.

To test sign-in locally, launch Chrome with web security disabled in a throwaway profile:

```bash
# macOS
open -na "Google Chrome" --args \
  --user-data-dir=/tmp/chrome-immich-dev \
  --disable-web-security \
  http://localhost:5173
```

```powershell
# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="$env:TEMP\chrome-immich-dev" `
  --disable-web-security `
  http://localhost:5173
```

```bash
# Linux
google-chrome \
  --user-data-dir=/tmp/chrome-immich-dev \
  --disable-web-security \
  http://localhost:5173
```

Use this window only for local dev — it has web security turned off.

## 🚀 Build & deploy to a TV

The deploy scripts target a webOS device registered with `ares-setup-device` under the name `lg_c2`. Rename in `package.json` to match your device.

```bash
npm run build      # type-check + production bundle into dist/
npm run package    # build, then ares-package into out/*.ipk
npm run deploy     # package + install on the TV + launch
```

Individual steps:

```bash
npm run install-tv # ares-install the .ipk onto lg_c2
npm run launch     # ares-launch the installed app
```

## 📁 Project layout

```
src/
  api/         Immich REST client (auth, assets, media)
  auth/        session storage
  components/  Focusable primitives, photo grid, sidebar, icons
  nav/         remote key codes, spatial focus, back/exit handling
  views/       Login, Home, Albums, Search, Fullscreen
public/        appinfo.json + icons/splash for the webOS package
```

## 📄 License

[MIT](LICENSE)
