import { fmtNum, fmtTime } from '../../core/math';
import { LEVELS, levelName } from '../../data/levels';
import { techName } from '../../data/tech';
import type { Game } from '../../game/game';
import { t as tr } from '../../core/i18n';
import type { Screens } from '../screens';
import { el } from '../dom';
import { boardLabel } from './records';
import { RANKS, rankTitle } from '../../data/ranks';

/** Score, board placement, daily streak and commander XP for the run that just ended. */
function resultBox(game: Game): HTMLElement | null {
  const r = game.result;
  if (!r) return null;
  const box = el('div', 'result-box');
  box.appendChild(el('div', 'label', tr('screens.result.score', 'Score')));
  box.appendChild(el('div', 'score', r.score.toLocaleString()));
  const line = (text: string, color?: string) => {
    const p = el('div', 'sub', text);
    if (color) p.style.color = color;
    box.appendChild(p);
  };
  if (r.heat > 0) {
    line(tr('screens.result.heat', '🔥 heat {heat} · ×{mult}', { heat: r.heat, mult: r.mult.toFixed(1) }), 'var(--relic)');
  }
  if (r.board) {
    if (r.place === 1) {
      line(tr('screens.result.first', '★ New #1 on the {board} board', { board: boardLabel(r.board) }), 'var(--relic)');
    } else if (r.place) {
      line(tr('screens.result.place', '★ #{place} on the {board} board', { place: r.place, board: boardLabel(r.board) }), 'var(--good)');
    } else {
      line(tr('screens.result.missed', 'Below the top 10 of the {board} board', { board: boardLabel(r.board) }));
    }
  }
  if (r.daily) {
    line(r.daily.newBest
      ? tr('screens.result.dailyBest', 'New best for {day}', { day: r.daily.key })
      : tr('screens.result.dailyNoBest', 'Your best for {day} stands', { day: r.daily.key }));
    if (r.daily.first) {
      line(tr('screens.result.dailyStreak', 'Streak {n} d · +{relics} ⬢ daily bounty', { n: r.daily.streak, relics: r.daily.relics }), 'var(--relic)');
    }
  }
  line(tr('screens.result.xp', '+{xp} XP', { xp: r.xp.gained }), 'var(--accent)');
  if (r.xp.after > r.xp.before) {
    line(tr('screens.result.rankUp', '▲ Rank {rank} · {title} · +{relics} ⬢',
      { rank: r.xp.after, title: rankTitle(RANKS[r.xp.after - 1]), relics: r.xp.relics }), 'var(--good)');
  }
  return box;
}

/** Victory and defeat screens. */

export function showVictory(ui: Screens, game: Game, isFinalSector: boolean) {
  const sum = game.summary();
  const skirmish = game.mode === 'skirmish';
  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack');

  stack.appendChild(el('p', 'subtitle', skirmish
    ? tr('screens.victory.subtitleSkirmish', 'custom battle cleared')
    : isFinalSector
      ? tr('screens.victory.subtitleCampaign', 'campaign complete')
      : tr('screens.victory.subtitleSector', 'sector secured')));
  const h = el('h2', undefined, skirmish
    ? tr('screens.victory.titleSkirmish', 'Battle Won')
    : isFinalSector
      ? tr('screens.victory.titleCampaign', 'The Hive Is Silent')
      : tr('screens.victory.titleSector', 'Sector Secured'));
  h.style.color = 'var(--good)';
  stack.appendChild(h);
  stack.appendChild(el('p', 'flavor', skirmish
    ? tr('screens.victory.flavorSkirmish',
      'Your configuration held. No campaign progress rides on this one — just the relics you earned.')
    : isFinalSector
      ? tr('screens.victory.flavorCampaign',
        'The World-Eater is scrap and the throat is collapsing behind you. Every achievement you earned ' +
        'is permanent — start again and you will start stronger.')
      : tr('screens.victory.flavorSector', '{level} is clear. Your tech and unlocks carry forward.',
        { level: levelName(sum.level) })));

  if (!isFinalSector && !skirmish) {
    const nextLv = LEVELS[Math.min(LEVELS.length - 1, sum.level.id + 1)];
    const saved = el('p', 'flavor');
    saved.style.color = 'var(--good)';
    saved.innerHTML = tr('screens.victory.progressSaved',
      '✔ <strong>Progress saved.</strong> Sector {index} — {name} — is unlocked. ' +
      'You can quit now and start straight from there next time.',
      { index: nextLv.id + 1, name: levelName(nextLv) });
    stack.appendChild(saved);
  }

  if (game.lastRelicAward > 0) {
    const relic = el('p', 'flavor');
    relic.style.color = 'var(--relic)';
    relic.innerHTML = tr('screens.victory.relicAward',
      '⬢ <strong>+{award} relics</strong> — {total} banked. ' +
      'Spend them in the Armoury for permanent upgrades that apply to every future run.',
      { award: game.lastRelicAward, total: game.progress.relics });
    stack.appendChild(relic);
  }

  const box = resultBox(game);
  if (box) stack.appendChild(box);

  const structuresLostLabel = tr('screens.victory.stats.structuresLost', 'Structures lost');
  const grid = el('div', 'stat-grid');
  const cells: [string, string][] = [
    [tr('screens.victory.stats.wavesHeld', 'Waves held'), `${sum.waves}`],
    [tr('screens.victory.stats.kills', 'Kills'), fmtNum(sum.kills)],
    [tr('screens.victory.stats.damageDealt', 'Damage dealt'), fmtNum(sum.damage)],
    [tr('screens.victory.stats.oreMined', 'Ore mined'), fmtNum(sum.ore)],
    [tr('screens.victory.stats.essenceRendered', 'Essence rendered'), fmtNum(sum.essence)],
    [tr('screens.victory.stats.structuresBuilt', 'Structures built'), `${sum.built}`],
    [structuresLostLabel, `${sum.lost}`],
    [tr('screens.victory.stats.coreIntegrity', 'Core integrity'), `${Math.round(sum.corePct * 100)}%`],
    [tr('screens.victory.stats.time', 'Time'), fmtTime(sum.time)],
  ];
  for (const [k, v] of cells) {
    const c = el('div', 'cell');
    c.appendChild(el('div', 'label', k));
    const v2 = el('div', 'v accent', v);
    if (k === structuresLostLabel && sum.lost === 0) v2.style.color = 'var(--good)';
    c.appendChild(v2);
    grid.appendChild(c);
  }
  stack.appendChild(grid);

  if (sum.tech.length) {
    const p = el('p', 'flavor');
    p.innerHTML = tr('screens.victory.runTech', '<strong>Run tech:</strong> {list}',
      { list: sum.tech.map((t) => techName(t)).join(' · ') });
    stack.appendChild(p);
  }

  const col = el('div', 'menu-col');
  if (!isFinalSector && !skirmish) {
    col.appendChild(ui.button(tr('screens.victory.advance', 'Advance to next sector'), () => ui.cb.onNextLevel()));
  }
  if (skirmish) {
    col.appendChild(ui.button(tr('screens.victory.battleAgain', 'Battle again'), () => ui.cb.onRestart()));
  }
  col.appendChild(ui.button(tr('screens.victory.returnToTitle', 'Return to title'), () => ui.cb.onQuitToTitle(), 'btn ghost'));
  stack.appendChild(col);

  s.appendChild(stack);
  ui.open(isFinalSector ? 'campaignEnd' : 'victory', s);
}

export function showDefeat(ui: Screens, game: Game) {
  const sum = game.summary();
  const endless = sum.mode === 'endless';
  const rec = game.endlessRecord;
  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack');

  stack.appendChild(el('p', 'subtitle', endless
    ? tr('screens.defeat.subtitleEndless', 'run over')
    : tr('screens.defeat.subtitleSector', 'core breach')));
  const h = el('h2', undefined, endless
    ? tr('screens.defeat.titleEndless', 'Wave {wave}', { wave: sum.wave })
    : tr('screens.defeat.titleSector', 'The Line Broke'));
  h.style.color = endless && rec?.isRecord ? 'var(--relic)' : 'var(--danger)';
  stack.appendChild(h);

  if (endless) {
    if (rec?.isRecord) {
      const nb = el('p', 'flavor');
      nb.style.color = 'var(--relic)';
      nb.innerHTML = tr('screens.defeat.newRecord', '★ <strong>New personal best</strong> on {level}.',
        { level: levelName(sum.level) });
      stack.appendChild(nb);
    } else if (rec) {
      stack.appendChild(el('p', 'flavor',
        tr('screens.defeat.bestStill', 'Your best on {level} is still wave {best}.',
          { level: levelName(sum.level), best: rec.best })));
    }
  } else {
    stack.appendChild(el('p', 'flavor',
      tr('screens.defeat.coreWentDark',
        'The core went dark on wave {wave} of {total}. Achievement progress is kept — ' +
        'the bonuses you earned here make the next attempt easier.',
        { wave: sum.wave, total: sum.waves })));
  }
  if (game.progress.relics > 0) {
    const relic = el('p', 'flavor');
    relic.style.color = 'var(--relic)';
    relic.innerHTML = tr('screens.defeat.relicsBanked',
      '⬢ <strong>{relics} relics banked.</strong> ' +
      'The Armoury turns them into permanent upgrades — and the next map will be a different one.',
      { relics: game.progress.relics });
    stack.appendChild(relic);
  }

  const box = resultBox(game);
  if (box) stack.appendChild(box);

  const grid = el('div', 'stat-grid');
  const cells: [string, string][] = [
    [tr('screens.defeat.stats.reachedWave', 'Reached wave'), endless ? `${sum.wave}` : `${sum.wave} / ${sum.waves}`],
    [tr('screens.defeat.stats.kills', 'Kills'), fmtNum(sum.kills)],
    [tr('screens.defeat.stats.oreMined', 'Ore mined'), fmtNum(sum.ore)],
    [tr('screens.defeat.stats.structuresLost', 'Structures lost'), `${sum.lost}`],
    [tr('screens.defeat.stats.damageDealt', 'Damage dealt'), fmtNum(sum.damage)],
    [tr('screens.defeat.stats.time', 'Time'), fmtTime(sum.time)],
  ];
  for (const [k, v] of cells) {
    const c = el('div', 'cell');
    c.appendChild(el('div', 'label', k));
    c.appendChild(el('div', 'v accent', v));
    grid.appendChild(c);
  }
  stack.appendChild(grid);

  const col = el('div', 'menu-col');
  col.appendChild(ui.button(
    endless
      ? tr('screens.defeat.runAgain', 'Run it again')
      : game.mode === 'skirmish'
        ? tr('screens.defeat.retryBattle', 'Retry battle')
        : tr('screens.defeat.retrySector', 'Retry sector'),
    () => ui.cb.onRestart(),
  ));
  col.appendChild(ui.button(tr('screens.defeat.returnToTitle', 'Return to title'), () => ui.cb.onQuitToTitle(), 'btn ghost'));
  stack.appendChild(col);

  s.appendChild(stack);
  ui.open('defeat', s);
}
