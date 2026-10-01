import { clamp } from '../core/math';
import { t as tr } from '../core/i18n';
import { BUILDINGS, type BuildingKind } from '../data/buildings';
import { LEVELS, levelName } from '../data/levels';
import { applyPerk } from '../data/perks';
import { ARMOR_TIERS, type WeaponKind } from '../data/loadout';
import { TECH_CARDS } from '../data/tech';
import { applySynergies } from '../data/synergies';
import { applyMutators } from '../data/mutators';
import { TILE } from './world';
import { MAX_SPARE_CHASSIS } from './entities';
import { WaveDirector } from './waves';
import { RUN_SNAPSHOT_VERSION, type RunSnapshot } from '../core/save';
import { type Game, PLAYER_BASE_HP, CORE_BASE_HP } from './game';

/**
 * Save/resume for `Game`, split out of the class because the shape of a run
 * snapshot — and how to rebuild one — is a self-contained concern that
 * doesn't need any of the class's private state, unlike almost everything
 * else in that file. See `Game.snapshot`/`Game.resume`, which just delegate here.
 */

/**
 * Snapshots the run. Only valid during a build phase — the caller guarantees
 * that, which is precisely why no enemy, projectile or particle state is here.
 */
export function buildSnapshot(game: Game): RunSnapshot {
  return {
    v: RUN_SNAPSHOT_VERSION,
    mode: game.mode,
    levelIndex: game.levelIndex,
    seed: game.runSeed,
    waveIndex: game.waveIndex,
    prepRemaining: game.prepRemaining,
    ore: Math.round(game.ore),
    essence: Math.round(game.essence),
    coreHp: game.core.hp,
    coreShield: game.core.shield,
    playerHp: game.player.hp,
    playerX: game.player.x,
    playerY: game.player.y,
    tech: [...game.techTaken],
    unlocked: [...game.unlockedBuildings],
    weaponsOwned: [...game.player.weaponsOwned],
    weapon: game.player.weapon,
    armorTier: game.player.armorTier,
    buildings: game.buildings.map((b) => ({
      k: b.kind, tx: b.tx, ty: b.ty, hp: Math.round(b.hp),
      ...(b.level > 1 ? { lv: b.level } : {}),
      ...(b.branch ? { br: b.branch } : {}),
    })),
    strike: Math.round(game.strike.charge * 10) / 10,
    spare: game.player.spareChassis,
    ...(game.mutators.length ? { mut: [...game.mutators] } : {}),
    nodes: game.world.nodes.map((n) => Math.round(n.amount)),
    stats: {
      kills: game.runStats.kills,
      bossKills: game.runStats.bossKills,
      oreMined: Math.round(game.runStats.oreMined),
      essenceCollected: Math.round(game.runStats.essenceCollected),
      built: game.runStats.built,
      damage: Math.round(game.runStats.damage),
      structuresLost: game.runStats.structuresLost,
      wavesCleared: game.runStats.wavesCleared,
      coreDamage: Math.round(game.runStats.coreDamage),
      timeSeconds: Math.round(game.runStats.timeSeconds),
      bestPower: game.runStats.bestPower,
      dronesLost: game.runStats.dronesLost,
      droneOre: Math.round(game.runStats.droneOre),
    },
    savedAt: Date.now(),
  };
}

/**
 * Rebuilds a run from a snapshot. Returns false if the snapshot is unusable,
 * leaving the game untouched.
 */
export function applySnapshot(game: Game, snap: RunSnapshot): boolean {
  if (!snap || snap.v !== RUN_SNAPSHOT_VERSION) return false;
  if (snap.levelIndex < 0 || snap.levelIndex >= LEVELS.length) return false;

  // Regenerate the exact same world from the seed, then lay the player's
  // changes back over the top.
  game.startLevel(snap.levelIndex, undefined, snap.seed, {
    mode: snap.mode,
    resuming: true,
    mutators: snap.mut,
  });

  game.techTaken = [...snap.tech];
  game.unlockedBuildings = new Set(snap.unlocked as BuildingKind[]);
  // Perks are derived, never stored: the profile may have gained achievements
  // or shop ranks since the save, and the run should benefit from them.
  game.perks = game.progress.computePerks();
  applyMutators(game.perks, game.mutators);
  for (const id of game.techTaken) {
    const card = TECH_CARDS.find((c) => c.id === id);
    if (card?.perk) applyPerk(game.perks, card.perk);
  }
  applySynergies(game.perks, game.techTaken);

  const armorHpBonus = ARMOR_TIERS[game.player.armorTier]?.hpBonus ?? 0;
  game.core.maxHp = Math.round(CORE_BASE_HP * game.perks.coreHp);
  game.core.hp = clamp(snap.coreHp, 1, game.core.maxHp);
  game.core.shield = Math.max(0, snap.coreShield);
  game.player.armorTier = clamp(snap.armorTier ?? 0, 0, ARMOR_TIERS.length - 1);
  game.player.weaponsOwned = new Set((snap.weaponsOwned as WeaponKind[] | undefined) ?? ['rifle']);
  game.player.weapon = (snap.weapon as WeaponKind | undefined) ?? 'rifle';
  game.player.maxHp = Math.round(PLAYER_BASE_HP * game.perks.playerMaxHp) + armorHpBonus;
  game.player.hp = clamp(snap.playerHp, 1, game.player.maxHp);
  game.player.x = clamp(snap.playerX, TILE, game.world.pxW - TILE);
  game.player.y = clamp(snap.playerY, TILE, game.world.pxH - TILE);
  game.player.spareChassis = clamp(snap.spare ?? MAX_SPARE_CHASSIS, 0, MAX_SPARE_CHASSIS);

  game.ore = Math.max(0, snap.ore);
  game.strike.charge = Math.max(0, snap.strike ?? 0);
  game.essence = Math.max(0, snap.essence);

  // Restore drained seams before structures, so an extractor can re-bind.
  for (let i = 0; i < game.world.nodes.length && i < snap.nodes.length; i++) {
    const n = game.world.nodes[i];
    const amount = clamp(snap.nodes[i], 0, n.max);
    if (amount >= n.max) continue;
    game.world.drain(n, n.amount - amount);
  }

  for (const b of snap.buildings) {
    const def = BUILDINGS[b.k as BuildingKind];
    if (!def) continue;
    const branch = b.br === 'rapid' || b.br === 'range' ? b.br : null;
    game.restoreBuilding(def, b.tx, b.ty, b.hp, b.lv ?? 1, branch);
  }

  game.runStats = { ...game.runStats, ...snap.stats };

  game.waveIndex = snap.waveIndex;
  // Rebuild the director from scratch before walking it forward. startLevel has
  // already consumed a plan(0) off the one it created, and the director's RNG
  // advances per call — reusing it would put the resumed run one roll out of
  // step with the wave the player was actually promised.
  game.director = new WaveDirector(
    game.level, game.world.spawns.length, game.mapSeed ^ 0xabcdef, game.endless,
  );
  game.director.fastForwardTo(game.waveIndex);
  game.nextPlan = game.director.plan(game.waveIndex);
  game.plan = null;
  game.orderCursor = 0;
  game.prepRemaining = Math.max(3, snap.prepRemaining);
  game.phase = game.waveIndex === 0 ? 'prep' : 'cleared';
  game.world.field.dirty = true;
  game.world.field.rebuild();

  // Drones are not serialised — they are transient and always mid-flight. Refill
  // the bays outright rather than making the player wait out respawn timers for
  // something that was only lost to saving.
  game.fillDroneBays();

  game.setBanner(
    tr('game.banner.runResumed', 'RUN RESUMED'),
    game.endless
      ? tr('game.banner.runResumedDetailEndless', '{level} - wave {wave} - endless',
        { level: levelName(game.level), wave: game.waveIndex + 1 })
      : tr('game.banner.runResumedDetail', '{level} - wave {wave}',
        { level: levelName(game.level), wave: game.waveIndex + 1 }),
    3.2, '#5cf2a0');
  return true;
}
