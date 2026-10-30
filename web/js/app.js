import { api } from './api.js';
import { h } from './dom.js';
import { todayIso } from './format.js';
import { activate, browserLanguage, detectLanguage, saveLanguage, t } from './i18n.js';
import { startRouter } from './router.js';
import { missingFromSnapshot, readSnapshot, updateSnapshot } from './snapshot.js';
import { getState, setState, subscribe } from './store.js';
import { applyGlow, applyTheme, savedTheme } from './theme.js';
import * as account from './views/account.js';
import { avatar, displayName } from './views/avatar.js';
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
    applyGlow('neutral');
    root.replaceChildren(state.loadFailed ? renderLoadFailed(state) : '');
    return;
  }

  const signedIn = state.user !== null;
  if (!signedIn) loadedView = null;
  const view = signedIn ? (isAvailable(state.path, state.user) ? routes[state.path] : notFound) : login;
  document.title = `${t(view.title)} · ${t('app.name')}`;
  // A view's optional glow() picks the colour behind it.
  applyGlow(view.glow?.(state) ?? 'neutral');

  // Re-rendering replaces elements; keep keyboard focus on the same control,
  // and the position of anything scrolled inside the page (e.g. the weight
  // history on wide screens). Both need the element to have an id.
  const focusedId = document.activeElement?.id;
  const scrolled = [...root.querySelectorAll('[id]')]
    .filter((element) => element.scrollTop > 0)
    .map((element) => [element.id, element.scrollTop]);

  const main = h('main', { class: signedIn ? 'main' : 'main main-centered', id: 'main' });
  view.render(main, state);
  if (state.offline) main.prepend(renderOfflineBanner(state));
  announceOffline(state);
  root.replaceChildren(...(signedIn ? [renderNav(state), main] : [main]));
  // A view can render one modal dialog (`<dialog data-modal>`). It's rebuilt
  // with the page, so it's opened again each time; focus is restored below.
  root.querySelector('dialog[data-modal]')?.showModal();

  if (state.path !== renderedPath && renderedPath !== null) {
    // A new screen starts at the top, not at the old screen's scroll position.
    window.scrollTo(0, 0);
    // After navigating, move focus to the new page's heading (screen readers announce it).
    main.querySelector('h1')?.focus();
  } else {
    // Scroll first: focusing then scrolls the control into view if it needs to.
    for (const [id, top] of scrolled) {
      const element = document.getElementById(id);
      if (element) element.scrollTop = top;
    }
    if (focusedId) document.getElementById(focusedId)?.focus();
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
  const { primary, secondary } = displayName(state.user);
  return [
    avatar(state, 'small'),
    h('span', { class: 'nav-account-label' }, t(item.label)),
    h(
      'span',
      { class: 'nav-person' },
      h('span', { class: 'nav-person-name' }, primary),
      secondary && h('span', { class: 'nav-person-email' }, secondary),
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
      h('button', { type: 'button', class: 'button large', onclick: loadUser }, t('app.retry')),
    ),
  );
}

async function loadUser() {
  setState({ loadFailed: false });
  try {
    const me = await api('GET', '/api/me');
    // The server hands over the name, email and picture only right after
    // signing in (it doesn't store them); from then on this device's copy is
    // used, if it belongs to the same user.
    const kept = readSnapshot()?.user;
    const profile = me.profile ?? (kept?.id === me.id ? kept.profile : null);
    const user = { id: me.id, settings: me.settings, profile };
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

/**
 * Screens work out "today" when they render, and an installed app can stay
 * open for days. Re-render when the date has changed, so "Started today" or
 * the weight form never use yesterday's date. `state.today` only exists to
 * notice the change; views keep calling todayIso().
 */
function checkDate() {
  const today = todayIso();
  if (today !== getState().today) setState({ today });
}

/** Back online: fetch everything fresh, including the current screen's data. */
async function reconnect() {
  if (getState().reconnecting) return; // A retry is already running.
  loadedView = null;
  setState({ reconnecting: true });
  await loadUser();
  setState({ reconnecting: false });
}

/** What the offline banner says (and screen readers hear). Signed out, there's no data to talk about. */
function offlineMessage(state) {
  return t(state.user ? 'app.offline' : 'app.offlineSignIn');
}

const announcer = document.getElementById('announcer');
let announced = '';
let wasOffline = false;

/**
 * Screen readers hear the offline message once, when it changes, and "back
 * online" once when the connection returns. The visible banner is rebuilt on
 * every render, so it can't be the live region itself: that would announce
 * it again each time.
 */
function announceOffline(state) {
  if (state.offline) wasOffline = true;
  let text = '';
  if (state.offline) text = offlineMessage(state);
  else if (wasOffline) text = t('app.backOnline');
  if (text === announced) return;
  announced = text;
  announcer.textContent = text;
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
    h('p', {}, offlineMessage(state)),
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
  // A new version takes control right away (sw.js calls skipWaiting), but this
  // page keeps running the files it loaded: reload to get the new ones. The
  // first install also takes control of the page; that's no update. (After a
  // hard reload the page has no controller, but a worker is active: that's
  // not a first install, so its updates still reload.)
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker
    .getRegistration()
    .then((registration) => {
      if (registration?.active) hadController = true;
    })
    .catch(() => {});
  navigator.serviceWorker.register('/sw.js').catch(() => {});

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    updatePending = true;
    reloadIfUpdated();
  });
}

let updatePending = false;

/** Reloads into a new version, but not while the user is typing: then it waits for the next return to the app. */
function reloadIfUpdated() {
  if (updatePending && !document.activeElement?.matches('input, textarea, select')) location.reload();
}

/**
 * The browser only looks for a new sw.js when a page loads, and returning to
 * an installed app doesn't load one. One small request; a changed sw.js
 * installs the new version, which ends in 'controllerchange' above.
 */
function checkForUpdate() {
  navigator.serviceWorker
    ?.getRegistration()
    .then((registration) => registration?.update())
    .catch(() => {}); // Offline or unreachable: the next return tries again.
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
// Like a request that can't reach the server (see api()): show this device's
// copy of any data not loaded yet.
window.addEventListener('offline', () => setState({ offline: true, ...missingFromSnapshot(getState()) }));
window.addEventListener('online', reconnect);
// Also retry when the app comes back to the foreground: an unreachable server
// (rather than a lost connection) sends no 'online' event.
// Returning is also when a new date, or a new version, is noticed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  reloadIfUpdated();
  checkForUpdate();
  checkDate();
  if (getState().offline) reconnect();
});
// For a window that stays visible past midnight (e.g. a desktop tab).
setInterval(checkDate, 60_000);
setState({
  path: startRouter(),
  lang: detectLanguage(),
  theme: savedTheme(),
  offline: !navigator.onLine,
  today: todayIso(),
  authError,
});
loadUser();
registerServiceWorker();
