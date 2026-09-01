import { ACHIEVEMENTS, type AchievementDef, type StatEvent } from '../data/achievements';
import { applyPerk, basePerks, type Perks } from '../data/perks';
import { RELIC_UPGRADES, UPGRADES_BY_ID, upgradeCost, type RelicUpgrade } from '../data/relicUpgrades';
import { loadSave, saveGame, saveNow, type SaveData } from '../core/save';

export interface UnlockNotice {
  def: AchievementDef;
}

/**
 * Owns the persistent profile: achievement counters, unlock checks and the
 * permanent perk bag derived from them. The simulation only ever calls
 * `bump()`; everything else (saving, unlocking, notifying) happens here.
 */
export class Progress {
  data: SaveData;
  /** Perks granted purely by unlocked achievements — the run's starting point. */
  perks: Perks;
  /** Drained by the UI each frame to raise toasts. */
  pending: UnlockNotice[] = [];

  private byTrack = new Map<StatEvent, AchievementDef[]>();

  constructor() {
    this.data = loadSave();
    for (const a of ACHIEVEMENTS) {
      const list = this.byTrack.get(a.track);
      if (list) list.push(a);
      else this.byTrack.set(a.track, [a]);
    }
    this.perks = this.computePerks();
  }

  isUnlocked(id: string) { return this.data.unlocked.includes(id); }

  progressOf(a: AchievementDef) {
    return Math.min(a.goal, this.data.achievements[a.id] ?? 0);
  }

  computePerks(): Perks {
    const p = basePerks();
    // Two permanent sources, one funnel: earned achievements and bought upgrades.
    for (const a of ACHIEVEMENTS) {
      if (this.isUnlocked(a.id)) applyPerk(p, a.perk);
    }
    for (const u of RELIC_UPGRADES) {
      const rank = this.rankOf(u.id);
      for (let i = 0; i < rank; i++) applyPerk(p, u.perRank);
    }
    return p;
  }

  /* ---- relic economy --------------------------------------------------- */

  get relics() { return this.data.relics; }

  rankOf(id: string) {
    const u = UPGRADES_BY_ID.get(id);
    if (!u) return 0;
    return Math.min(u.maxRank, this.data.relicUpgrades[id] ?? 0);
  }

  isMaxed(u: RelicUpgrade) { return this.rankOf(u.id) >= u.maxRank; }

  /** Relics for the next rank, or null when it is already maxed. */
  nextCost(u: RelicUpgrade): number | null {
    const rank = this.rankOf(u.id);
    return rank >= u.maxRank ? null : upgradeCost(u, rank);
  }

  canBuy(u: RelicUpgrade) {
    const cost = this.nextCost(u);
    return cost !== null && this.data.relics >= cost;
  }

  /** Buys one rank. Returns false when maxed or unaffordable. */
  buyUpgrade(id: string): boolean {
    const u = UPGRADES_BY_ID.get(id);
    if (!u) return false;
    const cost = this.nextCost(u);
    if (cost === null || this.data.relics < cost) return false;
    this.data.relics -= cost;
    this.data.relicUpgrades[id] = this.rankOf(id) + 1;
    this.perks = this.computePerks();
    // A purchase is a deliberate, irreversible spend — commit it at once.
    saveNow(this.data);
    return true;
  }

  /** Refunds every rank at full value. Cheap to offer and encourages experiments. */
  respec(): number {
    let refund = 0;
    for (const u of RELIC_UPGRADES) {
      const rank = this.rankOf(u.id);
      for (let r = 0; r < rank; r++) refund += upgradeCost(u, r);
    }
    if (refund <= 0) return 0;
    this.data.relicUpgrades = {};
    this.data.relics += refund;
    this.perks = this.computePerks();
    saveNow(this.data);
    return refund;
  }

  awardRelics(n: number) {
    if (n <= 0) return;
    this.data.relics += n;
    this.data.relicsEarned += n;
    saveGame(this.data);
  }

  get spentRelics() {
    let sum = 0;
    for (const u of RELIC_UPGRADES) {
      const rank = this.rankOf(u.id);
      for (let r = 0; r < rank; r++) sum += upgradeCost(u, r);
    }
    return sum;
  }

  /**
   * Record `n` occurrences of an event. Counters that track a *maximum*
   * (best wave, peak power) pass `mode: 'max'` so they don't accumulate.
   */
  bump(event: StatEvent, n = 1, mode: 'add' | 'max' = 'add') {
    const list = this.byTrack.get(event);
    if (!list) return;
    for (const a of list) {
      const cur = this.data.achievements[a.id] ?? 0;
      if (cur >= a.goal) continue;
      const next = mode === 'max' ? Math.max(cur, n) : cur + n;
      this.data.achievements[a.id] = next;
      if (next >= a.goal) this.unlock(a);
    }
    saveGame(this.data);
  }

  private unlock(a: AchievementDef) {
    if (this.data.unlocked.includes(a.id)) return;
    this.data.unlocked.push(a.id);
    const bounty = a.tier === 'platinum' ? 5 : a.tier === 'gold' ? 3 : a.tier === 'silver' ? 2 : 1;
    this.data.relics += bounty;
    this.data.relicsEarned += bounty;
    this.perks = this.computePerks();
    this.pending.push({ def: a });
    // An achievement is a permanent reward — never risk it to a queued write.
    saveNow(this.data);
  }

  /** Mirrors run outcomes into the lifetime stat block shown on the menu. */
  recordRunStat<K extends keyof SaveData['stats']>(key: K, value: number, mode: 'add' | 'max' = 'add') {
    const s = this.data.stats;
    s[key] = mode === 'max' ? Math.max(s[key], value) : s[key] + value;
    saveGame(this.data);
  }

  /**
   * Records a cleared sector, unlocking the next one. Written synchronously:
   * this is the single most important thing in the profile, and the player may
   * well close the tab straight off the victory screen.
   */
  markLevelCleared(levelIndex: number) {
    if (levelIndex > this.data.highestLevel) {
      this.data.highestLevel = levelIndex;
      saveNow(this.data);
    }
  }

  /**
   * Relics paid out for clearing a sector, scaling with how deep it is. This is
   * the main income stream — achievements alone did not supply enough to make a
   * shop worth opening.
   */
  awardSectorClear(levelIndex: number): number {
    const n = 3 + levelIndex * 2;
    this.data.relics += n;
    this.data.relicsEarned += n;
    saveNow(this.data);
    return n;
  }

  /* ---- endless records ------------------------------------------------- */

  endlessBest(levelIndex: number) {
    return this.data.endlessBest[String(levelIndex)] ?? 0;
  }

  get endlessBestOverall() {
    let best = 0;
    for (const v of Object.values(this.data.endlessBest)) best = Math.max(best, v);
    return best;
  }

  /** Banks an endless result. `waves` is the number of waves fully survived. */
  recordEndlessResult(levelIndex: number, waves: number) {
    const key = String(levelIndex);
    const prev = this.data.endlessBest[key] ?? 0;
    const isRecord = waves > prev;
    if (isRecord) this.data.endlessBest[key] = waves;
    this.recordRunStat('bestWave', waves, 'max');
    saveNow(this.data);
    return { waves, best: Math.max(prev, waves), isRecord };
  }

  /**
   * Endless payout. Scales with depth so a deep run is worth more than several
   * shallow ones, which is what stops it being a mindless farm.
   */
  awardEndlessRelics(waves: number) {
    const n = Math.floor(waves / 3) + Math.floor(waves / 10) * 2;
    if (n > 0) this.awardRelics(n);
    return n;
  }

  /**
   * Skirmish payout. There is no sector index to scale off (see
   * `awardSectorClear`), so it scales with the difficulty the player dialled
   * in instead — a harder custom battle pays out more.
   */
  awardSkirmishRelics(difficultyMult: number): number {
    const n = Math.round(3 + difficultyMult * 2);
    this.awardRelics(n);
    return n;
  }

  /** Highest sector the player may deploy to: the one after their best clear. */
  get furthestUnlockedLevel() {
    return this.data.highestLevel + 1;
  }

  canPlayLevel(index: number) {
    return index <= this.furthestUnlockedLevel;
  }

  get sectorsCleared() {
    return this.data.highestLevel + 1;
  }

  get unlockedCount() { return this.data.unlocked.length; }
  get totalCount() { return ACHIEVEMENTS.length; }
}
