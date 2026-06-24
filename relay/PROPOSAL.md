# Proposal: native Device Authorization flow in Immich

**Goal:** let TVs, consoles, and other input-constrained devices sign in to
Immich by scanning a QR / entering a short code on a phone — without a
third-party relay, and without typing an email + password on a D-pad.

This describes a server-side feature for Immich that implements the
[OAuth 2.0 Device Authorization Grant, RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628).
The webOS TV app already speaks this contract (see `src/api/deviceAuth.ts`); if
Immich ships it, the app points its issuer at the Immich server and the external
relay in this folder is no longer needed.

## Endpoints

All under the existing `/api` prefix, no auth required to start (the user
authenticates during the flow).

### `POST /api/oauth/device_authorization`

Request:
```json
{ "clientId": "immich-tv", "scope": "all" }
```
Response (`200`):
```json
{
  "device_code": "<opaque, single-use>",
  "user_code": "K3MQ-7XAB",
  "verification_uri": "https://<server>/device",
  "verification_uri_complete": "https://<server>/device?user_code=K3MQ-7XAB",
  "expires_in": 300,
  "interval": 5
}
```

### `GET /device` (web UI)

A page in the existing Immich web app. If `user_code` is present, prefill it.
The user is already (or logs in) as themselves in the browser, sees the device
description, and clicks **Approve** (or **Deny**). On approve, the server marks
the device_code approved and mints an access token / session bound to the
approving user.

### `POST /api/oauth/token`

Request (RFC 8628 §3.4):
```json
{
  "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
  "device_code": "<from step 1>",
  "client_id": "immich-tv"
}
```
Responses:
- `200` → `{ "access_token": "...", "token_type": "Bearer", "user": {...} }`
- `400` → `{ "error": "authorization_pending" }` — keep polling
- `400` → `{ "error": "slow_down" }` — increase interval by 5s
- `400` → `{ "error": "expired_token" }` — restart the flow
- `400` → `{ "error": "access_denied" }` — user denied

## Why this shape

- **Standard.** RFC 8628 is what Apple TV, Android TV, smart TVs, and CLIs use.
  Existing client libraries and user mental models already fit.
- **Credentials stay on the trusted surface.** The TV never handles the
  password; approval happens in the already-trusted Immich web session.
- **Reuses Immich auth.** Approval can reuse the current session or any existing
  login method (including OAuth/OIDC), so SSO setups work for free.
- **Revocable.** Device sessions can appear in the existing "Authorized Devices"
  / sessions UI and be revoked like any other session.

## Security notes

- `device_code` is high-entropy, single-use, short-TTL.
- `user_code` is short but rate-limited and only usable by an authenticated
  approver; it grants nothing on its own.
- Bind the minted token to a device session row so it shows up in session
  management and respects logout-all.
- Enforce the poll `interval` server-side; emit `slow_down` on abuse.

## Migration for this app

`src/api/deviceAuth.ts` already targets these exact request/response shapes. The
only change needed if Immich implements this is to set the issuer to the Immich
server's `/api/oauth` base instead of the relay. No other client code changes.
