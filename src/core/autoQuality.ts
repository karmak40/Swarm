import type { Quality } from './platform';

/** Below this smoothed frame rate, a frame counts as "slow". */
const LOW_FPS = 40;
/** Seconds of continuous slow frames before stepping down a tier. */
const SUSTAIN = 4;
/** Seconds to let a new tier settle before judging it. */
const COOLDOWN = 6;
/**
 * A single frame longer than this is a stall, not a frame rate: the tab was
 * backgrounded or throttled, a GC or asset hitch landed, the device woke.
 * It says nothing about render cost, so it resets the measurement instead.
 */
const STALL = 0.25;
/** EMA weight per frame for the frame-rate estimate. */
const SMOOTH = 0.08;

const ORDER: Quality[] = ['high', 'medium', 'low'];

/** The tier below `q`, or null at the floor. */
export function lowerQuality(q: Quality): Quality | null {
  const i = ORDER.indexOf(q);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : null;
}

/** The lower of two tiers. */
export function minQuality(a: Quality, b: Quality): Quality {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

/**
 * Watches real frame times and asks for a cheaper render tier when the frame
 * rate stays low.
 *
 * Only ever steps down, one tier at a time with a settle period between, so it
 * can't oscillate. Pure bookkeeping — the caller applies the tier — which is
 * what lets the smoke test drive it with synthetic frame times.
 */
export class QualityGovernor {
  private fps = 60;
  private slow = 0;
  private cooldown = 0;

  /**
   * Feed one frame. `dt` is the real frame time in seconds (unclamped);
   * `active` is false whenever the numbers shouldn't count (menus, paused,
   * hidden tab). Returns the tier to switch to, or null to stay.
   */
  sample(dt: number, active: boolean, current: Quality): Quality | null {
    if (!active || dt > STALL || dt <= 0) {
      this.slow = 0;
      return null;
    }
    this.fps += (1 / dt - this.fps) * SMOOTH;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return null;
    }
    this.slow = this.fps < LOW_FPS ? this.slow + dt : 0;
    if (this.slow < SUSTAIN) return null;

    const next = lowerQuality(current);
    this.slow = 0;
    if (!next) return null;
    this.cooldown = COOLDOWN;
    this.fps = 60;                     // re-measure the new tier from scratch
    return next;
  }

  /** Forget the running measurement, e.g. after a manual settings change. */
  reset() {
    this.fps = 60;
    this.slow = 0;
    this.cooldown = COOLDOWN;
  }
}
