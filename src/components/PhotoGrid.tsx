import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { memo } from 'preact/compat';
import { TimeBucket, BucketColumns } from '../api/client';
import { Asset, flattenBucket } from '../api/assets';
import { Thumb } from './Thumb';
import { bucketObserver, setLazyRoot } from './lazyObserver';
import { justify, targetRowHeight, GRID_GAP as GAP } from './justified';
import { reportError } from './ErrorBoundary';
import { EmptyState } from './EmptyState';

const DAY_SEP = 5; // px gap inserted between day-groups on a shared row
const MIN_LABEL_WIDTH = 230; // min px between consecutive day labels (prevents collision)

interface Props {
  // loaders injected so the same grid serves timeline / albums / favorites
  loadBuckets: () => Promise<TimeBucket[]>;
  loadBucket: (timeBucket: string) => Promise<BucketColumns>;
  onOpen: (assets: Asset[], index: number) => void;
  // ref filled with a function that loads the next unloaded bucket; caller invokes it to prefetch
  loadNextUnloaded?: { current: (() => void) | null };
  // called whenever the flat asset list grows (new bucket loaded)
  onAssetsChange?: (assets: Asset[]) => void;
  // shown (centered, with the broken logo) when the bucket list loads empty
  emptyLabel?: string;
  emptyHint?: string;
}

// Date-bucketed, justified-row photo grid (Immich timeline look). Buckets load
// lazily as their header nears the viewport; loaded assets are concatenated so
// fullscreen left/right traverses everything loaded.
//
// Perf: every prop handed to BucketSection is kept referentially stable (refs +
// stable useCallbacks), and BucketSection is memo()'d. So loading the Nth bucket
// re-renders ONLY that section — not all N previously loaded sections. Without
// this the grid did O(N) justify()+vnode work on every bucket load, which is
// why the UI degraded the longer you scrolled.
export function PhotoGrid({ loadBuckets, loadBucket, onOpen, loadNextUnloaded, onAssetsChange, emptyLabel, emptyHint }: Props) {
  const [buckets, setBuckets] = useState<TimeBucket[]>([]);
  const [fetched, setFetched] = useState(false); // bucket list resolved (may be empty)
  const [loaded, setLoaded] = useState<Record<string, Asset[]>>({});
  const [error, setError] = useState('');
  const [width, setWidth] = useState(window.innerWidth - 96 - 32);
  const [rowH, setRowH] = useState(targetRowHeight());
  const loadingRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Refs mirror the latest state so the stable callbacks below can read current
  // values without being recreated (which would defeat the memo on sections).
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onAssetsChangeRef = useRef(onAssetsChange);
  onAssetsChangeRef.current = onAssetsChange;
  const flatRef = useRef<Asset[]>([]);
  const offsetRef = useRef<Record<string, number>>({});

  // keep loadNextUnloaded.current pointed at a fresh closure so callers always
  // get the next truly-unloaded bucket regardless of when they invoke it
  const bucketsRef = useRef(buckets);
  bucketsRef.current = buckets;
  if (loadNextUnloaded) {
    loadNextUnloaded.current = () => {
      const next = bucketsRef.current.find(
        (b) => !loadedRef.current[b.timeBucket] && !loadingRef.current.has(b.timeBucket),
      );
      if (next) ensureBucket(next.timeBucket);
    };
  }

  useEffect(() => {
    setFetched(false);
    loadBuckets()
      .then(setBuckets)
      .catch((e) => setError(e?.message || 'Failed to load timeline'))
      .finally(() => setFetched(true));
  }, [loadBuckets]);

  useEffect(() => {
    const onResize = () => {
      if (scrollRef.current) setWidth(scrollRef.current.clientWidth - 32);
      setRowH(targetRowHeight());
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Point the shared lazy observers at THIS grid's scroll container. Child Thumb
  // / BucketSection effects run first (root=null), so setLazyRoot rebuilds and
  // re-observes them against the scroller — without which rootMargin is clipped
  // by .grid-scroll and the 2-page prefetch never triggers ahead of the viewport.
  useEffect(() => {
    setLazyRoot(scrollRef.current);
    return () => setLazyRoot(null);
  }, []);

  // notify caller whenever the flat asset list grows so it can update live views
  useEffect(() => {
    onAssetsChangeRef.current?.(flatRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Stable: reads `loaded` via ref, so it never changes identity. Passed to
  // every section as-is.
  const ensureBucket = useCallback(
    (tb: string) => {
      if (loadedRef.current[tb] || loadingRef.current.has(tb)) return;
      loadingRef.current.add(tb);
      loadBucket(tb)
        .then((cols) => setLoaded((m) => ({ ...m, [tb]: flattenBucket(cols) })))
        .catch((e) => reportError(new Error(`Failed to load bucket ${tb}: ${e?.message ?? e}`)))
        .finally(() => loadingRef.current.delete(tb));
    },
    [loadBucket],
  );

  // Stable: resolves the bucket-local index to a global one against the latest
  // flat list (read from refs) at click time.
  const handleOpen = useCallback((tb: string, localIdx: number) => {
    onOpenRef.current(flatRef.current, (offsetRef.current[tb] ?? 0) + localIdx);
  }, []);

  // flat list of everything loaded, for fullscreen traversal. Stored in refs so
  // the stable handleOpen sees current values; only array refs are copied here,
  // no vnode work, so this stays cheap.
  const flat: Asset[] = [];
  const offsetOf: Record<string, number> = {};
  for (const b of buckets) {
    offsetOf[b.timeBucket] = flat.length;
    const arr = loaded[b.timeBucket];
    if (arr) for (const a of arr) flat.push(a);
  }
  flatRef.current = flat;
  offsetRef.current = offsetOf;

  if (error) return <div class="msg error">{error}</div>;
  if (!buckets.length) {
    return fetched ? (
      <EmptyState title={emptyLabel ?? 'Nothing here yet'} hint={emptyHint} />
    ) : (
      <div class="msg">Loading…</div>
    );
  }

  return (
    <div
      class="grid-scroll"
      ref={scrollRef}
      // Clicking empty space (gaps, padding, bucket titles) would otherwise
      // move focus to <body> and drop the focus ring off the current thumbnail.
      // Suppressing focus shift on mousedown for non-focusable targets keeps the
      // last thumbnail focused; clicks that land on a thumb still focus/open it.
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest('[data-focusable]')) e.preventDefault();
      }}
    >
      {buckets.map((b) => (
        <BucketSection
          key={b.timeBucket}
          bucket={b}
          assets={loaded[b.timeBucket]}
          width={width}
          rowH={rowH}
          ensureBucket={ensureBucket}
          onOpen={handleOpen}
        />
      ))}
    </div>
  );
}

const BucketSection = memo(function BucketSection({
  bucket,
  assets,
  width,
  rowH,
  ensureBucket,
  onOpen,
}: {
  bucket: TimeBucket;
  assets?: Asset[];
  width: number;
  rowH: number;
  ensureBucket: (tb: string) => void;
  onOpen: (tb: string, localIdx: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tb = bucket.timeBucket;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    bucketObserver.observe(el, (inside) => {
      if (inside) ensureBucket(tb);
    });
    return () => bucketObserver.unobserve(el);
  }, [tb, ensureBucket]);

  // Pack consecutive day-groups into shared rows when they fit.
  // A day is merged into the current unit only if:
  //   1. combined ratioSum fits in one row at rowH (with separator pixels deducted)
  //   2. pixel gap between the last label and the new label >= MIN_LABEL_WIDTH
  const days = assets ? groupByDay(assets) : [];
  const units: Asset[][] = [];
  if (days.length) {
    let cur: Asset[] = [];
    let curRatioSum = 0;
    let lastLabelRatioSum = 0; // ratio offset of the most-recent day label
    let curSeps = 0;           // separator divs already in cur
    for (const day of days) {
      const dayRatioSum = day.assets.reduce((s, a) => s + Math.max(a.ratio, 0.1), 0);
      if (cur.length === 0) {
        cur = day.assets.slice();
        curRatioSum = dayRatioSum;
        lastLabelRatioSum = 0;
        curSeps = 0;
      } else {
        // effWidth: container minus the separator divs that will be rendered
        const effWidth = width - (curSeps + 1) * (DAY_SEP + GAP);
        const mergedTotal = curRatioSum + dayRatioSum;
        // pixel distance between the last label and this new label in the merged row
        const labelGap = (curRatioSum - lastLabelRatioSum) * effWidth / mergedTotal;
        if (mergedTotal <= effWidth / rowH && labelGap >= MIN_LABEL_WIDTH) {
          lastLabelRatioSum = curRatioSum;
          cur.push(...day.assets);
          curRatioSum = mergedTotal;
          curSeps++;
        } else {
          units.push(cur);
          cur = day.assets.slice();
          curRatioSum = dayRatioSum;
          lastLabelRatioSum = 0;
          curSeps = 0;
        }
      }
    }
    if (cur.length) units.push(cur);
  }

  let bucketIdx = 0;

  return (
    <section ref={ref} class="bucket">
      {assets ? (
        units.map((unitAssets, ui) => {
          const nSeps = Math.max(0, new Set(unitAssets.map((a) => dayKey(a.createdAt))).size - 1);
          const effWidth = width - nSeps * (DAY_SEP + GAP);
          const rows = justify(unitAssets, effWidth, rowH, GAP);
          let rowOffset = 0;
          let prevDk: string | undefined; // persists across rows — no duplicate labels
          const rowEls = rows.map((row, ri) => {
            const labels: Array<{ left: number; text: string }> = [];
            const rowChildren: preact.ComponentChildren[] = [];
            let cumX = 0;
            row.items.forEach((a, j) => {
              const dk = dayKey(a.createdAt);
              const isNewDay = dk !== prevDk;
              if (isNewDay && j > 0) {
                rowChildren.push(<div class="day-sep" key={`sep${j}`} />);
                cumX += DAY_SEP + GAP;
              }
              if (isNewDay) {
                labels.push({ left: cumX, text: formatDay(dk) });
                prevDk = dk;
              }
              const myIdx = bucketIdx + rowOffset + j;
              rowChildren.push(
                <Thumb
                  key={a.id}
                  assetId={a.id}
                  isVideo={a.isVideo}
                  duration={a.duration}
                  isLive={!!a.livePhotoVideoId}
                  width={a.w}
                  height={a.h}
                  onSelect={() => onOpen(tb, myIdx)}
                />,
              );
              cumX += a.w + GAP;
            });
            rowOffset += row.items.length;
            return (
              <div class="jrow-wrap" key={`${ui}-${ri}`}>
                {labels.length > 0 && (
                  <div class="jrow-header">
                    {labels.map((l) => (
                      <span class="day-label" style={{ left: `${l.left}px` }} key={l.text}>
                        {l.text}
                      </span>
                    ))}
                  </div>
                )}
                <div class="jrow" style={{ height: `${row.height}px` }}>{rowChildren}</div>
              </div>
            );
          });
          bucketIdx += unitAssets.length;
          return rowEls;
        })
      ) : (
        <>
          <h2 class="bucket-title">{formatBucket(tb)}</h2>
          {/* placeholder block sized from the known count so scroll height is
              stable. Estimate columns from the current row height (~square-ish
              cells) so the reserved height roughly matches the real layout. */}
          <div
            class="bucket-ph"
            style={{
              height: `${Math.ceil(Math.min(bucket.count, 60) / Math.max(3, Math.round(width / (rowH * 1.2)))) * (rowH + GAP)}px`,
            }}
          />
        </>
      )}
    </section>
  );
});

interface DayGroup {
  key: string; // YYYY-MM-DD
  base: number; // index of this group's first asset within the bucket
  assets: Asset[];
}

// Split a date-sorted bucket into consecutive same-calendar-day runs. `base`
// preserves each group's offset within the bucket so onOpen still maps to the
// correct flat index. Local calendar day (not UTC) so headers match the wall
// date the photo shows.
function groupByDay(assets: Asset[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let cur: DayGroup | null = null;
  for (let i = 0; i < assets.length; i++) {
    const key = dayKey(assets[i].createdAt);
    if (!cur || cur.key !== key) {
      cur = { key, base: i, assets: [] };
      groups.push(cur);
    }
    cur.assets.push(assets[i]);
  }
  return groups;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso || 'unknown';
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function formatDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return key;
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatBucket(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}
