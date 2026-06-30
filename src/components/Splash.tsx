import { useEffect, useState } from 'preact/hooks';
import logoUrl from '../assets/logo.png';
import edgesUrl from '../assets/logo-edges.png';

export function Splash({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const fade = setTimeout(() => setLeaving(true), 3300);
    const done = setTimeout(onDone, 3800);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [onDone]);

  return (
    <div class={'splash ' + (leaving ? 'leaving' : '')}>
      <div class="splash-orb">
        <img src={logoUrl} width="220" height="220" alt="Immich" />
        {/* light sweep, masked to the rim so it only lights the flower's edges */}
        <span
          class="splash-sheen"
          style={{ WebkitMaskImage: `url(${edgesUrl})`, maskImage: `url(${edgesUrl})` }}
        />
      </div>
    </div>
  );
}
