import './style.css';
import { audio } from './core/audio';
import { Input } from './core/input';
import { saveNow, clearRun } from './core/save';
import { LEVELS, type LevelDef } from './data/levels';
import { achievementName, achievementDesc } from './data/achievements';
import { levelName } from './data/levels';
import type { TechCard } from './data/tech';
import type { BuildingKind } from './data/buildings';
import { Game, type GameMode } from './game/game';
import { Hud } from './render/hud';
import { Renderer } from './render/renderer';
import { Screens, type ResumeInfo } from './ui/screens';
import { TouchInput } from './core/touch';
import { TouchHud } from './render/touchHud';
import { Coach } from './render/coach';
import { detectCoarsePointer, detectQuality, isPortrait, type Quality } from './core/platform';
import { QualityGovernor, minQuality } from './core/autoQuality';
import { detectLocale, setLocale, getLocale, t } from './core/i18n';
import { hideStatusBar, lockOrientation, onBackButton, minimizeApp } from './core/native';

/**
 * Application shell.
 *
 * Owns the render loop and the coarse state machine (title → briefing → play →
 * results). The `Game` object is authoritative for the simulation; this file
 * only decides when it is allowed to run and which overlay is on top.
 */

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

const renderer = new Renderer(canvas);
const hud = new Hud();
const touchHud = new TouchHud();
const game = new Game();
const coach = new Coach(() => game.progress.data.coachDone, () => saveNow(game.progress.data));

/* -------------------------------------------------------------------------- */
/* Control scheme                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Both input readers exist; exactly one drives the simulation. Keyboard events
 * still reach the desktop reader on a tablet with a keyboard attached, but only
 * the active source is polled, so they can never fight each other.
 */
const keyboard = new Input(canvas);
const touch = new TouchInput(canvas);
let touchMode = false;

function resolveTouchMode(): boolean {
  const pref = game.progress.data.settings.controls;
  if (pref === 'touch') return true;
  if (pref === 'desktop') return false;
  return detectCoarsePointer();
}

function activeInput(): Input | TouchInput {
  return touchMode ? touch : keyboard;
}

function applyControlScheme() {
  touchMode = resolveTouchMode();
  const st = game.progress.data.settings;
  document.body.classList.toggle('touch', touchMode);
  hud.compact = touchMode;
  hud.uiScale = st.uiScale;
  hud.insets = renderer.insets;
  // Touch has no cursor to aim with, so this one is mandatory there; mining now
  // has a real touch gesture (hold near a seam, see TouchInput.mouseDown(2)),
  // so it stays an opt-in setting on every platform instead of being forced.
  game.autoAim = touchMode || st.autoAim;
  game.autoMine = st.autoMine;
  game.touchUi = touchMode;
  touch.setHaptics(st.haptics);
  touch.layout(renderer.width, renderer.height, { southpaw: st.southpaw, scale: st.uiScale, insets: renderer.insets });
  if (!touchMode) touch.reset();
}

/** Steps 'auto' quality down when the frame rate stays low (see autoQuality.ts). */
const governor = new QualityGovernor();
/** The tier actually in use, after 'auto' and any learned ceiling. */
let currentQuality: Quality = 'high';
let lastQualityPref: string | null = null;

function applyQuality() {
  const data = game.progress.data;
  const pref = data.settings.quality;
  // The player touching the setting overrides whatever the governor learned —
  // including re-picking 'auto', which is how to let a device try again.
  if (lastQualityPref !== null && pref !== lastQualityPref) {
    data.autoQualityCap = null;
    governor.reset();
  }
  lastQualityPref = pref;
  const cap = data.autoQualityCap;
  const q: Quality = pref !== 'auto' ? pref : cap ? minQuality(detectQuality(), cap) : detectQuality();
  currentQuality = q;
  renderer.setQuality(q);
  game.particles.density = renderer.quality.particleDensity;
  game.setViewport(renderer.width, renderer.height);
  hud.insets = renderer.insets;
  touch.layout(renderer.width, renderer.height, {
    southpaw: game.progress.data.settings.southpaw,
    scale: game.progress.data.settings.uiScale,
    insets: renderer.insets,
  });
}

type AppState = 'title' | 'briefing' | 'playing' | 'paused' | 'modal';
let state: AppState = 'title';
/** Set while a run exists, so pause/restart know what to act on. */
let runActive = false;

const screens = new Screens(uiRoot, {
  onStartLevel: (index, fresh) => beginLevel(index, fresh),
  onStartEndless: (index) => beginLevel(index, true, 'endless'),
  onStartSkirmish: (level) => beginLevel(level, true, 'skirmish'),
  onResumeRun: () => resumeRun(),
  onSaveAndQuit: () => saveAndQuit(),
  onResume: () => { state = 'playing'; game.frozen = false; },
  onRestart: () => beginLevel(game.mode === 'skirmish' ? game.level : game.levelIndex, true, game.mode),
  onQuitToTitle: () => abandonToTitle(),
  onPickTech: (card: TechCard) => {
    game.takeTech(card);
    state = 'playing';
  },
  onNextLevel: () => {
    const next = game.levelIndex + 1;
    if (next >= LEVELS.length) toTitle();
    else beginLevel(next, false, game.mode);
  },
  onSettingChange: () => {
    applySettings();
    applyControlScheme();
    applyQuality();
    saveNow(game.progress.data);
  },
});

const rotateMsg = document.getElementById('rotate-msg');
const rotateSub = document.getElementById('rotate-sub');

function applySettings() {
  const s = game.progress.data.settings;
  audio.setVolume('sfx', s.sfx);
  audio.setVolume('music', s.music);
  audio.setVolume('ui', s.ui);
  audio.setMuted(s.muted);
  setLocale(s.locale === 'auto' ? detectLocale() : s.locale);
  document.documentElement.lang = getLocale();
  // Experimental portrait layout: text flipped along with the gate itself in
  // updateOrientationGate(). Translations still say "landscape" until this
  // sticks — not worth touching 5 locale files for a reversible experiment.
  if (rotateMsg) rotateMsg.textContent = t('main.rotate.msg', 'Rotate your device');
  if (rotateSub) rotateSub.textContent = t('main.rotate.sub', 'SWARM is played in portrait');
}

/* -------------------------------------------------------------------------- */
/* Flow                                                                        */
/* -------------------------------------------------------------------------- */

/** Describes a stored snapshot for the title screen, or null if there is none. */
function resumeInfo(): ResumeInfo | null {
  const snap = Game.loadSnapshot();
  if (!snap) return null;
  const lv = LEVELS[snap.levelIndex];
  return {
    levelName: lv ? levelName(lv) : t('main.resume.unknownSector', 'Unknown sector'),
    wave: snap.waveIndex + 1,
    endless: snap.mode === 'endless',
  };
}

function toTitle() {
  runActive = false;
  state = 'title';
  audio.stopMusic();
  game.frozen = true;
  saveNow(game.progress.data);
  screens.showTitle(game.progress, resumeInfo());
}

/** Abandoning a run must not leave its snapshot behind to be resumed later. */
function abandonToTitle() {
  clearRun();
  toTitle();
}

function resumeRun() {
  const snap = Game.loadSnapshot();
  if (!snap || !game.resume(snap)) {
    // Corrupt or incompatible snapshot: drop it and fall back to the title.
    clearRun();
    toTitle();
    return;
  }
  audio.unlock();
  applySettings();
  applyControlScheme();
  game.setViewport(renderer.width, renderer.height);
  runActive = true;
  state = 'playing';
  game.frozen = false;
  screens.close();
}

function saveAndQuit() {
  if (!game.autoSaveRun()) {
    // Should not happen — the button is only offered in a build phase.
    alert('The run can only be saved during a build phase.');
    return;
  }
  runActive = false;
  state = 'title';
  audio.stopMusic();
  saveNow(game.progress.data);
  screens.showTitle(game.progress, resumeInfo());
}

function beginLevel(index: number | LevelDef, fresh: boolean, mode: GameMode = 'campaign') {
  audio.unlock();
  applySettings();
  // Starting anything new invalidates a stored run.
  clearRun();
  const carry = !fresh && runActive ? game.carryOver() : undefined;
  game.startLevel(index, carry, undefined, { mode });
  applyControlScheme();
  game.setViewport(renderer.width, renderer.height);
  runActive = true;
  game.frozen = true;
  state = 'briefing';
  screens.showBriefing(game, () => {
    // Touch controls are taught in context by the coach (render/coach.ts)
    // rather than an up-front legend; the legend lives on in the pause menu.
    coach.reset();
    state = 'playing';
    game.frozen = false;
  });
}

game.onPhaseChange = (phase) => {
  if (phase === 'won') {
    state = 'modal';
    const isFinal = game.levelIndex >= LEVELS.length - 1;
    // Let the death animation breathe before the results land.
    setTimeout(() => screens.showVictory(game, isFinal), 1500);
  } else if (phase === 'lost') {
    state = 'modal';
    setTimeout(() => screens.showDefeat(game), 1800);
  }
};

game.onDraft = (cards) => {
  state = 'modal';
  screens.showDraft(cards);
};

/* -------------------------------------------------------------------------- */
/* HUD click routing                                                           */
/* -------------------------------------------------------------------------- */

/** True when the pointer is over canvas chrome, so world clicks are suppressed. */
function overHud(x: number, y: number): boolean {
  const w = renderer.width, h = renderer.height;
  if (y < 116) return true;                       // top bar + wave tracker
  if (y > h - 142) return true;                   // section tabs + build bar + legend
  if (x > w - 200 && y > h - 200) return true;    // minimap
  if (x < 210 && y > h - 230) return true;        // status rail
  return false;
}

canvas.addEventListener('pointerdown', (e) => {
  audio.unlock();
  if (touchMode) return;              // touch routing lives in handleTouch()
  if (state !== 'playing') return;
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;

  // Section tabs sit directly above the slots, so they are tested first.
  const tab = hud.hitCategoryTab(mx, my);
  if (tab) {
    if (game.buildCategory !== tab) {
      game.buildCategory = tab;
      game.selectBuilding(null);
      audio.play('uiClick');
    }
    return;
  }

  for (const slot of hud.buildSlots) {
    if (mx >= slot.x && mx <= slot.x + slot.w && my >= slot.y && my <= slot.y + slot.h) {
      if (game.buildKind === slot.kind) {
        game.selectBuilding(null);
        audio.play('uiBack');
      } else {
        game.selectBuilding(slot.kind);
        audio.play('uiClick');
      }
      return;
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Global keys                                                                 */
/* -------------------------------------------------------------------------- */

/** Shared by the Escape key and the Android hardware back button. */
function togglePause() {
  if (state === 'playing') {
    state = 'paused';
    game.frozen = true;
    audio.play('uiBack');
    screens.showPause(game, game.canSaveRun);
  } else if (state === 'paused') {
    screens.close();
    state = 'playing';
    game.frozen = false;
  }
}

/** Also reachable from the pause menu — this is the direct-from-play shortcut. */
function openLoadout() {
  if (state !== 'playing') return;
  state = 'modal';
  game.frozen = true;
  audio.play('uiBack');
  screens.showLoadout(game, () => { state = 'playing'; game.frozen = false; });
}

addEventListener('keydown', (e) => {
  if (e.code === 'Escape') togglePause();
  if (e.code === 'KeyG') openLoadout();
  if (e.code === 'Tab') {
    e.preventDefault();
    hud.showStats = !hud.showStats;
  }
  if (e.code === 'KeyM') {
    const s = game.progress.data.settings;
    s.muted = !s.muted;
    audio.setMuted(s.muted);
    saveNow(game.progress.data);
  }
});

// Android hardware/gesture back button — a no-op listener registration on
// web and iOS, since neither platform has an equivalent event.
void onBackButton(() => {
  if (state === 'playing' || state === 'paused') {
    togglePause();
  } else if (screens.current === null || screens.current === 'title') {
    void minimizeApp();
  }
  // Any other modal screen (settings, achievements, level select, …): swallow
  // the press rather than guess a destination. Several of their own "Back"
  // buttons return to the title screen regardless of how they were opened,
  // so mirroring that via hardware back risks quietly abandoning a run that
  // was only paused to open, say, Settings.
});

function onViewportChange() {
  renderer.resize();
  game.setViewport(renderer.width, renderer.height);
  hud.insets = renderer.insets;
  touch.layout(renderer.width, renderer.height, {
    southpaw: game.progress.data.settings.southpaw,
    scale: game.progress.data.settings.uiScale,
    insets: renderer.insets,
  });
  updateOrientationGate();
}

addEventListener('resize', onViewportChange);
addEventListener('orientationchange', () => setTimeout(onViewportChange, 120));
matchMedia('(orientation: portrait)').addEventListener('change', () => {
  setTimeout(onViewportChange, 60);
});

function persistEverything() {
  saveNow(game.progress.data);
  // Only writes when the run is in a resumable state; a no-op mid-wave.
  if (runActive) game.autoSaveRun();
}

addEventListener('beforeunload', persistEverything);

// `beforeunload` does not reliably fire on mobile or when a tab is discarded;
// `visibilitychange` → hidden is the one the platform actually guarantees.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistEverything();
});

/* -------------------------------------------------------------------------- */
/* Touch routing                                                              */
/* -------------------------------------------------------------------------- */

/** Structures placed by dragging a finger along the map, without ✓. */
const DRAG_PLACED = new Set<BuildingKind>(['wall']);

/** World point the pending placement ghost is pinned to (touch only). */
let ghostAnchor: { x: number; y: number } | null = null;

/**
 * Pins the touch placement ghost to the world.
 *
 * `TouchInput.mouseX/Y` is a screen point that only moves under a finger, but
 * the camera follows the player — so without this, walking with the stick
 * while a ✓ is pending would slide the ghost across the map. A finger on the
 * map re-aims the anchor; otherwise the screen point is re-derived from it.
 * Shake is left out on purpose: the ghost shouldn't jitter with the screen.
 */
function anchorGhost() {
  if (!touch.placing) { ghostAnchor = null; game.aimOverride = null; return; }
  const cam = game.camera;
  const w = renderer.width, h = renderer.height;
  // A fresh placement starts mid-screen, whatever the last tap was.
  if (!ghostAnchor && !touch.mapHeld && !touch.mapTap) {
    touch.mouseX = w / 2;
    touch.mouseY = h / 2;
  }
  if (touch.mapHeld || touch.mapTap || !ghostAnchor) {
    ghostAnchor = {
      x: cam.x + (touch.mouseX - w / 2) / cam.zoom,
      y: cam.y + (touch.mouseY - h / 2) / cam.zoom,
    };
  } else {
    touch.mouseX = (ghostAnchor.x - cam.x) * cam.zoom + w / 2;
    touch.mouseY = (ghostAnchor.y - cam.y) * cam.zoom + h / 2;
  }
  // Game aims from this world point directly: re-deriving it from the screen
  // point after the camera moves this frame would make the ghost swim a tile.
  game.aimOverride = ghostAnchor;
}

/** Which touch buttons exist right now, from drawer/placement/phase state. */
function syncTouchButtons() {
  touch.placing = game.cursorMode === 'build' && game.buildKind !== null;
  touch.confirmPlacement = touch.placing && !DRAG_PLACED.has(game.buildKind!);
  // The drawer covers the bottom of the screen, so the action cluster steps
  // aside; leaving it tappable underneath is how you dash instead of building.
  const drawer = touch.drawerOpen;
  const confirming = !drawer && touch.placing && touch.confirmPlacement;
  touch.setVisible('dash', !drawer);
  touch.setVisible('build', !drawer);
  touch.setVisible('confirm', confirming);
  // The "start wave" button only exists while a build window is open, and
  // gives its slot to ✓ while a placement is pending.
  touch.setVisible('startWave', !drawer && !confirming && game.inBuildPhase && game.prepRemaining > 2);
}

/** Consumes this frame's touch events and turns them into game actions. */
function handleTouch() {
  if (!touchMode) { game.aimOverride = null; game.buildCamHold = false; return; }
  if (state !== 'playing') return;
  const st = game.progress.data.settings;

  touch.drawerOpen = touch.drawerOpen && !screens.isModal;
  touch.placing = game.cursorMode === 'build' && game.buildKind !== null;
  touchHud.lastWidth = renderer.width;
  anchorGhost();

  // Build-mode look-around: dragging the map (off the ghost) moves the view,
  // which stays put until building ends, then eases back to the player.
  const pinch = touch.consumePinch();
  if (pinch !== 1) { game.zoomCamera(pinch); coach.saw('pinch'); }
  const pan = touch.consumePan();
  if (pan.x || pan.y) {
    game.panCamera(-pan.x / game.camera.zoom, -pan.y / game.camera.zoom);
    coach.saw('pan');
  }
  game.buildCamHold = touch.placing || touch.drawerOpen;

  syncTouchButtons();

  for (const b of touch.buttons) {
    if (!b.tapped) continue;
    switch (b.id) {
      case 'pause':
        state = 'paused';
        game.frozen = true;
        touch.reset();
        audio.play('uiBack');
        screens.showPause(game, game.canSaveRun);
        break;
      case 'build':
        if (touch.drawerOpen) {
          touch.drawerOpen = false;
        } else if (game.buildKind) {
          // A tool is already selected: cancel it in place instead of
          // reopening the drawer — backing out of a placement shouldn't cost
          // a second tap to then dismiss the drawer too.
          game.buildKind = null;
          game.cursorMode = 'normal';
        } else {
          touch.drawerOpen = true;
          touchHud.drawerInfo = null;
        }
        touchHud.closeMenu();
        audio.play('uiClick');
        break;
      case 'startWave':
        // Reuse the same path the SPACE key takes.
        game.skipBuildPhase();
        break;
      case 'map':
        hud.showMinimap = !hud.showMinimap;
        audio.play('uiClick');
        break;
      case 'dash':
      case 'confirm':
        break;                        // read by Game via input.pressed / mouseDown
    }
  }

  // Again, now that a tap may have opened/closed the drawer — otherwise this
  // frame draws Dash/Close on top of a freshly opened drawer.
  syncTouchButtons();

  // Long press on a structure opens the context menu.
  const lp = touch.consumeLongPress();
  if (lp && touch.drawerOpen) {
    // Long-press a drawer slot for its details; a tap still builds.
    const kind = touchHud.hitDrawer(lp.x, lp.y);
    if (kind) { touchHud.drawerInfo = kind; audio.play('uiClick'); }
  } else if (lp) {
    if (game.hoverBuilding) touchHud.openMenu(lp.x, lp.y, game.hoverBuilding);
    else touchHud.closeMenu();
  }

  // Taps: menu first, then drawer, then the world.
  const tap = touch.mapTap;
  if (tap) {
    if (touchHud.menu) {
      const hit = touchHud.hitMenu(tap.x, tap.y);
      if (hit) {
        // The structure captured when the menu opened — hover has already
        // moved to wherever this tap landed.
        const b = touchHud.menuTarget;
        let keepOpen = hit === 'repair' || hit === 'target';
        if (hit === 'sell' && b) {
          // First tap arms, second sells — see TouchHud.sellArmed.
          if (touchHud.sellArmed) game.sellBuilding(b);
          else { touchHud.armSell(); keepOpen = true; }
        } else {
          // Anything else backs out of a pending sale.
          touchHud.disarmSell();
          if (hit === 'repair' && b) game.repairBuildingBurst(b);
          else if (hit === 'target' && b) game.cycleTargeting(b);
        }
        if (!keepOpen) touchHud.closeMenu();
        audio.play('uiClick');
        touch.consumeTap();
        return;
      }
      touchHud.closeMenu();
    }

    if (touch.drawerOpen) {
      const kind = touchHud.hitDrawer(tap.x, tap.y);
      if (kind) {
        game.buildKind = game.buildKind === kind ? null : kind;
        game.cursorMode = game.buildKind ? 'build' : 'normal';
        // Collapse so the map is visible for placement.
        if (game.buildKind) {
          touch.drawerOpen = false;
          // The tap that picked the drawer slot already landed near the
          // bottom of the screen and got recorded as a world position (drawer
          // icons aren't real TouchInput buttons) — recentre it, or the very
          // first placement ghost shows up under the drawer instead of where
          // the player is standing.
          touch.mouseX = renderer.width / 2;
          touch.mouseY = renderer.height / 2;
        }
        audio.play('uiClick');
        touch.consumeTap();
        return;
      }
      // Anywhere else dismisses the drawer rather than reaching the world — a
      // stray tap should never place or sell something behind an open panel.
      touch.drawerOpen = false;
      audio.play('uiBack');
      touch.consumeTap();
      return;
    }
    // Otherwise it falls through to Game, which reads mouseClicked(0).
  }

  void st;
}

/* -------------------------------------------------------------------------- */
/* Orientation                                                                */
/* -------------------------------------------------------------------------- */

let gateBlocked = false;

/**
 * Shows the rotate prompt in landscape.
 *
 * Experimental portrait layout: inverted from the original landscape-required
 * gate rather than rewritten, so flipping back is a one-line change.
 *
 * Also polled from the render loop rather than trusting `resize` alone: some
 * browsers report stale dimensions during a rotation, and a stuck gate makes the
 * game look broken. The check is two number comparisons, so polling is free.
 */
function updateOrientationGate() {
  const block = touchMode && !isPortrait();
  if (block === gateBlocked) return;
  gateBlocked = block;
  document.body.classList.toggle('portrait-block', block);
  if (block && state === 'playing') {
    state = 'paused';
    game.frozen = true;
    touch.reset();
  }
}

/**
 * Fullscreen has to be requested from a gesture; the first tap is the moment.
 *
 * The orientation lock and status bar hide route through Capacitor's plugin
 * API (see core/native.ts) instead of the raw web APIs — that also gives the
 * native Android/iOS builds a real lock instead of relying on the WebView's
 * patchy support for the Screen Orientation Web API.
 */
async function tryFullscreen() {
  if (!touchMode) return;
  void hideStatusBar();
  void lockOrientation();
  if (document.fullscreenElement) return;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // Denied or unsupported — the game still works in the browser chrome.
  }
}

/* -------------------------------------------------------------------------- */
/* Crash handling                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A `requestAnimationFrame` callback that throws never reports anything to the
 * player: the browser eats the error, the callback simply never reschedules
 * itself, and the last drawn frame just sits there looking like a hang. This
 * is the one recovery path for that — stop, save whatever is safe to save,
 * and tell the player instead of leaving them staring at a dead screen.
 */
let crashed = false;

function showCrash(err: unknown) {
  if (crashed) return;
  crashed = true;

  console.error('[SWARM] unhandled error', err);

  // Best-effort persistence. Neither call is allowed to block the crash UI —
  // autoSaveRun already no-ops outside a build phase, but a corrupted state is
  // exactly the situation where "safe elsewhere" assumptions stop holding.
  try { game.autoSaveRun(); } catch { /* ignore */ }
  try { saveNow(game.progress.data); } catch { /* ignore */ }

  try {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : '';
    const details = `${message}\n${stack}`.trim();

    const overlay = document.createElement('div');
    overlay.id = 'crash-overlay';
    const panel = document.createElement('div');
    panel.className = 'crash-panel';

    const title = document.createElement('div');
    title.className = 'crash-title';
    title.textContent = t('main.crash.title', 'Something went wrong');
    panel.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'crash-sub';
    sub.textContent = t('main.crash.sub',
      'The game hit an unexpected error and stopped. Anything saved at your last build phase is safe.');
    panel.appendChild(sub);

    const detailsBox = document.createElement('textarea');
    detailsBox.className = 'crash-details';
    detailsBox.readOnly = true;
    detailsBox.value = details;
    panel.appendChild(detailsBox);

    const actions = document.createElement('div');
    actions.className = 'crash-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn ghost';
    copyBtn.textContent = t('main.crash.copy', 'Copy details');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(details).then(
        () => { copyBtn.textContent = t('main.crash.copied', 'Copied'); },
        () => { /* clipboard unavailable — the text is still there to select by hand */ },
      );
    });
    actions.appendChild(copyBtn);

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn';
    reloadBtn.textContent = t('main.crash.reload', 'Reload');
    reloadBtn.addEventListener('click', () => location.reload());
    actions.appendChild(reloadBtn);

    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  } catch {
    // The styled overlay itself failed to build — fall back to the one path
    // that can't, so the player at least learns the game died and why.
    alert('SWARM hit an unexpected error and needs to reload.');
  }
}

// Defence in depth: this catches anything NOT already caught inside frame()
// below — event handlers, timers, async code elsewhere in the app.
window.addEventListener('error', (e) => showCrash(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showCrash(e.reason));

/**
 * Lets the frame-rate governor drop 'auto' quality a tier on a device that
 * can't keep up — most often a phone zoomed far out, drawing a lot more map.
 * Only measured during live play in a visible tab; menus and a throttled
 * background tab say nothing about render cost.
 */
function governQuality(realDt: number) {
  const data = game.progress.data;
  if (data.settings.quality !== 'auto') return;
  const live = state === 'playing' && !game.frozen && document.visibilityState === 'visible';
  const next = governor.sample(realDt, live, currentQuality);
  if (!next) return;
  data.autoQualityCap = next;
  saveNow(data);
  applyQuality();
  const tier = next === 'low'
    ? t('screens.settings.qualityLow', 'LOW')
    : t('screens.settings.qualityMedium', 'MEDIUM');
  screens.toast('◐', t('main.autoQuality.title', 'Graphics adjusted'),
    t('main.autoQuality.sub', 'Lowered to {tier} to keep play smooth · change in Settings', { tier }));
}

/* -------------------------------------------------------------------------- */
/* Loop                                                                        */
/* -------------------------------------------------------------------------- */

let last = performance.now();
let fpsSmoothed = 60;
/** Title-screen backdrop runs a throwaway level so the menu isn't static. */
let bootDone = false;

function frame(now: number) {
  try {
    stepFrame(now);
  } catch (err) {
    showCrash(err);
    return; // Do not reschedule — the simulation state may be corrupted.
  }
  requestAnimationFrame(frame);
}

function stepFrame(now: number) {
  const realDt = (now - last) / 1000;
  const rawDt = Math.min(0.1, realDt);
  last = now;
  fpsSmoothed += (1 / Math.max(1e-4, rawDt) - fpsSmoothed) * 0.06;
  governQuality(realDt);

  updateOrientationGate();

  if (!touchMode) {
    keyboard.pollGamepad();
    // A gamepad has no cursor to aim with, so it rides the same auto-aim
    // path touch uses — but only while it's actually the device in the
    // player's hands, so picking the mouse back up restores manual aim.
    game.autoAim = game.progress.data.settings.autoAim || keyboard.gamepadActive;
    if (keyboard.gamepadStartPressed) togglePause();
  }

  const input = activeInput();
  hud.lastMouse.x = input.mouseX;
  hud.lastMouse.y = input.mouseY;

  const modal = screens.isModal;
  // `overHud` reads the last known cursor position, which is only meaningful for
  // a mouse — it tracks continuously even when nothing is pressed. Touch has no
  // such thing: `TouchInput.mouseX/Y` only move on an actual world tap, so they
  // sit at their (0, 0) default — inside the top info strip — until the first
  // one ever lands. Gating on `overHud` here would keep uiCaptured stuck true
  // from frame one, and since it also zeroes movement/dash in Game.update, that
  // reads as "touch controls don't work" — not just "one accidental tap ignored".
  // TouchInput already hit-tests its own buttons and stick zone before any of
  // this runs, so it doesn't need the overHud check at all.
  input.uiCaptured = modal || (!touchMode && state === 'playing' && overHud(input.mouseX, input.mouseY));
  hud.uiCaptured = input.uiCaptured;
  // The custom aim reticle stands in for the OS pointer over the game world
  // (see #stage's `cursor: none`); restore the real pointer over HUD chrome
  // so hovering the build bar reads as hovering a UI, not aiming through it.
  // Touch has its own `body.touch #stage` cursor rule and no mouse to move here.
  if (!touchMode) canvas.style.cursor = input.uiCaptured ? 'pointer' : 'none';
  if (modal && touchMode) touch.reset();

  handleTouch();

  if (runActive) {
    game.update(rawDt, input);
    renderer.render(game, game.progress.data.settings.bloom);
    if (state === 'playing' || state === 'paused') {
      const ctx = renderer.ctx;
      ctx.save();
      ctx.scale(renderer.dpr, renderer.dpr);
      hud.draw(ctx, game, renderer.width, renderer.height, fpsSmoothed);
      if (touchMode && state === 'playing') {
        touchHud.hintArea = hud.hintArea;
        touchHud.draw(ctx, game, touch, renderer.width, renderer.height);
        // After touchHud: tips point at its drawer/arrows, and read button
        // taps before endFrame clears them.
        coach.update(rawDt, game, touch, touchHud, renderer.width, renderer.height);
        coach.draw(ctx, game, touch, touchHud, renderer.width, renderer.height);
      }
      ctx.restore();
    }
  } else {
    // Idle backdrop: slow drifting starfield behind the title screens.
    drawIdleBackdrop(now / 1000);
  }

  // Surface achievement unlocks whenever they land.
  while (game.progress.pending.length) {
    const n = game.progress.pending.shift()!;
    screens.toast(n.def.icon, achievementName(n.def), achievementDesc(n.def));
    audio.play('achievement');
  }

  input.endFrame();
}

const idleStars: { x: number; y: number; z: number }[] = [];
for (let i = 0; i < 220; i++) {
  idleStars.push({ x: Math.random(), y: Math.random(), z: Math.random() });
}

function drawIdleBackdrop(t: number) {
  const ctx = renderer.ctx;
  const w = renderer.width, h = renderer.height;
  ctx.save();
  ctx.scale(renderer.dpr, renderer.dpr);

  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0a1020');
  g.addColorStop(1, '#02040a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'lighter';
  for (const s of idleStars) {
    const drift = (s.x + t * 0.006 * (0.3 + s.z)) % 1;
    const px = drift * w;
    const py = ((s.y + Math.sin(t * 0.1 + s.z * 9) * 0.01) % 1) * h;
    const a = 0.12 + s.z * 0.4;
    const r = 0.4 + s.z * 1.5;
    ctx.fillStyle = `rgba(150,210,255,${a})`;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Two lazy nebula blooms.
  for (let i = 0; i < 2; i++) {
    const cx = w * (0.3 + i * 0.45) + Math.sin(t * 0.07 + i) * 60;
    const cy = h * (0.4 + i * 0.2) + Math.cos(t * 0.05 + i) * 40;
    const rad = Math.min(w, h) * (0.4 + i * 0.15);
    const ng = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    ng.addColorStop(0, i ? 'rgba(180,124,255,0.07)' : 'rgba(70,216,255,0.08)');
    ng.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = ng;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

screens.showBoot();
requestAnimationFrame(frame);

// A short boot beat sells the "loading a big game" feel and lets fonts settle.
setTimeout(() => {
  if (bootDone) return;
  bootDone = true;
  applySettings();
  applyControlScheme();
  applyQuality();
  updateOrientationGate();
  screens.showTitle(game.progress, resumeInfo());
}, 900);

// Dev-only console handle: `swarm.game`, `swarm.renderer`, … for poking at a
// live run from devtools. Stripped from production builds by the DEV guard.
if (import.meta.env.DEV) {
  (window as unknown as { swarm: unknown }).swarm = {
    game, renderer, hud, touchHud, coach, screens, audio,
    keyboard, touch,
    get input() { return activeInput(); },
    get touchMode() { return touchMode; },
    setTouchMode(on: boolean) {
      game.progress.data.settings.controls = on ? 'touch' : 'desktop';
      applyControlScheme();
    },
    applyQuality, applyControlScheme,
  };
}

// Any first gesture unlocks the audio context.
const unlockOnce = () => {
  audio.unlock();
  applySettings();
  void tryFullscreen();
  removeEventListener('pointerdown', unlockOnce);
  removeEventListener('keydown', unlockOnce);
};
addEventListener('pointerdown', unlockOnce);
addEventListener('keydown', unlockOnce);
