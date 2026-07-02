// Deploy the app to a webOS TV.
//
//   npm run deploy            build locally, then install + launch
//   npm run deploy latest     download the .ipk from the latest GitHub release,
//                             then install + launch (no local build)
//   npm run deploy latest c2  ...targeting a specific ares device name
//
// The release workflow publishes the ipk under a stable asset name, so
// GitHub's /releases/latest/download/<asset> redirect always points at newest.

import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = 'aneeshtigga/immich-webos';
const APP_ID = 'com.immich.webos';
const ASSET = `${APP_ID}.ipk`;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

const args = process.argv.slice(2);
const useLatest = args[0] === 'latest';
const device = (useLatest ? args[1] : args[0]) || 'lg_c2';

function run(cmd, cmdArgs) {
  execFileSync(cmd, cmdArgs, { stdio: 'inherit' });
}

async function downloadLatest() {
  const url = `https://github.com/${REPO}/releases/latest/download/${ASSET}`;
  console.log(`↓ downloading latest release: ${url}`);
  const res = await fetch(url); // fetch follows the release redirect
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (no release asset "${ASSET}"?)`);
  mkdirSync(OUT_DIR, { recursive: true });
  const ipk = join(OUT_DIR, ASSET);
  writeFileSync(ipk, Buffer.from(await res.arrayBuffer()));
  console.log(`✓ saved ${ipk}`);
  return ipk;
}

function buildLocal() {
  console.log('▶ building locally…');
  execSync('npm run package', { stdio: 'inherit' });
  const version = process.env.npm_package_version;
  return join(OUT_DIR, `${APP_ID}_${version}_all.ipk`);
}

const ipk = useLatest ? await downloadLatest() : buildLocal();

console.log(`▶ installing on ${device}…`);
run('ares-install', ['--device', device, ipk]);
console.log(`▶ launching ${APP_ID}…`);
run('ares-launch', ['--device', device, APP_ID]);
console.log('✓ done');
