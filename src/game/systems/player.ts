import { audio } from '../../core/audio';
import { t as tr } from '../../core/i18n';
import {
  angleDelta, chance, clamp, damp, dist, dist2, rand, rotateToward,
} from '../../core/math';
import { PKind } from '../../engine/particles';
import { ARMOR_TIERS, WEAPONS, type WeaponKind } from '../../data/loadout';
import type { Enemy } from '../entities';
import type { OreNode } from '../world';
import { HAZARD_DPS, TILE, Tile } from '../world';
import type { InputSource } from '../../core/input';
import type { Game } from '../game';

/** How far the player's weapon reaches when auto-aiming. */
const PLAYER_AIM_RANGE = 430;
/** How close the player must be to work a seam. */
const PLAYER_MINE_RANGE = 168;

/** The player-controlled avatar: movement, aim/fire, mining, and its own hp/loadout. */
export class PlayerSystem {
  constructor(private game: Game) {}

  armorHpBonus() {
    return ARMOR_TIERS[this.game.player.armorTier]?.hpBonus ?? 0;
  }

  /**
   * Unlocks (or, if already owned, just re-equips for free) a weapon. This is
   * a deliberate essence sink the player opts into, distinct from tech cards
   * (random, free, numeric-only) and the relic Armoury (permanent, cross-run,
   * bought with relics) — see the module doc in data/loadout.ts.
   */
  buyWeapon(kind: WeaponKind): boolean {
    const g = this.game;
    if (g.player.weaponsOwned.has(kind)) {
      g.player.weapon = kind;
      return true;
    }
    const def = WEAPONS[kind];
    if (!def || g.essence < def.cost) return false;
    g.essence -= def.cost;
    g.player.weaponsOwned.add(kind);
    g.player.weapon = kind;
    audio.play('levelUp');
    return true;
  }

  /** Buys exactly the next armor tier up from the one currently worn. */
  buyArmorTier(): boolean {
    const g = this.game;
    const next = ARMOR_TIERS[g.player.armorTier + 1];
    if (!next) return false;
    if (g.essence < next.cost) return false;
    g.essence -= next.cost;
    const delta = next.hpBonus - this.armorHpBonus();
    g.player.armorTier = next.tier;
    g.player.maxHp += delta;
    g.player.hp += delta;
    audio.play('levelUp');
    return true;
  }

  updatePlayer(dt: number, input: InputSource) {
    const g = this.game;
    const p = g.player;
    if (p.dead) {
      // Downed players respawn at the core after a beat — the core is the fail state.
      p.invuln -= dt;
      if (p.invuln <= 0) {
        p.dead = false;
        p.hp = Math.round(p.maxHp * 0.5);
        p.x = g.core.x + rand(-40, 40);
        p.y = g.core.y + rand(-40, 40);
        p.invuln = 2.2;
        g.particles.ring(p.x, p.y, 40, 0x7fd9ff, 0.5);
      }
      return;
    }

    const ax = input.uiCaptured ? { x: 0, y: 0 } : input.axis();

    if (g.autoAim) {
      // Track the nearest live threat. The turn rate is finite so a target
      // crossing behind you is not hit instantly — auto-aim assists, it does
      // not make positioning irrelevant.
      const target = this.pickPlayerTarget();
      g.autoTarget = target;
      if (target) {
        const want = Math.atan2(target.y - p.y, target.x - p.x);
        p.aim = rotateToward(p.aim, want, dt * 14);
      } else if (ax.x || ax.y) {
        // Nothing to aim at — there's no mouse to point with either (this
        // path is touch's), so face the way you're actually walking instead
        // of leaving the sprite frozen on whatever it last aimed at.
        p.aim = rotateToward(p.aim, Math.atan2(ax.y, ax.x), dt * 14);
      }
    } else {
      g.autoTarget = null;
      p.aim = Math.atan2(g.mouseWorldY - p.y, g.mouseWorldX - p.x);
    }
    p.facing = rotateToward(p.facing, p.aim, dt * 12);
    p.hitFlash = Math.max(0, p.hitFlash - dt * 5);
    p.invuln = Math.max(0, p.invuln - dt);
    p.recoil = damp(p.recoil, 0, 14, dt);
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    p.webbed = Math.max(0, p.webbed - dt);

    if (g.perks.playerRegen > 0 && p.hp < p.maxHp) {
      p.hp = Math.min(p.maxHp, p.hp + g.perks.playerRegen * dt);
    }

    // Heat / overheat.
    if (p.overheated) {
      p.heat -= dt * 0.5;
      if (p.heat <= 0.25) { p.overheated = false; p.heat = 0.25; }
    } else {
      p.heat = Math.max(0, p.heat - dt * 0.42);
    }

    // A Weaver's web drags the pilot to a crawl; a dash still breaks free.
    const speed = 232 * g.perks.playerSpeed * (p.webbed > 0 ? 0.4 : 1);

    // Dash.
    if (p.dashTime > 0) {
      p.dashTime -= dt;
      p.vx = p.dashDirX * 640;
      p.vy = p.dashDirY * 640;
      p.invuln = Math.max(p.invuln, 0.08 + g.perks.dashInvuln);
      if (chance(dt * 40)) {
        g.particles.spawn(p.x, p.y, rand(-30, 30), rand(-30, 30), 0.25, rand(3, 7), 0x7fd9ff, PKind.Glow);
      }
      // Kinetic Ram: only checked once the relic upgrade is owned, so an
      // undashing-through-enemies playstyle costs nothing for everyone else.
      if (g.perks.dashRamDamage > 0) {
        const reach = p.radius + 24;
        const list = g.enemyHash.query(p.x, p.y, reach, g.queryBuf);
        for (let i = 0; i < list.length; i++) {
          const e = g.enemies[list[i]];
          if (!e || e.dead || !e.targetable || p.dashHitIds.includes(e.id)) continue;
          const rr = reach + e.radius;
          if (dist2(p.x, p.y, e.x, e.y) > rr * rr) continue;
          p.dashHitIds.push(e.id);
          g.damageEnemy(e, g.perks.dashRamDamage, {
            source: 'player', armorPierce: g.perks.armorShred,
            dirX: e.x - p.x, dirY: e.y - p.y,
          });
        }
      }
    } else {
      if (!input.uiCaptured && input.pressed('ShiftLeft') && p.dashCooldown <= 0 && (ax.x || ax.y)) {
        p.dashTime = 0.16;
        p.dashCooldown = 1.35 * g.perks.dashCooldown;
        p.dashDirX = ax.x; p.dashDirY = ax.y;
        p.dashHitIds.length = 0;
        audio.play('shootHeavy');
        g.particles.ring(p.x, p.y, 26, 0x7fd9ff, 0.28);
      }
      p.vx = damp(p.vx, ax.x * speed, 16, dt);
      p.vy = damp(p.vy, ax.y * speed, 16, dt);
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    g.world.collideCircle(p, p.radius);
    g.collideWithBuildings(p, p.radius);
    // Keep the player out of the core's footprint.
    const dc = dist(p.x, p.y, g.core.x, g.core.y);
    if (dc < g.core.radius + p.radius) {
      const nx = (p.x - g.core.x) / (dc || 1), ny = (p.y - g.core.y) / (dc || 1);
      p.x = g.core.x + nx * (g.core.radius + p.radius);
      p.y = g.core.y + ny * (g.core.radius + p.radius);
    }

    // Hazard tiles: a quiet DoT tick, not the usual shake/flash hit feedback —
    // that's fine for one impact, but continuous every-frame damage would
    // otherwise shake the screen non-stop the whole time you're standing in it.
    if (g.world.tileAt(Math.floor(p.x / TILE), Math.floor(p.y / TILE)) === Tile.Hazard) {
      this.damagePlayer(HAZARD_DPS * dt, true);
      if (chance(dt * 10)) {
        g.particles.spawn(p.x + rand(-8, 8), p.y + rand(-4, 4), rand(-10, 10), rand(-40, -15),
          rand(0.25, 0.5), rand(2, 4), g.level.palette.hazardColor, PKind.Ember);
      }
    }

    const moved = Math.hypot(p.vx, p.vy);
    p.stride += moved * dt * 0.05;
    if (moved > 30 && chance(dt * 14)) {
      g.particles.spawn(p.x, p.y + 8, rand(-14, 14), rand(-6, 10), rand(0.25, 0.6),
        rand(2, 5), g.level.palette.ground1, PKind.Smoke, { additive: false, drag: 3 });
    }
    // Maxed-out power tier throws off ambient sparks — the loudest of the
    // chassis's escalating tells, see Renderer.drawPlayer for the rest.
    if (g.powerTier >= 4 && chance(dt * 4)) {
      g.particles.spawn(p.x + rand(-10, 10), p.y + rand(-10, 10), rand(-20, 20), rand(-50, -15),
        rand(0.3, 0.6), rand(2, 4), 0xffe066, PKind.Spark, { drag: 2 });
    }

    // Firing.
    p.cooldown -= dt;
    let wantFire = !input.uiCaptured && input.mouseDown(0) && g.cursorMode === 'normal';
    if (g.autoAim) {
      // Auto-fire manages heat on the player's behalf: it holds off near the
      // overheat threshold so the weapon never locks out, which preserves the
      // sustained-DPS ceiling without demanding a trigger finger.
      const locked = g.autoTarget !== null && !g.autoTarget.dead;
      const aligned = locked &&
        Math.abs(angleDelta(p.aim, Math.atan2(g.autoTarget!.y - p.y, g.autoTarget!.x - p.x))) < 0.22;
      wantFire = locked && aligned && p.heat < 0.85 && g.cursorMode !== 'build';
    }
    if (wantFire && p.cooldown <= 0 && !p.overheated) {
      const weaponDef = WEAPONS[p.weapon];
      this.playerShoot();
      p.cooldown = 1 / (weaponDef.fireRate * g.perks.playerFireRate);
      p.heat += weaponDef.heatPerShot;
      if (p.heat >= 1) { p.overheated = true; p.heat = 1; audio.play('error'); }
    }

    // Mining.
    p.miningNode = -1;
    g.nearbyMineNode = g.world.nearestNode(p.x, p.y, PLAYER_MINE_RANGE);
    if (g.autoMine) {
      // Nothing to decide here — mining is strictly good — so with the
      // setting on, it just happens whenever a seam is in reach.
      const node = g.nearbyMineNode;
      if (node) {
        p.miningNode = g.world.nodes.indexOf(node);
        this.mine(node, dt);
      }
    } else if (!input.uiCaptured && input.mouseDown(2) && g.cursorMode === 'normal') {
      const node = g.world.nearestNode(g.mouseWorldX, g.mouseWorldY, TILE * 1.6);
      if (node) {
        const nx = (node.tx + 0.5) * TILE, ny = (node.ty + 0.5) * TILE;
        if (dist(p.x, p.y, nx, ny) < PLAYER_MINE_RANGE) {
          p.miningNode = g.world.nodes.indexOf(node);
          this.mine(node, dt);
        }
      }
    }
    if (p.miningNode < 0) p.miningHeat = damp(p.miningHeat, 0, 8, dt);
  }

  /**
   * Best target for the player's weapon: nearest visible enemy in range.
   *
   * Sticky — it keeps the current target while that target is still valid and
   * roughly as close as the alternative, so the aim does not jitter between two
   * equidistant enemies.
   */
  private pickPlayerTarget(): Enemy | null {
    const g = this.game;
    const p = g.player;
    const range = PLAYER_AIM_RANGE;
    const list = g.enemyHash.query(p.x, p.y, range, g.queryBuf);
    let best: Enemy | null = null;
    let bestD = range * range;

    for (let i = 0; i < list.length; i++) {
      const e = g.enemies[list[i]];
      if (!e || e.dead || !e.targetable) continue;
      const d2 = dist2(p.x, p.y, e.x, e.y);
      if (d2 > bestD) continue;
      if (!g.world.lineOfSight(p.x, p.y, e.x, e.y)) continue;
      bestD = d2;
      best = e;
    }

    const cur = g.autoTarget;
    if (cur && !cur.dead && cur.targetable) {
      const dCur = dist2(p.x, p.y, cur.x, cur.y);
      // 30% hysteresis before switching away from a target already engaged.
      if (dCur <= range * range && dCur < bestD * 1.7 &&
          g.world.lineOfSight(p.x, p.y, cur.x, cur.y)) {
        return cur;
      }
    }
    return best;
  }

  private mine(node: OreNode, dt: number) {
    const g = this.game;
    const p = g.player;
    p.miningHeat = Math.min(1, p.miningHeat + dt * 4);
    const rate = 30 * g.perks.miningSpeed * (node.rich ? 1.5 : 1);
    const got = g.world.drain(node, rate * dt);
    const gain = got * g.perks.oreYield;
    g.ore += gain;
    g.buffers.ore += gain;
    g.runStats.oreMined += gain;

    const nx = (node.tx + 0.5) * TILE, ny = (node.ty + 0.5) * TILE;
    if (chance(dt * 26)) {
      audio.play('mine', rand(0.9, 1.15));
      const a = Math.atan2(p.y - ny, p.x - nx) + rand(-0.6, 0.6);
      g.particles.spawn(nx + rand(-8, 8), ny + rand(-8, 8),
        Math.cos(a) * rand(60, 180), Math.sin(a) * rand(60, 180),
        rand(0.2, 0.5), rand(1.5, 3.5), g.level.palette.oreColor, PKind.Spark, { grav: 60 });
    }
    if (node.amount <= 0) {
      audio.play('mineDone');
      g.particles.explosion(nx, ny, 34, g.level.palette.oreColor, g.level.palette.rock);
      g.progress.bump('mineNode');
      g.shake(3);
    }
  }

  /** Fires whatever `player.weapon` currently is — see data/loadout.ts for the roster. */
  private playerShoot() {
    const g = this.game;
    const p = g.player;
    const mx = p.x + Math.cos(p.aim) * 22;
    const my = p.y + Math.sin(p.aim) * 22;
    const pierce = g.perks.armorShred;

    switch (p.weapon) {
      case 'dualmg': {
        // Twin barrels either side of the aim line, each its own stream —
        // more total lead downrange, looser accuracy than the rifle.
        const dmg = 9 * g.perks.playerDamage;
        for (const side of [-1, 1]) {
          const ox = -Math.sin(p.aim) * side * 6, oy = Math.cos(p.aim) * side * 6;
          const a = p.aim + rand(-0.09, 0.09);
          g.fire({
            x: mx + ox, y: my + oy, angle: a, speed: 980, damage: dmg, kind: 'bullet',
            faction: 'player', color: 0xfff0a0, size: 3, life: 0.7,
            armorPierce: 1 + pierce, ownerId: 0, splash: 0,
          });
        }
        g.particles.muzzle(mx, my, p.aim, 0xffd98a, 1);
        audio.play('shoot', rand(1.1, 1.25));
        break;
      }
      case 'shotgun': {
        const pellets = 5;
        const dmg = 7 * g.perks.playerDamage;
        for (let i = 0; i < pellets; i++) {
          const a = p.aim + rand(-0.22, 0.22);
          g.fire({
            x: mx, y: my, angle: a, speed: 900, damage: dmg, kind: 'bullet',
            faction: 'player', color: 0xffcf7a, size: 2.6, life: 0.4,
            armorPierce: pierce, ownerId: 0, splash: 0,
          });
        }
        g.particles.muzzle(mx, my, p.aim, 0xffcf7a, 1.4);
        audio.play('shoot', rand(0.75, 0.85));
        break;
      }
      case 'rocket': {
        const dmg = 65 * g.perks.playerDamage;
        g.fire({
          x: mx, y: my, angle: p.aim, speed: 560, damage: dmg, kind: 'rocket',
          faction: 'player', color: 0xffb066, size: 5, life: 1.6,
          armorPierce: 6 + pierce, ownerId: 0, splash: 55,
        });
        g.particles.muzzle(mx, my, p.aim, 0xffb066, 1.6);
        audio.play('shootHeavy', rand(0.9, 1));
        g.shake(2);
        break;
      }
      default: {
        const spread = 0.035;
        const a = p.aim + rand(-spread, spread);
        const dmg = 16 * g.perks.playerDamage;
        g.fire({
          x: mx, y: my, angle: a, speed: 980, damage: dmg, kind: 'bullet',
          faction: 'player', color: 0xfff0a0, size: 3.4, life: 0.7,
          armorPierce: 2 + pierce, ownerId: 0, splash: 0,
        });
        g.particles.muzzle(mx, my, p.aim, 0xffd98a, 1);
        audio.play('shoot', rand(0.94, 1.08));
      }
    }

    // Recoil is expressed on the weapon sprite and the crosshair only — the
    // camera is deliberately left alone so sustained fire never shakes the view.
    p.recoil = 1;
  }

  damagePlayer(amount: number, silent = false) {
    const g = this.game;
    const p = g.player;
    if (p.dead || p.invuln > 0) return;
    p.hp -= amount;
    if (!silent) {
      p.hitFlash = 1;
      g.shake(4);
      g.addFlash(1, 0.2, 0.2, clamp(amount / 60, 0.05, 0.28));
      audio.play('hit', 0.6);
    }
    if (p.hp <= 0) {
      p.hp = 0;
      p.dead = true;
      p.invuln = 3.2;
      g.particles.explosion(p.x, p.y, 44, 0x7fd9ff, g.level.palette.rock);
      audio.play('explode');
      g.shake(12);
      g.setBanner(
        tr('game.banner.chassisDown', 'CHASSIS DOWN'),
        tr('game.banner.chassisDownDetail', 'Rebuilding at the core…'),
        3, '#ff4f5e',
      );
    }
  }
}
