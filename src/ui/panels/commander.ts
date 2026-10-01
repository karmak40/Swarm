import { fmtNum } from '../../core/math';
import { t as tr } from '../../core/i18n';
import { describePerk } from '../../data/perks';
import { MAX_RANK, RANKS, rankRelics, rankTitle } from '../../data/ranks';
import { MUTATORS, mutatorName } from '../../data/mutators';
import type { Progress } from '../../game/progress';
import type { Screens } from '../screens';
import { el } from '../dom';

/** Commander rank: the passive, run-by-run layer of progression. */

/** Compact rank readout for the title screen. Clicking it opens the full ladder. */
export function rankStrip(ui: Screens, progress: Progress): HTMLElement {
  const st = progress.rankStatus;
  const def = RANKS[st.rank - 1];
  const strip = el('button', 'rank-strip');
  strip.addEventListener('click', () => ui.showCommander(progress));
  strip.appendChild(el('div', 'line label',
    tr('screens.title.rank', 'rank {n} · {title}', { n: st.rank, title: rankTitle(def) })));
  const bar = el('div', 'rank-bar');
  const fill = el('i');
  fill.style.width = `${Math.round(st.progress * 100)}%`;
  bar.appendChild(fill);
  strip.appendChild(bar);
  return strip;
}

export function showCommander(ui: Screens, progress: Progress) {
  const st = progress.rankStatus;
  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack');
  stack.appendChild(el('p', 'subtitle', tr('screens.commander.subtitle', 'earned by playing')));
  stack.appendChild(el('h2', undefined, tr('screens.commander.heading', 'Commander Rank')));
  stack.appendChild(el('p', 'flavor',
    st.rank >= MAX_RANK
      ? tr('screens.commander.maxed', '{xp} XP. You have reached the top of the ladder.', { xp: fmtNum(progress.xp) })
      : tr('screens.commander.intro',
        'Every run pays XP — win or lose, deeper waves and more heat pay more. Each rank adds a permanent bonus, ' +
        'a relic bounty and sometimes a new mutator. {into} / {span} XP to the next rank.',
        { into: fmtNum(st.into), span: fmtNum(st.span) })));

  const list = el('div', 'rank-list');
  for (const def of RANKS) {
    const row = el('div', 'rank-row' + (def.rank <= st.rank ? ' reached' : '') + (def.rank === st.rank ? ' current' : ''));
    row.appendChild(el('div', 'n', String(def.rank)));
    row.appendChild(el('div', 't', rankTitle(def)));
    const bits: string[] = [];
    if (def.perk) bits.push(describePerk(def.perk));
    const relics = rankRelics(def.rank);
    if (relics > 0) bits.push(`+${relics} ⬢`);
    for (const m of MUTATORS) {
      if (m.unlockRank === def.rank) {
        bits.push(tr('screens.commander.unlocksMutator', 'unlocks {name}', { name: mutatorName(m) }));
      }
    }
    row.appendChild(el('div', 'perk', bits.join(' · ')));
    list.appendChild(row);
  }
  stack.appendChild(list);
  stack.appendChild(ui.button(tr('screens.commander.back', 'Back'), () => ui.showProgress(progress), 'btn ghost'));
  s.appendChild(stack);
  ui.open('commander', s, () => ui.showProgress(progress));
}
