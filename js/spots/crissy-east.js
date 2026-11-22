// Everything specific to one spot. Adding a spot means adding a file like this one.
// Numbers marked “uncalibrated” are physics-based starting guesses, to be tuned
// against how the water actually felt.

export default {
  id: "crissy-east",
  name: "Crissy Field East Beach",
  shortName: "Crissy East",
  timeZone: "America/Los_Angeles",
  lat: 37.8068,
  lon: -122.4505,

  // Daily window shown, in local hours. The last row is 5 PM.
  firstHour: 6,
  lastHour: 17,

  // How deep the wader stands, in meters. Chest deep, feet on the sand.
  standingDepthM: 1.3,

  // The way the beach faces, in degrees: from the sand out to open water. Sets which
  // winds push a wader out, in, or along the shore.
  shoreFacingDeg: 0,

  current: {
    // NOAA subordinate station, about 1.5 km west in the channel. It only publishes
    // slack and max times, so hourly speeds are interpolated between them.
    station: "PCT0286",
    stationName: "Fort Point, 0.5 nmi E of",
    // Uncalibrated: the beach sees a fraction of the channel speed (shallower water,
    // more friction, the Crissy eddy).
    nearshoreFactor: 0.5,
    // Which way each phase of the tide moves water past the beach, for the card.
    ebb: "Ebb, pulling west toward the Gate",
    flood: "Flood, pushing east toward the Marina",
  },

  tide: { station: "9414290", stationName: "San Francisco (Presidio)" },
  waterTemp: { station: "9414290", stationName: "San Francisco (Presidio)" },
  // The nearest NWS station that reports the sky, about 17 km south. Fills in the sky
  // for hours the forecast has dropped. It’s often clearer than the beach in fog.
  skyObserved: { station: "KSFO", stationName: "SFO" },

  waves: {
    // Wave height at the beach from the NWS Nearshore Wave Prediction System, read
    // through Plunge’s server function, which also records it for past days.
    source: "nwps",
    // Open-Meteo marine model point just outside the Golden Gate.
    lat: 37.8,
    lon: -122.53,
    // Uncalibrated: share of offshore swell height that reaches the beach. Longer
    // periods bend through the Gate better.
    transfer: { basePeriodS: 8, baseFactor: 0.05, perSecond: 0.02, minFactor: 0.03, maxFactor: 0.3 },
    // Swell directions (degrees, coming from) that line up with the Gate. Full
    // effect inside [fullFrom, fullTo], tapering to zero at [zeroFrom, zeroTo].
    exposure: { zeroFrom: 225, fullFrom: 260, fullTo: 285, zeroTo: 315 },
  },

  thresholds: {
    // Depth × velocity (m²/s) at standing depth. 0.6 is the common limit for adult
    // stability in flowing water (Australian Rainfall and Runoff, 2019).
    currentDV: { caution: 0.4, high: 0.6 },
    // Estimated wave height at the beach, trough to crest, feet. At chest depth (1.3 m),
    // a 2 ft wave’s crest reaches the mouth, so breathing takes timing. Waves break at
    // about 0.78 × depth, roughly 3.3 ft here, and a wave breaking on a wader is what
    // knocks them down; 3 ft rounds that down.
    beachWaveFt: { caution: 2, high: 3 },
    // Sustained wind, mph.
    windMph: { caution: 15, high: 25 },
    // Water temperature, °F. Below this, cold shock is a hazard on its own.
    waterTempF: { caution: 50 },
  },

  // SFPUC shoreline bacteria monitoring. Sampled weekly.
  waterQuality: {
    // The beach’s stations (the worst of them counts) and the name the card gives them.
    stations: ["4612"], stationName: "Crissy Field Beach East",
    // A clean sample stands for a weekly cycle plus a day for the lab.
    cleanForDays: 8,
    // A bacteria posting is a weekly sample’s finding; with no heavy rain since, it’s
    // taken to have cleared this long after the sample. (Overflow postings are
    // resampled daily, so they stand until SFPUC lifts them.)
    postingHours: 72,
    // SFPUC doesn’t say when it sampled, only the day. Mornings, by its schedule.
    sampleHour: 9,
  },

  // Rain washes runoff into the bay, and heavy rain overflows SF’s combined sewers.
  // California guidance (state Ocean Protection Council; LA, San Diego, SLO, Ventura
  // counties): stay out for 72 hours after rain ends. SF gives no number, only “during
  // and immediately after rain events”. The gauge is SFO’s, about 17 km
  // south, the nearest that reports by the hour.
  rain: {
    station: "SFO", stationName: "SFO",
    // Inches in any 24 hours. Enough rain to wash runoff in (caution): 0.2″, where
    // Ventura County says runoff becomes a concern; SF publishes no number. Heavy rain
    // (high): 0.5″, uncalibrated, with no published figure for SF’s sewer overflows.
    cautionIn: 0.2, highIn: 0.5,
    afterHours: 72,
    // Forecast rain this far past the last measurement is too uncertain for High.
    sureForecastHours: 72,
    // Days of rain loaded before the first day shown: 72 hours, plus a 24-hour total.
    lookbackDays: 5,
  },
};
