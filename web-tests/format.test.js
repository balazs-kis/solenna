// Tests for web/js/format.js: calendar-day math and the localized formats.

import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, daysBetween, formatDay, formatDays, formatKg, formatRelativeDay } from '../web/js/format.js';
import { activate } from '../web/js/i18n.js';

test('calendar days add up across months, years and leap days', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-10-05', 28), '2026-11-02');
});

test('days between calendar days ignore daylight saving changes', () => {
  // The EU clocks change on Mar 29 and Oct 25, 2026 (setup.js runs the tests
  // in Budapest time); the count must not.
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.equal(daysBetween('2026-11-02', '2026-10-05'), -28);
});

// The exact strings come from the date and number data bundled with Node,
// which can change between Node versions. If one of these fails after a Node
// update, check the new string: the fix is probably the expected value, not the app.
test('English formats', () => {
  activate('en');
  assert.equal(formatDays(1), '1 day');
  assert.equal(formatDays(5), '5 days');
  assert.equal(formatRelativeDay('2026-10-31', '2026-10-30'), 'tomorrow');
  assert.equal(formatRelativeDay('2026-11-08', '2026-10-30'), 'in 9 days');
  assert.equal(formatRelativeDay('2026-10-27', '2026-10-30'), '3 days ago');
  assert.equal(formatDay('2026-10-28'), 'Oct 28, 2026');
  assert.equal(formatKg(72400), '72.4');
  assert.equal(formatKg(1500, { signed: true }), '+1.5');
  assert.equal(formatKg(0, { signed: true }), '0.0');
});

test('Hungarian formats', () => {
  activate('hu');
  assert.equal(formatDays(5), '5 nap');
  assert.equal(formatRelativeDay('2026-10-31', '2026-10-30'), 'holnap');
  assert.equal(formatKg(72400), '72,4');
  // Hungarian dates end with a period, so translations must not add one after {date}.
  assert.equal(formatDay('2026-10-28'), '2026. okt. 28.');
  activate('en');
});
