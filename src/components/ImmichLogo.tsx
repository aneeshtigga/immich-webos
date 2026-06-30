// Small (192px) variant for the in-app marks (sidebar ~80px, login ~151px at
// DPR 2). The full 1024 logo.png is for the splash; the browser downscaling it
// 12x to these tiny boxes looked soft, so ship a right-sized asset here.
import logoUrl from '../assets/logo-sm.png';

export function ImmichLogo({ size = 30, class: cls }: { size?: number; class?: string }) {
  return (
    <img
      src={logoUrl}
      width={cls ? undefined : size}
      height={cls ? undefined : size}
      class={cls ? `logo-orb ${cls}` : 'logo-orb'}
      alt="Immich"
    />
  );
}
