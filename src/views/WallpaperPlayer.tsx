import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Asset } from '../api/assets';
import { loadBlobUrl, revoke } from '../api/media';
import { thumbnailUrl, videoStreamUrl, originalUrl, getAssetLocation } from '../api/client';
import { Key, isBack, dirFromKey } from '../nav/keys';
import { fetchStations, Station } from '../api/radio';
import { Icon } from '../components/Icon';

interface Props {
  assets: Asset[];
  onExit: () => void;
  // called when nearing the end of the loaded list so more buckets can load
  onNearEnd?: () => void;
}

const HIDE_MS = 3000;
const SPEEDS = [
  { label: '30s', ms: 30000 },
  { label: '1m', ms: 60000 },
  { label: '5m', ms: 300000 },
  { label: '10m', ms: 600000 },
];
const DEFAULT_MS = SPEEDS[0].ms; // dwell per still
const GENRES = [
  { label: 'Ambient', tag: 'ambient' },
  { label: 'Lofi', tag: 'lofi' },
  { label: 'Jazz', tag: 'jazz' },
  { label: 'Classical', tag: 'classical' },
];
const WINDOW = 5; // stills prefetched ahead at original quality
const VIDEO_STALL_MS = 8000; // skip a video that hasn't produced a frame by now
const PREBUFFER_S = 5; // seconds of the NEXT video to pre-download

interface Cached {
  src: string;
  isVideo: boolean;
  blob: boolean; // owns an object URL (still) that must be revoked
  // stills: ready === decoded === true once the blob resolves.
  // videos: ready (navigable) on `loadedmetadata` while only metadata is
  // buffered; decoded (safe to show) on `loadeddata`, after it promotes to
  // full buffering when it becomes current.
  ready: boolean;
  decoded: boolean;
  error?: boolean; // failed to load — advance past it
  el?: HTMLVideoElement; // for video: the buffering, reusable element
}

interface Frame {
  key: number;
  asset: Asset;
  src: string;
  el?: HTMLVideoElement;
}

// Fullscreen auto-advancing wallpaper slideshow. Stills crossfade every 8s at
// original quality; videos buffer in chunks (progressive range streaming, like
// the grid) and play muted to the end, then advance. Navigation (auto or d-pad)
// only moves to an item whose media is loaded — never onto a black/unready
// frame. Loops forever. Owns its own key listener; the shell disables its
// remote handler while this is up.
export function WallpaperPlayer({ assets, onExit, onNearEnd }: Props) {
  const [i, setI] = useState(0);
  const [stack, setStack] = useState<Frame[]>([]);
  const [shownKey, setShownKey] = useState(0);
  const [paused, setPaused] = useState(false);
  const [overlay, setOverlay] = useState(true);
  // transient play/pause feedback pill, shown briefly on each toggle
  const [pill, setPill] = useState<'none' | 'paused' | 'playing'>('none');
  const pillTimer = useRef<number | undefined>(undefined);
  // reverse-geocoded place for the current asset (date comes from the asset)
  const [location, setLocation] = useState<string | null>(null);
  // slideshow speed for stills (videos advance on their own end)
  const [intervalMs, setIntervalMs] = useState(DEFAULT_MS);
  const intervalRef = useRef(DEFAULT_MS);
  intervalRef.current = intervalMs;
  // background music (Radio Browser internet-radio streams)
  const [musicOn, setMusicOn] = useState(false);
  const [genre, setGenre] = useState(GENRES[0].tag);
  const [stations, setStations] = useState<Station[]>([]);
  const [stIdx, setStIdx] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const musicOnRef = useRef(false);
  musicOnRef.current = musicOn;
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const keyRef = useRef(0);
  const advanceTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const iRef = useRef(0);
  iRef.current = i;
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  // latest "advance forward" fn, so video element listeners never go stale
  const advanceRef = useRef<() => void>(() => {});

  const asset = assets[i];

  // Prefetch cache: index -> loaded item. Kept to a small sliding window so only
  // a handful of full-res stills / buffering videos live in TV memory at once.
  const cache = useRef<Map<number, Cached>>(new Map());

  const pushFrame = useCallback((f: Frame) => {
    setStack((prev) => [...prev, f].slice(-2));
  }, []);

  // Load one item into the cache. Stills: fetch original (HEIC/RAW fall back to
  // the preview JPEG), ready once the blob resolves. Videos: a hidden <video>
  // that buffers in chunks; ready on its first decoded frame (loadeddata).
  const loadInto = useCallback(
    async (idx: number): Promise<Cached | null> => {
      const hit = cache.current.get(idx);
      if (hit) return hit;
      const a = assets[idx];
      if (!a) return null;

      if (a.isVideo) {
        const el = document.createElement('video');
        el.src = videoStreamUrl(a.id);
        el.muted = true;
        el.playsInline = true;
        // only metadata while it's a lookahead/behind; promoted to 'auto' when
        // it becomes the current clip (keeps at most one clip fully buffering).
        el.preload = 'metadata';
        el.setAttribute('playsinline', '');
        el.setAttribute('muted', '');
        const e: Cached = { src: el.src, isVideo: true, blob: false, ready: false, decoded: false, el };
        cache.current.set(idx, e);
        el.addEventListener('loadedmetadata', () => { e.ready = true; bump(); }, { once: true });
        el.addEventListener('loadeddata', () => { e.decoded = true; bump(); }, { once: true });
        el.addEventListener('ended', () => { if (iRef.current === idx) advanceRef.current(); });
        el.addEventListener('waiting', () => { if (!pausedRef.current) void el.play().catch(() => {}); });
        el.addEventListener('error', () => {
          e.ready = true; // let nav move onto it so it can be skipped
          e.error = true;
          bump();
          if (iRef.current === idx) advanceRef.current();
        });
        el.load();
        return e;
      }

      try {
        const src = await loadBlobUrl(originalUrl(a.id));
        const e: Cached = { src, isVideo: false, blob: true, ready: true, decoded: true };
        cache.current.set(idx, e);
        return e;
      } catch {
        try {
          const src = await loadBlobUrl(thumbnailUrl(a.id, 'preview'));
          const e: Cached = { src, isVideo: false, blob: true, ready: true, decoded: true };
          cache.current.set(idx, e);
          return e;
        } catch {
          return null;
        }
      }
    },
    [assets, bump],
  );

  // Pre-download ~PREBUFFER_S of a NEIGHBOUR video, then back off so it doesn't
  // keep filling. Download-only (never play()) so it won't grab the TV's HW
  // video decoder from the current clip. Once this item becomes current the
  // show effect flips it back to full 'auto' buffering.
  const capPrebuffer = useCallback((idx: number, e: Cached) => {
    const el = e.el;
    if (!el) return;
    el.preload = 'auto';
    const onProgress = () => {
      if (iRef.current === idx) {
        el.removeEventListener('progress', onProgress); // it's current now — let it buffer fully
        return;
      }
      let end = 0;
      try {
        if (el.buffered.length) end = el.buffered.end(el.buffered.length - 1);
      } catch {
        /* buffered not readable yet */
      }
      if (end >= PREBUFFER_S) {
        el.preload = 'metadata'; // best-effort: signal the browser to stop topping up
        el.removeEventListener('progress', onProgress);
      }
    };
    el.addEventListener('progress', onProgress);
    el.load();
  }, []);

  // tear down a cached video element (stop buffering, release the network/decoder)
  const teardown = (e: Cached) => {
    if (e.blob) revoke(e.src);
    if (e.el) {
      e.el.pause();
      e.el.removeAttribute('src');
      e.el.load();
      e.el.remove();
    }
  };

  // Drop cached items outside the [i-1, i+WINDOW] window.
  const evict = useCallback((center: number) => {
    for (const [idx, e] of cache.current) {
      if (idx < center - 1 || idx > center + WINDOW) {
        teardown(e);
        cache.current.delete(idx);
      }
    }
  }, []);

  // An index is navigable only once its media is loaded: a still's blob is ready,
  // or a video has decoded its first frame (or errored, so it can be skipped).
  const isLoaded = useCallback(
    (idx: number) => {
      const a = assets[idx];
      if (!a) return false;
      const e = cache.current.get(idx);
      if (!e) return false;
      return e.isVideo ? e.ready : true;
    },
    [assets],
  );

  const targetIndex = useCallback(
    (delta: number) => {
      const n = iRef.current + delta;
      if (n < 0) return assets.length - 1; // wrap to last
      if (n >= assets.length) return 0; // wrap to first
      return n;
    },
    [assets.length],
  );

  // Move by delta, but ONLY if the target is loaded. If not, stay put and kick
  // off its load (never jump to — or wrap onto — an unloaded/black frame).
  const advance = useCallback(
    (delta: number) => {
      const n = targetIndex(delta);
      if (isLoaded(n)) {
        window.clearTimeout(advanceTimer.current);
        setI(n);
        return true;
      }
      void loadInto(n);
      return false;
    },
    [targetIndex, isLoaded, loadInto],
  );

  // Auto-advance: try to step forward; if the next frame isn't loaded yet, keep
  // retrying at a short interval rather than skipping or looping past it.
  const scheduleNext = useCallback(
    (ms: number) => {
      window.clearTimeout(advanceTimer.current);
      if (pausedRef.current) return;
      advanceTimer.current = window.setTimeout(() => {
        if (!advance(1)) scheduleNext(400);
      }, ms);
    },
    [advance],
  );
  advanceRef.current = () => scheduleNext(0);

  // load + show the current asset, prefetch ahead, evict the rest
  useEffect(() => {
    if (!asset) return;
    let alive = true;
    const key = ++keyRef.current;
    let stallTimer: number | undefined;
    window.clearTimeout(advanceTimer.current);

    loadInto(i)
      .then((e) => {
        if (!alive) return;
        if (!e) return scheduleNext(500); // unloadable still — skip quickly
        if (!e.isVideo) {
          pushFrame({ key, asset, src: e.src });
          scheduleNext(intervalRef.current); // stills auto-advance on a timer
          return;
        }
        // Video: promote to full buffering now that it's current, and only
        // REVEAL it once it has a decoded frame — until then the previous frame
        // stays up (no black flash mid-crossfade). Advance is driven by 'ended'.
        const el = e.el!;
        el.preload = 'auto';
        if (e.error) return scheduleNext(0); // failed — advance past
        void el.play().catch(() => {}); // muted; kicks buffering + decode
        let revealed = false;
        const reveal = () => {
          if (revealed || !alive) return;
          revealed = true;
          try { el.currentTime = 0; } catch { /* not seekable yet */ }
          if (!pausedRef.current) void el.play().catch(() => {});
          pushFrame({ key, asset, src: e.src, el });
        };
        if (e.decoded) reveal();
        else {
          el.addEventListener('loadeddata', reveal, { once: true });
          el.addEventListener('canplay', reveal, { once: true });
        }
        // watchdog: a video that never produces a frame gets skipped, so a
        // stuck/black clip can't stall the slideshow forever
        stallTimer = window.setTimeout(() => {
          if (alive && (el.currentTime || 0) === 0) scheduleNext(0);
        }, VIDEO_STALL_MS);
      })
      .catch(() => alive && scheduleNext(500));

    // prefetch: all stills in the window, but only the NEXT video ahead (videos
    // are heavy to buffer — one lookahead is enough to keep nav unblocked)
    let vids = 0;
    for (let k = i + 1; k <= i + WINDOW && k < assets.length; k++) {
      if (assets[k].isVideo) {
        if (vids < 1) {
          const idx = k;
          vids++;
          void loadInto(idx).then((e) => { if (e?.el) capPrebuffer(idx, e); }); // ~5s prebuffer
        }
      } else {
        void loadInto(k);
      }
    }
    evict(i);
    if (onNearEnd && i >= assets.length - 3) onNearEnd();

    return () => {
      alive = false;
      window.clearTimeout(stallTimer);
      // pause the outgoing video and demote it back to metadata-only so it stops
      // buffering while it's just a neighbour again
      const out = cache.current.get(i)?.el;
      if (out) {
        out.pause();
        out.preload = 'metadata';
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, assets.length]);

  // reverse-geocode the current asset for the bottom-left caption
  useEffect(() => {
    if (!asset) return;
    let alive = true;
    // keep the previous caption until the new one resolves, so two shots from
    // the same place don't flicker the key (and re-trigger the animation)
    getAssetLocation(asset.id)
      .then((loc) => {
        if (!alive) return;
        const parts = [loc.city, loc.state, loc.country].filter(Boolean) as string[];
        const deduped = parts.filter((p, k) => p !== parts[k - 1]);
        setLocation(deduped.length ? deduped.join(', ') : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [asset?.id]);

  // fade the newest frame in on the next paint (starts at opacity 0)
  useEffect(() => {
    const top = stack[stack.length - 1];
    if (!top) return;
    const r = requestAnimationFrame(() => setShownKey(top.key));
    return () => cancelAnimationFrame(r);
  }, [stack]);

  // release everything held when the player unmounts
  useEffect(() => {
    const held = cache.current;
    return () => {
      window.clearTimeout(advanceTimer.current);
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(pillTimer.current);
      for (const e of held.values()) teardown(e);
      held.clear();
    };
  }, []);

  // pause/resume: stop the timer + current video, or resume playback/rotation
  useEffect(() => {
    const cur = cache.current.get(iRef.current);
    if (paused) {
      window.clearTimeout(advanceTimer.current);
      cur?.el?.pause();
    } else if (cur?.isVideo) {
      void cur.el?.play().catch(() => {});
    } else {
      scheduleNext(intervalRef.current);
    }
  }, [paused, scheduleNext]);

  // changing the speed while a still is showing restarts its timer at the new rate
  useEffect(() => {
    if (paused) return;
    if (!assets[iRef.current]?.isVideo) scheduleNext(intervalMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  const poke = useCallback(() => {
    setOverlay(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setOverlay(false), HIDE_MS);
  }, []);

  const flashPill = useCallback((mode: 'paused' | 'playing') => {
    setPill(mode);
    window.clearTimeout(pillTimer.current);
    pillTimer.current = window.setTimeout(() => setPill('none'), 1400);
  }, []);

  // --- background music ---
  const loadGenre = useCallback(async (tag: string) => {
    const st = await fetchStations(tag);
    setStations(st);
    setStIdx(0);
  }, []);

  const toggleMusic = useCallback(async () => {
    poke();
    if (musicOn) {
      setMusicOn(false);
      return;
    }
    setMusicOn(true);
    if (stations.length === 0) await loadGenre(genre);
  }, [musicOn, stations.length, genre, loadGenre, poke]);

  const selectGenre = useCallback(
    (tag: string) => {
      poke();
      if (tag === genre) return;
      setGenre(tag);
      if (musicOn) void loadGenre(tag);
    },
    [genre, musicOn, loadGenre, poke],
  );

  const nextStation = useCallback(() => {
    poke();
    setStIdx((n) => (stations.length ? (n + 1) % stations.length : 0));
  }, [stations.length, poke]);

  // drive the <audio> element from music state / selected station
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (musicOn && stations[stIdx]) {
      if (a.src !== stations[stIdx].url) a.src = stations[stIdx].url;
      void a.play().catch(() => {});
    } else {
      a.pause();
    }
  }, [musicOn, stIdx, stations]);

  // stop music when the player closes
  useEffect(() => () => audioRef.current?.pause(), []);

  // show the overlay briefly at start; afterwards it appears only on interaction
  // (key / pointer), never on an automatic photo change
  useEffect(() => {
    poke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // own key listener (the shell's remote handler is disabled while we're up)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const code = e.keyCode;
      poke();
      if (isBack(code)) {
        e.preventDefault();
        onExit();
        return;
      }
      const dir = dirFromKey(code);
      if (dir === 'left') {
        e.preventDefault();
        advance(-1); // no-op until the previous frame is loaded
      } else if (dir === 'right') {
        e.preventDefault();
        advance(1); // no-op until the next frame is loaded
      } else if (code === Key.Enter || code === Key.PlayPause) {
        e.preventDefault();
        setPaused((p) => {
          const next = !p;
          flashPill(next ? 'paused' : 'playing');
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, onExit, poke, flashPill]);

  if (!asset) return null;

  const cur = cache.current.get(i);
  const buffering = !!asset.isVideo && !(cur?.decoded);
  const dateStr = fmtDate(asset.createdAt);
  // key on the caption CONTENT so it only re-animates when the text changes
  // (consecutive shots from the same place/day won't re-trigger the animation)
  const metaKey = `${location ?? ''}|${dateStr}`;

  // mount the cached, already-buffering <video> element into its crossfade layer
  // (reused so it never re-downloads or flashes black)
  const mountVideo = (node: HTMLDivElement | null, f: Frame, isTop: boolean) => {
    if (!node || !f.el) return;
    if (f.el.parentElement !== node) node.appendChild(f.el);
    // only the top (current) frame plays; the outgoing one freezes as it fades
    if (isTop && !pausedRef.current) void f.el.play().catch(() => {});
    else f.el.pause();
  };

  // Portal to <body>: rendered inside the shell's .view-enter, whose lingering
  // transform (animation ... both) would otherwise trap position:fixed inside
  // the content box, leaving the sidebar visible instead of a true fullscreen.
  return createPortal(
    <div class={'wp-player ' + (overlay ? 'show-ui' : '')} onMouseMove={poke}>
      {stack.map((f, idx) => {
        // the frame below the top is already fully faded in; the top frame
        // fades in once shownKey catches up to it.
        const on = idx < stack.length - 1 || f.key === shownKey;
        const cls = 'wp-frame' + (on ? ' on' : '');
        return f.el ? (
          <div
            key={f.key}
            class={cls + ' wp-vframe'}
            ref={(node) => mountVideo(node, f, idx === stack.length - 1)}
          />
        ) : (
          <img key={f.key} class={cls} src={f.src} />
        );
      })}

      {buffering && (
        <div class="wp-player-spin">
          <div class="fs-spinner" />
        </div>
      )}

      {/* bottom-left caption, animates in fresh for each wallpaper (keyed by id) */}
      <div class="wp-player-meta" key={metaKey}>
        {location && <div class="wp-player-loc">{location}</div>}
        {dateStr && <div class="wp-player-date">{dateStr}</div>}
      </div>

      <div class="wp-player-ui">
        <div class="wp-player-top">
          {pill !== 'none' && (
            <span class="wp-player-pill">
              <Icon name={pill === 'paused' ? 'pause' : 'play'} size={22} />
              {pill === 'paused' ? 'Paused' : 'Playing'}
            </span>
          )}
          <div class="wp-music">
            {musicOn && (
              <div class="wp-speed">
                {GENRES.map((g) => (
                  <button
                    key={g.tag}
                    class={'wp-speed-btn' + (g.tag === genre ? ' active' : '')}
                    onClick={() => selectGenre(g.tag)}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            )}
            {musicOn && stations[stIdx] && (
              <span class="wp-music-name">{stations[stIdx].name}</span>
            )}
            {musicOn && stations.length > 1 && (
              <button class="wp-icon-btn" onClick={nextStation} title="Next station">
                <Icon name="skipNext" size={22} />
              </button>
            )}
            <button
              class={'wp-icon-btn' + (musicOn ? ' active' : '')}
              onClick={toggleMusic}
              title="Background music"
            >
              <Icon name="music" size={22} />
            </button>
          </div>
          <div class="wp-speed">
            {SPEEDS.map((s) => (
              <button
                key={s.ms}
                class={'wp-speed-btn' + (s.ms === intervalMs ? ' active' : '')}
                onClick={() => { setIntervalMs(s.ms); poke(); }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <audio
          ref={audioRef}
          onError={nextStation}
          // a muted video can still steal audio focus on webOS and pause the
          // stream — resume it if music is meant to be on
          onPause={() => {
            if (musicOnRef.current) {
              window.setTimeout(() => {
                if (musicOnRef.current) void audioRef.current?.play().catch(() => {});
              }, 400);
            }
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
