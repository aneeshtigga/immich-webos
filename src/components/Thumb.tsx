import { useEffect, useState, useRef } from 'preact/hooks';
import { loadThumb } from '../api/media';
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
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let alive = true;
    loadThumb(assetId)
      .then((url) => alive && setSrc(url))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [near, assetId]);

  return (
    <button
      ref={ref}
      data-focusable
      class="thumb focusable"
      style={{ width: `${width}px`, height: `${height}px` }}
      onClick={onSelect}
    >
      {src ? (
        <img class="thumb-img" src={src} loading="lazy" />
      ) : (
        <div class="thumb-ph" />
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

function formatDuration(d?: number | string | null): string {
  if (d == null) return '';
  if (typeof d === 'string' && d.includes(':')) return d.split('.')[0].replace(/^00:/, '');
  const secs = typeof d === 'string' ? parseFloat(d) : d;
  if (!isFinite(secs)) return '';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
