import { BucketColumns } from './client';

// Flattened single-asset model derived from a columnar bucket response.
export interface Asset {
  id: string;
  isImage: boolean;
  isVideo: boolean;
  duration: number | string | null;
  ratio: number;
  createdAt: string; // fileCreatedAt ISO; used to subdivide a month bucket by day
}

export function flattenBucket(b: BucketColumns): Asset[] {
  const n = b.id.length;
  const out: Asset[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const isImage = b.isImage[i];
    out[i] = {
      id: b.id[i],
      isImage,
      isVideo: !isImage,
      duration: b.duration ? b.duration[i] : null,
      ratio: b.ratio ? b.ratio[i] : 1,
      createdAt: b.fileCreatedAt ? b.fileCreatedAt[i] : '',
    };
  }
  return out;
}
