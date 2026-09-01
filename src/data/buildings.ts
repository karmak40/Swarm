import { t } from '../core/i18n';

/**
 * Buildable structures.
 *
 * Cost is paid in ore + essence. Turrets draw power; generators supply it.
 * When draw exceeds supply the whole grid browns out and every turret's rate
 * of fire scales by the deficit ratio — that tension is the core build puzzle.
 */

export type BuildingKind =
  | 'wall' | 'turret' | 'rocket' | 'cannon' | 'tesla' | 'flak'
  | 'pulselaser' | 'laser' | 'mortar'
  | 'generator' | 'extractor' | 'dronebay' | 'repairbay' | 'shield' | 'forcefield';

export type TargetingMode = 'first' | 'closest' | 'strongest' | 'weakest';

/**
 * Build-bar sections.
 *
 * The roster outgrew a single strip of fourteen slots, so the desktop bar is
 * grouped. The split is by what you are trying to do, not by tier: you open
 * Resources during the build phase to grow income, Towers to add guns, and
 * Defence for the things that keep both alive.
 */
export type BuildCategory = 'resources' | 'towers' | 'defence';

export const BUILD_CATEGORIES: BuildCategory[] = ['resources', 'towers', 'defence'];

/** English labels; localised at the call site via `buildCategoryLabel`. */
export const CATEGORY_NAME: Record<BuildCategory, string> = {
  resources: 'Resources',
  towers: 'Towers',
  defence: 'Defence',
};

/** Direct-select key per section, so the mouse is never required. */
export const CATEGORY_KEY: Record<BuildCategory, string> = {
  resources: 'Z',
  towers: 'X',
  defence: 'C',
};

export const CATEGORY_KEY_CODE: Record<BuildCategory, string> = {
  resources: 'KeyZ',
  towers: 'KeyX',
  defence: 'KeyC',
};

export interface BuildingDef {
  id: BuildingKind;
  name: string;
  glyph: string;
  /**
   * Slot key *within its section*, not a global hotkey. Sections are switched
   * with CATEGORY_KEY, so the same digit means a different structure depending
   * on which tab is open — that is what let the roster keep growing.
   */
  hotkey: string;
  category: BuildCategory;
  tier: number;
  ore: number;
  essence: number;
  hp: number;
  /** Footprint in tiles (square). */
  size: number;
  /** Positive = consumes power, negative = supplies it. */
  power: number;
  blocksMovement: boolean;
  /** Multiplies the pathing cost of covered tiles; enemies route around it. */
  pathCost: number;
  buildTime: number;
  desc: string;

  // --- weapon (turrets only) ---
  damage?: number;
  fireRate?: number;      // shots/sec
  range?: number;         // px
  projectileSpeed?: number;
  splash?: number;
  pierce?: number;
  chains?: number;
  beam?: boolean;
  /** Ray tint for beam weapons, so each laser reads as its own weapon. */
  beamColor?: number;
  /**
   * Muzzle-flare brightness multiplier (default 1). Rapid-firing or multi-barrel
   * guns need this well below 1: their flashes retrigger before the previous one
   * has faded, and the bloom pass compounds them into a standing glare.
   */
  muzzleFlare?: number;
  antiAir?: boolean;
  groundOnly?: boolean;
  spread?: number;        // radians of inaccuracy
  burst?: number;
  armorPierce?: number;
  turnRate?: number;      // rad/s
  slowFactor?: number;
  /** Projectiles steer toward the locked target instead of flying straight. */
  homing?: boolean;
  /** rad/s a homing projectile can turn; low values let fast fliers juke it. */
  homingTurn?: number;
  /** Minimum engagement distance — the shell cannot arm closer than this. */
  minRange?: number;

  // --- utility ---
  auraRadius?: number;
  repairRate?: number;
  shieldAmount?: number;
  extractRate?: number;
  /**
   * Force Field only: the dome's own hp pool once fully charged (scales with
   * `Perks.structureHp` like a building's own hp does). Presence of this
   * field is what identifies a Force Field to `Game.updateForceField`.
   */
  fieldHp?: number;
  /** Force Field: seconds to come online the first time, after construction. */
  chargeTime?: number;
  /** Force Field: seconds to come back up after the dome has been depleted — deliberately longer than `chargeTime`. */
  rechargeTime?: number;

  // --- drones ---
  /** How many drones this structure keeps in the air. */
  droneSlots?: number;
  /** Seconds to rebuild a lost drone. */
  droneRespawn?: number;
  /** Ore mined per second while a drone is working a seam. */
  droneMineRate?: number;
  /** Ore a drone carries before it must return to unload. */
  droneCargo?: number;
  /** Flight speed, px/s. */
  droneSpeed?: number;
  droneHp?: number;
  /** How far from the bay a drone will look for work. */
  droneRange?: number;
}

export const BUILDINGS: Record<BuildingKind, BuildingDef> = {
  wall: {
    id: 'wall', name: 'Barricade', glyph: '▦', hotkey: '1', category: 'defence', tier: 0,
    ore: 12, essence: 0, hp: 420, size: 1, power: 0,
    blocksMovement: true, pathCost: 26, buildTime: 0.35,
    desc: 'Cheap plating. Reroutes the swarm instead of stopping it — leave a gap you control.',
  },
  turret: {
    id: 'turret', name: 'Autogun', glyph: '⌖', hotkey: '1', category: 'towers', tier: 0,
    ore: 40, essence: 0, hp: 200, size: 1, power: 4,
    blocksMovement: true, pathCost: 22, buildTime: 0.8,
    damage: 9, fireRate: 3.6, range: 190, projectileSpeed: 620,
    spread: 0.045, turnRate: 7, antiAir: true,
    desc: 'Reliable rapid fire. Hits air. Your bread and butter.',
  },
  generator: {
    id: 'generator', name: 'Reactor', glyph: '⬢', hotkey: '3', category: 'resources', tier: 0,
    ore: 55, essence: 0, hp: 260, size: 2, power: -30,
    blocksMovement: true, pathCost: 30, buildTime: 1.0,
    desc: 'Supplies 30 power. Explodes violently when destroyed — keep it behind the line.',
  },
  extractor: {
    id: 'extractor', name: 'Extractor', glyph: '⛏', hotkey: '1', category: 'resources', tier: 0,
    ore: 60, essence: 0, hp: 220, size: 2, power: 5,
    blocksMovement: true, pathCost: 30, buildTime: 1.2,
    extractRate: 2.4,
    desc: 'Must sit on an ore seam. Mines it passively so you can fight instead.',
  },
  dronebay: {
    id: 'dronebay', name: 'Drone Bay', glyph: '⬡', hotkey: '2', category: 'resources', tier: 1,
    ore: 145, essence: 40, hp: 260, size: 2, power: 10,
    blocksMovement: true, pathCost: 30, buildTime: 1.6,
    droneSlots: 3, droneRespawn: 20,
    droneMineRate: 4, droneCargo: 20, droneSpeed: 95, droneHp: 34, droneRange: 900,
    desc: 'Keeps three hover drones mining whatever seam is nearest and hauling it home. ' +
      'Slower than an Extractor per seam, but it never strands when one runs dry — ' +
      'and the drones are fragile in the open.',
  },
  rocket: {
    id: 'rocket', name: 'Missile Battery', glyph: '➤', hotkey: '2', category: 'towers', tier: 1,
    ore: 170, essence: 35, hp: 270, size: 2, power: 15,
    blocksMovement: true, pathCost: 34, buildTime: 1.6,
    damage: 130, fireRate: 0.52, range: 420, projectileSpeed: 260,
    splash: 78, armorPierce: 10, burst: 2, turnRate: 2.8, antiAir: true,
    homing: true, homingTurn: 3.4, minRange: 90,
    // Two pods launching 75ms apart: a heavy flash, but not a full-strength
    // slam twice in a row. Kept brighter than the flak's — it is a rocket motor.
    muzzleFlare: 0.6,
    desc: 'Guided warheads with the highest single-shot damage in the arsenal. ' +
      'They track their target and hit air, but cannot arm at close range — screen it with autoguns.',
  },
  cannon: {
    id: 'cannon', name: 'Siege Cannon', glyph: '◎', hotkey: '3', category: 'towers', tier: 1,
    ore: 95, essence: 10, hp: 320, size: 2, power: 9,
    blocksMovement: true, pathCost: 34, buildTime: 1.4,
    damage: 46, fireRate: 0.72, range: 250, projectileSpeed: 430,
    splash: 62, armorPierce: 4, turnRate: 2.4, groundOnly: true,
    desc: 'Heavy shells with a wide blast. Slow to traverse — cover the flanks.',
  },
  tesla: {
    id: 'tesla', name: 'Arc Node', glyph: '⚡', hotkey: '4', category: 'towers', tier: 1,
    ore: 80, essence: 30, hp: 180, size: 1, power: 12,
    blocksMovement: true, pathCost: 22, buildTime: 1.1,
    damage: 15, fireRate: 1.5, range: 165, chains: 4, slowFactor: 0.6, antiAir: true,
    desc: 'Chains lightning between targets and leaves them sluggish. Melts swarms.',
  },
  flak: {
    id: 'flak', name: 'Flak Battery', glyph: '✳', hotkey: '5', category: 'towers', tier: 1,
    ore: 85, essence: 20, hp: 190, size: 1, power: 8,
    blocksMovement: true, pathCost: 22, buildTime: 1.1,
    damage: 22, fireRate: 1.6, range: 265, projectileSpeed: 700,
    splash: 54, burst: 3, spread: 0.09, turnRate: 6, antiAir: true,
    // Twin barrels firing a 3-round burst: keep each flash small and let the
    // shells' airburst carry the spectacle instead.
    muzzleFlare: 0.28,
    desc: 'Bursting shells tuned for fliers. Barely scratches armour on the ground.',
  },
  pulselaser: {
    id: 'pulselaser', name: 'Pulse Laser', glyph: '◈', hotkey: '6', category: 'towers', tier: 1,
    ore: 105, essence: 25, hp: 200, size: 1, power: 13,
    blocksMovement: true, pathCost: 22, buildTime: 1.1,
    damage: 26, fireRate: 6, range: 230, beam: true, pierce: 1,
    armorPierce: 999, turnRate: 6.5, antiAir: true, beamColor: 0x7dffd0,
    desc: 'Compact tracking beam. Ignores armour entirely and never misses, ' +
      'but only ever burns one target at a time.',
  },
  laser: {
    id: 'laser', name: 'Lance', glyph: '✦', hotkey: '7', category: 'towers', tier: 2,
    ore: 150, essence: 55, hp: 240, size: 2, power: 20,
    blocksMovement: true, pathCost: 34, buildTime: 1.8,
    damage: 78, fireRate: 5, range: 300, beam: true, pierce: 3,
    armorPierce: 999, turnRate: 3.5, antiAir: true, beamColor: 0xff6fd0,
    desc: 'Continuous beam that ignores armour and burns through a line of bodies.',
  },
  mortar: {
    id: 'mortar', name: 'Siege Mortar', glyph: '◭', hotkey: '8', category: 'towers', tier: 2,
    ore: 190, essence: 70, hp: 280, size: 2, power: 16,
    blocksMovement: true, pathCost: 34, buildTime: 2.0,
    damage: 120, fireRate: 0.35, range: 620, projectileSpeed: 210,
    splash: 108, armorPierce: 8, groundOnly: true, turnRate: 1.6, minRange: 140,
    desc: 'Lobs over walls onto distant spawn lanes. Cannot hit anything close.',
  },
  repairbay: {
    id: 'repairbay', name: 'Repair Bay', glyph: '✚', hotkey: '2', category: 'defence', tier: 2,
    ore: 130, essence: 45, hp: 240, size: 2, power: 14,
    blocksMovement: true, pathCost: 30, buildTime: 1.5,
    auraRadius: 200, repairRate: 14,
    desc: 'Continuously welds every structure in range, including itself.',
  },
  shield: {
    id: 'shield', name: 'Aegis Pylon', glyph: '❖', hotkey: '3', category: 'defence', tier: 3,
    ore: 210, essence: 110, hp: 200, size: 2, power: 26,
    blocksMovement: true, pathCost: 30, buildTime: 2.0,
    auraRadius: 190, shieldAmount: 260,
    desc: 'Wraps nearby structures in a regenerating barrier that soaks hits first.',
  },
  forcefield: {
    id: 'forcefield', name: 'Field Emitter', glyph: '⬡', hotkey: '4', category: 'defence', tier: 4,
    ore: 260, essence: 150, hp: 170, size: 2, power: 24,
    blocksMovement: true, pathCost: 30, buildTime: 2.2,
    auraRadius: 130, fieldHp: 380, chargeTime: 6, rechargeTime: 16,
    desc: 'Raises a dome that intercepts ranged fire — melee still gets through. Draws power to charge, '
      + 'more to hold; enough incoming damage collapses it, and every recharge after the first takes longer.',
  },
};

export const BUILD_ORDER: BuildingKind[] = [
  // Section order, then slot order within each — this is the order the bar and
  // the touch drawer both walk.
  'extractor', 'dronebay', 'generator',
  'turret', 'rocket', 'cannon', 'tesla', 'flak', 'pulselaser', 'laser', 'mortar',
  'wall', 'repairbay', 'shield', 'forcefield',
];

/** Everything in one section, in slot order, filtered to what is unlocked. */
export function buildingsInCategory(
  category: BuildCategory,
  unlocked: ReadonlySet<BuildingKind> | BuildingKind[],
): BuildingKind[] {
  const has = Array.isArray(unlocked)
    ? (k: BuildingKind) => unlocked.includes(k)
    : (k: BuildingKind) => unlocked.has(k);
  return BUILD_ORDER.filter((k) => BUILDINGS[k].category === category && has(k));
}

/**
 * Slot-key label -> KeyboardEvent.code.
 *
 * Only digits are needed now: sections carry their own keys, so no structure
 * has to reach for `-`, `=` or the brackets any more.
 */
export const HOTKEY_CODES: Record<string, string> = {
  '1': 'Digit1', '2': 'Digit2', '3': 'Digit3', '4': 'Digit4',
  '5': 'Digit5', '6': 'Digit6', '7': 'Digit7', '8': 'Digit8',
  '9': 'Digit9', '0': 'Digit0',
};

/** Refund fraction when a structure is sold. */
export const SELL_RATIO = 0.6;
/** Repair cost per HP restored, in ore. */
export const REPAIR_COST_PER_HP = 0.06;

/** Localised display name. English text above is the source of truth and fallback. */
export function buildCategoryLabel(category: BuildCategory): string {
  return t(`build.category.${category}`, CATEGORY_NAME[category]);
}

export function buildingName(def: BuildingDef): string {
  return t(`building.${def.id}.name`, def.name);
}

/** Localised flavour/description line, e.g. for the build-bar tooltip. */
export function buildingDesc(def: BuildingDef): string {
  return t(`building.${def.id}.desc`, def.desc);
}
