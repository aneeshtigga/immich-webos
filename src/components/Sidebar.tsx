import { useState, useEffect } from 'preact/hooks';
import { Icon } from './Icon';
import { IconName } from './icons';
import { ImmichLogo } from './ImmichLogo';

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

// Immich-style left rail. Two layers:
//  - `.rail`: a static icon strip, always visible, that never animates.
//  - `.sidebar`: the labeled drawer that slides over the rail on reveal.
// The drawer is animated with transform (translateX), not width, so the open /
// close transition is GPU-composited and stays smooth on the TV — animating
// width relayouts + repaints every frame and was the source of the chop.
//
// The Home shell reveals the drawer on a left-edge d-pad press and collapses it
// when focus returns to the grid. Only the drawer's buttons are focusable
// (data-focusable); the rail icons are pointer-clickable (magic remote) but out
// of the d-pad focus order.
export function Sidebar({ open, active, userName, onNavigate, onLogout }: Props) {
  // Warm-up: the first real open is otherwise cold — the TV GPU has to
  // rasterize the drawer's layer AND its big `box-shadow` blur on that first
  // frame, so the opening slide hitches once. At mount we briefly flip the
  // drawer into its `.open` state (translateX(0) + the shadow), invisible
  // (.priming pins opacity:0 + pointer-events:none). Chromium rasterizes
  // opacity:0 layers, so the texture + shadow land in the GPU cache; the user's
  // first real open then hits a warm layer and slides at full speed. opacity:0
  // (not display:none/visibility:hidden) is required — those skip rasterization.
  //
  // Teardown runs a 3-step state machine across frames so dropping the prime
  // never shows a slide-out: `.priming` also sets `transition:none`, and we
  // keep it on through the frame where the drawer's transform jumps back
  // offscreen (translateX(-100%)) — so that jump is instant — then drop it only
  // once the transform has already settled, re-enabling the transition with no
  // pending value change to animate.
  //   prime  -> classes: open + priming   (onscreen, shadow, invisible, no-anim)
  //   settle -> classes: priming          (transform jumps offscreen, no-anim)
  //   done   -> classes: (none)            (transition restored, nothing to anim)
  const [warm, setWarm] = useState<'prime' | 'settle' | 'done'>('prime');
  useEffect(() => {
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      setWarm('settle');
      r2 = requestAnimationFrame(() => setWarm('done'));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, []);

  const priming = warm !== 'done';
  const drawerOpen = open || warm === 'prime';

  return (
    <>
      {/* static collapsed rail (icons only) */}
      <aside class="rail">
        <div class="rail-brand">
          <ImmichLogo size={30} />
        </div>
        <nav class="rail-nav">
          {ITEMS.map((it) => (
            <button
              key={it.route}
              class={'rail-item ' + (active === it.route ? 'active' : '')}
              onClick={() => onNavigate(it.route)}
              tabIndex={-1}
            >
              <Icon name={it.icon} size={26} />
            </button>
          ))}
        </nav>
        <div class="rail-foot">
          <div class="rail-item user">
            <Icon name="account" size={26} />
          </div>
          <button class="rail-item" onClick={onLogout} tabIndex={-1}>
            <Icon name="logout" size={26} />
          </button>
        </div>
      </aside>

      {/* sliding labeled drawer (focusable) */}
      <aside
        class={
          'sidebar ' + (drawerOpen ? 'open ' : '') + (priming ? 'priming' : '')
        }
      >
        <div class="sidebar-brand">
          <ImmichLogo size={30} />
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
    </>
  );
}
