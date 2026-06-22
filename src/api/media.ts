// Authed binary loader. <img>/<video> can't send an Authorization header,
// so we fetch the bytes with Bearer auth and hand back a blob: object URL.
//
// Object URLs hold the blob in memory until revoked. TVs have little RAM, so
// thumbnails go through a bounded LRU cache that revokes the least-recently
// used URL once the cap is exceeded. Full-size images / videos are one-off
// loads the caller is responsible for revoking (revoke()).

import { authedBlobUrl } from './internal-fetch';
import { thumbnailUrl } from './client';

const MAX_THUMBS = 300; // ~ a few screens of grid; tune for TV RAM
const cache = new Map<string, string>(); // assetId -> object URL (insertion order = LRU)
const inflight = new Map<string, Promise<string>>();

export async function loadThumb(id: string): Promise<string> {
  const hit = cache.get(id);
  if (hit) {
    // refresh LRU position
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const pending = inflight.get(id);
  if (pending) return pending;

  const p = authedBlobUrl(thumbnailUrl(id, 'thumbnail'))
    .then((url) => {
      cache.set(id, url);
      evict();
      inflight.delete(id);
      return url;
    })
    .catch((e) => {
      inflight.delete(id);
      throw e;
    });
  inflight.set(id, p);
  return p;
}

function evict(): void {
  while (cache.size > MAX_THUMBS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    const url = cache.get(oldest)!;
    cache.delete(oldest);
    URL.revokeObjectURL(url);
  }
}

// One-off loaders for fullscreen image / video. Caller must revoke().
export async function loadBlobUrl(url: string): Promise<string> {
  return authedBlobUrl(url);
}

export function revoke(objectUrl: string): void {
  if (objectUrl && objectUrl.startsWith('blob:')) URL.revokeObjectURL(objectUrl);
}
