// The privacy notice and the terms as pages of their own (/privacy, /terms;
// the server serves legal.html for both), for links from outside the app,
// such as Google's sign-in screen. Nobody needs to be signed in. The text is
// the same as in the app's dialogs (views/legal.js).
//
// Language: `?lang=` if it names one, else the one this device last used,
// else the browser's. The select at the top switches it in place.

import { h } from './dom.js';
import { activate, detectLanguage, languageNames, languages, t } from './i18n.js';
import { applyGlow, applyTheme, savedTheme } from './theme.js';
import { documents, legalDocument } from './views/legal.js';

const root = document.getElementById('app');
const name = location.pathname === '/terms' ? 'terms' : 'privacy';
const other = name === 'terms' ? 'privacy' : 'terms';
const requested = new URLSearchParams(location.search).get('lang');
let lang = languages.includes(requested) ? requested : detectLanguage();
let contact;

function render() {
  const doc = documents[name];
  document.title = `${t(doc.title)} · ${t('app.name')}`;
  root.replaceChildren(
    h(
      'main',
      { class: 'legal-page' },
      h(
        'a',
        { class: 'legal-brand', href: '/' },
        h('img', { src: '/icons/icon-192.png', alt: '', width: 40, height: 40 }),
        t('app.name'),
      ),
      h(
        'article',
        { class: 'card legal-card' },
        h(
          'div',
          { class: 'legal-card-header' },
          h('h1', {}, t(doc.title)),
          h(
            'span',
            { class: 'setting-select' },
            h(
              'select',
              { id: 'legal-language', 'aria-label': t('legal.language'), onchange: (event) => changeLanguage(event.target.value) },
              languages.map((code) => h('option', { value: code, selected: code === lang }, t(languageNames[code]))),
            ),
          ),
        ),
        legalDocument(name, contact),
      ),
      h(
        'p',
        { class: 'legal-links' },
        h('a', { href: `${documents[other].path}?lang=${lang}` }, t(documents[other].title)),
      ),
    ),
  );
}

/** Switches the page in place; the address keeps the choice, for sharing or reloading. */
function changeLanguage(code) {
  lang = code;
  history.replaceState(null, '', `${location.pathname}?lang=${code}`);
  activate(lang);
  render();
  document.getElementById('legal-language')?.focus();
}

activate(lang);
applyTheme(savedTheme());
applyGlow('neutral');

// Who runs the server, for the contact lines; rendered once it's known, so
// they don't flash "can't be loaded" first. Without it, they say that.
fetch('/api/about')
  .then((response) => (response.ok ? response.json() : null))
  .catch(() => null)
  .then((about) => {
    contact = about?.contact;
    render();
  });
