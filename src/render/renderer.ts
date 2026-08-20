import { TAU, clamp, lerp } from '../core/math';
import { PKind } from '../engine/particles';
import { Tile, TILE } from '../game/world';
import type { Game } from '../game/game';
import { BUILDINGS } from '../data/buildings';
import { css, rgba, lighten, darken, mix } from './palette';
import { QUALITY, readSafeAreaInsets, type Quality, type QualityProfile, type SafeInsets } from '../core/platform';
import { drawBuilding, drawDrone, drawEnemy, lightning, poly, star, techRect } from './shapes';

/**
 * Layered Canvas2D renderer.
 *
 *   world layer  → terrain, structures, agents, particles
 *   glow layer   → the emissive subset, drawn at 1/3 scale then blurred back
 *                  over the world with `lighter` for a cheap but convincing bloom
 *   post         → vignette, damage flash, core-distress tint, scanlines
 *
 * Only tiles inside the camera frustum are touched, so map size is free.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private glow: HTMLCanvasElement;
  private gctx: CanvasRenderingContext2D;
  private glowScale = 0.34;
  private supportsFilter: boolean;
  /** Active quality profile. Drives dpr, bloom cost and overlay work. */
  private profile: QualityProfile = QUALITY.high;

  width = 0;
  height = 0;
  dpr = 1;
  /** Notch/Dynamic Island/home-indicator clearance, in CSS px. Refreshed on resize. */
  insets: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas2D unavailable');
    this.ctx = ctx;

    this.glow = document.createElement('canvas');
    const g = this.glow.getContext('2d', { alpha: true });
    if (!g) throw new Error('Canvas2D unavailable');
    this.gctx = g;

    // `filter` on 2D contexts is what makes the bloom cheap; degrade if absent.
    this.supportsFilter = 'filter' in ctx;
    this.resize();
  }

  /** Applies a quality tier. Cheap to call; re-allocates the glow buffer. */
  setQuality(q: Quality) {
    this.profile = QUALITY[q];
    this.glowScale = this.profile.glowScale;
    this.resize();
  }

  get quality() { return this.profile; }

  resize() {
    this.dpr = Math.min(this.profile.maxDpr, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    // Some mobile browsers briefly report a 0×0 viewport mid-rotation or while
    // backgrounded. Applying that would strand the canvas — and every touch
    // hit-test, which reads its bounding rect — at zero size until another
    // resize event happened to come along to fix it. Keep the last good size.
    if (w <= 0 || h <= 0) return;
    this.width = w;
    this.height = h;
    this.insets = readSafeAreaInsets();
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.glow.width = Math.max(1, Math.floor(w * this.glowScale));
    this.glow.height = Math.max(1, Math.floor(h * this.glowScale));
  }

  /* ---------------------------------------------------------------------- */

  render(game: Game, bloomEnabled: boolean) {
    const ctx = this.ctx;
    const gctx = this.gctx;
    const cam = game.camera;
    const pal = game.level.palette;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    this.drawSky(ctx, game);

    // View transform, shared by both layers.
    const camX = cam.x + cam.shakeX;
    const camY = cam.y + cam.shakeY;
    const ox = this.width / 2 - camX * cam.zoom;
    const oy = this.height / 2 - camY * cam.zoom;

    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.clearRect(0, 0, this.glow.width, this.glow.height);
    const gs = this.glowScale;
    gctx.setTransform(cam.zoom * gs, 0, 0, cam.zoom * gs, ox * gs, oy * gs);
    gctx.globalCompositeOperation = 'lighter';

    ctx.save();
    ctx.setTransform(this.dpr * cam.zoom, 0, 0, this.dpr * cam.zoom, ox * this.dpr, oy * this.dpr);

    const view = this.frustum(game);

    this.drawTerrain(ctx, game, view);
    this.drawOre(ctx, gctx, game, view);
    this.drawGates(ctx, gctx, game);
    this.drawPlacementGhost(ctx, game);
    this.drawRangeRings(ctx, game);
    this.drawParticles(ctx, gctx, game, false);
    this.drawBuildings(ctx, gctx, game, view);
    this.drawCore(ctx, gctx, game);
    this.drawPickups(ctx, gctx, game);
    this.drawEnemies(ctx, gctx, game, view);
    this.drawDrones(ctx, gctx, game, view);
    this.drawPlayer(ctx, gctx, game);
    this.drawProjectiles(ctx, gctx, game);
    this.drawEffects(ctx, gctx, game);
    this.drawParticles(ctx, gctx, game, true);
    this.drawDamageNumbers(ctx, game);

    ctx.restore();

    if (bloomEnabled && this.profile.bloomPasses > 0) this.compositeGlow(ctx);

    this.drawPost(ctx, game, pal);
    ctx.restore();
  }

  private frustum(game: Game) {
    const cam = game.camera;
    const halfW = this.width / (2 * cam.zoom) + TILE * 2;
    const halfH = this.height / (2 * cam.zoom) + TILE * 2;
    return {
      x0: cam.x - halfW, x1: cam.x + halfW,
      y0: cam.y - halfH, y1: cam.y + halfH,
      tx0: Math.max(0, Math.floor((cam.x - halfW) / TILE)),
      tx1: Math.min(game.world.w - 1, Math.ceil((cam.x + halfW) / TILE)),
      ty0: Math.max(0, Math.floor((cam.y - halfH) / TILE)),
      ty1: Math.min(game.world.h - 1, Math.ceil((cam.y + halfH) / TILE)),
    };
  }

  private visible(v: ReturnType<Renderer['frustum']>, x: number, y: number, r: number) {
    return x + r > v.x0 && x - r < v.x1 && y + r > v.y0 && y - r < v.y1;
  }

  /* ---- background ------------------------------------------------------ */

  private skyGrad: CanvasGradient | null = null;
  private skyKey = '';

  private drawSky(ctx: CanvasRenderingContext2D, game: Game) {
    const pal = game.level.palette;
    const key = `${pal.void0}|${pal.void1}|${this.width}x${this.height}`;
    if (this.skyKey !== key) {
      const g = ctx.createLinearGradient(0, 0, 0, this.height);
      g.addColorStop(0, css(pal.void1));
      g.addColorStop(1, css(pal.void0));
      this.skyGrad = g;
      this.skyKey = key;
    }
    ctx.fillStyle = this.skyGrad!;
    ctx.fillRect(0, 0, this.width, this.height);

    // Slow parallax nebula bands, keyed off camera position.
    const cam = game.camera;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.06;
    for (let i = 0; i < 3; i++) {
      const speed = 0.02 + i * 0.015;
      const x = (-cam.x * speed) % (this.width + 400) - 200;
      const y = (-cam.y * speed) % (this.height + 400) - 200;
      const r = 260 + i * 140;
      const g = ctx.createRadialGradient(x + i * 320, y + i * 190, 0, x + i * 320, y + i * 190, r);
      g.addColorStop(0, css(pal.accent));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.width, this.height);
    }
    ctx.restore();
  }

  /* ---- terrain --------------------------------------------------------- */

  private drawTerrain(ctx: CanvasRenderingContext2D, game: Game, v: ReturnType<Renderer['frustum']>) {
    const w = game.world;
    const pal = game.level.palette;

    // Ground base fill for the whole visible band, then per-tile variation.
    ctx.fillStyle = css(pal.ground0);
    ctx.fillRect(v.tx0 * TILE, v.ty0 * TILE, (v.tx1 - v.tx0 + 1) * TILE, (v.ty1 - v.ty0 + 1) * TILE);

    for (let ty = v.ty0; ty <= v.ty1; ty++) {
      for (let tx = v.tx0; tx <= v.tx1; tx++) {
        const i = w.idx(tx, ty);
        const t = w.tiles[i];
        const d = w.detail[i];
        if (t === Tile.Rock) continue;
        if (d > 0.52) {
          ctx.fillStyle = rgba(pal.ground1, (d - 0.52) * 1.6);
          ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
        }
      }
    }

    // Faint build grid.
    ctx.strokeStyle = rgba(pal.grid, 0.12);
    ctx.lineWidth = 1 / game.camera.zoom;
    ctx.beginPath();
    for (let tx = v.tx0; tx <= v.tx1 + 1; tx++) {
      ctx.moveTo(tx * TILE, v.ty0 * TILE);
      ctx.lineTo(tx * TILE, (v.ty1 + 1) * TILE);
    }
    for (let ty = v.ty0; ty <= v.ty1 + 1; ty++) {
      ctx.moveTo(v.tx0 * TILE, ty * TILE);
      ctx.lineTo((v.tx1 + 1) * TILE, ty * TILE);
    }
    ctx.stroke();

    // Rock: body, then a lit rim on faces exposed to the top-left light.
    const rockCss = css(pal.rock);
    const litCss = css(pal.rockLit);
    for (let ty = v.ty0; ty <= v.ty1; ty++) {
      for (let tx = v.tx0; tx <= v.tx1; tx++) {
        if (w.tiles[w.idx(tx, ty)] !== Tile.Rock) continue;
        const px = tx * TILE, py = ty * TILE;
        const d = w.detail[w.idx(tx, ty)];

        ctx.fillStyle = rockCss;
        ctx.fillRect(px, py, TILE, TILE);
        if (d > 0.5) {
          ctx.fillStyle = rgba(lighten(pal.rock, 0.14), (d - 0.5) * 1.2);
          ctx.fillRect(px, py, TILE, TILE);
        }

        const openTop = !w.isSolid(tx, ty - 1);
        const openLeft = !w.isSolid(tx - 1, ty);
        const openBottom = !w.isSolid(tx, ty + 1);
        const openRight = !w.isSolid(tx + 1, ty);

        if (openTop || openLeft) {
          ctx.fillStyle = litCss;
          if (openTop) ctx.fillRect(px, py, TILE, 3);
          if (openLeft) ctx.fillRect(px, py, 3, TILE);
        }
        if (openBottom || openRight) {
          ctx.fillStyle = rgba(0x000000, 0.45);
          if (openBottom) ctx.fillRect(px, py + TILE - 4, TILE, 4);
          if (openRight) ctx.fillRect(px + TILE - 4, py, 4, TILE);
        }
        // A couple of speckles for texture.
        if (d > 0.62) {
          ctx.fillStyle = rgba(pal.rockLit, 0.22);
          ctx.fillRect(px + ((d * 97) % 20) + 4, py + ((d * 53) % 20) + 4, 3, 3);
          ctx.fillRect(px + ((d * 31) % 22) + 3, py + ((d * 71) % 18) + 6, 2, 2);
        }
      }
    }
  }

  private drawOre(
    ctx: CanvasRenderingContext2D,
    gctx: CanvasRenderingContext2D,
    game: Game,
    v: ReturnType<Renderer['frustum']>,
  ) {
    const pal = game.level.palette;
    for (const n of game.world.nodes) {
      if (n.amount <= 0) continue;
      const cx = (n.tx + 0.5) * TILE, cy = (n.ty + 0.5) * TILE;
      if (!this.visible(v, cx, cy, TILE)) continue;

      const f = clamp(n.fullness, 0.12, 1);
      const pulse = 0.7 + Math.sin(n.shimmer) * 0.3;
      const col = n.rich ? mix(pal.oreColor, 0xffffff, 0.25) : pal.oreColor;
      const count = n.rich ? 7 : 5;

      // Socket shadow.
      ctx.fillStyle = rgba(0x000000, 0.4);
      ctx.beginPath();
      ctx.ellipse(cx, cy + 4, TILE * 0.42, TILE * 0.22, 0, 0, TAU);
      ctx.fill();

      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU + n.shimmer * 0.12;
        const dr = TILE * 0.22 * (0.5 + ((i * 37) % 10) / 10);
        const px = cx + Math.cos(a) * dr;
        const py = cy + Math.sin(a) * dr * 0.7;
        const hgt = TILE * 0.4 * f * (0.6 + ((i * 53) % 10) / 14);
        ctx.fillStyle = css(darken(col, 0.45));
        ctx.beginPath();
        ctx.moveTo(px - 3.4, py + 2);
        ctx.lineTo(px + 3.4, py + 2);
        ctx.lineTo(px, py - hgt);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = rgba(col, 0.85);
        ctx.beginPath();
        ctx.moveTo(px - 1.6, py + 1);
        ctx.lineTo(px + 1.1, py + 1.4);
        ctx.lineTo(px, py - hgt * 0.94);
        ctx.closePath();
        ctx.fill();
      }

      gctx.fillStyle = rgba(col, 0.4 * pulse * f);
      gctx.beginPath();
      gctx.arc(cx, cy - 4, TILE * 0.62 * f, 0, TAU);
      gctx.fill();

      if (n.claimedBy >= 0) {
        ctx.strokeStyle = rgba(0x5cf2a0, 0.35);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, TILE * 0.55, 0, TAU);
        ctx.stroke();
      }
    }
  }

  private drawGates(ctx: CanvasRenderingContext2D, gctx: CanvasRenderingContext2D, game: Game) {
    const t = game.elapsed;
    for (const s of game.world.spawns) {
      const heat = s.heat;
      const base = 0.4 + heat * 0.6;

      ctx.save();
      ctx.translate(s.x, s.y);

      // Cracked ground halo.
      ctx.fillStyle = rgba(0x000000, 0.5);
      ctx.beginPath();
      ctx.arc(0, 0, TILE * 1.5, 0, TAU);
      ctx.fill();

      ctx.strokeStyle = rgba(0xff4f5e, 0.35 + heat * 0.5);
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.rotate(t * (0.3 + i * 0.22) * (i % 2 ? -1 : 1));
        poly(ctx, 3 + i, TILE * (0.75 + i * 0.32), 0);
        ctx.stroke();
        ctx.restore();
      }

      // Maw.
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, TILE * 1.1);
      g.addColorStop(0, rgba(0xff4f5e, 0.55 + heat * 0.4));
      g.addColorStop(0.5, rgba(0x8c1f2f, 0.35));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, TILE * 1.1, 0, TAU);
      ctx.fill();

      ctx.fillStyle = rgba(0x1a0308, 0.9);
      ctx.beginPath();
      ctx.ellipse(0, 0, TILE * 0.55, TILE * 0.42, 0, 0, TAU);
      ctx.fill();

      // Directional arrow toward the core.
      ctx.rotate(s.angle);
      ctx.fillStyle = rgba(0xff4f5e, 0.3 + Math.sin(t * 3) * 0.15);
      ctx.beginPath();
      ctx.moveTo(TILE * 1.7, 0);
      ctx.lineTo(TILE * 1.2, -TILE * 0.24);
      ctx.lineTo(TILE * 1.2, TILE * 0.24);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      gctx.fillStyle = rgba(0xff4f5e, 0.28 * base);
      gctx.beginPath();
      gctx.arc(s.x, s.y, TILE * 1.6, 0, TAU);
      gctx.fill();
    }
  }

  /* ---- build feedback -------------------------------------------------- */

  private drawPlacementGhost(ctx: CanvasRenderingContext2D, game: Game) {
    if (game.cursorMode === 'sell') {
      const b = game.hoverBuilding;
      if (b) {
        ctx.strokeStyle = rgba(0xff4f5e, 0.9);
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        techRect(ctx, b.x - b.radius, b.y - b.radius, b.radius * 2, b.radius * 2, 8);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = rgba(0xff4f5e, 0.18);
        ctx.fill();
      }
      return;
    }
    if (game.cursorMode !== 'build' || !game.buildKind) return;

    const def = BUILDINGS[game.buildKind];
    const size = def.size * TILE;
    const px = game.buildTx * TILE;
    const py = game.buildTy * TILE;
    const ok = game.buildValid;
    const col = ok ? 0x46d8ff : 0xff4f5e;

    ctx.fillStyle = rgba(col, 0.14);
    ctx.fillRect(px, py, size, size);
    ctx.strokeStyle = rgba(col, 0.95);
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    techRect(ctx, px, py, size, size, 8);
    ctx.stroke();
    ctx.setLineDash([]);

    // Footprint tick marks.
    ctx.strokeStyle = rgba(col, 0.5);
    ctx.lineWidth = 1;
    for (let i = 1; i < def.size; i++) {
      ctx.beginPath();
      ctx.moveTo(px + i * TILE, py);
      ctx.lineTo(px + i * TILE, py + size);
      ctx.moveTo(px, py + i * TILE);
      ctx.lineTo(px + size, py + i * TILE);
      ctx.stroke();
    }

    if (def.range) {
      ctx.strokeStyle = rgba(col, 0.35);
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(px + size / 2, py + size / 2, def.range * game.perks.turretRange, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (def.auraRadius) {
      ctx.strokeStyle = rgba(0x5cf2a0, 0.35);
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(px + size / 2, py + size / 2, def.auraRadius, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawRangeRings(ctx: CanvasRenderingContext2D, game: Game) {
    const b = game.hoverBuilding;
    if (!b || game.cursorMode === 'build') return;
    if (b.def.range) {
      ctx.strokeStyle = rgba(0x46d8ff, 0.4);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 7]);
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.def.range * game.perks.turretRange, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (b.def.auraRadius) {
      ctx.strokeStyle = rgba(0x5cf2a0, 0.4);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 7]);
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.def.auraRadius, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Drone bays show how far their drones will range for work.
    if (b.def.droneRange) {
      ctx.strokeStyle = rgba(game.level.palette.oreColor, 0.28);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 9]);
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.def.droneRange, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /* ---- entities -------------------------------------------------------- */

  private drawBuildings(
    ctx: CanvasRenderingContext2D,
    gctx: CanvasRenderingContext2D,
    game: Game,
    v: ReturnType<Renderer['frustum']>,
  ) {
    const accent = game.level.palette.accent;
    for (const b of game.buildings) {
      if (!this.visible(v, b.x, b.y, b.radius + 20)) continue;

      // Ground shadow.
      ctx.fillStyle = rgba(0x000000, 0.35);
      ctx.beginPath();
      ctx.ellipse(b.x + 3, b.y + 5, b.radius * 0.95, b.radius * 0.55, 0, 0, TAU);
      ctx.fill();

      drawBuilding(ctx, b, accent, game.elapsed);

      // Beam weapons draw their ray here so it sits above the chassis.
      if (b.def.beam && b.beamIntensity > 0.02) {
        const i = b.beamIntensity;
        const beamCol = b.def.beamColor ?? 0xff6fd0;
        // Thin beams (Pulse Laser) stay tight; the Lance blooms wide.
        const girth = b.def.pierce && b.def.pierce > 1 ? 1 : 0.6;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = rgba(beamCol, 0.35 * i);
        ctx.lineWidth = 9 * i * girth;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.beamHitX, b.beamHitY);
        ctx.stroke();
        ctx.strokeStyle = rgba(0xffffff, 0.95 * i);
        ctx.lineWidth = 2.4 * i * girth;
        ctx.stroke();
        ctx.restore();

        gctx.strokeStyle = rgba(beamCol, 0.7 * i);
        gctx.lineWidth = 14 * i * girth;
        gctx.beginPath();
        gctx.moveTo(b.x, b.y);
        gctx.lineTo(b.beamHitX, b.beamHitY);
        gctx.stroke();
        gctx.fillStyle = rgba(0xffffff, 0.8 * i);
        gctx.beginPath();
        gctx.arc(b.beamHitX, b.beamHitY, 12 * i, 0, TAU);
        gctx.fill();
      }

      if (b.shield > 0 && b.maxShield > 0) {
        const s = b.shield / b.maxShield;
        ctx.strokeStyle = rgba(0x9fd8ff, 0.25 + s * 0.35);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.radius * 1.35, 0, TAU);
        ctx.stroke();
      }

      if (b.muzzleFlash > 0) {
        // The bloom pass composites this twice, so a full-size blob here reads as
        // a flashbang on fast guns — scale it by the turret's authored flare.
        // Kept small even at full flare: a cluster of turrets firing on the same
        // spot adds these additively, and an oversized blob per gun buries the
        // target under the pile-up long before any single flash looks too big.
        const flare = b.def.muzzleFlare ?? 1;
        gctx.fillStyle = rgba(0xffe0a0, b.muzzleFlash * 0.5 * flare);
        gctx.beginPath();
        gctx.arc(
          b.x + Math.cos(b.angle) * b.radius,
          b.y + Math.sin(b.angle) * b.radius,
          11 * b.muzzleFlash * flare, 0, TAU,
        );
        gctx.fill();
      }
      if (b.kind === 'generator') {
        gctx.fillStyle = rgba(0x46d8ff, 0.28 + Math.sin(game.elapsed * 3 + b.phase) * 0.1);
        gctx.beginPath();
        gctx.arc(b.x, b.y, b.radius * 1.5, 0, TAU);
        gctx.fill();
      }
    }
  }

  private drawCore(ctx: CanvasRenderingContext2D, gctx: CanvasRenderingContext2D, game: Game) {
    const c = game.core;
    const t = game.elapsed;
    const pal = game.level.palette;
    const danger = c.distress;
    const hot = mix(0x46d8ff, 0xff4f5e, danger);

    ctx.save();
    ctx.translate(c.x, c.y);

    // Base platform.
    ctx.fillStyle = rgba(0x000000, 0.5);
    ctx.beginPath();
    ctx.ellipse(4, 8, c.radius * 1.35, c.radius * 0.7, 0, 0, TAU);
    ctx.fill();

    ctx.fillStyle = css(0x121926);
    poly(ctx, 6, c.radius * 1.3, Math.PI / 6);
    ctx.fill();
    ctx.fillStyle = css(0x1c2637);
    poly(ctx, 6, c.radius * 1.12, Math.PI / 6);
    ctx.fill();
    ctx.strokeStyle = rgba(pal.accent, 0.3);
    ctx.lineWidth = 2;
    poly(ctx, 6, c.radius * 1.12, Math.PI / 6);
    ctx.stroke();

    // Buttress struts.
    ctx.strokeStyle = css(0x2c3a4e);
    ctx.lineWidth = 5;
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (i / 6) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * c.radius * 0.6, Math.sin(a) * c.radius * 0.6);
      ctx.lineTo(Math.cos(a) * c.radius * 1.18, Math.sin(a) * c.radius * 1.18);
      ctx.stroke();
    }

    // Counter-rotating containment rings.
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.rotate(c.spin * (i % 2 ? -1 : 1) * (0.6 + i * 0.4));
      ctx.strokeStyle = rgba(hot, 0.5 - i * 0.1);
      ctx.lineWidth = 3 - i * 0.6;
      const r = c.radius * (0.86 - i * 0.16);
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.arc(0, 0, r, (k / 3) * TAU, (k / 3) * TAU + 1.4);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Levitating shards.
    for (let i = 0; i < 5; i++) {
      const a = c.spin * 1.6 + (i / 5) * TAU;
      const rr = c.radius * 0.55 + Math.sin(t * 2 + i) * 3;
      ctx.save();
      ctx.translate(Math.cos(a) * rr, Math.sin(a) * rr);
      ctx.rotate(a + t);
      ctx.fillStyle = rgba(hot, 0.85);
      poly(ctx, 3, c.radius * 0.13, 0);
      ctx.fill();
      ctx.restore();
    }

    // Reactor heart.
    const beat = 0.8 + Math.sin(t * (2.2 + danger * 5)) * 0.2;
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, c.radius * 0.8);
    grd.addColorStop(0, rgba(0xffffff, 0.95));
    grd.addColorStop(0.35, rgba(hot, 0.85 * beat));
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(0, 0, c.radius * 0.8, 0, TAU);
    ctx.fill();

    ctx.fillStyle = rgba(0xffffff, 0.9);
    star(ctx, 6, c.radius * 0.3 * beat, c.radius * 0.13, c.spin * 0.4);
    ctx.fill();

    if (c.hitFlash > 0) {
      ctx.strokeStyle = rgba(0xff4f5e, c.hitFlash);
      ctx.lineWidth = 4;
      poly(ctx, 6, c.radius * 1.2, Math.PI / 6);
      ctx.stroke();
    }
    if (c.shield > 0 && c.maxShield > 0) {
      const s = c.shield / c.maxShield;
      ctx.strokeStyle = rgba(0x9fd8ff, 0.3 + s * 0.4);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, c.radius * 1.55, 0, TAU);
      ctx.stroke();
    }

    // HP arc.
    ctx.lineWidth = 5;
    ctx.strokeStyle = rgba(0x000000, 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, c.radius * 1.45, -Math.PI * 0.5, Math.PI * 1.5);
    ctx.stroke();
    ctx.strokeStyle = css(c.pct > 0.5 ? 0x5cf2a0 : c.pct > 0.25 ? 0xffb347 : 0xff4f5e);
    ctx.beginPath();
    ctx.arc(0, 0, c.radius * 1.45, -Math.PI * 0.5, -Math.PI * 0.5 + TAU * c.pct);
    ctx.stroke();

    ctx.restore();

    gctx.fillStyle = rgba(hot, 0.34 * beat);
    gctx.beginPath();
    gctx.arc(c.x, c.y, c.radius * 1.7, 0, TAU);
    gctx.fill();
    if (c.reviveFlash > 0) {
      gctx.fillStyle = rgba(0x7dfff0, c.reviveFlash * 0.8);
      gctx.beginPath();
      gctx.arc(c.x, c.y, c.radius * (2 + (1 - c.reviveFlash) * 6), 0, TAU);
      gctx.fill();
    }
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, gctx: CanvasRenderingContext2D, game: Game) {
    const p = game.player;
    if (p.dead) return;
    const t = game.elapsed;
    const blink = p.invuln > 0 && Math.floor(t * 14) % 2 === 0;

    ctx.save();
    ctx.translate(p.x, p.y);

    ctx.fillStyle = rgba(0x000000, 0.4);
    ctx.beginPath();
    ctx.ellipse(2, 6, p.radius * 1.1, p.radius * 0.55, 0, 0, TAU);
    ctx.fill();

    if (blink) ctx.globalAlpha = 0.45;

    // Legs, animated by stride.
    ctx.save();
    ctx.rotate(p.facing);
    ctx.strokeStyle = css(0x39485c);
    ctx.lineWidth = 4.5;
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      const sw = Math.sin(p.stride * 3 + (side > 0 ? Math.PI : 0)) * 5;
      ctx.beginPath();
      ctx.moveTo(-2, side * 7);
      ctx.lineTo(sw - 4, side * 13);
      ctx.stroke();
    }
    ctx.restore();

    // Chassis.
    ctx.save();
    ctx.rotate(p.facing);
    const body = p.hitFlash > 0 ? lighten(0x33465e, p.hitFlash * 0.7) : 0x33465e;
    ctx.fillStyle = css(body);
    techRect(ctx, -p.radius, -p.radius * 0.82, p.radius * 1.9, p.radius * 1.64, 5);
    ctx.fill();
    ctx.strokeStyle = rgba(0x7fd9ff, 0.5);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // Thruster vents.
    ctx.fillStyle = rgba(0x46d8ff, 0.5 + Math.sin(t * 12) * 0.2);
    ctx.fillRect(-p.radius - 1, -5, 3, 10);
    ctx.restore();

    // Turret + barrel.
    ctx.save();
    ctx.rotate(p.aim);
    const rec = -p.recoil * 3.4;
    ctx.fillStyle = css(0x4a6079);
    ctx.beginPath();
    ctx.arc(0, 0, p.radius * 0.66, 0, TAU);
    ctx.fill();
    ctx.fillStyle = css(0x5f7893);
    ctx.fillRect(rec + p.radius * 0.4, -2.6, p.radius * 1.5, 5.2);
    ctx.fillStyle = css(0x8fb4d6);
    ctx.fillRect(rec + p.radius * 1.5, -2.0, p.radius * 0.42, 4);
    // Heat glow on the barrel.
    if (p.heat > 0.1) {
      ctx.fillStyle = rgba(p.overheated ? 0xff4f5e : 0xffb347, p.heat * 0.75);
      ctx.fillRect(rec + p.radius * 1.2, -2.6, p.radius * 0.75, 5.2);
    }
    ctx.restore();

    // Cockpit light.
    ctx.fillStyle = rgba(0x9fe8ff, 0.9);
    ctx.beginPath();
    ctx.arc(0, 0, 2.6, 0, TAU);
    ctx.fill();

    ctx.restore();

    // Mining beam.
    if (p.miningNode >= 0) {
      const n = game.world.nodes[p.miningNode];
      if (n) {
        const nx = (n.tx + 0.5) * TILE, ny = (n.ty + 0.5) * TILE;
        const w = 2 + p.miningHeat * 3;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = rgba(game.level.palette.oreColor, 0.25 + p.miningHeat * 0.4);
        ctx.lineWidth = w * 2.4;
        lightning(ctx, p.x, p.y, nx, ny, Math.floor(t * 30) * 7, 8);
        ctx.stroke();
        ctx.strokeStyle = rgba(0xffffff, 0.8);
        ctx.lineWidth = w * 0.7;
        ctx.stroke();
        ctx.restore();

        gctx.strokeStyle = rgba(game.level.palette.oreColor, 0.6);
        gctx.lineWidth = w * 3;
        gctx.beginPath();
        gctx.moveTo(p.x, p.y);
        gctx.lineTo(nx, ny);
        gctx.stroke();
      }
    }

    gctx.fillStyle = rgba(0x46d8ff, 0.22);
    gctx.beginPath();
    gctx.arc(p.x, p.y, p.radius * 1.7, 0, TAU);
    gctx.fill();

    // Health ring, only when hurt.
    if (p.hp < p.maxHp) {
      const pct = p.hp / p.maxHp;
      ctx.lineWidth = 3;
      ctx.strokeStyle = rgba(0x000000, 0.6);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius + 8, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = css(pct > 0.4 ? 0x5cf2a0 : 0xff4f5e);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius + 8, -Math.PI / 2, -Math.PI / 2 + TAU * pct);
      ctx.stroke();
    }
  }

  private drawEnemies(
    ctx: CanvasRenderingContext2D,
    gctx: CanvasRenderingContext2D,
    game: Game,
    v: ReturnType<Renderer['frustum']>,
  ) {
    for (const e of game.enemies) {
      if (!this.visible(v, e.x, e.y, e.radius + 30)) continue;

      // Fliers cast a displaced shadow to read as airborne.
      const shadowOff = e.flying ? 12 : 4;
      ctx.fillStyle = rgba(0x000000, e.flying ? 0.28 : 0.4);
      ctx.beginPath();
      ctx.ellipse(e.x + 2, e.y + shadowOff, e.radius * 0.9, e.radius * 0.45, 0, 0, TAU);
      ctx.fill();

      ctx.save();
      ctx.translate(e.x, e.y - (e.flying ? 8 : 0));
      drawEnemy(ctx, {
        shape: e.def.shape, r: e.radius, angle: e.angle, anim: e.anim, gait: e.gait,
        color: e.def.color, accent: e.def.accent, flash: e.hitFlash,
        elite: e.elite, hpPct: e.hp / e.maxHp, submerged: e.submerged,
        casting: e.castingIndex >= 0,
      });
      ctx.restore();

      if (e.submerged) continue;

      // Elite trim.
      if (e.elite) {
        ctx.strokeStyle = rgba(0xffcc55, 0.55);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.radius * 1.28, 0, TAU);
        ctx.stroke();
      }

      // Status auras.
      if (e.slowTimer > 0) {
        ctx.strokeStyle = rgba(0x9fd8ff, 0.4);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.radius * 1.15, 0, TAU);
        ctx.stroke();
      }
      if (e.def.behavior === 'support' && e.def.auraRadius) {
        ctx.strokeStyle = rgba(e.def.accent, 0.16 + Math.sin(e.auraPhase) * 0.06);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.def.auraRadius, 0, TAU);
        ctx.stroke();
      }
      if (e.shieldHp > 0) {
        ctx.strokeStyle = rgba(0x9fd8ff, 0.55);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.radius * 1.35, 0, TAU);
        ctx.stroke();
      }

      // Health bar for anything meaningful.
      if (e.hp < e.maxHp && (e.radius > 8 || e.boss)) {
        const w = e.boss ? e.radius * 2.4 : e.radius * 2;
        const pct = e.hp / e.maxHp;
        const yy = e.y - e.radius - (e.boss ? 18 : 9);
        ctx.fillStyle = rgba(0x000000, 0.6);
        ctx.fillRect(e.x - w / 2, yy, w, e.boss ? 5 : 3);
        ctx.fillStyle = css(e.elite ? 0xffcc55 : e.boss ? 0xff4f5e : 0xff8090);
        ctx.fillRect(e.x - w / 2, yy, w * pct, e.boss ? 5 : 3);
      }

      gctx.fillStyle = rgba(e.def.accent, e.boss ? 0.3 : 0.14);
      gctx.beginPath();
      gctx.arc(e.x, e.y, e.radius * (e.boss ? 2 : 1.4), 0, TAU);
      gctx.fill();
      if (e.hitFlash > 0) {
        gctx.fillStyle = rgba(0xffffff, e.hitFlash * 0.5);
        gctx.beginPath();
        gctx.arc(e.x, e.y, e.radius * 1.6, 0, TAU);
        gctx.fill();
      }
    }
  }

  private drawDrones(
    ctx: CanvasRenderingContext2D,
    gctx: CanvasRenderingContext2D,
    game: Game,
    v: ReturnType<Renderer['frustum']>,
  ) {
    const oreCol = game.level.palette.oreColor;

    for (const d of game.drones) {
      if (!this.visible(v, d.x, d.y, d.radius + 30)) continue;
      // Hover bob, and a shadow offset well below it so it reads as airborne.
      const bob = Math.sin(d.anim * 3.4 + d.id) * 2;

      ctx.fillStyle = rgba(0x000000, 0.3);
      ctx.beginPath();
      ctx.ellipse(d.x + 2, d.y + 14, d.radius * 0.75, d.radius * 0.34, 0, 0, TAU);
      ctx.fill();

      // Mining beam, drawn before the body so the drone sits on top of it.
      if (d.beam > 0.02 && d.nodeIndex >= 0) {
        const n = game.world.nodes[d.nodeIndex];
        if (n) {
          const nx = (n.tx + 0.5) * TILE, ny = (n.ty + 0.5) * TILE;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = rgba(oreCol, 0.3 * d.beam);
          ctx.lineWidth = 4 * d.beam;
          ctx.beginPath();
          ctx.moveTo(d.x, d.y + bob);
          ctx.lineTo(nx, ny);
          ctx.stroke();
          ctx.strokeStyle = rgba(0xffffff, 0.65 * d.beam);
          ctx.lineWidth = 1.3 * d.beam;
          ctx.stroke();
          ctx.restore();

          gctx.strokeStyle = rgba(oreCol, 0.5 * d.beam);
          gctx.lineWidth = 7 * d.beam;
          gctx.beginPath();
          gctx.moveTo(d.x, d.y + bob);
          gctx.lineTo(nx, ny);
          gctx.stroke();
        }
      }

      ctx.save();
      ctx.translate(d.x, d.y + bob);
      drawDrone(ctx, {
        r: d.radius, angle: d.angle, anim: d.anim, flash: d.hitFlash,
        hpPct: d.hp / d.maxHp, cargoPct: d.cargo / d.cargoMax,
        working: d.state === 'mining',
      });
      ctx.restore();

      // Health pip only when hurt — drones are small and the HUD is busy.
      if (d.hp < d.maxHp) {
        const w = d.radius * 1.8;
        const pct = d.hp / d.maxHp;
        ctx.fillStyle = rgba(0x000000, 0.6);
        ctx.fillRect(d.x - w / 2, d.y + bob - d.radius - 7, w, 2.5);
        ctx.fillStyle = css(pct > 0.5 ? 0x5cf2a0 : 0xff4f5e);
        ctx.fillRect(d.x - w / 2, d.y + bob - d.radius - 7, w * pct, 2.5);
      }

      gctx.fillStyle = rgba(0x46d8ff, 0.16);
      gctx.beginPath();
      gctx.arc(d.x, d.y + bob, d.radius * 1.6, 0, TAU);
      gctx.fill();
    }
  }

  private drawPickups(ctx: CanvasRenderingContext2D, gctx: CanvasRenderingContext2D, game: Game) {
    for (const q of game.pickups) {
      if (q.dead) continue;
      const bob = Math.sin(q.bob) * 2.5;
      const fade = q.life < 4 ? clamp(q.life / 4, 0, 1) : 1;
      const col = q.kind === 'essence' ? 0xb47cff
        : q.kind === 'ore' ? 0x7fd9ff
        : q.kind === 'health' ? 0x5cf2a0 : 0xffcc55;

      ctx.save();
      ctx.translate(q.x, q.y + bob);
      ctx.rotate(q.bob * 0.4);
      ctx.globalAlpha = fade;
      ctx.fillStyle = rgba(col, 0.95);
      if (q.kind === 'relic') star(ctx, 5, q.radius * 1.3, q.radius * 0.55, 0);
      else poly(ctx, q.kind === 'health' ? 4 : 3, q.radius, 0);
      ctx.fill();
      ctx.strokeStyle = rgba(0xffffff, 0.6);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      gctx.fillStyle = rgba(col, 0.45 * fade);
      gctx.beginPath();
      gctx.arc(q.x, q.y + bob, q.radius * 2.2, 0, TAU);
      gctx.fill();
    }
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D, gctx: CanvasRenderingContext2D, game: Game) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of game.projectiles) {
      if (p.dead) continue;

      if (p.kind === 'mortar') {
        // Ground marker + arcing shell.
        const t = p.flightTotal > 0 ? p.flightTime / p.flightTotal : 0;
        ctx.strokeStyle = rgba(0xffb066, 0.35 + t * 0.4);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.targetX, p.targetY, (p.splash || 60) * (0.4 + t * 0.6), 0, TAU);
        ctx.stroke();
        ctx.fillStyle = rgba(0xffd9a0, 0.95);
        ctx.beginPath();
        ctx.arc(p.x, p.y - p.z, p.size * (0.7 + t * 0.3), 0, TAU);
        ctx.fill();
        gctx.fillStyle = rgba(0xffb066, 0.6);
        gctx.beginPath();
        gctx.arc(p.x, p.y - p.z, p.size * 2.2, 0, TAU);
        gctx.fill();
        continue;
      }

      if (p.kind === 'rocket') {
        // Solid warhead with fins and a flame, rather than a tracer streak.
        const a = Math.atan2(p.vy, p.vx);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.translate(p.x, p.y);
        ctx.rotate(a);
        const L = p.size * 2.3, W = p.size * 0.9;
        ctx.fillStyle = css(0x3f4a5c);
        ctx.beginPath();
        ctx.moveTo(L, 0);
        ctx.lineTo(L * 0.35, -W);
        ctx.lineTo(-L * 0.55, -W);
        ctx.lineTo(-L * 0.55, W);
        ctx.lineTo(L * 0.35, W);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = css(0xff8a5c);
        ctx.beginPath();
        ctx.moveTo(L, 0);
        ctx.lineTo(L * 0.45, -W * 0.55);
        ctx.lineTo(L * 0.45, W * 0.55);
        ctx.closePath();
        ctx.fill();
        // Fins.
        ctx.fillStyle = css(0x2a3140);
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(-L * 0.35, s * W);
          ctx.lineTo(-L * 0.7, s * W * 2);
          ctx.lineTo(-L * 0.55, s * W * 0.9);
          ctx.closePath();
          ctx.fill();
        }
        // Motor flame, flickering.
        const flick = 0.7 + Math.sin(game.elapsed * 60 + p.x) * 0.3;
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = rgba(0xffd08a, 0.9);
        ctx.beginPath();
        ctx.moveTo(-L * 0.55, -W * 0.6);
        ctx.lineTo(-L * (1.1 + flick * 0.7), 0);
        ctx.lineTo(-L * 0.55, W * 0.6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        gctx.fillStyle = rgba(0xffa060, 0.7);
        gctx.beginPath();
        gctx.arc(p.x, p.y, p.size * 3, 0, TAU);
        gctx.fill();
        continue;
      }

      const speed = Math.hypot(p.vx, p.vy);
      const len = clamp(speed * 0.016, 4, 26);
      const a = Math.atan2(p.vy, p.vx);
      const tailX = p.x - Math.cos(a) * len;
      const tailY = p.y - Math.sin(a) * len;

      ctx.strokeStyle = rgba(p.color, 0.55);
      ctx.lineWidth = p.size * 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.strokeStyle = rgba(0xffffff, 0.9);
      ctx.lineWidth = p.size * 0.55;
      ctx.stroke();

      gctx.fillStyle = rgba(p.color, 0.55);
      gctx.beginPath();
      gctx.arc(p.x, p.y, p.size * 2.4, 0, TAU);
      gctx.fill();
    }
    ctx.restore();
  }

  private drawEffects(ctx: CanvasRenderingContext2D, gctx: CanvasRenderingContext2D, game: Game) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of game.effects) {
      const t = clamp(e.life / e.maxLife, 0, 1);
      switch (e.kind) {
        case 'arc': {
          ctx.strokeStyle = rgba(e.color, 0.7 * t);
          ctx.lineWidth = e.width * 2.6;
          lightning(ctx, e.x, e.y, e.x2, e.y2, e.seed, 14);
          ctx.stroke();
          ctx.strokeStyle = rgba(0xffffff, 0.95 * t);
          ctx.lineWidth = e.width * 0.8;
          ctx.stroke();
          gctx.strokeStyle = rgba(e.color, 0.6 * t);
          gctx.lineWidth = e.width * 4;
          gctx.beginPath();
          gctx.moveTo(e.x, e.y);
          gctx.lineTo(e.x2, e.y2);
          gctx.stroke();
          break;
        }
        case 'beam': {
          const w = e.width * t;
          ctx.strokeStyle = rgba(e.color, 0.4 * t);
          ctx.lineWidth = w * 2;
          ctx.beginPath();
          ctx.moveTo(e.x, e.y);
          ctx.lineTo(e.x2, e.y2);
          ctx.stroke();
          ctx.strokeStyle = rgba(0xffffff, 0.9 * t);
          ctx.lineWidth = w * 0.5;
          ctx.stroke();
          gctx.strokeStyle = rgba(e.color, 0.7 * t);
          gctx.lineWidth = w * 3;
          gctx.beginPath();
          gctx.moveTo(e.x, e.y);
          gctx.lineTo(e.x2, e.y2);
          gctx.stroke();
          break;
        }
        case 'shock': {
          const r = e.radius * (1 - t * 0.85);
          ctx.strokeStyle = rgba(e.color, t * 0.85);
          ctx.lineWidth = e.width * t + 1;
          ctx.beginPath();
          ctx.arc(e.x, e.y, r, 0, TAU);
          ctx.stroke();
          ctx.strokeStyle = rgba(0xffffff, t * 0.5);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(e.x, e.y, r * 0.82, 0, TAU);
          ctx.stroke();
          break;
        }
        case 'telegraph': {
          // Fills as the wind-up completes, so the danger zone is unambiguous.
          const fill = 1 - t;
          ctx.setLineDash([9, 7]);
          ctx.strokeStyle = rgba(e.color, 0.5 + fill * 0.4);
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.radius, 0, TAU);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = rgba(e.color, 0.1 + fill * 0.18);
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.radius * fill, 0, TAU);
          ctx.fill();
          break;
        }
      }
    }
    ctx.restore();
  }

  private drawParticles(
    ctx: CanvasRenderingContext2D,
    gctx: CanvasRenderingContext2D,
    game: Game,
    additivePass: boolean,
  ) {
    const P = game.particles;
    ctx.save();
    if (additivePass) ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < P.count; i++) {
      const isAdd = P.additive[i] === 1;
      if (isAdd !== additivePass) continue;

      const t = P.life[i] / P.maxLife[i];
      const col = P.color[i];
      const x = P.x[i], y = P.y[i];
      const s = P.size[i];

      switch (P.kind[i]) {
        case PKind.Spark: {
          const l = Math.min(11, Math.hypot(P.vx[i], P.vy[i]) * 0.02);
          const a = Math.atan2(P.vy[i], P.vx[i]);
          ctx.strokeStyle = rgba(col, t);
          ctx.lineWidth = s * t;
          ctx.beginPath();
          ctx.moveTo(x - Math.cos(a) * l, y - Math.sin(a) * l);
          ctx.lineTo(x, y);
          ctx.stroke();
          break;
        }
        case PKind.Trail:
        case PKind.Ember: {
          ctx.fillStyle = rgba(col, t * 0.9);
          ctx.beginPath();
          ctx.arc(x, y, s * t, 0, TAU);
          ctx.fill();
          break;
        }
        case PKind.Smoke: {
          ctx.fillStyle = rgba(col, t * 0.32);
          ctx.beginPath();
          ctx.arc(x, y, s * (1.6 - t * 0.6), 0, TAU);
          ctx.fill();
          break;
        }
        case PKind.Shard: {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(P.rot[i]);
          ctx.fillStyle = rgba(col, Math.min(1, t * 1.4));
          ctx.fillRect(-s / 2, -s / 3, s, s * 0.66);
          ctx.restore();
          break;
        }
        case PKind.Ring: {
          const r = s * (1.2 - t);
          ctx.strokeStyle = rgba(col, t * 0.8);
          ctx.lineWidth = 2 + t * 2;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, TAU);
          ctx.stroke();
          break;
        }
        case PKind.Glow: {
          ctx.fillStyle = rgba(col, t * 0.55);
          ctx.beginPath();
          ctx.arc(x, y, s * (0.6 + (1 - t)), 0, TAU);
          ctx.fill();
          break;
        }
      }

      if (isAdd && s > 1.5) {
        gctx.fillStyle = rgba(col, t * 0.4);
        gctx.beginPath();
        gctx.arc(x, y, s * 1.8, 0, TAU);
        gctx.fill();
      }
    }
    ctx.restore();
  }

  private drawDamageNumbers(ctx: CanvasRenderingContext2D, game: Game) {
    if (!game.progress.data.settings.showDamageNumbers) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const d of game.damageNumbers) {
      const a = clamp(d.life / 0.75, 0, 1);
      const size = d.crit ? 15 : 12;
      ctx.font = `700 ${size}px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = rgba(0x000000, a * 0.7);
      ctx.fillText(String(d.value), d.x + 1, d.y + 1);
      ctx.fillStyle = rgba(d.crit ? 0xffe08a : d.color, a);
      ctx.fillText(String(d.value), d.x, d.y);
    }
    ctx.restore();
  }

  /* ---- composite & post ------------------------------------------------ */

  private compositeGlow(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (this.supportsFilter) ctx.filter = 'blur(7px)';
    ctx.globalAlpha = 0.95;
    ctx.drawImage(this.glow, 0, 0, this.width, this.height);
    // The wide second pass is what sells the bloom, and also what costs the most
    // — a full-screen blur. Mid and low tiers stop at one pass.
    if (this.profile.bloomPasses > 1) {
      if (this.supportsFilter) ctx.filter = 'blur(18px)';
      ctx.globalAlpha = 0.6;
      ctx.drawImage(this.glow, 0, 0, this.width, this.height);
    }
    ctx.filter = 'none';
    ctx.restore();
  }

  private vignette: CanvasGradient | null = null;
  private vignetteKey = '';

  private drawPost(ctx: CanvasRenderingContext2D, game: Game, pal: { fog: number }) {
    const w = this.width, h = this.height;

    // Fog of distance — pulls the eye to the centre of the action.
    const key = `${w}x${h}`;
    if (this.vignetteKey !== key) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.78);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.62)');
      this.vignette = g;
      this.vignetteKey = key;
    }
    ctx.fillStyle = this.vignette!;
    ctx.fillRect(0, 0, w, h);
    void pal;

    // Core distress: pulsing red rim.
    const d = game.core.distress;
    if (d > 0.35) {
      const pulse = (Math.sin(game.elapsed * 6) * 0.5 + 0.5) * (d - 0.35) / 0.65;
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.28, w / 2, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(255,40,60,${0.16 + pulse * 0.3})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // Impact flash.
    if (game.flash.a > 0.002) {
      const f = game.flash;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(${Math.round(f.r * 255)},${Math.round(f.g * 255)},${Math.round(f.b * 255)},${f.a * 0.5})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    // Very light scanlines to unify the palette. Hundreds of fills per frame, so
    // the lower tiers skip it entirely.
    if (this.profile.scanlines) {
      ctx.save();
      ctx.globalAlpha = 0.045;
      ctx.fillStyle = '#000';
      for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
      ctx.restore();
    }
  }

  /** World → screen, for DOM overlays and tooltips. */
  worldToScreen(game: Game, x: number, y: number) {
    const cam = game.camera;
    return {
      x: (x - (cam.x + cam.shakeX)) * cam.zoom + this.width / 2,
      y: (y - (cam.y + cam.shakeY)) * cam.zoom + this.height / 2,
    };
  }
}

export { lerp };
