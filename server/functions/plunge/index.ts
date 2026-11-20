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
// /collect, which saves the beach’s water quality posting (SFPUC keeps no history) and
// the latest run’s wave height (runs vanish after about two days) to the
// plunge.history table. /history?date= reads a past day back, and /posted-since says
// how long the current posting has stood.

import { nearestWater, readFields } from "./grib2.ts";

const SPOT = "crissy-east";
const TIME_ZONE = "America/Los_Angeles";

// How long each route’s answer is reused, and the answers themselves.
const ROUTES: Record<string, { cacheMs: number; load: () => Promise<unknown> }> = {
  "water-temp": { cacheMs: 10 * 60e3, load: waterTemp },
  // A new wave run comes out about every 12 hours, some 7 hours after its start time.
  "waves": { cacheMs: 30 * 60e3, load: waves },
  "water-quality": { cacheMs: 10 * 60e3, load: waterQuality },
  // SFO reports once an hour, at :56. The Iowa Environmental Mesonet is a volunteer
  // service that limits how often one address asks, so every phone shares one copy.
  "rain": { cacheMs: 30 * 60e3, load: rain },
  "posted-since": { cacheMs: 10 * 60e3, load: postedSince },
};
const cache = new Map<string, { at: number; body: unknown }>();
async function cached(route: string) {
  const spec = ROUTES[route];
  let hit = cache.get(route);
  if (!hit || Date.now() - hit.at > spec.cacheMs) cache.set(route, hit = { at: Date.now(), body: await spec.load() });
  return hit.body;
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

// The beach’s posting from SFPUC, the feed behind
// https://webapps.sfpuc.org/sapps/beachesandbay.html: XML wrapping a JSON array of
// stations. Same rules as js/sources.js.
async function waterQuality() {
  const res = await fetch("https://infrastructure.sfwater.org/lims.asmx/getBeaches");
  if (!res.ok) throw new Error(`SFPUC responded ${res.status}`);
  const inner = (await res.text()).match(/<string[^>]*>([\s\S]*)<\/string>/)?.[1];
  if (!inner) throw new Error("Unexpected response from SFPUC");
  const decoded = inner.replace(/&(quot|amp|lt|gt|apos|#39);/g, (_, e: string) =>
    ({ quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", "#39": "'" } as Record<string, string>)[e]);
  // deno-lint-ignore no-explicit-any
  const station = JSON.parse(decoded).find((x: any) => x.stationid === "4612");
  if (!station) throw new Error("Station 4612 not in the SFPUC feed");
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

// Measured rain at SFO, the nearest NWS gauge to the beach (about 17 km south), by
// hour for the last 8 days: the hourly METAR’s precipitation, from the Iowa
// Environmental Mesonet’s archive. Each hour is the one a report at :56 closes.
// A trace counts as none.
async function rain() {
  const start = new Date(Date.now() - 8 * 864e5), end = new Date(Date.now() + 864e5);
  const ymd = (d: Date, n: number) => ({ [`year${n}`]: String(d.getUTCFullYear()),
    [`month${n}`]: String(d.getUTCMonth() + 1), [`day${n}`]: String(d.getUTCDate()) });
  const res = await fetch(`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${new URLSearchParams({
    station: "SFO", data: "p01i", tz: "UTC", format: "onlycomma", latlon: "no", report_type: "3",
    ...ymd(start, 1), ...ymd(end, 2) })}`);
  if (!res.ok) throw new Error(`Iowa Environmental Mesonet responded ${res.status}`);
  const lines = (await res.text()).trim().split("\n");
  if (!/^station,valid,p01i/.test(lines[0] ?? "")) throw new Error(`Unexpected response: ${lines[0]?.slice(0, 80)}`);
  const byHour = new Map<string, number>();
  let through = 0;
  for (const line of lines.slice(1)) {
    const [, valid, p01i] = line.split(",");
    if (!valid || p01i === "M") continue;
    const ms = Date.parse(`${valid.replace(" ", "T")}:00Z`);
    byHour.set(new Date(ms - ms % 3600e3).toISOString(), p01i === "T" ? 0 : Number(p01i));
    through = Math.max(through, ms);
  }
  if (!through) throw new Error("No rain reports from SFO");
  return {
    station: "SFO", name: "San Francisco International Airport",
    hours: [...byHour].map(([time, inches]) => ({ time, in: inches })),
    through: new Date(through).toISOString(),
  };
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

// Saves this hour’s posting, and the wave height for every hour from the start of
// yesterday to now that the latest run covers (a newer run’s value replaces an older
// one’s). Each source is saved on its own: one failing doesn’t stop the other.
async function collect() {
  const now = local(Date.now());
  const rows: Row[] = [];
  const errors: Record<string, string> = {};
  try {
    rows.push({ spot: SPOT, kind: "waterQuality", ...now, value: await cached("water-quality") });
  } catch (err) { errors.waterQuality = (err as Error).message; }
  try {
    const run = await cached("waves") as Awaited<ReturnType<typeof waves>>;
    const since = Date.now() - 2 * 864e5;
    for (const { time, ft } of run.hours) {
      const ms = Date.parse(time);
      if (ms > since && ms <= Date.now()) rows.push({ spot: SPOT, kind: "waves", ...local(ms), value: { ft, run: run.run } });
    }
  } catch (err) { errors.waves = (err as Error).message; }
  if (rows.length) {
    await db("?on_conflict=spot,kind,date,hour", { method: "POST", body: JSON.stringify(rows),
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
  }
  return { at: new Date().toISOString(), saved: rows.length, errors };
}

// When the current posting began: the first hour of the latest unbroken run of the
// same status in the record, looking back 45 days. A run older than that reports the
// oldest hour looked at, which is later than the truth but still a posting that old.
async function postedSince() {
  const from = local(Date.now() - 45 * 864e5).date;
  const rows = await db(`?spot=eq.${SPOT}&kind=eq.waterQuality&date=gte.${from}` +
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
async function history(date: string) {
  const rows = await db(`?spot=eq.${SPOT}&date=eq.${date}&select=kind,hour,value&order=hour`) as Row[];
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
  return { date, waterQuality, waves, waterTemp };
}

Deno.serve(async req => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (req.method !== "GET") return Response.json({ error: "Not found" }, { status: 404 });
  try {
    if (route === "collect") return Response.json(await collect(), { headers: { "Cache-Control": "no-store" } });
    if (route === "history") {
      const date = url.searchParams.get("date") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
      return Response.json(await history(date), { headers: { "Cache-Control": "public, max-age=600", "Vary": "Origin" } });
    }
    if (!ROUTES[route]) return Response.json({ error: "Not found" }, { status: 404 });
    // The gateway’s CORS header echoes the requesting site, so caches must keep one
    // copy per site (Vary: Origin) or a copy fetched from one site breaks another.
    return Response.json(await cached(route),
      { headers: { "Cache-Control": `public, max-age=${ROUTES[route].cacheMs / 1000}`, "Vary": "Origin" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
});
