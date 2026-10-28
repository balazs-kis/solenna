/**
 * The single app state. Views read it; changes go through setState, which
 * notifies subscribers (the app re-renders).
 */
let state = {};
const listeners = new Set();

/**
 * State after signing out: the user and everything loaded for them is
 * dropped, so the next person on this device starts clean. Add each new kind
 * of user data here.
 */
export const SIGNED_OUT = {
  user: null,
  weights: undefined,
  weightUi: undefined,
  periods: undefined,
  cycleUi: undefined,
  accountUi: undefined,
  avatarFailed: undefined,
};

export function getState() {
  return state;
}

/**
 * Updates the state without re-rendering, for values the page already shows,
 * like text being typed: a later re-render then keeps them instead of resetting
 * the input. Everything else goes through setState.
 */
export function remember(patch) {
  state = { ...state, ...patch };
}

export function setState(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
