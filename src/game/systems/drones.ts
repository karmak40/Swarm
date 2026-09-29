import { audio } from '../../core/audio';
import {
  TAU, chance, clamp, damp, dist, dist2, rand, rotateToward,
} from '../../core/math';
import { PKind } from '../../engine/particles';
import { Building, Drone } from '../entities';
import { TILE } from '../world';
import type { Game } from '../game';

/**
 * Drone bay economy: spawning/losing drones, and their fly-to-seam →
 * mine → fly-home → unload loop. Extractors mine in place; drones are the
 * mobile, fragile alternative — see `pickSeamForDrone`.
 */
export class DroneSystem {
  readonly drones: Drone[] = [];

  constructor(private game: Game) {}

  /**
   * Keeps a bay's complement in the air.
   *
   * Losses are replaced on a timer rather than instantly, so a wave that catches
   * your drones in the open costs you real throughput for the next half-minute.
   */
  updateDroneBay(b: Building, dt: number) {
    b.depositFlash = Math.max(0, b.depositFlash - dt * 3);
    const slots = Math.round(b.def.droneSlots!);
    let live = 0;
    for (const d of this.drones) if (!d.dead && d.bayId === b.id) live++;
    // Deliberately does NOT clear the timer at capacity: killDrone starts it, and
    // zeroing it here made every loss refill on the very next frame, which threw
    // away the whole point of the drones being fragile.
    if (live >= slots) return;

    // A browned-out bay rebuilds proportionally slower, like everything else.
    b.droneCooldown -= dt * Math.max(0.15, b.efficiency);
    if (b.droneCooldown > 0) return;
    b.droneCooldown = b.def.droneRespawn ?? 20;
    this.spawnDrone(b);
  }

  spawnDrone(bay: Building): Drone {
    const g = this.game;
    const a = rand(0, TAU);
    const d = new Drone(
      bay.x + Math.cos(a) * bay.radius,
      bay.y + Math.sin(a) * bay.radius,
      Math.round((bay.def.droneHp ?? 34) * g.perks.structureHp),
      Math.round(bay.def.droneCargo ?? 20),
      bay.id,
    );
    this.drones.push(d);
    g.particles.ring(d.x, d.y, 16, 0x7fd9ff, 0.3);
    return d;
  }

  /** Fills every bay to capacity at once, ignoring respawn timers. */
  fillDroneBays() {
    const g = this.game;
    for (const b of g.buildings) {
      if (b.def.droneSlots === undefined || !b.built) continue;
      let live = 0;
      for (const d of this.drones) if (!d.dead && d.bayId === b.id) live++;
      for (let i = live; i < Math.round(b.def.droneSlots); i++) this.spawnDrone(b);
      b.droneCooldown = 0;
    }
  }

  private bayOf(d: Drone): Building | null {
    return this.game.buildingById.get(d.bayId) ?? null;
  }

  /** Live drones belonging to a bay, and the bay's capacity. */
  droneCount(bay: Building) {
    let live = 0;
    for (const d of this.drones) if (!d.dead && d.bayId === bay.id) live++;
    return { live, slots: Math.round(bay.def.droneSlots ?? 0) };
  }

  /**
   * Drone logistics: fly to a seam, cut ore into the hold, fly it home, repeat.
   *
   * The trade against an Extractor is deliberate — a drone is slower per seam
   * because of the round trip, but it re-targets when a seam runs dry instead of
   * becoming dead weight.
   */
  updateDrones(dt: number) {
    const g = this.game;
    const world = g.world;

    for (let i = this.drones.length - 1; i >= 0; i--) {
      const d = this.drones[i];
      if (d.dead) { this.drones.splice(i, 1); continue; }

      d.anim += dt;
      d.hitFlash = Math.max(0, d.hitFlash - dt * 5);

      const bay = this.bayOf(d);
      if (!bay || bay.dead || !bay.built) {
        // Without a bay there is nowhere to unload and nothing to maintain it.
        this.killDrone(d, true);
        continue;
      }

      const def = bay.def;
      const speed = (def.droneSpeed ?? 95);
      const range = def.droneRange ?? 900;

      // Re-validate the assignment every tick: seams empty, and another drone
      // may have finished the one this drone was flying to.
      let node = d.nodeIndex >= 0 ? world.nodes[d.nodeIndex] : undefined;
      if (node && node.amount <= 0) { node = undefined; d.nodeIndex = -1; }

      if (d.state === 'idle' || (d.state === 'toSeam' && !node)) {
        if (d.cargo > 0) {
          d.state = 'toBay';
        } else {
          const pick = this.pickSeamForDrone(bay, range);
          if (pick >= 0) { d.nodeIndex = pick; d.state = 'toSeam'; }
          else d.state = 'idle';
        }
      }

      let tx = bay.x;
      let ty = bay.y;

      switch (d.state) {
        case 'toSeam': {
          node = world.nodes[d.nodeIndex];
          if (!node) { d.state = 'idle'; break; }
          tx = (node.tx + 0.5) * TILE;
          ty = (node.ty + 0.5) * TILE;
          if (dist(d.x, d.y, tx, ty) < 26) d.state = 'mining';
          break;
        }
        case 'mining': {
          node = world.nodes[d.nodeIndex];
          if (!node || node.amount <= 0) {
            d.nodeIndex = -1;
            d.state = d.cargo > 0 ? 'toBay' : 'idle';
            break;
          }
          tx = (node.tx + 0.5) * TILE;
          ty = (node.ty + 0.5) * TILE;
          d.beam = Math.min(1, d.beam + dt * 5);

          const rate = (def.droneMineRate ?? 4) * g.perks.extractorRate * bay.efficiency;
          const room = d.cargoMax - d.cargo;
          const took = world.drain(node, Math.min(room, rate * dt));
          d.cargo += took;
          if (chance(dt * 8)) {
            g.particles.spawn(tx + rand(-6, 6), ty + rand(-6, 6),
              rand(-30, 30), rand(-60, -20), rand(0.2, 0.45), rand(1.5, 3),
              g.level.palette.oreColor, PKind.Spark, { grav: 40 });
          }
          if (d.full || node.amount <= 0) {
            if (node.amount <= 0) g.progress.bump('mineNode');
            d.state = 'toBay';
          }
          break;
        }
        case 'toBay': {
          tx = bay.x;
          ty = bay.y;
          if (dist(d.x, d.y, tx, ty) < bay.radius + 12) {
            // Unload. Yield perks apply here, at the point of delivery.
            const gain = d.cargo * g.perks.oreYield;
            g.ore += gain;
            g.buffers.ore += gain;
            g.runStats.oreMined += gain;
            g.runStats.droneOre += gain;
            d.cargo = 0;
            bay.depositFlash = 1;
            audio.play('pickup', rand(1.15, 1.3));
            g.particles.ring(bay.x, bay.y, bay.radius * 1.2, g.level.palette.oreColor, 0.25);
            d.state = 'idle';
          }
          break;
        }
        case 'idle': {
          // Loiter above the bay rather than sitting on it, so it reads as parked.
          tx = bay.x + Math.cos(d.anim * 0.7 + d.id) * bay.radius * 1.5;
          ty = bay.y + Math.sin(d.anim * 0.7 + d.id) * bay.radius * 1.5;
          break;
        }
      }

      if (d.state !== 'mining') d.beam = Math.max(0, d.beam - dt * 4);

      // Steering. Flying, so no terrain collision — only world bounds.
      const dx = tx - d.x, dy = ty - d.y;
      const dd = Math.hypot(dx, dy);
      const wantSpeed = d.state === 'mining' ? 0 : speed;
      if (dd > 1 && wantSpeed > 0) {
        const arrive = Math.min(1, dd / 40);       // ease in on approach
        d.vx = damp(d.vx, (dx / dd) * wantSpeed * arrive, 6, dt);
        d.vy = damp(d.vy, (dy / dd) * wantSpeed * arrive, 6, dt);
      } else {
        d.vx = damp(d.vx, 0, 8, dt);
        d.vy = damp(d.vy, 0, 8, dt);
      }
      d.x = clamp(d.x + d.vx * dt, d.radius, world.pxW - d.radius);
      d.y = clamp(d.y + d.vy * dt, d.radius, world.pxH - d.radius);
      if (Math.abs(d.vx) + Math.abs(d.vy) > 3) {
        d.angle = rotateToward(d.angle, Math.atan2(d.vy, d.vx), dt * 6);
      }
    }
  }

  /**
   * Picks a seam for one drone.
   *
   * Skips seams an Extractor already owns, so the two systems complement each
   * other instead of double-dipping one deposit. Crowding is penalised rather
   * than forbidden: without it a bay's whole flight converges on the single
   * nearest seam, which flies in lockstep, drains one deposit at a time, and
   * lets one blast take out every drone at once.
   */
  private pickSeamForDrone(bay: Building, range: number): number {
    const world = this.game.world;
    // How many of this bay's drones are already committed to each seam.
    const taken = new Map<number, number>();
    for (const d of this.drones) {
      if (d.dead || d.bayId !== bay.id || d.nodeIndex < 0) continue;
      taken.set(d.nodeIndex, (taken.get(d.nodeIndex) ?? 0) + 1);
    }

    let best = -1;
    let bestScore = Infinity;
    const maxD2 = range * range;
    for (let i = 0; i < world.nodes.length; i++) {
      const n = world.nodes[i];
      if (n.amount <= 0 || n.claimedBy >= 0) continue;
      const nx = (n.tx + 0.5) * TILE, ny = (n.ty + 0.5) * TILE;
      const d2 = dist2(bay.x, bay.y, nx, ny);
      if (d2 > maxD2) continue;
      // A seam already worked by one drone has to be meaningfully closer to win.
      const score = d2 * (1 + (taken.get(i) ?? 0) * 0.9);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  damageDrone(d: Drone, amount: number) {
    if (d.dead) return;
    d.hp -= amount;
    d.hitFlash = 1;
    if (d.hp <= 0) this.killDrone(d, false);
  }

  killDrone(d: Drone, quiet: boolean) {
    if (d.dead) return;
    const g = this.game;
    d.dead = true;
    g.runStats.dronesLost++;
    // Start the bay's rebuild clock here, at the moment of loss.
    const bay = this.bayOf(d);
    if (bay && !bay.dead) {
      bay.droneCooldown = Math.max(bay.droneCooldown, bay.def.droneRespawn ?? 20);
    }
    g.particles.explosion(d.x, d.y, 22, 0x7fd9ff, g.level.palette.rock);
    g.particles.gib(d.x, d.y, 0x4a5566, 5, 0.8);
    // Cargo in the hold is lost with it — that is the cost of the round trip.
    if (!quiet) audio.play('explode', rand(1.2, 1.4));
  }
}
