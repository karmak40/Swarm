import { t } from '../core/i18n';

/**
 * Enemy archetypes.
 *
 * `shape` drives the procedural renderer; `behavior` selects the AI branch in
 * the simulation. Stats here are level-1 baselines — the wave director scales
 * them by level and wave index.
 */

export type EnemyBehavior =
  | 'charger'    // straight at the core, attacks whatever blocks it
  | 'swarm'      // fast, fragile, flocks tightly
  | 'brute'      // slow, armoured, prioritises buildings
  | 'ranged'     // stops at range and spits
  | 'flyer'      // ignores terrain and walls, beelines
  | 'bomber'     // suicide charge with a death explosion
  | 'burrower'   // periodically phases through walls
  | 'support'    // heals / shields nearby allies
  | 'splitter';  // spawns children on death

export type EnemyShape =
  | 'crawler' | 'mite' | 'brute' | 'spitter' | 'moth'
  | 'bomber' | 'burrower' | 'shaman' | 'blob' | 'queen' | 'scorpion' | 'wasp' | 'boss';

export interface EnemyDef {
  id: string;
  name: string;
  shape: EnemyShape;
  behavior: EnemyBehavior;
  hp: number;
  speed: number;          // px/s
  radius: number;
  /** Flat damage reduction applied per hit, floored at 15% of incoming. */
  armor: number;
  damage: number;         // per melee swing / per projectile
  attackRate: number;     // attacks per second
  attackRange: number;    // px, measured surface to surface
  /** Ore + essence dropped on death. */
  ore: number;
  essence: number;
  xp: number;
  color: number;
  accent: number;
  /** Score/threat weight the wave budget spends. */
  cost: number;
  /** Extra tuning consumed by specific behaviours. */
  projectileSpeed?: number;
  splashRadius?: number;
  splitInto?: string;
  splitCount?: number;
  auraRadius?: number;
  phaseInterval?: number;
  /**
   * Ignores terrain/walls like `behavior: 'flyer'` does, but independent of
   * behavior — lets a non-'flyer' behavior (e.g. 'ranged') keep its own
   * targeting/movement while still flying. See Enemy.flying.
   */
  flies?: boolean;
  boss?: boolean;
  /** Telegraphed special abilities — not boss-exclusive, see Game.updateBossAbilities. */
  abilities?: BossAbility[];
  description?: string;
}

export interface BossAbility {
  id: 'slam' | 'spawn' | 'beam' | 'charge' | 'volley' | 'shield';
  cooldown: number;
  telegraph: number;
  value: number;
}

export const ENEMIES: Record<string, EnemyDef> = {
  crawler: {
    id: 'crawler', name: 'Crawler', shape: 'crawler', behavior: 'charger',
    hp: 34, speed: 62, radius: 9, armor: 0, damage: 7, attackRate: 1.1, attackRange: 4,
    ore: 0, essence: 1, xp: 1, color: 0x9a4b5f, accent: 0xff7d92, cost: 1,
    description: 'Baseline hive drone. Dangerous only in numbers.',
  },
  mite: {
    id: 'mite', name: 'Mite', shape: 'mite', behavior: 'swarm',
    hp: 14, speed: 104, radius: 6, armor: 0, damage: 3, attackRate: 2.2, attackRange: 3,
    ore: 0, essence: 1, xp: 1, color: 0xc46a3a, accent: 0xffb066, cost: 0.6,
    description: 'Fast, brittle, arrives in clouds. Splash weapons shred them.',
  },
  brute: {
    id: 'brute', name: 'Brute', shape: 'brute', behavior: 'brute',
    hp: 260, speed: 38, radius: 17, armor: 4, damage: 26, attackRate: 0.7, attackRange: 8,
    ore: 2, essence: 4, xp: 5, color: 0x6b3f6e, accent: 0xd07dff, cost: 5,
    description: 'Armoured battering ram. Targets your walls first.',
  },
  scorpion: {
    id: 'scorpion', name: 'Sand Scorpion', shape: 'scorpion', behavior: 'charger',
    hp: 130, speed: 58, radius: 14, armor: 3, damage: 16, attackRate: 1.4, attackRange: 6,
    ore: 2, essence: 5, xp: 5, color: 0x7a5a2e, accent: 0xffb347, cost: 5.2,
    abilities: [
      { id: 'charge', cooldown: 7, telegraph: 0.7, value: 380 },
    ],
    description: 'Skitters in at a steady clip, then rears back and stinger-charges the core. The wind-up is your only warning.',
  },
  spitter: {
    id: 'spitter', name: 'Spitter', shape: 'spitter', behavior: 'ranged',
    hp: 58, speed: 48, radius: 11, armor: 1, damage: 11, attackRate: 0.72, attackRange: 190,
    ore: 0, essence: 3, xp: 3, color: 0x3f7a52, accent: 0x7dffa8, cost: 3,
    projectileSpeed: 250, splashRadius: 18,
    description: 'Outranges short turrets. Kill it before it settles in.',
  },
  moth: {
    id: 'moth', name: 'Void Moth', shape: 'moth', behavior: 'flyer',
    hp: 46, speed: 88, radius: 10, armor: 0, damage: 9, attackRate: 1.3, attackRange: 5,
    ore: 0, essence: 2, xp: 2, color: 0x3d5c8c, accent: 0x8fd0ff, cost: 2.4,
    description: 'Flies over walls and terrain. Only anti-air reaches it.',
  },
  wasp: {
    id: 'wasp', name: 'Void Wasp', shape: 'wasp', behavior: 'ranged', flies: true,
    hp: 34, speed: 102, radius: 8, armor: 0, damage: 10, attackRate: 1.0, attackRange: 170,
    ore: 0, essence: 2, xp: 2, color: 0x2a2410, accent: 0xffe066, cost: 2.6,
    projectileSpeed: 260,
    description: 'Flies, and keeps its distance while it stings — the first flier that will not just close and melee you.',
  },
  bomber: {
    id: 'bomber', name: 'Bloater', shape: 'bomber', behavior: 'bomber',
    hp: 74, speed: 70, radius: 13, armor: 0, damage: 62, attackRate: 1, attackRange: 12,
    ore: 0, essence: 3, xp: 3, color: 0x8a7a2c, accent: 0xfff07a, cost: 3.2,
    splashRadius: 76,
    description: 'Detonates on contact. Do not let it reach a turret cluster.',
  },
  burrower: {
    id: 'burrower', name: 'Burrower', shape: 'burrower', behavior: 'burrower',
    hp: 120, speed: 56, radius: 12, armor: 2, damage: 15, attackRate: 1, attackRange: 6,
    ore: 1, essence: 4, xp: 4, color: 0x7a5230, accent: 0xffb066, cost: 4,
    phaseInterval: 4.5,
    description: 'Submerges to slip past walls. Untouchable while burrowed.',
  },
  shaman: {
    id: 'shaman', name: 'Hive Shaman', shape: 'shaman', behavior: 'support',
    hp: 96, speed: 50, radius: 12, armor: 1, damage: 0, attackRate: 0, attackRange: 0,
    ore: 0, essence: 6, xp: 5, color: 0x5d3f8a, accent: 0xc79bff, cost: 4.5,
    auraRadius: 150,
    description: 'Regenerates and hardens everything around it. Priority target.',
  },
  queen: {
    id: 'queen', name: 'Broodmother', shape: 'queen', behavior: 'support',
    hp: 480, speed: 22, radius: 22, armor: 4, damage: 0, attackRate: 0, attackRange: 0,
    ore: 3, essence: 10, xp: 8, color: 0x4a2f5a, accent: 0xd88fff, cost: 7,
    abilities: [
      { id: 'spawn', cooldown: 10, telegraph: 1.1, value: 3 },
    ],
    description: 'Never fights you directly. Every few seconds she vomits fresh broodlings instead — kill her fast or the wave never thins out.',
  },
  blob: {
    id: 'blob', name: 'Splitter', shape: 'blob', behavior: 'splitter',
    hp: 150, speed: 46, radius: 15, armor: 1, damage: 14, attackRate: 0.9, attackRange: 6,
    ore: 1, essence: 4, xp: 4, color: 0x2f7d78, accent: 0x66ffe0, cost: 4,
    splitInto: 'blobling', splitCount: 3,
    description: 'Bursts into three smaller blobs when killed.',
  },
  blobling: {
    id: 'blobling', name: 'Blobling', shape: 'blob', behavior: 'charger',
    hp: 38, speed: 74, radius: 8, armor: 0, damage: 6, attackRate: 1.3, attackRange: 4,
    ore: 0, essence: 1, xp: 1, color: 0x2f7d78, accent: 0x66ffe0, cost: 0,
  },

  /* ---- bosses --------------------------------------------------------- */

  tyrant: {
    id: 'tyrant', name: 'HIVE TYRANT', shape: 'boss', behavior: 'brute',
    hp: 4200, speed: 34, radius: 42, armor: 10, damage: 60, attackRate: 0.6, attackRange: 22,
    ore: 40, essence: 90, xp: 60, color: 0x8c2f4a, accent: 0xff5b7d, cost: 0, boss: true,
    abilities: [
      { id: 'slam', cooldown: 9, telegraph: 1.1, value: 150 },
      { id: 'spawn', cooldown: 14, telegraph: 1.4, value: 7 },
    ],
    description: 'The brood mother. Ground-slams and vomits fresh drones.',
  },
  devourer: {
    id: 'devourer', name: 'THE DEVOURER', shape: 'boss', behavior: 'charger',
    hp: 7600, speed: 46, radius: 40, armor: 12, damage: 72, attackRate: 0.8, attackRange: 20,
    ore: 60, essence: 130, xp: 90, color: 0x2f6b8c, accent: 0x6fd8ff, cost: 0, boss: true,
    abilities: [
      { id: 'charge', cooldown: 8, telegraph: 1.0, value: 520 },
      { id: 'volley', cooldown: 11, telegraph: 0.9, value: 12 },
      { id: 'spawn', cooldown: 17, telegraph: 1.3, value: 9 },
    ],
    description: 'Rams through fortifications and answers walls with a volley.',
  },
  matriarch: {
    id: 'matriarch', name: 'THE MATRIARCH', shape: 'boss', behavior: 'ranged',
    hp: 11800, speed: 30, radius: 46, armor: 16, damage: 44, attackRate: 1.1, attackRange: 300,
    ore: 85, essence: 190, xp: 130, color: 0x5a2f8c, accent: 0xc48fff, cost: 0, boss: true,
    projectileSpeed: 280, splashRadius: 42,
    abilities: [
      { id: 'beam', cooldown: 12, telegraph: 1.5, value: 260 },
      { id: 'shield', cooldown: 20, telegraph: 0.8, value: 2500 },
      { id: 'spawn', cooldown: 13, telegraph: 1.2, value: 11 },
    ],
    description: 'Shields herself and rakes the field with a searing beam.',
  },
  worldeater: {
    id: 'worldeater', name: 'WORLD-EATER', shape: 'boss', behavior: 'brute',
    hp: 14000, speed: 30, radius: 56, armor: 15, damage: 78, attackRate: 0.6, attackRange: 28,
    ore: 140, essence: 300, xp: 220, color: 0x8c5a1f, accent: 0xffc44d, cost: 0, boss: true,
    // Longer cooldowns and clearer telegraphs: the fight is still the hardest in
    // the game, but it gives you room to answer each ability instead of stacking them.
    abilities: [
      { id: 'slam', cooldown: 11, telegraph: 1.3, value: 190 },
      { id: 'charge', cooldown: 15, telegraph: 1.2, value: 560 },
      { id: 'beam', cooldown: 18, telegraph: 1.8, value: 240 },
      { id: 'spawn', cooldown: 16, telegraph: 1.4, value: 9 },
      { id: 'shield', cooldown: 34, telegraph: 1.0, value: 3000 },
    ],
    description: 'Everything the hive has learned, in one body.',
  },
};

export const BOSS_IDS = ['tyrant', 'devourer', 'matriarch', 'worldeater'] as const;

/** Localised display name. English text above is the source of truth and fallback. */
export function enemyName(def: EnemyDef): string {
  return t(`enemy.${def.id}.name`, def.name);
}

/** Localised bestiary/telemetry blurb, when the archetype has one. */
export function enemyDesc(def: EnemyDef): string | undefined {
  return def.description === undefined ? undefined : t(`enemy.${def.id}.desc`, def.description);
}
