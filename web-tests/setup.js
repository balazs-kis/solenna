// Imported first by every test file, so this runs before any app module loads.

// A time zone with daylight saving time, so the calendar-day tests can catch
// date math that goes through local time (CI runs in UTC, where they couldn't).
process.env.TZ = 'Europe/Budapest';

// i18n.js's activate() sets <html lang>. Node has no page, so give it a
// stand-in before any test switches the language.
globalThis.document = { documentElement: {} };
