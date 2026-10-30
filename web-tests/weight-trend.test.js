// Tests for web/js/weight-trend.js: the trend line and its curve.

import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smoothPath, weightTrend } from '../web/js/weight-trend.js';

test('the trend starts at the first weigh-in', () => {
  assert.deepEqual(weightTrend([{ day: '2026-10-01', weight_g: 80000 }]), [{ day: '2026-10-01', weight_g: 80000 }]);
});

test('each day the trend moves 10% of the way to the weigh-in', () => {
  const trend = weightTrend([
    { day: '2026-10-01', weight_g: 80000 },
    { day: '2026-10-02', weight_g: 81000 },
  ]);
  assert.equal(trend[1].weight_g, 80100);
});

test('after a gap of n days the weigh-in counts as n daily steps (1 - 0.9^n)', () => {
  const trend = weightTrend([
    { day: '2026-10-01', weight_g: 80000 },
    { day: '2026-10-04', weight_g: 81000 },
  ]);
  assert.ok(Math.abs(trend[1].weight_g - 80271) < 1e-6, trend[1].weight_g);
});

test('a steady weight gives a flat trend', () => {
  const steady = ['2026-10-01', '2026-10-02', '2026-10-05'].map((day) => ({ day, weight_g: 75000 }));
  assert.deepEqual(
    weightTrend(steady).map((entry) => entry.weight_g),
    [75000, 75000, 75000],
  );
});

/** The y values of each cubic segment's two control points, with its end points. */
function segments(path) {
  const numbers = path.match(/-?\d+(\.\d+)?/g).map(Number);
  const result = [];
  let start = [numbers[0], numbers[1]];
  for (let i = 2; i < numbers.length; i += 6) {
    const end = [numbers[i + 4], numbers[i + 5]];
    result.push({ startY: start[1], controlYs: [numbers[i + 1], numbers[i + 3]], endY: end[1] });
    start = end;
  }
  return result;
}

test('the curve never overshoots: between two points it stays between their values', () => {
  // A peak, a dip, a step and a flat stretch.
  const points = [
    [0, 50],
    [10, 10],
    [20, 60],
    [30, 55],
    [40, 55],
    [50, 20],
  ];
  // A Bézier curve stays inside its control points, so it's enough that those
  // stay between the segment's end values.
  for (const { startY, controlYs, endY } of segments(smoothPath(points))) {
    const [low, high] = [Math.min(startY, endY), Math.max(startY, endY)];
    for (const y of controlYs) assert.ok(y >= low - 1e-9 && y <= high + 1e-9, `${y} outside ${low}..${high}`);
  }
});

test('the curve passes through every point', () => {
  const points = [
    [0, 5],
    [3, 7],
    [9, 2],
  ];
  const ends = segments(smoothPath(points)).map((segment) => segment.endY);
  assert.deepEqual(ends, [7, 2]);
});

test('two points make a straight line', () => {
  const [segment] = segments(smoothPath([[0, 0], [30, 30]]));
  assert.deepEqual(segment.controlYs, [10, 20]);
});
