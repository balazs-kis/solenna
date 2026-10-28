// A copy of the signed-in user's data on this device, so the app can show the
// last data it fetched when the server can't be reached (offline). It also
// holds the user's Google profile (name, email, picture), which the server
// only hands over once, right after signing in. It's deleted whenever the user
// signs out (or the session ends), so the next person on a shared device
// never sees it.
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
  // Weigh-ins and periods only load when their screen is opened. Until then
  // they're undefined, and the stored copy (if it's this user's) still counts.
  const stored = saved ?? readSnapshot();
  const sameUser = stored?.user?.id === state.user.id;
  const next = Object.fromEntries(
    KEYS.map((key) => [key, state[key] === undefined && sameUser ? stored[key] : state[key]]),
  );
  if (saved && KEYS.every((key) => saved[key] === next[key])) return;
  saved = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage full or unavailable: there's just no offline copy.
  }
}

/**
 * The kept data the state doesn't have yet (screens not opened this session),
 * if the copy is this user's: for when the server becomes unreachable
 * mid-session, so every screen still shows its last data.
 */
export function missingFromSnapshot(state) {
  const stored = readSnapshot();
  if (!state.user || stored?.user?.id !== state.user.id) return {};
  const dataKeys = KEYS.filter((key) => key !== 'user');
  const missing = dataKeys.filter((key) => state[key] === undefined && stored[key] !== undefined);
  return Object.fromEntries(missing.map((key) => [key, stored[key]]));
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
