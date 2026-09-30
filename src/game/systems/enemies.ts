import { audio } from '../../core/audio';
import {
  TAU, chance, clamp, dist, dist2, damp, rand, randInt, rotateToward,
} from '../../core/math';
import { PKind } from '../../engine/particles';
import type { SpatialHash } from '../../engine/spatial';
import { ELITE_AFFIXES, ENEMIES, type EnemyDef } from '../../data/enemies';
import { Building, Enemy } from '../entities';
import { HAZARD_DPS, TILE, Tile } from '../world';
import type { Game } from '../game';

/** Damage after flat armour, never fully negated. */
function mitigate(amount: number, armor: number, pierce: number): number {
  const a = Math.max(0, armor - pierce);
  return Math.max(amount * 0.15, amount - a);
}

/**
 * The hive: enemy AI (movement, targeting, melee/ranged attacks, boss
 * ability telegraph/cast/resolve), and the damage/death pipeline that feeds
 * loot and splitter spawns back out through `Game`.
 */
export class EnemySystem {
  readonly enemies: Enemy[] = [];
  enemyHash!: SpatialHash;
  queryBuf: number[] = [];
  private flowOut = { x: 0, y: 0 };

  constructor(private game: Game) {}

  spawnEnemy(def: EnemyDef, x: number, y: number, hpMult: number, dmgMult: number, elite: boolean): Enemy {
    const e = new Enemy(def, x, y, hpMult * (elite ? 1.9 : 1), dmgMult * (elite ? 1.4 : 1));
    e.elite = elite;
    if (elite) {
      e.radius *= 1.18;
      // Every elite rolls a modifier (data/enemies.ts ELITE_AFFIXES). Seeded
      // RNG, so a replayed seed gets the same elites.
      e.affix = ELITE_AFFIXES[Math.floor(this.game.rng.next() * ELITE_AFFIXES.length)];
      if (e.affix === 'shielded') {
        e.shieldMax = Math.round(e.maxHp * 0.6);
        e.shieldHp = e.shieldMax;
      }
    }
    this.enemies.push(e);
    return e;
  }

  rebuildEnemyHash() {
    this.enemyHash.clear();
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      this.enemyHash.insert(i, e.x, e.y);
    }
  }

  updateEnemies(dt: number) {
    const g = this.game;
    const world = g.world;
    const field = world.field;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.dead) { this.enemies.splice(i, 1); continue; }

      e.anim += dt;
      e.hitFlash = Math.max(0, e.hitFlash - dt * 6);
      e.slowTimer = Math.max(0, e.slowTimer - dt);
      e.stunTimer = Math.max(0, e.stunTimer - dt);
      e.retargetIn -= dt;
      e.attackCooldown -= dt;

      if (e.burnTimer > 0) {
        e.burnTimer -= dt;
        this.damageEnemy(e, e.burnDps * dt, { source: 'burn', silent: true, armorPierce: 999 });
        if (e.dead) continue;
        if (chance(dt * 10)) {
          g.particles.spawn(e.x + rand(-6, 6), e.y + rand(-6, 6), rand(-10, 10), rand(-50, -20),
            rand(0.2, 0.5), rand(2, 4), 0xff8a3c, PKind.Ember);
        }
      }

      // Hazard terrain: grounded units only — fliers and submerged burrowers
      // already ignore the tile grid entirely for movement, same exemption here.
      if (!e.flying && !e.submerged &&
          g.world.tileAt(Math.floor(e.x / TILE), Math.floor(e.y / TILE)) === Tile.Hazard) {
        this.damageEnemy(e, HAZARD_DPS * dt, { source: 'burn', silent: true, armorPierce: 999 });
        if (e.dead) continue;
        if (chance(dt * 10)) {
          g.particles.spawn(e.x + rand(-6, 6), e.y + rand(-6, 6), rand(-10, 10), rand(-50, -20),
            rand(0.2, 0.5), rand(2, 4), g.level.palette.hazardColor, PKind.Ember);
        }
      }

      // Regen elites knit back together once they've gone a moment unhit.
      if (e.affix === 'regen' && e.hp < e.maxHp && g.elapsed - e.lastHitAt > 1.5) {
        e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.06 * dt);
        if (chance(dt * 6)) {
          g.particles.spawn(e.x + rand(-e.radius, e.radius), e.y + rand(-e.radius, e.radius),
            0, rand(-40, -20), rand(0.3, 0.6), rand(2, 3), 0x5cf2a0, PKind.Glow);
        }
      }

      // Centipede bodies: remember where the head has been so the segments
      // can trail along the same path (render only — the unit is its head).
      if (e.trail) {
        const seg = e.radius * 0.95;
        const maxPts = e.boss ? 16 : 4;
        if (dist2(e.x, e.y, e.trail[0], e.trail[1]) >= seg * seg) {
          e.trail.unshift(e.x, e.y);
          if (e.trail.length > maxPts * 2) e.trail.length = maxPts * 2;
        }
      }

      // An ability dive (the Scolopendra's 'burrow') — ordinary burrowers run
      // their own cycle below. Surfacing may erupt with a slam.
      if (e.submerged && e.def.behavior !== 'burrower') {
        e.burrowTimer -= dt;
        if (chance(dt * 20)) g.particles.dust(e.x, e.y, g.level.palette.rockLit, 2);
        if (e.burrowTimer <= 0) {
          e.submerged = false;
          if (e.emergeSlam) {
            e.emergeSlam = false;
            g.explode(e.x, e.y, 170, e.damage * 2.2, 'hive');
            g.effects.push({
              kind: 'shock', x: e.x, y: e.y, x2: 0, y2: 0,
              radius: 170, life: 0.5, maxLife: 0.5, color: e.def.accent, width: 8, seed: 0,
            });
            g.particles.explosion(e.x, e.y, 60, e.def.accent, g.level.palette.rock);
            audio.play('explodeBig');
            g.shake(18);
          }
        }
      }

      // Not boss-exclusive despite the name: any def with an `abilities` array
      // gets the same telegraph/cast/resolve loop — e.g. the Broodmother's
      // `spawn` uses this to reinforce the wave without being a wave boss.
      if (e.def.abilities) this.updateBossAbilities(e, dt);

      // Burrowers periodically submerge and phase through everything.
      if (e.def.behavior === 'burrower') {
        e.burrowCooldown -= dt;
        if (e.submerged) {
          e.burrowTimer -= dt;
          if (e.burrowTimer <= 0) {
            e.submerged = false;
            e.burrowCooldown = e.def.phaseInterval ?? 4.5;
            g.particles.explosion(e.x, e.y, 30, e.def.accent, g.level.palette.rock);
            audio.play('kill');
          }
        } else if (e.burrowCooldown <= 0) {
          e.submerged = true;
          e.burrowTimer = 2.4;
          g.particles.dust(e.x, e.y, g.level.palette.rockLit, 10);
        }
      }

      // Support aura.
      if (e.def.behavior === 'support' && e.def.auraRadius) {
        e.auraPhase += dt * 2;
        const r2 = e.def.auraRadius * e.def.auraRadius;
        const list = this.enemyHash.query(e.x, e.y, e.def.auraRadius, this.queryBuf);
        for (let k = 0; k < list.length; k++) {
          const o = this.enemies[list[k]];
          if (!o || o === e || o.dead) continue;
          if (dist2(e.x, e.y, o.x, o.y) > r2) continue;
          o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.05 * dt);
          o.armor = Math.max(o.armor, o.def.armor + 3);
        }
      }

      const desired = this.enemyDesire(e, dt);

      if (e.stunTimer <= 0 && e.chargeTimer <= 0) {
        const sp = e.effectiveSpeed;
        e.vx = damp(e.vx, desired.x * sp, 9, dt);
        e.vy = damp(e.vy, desired.y * sp, 9, dt);
      } else if (e.chargeTimer > 0) {
        e.chargeTimer -= dt;
        e.vx = e.chargeDirX * (e.def.abilities ? 520 : 400);
        e.vy = e.chargeDirY * (e.def.abilities ? 520 : 400);
        if (chance(dt * 30)) {
          g.particles.spawn(e.x, e.y, rand(-40, 40), rand(-40, 40), 0.3, rand(4, 9), e.def.accent, PKind.Glow);
        }
      } else {
        e.vx = damp(e.vx, 0, 12, dt);
        e.vy = damp(e.vy, 0, 12, dt);
      }

      // Separation, so packs spread instead of stacking into one pixel.
      if (!e.flying && !e.boss) {
        const list = this.enemyHash.query(e.x, e.y, e.radius * 2.4, this.queryBuf);
        let px = 0, py = 0, n = 0;
        for (let k = 0; k < list.length && n < 6; k++) {
          const o = this.enemies[list[k]];
          if (!o || o === e || o.dead) continue;
          const dx = e.x - o.x, dy = e.y - o.y;
          const d2 = dx * dx + dy * dy;
          const rr = (e.radius + o.radius) * 0.95;
          if (d2 > rr * rr || d2 < 1e-4) continue;
          const d = Math.sqrt(d2);
          px += (dx / d) * (rr - d);
          py += (dy / d) * (rr - d);
          n++;
        }
        if (n) { e.x += px * 0.5; e.y += py * 0.5; }
      }

      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.gait += Math.hypot(e.vx, e.vy) * dt * 0.06;
      if (Math.abs(e.vx) + Math.abs(e.vy) > 4) {
        e.angle = rotateToward(e.angle, Math.atan2(e.vy, e.vx), dt * 9);
      }

      if (!e.flying && !e.submerged) {
        const preCx = e.x, preCy = e.y;
        world.collideCircle(e, e.radius);
        // A body squeezed by rock on both sides gets shoved hard back toward
        // centre every single frame (unlike a normal corner graze, which only
        // nudges it once). Sustained heavy shoving means it's wedged — most
        // corridors are now generated wide enough for any boss (see
        // world.ts's carveCorridor), but this is the backstop for whatever
        // that guarantee doesn't reach (e.g. two carved features meeting).
        const shoved2 = (e.x - preCx) * (e.x - preCx) + (e.y - preCy) * (e.y - preCy);
        if (shoved2 > (e.radius * 0.5) * (e.radius * 0.5)) e.stuckTimer += dt;
        else e.stuckTimer = Math.max(0, e.stuckTimer - dt * 2);
        if (e.stuckTimer > 1.2) {
          const out = world.findOpenNear(e.x, e.y);
          e.x = out.x; e.y = out.y;
          e.vx = 0; e.vy = 0;
          e.stuckTimer = 0;
        }
        // Belt and braces: if anything still ends the tick buried in rock (a
        // surfacing burrower, a hard knockback), it would be both immobile and
        // unhittable. Eject it to the nearest reachable tile instead.
        if (world.solidAtPx(e.x, e.y)) {
          const out = world.findOpenNear(e.x, e.y);
          e.x = out.x; e.y = out.y;
          e.vx = 0; e.vy = 0;
        }
        const blocker = g.collideWithBuildings(e, e.radius);
        if (blocker && e.def.behavior !== 'ranged') {
          e.targetBuilding = blocker;
          e.targetIsCore = false;
        }
      } else {
        e.x = clamp(e.x, e.radius, world.pxW - e.radius);
        e.y = clamp(e.y, e.radius, world.pxH - e.radius);
      }

      this.enemyAttack(e, dt);

      // Ambient trail.
      if (e.boss && chance(dt * 30)) {
        g.particles.spawn(e.x + rand(-e.radius, e.radius), e.y + rand(-e.radius, e.radius),
          rand(-20, 20), rand(-40, -10), rand(0.5, 1.2), rand(6, 16),
          e.def.color, PKind.Smoke, { additive: false, drag: 1.2 });
      }
      void field;
    }
  }

  /** Movement intent for one enemy, as a unit vector. */
  private enemyDesire(e: Enemy, dt: number): { x: number; y: number } {
    const g = this.game;
    const out = this.flowOut;
    const beh = e.def.behavior;

    // A ranged flier (e.g. the Void Wasp) still holds its stand-off range
    // instead of beelining into contact range like a melee flier — same hold
    // logic as a grounded ranged unit, just untethered from the flow field.
    if (e.flying && beh === 'ranged' && !e.berserk) {
      const target = this.pickRangedTarget(e);
      if (target) {
        const d = dist(e.x, e.y, target.x, target.y);
        const want = e.def.attackRange * 0.78;
        const dir = (d - want) / (Math.abs(d - want) || 1);
        if (Math.abs(d - want) < 18) return { x: 0, y: 0 };
        const l = d || 1;
        return { x: ((target.x - e.x) / l) * dir, y: ((target.y - e.y) / l) * dir };
      }
      // No target in sight yet: fall through to the beeline below so it closes in.
    }

    // Fliers and submerged burrowers ignore the field entirely.
    if (e.flying || e.submerged) {
      const tx = g.core.x, ty = g.core.y;
      const d = Math.hypot(tx - e.x, ty - e.y) || 1;
      out.x = (tx - e.x) / d;
      out.y = (ty - e.y) / d;
      if (e.flying) {
        // Lazy sine drift so moths don't fly in perfect lines.
        const perpX = -out.y, perpY = out.x;
        const w = Math.sin(e.anim * 2.2 + e.id) * 0.4;
        out.x += perpX * w; out.y += perpY * w;
        const l = Math.hypot(out.x, out.y) || 1;
        out.x /= l; out.y /= l;
      }
      return out;
    }

    // Ranged units hold at range once they have a target in sight. Enraged
    // stragglers give that up and close on the core instead.
    if (beh === 'ranged' && !e.berserk) {
      const target = this.pickRangedTarget(e);
      if (target) {
        const d = dist(e.x, e.y, target.x, target.y);
        const want = e.def.attackRange * 0.78;
        const dir = (d - want) / (Math.abs(d - want) || 1);
        if (Math.abs(d - want) < 18) { out.x = 0; out.y = 0; return out; }
        out.x = ((target.x - e.x) / (d || 1)) * dir;
        out.y = ((target.y - e.y) / (d || 1)) * dir;
        return out;
      }
    }

    // Brutes divert to nearby structures.
    if (beh === 'brute' && !e.berserk && e.retargetIn <= 0) {
      e.retargetIn = 0.6;
      const b = this.nearestBuilding(e.x, e.y, 240);
      e.targetBuilding = b;
    }
    if (!e.berserk && e.targetBuilding && !e.targetBuilding.dead) {
      const t = e.targetBuilding;
      const d = dist(e.x, e.y, t.x, t.y);
      if (d > t.radius + e.radius + e.def.attackRange) {
        out.x = (t.x - e.x) / (d || 1);
        out.y = (t.y - e.y) / (d || 1);
        return out;
      }
      out.x = 0; out.y = 0;
      return out;
    }

    // Default: follow the flow field to the core.
    const tx = Math.floor(e.x / TILE);
    const ty = Math.floor(e.y / TILE);
    const fx = e.x / TILE - tx;
    const fy = e.y / TILE - ty;
    g.world.field.sample(tx, ty, fx, fy, out);

    // Swarm units drift toward their neighbours' heading for a flocking feel.
    if (e.def.behavior === 'swarm') {
      const list = this.enemyHash.query(e.x, e.y, 70, this.queryBuf);
      let ax = 0, ay = 0, n = 0;
      for (let k = 0; k < list.length && n < 5; k++) {
        const o = this.enemies[list[k]];
        if (!o || o === e || o.dead) continue;
        ax += o.vx; ay += o.vy; n++;
      }
      if (n) {
        const l = Math.hypot(ax, ay) || 1;
        out.x = out.x * 0.75 + (ax / l) * 0.25;
        out.y = out.y * 0.75 + (ay / l) * 0.25;
        const ll = Math.hypot(out.x, out.y) || 1;
        out.x /= ll; out.y /= ll;
      }
    }
    void dt;
    return out;
  }

  private pickRangedTarget(e: Enemy): { x: number; y: number; radius: number } | null {
    const g = this.game;
    const range = e.def.attackRange;
    let best: { x: number; y: number; radius: number } | null = null;
    let bestD = range * range;

    const list = g.buildingHash.query(e.x, e.y, range, g.buildingQueryBuf);
    for (let k = 0; k < list.length; k++) {
      const b = g.buildings[list[k]];
      if (!b) continue;
      const d2 = dist2(e.x, e.y, b.x, b.y);
      if (d2 < bestD && g.world.lineOfSight(e.x, e.y, b.x, b.y)) { bestD = d2; best = b; }
    }
    const dCore = dist2(e.x, e.y, g.core.x, g.core.y);
    if (dCore < bestD && g.world.lineOfSight(e.x, e.y, g.core.x, g.core.y)) {
      bestD = dCore; best = g.core;
    }
    const dp = dist2(e.x, e.y, g.player.x, g.player.y);
    if (!g.player.dead && dp < bestD * 0.7 && g.world.lineOfSight(e.x, e.y, g.player.x, g.player.y)) {
      best = g.player;
    }
    return best;
  }

  private nearestBuilding(x: number, y: number, maxR: number): Building | null {
    const g = this.game;
    let best: Building | null = null;
    let bestD = maxR * maxR;
    const list = g.buildingHash.query(x, y, maxR, g.buildingQueryBuf);
    for (let k = 0; k < list.length; k++) {
      const b = g.buildings[list[k]];
      if (!b) continue;
      const d2 = dist2(x, y, b.x, b.y);
      if (d2 < bestD) { bestD = d2; best = b; }
    }
    return best;
  }

  private enemyAttack(e: Enemy, dt: number) {
    const g = this.game;
    if (e.submerged || e.stunTimer > 0) return;
    const beh = e.def.behavior;
    if (beh === 'support') return;

    // Bombers detonate on anything they touch.
    if (beh === 'bomber') {
      const reach = e.radius + e.def.attackRange;
      let contact: { x: number; y: number } | null = null;
      if (dist(e.x, e.y, g.core.x, g.core.y) < reach + g.core.radius) contact = g.core;
      if (!contact) {
        const b = this.nearestBuilding(e.x, e.y, reach + 34);
        if (b && dist(e.x, e.y, b.x, b.y) < reach + b.radius) contact = b;
      }
      if (!contact && !g.player.dead && dist(e.x, e.y, g.player.x, g.player.y) < reach + g.player.radius) {
        contact = g.player;
      }
      if (contact) {
        g.explode(e.x, e.y, e.def.splashRadius ?? 70, e.damage, 'hive');
        audio.play('explode');
        g.shake(8);
        this.killEnemy(e, 'self', false);
      }
      return;
    }

    if (e.attackCooldown > 0) return;

    if (beh === 'ranged') {
      const t = this.pickRangedTarget(e);
      if (!t) return;
      const d = dist(e.x, e.y, t.x, t.y);
      if (d > e.def.attackRange) return;
      e.attackCooldown = 1 / e.def.attackRate;
      const a = Math.atan2(t.y - e.y, t.x - e.x) + rand(-0.06, 0.06);
      g.fire({
        x: e.x + Math.cos(a) * e.radius, y: e.y + Math.sin(a) * e.radius,
        angle: a, speed: e.def.projectileSpeed ?? 250, damage: e.damage,
        kind: e.boss ? 'bossOrb' : 'spit', faction: 'hive',
        color: e.def.accent, size: e.boss ? 9 : 5,
        life: (e.def.attackRange / (e.def.projectileSpeed ?? 250)) * 1.5,
        armorPierce: 0, ownerId: e.id, splash: e.def.splashRadius ?? 0,
      });
      g.particles.muzzle(e.x + Math.cos(a) * e.radius, e.y + Math.sin(a) * e.radius, a, e.def.accent, 1);
      audio.play('shoot', rand(0.6, 0.75));
      return;
    }

    // Melee: core first if in reach, then the assigned structure, then the player.
    const reach = e.radius + e.def.attackRange;
    if (dist(e.x, e.y, g.core.x, g.core.y) < reach + g.core.radius) {
      e.attackCooldown = 1 / e.def.attackRate;
      g.damageCore(e.damage);
      this.slashFx(e, g.core.x, g.core.y);
      return;
    }
    if (e.targetBuilding && !e.targetBuilding.dead) {
      const b = e.targetBuilding;
      if (dist(e.x, e.y, b.x, b.y) < reach + b.radius) {
        e.attackCooldown = 1 / e.def.attackRate;
        g.damageBuilding(b, e.damage);
        this.slashFx(e, b.x, b.y);
        return;
      }
    }
    if (!g.player.dead && dist(e.x, e.y, g.player.x, g.player.y) < reach + g.player.radius) {
      e.attackCooldown = 1 / e.def.attackRate;
      g.damagePlayer(e.damage * 0.6);
      this.slashFx(e, g.player.x, g.player.y);
    }
    void dt;
  }

  private slashFx(e: Enemy, tx: number, ty: number) {
    const g = this.game;
    const a = Math.atan2(ty - e.y, tx - e.x);
    g.particles.impact(e.x + Math.cos(a) * e.radius, e.y + Math.sin(a) * e.radius, a, e.def.accent, 1.1);
    audio.play('hit', rand(0.7, 0.9));
  }

  /* ---- boss abilities --------------------------------------------------- */

  private updateBossAbilities(e: Enemy, dt: number) {
    const g = this.game;
    const abilities = e.def.abilities;
    if (!abilities) return;

    if (e.shieldHp > 0) {
      e.shieldHp = Math.max(0, e.shieldHp - e.shieldMax * 0.04 * dt);
    }

    if (e.castingIndex >= 0) {
      e.castTimer -= dt;
      const ab = abilities[e.castingIndex];
      // Telegraph ring grows through the wind-up.
      if (chance(dt * 30)) {
        const t = 1 - e.castTimer / ab.telegraph;
        g.particles.spawn(
          e.x + rand(-e.radius, e.radius), e.y + rand(-e.radius, e.radius),
          rand(-30, 30), rand(-80, -20), rand(0.2, 0.5), rand(2, 5),
          0xff4f5e, PKind.Spark, { drag: 2 },
        );
        void t;
      }
      if (e.castTimer <= 0) {
        this.resolveBossAbility(e, e.castingIndex);
        e.castingIndex = -1;
      }
      return;
    }

    for (let i = 0; i < abilities.length; i++) {
      e.abilityCd[i] -= dt;
      if (e.abilityCd[i] > 0) continue;
      const ab = abilities[i];
      // Only cast when it can matter.
      if (ab.id === 'slam' && dist(e.x, e.y, g.core.x, g.core.y) > 420 &&
          !this.nearestBuilding(e.x, e.y, 260) && dist(e.x, e.y, g.player.x, g.player.y) > 320) continue;
      // Nothing new while diving or mid-charge; webs only with something to web.
      if (e.submerged) continue;
      if ((ab.id === 'burrow' || ab.id === 'charge') && e.chargeTimer > 0) continue;
      if (ab.id === 'web' && this.webTargets(e, ab.value).length === 0) continue;
      e.abilityCd[i] = ab.cooldown;
      e.castingIndex = i;
      e.castTimer = ab.telegraph;
      const radius = ab.id === 'slam' ? 210 : ab.id === 'beam' ? 40 : e.radius * 2.2;
      g.effects.push({
        kind: 'telegraph', x: e.x, y: e.y,
        x2: g.core.x, y2: g.core.y,
        radius, life: ab.telegraph, maxLife: ab.telegraph,
        color: 0xff4f5e, width: 3, seed: Math.random() * 1000,
      });
      audio.play('coreCritical');
      break;
    }
  }

  /**
   * Who a Weaver web volley goes for: the nearest working turrets within
   * range (silencing guns is the point), plus the pilot if in reach.
   */
  private webTargets(e: Enemy, count: number): { x: number; y: number }[] {
    const g = this.game;
    const range = 560;
    const turrets = g.buildings
      .filter((b) => b.isTurret && b.built && !b.dead && b.webbed <= 0 && dist(e.x, e.y, b.x, b.y) <= range)
      .sort((a, b) => dist2(e.x, e.y, a.x, a.y) - dist2(e.x, e.y, b.x, b.y));
    const out: { x: number; y: number }[] = [];
    const playerInReach = !g.player.dead && dist(e.x, e.y, g.player.x, g.player.y) <= range;
    for (const b of turrets) {
      if (out.length >= count - (playerInReach ? 1 : 0)) break;
      out.push(b);
    }
    if (playerInReach) out.push(g.player);
    return out;
  }

  private resolveBossAbility(e: Enemy, index: number) {
    const g = this.game;
    const ab = e.def.abilities![index];
    switch (ab.id) {
      case 'burrow': {
        // Dive: untargetable and straight through walls (see enemyDesire),
        // then erupt with a slam where it surfaces (updateEnemies).
        e.submerged = true;
        e.burrowTimer = ab.value;
        e.emergeSlam = true;
        g.particles.dust(e.x, e.y, g.level.palette.rockLit, 24);
        audio.play('explode', 0.6);
        g.shake(10);
        break;
      }
      case 'shed': {
        // Live segments peel off the tail and keep coming.
        const def = ENEMIES.centipedeling;
        for (let i = 0; i < ab.value; i++) {
          const tx = e.trail ? e.trail[Math.min(e.trail.length - 2, (i + 2) * 2)] : e.x;
          const ty = e.trail ? e.trail[Math.min(e.trail.length - 1, (i + 2) * 2 + 1)] : e.y;
          const at = g.world.findOpenNear(tx + rand(-10, 10), ty + rand(-10, 10));
          const child = this.spawnEnemy(def, at.x, at.y, g.plan?.hpMult ?? 1, g.plan?.dmgMult ?? 1, false);
          child.wave = g.waveIndex;
          child.spawnedBy = e.id;
          g.particles.ring(child.x, child.y, 16, def.accent, 0.3);
        }
        audio.play('bossRoar', 1.2);
        g.shake(8);
        break;
      }
      case 'web': {
        for (const t of this.webTargets(e, ab.value)) {
          g.fire({
            x: e.x, y: e.y, angle: Math.atan2(t.y - e.y, t.x - e.x), speed: 340,
            damage: 6, kind: 'web', faction: 'hive', color: 0xe8f0ff, size: 7,
            life: 2.6, armorPierce: 0, ownerId: e.id, splash: 0,
          });
        }
        audio.play('shootHeavy', 1.4);
        break;
      }
      case 'slam': {
        g.explode(e.x, e.y, 210, ab.value, 'hive');
        g.effects.push({
          kind: 'shock', x: e.x, y: e.y, x2: 0, y2: 0,
          radius: 210, life: 0.5, maxLife: 0.5, color: 0xff8a5c, width: 8, seed: 0,
        });
        audio.play('explodeBig');
        g.shake(22);
        g.addFlash(1, 0.5, 0.3, 0.3);
        break;
      }
      case 'spawn': {
        const roster = g.level.roster.filter((r) => (ENEMIES[r]?.cost ?? 9) <= 3);
        const pool = roster.length ? roster : ['crawler'];
        for (let i = 0; i < ab.value; i++) {
          const a = (i / ab.value) * TAU + rand(-0.2, 0.2);
          const r = e.radius + rand(20, 60);
          const def = ENEMIES[pool[randInt(0, pool.length - 1)]];
          const at = g.world.findOpenNear(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r);
          const child = this.spawnEnemy(def, at.x, at.y,
            g.plan?.hpMult ?? 1, g.plan?.dmgMult ?? 1, false);
          child.wave = g.waveIndex;
          child.spawnedBy = e.id;
          g.particles.ring(child.x, child.y, 18, def.accent, 0.3);
        }
        audio.play('bossRoar');
        g.shake(8);
        break;
      }
      case 'beam': {
        // Sweeps toward the core, damaging everything on the line.
        const a = Math.atan2(g.core.y - e.y, g.core.x - e.x);
        const len = 900;
        const ex = e.x + Math.cos(a) * len, ey = e.y + Math.sin(a) * len;
        g.effects.push({
          kind: 'beam', x: e.x, y: e.y, x2: ex, y2: ey,
          radius: 26, life: 0.45, maxLife: 0.45, color: 0xff4f5e, width: 26, seed: 0,
        });
        g.damageAlongLine(e.x, e.y, ex, ey, 26, ab.value);
        audio.play('laser', 0.5);
        g.shake(14);
        break;
      }
      case 'charge': {
        const a = Math.atan2(g.core.y - e.y, g.core.x - e.x);
        e.chargeDirX = Math.cos(a);
        e.chargeDirY = Math.sin(a);
        e.chargeTimer = ab.value / 520;
        audio.play('shootHeavy', 0.5);
        break;
      }
      case 'volley': {
        const base = Math.atan2(g.core.y - e.y, g.core.x - e.x);
        for (let i = 0; i < ab.value; i++) {
          const a = base + (i - ab.value / 2) * 0.16;
          g.fire({
            x: e.x, y: e.y, angle: a, speed: 300, damage: e.damage * 0.6,
            kind: 'bossOrb', faction: 'hive', color: e.def.accent, size: 8,
            life: 3.4, armorPierce: 0, ownerId: e.id, splash: 40,
          });
        }
        audio.play('shootHeavy', 0.7);
        break;
      }
      case 'shield': {
        e.shieldMax = ab.value;
        e.shieldHp = ab.value;
        g.particles.ring(e.x, e.y, e.radius * 3, 0x9fd8ff, 0.6);
        audio.play('levelUp');
        break;
      }
    }
  }

  damageEnemy(
    e: Enemy,
    amount: number,
    opts: {
      /** 'ability' = the orbital strike: credited to neither turrets nor the player's gun. */
      source: 'turret' | 'player' | 'burn' | 'ability';
      armorPierce?: number;
      building?: Building;
      dirX?: number; dirY?: number;
      silent?: boolean;
    },
  ) {
    const g = this.game;
    if (e.dead) return;
    e.lastHitAt = g.elapsed;
    const pierce = (opts.armorPierce ?? 0) + g.perks.armorShred;
    let dmg = mitigate(amount, e.armor, pierce);

    if (e.shieldHp > 0) {
      const absorbed = Math.min(e.shieldHp, dmg);
      e.shieldHp -= absorbed;
      dmg -= absorbed;
      if (!opts.silent) g.particles.impact(e.x, e.y, Math.atan2(opts.dirY ?? 0, opts.dirX ?? 1), 0x9fd8ff, 1);
      if (dmg <= 0) return;
    }

    e.hp -= dmg;
    e.hitFlash = 1;
    g.runStats.damage += dmg;
    g.buffers.damage += dmg;

    // Echo splash from the Resonance Cascade tech.
    if (g.perks.splashEcho > 0 && !opts.silent && dmg > 1) {
      g.explode(e.x, e.y, 46, dmg * g.perks.splashEcho, 'player', 999);
    }

    if (!opts.silent) {
      const a = Math.atan2(opts.dirY ?? rand(-1, 1), opts.dirX ?? rand(-1, 1));
      g.particles.impact(e.x, e.y, a, e.armor > 3 ? 0xffe08a : e.def.accent, e.boss ? 1.6 : 1);
      audio.play(e.armor > 3 ? 'hitArmor' : 'hit', rand(0.9, 1.15));
      if (g.progress.data.settings.showDamageNumbers) {
        g.presentation.spawnDamageNumber(e.x, e.y - e.radius, Math.round(dmg), dmg > amount * 0.9, 0xffffff);
      }
    }

    // Knockback for non-bosses.
    if (!e.boss && opts.dirX !== undefined) {
      const l = Math.hypot(opts.dirX, opts.dirY ?? 0) || 1;
      const k = clamp(dmg / e.maxHp, 0, 0.4) * 260;
      e.vx += (opts.dirX / l) * k;
      e.vy += ((opts.dirY ?? 0) / l) * k;
    }

    if (e.hp <= 0) {
      this.killEnemy(e,
        opts.source === 'player' ? 'player' : opts.source === 'ability' ? 'ability' : 'turret', true);
      if (opts.building) opts.building.kills++;
    }
  }

  private killEnemy(e: Enemy, by: 'player' | 'turret' | 'self' | 'ability', reward: boolean) {
    const g = this.game;
    if (e.dead) return;
    e.dead = true;
    g.killedThisWave++;
    g.runStats.kills++;
    // Real kills charge the orbital strike — not self-destructs, not its own victims.
    if (reward && by !== 'self' && by !== 'ability') g.strike.onKill(e);
    // Volatile elites go up when they die: kill them before they reach the line.
    if (e.affix === 'volatile') {
      g.explode(e.x, e.y, 70, 26 + e.damage * 1.5, 'hive');
      g.particles.explosion(e.x, e.y, 40, 0xff6b3d, g.level.palette.rock);
      audio.play('explode');
      g.shake(5);
    }
    g.progress.bump('kill');
    g.progress.recordRunStat('kills', 1);
    if (by === 'player') g.progress.bump('meleeKills');
    else if (by === 'turret') g.progress.bump('turretKills');

    const pal = g.level.palette;
    if (e.boss) {
      g.runStats.bossKills++;
      g.progress.bump('killBoss');
      g.progress.recordRunStat('bossKills', 1);
      if (g.coreDamageThisWave <= 0) g.progress.bump('bossNoCoreDamage');
      g.presentation.hitstop = 0.55;
      g.shake(26);
      g.addFlash(1, 0.9, 0.7, 0.6);
      for (let i = 0; i < 6; i++) {
        setTimeout(() => {
          g.particles.explosion(
            e.x + rand(-e.radius, e.radius), e.y + rand(-e.radius, e.radius),
            e.radius * rand(0.7, 1.4), e.def.accent, pal.rock,
          );
        }, i * 110);
      }
      audio.play('explodeBig');
      g.bossRef = null;
    } else {
      g.particles.explosion(e.x, e.y, e.radius * 1.6, e.def.accent, pal.rock);
      g.particles.gib(e.x, e.y, e.def.color, e.elite ? 12 : 7, e.boss ? 2 : 1);
      audio.play('kill', rand(0.9, 1.1));
      // Reserved for the genuinely heavy units; ordinary kills stay shake-free.
      if (e.radius > 16 || e.elite) g.shake(1.4);
    }

    if (reward) {
      const mult = e.elite ? 2 : 1;
      const essence = Math.round(e.def.essence * mult * g.perks.essenceYield);
      const oreDrop = Math.round(e.def.ore * mult * g.perks.oreYield);
      for (let i = 0; i < Math.min(6, essence); i++) g.dropPickup(e.x, e.y, 'essence', Math.ceil(essence / Math.min(6, essence)));
      if (oreDrop > 0) g.dropPickup(e.x, e.y, 'ore', oreDrop);
      if (g.perks.luck > 0 && chance(g.perks.luck)) g.dropPickup(e.x, e.y, 'essence', 2);
      if (chance(0.02)) g.dropPickup(e.x, e.y, 'health', 20);
      if (e.boss) {
        for (let i = 0; i < 14; i++) g.dropPickup(e.x, e.y, 'essence', Math.ceil(e.def.essence / 14));
        g.dropPickup(e.x, e.y, 'relic', 1);
      }
    }

    // Splitters seed children.
    if (e.def.splitInto && ENEMIES[e.def.splitInto]) {
      const childDef = ENEMIES[e.def.splitInto];
      for (let i = 0; i < (e.def.splitCount ?? 2); i++) {
        const a = (i / (e.def.splitCount ?? 2)) * TAU + rand(-0.3, 0.3);
        const at = g.world.findOpenNear(
          e.x + Math.cos(a) * (e.radius + 6), e.y + Math.sin(a) * (e.radius + 6));
        const c = this.spawnEnemy(childDef, at.x, at.y,
          g.plan?.hpMult ?? 1, g.plan?.dmgMult ?? 1, false);
        c.vx = Math.cos(a) * 160;
        c.vy = Math.sin(a) * 160;
        c.wave = e.wave;
        c.spawnedBy = e.id;
      }
    }
  }
}
