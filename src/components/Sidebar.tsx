import { useState, useEffect } from 'preact/hooks';
import { Icon } from './Icon';
import { IconName } from './icons';
import { ImmichLogo } from './ImmichLogo';
import { isWebOS, checkForUpdate } from '../api/localRelay';
import pkg from '../../package.json';

const APP_VERSION = 'v' + pkg.version;

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
  onUpdateAvailable?: (version: string) => void;
}

// Single floating rail card. Collapsed it's a 76px icon strip; open it widens
// to 300px and reveals the labels — the SAME element grows, not a second drawer
// sliding over it.
//
// Smoothness: animating `width` normally relayouts the contents every frame
// (the old chop). We avoid that by laying the inner content out at a FIXED
// width (.rail-inner) regardless of the outer card's animated width, so growing
// the card just reveals more of already-laid-out content (overflow:hidden clips
// it) — no text reflow per frame. `contain` bounds the relayout/repaint to the
// card's own small box, so the (huge) grid behind it is never touched.
//
// Focusability: the nav buttons join d-pad navigation (data-focusable +
// data-sidebar) ONLY while open, so the collapsed strip stays out of the grid's
// focus order. Collapsed, they remain pointer-clickable (magic remote).
type UpdateStatus = 'idle' | 'checking' | 'upToDate' | 'installing' | 'error';

export function Sidebar({ open, active, userName, onNavigate, onLogout, onUpdateAvailable }: Props) {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateLabel, setUpdateLabel] = useState(APP_VERSION);

  const handleUpdate = async () => {
    if (updateStatus === 'checking') return;
    setUpdateStatus('checking');
    setUpdateLabel('Checking...');
    const result = await checkForUpdate();
    if ('error' in result) {
      setUpdateLabel(result.error.slice(0, 28));
      setUpdateStatus('error');
      setTimeout(() => { setUpdateStatus('idle'); setUpdateLabel(APP_VERSION); }, 4000);
    } else if ('upToDate' in result) {
      setUpdateLabel('Up to date');
      setUpdateStatus('upToDate');
      setTimeout(() => { setUpdateStatus('idle'); setUpdateLabel(APP_VERSION); }, 3000);
    } else {
      if (result.latestVersion === pkg.version) {
        setUpdateLabel('Up to date');
        setUpdateStatus('upToDate');
        setTimeout(() => { setUpdateStatus('idle'); setUpdateLabel(APP_VERSION); }, 3000);
      } else {
        setUpdateLabel('v' + result.latestVersion + ' available');
        setUpdateStatus('upToDate');
        onUpdateAvailable?.(result.latestVersion);
      }
    }
  };
  // Warm-up: prime the open-state card (full width + its box-shadow blur) into
  // the GPU cache once at mount, invisibly, so the first real open paints
  // without a cold hitch. A 3-step state machine across frames keeps the
  // teardown from animating: `.priming` pins transition:none + opacity:0, held
  // through the frame where width jumps back to collapsed, then dropped only
  // once it's settled — re-enabling the transition with nothing pending.
  //   prime  -> open + priming   (full width, shadow, invisible, no-anim)
  //   settle -> priming          (width jumps back to collapsed, no-anim)
  //   done   -> (none)           (transition restored, nothing to animate)
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
  const railOpen = open || warm === 'prime';
  // d-pad focusability only when genuinely open (not during the warm-up prime).
  const navAttrs = open
    ? { 'data-focusable': true, 'data-sidebar': true }
    : { tabIndex: -1 };

  return (
    <aside
      class={'rail ' + (railOpen ? 'open ' : '') + (priming ? 'priming' : '')}
    >
      {/* fixed-width inner: never reflows as the outer card animates width */}
      <div class="rail-inner">
        <div class="rail-brand">
          <ImmichLogo size={30} />
          <span class="rail-label">Immich</span>
        </div>

        <nav class="rail-nav">
          {ITEMS.map((it) => (
            <button
              key={it.route}
              {...navAttrs}
              class={'rail-item focusable ' + (active === it.route ? 'active' : '')}
              onClick={() => onNavigate(it.route)}
            >
              <Icon name={it.icon} size={26} />
              <span class="rail-label">{it.label}</span>
            </button>
          ))}
        </nav>

        <div class="rail-foot">
          <div class="rail-item user">
            <Icon name="account" size={26} />
            <span class="rail-label">{userName || 'Account'}</span>
          </div>
          {isWebOS() && (
            <button
              {...navAttrs}
              class={'rail-item focusable' + (updateStatus === 'error' ? ' rail-item--error' : updateStatus === 'upToDate' ? ' rail-item--ok' : '')}
              onClick={handleUpdate}
            >
              <Icon name="update" size={26} />
              <span class="rail-label">{updateLabel}</span>
            </button>
          )}
          <button
            {...navAttrs}
            class="rail-item focusable"
            onClick={onLogout}
          >
            <Icon name="logout" size={26} />
            <span class="rail-label">Sign out</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
