// Calendar days are `YYYY-MM-DD` strings in the user's local time zone, the
// same format the API uses. ISO strings compare correctly as plain strings.

import { locale } from './i18n.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's local calendar day. */
export function todayIso() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, i) => String(part).padStart(i === 0 ? 4 : 2, '0'))
    .join('-');
}

/** Day number since the epoch, ignoring time zones (UTC math on the date parts). */
function dayNumber(day) {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date) / DAY_MS;
}

export function daysBetween(from, to) {
  return dayNumber(to) - dayNumber(from);
}

export function addDays(day, days) {
  return new Date((dayNumber(day) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** e.g. "Oct 26, 2026" / "2026. okt. 26." */
export function formatDay(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'short', day: 'numeric' })
    .format(new Date(year, month - 1, date));
}

/** e.g. "Tuesday, October 27" / "október 27., kedd" */
export function formatDayLong(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(), { weekday: 'long', month: 'long', day: 'numeric' })
    .format(new Date(year, month - 1, date));
}

/** `day` relative to `today`: "today", "tomorrow", "in 9 days", "3 days ago" (localized). */
export function formatRelativeDay(day, today) {
  return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(daysBetween(today, day), 'day');
}

/** A number of days with the right plural: "1 day", "5 days", "5 nap". */
export function formatDays(count) {
  return new Intl.NumberFormat(locale(), { style: 'unit', unit: 'day', unitDisplay: 'long' }).format(count);
}

/** Grams as kilograms with one decimal ("72.4" / "72,4"). `signed` adds +/−. */
export function formatKg(grams, { signed = false } = {}) {
  return new Intl.NumberFormat(locale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(grams / 1000);
}
