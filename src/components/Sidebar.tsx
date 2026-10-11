import { useState, useEffect } from 'preact/hooks';
import { Icon } from './Icon';
import { IconName } from './icons';
import { ImmichLogo } from './ImmichLogo';
import { isWebOS, checkForUpdate } from '../api/localRelay';
import pkg from '../../package.json';

const APP_VERSION = 'v' + pkg.version;

export type Route = 'timeline' | 'albums' | 'favorites' | 'search' | 'wallpaper';

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
  { route: 'wallpaper', label: 'Wallpaper', icon: 'wallpaper' },
];

interface Props {
  open: boolean;
  active: Route;
  userName?: string;
  onNavigate: (r: Route) => void;
  onLogout: () => void;
  onSwitchAccount: () => void;
}

type UpdateStatus = 'idle' | 'checking' | 'upToDate' | 'installing' | 'error';

export function Sidebar({ open, active, userName, onNavigate, onLogout, onSwitchAccount }: Props) {
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
      }
    }
  };

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
  const navAttrs = open
    ? { 'data-focusable': true, 'data-sidebar': true }
    : { tabIndex: -1 };

  return (
    <>
      <div class={'rail-shadow' + (open ? ' open' : '')} aria-hidden="true" />
      <aside class={'rail ' + (railOpen ? 'open ' : '') + (priming ? 'priming' : '')}>
        <div class="rail-inner">
          <div class="rail-brand">
            <ImmichLogo size={40} />
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

            <button
              {...navAttrs}
              class="rail-item focusable"
              onClick={onSwitchAccount}
            >
              <Icon name="account" size={26} />
              <span class="rail-label">Accounts</span>
            </button>

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
    </>
  );
}
