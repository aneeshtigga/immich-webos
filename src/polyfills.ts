// webOS ships a range of Chromium versions. Older sets (webOS 4.x / Chromium
// 53, e.g. LG B8/C8) predate Promise.prototype.finally (Chrome 63). Vite's `target: chrome53`
// only downlevels *syntax*, not runtime APIs, so the app boots straight into
// "TypeError: ...finally is not a function" on those TVs. Add finally back.
// String.prototype.padStart is Chrome 57. The 2019 C9 (OLED77C9PUB) reports
// Chrome/53.0.2785.34, so formatting a video's duration badge threw a
// TypeError there and took the surrounding grid down with it.
if (typeof String !== 'undefined' && !String.prototype.padStart) {
  // eslint-disable-next-line no-extend-native
  String.prototype.padStart = function (targetLength: number, padString?: string): string {
    const s = String(this);
    const pad = padString === undefined ? ' ' : String(padString);
    if (s.length >= targetLength || pad === '') return s;
    let out = '';
    while (out.length < targetLength - s.length) out += pad;
    return out.slice(0, targetLength - s.length) + s;
  };
}

if (typeof Promise !== 'undefined' && !Promise.prototype.finally) {
  // eslint-disable-next-line no-extend-native
  Promise.prototype.finally = function <T>(this: Promise<T>, onFinally?: (() => void) | null): Promise<T> {
    const P = (this.constructor as PromiseConstructor) || Promise;
    return this.then(
      (value) => P.resolve(onFinally ? onFinally() : undefined).then(() => value),
      (reason) =>
        P.resolve(onFinally ? onFinally() : undefined).then(() => {
          throw reason;
        }),
    );
  };
}

// IntersectionObserverEntry.prototype.isIntersecting was introduced in Chrome 58.
// On webOS 4.0 - 4.4 (Chromium 53, e.g. LG B8 / C8), native IntersectionObserver is present
// but `entry.isIntersecting` is undefined. The observer callbacks check `if (inside)` which
// evaluates to falsy, completely breaking bucket loading and thumbnail loading.
if (
  typeof IntersectionObserverEntry !== 'undefined' &&
  !('isIntersecting' in IntersectionObserverEntry.prototype)
) {
  Object.defineProperty(IntersectionObserverEntry.prototype, 'isIntersecting', {
    get() {
      return (
        this.intersectionRatio > 0 ||
        Boolean(
          this.intersectionRect &&
            (this.intersectionRect.width > 0 || this.intersectionRect.height > 0),
        )
      );
    },
    configurable: true,
    enumerable: true,
  });
}
