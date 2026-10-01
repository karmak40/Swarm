import { audio } from '../../core/audio';
import { t as tr } from '../../core/i18n';
import {
  TAU, chance, clamp, damp, dist, dist2, rand, rotateToward,
} from '../../core/math';
import { PKind } from '../../engine/particles';
import type { SpatialHash } from '../../engine/spatial';
import {
  BUILD_CATEGORIES, BUILDINGS, REPAIR_COST_PER_HP, SELL_RATIO, buildingsInCategory,
  type BuildCategory, type BuildingDef, type BuildingKind, type TargetingMode,
} from '../../data/buildings';
import { Building, type Enemy, type Projectile } from '../entities';
import { MAX_BUILDING_LEVEL, upgradeCostFraction, type UpgradeBranch } from '../../data/upgrades';
import { TILE, Tile } from '../world';
import type { Game } from '../game';

/** Largest dome any Force Field def can hold — bounds the fieldAt() broadphase query. */
const FIELD_QUERY_RADIUS = Math.max(
  130, ...Object.values(BUILDINGS).filter((d) => d.fieldHp !== undefined).map((d) => d.auraRadius ?? 130),
);

/**
 * Everything a placed structure can be: placement/economy, the power grid,
 * per-type upkeep (extractor, repair bay, shield pylon, force field), and
 * turret targeting/firing. Drones have their own system (`DroneSystem`) even
 * though drone *bays* are buildings — the bay's upkeep tick lives here, the
 * drones themselves are a separate lifecycle.
 */
/** How far from the pilot (px) structures can be placed — see BuildingSystem.buildAnchor. */
export const BUILD_REACH = 10 * TILE;

export class BuildingSystem {
  readonly buildings: Building[] = [];
  /** Tile → building occupying it, for O(1) collision and placement checks. */
  buildingAt: (Building | null)[] = [];
  buildingHash!: SpatialHash;
  buildingQueryBuf: number[] = [];
  /** id → building, for O(1) lookups (drone bays) instead of scanning `buildings`. */
  buildingById = new Map<number, Building>();
  power = { supply: 0, draw: 0, efficiency: 1 };

  constructor(private game: Game) {}

  /** Cycles a turret's target priority. Shared by the T key and the touch menu. */
  cycleTargeting(b: Building) {
    if (!b.isTurret) return;
    const modes: TargetingMode[] = ['first', 'closest', 'strongest', 'weakest'];
    b.targeting = modes[(modes.indexOf(b.targeting) + 1) % modes.length];
    audio.play('uiClick');
  }

  /**
   * One tap's worth of repair. The held-key path bills continuously; touch has no
   * comfortable equivalent, so this applies a fixed chunk per tap instead.
   */
  repairBuildingBurst(b: Building): boolean {
    const g = this.game;
    const missing = b.maxHp - b.hp;
    if (missing <= 0) return false;
    const heal = Math.min(missing, b.maxHp * 0.25);
    const cost = heal * REPAIR_COST_PER_HP;
    if (g.ore < cost) { g.presentation.error(tr('game.error.notEnoughOreRepair', 'Not enough ore to repair')); return false; }
    g.ore -= cost;
    b.hp += heal;
    g.buffers.repair += heal;
    g.particles.ring(b.x, b.y, b.radius * 1.5, 0x5cf2a0, 0.3);
    audio.play('repair');
    return true;
  }

  buildingAtTile(tx: number, ty: number): Building | null {
    const world = this.game.world;
    if (!world.inBounds(tx, ty)) return null;
    return this.buildingAt[world.idx(tx, ty)];
  }

  /**
   * Returns null when placement is legal, otherwise a player-facing reason.
   * `restoring` is set when replaying a save: the structure was already paid
   * for, and the player's restored position is irrelevant to whether it's
   * valid. (Checking cost there used to drop any structure pricier than the
   * ore the player happened to be holding at save time.)
   */
  /**
   * Where the build reach is measured from: the pilot, or the core while the
   * pilot is down (so a dead pilot never soft-locks the build phase). Without
   * a reach the camera could be zoomed out and the whole map built up from
   * one spot.
   */
  buildAnchor(): { x: number; y: number } {
    const g = this.game;
    return g.player.dead ? g.core : g.player;
  }

  canPlace(def: BuildingDef, tx: number, ty: number, restoring = false): string | null {
    const g = this.game;
    const world = g.world;
    const cost = this.costOf(def);
    if (!restoring && g.ore < cost.ore) return tr('game.place.needOre', 'Need {n} ore', { n: cost.ore });
    if (!restoring && g.essence < cost.essence) {
      return tr('game.place.needEssence', 'Need {n} essence', { n: cost.essence });
    }

    let coversNode = false;
    for (let y = ty; y < ty + def.size; y++) {
      for (let x = tx; x < tx + def.size; x++) {
        if (!world.inBounds(x, y)) return tr('game.place.outOfBounds', 'Out of bounds');
        if (world.isSolid(x, y)) return tr('game.place.solidRock', 'Solid rock');
        if (this.buildingAt[world.idx(x, y)]) return tr('game.place.occupied', 'Occupied');
        const tile = world.tileAt(x, y);
        if (tile === Tile.Hazard) return tr('game.place.hazard', 'Too hot to build here');
        if (tile === Tile.Ore || tile === Tile.RichOre) coversNode = true;
      }
    }

    const cx = (tx + def.size / 2) * TILE, cy = (ty + def.size / 2) * TILE;
    if (!restoring) {
      const a = this.buildAnchor();
      if (dist(cx, cy, a.x, a.y) > BUILD_REACH + def.size * TILE * 0.5) {
        return g.player.dead
          ? tr('game.place.tooFarCore', 'Too far from the core')
          : tr('game.place.tooFarPilot', 'Too far from the pilot — move closer');
      }
    }

    // Keep the core plaza clear.
    if (dist(cx, cy, g.core.x, g.core.y) < g.core.radius + def.size * TILE * 0.5 + 4) {
      return tr('game.place.tooCloseCore', 'Too close to the core');
    }
    // Don't let the player wall themselves in.
    if (!restoring && !g.player.dead
      && dist(cx, cy, g.player.x, g.player.y) < g.player.radius + def.size * TILE * 0.5) {
      return tr('game.place.playerInWay', 'Character is in the way');
    }
    // Do not let players cap a spawn gate.
    for (const s of world.spawns) {
      if (dist(cx, cy, s.x, s.y) < TILE * 3.2) {
        return tr('game.place.tooCloseGate', 'Too close to a hive gate');
      }
    }

    if (def.id === 'extractor' && !coversNode) {
      return tr('game.place.needsOreSeam', 'Must be placed on an ore seam');
    }
    if (def.id !== 'extractor' && coversNode) {
      return tr('game.place.seamExtractorOnly', 'Ore seam — only extractors fit here');
    }

    return null;
  }

  costOf(def: BuildingDef) {
    const perks = this.game.perks;
    return {
      ore: Math.max(1, Math.round(def.ore * perks.buildCost)),
      essence: Math.round(def.essence * perks.buildCost),
    };
  }

  place(def: BuildingDef, tx: number, ty: number) {
    const g = this.game;
    const world = g.world;
    const cost = this.costOf(def);
    g.ore -= cost.ore;
    g.essence -= cost.essence;

    const b = new Building(def, tx, ty, TILE, g.perks.structureHp);
    b.progress = 0;
    this.buildings.push(b);
    this.buildingById.set(b.id, b);

    for (let y = ty; y < ty + def.size; y++) {
      for (let x = tx; x < tx + def.size; x++) {
        this.buildingAt[world.idx(x, y)] = b;
        if (def.blocksMovement) world.field.setCost(x, y, def.pathCost);
      }
    }

    if (def.id === 'extractor') {
      for (let y = ty; y < ty + def.size; y++) {
        for (let x = tx; x < tx + def.size; x++) {
          const n = world.nodeAtTile(x, y);
          if (n) { b.nodeIndex = world.nodes.indexOf(n); n.claimedBy = b.id; break; }
        }
        if (b.nodeIndex >= 0) break;
      }
    }

    g.runStats.built++;
    g.progress.bump('build');
    g.progress.recordRunStat('buildingsBuilt', 1);
    audio.play('build');
    g.particles.dust(b.x, b.y, g.level.palette.rockLit, 10);
    g.particles.ring(b.x, b.y, b.radius * 1.6, 0x7fd9ff, 0.3);
    g.shake(2.5);
  }

  /** What selling `b` would return right now — shared with the touch sell prompt. */
  sellValue(b: Building) {
    const g = this.game;
    const cost = this.costOf(b.def);
    // Upgrades paid in are refunded at the same rate as the structure itself.
    const spent = this.upgradeSpent(b);
    return {
      ore: Math.round((cost.ore * (0.5 + b.progress * 0.5) + spent.ore) * SELL_RATIO * g.perks.sellRefund),
      essence: Math.round((cost.essence + spent.essence) * SELL_RATIO * g.perks.sellRefund),
    };
  }

  /* ---- upgrades (see data/upgrades.ts) ---------------------------------- */

  /** Price of the step to `level` for this structure type, or null past the cap. */
  private stepCost(def: BuildingDef, level: number) {
    const f = upgradeCostFraction(level);
    if (f <= 0) return null;
    const base = this.costOf(def);
    return { ore: Math.max(1, Math.round(base.ore * f)), essence: Math.round(base.essence * f) };
  }

  /**
   * Cost of `b`'s next upgrade, or null when it can't go further: not a
   * turret, still under construction, or already at the top level.
   */
  upgradeCost(b: Building) {
    if (!b.isTurret || !b.built || b.level >= MAX_BUILDING_LEVEL) return null;
    return this.stepCost(b.def, b.level + 1);
  }

  /** Total paid into `b`'s upgrades so far, at today's prices (for refunds). */
  private upgradeSpent(b: Building) {
    const total = { ore: 0, essence: 0 };
    for (let lv = 2; lv <= b.level; lv++) {
      const c = this.stepCost(b.def, lv);
      if (c) { total.ore += c.ore; total.essence += c.essence; }
    }
    return total;
  }

  /**
   * Buys `b`'s next level. Level 3 needs a `branch`. Returns whether it
   * happened; on failure the reason is shown as the usual error toast.
   */
  upgradeBuilding(b: Building, branch?: UpgradeBranch): boolean {
    const g = this.game;
    const cost = this.upgradeCost(b);
    if (!cost || b.dead) return false;
    const next = b.level + 1;
    if (next === MAX_BUILDING_LEVEL && !branch) return false;
    if (g.ore < cost.ore) {
      g.presentation.error(tr('game.error.upgradeNeedOre', 'Need {n} ore to upgrade', { n: cost.ore }));
      return false;
    }
    if (g.essence < cost.essence) {
      g.presentation.error(tr('game.error.upgradeNeedEssence', 'Need {n} essence to upgrade', { n: cost.essence }));
      return false;
    }
    g.ore -= cost.ore;
    g.essence -= cost.essence;
    this.applyLevel(b, next, next === MAX_BUILDING_LEVEL ? branch! : null);
    audio.play('build');
    g.particles.ring(b.x, b.y, b.radius * 1.8, branch === 'rapid' ? 0xffb347 : 0x7fd9ff, 0.4);
    g.shake(1.5);
    return true;
  }

  /**
   * Sets a level/branch and grows the hull to match, keeping the damage it
   * has already taken (the new capacity arrives repaired).
   */
  private applyLevel(b: Building, level: number, branch: UpgradeBranch | null) {
    const missing = b.maxHp - b.hp;
    b.level = level;
    b.branch = branch;
    b.maxHp = Math.round(b.def.hp * this.game.perks.structureHp * b.upgrade.hp);
    b.hp = clamp(b.maxHp - missing, 1, b.maxHp);
  }

  sellBuilding(b: Building) {
    const g = this.game;
    const { ore: refund, essence: refundE } = this.sellValue(b);
    g.ore += refund;
    g.essence += refundE;
    this.removeBuilding(b, false);
    g.progress.bump('sell');
    audio.play('sell');
    g.presentation.spawnDamageNumber(b.x, b.y, refund, false, 0x7fd9ff);
  }

  repairBuilding(b: Building, dt: number) {
    const g = this.game;
    const missing = b.maxHp - b.hp;
    if (missing <= 0) return;
    const rate = 90 * g.perks.repairRate * dt;
    const heal = Math.min(missing, rate);
    const cost = heal * REPAIR_COST_PER_HP;
    if (g.ore < cost) return;
    g.ore -= cost;
    b.hp += heal;
    g.buffers.repair += heal;
    if (chance(dt * 20)) {
      g.particles.spawn(
        b.x + rand(-b.radius, b.radius), b.y + rand(-b.radius, b.radius),
        rand(-20, 20), rand(-60, -20), rand(0.2, 0.5), rand(1.5, 3), 0x5cf2a0, PKind.Spark,
      );
      audio.play('repair');
    }
  }

  removeBuilding(b: Building, destroyed: boolean) {
    const g = this.game;
    const world = g.world;
    b.dead = true;
    for (let y = b.ty; y < b.ty + b.size; y++) {
      for (let x = b.tx; x < b.tx + b.size; x++) {
        if (this.buildingAt[world.idx(x, y)] === b) {
          this.buildingAt[world.idx(x, y)] = null;
          world.field.setCost(x, y, 1);
        }
      }
    }
    if (b.nodeIndex >= 0) {
      const n = world.nodes[b.nodeIndex];
      if (n) n.claimedBy = -1;
    }
    const i = this.buildings.indexOf(b);
    if (i >= 0) this.buildings.splice(i, 1);
    this.buildingById.delete(b.id);

    // Any enemy chewing on it needs a new target.
    for (const e of g.enemies) if (e.targetBuilding === b) { e.targetBuilding = null; e.retargetIn = 0; }

    // A bay's drones have nowhere to unload and nothing to service them.
    if (b.def.droneSlots !== undefined) {
      for (const d of g.drones) if (!d.dead && d.bayId === b.id) g.droneSystem.killDrone(d, false);
    }

    if (destroyed) {
      g.runStats.structuresLost++;
      g.structuresLostThisWave++;
      const pal = g.level.palette;
      if (b.kind === 'generator') {
        // Reactors go off like a bomb — a real risk to a dense build.
        g.explode(b.x, b.y, 118, 90, 'player');
        audio.play('explodeBig');
        g.shake(16);
        g.addFlash(1, 0.7, 0.3, 0.35);
      } else {
        g.particles.explosion(b.x, b.y, b.radius * 1.5, 0xffa657, pal.rock);
        audio.play('explode');
        g.shake(6);
      }
      g.particles.gib(b.x, b.y, pal.rockLit, 12, 1.2);
    }
  }

  /* ====================================================================== */
  /* Power                                                                   */
  /* ====================================================================== */

  updatePower() {
    const g = this.game;
    let supply = 0, draw = 0;
    for (const b of this.buildings) {
      if (!b.built) continue;
      if (b.def.power < 0) supply += -b.def.power * g.perks.powerOutput;
      else draw += b.def.power;
    }
    this.power.supply = supply;
    this.power.draw = draw;
    this.power.efficiency = draw <= 0 ? 1 : clamp(supply / draw, 0.15, 1);
    for (const b of this.buildings) b.efficiency = b.def.power > 0 ? this.power.efficiency : 1;

    if (this.power.efficiency >= 1 && draw > g.runStats.bestPower) {
      g.runStats.bestPower = draw;
      g.progress.bump('powerCap', Math.floor(draw), 'max');
    }
  }

  /* ====================================================================== */
  /* Per-tick upkeep, dispatched by type                                     */
  /* ====================================================================== */

  updateBuildings(dt: number) {
    const g = this.game;
    for (let i = this.buildings.length - 1; i >= 0; i--) {
      const b = this.buildings[i];
      b.hitFlash = Math.max(0, b.hitFlash - dt * 5);
      b.recoil = damp(b.recoil, 0, 12, dt);
      b.muzzleFlash = Math.max(0, b.muzzleFlash - dt * 9);

      if (!b.built) {
        b.progress = Math.min(1, b.progress + (dt / b.def.buildTime) * g.perks.buildSpeed);
        if (b.built) {
          g.particles.ring(b.x, b.y, b.radius * 2, 0x7fd9ff, 0.35);
          audio.play('mineDone');
          // A finished bay launches its whole complement at once — you paid for
          // the drones. The respawn timer exists to make *losses* hurt, not to
          // tax you for building the thing in the first place.
          if (b.def.droneSlots !== undefined) {
            for (let k = 0; k < Math.round(b.def.droneSlots); k++) g.droneSystem.spawnDrone(b);
            b.droneCooldown = 0;
          }
          // Force Field: starts charging the moment construction finishes —
          // the short first charge, see popForceField for the longer repeats.
          if (b.def.fieldHp !== undefined) {
            b.fieldChargeTimer = b.def.chargeTime ?? 6;
            b.fieldChargeTotal = b.fieldChargeTimer;
          }
        }
        continue;
      }

      if (b.maxShield > 0) {
        b.shield = Math.min(b.maxShield, b.shield + b.maxShield * 0.12 * dt);
      }

      if (b.def.droneSlots !== undefined) g.droneSystem.updateDroneBay(b, dt);
      if (b.def.extractRate !== undefined) this.updateExtractor(b, dt);
      if (b.def.repairRate !== undefined) this.updateRepairBay(b, dt);
      if (b.def.shieldAmount !== undefined) this.updateShieldPylon(b, dt);
      if (b.def.fieldHp !== undefined) this.updateForceField(b, dt);
      if (b.isTurret) {
        // Webbed by the Weaver: silent until it wears off (beams wind down too).
        if (b.webbed > 0) {
          b.webbed = Math.max(0, b.webbed - dt);
          b.beamIntensity = damp(b.beamIntensity, 0, 10, dt);
        } else {
          this.updateTurret(b, dt);
        }
      }
    }
  }

  private updateExtractor(b: Building, dt: number) {
    const g = this.game;
    const node = b.nodeIndex >= 0 ? g.world.nodes[b.nodeIndex] : undefined;
    if (!node || node.amount <= 0) return;
    const rate = b.def.extractRate! * g.perks.extractorRate * b.efficiency * (node.rich ? 1.6 : 1);
    const got = g.world.drain(node, rate * dt);
    const gain = got * g.perks.oreYield;
    b.extractBuffer += gain;
    g.ore += gain;
    g.buffers.ore += gain;
    g.runStats.oreMined += gain;
    if (b.extractBuffer >= 10) {
      b.extractBuffer -= 10;
      g.particles.spawn(b.x, b.y - 6, rand(-14, 14), rand(-70, -40), 0.5, 3,
        g.level.palette.oreColor, PKind.Spark, { grav: 40 });
    }
    if (node.amount <= 0) g.progress.bump('mineNode');
  }

  private updateRepairBay(b: Building, dt: number) {
    const g = this.game;
    const rate = b.def.repairRate! * g.perks.repairRate * b.efficiency * dt;
    const radius = b.def.auraRadius!;
    const r2 = radius * radius;
    let healed = 0;
    const list = this.buildingHash.query(b.x, b.y, radius, this.buildingQueryBuf);
    for (let k = 0; k < list.length; k++) {
      const t = this.buildings[list[k]];
      if (!t || t.hp >= t.maxHp || !t.built) continue;
      if (dist2(b.x, b.y, t.x, t.y) > r2) continue;
      const heal = Math.min(t.maxHp - t.hp, rate);
      t.hp += heal;
      healed += heal;
      if (chance(dt * 6)) {
        g.particles.spawn(t.x + rand(-10, 10), t.y + rand(-10, 10), rand(-10, 10), rand(-40, -10),
          rand(0.3, 0.6), rand(1.5, 3), 0x5cf2a0, PKind.Spark);
      }
    }
    if (g.core.hp < g.core.maxHp && dist2(b.x, b.y, g.core.x, g.core.y) <= r2) {
      const heal = Math.min(g.core.maxHp - g.core.hp, rate * 1.5);
      g.core.hp += heal;
      healed += heal;
    }
    g.buffers.repair += healed;
  }

  private updateShieldPylon(b: Building, dt: number) {
    const g = this.game;
    const amount = b.def.shieldAmount! * b.efficiency;
    const radius = b.def.auraRadius!;
    const r2 = radius * radius;
    const list = this.buildingHash.query(b.x, b.y, radius, this.buildingQueryBuf);
    for (let k = 0; k < list.length; k++) {
      const t = this.buildings[list[k]];
      if (!t || !t.built) continue;
      if (dist2(b.x, b.y, t.x, t.y) > r2) continue;
      if (t.maxShield < amount) t.maxShield = amount;
      t.shield = Math.min(t.maxShield, t.shield + amount * 0.25 * dt);
    }
    if (dist2(b.x, b.y, g.core.x, g.core.y) <= r2) {
      const coreShield = amount * 2.5;
      if (g.core.maxShield < coreShield) g.core.maxShield = coreShield;
      g.core.shield = Math.min(g.core.maxShield, g.core.shield + coreShield * 0.2 * dt);
    }
  }

  /**
   * Force Field: charges on power, then holds a flat hp pool that only
   * ranged fire can spend (see absorbIntoField / fieldAt, and the call sites
   * in projectileVsPlayerSide and damageAlongLine). Unlike the Aegis Pylon's
   * shield, this does not regenerate while up — it holds until popped, then
   * has to charge back from zero, slower than the first time.
   */
  private updateForceField(b: Building, dt: number) {
    const g = this.game;
    const maxHp = b.def.fieldHp! * g.perks.structureHp;
    if (b.fieldChargeTimer > 0) {
      // Underpowered slows the charge instead of stopping it outright — a
      // half-lit grid still gets there, just not on schedule.
      b.fieldChargeTimer = Math.max(0, b.fieldChargeTimer - dt * Math.max(0.1, b.efficiency));
      if (b.fieldChargeTimer <= 0) {
        b.fieldHp = maxHp;
        b.fieldMaxHp = maxHp;
        g.particles.ring(b.x, b.y, b.def.auraRadius ?? 130, 0x9fd8ff, 0.5);
        audio.play('levelUp');
      }
      return;
    }
    if (b.fieldHp <= 0) return;
    b.fieldMaxHp = maxHp;
    // Active but underpowered: the dome itself bleeds down instead of just
    // sitting there for free — upkeep is a real cost, not a one-time toggle.
    if (b.efficiency < 1) {
      b.fieldHp = Math.max(0, b.fieldHp - (1 - b.efficiency) * maxHp * 0.15 * dt);
      if (b.fieldHp <= 0) this.popForceField(b);
    }
  }

  /** The dome has taken (or bled) enough damage to collapse — starts the (longer) recharge. */
  private popForceField(b: Building) {
    const g = this.game;
    b.fieldHp = 0;
    b.fieldChargeTimer = b.def.rechargeTime ?? 16;
    b.fieldChargeTotal = b.fieldChargeTimer;
    g.particles.explosion(b.x, b.y, (b.def.auraRadius ?? 130) * 0.35, 0x9fd8ff, g.level.palette.rock);
    audio.play('explode');
  }

  /** The active Force Field (if any) whose dome covers this point. */
  fieldAt(x: number, y: number): Building | null {
    const list = this.buildingHash.query(x, y, FIELD_QUERY_RADIUS, this.buildingQueryBuf);
    for (let k = 0; k < list.length; k++) {
      const b = this.buildings[list[k]];
      if (!b || !b.built || b.def.fieldHp === undefined || b.fieldHp <= 0) continue;
      const r = b.def.auraRadius ?? 130;
      if (dist2(x, y, b.x, b.y) <= r * r) return b;
    }
    return null;
  }

  /**
   * Routes ranged damage aimed at (x, y) into a covering Force Field's own
   * hp instead of the actual target, if one is up. Returns whether it was
   * absorbed — callers skip their normal damage application when true.
   * Melee/contact damage never calls this, which is what makes the field
   * "ranged-only": see projectileVsPlayerSide and damageAlongLine, its only
   * two callers.
   */
  absorbIntoField(x: number, y: number, amount: number): boolean {
    const field = this.fieldAt(x, y);
    if (!field) return false;
    field.fieldHp = Math.max(0, field.fieldHp - amount);
    this.game.particles.impact(x, y, 0, 0x9fd8ff, 0.8);
    if (field.fieldHp <= 0) this.popForceField(field);
    return true;
  }

  private updateTurret(b: Building, dt: number) {
    const g = this.game;
    const def = b.def;
    const range = def.range! * g.perks.turretRange * b.upgrade.range;

    // Retarget periodically, or immediately if the current target is gone.
    if (!b.target || b.target.dead || !b.target.targetable || dist2(b.x, b.y, b.target.x, b.target.y) > range * range) {
      b.target = this.findTarget(b, range);
    }

    if (!b.target) {
      b.beamIntensity = damp(b.beamIntensity, 0, 10, dt);
      // Idle sweep so the field feels alive.
      b.angle += Math.sin(g.elapsed * 0.6 + b.phase) * dt * 0.35;
      return;
    }

    const t = b.target;
    const lead = def.projectileSpeed
      ? dist(b.x, b.y, t.x, t.y) / def.projectileSpeed
      : 0;
    const px = t.x + t.vx * lead;
    const py = t.y + t.vy * lead;
    const want = Math.atan2(py - b.y, px - b.x);
    const turn = (def.turnRate ?? 5) * dt;
    b.angle = rotateToward(b.angle, want, turn);

    const aligned = Math.abs(((want - b.angle + Math.PI * 3) % TAU) - Math.PI) < 0.16;
    const rate = def.fireRate! * g.perks.turretFireRate * b.upgrade.rate * b.efficiency;

    if (def.beam) {
      // Continuous beam: damage is applied per second while locked on.
      if (aligned) {
        b.beamIntensity = damp(b.beamIntensity, 1, 12, dt);
        this.beamTick(b, dt, range);
        if (chance(dt * 12)) audio.play('laser', rand(0.9, 1.1));
      } else {
        b.beamIntensity = damp(b.beamIntensity, 0, 10, dt);
      }
      return;
    }

    b.cooldown -= dt;
    if (b.burstLeft > 0) {
      b.burstTimer -= dt;
      if (b.burstTimer <= 0) {
        this.turretFire(b, range);
        // Additionally damp burst follow-ups: retriggering every 75ms is what
        // turned the flak's twin muzzles into one continuous glare.
        const bf = b.def.muzzleFlare ?? 1;
        if (bf < 1) b.muzzleFlash = Math.min(b.muzzleFlash, 0.35 + bf * 0.3);
        b.burstLeft--;
        b.burstTimer = 0.075;
      }
      return;
    }
    if (b.cooldown <= 0 && aligned) {
      b.cooldown = 1 / Math.max(0.05, rate);
      if (def.burst && def.burst > 1) {
        b.burstLeft = def.burst - 1;
        b.burstTimer = 0.075;
      }
      this.turretFire(b, range);
    }
  }

  private findTarget(b: Building, range: number): Enemy | null {
    const g = this.game;
    const def = b.def;
    const r2 = range * range;
    const list = g.enemyHash.query(b.x, b.y, range, g.queryBuf);
    let best: Enemy | null = null;
    let bestScore = -Infinity;

    for (let i = 0; i < list.length; i++) {
      const e = g.enemies[list[i]];
      if (!e || e.dead || !e.targetable) continue;
      if (def.antiAir === undefined && e.flying) continue;
      if (def.groundOnly && e.flying) continue;
      const d2 = dist2(b.x, b.y, e.x, e.y);
      if (d2 > r2) continue;
      // Mortars and missiles cannot arm inside their minimum engagement range.
      if (def.minRange && d2 < def.minRange * def.minRange) continue;

      let score: number;
      switch (b.targeting) {
        case 'closest': score = -d2; break;
        case 'strongest': score = e.hp + (e.boss ? 1e6 : 0); break;
        case 'weakest': score = -e.hp; break;
        default: {
          // 'first' = furthest along the path to the core.
          const d = g.world.field.distAt(Math.floor(e.x / TILE), Math.floor(e.y / TILE));
          score = -(Number.isFinite(d) ? d : 1e6);
          break;
        }
      }
      if (e.boss && b.targeting === 'first') score += 50;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  private turretFire(b: Building, range: number) {
    const g = this.game;
    const def = b.def;
    const muzzleLen = b.radius * 0.9;
    const mx = b.x + Math.cos(b.angle) * muzzleLen;
    const my = b.y + Math.sin(b.angle) * muzzleLen;
    const dmg = def.damage! * g.perks.turretDamage * b.upgrade.damage;
    b.recoil = 1;
    // Low-flare guns never reach a full-intensity flash at all, not even on the
    // first round of a burst — that first slam was the remaining glare source.
    const flare = def.muzzleFlare ?? 1;
    b.muzzleFlash = flare >= 1 ? 1 : Math.min(1, 0.25 + flare * 0.75);

    if (def.chains) {
      this.arcChain(b, dmg, range);
      audio.play('tesla', rand(0.9, 1.1));
      return;
    }

    if (def.id === 'mortar') {
      const t = b.target!;
      const flight = clamp(dist(b.x, b.y, t.x, t.y) / def.projectileSpeed!, 0.6, 3.2);
      g.fireMortar(mx, my, t.x + t.vx * flight * 0.7, t.y + t.vy * flight * 0.7, dmg, def, b, flight);
      audio.play('shootHeavy', rand(0.85, 1.0));
      g.particles.muzzle(mx, my, b.angle, 0xffb066, 1.6);
      return;
    }

    const spread = def.spread ?? 0;
    const angle = b.angle + rand(-spread, spread);
    const kind: Projectile['kind'] = def.homing ? 'rocket'
      : def.splash ? (def.id === 'flak' ? 'flak' : 'shell')
      : 'bullet';

    // Missiles leave from alternating pods so a burst reads as two launches.
    let ox = 0, oy = 0;
    if (def.homing) {
      const side = b.burstLeft % 2 === 0 ? 1 : -1;
      ox = -Math.sin(b.angle) * b.radius * 0.42 * side;
      oy = Math.cos(b.angle) * b.radius * 0.42 * side;
    }

    g.fire({
      x: mx + ox, y: my + oy, angle, speed: def.projectileSpeed!, damage: dmg, kind,
      faction: 'player',
      color: def.homing ? 0xffb8a0
        : def.id === 'cannon' ? 0xffb066
        : def.id === 'flak' ? 0xffe08a
        : 0x9fe8ff,
      size: def.homing ? 6 : def.splash ? 5 : 3,
      // Guided shots need extra flight time because they curve rather than fly straight.
      life: (range / def.projectileSpeed!) * (def.homing ? 2.4 : 1.35),
      armorPierce: (def.armorPierce ?? 0) + g.perks.armorShred,
      ownerId: b.id, splash: def.splash ?? 0,
      homingTarget: def.homing ? b.target : null,
      homingTurn: def.homingTurn ?? 0,
    });

    g.particles.muzzle(mx + ox, my + oy, b.angle,
      def.homing ? 0xffd0b0 : def.splash ? 0xffb066 : 0xbfe8ff,
      (def.homing ? 1.8 : def.splash ? 1.5 : 0.9) * (def.muzzleFlare ?? 1));
    audio.play(def.splash ? 'shootHeavy' : 'shoot', rand(0.9, 1.1));
  }

  /** Tesla chain: hop between nearby enemies, losing damage each jump. */
  private arcChain(b: Building, dmg: number, range: number) {
    const g = this.game;
    const hops = b.def.chains!;
    let cur: { x: number; y: number } = b;
    const hit = new Set<number>();
    let power = dmg;

    for (let i = 0; i < hops; i++) {
      const searchR = i === 0 ? range : 120;
      const list = g.enemyHash.query(cur.x, cur.y, searchR, g.queryBuf);
      let next: Enemy | null = null;
      let bestD = searchR * searchR;
      for (let k = 0; k < list.length; k++) {
        const e = g.enemies[list[k]];
        if (!e || e.dead || !e.targetable || hit.has(e.id)) continue;
        const d2 = dist2(cur.x, cur.y, e.x, e.y);
        if (d2 < bestD) { bestD = d2; next = e; }
      }
      if (!next) break;
      hit.add(next.id);
      g.effects.push({
        kind: 'arc', x: cur.x, y: cur.y, x2: next.x, y2: next.y,
        radius: 0, life: 0.16, maxLife: 0.16, color: 0x9fd8ff, width: 3 - i * 0.4,
        seed: Math.random() * 1000,
      });
      g.damageEnemy(next, power, { source: 'turret', armorPierce: g.perks.armorShred, building: b });
      if (b.def.slowFactor) {
        next.slowTimer = Math.max(next.slowTimer, 1.6);
        next.slowFactor = b.def.slowFactor;
      }
      cur = next;
      power *= 0.72;
    }
  }

  /** Lance beam: pierces up to `pierce` bodies along a ray. */
  private beamTick(b: Building, dt: number, range: number) {
    const g = this.game;
    const world = g.world;
    const def = b.def;
    const up = b.upgrade;
    const dps = def.damage! * g.perks.turretDamage * up.damage * def.fireRate! * up.rate * b.efficiency;
    const dirX = Math.cos(b.angle), dirY = Math.sin(b.angle);

    // Truncate the beam at terrain.
    let reach = range;
    const steps = Math.ceil(range / (TILE * 0.5));
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * range;
      if (world.solidAtPx(b.x + dirX * t, b.y + dirY * t)) { reach = t; break; }
    }
    b.beamHitX = b.x + dirX * reach;
    b.beamHitY = b.y + dirY * reach;

    const list = g.enemyHash.query(
      b.x + dirX * reach * 0.5, b.y + dirY * reach * 0.5, reach * 0.5 + 40, g.queryBuf,
    );
    const along: { e: Enemy; t: number }[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = g.enemies[list[i]];
      if (!e || e.dead || !e.targetable) continue;
      const rx = e.x - b.x, ry = e.y - b.y;
      const t = rx * dirX + ry * dirY;
      if (t < 0 || t > reach) continue;
      const perp = Math.abs(rx * dirY - ry * dirX);
      if (perp > e.radius + 7) continue;
      along.push({ e, t });
    }
    along.sort((a, c) => a.t - c.t);
    const limit = def.pierce ?? 1;
    for (let i = 0; i < Math.min(limit, along.length); i++) {
      const { e } = along[i];
      g.damageEnemy(e, dps * dt, {
        source: 'turret', armorPierce: 999, building: b, silent: true,
      });
      if (chance(dt * 22)) {
        g.particles.spawn(e.x, e.y, rand(-60, 60), rand(-60, 60), rand(0.1, 0.3),
          rand(1.5, 3), def.beamColor ?? 0xff6fd0, PKind.Spark);
      }
    }
    if (along.length) {
      const first = along[0];
      b.beamHitX = b.x + dirX * first.t;
      b.beamHitY = b.y + dirY * first.t;
    }
  }

  rebuildBuildingHash() {
    this.buildingHash.clear();
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      this.buildingHash.insert(i, b.x, b.y);
    }
  }

  damageBuilding(b: Building, amount: number) {
    const g = this.game;
    if (b.dead) return;
    let dmg = amount;
    if (b.shield > 0) {
      const absorbed = Math.min(b.shield, dmg);
      b.shield -= absorbed;
      dmg -= absorbed;
      g.particles.ring(b.x, b.y, b.radius * 1.4, 0x9fd8ff, 0.18);
      if (dmg <= 0) return;
    }
    b.hp -= dmg;
    b.hitFlash = 1;
    b.attackedAt = g.elapsed;
    if (chance(0.4)) {
      g.particles.spawn(b.x + rand(-b.radius, b.radius), b.y + rand(-b.radius, b.radius),
        rand(-40, 40), rand(-60, 0), rand(0.15, 0.4), rand(1.5, 3), 0xffa657, PKind.Spark);
    }
    if (b.hp <= 0) this.removeBuilding(b, true);
  }

  /** Unlocked structures in one section, in slot order. */
  categoryBuildings(category: BuildCategory): BuildingKind[] {
    return buildingsInCategory(category, this.game.unlockedBuildings);
  }

  /** Sections that currently have anything in them — empty tabs are hidden. */
  get activeCategories(): BuildCategory[] {
    return BUILD_CATEGORIES.filter((c) => this.categoryBuildings(c).length > 0);
  }

  /**
   * Points the bar at a structure, switching section if needed. Used by the
   * renderer's click routing and whenever a tech unlock should be discoverable.
   */
  selectBuilding(kind: BuildingKind | null) {
    const g = this.game;
    if (kind === null) {
      g.buildKind = null;
      g.cursorMode = 'normal';
      return;
    }
    if (!g.unlockedBuildings.has(kind)) return;
    g.buildCategory = BUILDINGS[kind].category;
    g.buildKind = kind;
    g.cursorMode = 'build';
  }

  /** Places a saved structure without charging for it or playing build FX. */
  restoreBuilding(
    def: BuildingDef, tx: number, ty: number, hp: number,
    level = 1, branch: UpgradeBranch | null = null,
  ) {
    const g = this.game;
    const world = g.world;
    // Terrain regenerates identically, so a rejection means the snapshot and the
    // code have diverged; skip that structure rather than corrupt the grid.
    if (this.canPlace(def, tx, ty, true) !== null) return;

    const b = new Building(def, tx, ty, TILE, g.perks.structureHp);
    b.progress = 1;
    if (b.isTurret && level > 1) {
      this.applyLevel(b, clamp(Math.round(level), 1, MAX_BUILDING_LEVEL),
        level >= MAX_BUILDING_LEVEL ? (branch === 'range' ? 'range' : 'rapid') : null);
    }
    b.hp = clamp(hp, 1, b.maxHp);
    this.buildings.push(b);
    this.buildingById.set(b.id, b);
    for (let y = ty; y < ty + def.size; y++) {
      for (let x = tx; x < tx + def.size; x++) {
        this.buildingAt[world.idx(x, y)] = b;
        if (def.blocksMovement) world.field.setCost(x, y, def.pathCost);
      }
    }
    if (def.id === 'extractor') {
      for (let y = ty; y < ty + def.size && b.nodeIndex < 0; y++) {
        for (let x = tx; x < tx + def.size; x++) {
          const n = world.nodeAtTile(x, y);
          if (n) { b.nodeIndex = world.nodes.indexOf(n); n.claimedBy = b.id; break; }
        }
      }
    }
  }
}
