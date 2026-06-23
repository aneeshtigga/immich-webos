import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { memo } from 'preact/compat';
import { TimeBucket, BucketColumns } from '../api/client';
import { Asset, flattenBucket } from '../api/assets';
import { Thumb } from './Thumb';
import { bucketObserver } from './lazyObserver';
import { justify } from './justified';

interface Props {
  // loaders injected so the same grid serves timeline / albums / favorites
  loadBuckets: () => Promise<TimeBucket[]>;
  loadBucket: (timeBucket: string) => Promise<BucketColumns>;
  onOpen: (assets: Asset[], index: number) => void;
}

const GAP = 6;

// Target justified-row height as a fraction of viewport height. The webOS
// viewport is a fixed 1280x720 logical canvas (see index.html), so a desktop
// pixel size like 170px renders tiny from TV-couch distance. Sizing the row to
// ~26% of viewport height yields ~3 comfortably large rows on screen — a proper
// 10-foot UI — and tracks the viewport if it ever changes.
function targetRowHeight(): number {
  const h = window.innerHeight || 720;
  return Math.round(Math.max(200, Math.min(320, h * 0.26)));
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
export function PhotoGrid({ loadBuckets, loadBucket, onOpen }: Props) {
  const [buckets, setBuckets] = useState<TimeBucket[]>([]);
  const [loaded, setLoaded] = useState<Record<string, Asset[]>>({});
  const [error, setError] = useState('');
  const [width, setWidth] = useState(window.innerWidth - 96);
  const [rowH, setRowH] = useState(targetRowHeight());
  const loadingRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Refs mirror the latest state so the stable callbacks below can read current
  // values without being recreated (which would defeat the memo on sections).
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const flatRef = useRef<Asset[]>([]);
  const offsetRef = useRef<Record<string, number>>({});

  useEffect(() => {
    loadBuckets()
      .then(setBuckets)
      .catch((e) => setError(e?.message || 'Failed to load timeline'));
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

  // Stable: reads `loaded` via ref, so it never changes identity. Passed to
  // every section as-is.
  const ensureBucket = useCallback(
    (tb: string) => {
      if (loadedRef.current[tb] || loadingRef.current.has(tb)) return;
      loadingRef.current.add(tb);
      loadBucket(tb)
        .then((cols) => setLoaded((m) => ({ ...m, [tb]: flattenBucket(cols) })))
        .catch(() => {})
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
  if (!buckets.length) return <div class="msg">Loading…</div>;

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
    bucketObserver.observe(el, () => ensureBucket(tb));
    return () => bucketObserver.unobserve(el);
  }, [tb, ensureBucket]);

  // Server buckets are monthly; subdivide into calendar-day groups for finer
  // headers (assets arrive date-sorted, so consecutive same-day runs group
  // cleanly). `base` is the running bucket-local index so fullscreen traversal
  // still indexes into the flat per-bucket asset list.
  const days = assets ? groupByDay(assets) : [];

  return (
    <section ref={ref} class="bucket">
      {assets ? (
        days.map((day) => {
          const rows = justify(day.assets, width, rowH, GAP);
          let idx = day.base; // bucket-local index of the first asset this day
          return (
            <div class="day" key={day.key}>
              <h2 class="bucket-title">{formatDay(day.key)}</h2>
              {rows.map((row, ri) => (
                <div class="jrow" key={ri} style={{ height: `${row.height}px` }}>
                  {row.items.map((a) => {
                    const myIdx = idx++;
                    return (
                      <Thumb
                        key={a.id}
                        assetId={a.id}
                        isVideo={a.isVideo}
                        duration={a.duration}
                        width={a.w}
                        height={a.h}
                        onSelect={() => onOpen(tb, myIdx)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          );
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
