// The theme is a per-device preference, so it lives in localStorage, not in
// the account. js/theme-init.js applies it before the page renders.
const STORAGE_KEY = 'solenna-theme';

/** 'system' follows the OS setting; 'light' and 'dark' override it. */
export const themes = ['system', 'light', 'dark'];

export function savedTheme() {
  try {
    const theme = localStorage.getItem(STORAGE_KEY);
    return themes.includes(theme) ? theme : 'system';
  } catch {
    return 'system';
  }
}

/** Puts the theme on the page; the CSS reads `data-theme` on <html>. */
export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

export function saveTheme(theme) {
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode); the choice just won't persist.
  }
}
