// Plunge’s server side: fetches public data that browsers can’t read directly (the
// source doesn’t send CORS headers) and hands it to the app as JSON.
//
// Runs as a Supabase edge function on the self-hosted Supabase at
// supabase.erichenry.com, at /functions/v1/plunge/<route>. The gateway adds the CORS
// headers. Deploy: see server/README.md.
//
// Only fixed upstream URLs are fetched; nothing in a request picks what gets fetched,
// so this can’t be used as an open proxy.
//
// It also keeps a record of what sources forget: every hour, cron on the server calls
// /collect, which saves each beach’s water quality posting (SFPUC keeps no history) and
// Crissy East’s latest wave run (runs vanish after about two days), and each STOFS water
// level run at the tide gauge (NOMADS keeps about a day of them), to the
// plunge.history table. /history?date=&spot= reads a past day back, /water-level
// stitches the saved STOFS runs into one series, and
// /posted-since?spot= says how long the current posting has stood. Routes that take a
// spot answer for Crissy East without one, and name the spot they answer for.

import { nearestWater, readFields } from "./grib2.ts";

// Each beach’s SFPUC stations: the worst of them counts (see js/spots/). The first is
// the default, for requests that name no spot.
const SPOTS: Record<string, { stations: string[] }> = {
  "crissy-east": { stations: ["4612"] },
  "baker-beach": { stations: ["4608", "4610", "4609"] },
};
const DEFAULT_SPOT = "crissy-east";
const TIME_ZONE = "America/Los_Angeles";

// How long each route’s answer is reused, and the answers themselves. Routes marked
// bySpot answer for one beach.
const ROUTES: Record<string, { cacheMs: number; bySpot?: boolean; load: (spot: string) => Promise<unknown> }> = {
  "water-temp": { cacheMs: 10 * 60e3, load: waterTemp },
  // A new wave run comes out about every 12 hours, some 7 hours after its start time.
  // Crissy East’s only: Baker Beach’s waves come from CDIP, which browsers can read.
  "waves": { cacheMs: 30 * 60e3, load: waves },
  "water-quality": { cacheMs: 10 * 60e3, bySpot: true, load: waterQuality },
  // SFO reports once an hour, at :56. The Iowa Environmental Mesonet is a volunteer
  // service that limits how often one address asks, so every phone shares one copy
  // (see rain() for what happens when it says no).
  "rain": { cacheMs: 30 * 60e3, load: rain },
  "posted-since": { cacheMs: 10 * 60e3, bySpot: true, load: postedSince },
  // Stitched from the STOFS runs /collect saves (a new one about every 6 hours).
  "water-level": { cacheMs: 30 * 60e3, load: waterLevel },
};
// Requests that arrive while a load is under way wait for it instead of starting
// their own, so a busy moment asks each source once.
const cache = new Map<string, { at: number; body: unknown }>();
const loading = new Map<string, Promise<unknown>>();
async function cached(route: string, spot = DEFAULT_SPOT) {
  const spec = ROUTES[route];
  const key = spec.bySpot ? `${route}:${spot}` : route;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= spec.cacheMs) return hit.body;
  let pending = loading.get(key);
  if (!pending) {
    pending = spec.load(spot).then(body => {
      const value = spec.bySpot ? { spot, ...body as object } : body;
      cache.set(key, { at: Date.now(), body: value });
      return value;
    }).finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

// Water temperature readings from NDBC buoy 46237 (San Francisco Bar), newest first.
// The file holds the last 45 days.
async function buoyReadings() {
  const res = await fetch("https://www.ndbc.noaa.gov/data/realtime2/46237.txt");
  if (!res.ok) throw new Error(`NDBC responded ${res.status}`);
  const lines = (await res.text()).split("\n");
  const columns = lines[0].replace(/^#/, "").trim().split(/\s+/);
  const col = (name: string) => columns.indexOf(name);
  const readings: { ms: number; f: number }[] = [];
  for (const line of lines) {
    if (line.startsWith("#") || !line.trim()) continue;
    const v = line.trim().split(/\s+/);
    const c = Number(v[col("WTMP")]);
    if (!Number.isFinite(c)) continue; // "MM" means missing
    const [y, mo, d, h, mi] = ["YY", "MM", "DD", "hh", "mm"].map(k => Number(v[col(k)]));
    readings.push({ ms: Date.UTC(y, mo - 1, d, h, mi), f: Math.round((c * 9 / 5 + 32) * 10) / 10 });
  }
  return readings;
}

// Latest water temperature from the buoy.
async function waterTemp() {
  const [latest] = await buoyReadings();
  if (!latest) throw new Error("No water temperature in the latest readings");
  return {
    station: "46237", name: "San Francisco Bar",
    celsius: Math.round((latest.f - 32) * 5 / 9 * 10) / 10, fahrenheit: latest.f,
    observedAt: new Date(latest.ms).toISOString(),
  };
}

// A beach’s posting from SFPUC, the feed behind
// https://webapps.sfpuc.org/sapps/beachesandbay.html: XML wrapping a JSON array of
// stations. The worst of the beach’s stations, by the same rules as js/sources.js
// (worstPosting): any posted makes it posted, for an overflow if any was, as of the
// latest posted sample; clean only when every station is, as of the oldest sample;
// otherwise not sampled. A station missing from the feed counts as not sampled.
type Posting = { status: string; reason?: string; sampled: string | null };
async function waterQuality(spot: string) {
  const res = await fetch("https://infrastructure.sfwater.org/lims.asmx/getBeaches");
  if (!res.ok) throw new Error(`SFPUC responded ${res.status}`);
  const inner = (await res.text()).match(/<string[^>]*>([\s\S]*)<\/string>/)?.[1];
  if (!inner) throw new Error("Unexpected response from SFPUC");
  const decoded = inner.replace(/&(quot|amp|lt|gt|apos|#39);/g, (_, e: string) =>
    ({ quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", "#39": "'" } as Record<string, string>)[e]);
  // deno-lint-ignore no-explicit-any
  const feed = JSON.parse(decoded) as any[];
  const ids = SPOTS[spot].stations;
  const found = ids.map(id => feed.find(x => x.stationid === id));
  if (!found.some(Boolean)) throw new Error(`Station ${ids.join(", ")} not in the SFPUC feed`);
  // deno-lint-ignore no-explicit-any
  const all: Posting[] = found.map((station: any) => {
    if (!station) return { status: "unsampled", sampled: null };
    const [m, d, y] = (station.sample_date ?? "").split("/").map(Number);
    const status = station.s_color === "R" || station.cso || (station.posted && ["R", "G"].includes(station.p_color)) ? "posted"
      : station.s_color === "Y" || station.s_color === "W" ? "unsampled"
      : "clean";
    return {
      status,
      // cso names the outfall that overflowed; any other posting is for bacteria.
      ...(status === "posted" && { reason: station.cso ? "overflow" : "bacteria" }),
      sampled: m ? `20${String(y).padStart(2, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null,
    };
  });
  const posted = all.filter(p => p.status === "posted");
  const dates = (ps: Posting[]) => ps.map(p => p.sampled).filter((x): x is string => !!x).sort();
  if (posted.length) {
    return { status: "posted", reason: posted.some(p => p.reason === "overflow") ? "overflow" : "bacteria",
      sampled: dates(posted).at(-1) ?? null };
  }
  if (all.every(p => p.status === "clean")) {
    return { status: "clean", sampled: dates(all).length === all.length ? dates(all)[0] : null };
  }
  return { status: "unsampled", sampled: dates(all).at(-1) ?? null };
}

// Wave height forecast for Crissy Field East Beach from the NWS Nearshore Wave
// Prediction System: SWAN run by NWS San Francisco Bay Area (MTR) on its ~1 km grid
// around the Bay (CG2), which models the Golden Gate’s seafloor, swell bending into
// the Bay, wind chop inside it and the tidal current. Each run is one 18 MB GRIB2
// file; only the grid point at the beach is kept.
const BEACH = { lat: 37.8068, lon: -122.4505 };
const NWPS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/nwps/prod";

async function waves() {
  // Newest run first: 12Z and 00Z, today and yesterday (UTC). A run’s file appears
  // several hours after its start, so the newest ones are often not there yet.
  const now = new Date();
  const runs: { day: string; hh: string }[] = [];
  for (const back of [0, 1]) {
    const day = new Date(now.getTime() - back * 864e5).toISOString().slice(0, 10).replaceAll("-", "");
    for (const hh of ["12", "00"]) runs.push({ day, hh });
  }
  for (const { day, hh } of runs) {
    const res = await fetch(`${NWPS}/wr.${day}/mtr/${hh}/CG2/nwps.t${hh}z.cg2.mtr.grib2`);
    if (!res.ok) { await res.body?.cancel(); continue; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    let cell: { i: number; j: number } | null = null;
    const hours: { time: string; ft: number }[] = [];
    for (const f of readFields(bytes)) {
      // Discipline 10, category 0, number 3: significant height of combined wind
      // waves and swell, in meters.
      if (f.discipline !== 10 || f.category !== 0 || f.number !== 3) continue;
      cell ??= nearestWater(f, BEACH.lat, BEACH.lon);
      if (!cell) throw new Error("No water grid point near the beach");
      const m = f.valueAt(cell.i, cell.j);
      if (m === null) continue;
      hours.push({ time: new Date(f.refTime.getTime() + f.forecastHours * 3600e3).toISOString(),
        ft: Math.round(m * 3.28084 * 100) / 100 });
    }
    if (!cell || !hours.length) throw new Error("No wave heights in the latest run");
    const { grid } = readFields(bytes).next().value!;
    return {
      model: "NWS NWPS, San Francisco Bay Area (MTR) CG2",
      run: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T${hh}:00:00Z`,
      point: { lat: round4(grid.lat1 + cell.j * grid.dj), lon: round4(grid.lon1 + cell.i * grid.di) },
      hours,
    };
  }
  throw new Error("No NWPS run available");
}
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

// Water level forecast at the San Francisco (Presidio) tide gauge from NOAA’s Surge
// and Tide Operational Forecast System (STOFS-2D-Global): tide and storm surge
// together, corrected toward what the gauge has been reading, in feet above MLLW every
// 30 minutes for about seven days. Each run’s station forecasts come as a SHEF text
// file (about 2 MB); only the gauge’s block is kept. NWS calls the gauge FTPC1 (Fort Point); NOAA calls it 9414290.
const STOFS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/stofs/prod";
const STOFS_STATION = "FTPC1";

// The runs NOMADS still has (it keeps about a day), newest first: 18Z, 12Z, 06Z and
// 00Z, today and yesterday (UTC). A run’s file appears a few hours after its start.
function stofsRuns() {
  const now = Date.now(), runs: { day: string; hh: string; run: string }[] = [];
  for (const back of [0, 1]) {
    const day = new Date(now - back * 864e5).toISOString().slice(0, 10).replaceAll("-", "");
    for (const hh of ["18", "12", "06", "00"]) {
      const run = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T${hh}:00:00Z`;
      if (Date.parse(run) < now) runs.push({ day, hh, run });
    }
  }
  return runs;
}

// One run’s forecast at the gauge, or null when its file isn’t there (yet, or anymore).
async function stofsRun({ day, hh, run }: { day: string; hh: string; run: string }) {
  const res = await fetch(`${STOFS}/stofs_2d_glo.${day}/stofs_2d_glo.t${hh}z.points.cwl.shef`);
  if (!res.ok) { await res.body?.cancel(); return null; }
  return { run, station: STOFS_STATION, points: readShef(await res.text(), STOFS_STATION) };
}
type StofsRun = { run: string; station: string; points: { time: string; ft: number }[] };

// The water level from yesterday on, from the runs /collect has saved: at each half
// hour, the newest run that reaches it. Where a newer run takes over, it fades in over
// a few hours, so the line doesn’t step from one run to the next.
const FADE_MS = 3 * 3600e3;
async function waterLevel() {
  const from = local(Date.now() - 3 * 864e5).date;
  const rows = await db(`?spot=eq.${DEFAULT_SPOT}&kind=eq.waterLevelForecast&date=gte.${from}&select=value`) as { value: StofsRun }[];
  const runs = rows.map(r => ({ run: r.value.run, startMs: Date.parse(r.value.run),
    ft: new Map(r.value.points.map(p => [Date.parse(p.time), p.ft])) })).sort((a, b) => a.startMs - b.startMs);
  if (!runs.length) throw new Error("No STOFS runs saved yet");
  const since = Date.now() - 2 * 864e5;
  const times = [...new Set(runs.flatMap(r => [...r.ft.keys()]))].filter(ms => ms >= since).sort((a, b) => a - b);
  const points = times.map(ms => {
    let ft: number | null = null;
    for (const r of runs) {
      const v = r.ft.get(ms);
      if (v === undefined) continue;
      ft = ft === null ? v : ft + (v - ft) * Math.min(1, (ms - r.startMs) / FADE_MS);
    }
    return { time: new Date(ms).toISOString(), ft: Math.round(ft! * 100) / 100 };
  });
  return { model: "NOAA STOFS-2D-Global, combined water level", station: STOFS_STATION,
    runs: runs.map(r => r.run), points };
}

// One station’s series from a SHEF file: “.E FTPC1 20261122 Z DH0000/DC…/HMIFC/DIN30/ 1.70/ 2.00/…”,
// then “.E1 …”, “.E2 …” lines of more values. DH is the first value’s UTC hour and
// minute, DIN the minutes between values. → [{ time, ft }], missing values left out.
function readShef(text: string, station: string) {
  const lines = text.split("\n");
  const start = lines.findIndex(l => l.startsWith(`.E ${station} `));
  if (start < 0) throw new Error(`Station ${station} not in the STOFS run`);
  const head = lines[start].match(/^\.E \S+ (\d{4})(\d\d)(\d\d) Z DH(\d\d)(\d\d)\/.*?\/DIN(\d+)\/(.*)$/);
  if (!head) throw new Error(`Unexpected STOFS line: ${lines[start].slice(0, 80)}`);
  const [, y, mo, d, h, mi, step, rest] = head;
  const values = rest.split("/");
  for (const line of lines.slice(start + 1)) {
    const more = line.match(/^\.E\d+\s+(.*)$/);
    if (!more) break;
    values.push(...more[1].split("/"));
  }
  const t0 = Date.UTC(+y, +mo - 1, +d, +h, +mi), stepMs = +step * 60e3;
  const points: { time: string; ft: number }[] = [];
  values.map(v => v.trim()).filter(Boolean).forEach((v, k) => {
    const ft = Number(v);
    // SHEF marks a missing value with M or -9999.
    if (Number.isFinite(ft) && ft > -99) points.push({ time: new Date(t0 + k * stepMs).toISOString(), ft });
  });
  if (!points.length) throw new Error(`No water levels for ${station} in the STOFS run`);
  return points;
}

// A fetch that gives up after timeoutMs, and tries again (tries in all) when the
// network fails, the request times out, or the source answers 429 or 5xx: waiting
// as long as Retry-After asks, up to 5 s, or 1 s, then 2 s.
async function fetchRetry(url: string, init: RequestInit = {}, { tries = 2, timeoutMs = 15e3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let wait = 1000 * 2 ** (attempt - 1);
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (attempt >= tries || (res.status !== 429 && res.status < 500)) return res;
      const after = Number(res.headers.get("Retry-After"));
      if (Number.isFinite(after) && after > 0) wait = Math.min(after * 1000, 5000);
      await res.body?.cancel();
    } catch (err) {
      if (attempt >= tries) throw err;
    }
    await new Promise(r => setTimeout(r, wait));
  }
}

// The NWS asks every client to name itself.
const NWS_HEADERS = { "User-Agent": "Plunge beach conditions (supabase.erichenry.com)", Accept: "application/geo+json" };

type RainHour = { time: string; in: number };
type Rain = { station: string; name: string; source: string; hours: RainHour[]; through: string };

// Measured rain at SFO, the nearest NWS gauge to the beach (about 17 km south), by
// hour for the last 8 days: the precipitation in each routine hourly METAR, which
// SFO sends at :56. Each hour is the one that report closes. A trace counts as none:
// it’s below the 0.01″ the gauge can measure.
//
// The same reports come from two places, tried in turn, so one being down or busy
// doesn’t lose the gauge:
//   1. The Iowa Environmental Mesonet’s archive, which reads them for us. It turns
//      away an address that asks again within seconds (429).
//   2. The NWS’s own station observations, whose METAR text we read.
// Each good answer is saved to plunge.history (kind rain, one row per hour), and when
// both fail the saved hours answer, as long as they reach within STALE_RAIN_MS of now.
const RAIN_DAYS = 8, STALE_RAIN_MS = 6 * 3600e3;
async function rain(): Promise<Rain> {
  const errors: string[] = [];
  for (const [source, load] of [["Iowa Environmental Mesonet", rainFromMesonet], ["NWS station observations", rainFromNws]] as const) {
    try {
      const hours = await load();
      const answer = rainAnswer(source, hours);
      saveRain(hours).catch(err => console.error(`Saving rain: ${(err as Error).message}`));
      return answer;
    } catch (err) {
      errors.push(`${source}: ${(err as Error).message}`);
    }
  }
  try {
    const answer = rainAnswer("saved copy", await savedRain());
    if (Date.now() - Date.parse(answer.through) <= STALE_RAIN_MS) return answer;
    errors.push(`saved copy: ends ${answer.through}`);
  } catch (err) {
    errors.push(`saved copy: ${(err as Error).message}`);
  }
  throw new Error(`No rain from SFO. ${errors.join("; ")}`);
}

// Report times and inches, newest last, as the answer the app reads: one entry per
// hour, at the hour’s start, and through, the time of the last report.
function rainAnswer(source: string, reports: RainHour[]): Rain {
  if (!reports.length) throw new Error("No rain reports from SFO");
  const byHour = new Map<string, number>();
  let through = 0;
  for (const r of reports) {
    const ms = Date.parse(r.time);
    byHour.set(new Date(ms - ms % 3600e3).toISOString(), r.in < 0.01 ? 0 : r.in);
    through = Math.max(through, ms);
  }
  return {
    station: "SFO", name: "San Francisco International Airport", source,
    hours: [...byHour].sort(([a], [b]) => a.localeCompare(b)).map(([time, inches]) => ({ time, in: inches })),
    through: new Date(through).toISOString(),
  };
}

async function rainFromMesonet(): Promise<RainHour[]> {
  const start = new Date(Date.now() - RAIN_DAYS * 864e5), end = new Date(Date.now() + 864e5);
  const ymd = (d: Date, n: number) => ({ [`year${n}`]: String(d.getUTCFullYear()),
    [`month${n}`]: String(d.getUTCMonth() + 1), [`day${n}`]: String(d.getUTCDate()) });
  // A 429 lifts within seconds, so one more try after the wait is worth it.
  const res = await fetchRetry(`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${new URLSearchParams({
    station: "SFO", data: "p01i", tz: "UTC", format: "onlycomma", latlon: "no", report_type: "3",
    ...ymd(start, 1), ...ymd(end, 2) })}`, {}, { tries: 2 });
  if (!res.ok) throw new Error(`responded ${res.status}`);
  const lines = (await res.text()).trim().split("\n");
  if (!/^station,valid,p01i/.test(lines[0] ?? "")) throw new Error(`unexpected response: ${lines[0]?.slice(0, 80)}`);
  const reports: RainHour[] = [];
  for (const line of lines.slice(1)) {
    const [, valid, p01i] = line.split(",");
    if (!valid || p01i === "M") continue;
    reports.push({ time: new Date(`${valid.replace(" ", "T")}:00Z`).toISOString(), in: p01i === "T" ? 0 : Number(p01i) });
  }
  return reports;
}

async function rainFromNws(): Promise<RainHour[]> {
  const since = Date.now() - RAIN_DAYS * 864e5;
  let url: string | undefined = `https://api.weather.gov/stations/KSFO/observations?${new URLSearchParams({
    start: new Date(since).toISOString(), limit: "500" })}`;
  const reports: RainHour[] = [];
  // Newest first, 500 to a page; 8 days of SFO’s reports take a page or two.
  for (let page = 0; url && page < 5; page++) {
    const res = await fetchRetry(url, { headers: NWS_HEADERS });
    if (!res.ok) throw new Error(`responded ${res.status}`);
    const json = await res.json() as { features: { properties: { timestamp: string; rawMessage?: string } }[]; pagination?: { next?: string } };
    if (!json.features.length) break;
    for (const f of json.features) {
      const inches = metarHourlyRain(f.properties.rawMessage ?? "");
      if (inches != null) reports.push({ time: f.properties.timestamp, in: inches });
    }
    if (Date.parse(json.features.at(-1)!.properties.timestamp) <= since) break;
    url = json.pagination?.next;
  }
  return reports.reverse();
}

// The rain in a routine hourly METAR from SFO, in inches, or null for any other
// report, or one whose gauge reading is missing. The remarks carry it as Pnnnn, in
// hundredths of an inch (P0000 is a trace); a routine report with none had no rain.
// PNO means the gauge isn’t reporting.
export function metarHourlyRain(raw: string): number | null {
  const m = raw.match(/^(?:METAR |SPECI )?KSFO \d{4}(\d{2})Z\b/);
  if (!m || m[1] !== "56" || /^SPECI /.test(raw)) return null;
  const remarks = raw.split(/\sRMK\s/)[1] ?? "";
  if (/\bPNO\b/.test(remarks)) return null;
  const p = remarks.match(/\bP(\d{4})\b/);
  return p ? Number(p[1]) / 100 : 0;
}

// Each hour’s report, upserted, so the record outlives both sources’ bad moments.
async function saveRain(reports: RainHour[]) {
  // The hour clocks repeat in the fall is one row; the later report keeps it, as one
  // upsert can’t name a row twice.
  const rows = [...new Map(reports.map(r => {
    const row: Row = { spot: DEFAULT_SPOT, kind: "rain", ...local(Date.parse(r.time)), value: r };
    return [`${row.date} ${row.hour}`, row];
  })).values()];
  for (let i = 0; i < rows.length; i += 500) {
    await db("?on_conflict=spot,kind,date,hour", { method: "POST", body: JSON.stringify(rows.slice(i, i + 500)),
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
  }
}

async function savedRain(): Promise<RainHour[]> {
  const rows = await db(`?spot=eq.${DEFAULT_SPOT}&kind=eq.rain&date=gte.${local(Date.now() - RAIN_DAYS * 864e5).date}` +
    `&select=value`) as { value: RainHour }[];
  return rows.map(r => r.value);
}

// ---- History -------------------------------------------------------------------------

// The local date and hour of an instant at the beach: { date: "2026-11-16", hour: 13 }.
const LOCAL = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", hourCycle: "h23" });
function local(ms: number) {
  const p = Object.fromEntries(LOCAL.formatToParts(ms).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// plunge.history through the database’s REST API, as the service role (the table
// has row-level security on and no policies, so nothing else can read or write it).
// The profile headers pick the plunge schema; see server/schema.sql.
async function db(path: string, init: RequestInit = {}) {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/history${path}`, {
    ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      "Accept-Profile": "plunge", "Content-Profile": "plunge", ...init.headers },
  });
  if (!res.ok) throw new Error(`Database responded ${res.status}: ${await res.text()}`);
  return res.status === 204 || init.method === "POST" ? null : res.json();
}

type Row = { spot: string; kind: string; date: string; hour: number; value: unknown };

// Saves this hour’s posting at each beach, and Crissy East’s wave height for every hour from the start of
// yesterday to now that the latest run covers (a newer run’s value replaces an older
// one’s). Each source is saved on its own: one failing doesn’t stop the other.
async function collect() {
  const now = local(Date.now());
  const rows: Row[] = [];
  const errors: Record<string, string> = {};
  for (const spot of Object.keys(SPOTS)) {
    try {
      const { spot: _, ...value } = await cached("water-quality", spot) as Posting & { spot: string };
      rows.push({ spot, kind: "waterQuality", ...now, value });
    } catch (err) { errors[`waterQuality:${spot}`] = (err as Error).message; }
  }
  try {
    const run = await cached("waves") as Awaited<ReturnType<typeof waves>>;
    const since = Date.now() - 2 * 864e5;
    for (const { time, ft } of run.hours) {
      const ms = Date.parse(time);
      if (ms > since && ms <= Date.now()) rows.push({ spot: DEFAULT_SPOT, kind: "waves", ...local(ms), value: { ft, run: run.run } });
    }
  } catch (err) { errors.waves = (err as Error).message; }
  // Each STOFS run still on NOMADS that isn’t saved yet, whole, filed under its start
  // time: /water-level stitches them together, and they’re the record to score the
  // forecast against what the gauge measured (NOAA keeps the gauge’s own record).
  try {
    const saved = new Set((await db(`?spot=eq.${DEFAULT_SPOT}&kind=eq.waterLevelForecast&date=gte.${local(Date.now() - 3 * 864e5).date}` +
      `&select=value->>run`) as { run: string }[]).map(r => r.run));
    for (const candidate of stofsRuns().filter(r => !saved.has(r.run))) {
      try {
        const run = await stofsRun(candidate);
        if (run) rows.push({ spot: DEFAULT_SPOT, kind: "waterLevelForecast", ...local(Date.parse(run.run)), value: run });
      } catch (err) { errors[`waterLevelForecast:${candidate.run}`] = (err as Error).message; }
    }
  } catch (err) { errors.waterLevelForecast = (err as Error).message; }
  if (rows.length) {
    await db("?on_conflict=spot,kind,date,hour", { method: "POST", body: JSON.stringify(rows),
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
  }
  return { at: new Date().toISOString(), saved: rows.length, errors };
}

// When the current posting began: the first hour of the latest unbroken run of the
// same status in the record, looking back 45 days. A run older than that reports the
// oldest hour looked at, which is later than the truth but still a posting that old.
async function postedSince(spot: string) {
  const from = local(Date.now() - 45 * 864e5).date;
  const rows = await db(`?spot=eq.${spot}&kind=eq.waterQuality&date=gte.${from}` +
    `&select=recorded_at,value&order=date.desc,hour.desc`) as { recorded_at: string; value: { status: string } }[];
  const status = rows[0]?.value.status;
  if (!status) throw new Error("No postings recorded");
  let since = rows[0].recorded_at;
  for (const r of rows) {
    if (r.value.status !== status) break;
    since = r.recorded_at;
  }
  return { status, since };
}

// A past day: the last posting recorded that day, the wave height by hour, and the
// buoy’s water temperature by hour (the reading nearest each half past, within half
// an hour; the buoy file itself keeps 45 days, so this isn’t recorded).
async function history(date: string, spot: string) {
  const rows = await db(`?spot=eq.${spot}&date=eq.${date}&select=kind,hour,value&order=hour`) as Row[];
  const waves: Record<number, number> = {};
  let waterQuality = null;
  for (const r of rows) {
    if (r.kind === "waves") waves[r.hour] = (r.value as { ft: number }).ft;
    if (r.kind === "waterQuality") waterQuality = r.value; // in hour order, so the last wins
  }
  const waterTemp: Record<number, { f: number; ms: number }> = {};
  try {
    for (const r of await buoyReadings()) {
      const at = local(r.ms);
      if (at.date !== date) continue;
      const halfPast = r.ms - (new Date(r.ms).getUTCMinutes() - 30) * 60e3;
      const best = waterTemp[at.hour];
      if (!best || Math.abs(r.ms - halfPast) < Math.abs(best.ms - halfPast)) waterTemp[at.hour] = r;
    }
  } catch { /* water temperature is left out; the rest still answers */ }
  return { spot, date, waterQuality, waves, waterTemp };
}

Deno.serve(async req => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (req.method !== "GET") return Response.json({ error: "Not found" }, { status: 404 });
  const spot = url.searchParams.get("spot") ?? DEFAULT_SPOT;
  if (!SPOTS[spot]) return Response.json({ error: "Unknown spot" }, { status: 400 });
  try {
    if (route === "collect") return Response.json(await collect(), { headers: { "Cache-Control": "no-store" } });
    if (route === "history") {
      const date = url.searchParams.get("date") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
      return Response.json(await history(date, spot), { headers: { "Cache-Control": "public, max-age=600", "Vary": "Origin" } });
    }
    if (!ROUTES[route]) return Response.json({ error: "Not found" }, { status: 404 });
    // The gateway’s CORS header echoes the requesting site, so caches must keep one
    // copy per site (Vary: Origin) or a copy fetched from one site breaks another.
    return Response.json(await cached(route, spot),
      { headers: { "Cache-Control": `public, max-age=${ROUTES[route].cacheMs / 1000}`, "Vary": "Origin" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
});
