import { audio } from '../../core/audio';
import { t as tr } from '../../core/i18n';
import { TAU, dist, rand } from '../../core/math';
import { PKind } from '../../engine/particles';
import { Pickup, type PickupKind } from '../entities';
import type { Game } from '../game';

const MAX_PICKUPS = 500;

/** Loot drops: ore/essence/health/relic pickups dropped in the world, homing in on and collected by the player. */
export class PickupSystem {
  readonly pickups: Pickup[] = [];

  constructor(private game: Game) {}

  dropPickup(x: number, y: number, kind: PickupKind, amount: number) {
    let p = this.pickups.find((q) => q.dead);
    if (!p) {
      if (this.pickups.length >= MAX_PICKUPS) return;
      p = new Pickup();
      this.pickups.push(p);
    }
    p.dead = false;
    p.kind = kind;
    p.amount = amount;
    p.x = x + rand(-8, 8);
    p.y = y + rand(-8, 8);
    const a = rand(0, TAU);
    const s = rand(40, 130);
    p.vx = Math.cos(a) * s;
    p.vy = Math.sin(a) * s;
    p.life = 26;
    p.bob = rand(0, TAU);
    p.homing = false;
    p.homeSpeed = 0;
    p.radius = kind === 'relic' ? 10 : 7;
  }

  updatePickups(dt: number) {
    const g = this.game;
    const p = g.player;
    const grab = 96 * g.perks.pickupRadius;
    for (const q of this.pickups) {
      if (q.dead) continue;
      q.life -= dt;
      q.bob += dt * 5;
      if (q.life <= 0) { q.dead = true; continue; }

      const d = dist(q.x, q.y, p.x, p.y);
      if (!p.dead && (q.homing || d < grab)) {
        q.homing = true;
        q.homeSpeed = Math.min(760, q.homeSpeed + dt * 1500);
        const nx = (p.x - q.x) / (d || 1), ny = (p.y - q.y) / (d || 1);
        q.vx = nx * q.homeSpeed;
        q.vy = ny * q.homeSpeed;
      } else {
        q.vx *= Math.exp(-3.4 * dt);
        q.vy *= Math.exp(-3.4 * dt);
      }
      q.x += q.vx * dt;
      q.y += q.vy * dt;

      if (!p.dead && d < p.radius + q.radius + 4) {
        this.collect(q);
        q.dead = true;
      }
    }
  }

  private collect(q: Pickup) {
    const g = this.game;
    switch (q.kind) {
      case 'essence':
        g.essence += q.amount;
        g.buffers.essence += q.amount;
        g.runStats.essenceCollected += q.amount;
        audio.play('pickupEssence', rand(0.95, 1.1));
        g.particles.spawn(q.x, q.y, 0, -40, 0.3, 6, 0xb47cff, PKind.Glow);
        break;
      case 'ore':
        g.ore += q.amount;
        g.buffers.ore += q.amount;
        audio.play('pickup', rand(0.95, 1.1));
        break;
      case 'health':
        g.player.hp = Math.min(g.player.maxHp, g.player.hp + q.amount);
        audio.play('pickup', 1.2);
        g.particles.ring(g.player.x, g.player.y, 24, 0x5cf2a0, 0.3);
        break;
      case 'relic':
        g.progress.awardRelics(q.amount);
        audio.play('levelUp');
        g.setBanner(
          tr('game.banner.relicRecovered', 'RELIC RECOVERED'),
          tr('game.banner.relicRecoveredDetail', 'Permanent account currency'),
          2.6, '#ffcc55',
        );
        break;
    }
  }
}
