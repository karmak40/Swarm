import { t } from '../core/i18n';
import type { EnemyDef } from './enemies';

/**
 * What the new-enemy card and the bestiary say about a hive type: short trait
 * chips and a "how to fight it" line. Derived from the def (behaviour, flags,
 * abilities) rather than written per enemy, so a new type gets sensible
 * advice for free — and the advice can't drift from what the unit does.
 */

const flies = (d: EnemyDef) => d.behavior === 'flyer' || !!d.flies;

/** Short trait chips: "Flies", "Armour 10", "Boss", … */
export function enemyTraits(d: EnemyDef): string[] {
  const out: string[] = [];
  if (d.boss) out.push(t('bestiary.trait.boss', 'Boss'));
  if (flies(d)) out.push(t('bestiary.trait.flies', 'Flies'));
  if (d.behavior === 'ranged') out.push(t('bestiary.trait.ranged', 'Ranged'));
  if (d.behavior === 'burrower') out.push(t('bestiary.trait.burrows', 'Burrows'));
  if (d.behavior === 'support') out.push(t('bestiary.trait.support', 'Heals allies'));
  if (d.behavior === 'splitter') out.push(t('bestiary.trait.splits', 'Splits'));
  if (d.behavior === 'bomber') out.push(t('bestiary.trait.explodes', 'Explodes'));
  if (d.speed >= 90) out.push(t('bestiary.trait.fast', 'Fast'));
  if (d.armor >= 3) out.push(t('bestiary.trait.armour', 'Armour {n}', { n: d.armor }));
  return out;
}

/**
 * How to fight it, as one or more short sentences: the behaviour's counter,
 * then a tip per telegraphed ability. Fliers lead with the anti-air warning —
 * the one thing a player otherwise learns only by losing.
 */
export function enemyCounter(d: EnemyDef): string {
  const parts: string[] = [];
  if (flies(d)) {
    parts.push(t('bestiary.counter.flies',
      'Flies over walls and terrain. Only anti-air reaches it: Autogun, Flak, Arc Node, Missiles and lasers. The Siege Cannon and Mortar cannot hit it.'));
  }
  switch (d.behavior) {
    case 'swarm':
      parts.push(t('bestiary.counter.swarm', 'Fast and fragile, arrives in clouds. Splash weapons (Flak, Cannon, Mortar) shred them.'));
      break;
    case 'charger':
      parts.push(t('bestiary.counter.charger', 'Runs at the core and chews through whatever is in the way. Walls buy your turrets time.'));
      break;
    case 'brute':
      parts.push(t('bestiary.counter.brute', 'Armoured, and goes for your walls first. Armour-piercing damage (Lance, Pulse Laser, Siege Cannon) and focused fire.'));
      break;
    case 'ranged':
      if (!flies(d)) {
        parts.push(t('bestiary.counter.ranged', 'Stops at range and shoots. Outrange it (Missiles, Cannon, Lance, Mortar) or go after it with the pilot.'));
      }
      break;
    case 'bomber':
      parts.push(t('bestiary.counter.bomber', 'Explodes on contact. Kill it before it reaches a turret cluster; walls out front take the blast.'));
      break;
    case 'burrower':
      parts.push(t('bestiary.counter.burrower', 'Dives under walls and cannot be hit while buried. Keep turrets covering the inside of your walls too.'));
      break;
    case 'support':
      parts.push(t('bestiary.counter.support', 'Heals and hardens everything near it. Kill it first: focus fire or the orbital strike.'));
      break;
    case 'splitter':
      parts.push(t('bestiary.counter.splitter', 'Bursts into smaller copies when killed. Splash damage cleans up the pieces.'));
      break;
    default:
      break;
  }
  const seen = new Set<string>();
  for (const ab of d.abilities ?? []) {
    if (seen.has(ab.id)) continue;
    seen.add(ab.id);
    const tip = abilityTip(ab.id);
    if (tip) parts.push(tip);
  }
  return parts.join(' ');
}

function abilityTip(id: string): string | null {
  switch (id) {
    case 'charge': return t('bestiary.tip.charge', 'Rears back before a charge: the wind-up is your warning.');
    case 'slam': return t('bestiary.tip.slam', 'Ground-slams everything close: keep the pilot out of the ring.');
    case 'spawn': return t('bestiary.tip.spawn', 'Spits out fresh swarmlings around itself: splash weapons clear them fastest.');
    case 'shed': return t('bestiary.tip.shed', 'Sheds live segments as it goes.');
    case 'beam': return t('bestiary.tip.beam', 'Sweeps a beam toward the core: do not line everything up on one axis.');
    case 'volley': return t('bestiary.tip.volley', 'Answers walls with a volley of orbs.');
    case 'shield': return t('bestiary.tip.shield', 'Raises a shield that decays: keep firing through it.');
    case 'burrow': return t('bestiary.tip.burrow', 'Dives under your walls and erupts behind them: build defences in depth.');
    case 'web': return t('bestiary.tip.web', 'Webs silence turrets for a few seconds: spread your guns out.');
    default: return null;
  }
}
