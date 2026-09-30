import type { Quality } from './platform';
import type { SfxName } from './audio';

/**
 * Exposed by electron/preload.cjs. Present only under Electron — everywhere
 * else (plain web, Capacitor) storage stays on localStorage, unchanged.
 */
declare global {
  interface Window {
    swarmNative?: {
      readFileSync(name: string): string | null;
      writeFile(name: string, content: string): void;
    };
  }
}

/**
 * Storage backend, swapped transparently so every call site below stays
 * synchronous either way. Electron writes a real file in the OS user-data
 * directory instead of localStorage so a tool like Steam Cloud — which syncs
 * files, not browser storage — can actually back it up. Reads go through
 * `ipcRenderer.sendSync` in the preload bridge, which is the one thing that
 * keeps this synchronous instead of forcing `loadSave`/`loadRun` (and every
 * one of their callers, right up through `Progress`'s constructor) to become
 * async.
 */
function readStorage(key: string): string | null {
  const native = typeof window !== 'undefined' ? window.swarmNative : undefined;
  return native ? native.readFileSync(key) : localStorage.getItem(key);
}

function writeStorage(key: string, value: string) {
  const native = typeof window !== 'undefined' ? window.swarmNative : undefined;
  if (native) native.writeFile(key, value);
  else localStorage.setItem(key, value);
}

/** An empty file reads back as falsy, same as a missing key — good enough as a delete. */
function removeStorage(key: string) {
  const native = typeof window !== 'undefined' ? window.swarmNative : undefined;
  if (native) native.writeFile(key, '');
  else localStorage.removeItem(key);
}

/** Everything that survives between runs. Versioned so old saves can migrate. */
export interface SaveData {
  version: number;
  /** Achievement id → progress counter (a value >= its goal means unlocked). */
  achievements: Record<string, number>;
  unlocked: string[];
  /** Highest level index the player has cleared, -1 = none. */
  highestLevel: number;
  relics: number;
  /** Relic upgrade id → purchased rank. Absent means rank 0. */
  relicUpgrades: Record<string, number>;
  /** Lifetime relics earned, for the "spent / earned" readout. */
  relicsEarned: number;
  /** Endless personal best: sector index → highest wave reached. */
  endlessBest: Record<string, number>;
  /** Shown once, right before the player's first deployment. */
  /** Touch coach tips already shown/learned — see render/coach.ts. */
  coachDone: string[];
  /** Hive types the player has been introduced to (new-enemy card, bestiary). */
  seenEnemies: string[];
  /**
   * Ceiling the frame-rate governor learned for 'auto' quality on this device
   * (see core/autoQuality.ts), so a slow phone doesn't re-stutter every boot.
   * Cleared whenever the player changes the quality setting themselves.
   */
  autoQualityCap: Quality | null;
  stats: {
    runs: number;
    victories: number;
    kills: number;
    bossKills: number;
    oreMined: number;
    essenceCollected: number;
    buildingsBuilt: number;
    wavesSurvived: number;
    damageDealt: number;
    playSeconds: number;
    bestWave: number;
    noLossVictories: number;
  };
  settings: {
    sfx: number;
    music: number;
    ui: number;
    muted: boolean;
    screenShake: number;
    showDamageNumbers: boolean;
    bloom: boolean;
    /** 'auto' follows the pointer type; the rest force a scheme. */
    controls: 'auto' | 'touch' | 'desktop';
    /** Render quality tier; 'auto' re-detects on every boot. */
    quality: 'auto' | 'low' | 'medium' | 'high';
    /** Aim and fire the player weapon automatically. Default on for touch. */
    autoAim: boolean;
    /** Mine the nearest seam in range without holding a button. */
    autoMine: boolean;
    /** Extra scale applied to HUD text and touch targets. */
    uiScale: number;
    /** Left-handed layout: mirrors the touch controls. */
    southpaw: boolean;
    haptics: boolean;
    /** 'auto' follows the browser's language; the rest force one. */
    locale: 'auto' | 'en' | 'ru' | 'de' | 'es' | 'fr';
    /** New Game+ tier, 1-10. Only offered once the campaign has been cleared once. */
    ngTier: number;
  };
}

const KEY = 'swarm.save.v1';
const VERSION = 3;

export function emptySave(): SaveData {
  return {
    version: VERSION,
    achievements: {},
    unlocked: [],
    highestLevel: -1,
    relics: 0,
    relicUpgrades: {},
    relicsEarned: 0,
    endlessBest: {},
    coachDone: [],
    seenEnemies: [],
    autoQualityCap: null,
    stats: {
      runs: 0, victories: 0, kills: 0, bossKills: 0, oreMined: 0,
      essenceCollected: 0, buildingsBuilt: 0, wavesSurvived: 0,
      damageDealt: 0, playSeconds: 0, bestWave: 0, noLossVictories: 0,
    },
    settings: {
      sfx: 0.85, music: 0.5, ui: 0.7, muted: false,
      screenShake: 1, showDamageNumbers: true, bloom: true,
      controls: 'auto', quality: 'auto',
      autoAim: false, autoMine: false,
      uiScale: 1, southpaw: false, haptics: true,
      locale: 'auto',
      ngTier: 1,
    },
  };
}

export function loadSave(): SaveData {
  try {
    const raw = readStorage(KEY);
    if (!raw) return emptySave();
    // `tutorialSeen` is from saves before the touch coach replaced the
    // up-front legend; it's read once below and deliberately not carried over.
    const { tutorialSeen, ...parsed } = JSON.parse(raw) as Partial<SaveData> & { tutorialSeen?: boolean };
    const base = emptySave();
    // Shallow-merge each section so new fields added in later versions appear.
    return {
      ...base,
      ...parsed,
      version: VERSION,
      achievements: { ...base.achievements, ...(parsed.achievements ?? {}) },
      relicUpgrades: { ...base.relicUpgrades, ...(parsed.relicUpgrades ?? {}) },
      endlessBest: { ...base.endlessBest, ...(parsed.endlessBest ?? {}) },
      unlocked: parsed.unlocked ?? [],
      // Players who already sat through the old up-front legend know how to
      // move and open the drawer; they still get the tips for newer gestures.
      coachDone: parsed.coachDone ?? (tutorialSeen ? ['move', 'build'] : []),
      // Veterans already know the opening pair; everything else still gets its card.
      seenEnemies: parsed.seenEnemies ?? ((parsed.stats?.runs ?? 0) > 0 ? ['crawler', 'mite'] : []),
      stats: { ...base.stats, ...(parsed.stats ?? {}) },
      settings: { ...base.settings, ...(parsed.settings ?? {}) },
    };
  } catch {
    return emptySave();
  }
}

let writeTimer: number | undefined;
let lastWrite = 0;

/** At most one write per this many ms during sustained play. */
const WRITE_INTERVAL = 1000;

function write(data: SaveData) {
  try {
    writeStorage(KEY, JSON.stringify(data));
    lastWrite = Date.now();
  } catch {
    /* quota or private mode — the run simply won't persist */
  }
}

/**
 * Throttled with a trailing write — deliberately NOT a plain debounce.
 *
 * `Progress.bump` fires on nearly every kill, so a debounce would cancel and
 * re-arm its timer many times a second and never actually write for the whole
 * duration of a fight. This guarantees a write at least every WRITE_INTERVAL
 * while still coalescing bursts.
 */
export function saveGame(data: SaveData) {
  const now = Date.now();
  if (now - lastWrite >= WRITE_INTERVAL) {
    clearTimeout(writeTimer);
    writeTimer = undefined;
    write(data);
    return;
  }
  // Already have a trailing write queued: leave it alone rather than pushing it back.
  if (writeTimer !== undefined) return;
  writeTimer = window.setTimeout(() => {
    writeTimer = undefined;
    write(data);
  }, WRITE_INTERVAL - (now - lastWrite));
}

/** Synchronous write. Use for anything whose loss would be unacceptable. */
export function saveNow(data: SaveData) {
  clearTimeout(writeTimer);
  writeTimer = undefined;
  write(data);
}

/* -------------------------------------------------------------------------- */
/* In-progress run snapshot                                                    */
/* -------------------------------------------------------------------------- */

const RUN_KEY = 'swarm.run.v1';
export const RUN_SNAPSHOT_VERSION = 3;

/**
 * A resumable run.
 *
 * Only ever written during a build phase, which is what keeps this small: there
 * are no live enemies, projectiles or particles to serialise. The world itself is
 * not stored either — it regenerates bit-for-bit from `seed`, so only the parts
 * the player changed (drained ore, placed structures) need saving.
 */
export interface RunSnapshot {
  v: number;
  mode: 'campaign' | 'endless' | 'skirmish';
  levelIndex: number;
  seed: number;
  waveIndex: number;
  prepRemaining: number;
  ore: number;
  essence: number;
  coreHp: number;
  coreShield: number;
  playerHp: number;
  playerX: number;
  playerY: number;
  tech: string[];
  unlocked: string[];
  weaponsOwned: string[];
  weapon: string;
  armorTier: number;
  /** `lv`/`br`: turret upgrade level and level-3 branch (absent = level 1; older saves). */
  buildings: { k: string; tx: number; ty: number; hp: number; lv?: number; br?: string }[];
  /** Orbital strike charge in kill points (absent in older saves = empty). */
  strike?: number;
  /** Remaining ore per seam, in world.nodes order. */
  nodes: number[];
  stats: {
    kills: number; bossKills: number; oreMined: number; essenceCollected: number;
    built: number; damage: number; structuresLost: number; wavesCleared: number;
    coreDamage: number; timeSeconds: number; bestPower: number;
    dronesLost: number; droneOre: number;
  };
  savedAt: number;
}

export function saveRun(snap: RunSnapshot) {
  try {
    writeStorage(RUN_KEY, JSON.stringify(snap));
  } catch { /* ignore */ }
}

export function loadRun(): RunSnapshot | null {
  try {
    const raw = readStorage(RUN_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as RunSnapshot;
    // A snapshot from an older layout cannot be trusted against new code.
    if (snap?.v !== RUN_SNAPSHOT_VERSION) { clearRun(); return null; }
    return snap;
  } catch {
    clearRun();
    return null;
  }
}

export function clearRun() {
  try { removeStorage(RUN_KEY); } catch { /* ignore */ }
}

export function hasRun() {
  return loadRun() !== null;
}

export function wipeSave() {
  try { removeStorage(KEY); } catch { /* ignore */ }
  clearRun();
}

/** Re-export so UI modules can type sound hooks without importing the engine. */
export type { SfxName };
