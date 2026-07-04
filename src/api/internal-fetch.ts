// Fetch a binary endpoint with Bearer auth and return a blob: object URL.
import { getAuthHeaders } from '../auth/store';

// A hung fetch (TCP stall, silently-dropped connection — common over flaky TV
// wifi to a self-hosted NAS) would otherwise never settle. media.ts gates
// thumbnail loads through a fixed pool of in-flight slots; a fetch that never
// resolves nor rejects permanently burns its slot, and once all slots are dead
// the whole grid stops loading (the network goes idle mid-scroll). So every
// request is bounded by an AbortController timeout: on timeout the fetch aborts,
// the promise rejects, and the slot is freed for the next asset.
export async function authedBlobUrl(url: string, timeoutMs = 20000): Promise<string> {
  // AbortController lands in Chrome 66; webOS 4.0 (Chromium 53, e.g. LG 2018 B8)
  // doesn't have it. Referencing `new AbortController()` there throws, which used
  // to make EVERY thumbnail fetch reject — the whole grid stayed blank while the
  // date headers (plain jsonReq, no controller) still rendered. Feature-detect:
  // when present, abort on timeout (also cancels a stalled body read); when
  // absent, fall back to a timeout that just rejects the promise so the media
  // pool's slot is freed (the fetch itself keeps running uncancelled, acceptable
  // on the old platform).
  const hasAbort = typeof AbortController !== 'undefined';
  const ctrl = hasAbort ? new AbortController() : null;
  let timer = 0;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl?.abort();
      reject(new Error(`media timeout for ${url}`));
    }, timeoutMs) as unknown as number;
  });
  const run = (async () => {
    const res = await fetch(url, {
      headers: getAuthHeaders(),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (!res.ok) throw new Error(`media ${res.status} for ${url}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  })();
  try {
    return await Promise.race([run, guard]);
  } finally {
    clearTimeout(timer);
  }
}
