import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { Asset, flattenBucket } from '../api/assets';
import { getTimelineBuckets, getBucket, thumbnailUrl, searchByType, TimeBucket } from '../api/client';
import { loadThumb, loadBlobUrl, revoke } from '../api/media';
import { Icon } from '../components/Icon';
import { IconName } from '../components/icons';
import { WallpaperPlayer } from './WallpaperPlayer';

interface Collection {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  // `type` drives the fast hero/cover sample (metadata search); `filter` is
  // applied to the timeline buckets the player streams from.
  type?: 'IMAGE' | 'VIDEO';
  filter: (a: Asset) => boolean;
}

// No combined photos+videos collection: videos play with their ORIGINAL audio
// (webOS has a single hardware media pipeline, so background music and video
// can't decode at once — see WallpaperPlayer), and mixing silent stills with
// full-audio clips made for a jarring show.
const COLLECTIONS: Collection[] = [
  { id: 'photos', label: 'Photos', hint: 'Images only', icon: 'wallpaper', type: 'IMAGE', filter: (a) => a.isImage },
  { id: 'videos', label: 'Videos', hint: 'Videos only', icon: 'playCircle', type: 'VIDEO', filter: (a) => a.isVideo },
];

interface Props {
  // register a back handler with the shell; returns true when it consumed Back
  backRef: { current: (() => boolean) | null };
  // tell the shell a fullscreen overlay owns the keys (disables its remote nav)
  onFullscreen: (active: boolean) => void;
}

// Wallpaper page: an Apple-TV-style browse surface. A full-bleed hero carousel
// on top previews the focused collection; a shelf of collection tiles sits
// below. Selecting a tile gathers that collection and launches the fullscreen
// slideshow directly.
export function Wallpaper({ backRef, onFullscreen }: Props) {
  const [focused, setFocused] = useState<Collection>(COLLECTIONS[0]);
  const [player, setPlayer] = useState<Asset[] | null>(null);
  const [playerMode, setPlayerMode] = useState<'photos' | 'videos'>('photos');
  const [preparing, setPreparing] = useState<Collection | null>(null);
  const homeRef = useRef<HTMLDivElement>(null);
  // bumped to cancel an in-flight prepare (Back pressed while preparing)
  const prepToken = useRef(0);
  // paged bucket cursor for the currently-playing collection: buckets load one
  // at a time as the slideshow nears the end, instead of all up front.
  const feed = useRef<{ buckets: TimeBucket[]; idx: number; filter: (a: Asset) => boolean; loading: boolean } | null>(null);

  // wire the shell's Back button to pop our internal state
  useEffect(() => {
    backRef.current = () => {
      if (player) {
        setPlayer(null);
        return true;
      }
      if (preparing) {
        prepToken.current++;
        setPreparing(null);
        return true;
      }
      return false;
    };
    return () => {
      backRef.current = null;
    };
  }, [backRef, player, preparing]);

  useEffect(() => {
    onFullscreen(!!player);
  }, [player, onFullscreen]);

  // prime 1a, 2a, 3a first, then fill each tile's rest in the background
  useEffect(() => {
    void primeHeroes(COLLECTIONS);
  }, []);

  // when returning to the home surface, land focus on a tile again
  useEffect(() => {
    if (player) return;
    setTimeout(() => {
      homeRef.current?.querySelector<HTMLElement>('[data-focusable]')?.focus();
    }, 0);
  }, [player]);

  // Pull the next bucket(s) until one yields assets matching the filter. Returns
  // that batch (empty when the collection is exhausted).
  const pullBatch = async (token: number): Promise<Asset[]> => {
    const f = feed.current;
    if (!f) return [];
    while (f.idx < f.buckets.length) {
      const cols = await getBucket(f.buckets[f.idx++].timeBucket).catch(() => null);
      if (prepToken.current !== token) return [];
      const add = cols ? flattenBucket(cols).filter(f.filter) : [];
      if (add.length) return add;
    }
    return [];
  };

  // onNearEnd: append the next batch to the live play list (guarded so overlapping
  // near-end fires don't double-load the same bucket).
  const loadMore = useCallback(async () => {
    const f = feed.current;
    if (!f || f.loading) return;
    f.loading = true;
    const add = await pullBatch(prepToken.current);
    if (add.length) setPlayer((prev) => (prev ? [...prev, ...add] : add));
    f.loading = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCollection = async (c: Collection) => {
    const token = ++prepToken.current;
    setPlayerMode(c.id === 'videos' ? 'videos' : 'photos');
    setPreparing(c);
    const buckets = await getTimelineBuckets().catch(() => [] as TimeBucket[]);
    if (prepToken.current !== token) return; // cancelled via Back
    feed.current = { buckets, idx: 0, filter: c.filter, loading: false };
    const first = await pullBatch(token); // just the first non-empty bucket
    if (prepToken.current !== token) return;
    setPreparing(null);
    if (first.length) setPlayer(first);
  };

  return (
    <div class="wp" ref={homeRef}>
      <Hero collection={focused} />
      <div class="wp-shelf">
        <h2 class="wp-shelf-title">Choose a source</h2>
        <div class="wp-tiles">
          {COLLECTIONS.map((c) => (
            <CollectionTile
              key={c.id}
              collection={c}
              onFocus={() => setFocused(c)}
              onOpen={() => openCollection(c)}
            />
          ))}
        </div>
      </div>

      {preparing && (
        <div class="wp-prep">
          <div class="fs-spinner" />
          <div class="wp-prep-text">Preparing {preparing.label}…</div>
        </div>
      )}

      {player && (
        <WallpaperPlayer assets={player} mode={playerMode} onExit={() => setPlayer(null)} onNearEnd={loadMore} />
      )}
    </div>
  );
}

// Fisher-Yates pick of up to `n` distinct random items (does not mutate input).
function pickRandom<T>(items: T[], n: number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// Per-collection hero cache, kept at module scope so it PERSISTS across tile
// switches (and Hero unmount/remount). Returning to a tile shows exactly the
// previews it already loaded — never a blank, never a fresh random shuffle.
const HERO_MAX = 6;
interface HeroState {
  pool: Asset[] | null; // candidate assets in a fixed random order
  cursor: number; // next pool index to attempt loading
  loaded: string[]; // preview object URLs loaded so far (kept for app lifetime)
  loading: boolean; // a fill() is in flight for this collection
}
const heroStore = new Map<string, HeroState>();
function heroState(id: string): HeroState {
  let s = heroStore.get(id);
  if (!s) {
    s = { pool: null, cursor: 0, loaded: [], loading: false };
    heroStore.set(id, s);
  }
  return s;
}

// Random candidate pool per collection via a single type-filtered metadata
// search (fast even for sparse types like Videos), fetched once and cached.
const poolCache = new Map<string, Promise<Asset[]>>();
function collectionPool(c: Collection): Promise<Asset[]> {
  let p = poolCache.get(c.id);
  if (!p) {
    p = searchByType(c.type)
      // skip assets with no generated thumbnail — they 404 on the preview endpoint
      .then((list) => pickRandom(list.filter((a) => a.thumbhash), list.length))
      .catch(() => []);
    poolCache.set(c.id, p);
  }
  return p;
}

// Clear all wallpaper caches (hero previews + collection pools) — call on
// logout/account switch so a new account doesn't see the old one's assets.
export function resetWallpaperCaches(): void {
  for (const s of heroStore.values()) s.loaded.forEach(revoke);
  heroStore.clear();
  poolCache.clear();
}

// re-render subscribers (the mounted Hero) whenever any collection's cache grows
const heroListeners = new Set<() => void>();
function heroEmit() {
  heroListeners.forEach((l) => l());
}

// Fill a collection's cache up to `max` previews, resuming from where a prior
// call stopped. Guarded against overlapping calls; skips unloadable assets.
// Loaded blobs persist for the app's life.
async function fillHero(c: Collection, max: number): Promise<void> {
  const st = heroState(c.id);
  if (st.loading || st.loaded.length >= max) return;
  st.loading = true;
  try {
    if (!st.pool) st.pool = await collectionPool(c);
    while (st.loaded.length < max && st.cursor < st.pool.length) {
      const a = st.pool[st.cursor++];
      try {
        st.loaded.push(await loadBlobUrl(thumbnailUrl(a.id, 'preview')));
        heroEmit();
      } catch {
        // unloadable — skip and try the next in the pool
      }
    }
  } finally {
    st.loading = false;
  }
}

// Prime pass: load the FIRST preview of every collection first (1a, 2a, 3a) so
// each tile has a hero image the instant it's focused, THEN fill the rest per
// tile in the background.
async function primeHeroes(collections: Collection[]): Promise<void> {
  for (const c of collections) await fillHero(c, 1);
  for (const c of collections) void fillHero(c, HERO_MAX);
}

// ---- Hero carousel: crossfading previews of the focused collection ----
// Only TWO <img> layers are ever mounted (not the whole set) so at most two 4K
// framebuffers are decoded at once — the rest of the previews stay as cheap
// compressed blobs. Rotating swaps the next preview into the hidden layer and
// crossfades to it.
function Hero({ collection }: { collection: Collection }) {
  const [, force] = useState(0);
  const [idx, setIdx] = useState(0);
  const st = heroState(collection.id);
  const srcs = st.loaded;

  const [layers, setLayers] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
  const [showA, setShowA] = useState(true);
  const showARef = useRef(true);

  // re-render as this (or any) collection's cache grows
  useEffect(() => {
    const l = () => force((v) => v + 1);
    heroListeners.add(l);
    return () => {
      heroListeners.delete(l);
    };
  }, []);

  // resume filling the focused collection to HERO_MAX (no-op if already full)
  useEffect(() => {
    void fillHero(collection, HERO_MAX);
  }, [collection]);

  // start each visit from the first cached preview of the focused collection
  useEffect(() => setIdx(0), [collection.id]);

  // rotate only among ALREADY-loaded previews (advances to the next once it exists)
  useEffect(() => {
    if (srcs.length < 2) return;
    const t = window.setInterval(() => setIdx((n) => (n + 1) % srcs.length), 6000);
    return () => window.clearInterval(t);
  }, [srcs.length]);

  // crossfade to the current preview by loading it into the hidden layer
  const curSrc = srcs[idx] ?? srcs[0] ?? null;
  useEffect(() => {
    if (!curSrc) return;
    const toA = !showARef.current; // reveal via the currently-hidden layer
    setLayers((prev) => (toA ? { a: curSrc, b: prev.b } : { a: prev.a, b: curSrc }));
    showARef.current = toA;
    setShowA(toA);
  }, [curSrc]);

  return (
    <div class="wp-hero">
      {layers.a && <img class={'wp-hero-img' + (showA ? ' on' : '')} src={layers.a} decoding="async" />}
      {layers.b && <img class={'wp-hero-img' + (!showA ? ' on' : '')} src={layers.b} decoding="async" />}
      <div class="wp-hero-scrim" />
      <div class="wp-hero-meta">
        <div class="wp-hero-kicker">
          <Icon name="wallpaper" size={22} />
          <span>Wallpaper</span>
        </div>
        <h1 class="wp-hero-title">{collection.label}</h1>
        <p class="wp-hero-hint">{collection.hint}</p>
      </div>
    </div>
  );
}

// ---- Collection tile with a lazily-loaded cover thumbnail ----
function CollectionTile({
  collection,
  onFocus,
  onOpen,
}: {
  collection: Collection;
  onFocus: () => void;
  onOpen: () => void;
}) {
  const [cover, setCover] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    collectionPool(collection).then(async (list) => {
      // pool is already shuffled — use the first thumbnail that actually loads
      for (const a of list) {
        if (!alive) return;
        try {
          const u = await loadThumb(a.id);
          if (!alive) return;
          setCover(u);
          return;
        } catch {
          // try the next candidate
        }
      }
    });
    return () => {
      alive = false;
    };
  }, [collection.id, collection.filter]);

  return (
    <button
      data-focusable
      class="wp-tile focusable"
      onFocus={onFocus}
      onClick={onOpen}
    >
      {cover ? <img class="wp-tile-img" src={cover} /> : <div class="thumb-ph" />}
      <span class="wp-tile-grad" />
      <span class="wp-tile-label">
        <Icon name={collection.icon} size={22} />
        {collection.label}
      </span>
    </button>
  );
}
