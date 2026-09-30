import { t } from '../core/i18n';

/**
 * In-place turret upgrades.
 *
 * A turret starts at level 1. Level 2 is a straight step up; level 3 forks
 * into one of two branches, so a placed gun keeps growing with the base and a
 * mid-game ore surplus has somewhere meaningful to go besides "more of the
 * same". Only turrets upgrade — walls and utilities stay as they are.
 *
 * Multipliers stack on top of the global perk multipliers (tech, relics).
 */

export type UpgradeBranch = 'rapid' | 'range';

export const MAX_BUILDING_LEVEL = 3;

export interface UpgradeMul {
  damage: number;
  rate: number;
  range: number;
  hp: number;
}

const BASE: UpgradeMul = { damage: 1, rate: 1, range: 1, hp: 1 };
/** Level 2: the same gun, just better. */
const LEVEL2: UpgradeMul = { damage: 1.3, rate: 1, range: 1, hp: 1.25 };
/** Level 3 branches, applied on top of level 2. */
const BRANCH: Record<UpgradeBranch, UpgradeMul> = {
  rapid: { damage: 1, rate: 1.35, range: 1, hp: 1.1 },
  range: { damage: 1.15, rate: 1, range: 1.25, hp: 1.1 },
};

/** Total multipliers for a turret at `level` (with `branch` at level 3). */
export function upgradeMul(level: number, branch: UpgradeBranch | null): UpgradeMul {
  if (level <= 1) return BASE;
  if (level === 2 || !branch) return LEVEL2;
  const b = BRANCH[branch];
  return {
    damage: LEVEL2.damage * b.damage,
    rate: LEVEL2.rate * b.rate,
    range: LEVEL2.range * b.range,
    hp: LEVEL2.hp * b.hp,
  };
}

/** Price of the step *to* `level`, as a fraction of the structure's build cost. */
export function upgradeCostFraction(level: number): number {
  return level === 2 ? 0.6 : level === 3 ? 0.9 : 0;
}

export function branchName(branch: UpgradeBranch): string {
  return branch === 'rapid'
    ? t('upgrades.branch.rapid', 'Rapid fire')
    : t('upgrades.branch.range', 'Long range');
}

/** One-line effect summary, for tooltips and the touch menu. */
export function branchEffect(branch: UpgradeBranch): string {
  return branch === 'rapid'
    ? t('upgrades.branch.rapidEffect', '+35% fire rate')
    : t('upgrades.branch.rangeEffect', '+25% range, +15% damage');
}
