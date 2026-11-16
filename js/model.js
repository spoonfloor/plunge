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

// The tide’s height (feet above MLLW) rides along here: the current is what it does
// to a wader, so the two share a card.
export function assessCurrent(events, startMs, spot, tideFt = null) {
  const channel = peakCurrent(events, startMs);
  if (channel === null) return unknown("No current prediction covers this hour.");
  const beach = Math.abs(channel) * spot.current.nearshoreFactor;
  // Depth × speed at chest depth, against the depth where adults lose their footing.
  const dv = spot.standingDepthM * beach * KNOT_MS;
  const { caution, high } = spot.thresholds.currentDV;
  const level = dv >= high ? "high" : dv >= caution ? "caution" : "low";
  const way = Math.abs(channel) < 0.05 ? "Near slack"
    : channel < 0 ? "Ebb, pulling west toward the Gate" : "Flood, pushing east toward the Marina";
  const slack = nextSlack(events, startMs);
  const slackDay = slack !== null && zonedParts(slack, spot.timeZone).date !== zonedParts(startMs, spot.timeZone).date
    ? " tomorrow" : "";
  return {
    level,
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

// components: [{ ft, periodS, dirDeg }], offshore swells for one hour.
export function assessWaves(components, spot) {
  const swells = (components ?? []).filter(c => c.ft > 0 && c.periodS > 0 && c.dirDeg != null);
  if (!swells.length) return unknown("No swell forecast for this hour.");
  const parts = swells.map(c => ({ ...c, share: transferFactor(c.periodS, c.dirDeg, spot.waves) }))
    .sort((x, y) => y.ft * y.share - x.ft * x.share);
  // Heights of separate swells combine as the root of the summed squares (their energy adds).
  const beach = Math.hypot(...parts.map(c => c.ft * c.share));
  const { caution, high } = spot.thresholds.beachWaveFt;
  const level = beach >= high ? "high" : beach >= caution ? "caution" : "low";
  return { level, value: `${fmt(beach)} ft`, notes: [] };
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
  const { caution, high } = spot.thresholds.windMph;
  const level = wind.mph >= high ? "high" : wind.mph >= caution ? "caution" : "low";
  return { level, value: `${wind.mph} mph`, notes: [windPush(wind.dir, spot.shoreFacingDeg)].filter(Boolean) };
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
    waves: data.waves ? assessWaves(data.waves[hour], spot) : unknown("Swell forecast didn’t load."),
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
const list = xs => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const CARDINAL = ["north", "east", "south", "west"];
