// Booking rules and date helpers. Dates and times are stored as Bangalore-local
// strings ("2030-01-08", "09:30"), so results never depend on where the server runs.

const CLINIC = { city: 'Bangalore', timeZone: 'Asia/Kolkata', timeZoneLabel: 'IST' };

const SLOT_TIMES = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  // 13:00-14:00 is the lunch break
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
];
const MAX_DAYS_AHEAD = 30;
const CANCEL_CUTOFF_MINUTES = 120;

const clinicClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: CLINIC.timeZone,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// Current time in Bangalore. FIXED_NOW lets the test server run at a known moment.
function now() {
  if (process.env.FIXED_NOW) return process.env.FIXED_NOW.slice(0, 16);
  const parts = Object.fromEntries(clinicClock.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const today = () => now().slice(0, 10);

function parseDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = parseDate(date);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date; // rejects 2030-02-31
}

function addDays(date, days) {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const dayOfWeek = (date) => parseDate(date).getUTCDay();
const lastBookableDate = () => addDays(today(), MAX_DAYS_AHEAD);

function toMinutes(date, time) {
  const [h, m] = time.split(':').map(Number);
  return parseDate(date).getTime() / 60000 + h * 60 + m;
}

function minutesUntil(date, time) {
  const [nowDate, nowTime] = now().split('T');
  return toMinutes(date, time) - toMinutes(nowDate, nowTime);
}

// Moves a Bangalore-local "YYYY-MM-DDTHH:MM" timestamp, like now() returns, by some minutes.
function shiftTime(timestamp, minutes) {
  const [date, time] = timestamp.split('T');
  return new Date((toMinutes(date, time) + minutes) * 60000).toISOString().slice(0, 16);
}

module.exports = {
  CLINIC, SLOT_TIMES, MAX_DAYS_AHEAD, CANCEL_CUTOFF_MINUTES,
  now, today, lastBookableDate, isValidDate, dayOfWeek, minutesUntil, shiftTime,
};
