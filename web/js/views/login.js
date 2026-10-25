import { h } from '../dom.js';
import { t } from '../i18n.js';

export const title = 'login.title';

// The server redirects back with `?auth_error=cancelled|failed`.
const errorMessages = {
  cancelled: 'login.cancelled',
  failed: 'login.failed',
};

export function render(container, state) {
  container.append(
    h(
      'div',
      { class: 'card login-card' },
      // Decorative: the heading right below names the app.
      h('img', { class: 'login-logo', src: '/icons/icon-192.png', alt: '', width: 96, height: 96 }),
      h('h1', { tabindex: '-1' }, t('app.name')),
      h('p', { class: 'muted' }, t('login.tagline')),
      state.authError &&
        h('p', { class: 'error', role: 'alert' }, t(errorMessages[state.authError] ?? 'login.failed')),
      // A plain link: the server handles /auth/* (the router leaves it alone).
      h('a', { class: 'button', href: '/auth/google' }, t('login.google')),
    ),
  );
}
