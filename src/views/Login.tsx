import { useState, useRef } from 'preact/hooks';
import { login } from '../api/client';
import { getServer, saveSession, normalizeServer } from '../auth/store';
import { useRemote } from '../nav/useRemote';
import { exitApp } from '../nav/exit';
import { Key } from '../nav/keys';

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

  // Inputs handle their own arrow keys (below); Back quits via webOS's native
  // exit.
  useRemote({ onBack: () => exitApp() });

  // Move focus between the form's focusable controls by DOM order. The global
  // remote handler does geometric nav AND, on Enter, calls preventDefault +
  // active.click() — which on a text input swallows the key webOS uses to open
  // its on-screen keyboard (so it took two presses to start typing) and fought
  // the field on Up/Down (two presses to move). Handling keys here + stopping
  // propagation makes both deterministic: Up/Down step one field, Enter lets
  // the platform open the keyboard (or submits on the button).
  const onFieldKey = (e: KeyboardEvent) => {
    const code = e.keyCode;
    if (code !== Key.Up && code !== Key.Down) return;
    e.preventDefault();
    e.stopPropagation();
    const form = formRef.current;
    if (!form) return;
    const items = Array.from(
      form.querySelectorAll<HTMLElement>('[data-focusable]'),
    );
    const i = items.indexOf(e.target as HTMLElement);
    if (i === -1) return;
    const next = items[code === Key.Down ? i + 1 : i - 1];
    next?.focus();
  };

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
      <img class="login-logo" src="./immich-logo-inline.svg" alt="Immich" />
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
            onKeyDown={onFieldKey}
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
            onKeyDown={onFieldKey}
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
            onKeyDown={onFieldKey}
          />
        </label>
        {error && <div class="login-error">{error}</div>}
        <button
          data-focusable
          type="submit"
          class="focusable btn-primary"
          disabled={busy}
          onKeyDown={onFieldKey}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
