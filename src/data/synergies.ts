import { t } from '../core/i18n';
import { applyPerk, describePerk, type PerkDelta, type Perks } from './perks';
import { TECH_CARDS } from './tech';

/**
 * Tech synergies: every tech card belongs to one family, and holding enough
 * picks of a family (stacks count) switches on a set bonus — at 3 picks, and
 * a bigger one at 5. It turns the draft from "which card is strongest" into
 * "which build am I going for", and gives a reason to take a weaker card that
 * completes a set.
 *
 * Bonuses are ordinary perk deltas, so they flow through the same `Perks`
 * funnel as everything else and need no special handling in the systems.
 */

export type SynergyTag = 'arsenal' | 'industry' | 'bastion' | 'pilot';

export const SYNERGY_TAGS: SynergyTag[] = ['arsenal', 'industry', 'bastion', 'pilot'];

export interface SynergyTier {
  /** Picks of this family needed. */
  count: number;
  perk: PerkDelta;
}

export interface SynergyDef {
  name: string;
  glyph: string;
  color: number;
  tiers: SynergyTier[];
}

export const SYNERGIES: Record<SynergyTag, SynergyDef> = {
  arsenal: {
    name: 'Arsenal', glyph: '⌖', color: 0xff8a5c,
    tiers: [
      { count: 3, perk: { turretFireRate: 1.1 } },
      { count: 5, perk: { turretDamage: 1.15, armorShred: 4 } },
    ],
  },
  industry: {
    name: 'Industry', glyph: '⛏', color: 0x7fd9ff,
    tiers: [
      { count: 3, perk: { oreYield: 1.15 } },
      { count: 5, perk: { buildCost: 0.85, essenceYield: 1.15 } },
    ],
  },
  bastion: {
    name: 'Bastion', glyph: '⬢', color: 0x5cf2a0,
    tiers: [
      { count: 3, perk: { structureHp: 1.15 } },
      { count: 5, perk: { coreRegen: 3, repairRate: 1.3 } },
    ],
  },
  pilot: {
    name: 'Pilot', glyph: '»', color: 0xb47cff,
    tiers: [
      { count: 3, perk: { dashCooldown: 0.85 } },
      { count: 5, perk: { playerDamage: 1.25, playerRegen: 2 } },
    ],
  },
};

/** The family a tech card belongs to (every card has one). */
export function tagOf(cardId: string): SynergyTag | null {
  return TECH_CARDS.find((c) => c.id === cardId)?.tag ?? null;
}

/** Picks per family in a run's tech list (duplicates are stacks, and count). */
export function synergyCounts(techIds: readonly string[]): Record<SynergyTag, number> {
  const counts: Record<SynergyTag, number> = { arsenal: 0, industry: 0, bastion: 0, pilot: 0 };
  for (const id of techIds) {
    const tag = tagOf(id);
    if (tag) counts[tag]++;
  }
  return counts;
}

/** How many of a family's tiers `count` picks have switched on (0..tiers). */
export function tiersReached(tag: SynergyTag, count: number): number {
  return SYNERGIES[tag].tiers.filter((tier) => count >= tier.count).length;
}

/** Adds every reached tier's bonus to `perks`. Used when perks are rebuilt from a tech list. */
export function applySynergies(perks: Perks, techIds: readonly string[]) {
  const counts = synergyCounts(techIds);
  for (const tag of SYNERGY_TAGS) {
    const n = tiersReached(tag, counts[tag]);
    for (let i = 0; i < n; i++) applyPerk(perks, SYNERGIES[tag].tiers[i].perk);
  }
}

export function synergyName(tag: SynergyTag): string {
  return t(`synergy.${tag}.name`, SYNERGIES[tag].name);
}

/** "Arsenal II" — the family and a tier numeral (1-based). */
export function synergyTitle(tag: SynergyTag, tier: number): string {
  return `${synergyName(tag)} ${'I'.repeat(Math.max(1, tier))}`;
}

/** What a tier gives, as the usual perk one-liner. */
export function tierBonusText(tag: SynergyTag, tierIndex: number): string {
  return describePerk(SYNERGIES[tag].tiers[tierIndex].perk);
}
