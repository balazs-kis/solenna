// Tests for web/js/cycle-math.js: the calendar-method rules described in that
// file and in CLAUDE.md ("Cycle tracking"). Run with `node --test "web-tests/*.test.js"`.

import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeCycle, assumedEnd, checkPastPeriods, cycleStart, todayStatus, withoutFertility } from '../web/js/cycle-math.js';
import { addDays } from '../web/js/format.js';

let nextId = 1;

/** A logged period; `flow` maps days to a strength (1 = spotting), the rest count as real flow. */
function period(start, end, flow = {}) {
  return {
    id: nextId++,
    start_day: start,
    end_day: end,
    flow: Object.entries(flow).map(([day, level]) => ({ day, flow: level })),
  };
}

/** Five-day periods starting on each of `starts`. */
function periods(...starts) {
  return starts.map((start) => period(start, addDays(start, 4)));
}

// Three 28-day cycles; the last one starts on Oct 5, the next is due Nov 2.
const regular = periods('2026-08-10', '2026-09-07', '2026-10-05');

test('averages come from the logged cycles and periods', () => {
  const { stats } = analyzeCycle(regular, '2026-10-18');
  assert.equal(stats.cycleLength, 28);
  assert.equal(stats.periodLength, 5);
  assert.equal(stats.measuredCycles, 2);
  assert.equal(stats.skippedGaps, 0);
});

test('without enough history, lengths fall back to 28 / 5 days', () => {
  const { stats } = analyzeCycle(periods('2026-10-05'), '2026-10-10');
  assert.equal(stats.cycleLength, 28);
  assert.equal(stats.measuredCycles, 0);
  assert.equal(stats.periodLength, 5);
});

test('ovulation is 15 days before the next period, with a 6-day fertile window', () => {
  const [current] = analyzeCycle(regular, '2026-10-18').cycles;
  assert.equal(current.nextStart, '2026-11-02');
  assert.equal(current.ovulation, '2026-10-18');
  assert.equal(current.fertileStart, '2026-10-13');
  assert.equal(current.fertileEnd, '2026-10-18');
});

test('phases follow each other through the cycle', () => {
  const analysis = analyzeCycle(regular, '2026-10-30');
  assert.equal(analysis.dayInfo('2026-10-05').phase, 'menstrual');
  assert.equal(analysis.dayInfo('2026-10-05').cycleDay, 1);
  assert.equal(analysis.dayInfo('2026-10-09').phase, 'menstrual');
  assert.equal(analysis.dayInfo('2026-10-10').phase, 'follicular');
  assert.equal(analysis.dayInfo('2026-10-18').phase, 'ovulation');
  assert.equal(analysis.dayInfo('2026-10-18').cycleDay, 14);
  assert.equal(analysis.dayInfo('2026-10-19').phase, 'luteal');
});

test('fertility has two levels: fertile 5-3 days before ovulation, high from 2 days before', () => {
  const analysis = analyzeCycle(regular, '2026-10-10');
  assert.equal(analysis.dayInfo('2026-10-12').fertility, null);
  assert.equal(analysis.dayInfo('2026-10-13').fertility, 'medium');
  assert.equal(analysis.dayInfo('2026-10-15').fertility, 'medium');
  assert.equal(analysis.dayInfo('2026-10-16').fertility, 'high');
  assert.equal(analysis.dayInfo('2026-10-18').fertility, 'high');
  assert.equal(analysis.dayInfo('2026-10-19').fertility, null);
});

test('with fertility hidden, ovulation day reads as follicular and no day has a fertility level', () => {
  const analysis = withoutFertility(analyzeCycle(regular, '2026-10-30'));
  assert.equal(analysis.dayInfo('2026-10-18').phase, 'follicular');
  for (let day = '2026-10-05'; day <= '2026-10-30'; day = addDays(day, 1)) {
    assert.equal(analysis.dayInfo(day).fertility, null, day);
  }
  // The other phases stay, so the switch to luteal still happens the next day.
  assert.equal(analysis.dayInfo('2026-10-19').phase, 'luteal');
});

test('cycle day 1 is the first day of real flow: leading spotting belongs to the previous cycle', () => {
  const last = period('2026-10-03', '2026-10-09', { '2026-10-03': 1, '2026-10-04': 1 });
  const analysis = analyzeCycle([...periods('2026-08-10', '2026-09-07'), last], '2026-10-20');
  assert.equal(cycleStart(last, '2026-10-20'), '2026-10-05');
  assert.equal(analysis.cycles[0].start, '2026-10-05');
  assert.equal(analysis.dayInfo('2026-10-05').cycleDay, 1);
  assert.equal(analysis.dayInfo('2026-10-04').period, 'logged');
  assert.equal(analysis.dayInfo('2026-10-04').cycleDay, null);
  // Period lengths count from cycle day 1 too: Oct 5-9 is 5 days, not 7.
  assert.equal(analysis.stats.periodLength, 5);
});

test('a spotting-only period starts no cycle and is not counted', () => {
  const spotting = period('2026-10-29', null, { '2026-10-29': 1, '2026-10-30': 1 });
  const analysis = analyzeCycle([...regular, spotting], '2026-10-30');
  assert.equal(analysis.last, spotting);
  assert.notEqual(analysis.cycleLast, spotting);
  assert.equal(analysis.cycles[0].start, '2026-10-05');
  assert.equal(analysis.stats.loggedPeriods, 3);
  // The calendar still shows the spotting days.
  assert.equal(analysis.dayInfo('2026-10-30').period, 'logged');
});

test('a day without a logged strength counts as real flow', () => {
  const last = period('2026-10-05', '2026-10-09', { '2026-10-05': 1 });
  // Oct 6 has no strength logged: the cycle starts there.
  assert.equal(cycleStart(last, '2026-10-20'), '2026-10-06');
});

test('a gap over 1.8x the usual cycle is a missed log and is left out', () => {
  // Gaps 28, 56 (a period never logged), 28.
  const analysis = analyzeCycle(periods('2026-06-15', '2026-07-13', '2026-09-07', '2026-10-05'), '2026-10-10');
  assert.equal(analysis.stats.cycleLength, 28);
  assert.equal(analysis.stats.skippedGaps, 1);
  assert.equal(analysis.stats.measuredCycles, 2);
});

test('real variation is kept: 21 and 35 days average to 28', () => {
  const analysis = analyzeCycle(periods('2026-07-01', '2026-07-22', '2026-08-26'), '2026-08-30');
  assert.equal(analysis.stats.cycleLength, 28);
  assert.equal(analysis.stats.skippedGaps, 0);
  assert.equal(analysis.stats.spread, 14);
});

test('gaps outside 15-60 days are ignored as missed logs', () => {
  // A 70-day gap, then a 28-day one.
  const analysis = analyzeCycle(periods('2026-06-01', '2026-08-10', '2026-09-07'), '2026-09-10');
  assert.equal(analysis.stats.measuredCycles, 1);
  assert.equal(analysis.stats.cycleLength, 28);
});

test('cycles under 21 days get no ovulation or fertile window', () => {
  const analysis = analyzeCycle(periods('2026-08-20', '2026-09-09', '2026-09-29', '2026-10-19'), '2026-10-25');
  assert.equal(analysis.stats.cycleLength, 20);
  assert.equal(analysis.cycles[0].ovulation, null);
  assert.equal(analysis.cycles[0].fertileStart, null);
  // After the period the phase is unknown, not guessed.
  assert.equal(analysis.dayInfo('2026-10-25').phase, null);
  assert.equal(analysis.dayInfo('2026-10-25').fertility, null);
});

test('an overdue period makes the phase unknown and predicts nothing further', () => {
  const analysis = analyzeCycle(regular, '2026-11-04'); // due Nov 2
  assert.equal(analysis.overdueBy, 2);
  assert.equal(analysis.expectedStart, '2026-11-02');
  assert.equal(analysis.cycles.length, 1);
  assert.equal(analysis.cycles[0].ovulation, null);
  assert.equal(analysis.dayInfo('2026-11-04').phase, null);
  assert.equal(analysis.dayInfo('2026-11-04').cycleDay, 31);
});

test('"late" only after 5 days, or the user\'s own cycle spread if larger', () => {
  assert.equal(analyzeCycle(regular, '2026-11-07').late, false); // 5 days over
  assert.equal(analyzeCycle(regular, '2026-11-08').late, true); // 6 days over
  // Cycles of 25 and 33 days: a spread of 8, so 8 days over is still normal.
  const varied = periods('2026-07-01', '2026-07-26', '2026-08-28'); // next due Sep 26
  assert.equal(analyzeCycle(varied, '2026-10-04').late, false);
  assert.equal(analyzeCycle(varied, '2026-10-05').late, true);
});

test('days up to today stay in the current cycle until a period is logged', () => {
  // Due today (Nov 2) but not logged: still cycle day 29, shown as a predicted period.
  const info = analyzeCycle(regular, '2026-11-02').dayInfo('2026-11-02');
  assert.equal(info.cycleDay, 29);
  assert.equal(info.phase, 'luteal');
  assert.equal(info.period, 'predicted');
});

test('an ongoing period assumes the average length, at least until today', () => {
  const ongoing = period('2026-10-28', null);
  const analysis = analyzeCycle([...periods('2026-08-31', '2026-09-28'), ongoing], '2026-10-30');
  assert.equal(analysis.cycles[0].periodEnd, '2026-11-01');
  assert.equal(analysis.dayInfo('2026-10-30').phase, 'menstrual');
  // Bleeding longer than usual: the end moves along with today.
  const later = analyzeCycle([...periods('2026-08-31', '2026-09-28'), ongoing], '2026-11-03');
  assert.equal(later.cycles[0].periodEnd, '2026-11-03');
});

test('a past start gets the average length as its end, never into the next period', () => {
  const logged = periods('2026-09-07', '2026-10-05');
  // Long past, nothing after it: ends after the average length.
  assert.equal(assumedEnd('2026-08-10', [], 5, '2026-10-30'), '2026-08-14');
  // Three days before the next logged period: ends the day before it.
  assert.equal(assumedEnd('2026-09-04', logged, 5, '2026-10-30'), '2026-09-06');
  // Could still be going on: stays ongoing.
  assert.equal(assumedEnd('2026-10-28', [], 5, '2026-10-30'), null);
});

// todayStatus(): what the header, the quick action and the event cards say about today.

test('today: the cycle day, the next period and this cycle\'s fertile window', () => {
  const status = todayStatus(analyzeCycle(regular, '2026-10-18')); // ovulation day
  assert.deepEqual(status.day, { kind: 'cycle', number: 14 });
  assert.equal(status.ongoing, false);
  assert.equal(status.expectedEnd, null);
  assert.equal(status.overdue, null);
  assert.equal(status.nextPeriod, '2026-11-02');
  assert.deepEqual(status.fertile, { start: '2026-10-13', end: '2026-10-18', now: true, thisCycle: true });
  assert.equal(status.ovulation, '2026-10-18');
  assert.equal(status.noOvulationEstimate, false);
});

test('today: after this cycle\'s fertile window, the next one is the next cycle\'s', () => {
  const status = todayStatus(analyzeCycle(regular, '2026-10-25'));
  assert.deepEqual(status.fertile, { start: '2026-11-10', end: '2026-11-15', now: false, thisCycle: false });
  assert.equal(status.ovulation, '2026-11-15');
});

test('today: an ongoing period counts from cycle day 1 and is expected to end, never before today', () => {
  const ongoing = period('2026-10-28', null, { '2026-10-28': 1 }); // leading spotting
  const history = periods('2026-08-31', '2026-09-28');
  const status = todayStatus(analyzeCycle([...history, ongoing], '2026-10-30'));
  assert.deepEqual(status.day, { kind: 'period', number: 2 });
  assert.equal(status.ongoing, true);
  assert.equal(status.expectedEnd, '2026-11-02'); // 5 days from Oct 29
  // Bleeding longer than usual: the expected end moves along with today.
  assert.equal(todayStatus(analyzeCycle([...history, ongoing], '2026-11-05')).expectedEnd, '2026-11-05');
});

test('today: ongoing spotting is counted from its first day and expects no end', () => {
  const spotting = period('2026-10-28', null, { '2026-10-28': 1, '2026-10-29': 1 });
  const status = todayStatus(analyzeCycle([...regular, spotting], '2026-10-29'));
  assert.deepEqual(status.day, { kind: 'spotting', number: 2 });
  assert.equal(status.ongoing, true);
  assert.equal(status.expectedEnd, null);
  // The cycle runs on: the next period is still due.
  assert.equal(status.nextPeriod, '2026-11-02');
});

test('today: an overdue period predicts no next period and no fertile window', () => {
  const status = todayStatus(analyzeCycle(regular, '2026-11-04'));
  assert.deepEqual(status.day, { kind: 'cycle', number: 31 });
  assert.deepEqual(status.overdue, { expectedStart: '2026-11-02', late: false });
  assert.equal(status.nextPeriod, null);
  assert.equal(status.fertile, null);
  assert.equal(status.noOvulationEstimate, false);
});

test('today: short cycles say there is no ovulation estimate', () => {
  const short = periods('2026-08-20', '2026-09-09', '2026-09-29', '2026-10-19');
  assert.equal(todayStatus(analyzeCycle(short, '2026-10-25')).noOvulationEstimate, true);
});

test('today: nothing logged, nothing to say', () => {
  const status = todayStatus(analyzeCycle([], '2026-10-30'));
  assert.equal(status.day, null);
  assert.equal(status.nextPeriod, null);
  assert.equal(status.fertile, null);
});

// checkPastPeriods(): the "add past periods" dialog's rows.

test('past periods: complete rows become periods, empty rows are skipped', () => {
  const results = checkPastPeriods(
    [{ start: '2026-09-15', end: '2026-09-19' }, { start: '', end: '' }],
    periods('2026-10-14'),
    5,
    '2026-10-30',
  );
  assert.deepEqual(results, [{ period: { start_day: '2026-09-15', end_day: '2026-09-19' } }, null]);
});

test('past periods: without an end, a period gets the calendar\'s assumed end (usual length, never into the next one)', () => {
  const logged = periods('2026-10-14');
  const check = (start, today = '2026-10-30') => checkPastPeriods([{ start, end: '' }], logged, 5, today)[0].period?.end_day;
  assert.equal(check('2026-09-15'), '2026-09-19');
  assert.equal(check('2026-10-11'), '2026-10-13'); // the logged period starts Oct 14
  // Could still be going on: saved as ongoing, like a start logged on the calendar.
  assert.deepEqual(checkPastPeriods([{ start: '2026-11-03', end: '' }], [], 5, '2026-11-05')[0], {
    period: { start_day: '2026-11-03', end_day: null },
  });
  // Another row counts as the next period too.
  const rows = [{ start: '2026-09-15', end: '' }, { start: '2026-09-18', end: '2026-09-20' }];
  assert.equal(checkPastPeriods(rows, [], 5, '2026-10-30')[0].period.end_day, '2026-09-17');
});

test('past periods: each row says what is wrong with it', () => {
  const error = (start, end) => checkPastPeriods([{ start, end }], periods('2026-10-14'), 5, '2026-10-30')[0].error;
  assert.equal(error('', '2026-09-19'), 'missingStart');
  assert.equal(error('2026-10-31', ''), 'future');
  assert.equal(error('2026-10-28', '2026-10-31'), 'future');
  assert.equal(error('2026-09-19', '2026-09-15'), 'endBeforeStart');
  assert.equal(error('2026-09-01', '2026-09-16'), 'tooLong'); // 16 days
  assert.equal(error('2026-09-01', '2026-09-15'), undefined); // 15 days is the most
});

test('past periods: overlaps with logged periods and with rows above are caught', () => {
  const logged = [period('2026-10-28', null)]; // ongoing: counts until today
  const rows = [
    { start: '2026-10-12', end: '2026-10-16' },
    { start: '2026-10-15', end: '2026-10-18' },
    { start: '2026-10-29', end: '2026-10-30' },
  ];
  const [first, second, third] = checkPastPeriods(rows, logged, 5, '2026-10-30');
  assert.ok(first.period);
  assert.deepEqual(second, { error: 'overlap', other: { start_day: '2026-10-12', end_day: '2026-10-16' } });
  assert.deepEqual(third, { error: 'overlap', other: { start_day: '2026-10-28', end_day: '2026-10-30' } });
});

test('past periods: an ongoing period that was never ended blocks later rows, like on the server', () => {
  // Started Sep 1 and never ended: it covers Sep 1-15 on the calendar, but
  // the server counts it as open-ended.
  const stale = period('2026-09-01', null);
  const rows = [
    { start: '2026-09-20', end: '2026-09-24' },
    { start: '2026-08-01', end: '2026-08-05' },
  ];
  const [after, before] = checkPastPeriods(rows, [stale], 5, '2026-10-30');
  assert.deepEqual(after, { error: 'afterOngoing', other: stale });
  assert.ok(before.period);
});
