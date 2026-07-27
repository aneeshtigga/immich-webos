import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { Asset, flattenBucket } from '../api/assets';
import {
  getTimelineBuckets,
  getBucket,
  getAlbums,
  getAlbumBuckets,
  getAlbumBucket,
  thumbnailUrl,
  searchByType,
  TimeBucket,
  Album,
} from '../api/client';
import { loadThumb, loadBlobUrl, revoke } from '../api/media';
import { Icon } from '../components/Icon';
import { IconName } from '../components/icons';
import { WallpaperPlayer } from './WallpaperPlayer';
import { aimAtFaces } from './faceCrop';
import { EmptyState } from '../components/EmptyState';

interface Collection {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  // `type` drives the fast hero/cover sample (metadata search) for the whole
  // library; `filter` is applied to the buckets the player streams from.
  type?: 'IMAGE' | 'VIDEO';
  // When set, this source streams a single album instead of the whole timeline:
  // buckets come from the album endpoints and the hero/cover pool is sampled
  // from the album's own assets.
  albumId?: string;
  // Direct tile-cover asset (album thumbnail). Lets the tile show a cover from a
  // single thumbnail fetch WITHOUT triggering the collection's full pool — that
  // pool (an album walks up to 40 assets) is deferred until the hero needs it.
  coverAssetId?: string;
  filter: (a: Asset) => boolean;
}

// No combined photos+videos collection: videos play with their ORIGINAL audio
// (webOS has a single hardware media pipeline, so background music and video
// can't decode at once — see WallpaperPlayer), and mixing silent stills with
// full-audio clips made for a jarring show.
const BASE_COLLECTIONS: Collection[] = [
  { id: 'photos', label: 'Photos', hint: 'Images only', icon: 'wallpaper', type: 'IMAGE', filter: (a) => a.isImage },
  { id: 'videos', label: 'Videos', hint: 'Videos only', icon: 'playCircle', type: 'VIDEO', filter: (a) => a.isVideo },
];

// Album source: images only (same no-mix rationale as above — an album's clips
// would otherwise interrupt the silent slideshow with audio), so it plays in
// 'photos' mode. assetCount is the whole album; the images-only show may be
// shorter, which is fine.
function albumCollection(a: Album): Collection {
  return {
    id: 'album:' + a.id,
    label: a.albumName,
    hint: a.assetCount + (a.assetCount === 1 ? ' item' : ' items'),
    icon: 'albums',
    albumId: a.id,
    coverAssetId: a.albumThumbnailAssetId ?? undefined,
    filter: (asset) => asset.isImage,
  };
}

// Bucket source per collection: album endpoints when albumId is set, else the
// whole-library timeline. Same columnar shape either way, so the player is
// agnostic.
const bucketsFor = (c: Collection): Promise<TimeBucket[]> =>
  c.albumId ? getAlbumBuckets(c.albumId) : getTimelineBuckets();
const bucketFor = (c: Collection, tb: string) =>
  c.albumId ? getAlbumBucket(c.albumId, tb) : getBucket(tb);

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
  // Photos/Videos always; user albums appended once /albums resolves.
  const [collections, setCollections] = useState<Collection[]>(BASE_COLLECTIONS);
  const [focused, setFocused] = useState<Collection>(BASE_COLLECTIONS[0]);
  const [player, setPlayer] = useState<Asset[] | null>(null);
  const [playerMode, setPlayerMode] = useState<'photos' | 'videos'>('photos');
  const [preparing, setPreparing] = useState<Collection | null>(null);
  const [emptySource, setEmptySource] = useState<Collection | null>(null);
  const homeRef = useRef<HTMLDivElement>(null);
  // bumped to cancel an in-flight prepare (Back pressed while preparing)
  const prepToken = useRef(0);
  // paged bucket cursor for the currently-playing collection: buckets load one
  // at a time as the slideshow nears the end, instead of all up front. `col` is
  // kept so the pager knows which endpoint (timeline vs album) to fetch from.
  const feed = useRef<{ col: Collection; buckets: TimeBucket[]; idx: number; filter: (a: Asset) => boolean; loading: boolean } | null>(null);
  // Debounce hero updates: while the user is moving between tiles, the focus
  // transition should own the main thread. Only once movement settles (~280ms
  // of no new focus) do we swap the focused collection, which is what triggers
  // the hero's (lazy) preview load and crossfade. Prevents the big 4K decode
  // from competing with the focus animation on every d-pad press.
  const focusDebounce = useRef<number | undefined>(undefined);
  const requestHero = useCallback((c: Collection) => {
    window.clearTimeout(focusDebounce.current);
    focusDebounce.current = window.setTimeout(() => setFocused(c), 280);
  }, []);
  useEffect(() => () => window.clearTimeout(focusDebounce.current), []);

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
      if (emptySource) {
        setEmptySource(null);
        return true;
      }
      return false;
    };
    return () => {
      backRef.current = null;
    };
  }, [backRef, player, preparing, emptySource]);

  useEffect(() => {
    onFullscreen(!!player);
  }, [player, onFullscreen]);

  // Load user albums once and append them as sources. Only non-empty albums
  // (an empty album has no cover and no show).
  useEffect(() => {
    let alive = true;
    getAlbums()
      .then((albums) => {
        if (!alive) return;
        const cols = albums.filter((a) => a.assetCount > 0).map(albumCollection);
        if (cols.length) setCollections([...BASE_COLLECTIONS, ...cols]);
      })
      .catch(() => {}); // albums unavailable: just keep Photos/Videos
    return () => {
      alive = false;
    };
  }, []);

  // Hero previews load lazily: the mounted Hero fills only the focused
  // collection (see its effect), so we no longer eagerly load every source's 4K
  // preview up front. Tile covers still show immediately from a single cheap
  // thumbnail. This keeps navigation resources free for the focus transition.

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
      const cols = await bucketFor(f.col, f.buckets[f.idx++].timeBucket).catch(() => null);
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

  // Shuffle toggled in the player: reorder the NOT-YET-CONSUMED buckets so the
  // pages that stream in next are sampled from across the whole timeline (a
  // library-wide bound), not just the chronological tail. Off restores
  // chronological order. Already-loaded assets are permuted by the player.
  const onShuffleChange = useCallback((on: boolean) => {
    const f = feed.current;
    if (!f) return;
    const rest = f.buckets.slice(f.idx);
    if (on) {
      for (let k = rest.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [rest[k], rest[j]] = [rest[j], rest[k]];
      }
    } else {
      rest.sort((a, b) => (a.timeBucket < b.timeBucket ? 1 : -1)); // newest first
    }
    f.buckets = [...f.buckets.slice(0, f.idx), ...rest];
  }, []);

  const openCollection = async (c: Collection) => {
    const token = ++prepToken.current;
    setEmptySource(null);
    setPlayerMode(c.id === 'videos' ? 'videos' : 'photos');
    setPreparing(c);
    const buckets = await bucketsFor(c).catch(() => [] as TimeBucket[]);
    if (prepToken.current !== token) return; // cancelled via Back
    feed.current = { col: c, buckets, idx: 0, filter: c.filter, loading: false };
    const first = await pullBatch(token); // just the first non-empty bucket
    if (prepToken.current !== token) return;
    setPreparing(null);
    if (first.length) setPlayer(first);
    else setEmptySource(c); // nothing matched this source
  };

  return (
    <div class="wp" ref={homeRef}>
      <Hero collection={focused} />
      <div class="wp-shelf">
        <h2 class="wp-shelf-title">Choose a source</h2>
        <div class="wp-tiles">
          {collections.map((c) => (
            <CollectionTile
              key={c.id}
              collection={c}
              onFocus={() => requestHero(c)}
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

      {emptySource && (
        <div class="wp-prep">
          <EmptyState
            title={`No ${emptySource.label.toLowerCase()} to show`}
            hint="Add photos or videos to your Immich library to use them as wallpaper."
          />
        </div>
      )}

      {player && (
        <WallpaperPlayer
          assets={player}
          mode={playerMode}
          onExit={() => setPlayer(null)}
          onNearEnd={loadMore}
          onShuffleChange={onShuffleChange}
        />
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
interface HeroPreview {
  url: string; // preview object URL
  id: string; // asset id (for face-aware cropping)
}
interface HeroState {
  pool: Asset[] | null; // candidate assets in a fixed random order
  cursor: number; // next pool index to attempt loading
  loaded: HeroPreview[]; // previews loaded so far (kept for app lifetime)
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

// Random candidate pool per collection, fetched once and cached. Whole-library
// sources use a single type-filtered metadata search (fast even for sparse types
// like Videos); album sources sample the album's own buckets.
const poolCache = new Map<string, Promise<Asset[]>>();
function collectionPool(c: Collection): Promise<Asset[]> {
  let p = poolCache.get(c.id);
  if (!p) {
    p = (c.albumId ? albumPool(c) : searchByType(c.type))
      // skip assets with no generated thumbnail — they 404 on the preview endpoint
      .then((list) => pickRandom(list.filter((a) => a.thumbhash && c.filter(a)), list.length))
      .catch(() => []);
    poolCache.set(c.id, p);
  }
  return p;
}

// Gather an album's assets for the hero/cover pool by walking its buckets.
// Capped so a huge album doesn't fetch everything just to seed a few previews.
async function albumPool(c: Collection): Promise<Asset[]> {
  const buckets = await getAlbumBuckets(c.albumId!).catch(() => [] as TimeBucket[]);
  const out: Asset[] = [];
  for (let i = 0; i < buckets.length && out.length < 40; i++) {
    const cols = await getAlbumBucket(c.albumId!, buckets[i].timeBucket).catch(() => null);
    if (cols) out.push(...flattenBucket(cols));
  }
  return out;
}

// Clear all wallpaper caches (hero previews + collection pools) — call on
// logout/account switch so a new account doesn't see the old one's assets.
export function resetWallpaperCaches(): void {
  for (const s of heroStore.values()) s.loaded.forEach((p) => revoke(p.url));
  heroStore.clear();
  heroLRU.length = 0;
  poolCache.clear();
}

// re-render subscribers (the mounted Hero) whenever any collection's cache grows
const heroListeners = new Set<() => void>();
function heroEmit() {
  heroListeners.forEach((l) => l());
}

// Hero preview blobs are 4K and uncached (unlike thumbnails), so retaining every
// visited collection's set would grow unbounded once albums are in the mix (many
// sources x HERO_MAX). Keep only the few most-recently-focused collections'
// previews; evict the rest (revoking their object URLs). Base sources
// (Photos/Videos) are pinned so their heroes stay instant.
const HERO_KEEP = 4;
const heroLRU: string[] = [];
function touchHero(id: string): void {
  const i = heroLRU.indexOf(id);
  if (i >= 0) heroLRU.splice(i, 1);
  heroLRU.push(id);
  while (heroLRU.length > HERO_KEEP) {
    const victim = heroLRU.shift()!;
    if (victim === 'photos' || victim === 'videos') {
      heroLRU.push(victim); // pinned: never evict the base sources
      continue;
    }
    const st = heroStore.get(victim);
    if (st) {
      st.loaded.forEach((p) => revoke(p.url));
      heroStore.delete(victim); // next visit reloads from scratch
    }
  }
}

// Fill a collection's cache up to `max` previews, resuming from where a prior
// call stopped. Guarded against overlapping calls; skips unloadable assets.
async function fillHero(c: Collection, max: number): Promise<void> {
  const st = heroState(c.id);
  touchHero(c.id); // mark most-recently-used (also evicts stale collections)
  if (st.loading || st.loaded.length >= max) return;
  st.loading = true;
  try {
    if (!st.pool) st.pool = await collectionPool(c);
    while (st.loaded.length < max && st.cursor < st.pool.length) {
      const a = st.pool[st.cursor++];
      try {
        st.loaded.push({ url: await loadBlobUrl(thumbnailUrl(a.id, 'preview')), id: a.id });
        heroEmit();
      } catch {
        // unloadable — skip and try the next in the pool
      }
    }
  } finally {
    st.loading = false;
  }
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

  const [layers, setLayers] = useState<{ a: HeroPreview | null; b: HeroPreview | null }>({ a: null, b: null });
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

  // Load just ONE preview up front so the hero shows immediately on focus, then
  // top up to HERO_MAX (for the crossfade rotation) lazily a beat later. Loading
  // all six per focus was the fetch/createObjectURL/GC churn while browsing —
  // most tiles are passed through, not lingered on, so their extra previews were
  // decoded for nothing. The top-up is cancelled if focus moves on first.
  useEffect(() => {
    let topUp = 0;
    void fillHero(collection, 1);
    topUp = window.setTimeout(() => void fillHero(collection, HERO_MAX), 1200);
    return () => window.clearTimeout(topUp);
  }, [collection]);

  // start each visit from the first cached preview of the focused collection
  useEffect(() => setIdx(0), [collection.id]);

  // rotate only among ALREADY-loaded previews (advances to the next once it exists)
  useEffect(() => {
    if (srcs.length < 2) return;
    const t = window.setInterval(() => setIdx((n) => (n + 1) % srcs.length), 6000);
    return () => window.clearInterval(t);
  }, [srcs.length]);

  // Crossfade: load the current preview into the hidden layer, but DON'T reveal
  // it yet — flip the crossfade only once that layer's image has actually
  // decoded (its onLoad below). This avoids fading to a blank/half-painted layer
  // and, with the focus debounce upstream, means the 4K decode never starts
  // mid-navigation. `reveal` records which layer is waiting to be shown.
  const curSrc = srcs[idx] ?? srcs[0] ?? null;
  const reveal = useRef<'a' | 'b' | null>(null);
  useEffect(() => {
    if (!curSrc) return;
    const toA = !showARef.current; // load into the currently-hidden layer
    showARef.current = toA;
    reveal.current = toA ? 'a' : 'b';
    setLayers((prev) => (toA ? { a: curSrc, b: prev.b } : { a: prev.a, b: curSrc }));
  }, [curSrc?.url]);

  // aim each layer's cover crop at faces once it has decoded (natural size known)
  const aim = (e: Event, p: HeroPreview) => void aimAtFaces(e.currentTarget as HTMLImageElement, p.id);
  // once the layer awaiting reveal has decoded, run the crossfade to it
  const onLayerLoad = (e: Event, p: HeroPreview, layer: 'a' | 'b') => {
    aim(e, p);
    if (reveal.current === layer) {
      setShowA(layer === 'a');
      reveal.current = null;
    }
  };

  return (
    <div class="wp-hero">
      {layers.a && (
        <img
          class={'wp-hero-img' + (showA ? ' on' : '')}
          src={layers.a.url}
          decoding="async"
          onLoad={(e) => onLayerLoad(e, layers.a!, 'a')}
        />
      )}
      {layers.b && (
        <img
          class={'wp-hero-img' + (!showA ? ' on' : '')}
          src={layers.b.url}
          decoding="async"
          onLoad={(e) => onLayerLoad(e, layers.b!, 'b')}
        />
      )}
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
    // Prefer a direct cover asset (album thumbnail): one cheap thumbnail fetch,
    // and it does NOT trigger the collection's full pool — so an album's up-to-40
    // asset walk stays deferred until its hero is actually focused.
    if (collection.coverAssetId) {
      loadThumb(collection.coverAssetId)
        .then((u) => alive && setCover(u))
        .catch(() => {}); // fall through to nothing; tile shows the placeholder
      return () => {
        alive = false;
      };
    }
    // Photos/Videos (no direct cover): first thumbnail that loads from the pool.
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
  }, [collection.id, collection.filter, collection.coverAssetId]);

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
