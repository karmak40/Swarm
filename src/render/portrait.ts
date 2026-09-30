import type { EnemyDef } from '../data/enemies';
import { drawCentipedeBody, drawEnemy } from './shapes';

/**
 * A still portrait of a hive type for DOM screens (new-enemy card, bestiary),
 * drawn with the same shape code as the game so it always matches.
 * `silhouette`: an unseen type in the bestiary — a flat dark shape only.
 */
export function enemyPortrait(def: EnemyDef, size: number, silhouette = false): HTMLCanvasElement {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.round(size * dpr);
  c.height = Math.round(size * dpr);
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  ctx.scale(dpr, dpr);

  const long = def.shape === 'centipede';
  const spider = def.shape === 'spider';
  // Fit the silhouette: legs and bodies reach past the collision radius.
  const reach = long ? 2.6 : spider ? 1.9 : def.boss ? 1.4 : 1.35;
  const r = (size * 0.5) / reach;
  const color = silhouette ? 0x111722 : def.color;
  const accent = silhouette ? 0x1a2230 : def.accent;

  ctx.save();
  ctx.translate(size / 2 + (long ? size * 0.22 : 0), size / 2);
  if (long) {
    // A short straight body trailing to the left of the head.
    const trail: number[] = [];
    for (let i = 0; i < 6; i++) trail.push(-i * r * 0.95, Math.sin(i * 0.9) * r * 0.25);
    drawCentipedeBody(ctx, trail, r, color, accent, 0.4, 0);
  }
  drawEnemy(ctx, {
    shape: def.shape, r, angle: 0, anim: 0.6, gait: 0.35,
    color, accent, flash: 0, elite: false, hpPct: 1, submerged: false, casting: false,
  });
  ctx.restore();
  return c;
}
