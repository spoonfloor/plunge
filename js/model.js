// The risk model. Pure functions: data in, hourly assessment out. No fetching, no DOM.

import { clockTime, hourLabel, zonedParts } from "./time.js";

const KNOT_MS = 0.514444;
const G = 9.81;
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

// The next slack (the current turning) at or after ms, or null past the events we have.
export function nextSlack(events, ms) {
  return events.find(e => e.ms >= ms && e.knots === 0)?.ms ?? null;
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

// The tide’s height (feet above MLLW) rides along here: the current is what it does
// to a wader, so the two share a card.
export function assessCurrent(events, startMs, spot, tideFt = null) {
  const channel = peakCurrent(events, startMs);
  if (channel === null) return unknown("No current prediction covers this hour.");
  const beach = round1(Math.abs(channel) * spot.current.nearshoreFactor);
  const level = levelFor(beach, currentKnots(spot));
  const way = Math.abs(channel) < 0.05 ? "Near slack"
    : channel < 0 ? "Ebb, pulling west toward the Gate" : "Flood, pushing east toward the Marina";
  const slack = nextSlack(events, startMs);
  const slackDay = slack !== null && zonedParts(slack, spot.timeZone).date !== zonedParts(startMs, spot.timeZone).date
    ? " tomorrow" : "";
  return {
    level,
    amount: beach,
    value: `${fmt(beach)} kn`,
    notes: [
      way,
      slack !== null ? `Slack at ${clockTime(slack, spot.timeZone)}${slackDay}` : null,
      tideFt != null ? `Water level ${fmt(tideFt)} ft` : null,
    ].filter(Boolean),
  };
}

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

// waves: one hour, either { beachFt } from the NWS nearshore model or { swells } from
// the offshore forecast.
export function assessWaves(waves, spot) {
  const raw = waves?.beachFt ?? beachWaveFt(waves?.swells, spot);
  if (raw == null) return unknown("No wave forecast for this hour.");
  const beach = round1(raw);
  return { level: levelFor(beach, spot.thresholds.beachWaveFt), amount: beach, value: `${fmt(beach)} ft`, notes: [] };
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

export function assessWaterTemp(temp, spot) {
  if (!temp) return unknown("No recent water temperature reading.");
  const level = temp.f < spot.thresholds.waterTempF.caution ? "caution" : "low";
  return { level, value: `${Math.round(temp.f)}°F`, notes: [] };
}

// quality: { status: "clean" | "posted" | "unsampled", sampled: "2026-11-09" | null }
export function assessWaterQuality(quality) {
  if (!quality) return unknown("SFPUC water quality didn’t load.");
  const when = quality.sampled ? `Sampled ${shortDate(quality.sampled)}` : "No recent sample";
  if (quality.status === "posted") {
    return { level: "high", value: "Posted", notes: ["High bacteria or a sewer overflow. Don’t go in.", when] };
  }
  if (quality.status === "unsampled") return unknown(`SFPUC isn’t sampling this beach right now. ${when}.`);
  return { level: "low", value: "Meets standards", notes: [when] };
}

// ---- Sky ---------------------------------------------------------------------------

// sky: { text: "Partly Sunny", rainPct: 20, day: true } from the NWS hourly forecast →
// which icon to draw. Order matters: “Chance Showers And Thunderstorms” is a storm,
// “Partly Cloudy” is partly, not cloudy.
export function skyKind(sky) {
  const t = sky.text.toLowerCase();
  if (/thunder|t-storm/.test(t)) return "storm";
  if (/rain|shower|drizzle|sleet|snow/.test(t)) return "rain";
  if (/fog|haze|smoke|mist/.test(t)) return "fog";
  if (/partly|mostly sunny|mostly clear/.test(t)) return sky.day ? "partly-day" : "partly-night";
  if (/cloud|overcast/.test(t)) return "cloud";
  return sky.day ? "sun" : "moon";
}

// “Partly sunny · 20% rain”, or “Chance light rain · 28%” when the words already say rain.
export function skyLine(sky) {
  const text = `${sky.text.charAt(0)}${sky.text.slice(1).toLowerCase()}`;
  return `${text} · ${Math.round(sky.rainPct)}%${/rain|shower|drizzle/.test(text) ? "" : " rain"}`;
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

// data: { currents, tide, waves, wind, waterTemp } as normalized by sources.js
// (each may be null when its source failed).
export function assessHour(hour, startMs, data, spot) {
  const factors = {
    current: data.currents ? assessCurrent(data.currents, startMs, spot, data.tide?.[hour]) : unknown("Current predictions didn’t load."),
    waves: data.waves ? assessWaves(data.waves[hour], spot) : unknown("Wave forecast didn’t load."),
    // Measured where the hour has passed, forecast otherwise.
    wind: assessWind(data.windObserved?.[hour] ?? data.wind?.[hour], spot),
    waterTemp: assessWaterTemp(data.waterTemp, spot),
    waterQuality: assessWaterQuality(data.waterQuality),
  };
  return { hour, startMs, factors, overall: overall(factors) };
}

const NAMES = { current: "current", waves: "waves", wind: "wind", waterTemp: "water temperature", waterQuality: "water quality" };
// Without these two there’s no honest rating: they’re what knocks a wader off their feet.
const CRITICAL = ["current", "waves"];

export function overall(factors) {
  // A posted beach is a no-go whatever the water is doing.
  if (factors.waterQuality?.level === "high") {
    return { level: "high", drivers: ["waterQuality"], why: "SFPUC has posted this beach for bacteria or a sewer overflow. Don’t go in." };
  }
  const missing = CRITICAL.filter(k => factors[k].level === "unknown");
  if (missing.length) {
    return { level: "unknown", drivers: missing, why: `No rating: ${missing.map(k => NAMES[k]).join(" and ")} data is missing.` };
  }
  const scored = Object.keys(NAMES).filter(k => factors[k]?.level in RANK);
  if (factors.current.level === "caution" && factors.waves.level === "caution") {
    return { level: "high", drivers: ["current", "waves"],
      why: "Current and wave surge are both moderate. Together they push harder than either alone." };
  }
  const worst = Math.max(...scored.map(k => RANK[factors[k].level]));
  const level = Object.keys(RANK).find(l => RANK[l] === worst);
  if (level === "low") return { level, drivers: [], why: "Nothing stands out." };
  const drivers = scored.filter(k => RANK[factors[k].level] === worst);
  return { level, drivers, why: `Because of the ${list(drivers.map(k => NAMES[k]))}.` };
}

// ---- The day in a sentence or three -------------------------------------------------

const LEVEL_WORDS = { low: "Low", caution: "Caution", high: "High", unknown: "No rating" };

// “Low 6 AM–1 PM. High 1–3 PM, because of the wind. Caution 3–6 PM, …”
// hours: assessHour results in time order.
export function summarizeDay(hours) {
  const runs = [];
  for (const h of hours) {
    const last = runs.at(-1);
    if (last && last.level === h.overall.level && last.to === h.hour) {
      last.to = h.hour + 1;
      for (const d of h.overall.drivers) if (!last.drivers.includes(d)) last.drivers.push(d);
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
      : `${LEVEL_WORDS[r.level]} ${span}, because of the ${what}.`;
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
const list = xs => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const CARDINAL = ["north", "east", "south", "west"];
