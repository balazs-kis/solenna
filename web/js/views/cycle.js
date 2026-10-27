import { api } from '../api.js';
import { analyzeCycle, assumedEnd, MAX_PERIOD_DAYS } from '../cycle-math.js';
import { h } from '../dom.js';
import { daysBetween, formatDay, formatDayLong, formatDays, formatRelativeDay, todayIso } from '../format.js';
import { t } from '../i18n.js';
import { getState, setState } from '../store.js';
import { fertilityLabels, fertilityMarker, flowLabels, renderCalendar } from './cycle-calendar.js';

export const title = 'cycle.title';

// State: `state.periods` is the user's data (undefined until loaded, sorted by
// start day). `state.cycleUi` holds this screen's UI state:
//   month ('YYYY-MM' shown), selected (day), error (i18n key),
//   confirmDelete (period id), loadFailed. Only `month` and `selected`
//   survive leaving the screen.

const phases = {
  menstrual: { name: 'cycle.phaseMenstrual', text: 'cycle.phaseMenstrualText' },
  follicular: { name: 'cycle.phaseFollicular', text: 'cycle.phaseFollicularText' },
  ovulation: { name: 'cycle.phaseOvulation', text: 'cycle.phaseOvulationText' },
  luteal: { name: 'cycle.phaseLuteal', text: 'cycle.phaseLutealText' },
};

function ui() {
  return getState().cycleUi ?? {};
}

function setUi(patch) {
  setState({ cycleUi: { ...ui(), ...patch } });
}

/** Called by the app whenever this screen becomes active. */
export async function load() {
  setUi({ loadFailed: false, error: null, confirmDelete: null });
  try {
    setState({ periods: await api('GET', '/api/periods') });
  } catch (error) {
    if (error.status !== 401) setUi({ loadFailed: true });
  }
}

export function render(container, state) {
  container.append(h('h1', { tabindex: '-1' }, t('cycle.title')));
  const view = state.cycleUi ?? {};

  if (view.loadFailed) {
    container.append(
      h(
        'div',
        { class: 'card stack' },
        h('p', { class: 'error', role: 'alert' }, t('cycle.loadFailed')),
        h('button', { type: 'button', class: 'button secondary', onclick: load }, t('app.retry')),
      ),
    );
    return;
  }
  if (!state.periods) return; // Still loading.

  const today = todayIso();
  const analysis = analyzeCycle(state.periods, today);
  const selected = view.selected ?? today;
  const month = view.month ?? today.slice(0, 7);

  container.append(
    h(
      'div',
      { class: 'stack' },
      renderQuickAction(analysis),
      h(
        'section',
        { class: 'card stack' },
        renderCalendar({
          month,
          selected,
          analysis,
          onSelect: (day) => setUi({ selected: day, error: null, confirmDelete: null }),
          onMonth: (next) => setUi({ month: next }),
        }),
        renderLegend(),
        renderDayPanel(selected, analysis, view),
      ),
      renderEvents(analysis),
      h(
        'p',
        { class: 'disclaimer' },
        h('span', { class: 'icon icon-info', 'aria-hidden': 'true' }),
        h('span', {}, t('cycle.disclaimer')),
      ),
    ),
  );
}

/** One big button for the most common action today. */
function renderQuickAction(analysis) {
  const { last, today } = analysis;
  const ongoing = last && last.end_day === null;

  if (ongoing) {
    const periodDay = daysBetween(last.start_day, today) + 1;
    if (periodDay > MAX_PERIOD_DAYS) {
      return h('p', { class: 'card error' }, t('cycle.ongoingTooLong', { days: formatDays(periodDay) }));
    }
    return h(
      'div',
      { class: 'card quick-action' },
      h('span', { class: 'quick-action-label' }, t('cycle.periodDay', { day: periodDay })),
      h(
        'button',
        { type: 'button', id: 'quick-action', class: 'button', onclick: () => endPeriod(last, today) },
        t('cycle.stoppedToday'),
      ),
    );
  }
  // Today already inside an ended period: nothing to start.
  if (analysis.periodOn(today)) return null;
  return h(
    'div',
    { class: 'card quick-action' },
    h(
      'button',
      { type: 'button', id: 'quick-action', class: 'button', onclick: () => startPeriod(today) },
      h('span', { class: 'icon icon-drop', 'aria-hidden': 'true' }),
      t('cycle.startedToday'),
    ),
  );
}

/** Two groups, matching the calendar's two layers: phase colours and fertility markers. */
function renderLegend() {
  const swatch = (className, label) =>
    h('li', {}, h('span', { class: `legend-swatch ${className}`, 'aria-hidden': 'true' }), t(label));
  const marker = (level) => h('li', {}, fertilityMarker(level), t(fertilityLabels[level]));
  return h(
    'div',
    { class: 'legend' },
    h(
      'div',
      { class: 'legend-group' },
      h('span', { class: 'legend-title' }, t('cycle.legendPhases')),
      h(
        'ul',
        {},
        swatch('is-period', 'cycle.legendPeriod'),
        swatch('is-predicted-period', 'cycle.legendPredicted'),
        swatch('phase-follicular', 'cycle.phaseFollicular'),
        swatch('phase-ovulation', 'cycle.phaseOvulation'),
        swatch('phase-luteal', 'cycle.phaseLuteal'),
      ),
    ),
    h(
      'div',
      { class: 'legend-group' },
      h('span', { class: 'legend-title' }, t('cycle.legendFertility')),
      h('ul', {}, marker('medium'), marker('high')),
    ),
  );
}

/** What's on the selected day, and the actions that make sense for it. */
function renderDayPanel(day, analysis, view) {
  const info = analysis.dayInfo(day);
  const period = analysis.periodOn(day);
  const status = [];
  if (info.period === 'logged') status.push(t('cycle.legendPeriod'));
  if (info.period === 'predicted') status.push(t('cycle.legendPredicted'));
  if (info.fertility) status.push(t(fertilityLabels[info.fertility]));
  if (info.phase) status.push(t('cycle.cycleDayPhase', { day: info.cycleDay, phase: t(phases[info.phase].name) }));
  else if (info.cycleDay) status.push(t('cycle.cycleDay', { day: info.cycleDay }));

  const content = [
    h('h3', { class: 'day-panel-title' }, formatDayLong(day)),
    status.length > 0 && h('p', { class: 'muted' }, status.join(' · ')),
  ];

  if (info.isFuture) {
    content.push(h('p', { class: 'muted' }, t('cycle.futureDay')));
  } else {
    if (period) content.push(renderFlowPicker(period, day, info.flow));
    content.push(renderDayActions(day, period, analysis, view));
  }
  if (view.error) content.push(h('p', { class: 'error', role: 'alert' }, t(view.error)));

  return h('div', { class: 'day-panel stack' }, content);
}

function renderFlowPicker(period, day, current) {
  return h(
    'fieldset',
    { class: 'flow-picker' },
    h('legend', {}, t('cycle.flowLabel')),
    h(
      'div',
      { class: 'flow-options' },
      flowLabels.map((label, i) => {
        const level = i + 1;
        return h(
          'button',
          {
            type: 'button',
            id: `flow-${level}`,
            class: `flow-option flow-${level}`,
            'aria-pressed': String(current === level),
            onclick: () => setFlow(period, day, current === level ? null : level, `flow-${level}`),
          },
          h('span', { class: 'flow-drops', 'aria-hidden': 'true' }, '●'.repeat(level)),
          h('span', {}, t(label)),
        );
      }),
    ),
  );
}

function renderDayActions(day, period, analysis, view) {
  const { today } = analysis;
  const periods = getState().periods;
  const actions = [];

  if (!period) {
    actions.push(
      h(
        'button',
        { type: 'button', id: 'day-start', class: 'button', onclick: () => startPeriod(day) },
        t('cycle.startedThisDay'),
      ),
    );
  }

  // "Stopped this day" ends (or moves the end of) the latest period that
  // started on or before this day, if it would still be a plausible period.
  const before = periods.filter((p) => p.start_day <= day).at(-1);
  const canEnd =
    before && before.end_day !== day && daysBetween(before.start_day, day) < MAX_PERIOD_DAYS && day <= today;
  if (canEnd) {
    actions.push(
      h(
        'button',
        { type: 'button', id: 'day-end', class: 'button secondary', onclick: () => endPeriod(before, day) },
        t('cycle.stoppedThisDay'),
      ),
    );
  }

  if (period) {
    actions.push(
      view.confirmDelete === period.id
        ? h(
            'div',
            { class: 'confirm' },
            h('span', { class: 'muted' }, t('cycle.confirmDelete')),
            h(
              'button',
              {
                type: 'button',
                id: 'confirm-delete',
                class: 'button danger small',
                onclick: () => deletePeriod(period),
              },
              t('cycle.delete'),
            ),
            h(
              'button',
              { type: 'button', class: 'button secondary small', onclick: cancelDelete },
              t('cycle.cancel'),
            ),
          )
        : h(
            'button',
            { type: 'button', id: 'day-delete', class: 'link-button', onclick: () => askDelete(period) },
            t('cycle.deletePeriod'),
          ),
    );
  }
  return h('div', { class: 'actions' }, actions);
}

/** The key upcoming events as cards: phase today, next period, fertile window, ovulation, averages. */
function renderEvents(analysis) {
  const { last, today, stats, cycles } = analysis;
  if (!last) {
    return h('section', { class: 'card' }, h('p', { class: 'muted' }, t('cycle.empty')));
  }

  const info = analysis.dayInfo(today);
  const cards = [];

  if (info.phase) {
    const phase = phases[info.phase];
    cards.push(
      eventCard(`phase-${info.phase}`, 'cycle', t('cycle.cycleDayPhase', { day: info.cycleDay, phase: t(phase.name) }), t(phase.text)),
    );
  } else if (info.cycleDay) {
    // The phase can't be estimated: the period is overdue, or the cycles are too short.
    const reason = analysis.overdueBy > 0 ? 'cycle.phaseUnknownOverdue' : 'cycle.phaseUnknownShort';
    cards.push(eventCard('stats', 'cycle', t('cycle.cycleDay', { day: info.cycleDay }), t(reason)));
  }

  const ongoing = last.end_day === null;
  const next = cycles[1];
  if (ongoing) {
    const expectedEnd = cycles[0].periodEnd;
    cards.push(
      eventCard(
        'period',
        'drop',
        t('cycle.periodDay', { day: daysBetween(last.start_day, today) + 1 }),
        t('cycle.expectedEnd', { date: formatDay(expectedEnd > today ? expectedEnd : today) }),
      ),
    );
  } else if (analysis.overdueBy > 0) {
    // A few days over is normal variation; only past that is it called late.
    const when = formatRelativeDay(analysis.expectedStart, today);
    const date = formatDay(analysis.expectedStart);
    cards.push(
      analysis.late
        ? eventCard('period', 'drop', t('cycle.late'), t('cycle.wasExpected', { when, date }))
        : eventCard('period', 'drop', t('cycle.expectedWas', { when }), t('cycle.normalVariation', { date })),
    );
  } else if (next) {
    cards.push(
      eventCard(
        'period',
        'drop',
        t('cycle.nextPeriod', { when: formatRelativeDay(next.start, today) }),
        formatDay(next.start),
      ),
    );
  }

  const fertile = cycles.find((c) => c.fertileEnd !== null && c.fertileEnd >= today);
  if (fertile) {
    const now = fertile.fertileStart <= today;
    cards.push(
      eventCard(
        'fertile',
        'sprout',
        now ? t('cycle.fertileNow') : t('cycle.fertileFrom', { when: formatRelativeDay(fertile.fertileStart, today) }),
        t('cycle.dateRange', { from: formatDay(fertile.fertileStart), to: formatDay(fertile.fertileEnd) }),
      ),
    );
  }

  const ovulation = cycles.find((c) => c.ovulation !== null && c.ovulation >= today);
  if (ovulation) {
    cards.push(
      eventCard(
        'ovulation',
        'ovulation',
        t('cycle.ovulationOn', { when: formatRelativeDay(ovulation.ovulation, today) }),
        formatDay(ovulation.ovulation),
      ),
    );
  }

  // Short cycles: say why there's no fertile window instead of silently omitting it.
  if (analysis.overdueBy === 0 && cycles.some((c) => c.predicted && c.ovulation === null)) {
    cards.push(eventCard('fertile', 'sprout', t('cycle.noOvulationEstimate'), t('cycle.noOvulationEstimateText')));
  }

  cards.push(
    eventCard(
      'stats',
      'repeat',
      t('cycle.averages', { cycle: formatDays(stats.cycleLength), period: formatDays(stats.periodLength) }),
      averagesSource(stats),
    ),
  );

  return h(
    'section',
    { class: 'stack' },
    h('h2', {}, t('cycle.events')),
    h('ul', { class: 'events' }, cards),
  );
}

/** Where the averages come from, naming the real reason when they're typical values. */
function averagesSource(stats) {
  const parts = [];
  if (stats.measuredCycles > 0) parts.push(t('cycle.basedOn', { count: stats.measuredCycles }));
  else if (stats.loggedPeriods < 2) parts.push(t('cycle.typicalCycleFewPeriods'));
  else parts.push(t('cycle.typicalCycleGaps'));
  if (stats.measuredPeriods === 0) parts.push(t('cycle.typicalPeriodLength'));
  return parts.join(' ');
}

function eventCard(kind, icon, heading, text) {
  return h(
    'li',
    { class: `card event event-${kind}` },
    h('span', { class: 'event-icon', 'aria-hidden': 'true' }, h('span', { class: `icon icon-${icon}` })),
    h('div', {}, h('p', { class: 'event-title' }, heading), h('p', { class: 'muted' }, text)),
  );
}

// --- Actions -----------------------------------------------------------------
// Every change saves a whole period (the API replaces it), then updates the
// local list from the server's answer.

async function startPeriod(day) {
  const periods = getState().periods;
  const today = todayIso();
  // A start in the past gets an assumed end (the average length, adjustable
  // with "stopped this day"); only a recent one stays ongoing.
  const { stats } = analyzeCycle(periods, today);
  const body = { start_day: day, end_day: assumedEnd(day, periods, stats.periodLength, today), flow: [] };
  await save(async () => {
    const created = await api('POST', '/api/periods', body);
    return [...periods, created];
  }, day);
}

async function endPeriod(period, day) {
  const flow = period.flow.filter((f) => f.day <= day);
  await savePeriod({ ...period, end_day: day, flow }, day);
}

/** Sets (or with `level` null, clears) the strength of one day; focus returns to `focusId`. */
async function setFlow(period, day, level, focusId) {
  const flow = period.flow.filter((f) => f.day !== day);
  if (level !== null) flow.push({ day, flow: level });
  await savePeriod({ ...period, flow }, day, focusId);
}

async function savePeriod(period, day, focusId) {
  const periods = getState().periods;
  const { id, start_day, end_day, flow } = period;
  await save(
    async () => {
      const saved = await api('PUT', `/api/periods/${id}`, { start_day, end_day, flow });
      return periods.map((p) => (p.id === id ? saved : p));
    },
    day,
    focusId,
  );
}

function askDelete(period) {
  setUi({ confirmDelete: period.id, error: null });
  document.getElementById('confirm-delete')?.focus();
}

function cancelDelete() {
  setUi({ confirmDelete: null });
  document.getElementById('day-delete')?.focus();
}

async function deletePeriod(period) {
  const periods = getState().periods;
  await save(
    async () => {
      try {
        await api('DELETE', `/api/periods/${period.id}`);
      } catch (error) {
        // Already gone (e.g. deleted on another device) is what we wanted.
        if (error.status !== 404) throw error;
      }
      return periods.filter((p) => p.id !== period.id);
    },
    ui().selected,
  );
}

/**
 * Runs a change and stores the resulting period list, keeping the changed day
 * selected and focus on a sensible control (the buttons get re-rendered).
 */
async function save(change, day, focusId) {
  try {
    const periods = (await change()).sort((a, b) => a.start_day.localeCompare(b.start_day));
    setState({ periods, cycleUi: { ...ui(), selected: day, error: null, confirmDelete: null } });
    document.getElementById(focusId ?? `day-${day}`)?.focus();
  } catch (error) {
    if (error.status === 401) return;
    let message = 'cycle.saveFailed';
    if (error.status === 409) message = 'cycle.overlap';
    else if (error.code === 'stale_ongoing') message = 'cycle.staleOngoing';
    else if (error.status === 400) message = 'cycle.invalid';
    setUi({ error: message, confirmDelete: null });
  }
}
