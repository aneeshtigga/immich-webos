import { useState, useCallback, useEffect } from 'preact/hooks';
import { isLoggedIn } from './auth/store';
import { Login } from './views/Login';
import { Home } from './views/Home';
import { Splash } from './components/Splash';

// Top-level: an animated splash on app open, then Login until authenticated,
// then the main Home shell (timeline / albums / fullscreen / video).
export function App() {
  const [authed, setAuthed] = useState(isLoggedIn());
  const [splashDone, setSplashDone] = useState(false);

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

  return authed ? <Home onLogout={onLogout} /> : <Login onLogin={onLogin} />;
}
