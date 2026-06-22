import { useState, useCallback, useEffect } from 'preact/hooks';
import { isLoggedIn } from './auth/store';
import { Login } from './views/Login';
import { Home } from './views/Home';

// Top-level: show Login until authenticated, then the main Home shell which
// owns its own internal navigation (timeline / albums / fullscreen / video).
export function App() {
  const [authed, setAuthed] = useState(isLoggedIn());

  const onLogin = useCallback(() => setAuthed(true), []);
  const onLogout = useCallback(() => setAuthed(false), []);

  // Suppress browser context menu / text selection feel on TV.
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  return authed ? <Home onLogout={onLogout} /> : <Login onLogin={onLogin} />;
}
