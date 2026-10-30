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

let applied;

/** Puts the theme on the page; the CSS reads `data-theme` on <html>. */
export function applyTheme(theme) {
  if (theme === applied) return;
  applied = theme;
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  updateThemeColor();
}

let appliedGlow;

/**
 * The colour glow behind the screen ('neutral', 'rose', 'amber', 'teal' or
 * 'lilac'); the CSS reads `data-glow` on <html>. Each glow has its own base
 * colour, so the status bar follows it.
 */
export function applyGlow(glow) {
  if (glow === appliedGlow) return;
  appliedGlow = glow;
  document.documentElement.dataset.glow = glow;
  updateThemeColor();
}

/** The installed app's status bar takes the page's background colour. */
function updateThemeColor() {
  const color = getComputedStyle(document.body).backgroundColor;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

// "System" follows the OS, so the status bar has to follow it too.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeColor);

export function saveTheme(theme) {
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode); the choice just won't persist.
  }
}
