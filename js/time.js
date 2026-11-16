// Wall-clock time in a named time zone, independent of the phone’s own zone.

const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }));
  }
  return formatters.get(timeZone);
}

// { date: "2026-11-15", hour: 6, minute: 9 } for an instant, in timeZone.
export function zonedParts(ms, timeZone) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(ms).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

// The instant for a local wall-clock time such as "2026-11-15 06:09" or "2026-11-15T06:00".
export function zonedToMs(local, timeZone) {
  const [date, time = "00:00"] = local.split(/[ T]/);
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  // Correct by the zone’s offset at that moment; the second pass settles DST edges.
  let ms = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(ms, timeZone);
    const [py, pm, pd] = p.date.split("-").map(Number);
    ms += asUtc - Date.UTC(py, pm - 1, pd, p.hour, p.minute);
  }
  return ms;
}

// "2026-11-15" → "2026-11-14" (n = -1). Calendar math only, no time zone involved.
export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const compact = date => date.replaceAll("-", "");

export function hourLabel(hour) {
  const h = hour % 12 || 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

// An instant as a wall-clock time in timeZone: “1:40 PM”.
export function clockTime(ms, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(ms);
}

// Whether the sun is above the horizon at an instant and place: the standard
// low-precision solar position (good to a minute or two), with −0.833° for refraction
// and the sun’s radius.
export function sunIsUp(ms, lat, lon) {
  const rad = Math.PI / 180, d = ms / 86400000 - 10957.5; // days since J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15 * rad;
  const h = gmst + lon * rad - ra;
  const elevation = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(h));
  return elevation > -0.833 * rad;
}
