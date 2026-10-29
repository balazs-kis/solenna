import { h, svg } from '../dom.js';
import { daysBetween, formatDay, formatKg } from '../format.js';
import { t } from '../i18n.js';
import { smoothPath } from '../weight-trend.js';

/**
 * Chart of the weigh-ins `entries` as dots and their `trend` (see
 * weight-trend.js) as a line, over the days `from`..`to`. Both are sorted by day.
 *
 * The line is an SVG stretched to fill the plot box (with a non-scaling
 * stroke), while tick labels and dots are HTML positioned in percent, so text
 * and dots stay crisp and readable at any width without measuring anything.
 */
export function renderChart(entries, trend, from, to) {
  const span = Math.max(daysBetween(from, to), 1);
  const x = (day) => (daysBetween(from, day) / span) * 100;
  const { lo, hi, ticks } = yScale([...entries, ...trend].map((entry) => entry.weight_g / 1000));
  const y = (kg) => (1 - (kg - lo) / (hi - lo)) * 100;
  const point = (entry) => [x(entry.day), y(entry.weight_g / 1000)];

  // Painted in order: grid, then the weigh-ins, then the trend on top, so the
  // trend stays readable where weigh-ins crowd together.
  const plotSvg = (...children) =>
    svg('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, children);

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
      plotSvg(ticks.map((kg) => svg('line', { class: 'chart-grid', x1: 0, x2: 100, y1: y(kg), y2: y(kg) }))),
      entries.map((entry) => {
        const [left, top] = point(entry);
        return place(h('span', { class: 'chart-dot' }), { left, top });
      }),
      plotSvg(svg('path', { class: 'chart-line', d: smoothPath(trend.map(point)) })),
      ticks.map((kg) => place(h('span', { class: 'chart-tick' }, formatKg(kg * 1000)), { top: y(kg) })),
    ),
    h('div', { class: 'chart-axis' }, h('span', {}, formatDay(from)), h('span', {}, formatDay(to))),
    // A single weigh-in draws no line, so there's nothing to explain yet.
    // Visual only, like the plot: the figure's label tells screen readers.
    trend.length >= 2 &&
      h(
        'ul',
        { class: 'chart-legend', 'aria-hidden': 'true' },
        h('li', {}, h('span', { class: 'chart-legend-line', 'aria-hidden': 'true' }), t('weight.legendTrend')),
        h('li', {}, h('span', { class: 'chart-legend-dot', 'aria-hidden': 'true' }), t('weight.legendWeighIn')),
      ),
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
