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
}

export function flattenBucket(b: BucketColumns): Asset[] {
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
    const isImage = b.isImage[i];
    out.push({
      id: b.id[i],
      isImage,
      isVideo: !isImage,
      duration: b.duration ? b.duration[i] : null,
      ratio: b.ratio ? b.ratio[i] : 1,
      createdAt: b.fileCreatedAt ? b.fileCreatedAt[i] : '',
      livePhotoVideoId: b.livePhotoVideoId?.[i] ?? null,
    });
  }
  return out;
}
