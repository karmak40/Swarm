import { Rng, ValueNoise, clamp, dist, dist2, TAU } from '../core/math';
import { FlowField } from '../engine/flowfield';
import type { LevelDef } from '../data/levels';
import { ENEMIES } from '../data/enemies';

export const TILE = 32;

/** Largest boss collision radius on the roster (px) — see carveCorridor. */
const MAX_BOSS_RADIUS = Math.max(...Object.values(ENEMIES).filter((e) => e.boss).map((e) => e.radius));

/**
 * Corridor stamp radius floor, in tiles. Two stamps 1.1 tiles apart can never
 * pinch narrower than the stamp radius itself, whatever the turn's sharpness
 * (circle geometry) — so keeping this at least the biggest boss's radius,
 * plus margin, guarantees a corridor can never wedge that boss. See
 * carveCorridor.
 */
const MIN_CORRIDOR_R = MAX_BOSS_RADIUS / TILE + 0.5;

export const enum Tile {
  Ground = 0,
  Rock = 1,
  Ore = 2,
  RichOre = 3,
}

export interface OreNode {
  tx: number;
  ty: number;
  amount: number;
  max: number;
  rich: boolean;
  /** 0..1, drives the crystal's visual size and glow. */
  fullness: number;
  /** Set when an extractor has claimed this seam. */
  claimedBy: number;
  shimmer: number;
}

export interface SpawnPoint {
  x: number;
  y: number;
  tx: number;
  ty: number;
  angle: number;
  /** Pulses when the gate is actively disgorging. */
  heat: number;
}

/**
 * The static level: tile grid, ore seams, spawn gates and the pathing field.
 *
 * Generation is fully deterministic from the seed it is handed — cellular-automata
 * caves carved out of noise, then a guaranteed-connected pass so no spawn gate is
 * ever walled off from the core by terrain alone. The seed comes from the run,
 * not the level, so replaying a sector gives a genuinely different map while the
 * sector keeps its own character through rockDensity / ore counts / palette.
 */
export class World {
  readonly def: LevelDef;
  readonly w: number;
  readonly h: number;
  readonly pxW: number;
  readonly pxH: number;
  readonly tiles: Uint8Array;
  /** Per-tile 0..1 detail value, baked once and reused by the renderer. */
  readonly detail: Float32Array;
  readonly nodes: OreNode[] = [];
  readonly nodeAt = new Map<number, OreNode>();
  readonly spawns: SpawnPoint[] = [];
  readonly field: FlowField;
  /** Flow field for fliers — terrain-free, so they cut straight lines. */
  readonly coreTx: number;
  readonly coreTy: number;
  readonly coreX: number;
  readonly coreY: number;
  readonly rng: Rng;
  readonly noise: ValueNoise;
  /** The seed this map was generated from. Surfaced in the UI so runs are shareable. */
  readonly seed: number;

  constructor(def: LevelDef, seed: number) {
    this.def = def;
    this.seed = seed >>> 0;
    this.w = def.width;
    this.h = def.height;
    this.pxW = this.w * TILE;
    this.pxH = this.h * TILE;
    this.tiles = new Uint8Array(this.w * this.h);
    this.detail = new Float32Array(this.w * this.h);
    this.rng = new Rng(this.seed);
    this.noise = new ValueNoise(this.seed ^ 0x9e3779b9);
    this.field = new FlowField(this.w, this.h);

    this.coreTx = (this.w / 2) | 0;
    this.coreTy = (this.h / 2) | 0;
    this.coreX = (this.coreTx + 0.5) * TILE;
    this.coreY = (this.coreTy + 0.5) * TILE;

    this.generate();
  }

  idx(tx: number, ty: number) { return ty * this.w + tx; }
  inBounds(tx: number, ty: number) { return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h; }
  tileAt(tx: number, ty: number): Tile {
    return this.inBounds(tx, ty) ? (this.tiles[this.idx(tx, ty)] as Tile) : Tile.Rock;
  }
  isSolid(tx: number, ty: number) { return this.tileAt(tx, ty) === Tile.Rock; }
  solidAtPx(x: number, y: number) {
    return this.isSolid(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  /* ---------------------------------------------------------------------- */
  /* Generation                                                              */
  /* ---------------------------------------------------------------------- */

  private generate() {
    const { w, h, rng, noise } = this;
    const density = this.def.rockDensity;

    // 1. Seed rock from fbm noise plus a hard border wall.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = this.idx(x, y);
        const border = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
        const n = noise.fbm(x * 0.075, y * 0.075, 4);
        this.tiles[i] = border || n < density + 0.28 ? Tile.Rock : Tile.Ground;
        this.detail[i] = noise.fbm(x * 0.22 + 40, y * 0.22 + 40, 3);
      }
    }

    // 2. Smooth with cellular automata so blobs read as rock formations.
    for (let pass = 0; pass < 3; pass++) {
      const next = this.tiles.slice();
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          let n = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
              if (dx || dy) n += this.tiles[this.idx(x + dx, y + dy)] === Tile.Rock ? 1 : 0;
          const i = this.idx(x, y);
          next[i] = n > 4 ? Tile.Rock : n < 3 ? Tile.Ground : this.tiles[i];
        }
      }
      this.tiles.set(next);
      // Re-assert the border after each pass.
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) this.tiles[this.idx(x, y)] = Tile.Rock;
    }

    // 3. Guarantee the map is not choked. With per-run seeds a dense biome can
    //    roll a layout that is almost solid rock — playable in the strict sense
    //    (gates still connect) but miserable: nowhere to build, no manoeuvring.
    this.ensureOpenness(0.34);

    // 4. Clear a generous plaza around the core so there is always room to build.
    this.carveDisc(this.coreTx, this.coreTy, 9);

    // 5. Place spawn gates on the perimeter, spread evenly with jitter.
    const count = this.def.spawnPoints;
    const baseAngle = rng.range(0, TAU);
    const radius = Math.min(w, h) * 0.46;
    for (let i = 0; i < count; i++) {
      const a = baseAngle + (i / count) * TAU + rng.range(-0.22, 0.22);
      const tx = clamp(Math.round(this.coreTx + Math.cos(a) * radius), 3, w - 4);
      const ty = clamp(Math.round(this.coreTy + Math.sin(a) * radius), 3, h - 4);
      this.carveDisc(tx, ty, 3.4);
      // Guarantee a route to the core; the corridor is deliberately winding.
      this.carveCorridor(tx, ty, this.coreTx, this.coreTy);
      this.spawns.push({
        tx, ty,
        x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE,
        angle: Math.atan2(this.coreY - (ty + 0.5) * TILE, this.coreX - (tx + 0.5) * TILE),
        heat: 0,
      });
    }

    // 6. Sprinkle ore seams, biased away from the core so mining costs time.
    this.placeOre();

    // 7. Prime the pathing field.
    this.rebuildCosts();
    this.field.setGoals([this.idx(this.coreTx, this.coreTy)]);
    this.field.rebuild();

    // 8. If terrain still stranded a gate, brute-force a straight tunnel.
    for (const s of this.spawns) {
      if (!this.field.reachable(s.tx, s.ty)) {
        this.carveLine(s.tx, s.ty, this.coreTx, this.coreTy, 2);
        this.rebuildCosts();
        this.field.dirty = true;
        this.field.rebuild();
      }
    }
  }

  /**
   * Erodes rock until at least `minFraction` of the map is walkable.
   *
   * Each pass converts rock tiles with few rock neighbours into ground, getting
   * progressively more aggressive. This preserves the biome's character (a dense
   * sector still reads as dense) while ruling out the degenerate seeds.
   */
  private ensureOpenness(minFraction: number) {
    const { w, h } = this;
    const total = w * h;
    const openFraction = () => {
      let open = 0;
      for (let i = 0; i < total; i++) if (this.tiles[i] !== Tile.Rock) open++;
      return open / total;
    };

    for (let pass = 0; pass < 8; pass++) {
      if (openFraction() >= minFraction) return;
      const next = this.tiles.slice();
      // Threshold climbs with each pass so early passes only shave thin spurs.
      const limit = 3 + pass;
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
          const i = this.idx(x, y);
          if (this.tiles[i] !== Tile.Rock) continue;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              if (this.tiles[this.idx(x + dx, y + dy)] === Tile.Rock) n++;
            }
          }
          if (n <= limit) next[i] = Tile.Ground;
        }
      }
      this.tiles.set(next);
    }
  }

  private carveDisc(cx: number, cy: number, r: number) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (!this.inBounds(x, y)) continue;
        if (x < 2 || y < 2 || x >= this.w - 2 || y >= this.h - 2) continue;
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) this.tiles[this.idx(x, y)] = Tile.Ground;
      }
    }
  }

  private carveLine(x0: number, y0: number, x1: number, y1: number, r: number) {
    const steps = Math.ceil(dist(x0, y0, x1, y1)) * 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.carveDisc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r);
    }
  }

  /** A wandering tunnel — reads more organic than a straight bore. */
  private carveCorridor(x0: number, y0: number, x1: number, y1: number) {
    const rng = this.rng;
    let x = x0, y = y0;
    let guard = 0;
    while ((Math.abs(x - x1) > 2 || Math.abs(y - y1) > 2) && guard++ < 900) {
      const wobble = Math.sin(guard * 0.14) * 0.5;
      const dx = x1 - x, dy = y1 - y;
      const len = Math.hypot(dx, dy) || 1;
      let nx = dx / len + wobble * -(dy / len) + rng.range(-0.45, 0.45);
      let ny = dy / len + wobble * (dx / len) + rng.range(-0.45, 0.45);
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      x += nx * 1.1;
      y += ny * 1.1;
      this.carveDisc(x, y, rng.range(MIN_CORRIDOR_R, MIN_CORRIDOR_R + 0.9));
    }
  }

  private placeOre() {
    const { rng, w, h } = this;
    const wanted = this.def.oreNodes;
    const rich = this.def.richNodes;
    let placed = 0, richPlaced = 0, guard = 0;

    while (placed < wanted + rich && guard++ < 6000) {
      const tx = rng.int(4, w - 5);
      const ty = rng.int(4, h - 5);
      if (this.tileAt(tx, ty) !== Tile.Ground) continue;
      const dToCore = dist(tx, ty, this.coreTx, this.coreTy);
      if (dToCore < 6) continue;               // don't gift free ore at spawn
      if (this.nodeAt.has(this.idx(tx, ty))) continue;
      // Keep seams apart so mining means moving.
      let tooClose = false;
      for (const n of this.nodes) {
        if (dist(tx, ty, n.tx, n.ty) < 4) { tooClose = true; break; }
      }
      if (tooClose) continue;

      const isRich = richPlaced < rich && (placed >= wanted || rng.chance(0.25));
      const amount = isRich ? rng.int(900, 1400) : rng.int(280, 460);
      const node: OreNode = {
        tx, ty, amount, max: amount, rich: isRich,
        fullness: 1, claimedBy: -1, shimmer: rng.range(0, TAU),
      };
      this.tiles[this.idx(tx, ty)] = isRich ? Tile.RichOre : Tile.Ore;
      this.nodes.push(node);
      this.nodeAt.set(this.idx(tx, ty), node);
      placed++;
      if (isRich) richPlaced++;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Pathing costs                                                           */
  /* ---------------------------------------------------------------------- */

  /** Rewrites base terrain costs. Buildings layer their own cost on top. */
  rebuildCosts() {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const solid = this.tiles[this.idx(x, y)] === Tile.Rock;
        this.field.setCost(x, y, solid ? FlowField.IMPASSABLE : 1);
      }
    }
  }

  nodeAtTile(tx: number, ty: number): OreNode | undefined {
    return this.nodeAt.get(this.idx(tx, ty));
  }

  /** Nearest seam with ore left, within `maxPx`. */
  nearestNode(x: number, y: number, maxPx: number): OreNode | null {
    let best: OreNode | null = null;
    let bestD = maxPx * maxPx;
    for (const n of this.nodes) {
      if (n.amount <= 0) continue;
      const nx = (n.tx + 0.5) * TILE, ny = (n.ty + 0.5) * TILE;
      const d = (nx - x) * (nx - x) + (ny - y) * (ny - y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /** Depletes a seam; returns how much was actually taken. */
  drain(node: OreNode, amount: number): number {
    const took = Math.min(node.amount, amount);
    node.amount -= took;
    node.fullness = node.amount / node.max;
    if (node.amount <= 0) {
      this.tiles[this.idx(node.tx, node.ty)] = Tile.Ground;
      this.nodeAt.delete(this.idx(node.tx, node.ty));
    }
    return took;
  }

  /** Circle-vs-tile resolution against solid rock. Mutates `p`. */
  collideCircle(p: { x: number; y: number }, r: number) {
    const minTx = Math.floor((p.x - r) / TILE);
    const maxTx = Math.floor((p.x + r) / TILE);
    const minTy = Math.floor((p.y - r) / TILE);
    const maxTy = Math.floor((p.y + r) / TILE);
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        if (!this.isSolid(tx, ty)) continue;
        const left = tx * TILE, top = ty * TILE;
        const cx = clamp(p.x, left, left + TILE);
        const cy = clamp(p.y, top, top + TILE);
        let dx = p.x - cx, dy = p.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-5) {
          // Centre inside the tile: push out along the shallowest axis.
          const midX = left + TILE / 2, midY = top + TILE / 2;
          dx = p.x - midX; dy = p.y - midY;
          if (Math.abs(dx) > Math.abs(dy)) { p.x = dx > 0 ? left + TILE + r : left - r; }
          else { p.y = dy > 0 ? top + TILE + r : top - r; }
          continue;
        }
        const push = (r - d) / d;
        p.x += dx * push;
        p.y += dy * push;
      }
    }
    p.x = clamp(p.x, r, this.pxW - r);
    p.y = clamp(p.y, r, this.pxH - r);
  }

  /**
   * Nearest open, core-reachable point to (x, y).
   *
   * Anything that materialises a unit at a computed offset — hive gates, boss
   * spawn abilities, splitter children — must route through this. A unit dropped
   * inside solid rock is wedged permanently: the flow field has no descent
   * direction for that tile so it cannot walk out, and every incoming projectile
   * is absorbed by the terrain before it arrives, so it cannot be killed either.
   * That holds the wave open forever.
   */
  findOpenNear(x: number, y: number, maxTiles = 7): { x: number; y: number } {
    const tx0 = Math.floor(x / TILE);
    const ty0 = Math.floor(y / TILE);
    const usable = (tx: number, ty: number) =>
      this.inBounds(tx, ty) && !this.isSolid(tx, ty) && this.field.reachable(tx, ty);

    if (usable(tx0, ty0)) return { x, y };

    // Expanding square rings, so the closest valid tile wins.
    for (let r = 1; r <= maxTiles; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = tx0 + dx, ty = ty0 + dy;
          if (!usable(tx, ty)) continue;
          return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
        }
      }
    }

    // Nothing nearby works — fall back to a hive gate, which is carved open by
    // generation and always has a route. Never the core: that would be free damage.
    let best = this.spawns[0];
    let bestD = Infinity;
    for (const sp of this.spawns) {
      const d = dist2(x, y, sp.x, sp.y);
      if (d < bestD) { bestD = d; best = sp; }
    }
    return best ? { x: best.x, y: best.y } : { x: this.coreX, y: this.coreY };
  }

  /** Bresenham-ish line of sight against rock, used by ranged AI and lasers. */
  lineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    const steps = Math.ceil(dist(x0, y0, x1, y1) / (TILE * 0.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this.solidAtPx(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }
}
