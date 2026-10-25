import { h } from '../dom.js';
import { t } from '../i18n.js';

export const title = 'cycle.title';

export function render(container) {
  container.append(
    h('h1', { tabindex: '-1' }, t('cycle.title')),
    h('p', { class: 'card empty' }, t('cycle.empty')),
  );
}
