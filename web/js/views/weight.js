import { api } from '../api.js';
import { h } from '../dom.js';
import { addDays, formatDay, formatKg, todayIso } from '../format.js';
import { t } from '../i18n.js';
import { getState, remember, setState } from '../store.js';
import { weightTrend } from '../weight-trend.js';
import { hero } from './hero.js';
import { renderChart } from './weight-chart.js';

export const title = 'weight.title';

export function glow() {
  return 'rose';
}

const ranges = [
  { id: '30d', days: 30, label: 'weight.range30d' },
  { id: '90d', days: 90, label: 'weight.range90d' },
  { id: '1y', days: 365, label: 'weight.range1y' },
  { id: 'all', days: null, label: 'weight.rangeAll' },
];
const DEFAULT_RANGE = '90d';

// State: `state.weights` is the user's data (undefined until loaded, sorted by
// day). `state.weightUi` holds this screen's UI state:
//   range, edit ({ day, weight_g } being edited), draft ({ day, kg } as typed,
//   kept with remember() so re-renders don't reset the form; `day` is null
//   unless the user picked one, so the form keeps following today), error (i18n key
//   of the save error), confirmDelete (day), deleteError, loadFailed. `range`,
//   `edit` and `draft` survive leaving the screen.

function ui() {
  return getState().weightUi ?? {};
}

function setUi(patch) {
  setState({ weightUi: { ...ui(), ...patch } });
}

/**
 * Called by the app whenever this screen becomes active (and after
 * reconnecting). A half-typed entry stays.
 */
export async function load() {
  setUi({ loadFailed: false, error: null, confirmDelete: null, deleteError: false });
  const before = getState().weights;
  try {
    const weights = await api('GET', '/api/weights');
    // Signed out meanwhile, or a save changed the list after this request
    // started: this answer is stale.
    if (!getState().user || getState().weights !== before) return;
    // An entry being edited may have been deleted elsewhere.
    const edit = ui().edit;
    const editGone = edit && !weights.some((entry) => entry.day === edit.day);
    setState({ weights, ...(editGone && { weightUi: { ...ui(), edit: null } }) });
  } catch (error) {
    // No connection: the offline banner says so, and the screen keeps the data
    // it has. Reconnecting loads it again.
    if (error.status !== 401 && error.code !== 'network') setUi({ loadFailed: true });
  }
}

export function render(container, state) {
  container.append(h('h1', { id: 'page-title', tabindex: '-1' }, t('weight.title')));
  const view = state.weightUi ?? {};

  if (view.loadFailed) {
    container.append(
      h(
        'div',
        { class: 'card stack' },
        h('p', { class: 'error', role: 'alert' }, t('weight.loadFailed')),
        h('button', { type: 'button', class: 'button secondary', onclick: load }, t('app.retry')),
      ),
    );
    return;
  }
  if (!state.weights) {
    // Still loading (it's quick, so no spinner), or offline with nothing saved yet.
    if (state.offline) container.append(h('p', { class: 'card muted' }, t('app.offlineNoData')));
    return;
  }

  const range = ranges.find((r) => r.id === (view.range ?? DEFAULT_RANGE));
  const today = todayIso();
  const from = range.days ? addDays(today, -range.days) : (state.weights[0]?.day ?? today);
  const inRange = state.weights.filter((entry) => entry.day >= from);
  // From the whole history, so the line doesn't start from scratch at the range's edge.
  const trend = weightTrend(state.weights).filter((entry) => entry.day >= from);

  // Phone order: form, chart, history. On wide screens the chart moves to the
  // left column, the form and history stack on the right (see app.css).
  container.append(
    state.weights.length > 0 && renderHero(state.weights.at(-1), trend),
    h(
      'div',
      { class: 'columns weight-columns' },
      renderForm(view, state.offline),
      state.weights.length === 0
        ? h('p', { class: 'card muted weight-main' }, t('weight.empty'))
        : [renderChartCard(range, inRange, trend, from, today), renderHistory(inRange, view, state.offline)],
    ),
  );
}

function renderForm(view, offline) {
  const editing = view.edit;
  const values = {
    day: view.draft?.day ?? editing?.day ?? todayIso(),
    kg: view.draft?.kg ?? (editing ? (editing.weight_g / 1000).toFixed(1) : ''),
  };

  return h(
    'form',
    { class: 'card stack weight-form', onsubmit: save, oninput: keepDraft },
    h('h2', {}, t(editing ? 'weight.editTitle' : 'weight.addTitle')),
    h(
      'div',
      { class: 'form-row' },
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'weight-day' }, t('weight.date')),
        h('input', {
          id: 'weight-day',
          name: 'day',
          type: 'date',
          required: true,
          // Same bounds the server accepts (it also rejects years before 1900).
          min: '1900-01-01',
          max: todayIso(),
          value: values.day,
          // Editing changes the weight of a day; moving it to another day is delete + add.
          readonly: Boolean(editing),
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'weight-kg' }, t('weight.kg')),
        h('input', {
          id: 'weight-kg',
          name: 'kg',
          type: 'number',
          inputmode: 'decimal',
          step: '0.1',
          min: '20',
          max: '400',
          required: true,
          value: values.kg,
        }),
      ),
    ),
    view.error && h('p', { class: 'error', role: 'alert' }, t(view.error)),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'submit', class: 'button', disabled: offline }, t('weight.save')),
      editing &&
        h('button', { type: 'button', class: 'button secondary', onclick: cancelEdit }, t('weight.cancel')),
    ),
  );
}

/**
 * The latest weigh-in as it was measured, and the change over the range from
 * the trend: the difference of two single weigh-ins is as noisy as they are.
 * The change needs two trend points in the range; without them only the date shows.
 */
function renderHero(latest, trend) {
  const change = trend.length >= 2 ? trend.at(-1).weight_g - trend[0].weight_g : null;
  return hero({
    value: formatKg(latest.weight_g),
    unit: t('weight.unit'),
    line1:
      change !== null &&
      t('weight.changeOver', { change: t('weight.value', { value: formatKg(change, { signed: true }) }) }),
    line2: t('weight.latestOn', { date: formatDay(latest.day) }),
  });
}

function renderChartCard(range, inRange, trend, from, today) {
  return h(
    'section',
    { class: 'card stack weight-main' },
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': t('weight.rangeLabel') },
      ranges.map((r) =>
        h(
          'button',
          {
            type: 'button',
            id: `range-${r.id}`,
            'aria-pressed': String(r.id === range.id),
            onclick: () => setUi({ range: r.id }),
          },
          t(r.label),
        ),
      ),
    ),
    inRange.length === 0
      ? h('p', { class: 'muted' }, t('weight.emptyRange'))
      : renderChart(inRange, trend, from, today),
  );
}

function renderHistory(inRange, view, offline) {
  if (inRange.length === 0) return null;
  return h(
    'section',
    { class: 'card stack weight-history' },
    h('h2', { id: 'weight-history', tabindex: '-1' }, t('weight.history')),
    view.deleteError && h('p', { class: 'error', role: 'alert' }, t('weight.deleteFailed')),
    h(
      'ul',
      // The id keeps its scroll position across re-renders (see app.js).
      { id: 'weight-entries', class: 'entry-list' },
      [...inRange].reverse().map((entry) => renderEntry(entry, view, offline)),
    ),
  );
}

function renderEntry(entry, view, offline) {
  const date = formatDay(entry.day);
  const actions =
    view.confirmDelete === entry.day
      ? h(
          'div',
          { class: 'confirm' },
          h('span', { class: 'muted' }, t('weight.confirmDelete')),
          h(
            'button',
            {
              type: 'button',
              id: 'confirm-delete',
              class: 'button danger small',
              disabled: offline,
              onclick: () => remove(entry.day),
            },
            t('weight.delete'),
          ),
          h(
            'button',
            { type: 'button', class: 'button secondary small', onclick: () => cancelDelete(entry.day) },
            t('weight.cancel'),
          ),
        )
      : [
          h(
            'button',
            {
              type: 'button',
              class: 'link-button',
              'aria-label': t('weight.editLabel', { date }),
              onclick: () => startEdit(entry),
            },
            t('weight.edit'),
          ),
          h(
            'button',
            {
              type: 'button',
              id: `delete-${entry.day}`,
              class: 'link-button',
              disabled: offline,
              'aria-label': t('weight.deleteLabel', { date }),
              onclick: () => askDelete(entry.day),
            },
            t('weight.delete'),
          ),
        ];

  return h(
    'li',
    { class: 'entry' },
    h('span', { class: 'entry-date' }, date),
    h('span', { class: 'entry-value' }, t('weight.value', { value: formatKg(entry.weight_g) })),
    h('div', { class: 'entry-actions' }, actions),
  );
}

/**
 * The form's values as a draft. The day only counts if the user picked one:
 * an untouched date field shows today, and must keep doing so tomorrow.
 */
function draftOf(form) {
  const { day, kg } = form.elements;
  const picked = ui().edit || day.value !== todayIso();
  return { day: picked ? day.value : null, kg: kg.value };
}

/** Keeps the typed values in the state, without a re-render that would interrupt typing. */
function keepDraft(event) {
  remember({ weightUi: { ...ui(), draft: draftOf(event.currentTarget) } });
}

async function save(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const day = form.elements.day.value;
  const kg = form.elements.kg.value;
  const weight_g = Math.round(Number(kg) * 1000);

  try {
    const saved = await api('PUT', `/api/weights/${day}`, { weight_g });
    if (!getState().user) return; // Signed out meanwhile.
    const weights = getState()
      .weights.filter((entry) => entry.day !== saved.day)
      .concat(saved)
      .sort((a, b) => a.day.localeCompare(b.day));
    setState({ weights, weightUi: { ...ui(), edit: null, draft: null, error: null } });
    // Ready for the next entry; the submit button was replaced by the re-render.
    document.getElementById('weight-kg')?.focus();
  } catch (error) {
    if (error.status === 401 || !getState().user) return;
    // Keep what the user typed; the re-render would otherwise reset the form.
    // A 400 means the input itself was rejected, so "try again" wouldn't help.
    let message = 'weight.saveFailed';
    if (error.code === 'network') message = 'app.networkError';
    else if (error.status === 400) message = 'weight.invalid';
    setUi({ draft: draftOf(form), error: message });
  }
}

function startEdit(entry) {
  setUi({ edit: entry, draft: null, error: null, confirmDelete: null });
  document.getElementById('weight-kg')?.focus();
}

function cancelEdit() {
  setUi({ edit: null, draft: null, error: null });
  document.getElementById('weight-kg')?.focus();
}

function askDelete(day) {
  setUi({ confirmDelete: day, deleteError: false });
  document.getElementById('confirm-delete')?.focus();
}

function cancelDelete(day) {
  setUi({ confirmDelete: null });
  document.getElementById(`delete-${day}`)?.focus();
}

async function remove(day) {
  try {
    await api('DELETE', `/api/weights/${day}`);
  } catch (error) {
    // 404: already gone (e.g. deleted on another device), which is what we wanted.
    if (error.status !== 404) {
      if (error.status !== 401 && getState().user) setUi({ deleteError: true });
      return;
    }
  }
  if (!getState().user) return; // Signed out meanwhile.
  const weights = getState().weights.filter((entry) => entry.day !== day);
  const editingThis = ui().edit?.day === day;
  setState({
    weights,
    weightUi: { ...ui(), confirmDelete: null, deleteError: false, ...(editingThis && { edit: null }) },
  });
  // The deleted row (and its focused button) is gone; land on the list heading,
  // or the page heading if the list itself disappeared.
  (document.getElementById('weight-history') ?? document.querySelector('main h1'))?.focus();
}
