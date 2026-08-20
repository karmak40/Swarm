/**
 * Dijkstra flow field over the tile grid.
 *
 * Ground enemies never pathfind individually; they sample this field. Walls
 * are not hard blockers but *expensive* tiles, so the swarm naturally prefers
 * the cheapest gap and only chews through a wall when going around costs more.
 * That single trick gives maze-building real meaning without any per-unit A*.
 */

const SQRT2 = Math.SQRT2;
const INF = Infinity;

/** Neighbour offsets: 4 cardinals first, then diagonals. */
const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NY = [0, 0, 1, -1, 1, -1, 1, -1];
const NCOST = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];

/** Minimal binary min-heap keyed on Float32 priority. */
class Heap {
  private items: number[] = [];
  private prio: number[] = [];

  get size() { return this.items.length; }
  clear() { this.items.length = 0; this.prio.length = 0; }

  push(item: number, p: number) {
    const it = this.items, pr = this.prio;
    let i = it.length;
    it.push(item); pr.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pr[parent] <= pr[i]) break;
      [it[parent], it[i]] = [it[i], it[parent]];
      [pr[parent], pr[i]] = [pr[i], pr[parent]];
      i = parent;
    }
  }

  pop(): number {
    const it = this.items, pr = this.prio;
    const top = it[0];
    const last = it.pop()!;
    const lastP = pr.pop()!;
    if (it.length) {
      it[0] = last; pr[0] = lastP;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < pr.length && pr[l] < pr[m]) m = l;
        if (r < pr.length && pr[r] < pr[m]) m = r;
        if (m === i) break;
        [it[m], it[i]] = [it[i], it[m]];
        [pr[m], pr[i]] = [pr[i], pr[m]];
        i = m;
      }
    }
    return top;
  }
}

export class FlowField {
  readonly w: number;
  readonly h: number;
  /** Traversal cost per tile. `IMPASSABLE` means solid terrain. */
  readonly cost: Float32Array;
  /** Integrated cost to the nearest goal. Infinity where unreachable. */
  readonly dist: Float32Array;
  /** Unit direction toward the goal, packed as interleaved x,y. */
  readonly dir: Float32Array;

  static readonly IMPASSABLE = -1;

  private heap = new Heap();
  private goals: number[] = [];
  dirty = true;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cost = new Float32Array(w * h).fill(1);
    this.dist = new Float32Array(w * h).fill(INF);
    this.dir = new Float32Array(w * h * 2);
  }

  index(tx: number, ty: number) { return ty * this.w + tx; }
  inBounds(tx: number, ty: number) { return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h; }

  setGoals(tiles: readonly number[]) {
    this.goals = tiles.slice();
    this.dirty = true;
  }

  setCost(tx: number, ty: number, c: number) {
    if (!this.inBounds(tx, ty)) return;
    const i = this.index(tx, ty);
    if (this.cost[i] !== c) {
      this.cost[i] = c;
      this.dirty = true;
    }
  }

  costAt(tx: number, ty: number) {
    return this.inBounds(tx, ty) ? this.cost[this.index(tx, ty)] : FlowField.IMPASSABLE;
  }

  distAt(tx: number, ty: number) {
    return this.inBounds(tx, ty) ? this.dist[this.index(tx, ty)] : INF;
  }

  reachable(tx: number, ty: number) {
    return this.distAt(tx, ty) < INF;
  }

  /** Full recompute. ~1ms on a 120x90 grid; only runs when `dirty`. */
  rebuild() {
    if (!this.dirty) return;
    this.dirty = false;

    const { w, h, cost, dist, dir } = this;
    dist.fill(INF);
    const heap = this.heap;
    heap.clear();

    for (const g of this.goals) {
      if (g < 0 || g >= dist.length) continue;
      if (cost[g] === FlowField.IMPASSABLE) continue;
      dist[g] = 0;
      heap.push(g, 0);
    }

    while (heap.size) {
      const cur = heap.pop();
      const d = dist[cur];
      const cx = cur % w;
      const cy = (cur / w) | 0;

      for (let n = 0; n < 8; n++) {
        const nx = cx + NX[n];
        const ny = cy + NY[n];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        const c = cost[ni];
        if (c === FlowField.IMPASSABLE) continue;

        // Forbid cutting a diagonal between two solid tiles.
        if (n >= 4) {
          if (cost[cy * w + nx] === FlowField.IMPASSABLE) continue;
          if (cost[ny * w + cx] === FlowField.IMPASSABLE) continue;
        }

        const nd = d + c * NCOST[n];
        if (nd < dist[ni]) {
          dist[ni] = nd;
          heap.push(ni, nd);
        }
      }
    }

    // Derive descent directions once the field is settled.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cost[i] === FlowField.IMPASSABLE) { dir[i * 2] = 0; dir[i * 2 + 1] = 0; continue; }
        let best = dist[i];
        let bx = 0, by = 0;
        for (let n = 0; n < 8; n++) {
          const nx = x + NX[n], ny = y + NY[n];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (cost[ni] === FlowField.IMPASSABLE) continue;
          if (n >= 4) {
            if (cost[y * w + nx] === FlowField.IMPASSABLE) continue;
            if (cost[ny * w + x] === FlowField.IMPASSABLE) continue;
          }
          const d = dist[ni];
          if (d < best) { best = d; bx = NX[n]; by = NY[n]; }
        }
        const len = Math.hypot(bx, by) || 1;
        dir[i * 2] = bx / len;
        dir[i * 2 + 1] = by / len;
      }
    }
  }

  /**
   * Bilinear-blended direction at a world-space point, so units flowing across
   * a tile boundary don't snap. `out` is mutated and returned.
   */
  sample(tx: number, ty: number, fx: number, fy: number, out: { x: number; y: number }) {
    const { w, h, dir } = this;
    let sx = 0, sy = 0;
    // Sample the 2x2 tile neighbourhood around the fractional position.
    const bx = fx < 0.5 ? tx - 1 : tx;
    const by = fy < 0.5 ? ty - 1 : ty;
    const u = fx < 0.5 ? fx + 0.5 : fx - 0.5;
    const v = fy < 0.5 ? fy + 0.5 : fy - 0.5;
    const wts = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
    const offs = [[0, 0], [1, 0], [0, 1], [1, 1]];
    for (let k = 0; k < 4; k++) {
      const gx = bx + offs[k][0], gy = by + offs[k][1];
      if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
      const i = (gy * w + gx) * 2;
      sx += dir[i] * wts[k];
      sy += dir[i + 1] * wts[k];
    }
    const len = Math.hypot(sx, sy);
    if (len < 1e-4) {
      // Dead spot (e.g. standing on the goal) — fall back to the raw tile dir.
      const i = (Math.max(0, Math.min(h - 1, ty)) * w + Math.max(0, Math.min(w - 1, tx))) * 2;
      out.x = dir[i]; out.y = dir[i + 1];
    } else {
      out.x = sx / len; out.y = sy / len;
    }
    return out;
  }
}
