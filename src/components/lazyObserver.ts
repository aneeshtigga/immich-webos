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

// 400px: start fetching a thumbnail before it scrolls into view.
export const thumbObserver = makeObserver('400px');
// 700px: load a bucket's assets while its header is still below the fold.
export const bucketObserver = makeObserver('700px');
