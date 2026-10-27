import { api } from './api.js';
import { h } from './dom.js';
import { activate, browserLanguage, detectLanguage, saveLanguage, t } from './i18n.js';
import { startRouter } from './router.js';
import { setState, subscribe } from './store.js';
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
 * profile object when signed in.
 */
function render(state) {
  activate(state.lang);
  applyTheme(state.theme);

  if (state.user === undefined) {
    root.replaceChildren(state.loadFailed ? renderLoadFailed() : '');
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
  root.replaceChildren(...(signedIn ? [renderNav(state), main] : [main]));

  if (state.path !== renderedPath && renderedPath !== null) {
    // After navigating, move focus to the new page's heading (screen readers announce it).
    main.querySelector('h1')?.focus();
  } else if (focusedId) {
    document.getElementById(focusedId)?.focus();
  }
  renderedPath = state.path;

  // A view's optional load() fetches its data each time the view becomes
  // active. Last, because it calls setState, which renders again.
  if (signedIn && view !== loadedView) {
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

function renderLoadFailed() {
  return h(
    'main',
    { class: 'main main-centered' },
    h(
      'div',
      { class: 'card login-card' },
      h('p', { role: 'alert' }, t('app.loadFailed')),
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
    setState({ user, lang: language ?? browserLanguage() });
  } catch (error) {
    // A 401 already set user to null (login screen); anything else is a failure to load.
    if (error.status !== 401) setState({ loadFailed: true });
  }
}

/** Reads and removes `?auth_error=` (set by the server after a failed sign-in). */
function takeAuthError() {
  const error = new URLSearchParams(location.search).get('auth_error');
  if (error) history.replaceState(null, '', location.pathname);
  return error;
}

const authError = takeAuthError();
subscribe(render);
setState({ path: startRouter(), lang: detectLanguage(), theme: savedTheme(), authError });
loadUser();
