import { Rng } from '../core/math';
import { ENEMIES } from '../data/enemies';
import type { LevelDef } from '../data/levels';
import {
  endlessBudget, endlessDuration, endlessScaling, isEndlessBossWave,
  waveBudget, waveScaling,
} from '../data/levels';
import { BOSS_IDS } from '../data/enemies';

export type Phase = 'prep' | 'incoming' | 'combat' | 'cleared' | 'boss' | 'won' | 'lost';

export interface SpawnOrder {
  enemyId: string;
  /** Index into world.spawns. */
  gate: number;
  /** Seconds from the start of the wave. */
  at: number;
  elite: boolean;
}

export interface WavePlan {
  index: number;
  isBoss: boolean;
  orders: SpawnOrder[];
  duration: number;
  hpMult: number;
  dmgMult: number;
  /** Preview shown during the build phase. */
  composition: { id: string; count: number }[];
}

/**
 * Builds a wave from a threat budget.
 *
 * The budget is spent on roster entries weighted by how "late" they feel — the
 * roster is ordered from chaff to elite in the level definition, and the
 * director biases toward the back of that list as waves progress. Elites are
 * upgraded copies (1.9x hp, gold trim) that start appearing past the midpoint.
 */
export class WaveDirector {
  private rng: Rng;
  private level: LevelDef;
  private gates: number;
  private endless: boolean;

  constructor(level: LevelDef, gates: number, seed: number, endless = false) {
    this.level = level;
    this.gates = Math.max(1, gates);
    this.rng = new Rng(seed);
    this.endless = endless;
  }

  /**
   * Replays and discards the plans for earlier waves.
   *
   * The director's RNG advances with every `plan()` call, so resuming a saved run
   * at wave N has to walk the sequence to N rather than jumping — otherwise the
   * resumed wave is a different roll from the one the player was promised.
   */
  fastForwardTo(waveIndex: number) {
    for (let i = 0; i < waveIndex && i < 400; i++) this.plan(i);
  }

  plan(waveIndex: number): WavePlan {
    const lvl = this.level;
    const isBoss = this.endless
      ? isEndlessBossWave(waveIndex)
      : waveIndex >= lvl.waves - 1;
    const { hp, dmg } = this.endless
      ? endlessScaling(lvl, waveIndex)
      : waveScaling(lvl, waveIndex);
    const budget = this.endless ? endlessBudget(lvl, waveIndex) : waveBudget(lvl, waveIndex);
    const orders: SpawnOrder[] = [];

    if (isBoss) {
      // A boss arrives alone at first, with an escort trickling in behind.
      const gate = this.rng.int(0, this.gates - 1);
      orders.push({ enemyId: this.bossFor(waveIndex), gate, at: 1.2, elite: false });

      this.spend(budget * 0.55, waveIndex, orders, 4, 34);
      const duration = this.endless ? 46 : 40;
      return {
        index: waveIndex, isBoss, orders, duration,
        hpMult: hp, dmgMult: dmg,
        composition: this.summarise(orders),
      };
    }

    const duration = this.endless
      ? endlessDuration(waveIndex)
      : 16 + Math.min(26, waveIndex * 1.9);
    this.spend(budget, waveIndex, orders, 0, duration);
    orders.sort((a, b) => a.at - b.at);

    return {
      index: waveIndex, isBoss, orders, duration,
      hpMult: hp, dmgMult: dmg,
      composition: this.summarise(orders),
    };
  }

  /** Campaign uses the sector's own boss; endless cycles the whole roster. */
  bossFor(waveIndex: number): string {
    if (!this.endless) return this.level.boss;
    const n = Math.floor((waveIndex + 1) / 10) - 1;
    return BOSS_IDS[Math.max(0, n) % BOSS_IDS.length];
  }

  private spend(
    budget: number,
    waveIndex: number,
    out: SpawnOrder[],
    tStart: number,
    tEnd: number,
  ) {
    const lvl = this.level;
    const progress = waveIndex / Math.max(1, lvl.waves - 1);
    const roster = lvl.roster.filter((id) => ENEMIES[id]);
    if (!roster.length) return;

    // Weight later roster entries more heavily as the level progresses.
    const weights = roster.map((_, i) => {
      const rel = roster.length === 1 ? 0 : i / (roster.length - 1);
      const bias = 1 - Math.abs(rel - progress * 1.15);
      return Math.max(0.08, bias) ** 2;
    });
    const totalW = weights.reduce((a, b) => a + b, 0);

    // Squads: spawning in clumps from one gate reads far better than a drip.
    let spent = 0;
    let guard = 0;
    while (spent < budget && guard++ < 400) {
      let r = this.rng.next() * totalW;
      let pickIdx = 0;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) { pickIdx = i; break; }
      }
      const def = ENEMIES[roster[pickIdx]];
      const squad = Math.max(1, Math.round(this.rng.range(2, 6) / Math.max(0.6, def.cost * 0.5)));
      const gate = this.rng.int(0, this.gates - 1);
      const t0 = this.rng.range(tStart, Math.max(tStart + 0.5, tEnd));

      for (let i = 0; i < squad && spent < budget; i++) {
        const elite = progress > 0.45 && this.rng.chance(0.06 + progress * 0.1);
        out.push({
          enemyId: def.id,
          gate,
          at: t0 + i * this.rng.range(0.12, 0.42),
          elite,
        });
        spent += def.cost * (elite ? 2 : 1);
      }
    }
    out.sort((a, b) => a.at - b.at);
  }

  private summarise(orders: SpawnOrder[]) {
    const counts = new Map<string, number>();
    for (const o of orders) counts.set(o.enemyId, (counts.get(o.enemyId) ?? 0) + 1);
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count);
  }
}
