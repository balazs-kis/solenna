import { api } from '../api.js';
import { h } from '../dom.js';
import { addDays, formatDay, formatKg, todayIso } from '../format.js';
import { t } from '../i18n.js';
import { getState, setState } from '../store.js';
import { renderChart } from './weight-chart.js';

export const title = 'weight.title';

const ranges = [
  { id: '30d', days: 30, label: 'weight.range30d' },
  { id: '90d', days: 90, label: 'weight.range90d' },
  { id: '1y', days: 365, label: 'weight.range1y' },
  { id: 'all', days: null, label: 'weight.rangeAll' },
];
const DEFAULT_RANGE = '90d';

// State: `state.weights` is the user's data (undefined until loaded, sorted by
// day). `state.weightUi` holds this screen's UI state:
//   range, edit ({ day, weight_g } being edited), draft (form values kept after
//   a failed save), error (i18n key of the save error), confirmDelete (day),
//   deleteError, loadFailed. Only `range` survives leaving the screen.

function ui() {
  return getState().weightUi ?? {};
}

function setUi(patch) {
  setState({ weightUi: { ...ui(), ...patch } });
}

/** Called by the app whenever this screen becomes active. */
export async function load() {
  setUi({
    loadFailed: false,
    edit: null,
    draft: null,
    error: null,
    confirmDelete: null,
    deleteError: false,
  });
  try {
    setState({ weights: await api('GET', '/api/weights') });
  } catch (error) {
    if (error.status !== 401) setUi({ loadFailed: true });
  }
}

export function render(container, state) {
  container.append(h('h1', { tabindex: '-1' }, t('weight.title')));
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

  container.append(
    h(
      'div',
      { class: 'stack' },
      renderForm(view),
      state.weights.length === 0
        ? h('p', { class: 'card empty' }, t('weight.empty'))
        : [
            renderSummary(state.weights.at(-1), inRange),
            renderChartCard(range, inRange, from, today),
            renderHistory(inRange, view),
          ],
    ),
  );
}

function renderForm(view) {
  const editing = view.edit;
  const values = view.draft ?? {
    day: editing?.day ?? todayIso(),
    kg: editing ? (editing.weight_g / 1000).toFixed(1) : '',
  };

  return h(
    'form',
    { class: 'card stack', onsubmit: save },
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
      h('button', { type: 'submit', class: 'button', disabled: getState().offline }, t('weight.save')),
      editing &&
        h('button', { type: 'button', class: 'button secondary', onclick: cancelEdit }, t('weight.cancel')),
    ),
  );
}

function renderSummary(latest, inRange) {
  const change = inRange.length >= 2 ? inRange.at(-1).weight_g - inRange[0].weight_g : null;
  return h(
    'div',
    { class: 'card summary' },
    h('span', { class: 'muted' }, t('weight.latest')),
    h('span', { class: 'summary-value' }, t('weight.value', { value: formatKg(latest.weight_g) })),
    h('span', { class: 'muted' }, formatDay(latest.day)),
    change !== null &&
      h(
        'span',
        { class: 'muted' },
        t('weight.changeOver', {
          change: t('weight.value', { value: formatKg(change, { signed: true }) }),
        }),
      ),
  );
}

function renderChartCard(range, inRange, from, today) {
  return h(
    'section',
    { class: 'card stack' },
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
      : renderChart(inRange, from, today),
  );
}

function renderHistory(inRange, view) {
  if (inRange.length === 0) return null;
  return h(
    'section',
    { class: 'card stack' },
    h('h2', { id: 'weight-history', tabindex: '-1' }, t('weight.history')),
    view.deleteError && h('p', { class: 'error', role: 'alert' }, t('weight.deleteFailed')),
    h(
      'ul',
      { class: 'entry-list' },
      [...inRange].reverse().map((entry) => renderEntry(entry, view)),
    ),
  );
}

function renderEntry(entry, view) {
  const date = formatDay(entry.day);
  const actions =
    view.confirmDelete === entry.day
      ? [
          h('span', { class: 'muted' }, t('weight.confirmDelete')),
          h(
            'button',
            {
              type: 'button',
              id: 'confirm-delete',
              class: 'button danger small',
              disabled: getState().offline,
              onclick: () => remove(entry.day),
            },
            t('weight.delete'),
          ),
          h(
            'button',
            { type: 'button', class: 'button secondary small', onclick: () => cancelDelete(entry.day) },
            t('weight.cancel'),
          ),
        ]
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
              disabled: getState().offline,
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

async function save(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const day = form.elements.day.value;
  const kg = form.elements.kg.value;
  const weight_g = Math.round(Number(kg) * 1000);

  try {
    const saved = await api('PUT', `/api/weights/${day}`, { weight_g });
    const weights = getState()
      .weights.filter((entry) => entry.day !== saved.day)
      .concat(saved)
      .sort((a, b) => a.day.localeCompare(b.day));
    setState({ weights, weightUi: { ...ui(), edit: null, draft: null, error: null } });
    // Ready for the next entry; the submit button was replaced by the re-render.
    document.getElementById('weight-kg')?.focus();
  } catch (error) {
    if (error.status === 401) return;
    // Keep what the user typed; the re-render would otherwise reset the form.
    // A 400 means the input itself was rejected, so "try again" wouldn't help.
    const message = error.status === 400 ? 'weight.invalid' : 'weight.saveFailed';
    setUi({ draft: { day, kg }, error: message });
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
      if (error.status !== 401) setUi({ deleteError: true });
      return;
    }
  }
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
