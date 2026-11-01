import { useEffect, useRef, useState } from 'preact/hooks';
import { getActiveProfileId, getProfiles, removeProfile, type StoredProfile } from '../auth/profiles';
import { activateProfile, clearSession } from '../auth/store';
import { validateToken } from '../api/client';
import { useRemote } from '../nav/useRemote';
import { Key } from '../nav/keys';
import { exitApp } from '../nav/exit';
import { Icon } from '../components/Icon';
import { colorFor, initialOf } from '../components/UserInitial';

interface Props {
  onPicked: () => void; // active profile set + token valid -> Home
  onAddAccount: () => void; // no active session -> Login
}

// Launch-time "who's watching" screen (YouTube TV style), shown when 2+
// accounts are saved. Tiles sit in one row: Left/Right step, Enter picks,
// Back exits the app like Home does. The last-used account is focused first
// so a single Enter keeps the old one-press launch. The focused account's full
// server address shows once under the row (tile width would truncate it).
export function AccountPicker({ onPicked, onAddAccount }: Props) {
  const [profiles, setProfiles] = useState(getProfiles());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [focused, setFocused] = useState<StoredProfile | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const tiles = () =>
    Array.from(rowRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);

  useEffect(() => {
    const activeId = getActiveProfileId();
    const list = tiles();
    const i = profiles.findIndex((p) => p.id === activeId);
    list[i >= 0 ? i : 0]?.focus();
  }, []);

  const onKey = (code: number): boolean => {
    const step = code === Key.Left ? -1 : code === Key.Right ? 1 : 0;
    if (code === Key.Up || code === Key.Down) return true; // single row
    if (!step) return false;
    const list = tiles();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[Math.max(0, Math.min(list.length - 1, i + step))]?.focus();
    return true;
  };

  useRemote({ onKey, onBack: exitApp, enabled: !busyId });

  const pick = async (p: StoredProfile) => {
    if (busyId) return;
    setBusyId(p.id);
    activateProfile(p.id);
    // Token may have been revoked server-side since last launch (signed out
    // elsewhere, demo reset): drop it and fall through to Login.
    if (await validateToken()) {
      onPicked();
      return;
    }
    removeProfile(p.id);
    clearSession();
    const left = getProfiles();
    setBusyId(null);
    if (left.length < 2) onAddAccount();
    else setProfiles(left);
  };

  const addAccount = () => {
    clearSession();
    onAddAccount();
  };

  return (
    <div class="picker">
      <h1 class="picker-title">Who's watching?</h1>
      <div class="picker-row" ref={rowRef}>
        {profiles.map((p) => (
          <button
            key={p.id}
            data-focusable
            class={'picker-tile focusable' + (busyId === p.id ? ' busy' : '')}
            onFocus={() => setFocused(p)}
            onMouseEnter={() => setFocused(p)}
            onClick={() => pick(p)}
          >
            <Avatar profile={p} />
            <span class="picker-name">{p.user.name || p.user.email}</span>
          </button>
        ))}
        <button
          data-focusable
          class="picker-tile picker-add focusable"
          onFocus={() => setFocused(null)}
          onMouseEnter={() => setFocused(null)}
          onClick={addAccount}
        >
          <span class="picker-avatar">
            <Icon name="add" size={48} />
          </span>
          <span class="picker-name">Add account</span>
        </button>
      </div>
      {/* keeps its height when empty so the row doesn't shift on Add account */}
      {/* hidden, not removed, on Add account so the row doesn't shift */}
      <div class={'picker-server' + (focused ? '' : ' empty')}>
        <Icon name="server" size={24} />
        <span>
          <span class="picker-server-label">Server:</span> {focused?.server ?? ''}
        </span>
      </div>
    </div>
  );
}

// Immich profile picture, authed with the profile's own token (not the active
// one) since every tile points at a different user/server. Falls back to the
// initial when the user has no picture or the token is dead.
function Avatar({ profile }: { profile: StoredProfile }) {
  const [failed, setFailed] = useState(false);
  const q = profile.authKind === 'apikey' ? 'apiKey' : 'sessionKey';
  const src = `${profile.server}/api/users/${profile.user.userId}/profile-image?${q}=${encodeURIComponent(profile.token)}`;
  const initial = initialOf(profile.user.name, profile.user.email);
  return (
    <span class="picker-avatar" style={{ background: colorFor(profile.user.userId) }}>
      {initial}
      {!failed && <img src={src} alt="" onError={() => setFailed(true)} />}
    </span>
  );
}
