import type { BuildingKind } from './buildings';
import { BUILDINGS } from './buildings';
import { t } from '../core/i18n';
import { clamp } from '../core/math';

/**
 * Campaign definition. Each level is a biome with its own palette, terrain
 * generation weights, enemy roster and wave count. The last wave of every
 * level is the boss wave.
 */

export interface Palette {
  /** Deep background wash. */
  void0: number;
  void1: number;
  /** Walkable ground, low → high variation. */
  ground0: number;
  ground1: number;
  /** Solid rock body and its lit edge. */
  rock: number;
  rockLit: number;
  /** Grid line + ambient light tint. */
  grid: number;
  fog: number;
  /** Signature accent for this biome. */
  accent: number;
  oreColor: number;
}

export interface LevelDef {
  id: number;
  name: string;
  subtitle: string;
  biome: string;
  seed: number;
  width: number;         // tiles
  height: number;        // tiles
  waves: number;         // total, including the boss wave
  boss: string;          // enemy id
  roster: string[];      // enemy ids that can appear
  /** Multiplies enemy hp/damage on top of the per-wave ramp. */
  difficulty: number;
  startOre: number;
  startEssence: number;
  /** Buildings available from wave 1; the rest unlock via tech cards. */
  unlocked: BuildingKind[];
  /** Terrain generator knobs. */
  rockDensity: number;
  oreNodes: number;
  richNodes: number;
  spawnPoints: number;
  /** Seconds of build time before wave 1 and between waves. */
  prepTime: number;
  buildTime: number;
  palette: Palette;
  briefing: string;
}

/**
 * One palette per biome, keyed by `LevelDef.biome`. Pulled out of the campaign
 * entries below so a biome can be picked on its own — needed for the custom
 * skirmish map, which is not tied to any single campaign sector.
 */
export const PALETTES: Record<string, Palette> = {
  ash: {
    void0: 0x0a0a0f, void1: 0x14121a,
    ground0: 0x24222c, ground1: 0x312d3a,
    rock: 0x171520, rockLit: 0x4a4358,
    grid: 0x3a3448, fog: 0x0d0b12,
    accent: 0xff8a5c, oreColor: 0x7fd9ff,
  },
  jungle: {
    void0: 0x040a08, void1: 0x0b1712,
    ground0: 0x16281f, ground1: 0x1f3a2b,
    rock: 0x0d1a14, rockLit: 0x2f5c42,
    grid: 0x2c5540, fog: 0x081310,
    accent: 0x7dffa8, oreColor: 0x9ff0ff,
  },
  ice: {
    void0: 0x040810, void1: 0x0a1524,
    ground0: 0x152437, ground1: 0x1e3550,
    rock: 0x0c1626, rockLit: 0x3a6494,
    grid: 0x2f5680, fog: 0x081220,
    accent: 0x7fd9ff, oreColor: 0xc0f0ff,
  },
  desert: {
    void0: 0x100a06, void1: 0x1e150c,
    ground0: 0x3a2d1c, ground1: 0x4e3d27,
    rock: 0x241a10, rockLit: 0x6e5533,
    grid: 0x5c4830, fog: 0x150e08,
    accent: 0xffc44d, oreColor: 0x8fe8ff,
  },
  blood: {
    void0: 0x0e0407, void1: 0x1c070e,
    ground0: 0x2e1119, ground1: 0x421823,
    rock: 0x1a070d, rockLit: 0x6b2436,
    grid: 0x5c2030, fog: 0x120509,
    accent: 0xff5b7d, oreColor: 0xffb0c4,
  },
  void: {
    void0: 0x07040e, void1: 0x120a24,
    ground0: 0x1d1436, ground1: 0x281c4a,
    rock: 0x120a24, rockLit: 0x4a2f80,
    grid: 0x513a8c, fog: 0x0c0618,
    accent: 0xc48fff, oreColor: 0xd4b0ff,
  },
};

/** Terrain density that made each biome feel distinct — reused for skirmish maps. */
const BIOME_ROCK_DENSITY: Record<string, number> = {
  ash: 0.16, jungle: 0.22, ice: 0.27, desert: 0.12, blood: 0.2, void: 0.18,
};

export const BIOME_IDS = ['ash', 'jungle', 'ice', 'desert', 'blood', 'void'] as const;
export type BiomeId = (typeof BIOME_IDS)[number];

/** Localised biome display name, for the skirmish picker. */
export function biomeLabel(id: BiomeId): string {
  const fallback: Record<BiomeId, string> = {
    ash: 'Ashfall', jungle: 'Verdant Rot', ice: 'Glacier', desert: 'Salt Wastes',
    blood: 'Necrotide', void: 'Hive Throat',
  };
  return t(`biome.${id}`, fallback[id]);
}

export const LEVELS: LevelDef[] = [
  {
    id: 0,
    name: 'Ashfall Basin',
    subtitle: 'Sector 01 · Orientation',
    biome: 'ash',
    seed: 0x51a3f1,
    width: 84, height: 62,
    waves: 8,
    boss: 'tyrant',
    roster: ['crawler', 'mite', 'crawler', 'spitter'],
    difficulty: 1,
    startOre: 220, startEssence: 0,
    unlocked: ['wall', 'turret', 'generator', 'extractor'],
    rockDensity: 0.16, oreNodes: 14, richNodes: 2, spawnPoints: 2,
    prepTime: 60, buildTime: 22,
    palette: PALETTES.ash,
    briefing: 'A dead volcanic pan. The hive has not noticed us yet. Sink an extractor, ring the core with autoguns, and learn the rhythm before the Tyrant wakes.',
  },
  {
    id: 1,
    name: 'Verdant Rot',
    subtitle: 'Sector 04 · Infested Canopy',
    biome: 'jungle',
    seed: 0x2f8b41,
    width: 92, height: 68,
    waves: 10,
    boss: 'devourer',
    roster: ['crawler', 'mite', 'spitter', 'moth', 'bomber'],
    difficulty: 1.28,
    startOre: 260, startEssence: 30,
    unlocked: ['wall', 'turret', 'generator', 'extractor', 'dronebay', 'flak', 'pulselaser'],
    rockDensity: 0.22, oreNodes: 16, richNodes: 3, spawnPoints: 3,
    prepTime: 55, buildTime: 24,
    palette: PALETTES.jungle,
    briefing: 'Fungal overgrowth, and the first fliers. Walls mean nothing to a Void Moth — put flak up early or the Devourer will arrive to an undefended core.',
  },
  {
    id: 2,
    name: 'Glacier Vein',
    subtitle: 'Sector 09 · Frozen Shelf',
    biome: 'ice',
    seed: 0x77c4ff,
    width: 98, height: 72,
    waves: 11,
    boss: 'matriarch',
    roster: ['crawler', 'mite', 'brute', 'moth', 'burrower', 'spitter'],
    difficulty: 1.62,
    startOre: 300, startEssence: 60,
    unlocked: ['wall', 'turret', 'generator', 'extractor', 'dronebay', 'flak', 'pulselaser',
      'cannon', 'tesla', 'rocket'],
    rockDensity: 0.27, oreNodes: 18, richNodes: 4, spawnPoints: 3,
    prepTime: 55, buildTime: 26,
    palette: PALETTES.ice,
    briefing: 'Burrowers use the ice tunnels to bypass anything you build. Layered defence, not a single wall — and watch the Matriarch\'s shield timing.',
  },
  {
    id: 3,
    name: 'The Salt Wastes',
    subtitle: 'Sector 12 · Open Ground',
    biome: 'desert',
    seed: 0xd4a24c,
    width: 104, height: 76,
    waves: 12,
    boss: 'tyrant',
    roster: ['crawler', 'mite', 'brute', 'bomber', 'spitter', 'blob', 'scorpion', 'moth', 'wasp'],
    difficulty: 2.05,
    startOre: 340, startEssence: 90,
    unlocked: ['wall', 'turret', 'generator', 'extractor', 'dronebay', 'flak', 'pulselaser',
      'cannon', 'tesla', 'rocket', 'mortar'],
    rockDensity: 0.12, oreNodes: 20, richNodes: 5, spawnPoints: 4,
    prepTime: 50, buildTime: 26,
    palette: PALETTES.desert,
    briefing: 'Almost no cover and four spawn gates. You will not out-wall this one — build kill zones with mortars and keep the reactors far from the front.',
  },
  {
    id: 4,
    name: 'Necrotide',
    subtitle: 'Sector 17 · The Bleeding Coast',
    biome: 'blood',
    seed: 0x8c2f4a,
    width: 108, height: 78,
    waves: 13,
    boss: 'matriarch',
    roster: ['crawler', 'mite', 'brute', 'bomber', 'spitter', 'blob', 'scorpion', 'moth', 'wasp', 'burrower', 'shaman', 'queen'],
    difficulty: 2.6,
    startOre: 380, startEssence: 130,
    unlocked: ['wall', 'turret', 'generator', 'extractor', 'dronebay', 'flak', 'pulselaser',
      'cannon', 'tesla', 'rocket', 'mortar', 'laser', 'repairbay'],
    rockDensity: 0.2, oreNodes: 20, richNodes: 6, spawnPoints: 4,
    prepTime: 50, buildTime: 28,
    palette: PALETTES.blood,
    briefing: 'Shamans are here. They regenerate everything around them faster than an autogun can chew through it — snipe the support or nothing else lands.',
  },
  {
    id: 5,
    name: 'The Hive Throat',
    subtitle: 'Sector 00 · Origin',
    biome: 'void',
    seed: 0x6f2fd4,
    width: 112, height: 82,
    waves: 15,
    boss: 'worldeater',
    roster: ['crawler', 'mite', 'brute', 'bomber', 'spitter', 'blob', 'scorpion', 'moth', 'wasp', 'burrower', 'shaman', 'queen'],
    difficulty: 3.4,
    startOre: 450, startEssence: 200,
    unlocked: ['wall', 'turret', 'generator', 'extractor', 'dronebay', 'rocket', 'cannon',
      'tesla', 'flak', 'pulselaser', 'laser', 'mortar', 'repairbay', 'shield', 'forcefield'],
    rockDensity: 0.18, oreNodes: 22, richNodes: 8, spawnPoints: 5,
    prepTime: 60, buildTime: 28,
    palette: PALETTES.void,
    briefing: 'Where it all comes from. Five gates, no mercy, and the World-Eater at the end of it. Everything you have unlocked, you will need.',
  },
];

/** Every enemy id used by at least one campaign roster — pre-tuned, safe direct
 *  spawns. Deliberately excludes ids that only ever appear as a side-effect
 *  (e.g. `blobling`, spawned by a splitter dying) — the wave director assumes
 *  a roster entry has a real `cost` to spend budget against, and a free
 *  ride-along can stall its spend loop. */
const FULL_ROSTER = [...new Set(LEVELS.flatMap((l) => l.roster))];

/* -------------------------------------------------------------------------- */
/* New Game+                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * NG+ difficulty multiplier for tier 1-10, applied on top of a sector's own
 * `difficulty`. Tier 1 is exactly the base game — nothing changes until a
 * player opts in. Since `difficulty` already drives both enemy hp/damage
 * (`waveScaling`) and enemy count (`waveBudget`), scaling it is the entire
 * implementation: no separate count/strength knobs to keep in sync.
 */
export function ngDifficultyMult(tier: number): number {
  return 1 + (clamp(Math.round(tier), 1, 10) - 1) * 0.18;
}

/* -------------------------------------------------------------------------- */
/* Skirmish (custom battle)                                                    */
/* -------------------------------------------------------------------------- */

export const SKIRMISH_SIZES = ['small', 'medium', 'large', 'huge'] as const;
export type SkirmishSize = (typeof SKIRMISH_SIZES)[number];

const SKIRMISH_DIMENSIONS: Record<SkirmishSize, { width: number; height: number }> = {
  small: { width: 70, height: 54 },
  medium: { width: 92, height: 68 },
  large: { width: 108, height: 78 },
  huge: { width: 124, height: 90 },
};

/** Localised size label for the skirmish picker. */
export function skirmishSizeLabel(size: SkirmishSize): string {
  const fallback: Record<SkirmishSize, string> = {
    small: 'Small', medium: 'Medium', large: 'Large', huge: 'Huge',
  };
  return t(`skirmish.size.${size}`, fallback[size]);
}

export interface SkirmishConfig {
  size: SkirmishSize;
  biome: BiomeId;
  /** 1-10, same curve and meaning as NG+ — see `ngDifficultyMult`. */
  difficultyTier: number;
  gates: number;
}

/** Boss toughness climbs with the chosen difficulty, same as picking a later sector would. */
function bossForTier(tier: number): string {
  if (tier <= 3) return 'tyrant';
  if (tier <= 6) return 'devourer';
  if (tier <= 8) return 'matriarch';
  return 'worldeater';
}

/**
 * Builds a one-off `LevelDef` from a player-chosen configuration instead of
 * picking one of the fixed campaign sectors. `id: -1` marks it as not a real
 * sector — `Game.startLevel` and the progress/save code both treat that as
 * "do not touch campaign or endless-best records for this run."
 */
export function makeSkirmishLevel(cfg: SkirmishConfig): LevelDef {
  const { width, height } = SKIRMISH_DIMENSIONS[cfg.size];
  const gates = clamp(Math.round(cfg.gates), 1, 6);
  const difficulty = ngDifficultyMult(cfg.difficultyTier);
  const area = width * height;
  return {
    id: -1,
    name: t('skirmish.name', 'Custom Battle'),
    subtitle: t('skirmish.subtitle', '{size} · {biome}',
      { size: skirmishSizeLabel(cfg.size), biome: biomeLabel(cfg.biome) }),
    biome: cfg.biome,
    // Any fixed salt works: the actual map comes from the run seed XORed with
    // this, and the run seed is what varies between attempts.
    seed: 0x5c1121 ^ (cfg.gates * 0x1000) ^ Math.round(difficulty * 1000),
    width, height,
    waves: 10,
    boss: bossForTier(cfg.difficultyTier),
    roster: FULL_ROSTER,
    difficulty,
    startOre: 400, startEssence: 150,
    unlocked: Object.keys(BUILDINGS) as BuildingKind[],
    rockDensity: BIOME_ROCK_DENSITY[cfg.biome] ?? 0.2,
    oreNodes: Math.round(area / 380),
    richNodes: Math.round(area / 1400),
    spawnPoints: gates,
    prepTime: 55, buildTime: 26,
    palette: PALETTES[cfg.biome],
    briefing: t('skirmish.briefing',
      'A custom deployment — your size, your biome, your difficulty. No campaign progress rides on this one; just the fight.'),
  };
}

/** Localised display name. English text above is the source of truth and fallback. */
export function levelName(lv: LevelDef): string {
  return t(`level.${lv.id}.name`, lv.name);
}

/** Localised sector/biome subtitle line. */
export function levelSubtitle(lv: LevelDef): string {
  return t(`level.${lv.id}.subtitle`, lv.subtitle);
}

/** Localised deployment briefing paragraph. */
export function levelBriefing(lv: LevelDef): string {
  return t(`level.${lv.id}.briefing`, lv.briefing);
}

/** Wave composition weights ramp across a level: early waves lean on tier-1. */
export function waveBudget(level: LevelDef, wave: number): number {
  const t = wave / Math.max(1, level.waves - 1);
  const base = 9 + wave * wave * 0.78 + wave * 5.2;
  return base * (0.85 + t * 0.5) * level.difficulty;
}

/** Multiplier applied to enemy hp and damage for a given wave. */
export function waveScaling(level: LevelDef, wave: number): { hp: number; dmg: number } {
  const t = wave / Math.max(1, level.waves - 1);
  return {
    hp: (1 + t * 1.5) * level.difficulty,
    dmg: (1 + t * 0.85) * (0.7 + level.difficulty * 0.3),
  };
}

/* -------------------------------------------------------------------------- */
/* Endless                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Endless mode cannot reuse the campaign curves: those normalise the wave index
 * against `level.waves`, so once you pass the last scripted wave the ramp keeps
 * accelerating off a cliff. These are functions of the raw wave number with
 * deliberately decelerating growth, so the run stays readable for a long time
 * and eventually — but not abruptly — becomes unwinnable.
 */

/** A boss shows up on every Nth endless wave. */
export const ENDLESS_BOSS_INTERVAL = 10;

export function endlessBudget(level: LevelDef, wave: number): number {
  // Quadratic term is gentler than the campaign's, because there is no end.
  const base = 12 + wave * wave * 0.42 + wave * 6.5;
  return base * (0.75 + level.difficulty * 0.25);
}

export function endlessScaling(level: LevelDef, wave: number): { hp: number; dmg: number } {
  const decades = wave / ENDLESS_BOSS_INTERVAL;
  return {
    // Linear in "decades": at wave 50 enemies have ~5x hp, at wave 100 ~10x.
    hp: (1 + decades * 0.9) * level.difficulty,
    // Damage grows slower than hp, so the fight gets long before it gets lethal.
    dmg: (1 + decades * 0.4) * (0.7 + level.difficulty * 0.3),
  };
}

/** Wave window grows with the budget so spawn density stays manageable. */
export function endlessDuration(wave: number): number {
  return 18 + Math.min(46, wave * 1.4);
}

export function isEndlessBossWave(wave: number): boolean {
  return wave > 0 && (wave + 1) % ENDLESS_BOSS_INTERVAL === 0;
}
