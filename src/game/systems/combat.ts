import { audio } from '../../core/audio';
import {
  clamp, dist, dist2, rand, rotateToward,
} from '../../core/math';
import { PKind } from '../../engine/particles';
import type { BuildingDef } from '../../data/buildings';
import { Building, type Enemy, Projectile } from '../entities';
import { TILE } from '../world';
import type { Game } from '../game';

const MAX_PROJECTILES = 900;
/** How long a Weaver web silences a turret it lands on. */
export const WEB_TURRET_SECONDS = 4;
/** How long a web slows the pilot. */
export const WEB_PLAYER_SECONDS = 2.5;

/**
 * Projectile lifecycle (pooled — see `getProjectile`) and the area-damage
 * paths that spend out of it: line-of-effect beams (`damageAlongLine`),
 * splash on death/timeout (`detonate`), and generic radial damage (`explode`,
 * shared by boss slams, wrecked generators, and splash weapons alike).
 */
export class CombatSystem {
  readonly projectiles: Projectile[] = [];

  constructor(private game: Game) {}

  damageAlongLine(x0: number, y0: number, x1: number, y1: number, width: number, damage: number) {
    const g = this.game;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len, ny = dy / len;

    const hitBody = (b: { x: number; y: number; radius: number }) => {
      const rx = b.x - x0, ry = b.y - y0;
      const t = rx * nx + ry * ny;
      if (t < 0 || t > len) return false;
      return Math.abs(rx * ny - ry * nx) < width + b.radius;
    };

    for (let i = g.buildings.length - 1; i >= 0; i--) {
      const b = g.buildings[i];
      if (hitBody(b) && !g.absorbIntoField(b.x, b.y, damage)) g.damageBuilding(b, damage);
    }
    if (hitBody(g.core) && !g.absorbIntoField(g.core.x, g.core.y, damage)) g.damageCore(damage);
    if (!g.player.dead && hitBody(g.player) &&
        !g.absorbIntoField(g.player.x, g.player.y, damage * 0.5)) {
      g.damagePlayer(damage * 0.5);
    }
  }

  fire(o: {
    x: number; y: number; angle: number; speed: number; damage: number;
    kind: Projectile['kind']; faction: Projectile['faction']; color: number;
    size: number; life: number; armorPierce: number; ownerId: number; splash: number;
    pierce?: number; slowFactor?: number;
    homingTarget?: Enemy | null; homingTurn?: number;
  }) {
    const p = this.getProjectile();
    if (!p) return;
    p.dead = false;
    p.x = o.x; p.y = o.y;
    p.vx = Math.cos(o.angle) * o.speed;
    p.vy = Math.sin(o.angle) * o.speed;
    p.kind = o.kind;
    p.faction = o.faction;
    p.damage = o.damage;
    p.splash = o.splash;
    p.armorPierce = o.armorPierce;
    p.pierce = o.pierce ?? 0;
    p.life = o.life;
    p.maxLife = o.life;
    p.color = o.color;
    p.size = o.size;
    p.radius = Math.max(2, o.size * 0.7);
    p.ownerId = o.ownerId;
    p.hitIds.length = 0;
    p.z = 0;
    p.flightTime = 0;
    p.flightTotal = 0;
    p.trail = 0;
    p.exhaust = 0;
    p.slowFactor = o.slowFactor ?? 0;
    p.target = o.homingTarget ?? null;
    p.homingTurn = o.homingTurn ?? 0;
  }

  fireMortar(
    x: number, y: number, tx: number, ty: number,
    damage: number, def: BuildingDef, owner: Building, flight: number,
  ) {
    const g = this.game;
    const p = this.getProjectile();
    if (!p) return;
    p.dead = false;
    p.kind = 'mortar';
    p.faction = 'player';
    p.x = x; p.y = y;
    p.targetX = clamp(tx, 0, g.world.pxW);
    p.targetY = clamp(ty, 0, g.world.pxH);
    p.vx = (p.targetX - x) / flight;
    p.vy = (p.targetY - y) / flight;
    p.damage = damage;
    p.splash = def.splash ?? 80;
    p.armorPierce = (def.armorPierce ?? 0) + g.perks.armorShred;
    p.life = flight;
    p.maxLife = flight;
    p.flightTotal = flight;
    p.flightTime = 0;
    p.color = 0xffb066;
    p.size = 6;
    p.radius = 5;
    p.ownerId = owner.id;
    p.hitIds.length = 0;
    p.pierce = 0;
  }

  private getProjectile(): Projectile | null {
    for (const p of this.projectiles) if (p.dead) return p;
    if (this.projectiles.length >= MAX_PROJECTILES) return null;
    const p = new Projectile();
    this.projectiles.push(p);
    return p;
  }

  updateProjectiles(dt: number) {
    const g = this.game;
    for (const p of this.projectiles) {
      if (p.dead) {
        // Pooled slots must not pin a dead Enemy alive through their lock.
        if (p.target) p.target = null;
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) {
        if (p.kind === 'mortar' || p.splash > 0) this.detonate(p);
        p.dead = true;
        continue;
      }

      if (p.homingTurn > 0) this.guide(p, dt);

      if (p.kind === 'mortar') {
        p.flightTime += dt;
        const t = clamp(p.flightTime / p.flightTotal, 0, 1);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z = Math.sin(t * Math.PI) * 110;
        if (t >= 1) { this.detonate(p); p.dead = true; }
        continue;
      }

      const steps = Math.hypot(p.vx, p.vy) * dt > 18 ? 2 : 1;
      const sdt = dt / steps;
      for (let s = 0; s < steps && !p.dead; s++) {
        p.x += p.vx * sdt;
        p.y += p.vy * sdt;

        if (p.x < 0 || p.y < 0 || p.x > g.world.pxW || p.y > g.world.pxH) { p.dead = true; break; }
        if (g.world.solidAtPx(p.x, p.y)) {
          g.particles.impact(p.x, p.y, Math.atan2(p.vy, p.vx), g.level.palette.rockLit, 0.9);
          if (p.splash > 0) this.detonate(p);
          p.dead = true;
          break;
        }

        if (p.faction === 'player') this.projectileVsEnemies(p);
        else this.projectileVsPlayerSide(p);
      }

      // Trails.
      p.trail += dt;
      if (p.trail > 0.012) {
        p.trail = 0;
        g.particles.spawn(p.x, p.y, 0, 0, p.kind === 'bullet' ? 0.07 : 0.16,
          p.size * 0.8, p.color, PKind.Trail, { drag: 0.5 });
      }

      // Rocket exhaust: a fatter smoke plume behind the warhead.
      if (p.kind === 'rocket') {
        p.exhaust += dt;
        if (p.exhaust > 0.03) {
          p.exhaust = 0;
          const a = Math.atan2(p.vy, p.vx) + Math.PI;
          const bx = p.x + Math.cos(a) * p.size;
          const by = p.y + Math.sin(a) * p.size;
          g.particles.spawn(bx, by,
            Math.cos(a) * rand(20, 70) + rand(-18, 18),
            Math.sin(a) * rand(20, 70) + rand(-18, 18),
            rand(0.35, 0.8), rand(4, 8), 0x6b7383, PKind.Smoke,
            { drag: 1.6, additive: false });
          g.particles.spawn(bx, by, Math.cos(a) * rand(40, 120), Math.sin(a) * rand(40, 120),
            rand(0.08, 0.2), rand(2, 4), 0xffb066, PKind.Ember, { drag: 5 });
        }
      }
    }
  }

  /**
   * Steers a guided projectile toward its lock. The turn rate is deliberately
   * finite: fast fliers can out-turn a missile, which is what keeps the Missile
   * Battery from being a strict upgrade over cheaper anti-air.
   */
  private guide(p: Projectile, dt: number) {
    const g = this.game;
    let t = p.target;
    if (!t || t.dead || !t.targetable) {
      // Re-acquire the nearest live target ahead of the warhead, or fly on straight.
      const list = g.enemyHash.query(p.x, p.y, 220, g.queryBuf);
      let best: Enemy | null = null;
      let bestD = 220 * 220;
      for (let i = 0; i < list.length; i++) {
        const e = g.enemies[list[i]];
        if (!e || e.dead || !e.targetable) continue;
        const d2 = dist2(p.x, p.y, e.x, e.y);
        if (d2 < bestD) { bestD = d2; best = e; }
      }
      p.target = best;
      t = best;
      if (!t) return;
    }

    const speed = Math.hypot(p.vx, p.vy) || 1;
    // Lead the target slightly so the missile curves ahead of it, not behind.
    const eta = dist(p.x, p.y, t.x, t.y) / speed;
    const aimX = t.x + t.vx * eta * 0.55;
    const aimY = t.y + t.vy * eta * 0.55;

    const cur = Math.atan2(p.vy, p.vx);
    const want = Math.atan2(aimY - p.y, aimX - p.x);
    const next = rotateToward(cur, want, p.homingTurn * dt);
    p.vx = Math.cos(next) * speed;
    p.vy = Math.sin(next) * speed;
  }

  private projectileVsEnemies(p: Projectile) {
    const g = this.game;
    const list = g.enemyHash.query(p.x, p.y, p.radius + 26, g.queryBuf);
    for (let i = 0; i < list.length; i++) {
      const e = g.enemies[list[i]];
      if (!e || e.dead || !e.targetable) continue;
      if (p.hitIds.includes(e.id)) continue;
      const rr = e.radius + p.radius;
      if (dist2(p.x, p.y, e.x, e.y) > rr * rr) continue;

      if (p.splash > 0) {
        this.detonate(p);
        p.dead = true;
        return;
      }
      g.damageEnemy(e, p.damage, {
        source: 'turret', armorPierce: p.armorPierce, dirX: p.vx, dirY: p.vy,
      });
      if (p.slowFactor) { e.slowTimer = Math.max(e.slowTimer, 1.4); e.slowFactor = p.slowFactor; }
      p.hitIds.push(e.id);
      if (p.pierce > 0) { p.pierce--; p.damage *= 0.78; }
      else { p.dead = true; return; }
    }
  }

  private projectileVsPlayerSide(p: Projectile) {
    const g = this.game;
    // Buildings.
    const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
    const b = g.buildingAtTile(tx, ty);
    if (b) {
      if (g.absorbIntoField(p.x, p.y, p.damage)) { p.dead = true; return; }
      if (p.kind === 'web') {
        // Webs don't break structures; they gum turrets up.
        if (b.isTurret) b.webbed = Math.max(b.webbed, WEB_TURRET_SECONDS);
        g.damageBuilding(b, p.damage);
        g.particles.ring(p.x, p.y, 14, 0xe8f0ff, 0.35);
        p.dead = true;
        return;
      }
      if (p.splash > 0) { this.detonate(p); p.dead = true; return; }
      g.damageBuilding(b, p.damage);
      g.particles.impact(p.x, p.y, Math.atan2(p.vy, p.vx), p.color, 1);
      p.dead = true;
      return;
    }
    const rc = g.core.radius + p.radius;
    if (dist2(p.x, p.y, g.core.x, g.core.y) < rc * rc) {
      if (g.absorbIntoField(p.x, p.y, p.damage)) { p.dead = true; return; }
      if (p.splash > 0) { this.detonate(p); p.dead = true; return; }
      g.damageCore(p.damage);
      p.dead = true;
      return;
    }
    if (!g.player.dead) {
      const rp = g.player.radius + p.radius;
      if (dist2(p.x, p.y, g.player.x, g.player.y) < rp * rp) {
        if (g.absorbIntoField(p.x, p.y, p.damage)) { p.dead = true; return; }
        if (p.kind === 'web') g.player.webbed = Math.max(g.player.webbed, WEB_PLAYER_SECONDS);
        else if (p.splash > 0) { this.detonate(p); p.dead = true; return; }
        g.damagePlayer(p.damage);
        p.dead = true;
      }
    }
  }

  private detonate(p: Projectile) {
    const g = this.game;
    const r = p.splash || 40;
    this.explode(p.x, p.y, r, p.damage, p.faction, p.armorPierce);
    g.particles.explosion(p.x, p.y, r * 0.7, p.color, g.level.palette.rock);
    audio.play(r > 90 ? 'explodeBig' : 'explode', rand(0.9, 1.1));
    // Only genuinely large blasts move the camera. Cannon/flak/rocket shells land
    // several times a second, and shaking on each one turns the whole fight to mush.
    if (r >= 95) g.shake(clamp(r * 0.035, 2, 7));
  }

  /** Radial damage. `faction` is the *attacker*; splash never hits its own side. */
  explode(x: number, y: number, radius: number, damage: number, faction: 'player' | 'hive', pierce = 0) {
    const g = this.game;
    const r2 = radius * radius;
    g.effects.push({
      kind: 'shock', x, y, x2: 0, y2: 0, radius,
      life: 0.32, maxLife: 0.32, color: 0xffc06a, width: 5, seed: 0,
    });

    if (faction === 'player') {
      let chained = 0;
      const list = g.enemyHash.query(x, y, radius, g.queryBuf);
      for (let i = 0; i < list.length; i++) {
        const e = g.enemies[list[i]];
        if (!e || e.dead || !e.targetable) continue;
        const d2 = dist2(x, y, e.x, e.y);
        if (d2 > r2) continue;
        const falloff = 1 - Math.sqrt(d2) / radius * 0.55;
        const before = e.dead;
        g.damageEnemy(e, damage * falloff, {
          source: 'turret', armorPierce: pierce,
          dirX: e.x - x, dirY: e.y - y,
        });
        if (!before && e.dead) chained++;
      }
      if (chained >= 12) g.progress.bump('chainKill');
    } else {
      for (let i = g.buildings.length - 1; i >= 0; i--) {
        const b = g.buildings[i];
        const d2 = dist2(x, y, b.x, b.y);
        if (d2 > r2) continue;
        g.damageBuilding(b, damage * (1 - Math.sqrt(d2) / radius * 0.5));
      }
      if (dist2(x, y, g.core.x, g.core.y) < r2) {
        g.damageCore(damage * 0.8);
      }
      if (!g.player.dead && dist2(x, y, g.player.x, g.player.y) < r2) {
        g.damagePlayer(damage * 0.7);
      }
      // Drones are caught by area damage too. Without this, automation would be
      // entirely risk-free and the whole trade would collapse.
      for (let i = g.drones.length - 1; i >= 0; i--) {
        const d = g.drones[i];
        if (d.dead) continue;
        const dd2 = dist2(x, y, d.x, d.y);
        if (dd2 > r2) continue;
        g.damageDrone(d, damage * (1 - Math.sqrt(dd2) / radius * 0.5));
      }
    }
  }
}
