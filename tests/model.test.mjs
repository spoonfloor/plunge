// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { currentAt, peakCurrent, transferFactor, assessCurrent, assessWaves, assessWind, windPush, overall, summarizeDay, hourSpan,
  assessWaterQuality, waterAdvisories, advisorySummary, advisoryParagraphs, currentKnots, thresholds, skyKind, skyLine, skyText } from "../js/model.js";
import { sunIsUp } from "../js/time.js";
import { forDate } from "../js/sources.js";
import spot from "../js/spots/crissy-east.js";
import { zonedToMs, zonedParts } from "../js/time.js";

const H = 3600e3;
const events = [
  { ms: 0, knots: 0 }, { ms: 2 * H, knots: -2 }, { ms: 4 * H, knots: 0 }, { ms: 6 * H, knots: 1 },
];

test("current follows a sine from slack to max and back", () => {
  assert.ok(currentAt(events, 0) === 0); // -0 counts as slack
  assert.equal(currentAt(events, 2 * H), -2);
  assert.ok(Math.abs(currentAt(events, H) - -2 * Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(currentAt(events, 3 * H) - -2 * Math.SQRT1_2) < 1e-9);
  assert.equal(currentAt(events, 7 * H), null);
});

test("hourly peak catches a max inside the hour", () => {
  assert.equal(peakCurrent(events, 1.5 * H), -2);
});

test("current levels use depth × velocity", () => {
  // 1.8 kn in the channel → 0.9 kn at the beach → 1.3 × 0.463 = 0.60 m²/s → high
  const ev = [{ ms: 0, knots: -1.8 }, { ms: 1 * H, knots: -1.8 }, { ms: 2 * H, knots: 0 }];
  assert.equal(assessCurrent(ev, 0, spot).level, "high");
  const weak = [{ ms: 0, knots: 0.5 }, { ms: 2 * H, knots: 0 }];
  assert.equal(assessCurrent(weak, 0, spot).level, "low");
});

test("swell outside the Gate’s window doesn’t reach the beach", () => {
  assert.equal(transferFactor(16, 200, spot.waves), 0);
  assert.ok(transferFactor(16, 275, spot.waves) > transferFactor(10, 275, spot.waves));
  assert.ok(Math.abs(transferFactor(10, 242.5, spot.waves) - transferFactor(10, 275, spot.waves) / 2) < 1e-9);
});

test("wave levels from the nearshore model, or estimated from offshore swell", () => {
  assert.equal(assessWaves({ beachFt: 1.9 }, spot).level, "low");
  assert.equal(assessWaves({ beachFt: 2.1 }, spot).level, "caution");
  assert.equal(assessWaves({ beachFt: 3 }, spot).level, "high");
  assert.equal(assessWaves({ swells: [{ ft: 8, periodS: 11, dirDeg: 280 }] }, spot).level, "low");     // 0.88 ft
  assert.equal(assessWaves({ swells: [{ ft: 12, periodS: 17, dirDeg: 275 }] }, spot).level, "caution"); // 2.76 ft
  assert.equal(assessWaves({ swells: [{ ft: 16, periodS: 18, dirDeg: 275 }] }, spot).level, "high");    // 4.0 ft
  assert.equal(assessWaves({ swells: [] }, spot).level, "unknown");
  assert.equal(assessWaves(undefined, spot).level, "unknown");
});

test("overall: worst factor, two cautions make high, missing criticals make no rating", () => {
  const f = (current, waves, wind = "low") => ({ current: { level: current }, waves: { level: waves },
    wind: { level: wind }, waterTemp: { level: "unknown" } });
  assert.equal(overall(f("low", "low")).level, "low");
  assert.equal(overall(f("low", "low", "caution")).level, "caution");
  assert.equal(overall(f("caution", "caution")).level, "high");
  assert.equal(overall(f("unknown", "low")).level, "unknown");
});

test("local times convert in Los Angeles, across DST", () => {
  const tz = "America/Los_Angeles";
  assert.equal(new Date(zonedToMs("2026-11-15 06:09", tz)).toISOString(), "2026-11-15T14:09:00.000Z");
  assert.equal(new Date(zonedToMs("2026-07-01 06:00", tz)).toISOString(), "2026-07-01T13:00:00.000Z");
  assert.deepEqual(zonedParts(Date.parse("2026-11-15T14:09:00Z"), tz), { date: "2026-11-15", hour: 6, minute: 9 });
});

test("day summary groups hours by rating and reason", () => {
  const h = (hour, level, drivers = []) => ({ hour, overall: { level, drivers } });
  const day = [h(6, "low"), h(7, "low"), h(8, "high", ["wind"]), h(9, "high", ["wind", "waves"]),
    h(10, "caution", ["current"]), h(11, "low")];
  assert.equal(summarizeDay(day),
    "Low 6–8 AM. High 8–9 AM, because of wind. High 9–10 AM, because of wind and waves. Caution 10–11 AM, because of current. Low 11 AM–12 PM.");
  assert.equal(summarizeDay([h(6, "caution", ["waves"]), h(7, "caution", ["waves"])]), "Caution 6–8 AM, because of waves.");
  assert.equal(hourSpan(11, 13), "11 AM–1 PM");
  assert.equal(hourSpan(13, 18), "1–6 PM");
});

test("a posted beach is High every hour, even without current or wave data", () => {
  const posted = assessWaterQuality({ status: "posted", sampled: "2026-11-09" });
  assert.equal(posted.level, "high");
  assert.equal(posted.value, "Hazardous");
  const f = { current: { level: "unknown" }, waves: { level: "low" }, wind: { level: "low" },
    waterTemp: { level: "low" }, waterQuality: posted };
  assert.deepEqual(overall(f), { level: "high", drivers: ["waterQuality"], why: "SFPUC has posted this beach for bacteria or a sewer overflow. Don’t go in." });
  // Other factors at caution or worse still show as reasons.
  assert.deepEqual(overall({ ...f, current: { level: "caution" }, wind: { level: "high" } }).drivers, ["waterQuality", "current", "wind"]);
  assert.equal(assessWaterQuality({ status: "clean", sampled: "2026-11-09" }).value, "OK");
  assert.equal(assessWaterQuality({ status: "clean", sampled: "2026-11-09" }).level, "low");
  assert.deepEqual(assessWaterQuality({ status: "clean", sampled: "2026-11-09" }).notes, ["Sampled Nov 9"]);
  assert.equal(assessWaterQuality({ status: "unsampled", sampled: null }).level, "unknown");
  assert.equal(assessWaterQuality(null).level, "unknown");
  for (const status of ["unforecast", "unrecorded", undefined]) {
    const q = assessWaterQuality({ status });
    assert.equal(q.level, "unknown");
    assert.equal(q.value, "Unavailable");
  }
});

test("a posting counts for today only", () => {
  const day = (status, date) => forDate({ waterQuality: { [date]: { status } } }, date);
  assert.equal(day("posted", "2026-11-17").waterQuality.status, "posted");
  assert.deepEqual(forDate({ waterQuality: { "2026-11-17": { status: "posted" } } }, "2026-11-18").waterQuality, {});
  const f = { current: { level: "low" }, waves: { level: "low" }, wind: { level: "low" }, waterTemp: { level: "low" },
    waterQuality: assessWaterQuality({ status: "unforecast" }) };
  assert.equal(overall(f).level, "low");
});

test("current card: direction, next two slacks and water level", () => {
  const z = t => zonedToMs(t, spot.timeZone);
  const start = z("2026-11-15 13:00");
  const ev = [{ ms: start - 2 * H, knots: -2 }, { ms: start + 40 * 60e3, knots: 0 }, { ms: start + 3 * H, knots: 1.5 }];
  const c = assessCurrent(ev, start, spot, 4.43);
  assert.equal(c.value, "0.4 kn"); // 0.77 kn in the channel at 1 PM, half of it at the beach
  // One slack left in the events: just that one. No tide leaves the water line out.
  assert.deepEqual(c.notes, ["Ebb, pulling west toward the Gate", "Slack at 1:40 PM", "Water level 4.4 ft"]);
  const notes = (slacks, at = start) =>
    assessCurrent([{ ms: at - H, knots: 1 }, ...slacks.map(t => ({ ms: z(t), knots: 0 }))], at, spot).notes[1];
  assert.equal(notes(["2026-11-15 13:40", "2026-11-15 19:52", "2026-11-16 01:14"]), "Slack at 1:40 PM and 7:52 PM");
  assert.equal(notes(["2026-11-15 22:24", "2026-11-16 01:14"]), "Slack at 10:24 PM and tomorrow at 1:14 AM");
  assert.equal(notes(["2026-11-16 01:14", "2026-11-16 05:40"]), "Slack tomorrow at 1:14 AM and 5:40 AM");
  assert.equal(notes(["2026-11-16 00:30"], z("2026-11-15 17:00")), "Slack tomorrow at 12:30 AM");
});

test("wind says which way it pushes a wader on a north-facing beach", () => {
  assert.equal(windPush("S", 0), "Offshore, pushing you out");
  assert.equal(windPush("SSW", 0), "Offshore, pushing you out");
  assert.equal(windPush("N", 0), "Onshore, pushing you in");
  assert.equal(windPush("W", 0), "Along the shore, pushing you east");
  assert.equal(windPush("E", 0), "Along the shore, pushing you west");
  assert.equal(windPush("", 0), null);
  assert.deepEqual(assessWind({ mph: 12, dir: "W" }, spot), { level: "low", amount: 12, value: "12 mph", notes: ["Along the shore, pushing you east"] });
});

test("advisories keep only water-relevant NWS events", () => {
  const list = waterAdvisories([{ event: "Coastal Flood Advisory" }, { event: "Heat Advisory" },
    { event: "High Surf Advisory" }, { event: "Wind Advisory" }, { event: "Winter Storm Warning" }, { event: "High Surf Warning" }]);
  assert.deepEqual(list.map(a => a.event), ["Coastal Flood Advisory", "High Surf Advisory", "Wind Advisory", "High Surf Warning"]);
  assert.equal(advisorySummary(list), "Flooding, high surf, high winds");
  assert.deepEqual(waterAdvisories(null), []);
  assert.deepEqual(advisoryParagraphs("* WHAT...Breaking waves of 18 to\n24 ft.\n\n* WHERE...Coast of\nSan Francisco."),
    ["What: Breaking waves of 18 to 24 ft.", "Where: Coast of San Francisco."]);
});

test("current thresholds in knots, and ratings use the number the card shows", () => {
  assert.deepEqual(currentKnots(spot), { caution: 0.6, high: 0.9 });
  assert.deepEqual(thresholds(spot).waves, { caution: 2, high: 3 });
  // 1.16 kn in the channel → 0.58 kn at the beach, shown as 0.6 → caution, not low.
  const ev = [{ ms: 0, knots: 1.16 }, { ms: H, knots: 1.16 }, { ms: 2 * H, knots: 0 }];
  const c = assessCurrent(ev, 0, spot);
  assert.equal(c.value, "0.6 kn");
  assert.equal(c.level, "caution");
  assert.equal(c.amount, 0.6);
  // 1.96 ft shows as 2.0 ft, so it’s rated at the 2 ft line.
  assert.equal(assessWaves({ beachFt: 1.96 }, spot).level, "caution");
});

test("sky icon and line from the NWS short forecast", () => {
  assert.equal(skyKind({ text: "Sunny", day: true }), "sun");
  assert.equal(skyKind({ text: "Clear", day: false }), "moon");
  assert.equal(skyKind({ text: "Partly Cloudy", day: true }), "partly-day");
  assert.equal(skyKind({ text: "Mostly Clear", day: false }), "partly-night");
  assert.equal(skyKind({ text: "Mostly Cloudy", day: true }), "cloud");
  assert.equal(skyKind({ text: "Chance Light Rain", day: true }), "rain-light");
  assert.equal(skyKind({ text: "Patchy Drizzle", day: true }), "rain-light");
  assert.equal(skyKind({ text: "Rain Showers Likely", day: true }), "rain");
  assert.equal(skyKind({ text: "Heavy Rain", day: true }), "rain-heavy");
  assert.equal(skyKind({ text: "Chance Showers And Thunderstorms", day: true }), "storm");
  assert.equal(skyKind({ text: "Patchy Fog", day: true }), "fog");
  assert.equal(skyLine({ text: "Partly Sunny", rainPct: 20 }), "Partly sunny · 20% rain");
  assert.equal(skyLine({ text: "Chance Light Rain", rainPct: 28 }), "Light rain · 28% chance");
  assert.equal(skyLine({ text: "Slight Chance Light Rain", rainPct: 16 }), "Light rain · 16% chance");
  assert.equal(skyLine({ text: "Rain Likely", rainPct: 70 }), "Rain · 70% chance");
  assert.equal(skyLine({ text: "Chance Showers And Thunderstorms", rainPct: 40 }), "Showers and thunderstorms · 40% chance");
  assert.equal(skyLine({ text: "Patchy Fog", rainPct: 5 }), "Patchy fog · 5% rain");
});

test("sky as reported at a station: its own words, and where", () => {
  assert.equal(skyKind({ text: "A Few Clouds", day: true }), "partly-day");
  assert.equal(skyKind({ text: "Rain and Fog/Mist", day: true }), "rain");
  assert.equal(skyKind({ text: "Fog/Mist", day: true }), "fog");
  assert.equal(skyLine({ text: "Light Rain", day: true, observed: "SFO" }), "Light rain · at SFO");
});

test("one day out of a multi-day load", () => {
  const data = { currents: [1], waves: { "2026-11-16": { 6: { beachFt: 1 } } }, wind: null, waterTemp: { f: 55 } };
  const day = forDate(data, "2026-11-17");
  assert.deepEqual(day.waves, {}); // loaded, nothing that day
  assert.equal(day.wind, null); // didn’t load
  assert.deepEqual(day.currents, [1]);
  assert.deepEqual(forDate(data, "2026-11-16").waves[6], { beachFt: 1 });
});

test("sky words from NWS gridpoint weather and cover", () => {
  assert.equal(skyText({ cover: 90, wx: { coverage: "slight_chance", weather: "rain", intensity: "light" }, day: true }), "Slight chance light rain");
  assert.equal(skyText({ cover: 90, wx: { coverage: "likely", weather: "rain", intensity: "light" }, day: true }), "Light rain likely");
  assert.equal(skyText({ cover: 90, wx: { coverage: "definite", weather: "rain", intensity: "moderate" }, day: true }), "Rain");
  assert.equal(skyText({ cover: 90, wx: { coverage: "chance", weather: "rain_showers", intensity: null }, day: true }), "Chance showers");
  assert.equal(skyText({ cover: 50, wx: { coverage: "patchy", weather: "fog", intensity: null }, day: true }), "Patchy fog");
  assert.equal(skyText({ cover: 5, wx: null, day: true }), "Sunny");
  assert.equal(skyText({ cover: 30, wx: null, day: false }), "Mostly clear");
  assert.equal(skyText({ cover: 50, wx: null, day: true }), "Partly sunny");
  assert.equal(skyText({ cover: 95, wx: null, day: true }), "Cloudy");
});

test("sun up or down over San Francisco on Nov 16, 2026 (sunrise ≈ 6:54 AM, sunset ≈ 4:57 PM PST)", () => {
  const at = (h, m) => Date.UTC(2026, 10, 16, h + 8, m);
  assert.equal(sunIsUp(at(6, 40), 37.8, -122.45), false);
  assert.equal(sunIsUp(at(7, 10), 37.8, -122.45), true);
  assert.equal(sunIsUp(at(16, 40), 37.8, -122.45), true);
  assert.equal(sunIsUp(at(17, 10), 37.8, -122.45), false);
});
