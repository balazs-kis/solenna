import { h, svg } from '../dom.js';
import { daysBetween, formatDay, formatKg } from '../format.js';
import { t } from '../i18n.js';

/** Above this many points, dots would just turn the line into a smudge. */
const MAX_DOTS = 60;

/**
 * Line chart of `entries` (sorted by day) over the days `from`..`to`.
 *
 * The lines are an SVG stretched to fill the plot box (with non-scaling
 * strokes), while tick labels and dots are HTML positioned in percent, so text
 * and dots stay crisp and readable at any width without measuring anything.
 */
export function renderChart(entries, from, to) {
  const span = Math.max(daysBetween(from, to), 1);
  const x = (day) => (daysBetween(from, day) / span) * 100;
  const { lo, hi, ticks } = yScale(entries.map((entry) => entry.weight_g / 1000));
  const y = (kg) => (1 - (kg - lo) / (hi - lo)) * 100;
  const points = entries.map((entry) => [x(entry.day), y(entry.weight_g / 1000)]);

  return h(
    'figure',
    {
      class: 'chart',
      role: 'img',
      'aria-label': t('weight.chartLabel', { from: formatDay(from), to: formatDay(to) }),
    },
    h(
      'div',
      { class: 'chart-plot' },
      svg(
        'svg',
        { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        ticks.map((kg) => svg('line', { class: 'chart-grid', x1: 0, x2: 100, y1: y(kg), y2: y(kg) })),
        svg('polyline', { class: 'chart-line', points: points.map((p) => p.join(',')).join(' ') }),
      ),
      ticks.map((kg) => place(h('span', { class: 'chart-tick' }, formatKg(kg * 1000)), { top: y(kg) })),
      entries.length <= MAX_DOTS &&
        points.map(([left, top]) => place(h('span', { class: 'chart-dot' }), { left, top })),
    ),
    h('div', { class: 'chart-axis' }, h('span', {}, formatDay(from)), h('span', {}, formatDay(to))),
  );
}

/**
 * Positions an element in percent of the plot. Uses `element.style` (CSSOM),
 * which the CSP allows; `style="..."` attributes would be blocked.
 */
function place(element, { left, top }) {
  if (left !== undefined) element.style.left = `${left}%`;
  if (top !== undefined) element.style.top = `${top}%`;
  return element;
}

/** Round-numbered kg ticks (at most ~5) covering the values, at least 2 kg tall. */
function yScale(values) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 2) {
    const middle = (min + max) / 2;
    [min, max] = [middle - 1, middle + 1];
  }
  const step = [0.5, 1, 2, 5, 10, 20, 50].find((s) => (max - min) / s <= 4) ?? 100;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = lo; value <= hi + step / 2; value += step) ticks.push(value);
  return { lo, hi, ticks };
}
