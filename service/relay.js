// webOS JS service — on-device pairing relay.
//
// Runs the OAuth 2.0 Device Authorization Grant (RFC 8628) entirely on the TV,
// so signing in by scanning a QR with your phone needs NO external server. The
// probe proved a bundled JS service can open a LAN-reachable TCP port; this is
// the full relay built on that.
//
// Flow:
//   web app  ─Luna start─▶ service          (starts HTTP server, returns base URL)
//   web app  ─HTTP device_authorization─▶   (gets device_code + user_code + QR URI)
//   web app  shows QR ─▶ phone scans ─▶ GET /verify   (served by THIS service)
//   phone    ─POST /approve─▶ service        (server URL + credentials)
//   service  ─HTTPS login──▶ Immich          (server-side; tolerates self-signed
//                                             certs, which a phone browser can't)
//   web app  ─HTTP token (poll)─▶ service    (authorization_pending → token)
//
// The password is used for one login request and never stored or logged. All
// state is in-memory and short-lived.
//
// Node on webOS is older: stick to CommonJS, var, no fetch, no crypto.randomInt.

/* eslint-disable no-var */
/* eslint-disable import/no-unresolved */
var Service = require('webos-service');
var http = require('http');
var https = require('https');
var os = require('os');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var urlmod = require('url');

var service = new Service('com.immich.webos.service');

var PORT = 8790;
var CODE_TTL = 300; // seconds
var INTERVAL = 5; // seconds between TV polls
var server = null;

var VERIFY_HTML = '';
try {
  VERIFY_HTML = fs.readFileSync(path.join(__dirname, 'verify.html'), 'utf8');
} catch (e) {
  VERIFY_HTML = '<!doctype html><p>verify page missing</p>';
}

// device_code -> { user_code, expiresAt, approved }
var pending = {};

var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I/L
function userCode() {
  var bytes = crypto.randomBytes(8);
  var s = '';
  for (var i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

function prune() {
  var now = Date.now();
  for (var k in pending) {
    if (pending.hasOwnProperty(k) && pending[k].expiresAt < now) delete pending[k];
  }
}

function findByUserCode(input) {
  var norm = String(input).toUpperCase().replace(/[\s-]/g, '');
  for (var k in pending) {
    if (pending.hasOwnProperty(k) && pending[k].user_code.replace('-', '') === norm) {
      return pending[k];
    }
  }
  return null;
}

function lanIp() {
  var ifaces = os.networkInterfaces();
  for (var name in ifaces) {
    var list = ifaces[name] || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function publicBase() {
  return 'http://' + (lanIp() || 'localhost') + ':' + PORT;
}

// Minimal JSON POST that works against http or https Immich, tolerating
// self-signed certs (LAN HTTPS Immich is common; a phone browser would reject
// it, but the TV service can choose not to). Scoped to this one call.
function postJson(target, bodyObj, cb) {
  var u = urlmod.parse(target);
  var isHttps = u.protocol === 'https:';
  var lib = isHttps ? https : http;
  var data = Buffer.from(JSON.stringify(bodyObj));
  var opts = {
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.path,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
  };
  if (isHttps) opts.rejectUnauthorized = false;
  var req = lib.request(opts, function (res) {
    var chunks = '';
    res.on('data', function (c) {
      chunks += c;
    });
    res.on('end', function () {
      var json = null;
      try {
        json = JSON.parse(chunks || '{}');
      } catch (e) {
        json = {};
      }
      cb(null, res.statusCode, json);
    });
  });
  req.on('error', function (err) {
    cb(err);
  });
  req.write(data);
  req.end();
}

function sendJson(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req, cb) {
  var b = '';
  req.on('data', function (c) {
    b += c;
  });
  req.on('end', function () {
    try {
      cb(JSON.parse(b || '{}'));
    } catch (e) {
      cb({});
    }
  });
}

function handle(req, res) {
  prune();
  var u = urlmod.parse(req.url, true);
  var p = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  // TV: start a pairing
  if (req.method === 'POST' && p === '/device_authorization') {
    var device_code = crypto.randomBytes(32).toString('hex');
    var uc = userCode();
    pending[device_code] = { user_code: uc, expiresAt: Date.now() + CODE_TTL * 1000, approved: null };
    var verification_uri = publicBase() + '/verify';
    return sendJson(res, 200, {
      device_code: device_code,
      user_code: uc,
      verification_uri: verification_uri,
      verification_uri_complete: verification_uri + '?user_code=' + encodeURIComponent(uc),
      expires_in: CODE_TTL,
      interval: INTERVAL,
    });
  }

  // Phone: verification page
  if (req.method === 'GET' && p === '/verify') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(VERIFY_HTML);
  }

  // Phone: approve — service logs into Immich and stores the token
  if (req.method === 'POST' && p === '/approve') {
    return readBody(req, function (body) {
      var user_code = body.user_code;
      var server_url = body.server_url;
      var email = body.email;
      var password = body.password;
      if (!user_code || !server_url || !email || !password) {
        return sendJson(res, 400, { error: 'invalid_request' });
      }
      var rec = findByUserCode(user_code);
      if (!rec) return sendJson(res, 404, { error: 'invalid_user_code' });

      var base = String(server_url).trim().replace(/\/+$/, '').replace(/\/api$/, '');
      postJson(base + '/api/auth/login', { email: email, password: password }, function (err, status, json) {
        if (err) return sendJson(res, 502, { error: 'immich_unreachable' });
        if (status === 401) return sendJson(res, 401, { error: 'invalid_credentials' });
        if (status < 200 || status >= 300) return sendJson(res, 502, { error: 'immich_error', status: status });
        rec.approved = {
          access_token: json.accessToken,
          server_url: base,
          user: { userId: json.userId, name: json.name, email: json.userEmail },
        };
        return sendJson(res, 200, { ok: true });
      });
    });
  }

  // TV: poll for the token
  if (req.method === 'POST' && p === '/token') {
    return readBody(req, function (body) {
      if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
        return sendJson(res, 400, { error: 'unsupported_grant_type' });
      }
      var rec = pending[body.device_code];
      if (!rec) return sendJson(res, 400, { error: 'expired_token' });
      if (!rec.approved) return sendJson(res, 400, { error: 'authorization_pending' });
      delete pending[body.device_code]; // single-use
      return sendJson(res, 200, {
        access_token: rec.approved.access_token,
        server_url: rec.approved.server_url,
        user: rec.approved.user,
      });
    });
  }

  sendJson(res, 404, { error: 'not_found' });
}

function ensureServer() {
  if (server) return;
  server = http.createServer(handle);
  server.on('error', function (e) {
    console.error('relay server error:', e && e.message);
  });
  server.listen(PORT, '0.0.0.0');
}

// Luna: start the relay; returns where it's listening so the web app can point
// its device-flow client at it and build the QR.
service.register('start', function (message) {
  try {
    ensureServer();
    message.respond({ returnValue: true, base: publicBase(), ip: lanIp(), port: PORT });
  } catch (e) {
    message.respond({ returnValue: false, errorText: String(e && e.message) });
  }
});

service.register('ping', function (message) {
  message.respond({ returnValue: true, base: publicBase(), listening: !!server });
});
