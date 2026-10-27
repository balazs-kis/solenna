import { api } from './api.js';
import { h } from './dom.js';
import { activate, browserLanguage, detectLanguage, saveLanguage, t } from './i18n.js';
import { startRouter } from './router.js';
import { readSnapshot, updateSnapshot } from './snapshot.js';
import { getState, setState, subscribe } from './store.js';
import { applyTheme, savedTheme } from './theme.js';
import * as account from './views/account.js';
import { avatar } from './views/avatar.js';
import * as cycle from './views/cycle.js';
import * as login from './views/login.js';
import * as notFound from './views/not-found.js';
import * as weight from './views/weight.js';

const routes = {
  '/weight': weight,
  '/cycle': cycle,
  '/account': account,
};

// `feature` names the setting that turns a screen off.
const navItems = [
  { path: '/weight', label: 'nav.weight', icon: 'weight' },
  { path: '/cycle', label: 'nav.cycle', icon: 'cycle', feature: 'track_cycle' },
  // No icon: shown with the user's picture (renderAccountLink).
  { path: '/account', label: 'nav.account' },
];

const root = document.getElementById('app');
let renderedPath = null;
let loadedView = null;

/**
 * `state.user` is undefined while loading, null when signed out, and the
 * profile object when signed in. `state.offline` is true while the device is
 * offline or the server can't be reached; the app then shows the last data it
 * fetched and disables everything that saves.
 */
function render(state) {
  activate(state.lang);
  applyTheme(state.theme);

  if (state.user === undefined) {
    root.replaceChildren(state.loadFailed ? renderLoadFailed(state) : '');
    return;
  }

  const signedIn = state.user !== null;
  if (!signedIn) loadedView = null;
  const view = signedIn ? (isAvailable(state.path, state.user) ? routes[state.path] : notFound) : login;
  document.title = `${t(view.title)} · ${t('app.name')}`;

  // Re-rendering replaces elements; keep keyboard focus on the same control.
  const focusedId = document.activeElement?.id;

  const main = h('main', { class: signedIn ? 'main' : 'main main-centered', id: 'main' });
  view.render(main, state);
  if (state.offline) main.prepend(renderOfflineBanner(state));
  root.replaceChildren(...(signedIn ? [renderNav(state), main] : [main]));

  if (state.path !== renderedPath && renderedPath !== null) {
    // After navigating, move focus to the new page's heading (screen readers announce it).
    main.querySelector('h1')?.focus();
  } else if (focusedId) {
    document.getElementById(focusedId)?.focus();
  }
  renderedPath = state.path;

  // A view's optional load() fetches its data each time the view becomes
  // active (not while offline: the screen shows the data it already has).
  // Last, because it calls setState, which renders again.
  if (signedIn && view !== loadedView && !state.offline) {
    loadedView = view;
    view.load?.();
  }
}

/** A known screen whose feature (if any) the user has turned on. */
function isAvailable(path, user) {
  const item = navItems.find((i) => i.path === path);
  return Boolean(routes[path]) && (!item?.feature || user.settings[item.feature]);
}

function renderNav(state) {
  return h(
    'nav',
    { class: 'nav', 'aria-label': t('nav.label') },
    h(
      'div',
      { class: 'nav-brand' },
      h('img', { src: '/icons/icon-192.png', alt: '', width: 32, height: 32 }),
      t('app.name'),
    ),
    h(
      'ul',
      { class: 'nav-list' },
      navItems.filter((item) => isAvailable(item.path, state.user)).map((item) =>
        h(
          'li',
          {},
          h(
            'a',
            {
              class: item.icon ? 'nav-link' : 'nav-link nav-account',
              href: item.path,
              'aria-current': state.path === item.path ? 'page' : false,
            },
            item.icon
              ? [h('span', { class: `icon icon-${item.icon}`, 'aria-hidden': 'true' }), h('span', {}, t(item.label))]
              : renderAccountLink(state, item),
          ),
        ),
      ),
    ),
  );
}

/**
 * The account entry: the user's picture with "Account" under it on mobile; on
 * desktop it sits at the bottom of the sidebar with the name and email
 * ("Account" stays in the accessible name there too).
 */
function renderAccountLink(state, item) {
  const { name, email } = state.user;
  return [
    avatar(state, 'small'),
    h('span', { class: 'nav-account-label' }, t(item.label)),
    h(
      'span',
      { class: 'nav-person' },
      h('span', { class: 'nav-person-name' }, name || email),
      name && h('span', { class: 'nav-person-email' }, email),
    ),
  ];
}

function renderLoadFailed(state) {
  return h(
    'main',
    { class: 'main main-centered' },
    h(
      'div',
      { class: 'card login-card' },
      h('p', { role: 'alert' }, t(state.offline ? 'app.offlineNoData' : 'app.loadFailed')),
      h('button', { type: 'button', class: 'button', onclick: loadUser }, t('app.retry')),
    ),
  );
}

async function loadUser() {
  setState({ loadFailed: false });
  try {
    const user = await api('GET', '/api/me');
    // The account's language, or the browser's when the user chose "same as
    // device" (null). This device remembers it for the login screen.
    const language = user.settings.language;
    saveLanguage(language);
    setState({ user, lang: language ?? browserLanguage(), offline: false });
  } catch (error) {
    // A 401 already set user to null (login screen).
    if (error.status === 401) return;
    // The server can't be reached: show the last data this device fetched, if any.
    const snapshot = readSnapshot();
    setState(snapshot ? { ...snapshot, offline: true } : { loadFailed: true, offline: true });
  }
}

/** Back online: fetch everything fresh, including the current screen's data. */
async function reconnect() {
  if (getState().reconnecting) return; // A retry is already running.
  loadedView = null;
  setState({ reconnecting: true });
  await loadUser();
  setState({ reconnecting: false });
}

/**
 * The browser can't tell when our server is reachable again (its 'online'
 * event only means the device has a network), so the user can retry by hand.
 */
function renderOfflineBanner(state) {
  return h(
    'div',
    { class: 'offline-banner' },
    // Signed out (e.g. after removing the data offline), there's no data to talk about.
    h('p', { role: 'status' }, t(state.user ? 'app.offline' : 'app.offlineSignIn')),
    h(
      'button',
      // Stays enabled while retrying (a disabled button would lose focus); reconnect() ignores repeats.
      { type: 'button', id: 'offline-retry', class: 'button secondary small', onclick: reconnect },
      t(state.reconnecting ? 'app.retrying' : 'app.retry'),
    ),
  );
}

/**
 * Not on the usual dev hosts: `cargo run` serves web/ from disk, and a cached
 * shell would hide every edit. To test offline locally, use http://127.0.0.2:8080.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || ['localhost', '127.0.0.1'].includes(location.hostname)) return;
  // Without it the app still works online, so a failure needs no handling.
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/** Reads and removes `?auth_error=` (set by the server after a failed sign-in). */
function takeAuthError() {
  const error = new URLSearchParams(location.search).get('auth_error');
  if (error) history.replaceState(null, '', location.pathname);
  return error;
}

const authError = takeAuthError();
subscribe(render);
subscribe(updateSnapshot);
window.addEventListener('offline', () => setState({ offline: true }));
window.addEventListener('online', reconnect);
// Also retry when the app comes back to the foreground: an unreachable server
// (rather than a lost connection) sends no 'online' event.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && getState().offline) reconnect();
});
setState({
  path: startRouter(),
  lang: detectLanguage(),
  theme: savedTheme(),
  offline: !navigator.onLine,
  authError,
});
loadUser();
registerServiceWorker();
