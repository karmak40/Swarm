import { audio } from '../core/audio';
import { fmtNum, fmtTime } from '../core/math';
import { ACHIEVEMENTS, TIER_COLOR, achievementName, achievementDesc } from '../data/achievements';
import { describePerk, type PerkDelta } from '../data/perks';
import {
  CATEGORY_ORDER, RELIC_UPGRADES, categoryLabel, categoryBlurb, relicUpgradeName, relicUpgradeDesc,
} from '../data/relicUpgrades';
import {
  LEVELS, levelName, levelSubtitle, levelBriefing,
  BIOME_IDS, biomeLabel, SKIRMISH_SIZES, skirmishSizeLabel, makeSkirmishLevel, ngDifficultyMult,
  type BiomeId, type SkirmishSize, type SkirmishConfig, type LevelDef,
} from '../data/levels';
import {
  WEAPON_KINDS, WEAPONS, weaponName, weaponDesc, ARMOR_TIERS, armorTierName,
} from '../data/loadout';
import { techName, techDesc, type TechCard } from '../data/tech';
import {
  SYNERGIES, SYNERGY_TAGS, synergyCounts, synergyName, synergyTitle, tierBonusText, tiersReached,
  type SynergyTag,
} from '../data/synergies';
import { css } from '../render/palette';
import { enemyPortrait } from '../render/portrait';
import { enemyCounter, enemyTraits } from '../data/bestiary';
import { ENEMIES, enemyDesc, enemyName, type EnemyDef } from '../data/enemies';
import type { Game } from '../game/game';
import type { Progress } from '../game/progress';
import { detectLocale, setLocale, LOCALES, type LocaleCode, t as tr } from '../core/i18n';

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
  | 'endlessSelect' | 'customBattle' | 'loadout' | 'tutorial' | 'enemyIntro' | 'bestiary' | null;

/** Minimal shape the title screen needs to advertise a resumable run. */
export interface ResumeInfo {
  levelName: string;
  wave: number;
  endless: boolean;
}

export interface ScreenCallbacks {
  onStartLevel: (index: number, fresh: boolean) => void;
  onStartEndless: (index: number) => void;
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

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

/**
 * Compounds a per-rank perk delta `rank` times so the UI can state what the
 * player actually owns, not just what one rank is worth.
 */
function scalePerk(delta: PerkDelta, rank: number): PerkDelta {
  const out: PerkDelta = {};
  for (const k of Object.keys(delta) as (keyof PerkDelta)[]) {
    const v = delta[k]!;
    // Multiplicative perks sit around 1; additive ones are raw amounts.
    out[k] = ADDITIVE_LOOKING(v) ? v * rank : Math.pow(v, rank);
  }
  return out;
}

/** Values near 1 are multipliers; anything else is a flat amount. */
const ADDITIVE_LOOKING = (v: number) => v === 0 || v > 1.9 || v < 0.5;

export class Screens {
  private layer: HTMLElement;
  private toasts: HTMLElement;
  private cb: ScreenCallbacks;
  current: ScreenName = null;
  /** Remembered across visits to the Custom Battle screen so it doesn't reset every time. */
  private lastSkirmish: SkirmishConfig = { size: 'medium', biome: 'ash', difficultyTier: 1, gates: 3 };

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

  private open(name: ScreenName, node: HTMLElement, back?: () => void) {
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
  private confirmDialog(message: string, onYes: () => void, yesLabel?: string) {
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

  private button(label: string, onClick: () => void, cls = 'btn') {
    const b = el('button', cls, label);
    b.addEventListener('click', () => { audio.unlock(); audio.play('uiClick'); onClick(); });
    b.addEventListener('pointerenter', () => audio.play('uiHover'));
    return b;
  }

  /** A labelled row that cycles through a fixed set of options on click. */
  private cycle<T extends string>(
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
  private stepper(label: string, value: number, min: number, max: number, onChange: (v: number) => void) {
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

  /* ====================================================================== */
  /* Boot                                                                    */
  /* ====================================================================== */

  showBoot() {
    const s = el('div', 'screen opaque');
    s.id = 'boot';
    s.appendChild(el('div', 'title', tr('screens.boot.title', 'SWARM')));
    s.appendChild(el('div', 'subtitle', tr('screens.boot.subtitle', 'hold the line')));
    const bar = el('div', 'bar');
    bar.appendChild(el('i'));
    s.appendChild(bar);
    s.appendChild(el('div', 'label', tr('screens.boot.compiling', 'compiling procedural systems')));
    this.open('boot', s);
  }

  /* ====================================================================== */
  /* Title                                                                   */
  /* ====================================================================== */

  showTitle(progress: Progress, resumable?: ResumeInfo | null) {
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack title-stack');

    stack.appendChild(el('h1', 'title', tr('screens.title.title', 'SWARM')));
    stack.appendChild(el('p', 'subtitle', tr('screens.title.subtitle', 'hold the line')));
    // The pitch blurb is onboarding copy the player has already read, so it is
    // the one thing still dropped on short landscape phones. Progress pips and
    // the lifetime-stats grid move beside the menu instead — see `.title-stack`
    // in style.css — rather than leaving that width empty.
    stack.appendChild(el('p', 'flavor pitch',
      tr('screens.title.pitch',
        'One reactor core against an endless hive. Mine the seams, wall the approaches, and render the ' +
        'swarm down into something you can spend. Every wave is a countdown to the one that ends the sector.')));

    // Campaign progress readout, so a returning player can see at a glance that
    // their clears were saved and where they left off.
    const cleared = progress.sectorsCleared;
    const total = LEVELS.length;
    const done = cleared >= total;
    if (cleared > 0) {
      const prog = el('div', 'campaign-progress');
      prog.style.display = 'flex';
      prog.style.flexDirection = 'column';
      prog.style.alignItems = 'center';
      prog.style.gap = '10px';

      const line = el('div', 'label', done
        ? tr('screens.title.campaignComplete', 'campaign complete · all sectors cleared')
        : tr('screens.title.campaignProgress',
          `campaign progress · ${cleared} sector${cleared === 1 ? '' : 's'} cleared`, { cleared }));
      line.style.color = done ? 'var(--relic)' : 'var(--good)';
      prog.appendChild(line);

      // One pip per sector: filled = cleared, ringed = next up, dim = locked.
      const pips = el('div', 'row');
      pips.style.gap = '7px';
      // Only up to the sector they can reach — the chain grows as they advance
      // rather than announcing how much content exists.
      const shown = Math.min(LEVELS.length, cleared + 1);
      LEVELS.slice(0, shown).forEach((lv, i) => {
        const pip = el('div');
        pip.style.width = '26px';
        pip.style.height = '5px';
        pip.style.background = i < cleared ? 'var(--good)' : 'var(--accent)';
        pip.style.boxShadow = i === cleared ? '0 0 10px var(--accent)' : 'none';
        pip.title = tr('screens.title.sectorPip', '{index}. {name}', { index: i + 1, name: levelName(lv) });
        pips.appendChild(pip);
      });
      prog.appendChild(pips);
      stack.appendChild(prog);
    }

    const col = el('div', 'menu-col');

    if (resumable) {
      const label = resumable.endless
        ? tr('screens.title.resumeEndless', 'Resume endless · wave {wave}', { wave: resumable.wave })
        : tr('screens.title.resumeRun', 'Resume · {level}, wave {wave}',
          { level: resumable.levelName, wave: resumable.wave });
      const b = this.button(label, () => this.cb.onResumeRun());
      b.style.borderColor = 'rgba(92,242,160,0.55)';
      col.appendChild(b);
    }

    if (cleared > 0) {
      const next = Math.min(total - 1, progress.furthestUnlockedLevel);
      const nextName = levelName(LEVELS[next]);
      col.appendChild(this.button(
        done
          ? tr('screens.title.replay', 'Replay · {index}. {name}', { index: next + 1, name: nextName })
          : tr('screens.title.continue', 'Continue · {index}. {name}', { index: next + 1, name: nextName }),
        () => this.cb.onStartLevel(next, true),
      ));
      col.appendChild(this.button(tr('screens.title.sectorSelect', 'Sector select'), () => this.showLevelSelect(progress), 'btn ghost'));
    } else {
      col.appendChild(this.button(tr('screens.title.newCampaign', 'New campaign'), () => this.cb.onStartLevel(0, true)));
    }
    if (cleared > 0) {
      const best = progress.endlessBestOverall;
      col.appendChild(this.button(
        best > 0
          ? tr('screens.title.endlessBest', 'Endless · best wave {best}', { best })
          : tr('screens.title.endlessMode', 'Endless mode'),
        () => this.showEndlessSelect(progress), 'btn ghost',
      ));
      col.appendChild(this.button(
        tr('screens.title.customBattle', 'Custom battle'),
        () => this.showCustomBattle(progress), 'btn ghost',
      ));
    }
    col.appendChild(this.button(
      tr('screens.title.armoury', 'Armoury · {relics} ⬢', { relics: progress.relics }),
      () => this.showArmoury(progress), progress.relics > 0 ? 'btn' : 'btn ghost',
    ));
    col.appendChild(this.button(
      tr('screens.title.achievements', 'Achievements · {unlocked}/{total}',
        { unlocked: progress.unlockedCount, total: progress.totalCount }),
      () => this.showAchievements(progress), 'btn ghost',
    ));
    col.appendChild(this.button(
      tr('screens.title.bestiary', 'Bestiary · {n}/{total}', {
        n: progress.data.seenEnemies.length, total: Object.keys(ENEMIES).length,
      }),
      () => this.showBestiary(progress), 'btn ghost',
    ));
    col.appendChild(this.button(tr('screens.title.settings', 'Settings'), () => this.showSettings(progress), 'btn ghost'));
    stack.appendChild(col);

    // Lifetime stats strip.
    const st = progress.data.stats;
    const grid = el('div', 'stat-grid title-stats');
    const cells: [string, string][] = [
      [tr('screens.title.stats.runs', 'Runs'), fmtNum(st.runs)],
      [tr('screens.title.stats.sectorsCleared', 'Sectors cleared'), fmtNum(st.victories)],
      [tr('screens.title.stats.totalKills', 'Total kills'), fmtNum(st.kills)],
      [tr('screens.title.stats.bossesFelled', 'Bosses felled'), fmtNum(st.bossKills)],
      [tr('screens.title.stats.oreMined', 'Ore mined'), fmtNum(st.oreMined)],
      [tr('screens.title.stats.bestWave', 'Best wave'), fmtNum(st.bestWave)],
    ];
    for (const [k, v] of cells) {
      const c = el('div', 'cell');
      c.appendChild(el('div', 'label', k));
      c.appendChild(el('div', 'v accent', v));
      grid.appendChild(c);
    }
    stack.appendChild(grid);

    s.appendChild(stack);
    s.appendChild(el('div', 'hint-bar',
      tr('screens.title.hintBar', 'WASD move · LMB fire · RMB mine · number keys build · SHIFT dash · G loadout · TAB stats · ESC pause')));
    this.open('title', s);
  }

  /* ====================================================================== */
  /* Sector select                                                           */
  /* ====================================================================== */

  showLevelSelect(progress: Progress) {
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack');
    stack.appendChild(el('h2', undefined, tr('screens.levelSelect.heading', 'Sector Select')));
    stack.appendChild(el('p', 'flavor',
      tr('screens.levelSelect.intro',
        `${progress.sectorsCleared} sector${progress.sectorsCleared === 1 ? '' : 's'} cleared. ` +
        'Clearing a sector permanently unlocks the next one, so you can pick up from there any time. ' +
        'The map is rolled fresh every deployment — starting a sector again is never the same fight.',
        { cleared: progress.sectorsCleared })));

    // New Game+: unlocked once the campaign has been cleared at least once, so
    // nobody sees a harder-than-expected sector before they know what "base"
    // difficulty even feels like.
    if (progress.data.highestLevel >= LEVELS.length - 1) {
      const st = progress.data.settings;
      const ngPanel = el('div', 'panel clip-corner');
      ngPanel.style.padding = '14px 20px';
      ngPanel.style.marginBottom = '18px';
      const mult = ngDifficultyMult(st.ngTier);
      ngPanel.appendChild(this.stepper(
        tr('screens.levelSelect.ngTier', 'New Game+ tier — x{mult} enemies', { mult: mult.toFixed(2) }),
        st.ngTier, 1, 10,
        (v) => { st.ngTier = v; this.cb.onSettingChange(); this.showLevelSelect(progress); },
      ));
      stack.appendChild(ngPanel);
    }

    const row = el('div', 'card-row');
    LEVELS.forEach((lv, i) => {
      const locked = !progress.canPlayLevel(i);
      const card = el('div', 'tech-card');
      if (locked) card.style.opacity = '0.4';
      card.style.borderColor = `rgba(120,190,255,${locked ? 0.1 : 0.35})`;

      card.appendChild(el('div', 'rarity r-rare', levelSubtitle(lv)));
      card.appendChild(el('h3', undefined,
        tr('screens.levelSelect.cardTitle', '{index}. {name}', { index: i + 1, name: levelName(lv) })));
      const meta = el('p');
      meta.innerHTML = locked
        ? `<em>${tr('screens.levelSelect.lockedMeta', 'Locked — clear the previous sector.')}</em>`
        : tr('screens.levelSelect.meta', '{waves} waves · boss: <strong>{boss}</strong><br><br>{briefing}',
          { waves: lv.waves, boss: lv.boss.toUpperCase(), briefing: levelBriefing(lv) });
      card.appendChild(meta);

      const badge = el('div', 'rarity');
      if (i <= progress.data.highestLevel) {
        badge.textContent = tr('screens.levelSelect.cleared', '✔ CLEARED');
        badge.style.color = 'var(--good)';
      } else if (!locked) {
        badge.textContent = i === 0
          ? tr('screens.levelSelect.startHere', 'START HERE')
          : tr('screens.levelSelect.unlockedContinue', '▶ UNLOCKED — CONTINUE HERE');
        badge.style.color = 'var(--accent)';
      } else {
        badge.textContent = tr('screens.levelSelect.lockedBadge', '🔒 LOCKED');
      }
      card.appendChild(badge);

      if (!locked) {
        card.addEventListener('click', () => { audio.play('uiClick'); this.cb.onStartLevel(i, true); });
        card.addEventListener('pointerenter', () => audio.play('uiHover'));
      } else {
        card.style.cursor = 'not-allowed';
      }
      row.appendChild(card);
    });
    stack.appendChild(row);
    stack.appendChild(this.button(tr('screens.levelSelect.back', 'Back'), () => this.showTitle(progress), 'btn ghost'));
    s.appendChild(stack);
    this.open('levelSelect', s, () => this.showTitle(progress));
  }

  /* ====================================================================== */
  /* Armoury — permanent relic upgrades                                      */
  /* ====================================================================== */

  showArmoury(progress: Progress) {
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack');
    stack.appendChild(el('h2', undefined, tr('screens.armoury.heading', 'Armoury')));
    stack.appendChild(el('p', 'flavor',
      tr('screens.armoury.intro',
        'Relics come from clearing sectors, felling bosses and earning achievements. ' +
        'Everything bought here is permanent and applies to every run from now on.')));

    // Relic wallet.
    const bar = el('div', 'relic-bar');
    const amount = el('div', 'amount', tr('screens.armoury.relicAmount', '{relics} ⬢', { relics: progress.relics }));
    bar.appendChild(amount);
    const sub = el('div', 'sub');
    const refreshWallet = () => {
      amount.textContent = tr('screens.armoury.relicAmount', '{relics} ⬢', { relics: progress.relics });
      sub.innerHTML = tr('screens.armoury.walletSub', 'RELICS AVAILABLE<br>{spent} invested · {earned} earned all-time',
        { spent: progress.spentRelics, earned: progress.data.relicsEarned });
    };
    bar.appendChild(sub);
    stack.appendChild(bar);

    const wrap = el('div', 'shop-wrap');
    // Re-render in place so ranks, costs and affordability all stay truthful
    // after every purchase without rebuilding the whole screen.
    const rows: (() => void)[] = [];

    for (const cat of CATEGORY_ORDER) {
      const items = RELIC_UPGRADES.filter((u) => u.category === cat);
      if (!items.length) continue;

      const section = el('div', 'shop-cat');
      section.appendChild(el('h4', undefined, categoryLabel(cat)));
      section.appendChild(el('div', 'blurb', categoryBlurb(cat)));
      const grid = el('div', 'shop-grid');

      for (const u of items) {
        const card = el('div', 'up');
        card.appendChild(el('div', 'icon', u.icon));

        const body = el('div', 'body');
        body.appendChild(el('div', 'name', relicUpgradeName(u)));
        body.appendChild(el('div', 'desc', relicUpgradeDesc(u)));
        const effect = el('div', 'effect');
        body.appendChild(effect);
        const pips = el('div', 'pips');
        body.appendChild(pips);
        card.appendChild(body);

        const buy = el('button', 'buy');
        card.appendChild(buy);

        const refresh = () => {
          const rank = progress.rankOf(u.id);
          const cost = progress.nextCost(u);
          const maxed = cost === null;

          card.className = `up${maxed ? ' maxed' : progress.canBuy(u) ? ' affordable' : ''}`;
          // Show the cumulative total owned, and the cumulative total after the
          // next rank — quoting the per-rank delta again reads as a duplicate.
          const owned = describePerk(scalePerk(u.perRank, rank));
          effect.textContent = maxed
            ? tr('screens.armoury.effectMaxed', 'MAXED — {owned}', { owned })
            : rank > 0
              ? tr('screens.armoury.effectUpgrade', '{owned}   →   {next}',
                { owned, next: describePerk(scalePerk(u.perRank, rank + 1)) })
              : tr('screens.armoury.effectPerRank', 'Per rank: {perk}', { perk: describePerk(u.perRank) });

          pips.innerHTML = '';
          for (let i = 0; i < u.maxRank; i++) {
            const pip = el('i');
            if (i < rank) pip.className = 'on';
            pips.appendChild(pip);
          }

          if (maxed) {
            buy.className = 'buy done';
            buy.textContent = tr('screens.armoury.maxButton', '✔ MAX');
            buy.disabled = true;
          } else {
            buy.className = 'buy';
            buy.textContent = tr('screens.armoury.costButton', '{cost} ⬢', { cost });
            buy.disabled = !progress.canBuy(u);
          }
        };
        rows.push(refresh);

        buy.addEventListener('click', () => {
          if (!progress.buyUpgrade(u.id)) { audio.play('error'); return; }
          audio.play('levelUp');
          refreshWallet();
          for (const r of rows) r();
        });
        buy.addEventListener('pointerenter', () => audio.play('uiHover'));

        grid.appendChild(card);
      }
      section.appendChild(grid);
      wrap.appendChild(section);
    }

    refreshWallet();
    for (const r of rows) r();
    stack.appendChild(wrap);

    const btnRow = el('div', 'row');
    btnRow.appendChild(this.button(tr('screens.armoury.back', 'Back'), () => this.showTitle(progress), 'btn ghost'));
    btnRow.appendChild(this.button(tr('screens.armoury.refundAll', 'Refund all'), () => {
      if (progress.spentRelics <= 0) { audio.play('error'); return; }
      this.confirmDialog(tr('screens.armoury.refundConfirm', 'Refund every upgrade and get {relics} relics back?',
        { relics: progress.spentRelics }), () => {
        progress.respec();
        audio.play('sell');
        this.showArmoury(progress);
      }, tr('screens.armoury.refundAll', 'Refund all'));
    }, 'btn ghost'));
    stack.appendChild(btnRow);

    s.appendChild(stack);
    this.open('armoury', s, () => this.showTitle(progress));
  }

  /* ====================================================================== */
  /* Endless                                                                 */
  /* ====================================================================== */

  showEndlessSelect(progress: Progress) {
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack');
    stack.appendChild(el('p', 'subtitle', tr('screens.endlessSelect.subtitle', 'no last wave')));
    stack.appendChild(el('h2', undefined, tr('screens.endlessSelect.heading', 'Endless')));
    stack.appendChild(el('p', 'flavor',
      tr('screens.endlessSelect.intro',
        'The hive never stops. Waves escalate forever and a boss arrives every tenth one. ' +
        'There is no victory here — only how far you get, and the relics you bring back.')));

    const row = el('div', 'card-row');
    LEVELS.forEach((lv, i) => {
      if (!progress.canPlayLevel(i)) return;
      const best = progress.endlessBest(i);
      const card = el('div', 'tech-card');
      card.appendChild(el('div', 'rarity r-rare', levelSubtitle(lv)));
      card.appendChild(el('h3', undefined,
        tr('screens.endlessSelect.cardTitle', '{index}. {name}', { index: i + 1, name: levelName(lv) })));
      const meta = el('p');
      meta.innerHTML = tr('screens.endlessSelect.meta',
        '{gates} hive gates · {types} enemy types<br><br>Difficulty multiplier <strong>x{difficulty}</strong>',
        { gates: lv.spawnPoints, types: lv.roster.length, difficulty: lv.difficulty.toFixed(2) });
      card.appendChild(meta);
      const badge = el('div', 'rarity');
      badge.textContent = best > 0
        ? tr('screens.endlessSelect.best', 'BEST: WAVE {wave}', { wave: best })
        : tr('screens.endlessSelect.noRecord', 'NO RECORD YET');
      badge.style.color = best > 0 ? 'var(--relic)' : 'var(--ink-faint)';
      card.appendChild(badge);
      card.addEventListener('pointerenter', () => audio.play('uiHover'));
      card.addEventListener('click', () => { audio.play('uiClick'); this.cb.onStartEndless(i); });
      row.appendChild(card);
    });
    stack.appendChild(row);
    stack.appendChild(this.button(tr('screens.endlessSelect.back', 'Back'), () => this.showTitle(progress), 'btn ghost'));
    s.appendChild(stack);
    this.open('endlessSelect', s, () => this.showTitle(progress));
  }

  /* ====================================================================== */
  /* Custom battle (skirmish)                                                */
  /* ====================================================================== */

  showCustomBattle(progress: Progress) {
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack');
    stack.appendChild(el('p', 'subtitle', tr('screens.customBattle.subtitle', 'your rules')));
    stack.appendChild(el('h2', undefined, tr('screens.customBattle.heading', 'Custom Battle')));
    stack.appendChild(el('p', 'flavor',
      tr('screens.customBattle.intro',
        'Configure a one-off map — size, biome, difficulty, hive gates — and deploy with everything already ' +
        'unlocked. Nothing here touches campaign progress; it is a fight for its own sake.')));

    const cfg = this.lastSkirmish;
    // Difficulty's label quotes the live multiplier, so any change re-renders
    // the whole screen rather than patching one control in place — simplest,
    // and matches how the language cycle and NG+ stepper already do this.
    const rerender = () => this.showCustomBattle(progress);

    const panel = el('div', 'panel clip-corner');
    panel.style.padding = '20px 26px';
    panel.style.width = 'min(480px, 90vw)';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.gap = '14px';

    const sizeLabels = Object.fromEntries(
      SKIRMISH_SIZES.map((sz): [SkirmishSize, string] => [sz, skirmishSizeLabel(sz).toUpperCase()]),
    ) as Record<SkirmishSize, string>;
    panel.appendChild(this.cycle(
      tr('screens.customBattle.size', 'Map size'), cfg.size, SKIRMISH_SIZES, sizeLabels,
      (v) => { cfg.size = v; },
    ));

    const biomeLabels = Object.fromEntries(
      BIOME_IDS.map((b): [BiomeId, string] => [b, biomeLabel(b).toUpperCase()]),
    ) as Record<BiomeId, string>;
    panel.appendChild(this.cycle(
      tr('screens.customBattle.biome', 'Biome'), cfg.biome, BIOME_IDS, biomeLabels,
      (v) => { cfg.biome = v; },
    ));

    panel.appendChild(this.stepper(
      tr('screens.customBattle.difficulty', 'Difficulty tier — x{mult} enemies',
        { mult: ngDifficultyMult(cfg.difficultyTier).toFixed(2) }),
      cfg.difficultyTier, 1, 10,
      (v) => { cfg.difficultyTier = v; rerender(); },
    ));

    panel.appendChild(this.stepper(
      tr('screens.customBattle.gates', 'Hive gates'), cfg.gates, 1, 6,
      (v) => { cfg.gates = v; },
    ));

    stack.appendChild(panel);

    const col = el('div', 'menu-col');
    col.appendChild(this.button(tr('screens.customBattle.deploy', 'Deploy'), () => {
      this.cb.onStartSkirmish(makeSkirmishLevel(cfg));
    }));
    col.appendChild(this.button(tr('screens.customBattle.back', 'Back'), () => this.showTitle(progress), 'btn ghost'));
    stack.appendChild(col);

    s.appendChild(stack);
    this.open('customBattle', s, () => this.showTitle(progress));
  }

  /* ====================================================================== */
  /* Achievements                                                            */
  /* ====================================================================== */

  /** `onBack` defaults to the title screen; the pause menu passes its own way back. */
  showAchievements(progress: Progress, onBack: () => void = () => this.showTitle(progress)) {
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack');
    stack.appendChild(el('h2', undefined, tr('screens.achievements.heading', 'Achievements')));
    stack.appendChild(el('p', 'flavor',
      tr('screens.achievements.intro',
        '{unlocked} of {total} unlocked. Every unlock grants a permanent ' +
        'bonus applied at the start of every run — they stack.',
        { unlocked: progress.unlockedCount, total: progress.totalCount })));

    const wrap = el('div', 'ach-wrap');
    const grid = el('div', 'ach-grid');

    const sorted = [...ACHIEVEMENTS].sort((a, b) => {
      const ua = progress.isUnlocked(a.id) ? 0 : 1;
      const ub = progress.isUnlocked(b.id) ? 0 : 1;
      if (ua !== ub) return ua - ub;
      return a.goal - b.goal;
    });

    for (const a of sorted) {
      const unlocked = progress.isUnlocked(a.id);
      const prog = progress.progressOf(a);
      const hidden = a.secret && !unlocked;

      const row = el('div', `ach ${unlocked ? 'unlocked' : 'locked'}`);
      row.appendChild(el('div', 'icon', hidden ? '❔' : a.icon));

      const body = el('div');
      body.style.flex = '1';
      const name = el('div', 'name', hidden ? tr('screens.achievements.hiddenName', 'Hidden Achievement') : achievementName(a));
      name.style.color = TIER_COLOR[a.tier];
      body.appendChild(name);
      body.appendChild(el('div', 'desc',
        hidden ? tr('screens.achievements.hiddenDesc', 'Discover it in the field.') : achievementDesc(a)));
      body.appendChild(el('div', 'perk', tr('screens.achievements.perkPrefix', '⬆ {perk}', { perk: describePerk(a.perk) })));

      if (!unlocked && !hidden && a.goal > 1) {
        const bar = el('div', 'bar');
        const i = el('i');
        i.style.width = `${Math.min(100, (prog / a.goal) * 100)}%`;
        bar.appendChild(i);
        body.appendChild(bar);
        const t = el('div', 'desc',
          tr('screens.achievements.progress', '{prog} / {goal}', { prog: fmtNum(prog), goal: fmtNum(a.goal) }));
        t.style.fontSize = '10px';
        body.appendChild(t);
      }
      row.appendChild(body);
      grid.appendChild(row);
    }

    wrap.appendChild(grid);
    stack.appendChild(wrap);
    stack.appendChild(this.button(tr('screens.achievements.back', 'Back'), onBack, 'btn ghost'));
    s.appendChild(stack);
    this.open('achievements', s, onBack);
  }

  /* ====================================================================== */
  /* Settings                                                                */
  /* ====================================================================== */

  /**
   * `onBack` defaults to the title screen. Opened from the pause menu it
   * returns there — it used to go to the title even mid-run.
   */
  showSettings(progress: Progress, onBack: () => void = () => this.showTitle(progress)) {
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack');
    stack.appendChild(el('h2', undefined, tr('screens.settings.heading', 'Settings')));

    const panel = el('div', 'panel clip-corner');
    panel.style.padding = '26px 30px';
    panel.style.width = 'min(520px, 90vw)';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.gap = '18px';
    // The row count (and each label's wrapped height) varies by language and
    // viewport, so cap the panel and let it scroll rather than pushing the
    // Back/Wipe-save row off the bottom of a short screen. Reserving a fixed
    // budget for the heading + button row (instead of a flat vh%) means a
    // roomy window still shows the whole panel with no scrollbar at all.
    panel.style.maxHeight = 'calc(100vh - 220px)';
    panel.style.overflowY = 'auto';

    const st = progress.data.settings;

    const slider = (label: string, value: number, min: number, max: number, step: number,
                    onInput: (v: number) => void) => {
      const wrap = el('div');
      const head = el('div', 'row');
      head.style.justifyContent = 'space-between';
      head.appendChild(el('div', 'label', label));
      const out = el('div', 'label', String(Math.round(value * 100) / 100));
      out.style.color = 'var(--accent)';
      head.appendChild(out);
      wrap.appendChild(head);
      const input = el('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.style.width = '100%';
      input.style.accentColor = '#46d8ff';
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        out.textContent = String(Math.round(v * 100) / 100);
        onInput(v);
        this.cb.onSettingChange();
      });
      wrap.appendChild(input);
      return wrap;
    };

    const toggle = (label: string, value: boolean, onChange: (v: boolean) => void) => {
      const row = el('div', 'row');
      row.style.justifyContent = 'space-between';
      row.appendChild(el('div', 'label', label));
      const b = el('button', 'btn ghost', value ? tr('screens.settings.on', 'ON') : tr('screens.settings.off', 'OFF'));
      b.style.padding = '6px 20px';
      b.addEventListener('click', () => {
        value = !value;
        b.textContent = value ? tr('screens.settings.on', 'ON') : tr('screens.settings.off', 'OFF');
        onChange(value);
        audio.play('uiClick');
        this.cb.onSettingChange();
      });
      row.appendChild(b);
      return row;
    };

    const localeOptions = LOCALES.map((l) => l.code);
    const localeLabels = Object.fromEntries(
      [['auto', tr('screens.settings.auto', 'AUTO')] as const,
        ...LOCALES.map((l): [LocaleCode, string] => [l.code, l.label.toUpperCase()])],
    ) as Record<'auto' | LocaleCode, string>;
    panel.appendChild(this.cycle(
      tr('screens.settings.language', 'Language'), st.locale, ['auto', ...localeOptions] as const, localeLabels,
      (v) => {
        st.locale = v;
        setLocale(v === 'auto' ? detectLocale() : v);
        this.cb.onSettingChange();
        // Every label on this very screen needs to redraw in the new language.
        this.showSettings(progress, onBack);
      },
    ));

    panel.appendChild(slider(tr('screens.settings.effectsVolume', 'Effects volume'), st.sfx, 0, 1, 0.05,
      (v) => { st.sfx = v; audio.setVolume('sfx', v); }));
    panel.appendChild(slider(tr('screens.settings.musicVolume', 'Music volume'), st.music, 0, 1, 0.05,
      (v) => { st.music = v; audio.setVolume('music', v); }));
    panel.appendChild(slider(tr('screens.settings.interfaceVolume', 'Interface volume'), st.ui, 0, 1, 0.05,
      (v) => { st.ui = v; audio.setVolume('ui', v); }));
    panel.appendChild(slider(tr('screens.settings.screenShake', 'Screen shake'), st.screenShake, 0, 1.5, 0.1,
      (v) => { st.screenShake = v; }));
    panel.appendChild(toggle(tr('screens.settings.muteAll', 'Mute all'), st.muted, (v) => { st.muted = v; audio.setMuted(v); }));
    panel.appendChild(toggle(tr('screens.settings.bloom', 'Bloom'), st.bloom, (v) => { st.bloom = v; }));
    panel.appendChild(toggle(tr('screens.settings.damageNumbers', 'Damage numbers'), st.showDamageNumbers,
      (v) => { st.showDamageNumbers = v; }));

    // --- controls & performance ---
    const divider = el('div');
    divider.style.borderTop = '1px solid var(--line)';
    divider.style.margin = '4px 0';
    panel.appendChild(divider);
    panel.appendChild(el('div', 'label', tr('screens.settings.controlsPerformance', 'controls & performance')));

    panel.appendChild(this.cycle(
      tr('screens.settings.controlScheme', 'Control scheme'), st.controls, ['auto', 'touch', 'desktop'] as const,
      {
        auto: tr('screens.settings.auto', 'AUTO'),
        touch: tr('screens.settings.controlSchemeTouch', 'TOUCH'),
        desktop: tr('screens.settings.controlSchemeDesktop', 'MOUSE + KEYS'),
      },
      (v) => { st.controls = v; this.cb.onSettingChange(); },
    ));
    panel.appendChild(this.cycle(
      tr('screens.settings.renderQuality', 'Render quality'), st.quality, ['auto', 'low', 'medium', 'high'] as const,
      {
        auto: tr('screens.settings.auto', 'AUTO'),
        low: tr('screens.settings.qualityLow', 'LOW'),
        medium: tr('screens.settings.qualityMedium', 'MEDIUM'),
        high: tr('screens.settings.qualityHigh', 'HIGH'),
      },
      (v) => { st.quality = v; this.cb.onSettingChange(); },
    ));
    panel.appendChild(slider(tr('screens.settings.uiScale', 'Interface scale'), st.uiScale, 0.8, 1.6, 0.1,
      (v) => { st.uiScale = v; }));
    // Both assists are forced on under touch controls; the toggles matter on desktop.
    panel.appendChild(toggle(tr('screens.settings.autoAim', 'Auto-aim (always on for touch)'), st.autoAim,
      (v) => { st.autoAim = v; }));
    panel.appendChild(toggle(tr('screens.settings.autoMine', 'Auto-mine'), st.autoMine,
      (v) => { st.autoMine = v; }));
    panel.appendChild(toggle(tr('screens.settings.southpaw', 'Left-handed layout'), st.southpaw, (v) => { st.southpaw = v; }));
    panel.appendChild(toggle(tr('screens.settings.haptics', 'Vibration'), st.haptics, (v) => { st.haptics = v; }));

    stack.appendChild(panel);

    const row = el('div', 'row');
    row.appendChild(this.button(tr('screens.settings.back', 'Back'), onBack, 'btn ghost'));
    row.appendChild(this.button(tr('screens.settings.wipeSave', 'Wipe save'), () => {
      this.confirmDialog(tr('screens.settings.wipeSaveConfirm',
        'Erase all achievements, unlocks and lifetime stats? This cannot be undone.'), () => {
        localStorage.removeItem('swarm.save.v1');
        location.reload();
      }, tr('screens.settings.wipeSave', 'Wipe save'));
    }, 'btn danger'));
    stack.appendChild(row);

    s.appendChild(stack);
    this.open('settings', s, onBack);
  }

  /* ====================================================================== */
  /* Briefing                                                                */
  /* ====================================================================== */

  showBriefing(game: Game, onBegin: () => void) {
    const lv = game.level;
    const s = el('div', 'screen');
    const stack = el('div', 'stack');

    stack.appendChild(el('p', 'subtitle', levelSubtitle(lv)));
    stack.appendChild(el('h2', undefined, levelName(lv)));
    stack.appendChild(el('p', 'flavor', levelBriefing(lv)));
    const rolled = el('p', 'flavor');
    rolled.style.fontSize = '12px';
    rolled.innerHTML = tr('screens.briefing.mapSeed',
      'Terrain, ore seams and hive gates are rolled fresh for this deployment — ' +
      'map seed <strong style="color:var(--accent)">{seed}</strong>.',
      { seed: game.seedCode });
    stack.appendChild(rolled);

    const grid = el('div', 'stat-grid');
    const boss = game.endless ? tr('screens.briefing.bossCadenceValue', 'EVERY 10 WAVES') : lv.boss.toUpperCase();
    const cells: [string, string][] = [
      [tr('screens.briefing.waves', 'Waves'), game.endless ? '∞' : `${lv.waves}`],
      [tr('screens.briefing.hiveGates', 'Hive gates'), `${lv.spawnPoints}`],
      [tr('screens.briefing.oreSeams', 'Ore seams'), `${lv.oreNodes + lv.richNodes}`],
      [game.endless ? tr('screens.briefing.bossCadence', 'Boss cadence') : tr('screens.briefing.finalWave', 'Final wave'), boss],
      [tr('screens.briefing.startingOre', 'Starting ore'), `${Math.round(lv.startOre + game.perks.startOre)}`],
      [tr('screens.briefing.mapSeedLabel', 'Map seed'), game.seedCode],
    ];
    for (const [k, v] of cells) {
      const c = el('div', 'cell');
      c.appendChild(el('div', 'label', k));
      c.appendChild(el('div', 'v accent', v));
      grid.appendChild(c);
    }
    stack.appendChild(grid);

    // Active permanent bonuses, so achievements feel present.
    const unlocked = ACHIEVEMENTS.filter((a) => game.progress.isUnlocked(a.id));
    if (unlocked.length) {
      const p = el('p', 'flavor');
      p.style.color = 'var(--good)';
      const moreCount = unlocked.length - 8;
      const morePart = moreCount > 0
        ? tr('screens.briefing.moreBonuses', ' · +{n} more', { n: moreCount })
        : '';
      p.innerHTML = tr('screens.briefing.bonusesActive', '<strong>{count} permanent bonuses active</strong><br>{list}{more}',
        {
          count: unlocked.length,
          list: unlocked.slice(0, 8).map((a) => describePerk(a.perk)).join(' · '),
          more: morePart,
        });
      stack.appendChild(p);
    }

    stack.appendChild(this.button(tr('screens.briefing.begin', 'Begin deployment'), () => { this.close(); onBegin(); }));
    s.appendChild(stack);
    this.open('briefing', s);
  }

  /* ====================================================================== */
  /* Pause                                                                   */
  /* ====================================================================== */

  showPause(game: Game, canSave = false) {
    const progress = game.progress;
    const s = el('div', 'screen');
    const stack = el('div', 'stack');
    stack.appendChild(el('h2', undefined, tr('screens.pause.heading', 'Paused')));
    // Build so far — how close each tech synergy is.
    if (game.techTaken.length) stack.appendChild(this.synergySummary(game.techTaken));
    const col = el('div', 'menu-col');
    col.appendChild(this.button(tr('screens.pause.resume', 'Resume'), () => { this.close(); this.cb.onResume(); }));
    col.appendChild(this.button(tr('screens.pause.loadout', 'Loadout'),
      () => this.showLoadout(game, () => this.showPause(game, canSave)), 'btn ghost'));
    // The touch controls reference; desktop controls are on the title hint bar.
    if (document.body.classList.contains('touch')) {
      col.appendChild(this.button(tr('screens.pause.howToPlay', 'How to play'),
        () => this.showTutorial(() => this.showPause(game, canSave)), 'btn ghost'));
    }
    const backToPause = () => this.showPause(game, canSave);
    col.appendChild(this.button(tr('screens.pause.achievements', 'Achievements'),
      () => this.showAchievements(progress, backToPause), 'btn ghost'));
    col.appendChild(this.button(tr('screens.pause.bestiary', 'Bestiary'),
      () => this.showBestiary(progress, backToPause), 'btn ghost'));
    col.appendChild(this.button(tr('screens.pause.settings', 'Settings'),
      () => this.showSettings(progress, backToPause), 'btn ghost'));
    col.appendChild(this.button(tr('screens.pause.restartSector', 'Restart sector'), () => {
      this.confirmDialog(tr('screens.pause.restartConfirm', 'Restart this sector from wave 1?'),
        () => this.cb.onRestart(), tr('screens.pause.restartSector', 'Restart sector'));
    }, 'btn ghost'));
    // Only offered in a build phase: that is the only state a snapshot covers.
    if (canSave) {
      col.appendChild(this.button(tr('screens.pause.saveAndQuit', 'Save & quit'), () => this.cb.onSaveAndQuit(), 'btn ghost'));
    }
    col.appendChild(this.button(tr('screens.pause.abandonRun', 'Abandon run'), () => {
      this.confirmDialog(
        tr('screens.pause.abandonConfirm', 'Abandon the run? Any saved progress for this run is discarded.'),
        () => this.cb.onQuitToTitle(), tr('screens.pause.abandonRun', 'Abandon run'));
    }, 'btn danger'));
    stack.appendChild(col);
    s.appendChild(stack);
    s.appendChild(el('div', 'hint-bar',
      canSave
        ? tr('screens.pause.hintCanSave', 'ESC to resume · the run auto-saves at the start of every build phase')
        : tr('screens.pause.hintCannotSave', 'ESC to resume · saving is available during build phases')));
    this.open('pause', s);
  }

  /* ====================================================================== */
  /* Loadout — essence-bought weapons and armor, mid-run                    */
  /* ====================================================================== */

  showLoadout(game: Game, onClose: () => void) {
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack');
    stack.appendChild(el('h2', undefined, tr('screens.loadout.heading', 'Loadout')));
    stack.appendChild(el('p', 'flavor',
      tr('screens.loadout.intro',
        'Essence spent here buys weapons and armor for your chassis — it carries between sectors in ' +
        'this campaign attempt, same as tech, but it is not a permanent unlock like the Armoury.')));

    const wallet = el('div', 'relic-bar');
    const amount = el('div', 'amount');
    wallet.appendChild(amount);
    stack.appendChild(wallet);

    const rows: (() => void)[] = [];
    const refreshWallet = () => {
      amount.textContent = tr('screens.loadout.essence', '{essence} ✦', { essence: Math.round(game.essence) });
    };

    stack.appendChild(el('h4', undefined, tr('screens.loadout.weapons', 'Weapons')));
    const wgrid = el('div', 'shop-grid');
    for (const kind of WEAPON_KINDS) {
      const w = WEAPONS[kind];
      const card = el('div', 'up');
      card.appendChild(el('div', 'icon', w.glyph));
      const body = el('div', 'body');
      body.appendChild(el('div', 'name', weaponName(w)));
      body.appendChild(el('div', 'desc', weaponDesc(w)));
      card.appendChild(body);
      const buy = el('button', 'buy');
      card.appendChild(buy);

      const refresh = () => {
        const owned = game.player.weaponsOwned.has(kind);
        const equipped = game.player.weapon === kind;
        card.className = `up${equipped ? ' maxed' : owned || game.essence >= w.cost ? ' affordable' : ''}`;
        buy.disabled = equipped;
        buy.textContent = equipped
          ? tr('screens.loadout.equipped', 'EQUIPPED')
          : owned
            ? tr('screens.loadout.equip', 'EQUIP')
            : tr('screens.loadout.costButton', '{cost} ✦', { cost: w.cost });
      };
      rows.push(refresh);

      buy.addEventListener('click', () => {
        if (!game.buyWeapon(kind)) { audio.play('error'); return; }
        refreshWallet();
        for (const r of rows) r();
      });
      buy.addEventListener('pointerenter', () => audio.play('uiHover'));
      wgrid.appendChild(card);
    }
    stack.appendChild(wgrid);

    stack.appendChild(el('h4', undefined, tr('screens.loadout.armor', 'Armor')));
    const agrid = el('div', 'shop-grid');
    // Tier 0 (unarmoured) is the free starting state — nothing to buy, so it
    // is not offered as a card; owning nothing already means "worn: none."
    for (const a of ARMOR_TIERS.slice(1)) {
      const card = el('div', 'up');
      card.appendChild(el('div', 'icon', '⛨'));
      const body = el('div', 'body');
      body.appendChild(el('div', 'name', armorTierName(a)));
      body.appendChild(el('div', 'desc', tr('screens.loadout.armorHp', '+{hp} max HP', { hp: a.hpBonus })));
      card.appendChild(body);
      const buy = el('button', 'buy');
      card.appendChild(buy);

      const refresh = () => {
        const owned = game.player.armorTier >= a.tier;
        const isNext = game.player.armorTier === a.tier - 1;
        card.className = `up${owned ? ' maxed' : isNext && game.essence >= a.cost ? ' affordable' : ''}`;
        buy.disabled = owned || !isNext;
        buy.textContent = owned
          ? tr('screens.loadout.worn', 'WORN')
          : isNext
            ? tr('screens.loadout.costButton', '{cost} ✦', { cost: a.cost })
            : tr('screens.loadout.locked', 'LOCKED');
      };
      rows.push(refresh);

      buy.addEventListener('click', () => {
        if (game.player.armorTier !== a.tier - 1 || !game.buyArmorTier()) { audio.play('error'); return; }
        refreshWallet();
        for (const r of rows) r();
      });
      buy.addEventListener('pointerenter', () => audio.play('uiHover'));
      agrid.appendChild(card);
    }
    stack.appendChild(agrid);

    refreshWallet();
    for (const r of rows) r();

    const close = () => { this.close(); onClose(); };
    stack.appendChild(this.button(tr('screens.loadout.close', 'Close'), close, 'btn ghost'));
    s.appendChild(stack);
    this.open('loadout', s, close);
  }

  /* ====================================================================== */
  /* Tech draft                                                              */
  /* ====================================================================== */

  /** `techTaken`: the run's picks so far, for the synergy progress on each card. */
  showDraft(cards: TechCard[], techTaken: readonly string[] = []) {
    const s = el('div', 'screen');
    const stack = el('div', 'stack');
    stack.appendChild(el('p', 'subtitle', tr('screens.draft.subtitle', 'field requisition')));
    stack.appendChild(el('h2', undefined, tr('screens.draft.heading', 'Choose an upgrade')));
    stack.appendChild(el('p', 'flavor',
      tr('screens.draft.intro', 'This choice lasts for the rest of the run and carries into the next sector.')));

    // Where each synergy family stands before this pick.
    const counts = synergyCounts(techTaken);
    stack.appendChild(this.synergySummary(techTaken));

    const row = el('div', 'card-row');
    for (const c of cards) {
      const card = el('div', 'tech-card');
      const glyph = el('div', 'glyph', c.glyph);
      glyph.style.color = c.rarity === 'epic' ? 'var(--essence)'
        : c.rarity === 'rare' ? 'var(--accent)' : 'var(--ink-dim)';
      card.appendChild(glyph);
      card.appendChild(el('div', `rarity r-${c.rarity}`, c.rarity));
      card.appendChild(el('h3', undefined, techName(c)));
      card.appendChild(el('p', undefined, techDesc(c)));
      if (c.perk) {
        const p = el('div', 'rarity');
        p.style.color = 'var(--good)';
        p.textContent = describePerk(c.perk);
        card.appendChild(p);
      }
      card.appendChild(this.synergyLine(c, counts));
      card.addEventListener('pointerenter', () => audio.play('uiHover'));
      card.addEventListener('click', () => {
        audio.play('uiClick');
        this.close();
        this.cb.onPickTech(c);
      });
      row.appendChild(card);
    }
    stack.appendChild(row);
    s.appendChild(stack);
    this.open('draft', s);
  }

  /**
   * One chip per synergy family: picks toward the next tier ("Arsenal 2/3"),
   * lit once a tier is on, ✓ when the set is complete.
   */
  private synergySummary(techTaken: readonly string[]): HTMLElement {
    const counts = synergyCounts(techTaken);
    const summary = el('div', 'synergy-summary');
    for (const tag of SYNERGY_TAGS) {
      const def = SYNERGIES[tag];
      const n = counts[tag];
      const reached = tiersReached(tag, n);
      const next = def.tiers[reached];
      const chip = el('span', 'synergy-chip' + (reached ? ' on' : ''),
        `${def.glyph} ${synergyName(tag)} ${next ? `${n}/${next.count}` : '✓'}`);
      chip.style.setProperty('--syn', css(def.color));
      summary.appendChild(chip);
    }
    return summary;
  }

  /**
   * The card's synergy family and what picking it does for that set: either
   * "completes Arsenal I: +10% turret fire rate", or progress toward the next
   * tier. See data/synergies.ts.
   */
  private synergyLine(c: TechCard, counts: Record<SynergyTag, number>): HTMLElement {
    const def = SYNERGIES[c.tag];
    const before = counts[c.tag];
    const after = before + 1;
    const tierBefore = tiersReached(c.tag, before);
    const tierAfter = tiersReached(c.tag, after);
    const box = el('div', 'synergy-line' + (tierAfter > tierBefore ? ' completes' : ''));
    box.style.setProperty('--syn', css(def.color));
    box.appendChild(el('div', 'synergy-tag', `${def.glyph} ${synergyName(c.tag)}`));
    if (tierAfter > tierBefore) {
      box.appendChild(el('div', 'synergy-text', tr('screens.draft.synergyCompletes', 'Completes {set}: {bonus}', {
        set: synergyTitle(c.tag, tierAfter), bonus: tierBonusText(c.tag, tierAfter - 1),
      })));
    } else {
      const next = def.tiers[tierBefore];
      box.appendChild(el('div', 'synergy-text', next
        ? tr('screens.draft.synergyProgress', '{n} → {m}/{need} for {bonus}', {
          n: before, m: after, need: next.count, bonus: tierBonusText(c.tag, tierBefore),
        })
        : tr('screens.draft.synergyDone', 'Set complete')));
    }
    return box;
  }

  /* ====================================================================== */
  /* Hive intel: new-enemy card and the bestiary                            */
  /* ====================================================================== */

  /** One enemy's intel panel: portrait, name, traits, flavour, how to fight it. */
  private enemyPanel(def: EnemyDef, known = true): HTMLElement {
    const panel = el('div', 'enemy-panel' + (def.boss ? ' boss' : '') + (known ? '' : ' unknown'));
    panel.appendChild(enemyPortrait(def, 88, !known));
    const body = el('div', 'enemy-body');
    body.appendChild(el('h3', undefined, known ? enemyName(def) : '???'));
    if (!known) {
      body.appendChild(el('p', 'enemy-desc', tr('screens.bestiary.unknown', 'Not yet encountered.')));
      panel.appendChild(body);
      return panel;
    }
    const traits = el('div', 'enemy-traits');
    for (const tr_ of enemyTraits(def)) traits.appendChild(el('span', 'enemy-trait', tr_));
    if (traits.childElementCount) body.appendChild(traits);
    const desc = enemyDesc(def);
    if (desc) body.appendChild(el('p', 'enemy-desc', desc));
    const counter = enemyCounter(def);
    if (counter) {
      body.appendChild(el('div', 'enemy-counter-label', tr('screens.enemyIntro.howTo', 'How to fight it')));
      body.appendChild(el('p', 'enemy-counter', counter));
    }
    panel.appendChild(body);
    return panel;
  }

  /**
   * Shown during a build phase when the next wave brings types the player
   * hasn't met: what they are and how to fight them, while there's still
   * time to build for it (anti-air for fliers, above all).
   */
  showEnemyIntro(defs: EnemyDef[], onDone: () => void) {
    const s = el('div', 'screen');
    const stack = el('div', 'stack');
    const boss = defs.some((d) => d.boss);
    stack.appendChild(el('p', 'subtitle', boss
      ? tr('screens.enemyIntro.bossSubtitle', 'boss incoming')
      : tr('screens.enemyIntro.subtitle', 'hive intel')));
    stack.appendChild(el('h2', undefined, defs.length > 1
      ? tr('screens.enemyIntro.headingMany', 'New hostiles in the next wave')
      : tr('screens.enemyIntro.heading', 'New hostile in the next wave')));
    const list = el('div', 'enemy-list');
    for (const d of defs) list.appendChild(this.enemyPanel(d));
    stack.appendChild(list);
    const done = () => { this.close(); onDone(); };
    stack.appendChild(this.button(tr('screens.enemyIntro.ok', 'Understood'), done));
    s.appendChild(stack);
    this.open('enemyIntro', s, done);
  }

  /** Every hive type: full intel for those met, a silhouette for the rest. */
  showBestiary(progress: Progress, onBack: () => void = () => this.showTitle(progress)) {
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack');
    const seen = new Set(progress.data.seenEnemies);
    const all = Object.values(ENEMIES);
    stack.appendChild(el('h2', undefined, tr('screens.bestiary.heading', 'Bestiary')));
    stack.appendChild(el('p', 'flavor', tr('screens.bestiary.intro',
      '{n} of {total} hive types catalogued. New ones are added the first time they show up in a wave.',
      { n: all.filter((d) => seen.has(d.id)).length, total: all.length })));
    const list = el('div', 'enemy-list');
    // Regular hive first, bosses last.
    for (const d of [...all.filter((x) => !x.boss), ...all.filter((x) => x.boss)]) {
      list.appendChild(this.enemyPanel(d, seen.has(d.id)));
    }
    stack.appendChild(list);
    stack.appendChild(this.button(tr('screens.bestiary.back', 'Back'), onBack, 'btn ghost'));
    s.appendChild(stack);
    this.open('bestiary', s, onBack);
  }

  /* ====================================================================== */
  /* Tutorial                                                                */
  /* ====================================================================== */

  /**
   * Touch control reference, opened from the pause menu. First-time players
   * are taught in context by the coach (render/coach.ts) instead; this is
   * the place to look something up again. Desktop spells its controls out in
   * the title screen's hint bar.
   */
  showTutorial(onDone: () => void) {
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack');
    stack.appendChild(el('h2', undefined, tr('screens.tutorial.heading', 'How to play')));

    const tips: [string, string, string][] = [
      ['◐', tr('screens.tutorial.moveTitle', 'Move'),
        tr('screens.tutorial.moveBody', 'Touch and drag near the bottom-left to walk.')],
      ['⌖', tr('screens.tutorial.aimTitle', 'Aim & fire'),
        tr('screens.tutorial.aimBody', 'Automatic — the nearest enemy is targeted and shot for you.')],
      ['⛏', tr('screens.tutorial.mineTitle', 'Mine'),
        tr('screens.tutorial.mineBody', 'Stand near a seam and hold your finger on it to mine.')],
      ['⌂', tr('screens.tutorial.buildTitle', 'Build'),
        tr('screens.tutorial.buildBody',
          'Tap Build and pick a structure. Tap the map to aim, then ✓ to build — walls go down on tap. '
          + 'Hold a slot in the drawer for details.')],
      ['✥', tr('screens.tutorial.lookTitle', 'Look & zoom'),
        tr('screens.tutorial.lookBody', 'While building, drag the map to look around. Pinch with two fingers to zoom.')],
      ['»', tr('screens.tutorial.dashTitle', 'Dash'),
        tr('screens.tutorial.dashBody', 'Tap Dash for a quick burst — good for dodging or closing gaps.')],
      ['✚', tr('screens.tutorial.manageTitle', 'Manage structures'),
        tr('screens.tutorial.manageBody', 'Long-press one for repair, sell (tap twice), or targeting options.')],
    ];

    const list = el('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '14px';
    list.style.width = 'min(460px, 88vw)';
    for (const [glyph, title, body] of tips) {
      const row = el('div', 'row');
      row.style.alignItems = 'flex-start';
      row.style.gap = '16px';
      const g = el('div', undefined, glyph);
      g.style.fontSize = '22px';
      g.style.color = 'var(--accent)';
      g.style.width = '28px';
      g.style.textAlign = 'center';
      g.style.flex = 'none';
      row.appendChild(g);
      const text = el('div');
      text.appendChild(el('div', 'label', title));
      const b = el('p', 'flavor', body);
      b.style.textAlign = 'left';
      b.style.margin = '4px 0 0';
      b.style.fontSize = '13px';
      text.appendChild(b);
      row.appendChild(text);
      list.appendChild(row);
    }
    stack.appendChild(list);

    const back = () => { this.close(); onDone(); };
    stack.appendChild(this.button(tr('screens.tutorial.back', 'Back'), back));

    s.appendChild(stack);
    this.open('tutorial', s, back);
  }

  /* ====================================================================== */
  /* Results                                                                 */
  /* ====================================================================== */

  showVictory(game: Game, isFinalSector: boolean) {
    const sum = game.summary();
    const skirmish = game.mode === 'skirmish';
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack');

    stack.appendChild(el('p', 'subtitle', skirmish
      ? tr('screens.victory.subtitleSkirmish', 'custom battle cleared')
      : isFinalSector
        ? tr('screens.victory.subtitleCampaign', 'campaign complete')
        : tr('screens.victory.subtitleSector', 'sector secured')));
    const h = el('h2', undefined, skirmish
      ? tr('screens.victory.titleSkirmish', 'Battle Won')
      : isFinalSector
        ? tr('screens.victory.titleCampaign', 'The Hive Is Silent')
        : tr('screens.victory.titleSector', 'Sector Secured'));
    h.style.color = 'var(--good)';
    stack.appendChild(h);
    stack.appendChild(el('p', 'flavor', skirmish
      ? tr('screens.victory.flavorSkirmish',
        'Your configuration held. No campaign progress rides on this one — just the relics you earned.')
      : isFinalSector
        ? tr('screens.victory.flavorCampaign',
          'The World-Eater is scrap and the throat is collapsing behind you. Every achievement you earned ' +
          'is permanent — start again and you will start stronger.')
        : tr('screens.victory.flavorSector', '{level} is clear. Your tech and unlocks carry forward.',
          { level: levelName(sum.level) })));

    if (!isFinalSector && !skirmish) {
      const nextLv = LEVELS[Math.min(LEVELS.length - 1, sum.level.id + 1)];
      const saved = el('p', 'flavor');
      saved.style.color = 'var(--good)';
      saved.innerHTML = tr('screens.victory.progressSaved',
        '✔ <strong>Progress saved.</strong> Sector {index} — {name} — is unlocked. ' +
        'You can quit now and start straight from there next time.',
        { index: nextLv.id + 1, name: levelName(nextLv) });
      stack.appendChild(saved);
    }

    if (game.lastRelicAward > 0) {
      const relic = el('p', 'flavor');
      relic.style.color = 'var(--relic)';
      relic.innerHTML = tr('screens.victory.relicAward',
        '⬢ <strong>+{award} relics</strong> — {total} banked. ' +
        'Spend them in the Armoury for permanent upgrades that apply to every future run.',
        { award: game.lastRelicAward, total: game.progress.relics });
      stack.appendChild(relic);
    }

    const structuresLostLabel = tr('screens.victory.stats.structuresLost', 'Structures lost');
    const grid = el('div', 'stat-grid');
    const cells: [string, string][] = [
      [tr('screens.victory.stats.wavesHeld', 'Waves held'), `${sum.waves}`],
      [tr('screens.victory.stats.kills', 'Kills'), fmtNum(sum.kills)],
      [tr('screens.victory.stats.damageDealt', 'Damage dealt'), fmtNum(sum.damage)],
      [tr('screens.victory.stats.oreMined', 'Ore mined'), fmtNum(sum.ore)],
      [tr('screens.victory.stats.essenceRendered', 'Essence rendered'), fmtNum(sum.essence)],
      [tr('screens.victory.stats.structuresBuilt', 'Structures built'), `${sum.built}`],
      [structuresLostLabel, `${sum.lost}`],
      [tr('screens.victory.stats.coreIntegrity', 'Core integrity'), `${Math.round(sum.corePct * 100)}%`],
      [tr('screens.victory.stats.time', 'Time'), fmtTime(sum.time)],
    ];
    for (const [k, v] of cells) {
      const c = el('div', 'cell');
      c.appendChild(el('div', 'label', k));
      const v2 = el('div', 'v accent', v);
      if (k === structuresLostLabel && sum.lost === 0) v2.style.color = 'var(--good)';
      c.appendChild(v2);
      grid.appendChild(c);
    }
    stack.appendChild(grid);

    if (sum.tech.length) {
      const p = el('p', 'flavor');
      p.innerHTML = tr('screens.victory.runTech', '<strong>Run tech:</strong> {list}',
        { list: sum.tech.map((t) => techName(t)).join(' · ') });
      stack.appendChild(p);
    }

    const col = el('div', 'menu-col');
    if (!isFinalSector && !skirmish) {
      col.appendChild(this.button(tr('screens.victory.advance', 'Advance to next sector'), () => this.cb.onNextLevel()));
    }
    if (skirmish) {
      col.appendChild(this.button(tr('screens.victory.battleAgain', 'Battle again'), () => this.cb.onRestart()));
    }
    col.appendChild(this.button(tr('screens.victory.returnToTitle', 'Return to title'), () => this.cb.onQuitToTitle(), 'btn ghost'));
    stack.appendChild(col);

    s.appendChild(stack);
    this.open(isFinalSector ? 'campaignEnd' : 'victory', s);
  }

  showDefeat(game: Game) {
    const sum = game.summary();
    const endless = sum.mode === 'endless';
    const rec = game.endlessRecord;
    const s = el('div', 'screen opaque');
    const stack = el('div', 'stack');

    stack.appendChild(el('p', 'subtitle', endless
      ? tr('screens.defeat.subtitleEndless', 'run over')
      : tr('screens.defeat.subtitleSector', 'core breach')));
    const h = el('h2', undefined, endless
      ? tr('screens.defeat.titleEndless', 'Wave {wave}', { wave: sum.wave })
      : tr('screens.defeat.titleSector', 'The Line Broke'));
    h.style.color = endless && rec?.isRecord ? 'var(--relic)' : 'var(--danger)';
    stack.appendChild(h);

    if (endless) {
      if (rec?.isRecord) {
        const nb = el('p', 'flavor');
        nb.style.color = 'var(--relic)';
        nb.innerHTML = tr('screens.defeat.newRecord', '★ <strong>New personal best</strong> on {level}.',
          { level: levelName(sum.level) });
        stack.appendChild(nb);
      } else if (rec) {
        stack.appendChild(el('p', 'flavor',
          tr('screens.defeat.bestStill', 'Your best on {level} is still wave {best}.',
            { level: levelName(sum.level), best: rec.best })));
      }
    } else {
      stack.appendChild(el('p', 'flavor',
        tr('screens.defeat.coreWentDark',
          'The core went dark on wave {wave} of {total}. Achievement progress is kept — ' +
          'the bonuses you earned here make the next attempt easier.',
          { wave: sum.wave, total: sum.waves })));
    }
    if (game.progress.relics > 0) {
      const relic = el('p', 'flavor');
      relic.style.color = 'var(--relic)';
      relic.innerHTML = tr('screens.defeat.relicsBanked',
        '⬢ <strong>{relics} relics banked.</strong> ' +
        'The Armoury turns them into permanent upgrades — and the next map will be a different one.',
        { relics: game.progress.relics });
      stack.appendChild(relic);
    }

    const grid = el('div', 'stat-grid');
    const cells: [string, string][] = [
      [tr('screens.defeat.stats.reachedWave', 'Reached wave'), endless ? `${sum.wave}` : `${sum.wave} / ${sum.waves}`],
      [tr('screens.defeat.stats.kills', 'Kills'), fmtNum(sum.kills)],
      [tr('screens.defeat.stats.oreMined', 'Ore mined'), fmtNum(sum.ore)],
      [tr('screens.defeat.stats.structuresLost', 'Structures lost'), `${sum.lost}`],
      [tr('screens.defeat.stats.damageDealt', 'Damage dealt'), fmtNum(sum.damage)],
      [tr('screens.defeat.stats.time', 'Time'), fmtTime(sum.time)],
    ];
    for (const [k, v] of cells) {
      const c = el('div', 'cell');
      c.appendChild(el('div', 'label', k));
      c.appendChild(el('div', 'v accent', v));
      grid.appendChild(c);
    }
    stack.appendChild(grid);

    const col = el('div', 'menu-col');
    col.appendChild(this.button(
      endless
        ? tr('screens.defeat.runAgain', 'Run it again')
        : game.mode === 'skirmish'
          ? tr('screens.defeat.retryBattle', 'Retry battle')
          : tr('screens.defeat.retrySector', 'Retry sector'),
      () => this.cb.onRestart(),
    ));
    col.appendChild(this.button(tr('screens.defeat.returnToTitle', 'Return to title'), () => this.cb.onQuitToTitle(), 'btn ghost'));
    stack.appendChild(col);

    s.appendChild(stack);
    this.open('defeat', s);
  }

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
