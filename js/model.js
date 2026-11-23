// The risk model. Pure functions: data in, hourly assessment out. No fetching, no DOM.

import { addDays, clockTime, hourLabel, zonedParts, zonedToMs } from "./time.js";

const KNOT_MS = 0.514444;
const G = 9.81;
const H = 3600e3;
const RANK = { low: 0, caution: 1, high: 2 };

// ---- Tidal current ----------------------------------------------------------------

// Signed speed (knots, flood positive) at an instant, from NOAA slack/max events sorted
// by time. Uses NOAA’s method for subordinate stations: a sine curve from slack up to
// each max and back down to the next slack.
export function currentAt(events, ms) {
  const i = events.findIndex(e => e.ms > ms);
  if (i <= 0) return null; // outside the events we have
  const a = events[i - 1], b = events[i];
  const f = (ms - a.ms) / (b.ms - a.ms);
  const aSlack = a.knots === 0, bSlack = b.knots === 0;
  if (aSlack && bSlack) return 0;
  if (aSlack) return b.knots * Math.sin((Math.PI / 2) * f);
  if (bSlack) return a.knots * Math.cos((Math.PI / 2) * f);
  // Two maxes with no slack between (the current weakens but doesn’t turn).
  return a.knots + (b.knots - a.knots) * (1 - Math.cos(Math.PI * f)) / 2;
}

// The strongest current during the hour starting at startMs, sampled every 6 minutes.
export function peakCurrent(events, startMs) {
  let peak = null;
  for (let m = 0; m <= 60; m += 6) {
    const v = currentAt(events, startMs + m * 60000);
    if (v === null) return null;
    if (peak === null || Math.abs(v) > Math.abs(peak)) peak = v;
  }
  return peak;
}

// The next slacks (the current turning) at or after ms, up to count of them: fewer, or
// none, past the events we have.
export function nextSlacks(events, ms, count = 2) {
  return events.filter(e => e.ms >= ms && e.knots === 0).slice(0, count).map(e => e.ms);
}

// “Slack at 10:24 AM and tomorrow at 1:14 AM”. A day word shared by every slack comes
// once, up front: “Slack tomorrow at 1:14 AM and 7:40 AM”.
function slackLine(slacks, startMs, timeZone) {
  const today = zonedParts(startMs, timeZone).date;
  const day = ms => zonedParts(ms, timeZone).date === today ? "" : "tomorrow ";
  const clock = ms => clockTime(ms, timeZone);
  return new Set(slacks.map(day)).size === 1
    ? `Slack ${day(slacks[0])}at ${slacks.map(clock).join(" and ")}`
    : `Slack ${slacks.map(ms => `${day(ms)}at ${clock(ms)}`).join(" and ")}`;
}

// Current thresholds as speed at the beach (knots, to the tenth shown on the card):
// depth × speed at chest depth reaching the spot’s caution and high limits.
export function currentKnots(spot) {
  const kn = dv => round1(dv / (spot.standingDepthM * KNOT_MS));
  return { caution: kn(spot.thresholds.currentDV.caution), high: kn(spot.thresholds.currentDV.high) };
}

// Each factor’s thresholds in the units its card shows, for the day curves.
export function thresholds(spot) {
  return { current: currentKnots(spot), waves: spot.thresholds.beachWaveFt, wind: spot.thresholds.windMph };
}

// Ratings compare the number as the card shows it, so “0.6 kn” is never rated below a
// 0.6 kn line because it was really 0.58.
const levelFor = (x, { caution, high }) => x >= high ? "high" : x >= caution ? "caution" : "low";

export function assessCurrent(events, startMs, spot) {
  const channel = peakCurrent(events, startMs);
  if (channel === null) return unknown("No current prediction covers this hour.");
  const beach = round1(Math.abs(channel) * spot.current.nearshoreFactor);
  const level = levelFor(beach, currentKnots(spot));
  const way = Math.abs(channel) < 0.05 ? "Near slack"
    : channel < 0 ? spot.current.ebb : spot.current.flood;
  const slacks = nextSlacks(events, startMs);
  return {
    level,
    amount: beach,
    value: `${fmt(beach)} kn`,
    notes: [
      way,
      slacks.length ? slackLine(slacks, startMs, spot.timeZone) : null,
    ].filter(Boolean),
  };
}

// ---- Tide -------------------------------------------------------------------------

// The tide (feet above MLLW) at an instant, from NOAA’s highs and lows
// ({ ms, ft, type }, in time order): half a cosine from each one to the next, the way
// tide tables are read between their entries. Null outside the list.
export function tideAt(turns, ms) {
  const i = turns.findIndex((t, k) => k + 1 < turns.length && ms >= t.ms && ms <= turns[k + 1].ms);
  if (i < 0) return null;
  const a = turns[i], b = turns[i + 1];
  return a.ft + (b.ft - a.ft) * (1 - Math.cos(Math.PI * (ms - a.ms) / (b.ms - a.ms))) / 2;
}

// The water level (feet above MLLW) at an instant, from tide as sources.js gives it
// ({ turns, levels }): the STOFS forecast where its levels reach, drawn as a smooth
// curve through its half-hourly values (Catmull–Rom); NOAA’s highs and lows, tide
// only, elsewhere. Near either end of the forecast the two fade into each other over a
// few hours, so the line doesn’t jump where the forecast starts or stops (as for
// yesterday, when the server hasn’t kept the runs that reach back that far). Null
// where neither reaches.
export function levelAt(tide, ms) {
  const i = levelIndex(tide.levels, ms), only = tideAt(tide.turns, ms);
  if (i < 0) return only;
  const L = tide.levels, p = k => L[Math.min(L.length - 1, Math.max(0, k))].ft;
  const f = (ms - L[i].ms) / (L[i + 1].ms - L[i].ms);
  const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
  const forecast = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
  return only === null ? forecast : only + (forecast - only) * surgeWeight(L, ms);
}
// Whether the number at the instant is mostly the STOFS forecast, surge and all,
// rather than the tide alone.
export const hasSurge = (tide, ms) => levelIndex(tide.levels, ms) >= 0 && surgeWeight(tide.levels, ms) >= 0.5;
const EDGE_FADE_MS = 3 * 3600e3;
const surgeWeight = (levels, ms) => Math.min(1, (ms - levels[0].ms) / EDGE_FADE_MS, (levels.at(-1).ms - ms) / EDGE_FADE_MS);
// The level just before ms, when ms sits between two levels.
function levelIndex(levels, ms) {
  if (!levels || levels.length < 2 || ms < levels[0].ms || ms > levels.at(-1).ms) return -1;
  return Math.min(levels.length - 2, levels.findLastIndex(l => l.ms <= ms));
}

// NOAA’s highs and lows, each at the water level then: the time is the tide’s, the
// height includes the surge where the forecast reaches. That’s how NWS states a high
// in a coastal flood forecast (the tide’s time, the tide plus the surge’s height).
export const highsAndLows = tide => tide.turns.map(t => ({ ...t, ft: levelAt(tide, t.ms) ?? t.ft }));

// Tide isn’t rated: it’s shown for planning. Level “unrated”, with whether it’s rising
// or falling where a rating would go, the next high or low, whether surge is in the
// number, and any coastal flood warning or advisory in force (from NWS alerts).
export function assessTide(tide, startMs, spot, alerts = []) {
  const ft = levelAt(tide, startMs);
  if (ft === null) return unknown("No tide prediction covers this hour.");
  const next = highsAndLows(tide).find(t => t.ms > startMs);
  if (!next) return unknown("No tide prediction covers this hour.");
  const rising = next.type === "high";
  const flood = (alerts ?? []).find(a => /coastal flood/i.test(a.event) && a.onsetMs <= startMs && (!a.endsMs || a.endsMs > startMs));
  return {
    level: "unrated",
    amount: ft,
    trend: rising ? "Rising" : "Falling",
    value: `${feet(ft)} ft ${rising ? "↑" : "↓"}`,
    notes: [
      `${rising ? "High" : "Low"} ${feet(next.ft)} ft at ${clockTime(next.ms, spot.timeZone)}`,
      hasSurge(tide, startMs) ? "Forecast with storm surge" : "Tide only, without storm surge",
      flood ? `${flood.event.charAt(0)}${flood.event.slice(1).toLowerCase()} in effect` : null,
    ].filter(Boolean),
  };
}
// Feet to a tenth, with a true minus sign: “−0.6”.
export const feet = ft => fmt(Math.abs(ft) < 0.05 ? 0 : ft).replace("-", "−");

// ---- Waves ------------------------------------------------------------------------

// Share of an offshore swell that reaches the beach, by period and direction.
export function transferFactor(periodS, dirDeg, waves) {
  const t = waves.transfer;
  const byPeriod = clamp(t.baseFactor + (periodS - t.basePeriodS) * t.perSecond, t.minFactor, t.maxFactor);
  const e = waves.exposure;
  const byDir = dirDeg < e.zeroFrom || dirDeg > e.zeroTo ? 0
    : dirDeg < e.fullFrom ? (dirDeg - e.zeroFrom) / (e.fullFrom - e.zeroFrom)
    : dirDeg > e.fullTo ? (e.zeroTo - dirDeg) / (e.zeroTo - e.fullTo)
    : 1;
  return byPeriod * byDir;
}

// Estimated wave height at the beach from offshore swells ([{ ft, periodS, dirDeg }]),
// each scaled by how much of it gets through the Gate. The fallback when the NWS
// nearshore model isn’t available.
export function beachWaveFt(swells, spot) {
  const parts = (swells ?? []).filter(c => c.ft > 0 && c.periodS > 0 && c.dirDeg != null);
  if (!parts.length) return null;
  // Heights of separate swells combine as the root of the summed squares (their energy adds).
  return Math.hypot(...parts.map(c => c.ft * transferFactor(c.periodS, c.dirDeg, spot.waves)));
}

// The height waves break at (feet) on an open beach, from their significant height
// (hsM, meters) and peak period (tpS, seconds) where the water is depthM deep, as a
// nearshore model such as CDIP’s gives them. Linear wave theory takes the height back to
// deep water, as if the seafloor hadn’t shoaled it yet (the model has already bent it
// toward the beach), and Komar and Gaudet’s formula (1973) breaks it: Hb = 0.39 g^⅕ (T H₀²)^⅖.
// Long-period swell grows the most on its way in: 1 m at 13 s breaks at about 1.6 m.
export function breakerFt({ hsM, tpS, depthM }) {
  if (!(hsM > 0) || !(tpS > 0) || !(depthM > 0)) return null;
  const w = 2 * Math.PI / tpS;
  // Wavenumber where the water is depthM deep: solve w² = g k tanh(k h) (Newton’s method).
  let k = w * w / G;
  for (let i = 0; i < 30; i++) {
    const t = Math.tanh(k * depthM);
    k -= (G * k * t - w * w) / (G * t + G * k * depthM * (1 - t * t));
  }
  const kh = k * depthM;
  const groupSpeed = (w / k) / 2 * (1 + 2 * kh / Math.sinh(2 * kh));
  const deepGroupSpeed = G / (2 * w);
  const deepM = hsM / Math.sqrt(deepGroupSpeed / groupSpeed);
  return 0.39 * G ** 0.2 * (tpS * deepM * deepM) ** 0.4 / 0.3048;
}

// waves: one hour, one of { beachFt } from the NWS nearshore model, { swells } from the
// offshore forecast, or { nearshore: { hsM, tpS, depthM } } from CDIP’s model off an open
// beach, rated on the height the waves break at.
export function assessWaves(waves, spot) {
  const breaking = waves?.nearshore ? breakerFt(waves.nearshore) : null;
  const raw = breaking ?? waves?.beachFt ?? beachWaveFt(waves?.swells, spot);
  if (raw == null) return unknown("No wave forecast for this hour.");
  const beach = round1(raw);
  return { level: levelFor(beach, spot.thresholds.beachWaveFt), amount: beach, value: `${fmt(beach)} ft`,
    notes: breaking == null ? [] : [`Breaking height, ${Math.round(waves.nearshore.tpS)}-second swell`] };
}

// ---- Wind and water temperature ----------------------------------------------------

// Which way a wind from fromDir (compass point, such as "SSW") pushes a wader, against
// the way the beach faces: out, in, or along the shore. Null when there’s no direction.
export function windPush(fromDir, shoreFacingDeg) {
  const i = COMPASS.indexOf(fromDir);
  if (i < 0) return null;
  // Angle between where the wind comes from and the open water: 0 means it blows in.
  const off = Math.abs(((i * 22.5 - shoreFacingDeg) % 360 + 540) % 360 - 180);
  if (off <= 45) return "Onshore, pushing you in";
  if (off >= 135) return "Offshore, pushing you out";
  const toward = (i * 22.5 + 180) % 360;
  return `Along the shore, pushing you ${CARDINAL[Math.round(toward / 90) % 4]}`;
}

export function assessWind(wind, spot) {
  if (!wind) return unknown("No wind measurement or forecast for this hour.");
  return { level: levelFor(wind.mph, spot.thresholds.windMph), amount: wind.mph, value: `${wind.mph} mph`,
    notes: [windPush(wind.dir, spot.shoreFacingDeg)].filter(Boolean) };
}

// temp.estimate: a day ahead, carrying the latest reading, which the note names by its
// day (“Sun 22”, as on the sky line) since “today” reads wrong on a day ahead.
export function assessWaterTemp(temp, spot) {
  if (!temp) return unknown("No water temperature reading for this hour.");
  const level = temp.f < spot.thresholds.waterTempF.caution ? "caution" : "low";
  if (!temp.estimate) return { level, value: `${Math.round(temp.f)}°F`, notes: [] };
  const { date } = zonedParts(temp.ms, spot.timeZone);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(Date.parse(date));
  return { level, value: `~${Math.round(temp.f)}°F`,
    notes: [`Estimate based on the ${day} ${Number(date.slice(8))} reading, since water temperature isn’t forecast.`] };
}

// ---- Water quality ----------------------------------------------------------------

// rain: { startMs, inches: [one per hour from startMs], observedUntilMs, gauge } from
// sources.js. The rain in the 24 hours up to and including hour t, to the hundredth.
function daySum(rain, t) {
  let x = 0;
  for (let k = Math.max(0, t - 23); k <= t; k++) x += rain.inches[k] ?? 0;
  return round2(x);
}

// The latest hour up to the one starting at ms when rain was falling and the 24 hours
// to it held at least atLeast inches, or null: { endMs, the end of that hour; forecast,
// whether it’s forecast rather than measured }.
export function lastRain(rain, ms, atLeast) {
  if (!rain) return null;
  for (let t = Math.min(Math.floor((ms - rain.startMs) / H), rain.inches.length - 1); t >= 0; t--) {
    if (!(rain.inches[t] > 0) || daySum(rain, t) < atLeast) continue;
    const hourMs = rain.startMs + t * H;
    return { endMs: hourMs + H, forecast: hourMs >= rain.observedUntilMs };
  }
  return null;
}

// When, after the hour starting at ms, the rain next reaches atLeast inches in a day:
// the hour it starts to count, which is when the rating changes. Drizzle leading up to
// it doesn’t count. Null if none is forecast.
export function nextRain(rain, ms, atLeast) {
  if (!rain) return null;
  for (let t = Math.max(0, Math.floor((ms - rain.startMs) / H) + 1); t < rain.inches.length; t++) {
    if (rain.inches[t] > 0 && daySum(rain, t) >= atLeast) return rain.startMs + t * H;
  }
  return null;
}

// When a stretch that rain keeps restarting ends: hours after fromMs, pushed later by
// each rain of at least atLeast inches (measured or forecast) that falls before it ends.
export function endAfterRain(rain, fromMs, atLeast, hours) {
  let end = fromMs + hours * H;
  for (;;) {
    const next = lastRain(rain, end - H, atLeast);
    if (!next || next.endMs + hours * H <= end) return end;
    end = next.endMs + hours * H;
  }
}

// One hour’s water quality, from the day’s SFPUC posting and the rain around it.
// quality: { status, reason, sampled: "2026-11-09" | null, sinceMs } from sources.js.
// status is "clean", "posted" or "unsampled" for a reading; "unrecorded" for a past day
// with no record of its posting. reason, for a posting: "overflow" or "bacteria".
// sinceMs: when the posting began, where known. rain: as for lastRain, or null when it
// didn’t load.
//
// The newest evidence wins: rain only counts if it ended after the last sample, so a
// clean sample taken after a storm clears it.
//
// First match wins:
//   1. Posted → Hazardous (high). SFPUC samples an overflow posting daily and lifts it
//      when the water is clean, so through today an overflow posting stands as is. A
//      bacteria posting (sampled weekly), or an overflow posting on a day ahead, lasts
//      72 hours from the sample, the overflow or the last heavy rain. Forecast rain more
//      than 3 days past the last measurement doesn’t restart the clock. Without rain
//      data, or a start to count from, a posting never ages.
//   2. Rain (≥ cautionIn in a day) in the last 72 hours → Recent rain (caution), measured
//      or forecast, however heavy. Rain doesn’t always bring bacteria, and a storm can
//      flush out what earlier rain washed in; only a sample shows what’s in the water,
//      so rain alone puts swimmers on alert but never rates High.
//   3. Posted but aged out, or a clean sample under 8 days old → OK (low).
//   4. Anything else → unrated.
//
// Each card says, at most: when it changes, then what SFPUC last said. An advisory says
// what started its 72 hours, when they run out, and what forecast rain could keep it
// going: “Last rain yesterday at 2 AM. Advisory ends Tuesday night, but may be extended
// by rain expected Monday night.” Its end counts from that rain alone, never from rain
// still to come. Rain that has fallen is named by its hour; rain still to come, and
// every end, by a part of the day, as they rest on forecasts (“Rain expected Tuesday
// afternoon through Wednesday morning. Advisory would end Saturday morning.”). Days ahead are said from today,
// by weekday, never as their own “today”: rain on them is still to come.
export function assessWaterQuality(quality, rain, startMs, spot) {
  const wq = spot.waterQuality, r = spot.rain, tz = spot.timeZone;
  const q = quality?.status ? quality : null;
  const sampleMs = q?.sampled ? zonedToMs(`${q.sampled} ${String(wq.sampleHour).padStart(2, "0")}:00`, tz) : null;
  // Days are said from the hour shown, or for a day ahead, from now (the last
  // measurement), so a day ahead isn’t its own “today”.
  const fromMs = rain ? Math.min(startMs, rain.observedUntilMs - 1) : startMs;
  const when = ms => partOfDay(ms, fromMs, tz);
  // A stretch ending at ms lasts through the hour before it.
  const until = ms => when(ms - 1);
  // Without rain data, the card says what it left out and, where it would otherwise be
  // OK, what to do instead; retry asks the app to offer loading again.
  const unseen = rain ? null : "Rain data didn’t load, so recent rain wasn’t considered.";
  const noRain = unseen && `${unseen} If it’s rained in the last ${r.afterHours / 24} days, use caution.`;
  const retry = rain ? {} : { retry: true };
  const newer = x => x && (sampleMs == null || x.endMs > sampleMs) ? x : null;
  const heavy = newer(lastRain(rain, startMs, r.highIn)), light = newer(lastRain(rain, startMs, r.cautionIn));
  const unsure = x => x?.forecast && startMs - rain.observedUntilMs > r.sureForecastHours * H;
  const recent = x => x && startMs < x.endMs + r.afterHours * H;

  let posted = null;
  if (q?.status === "posted") {
    const overflow = q.reason === "overflow";
    const fromMs = overflow && q.sinceMs ? q.sinceMs : sampleMs;
    const on = fromMs ? ` ${shortDate(zonedParts(fromMs, tz).date)}` : "";
    // Past the forecast it trusts, the clock counts from the last heavy rain it does.
    const restart = unsure(heavy) ? newer(lastRain(rain, rain.observedUntilMs + (r.sureForecastHours - 1) * H, r.highIn)) : heavy;
    const startsMs = [sampleMs, restart?.endMs, overflow ? q.sinceMs : null].filter(Number.isFinite);
    const ahead = rain && zonedParts(startMs, tz).date > zonedParts(rain.observedUntilMs - 1, tz).date;
    const noStart = !rain || (overflow ? !ahead || (!q.sinceMs && !restart) : !sampleMs);
    const endsMs = noStart ? Infinity : endAfterRain(rain, Math.max(...startsMs), r.highIn, wq.postingHours);
    if (startMs < endsMs) {
      return { level: "high", value: "Hazardous",
        why: `Posted for ${POSTED_FOR[q.reason] ?? "bacteria or a sewer overflow"}.`,
        notes: [`Warning until ${Number.isFinite(endsMs) ? until(endsMs) : "SFPUC resamples"}.`,
          `Posted${on}${q.reason ? ` for ${POSTED_FOR[q.reason]}` : ""}.`, unseen].filter(Boolean), ...retry };
    }
    posted = `Warning posted${on}, not yet resampled.`;
  }

  // What SFPUC last said, under the line about when things change.
  const sampleAge = sampleMs == null ? Infinity : startMs - sampleMs;
  const freshClean = q?.status === "clean" && sampleAge <= wq.cleanForDays * 24 * H;
  const status = posted ?? (freshClean ? `Last sample, ${shortDate(q.sampled)}, was clean.`
    : q?.status === "unsampled" ? "SFPUC isn’t sampling here right now." : null);
  // The rain behind an advisory: the whole spell the last counting hour is part of, so
  // an advisory shown in the middle of rain ends after it. Measured rain is named by its
  // last hour; forecast rain by when it’s expected to start and stop counting.
  if (recent(light)) {
    const spell = rainSpell(rain, light.endMs, r.cautionIn);
    const endsMs = spell.endMs + r.afterHours * H;
    const next = nextRain(rain, Math.max(startMs, spell.endMs - H), r.cautionIn);
    const extended = next != null && next < endsMs ? `, but may be extended by rain expected ${when(next)}` : "";
    const lastHourMs = spell.endMs - H;
    const [from, to] = [when(spell.fromMs), until(spell.endMs)];
    const cause = light.forecast ? `Rain expected ${from}${to === from ? "" : ` through ${to}`}.`
      : `Last rain ${dayWord(lastHourMs, fromMs, tz)} at ${hourLabel(zonedParts(lastHourMs, tz).hour)}.`;
    return { level: "caution", value: "Recent rain",
      notes: [`${cause} Advisory ${light.forecast ? "would end" : "ends"} ${until(endsMs)}${extended}.`, status].filter(Boolean) };
  }
  if (posted || freshClean) {
    const next = nextRain(rain, startMs, r.cautionIn);
    return { level: "low", value: "OK",
      notes: [next ? `Until ${when(next)}, when rain is expected.` : null, status, noRain].filter(Boolean),
      ...retry };
  }
  if (!q) return unknown(quality ? "No record of this day’s posting." : "SFPUC didn’t load.");
  switch (q.status) {
    case "clean": return unknown(q.sampled ? `No sample since ${shortDate(q.sampled)}.` : "No recent sample.");
    case "unsampled": return unknown("SFPUC isn’t sampling here right now.");
    case "unrecorded": return unknown("No record of this day’s posting.");
    default: return unknown("No water quality for this day.");
  }
}
const POSTED_FOR = { overflow: "a sewer overflow", bacteria: "high bacteria" };

// The spell of rain around the counting hour that ends at endMs, through the wet hours
// next to it that keep counting and are the same kind (measured or forecast): when it
// starts to count (fromMs) and when its last counting hour ends (endMs). Measured rain
// that goes on into the forecast is a spell that may be extended, not a longer one.
function rainSpell(rain, endMs, atLeast) {
  const forecast = t => rain.startMs + t * H >= rain.observedUntilMs;
  const at = Math.floor((endMs - rain.startMs) / H) - 1;
  const counts = t => t >= 0 && t < rain.inches.length && rain.inches[t] > 0 && daySum(rain, t) >= atLeast
    && forecast(t) === forecast(at);
  let first = at, last = at;
  while (counts(first - 1)) first--;
  while (counts(last + 1)) last++;
  return { fromMs: rain.startMs + first * H, endMs: rain.startMs + (last + 1) * H };
}

// The day of an instant, said from the hour starting fromMs: “today”, “yesterday”,
// “tomorrow”, “Thursday”.
function dayWord(ms, fromMs, timeZone) {
  const date = zonedParts(ms, timeZone).date;
  const days = (Date.parse(date) - Date.parse(zonedParts(fromMs, timeZone).date)) / 864e5;
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(Date.parse(date));
}

// An instant as a part of the day, said from the hour starting fromMs: “this
// afternoon”, “tonight”, “tomorrow morning”, “Sunday evening”, or past a week, “Nov 29”.
// Night runs from 9 PM to 5 AM and belongs to the evening it starts in.
const PARTS = [[21, "night"], [17, "evening"], [12, "afternoon"], [5, "morning"]];
export function partOfDay(ms, fromMs, timeZone) {
  const at = zonedParts(ms, timeZone);
  const date = at.hour < 5 ? addDays(at.date, -1) : at.date;
  const part = at.hour < 5 ? "night" : PARTS.find(([h]) => at.hour >= h)[1];
  const days = (Date.parse(date) - Date.parse(zonedParts(fromMs, timeZone).date)) / 864e5;
  if (days <= 0) return part === "night" ? "tonight" : `this ${part}`;
  if (days === 1) return `tomorrow ${part}`;
  if (days >= 7) return shortDate(date);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(Date.parse(date));
  return `${weekday} ${part}`;
}

// ---- Sky ---------------------------------------------------------------------------

// NWS gridpoint weather for one hour → the words the NWS hourly forecast would use.
// cover: sky cover %, wx: { coverage, weather, intensity } or null, day: sun is up.
// “Slight chance light rain”, “Light rain likely”, “Patchy fog”, “Mostly sunny”.
const COVERAGE = { slight_chance: "Slight chance", chance: "Chance", isolated: "Isolated", scattered: "Scattered",
  numerous: "Numerous", patchy: "Patchy", areas: "Areas of", widespread: "Widespread", occasional: "Occasional",
  frequent: "Frequent", intermittent: "Intermittent", periods: "Periods of", brief: "Brief" };
const WEATHER = { rain_showers: "showers", thunderstorms: "thunderstorms", freezing_fog: "freezing fog",
  freezing_rain: "freezing rain", freezing_drizzle: "freezing drizzle", snow_showers: "snow showers" };
export function skyText({ cover, wx, day }) {
  if (wx) {
    const intensity = { very_light: "very light", light: "light", heavy: "heavy" }[wx.intensity];
    const what = [intensity, WEATHER[wx.weather] ?? wx.weather.replace(/_/g, " ")].filter(Boolean).join(" ");
    const text = wx.coverage === "likely" ? `${what} likely` : [COVERAGE[wx.coverage], what].filter(Boolean).join(" ");
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  }
  // NWS sky-cover words, in eighths of the sky: 0–1 clear, 1–3 mostly, 3–5 partly, 5–7 mostly cloudy.
  const words = day ? ["Sunny", "Mostly sunny", "Partly sunny", "Mostly cloudy", "Cloudy"]
    : ["Clear", "Mostly clear", "Partly cloudy", "Mostly cloudy", "Cloudy"];
  return words[[12.5, 37.5, 62.5, 87.5].filter(t => cover > t).length];
}

// sky: { text: "Partly Sunny", rainPct: 20, day: true } from the NWS forecast, or
// { text: "A Few Clouds", day: true, observed: "SFO" } as reported at a station →
// which icon to draw. Order matters: “Chance Showers And Thunderstorms” is a storm,
// “Partly Cloudy” is partly, not cloudy.
export function skyKind(sky) {
  const t = sky.text.toLowerCase();
  if (/thunder|t-storm/.test(t)) return "storm";
  // Drops show intensity; the chance of rain is the % on the sky line.
  if (/heavy/.test(t) && /rain|shower/.test(t)) return "rain-heavy";
  if (/drizzle|light (rain|shower)/.test(t)) return "rain-light";
  if (/rain|shower|sleet|snow/.test(t)) return "rain";
  if (/fog|haze|smoke|mist/.test(t)) return "fog";
  if (/partly|mostly sunny|mostly clear|few clouds/.test(t)) return sky.day ? "partly-day" : "partly-night";
  if (/cloud|overcast/.test(t)) return "cloud";
  return sky.day ? "sun" : "moon";
}

// The lowest chance of rain worth showing. NWS forecasts don’t mention rain below 20%
// (“Slight chance” starts there), so a lower number is noise next to a dry sky.
const RAIN_SHOWN = 20;
export const showsRain = pct => Math.round(pct) >= RAIN_SHOWN;

// “Partly sunny · 20% rain”, or “Light rain · 28% chance” when rain is forecast: the
// percentage already says how likely, so NWS’s hedge words (“Slight chance”, “likely”)
// go. Under 20% a dry sky drops the number (“Mostly sunny”); a wet one keeps it, so rain
// never goes without its odds. “Patchy fog” keeps “Patchy”, which is about where, not
// how likely. A reported sky says where it was seen instead: “Light rain · at SFO”.
const HEDGES = /^(slight chance|chance|isolated|scattered|numerous|occasional|periods of) | likely$/gi;
export function skyLine(sky) {
  if (sky.observed) {
    const words = sky.text.toLowerCase();
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} · at ${sky.observed}`;
  }
  const wet = /rain|shower|drizzle|thunder/i.test(sky.text);
  // A thunderstorm always rains, so “Showers and thunderstorms” says no more than “Thunderstorms”.
  const words = (wet ? sky.text.replace(HEDGES, "") : sky.text).toLowerCase()
    .replace(/^showers and thunderstorms\b/, "thunderstorms");
  const line = `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  if (!wet && !showsRain(sky.rainPct)) return line;
  return `${line} · ${Math.round(sky.rainPct)}% ${wet ? "chance" : "rain"}`;
}

// ---- NWS advisories ----------------------------------------------------------------

// The NWS events that bear on being in the water, each with a short name for the card’s
// one-line summary. Everything else at this point (heat, frost, air quality) is left out.
const ADVISORY_TOPICS = [
  [/coastal flood/i, "flooding"],
  [/high surf/i, "high surf"],
  [/rip current/i, "rip currents"],
  [/beach hazards/i, "beach hazards"],
  [/tsunami/i, "tsunami"],
  [/^storm (warning|watch)$|hurricane force wind/i, "storm-force winds"],
  [/gale/i, "gale"],
  [/high wind|extreme wind|wind advisory/i, "high winds"],
  [/hazardous seas/i, "hazardous seas"],
  [/small craft/i, "small craft"],
  [/special marine/i, "marine warning"],
];

// alerts: [{ event, ... }] as normalized by sources.js → the water-relevant ones, each
// with its topic added.
export function waterAdvisories(alerts) {
  return (alerts ?? []).flatMap(a => {
    const topic = ADVISORY_TOPICS.find(([re]) => re.test(a.event))?.[1];
    return topic ? [{ ...a, topic }] : [];
  });
}

// “Flooding, high surf, high winds”
export function advisorySummary(advisories) {
  const s = [...new Set(advisories.map(a => a.topic))].join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// An NWS description, hard-wrapped with “* WHAT...” bullets, as plain paragraphs:
// “What: Breaking waves of 18 to 24 ft.”
export function advisoryParagraphs(description) {
  return (description ?? "").split(/\n\s*\n/)
    .map(p => p.replace(/\s*\n\s*/g, " ").trim()
      .replace(/^\*\s*([A-Z][A-Z ]*?)\.\.\.\s*/, (_, label) => `${label.charAt(0)}${label.slice(1).toLowerCase()}: `))
    .filter(Boolean);
}

// ---- One hour, all factors ---------------------------------------------------------

// data: one day of { currents, tide, waves, wind, waterTemp, waterQuality, rain } as normalized by sources.js
// (each may be null when its source failed).
export function assessHour(hour, startMs, data, spot) {
  const factors = {
    current: data.currents ? assessCurrent(data.currents, startMs, spot) : unknown("Current predictions didn’t load."),
    waves: data.waves ? assessWaves(data.waves[hour], spot) : unknown("Wave forecast didn’t load."),
    // Measured where the hour has passed, forecast otherwise.
    wind: assessWind(data.windObserved?.[hour] ?? data.wind?.[hour], spot),
    tide: data.tide ? assessTide(data.tide, startMs, spot, data.alerts) : unknown("Tide predictions didn’t load."),
    waterTemp: data.waterTemp ? assessWaterTemp(data.waterTemp[hour], spot) : unknown("Water temperature didn’t load."),
    waterQuality: assessWaterQuality(data.waterQuality, data.rain, startMs, spot),
  };
  return { hour, startMs, factors, overall: overall(factors) };
}

const NAMES = { current: "current", waves: "waves", wind: "wind", waterTemp: "water temperature", waterQuality: "water quality" };
// Without these two there’s no honest rating: they’re what knocks a wader off their feet.
const CRITICAL = ["current", "waves"];

// drivers: the factors that set the level, named in the summary. active: every factor
// at caution or worse as { key, level }, shown as icons in their own level’s color so
// a hazard doesn’t drop out of view when something worse joins it. Worst first; within
// a level, drivers first, then card order. levels: a driver’s level where it isn’t
// its own, as when two moderates together make high.
export function overall(factors) {
  const scored = Object.keys(NAMES).filter(k => factors[k]?.level in RANK);
  const atLeast = level => scored.filter(k => RANK[factors[k].level] >= RANK[level]);
  const rated = (level, drivers, why, levels = {}) => ({ level, drivers, why,
    active: level === "low" ? [] : [...drivers, ...atLeast("caution").filter(k => !drivers.includes(k))]
      .map(key => ({ key, level: levels[key] ?? factors[key].level }))
      .sort((a, b) => RANK[b.level] - RANK[a.level]) });

  // A posted beach, or one just hit by heavy rain, is a no-go whatever the water is
  // doing. Anything else at caution or worse is still named, so the reasons don’t
  // vanish behind it.
  if (factors.waterQuality?.level === "high") {
    const also = atLeast("caution").filter(k => k !== "waterQuality");
    return rated("high", ["waterQuality", ...also],
      factors.waterQuality.why ?? "Posted for bacteria or a sewer overflow.");
  }
  // Missing data can hide a hazard but never cancels a known one: any factor at high
  // still makes the hour high. Short of that, a low or caution could be a false
  // all-clear, so the hour goes unrated.
  const missing = CRITICAL.filter(k => factors[k].level === "unknown");
  const missingText = missing.map(k => NAMES[k]).join(" and ");
  const high = atLeast("high");
  if (missing.length && !high.length) {
    return { level: "unknown", drivers: missing, active: [], why: `No rating: ${missingText} data is missing.` };
  }
  if (factors.current.level === "caution" && factors.waves.level === "caution") {
    return rated("high", ["current", "waves"],
      "Current and wave surge are both moderate. Together they push harder than either alone.",
      { current: "high", waves: "high" });
  }
  const worst = Math.max(...scored.map(k => RANK[factors[k].level]));
  const level = Object.keys(RANK).find(l => RANK[l] === worst);
  if (level === "low") return rated(level, [], "Nothing stands out.");
  const drivers = scored.filter(k => RANK[factors[k].level] === worst);
  const why = `Because of the ${list(drivers.map(k => NAMES[k]))}.`;
  return rated(level, drivers, missing.length ? `${why} No ${missingText} data.` : why);
}

// ---- The day in a sentence or three -------------------------------------------------

const LEVEL_WORDS = { low: "Low", caution: "Caution", high: "High", unknown: "No rating" };

// “Low 6 AM–1 PM. High 1–3 PM, because of wind. Caution 3–6 PM, because of waves.”
// hours: assessHour results in time order.
export function summarizeDay(hours) {
  const runs = [];
  for (const h of hours) {
    const last = runs.at(-1);
    // A run ends where the rating or its reasons change, so every reason named is true
    // for every hour it covers.
    const same = last && last.level === h.overall.level && last.to === h.hour
      && last.drivers.join() === h.overall.drivers.join();
    if (same) {
      last.to = h.hour + 1;
    } else {
      runs.push({ level: h.overall.level, from: h.hour, to: h.hour + 1, drivers: [...h.overall.drivers] });
    }
  }
  return runs.map(r => {
    const span = hourSpan(r.from, r.to);
    if (r.level === "low") return `Low ${span}.`;
    const what = list(r.drivers.map(k => NAMES[k]));
    return r.level === "unknown"
      ? `No rating ${span}: missing ${what} data.`
      : `${LEVEL_WORDS[r.level]} ${span}, because of ${what}.`;
  }).join(" ");
}

// 13, 15 → “1–3 PM”; 6, 13 → “6 AM–1 PM”.
export function hourSpan(from, to) {
  const [a, b] = [hourLabel(from), hourLabel(to)];
  const meridiem = x => x.slice(-2);
  return meridiem(a) === meridiem(b) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}

// ---- Helpers -----------------------------------------------------------------------

// "2026-11-09" → "Nov 9"
function shortDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(Date.UTC(y, m - 1, d));
}

function unknown(note) { return { level: "unknown", value: "Unavailable", notes: [note] }; }
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const fmt = (x, digits = 1) => x.toFixed(digits);
const round1 = x => Math.round(x * 10) / 10;
const round2 = x => Math.round(x * 100) / 100;
const list = xs => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const CARDINAL = ["north", "east", "south", "west"];
