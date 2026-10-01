import { audio } from '../../core/audio';
import { describePerk, type PerkDelta } from '../../data/perks';
import {
  CATEGORY_ORDER, RELIC_UPGRADES, categoryLabel, categoryBlurb, relicUpgradeName, relicUpgradeDesc,
} from '../../data/relicUpgrades';
import type { Progress } from '../../game/progress';
import { t as tr } from '../../core/i18n';
import type { Screens } from '../screens';
import { el } from '../dom';

/** Permanent relic upgrades bought between runs. */

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

export function showArmoury(ui: Screens, progress: Progress) {
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
  btnRow.appendChild(ui.button(tr('screens.armoury.back', 'Back'), () => ui.showProgress(progress), 'btn ghost'));
  btnRow.appendChild(ui.button(tr('screens.armoury.refundAll', 'Refund all'), () => {
    if (progress.spentRelics <= 0) { audio.play('error'); return; }
    ui.confirmDialog(tr('screens.armoury.refundConfirm', 'Refund every upgrade and get {relics} relics back?',
      { relics: progress.spentRelics }), () => {
      progress.respec();
      audio.play('sell');
      ui.showArmoury(progress);
    }, tr('screens.armoury.refundAll', 'Refund all'));
  }, 'btn ghost'));
  stack.appendChild(btnRow);

  s.appendChild(stack);
  ui.open('armoury', s, () => ui.showProgress(progress));
}
