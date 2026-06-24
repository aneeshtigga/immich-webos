// Shared IntersectionObserver pools. Previously every Thumb and BucketSection
// created its own IntersectionObserver; with a few screens of grid that's
// hundreds of live observers, each recomputing intersections on scroll — a
// real source of scroll jank on the TV's browser. Instead we keep ONE observer
// per rootMargin and route callbacks through a WeakMap keyed by element.

type Cb = () => void;

function makeObserver(rootMargin: string) {
  const cbs = new WeakMap<Element, Cb>();
  let io: IntersectionObserver | null = null;

  const get = (): IntersectionObserver => {
    if (!io) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              const cb = cbs.get(e.target);
              if (cb) cb();
            }
          }
        },
        { rootMargin },
      );
    }
    return io;
  };

  return {
    observe(el: Element, cb: Cb): void {
      cbs.set(el, cb);
      get().observe(el);
    },
    unobserve(el: Element): void {
      cbs.delete(el);
      io?.unobserve(el);
    },
  };
}

// Prefetch window, sized in viewport heights ("pages") so it tracks the screen.
// We keep roughly two pages above AND below the viewport loaded so scrolling
// back and forth never waits on a refetch (the thumbnails stay mounted and in
// the media LRU cache). rootMargin expands the root box in every direction, so
// `2 pages` means thumbnails within ~2 pages of the viewport in either
// direction start loading.
const PAGE = (typeof window !== 'undefined' && window.innerHeight) || 720;

// ~2 pages: fetch a thumbnail well before it scrolls into view.
export const thumbObserver = makeObserver(`${PAGE * 2}px`);
// A bit further out than the thumbnails, so a bucket's assets have loaded by
// the time its thumbnails enter the prefetch window (thumbs can't exist until
// their bucket's asset list arrives).
export const bucketObserver = makeObserver(`${PAGE * 2 + 300}px`);
