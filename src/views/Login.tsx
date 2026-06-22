import { useState, useRef } from 'preact/hooks';
import { login } from '../api/client';
import { getServer, saveSession, normalizeServer } from '../auth/store';
import { useRemote } from '../nav/useRemote';

// Login screen. Server URL is prefilled (see auth/store DEFAULT_SERVER) so the
// common case is just email + password. On-screen keyboard is the webOS system
// keyboard, triggered automatically when a text input gains focus.
export function Login({ onLogin }: { onLogin: () => void }) {
  const [server, setServer] = useState(getServer());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Inputs handle their own arrow keys; only intercept Back here.
  useRemote({ onBack: () => {} });

  async function submit(e: Event) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const srv = normalizeServer(server);
      const res = await login(srv, email.trim(), password);
      saveSession(srv, res.accessToken, {
        userId: res.userId,
        name: res.name,
        email: res.userEmail,
      });
      onLogin();
    } catch (err: any) {
      const status = err?.status;
      setError(
        status === 401
          ? 'Wrong email or password.'
          : `Could not reach server. Check the URL and that the TV is on the same network. (${err?.message || 'network error'})`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="login">
      <h1 class="login-title">Immich</h1>
      <form ref={formRef} class="login-form" onSubmit={submit}>
        <label class="field">
          <span>Server URL</span>
          <input
            data-focusable
            class="focusable input"
            type="url"
            value={server}
            placeholder="http://192.168.1.2:30041"
            onInput={(e) => setServer((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>Email</span>
          <input
            data-focusable
            class="focusable input"
            type="email"
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>Password</span>
          <input
            data-focusable
            class="focusable input"
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
        </label>
        {error && <div class="login-error">{error}</div>}
        <button data-focusable type="submit" class="focusable btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
