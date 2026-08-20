import type { BuildingKind } from './buildings';
import type { PerkDelta } from './perks';

/**
 * Run-scoped roguelite draft. Offered after every third wave and after each
 * boss; the player keeps the pick for the rest of the run only.
 */

export type Rarity = 'common' | 'rare' | 'epic';

export interface TechCard {
  id: string;
  name: string;
  desc: string;
  glyph: string;
  rarity: Rarity;
  perk?: PerkDelta;
  /** Permanently adds a structure to the build bar for this run. */
  unlock?: BuildingKind;
  /** Special one-shot effects resolved by the game when picked. */
  effect?: 'refillCore' | 'freeOre' | 'freeEssence' | 'repairAll' | 'instantWave';
  value?: number;
  /** Cannot be offered more than this many times per run. */
  maxStacks?: number;
  /** Only offered when this building is unlocked. */
  requires?: BuildingKind;
}

export const TECH_CARDS: TechCard[] = [
  // --- common ---
  { id: 'hv_rounds', name: 'High-Velocity Rounds', glyph: '🎯', rarity: 'common',
    desc: 'Turrets hit 18% harder.', perk: { turretDamage: 1.18 }, maxStacks: 4 },
  { id: 'feed_mech', name: 'Feed Mechanism', glyph: '⚙️', rarity: 'common',
    desc: 'Turrets fire 15% faster.', perk: { turretFireRate: 1.15 }, maxStacks: 4 },
  { id: 'optics', name: 'Targeting Optics', glyph: '🔭', rarity: 'common',
    desc: 'Turret range +14%.', perk: { turretRange: 1.14 }, maxStacks: 3 },
  { id: 'plating', name: 'Ablative Plating', glyph: '🛡️', rarity: 'common',
    desc: 'Structures gain 22% more HP.', perk: { structureHp: 1.22 }, maxStacks: 3 },
  { id: 'drill_bits', name: 'Tungsten Bits', glyph: '⛏️', rarity: 'common',
    desc: 'Mine 30% faster.', perk: { miningSpeed: 1.3 }, maxStacks: 3 },
  { id: 'servos', name: 'Servo Overhaul', glyph: '🦿', rarity: 'common',
    desc: 'Move 14% faster.', perk: { playerSpeed: 1.14 }, maxStacks: 3 },
  { id: 'coolant', name: 'Coolant Loop', glyph: '❄️', rarity: 'common',
    desc: 'Your weapon fires 18% faster.', perk: { playerFireRate: 1.18 }, maxStacks: 3 },
  { id: 'salvage', name: 'Salvage Protocol', glyph: '♻️', rarity: 'common',
    desc: 'Structures cost 12% less ore.', perk: { buildCost: 0.88 }, maxStacks: 3 },
  { id: 'magnets', name: 'Collection Field', glyph: '🧲', rarity: 'common',
    desc: 'Pickup radius +60%.', perk: { pickupRadius: 1.6 }, maxStacks: 2 },
  { id: 'stipend', name: 'Emergency Stipend', glyph: '📦', rarity: 'common',
    desc: 'Immediately gain 220 ore.', effect: 'freeOre', value: 220 },

  // --- rare ---
  { id: 'overclock', name: 'Reactor Overclock', glyph: '⚡', rarity: 'rare',
    desc: 'Reactors output 35% more power.', perk: { powerOutput: 1.35 }, maxStacks: 2 },
  { id: 'nanoweld', name: 'Nanoweld Swarm', glyph: '🔧', rarity: 'rare',
    desc: 'Repair 40% faster and repair all structures now.',
    perk: { repairRate: 1.4 }, effect: 'repairAll', maxStacks: 2 },
  { id: 'bio_refinery', name: 'Bio-Refinery', glyph: '⚗️', rarity: 'rare',
    desc: 'Enemies yield 35% more essence.', perk: { essenceYield: 1.35 }, maxStacks: 2 },
  { id: 'deep_seams', name: 'Deep Seam Survey', glyph: '💎', rarity: 'rare',
    desc: 'Ore yield +30%, extractors and drones +25%.',
    perk: { oreYield: 1.3, extractorRate: 1.25 }, maxStacks: 2 },
  { id: 'core_lattice', name: 'Core Lattice', glyph: '🔷', rarity: 'rare',
    desc: 'Core HP +25% and it regenerates 3/s.',
    perk: { coreHp: 1.25, coreRegen: 3 }, effect: 'refillCore', maxStacks: 2 },
  { id: 'exo_frame', name: 'Exo-Frame', glyph: '🦾', rarity: 'rare',
    desc: 'Max health +35% and regenerate 2/s.',
    perk: { playerMaxHp: 1.35, playerRegen: 2 }, maxStacks: 2 },
  { id: 'ap_core', name: 'Armour-Piercing Core', glyph: '🔩', rarity: 'rare',
    desc: 'All damage shreds 6 armour.', perk: { armorShred: 6 }, maxStacks: 3 },
  { id: 'lucky', name: 'Scavenger Instinct', glyph: '🍀', rarity: 'rare',
    desc: '+20% chance of a bonus essence drop.', perk: { luck: 0.2 }, maxStacks: 3 },
  { id: 'prefab', name: 'Prefab Kits', glyph: '🏗️', rarity: 'rare',
    desc: 'Structures finish 60% faster.', perk: { buildSpeed: 1.6 }, maxStacks: 2 },

  { id: 'warheads', name: 'Shaped Warheads', glyph: '➤', rarity: 'rare',
    desc: 'Turret damage +25% and 8 armour shred — built for missile racks.',
    perk: { turretDamage: 1.25, armorShred: 8 }, requires: 'rocket', maxStacks: 2 },

  // --- epic ---
  { id: 'unlock_rocket', name: 'Guided Munitions', glyph: '➤', rarity: 'epic',
    desc: 'Unlocks the Missile Battery — the highest single-shot damage available.',
    unlock: 'rocket', maxStacks: 1 },
  { id: 'unlock_pulse', name: 'Coherent Pulse', glyph: '◈', rarity: 'epic',
    desc: 'Unlocks the Pulse Laser — a tracking beam that ignores armour.',
    unlock: 'pulselaser', maxStacks: 1 },
  { id: 'unlock_dronebay', name: 'Automation Doctrine', glyph: '⬡', rarity: 'epic',
    desc: 'Unlocks the Drone Bay — three hover drones that mine and haul for you.',
    unlock: 'dronebay', maxStacks: 1 },
  { id: 'unlock_cannon', name: 'Siege Doctrine', glyph: '◎', rarity: 'epic',
    desc: 'Unlocks the Siege Cannon for this run.', unlock: 'cannon', maxStacks: 1 },
  { id: 'unlock_tesla', name: 'Arc Theory', glyph: '⚡', rarity: 'epic',
    desc: 'Unlocks the Arc Node for this run.', unlock: 'tesla', maxStacks: 1 },
  { id: 'unlock_flak', name: 'Air Denial', glyph: '✳', rarity: 'epic',
    desc: 'Unlocks the Flak Battery for this run.', unlock: 'flak', maxStacks: 1 },
  { id: 'unlock_laser', name: 'Coherent Optics', glyph: '✦', rarity: 'epic',
    desc: 'Unlocks the Lance for this run.', unlock: 'laser', maxStacks: 1 },
  { id: 'unlock_mortar', name: 'Indirect Fire', glyph: '◭', rarity: 'epic',
    desc: 'Unlocks the Siege Mortar for this run.', unlock: 'mortar', maxStacks: 1 },
  { id: 'unlock_repair', name: 'Field Logistics', glyph: '✚', rarity: 'epic',
    desc: 'Unlocks the Repair Bay for this run.', unlock: 'repairbay', maxStacks: 1 },
  { id: 'unlock_shield', name: 'Aegis Protocol', glyph: '◈', rarity: 'epic',
    desc: 'Unlocks the Aegis Pylon for this run.', unlock: 'shield', maxStacks: 1 },
  { id: 'echo', name: 'Resonance Cascade', glyph: '🌀', rarity: 'epic',
    desc: 'Every hit echoes 25% of its damage as splash.',
    perk: { splashEcho: 0.25 }, maxStacks: 2 },
  { id: 'annihilation', name: 'Annihilation Doctrine', glyph: '☢️', rarity: 'epic',
    desc: 'Turrets: +30% damage, +20% fire rate, -15% HP.',
    perk: { turretDamage: 1.3, turretFireRate: 1.2, structureHp: 0.85 }, maxStacks: 2 },
  { id: 'second_wind', name: 'Contingency Core', glyph: '💫', rarity: 'epic',
    desc: 'The core survives one lethal hit at 30% HP.', perk: { revives: 1 }, maxStacks: 2 },
];

export const RARITY_WEIGHT: Record<Rarity, number> = { common: 62, rare: 29, epic: 9 };
