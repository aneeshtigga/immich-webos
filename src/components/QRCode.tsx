import { useMemo } from 'preact/hooks';
import qrcode from 'qrcode-generator';

// Renders a QR code as a crisp SVG (no canvas — scales to any TV resolution and
// needs no 2D context). Uses qrcode-generator: tiny, dependency-free, and ES5,
// so it runs on the old webOS Chromium without polyfills.
//
// Size is controlled by CSS on .qr (width/height in vmin) so it scales with the
// viewport; the optional `size` prop is just a fallback when no CSS sizes it.
export function QRCode({ value, size }: { value: string; size?: number }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M'); // type 0 = auto-fit version, medium error correction
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
      }
    }
    return { d, n };
  }, [value]);

  return (
    <svg
      class="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${path.n} ${path.n}`}
      preserveAspectRatio="xMidYMid meet"
      shape-rendering="crispEdges"
    >
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}
