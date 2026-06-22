import { Icon } from './Icon';
import { IconName } from './icons';

export type Route = 'timeline' | 'albums' | 'favorites' | 'search';

interface Item {
  route: Route;
  label: string;
  icon: IconName;
}

const ITEMS: Item[] = [
  { route: 'timeline', label: 'Photos', icon: 'photos' },
  { route: 'search', label: 'Search', icon: 'search' },
  { route: 'albums', label: 'Albums', icon: 'albums' },
  { route: 'favorites', label: 'Favorites', icon: 'favorite' },
];

interface Props {
  open: boolean;
  active: Route;
  userName?: string;
  onNavigate: (r: Route) => void;
  onLogout: () => void;
}

// Immich-style left rail. Collapsed to an icon strip by default; expands to
// show labels when `open`. The Home shell reveals it on a left-edge d-pad
// press and collapses it when focus returns to the grid.
export function Sidebar({ open, active, userName, onNavigate, onLogout }: Props) {
  return (
    <aside class={'sidebar ' + (open ? 'open' : 'collapsed')}>
      <div class="sidebar-brand">
        <Icon name="menu" size={26} />
        <span class="sidebar-label">Immich</span>
      </div>

      <nav class="sidebar-nav">
        {ITEMS.map((it) => (
          <button
            key={it.route}
            data-focusable
            data-sidebar
            class={'sidebar-item focusable ' + (active === it.route ? 'active' : '')}
            onClick={() => onNavigate(it.route)}
          >
            <Icon name={it.icon} size={26} />
            <span class="sidebar-label">{it.label}</span>
          </button>
        ))}
      </nav>

      <div class="sidebar-foot">
        <div class="sidebar-item user">
          <Icon name="account" size={26} />
          <span class="sidebar-label">{userName || 'Account'}</span>
        </div>
        <button
          data-focusable
          data-sidebar
          class="sidebar-item focusable"
          onClick={onLogout}
        >
          <Icon name="logout" size={26} />
          <span class="sidebar-label">Sign out</span>
        </button>
      </div>
    </aside>
  );
}
