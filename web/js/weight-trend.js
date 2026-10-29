// The weight trend: an exponentially smoothed average of the weigh-ins, as in
// John Walker's "The Hacker's Diet". Day-to-day weight swings by half a kilo
// or more (water, food), which hides the real change; the trend filters that
// out. Each day it moves 10% of the way to the day's weight, so a real change
// shows up over a week or two.
//
// Weigh-ins don't come every day. After a gap of `n` days the new weight
// counts as much as `n` daily steps would let it (1 − 0.9ⁿ), so a weigh-in
// after a long break pulls the trend most of the way to it.
//
// The chart draws the trend with smoothPath(), a curve that never overshoots.
// Pure functions only: no DOM, no state.

import { daysBetween } from './format.js';

/** How much of the trend carries over to the next day (Walker's "10% smoothing"). */
const DAILY_CARRY = 0.9;

/**
 * The trend on each weigh-in day: `entries` are the API's weigh-ins sorted by
 * day; the result has the same days, with `weight_g` the trend (not rounded).
 */
export function weightTrend(entries) {
  const trend = [];
  for (const entry of entries) {
    const previous = trend.at(-1);
    if (!previous) {
      trend.push({ day: entry.day, weight_g: entry.weight_g });
      continue;
    }
    const pull = 1 - DAILY_CARRY ** daysBetween(previous.day, entry.day);
    trend.push({ day: entry.day, weight_g: previous.weight_g + pull * (entry.weight_g - previous.weight_g) });
  }
  return trend;
}

/**
 * An SVG path through `points` (sorted by x, no two on the same x) as a smooth
 * curve: monotone cubic interpolation (Steffen 1990, as in d3's curveMonotoneX).
 * Unlike other smoothing it never overshoots: between two points the curve
 * stays between their values, so it never shows a low or high nobody measured.
 * Stretching the SVG keeps it smooth (scaling a Bézier curve gives a Bézier curve).
 */
export function smoothPath(points) {
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
