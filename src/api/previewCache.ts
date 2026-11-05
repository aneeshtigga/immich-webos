// Fullscreen preview cache: fetch + decode ahead, keep the last few.
//
// The viewer used to fetch each preview as a one-off blob and revoke it on
// every photo change. That meant two costs on every step, even when going back
// to a photo seen a second ago:
//   1. a re-fetch of the preview JPEG, and
//   2. a re-decode at paint time. A full-size phone preview takes ~500ms to
//      decode on an LG C2, and the frame that first shows it waits for it.
//
// Here each preview is fetched once, decoded off-screen with img.decode()
// before the viewer shows it, and its blob URL is kept in a small LRU. Showing
// the same URL again lets Chromium reuse the decoded bitmap, so a cached photo
// is on screen in one frame. The viewer also asks for its neighbours, so the
// next photo is usually decoded before the remote key is pressed.
//
// Bounded because decoded previews are big (a 1440x1920 RGBA bitmap is ~11MB):
// MAX_PREVIEWS covers the current photo, the ones either side and one more in
// the direction of travel. Chromium may still drop a decoded bitmap under
// memory pressure; the blob stays, so the worst case is a re-decode, not a
// re-fetch.

import { loadBlobUrl, revoke } from './media';
import { thumbnailUrl } from './client';

const MAX_PREVIEWS = 5;

interface Entry {
  url: string | null; // set once fetched
  ready: boolean; // fetched AND decoded
  promise: Promise<string>;
  img: HTMLImageElement | null; // keeps the decoded image referenced
}

const entries = new Map<string, Entry>(); // assetId -> entry (insertion order = LRU)
let pinned: string | null = null; // the photo on screen: never evicted

function touch(id: string, e: Entry): void {
  entries.delete(id);
  entries.set(id, e);
}

function evict(): void {
  for (const id of Array.from(entries.keys())) {
    if (entries.size <= MAX_PREVIEWS) break;
    if (id === pinned) continue;
    const e = entries.get(id)!;
    if (!e.ready) continue; // in flight: let it land, evict on a later pass
    entries.delete(id);
    if (e.url) revoke(e.url);
    e.img = null;
  }
}

// Decode via an off-screen <img>. decode() is Chrome 64+; older engines
// (webOS 4.x is Chrome 53) fall back to the load event, which still saves the
// fetch, just not the paint-time decode.
function decodeUrl(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  if (typeof img.decode === 'function') {
    return img.decode().then(
      () => img,
      () => img, // a failed decode still lets the <img> try at paint time
    );
  }
  return new Promise((resolve) => {
    img.onload = img.onerror = () => resolve(img);
  });
}

// Resolves to a blob URL whose image is already decoded.
export function getPreview(id: string): Promise<string> {
  const hit = entries.get(id);
  if (hit) {
    touch(id, hit);
    return hit.promise;
  }
  const e: Entry = { url: null, ready: false, img: null, promise: null as unknown as Promise<string> };
  e.promise = loadBlobUrl(thumbnailUrl(id, 'preview')).then(
    (url) => {
      e.url = url;
      return decodeUrl(url).then((img) => {
        e.img = img;
        e.ready = true;
        evict();
        return url;
      });
    },
    (err) => {
      entries.delete(id); // let a later call retry
      throw err;
    },
  );
  entries.set(id, e);
  evict();
  return e.promise;
}

// The decoded URL if this preview is ready right now, else null. Lets the
// viewer render a cached photo in the same frame as the key press.
export function peekPreview(id: string): string | null {
  const e = entries.get(id);
  return e && e.ready ? e.url : null;
}

// Mark the photo on screen so eviction never revokes a URL that is displayed.
export function pinPreview(id: string | null): void {
  pinned = id;
}

// Warm the cache for upcoming photos, one at a time so a neighbour never
// competes with the photo on screen for bandwidth or decode time.
let warmToken = 0;
export function prefetchPreviews(ids: string[]): void {
  const token = ++warmToken;
  const next = (k: number): void => {
    if (token !== warmToken || k >= ids.length) return; // superseded by a newer call
    getPreview(ids[k]).then(
      () => next(k + 1),
      () => next(k + 1),
    );
  };
  next(0);
}
