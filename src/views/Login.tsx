import { useState, useRef, useEffect } from 'preact/hooks';
import { ImmichLogo } from '../components/ImmichLogo';
import { login } from '../api/client';
import { getServer, saveSession, normalizeServer, getPairIssuer } from '../auth/store';
import { useRemote } from '../nav/useRemote';
import { exitApp } from '../nav/exit';
import { Key } from '../nav/keys';
import {
  requestDeviceCode,
  pollUntilDone,
  DeviceCodeResponse,
  DeviceExpired,
} from '../api/deviceAuth';
import { QRCode } from '../components/QRCode';
import { startLocalRelay, isWebOS } from '../api/localRelay';

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

  // --- QR (phone) sign-in via the device-authorization flow ---
  // Issuer resolution: on webOS, start the bundled on-device relay service and
  // use the LAN URL it returns — fully self-contained, no external server. Off
  // webOS (dev browser), fall back to an externally hosted relay if configured
  // via VITE_PAIR_ISSUER / localStorage. If neither is available, the QR panel
  // is hidden and only the manual form shows.
  const [device, setDevice] = useState<DeviceCodeResponse | null>(null);
  const [qrError, setQrError] = useState('');
  const [qrEnabled, setQrEnabled] = useState(isWebOS() || !!getPairIssuer());

  useEffect(() => {
    const signal = { aborted: false };
    let restartTimer: number | undefined;

    const resolveIssuer = async (): Promise<string | null> => {
      if (isWebOS()) {
        const info = await startLocalRelay(); // throws if the service won't start
        return info.base;
      }
      return getPairIssuer() || null;
    };

    const begin = async (issuer: string) => {
      setQrError('');
      try {
        const dc = await requestDeviceCode(issuer);
        if (signal.aborted) return;
        setDevice(dc);
        const res = await pollUntilDone(issuer, dc, signal);
        if (signal.aborted) return;
        // phone approved → token minted by the relay; log straight in.
        saveSession(res.server_url, res.access_token, res.user);
        onLogin();
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof DeviceExpired) {
          restartTimer = window.setTimeout(() => begin(issuer), 0); // fresh code
          return;
        }
        setQrError('Phone sign-in unavailable. Use the form.');
      }
    };

    resolveIssuer()
      .then((issuer) => {
        if (signal.aborted) return;
        if (!issuer) {
          setQrEnabled(false);
          return;
        }
        setQrEnabled(true);
        begin(issuer);
      })
      .catch(() => {
        if (!signal.aborted) setQrEnabled(false); // on-device relay failed to start
      });

    return () => {
      signal.aborted = true;
      window.clearTimeout(restartTimer);
    };
  }, []);

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
    const isInput = (e.target as HTMLElement)?.tagName === 'INPUT';

    // OK/Enter while a text field is focused belongs to the webOS on-screen
    // keyboard (selecting a key). The global remote handler would otherwise
    // call preventDefault + active.click() on the input, swallowing that first
    // keypress — which is why the very first letter was lost when the VKB had
    // just opened via d-pad (the magic-mouse pointer never fires Enter, so it
    // worked). Stop propagation so the global handler never sees it, and do NOT
    // preventDefault, so the platform keyboard receives the key.
    if (isInput && code === Key.Enter) {
      e.stopPropagation();
      return;
    }

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

  // webOS raises its on-screen keyboard on focus but only enters active EDIT
  // mode on a pointer click — so a programmatic .focus() (any d-pad nav into the
  // field) showed the keyboard yet ate the first keypress (it bound editing
  // instead of typing), while a magic-mouse click worked immediately. Emulating
  // the click on focus puts the VKB straight into edit mode so the first letter
  // registers. Runs for every focus path (initial, d-pad step, geometric nav).
  const onFieldFocus = (e: FocusEvent) => {
    const el = e.target as HTMLInputElement;
    // guard against the click re-triggering focus → click loops
    if (el.dataset.vkbReady === '1') return;
    el.dataset.vkbReady = '1';
    el.click();
    setTimeout(() => delete el.dataset.vkbReady, 0);
  };

  // Set the server URL's scheme without losing whatever host the user typed.
  // Strips any existing scheme, then prefixes the chosen one.
  const setScheme = (scheme: 'http://' | 'https://') => {
    setServer((s) => scheme + s.replace(/^\s*https?:\/\//i, ''));
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
    <div class={'login' + (qrEnabled ? ' login--split' : '')}>
      <div class="login-left">
        <div class="login-brand">
          <ImmichLogo class="login-logo" />
          <div class="login-brand-text">
            <span class="login-brand-name">immich <span class="login-brand-platform">webOS</span></span>
          </div>
        </div>
        <h1 class="login-heading">Sign in to your server</h1>
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
            onFocus={onFieldFocus}
          />
          <div class="scheme-row">
            <button
              type="button"
              data-focusable
              class="focusable scheme-btn"
              onClick={() => setScheme('http://')}
              onKeyDown={onFieldKey}
            >
              http://
            </button>
            <button
              type="button"
              data-focusable
              class="focusable scheme-btn"
              onClick={() => setScheme('https://')}
              onKeyDown={onFieldKey}
            >
              https://
            </button>
          </div>
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
            onFocus={onFieldFocus}
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
            onFocus={onFieldFocus}
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

      {qrEnabled && (
        <aside class="login-right">
          {qrError ? (
            <div class="login-error">{qrError}</div>
          ) : device ? (
            <>
              <QRCode value={device.verification_uri_complete} />
              <p class="login-qr-hint">
                Scan QR code or go to
                <br />
                <strong>{device.verification_uri.replace(/^https?:\/\//, '')}</strong>
              </p>
              <p class="login-qr-enter">Enter the code</p>
              <p class="login-qr-code">{device.user_code}</p>
            </>
          ) : (
            <div class="fs-spinner login-qr-spinner" />
          )}
        </aside>
      )}
    </div>
  );
}
