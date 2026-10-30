import { h } from '../dom.js';
import { t } from '../i18n.js';
import { HOME } from '../router.js';

export const title = 'notFound.title';

export function render(container) {
  container.append(
    h('h1', { tabindex: '-1' }, t('notFound.title')),
    // A button-sized link: a 44px touch target, like every other action.
    h('a', { class: 'button secondary', href: HOME }, t('notFound.back')),
  );
}
