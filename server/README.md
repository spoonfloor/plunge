# Plunge server function

`functions/plunge/index.ts` fetches data browsers can’t read directly and returns it as JSON. It runs as an edge function on the self-hosted Supabase at `supabase.erichenry.com`.

| Route | Returns |
|---|---|
| `GET /functions/v1/plunge/water-temp` | Latest water temperature from NDBC buoy 46237 (San Francisco Bar) |
| `GET /functions/v1/plunge/waves` | Hourly wave height at Crissy Field East Beach from the latest NWS Nearshore Wave Prediction System run (SF Bay Area grid). Each run is an 18 MB GRIB2 file; `grib2.ts` reads the one grid point at the beach. |

## Deploy

The edge runtime picks up changes on the next request; no restart needed.

```bash
scp server/functions/plunge/index.ts server/functions/plunge/grib2.ts ubuntu@40.160.150.92:supabase-project/volumes/functions/plunge/
```

```bash
curl https://supabase.erichenry.com/functions/v1/plunge/water-temp
```

```bash
curl https://supabase.erichenry.com/functions/v1/plunge/waves
```
