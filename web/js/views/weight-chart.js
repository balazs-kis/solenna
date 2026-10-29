import { h, svg } from '../dom.js';
import { daysBetween, formatDay, formatKg } from '../format.js';
import { t } from '../i18n.js';

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
    trend.length >= 2 &&
      h(
        'ul',
        { class: 'chart-legend' },
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

/**
 * An SVG path through `points` (sorted by x, no two on the same x) as a smooth
 * curve: monotone cubic interpolation (Steffen 1990, as in d3's curveMonotoneX).
 * Unlike other smoothing it never overshoots: between two weigh-ins the curve
 * stays between their values, so it never shows a low or high nobody measured.
 * Stretching the SVG keeps it smooth (scaling a Bézier curve gives a Bézier curve).
 */
function smoothPath(points) {
  const n = points.length;
  const secant = (i) => (points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]);
  // The curve's slope at each point.
  const slopes = points.map((_, i) => {
    if (i === 0 || i === n - 1) return 0; // Filled in below, from the neighbour.
    const [s0, s1] = [secant(i - 1), secant(i)];
    const [h0, h1] = [points[i][0] - points[i - 1][0], points[i + 1][0] - points[i][0]];
    const p = (s0 * h1 + s1 * h0) / (h0 + h1);
    // Flat at a peak or dip; otherwise limited so the curve can't overshoot.
    return (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p));
  });
  if (n >= 2) {
    // The ends: two points make a straight line, more lean on the next point's slope.
    slopes[0] = n === 2 ? secant(0) : (3 * secant(0) - slopes[1]) / 2;
    slopes[n - 1] = n === 2 ? secant(0) : (3 * secant(n - 2) - slopes[n - 2]) / 2;
  }

  const xy = ([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`;
  let d = `M${xy(points[0])}`;
  for (let i = 1; i < n; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const third = (x1 - x0) / 3;
    d += `C${xy([x0 + third, y0 + slopes[i - 1] * third])} ${xy([x1 - third, y1 - slopes[i] * third])} ${xy(points[i])}`;
  }
  return d;
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
