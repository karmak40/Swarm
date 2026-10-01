import { fmtNum } from '../../core/math';
import { t as tr } from '../../core/i18n';
import { dailyKey } from '../../data/daily';
import { ENEMIES } from '../../data/enemies';
import type { Progress } from '../../game/progress';
import type { Screens } from '../screens';
import { el } from '../dom';

/**
 * The two hubs behind the title screen's "Game modes" and "Progress" buttons.
 * The title keeps only what a player reaches for every session; everything
 * else is one tap further, grouped by intent — where to play, and what you
 * have earned.
 */

function hub(
  ui: Screens, name: 'modes' | 'progressHub', subtitle: string, heading: string,
  progress: Progress, fill: (col: HTMLElement) => void,
) {
  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack');
  stack.appendChild(el('p', 'subtitle', subtitle));
  stack.appendChild(el('h2', undefined, heading));
  const col = el('div', 'menu-col');
  fill(col);
  col.appendChild(ui.button(tr('screens.hub.back', 'Back'), () => ui.showTitle(progress), 'btn ghost'));
  stack.appendChild(col);
  s.appendChild(stack);
  ui.open(name, s, () => ui.showTitle(progress));
}

export function showModes(ui: Screens, progress: Progress) {
  hub(ui, 'modes', tr('screens.modes.subtitle', 'choose your fight'), tr('screens.modes.heading', 'Game Modes'), progress, (col) => {
    col.appendChild(ui.button(tr('screens.title.sectorSelect', 'Sector select'), () => ui.showLevelSelect(progress), 'btn ghost'));
    const best = progress.endlessBestOverall;
    col.appendChild(ui.button(
      best > 0
        ? tr('screens.title.endlessBest', 'Endless · best wave {best}', { best })
        : tr('screens.title.endlessMode', 'Endless mode'),
      () => ui.showEndlessSelect(progress), 'btn ghost',
    ));
    const key = dailyKey();
    const done = progress.dailyDone(key);
    col.appendChild(ui.button(
      done
        ? tr('screens.title.dailyBest', 'Daily challenge · best {score}', { score: fmtNum(progress.dailyBest(key)) })
        : tr('screens.title.dailyNew', 'Daily challenge · new'),
      () => ui.showDaily(progress), done ? 'btn ghost' : 'btn',
    ));
    col.appendChild(ui.button(tr('screens.title.customBattle', 'Custom battle'), () => ui.showCustomBattle(progress), 'btn ghost'));
  });
}

export function showProgress(ui: Screens, progress: Progress) {
  hub(ui, 'progressHub', tr('screens.progress.subtitle', 'what you have earned'), tr('screens.progress.heading', 'Progress'), progress, (col) => {
    col.appendChild(ui.button(
      tr('screens.title.armoury', 'Armoury · {relics} ⬢', { relics: progress.relics }),
      () => ui.showArmoury(progress), progress.relics > 0 ? 'btn' : 'btn ghost',
    ));
    col.appendChild(ui.button(
      tr('screens.progress.commander', 'Commander rank · {rank}', { rank: progress.rank }),
      () => ui.showCommander(progress), 'btn ghost',
    ));
    col.appendChild(ui.button(
      tr('screens.title.achievements', 'Achievements · {unlocked}/{total}',
        { unlocked: progress.unlockedCount, total: progress.totalCount }),
      () => ui.showAchievements(progress), 'btn ghost',
    ));
    col.appendChild(ui.button(
      tr('screens.title.bestiary', 'Bestiary · {n}/{total}', {
        n: progress.data.seenEnemies.length, total: Object.keys(ENEMIES).length,
      }),
      () => ui.showBestiary(progress), 'btn ghost',
    ));
    if (progress.data.stats.runs > 0) {
      col.appendChild(ui.button(tr('screens.title.records', 'Records'), () => ui.showRecords(progress), 'btn ghost'));
    }
  });
}
