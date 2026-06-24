// Local dev launcher (Mac): starts the pairing relay and Vite together so the
// login page shows the QR sign-in path that the TV gets from its on-device
// relay. Off webOS there's no PalmServiceBridge/Luna service, so QR is gated on
// VITE_PAIR_ISSUER (see auth/store + Login.tsx) — we point it at the relay we
// spin up here.
//
// The QR's verification_uri must be reachable from the PHONE, so both the relay
// (PUBLIC_URL) and the app (VITE_PAIR_ISSUER) use this host's LAN IP, not
// localhost. `npm run deploy` is unaffected: the TV bundles service/relay.js
// and never uses this script.

import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function lanIP() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

const PORT = process.env.RELAY_PORT || '8788';
const ip = lanIP();
const issuer = `http://${ip}:${PORT}`;

console.log(`\n  pairing relay : ${issuer}`);
console.log(`  QR sign-in    : enabled (VITE_PAIR_ISSUER=${issuer})\n`);

// shared stdio so both processes' logs stream to this terminal
const relay = spawn('node', [join(root, 'relay', 'server.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, PORT, PUBLIC_URL: issuer },
});

const vite = spawn('npx', ['vite'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_PAIR_ISSUER: issuer },
});

// if either dies, tear down the other so we don't leave an orphan. Child
// 'exit' passes a numeric code; signal handlers pass a signal string — coerce
// so process.exit() always gets a number.
const killAll = (code) => {
  relay.kill();
  vite.kill();
  process.exit(typeof code === 'number' ? code : 0);
};
relay.on('exit', killAll);
vite.on('exit', killAll);
process.on('SIGINT', killAll);
process.on('SIGTERM', killAll);
