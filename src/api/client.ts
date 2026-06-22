// Immich REST client. All endpoints verified against the official
// OpenAPI spec (immich-app/immich open-api/immich-openapi-specs.json).
//
// Auth: POST /api/auth/login -> { accessToken }. Every other call sends
// `Authorization: Bearer <token>`. Immich runs app.enableCors() with the
// NestJS default (origin: *) and uses header-based auth, so cross-origin
// requests from a webOS app work without a proxy.
//
// Binary endpoints (thumbnail / original / video) cannot use an <img>/<video>
// src directly because we can't attach an Authorization header to those, and
// the cross-origin cookie auth path is unavailable. So we fetch them with the
// Bearer header and turn the response into a blob: object URL (see media.ts).

import { getServer, getToken } from '../auth/store';

export interface LoginResponse {
  accessToken: string;
  userId: string;
  userEmail: string;
  name: string;
  isAdmin: boolean;
}

export interface TimeBucket {
  timeBucket: string; // e.g. "2024-03-01T00:00:00.000Z"
  count: number;
}

// /api/timeline/bucket returns columnar parallel arrays, not a list of objects.
export interface BucketColumns {
  id: string[];
  ratio: number[];
  isImage: boolean[];
  isFavorite: boolean[];
  isTrashed: boolean[];
  duration: (number | string | null)[];
  livePhotoVideoId: (string | null)[];
  fileCreatedAt: string[];
  thumbhash: (string | null)[];
}

export interface Album {
  id: string;
  albumName: string;
  albumThumbnailAssetId: string | null;
  assetCount: number;
  shared: boolean;
  startDate?: string;
  endDate?: string;
}

function base(): string {
  return getServer() + '/api';
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function jsonReq<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base() + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body || res.statusText);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// --- Auth ---

export async function login(
  server: string,
  email: string,
  password: string,
): Promise<LoginResponse> {
  // server passed explicitly because it isn't saved until login succeeds
  const res = await fetch(server + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body || res.statusText);
  }
  return res.json() as Promise<LoginResponse>;
}

export async function logout(): Promise<void> {
  try {
    await jsonReq('/auth/logout', { method: 'POST' });
  } catch {
    // ignore: clearing local session is what matters
  }
}

export async function validateToken(): Promise<boolean> {
  try {
    const r = await jsonReq<{ authStatus: boolean }>('/auth/validateToken', {
      method: 'POST',
    });
    return !!r.authStatus;
  } catch {
    return false;
  }
}

// --- Timeline ---

// Default timeline query: own assets, newest first, exclude trashed.
export async function getTimelineBuckets(): Promise<TimeBucket[]> {
  return jsonReq<TimeBucket[]>('/timeline/buckets?isTrashed=false&order=desc');
}

export async function getBucket(timeBucket: string): Promise<BucketColumns> {
  const q = new URLSearchParams({
    timeBucket,
    isTrashed: 'false',
    order: 'desc',
  });
  return jsonReq<BucketColumns>('/timeline/bucket?' + q.toString());
}

export async function getFavoriteBuckets(): Promise<TimeBucket[]> {
  return jsonReq<TimeBucket[]>(
    '/timeline/buckets?isTrashed=false&isFavorite=true&order=desc',
  );
}

export async function getFavoriteBucket(timeBucket: string): Promise<BucketColumns> {
  const q = new URLSearchParams({
    timeBucket,
    isTrashed: 'false',
    isFavorite: 'true',
    order: 'desc',
  });
  return jsonReq<BucketColumns>('/timeline/bucket?' + q.toString());
}

// --- Albums ---

export async function getAlbums(): Promise<Album[]> {
  return jsonReq<Album[]>('/albums');
}

// Album assets reuse the timeline endpoints with an albumId filter — same
// columnar shape, so the grid view is identical to the main timeline.
export async function getAlbumBuckets(albumId: string): Promise<TimeBucket[]> {
  const q = new URLSearchParams({ albumId, order: 'desc' });
  return jsonReq<TimeBucket[]>('/timeline/buckets?' + q.toString());
}

export async function getAlbumBucket(
  albumId: string,
  timeBucket: string,
): Promise<BucketColumns> {
  const q = new URLSearchParams({ albumId, timeBucket, order: 'desc' });
  return jsonReq<BucketColumns>('/timeline/bucket?' + q.toString());
}

// --- Search ---

interface AssetResponseDto {
  id: string;
  type: string; // "IMAGE" | "VIDEO"
  duration: string | null;
  width?: number;
  height?: number;
  exifInfo?: { exifImageWidth?: number; exifImageHeight?: number };
}

export async function smartSearch(query: string): Promise<import('./assets').Asset[]> {
  const res = await jsonReq<{ assets: { items: AssetResponseDto[] } }>(
    '/search/smart',
    { method: 'POST', body: JSON.stringify({ query }) },
  );
  return res.assets.items.map((a) => {
    const isImage = a.type === 'IMAGE';
    const w = a.width || a.exifInfo?.exifImageWidth || 1;
    const h = a.height || a.exifInfo?.exifImageHeight || 1;
    return {
      id: a.id,
      isImage,
      isVideo: !isImage,
      duration: a.duration,
      ratio: h > 0 ? w / h : 1,
    };
  });
}

// --- Binary asset URLs ---
//
// Two flavors:
//  - thumbnail/original are fetched via media.ts (authed fetch -> blob URL),
//    because images are small and we want LRU caching + memory control.
//  - video uses a DIRECT src URL with the token as a `sessionKey` query param
//    (Immich's ImmichQuery.SessionKey, verified in server/src/enum.ts). This
//    lets <video> stream progressively with HTTP range seeking instead of
//    downloading the whole file into a blob first — essential for big videos
//    on a low-RAM TV. We can't use an Authorization header on a <video> tag,
//    and cross-origin cookie auth is unavailable, so the query token is the
//    only way to stream directly.

export function thumbnailUrl(id: string, size: 'thumbnail' | 'preview' = 'thumbnail'): string {
  return `${base()}/assets/${id}/thumbnail?size=${size}`;
}

export function originalUrl(id: string): string {
  return `${base()}/assets/${id}/original`;
}

// Direct streaming URL (token in query). Used as a plain <video src>.
export function videoStreamUrl(id: string): string {
  const t = getToken();
  const q = new URLSearchParams({ sessionKey: t || '' });
  return `${base()}/assets/${id}/video/playback?${q.toString()}`;
}

export function originalStreamUrl(id: string): string {
  const t = getToken();
  const q = new URLSearchParams({ sessionKey: t || '' });
  return `${base()}/assets/${id}/original?${q.toString()}`;
}
