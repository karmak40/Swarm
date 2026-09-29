import type { PerkDelta } from './perks';
import { t } from '../core/i18n';

/**
 * Permanent, cross-run upgrades bought with Relics.
 *
 * Relics were already being awarded (achievement tiers, boss drops) with nothing
 * to spend them on. This is that sink: the between-runs progression that makes a
 * failed run still feel like it moved you forward.
 *
 * Every entry funnels through `Perks` exactly like achievement rewards and tech
 * cards do, so nothing in the simulation needs to know this file exists.
 */

export type UpgradeCategory = 'core' | 'turrets' | 'economy' | 'chassis' | 'doctrine';

export interface RelicUpgrade {
  id: string;
  name: string;
  desc: string;
  icon: string;
  category: UpgradeCategory;
  maxRank: number;
  /** Cost of rank 1. */
  baseCost: number;
  /** Added to the cost for each rank already owned. */
  costStep: number;
  /** Applied once per owned rank — multiplicative fields compound. */
  perRank: PerkDelta;
}

export const CATEGORY_LABEL: Record<UpgradeCategory, string> = {
  core: 'Reactor Core',
  turrets: 'Ordnance',
  economy: 'Logistics',
  chassis: 'Chassis',
  doctrine: 'Doctrine',
};

export const CATEGORY_BLURB: Record<UpgradeCategory, string> = {
  core: 'Keep the thing you are defending alive longer.',
  turrets: 'Everything you build shoots harder.',
  economy: 'More ore, more essence, cheaper walls.',
  chassis: 'You, personally, in the field.',
  doctrine: 'Expensive, run-defining changes.',
};

export const RELIC_UPGRADES: RelicUpgrade[] = [
  // --- core ---
  {
    id: 'reinforced_core', name: 'Reinforced Core', icon: '🔷', category: 'core',
    desc: 'Thicker containment plating on the reactor.',
    maxRank: 5, baseCost: 4, costStep: 3, perRank: { coreHp: 1.08 },
  },
  {
    id: 'core_nanites', name: 'Core Nanites', icon: '🩹', category: 'core',
    desc: 'The core slowly knits itself back together between waves.',
    maxRank: 3, baseCost: 8, costStep: 6, perRank: { coreRegen: 1.5 },
  },

  // --- turrets ---
  {
    id: 'calibration', name: 'Gun Calibration', icon: '🎯', category: 'turrets',
    desc: 'Factory-tuned barrels on every turret you build.',
    maxRank: 5, baseCost: 4, costStep: 3, perRank: { turretDamage: 1.06 },
  },
  {
    id: 'autoloader', name: 'Autoloaders', icon: '⚙️', category: 'turrets',
    desc: 'Faster feed mechanisms across the board.',
    maxRank: 4, baseCost: 5, costStep: 4, perRank: { turretFireRate: 1.05 },
  },
  {
    id: 'optics', name: 'Optics Array', icon: '🔭', category: 'turrets',
    desc: 'Longer engagement envelope on every gun.',
    maxRank: 3, baseCost: 5, costStep: 4, perRank: { turretRange: 1.05 },
  },
  {
    id: 'alloys', name: 'Structural Alloys', icon: '🧱', category: 'turrets',
    desc: 'Everything you build takes more punishment.',
    maxRank: 4, baseCost: 4, costStep: 3, perRank: { structureHp: 1.08 },
  },
  {
    id: 'shredder', name: 'Shredder Rounds', icon: '🔩', category: 'turrets',
    desc: 'All damage strips armour before it lands.',
    maxRank: 3, baseCost: 6, costStep: 5, perRank: { armorShred: 3 },
  },

  // --- economy ---
  {
    id: 'deep_drills', name: 'Deep Drills', icon: '⛏️', category: 'economy',
    desc: 'Your mining beam cuts seams faster.',
    maxRank: 4, baseCost: 3, costStep: 3, perRank: { miningSpeed: 1.1 },
  },
  {
    id: 'assay', name: 'Assay Refinement', icon: '💎', category: 'economy',
    desc: 'More ore recovered from the same seam, however you work it.',
    maxRank: 4, baseCost: 4, costStep: 3, perRank: { oreYield: 1.06 },
  },
  {
    id: 'bio_reclaim', name: 'Bio-Reclamation', icon: '⚗️', category: 'economy',
    desc: 'Render more essence out of every corpse.',
    maxRank: 3, baseCost: 5, costStep: 4, perRank: { essenceYield: 1.08 },
  },
  {
    id: 'supply_cache', name: 'Supply Cache', icon: '📦', category: 'economy',
    desc: 'Deploy with ore already on the ground.',
    maxRank: 4, baseCost: 3, costStep: 2, perRank: { startOre: 45 },
  },
  {
    id: 'essence_reserve', name: 'Essence Reserve', icon: '🧪', category: 'economy',
    desc: 'Deploy with essence banked.',
    maxRank: 3, baseCost: 4, costStep: 3, perRank: { startEssence: 25 },
  },
  {
    id: 'grid_eff', name: 'Grid Efficiency', icon: '⚡', category: 'economy',
    desc: 'Reactors push more power into the grid.',
    maxRank: 3, baseCost: 5, costStep: 4, perRank: { powerOutput: 1.08 },
  },
  {
    id: 'salvage', name: 'Salvage Rights', icon: '♻️', category: 'economy',
    desc: 'Better refunds and slightly cheaper construction.',
    maxRank: 3, baseCost: 4, costStep: 3, perRank: { sellRefund: 1.1, buildCost: 0.97 },
  },

  // --- chassis ---
  {
    id: 'hardened', name: 'Hardened Chassis', icon: '🦾', category: 'chassis',
    desc: 'More health on your own frame.',
    maxRank: 4, baseCost: 3, costStep: 3, perRank: { playerMaxHp: 1.1 },
  },
  {
    id: 'servos', name: 'Exo-Servos', icon: '🦿', category: 'chassis',
    desc: 'Move faster between the seams and the line.',
    maxRank: 3, baseCost: 4, costStep: 3, perRank: { playerSpeed: 1.06 },
  },
  {
    id: 'medifield', name: 'Medifield', icon: '➕', category: 'chassis',
    desc: 'Regenerate health continuously in the field.',
    maxRank: 3, baseCost: 5, costStep: 4, perRank: { playerRegen: 1 },
  },
  {
    id: 'magnet', name: 'Collection Field', icon: '🧲', category: 'chassis',
    desc: 'Pull essence in from much further away.',
    maxRank: 2, baseCost: 4, costStep: 4, perRank: { pickupRadius: 1.25 },
  },
  {
    id: 'dash_thrusters', name: 'Recharge Cycles', icon: '🔋', category: 'chassis',
    desc: 'The dash thrusters cool down faster.',
    maxRank: 4, baseCost: 4, costStep: 3, perRank: { dashCooldown: 0.88 },
  },
  {
    id: 'dash_shielding', name: 'Phase Shielding', icon: '🛡️', category: 'chassis',
    desc: 'Longer invulnerability while dashing.',
    maxRank: 3, baseCost: 5, costStep: 4, perRank: { dashInvuln: 0.06 },
  },
  {
    id: 'dash_ram', name: 'Kinetic Ram', icon: '💥', category: 'chassis',
    desc: 'Anything you dash through takes a hit.',
    maxRank: 3, baseCost: 6, costStep: 5, perRank: { dashRamDamage: 22 },
  },

  // --- doctrine ---
  {
    id: 'prospector', name: "Prospector's Luck", icon: '🍀', category: 'doctrine',
    desc: 'Chance of a bonus essence drop from any kill.',
    maxRank: 3, baseCost: 6, costStep: 5, perRank: { luck: 0.06 },
  },
  {
    id: 'requisition', name: 'Field Requisition', icon: '📡', category: 'doctrine',
    desc: 'Every tech draft offers one extra option, for the rest of time.',
    maxRank: 1, baseCost: 30, costStep: 0, perRank: { techChoices: 1 },
  },
  {
    id: 'contingency', name: 'Contingency Protocol', icon: '💫', category: 'doctrine',
    desc: 'The core survives a lethal hit and reboots at 30%.',
    maxRank: 2, baseCost: 25, costStep: 20, perRank: { revives: 1 },
  },
];

export const UPGRADES_BY_ID = new Map(RELIC_UPGRADES.map((u) => [u.id, u]));

/** Relic cost to take an upgrade from `rank` to `rank + 1`. */
export function upgradeCost(u: RelicUpgrade, rank: number): number {
  return u.baseCost + u.costStep * rank;
}

/** Total relics needed to max a single upgrade from scratch. */
export function totalCost(u: RelicUpgrade): number {
  let sum = 0;
  for (let r = 0; r < u.maxRank; r++) sum += upgradeCost(u, r);
  return sum;
}

export const CATEGORY_ORDER: UpgradeCategory[] =
  ['core', 'turrets', 'economy', 'chassis', 'doctrine'];

/** Localised display name. English text above is the source of truth and fallback. */
export function relicUpgradeName(u: RelicUpgrade): string {
  return t(`relicUpgrade.${u.id}.name`, u.name);
}

/** Localised effect description. */
export function relicUpgradeDesc(u: RelicUpgrade): string {
  return t(`relicUpgrade.${u.id}.desc`, u.desc);
}

/** Localised category heading, e.g. for the armoury's section tabs. */
export function categoryLabel(cat: UpgradeCategory): string {
  return t(`relicUpgrade.category.${cat}.label`, CATEGORY_LABEL[cat]);
}

/** Localised one-line category blurb. */
export function categoryBlurb(cat: UpgradeCategory): string {
  return t(`relicUpgrade.category.${cat}.blurb`, CATEGORY_BLURB[cat]);
}
