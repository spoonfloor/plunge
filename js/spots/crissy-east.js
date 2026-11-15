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

  current: {
    // NOAA subordinate station, about 1.5 km west in the channel. It only publishes
    // slack and max times, so hourly speeds are interpolated between them.
    station: "PCT0286",
    stationName: "Fort Point, 0.5 nmi E of",
    // Uncalibrated: the beach sees a fraction of the channel speed (shallower water,
    // more friction, the Crissy eddy).
    nearshoreFactor: 0.5,
  },

  tide: { station: "9414290", stationName: "San Francisco (Presidio)" },
  waterTemp: { station: "9414290", stationName: "San Francisco (Presidio)" },

  waves: {
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
    // Estimated wave height at the beach, feet. Uncalibrated.
    beachWaveFt: { caution: 1, high: 2 },
    // Sustained wind, mph.
    windMph: { caution: 15, high: 25 },
    // Water temperature, °F. Below this, cold shock is a hazard on its own.
    waterTempF: { caution: 50 },
  },

  links: {
    waterQuality: "https://sfpuc.org/programs/ocean-and-beach-monitoring",
  },
};
