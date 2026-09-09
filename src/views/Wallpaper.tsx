import { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'preact/hooks';
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
  BucketColumns,
  Order,
} from '../api/client';
import { loadThumb, loadBlobUrl, revoke } from '../api/media';
import { Icon } from '../components/Icon';
import { IconName } from '../components/icons';
import { WallpaperPlayer } from './WallpaperPlayer';
import { aimAtFaces } from './faceCrop';
import { EmptyState } from '../components/EmptyState';
import { Key } from '../nav/keys';

interface Collection {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  // `type` drives the fast hero/cover sample (metadata search); `filter` is
  // applied to the buckets the player streams from.
  type?: 'IMAGE' | 'VIDEO';
  filter: (a: Asset) => boolean;
  // When set, this source is a single album: the feed streams that album's
  // buckets (in `order`, ascending by default) instead of the whole timeline,
  // and the hero/cover sample from the album rather than a type search.
  albumId?: string;
  // Cover thumbnail id for album tiles (the album's own thumbnail), so the tile
  // doesn't have to fetch a whole pool just to show a cover.
  coverId?: string;
  // Playback order for this source. Albums default to 'asc' (oldest first);
  // the timeline collections stay 'desc' (newest first).
  order?: Order;
}

// No combined photos+videos collection: videos play with their ORIGINAL audio
// (webOS has a single hardware media pipeline, so background music and video
// can't decode at once — see WallpaperPlayer), and mixing silent stills with
// full-audio clips made for a jarring show.
const COLLECTIONS: Collection[] = [
  { id: 'photos', label: 'Photos', hint: 'All photos', icon: 'wallpaper', type: 'IMAGE', filter: (a) => a.isImage },
  { id: 'videos', label: 'Videos', hint: 'All videos', icon: 'playCircle', type: 'VIDEO', filter: (a) => a.isVideo },
];

// LEFT_INSET is where the selected tile is pinned: the shelf's left padding, so
// it lines up under the "Choose a source" title (must match .wp-shelf
// padding-left). Tiles render in a fixed row and the whole track slides so the
// selected one reaches LEFT_INSET; earlier tiles physically sit to its left
// (full-bleed strip), so the slide animates smoothly.
const LEFT_INSET = 142;

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
  // Fixed timeline sources first, then one tile per album (loaded async). Albums
  // play oldest-first (order 'asc'); photos are images only.
  const [collections, setCollections] = useState<Collection[]>(COLLECTIONS);
  // Carousel: the SELECTED source is pinned to the left; left/right slide the
  // whole strip rather than moving focus. For a seamless loop we render THREE
  // copies of the list and track a CONTINUOUS position `pos`; the real selected
  // index is `pos mod n`. After a slide that runs off the center copy we
  // silently recenter (jump by n tiles with no animation — invisible because
  // the copies are identical). See the layout effect + onTransitionEnd below.
  const [pos, setPos] = useState(0);
  const skipAnim = useRef(false);
  const prevLen = useRef(0);
  const [focused, setFocused] = useState<Collection>(COLLECTIONS[0]);
  const [player, setPlayer] = useState<Asset[] | null>(null);
  const [playerMode, setPlayerMode] = useState<'photos' | 'videos'>('photos');
  const [preparing, setPreparing] = useState<Collection | null>(null);
  const [emptySource, setEmptySource] = useState<Collection | null>(null);
  const homeRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // bumped to cancel an in-flight prepare (Back pressed while preparing)
  const prepToken = useRef(0);
  // paged bucket cursor for the currently-playing collection: buckets load one
  // at a time as the slideshow nears the end, instead of all up front.
  const feed = useRef<{
    buckets: TimeBucket[];
    idx: number;
    filter: (a: Asset) => boolean;
    loading: boolean;
    order: Order; // drives the shuffle-off resort direction
    fetchBucket: (timeBucket: string) => Promise<BucketColumns | null>;
  } | null>(null);

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

  // prime the fixed tiles' heroes first (albums fill lazily on focus, so a big
  // album list doesn't fire a fetch storm on mount)
  useEffect(() => {
    void primeHeroes(COLLECTIONS);
  }, []);

  // append one source tile per album (photos, oldest-first)
  useEffect(() => {
    let alive = true;
    getAlbums()
      .then((albums) => {
        if (!alive) return;
        const albumCols: Collection[] = albums
          .filter((a) => a.assetCount > 0)
          .map((a) => ({
            id: 'album:' + a.id,
            label: a.albumName,
            hint: `Album • ${a.assetCount} ${a.assetCount === 1 ? 'item' : 'items'}`,
            icon: 'albums' as IconName,
            filter: (asset: Asset) => asset.isImage,
            albumId: a.id,
            coverId: a.albumThumbnailAssetId ?? undefined,
            order: 'asc' as Order,
          }));
        setCollections([...COLLECTIONS, ...albumCols]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // when returning to the home surface, land focus on a tile again
  useEffect(() => {
    if (player) return;
    setTimeout(() => {
      homeRef.current?.querySelector<HTMLElement>('[data-focusable]')?.focus();
    }, 0);
  }, [player]);

  const n = collections.length;
  const realIndex = n ? (((pos % n) + n) % n) : 0;

  // hero follows the selected collection
  useEffect(() => {
    if (n) setFocused(collections[realIndex]);
  }, [realIndex, collections, n]);

  // Slide the track so the selected tile sits at LEFT_INSET. Normally animated
  // (CSS transition on .wp-track); when recentering after a loop we suppress the
  // animation for one frame so the jump is invisible. Also keep focus on the
  // selected tile while navigating the carousel (not when focus is elsewhere).
  useLayoutEffect(() => {
    const track = trackRef.current;
    const sel = track?.querySelector<HTMLElement>('.wp-tile.selected');
    if (!track || !sel) return;
    // the tile list grew (albums loaded) — reposition without a slide
    if (prevLen.current !== n) {
      prevLen.current = n;
      skipAnim.current = true;
    }
    if (skipAnim.current) {
      track.style.transition = 'none';
      track.style.transform = `translateX(${LEFT_INSET - sel.offsetLeft}px)`;
      void track.offsetWidth; // force reflow so the next change animates again
      track.style.transition = '';
      skipAnim.current = false;
    } else {
      track.style.transform = `translateX(${LEFT_INSET - sel.offsetLeft}px)`;
    }
    const ae = document.activeElement as HTMLElement | null;
    if (!player && ae && ae.classList.contains('wp-tile') && ae !== sel) sel.focus();
  }, [pos, collections, player]);

  // After a slide that ran past the center copy, recenter pos into [0,n) with no
  // animation (the copies are identical, so it's invisible) — seamless loop.
  const onTrackTransitionEnd = useCallback(() => {
    if (n && (pos < 0 || pos >= n)) {
      skipAnim.current = true;
      setPos(realIndex);
    }
  }, [pos, n, realIndex]);

  // left/right slide the strip by one (continuous; recenter keeps it looping)
  const rotate = useCallback((delta: number) => setPos((p) => p + delta), []);
  // left/right rotate the strip instead of moving focus; stopPropagation keeps
  // the global nav from also acting (e.g. left-edge opening the sidebar).
  // Inert while the slideshow player is open — the background tile keeps DOM
  // focus, so without this its keydown would swallow the player's own left/right
  // (advancing the show) and rotate the hidden carousel instead.
  const onTileKey = useCallback(
    (e: KeyboardEvent) => {
      if (player) return;
      if (e.keyCode === Key.Left) {
        e.preventDefault();
        e.stopPropagation();
        rotate(-1);
      } else if (e.keyCode === Key.Right) {
        e.preventDefault();
        e.stopPropagation();
        rotate(1);
      }
    },
    [rotate, player],
  );

  // Pull the next bucket(s) until one yields assets matching the filter. Returns
  // that batch (empty when the collection is exhausted).
  const pullBatch = async (token: number): Promise<Asset[]> => {
    const f = feed.current;
    if (!f) return [];
    while (f.idx < f.buckets.length) {
      const cols = await f.fetchBucket(f.buckets[f.idx++].timeBucket).catch(() => null);
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
    } else if (f.order === 'asc') {
      rest.sort((a, b) => (a.timeBucket < b.timeBucket ? -1 : 1)); // oldest first
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
    // Album source: stream that album's buckets in `order` (asc default).
    // Timeline source: the whole library, newest first (as before).
    const order: Order = c.order ?? 'desc';
    const buckets = await (c.albumId
      ? getAlbumBuckets(c.albumId, order)
      : getTimelineBuckets(order)
    ).catch(() => [] as TimeBucket[]);
    if (prepToken.current !== token) return; // cancelled via Back
    const albumId = c.albumId;
    const fetchBucket = albumId
      ? (tb: string) => getAlbumBucket(albumId, tb, order)
      : (tb: string) => getBucket(tb, order);
    feed.current = { buckets, idx: 0, filter: c.filter, loading: false, order, fetchBucket };
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
          <div class="wp-track" ref={trackRef} onTransitionEnd={onTrackTransitionEnd}>
          {Array.from({ length: n * 3 }, (_, r) => {
            // Three copies so there's always a tile on both sides (seamless
            // loop). The selected one is at the center-copy slot n + pos.
            const c = collections[r % n];
            const isSel = r === n + pos;
            return (
              <CollectionTile
                key={r}
                collection={c}
                selected={isSel}
                onKeyDown={isSel ? onTileKey : undefined}
                onOpen={() => openCollection(c)}
              />
            );
          })}
          </div>
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

// A few of an album's images (oldest-first), for the hero/cover sample only —
// stops after enough buckets to fill the hero, so a large album isn't fully
// walked just to preview it.
async function albumImages(albumId: string): Promise<Asset[]> {
  const buckets = await getAlbumBuckets(albumId, 'asc').catch(() => [] as TimeBucket[]);
  const out: Asset[] = [];
  for (const b of buckets) {
    const cols = await getAlbumBucket(albumId, b.timeBucket, 'asc').catch(() => null);
    if (cols) out.push(...flattenBucket(cols).filter((a) => a.isImage));
    if (out.length >= HERO_MAX * 3) break;
  }
  return out;
}

// Random candidate pool per collection. Timeline sources use a single
// type-filtered metadata search (fast even for sparse types); album sources
// sample the album's own images. Fetched once and cached per collection id.
const poolCache = new Map<string, Promise<Asset[]>>();
function collectionPool(c: Collection): Promise<Asset[]> {
  let p = poolCache.get(c.id);
  if (!p) {
    const source = c.albumId ? albumImages(c.albumId) : searchByType(c.type);
    p = source
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
  for (const s of heroStore.values()) s.loaded.forEach((p) => revoke(p.url));
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
  }, [curSrc?.url]);

  // aim each layer's cover crop at faces once it has decoded (natural size known)
  const aim = (e: Event, p: HeroPreview) => void aimAtFaces(e.currentTarget as HTMLImageElement, p.id);

  return (
    <div class="wp-hero">
      {layers.a && (
        <img
          class={'wp-hero-img' + (showA ? ' on' : '')}
          src={layers.a.url}
          decoding="async"
          onLoad={(e) => aim(e, layers.a!)}
        />
      )}
      {layers.b && (
        <img
          class={'wp-hero-img' + (!showA ? ' on' : '')}
          src={layers.b.url}
          decoding="async"
          onLoad={(e) => aim(e, layers.b!)}
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
  selected,
  onKeyDown,
  onOpen,
}: {
  collection: Collection;
  // the selected (left-slot) tile is the single focusable one and owns the
  // rotate keys; the rest are pointer-only.
  selected: boolean;
  onKeyDown?: (e: KeyboardEvent) => void;
  onOpen: () => void;
}) {
  const [cover, setCover] = useState<string | null>(null);
  useEffect(() => {
    // Only albums show a real cover (their own thumbnail). Photos/Videos use a
    // generic tile, so there's no per-tile library fetch for them.
    if (!collection.coverId) {
      setCover(null);
      return;
    }
    let alive = true;
    loadThumb(collection.coverId)
      .then((u) => { if (alive) setCover(u); })
      .catch(() => {});
    return () => { alive = false; };
  }, [collection.coverId]);

  return (
    <button
      data-focusable={selected || undefined}
      class={'wp-tile' + (selected ? ' focusable selected' : '')}
      onKeyDown={onKeyDown}
      onClick={onOpen}
    >
      {cover ? (
        <img class="wp-tile-img" src={cover} />
      ) : (
        <div class="wp-tile-generic">
          <Icon name={collection.icon} size={64} />
        </div>
      )}
      <span class="wp-tile-grad" />
      {/* all tiles: icon top-left, title bottom-left */}
      <span class="wp-tile-icon">
        <Icon name={collection.icon} size={22} />
      </span>
      <span class="wp-tile-label">
        <span class="wp-tile-label-text">{collection.label}</span>
      </span>
    </button>
  );
}
