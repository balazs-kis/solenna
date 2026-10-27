import { h } from '../dom.js';
import { locale } from '../i18n.js';
import { setState } from '../store.js';

/**
 * The user's picture (saved by the server at sign-in, served from our own
 * origin), or the first letter of their name in a circle. Decorative: the name
 * is always shown or spoken next to it. `state.avatarFailed` is set when the
 * picture can't load (e.g. offline), so the monogram shows instead.
 */
export function avatar(state, size) {
  const { user } = state;
  if (user.avatar && !state.avatarFailed) {
    return h('img', {
      class: `avatar avatar-${size}`,
      src: '/api/me/avatar',
      alt: '',
      onerror: () => setState({ avatarFailed: true }),
    });
  }
  return h('span', { class: `avatar avatar-${size} avatar-monogram`, 'aria-hidden': 'true' }, monogram(user));
}

/** The first character as the user sees it (so "Á" or an emoji stays whole), from the name or else the email. */
function monogram(user) {
  const source = (user.name || user.email).trim();
  const [first] = new Intl.Segmenter(locale(), { granularity: 'grapheme' }).segment(source);
  return first ? first.segment.toLocaleUpperCase(locale()) : '?';
}
