import { audio } from '../../core/audio';
import { fmtNum, fmtTime } from '../../core/math';
import { t as tr } from '../../core/i18n';
import { BOARD_IDS, type BoardId, type RunRecord } from '../../core/save';
import { LEVELS, levelName } from '../../data/levels';
import type { Progress } from '../../game/progress';
import type { Screens } from '../screens';
import { el } from '../dom';

/** The on-device leaderboards: one tab per way of playing. */

export const boardLabel = (id: BoardId) => ({
  endless: tr('screens.records.board.endless', 'Endless'),
  daily: tr('screens.records.board.daily', 'Daily'),
  campaign: tr('screens.records.board.campaign', 'Campaign'),
  skirmish: tr('screens.records.board.skirmish', 'Custom'),
})[id];

function whereLabel(r: RunRecord): string {
  if (r.day) return r.day;
  const lv = LEVELS[r.level];
  return lv ? levelName(lv) : tr('screens.records.customBattle', 'Custom battle');
}

/** A ranked table of runs. `highlight` marks a just-filed run (1-based place). */
export function renderBoard(rows: readonly RunRecord[], limit = rows.length, highlight?: number | null): HTMLElement {
  const table = el('div', 'rec-table');
  for (const h of [
    '#', tr('screens.records.score', 'Score'), tr('screens.records.waves', 'Waves'),
    tr('screens.records.kills', 'Kills'), tr('screens.records.time', 'Time'),
    tr('screens.records.where', 'Where'),
  ]) table.appendChild(el('div', 'h', h));

  if (rows.length === 0) {
    table.appendChild(el('div', 'empty', tr('screens.records.empty', 'No runs yet.')));
    return table;
  }
  rows.slice(0, limit).forEach((r, i) => {
    const mine = highlight === i + 1;
    const cls = mine ? 'gold' : 'dim';
    table.appendChild(el('div', cls, String(i + 1)));
    const score = el('div', 'score', r.score.toLocaleString());
    if (mine) score.classList.add('gold');
    table.appendChild(score);
    table.appendChild(el('div', undefined, String(r.waves)));
    table.appendChild(el('div', undefined, fmtNum(r.kills)));
    table.appendChild(el('div', undefined, fmtTime(r.seconds)));
    const where = el('div', 'dim', whereLabel(r));
    if (r.heat > 0) where.textContent += ` · 🔥${r.heat}`;
    table.appendChild(where);
  });
  return table;
}

export function showRecords(ui: Screens, progress: Progress, board: BoardId = 'endless') {
  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack');
  stack.appendChild(el('p', 'subtitle', tr('screens.records.subtitle', 'best runs on this device')));
  stack.appendChild(el('h2', undefined, tr('screens.records.heading', 'Records')));

  const tabs = el('div', 'tab-row');
  for (const id of BOARD_IDS) {
    const b = ui.button(boardLabel(id), () => ui.showRecords(progress, id), id === board ? 'btn active' : 'btn ghost');
    tabs.appendChild(b);
  }
  stack.appendChild(tabs);

  stack.appendChild(el('p', 'flavor', {
    endless: tr('screens.records.blurb.endless', 'Endless runs, ranked by score: waves survived first, kills second, boosted by heat.'),
    daily: tr('screens.records.blurb.daily', 'Your best daily challenge runs. Everyone plays the same map on the same day.'),
    campaign: tr('screens.records.blurb.campaign', 'Cleared sectors, ranked by score. Faster clears earn a speed bonus.'),
    skirmish: tr('screens.records.blurb.skirmish', 'Cleared custom battles, ranked by score.'),
  }[board]));

  stack.appendChild(renderBoard(progress.board(board)));
  stack.appendChild(ui.button(tr('screens.records.back', 'Back'), () => { audio.play('uiBack'); ui.showProgress(progress); }, 'btn ghost'));
  s.appendChild(stack);
  ui.open('records', s, () => ui.showProgress(progress));
}
