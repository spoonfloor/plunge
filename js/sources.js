// Fetches each data source and normalizes it for model.js. Every source fails on its
// own: one being down leaves the others working, and the last good copy from today
// (saved on this device) stands in, marked with when it was fetched.

import { addDays, compact, zonedParts, zonedToMs } from "./time.js";

const COOPS = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
// Plunge’s server function (server/functions/plunge), for sources browsers can’t read.
const SERVER = "https://supabase.erichenry.com/functions/v1/plunge";
const COOPS_COMMON = { units: "english", time_zone: "lst_ldt", format: "json", application: "plunge" };

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? String(json.error));
  return json;
}
const withQuery = (base, params) => `${base}?${new URLSearchParams(params)}`;

// Each returns { data, link }: data in model.js’s shape, link a page a person can read.
const FETCHERS = {
  // NOAA slack and max events from 6 PM yesterday to 6 AM tomorrow, so every hour of
  // today sits between two of them.
  async currents(spot, date) {
    const { station, stationName } = spot.current;
    const json = await getJson(withQuery(COOPS, {
      ...COOPS_COMMON, product: "currents_predictions", station, interval: "MAX_SLACK",
      begin_date: `${compact(addDays(date, -1))} 18:00`, end_date: `${compact(addDays(date, 1))} 06:00`,
    }));
    const data = json.current_predictions.cp.map(e => ({
      ms: zonedToMs(e.Time, spot.timeZone), knots: Number(e.Velocity_Major), type: e.Type,
    })).sort((a, b) => a.ms - b.ms);
    return { data, label: `NOAA current predictions, ${stationName} (${station})`,
      link: `https://tidesandcurrents.noaa.gov/noaacurrents/predictions?id=${station}_1` };
  },

  async tide(spot, date) {
    const { station, stationName } = spot.tide;
    const json = await getJson(withQuery(COOPS, {
      ...COOPS_COMMON, product: "predictions", station, interval: "h", datum: "MLLW",
      begin_date: compact(date), end_date: compact(date),
    }));
    const data = {};
    for (const p of json.predictions) data[Number(p.t.slice(11, 13))] = Number(p.v);
    return { data, label: `NOAA tide predictions, ${stationName} (${station})`,
      link: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station}` };
  },

  // The Presidio station sits inside the Bay, closest to the beach. When it has no
  // recent reading, fall back to the SF Bar buoy outside the Gate, read through
  // Plunge’s server function (NDBC doesn’t allow browsers to read it directly).
  async waterTemp(spot) {
    const { station, stationName } = spot.waterTemp;
    const fresh = ms => Date.now() - ms < 24 * 3600e3;
    let presidioError;
    try {
      const json = await getJson(withQuery(COOPS, {
        ...COOPS_COMMON, product: "water_temperature", station, date: "latest",
      }));
      const reading = json.data?.[0];
      const ms = reading && zonedToMs(reading.t, spot.timeZone);
      if (reading && fresh(ms)) {
        return { data: { f: Number(reading.v), ms, where: stationName }, label: `NOAA water temperature, ${stationName} (${station})`,
          link: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station}` };
      }
      presidioError = "no reading in the last 24 hours";
    } catch (err) { presidioError = err.message; }

    const buoy = await getJson(`${SERVER}/water-temp`);
    const ms = Date.parse(buoy.observedAt);
    if (!fresh(ms)) throw new Error("No reading in the last 24 hours");
    return { data: { f: buoy.fahrenheit, ms, where: `${buoy.name} buoy, outside the Gate` },
      label: `NDBC water temperature, ${buoy.name} buoy (${buoy.station}), standing in for ${stationName} (${presidioError})`,
      link: `https://www.ndbc.noaa.gov/station_page.php?station=${buoy.station}` };
  },

  async waves(spot, date) {
    const vars = ["", "secondary_", "tertiary_"].flatMap(p =>
      [`${p}swell_wave_height`, `${p}swell_wave_period`, `${p}swell_wave_direction`]);
    const json = await getJson(withQuery("https://marine-api.open-meteo.com/v1/marine", {
      latitude: spot.waves.lat, longitude: spot.waves.lon, hourly: vars.join(","),
      timezone: spot.timeZone, length_unit: "imperial", start_date: date, end_date: date,
    }));
    const h = json.hourly, data = {};
    h.time.forEach((t, i) => {
      data[Number(t.slice(11, 13))] = ["", "secondary_", "tertiary_"].map(p => ({
        ft: h[`${p}swell_wave_height`]?.[i], periodS: h[`${p}swell_wave_period`]?.[i],
        dirDeg: h[`${p}swell_wave_direction`]?.[i],
      })).filter(c => c.ft != null);
    });
    return { data, label: "Open-Meteo marine forecast, offshore of the Golden Gate",
      link: "https://open-meteo.com/en/docs/marine-weather-api" };
  },

  async wind(spot, date) {
    const point = await getJson(`https://api.weather.gov/points/${spot.lat},${spot.lon}`);
    const json = await getJson(point.properties.forecastHourly);
    const data = {};
    for (const p of json.properties.periods) {
      const at = zonedParts(Date.parse(p.startTime), spot.timeZone);
      if (at.date !== date) continue;
      const mph = Math.max(...(p.windSpeed.match(/\d+/g) ?? []).map(Number));
      if (Number.isFinite(mph)) data[at.hour] = { mph, dir: p.windDirection };
    }
    return { data, label: "National Weather Service hourly forecast",
      link: `https://forecast.weather.gov/MapClick.php?lat=${spot.lat}&lon=${spot.lon}` };
  },

  // Measured wind at the Presidio pier, about 1.4 km west, for hours already past.
  async windObserved(spot, date) {
    const { station, stationName } = spot.tide;
    const json = await getJson(withQuery(COOPS, {
      ...COOPS_COMMON, product: "wind", station, interval: "h",
      begin_date: compact(date), end_date: compact(date),
    }));
    const data = {};
    for (const w of json.data) {
      const knots = Number(w.s);
      if (Number.isFinite(knots)) data[Number(w.t.slice(11, 13))] = { mph: Math.round(knots * 1.15078), dir: w.dr, observed: true };
    }
    return { data, label: `NOAA measured wind, ${stationName} (${station})`,
      link: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station}` };
  },

  // The blanket warnings, shown for comparison. They don’t feed the rating.
  async alerts(spot) {
    const json = await getJson(`https://api.weather.gov/alerts/active?point=${spot.lat},${spot.lon}`);
    const data = json.features.map(({ properties: p }) => ({
      event: p.event, headline: p.headline, areas: p.areaDesc,
      onsetMs: Date.parse(p.onset ?? p.effective), endsMs: Date.parse(p.ends ?? p.expires),
    }));
    return { data, label: "National Weather Service active alerts",
      link: `https://forecast.weather.gov/MapClick.php?lat=${spot.lat}&lon=${spot.lon}` };
  },
};

// Names for sources that failed before ever loading.
const NAMES = {
  currents: "NOAA current predictions", tide: "NOAA tide predictions",
  waterTemp: "NOAA water temperature", waves: "Open-Meteo marine forecast",
  wind: "National Weather Service hourly forecast", windObserved: "NOAA measured wind", alerts: "National Weather Service active alerts",
};

const cacheKey = (spot, key) => `plunge:${spot.id}:${key}`;
function readCache(spot, key, date) {
  try {
    const saved = JSON.parse(localStorage.getItem(cacheKey(spot, key)));
    return saved?.date === date ? saved : null;
  } catch { return null; }
}
function writeCache(spot, key, entry) {
  try { localStorage.setItem(cacheKey(spot, key), JSON.stringify(entry)); } catch { /* storage unavailable */ }
}

// Resolves to { data: { currents, tide, ... }, sources: [{ key, label, link, fetchedAt, stale, error }] }.
export async function loadAll(spot, date) {
  const keys = Object.keys(FETCHERS);
  const results = await Promise.all(keys.map(async key => {
    try {
      const got = await FETCHERS[key](spot, date);
      const entry = { date, ...got, fetchedAt: Date.now() };
      writeCache(spot, key, entry);
      return { key, ...entry, stale: false };
    } catch (err) {
      const saved = readCache(spot, key, date);
      return saved ? { key, ...saved, stale: true, error: err.message }
        : { key, label: NAMES[key], data: null, error: err.message };
    }
  }));
  return {
    data: Object.fromEntries(results.map(r => [r.key, r.data])),
    sources: results.map(({ data, date: _d, ...meta }) => meta),
  };
}
