# Plunge server function

`functions/plunge/index.ts` fetches data browsers can’t read directly and returns it as JSON. It runs as an edge function on the self-hosted Supabase at `supabase.erichenry.com`.

| Route | Returns |
|---|---|
| `GET /functions/v1/plunge/water-temp` | Latest water temperature from NDBC buoy 46237 (San Francisco Bar) |

## Deploy

The edge runtime picks up changes on the next request; no restart needed.

```bash
scp server/functions/plunge/index.ts ubuntu@40.160.150.92:supabase-project/volumes/functions/plunge/index.ts
```

```bash
curl https://supabase.erichenry.com/functions/v1/plunge/water-temp
```
