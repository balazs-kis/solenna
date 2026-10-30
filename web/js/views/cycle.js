import { api } from '../api.js';
import {
  analyzeCycle,
  assumedEnd,
  checkPastPeriods,
  loggedEnd,
  MAX_PERIOD_DAYS,
  todayStatus,
  withoutFertility,
} from '../cycle-math.js';
import { h } from '../dom.js';
import { daysBetween, formatDay, formatDayLong, formatDays, formatRelativeDay, todayIso } from '../format.js';
import { t } from '../i18n.js';
import { getState, remember, setState, subscribe } from '../store.js';
import { fertilityLabels, fertilityMarker, flowLabels, renderCalendar } from './cycle-calendar.js';
import { hero } from './hero.js';

export const title = 'cycle.title';

// State: `state.periods` is the user's data (undefined until loaded, sorted by
// start day). `state.cycleUi` holds this screen's UI state:
//   month ('YYYY-MM' shown), selected (day), error (i18n key),
//   confirmDelete (period id), loadFailed, history (the "add past periods"
//   dialog while it's open, see below). Only `month`, `selected` and `history`
//   survive leaving the screen. Both are null while they're today's (set
//   them through followingDay() and followingMonth()), so they move on with
//   the date.

/** The header's big value and the day cards, by `todayStatus().day.kind`. */
const dayLabels = {
  period: 'cycle.periodDay',
  spotting: 'cycle.spottingDay',
  cycle: 'cycle.cycleDay',
};

const phases = {
  menstrual: { name: 'cycle.phaseMenstrual', text: 'cycle.phaseMenstrualText' },
  follicular: { name: 'cycle.phaseFollicular', text: 'cycle.phaseFollicularText' },
  ovulation: { name: 'cycle.phaseOvulation', text: 'cycle.phaseOvulationText' },
  luteal: { name: 'cycle.phaseLuteal', text: 'cycle.phaseLutealText' },
};

/**
 * A day as `cycleUi.selected`: null if it's today, so an app left open past
 * midnight selects the new today instead of keeping yesterday.
 */
function followingDay(day) {
  return day === todayIso() ? null : day;
}

/** A month ('YYYY-MM') as `cycleUi.month`: null if it's this month, for the same reason. */
function followingMonth(month) {
  return month === todayIso().slice(0, 7) ? null : month;
}

function ui() {
  return getState().cycleUi ?? {};
}

function setUi(patch) {
  setState({ cycleUi: { ...ui(), ...patch } });
}

/** Called by the app whenever this screen becomes active. */
export async function load() {
  setUi({ loadFailed: false, error: null, confirmDelete: null });
  const before = getState().periods;
  try {
    const periods = await api('GET', '/api/periods');
    // Signed out meanwhile, or a save changed the list after this request
    // started: this answer is stale.
    if (!getState().user || getState().periods !== before) return;
    setState({ periods });
  } catch (error) {
    // No connection: the offline banner says so, and the screen keeps the data
    // it has. Reconnecting loads it again.
    if (error.status !== 401 && error.code !== 'network') setUi({ loadFailed: true });
  }
}

export function render(container, state) {
  container.append(h('h1', { id: 'page-title', tabindex: '-1' }, t('cycle.title')));
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
  if (!state.periods) {
    // Still loading, or offline with nothing saved yet.
    if (state.offline) container.append(h('p', { class: 'card muted' }, t('app.offlineNoData')));
    return;
  }

  const today = todayIso();
  const showFertility = state.user.settings.show_fertility;
  const analysis = shownAnalysis(state);
  const status = todayStatus(analysis);
  const selected = view.selected ?? today;
  const month = view.month ?? today.slice(0, 7);

  // Phone order: quick action, calendar, events, disclaimer. On wide screens
  // the calendar moves to the left column (see app.css).
  container.append(
    renderHero(analysis, status, showFertility),
    h(
      'div',
      { class: 'columns cycle-columns' },
      renderQuickAction(analysis, status, state.offline),
      renderHistoryPrompt(analysis),
      h(
        'section',
        { class: 'card stack cycle-main' },
        renderCalendar({
          month,
          selected,
          analysis,
          onSelect: (day) => setUi({ selected: followingDay(day), error: null, confirmDelete: null }),
          onMonth: (next) => setUi({ month: followingMonth(next) }),
        }),
        renderLegend(showFertility),
        renderDayPanel(selected, analysis, view, state),
      ),
      renderEvents(analysis, status, showFertility),
      h(
        'p',
        { class: 'disclaimer' },
        h('span', { class: 'icon icon-info', 'aria-hidden': 'true' }),
        h('span', {}, t('cycle.disclaimer')),
      ),
    ),
    renderHistoryDialog(view.history, state.periods, analysis, state.offline),
  );
}

// The last analysis and what it was computed from. Every render needs it twice
// (glow() and render()), and the app re-renders on any state change, while
// analyzeCycle() walks every logged period and day. Saves always store a new
// periods array (save() sorts a copy), so comparing the array itself is enough.
const EMPTY = { periods: null, today: null, showFertility: null, analysis: null };
let cached = EMPTY;

// Signed out (or not loaded yet): drop the previous user's analysis too, not
// just their periods in the state.
subscribe((state) => {
  if (!state.periods) cached = EMPTY;
});

/** What the screen shows: the analysis without fertility when the user turned it off. */
function shownAnalysis(state) {
  const today = todayIso();
  const showFertility = state.user.settings.show_fertility;
  if (cached.periods !== state.periods || cached.today !== today || cached.showFertility !== showFertility) {
    const full = analyzeCycle(state.periods, today);
    const analysis = showFertility ? full : withoutFertility(full);
    cached = { periods: state.periods, today, showFertility, analysis };
  }
  return cached.analysis;
}

const phaseGlows = { menstrual: 'rose', follicular: 'amber', ovulation: 'teal', luteal: 'lilac' };

/**
 * The glow follows today's phase. It comes from the same analysis the screen
 * shows, so with fertility info off the ovulation day glows amber (it reads as
 * follicular), never teal: that would give away the hidden estimate. No
 * estimate (overdue, short cycles, nothing logged): neutral.
 */
export function glow(state) {
  if (!state.periods || state.cycleUi?.loadFailed) return 'neutral';
  return phaseGlows[shownAnalysis(state).dayInfo(todayIso()).phase] ?? 'neutral';
}

/**
 * Today at a glance: the day of the period (or spotting, or cycle), the phase,
 * and what comes next. Nothing before the first period is logged.
 */
function renderHero(analysis, status, showFertility) {
  const { today } = analysis;
  const { day, info, overdue, fertile } = status;
  if (!day) return null;
  const value = t(dayLabels[day.kind], { day: day.number });

  // Overdue: the phase is unknown, and the lines say what the card says.
  const overdueText = overdue && overdueLines(overdue, today);
  let line1 = null;
  if (info.phase === 'ovulation') line1 = t('cycle.heroOvulation');
  else if (info.phase) line1 = t(phases[info.phase].name);
  else if (overdue) line1 = overdueText.title;

  // What comes next: the end of this period, the fertile window of this cycle
  // (only with fertility info on), or the next period.
  let line2 = null;
  if (status.expectedEnd) {
    line2 = t('cycle.expectedEnd', { date: formatDay(status.expectedEnd) });
  } else if (overdue) {
    line2 = overdueText.text;
  } else if (showFertility && fertile?.thisCycle) {
    if (info.fertility === 'high') line2 = t('cycle.highFertilityToday');
    else if (fertile.now) line2 = t('cycle.fertileNow');
    else line2 = t('cycle.fertileFrom', { when: formatRelativeDay(fertile.start, today) });
  } else if (status.nextPeriod) {
    line2 = t('cycle.nextPeriod', { when: formatRelativeDay(status.nextPeriod, today) });
  }

  return hero({ value, size: 'words', line1, line2 });
}

/**
 * An overdue period in words, for the header and its card. A few days over
 * is normal variation; only past that is it called late.
 */
function overdueLines({ expectedStart, late }, today) {
  const when = formatRelativeDay(expectedStart, today);
  const date = formatDay(expectedStart);
  return late
    ? { title: t('cycle.late'), text: t('cycle.wasExpected', { when, date }) }
    : { title: t('cycle.expectedWas', { when }), text: t('cycle.normalVariation', { date }) };
}

/** One big button for the most common action today. */
function renderQuickAction(analysis, status, offline) {
  const { last, today } = analysis;

  if (last?.end_day === null) {
    // The length limit counts from the logged start, like the server's.
    const loggedDays = daysBetween(last.start_day, today) + 1;
    if (loggedDays > MAX_PERIOD_DAYS) {
      return h('p', { class: 'card error' }, t('cycle.ongoingTooLong', { days: formatDays(loggedDays) }));
    }
    // Within the limit, the ongoing period covers today: day.kind is 'period' or 'spotting'.
    const { day } = status;
    return h(
      'div',
      { class: 'card quick-action' },
      h('span', { class: 'quick-action-label' }, t(dayLabels[day.kind], { day: day.number })),
      h(
        'button',
        {
          type: 'button',
          id: 'quick-action',
          class: 'button large',
          disabled: offline,
          onclick: () => endPeriod(last, today),
        },
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
      {
        type: 'button',
        id: 'quick-action',
        class: 'button large',
        disabled: offline,
        onclick: () => startPeriod(today),
      },
      h('span', { class: 'icon icon-drop', 'aria-hidden': 'true' }),
      t('cycle.startedToday'),
    ),
  );
}

/**
 * Two groups, matching the calendar's two layers: phase colours and fertility
 * markers. With fertility info off, ovulation and the marker group are left out.
 */
function renderLegend(showFertility) {
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
        showFertility && swatch('phase-ovulation', 'cycle.phaseOvulation'),
        swatch('phase-luteal', 'cycle.phaseLuteal'),
      ),
    ),
    showFertility &&
      h(
        'div',
        { class: 'legend-group' },
        h('span', { class: 'legend-title' }, t('cycle.legendFertility')),
        h('ul', {}, marker('medium'), marker('high')),
      ),
  );
}

/** What's on the selected day, and the actions that make sense for it. */
function renderDayPanel(day, analysis, view, state) {
  const info = analysis.dayInfo(day);
  const period = analysis.periodOn(day);
  const status = [];
  if (info.period === 'logged') status.push(t('cycle.legendPeriod'));
  if (info.period === 'predicted') status.push(t('cycle.legendPredicted'));
  if (info.fertility) status.push(t(fertilityLabels[info.fertility]));
  if (info.phase) status.push(t('cycle.cycleDayPhase', { day: info.cycleDay, phase: t(phases[info.phase].name) }));
  else if (info.cycleDay) status.push(t('cycle.cycleDay', { day: info.cycleDay }));

  // The text block; on wide screens the actions sit next to it in one row.
  const text = h(
    'div',
    { class: 'day-panel-text' },
    h('h3', { class: 'day-panel-title' }, formatDayLong(day)),
    status.length > 0 && h('p', { class: 'muted' }, status.join(' · ')),
    info.isFuture && h('p', { class: 'muted' }, t('cycle.futureDay')),
  );
  const content = [text];

  if (!info.isFuture) {
    if (period) content.push(renderFlowPicker(period, day, info.flow, state.offline));
    content.push(renderDayActions(day, period, analysis, view, state));
  }
  if (view.error) content.push(h('p', { class: 'error', role: 'alert' }, t(view.error)));

  return h('div', { class: 'day-panel stack' }, content);
}

function renderFlowPicker(period, day, current, offline) {
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
            disabled: offline,
            onclick: () => setFlow(period, day, current === level ? null : level, `flow-${level}`),
          },
          h('span', { class: 'flow-drops', 'aria-hidden': 'true' }, '●'.repeat(level)),
          h('span', {}, t(label)),
        );
      }),
    ),
  );
}

function renderDayActions(day, period, analysis, view, state) {
  const { today } = analysis;
  const { periods, offline } = state;
  const actions = [];

  if (!period) {
    actions.push(
      h(
        'button',
        {
          type: 'button',
          id: 'day-start',
          class: 'button secondary',
          disabled: offline,
          onclick: () => startPeriod(day),
        },
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
        {
          type: 'button',
          id: 'day-end',
          class: 'button secondary',
          disabled: offline,
          onclick: () => endPeriod(before, day),
        },
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
                disabled: offline,
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
            {
              type: 'button',
              id: 'day-delete',
              class: 'link-button',
              disabled: offline,
              onclick: () => askDelete(period),
            },
            t('cycle.deletePeriod'),
          ),
    );
  }
  return h('div', { class: 'actions' }, actions);
}

/**
 * The key upcoming events as cards: phase today, next period, fertile window,
 * ovulation, averages. The fertility cards only show with fertility info on.
 */
function renderEvents(analysis, status, showFertility) {
  const { last, today, stats } = analysis;
  if (!last) {
    return h('p', { class: 'card muted' }, t('cycle.empty'));
  }

  const { info, day, overdue } = status;
  const cards = [];

  if (info.phase) {
    const phase = phases[info.phase];
    cards.push(
      eventCard(`phase-${info.phase}`, 'cycle', t('cycle.cycleDayPhase', { day: info.cycleDay, phase: t(phase.name) }), t(phase.text)),
    );
  } else if (info.cycleDay) {
    // The phase can't be estimated: the period is overdue, or the cycles are too short.
    const reason = overdue ? 'cycle.phaseUnknownOverdue' : 'cycle.phaseUnknownShort';
    cards.push(eventCard('stats', 'cycle', t('cycle.cycleDay', { day: info.cycleDay }), t(reason)));
  }

  // Ongoing spotting (nothing but spotting logged so far) is no period of its
  // own: the cycle runs on, so the next-period cards still apply.
  if (status.ongoing && day.kind === 'spotting') {
    cards.push(eventCard('period', 'drop', t('cycle.spottingDay', { day: day.number }), t('cycle.spottingText')));
  }
  if (status.expectedEnd) {
    cards.push(
      eventCard(
        'period',
        'drop',
        t('cycle.periodDay', { day: day.number }),
        t('cycle.expectedEnd', { date: formatDay(status.expectedEnd) }),
      ),
    );
  } else if (overdue) {
    const { title, text } = overdueLines(overdue, today);
    cards.push(eventCard('period', 'drop', title, text));
  } else if (status.nextPeriod) {
    cards.push(
      eventCard(
        'period',
        'drop',
        t('cycle.nextPeriod', { when: formatRelativeDay(status.nextPeriod, today) }),
        formatDay(status.nextPeriod),
      ),
    );
  }

  if (showFertility) cards.push(...fertilityCards(status, today));

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

/** The next fertile window and ovulation, or why there's no estimate. */
function fertilityCards(status, today) {
  const { fertile, ovulation } = status;
  const cards = [];

  if (fertile) {
    cards.push(
      eventCard(
        'fertile',
        'sprout',
        fertile.now ? t('cycle.fertileNow') : t('cycle.fertileFrom', { when: formatRelativeDay(fertile.start, today) }),
        t('cycle.dateRange', { from: formatDay(fertile.start), to: formatDay(fertile.end) }),
      ),
    );
  }

  if (ovulation) {
    cards.push(
      eventCard(
        'ovulation',
        'ovulation',
        t('cycle.ovulationOn', { when: formatRelativeDay(ovulation, today) }),
        formatDay(ovulation),
      ),
    );
  }

  // Short cycles: say why there's no fertile window instead of silently omitting it.
  if (status.noOvulationEstimate) {
    cards.push(eventCard('fertile', 'sprout', t('cycle.noOvulationEstimate'), t('cycle.noOvulationEstimateText')));
  }
  return cards;
}

/** Where the averages come from, naming the real reason when they're typical values. */
function averagesSource(stats) {
  const parts = [];
  if (stats.measuredCycles > 0) parts.push(t('cycle.basedOn', { count: stats.measuredCycles }));
  else if (stats.loggedPeriods < 2) parts.push(t('cycle.typicalCycleFewPeriods'));
  else parts.push(t('cycle.typicalCycleGaps'));
  if (stats.skippedGaps > 0) parts.push(t('cycle.skippedGaps'));
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
// local list from the server's answer. Changes run one after another, and each
// starts from the list as the previous one left it: two quick taps (flow on two
// days, or "started today" twice) would otherwise each send the old period,
// and the slower request would undo the faster one.

let saving = Promise.resolve();
// Changes waiting or running, and whether one of them failed: a later success
// in the same burst of taps must not hide that error.
let pending = 0;
let failedInBurst = false;

function queue(task) {
  pending++;
  // save() reports its own errors; the catch only keeps an unexpected one
  // from stopping every later change.
  saving = saving
    .then(task)
    .catch((error) => console.error(error))
    .finally(() => {
      pending--;
      if (pending === 0) failedInBurst = false;
    });
}

/** The period with this id as it is now (after earlier queued changes), if it still exists. */
function current(period) {
  return getState().periods?.find((p) => p.id === period.id);
}

function startPeriod(day) {
  queue(async () => {
    const periods = getState().periods;
    if (!periods) return; // Signed out meanwhile.
    const today = todayIso();
    const analysis = analyzeCycle(periods, today);
    if (analysis.periodOn(day)) return; // A repeated tap: it has already started.
    // A start in the past gets an assumed end (the average length, adjustable
    // with "stopped this day"); only a recent one stays ongoing.
    const end = assumedEnd(day, periods, analysis.stats.periodLength, today);
    const body = { start_day: day, end_day: end, flow: [] };
    await save(async () => {
      const created = await api('POST', '/api/periods', body);
      // A reload that finished meanwhile may already list it.
      return (periods) => [...periods.filter((p) => p.id !== created.id), created];
    }, day);
  });
}

function endPeriod(period, day) {
  queue(async () => {
    const latest = current(period);
    if (!latest) return;
    const flow = latest.flow.filter((f) => f.day <= day);
    await savePeriod({ ...latest, end_day: day, flow }, day);
  });
}

/** Sets (or with `level` null, clears) the strength of one day; focus returns to `focusId`. */
function setFlow(period, day, level, focusId) {
  queue(async () => {
    const latest = current(period);
    if (!latest) return;
    const flow = latest.flow.filter((f) => f.day !== day);
    if (level !== null) flow.push({ day, flow: level });
    await savePeriod({ ...latest, flow }, day, focusId);
  });
}

async function savePeriod(period, day, focusId) {
  const { id, start_day, end_day, flow } = period;
  await save(
    async () => {
      const saved = await api('PUT', `/api/periods/${id}`, { start_day, end_day, flow });
      return (periods) => periods.map((p) => (p.id === id ? saved : p));
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

function deletePeriod(period) {
  queue(async () => {
    if (!current(period)) return; // A repeated tap: already deleted.
    await save(
      async () => {
        try {
          await api('DELETE', `/api/periods/${period.id}`);
        } catch (error) {
          // Already gone (e.g. deleted on another device) is what we wanted.
          if (error.status !== 404) throw error;
        }
        return (periods) => periods.filter((p) => p.id !== period.id);
      },
      ui().selected ?? todayIso(),
    );
  });
}

/**
 * Runs a change and stores the resulting period list, keeping the changed day
 * selected and focus on a sensible control (the buttons get re-rendered).
 * `change` calls the API and returns how to update the list with its answer,
 * so the list is only touched once it's clear the user is still signed in.
 */
async function save(change, day, focusId) {
  try {
    const update = await change();
    if (!getState().user) return; // Signed out meanwhile.
    // A sorted copy: the stored list is never changed in place (the analysis cache relies on it).
    const periods = update(getState().periods).toSorted((a, b) => a.start_day.localeCompare(b.start_day));
    const error = failedInBurst ? ui().error : null;
    setState({ periods, cycleUi: { ...ui(), selected: followingDay(day), error, confirmDelete: null } });
    document.getElementById(focusId ?? `day-${day}`)?.focus();
  } catch (error) {
    if (error.status === 401 || !getState().user) return;
    failedInBurst = true;
    setUi({ error: saveError(error), confirmDelete: null });
  }
}

/** The message (i18n key) for a period change the server didn't accept. */
function saveError(error) {
  if (error.code === 'network') return 'app.networkError';
  if (error.status === 409) return 'cycle.overlap';
  if (error.code === 'stale_ongoing') return 'cycle.staleOngoing';
  if (error.status === 400) return 'cycle.invalid';
  return 'cycle.saveFailed';
}

// --- Adding past periods -----------------------------------------------------
// With fewer than 3 periods logged (none included), a card offers to add the
// ones the user remembers, in a dialog: one row per period, its first and
// last day only. `cycleUi.history` is the open dialog: rows ({ key, start,
// end }, as typed), results (checkPastPeriods() of the last save attempt, for
// the row errors), error (i18n key), saving.

/** The card shows while fewer periods than this are logged. */
const HISTORY_PROMPT_BELOW = 3;

const pastPeriodErrors = {
  missingStart: 'cycle.historyMissingStart',
  future: 'cycle.historyFuture',
  endBeforeStart: 'cycle.historyEndBeforeStart',
};

// Keys for the rows: element ids that stay the same across re-renders.
let nextRowKey = 1;

function emptyRow() {
  return { key: nextRowKey++, start: '', end: '' };
}

function renderHistoryPrompt(analysis) {
  if (analysis.stats.loggedPeriods >= HISTORY_PROMPT_BELOW) return null;
  return h(
    'section',
    { class: 'card history-prompt' },
    h('span', { class: 'event-icon', 'aria-hidden': 'true' }, h('span', { class: 'icon icon-history' })),
    h('div', {}, h('h2', {}, t('cycle.historyPromptTitle')), h('p', { class: 'muted' }, t('cycle.historyPromptText'))),
    h(
      'button',
      { type: 'button', id: 'history-open', class: 'button secondary', onclick: openHistory },
      t('cycle.historyOpen'),
    ),
  );
}

/**
 * The dialog (app.js opens it as a modal). The rows keep what was picked in
 * the UI state, so re-renders don't lose it.
 */
function renderHistoryDialog(history, periods, analysis, offline) {
  if (!history) return null;
  const { today, stats } = analysis;
  const logged = periods.map((p) =>
    t('cycle.dateRange', { from: formatDay(p.start_day), to: formatDay(loggedEnd(p, today)) }),
  );
  return h(
    'dialog',
    {
      id: 'history-dialog',
      class: 'dialog',
      'data-modal': true,
      'aria-labelledby': 'history-title',
      // Escape: close through the state, like the close button (not while saving).
      oncancel: (event) => {
        event.preventDefault();
        if (!history.saving) closeHistory();
      },
    },
    h(
      'form',
      { class: 'stack', novalidate: true, onsubmit: saveHistory, oninput: keepRows, onfocusin: showRows },
      h(
        'div',
        { class: 'dialog-header' },
        h('h2', { id: 'history-title' }, t('cycle.historyTitle')),
        h(
          'button',
          {
            type: 'button',
            id: 'history-close',
            class: 'icon-button',
            'aria-label': t('cycle.historyClose'),
            disabled: history.saving,
            onclick: closeHistory,
          },
          h('span', { class: 'icon icon-close', 'aria-hidden': 'true' }),
        ),
      ),
      h('p', { class: 'muted' }, t('cycle.historyIntro')),
      logged.length > 0 && h('p', { class: 'muted' }, t('cycle.historyLogged', { periods: logged.join(', ') })),
      history.error && h('p', { class: 'error', role: 'alert' }, t(history.error)),
      h(
        'ul',
        { class: 'history-rows' },
        history.rows.map((row, i) => renderHistoryRow(row, i, history.results?.[i], stats.periodLength)),
      ),
      h(
        'button',
        { type: 'button', id: 'history-add', class: 'button secondary add-row', onclick: addRow },
        h('span', { class: 'icon icon-plus', 'aria-hidden': 'true' }),
        t('cycle.historyAdd'),
      ),
      h(
        'div',
        { class: 'dialog-actions' },
        h(
          'button',
          {
            type: 'button',
            id: 'history-cancel',
            class: 'button secondary',
            disabled: history.saving,
            onclick: closeHistory,
          },
          t('cycle.cancel'),
        ),
        h(
          'button',
          { type: 'submit', id: 'history-save', class: 'button', disabled: offline || history.saving },
          t('cycle.historySave'),
        ),
      ),
    ),
  );
}

/** One period: its first and last day, a remove button, and a hint or what's wrong. */
function renderHistoryRow(row, index, result, periodLength) {
  let message = null;
  if (result?.error === 'overlap') {
    const range = t('cycle.dateRange', { from: formatDay(result.other.start_day), to: formatDay(result.other.end_day) });
    message = h('p', { class: 'error' }, t('cycle.historyOverlap', { range }));
  } else if (result?.error === 'tooLong') {
    message = h('p', { class: 'error' }, t('cycle.historyTooLong', { days: formatDays(MAX_PERIOD_DAYS) }));
  } else if (result?.error) {
    message = h('p', { class: 'error' }, t(pastPeriodErrors[result.error]));
  } else if (row.start && !row.end) {
    message = h('p', { class: 'muted' }, t('cycle.historyNoEnd', { days: formatDays(periodLength) }));
  }
  const field = (name, label) =>
    h(
      'div',
      { class: 'field' },
      h('label', { for: `history-${name}-${row.key}` }, label),
      h('input', {
        id: `history-${name}-${row.key}`,
        name: `${name}-${row.key}`,
        type: 'date',
        min: '1900-01-01',
        max: todayIso(),
        value: row[name],
      }),
    );
  return h(
    'li',
    { class: result?.error ? 'history-row has-error' : 'history-row' },
    h(
      'div',
      { class: 'history-fields' },
      field('start', t('cycle.historyStarted')),
      field('end', t('cycle.historyEnded')),
    ),
    h(
      'button',
      {
        type: 'button',
        id: `history-remove-${row.key}`,
        class: 'icon-button',
        'aria-label': t('cycle.historyRemove', { number: index + 1 }),
        onclick: () => removeRow(row.key),
      },
      h('span', { class: 'icon icon-trash', 'aria-hidden': 'true' }),
    ),
    message,
  );
}

function setHistory(patch) {
  setUi({ history: { ...ui().history, ...patch } });
}

function openHistory() {
  const row = emptyRow();
  setUi({ history: { rows: [row], results: null, error: null, saving: false } });
  document.getElementById(`history-start-${row.key}`)?.focus();
}

function closeHistory() {
  setUi({ history: null });
  // Back to the button, or to the page once enough is logged and the card is
  // gone; not if a save finished after the user went to another screen.
  if (getState().path !== '/cycle') return;
  (document.getElementById('history-open') ?? document.getElementById('page-title'))?.focus();
}

/**
 * Keeps the dates as they're typed, without a re-render: the browser takes a
 * date as complete while its year is still being typed (2 is the year 0002),
 * and a new input would put the caret back on the first part. Old errors
 * go: they were about the old dates.
 */
function keepRows(event) {
  const { elements } = event.currentTarget;
  const rows = ui().history.rows.map((row) => ({
    ...row,
    start: elements[`start-${row.key}`].value,
    end: elements[`end-${row.key}`].value,
  }));
  remember({ cycleUi: { ...ui(), history: { ...ui().history, rows, results: null, error: null } } });
}

/**
 * Shows the kept dates (the hint for a missing last day, no old errors) once
 * focus has moved from one date to another (focusin: the new one already has
 * focus, so the re-render keeps it there). Not when focus goes to a button:
 * re-rendering between mousedown and mouseup would swallow the click, and
 * every button renders anyway.
 */
function showRows(event) {
  if (event.target.matches('input') && event.relatedTarget?.matches('#history-dialog input')) setHistory({});
}

function addRow() {
  const row = emptyRow();
  setHistory({ rows: [...ui().history.rows, row] });
  document.getElementById(`history-start-${row.key}`)?.focus();
}

function removeRow(key) {
  const rows = ui().history.rows.filter((row) => row.key !== key);
  setHistory({ rows: rows.length > 0 ? rows : [emptyRow()], results: null, error: null });
  document.getElementById('history-add')?.focus();
}

/**
 * Checks every row first, and saves only if all are fine: one period after
 * the other, each leaving the dialog once saved. If the server turns one
 * down, the ones before it stay saved and the rest stay for another try.
 */
function saveHistory(event) {
  event.preventDefault();
  const history = ui().history;
  if (!history || history.saving) return;
  const periods = getState().periods;
  const today = todayIso();
  const { periodLength } = analyzeCycle(periods, today).stats;
  const results = checkPastPeriods(history.rows, periods, periodLength, today);
  const firstError = results.findIndex((result) => result?.error);
  if (firstError >= 0) {
    setHistory({ results, error: 'cycle.historyFix' });
    document.getElementById(`history-start-${history.rows[firstError].key}`)?.focus();
    return;
  }
  const toSave = history.rows
    .map((row, i) => ({ key: row.key, period: results[i]?.period }))
    .filter((item) => item.period);
  if (toSave.length === 0) {
    closeHistory();
    return;
  }
  setHistory({ results: null, error: null, saving: true });
  queue(async () => {
    for (const { key, period } of toSave) {
      try {
        const created = await api('POST', '/api/periods', { ...period, flow: [] });
        if (!getState().user) return; // Signed out meanwhile.
        const periods = [...getState().periods.filter((p) => p.id !== created.id), created].toSorted((a, b) =>
          a.start_day.localeCompare(b.start_day),
        );
        // The dialog can't be closed while saving, but don't count on it.
        const history = ui().history;
        const rows = history?.rows.filter((row) => row.key !== key);
        setState({ periods, cycleUi: { ...ui(), history: history && { ...history, rows } } });
      } catch (error) {
        if (error.status === 401 || !getState().user || !ui().history) return;
        setHistory({ error: saveError(error), saving: false });
        document.getElementById('history-save')?.focus();
        return;
      }
    }
    closeHistory();
  });
}
