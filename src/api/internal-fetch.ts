// Fetch a binary endpoint with Bearer auth and return a blob: object URL.
import { getAuthHeaders } from '../auth/store';

// A hung fetch (TCP stall, silently-dropped connection — common over flaky TV
// wifi to a self-hosted NAS) would otherwise never settle. media.ts gates
// thumbnail loads through a fixed pool of in-flight slots; a fetch that never
// resolves nor rejects permanently burns its slot, and once all slots are dead
// the whole grid stops loading (the network goes idle mid-scroll). So every
// request is bounded by an AbortController timeout: on timeout the fetch aborts,
// the promise rejects, and the slot is freed for the next asset.
// AbortController is Chrome 66, and webOS 4.x TVs (the 2019 C9 reports
// Chrome/53) don't have it — `new AbortController()` threw there, so every
// thumbnail and video load failed and the grid rendered blank. The timeout is
// what actually matters for the pool, so race the request against a timer and
// only cancel for real where the API exists. Without it the socket is left to
// finish on its own, but the promise still settles and the slot is freed.
const canAbort = typeof AbortController !== 'undefined';

export function authedBlobUrl(url: string, timeoutMs = 20000): Promise<string> {
  const ctrl = canAbort ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const load = (async () => {
    const init: RequestInit = { headers: getAuthHeaders() };
    // Aborting also cancels an in-progress body read, so a stall during
    // .blob() (headers arrived, bytes never finish) is covered too.
    if (ctrl) init.signal = ctrl.signal;
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`media ${res.status} for ${url}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  })();

  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (ctrl) ctrl.abort();
      reject(new Error(`media timeout after ${timeoutMs}ms for ${url}`));
    }, timeoutMs);
  });

  // Two-arg then rather than .finally(): finally is itself polyfilled on these
  // sets, and this path runs for every tile on screen.
  return Promise.race([load, expiry]).then(
    (v) => {
      clearTimeout(timer);
      return v;
    },
    (e) => {
      clearTimeout(timer);
      throw e;
    },
  );
}
