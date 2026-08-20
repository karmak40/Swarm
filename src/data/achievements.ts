import type { PerkDelta } from './perks';
import { t } from '../core/i18n';

/**
 * Achievements are the meta-progression spine: every one that unlocks grants a
 * permanent perk applied at the start of every subsequent run. Progress is a
 * single counter per achievement, incremented by `Stats` events, so unlocking
 * is just `progress >= goal`.
 */

export type StatEvent =
  | 'kill' | 'killBoss' | 'killElite' | 'wave' | 'level' | 'ore' | 'essence'
  | 'build' | 'sell' | 'repair' | 'damage' | 'coreDamage' | 'run' | 'victory'
  | 'mineNode' | 'flawlessWave' | 'flawlessLevel' | 'powerCap' | 'chainKill'
  | 'bossNoCoreDamage' | 'playSeconds' | 'turretKills' | 'meleeKills' | 'campaign';

export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  icon: string;
  /** Which counter drives progress. */
  track: StatEvent;
  goal: number;
  perk: PerkDelta;
  /** Hidden until unlocked. */
  secret?: boolean;
  tier: 'bronze' | 'silver' | 'gold' | 'platinum';
}

export const ACHIEVEMENTS: AchievementDef[] = [
  // --- combat volume ---
  { id: 'first_blood', name: 'First Blood', desc: 'Kill your first hive creature.', icon: '🩸',
    track: 'kill', goal: 1, perk: { playerDamage: 1.05 }, tier: 'bronze' },
  { id: 'exterminator', name: 'Exterminator', desc: 'Kill 500 enemies across all runs.', icon: '☠️',
    track: 'kill', goal: 500, perk: { turretDamage: 1.06 }, tier: 'bronze' },
  { id: 'genocide', name: 'Pest Control', desc: 'Kill 5,000 enemies.', icon: '💀',
    track: 'kill', goal: 5000, perk: { turretDamage: 1.1, playerDamage: 1.08 }, tier: 'silver' },
  { id: 'apocalypse', name: 'Apocalypse Engine', desc: 'Kill 25,000 enemies.', icon: '🌋',
    track: 'kill', goal: 25000, perk: { turretDamage: 1.15, turretFireRate: 1.08 }, tier: 'gold' },
  { id: 'artillery', name: 'Fire Support', desc: 'Land 250,000 total damage.', icon: '💥',
    track: 'damage', goal: 250000, perk: { turretFireRate: 1.07 }, tier: 'silver' },
  { id: 'hands_on', name: 'Hands On', desc: 'Personally kill 750 enemies.', icon: '🔫',
    track: 'meleeKills', goal: 750, perk: { playerFireRate: 1.1, playerDamage: 1.05 }, tier: 'silver' },
  { id: 'automation', name: 'Let It Work', desc: 'Let turrets score 3,000 kills.', icon: '🤖',
    track: 'turretKills', goal: 3000, perk: { turretRange: 1.08 }, tier: 'silver' },

  // --- bosses ---
  { id: 'giant_slayer', name: 'Giant Slayer', desc: 'Kill your first boss.', icon: '🗡️',
    track: 'killBoss', goal: 1, perk: { playerMaxHp: 1.1 }, tier: 'bronze' },
  { id: 'trophy_hunter', name: 'Trophy Hunter', desc: 'Kill 10 bosses.', icon: '🏆',
    track: 'killBoss', goal: 10, perk: { turretDamage: 1.08, coreHp: 1.1 }, tier: 'silver' },
  { id: 'apex', name: 'Apex Predator', desc: 'Kill 30 bosses.', icon: '👑',
    track: 'killBoss', goal: 30, perk: { turretDamage: 1.12, playerDamage: 1.12 }, tier: 'gold' },
  { id: 'untouched', name: 'Not One Scratch', desc: 'Beat a boss without the core taking damage.', icon: '🛡️',
    track: 'bossNoCoreDamage', goal: 1, perk: { coreHp: 1.15, coreRegen: 1 }, tier: 'gold' },

  // --- economy ---
  { id: 'prospector', name: 'Prospector', desc: 'Mine 5,000 ore.', icon: '⛏️',
    track: 'ore', goal: 5000, perk: { miningSpeed: 1.12 }, tier: 'bronze' },
  { id: 'tycoon', name: 'Tycoon', desc: 'Mine 50,000 ore.', icon: '💎',
    track: 'ore', goal: 50000, perk: { oreYield: 1.12, startOre: 100 }, tier: 'gold' },
  { id: 'harvester', name: 'Harvester', desc: 'Drain 60 ore seams dry.', icon: '🕳️',
    track: 'mineNode', goal: 60, perk: { extractorRate: 1.2 }, tier: 'silver' },
  { id: 'essence_1', name: 'Bio-Alchemist', desc: 'Collect 2,000 essence from kills.', icon: '🧪',
    track: 'essence', goal: 2000, perk: { essenceYield: 1.15 }, tier: 'silver' },
  { id: 'essence_2', name: 'Rendering Plant', desc: 'Collect 15,000 essence.', icon: '⚗️',
    track: 'essence', goal: 15000, perk: { essenceYield: 1.2, startEssence: 80 }, tier: 'gold' },
  { id: 'thrifty', name: 'Thrifty', desc: 'Sell 100 structures for salvage.', icon: '♻️',
    track: 'sell', goal: 100, perk: { sellRefund: 1.2, buildCost: 0.96 }, tier: 'bronze' },

  // --- construction ---
  { id: 'foreman', name: 'Foreman', desc: 'Build 200 structures.', icon: '🔧',
    track: 'build', goal: 200, perk: { buildSpeed: 1.25 }, tier: 'bronze' },
  { id: 'architect', name: 'Architect', desc: 'Build 1,000 structures.', icon: '🏗️',
    track: 'build', goal: 1000, perk: { buildCost: 0.92, structureHp: 1.1 }, tier: 'gold' },
  { id: 'engineer', name: 'Field Engineer', desc: 'Repair 20,000 structure HP.', icon: '🔩',
    track: 'repair', goal: 20000, perk: { repairRate: 1.25, structureHp: 1.06 }, tier: 'silver' },
  { id: 'grid_master', name: 'Grid Master', desc: 'Run 500 power without a brownout.', icon: '⚡',
    track: 'powerCap', goal: 500, perk: { powerOutput: 1.15 }, tier: 'silver' },

  // --- survival / campaign ---
  { id: 'held_line', name: 'Held The Line', desc: 'Survive 50 waves in total.', icon: '🚩',
    track: 'wave', goal: 50, perk: { structureHp: 1.08 }, tier: 'bronze' },
  { id: 'veteran', name: 'Veteran', desc: 'Survive 300 waves.', icon: '🎖️',
    track: 'wave', goal: 300, perk: { structureHp: 1.12, coreHp: 1.1 }, tier: 'gold' },
  { id: 'clean_wave', name: 'Immaculate', desc: 'Clear 25 waves without losing a structure.', icon: '✨',
    track: 'flawlessWave', goal: 25, perk: { turretFireRate: 1.08, repairRate: 1.15 }, tier: 'silver' },
  { id: 'first_clear', name: 'Beachhead', desc: 'Clear your first sector.', icon: '🏁',
    track: 'level', goal: 1, perk: { startOre: 60, techChoices: 0 }, tier: 'bronze' },
  // Cumulative across all runs, so re-clearing a sector counts. Worded to avoid
  // implying anything about how many sectors exist.
  { id: 'campaigner', name: 'Campaigner', desc: 'Clear sectors six times over.', icon: '🗺️',
    track: 'level', goal: 6, perk: { startOre: 120, startEssence: 40 }, tier: 'silver' },
  { id: 'liberator', name: 'Liberator', desc: 'Finish the campaign.', icon: '🌟',
    track: 'campaign', goal: 1, perk: { techChoices: 1, revives: 1 }, tier: 'platinum' },
  { id: 'flawless_run', name: 'Flawless', desc: 'Clear a sector without losing a single structure.', icon: '💠',
    track: 'flawlessLevel', goal: 1, perk: { structureHp: 1.15, coreRegen: 2 }, tier: 'platinum' },
  { id: 'marathon', name: 'Marathon', desc: 'Play for 3 hours.', icon: '⏱️',
    track: 'playSeconds', goal: 10800, perk: { playerRegen: 1, pickupRadius: 1.4 }, tier: 'silver' },
  { id: 'overkill', name: 'Overkill', desc: 'Kill 12 enemies with one explosion.', icon: '🎆',
    track: 'chainKill', goal: 1, perk: { splashEcho: 0.15 }, tier: 'gold', secret: true },
];

export const ACH_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

/** Localised display name. English text above is the source of truth and fallback. */
export function achievementName(a: AchievementDef): string {
  return t(`achievement.${a.id}.name`, a.name);
}

/** Localised objective description. */
export function achievementDesc(a: AchievementDef): string {
  return t(`achievement.${a.id}.desc`, a.desc);
}

export const TIER_COLOR: Record<AchievementDef['tier'], string> = {
  bronze: '#c08552',
  silver: '#c8d4e2',
  gold: '#ffcc55',
  platinum: '#7dfff0',
};
