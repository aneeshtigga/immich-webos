// Geometric spatial-navigation engine for TV remote dpad.
//
// CSS :focus alone is unreliable on webOS, and the platform has no built-in
// spatial nav for web apps, so we implement it: any element with the
// `data-focusable` attribute participates. On an arrow press we find the
// best candidate in that direction by a scoring function (primary-axis
// distance + perpendicular offset penalty), move DOM focus, and scroll it
// into view.
//
// Views call setRoot() when they mount so navigation is scoped to the
// currently visible screen, and focusFirst() to set an initial focus.

import { Direction } from './keys';

let root: HTMLElement = document.body;

export function setRoot(el: HTMLElement | null): void {
  root = el || document.body;
}

export function focusables(): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('[data-focusable]'),
  ).filter((el) => el.offsetParent !== null); // visible only
}

export function focusFirst(): void {
  const els = focusables();
  if (els.length) focus(els[0]);
}

export function focus(el: HTMLElement): void {
  el.focus();
  el.scrollIntoView({ block: 'center', inline: 'center' });
}

function center(r: DOMRect) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Returns the best element to move to, or null if none in that direction.
export function nextInDirection(dir: Direction): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  const els = focusables();
  // Nothing focused yet (e.g. first key press after a view loads): start in the
  // content area, never the sidebar. The sidebar is only entered deliberately
  // via the left-edge reveal.
  if (!active || !els.includes(active)) {
    return els.find((e) => !e.hasAttribute('data-sidebar')) || els[0] || null;
  }

  // Thumbnails form a linear chronological sequence (data-seq). Justified rows
  // have ragged right/left edges, so pure geometry on left/right jumps to a
  // thumb in another row that happens to sit further out. For sequence items,
  // left/right instead walks DOM order — last-in-row -> first-of-next-row and
  // vice versa — which is the intended timeline traversal. Up/down stay
  // geometric so they move between rows.
  if (active.hasAttribute('data-seq') && (dir === 'left' || dir === 'right')) {
    const seq = els.filter((e) => e.hasAttribute('data-seq'));
    const idx = seq.indexOf(active);
    if (idx !== -1) {
      const next = dir === 'right' ? seq[idx + 1] : seq[idx - 1];
      return next || null;
    }
  }

  // Sidebar and content are separate nav zones; you only cross between them via
  // the left-edge reveal / right-edge collapse (handled in useRemote's onEdge),
  // never by geometric scoring. So:
  //  - inside the sidebar -> only sidebar items are candidates (no escaping to
  //    the grid when pressing Down past the bottom item)
  //  - inside the content -> sidebar items are excluded (Up from the top grid
  //    row must not jump onto the collapsed icon rail)
  const inSidebar = active.hasAttribute('data-sidebar');
  const candidates = els.filter(
    (e) => e.hasAttribute('data-sidebar') === inSidebar,
  );

  const from = active.getBoundingClientRect();
  const fc = center(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of candidates) {
    if (el === active) continue;
    const r = el.getBoundingClientRect();
    const c = center(r);
    const dx = c.x - fc.x;
    const dy = c.y - fc.y;

    // must lie predominantly in the requested direction
    let primary: number, perp: number;
    switch (dir) {
      case 'left':
        if (dx >= -1) continue;
        primary = -dx;
        perp = Math.abs(dy);
        break;
      case 'right':
        if (dx <= 1) continue;
        primary = dx;
        perp = Math.abs(dy);
        break;
      case 'up':
        if (dy >= -1) continue;
        primary = -dy;
        perp = Math.abs(dx);
        break;
      case 'down':
        if (dy <= 1) continue;
        primary = dy;
        perp = Math.abs(dx);
        break;
    }
    // perpendicular offset weighted heavily so we stay in the same row/column
    const score = primary + perp * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

export function move(dir: Direction): boolean {
  const el = nextInDirection(dir);
  if (el) {
    focus(el);
    return true;
  }
  return false;
}
