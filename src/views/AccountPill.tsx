import { useEffect, useRef, useState } from 'preact/hooks';
import { getActiveProfileId, getProfiles, removeProfile, type StoredProfile } from '../auth/profiles';
import { activateProfile } from '../auth/store';
import { validateToken } from '../api/client';
import { useRemote } from '../nav/useRemote';
import { Key } from '../nav/keys';
import { Icon } from '../components/Icon';
import { UserInitial } from '../components/UserInitial';

interface Props {
  anchor: HTMLElement; // the sidebar user row it pops out from
  // Opened by pointer hover (magic remote): no scrim, no auto-focus, and the
  // remote stays with Home. Opened by click/Enter: owns the remote.
  hover: boolean;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onClose: () => void;
  onProfileChanged: () => void;
  onAddAccount: () => void;
}

// Account switcher popped out of the sidebar's user row: one letter circle per
// OTHER saved account (the current one is the row itself) plus "+" to sign in
// to another, in a single pill. Opened from
// the remote it owns the keys (like ConfirmDialog): Left/Right step, Enter
// picks, Back or Up/Down closes.
export function AccountPill({
  anchor,
  hover,
  onPointerEnter,
  onPointerLeave,
  onClose,
  onProfileChanged,
  onAddAccount,
}: Props) {
  // Snapshot once: pick() activates the new profile before the reload, and a
  // live read would then re-render the pill with the old account swapped in.
  const [profiles] = useState(() => {
    const activeId = getActiveProfileId();
    return getProfiles().filter((p) => p.id !== activeId);
  });
  const [busy, setBusy] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const items = () =>
    Array.from(rowRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);

  useEffect(() => {
    if (hover) return;
    items()[0]?.focus();
  }, [hover]);

  const onKey = (code: number): boolean => {
    if (code === Key.Up || code === Key.Down) {
      onClose();
      return true;
    }
    const step = code === Key.Left ? -1 : code === Key.Right ? 1 : 0;
    if (!step) return false;
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[Math.max(0, Math.min(list.length - 1, i + step))]?.focus();
    return true;
  };

  useRemote({ onKey, onBack: onClose, enabled: !hover && !busy });

  const pick = async (p: StoredProfile) => {
    setBusy(true);
    activateProfile(p.id);
    // A saved session token can be revoked server-side (signed out elsewhere,
    // demo server reset). Drop it and go to Login instead of reloading into an
    // "Invalid user token" timeline.
    if (!(await validateToken())) {
      removeProfile(p.id);
      onAddAccount();
      return;
    }
    onProfileChanged();
  };

  // Beside the rail card (not the row: collapsed, the row's laid-out width
  // overflows the 76px strip), vertically centred on the row.
  const row = anchor.getBoundingClientRect();
  const railRight = (anchor.closest('.rail') ?? anchor).getBoundingClientRect().right;

  const pill = (
    <div
      class="account-pill"
      style={{ left: `${railRight + 12}px`, top: `${row.top + row.height / 2}px` }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div class="account-pill-row" ref={rowRef}>
        {profiles.map((p) => (
          <button
            key={p.id}
            data-focusable
            data-noautofocus
            class="pill-item focusable"
            onClick={() => pick(p)}
            aria-label={p.user.name || p.user.email}
          >
            <UserInitial id={p.user.userId} name={p.user.name} email={p.user.email} />
          </button>
        ))}
        <button
          data-focusable
          data-noautofocus
          class="pill-item pill-add focusable"
          onClick={onAddAccount}
          aria-label="Add account"
        >
          <span class="pill-add-ring">
            <Icon name="add" size={24} />
          </span>
        </button>
      </div>
    </div>
  );

  // hover: no scrim, so moving off the pill reaches the row/grid underneath
  return hover ? pill : (
    <div class="pill-scrim" onClick={onClose}>
      {pill}
    </div>
  );
}
