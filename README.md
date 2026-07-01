<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/banner-dark.svg" />
    <img src="screenshots/banner-light.svg" alt="immich webOS" width="420" />
  </picture>
</p>

A native [webOS](https://webostv.developer.lge.com/) TV app for browsing your [Immich](https://immich.app/) photo and video server from the couch. Built with [Preact](https://preactjs.com/) + [Vite](https://vitejs.dev/), driven entirely by the LG remote.

> Unofficial — "Immich" and its logo belong to the [Immich project](https://immich.app).

[![Download latest .ipk](https://img.shields.io/github/v/release/aneeshtigga/immich-webos?label=Download%20.ipk&logo=lg&style=for-the-badge)](https://github.com/aneeshtigga/immich-webos/releases/latest/download/com.immich.webos.ipk)

## Features

- Log in with email + password, or **scan a QR code with your phone**
- Browse your timeline in a justified, day-grouped photo grid
- Browse albums
- Search by text, plus browse **People** (faces) and **Places** (cities)
- Full-screen photo/video viewer with remote playback controls
- D-pad spatial navigation tuned for the 10-foot experience

## Screenshots

<table>
  <tr>
    <td width="50%" align="center">
      <img src="screenshots/login.png" alt="Login with phone QR sign-in" width="100%">
    </td>
    <td width="50%" align="center">
      <img src="screenshots/grid.png" alt="Justified, day-grouped photo timeline" width="100%">
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="screenshots/sidebar.png" alt="Auto-hiding sidebar" width="100%">
    </td>
    <td width="50%" align="center">
      <img src="screenshots/search.png" alt="Search with People and Places" width="100%">
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="screenshots/bike.png" alt="Text search results" width="100%">
    </td>
    <td width="50%" align="center">
      <img src="screenshots/albums.png" alt="Album browser" width="100%">
    </td>
  </tr>
</table>

> Screenshots use the public Immich [demo server](https://demo.immich.app).

## Requirements

- An [Immich](https://immich.app/) server you can reach from the TV
- Node.js 18+
- An LG webOS TV (webOS 5.0+ / Chromium 68+) in [developer mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app), or the webOS emulator
- [`@webos-tools/cli`](https://www.npmjs.com/package/@webos-tools/cli) (installed as a dev dependency) for packaging and deploy

## Install from a release

Grab the latest `com.immich.webos.ipk` from the [releases page](https://github.com/aneeshtigga/immich-webos/releases/latest) (or the button above), then sideload it onto a TV in [developer mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app):

```bash
ares-install --device <your-device> com.immich.webos.ipk
```

## Sign in with your phone (QR)

The login screen can show a QR code that lets you sign in from your phone
instead of typing on the remote, using the standard
[OAuth 2.0 Device Authorization Grant (RFC 8628)](https://datatracker.ietf.org/doc/html/rfc8628).

On a webOS TV this works **out of the box** — a small JS service bundled in the
app (`service/`) runs the pairing flow on the TV itself and logs in to your
Immich server, so there's no external server to host and self-signed / no-CORS
Immich instances work. The phone scans the QR (or opens the printed URL and
enters the 8-character code), submits your Immich URL + credentials to the TV,
and the TV signs in automatically. Credentials are used once and never stored.

In a **desktop browser** (dev), there's no on-device service, so the QR panel
is hidden unless you point it at an external relay:

```bash
VITE_PAIR_ISSUER=https://your-relay.example npm run build
```

A reference relay implementation lives in [`relay/`](relay/) (see its
[README](relay/README.md)); [`relay/PROPOSAL.md`](relay/PROPOSAL.md) describes
the contract for Immich to implement the device flow natively.

## Development

```bash
npm install        # patch-package runs automatically via postinstall
npm run dev        # Vite dev server at http://localhost:5173
```

In the browser, the remote is emulated: arrow keys = D-pad, Enter = select, **Esc** = Back.

### CORS in the dev browser

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

## Build & deploy to a TV

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

## Project layout

```
src/
  api/         Immich REST client, media cache, device-auth + relay bridge
  auth/        session storage + pairing-issuer config
  components/  Focusable primitives, photo grid, sidebar, QR code, icons
  nav/         remote key codes, spatial focus, back/exit handling
  views/       Login, Home, Albums, Search, Fullscreen
  assets/      login background
  fonts/       bundled Inter (Latin woff2)
service/       on-device pairing relay (webOS JS service, packaged in the .ipk)
relay/         reference external relay + RFC 8628 proposal for Immich
public/        appinfo.json + icons/splash for the webOS package
```

## License

[MIT](LICENSE)
