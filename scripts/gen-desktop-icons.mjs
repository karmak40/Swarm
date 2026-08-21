// Regenerate desktop app icons (Windows .ico, macOS .icns, Linux .png) from
// the single SVG source used for the mobile icons too (assets/logo.svg).
// Run with: node scripts/gen-desktop-icons.mjs
import iconGen from 'icon-gen';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, '..', 'assets', 'logo.svg');
const dest = path.join(root, '..', 'build', 'icons');

await iconGen(src, dest, {
  report: true,
  ico: { name: 'icon' },
  icns: { name: 'icon' },
  favicon: { name: 'icon-', pngSizes: [256, 512, 1024], icoSizes: [] },
});
