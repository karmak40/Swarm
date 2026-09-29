import { audio } from '../core/audio';
import type { InputSource } from '../core/input';
import { GHOST_LIFT } from '../core/touch';
import {
  Rng, clamp, lerp,
} from '../core/math';
// Aliased: this file's `t` is almost always a Tile value, not a translation call.
import { t as tr } from '../core/i18n';
import { Particles } from '../engine/particles';
import { SpatialHash } from '../engine/spatial';
import { FlowField } from '../engine/flowfield';
import {
  BUILDINGS, BUILD_ORDER, BUILD_CATEGORIES, CATEGORY_KEY_CODE, HOTKEY_CODES,
  type BuildCategory, type BuildingDef, type BuildingKind,
} from '../data/buildings';
import { type EnemyDef } from '../data/enemies';
import {
  ENDLESS_BOSS_INTERVAL, LEVELS, levelName, levelSubtitle, ngDifficultyMult, type LevelDef,
} from '../data/levels';
import { applyPerk, basePerks, type Perks } from '../data/perks';
import { ARMOR_TIERS, type WeaponKind } from '../data/loadout';
import { TECH_CARDS, type TechCard } from '../data/tech';
import {
  Building, Core, Drone, Enemy,
  type PickupKind, Player, Projectile,
} from './entities';
import { Progress } from './progress';
import {
  clearRun, loadRun, saveRun, type RunSnapshot,
} from '../core/save';
import { TILE, Tile, World, type OreNode } from './world';
import { WaveDirector, type Phase, type WavePlan } from './waves';
import { buildSnapshot, applySnapshot } from './runSnapshot';
import { PresentationSystem } from './systems/presentation';
import { CoreSystem } from './systems/core';
import { PickupSystem } from './systems/pickups';
import { DroneSystem } from './systems/drones';
import { BuildingSystem } from './systems/buildings';
import { PlayerSystem } from './systems/player';
import { CombatSystem } from './systems/combat';
import { EnemySystem } from './systems/enemies';
import { WaveSystem } from './systems/waveFlow';

/**
 * Campaign runs end at a scripted boss; endless runs end when the core dies;
 * skirmish is a player-configured one-off — structured like campaign (a
 * scripted boss wave) but outside progress tracking (see `finishLevel`).
 */
export type GameMode = 'campaign' | 'endless' | 'skirmish';

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

export const PLAYER_BASE_HP = 160;
export const CORE_BASE_HP = 2600;

export class Game {
  // --- persistent ---
  readonly progress: Progress;

  // --- level scoped ---
  level!: LevelDef;
  /** -1 for a skirmish run: it isn't an entry in LEVELS, so nothing keyed on it applies. */
  levelIndex = 0;
  mode: GameMode = 'campaign';
  /** NG+ tier actually applied this run (1 = base game). Campaign starts only — see startLevel. */
  ngTier = 1;
  /** Seed the current map was rolled from; shown in the UI and reusable. */
  runSeed = 0;
  /** runSeed mixed with the sector salt — what the world and director derive from. */
  mapSeed = 0;
  world!: World;
  readonly coreSystem: CoreSystem;
  player!: Player;
  readonly playerSystem: PlayerSystem;
  perks: Perks = basePerks();
  rng!: Rng;

  readonly enemySystem: EnemySystem;
  readonly waveSystem: WaveSystem;
  readonly buildingSystem: BuildingSystem;
  readonly combatSystem: CombatSystem;
  readonly droneSystem: DroneSystem;
  readonly pickupSystem: PickupSystem;
  readonly particles = new Particles();

  // --- economy ---
  ore = 0;
  essence = 0;

  // --- wave state ---
  phase: Phase = 'prep';
  waveIndex = 0;
  plan: WavePlan | null = null;
  nextPlan: WavePlan | null = null;
  director!: WaveDirector;
  orderCursor = 0;
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
  structuresLostThisWave = 0;
  coreDamageThisWave = 0;
  buffers = { ore: 0, essence: 0, damage: 0, repair: 0, seconds: 0 };

  // --- presentation ---
  readonly presentation: PresentationSystem;
  /** Set while the sim should not advance (menus, draft, results). */
  frozen = false;

  // --- interaction ---
  /**
   * Aim and fire the player weapon without pointer input. Required on touch,
   * where there is no cursor to aim with; optional on desktop.
   */
  autoAim = false;
  /** Mine the nearest seam in range with no button held. Opt-in everywhere. */
  autoMine = false;
  /** Set from touch's control scheme. Nudges a few things a finger needs that a
   *  cursor doesn't — e.g. lifting the build ghost out from under the thumb. */
  touchUi = false;
  /**
   * Touch: world point the placement ghost is pinned to, overriding the
   * cursor-derived one. Set by the touch layer so the ghost stays put while
   * the camera moves under it (walking, or a build-mode pan).
   */
  aimOverride: { x: number; y: number } | null = null;
  /** Touch: keep a build-mode camera pan in place instead of easing back to the player. */
  buildCamHold = false;
  /** The enemy auto-aim is currently tracking, for the HUD lock indicator. */
  autoTarget: Enemy | null = null;
  cursorMode: CursorMode = 'normal';
  /**
   * Which build-bar section the digit keys address. UI state, but it lives here
   * so the keyboard handler and the renderer read one value rather than two.
   */
  buildCategory: BuildCategory = 'resources';
  buildKind: BuildingKind | null = null;
  buildValid = false;
  buildTx = 0;
  buildTy = 0;
  hoverBuilding: Building | null = null;
  hoverNode: OreNode | null = null;
  /** Nearest unclaimed seam in mining range of the player, regardless of cursor
   *  position — drives the touch "hold to mine" prompt, which has no cursor to
   *  hover with between taps. */
  nearbyMineNode: OreNode | null = null;
  mouseWorldX = 0;
  mouseWorldY = 0;

  /** Fired when the run reaches a state the shell must present. */
  onPhaseChange: ((p: Phase) => void) | null = null;
  onDraft: ((cards: TechCard[]) => void) | null = null;

  constructor() {
    this.progress = new Progress();
    this.presentation = new PresentationSystem(this);
    this.coreSystem = new CoreSystem(this);
    this.pickupSystem = new PickupSystem(this);
    this.droneSystem = new DroneSystem(this);
    this.buildingSystem = new BuildingSystem(this);
    this.playerSystem = new PlayerSystem(this);
    this.combatSystem = new CombatSystem(this);
    this.enemySystem = new EnemySystem(this);
    this.waveSystem = new WaveSystem(this);
  }

  get projectiles() { return this.combatSystem.projectiles; }
  get enemies() { return this.enemySystem.enemies; }
  get enemyHash() { return this.enemySystem.enemyHash; }
  get queryBuf() { return this.enemySystem.queryBuf; }

  get core() { return this.coreSystem.core; }
  get pickups() { return this.pickupSystem.pickups; }
  get drones() { return this.droneSystem.drones; }

  // --- building forwarding: renderer/HUD read these as plain Game fields ---
  get buildings() { return this.buildingSystem.buildings; }
  get buildingAt() { return this.buildingSystem.buildingAt; }
  get buildingHash() { return this.buildingSystem.buildingHash; }
  get buildingQueryBuf() { return this.buildingSystem.buildingQueryBuf; }
  get buildingById() { return this.buildingSystem.buildingById; }
  get power() { return this.buildingSystem.power; }

  // --- presentation forwarding: renderer/HUD read these as plain Game fields ---
  get camera() { return this.presentation.camera; }
  get flash() { return this.presentation.flash; }
  get banner() { return this.presentation.banner; }
  get timeScale() { return this.presentation.timeScale; }
  get elapsed() { return this.presentation.elapsed; }
  get effects() { return this.presentation.effects; }
  get damageNumbers() { return this.presentation.damageNumbers; }
  get lastError() { return this.presentation.lastError; }
  get viewport() { return this.presentation.viewport; }

  /* ====================================================================== */
  /* Lifecycle                                                               */
  /* ====================================================================== */

  /**
   * @param levelIndex  Either a campaign sector index, or a fully-formed
   *                     `LevelDef` (a skirmish map built by `makeSkirmishLevel`)
   *                     to play as a one-off outside the fixed `LEVELS` array.
   * @param seed  Explicit map seed. Omit for a fresh random map — this is what
   *              makes a replayed sector a different fight rather than the same
   *              one from memory. Pass a value to reproduce a run or to pin a map
   *              in tests.
   */
  startLevel(
    levelIndex: number | LevelDef,
    carryOver?: {
      perks: Perks; tech: string[]; unlocked: BuildingKind[];
      weaponsOwned: WeaponKind[]; weapon: WeaponKind; armorTier: number;
    },
    seed?: number,
    opts: { mode?: GameMode; resuming?: boolean } = {},
  ) {
    this.mode = opts.mode ?? 'campaign';
    if (typeof levelIndex === 'number') {
      this.levelIndex = clamp(levelIndex, 0, LEVELS.length - 1);
      const base = LEVELS[this.levelIndex];
      // NG+ only ever applies to a real campaign sector picked by index —
      // a skirmish map already bakes the chosen difficulty into its own
      // LevelDef, and endless has its own separate scaling.
      this.ngTier = this.mode === 'campaign'
        ? clamp(Math.round(this.progress.data.settings.ngTier ?? 1), 1, 10)
        : 1;
      this.level = this.ngTier > 1
        ? { ...base, difficulty: base.difficulty * ngDifficultyMult(this.ngTier) }
        : base;
    } else {
      this.levelIndex = -1;
      this.level = levelIndex;
      this.ngTier = 1;
    }
    // The level's own seed is a per-sector salt, so the same run seed still yields
    // a different map in each sector.
    this.runSeed = (seed ?? ((Math.random() * 0x100000000) >>> 0)) >>> 0;
    const mapSeed = (this.runSeed ^ this.level.seed) >>> 0;
    this.mapSeed = mapSeed;
    this.rng = new Rng(mapSeed ^ 0xc0ffee);
    this.world = new World(this.level, mapSeed);
    this.enemySystem.enemyHash = new SpatialHash(this.world.pxW, this.world.pxH, 72);
    this.buildingSystem.buildingHash = new SpatialHash(this.world.pxW, this.world.pxH, 128);

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
    this.buildingById.clear();
    this.buildingSystem.buildingAt = new Array(this.world.w * this.world.h).fill(null);
    this.projectiles.length = 0;
    this.drones.length = 0;
    this.pickups.length = 0;
    this.effects.length = 0;
    this.damageNumbers.length = 0;
    this.particles.clear();

    this.coreSystem.core = new Core(this.world.coreX, this.world.coreY, Math.round(CORE_BASE_HP * this.perks.coreHp));
    const armorTier = carryOver?.armorTier ?? 0;
    const armorHpBonus = ARMOR_TIERS[armorTier]?.hpBonus ?? 0;
    this.player = new Player(
      this.world.coreX + TILE * 2.5,
      this.world.coreY + TILE * 2.5,
      Math.round(PLAYER_BASE_HP * this.perks.playerMaxHp) + armorHpBonus,
    );
    this.player.armorTier = armorTier;
    if (carryOver) {
      this.player.weaponsOwned = new Set(carryOver.weaponsOwned);
      this.player.weapon = carryOver.weapon;
    }

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

    this.presentation.reset();
    this.cursorMode = 'normal';
    this.buildKind = null;
    // A section that is empty in this sector must not stay selected.
    this.buildCategory = this.activeCategories[0] ?? 'resources';
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

  setPhase(p: Phase) {
    if (this.phase === p) return;
    this.phase = p;
    this.onPhaseChange?.(p);
  }

  setBanner(title: string, sub: string, life = 3, color = '#46d8ff') {
    this.presentation.setBanner(title, sub, life, color);
  }

  /* ====================================================================== */
  /* Main tick                                                               */
  /* ====================================================================== */

  update(rawDt: number, input: InputSource) {
    this.presentation.advanceTimeScale(rawDt);

    const dt = Math.min(0.05, rawDt) * (this.frozen ? 0 : this.presentation.timeScale);
    this.presentation.elapsed += dt;

    this.updateInteraction(input, rawDt);
    this.presentation.updateBanner(rawDt);

    if (dt <= 0) {
      this.presentation.updateCamera(rawDt, input);
      return;
    }

    this.buffers.seconds += dt;
    this.runStats.timeSeconds += dt;

    this.enemySystem.rebuildEnemyHash();
    this.rebuildBuildingHash();
    this.updatePower();
    this.waveSystem.updateWaves(dt);
    this.playerSystem.updatePlayer(dt, input);
    this.updateBuildings(dt);
    this.droneSystem.updateDrones(dt);
    this.enemySystem.updateEnemies(dt);
    this.combatSystem.updateProjectiles(dt);
    this.pickupSystem.updatePickups(dt);
    this.presentation.updateEffects(dt);
    this.coreSystem.updateCore(dt);
    this.updateNodes(dt);

    this.particles.update(dt);
    this.presentation.updateDamageNumbers(dt);
    this.presentation.updateCamera(rawDt, input);
    this.presentation.updateAudioMix(dt);
    this.flushBuffers();

    this.world.field.rebuild();
  }

  private flushBuffers() {
    const b = this.buffers;
    if (b.ore >= 1) { const n = Math.floor(b.ore); b.ore -= n; this.progress.bump('ore', n); this.progress.recordRunStat('oreMined', n); }
    if (b.essence >= 1) { const n = Math.floor(b.essence); b.essence -= n; this.progress.bump('essence', n); this.progress.recordRunStat('essenceCollected', n); }
    if (b.damage >= 25) { const n = Math.floor(b.damage); b.damage -= n; this.progress.bump('damage', n); this.progress.recordRunStat('damageDealt', n); }
    if (b.repair >= 25) { const n = Math.floor(b.repair); b.repair -= n; this.progress.bump('repair', n); }
    if (b.seconds >= 5) { const n = Math.floor(b.seconds); b.seconds -= n; this.progress.bump('playSeconds', n); this.progress.recordRunStat('playSeconds', n); }
  }

  /* ====================================================================== */
  /* Interaction: build placement, selling, repairing                        */
  /* ====================================================================== */

  private updateInteraction(input: InputSource, dt: number) {
    // Cursor → world.
    const view = this.viewport;
    this.mouseWorldX = this.camera.x + (input.mouseX - view.w / 2) / this.camera.zoom;
    this.mouseWorldY = this.camera.y + (input.mouseY - view.h / 2) / this.camera.zoom;
    if (this.aimOverride) {
      this.mouseWorldX = this.aimOverride.x;
      this.mouseWorldY = this.aimOverride.y;
    }

    if (input.uiCaptured) return;

    // Zoom.
    if (input.wheel !== 0) {
      this.camera.zoom = clamp(this.camera.zoom * (input.wheel > 0 ? 0.9 : 1.111), 0.55, 1.9);
    }

    // Section keys first: they change what the digits mean.
    for (const cat of BUILD_CATEGORIES) {
      if (!input.pressed(CATEGORY_KEY_CODE[cat])) continue;
      if (this.categoryBuildings(cat).length === 0) break;
      this.buildCategory = cat;
      // Switching sections cancels a pending placement rather than silently
      // leaving a ghost from the section you just left.
      this.buildKind = null;
      this.cursorMode = 'normal';
      audio.play('uiClick');
      break;
    }

    // Digits select a slot inside the active section.
    for (const kind of this.categoryBuildings(this.buildCategory)) {
      const def = BUILDINGS[kind];
      const code = HOTKEY_CODES[def.hotkey];
      if (!code || !input.pressed(code)) continue;
      this.buildKind = this.buildKind === kind ? null : kind;
      this.cursorMode = this.buildKind ? 'build' : 'normal';
      audio.play('uiClick');
      break;
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
      // On touch, the placement point sits right under the thumb doing the
      // pointing — lift it clear so the ghost (and what's behind it) is
      // actually visible. Desktop has a real cursor, so it needs none of this.
      // The lift is in screen px (≈ a fingertip), so it holds at any zoom.
      const pty = this.touchUi ? Math.floor((this.mouseWorldY - GHOST_LIFT / this.camera.zoom) / TILE) : hty;
      // Centre the footprint on the cursor for multi-tile structures.
      const off = Math.floor((def.size - 1) / 2);
      this.buildTx = htx - off;
      this.buildTy = pty - off;
      this.buildValid = this.canPlace(def, this.buildTx, this.buildTy) === null;

      if (input.mouseDown(0)) {
        const reason = this.canPlace(def, this.buildTx, this.buildTy);
        if (reason === null) this.place(def, this.buildTx, this.buildTy);
        else if (input.mouseClicked(0)) this.presentation.error(reason);
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
    this.buildingSystem.cycleTargeting(b);
  }

  /**
   * One tap's worth of repair. The held-key path bills continuously; touch has no
   * comfortable equivalent, so this applies a fixed chunk per tap instead.
   */
  repairBuildingBurst(b: Building): boolean {
    return this.buildingSystem.repairBuildingBurst(b);
  }

  buildingAtTile(tx: number, ty: number): Building | null {
    return this.buildingSystem.buildingAtTile(tx, ty);
  }

  /**
   * Returns null when placement is legal, otherwise a player-facing reason.
   * `checkPlayer` is turned off when replaying a save: the player's restored
   * position is irrelevant to whether a structure they placed earlier is valid.
   */
  canPlace(def: BuildingDef, tx: number, ty: number, checkPlayer = true): string | null {
    return this.buildingSystem.canPlace(def, tx, ty, checkPlayer);
  }

  costOf(def: BuildingDef) {
    return this.buildingSystem.costOf(def);
  }

  private place(def: BuildingDef, tx: number, ty: number) {
    this.buildingSystem.place(def, tx, ty);
  }

  sellBuilding(b: Building) {
    this.buildingSystem.sellBuilding(b);
  }

  /** Touch build-mode look-around: shifts the camera by a world-space delta. */
  panCamera(dx: number, dy: number) {
    this.presentation.panBy(dx, dy);
  }

  /** Touch pinch-zoom: multiplies the fitted zoom by `factor`. */
  zoomCamera(factor: number) {
    this.presentation.zoomBy(factor);
  }

  sellValue(b: Building) {
    return this.buildingSystem.sellValue(b);
  }

  private repairBuilding(b: Building, dt: number) {
    this.buildingSystem.repairBuilding(b, dt);
  }

  removeBuilding(b: Building, destroyed: boolean) {
    this.buildingSystem.removeBuilding(b, destroyed);
  }

  /* ====================================================================== */
  /* Power                                                                   */
  /* ====================================================================== */

  private updatePower() {
    this.buildingSystem.updatePower();
  }

  /* ====================================================================== */
  /* Waves                                                                   */
  /* ====================================================================== */

  describeWave(plan: WavePlan): string {
    return this.waveSystem.describeWave(plan);
  }

  /** Relics paid out by the sector just cleared; shown on the victory screen. */
  lastRelicAward = 0;
  /** Endless outcome, filled in on death: was this a new personal best? */
  endlessRecord: { waves: number; best: number; isRecord: boolean } | null = null;

  rollDraft(count: number): TechCard[] {
    return this.waveSystem.rollDraft(count);
  }

  takeTech(card: TechCard) {
    this.waveSystem.takeTech(card);
  }

  armorHpBonus() {
    return this.playerSystem.armorHpBonus();
  }

  /* ====================================================================== */
  /* Loadout — essence-bought player weapons and armor, see data/loadout.ts   */
  /* ====================================================================== */

  /**
   * Unlocks (or, if already owned, just re-equips for free) a weapon. This is
   * a deliberate essence sink the player opts into, distinct from tech cards
   * (random, free, numeric-only) and the relic Armoury (permanent, cross-run,
   * bought with relics) — see the module doc in data/loadout.ts.
   */
  buyWeapon(kind: WeaponKind): boolean {
    return this.playerSystem.buyWeapon(kind);
  }

  /** Buys exactly the next armor tier up from the one currently worn. */
  buyArmorTier(): boolean {
    return this.playerSystem.buyArmorTier();
  }

  spawnEnemy(def: EnemyDef, x: number, y: number, hpMult: number, dmgMult: number, elite: boolean): Enemy {
    return this.enemySystem.spawnEnemy(def, x, y, hpMult, dmgMult, elite);
  }

  /* ====================================================================== */
  /* Buildings                                                               */
  /* ====================================================================== */

  private updateBuildings(dt: number) {
    this.buildingSystem.updateBuildings(dt);
  }

  spawnDrone(bay: Building): Drone {
    return this.droneSystem.spawnDrone(bay);
  }

  /** Fills every bay to capacity at once, ignoring respawn timers. */
  fillDroneBays() {
    this.droneSystem.fillDroneBays();
  }

  damageDrone(d: Drone, amount: number) {
    this.droneSystem.damageDrone(d, amount);
  }

  /** The active Force Field (if any) whose dome covers this point. */
  fieldAt(x: number, y: number): Building | null {
    return this.buildingSystem.fieldAt(x, y);
  }

  /**
   * Routes ranged damage aimed at (x, y) into a covering Force Field's own
   * hp instead of the actual target, if one is up. Returns whether it was
   * absorbed — callers skip their normal damage application when true.
   */
  absorbIntoField(x: number, y: number, amount: number): boolean {
    return this.buildingSystem.absorbIntoField(x, y, amount);
  }


  /* ====================================================================== */
  /* Enemies                                                                 */
  /* ====================================================================== */

  private rebuildBuildingHash() {
    this.buildingSystem.rebuildBuildingHash();
  }

  damageAlongLine(x0: number, y0: number, x1: number, y1: number, width: number, damage: number) {
    this.combatSystem.damageAlongLine(x0, y0, x1, y1, width, damage);
  }

  /* ====================================================================== */
  /* Projectiles                                                             */
  /* ====================================================================== */

  fire(o: {
    x: number; y: number; angle: number; speed: number; damage: number;
    kind: Projectile['kind']; faction: Projectile['faction']; color: number;
    size: number; life: number; armorPierce: number; ownerId: number; splash: number;
    pierce?: number; slowFactor?: number;
    homingTarget?: Enemy | null; homingTurn?: number;
  }) {
    this.combatSystem.fire(o);
  }

  fireMortar(
    x: number, y: number, tx: number, ty: number,
    damage: number, def: BuildingDef, owner: Building, flight: number,
  ) {
    this.combatSystem.fireMortar(x, y, tx, ty, damage, def, owner, flight);
  }

  /** Radial damage. `faction` is the *attacker*; splash never hits its own side. */
  explode(x: number, y: number, radius: number, damage: number, faction: 'player' | 'hive', pierce = 0) {
    this.combatSystem.explode(x, y, radius, damage, faction, pierce);
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
    this.enemySystem.damageEnemy(e, amount, opts);
  }

  damageBuilding(b: Building, amount: number) {
    this.buildingSystem.damageBuilding(b, amount);
  }

  damageCore(amount: number) {
    this.coreSystem.damageCore(amount);
  }

  damagePlayer(amount: number, silent = false) {
    this.playerSystem.damagePlayer(amount, silent);
  }

  /* ====================================================================== */
  /* Pickups, core, nodes, effects                                           */
  /* ====================================================================== */

  dropPickup(x: number, y: number, kind: PickupKind, amount: number) {
    this.pickupSystem.dropPickup(x, y, kind, amount);
  }

  private updateNodes(dt: number) {
    for (const n of this.world.nodes) n.shimmer += dt * 1.4;
  }

  /* ====================================================================== */
  /* Camera & feedback                                                       */
  /* ====================================================================== */

  setViewport(w: number, h: number) {
    this.presentation.setViewport(w, h);
  }

  shake(amount: number) {
    this.presentation.shake(amount);
  }

  addFlash(r: number, g: number, b: number, a: number) {
    this.presentation.addFlash(r, g, b, a);
  }

  /* ====================================================================== */
  /* Collision helpers                                                       */
  /* ====================================================================== */

  /** Pushes a circle out of solid buildings; returns the last one it touched. */
  collideWithBuildings(p: { x: number; y: number }, r: number): Building | null {
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

  /**
   * Whether a run snapshot is worth writing at all. Skirmish is excluded: it
   * isn't a `LEVELS` index (see `levelIndex`), so `resume()` would reject the
   * snapshot anyway — bailing out here just avoids clobbering a genuine
   * campaign/endless snapshot the player might still have with a useless one.
   */
  get canSaveRun() { return this.inBuildPhase && this.mode !== 'skirmish'; }

  /**
   * How stacked this run's tech is, 0-4 — the single source of truth the
   * renderer reads to escalate the player chassis's energy glow, and that
   * updatePlayer reads below to decide whether it should be throwing off
   * ambient sparks at the top tier. Deliberately separate from armor tier:
   * this is about power picked up in the field (tech cards), not gear bought
   * with essence.
   */
  get powerTier() { return Math.min(4, Math.floor(this.techTaken.length / 2)); }

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
    return this.droneSystem.droneCount(bay);
  }

  /** Unlocked structures in one section, in slot order. */
  categoryBuildings(category: BuildCategory): BuildingKind[] {
    return this.buildingSystem.categoryBuildings(category);
  }

  /** Sections that currently have anything in them — empty tabs are hidden. */
  get activeCategories(): BuildCategory[] {
    return this.buildingSystem.activeCategories;
  }

  /**
   * Points the bar at a structure, switching section if needed. Used by the
   * renderer's click routing and whenever a tech unlock should be discoverable.
   */
  selectBuilding(kind: BuildingKind | null) {
    this.buildingSystem.selectBuilding(kind);
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
   * See runSnapshot.ts for the implementation — it needs none of this class's
   * private state, so it lives outside the class entirely.
   */
  snapshot(): RunSnapshot {
    return buildSnapshot(this);
  }

  /** Writes a snapshot if the run is in a resumable state. Safe to spam. */
  autoSaveRun() {
    if (!this.canSaveRun || this.phase === 'won' || this.phase === 'lost') return false;
    saveRun(this.snapshot());
    return true;
  }

  /** Drops any stored snapshot — call when a run ends or is abandoned. */
  discardSavedRun() {
    clearRun();
  }

  /**
   * Rebuilds a run from a snapshot. Returns false if the snapshot is unusable,
   * leaving the game untouched. See runSnapshot.ts for the implementation.
   */
  resume(snap: RunSnapshot): boolean {
    return applySnapshot(this, snap);
  }

  /** Places a saved structure without charging for it or playing build FX. */
  restoreBuilding(def: BuildingDef, tx: number, ty: number, hp: number) {
    this.buildingSystem.restoreBuilding(def, tx, ty, hp);
  }

  static loadSnapshot() {
    return loadRun();
  }

  carryOver() {
    return {
      perks: this.perks,
      tech: [...this.techTaken],
      unlocked: [...this.unlockedBuildings],
      weaponsOwned: [...this.player.weaponsOwned],
      weapon: this.player.weapon,
      armorTier: this.player.armorTier,
    };
  }

  /** Terrain colour for a tile, cached-free but cheap; used by the renderer. */
  tileTint(tx: number, ty: number): number {
    const pal = this.level.palette;
    if (this.world.tileAt(tx, ty) === Tile.Hazard) return pal.hazardColor;
    const d = this.world.detail[this.world.idx(tx, ty)];
    return lerp(0, 1, d) > 0.5 ? pal.ground1 : pal.ground0;
  }
}

export { FlowField };
