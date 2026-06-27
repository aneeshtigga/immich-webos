import { useEffect, useState } from 'preact/hooks';

const PETAL_COLORS = ['#FA2921', '#ED79B5', '#FFB400', '#1E83F7', '#18C249'];

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function Splash({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const [color] = useState(() => PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)]);

  useEffect(() => {
    document.documentElement.style.setProperty('--brand-color', color);
    const fade = setTimeout(() => setLeaving(true), 1600);
    const done = setTimeout(onDone, 2100);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [onDone]);

  return (
    <div class={'splash ' + (leaving ? 'leaving' : '')}>
      <div class="splash-warmth" style={{ background: `radial-gradient(ellipse 65% 65% at 50% 50%, ${hexToRgba(color, 0.4)} 0%, transparent 70%)` }} />
      <svg class="splash-orb" viewBox="0 0 1024 1024" width="220" height="220">
        <defs>
          <radialGradient id="sp-core-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="30%" stopColor={color} stopOpacity="0.7" />
            <stop offset="100%" stopColor={color} />
          </radialGradient>
          <filter id="sp-blur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="40" />
          </filter>
        </defs>
        {/* ambient glow */}
        <circle cx="512" cy="512" r="220" fill={color} class="orb-glow" filter="url(#sp-blur)" />
        {/* core — white center fading to petal color at edges */}
        <circle cx="512" cy="512" r="170" fill="url(#sp-core-grad)" class="orb-core" />
        {/* glass shell — ring tinted with petal color */}
        <circle cx="512" cy="512" r="300"
                fill={hexToRgba(color, 0.12)}
                stroke={hexToRgba(color, 0.75)}
                strokeWidth="10"
                class="orb-ring" />
        {/* glass highlights */}
        <ellipse cx="420" cy="340" rx="120" ry="55"
                 fill="white" transform="rotate(-20 420 340)"
                 class="orb-hi1" />
        <ellipse cx="650" cy="690" rx="60" ry="35"
                 fill="white" transform="rotate(-25 650 690)"
                 class="orb-hi2" />
      </svg>
    </div>
  );
}
