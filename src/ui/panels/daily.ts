import { fmtNum } from '../../core/math';
import { t as tr } from '../../core/i18n';
import { dailyChallenge, dailyKey } from '../../data/daily';
import { LEVELS, levelName, levelSubtitle } from '../../data/levels';
import { HEAT_STEP, MUTATORS_BY_ID, mutatorDesc, mutatorName, totalHeat } from '../../data/mutators';
import type { Progress } from '../../game/progress';
import type { Screens } from '../screens';
import { el } from '../dom';
import { renderBoard } from './records';

/** The daily challenge: today's shared map, its two mutators, and your history with it. */

/** One mutator line, shared by the daily card and the endless picker. */
export function mutatorRow(id: string, tag: string, as: 'div' | 'button' = 'div'): HTMLElement {
  const m = MUTATORS_BY_ID.get(id)!;
  const row = el(as, 'mut-row');
  row.appendChild(el('div', 'icon', m.icon));
  const body = el('div', 'body');
  body.appendChild(el('div', 'name', mutatorName(m)));
  body.appendChild(el('div', 'desc', mutatorDesc(m)));
  row.appendChild(body);
  row.appendChild(el('div', 'heat', tag));
  return row;
}

export function showDaily(ui: Screens, progress: Progress) {
  const key = dailyKey();
  const dc = dailyChallenge(key);
  const lv = LEVELS[dc.levelIndex];
  const heat = totalHeat(dc.mutators);
  const d = progress.data.daily;
  const best = progress.dailyBest(key);

  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack');
  stack.appendChild(el('p', 'subtitle', tr('screens.daily.subtitle', 'daily challenge · {date}', { date: key })));
  stack.appendChild(el('h2', undefined, levelName(lv)));
  stack.appendChild(el('p', 'flavor',
    tr('screens.daily.intro',
      '{sector}. One shared endless run per day: everyone gets this map and these handicaps, ' +
      'and only your best score of the day counts. The first run each day pays a relic bounty that grows with your streak.',
      { sector: levelSubtitle(lv) })));

  const list = el('div', 'mut-list');
  for (const id of dc.mutators) {
    list.appendChild(mutatorRow(id, tr('screens.daily.heatTag', '🔥 {heat}', { heat: MUTATORS_BY_ID.get(id)!.heat })));
  }
  stack.appendChild(list);
  stack.appendChild(el('p', 'flavor',
    tr('screens.daily.heatTotal', 'Heat {heat} — score, XP and relics ×{mult}',
      { heat, mult: (1 + heat * HEAT_STEP).toFixed(1) })));

  const grid = el('div', 'stat-grid');
  const cells: [string, string][] = [
    [tr('screens.daily.todaysBest', "Today's best"), best > 0 ? fmtNum(best) : '—'],
    [tr('screens.daily.streak', 'Streak'), tr('screens.daily.days', '{n} d', { n: d.streak })],
    [tr('screens.daily.bestStreak', 'Best streak'), tr('screens.daily.days', '{n} d', { n: d.bestStreak })],
  ];
  for (const [k, v] of cells) {
    const c = el('div', 'cell');
    c.appendChild(el('div', 'label', k));
    c.appendChild(el('div', 'v accent', v));
    grid.appendChild(c);
  }
  stack.appendChild(grid);

  const todays = progress.board('daily').filter((r) => r.day === key);
  if (todays.length) stack.appendChild(renderBoard(todays, 3));

  const col = el('div', 'menu-col');
  col.appendChild(ui.button(
    progress.dailyDone(key)
      ? tr('screens.daily.again', 'Beat your score')
      : tr('screens.daily.deploy', 'Deploy'),
    () => ui.cb.onStartDaily(),
  ));
  col.appendChild(ui.button(tr('screens.daily.records', 'Records'), () => ui.showRecords(progress, 'daily'), 'btn ghost'));
  col.appendChild(ui.button(tr('screens.daily.back', 'Back'), () => ui.showModes(progress), 'btn ghost'));
  stack.appendChild(col);

  s.appendChild(stack);
  ui.open('daily', s, () => ui.showModes(progress));
}
