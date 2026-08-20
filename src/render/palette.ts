/** Colour helpers. Packed 0xRRGGBB integers everywhere, stringified on demand. */

const cache = new Map<number, string>();

export function css(hex: number): string {
  let s = cache.get(hex);
  if (s === undefined) {
    s = `#${(hex & 0xffffff).toString(16).padStart(6, '0')}`;
    cache.set(hex, s);
  }
  return s;
}

const rgbaCache = new Map<string, string>();

export function rgba(hex: number, a: number): string {
  const key = `${hex}|${a.toFixed(3)}`;
  let s = rgbaCache.get(key);
  if (s === undefined) {
    const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    s = `rgba(${r},${g},${b},${a})`;
    if (rgbaCache.size < 6000) rgbaCache.set(key, s);
  }
  return s;
}

export function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export function lighten(hex: number, amount: number): number {
  return mix(hex, 0xffffff, amount);
}

export function darken(hex: number, amount: number): number {
  return mix(hex, 0x000000, amount);
}
