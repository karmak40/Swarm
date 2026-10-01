import { fmtNum } from '../../core/math';
import { LEVELS, levelName } from '../../data/levels';
import type { Progress } from '../../game/progress';
import { t as tr } from '../../core/i18n';
import type { Screens, ResumeInfo } from '../screens';
import { el } from '../dom';
import { rankStrip } from './commander';
import { dailyKey } from '../../data/daily';

/** Boot splash and the title screen. */

export function showBoot(ui: Screens) {
  const s = el('div', 'screen opaque');
  s.id = 'boot';
  s.appendChild(el('div', 'title', tr('screens.boot.title', 'SWARM')));
  s.appendChild(el('div', 'subtitle', tr('screens.boot.subtitle', 'hold the line')));
  const bar = el('div', 'bar');
  bar.appendChild(el('i'));
  s.appendChild(bar);
  s.appendChild(el('div', 'label', tr('screens.boot.compiling', 'compiling procedural systems')));
  ui.open('boot', s);
}

export function showTitle(ui: Screens, progress: Progress, resumable?: ResumeInfo | null) {
  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack title-stack');

  stack.appendChild(el('h1', 'title', tr('screens.title.title', 'SWARM')));
  stack.appendChild(el('p', 'subtitle', tr('screens.title.subtitle', 'hold the line')));
  // The pitch blurb is onboarding copy the player has already read, so it is
  // the one thing still dropped on short landscape phones. Progress pips and
  // the lifetime-stats grid move beside the menu instead — see `.title-stack`
  // in style.css — rather than leaving that width empty.
  stack.appendChild(el('p', 'flavor pitch',
    tr('screens.title.pitch',
      'One reactor core against an endless hive. Mine the seams, wall the approaches, and render the ' +
      'swarm down into something you can spend. Every wave is a countdown to the one that ends the sector.')));

  // Campaign progress readout, so a returning player can see at a glance that
  // their clears were saved and where they left off.
  const cleared = progress.sectorsCleared;
  const total = LEVELS.length;
  const done = cleared >= total;
  if (cleared > 0 || progress.data.stats.runs > 0) {
    const prog = el('div', 'campaign-progress');
    prog.style.display = 'flex';
    prog.style.flexDirection = 'column';
    prog.style.alignItems = 'center';
    prog.style.gap = '10px';

    if (cleared > 0) {
      const line = el('div', 'label', done
        ? tr('screens.title.campaignComplete', 'campaign complete · all sectors cleared')
        : tr('screens.title.campaignProgress',
          `campaign progress · ${cleared} sector${cleared === 1 ? '' : 's'} cleared`, { cleared }));
      line.style.color = done ? 'var(--relic)' : 'var(--good)';
      prog.appendChild(line);

      // One pip per sector: filled = cleared, ringed = next up, dim = locked.
      const pips = el('div', 'row');
      pips.style.gap = '7px';
      // Only up to the sector they can reach — the chain grows as they advance
      // rather than announcing how much content exists.
      const shown = Math.min(LEVELS.length, cleared + 1);
      LEVELS.slice(0, shown).forEach((lv, i) => {
        const pip = el('div');
        pip.style.width = '26px';
        pip.style.height = '5px';
        pip.style.background = i < cleared ? 'var(--good)' : 'var(--accent)';
        pip.style.boxShadow = i === cleared ? '0 0 10px var(--accent)' : 'none';
        pip.title = tr('screens.title.sectorPip', '{index}. {name}', { index: i + 1, name: levelName(lv) });
        pips.appendChild(pip);
      });
      prog.appendChild(pips);
    }
    if (progress.data.stats.runs > 0) prog.appendChild(rankStrip(ui, progress));
    stack.appendChild(prog);
  }

  const col = el('div', 'menu-col');

  if (resumable) {
    const label = resumable.endless
      ? tr('screens.title.resumeEndless', 'Resume endless · wave {wave}', { wave: resumable.wave })
      : tr('screens.title.resumeRun', 'Resume · {level}, wave {wave}',
        { level: resumable.levelName, wave: resumable.wave });
    const b = ui.button(label, () => ui.cb.onResumeRun());
    b.style.borderColor = 'rgba(92,242,160,0.55)';
    col.appendChild(b);
  }

  if (cleared > 0) {
    const next = Math.min(total - 1, progress.furthestUnlockedLevel);
    const nextName = levelName(LEVELS[next]);
    col.appendChild(ui.button(
      done
        ? tr('screens.title.replay', 'Replay · {index}. {name}', { index: next + 1, name: nextName })
        : tr('screens.title.continue', 'Continue · {index}. {name}', { index: next + 1, name: nextName }),
      () => ui.cb.onStartLevel(next, true),
    ));
    // Sector select, Endless, Daily and Custom battle live one tap further in.
    const dailyReady = !progress.dailyDone(dailyKey());
    col.appendChild(ui.button(
      dailyReady
        ? tr('screens.title.modesDaily', 'Game modes · daily ready')
        : tr('screens.title.modes', 'Game modes'),
      () => ui.showModes(progress), dailyReady ? 'btn' : 'btn ghost',
    ));
  } else {
    col.appendChild(ui.button(tr('screens.title.newCampaign', 'New campaign'), () => ui.cb.onStartLevel(0, true)));
  }
  col.appendChild(ui.button(
    progress.relics > 0
      ? tr('screens.title.progressRelics', 'Progress · {relics} ⬢', { relics: progress.relics })
      : tr('screens.title.progress', 'Progress'),
    () => ui.showProgress(progress), 'btn ghost',
  ));
  col.appendChild(ui.button(tr('screens.title.settings', 'Settings'), () => ui.showSettings(progress), 'btn ghost'));
  stack.appendChild(col);

  // Lifetime stats strip.
  const st = progress.data.stats;
  const grid = el('div', 'stat-grid title-stats');
  const cells: [string, string][] = [
    [tr('screens.title.stats.runs', 'Runs'), fmtNum(st.runs)],
    [tr('screens.title.stats.sectorsCleared', 'Sectors cleared'), fmtNum(st.victories)],
    [tr('screens.title.stats.totalKills', 'Total kills'), fmtNum(st.kills)],
    [tr('screens.title.stats.bossesFelled', 'Bosses felled'), fmtNum(st.bossKills)],
    [tr('screens.title.stats.oreMined', 'Ore mined'), fmtNum(st.oreMined)],
    [tr('screens.title.stats.bestWave', 'Best wave'), fmtNum(st.bestWave)],
  ];
  for (const [k, v] of cells) {
    const c = el('div', 'cell');
    c.appendChild(el('div', 'label', k));
    c.appendChild(el('div', 'v accent', v));
    grid.appendChild(c);
  }
  stack.appendChild(grid);

  s.appendChild(stack);
  s.appendChild(el('div', 'hint-bar',
    tr('screens.title.hintBar', 'WASD move · LMB fire · RMB mine · number keys build · SHIFT dash · G loadout · TAB stats · ESC pause')));
  ui.open('title', s);
}
