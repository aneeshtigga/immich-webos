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

// Build a query string by hand rather than via `new URLSearchParams(record)`.
//
// Older webOS ships a URLSearchParams whose constructor only understands a
// query *string*: handed an object it stringifies it to "[object Object]" and
// parses that, so every parameter silently disappears and the request goes out
// bare. It fails quietly — endpoints whose parameters are all optional still
// answer (/timeline/buckets returns the default timeline, which is why month
// headers appear at all), so it only surfaces on a call with a required
// parameter, as HTTP 400 "timeBucket: expected string, received undefined".
//
// encodeURIComponent has been universal since ES3, so this is safe everywhere.
function qs(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const key in params) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    const value = params[key];
    if (value === undefined || value === null) continue;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
  }
  return parts.join('&');
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

// Turn whatever a failed call produced into one short line fit for a TV screen.
// Immich has used two error envelopes: pre-v3 put validation failures in a
// `message` array, v3 moved them to `errors: [{ path, message }]`. Unwrap both,
// and fall back to the raw body for anything else (a reverse proxy's HTML 502,
// say). Non-ApiError values are usually a TypeError from parsing an unexpected
// payload — keep the name so that stays distinguishable from a server refusal.
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    let detail = e.message;
    try {
      const body = JSON.parse(e.message) as {
        message?: string | string[];
        errors?: { path?: string; message?: string }[];
      };
      if (body.errors?.length) {
        detail = body.errors
          .map((x) => (x.path ? x.path + ': ' + x.message : x.message))
          .join('; ');
      } else if (Array.isArray(body.message)) {
        detail = body.message.join('; ');
      } else if (body.message) {
        detail = body.message;
      }
    } catch {
      // not JSON — keep the raw body
    }
    return 'HTTP ' + e.status + ' — ' + detail.slice(0, 300);
  }
  if (e instanceof Error) return e.name + ': ' + e.message;
  return String(e);
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

// --- Bucket key formats ---
//
// /timeline/buckets hands back a key that /timeline/bucket wants echoed back,
// but which form is accepted has moved around across Immich releases:
//
//   'day' — "2026-07-01". What current servers return AND expect.
//   'iso' — "2026-07-01T00:00:00.000Z". What some builds require instead; the
//           official web client hit the same split (immich-app/immich#20438).
//
// Worse, a server that dislikes the form it was sent may either reject it
// (400 "timeBucket must be a string") or silently answer 200 with empty
// arrays — so we can't detect the mismatch from the status code alone.
// Some servers also emit an unpadded key ("2026-8-1") that they then refuse
// to accept back, so every form is zero-padded before it goes out.
//
// Rather than hardcode a guess, negotiate once per session: try the preferred
// form, and if it 400s or comes back with zero assets, retry with the other
// and remember whichever worked. See resolveBucket() below.
type BucketFormat = 'day' | 'iso';

const pad2 = (s: string): string => (s.length === 1 ? '0' + s : s);

// "2026-8-1" / "2026-08-1" -> "2026-08-01". Anything that isn't a bare
// year-month-day (already a full ISO timestamp, say) is passed through.
function toDayKey(tb: string): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(tb);
  return m ? m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]) : tb;
}

function toIsoKey(tb: string): string {
  const day = toDayKey(tb);
  return day.length === 10 ? day + 'T00:00:00.000Z' : day;
}

const formatKey = (tb: string, f: BucketFormat): string =>
  f === 'iso' ? toIsoKey(tb) : toDayKey(tb);

// Sticky once a form is known to work, so we pay the probe at most once —
// but only for the server it was learned from, so pointing the app at a
// different Immich re-probes instead of inheriting the wrong answer.
let learned: { server: string; format: BucketFormat } | null = null;

function knownFormat(): BucketFormat | null {
  return learned && learned.server === getServer() ? learned.format : null;
}

function rememberFormat(format: BucketFormat): void {
  learned = { server: getServer(), format };
}

const isEmptyBucket = (c: BucketColumns): boolean =>
  !c || !Array.isArray(c.id) || c.id.length === 0;

// Run `send` against each candidate form until one yields a non-empty bucket.
// A bucket only exists because /timeline/buckets said it holds assets, so an
// empty answer means the key was wrong, not that the month is empty.
async function resolveBucket(
  timeBucket: string,
  send: (key: string) => Promise<BucketColumns>,
): Promise<BucketColumns> {
  const known = knownFormat();
  const candidates: BucketFormat[] = known ? [known] : ['day', 'iso'];
  let lastErr: unknown = null;
  let lastEmpty: BucketColumns | null = null;

  for (const f of candidates) {
    try {
      const cols = await send(formatKey(timeBucket, f));
      if (!isEmptyBucket(cols)) {
        rememberFormat(f);
        return cols;
      }
      lastEmpty = cols;
    } catch (e) {
      lastErr = e;
    }
  }

  // Every form came back empty: genuinely nothing here (or a server we can't
  // satisfy). Hand back the empty response rather than failing the section.
  if (lastEmpty) return lastEmpty;
  throw lastErr ?? new Error('bucket request failed');
}

// Default timeline query: own assets, exclude trashed. Order defaults to newest
// first; callers pass the user's saved per-section direction.
export async function getTimelineBuckets(order: Order = 'desc'): Promise<TimeBucket[]> {
  const q = qs({ isTrashed: 'false', order });
  return jsonReq<TimeBucket[]>('/timeline/buckets?' + q);
}

export async function getBucket(
  timeBucket: string,
  order: Order = 'desc',
): Promise<BucketColumns> {
  return resolveBucket(timeBucket, (key) => {
    const q = qs({
      timeBucket: key,
      isTrashed: 'false',
      order,
    });
    return jsonReq<BucketColumns>('/timeline/bucket?' + q);
  });
}

export async function getFavoriteBuckets(order: Order = 'desc'): Promise<TimeBucket[]> {
  const q = qs({ isTrashed: 'false', isFavorite: 'true', order });
  return jsonReq<TimeBucket[]>('/timeline/buckets?' + q);
}

export async function getFavoriteBucket(
  timeBucket: string,
  order: Order = 'desc',
): Promise<BucketColumns> {
  return resolveBucket(timeBucket, (key) => {
    const q = qs({
      timeBucket: key,
      isTrashed: 'false',
      isFavorite: 'true',
      order,
    });
    return jsonReq<BucketColumns>('/timeline/bucket?' + q);
  });
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
  const q = qs({ albumId, order });
  return jsonReq<TimeBucket[]>('/timeline/buckets?' + q);
}

export async function getAlbumBucket(
  albumId: string,
  timeBucket: string,
  order: Order = 'desc',
): Promise<BucketColumns> {
  return resolveBucket(timeBucket, (key) => {
    const q = qs({ albumId, timeBucket: key, order });
    return jsonReq<BucketColumns>('/timeline/bucket?' + q);
  });
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
  thumbhash?: string | null; // null when no thumbnail has been generated yet
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
    thumbhash: a.thumbhash ?? null,
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

// Assets by type (IMAGE/VIDEO), newest first. One request, so sparse types
// (e.g. videos) return quickly instead of walking the whole timeline.
export async function searchByType(
  type?: 'IMAGE' | 'VIDEO',
): Promise<import('./assets').Asset[]> {
  return metadataSearch(type ? { type } : {});
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

interface AssetInfo {
  location: AssetLocation;
  // EXIF orientation, normalised to 1 (upright) when absent or unparseable.
  // Immich returns it as a string; anything other than 1 means the pixels are
  // stored rotated or mirrored relative to how they should be displayed.
  orientation: number;
}

const infoCache = new Map<string, AssetInfo>();

async function getAssetInfo(id: string): Promise<AssetInfo> {
  const hit = infoCache.get(id);
  if (hit) return hit;
  const a = await jsonReq<{
    exifInfo?: { city?: string; state?: string; country?: string; orientation?: string | null };
  }>(`/assets/${id}`);
  const raw = parseInt(a.exifInfo?.orientation ?? '', 10);
  const info: AssetInfo = {
    location: {
      city: a.exifInfo?.city ?? undefined,
      state: a.exifInfo?.state ?? undefined,
      country: a.exifInfo?.country ?? undefined,
    },
    // A tag we can't read is treated as rotated: displaying a correctly-
    // oriented photo via the preview costs sharpness, showing a rotated one
    // costs the shot.
    orientation: a.exifInfo?.orientation == null ? 1 : isNaN(raw) ? 0 : raw,
  };
  infoCache.set(id, info);
  return info;
}

export async function getAssetLocation(id: string): Promise<AssetLocation> {
  return (await getAssetInfo(id)).location;
}

export async function getAssetOrientation(id: string): Promise<number> {
  return (await getAssetInfo(id)).orientation;
}

// Detected-face bounding box, normalized to 0..1 of the image. Immich reports
// boxes against the (smaller) image its ML pipeline processed, so they must be
// divided by the imageWidth/imageHeight in the response, not the original dims.
export interface FaceBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const faceCache = new Map<string, FaceBox[]>();

// All detected faces for an asset (named or not), normalized. Empty array when
// there are none or the lookup fails — callers fall back to a center crop.
export async function getAssetFaces(id: string): Promise<FaceBox[]> {
  if (faceCache.has(id)) return faceCache.get(id)!;
  let boxes: FaceBox[] = [];
  try {
    const faces = await jsonReq<
      {
        boundingBoxX1: number;
        boundingBoxY1: number;
        boundingBoxX2: number;
        boundingBoxY2: number;
        imageWidth: number;
        imageHeight: number;
      }[]
    >(`/faces?id=${id}`);
    boxes = faces
      .filter((f) => f.imageWidth > 0 && f.imageHeight > 0)
      .map((f) => ({
        x1: f.boundingBoxX1 / f.imageWidth,
        y1: f.boundingBoxY1 / f.imageHeight,
        x2: f.boundingBoxX2 / f.imageWidth,
        y2: f.boundingBoxY2 / f.imageHeight,
      }));
  } catch {
    /* no faces / endpoint unavailable — center crop */
  }
  faceCache.set(id, boxes);
  return boxes;
}

export function thumbnailUrl(id: string, size: 'thumbnail' | 'preview' = 'thumbnail'): string {
  return `${base()}/assets/${id}/thumbnail?size=${size}`;
}

export function originalUrl(id: string): string {
  return `${base()}/assets/${id}/original`;
}

// Direct streaming URL (token in query). Used as a plain <video src>.
export function videoStreamUrl(id: string): string {
  const q = qs(getAuthQuery());
  return `${base()}/assets/${id}/video/playback?${q}`;
}

export function originalStreamUrl(id: string): string {
  const q = qs(getAuthQuery());
  return `${base()}/assets/${id}/original?${q}`;
}
