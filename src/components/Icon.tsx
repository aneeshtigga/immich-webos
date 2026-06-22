import { ICONS, IconName } from './icons';

interface Props {
  name: IconName;
  size?: number;
  class?: string;
}

// Renders an MDI path in a 24x24 viewBox (the MDI standard).
export function Icon({ name, size = 24, class: cls }: Props) {
  return (
    <svg
      class={cls}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
