// The weight trend: an exponentially smoothed average of the weigh-ins, as in
// John Walker's "The Hacker's Diet". Day-to-day weight swings by half a kilo
// or more (water, food), which hides the real change; the trend filters that
// out. Each day it moves 10% of the way to the day's weight, so a real change
// shows up over a week or two.
//
// Weigh-ins don't come every day. After a gap of `n` days the new weight
// counts as much as `n` daily steps would let it (1 − 0.9ⁿ), so a weigh-in
// after a long break pulls the trend most of the way to it.
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
