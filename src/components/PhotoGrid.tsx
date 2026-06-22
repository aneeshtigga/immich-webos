import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { TimeBucket, BucketColumns } from '../api/client';
import { Asset, flattenBucket } from '../api/assets';
import { Thumb } from './Thumb';
import { justify } from './justified';

interface Props {
  // loaders injected so the same grid serves timeline / albums / favorites
  loadBuckets: () => Promise<TimeBucket[]>;
  loadBucket: (timeBucket: string) => Promise<BucketColumns>;
  onOpen: (assets: Asset[], index: number) => void;
}

const TARGET_ROW_HEIGHT = 170; // px, close to Immich web default
const GAP = 6;

// Date-bucketed, justified-row photo grid (Immich timeline look). Buckets load
// lazily as their header nears the viewport; loaded assets are concatenated so
// fullscreen left/right traverses everything loaded.
export function PhotoGrid({ loadBuckets, loadBucket, onOpen }: Props) {
  const [buckets, setBuckets] = useState<TimeBucket[]>([]);
  const [loaded, setLoaded] = useState<Record<string, Asset[]>>({});
  const [error, setError] = useState('');
  const [width, setWidth] = useState(window.innerWidth - 96);
  const loadingRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadBuckets()
      .then(setBuckets)
      .catch((e) => setError(e?.message || 'Failed to load timeline'));
  }, [loadBuckets]);

  useEffect(() => {
    const onResize = () => {
      if (scrollRef.current) setWidth(scrollRef.current.clientWidth - 32);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const ensureBucket = useCallback(
    (tb: string) => {
      if (loaded[tb] || loadingRef.current.has(tb)) return;
      loadingRef.current.add(tb);
      loadBucket(tb)
        .then((cols) => setLoaded((m) => ({ ...m, [tb]: flattenBucket(cols) })))
        .catch(() => {})
        .finally(() => loadingRef.current.delete(tb));
    },
    [loaded, loadBucket],
  );

  // flat list of everything loaded, for fullscreen traversal
  const flat: Asset[] = [];
  const offsetOf: Record<string, number> = {};
  for (const b of buckets) {
    offsetOf[b.timeBucket] = flat.length;
    const arr = loaded[b.timeBucket];
    if (arr) flat.push(...arr);
  }

  if (error) return <div class="msg error">{error}</div>;
  if (!buckets.length) return <div class="msg">Loading…</div>;

  return (
    <div class="grid-scroll" ref={scrollRef}>
      {buckets.map((b) => (
        <BucketSection
          key={b.timeBucket}
          bucket={b}
          assets={loaded[b.timeBucket]}
          width={width}
          onNear={() => ensureBucket(b.timeBucket)}
          onOpen={(localIdx) => onOpen(flat, offsetOf[b.timeBucket] + localIdx)}
        />
      ))}
    </div>
  );
}

function BucketSection({
  bucket,
  assets,
  width,
  onNear,
  onOpen,
}: {
  bucket: TimeBucket;
  assets?: Asset[];
  width: number;
  onNear: () => void;
  onOpen: (localIdx: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onNear();
      },
      { rootMargin: '700px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onNear]);

  const rows = assets ? justify(assets, width, TARGET_ROW_HEIGHT, GAP) : [];
  // index counter across rows so onOpen gets the bucket-local position
  let idx = 0;

  return (
    <section ref={ref} class="bucket">
      <h2 class="bucket-title">{formatBucket(bucket.timeBucket)}</h2>
      {assets ? (
        rows.map((row, ri) => (
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
                  onSelect={() => onOpen(myIdx)}
                />
              );
            })}
          </div>
        ))
      ) : (
        // placeholder block sized from the known count so scroll height is stable
        <div
          class="bucket-ph"
          style={{
            height: `${Math.ceil(Math.min(bucket.count, 60) / 6) * (TARGET_ROW_HEIGHT + GAP)}px`,
          }}
        />
      )}
    </section>
  );
}

function formatBucket(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}
