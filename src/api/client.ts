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

import { getServer, getAuthHeaders, getAuthQuery, getAuthKind } from '../auth/store';

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
  return getAuthHeaders();
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

export interface ApiKeyUser {
  userId: string;
  name: string;
  email: string;
}

// Validate a personal API key and resolve the owning user. There's no "login"
// for API keys — the key IS the credential — so we probe GET /users/me with the
// key as proof it works and to pull the display name/email for the session.
export async function loginWithApiKey(
  server: string,
  key: string,
): Promise<ApiKeyUser> {
  // server passed explicitly because it isn't saved until validation succeeds
  const res = await fetch(server + '/api/users/me', {
    headers: { 'x-api-key': key },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body || res.statusText);
  }
  const u = (await res.json()) as { id: string; name: string; email: string };
  return { userId: u.id, name: u.name, email: u.email };
}

export async function logout(): Promise<void> {
  // API keys have no server-side session to invalidate; just drop it locally.
  if (getAuthKind() === 'apikey') return;
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

// Sort order passed to the timeline endpoints. 'desc' = newest first (default),
// 'asc' = oldest first. Drives both the bucket list order and the asset order
// within each bucket, so a whole section reads oldest-to-newest end to end.
export type Order = 'asc' | 'desc';

// Default timeline query: own assets, exclude trashed. Order defaults to newest
// first; callers pass the user's saved per-section direction.
export async function getTimelineBuckets(order: Order = 'desc'): Promise<TimeBucket[]> {
  const q = new URLSearchParams({ isTrashed: 'false', order });
  return jsonReq<TimeBucket[]>('/timeline/buckets?' + q.toString());
}

export async function getBucket(
  timeBucket: string,
  order: Order = 'desc',
): Promise<BucketColumns> {
  const q = new URLSearchParams({
    timeBucket,
    isTrashed: 'false',
    order,
  });
  return jsonReq<BucketColumns>('/timeline/bucket?' + q.toString());
}

export async function getFavoriteBuckets(order: Order = 'desc'): Promise<TimeBucket[]> {
  const q = new URLSearchParams({ isTrashed: 'false', isFavorite: 'true', order });
  return jsonReq<TimeBucket[]>('/timeline/buckets?' + q.toString());
}

export async function getFavoriteBucket(
  timeBucket: string,
  order: Order = 'desc',
): Promise<BucketColumns> {
  const q = new URLSearchParams({
    timeBucket,
    isTrashed: 'false',
    isFavorite: 'true',
    order,
  });
  return jsonReq<BucketColumns>('/timeline/bucket?' + q.toString());
}

// --- Albums ---

export async function getAlbums(): Promise<Album[]> {
  // `/albums` alone returns only albums the user owns. Albums shared *with*
  // this account come back from `/albums?shared=true`, so fetch both and
  // dedupe by id (owned-and-shared albums appear in both responses).
  const [owned, shared] = await Promise.all([
    jsonReq<Album[]>('/albums'),
    jsonReq<Album[]>('/albums?shared=true'),
  ]);
  const byId = new Map<string, Album>();
  for (const a of [...owned, ...shared]) byId.set(a.id, a);
  return [...byId.values()];
}

// Album assets reuse the timeline endpoints with an albumId filter — same
// columnar shape, so the grid view is identical to the main timeline.
export async function getAlbumBuckets(
  albumId: string,
  order: Order = 'desc',
): Promise<TimeBucket[]> {
  const q = new URLSearchParams({ albumId, order });
  return jsonReq<TimeBucket[]>('/timeline/buckets?' + q.toString());
}

export async function getAlbumBucket(
  albumId: string,
  timeBucket: string,
  order: Order = 'desc',
): Promise<BucketColumns> {
  const q = new URLSearchParams({ albumId, timeBucket, order });
  return jsonReq<BucketColumns>('/timeline/bucket?' + q.toString());
}

// --- Search ---

interface AssetResponseDto {
  id: string;
  type: string; // "IMAGE" | "VIDEO"
  duration: number | string | null; // string "HH:MM:SS" (v2) or integer ms (v3)
  fileCreatedAt?: string;
  width?: number;
  height?: number;
  livePhotoVideoId?: string | null;
  exifInfo?: { exifImageWidth?: number; exifImageHeight?: number };
}

function mapAsset(a: AssetResponseDto): import('./assets').Asset {
  const isImage = a.type === 'IMAGE';
  const w = a.width || a.exifInfo?.exifImageWidth || 1;
  const h = a.height || a.exifInfo?.exifImageHeight || 1;
  return {
    id: a.id,
    isImage,
    isVideo: !isImage,
    duration: a.duration,
    ratio: h > 0 ? w / h : 1,
    createdAt: a.fileCreatedAt || '',
    livePhotoVideoId: a.livePhotoVideoId ?? null,
  };
}

// Natural-language search ("beach sunset", "dog"). POST /search/smart.
export async function smartSearch(query: string): Promise<import('./assets').Asset[]> {
  const res = await jsonReq<{ assets: { items: AssetResponseDto[] } }>(
    '/search/smart',
    { method: 'POST', body: JSON.stringify({ query }) },
  );
  return res.assets.items.map(mapAsset);
}

// Structured search by metadata facets (personIds, city, …). POST /search/metadata.
async function metadataSearch(
  body: Record<string, unknown>,
): Promise<import('./assets').Asset[]> {
  const res = await jsonReq<{ assets: { items: AssetResponseDto[] } }>(
    '/search/metadata',
    { method: 'POST', body: JSON.stringify(body) },
  );
  return res.assets.items.map(mapAsset);
}

// --- People ---

export interface Person {
  id: string;
  name: string;
}

// Named people for the search browse view (face circles). Unnamed face
// clusters are omitted — they aren't useful to pick by sight on a TV.
export async function getPeople(): Promise<Person[]> {
  const r = await jsonReq<{
    people: { id: string; name: string; isHidden?: boolean }[];
  }>('/people?withHidden=false');
  return (r.people || [])
    .filter((p) => p.name && !p.isHidden)
    .map((p) => ({ id: p.id, name: p.name }));
}

export async function searchByPerson(personId: string): Promise<import('./assets').Asset[]> {
  return metadataSearch({ personIds: [personId] });
}

export function personThumbnailUrl(id: string): string {
  return `${base()}/people/${id}/thumbnail`;
}

// --- Places (explore aggregation by city) ---

export interface Place {
  value: string; // city name
  assetId: string; // representative asset for the cover thumbnail
}

// GET /search/explore returns grouped aggregations; we surface the city group.
export async function getPlaces(): Promise<Place[]> {
  const groups = await jsonReq<
    { fieldName: string; items: { value: string; data: { id: string } }[] }[]
  >('/search/explore');
  const cities = groups.find(
    (g) => g.fieldName === 'exifInfo.city' || g.fieldName === 'city',
  );
  return (cities?.items || [])
    .filter((i) => i.value && i.data?.id)
    .map((i) => ({ value: i.value, assetId: i.data.id }));
}

export async function searchByCity(city: string): Promise<import('./assets').Asset[]> {
  return metadataSearch({ city });
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

export interface AssetLocation {
  city?: string;
  state?: string;
  country?: string;
}

const locationCache = new Map<string, AssetLocation>();

export async function getAssetLocation(id: string): Promise<AssetLocation> {
  if (locationCache.has(id)) return locationCache.get(id)!;
  const a = await jsonReq<{ exifInfo?: { city?: string; state?: string; country?: string } }>(`/assets/${id}`);
  const loc: AssetLocation = {
    city: a.exifInfo?.city ?? undefined,
    state: a.exifInfo?.state ?? undefined,
    country: a.exifInfo?.country ?? undefined,
  };
  locationCache.set(id, loc);
  return loc;
}

export function thumbnailUrl(id: string, size: 'thumbnail' | 'preview' = 'thumbnail'): string {
  return `${base()}/assets/${id}/thumbnail?size=${size}`;
}

export function originalUrl(id: string): string {
  return `${base()}/assets/${id}/original`;
}

// Direct streaming URL (token in query). Used as a plain <video src>.
export function videoStreamUrl(id: string): string {
  const q = new URLSearchParams(getAuthQuery());
  return `${base()}/assets/${id}/video/playback?${q.toString()}`;
}

export function originalStreamUrl(id: string): string {
  const q = new URLSearchParams(getAuthQuery());
  return `${base()}/assets/${id}/original?${q.toString()}`;
}
