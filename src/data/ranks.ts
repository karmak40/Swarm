import { t } from '../core/i18n';
import type { PerkDelta } from './perks';

/**
 * Commander rank — the second layer of meta-progression next to the Armoury.
 *
 * The Armoury is a shop: relics in, chosen upgrades out. Rank is the opposite:
 * it is earned passively from every run (win or lose), and each rank hands out
 * a fixed small perk, a relic bounty, and — at certain ranks — unlocks a
 * mutator. Nothing here needs choosing, so it rewards simply playing.
 */

export const MAX_RANK = 12;

export interface RankDef {
  rank: number;
  title: string;
  /** Small permanent perk granted on reaching this rank. Rank 1 has none. */
  perk?: PerkDelta;
}

export const RANKS: RankDef[] = [
  { rank: 1, title: 'Recruit' },
  { rank: 2, title: 'Sentry', perk: { startOre: 20 } },
  { rank: 3, title: 'Warden', perk: { miningSpeed: 1.05 } },
  { rank: 4, title: 'Operator', perk: { turretDamage: 1.03 } },
  { rank: 5, title: 'Sergeant', perk: { startEssence: 15 } },
  { rank: 6, title: 'Captain', perk: { structureHp: 1.04 } },
  { rank: 7, title: 'Marshal', perk: { playerMaxHp: 1.05 } },
  { rank: 8, title: 'Commander', perk: { oreYield: 1.03 } },
  { rank: 9, title: 'Strategos', perk: { turretFireRate: 1.03 } },
  { rank: 10, title: 'Overseer', perk: { coreHp: 1.05 } },
  { rank: 11, title: 'Warlord', perk: { buildCost: 0.98 } },
  { rank: 12, title: 'Sovereign', perk: { luck: 0.05 } },
];

export const rankTitle = (r: RankDef) => t(`rank.title.${r.rank}`, r.title);

/** Cumulative XP needed to reach `rank` (rank 1 = 0). */
export function xpForRank(rank: number): number {
  const r = Math.max(1, Math.min(MAX_RANK, Math.floor(rank)));
  return 60 * r * (r - 1);
}

export interface RankStatus {
  rank: number;
  /** XP earned inside the current rank. */
  into: number;
  /** XP the current rank spans; 0 at max rank. */
  span: number;
  /** 0-1 progress to the next rank; 1 at max. */
  progress: number;
}

export function rankFromXp(xp: number): RankStatus {
  let rank = 1;
  while (rank < MAX_RANK && xp >= xpForRank(rank + 1)) rank++;
  if (rank >= MAX_RANK) return { rank, into: xp - xpForRank(rank), span: 0, progress: 1 };
  const base = xpForRank(rank);
  const span = xpForRank(rank + 1) - base;
  return { rank, into: xp - base, span, progress: (xp - base) / span };
}

/** Relics paid for reaching `rank`. */
export function rankRelics(rank: number): number {
  return rank <= 1 ? 0 : 2 + Math.floor(rank / 4);
}

/** Perks of every rank up to and including `rank`. */
export function rankPerks(rank: number): PerkDelta[] {
  return RANKS.filter((r) => r.rank <= rank && r.perk).map((r) => r.perk!);
}
