// Baker Beach, on the ocean side of the Presidio just outside the Golden Gate. Unlike
// Crissy East, it takes swell head on: what knocks a wader down here is surf, and the
// rip currents that come with it. Numbers marked “uncalibrated” are starting guesses,
// to be tuned against how the water actually felt.

import crissy from "./crissy-east.js";

export default {
  id: "baker-beach",
  name: "Baker Beach",
  shortName: "Baker Beach",
  timeZone: "America/Los_Angeles",
  // Mid-beach, at Lobos Creek.
  lat: 37.7925,
  lon: -122.4845,

  firstHour: 6,
  lastHour: 17,

  standingDepthM: 1.3,

  // West-northwest, from CDIP’s shore normal for the middle of the beach (281–290°).
  shoreFacingDeg: 285,

  current: {
    // NOAA subordinate station 0.6 km off the beach’s south end, 9.5 m down. Here the
    // tide runs along the shore, not out to sea: flood toward 38°, ebb toward 208°.
    station: "PCT0256",
    stationName: "Baker Beach (South Bay), 0.3 nmi NW of",
    // Uncalibrated, as at Crissy: shallower water near the sand slows the current.
    nearshoreFactor: 0.5,
    ebb: "Ebb, pulling south toward China Beach",
    flood: "Flood, pulling north toward the bridge",
  },

  tide: crissy.tide,
  waterTemp: crissy.waterTemp,
  skyObserved: crissy.skyObserved,

  waves: {
    // CDIP’s Monitoring and Prediction model (MOP): swell carried from deep water over
    // the real seafloor to points 10 m deep, about every 200 m along the California coast.
    // SF061 sits off the middle of the beach. Its nowcast covers past hours; its forecast,
    // from ECMWF’s ocean forecast, reaches about a week ahead. The breaking height is
    // worked out from its height and period (see breakerFt in model.js).
    source: "cdip",
    site: "SF061",
    siteName: "MOP SF061, 10 m deep off mid-beach",
  },

  thresholds: {
    // As at Crissy: 0.6 m²/s is the adult stability limit in flowing water.
    currentDV: { caution: 0.4, high: 0.6 },
    // Breaking height, trough to crest, feet. Same physics as Crissy’s line: a 2 ft wave’s
    // crest reaches a chest-deep wader’s mouth, and a wave over about 3.3 ft (0.78 × 1.3 m)
    // breaks before or on them. Bigger surf also feeds stronger rip currents.
    beachWaveFt: { caution: 2, high: 3 },
    windMph: crissy.thresholds.windMph,
    waterTempF: crissy.thresholds.waterTempF,
  },

  waterQuality: {
    ...crissy.waterQuality,
    // Three stations along the beach; the worst of them counts.
    stations: ["4608", "4610", "4609"], stationName: "Baker Beach West, at Lobos Creek and East",
  },

  rain: crissy.rain,
};
