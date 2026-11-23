# Plunge

How risky is it to wade chest deep at Crissy Field East Beach, or at Baker Beach, today? An hour-by-hour rating from 6 AM to 5 PM, with each factor and the reason behind it, for yesterday through five days ahead. Swipe the page sideways (or tap the dots under the title, or press ← →) to change the day; the hour you picked stays picked. Tap the beach’s name to switch beaches: the menu shows each one’s rating now, the app remembers the pick, and the day and hour stay as they were. Built because NWS warnings cover whole stretches of coast, not this beach.

Live at https://spoonfloor.github.io/plunge/. Install it from Safari with Share → Add to Home Screen.

## How the rating works

What knocks a chest-deep wader off their feet is moving water, so **current** and **waves** drive the rating. **Wind**, **water temperature** and **water quality** can raise it, and an SFPUC posting makes it High no matter what. **Tide** has its own card, with the day’s highs and lows on its graph, but isn’t scored. Each factor is rated on the number its card shows (0.58 kn shows as 0.6 and is rated at the 0.6 line). An hour takes its worst factor’s level, and moderate current plus moderate waves together count as high. With no current or wave data, the hour gets no rating instead of a misleading one, unless another factor is already High: missing data can hide a hazard but not cancel one. The Risk line shows an icon for every factor at Caution or worse, each in its own level’s color, worst first (moderate current and waves that together make High show as High).

| Factor | Source | How it’s turned into a level |
|---|---|---|
| Current | NOAA predictions: Fort Point 0.5 nmi E (PCT0286) for Crissy; Baker Beach (South Bay) 0.3 nmi NW (PCT0256) for Baker, where the tide runs along the shore | Interpolated between slack and max, peak within the hour, scaled to the beach, then depth × speed against the 0.6 m²/s adult stability limit |
| Waves | Baker: CDIP’s nearshore model (MOP SF061, 10 m deep off mid-beach), its hourly nowcast for past hours and ECMWF-driven forecast after, rated on the breaking height (Komar–Gaudet, from height and period). Crissy: NWS Nearshore Wave Prediction System (SWAN, ~1 km grid around the Bay), through the server function; Open-Meteo offshore forecast, scaled to the beach, when that’s unavailable | Height at the beach. The nearshore run reaches about six days out; for yesterday, the server’s hourly record of the run current at the time; the offshore estimate fills hours neither covers. Caution at 2 ft, where the crest reaches a chest-deep wader’s mouth; high at 3 ft, about where waves break at chest depth |
| Wind | NOAA measured (past hours), NWS forecast (later hours) | Sustained speed. Direction is shown as onshore, offshore or along the shore, from the way the beach faces |
| Water quality | SFPUC beach monitoring, Crissy Field Beach East (4612), or the worst of Baker Beach West, at Lobos Creek and East (4608, 4610, 4609); rain measured at SFO (Iowa Environmental Mesonet, through the server function), then the NWS rainfall forecast | Rated by the hour on what has happened, never on a forecast: a reading, or rain the gauge has measured. First match wins. 1. Posted, from a sample in the last 72 hours: Hazardous (High). Only a sample rates High; an older posting no longer counts. 2. Measured rain of 0.2″ in a day (Ventura County’s runoff threshold; SF publishes none) in the last 72 hours (the standard California wait), ending after the last sample: Caution, “Recent rain”, however heavy, with or without a recent sample. A clean sample taken after the rain clears it. 3. A clean sample under 8 days old: OK (Low). 4. Anything else: Unavailable. Forecast rain only gets a mention: “Rain expected Tuesday evening”, or on an advisory, “may be extended by rain expected Monday night”. An advisory names the rain and when it ends (“Last rain yesterday at 2 AM. Advisory ends Tuesday night”), then what SFPUC last said. Days ahead are rated on what’s known now, with the clocks run forward, and carry today’s posting; yesterday uses the posting the server recorded. When rain data doesn’t load, the card says rain wasn’t considered, to use caution if it’s rained in the last 3 days, and offers Retry |
| Water temperature | NOAA, San Francisco (9414290); SF Bar buoy (46237) through the server function while that station is down | Under 50°F is a caution. Yesterday is rated on each hour’s own reading (Presidio, then the buoy). There’s no forecast, so today and the days ahead use the latest reading, and days ahead say so |
| Tide | NOAA STOFS water level forecast at the San Francisco gauge (9414290, NWS’s FTPC1), tide and storm surge together, through the server function; NOAA tide predictions for the times of highs and lows, and for the whole level where the forecast doesn’t load or reach | Shown only, on its own card. Each high and low keeps the tide’s time and shows the forecast level then, the way NWS states highs in coastal flood forecasts. The card says whether the number includes surge, and names a coastal flood warning or advisory in force |

After the time on the Risk line, icons for current, waves, wind and water quality (or the water temperature itself) show what’s driving a Caution or High hour. The sky icons above the hours and the sky line under the rating come from the NWS forecast: the hourly forecast’s own words where it has the hour, and its gridpoint data for hours already past. Rain icons show intensity (light, rain, heavy); the chance of rain is the % on the sky line. Above each icon is the hour’s air temperature, from the same forecast. Tapping the sky line opens the day’s chance of rain as a line under the sky icons, each point under its hour, with dashed lines at 0, 50 and 100%. Hours the forecast has already dropped, mostly yesterday’s, show the sky as reported at SFO (the nearest NWS station that reports it, about 17 km south), marked “at SFO”, with SFO’s temperature. They don’t feed the rating either. NWS advisories for the point that bear on being in the water (surf, coastal flooding, wind, marine warnings) appear below the factors, with “None” when there are none. They don’t feed the rating.

The beach scaling for current, and for Crissy’s waves when the nearshore model is unavailable, is a starting guess (`js/spots/`), not yet tuned against real sessions. At Baker, rip currents grow with the surf; nothing forecasts them for this beach, so the wave rating stands in for them, and NWS beach hazards statements show under advisories.

## What’s where

| File | What it’s for |
|---|---|
| `js/spots/` | Everything specific to each beach: location, stations, scaling, thresholds. A new spot is a new file, listed in `index.js` (and, for its water quality history, in the server’s `SPOTS`). |
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
