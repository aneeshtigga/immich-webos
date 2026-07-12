import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { Asset } from '../api/assets';
import { loadBlobUrl, loadThumb, revoke } from '../api/media';
import { thumbnailUrl, videoStreamUrl, originalStreamUrl, getAssetLocation } from '../api/client';
import { Key, isBack, dirFromKey } from '../nav/keys';
import { Icon } from '../components/Icon';

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
const HIDE_MS = 3000;

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
  const [progress, setProgress] = useState({ cur: 0, dur: 0 });
  const [quality, setQuality] = useState<Quality>('transcoded');
  const [overlay, setOverlay] = useState(true);
  const [videoErr, setVideoErr] = useState(false);
  const [buffering, setBuffering] = useState(false);
  // Live Photo: motionOn keeps the clip mounted; motionVisible drives its
  // opacity. The clip mounts transparent (still shows through), fades IN only
  // once it has a decoded frame (no black buffering flash), and fades OUT when
  // it ends before unmounting.
  const [motionOn, setMotionOn] = useState(false);
  const [motionVisible, setMotionVisible] = useState(false);
  const motionFadeTimer = useRef<number | undefined>(undefined);

  const videoRef = useRef<HTMLVideoElement>(null);
  const motionRef = useRef<HTMLVideoElement>(null);
  const imgUrlRef = useRef<string | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const resumeAt = useRef(0); // remember position across quality switch
  const seekRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const nearEndFiredRef = useRef(0);

  const asset = assets[i];
  const isVideo = !!asset?.isVideo;
  // A still that carries a paired motion clip is a Live Photo.
  const livePhotoId = asset && !isVideo ? asset.livePhotoVideoId ?? null : null;

  // Autoplay the motion clip once each time a Live Photo is opened; clear it
  // for plain photos and videos.
  useEffect(() => {
    window.clearTimeout(motionFadeTimer.current);
    setMotionVisible(false);
    setMotionOn(!!livePhotoId);
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
  const toggleMotion = useCallback(() => {
    if (motionOn && motionVisible) endMotion();
    else replayMotion();
  }, [motionOn, motionVisible, endMotion, replayMotion]);
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
      if (forceShow) setOverlay(true);
      window.clearTimeout(hideTimer.current);
      // only auto-hide while a video is actively playing
      if (isVideo && !paused) {
        hideTimer.current = window.setTimeout(() => setOverlay(false), HIDE_MS);
      }
    },
    [isVideo, paused],
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

  // reset per-asset video state
  useEffect(() => {
    setQuality('transcoded');
    setVideoErr(false);
    setProgress({ cur: 0, dur: 0 });
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

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.paused ? v.play() : v.pause();
  }, []);

  const seek = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 1e9, v.currentTime + delta));
    setProgress({ cur: v.currentTime, dur: v.duration || 0 });
  }, []);

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
    setProgress({ cur: v.currentTime, dur: v.duration });
  }, []);

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
    setQuality((q) => (q === 'transcoded' ? 'original' : 'transcoded'));
    setVideoErr(false);
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
      if (livePhotoId && (code === Key.Enter || code === Key.PlayPause)) {
        e.preventDefault();
        toggleMotion(); // OK/Enter plays or stops the Live Photo motion
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
  }, [isVideo, paused, go, seek, togglePlay, poke, onClose, livePhotoId, toggleMotion]);

  if (!asset) return null;

  const videoSrc = quality === 'original' ? originalStreamUrl(asset.id) : videoStreamUrl(asset.id);
  const pct = progress.dur > 0 ? (progress.cur / progress.dur) * 100 : 0;
  const atStart = i === 0;
  const atEnd = i === assets.length - 1;

  return (
    <div class={'fs ' + (overlay ? 'show-ui' : '')} onMouseMove={() => poke(true)}>
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
            onPlaying={() => setBuffering(false)}
            onCanPlay={() => setBuffering(false)}
            onWaiting={() => setBuffering(true)}
            onPause={() => {
              setPaused(true);
              setOverlay(true);
            }}
            onLoadedMetadata={() => {
              const v = videoRef.current;
              if (v && resumeAt.current) v.currentTime = resumeAt.current;
            }}
            onTimeUpdate={() => {
              const v = videoRef.current;
              if (v) setProgress({ cur: v.currentTime, dur: v.duration || 0 });
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
              class={'fs-img' + (motionVisible ? ' motion-revealed' : '')}
              src={imgSrc}
              onLoad={() => setImgReady(true)}
            />
          )}
        </>
      )}

      {/* centered loading spinner: photo not yet decoded, or video buffering */}
      {((!isVideo && !imgReady) || (isVideo && buffering && !videoErr)) && (
        <div class="fs-spinner" />
      )}

      {/* overlay UI */}
      <div class="fs-ui">
        {/* top bar */}
        <div class="fs-top">
          <button class="fs-btn" onClick={() => onClose(i)} title="Back to grid">
            <Icon name="back" size={28} />
            <span>Back</span>
          </button>
          <div class="fs-top-right">
            {location && <span class="fs-location">{location}</span>}
            {livePhotoId && (
              <button
                class={'fs-btn round' + (motionOn && motionVisible ? ' active' : '')}
                onClick={replayMotion}
                title="Play Live Photo"
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

        {/* side nav arrows */}
        {!atStart && (
          <button class="fs-arrow left" onClick={() => go(-1)} title="Previous">
            <Icon name="chevronLeft" size={48} />
          </button>
        )}
        {!atEnd && (
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
              <div class="fs-seek-fill" style={{ width: `${pct}%` }}>
                <span class="fs-seek-knob" />
              </div>
            </div>
            <span class="fs-time">{fmt(progress.dur)}</span>
          </div>
        )}

        <div class="fs-counter">
          {i + 1} / {assets.length}
        </div>
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
