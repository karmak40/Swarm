import { audio } from '../../core/audio';
import { describePerk } from '../../data/perks';
import { techName, techDesc, type TechCard } from '../../data/tech';
import {
  SYNERGIES, SYNERGY_TAGS, synergyCounts, synergyName, synergyTitle, tierBonusText, tiersReached,
  type SynergyTag,
} from '../../data/synergies';
import { css } from '../../render/palette';
import { t as tr } from '../../core/i18n';
import type { Screens } from '../screens';
import { el } from '../dom';

/** Tech draft between waves, with synergy progress. */

/** `techTaken`: the run's picks so far, for the synergy progress on each card. */
export function showDraft(ui: Screens, cards: TechCard[], techTaken: readonly string[] = []) {
  const s = el('div', 'screen');
  const stack = el('div', 'stack');
  stack.appendChild(el('p', 'subtitle', tr('screens.draft.subtitle', 'field requisition')));
  stack.appendChild(el('h2', undefined, tr('screens.draft.heading', 'Choose an upgrade')));
  stack.appendChild(el('p', 'flavor',
    tr('screens.draft.intro', 'This choice lasts for the rest of the run and carries into the next sector.')));

  // Where each synergy family stands before this pick.
  const counts = synergyCounts(techTaken);
  stack.appendChild(synergySummary(techTaken));

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
    card.appendChild(synergyLine(c, counts));
    card.addEventListener('pointerenter', () => audio.play('uiHover'));
    card.addEventListener('click', () => {
      audio.play('uiClick');
      ui.close();
      ui.cb.onPickTech(c);
    });
    row.appendChild(card);
  }
  stack.appendChild(row);
  s.appendChild(stack);
  ui.open('draft', s);
}

/**
 * One chip per synergy family: picks toward the next tier ("Arsenal 2/3"),
 * lit once a tier is on, ✓ when the set is complete.
 */
export function synergySummary(techTaken: readonly string[]): HTMLElement {
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
export function synergyLine(c: TechCard, counts: Record<SynergyTag, number>): HTMLElement {
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
