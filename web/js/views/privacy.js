import { h } from '../dom.js';
import { t } from '../i18n.js';
import { setState } from '../store.js';

// The privacy notice, as a dialog. It opens from the login screen, the consent
// screen and Account, so it shows signed out and before agreeing too. Each of
// them renders privacyButton() and privacyDialog(state); whether it's open is
// `state.privacyOpen`. Who runs the server comes from `state.about.contact`
// (SOLENNA_CONTACT).

const SOURCE_URL = 'https://github.com/balazs-kis/solenna';

// Each section: a heading, then its content: an i18n key is a paragraph, an
// array of keys a list.
const sections = [
  { heading: 'privacy.storedHeading', content: [['privacy.storedData', 'privacy.storedAccount', 'privacy.storedSessions']] },
  { heading: 'privacy.purposeHeading', content: ['privacy.purposeText'] },
  { heading: 'privacy.sharingHeading', content: ['privacy.sharingText', 'privacy.googleText'] },
  { heading: 'privacy.storageHeading', content: ['privacy.storageText', 'privacy.logsText', 'privacy.declineText'] },
  { heading: 'privacy.deviceHeading', content: ['privacy.deviceText', 'privacy.cookiesText'] },
  {
    heading: 'privacy.rightsHeading',
    content: [
      'privacy.rightsIntro',
      ['privacy.rightsAccess', 'privacy.rightsCorrect', 'privacy.rightsErase', 'privacy.rightsWithdraw'],
      'privacy.rightsContact',
    ],
  },
  { heading: 'privacy.disclaimerHeading', content: ['privacy.disclaimerText'] },
  { heading: 'privacy.changesHeading', content: ['privacy.changesText'] },
];

/** The link-styled button that opens the notice; `label` is its i18n key. One per screen. */
export function privacyButton(label) {
  return h('button', { type: 'button', id: 'privacy-open', class: 'inline-link', onclick: open }, t(label));
}

export function privacyDialog(state) {
  if (!state.privacyOpen) return null;
  const contact = state.about?.contact;
  return h(
    'dialog',
    {
      id: 'privacy-dialog',
      class: 'dialog',
      'data-modal': true,
      'aria-labelledby': 'privacy-title',
      // Escape: close through the state, like the buttons.
      oncancel: (event) => {
        event.preventDefault();
        close();
      },
    },
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'dialog-header' },
        h('h2', { id: 'privacy-title' }, t('privacy.title')),
        h(
          'button',
          { type: 'button', id: 'privacy-close', class: 'icon-button', 'aria-label': t('privacy.close'), onclick: close },
          h('span', { class: 'icon icon-close', 'aria-hidden': 'true' }),
        ),
      ),
      h(
        'div',
        { class: 'privacy' },
        h('p', {}, t('privacy.intro')),
        h(
          'section',
          {},
          h('h3', {}, t('privacy.controllerHeading')),
          h('p', {}, t('privacy.controllerText')),
          contact
            ? h('p', { class: 'privacy-contact' }, contact)
            : h('p', { class: 'muted' }, t('privacy.contactUnknown')),
        ),
        h(
          'section',
          {},
          h('h3', {}, t('privacy.openSourceHeading')),
          h('p', {}, t('privacy.openSourceText')),
          // A new tab: an installed app would otherwise leave itself for GitHub.
          h('p', {}, h('a', { href: SOURCE_URL, target: '_blank', rel: 'noopener' }, t('privacy.sourceLink'))),
        ),
        sections.map(({ heading, content }) =>
          h(
            'section',
            {},
            h('h3', {}, t(heading)),
            content.map((item) =>
              Array.isArray(item) ? h('ul', {}, item.map((key) => h('li', {}, t(key)))) : h('p', {}, t(item)),
            ),
          ),
        ),
        h('p', { class: 'muted' }, t('privacy.updated')),
      ),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', id: 'privacy-done', class: 'button', onclick: close }, t('privacy.close')),
      ),
    ),
  );
}

function open() {
  setState({ privacyOpen: true });
  // The dialog opens with the render; start at its top, not on the trigger behind it.
  document.getElementById('privacy-close')?.focus();
}

function close() {
  setState({ privacyOpen: false });
  document.getElementById('privacy-open')?.focus();
}
