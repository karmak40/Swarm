import { audio } from '../../core/audio';
import {
  LEVELS, levelName, levelSubtitle, levelBriefing, BIOME_IDS, biomeLabel, SKIRMISH_SIZES,
  skirmishSizeLabel, makeSkirmishLevel, ngDifficultyMult, type BiomeId, type SkirmishSize,
} from '../../data/levels';
import type { Progress } from '../../game/progress';
import { t as tr } from '../../core/i18n';
import type { Screens } from '../screens';
import { el } from '../dom';
import { MAX_MUTATORS, MUTATORS, heatMult, isMutatorUnlocked, totalHeat } from '../../data/mutators';
import { mutatorRow } from './daily';

/** Campaign level select, endless select and the custom-battle setup. */

export function showLevelSelect(ui: Screens, progress: Progress) {
  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack');
  stack.appendChild(el('h2', undefined, tr('screens.levelSelect.heading', 'Sector Select')));
  stack.appendChild(el('p', 'flavor',
    tr('screens.levelSelect.intro',
      `${progress.sectorsCleared} sector${progress.sectorsCleared === 1 ? '' : 's'} cleared. ` +
      'Clearing a sector permanently unlocks the next one, so you can pick up from there any time. ' +
      'The map is rolled fresh every deployment — starting a sector again is never the same fight.',
      { cleared: progress.sectorsCleared })));

  // New Game+: unlocked once the campaign has been cleared at least once, so
  // nobody sees a harder-than-expected sector before they know what "base"
  // difficulty even feels like.
  if (progress.data.highestLevel >= LEVELS.length - 1) {
    const st = progress.data.settings;
    const ngPanel = el('div', 'panel clip-corner');
    ngPanel.style.padding = '14px 20px';
    ngPanel.style.marginBottom = '18px';
    const mult = ngDifficultyMult(st.ngTier);
    ngPanel.appendChild(ui.stepper(
      tr('screens.levelSelect.ngTier', 'New Game+ tier — x{mult} enemies', { mult: mult.toFixed(2) }),
      st.ngTier, 1, 10,
      (v) => { st.ngTier = v; ui.cb.onSettingChange(); ui.showLevelSelect(progress); },
    ));
    stack.appendChild(ngPanel);
  }

  const row = el('div', 'card-row');
  LEVELS.forEach((lv, i) => {
    const locked = !progress.canPlayLevel(i);
    const card = el('div', 'tech-card');
    if (locked) card.style.opacity = '0.4';
    card.style.borderColor = `rgba(120,190,255,${locked ? 0.1 : 0.35})`;

    card.appendChild(el('div', 'rarity r-rare', levelSubtitle(lv)));
    card.appendChild(el('h3', undefined,
      tr('screens.levelSelect.cardTitle', '{index}. {name}', { index: i + 1, name: levelName(lv) })));
    const meta = el('p');
    meta.innerHTML = locked
      ? `<em>${tr('screens.levelSelect.lockedMeta', 'Locked — clear the previous sector.')}</em>`
      : tr('screens.levelSelect.meta', '{waves} waves · boss: <strong>{boss}</strong><br><br>{briefing}',
        { waves: lv.waves, boss: lv.boss.toUpperCase(), briefing: levelBriefing(lv) });
    card.appendChild(meta);

    const badge = el('div', 'rarity');
    if (i <= progress.data.highestLevel) {
      badge.textContent = tr('screens.levelSelect.cleared', '✔ CLEARED');
      badge.style.color = 'var(--good)';
    } else if (!locked) {
      badge.textContent = i === 0
        ? tr('screens.levelSelect.startHere', 'START HERE')
        : tr('screens.levelSelect.unlockedContinue', '▶ UNLOCKED — CONTINUE HERE');
      badge.style.color = 'var(--accent)';
    } else {
      badge.textContent = tr('screens.levelSelect.lockedBadge', '🔒 LOCKED');
    }
    card.appendChild(badge);

    if (!locked) {
      card.addEventListener('click', () => { audio.play('uiClick'); ui.cb.onStartLevel(i, true); });
      card.addEventListener('pointerenter', () => audio.play('uiHover'));
    } else {
      card.style.cursor = 'not-allowed';
    }
    row.appendChild(card);
  });
  stack.appendChild(row);
  stack.appendChild(ui.button(tr('screens.levelSelect.back', 'Back'), () => ui.showModes(progress), 'btn ghost'));
  s.appendChild(stack);
  ui.open('levelSelect', s, () => ui.showModes(progress));
}

export function showEndlessSelect(ui: Screens, progress: Progress) {
  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack');
  stack.appendChild(el('p', 'subtitle', tr('screens.endlessSelect.subtitle', 'no last wave')));
  stack.appendChild(el('h2', undefined, tr('screens.endlessSelect.heading', 'Endless')));
  stack.appendChild(el('p', 'flavor',
    tr('screens.endlessSelect.intro',
      'The hive never stops. Waves escalate forever and a boss arrives every tenth one. ' +
      'There is no victory here — only how far you get, and the relics you bring back.')));

  // Mutators: opt-in handicaps that pay out more score, XP and relics.
  const picked = progress.selectedMutators;
  const rank = progress.rank;
  stack.appendChild(el('p', 'label', tr('screens.endlessSelect.mutators', 'Mutators — risk for reward')));
  const mutList = el('div', 'mut-list grid');
  for (const m of MUTATORS) {
    const open = isMutatorUnlocked(m, rank);
    const row = mutatorRow(m.id, open
      ? tr('screens.endlessSelect.heatTag', '🔥 {heat}', { heat: m.heat })
      : tr('screens.endlessSelect.lockedTag', '🔒 rank {rank}', { rank: m.unlockRank }), open ? 'button' : 'div');
    if (!open) row.classList.add('locked');
    else {
      if (picked.includes(m.id)) row.classList.add('on');
      row.addEventListener('pointerenter', () => audio.play('uiHover'));
      row.addEventListener('click', () => {
        if (progress.toggleMutator(m.id)) {
          audio.play('uiClick');
          ui.showEndlessSelect(progress);
        } else {
          ui.toast('⚠', tr('screens.endlessSelect.limitTitle', 'Mutator limit'),
            tr('screens.endlessSelect.limitSub', 'Up to {n} mutators at once.', { n: MAX_MUTATORS }));
        }
      });
    }
    mutList.appendChild(row);
  }
  stack.appendChild(mutList);
  const heat = totalHeat(picked);
  stack.appendChild(el('p', 'flavor', heat > 0
    ? tr('screens.endlessSelect.heatTotal', 'Heat {heat} — score, XP and relics ×{mult}',
      { heat, mult: heatMult(picked).toFixed(1) })
    : tr('screens.endlessSelect.heatNone', 'No mutators — standard rules.')));

  const row = el('div', 'card-row');
  LEVELS.forEach((lv, i) => {
    if (!progress.canPlayLevel(i)) return;
    const best = progress.endlessBest(i);
    const card = el('div', 'tech-card');
    card.appendChild(el('div', 'rarity r-rare', levelSubtitle(lv)));
    card.appendChild(el('h3', undefined,
      tr('screens.endlessSelect.cardTitle', '{index}. {name}', { index: i + 1, name: levelName(lv) })));
    const meta = el('p');
    meta.innerHTML = tr('screens.endlessSelect.meta',
      '{gates} hive gates · {types} enemy types<br><br>Difficulty multiplier <strong>x{difficulty}</strong>',
      { gates: lv.spawnPoints, types: lv.roster.length, difficulty: lv.difficulty.toFixed(2) });
    card.appendChild(meta);
    const badge = el('div', 'rarity');
    badge.textContent = best > 0
      ? tr('screens.endlessSelect.best', 'BEST: WAVE {wave}', { wave: best })
      : tr('screens.endlessSelect.noRecord', 'NO RECORD YET');
    badge.style.color = best > 0 ? 'var(--relic)' : 'var(--ink-faint)';
    card.appendChild(badge);
    card.addEventListener('pointerenter', () => audio.play('uiHover'));
    card.addEventListener('click', () => { audio.play('uiClick'); ui.cb.onStartEndless(i, progress.selectedMutators); });
    row.appendChild(card);
  });
  stack.appendChild(row);
  stack.appendChild(ui.button(tr('screens.endlessSelect.back', 'Back'), () => ui.showModes(progress), 'btn ghost'));
  s.appendChild(stack);
  ui.open('endlessSelect', s, () => ui.showModes(progress));
}

export function showCustomBattle(ui: Screens, progress: Progress) {
  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack');
  stack.appendChild(el('p', 'subtitle', tr('screens.customBattle.subtitle', 'your rules')));
  stack.appendChild(el('h2', undefined, tr('screens.customBattle.heading', 'Custom Battle')));
  stack.appendChild(el('p', 'flavor',
    tr('screens.customBattle.intro',
      'Configure a one-off map — size, biome, difficulty, hive gates — and deploy with everything already ' +
      'unlocked. Nothing here touches campaign progress; it is a fight for its own sake.')));

  const cfg = ui.lastSkirmish;
  // Difficulty's label quotes the live multiplier, so any change re-renders
  // the whole screen rather than patching one control in place — simplest,
  // and matches how the language cycle and NG+ stepper already do ui.
  const rerender = () => ui.showCustomBattle(progress);

  const panel = el('div', 'panel clip-corner');
  panel.style.padding = '20px 26px';
  panel.style.width = 'min(480px, 90vw)';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.gap = '14px';

  const sizeLabels = Object.fromEntries(
    SKIRMISH_SIZES.map((sz): [SkirmishSize, string] => [sz, skirmishSizeLabel(sz).toUpperCase()]),
  ) as Record<SkirmishSize, string>;
  panel.appendChild(ui.cycle(
    tr('screens.customBattle.size', 'Map size'), cfg.size, SKIRMISH_SIZES, sizeLabels,
    (v) => { cfg.size = v; },
  ));

  const biomeLabels = Object.fromEntries(
    BIOME_IDS.map((b): [BiomeId, string] => [b, biomeLabel(b).toUpperCase()]),
  ) as Record<BiomeId, string>;
  panel.appendChild(ui.cycle(
    tr('screens.customBattle.biome', 'Biome'), cfg.biome, BIOME_IDS, biomeLabels,
    (v) => { cfg.biome = v; },
  ));

  panel.appendChild(ui.stepper(
    tr('screens.customBattle.difficulty', 'Difficulty tier — x{mult} enemies',
      { mult: ngDifficultyMult(cfg.difficultyTier).toFixed(2) }),
    cfg.difficultyTier, 1, 10,
    (v) => { cfg.difficultyTier = v; rerender(); },
  ));

  panel.appendChild(ui.stepper(
    tr('screens.customBattle.gates', 'Hive gates'), cfg.gates, 1, 6,
    (v) => { cfg.gates = v; },
  ));

  stack.appendChild(panel);

  const col = el('div', 'menu-col');
  col.appendChild(ui.button(tr('screens.customBattle.deploy', 'Deploy'), () => {
    ui.cb.onStartSkirmish(makeSkirmishLevel(cfg));
  }));
  col.appendChild(ui.button(tr('screens.customBattle.back', 'Back'), () => ui.showModes(progress), 'btn ghost'));
  stack.appendChild(col);

  s.appendChild(stack);
  ui.open('customBattle', s, () => ui.showModes(progress));
}
