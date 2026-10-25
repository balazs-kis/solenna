import { h } from './dom.js';
import { activate, detectLanguage, t } from './i18n.js';
import { startRouter } from './router.js';
import { setState, subscribe } from './store.js';
import * as cycle from './views/cycle.js';
import * as notFound from './views/not-found.js';
import * as settings from './views/settings.js';
import * as weight from './views/weight.js';

const routes = {
  '/weight': weight,
  '/cycle': cycle,
  '/settings': settings,
};

const navItems = [
  { path: '/weight', label: 'nav.weight', icon: 'weight' },
  { path: '/cycle', label: 'nav.cycle', icon: 'cycle' },
  { path: '/settings', label: 'nav.settings', icon: 'settings' },
];

const root = document.getElementById('app');
let renderedPath = null;

function render(state) {
  activate(state.lang);
  const view = routes[state.path] ?? notFound;
  document.title = `${t(view.title)} · ${t('app.name')}`;

  // Re-rendering replaces elements; keep keyboard focus on the same control.
  const focusedId = document.activeElement?.id;

  const main = h('main', { class: 'main', id: 'main' });
  view.render(main, state);
  root.replaceChildren(renderNav(state), main);

  if (state.path !== renderedPath && renderedPath !== null) {
    // After navigating, move focus to the new page's heading (screen readers announce it).
    main.querySelector('h1')?.focus();
  } else if (focusedId) {
    document.getElementById(focusedId)?.focus();
  }
  renderedPath = state.path;
}

function renderNav(state) {
  return h(
    'nav',
    { class: 'nav', 'aria-label': t('nav.label') },
    h('div', { class: 'nav-brand' }, t('app.name')),
    h(
      'ul',
      { class: 'nav-list' },
      navItems.map((item) =>
        h(
          'li',
          {},
          h(
            'a',
            {
              class: 'nav-link',
              href: item.path,
              'aria-current': state.path === item.path ? 'page' : false,
            },
            h('span', { class: `icon icon-${item.icon}`, 'aria-hidden': 'true' }),
            h('span', {}, t(item.label)),
          ),
        ),
      ),
    ),
  );
}

subscribe(render);
setState({ path: startRouter(), lang: detectLanguage() });
