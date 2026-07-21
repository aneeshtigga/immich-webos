import brokenLogo from '../assets/broken_logo.webp';

// Centered empty-state placeholder: the shattered Immich logo, a title, and a
// short hint on how to populate the view. Used by the timeline, favorites,
// albums and wallpaper surfaces when they resolve to nothing.
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div class="empty-state">
      <img class="empty-state-logo" src={brokenLogo} alt="" />
      <div class="empty-state-title">{title}</div>
      {hint && <div class="empty-state-hint">{hint}</div>}
    </div>
  );
}
