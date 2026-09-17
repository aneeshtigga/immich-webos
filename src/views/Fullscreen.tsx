import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { Asset } from '../api/assets';
import { loadBlobUrl, loadThumb, revoke } from '../api/media';
import { thumbnailUrl, videoStreamUrl, originalStreamUrl, getAssetLocation } from '../api/client';
import { Key, isBack, dirFromKey } from '../nav/keys';
import { Icon } from '../components/Icon';
import {
  getLivePlay,
  setLivePlay,
  getVideoQuality,
  setVideoQuality,
  getOverlayHidden,
} from '../settings';

interface Props {
  assets: Asset[];
  index: number;
  // reports the index being viewed at close time so the grid can restore focus
  // to that exact photo (the user may have paged left/right while in here).
  onClose: (index: number) => void;
  // called when within 5 of the last loaded asset, so the grid can prefetch the next bucket
  onNearEnd?: () => void;
}

type Quality = 'transcoded' | 'original';
const SEEK_STEP = 10; // seconds
const HIDE_MS = 5000;
const ZOOM_STEP = 1.2; // scale multiplier per scroll-wheel tick
const MAX_ZOOM = 6;
const PAN_KEY_STEP = 120; // px the d-pad nudges a zoomed photo

// Keep a zoomed photo's pan within bounds so it can't be dragged fully off
// screen: at scale z the image overhangs the viewport by (z-1) on each axis,
// so the max offset is half of that overhang.
function clampPan(x: number, y: number, z: number): { x: number; y: number } {
  const maxX = ((z - 1) * window.innerWidth) / 2;
  const maxY = ((z - 1) * window.innerHeight) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, x)),
    y: Math.max(-maxY, Math.min(maxY, y)),
  };
}

// Unified fullscreen viewer for photos and videos with an auto-hiding overlay.
//
// Photos: arrow keys go to previous/next media. Loads the 'preview' JPEG so
// HEIC/RAW render (browser never sees raw bytes).
//
// Videos: autoplay on open. While PLAYING, left/right seek -/+10s; while
// PAUSED, left/right move to previous/next media. Enter/OK toggles play-pause.
// Overlay (back, prev/next arrows, seek bar, quality) hides during playback and
// reappears when paused or on any remote activity. A top-right button switches
// between the transcoded stream and the original file, preserving position.
//
// On-screen buttons are clickable with the LG magic-remote pointer; the d-pad
// keeps fixed media semantics rather than moving focus between buttons.
export function Fullscreen({ assets, index, onClose, onNearEnd }: Props) {
  const [i, setI] = useState(index);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgReady, setImgReady] = useState(false);
  const [thumbSrc, setThumbSrc] = useState<string | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [progress, setProgress] = useState({ cur: 0, dur: 0, buffered: 0 });
  // remembered across assets and restarts (see settings.getVideoQuality)
  const [quality, setQuality] = useState<Quality>(getVideoQuality);
  // When the user has toggled "hide overlay" in the grid header, the viewer
  // opens with its chrome hidden and never auto-shows it (poke below no-ops the
  // show). Read once at open; nav/back still work via the remote regardless.
  const overlayHidden = useRef(getOverlayHidden()).current;
  const [overlay, setOverlay] = useState(!overlayHidden);
  const [videoErr, setVideoErr] = useState(false);
  const [buffering, setBuffering] = useState(false);
  // Live Photo: motionOn keeps the clip mounted; motionVisible drives its
  // opacity. The clip mounts transparent (still shows through), fades IN only
  // once it has a decoded frame (no black buffering flash), and fades OUT when
  // it ends before unmounting.
  const [motionOn, setMotionOn] = useState(false);
  const [motionVisible, setMotionVisible] = useState(false);
  const motionFadeTimer = useRef<number | undefined>(undefined);
  // Persisted "live play" preference: whether Live Photos autoplay their motion.
  // Off by default; toggled with OK/Enter and remembered across app restarts.
  const [livePlay, setLivePlayState] = useState(getLivePlay);
  const livePlayRef = useRef(livePlay);
  livePlayRef.current = livePlay;

  const videoRef = useRef<HTMLVideoElement>(null);
  const motionRef = useRef<HTMLVideoElement>(null);
  const imgUrlRef = useRef<string | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const resumeAt = useRef(0); // remember position across quality switch
  const seekRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const nearEndFiredRef = useRef(0);

  // ---- photo zoom (magic-remote scroll wheel) ----
  // zoom scales the still; pan offsets it (px). Both reset per photo. zoomRef
  // mirrors zoom so the keydown/pointer handlers read it without re-subscribing.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const panDragRef = useRef({ on: false, x: 0, y: 0 });

  const asset = assets[i];
  const isVideo = !!asset?.isVideo;
  // A still that carries a paired motion clip is a Live Photo.
  const livePhotoId = asset && !isVideo ? asset.livePhotoVideoId ?? null : null;

  // On opening a Live Photo, autoplay its motion only if live play is enabled;
  // clear it for plain photos, videos, or when the preference is off. Reads the
  // preference via a ref so toggling it doesn't re-run this (the toggle handler
  // applies the change to the current photo itself).
  useEffect(() => {
    window.clearTimeout(motionFadeTimer.current);
    setMotionVisible(false);
    setMotionOn(!!livePhotoId && livePlayRef.current);
  }, [asset?.id, livePhotoId]);

  // Fade the motion clip out (revealing the still beneath) rather than cutting.
  const MOTION_FADE_MS = 600; // must match .fs-img opacity transition in CSS
  const endMotion = useCallback(() => {
    setMotionVisible(false);
    window.clearTimeout(motionFadeTimer.current);
    motionFadeTimer.current = window.setTimeout(() => setMotionOn(false), MOTION_FADE_MS);
  }, []);
  const replayMotion = useCallback(() => {
    window.clearTimeout(motionFadeTimer.current);
    setMotionVisible(false); // stays transparent until the first frame decodes
    setMotionOn(true);
  }, []);
  // OK/Enter toggles the persisted live-play preference AND applies it to the
  // photo on screen: turning it on plays the current Live Photo's motion,
  // turning it off stops it. The choice sticks for future photos and restarts.
  const toggleLivePlay = useCallback(() => {
    setLivePlayState((prev) => {
      const next = !prev;
      setLivePlay(next);
      if (next) replayMotion();
      else endMotion();
      return next;
    });
  }, [replayMotion, endMotion]);
  useEffect(() => () => window.clearTimeout(motionFadeTimer.current), []);

  // fire onNearEnd when within 5 of the end so the grid prefetches the next bucket
  useEffect(() => {
    if (!onNearEnd) return;
    if (assets.length - i <= 5 && assets.length !== nearEndFiredRef.current) {
      nearEndFiredRef.current = assets.length;
      onNearEnd();
    }
  }, [i, assets.length, onNearEnd]);

  // ---- overlay auto-hide ----
  const poke = useCallback(
    (forceShow = true) => {
      // Overlay-hidden mode: keep it hidden, never show or arm the timer.
      if (overlayHidden) {
        setOverlay(false);
        return;
      }
      if (forceShow) setOverlay(true);
      window.clearTimeout(hideTimer.current);
      // auto-hide after inactivity for both photos and videos; any interaction
      // (pointer move, key, seek) re-shows it and restarts the countdown.
      hideTimer.current = window.setTimeout(() => setOverlay(false), HIDE_MS);
    },
    [overlayHidden],
  );

  useEffect(() => {
    poke(true);
    return () => window.clearTimeout(hideTimer.current);
  }, [i, paused, poke]);

  // ---- thumbnail placeholder (shown while preview loads) ----
  // loadThumb is a cache-hit for any asset the grid already rendered, so this
  // resolves on the next microtask and the placeholder appears instantly.
  useEffect(() => {
    if (!asset || asset.isVideo) {
      setThumbSrc(null);
      return;
    }
    let alive = true;
    loadThumb(asset.id).then((url) => { if (alive) setThumbSrc(url); }).catch(() => {});
    return () => { alive = false; };
  }, [asset?.id]);

  // ---- location tag ----
  useEffect(() => {
    if (!asset) { setLocation(null); return; }
    let alive = true;
    getAssetLocation(asset.id)
      .then((loc) => {
        if (!alive) return;
        const parts = [loc.city, loc.state, loc.country].filter(Boolean) as string[];
        const deduped = parts.filter((p, i) => p !== parts[i - 1]);
        setLocation(deduped.length ? deduped.join(', ') : null);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [asset?.id]);

  // ---- photo loading (preview JPEG) ----
  useEffect(() => {
    if (!asset || asset.isVideo) {
      setImgSrc(null);
      setImgReady(false);
      return;
    }
    let alive = true;
    setImgSrc(null);
    setImgReady(false);
    loadBlobUrl(thumbnailUrl(asset.id, 'preview'))
      .then((url) => {
        if (!alive) return revoke(url);
        if (imgUrlRef.current) revoke(imgUrlRef.current);
        imgUrlRef.current = url;
        setImgSrc(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [asset?.id]);

  useEffect(
    () => () => {
      if (imgUrlRef.current) revoke(imgUrlRef.current);
    },
    [],
  );

  // reset per-asset video state (quality is intentionally NOT reset — it carries
  // over to every video and persists across restarts)
  useEffect(() => {
    setVideoErr(false);
    setProgress({ cur: 0, dur: 0, buffered: 0 });
    resumeAt.current = 0;
    setPaused(!isVideo); // videos start in playing intent (autoplay)
    setBuffering(isVideo); // a fresh video is loading until it can play
  }, [asset?.id, isVideo]);

  // switching quality reloads a different source — show the spinner again
  useEffect(() => {
    if (isVideo) setBuffering(true);
  }, [quality, isVideo]);

  const go = useCallback(
    (delta: number) => {
      const n = i + delta;
      if (n < 0 || n >= assets.length) return;
      setI(n);
    },
    [i, assets.length],
  );

  const updateProgress = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    let buffered = 0;
    try {
      for (let k = 0; k < v.buffered.length; k++) {
        const start = v.buffered.start(k);
        const end = v.buffered.end(k);
        if (v.currentTime >= start && v.currentTime <= end) {
          buffered = end;
          break;
        }
      }
    } catch {
    }
    setProgress({ cur: v.currentTime, dur: v.duration || 0, buffered });
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.paused ? v.play() : v.pause();
  }, []);

  const seek = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 1e9, v.currentTime + delta));
    updateProgress();
  }, [updateProgress]);

  // Pointer scrubbing on the seek bar — works for PC mouse and the LG
  // magic-remote pointer (both emit pointer events). Maps the x position within
  // the bar to a fraction of duration. Used for a single click (jump) and for
  // drag (scrub): pointermove updates while a drag is active.
  const seekToClientX = useCallback((clientX: number) => {
    const v = videoRef.current;
    const bar = seekRef.current;
    if (!v || !bar || !v.duration) return;
    const rect = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    v.currentTime = frac * v.duration;
    updateProgress();
  }, [updateProgress]);

  const onSeekDown = useCallback(
    (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      seekToClientX(e.clientX);
      poke(true);
    },
    [seekToClientX, poke],
  );

  const onSeekMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      seekToClientX(e.clientX);
      poke(true);
    },
    [seekToClientX, poke],
  );

  const onSeekUp = useCallback((e: PointerEvent) => {
    draggingRef.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  const cycleQuality = useCallback(() => {
    const v = videoRef.current;
    resumeAt.current = v?.currentTime || 0;
    setQuality((q) => {
      const next: Quality = q === 'transcoded' ? 'original' : 'transcoded';
      setVideoQuality(next); // remember for later videos + app restarts
      return next;
    });
    setVideoErr(false);
  }, []);

  // reset zoom when the photo changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [asset?.id]);

  const zoomBy = useCallback((inward: boolean) => {
    const z = zoomRef.current;
    const next = Math.min(MAX_ZOOM, Math.max(1, inward ? z * ZOOM_STEP : z / ZOOM_STEP));
    setZoom(next);
    setPan((p) => (next <= 1.001 ? { x: 0, y: 0 } : clampPan(p.x, p.y, next)));
  }, []);

  // Scroll wheel (LG magic remote / mouse) zooms the still. Photos only.
  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (isVideo) return;
      e.preventDefault();
      poke(true);
      zoomBy(e.deltaY < 0);
    },
    [isVideo, poke, zoomBy],
  );

  // Pointer drag pans a zoomed photo (magic-remote pointer / mouse). Handlers
  // sit on the .fs root and fire via bubbling, so overlay buttons still click.
  const onImgDown = useCallback(
    (e: PointerEvent) => {
      if (isVideo || zoomRef.current <= 1) return;
      e.preventDefault();
      panDragRef.current = { on: true, x: e.clientX, y: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      poke(true);
    },
    [isVideo, poke],
  );
  const onImgMove = useCallback(
    (e: PointerEvent) => {
      if (!panDragRef.current.on) return;
      const dx = e.clientX - panDragRef.current.x;
      const dy = e.clientY - panDragRef.current.y;
      panDragRef.current.x = e.clientX;
      panDragRef.current.y = e.clientY;
      setPan((p) => clampPan(p.x + dx, p.y + dy, zoomRef.current));
      poke(true);
    },
    [poke],
  );
  const onImgUp = useCallback((e: PointerEvent) => {
    panDragRef.current.on = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  // ---- key handling: fixed media semantics ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const code = e.keyCode;
      poke(true);

      if (isBack(code)) {
        e.preventDefault();
        onClose(i);
        return;
      }

      const dir = dirFromKey(code);

      if (isVideo) {
        if (code === Key.Enter || code === Key.PlayPause) {
          e.preventDefault();
          togglePlay();
        } else if (code === Key.Play) {
          e.preventDefault();
          videoRef.current?.play();
        } else if (code === Key.Pause) {
          e.preventDefault();
          videoRef.current?.pause();
        } else if (code === Key.FastForward) {
          e.preventDefault();
          seek(SEEK_STEP);
        } else if (code === Key.Rewind) {
          e.preventDefault();
          seek(-SEEK_STEP);
        } else if (dir === 'left') {
          e.preventDefault();
          paused ? go(-1) : seek(-SEEK_STEP); // paused: prev media, playing: seek back
        } else if (dir === 'right') {
          e.preventDefault();
          paused ? go(1) : seek(SEEK_STEP);
        }
        return;
      }

      // photo
      // Zoomed in: arrows pan the image and OK/Enter resets to fit. This takes
      // priority over prev/next and live-play so the d-pad can steer the zoom.
      if (zoomRef.current > 1) {
        if (code === Key.Enter || code === Key.PlayPause) {
          e.preventDefault();
          setZoom(1);
          setPan({ x: 0, y: 0 });
          return;
        }
        if (dir) {
          e.preventDefault();
          const z = zoomRef.current;
          setPan((p) => {
            const dx = dir === 'left' ? PAN_KEY_STEP : dir === 'right' ? -PAN_KEY_STEP : 0;
            const dy = dir === 'up' ? PAN_KEY_STEP : dir === 'down' ? -PAN_KEY_STEP : 0;
            return clampPan(p.x + dx, p.y + dy, z);
          });
          return;
        }
      }
      if (livePhotoId && (code === Key.Enter || code === Key.PlayPause)) {
        e.preventDefault();
        toggleLivePlay(); // OK/Enter turns live play on/off (persisted) + applies now
      } else if (dir === 'left') {
        e.preventDefault();
        go(-1);
      } else if (dir === 'right') {
        e.preventDefault();
        go(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isVideo, paused, go, seek, togglePlay, poke, onClose, livePhotoId, toggleLivePlay]);

  if (!asset) return null;

  const videoSrc = quality === 'original' ? originalStreamUrl(asset.id) : videoStreamUrl(asset.id);
  const pct = progress.dur > 0 ? (progress.cur / progress.dur) * 100 : 0;
  const bufferedPct = progress.dur > 0 ? Math.min(100, (progress.buffered / progress.dur) * 100) : 0;
  const atStart = i === 0;
  const atEnd = i === assets.length - 1;

  // ---- zoom minimap ----
  // While zoomed, a small overview shows the whole photo with a rectangle
  // marking the visible region. Compute the rectangle from the contain-fit
  // size, the current scale, and the pan (all in screen px). Null when not
  // zoomed so the overview stays hidden.
  const miniImg = thumbSrc || imgSrc;
  let mini: {
    w: number;
    h: number;
    box: { left: string; top: string; width: string; height: string };
  } | null = null;
  if (!isVideo && zoom > 1 && miniImg) {
    const imgAspect = asset.ratio && asset.ratio > 0 ? asset.ratio : 1;
    const Vw = window.innerWidth;
    const Vh = window.innerHeight;
    const viewAspect = Vw / Vh;
    // contain-fit size at scale 1
    let baseW: number, baseH: number;
    if (imgAspect > viewAspect) {
      baseW = Vw;
      baseH = Vw / imgAspect;
    } else {
      baseH = Vh;
      baseW = Vh * imgAspect;
    }
    const Sw = baseW * zoom;
    const Sh = baseH * zoom;
    const fx = Math.min(1, Vw / Sw);
    const fy = Math.min(1, Vh / Sh);
    // viewport center offset from image center (pan moves the image, so the
    // view center moves opposite), normalized to the scaled image.
    const cx = 0.5 - pan.x / Sw;
    const cy = 0.5 - pan.y / Sh;
    const bx = Math.max(0, Math.min(1 - fx, cx - fx / 2));
    const by = Math.max(0, Math.min(1 - fy, cy - fy / 2));
    const MINI_W = 220;
    mini = {
      w: MINI_W,
      h: Math.round(MINI_W / imgAspect),
      box: {
        left: bx * 100 + '%',
        top: by * 100 + '%',
        width: fx * 100 + '%',
        height: fy * 100 + '%',
      },
    };
  }

  return (
    <div
      class={'fs ' + (overlay ? 'show-ui' : '')}
      onMouseMove={() => poke(true)}
      onWheel={onWheel}
      onPointerDown={onImgDown}
      onPointerMove={onImgMove}
      onPointerUp={onImgUp}
      onPointerCancel={onImgUp}
    >
      {/* media */}
      {isVideo ? (
        videoErr && quality === 'original' ? (
          <div class="msg error">This video format is not supported on this TV.</div>
        ) : (
          <video
            ref={videoRef}
            class="fs-video"
            src={videoSrc}
            autoPlay
            playsInline
            onPlay={() => {
              setPaused(false);
              poke(false);
            }}
            onPlaying={() => { setBuffering(false); updateProgress(); }}
            onCanPlay={() => { setBuffering(false); updateProgress(); }}
            onProgress={updateProgress}
            onDurationChange={updateProgress}
            onWaiting={() => { setBuffering(true); updateProgress(); }}
            onPause={() => {
              setPaused(true);
              setOverlay(true);
              updateProgress();
            }}
            onLoadedMetadata={() => {
              const v = videoRef.current;
              if (v && resumeAt.current) v.currentTime = resumeAt.current;
            }}
            onTimeUpdate={() => {
              updateProgress();
            }}
            onEnded={() => setPaused(true)}
            onError={() => {
              // fall back transcoded -> original once
              if (quality === 'transcoded') cycleQuality();
              else {
                setVideoErr(true);
                setBuffering(false);
              }
            }}
          />
        )
      ) : (
        <>
          {thumbSrc && !imgReady && <img class="fs-thumb-ph" src={thumbSrc} />}
          {livePhotoId && motionOn && (
            <video
              ref={motionRef}
              class="fs-motion"
              src={videoStreamUrl(livePhotoId)}
              autoPlay
              muted
              playsInline
              // webOS fires `playing` at the first frame then can stall the
              // short transcoded clip; kick playback on canplay and re-issue
              // play() on any stall so it does not freeze on frame one.
              onCanPlay={() => { void motionRef.current?.play().catch(() => {}); }}
              // Reveal only once frames are actually advancing on the hardware
              // plane. `playing` fires a beat early on webOS, so fading the still
              // then punches a black frame mid-fade; waiting for currentTime > 0
              // guarantees a real frame is on the plane before the still fades.
              onTimeUpdate={() => {
                if ((motionRef.current?.currentTime ?? 0) > 0) setMotionVisible(true);
              }}
              onWaiting={() => { void motionRef.current?.play().catch(() => {}); }}
              onStalled={() => { void motionRef.current?.play().catch(() => {}); }}
              onEnded={endMotion}
              onError={() => setMotionOn(false)}
            />
          )}
          {/* still sits ON TOP of the motion clip and fades OUT to reveal it,
              so the opaque image always covers the video plane (no black flash
              from webOS punching the hardware plane through a transparent
              layer). */}
          {imgSrc && (
            <img
              class={'fs-img' + (motionVisible ? ' motion-revealed' : '') + (zoom > 1 ? ' zoomed' : '')}
              src={imgSrc}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              onLoad={() => setImgReady(true)}
            />
          )}
        </>
      )}

      {/* centered loading spinner: photo not yet decoded, or video buffering */}
      {((!isVideo && !imgReady) || (isVideo && buffering && !videoErr)) && (
        <div class="fs-spinner" />
      )}

      {/* zoom minimap: whole photo + visible-region rectangle */}
      {mini && miniImg && (
        <div class="fs-minimap" style={{ width: `${mini.w}px`, height: `${mini.h}px` }}>
          <img src={miniImg} />
          <div class="fs-minimap-box" style={mini.box} />
        </div>
      )}

      {/* overlay UI */}
      <div class="fs-ui">
        {/* top bar */}
        <div class="fs-top">
          {/* hide Back while zoomed so the d-pad/pointer drive the zoom */}
          {zoom === 1 && (
            <button class="fs-btn" onClick={() => onClose(i)} title="Back to grid">
              <Icon name="back" size={28} />
              <span>Back</span>
            </button>
          )}
          <div class="fs-top-right">
            {location && <span class="fs-location">{location}</span>}
            {livePhotoId && (
              <button
                class={'fs-btn round' + (livePlay ? ' active' : '')}
                onClick={toggleLivePlay}
                title={livePlay ? 'Live play on' : 'Live play off'}
              >
                <Icon name="live" size={28} />
              </button>
            )}
            {isVideo && (
              <button class="fs-btn" onClick={cycleQuality} title="Video quality">
                <Icon name="hd" size={26} />
                <span>{quality === 'original' ? 'Original' : 'Transcoded'}</span>
              </button>
            )}
          </div>
        </div>

        {/* side nav arrows — hidden while zoomed (arrows pan the photo) */}
        {zoom === 1 && !atStart && (
          <button class="fs-arrow left" onClick={() => go(-1)} title="Previous">
            <Icon name="chevronLeft" size={48} />
          </button>
        )}
        {zoom === 1 && !atEnd && (
          <button class="fs-arrow right" onClick={() => go(1)} title="Next">
            <Icon name="chevronRight" size={48} />
          </button>
        )}

        {/* bottom: video transport + seek bar */}
        {isVideo && (
          <div class="fs-bottom">
            <button class="fs-btn round" onClick={togglePlay}>
              <Icon name={paused ? 'play' : 'pause'} size={30} />
            </button>
            <span class="fs-time">{fmt(progress.cur)}</span>
            <div
              ref={seekRef}
              class="fs-seek"
              onPointerDown={onSeekDown}
              onPointerMove={onSeekMove}
              onPointerUp={onSeekUp}
              onPointerCancel={onSeekUp}
            >
              <div class="fs-seek-buffer" style={{ width: `${bufferedPct}%` }} />
              <div class="fs-seek-fill" style={{ width: `${pct}%` }}>
                <span class="fs-seek-knob" />
              </div>
            </div>
            <span class="fs-time">{fmt(progress.dur)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
