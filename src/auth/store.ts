// Persistent auth state: server URL + access token in localStorage.
// webOS web apps have a normal localStorage that survives app restarts.

const SERVER_KEY = 'immich.server';
const TOKEN_KEY = 'immich.token';
const USER_KEY = 'immich.user';

// Prefilled so you don't type a URL on the TV remote. Change in login screen.
const DEFAULT_SERVER = 'http://192.168.1.2:30041';

export interface SessionUser {
  userId: string;
  name: string;
  email: string;
}

export function getServer(): string {
  return localStorage.getItem(SERVER_KEY) || DEFAULT_SERVER;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): SessionUser | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as SessionUser) : null;
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export function saveSession(server: string, token: string, user: SessionUser): void {
  localStorage.setItem(SERVER_KEY, normalizeServer(server));
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  // keep server URL so re-login is easy
}

// Trim trailing slash; tolerate the user pasting a URL with or without /api.
export function normalizeServer(url: string): string {
  let s = url.trim().replace(/\/+$/, '');
  s = s.replace(/\/api$/, '');
  return s;
}
