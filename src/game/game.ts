import { audio } from '../core/audio';
import type { InputSource } from '../core/input';
import {
  Rng, TAU, angleDelta, clamp, damp, dist, dist2, lerp, rand, randInt, chance, rotateToward,
} from '../core/math';
// Aliased: this file's `t` is almost always a Tile value, not a translation call.
import { t as tr } from '../core/i18n';
import { PKind, Particles } from '../engine/particles';
import { SpatialHash } from '../engine/spatial';
import { FlowField } from '../engine/flowfield';
import {
  BUILDINGS, BUILD_ORDER, HOTKEY_CODES, REPAIR_COST_PER_HP, SELL_RATIO, buildingName,
  type BuildingDef, type BuildingKind, type TargetingMode,
} from '../data/buildings';
import { ENEMIES, enemyName, enemyDesc, type EnemyDef } from '../data/enemies';
import { ENDLESS_BOSS_INTERVAL, LEVELS, levelName, levelSubtitle, type LevelDef } from '../data/levels';
import { applyPerk, basePerks, type Perks } from '../data/perks';
import { RARITY_WEIGHT, TECH_CARDS, techName, techDesc, type TechCard } from '../data/tech';
import {
  Building, Core, type DamageNumber, Drone, type Effect, Enemy, Pickup,
  type PickupKind, Player, Projectile,
} from './entities';
import { Progress } from './progress';
import {
  clearRun, loadRun, saveRun, RUN_SNAPSHOT_VERSION, type RunSnapshot,
} from '../core/save';
import { TILE, Tile, World, type OreNode } from './world';
import { WaveDirector, type Phase, type WavePlan } from './waves';

/** Campaign runs end at a scripted boss; endless runs end when the core dies. */
export type GameMode = 'campaign' | 'endless';

export type BuildMode = { kind: BuildingKind } | null;
export type CursorMode = 'normal' | 'build' | 'sell';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  shake: number;
  shakeX: number;
  shakeY: number;
}

export interface Banner {
  title: string;
  sub: string;
  life: number;
  maxLife: number;
  color: string;
}

const MAX_PROJECTILES = 900;
const MAX_PICKUPS = 500;
const PLAYER_BASE_HP = 160;
const CORE_BASE_HP = 2600;
/** How far the player's weapon reaches when auto-aiming. */
const PLAYER_AIM_RANGE = 430;
/** How close the player must be to work a seam. */
const PLAYER_MINE_RANGE = 168;
/** Fraction of the per-wave hp/damage ramp that bosses inherit. See spawnFromGate. */
const BOSS_SCALE_SHARE = 0.3;
/**
 * Seconds past a wave's scripted window before surviving enemies are enraged.
 * Without this a single straggler camping an out-of-coverage structure can hold
 * a wave open indefinitely, which reads to the player as a soft-lock.
 */
const STRAGGLER_GRACE = 25;

/** Damage after flat armour, never fully negated. */
function mitigate(amount: number, armor: number, pierce: number): number {
  const a = Math.max(0, armor - pierce);
  return Math.max(amount * 0.15, amount - a);
}

export class Game {
  // --- persistent ---
  readonly progress: Progress;

  // --- level scoped ---
  level!: LevelDef;
  levelIndex = 0;
  mode: GameMode = 'campaign';
  /** Seed the current map was rolled from; shown in the UI and reusable. */
  runSeed = 0;
  /** runSeed mixed with the sector salt — what the world and director derive from. */
  private mapSeed = 0;
  world!: World;
  core!: Core;
  player!: Player;
  perks: Perks = basePerks();
  rng!: Rng;

  readonly enemies: Enemy[] = [];
  readonly buildings: Building[] = [];
  /** Tile → building occupying it, for O(1) collision and placement checks. */
  buildingAt: (Building | null)[] = [];
  readonly projectiles: Projectile[] = [];
  readonly drones: Drone[] = [];
  readonly pickups: Pickup[] = [];
  readonly effects: Effect[] = [];
  readonly damageNumbers: DamageNumber[] = [];
  readonly particles = new Particles();

  private enemyHash!: SpatialHash;
  private queryBuf: number[] = [];

  // --- economy ---
  ore = 0;
  essence = 0;
  power = { supply: 0, draw: 0, efficiency: 1 };

  // --- wave state ---
  phase: Phase = 'prep';
  waveIndex = 0;
  plan: WavePlan | null = null;
  nextPlan: WavePlan | null = null;
  private director!: WaveDirector;
  private orderCursor = 0;
  waveTimer = 0;         // counts down in prep, up in combat
  prepRemaining = 0;
  spawnedThisWave = 0;
  killedThisWave = 0;
  bossRef: Enemy | null = null;
  /** True once STRAGGLER_GRACE has elapsed and the remnant has been enraged. */
  stragglersEnraged = false;

  // --- run bookkeeping ---
  unlockedBuildings = new Set<BuildingKind>();
  techTaken: string[] = [];
  pendingDraft: TechCard[] | null = null;
  runStats = {
    kills: 0, bossKills: 0, oreMined: 0, essenceCollected: 0,
    built: 0, damage: 0, structuresLost: 0, wavesCleared: 0,
    coreDamage: 0, timeSeconds: 0, bestPower: 0, dronesLost: 0, droneOre: 0,
  };
  private structuresLostThisWave = 0;
  private coreDamageThisWave = 0;
  private buffers = { ore: 0, essence: 0, damage: 0, repair: 0, seconds: 0 };

  // --- presentation ---
  camera: Camera = { x: 0, y: 0, zoom: 1, shake: 0, shakeX: 0, shakeY: 0 };
  flash = { r: 0, g: 0, b: 0, a: 0 };
  banner: Banner | null = null;
  timeScale = 1;
  private hitstop = 0;
  elapsed = 0;
  /** Set while the sim should not advance (menus, draft, results). */
  frozen = false;

  // --- interaction ---
  /**
   * Aim and fire the player weapon without pointer input. Required on touch,
   * where there is no cursor to aim with; optional on desktop.
   */
  autoAim = false;
  /** Mine the nearest seam in range with no button held. Required on touch. */
  autoMine = false;
  /** The enemy auto-aim is currently tracking, for the HUD lock indicator. */
  autoTarget: Enemy | null = null;
  cursorMode: CursorMode = 'normal';
  buildKind: BuildingKind | null = null;
  buildValid = false;
  buildTx = 0;
  buildTy = 0;
  hoverBuilding: Building | null = null;
  hoverNode: OreNode | null = null;
  mouseWorldX = 0;
  mouseWorldY = 0;
  lastError = { text: '', life: 0 };

  /** Fired when the run reaches a state the shell must present. */
  onPhaseChange: ((p: Phase) => void) | null = null;
  onDraft: ((cards: TechCard[]) => void) | null = null;

  constructor() {
    this.progress = new Progress();
  }

  /* ====================================================================== */
  /* Lifecycle                                                               */
  /* ====================================================================== */

  /**
   * @param seed  Explicit map seed. Omit for a fresh random map — this is what
   *              makes a replayed sector a different fight rather than the same
   *              one from memory. Pass a value to reproduce a run or to pin a map
   *              in tests.
   */
  startLevel(
    levelIndex: number,
    carryOver?: { perks: Perks; tech: string[]; unlocked: BuildingKind[] },
    seed?: number,
    opts: { mode?: GameMode; resuming?: boolean } = {},
  ) {
    this.levelIndex = clamp(levelIndex, 0, LEVELS.length - 1);
    this.level = LEVELS[this.levelIndex];
    this.mode = opts.mode ?? 'campaign';
    // The level's own seed is a per-sector salt, so the same run seed still yields
    // a different map in each sector.
    this.runSeed = (seed ?? ((Math.random() * 0x100000000) >>> 0)) >>> 0;
    const mapSeed = (this.runSeed ^ this.level.seed) >>> 0;
    this.mapSeed = mapSeed;
    this.rng = new Rng(mapSeed ^ 0xc0ffee);
    this.world = new World(this.level, mapSeed);
    this.enemyHash = new SpatialHash(this.world.pxW, this.world.pxH, 72);

    // Perks: achievements always apply; tech carries across levels in a campaign.
    this.perks = this.progress.computePerks();
    if (carryOver) {
      this.techTaken = [...carryOver.tech];
      for (const id of this.techTaken) {
        const card = TECH_CARDS.find((c) => c.id === id);
        if (card?.perk) applyPerk(this.perks, card.perk);
      }
      this.unlockedBuildings = new Set([...this.level.unlocked, ...carryOver.unlocked]);
    } else {
      this.techTaken = [];
      this.unlockedBuildings = new Set(this.level.unlocked);
    }

    this.enemies.length = 0;
    this.buildings.length = 0;
    this.buildingAt = new Array(this.world.w * this.world.h).fill(null);
    this.projectiles.length = 0;
    this.drones.length = 0;
    this.pickups.length = 0;
    this.effects.length = 0;
    this.damageNumbers.length = 0;
    this.particles.clear();

    this.core = new Core(this.world.coreX, this.world.coreY, Math.round(CORE_BASE_HP * this.perks.coreHp));
    this.player = new Player(
      this.world.coreX + TILE * 2.5,
      this.world.coreY + TILE * 2.5,
      Math.round(PLAYER_BASE_HP * this.perks.playerMaxHp),
    );

    this.ore = Math.round(this.level.startOre + this.perks.startOre);
    this.essence = Math.round(this.level.startEssence + this.perks.startEssence);

    this.director = new WaveDirector(
      this.level, this.world.spawns.length, mapSeed ^ 0xabcdef, this.mode === 'endless',
    );
    this.waveIndex = 0;
    this.plan = null;
    this.nextPlan = this.director.plan(0);
    this.orderCursor = 0;
    this.spawnedThisWave = 0;
    this.killedThisWave = 0;
    this.bossRef = null;
    this.phase = 'prep';
    this.prepRemaining = this.level.prepTime;
    this.waveTimer = 0;
    this.structuresLostThisWave = 0;
    this.coreDamageThisWave = 0;
    this.pendingDraft = null;

    this.runStats = {
      kills: 0, bossKills: 0, oreMined: 0, essenceCollected: 0,
      built: 0, damage: 0, structuresLost: 0, wavesCleared: 0,
      coreDamage: 0, timeSeconds: 0, bestPower: 0, dronesLost: 0, droneOre: 0,
    };

    this.camera.x = this.core.x;
    this.camera.y = this.core.y;
    this.camera.zoom = 1;
    this.cursorMode = 'normal';
    this.buildKind = null;
    this.elapsed = 0;
    this.frozen = false;

    // Seed the field with the core as the single goal.
    this.world.field.setGoals([this.world.field.index(this.world.coreTx, this.world.coreTy)]);
    this.world.field.rebuild();

    this.setBanner(
      this.mode === 'endless'
        ? tr('game.banner.endlessTitle', 'ENDLESS · {name}', { name: levelName(this.level).toUpperCase() })
        : levelName(this.level).toUpperCase(),
      this.mode === 'endless'
        ? tr('game.banner.endlessSubtitle', 'Survive as long as you can')
        : levelSubtitle(this.level),
      4.2, this.mode === 'endless' ? '#ffcc55' : '#46d8ff',
    );
    audio.startMusic(this.levelIndex * 2);
    audio.setIntensity(0);
    // Resuming is not a new attempt; only count fresh deployments.
    if (!opts.resuming) this.progress.recordRunStat('runs', 1);
  }

  private setPhase(p: Phase) {
    if (this.phase === p) return;
    this.phase = p;
    this.onPhaseChange?.(p);
  }

  setBanner(title: string, sub: string, life = 3, color = '#46d8ff') {
    this.banner = { title, sub, life, maxLife: life, color };
  }

  private error(text: string) {
    this.lastError = { text, life: 1.6 };
    audio.play('error');
  }

  /* ====================================================================== */
  /* Main tick                                                               */
  /* ====================================================================== */

  update(rawDt: number, input: InputSource) {
    // Hitstop: a few frames of near-freeze sells big impacts.
    if (this.hitstop > 0) {
      this.hitstop -= rawDt;
      this.timeScale = damp(this.timeScale, 0.08, 22, rawDt);
    } else {
      this.timeScale = damp(this.timeScale, 1, 9, rawDt);
    }

    const dt = Math.min(0.05, rawDt) * (this.frozen ? 0 : this.timeScale);
    this.elapsed += dt;

    this.updateInteraction(input, rawDt);
    this.updateBanner(rawDt);

    if (dt <= 0) {
      this.updateCamera(rawDt, input);
      return;
    }

    this.buffers.seconds += dt;
    this.runStats.timeSeconds += dt;

    this.rebuildEnemyHash();
    this.updatePower();
    this.updateWaves(dt);
    this.updatePlayer(dt, input);
    this.updateBuildings(dt);
    this.updateDrones(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.updatePickups(dt);
    this.updateEffects(dt);
    this.updateCore(dt);
    this.updateNodes(dt);

    this.particles.update(dt);
    this.updateDamageNumbers(dt);
    this.updateCamera(rawDt, input);
    this.updateAudioMix(dt);
    this.flushBuffers();

    this.world.field.rebuild();
  }

  private updateBanner(dt: number) {
    if (this.banner) {
      this.banner.life -= dt;
      if (this.banner.life <= 0) this.banner = null;
    }
    if (this.lastError.life > 0) this.lastError.life -= dt;
    this.flash.a = Math.max(0, this.flash.a - dt * 3.4);
  }

  private flushBuffers() {
    const b = this.buffers;
    if (b.ore >= 1) { const n = Math.floor(b.ore); b.ore -= n; this.progress.bump('ore', n); this.progress.recordRunStat('oreMined', n); }
    if (b.essence >= 1) { const n = Math.floor(b.essence); b.essence -= n; this.progress.bump('essence', n); this.progress.recordRunStat('essenceCollected', n); }
    if (b.damage >= 25) { const n = Math.floor(b.damage); b.damage -= n; this.progress.bump('damage', n); this.progress.recordRunStat('damageDealt', n); }
    if (b.repair >= 25) { const n = Math.floor(b.repair); b.repair -= n; this.progress.bump('repair', n); }
    if (b.seconds >= 5) { const n = Math.floor(b.seconds); b.seconds -= n; this.progress.bump('playSeconds', n); this.progress.recordRunStat('playSeconds', n); }
  }

  private updateAudioMix(dt: number) {
    let intensity = 0;
    if (this.phase === 'combat' || this.phase === 'incoming') {
      const threat = Math.min(1, this.enemies.length / 40);
      const waveT = this.waveIndex / Math.max(1, this.level.waves - 1);
      intensity = 0.35 + threat * 0.35 + waveT * 0.2;
    } else if (this.phase === 'boss') {
      intensity = 1;
    } else if (this.phase === 'prep' || this.phase === 'cleared') {
      intensity = 0.1;
    }
    if (this.core.pct < 0.35) intensity = Math.max(intensity, 0.85);
    audio.setIntensity(intensity);
    audio.update(dt);
  }

  /* ====================================================================== */
  /* Interaction: build placement, selling, repairing                        */
  /* ====================================================================== */

  private updateInteraction(input: InputSource, dt: number) {
    // Cursor → world.
    const view = this.viewport;
    this.mouseWorldX = this.camera.x + (input.mouseX - view.w / 2) / this.camera.zoom;
    this.mouseWorldY = this.camera.y + (input.mouseY - view.h / 2) / this.camera.zoom;

    if (input.uiCaptured) return;

    // Zoom.
    if (input.wheel !== 0) {
      this.camera.zoom = clamp(this.camera.zoom * (input.wheel > 0 ? 0.9 : 1.111), 0.55, 1.9);
    }

    // Build hotkeys.
    for (const kind of BUILD_ORDER) {
      const def = BUILDINGS[kind];
      const code = HOTKEY_CODES[def.hotkey];
      if (code && input.pressed(code)) {
        if (!this.unlockedBuildings.has(kind)) {
          this.error(tr('game.error.notResearched', '{name} is not researched', { name: buildingName(def) }));
          break;
        }
        this.buildKind = this.buildKind === kind ? null : kind;
        this.cursorMode = this.buildKind ? 'build' : 'normal';
        audio.play('uiClick');
        break;
      }
    }

    if (input.pressed('KeyQ')) {
      this.cursorMode = this.cursorMode === 'sell' ? 'normal' : 'sell';
      this.buildKind = null;
      audio.play('uiClick');
    }

    if (input.pressed('Escape') && this.cursorMode !== 'normal') {
      this.cursorMode = 'normal';
      this.buildKind = null;
      audio.play('uiBack');
    }

    // Hover resolution.
    const htx = Math.floor(this.mouseWorldX / TILE);
    const hty = Math.floor(this.mouseWorldY / TILE);
    this.hoverBuilding = this.buildingAtTile(htx, hty);
    this.hoverNode = this.world.nodeAtTile(htx, hty) ?? null;

    // Cycle targeting mode of the hovered turret.
    if (input.pressed('KeyT') && this.hoverBuilding) this.cycleTargeting(this.hoverBuilding);

    // Repair while E held.
    if (input.down('KeyE') && this.hoverBuilding && this.hoverBuilding.hp < this.hoverBuilding.maxHp) {
      this.repairBuilding(this.hoverBuilding, dt);
    }

    if (this.cursorMode === 'build' && this.buildKind) {
      const def = BUILDINGS[this.buildKind];
      // Centre the footprint on the cursor for multi-tile structures.
      const off = Math.floor((def.size - 1) / 2);
      this.buildTx = htx - off;
      this.buildTy = hty - off;
      this.buildValid = this.canPlace(def, this.buildTx, this.buildTy) === null;

      if (input.mouseDown(0)) {
        const reason = this.canPlace(def, this.buildTx, this.buildTy);
        if (reason === null) this.place(def, this.buildTx, this.buildTy);
        else if (input.mouseClicked(0)) this.error(reason);
      }
      if (input.mouseClicked(2)) {
        this.cursorMode = 'normal';
        this.buildKind = null;
        audio.play('uiBack');
      }
    } else if (this.cursorMode === 'sell') {
      if (input.mouseClicked(0) && this.hoverBuilding) this.sellBuilding(this.hoverBuilding);
      if (input.mouseClicked(2)) { this.cursorMode = 'normal'; audio.play('uiBack'); }
    }

    // Skip the build phase for a bonus.
    if (input.pressed('Space')) this.skipBuildPhase();
  }

  /**
   * Ends the current build window early for bonus ore. Public because the touch
   * layer needs the same action from an on-screen button — duplicating it is how
   * the two schemes drift apart.
   */
  skipBuildPhase(): boolean {
    if (!this.inBuildPhase || this.prepRemaining <= 2) return false;
    const bonus = Math.round(this.prepRemaining * 3);
    this.ore += bonus;
    this.setBanner(
      tr('game.banner.earlyAssault', 'EARLY ASSAULT'),
      tr('game.banner.earlyAssaultDetail', '+{bonus} ore for skipping {seconds}s',
        { bonus, seconds: Math.ceil(this.prepRemaining) }),
      2.4, '#ffb347',
    );
    this.prepRemaining = 0.6;
    audio.play('levelUp');
    return true;
  }

  /** Cycles a turret's target priority. Shared by the T key and the touch menu. */
  cycleTargeting(b: Building) {
    if (!b.isTurret) return;
    const modes: TargetingMode[] = ['first', 'closest', 'strongest', 'weakest'];
    b.targeting = modes[(modes.indexOf(b.targeting) + 1) % modes.length];
    audio.play('uiClick');
  }

  /**
   * One tap's worth of repair. The held-key path bills continuously; touch has no
   * comfortable equivalent, so this applies a fixed chunk per tap instead.
   */
  repairBuildingBurst(b: Building): boolean {
    const missing = b.maxHp - b.hp;
    if (missing <= 0) return false;
    const heal = Math.min(missing, b.maxHp * 0.25);
    const cost = heal * REPAIR_COST_PER_HP;
    if (this.ore < cost) { this.error(tr('game.error.notEnoughOreRepair', 'Not enough ore to repair')); return false; }
    this.ore -= cost;
    b.hp += heal;
    this.buffers.repair += heal;
    this.particles.ring(b.x, b.y, b.radius * 1.5, 0x5cf2a0, 0.3);
    audio.play('repair');
    return true;
  }

  buildingAtTile(tx: number, ty: number): Building | null {
    if (!this.world.inBounds(tx, ty)) return null;
    return this.buildingAt[this.world.idx(tx, ty)];
  }

  /** Returns null when placement is legal, otherwise a player-facing reason. */
  canPlace(def: BuildingDef, tx: number, ty: number): string | null {
    const cost = this.costOf(def);
    if (this.ore < cost.ore) return tr('game.place.needOre', 'Need {n} ore', { n: cost.ore });
    if (this.essence < cost.essence) {
      return tr('game.place.needEssence', 'Need {n} essence', { n: cost.essence });
    }

    let coversNode = false;
    for (let y = ty; y < ty + def.size; y++) {
      for (let x = tx; x < tx + def.size; x++) {
        if (!this.world.inBounds(x, y)) return tr('game.place.outOfBounds', 'Out of bounds');
        if (this.world.isSolid(x, y)) return tr('game.place.solidRock', 'Solid rock');
        if (this.buildingAt[this.world.idx(x, y)]) return tr('game.place.occupied', 'Occupied');
        const tile = this.world.tileAt(x, y);
        if (tile === Tile.Ore || tile === Tile.RichOre) coversNode = true;
      }
    }

    // Keep the core plaza clear.
    const cx = (tx + def.size / 2) * TILE, cy = (ty + def.size / 2) * TILE;
    if (dist(cx, cy, this.core.x, this.core.y) < this.core.radius + def.size * TILE * 0.5 + 4) {
      return tr('game.place.tooCloseCore', 'Too close to the core');
    }
    // Do not let players cap a spawn gate.
    for (const s of this.world.spawns) {
      if (dist(cx, cy, s.x, s.y) < TILE * 3.2) {
        return tr('game.place.tooCloseGate', 'Too close to a hive gate');
      }
    }

    if (def.id === 'extractor' && !coversNode) {
      return tr('game.place.needsOreSeam', 'Must be placed on an ore seam');
    }
    if (def.id !== 'extractor' && coversNode) {
      return tr('game.place.seamExtractorOnly', 'Ore seam — only extractors fit here');
    }

    return null;
  }

  costOf(def: BuildingDef) {
    return {
      ore: Math.max(1, Math.round(def.ore * this.perks.buildCost)),
      essence: Math.round(def.essence * this.perks.buildCost),
    };
  }

  private place(def: BuildingDef, tx: number, ty: number) {
    const cost = this.costOf(def);
    this.ore -= cost.ore;
    this.essence -= cost.essence;

    const b = new Building(def, tx, ty, TILE, this.perks.structureHp);
    b.progress = 0;
    this.buildings.push(b);

    for (let y = ty; y < ty + def.size; y++) {
      for (let x = tx; x < tx + def.size; x++) {
        this.buildingAt[this.world.idx(x, y)] = b;
        if (def.blocksMovement) this.world.field.setCost(x, y, def.pathCost);
      }
    }

    if (def.id === 'extractor') {
      for (let y = ty; y < ty + def.size; y++) {
        for (let x = tx; x < tx + def.size; x++) {
          const n = this.world.nodeAtTile(x, y);
          if (n) { b.nodeIndex = this.world.nodes.indexOf(n); n.claimedBy = b.id; break; }
        }
        if (b.nodeIndex >= 0) break;
      }
    }

    this.runStats.built++;
    this.progress.bump('build');
    this.progress.recordRunStat('buildingsBuilt', 1);
    audio.play('build');
    this.particles.dust(b.x, b.y, this.level.palette.rockLit, 10);
    this.particles.ring(b.x, b.y, b.radius * 1.6, 0x7fd9ff, 0.3);
    this.shake(2.5);
  }

  sellBuilding(b: Building) {
    const cost = this.costOf(b.def);
    const refund = Math.round(cost.ore * SELL_RATIO * this.perks.sellRefund * (0.5 + b.progress * 0.5));
    const refundE = Math.round(cost.essence * SELL_RATIO * this.perks.sellRefund);
    this.ore += refund;
    this.essence += refundE;
    this.removeBuilding(b, false);
    this.progress.bump('sell');
    audio.play('sell');
    this.spawnDamageNumber(b.x, b.y, refund, false, 0x7fd9ff);
  }

  private repairBuilding(b: Building, dt: number) {
    const missing = b.maxHp - b.hp;
    if (missing <= 0) return;
    const rate = 90 * this.perks.repairRate * dt;
    const heal = Math.min(missing, rate);
    const cost = heal * REPAIR_COST_PER_HP;
    if (this.ore < cost) return;
    this.ore -= cost;
    b.hp += heal;
    this.buffers.repair += heal;
    if (chance(dt * 20)) {
      this.particles.spawn(
        b.x + rand(-b.radius, b.radius), b.y + rand(-b.radius, b.radius),
        rand(-20, 20), rand(-60, -20), rand(0.2, 0.5), rand(1.5, 3), 0x5cf2a0, PKind.Spark,
      );
      audio.play('repair');
    }
  }

  removeBuilding(b: Building, destroyed: boolean) {
    b.dead = true;
    for (let y = b.ty; y < b.ty + b.size; y++) {
      for (let x = b.tx; x < b.tx + b.size; x++) {
        if (this.buildingAt[this.world.idx(x, y)] === b) {
          this.buildingAt[this.world.idx(x, y)] = null;
          this.world.field.setCost(x, y, 1);
        }
      }
    }
    if (b.nodeIndex >= 0) {
      const n = this.world.nodes[b.nodeIndex];
      if (n) n.claimedBy = -1;
    }
    const i = this.buildings.indexOf(b);
    if (i >= 0) this.buildings.splice(i, 1);

    // Any enemy chewing on it needs a new target.
    for (const e of this.enemies) if (e.targetBuilding === b) { e.targetBuilding = null; e.retargetIn = 0; }

    // A bay's drones have nowhere to unload and nothing to service them.
    if (b.def.droneSlots !== undefined) {
      for (const d of this.drones) if (!d.dead && d.bayId === b.id) this.killDrone(d, false);
    }

    if (destroyed) {
      this.runStats.structuresLost++;
      this.structuresLostThisWave++;
      const pal = this.level.palette;
      if (b.kind === 'generator') {
        // Reactors go off like a bomb — a real risk to a dense build.
        this.explode(b.x, b.y, 118, 90, 'player');
        audio.play('explodeBig');
        this.shake(16);
        this.addFlash(1, 0.7, 0.3, 0.35);
      } else {
        this.particles.explosion(b.x, b.y, b.radius * 1.5, 0xffa657, pal.rock);
        audio.play('explode');
        this.shake(6);
      }
      this.particles.gib(b.x, b.y, pal.rockLit, 12, 1.2);
    }
  }

  /* ====================================================================== */
  /* Power                                                                   */
  /* ====================================================================== */

  private updatePower() {
    let supply = 0, draw = 0;
    for (const b of this.buildings) {
      if (!b.built) continue;
      if (b.def.power < 0) supply += -b.def.power * this.perks.powerOutput;
      else draw += b.def.power;
    }
    this.power.supply = supply;
    this.power.draw = draw;
    this.power.efficiency = draw <= 0 ? 1 : clamp(supply / draw, 0.15, 1);
    for (const b of this.buildings) b.efficiency = b.def.power > 0 ? this.power.efficiency : 1;

    if (this.power.efficiency >= 1 && draw > this.runStats.bestPower) {
      this.runStats.bestPower = draw;
      this.progress.bump('powerCap', Math.floor(draw), 'max');
    }
  }

  /* ====================================================================== */
  /* Waves                                                                   */
  /* ====================================================================== */

  private updateWaves(dt: number) {
    switch (this.phase) {
      case 'prep': {
        this.prepRemaining -= dt;
        if (this.prepRemaining <= 0) this.beginWave();
        break;
      }
      case 'incoming':
      case 'combat':
      case 'boss': {
        this.waveTimer += dt;
        const plan = this.plan!;
        while (this.orderCursor < plan.orders.length && plan.orders[this.orderCursor].at <= this.waveTimer) {
          const o = plan.orders[this.orderCursor++];
          this.spawnFromGate(o.enemyId, o.gate, plan, o.elite);
        }
        if (this.phase === 'incoming' && this.waveTimer > 1.6) this.setPhase(plan.isBoss ? 'boss' : 'combat');

        const allSpawned = this.orderCursor >= plan.orders.length;
        const allDead = this.enemies.length === 0;
        if (allSpawned && allDead) {
          this.completeWave();
        } else if (allSpawned && this.waveTimer > plan.duration + this.stragglerGrace(plan)) {
          // Re-applied every frame, not once: a boss keeps spawning escorts, and
          // anything that arrives after the deadline has to be woken up too.
          this.enrageStragglers();
        }
        break;
      }
      case 'cleared': {
        this.prepRemaining -= dt;
        if (this.prepRemaining <= 0) {
          if (this.pendingDraft) break; // draft UI owns the flow
          this.beginWave();
        }
        break;
      }
      default:
        break;
    }

    for (const s of this.world.spawns) s.heat = Math.max(0, s.heat - dt * 1.5);
  }

  private beginWave() {
    this.plan = this.nextPlan ?? this.director.plan(this.waveIndex);
    this.nextPlan = null;
    this.orderCursor = 0;
    this.waveTimer = 0;
    this.spawnedThisWave = 0;
    this.killedThisWave = 0;
    this.structuresLostThisWave = 0;
    this.coreDamageThisWave = 0;
    this.stragglersEnraged = false;
    this.setPhase('incoming');

    if (this.plan.isBoss) {
      const bossDef = ENEMIES[this.level.boss];
      this.setBanner(
        enemyName(bossDef),
        tr('game.banner.finalWave', 'FINAL WAVE — {desc}', { desc: enemyDesc(bossDef) ?? '' }),
        5, '#ff4f5e',
      );
      audio.play('bossRoar');
      this.shake(20);
      this.addFlash(1, 0.2, 0.25, 0.4);
    } else {
      this.setBanner(
        tr('game.banner.wave', 'WAVE {n} / {total}', { n: this.waveIndex + 1, total: this.level.waves }),
        this.describeWave(this.plan), 3, '#ffb347',
      );
      audio.play('waveStart');
      this.shake(5);
    }
  }

  describeWave(plan: WavePlan): string {
    return plan.composition
      .slice(0, 4)
      .map((c) => {
        const def = ENEMIES[c.id];
        return tr('game.wave.composition', '{count}× {name}', { count: c.count, name: def ? enemyName(def) : c.id });
      })
      .join('  ·  ');
  }

  /**
   * Wakes up the remnant of an overstaying wave. Enraged units abandon whatever
   * structure they were gnawing on and drive for the core, so the wave always
   * terminates — either they die inside your kill zone or they reach the core and
   * force the issue. Nothing is ever silently despawned.
   *
   * Bosses get the behavioural half only. A ranged boss such as the Matriarch
   * otherwise kites from beyond every turret's reach and the wave cannot end;
   * making it close the distance resolves that *and* favours the player, whereas
   * buffing it mid-fight would punish someone legitimately grinding it down.
   */
  private stragglerGrace(plan: WavePlan) {
    // A legitimate boss fight routinely outlasts the scripted window, so its
    // escort gets far more rope before the game intervenes.
    return plan.isBoss ? STRAGGLER_GRACE * 4 : STRAGGLER_GRACE;
  }

  private enrageStragglers() {
    let n = 0;
    for (const e of this.enemies) {
      if (e.berserk) continue;
      e.berserk = true;
      e.targetBuilding = null;
      e.retargetIn = 0;
      if (!e.boss) {
        e.speed *= 1.35;
        e.damage *= 1.25;
      }
      n++;
      this.particles.ring(e.x, e.y, e.radius * 2.6, 0xff4f5e, 0.45);
    }
    if (n > 0 && !this.stragglersEnraged) {
      this.stragglersEnraged = true;
      this.setBanner(
        tr('game.banner.remnantTurns', 'THE REMNANT TURNS'),
        n > 1
          ? tr('game.banner.stragglersMany', '{n} stragglers charging the core', { n })
          : tr('game.banner.stragglersOne', '{n} straggler charging the core', { n }),
        2.8, '#ff4f5e',
      );
      audio.play('bossRoar');
    }
  }

  private completeWave() {
    this.runStats.wavesCleared++;
    this.progress.bump('wave');
    this.progress.recordRunStat('wavesSurvived', 1);
    this.progress.recordRunStat('bestWave', this.waveIndex + 1, 'max');
    if (this.structuresLostThisWave === 0) this.progress.bump('flawlessWave');

    const wasBoss = this.plan?.isBoss ?? false;
    if (wasBoss && this.mode === 'campaign') {
      this.finishLevel();
      return;
    }

    // Wave clear bonus scales with how intact your base is.
    const bonus = Math.round(28 + this.waveIndex * 14 + (this.structuresLostThisWave === 0 ? 40 : 0));
    this.ore += bonus;
    this.essence += Math.round(6 + this.waveIndex * 2);
    if (wasBoss) {
      // Endless boss cleared: a real payout, and the run keeps going.
      this.essence += 60;
      this.setBanner(
        tr('game.banner.bossDown', 'BOSS DOWN'),
        tr('game.banner.bossDownDetail', '+{bonus} ore  ·  the hive sends more', { bonus }),
        3.4, '#ffcc55',
      );
      audio.play('victory');
    } else {
      this.setBanner(
        tr('game.banner.waveCleared', 'WAVE CLEARED'),
        tr('game.banner.waveClearedDetail', '+{bonus} ore  ·  next wave in {seconds}s',
          { bonus, seconds: this.level.buildTime }),
        3, '#5cf2a0',
      );
      audio.play('levelUp');
    }

    this.waveIndex++;
    this.nextPlan = this.director.plan(this.waveIndex);
    this.prepRemaining = this.level.buildTime;
    this.setPhase('cleared');
    // Auto-save at the top of every build window: the most a crash can now cost
    // is the wave that was in progress.
    this.autoSaveRun();

    // Draft a tech card every third wave.
    if (this.waveIndex % 3 === 0) this.offerDraft();
  }

  /** Relics paid out by the sector just cleared; shown on the victory screen. */
  lastRelicAward = 0;
  /** Endless outcome, filled in on death: was this a new personal best? */
  endlessRecord: { waves: number; best: number; isRecord: boolean } | null = null;

  private finishLevel() {
    this.progress.markLevelCleared(this.levelIndex);
    this.lastRelicAward = this.progress.awardSectorClear(this.levelIndex);
    this.progress.bump('level');
    this.progress.recordRunStat('victories', 1);
    if (this.runStats.structuresLost === 0) {
      this.progress.bump('flawlessLevel');
      this.progress.recordRunStat('noLossVictories', 1);
    }
    if (this.levelIndex >= LEVELS.length - 1) this.progress.bump('campaign');
    // The run is over; nothing left to resume.
    this.discardSavedRun();
    audio.play('victory');
    this.hitstop = 0.5;
    this.setPhase('won');
    this.frozen = true;
  }

  private offerDraft() {
    const cards = this.rollDraft(Math.max(2, Math.round(this.perks.techChoices)));
    if (!cards.length) return;
    this.pendingDraft = cards;
    this.frozen = true;
    this.onDraft?.(cards);
  }

  rollDraft(count: number): TechCard[] {
    const taken = new Map<string, number>();
    for (const id of this.techTaken) taken.set(id, (taken.get(id) ?? 0) + 1);

    const eligible = TECH_CARDS.filter((c) => {
      if (c.unlock && this.unlockedBuildings.has(c.unlock)) return false;
      if (c.requires && !this.unlockedBuildings.has(c.requires)) return false;
      const stacks = taken.get(c.id) ?? 0;
      return stacks < (c.maxStacks ?? 99);
    });
    if (!eligible.length) return [];

    const chosen: TechCard[] = [];
    const pool = [...eligible];
    for (let i = 0; i < count && pool.length; i++) {
      const total = pool.reduce((s, c) => s + RARITY_WEIGHT[c.rarity], 0);
      let r = this.rng.next() * total;
      let idx = 0;
      for (let k = 0; k < pool.length; k++) {
        r -= RARITY_WEIGHT[pool[k].rarity];
        if (r <= 0) { idx = k; break; }
      }
      chosen.push(pool.splice(idx, 1)[0]);
    }
    return chosen;
  }

  takeTech(card: TechCard) {
    this.techTaken.push(card.id);
    if (card.perk) applyPerk(this.perks, card.perk);
    if (card.unlock) this.unlockedBuildings.add(card.unlock);

    switch (card.effect) {
      case 'freeOre': this.ore += card.value ?? 200; break;
      case 'freeEssence': this.essence += card.value ?? 100; break;
      case 'refillCore':
        this.core.maxHp = Math.round(CORE_BASE_HP * this.perks.coreHp);
        this.core.hp = this.core.maxHp;
        break;
      case 'repairAll':
        for (const b of this.buildings) b.hp = b.maxHp;
        break;
      default: break;
    }

    // Perks that change maxima need the live values re-derived.
    this.player.maxHp = Math.round(PLAYER_BASE_HP * this.perks.playerMaxHp);
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + 20);
    const newCoreMax = Math.round(CORE_BASE_HP * this.perks.coreHp);
    if (newCoreMax > this.core.maxHp) {
      this.core.hp += newCoreMax - this.core.maxHp;
      this.core.maxHp = newCoreMax;
    }
    for (const b of this.buildings) {
      const nm = Math.round(b.def.hp * this.perks.structureHp);
      if (nm !== b.maxHp) {
        const ratio = b.hp / b.maxHp;
        b.maxHp = nm;
        b.hp = Math.max(1, Math.round(nm * ratio));
      }
    }

    this.pendingDraft = null;
    this.frozen = false;
    audio.play('levelUp');
    this.setBanner(techName(card).toUpperCase(), techDesc(card), 3, '#b47cff');
  }

  private spawnFromGate(enemyId: string, gate: number, plan: WavePlan, elite: boolean) {
    const def = ENEMIES[enemyId];
    if (!def) return;
    const g = this.world.spawns[gate % this.world.spawns.length];
    g.heat = 1;

    // Nudge off-centre so a squad doesn't stack into one point.
    const a = rand(0, TAU);
    const r = rand(0, TILE * 1.8);
    // The jitter can push a unit into the rock ringing a gate; snap it back out.
    const spot = this.world.findOpenNear(
      clamp(g.x + Math.cos(a) * r, TILE, this.world.pxW - TILE),
      clamp(g.y + Math.sin(a) * r, TILE, this.world.pxH - TILE),
    );
    const x = spot.x;
    const y = spot.y;

    // Bosses already carry hand-authored stats per sector, so stacking the full
    // per-wave ramp on top of them (×8.5 on the last sector) made the final fight
    // a damage-sponge slog. They take a heavily damped share of it instead.
    const hpMult = def.boss ? 1 + (plan.hpMult - 1) * BOSS_SCALE_SHARE : plan.hpMult;
    const dmgMult = def.boss ? 1 + (plan.dmgMult - 1) * BOSS_SCALE_SHARE : plan.dmgMult;

    const e = this.spawnEnemy(def, x, y, hpMult, dmgMult, elite);
    e.wave = plan.index;
    this.spawnedThisWave++;
    if (def.boss) {
      this.bossRef = e;
      this.particles.explosion(x, y, 90, def.accent, this.level.palette.rock);
      this.shake(14);
    } else {
      this.particles.ring(x, y, 22, def.accent, 0.4);
      for (let i = 0; i < 6; i++) {
        const aa = rand(0, TAU);
        this.particles.spawn(x, y, Math.cos(aa) * rand(40, 140), Math.sin(aa) * rand(40, 140),
          rand(0.2, 0.5), rand(1.5, 3.5), def.accent, PKind.Spark);
      }
    }
  }

  spawnEnemy(def: EnemyDef, x: number, y: number, hpMult: number, dmgMult: number, elite: boolean): Enemy {
    const e = new Enemy(def, x, y, hpMult * (elite ? 1.9 : 1), dmgMult * (elite ? 1.4 : 1));
    e.elite = elite;
    if (elite) e.radius *= 1.18;
    this.enemies.push(e);
    return e;
  }

  /* ====================================================================== */
  /* Player                                                                  */
  /* ====================================================================== */

  private updatePlayer(dt: number, input: InputSource) {
    const p = this.player;
    if (p.dead) {
      // Downed players respawn at the core after a beat — the core is the fail state.
      p.invuln -= dt;
      if (p.invuln <= 0) {
        p.dead = false;
        p.hp = Math.round(p.maxHp * 0.5);
        p.x = this.core.x + rand(-40, 40);
        p.y = this.core.y + rand(-40, 40);
        p.invuln = 2.2;
        this.particles.ring(p.x, p.y, 40, 0x7fd9ff, 0.5);
      }
      return;
    }

    if (this.autoAim) {
      // Track the nearest live threat. The turn rate is finite so a target
      // crossing behind you is not hit instantly — auto-aim assists, it does
      // not make positioning irrelevant.
      const target = this.pickPlayerTarget();
      this.autoTarget = target;
      if (target) {
        const want = Math.atan2(target.y - p.y, target.x - p.x);
        p.aim = rotateToward(p.aim, want, dt * 14);
      }
    } else {
      this.autoTarget = null;
      p.aim = Math.atan2(this.mouseWorldY - p.y, this.mouseWorldX - p.x);
    }
    p.facing = rotateToward(p.facing, p.aim, dt * 12);
    p.hitFlash = Math.max(0, p.hitFlash - dt * 5);
    p.invuln = Math.max(0, p.invuln - dt);
    p.recoil = damp(p.recoil, 0, 14, dt);
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);

    if (this.perks.playerRegen > 0 && p.hp < p.maxHp) {
      p.hp = Math.min(p.maxHp, p.hp + this.perks.playerRegen * dt);
    }

    // Heat / overheat.
    if (p.overheated) {
      p.heat -= dt * 0.5;
      if (p.heat <= 0.25) { p.overheated = false; p.heat = 0.25; }
    } else {
      p.heat = Math.max(0, p.heat - dt * 0.42);
    }

    const speed = 232 * this.perks.playerSpeed;
    const ax = input.uiCaptured ? { x: 0, y: 0 } : input.axis();

    // Dash.
    if (p.dashTime > 0) {
      p.dashTime -= dt;
      p.vx = p.dashDirX * 640;
      p.vy = p.dashDirY * 640;
      p.invuln = Math.max(p.invuln, 0.08);
      if (chance(dt * 40)) {
        this.particles.spawn(p.x, p.y, rand(-30, 30), rand(-30, 30), 0.25, rand(3, 7), 0x7fd9ff, PKind.Glow);
      }
    } else {
      if (!input.uiCaptured && input.pressed('ShiftLeft') && p.dashCooldown <= 0 && (ax.x || ax.y)) {
        p.dashTime = 0.16;
        p.dashCooldown = 1.35;
        p.dashDirX = ax.x; p.dashDirY = ax.y;
        audio.play('shootHeavy');
        this.particles.ring(p.x, p.y, 26, 0x7fd9ff, 0.28);
      }
      p.vx = damp(p.vx, ax.x * speed, 16, dt);
      p.vy = damp(p.vy, ax.y * speed, 16, dt);
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    this.world.collideCircle(p, p.radius);
    this.collideWithBuildings(p, p.radius);
    // Keep the player out of the core's footprint.
    const dc = dist(p.x, p.y, this.core.x, this.core.y);
    if (dc < this.core.radius + p.radius) {
      const nx = (p.x - this.core.x) / (dc || 1), ny = (p.y - this.core.y) / (dc || 1);
      p.x = this.core.x + nx * (this.core.radius + p.radius);
      p.y = this.core.y + ny * (this.core.radius + p.radius);
    }

    const moved = Math.hypot(p.vx, p.vy);
    p.stride += moved * dt * 0.05;
    if (moved > 30 && chance(dt * 14)) {
      this.particles.spawn(p.x, p.y + 8, rand(-14, 14), rand(-6, 10), rand(0.25, 0.6),
        rand(2, 5), this.level.palette.ground1, PKind.Smoke, { additive: false, drag: 3 });
    }

    // Firing.
    p.cooldown -= dt;
    let wantFire = !input.uiCaptured && input.mouseDown(0) && this.cursorMode === 'normal';
    if (this.autoAim) {
      // Auto-fire manages heat on the player's behalf: it holds off near the
      // overheat threshold so the weapon never locks out, which preserves the
      // sustained-DPS ceiling without demanding a trigger finger.
      const locked = this.autoTarget !== null && !this.autoTarget.dead;
      const aligned = locked &&
        Math.abs(angleDelta(p.aim, Math.atan2(this.autoTarget!.y - p.y, this.autoTarget!.x - p.x))) < 0.22;
      wantFire = locked && aligned && p.heat < 0.85 && this.cursorMode !== 'build';
    }
    if (wantFire && p.cooldown <= 0 && !p.overheated) {
      this.playerShoot();
      p.cooldown = 1 / (7.4 * this.perks.playerFireRate);
      p.heat += 0.052;
      if (p.heat >= 1) { p.overheated = true; p.heat = 1; audio.play('error'); }
    }

    // Mining.
    p.miningNode = -1;
    if (this.autoMine) {
      // Nothing to decide here — mining is strictly good — so on touch it just
      // happens whenever a seam is in reach.
      const node = this.world.nearestNode(p.x, p.y, PLAYER_MINE_RANGE);
      if (node) {
        p.miningNode = this.world.nodes.indexOf(node);
        this.mine(node, dt);
      }
    } else if (!input.uiCaptured && input.mouseDown(2) && this.cursorMode === 'normal') {
      const node = this.world.nearestNode(this.mouseWorldX, this.mouseWorldY, TILE * 1.6);
      if (node) {
        const nx = (node.tx + 0.5) * TILE, ny = (node.ty + 0.5) * TILE;
        if (dist(p.x, p.y, nx, ny) < PLAYER_MINE_RANGE) {
          p.miningNode = this.world.nodes.indexOf(node);
          this.mine(node, dt);
        }
      }
    }
    if (p.miningNode < 0) p.miningHeat = damp(p.miningHeat, 0, 8, dt);
  }

  /**
   * Best target for the player's weapon: nearest visible enemy in range.
   *
   * Sticky — it keeps the current target while that target is still valid and
   * roughly as close as the alternative, so the aim does not jitter between two
   * equidistant enemies.
   */
  private pickPlayerTarget(): Enemy | null {
    const p = this.player;
    const range = PLAYER_AIM_RANGE;
    const list = this.enemyHash.query(p.x, p.y, range, this.queryBuf);
    let best: Enemy | null = null;
    let bestD = range * range;

    for (let i = 0; i < list.length; i++) {
      const e = this.enemies[list[i]];
      if (!e || e.dead || !e.targetable) continue;
      const d2 = dist2(p.x, p.y, e.x, e.y);
      if (d2 > bestD) continue;
      if (!this.world.lineOfSight(p.x, p.y, e.x, e.y)) continue;
      bestD = d2;
      best = e;
    }

    const cur = this.autoTarget;
    if (cur && !cur.dead && cur.targetable) {
      const dCur = dist2(p.x, p.y, cur.x, cur.y);
      // 30% hysteresis before switching away from a target already engaged.
      if (dCur <= range * range && dCur < bestD * 1.7 &&
          this.world.lineOfSight(p.x, p.y, cur.x, cur.y)) {
        return cur;
      }
    }
    return best;
  }

  private mine(node: OreNode, dt: number) {
    const p = this.player;
    p.miningHeat = Math.min(1, p.miningHeat + dt * 4);
    const rate = 30 * this.perks.miningSpeed * (node.rich ? 1.5 : 1);
    const got = this.world.drain(node, rate * dt);
    const gain = got * this.perks.oreYield;
    this.ore += gain;
    this.buffers.ore += gain;
    this.runStats.oreMined += gain;

    const nx = (node.tx + 0.5) * TILE, ny = (node.ty + 0.5) * TILE;
    if (chance(dt * 26)) {
      audio.play('mine', rand(0.9, 1.15));
      const a = Math.atan2(p.y - ny, p.x - nx) + rand(-0.6, 0.6);
      this.particles.spawn(nx + rand(-8, 8), ny + rand(-8, 8),
        Math.cos(a) * rand(60, 180), Math.sin(a) * rand(60, 180),
        rand(0.2, 0.5), rand(1.5, 3.5), this.level.palette.oreColor, PKind.Spark, { grav: 60 });
    }
    if (node.amount <= 0) {
      audio.play('mineDone');
      this.particles.explosion(nx, ny, 34, this.level.palette.oreColor, this.level.palette.rock);
      this.progress.bump('mineNode');
      this.shake(3);
    }
  }

  private playerShoot() {
    const p = this.player;
    const spread = 0.035;
    const a = p.aim + rand(-spread, spread);
    const mx = p.x + Math.cos(p.aim) * 22;
    const my = p.y + Math.sin(p.aim) * 22;
    const dmg = 16 * this.perks.playerDamage;

    this.fire({
      x: mx, y: my, angle: a, speed: 980, damage: dmg, kind: 'bullet',
      faction: 'player', color: 0xfff0a0, size: 3.4, life: 0.7,
      armorPierce: 2 + this.perks.armorShred, ownerId: 0, splash: 0,
    });

    // Recoil is expressed on the weapon sprite and the crosshair only — the
    // camera is deliberately left alone so sustained fire never shakes the view.
    p.recoil = 1;
    this.particles.muzzle(mx, my, p.aim, 0xffd98a, 1);
    audio.play('shoot', rand(0.94, 1.08));
  }

  /* ====================================================================== */
  /* Buildings                                                               */
  /* ====================================================================== */

  private updateBuildings(dt: number) {
    for (let i = this.buildings.length - 1; i >= 0; i--) {
      const b = this.buildings[i];
      b.hitFlash = Math.max(0, b.hitFlash - dt * 5);
      b.recoil = damp(b.recoil, 0, 12, dt);
      b.muzzleFlash = Math.max(0, b.muzzleFlash - dt * 9);

      if (!b.built) {
        b.progress = Math.min(1, b.progress + (dt / b.def.buildTime) * this.perks.buildSpeed);
        if (b.built) {
          this.particles.ring(b.x, b.y, b.radius * 2, 0x7fd9ff, 0.35);
          audio.play('mineDone');
          // A finished bay launches its whole complement at once — you paid for
          // the drones. The respawn timer exists to make *losses* hurt, not to
          // tax you for building the thing in the first place.
          if (b.def.droneSlots !== undefined) {
            for (let k = 0; k < Math.round(b.def.droneSlots); k++) this.spawnDrone(b);
            b.droneCooldown = 0;
          }
        }
        continue;
      }

      if (b.maxShield > 0) {
        b.shield = Math.min(b.maxShield, b.shield + b.maxShield * 0.12 * dt);
      }

      if (b.def.droneSlots !== undefined) this.updateDroneBay(b, dt);
      if (b.def.extractRate !== undefined) this.updateExtractor(b, dt);
      if (b.def.repairRate !== undefined) this.updateRepairBay(b, dt);
      if (b.def.shieldAmount !== undefined) this.updateShieldPylon(b, dt);
      if (b.isTurret) this.updateTurret(b, dt);
    }
  }

  private updateExtractor(b: Building, dt: number) {
    const node = b.nodeIndex >= 0 ? this.world.nodes[b.nodeIndex] : undefined;
    if (!node || node.amount <= 0) return;
    const rate = b.def.extractRate! * this.perks.extractorRate * b.efficiency * (node.rich ? 1.6 : 1);
    const got = this.world.drain(node, rate * dt);
    const gain = got * this.perks.oreYield;
    b.extractBuffer += gain;
    this.ore += gain;
    this.buffers.ore += gain;
    this.runStats.oreMined += gain;
    if (b.extractBuffer >= 10) {
      b.extractBuffer -= 10;
      this.particles.spawn(b.x, b.y - 6, rand(-14, 14), rand(-70, -40), 0.5, 3,
        this.level.palette.oreColor, PKind.Spark, { grav: 40 });
    }
    if (node.amount <= 0) this.progress.bump('mineNode');
  }

  /**
   * Keeps a bay's complement in the air.
   *
   * Losses are replaced on a timer rather than instantly, so a wave that catches
   * your drones in the open costs you real throughput for the next half-minute.
   */
  private updateDroneBay(b: Building, dt: number) {
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
    const a = rand(0, TAU);
    const d = new Drone(
      bay.x + Math.cos(a) * bay.radius,
      bay.y + Math.sin(a) * bay.radius,
      Math.round((bay.def.droneHp ?? 34) * this.perks.structureHp),
      Math.round(bay.def.droneCargo ?? 20),
      bay.id,
    );
    this.drones.push(d);
    this.particles.ring(d.x, d.y, 16, 0x7fd9ff, 0.3);
    return d;
  }

  /** Fills every bay to capacity at once, ignoring respawn timers. */
  fillDroneBays() {
    for (const b of this.buildings) {
      if (b.def.droneSlots === undefined || !b.built) continue;
      let live = 0;
      for (const d of this.drones) if (!d.dead && d.bayId === b.id) live++;
      for (let i = live; i < Math.round(b.def.droneSlots); i++) this.spawnDrone(b);
      b.droneCooldown = 0;
    }
  }

  private bayOf(d: Drone): Building | null {
    for (const b of this.buildings) if (b.id === d.bayId) return b;
    return null;
  }

  /**
   * Drone logistics: fly to a seam, cut ore into the hold, fly it home, repeat.
   *
   * The trade against an Extractor is deliberate — a drone is slower per seam
   * because of the round trip, but it re-targets when a seam runs dry instead of
   * becoming dead weight.
   */
  private updateDrones(dt: number) {
    const world = this.world;

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

          const rate = (def.droneMineRate ?? 4) * this.perks.extractorRate * bay.efficiency;
          const room = d.cargoMax - d.cargo;
          const took = world.drain(node, Math.min(room, rate * dt));
          d.cargo += took;
          if (chance(dt * 8)) {
            this.particles.spawn(tx + rand(-6, 6), ty + rand(-6, 6),
              rand(-30, 30), rand(-60, -20), rand(0.2, 0.45), rand(1.5, 3),
              this.level.palette.oreColor, PKind.Spark, { grav: 40 });
          }
          if (d.full || node.amount <= 0) {
            if (node.amount <= 0) this.progress.bump('mineNode');
            d.state = 'toBay';
          }
          break;
        }
        case 'toBay': {
          tx = bay.x;
          ty = bay.y;
          if (dist(d.x, d.y, tx, ty) < bay.radius + 12) {
            // Unload. Yield perks apply here, at the point of delivery.
            const gain = d.cargo * this.perks.oreYield;
            this.ore += gain;
            this.buffers.ore += gain;
            this.runStats.oreMined += gain;
            this.runStats.droneOre += gain;
            d.cargo = 0;
            bay.depositFlash = 1;
            audio.play('pickup', rand(1.15, 1.3));
            this.particles.ring(bay.x, bay.y, bay.radius * 1.2, this.level.palette.oreColor, 0.25);
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
    // How many of this bay's drones are already committed to each seam.
    const taken = new Map<number, number>();
    for (const d of this.drones) {
      if (d.dead || d.bayId !== bay.id || d.nodeIndex < 0) continue;
      taken.set(d.nodeIndex, (taken.get(d.nodeIndex) ?? 0) + 1);
    }

    let best = -1;
    let bestScore = Infinity;
    const maxD2 = range * range;
    for (let i = 0; i < this.world.nodes.length; i++) {
      const n = this.world.nodes[i];
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

  private killDrone(d: Drone, quiet: boolean) {
    if (d.dead) return;
    d.dead = true;
    this.runStats.dronesLost++;
    // Start the bay's rebuild clock here, at the moment of loss.
    const bay = this.bayOf(d);
    if (bay && !bay.dead) {
      bay.droneCooldown = Math.max(bay.droneCooldown, bay.def.droneRespawn ?? 20);
    }
    this.particles.explosion(d.x, d.y, 22, 0x7fd9ff, this.level.palette.rock);
    this.particles.gib(d.x, d.y, 0x4a5566, 5, 0.8);
    // Cargo in the hold is lost with it — that is the cost of the round trip.
    if (!quiet) audio.play('explode', rand(1.2, 1.4));
  }

  private updateRepairBay(b: Building, dt: number) {
    const rate = b.def.repairRate! * this.perks.repairRate * b.efficiency * dt;
    const r2 = b.def.auraRadius! * b.def.auraRadius!;
    let healed = 0;
    for (const t of this.buildings) {
      if (t.hp >= t.maxHp || !t.built) continue;
      if (dist2(b.x, b.y, t.x, t.y) > r2) continue;
      const heal = Math.min(t.maxHp - t.hp, rate);
      t.hp += heal;
      healed += heal;
      if (chance(dt * 6)) {
        this.particles.spawn(t.x + rand(-10, 10), t.y + rand(-10, 10), rand(-10, 10), rand(-40, -10),
          rand(0.3, 0.6), rand(1.5, 3), 0x5cf2a0, PKind.Spark);
      }
    }
    if (this.core.hp < this.core.maxHp && dist2(b.x, b.y, this.core.x, this.core.y) <= r2) {
      const heal = Math.min(this.core.maxHp - this.core.hp, rate * 1.5);
      this.core.hp += heal;
      healed += heal;
    }
    this.buffers.repair += healed;
  }

  private updateShieldPylon(b: Building, dt: number) {
    const amount = b.def.shieldAmount! * b.efficiency;
    const r2 = b.def.auraRadius! * b.def.auraRadius!;
    for (const t of this.buildings) {
      if (!t.built) continue;
      if (dist2(b.x, b.y, t.x, t.y) > r2) continue;
      if (t.maxShield < amount) t.maxShield = amount;
      t.shield = Math.min(t.maxShield, t.shield + amount * 0.25 * dt);
    }
    if (dist2(b.x, b.y, this.core.x, this.core.y) <= r2) {
      const coreShield = amount * 2.5;
      if (this.core.maxShield < coreShield) this.core.maxShield = coreShield;
      this.core.shield = Math.min(this.core.maxShield, this.core.shield + coreShield * 0.2 * dt);
    }
  }

  private updateTurret(b: Building, dt: number) {
    const def = b.def;
    const range = def.range! * this.perks.turretRange;

    // Retarget periodically, or immediately if the current target is gone.
    if (!b.target || b.target.dead || !b.target.targetable || dist2(b.x, b.y, b.target.x, b.target.y) > range * range) {
      b.target = this.findTarget(b, range);
    }

    if (!b.target) {
      b.beamIntensity = damp(b.beamIntensity, 0, 10, dt);
      // Idle sweep so the field feels alive.
      b.angle += Math.sin(this.elapsed * 0.6 + b.phase) * dt * 0.35;
      return;
    }

    const t = b.target;
    const lead = def.projectileSpeed
      ? dist(b.x, b.y, t.x, t.y) / def.projectileSpeed
      : 0;
    const px = t.x + t.vx * lead;
    const py = t.y + t.vy * lead;
    const want = Math.atan2(py - b.y, px - b.x);
    const turn = (def.turnRate ?? 5) * dt;
    b.angle = rotateToward(b.angle, want, turn);

    const aligned = Math.abs(((want - b.angle + Math.PI * 3) % TAU) - Math.PI) < 0.16;
    const rate = def.fireRate! * this.perks.turretFireRate * b.efficiency;

    if (def.beam) {
      // Continuous beam: damage is applied per second while locked on.
      if (aligned) {
        b.beamIntensity = damp(b.beamIntensity, 1, 12, dt);
        this.beamTick(b, dt, range);
        if (chance(dt * 12)) audio.play('laser', rand(0.9, 1.1));
      } else {
        b.beamIntensity = damp(b.beamIntensity, 0, 10, dt);
      }
      return;
    }

    b.cooldown -= dt;
    if (b.burstLeft > 0) {
      b.burstTimer -= dt;
      if (b.burstTimer <= 0) {
        this.turretFire(b, range);
        // Additionally damp burst follow-ups: retriggering every 75ms is what
        // turned the flak's twin muzzles into one continuous glare.
        const bf = b.def.muzzleFlare ?? 1;
        if (bf < 1) b.muzzleFlash = Math.min(b.muzzleFlash, 0.35 + bf * 0.3);
        b.burstLeft--;
        b.burstTimer = 0.075;
      }
      return;
    }
    if (b.cooldown <= 0 && aligned) {
      b.cooldown = 1 / Math.max(0.05, rate);
      if (def.burst && def.burst > 1) {
        b.burstLeft = def.burst - 1;
        b.burstTimer = 0.075;
      }
      this.turretFire(b, range);
    }
  }

  private findTarget(b: Building, range: number): Enemy | null {
    const def = b.def;
    const r2 = range * range;
    const list = this.enemyHash.query(b.x, b.y, range, this.queryBuf);
    let best: Enemy | null = null;
    let bestScore = -Infinity;

    for (let i = 0; i < list.length; i++) {
      const e = this.enemies[list[i]];
      if (!e || e.dead || !e.targetable) continue;
      if (def.antiAir === undefined && e.flying) continue;
      if (def.groundOnly && e.flying) continue;
      const d2 = dist2(b.x, b.y, e.x, e.y);
      if (d2 > r2) continue;
      // Mortars and missiles cannot arm inside their minimum engagement range.
      if (def.minRange && d2 < def.minRange * def.minRange) continue;

      let score: number;
      switch (b.targeting) {
        case 'closest': score = -d2; break;
        case 'strongest': score = e.hp + (e.boss ? 1e6 : 0); break;
        case 'weakest': score = -e.hp; break;
        default: {
          // 'first' = furthest along the path to the core.
          const d = this.world.field.distAt(Math.floor(e.x / TILE), Math.floor(e.y / TILE));
          score = -(Number.isFinite(d) ? d : 1e6);
          break;
        }
      }
      if (e.boss && b.targeting === 'first') score += 50;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  private turretFire(b: Building, range: number) {
    const def = b.def;
    const muzzleLen = b.radius * 0.9;
    const mx = b.x + Math.cos(b.angle) * muzzleLen;
    const my = b.y + Math.sin(b.angle) * muzzleLen;
    const dmg = def.damage! * this.perks.turretDamage;
    b.recoil = 1;
    // Low-flare guns never reach a full-intensity flash at all, not even on the
    // first round of a burst — that first slam was the remaining glare source.
    const flare = def.muzzleFlare ?? 1;
    b.muzzleFlash = flare >= 1 ? 1 : Math.min(1, 0.25 + flare * 0.75);

    if (def.chains) {
      this.arcChain(b, dmg, range);
      audio.play('tesla', rand(0.9, 1.1));
      return;
    }

    if (def.id === 'mortar') {
      const t = b.target!;
      const flight = clamp(dist(b.x, b.y, t.x, t.y) / def.projectileSpeed!, 0.6, 3.2);
      this.fireMortar(mx, my, t.x + t.vx * flight * 0.7, t.y + t.vy * flight * 0.7, dmg, def, b, flight);
      audio.play('shootHeavy', rand(0.85, 1.0));
      this.particles.muzzle(mx, my, b.angle, 0xffb066, 1.6);
      return;
    }

    const spread = def.spread ?? 0;
    const angle = b.angle + rand(-spread, spread);
    const kind: Projectile['kind'] = def.homing ? 'rocket'
      : def.splash ? (def.id === 'flak' ? 'flak' : 'shell')
      : 'bullet';

    // Missiles leave from alternating pods so a burst reads as two launches.
    let ox = 0, oy = 0;
    if (def.homing) {
      const side = b.burstLeft % 2 === 0 ? 1 : -1;
      ox = -Math.sin(b.angle) * b.radius * 0.42 * side;
      oy = Math.cos(b.angle) * b.radius * 0.42 * side;
    }

    this.fire({
      x: mx + ox, y: my + oy, angle, speed: def.projectileSpeed!, damage: dmg, kind,
      faction: 'player',
      color: def.homing ? 0xffb8a0
        : def.id === 'cannon' ? 0xffb066
        : def.id === 'flak' ? 0xffe08a
        : 0x9fe8ff,
      size: def.homing ? 6 : def.splash ? 5 : 3,
      // Guided shots need extra flight time because they curve rather than fly straight.
      life: (range / def.projectileSpeed!) * (def.homing ? 2.4 : 1.35),
      armorPierce: (def.armorPierce ?? 0) + this.perks.armorShred,
      ownerId: b.id, splash: def.splash ?? 0,
      homingTarget: def.homing ? b.target : null,
      homingTurn: def.homingTurn ?? 0,
    });

    this.particles.muzzle(mx + ox, my + oy, b.angle,
      def.homing ? 0xffd0b0 : def.splash ? 0xffb066 : 0xbfe8ff,
      (def.homing ? 1.8 : def.splash ? 1.5 : 0.9) * (def.muzzleFlare ?? 1));
    audio.play(def.splash ? 'shootHeavy' : 'shoot', rand(0.9, 1.1));
  }

  /** Tesla chain: hop between nearby enemies, losing damage each jump. */
  private arcChain(b: Building, dmg: number, range: number) {
    const hops = b.def.chains!;
    let cur: { x: number; y: number } = b;
    const hit = new Set<number>();
    let power = dmg;

    for (let i = 0; i < hops; i++) {
      const searchR = i === 0 ? range : 120;
      const list = this.enemyHash.query(cur.x, cur.y, searchR, this.queryBuf);
      let next: Enemy | null = null;
      let bestD = searchR * searchR;
      for (let k = 0; k < list.length; k++) {
        const e = this.enemies[list[k]];
        if (!e || e.dead || !e.targetable || hit.has(e.id)) continue;
        const d2 = dist2(cur.x, cur.y, e.x, e.y);
        if (d2 < bestD) { bestD = d2; next = e; }
      }
      if (!next) break;
      hit.add(next.id);
      this.effects.push({
        kind: 'arc', x: cur.x, y: cur.y, x2: next.x, y2: next.y,
        radius: 0, life: 0.16, maxLife: 0.16, color: 0x9fd8ff, width: 3 - i * 0.4,
        seed: Math.random() * 1000,
      });
      this.damageEnemy(next, power, { source: 'turret', armorPierce: this.perks.armorShred, building: b });
      if (b.def.slowFactor) {
        next.slowTimer = Math.max(next.slowTimer, 1.6);
        next.slowFactor = b.def.slowFactor;
      }
      cur = next;
      power *= 0.72;
    }
  }

  /** Lance beam: pierces up to `pierce` bodies along a ray. */
  private beamTick(b: Building, dt: number, range: number) {
    const def = b.def;
    const dps = def.damage! * this.perks.turretDamage * def.fireRate! * b.efficiency;
    const dirX = Math.cos(b.angle), dirY = Math.sin(b.angle);

    // Truncate the beam at terrain.
    let reach = range;
    const steps = Math.ceil(range / (TILE * 0.5));
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * range;
      if (this.world.solidAtPx(b.x + dirX * t, b.y + dirY * t)) { reach = t; break; }
    }
    b.beamHitX = b.x + dirX * reach;
    b.beamHitY = b.y + dirY * reach;

    const list = this.enemyHash.query(
      b.x + dirX * reach * 0.5, b.y + dirY * reach * 0.5, reach * 0.5 + 40, this.queryBuf,
    );
    const along: { e: Enemy; t: number }[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = this.enemies[list[i]];
      if (!e || e.dead || !e.targetable) continue;
      const rx = e.x - b.x, ry = e.y - b.y;
      const t = rx * dirX + ry * dirY;
      if (t < 0 || t > reach) continue;
      const perp = Math.abs(rx * dirY - ry * dirX);
      if (perp > e.radius + 7) continue;
      along.push({ e, t });
    }
    along.sort((a, c) => a.t - c.t);
    const limit = def.pierce ?? 1;
    for (let i = 0; i < Math.min(limit, along.length); i++) {
      const { e } = along[i];
      this.damageEnemy(e, dps * dt, {
        source: 'turret', armorPierce: 999, building: b, silent: true,
      });
      if (chance(dt * 22)) {
        this.particles.spawn(e.x, e.y, rand(-60, 60), rand(-60, 60), rand(0.1, 0.3),
          rand(1.5, 3), def.beamColor ?? 0xff6fd0, PKind.Spark);
      }
    }
    if (along.length) {
      const first = along[0];
      b.beamHitX = b.x + dirX * first.t;
      b.beamHitY = b.y + dirY * first.t;
    }
  }

  /* ====================================================================== */
  /* Enemies                                                                 */
  /* ====================================================================== */

  private rebuildEnemyHash() {
    this.enemyHash.clear();
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      this.enemyHash.insert(i, e.x, e.y);
    }
  }

  private flowOut = { x: 0, y: 0 };

  private updateEnemies(dt: number) {
    const world = this.world;
    const field = world.field;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.dead) { this.enemies.splice(i, 1); continue; }

      e.anim += dt;
      e.hitFlash = Math.max(0, e.hitFlash - dt * 6);
      e.slowTimer = Math.max(0, e.slowTimer - dt);
      e.stunTimer = Math.max(0, e.stunTimer - dt);
      e.retargetIn -= dt;
      e.attackCooldown -= dt;

      if (e.burnTimer > 0) {
        e.burnTimer -= dt;
        this.damageEnemy(e, e.burnDps * dt, { source: 'burn', silent: true, armorPierce: 999 });
        if (e.dead) continue;
        if (chance(dt * 10)) {
          this.particles.spawn(e.x + rand(-6, 6), e.y + rand(-6, 6), rand(-10, 10), rand(-50, -20),
            rand(0.2, 0.5), rand(2, 4), 0xff8a3c, PKind.Ember);
        }
      }

      if (e.boss) this.updateBossAbilities(e, dt);

      // Burrowers periodically submerge and phase through everything.
      if (e.def.behavior === 'burrower') {
        e.burrowCooldown -= dt;
        if (e.submerged) {
          e.burrowTimer -= dt;
          if (e.burrowTimer <= 0) {
            e.submerged = false;
            e.burrowCooldown = e.def.phaseInterval ?? 4.5;
            this.particles.explosion(e.x, e.y, 30, e.def.accent, this.level.palette.rock);
            audio.play('kill');
          }
        } else if (e.burrowCooldown <= 0) {
          e.submerged = true;
          e.burrowTimer = 2.4;
          this.particles.dust(e.x, e.y, this.level.palette.rockLit, 10);
        }
      }

      // Support aura.
      if (e.def.behavior === 'support' && e.def.auraRadius) {
        e.auraPhase += dt * 2;
        const r2 = e.def.auraRadius * e.def.auraRadius;
        const list = this.enemyHash.query(e.x, e.y, e.def.auraRadius, this.queryBuf);
        for (let k = 0; k < list.length; k++) {
          const o = this.enemies[list[k]];
          if (!o || o === e || o.dead) continue;
          if (dist2(e.x, e.y, o.x, o.y) > r2) continue;
          o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.05 * dt);
          o.armor = Math.max(o.armor, o.def.armor + 3);
        }
      }

      const desired = this.enemyDesire(e, dt);

      if (e.stunTimer <= 0 && e.chargeTimer <= 0) {
        const sp = e.effectiveSpeed;
        e.vx = damp(e.vx, desired.x * sp, 9, dt);
        e.vy = damp(e.vy, desired.y * sp, 9, dt);
      } else if (e.chargeTimer > 0) {
        e.chargeTimer -= dt;
        e.vx = e.chargeDirX * (e.def.abilities ? 520 : 400);
        e.vy = e.chargeDirY * (e.def.abilities ? 520 : 400);
        if (chance(dt * 30)) {
          this.particles.spawn(e.x, e.y, rand(-40, 40), rand(-40, 40), 0.3, rand(4, 9), e.def.accent, PKind.Glow);
        }
      } else {
        e.vx = damp(e.vx, 0, 12, dt);
        e.vy = damp(e.vy, 0, 12, dt);
      }

      // Separation, so packs spread instead of stacking into one pixel.
      if (!e.flying && !e.boss) {
        const list = this.enemyHash.query(e.x, e.y, e.radius * 2.4, this.queryBuf);
        let px = 0, py = 0, n = 0;
        for (let k = 0; k < list.length && n < 6; k++) {
          const o = this.enemies[list[k]];
          if (!o || o === e || o.dead) continue;
          const dx = e.x - o.x, dy = e.y - o.y;
          const d2 = dx * dx + dy * dy;
          const rr = (e.radius + o.radius) * 0.95;
          if (d2 > rr * rr || d2 < 1e-4) continue;
          const d = Math.sqrt(d2);
          px += (dx / d) * (rr - d);
          py += (dy / d) * (rr - d);
          n++;
        }
        if (n) { e.x += px * 0.5; e.y += py * 0.5; }
      }

      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.gait += Math.hypot(e.vx, e.vy) * dt * 0.06;
      if (Math.abs(e.vx) + Math.abs(e.vy) > 4) {
        e.angle = rotateToward(e.angle, Math.atan2(e.vy, e.vx), dt * 9);
      }

      if (!e.flying && !e.submerged) {
        world.collideCircle(e, e.radius);
        // Belt and braces: if anything still ends the tick buried in rock (a
        // surfacing burrower, a hard knockback), it would be both immobile and
        // unhittable. Eject it to the nearest reachable tile instead.
        if (world.solidAtPx(e.x, e.y)) {
          const out = world.findOpenNear(e.x, e.y);
          e.x = out.x; e.y = out.y;
          e.vx = 0; e.vy = 0;
        }
        const blocker = this.collideWithBuildings(e, e.radius);
        if (blocker && e.def.behavior !== 'ranged') {
          e.targetBuilding = blocker;
          e.targetIsCore = false;
        }
      } else {
        e.x = clamp(e.x, e.radius, world.pxW - e.radius);
        e.y = clamp(e.y, e.radius, world.pxH - e.radius);
      }

      this.enemyAttack(e, dt);

      // Ambient trail.
      if (e.boss && chance(dt * 30)) {
        this.particles.spawn(e.x + rand(-e.radius, e.radius), e.y + rand(-e.radius, e.radius),
          rand(-20, 20), rand(-40, -10), rand(0.5, 1.2), rand(6, 16),
          e.def.color, PKind.Smoke, { additive: false, drag: 1.2 });
      }
      void field;
    }
  }

  /** Movement intent for one enemy, as a unit vector. */
  private enemyDesire(e: Enemy, dt: number): { x: number; y: number } {
    const out = this.flowOut;
    const beh = e.def.behavior;

    // Fliers and submerged burrowers ignore the field entirely.
    if (e.flying || e.submerged) {
      const tx = this.core.x, ty = this.core.y;
      const d = Math.hypot(tx - e.x, ty - e.y) || 1;
      out.x = (tx - e.x) / d;
      out.y = (ty - e.y) / d;
      if (e.flying) {
        // Lazy sine drift so moths don't fly in perfect lines.
        const perpX = -out.y, perpY = out.x;
        const w = Math.sin(e.anim * 2.2 + e.id) * 0.4;
        out.x += perpX * w; out.y += perpY * w;
        const l = Math.hypot(out.x, out.y) || 1;
        out.x /= l; out.y /= l;
      }
      return out;
    }

    // Ranged units hold at range once they have a target in sight. Enraged
    // stragglers give that up and close on the core instead.
    if (beh === 'ranged' && !e.berserk) {
      const target = this.pickRangedTarget(e);
      if (target) {
        const d = dist(e.x, e.y, target.x, target.y);
        const want = e.def.attackRange * 0.78;
        const dir = (d - want) / (Math.abs(d - want) || 1);
        if (Math.abs(d - want) < 18) { out.x = 0; out.y = 0; return out; }
        out.x = ((target.x - e.x) / (d || 1)) * dir;
        out.y = ((target.y - e.y) / (d || 1)) * dir;
        return out;
      }
    }

    // Brutes divert to nearby structures.
    if (beh === 'brute' && !e.berserk && e.retargetIn <= 0) {
      e.retargetIn = 0.6;
      const b = this.nearestBuilding(e.x, e.y, 240);
      e.targetBuilding = b;
    }
    if (!e.berserk && e.targetBuilding && !e.targetBuilding.dead) {
      const t = e.targetBuilding;
      const d = dist(e.x, e.y, t.x, t.y);
      if (d > t.radius + e.radius + e.def.attackRange) {
        out.x = (t.x - e.x) / (d || 1);
        out.y = (t.y - e.y) / (d || 1);
        return out;
      }
      out.x = 0; out.y = 0;
      return out;
    }

    // Default: follow the flow field to the core.
    const tx = Math.floor(e.x / TILE);
    const ty = Math.floor(e.y / TILE);
    const fx = e.x / TILE - tx;
    const fy = e.y / TILE - ty;
    this.world.field.sample(tx, ty, fx, fy, out);

    // Swarm units drift toward their neighbours' heading for a flocking feel.
    if (e.def.behavior === 'swarm') {
      const list = this.enemyHash.query(e.x, e.y, 70, this.queryBuf);
      let ax = 0, ay = 0, n = 0;
      for (let k = 0; k < list.length && n < 5; k++) {
        const o = this.enemies[list[k]];
        if (!o || o === e || o.dead) continue;
        ax += o.vx; ay += o.vy; n++;
      }
      if (n) {
        const l = Math.hypot(ax, ay) || 1;
        out.x = out.x * 0.75 + (ax / l) * 0.25;
        out.y = out.y * 0.75 + (ay / l) * 0.25;
        const ll = Math.hypot(out.x, out.y) || 1;
        out.x /= ll; out.y /= ll;
      }
    }
    void dt;
    return out;
  }

  private pickRangedTarget(e: Enemy): { x: number; y: number; radius: number } | null {
    const range = e.def.attackRange;
    let best: { x: number; y: number; radius: number } | null = null;
    let bestD = range * range;

    for (const b of this.buildings) {
      const d2 = dist2(e.x, e.y, b.x, b.y);
      if (d2 < bestD && this.world.lineOfSight(e.x, e.y, b.x, b.y)) { bestD = d2; best = b; }
    }
    const dCore = dist2(e.x, e.y, this.core.x, this.core.y);
    if (dCore < bestD && this.world.lineOfSight(e.x, e.y, this.core.x, this.core.y)) {
      bestD = dCore; best = this.core;
    }
    const dp = dist2(e.x, e.y, this.player.x, this.player.y);
    if (!this.player.dead && dp < bestD * 0.7 && this.world.lineOfSight(e.x, e.y, this.player.x, this.player.y)) {
      best = this.player;
    }
    return best;
  }

  private nearestBuilding(x: number, y: number, maxR: number): Building | null {
    let best: Building | null = null;
    let bestD = maxR * maxR;
    for (const b of this.buildings) {
      const d2 = dist2(x, y, b.x, b.y);
      if (d2 < bestD) { bestD = d2; best = b; }
    }
    return best;
  }

  private enemyAttack(e: Enemy, dt: number) {
    if (e.submerged || e.stunTimer > 0) return;
    const beh = e.def.behavior;
    if (beh === 'support') return;

    // Bombers detonate on anything they touch.
    if (beh === 'bomber') {
      const reach = e.radius + e.def.attackRange;
      let contact: { x: number; y: number } | null = null;
      if (dist(e.x, e.y, this.core.x, this.core.y) < reach + this.core.radius) contact = this.core;
      if (!contact) {
        const b = this.nearestBuilding(e.x, e.y, reach + 34);
        if (b && dist(e.x, e.y, b.x, b.y) < reach + b.radius) contact = b;
      }
      if (!contact && !this.player.dead && dist(e.x, e.y, this.player.x, this.player.y) < reach + this.player.radius) {
        contact = this.player;
      }
      if (contact) {
        this.explode(e.x, e.y, e.def.splashRadius ?? 70, e.damage, 'hive');
        audio.play('explode');
        this.shake(8);
        this.killEnemy(e, 'self', false);
      }
      return;
    }

    if (e.attackCooldown > 0) return;

    if (beh === 'ranged') {
      const t = this.pickRangedTarget(e);
      if (!t) return;
      const d = dist(e.x, e.y, t.x, t.y);
      if (d > e.def.attackRange) return;
      e.attackCooldown = 1 / e.def.attackRate;
      const a = Math.atan2(t.y - e.y, t.x - e.x) + rand(-0.06, 0.06);
      this.fire({
        x: e.x + Math.cos(a) * e.radius, y: e.y + Math.sin(a) * e.radius,
        angle: a, speed: e.def.projectileSpeed ?? 250, damage: e.damage,
        kind: e.boss ? 'bossOrb' : 'spit', faction: 'hive',
        color: e.def.accent, size: e.boss ? 9 : 5,
        life: (e.def.attackRange / (e.def.projectileSpeed ?? 250)) * 1.5,
        armorPierce: 0, ownerId: e.id, splash: e.def.splashRadius ?? 0,
      });
      this.particles.muzzle(e.x + Math.cos(a) * e.radius, e.y + Math.sin(a) * e.radius, a, e.def.accent, 1);
      audio.play('shoot', rand(0.6, 0.75));
      return;
    }

    // Melee: core first if in reach, then the assigned structure, then the player.
    const reach = e.radius + e.def.attackRange;
    if (dist(e.x, e.y, this.core.x, this.core.y) < reach + this.core.radius) {
      e.attackCooldown = 1 / e.def.attackRate;
      this.damageCore(e.damage);
      this.slashFx(e, this.core.x, this.core.y);
      return;
    }
    if (e.targetBuilding && !e.targetBuilding.dead) {
      const b = e.targetBuilding;
      if (dist(e.x, e.y, b.x, b.y) < reach + b.radius) {
        e.attackCooldown = 1 / e.def.attackRate;
        this.damageBuilding(b, e.damage);
        this.slashFx(e, b.x, b.y);
        return;
      }
    }
    if (!this.player.dead && dist(e.x, e.y, this.player.x, this.player.y) < reach + this.player.radius) {
      e.attackCooldown = 1 / e.def.attackRate;
      this.damagePlayer(e.damage * 0.6);
      this.slashFx(e, this.player.x, this.player.y);
    }
    void dt;
  }

  private slashFx(e: Enemy, tx: number, ty: number) {
    const a = Math.atan2(ty - e.y, tx - e.x);
    this.particles.impact(e.x + Math.cos(a) * e.radius, e.y + Math.sin(a) * e.radius, a, e.def.accent, 1.1);
    audio.play('hit', rand(0.7, 0.9));
  }

  /* ---- boss abilities --------------------------------------------------- */

  private updateBossAbilities(e: Enemy, dt: number) {
    const abilities = e.def.abilities;
    if (!abilities) return;

    if (e.shieldHp > 0) {
      e.shieldHp = Math.max(0, e.shieldHp - e.shieldMax * 0.04 * dt);
    }

    if (e.castingIndex >= 0) {
      e.castTimer -= dt;
      const ab = abilities[e.castingIndex];
      // Telegraph ring grows through the wind-up.
      if (chance(dt * 30)) {
        const t = 1 - e.castTimer / ab.telegraph;
        this.particles.spawn(
          e.x + rand(-e.radius, e.radius), e.y + rand(-e.radius, e.radius),
          rand(-30, 30), rand(-80, -20), rand(0.2, 0.5), rand(2, 5),
          0xff4f5e, PKind.Spark, { drag: 2 },
        );
        void t;
      }
      if (e.castTimer <= 0) {
        this.resolveBossAbility(e, e.castingIndex);
        e.castingIndex = -1;
      }
      return;
    }

    for (let i = 0; i < abilities.length; i++) {
      e.abilityCd[i] -= dt;
      if (e.abilityCd[i] > 0) continue;
      const ab = abilities[i];
      // Only cast when it can matter.
      if (ab.id === 'slam' && dist(e.x, e.y, this.core.x, this.core.y) > 420 &&
          !this.nearestBuilding(e.x, e.y, 260) && dist(e.x, e.y, this.player.x, this.player.y) > 320) continue;
      e.abilityCd[i] = ab.cooldown;
      e.castingIndex = i;
      e.castTimer = ab.telegraph;
      const radius = ab.id === 'slam' ? 210 : ab.id === 'beam' ? 40 : e.radius * 2.2;
      this.effects.push({
        kind: 'telegraph', x: e.x, y: e.y,
        x2: this.core.x, y2: this.core.y,
        radius, life: ab.telegraph, maxLife: ab.telegraph,
        color: 0xff4f5e, width: 3, seed: Math.random() * 1000,
      });
      audio.play('coreCritical');
      break;
    }
  }

  private resolveBossAbility(e: Enemy, index: number) {
    const ab = e.def.abilities![index];
    switch (ab.id) {
      case 'slam': {
        this.explode(e.x, e.y, 210, ab.value, 'hive');
        this.effects.push({
          kind: 'shock', x: e.x, y: e.y, x2: 0, y2: 0,
          radius: 210, life: 0.5, maxLife: 0.5, color: 0xff8a5c, width: 8, seed: 0,
        });
        audio.play('explodeBig');
        this.shake(22);
        this.addFlash(1, 0.5, 0.3, 0.3);
        break;
      }
      case 'spawn': {
        const roster = this.level.roster.filter((r) => (ENEMIES[r]?.cost ?? 9) <= 3);
        const pool = roster.length ? roster : ['crawler'];
        for (let i = 0; i < ab.value; i++) {
          const a = (i / ab.value) * TAU + rand(-0.2, 0.2);
          const r = e.radius + rand(20, 60);
          const def = ENEMIES[pool[randInt(0, pool.length - 1)]];
          const at = this.world.findOpenNear(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r);
          const child = this.spawnEnemy(def, at.x, at.y,
            this.plan?.hpMult ?? 1, this.plan?.dmgMult ?? 1, false);
          child.wave = this.waveIndex;
          child.spawnedBy = e.id;
          this.particles.ring(child.x, child.y, 18, def.accent, 0.3);
        }
        audio.play('bossRoar');
        this.shake(8);
        break;
      }
      case 'beam': {
        // Sweeps toward the core, damaging everything on the line.
        const a = Math.atan2(this.core.y - e.y, this.core.x - e.x);
        const len = 900;
        const ex = e.x + Math.cos(a) * len, ey = e.y + Math.sin(a) * len;
        this.effects.push({
          kind: 'beam', x: e.x, y: e.y, x2: ex, y2: ey,
          radius: 26, life: 0.45, maxLife: 0.45, color: 0xff4f5e, width: 26, seed: 0,
        });
        this.damageAlongLine(e.x, e.y, ex, ey, 26, ab.value);
        audio.play('laser', 0.5);
        this.shake(14);
        break;
      }
      case 'charge': {
        const a = Math.atan2(this.core.y - e.y, this.core.x - e.x);
        e.chargeDirX = Math.cos(a);
        e.chargeDirY = Math.sin(a);
        e.chargeTimer = ab.value / 520;
        audio.play('shootHeavy', 0.5);
        break;
      }
      case 'volley': {
        const base = Math.atan2(this.core.y - e.y, this.core.x - e.x);
        for (let i = 0; i < ab.value; i++) {
          const a = base + (i - ab.value / 2) * 0.16;
          this.fire({
            x: e.x, y: e.y, angle: a, speed: 300, damage: e.damage * 0.6,
            kind: 'bossOrb', faction: 'hive', color: e.def.accent, size: 8,
            life: 3.4, armorPierce: 0, ownerId: e.id, splash: 40,
          });
        }
        audio.play('shootHeavy', 0.7);
        break;
      }
      case 'shield': {
        e.shieldMax = ab.value;
        e.shieldHp = ab.value;
        this.particles.ring(e.x, e.y, e.radius * 3, 0x9fd8ff, 0.6);
        audio.play('levelUp');
        break;
      }
    }
  }

  private damageAlongLine(x0: number, y0: number, x1: number, y1: number, width: number, damage: number) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len, ny = dy / len;

    const hitBody = (b: { x: number; y: number; radius: number }) => {
      const rx = b.x - x0, ry = b.y - y0;
      const t = rx * nx + ry * ny;
      if (t < 0 || t > len) return false;
      return Math.abs(rx * ny - ry * nx) < width + b.radius;
    };

    for (let i = this.buildings.length - 1; i >= 0; i--) {
      const b = this.buildings[i];
      if (hitBody(b)) this.damageBuilding(b, damage);
    }
    if (hitBody(this.core)) this.damageCore(damage);
    if (!this.player.dead && hitBody(this.player)) this.damagePlayer(damage * 0.5);
  }

  /* ====================================================================== */
  /* Projectiles                                                             */
  /* ====================================================================== */

  private fire(o: {
    x: number; y: number; angle: number; speed: number; damage: number;
    kind: Projectile['kind']; faction: Projectile['faction']; color: number;
    size: number; life: number; armorPierce: number; ownerId: number; splash: number;
    pierce?: number; slowFactor?: number;
    homingTarget?: Enemy | null; homingTurn?: number;
  }) {
    const p = this.getProjectile();
    if (!p) return;
    p.dead = false;
    p.x = o.x; p.y = o.y;
    p.vx = Math.cos(o.angle) * o.speed;
    p.vy = Math.sin(o.angle) * o.speed;
    p.kind = o.kind;
    p.faction = o.faction;
    p.damage = o.damage;
    p.splash = o.splash;
    p.armorPierce = o.armorPierce;
    p.pierce = o.pierce ?? 0;
    p.life = o.life;
    p.maxLife = o.life;
    p.color = o.color;
    p.size = o.size;
    p.radius = Math.max(2, o.size * 0.7);
    p.ownerId = o.ownerId;
    p.hitIds.length = 0;
    p.z = 0;
    p.flightTime = 0;
    p.flightTotal = 0;
    p.trail = 0;
    p.exhaust = 0;
    p.slowFactor = o.slowFactor ?? 0;
    p.target = o.homingTarget ?? null;
    p.homingTurn = o.homingTurn ?? 0;
  }

  private fireMortar(
    x: number, y: number, tx: number, ty: number,
    damage: number, def: BuildingDef, owner: Building, flight: number,
  ) {
    const p = this.getProjectile();
    if (!p) return;
    p.dead = false;
    p.kind = 'mortar';
    p.faction = 'player';
    p.x = x; p.y = y;
    p.targetX = clamp(tx, 0, this.world.pxW);
    p.targetY = clamp(ty, 0, this.world.pxH);
    p.vx = (p.targetX - x) / flight;
    p.vy = (p.targetY - y) / flight;
    p.damage = damage;
    p.splash = def.splash ?? 80;
    p.armorPierce = (def.armorPierce ?? 0) + this.perks.armorShred;
    p.life = flight;
    p.maxLife = flight;
    p.flightTotal = flight;
    p.flightTime = 0;
    p.color = 0xffb066;
    p.size = 6;
    p.radius = 5;
    p.ownerId = owner.id;
    p.hitIds.length = 0;
    p.pierce = 0;
  }

  private getProjectile(): Projectile | null {
    for (const p of this.projectiles) if (p.dead) return p;
    if (this.projectiles.length >= MAX_PROJECTILES) return null;
    const p = new Projectile();
    this.projectiles.push(p);
    return p;
  }

  private updateProjectiles(dt: number) {
    for (const p of this.projectiles) {
      if (p.dead) {
        // Pooled slots must not pin a dead Enemy alive through their lock.
        if (p.target) p.target = null;
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) {
        if (p.kind === 'mortar' || p.splash > 0) this.detonate(p);
        p.dead = true;
        continue;
      }

      if (p.homingTurn > 0) this.guide(p, dt);

      if (p.kind === 'mortar') {
        p.flightTime += dt;
        const t = clamp(p.flightTime / p.flightTotal, 0, 1);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z = Math.sin(t * Math.PI) * 110;
        if (t >= 1) { this.detonate(p); p.dead = true; }
        continue;
      }

      const steps = Math.hypot(p.vx, p.vy) * dt > 18 ? 2 : 1;
      const sdt = dt / steps;
      for (let s = 0; s < steps && !p.dead; s++) {
        p.x += p.vx * sdt;
        p.y += p.vy * sdt;

        if (p.x < 0 || p.y < 0 || p.x > this.world.pxW || p.y > this.world.pxH) { p.dead = true; break; }
        if (this.world.solidAtPx(p.x, p.y)) {
          this.particles.impact(p.x, p.y, Math.atan2(p.vy, p.vx), this.level.palette.rockLit, 0.9);
          if (p.splash > 0) this.detonate(p);
          p.dead = true;
          break;
        }

        if (p.faction === 'player') this.projectileVsEnemies(p);
        else this.projectileVsPlayerSide(p);
      }

      // Trails.
      p.trail += dt;
      if (p.trail > 0.012) {
        p.trail = 0;
        this.particles.spawn(p.x, p.y, 0, 0, p.kind === 'bullet' ? 0.07 : 0.16,
          p.size * 0.8, p.color, PKind.Trail, { drag: 0.5 });
      }

      // Rocket exhaust: a fatter smoke plume behind the warhead.
      if (p.kind === 'rocket') {
        p.exhaust += dt;
        if (p.exhaust > 0.03) {
          p.exhaust = 0;
          const a = Math.atan2(p.vy, p.vx) + Math.PI;
          const bx = p.x + Math.cos(a) * p.size;
          const by = p.y + Math.sin(a) * p.size;
          this.particles.spawn(bx, by,
            Math.cos(a) * rand(20, 70) + rand(-18, 18),
            Math.sin(a) * rand(20, 70) + rand(-18, 18),
            rand(0.35, 0.8), rand(4, 8), 0x6b7383, PKind.Smoke,
            { drag: 1.6, additive: false });
          this.particles.spawn(bx, by, Math.cos(a) * rand(40, 120), Math.sin(a) * rand(40, 120),
            rand(0.08, 0.2), rand(2, 4), 0xffb066, PKind.Ember, { drag: 5 });
        }
      }
    }
  }

  /**
   * Steers a guided projectile toward its lock. The turn rate is deliberately
   * finite: fast fliers can out-turn a missile, which is what keeps the Missile
   * Battery from being a strict upgrade over cheaper anti-air.
   */
  private guide(p: Projectile, dt: number) {
    let t = p.target;
    if (!t || t.dead || !t.targetable) {
      // Re-acquire the nearest live target ahead of the warhead, or fly on straight.
      const list = this.enemyHash.query(p.x, p.y, 220, this.queryBuf);
      let best: Enemy | null = null;
      let bestD = 220 * 220;
      for (let i = 0; i < list.length; i++) {
        const e = this.enemies[list[i]];
        if (!e || e.dead || !e.targetable) continue;
        const d2 = dist2(p.x, p.y, e.x, e.y);
        if (d2 < bestD) { bestD = d2; best = e; }
      }
      p.target = best;
      t = best;
      if (!t) return;
    }

    const speed = Math.hypot(p.vx, p.vy) || 1;
    // Lead the target slightly so the missile curves ahead of it, not behind.
    const eta = dist(p.x, p.y, t.x, t.y) / speed;
    const aimX = t.x + t.vx * eta * 0.55;
    const aimY = t.y + t.vy * eta * 0.55;

    const cur = Math.atan2(p.vy, p.vx);
    const want = Math.atan2(aimY - p.y, aimX - p.x);
    const next = rotateToward(cur, want, p.homingTurn * dt);
    p.vx = Math.cos(next) * speed;
    p.vy = Math.sin(next) * speed;
  }

  private projectileVsEnemies(p: Projectile) {
    const list = this.enemyHash.query(p.x, p.y, p.radius + 26, this.queryBuf);
    for (let i = 0; i < list.length; i++) {
      const e = this.enemies[list[i]];
      if (!e || e.dead || !e.targetable) continue;
      if (p.hitIds.includes(e.id)) continue;
      const rr = e.radius + p.radius;
      if (dist2(p.x, p.y, e.x, e.y) > rr * rr) continue;

      if (p.splash > 0) {
        this.detonate(p);
        p.dead = true;
        return;
      }
      this.damageEnemy(e, p.damage, {
        source: 'turret', armorPierce: p.armorPierce, dirX: p.vx, dirY: p.vy,
      });
      if (p.slowFactor) { e.slowTimer = Math.max(e.slowTimer, 1.4); e.slowFactor = p.slowFactor; }
      p.hitIds.push(e.id);
      if (p.pierce > 0) { p.pierce--; p.damage *= 0.78; }
      else { p.dead = true; return; }
    }
  }

  private projectileVsPlayerSide(p: Projectile) {
    // Buildings.
    const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
    const b = this.buildingAtTile(tx, ty);
    if (b) {
      if (p.splash > 0) { this.detonate(p); p.dead = true; return; }
      this.damageBuilding(b, p.damage);
      this.particles.impact(p.x, p.y, Math.atan2(p.vy, p.vx), p.color, 1);
      p.dead = true;
      return;
    }
    const rc = this.core.radius + p.radius;
    if (dist2(p.x, p.y, this.core.x, this.core.y) < rc * rc) {
      if (p.splash > 0) { this.detonate(p); p.dead = true; return; }
      this.damageCore(p.damage);
      p.dead = true;
      return;
    }
    if (!this.player.dead) {
      const rp = this.player.radius + p.radius;
      if (dist2(p.x, p.y, this.player.x, this.player.y) < rp * rp) {
        if (p.splash > 0) { this.detonate(p); p.dead = true; return; }
        this.damagePlayer(p.damage);
        p.dead = true;
      }
    }
  }

  private detonate(p: Projectile) {
    const r = p.splash || 40;
    this.explode(p.x, p.y, r, p.damage, p.faction, p.armorPierce);
    this.particles.explosion(p.x, p.y, r * 0.7, p.color, this.level.palette.rock);
    audio.play(r > 90 ? 'explodeBig' : 'explode', rand(0.9, 1.1));
    // Only genuinely large blasts move the camera. Cannon/flak/rocket shells land
    // several times a second, and shaking on each one turns the whole fight to mush.
    if (r >= 95) this.shake(clamp(r * 0.035, 2, 7));
  }

  /** Radial damage. `faction` is the *attacker*; splash never hits its own side. */
  explode(x: number, y: number, radius: number, damage: number, faction: 'player' | 'hive', pierce = 0) {
    const r2 = radius * radius;
    this.effects.push({
      kind: 'shock', x, y, x2: 0, y2: 0, radius,
      life: 0.32, maxLife: 0.32, color: 0xffc06a, width: 5, seed: 0,
    });

    if (faction === 'player') {
      let chained = 0;
      const list = this.enemyHash.query(x, y, radius, this.queryBuf);
      for (let i = 0; i < list.length; i++) {
        const e = this.enemies[list[i]];
        if (!e || e.dead || !e.targetable) continue;
        const d2 = dist2(x, y, e.x, e.y);
        if (d2 > r2) continue;
        const falloff = 1 - Math.sqrt(d2) / radius * 0.55;
        const before = e.dead;
        this.damageEnemy(e, damage * falloff, {
          source: 'turret', armorPierce: pierce,
          dirX: e.x - x, dirY: e.y - y,
        });
        if (!before && e.dead) chained++;
      }
      if (chained >= 12) this.progress.bump('chainKill');
    } else {
      for (let i = this.buildings.length - 1; i >= 0; i--) {
        const b = this.buildings[i];
        const d2 = dist2(x, y, b.x, b.y);
        if (d2 > r2) continue;
        this.damageBuilding(b, damage * (1 - Math.sqrt(d2) / radius * 0.5));
      }
      if (dist2(x, y, this.core.x, this.core.y) < r2) {
        this.damageCore(damage * 0.8);
      }
      if (!this.player.dead && dist2(x, y, this.player.x, this.player.y) < r2) {
        this.damagePlayer(damage * 0.7);
      }
      // Drones are caught by area damage too. Without this, automation would be
      // entirely risk-free and the whole trade would collapse.
      for (let i = this.drones.length - 1; i >= 0; i--) {
        const d = this.drones[i];
        if (d.dead) continue;
        const dd2 = dist2(x, y, d.x, d.y);
        if (dd2 > r2) continue;
        this.damageDrone(d, damage * (1 - Math.sqrt(dd2) / radius * 0.5));
      }
    }
  }

  /* ====================================================================== */
  /* Damage & death                                                          */
  /* ====================================================================== */

  damageEnemy(
    e: Enemy,
    amount: number,
    opts: {
      source: 'turret' | 'player' | 'burn';
      armorPierce?: number;
      building?: Building;
      dirX?: number; dirY?: number;
      silent?: boolean;
    },
  ) {
    if (e.dead) return;
    const pierce = (opts.armorPierce ?? 0) + this.perks.armorShred;
    let dmg = mitigate(amount, e.armor, pierce);

    if (e.shieldHp > 0) {
      const absorbed = Math.min(e.shieldHp, dmg);
      e.shieldHp -= absorbed;
      dmg -= absorbed;
      if (!opts.silent) this.particles.impact(e.x, e.y, Math.atan2(opts.dirY ?? 0, opts.dirX ?? 1), 0x9fd8ff, 1);
      if (dmg <= 0) return;
    }

    e.hp -= dmg;
    e.hitFlash = 1;
    this.runStats.damage += dmg;
    this.buffers.damage += dmg;

    // Echo splash from the Resonance Cascade tech.
    if (this.perks.splashEcho > 0 && !opts.silent && dmg > 1) {
      this.explode(e.x, e.y, 46, dmg * this.perks.splashEcho, 'player', 999);
    }

    if (!opts.silent) {
      const a = Math.atan2(opts.dirY ?? rand(-1, 1), opts.dirX ?? rand(-1, 1));
      this.particles.impact(e.x, e.y, a, e.armor > 3 ? 0xffe08a : e.def.accent, e.boss ? 1.6 : 1);
      audio.play(e.armor > 3 ? 'hitArmor' : 'hit', rand(0.9, 1.15));
      if (this.progress.data.settings.showDamageNumbers) {
        this.spawnDamageNumber(e.x, e.y - e.radius, Math.round(dmg), dmg > amount * 0.9, 0xffffff);
      }
    }

    // Knockback for non-bosses.
    if (!e.boss && opts.dirX !== undefined) {
      const l = Math.hypot(opts.dirX, opts.dirY ?? 0) || 1;
      const k = clamp(dmg / e.maxHp, 0, 0.4) * 260;
      e.vx += (opts.dirX / l) * k;
      e.vy += ((opts.dirY ?? 0) / l) * k;
    }

    if (e.hp <= 0) {
      this.killEnemy(e, opts.source === 'player' ? 'player' : 'turret', true);
      if (opts.building) opts.building.kills++;
    }
  }

  private killEnemy(e: Enemy, by: 'player' | 'turret' | 'self', reward: boolean) {
    if (e.dead) return;
    e.dead = true;
    this.killedThisWave++;
    this.runStats.kills++;
    this.progress.bump('kill');
    this.progress.recordRunStat('kills', 1);
    if (by === 'player') this.progress.bump('meleeKills');
    else if (by === 'turret') this.progress.bump('turretKills');

    const pal = this.level.palette;
    if (e.boss) {
      this.runStats.bossKills++;
      this.progress.bump('killBoss');
      this.progress.recordRunStat('bossKills', 1);
      if (this.coreDamageThisWave <= 0) this.progress.bump('bossNoCoreDamage');
      this.hitstop = 0.55;
      this.shake(26);
      this.addFlash(1, 0.9, 0.7, 0.6);
      for (let i = 0; i < 6; i++) {
        setTimeout(() => {
          this.particles.explosion(
            e.x + rand(-e.radius, e.radius), e.y + rand(-e.radius, e.radius),
            e.radius * rand(0.7, 1.4), e.def.accent, pal.rock,
          );
        }, i * 110);
      }
      audio.play('explodeBig');
      this.bossRef = null;
    } else {
      this.particles.explosion(e.x, e.y, e.radius * 1.6, e.def.accent, pal.rock);
      this.particles.gib(e.x, e.y, e.def.color, e.elite ? 12 : 7, e.boss ? 2 : 1);
      audio.play('kill', rand(0.9, 1.1));
      // Reserved for the genuinely heavy units; ordinary kills stay shake-free.
      if (e.radius > 16 || e.elite) this.shake(1.4);
    }

    if (reward) {
      const mult = e.elite ? 2 : 1;
      const essence = Math.round(e.def.essence * mult * this.perks.essenceYield);
      const oreDrop = Math.round(e.def.ore * mult * this.perks.oreYield);
      for (let i = 0; i < Math.min(6, essence); i++) this.dropPickup(e.x, e.y, 'essence', Math.ceil(essence / Math.min(6, essence)));
      if (oreDrop > 0) this.dropPickup(e.x, e.y, 'ore', oreDrop);
      if (this.perks.luck > 0 && chance(this.perks.luck)) this.dropPickup(e.x, e.y, 'essence', 2);
      if (chance(0.02)) this.dropPickup(e.x, e.y, 'health', 20);
      if (e.boss) {
        for (let i = 0; i < 14; i++) this.dropPickup(e.x, e.y, 'essence', Math.ceil(e.def.essence / 14));
        this.dropPickup(e.x, e.y, 'relic', 1);
      }
    }

    // Splitters seed children.
    if (e.def.splitInto && ENEMIES[e.def.splitInto]) {
      const childDef = ENEMIES[e.def.splitInto];
      for (let i = 0; i < (e.def.splitCount ?? 2); i++) {
        const a = (i / (e.def.splitCount ?? 2)) * TAU + rand(-0.3, 0.3);
        const at = this.world.findOpenNear(
          e.x + Math.cos(a) * (e.radius + 6), e.y + Math.sin(a) * (e.radius + 6));
        const c = this.spawnEnemy(childDef, at.x, at.y,
          this.plan?.hpMult ?? 1, this.plan?.dmgMult ?? 1, false);
        c.vx = Math.cos(a) * 160;
        c.vy = Math.sin(a) * 160;
        c.wave = e.wave;
        c.spawnedBy = e.id;
      }
    }
  }

  damageBuilding(b: Building, amount: number) {
    if (b.dead) return;
    let dmg = amount;
    if (b.shield > 0) {
      const absorbed = Math.min(b.shield, dmg);
      b.shield -= absorbed;
      dmg -= absorbed;
      this.particles.ring(b.x, b.y, b.radius * 1.4, 0x9fd8ff, 0.18);
      if (dmg <= 0) return;
    }
    b.hp -= dmg;
    b.hitFlash = 1;
    if (chance(0.4)) {
      this.particles.spawn(b.x + rand(-b.radius, b.radius), b.y + rand(-b.radius, b.radius),
        rand(-40, 40), rand(-60, 0), rand(0.15, 0.4), rand(1.5, 3), 0xffa657, PKind.Spark);
    }
    if (b.hp <= 0) this.removeBuilding(b, true);
  }

  damageCore(amount: number) {
    if (this.phase === 'lost' || this.phase === 'won') return;
    let dmg = amount;
    if (this.core.shield > 0) {
      const absorbed = Math.min(this.core.shield, dmg);
      this.core.shield -= absorbed;
      dmg -= absorbed;
      if (dmg <= 0) return;
    }
    this.core.hp -= dmg;
    this.core.hitFlash = 1;
    this.coreDamageThisWave += dmg;
    this.runStats.coreDamage += dmg;
    this.progress.bump('coreDamage', Math.round(dmg));
    this.shake(clamp(dmg * 0.08, 2, 9));
    audio.play('coreHit', rand(0.9, 1.1));
    this.addFlash(1, 0.25, 0.3, clamp(dmg / 300, 0.06, 0.3));

    if (this.core.hp <= 0) {
      if (this.perks.revives > 0) {
        this.perks.revives--;
        this.core.hp = this.core.maxHp * 0.3;
        this.core.reviveFlash = 1;
        this.explode(this.core.x, this.core.y, 320, 400, 'player', 999);
        this.setBanner(
          tr('game.banner.contingencyCore', 'CONTINGENCY CORE'),
          tr('game.banner.contingencyCoreDetail', 'The core reboots at 30%'),
          3.4, '#7dfff0',
        );
        audio.play('victory');
        this.shake(24);
        this.addFlash(0.6, 1, 1, 0.7);
        this.hitstop = 0.4;
      } else {
        this.core.hp = 0;
        this.loseRun();
      }
    }
  }

  damagePlayer(amount: number) {
    const p = this.player;
    if (p.dead || p.invuln > 0) return;
    p.hp -= amount;
    p.hitFlash = 1;
    this.shake(4);
    this.addFlash(1, 0.2, 0.2, clamp(amount / 60, 0.05, 0.28));
    audio.play('hit', 0.6);
    if (p.hp <= 0) {
      p.hp = 0;
      p.dead = true;
      p.invuln = 3.2;
      this.particles.explosion(p.x, p.y, 44, 0x7fd9ff, this.level.palette.rock);
      audio.play('explode');
      this.shake(12);
      this.setBanner(
        tr('game.banner.chassisDown', 'CHASSIS DOWN'),
        tr('game.banner.chassisDownDetail', 'Rebuilding at the core…'),
        3, '#ff4f5e',
      );
    }
  }

  private loseRun() {
    if (this.mode === 'endless') {
      // Endless has no victory condition, so the score is banked on death.
      this.endlessRecord = this.progress.recordEndlessResult(this.levelIndex, this.waveIndex);
      this.lastRelicAward = this.progress.awardEndlessRelics(this.waveIndex);
    }
    this.setPhase('lost');
    this.frozen = true;
    this.discardSavedRun();
    audio.play('gameOver');
    audio.stopMusic();
    this.hitstop = 0.7;
    this.shake(30);
    this.addFlash(1, 0.1, 0.1, 0.8);
    this.particles.explosion(this.core.x, this.core.y, 260, 0xff4f5e, this.level.palette.rock);
  }

  /* ====================================================================== */
  /* Pickups, core, nodes, effects                                           */
  /* ====================================================================== */

  private dropPickup(x: number, y: number, kind: PickupKind, amount: number) {
    let p = this.pickups.find((q) => q.dead);
    if (!p) {
      if (this.pickups.length >= MAX_PICKUPS) return;
      p = new Pickup();
      this.pickups.push(p);
    }
    p.dead = false;
    p.kind = kind;
    p.amount = amount;
    p.x = x + rand(-8, 8);
    p.y = y + rand(-8, 8);
    const a = rand(0, TAU);
    const s = rand(40, 130);
    p.vx = Math.cos(a) * s;
    p.vy = Math.sin(a) * s;
    p.life = 26;
    p.bob = rand(0, TAU);
    p.homing = false;
    p.homeSpeed = 0;
    p.radius = kind === 'relic' ? 10 : 7;
  }

  private updatePickups(dt: number) {
    const p = this.player;
    const grab = 96 * this.perks.pickupRadius;
    for (const q of this.pickups) {
      if (q.dead) continue;
      q.life -= dt;
      q.bob += dt * 5;
      if (q.life <= 0) { q.dead = true; continue; }

      const d = dist(q.x, q.y, p.x, p.y);
      if (!p.dead && (q.homing || d < grab)) {
        q.homing = true;
        q.homeSpeed = Math.min(760, q.homeSpeed + dt * 1500);
        const nx = (p.x - q.x) / (d || 1), ny = (p.y - q.y) / (d || 1);
        q.vx = nx * q.homeSpeed;
        q.vy = ny * q.homeSpeed;
      } else {
        q.vx *= Math.exp(-3.4 * dt);
        q.vy *= Math.exp(-3.4 * dt);
      }
      q.x += q.vx * dt;
      q.y += q.vy * dt;

      if (!p.dead && d < p.radius + q.radius + 4) {
        this.collect(q);
        q.dead = true;
      }
    }
  }

  private collect(q: Pickup) {
    switch (q.kind) {
      case 'essence':
        this.essence += q.amount;
        this.buffers.essence += q.amount;
        this.runStats.essenceCollected += q.amount;
        audio.play('pickupEssence', rand(0.95, 1.1));
        this.particles.spawn(q.x, q.y, 0, -40, 0.3, 6, 0xb47cff, PKind.Glow);
        break;
      case 'ore':
        this.ore += q.amount;
        this.buffers.ore += q.amount;
        audio.play('pickup', rand(0.95, 1.1));
        break;
      case 'health':
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + q.amount);
        audio.play('pickup', 1.2);
        this.particles.ring(this.player.x, this.player.y, 24, 0x5cf2a0, 0.3);
        break;
      case 'relic':
        this.progress.awardRelics(q.amount);
        audio.play('levelUp');
        this.setBanner(
          tr('game.banner.relicRecovered', 'RELIC RECOVERED'),
          tr('game.banner.relicRecoveredDetail', 'Permanent account currency'),
          2.6, '#ffcc55',
        );
        break;
    }
  }

  private updateCore(dt: number) {
    const c = this.core;
    c.hitFlash = Math.max(0, c.hitFlash - dt * 4);
    c.reviveFlash = Math.max(0, c.reviveFlash - dt * 1.6);
    c.spin += dt * 0.5;
    c.distress = damp(c.distress, 1 - c.pct, 3, dt);
    if (this.perks.coreRegen > 0 && c.hp < c.maxHp && c.hp > 0) {
      c.hp = Math.min(c.maxHp, c.hp + this.perks.coreRegen * dt);
    }
    if (c.maxShield > 0) {
      c.shield = Math.min(c.maxShield, c.shield + c.maxShield * 0.08 * dt);
    }

    // The core has a weak built-in gun so you are never completely helpless.
    if (this.phase === 'combat' || this.phase === 'boss' || this.phase === 'incoming') {
      c.spin += dt;
      if ((this.elapsed % 0.5) < dt) {
        const list = this.enemyHash.query(c.x, c.y, 230, this.queryBuf);
        let best: Enemy | null = null;
        let bd = 230 * 230;
        for (let i = 0; i < list.length; i++) {
          const e = this.enemies[list[i]];
          if (!e || e.dead || !e.targetable) continue;
          const d2 = dist2(c.x, c.y, e.x, e.y);
          if (d2 < bd) { bd = d2; best = e; }
        }
        if (best) {
          const a = Math.atan2(best.y - c.y, best.x - c.x);
          this.fire({
            x: c.x + Math.cos(a) * c.radius, y: c.y + Math.sin(a) * c.radius,
            angle: a, speed: 700, damage: 14 * this.perks.turretDamage, kind: 'bullet',
            faction: 'player', color: 0x7fd9ff, size: 3.6, life: 0.6,
            armorPierce: 2 + this.perks.armorShred, ownerId: -1, splash: 0,
          });
          audio.play('shoot', 1.2);
        }
      }
    }
  }

  private updateNodes(dt: number) {
    for (const n of this.world.nodes) n.shimmer += dt * 1.4;
  }

  private updateEffects(dt: number) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= dt;
      if (e.life <= 0) this.effects.splice(i, 1);
    }
  }

  private spawnDamageNumber(x: number, y: number, value: number, crit: boolean, color: number) {
    if (this.damageNumbers.length > 90) this.damageNumbers.shift();
    this.damageNumbers.push({
      x: x + rand(-6, 6), y, vy: -46, life: 0.75, value, crit, color,
    });
  }

  private updateDamageNumbers(dt: number) {
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const d = this.damageNumbers[i];
      d.life -= dt;
      d.y += d.vy * dt;
      d.vy += 60 * dt;
      if (d.life <= 0) this.damageNumbers.splice(i, 1);
    }
  }

  /* ====================================================================== */
  /* Camera & feedback                                                       */
  /* ====================================================================== */

  private viewportW = 1280;
  private viewportH = 720;

  setViewport(w: number, h: number) {
    this.viewportW = w;
    this.viewportH = h;
  }

  get viewport() { return { w: this.viewportW, h: this.viewportH }; }

  private updateCamera(dt: number, input: InputSource) {
    const cam = this.camera;
    const p = this.player;
    // Bias the camera toward the cursor so you can see what you're shooting.
    const lookX = (this.mouseWorldX - p.x) * 0.22;
    const lookY = (this.mouseWorldY - p.y) * 0.22;
    const tx = p.x + clamp(lookX, -190, 190);
    const ty = p.y + clamp(lookY, -190, 190);

    cam.x = damp(cam.x, tx, 7, dt);
    cam.y = damp(cam.y, ty, 7, dt);

    const halfW = this.viewportW / (2 * cam.zoom);
    const halfH = this.viewportH / (2 * cam.zoom);
    if (this.world.pxW > halfW * 2) cam.x = clamp(cam.x, halfW, this.world.pxW - halfW);
    else cam.x = this.world.pxW / 2;
    if (this.world.pxH > halfH * 2) cam.y = clamp(cam.y, halfH, this.world.pxH - halfH);
    else cam.y = this.world.pxH / 2;

    const amp = cam.shake * this.progress.data.settings.screenShake;
    cam.shakeX = rand(-amp, amp);
    cam.shakeY = rand(-amp, amp);
    cam.shake = damp(cam.shake, 0, 8, dt);
    void input;
  }

  shake(amount: number) {
    this.camera.shake = Math.min(34, this.camera.shake + amount);
  }

  addFlash(r: number, g: number, b: number, a: number) {
    if (a <= this.flash.a) return;
    this.flash = { r, g, b, a };
  }

  /* ====================================================================== */
  /* Collision helpers                                                       */
  /* ====================================================================== */

  /** Pushes a circle out of solid buildings; returns the last one it touched. */
  private collideWithBuildings(p: { x: number; y: number }, r: number): Building | null {
    let hit: Building | null = null;
    const minTx = Math.floor((p.x - r) / TILE);
    const maxTx = Math.floor((p.x + r) / TILE);
    const minTy = Math.floor((p.y - r) / TILE);
    const maxTy = Math.floor((p.y + r) / TILE);
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const b = this.buildingAtTile(tx, ty);
        if (!b || !b.def.blocksMovement) continue;
        const left = tx * TILE, top = ty * TILE;
        const cx = clamp(p.x, left, left + TILE);
        const cy = clamp(p.y, top, top + TILE);
        let dx = p.x - cx, dy = p.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        hit = b;
        const d = Math.sqrt(d2);
        if (d < 1e-5) {
          const midX = left + TILE / 2, midY = top + TILE / 2;
          dx = p.x - midX; dy = p.y - midY;
          if (Math.abs(dx) > Math.abs(dy)) p.x = dx > 0 ? left + TILE + r : left - r;
          else p.y = dy > 0 ? top + TILE + r : top - r;
          continue;
        }
        const push = (r - d) / d;
        p.x += dx * push;
        p.y += dy * push;
      }
    }
    return hit;
  }

  /* ====================================================================== */
  /* Queries for the UI                                                      */
  /* ====================================================================== */

  /** Compact, shareable rendering of the current map seed. */
  get seedCode() {
    return this.runSeed.toString(36).toUpperCase().padStart(7, '0');
  }

  /**
   * True during any build window — both the long one before wave 1 ('prep') and
   * the short ones between waves ('cleared').
   *
   * These are two distinct phases, and the early-start handler used to test only
   * 'prep', so skipping ahead worked exactly once per level while the HUD kept
   * advertising it. Both now read this single getter.
   */
  get inBuildPhase() {
    return this.phase === 'prep' || this.phase === 'cleared';
  }

  get endless() { return this.mode === 'endless'; }

  get waveLabel() {
    if (this.endless) {
      if (this.plan?.isBoss || this.phase === 'boss') {
        return tr('game.waveLabel.bossWave', 'BOSS WAVE {n}', { n: this.waveIndex + 1 });
      }
      return tr('game.waveLabel.wave', 'WAVE {n}', { n: this.waveIndex + 1 });
    }
    if (this.plan?.isBoss || this.phase === 'boss') return tr('game.waveLabel.finalWave', 'FINAL WAVE');
    return tr('game.waveLabel.waveOfTotal', 'WAVE {n} / {total}', { n: this.waveIndex + 1, total: this.level.waves });
  }

  /** Waves until the next endless boss; 0 when the current wave is one. */
  get wavesUntilBoss() {
    if (!this.endless) return Math.max(0, this.level.waves - 1 - this.waveIndex);
    const next = Math.ceil((this.waveIndex + 1) / ENDLESS_BOSS_INTERVAL) * ENDLESS_BOSS_INTERVAL;
    return next - (this.waveIndex + 1);
  }

  get remainingEnemies() {
    const plan = this.plan;
    if (!plan) return 0;
    const unspawned = Math.max(0, plan.orders.length - this.orderCursor);
    return unspawned + this.enemies.length;
  }

  get waveProgress() {
    const plan = this.plan;
    if (!plan || plan.orders.length === 0) return 0;
    const total = plan.orders.length;
    const done = this.killedThisWave;
    return clamp(done / total, 0, 1);
  }

  /** Live drones belonging to a bay, and the bay's capacity. */
  droneCount(bay: Building) {
    let live = 0;
    for (const d of this.drones) if (!d.dead && d.bayId === bay.id) live++;
    return { live, slots: Math.round(bay.def.droneSlots ?? 0) };
  }

  get availableBuildings(): BuildingKind[] {
    return BUILD_ORDER.filter((k) => this.unlockedBuildings.has(k));
  }

  /** Snapshot used by the level-complete and defeat screens. */
  summary() {
    return {
      level: this.level,
      mode: this.mode,
      wave: this.waveIndex + 1,
      waves: this.endless ? 0 : this.level.waves,
      kills: this.runStats.kills,
      bossKills: this.runStats.bossKills,
      ore: Math.round(this.runStats.oreMined),
      essence: Math.round(this.runStats.essenceCollected),
      built: this.runStats.built,
      lost: this.runStats.structuresLost,
      damage: Math.round(this.runStats.damage),
      time: this.runStats.timeSeconds,
      corePct: this.core.pct,
      tech: this.techTaken.map((id) => TECH_CARDS.find((c) => c.id === id)!).filter(Boolean),
    };
  }

  /* ====================================================================== */
  /* Resumable runs                                                          */
  /* ====================================================================== */

  /**
   * Snapshots the run. Only valid during a build phase — the caller guarantees
   * that, which is precisely why no enemy, projectile or particle state is here.
   */
  snapshot(): RunSnapshot {
    return {
      v: RUN_SNAPSHOT_VERSION,
      mode: this.mode,
      levelIndex: this.levelIndex,
      seed: this.runSeed,
      waveIndex: this.waveIndex,
      prepRemaining: this.prepRemaining,
      ore: Math.round(this.ore),
      essence: Math.round(this.essence),
      coreHp: this.core.hp,
      coreShield: this.core.shield,
      playerHp: this.player.hp,
      playerX: this.player.x,
      playerY: this.player.y,
      tech: [...this.techTaken],
      unlocked: [...this.unlockedBuildings],
      buildings: this.buildings.map((b) => ({
        k: b.kind, tx: b.tx, ty: b.ty, hp: Math.round(b.hp),
      })),
      nodes: this.world.nodes.map((n) => Math.round(n.amount)),
      stats: {
        kills: this.runStats.kills,
        bossKills: this.runStats.bossKills,
        oreMined: Math.round(this.runStats.oreMined),
        essenceCollected: Math.round(this.runStats.essenceCollected),
        built: this.runStats.built,
        damage: Math.round(this.runStats.damage),
        structuresLost: this.runStats.structuresLost,
        wavesCleared: this.runStats.wavesCleared,
        coreDamage: Math.round(this.runStats.coreDamage),
        timeSeconds: Math.round(this.runStats.timeSeconds),
        bestPower: this.runStats.bestPower,
        dronesLost: this.runStats.dronesLost,
        droneOre: Math.round(this.runStats.droneOre),
      },
      savedAt: Date.now(),
    };
  }

  /** Writes a snapshot if the run is in a resumable state. Safe to spam. */
  autoSaveRun() {
    if (!this.inBuildPhase || this.phase === 'won' || this.phase === 'lost') return false;
    saveRun(this.snapshot());
    return true;
  }

  /** Drops any stored snapshot — call when a run ends or is abandoned. */
  discardSavedRun() {
    clearRun();
  }

  /**
   * Rebuilds a run from a snapshot. Returns false if the snapshot is unusable,
   * leaving the game untouched.
   */
  resume(snap: RunSnapshot): boolean {
    if (!snap || snap.v !== RUN_SNAPSHOT_VERSION) return false;
    if (snap.levelIndex < 0 || snap.levelIndex >= LEVELS.length) return false;

    // Regenerate the exact same world from the seed, then lay the player's
    // changes back over the top.
    this.startLevel(snap.levelIndex, undefined, snap.seed, {
      mode: snap.mode,
      resuming: true,
    });

    this.techTaken = [...snap.tech];
    this.unlockedBuildings = new Set(snap.unlocked as BuildingKind[]);
    // Perks are derived, never stored: the profile may have gained achievements
    // or shop ranks since the save, and the run should benefit from them.
    this.perks = this.progress.computePerks();
    for (const id of this.techTaken) {
      const card = TECH_CARDS.find((c) => c.id === id);
      if (card?.perk) applyPerk(this.perks, card.perk);
    }

    this.core.maxHp = Math.round(CORE_BASE_HP * this.perks.coreHp);
    this.core.hp = clamp(snap.coreHp, 1, this.core.maxHp);
    this.core.shield = Math.max(0, snap.coreShield);
    this.player.maxHp = Math.round(PLAYER_BASE_HP * this.perks.playerMaxHp);
    this.player.hp = clamp(snap.playerHp, 1, this.player.maxHp);
    this.player.x = clamp(snap.playerX, TILE, this.world.pxW - TILE);
    this.player.y = clamp(snap.playerY, TILE, this.world.pxH - TILE);

    this.ore = Math.max(0, snap.ore);
    this.essence = Math.max(0, snap.essence);

    // Restore drained seams before structures, so an extractor can re-bind.
    for (let i = 0; i < this.world.nodes.length && i < snap.nodes.length; i++) {
      const n = this.world.nodes[i];
      const amount = clamp(snap.nodes[i], 0, n.max);
      if (amount >= n.max) continue;
      this.world.drain(n, n.amount - amount);
    }

    for (const b of snap.buildings) {
      const def = BUILDINGS[b.k as BuildingKind];
      if (!def) continue;
      this.restoreBuilding(def, b.tx, b.ty, b.hp);
    }

    this.runStats = { ...this.runStats, ...snap.stats };

    this.waveIndex = snap.waveIndex;
    // Rebuild the director from scratch before walking it forward. startLevel has
    // already consumed a plan(0) off the one it created, and the director's RNG
    // advances per call — reusing it would put the resumed run one roll out of
    // step with the wave the player was actually promised.
    this.director = new WaveDirector(
      this.level, this.world.spawns.length, this.mapSeed ^ 0xabcdef, this.endless,
    );
    this.director.fastForwardTo(this.waveIndex);
    this.nextPlan = this.director.plan(this.waveIndex);
    this.plan = null;
    this.orderCursor = 0;
    this.prepRemaining = Math.max(3, snap.prepRemaining);
    this.phase = this.waveIndex === 0 ? 'prep' : 'cleared';
    this.world.field.dirty = true;
    this.world.field.rebuild();

    // Drones are not serialised — they are transient and always mid-flight. Refill
    // the bays outright rather than making the player wait out respawn timers for
    // something that was only lost to saving.
    this.fillDroneBays();

    this.setBanner(
      tr('game.banner.runResumed', 'RUN RESUMED'),
      this.endless
        ? tr('game.banner.runResumedDetailEndless', '{level} - wave {wave} - endless',
          { level: levelName(this.level), wave: this.waveIndex + 1 })
        : tr('game.banner.runResumedDetail', '{level} - wave {wave}',
          { level: levelName(this.level), wave: this.waveIndex + 1 }),
      3.2, '#5cf2a0');
    return true;
  }

  /** Places a saved structure without charging for it or playing build FX. */
  private restoreBuilding(def: BuildingDef, tx: number, ty: number, hp: number) {
    // Terrain regenerates identically, so a rejection means the snapshot and the
    // code have diverged; skip that structure rather than corrupt the grid.
    if (this.canPlace(def, tx, ty) !== null) return;

    const b = new Building(def, tx, ty, TILE, this.perks.structureHp);
    b.progress = 1;
    b.hp = clamp(hp, 1, b.maxHp);
    this.buildings.push(b);
    for (let y = ty; y < ty + def.size; y++) {
      for (let x = tx; x < tx + def.size; x++) {
        this.buildingAt[this.world.idx(x, y)] = b;
        if (def.blocksMovement) this.world.field.setCost(x, y, def.pathCost);
      }
    }
    if (def.id === 'extractor') {
      for (let y = ty; y < ty + def.size && b.nodeIndex < 0; y++) {
        for (let x = tx; x < tx + def.size; x++) {
          const n = this.world.nodeAtTile(x, y);
          if (n) { b.nodeIndex = this.world.nodes.indexOf(n); n.claimedBy = b.id; break; }
        }
      }
    }
  }

  static loadSnapshot() {
    return loadRun();
  }

  carryOver() {
    return {
      perks: this.perks,
      tech: [...this.techTaken],
      unlocked: [...this.unlockedBuildings],
    };
  }

  /** Terrain colour for a tile, cached-free but cheap; used by the renderer. */
  tileTint(tx: number, ty: number): number {
    const d = this.world.detail[this.world.idx(tx, ty)];
    const pal = this.level.palette;
    return lerp(0, 1, d) > 0.5 ? pal.ground1 : pal.ground0;
  }
}

export { FlowField };
