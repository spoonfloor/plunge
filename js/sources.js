// Fetches each data source and normalizes it for model.js. Every source fails on its
// own: one being down leaves the others working, and the last good copy from today
// (saved on this device) stands in, marked with when it was fetched.
//
// One load covers every day the app shows. Sources that change hour to hour come back
// by day ({ "2026-11-16": { 6: …, 7: … }, … }); forDate() picks out one day.

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

// An empty hour map for each of dates: { "2026-11-16": {}, … }.
const byDay = dates => Object.fromEntries(dates.map(d => [d, {}]));
// "2026-11-16 13:00" (NOAA and Open-Meteo local times) → its date and hour.
const localParts = t => ({ date: t.slice(0, 10), hour: Number(t.slice(11, 13)) });

// NWS gridpoint series ({ validTime: "2026-11-16T06:00:00+00:00/PT2H", value }) → value
// by date and local hour, each value spread over the hours it covers.
function byHour(series, spot, dates, map = v => v) {
  const out = byDay(dates);
  for (const { validTime, value } of series) {
    const [start, span] = validTime.split("/");
    const [, d, h] = span.match(/P(?:(\d+)D)?T?(?:(\d+)H)?/).map(x => Number(x ?? 0));
    for (let i = 0; i < d * 24 + h; i++) {
      const at = zonedParts(Date.parse(start) + i * 3600000, spot.timeZone);
      if (out[at.date]) out[at.date][at.hour] = map(value);
    }
  }
  return out;
}
const isEmpty = days => Object.values(days).every(hours => !Object.keys(hours).length);
// Gridpoint weather types, most significant first.
const WX_RANK = ["thunderstorms", "freezing_rain", "freezing_drizzle", "snow", "snow_showers", "rain",
  "rain_showers", "drizzle", "fog", "freezing_fog", "haze", "smoke"];

// Wave height at the beach estimated from Open-Meteo’s offshore swell forecast.
async function offshoreWaves(spot, dates) {
  const vars = ["", "secondary_", "tertiary_"].flatMap(p =>
    [`${p}swell_wave_height`, `${p}swell_wave_period`, `${p}swell_wave_direction`]);
  const json = await getJson(withQuery("https://marine-api.open-meteo.com/v1/marine", {
    latitude: spot.waves.lat, longitude: spot.waves.lon, hourly: vars.join(","),
    timezone: spot.timeZone, length_unit: "imperial", start_date: dates[0], end_date: dates.at(-1),
  }));
  const h = json.hourly, data = byDay(dates);
  h.time.forEach((t, i) => {
    const at = localParts(t);
    if (data[at.date]) data[at.date][at.hour] = { swells: ["", "secondary_", "tertiary_"].map(p => ({
      ft: h[`${p}swell_wave_height`]?.[i], periodS: h[`${p}swell_wave_period`]?.[i],
      dirDeg: h[`${p}swell_wave_direction`]?.[i],
    })).filter(c => c.ft != null) };
  });
  return { data, label: "Open-Meteo marine forecast, offshore of the Golden Gate, scaled to the beach",
    link: "https://open-meteo.com/en/docs/marine-weather-api" };
}

// Each returns { data, link }: data in model.js’s shape, link a page a person can read.
// The latest water temperature. The Presidio station sits inside the Bay, closest to
// the beach. When it has no recent reading, fall back to the SF Bar buoy outside the
// Gate, read through Plunge’s server function (NDBC doesn’t allow browsers to read it
// directly).
async function latestWaterTemp(spot) {
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
}

// A past day’s water temperature by hour, into hours: the Presidio station’s hourly
// readings, with the buoy’s (from the server) for any hour Presidio missed. Says
// whether it found any.
async function pastWaterTemp(spot, date, shared, hours) {
  const { station, stationName } = spot.waterTemp;
  try {
    const json = await getJson(withQuery(COOPS, { ...COOPS_COMMON, product: "water_temperature", station,
      interval: "h", begin_date: compact(date), end_date: compact(date) }));
    for (const { t, v } of json.data ?? []) {
      const { hour } = localParts(t);
      if (v !== "") hours[hour] = { f: Number(v), ms: zonedToMs(t, spot.timeZone), where: stationName };
    }
  } catch { /* the buoy fills in below */ }
  try {
    for (const [hour, r] of Object.entries((await shared.history(date)).waterTemp ?? {})) {
      hours[hour] ??= { f: r.f, ms: r.ms, where: "San Francisco Bar buoy, outside the Gate" };
    }
  } catch { /* hours with no reading stay empty */ }
  return Object.keys(hours).length > 0;
}

const FETCHERS = {
  // NOAA slack and max events from 6 PM the evening before the first day to 6 AM after
  // the last, so every hour shown sits between two of them. One list, not by day.
  async currents(spot, dates) {
    const { station, stationName } = spot.current;
    const json = await getJson(withQuery(COOPS, {
      ...COOPS_COMMON, product: "currents_predictions", station, interval: "MAX_SLACK",
      begin_date: `${compact(addDays(dates[0], -1))} 18:00`, end_date: `${compact(addDays(dates.at(-1), 1))} 06:00`,
    }));
    const data = json.current_predictions.cp.map(e => ({
      ms: zonedToMs(e.Time, spot.timeZone), knots: Number(e.Velocity_Major), type: e.Type,
    })).sort((a, b) => a.ms - b.ms);
    return { data, label: `NOAA current predictions, ${stationName} (${station})`,
      link: `https://tidesandcurrents.noaa.gov/noaacurrents/predictions?id=${station}_1` };
  },

  async tide(spot, dates) {
    const { station, stationName } = spot.tide;
    const json = await getJson(withQuery(COOPS, {
      ...COOPS_COMMON, product: "predictions", station, interval: "h", datum: "MLLW",
      begin_date: compact(dates[0]), end_date: compact(dates.at(-1)),
    }));
    const data = byDay(dates);
    for (const p of json.predictions) {
      const at = localParts(p.t);
      if (data[at.date]) data[at.date][at.hour] = Number(p.v);
    }
    return { data, label: `NOAA tide predictions, ${stationName} (${station})`,
      link: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station}` };
  },

  // By day and hour. Past days get each hour’s own reading; today and the days ahead
  // get the latest reading, since there’s no forecast for water temperature.
  async waterTemp(spot, dates, shared) {
    const today = zonedParts(Date.now(), spot.timeZone).date;
    const data = byDay(dates);
    const past = dates.filter(d => d < today);
    let latest = null, latestError = null;
    try { latest = await latestWaterTemp(spot); } catch (err) { latestError = err; }
    for (const date of dates) {
      if (date < today || !latest) continue;
      for (let hour = spot.firstHour; hour <= spot.lastHour; hour++) data[date][hour] = latest.data;
    }
    const pastFound = (await Promise.all(past.map(date => pastWaterTemp(spot, date, shared, data[date])))).some(Boolean);
    if (!latest && !pastFound) throw latestError;
    return latest ? { ...latest, data } : { data, label: "NOAA water temperature, past days only" };
  },

  // Wave height at the beach from the NWS Nearshore Wave Prediction System, read
  // through Plunge’s server function (the model’s files are too big for a phone).
  // Its latest run starts this morning and reaches about six days out. For past days,
  // the server’s record of each hour from the run current at the time. For hours
  // neither covers (the tail of the last day) or when both fail, an estimate from the
  // offshore forecast stands in.
  async waves(spot, dates, shared) {
    const today = zonedParts(Date.now(), spot.timeZone).date;
    const data = byDay(dates);
    let run = null;
    await Promise.all(dates.filter(d => d < today).map(async date => {
      try {
        for (const [hour, ft] of Object.entries((await shared.history(date)).waves)) data[date][hour] = { beachFt: ft };
      } catch { /* no record; the run or the offshore estimate covers it below */ }
    }));
    try {
      const json = await getJson(`${SERVER}/waves`);
      for (const { time, ft } of json.hours) {
        const at = zonedParts(Date.parse(time), spot.timeZone);
        if (data[at.date] && !data[at.date][at.hour]) data[at.date][at.hour] = { beachFt: ft };
      }
      run = json.run;
    } catch { /* the offshore estimate covers every hour below */ }
    const gaps = dates.some(date => {
      for (let hour = spot.firstHour; hour <= spot.lastHour; hour++) if (!data[date][hour]) return true;
      return false;
    });
    let offshore = null;
    if (gaps) {
      try {
        offshore = await offshoreWaves(spot, dates);
        for (const date of dates) data[date] = { ...offshore.data[date], ...data[date] };
      } catch (err) { if (!run) throw err; }
    }
    if (!run) return offshore;
    return { data, label: `NWS Nearshore Wave Prediction System, run of ${run}${offshore ? `, with ${offshore.label} where the run doesn’t reach` : ""}`,
      link: "https://polar.ncep.noaa.gov/nwps/viewer.shtml" };
  },

  async wind(spot, dates, shared) {
    const json = await shared.nwsHourly();
    const data = byDay(dates);
    for (const p of json.properties.periods) {
      const at = zonedParts(Date.parse(p.startTime), spot.timeZone);
      if (!data[at.date]) continue;
      const mph = Math.max(...(p.windSpeed.match(/\d+/g) ?? []).map(Number));
      if (Number.isFinite(mph)) data[at.date][at.hour] = { mph, dir: p.windDirection };
    }
    return { data, label: "National Weather Service hourly forecast",
      link: `https://forecast.weather.gov/MapClick.php?lat=${spot.lat}&lon=${spot.lon}` };
  },

  // Sky and chance of rain by hour, from the NWS gridpoint forecast that the hourly
  // forecast is built from. Both drop hours once they pass, though the gridpoint one
  // sometimes keeps a few: those past hours get a sky as forecast for them, and
  // skyObserved fills the rest.
  async sky(spot, dates, shared) {
    const grid = (await shared.nwsGrid()).properties;
    const cover = byHour(grid.skyCover.values, spot, dates);
    const rainPct = byHour(grid.probabilityOfPrecipitation.values, spot, dates);
    // The weather that matters most when an hour lists more than one.
    const wx = byHour(grid.weather.values, spot, dates, v => v.filter(w => w.weather)
      .sort((a, b) => WX_RANK.indexOf(a.weather) - WX_RANK.indexOf(b.weather))[0] ?? null);
    const data = byDay(dates);
    for (const date of dates) {
      for (let hour = spot.firstHour; hour <= spot.lastHour; hour++) {
        if (cover[date][hour] == null) continue;
        const day = sunIsUp(zonedToMs(`${date} ${String(hour).padStart(2, "0")}:30`, spot.timeZone), spot.lat, spot.lon);
        const w = wx[date][hour] && { coverage: wx[date][hour].coverage, weather: wx[date][hour].weather, intensity: wx[date][hour].intensity };
        data[date][hour] = { text: skyText({ cover: cover[date][hour], wx: w, day }), rainPct: rainPct[date][hour] ?? 0, day };
      }
    }
    // For hours the hourly forecast covers, its own words and day/night win: NWS’s cover
    // cutoffs don’t match the textbook ones above (19% cover reads “Sunny”), so this keeps
    // the line under the rating exactly what NWS says.
    const hourly = await shared.nwsHourly().catch(() => null);
    for (const p of hourly?.properties.periods ?? []) {
      const at = zonedParts(Date.parse(p.startTime), spot.timeZone);
      if (!data[at.date]?.[at.hour]) continue;
      data[at.date][at.hour] = { text: p.shortForecast, rainPct: p.probabilityOfPrecipitation?.value ?? 0, day: p.isDaytime };
    }
    if (isEmpty(data)) throw new Error("No hours in the gridpoint forecast");
    return { data, label: "National Weather Service forecast",
      link: `https://forecast.weather.gov/MapClick.php?lat=${spot.lat}&lon=${spot.lon}` };
  },

  // The sky as reported by the nearest NWS station that reports it, for hours the
  // forecast has already dropped (yesterday, mostly). Each hour takes the report
  // nearest its half past.
  async skyObserved(spot, dates) {
    const { station, stationName } = spot.skyObserved;
    const start = new Date(zonedToMs(`${dates[0]} 00:00`, spot.timeZone)).toISOString();
    const json = await getJson(withQuery(`https://api.weather.gov/stations/${station}/observations`, { start }));
    const data = byDay(dates), offBy = byDay(dates);
    for (const { properties: p } of json.features) {
      if (!p.textDescription) continue;
      const ms = Date.parse(p.timestamp);
      const at = zonedParts(ms, spot.timeZone);
      if (!data[at.date] || offBy[at.date][at.hour] <= Math.abs(at.minute - 30)) continue;
      offBy[at.date][at.hour] = Math.abs(at.minute - 30);
      data[at.date][at.hour] = { text: p.textDescription, day: sunIsUp(ms, spot.lat, spot.lon), observed: stationName };
    }
    if (isEmpty(data)) throw new Error("No sky reports");
    return { data, label: `NWS observations, ${stationName} (${station})`,
      link: `https://forecast.weather.gov/data/obhistory/${station}.html` };
  },

  // Measured wind at the Presidio pier, about 1.4 km west, for hours already past.
  async windObserved(spot, dates) {
    const { station, stationName } = spot.tide;
    const json = await getJson(withQuery(COOPS, {
      ...COOPS_COMMON, product: "wind", station, interval: "h",
      begin_date: compact(dates[0]), end_date: compact(dates.at(-1)),
    }));
    const data = byDay(dates);
    for (const w of json.data) {
      const knots = Number(w.s), at = localParts(w.t);
      if (Number.isFinite(knots) && data[at.date]) data[at.date][at.hour] = { mph: Math.round(knots * 1.15078), dir: w.dr, observed: true };
    }
    return { data, label: `NOAA measured wind, ${stationName} (${station})`,
      link: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station}` };
  },

  // SFPUC beach postings, the feed behind https://webapps.sfpuc.org/sapps/beachesandbay.html.
  // XML wrapping a JSON array of stations. A posting is today’s and only today’s: SFPUC
  // doesn’t forecast, and the feed keeps no history, so past days come from the
  // server’s record.
  async waterQuality(spot, dates, shared) {
    const today = zonedParts(Date.now(), spot.timeZone).date;
    const recorded = Object.fromEntries(await Promise.all(dates.filter(d => d < today).map(async date =>
      [date, await shared.history(date).then(h => h.waterQuality, () => null) ?? { status: "unrecorded" }])));
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
    const reading = {
      // Same rules as the SFPUC page: a red status, a posted sign or a sewer
      // discharge means posted; yellow or white means not sampled.
      status: station.s_color === "R" || station.cso || (station.posted && ["R", "G"].includes(station.p_color)) ? "posted"
        : station.s_color === "Y" || station.s_color === "W" ? "unsampled"
        : "clean",
      sampled: m ? `20${String(y).padStart(2, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null,
    };
    return {
      data: Object.fromEntries(dates.map(date => [date,
        date === today ? reading : recorded[date] ?? { status: "unforecast" }])),
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
  windObserved: "NOAA measured wind", skyObserved: "NWS observations",
  waterQuality: "SFPUC beach water quality", alerts: "National Weather Service active alerts",
};
// Sources that come back by day. The rest are one reading or list for every day.
const BY_DAY = ["tide", "waves", "wind", "windObserved", "sky", "skyObserved", "waterTemp", "waterQuality"];

// One day out of loadAll’s data, in the shape model.js’s assessHour takes. A source
// that loaded but has nothing for the day gives an empty day, not null, so the card
// says there’s no forecast for the hour rather than that the source didn’t load.
export function forDate(data, date) {
  return { ...data, ...Object.fromEntries(BY_DAY.map(k => [k, data[k] ? data[k][date] ?? {} : null])) };
}

const cacheKey = (spot, key) => `plunge:${spot.id}:${key}`;
function readCache(spot, key, dates) {
  try {
    const saved = JSON.parse(localStorage.getItem(cacheKey(spot, key)));
    return saved?.dates === dates ? saved : null;
  } catch { return null; }
}
function writeCache(spot, key, entry) {
  try { localStorage.setItem(cacheKey(spot, key), JSON.stringify(entry)); } catch { /* storage unavailable */ }
}

// dates: the days to load, in order ("2026-11-15", "2026-11-16", …).
// Resolves to { data: { currents, tide, ... }, sources: [{ key, label, link, fetchedAt, stale, error }] }.
// onProgress(done, total), if given, is called as each source settles, loaded or not.
export async function loadAll(spot, dates, onProgress) {
  const keys = Object.keys(FETCHERS);
  let settled = 0;
  // Requests more than one fetcher reads, made once per load.
  let point, hourly, grid;
  const nwsPoint = () => point ??= getJson(`https://api.weather.gov/points/${spot.lat},${spot.lon}`);
  const history = {};
  const shared = {
    nwsHourly: () => hourly ??= nwsPoint().then(p => getJson(p.properties.forecastHourly)),
    nwsGrid: () => grid ??= nwsPoint().then(p => getJson(p.properties.forecastGridData)),
    // What the server recorded for a past day (see server/functions/plunge).
    history: date => history[date] ??= getJson(withQuery(`${SERVER}/history`, { date })),
  };
  const results = await Promise.all(keys.map(async key => {
    const result = await loadOne(key);
    onProgress?.(++settled, keys.length);
    return result;
  }));
  async function loadOne(key) {
    try {
      const got = await FETCHERS[key](spot, dates, shared);
      const entry = { dates: dates.join(), ...got, fetchedAt: Date.now() };
      writeCache(spot, key, entry);
      return { key, ...entry, stale: false };
    } catch (err) {
      const saved = readCache(spot, key, dates.join());
      return saved ? { key, ...saved, stale: true, error: err.message }
        : { key, label: NAMES[key], data: null, error: err.message };
    }
  }
  return {
    data: Object.fromEntries(results.map(r => [r.key, r.data])),
    sources: results.map(({ data, dates: _d, ...meta }) => meta),
  };
}
