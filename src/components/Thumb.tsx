import { useEffect, useState, useRef } from 'preact/hooks';
import { loadThumb } from '../api/media';
import { thumbObserver } from './lazyObserver';
import { Icon } from './Icon';

interface Props {
  assetId: string;
  isVideo: boolean;
  duration?: number | string | null;
  width: number;
  height: number;
  onSelect: () => void;
}

// Single justified-grid cell sized to explicit width/height (aspect preserved
// by the parent's justified-row math). Lazily fetches its thumbnail blob when
// near the viewport. Marked focusable for remote nav.
export function Thumb({ assetId, isVideo, duration, width, height, onSelect }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    thumbObserver.observe(el, () => {
      setNear(true);
      thumbObserver.unobserve(el);
    });
    return () => thumbObserver.unobserve(el);
  }, []);

  // Load once near the viewport, retrying a few times with backoff. A thumb
  // fetch can fail transiently (a slot's fetch timed out, wifi hiccup); without
  // a retry the cell would keep its placeholder forever, since the observer has
  // already unobserved it and nothing re-triggers the load. Bounded attempts so
  // a genuinely-missing asset doesn't loop.
  useEffect(() => {
    if (!near) return;
    let alive = true;
    let timer = 0;
    const attempt = (n: number) => {
      loadThumb(assetId)
        .then((url) => alive && setSrc(url))
        .catch(() => {
          if (alive && n < 4) timer = window.setTimeout(() => attempt(n + 1), 1000 * (n + 1));
        });
    };
    attempt(0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [near, assetId]);

  return (
    <button
      ref={ref}
      data-focusable
      data-seq
      data-asset-id={assetId}
      class="thumb focusable"
      style={{ width: `${width}px`, height: `${height}px` }}
      onClick={onSelect}
    >
      {src ? (
        <img class="thumb-img" src={src} loading="lazy" />
      ) : (
        <div class="thumb-ph" style={{ background: phColor(assetId) }} />
      )}
      {isVideo && (
        <span class="thumb-badge">
          <Icon name="playCircle" size={18} />
          {formatDuration(duration)}
        </span>
      )}
    </button>
  );
}

// Flat random-ish placeholder tint, derived deterministically from the asset id
// so a given cell keeps the same color across re-renders (no flicker) without
// storing anything. A plain solid fill is the cheapest thing the TV GPU can
// paint — no gradient, no shimmer animation, no need to match the image's
// aspect ratio (the cell is already sized by the justified layout). Dark, low
// saturation so the grid reads as quiet placeholders, not a confetti wall.
function phColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 14%, 16%)`;
}

function formatDuration(d?: number | string | null): string {
  if (d == null) return '';
  if (typeof d === 'string' && d.includes(':')) return d.split('.')[0].replace(/^00:/, '');
  const secs = typeof d === 'string' ? parseFloat(d) : d;
  if (!isFinite(secs)) return '';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
