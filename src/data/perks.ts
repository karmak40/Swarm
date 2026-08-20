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

/** Human-readable one-liner for a delta, used on cards and achievement rows. */
export function describePerk(delta: PerkDelta): string {
  const parts: string[] = [];
  const pct = (v: number) => `${v > 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`;
  const label: Record<string, string> = {
    turretDamage: 'turret damage', turretFireRate: 'turret fire rate', turretRange: 'turret range',
    playerDamage: 'weapon damage', playerFireRate: 'weapon fire rate', playerMaxHp: 'max health',
    playerSpeed: 'move speed', miningSpeed: 'mining speed', oreYield: 'ore yield',
    essenceYield: 'essence yield', buildCost: 'build cost', sellRefund: 'sell refund',
    extractorRate: 'extractor rate', structureHp: 'structure HP', coreHp: 'core HP',
    powerOutput: 'power output', repairRate: 'repair rate', buildSpeed: 'build speed',
    pickupRadius: 'pickup radius',
  };
  for (const k of Object.keys(delta) as (keyof Perks)[]) {
    const v = delta[k]!;
    if (k === 'startOre') parts.push(`+${v} starting ore`);
    else if (k === 'startEssence') parts.push(`+${v} starting essence`);
    else if (k === 'playerRegen') parts.push(`+${v}/s health regen`);
    else if (k === 'coreRegen') parts.push(`+${v}/s core regen`);
    else if (k === 'revives') parts.push(`${v} core save${v > 1 ? 's' : ''}`);
    else if (k === 'techChoices') parts.push(`+${v} tech option`);
    else if (k === 'luck') parts.push(`+${Math.round(v * 100)}% bonus drops`);
    else if (k === 'splashEcho') parts.push(`${Math.round(v * 100)}% splash echo`);
    else if (k === 'armorShred') parts.push(`+${v} armour shred`);
    else parts.push(`${pct(v)} ${label[k] ?? k}`);
  }
  return parts.join(', ');
}
