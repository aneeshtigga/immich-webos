// webOS ships a range of Chromium versions. Older sets (webOS 4.x / Chromium
// 53) predate Promise.prototype.finally (Chrome 63). Vite's `target: chrome58`
// only downlevels *syntax*, not runtime APIs, so the app boots straight into
// "TypeError: ...finally is not a function" on those TVs. Add finally back.
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
