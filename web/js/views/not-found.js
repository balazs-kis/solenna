import { h } from '../dom.js';
import { t } from '../i18n.js';
import { HOME } from '../router.js';

export const title = 'notFound.title';

export function render(container) {
  container.append(
    h('h1', { tabindex: '-1' }, t('notFound.title')),
    h('p', {}, h('a', { href: HOME }, t('notFound.back'))),
  );
}
