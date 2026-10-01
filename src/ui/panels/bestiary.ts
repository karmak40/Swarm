import { enemyPortrait } from '../../render/portrait';
import { enemyCounter, enemyTraits } from '../../data/bestiary';
import { ENEMIES, enemyDesc, enemyName, type EnemyDef } from '../../data/enemies';
import type { Progress } from '../../game/progress';
import { t as tr } from '../../core/i18n';
import type { Screens } from '../screens';
import { el } from '../dom';

/** Enemy panels: the per-wave intro card and the Bestiary. */

/** One enemy's intel panel: portrait, name, traits, flavour, how to fight it. */
export function enemyPanel(def: EnemyDef, known = true): HTMLElement {
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
export function showEnemyIntro(ui: Screens, defs: EnemyDef[], onDone: () => void) {
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
  for (const d of defs) list.appendChild(enemyPanel(d));
  stack.appendChild(list);
  const done = () => { ui.close(); onDone(); };
  stack.appendChild(ui.button(tr('screens.enemyIntro.ok', 'Understood'), done));
  s.appendChild(stack);
  ui.open('enemyIntro', s, done);
}

/** Every hive type: full intel for those met, a silhouette for the rest. */
export function showBestiary(ui: Screens, progress: Progress, onBack: () => void = () => ui.showProgress(progress)) {
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
    list.appendChild(enemyPanel(d, seen.has(d.id)));
  }
  stack.appendChild(list);
  stack.appendChild(ui.button(tr('screens.bestiary.back', 'Back'), onBack, 'btn ghost'));
  s.appendChild(stack);
  ui.open('bestiary', s, onBack);
}
