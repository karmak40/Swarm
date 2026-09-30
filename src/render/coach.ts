import { TAU, clamp } from '../core/math';
import { t as tr } from '../core/i18n';
import { GHOST_LIFT, type TouchInput } from '../core/touch';
import type { Game } from '../game/game';
import { css, rgba } from './palette';
import { techRect } from './shapes';
import { wrapLines, type TouchHud } from './touchHud';

type Ctx = CanvasRenderingContext2D;

const UI_FONT = "'Bahnschrift', 'DIN Alternate', 'Segoe UI', system-ui, sans-serif";

/** Seconds of play before the first tip, so the sector banner has the stage. */
const START_DELAY = 2.5;
/** Pause between one tip finishing and the next appearing. */
const GAP = 1;
/** A tip nobody acts on retires after this long on screen, rather than nagging. */
const MAX_SHOWN = 14;
/** Purely informational tips retire after this long. */
const INFO_SHOWN = 6;

export type CoachEvent = 'pan' | 'pinch';

interface Anchor {
  x: number;
  y: number;
  /** Radius of the pulsing ring; 0 = no ring or pointer (screen-wide tip). */
  r: number;
}

/** Everything a tip's rules look at, gathered once per frame. */
interface Frame {
  game: Game;
  touch: TouchInput;
  hud: TouchHud;
  w: number;
  h: number;
}

interface Tip {
  id: string;
  text: () => string;
  /** The situation the tip is about is on screen right now. */
  ready: (f: Frame) => boolean;
  /**
   * The player has done the thing. Checked for every unfinished tip every
   * frame — shown or not — so a tip for something already discovered never
   * appears. `shown` is how long this tip has been visible so far.
   */
  done: (f: Frame, shown: number) => boolean;
  anchor: (f: Frame) => Anchor | null;
}

/**
 * Just-in-time touch tutorial.
 *
 * Replaces the old up-front legend: each gesture is explained the first time
 * it becomes relevant — the drawer when it first opens, ✓ on the first
 * placement, the long-press once there is something to press — with a callout
 * pointing at the control. One tip at a time; each is shown once per save and
 * is skipped entirely if the player already found the gesture on their own.
 */
export class Coach {
  private shown = 0;
  private cooldown = 0;
  private current: Tip | null = null;
  private stickTime = 0;
  private events = new Set<CoachEvent>();
  /** Structure count when the current placement began (-1 = not placing). */
  private builtBase = -1;
  private readonly tips: Tip[];

  /**
   * `doneList` is read through a getter: the save object can be swapped out
   * under us (reload, wipe), and a captured array would go stale.
   */
  constructor(private readonly doneList: () => string[], private readonly persist: () => void) {
    const btn = (f: Frame, id: Parameters<TouchInput['button']>[0]): Anchor | null => {
      const b = f.touch.button(id);
      return b && b.visible ? { x: b.x, y: b.y, r: b.r * 1.3 } : null;
    };
    const placedSince = (f: Frame) => this.builtBase >= 0 && f.game.buildings.length > this.builtBase;
    const calm = (f: Frame) => !f.touch.placing && !f.touch.drawerOpen && !f.hud.menu;

    // Order is priority: tips about the mode the player is in right now come
    // first, general ones after.
    this.tips = [
      {
        id: 'drawer',
        text: () => tr('coach.drawer', 'Tap a structure to build it · hold it for details'),
        ready: (f) => f.touch.drawerOpen,
        done: (f) => f.game.buildKind !== null || f.hud.drawerInfo !== null,
        anchor: (f) => ({ x: f.w / 2, y: f.hud.drawerTop, r: 0 }),
      },
      {
        id: 'place',
        text: () => tr('coach.place', 'Tap the map to aim, then ✓ to build'),
        ready: (f) => f.touch.placing && f.touch.confirmPlacement && !f.touch.drawerOpen,
        done: (f) => f.touch.placing && f.touch.confirmPlacement && placedSince(f),
        anchor: (f) => btn(f, 'confirm'),
      },
      {
        id: 'wall',
        text: () => tr('coach.wall', 'Tap to place · drag from the ghost to lay a line'),
        ready: (f) => f.touch.placing && !f.touch.confirmPlacement && !f.touch.drawerOpen,
        done: (f) => f.touch.placing && !f.touch.confirmPlacement && placedSince(f)
          && f.game.buildings.length >= this.builtBase + 2,
        anchor: (f) => ({ x: f.touch.mouseX, y: f.touch.mouseY - GHOST_LIFT, r: 26 * f.touch.scale }),
      },
      {
        id: 'look',
        text: () => tr('coach.look', 'Drag the map to look around'),
        ready: (f) => f.touch.placing && !f.touch.drawerOpen && (this.isDone('place') || this.isDone('wall')),
        done: () => this.events.has('pan'),
        anchor: (f) => ({ x: f.w / 2, y: f.h * 0.4, r: 0 }),
      },
      {
        id: 'threat',
        text: () => tr('coach.threat', 'Red arrows point at enemies off-screen'),
        ready: (f) => f.hud.threatAnchor !== null && calm(f),
        done: (_f, shown) => shown > INFO_SHOWN,
        anchor: (f) => f.hud.threatAnchor && { ...f.hud.threatAnchor, r: 22 * f.touch.scale },
      },
      {
        id: 'strike',
        text: () => tr('coach.strike', 'Orbital strike charged — tap ▼, then tap the map'),
        ready: (f) => calm(f) && f.game.strike.ready && !!f.touch.button('strike')?.visible,
        done: (f) => f.game.cursorMode === 'strike',
        anchor: (f) => btn(f, 'strike'),
      },
      {
        id: 'move',
        text: () => tr('coach.move', 'Drag here to move'),
        ready: (f) => calm(f),
        done: () => this.stickTime > 0.6,
        anchor: (f) => ({
          x: f.touch.southpaw ? f.w * 0.79 : f.w * 0.21,
          y: f.h * 0.72,
          r: 44 * f.touch.scale,
        }),
      },
      {
        id: 'build',
        text: () => tr('coach.build', 'Tap ⌂ to build defences'),
        ready: (f) => calm(f) && f.game.inBuildPhase,
        done: (f) => f.touch.drawerOpen,
        anchor: (f) => btn(f, 'build'),
      },
      {
        id: 'start',
        text: () => tr('coach.start', 'Ready? ▶ starts the wave early for bonus ore'),
        ready: (f) => calm(f) && f.game.buildings.length > 0 && !!f.touch.button('startWave')?.visible,
        // Only "learned" once seen, or used: the wave also starts on its own.
        done: (f, shown) => f.touch.button('startWave')?.tapped === true || (shown > 0 && !f.game.inBuildPhase),
        anchor: (f) => btn(f, 'startWave'),
      },
      {
        id: 'hold',
        text: () => tr('coach.hold', 'Hold a structure to upgrade, repair or sell it'),
        ready: (f) => calm(f) && this.holdTarget(f) !== null,
        done: (f) => f.hud.menu !== null,
        anchor: (f) => {
          const p = this.holdTarget(f);
          return p && { ...p, r: 30 * f.touch.scale };
        },
      },
      {
        id: 'pinch',
        text: () => tr('coach.pinch', 'Pinch with two fingers to zoom'),
        ready: (f) => calm(f) && f.game.waveIndex >= 1,
        done: (_f, shown) => this.events.has('pinch') || shown > INFO_SHOWN,
        anchor: (f) => ({ x: f.w / 2, y: f.h * 0.4, r: 0 }),
      },
    ];
  }

  /** Signals a gesture the coach can't read off game state. */
  saw(e: CoachEvent) { this.events.add(e); }

  private isDone(id: string) { return this.doneList().includes(id); }

  private finish(id: string) {
    if (this.isDone(id)) return;
    this.doneList().push(id);
    this.persist();
  }

  /**
   * A structure worth long-pressing: a damaged one on screen, or — from the
   * second wave on — any on screen, so the tip isn't gated on taking damage.
   */
  private holdTarget(f: Frame): { x: number; y: number } | null {
    const cam = f.game.camera;
    const s = f.touch.scale;
    let fallback: { x: number; y: number } | null = null;
    for (const b of f.game.buildings) {
      if (b.dead || !b.built) continue;
      const x = (b.x - cam.x) * cam.zoom + f.w / 2;
      const y = (b.y - cam.y) * cam.zoom + f.h / 2;
      // Clear of the top strip and the bottom control rows.
      if (x < 40 * s || x > f.w - 110 * s || y < 140 * s || y > f.h - 220 * s) continue;
      if (b.hp < b.maxHp) return { x, y };
      fallback ??= { x, y };
    }
    return f.game.waveIndex >= 1 ? fallback : null;
  }

  /** Resets per-run bookkeeping; learned tips stay learned. */
  reset() {
    this.current = null;
    this.shown = 0;
    this.cooldown = 0;
    this.builtBase = -1;
  }

  update(dt: number, game: Game, touch: TouchInput, hud: TouchHud, w: number, h: number) {
    const f: Frame = { game, touch, hud, w, h };
    if (touch.stick.active) this.stickTime += dt;
    // "Placed something" is measured per placement session, from entering
    // build mode to leaving it.
    if (touch.placing && this.builtBase < 0) this.builtBase = game.buildings.length;
    else if (!touch.placing) this.builtBase = -1;

    // Retire anything the player has already done, shown or not.
    for (const tip of this.tips) {
      if (this.isDone(tip.id)) continue;
      const shown = tip === this.current ? this.shown : 0;
      if (tip.done(f, shown) || shown > MAX_SHOWN) {
        this.finish(tip.id);
        if (tip === this.current) {
          this.current = null;
          this.cooldown = GAP;
        }
      }
    }

    // A tip whose situation has passed (drawer closed, placement cancelled)
    // steps aside without counting as learned.
    if (this.current && !this.current.ready(f)) this.current = null;

    if (!this.current) {
      this.cooldown -= dt;
      if (this.cooldown > 0 || game.elapsed < START_DELAY) return;
      this.current = this.tips.find((t) => !this.isDone(t.id) && t.ready(f)) ?? null;
      this.shown = 0;
      return;
    }
    this.shown += dt;
  }

  draw(ctx: Ctx, game: Game, touch: TouchInput, hud: TouchHud, w: number, h: number) {
    const tip = this.current;
    if (!tip) return;
    const f: Frame = { game, touch, hud, w, h };
    const anchor = tip.anchor(f);
    const s = touch.scale;
    // Ease in over the first ~0.25s so a tip doesn't pop.
    const alpha = clamp(this.shown * 4, 0, 1);
    const pulse = 0.5 + 0.5 * Math.sin(game.elapsed * 5);

    ctx.save();
    ctx.globalAlpha = alpha;

    if (anchor && anchor.r > 0) {
      ctx.strokeStyle = rgba(0xffb347, 0.35 + 0.5 * pulse);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, anchor.r + pulse * 6 * s, 0, TAU);
      ctx.stroke();
    }

    const pad = Math.round(12 * s);
    const lineH = Math.round(17 * s);
    ctx.font = `600 ${Math.round(13 * s)}px ${UI_FONT}`;
    const maxW = Math.min(w - 32 * s, 300 * s);
    const lines = wrapLines(ctx, [tip.text()], ' ', maxW - pad * 2, 3);
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const bh = lines.length * lineH + pad * 2 - 4 * s;

    // Beside the anchor: above it in the lower half of the screen, below it in
    // the upper half, pulled inward so it never leaves the screen.
    const ax = anchor ? anchor.x : w / 2;
    const ay = anchor ? anchor.y : h * 0.4;
    const gap = (anchor?.r ?? 0) + 14 * s;
    const above = ay > h * 0.5;
    const bx = clamp(ax - bw / 2, 12 * s, w - bw - 12 * s);
    const by = clamp(above ? ay - gap - bh : ay + gap, hud.hintArea.top, h - bh - 12 * s);

    ctx.fillStyle = 'rgba(20,14,4,0.94)';
    techRect(ctx, bx, by, bw, bh, 9);
    ctx.fill();
    ctx.strokeStyle = rgba(0xffb347, 0.85);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Pointer nub toward the anchor.
    if (anchor && anchor.r > 0) {
      const nx = clamp(ax, bx + 14 * s, bx + bw - 14 * s);
      const ny = above ? by + bh : by;
      const dir = above ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(nx - 7 * s, ny);
      ctx.lineTo(nx + 7 * s, ny);
      ctx.lineTo(nx, ny + dir * 8 * s);
      ctx.closePath();
      ctx.fillStyle = rgba(0xffb347, 0.85);
      ctx.fill();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = css(0xffe2b8);
    lines.forEach((l, i) => ctx.fillText(l, bx + bw / 2, by + pad - 2 * s + lineH * (i + 0.5)));
    ctx.restore();
  }
}
