import { api } from '../api.js';
import { analyzeCycle, assumedEnd, cycleStart, MAX_PERIOD_DAYS, withoutFertility } from '../cycle-math.js';
import { h } from '../dom.js';
import { daysBetween, formatDay, formatDayLong, formatDays, formatRelativeDay, todayIso } from '../format.js';
import { t } from '../i18n.js';
import { getState, setState } from '../store.js';
import { fertilityLabels, fertilityMarker, flowLabels, renderCalendar } from './cycle-calendar.js';
import { hero } from './hero.js';

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
  if (!state.periods) {
    // Still loading, or offline with nothing saved yet.
    if (state.offline) container.append(h('p', { class: 'card muted' }, t('app.offlineNoData')));
    return;
  }

  const today = todayIso();
  const showFertility = state.user.settings.show_fertility;
  const analysis = shownAnalysis(state);
  const selected = view.selected ?? today;
  const month = view.month ?? today.slice(0, 7);

  // Phone order: quick action, calendar, events, disclaimer. On wide screens
  // the calendar moves to the left column (see app.css).
  container.append(
    renderHero(analysis, showFertility),
    h(
      'div',
      { class: 'columns cycle-columns' },
      renderQuickAction(analysis, state.offline),
      h(
        'section',
        { class: 'card stack cycle-main' },
        renderCalendar({
          month,
          selected,
          analysis,
          onSelect: (day) => setUi({ selected: day, error: null, confirmDelete: null }),
          onMonth: (next) => setUi({ month: next }),
        }),
        renderLegend(showFertility),
        renderDayPanel(selected, analysis, view, state),
      ),
      renderEvents(analysis, showFertility),
      h(
        'p',
        { class: 'disclaimer' },
        h('span', { class: 'icon icon-info', 'aria-hidden': 'true' }),
        h('span', {}, t('cycle.disclaimer')),
      ),
    ),
  );
}

/** What the screen shows: the analysis without fertility when the user turned it off. */
function shownAnalysis(state) {
  const analysis = analyzeCycle(state.periods, todayIso());
  return state.user.settings.show_fertility ? analysis : withoutFertility(analysis);
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
function renderHero(analysis, showFertility) {
  const { last, today, cycles } = analysis;
  if (!last) return null;
  const info = analysis.dayInfo(today);
  // A logged period covering today. Its days only count as the menstrual phase
  // once there's real flow; before that it's spotting (see cycle-math.js).
  const bleeding = analysis.periodOn(today);
  const menstrual = info.phase === 'menstrual';

  let value;
  if (bleeding && menstrual) value = t('cycle.periodDay', { day: periodDay(bleeding, today) });
  else if (bleeding) value = t('cycle.spottingDay', { day: daysBetween(bleeding.start_day, today) + 1 });
  else if (info.cycleDay) value = t('cycle.cycleDay', { day: info.cycleDay });
  else return null;

  // Overdue: the phase is unknown, and the lines say what the cards say.
  const overdue = analysis.overdueBy > 0;
  const when = overdue && formatRelativeDay(analysis.expectedStart, today);
  let line1 = null;
  if (info.phase === 'ovulation') line1 = t('cycle.heroOvulation');
  else if (info.phase) line1 = t(phases[info.phase].name);
  else if (overdue) line1 = analysis.late ? t('cycle.late') : t('cycle.expectedWas', { when });

  // What comes next: the end of this period, the fertile window of this cycle
  // (only with fertility info on), or the next period.
  const current = cycles[0];
  let line2 = null;
  if (bleeding && menstrual && bleeding.end_day === null) {
    line2 = t('cycle.expectedEnd', { date: formatDay(current.periodEnd > today ? current.periodEnd : today) });
  } else if (overdue) {
    const date = formatDay(analysis.expectedStart);
    line2 = analysis.late ? t('cycle.wasExpected', { when, date }) : t('cycle.normalVariation', { date });
  } else if (showFertility && current?.fertileEnd != null && current.fertileEnd >= today) {
    if (info.fertility === 'high') line2 = t('cycle.highFertilityToday');
    else if (current.fertileStart <= today) line2 = t('cycle.fertileNow');
    else line2 = t('cycle.fertileFrom', { when: formatRelativeDay(current.fertileStart, today) });
  } else if (cycles[1]) {
    line2 = t('cycle.nextPeriod', { when: formatRelativeDay(cycles[1].start, today) });
  }

  return hero({ value, words: true, line1, line2 });
}

/**
 * Day N of a period: counted from its first day of real flow (cycle day 1),
 * like the cycles and the period lengths. Leading spotting days don't count.
 */
function periodDay(period, today) {
  return daysBetween(cycleStart(period, today), today) + 1;
}

/** One big button for the most common action today. */
function renderQuickAction(analysis, offline) {
  const { last, today } = analysis;
  const ongoing = last && last.end_day === null;

  if (ongoing) {
    // The length limit counts from the logged start, like the server's.
    const loggedDays = daysBetween(last.start_day, today) + 1;
    const spotting = last !== analysis.cycleLast;
    if (loggedDays > MAX_PERIOD_DAYS) {
      return h('p', { class: 'card error' }, t('cycle.ongoingTooLong', { days: formatDays(loggedDays) }));
    }
    const label = spotting
      ? t('cycle.spottingDay', { day: loggedDays })
      : t('cycle.periodDay', { day: periodDay(last, today) });
    return h(
      'div',
      { class: 'card quick-action' },
      h('span', { class: 'quick-action-label' }, label),
      h(
        'button',
        {
          type: 'button',
          id: 'quick-action',
          class: 'button',
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
        class: 'button',
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
function renderEvents(analysis, showFertility) {
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
  // Ongoing spotting (nothing but spotting logged so far) is no period of its
  // own: the cycle runs on, so the next-period cards still apply.
  const spotting = ongoing && last !== analysis.cycleLast;
  const next = cycles[1];
  if (spotting) {
    const day = daysBetween(last.start_day, today) + 1;
    cards.push(eventCard('period', 'drop', t('cycle.spottingDay', { day }), t('cycle.spottingText')));
  }
  if (ongoing && !spotting) {
    const expectedEnd = cycles[0].periodEnd;
    cards.push(
      eventCard(
        'period',
        'drop',
        t('cycle.periodDay', { day: periodDay(last, today) }),
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

  if (showFertility) cards.push(...fertilityCards(analysis));

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
function fertilityCards(analysis) {
  const { today, cycles } = analysis;
  const cards = [];

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
      ui().selected,
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
    const periods = update(getState().periods).sort((a, b) => a.start_day.localeCompare(b.start_day));
    const error = failedInBurst ? ui().error : null;
    setState({ periods, cycleUi: { ...ui(), selected: day, error, confirmDelete: null } });
    document.getElementById(focusId ?? `day-${day}`)?.focus();
  } catch (error) {
    if (error.status === 401 || !getState().user) return;
    failedInBurst = true;
    let message = 'cycle.saveFailed';
    if (error.code === 'network') message = 'app.networkError';
    else if (error.status === 409) message = 'cycle.overlap';
    else if (error.code === 'stale_ongoing') message = 'cycle.staleOngoing';
    else if (error.status === 400) message = 'cycle.invalid';
    setUi({ error: message, confirmDelete: null });
  }
}
