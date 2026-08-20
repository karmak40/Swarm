import { t } from '../core/i18n';

/**
 * Perks are the single funnel through which *all* modifiers reach the
 * simulation: achievement rewards, drafted tech cards and level bonuses all
 * write into one `Perks` bag, which is then read by the systems. Adding a new
 * source of power means adding a field here and reading it in exactly one place.
 */
export interface Perks {
  /** Turret damage multiplier. */
  turretDamage: number;
  turretFireRate: number;
  turretRange: number;
  /** Player weapon. */
  playerDamage: number;
  playerFireRate: number;
  playerMaxHp: number;
  playerSpeed: number;
  playerRegen: number;      // hp/sec
  /** Economy. */
  miningSpeed: number;
  oreYield: number;
  essenceYield: number;
  buildCost: number;        // multiplier, lower is better
  sellRefund: number;
  extractorRate: number;
  /** Structures. */
  structureHp: number;
  coreHp: number;
  coreRegen: number;        // hp/sec
  powerOutput: number;
  repairRate: number;
  buildSpeed: number;
  /** Utility. */
  startOre: number;
  startEssence: number;
  pickupRadius: number;
  techChoices: number;
  /** One free core save per run. */
  revives: number;
  /** Chance an enemy drops a bonus essence orb. */
  luck: number;
  /** Damage the player deals is repeated as splash at this fraction. */
  splashEcho: number;
  /** Flat armour shred applied by every source. */
  armorShred: number;
}

export function basePerks(): Perks {
  return {
    turretDamage: 1, turretFireRate: 1, turretRange: 1,
    playerDamage: 1, playerFireRate: 1, playerMaxHp: 1, playerSpeed: 1, playerRegen: 0,
    miningSpeed: 1, oreYield: 1, essenceYield: 1, buildCost: 1, sellRefund: 1, extractorRate: 1,
    structureHp: 1, coreHp: 1, coreRegen: 0, powerOutput: 1, repairRate: 1, buildSpeed: 1,
    startOre: 0, startEssence: 0, pickupRadius: 1, techChoices: 3,
    revives: 0, luck: 0, splashEcho: 0, armorShred: 0,
  };
}

export type PerkDelta = Partial<Perks>;

/** Multiplicative fields compound; additive fields sum. */
const ADDITIVE = new Set<keyof Perks>([
  'playerRegen', 'coreRegen', 'startOre', 'startEssence',
  'techChoices', 'revives', 'luck', 'splashEcho', 'armorShred',
]);

export function applyPerk(target: Perks, delta: PerkDelta) {
  for (const k of Object.keys(delta) as (keyof Perks)[]) {
    const v = delta[k];
    if (v === undefined) continue;
    if (ADDITIVE.has(k)) target[k] += v;
    else target[k] *= v;
  }
}

/** English label for each multiplicative field — the fallback and translation key source. */
const FIELD_LABEL: Record<string, string> = {
  turretDamage: 'turret damage', turretFireRate: 'turret fire rate', turretRange: 'turret range',
  playerDamage: 'weapon damage', playerFireRate: 'weapon fire rate', playerMaxHp: 'max health',
  playerSpeed: 'move speed', miningSpeed: 'mining speed', oreYield: 'ore yield',
  essenceYield: 'essence yield', buildCost: 'build cost', sellRefund: 'sell refund',
  extractorRate: 'extractor rate', structureHp: 'structure HP', coreHp: 'core HP',
  powerOutput: 'power output', repairRate: 'repair rate', buildSpeed: 'build speed',
  pickupRadius: 'pickup radius',
};

/** Human-readable one-liner for a delta, used on cards and achievement rows. */
export function describePerk(delta: PerkDelta): string {
  const parts: string[] = [];
  const pct = (v: number) => `${v > 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`;
  for (const k of Object.keys(delta) as (keyof Perks)[]) {
    const v = delta[k]!;
    if (k === 'startOre') parts.push(t('perk.startOre', '+{v} starting ore', { v }));
    else if (k === 'startEssence') parts.push(t('perk.startEssence', '+{v} starting essence', { v }));
    else if (k === 'playerRegen') parts.push(t('perk.playerRegen', '+{v}/s health regen', { v }));
    else if (k === 'coreRegen') parts.push(t('perk.coreRegen', '+{v}/s core regen', { v }));
    else if (k === 'revives') {
      parts.push(v > 1
        ? t('perk.revives.many', '{v} core saves', { v })
        : t('perk.revives.one', '{v} core save', { v }));
    }
    else if (k === 'techChoices') parts.push(t('perk.techChoices', '+{v} tech option', { v }));
    else if (k === 'luck') parts.push(t('perk.luck', '+{v}% bonus drops', { v: Math.round(v * 100) }));
    else if (k === 'splashEcho') parts.push(t('perk.splashEcho', '{v}% splash echo', { v: Math.round(v * 100) }));
    else if (k === 'armorShred') parts.push(t('perk.armorShred', '+{v} armour shred', { v }));
    else {
      const key = k as string;
      const label = t(`perk.field.${key}`, FIELD_LABEL[key] ?? key);
      parts.push(t('perk.multiplier', '{pct} {label}', { pct: pct(v), label }));
    }
  }
  return parts.join(', ');
}
