import { api } from '../api.js';
import { h } from '../dom.js';
import { saveLanguage, t } from '../i18n.js';
import { setState } from '../store.js';

export const title = 'settings.title';

// Language names are shown in their own language, so they're the same in every dictionary.
const languageOptions = [
  { code: 'en', label: 'language.en' },
  { code: 'hu', label: 'language.hu' },
];

export function render(container, state) {
  container.append(
    h('h1', { tabindex: '-1' }, t('settings.title')),
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card field' },
        h('label', { for: 'language' }, t('settings.language')),
        h(
          'select',
          { id: 'language', onchange: (event) => changeLanguage(event.target.value) },
          languageOptions.map(({ code, label }) =>
            h('option', { value: code, selected: state.lang === code }, t(label)),
          ),
        ),
      ),
      h(
        'section',
        { class: 'card stack' },
        h('h2', {}, t('settings.account')),
        h('p', { class: 'muted' }, t('settings.signedInAs', { email: state.user.email })),
        state.logoutFailed && h('p', { class: 'error', role: 'alert' }, t('settings.logoutFailed')),
        h('button', { type: 'button', class: 'button secondary', onclick: logout }, t('settings.logout')),
      ),
    ),
  );
}

function changeLanguage(lang) {
  saveLanguage(lang);
  setState({ lang });
}

/**
 * Only show the login screen once the server confirmed the session is gone.
 * Otherwise a reload would silently sign the user back in, which matters on a
 * shared device.
 */
async function logout() {
  try {
    await api('POST', '/auth/logout');
    setState({ user: null, logoutFailed: false });
  } catch {
    setState({ logoutFailed: true });
  }
}
