import { Rng } from '../core/math';
import { LEVELS } from './levels';
import { MUTATORS } from './mutators';

/**
 * The daily challenge: one shared endless run per UTC day.
 *
 * Everything — sector, map seed, the two mutators — derives from the date
 * string alone, so every player on the same day fights the same map with the
 * same handicaps and scores are comparable. No server is involved.
 */

export interface DailyChallenge {
  /** UTC date, `YYYY-MM-DD`. */
  key: string;
  seed: number;
  levelIndex: number;
  mutators: string[];
}

/** How many mutators a daily always stacks. */
export const DAILY_MUTATORS = 2;

export function dailyKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** FNV-1a: small, stable across platforms, and good enough to spread date strings. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function dailyChallenge(key: string): DailyChallenge {
  const seed = hash('swarm-daily:' + key);
  const rng = new Rng(seed ^ 0x51ed270b);
  const levelIndex = rng.int(0, LEVELS.length - 1);
  const pool = MUTATORS.map((m) => m.id);
  const mutators: string[] = [];
  while (mutators.length < DAILY_MUTATORS) {
    const pick = pool.splice(rng.int(0, pool.length - 1), 1)[0];
    mutators.push(pick);
  }
  return { key, seed, levelIndex, mutators };
}

const DAY_MS = 86_400_000;

/** Whole days from `a` to `b` (both `YYYY-MM-DD`); 1 means `b` is the next day. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}
