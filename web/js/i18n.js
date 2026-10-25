import en from '../i18n/en.json' with { type: 'json' };
import hu from '../i18n/hu.json' with { type: 'json' };

const dictionaries = { en, hu };
export const languages = Object.keys(dictionaries);

const STORAGE_KEY = 'solenna-lang';
let active = 'en';

/** Looks up a key in the active language. `{name}` placeholders are filled from `params`. */
export function t(key, params = {}) {
  const text = dictionaries[active][key] ?? dictionaries.en[key];
  if (text === undefined) {
    console.warn(`missing translation: ${key}`);
    return key;
  }
  return text.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match);
}

export function activate(lang) {
  active = dictionaries[lang] ? lang : 'en';
  document.documentElement.lang = active;
}

export function locale() {
  return active;
}

/**
 * Saved choice, then the browser's languages, then English.
 * (The saved choice moves to the user's server-side settings in a later step.)
 */
export function detectLanguage() {
  const saved = readSaved();
  if (dictionaries[saved]) return saved;
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag?.split('-')[0];
    if (dictionaries[base]) return base;
  }
  return 'en';
}

export function saveLanguage(lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Storage can be unavailable (private mode); the choice just won't persist.
  }
}

function readSaved() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
