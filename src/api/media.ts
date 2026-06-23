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

// Thumbnail fetch concurrency gate. A fast scroll marks hundreds of thumbnails
// "near" at once; firing all those fetches together saturates the TV's wifi and
// floods the main thread with blob decodes, which is felt as scroll jank. Cap
// the number of in-flight network fetches and queue the rest. The cache /
// inflight dedup above means we never queue the same asset twice.
const MAX_CONCURRENT = 6;
let active = 0;
const queue: Array<() => void> = [];

function runNext(): void {
  if (active >= MAX_CONCURRENT) return;
  const job = queue.shift();
  if (!job) return;
  active++;
  job();
}

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

  const p = new Promise<string>((resolve, reject) => {
    queue.push(() => {
      authedBlobUrl(thumbnailUrl(id, 'thumbnail'))
        .then((url) => {
          cache.set(id, url);
          evict();
          resolve(url);
        })
        .catch(reject)
        .finally(() => {
          inflight.delete(id);
          active--;
          runNext();
        });
    });
    runNext();
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
