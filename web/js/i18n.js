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
 * Before the account is loaded: the language this device last used, then the
 * browser's languages, then English. Once signed in, the account's language
 * setting (if the user picked one) replaces it.
 */
export function detectLanguage() {
  const saved = readSaved();
  return dictionaries[saved] ? saved : browserLanguage();
}

/** The first of the browser's languages we have, else English. */
export function browserLanguage() {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag?.split('-')[0];
    if (dictionaries[base]) return base;
  }
  return 'en';
}

/** Remembers the account's language on this device; null (follow the browser) forgets it. */
export function saveLanguage(lang) {
  try {
    if (lang) localStorage.setItem(STORAGE_KEY, lang);
    else localStorage.removeItem(STORAGE_KEY);
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
