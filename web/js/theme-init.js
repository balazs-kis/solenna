// A classic (non-module) script in <head>, so it runs before the first paint:
// it applies the theme saved in Settings without a flash of the wrong theme.
// js/theme.js owns the setting; keep the storage key in sync.
try {
  const theme = localStorage.getItem('solenna-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage unavailable (private mode): follow the OS.
}
