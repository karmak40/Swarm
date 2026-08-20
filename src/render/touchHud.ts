import { TAU, clamp } from '../core/math';
import type { TouchButton, TouchInput } from '../core/touch';
import { BUILDINGS, buildingName, type BuildingKind, type TargetingMode } from '../data/buildings';
import { t as tr } from '../core/i18n';
import type { Game } from '../game/game';
import type { Building } from '../game/entities';
import { css, rgba } from './palette';
import { techRect } from './shapes';

type Ctx = CanvasRenderingContext2D;

const UI_FONT = "'Bahnschrift', 'DIN Alternate', 'Segoe UI', system-ui, sans-serif";
const MONO = "'Cascadia Mono', Consolas, monospace";

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
  menuItems: { id: 'sell' | 'repair' | 'target' | 'close'; x: number; y: number; w: number; h: number }[] = [];
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
    // Drawer first: the buttons that remain visible must sit on top of it.
    if (touch.drawerOpen) this.drawer(ctx, game, touch, w, h);
    else this.drawerSlots.length = 0;
    for (const b of touch.buttons) this.button(ctx, game, touch, b);
    if (this.menu) this.contextMenu(ctx, game, w, h);
    if (touch.placing) this.placementHint(ctx, game, w, h, touch);

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
        glyph = touch.drawerOpen ? '×' : '⌂';
        label = touch.drawerOpen ? tr('touchHud.button.close', 'CLOSE') : tr('touchHud.button.build', 'BUILD');
        tint = touch.drawerOpen ? 0xffb347 : 0x46d8ff;
        break;
      case 'startWave':
        glyph = '▶';
        label = tr('touchHud.button.start', 'START');
        tint = 0xffb347;
        break;
      case 'pause':
        glyph = '⏸';
        tint = 0x8fa3c0;
        break;
      case 'map':
        glyph = '⊞';
        tint = 0x8fa3c0;
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
    const drawerH = rows * (slot + gap) + Math.round(46 * s);
    const y0 = h - drawerH;

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

    const gridTop = y0 + Math.round(34 * s);
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
      ctx.globalAlpha = 1;
    });
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
    const s = touch.scale;
    const msg = game.buildValid
      ? tr('touchHud.placement.tapToPlace', 'TAP TO PLACE')
      : (game.lastError.text || tr('touchHud.placement.cannotBuildHere', 'CANNOT BUILD HERE'));
    ctx.textAlign = 'center';
    ctx.font = `600 ${Math.round(13 * s)}px ${UI_FONT}`;
    const tw = ctx.measureText(msg).width;
    const bx = w / 2 - tw / 2 - 16;
    const by = Math.round(96 * s);
    ctx.fillStyle = 'rgba(4,7,12,0.9)';
    techRect(ctx, bx, by, tw + 32, Math.round(30 * s), 8);
    ctx.fill();
    ctx.strokeStyle = rgba(game.buildValid ? 0x46d8ff : 0xff4f5e, 0.6);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = css(game.buildValid ? 0x9fe8ff : 0xff8090);
    ctx.fillText(msg, w / 2, by + Math.round(15 * s));
    void h;
  }

  /* ---- long-press context menu ---------------------------------------- */

  openMenu(screenX: number, screenY: number, target: Building) {
    this.menu = { screenX, screenY };
    this.menuTarget = target;
  }

  closeMenu() {
    this.menu = null;
    this.menuTarget = null;
    this.menuItems.length = 0;
  }

  /** Localised label for a turret's targeting mode, shown in the context menu. */
  private targetingLabel(mode: TargetingMode): string {
    switch (mode) {
      case 'first': return tr('touchHud.menu.targeting.first', 'FIRST');
      case 'closest': return tr('touchHud.menu.targeting.closest', 'CLOSEST');
      case 'strongest': return tr('touchHud.menu.targeting.strongest', 'STRONGEST');
      case 'weakest': return tr('touchHud.menu.targeting.weakest', 'WEAKEST');
    }
  }

  private contextMenu(ctx: Ctx, game: Game, w: number, h: number) {
    this.menuItems.length = 0;
    const b = this.menuTarget;
    // Structure destroyed while the menu was open.
    if (!b || b.dead) { this.closeMenu(); return; }
    void game;

    const s = 1;
    const itemW = 128 * s;
    const itemH = 44 * s;
    const items: { id: 'sell' | 'repair' | 'target' | 'close'; text: string; tint: number }[] = [
      { id: 'repair', text: tr('touchHud.menu.repair', 'REPAIR'), tint: 0x5cf2a0 },
      { id: 'sell', text: tr('touchHud.menu.sell', 'SELL'), tint: 0xff4f5e },
    ];
    if (b.isTurret) items.push({ id: 'target', text: this.targetingLabel(b.targeting), tint: 0x46d8ff });
    items.push({ id: 'close', text: tr('touchHud.menu.close', 'CLOSE'), tint: 0x8fa3c0 });

    const totalH = items.length * (itemH + 6);
    let x = clamp(this.menu!.screenX + 20, 10, w - itemW - 10);
    let y = clamp(this.menu!.screenY - totalH / 2, 90, h - totalH - 90);

    // Header: what we are acting on.
    ctx.textAlign = 'left';
    ctx.font = `600 12px ${UI_FONT}`;
    ctx.fillStyle = 'rgba(4,7,12,0.94)';
    techRect(ctx, x, y - 32, itemW, 28, 7);
    ctx.fill();
    ctx.strokeStyle = rgba(0x46d8ff, 0.35);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = css(0xe7f0ff);
    ctx.fillText(buildingName(b.def).toUpperCase().slice(0, 14), x + 10, y - 18);

    items.forEach((it, i) => {
      const iy = y + i * (itemH + 6);
      this.menuItems.push({ id: it.id, x, y: iy, w: itemW, h: itemH });
      ctx.fillStyle = 'rgba(8,13,22,0.95)';
      techRect(ctx, x, iy, itemW, itemH, 8);
      ctx.fill();
      ctx.strokeStyle = rgba(it.tint, 0.5);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = css(it.tint);
      ctx.font = `600 13px ${UI_FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(it.text, x + 12, iy + itemH / 2);

      if (it.id === 'repair') {
        ctx.textAlign = 'right';
        ctx.font = `500 11px ${MONO}`;
        ctx.fillStyle = css(0x8fa3c0);
        ctx.fillText(
          tr('touchHud.menu.repairPercent', '{pct}%', { pct: Math.round(b.pct * 100) }),
          x + itemW - 12, iy + itemH / 2,
        );
      }
    });
  }

  hitMenu(x: number, y: number) {
    for (const m of this.menuItems) {
      if (x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h) return m.id;
    }
    return null;
  }
}
