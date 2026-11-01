import { useState, useCallback, useEffect } from 'preact/hooks';
import { isLoggedIn } from './auth/store';
import { Login } from './views/Login';
import { Home } from './views/Home';
import { Splash } from './components/Splash';
import { AccountPicker } from './views/AccountPicker';
import { getProfiles } from './auth/profiles';

// Top-level: an animated splash on app open, then (with 2+ saved accounts) the
// launch account picker, then Login until authenticated, then the main Home
// shell (timeline / albums / fullscreen / video).
export function App() {
  const [authed, setAuthed] = useState(isLoggedIn());
  const [splashDone, setSplashDone] = useState(false);
  // 2+ saved accounts, or saved accounts but no active one (left via "Add
  // account" and closed the app): let the user choose instead of Login.
  const [picking, setPicking] = useState(() => {
    if (consumeSkipPicker()) return false;
    const n = getProfiles().length;
    return n >= 2 || (n >= 1 && !isLoggedIn());
  });

  const onLogin = useCallback(() => setAuthed(true), []);
  const onLogout = useCallback(() => setAuthed(false), []);
  const onSplashDone = useCallback(() => setSplashDone(true), []);

  // Suppress browser context menu / text selection feel on TV.
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  if (!splashDone) return <Splash onDone={onSplashDone} />;

  if (picking) {
    return (
      <AccountPicker
        onPicked={() => {
          setPicking(false);
          setAuthed(true);
        }}
        onAddAccount={() => {
          setPicking(false);
          setAuthed(false);
        }}
      />
    );
  }

  const backToPicker = getProfiles().length ? () => setPicking(true) : undefined;
  return authed ? <Home onLogout={onLogout} /> : <Login onLogin={onLogin} onBack={backToPicker} />;
}

// Set by the in-app account switcher right before it reloads into the new
// account, so that reload skips the launch picker. One-shot.
function consumeSkipPicker(): boolean {
  try {
    const skip = sessionStorage.getItem('immich.skipPicker') === '1';
    sessionStorage.removeItem('immich.skipPicker');
    return skip;
  } catch {
    return false;
  }
}
