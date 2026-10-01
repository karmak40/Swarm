import { heatMult } from './mutators';

/**
 * Score and XP for a finished run. Kept pure so the results screen, the
 * records board and the tests all agree on one definition.
 *
 * Score = waves × 1000 + kills (+ a speed bonus on a win), scaled by heat.
 * Waves dominate on purpose — surviving deeper always beats farming kills —
 * and the time term only exists for runs that can actually be won, where
 * finishing faster is the interesting thing to chase.
 */

export interface RunOutcome {
  /** Waves fully survived (endless), or the sector's wave count on a win. */
  waves: number;
  kills: number;
  seconds: number;
  won: boolean;
  mutators: readonly string[];
}

export const WAVE_POINTS = 1000;
/** A win earns one point per second under this many. */
export const SPEED_BONUS_CEILING = 3600;

export function baseScore(o: Pick<RunOutcome, 'waves' | 'kills' | 'seconds' | 'won'>): number {
  const speed = o.won ? Math.max(0, SPEED_BONUS_CEILING - Math.round(o.seconds)) : 0;
  return Math.max(0, o.waves) * WAVE_POINTS + Math.max(0, o.kills) + speed;
}

export function runScore(o: RunOutcome): number {
  return Math.round(baseScore(o) * heatMult(o.mutators));
}

/** Commander XP for a run: depth first, kills a little, a win and a daily on top. */
export function runXp(o: RunOutcome & { daily: boolean }): number {
  const raw = o.waves * 10 + Math.floor(o.kills / 10) + (o.won ? 100 : 0) + (o.daily ? 50 : 0);
  return Math.round(raw * heatMult(o.mutators));
}
