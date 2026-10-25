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
  );
}

function changeLanguage(lang) {
  saveLanguage(lang);
  setState({ lang });
}
