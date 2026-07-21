// Keep the webOS TV screen saver from kicking in during the wallpaper show.
//
// There's no public per-app "disable screensaver" API. The working approach
// (undocumented, but the standard one) is to subscribe to the tvpower service's
// registerScreenSaverRequest and, whenever it says the saver is about to go
// "Active", veto it by replying to responseScreenSaverRequest with ack:false.
// The event re-fires on each idle timeout, so this holds the saver off for as
// long as we stay subscribed. No-op off webOS (dev browser has no bridge).

interface PalmBridge {
  onservicecallback: ((body: string) => void) | null;
  call(uri: string, params: string): void;
  cancel?(): void;
}

const REGISTER = 'luna://com.webos.service.tvpower/power/registerScreenSaverRequest';
const RESPOND = 'luna://com.webos.service.tvpower/power/responseScreenSaverRequest';
const CLIENT = 'immich-webos-wallpaper';

// Start holding the screen awake. Returns a stop() that releases it (letting
// the TV's normal screen saver resume).
export function keepAwake(): () => void {
  const Ctor = (window as any).PalmServiceBridge;
  if (!Ctor) return () => {}; // not on webOS

  const sub: PalmBridge = new Ctor();
  sub.onservicecallback = (body: string) => {
    try {
      const msg = JSON.parse(body);
      // ack:false = "don't let the saver start"; echo back the timestamp we got
      if (msg.state === 'Active') {
        const resp: PalmBridge = new Ctor();
        resp.call(
          RESPOND,
          JSON.stringify({ clientName: CLIENT, ack: false, timestamp: msg.timestamp }),
        );
      }
    } catch {
      // ignore malformed callbacks
    }
  };
  sub.call(REGISTER, JSON.stringify({ subscribe: true, clientName: CLIENT }));

  return () => {
    try {
      sub.cancel?.();
    } catch {
      // ignore
    }
    sub.onservicecallback = null;
  };
}
