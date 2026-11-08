// Genera todos los iconos de la app a partir de un único dibujo (flecha con volumen sobre azul).
//   node tools/icons.mjs            → icon.svg, icons/*.png (web e iPhone) y assets/*.png (Android)
//   npx capacitor-assets generate --android   → después, para los recursos nativos de Android
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLUE = '#2563eb', LIGHT = '#dbeafe', DARK = '#0f172a';

// Flecha en un lienzo de 512; `s` la escala alrededor del centro (zonas seguras de Android).
const arrow = (s = 1) => `<g transform="translate(256 256) scale(${s}) translate(-256 -256)">
  <path d="M256 100 370 400 256 334 142 400z" fill="#fff" stroke="#fff" stroke-width="18" stroke-linejoin="round"/>
  <path d="M256 100 256 334 142 400z" fill="${LIGHT}"/>
</g>`;
const svg = (body, bg = BLUE, rx = 0) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
${bg ? `<rect width="512" height="512" rx="${rx}" fill="${bg}"/>` : ''}
${body}
</svg>`;

const png = (src, size, file) => sharp(Buffer.from(src), { density: Math.ceil((72 * size) / 512) })
  .resize(size, size).png().toFile(join(ROOT, file));

// Favicon y logo: con esquinas redondeadas.
writeFileSync(join(ROOT, 'icon.svg'), svg(arrow(), BLUE, 112) + '\n');

// iOS y Android recortan ellos mismos las esquinas: el PNG va a sangre.
await png(svg(arrow()), 180, 'icons/icon-180.png');
await png(svg(arrow()), 192, 'icons/icon-192.png');
await png(svg(arrow()), 512, 'icons/icon-512.png');
// Maskable: el sistema puede recortarlo en círculo, así que la flecha va dentro del 80 % central.
await png(svg(arrow(0.82)), 512, 'icons/icon-maskable-512.png');

// Capacitor (Android): icono completo, primer plano adaptable (zona segura del 66 %) y fondo.
await png(svg(arrow()), 1024, 'assets/icon-only.png');
await png(svg(arrow(0.62), null), 1024, 'assets/icon-foreground.png');
await png(svg('', BLUE), 1024, 'assets/icon-background.png');
await png(svg(`<rect x="176" y="176" width="160" height="160" rx="36" fill="${BLUE}"/><g transform="translate(176 176) scale(0.3125)">${arrow()}</g>`, DARK), 1024, 'assets/splash.png');
console.log('Iconos generados');
