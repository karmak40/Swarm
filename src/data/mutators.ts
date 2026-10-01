import { t } from '../core/i18n';
import { applyPerk, type Perks, type PerkDelta } from './perks';

/**
 * Mutators — opt-in handicaps for endless runs, and the fixed rules of a
 * daily challenge.
 *
 * Each one makes the run harder and is worth "heat". Total heat scales the
 * run's score, XP and relic payout, so a player who takes on risk is paid for
 * it. Like every other modifier they funnel through `Perks` (and the level's
 * difficulty multiplier), so the simulation never needs to know they exist.
 */

export interface Mutator {
  id: string;
  icon: string;
  /** Rewards multiplier grows by HEAT_STEP per point. */
  heat: number;
  /** Commander rank needed to pick it freely. Daily challenges ignore this. */
  unlockRank: number;
  perk?: PerkDelta;
  /** Multiplies the level's enemy difficulty. */
  difficulty?: number;
  name: string;
  desc: string;
}

/** Each heat point adds this much to the score/XP/relic multiplier. */
export const HEAT_STEP = 0.1;
/** Most mutators a player can stack in a freely-configured endless run. */
export const MAX_MUTATORS = 4;

export const MUTATORS: Mutator[] = [
  {
    id: 'surge', icon: '🐝', heat: 3, unlockRank: 2, difficulty: 1.25,
    name: 'Swarm Surge', desc: 'Enemies are 25% stronger.',
  },
  {
    id: 'thin_seams', icon: '⛏️', heat: 2, unlockRank: 3, perk: { oreYield: 0.75 },
    name: 'Thin Seams', desc: 'Ore seams yield 25% less.',
  },
  {
    id: 'glass', icon: '🥚', heat: 1, unlockRank: 4, perk: { playerMaxHp: 0.6 },
    name: 'Glass Frame', desc: 'Your own frame has 40% less health.',
  },
  {
    id: 'brittle', icon: '🧊', heat: 2, unlockRank: 5, perk: { structureHp: 0.75 },
    name: 'Brittle Steel', desc: 'Every structure has 25% less health.',
  },
  {
    id: 'austerity', icon: '💸', heat: 2, unlockRank: 6, perk: { buildCost: 1.25, sellRefund: 0.8 },
    name: 'Austerity', desc: 'Building costs 25% more and refunds shrink.',
  },
  {
    id: 'brownout', icon: '🔌', heat: 2, unlockRank: 8, perk: { powerOutput: 0.75 },
    name: 'Brownout', desc: 'Reactors output 25% less power.',
  },
  {
    id: 'frail_core', icon: '💔', heat: 3, unlockRank: 10, perk: { coreHp: 0.7 },
    name: 'Frail Core', desc: 'The reactor core has 30% less health.',
  },
];

export const MUTATORS_BY_ID = new Map(MUTATORS.map((m) => [m.id, m]));

export const mutatorName = (m: Mutator) => t(`mutator.${m.id}.name`, m.name);
export const mutatorDesc = (m: Mutator) => t(`mutator.${m.id}.desc`, m.desc);

/** Drops unknown and duplicate ids so a stale save can never crash a run. */
export function validMutators(ids: readonly string[] | undefined | null): string[] {
  const out: string[] = [];
  for (const id of ids ?? []) {
    if (MUTATORS_BY_ID.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export function totalHeat(ids: readonly string[]): number {
  let sum = 0;
  for (const id of ids) sum += MUTATORS_BY_ID.get(id)?.heat ?? 0;
  return sum;
}

/** Reward multiplier for a set of mutators: 1 with none active. */
export function heatMult(ids: readonly string[]): number {
  return 1 + totalHeat(ids) * HEAT_STEP;
}

/** Multiplier on the level's enemy difficulty. */
export function mutatorDifficulty(ids: readonly string[]): number {
  let mult = 1;
  for (const id of ids) mult *= MUTATORS_BY_ID.get(id)?.difficulty ?? 1;
  return mult;
}

export function applyMutators(perks: Perks, ids: readonly string[]) {
  for (const id of ids) {
    const m = MUTATORS_BY_ID.get(id);
    if (m?.perk) applyPerk(perks, m.perk);
  }
}

export function isMutatorUnlocked(m: Mutator, rank: number) {
  return rank >= m.unlockRank;
}
