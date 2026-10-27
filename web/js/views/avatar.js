import { h } from '../dom.js';
import { locale, t } from '../i18n.js';
import { setState } from '../store.js';

// `state.user.profile` ({ name, email, avatar }) is the Google profile this
// device received right after signing in; the server doesn't store it. It can
// be null (e.g. the server restarted before the browser picked it up), and
// then a generic "Google account" stands in until the next sign-in.

/**
 * The user's picture (a data: URL), or the first letter of their name in a
 * circle. Decorative: the name is always shown or spoken next to it.
 * `state.avatarFailed` is set if the picture can't be shown, so the monogram
 * shows instead.
 */
export function avatar(state, size) {
  const profile = state.user.profile;
  if (profile?.avatar && !state.avatarFailed) {
    return h('img', {
      class: `avatar avatar-${size}`,
      src: profile.avatar,
      alt: '',
      onerror: () => setState({ avatarFailed: true }),
    });
  }
  return h('span', { class: `avatar avatar-${size} avatar-monogram`, 'aria-hidden': 'true' }, monogram(profile));
}

/** The name to show, and the email under it (null when the name already is the email). */
export function displayName(user) {
  const { name, email } = user.profile ?? {};
  if (name) return { primary: name, secondary: email || null };
  return { primary: email || t('account.googleAccount'), secondary: null };
}

/** The first character as the user sees it (so "Á" or an emoji stays whole), from the name or else the email. */
function monogram(profile) {
  const source = (profile?.name || profile?.email || '').trim();
  const [first] = new Intl.Segmenter(locale(), { granularity: 'grapheme' }).segment(source);
  return first ? first.segment.toLocaleUpperCase(locale()) : '?';
}
