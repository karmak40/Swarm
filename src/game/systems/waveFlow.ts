import { audio } from '../../core/audio';
import { t as tr } from '../../core/i18n';
import { TAU, clamp, rand } from '../../core/math';
import { PKind } from '../../engine/particles';
import { applyPerk } from '../../data/perks';
import { ENEMIES, enemyName, enemyDesc } from '../../data/enemies';
import { LEVELS } from '../../data/levels';
import { RARITY_WEIGHT, TECH_CARDS, techName, techDesc, type TechCard } from '../../data/tech';
import { SYNERGIES, synergyCounts, synergyTitle, tierBonusText, tiersReached } from '../../data/synergies';
import { TILE } from '../world';
import type { WavePlan } from '../waves';
import { finalizeRun } from '../runResult';
import { CORE_BASE_HP, PLAYER_BASE_HP, type Game } from '../game';

/**
 * Seconds past a wave's scripted window before surviving enemies are enraged.
 * Without this a single straggler camping an out-of-coverage structure can hold
 * a wave open indefinitely, which reads to the player as a soft-lock.
 */
const STRAGGLER_GRACE = 25;
/** Fraction of the per-wave hp/damage ramp that bosses inherit. See spawnFromGate. */
const BOSS_SCALE_SHARE = 0.3;

/**
 * Wave pacing (prep → incoming → combat/boss → cleared), the straggler
 * anti-softlock, sector completion, and the tech draft. Owns no state of its
 * own — the wave counters/plan/draft fields live on `Game` because
 * `startLevel`/`resume` (run bootstrap and save/load) initialise them
 * directly, same reasoning as keeping `ore`/`essence` centralised.
 */
export class WaveSystem {
  constructor(private game: Game) {}

  updateWaves(dt: number) {
    const g = this.game;
    switch (g.phase) {
      case 'prep': {
        g.prepRemaining -= dt;
        if (g.prepRemaining <= 0) this.beginWave();
        break;
      }
      case 'incoming':
      case 'combat':
      case 'boss': {
        g.waveTimer += dt;
        const plan = g.plan!;
        while (g.orderCursor < plan.orders.length && plan.orders[g.orderCursor].at <= g.waveTimer) {
          const o = plan.orders[g.orderCursor++];
          this.spawnFromGate(o.enemyId, o.gate, plan, o.elite);
        }
        if (g.phase === 'incoming' && g.waveTimer > 1.6) g.setPhase(plan.isBoss ? 'boss' : 'combat');

        const allSpawned = g.orderCursor >= plan.orders.length;
        const allDead = g.enemies.length === 0;
        if (allSpawned && allDead) {
          this.completeWave();
        } else if (allSpawned && g.waveTimer > plan.duration + this.stragglerGrace(plan)) {
          // Re-applied every frame, not once: a boss keeps spawning escorts, and
          // anything that arrives after the deadline has to be woken up too.
          this.enrageStragglers();
        }
        break;
      }
      case 'cleared': {
        g.prepRemaining -= dt;
        if (g.prepRemaining <= 0) {
          if (g.pendingDraft) break; // draft UI owns the flow
          this.beginWave();
        }
        break;
      }
      default:
        break;
    }

    for (const s of g.world.spawns) s.heat = Math.max(0, s.heat - dt * 1.5);
  }

  private beginWave() {
    const g = this.game;
    g.plan = g.nextPlan ?? g.director.plan(g.waveIndex);
    g.nextPlan = null;
    g.orderCursor = 0;
    g.waveTimer = 0;
    g.spawnedThisWave = 0;
    g.killedThisWave = 0;
    g.structuresLostThisWave = 0;
    g.coreDamageThisWave = 0;
    g.stragglersEnraged = false;
    g.setPhase('incoming');

    if (g.plan.isBoss) {
      const bossDef = ENEMIES[g.level.boss];
      g.setBanner(
        enemyName(bossDef),
        tr('game.banner.finalWave', 'FINAL WAVE — {desc}', { desc: enemyDesc(bossDef) ?? '' }),
        5, '#ff4f5e',
      );
      audio.play('bossRoar');
      g.shake(20);
      g.addFlash(1, 0.2, 0.25, 0.4);
    } else {
      g.setBanner(
        tr('game.banner.wave', 'WAVE {n} / {total}', { n: g.waveIndex + 1, total: g.level.waves }),
        this.describeWave(g.plan), 3, '#ffb347',
      );
      audio.play('waveStart');
      g.shake(5);
    }
  }

  describeWave(plan: WavePlan): string {
    return plan.composition
      .slice(0, 4)
      .map((c) => {
        const def = ENEMIES[c.id];
        return tr('game.wave.composition', '{count}× {name}', { count: c.count, name: def ? enemyName(def) : c.id });
      })
      .join('  ·  ');
  }

  /**
   * Wakes up the remnant of an overstaying wave. Enraged units abandon whatever
   * structure they were gnawing on and drive for the core, so the wave always
   * terminates — either they die inside your kill zone or they reach the core and
   * force the issue. Nothing is ever silently despawned.
   *
   * Bosses get the behavioural half only. A ranged boss such as the Matriarch
   * otherwise kites from beyond every turret's reach and the wave cannot end;
   * making it close the distance resolves that *and* favours the player, whereas
   * buffing it mid-fight would punish someone legitimately grinding it down.
   */
  private stragglerGrace(plan: WavePlan) {
    // A legitimate boss fight routinely outlasts the scripted window, so its
    // escort gets far more rope before the game intervenes.
    return plan.isBoss ? STRAGGLER_GRACE * 4 : STRAGGLER_GRACE;
  }

  private enrageStragglers() {
    const g = this.game;
    let n = 0;
    for (const e of g.enemies) {
      if (e.berserk) continue;
      e.berserk = true;
      e.targetBuilding = null;
      e.retargetIn = 0;
      if (!e.boss) {
        e.speed *= 1.35;
        e.damage *= 1.25;
      }
      n++;
      g.particles.ring(e.x, e.y, e.radius * 2.6, 0xff4f5e, 0.45);
    }
    if (n > 0 && !g.stragglersEnraged) {
      g.stragglersEnraged = true;
      g.setBanner(
        tr('game.banner.remnantTurns', 'THE REMNANT TURNS'),
        n > 1
          ? tr('game.banner.stragglersMany', '{n} stragglers charging the core', { n })
          : tr('game.banner.stragglersOne', '{n} straggler charging the core', { n }),
        2.8, '#ff4f5e',
      );
      audio.play('bossRoar');
    }
  }

  private completeWave() {
    const g = this.game;
    g.runStats.wavesCleared++;
    g.progress.bump('wave');
    g.progress.recordRunStat('wavesSurvived', 1);
    g.progress.recordRunStat('bestWave', g.waveIndex + 1, 'max');
    if (g.structuresLostThisWave === 0) g.progress.bump('flawlessWave');

    const wasBoss = g.plan?.isBoss ?? false;
    if (wasBoss && (g.mode === 'campaign' || g.mode === 'skirmish')) {
      this.finishLevel();
      return;
    }

    // Wave clear bonus scales with how intact your base is.
    const bonus = Math.round(28 + g.waveIndex * 14 + (g.structuresLostThisWave === 0 ? 40 : 0));
    g.ore += bonus;
    g.essence += Math.round(6 + g.waveIndex * 2);
    if (wasBoss) {
      // Endless boss cleared: a real payout, and the run keeps going.
      g.essence += 60;
      g.setBanner(
        tr('game.banner.bossDown', 'BOSS DOWN'),
        tr('game.banner.bossDownDetail', '+{bonus} ore  ·  the hive sends more', { bonus }),
        3.4, '#ffcc55',
      );
      audio.play('victory');
    } else {
      g.setBanner(
        tr('game.banner.waveCleared', 'WAVE CLEARED'),
        tr('game.banner.waveClearedDetail', '+{bonus} ore  ·  next wave in {seconds}s',
          { bonus, seconds: g.level.buildTime }),
        3, '#5cf2a0',
      );
      audio.play('levelUp');
    }

    g.playerSystem.restockChassis();
    g.waveIndex++;
    g.nextPlan = g.director.plan(g.waveIndex);
    g.prepRemaining = g.level.buildTime;
    g.setPhase('cleared');
    // Auto-save at the top of every build window: the most a crash can now cost
    // is the wave that was in progress.
    g.autoSaveRun();

    // Draft a tech card every third wave.
    if (g.waveIndex % 3 === 0) this.offerDraft();
  }

  private finishLevel() {
    const g = this.game;
    if (g.mode === 'campaign') {
      g.progress.markLevelCleared(g.levelIndex);
      g.lastRelicAward = g.progress.awardSectorClear(g.levelIndex);
      if (g.levelIndex >= LEVELS.length - 1) g.progress.bump('campaign');
    } else {
      // Skirmish: no sector index to key a reward off, so it scales with
      // whatever difficulty the player configured instead.
      g.lastRelicAward = g.progress.awardSkirmishRelics(g.level.difficulty);
    }
    g.progress.bump('level');
    g.progress.recordRunStat('victories', 1);
    if (g.runStats.structuresLost === 0) {
      g.progress.bump('flawlessLevel');
      g.progress.recordRunStat('noLossVictories', 1);
    }
    g.result = finalizeRun(g, true);
    // The run is over; nothing left to resume.
    g.discardSavedRun();
    audio.play('victory');
    g.presentation.hitstop = 0.5;
    g.setPhase('won');
    g.frozen = true;
  }

  private offerDraft() {
    const g = this.game;
    const cards = this.rollDraft(Math.max(2, Math.round(g.perks.techChoices)));
    if (!cards.length) return;
    g.pendingDraft = cards;
    g.frozen = true;
    g.onDraft?.(cards);
  }

  rollDraft(count: number): TechCard[] {
    const g = this.game;
    const taken = new Map<string, number>();
    for (const id of g.techTaken) taken.set(id, (taken.get(id) ?? 0) + 1);

    const eligible = TECH_CARDS.filter((c) => {
      if (c.unlock && g.unlockedBuildings.has(c.unlock)) return false;
      if (c.requires && !g.unlockedBuildings.has(c.requires)) return false;
      const stacks = taken.get(c.id) ?? 0;
      return stacks < (c.maxStacks ?? 99);
    });
    if (!eligible.length) return [];

    const chosen: TechCard[] = [];
    const pool = [...eligible];
    for (let i = 0; i < count && pool.length; i++) {
      const total = pool.reduce((s, c) => s + RARITY_WEIGHT[c.rarity], 0);
      let r = g.rng.next() * total;
      let idx = 0;
      for (let k = 0; k < pool.length; k++) {
        r -= RARITY_WEIGHT[pool[k].rarity];
        if (r <= 0) { idx = k; break; }
      }
      chosen.push(pool.splice(idx, 1)[0]);
    }
    return chosen;
  }

  takeTech(card: TechCard) {
    const g = this.game;
    const tiersBefore = tiersReached(card.tag, synergyCounts(g.techTaken)[card.tag]);
    g.techTaken.push(card.id);
    if (card.perk) applyPerk(g.perks, card.perk);
    // Completing a synergy tier switches its set bonus on (data/synergies.ts).
    // Applied before the maxima re-derive below, so hull/core bonuses land now.
    const tiersAfter = tiersReached(card.tag, synergyCounts(g.techTaken)[card.tag]);
    for (let i = tiersBefore; i < tiersAfter; i++) applyPerk(g.perks, SYNERGIES[card.tag].tiers[i].perk);
    const newTier = tiersAfter > tiersBefore ? tiersAfter : 0;
    if (card.unlock) g.unlockedBuildings.add(card.unlock);

    switch (card.effect) {
      case 'freeOre': g.ore += card.value ?? 200; break;
      case 'freeEssence': g.essence += card.value ?? 100; break;
      case 'refillCore':
        g.core.maxHp = Math.round(CORE_BASE_HP * g.perks.coreHp);
        g.core.hp = g.core.maxHp;
        break;
      case 'repairAll':
        for (const b of g.buildings) b.hp = b.maxHp;
        break;
      default: break;
    }

    // Perks that change maxima need the live values re-derived. Armor tier's
    // flat bonus rides along on top — otherwise a tech pick here would quietly
    // wipe out essence already spent on armor.
    g.player.maxHp = Math.round(PLAYER_BASE_HP * g.perks.playerMaxHp) + g.armorHpBonus();
    g.player.hp = Math.min(g.player.maxHp, g.player.hp + 20);
    const newCoreMax = Math.round(CORE_BASE_HP * g.perks.coreHp);
    if (newCoreMax > g.core.maxHp) {
      g.core.hp += newCoreMax - g.core.maxHp;
      g.core.maxHp = newCoreMax;
    }
    for (const b of g.buildings) {
      // Keep an upgraded turret's bigger hull (data/upgrades.ts) through the re-derive.
      const nm = Math.round(b.def.hp * g.perks.structureHp * b.upgrade.hp);
      if (nm !== b.maxHp) {
        const ratio = b.hp / b.maxHp;
        b.maxHp = nm;
        b.hp = Math.max(1, Math.round(nm * ratio));
      }
    }

    g.pendingDraft = null;
    g.frozen = false;
    audio.play('levelUp');
    if (newTier) {
      // A completed set outranks the card itself in the banner.
      g.setBanner(synergyTitle(card.tag, newTier).toUpperCase(), tierBonusText(card.tag, newTier - 1), 3.5,
        `#${SYNERGIES[card.tag].color.toString(16).padStart(6, '0')}`);
    } else {
      g.setBanner(techName(card).toUpperCase(), techDesc(card), 3, '#b47cff');
    }
  }

  private spawnFromGate(enemyId: string, gate: number, plan: WavePlan, elite: boolean) {
    const g = this.game;
    const def = ENEMIES[enemyId];
    if (!def) return;
    const gate_ = g.world.spawns[gate % g.world.spawns.length];
    gate_.heat = 1;

    // Nudge off-centre so a squad doesn't stack into one point.
    const a = rand(0, TAU);
    const r = rand(0, TILE * 1.8);
    // The jitter can push a unit into the rock ringing a gate; snap it back out.
    const spot = g.world.findOpenNear(
      clamp(gate_.x + Math.cos(a) * r, TILE, g.world.pxW - TILE),
      clamp(gate_.y + Math.sin(a) * r, TILE, g.world.pxH - TILE),
    );
    const x = spot.x;
    const y = spot.y;

    // Bosses already carry hand-authored stats per sector, so stacking the full
    // per-wave ramp on top of them (×8.5 on the last sector) made the final fight
    // a damage-sponge slog. They take a heavily damped share of it instead.
    const hpMult = def.boss ? 1 + (plan.hpMult - 1) * BOSS_SCALE_SHARE : plan.hpMult;
    const dmgMult = def.boss ? 1 + (plan.dmgMult - 1) * BOSS_SCALE_SHARE : plan.dmgMult;

    const e = g.spawnEnemy(def, x, y, hpMult, dmgMult, elite);
    e.wave = plan.index;
    g.spawnedThisWave++;
    if (def.boss) {
      g.bossRef = e;
      g.particles.explosion(x, y, 90, def.accent, g.level.palette.rock);
      g.shake(14);
    } else {
      g.particles.ring(x, y, 22, def.accent, 0.4);
      for (let i = 0; i < 6; i++) {
        const aa = rand(0, TAU);
        g.particles.spawn(x, y, Math.cos(aa) * rand(40, 140), Math.sin(aa) * rand(40, 140),
          rand(0.2, 0.5), rand(1.5, 3.5), def.accent, PKind.Spark);
      }
    }
  }
}
