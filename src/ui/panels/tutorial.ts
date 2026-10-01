import { t as tr } from '../../core/i18n';
import type { Screens } from '../screens';
import { el } from '../dom';

/** Touch control reference. */

/**
 * Touch control reference, opened from the pause menu. First-time players
 * are taught in context by the coach (render/coach.ts) instead; this is
 * the place to look something up again. Desktop spells its controls out in
 * the title screen's hint bar.
 */
export function showTutorial(ui: Screens, onDone: () => void) {
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

  const back = () => { ui.close(); onDone(); };
  stack.appendChild(ui.button(tr('screens.tutorial.back', 'Back'), back));

  s.appendChild(stack);
  ui.open('tutorial', s, back);
}
