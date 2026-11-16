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
