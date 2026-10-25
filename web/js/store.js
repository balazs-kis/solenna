/**
 * The single app state. Views read it; changes go through setState, which
 * notifies subscribers (the app re-renders).
 */
let state = {};
const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
