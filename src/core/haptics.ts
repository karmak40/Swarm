/**
 * Event haptics: short vibration cues for things happening in the world —
 * a wave arriving, the boss, the core under fire, the run ending.
 *
 * Button taps buzz on their own in TouchInput; this is only for events the
 * player didn't cause, which is exactly why it is rate-limited so hard. A
 * swarm chewing on the core can land hits every frame, and a phone that
 * never stops buzzing is worse than one that never buzzes at all:
 *
 * - every event has its own cooldown (the core-hit cue at most every few
 *   seconds, however many hits land);
 * - any two event buzzes are at least MIN_GAP apart;
 * - at most BUDGET event buzzes in any WINDOW seconds.
 *
 * Only the few events that must never be missed (boss, defeat, victory)
 * skip the gap and the budget — never their own cooldown.
 */

export type HapticEvent = 'coreHit' | 'waveStart' | 'coreCritical' | 'boss' | 'defeat' | 'victory';

interface Spec {
  /** A duration in ms, or an on/off/on… pattern. */
  pattern: number | number[];
  /** Minimum seconds between two buzzes of this event. */
  cooldown: number;
  /** Ignores MIN_GAP and the rolling budget. */
  urgent?: boolean;
}

const SPECS: Record<HapticEvent, Spec> = {
  coreHit: { pattern: 25, cooldown: 5 },
  waveStart: { pattern: [40, 70, 40], cooldown: 5 },
  coreCritical: { pattern: [70, 50, 70], cooldown: 20 },
  boss: { pattern: [90, 60, 160], cooldown: 20, urgent: true },
  defeat: { pattern: 220, cooldown: 5, urgent: true },
  victory: { pattern: [30, 50, 30, 50, 70], cooldown: 5, urgent: true },
};

/** Seconds between any two non-urgent event buzzes. */
const MIN_GAP = 1.2;
/** At most BUDGET non-urgent buzzes in any WINDOW seconds. */
const WINDOW = 15;
const BUDGET = 4;

export class HapticDirector {
  /** Off on desktop, or with the Haptics setting off. */
  enabled = true;
  private lastBy = new Map<HapticEvent, number>();
  private lastAny = -Infinity;
  private recent: number[] = [];

  /**
   * `vibrate` and `now` (seconds) are injected so the smoke test can drive
   * this with a fake clock; the game passes navigator.vibrate and
   * performance.now.
   */
  constructor(
    private readonly vibrate: (pattern: number | number[]) => void,
    private readonly now: () => number,
  ) {}

  /** Buzzes for `event` if the limits allow. Returns whether it did. */
  fire(event: HapticEvent): boolean {
    if (!this.enabled) return false;
    const spec = SPECS[event];
    const t = this.now();
    if (t - (this.lastBy.get(event) ?? -Infinity) < spec.cooldown) return false;

    while (this.recent.length && t - this.recent[0] >= WINDOW) this.recent.shift();
    if (!spec.urgent) {
      if (t - this.lastAny < MIN_GAP) return false;
      if (this.recent.length >= BUDGET) return false;
      this.recent.push(t);
    }
    this.lastBy.set(event, t);
    this.lastAny = t;
    try { this.vibrate(spec.pattern); } catch { /* unsupported */ }
    return true;
  }
}
