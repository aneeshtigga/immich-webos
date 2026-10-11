import type { AuthKind, SessionUser } from './store';

export interface StoredProfile {
  id: string;
  name: string;
  server: string;
  token: string;
  authKind: AuthKind;
  user: SessionUser;
  createdAt: number;
  lastUsedAt: number;
}

const PROFILES_KEY = 'immich.profiles';
const ACTIVE_PROFILE_KEY = 'immich.activeProfile';

function normalizeServer(server: string): string {
  let s = server.trim().replace(/\/+$/, '');
  s = s.replace(/\/api$/, '');
  return s;
}

function hostnameFrom(server: string): string {
  try {
    return new URL(server).hostname;
  } catch {
    return server.replace(/^https?:\/\//, '');
  }
}

export function getProfiles(): StoredProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as StoredProfile[]) : [];
  } catch {
    return [];
  }
}

export function getProfile(id: string): StoredProfile | null {
  return getProfiles().find((profile) => profile.id === id) ?? null;
}

export function getActiveProfileId(): string | null {
  return localStorage.getItem(ACTIVE_PROFILE_KEY);
}

export function clearActiveProfile(): void {
  localStorage.removeItem(ACTIVE_PROFILE_KEY);
}

export function setActiveProfile(id: string): StoredProfile | null {
  const profile = getProfile(id);
  if (!profile) return null;

  const profiles = getProfiles().map((item) =>
    item.id === id ? { ...item, lastUsedAt: Date.now() } : item,
  );

  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles.sort((a, b) => b.lastUsedAt - a.lastUsedAt)));
  localStorage.setItem(ACTIVE_PROFILE_KEY, id);
  return profile;
}

export function removeProfile(id: string): boolean {
  const profiles = getProfiles();
  const next = profiles.filter((profile) => profile.id !== id);

  if (next.length === profiles.length) return false;

  localStorage.setItem(PROFILES_KEY, JSON.stringify(next));

  if (getActiveProfileId() === id) {
    clearActiveProfile();
  }

  return true;
}

export function saveProfileForLogin(
  server: string,
  token: string,
  user: SessionUser,
  authKind: AuthKind,
): StoredProfile {
  const normalized = normalizeServer(server);
  const profiles = getProfiles();
  const now = Date.now();
  const displayName = `${hostnameFrom(normalized)} - ${user.email.split('@')[0]}`;

  const existing = profiles.find(
    (profile) =>
      profile.server === normalized &&
      profile.user.userId === user.userId &&
      profile.authKind === authKind,
  );

  const nextProfile: StoredProfile = existing
    ? {
        ...existing,
        server: normalized,
        token,
        authKind,
        user,
        name: existing.name || displayName,
        lastUsedAt: now,
      }
    : {
        id: `profile_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: displayName,
        server: normalized,
        token,
        authKind,
        user,
        createdAt: now,
        lastUsedAt: now,
      };

  const updated = existing
    ? profiles.map((profile) => (profile.id === existing.id ? nextProfile : profile))
    : [...profiles, nextProfile];

  localStorage.setItem(PROFILES_KEY, JSON.stringify(updated.sort((a, b) => b.lastUsedAt - a.lastUsedAt)));
  localStorage.setItem(ACTIVE_PROFILE_KEY, nextProfile.id);

  return nextProfile;
}

export function activateProfile(id: string): StoredProfile | null {
  const profile = getProfile(id);
  if (!profile) return null;
  setActiveProfile(id);
  return profile;
}
