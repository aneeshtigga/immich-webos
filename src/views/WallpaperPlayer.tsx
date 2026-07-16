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
const CAPTION_DELAY_MS = 1000; // location/date animate in this long after a transition
const SPEEDS = [
  { label: '10s', ms: 10000 },
  { label: '30s', ms: 30000 },
  { label: '1m', ms: 60000 },
  { label: '5m', ms: 300000 },
  { label: '10m', ms: 600000 },
];
const DEFAULT_MS = SPEEDS[1].ms; // dwell per still (30s)
const GENRES = [
  { label: 'Ambient', tag: 'ambient' },
  { label: 'Lofi', tag: 'lofi' },
  { label: 'Jazz', tag: 'jazz' },
  { label: 'Classical', tag: 'classical' },
];
const WINDOW = 3; // stills prefetched ahead at original quality (TV bandwidth/RAM)
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
  img?: HTMLImageElement; // for still: the fully-decoded, reusable <img> element
}

interface Frame {
  key: number;
  asset: Asset;
  src: string;
  el?: HTMLVideoElement;
  img?: HTMLImageElement;
}

// Fullscreen auto-advancing wallpaper slideshow. Stills crossfade every 8s at
// original quality; videos buffer in chunks (progressive range streaming, like
// the grid) and play muted to the end, then advance. Navigation (auto or d-pad)
// only moves to an item whose media is loaded — never onto a black/unready
// frame. Loops forever. Owns its own key listener; the shell disables its
// remote handler while this is up.
export function WallpaperPlayer({ assets, onExit, onNearEnd }: Props) {
  const [i, setI] = useState(0);
  // Two persistent crossfade layers (A/B), exactly like the selection-page hero
  // carousel that fades reliably. Each layer is a long-lived DOM node that sits
  // at opacity 0; showing a frame drops it into the currently-hidden layer and
  // flips `showA`, so the incoming layer transitions 0->1 from its already-
  // painted 0 state. (A freshly-mounted node with a keyframe animation snapped
  // in instead of fading on webOS's Chromium 79.)
  const [layers, setLayers] = useState<{ a: Frame | null; b: Frame | null }>({ a: null, b: null });
  const [showA, setShowA] = useState(true);
  const showARef = useRef(true);
  const [paused, setPaused] = useState(false);
  const [overlay, setOverlay] = useState(true);
  // transient play/pause feedback pill, shown briefly on each toggle
  const [pill, setPill] = useState<'none' | 'paused' | 'playing'>('none');
  const pillTimer = useRef<number | undefined>(undefined);
  // caption (place + date) committed together so a switch animates it ONCE.
  // Date is on the asset immediately but the place is reverse-geocoded async;
  // setting them separately re-keyed the caption twice (date now, place later)
  // and it animated in twice. Commit both once the lookup resolves.
  const [meta, setMeta] = useState<{ loc: string | null; date: string }>({ loc: null, date: '' });
  // the asset of the frame currently ON SCREEN (in the visible layer). The caption
  // keys off THIS, not the target index, so it only appears once the image has
  // actually loaded and been revealed — never over a still-loading frame.
  const [shownAsset, setShownAsset] = useState<Asset | null>(null);
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
  // off-screen full-screen container used to lay out + raster a decoded still at
  // display size BEFORE it's shown, so the transition never hitches on a
  // first-composite resize (see fitOnStage / loadInto).
  const stageRef = useRef<HTMLDivElement>(null);
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

  // Reveal a frame: put it in the hidden layer and flip which layer is shown, so
  // the incoming layer crossfades in and the outgoing one fades out.
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const showFrame = useCallback((f: Frame) => {
    // GUARD: never re-show an element that's already in the VISIBLE layer.
    // Each media element exists once; mountLayer reparents with appendChild, so
    // putting the same element into the hidden layer would STEAL it from the
    // visible one — the screen goes black while the incoming layer fades up.
    const visible = showARef.current ? layersRef.current.a : layersRef.current.b;
    const el = f.el || f.img;
    if (el && visible && (visible.el || visible.img) === el) return;
    const toA = !showARef.current;
    setLayers((prev) => (toA ? { a: f, b: prev.b } : { a: prev.a, b: f }));
    showARef.current = toA;
    setShowA(toA);
  }, []);

  // Mount a decoded <img> into the off-screen full-screen stage so the browser
  // lays it out and RASTERS it at display size, then resolves after two frames
  // (one to lay out, one to paint). The element is later reparented into the
  // visible layer already fitted — the transition can't hitch on a resize. If
  // the stage isn't mounted yet (first render), resolve immediately.
  const fitOnStage = useCallback((img: HTMLImageElement): Promise<void> => {
    return new Promise((res) => {
      const stage = stageRef.current;
      if (!stage) return res();
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      if (img.parentElement !== stage) stage.appendChild(img);
      void img.offsetWidth; // force synchronous layout at full-screen size
      requestAnimationFrame(() => requestAnimationFrame(() => res()));
    });
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
        // Build and fully DECODE the actual <img> element before caching, then
        // reuse THAT element on screen (mounted via ref, like videos). A still
        // is "loaded" only once its real element can paint instantly. Decoding a
        // throwaway Image wasn't enough: the rendered element re-decoded async
        // and the fade reached full opacity over a still-blank layer = black pop.
        let img: HTMLImageElement;
        try {
          img = await decodeStill(src);
        } catch (decodeErr) {
          revoke(src); // undecodable original (e.g. HEIC/RAW) — drop it, try preview
          throw decodeErr;
        }
        await fitOnStage(img); // lay out + raster at full-screen before it's eligible
        const e: Cached = { src, isVideo: false, blob: true, ready: true, decoded: true, img };
        cache.current.set(idx, e);
        return e;
      } catch {
        try {
          const src = await loadBlobUrl(thumbnailUrl(a.id, 'preview'));
          const img = await decodeStill(src); // preview is always a browser-decodable JPEG
          await fitOnStage(img);
          const e: Cached = { src, isVideo: false, blob: true, ready: true, decoded: true, img };
          cache.current.set(idx, e);
          return e;
        } catch {
          return null;
        }
      }
    },
    [assets, bump, fitOnStage],
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

  // tear down a cached element (release the blob, stop buffering, drop the DOM node)
  const teardown = (e: Cached) => {
    if (e.blob) revoke(e.src);
    if (e.el) {
      e.el.pause();
      e.el.removeAttribute('src');
      e.el.load();
      e.el.remove();
    }
    if (e.img) e.img.remove(); // pull the still off the stage / frame layer
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
          showFrame({ key, asset, src: e.src, img: e.img });
          scheduleNext(intervalRef.current); // stills auto-advance on a timer
          return;
        }
        // Video: promote to full buffering now that it's current, and only
        // REVEAL it once it has a decoded frame — until then the previous frame
        // stays up (no black flash mid-crossfade). Advance is driven by 'ended'.
        const el = e.el!;
        el.preload = 'auto';
        if (e.error) return scheduleNext(0); // failed — advance past
        let revealed = false;
        const reveal = () => {
          if (revealed || !alive) return;
          revealed = true;
          // Start playback, then crossfade the element in only once a frame has
          // ACTUALLY been composited. Revealing on 'loadeddata'/'canplay' alone
          // reparents an element whose surface hasn't painted yet, so it fades in
          // black and stays black until a re-mount (a manual nav) forces a paint.
          // requestVideoFrameCallback fires on the first presented frame (Chrome);
          // Cr79 lacks it, so fall back to two rAFs after play() begins.
          const present = () => { if (alive) showFrame({ key, asset, src: e.src, el }); };
          if (!pausedRef.current) void el.play().catch(() => {});
          const rvfc = (el as unknown as {
            requestVideoFrameCallback?: (cb: () => void) => number;
          }).requestVideoFrameCallback;
          if (rvfc) rvfc.call(el, () => present());
          else requestAnimationFrame(() => requestAnimationFrame(present));
        };
        if (e.decoded) reveal();
        else {
          el.addEventListener('loadeddata', reveal, { once: true });
          el.addEventListener('canplay', reveal, { once: true });
        }
        // watchdog: forward auto-advance rides on the 'ended' event, so a clip
        // that never starts OR freezes mid-playback (buffer stall) would hang the
        // show forever ('ended' never fires). Poll the playback position: while
        // playing, if it stops advancing for VIDEO_STALL_MS, skip to the next.
        let lastT = -1;
        let strikes = 0;
        const ticks = Math.max(1, Math.round(VIDEO_STALL_MS / 2000));
        stallTimer = window.setInterval(() => {
          if (!alive || iRef.current !== i) return;
          if (pausedRef.current) { lastT = -1; return; } // don't skip a paused clip
          const t = el.currentTime || 0;
          if (t > lastT) { lastT = t; strikes = 0; return; }
          if (++strikes >= ticks) { window.clearInterval(stallTimer); scheduleNext(0); }
        }, 2000);
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
      window.clearInterval(stallTimer);
      // pause the outgoing video and demote it back to metadata-only so it stops
      // buffering while it's just a neighbour again
      const out = cache.current.get(i)?.el;
      if (out) {
        out.pause();
        out.preload = 'metadata';
      }
    };
    // NOTE: keyed on the index and the identity of the asset AT that index —
    // NOT assets.length. onNearEnd appends to the live list, and a length dep
    // re-ran this whole effect at the SAME index: the second showFrame moved
    // the already-visible element into the other layer (appendChild = steal),
    // blacking out the screen. Deterministically hit the same photos (the ones
    // on screen when a bucket load landed). asset?.id covers the one case a
    // re-run IS wanted: assets[i] itself changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, asset?.id]);

  // track which asset is actually on screen (the frame in the visible layer)
  useEffect(() => {
    const shown = showA ? layers.a : layers.b;
    if (shown) setShownAsset(shown.asset);
  }, [layers, showA]);

  // Reverse-geocode the SHOWN asset and commit place+date together, once BOTH
  // the lookup has resolved AND a short beat (CAPTION_DELAY_MS) has passed since
  // the image was revealed. Keying on the shown asset (not the target index)
  // guarantees the caption never fades in before its image is loaded. Committing
  // the pair as one metaKey means the caption is keyed on its content: identical
  // place+date reuses the DOM node and does NOT re-fade; only a genuine change
  // remounts and fades in.
  useEffect(() => {
    if (!shownAsset) return;
    let alive = true;
    const date = fmtDate(shownAsset.createdAt);
    let loc: string | null = null;
    let resolved = false;
    let delayed = false;
    const commit = () => {
      if (alive && resolved && delayed) setMeta({ loc, date });
    };
    const t = window.setTimeout(() => {
      delayed = true;
      commit();
    }, CAPTION_DELAY_MS);
    getAssetLocation(shownAsset.id)
      .then((r) => {
        const parts = [r.city, r.state, r.country].filter(Boolean) as string[];
        const deduped = parts.filter((p, k) => p !== parts[k - 1]);
        loc = deduped.length ? deduped.join(', ') : null;
      })
      .catch(() => {
        loc = null;
      })
      .finally(() => {
        resolved = true;
        commit();
      });
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [shownAsset?.id]);

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
  // key on the caption CONTENT so it only re-animates when the text changes
  // (consecutive shots from the same place/day won't re-trigger the animation)
  const metaKey = `${meta.loc ?? ''}|${meta.date}`;

  // Mount a frame's reused element (pre-decoded <img> or buffering <video>) as
  // the sole child of a persistent crossfade layer. The element is reparented,
  // never recreated, so it never re-decodes/re-downloads or flashes black. Only
  // the visible layer's video plays; the outgoing one freezes as it fades.
  const mountLayer = (node: HTMLDivElement | null, f: Frame | null, on: boolean) => {
    if (!node) return;
    const want = (f && (f.el || f.img)) || null;
    if (node.firstChild !== want) {
      while (node.firstChild) node.removeChild(node.firstChild); // detach prior element (still cached)
      if (want) node.appendChild(want);
    }
    if (f?.el) {
      if (on && !pausedRef.current) void f.el.play().catch(() => {});
      else f.el.pause();
    }
  };

  // Portal to <body>: rendered inside the shell's .view-enter, whose lingering
  // transform (animation ... both) would otherwise trap position:fixed inside
  // the content box, leaving the sidebar visible instead of a true fullscreen.
  return createPortal(
    <div class={'wp-player ' + (overlay ? 'show-ui' : '')} onMouseMove={poke}>
      {/* off-screen full-screen stage: stills are laid out + rastered here at
          display size before they're shown, then reparented into a frame layer */}
      <div class="wp-stage" ref={stageRef} />
      {(['a', 'b'] as const).map((slot) => {
        const f = layers[slot];
        const on = (slot === 'a') === showA; // this layer is the visible one
        return (
          <div
            key={slot}
            class={'wp-frame' + (on ? ' on' : '')}
            ref={(node) => mountLayer(node, f, on)}
          />
        );
      })}

      {buffering && (
        <div class="wp-player-spin">
          <div class="fs-spinner" />
        </div>
      )}

      {/* bottom-left caption, animates in fresh for each wallpaper (keyed by id) */}
      {meta.date && (
        <div class="wp-player-meta" key={metaKey}>
          {meta.loc && <div class="wp-player-loc">{meta.loc}</div>}
          {meta.date && <div class="wp-player-date">{meta.date}</div>}
        </div>
      )}

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

// Build an <img> element and fully decode its bitmap off-screen, resolving with
// the SAME element once it's ready to paint. The caller caches and mounts this
// exact element, so it never re-decodes on screen. A decode REJECTION is
// propagated (not swallowed): the byte fetch can succeed while the format is
// undecodable on the TV (HEIC/RAW original), and the caller must fall back to
// the preview JPEG rather than cache a broken element that renders black.
function decodeStill(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  if (!img.decode) return Promise.resolve(img); // can't verify — assume paintable
  return img.decode().then(() => img);
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
