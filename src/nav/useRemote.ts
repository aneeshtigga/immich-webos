import { useEffect } from 'preact/hooks';
import { dirFromKey, isBack, Key } from './keys';
import { move } from './focus';

import { Direction } from './keys';

interface Handlers {
  onBack?: () => void;
  onEnter?: () => void;
  // intercept any key first; return true to mark handled and stop default nav
  onKey?: (code: number) => boolean;
  // fired when an arrow press finds no focusable in that direction (screen edge)
  onEdge?: (dir: Direction) => boolean | void;
  // when false the listener is detached (e.g. a fullscreen overlay owns keys)
  enabled?: boolean;
}

// Global remote key handling. Arrow keys drive spatial navigation; Enter
// fires the focused element's click; Back is routed to the view. Views pass
// onKey to grab media-transport keys (play/pause/seek) in the video player.
export function useRemote(handlers: Handlers): void {
  const enabled = handlers.enabled !== false;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const code = e.keyCode;

      if (handlers.onKey && handlers.onKey(code)) {
        e.preventDefault();
        return;
      }

      if (isBack(code)) {
        e.preventDefault();
        handlers.onBack?.();
        return;
      }

      const dir = dirFromKey(code);
      if (dir) {
        e.preventDefault();
        const moved = move(dir);
        if (!moved) handlers.onEdge?.(dir);
        return;
      }

      if (code === Key.Enter) {
        const active = document.activeElement as HTMLElement | null;
        if (active && active.hasAttribute('data-focusable')) {
          e.preventDefault();
          active.click();
        } else {
          handlers.onEnter?.();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, handlers.onBack, handlers.onEnter, handlers.onKey, handlers.onEdge]);
}
