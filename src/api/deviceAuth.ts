// OAuth 2.0 Device Authorization Grant (RFC 8628) client — the standard "log a
// TV in from your phone" flow. The TV asks the issuer for a device code, shows
// a QR/short code, then polls until the user has approved on their phone and a
// token is minted.
//
// The issuer is a small pairing relay (see relay/) that bridges to Immich: the
// phone submits credentials to the relay, which logs in to Immich server-side
// and holds only the resulting token for the TV to poll. The contract is
// deliberately the IETF standard so that, if Immich adds native device-flow
// support, the TV only has to point at the Immich server instead of the relay —
// no client changes.
//
// Endpoints (relative to the issuer base URL):
//   POST /device_authorization -> { device_code, user_code, verification_uri,
//                                    verification_uri_complete, expires_in, interval }
//   POST /token (grant_type=urn:ietf:params:oauth:grant-type:device_code)
//        -> 200 { access_token, server_url, user: {...} }
//         | 400 { error: "authorization_pending" | "slow_down" | "expired_token"
//                        | "access_denied" }

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string; // URI with the code embedded — what the QR encodes
  expires_in: number; // seconds
  interval: number; // min seconds between polls
}

export interface DeviceTokenSuccess {
  access_token: string;
  server_url: string;
  user: { userId: string; name: string; email: string };
}

export class DevicePending extends Error {
  constructor(public reason: 'authorization_pending' | 'slow_down') {
    super(reason);
  }
}
export class DeviceExpired extends Error {}
export class DeviceDenied extends Error {}

function issuerBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export async function requestDeviceCode(issuer: string): Promise<DeviceCodeResponse> {
  const res = await fetch(issuerBase(issuer) + '/device_authorization', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'immich-webos-tv', scope: 'immich' }),
  });
  if (!res.ok) throw new Error(`device_authorization ${res.status}`);
  return res.json() as Promise<DeviceCodeResponse>;
}

// One poll attempt. Resolves with the token on success; throws a typed error
// the caller uses to decide whether to keep polling, back off, or stop.
export async function pollToken(
  issuer: string,
  deviceCode: string,
): Promise<DeviceTokenSuccess> {
  const res = await fetch(issuerBase(issuer) + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: 'immich-webos-tv',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body as DeviceTokenSuccess;

  switch (body?.error) {
    case 'authorization_pending':
      throw new DevicePending('authorization_pending');
    case 'slow_down':
      throw new DevicePending('slow_down');
    case 'expired_token':
      throw new DeviceExpired();
    case 'access_denied':
      throw new DeviceDenied();
    default:
      throw new Error(body?.error || `token ${res.status}`);
  }
}

// Drive the full poll loop until the user approves, the code expires, the user
// is denied, or `signal` aborts. Honors RFC 8628 interval + slow_down backoff.
export async function pollUntilDone(
  issuer: string,
  dc: DeviceCodeResponse,
  signal: { aborted: boolean },
): Promise<DeviceTokenSuccess> {
  let interval = Math.max(1, dc.interval || 5);
  const deadline = Date.now() + dc.expires_in * 1000;

  while (!signal.aborted) {
    if (Date.now() > deadline) throw new DeviceExpired();
    await wait(interval * 1000, signal);
    if (signal.aborted) break;
    try {
      return await pollToken(issuer, dc.device_code);
    } catch (e) {
      if (e instanceof DevicePending) {
        if (e.reason === 'slow_down') interval += 5; // RFC 8628 §3.5
        continue;
      }
      throw e; // expired / denied / network — surface to caller
    }
  }
  throw new DeviceDenied(); // aborted by caller
}

function wait(ms: number, signal: { aborted: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (signal.aborted || Date.now() - start >= ms) resolve();
      else setTimeout(tick, 250);
    };
    tick();
  });
}
