export function ImmichLogo({ size = 30, class: cls }: { size?: number; class?: string }) {
  return (
    <svg width={cls ? undefined : size} height={cls ? undefined : size} class={cls ? `logo-orb ${cls}` : 'logo-orb'} viewBox="160 160 704 704" aria-label="Immich">
      <defs>
        <radialGradient id="il-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="30%" stopColor="currentColor" stopOpacity="0.7" />
          <stop offset="100%" stopColor="currentColor" />
        </radialGradient>
        <filter id="il-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="35" />
        </filter>
      </defs>
      <circle cx="512" cy="512" r="220" class="logo-glow" filter="url(#il-blur)" />
      <circle cx="512" cy="512" r="170" fill="url(#il-core)" />
      <circle cx="512" cy="512" r="300"
              class="logo-ring"
              strokeWidth="10" />
      <ellipse cx="420" cy="340" rx="120" ry="55"
               fill="white" opacity="0.55"
               transform="rotate(-20 420 340)" />
      <ellipse cx="650" cy="690" rx="60" ry="35"
               fill="white" opacity="0.45"
               transform="rotate(-25 650 690)" />
    </svg>
  );
}
