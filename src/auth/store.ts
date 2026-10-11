// Persistent auth state: server URL + access token in localStorage.
// webOS web apps have a normal localStorage that survives app restarts.
// Profiles are now used for multi-user / multi-server support.

import {
  clearActiveProfile,
  getActiveProfile,
  getProfile,
  saveProfileForLogin,
  setActiveProfile,
} from './profiles';

const SERVER_KEY = 'immich.server';
const TOKEN_KEY = 'immich.token';
const USER_KEY = 'immich.user';
const ISSUER_KEY = 'immich.pairIssuer';
const KIND_KEY = 'immich.authKind';

// How the stored credential authenticates to Immich. 'session' is a login
// access token (Authorization: Bearer / ?sessionKey); 'apikey' is a personal
// API key (x-api-key / ?apiKey). Same TOKEN_KEY slot holds either.
export type AuthKind = 'session' | 'apikey';

// Prefilled so you don't type a URL on the TV remote. Change in login screen.
const DEFAULT_SERVER = 'http://192.168.1.2:30041';

// Pairing relay (RFC 8628 device-flow issuer) used by the "scan to sign in"
// QR. Configured at build time via VITE_PAIR_ISSUER, overridable at runtime
// (localStorage) for users who host their own relay. Empty => QR sign-in is
// hidden and only the manual form shows.
const DEFAULT_ISSUER = (import.meta as any).env?.VITE_PAIR_ISSUER || '';

export function getPairIssuer(): string {
  return localStorage.getItem(ISSUER_KEY) || DEFAULT_ISSUER;
}

export function setPairIssuer(url: string): void {
  if (url) localStorage.setItem(ISSUER_KEY, url.trim());
  else localStorage.removeItem(ISSUER_KEY);
}

export interface SessionUser {
  userId: string;
  name: string;
  email: string;
}

export function getServer(): string {
  return getActiveProfile()?.server || localStorage.getItem(SERVER_KEY) || DEFAULT_SERVER;
}

export function getToken(): string | null {
  return getActiveProfile()?.token || localStorage.getItem(TOKEN_KEY);
}

export function getAuthKind(): AuthKind {
  return getActiveProfile()?.authKind || (localStorage.getItem(KIND_KEY) === 'apikey' ? 'apikey' : 'session');
}

// Auth as request headers (JSON + binary blob fetches that can set headers).
export function getAuthHeaders(): Record<string, string> {
  const t = getToken();
  if (!t) return {};
  return getAuthKind() === 'apikey'
    ? { 'x-api-key': t }
    : { Authorization: `Bearer ${t}` };
}

// Auth as a query param, for direct <video>/<img> src that can't set headers.
export function getAuthQuery(): Record<string, string> {
  const t = getToken();
  if (!t) return {};
  return getAuthKind() === 'apikey' ? { apiKey: t } : { sessionKey: t };
}

export function getUser(): SessionUser | null {
  return getActiveProfile()?.user || (() => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  })();
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export function applyRuntimeSession(
  server: string,
  token: string,
  user: SessionUser,
  authKind: AuthKind,
): void {
  const normalized = normalizeServer(server);
  localStorage.setItem(SERVER_KEY, normalized);
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  localStorage.setItem(KIND_KEY, authKind);
}

export function saveSession(server: string, token: string, user: SessionUser): void {
  const normalized = normalizeServer(server);
  applyRuntimeSession(normalized, token, user, 'session');
  saveProfileForLogin(normalized, token, user, 'session');
}

export function saveApiKey(server: string, key: string, user: SessionUser): void {
  const normalized = normalizeServer(server);
  applyRuntimeSession(normalized, key, user, 'apikey');
  saveProfileForLogin(normalized, key, user, 'apikey');
}

export function activateProfile(id: string) {
  const profile = getProfile(id);
  if (!profile) return null;

  applyRuntimeSession(profile.server, profile.token, profile.user, profile.authKind);
  setActiveProfile(id);
  return profile;
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(KIND_KEY);
  // keep server URL so re-login is easy
  clearActiveProfile();
}

// Trim trailing slash; tolerate the user pasting a URL with or without /api.
export function normalizeServer(url: string): string {
  let s = url.trim().replace(/\/+$/, '');
  s = s.replace(/\/api$/, '');
  return s;
}
