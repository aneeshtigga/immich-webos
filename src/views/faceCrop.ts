import { getAssetFaces, FaceBox } from '../api/client';

// --- face-aware cover crop ---
// object-fit:cover crops the axis that overflows the container; object-position
// picks WHICH slice survives. Solve for the position that puts the center of
// the detected faces at the focal point (horizontal center, and 38% from the
// top — roughly the rule-of-thirds eye line), clamped to 0..100% so the image
// always still fills the container. Returns null for "keep the default center
// crop" (no faces, no overflow, or the math lands on center anyway).
export const FACE_FOCUS_Y = 0.38;

// Given the natural image size, the container size, and the detected faces,
// return the CSS object-position that aims faces at the focal point (or null
// for the default center crop). Container defaults to the full viewport.
export function faceObjectPosition(
  w: number,
  h: number,
  faces: FaceBox[],
  cw = window.innerWidth || 1280,
  ch = window.innerHeight || 720,
): string | null {
  if (!faces.length || !w || !h) return null;
  // ignore small background faces (crowds, passers-by): keep only faces at
  // least 30% of the area of the largest one, then take the union box
  const area = (f: FaceBox) => Math.max(0, f.x2 - f.x1) * Math.max(0, f.y2 - f.y1);
  const biggest = Math.max(...faces.map(area));
  const kept = faces.filter((f) => area(f) >= biggest * 0.3);
  if (!kept.length) return null;
  const cx = (Math.min(...kept.map((f) => f.x1)) + Math.max(...kept.map((f) => f.x2))) / 2;
  const cy = (Math.min(...kept.map((f) => f.y1)) + Math.max(...kept.map((f) => f.y2))) / 2;
  const scale = Math.max(cw / w, ch / h);
  const dw = w * scale; // image size once cover-scaled
  const dh = h * scale;
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  let px = 50;
  let py = 50;
  // object-position P%: image offset = (container - scaled) * P/100. Solving
  // "face center lands on the focal point" for P gives the expressions below;
  // clamping keeps the crop window inside the image (never a gap).
  if (dw - cw > 1) px = clamp(((cx * dw - cw * 0.5) / (dw - cw)) * 100);
  if (dh - ch > 1) py = clamp(((cy * dh - ch * FACE_FOCUS_Y) / (dh - ch)) * 100);
  if (Math.abs(px - 50) < 0.5 && Math.abs(py - 50) < 0.5) return null;
  return `${px.toFixed(2)}% ${py.toFixed(2)}%`;
}

// Fetch the asset's detected faces and aim the <img>'s cover crop at them.
// No-op (default center crop) when there are none. Container size defaults to
// the element's own client box, falling back to the viewport.
export async function aimAtFaces(el: HTMLImageElement, id: string): Promise<void> {
  const src = el.getAttribute('src'); // guard: layers are reused across previews
  const faces = await getAssetFaces(id); // never throws; [] on failure
  if (el.getAttribute('src') !== src) return; // element moved on — a newer load owns it
  const cw = el.clientWidth || undefined;
  const ch = el.clientHeight || undefined;
  const pos = faceObjectPosition(el.naturalWidth, el.naturalHeight, faces, cw, ch);
  // always assign — reused <img> layers (hero carousel) must reset to center
  // when the next preview has no face crop, not keep the prior one's position
  el.style.objectPosition = pos ?? '50% 50%';
}
