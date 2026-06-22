import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { Asset } from '../api/assets';
import { loadBlobUrl, revoke } from '../api/media';
import { thumbnailUrl, videoStreamUrl, originalStreamUrl } from '../api/client';
import { Key, isBack, dirFromKey } from '../nav/keys';
import { Icon } from '../components/Icon';

interface Props {
  assets: Asset[];
  index: number;
  onClose: () => void;
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
export function Fullscreen({ assets, index, onClose }: Props) {
  const [i, setI] = useState(index);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [progress, setProgress] = useState({ cur: 0, dur: 0 });
  const [quality, setQuality] = useState<Quality>('transcoded');
  const [overlay, setOverlay] = useState(true);
  const [videoErr, setVideoErr] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const imgUrlRef = useRef<string | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const resumeAt = useRef(0); // remember position across quality switch

  const asset = assets[i];
  const isVideo = !!asset?.isVideo;

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

  // ---- photo loading (preview JPEG) ----
  useEffect(() => {
    if (!asset || asset.isVideo) {
      setImgSrc(null);
      return;
    }
    let alive = true;
    setImgSrc(null);
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
  }, [asset?.id, isVideo]);

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
        onClose();
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
      if (dir === 'left') {
        e.preventDefault();
        go(-1);
      } else if (dir === 'right') {
        e.preventDefault();
        go(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isVideo, paused, go, seek, togglePlay, poke, onClose]);

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
              else setVideoErr(true);
            }}
          />
        )
      ) : imgSrc ? (
        <img class="fs-img" src={imgSrc} />
      ) : (
        <div class="msg">Loading…</div>
      )}

      {/* overlay UI */}
      <div class="fs-ui">
        {/* top bar */}
        <div class="fs-top">
          <button class="fs-btn" onClick={onClose} title="Back to grid">
            <Icon name="back" size={28} />
            <span>Back</span>
          </button>
          <div class="fs-top-right">
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
            <div class="fs-seek">
              <div class="fs-seek-fill" style={{ width: `${pct}%` }} />
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
