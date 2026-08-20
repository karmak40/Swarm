import { TAU } from '../core/math';
import { css, rgba, lighten, darken } from './palette';
import type { Building } from '../game/entities';
import type { EnemyShape } from '../data/enemies';

type Ctx = CanvasRenderingContext2D;

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

export function poly(ctx: Ctx, sides: number, r: number, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TAU;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function star(ctx: Ctx, points: number, rOuter: number, rInner: number, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = rot + (i / (points * 2)) * TAU;
    const r = i % 2 === 0 ? rOuter : rInner;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Chamfered "tech panel" rect — the shared visual language for structures. */
export function techRect(ctx: Ctx, x: number, y: number, w: number, h: number, cut: number) {
  const c = Math.min(cut, w / 3, h / 3);
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

/** Jagged lightning path between two points. Deterministic per `seed`. */
export function lightning(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, seed: number, jag = 10) {
  const segs = 7;
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  let s = seed;
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    s = (s * 9301 + 49297) % 233280;
    const off = (s / 233280 - 0.5) * jag * Math.sin(t * Math.PI);
    ctx.lineTo(x0 + dx * t + nx * off, y0 + dy * t + ny * off);
  }
  ctx.lineTo(x1, y1);
}

/* -------------------------------------------------------------------------- */
/* Enemies                                                                     */
/* -------------------------------------------------------------------------- */

export interface EnemyDrawState {
  shape: EnemyShape;
  r: number;
  angle: number;
  anim: number;
  gait: number;
  color: number;
  accent: number;
  flash: number;
  elite: boolean;
  hpPct: number;
  submerged: boolean;
  casting: boolean;
}

export function drawEnemy(ctx: Ctx, s: EnemyDrawState) {
  const body = s.flash > 0 ? lighten(s.color, s.flash * 0.75) : s.color;
  const edge = s.elite ? 0xffcc55 : s.accent;

  ctx.save();
  ctx.rotate(s.angle);
  if (s.submerged) ctx.globalAlpha = 0.28;

  switch (s.shape) {
    case 'crawler': drawCrawler(ctx, s, body, edge); break;
    case 'mite': drawMite(ctx, s, body, edge); break;
    case 'brute': drawBrute(ctx, s, body, edge); break;
    case 'spitter': drawSpitter(ctx, s, body, edge); break;
    case 'moth': drawMoth(ctx, s, body, edge); break;
    case 'bomber': drawBomber(ctx, s, body, edge); break;
    case 'burrower': drawBurrower(ctx, s, body, edge); break;
    case 'shaman': drawShaman(ctx, s, body, edge); break;
    case 'blob': drawBlob(ctx, s, body, edge); break;
    case 'boss': drawBoss(ctx, s, body, edge); break;
  }

  ctx.restore();
}

function legs(ctx: Ctx, r: number, gait: number, count: number, spread: number, color: number, width: number) {
  ctx.strokeStyle = css(color);
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const bx = -r * 0.4 + t * r * 0.9;
      const by = side * r * 0.45;
      const swing = Math.sin(gait * 6 + i * 1.7 + (side > 0 ? Math.PI : 0)) * spread;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + swing * r * 0.5, by + side * r * 0.95);
      ctx.stroke();
    }
  }
}

function drawCrawler(ctx: Ctx, s: EnemyDrawState, body: number, edge: number) {
  const r = s.r;
  legs(ctx, r, s.gait, 3, 0.7, darken(body, 0.35), Math.max(1.2, r * 0.16));
  // Segmented carapace.
  for (let i = 2; i >= 0; i--) {
    const t = i / 2;
    const cx = -r * 0.35 + t * r * 0.95;
    const rr = r * (0.55 + (1 - t) * 0.35);
    ctx.fillStyle = css(i === 0 ? lighten(body, 0.12) : body);
    ctx.beginPath();
    ctx.ellipse(cx, 0, rr, rr * 0.82, 0, 0, TAU);
    ctx.fill();
  }
  // Mandibles + eye.
  ctx.strokeStyle = css(edge);
  ctx.lineWidth = Math.max(1, r * 0.14);
  const bite = Math.sin(s.anim * 9) * 0.3 + 0.4;
  ctx.beginPath();
  ctx.moveTo(r * 0.55, -r * 0.25);
  ctx.lineTo(r * 1.05, -r * 0.25 * bite);
  ctx.moveTo(r * 0.55, r * 0.25);
  ctx.lineTo(r * 1.05, r * 0.25 * bite);
  ctx.stroke();
  ctx.fillStyle = css(edge);
  ctx.beginPath();
  ctx.arc(r * 0.4, 0, r * 0.2, 0, TAU);
  ctx.fill();
}

function drawMite(ctx: Ctx, s: EnemyDrawState, body: number, edge: number) {
  const r = s.r;
  const flick = Math.sin(s.gait * 12) * 0.25;
  ctx.fillStyle = css(body);
  ctx.beginPath();
  ctx.moveTo(r * 1.1, 0);
  ctx.lineTo(-r * 0.7, -r * 0.85 + flick * r);
  ctx.lineTo(-r * 0.35, 0);
  ctx.lineTo(-r * 0.7, r * 0.85 - flick * r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = css(edge);
  ctx.beginPath();
  ctx.arc(r * 0.35, 0, r * 0.26, 0, TAU);
  ctx.fill();
}

function drawBrute(ctx: Ctx, s: EnemyDrawState, body: number, edge: number) {
  const r = s.r;
  legs(ctx, r, s.gait, 2, 0.5, darken(body, 0.45), r * 0.3);
  // Shoulder plates.
  ctx.fillStyle = css(darken(body, 0.3));
  poly(ctx, 6, r * 1.05, 0.4);
  ctx.fill();
  ctx.fillStyle = css(body);
  poly(ctx, 6, r * 0.82, 0.4);
  ctx.fill();
  // Armour ridges.
  ctx.strokeStyle = css(lighten(body, 0.28));
  ctx.lineWidth = Math.max(1.4, r * 0.1);
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, i * r * 0.4);
    ctx.lineTo(r * 0.6, i * r * 0.3);
    ctx.stroke();
  }
  // Twin eyes.
  ctx.fillStyle = css(edge);
  for (const sy of [-0.28, 0.28]) {
    ctx.beginPath();
    ctx.arc(r * 0.62, sy * r, r * 0.15, 0, TAU);
    ctx.fill();
  }
  // Hammer arms swinging with the gait.
  const swing = Math.sin(s.gait * 5) * 0.4;
  ctx.strokeStyle = css(darken(body, 0.2));
  ctx.lineWidth = r * 0.34;
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(r * 0.2, side * r * 0.7);
    ctx.lineTo(r * 0.95, side * r * (0.85 + swing * side));
    ctx.stroke();
  }
}

function drawSpitter(ctx: Ctx, s: EnemyDrawState, body: number, edge: number) {
  const r = s.r;
  legs(ctx, r, s.gait, 2, 0.6, darken(body, 0.4), r * 0.16);
  // Bulbous acid sac that pulses.
  const pulse = 1 + Math.sin(s.anim * 3.2) * 0.09;
  ctx.fillStyle = css(darken(body, 0.15));
  ctx.beginPath();
  ctx.ellipse(-r * 0.3, 0, r * 0.85 * pulse, r * 0.75 * pulse, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba(edge, 0.5);
  ctx.beginPath();
  ctx.ellipse(-r * 0.35, 0, r * 0.45 * pulse, r * 0.38 * pulse, 0, 0, TAU);
  ctx.fill();
  // Head + nozzle.
  ctx.fillStyle = css(body);
  ctx.beginPath();
  ctx.ellipse(r * 0.45, 0, r * 0.5, r * 0.42, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = css(edge);
  ctx.lineWidth = Math.max(1.4, r * 0.16);
  ctx.beginPath();
  ctx.moveTo(r * 0.8, 0);
  ctx.lineTo(r * 1.25, 0);
  ctx.stroke();
}

function drawMoth(ctx: Ctx, s: EnemyDrawState, body: number, edge: number) {
  const r = s.r;
  const flap = Math.abs(Math.sin(s.anim * 13));
  // Wings behind the body.
  ctx.fillStyle = rgba(edge, 0.32 + flap * 0.28);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-r * 0.6, side * r * (0.6 + flap * 1.5), -r * 1.5, side * r * (0.3 + flap * 0.7));
    ctx.quadraticCurveTo(-r * 0.7, side * r * 0.15, 0, 0);
    ctx.fill();
  }
  ctx.fillStyle = css(body);
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.95, r * 0.5, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = css(edge);
  ctx.beginPath();
  ctx.arc(r * 0.6, 0, r * 0.22, 0, TAU);
  ctx.fill();
  // Antennae.
  ctx.strokeStyle = rgba(edge, 0.8);
  ctx.lineWidth = Math.max(1, r * 0.1);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(r * 0.7, side * r * 0.15);
    ctx.quadraticCurveTo(r * 1.3, side * r * 0.5, r * 1.5, side * r * 0.2);
    ctx.stroke();
  }
}

function drawBomber(ctx: Ctx, s: EnemyDrawState, body: number, edge: number) {
  const r = s.r;
  const pulse = 1 + Math.sin(s.anim * 6) * 0.12;
  legs(ctx, r, s.gait, 2, 0.8, darken(body, 0.4), r * 0.14);
  ctx.fillStyle = css(body);
  ctx.beginPath();
  ctx.arc(0, 0, r * pulse, 0, TAU);
  ctx.fill();
  // Blistering gas pockets.
  ctx.fillStyle = rgba(edge, 0.55 + Math.sin(s.anim * 6) * 0.25);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + s.anim * 0.4;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45, r * 0.26 * pulse, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = rgba(0xffffff, 0.35);
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.beginPath();
  ctx.arc(0, 0, r * pulse, 0, TAU);
  ctx.stroke();
}

function drawBurrower(ctx: Ctx, s: EnemyDrawState, body: number, edge: number) {
  const r = s.r;
  // Conical drill head.
  ctx.fillStyle = css(darken(body, 0.2));
  ctx.beginPath();
  ctx.moveTo(r * 1.35, 0);
  ctx.lineTo(r * 0.1, -r * 0.8);
  ctx.lineTo(r * 0.1, r * 0.8);
  ctx.closePath();
  ctx.fill();
  // Spiral flutes.
  ctx.strokeStyle = rgba(edge, 0.8);
  ctx.lineWidth = Math.max(1, r * 0.1);
  for (let i = 0; i < 3; i++) {
    const o = (s.anim * 6 + i * 0.9) % 1;
    ctx.beginPath();
    ctx.moveTo(r * 0.1 + o * r * 1.2, -r * 0.7 * (1 - o));
    ctx.lineTo(r * 0.1 + o * r * 1.2, r * 0.7 * (1 - o));
    ctx.stroke();
  }
  // Body segments.
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = css(i % 2 ? darken(body, 0.15) : body);
    ctx.beginPath();
    ctx.ellipse(-r * 0.2 - i * r * 0.45, 0, r * 0.42, r * (0.7 - i * 0.12), 0, 0, TAU);
    ctx.fill();
  }
}

function drawShaman(ctx: Ctx, s: EnemyDrawState, body: number, edge: number) {
  const r = s.r;
  // Robe.
  ctx.fillStyle = css(body);
  ctx.beginPath();
  ctx.moveTo(r * 0.6, 0);
  ctx.quadraticCurveTo(0, -r * 1.1, -r, -r * 0.6);
  ctx.quadraticCurveTo(-r * 1.2, 0, -r, r * 0.6);
  ctx.quadraticCurveTo(0, r * 1.1, r * 0.6, 0);
  ctx.fill();
  // Orbiting focus stones.
  for (let i = 0; i < 3; i++) {
    const a = s.anim * 2.4 + (i / 3) * TAU;
    const ox = Math.cos(a) * r * 1.25;
    const oy = Math.sin(a) * r * 0.7;
    ctx.fillStyle = rgba(edge, 0.9);
    ctx.beginPath();
    ctx.arc(ox, oy, r * 0.2, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = css(edge);
  poly(ctx, 3, r * 0.36, s.anim * 1.5);
  ctx.fill();
}

function drawBlob(ctx: Ctx, s: EnemyDrawState, body: number, edge: number) {
  const r = s.r;
  ctx.fillStyle = css(body);
  ctx.beginPath();
  const lobes = 9;
  for (let i = 0; i <= lobes; i++) {
    const a = (i / lobes) * TAU;
    const wob = 1 + Math.sin(a * 3 + s.anim * 4) * 0.14 + Math.sin(a * 5 - s.anim * 3) * 0.07;
    const x = Math.cos(a) * r * wob, y = Math.sin(a) * r * wob;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = rgba(edge, 0.6);
  ctx.beginPath();
  ctx.arc(r * 0.15, 0, r * 0.42, 0, TAU);
  ctx.fill();
  ctx.fillStyle = css(0x0a0a0f);
  for (const sy of [-0.3, 0.3]) {
    ctx.beginPath();
    ctx.arc(r * 0.42, sy * r, r * 0.11, 0, TAU);
    ctx.fill();
  }
}

function drawBoss(ctx: Ctx, s: EnemyDrawState, body: number, edge: number) {
  const r = s.r;
  const breathe = 1 + Math.sin(s.anim * 1.6) * 0.03;

  // Six armoured limbs.
  ctx.strokeStyle = css(darken(body, 0.4));
  ctx.lineWidth = r * 0.2;
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? -1 : 1;
    const t = (i % 3) / 2;
    const a0 = side * (0.5 + t * 0.7);
    const swing = Math.sin(s.gait * 4 + i * 1.3) * 0.22;
    const jx = Math.cos(a0 + swing) * r * 1.1;
    const jy = Math.sin(a0 + swing) * r * 1.1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(jx * 0.6, jy * 0.6);
    ctx.lineTo(jx * 1.5, jy * 1.15);
    ctx.stroke();
  }

  // Carapace: layered hexes.
  ctx.fillStyle = css(darken(body, 0.28));
  poly(ctx, 6, r * 1.1 * breathe, 0.26);
  ctx.fill();
  ctx.fillStyle = css(body);
  poly(ctx, 6, r * 0.88 * breathe, 0.26);
  ctx.fill();
  ctx.strokeStyle = rgba(edge, 0.55);
  ctx.lineWidth = Math.max(2, r * 0.05);
  poly(ctx, 6, r * 0.88 * breathe, 0.26);
  ctx.stroke();

  // Spinal spikes.
  ctx.fillStyle = css(darken(body, 0.45));
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const px = -r * 0.9 + t * r * 1.4;
    ctx.beginPath();
    ctx.moveTo(px, -r * 0.1);
    ctx.lineTo(px - r * 0.18, -r * (0.9 + Math.sin(s.anim * 2 + i) * 0.08));
    ctx.lineTo(px + r * 0.14, -r * 0.1);
    ctx.closePath();
    ctx.fill();
  }

  // Head plate and mandibles.
  const bite = (Math.sin(s.anim * 4) * 0.5 + 0.5) * 0.35;
  ctx.fillStyle = css(lighten(body, 0.14));
  ctx.save();
  ctx.translate(r * 0.75, 0);
  poly(ctx, 5, r * 0.42, 0);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = css(darken(edge, 0.15));
  ctx.lineWidth = r * 0.12;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(r * 0.95, side * r * 0.2);
    ctx.quadraticCurveTo(r * 1.5, side * r * (0.5 - bite), r * 1.75, side * r * (0.15 + bite * 0.5));
    ctx.stroke();
  }

  // Eye cluster — brightens while casting.
  const glow = s.casting ? 1 : 0.55 + Math.sin(s.anim * 5) * 0.15;
  ctx.fillStyle = rgba(edge, glow);
  for (let i = 0; i < 4; i++) {
    const a = -0.5 + i * 0.33;
    ctx.beginPath();
    ctx.arc(r * 0.85 + Math.cos(a) * r * 0.12, Math.sin(a) * r * 0.3, r * 0.09, 0, TAU);
    ctx.fill();
  }
}

/* -------------------------------------------------------------------------- */
/* Drones                                                                      */
/* -------------------------------------------------------------------------- */

export interface DroneDrawState {
  r: number;
  angle: number;
  anim: number;
  flash: number;
  hpPct: number;
  cargoPct: number;
  working: boolean;
}

/** Small hover frame: four rotor discs, a slung cargo pod, a sensor eye. */
export function drawDrone(ctx: Ctx, s: DroneDrawState) {
  const r = s.r;
  const body = s.flash > 0 ? lighten(0x3d4c60, s.flash * 0.8) : 0x3d4c60;

  ctx.save();
  ctx.rotate(s.angle);

  // Rotor discs — blurred by drawing a translucent ring, no per-blade detail.
  const spin = s.anim * 26;
  for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
    const px = ox * r * 0.72, py = oy * r * 0.72;
    ctx.strokeStyle = rgba(0x9fd8ff, 0.28);
    ctx.lineWidth = r * 0.16;
    ctx.beginPath();
    ctx.arc(px, py, r * 0.42, spin % TAU, (spin % TAU) + 4.4);
    ctx.stroke();
    ctx.fillStyle = css(0x2a3546);
    ctx.beginPath();
    ctx.arc(px, py, r * 0.14, 0, TAU);
    ctx.fill();
  }

  // Frame arms.
  ctx.strokeStyle = css(body);
  ctx.lineWidth = r * 0.2;
  ctx.beginPath();
  ctx.moveTo(-r * 0.72, -r * 0.72); ctx.lineTo(r * 0.72, r * 0.72);
  ctx.moveTo(r * 0.72, -r * 0.72); ctx.lineTo(-r * 0.72, r * 0.72);
  ctx.stroke();

  // Hull.
  ctx.fillStyle = css(body);
  roundRect(ctx, -r * 0.46, -r * 0.36, r * 0.92, r * 0.72, r * 0.2);
  ctx.fill();
  ctx.strokeStyle = rgba(0x9fe8ff, 0.55);
  ctx.lineWidth = 1;
  ctx.stroke();

  // Cargo pod, filling up as it mines.
  if (s.cargoPct > 0.02) {
    ctx.fillStyle = rgba(0x7fd9ff, 0.35 + s.cargoPct * 0.5);
    const h = r * 0.34 * s.cargoPct;
    ctx.fillRect(-r * 0.3, r * 0.16 - h * 0.5, r * 0.6, h);
  }

  // Forward sensor.
  ctx.fillStyle = rgba(s.working ? 0xffe08a : 0x9fe8ff, 0.9);
  ctx.beginPath();
  ctx.arc(r * 0.4, 0, r * 0.13, 0, TAU);
  ctx.fill();

  ctx.restore();
}

/* -------------------------------------------------------------------------- */
/* Buildings                                                                   */
/* -------------------------------------------------------------------------- */

export function drawBuilding(ctx: Ctx, b: Building, accent: number, time: number) {
  const size = b.size * 32;
  const half = size / 2;
  const shell = b.hitFlash > 0 ? lighten(0x2a3242, b.hitFlash * 0.6) : 0x2a3242;

  ctx.save();
  ctx.translate(b.x, b.y);

  // Under-construction ghost.
  if (!b.built) {
    ctx.globalAlpha = 0.35 + b.progress * 0.4;
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = rgba(accent, 0.9);
    ctx.lineWidth = 2;
    techRect(ctx, -half, -half, size, size, 7);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = rgba(accent, 0.14);
    ctx.fillRect(-half, half - size * b.progress, size, size * b.progress);
    ctx.restore();
    return;
  }

  // Base pad.
  ctx.fillStyle = css(0x161c28);
  techRect(ctx, -half, -half, size, size, 7);
  ctx.fill();
  ctx.fillStyle = css(shell);
  techRect(ctx, -half + 2.5, -half + 2.5, size - 5, size - 5, 6);
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.28);
  ctx.lineWidth = 1;
  ctx.stroke();

  // Corner rivets.
  ctx.fillStyle = css(0x0e1420);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(sx * (half - 5), sy * (half - 5), 1.7, 0, TAU);
    ctx.fill();
  }

  switch (b.kind) {
    case 'wall': drawWall(ctx, half, accent); break;
    case 'generator': drawGenerator(ctx, half, b, time); break;
    case 'extractor': drawExtractor(ctx, half, b, time, accent); break;
    case 'dronebay': drawDroneBay(ctx, half, b, time, accent); break;
    case 'repairbay': drawRepairBay(ctx, half, time); break;
    case 'shield': drawShieldPylon(ctx, half, time); break;
    default: drawTurretBody(ctx, b, half, accent); break;
  }

  // Damage state: cracks and smoke sockets.
  if (b.pct < 0.6) {
    ctx.strokeStyle = rgba(0x000000, 0.5);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-half * 0.6, -half * 0.3);
    ctx.lineTo(-half * 0.1, half * 0.1);
    ctx.lineTo(half * 0.4, -half * 0.2);
    ctx.stroke();
  }

  // Health pip.
  if (b.pct < 1) {
    const w = size * 0.8;
    ctx.fillStyle = rgba(0x000000, 0.55);
    ctx.fillRect(-w / 2, half + 3, w, 3);
    ctx.fillStyle = css(b.pct > 0.5 ? 0x5cf2a0 : b.pct > 0.25 ? 0xffb347 : 0xff4f5e);
    ctx.fillRect(-w / 2, half + 3, w * b.pct, 3);
  }

  ctx.restore();
}

function drawWall(ctx: Ctx, half: number, accent: number) {
  ctx.fillStyle = css(0x3a4456);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const w = half * 0.82;
      ctx.fillRect(-half + 3 + i * w, -half + 3 + j * w, w - 2.5, w - 2.5);
    }
  }
  ctx.strokeStyle = rgba(accent, 0.16);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-half + 3, 0); ctx.lineTo(half - 3, 0);
  ctx.moveTo(0, -half + 3); ctx.lineTo(0, half - 3);
  ctx.stroke();
}

function drawGenerator(ctx: Ctx, half: number, b: Building, time: number) {
  const pulse = 0.55 + Math.sin(time * 3 + b.phase) * 0.25;
  ctx.fillStyle = css(0x0c1018);
  poly(ctx, 6, half * 0.72, Math.PI / 6);
  ctx.fill();
  ctx.fillStyle = rgba(0x46d8ff, pulse);
  poly(ctx, 6, half * 0.5, Math.PI / 6);
  ctx.fill();
  ctx.strokeStyle = rgba(0x9fe8ff, 0.8);
  ctx.lineWidth = 1.6;
  poly(ctx, 6, half * 0.72, Math.PI / 6);
  ctx.stroke();
  // Rotating containment ring.
  ctx.save();
  ctx.rotate(time * 1.2 + b.phase);
  ctx.strokeStyle = rgba(0x46d8ff, 0.55);
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(0, 0, half * 0.62, (i / 3) * TAU, (i / 3) * TAU + 1.1);
    ctx.stroke();
  }
  ctx.restore();
}

function drawExtractor(ctx: Ctx, half: number, b: Building, time: number, accent: number) {
  ctx.fillStyle = css(0x1d2534);
  roundRect(ctx, -half * 0.7, -half * 0.7, half * 1.4, half * 1.4, 4);
  ctx.fill();
  // Reciprocating drill head.
  const bob = Math.sin(time * 6 + b.phase) * half * 0.14;
  ctx.fillStyle = css(0x5a6779);
  ctx.beginPath();
  ctx.moveTo(-half * 0.24, -half * 0.2 + bob);
  ctx.lineTo(half * 0.24, -half * 0.2 + bob);
  ctx.lineTo(0, half * 0.62 + bob);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.7);
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // Ore conduit.
  ctx.fillStyle = rgba(0x7fd9ff, 0.5 + Math.sin(time * 8 + b.phase) * 0.3);
  ctx.fillRect(-half * 0.68, -half * 0.62, half * 0.2, half * 1.24);
}

/**
 * A landing pad with one lit berth per drone slot, plus a beacon that flashes
 * when a drone unloads. The berths read as occupied/empty at a glance, which is
 * how the player sees losses without reading a number.
 */
function drawDroneBay(ctx: Ctx, half: number, b: Building, time: number, accent: number) {
  const slots = Math.round(b.def.droneSlots ?? 3);

  // Pad.
  ctx.fillStyle = css(0x18202e);
  roundRect(ctx, -half * 0.82, -half * 0.82, half * 1.64, half * 1.64, 6);
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.32);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Hazard chevrons along the near edge.
  ctx.fillStyle = rgba(0xffb347, 0.5);
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(-half * 0.7 + i * half * 0.4, half * 0.62, half * 0.2, half * 0.1);
  }

  // Berths, arranged on an arc so up to four stay legible.
  for (let i = 0; i < slots; i++) {
    const a = -Math.PI / 2 + ((i + 0.5) / slots - 0.5) * 2.2;
    const bx = Math.cos(a) * half * 0.42;
    const by = Math.sin(a) * half * 0.42 + half * 0.06;
    // Occupancy is not tracked per berth; the pulse simply shows the bay is live.
    const lit = 0.35 + Math.sin(time * 2.2 + b.phase + i) * 0.2;
    ctx.strokeStyle = rgba(0x7fd9ff, lit);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(bx, by, half * 0.19, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = rgba(0x7fd9ff, lit * 0.4);
    ctx.fill();
  }

  // Unload beacon.
  const flash = b.depositFlash;
  ctx.fillStyle = rgba(flash > 0 ? 0xffe08a : 0x46d8ff, 0.5 + flash * 0.5);
  ctx.beginPath();
  ctx.arc(0, -half * 0.62, half * 0.13 + flash * half * 0.08, 0, TAU);
  ctx.fill();
}

function drawRepairBay(ctx: Ctx, half: number, time: number) {
  ctx.fillStyle = css(0x14261e);
  roundRect(ctx, -half * 0.75, -half * 0.75, half * 1.5, half * 1.5, 5);
  ctx.fill();
  ctx.fillStyle = rgba(0x5cf2a0, 0.75);
  const t = half * 0.22;
  ctx.fillRect(-t / 2, -half * 0.6, t, half * 1.2);
  ctx.fillRect(-half * 0.6, -t / 2, half * 1.2, t);
  ctx.strokeStyle = rgba(0x5cf2a0, 0.35 + Math.sin(time * 4) * 0.2);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, half * 0.85, 0, TAU);
  ctx.stroke();
}

function drawShieldPylon(ctx: Ctx, half: number, time: number) {
  ctx.fillStyle = css(0x101a2c);
  poly(ctx, 4, half * 0.7, Math.PI / 4);
  ctx.fill();
  ctx.save();
  ctx.rotate(time * 0.8);
  ctx.strokeStyle = rgba(0x9fd8ff, 0.85);
  ctx.lineWidth = 2;
  poly(ctx, 3, half * 0.55, 0);
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.rotate(-time * 1.1);
  ctx.strokeStyle = rgba(0x46d8ff, 0.6);
  ctx.lineWidth = 1.5;
  poly(ctx, 3, half * 0.75, Math.PI / 3);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = rgba(0xffffff, 0.6 + Math.sin(time * 5) * 0.3);
  ctx.beginPath();
  ctx.arc(0, 0, half * 0.16, 0, TAU);
  ctx.fill();
}

function drawTurretBody(ctx: Ctx, b: Building, half: number, accent: number) {
  const def = b.def;
  // Traverse ring.
  ctx.strokeStyle = rgba(accent, 0.3);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, half * 0.78, 0, TAU);
  ctx.stroke();

  ctx.save();
  ctx.rotate(b.angle);
  const recoil = -b.recoil * half * 0.16;

  // Missile racks and beam emitters have their own silhouettes.
  if (def.id === 'rocket') { drawMissileRack(ctx, b, half, recoil, accent); ctx.restore(); drawTargetingPip(ctx, b, half); return; }
  if (def.id === 'pulselaser') { drawPulseEmitter(ctx, b, half, recoil); ctx.restore(); drawTargetingPip(ctx, b, half); return; }

  // Barrel(s).
  const barrelLen = half * (def.id === 'mortar' ? 0.85 : def.id === 'laser' ? 1.3 : 1.15);
  const barrelW = half * (def.id === 'cannon' || def.id === 'mortar' ? 0.34 : def.id === 'laser' ? 0.2 : 0.24);
  ctx.fillStyle = css(0x4a5566);
  if (def.id === 'flak') {
    for (const sy of [-1, 1]) {
      ctx.fillRect(recoil, sy * half * 0.2 - barrelW / 2, barrelLen, barrelW * 0.8);
    }
  } else {
    ctx.fillRect(recoil, -barrelW / 2, barrelLen, barrelW);
  }
  ctx.fillStyle = css(0x6b7a8f);
  ctx.fillRect(recoil, -barrelW / 2, barrelLen * 0.25, barrelW);

  if (def.id === 'mortar') {
    // Angled tube reads as indirect fire.
    ctx.fillStyle = css(0x3a4454);
    ctx.beginPath();
    ctx.moveTo(recoil, -barrelW * 0.8);
    ctx.lineTo(barrelLen * 0.9, -barrelW * 0.4);
    ctx.lineTo(barrelLen * 0.9, barrelW * 0.4);
    ctx.lineTo(recoil, barrelW * 0.8);
    ctx.closePath();
    ctx.fill();
  }

  // Housing.
  ctx.fillStyle = css(0x333d4d);
  roundRect(ctx, -half * 0.5, -half * 0.42, half * 0.95, half * 0.84, 4);
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.5);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Emitter / muzzle glow. Multi-barrel guns flash at each barrel tip rather
  // than as one blob in the gap between them.
  if (b.muzzleFlash > 0) {
    const flare = def.muzzleFlare ?? 1;
    ctx.fillStyle = rgba(0xfff2c0, b.muzzleFlash * Math.min(1, 0.35 + flare * 0.65));
    if (def.id === 'flak') {
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(barrelLen + recoil, sy * half * 0.2, half * 0.3 * flare * b.muzzleFlash, 0, TAU);
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.arc(barrelLen + recoil, 0, half * 0.3 * flare * b.muzzleFlash, 0, TAU);
      ctx.fill();
    }
  }
  if (def.id === 'tesla') {
    ctx.fillStyle = rgba(0x9fd8ff, 0.8);
    ctx.beginPath();
    ctx.arc(half * 0.5, 0, half * 0.16, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  drawTargetingPip(ctx, b, half);
}

function drawTargetingPip(ctx: Ctx, b: Building, half: number) {
  const pip = { first: 0x46d8ff, closest: 0x5cf2a0, strongest: 0xff4f5e, weakest: 0xffb347 }[b.targeting];
  ctx.fillStyle = css(pip);
  ctx.beginPath();
  ctx.arc(-half + 6, half - 6, 2.2, 0, TAU);
  ctx.fill();
}

/**
 * Missile Battery: a boxed rack of four tubes on a pivot. Tubes darken as they
 * are spent and refill over the reload, so the turret's cadence is readable from
 * across the map without reading a number.
 */
function drawMissileRack(ctx: Ctx, b: Building, half: number, recoil: number, accent: number) {
  const reload = 1 - Math.min(1, Math.max(0, b.cooldown) / Math.max(0.001, 1 / (b.def.fireRate ?? 1)));

  // Elevated launch box.
  ctx.fillStyle = css(0x2b3446);
  techRect(ctx, -half * 0.42 + recoil, -half * 0.62, half * 1.25, half * 1.24, 5);
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.45);
  ctx.lineWidth = 1.3;
  ctx.stroke();

  // Four tubes, 2×2.
  const tw = half * 0.44;
  const th = half * 0.46;
  for (let i = 0; i < 4; i++) {
    const col = i % 2, row = (i / 2) | 0;
    const tx = -half * 0.3 + recoil + col * (tw + half * 0.08);
    const ty = -half * 0.5 + row * (th + half * 0.1);
    ctx.fillStyle = css(0x121926);
    roundRect(ctx, tx, ty, tw, th, 2.5);
    ctx.fill();
    // Loaded warhead nose peeking out of the tube.
    const loaded = reload > i / 4;
    ctx.fillStyle = loaded ? css(0xff8a5c) : rgba(0x000000, 0.5);
    roundRect(ctx, tx + tw * 0.62, ty + th * 0.2, tw * 0.34, th * 0.6, 2);
    ctx.fill();
  }

  // Guidance dish on the near side.
  ctx.fillStyle = css(0x4a5566);
  ctx.beginPath();
  ctx.arc(-half * 0.5 + recoil, 0, half * 0.2, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = rgba(0x9fe8ff, 0.7);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(-half * 0.5 + recoil, 0, half * 0.2, -1, 1);
  ctx.stroke();

  if (b.muzzleFlash > 0) {
    ctx.fillStyle = rgba(0xffd0a0, b.muzzleFlash);
    ctx.beginPath();
    ctx.arc(half * 0.9 + recoil, 0, half * 0.36 * b.muzzleFlash, 0, TAU);
    ctx.fill();
  }
}

/**
 * Pulse Laser: slim gimbal with a stack of focusing rings and a lens that
 * brightens with the beam. Deliberately spindly next to the boxy Lance.
 */
function drawPulseEmitter(ctx: Ctx, b: Building, half: number, recoil: number) {
  const heat = b.beamIntensity;
  const col = b.def.beamColor ?? 0x7dffd0;

  // Yoke.
  ctx.fillStyle = css(0x2e3a4a);
  roundRect(ctx, -half * 0.46, -half * 0.34, half * 0.7, half * 0.68, 4);
  ctx.fill();

  // Emitter tube.
  ctx.fillStyle = css(0x46556a);
  ctx.fillRect(recoil + half * 0.1, -half * 0.13, half * 1.05, half * 0.26);

  // Focusing rings, spaced along the tube.
  for (let i = 0; i < 3; i++) {
    const rx = recoil + half * (0.28 + i * 0.3);
    ctx.fillStyle = css(0x6b7a8f);
    ctx.fillRect(rx, -half * 0.26, half * 0.09, half * 0.52);
    ctx.fillStyle = rgba(col, 0.35 + heat * 0.55);
    ctx.fillRect(rx, -half * 0.26, half * 0.09, half * 0.1);
  }

  // Lens.
  ctx.fillStyle = rgba(col, 0.5 + heat * 0.5);
  ctx.beginPath();
  ctx.arc(recoil + half * 1.16, 0, half * 0.17 + heat * half * 0.06, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba(0xffffff, 0.35 + heat * 0.6);
  ctx.beginPath();
  ctx.arc(recoil + half * 1.16, 0, half * 0.08, 0, TAU);
  ctx.fill();

  // Charge coil at the base pulses even when idle.
  ctx.fillStyle = rgba(col, 0.3 + heat * 0.5);
  ctx.beginPath();
  ctx.arc(-half * 0.14, 0, half * 0.16, 0, TAU);
  ctx.fill();
}
