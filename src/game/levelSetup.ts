import { audio } from '../core/audio';
import { clamp, Rng } from '../core/math';
// Aliased: `t` elsewhere in the game is almost always a Tile value.
import { t as tr } from '../core/i18n';
import { SpatialHash } from '../engine/spatial';
import type { BuildingKind } from '../data/buildings';
import { LEVELS, levelName, levelSubtitle, ngDifficultyMult, type LevelDef } from '../data/levels';
import { applyPerk, type Perks } from '../data/perks';
import { applyMutators, mutatorDifficulty, validMutators } from '../data/mutators';
import type { DailyChallenge } from '../data/daily';
import { ARMOR_TIERS, type WeaponKind } from '../data/loadout';
import { TECH_CARDS } from '../data/tech';
import { applySynergies } from '../data/synergies';
import { Core, Player } from './entities';
import type { Game, GameMode } from './game';
import { TILE, World } from './world';
import { WaveDirector } from './waves';

/**
 * Level setup: turns a sector (or skirmish map) plus optional carried-over
 * campaign state into a fresh, playable `Game`. Split out of game.ts because it
 * is a long straight-line reset that touches nearly every field once.
 */

export const PLAYER_BASE_HP = 160;
export const CORE_BASE_HP = 2600;

/** What a campaign hands from one sector to the next. */
export interface CarryOver {
  perks: Perks;
  tech: string[];
  unlocked: BuildingKind[];
  weaponsOwned: WeaponKind[];
  weapon: WeaponKind;
  armorTier: number;
}

/** Per-run options beyond the level itself. */
export interface LevelOptions {
  mode?: GameMode;
  resuming?: boolean;
  /** Handicaps for an endless run (ignored in other modes). */
  mutators?: readonly string[];
  /** Set for a daily challenge: fixes the mutators and marks the run for the daily board. */
  daily?: DailyChallenge | null;
}

export function setupLevel(
  g: Game,
  levelIndex: number | LevelDef,
  carryOver: CarryOver | undefined,
  seed: number | undefined,
  opts: LevelOptions,
) {
  g.mode = opts.mode ?? 'campaign';
  // Mutators only exist in endless runs; a daily brings its own fixed pair.
  g.daily = g.mode === 'endless' ? opts.daily ?? null : null;
  g.mutators = g.mode === 'endless' ? validMutators(g.daily ? g.daily.mutators : opts.mutators) : [];
  g.result = null;
  if (typeof levelIndex === 'number') {
    g.levelIndex = clamp(levelIndex, 0, LEVELS.length - 1);
    const base = LEVELS[g.levelIndex];
    // NG+ only ever applies to a real campaign sector picked by index —
    // a skirmish map already bakes the chosen difficulty into its own
    // LevelDef, and endless has its own separate scaling.
    g.ngTier = g.mode === 'campaign'
      ? clamp(Math.round(g.progress.data.settings.ngTier ?? 1), 1, 10)
      : 1;
    const difficultyMult = (g.ngTier > 1 ? ngDifficultyMult(g.ngTier) : 1) * mutatorDifficulty(g.mutators);
    g.level = difficultyMult !== 1 ? { ...base, difficulty: base.difficulty * difficultyMult } : base;
  } else {
    g.levelIndex = -1;
    g.level = levelIndex;
    g.ngTier = 1;
  }
  // The level's own seed is a per-sector salt, so the same run seed still yields
  // a different map in each sector.
  g.runSeed = (seed ?? ((Math.random() * 0x100000000) >>> 0)) >>> 0;
  const mapSeed = (g.runSeed ^ g.level.seed) >>> 0;
  g.mapSeed = mapSeed;
  g.rng = new Rng(mapSeed ^ 0xc0ffee);
  g.world = new World(g.level, mapSeed);
  g.enemySystem.enemyHash = new SpatialHash(g.world.pxW, g.world.pxH, 72);
  g.buildingSystem.buildingHash = new SpatialHash(g.world.pxW, g.world.pxH, 128);

  // Perks: achievements always apply; tech carries across levels in a campaign.
  g.perks = g.progress.computePerks();
  applyMutators(g.perks, g.mutators);
  if (carryOver) {
    g.techTaken = [...carryOver.tech];
    for (const id of g.techTaken) {
      const card = TECH_CARDS.find((c) => c.id === id);
      if (card?.perk) applyPerk(g.perks, card.perk);
    }
    applySynergies(g.perks, g.techTaken);
    g.unlockedBuildings = new Set([...g.level.unlocked, ...carryOver.unlocked]);
  } else {
    g.techTaken = [];
    g.unlockedBuildings = new Set(g.level.unlocked);
  }

  g.enemies.length = 0;
  g.buildings.length = 0;
  g.buildingById.clear();
  g.buildingSystem.buildingAt = new Array(g.world.w * g.world.h).fill(null);
  g.projectiles.length = 0;
  g.drones.length = 0;
  g.pickups.length = 0;
  g.effects.length = 0;
  g.damageNumbers.length = 0;
  g.particles.clear();

  g.coreSystem.core = new Core(g.world.coreX, g.world.coreY, Math.round(CORE_BASE_HP * g.perks.coreHp));
  const armorTier = carryOver?.armorTier ?? 0;
  const armorHpBonus = ARMOR_TIERS[armorTier]?.hpBonus ?? 0;
  g.player = new Player(
    g.world.coreX + TILE * 2.5,
    g.world.coreY + TILE * 2.5,
    Math.round(PLAYER_BASE_HP * g.perks.playerMaxHp) + armorHpBonus,
  );
  g.player.armorTier = armorTier;
  if (carryOver) {
    g.player.weaponsOwned = new Set(carryOver.weaponsOwned);
    g.player.weapon = carryOver.weapon;
  }

  g.ore = Math.round(g.level.startOre + g.perks.startOre);
  g.essence = Math.round(g.level.startEssence + g.perks.startEssence);

  g.director = new WaveDirector(
    g.level, g.world.spawns.length, mapSeed ^ 0xabcdef, g.mode === 'endless',
  );
  g.waveIndex = 0;
  g.plan = null;
  g.nextPlan = g.director.plan(0);
  g.orderCursor = 0;
  g.spawnedThisWave = 0;
  g.killedThisWave = 0;
  g.bossRef = null;
  g.phase = 'prep';
  g.prepRemaining = g.level.prepTime;
  g.waveTimer = 0;
  g.structuresLostThisWave = 0;
  g.coreDamageThisWave = 0;
  g.pendingDraft = null;

  g.runStats = {
    kills: 0, bossKills: 0, oreMined: 0, essenceCollected: 0,
    built: 0, damage: 0, structuresLost: 0, wavesCleared: 0,
    coreDamage: 0, timeSeconds: 0, bestPower: 0, dronesLost: 0, droneOre: 0,
  };

  g.presentation.reset();
  g.strike.reset();
  g.cursorMode = 'normal';
  g.buildKind = null;
  // A section that is empty in this sector must not stay selected.
  g.buildCategory = g.activeCategories[0] ?? 'resources';
  g.frozen = false;

  // Seed the field with the core as the single goal.
  g.world.field.setGoals([g.world.field.index(g.world.coreTx, g.world.coreTy)]);
  g.world.field.rebuild();

  g.setBanner(
    g.mode === 'endless'
      ? tr('game.banner.endlessTitle', 'ENDLESS · {name}', { name: levelName(g.level).toUpperCase() })
      : levelName(g.level).toUpperCase(),
    g.mode === 'endless'
      ? tr('game.banner.endlessSubtitle', 'Survive as long as you can')
      : levelSubtitle(g.level),
    4.2, g.mode === 'endless' ? '#ffcc55' : '#46d8ff',
  );
  audio.startMusic(g.levelIndex * 2);
  audio.setIntensity(0);
  // Resuming is not a new attempt; only count fresh deployments.
  if (!opts.resuming) g.progress.recordRunStat('runs', 1);
}
