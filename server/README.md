# Plunge server function

`functions/plunge/index.ts` fetches data browsers can’t read directly and returns it as JSON. It runs as an edge function on the self-hosted Supabase at `supabase.erichenry.com`.

| Route | Returns |
|---|---|
| `GET /functions/v1/plunge/water-temp` | Latest water temperature from NDBC buoy 46237 (San Francisco Bar) |
| `GET /functions/v1/plunge/waves` | Hourly wave height at Crissy Field East Beach from the latest NWS Nearshore Wave Prediction System run (SF Bay Area grid). Each run is an 18 MB GRIB2 file; `grib2.ts` reads the one grid point at the beach. |
| `GET /functions/v1/plunge/water-quality` | The beach’s SFPUC posting: `posted`, `clean` or `unsampled`, and the sample date |
| `GET /functions/v1/plunge/collect` | Records what sources forget into the `plunge_history` table: this hour’s posting, and the latest wave run’s height for each past hour since yesterday. Cron calls it hourly. |
| `GET /functions/v1/plunge/history?date=YYYY-MM-DD` | A past day: the last posting recorded, wave height by hour, and the buoy’s water temperature by hour (read from the buoy’s 45-day file, not recorded) |

## History

`plunge_history` lives in the same Supabase database, one row per spot, kind (`waterQuality`, `waves`), date and local hour, with the reading as JSON. Row-level security is on with no policies, so only the function (as the service role) can read or write it.

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
