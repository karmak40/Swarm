import { TAU, clamp } from '../core/math';
import type { TouchButton, TouchInput } from '../core/touch';
import { BUILDINGS, buildingDesc, buildingName, type BuildingKind, type TargetingMode } from '../data/buildings';
import { buildingStats, canHitAir } from './buildingInfo';
import { branchEffect, branchName } from '../data/upgrades';
import { clearOfBand, pickHintLane, type HintLane } from './hud';
import { t as tr } from '../core/i18n';
import type { Game } from '../game/game';
import type { Building } from '../game/entities';
import { css, rgba } from './palette';
import { techRect } from './shapes';

type Ctx = CanvasRenderingContext2D;

const UI_FONT = "'Bahnschrift', 'DIN Alternate', 'Segoe UI', system-ui, sans-serif";
const MONO = "'Cascadia Mono', Consolas, monospace";
/** Height of the drawer's details strip, before UI scale. */
const DRAWER_INFO_H = 72;

/**
 * Greedy word-wrap of `parts` joined by `sep` into at most `maxLines` lines
 * of `maxW` px in the current font; the last line gets an ellipsis if cut.
 */
export function wrapLines(ctx: Ctx, parts: string[], sep: string, maxW: number, maxLines: number): string[] {
  const words = sep === ' ' ? parts.join(' ').split(/\s+/).filter(Boolean) : parts;
  const lines: string[] = [];
  let cur = '';
  for (const wd of words) {
    const next = cur ? cur + sep + wd : wd;
    if (!cur || ctx.measureText(next).width <= maxW) { cur = next; continue; }
    lines.push(cur);
    cur = wd;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  else if (cur && lines.length === maxLines) {
    // Out of room: mark the cut on the last line.
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}

/** Direction buckets for off-screen threat arrows (15° each). */
const THREAT_BINS = 24;

/** Structure menu entries. 'rapid'/'range' are the level-3 upgrade fork. */
export type MenuItemId = 'sell' | 'repair' | 'target' | 'close' | 'upgrade' | 'rapid' | 'range';
/** Max neighbouring buckets folded into one arrow (3 × 15° = 45°). */
const MERGE_SPAN = 3;
/** Seconds a damaged off-screen structure keeps its "under attack" ping. */
const ALERT_SECONDS = 1.5;
/** How long an armed SELL waits for its confirming tap. */
const SELL_ARM_MS = 3000;

/**
 * Draws the on-screen controls and the touch build drawer.
 *
 * Kept separate from the desktop HUD because the two have different jobs: the
 * desktop HUD is an information display, this is an input surface. Geometry
 * comes from `TouchInput` so hit-testing and drawing cannot drift apart.
 */
export class TouchHud {
  /** Drawer slot rectangles, refreshed each frame for hit-testing. */
  drawerSlots: { kind: BuildingKind; x: number; y: number; w: number; h: number }[] = [];
  /** Context-menu buttons from the last long press. */
  menuItems: { id: MenuItemId; x: number; y: number; w: number; h: number }[] = [];
  /** World position the context menu refers to. */
  menu: { screenX: number; screenY: number } | null = null;
  /**
   * The structure the open menu acts on, captured when it opened.
   *
   * Not read from `game.hoverBuilding` at action time: tapping a menu item moves
   * the touch point off the structure, and the game recomputes hover before the
   * tap is handled, so the target would already be gone.
   */
  menuTarget: Building | null = null;

  draw(ctx: Ctx, game: Game, touch: TouchInput, w: number, h: number) {
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    this.stick(ctx, touch);
    this.threats(ctx, game, touch, w, h);
    // Drawer first: the buttons that remain visible must sit on top of it.
    if (touch.drawerOpen) this.drawer(ctx, game, touch, w, h);
    else this.drawerSlots.length = 0;
    for (const b of touch.buttons) this.button(ctx, game, touch, b);
    if (this.menu) this.contextMenu(ctx, game, w, h, touch.scale);
    if (game.cursorMode === 'strike') {
      this.hintPill(ctx, touch, tr('touchHud.strike.aim', 'TAP THE MAP TO CALL THE STRIKE'), 0x9fe8ff, 0x9fe8ff);
    } else if (touch.placing) {
      this.placementHint(ctx, game, w, h, touch);
      if (!touch.drawerOpen) this.placementCard(ctx, game, touch, w, h);
    } else if (!touch.drawerOpen && !this.menu && game.cursorMode === 'normal'
      && game.nearbyMineNode && game.player.miningNode === -1) {
      this.mineHint(ctx, w, h, touch);
    }

    ctx.restore();
  }

  /* ---- movement stick -------------------------------------------------- */

  private stick(ctx: Ctx, touch: TouchInput) {
    const s = touch.stick;
    if (!s.active) return;
    const R = s.radius;

    ctx.strokeStyle = rgba(0x9fd8ff, 0.22);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, R, 0, TAU);
    ctx.stroke();

    ctx.fillStyle = rgba(0x46d8ff, 0.07);
    ctx.fill();

    // Thumb, clamped to the ring.
    const dx = s.tx - s.cx, dy = s.ty - s.cy;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, R / d);
    const px = s.cx + dx * k, py = s.cy + dy * k;

    ctx.fillStyle = rgba(0x9fe8ff, 0.5);
    ctx.beginPath();
    ctx.arc(px, py, R * 0.34, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = rgba(0xffffff, 0.7);
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /* ---- off-screen threat indicators ------------------------------------ */

  private threatBins = Array.from({ length: THREAT_BINS }, () => ({ n: 0, d: 0, a: 0, boss: false }));
  private alertBins = Array.from({ length: THREAT_BINS }, () => ({ n: 0, a: 0 }));

  /**
   * Edge arrows toward enemies outside the view, and pings for structures
   * taking damage off-screen.
   *
   * A phone shows ~24 tiles of a 70–110-tile map, so without these the
   * first sign of a flank is the core's health bar. Enemies are bucketed by
   * direction so a swarm reads as one arrow with a count, not a fringe of
   * dozens; each arrow points at the nearest enemy in its bucket and grows
   * brighter as that enemy closes in.
   */
  private threats(ctx: Ctx, game: Game, touch: TouchInput, w: number, h: number) {
    const s = touch.scale;
    const ins = touch.insets;
    const cam = game.camera;
    // Keep clear of the top resource strip; the edges get a small margin.
    const L = 14 * s + ins.left, R = w - 14 * s - ins.right;
    const T = this.hintArea.top, B = h - 14 * s - ins.bottom;
    const cx = (L + R) / 2, cy = (T + B) / 2;
    const toSx = (x: number) => (x - cam.x) * cam.zoom + w / 2;
    const toSy = (y: number) => (y - cam.y) * cam.zoom + h / 2;
    const onScreen = (sx: number, sy: number) => sx >= 0 && sx <= w && sy >= 0 && sy <= h;
    const binOf = (a: number) => ((Math.round((a / TAU) * THREAT_BINS) % THREAT_BINS) + THREAT_BINS) % THREAT_BINS;

    for (const b of this.threatBins) { b.n = 0; b.d = Infinity; b.boss = false; }
    for (const b of this.alertBins) b.n = 0;

    for (const e of game.enemies) {
      if (e.dead) continue;
      const sx = toSx(e.x), sy = toSy(e.y);
      if (onScreen(sx, sy)) continue;
      const a = Math.atan2(sy - cy, sx - cx);
      const bin = this.threatBins[binOf(a)];
      const d = Math.hypot(e.x - cam.x, e.y - cam.y);
      bin.n++;
      if (d < bin.d) { bin.d = d; bin.a = a; }
      if (e.boss) bin.boss = true;
    }
    for (const b of game.buildings) {
      if (b.dead || game.elapsed - b.attackedAt > ALERT_SECONDS) continue;
      const sx = toSx(b.x), sy = toSy(b.y);
      if (onScreen(sx, sy)) continue;
      const a = Math.atan2(sy - cy, sx - cx);
      const bin = this.alertBins[binOf(a)];
      if (bin.n++ === 0) bin.a = a;
    }

    const edge = (a: number) => {
      const dx = Math.cos(a), dy = Math.sin(a);
      const tx = dx > 0 ? (R - cx) / dx : dx < 0 ? (L - cx) / dx : Infinity;
      const ty = dy > 0 ? (B - cy) / dy : dy < 0 ? (T - cy) / dy : Infinity;
      const t = Math.min(tx, ty);
      return { x: cx + dx * t, y: cy + dy * t, dx, dy };
    };
    // "Close" = within about one screen of the view centre, in world px.
    const near = Math.hypot(w, h) / cam.zoom;
    const pulse = 0.5 + 0.5 * Math.sin(game.elapsed * 8);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    this.threatAnchor = null;
    for (const bin of this.mergeAdjacent(this.threatBins)) {
      const p = edge(bin.a);
      this.threatAnchor ??= { x: p.x, y: p.y };
      const urgency = clamp(1.25 - bin.d / near, 0.35, 1);
      const size = (8 + Math.min(7, Math.log2(bin.n) * 2.2)) * s * (bin.boss ? 1.45 : 1);
      const tint = bin.boss ? 0xffb347 : 0xff4f5e;
      const alpha = bin.boss ? 0.6 + 0.4 * pulse : urgency;

      // Arrowhead pointing outward, tip on the edge.
      const bx = p.x - p.dx * size * 1.6, by = p.y - p.dy * size * 1.6;
      const nx = -p.dy, ny = p.dx;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(bx + nx * size, by + ny * size);
      ctx.lineTo(bx - nx * size, by - ny * size);
      ctx.closePath();
      ctx.fillStyle = rgba(tint, alpha * 0.9);
      ctx.fill();
      ctx.strokeStyle = rgba(0x05070c, 0.8);
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (bin.n > 1) {
        const lx = p.x - p.dx * size * 3, ly = p.y - p.dy * size * 3;
        ctx.font = `600 ${Math.round(11 * s)}px ${MONO}`;
        ctx.fillStyle = rgba(0xffd4d8, alpha);
        ctx.fillText(String(bin.n), lx, ly);
      }
    }

    for (const bin of this.alertBins) {
      if (bin.n === 0) continue;
      const p = edge(bin.a);
      const r = 11 * s;
      const x = p.x - p.dx * r * 1.2, y = p.y - p.dy * r * 1.2;
      ctx.beginPath();
      ctx.arc(x, y, r * (1.25 + pulse * 0.5), 0, TAU);
      ctx.strokeStyle = rgba(0xffb347, 0.25 + 0.5 * (1 - pulse));
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = 'rgba(4,7,12,0.85)';
      ctx.fill();
      ctx.strokeStyle = css(0xffb347);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = `700 ${Math.round(13 * s)}px ${UI_FONT}`;
      ctx.fillStyle = css(0xffb347);
      ctx.fillText('!', x, y + 0.5);
    }

    ctx.restore();
  }

  /**
   * Folds runs of neighbouring non-empty buckets into one arrow each, so a
   * swarm straddling a bucket boundary doesn't draw two overlapping arrows.
   * Runs are capped at `MERGE_SPAN` buckets so a wide front still shows as
   * several arrows. Each merged arrow keeps its nearest enemy's direction.
   */
  private mergeAdjacent(bins: { n: number; d: number; a: number; boss: boolean }[]) {
    const out: { n: number; d: number; a: number; boss: boolean }[] = [];
    const N = bins.length;
    // Start just after an empty bucket so no run wraps around index 0.
    let start = bins.findIndex((b) => b.n === 0);
    if (start < 0) start = 0;
    let run: { n: number; d: number; a: number; boss: boolean } | null = null;
    let span = 0;
    for (let k = 1; k <= N; k++) {
      const b = bins[(start + k) % N];
      if (b.n === 0 || span >= MERGE_SPAN) {
        if (run) out.push(run);
        run = null;
        span = 0;
        if (b.n === 0) continue;
      }
      if (!run) run = { n: 0, d: Infinity, a: 0, boss: false };
      run.n += b.n;
      if (b.d < run.d) { run.d = b.d; run.a = b.a; }
      run.boss ||= b.boss;
      span++;
    }
    if (run) out.push(run);
    return out;
  }

  /* ---- action buttons -------------------------------------------------- */

  private button(ctx: Ctx, game: Game, touch: TouchInput, b: TouchButton) {
    if (!b.visible) return;

    let glyph = '';
    let label = '';
    let tint = 0x46d8ff;
    let ready = true;

    switch (b.id) {
      case 'dash':
        glyph = '»';
        label = tr('touchHud.button.dash', 'DASH');
        ready = game.player.dashCooldown <= 0;
        tint = ready ? 0x5cf2a0 : 0x2f5680;
        break;
      case 'build':
        if (touch.drawerOpen) {
          glyph = '×';
          label = tr('touchHud.button.close', 'CLOSE');
          tint = 0xffb347;
        } else if (game.buildKind) {
          glyph = '×';
          label = tr('touchHud.button.cancel', 'CANCEL');
          tint = 0xff4f5e;
        } else {
          glyph = '⌂';
          label = tr('touchHud.button.build', 'BUILD');
          tint = 0x46d8ff;
        }
        break;
      case 'startWave':
        glyph = '▶';
        label = tr('touchHud.button.start', 'START');
        tint = 0xffb347;
        break;
      case 'confirm': {
        // ✓ only when the ghost could actually land. Blocked shows ⊘ as well
        // as turning red — green/red alone is the pair red-green colour
        // blindness can't split. A tap on ⊘ still goes through so Game can
        // say why it can't.
        const def = game.buildKind ? BUILDINGS[game.buildKind] : null;
        const cost = def ? game.costOf(def) : null;
        const affordable = !!cost && game.ore >= cost.ore && game.essence >= cost.essence;
        ready = game.buildValid && affordable;
        glyph = ready ? '✓' : '⊘';
        label = tr('touchHud.button.confirm', 'PLACE');
        tint = ready ? 0x5cf2a0 : 0xff4f5e;
        break;
      }
      case 'pause':
        glyph = '⏸';
        tint = 0x8fa3c0;
        break;
      case 'map':
        glyph = '⊞';
        tint = 0x8fa3c0;
        break;
      case 'speed':
        // Shows the current speed; lit while fast-forwarding.
        glyph = game.speed > 1 ? '×2' : '×1';
        tint = game.speed > 1 ? 0xffcc55 : 0x8fa3c0;
        break;
      case 'strike':
        // Orbital strike: dim with a charge sweep, lit and pulsing when ready,
        // a cancel cross while aiming.
        if (game.cursorMode === 'strike') {
          glyph = '×';
          label = tr('touchHud.button.cancel', 'CANCEL');
          tint = 0xff4f5e;
        } else {
          glyph = '▼';
          label = tr('touchHud.button.strike', 'STRIKE');
          ready = game.strike.ready;
          tint = ready ? 0x9fe8ff : 0x2f5680;
        }
        break;
    }

    const press = b.held ? 0.9 : 1;
    const r = b.r * press;

    ctx.fillStyle = rgba(0x0a1018, 0.72);
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = rgba(tint, b.held ? 0.95 : 0.5);
    ctx.lineWidth = 2;
    ctx.stroke();

    // Cooldown sweep for dash.
    if (b.id === 'dash' && !ready) {
      const t = 1 - clamp(game.player.dashCooldown / 1.35, 0, 1);
      ctx.strokeStyle = rgba(0x5cf2a0, 0.85);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, -Math.PI / 2, -Math.PI / 2 + TAU * t);
      ctx.stroke();
    }
    // Charge sweep for the strike; a soft pulse once it's ready.
    if (b.id === 'strike' && game.cursorMode !== 'strike') {
      if (!ready) {
        ctx.strokeStyle = rgba(0x9fe8ff, 0.85);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, -Math.PI / 2, -Math.PI / 2 + TAU * game.strike.pct);
        ctx.stroke();
      } else {
        const pulse = 0.5 + 0.5 * Math.sin(game.elapsed * 5);
        ctx.strokeStyle = rgba(0x9fe8ff, 0.3 + 0.5 * pulse);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r + 3 + pulse * 3, 0, TAU);
        ctx.stroke();
      }
    }

    ctx.fillStyle = rgba(tint, b.held ? 1 : 0.9);
    ctx.font = `600 ${Math.round(r * 0.95)}px ${UI_FONT}`;
    ctx.fillText(glyph, b.x, b.y + r * 0.04);

    if (label) {
      ctx.font = `600 ${Math.max(8, Math.round(r * 0.3))}px ${UI_FONT}`;
      ctx.fillStyle = rgba(0xc8d4e2, 0.75);
      ctx.fillText(label, b.x, b.y + r * 1.42);
    }
  }

  /* ---- build drawer ---------------------------------------------------- */

  private drawer(ctx: Ctx, game: Game, touch: TouchInput, w: number, h: number) {
    this.drawerSlots.length = 0;
    const kinds = game.availableBuildings;
    const s = touch.scale;

    const slot = Math.round(74 * s);
    const gap = Math.round(8 * s);
    const perRow = Math.max(1, Math.floor((w - 40) / (slot + gap)));
    const rows = Math.ceil(kinds.length / perRow);
    const infoH = Math.round(DRAWER_INFO_H * s);
    const drawerH = rows * (slot + gap) + Math.round(46 * s) + infoH;
    const y0 = h - drawerH;
    this.drawerTop = y0;

    ctx.fillStyle = 'rgba(4,7,12,0.95)';
    ctx.fillRect(0, y0, w, drawerH);
    ctx.strokeStyle = rgba(0x46d8ff, 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(w, y0);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = `600 ${Math.round(11 * s)}px ${UI_FONT}`;
    ctx.fillStyle = css(0x46d8ff);
    ctx.fillText(tr('touchHud.drawer.construct', 'CONSTRUCT'), 20, y0 + Math.round(18 * s));
    ctx.textAlign = 'right';
    ctx.fillStyle = css(0x7fd9ff);
    ctx.font = `600 ${Math.round(12 * s)}px ${MONO}`;
    ctx.fillText(tr('touchHud.drawer.resources', '◆ {ore}   ✦ {essence}', {
      ore: Math.floor(game.ore), essence: Math.floor(game.essence),
    }), w - 20, y0 + Math.round(18 * s));

    this.drawerInfoPanel(ctx, game, s, 20, y0 + Math.round(30 * s), w - 40, infoH);

    const gridTop = y0 + Math.round(34 * s) + infoH;
    const totalW = perRow * slot + (perRow - 1) * gap;
    const left = (w - totalW) / 2;

    kinds.forEach((kind, i) => {
      const def = BUILDINGS[kind];
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const x = left + col * (slot + gap);
      const y = gridTop + row * (slot + gap);
      const cost = game.costOf(def);
      const affordable = game.ore >= cost.ore && game.essence >= cost.essence;
      const selected = game.buildKind === kind;

      this.drawerSlots.push({ kind, x, y, w: slot, h: slot });

      ctx.fillStyle = selected ? rgba(0x46d8ff, 0.25) : 'rgba(14,20,32,0.95)';
      techRect(ctx, x, y, slot, slot, 9);
      ctx.fill();
      ctx.strokeStyle = selected ? css(0x46d8ff) : affordable ? rgba(0x46d8ff, 0.32) : rgba(0xff4f5e, 0.28);
      ctx.lineWidth = selected ? 2.5 : 1.2;
      ctx.stroke();

      ctx.globalAlpha = affordable ? 1 : 0.4;
      ctx.textAlign = 'center';
      ctx.font = `500 ${Math.round(slot * 0.4)}px ${UI_FONT}`;
      ctx.fillStyle = css(selected ? 0xffffff : 0xc8d4e2);
      ctx.fillText(def.glyph, x + slot / 2, y + slot * 0.36);

      ctx.font = `600 ${Math.round(slot * 0.13)}px ${UI_FONT}`;
      ctx.fillStyle = css(0x8fa3c0);
      ctx.fillText(buildingName(def).toUpperCase().slice(0, 10), x + slot / 2, y + slot * 0.63);

      ctx.font = `600 ${Math.round(slot * 0.15)}px ${MONO}`;
      ctx.fillStyle = css(game.ore >= cost.ore ? 0x7fd9ff : 0xff4f5e);
      const txt = cost.essence > 0
        ? tr('touchHud.drawer.costOreEssence', '{ore}+{essence}', { ore: cost.ore, essence: cost.essence })
        : tr('touchHud.drawer.costOre', '{ore}', { ore: cost.ore });
      ctx.fillText(txt, x + slot / 2, y + slot * 0.84);

      // Anti-air at a glance, so the ground-only guns (cannon, mortar) stand out.
      if (def.damage && canHitAir(def)) {
        ctx.font = `600 ${Math.round(slot * 0.17)}px ${UI_FONT}`;
        ctx.fillStyle = css(0x5cf2a0);
        ctx.fillText('✈', x + slot * 0.84, y + slot * 0.16);
      }
      if (this.drawerInfo === kind) {
        ctx.strokeStyle = rgba(0xffb347, 0.9);
        ctx.lineWidth = 2;
        techRect(ctx, x + 2, y + 2, slot - 4, slot - 4, 8);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }

  /**
   * Details strip at the top of the drawer for the slot last long-pressed.
   * A tap still picks a structure straight away — details are opt-in, so
   * building something familiar doesn't cost an extra tap.
   */
  private drawerInfoPanel(ctx: Ctx, game: Game, s: number, x: number, y: number, w: number, h: number) {
    ctx.fillStyle = 'rgba(14,20,32,0.9)';
    techRect(ctx, x, y, w, h - Math.round(6 * s), 8);
    ctx.fill();
    ctx.strokeStyle = rgba(0x46d8ff, 0.2);
    ctx.lineWidth = 1;
    ctx.stroke();

    const pad = Math.round(10 * s);
    const lineH = Math.round(15 * s);
    ctx.textAlign = 'left';
    if (!this.drawerInfo) {
      ctx.textAlign = 'center';
      ctx.font = `600 ${Math.round(11 * s)}px ${UI_FONT}`;
      ctx.fillStyle = css(0x55667e);
      ctx.fillText(tr('touchHud.drawer.holdForInfo', 'HOLD A STRUCTURE FOR DETAILS · TAP TO BUILD'),
        x + w / 2, y + (h - 6 * s) / 2, w - pad * 2);
      return;
    }
    const d = BUILDINGS[this.drawerInfo];
    let ty = y + pad + lineH / 2 - 2;
    ctx.font = `700 ${Math.round(12 * s)}px ${UI_FONT}`;
    ctx.fillStyle = css(0xe7f0ff);
    ctx.fillText(buildingName(d).toUpperCase(), x + pad, ty);
    ty += lineH;
    ctx.font = `500 ${Math.round(11 * s)}px ${UI_FONT}`;
    ctx.fillStyle = css(0x8fa3c0);
    for (const line of wrapLines(ctx, [buildingDesc(d)], ' ', w - pad * 2, 1)) {
      ctx.fillText(line, x + pad, ty);
      ty += lineH;
    }
    ctx.font = `600 ${Math.round(11 * s)}px ${MONO}`;
    ctx.fillStyle = css(0x9fe8ff);
    for (const line of wrapLines(ctx, buildingStats(game, d), ' · ', w - pad * 2, 2)) {
      ctx.fillText(line, x + pad, ty);
      ty += lineH;
    }
  }

  /** Top edge of the open build drawer, in screen px (for coach callouts). */
  drawerTop = 0;
  /** Where the first off-screen threat arrow was drawn this frame, or null. */
  threatAnchor: { x: number; y: number } | null = null;

  /** Structure whose details the drawer shows; set by a long-press on its slot. */
  drawerInfo: BuildingKind | null = null;

  /**
   * Card for the structure being placed: what it is and what it does, while
   * the ghost and its range ring are on the map. Bottom corner opposite the
   * action buttons (bottom-left, or bottom-right in the southpaw mirror);
   * purely a readout, so it takes no touches.
   */
  private placementCard(ctx: Ctx, game: Game, touch: TouchInput, w: number, h: number) {
    if (!game.buildKind) return;
    const d = BUILDINGS[game.buildKind];
    const s = touch.scale;
    const ins = touch.insets;
    const build = touch.button('build');
    // Free span between the screen edge and the Build button, on whichever
    // side the buttons aren't.
    const clear = build ? build.r * 1.4 : 0;
    const spanL = touch.southpaw && build ? build.x + clear : Math.round(12 * s) + ins.left;
    const spanR = !touch.southpaw && build ? build.x - clear : w - Math.round(12 * s) - ins.right;
    const cw = Math.min(spanR - spanL, 360 * s);
    if (cw < 140 * s) return;
    // Hug the outer edge.
    const x = touch.southpaw ? spanR - cw : spanL;
    const pad = Math.round(10 * s);
    const lineH = Math.round(15 * s);

    ctx.font = `600 ${Math.round(11 * s)}px ${MONO}`;
    const stats = wrapLines(ctx, buildingStats(game, d), ' · ', cw - pad * 2, 3);
    ctx.font = `500 ${Math.round(11 * s)}px ${UI_FONT}`;
    const desc = wrapLines(ctx, [buildingDesc(d)], ' ', cw - pad * 2, 2);
    const ch = pad * 2 + lineH * (1 + desc.length + stats.length);
    const y = h - ch - Math.round(14 * s) - ins.bottom;

    ctx.fillStyle = 'rgba(4,7,12,0.82)';
    techRect(ctx, x, y, cw, ch, 8);
    ctx.fill();
    ctx.strokeStyle = rgba(0x46d8ff, 0.35);
    ctx.lineWidth = 1;
    ctx.stroke();

    const cost = game.costOf(d);
    let ty = y + pad + lineH / 2;
    ctx.textAlign = 'left';
    ctx.font = `700 ${Math.round(12 * s)}px ${UI_FONT}`;
    ctx.fillStyle = css(0xe7f0ff);
    ctx.fillText(buildingName(d).toUpperCase(), x + pad, ty);
    ctx.textAlign = 'right';
    ctx.font = `600 ${Math.round(11 * s)}px ${MONO}`;
    ctx.fillStyle = css(game.ore >= cost.ore ? 0x7fd9ff : 0xff4f5e);
    ctx.fillText(cost.essence > 0 ? `◆${cost.ore} ✦${cost.essence}` : `◆${cost.ore}`, x + cw - pad, ty);
    ty += lineH;
    ctx.textAlign = 'left';
    ctx.font = `500 ${Math.round(11 * s)}px ${UI_FONT}`;
    ctx.fillStyle = css(0x8fa3c0);
    for (const line of desc) { ctx.fillText(line, x + pad, ty); ty += lineH; }
    ctx.font = `600 ${Math.round(11 * s)}px ${MONO}`;
    ctx.fillStyle = css(0x9fe8ff);
    for (const line of stats) { ctx.fillText(line, x + pad, ty); ty += lineH; }
  }

  /** Hit-test the drawer. Returns the tapped structure, or null. */
  hitDrawer(x: number, y: number): BuildingKind | null {
    for (const s of this.drawerSlots) {
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s.kind;
    }
    return null;
  }

  lastWidth = 1280;

  /* ---- placement hint -------------------------------------------------- */

  private placementHint(ctx: Ctx, game: Game, w: number, h: number, touch: TouchInput) {
    const def = game.buildKind ? BUILDINGS[game.buildKind] : null;
    if (!def) return;
    const msg = !game.buildValid
      ? (game.lastError.text || tr('touchHud.placement.cannotBuildHere', 'CANNOT BUILD HERE'))
      : touch.confirmPlacement
        ? tr('touchHud.placement.aimThenConfirm', 'TAP: AIM · DRAG: LOOK · ✓ PLACE')
        : tr('touchHud.placement.tapToPlace', 'TAP TO PLACE');
    this.hintPill(ctx, touch, msg, game.buildValid ? 0x46d8ff : 0xff4f5e, game.buildValid ? 0x9fe8ff : 0xff8090);
    void w; void h;
  }

  /**
   * "Hold to mine" prompt — mining now takes a deliberate hold near the seam
   * (see TouchInput.mouseDown(2)) instead of firing automatically on
   * proximity, so a brand-new gesture needs to announce itself somehow.
   */
  private mineHint(ctx: Ctx, w: number, h: number, touch: TouchInput) {
    this.hintPill(ctx, touch, tr('touchHud.mine.holdToMine', 'HOLD ON SEAM TO MINE'), 0x7fd9ff, 0x9fe8ff);
    void w; void h;
  }

  /**
   * One-line hint under the top HUD, in `hintArea` (so in portrait it keeps
   * left of the minimap). Long translations shrink rather than clip.
   */
  private hintPill(ctx: Ctx, touch: TouchInput, msg: string, stroke: number, text: number) {
    const s = touch.scale;
    ctx.textAlign = 'center';
    let px = Math.round(13 * s);
    ctx.font = `600 ${px}px ${UI_FONT}`;
    let tw = ctx.measureText(msg).width;
    // Too long for the lane beside the minimap: drop under it instead.
    const { left, right, top } = pickHintLane(tw, this.hintArea, this.hintAreaWide);
    const cx = (left + right) / 2;
    const maxW = right - left - 32;
    if (tw > maxW) {
      px = Math.max(Math.round(10 * s), Math.floor(px * maxW / tw));
      ctx.font = `600 ${px}px ${UI_FONT}`;
      tw = Math.min(ctx.measureText(msg).width, maxW);
    }
    const bh = Math.round(30 * s);
    // The sector/wave banner owns the middle band while it's up.
    const y = clearOfBand(top, bh, this.bannerBand);
    ctx.fillStyle = 'rgba(4,7,12,0.9)';
    techRect(ctx, cx - tw / 2 - 16, y, tw + 32, bh, 8);
    ctx.fill();
    ctx.strokeStyle = rgba(stroke, 0.6);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = css(text);
    ctx.fillText(msg, cx, y + bh / 2, maxW);
  }

  /** Set each frame from `Hud.hintArea`: the lane under the top HUD for hints. */
  hintArea: HintLane = { left: 12, right: 363, top: 100 };
  /** Set each frame from `Hud.bannerBand`: where the banner is, so hints can clear it. */
  bannerBand: { top: number; bottom: number } | null = null;
  /** Set each frame from `Hud.hintAreaWide`: the full-width lane under the minimap. */
  hintAreaWide: HintLane | null = null;

  /* ---- long-press context menu ---------------------------------------- */

  openMenu(screenX: number, screenY: number, target: Building) {
    this.menu = { screenX, screenY };
    this.menuTarget = target;
    this.sellArmedAt = 0;
  }

  closeMenu() {
    this.menu = null;
    this.menuTarget = null;
    this.menuItems.length = 0;
    this.sellArmedAt = 0;
  }

  /**
   * Selling is two taps: the first arms SELL (it turns into a confirm showing
   * the refund), the second sells. An armed SELL lapses after a few seconds so
   * a stale prompt can't be confirmed by accident much later.
   */
  private sellArmedAt = 0;
  get sellArmed() {
    return this.sellArmedAt > 0 && performance.now() - this.sellArmedAt < SELL_ARM_MS;
  }
  armSell() { this.sellArmedAt = performance.now(); }
  disarmSell() { this.sellArmedAt = 0; }

  /** Localised label for a turret's targeting mode, shown in the context menu. */
  private targetingLabel(mode: TargetingMode): string {
    switch (mode) {
      case 'first': return tr('touchHud.menu.targeting.first', 'FIRST');
      case 'closest': return tr('touchHud.menu.targeting.closest', 'CLOSEST');
      case 'strongest': return tr('touchHud.menu.targeting.strongest', 'STRONGEST');
      case 'weakest': return tr('touchHud.menu.targeting.weakest', 'WEAKEST');
    }
  }

  private contextMenu(ctx: Ctx, game: Game, w: number, h: number, s: number) {
    this.menuItems.length = 0;
    const b = this.menuTarget;
    // Structure destroyed while the menu was open.
    if (!b || b.dead) { this.closeMenu(); return; }

    const itemW = Math.round(172 * s);
    const itemH = Math.round(44 * s);
    const gap = Math.round(6 * s);
    // Extra space above SELL so it is never one slip away from REPAIR.
    const sellGap = Math.round(18 * s);
    const headerH = Math.round(28 * s);
    const armed = this.sellArmed;
    const refund = game.sellValue(b);
    const upCost = game.upgradeCost(b);
    const canAfford = !!upCost && game.ore >= upCost.ore && game.essence >= upCost.essence;

    type Item = { id: MenuItemId; text: string; tint: number; sub?: string; cost?: string; dim?: boolean };
    const costText = upCost
      ? (upCost.essence > 0 ? `◆${upCost.ore} ✦${upCost.essence}` : `◆${upCost.ore}`)
      : '';
    const items: Item[] = [
      { id: 'repair', text: tr('touchHud.menu.repair', 'REPAIR'), tint: 0x5cf2a0 },
    ];
    // Upgrades (turrets only; see data/upgrades.ts). Level 2 forks in two.
    if (upCost && b.level === 1) {
      items.push({
        id: 'upgrade', text: tr('touchHud.menu.upgrade', 'UPGRADE'), tint: 0xffcc55,
        sub: tr('touchHud.menu.upgradeEffect', '+30% damage, +25% hull'), cost: costText, dim: !canAfford,
      });
    } else if (upCost && b.level === 2) {
      for (const br of ['rapid', 'range'] as const) {
        items.push({
          id: br, text: branchName(br).toUpperCase(), tint: br === 'rapid' ? 0xffb347 : 0x7fd9ff,
          sub: branchEffect(br), cost: costText, dim: !canAfford,
        });
      }
    }
    if (b.isTurret) items.push({ id: 'target', text: this.targetingLabel(b.targeting), tint: 0x46d8ff });
    items.push({ id: 'close', text: tr('touchHud.menu.close', 'CLOSE'), tint: 0x8fa3c0 });
    items.push({
      id: 'sell',
      text: armed ? tr('touchHud.menu.sellConfirm', 'CONFIRM SELL') : tr('touchHud.menu.sell', 'SELL'),
      tint: 0xff4f5e,
    });

    const totalH = items.length * (itemH + gap) + sellGap;
    const x = clamp(this.menu!.screenX + 20 * s, 10, w - itemW - 10);
    const y = clamp(this.menu!.screenY - totalH / 2, this.hintArea.top + headerH, h - totalH - 90 * s);

    // Header: what we are acting on, and its level once upgraded.
    ctx.textAlign = 'left';
    ctx.font = `600 ${Math.round(12 * s)}px ${UI_FONT}`;
    ctx.fillStyle = 'rgba(4,7,12,0.94)';
    techRect(ctx, x, y - headerH - 4 * s, itemW, headerH, 7);
    ctx.fill();
    ctx.strokeStyle = rgba(0x46d8ff, 0.35);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = css(0xe7f0ff);
    const title = buildingName(b.def).toUpperCase();
    const lv = b.isTurret ? tr('touchHud.menu.level', 'LV{n}', { n: b.level }) : '';
    ctx.fillText(title, x + 10 * s, y - headerH / 2 - 4 * s, itemW - 20 * s - (lv ? 34 * s : 0));
    if (lv) {
      ctx.textAlign = 'right';
      ctx.fillStyle = css(0xffcc55);
      ctx.fillText(lv, x + itemW - 10 * s, y - headerH / 2 - 4 * s);
    }

    let iy = y;
    for (const it of items) {
      if (it.id === 'sell') iy += sellGap;
      this.menuItems.push({ id: it.id, x, y: iy, w: itemW, h: itemH });
      const hot = it.id === 'sell' && armed;
      ctx.globalAlpha = it.dim ? 0.55 : 1;
      ctx.fillStyle = hot ? rgba(0xff4f5e, 0.28) : 'rgba(8,13,22,0.95)';
      techRect(ctx, x, iy, itemW, itemH, 8);
      ctx.fill();
      ctx.strokeStyle = rgba(it.tint, hot ? 1 : 0.5);
      ctx.lineWidth = hot ? 2 : 1.4;
      ctx.stroke();

      // Right-aligned detail: repair state, upgrade price, or what the sale returns.
      let detail = it.cost ?? '';
      let detailColor = 0x8fa3c0;
      if (it.id === 'repair') {
        detail = tr('touchHud.menu.repairPercent', '{pct}%', { pct: Math.round(b.pct * 100) });
      } else if (it.id === 'sell') {
        detail = refund.essence > 0
          ? tr('touchHud.menu.sellRefundEssence', '+{ore}◆ +{essence}✦', refund)
          : tr('touchHud.menu.sellRefund', '+{ore}◆', refund);
      } else if (it.cost) {
        detailColor = it.dim ? 0xff4f5e : 0x7fd9ff;
      }
      ctx.font = `500 ${Math.round(11 * s)}px ${MONO}`;
      const detailW = detail ? ctx.measureText(detail).width + 8 * s : 0;

      ctx.textAlign = 'left';
      ctx.font = `600 ${Math.round(13 * s)}px ${UI_FONT}`;
      ctx.fillStyle = css(hot ? 0xffd4d8 : it.tint);
      const textMax = itemW - 24 * s - detailW;
      if (it.sub) {
        // Two lines: the action, and what it does.
        ctx.fillText(it.text, x + 12 * s, iy + itemH * 0.36, textMax);
        ctx.font = `500 ${Math.round(10 * s)}px ${UI_FONT}`;
        ctx.fillStyle = css(0x8fa3c0);
        ctx.fillText(it.sub, x + 12 * s, iy + itemH * 0.72, itemW - 24 * s);
      } else {
        ctx.fillText(it.text, x + 12 * s, iy + itemH / 2, textMax);
      }

      if (detail) {
        ctx.textAlign = 'right';
        ctx.font = `500 ${Math.round(11 * s)}px ${MONO}`;
        ctx.fillStyle = css(detailColor);
        ctx.fillText(detail, x + itemW - 12 * s, it.sub ? iy + itemH * 0.36 : iy + itemH / 2);
      }
      ctx.globalAlpha = 1;
      iy += itemH + gap;
    }
  }

  hitMenu(x: number, y: number) {
    for (const m of this.menuItems) {
      if (x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h) return m.id;
    }
    return null;
  }
}
