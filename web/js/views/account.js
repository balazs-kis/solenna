import { api } from '../api.js';
import { h } from '../dom.js';
import { todayIso } from '../format.js';
import { browserLanguage, saveLanguage, t } from '../i18n.js';
import { getState, SIGNED_OUT, setState } from '../store.js';
import { saveTheme } from '../theme.js';
import { avatar, displayName } from './avatar.js';

export const title = 'account.title';

// The account's settings are `state.user.settings` (from /api/me); the theme is
// `state.theme` (this device only). `state.accountUi` holds this screen's UI
// state: saveFailed, logoutFailed, exportFailed, deleteFailed, confirmDelete.

// Language names are shown in their own language, so they're the same in every
// dictionary. 'device' is saved as null: follow the browser's language.
const languageOptions = [
  { code: 'device', label: 'account.languageDevice' },
  { code: 'en', label: 'language.en' },
  { code: 'hu', label: 'language.hu' },
];

const themeOptions = [
  { value: 'system', label: 'account.themeSystem' },
  { value: 'light', label: 'account.themeLight' },
  { value: 'dark', label: 'account.themeDark' },
];

function ui() {
  return getState().accountUi ?? {};
}

function setUi(patch) {
  setState({ accountUi: { ...ui(), ...patch } });
}

/**
 * Called whenever this screen becomes active: start without stale messages,
 * and fetch the server's release version (`state.appVersion`, not per-user).
 */
export async function load() {
  setState({ accountUi: {} });
  try {
    const { version } = await api('GET', '/api/health');
    setState({ appVersion: version });
  } catch {
    // Not shown, then; it's only informational.
  }
}

export function render(container, state) {
  const view = state.accountUi ?? {};
  const settings = state.user.settings;
  // Everything here saves to the server, except the theme.
  const offline = state.offline;

  container.append(
    h('h1', { tabindex: '-1' }, t('account.title')),
    h(
      'div',
      { class: 'stack' },
      renderProfile(state, view),
      view.saveFailed && h('p', { class: 'card error', role: 'alert' }, t('account.saveFailed')),
      h(
        'section',
        { class: 'card stack' },
        h('h2', {}, t('account.display')),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'language' }, t('account.language')),
          h(
            'select',
            { id: 'language', disabled: offline, onchange: (event) => changeLanguage(event.target.value) },
            languageOptions.map(({ code, label }) =>
              h('option', { value: code, selected: (settings.language ?? 'device') === code }, t(label)),
            ),
          ),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'theme' }, t('account.theme')),
          h(
            'select',
            { id: 'theme', 'aria-describedby': 'theme-hint', onchange: (event) => changeTheme(event.target.value) },
            themeOptions.map(({ value, label }) =>
              h('option', { value, selected: state.theme === value }, t(label)),
            ),
          ),
          h('p', { id: 'theme-hint', class: 'muted' }, t('account.themeHint')),
        ),
      ),
      h(
        'section',
        { class: 'card stack' },
        h('h2', {}, t('account.cycle')),
        toggle({
          id: 'track-cycle',
          label: t('account.trackCycle'),
          hint: t('account.trackCycleHint'),
          checked: settings.track_cycle,
          disabled: offline,
          onchange: (checked) => saveSettings({ track_cycle: checked }),
        }),
        settings.track_cycle &&
          toggle({
            id: 'show-fertility',
            label: t('account.showFertility'),
            hint: t('account.showFertilityHint'),
            checked: settings.show_fertility,
            disabled: offline,
            onchange: (checked) => saveSettings({ show_fertility: checked }),
          }),
      ),
      renderDataSection(view, offline),
      renderDeleteSection(view, offline),
      state.appVersion && h('p', { class: 'muted app-version' }, t('account.version', { version: state.appVersion })),
    ),
  );
}

/** Who is signed in (name and picture come from Google), and signing out. */
function renderProfile(state, view) {
  const { primary, secondary } = displayName(state.user);
  return h(
    'section',
    { class: 'card profile' },
    avatar(state, 'large'),
    h(
      'div',
      { class: 'profile-text' },
      h('p', { class: 'profile-name' }, primary),
      secondary && h('p', { class: 'muted' }, secondary),
    ),
    state.offline
      ? h(
          'button',
          { type: 'button', id: 'remove-local', class: 'button secondary', onclick: removeLocalData },
          t('account.removeLocal'),
        )
      : h('button', { type: 'button', id: 'logout', class: 'button secondary', onclick: logout }, t('account.logout')),
    state.offline && h('p', { class: 'muted profile-note' }, t('account.removeLocalHint')),
    view.logoutFailed && h('p', { class: 'error profile-note', role: 'alert' }, t('account.logoutFailed')),
  );
}

/** A checkbox with its label and a hint below; the label is the 44px touch target. */
function toggle({ id, label, hint, checked, disabled, onchange }) {
  return h(
    'div',
    { class: 'toggle' },
    h('input', {
      type: 'checkbox',
      id,
      checked,
      disabled,
      'aria-describedby': `${id}-hint`,
      onchange: (event) => onchange(event.target.checked),
    }),
    h('label', { for: id }, label),
    h('p', { id: `${id}-hint`, class: 'muted' }, hint),
  );
}

function renderDataSection(view, offline) {
  return h(
    'section',
    { class: 'card stack' },
    h('h2', {}, t('account.data')),
    h('p', { class: 'muted' }, t('account.exportText')),
    view.exportFailed && h('p', { class: 'error', role: 'alert' }, t('account.exportFailed')),
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        { type: 'button', id: 'export', class: 'button secondary', disabled: offline, onclick: exportData },
        t('account.export'),
      ),
    ),
  );
}

/** Kept apart at the very bottom, with a confirmation step. */
function renderDeleteSection(view, offline) {
  return h(
    'section',
    { class: 'card stack danger-zone' },
    h('h2', {}, t('account.deleteAccount')),
    h('p', { class: 'muted' }, t('account.deleteText')),
    view.deleteFailed && h('p', { class: 'error', role: 'alert' }, t('account.deleteFailed')),
    view.confirmDelete
      ? h(
          'div',
          { class: 'confirm' },
          h('span', {}, t('account.deleteConfirm')),
          h(
            'button',
            {
              type: 'button',
              id: 'confirm-delete-account',
              class: 'button danger small',
              disabled: offline,
              onclick: deleteAccount,
            },
            t('account.deleteConfirmButton'),
          ),
          h('button', { type: 'button', class: 'button secondary small', onclick: cancelDelete }, t('account.cancel')),
        )
      : h(
          'div',
          { class: 'actions' },
          h(
            'button',
            { type: 'button', id: 'delete-account', class: 'button danger', disabled: offline, onclick: askDelete },
            t('account.deleteAccount'),
          ),
        ),
  );
}

// --- Actions -----------------------------------------------------------------

/** Saves the account's settings with `patch` applied; on failure the screen shows the old values. */
// Saves run one after another, and each one is built from the settings the
// previous one stored. Otherwise two quick changes would each send the other's
// old value, and the slower request would undo the faster one.
let saving = Promise.resolve();

function saveSettings(patch) {
  saving = saving.then(() => sendSettings(patch));
}

async function sendSettings(patch) {
  const before = getState().user;
  if (!before) return; // Signed out while an earlier save was running.
  try {
    const settings = await api('PUT', '/api/me/settings', { ...before.settings, ...patch });
    const user = getState().user;
    if (!user) return;
    saveLanguage(settings.language);
    setState({
      user: { ...user, settings },
      lang: settings.language ?? browserLanguage(),
      accountUi: { ...ui(), saveFailed: false },
    });
  } catch (error) {
    if (error.status !== 401) setUi({ saveFailed: true });
  }
}

function changeLanguage(code) {
  saveSettings({ language: code === 'device' ? null : code });
}

function changeTheme(theme) {
  saveTheme(theme);
  setState({ theme });
}

/**
 * Only show the login screen once the server confirmed the session is gone.
 * Otherwise a reload would silently sign the user back in, which matters on a
 * shared device.
 */
async function logout() {
  try {
    await api('POST', '/auth/logout');
    setState(SIGNED_OUT);
  } catch {
    setUi({ logoutFailed: true });
  }
}

/**
 * Offline, signing out can't reach the server, so this only drops the user's
 * data from this device (the snapshot goes with SIGNED_OUT). The session
 * cookie stays, so the next time the server is reachable, the app opens the
 * account again; the hint says so.
 */
function removeLocalData() {
  setState(SIGNED_OUT);
}

/** Downloads everything the server stores about the user as a JSON file. */
async function exportData() {
  try {
    const data = await api('GET', '/api/me/export');
    // The server has no name, email or picture; add this device's copy.
    data.account = { ...getState().user.profile, ...data.account };
    const file = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    // Not attached to the page, so the router's link interception never sees the click.
    h('a', { href: url, download: `solenna-export-${todayIso()}.json` }).click();
    // Give the browser a moment to start the download before freeing the file.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setUi({ exportFailed: false });
  } catch (error) {
    if (error.status !== 401) setUi({ exportFailed: true });
  }
}

function askDelete() {
  setUi({ confirmDelete: true, deleteFailed: false });
  document.getElementById('confirm-delete-account')?.focus();
}

function cancelDelete() {
  setUi({ confirmDelete: false });
  document.getElementById('delete-account')?.focus();
}

async function deleteAccount() {
  try {
    await api('DELETE', '/api/me');
    setState({ ...SIGNED_OUT, accountDeleted: true });
  } catch (error) {
    if (error.status !== 401) setUi({ deleteFailed: true });
  }
}
