import { audio } from '../../core/audio';
import { t as tr } from '../../core/i18n';
import { clamp, dist } from '../../core/math';
import type { Enemy } from '../entities';
import type { Game } from '../game';

/**
 * Orbital strike — the player's charged active ability.
 *
 * Kills charge it (bigger enemies more); once full it can be called onto any
 * point: a telegraph ring marks the spot, and a beam lands STRIKE_DELAY later
 * for heavy area damage that falls off toward the edge. It gives the player
 * something to decide mid-fight beyond dash — especially on touch, where aim
 * and fire are automatic — and a way to save a flank the defences missed.
 */

/** Kill points to fill the charge. A kill is worth 1 + maxHp/100 (capped). */
export const STRIKE_COST = 30;
/** Seconds between calling the strike and the beam landing. */
export const STRIKE_DELAY = 1;
/** World px. About 8 tiles across — a clump, not a lane. */
export const STRIKE_RADIUS = 130;
/** Base damage at the centre, before the per-wave ramp. */
const STRIKE_DAMAGE = 320;
/** One kill never fills more than this — a boss kill shouldn't hand out two strikes' worth. */
const MAX_POINTS_PER_KILL = 8;

interface PendingStrike {
  x: number;
  y: number;
  t: number;
}

export class StrikeSystem {
  /** Kill points banked, 0..STRIKE_COST. */
  charge = 0;
  private readonly pending: PendingStrike[] = [];

  constructor(private readonly game: Game) {}

  get ready() { return this.charge >= STRIKE_COST; }
  /** 0..1, for the HUD. */
  get pct() { return clamp(this.charge / STRIKE_COST, 0, 1); }
  /** Strikes called but not landed yet (their telegraph is on the map). */
  get incoming(): readonly PendingStrike[] { return this.pending; }

  /** Centre damage right now: ramps with the wave so it stays relevant late. */
  get damage() { return Math.round(STRIKE_DAMAGE * (1 + 0.12 * this.game.waveIndex)); }

  reset() {
    this.charge = 0;
    this.pending.length = 0;
  }

  onKill(e: Enemy) {
    if (this.ready) return;
    const pts = Math.min(MAX_POINTS_PER_KILL, 1 + e.maxHp / 100);
    const wasReady = this.ready;
    this.charge = Math.min(STRIKE_COST, this.charge + pts);
    if (!wasReady && this.ready) audio.play('levelUp');
  }

  /**
   * Calls the strike onto a world point. Returns false (with the usual error
   * toast) while it's still charging.
   */
  call(x: number, y: number): boolean {
    const g = this.game;
    if (!this.ready) {
      this.explainNotReady();
      return false;
    }
    this.charge = 0;
    const wx = clamp(x, 0, g.world.pxW), wy = clamp(y, 0, g.world.pxH);
    this.pending.push({ x: wx, y: wy, t: STRIKE_DELAY });
    g.effects.push({
      kind: 'telegraph', x: wx, y: wy, x2: wx, y2: wy,
      radius: STRIKE_RADIUS, life: STRIKE_DELAY, maxLife: STRIKE_DELAY,
      color: 0x9fe8ff, width: 3, seed: 0,
    });
    audio.play('waveStart', 1.4);
    return true;
  }

  /** The "still charging" toast, with how far along it is. */
  explainNotReady() {
    this.game.presentation.error(tr('game.error.strikeCharging', 'Orbital strike charging — {pct}%',
      { pct: Math.floor(this.pct * 100) }));
  }

  update(dt: number) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const s = this.pending[i];
      s.t -= dt;
      if (s.t > 0) continue;
      this.pending.splice(i, 1);
      this.land(s.x, s.y);
    }
  }

  private land(x: number, y: number) {
    const g = this.game;
    const dmg = this.damage;
    // Snapshot the victims first: damage can kill and splice as we go.
    const list = g.enemyHash.query(x, y, STRIKE_RADIUS, g.queryBuf);
    const hit: Enemy[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = g.enemies[list[i]];
      if (e && !e.dead && e.targetable && dist(x, y, e.x, e.y) <= STRIKE_RADIUS + e.radius) hit.push(e);
    }
    for (const e of hit) {
      // Full damage in the middle, 60% at the rim.
      const falloff = 1 - 0.4 * clamp(dist(x, y, e.x, e.y) / STRIKE_RADIUS, 0, 1);
      g.damageEnemy(e, dmg * falloff, {
        source: 'ability', armorPierce: 999, dirX: e.x - x, dirY: e.y - y,
      });
    }

    g.effects.push({
      kind: 'beam', x, y: y - 900, x2: x, y2: y,
      radius: 0, life: 0.4, maxLife: 0.4, color: 0x9fe8ff, width: 26, seed: 0,
    });
    g.effects.push({
      kind: 'shock', x, y, x2: x, y2: y,
      radius: STRIKE_RADIUS * 1.25, life: 0.55, maxLife: 0.55, color: 0x9fe8ff, width: 10, seed: 0,
    });
    g.particles.ring(x, y, STRIKE_RADIUS, 0x9fe8ff, 0.5);
    g.particles.dust(x, y, g.level.palette.rockLit, 24);
    g.presentation.addFlash(159, 232, 255, 0.35);
    g.presentation.hitstop = Math.max(g.presentation.hitstop, 0.08);
    g.shake(18);
    audio.play('explodeBig');
  }
}
