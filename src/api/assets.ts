import { BucketColumns } from './client';

// Flattened single-asset model derived from a columnar bucket response.
export interface Asset {
  id: string;
  isImage: boolean;
  isVideo: boolean;
  duration: number | string | null;
  ratio: number;
  createdAt: string; // fileCreatedAt ISO; used to subdivide a month bucket by day
  // Set on a Live Photo still: the id of its paired motion video. The motion
  // asset itself is filtered out of the timeline, so this is the only handle to
  // it (used to play the motion clip in the fullscreen viewer).
  livePhotoVideoId?: string | null;
  // null when the server hasn't generated a thumbnail yet — such assets 404 on
  // the thumbnail/preview endpoints, so callers can skip them.
  thumbhash?: string | null;
  isFavorite?: boolean; // weights the wallpaper shuffle toward favorites
}

// Pre-columnar Immich (and some proxies) answer /timeline/bucket with a plain
// list of asset objects instead of parallel arrays. Normalise that shape into
// BucketColumns so the columnar path below is the only one that matters.
interface LegacyAsset {
  id: string;
  type?: string;
  duration?: number | string | null;
  fileCreatedAt?: string;
  livePhotoVideoId?: string | null;
  thumbhash?: string | null;
  isFavorite?: boolean;
  exifInfo?: { exifImageWidth?: number; exifImageHeight?: number };
}

function columnsFromList(list: LegacyAsset[]): BucketColumns {
  const w = (a: LegacyAsset) => a.exifInfo?.exifImageWidth ?? 0;
  const h = (a: LegacyAsset) => a.exifInfo?.exifImageHeight ?? 0;
  return {
    id: list.map((a) => a.id),
    ratio: list.map((a) => (w(a) && h(a) ? w(a) / h(a) : 1)),
    isImage: list.map((a) => a.type !== 'VIDEO'),
    isFavorite: list.map((a) => !!a.isFavorite),
    isTrashed: list.map(() => false),
    duration: list.map((a) => a.duration ?? null),
    livePhotoVideoId: list.map((a) => a.livePhotoVideoId ?? null),
    fileCreatedAt: list.map((a) => a.fileCreatedAt ?? ''),
    thumbhash: list.map((a) => a.thumbhash ?? null),
  };
}

// Tolerant by design: the bucket payload has changed shape across Immich
// releases, and a missing column here used to throw a TypeError that took out
// the whole grid ("Failed to load bucket ..."). Every column is now optional
// with a sane default, so an unfamiliar server degrades to fewer details
// instead of an error screen.
export function flattenBucket(raw: BucketColumns | LegacyAsset[] | null): Asset[] {
  if (!raw) return [];
  const b: BucketColumns = Array.isArray(raw) ? columnsFromList(raw) : raw;
  if (!Array.isArray(b.id)) return [];
  const n = b.id.length;
  // Live Photos come back as two rows: the still (carrying livePhotoVideoId)
  // and its motion video. Immich's web hides the motion half; collect those
  // ids and skip them so a Live Photo shows as one item, not two.
  const motionIds = new Set<string>();
  for (let i = 0; i < n; i++) {
    const v = b.livePhotoVideoId?.[i];
    if (v) motionIds.add(v);
  }
  const out: Asset[] = [];
  for (let i = 0; i < n; i++) {
    if (motionIds.has(b.id[i])) continue;
    // Absent isImage column: assume image unless a duration says otherwise.
    const isImage = b.isImage ? b.isImage[i] : !b.duration?.[i];
    out.push({
      id: b.id[i],
      isImage,
      isVideo: !isImage,
      duration: b.duration ? b.duration[i] : null,
      ratio: b.ratio ? b.ratio[i] : 1,
      createdAt: b.fileCreatedAt ? b.fileCreatedAt[i] : '',
      livePhotoVideoId: b.livePhotoVideoId?.[i] ?? null,
      thumbhash: b.thumbhash?.[i] ?? null,
      isFavorite: b.isFavorite?.[i] ?? false,
    });
  }
  return out;
}
