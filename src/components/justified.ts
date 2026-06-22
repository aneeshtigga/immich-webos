import { Asset } from '../api/assets';

export interface PlacedAsset extends Asset {
  w: number;
  h: number;
}
export interface Row {
  items: PlacedAsset[];
  height: number;
}

// Justified-rows layout, the same look as Immich's timeline: each row is
// filled left-to-right with assets at their natural aspect ratio, then the
// whole row is scaled so it exactly spans the container width at ~targetHeight.
// `ratio` (width/height) comes from the timeline bucket response.
export function justify(
  assets: Asset[],
  containerWidth: number,
  targetHeight: number,
  gap: number,
): Row[] {
  const rows: Row[] = [];
  let cur: Asset[] = [];
  let ratioSum = 0;

  const flush = (last: boolean) => {
    if (!cur.length) return;
    const gaps = gap * (cur.length - 1);
    // height that makes the row's scaled widths sum to containerWidth
    let h = (containerWidth - gaps) / ratioSum;
    if (last && h > targetHeight) h = targetHeight; // don't blow up a short last row
    const items: PlacedAsset[] = cur.map((a) => {
      const r = a.ratio > 0 ? a.ratio : 1;
      return { ...a, h, w: Math.round(r * h) };
    });
    rows.push({ items, height: Math.round(h) });
    cur = [];
    ratioSum = 0;
  };

  for (const a of assets) {
    const r = a.ratio > 0 ? a.ratio : 1;
    cur.push(a);
    ratioSum += r;
    // estimate current row height; flush when it drops to target
    const gaps = gap * (cur.length - 1);
    const h = (containerWidth - gaps) / ratioSum;
    if (h <= targetHeight) flush(false);
  }
  flush(true);
  return rows;
}
