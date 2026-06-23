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
//
// Perf: the focusable set is cached and only rebuilt when the DOM under `root`
// actually changes (tracked by a MutationObserver), instead of re-running
// querySelectorAll on every keypress. The geometric scan is also windowed to a
// slice of the DOM-ordered list around the active element, so the number of
// getBoundingClientRect() reads (each a forced layout) per press is bounded by
// WINDOW rather than by the total thumbnail count. With thousands of grid cells
// the old per-press full-DOM walk was the main source of d-pad input lag.

import { Direction } from './keys';

let root: HTMLElement = document.body;

// Cached list of all [data-focusable] under root, in DOM order. `dirty` is set
// whenever the subtree changes so the next read rebuilds lazily.
let cache: HTMLElement[] = [];
let dirty = true;
let observer: MutationObserver | null = null;

// How many DOM-ordered neighbours either side of the active element to consider
// in the geometric scan. Vertically/horizontally adjacent grid cells are always
// close in DOM order, so a window comfortably larger than a few rows captures
// every real candidate while keeping layout reads bounded.
const WINDOW = 160;

function ensureObserver(): void {
  if (observer) return;
  observer = new MutationObserver(() => {
    dirty = true;
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function setRoot(el: HTMLElement | null): void {
  root = el || document.body;
  dirty = true;
  ensureObserver();
}

function rawList(): HTMLElement[] {
  if (dirty) {
    cache = Array.from(root.querySelectorAll<HTMLElement>('[data-focusable]'));
    dirty = false;
  }
  return cache;
}

function visible(el: HTMLElement): boolean {
  return el.offsetParent !== null;
}

// Public: visible focusables. Used by views for initial-focus logic. Kept as a
// fresh filtered view; callers invoke it rarely (mount / edge), not per-keypress.
export function focusables(): HTMLElement[] {
  return rawList().filter(visible);
}

export function focusFirst(): void {
  const els = focusables();
  if (els.length) focus(els[0]);
}

export function focus(el: HTMLElement): void {
  el.focus({ preventScroll: true }); // we scroll manually, eased (below)
  retarget(el);
}

// Nearest scrollable ancestor (the grid / album scroller), or null.
function scrollParent(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement;
  while (p && p !== document.body) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY + s.overflowX)) return p;
    p = p.parentElement;
  }
  return null;
}

// ---- Eased scroll animator ----
//
// Edge-triggered "safe zone" scrolling, the model streaming apps (AppleTV /
// Netflix / YouTube) use: the highlight moves cell-to-cell freely inside the
// viewport and the list only scrolls when the focused cell reaches a margin
// near an edge — and then only just enough to pull it back inside that margin.
//
// Instead of an instant scrollBy (a hard step each press), the container glides
// toward its target via a per-frame lerp: the focus RING moves instantly (snappy)
// while the CONTENT eases (smooth). Holding the d-pad re-targets the glide each
// press rather than restarting it, so fast traversal stays fluid. clamped to the
// container's scroll range so it never overshoots.

const EASE = 0.22; // fraction of remaining distance per frame (~150ms glide @60fps)
const SNAP = 0.5; // px: close enough → finish and stop the loop

let animSc: HTMLElement | null = null;
let targetTop = 0;
let targetLeft = 0;
let animRaf = 0;

// Compute the desired absolute scroll position to bring `el` inside the safe
// zone, set it as the animation target, and ensure the loop is running.
function retarget(el: HTMLElement): void {
  const sc = scrollParent(el);
  if (!sc) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  const er = el.getBoundingClientRect();
  const cr = sc.getBoundingClientRect();

  // ~one row/column of breathing room before an edge triggers a scroll.
  const marginY = Math.min(cr.height * 0.3, er.height + 24);
  const marginX = Math.min(cr.width * 0.3, er.width + 24);

  // Measure deltas against the LIVE target (where we're heading), not the
  // current mid-glide scroll, so re-targeting mid-animation stays stable.
  const baseTop = animSc === sc ? targetTop : sc.scrollTop;
  const baseLeft = animSc === sc ? targetLeft : sc.scrollLeft;
  const pendTop = baseTop - sc.scrollTop; // scroll already queued but not yet applied
  const pendLeft = baseLeft - sc.scrollLeft;

  let dy = 0;
  if (er.top - pendTop < cr.top + marginY) dy = er.top - pendTop - (cr.top + marginY);
  else if (er.bottom - pendTop > cr.bottom - marginY) dy = er.bottom - pendTop - (cr.bottom - marginY);

  let dx = 0;
  if (er.left - pendLeft < cr.left + marginX) dx = er.left - pendLeft - (cr.left + marginX);
  else if (er.right - pendLeft > cr.right - marginX) dx = er.right - pendLeft - (cr.right - marginX);

  const maxTop = sc.scrollHeight - sc.clientHeight;
  const maxLeft = sc.scrollWidth - sc.clientWidth;
  animSc = sc;
  targetTop = Math.max(0, Math.min(maxTop, baseTop + dy));
  targetLeft = Math.max(0, Math.min(maxLeft, baseLeft + dx));

  if (!animRaf) animRaf = requestAnimationFrame(tick);
}

function tick(): void {
  animRaf = 0;
  const sc = animSc;
  if (!sc || !sc.isConnected) {
    animSc = null;
    return;
  }
  const ny = sc.scrollTop + (targetTop - sc.scrollTop) * EASE;
  const nx = sc.scrollLeft + (targetLeft - sc.scrollLeft) * EASE;
  const doneY = Math.abs(targetTop - sc.scrollTop) <= SNAP;
  const doneX = Math.abs(targetLeft - sc.scrollLeft) <= SNAP;

  sc.scrollTop = doneY ? targetTop : ny;
  sc.scrollLeft = doneX ? targetLeft : nx;

  if (doneY && doneX) {
    animSc = null; // glide complete
    return;
  }
  animRaf = requestAnimationFrame(tick);
}

function center(r: DOMRect) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Returns the best element to move to, or null if none in that direction.
export function nextInDirection(dir: Direction): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  const list = rawList();
  // Nothing focused yet (e.g. first key press after a view loads): start in the
  // content area, never the sidebar. The sidebar is only entered deliberately
  // via the left-edge reveal.
  if (!active || !list.includes(active)) {
    return list.find((e) => visible(e) && !e.hasAttribute('data-sidebar')) || list.find(visible) || null;
  }

  // Thumbnails form a linear chronological sequence (data-seq). Justified rows
  // have ragged right/left edges, so pure geometry on left/right jumps to a
  // thumb in another row that happens to sit further out. For sequence items,
  // left/right instead walks DOM order — last-in-row -> first-of-next-row and
  // vice versa — which is the intended timeline traversal. Up/down stay
  // geometric so they move between rows. No layout reads on this path.
  if (active.hasAttribute('data-seq') && (dir === 'left' || dir === 'right')) {
    const step = dir === 'right' ? 1 : -1;
    const start = list.indexOf(active);
    for (let j = start + step; j >= 0 && j < list.length; j += step) {
      const el = list[j];
      if (el.hasAttribute('data-seq') && visible(el)) return el;
    }
    return null;
  }

  // Sidebar and content are separate nav zones; you only cross between them via
  // the left-edge reveal / right-edge collapse (handled in useRemote's onEdge),
  // never by geometric scoring. So:
  //  - inside the sidebar -> only sidebar items are candidates (no escaping to
  //    the grid when pressing Down past the bottom item)
  //  - inside the content -> sidebar items are excluded (Up from the top grid
  //    row must not jump onto the collapsed icon rail)
  const inSidebar = active.hasAttribute('data-sidebar');

  // Window the candidate set around the active element's DOM position. Adjacent
  // rows/columns are always nearby in DOM order, so this captures every genuine
  // candidate while bounding the number of getBoundingClientRect() reads.
  const ai = list.indexOf(active);
  const lo = Math.max(0, ai - WINDOW);
  const hi = Math.min(list.length, ai + WINDOW + 1);

  const from = active.getBoundingClientRect();
  const fc = center(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (let k = lo; k < hi; k++) {
    const el = list[k];
    if (el === active) continue;
    if (el.hasAttribute('data-sidebar') !== inSidebar) continue;
    if (!visible(el)) continue;
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
