# Immich TV pairing relay

A small reference service that lets the webOS TV app sign in **by scanning a QR
code with your phone**, using the OAuth 2.0 Device Authorization Grant
([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)).

## Why it's needed

Immich exposes no device-pairing endpoint, and a TV app cannot run an inbound
server, so the phone and TV can't hand a token to each other directly. This
relay brokers that exchange using the IETF standard device flow.

The phone sends your credentials to the relay, which logs in to your Immich
server (`/api/auth/login`) and keeps only the resulting access token, tied to
the short code shown on the TV. The relay performs the login server-side because
browsers can't call Immich cross-origin unless it sends CORS headers, which many
self-hosted instances don't. **The password is used for that one request and is
never stored or logged** — so run a relay you control, over HTTPS.

> A more private variant where the password never reaches the relay is possible
> on Immich instances that enable CORS (the phone calls Immich directly); see
> [PROPOSAL.md](./PROPOSAL.md).

If Immich ever implements the device flow natively, the TV app just points its
issuer URL at the Immich server and this relay becomes unnecessary — see
[PROPOSAL.md](./PROPOSAL.md).

## Run

```bash
node relay/server.mjs
```

Environment variables:

| var                 | default                  | meaning                                  |
| ------------------- | ------------------------ | ---------------------------------------- |
| `PORT`              | `8788`                   | listen port                              |
| `PUBLIC_URL`        | `http://localhost:$PORT` | externally reachable base URL (for QR)   |
| `CODE_TTL_SECONDS`  | `300`                    | how long a pairing code is valid         |
| `POLL_INTERVAL`     | `5`                      | min seconds between TV polls (RFC 8628)  |

Put it behind HTTPS (the phone needs a secure context to use the camera/QR and
to call Immich). `PUBLIC_URL` must be the HTTPS address the phone can reach.

## Point the TV app at it

Build the app with the issuer baked in:

```bash
VITE_PAIR_ISSUER=https://pair.example.com npm run build
```

Or set it at runtime in the browser console / via localStorage key
`immich.pairIssuer`. If unset, the QR panel is hidden and only the manual form
shows.

## Flow

```
TV    ─POST /device_authorization─▶ relay        (gets device_code + user_code + QR URI)
TV    shows QR ───────────────────▶ phone scans
phone ─POST /approve──────────────▶ relay        (user_code + server URL + credentials)
relay ─POST /api/auth/login───────▶ Immich       (server-side; relay keeps only the token)
TV    ─POST /token (poll)──────────▶ relay        (authorization_pending → token, single-use)
TV    logged in.
```

## Hardening before production

This is a **reference** implementation. Before real use:

- Replace the in-memory `Map` with a TTL store (Redis / Cloudflare KV) so codes
  survive restarts and scale across instances.
- Add rate limiting on `/device_authorization`, `/approve`, and `/token`.
- Restrict `Access-Control-Allow-Origin` to your TV app origin where possible.
- Add structured logging + metrics; alert on unusual `/approve` volume.
