// Quit the app using webOS's native flow. platformBack() hands control to the
// platform, which closes the app (and shows LG's own exit handling). Falls back
// to window.close() off-device (dev browser).
export function exitApp(): void {
  const sys = (window as any).webOSSystem;
  if (sys && typeof sys.platformBack === 'function') {
    sys.platformBack();
  } else {
    window.close();
  }
}
