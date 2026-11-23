# Plunge server function

`functions/plunge/index.ts` fetches data browsers can’t read directly and returns it as JSON. It runs as an edge function on the self-hosted Supabase at `supabase.erichenry.com`.

| Route | Returns |
|---|---|
| `GET /functions/v1/plunge/water-temp` | Latest water temperature from NDBC buoy 46237 (San Francisco Bar) |
| `GET /functions/v1/plunge/waves` | Hourly wave height at Crissy Field East Beach from the latest NWS Nearshore Wave Prediction System run (SF Bay Area grid). Each run is an 18 MB GRIB2 file; `grib2.ts` reads the one grid point at the beach. |
| `GET /functions/v1/plunge/water-quality?spot=` | The beach’s SFPUC posting (the worst of its stations): `posted` (with `reason`: `overflow` or `bacteria`), `clean` or `unsampled`, and the sample date |
| `GET /functions/v1/plunge/rain` | Measured rain at SFO by hour for the last 8 days, from the routine hourly METARs: first the Iowa Environmental Mesonet’s archive (which answers 429 to an address that asks again within seconds), then the NWS’s own station observations. Each good answer is saved to `plunge.history`, which answers when both sources fail, if it reaches within 6 hours of now. `source` names which one answered. Cached 30 minutes, and requests that arrive during a load share it. |
| `GET /functions/v1/plunge/water-level` | Water level at the San Francisco tide gauge (NWS FTPC1, NOAA 9414290), feet above MLLW every 30 minutes, from the last two days through about seven days out: NOAA’s STOFS-2D-Global forecast (tide and storm surge, corrected toward the gauge). Stitched from the runs `/collect` saves: each half hour from the newest run that reaches it, a newer run fading in over 3 hours so the line doesn’t step |
| `GET /functions/v1/plunge/posted-since?spot=` | The current posting status and when it began: the first hour of the latest unbroken run of that status in `plunge.history` |
| `GET /functions/v1/plunge/collect` | Records what sources forget into the `plunge.history` table: this hour’s posting at each beach, the latest wave run’s height for each past hour since yesterday, and each STOFS water level run not yet saved (NOMADS keeps about a day of them). Cron calls it hourly. |
| `GET /functions/v1/plunge/history?date=YYYY-MM-DD&spot=` | A past day: the last posting recorded, wave height by hour, and the buoy’s water temperature by hour (read from the buoy’s 45-day file, not recorded) |

`spot` is `crissy-east` (the default) or `baker-beach`; answers that take one name it in a `spot` field. The app ignores an answer without one for any beach but Crissy East, so it works against an older deploy.

## History

`plunge.history` lives in the same Supabase database as other projects, in its own `plunge` schema, one row per spot, kind (`waterQuality`, `waves`, `waterLevelForecast`, `rain`), date and local hour, with the reading as JSON. A `waterLevelForecast` row is one whole STOFS run (`{ run, station, points }`), filed under Crissy East at the run’s start; together they’re the record to score the forecast against what the gauge measured, which NOAA keeps. A `rain` row is one hour’s SFO report (`{ time, in }`), filed under Crissy East. Row-level security is on with no policies, so only the function (as the service role) can read or write it. [`schema.sql`](schema.sql) sets it up; `plunge` has to be in `PGRST_DB_SCHEMAS` in the server’s `~/supabase-project/.env` for the API to serve it.

Cron on the server calls `/collect` at five past every hour and logs to `~/plunge-collect.log`:

```
5 * * * * curl -s --max-time 150 https://supabase.erichenry.com/functions/v1/plunge/collect >> /home/ubuntu/plunge-collect.log 2>&1; echo >> /home/ubuntu/plunge-collect.log
```

## Deploy

The edge runtime picks up changes once the running worker retires, a minute after its last request; no restart needed.

```bash
scp server/functions/plunge/index.ts server/functions/plunge/grib2.ts ubuntu@40.160.150.92:supabase-project/volumes/functions/plunge/
```

```bash
curl https://supabase.erichenry.com/functions/v1/plunge/water-temp
```

```bash
curl https://supabase.erichenry.com/functions/v1/plunge/waves
```
