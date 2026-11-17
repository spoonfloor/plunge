# Plunge

How risky is it to wade chest deep at Crissy Field East Beach today? An hour-by-hour rating from 6 AM to 5 PM, with each factor and the reason behind it, for yesterday through five days ahead. Swipe the page sideways (or tap the dots under the title, or press ← →) to change the day; the hour you picked stays picked. Built because NWS warnings cover whole stretches of coast, not this beach.

Live at https://spoonfloor.github.io/plunge/. Install it from Safari with Share → Add to Home Screen.

## How the rating works

What knocks a chest-deep wader off their feet is moving water, so **current** and **waves** drive the rating. **Wind** and **water temperature** can raise it, and an SFPUC posting makes it High no matter what. **Tide** height is shown on the current card, with the next slack, but not scored. Each factor is rated on the number its card shows (0.58 kn shows as 0.6 and is rated at the 0.6 line). An hour takes its worst factor’s level, and moderate current plus moderate waves together count as high. With no current or wave data, the hour gets no rating instead of a misleading one.

| Factor | Source | How it’s turned into a level |
|---|---|---|
| Current | NOAA predictions, Fort Point 0.5 nmi E (PCT0286) | Interpolated between slack and max, peak within the hour, scaled to the beach, then depth × speed against the 0.6 m²/s adult stability limit |
| Waves | NWS Nearshore Wave Prediction System (SWAN, ~1 km grid around the Bay), through the server function; Open-Meteo offshore forecast, scaled to the beach, when that’s unavailable | Height at the beach. The nearshore run reaches about six days out; the offshore estimate fills hours it doesn’t cover, such as yesterday’s. Caution at 2 ft, where the crest reaches a chest-deep wader’s mouth; high at 3 ft, about where waves break at chest depth |
| Wind | NOAA measured (past hours), NWS forecast (later hours) | Sustained speed. Direction is shown as onshore, offshore or along the shore, from the way the beach faces |
| Water quality | SFPUC beach monitoring, Crissy Field Beach East (4612) | Posted for bacteria or a sewer overflow makes every hour High |
| Water temperature | NOAA, San Francisco (9414290); SF Bar buoy (46237) through the server function while that station is down | Under 50°F is a caution. A latest reading, not a forecast: other days show today’s, and say so |
| Tide | NOAA, San Francisco (9414290) | Shown only, on the current card |

After the time on the Risk line, icons for current, waves and wind (or the water temperature itself) show what’s driving a Caution or High hour. The sky icons above the hours and the sky line under the rating come from the NWS forecast: the hourly forecast’s own words where it has the hour, and its gridpoint data for hours already past. Rain icons show intensity (light, rain, heavy); the chance of rain is the % on the sky line. Tapping the sky line opens the day’s chance of rain as a line under the sky icons, each point under its hour, with dashed lines at 0, 50 and 100%. Hours the forecast has already dropped, mostly yesterday’s, show the sky as reported at SFO (the nearest NWS station that reports it, about 17 km south), marked “at SFO”. They don’t feed the rating either. NWS advisories for the point that bear on being in the water (surf, coastal flooding, wind, marine warnings) appear below the factors, with “None” when there are none. They don’t feed the rating.

The beach scaling for current, and for waves when the nearshore model is unavailable, is a starting guess (`js/spots/crissy-east.js`), not yet tuned against real sessions.

## What’s where

| File | What it’s for |
|---|---|
| `js/spots/crissy-east.js` | Everything specific to the beach: location, stations, scaling, thresholds. A new spot is a new file. |
| `js/sources.js` | Fetches and normalizes each source, for every day shown in one load. Each fails on its own, and falls back to today’s last good copy on this device. |
| `js/model.js` | The risk model. Pure functions, tested in `tests/`. |
| `js/app.js` | Renders the page |
| `js/time.js` | Times in the beach’s time zone, whatever the phone’s zone |

Built from [pwa-template](https://github.com/spoonfloor/pwa-template). `app.config.json`, `dev/configure.mjs` and the files below work as they do there.

## Develop

Dev server with live reload, at http://127.0.0.1:5180/:
```bash
node dev/serve.mjs
```

Model tests:
```bash
node --test tests/*.test.mjs
```

Pushing to `main` publishes to GitHub Pages.

## Good to know

- **Offline.** `sw.js` goes to the network first and falls back to the last saved copy, so online you never see a stale file. Add any new file to its `SHELL` list so it’s available offline from the first visit; `configure` warns about entries that don’t exist.
- **Testing on a real iPhone.** Service workers only run over HTTPS (localhost is the exception), and the dev server only listens on this Mac. To try Home Screen install and offline on a phone, host the folder somewhere with HTTPS, such as GitHub Pages or Netlify.
- **Top bar and status bar.** `#top-bar` is the app’s header: put the title and top controls inside it. iOS paints the status bar in its color, and on iOS 27 that’s also what stops iOS blurring the top of a Home Screen app. Keep it fixed, full width, opaque (any color) and over 10px tall. Don’t add `apple-mobile-web-app-status-bar-style`: on iOS 27 `black-translucent` brings the blur back. `dev/top-edge.html` and `dev/top-edge-default.html` test this on a phone.
- **Reinstall after `<head>` changes.** iOS reads the Home Screen settings when the app is added, so after changing them, delete the app and add it again.
- **Text fields** need a font size of at least 16px, or iOS zooms in when they’re focused. `app.css` sets that.
- **Icons.** Keep a full-bleed `<rect id="bg">` as the first shape in `source.svg`. Only the browser-tab favicon gets rounded corners; iOS rounds Home Screen icons itself.
