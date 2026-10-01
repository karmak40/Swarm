import { audio } from '../../core/audio';
import { fmtNum } from '../../core/math';
import { ACHIEVEMENTS, TIER_COLOR, achievementName, achievementDesc } from '../../data/achievements';
import { describePerk } from '../../data/perks';
import type { Progress } from '../../game/progress';
import { detectLocale, setLocale, LOCALES, type LocaleCode, t as tr } from '../../core/i18n';
import type { Screens } from '../screens';
import { el } from '../dom';

/** Achievement gallery and the settings screen. */

/** `onBack` defaults to the title screen; the pause menu passes its own way back. */
export function showAchievements(ui: Screens, progress: Progress, onBack: () => void = () => ui.showProgress(progress)) {
  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack');
  stack.appendChild(el('h2', undefined, tr('screens.achievements.heading', 'Achievements')));
  stack.appendChild(el('p', 'flavor',
    tr('screens.achievements.intro',
      '{unlocked} of {total} unlocked. Every unlock grants a permanent ' +
      'bonus applied at the start of every run — they stack.',
      { unlocked: progress.unlockedCount, total: progress.totalCount })));

  const wrap = el('div', 'ach-wrap');
  const grid = el('div', 'ach-grid');

  const sorted = [...ACHIEVEMENTS].sort((a, b) => {
    const ua = progress.isUnlocked(a.id) ? 0 : 1;
    const ub = progress.isUnlocked(b.id) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    return a.goal - b.goal;
  });

  for (const a of sorted) {
    const unlocked = progress.isUnlocked(a.id);
    const prog = progress.progressOf(a);
    const hidden = a.secret && !unlocked;

    const row = el('div', `ach ${unlocked ? 'unlocked' : 'locked'}`);
    row.appendChild(el('div', 'icon', hidden ? '❔' : a.icon));

    const body = el('div');
    body.style.flex = '1';
    const name = el('div', 'name', hidden ? tr('screens.achievements.hiddenName', 'Hidden Achievement') : achievementName(a));
    name.style.color = TIER_COLOR[a.tier];
    body.appendChild(name);
    body.appendChild(el('div', 'desc',
      hidden ? tr('screens.achievements.hiddenDesc', 'Discover it in the field.') : achievementDesc(a)));
    body.appendChild(el('div', 'perk', tr('screens.achievements.perkPrefix', '⬆ {perk}', { perk: describePerk(a.perk) })));

    if (!unlocked && !hidden && a.goal > 1) {
      const bar = el('div', 'bar');
      const i = el('i');
      i.style.width = `${Math.min(100, (prog / a.goal) * 100)}%`;
      bar.appendChild(i);
      body.appendChild(bar);
      const t = el('div', 'desc',
        tr('screens.achievements.progress', '{prog} / {goal}', { prog: fmtNum(prog), goal: fmtNum(a.goal) }));
      t.style.fontSize = '10px';
      body.appendChild(t);
    }
    row.appendChild(body);
    grid.appendChild(row);
  }

  wrap.appendChild(grid);
  stack.appendChild(wrap);
  stack.appendChild(ui.button(tr('screens.achievements.back', 'Back'), onBack, 'btn ghost'));
  s.appendChild(stack);
  ui.open('achievements', s, onBack);
}

/**
 * `onBack` defaults to the title screen. Opened from the pause menu it
 * returns there — it used to go to the title even mid-run.
 */
export function showSettings(ui: Screens, progress: Progress, onBack: () => void = () => ui.showTitle(progress)) {
  const s = el('div', 'screen opaque');
  const stack = el('div', 'stack');
  stack.appendChild(el('h2', undefined, tr('screens.settings.heading', 'Settings')));

  const panel = el('div', 'panel clip-corner');
  panel.style.padding = '26px 30px';
  panel.style.width = 'min(520px, 90vw)';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.gap = '18px';
  // The row count (and each label's wrapped height) varies by language and
  // viewport, so cap the panel and let it scroll rather than pushing the
  // Back/Wipe-save row off the bottom of a short screen. Reserving a fixed
  // budget for the heading + button row (instead of a flat vh%) means a
  // roomy window still shows the whole panel with no scrollbar at all.
  panel.style.maxHeight = 'calc(100vh - 220px)';
  panel.style.overflowY = 'auto';

  const st = progress.data.settings;

  const slider = (label: string, value: number, min: number, max: number, step: number,
                  onInput: (v: number) => void) => {
    const wrap = el('div');
    const head = el('div', 'row');
    head.style.justifyContent = 'space-between';
    head.appendChild(el('div', 'label', label));
    const out = el('div', 'label', String(Math.round(value * 100) / 100));
    out.style.color = 'var(--accent)';
    head.appendChild(out);
    wrap.appendChild(head);
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.style.width = '100%';
    input.style.accentColor = '#46d8ff';
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      out.textContent = String(Math.round(v * 100) / 100);
      onInput(v);
      ui.cb.onSettingChange();
    });
    wrap.appendChild(input);
    return wrap;
  };

  const toggle = (label: string, value: boolean, onChange: (v: boolean) => void) => {
    const row = el('div', 'row');
    row.style.justifyContent = 'space-between';
    row.appendChild(el('div', 'label', label));
    const b = el('button', 'btn ghost', value ? tr('screens.settings.on', 'ON') : tr('screens.settings.off', 'OFF'));
    b.style.padding = '6px 20px';
    b.addEventListener('click', () => {
      value = !value;
      b.textContent = value ? tr('screens.settings.on', 'ON') : tr('screens.settings.off', 'OFF');
      onChange(value);
      audio.play('uiClick');
      ui.cb.onSettingChange();
    });
    row.appendChild(b);
    return row;
  };

  const localeOptions = LOCALES.map((l) => l.code);
  const localeLabels = Object.fromEntries(
    [['auto', tr('screens.settings.auto', 'AUTO')] as const,
      ...LOCALES.map((l): [LocaleCode, string] => [l.code, l.label.toUpperCase()])],
  ) as Record<'auto' | LocaleCode, string>;
  panel.appendChild(ui.cycle(
    tr('screens.settings.language', 'Language'), st.locale, ['auto', ...localeOptions] as const, localeLabels,
    (v) => {
      st.locale = v;
      setLocale(v === 'auto' ? detectLocale() : v);
      ui.cb.onSettingChange();
      // Every label on this very screen needs to redraw in the new language.
      ui.showSettings(progress, onBack);
    },
  ));

  panel.appendChild(slider(tr('screens.settings.effectsVolume', 'Effects volume'), st.sfx, 0, 1, 0.05,
    (v) => { st.sfx = v; audio.setVolume('sfx', v); }));
  panel.appendChild(slider(tr('screens.settings.musicVolume', 'Music volume'), st.music, 0, 1, 0.05,
    (v) => { st.music = v; audio.setVolume('music', v); }));
  panel.appendChild(slider(tr('screens.settings.interfaceVolume', 'Interface volume'), st.ui, 0, 1, 0.05,
    (v) => { st.ui = v; audio.setVolume('ui', v); }));
  panel.appendChild(slider(tr('screens.settings.screenShake', 'Screen shake'), st.screenShake, 0, 1.5, 0.1,
    (v) => { st.screenShake = v; }));
  panel.appendChild(toggle(tr('screens.settings.muteAll', 'Mute all'), st.muted, (v) => { st.muted = v; audio.setMuted(v); }));
  panel.appendChild(toggle(tr('screens.settings.bloom', 'Bloom'), st.bloom, (v) => { st.bloom = v; }));
  panel.appendChild(toggle(tr('screens.settings.flashes', 'Screen flashes'), st.flashes, (v) => { st.flashes = v; }));
  panel.appendChild(toggle(tr('screens.settings.damageNumbers', 'Damage numbers'), st.showDamageNumbers,
    (v) => { st.showDamageNumbers = v; }));

  // --- controls & performance ---
  const divider = el('div');
  divider.style.borderTop = '1px solid var(--line)';
  divider.style.margin = '4px 0';
  panel.appendChild(divider);
  panel.appendChild(el('div', 'label', tr('screens.settings.controlsPerformance', 'controls & performance')));

  panel.appendChild(ui.cycle(
    tr('screens.settings.controlScheme', 'Control scheme'), st.controls, ['auto', 'touch', 'desktop'] as const,
    {
      auto: tr('screens.settings.auto', 'AUTO'),
      touch: tr('screens.settings.controlSchemeTouch', 'TOUCH'),
      desktop: tr('screens.settings.controlSchemeDesktop', 'MOUSE + KEYS'),
    },
    (v) => { st.controls = v; ui.cb.onSettingChange(); },
  ));
  panel.appendChild(ui.cycle(
    tr('screens.settings.renderQuality', 'Render quality'), st.quality, ['auto', 'low', 'medium', 'high'] as const,
    {
      auto: tr('screens.settings.auto', 'AUTO'),
      low: tr('screens.settings.qualityLow', 'LOW'),
      medium: tr('screens.settings.qualityMedium', 'MEDIUM'),
      high: tr('screens.settings.qualityHigh', 'HIGH'),
    },
    (v) => { st.quality = v; ui.cb.onSettingChange(); },
  ));
  panel.appendChild(slider(tr('screens.settings.uiScale', 'Interface scale'), st.uiScale, 0.8, 1.6, 0.1,
    (v) => { st.uiScale = v; }));
  // Both assists are forced on under touch controls; the toggles matter on desktop.
  panel.appendChild(toggle(tr('screens.settings.autoAim', 'Auto-aim (always on for touch)'), st.autoAim,
    (v) => { st.autoAim = v; }));
  panel.appendChild(toggle(tr('screens.settings.autoMine', 'Auto-mine'), st.autoMine,
    (v) => { st.autoMine = v; }));
  panel.appendChild(toggle(tr('screens.settings.southpaw', 'Left-handed layout'), st.southpaw, (v) => { st.southpaw = v; }));
  panel.appendChild(toggle(tr('screens.settings.haptics', 'Vibration'), st.haptics, (v) => { st.haptics = v; }));

  stack.appendChild(panel);

  const row = el('div', 'row');
  row.appendChild(ui.button(tr('screens.settings.back', 'Back'), onBack, 'btn ghost'));
  row.appendChild(ui.button(tr('screens.settings.wipeSave', 'Wipe save'), () => {
    ui.confirmDialog(tr('screens.settings.wipeSaveConfirm',
      'Erase all achievements, unlocks and lifetime stats? This cannot be undone.'), () => {
      localStorage.removeItem('swarm.save.v1');
      location.reload();
    }, tr('screens.settings.wipeSave', 'Wipe save'));
  }, 'btn danger'));
  stack.appendChild(row);

  s.appendChild(stack);
  ui.open('settings', s, onBack);
}
