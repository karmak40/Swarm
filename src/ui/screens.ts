import { audio } from '../core/audio';
import { type SkirmishConfig, type LevelDef } from '../data/levels';
import type { TechCard } from '../data/tech';
import { t as tr } from '../core/i18n';
import { el } from './dom';
import type { Progress } from '../game/progress';
import { showBoot, showTitle } from './panels/title';
import { showDaily } from './panels/daily';
import { showRecords } from './panels/records';
import { showCommander } from './panels/commander';
import { showModes, showProgress } from './panels/menus';
import { showLevelSelect, showEndlessSelect, showCustomBattle } from './panels/levels';
import { showArmoury } from './panels/armoury';
import { showAchievements, showSettings } from './panels/settings';
import { showEnemyIntro, showBestiary } from './panels/bestiary';
import { showTutorial } from './panels/tutorial';
import { showBriefing, showPause, showLoadout } from './panels/run';
import { showDraft } from './panels/draft';
import { showVictory, showDefeat } from './panels/results';

/**
 * DOM overlay layer.
 *
 * Anything modal — menus, the tech draft, results, the achievement gallery —
 * lives here rather than in canvas, because it needs scrolling, focus and text
 * reflow. The canvas HUD covers everything that must feel part of the world.
 */

type ScreenName =
  | 'boot' | 'title' | 'levelSelect' | 'achievements' | 'settings'
  | 'briefing' | 'pause' | 'draft' | 'victory' | 'defeat' | 'campaignEnd' | 'armoury'
  | 'endlessSelect' | 'customBattle' | 'loadout' | 'tutorial' | 'enemyIntro' | 'bestiary'
  | 'daily' | 'records' | 'commander' | 'modes' | 'progressHub' | null;

/** Minimal shape the title screen needs to advertise a resumable run. */
export interface ResumeInfo {
  levelName: string;
  wave: number;
  endless: boolean;
}

export interface ScreenCallbacks {
  onStartLevel: (index: number, fresh: boolean) => void;
  onStartEndless: (index: number, mutators: string[]) => void;
  onStartDaily: () => void;
  onStartSkirmish: (level: LevelDef) => void;
  onResumeRun: () => void;
  onSaveAndQuit: () => void;
  onResume: () => void;
  onRestart: () => void;
  onQuitToTitle: () => void;
  onPickTech: (card: TechCard) => void;
  onNextLevel: () => void;
  onSettingChange: () => void;
}




/** Parameters of a panel function after its leading Screens argument. */
type Rest<F> = F extends (ui: Screens, ...a: infer A) => unknown ? A : never;

export class Screens {
  layer: HTMLElement;
  private toasts: HTMLElement;
  cb: ScreenCallbacks;
  current: ScreenName = null;
  /** Remembered across visits to the Custom Battle screen so it doesn't reset every time. */
  lastSkirmish: SkirmishConfig = { size: 'medium', biome: 'ash', difficultyTier: 1, gates: 3 };

  constructor(root: HTMLElement, cb: ScreenCallbacks) {
    this.cb = cb;

    this.layer = el('div');
    this.layer.style.position = 'absolute';
    this.layer.style.inset = '0';
    this.layer.style.pointerEvents = 'none';
    root.appendChild(this.layer);

    this.toasts = el('div');
    this.toasts.id = 'toasts';
    root.appendChild(this.toasts);
  }

  get isModal() {
    return this.current !== null && this.current !== 'boot';
  }

  private clear() {
    this.layer.innerHTML = '';
    this.layer.style.pointerEvents = 'none';
    this.backAction = null;
  }

  /**
   * What the open screen's own Back/Close button does, so Escape and the
   * Android back button can do exactly the same. Null for screens with no
   * way back (briefing, tech draft, results, the pause menu itself).
   */
  private backAction: (() => void) | null = null;

  open(name: ScreenName, node: HTMLElement, back?: () => void) {
    this.clear();
    this.current = name;
    this.layer.style.pointerEvents = 'auto';
    this.layer.appendChild(node);
    this.backAction = back ?? null;
  }

  /** Runs the open screen's Back action. Returns false if it has none. */
  goBack(): boolean {
    const back = this.backAction;
    if (!back) return false;
    audio.play('uiBack');
    back();
    return true;
  }

  close() {
    this.clear();
    this.current = null;
  }

  /**
   * In-game yes/no prompt, layered over the current screen.
   *
   * Replaces `window.confirm`, which Android WebViews, fullscreen mobile
   * browsers and Electron can suppress or auto-answer "no" — the button then
   * silently does nothing.
   */
  confirmDialog(message: string, onYes: () => void, yesLabel?: string) {
    const overlay = el('div', 'confirm-overlay');
    const box = el('div', 'confirm-box');
    box.appendChild(el('p', undefined, message));
    const row = el('div', 'row');
    row.appendChild(this.button(tr('screens.confirm.cancel', 'Cancel'), () => overlay.remove(), 'btn ghost'));
    row.appendChild(this.button(yesLabel ?? tr('screens.confirm.yes', 'Confirm'), () => {
      overlay.remove();
      onYes();
    }, 'btn danger'));
    box.appendChild(row);
    overlay.appendChild(box);
    // A tap outside the box backs out, same as Cancel.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    this.layer.appendChild(overlay);
  }

  /**
   * Closes an open confirmDialog as if Cancel was pressed. Returns whether
   * there was one — hardware back / Escape back out of it before anything else.
   */
  dismissConfirm(): boolean {
    const overlay = this.layer.querySelector('.confirm-overlay');
    if (!overlay) return false;
    overlay.remove();
    audio.play('uiBack');
    return true;
  }

  button(label: string, onClick: () => void, cls = 'btn') {
    const b = el('button', cls, label);
    b.addEventListener('click', () => { audio.unlock(); audio.play('uiClick'); onClick(); });
    b.addEventListener('pointerenter', () => audio.play('uiHover'));
    return b;
  }

  /** A labelled row that cycles through a fixed set of options on click. */
  cycle<T extends string>(
    label: string, value: T, options: readonly T[], labels: Record<T, string>,
    onChange: (v: T) => void,
  ) {
    const row = el('div', 'row');
    row.style.justifyContent = 'space-between';
    row.appendChild(el('div', 'label', label));
    const b = el('button', 'btn ghost', labels[value]);
    b.style.padding = '6px 18px';
    b.style.minWidth = '120px';
    b.addEventListener('click', () => {
      const i = (options.indexOf(value) + 1) % options.length;
      value = options[i];
      b.textContent = labels[value];
      onChange(value);
      audio.play('uiClick');
    });
    row.appendChild(b);
    return row;
  }

  /** A labelled row with -/+ buttons stepping an integer through [min, max]. */
  stepper(label: string, value: number, min: number, max: number, onChange: (v: number) => void) {
    const row = el('div', 'row');
    row.style.justifyContent = 'space-between';
    row.appendChild(el('div', 'label', label));
    const controls = el('div', 'row');
    controls.style.gap = '10px';
    controls.style.alignItems = 'center';
    const out = el('div', 'label', String(value));
    out.style.color = 'var(--accent)';
    out.style.minWidth = '2ch';
    out.style.textAlign = 'center';
    const step = (delta: number) => {
      const v = Math.max(min, Math.min(max, value + delta));
      if (v === value) return;
      value = v;
      out.textContent = String(value);
      minus.disabled = value <= min;
      plus.disabled = value >= max;
      onChange(value);
      audio.play('uiClick');
    };
    const minus = this.button('−', () => step(-1), 'btn ghost');
    const plus = this.button('+', () => step(1), 'btn ghost');
    minus.style.padding = plus.style.padding = '4px 14px';
    minus.disabled = value <= min;
    plus.disabled = value >= max;
    controls.appendChild(minus);
    controls.appendChild(out);
    controls.appendChild(plus);
    row.appendChild(controls);
    return row;
  }

  /* Screens live in ./panels; these forward with the Screens instance as context. */

  showDaily(...a: Rest<typeof showDaily>) { showDaily(this, ...a); }
  showRecords(...a: Rest<typeof showRecords>) { showRecords(this, ...a); }
  showCommander(...a: Rest<typeof showCommander>) { showCommander(this, ...a); }
  showModes(...a: Rest<typeof showModes>) { showModes(this, ...a); }
  showProgress(...a: Rest<typeof showProgress>) { showProgress(this, ...a); }

  showBoot(...a: Rest<typeof showBoot>) { showBoot(this, ...a); }
  /** The resume offer from the last title screen, so returning from a sub-screen keeps it. */
  private resumeOffer: ResumeInfo | null = null;

  showTitle(progress: Progress, resumable?: ResumeInfo | null) {
    if (resumable !== undefined) this.resumeOffer = resumable;
    showTitle(this, progress, this.resumeOffer);
  }
  showLevelSelect(...a: Rest<typeof showLevelSelect>) { showLevelSelect(this, ...a); }
  showEndlessSelect(...a: Rest<typeof showEndlessSelect>) { showEndlessSelect(this, ...a); }
  showCustomBattle(...a: Rest<typeof showCustomBattle>) { showCustomBattle(this, ...a); }
  showArmoury(...a: Rest<typeof showArmoury>) { showArmoury(this, ...a); }
  showAchievements(...a: Rest<typeof showAchievements>) { showAchievements(this, ...a); }
  showSettings(...a: Rest<typeof showSettings>) { showSettings(this, ...a); }
  showEnemyIntro(...a: Rest<typeof showEnemyIntro>) { showEnemyIntro(this, ...a); }
  showBestiary(...a: Rest<typeof showBestiary>) { showBestiary(this, ...a); }
  showTutorial(...a: Rest<typeof showTutorial>) { showTutorial(this, ...a); }
  showBriefing(...a: Rest<typeof showBriefing>) { showBriefing(this, ...a); }
  showPause(...a: Rest<typeof showPause>) { showPause(this, ...a); }
  showLoadout(...a: Rest<typeof showLoadout>) { showLoadout(this, ...a); }
  showDraft(...a: Rest<typeof showDraft>) { showDraft(this, ...a); }
  showVictory(...a: Rest<typeof showVictory>) { showVictory(this, ...a); }
  showDefeat(...a: Rest<typeof showDefeat>) { showDefeat(this, ...a); }

  /* ====================================================================== */
  /* Toasts                                                                  */
  /* ====================================================================== */

  toast(icon: string, title: string, sub: string) {
    const t = el('div', 'toast');
    t.appendChild(el('div', 'icon', icon));
    const body = el('div');
    body.appendChild(el('div', 't', title));
    body.appendChild(el('div', 's', sub));
    t.appendChild(body);
    this.toasts.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 450);
    }, 4200);
    // Cap the stack so a burst of unlocks doesn't fill the screen.
    while (this.toasts.children.length > 5) this.toasts.firstElementChild?.remove();
  }
}
