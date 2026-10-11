import { useState, useCallback } from 'preact/hooks';
import { activateProfile, getProfiles, removeProfile } from '../auth/profiles';
import { Icon } from '../components/Icon';

interface Props {
  onClose: () => void;
  onProfileChanged: () => void;
}

export function AccountSwitcher({ onClose, onProfileChanged }: Props) {
  const [profiles, setProfiles] = useState(getProfiles());

  const switchTo = useCallback(
    (id: string) => {
      const profile = activateProfile(id);
      if (!profile) return;

      onProfileChanged();
      onClose();
    },
    [onClose, onProfileChanged],
  );

  const remove = useCallback((id: string) => {
    const ok = removeProfile(id);
    if (!ok) return;

    setProfiles(getProfiles());
  }, []);

  const activeId = localStorage.getItem('immich.activeProfile');

  return (
    <div class="account-switcher">
      <div class="account-switcher-header">
        <h2>Accounts</h2>
        <button onClick={onClose} class="focusable" aria-label="Close accounts">
          <Icon name="close" size={22} />
        </button>
      </div>

      {profiles.length === 0 ? (
        <div class="account-switcher-empty">
          <p>No saved accounts yet.</p>
        </div>
      ) : (
        <div class="account-switcher-list">
          {profiles.map((profile) => (
            <div
              key={profile.id}
              class={'account-switcher-item' + (profile.id === activeId ? ' active' : '')}
            >
              <div class="account-switcher-item-main">
                <div class="account-switcher-item-name">{profile.name}</div>
                <div class="account-switcher-item-server">{profile.server}</div>
                <div class="account-switcher-item-email">{profile.user.email}</div>
              </div>

              <div class="account-switcher-item-actions">
                {activeId !== profile.id ? (
                  <button class="focusable" onClick={() => switchTo(profile.id)}>
                    Switch
                  </button>
                ) : null}

                <button
                  class="focusable destructive"
                  onClick={() => remove(profile.id)}
                  aria-label={`Remove ${profile.name}`}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
