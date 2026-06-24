// Immich TV pairing relay — a reference implementation of the OAuth 2.0 Device
// Authorization Grant (RFC 8628) that bridges a webOS TV to an Immich server.
//
// WHY THIS EXISTS
//   Immich has no device-pairing endpoint, and a TV app can't run an inbound
//   server, so the phone and TV can't exchange a token directly. This small
//   relay brokers that exchange using the IETF standard device flow, so the TV
//   client speaks a standard contract. If Immich adopts the device flow
//   natively, the TV simply points its issuer at the Immich server and this
//   relay is no longer needed — see PROPOSAL.md.
//
// SECURITY MODEL
//   - The phone sends credentials to this relay, which logs in to Immich
//     server-side and keeps only the resulting token. (A browser can't call
//     Immich cross-origin unless it sends CORS headers, which many self-hosted
//     instances don't — so the relay proxies the login.) The password is used
//     for that one request and is never stored or logged. Run a relay you
//     control, over HTTPS.
//   - device_code and user_code are random and single-use; the phone proves it
//     knows user_code (typed or embedded in the QR) before a token is accepted.
//   - Codes expire (default 5 min). Tokens are held in memory only, briefly,
//     and deleted the moment the TV collects them.
//   - Deploy behind HTTPS. This is a reference; harden (rate limits, persistent
//     store, structured logging) before production use.
//
// ENDPOINTS
//   POST /device_authorization      (TV)    -> device/user codes + URIs
//   GET  /verify?user_code=...      (phone) -> verification page (static HTML)
//   POST /approve                   (phone) -> { user_code, server_url, email, password }
//                                              relay logs in to Immich, stores token
//   POST /token                     (TV)    -> pending | token | error  (RFC 8628 §3.4-3.5)
//
// Run: node relay/server.mjs   (PORT, CODE_TTL_SECONDS, POLL_INTERVAL env vars)

import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.PORT || 8788);
const CODE_TTL = Number(process.env.CODE_TTL_SECONDS || 300);
const INTERVAL = Number(process.env.POLL_INTERVAL || 5);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const here = dirname(fileURLToPath(import.meta.url));
const VERIFY_HTML = readFileSync(join(here, 'verify.html'), 'utf8');

// device_code -> record. In-memory by design (reference); swap for Redis/KV in
// production so it survives restarts and scales horizontally.
const pending = new Map();

// Human-friendly user code: 8 chars, no ambiguous 0/O/1/I/L. Shown on the TV
// and embedded in the QR's verification_uri_complete.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function userCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s.slice(0, 4) + '-' + s.slice(4); // e.g. "K3MQ-7XAB"
}

function prune() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}

// Match a pending record by user_code, ignoring case, spaces, and the dash.
function findByUserCode(input) {
  const norm = String(input).toUpperCase().replace(/[\s-]/g, '');
  for (const v of pending.values()) {
    if (v.user_code.replace('-', '') === norm) return v;
  }
  return null;
}

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': type,
    // The phone verification page calls Immich directly; the TV calls us
    // cross-origin. Allow it (reference). Lock this down per-deployment.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  prune();
  const url = new URL(req.url, PUBLIC_URL);
  const path = url.pathname;
  if (path !== '/verify') console.log(`${req.method} ${path}`);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // --- TV: start a pairing ---
  if (req.method === 'POST' && path === '/device_authorization') {
    const device_code = randomBytes(32).toString('hex');
    const user_code = userCode();
    pending.set(device_code, {
      user_code,
      expiresAt: Date.now() + CODE_TTL * 1000,
      approved: null, // filled by /approve
    });
    const verification_uri = `${PUBLIC_URL}/verify`;
    return send(res, 200, {
      device_code,
      user_code,
      verification_uri,
      verification_uri_complete: `${verification_uri}?user_code=${encodeURIComponent(user_code)}`,
      expires_in: CODE_TTL,
      interval: INTERVAL,
    });
  }

  // --- Phone: verification page ---
  if (req.method === 'GET' && path === '/verify') {
    return send(res, 200, VERIFY_HTML, 'text/html; charset=utf-8');
  }

  // --- Phone: approve a pairing ---
  // The phone sends the user_code plus the Immich server URL and credentials.
  // The relay performs the Immich login SERVER-SIDE (browsers can't call Immich
  // cross-origin unless it sends CORS headers, which many instances don't) and
  // stores only the resulting token for the TV to collect. The password is used
  // for this one request and never stored or logged.
  if (req.method === 'POST' && path === '/approve') {
    const { user_code, server_url, email, password } = await readJson(req);
    if (!user_code || !server_url || !email || !password) {
      return send(res, 400, { error: 'invalid_request' });
    }
    const rec = findByUserCode(user_code);
    if (!rec) return send(res, 404, { error: 'invalid_user_code' });

    const base = String(server_url).trim().replace(/\/+$/, '').replace(/\/api$/, '');
    let loginRes;
    try {
      const r = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (r.status === 401) return send(res, 401, { error: 'invalid_credentials' });
      if (!r.ok) return send(res, 502, { error: 'immich_error', status: r.status });
      loginRes = await r.json();
    } catch {
      return send(res, 502, { error: 'immich_unreachable' });
    }

    rec.approved = {
      access_token: loginRes.accessToken,
      server_url: base,
      user: {
        userId: loginRes.userId,
        name: loginRes.name,
        email: loginRes.userEmail,
      },
    };
    return send(res, 200, { ok: true });
  }

  // --- TV: poll for the token ---
  if (req.method === 'POST' && path === '/token') {
    const { device_code, grant_type } = await readJson(req);
    if (grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    const rec = pending.get(device_code);
    if (!rec) return send(res, 400, { error: 'expired_token' });
    if (!rec.approved) return send(res, 400, { error: 'authorization_pending' });
    // success: hand the token to the TV exactly once, then forget it.
    pending.delete(device_code);
    return send(res, 200, {
      access_token: rec.approved.access_token,
      server_url: rec.approved.server_url,
      user: rec.approved.user,
    });
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`Immich pairing relay on ${PUBLIC_URL} (TTL ${CODE_TTL}s, interval ${INTERVAL}s)`);
});
