// A copy of the signed-in user's data on this device, so the app can show the
// last data it fetched when the server can't be reached (offline). It's only
// read in that case, and it's deleted whenever the user signs out (or the
// session ends), so the next person on a shared device never sees it.
const STORAGE_KEY = 'solenna-snapshot';

/** The per-user state keys worth keeping (see SIGNED_OUT in store.js). */
const KEYS = ['user', 'weights', 'periods'];

// What this page last wrote: undefined until the first write or delete, null
// once deleted.
let saved;

/** Called on every state change; writes only when one of the kept keys changed. */
export function updateSnapshot(state) {
  if (state.user === undefined) return; // Still loading.
  if (state.user === null) {
    if (saved !== null) clear();
    return;
  }
  if (saved && KEYS.every((key) => saved[key] === state[key])) return;
  saved = Object.fromEntries(KEYS.map((key) => [key, state[key]]));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage full or unavailable: there's just no offline copy.
  }
}

export function readSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? null;
  } catch {
    return null;
  }
}

function clear() {
  saved = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}
