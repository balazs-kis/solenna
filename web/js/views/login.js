import { append, h } from '../dom.js';
import { t } from '../i18n.js';
import { privacyButton, privacyDialog } from './privacy.js';

export const title = 'login.title';

// The server redirects back with `?auth_error=cancelled|failed`.
const errorMessages = {
  cancelled: 'login.cancelled',
  failed: 'login.failed',
};

export function render(container, state) {
  append(container,
    h(
      'div',
      { class: 'card login-card' },
      // Decorative: the heading right below names the app.
      h('img', { class: 'login-logo', src: '/icons/icon-192.png', alt: '', width: 96, height: 96 }),
      h('h1', { id: 'page-title', tabindex: '-1' }, t('app.name')),
      h('p', { class: 'muted' }, t('login.tagline')),
      state.accountDeleted && h('p', { role: 'status' }, t('login.accountDeleted')),
      state.consentDeclined && h('p', { role: 'status' }, t('login.declined')),
      state.authError &&
        h('p', { class: 'error', role: 'alert' }, t(errorMessages[state.authError] ?? 'login.failed')),
      // A plain link: the server handles /auth/* (the router leaves it alone).
      h('a', { class: 'button large', href: '/auth/google' }, t('login.google')),
      // Seen before signing up. Consent itself is asked for after signing in.
      h(
        'p',
        { class: 'muted login-terms' },
        t('login.terms'),
        ' ',
        privacyButton('login.privacy'),
      ),
    ),
    privacyDialog(state),
  );
}
