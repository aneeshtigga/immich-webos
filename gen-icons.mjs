import sharp from 'sharp';

// Immich flower mark paths (from design/immich-logo.svg, viewBox 0 0 792 792)
const PETALS = [
  ['#FA2921','M375.48,267.63c38.64,34.21,69.78,70.87,89.82,105.42c34.42-61.56,57.42-134.71,57.71-181.3c0-0.33,0-0.63,0-0.91c0-68.94-68.77-95.77-128.01-95.77s-128.01,26.83-128.01,95.77c0,0.94,0,2.2,0,3.72C300.01,209.24,339.15,235.47,375.48,267.63z'],
  ['#ED79B5','M164.7,455.63c24.15-26.87,61.2-55.99,103.01-80.61c44.48-26.18,88.97-44.47,128.02-52.84c-47.91-51.76-110.37-96.24-154.6-110.91c-0.31-0.1-0.6-0.19-0.86-0.28c-65.57-21.3-112.34,35.81-130.64,92.15c-18.3,56.34-14.04,130.04,51.53,151.34C162.05,454.77,163.25,455.16,164.7,455.63z'],
  ['#FFB400','M681.07,302.19c-18.3-56.34-65.07-113.45-130.64-92.15c-0.9,0.29-2.1,0.68-3.54,1.15c-3.75,35.93-16.6,81.27-35.96,125.76c-20.59,47.32-45.84,88.27-72.51,118c69.18,13.72,145.86,12.98,190.26-1.14c0.31-0.1,0.6-0.2,0.86-0.28C695.11,432.22,699.37,358.52,681.07,302.19z'],
  ['#1E83F7','M336.54,510.71c-11.15-50.39-14.8-98.36-10.7-138.08c-64.03,29.57-125.63,75.23-153.26,112.76c-0.19,0.26-0.37,0.51-0.53,0.73c-40.52,55.78-0.66,117.91,47.27,152.72c47.92,34.82,119.33,53.54,159.86-2.24c0.56-0.76,1.3-1.78,2.19-3.01C363.28,602.32,347.02,558.08,336.54,510.71z'],
  ['#18C249','M617.57,482.52c-35.33,7.54-82.42,9.33-130.72,4.66c-51.37-4.96-98.11-16.32-134.63-32.5c8.33,70.03,32.73,142.73,59.88,180.6c0.19,0.26,0.37,0.51,0.53,0.73c40.52,55.78,111.93,37.06,159.86,2.24c47.92-34.82,87.79-96.95,47.27-152.72C619.2,484.77,618.46,483.75,617.57,482.52z'],
];

// canvas 512, rounded-square bg #232329, logo centered
const BG = '#232329';
const S = 512, R = 96; // corner radius
// logo native 792; scale to 384px (75% of canvas), center
const LOGO = 384;
const scale = LOGO / 792;
const tx = (S - LOGO) / 2, ty = (S - LOGO) / 2;
const petalSvg = PETALS.map(([f,d]) => `<path fill="${f}" d="${d}"/>`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
<rect width="${S}" height="${S}" rx="${R}" ry="${R}" fill="${BG}"/>
<g transform="translate(${tx},${ty}) scale(${scale})">${petalSvg}</g>
</svg>`;

const buf = Buffer.from(svg);
const out = 'C:/Users/anees/Desktop/Ideas/immich-webos/public';
// webOS spec is 80/130, but TVs are 4K and upscale a small PNG into a blurry
// mess. Ship higher-res (webOS downscales cleanly): icon 256, largeIcon 512.
await sharp(buf).resize(256, 256).png().toFile(`${out}/icon.png`);
await sharp(buf).resize(512, 512).png().toFile(`${out}/largeIcon.png`);
// splash background full-bleed bg color, logo centered ~360px on 1920x1080
const splashLogoScale = 360/792, slx=(1920-360)/2, sly=(1080-360)/2;
const splashSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#0a0a0a"/><g transform="translate(${slx},${sly}) scale(${splashLogoScale})">${petalSvg}</g></svg>`;
await sharp(Buffer.from(splashSvg)).png().toFile(`${out}/splash.png`);
console.log('icons written: icon.png 256, largeIcon.png 512, splash.png 1920x1080');
