import { audio } from '../../core/audio';
import { t as tr } from '../../core/i18n';
import { clamp, damp, dist2, rand } from '../../core/math';
import type { Core, Enemy } from '../entities';
import type { Game } from '../game';

/** The reactor: its passive regen/shield tick, its weak built-in gun, damage, and the loss condition. */
export class CoreSystem {
  core!: Core;

  constructor(private game: Game) {}

  updateCore(dt: number) {
    const g = this.game;
    const c = this.core;
    c.hitFlash = Math.max(0, c.hitFlash - dt * 4);
    c.reviveFlash = Math.max(0, c.reviveFlash - dt * 1.6);
    c.spin += dt * 0.5;
    c.distress = damp(c.distress, 1 - c.pct, 3, dt);
    if (g.perks.coreRegen > 0 && c.hp < c.maxHp && c.hp > 0) {
      c.hp = Math.min(c.maxHp, c.hp + g.perks.coreRegen * dt);
    }
    if (c.maxShield > 0) {
      c.shield = Math.min(c.maxShield, c.shield + c.maxShield * 0.08 * dt);
    }

    // The core has a weak built-in gun so you are never completely helpless.
    if (g.phase === 'combat' || g.phase === 'boss' || g.phase === 'incoming') {
      c.spin += dt;
      if ((g.elapsed % 0.5) < dt) {
        const list = g.enemyHash.query(c.x, c.y, 230, g.queryBuf);
        let best: Enemy | null = null;
        let bd = 230 * 230;
        for (let i = 0; i < list.length; i++) {
          const e = g.enemies[list[i]];
          if (!e || e.dead || !e.targetable) continue;
          const d2 = dist2(c.x, c.y, e.x, e.y);
          if (d2 < bd) { bd = d2; best = e; }
        }
        if (best) {
          const a = Math.atan2(best.y - c.y, best.x - c.x);
          g.fire({
            x: c.x + Math.cos(a) * c.radius, y: c.y + Math.sin(a) * c.radius,
            angle: a, speed: 700, damage: 14 * g.perks.turretDamage, kind: 'bullet',
            faction: 'player', color: 0x7fd9ff, size: 3.6, life: 0.6,
            armorPierce: 2 + g.perks.armorShred, ownerId: -1, splash: 0,
          });
          audio.play('shoot', 1.2);
        }
      }
    }
  }

  damageCore(amount: number) {
    const g = this.game;
    if (g.phase === 'lost' || g.phase === 'won') return;
    const c = this.core;
    let dmg = amount;
    if (c.shield > 0) {
      const absorbed = Math.min(c.shield, dmg);
      c.shield -= absorbed;
      dmg -= absorbed;
      if (dmg <= 0) return;
    }
    c.hp -= dmg;
    c.hitFlash = 1;
    g.coreDamageThisWave += dmg;
    g.runStats.coreDamage += dmg;
    g.progress.bump('coreDamage', Math.round(dmg));
    g.shake(clamp(dmg * 0.08, 2, 9));
    audio.play('coreHit', rand(0.9, 1.1));
    g.addFlash(1, 0.25, 0.3, clamp(dmg / 300, 0.06, 0.3));

    if (c.hp <= 0) {
      if (g.perks.revives > 0) {
        g.perks.revives--;
        c.hp = c.maxHp * 0.3;
        c.reviveFlash = 1;
        g.explode(c.x, c.y, 320, 400, 'player', 999);
        g.setBanner(
          tr('game.banner.contingencyCore', 'CONTINGENCY CORE'),
          tr('game.banner.contingencyCoreDetail', 'The core reboots at 30%'),
          3.4, '#7dfff0',
        );
        audio.play('victory');
        g.shake(24);
        g.addFlash(0.6, 1, 1, 0.7);
        g.presentation.hitstop = 0.4;
      } else {
        c.hp = 0;
        this.loseRun();
      }
    }
  }

  private loseRun() {
    const g = this.game;
    const c = this.core;
    if (g.mode === 'endless') {
      // Endless has no victory condition, so the score is banked on death.
      g.endlessRecord = g.progress.recordEndlessResult(g.levelIndex, g.waveIndex);
      g.lastRelicAward = g.progress.awardEndlessRelics(g.waveIndex);
    }
    g.setPhase('lost');
    g.frozen = true;
    g.discardSavedRun();
    audio.play('gameOver');
    audio.stopMusic();
    g.presentation.hitstop = 0.7;
    g.shake(30);
    g.addFlash(1, 0.1, 0.1, 0.8);
    g.particles.explosion(c.x, c.y, 260, 0xff4f5e, g.level.palette.rock);
  }
}
