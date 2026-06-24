// Fetch a binary endpoint with Bearer auth and return a blob: object URL.
import { getToken } from '../auth/store';

// A hung fetch (TCP stall, silently-dropped connection — common over flaky TV
// wifi to a self-hosted NAS) would otherwise never settle. media.ts gates
// thumbnail loads through a fixed pool of in-flight slots; a fetch that never
// resolves nor rejects permanently burns its slot, and once all slots are dead
// the whole grid stops loading (the network goes idle mid-scroll). So every
// request is bounded by an AbortController timeout: on timeout the fetch aborts,
// the promise rejects, and the slot is freed for the next asset.
export async function authedBlobUrl(url: string, timeoutMs = 20000): Promise<string> {
  const t = getToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: t ? { Authorization: `Bearer ${t}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`media ${res.status} for ${url}`);
    // Aborting also cancels an in-progress body read, so a stall during
    // .blob() (headers arrived, bytes never finish) is covered too.
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } finally {
    clearTimeout(timer);
  }
}
