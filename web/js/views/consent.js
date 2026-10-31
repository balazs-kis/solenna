import { api } from '../api.js';
import { append, h } from '../dom.js';
import { t } from '../i18n.js';
import { getState, SIGNED_OUT, setState } from '../store.js';
import { legalDialog, legalLinks } from './legal.js';

export const title = 'consent.title';

// Shown after signing in, until the user has agreed (`state.user.consentedAt`
// is null): the server refuses every data route until then. Two checkboxes,
// both needed: accepting the terms (and being 16 or older), and explicit
// consent to storing health data, which the GDPR wants kept apart from
// anything else agreed to (Art. 7(2), 9(2)(a)). One request records both.
// Not agreeing deletes the sign-in. `state.consentUi`: terms, agreed (the
// checkboxes), error (i18n key).

const points = ['consent.pointPrivate', 'consent.pointIdentity', 'consent.pointControl', 'consent.pointAsIs'];

function ui() {
  return getState().consentUi ?? {};
}

function setUi(patch) {
  setState({ consentUi: { ...ui(), ...patch } });
}

export function render(container, state) {
  const view = state.consentUi ?? {};
  append(container,
    h(
      'div',
      { class: 'card consent-card' },
      h('h1', { id: 'page-title', tabindex: '-1' }, t('consent.title')),
      h('p', {}, t('consent.intro')),
      h('ul', { class: 'consent-points' }, points.map((key) => h('li', {}, t(key)))),
      legalLinks(),
      checkbox('consent-terms', 'consent.acceptTerms', 'terms', view),
      checkbox('consent-agree', 'consent.agree', 'agreed', view),
      view.error && h('p', { class: 'error', role: 'alert' }, t(view.error)),
      h(
        'div',
        { class: 'actions' },
        // Stays enabled without the tick (a disabled button can't be focused
        // or explain itself); pressing it then says what's missing.
        h(
          'button',
          { type: 'button', id: 'consent-continue', class: 'button', disabled: state.offline, onclick: agree },
          t('consent.continue'),
        ),
        h(
          'button',
          { type: 'button', id: 'consent-decline', class: 'button secondary', disabled: state.offline, onclick: decline },
          t('consent.decline'),
        ),
      ),
      h('p', { class: 'muted' }, t('consent.declineHint')),
    ),
    legalDialog(state),
  );
}

/** The whole box is the label, so it's one big touch target. `field` is its key in consentUi. */
function checkbox(id, label, field, view) {
  return h(
    'label',
    { class: 'consent-check' },
    h('input', {
      type: 'checkbox',
      id,
      checked: Boolean(view[field]),
      onchange: (event) => setUi({ [field]: event.target.checked, error: null }),
    }),
    h('span', {}, t(label)),
  );
}

async function agree() {
  const { terms, agreed } = ui();
  if (!terms || !agreed) {
    setUi({ error: 'consent.mustAgree' });
    document.getElementById(terms ? 'consent-agree' : 'consent-terms')?.focus();
    return;
  }
  try {
    const { consented_at } = await api('POST', '/api/me/consent');
    const user = getState().user;
    if (!user) return; // Signed out meanwhile.
    setState({ user: { ...user, consentedAt: consented_at }, consentUi: undefined });
  } catch (error) {
    if (error.status !== 401) setUi({ error: error.code === 'network' ? 'app.networkError' : 'consent.failed' });
  }
}

/** Not agreeing removes the sign-in (the server has nothing else of this user). */
async function decline() {
  try {
    await api('DELETE', '/api/me');
    setState({ ...SIGNED_OUT, consentDeclined: true });
  } catch (error) {
    if (error.status !== 401) {
      setUi({ error: error.code === 'network' ? 'app.noConnection' : 'consent.declineFailed' });
    }
  }
}
