import type { BuildingDef, BuildingKind, TargetingMode } from '../data/buildings';
import type { EnemyDef } from '../data/enemies';
import type { WeaponKind } from '../data/loadout';

/** Everything in the world shares these fields so systems can treat them alike. */
export interface Body {
  x: number;
  y: number;
  radius: number;
  dead: boolean;
}

export type Faction = 'player' | 'hive';

/* -------------------------------------------------------------------------- */

export class Core implements Body {
  x: number;
  y: number;
  radius = 42;
  dead = false;
  hp: number;
  maxHp: number;
  shield = 0;
  maxShield = 0;
  /** Ramps 0→1 as HP drops; drives the warning klaxon and red vignette. */
  distress = 0;
  hitFlash = 0;
  spin = 0;
  /** Set the frame a revive perk fires, for the shockwave VFX. */
  reviveFlash = 0;

  constructor(x: number, y: number, hp: number) {
    this.x = x;
    this.y = y;
    this.hp = hp;
    this.maxHp = hp;
  }

  get pct() { return Math.max(0, this.hp / this.maxHp); }
}

/* -------------------------------------------------------------------------- */

export class Player implements Body {
  x: number;
  y: number;
  radius = 13;
  dead = false;
  hp: number;
  maxHp: number;
  vx = 0;
  vy = 0;
  /** Facing angle of the chassis (lags the aim). */
  facing = 0;
  /** Turret/aim angle, snaps to the cursor. */
  aim = 0;
  cooldown = 0;
  /** Mining beam target tile index, -1 when idle. */
  miningNode = -1;
  miningHeat = 0;
  hitFlash = 0;
  invuln = 0;
  dashCooldown = 0;
  dashTime = 0;
  dashDirX = 0;
  dashDirY = 0;
  /** Bought mid-run with essence — see data/loadout.ts and Game.buyWeapon. */
  weapon: WeaponKind = 'rifle';
  weaponsOwned: Set<WeaponKind> = new Set<WeaponKind>(['rifle']);
  /** Bought mid-run with essence — see data/loadout.ts and Game.buyArmorTier. */
  armorTier = 0;
  /** Walk-cycle phase for the leg animation. */
  stride = 0;
  recoil = 0;
  /** Overheat 0..1 — firing raises it, it vents when you stop. */
  heat = 0;
  overheated = false;

  constructor(x: number, y: number, hp: number) {
    this.x = x;
    this.y = y;
    this.hp = hp;
    this.maxHp = hp;
  }
}

/* -------------------------------------------------------------------------- */

export class Building implements Body {
  static nextId = 1;

  readonly id = Building.nextId++;
  readonly def: BuildingDef;
  readonly kind: BuildingKind;
  /** Top-left tile of the footprint. */
  tx: number;
  ty: number;
  size: number;
  x: number;
  y: number;
  radius: number;
  dead = false;

  hp: number;
  maxHp: number;
  shield = 0;
  maxShield = 0;

  /**
   * Force Field only (see BuildingDef.fieldHp): the dome's own hp pool while
   * charging or holding. `fieldChargeTimer > 0` means charging/recharging;
   * `fieldChargeTotal` is that cycle's full duration, so the renderer can
   * show progress without re-deriving which of chargeTime/rechargeTime is
   * currently in effect. See Game.updateForceField / popForceField.
   */
  fieldHp = 0;
  fieldMaxHp = 0;
  fieldChargeTimer = 0;
  fieldChargeTotal = 0;

  /** 0..1; the structure is inert until it reaches 1. */
  progress = 0;
  get built() { return this.progress >= 1; }

  // weapon state
  angle = 0;
  cooldown = 0;
  burstLeft = 0;
  burstTimer = 0;
  target: Enemy | null = null;
  targeting: TargetingMode = 'first';
  /** Continuous beam weapons keep a live intensity for rendering. */
  beamIntensity = 0;
  beamHitX = 0;
  beamHitY = 0;
  recoil = 0;
  muzzleFlash = 0;
  hitFlash = 0;
  kills = 0;
  /** Extractor: the seam it is sitting on. */
  nodeIndex = -1;
  extractBuffer = 0;
  /** Drone Bay: seconds until the next lost drone is rebuilt. */
  droneCooldown = 0;
  /** Drone Bay: pulses when a drone unloads, for the deposit flash. */
  depositFlash = 0;
  /** Powered fraction this frame, 0..1. */
  efficiency = 1;
  /** Cosmetic idle offset so identical buildings don't animate in lockstep. */
  phase: number;

  constructor(def: BuildingDef, tx: number, ty: number, tile: number, hpMult: number) {
    this.def = def;
    this.kind = def.id;
    this.tx = tx;
    this.ty = ty;
    this.size = def.size;
    this.x = (tx + def.size / 2) * tile;
    this.y = (ty + def.size / 2) * tile;
    this.radius = (def.size * tile) / 2;
    this.maxHp = Math.round(def.hp * hpMult);
    this.hp = this.maxHp;
    this.phase = Math.random() * Math.PI * 2;
  }

  get isTurret() { return this.def.damage !== undefined; }
  get pct() { return this.hp / this.maxHp; }
}

/* -------------------------------------------------------------------------- */

export type StatusKind = 'slow' | 'burn' | 'stun' | 'shred';

export class Enemy implements Body {
  static nextId = 1;

  readonly id = Enemy.nextId++;
  readonly def: EnemyDef;
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  radius: number;
  dead = false;

  hp: number;
  maxHp: number;
  armor: number;
  speed: number;
  damage: number;
  /** Boss / elite flags. */
  boss: boolean;
  elite = false;

  angle = 0;
  attackCooldown = 0;
  /** What this unit is currently chewing on. */
  targetBuilding: Building | null = null;
  targetIsCore = false;
  retargetIn = 0;

  hitFlash = 0;
  slowTimer = 0;
  slowFactor = 1;
  burnTimer = 0;
  burnDps = 0;
  stunTimer = 0;
  shredStacks = 0;

  /** Burrowers: >0 while phased through walls and untargetable. */
  burrowTimer = 0;
  burrowCooldown = 0;
  submerged = false;

  /**
   * Seconds spent being heavily shoved by terrain collision every frame —
   * the signature of being wedged in rock too narrow for this body's radius
   * (mainly a risk for bosses). See Game's enemy update loop, which resets
   * this whenever the terrain push is small and teleports the unit free of
   * whatever it's wedged in once this crosses a threshold.
   */
  stuckTimer = 0;

  /** Support aura pulse phase. */
  auraPhase = Math.random() * Math.PI * 2;
  /** Bosses: index → remaining cooldown, plus the active telegraph. */
  abilityCd: number[] = [];
  castingIndex = -1;
  castTimer = 0;
  chargeTimer = 0;
  chargeDirX = 0;
  chargeDirY = 0;
  shieldHp = 0;
  shieldMax = 0;
  /** Animation clock, offset per unit. */
  anim = Math.random() * 100;
  /** Distance travelled, used for gait animation. */
  gait = 0;
  /** Who spawned it — used so split children don't re-award full bounty. */
  spawnedBy = 0;
  /** Wave index this unit belongs to; the director uses it to detect clears. */
  wave = 0;
  /**
   * Set on stragglers once a wave has overstayed its window. A berserk unit stops
   * choosing distant structures to chew on and drives straight for the core, which
   * guarantees the wave can always resolve. See Game.enrageStragglers.
   */
  berserk = false;

  constructor(def: EnemyDef, x: number, y: number, hpMult: number, dmgMult: number) {
    this.def = def;
    this.x = x;
    this.y = y;
    this.radius = def.radius;
    this.maxHp = Math.round(def.hp * hpMult);
    this.hp = this.maxHp;
    this.armor = def.armor;
    this.speed = def.speed;
    this.damage = def.damage * dmgMult;
    this.boss = !!def.boss;
    if (def.abilities) this.abilityCd = def.abilities.map((a) => a.cooldown * 0.5);
  }

  get effectiveSpeed() {
    if (this.stunTimer > 0) return 0;
    return this.speed * (this.slowTimer > 0 ? this.slowFactor : 1);
  }

  get flying() { return this.def.behavior === 'flyer' || !!this.def.flies; }
  get targetable() { return !this.dead && !this.submerged; }
}

/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */

export type DroneState = 'toSeam' | 'mining' | 'toBay' | 'idle';

/**
 * A hover drone owned by a Drone Bay.
 *
 * Deliberately a flier: it ignores terrain entirely, which sidesteps per-unit
 * pathfinding (the flow field only leads to the core) *and* justifies why it is
 * exposed — a drone crossing open ground during a wave is in real danger. That
 * risk is the point; without it automation would just be free income.
 */
export class Drone implements Body {
  static nextId = 1;

  readonly id = Drone.nextId++;
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  radius = 8;
  dead = false;

  hp: number;
  maxHp: number;
  /** The bay that built it. When the bay dies, so does the drone. */
  bayId: number;

  state: DroneState = 'idle';
  /** Index into world.nodes, or -1 when it has no assignment. */
  nodeIndex = -1;
  cargo = 0;
  cargoMax: number;

  angle = 0;
  /** Rotor phase and hover bob, offset per unit so they do not pulse in sync. */
  anim = Math.random() * 100;
  hitFlash = 0;
  /** Ramps while working a seam, driving the mining beam's intensity. */
  beam = 0;

  constructor(x: number, y: number, hp: number, cargoMax: number, bayId: number) {
    this.x = x;
    this.y = y;
    this.hp = hp;
    this.maxHp = hp;
    this.cargoMax = cargoMax;
    this.bayId = bayId;
  }

  get full() { return this.cargo >= this.cargoMax; }
}

/* -------------------------------------------------------------------------- */

export type ProjKind =
  | 'bullet' | 'shell' | 'flak' | 'mortar' | 'rocket' | 'spit' | 'bossOrb' | 'plasma';

export class Projectile implements Body {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  radius = 3;
  dead = true;

  kind: ProjKind = 'bullet';
  faction: Faction = 'player';
  damage = 0;
  splash = 0;
  armorPierce = 0;
  pierce = 0;
  life = 0;
  maxLife = 0;
  color = 0xffffff;
  size = 3;
  /** Mortars: parabolic flight toward a fixed ground point. */
  targetX = 0;
  targetY = 0;
  z = 0;
  flightTime = 0;
  flightTotal = 0;
  /** Owner id, so a shell cannot hit the turret that fired it. */
  ownerId = 0;
  hitIds: number[] = [];
  trail = 0;
  slowFactor = 0;
  /** Guided munitions: the unit being tracked, re-acquired if it dies mid-flight. */
  target: Enemy | null = null;
  /** rad/s the projectile can steer. 0 = unguided. */
  homingTurn = 0;
  /** Exhaust puff timer, kept separate from the generic trail clock. */
  exhaust = 0;
}

/* -------------------------------------------------------------------------- */

export type PickupKind = 'ore' | 'essence' | 'health' | 'relic';

export class Pickup implements Body {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  radius = 7;
  dead = true;
  kind: PickupKind = 'essence';
  amount = 0;
  life = 0;
  bob = 0;
  /** Set once the magnet grabs it; it then homes at increasing speed. */
  homing = false;
  homeSpeed = 0;
}

/* -------------------------------------------------------------------------- */

/** Short-lived visual + damage volume: tesla arcs, boss beams, shockwaves. */
export interface Effect {
  kind: 'arc' | 'beam' | 'shock' | 'telegraph';
  x: number; y: number;
  x2: number; y2: number;
  radius: number;
  life: number;
  maxLife: number;
  color: number;
  width: number;
  /** Random offsets baked once so lightning doesn't reshuffle every frame. */
  seed: number;
}

export interface DamageNumber {
  x: number; y: number;
  vy: number;
  life: number;
  value: number;
  crit: boolean;
  color: number;
}
