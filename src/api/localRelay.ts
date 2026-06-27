// Bridge from the web app to the bundled on-device relay service
// (service/relay.js) over the Luna bus, then over plain HTTP to the local
// server it starts.
//
// The web app can't open a socket, so the relay runs as a native JS service.
// We start it via Luna (which returns the LAN base URL), then the QR/device
// flow talks to that base URL with ordinary fetch — same RFC 8628 contract as
// the external relay, so deviceAuth.ts works unchanged against it.

const SERVICE = 'luna://com.immich.webos.service';

interface PalmBridge {
  onservicecallback: ((body: string) => void) | null;
  call(uri: string, params: string): void;
}

function bridge(): PalmBridge {
  const Ctor = (window as any).PalmServiceBridge;
  if (!Ctor) throw new Error('PalmServiceBridge unavailable (not running on webOS)');
  return new Ctor();
}

export function isWebOS(): boolean {
  return !!(window as any).PalmServiceBridge;
}

export type UpdateResult =
  | { upToDate: true; version: string }
  | { updateAvailable: true; latestVersion: string; currentVersion: string }
  | { error: string };

export function checkForUpdate(): Promise<UpdateResult> {
  return new Promise((resolve) => {
    let b: PalmBridge;
    try { b = bridge(); } catch (e) {
      return resolve({ error: 'Not running on webOS' });
    }
    b.onservicecallback = (body: string) => {
      try {
        const r = JSON.parse(body);
        if (r.returnValue === false) resolve({ error: r.errorText || 'Check failed' });
        else if (r.upToDate) resolve({ upToDate: true, version: r.version });
        else resolve({ updateAvailable: true, latestVersion: r.latestVersion, currentVersion: r.currentVersion });
      } catch (e) {
        resolve({ error: 'Invalid response' });
      }
    };
    b.call(`${SERVICE}/selfUpdate`, JSON.stringify({}));
  });
}

export interface LocalRelayInfo {
  base: string; // e.g. http://192.168.1.23:8790
  ip: string | null;
  port: number;
}

// Start the on-device relay and get the LAN base URL the phone/QR will use.
export function startLocalRelay(): Promise<LocalRelayInfo> {
  return new Promise((resolve, reject) => {
    let b: PalmBridge;
    try {
      b = bridge();
    } catch (e) {
      return reject(e);
    }
    b.onservicecallback = (body: string) => {
      try {
        const r = JSON.parse(body);
        if (r.returnValue === false) reject(new Error(r.errorText || 'service error'));
        else resolve({ base: r.base, ip: r.ip ?? null, port: r.port });
      } catch (e) {
        reject(e);
      }
    };
    // subscribe:true keeps the service (and its HTTP server) alive while the
    // login page is open — webOS reaps idle services otherwise.
    b.call(`${SERVICE}/start`, JSON.stringify({ subscribe: true }));
  });
}
