import { h } from '../dom.js';
import { formatDay } from '../format.js';
import { locale, t } from '../i18n.js';

/** Bleeding strength 1..5 as i18n keys (literal, so the translation test sees them). */
export const flowLabels = ['cycle.flow1', 'cycle.flow2', 'cycle.flow3', 'cycle.flow4', 'cycle.flow5'];

/**
 * A month grid (weeks start on Monday) of day buttons. Each day is coloured
 * from `analysis.dayInfo()`; `onSelect(day)` and `onMonth(month)` handle clicks.
 * `month` is 'YYYY-MM'.
 */
export function renderCalendar({ month, selected, analysis, onSelect, onMonth }) {
  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  // getDay() is 0 for Sunday; shift so Monday is the first column.
  const leadingBlanks = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const title = new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' })
    .format(new Date(year, monthNumber - 1, 1));
  const currentMonth = analysis.today.slice(0, 7);

  const days = [];
  for (let date = 1; date <= daysInMonth; date++) {
    days.push(`${month}-${String(date).padStart(2, '0')}`);
  }

  return h(
    'div',
    { class: 'calendar' },
    h(
      'div',
      { class: 'calendar-header' },
      h(
        'button',
        {
          type: 'button',
          id: 'cal-prev',
          class: 'icon-button',
          'aria-label': t('cycle.prevMonth'),
          onclick: () => onMonth(shiftMonth(month, -1)),
        },
        h('span', { class: 'icon icon-chevron-left', 'aria-hidden': 'true' }),
      ),
      h('h2', { class: 'calendar-title' }, title),
      month !== currentMonth &&
        h(
          'button',
          { type: 'button', id: 'cal-today', class: 'link-button', onclick: () => onMonth(currentMonth) },
          t('cycle.thisMonth'),
        ),
      h(
        'button',
        {
          type: 'button',
          id: 'cal-next',
          class: 'icon-button',
          'aria-label': t('cycle.nextMonth'),
          onclick: () => onMonth(shiftMonth(month, 1)),
        },
        h('span', { class: 'icon icon-chevron-right', 'aria-hidden': 'true' }),
      ),
    ),
    h('div', { class: 'calendar-weekdays', 'aria-hidden': 'true' }, weekdayNames().map((name) => h('span', {}, name))),
    h(
      'div',
      { class: 'calendar-grid', role: 'group', 'aria-label': title },
      Array.from({ length: leadingBlanks }, () => h('span', {})),
      days.map((day) => renderDay(analysis.dayInfo(day), day === selected, onSelect)),
    ),
  );
}

function renderDay(info, selected, onSelect) {
  const classes = ['calendar-day'];
  // flow-0: a bleeding day without a logged strength.
  if (info.period === 'logged') classes.push('is-period', `flow-${info.flow ?? 0}`);
  if (info.period === 'predicted') classes.push('is-predicted-period');
  if (info.fertile) classes.push('is-fertile');
  if (info.ovulation) classes.push('is-ovulation');
  if (info.isToday) classes.push('is-today');
  if (info.isFuture) classes.push('is-future');

  return h(
    'button',
    {
      type: 'button',
      id: `day-${info.day}`,
      class: classes.join(' '),
      'aria-pressed': String(selected),
      'aria-current': info.isToday ? 'date' : false,
      'aria-label': describeDay(info),
      onclick: () => onSelect(info.day),
    },
    h('span', { class: 'calendar-date' }, Number(info.day.slice(8))),
    info.ovulation && h('span', { class: 'calendar-marker', 'aria-hidden': 'true' }),
  );
}

/** Spoken label: the date plus what's on it, e.g. "Oct 27, 2026, period, heavy". */
export function describeDay(info) {
  const parts = [formatDay(info.day)];
  if (info.period === 'logged') {
    parts.push(t('cycle.legendPeriod'));
    if (info.flow) parts.push(t(flowLabels[info.flow - 1]));
  }
  if (info.period === 'predicted') parts.push(t('cycle.legendPredicted'));
  if (info.ovulation) parts.push(t('cycle.legendOvulation'));
  else if (info.fertile) parts.push(t('cycle.legendFertile'));
  return parts.join(', ');
}

/** Short weekday names, Monday first (2024-01-01 was a Monday). */
function weekdayNames() {
  const format = new Intl.DateTimeFormat(locale(), { weekday: 'short' });
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(2024, 0, 1 + i)));
}

function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(year, monthNumber - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
