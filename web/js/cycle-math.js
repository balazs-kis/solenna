// Cycle predictions from logged periods, using the calendar method:
//
// - Cycle day 1 is the first day of real bleeding. Spotting at the start of a
//   period still belongs to the previous cycle, so leading spotting days are
//   skipped when finding where a cycle starts (the calendar still shows them).
// - Cycle and period lengths are averages of the recent history, or typical
//   values (28 / 5 days) until there is enough data.
// - Ovulation is followed by a ~14-day luteal phase that ends the day before
//   the next period, so ovulation is 15 days before the next start (cycle day
//   14 of a 28-day cycle). The luteal phase is the stable part of the cycle, so
//   counting back from the next period beats counting forward.
// - The fertile window is the 5 days before ovulation plus ovulation day,
//   because sperm can survive about 5 days.
//
// The method only says something when it has room to: for short cycles (or
// ovulation landing inside the period) and for overdue periods, ovulation and
// fertility are reported as unknown instead of inventing a date.
//
// These are estimates; the UI says so and never presents them as contraception.
// Pure functions only: no DOM, no state.

import { addDays, daysBetween } from './format.js';

export const TYPICAL_CYCLE_DAYS = 28;
export const TYPICAL_PERIOD_DAYS = 5;
/** Same limit as the server: the longest bleeding accepted as one period. */
export const MAX_PERIOD_DAYS = 15;

const LUTEAL_DAYS = 14;
const FERTILE_DAYS_BEFORE_OVULATION = 5;
/** Below this, there's no room for a follicular phase; ovulation can't be estimated. */
const MIN_CYCLE_FOR_OVULATION = 21;
/** How many recent cycles the averages use. */
const HISTORY = 6;
/** Gaps outside this range are most likely a missed log, not a real cycle. */
const MIN_CYCLE_DAYS = 15;
const MAX_CYCLE_DAYS = 60;
/**
 * Healthy cycles vary by up to about a week, so an overdue period only counts
 * as late after this many days (or the user's own observed variation, if larger).
 */
const LATE_TOLERANCE_DAYS = 5;
const PREDICTED_CYCLES = 3;

/**
 * Everything the cycle screen needs. `periods` are the API's periods sorted by
 * start day; `today` is the local calendar day.
 */
export function analyzeCycle(periods, today) {
  const stats = averages(periods, today);
  const last = periods.at(-1) ?? null;
  const prediction = last
    ? predictCycles(last, stats, today)
    : { cycles: [], expectedStart: null, overdueBy: 0 };
  const flowByDay = new Map(periods.flatMap((p) => p.flow.map((f) => [f.day, f.flow])));
  const lateAfter = Math.max(LATE_TOLERANCE_DAYS, stats.spread);

  return {
    today,
    stats,
    last,
    cycles: prediction.cycles,
    expectedStart: prediction.expectedStart,
    /** Days past the expected start of the next period (0 if not overdue). */
    overdueBy: prediction.overdueBy,
    /** Overdue by more than normal cycle-to-cycle variation. */
    late: prediction.overdueBy > lateAfter,
    /** The logged period that covers `day`, if any. */
    periodOn: (day) => periods.find((p) => day >= p.start_day && day <= loggedEnd(p, today)),
    /** Everything known or predicted about one day, for the calendar. */
    dayInfo: (day) => dayInfo(day, periods, prediction.cycles, flowByDay, today),
  };
}

/**
 * The last day an ongoing period covers so far: today, but never more than the
 * longest period we accept.
 */
export function loggedEnd(period, today) {
  if (period.end_day) return period.end_day;
  const limit = addDays(period.start_day, MAX_PERIOD_DAYS - 1);
  return today < limit ? today : limit;
}

/**
 * Where the cycle of this period starts: its first day that isn't logged as
 * spotting. A period of nothing but spotting (so far) starts on its first day.
 */
export function cycleStart(period, today) {
  const spotting = new Set(period.flow.filter((f) => f.flow === 1).map((f) => f.day));
  let day = period.start_day;
  while (spotting.has(day)) day = addDays(day, 1);
  return day <= loggedEnd(period, today) ? day : period.start_day;
}

/**
 * The end to assume for a period logged as started on `day` before the user
 * says when it stopped: the average length, but not into the next logged
 * period. `null` (ongoing) only if it could plausibly still be going on.
 */
export function assumedEnd(day, periods, periodLength, today) {
  let end = addDays(day, periodLength - 1);
  const next = periods.find((p) => p.start_day > day);
  if (next) {
    const dayBeforeNext = addDays(next.start_day, -1);
    return end < dayBeforeNext ? end : dayBeforeNext;
  }
  if (end >= today) return null;
  return end;
}

function averages(periods, today) {
  const starts = periods.map((p) => cycleStart(p, today));
  const cycleLengths = starts
    .slice(1)
    .map((start, i) => daysBetween(starts[i], start))
    .filter((days) => days >= MIN_CYCLE_DAYS && days <= MAX_CYCLE_DAYS)
    .slice(-HISTORY);
  const periodLengths = periods
    .filter((p) => p.end_day)
    .map((p) => daysBetween(p.start_day, p.end_day) + 1)
    .slice(-HISTORY);

  return {
    cycleLength: average(cycleLengths) ?? TYPICAL_CYCLE_DAYS,
    periodLength: average(periodLengths) ?? TYPICAL_PERIOD_DAYS,
    /** 0 means the cycle length is the typical value, not measured. */
    measuredCycles: cycleLengths.length,
    /** 0 means the period length is the typical value. */
    measuredPeriods: periodLengths.length,
    loggedPeriods: periods.length,
    /** How much the measured cycles vary (longest minus shortest). */
    spread: cycleLengths.length ? Math.max(...cycleLengths) - Math.min(...cycleLengths) : 0,
  };
}

function average(values) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * The current cycle (from the last logged period) plus the next few.
 *
 * If the next period is overdue, the estimate for the current cycle has been
 * proven wrong (most likely ovulation came later than assumed), so its
 * ovulation and phases become unknown and nothing further is predicted.
 */
function predictCycles(last, stats, today) {
  const { cycleLength, periodLength } = stats;
  const start = cycleStart(last, today);
  const ongoing = last.end_day === null;
  const expectedStart = addDays(start, cycleLength);
  const overdueBy = !ongoing && expectedStart < today ? daysBetween(expectedStart, today) : 0;

  // While bleeding, assume the average length (at least until today), but
  // never longer than a period can be.
  let currentPeriodEnd = last.end_day;
  if (ongoing) {
    const typicalEnd = addDays(last.start_day, periodLength - 1);
    const limit = addDays(last.start_day, MAX_PERIOD_DAYS - 1);
    currentPeriodEnd = typicalEnd > today ? typicalEnd : today;
    if (currentPeriodEnd > limit) currentPeriodEnd = limit;
  }

  if (overdueBy > 0) {
    // The current cycle simply runs on until a period is logged.
    const current = {
      start,
      nextStart: addDays(today, 1),
      periodEnd: currentPeriodEnd,
      predicted: false,
      unknown: true,
      ovulation: null,
      fertileStart: null,
      fertileEnd: null,
    };
    return { cycles: [current], expectedStart, overdueBy };
  }

  const cycles = [cycle(start, expectedStart, currentPeriodEnd, false)];
  let next = expectedStart;
  for (let i = 0; i < PREDICTED_CYCLES; i++) {
    const after = addDays(next, cycleLength);
    cycles.push(cycle(next, after, addDays(next, periodLength - 1), true));
    next = after;
  }
  return { cycles, expectedStart, overdueBy: 0 };
}

/**
 * One cycle. `ovulation` and the fertile window are null when the calendar
 * method can't place them: a cycle too short for a follicular phase, or an
 * ovulation that would fall inside the period.
 */
function cycle(start, nextStart, periodEnd, predicted) {
  const ovulation = addDays(nextStart, -(LUTEAL_DAYS + 1));
  const estimable = daysBetween(start, nextStart) >= MIN_CYCLE_FOR_OVULATION && ovulation > periodEnd;
  return {
    start,
    nextStart,
    periodEnd,
    predicted,
    unknown: false,
    ovulation: estimable ? ovulation : null,
    fertileStart: estimable ? addDays(ovulation, -FERTILE_DAYS_BEFORE_OVULATION) : null,
    fertileEnd: estimable ? ovulation : null,
  };
}

/**
 * Fertility level by days before the estimated ovulation, after the
 * conception-probability data of Wilcox et al. (1995): roughly 10-16% for 5 to
 * 3 days before, 27-33% from 2 days before through ovulation day, near zero
 * outside. Only two levels on purpose: the ovulation date is a calendar
 * estimate that is often off by days, so finer per-day levels (or a "peak day")
 * would claim a precision the method doesn't have.
 */
function fertilityLevel(daysBeforeOvulation) {
  if (daysBeforeOvulation >= 0 && daysBeforeOvulation <= 2) return 'high';
  if (daysBeforeOvulation >= 3 && daysBeforeOvulation <= FERTILE_DAYS_BEFORE_OVULATION) return 'medium';
  return null;
}

/**
 * `period` is 'logged', 'predicted' or null. `phase` is null where it can't be
 * estimated. `fertility` is 'medium', 'high' or null, independent of the phase:
 * in short cycles the fertile window can overlap bleeding days.
 * Phases and fertility only cover the last logged cycle onwards; earlier days
 * show logged data only.
 *
 * Days up to today belong to the current (logged) cycle even when a period was
 * predicted for them: until bleeding is actually logged, a new cycle hasn't
 * started, so a due or overdue day is still the end of the current cycle.
 */
function dayInfo(day, periods, cycles, flowByDay, today) {
  const logged = periods.some((p) => day >= p.start_day && day <= loggedEnd(p, today));
  const info = {
    day,
    isToday: day === today,
    isFuture: day > today,
    period: logged ? 'logged' : null,
    flow: logged ? (flowByDay.get(day) ?? null) : null,
    fertility: null,
    phase: null,
    cycleDay: null,
  };

  const predictedBleeding = cycles.some((c) => c.predicted && day >= c.start && day <= c.periodEnd);
  const currentBleeding = cycles[0] && day > today && day >= cycles[0].start && day <= cycles[0].periodEnd;
  if (!logged && day >= today && (predictedBleeding || currentBleeding)) info.period = 'predicted';

  const first = cycles[0];
  const owner =
    first && day <= today && day >= first.start
      ? first
      : cycles.find((c) => day >= c.start && day < c.nextStart);
  if (!owner) return info;

  info.cycleDay = daysBetween(owner.start, day) + 1;
  if (owner.ovulation !== null) {
    info.fertility = fertilityLevel(daysBetween(day, owner.ovulation));
  }
  if (day <= owner.periodEnd) {
    info.phase = 'menstrual';
  } else if (owner.ovulation !== null) {
    if (day < owner.ovulation) info.phase = 'follicular';
    else if (day === owner.ovulation) info.phase = 'ovulation';
    else info.phase = 'luteal';
  }
  return info;
}
