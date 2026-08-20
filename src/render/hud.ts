import { clamp, fmtNum, fmtTime, TAU } from '../core/math';
import { t as tr } from '../core/i18n';
import { BUILDINGS, buildingName, buildingDesc, type BuildingKind, type TargetingMode } from '../data/buildings';
import { ENEMIES, enemyName } from '../data/enemies';
import { levelName, levelSubtitle } from '../data/levels';
import { Tile, TILE } from '../game/world';
import type { Game } from '../game/game';
import { css, rgba } from './palette';
import { techRect } from './shapes';
import type { SafeInsets } from '../core/platform';

type Ctx = CanvasRenderingContext2D;

const UI_FONT = "'Bahnschrift', 'DIN Alternate', 'Segoe UI', system-ui, sans-serif";
const MONO = "'Cascadia Mono', Consolas, monospace";

/** Localised label for a turret's target-priority mode, shown in the hover tooltip. */
function targetingLabel(mode: TargetingMode): string {
  switch (mode) {
    case 'first': return tr('hud.targeting.first', 'FIRST');
    case 'closest': return tr('hud.targeting.closest', 'CLOSEST');
    case 'strongest': return tr('hud.targeting.strongest', 'STRONGEST');
    case 'weakest': return tr('hud.targeting.weakest', 'WEAKEST');
  }
}

/**
 * Diegetic HUD drawn straight onto the canvas: resource strip, wave tracker,
 * build bar, minimap, boss bar, tooltips and the phase banner. Keeping it in
 * canvas means it shakes and flashes with the world instead of floating above it.
 */
export class Hud {
  /** Build-bar hit rectangles, refreshed each frame for click routing. */
  buildSlots: { kind: BuildingKind; x: number; y: number; w: number; h: number }[] = [];
  /** Compact layout for touch: no build bar, no cursor chrome, thumb zones clear. */
  compact = false;
  /** Extra scale for text and gauges, from the UI scale setting. */
  uiScale = 1;
  /** Notch/Dynamic Island/home-indicator clearance, so corner readouts clear the cutout. */
  insets: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  draw(ctx: Ctx, game: Game, w: number, h: number, fps: number) {
    ctx.save();
    ctx.textBaseline = 'middle';

    if (this.compact) {
      // Touch: the bottom third belongs to the thumbs, so every readout moves up
      // and the build bar is replaced by the drawer in TouchHud.
      this.compactTopBar(ctx, game, w);
      this.waveTracker(ctx, game, w);
      this.minimap(ctx, game, w, h);
      if (game.bossRef) this.bossBar(ctx, game, w);
      this.banner(ctx, game, w, h);
      this.errorToast(ctx, game, w, h);
      this.debug(ctx, game, w, h, fps);
    } else {
      this.topBar(ctx, game, w);
      this.waveTracker(ctx, game, w);
      this.buildBar(ctx, game, w, h);
      this.minimap(ctx, game, w, h);
      this.statusRail(ctx, game, w, h);
      if (game.bossRef) this.bossBar(ctx, game, w);
      this.tooltip(ctx, game, w, h);
      this.banner(ctx, game, w, h);
      this.crosshair(ctx, game);
      this.errorToast(ctx, game, w, h);
      this.debug(ctx, game, w, h, fps);
    }

    ctx.restore();
  }

  /* ---- compact top strip (touch) --------------------------------------- */

  /**
   * Everything the desktop layout spreads across the top bar and the bottom-left
   * status rail, folded into one strip. The rail cannot stay at the bottom on
   * touch: that is exactly where the movement thumb lives.
   */
  private compactTopBar(ctx: Ctx, game: Game, w: number) {
    const s = this.uiScale;
    const { top: insetTop, right: insetRight, left: insetLeft } = this.insets;
    const H = Math.round(58 * s) + insetTop;

    const grad = ctx.createLinearGradient(0, 0, 0, H + 10);
    grad.addColorStop(0, 'rgba(5,8,14,0.94)');
    grad.addColorStop(1, 'rgba(5,8,14,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, H + 10);

    // The notch/Dynamic Island lands on a side in landscape, not necessarily
    // the top — insets.left/right keep this strip's readouts off it.
    const pad = Math.round(14 * s) + insetLeft;
    let x = pad;
    const row1 = Math.round(15 * s) + insetTop;
    const row2 = Math.round(34 * s) + insetTop;

    // Resources on one line, glyph + value only — labels do not survive the space.
    ctx.textAlign = 'left';
    ctx.font = `600 ${Math.round(13 * s)}px ${MONO}`;
    ctx.fillStyle = css(0x7fd9ff);
    ctx.fillText(`◆${fmtNum(game.ore)}`, x, row1);
    x += ctx.measureText(`◆${fmtNum(game.ore)}`).width + Math.round(12 * s);
    ctx.fillStyle = css(0xb47cff);
    ctx.fillText(`✦${fmtNum(game.essence)}`, x, row1);
    x += ctx.measureText(`✦${fmtNum(game.essence)}`).width + Math.round(12 * s);

    const eff = game.power.efficiency;
    ctx.fillStyle = css(eff >= 1 ? 0x5cf2a0 : eff > 0.6 ? 0xffb347 : 0xff4f5e);
    ctx.fillText(`⚡${Math.round(game.power.draw)}/${Math.round(game.power.supply)}`, x, row1);

    // Core + chassis bars, stacked and short.
    const barW = Math.round(120 * s);
    const barH = Math.round(7 * s);
    const c = game.core;
    ctx.fillStyle = rgba(0x000000, 0.6);
    ctx.fillRect(pad, row2 - barH, barW, barH);
    ctx.fillStyle = css(c.pct > 0.5 ? 0x5cf2a0 : c.pct > 0.25 ? 0xffb347 : 0xff4f5e);
    ctx.fillRect(pad, row2 - barH, barW * c.pct, barH);
    if (c.shield > 0 && c.maxShield > 0) {
      ctx.fillStyle = rgba(0x9fd8ff, 0.9);
      ctx.fillRect(pad, row2 - barH - 3, barW * clamp(c.shield / c.maxShield, 0, 1), 2);
    }
    ctx.font = `600 ${Math.round(8 * s)}px ${UI_FONT}`;
    ctx.fillStyle = css(0x55667e);
    ctx.fillText(tr('hud.compact.coreLabel', 'CORE'), pad + barW + Math.round(6 * s), row2 - barH / 2);

    const p = game.player;
    const px = pad + barW + Math.round(44 * s);
    const pPct = clamp(p.hp / p.maxHp, 0, 1);
    ctx.fillStyle = rgba(0x000000, 0.6);
    ctx.fillRect(px, row2 - barH, barW * 0.7, barH);
    ctx.fillStyle = css(pPct > 0.4 ? 0x5cf2a0 : 0xff4f5e);
    ctx.fillRect(px, row2 - barH, barW * 0.7 * pPct, barH);
    // Heat rides directly under the health bar it constrains.
    ctx.fillStyle = rgba(0x000000, 0.6);
    ctx.fillRect(px, row2 + 2, barW * 0.7, 3);
    ctx.fillStyle = css(p.overheated ? 0xff4f5e : p.heat > 0.7 ? 0xffb347 : 0x7fd9ff);
    ctx.fillRect(px, row2 + 2, barW * 0.7 * p.heat, 3);

    // Auto-aim lock indicator: the player has no crosshair to read.
    if (game.autoTarget) {
      ctx.textAlign = 'left';
      ctx.font = `600 ${Math.round(9 * s)}px ${UI_FONT}`;
      ctx.fillStyle = css(0xff8090);
      ctx.fillText(tr('hud.compact.locked', '◎ LOCKED'), px + barW * 0.7 + Math.round(8 * s), row2 - barH / 2);
    }

    // Clock, tucked left of the pause button.
    ctx.textAlign = 'right';
    ctx.font = `500 ${Math.round(11 * s)}px ${MONO}`;
    ctx.fillStyle = css(0x8fa3c0);
    ctx.fillText(fmtTime(game.runStats.timeSeconds), w - Math.round(62 * s) - insetRight, row1);
  }

  /* ---- top resource strip ---------------------------------------------- */

  private topBar(ctx: Ctx, game: Game, w: number) {
    const { top: insetTop, right: insetRight, left: insetLeft } = this.insets;
    const H = 52 + insetTop;
    const grad = ctx.createLinearGradient(0, 0, 0, H + 16);
    grad.addColorStop(0, 'rgba(5,8,14,0.92)');
    grad.addColorStop(1, 'rgba(5,8,14,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, H + 16);

    ctx.strokeStyle = rgba(0x46d8ff, 0.16);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(w, H);
    ctx.stroke();

    let x = 24 + insetLeft;
    x = this.resource(ctx, x, H / 2, '◆', tr('hud.resources.ore', 'ORE'), fmtNum(game.ore), 0x7fd9ff);
    x = this.resource(ctx, x, H / 2, '✦', tr('hud.resources.essence', 'ESSENCE'), fmtNum(game.essence), 0xb47cff);

    // Power gauge, with a brownout warning.
    const pw = game.power;
    const eff = pw.efficiency;
    const powCol = eff >= 1 ? 0x5cf2a0 : eff > 0.6 ? 0xffb347 : 0xff4f5e;
    x = this.resource(ctx, x, H / 2, '⚡', tr('hud.resources.power', 'POWER'), `${Math.round(pw.draw)}/${Math.round(pw.supply)}`, powCol);
    if (eff < 1) {
      ctx.font = `600 10px ${UI_FONT}`;
      ctx.fillStyle = css(0xff4f5e);
      ctx.textAlign = 'left';
      ctx.fillText(tr('hud.topBar.brownout', 'BROWNOUT −{pct}%', { pct: Math.round((1 - eff) * 100) }), x - 8, H / 2 + 15);
    }

    // Level name, centred.
    ctx.textAlign = 'center';
    ctx.font = `600 15px ${UI_FONT}`;
    ctx.fillStyle = css(0xe7f0ff);
    ctx.fillText(levelName(game.level).toUpperCase(), w / 2, 18 + insetTop);
    ctx.font = `400 10px ${UI_FONT}`;
    ctx.fillStyle = css(0x8fa3c0);
    ctx.fillText(levelSubtitle(game.level).toUpperCase(), w / 2, 35 + insetTop);

    // Clock + achievement counter on the right.
    ctx.textAlign = 'right';
    ctx.font = `500 13px ${MONO}`;
    ctx.fillStyle = css(0x8fa3c0);
    ctx.fillText(fmtTime(game.runStats.timeSeconds), w - 24 - insetRight, 18 + insetTop);
    ctx.font = `500 11px ${UI_FONT}`;
    ctx.fillText(`🏆 ${game.progress.unlockedCount}/${game.progress.totalCount}`, w - 24 - insetRight, 35 + insetTop);
  }

  private resource(ctx: Ctx, x: number, y: number, glyph: string, label: string, value: string, color: number) {
    ctx.textAlign = 'left';
    ctx.font = `500 17px ${UI_FONT}`;
    ctx.fillStyle = css(color);
    ctx.fillText(glyph, x, y);
    ctx.font = `600 19px ${MONO}`;
    ctx.fillStyle = css(0xe7f0ff);
    ctx.fillText(value, x + 20, y - 3);
    const vw = ctx.measureText(value).width;
    ctx.font = `500 9px ${UI_FONT}`;
    ctx.fillStyle = css(0x55667e);
    ctx.fillText(label, x + 20, y + 12);
    return x + 20 + Math.max(vw, ctx.measureText(label).width) + 34;
  }

  /* ---- wave tracker ---------------------------------------------------- */

  private waveTracker(ctx: Ctx, game: Game, w: number) {
    const cx = w / 2;
    const s = this.compact ? this.uiScale : 1;
    const y = this.compact ? Math.round(14 * s) + this.insets.top : 66;
    const bw = this.compact ? Math.min(w * 0.42, 260 * s) : 360;

    const isPrep = game.inBuildPhase;
    const label = isPrep ? tr('hud.wave.nextAssault', 'NEXT ASSAULT') : game.waveLabel;
    const boss = game.phase === 'boss' || game.plan?.isBoss;

    ctx.textAlign = 'center';
    ctx.font = `600 12px ${UI_FONT}`;
    ctx.fillStyle = css(boss ? 0xff4f5e : isPrep ? 0x5cf2a0 : 0xffb347);
    ctx.fillText(label, cx, y);

    // Bar: build countdown, or kill progress in combat.
    const barY = y + 12;
    ctx.fillStyle = rgba(0x000000, 0.6);
    techRect(ctx, cx - bw / 2, barY, bw, 8, 3);
    ctx.fill();

    let t: number;
    let col: number;
    if (isPrep) {
      const total = game.waveIndex === 0 ? game.level.prepTime : game.level.buildTime;
      t = 1 - clamp(game.prepRemaining / total, 0, 1);
      col = 0x5cf2a0;
    } else {
      t = game.waveProgress;
      col = boss ? 0xff4f5e : 0xffb347;
    }
    ctx.fillStyle = css(col);
    techRect(ctx, cx - bw / 2, barY, Math.max(2, bw * t), 8, 3);
    ctx.fill();
    ctx.strokeStyle = rgba(col, 0.4);
    ctx.lineWidth = 1;
    techRect(ctx, cx - bw / 2, barY, bw, 8, 3);
    ctx.stroke();

    // Wave pips. In the campaign this is the whole level; in endless it is the
    // current run of ten waves leading up to the next boss.
    const pipY = barY + 18;
    const total = game.endless ? 10 : game.level.waves;
    const doneInBlock = game.endless ? game.waveIndex % 10 : game.waveIndex;
    const pw = Math.min(16, bw / total);
    for (let i = 0; i < total; i++) {
      const px = cx - (total * pw) / 2 + i * pw + pw / 2;
      const done = i < doneInBlock;
      const cur = i === doneInBlock;
      const isBossPip = i === total - 1;
      ctx.fillStyle = done ? css(0x5cf2a0)
        : cur ? css(isBossPip ? 0xff4f5e : 0xffb347)
        : rgba(isBossPip ? 0xff4f5e : 0xffffff, 0.18);
      if (isBossPip) {
        ctx.beginPath();
        ctx.moveTo(px, pipY - 5);
        ctx.lineTo(px + 4.5, pipY);
        ctx.lineTo(px, pipY + 5);
        ctx.lineTo(px - 4.5, pipY);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(px - pw * 0.32, pipY - 2.5, pw * 0.64, 5);
      }
    }

    ctx.font = `500 11px ${UI_FONT}`;
    ctx.fillStyle = css(0x8fa3c0);
    if (isPrep) {
      ctx.fillText(
        tr('hud.wave.prepCountdown', '{s}s   ·   SPACE to start early for bonus ore', { s: Math.ceil(game.prepRemaining) }),
        cx, pipY + 18,
      );
      const next = game.nextPlan;
      if (next) {
        ctx.font = `500 10px ${UI_FONT}`;
        ctx.fillStyle = css(0x55667e);
        ctx.fillText(game.describeWave(next).toUpperCase(), cx, pipY + 34);
      }
    } else {
      ctx.fillText(tr('hud.wave.hostilesRemaining', '{n} HOSTILES REMAINING', { n: game.remainingEnemies }), cx, pipY + 18);
    }

    if (game.endless) {
      const left = game.wavesUntilBoss;
      ctx.font = `600 10px ${UI_FONT}`;
      ctx.fillStyle = css(left === 0 ? 0xff4f5e : 0xffcc55);
      ctx.fillText(
        left === 0
          ? tr('hud.wave.bossWave', 'BOSS WAVE')
          : tr('hud.wave.bossIn', 'BOSS IN {n} WAVE{s}', { n: left, s: left === 1 ? '' : 'S' }),
        cx, pipY + (isPrep ? 50 : 34),
      );
    }
  }

  /* ---- build bar ------------------------------------------------------- */

  private buildBar(ctx: Ctx, game: Game, w: number, h: number) {
    this.buildSlots.length = 0;
    const kinds = game.availableBuildings;
    if (!kinds.length) return;

    // The roster grows as sectors unlock, so the bar shrinks to fit rather than
    // running under the minimap.
    const gap = 6;
    const budget = Math.max(240, w - 96);
    const slot = Math.max(40, Math.min(62, Math.floor((budget - (kinds.length - 1) * gap) / kinds.length)));
    const scale = slot / 62;
    const totalW = kinds.length * slot + (kinds.length - 1) * gap;
    const x0 = (w - totalW) / 2;
    const y0 = h - slot - 26 - this.insets.bottom;

    ctx.fillStyle = 'rgba(5,8,14,0.6)';
    ctx.fillRect(0, y0 - 14, w, slot + 40);

    kinds.forEach((kind, i) => {
      const def = BUILDINGS[kind];
      const x = x0 + i * (slot + gap);
      const cost = game.costOf(def);
      const affordable = game.ore >= cost.ore && game.essence >= cost.essence;
      const selected = game.buildKind === kind;

      this.buildSlots.push({ kind, x, y: y0, w: slot, h: slot });

      ctx.fillStyle = selected ? rgba(0x46d8ff, 0.22) : 'rgba(12,18,28,0.9)';
      techRect(ctx, x, y0, slot, slot, 8);
      ctx.fill();
      ctx.strokeStyle = selected ? css(0x46d8ff) : affordable ? rgba(0x46d8ff, 0.3) : rgba(0xff4f5e, 0.25);
      ctx.lineWidth = selected ? 2 : 1;
      techRect(ctx, x, y0, slot, slot, 8);
      ctx.stroke();

      ctx.globalAlpha = affordable ? 1 : 0.42;

      ctx.textAlign = 'center';
      ctx.font = `500 ${Math.round(24 * scale)}px ${UI_FONT}`;
      ctx.fillStyle = css(selected ? 0xffffff : 0xc8d4e2);
      ctx.fillText(def.glyph, x + slot / 2, y0 + slot * 0.39);

      ctx.font = `600 ${Math.max(7, Math.round(9 * scale))}px ${UI_FONT}`;
      ctx.fillStyle = css(0x8fa3c0);
      const nameCap = Math.max(6, Math.round(11 * scale));
      ctx.fillText(buildingName(def).toUpperCase().slice(0, nameCap), x + slot / 2, y0 + slot * 0.66);

      ctx.font = `600 ${Math.max(8, Math.round(10 * scale))}px ${MONO}`;
      ctx.fillStyle = css(game.ore >= cost.ore ? 0x7fd9ff : 0xff4f5e);
      const oreTxt = `${cost.ore}`;
      const costY = y0 + slot * 0.87;
      if (cost.essence > 0) {
        ctx.textAlign = 'right';
        ctx.fillText(oreTxt, x + slot / 2 - 2, costY);
        ctx.textAlign = 'left';
        ctx.fillStyle = css(game.essence >= cost.essence ? 0xb47cff : 0xff4f5e);
        ctx.fillText(`${cost.essence}`, x + slot / 2 + 4, costY);
      } else {
        ctx.fillText(oreTxt, x + slot / 2, costY);
      }

      ctx.globalAlpha = 1;

      // Hotkey pip.
      ctx.textAlign = 'left';
      ctx.font = `600 9px ${MONO}`;
      ctx.fillStyle = rgba(0xffffff, 0.4);
      ctx.fillText(def.hotkey, x + 5, y0 + 8);

      if (def.power !== 0) {
        ctx.textAlign = 'right';
        ctx.fillStyle = def.power < 0 ? rgba(0x5cf2a0, 0.8) : rgba(0xffb347, 0.7);
        ctx.fillText(`${def.power < 0 ? '+' : ''}${-def.power}`, x + slot - 5, y0 + 8);
      }
    });

    // Control legend.
    ctx.textAlign = 'center';
    ctx.font = `500 10px ${UI_FONT}`;
    ctx.fillStyle = css(0x55667e);
    const mode = game.cursorMode === 'sell' ? tr('hud.buildBar.legendSell', 'SELL MODE — click a structure   ·   Q to exit')
      : game.cursorMode === 'build' ? tr('hud.buildBar.legendBuild', 'LMB place   ·   RMB cancel   ·   E repair   ·   T targeting')
      : tr('hud.buildBar.legendNormal', 'WASD move   ·   LMB fire   ·   RMB mine   ·   SHIFT dash   ·   Q sell   ·   E repair   ·   TAB stats');
    ctx.fillText(mode, w / 2, h - 12 - this.insets.bottom);
  }

  /* ---- minimap --------------------------------------------------------- */

  /** Minimap visibility, toggled by the touch overview button. */
  showMinimap = true;

  private minimap(ctx: Ctx, game: Game, w: number, h: number) {
    if (this.compact && !this.showMinimap) return;
    const s = this.compact ? this.uiScale : 1;
    // On touch the bottom-right corner is the action cluster, so the map moves to
    // the top-right, under the pause and overview buttons.
    const size = this.compact ? Math.round(Math.min(118 * s, h * 0.28)) : 168;
    const pad = this.compact ? Math.round(12 * s) : 18;
    const x0 = w - size - pad - this.insets.right;
    const y0 = this.compact ? Math.round(104 * s) + this.insets.top : h - size - pad - this.insets.bottom;
    const world = game.world;
    const sx = size / world.pxW;
    const sy = size / world.pxH;

    ctx.fillStyle = 'rgba(4,7,12,0.88)';
    techRect(ctx, x0, y0, size, size, 10);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    techRect(ctx, x0, y0, size, size, 10);
    ctx.clip();

    // Rock silhouette, sampled every other tile to stay cheap.
    ctx.fillStyle = rgba(game.level.palette.rock, 0.95);
    const step = 2;
    const tw = TILE * sx * step;
    const th = TILE * sy * step;
    for (let ty = 0; ty < world.h; ty += step) {
      for (let tx = 0; tx < world.w; tx += step) {
        if (world.tiles[world.idx(tx, ty)] !== Tile.Rock) continue;
        ctx.fillRect(x0 + tx * TILE * sx, y0 + ty * TILE * sy, tw + 0.5, th + 0.5);
      }
    }

    // Ore.
    for (const n of world.nodes) {
      if (n.amount <= 0) continue;
      ctx.fillStyle = rgba(game.level.palette.oreColor, 0.9);
      ctx.fillRect(x0 + n.tx * TILE * sx - 1, y0 + n.ty * TILE * sy - 1, 3, 3);
    }

    // Structures.
    for (const b of game.buildings) {
      ctx.fillStyle = b.isTurret ? rgba(0x46d8ff, 0.9) : rgba(0x8fa3c0, 0.75);
      ctx.fillRect(x0 + (b.x - b.radius) * sx, y0 + (b.y - b.radius) * sy,
        Math.max(2, b.radius * 2 * sx), Math.max(2, b.radius * 2 * sy));
    }

    // Gates.
    for (const s of world.spawns) {
      ctx.fillStyle = rgba(0xff4f5e, 0.5 + s.heat * 0.5);
      ctx.beginPath();
      ctx.arc(x0 + s.x * sx, y0 + s.y * sy, 4, 0, TAU);
      ctx.fill();
    }

    // Core.
    ctx.fillStyle = css(0x7fd9ff);
    ctx.beginPath();
    ctx.arc(x0 + world.coreX * sx, y0 + world.coreY * sy, 4.5, 0, TAU);
    ctx.fill();

    // Enemies.
    for (const e of game.enemies) {
      if (e.submerged) continue;
      ctx.fillStyle = e.boss ? css(0xff4f5e) : e.elite ? css(0xffcc55) : rgba(0xff8090, 0.9);
      const r = e.boss ? 5 : 2;
      ctx.beginPath();
      ctx.arc(x0 + e.x * sx, y0 + e.y * sy, r, 0, TAU);
      ctx.fill();
    }

    // Drones — small, distinct from structures, so losses are visible.
    for (const d of game.drones) {
      if (d.dead) continue;
      ctx.fillStyle = rgba(0x9fe8ff, 0.95);
      ctx.beginPath();
      ctx.arc(x0 + d.x * sx, y0 + d.y * sy, 1.6, 0, TAU);
      ctx.fill();
    }

    // Player + view frustum.
    ctx.fillStyle = css(0xffffff);
    ctx.beginPath();
    ctx.arc(x0 + game.player.x * sx, y0 + game.player.y * sy, 3, 0, TAU);
    ctx.fill();

    const vw = (w / game.camera.zoom) * sx;
    const vh = (h / game.camera.zoom) * sy;
    ctx.strokeStyle = rgba(0xffffff, 0.28);
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + game.camera.x * sx - vw / 2, y0 + game.camera.y * sy - vh / 2, vw, vh);

    ctx.restore();

    ctx.strokeStyle = rgba(0x46d8ff, 0.28);
    ctx.lineWidth = 1;
    techRect(ctx, x0, y0, size, size, 10);
    ctx.stroke();
  }

  /* ---- left status rail ------------------------------------------------ */

  private statusRail(ctx: Ctx, game: Game, w: number, h: number) {
    const x = 22 + this.insets.left;
    let y = h - 210 - this.insets.bottom;
    void w;

    // Core integrity.
    const c = game.core;
    ctx.textAlign = 'left';
    ctx.font = `500 9px ${UI_FONT}`;
    ctx.fillStyle = css(0x55667e);
    ctx.fillText(tr('hud.rail.coreIntegrity', 'CORE INTEGRITY'), x, y);
    y += 12;
    const bw = 178;
    ctx.fillStyle = rgba(0x000000, 0.6);
    ctx.fillRect(x, y, bw, 12);
    const pct = c.pct;
    ctx.fillStyle = css(pct > 0.5 ? 0x5cf2a0 : pct > 0.25 ? 0xffb347 : 0xff4f5e);
    ctx.fillRect(x, y, bw * pct, 12);
    if (c.shield > 0 && c.maxShield > 0) {
      ctx.fillStyle = rgba(0x9fd8ff, 0.85);
      ctx.fillRect(x, y - 4, bw * (c.shield / c.maxShield), 3);
    }
    ctx.strokeStyle = rgba(0xffffff, 0.15);
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, bw, 12);
    ctx.font = `600 10px ${MONO}`;
    ctx.fillStyle = css(0xe7f0ff);
    ctx.fillText(`${Math.ceil(c.hp)} / ${c.maxHp}`, x + 4, y + 6);
    y += 26;

    // Chassis.
    const p = game.player;
    ctx.font = `500 9px ${UI_FONT}`;
    ctx.fillStyle = css(0x55667e);
    ctx.fillText(tr('hud.rail.chassis', 'CHASSIS'), x, y);
    y += 12;
    ctx.fillStyle = rgba(0x000000, 0.6);
    ctx.fillRect(x, y, bw, 9);
    ctx.fillStyle = css(p.hp / p.maxHp > 0.4 ? 0x5cf2a0 : 0xff4f5e);
    ctx.fillRect(x, y, bw * clamp(p.hp / p.maxHp, 0, 1), 9);
    ctx.strokeStyle = rgba(0xffffff, 0.15);
    ctx.strokeRect(x, y, bw, 9);
    y += 20;

    // Heat.
    ctx.font = `500 9px ${UI_FONT}`;
    ctx.fillStyle = css(p.overheated ? 0xff4f5e : 0x55667e);
    ctx.fillText(p.overheated ? tr('hud.rail.overheated', 'WEAPON OVERHEATED') : tr('hud.rail.heat', 'HEAT'), x, y);
    y += 10;
    ctx.fillStyle = rgba(0x000000, 0.6);
    ctx.fillRect(x, y, bw, 5);
    ctx.fillStyle = css(p.overheated ? 0xff4f5e : p.heat > 0.7 ? 0xffb347 : 0x7fd9ff);
    ctx.fillRect(x, y, bw * p.heat, 5);
    y += 18;

    // Dash readiness.
    const dashReady = p.dashCooldown <= 0;
    ctx.font = `500 9px ${UI_FONT}`;
    ctx.fillStyle = css(dashReady ? 0x5cf2a0 : 0x55667e);
    ctx.fillText(dashReady ? tr('hud.rail.dashReady', 'DASH READY  [SHIFT]') : tr('hud.rail.dashRecharging', 'DASH RECHARGING'), x, y);
    y += 10;
    ctx.fillStyle = rgba(0x000000, 0.6);
    ctx.fillRect(x, y, bw, 4);
    ctx.fillStyle = css(dashReady ? 0x5cf2a0 : 0x2f5680);
    ctx.fillRect(x, y, bw * (dashReady ? 1 : 1 - p.dashCooldown / 1.35), 4);
    y += 20;

    // Active tech.
    if (game.techTaken.length) {
      ctx.font = `500 9px ${UI_FONT}`;
      ctx.fillStyle = css(0x55667e);
      ctx.fillText(tr('hud.rail.techCount', 'TECH  ×{n}', { n: game.techTaken.length }), x, y);
    }
  }

  /* ---- boss bar -------------------------------------------------------- */

  private bossBar(ctx: Ctx, game: Game, w: number) {
    const e = game.bossRef!;
    const bw = this.compact ? Math.min(420, w - 220) : Math.min(760, w - 200);
    const x = (w - bw) / 2;
    const y = this.compact ? Math.round(76 * this.uiScale) + this.insets.top : 132;

    ctx.textAlign = 'center';
    ctx.font = `700 20px ${UI_FONT}`;
    ctx.fillStyle = css(0xff4f5e);
    ctx.fillText(enemyName(e.def), w / 2, y - 14);

    ctx.fillStyle = rgba(0x000000, 0.72);
    techRect(ctx, x, y, bw, 16, 6);
    ctx.fill();

    const pct = clamp(e.hp / e.maxHp, 0, 1);
    const g = ctx.createLinearGradient(x, 0, x + bw, 0);
    g.addColorStop(0, '#8c1f2f');
    g.addColorStop(0.5, '#ff4f5e');
    g.addColorStop(1, '#ff8a5c');
    ctx.fillStyle = g;
    techRect(ctx, x, y, Math.max(3, bw * pct), 16, 6);
    ctx.fill();

    if (e.shieldHp > 0 && e.shieldMax > 0) {
      ctx.fillStyle = rgba(0x9fd8ff, 0.9);
      ctx.fillRect(x, y - 6, bw * clamp(e.shieldHp / e.shieldMax, 0, 1), 4);
    }

    // Phase notches every 25%.
    ctx.strokeStyle = rgba(0x000000, 0.6);
    ctx.lineWidth = 2;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(x + (bw * i) / 4, y);
      ctx.lineTo(x + (bw * i) / 4, y + 16);
      ctx.stroke();
    }

    ctx.strokeStyle = rgba(0xff4f5e, 0.5);
    ctx.lineWidth = 1;
    techRect(ctx, x, y, bw, 16, 6);
    ctx.stroke();

    ctx.font = `600 11px ${MONO}`;
    ctx.fillStyle = css(0xffffff);
    ctx.fillText(`${fmtNum(Math.ceil(e.hp))} / ${fmtNum(e.maxHp)}`, w / 2, y + 8);

    if (e.castingIndex >= 0) {
      const ab = e.def.abilities![e.castingIndex];
      ctx.font = `600 11px ${UI_FONT}`;
      ctx.fillStyle = css(0xffb347);
      ctx.fillText(tr('hud.boss.abilityIncoming', '⚠  {ability} INCOMING', { ability: ab.id.toUpperCase() }), w / 2, y + 30);
    }
  }

  /* ---- tooltip --------------------------------------------------------- */

  private tooltip(ctx: Ctx, game: Game, w: number, h: number) {
    let title = '';
    let lines: string[] = [];

    if (game.cursorMode === 'build' && game.buildKind) {
      const d = BUILDINGS[game.buildKind];
      const cost = game.costOf(d);
      title = buildingName(d);
      lines = [buildingDesc(d)];
      const stats: string[] = [cost.essence
        ? tr('hud.tooltip.costOreEssence', '{ore} ore · {essence} essence', { ore: cost.ore, essence: cost.essence })
        : tr('hud.tooltip.costOre', '{ore} ore', { ore: cost.ore })];
      if (d.power) stats.push(d.power < 0
        ? tr('hud.tooltip.powerSupply', '+{n} power', { n: -d.power })
        : tr('hud.tooltip.powerDraw', '{n} power draw', { n: d.power }));
      if (d.damage) stats.push(tr('hud.tooltip.dmg', '{n} dmg', { n: Math.round(d.damage * game.perks.turretDamage) }));
      if (d.fireRate) stats.push(tr('hud.tooltip.fireRate', '{n}/s', { n: (d.fireRate * game.perks.turretFireRate).toFixed(1) }));
      if (d.range) stats.push(tr('hud.tooltip.range', '{n} range', { n: Math.round(d.range * game.perks.turretRange) }));
      if (d.splash) stats.push(tr('hud.tooltip.splash', '{n} splash', { n: d.splash }));
      if (d.chains) stats.push(tr('hud.tooltip.chains', '{n} chain', { n: d.chains }));
      if (d.beam) stats.push(d.pierce && d.pierce > 1
        ? tr('hud.tooltip.beamPierces', 'beam · pierces {n}', { n: d.pierce })
        : tr('hud.tooltip.beamNeverMisses', 'beam · never misses'));
      if (d.homing) stats.push(tr('hud.tooltip.guided', 'guided'));
      if (d.armorPierce === 999) stats.push(tr('hud.tooltip.ignoresArmour', 'ignores armour'));
      else if (d.armorPierce) stats.push(tr('hud.tooltip.armourPierce', '{n} armour pierce', { n: d.armorPierce }));
      if (d.burst && d.burst > 1) stats.push(tr('hud.tooltip.burst', '{n}-round burst', { n: d.burst }));
      if (d.minRange) stats.push(tr('hud.tooltip.minRange', 'min range {n}', { n: d.minRange }));
      if (d.antiAir) stats.push(tr('hud.tooltip.antiAir', 'anti-air'));
      if (d.groundOnly) stats.push(tr('hud.tooltip.groundOnly', 'ground only'));
      if (d.droneSlots) {
        stats.push(tr('hud.tooltip.droneSlots', '{n} drones', { n: d.droneSlots }));
        stats.push(tr('hud.tooltip.droneRate', '{n}/s each', { n: (d.droneMineRate! * game.perks.extractorRate).toFixed(1) }));
        stats.push(tr('hud.tooltip.droneCargo', '{n} cargo', { n: d.droneCargo ?? 0 }));
      }
      stats.push(tr('hud.tooltip.hp', '{n} hp', { n: Math.round(d.hp * game.perks.structureHp) }));
      lines.push(stats.join('   ·   '));
      if (!game.buildValid && game.lastError.life > 0) lines.push(`⚠ ${game.lastError.text}`);
    } else if (game.hoverBuilding) {
      const b = game.hoverBuilding;
      title = buildingName(b.def);
      lines = [tr('hud.tooltip.hpShort', '{cur} / {max} HP', { cur: Math.ceil(b.hp), max: b.maxHp })
        + (b.shield > 0 ? tr('hud.tooltip.shieldInline', '  ·  {n} shield', { n: Math.ceil(b.shield) }) : '')];
      if (b.isTurret) {
        lines.push(tr('hud.tooltip.targeting', 'Targeting: {mode}  (T to cycle)  ·  {kills} kills',
          { mode: targetingLabel(b.targeting), kills: b.kills }));
      }
      if (b.def.droneSlots !== undefined) {
        const { live, slots } = game.droneCount(b);
        lines.push(tr('hud.tooltip.drones', 'Drones: {live} / {slots}', { live, slots })
          + (live < slots
            ? tr('hud.tooltip.dronesRebuilding', '  ·  rebuilding in {s}s', { s: Math.ceil(b.droneCooldown) })
            : tr('hud.tooltip.dronesFull', '  ·  full complement')));
      }
      if (b.def.power > 0 && b.efficiency < 1) {
        lines.push(tr('hud.tooltip.underpowered', '⚠ Underpowered — firing at {pct}%', { pct: Math.round(b.efficiency * 100) }));
      }
      if (!b.built) lines.push(tr('hud.tooltip.constructing', 'Constructing… {pct}%', { pct: Math.round(b.progress * 100) }));
      lines.push(tr('hud.tooltip.repairSell', 'E to repair  ·  Q then click to sell'));
    } else if (game.hoverNode) {
      const n = game.hoverNode;
      title = n.rich ? tr('hud.tooltip.richOreSeam', 'Rich Ore Seam') : tr('hud.tooltip.oreSeam', 'Ore Seam');
      lines = [
        tr('hud.tooltip.oreRemaining', '{cur} / {max} ore remaining', { cur: Math.ceil(n.amount), max: n.max }),
        n.claimedBy >= 0
          ? tr('hud.tooltip.extractorAttached', 'Extractor attached')
          : tr('hud.tooltip.mineHint', 'Hold RMB nearby to mine, or build an Extractor'),
      ];
    } else {
      return;
    }

    // Panel, anchored near the cursor but clamped on screen.
    ctx.font = `500 12px ${UI_FONT}`;
    let tw = ctx.measureText(title).width;
    for (const l of lines) tw = Math.max(tw, ctx.measureText(l).width);
    const pad = 12;
    const bw = tw + pad * 2;
    const bh = 26 + lines.length * 17 + pad;
    const mx = clamp(this.lastMouse.x + 20, 10, w - bw - 10);
    const my = clamp(this.lastMouse.y + 20, 10, h - bh - 10);

    ctx.fillStyle = 'rgba(6,10,18,0.94)';
    techRect(ctx, mx, my, bw, bh, 9);
    ctx.fill();
    ctx.strokeStyle = rgba(0x46d8ff, 0.35);
    ctx.lineWidth = 1;
    techRect(ctx, mx, my, bw, bh, 9);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = `600 13px ${UI_FONT}`;
    ctx.fillStyle = css(0xe7f0ff);
    ctx.fillText(title.toUpperCase(), mx + pad, my + pad + 7);
    ctx.font = `400 11px ${UI_FONT}`;
    lines.forEach((l, i) => {
      ctx.fillStyle = l.startsWith('⚠') ? css(0xffb347) : css(0x8fa3c0);
      ctx.fillText(l, mx + pad, my + pad + 28 + i * 17);
    });
  }

  lastMouse = { x: 0, y: 0 };

  /* ---- banner ---------------------------------------------------------- */

  private banner(ctx: Ctx, game: Game, w: number, h: number) {
    const b = game.banner;
    if (!b) return;
    const t = b.life / b.maxLife;
    // Fade in over the first 15%, hold, fade out over the last 30%.
    const alpha = t > 0.85 ? (1 - t) / 0.15 : t < 0.3 ? t / 0.3 : 1;
    const y = this.compact ? h * 0.36 : h * 0.3;

    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.textAlign = 'center';

    ctx.fillStyle = 'rgba(4,7,12,0.55)';
    ctx.fillRect(0, y - 42, w, 84);
    ctx.strokeStyle = b.color;
    ctx.globalAlpha = clamp(alpha, 0, 1) * 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y - 42); ctx.lineTo(w, y - 42);
    ctx.moveTo(0, y + 42); ctx.lineTo(w, y + 42);
    ctx.stroke();
    ctx.globalAlpha = clamp(alpha, 0, 1);

    ctx.font = `700 40px ${UI_FONT}`;
    ctx.fillStyle = b.color;
    ctx.fillText(b.title, w / 2, y - 8);
    ctx.font = `500 13px ${UI_FONT}`;
    ctx.fillStyle = css(0xc8d4e2);
    ctx.fillText(b.sub, w / 2, y + 22);
    ctx.restore();
  }

  private crosshair(ctx: Ctx, game: Game) {
    const { x, y } = this.lastMouse;
    const build = game.cursorMode !== 'normal';
    const col = game.cursorMode === 'sell' ? 0xff4f5e : build ? 0x46d8ff : 0xffffff;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = rgba(col, 0.9);
    ctx.lineWidth = 1.5;
    if (build) {
      ctx.strokeRect(-9, -9, 18, 18);
    } else {
      const spread = 5 + game.player.recoil * 5;
      ctx.beginPath();
      for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        ctx.moveTo(Math.cos(a) * spread, Math.sin(a) * spread);
        ctx.lineTo(Math.cos(a) * (spread + 6), Math.sin(a) * (spread + 6));
      }
      ctx.stroke();
      ctx.fillStyle = rgba(col, 0.9);
      ctx.fillRect(-1, -1, 2, 2);
    }
    ctx.restore();
  }

  private errorToast(ctx: Ctx, game: Game, w: number, h: number) {
    if (game.lastError.life <= 0) return;
    const a = clamp(game.lastError.life / 1.6, 0, 1);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.font = `600 13px ${UI_FONT}`;
    const txt = game.lastError.text.toUpperCase();
    const tw = ctx.measureText(txt).width;
    const y = h - 132;
    ctx.fillStyle = 'rgba(30,6,10,0.92)';
    techRect(ctx, w / 2 - tw / 2 - 16, y - 14, tw + 32, 28, 8);
    ctx.fill();
    ctx.strokeStyle = rgba(0xff4f5e, 0.6);
    ctx.lineWidth = 1;
    techRect(ctx, w / 2 - tw / 2 - 16, y - 14, tw + 32, 28, 8);
    ctx.stroke();
    ctx.fillStyle = css(0xff8090);
    ctx.fillText(txt, w / 2, y);
    ctx.restore();
  }

  /** TAB overlay: run stats + wave preview. */
  showStats = false;

  private debug(ctx: Ctx, game: Game, w: number, h: number, fps: number) {
    if (!this.showStats) return;
    const pad = 20;
    const bw = 330;
    const x = w / 2 - bw / 2;
    const y = h / 2 - 190;

    ctx.fillStyle = 'rgba(4,7,12,0.94)';
    techRect(ctx, x, y, bw, 380, 12);
    ctx.fill();
    ctx.strokeStyle = rgba(0x46d8ff, 0.3);
    ctx.lineWidth = 1;
    techRect(ctx, x, y, bw, 380, 12);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = `700 14px ${UI_FONT}`;
    ctx.fillStyle = css(0x46d8ff);
    ctx.fillText(tr('hud.telemetry.title', 'RUN TELEMETRY'), x + pad, y + 26);

    const rows: [string, string][] = [
      [tr('hud.telemetry.wave', 'Wave'), `${game.waveIndex + 1} / ${game.level.waves}`],
      [tr('hud.telemetry.kills', 'Kills'), fmtNum(game.runStats.kills)],
      [tr('hud.telemetry.damageDealt', 'Damage dealt'), fmtNum(Math.round(game.runStats.damage))],
      [tr('hud.telemetry.oreMined', 'Ore mined'), fmtNum(Math.round(game.runStats.oreMined))],
      [tr('hud.telemetry.essence', 'Essence'), fmtNum(Math.round(game.runStats.essenceCollected))],
      [tr('hud.telemetry.structuresBuilt', 'Structures built'), String(game.runStats.built)],
      [tr('hud.telemetry.structuresLost', 'Structures lost'), String(game.runStats.structuresLost)],
      [tr('hud.telemetry.coreDamageTaken', 'Core damage taken'), fmtNum(Math.round(game.runStats.coreDamage))],
      [tr('hud.telemetry.powerDrawSupply', 'Power draw / supply'), `${Math.round(game.power.draw)} / ${Math.round(game.power.supply)}`],
      [tr('hud.telemetry.techAcquired', 'Tech acquired'), String(game.techTaken.length)],
      [tr('hud.telemetry.elapsed', 'Elapsed'), fmtTime(game.runStats.timeSeconds)],
      [tr('hud.telemetry.entities', 'Entities'), tr('hud.telemetry.entitiesValue', '{e}e {b}b {p}p',
        { e: game.enemies.length, b: game.buildings.length, p: game.particles.count })],
      [tr('hud.telemetry.fps', 'FPS'), String(Math.round(fps))],
    ];

    ctx.font = `400 12px ${UI_FONT}`;
    rows.forEach((r, i) => {
      const ry = y + 52 + i * 20;
      ctx.fillStyle = css(0x8fa3c0);
      ctx.fillText(r[0], x + pad, ry);
      ctx.textAlign = 'right';
      ctx.fillStyle = css(0xe7f0ff);
      ctx.font = `500 12px ${MONO}`;
      ctx.fillText(r[1], x + bw - pad, ry);
      ctx.textAlign = 'left';
      ctx.font = `400 12px ${UI_FONT}`;
    });

    // Next wave composition.
    const next = game.nextPlan ?? game.plan;
    if (next) {
      ctx.font = `700 11px ${UI_FONT}`;
      ctx.fillStyle = css(0xffb347);
      ctx.fillText(tr('hud.telemetry.nextWave', 'NEXT WAVE'), x + pad, y + 326);
      ctx.font = `400 11px ${UI_FONT}`;
      ctx.fillStyle = css(0x8fa3c0);
      next.composition.slice(0, 3).forEach((c, i) => {
        const enemyDef = ENEMIES[c.id];
        ctx.fillText(
          tr('hud.telemetry.waveComposition', '{count}× {name}', { count: c.count, name: enemyDef ? enemyName(enemyDef) : c.id }),
          x + pad, y + 346 + i * 15,
        );
      });
    }
  }
}
