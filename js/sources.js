// Fetches each data source and normalizes it for model.js. Every source fails on its
// own: one being down leaves the others working, and the last good copy from today
// (saved on this device) stands in, marked with when it was fetched.

import { addDays, compact, sunIsUp, zonedParts, zonedToMs } from "./time.js";
import { skyText } from "./model.js";

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

// NWS gridpoint series ({ validTime: "2026-11-16T06:00:00+00:00/PT2H", value }) → value
// by local hour of date, each value spread over the hours it covers.
function byHour(series, spot, date, map = v => v) {
  const out = {};
  for (const { validTime, value } of series) {
    const [start, span] = validTime.split("/");
    const [, d, h] = span.match(/P(?:(\d+)D)?T?(?:(\d+)H)?/).map(x => Number(x ?? 0));
    for (let i = 0; i < d * 24 + h; i++) {
      const at = zonedParts(Date.parse(start) + i * 3600000, spot.timeZone);
      if (at.date === date) out[at.hour] = map(value);
    }
  }
  return out;
}
// Gridpoint weather types, most significant first.
const WX_RANK = ["thunderstorms", "freezing_rain", "freezing_drizzle", "snow", "snow_showers", "rain",
  "rain_showers", "drizzle", "fog", "freezing_fog", "haze", "smoke"];

// Wave height at the beach estimated from Open-Meteo’s offshore swell forecast.
async function offshoreWaves(spot, date) {
  const vars = ["", "secondary_", "tertiary_"].flatMap(p =>
    [`${p}swell_wave_height`, `${p}swell_wave_period`, `${p}swell_wave_direction`]);
  const json = await getJson(withQuery("https://marine-api.open-meteo.com/v1/marine", {
    latitude: spot.waves.lat, longitude: spot.waves.lon, hourly: vars.join(","),
    timezone: spot.timeZone, length_unit: "imperial", start_date: date, end_date: date,
  }));
  const h = json.hourly, data = {};
  h.time.forEach((t, i) => {
    data[Number(t.slice(11, 13))] = { swells: ["", "secondary_", "tertiary_"].map(p => ({
      ft: h[`${p}swell_wave_height`]?.[i], periodS: h[`${p}swell_wave_period`]?.[i],
      dirDeg: h[`${p}swell_wave_direction`]?.[i],
    })).filter(c => c.ft != null) };
  });
  return { data, label: "Open-Meteo marine forecast, offshore of the Golden Gate, scaled to the beach",
    link: "https://open-meteo.com/en/docs/marine-weather-api" };
}

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

  // Wave height at the beach from the NWS Nearshore Wave Prediction System, read
  // through Plunge’s server function (the model’s files are too big for a phone).
  // When that fails, an estimate from the offshore forecast stands in.
  async waves(spot, date) {
    try {
      const json = await getJson(`${SERVER}/waves`);
      const data = {};
      for (const { time, ft } of json.hours) {
        const at = zonedParts(Date.parse(time), spot.timeZone);
        if (at.date === date) data[at.hour] = { beachFt: ft };
      }
      if (!Object.keys(data).length) throw new Error("No hours for today in the latest run");
      return { data, label: `NWS Nearshore Wave Prediction System, run of ${json.run}`,
        link: "https://polar.ncep.noaa.gov/nwps/viewer.shtml" };
    } catch {
      return await offshoreWaves(spot, date);
    }
  },

  async wind(spot, date, shared) {
    const json = await shared.nwsHourly();
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

  // Sky and chance of rain by hour, from the NWS gridpoint forecast that the hourly
  // forecast is built from. Unlike the hourly forecast it starts the evening before, so
  // hours already past have a sky too (as forecast for them, not as observed).
  async sky(spot, date, shared) {
    const grid = (await shared.nwsGrid()).properties;
    const cover = byHour(grid.skyCover.values, spot, date);
    const rainPct = byHour(grid.probabilityOfPrecipitation.values, spot, date);
    // The weather that matters most when an hour lists more than one.
    const wx = byHour(grid.weather.values, spot, date, v => v.filter(w => w.weather)
      .sort((a, b) => WX_RANK.indexOf(a.weather) - WX_RANK.indexOf(b.weather))[0] ?? null);
    const data = {};
    for (let hour = spot.firstHour; hour <= spot.lastHour; hour++) {
      if (cover[hour] == null) continue;
      const day = sunIsUp(zonedToMs(`${date} ${String(hour).padStart(2, "0")}:30`, spot.timeZone), spot.lat, spot.lon);
      const w = wx[hour] && { coverage: wx[hour].coverage, weather: wx[hour].weather, intensity: wx[hour].intensity };
      data[hour] = { text: skyText({ cover: cover[hour], wx: w, day }), rainPct: rainPct[hour] ?? 0, day };
    }
    // For hours the hourly forecast covers, its own words and day/night win: NWS’s cover
    // cutoffs don’t match the textbook ones above (19% cover reads “Sunny”), so this keeps
    // the line under the rating exactly what NWS says.
    const hourly = await shared.nwsHourly().catch(() => null);
    for (const p of hourly?.properties.periods ?? []) {
      const at = zonedParts(Date.parse(p.startTime), spot.timeZone);
      if (at.date !== date || !(at.hour in data)) continue;
      data[at.hour] = { text: p.shortForecast, rainPct: p.probabilityOfPrecipitation?.value ?? 0, day: p.isDaytime };
    }
    if (!Object.keys(data).length) throw new Error("No hours for today in the gridpoint forecast");
    return { data, label: "National Weather Service forecast",
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

  // SFPUC beach postings, the feed behind https://webapps.sfpuc.org/sapps/beachesandbay.html.
  // XML wrapping a JSON array of stations.
  async waterQuality(spot) {
    const res = await fetch("https://infrastructure.sfwater.org/lims.asmx/getBeaches");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const inner = xml.match(/<string[^>]*>([\s\S]*)<\/string>/)?.[1];
    if (!inner) throw new Error("Unexpected response");
    const decoded = inner.replace(/&(quot|amp|lt|gt|apos|#39);/g, (_, e) =>
      ({ quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", "#39": "'" })[e]);
    const station = JSON.parse(decoded).find(x => x.stationid === spot.waterQuality.station);
    if (!station) throw new Error(`Station ${spot.waterQuality.station} not in the feed`);
    const [m, d, y] = (station.sample_date ?? "").split("/").map(Number);
    return {
      data: {
        // Same rules as the SFPUC page: a red status, a posted sign or a sewer
        // discharge means posted; yellow or white means not sampled.
        status: station.s_color === "R" || station.cso || (station.posted && ["R", "G"].includes(station.p_color)) ? "posted"
          : station.s_color === "Y" || station.s_color === "W" ? "unsampled"
          : "clean",
        sampled: m ? `20${String(y).padStart(2, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null,
      },
      label: `SFPUC beach water quality, ${spot.waterQuality.stationName}`,
      link: "https://webapps.sfpuc.org/sapps/beachesandbay.html",
    };
  },

  // NWS warnings and advisories for the point. Shown below the factors; they don’t
  // feed the rating.
  async alerts(spot) {
    const json = await getJson(`https://api.weather.gov/alerts/active?point=${spot.lat},${spot.lon}`);
    const data = json.features.map(({ properties: p }) => ({
      event: p.event, headline: p.headline, areas: p.areaDesc, description: p.description,
      onsetMs: Date.parse(p.onset ?? p.effective), endsMs: Date.parse(p.ends ?? p.expires),
    }));
    return { data, label: "National Weather Service active alerts",
      link: `https://forecast.weather.gov/MapClick.php?lat=${spot.lat}&lon=${spot.lon}` };
  },
};

// Names for sources that failed before ever loading.
const NAMES = {
  currents: "NOAA current predictions", tide: "NOAA tide predictions",
  waterTemp: "NOAA water temperature", waves: "NWS nearshore wave forecast",
  wind: "National Weather Service hourly forecast", sky: "National Weather Service forecast",
  windObserved: "NOAA measured wind",
  waterQuality: "SFPUC beach water quality", alerts: "National Weather Service active alerts",
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
  // Requests more than one fetcher reads, made once per load.
  let point, hourly, grid;
  const nwsPoint = () => point ??= getJson(`https://api.weather.gov/points/${spot.lat},${spot.lon}`);
  const shared = {
    nwsHourly: () => hourly ??= nwsPoint().then(p => getJson(p.properties.forecastHourly)),
    nwsGrid: () => grid ??= nwsPoint().then(p => getJson(p.properties.forecastGridData)),
  };
  const results = await Promise.all(keys.map(async key => {
    try {
      const got = await FETCHERS[key](spot, date, shared);
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
