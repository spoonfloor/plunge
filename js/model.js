// The risk model. Pure functions: data in, hourly assessment out. No fetching, no DOM.

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

export function assessCurrent(events, startMs, spot) {
  const channel = peakCurrent(events, startMs);
  if (channel === null) return unknown("No current prediction covers this hour.");
  const beach = Math.abs(channel) * spot.current.nearshoreFactor;
  const dv = spot.standingDepthM * beach * KNOT_MS;
  const { caution, high } = spot.thresholds.currentDV;
  const level = dv >= high ? "high" : dv >= caution ? "caution" : "low";
  const way = Math.abs(channel) < 0.05 ? "Near slack"
    : channel < 0 ? "Ebb, flowing west toward the Gate," : "Flood, flowing east toward the Marina,";
  return {
    level,
    value: `${fmt(beach)} kn at the beach`,
    why: `${way} peaking at ${fmt(Math.abs(channel))} kn in the channel this hour; about ` +
      `${fmt(beach)} kn at the beach (estimated at ${pct(spot.current.nearshoreFactor)}). ` +
      `Chest deep, depth × speed is ${fmt(dv, 2)} m²/s; adults lose their footing around ${high}.`,
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
  const main = parts[0];
  return {
    level,
    value: `${fmt(beach)} ft at the beach`,
    why: `Main swell offshore: ${fmt(main.ft)} ft at ${Math.round(main.periodS)} s from ` +
      `${Math.round(main.dirDeg)}° (${compass(main.dirDeg)}). About ${pct(main.share)} of it reaches ` +
      `the beach (estimated)${parts.length > 1 ? `, plus ${parts.length - 1} smaller swell${parts.length > 2 ? "s" : ""}` : ""}.`,
  };
}

// ---- Wind, water temperature, tide ------------------------------------------------

export function assessWind(wind, spot) {
  if (!wind) return unknown("No wind measurement or forecast for this hour.");
  const { caution, high } = spot.thresholds.windMph;
  const level = wind.mph >= high ? "high" : wind.mph >= caution ? "caution" : "low";
  return { level, value: `${wind.mph} mph ${wind.dir}`, why: `${wind.observed ? "Measured" : "Forecast"}: sustained ${wind.dir} wind, ${wind.mph} mph.` };
}

export function assessWaterTemp(temp, spot) {
  if (!temp) return unknown("No recent water temperature reading.");
  const level = temp.f < spot.thresholds.waterTempF.caution ? "caution" : "low";
  return {
    level, value: `${Math.round(temp.f)}°F`,
    why: `Measured ${Math.round(temp.f)}°F${temp.where ? ` at ${temp.where}` : ""}. ${level === "caution"
      ? "Cold enough that the gasp reflex on entry is a hazard by itself."
      : temp.f < 60 ? "Cold, so enter slowly." : "Mild for San Francisco."}`,
  };
}

export function assessTide(ft, nextFt) {
  if (ft == null) return unknown("No tide prediction for this hour.", "info");
  const trend = nextFt == null ? "" : nextFt > ft + 0.05 ? ", rising" : nextFt < ft - 0.05 ? ", falling" : ", turning";
  return {
    level: "info", value: `${fmt(ft)} ft${trend}`,
    why: "Height above mean lower low water. Higher water puts chest depth closer to shore.",
  };
}

// ---- One hour, all factors ---------------------------------------------------------

// data: { currents, tide, waves, wind, waterTemp } as normalized by sources.js
// (each may be null when its source failed).
export function assessHour(hour, startMs, data, spot) {
  const factors = {
    current: data.currents ? assessCurrent(data.currents, startMs, spot) : unknown("Current predictions didn’t load."),
    waves: data.waves ? assessWaves(data.waves[hour], spot) : unknown("Swell forecast didn’t load."),
    // Measured where the hour has passed, forecast otherwise.
    wind: assessWind(data.windObserved?.[hour] ?? data.wind?.[hour], spot),
    waterTemp: assessWaterTemp(data.waterTemp, spot),
    tide: data.tide ? assessTide(data.tide[hour], data.tide[hour + 1]) : unknown("Tide predictions didn’t load.", "info"),
  };
  return { hour, startMs, factors, overall: overall(factors) };
}

const NAMES = { current: "current", waves: "waves", wind: "wind", waterTemp: "water temperature" };
// Without these two there’s no honest rating: they’re what knocks a wader off their feet.
const CRITICAL = ["current", "waves"];

export function overall(factors) {
  const missing = CRITICAL.filter(k => factors[k].level === "unknown");
  if (missing.length) {
    return { level: "unknown", why: `No rating: ${missing.map(k => NAMES[k]).join(" and ")} data is missing.` };
  }
  const scored = Object.keys(NAMES).filter(k => factors[k].level in RANK);
  if (factors.current.level === "caution" && factors.waves.level === "caution") {
    return { level: "high", why: "Current and wave surge are both moderate. Together they push harder than either alone." };
  }
  const worst = Math.max(...scored.map(k => RANK[factors[k].level]));
  const level = Object.keys(RANK).find(l => RANK[l] === worst);
  if (level === "low") return { level, why: "Nothing stands out." };
  const drivers = scored.filter(k => RANK[factors[k].level] === worst).map(k => NAMES[k]);
  return { level, why: `Because of the ${list(drivers)}.` };
}

// ---- Helpers -----------------------------------------------------------------------

function unknown(why, level = "unknown") { return { level, value: "Unavailable", why }; }
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const fmt = (x, digits = 1) => x.toFixed(digits);
const pct = x => `${Math.round(x * 100)}%`;
const list = xs => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

export function compass(deg) {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return points[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}
