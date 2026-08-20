/**
 * Uniform-grid broadphase.
 *
 * Rebuilt from scratch every tick — with a few thousand agents that is far
 * cheaper than maintaining incremental buckets, and it keeps query results
 * consistent within a frame. Buckets store indices into a caller-owned array.
 */
export class SpatialHash {
  private cell: number;
  private inv: number;
  private cols: number;
  private rows: number;
  private buckets: number[][];

  constructor(worldW: number, worldH: number, cellSize = 64) {
    this.cell = cellSize;
    this.inv = 1 / cellSize;
    this.cols = Math.ceil(worldW / cellSize) + 1;
    this.rows = Math.ceil(worldH / cellSize) + 1;
    this.buckets = new Array(this.cols * this.rows);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  clear() {
    for (let i = 0; i < this.buckets.length; i++) {
      if (this.buckets[i].length) this.buckets[i].length = 0;
    }
  }

  private idx(cx: number, cy: number) { return cy * this.cols + cx; }

  insert(index: number, x: number, y: number) {
    const cx = Math.max(0, Math.min(this.cols - 1, (x * this.inv) | 0));
    const cy = Math.max(0, Math.min(this.rows - 1, (y * this.inv) | 0));
    this.buckets[this.idx(cx, cy)].push(index);
  }

  /** Appends indices whose cell overlaps the circle to `out`. May over-report. */
  query(x: number, y: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const x0 = Math.max(0, ((x - radius) * this.inv) | 0);
    const x1 = Math.min(this.cols - 1, ((x + radius) * this.inv) | 0);
    const y0 = Math.max(0, ((y - radius) * this.inv) | 0);
    const y1 = Math.min(this.rows - 1, ((y + radius) * this.inv) | 0);
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * this.cols;
      for (let cx = x0; cx <= x1; cx++) {
        const b = this.buckets[row + cx];
        for (let i = 0; i < b.length; i++) out.push(b[i]);
      }
    }
    return out;
  }

  get cellSize() { return this.cell; }
}
