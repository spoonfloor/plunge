// Plunge’s server side: fetches public data that browsers can’t read directly (the
// source doesn’t send CORS headers) and hands it to the app as JSON.
//
// Runs as a Supabase edge function on the self-hosted Supabase at
// supabase.erichenry.com, at /functions/v1/plunge/<route>. The gateway adds the CORS
// headers. Deploy: see server/README.md.
//
// Only fixed upstream URLs are fetched; nothing in a request picks what gets fetched,
// so this can’t be used as an open proxy.

const CACHE_MS = 10 * 60e3;
let cached: { at: number; body: unknown } | null = null;

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

Deno.serve(async req => {
  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop();
  if (req.method !== "GET" || route !== "water-temp") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  try {
    if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), body: await waterTemp() };
    return Response.json(cached.body, { headers: { "Cache-Control": "public, max-age=600" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
});
