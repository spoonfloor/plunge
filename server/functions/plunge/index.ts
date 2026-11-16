// Plunge’s server side: fetches public data that browsers can’t read directly (the
// source doesn’t send CORS headers) and hands it to the app as JSON.
//
// Runs as a Supabase edge function on the self-hosted Supabase at
// supabase.erichenry.com, at /functions/v1/plunge/<route>. The gateway adds the CORS
// headers. Deploy: see server/README.md.
//
// Only fixed upstream URLs are fetched; nothing in a request picks what gets fetched,
// so this can’t be used as an open proxy.

import { nearestWater, readFields } from "./grib2.ts";

// How long each route’s answer is reused, and the answers themselves.
const ROUTES: Record<string, { cacheMs: number; load: () => Promise<unknown> }> = {
  "water-temp": { cacheMs: 10 * 60e3, load: waterTemp },
  // A new wave run comes out about every 12 hours, some 7 hours after its start time.
  "waves": { cacheMs: 30 * 60e3, load: waves },
};
const cache = new Map<string, { at: number; body: unknown }>();

// Latest water temperature from NDBC buoy 46237 (San Francisco Bar).
async function waterTemp() {
  const res = await fetch("https://www.ndbc.noaa.gov/data/realtime2/46237.txt");
  if (!res.ok) throw new Error(`NDBC responded ${res.status}`);
  const lines = (await res.text()).split("\n");
  const columns = lines[0].replace(/^#/, "").trim().split(/\s+/);
  const col = (name: string) => columns.indexOf(name);
  for (const line of lines) {
    if (line.startsWith("#") || !line.trim()) continue;
    const v = line.trim().split(/\s+/);
    const c = Number(v[col("WTMP")]);
    if (!Number.isFinite(c)) continue; // "MM" means missing
    const [y, mo, d, h, mi] = ["YY", "MM", "DD", "hh", "mm"].map(k => Number(v[col(k)]));
    return {
      station: "46237", name: "San Francisco Bar",
      celsius: c, fahrenheit: Math.round((c * 9 / 5 + 32) * 10) / 10,
      observedAt: new Date(Date.UTC(y, mo - 1, d, h, mi)).toISOString(),
    };
  }
  throw new Error("No water temperature in the latest readings");
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

Deno.serve(async req => {
  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  const spec = ROUTES[route];
  if (req.method !== "GET" || !spec) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  try {
    let hit = cache.get(route);
    if (!hit || Date.now() - hit.at > spec.cacheMs) cache.set(route, hit = { at: Date.now(), body: await spec.load() });
    // The gateway’s CORS header echoes the requesting site, so caches must keep one
    // copy per site (Vary: Origin) or a copy fetched from one site breaks another.
    return Response.json(hit.body, { headers: { "Cache-Control": `public, max-age=${spec.cacheMs / 1000}`, "Vary": "Origin" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
});
