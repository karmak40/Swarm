import { rand, TAU } from '../core/math';

/**
 * Structure-of-arrays particle pool.
 *
 * Fixed capacity with a free-list-free "swap with last live" compaction, so
 * there is no allocation during play and iteration stays cache friendly.
 * Particles are pure cosmetics — the simulation never reads them.
 */

export const enum PKind {
  Spark = 0,
  Smoke = 1,
  Ember = 2,
  Shard = 3,
  Ring = 4,
  Glow = 5,
  Trail = 6,
}

const CAP = 4200;
/** Glow particles allowed per frame — see Particles.glowBudget. */
const GLOW_BUDGET = 14;
/** No single glow flash grows past this radius. */
const GLOW_MAX = 42;

export class Particles {
  readonly x = new Float32Array(CAP);
  readonly y = new Float32Array(CAP);
  readonly vx = new Float32Array(CAP);
  readonly vy = new Float32Array(CAP);
  readonly life = new Float32Array(CAP);
  readonly maxLife = new Float32Array(CAP);
  readonly size = new Float32Array(CAP);
  readonly rot = new Float32Array(CAP);
  readonly spin = new Float32Array(CAP);
  readonly drag = new Float32Array(CAP);
  readonly grav = new Float32Array(CAP);
  readonly kind = new Uint8Array(CAP);
  /** Packed 0xRRGGBB. Alpha comes from the life curve. */
  readonly color = new Int32Array(CAP);
  readonly additive = new Uint8Array(CAP);

  count = 0;
  /**
   * Global multiplier on emitted counts, driven by the quality tier. Particles
   * are the cheapest thing to cut on a weak GPU and the least missed.
   */
  density = 1;
  /**
   * Glow flashes left this frame. Dozens of turrets hitting one boss each
   * spawned a glow, and the additive stack washed the boss out to white.
   */
  private glowBudget = GLOW_BUDGET;

  /** Scales an authored emitter count, always leaving at least one particle. */
  private n(count: number) {
    return Math.max(1, Math.round(count * this.density));
  }

  private slot(): number {
    if (this.count < CAP) return this.count++;
    // Pool exhausted: recycle the oldest-looking slot rather than dropping.
    return (Math.random() * CAP) | 0;
  }

  spawn(
    x: number, y: number, vx: number, vy: number,
    life: number, size: number, color: number, kind: PKind,
    opts: { drag?: number; grav?: number; spin?: number; additive?: boolean } = {},
  ) {
    if (kind === PKind.Glow) {
      if (this.glowBudget <= 0) return;
      this.glowBudget--;
      size = Math.min(size, GLOW_MAX);
    }
    const i = this.slot();
    this.x[i] = x; this.y[i] = y;
    this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.maxLife[i] = life;
    this.size[i] = size;
    this.color[i] = color;
    this.kind[i] = kind;
    this.rot[i] = rand(0, TAU);
    this.spin[i] = opts.spin ?? 0;
    this.drag[i] = opts.drag ?? 2.2;
    this.grav[i] = opts.grav ?? 0;
    this.additive[i] = opts.additive === false ? 0 : 1;
  }

  update(dt: number) {
    this.glowBudget = GLOW_BUDGET;
    for (let i = 0; i < this.count; i++) {
      const l = (this.life[i] -= dt);
      if (l <= 0) {
        const last = --this.count;
        if (i !== last) this.copy(last, i);
        i--;
        continue;
      }
      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= d;
      this.vy[i] *= d;
      this.vy[i] += this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.rot[i] += this.spin[i] * dt;
    }
  }

  private copy(from: number, to: number) {
    this.x[to] = this.x[from]; this.y[to] = this.y[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from];
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.size[to] = this.size[from]; this.rot[to] = this.rot[from];
    this.spin[to] = this.spin[from]; this.drag[to] = this.drag[from];
    this.grav[to] = this.grav[from]; this.kind[to] = this.kind[from];
    this.color[to] = this.color[from]; this.additive[to] = this.additive[from];
  }

  clear() { this.count = 0; }

  /* ---- authored emitters ------------------------------------------------ */

  muzzle(x: number, y: number, angle: number, color: number, power = 1) {
    for (let i = 0; i < this.n(4 + power * 3); i++) {
      const a = angle + rand(-0.32, 0.32);
      const s = rand(90, 340) * power;
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s,
        rand(0.06, 0.18), rand(1.4, 3.4) * power, color, PKind.Spark, { drag: 6 });
    }
    this.spawn(x, y, 0, 0, 0.08, 11 * power, color, PKind.Glow, { drag: 1 });
  }

  impact(x: number, y: number, angle: number, color: number, power = 1) {
    const n = this.n(5 + power * 5);
    for (let i = 0; i < n; i++) {
      const a = angle + Math.PI + rand(-1.1, 1.1);
      const s = rand(60, 260) * power;
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s,
        rand(0.1, 0.3), rand(1, 2.6) * power, color, PKind.Spark, { drag: 5 });
    }
    this.spawn(x, y, 0, 0, 0.12, 6 * power, color, PKind.Glow);
  }

  explosion(x: number, y: number, radius: number, color: number, smokeColor = 0x2b3444) {
    const n = this.n(Math.min(70, 16 + radius * 0.55));
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const s = rand(0.25, 1) * radius * 4.5;
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s,
        rand(0.22, 0.62), rand(2, 5.5), color, PKind.Ember, { drag: 3.2, grav: 40 });
    }
    for (let i = 0; i < Math.max(1, n * 0.5); i++) {
      const a = rand(0, TAU);
      const s = rand(20, 120);
      this.spawn(x, y + rand(-6, 6), Math.cos(a) * s, Math.sin(a) * s - 18,
        rand(0.6, 1.5), rand(10, 26), smokeColor, PKind.Smoke,
        { drag: 1.4, spin: rand(-1.4, 1.4), additive: false });
    }
    this.spawn(x, y, 0, 0, 0.4, radius, color, PKind.Ring, { drag: 0 });
    this.spawn(x, y, 0, 0, 0.2, radius * 0.6, color, PKind.Glow, { drag: 0 });
  }

  gib(x: number, y: number, color: number, count = 8, power = 1) {
    for (let i = 0; i < this.n(count); i++) {
      const a = rand(0, TAU);
      const s = rand(50, 230) * power;
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s,
        rand(0.3, 0.8), rand(2, 5), color, PKind.Shard,
        { drag: 2.6, grav: 90, spin: rand(-9, 9), additive: false });
    }
  }

  ring(x: number, y: number, radius: number, color: number, life = 0.35) {
    this.spawn(x, y, 0, 0, life, radius, color, PKind.Ring, { drag: 0 });
  }

  dust(x: number, y: number, color: number, count = 4) {
    for (let i = 0; i < this.n(count); i++) {
      const a = rand(0, TAU);
      this.spawn(x, y, Math.cos(a) * rand(10, 60), Math.sin(a) * rand(10, 60),
        rand(0.3, 0.9), rand(3, 9), color, PKind.Smoke, { drag: 2.4, additive: false });
    }
  }
}
