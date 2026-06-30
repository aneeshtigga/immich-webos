import sharp from 'sharp';

// Source brand mark: liquid-glass rainbow flower (transparent bg, 1024x1024).
const FLOWER = 'reference_logo/liquid_glass_flower.png';
const OUT = 'public';

// App icon: flower on a rounded #232329 square (matches appinfo bgColor). webOS
// spec is 80/130 but TVs are 4K and upscale a small PNG into a blurry mess, so
// ship higher-res (webOS downscales cleanly): icon 512, largeIcon 1024 (1:1
// with the 1024 source flower = no upscale, sharpest the launcher can show).
const BG = '#e5e7eb';            // --fg (near-white)
const S = 1024, R = 192;         // master canvas + corner radius (R scales with S)
const LOGO = Math.round(S * 0.92); // flower fills ~92% of the square, centered

const bgSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect width="${S}" height="${S}" rx="${R}" ry="${R}" fill="${BG}"/></svg>`,
);
const flower = await sharp(FLOWER)
  .resize(LOGO, LOGO, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer();
const icon = await sharp(bgSvg).composite([{ input: flower, gravity: 'center' }]).png().toBuffer();

// webOS icon slots are EXACT: icon 80x80, largeIcon 130x130 (home panel renders
// at 126, usable 115 w/ >=5px pad). Wrong dims fail store submission, and
// oversized PNGs make the TV's runtime scaler alias. So ship spec sizes,
// downscaled from the 1024 master with lanczos3 for the cleanest reduction.
await sharp(icon).resize(130, 130, { kernel: 'lanczos3' }).toFile(`${OUT}/largeIcon.png`);
await sharp(icon).resize(80, 80, { kernel: 'lanczos3' }).toFile(`${OUT}/icon.png`);

// Splash: full-bleed --bg (#0a0a0a), flower centered ~420px on 1920x1080.
const SPLASH_W = 1920, SPLASH_H = 1080, SPLASH_LOGO = 420;
const splashBg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SPLASH_W}" height="${SPLASH_H}"><rect width="${SPLASH_W}" height="${SPLASH_H}" fill="#0a0a0a"/></svg>`,
);
const splashFlower = await sharp(FLOWER)
  .resize(SPLASH_LOGO, SPLASH_LOGO, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer();
await sharp(splashBg).composite([{ input: splashFlower, gravity: 'center' }]).png().toFile(`${OUT}/splash.png`);

console.log('icons written: icon.png 80, largeIcon.png 130 (webOS spec), splash.png 1920x1080');
