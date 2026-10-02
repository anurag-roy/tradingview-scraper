const IST_OFFSET = 330 * 60 * 1000;
export const CLOSE_GRACE_MS = 60_000;

export function readSessionHours(env = process.env) {
  const open = env.DAY_OPEN_TIME?.trim() || '03:30';
  const end = env.DAY_END_TIME?.trim() || '14:00';
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
  if (endMinutes <= openMinutes) {
    throw new Error('DAY_END_TIME must be after DAY_OPEN_TIME in the same IST day. For a full day, use 00:00 to 24:00.');
  }
  return { openMinutes, endMinutes, label: `${open}–${end} IST` };
}

export function sessionAt(now = Date.now(), hours = readSessionHours()) {
  const day = new Date(now + IST_OFFSET).toISOString().slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00+05:30`);
  return { day, start: midnight + hours.openMinutes * 60_000, end: midnight + hours.endMinutes * 60_000 };
}

export function insideSession(bar, timeframe, session) {
  return bar.time * 1000 >= session.start &&
    (bar.time + Number(timeframe) * 60) * 1000 <= session.end;
}

export function canDeliver(closeTime, now, session, boundaryLive = false) {
  return now >= session.start && (now < session.end ||
    (boundaryLive && closeTime === session.end && now <= session.end + CLOSE_GRACE_MS));
}
