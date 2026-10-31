import { h } from '../dom.js';
import { t } from '../i18n.js';
import { setState } from '../store.js';

// The privacy notice and the terms of use. The app shows them as dialogs (from
// the login screen, the consent screen and Account, so they show signed out
// and before agreeing too): each of those renders legalLinks() and
// legalDialog(state), and which one is open is `state.legalOpen` ('privacy' or
// 'terms'). The server also serves them as pages of their own, /privacy and
// /terms (legal.html, js/legal-page.js), for links from outside the app.
// Both use legalDocument(), so the texts exist once, in the dictionaries.
// Who runs the server comes from `about.contact` (SOLENNA_CONTACT).

const SOURCE_URL = 'https://github.com/balazs-kis/solenna';

/** Who runs the server, or a note that it can't be loaded right now. */
function contactLine(contact) {
  return contact
    ? h('p', { class: 'legal-contact' }, contact)
    : h('p', { class: 'muted' }, t('legal.contactUnknown'));
}

function sourceLink() {
  // A new tab: an installed app would otherwise leave itself for GitHub.
  return h('p', {}, h('a', { href: SOURCE_URL, target: '_blank', rel: 'noopener' }, t('privacy.sourceLink')));
}

// Each document: its title, intro, sections and date. A section's content is
// a list of items: an i18n key is a paragraph, an array of keys a list, and a
// function builds its own element from the contact.
export const documents = {
  privacy: {
    path: '/privacy',
    title: 'legal.privacy',
    intro: 'privacy.intro',
    updated: 'privacy.updated',
    sections: [
      { heading: 'privacy.controllerHeading', content: ['privacy.controllerText', contactLine] },
      { heading: 'privacy.openSourceHeading', content: ['privacy.openSourceText', sourceLink] },
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
      { heading: 'privacy.changesHeading', content: ['privacy.changesText'] },
    ],
  },
  terms: {
    path: '/terms',
    title: 'legal.terms',
    intro: 'terms.intro',
    updated: 'terms.updated',
    sections: [
      { heading: 'terms.providerHeading', content: ['terms.providerText', contactLine] },
      { heading: 'terms.ageHeading', content: ['terms.ageText'] },
      { heading: 'terms.useHeading', content: ['terms.useText'] },
      { heading: 'terms.dataHeading', content: ['terms.dataText'] },
      { heading: 'terms.disclaimerHeading', content: ['terms.disclaimerText', 'terms.liabilityText'] },
      { heading: 'terms.availabilityHeading', content: ['terms.availabilityText', 'terms.endingText'] },
      { heading: 'terms.lawHeading', content: ['terms.lawText'] },
      { heading: 'terms.changesHeading', content: ['terms.changesText'] },
    ],
  },
};

/** A document's text: the intro, the sections and the date (without the title). */
export function legalDocument(name, contact) {
  const { intro, sections, updated } = documents[name];
  return h(
    'div',
    { class: 'legal' },
    h('p', {}, t(intro)),
    sections.map(({ heading, content }) =>
      h(
        'section',
        {},
        h('h3', {}, t(heading)),
        content.map((item) => {
          if (typeof item === 'function') return item(contact);
          if (Array.isArray(item)) return h('ul', {}, item.map((key) => h('li', {}, t(key))));
          return h('p', {}, t(item));
        }),
      ),
    ),
    h('p', { class: 'muted' }, t(updated)),
  );
}

/**
 * Links to both documents. A click opens the dialog; they're real links to the
 * pages all the same, so opening one in a new tab works too.
 */
export function legalLinks() {
  return h(
    'p',
    { class: 'legal-links' },
    Object.entries(documents).map(([name, { path, title }]) =>
      h(
        'a',
        {
          href: path,
          id: `${name}-open`,
          class: 'inline-link',
          onclick: (event) => {
            // Handled here, so the router leaves it alone.
            event.preventDefault();
            open(name);
          },
        },
        t(title),
      ),
    ),
  );
}

export function legalDialog(state) {
  const name = state.legalOpen;
  if (!documents[name]) return null;
  return h(
    'dialog',
    {
      id: 'legal-dialog',
      class: 'dialog',
      'data-modal': true,
      'aria-labelledby': 'legal-title',
      // Escape: close through the state, like the buttons.
      oncancel: (event) => {
        event.preventDefault();
        close(name);
      },
    },
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'dialog-header' },
        h('h2', { id: 'legal-title' }, t(documents[name].title)),
        h(
          'button',
          { type: 'button', id: 'legal-close', class: 'icon-button', 'aria-label': t('legal.close'), onclick: () => close(name) },
          h('span', { class: 'icon icon-close', 'aria-hidden': 'true' }),
        ),
      ),
      legalDocument(name, state.about?.contact),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', id: 'legal-done', class: 'button', onclick: () => close(name) }, t('legal.close')),
      ),
    ),
  );
}

function open(name) {
  setState({ legalOpen: name });
  // The dialog opens with the render; start at its top, not on the link behind it.
  document.getElementById('legal-close')?.focus();
}

function close(name) {
  setState({ legalOpen: undefined });
  document.getElementById(`${name}-open`)?.focus();
}
