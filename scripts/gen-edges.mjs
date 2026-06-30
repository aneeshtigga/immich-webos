import sharp from 'sharp';

// Edge mask from the flower's own bright glass outlines: wherever the mark is
// near-white AND opaque. This traces exactly the visible edges (outer rim +
// inner petal seams), so the splash light sweep lights the edges in alignment.
const SRC = 'reference_logo/liquid_glass_flower.png';
const OUT = 'src/assets/logo-edges.png';
const S = 512;

const base = sharp(SRC).resize(S, S, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
const { data } = await base.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });

const edge = Buffer.alloc(S * S);
for (let p = 0; p < S * S; p++) {
  const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2], a = data[p * 4 + 3];
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  // bright (white glass outline) and on the flower
  edge[p] = a > 60 && lum > 200 ? 255 : 0;
}

// white RGB + edge as alpha, soft feather
const white = Buffer.alloc(S * S * 3, 255);
await sharp(white, { raw: { width: S, height: S, channels: 3 } })
  .joinChannel(edge, { raw: { width: S, height: S, channels: 1 } })
  .blur(1.2)
  .png()
  .toFile(OUT);

console.log(`wrote edge mask ${OUT}`);
