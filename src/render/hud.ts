import { clamp, fmtNum, fmtTime, TAU } from '../core/math';
import { buildingStats } from './buildingInfo';
import { branchEffect, branchName } from '../data/upgrades';
import { t as tr } from '../core/i18n';
import {
  BUILDINGS, CATEGORY_KEY, buildCategoryLabel, buildingDesc, buildingName,
  type BuildCategory, type BuildingKind, type TargetingMode,
} from '../data/buildings';
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
/** A horizontal lane for transient touch hints: x-extent and top edge, CSS px. */
export interface HintLane {
  left: number;
  right: number;
  top: number;
}

/**
 * Which lane a hint of `textW` px goes in: the narrow one beside the minimap
 * when it fits at full size, otherwise the full-width one under the minimap —
 * moving a long hint down beats shrinking it to an unreadable size. With no
 * wide lane (minimap hidden, landscape) the narrow one is already full width.
 */
export function pickHintLane(textW: number, narrow: HintLane, wide: HintLane | null): HintLane {
  return !wide || textW + 32 <= narrow.right - narrow.left ? narrow : wide;
}

/**
 * Top edge for a hint box of height `h` whose preferred top is `top`: pushed
 * just below `band` (the sector/wave banner) if it would overlap it.
 */
export function clearOfBand(top: number, h: number, band: { top: number; bottom: number } | null, gap = 6): number {
  if (!band || top + h <= band.top || top >= band.bottom) return top;
  return band.bottom + gap;
}

/** Smallest HUD font on touch, in CSS px before UI scale. */
const TOUCH_MIN_FONT = 11;

export class Hud {
  /** Build-bar hit rectangles, refreshed each frame for click routing. */
  buildSlots: { kind: BuildingKind; x: number; y: number; w: number; h: number }[] = [];
  /** Section-tab hit rectangles, same contract as buildSlots. */
  categoryTabs: { category: BuildCategory; x: number; y: number; w: number; h: number }[] = [];
  /** Compact layout for touch: no build bar, no cursor chrome, thumb zones clear. */
  compact = false;
  /** Extra scale for text and gauges, from the UI scale setting. */
  uiScale = 1;
  /** Notch/Dynamic Island/home-indicator clearance, so corner readouts clear the cutout. */
  insets: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Touch, taller than wide: the top readouts stack into rows instead of sharing one. */
  private portrait = false;
  /** Bottom edge of the top HUD stack this frame (touch), in CSS px. */
  topClear = 0;
  /**
   * Where transient touch hints (placement, mining, errors, coach) may go:
   * below the top HUD and, in portrait, left of the minimap. Refreshed every
   * frame; TouchHud and the coach read it rather than guessing a y offset.
   */
  hintArea: HintLane = { left: 12, right: 363, top: 100 };
  /** Full-width lane under the minimap, for hints too long for `hintArea`; null when not needed. */
  hintAreaWide: HintLane | null = null;
  /**
   * Screen band the phase/sector banner occupies this frame, or null. Hints
   * in the lane under the minimap drop below it instead of covering it.
   */
  bannerBand: { top: number; bottom: number } | null = null;

  /**
   * Font size in px. Desktop gets `px` as authored. Touch scales it with the
   * UI-scale setting and never goes below TOUCH_MIN_FONT — 8-10 px labels are
   * fine on a monitor at arm's length and unreadable on a phone.
   */
  private fs(px: number) {
    return this.compact ? Math.round(Math.max(px, TOUCH_MIN_FONT) * this.uiScale) : px;
  }

  /** Spacing multiplier: UI scale on touch, 1 on desktop. */
  private get k() { return this.compact ? this.uiScale : 1; }

  /** Top strip's left content end / clock start, from the last compactTopBar. */
  private stripLeftEnd = 0;
  private stripClockLeft = 0;

  /**
   * Width a wave tracker centred in the top strip's row would have between
   * the strip's left block and the clock (landscape touch).
   */
  private trackerRoom(w: number) {
    return 2 * Math.min(w / 2 - this.stripLeftEnd, this.stripClockLeft - w / 2) - Math.round(24 * this.k);
  }

  /** Right edge of the top strip on touch: the speed + pause buttons own the corner. */
  private stripRight(w: number) {
    return w - Math.round(110 * this.uiScale) - this.insets.right;
  }

  /**
   * `measureText` result cache. Most text here is either genuinely static
   * (category labels, per-locale strings) or a number that only changes when
   * the underlying resource does, so re-measuring the same (font, text) pair
   * every frame is pure waste — keyed on font since size/weight affects width.
   */
  private measureCache = new Map<string, number>();

  private measure(ctx: Ctx, text: string): number {
    const key = ctx.font + '|' + text;
    let w = this.measureCache.get(key);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      if (this.measureCache.size < 2000) this.measureCache.set(key, w);
    }
    return w;
  }

  draw(ctx: Ctx, game: Game, w: number, h: number, fps: number) {
    ctx.save();
    ctx.textBaseline = 'middle';

    if (this.compact) {
      // Touch: the bottom third belongs to the thumbs, so every readout moves up
      // and the build bar is replaced by the drawer in TouchHud. Portrait
      // stacks the readouts top-down; each block returns its bottom edge.
      this.portrait = h > w;
      let y = this.compactTopBar(ctx, game, w);
      // Landscape shares the strip's row with the tracker when there's room
      // between its left block and the clock; otherwise (portrait, or a large
      // UI scale) the tracker stacks under the strip.
      const inline = !this.portrait && this.trackerRoom(w) >= 180 * this.uiScale;
      y = Math.max(y, this.waveTracker(ctx, game, w, inline ? 0 : y));
      if (game.bossRef) y = this.bossBar(ctx, game, w, y);
      this.topClear = y;
      const map = this.minimap(ctx, game, w, h);
      const s = this.uiScale;
      const left = Math.round(12 * s) + this.insets.left;
      const fullRight = w - Math.round(12 * s) - this.insets.right;
      const beside = this.portrait && map !== null;
      this.hintArea = {
        left,
        right: beside ? map.left - Math.round(8 * s) : fullRight,
        top: y + Math.round(6 * s),
      };
      this.hintAreaWide = beside ? { left, right: fullRight, top: map.bottom + Math.round(8 * s) } : null;
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
  private compactTopBar(ctx: Ctx, game: Game, w: number): number {
    const s = this.uiScale;
    const { top: insetTop, left: insetLeft } = this.insets;
    const portrait = this.portrait;
    const right = this.stripRight(w);
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
    const row1 = Math.round(16 * s) + insetTop;
    const row2 = Math.round(38 * s) + insetTop;

    // Resources on one line, glyph + value only — labels do not survive the space.
    ctx.textAlign = 'left';
    ctx.font = `600 ${this.fs(13)}px ${MONO}`;
    ctx.fillStyle = css(0x7fd9ff);
    ctx.fillText(`◆${fmtNum(game.ore)}`, x, row1);
    x += this.measure(ctx, `◆${fmtNum(game.ore)}`) + Math.round(12 * s);
    ctx.fillStyle = css(0xb47cff);
    ctx.fillText(`✦${fmtNum(game.essence)}`, x, row1);
    x += this.measure(ctx, `✦${fmtNum(game.essence)}`) + Math.round(12 * s);

    const eff = game.power.efficiency;
    ctx.fillStyle = css(eff >= 1 ? 0x5cf2a0 : eff > 0.6 ? 0xffb347 : 0xff4f5e);
    const powerText = `⚡${Math.round(game.power.draw)}/${Math.round(game.power.supply)}`;
    ctx.fillText(powerText, x, row1);
    const resourcesEnd = x + this.measure(ctx, powerText);

    // Clock, tucked left of the pause button.
    ctx.textAlign = 'right';
    ctx.font = `500 ${this.fs(11)}px ${MONO}`;
    ctx.fillStyle = css(0x8fa3c0);
    const clock = fmtTime(game.runStats.timeSeconds);
    ctx.fillText(clock, right, row1);
    const clockLeft = right - this.measure(ctx, clock);

    // Core + chassis bars. Landscape: short, with the wave tracker centred
    // between them and the clock. Portrait: nothing else shares the row, so
    // they span the strip.
    const barH = Math.round(7 * s);
    const labelFont = `600 ${this.fs(9)}px ${UI_FONT}`;
    ctx.font = labelFont;
    // Both bars are labelled: they share a colour scheme, and the player's
    // own health read as a second core bar. Same word as the desktop rail.
    const coreLabel = tr('hud.compact.coreLabel', 'CORE');
    const chassisLabel = tr('hud.rail.chassis', 'CHASSIS');
    const labelW = this.measure(ctx, coreLabel);
    const chassisW = this.measure(ctx, chassisLabel);
    const gap = Math.round(6 * s);
    const between = Math.round(14 * s);
    let coreX: number, coreW: number, px: number, pW: number;
    if (portrait) {
      // CORE [core bar]   CHASSIS [chassis bar]
      coreX = pad + labelW + gap;
      const barsW = right - coreX - between - chassisW - gap;
      coreW = barsW * 0.58;
      px = coreX + coreW + between + chassisW + gap;
      pW = barsW - coreW;
    } else {
      // [core bar] CORE   [chassis bar] CHASSIS
      coreX = pad;
      coreW = Math.round(120 * s);
      px = coreX + coreW + gap + labelW + Math.round(12 * s);
      pW = coreW * 0.7;
    }

    const c = game.core;
    ctx.fillStyle = rgba(0x000000, 0.6);
    ctx.fillRect(coreX, row2 - barH, coreW, barH);
    ctx.fillStyle = css(c.pct > 0.5 ? 0x5cf2a0 : c.pct > 0.25 ? 0xffb347 : 0xff4f5e);
    ctx.fillRect(coreX, row2 - barH, coreW * c.pct, barH);
    if (c.shield > 0 && c.maxShield > 0) {
      ctx.fillStyle = rgba(0x9fd8ff, 0.9);
      ctx.fillRect(coreX, row2 - barH - 3, coreW * clamp(c.shield / c.maxShield, 0, 1), 2);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = css(0x55667e);
    ctx.fillText(coreLabel, portrait ? pad : coreX + coreW + gap, row2 - barH / 2);

    ctx.fillText(chassisLabel, portrait ? px - gap - chassisW : px + pW + gap, row2 - barH / 2);

    const p = game.player;
    const pPct = clamp(p.hp / p.maxHp, 0, 1);
    ctx.fillStyle = rgba(0x000000, 0.6);
    ctx.fillRect(px, row2 - barH, pW, barH);
    ctx.fillStyle = css(pPct > 0.4 ? 0x5cf2a0 : 0xff4f5e);
    ctx.fillRect(px, row2 - barH, pW * pPct, barH);
    // Heat rides directly under the health bar it constrains.
    const heatH = Math.max(3, Math.round(3 * s));
    ctx.fillStyle = rgba(0x000000, 0.6);
    ctx.fillRect(px, row2 + 2, pW, heatH);
    ctx.fillStyle = css(p.overheated ? 0xff4f5e : p.heat > 0.7 ? 0xffb347 : 0x7fd9ff);
    ctx.fillRect(px, row2 + 2, pW * p.heat, heatH);

    // Auto-aim lock indicator: the player has no crosshair to read. Portrait
    // has no room after the bars, so it sits on the resource row by the clock.
    ctx.font = labelFont;
    const locked = tr('hud.compact.locked', '◎ LOCKED');
    const lockedX = px + pW + gap + chassisW + Math.round(10 * s);
    // Where this strip's left-hand content ends and the clock begins, so a
    // wave tracker sharing the row (landscape) knows its room. The lock
    // indicator's slot is reserved even when hidden, or the tracker would
    // jump every time a target is acquired.
    this.stripLeftEnd = portrait ? right : Math.max(resourcesEnd, lockedX + this.measure(ctx, locked));
    this.stripClockLeft = clockLeft;
    if (game.autoTarget) {
      ctx.fillStyle = css(0xff8090);
      if (portrait) {
        ctx.textAlign = 'right';
        ctx.fillText(locked, clockLeft - Math.round(10 * s), row1);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(locked, lockedX, row2 - barH / 2);
      }
    }
    return row2 + 2 + heatH;
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
    const clock = fmtTime(game.runStats.timeSeconds);
    ctx.fillText(clock, w - 24 - insetRight, 18 + insetTop);
    const clockW = this.measure(ctx, clock);
    // Fast-forward indicator (R toggles it).
    const speedText = game.speed > 1
      ? tr('hud.topBar.fastForward', '▶▶ ×2  [R]')
      : tr('hud.topBar.normalSpeed', '×1  [R]');
    ctx.font = `600 11px ${UI_FONT}`;
    ctx.fillStyle = css(game.speed > 1 ? 0xffcc55 : 0x55667e);
    ctx.fillText(speedText, w - 24 - insetRight - clockW - 18, 18 + insetTop);
    ctx.fillStyle = css(0x8fa3c0);
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
    const vw = this.measure(ctx, value);
    ctx.font = `500 9px ${UI_FONT}`;
    ctx.fillStyle = css(0x55667e);
    ctx.fillText(label, x + 20, y + 12);
    return x + 20 + Math.max(vw, this.measure(ctx, label)) + 34;
  }

  /* ---- wave tracker ---------------------------------------------------- */

  /**
   * Wave label, progress bar, pips and the countdown / hostiles line. Returns
   * its bottom edge. `top` > 0 stacks it under the strip (portrait touch);
   * otherwise it sits in its usual spot.
   */
  private waveTracker(ctx: Ctx, game: Game, w: number, top = 0): number {
    const k = this.k;
    const stacked = this.compact && top > 0;
    const pad = Math.round(14 * k) + this.insets.left;
    const right = this.stripRight(w);
    const cx = stacked ? (pad + right) / 2 : w / 2;
    const y = stacked ? top + Math.round(14 * k)
      : this.compact ? Math.round(14 * k) + this.insets.top : 66;
    const room = this.trackerRoom(w);
    const bw = stacked ? Math.min(right - pad, 260 * k)
      : this.compact ? Math.min(w * 0.42, 260 * k, room) : 360;
    // Longest line allowed; canvas squeezes a line rather than overflow past it.
    const maxW = stacked ? right - pad : this.compact ? Math.min(w * 0.6, room) : undefined;

    const isPrep = game.inBuildPhase;
    const label = isPrep ? tr('hud.wave.nextAssault', 'NEXT ASSAULT') : game.waveLabel;
    const boss = game.phase === 'boss' || game.plan?.isBoss;

    ctx.textAlign = 'center';
    ctx.font = `600 ${this.fs(12)}px ${UI_FONT}`;
    ctx.fillStyle = css(boss ? 0xff4f5e : isPrep ? 0x5cf2a0 : 0xffb347);
    ctx.fillText(label, cx, y, maxW);

    // Bar: build countdown, or kill progress in combat.
    const barY = y + Math.round(12 * k);
    const barH = Math.round(8 * k);
    ctx.fillStyle = rgba(0x000000, 0.6);
    techRect(ctx, cx - bw / 2, barY, bw, barH, 3);
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
    techRect(ctx, cx - bw / 2, barY, Math.max(2, bw * t), barH, 3);
    ctx.fill();
    ctx.strokeStyle = rgba(col, 0.4);
    ctx.lineWidth = 1;
    techRect(ctx, cx - bw / 2, barY, bw, barH, 3);
    ctx.stroke();

    // Wave pips. In the campaign this is the whole level; in endless it is the
    // current run of ten waves leading up to the next boss.
    const pipY = barY + Math.round(18 * k);
    const total = game.endless ? 10 : game.level.waves;
    const doneInBlock = game.endless ? game.waveIndex % 10 : game.waveIndex;
    const pw = Math.min(16 * k, bw / total);
    const pr = 5 * k;
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
        ctx.moveTo(px, pipY - pr);
        ctx.lineTo(px + pr * 0.9, pipY);
        ctx.lineTo(px, pipY + pr);
        ctx.lineTo(px - pr * 0.9, pipY);
        ctx.closePath();
        ctx.fill();
      } else if (cur) {
        // The current wave stands taller and outlined: done (green) and
        // current (amber) differ only by hue otherwise, and red-green colour
        // blindness folds those two together.
        const ch = pr * 1.8;
        ctx.fillRect(px - pw * 0.32, pipY - ch / 2, pw * 0.64, ch);
        ctx.strokeStyle = rgba(0xffffff, 0.85);
        ctx.lineWidth = 1;
        ctx.strokeRect(px - pw * 0.32 - 0.5, pipY - ch / 2 - 0.5, pw * 0.64 + 1, ch + 1);
      } else {
        ctx.fillRect(px - pw * 0.32, pipY - pr / 2, pw * 0.64, pr);
      }
      if (isBossPip && cur) {
        ctx.strokeStyle = rgba(0xffffff, 0.85);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Text rows under the pips, spaced for the (possibly enlarged) font.
    const lineH = Math.max(16, this.fs(11) + 5);
    let ty = pipY + Math.round(18 * k);
    ctx.font = `500 ${this.fs(11)}px ${UI_FONT}`;
    ctx.fillStyle = css(0x8fa3c0);
    if (isPrep) {
      const s = Math.ceil(game.prepRemaining);
      // Touch has no Space key — point at the on-screen START button instead.
      ctx.fillText(
        this.compact
          ? tr('hud.wave.prepCountdownTouch', '{s}s   ·   ▶ START early for bonus ore', { s })
          : tr('hud.wave.prepCountdown', '{s}s   ·   SPACE to start early for bonus ore', { s }),
        cx, ty, maxW,
      );
      const next = game.nextPlan;
      if (next) {
        ty += lineH;
        ctx.font = `500 ${this.fs(10)}px ${UI_FONT}`;
        ctx.fillStyle = css(0x55667e);
        ctx.fillText(game.describeWave(next).toUpperCase(), cx, ty, maxW);
      }
    } else {
      ctx.fillText(tr('hud.wave.hostilesRemaining', '{n} HOSTILES REMAINING', { n: game.remainingEnemies }), cx, ty, maxW);
    }

    if (game.endless) {
      const left = game.wavesUntilBoss;
      ty += lineH;
      ctx.font = `600 ${this.fs(10)}px ${UI_FONT}`;
      ctx.fillStyle = css(left === 0 ? 0xff4f5e : 0xffcc55);
      ctx.fillText(
        left === 0
          ? tr('hud.wave.bossWave', 'BOSS WAVE')
          : tr('hud.wave.bossIn', 'BOSS IN {n} WAVE{s}', { n: left, s: left === 1 ? '' : 'S' }),
        cx, ty, maxW,
      );
    }
    return ty + Math.round(lineH / 2);
  }

  /* ---- build bar ------------------------------------------------------- */

  private buildBar(ctx: Ctx, game: Game, w: number, h: number) {
    this.buildSlots.length = 0;
    this.categoryTabs.length = 0;

    const cats = game.activeCategories;
    if (!cats.length) return;
    const kinds = game.categoryBuildings(game.buildCategory);

    // Only one section is on screen, so slots keep their full size however far
    // the roster grows — that is the whole point of grouping them.
    const gap = 6;
    const budget = Math.max(240, w - 96);
    const slot = Math.max(44, Math.min(62,
      Math.floor((budget - Math.max(0, kinds.length - 1) * gap) / Math.max(1, kinds.length))));
    const scale = slot / 62;
    const totalW = kinds.length * slot + Math.max(0, kinds.length - 1) * gap;
    const x0 = (w - totalW) / 2;
    const tabH = 22;
    const y0 = h - slot - 26 - this.insets.bottom;
    const tabY = y0 - tabH - 6;

    ctx.fillStyle = 'rgba(5,8,14,0.6)';
    ctx.fillRect(0, tabY - 8, w, slot + tabH + 54);

    // --- section tabs ---
    ctx.textAlign = 'center';
    const tabFont = `600 10px ${UI_FONT}`;
    ctx.font = tabFont;
    const tabWidths = cats.map((c) =>
      Math.round(this.measure(ctx, buildCategoryLabel(c).toUpperCase())) + 40);
    const tabsW = tabWidths.reduce((a, b) => a + b, 0) + (cats.length - 1) * 4;
    let tx = (w - tabsW) / 2;

    cats.forEach((cat, i) => {
      const tw = tabWidths[i];
      const active = cat === game.buildCategory;
      this.categoryTabs.push({ category: cat, x: tx, y: tabY, w: tw, h: tabH });

      ctx.fillStyle = active ? rgba(0x46d8ff, 0.2) : 'rgba(10,16,26,0.85)';
      techRect(ctx, tx, tabY, tw, tabH, 6);
      ctx.fill();
      ctx.strokeStyle = active ? css(0x46d8ff) : rgba(0x46d8ff, 0.22);
      ctx.lineWidth = active ? 1.8 : 1;
      techRect(ctx, tx, tabY, tw, tabH, 6);
      ctx.stroke();

      ctx.font = tabFont;
      ctx.fillStyle = css(active ? 0xffffff : 0x8fa3c0);
      ctx.fillText(buildCategoryLabel(cat).toUpperCase(), tx + tw / 2, tabY + tabH / 2 + 1);

      // Section key, drawn small in the corner like the slot keys.
      ctx.textAlign = 'left';
      ctx.font = `600 8px ${MONO}`;
      ctx.fillStyle = rgba(0xffffff, active ? 0.55 : 0.3);
      ctx.fillText(CATEGORY_KEY[cat], tx + 6, tabY + 7);
      ctx.textAlign = 'center';

      // Count, so you can see a section has more in it without opening it.
      const n = game.categoryBuildings(cat).length;
      ctx.font = `600 8px ${MONO}`;
      ctx.fillStyle = rgba(0xffffff, active ? 0.5 : 0.28);
      ctx.fillText(String(n), tx + tw - 9, tabY + 7);

      tx += tw + 4;
    });

    // --- slots in the active section ---
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

      // Slot key — a digit, now meaningful only within this section.
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
    const mode = game.cursorMode === 'sell'
      ? tr('hud.buildBar.legendSell', 'SELL MODE — click a structure   ·   Q to exit')
      : game.cursorMode === 'build'
      ? tr('hud.buildBar.legendBuild', 'LMB place   ·   RMB cancel   ·   E repair   ·   T targeting')
      : tr('hud.buildBar.legendSections',
          'Z/X/C section   ·   1-8 structure   ·   WASD move   ·   LMB fire   ·   RMB mine   ·   Q sell   ·   TAB stats');
    ctx.fillText(mode, w / 2, h - 12 - this.insets.bottom);
  }

  /** Hit-test the section tabs. Returns the tapped section, or null. */
  hitCategoryTab(x: number, y: number): BuildCategory | null {
    for (const t of this.categoryTabs) {
      if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return t.category;
    }
    return null;
  }

  /* ---- minimap --------------------------------------------------------- */

  /** Minimap visibility, toggled by the touch overview button. */
  showMinimap = true;

  /** Draws the minimap; returns its left/bottom edges, or null when hidden (touch). */
  private minimap(ctx: Ctx, game: Game, w: number, h: number): { left: number; bottom: number } | null {
    if (this.compact && !this.showMinimap) return null;
    const s = this.compact ? this.uiScale : 1;
    // On touch the bottom-right corner is the action cluster, so the map moves to
    // the top-right, under the pause and overview buttons.
    const size = this.compact ? Math.round(Math.min(118 * s, h * 0.28)) : 168;
    const pad = this.compact ? Math.round(12 * s) : 18;
    const x0 = w - size - pad - this.insets.right;
    // Touch: under the pause/overview buttons, and never over the top stack
    // (which grows in portrait, or when a boss bar joins it).
    const y0 = this.compact
      ? Math.max(Math.round(104 * s) + this.insets.top, this.topClear + pad)
      : h - size - pad - this.insets.bottom;
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
    return { left: x0, bottom: y0 + size };
  }

  /* ---- left status rail ------------------------------------------------ */

  private statusRail(ctx: Ctx, game: Game, w: number, h: number) {
    const x = 22 + this.insets.left;
    // Starts high enough to fit core, chassis, heat, dash, strike and tech.
    let y = h - 240 - this.insets.bottom;
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

    // Orbital strike charge.
    const strike = game.strike;
    ctx.font = `500 9px ${UI_FONT}`;
    ctx.fillStyle = css(strike.ready ? 0x9fe8ff : 0x55667e);
    ctx.fillText(strike.ready
      ? tr('hud.rail.strikeReady', 'ORBITAL STRIKE READY  [F]')
      : tr('hud.rail.strikeCharging', 'ORBITAL STRIKE  {pct}%', { pct: Math.floor(strike.pct * 100) }), x, y);
    y += 10;
    ctx.fillStyle = rgba(0x000000, 0.6);
    ctx.fillRect(x, y, bw, 4);
    ctx.fillStyle = css(strike.ready ? 0x9fe8ff : 0x2f5680);
    ctx.fillRect(x, y, bw * strike.pct, 4);
    y += 20;

    // Active tech.
    if (game.techTaken.length) {
      ctx.font = `500 9px ${UI_FONT}`;
      ctx.fillStyle = css(0x55667e);
      ctx.fillText(tr('hud.rail.techCount', 'TECH  ×{n}', { n: game.techTaken.length }), x, y);
    }
  }

  /* ---- boss bar -------------------------------------------------------- */

  /**
   * Boss name, health and incoming-ability warning. On touch it stacks under
   * `top` (the wave tracker's bottom) and returns its own bottom edge.
   */
  private bossBar(ctx: Ctx, game: Game, w: number, top = 0): number {
    const e = game.bossRef!;
    const k = this.k;
    const pad = Math.round(14 * k) + this.insets.left;
    const bw = !this.compact ? Math.min(760, w - 200)
      : this.portrait ? this.stripRight(w) - pad
      : Math.min(420, w - 220);
    const x = this.compact && this.portrait ? pad : (w - bw) / 2;
    const cx = x + bw / 2;
    const y = this.compact ? top + Math.round(30 * k) : 132;
    const bh = Math.round(16 * k);

    ctx.textAlign = 'center';
    ctx.font = `700 ${this.fs(20)}px ${UI_FONT}`;
    ctx.fillStyle = css(0xff4f5e);
    ctx.fillText(enemyName(e.def), cx, y - Math.round(14 * k), bw);

    ctx.fillStyle = rgba(0x000000, 0.72);
    techRect(ctx, x, y, bw, bh, 6);
    ctx.fill();

    const pct = clamp(e.hp / e.maxHp, 0, 1);
    const g = ctx.createLinearGradient(x, 0, x + bw, 0);
    g.addColorStop(0, '#8c1f2f');
    g.addColorStop(0.5, '#ff4f5e');
    g.addColorStop(1, '#ff8a5c');
    ctx.fillStyle = g;
    techRect(ctx, x, y, Math.max(3, bw * pct), bh, 6);
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
      ctx.lineTo(x + (bw * i) / 4, y + bh);
      ctx.stroke();
    }

    ctx.strokeStyle = rgba(0xff4f5e, 0.5);
    ctx.lineWidth = 1;
    techRect(ctx, x, y, bw, bh, 6);
    ctx.stroke();

    ctx.font = `600 ${this.fs(11)}px ${MONO}`;
    ctx.fillStyle = css(0xffffff);
    ctx.fillText(`${fmtNum(Math.ceil(e.hp))} / ${fmtNum(e.maxHp)}`, cx, y + bh / 2);

    if (e.castingIndex >= 0) {
      const ab = e.def.abilities![e.castingIndex];
      ctx.font = `600 ${this.fs(11)}px ${UI_FONT}`;
      ctx.fillStyle = css(0xffb347);
      ctx.fillText(tr('hud.boss.abilityIncoming', '⚠  {ability} INCOMING', { ability: ab.id.toUpperCase() }),
        cx, y + bh + Math.round(14 * k), bw);
    }
    // Room for the ability warning even when idle, so the stack doesn't jump.
    return y + bh + Math.round(24 * k);
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
      stats.push(...buildingStats(game, d));
      lines.push(stats.join('   ·   '));
      if (!game.buildValid && game.lastError.life > 0) lines.push(`⚠ ${game.lastError.text}`);
    } else if (game.hoverBuilding) {
      const b = game.hoverBuilding;
      title = buildingName(b.def);
      lines = [tr('hud.tooltip.hpShort', '{cur} / {max} HP', { cur: Math.ceil(b.hp), max: b.maxHp })
        + (b.shield > 0 ? tr('hud.tooltip.shieldInline', '  ·  {n} shield', { n: Math.ceil(b.shield) }) : '')];
      if (b.isTurret) {
        title += `  ·  ${tr('hud.tooltip.level', 'Lv {n}', { n: b.level })}`
          + (b.branch ? ` ${branchName(b.branch)}` : '');
        lines.push(tr('hud.tooltip.targeting', 'Targeting: {mode}  (T to cycle)  ·  {kills} kills',
          { mode: targetingLabel(b.targeting), kills: b.kills }));
        // What the next upgrade costs and which key buys it (see data/upgrades.ts).
        const up = game.upgradeCost(b);
        if (up) {
          const price = up.essence > 0
            ? tr('hud.tooltip.costOreEssence', '{ore} ore · {essence} essence', { ore: up.ore, essence: up.essence })
            : tr('hud.tooltip.costOre', '{ore} ore', { ore: up.ore });
          lines.push(b.level === 1
            ? tr('hud.tooltip.upgrade', 'U to upgrade ({cost}): +30% damage, +25% hull', { cost: price })
            : tr('hud.tooltip.upgradeFork', 'U: {a} ({ea})  ·  I: {b} ({eb})  —  {cost}', {
              a: branchName('rapid'), ea: branchEffect('rapid'),
              b: branchName('range'), eb: branchEffect('range'), cost: price,
            }));
        }
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
    let tw = this.measure(ctx, title);
    for (const l of lines) tw = Math.max(tw, this.measure(ctx, l));
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
  /** True while the pointer sits over HUD chrome — see `overHud` in main.ts. */
  uiCaptured = false;

  /* ---- banner ---------------------------------------------------------- */

  private banner(ctx: Ctx, game: Game, w: number, h: number) {
    const b = game.banner;
    this.bannerBand = null;
    if (!b) return;
    const t = b.life / b.maxLife;
    // Fade in over the first 15%, hold, fade out over the last 30%.
    const alpha = t > 0.85 ? (1 - t) / 0.15 : t < 0.3 ? t / 0.3 : 1;
    const y = this.compact ? h * 0.36 : h * 0.3;
    const k = this.k;
    const half = Math.round(42 * k);
    this.bannerBand = { top: y - half, bottom: y + half };

    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.textAlign = 'center';

    ctx.fillStyle = 'rgba(4,7,12,0.55)';
    ctx.fillRect(0, y - half, w, half * 2);
    ctx.strokeStyle = b.color;
    ctx.globalAlpha = clamp(alpha, 0, 1) * 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y - half); ctx.lineTo(w, y - half);
    ctx.moveTo(0, y + half); ctx.lineTo(w, y + half);
    ctx.stroke();
    ctx.globalAlpha = clamp(alpha, 0, 1);

    // A long sector name at a large UI scale can outgrow a phone: shrink the
    // title to fit rather than clip it at the screen edges.
    let titlePx = Math.round(40 * k);
    ctx.font = `700 ${titlePx}px ${UI_FONT}`;
    const tw = ctx.measureText(b.title).width;
    if (tw > w - 24) {
      titlePx = Math.max(this.fs(16), Math.floor(titlePx * (w - 24) / tw));
      ctx.font = `700 ${titlePx}px ${UI_FONT}`;
    }
    ctx.fillStyle = b.color;
    ctx.fillText(b.title, w / 2, y - Math.round(8 * k));
    ctx.font = `500 ${this.fs(13)}px ${UI_FONT}`;
    ctx.fillStyle = css(0xc8d4e2);
    ctx.fillText(b.sub, w / 2, y + Math.round(22 * k), w - 24);
    ctx.restore();
  }

  private crosshair(ctx: Ctx, game: Game) {
    // Over the build bar, minimap or status rail the native pointer takes over
    // (see main.ts toggling canvas.style.cursor) — drawing the aim reticle on
    // top of UI chrome read as if the game was still targeting through it.
    if (this.uiCaptured) return;
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
    // Touch placement shows the reason in its own hint; don't say it twice.
    if (this.compact && game.cursorMode === 'build') return;
    const a = clamp(game.lastError.life / 1.6, 0, 1);
    const k = this.k;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.font = `600 ${this.fs(13)}px ${UI_FONT}`;
    const txt = game.lastError.text.toUpperCase();
    // Touch: the bottom belongs to the thumbs and the action column, so the
    // toast goes under the top stack, in the hint lane, below any hint there.
    const area = pickHintLane(this.measure(ctx, txt), this.hintArea, this.hintAreaWide);
    const cx = this.compact ? (area.left + area.right) / 2 : w / 2;
    const maxW = this.compact ? area.right - area.left - 32 : w - 32;
    const tw = Math.min(this.measure(ctx, txt), maxW);
    const bh = Math.round(28 * k);
    const y = this.compact
      ? clearOfBand(area.top + Math.round(40 * k), bh, this.bannerBand) + bh / 2
      : h - 132;
    ctx.fillStyle = 'rgba(30,6,10,0.92)';
    techRect(ctx, cx - tw / 2 - 16, y - bh / 2, tw + 32, bh, 8);
    ctx.fill();
    ctx.strokeStyle = rgba(0xff4f5e, 0.6);
    ctx.lineWidth = 1;
    techRect(ctx, cx - tw / 2 - 16, y - bh / 2, tw + 32, bh, 8);
    ctx.stroke();
    ctx.fillStyle = css(0xff8090);
    ctx.fillText(txt, cx, y, maxW);
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
