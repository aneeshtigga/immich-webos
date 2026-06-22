// webOS / LG remote key codes. Arrows + Enter are standard; Back (461) is
// the webOS remote's back button. RETURN (10009) appears on some Tizen-ish
// remotes — handled too for safety.
export const Key = {
  Left: 37,
  Up: 38,
  Right: 39,
  Down: 40,
  Enter: 13,
  Back: 461,
  BackAlt: 10009,
  Escape: 27, // dev: stands in for the remote Back key in a PC browser
  Play: 415,
  Pause: 19,
  PlayPause: 463,
  Stop: 413,
  Rewind: 412,
  FastForward: 417,
} as const;

export type Direction = 'left' | 'up' | 'right' | 'down';

export function dirFromKey(code: number): Direction | null {
  switch (code) {
    case Key.Left:
      return 'left';
    case Key.Up:
      return 'up';
    case Key.Right:
      return 'right';
    case Key.Down:
      return 'down';
    default:
      return null;
  }
}

export function isBack(code: number): boolean {
  return code === Key.Back || code === Key.BackAlt || code === Key.Escape;
}
