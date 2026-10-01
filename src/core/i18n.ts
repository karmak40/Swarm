/**
 * String translation.
 *
 * Every user-facing string is authored in English inline at its call site and
 * passed through `t(key, english, vars?)`. English is never stored in a
 * dictionary — the inline string itself *is* the English translation — so
 * shipping a new language is just:
 *
 *   1. add `src/locales/xx.ts` exporting a flat `Record<string, string>` of
 *      `key -> translated text` (see `locales/ru.ts`);
 *   2. import it below and add one line to `DICTS` and `LOCALES`.
 *
 * A language doesn't need to cover every key on day one: anything missing
 * quietly falls back to the English string that was already there.
 */

import { ru } from '../locales/ru';
import { de } from '../locales/de';
import { es } from '../locales/es';
import { fr } from '../locales/fr';
import { pl } from '../locales/pl';

export type LocaleCode = 'en' | 'ru' | 'de' | 'es' | 'fr' | 'pl';

export interface LocaleInfo {
  code: LocaleCode;
  /** Name shown in its own language, e.g. 'Русский' — used in the picker itself. */
  label: string;
}

type Dict = Record<string, string>;

const DICTS: Record<LocaleCode, Dict> = {
  en: {},
  ru,
  de,
  es,
  fr,
  pl,
};

export const LOCALES: LocaleInfo[] = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'pl', label: 'Polski' },
  { code: 'ru', label: 'Русский' },
];

/**
 * Best-guess locale from the browser, used when settings.locale is 'auto'.
 *
 * Walks the user's language preferences in order (`navigator.languages` is
 * already sorted most- to least-preferred) and picks the first one we have a
 * locale for. Falls back to English when none of the user's languages are
 * among the ones registered in `LOCALES` — never a silent guess at some other
 * language the game doesn't actually support.
 */
export function detectLocale(): LocaleCode {
  const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  const supported = new Set(LOCALES.map((l) => l.code));
  for (const l of langs) {
    if (!l) continue;
    const short = l.slice(0, 2).toLowerCase() as LocaleCode;
    if (supported.has(short)) return short;
  }
  return 'en';
}

let current: LocaleCode = 'en';

export function getLocale(): LocaleCode {
  return current;
}

export function setLocale(code: LocaleCode) {
  current = code;
}

/**
 * Translate `english` via `key` for the active locale. `vars` fill
 * `{name}`-style placeholders in whichever string wins — the English fallback
 * included, so a not-yet-translated string still interpolates correctly.
 */
export function t(key: string, english: string, vars?: Record<string, string | number>): string {
  let s = DICTS[current][key] ?? english;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  }
  return s;
}
