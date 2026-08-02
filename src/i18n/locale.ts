// Language status + t(): The original Chinese text is the key (no additional key namespace is created), if the en dictionary cannot be found, it will fall back to Chinese.
// Never go blank. Switch persistence localStorage('cc.locale'), subscription rerendering (useSyncExternalStore).
// Rules: Use useT() (subscription switching) in React components; pure helper modules can directly import { t }
//  — As long as the component that renders its output calls useT(), it will be recalculated when switching languages.
// LLM interface (systemPrompt/tool ​​description/skill content) and persistent dynamic history tags do not enter i18n.
import { useSyncExternalStore } from 'react';
import { EN } from './dict/en';
import EN_DATA from './dict/en/templates-data';
import { ZH_DATA } from './dict/zh';

export type Locale = 'zh' | 'en';

const STORAGE_KEY = 'cc.locale';

/** Browser UI language, when the user has never made an explicit choice.
 * Anything that isn't a Chinese locale gets English rather than falling into
 * Chinese, which is unreadable for non-Chinese users and hides the toggle. */
function browserLocale(): Locale {
  try {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const lang of langs) {
      if (!lang) continue;
      if (/^zh\b/i.test(lang)) return 'zh';
      return 'en';
    }
  } catch { /* no navigator (SSR / tests) — fall through */ }
  return 'en';
}

function readInitial(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch { /* storage blocked — fall back to the browser language */ }
  return browserLocale();
}

let current: Locale = readInitial();
const subscribers = new Set<() => void>();

// setLocale() only syncs <html lang> on change, so stamp the initial value too.
try {
  document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN';
} catch { /* no document (tests) */ }

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch { /* If the private mode cannot be saved, it will only affect this session */ }
  document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN';
  subscribers.forEach((notify) => notify());
}

/** t('Selected {n}', { n: 3 }) - The Chinese original text is the key; the placeholder {name} has the same name in both languages. */
export function t(zh: string, params?: Record<string, string | number>): string {
  const raw = current === 'en' ? (EN[zh] ?? zh) : zh;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));
}

/** Two-way data localization: **data** names (template names, etc.) are displayed according to the current language in the table lookup. If not found, they are returned as they are.
 * English key data (211 built-in items) zh state walking ZH_DATA; Chinese key data (self-made package) en state walking EN_DATA.
 * It is only used for display and does not change the data itself (the name is also a reference key). */
export function tData(text: string): string {
  return current === 'zh' ? (ZH_DATA[text] ?? text) : (EN_DATA[text] ?? text);
}

/** Get t in the component: subscribe to language switching, trigger rerendering of this component when switching. */
export function useT(): typeof t {
  useSyncExternalStore(
    (onChange) => {
      subscribers.add(onChange);
      return () => subscribers.delete(onChange);
    },
    () => current,
  );
  return t;
}
