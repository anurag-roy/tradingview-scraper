const IST_OFFSET = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const CLOSE_GRACE_MS = 60_000;

export function readSessionHours(env = process.env) {
  const open = env.DAY_OPEN_TIME?.trim() || '03:30';
  const end = env.DAY_END_TIME?.trim() || '02:00';
  const parse = (value, name, allowMidnightEnd = false) => {
    if (allowMidnightEnd && value === '24:00') return 1440;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw new Error(`${name} must use HH:mm in IST${allowMidnightEnd ? ' (24:00 is allowed for end of day)' : ''}.`);
    }
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  };
  const openMinutes = parse(open, 'DAY_OPEN_TIME');
  const endMinutes = parse(end, 'DAY_END_TIME', true);
  if (endMinutes === openMinutes) {
    throw new Error('DAY_END_TIME must differ from DAY_OPEN_TIME. For a full day, use 00:00 to 24:00.');
  }
  const overnight = endMinutes < openMinutes;
  return { openMinutes, endMinutes, overnight, label: `${open}–${end}${overnight ? ' next day' : ''} IST` };
}

export function sessionAt(now = Date.now(), hours = readSessionHours()) {
  const calendarDay = new Date(now + IST_OFFSET).toISOString().slice(0, 10);
  let midnight = Date.parse(`${calendarDay}T00:00:00+05:30`);
  // The trading day changes at its opening time, keeping after-midnight
  // candles and the post-close break attached to the previous session.
  if (now < midnight + hours.openMinutes * 60_000) midnight -= DAY_MS;
  const day = new Date(midnight + IST_OFFSET).toISOString().slice(0, 10);
  return {
    day, start: midnight + hours.openMinutes * 60_000,
    end: midnight + (hours.endMinutes + (hours.overnight ? 1440 : 0)) * 60_000,
  };
}

export function insideSession(bar, timeframe, session) {
  return bar.time * 1000 >= session.start &&
    (bar.time + Number(timeframe) * 60) * 1000 <= session.end;
}

export function canDeliver(closeTime, now, session, boundaryLive = false) {
  return now >= session.start && (now < session.end ||
    (boundaryLive && closeTime === session.end && now <= session.end + CLOSE_GRACE_MS));
}
