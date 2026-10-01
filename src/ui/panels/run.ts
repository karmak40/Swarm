import { audio } from '../../core/audio';
import { ACHIEVEMENTS } from '../../data/achievements';
import { describePerk } from '../../data/perks';
import { levelName, levelSubtitle, levelBriefing } from '../../data/levels';
import {
  WEAPON_KINDS, WEAPONS, weaponName, weaponDesc, ARMOR_TIERS, armorTierName,
} from '../../data/loadout';
import type { Game } from '../../game/game';
import { t as tr } from '../../core/i18n';
import type { Screens } from '../screens';
import { synergySummary } from './draft';
import { el } from '../dom';
import { MUTATORS_BY_ID } from '../../data/mutators';
import { mutatorRow } from './daily';

/** In-run modals: briefing, pause menu and the loadout shop. */

export function showBriefing(ui: Screens, game: Game, onBegin: () => void) {
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

  if (game.mutators.length) {
    if (game.daily) {
      stack.appendChild(el('p', 'label', tr('screens.briefing.daily', 'daily challenge · {date}', { date: game.daily.key })));
    }
    const list = el('div', 'mut-list');
    for (const id of game.mutators) {
      list.appendChild(mutatorRow(id, tr('screens.briefing.heatTag', '🔥 {heat}', { heat: MUTATORS_BY_ID.get(id)!.heat })));
    }
    stack.appendChild(list);
  }

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

  stack.appendChild(ui.button(tr('screens.briefing.begin', 'Begin deployment'), () => { ui.close(); onBegin(); }));
  s.appendChild(stack);
  ui.open('briefing', s);
}

export function showPause(ui: Screens, game: Game, canSave = false) {
  const progress = game.progress;
  const s = el('div', 'screen');
  const stack = el('div', 'stack');
  stack.appendChild(el('h2', undefined, tr('screens.pause.heading', 'Paused')));
  // Build so far — how close each tech synergy is.
  if (game.techTaken.length) stack.appendChild(synergySummary(game.techTaken));
  const col = el('div', 'menu-col');
  col.appendChild(ui.button(tr('screens.pause.resume', 'Resume'), () => { ui.close(); ui.cb.onResume(); }));
  col.appendChild(ui.button(tr('screens.pause.loadout', 'Loadout'),
    () => ui.showLoadout(game, () => ui.showPause(game, canSave)), 'btn ghost'));
  // The touch controls reference; desktop controls are on the title hint bar.
  if (document.body.classList.contains('touch')) {
    col.appendChild(ui.button(tr('screens.pause.howToPlay', 'How to play'),
      () => ui.showTutorial(() => ui.showPause(game, canSave)), 'btn ghost'));
  }
  const backToPause = () => ui.showPause(game, canSave);
  col.appendChild(ui.button(tr('screens.pause.achievements', 'Achievements'),
    () => ui.showAchievements(progress, backToPause), 'btn ghost'));
  col.appendChild(ui.button(tr('screens.pause.bestiary', 'Bestiary'),
    () => ui.showBestiary(progress, backToPause), 'btn ghost'));
  col.appendChild(ui.button(tr('screens.pause.settings', 'Settings'),
    () => ui.showSettings(progress, backToPause), 'btn ghost'));
  col.appendChild(ui.button(tr('screens.pause.restartSector', 'Restart sector'), () => {
    ui.confirmDialog(tr('screens.pause.restartConfirm', 'Restart this sector from wave 1?'),
      () => ui.cb.onRestart(), tr('screens.pause.restartSector', 'Restart sector'));
  }, 'btn ghost'));
  // Only offered in a build phase: that is the only state a snapshot covers.
  if (canSave) {
    col.appendChild(ui.button(tr('screens.pause.saveAndQuit', 'Save & quit'), () => ui.cb.onSaveAndQuit(), 'btn ghost'));
  }
  col.appendChild(ui.button(tr('screens.pause.abandonRun', 'Abandon run'), () => {
    ui.confirmDialog(
      tr('screens.pause.abandonConfirm', 'Abandon the run? Any saved progress for this run is discarded.'),
      () => ui.cb.onQuitToTitle(), tr('screens.pause.abandonRun', 'Abandon run'));
  }, 'btn danger'));
  stack.appendChild(col);
  s.appendChild(stack);
  s.appendChild(el('div', 'hint-bar',
    canSave
      ? tr('screens.pause.hintCanSave', 'ESC to resume · the run auto-saves at the start of every build phase')
      : tr('screens.pause.hintCannotSave', 'ESC to resume · saving is available during build phases')));
  ui.open('pause', s);
}

export function showLoadout(ui: Screens, game: Game, onClose: () => void) {
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

  const close = () => { ui.close(); onClose(); };
  stack.appendChild(ui.button(tr('screens.loadout.close', 'Close'), close, 'btn ghost'));
  s.appendChild(stack);
  ui.open('loadout', s, close);
}
