import type { BoardId } from '../core/save';
import { totalHeat, heatMult } from '../data/mutators';
import { runScore, runXp } from '../data/scoring';
import type { Game } from './game';

/**
 * What a finished run is worth: its score, where that lands on a records
 * board, the commander XP it paid and — for a daily — the streak bookkeeping.
 * Computed once when the run ends and read by the results screens.
 */
export interface RunResult {
  won: boolean;
  score: number;
  /** Heat points the run carried (0 = no mutators). */
  heat: number;
  /** Score/XP/relic multiplier that heat produced. */
  mult: number;
  /** Which board the run was filed on; null when it does not qualify (a lost campaign sector). */
  board: BoardId | null;
  /** 1-based place on that board, or null if it missed the top. */
  place: number | null;
  xp: { gained: number; before: number; after: number; relics: number };
  daily: { key: string; first: boolean; newBest: boolean; streak: number; relics: number } | null;
}

/** Banks a finished run into the profile. Call exactly once, when the run ends. */
export function finalizeRun(g: Game, won: boolean): RunResult {
  const progress = g.progress;
  // A win means the whole sector was held; a loss counts waves actually survived.
  const waves = won ? g.level.waves : g.waveIndex;
  const outcome = {
    waves, kills: g.runStats.kills, seconds: g.runStats.timeSeconds, won, mutators: g.mutators,
  };
  const score = runScore(outcome);

  const board: BoardId | null = g.daily ? 'daily'
    : g.mode === 'endless' ? 'endless'
      : won && g.mode === 'campaign' ? 'campaign'
        : won && g.mode === 'skirmish' ? 'skirmish'
          : null;

  const place = board ? progress.submitRecord(board, {
    score, waves, kills: outcome.kills, seconds: Math.round(outcome.seconds),
    level: g.levelIndex, heat: totalHeat(g.mutators), date: Date.now(), seed: g.runSeed,
    ...(g.daily ? { day: g.daily.key } : {}),
  }) : null;

  const daily = g.daily ? { key: g.daily.key, ...progress.recordDailyRun(g.daily.key, score) } : null;
  const xp = progress.awardXp(runXp({ ...outcome, daily: !!g.daily }));

  return { won, score, heat: totalHeat(g.mutators), mult: heatMult(g.mutators), board, place, xp, daily };
}
