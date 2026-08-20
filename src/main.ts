import './style.css';
import { audio } from './core/audio';
import { Input } from './core/input';
import { saveNow, clearRun } from './core/save';
import { BUILDINGS } from './data/buildings';
import { LEVELS } from './data/levels';
import { achievementName, achievementDesc } from './data/achievements';
import { levelName } from './data/levels';
import type { TechCard } from './data/tech';
import { Game } from './game/game';
import { Hud } from './render/hud';
import { Renderer } from './render/renderer';
import { Screens, type ResumeInfo } from './ui/screens';
import { TouchInput } from './core/touch';
import { TouchHud } from './render/touchHud';
import { detectCoarsePointer, detectQuality, isPortrait, type Quality } from './core/platform';
import { detectLocale, setLocale, getLocale, t } from './core/i18n';

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
  // Touch has no cursor to aim with and no second button to mine with, so both
  // assists are mandatory there; on desktop they are opt-in.
  game.autoAim = touchMode || st.autoAim;
  game.autoMine = touchMode || st.autoMine;
  touch.setHaptics(st.haptics);
  touch.layout(renderer.width, renderer.height, { southpaw: st.southpaw, scale: st.uiScale, insets: renderer.insets });
  if (!touchMode) touch.reset();
}

function applyQuality() {
  const pref = game.progress.data.settings.quality;
  const q: Quality = pref === 'auto' ? detectQuality() : pref;
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
  onResumeRun: () => resumeRun(),
  onSaveAndQuit: () => saveAndQuit(),
  onResume: () => { state = 'playing'; game.frozen = false; },
  onRestart: () => beginLevel(game.levelIndex, true, game.mode),
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
  if (rotateMsg) rotateMsg.textContent = t('main.rotate.msg', 'Rotate your device');
  if (rotateSub) rotateSub.textContent = t('main.rotate.sub', 'SWARM is played in landscape');
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

function beginLevel(index: number, fresh: boolean, mode: 'campaign' | 'endless' = 'campaign') {
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
  if (touchMode) {
    // On touch, TouchInput hit-tests its own widgets before the world ever sees
    // the event, so only the information strip needs excluding here.
    return y < 92 * game.progress.data.settings.uiScale;
  }
  if (y < 116) return true;                       // top bar + wave tracker
  if (y > h - 112) return true;                   // build bar + legend
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

  for (const slot of hud.buildSlots) {
    if (mx >= slot.x && mx <= slot.x + slot.w && my >= slot.y && my <= slot.y + slot.h) {
      const def = BUILDINGS[slot.kind];
      if (game.buildKind === slot.kind) {
        game.buildKind = null;
        game.cursorMode = 'normal';
        audio.play('uiBack');
      } else {
        game.buildKind = slot.kind;
        game.cursorMode = 'build';
        audio.play('uiClick');
      }
      void def;
      return;
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Global keys                                                                 */
/* -------------------------------------------------------------------------- */

addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (state === 'playing') {
      state = 'paused';
      game.frozen = true;
      audio.play('uiBack');
      screens.showPause(game.progress, game.inBuildPhase);
    } else if (state === 'paused') {
      screens.close();
      state = 'playing';
      game.frozen = false;
    }
  }
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

/** Consumes this frame's touch events and turns them into game actions. */
function handleTouch() {
  if (!touchMode || state !== 'playing') return;
  const st = game.progress.data.settings;

  touch.drawerOpen = touch.drawerOpen && !screens.isModal;
  touch.placing = game.cursorMode === 'build' && game.buildKind !== null;
  touchHud.lastWidth = renderer.width;

  // The drawer covers the bottom of the screen, so the action cluster steps
  // aside; leaving it tappable underneath is how you dash instead of building.
  const drawer = touch.drawerOpen;
  touch.setVisible('dash', !drawer);
  touch.setVisible('build', !drawer);
  // The "start wave" button only exists while a build window is open.
  touch.setVisible('startWave', !drawer && game.inBuildPhase && game.prepRemaining > 2);

  for (const b of touch.buttons) {
    if (!b.tapped) continue;
    switch (b.id) {
      case 'pause':
        state = 'paused';
        game.frozen = true;
        touch.reset();
        audio.play('uiBack');
        screens.showPause(game.progress, game.inBuildPhase);
        break;
      case 'build':
        touch.drawerOpen = true;
        // Opening the drawer cancels any pending placement, so the two modes
        // cannot both be live at once.
        game.buildKind = null;
        game.cursorMode = 'normal';
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
        break;                        // read directly via input.pressed
    }
  }

  // Long press on a structure opens the context menu.
  const lp = touch.consumeLongPress();
  if (lp && !touch.drawerOpen) {
    if (game.hoverBuilding) touchHud.openMenu(lp.x, lp.y, game.hoverBuilding);
    else touchHud.closeMenu();
  }

  // Taps: menu first, then drawer, then the world.
  const tap = touch.mapTap;
  if (tap) {
    if (touchHud.menu) {
      const hit = touchHud.hitMenu(tap.x, tap.y);
      if (hit) {
        const b = game.hoverBuilding;
        if (hit === 'sell' && b) game.sellBuilding(b);
        else if (hit === 'repair' && b) game.repairBuildingBurst(b);
        else if (hit === 'target' && b) game.cycleTargeting(b);
        if (hit !== 'repair') touchHud.closeMenu();
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
        if (game.buildKind) touch.drawerOpen = false;
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
 * Shows the rotate prompt in portrait.
 *
 * Also polled from the render loop rather than trusting `resize` alone: some
 * browsers report stale dimensions during a rotation, and a stuck gate makes the
 * game look broken. The check is two number comparisons, so polling is free.
 */
function updateOrientationGate() {
  const block = touchMode && isPortrait();
  if (block === gateBlocked) return;
  gateBlocked = block;
  document.body.classList.toggle('portrait-block', block);
  if (block && state === 'playing') {
    state = 'paused';
    game.frozen = true;
    touch.reset();
  }
}

/** Fullscreen has to be requested from a gesture; the first tap is the moment. */
async function tryFullscreen() {
  if (!touchMode) return;
  if (document.fullscreenElement) return;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    const o = (screen as unknown as { orientation?: { lock?: (m: string) => Promise<void> } }).orientation;
    await o?.lock?.('landscape');
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
  const rawDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsSmoothed += (1 / Math.max(1e-4, rawDt) - fpsSmoothed) * 0.06;

  updateOrientationGate();

  const input = activeInput();
  hud.lastMouse.x = input.mouseX;
  hud.lastMouse.y = input.mouseY;

  const modal = screens.isModal;
  input.uiCaptured = modal || (state === 'playing' && overHud(input.mouseX, input.mouseY));
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
        touchHud.draw(ctx, game, touch, renderer.width, renderer.height);
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
    game, renderer, hud, touchHud, screens, audio,
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
