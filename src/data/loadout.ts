import { t } from '../core/i18n';

/**
 * Player weapons and armor tiers — bought mid-run with essence (see
 * `Game.buyWeapon`/`buyArmorTier`). Distinct from tech cards (random, free,
 * numeric perks only) and the relic Armoury (permanent, cross-run, bought
 * with relics): this is an essence sink the player chooses deliberately,
 * and it carries across sectors within one campaign attempt the same way
 * tech does — see `Game.carryOver`.
 */

export type WeaponKind = 'rifle' | 'shotgun' | 'dualmg' | 'rocket';

export const WEAPON_KINDS: readonly WeaponKind[] = ['rifle', 'shotgun', 'dualmg', 'rocket'];

export interface WeaponDef {
  id: WeaponKind;
  name: string;
  glyph: string;
  /** Essence cost to unlock. 0 = owned from the start. */
  cost: number;
  /** Base shots/sec before `Perks.playerFireRate`. */
  fireRate: number;
  /** Heat added per shot — how fast sustained fire trips the overheat lock. */
  heatPerShot: number;
  description: string;
}

export const WEAPONS: Record<WeaponKind, WeaponDef> = {
  rifle: {
    id: 'rifle', name: 'Autorifle', glyph: '◆', cost: 0, fireRate: 7.4, heatPerShot: 0.052,
    description: 'Balanced sidearm. Steady single-target damage, no real weaknesses.',
  },
  shotgun: {
    id: 'shotgun', name: 'Riot Shotgun', glyph: '✦', cost: 70, fireRate: 3.0, heatPerShot: 0.085,
    description: 'Five-pellet cone. Devastating up close, falls off hard at range.',
  },
  dualmg: {
    id: 'dualmg', name: 'Twin Autocannon', glyph: '≡', cost: 110, fireRate: 11.5, heatPerShot: 0.07,
    description: 'Twin streams at a much higher rate of fire. Loose spread, high sustained output.',
  },
  rocket: {
    id: 'rocket', name: 'Rocket Launcher', glyph: '▲', cost: 160, fireRate: 1.35, heatPerShot: 0.05,
    description: 'Slow and heavy, but explosive — clears clumps turrets alone cannot thin out.',
  },
};

/** Localised weapon name/description; English above is the source of truth and fallback. */
export function weaponName(w: WeaponDef): string { return t(`weapon.${w.id}.name`, w.name); }
export function weaponDesc(w: WeaponDef): string { return t(`weapon.${w.id}.desc`, w.description); }

export interface ArmorTierDef {
  tier: number;
  name: string;
  /** Essence cost to buy up from the previous tier. */
  cost: number;
  hpBonus: number;
  /** Chassis recolor — visibly heavier plating at higher tiers. */
  color: number;
}

export const ARMOR_TIERS: ArmorTierDef[] = [
  { tier: 0, name: 'Unarmoured', cost: 0, hpBonus: 0, color: 0x33465e },
  { tier: 1, name: 'Plate Vest', cost: 60, hpBonus: 40, color: 0x3c5570 },
  { tier: 2, name: 'Composite Armor', cost: 110, hpBonus: 90, color: 0x4a6b8a },
  { tier: 3, name: 'Exo Plating', cost: 180, hpBonus: 160, color: 0x5f86ac },
];

export function armorTierName(a: ArmorTierDef): string {
  return t(`armor.tier${a.tier}.name`, a.name);
}
