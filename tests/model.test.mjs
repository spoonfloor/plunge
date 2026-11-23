// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { currentAt, peakCurrent, transferFactor, assessCurrent, assessWaves, assessWind, windPush, overall, summarizeDay, hourSpan,
  assessWaterQuality, waterAdvisories, advisorySummary, advisoryParagraphs, currentKnots, thresholds, showsRain, skyKind, skyLine, skyText,
  tideAt, levelAt, highsAndLows, assessTide, feet, partOfDay, assessWaterTemp, breakerFt } from "../js/model.js";
import { sunIsUp } from "../js/time.js";
import { forDate, spreadRain, worstPosting } from "../js/sources.js";
import spot from "../js/spots/crissy-east.js";
import baker from "../js/spots/baker-beach.js";
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

test("overall: a known high beats missing data, and every hazard is active at its level", () => {
  const f = (current, waves, wind, waterQuality = "low") => ({ current: { level: current }, waves: { level: waves },
    wind: { level: wind }, waterTemp: { level: "unknown" }, waterQuality: { level: waterQuality } });
  const noWaves = overall(f("low", "unknown", "high"));
  assert.equal(noWaves.level, "high");
  assert.deepEqual(noWaves.drivers, ["wind"]);
  assert.equal(noWaves.why, "Because of the wind. No waves data.");
  assert.equal(overall(f("low", "unknown", "caution")).level, "unknown");
  assert.deepEqual(overall(f("low", "unknown", "caution")).active, []);
  // A caution stays in view when something worse joins it; only the worst set the level.
  const r = overall(f("high", "low", "low", "caution"));
  assert.deepEqual(r.drivers, ["current"]);
  assert.deepEqual(r.active, [{ key: "current", level: "high" }, { key: "waterQuality", level: "caution" }]);
  // Two moderates that together make high show as high; worst first, then card order.
  assert.deepEqual(overall(f("caution", "caution", "caution")).active,
    [{ key: "current", level: "high" }, { key: "waves", level: "high" }, { key: "wind", level: "caution" }]);
  assert.deepEqual(overall(f("low", "caution", "high", "caution")).active,
    [{ key: "wind", level: "high" }, { key: "waves", level: "caution" }, { key: "waterQuality", level: "caution" }]);
  assert.deepEqual(overall(f("low", "low", "low")).active, []);
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

// Water quality. Rain by hour from local midnight Nov 10, measured until 11 AM Nov 20
// (Fri) and forecast after. Nov 9 is a Monday.
const zq = t => zonedToMs(t, spot.timeZone);
function rainSeries(at = {}, until = "2026-11-20 11:00") {
  const startMs = zq("2026-11-10 00:00");
  const inches = Array(24 * 20).fill(0);
  for (const [t, v] of Object.entries(at)) inches[(zq(t) - startMs) / H] = v;
  return { startMs, inches, observedUntilMs: zq(until), gauge: "SFO" };
}
const wq = (q, rain, t) => assessWaterQuality(q, rain, zq(t), spot);
const dry = rainSeries();
const clean = { status: "clean", sampled: "2026-11-09" };
const bacteria = { status: "posted", reason: "bacteria", sampled: "2026-11-09" };
const overflow = { status: "posted", reason: "overflow", sampled: "2026-11-18" };

test("water quality: a clean sample stands for 8 days, through drizzle", () => {
  assert.deepEqual(wq(clean, dry, "2026-11-12 10:00"), { level: "low", value: "OK", notes: ["Last sample, Nov 9, was clean."] });
  assert.equal(wq(clean, dry, "2026-11-17 08:00").level, "low");
  assert.deepEqual(wq(clean, dry, "2026-11-17 09:00"), { level: "unknown", value: "Unavailable", notes: ["No sample since Nov 9."] });
  assert.equal(wq(clean, rainSeries({ "2026-11-11 13:00": 0.05 }), "2026-11-11 15:00").level, "low");
});

test("water quality: measured rain is an advisory until 72 hours after it stops", () => {
  const shower = rainSeries({ "2026-11-11 13:00": 0.2, "2026-11-11 14:00": 0.2 });
  assert.deepEqual(wq(clean, shower, "2026-11-11 12:00").notes, ["Last sample, Nov 9, was clean."]);
  assert.deepEqual(wq(clean, shower, "2026-11-11 13:00"), { level: "caution", value: "Recent rain",
    notes: ["Last rain today at 2 PM. Advisory ends Saturday afternoon.", "Last sample, Nov 9, was clean."] });
  assert.equal(wq(clean, shower, "2026-11-14 14:00").level, "caution");
  assert.equal(wq(clean, shower, "2026-11-14 15:00").level, "low");
  // Until the end of the hour before it lifts: a midnight end is the night before.
  assert.deepEqual(wq(clean, rainSeries({ "2026-11-17 23:00": 0.2 }), "2026-11-18 10:00").notes,
    ["Last rain yesterday at 11 PM. Advisory ends Friday night."]);
});

test("water quality: rain is an advisory however heavy, with or without a recent sample", () => {
  const storm = rainSeries({ "2026-11-11 13:00": 0.3, "2026-11-11 14:00": 0.3 });
  const r = wq(clean, storm, "2026-11-12 10:00");
  assert.deepEqual(r, { level: "caution", value: "Recent rain",
    notes: ["Last rain yesterday at 2 PM. Advisory ends Saturday afternoon.", "Last sample, Nov 9, was clean."] });
  assert.equal(overall({ current: { level: "low" }, waves: { level: "low" }, wind: { level: "low" }, waterTemp: { level: "low" },
    waterQuality: r }).level, "caution");
  assert.deepEqual(wq(null, storm, "2026-11-12 10:00").notes, ["Last rain yesterday at 2 PM. Advisory ends Saturday afternoon."]);
  assert.deepEqual(wq({ status: "unsampled", sampled: null }, storm, "2026-11-12 10:00").notes,
    ["Last rain yesterday at 2 PM. Advisory ends Saturday afternoon.", "SFPUC isn’t sampling here right now."]);
  // A sample too old to stand doesn’t stop rain from counting.
  assert.deepEqual(wq(clean, rainSeries({ "2026-11-19 09:00": 0.3 }), "2026-11-20 10:00").notes,
    ["Last rain yesterday at 9 AM. Advisory ends Sunday morning."]);
});

test("water quality: forecast rain never rates the water, only gets a mention", () => {
  const recent = { status: "clean", sampled: "2026-11-20" };
  const storm = rainSeries({ "2026-11-22 10:00": 0.6 });
  assert.deepEqual(wq(recent, storm, "2026-11-22 06:00"),
    { level: "low", value: "OK", notes: ["Rain expected Sunday morning.", "Last sample, Nov 20, was clean."] });
  assert.deepEqual(wq(recent, storm, "2026-11-22 12:00"), { level: "low", value: "OK", notes: ["Last sample, Nov 20, was clean."] });
  // Nor is a day ahead its own “today”: drizzle doesn’t count, and days are said from now.
  const drizzle = Object.fromEntries([7, 8, 9, 10, 11, 12].map(h => [`2026-11-21 ${String(h).padStart(2, "0")}:00`, 0.01]));
  const rain = rainSeries({ ...drizzle, "2026-11-21 13:00": 0.2 });
  assert.deepEqual(wq(recent, rain, "2026-11-21 06:00").notes, ["Rain expected tomorrow afternoon.", "Last sample, Nov 20, was clean."]);
  assert.equal(wq(recent, rain, "2026-11-21 13:00").level, "low");
});

test("water quality: the newest evidence wins", () => {
  const storm = rainSeries({ "2026-11-18 09:00": 1, "2026-11-19 09:00": 0.6, "2026-11-20 07:00": 0.3 });
  const after = { status: "clean", sampled: "2026-11-20" }; // taken at 8 AM, after the last hour of rain
  assert.deepEqual(wq(after, storm, "2026-11-20 12:00"), { level: "low", value: "OK", notes: ["Last sample, Nov 20, was clean."] });
  // Rain still falling in the hour from 8 AM is after it, so the sample doesn’t clear it.
  assert.equal(wq(after, rainSeries({ "2026-11-20 06:00": 0.17, "2026-11-20 08:00": 0.06 }), "2026-11-20 12:00").value, "Recent rain");
  // A sample from before the storm doesn’t clear it.
  assert.equal(wq({ status: "clean", sampled: "2026-11-17" }, storm, "2026-11-20 12:00").value, "Recent rain");
  // Rain measured after the sample counts again.
  assert.equal(wq(after, rainSeries({ "2026-11-20 10:00": 0.3 }), "2026-11-21 16:00").value, "Recent rain");
  // Under 0.2″ in a day isn’t enough to wash runoff in.
  assert.equal(wq(after, rainSeries({ "2026-11-20 10:00": 0.15 }), "2026-11-21 16:00").value, "OK");
});

test("water quality: forecast rain is spread in the gauge’s hundredths", () => {
  assert.deepEqual(spreadRain(0.04, 6), [0.01, 0, 0.01, 0.01, 0, 0.01]);
  assert.deepEqual(spreadRain(0.3, 6), [0.05, 0.05, 0.05, 0.05, 0.05, 0.05]);
  assert.deepEqual(spreadRain(0.004, 6), [0, 0, 0, 0, 0, 0]); // a trace
  assert.equal(Math.round(spreadRain(0.49, 6).reduce((a, b) => a + b) * 100), 49);
});

test("water quality: an advisory says what started it, when it ends, and what could extend it", () => {
  const before = { status: "clean", sampled: "2026-11-17" };
  // Measured rain is named by its last hour, and the end counts from it alone.
  const storm = rainSeries({ "2026-11-18 09:00": 1, "2026-11-19 09:00": 0.6, "2026-11-20 08:00": 0.3 });
  assert.equal(wq(before, storm, "2026-11-20 10:00").notes[0], "Last rain today at 8 AM. Advisory ends Monday morning.");
  // Forecast rain before the end may extend it; it doesn’t move the end.
  const more = rainSeries({ "2026-11-18 09:00": 0.3, "2026-11-20 18:00": 0.3 });
  assert.equal(wq(before, more, "2026-11-20 10:00").notes[0],
    "Last rain Wednesday at 9 AM. Advisory ends tomorrow morning, but may be extended by rain expected this evening.");
  // Rain that goes on into the forecast: the spell measured so far, then what may extend it.
  const going = rainSeries(Object.fromEntries([8, 9, 10, 11, 12].map(h => [`2026-11-20 ${String(h).padStart(2, "0")}:00`, 0.1])));
  assert.equal(wq(before, going, "2026-11-20 10:00").notes[0],
    "Last rain today at 10 AM. Advisory ends Monday morning, but may be extended by rain expected this morning.");
  // A day ahead isn’t its own “today”: days are said from now.
  assert.equal(wq(before, storm, "2026-11-21 10:00").notes[0], "Last rain today at 8 AM. Advisory ends Monday morning.");
});

test("water quality: a posting is a warning for 72 hours after its sample, then no longer counts", () => {
  const r = wq(bacteria, dry, "2026-11-12 07:00");
  assert.deepEqual(r, { level: "high", value: "Hazardous", why: "Posted for high bacteria.",
    notes: ["Warning until this morning.", "Posted Nov 9 for high bacteria."] });
  assert.equal(overall({ current: { level: "unknown" }, waves: { level: "low" }, wind: { level: "low" }, waterTemp: { level: "low" },
    waterQuality: r }).why, "Posted for high bacteria.");
  // An old posting isn’t a clean sample: unrated, unless there’s been rain.
  assert.deepEqual(wq(bacteria, dry, "2026-11-12 08:00"), { level: "unknown", value: "Unavailable", notes: ["Posted Nov 9, not resampled."] });
  assert.deepEqual(wq(bacteria, rainSeries({ "2026-11-10 09:00": 1 }), "2026-11-12 10:00"), { level: "caution", value: "Recent rain",
    notes: ["Last rain Tuesday at 9 AM. Advisory ends tomorrow morning.", "Posted Nov 9, not resampled."] });
  // An overflow posting too, named from when it began; rain, even heavy, doesn’t keep it High.
  const since = { ...overflow, sinceMs: zq("2026-11-18 06:00") };
  assert.deepEqual(wq(since, dry, "2026-11-20 12:00").notes, ["Warning until tomorrow morning.", "Posted Nov 18 for a sewer overflow."]);
  assert.deepEqual(wq(since, rainSeries({ "2026-11-20 18:00": 1 }), "2026-11-21 09:00"),
    { level: "unknown", value: "Unavailable", notes: ["Posted Nov 18, not resampled."] });
});

test("water quality: a posting with no sample date stands until SFPUC resamples", () => {
  assert.deepEqual(wq({ status: "posted", reason: "overflow", sampled: null }, dry, "2026-11-30 10:00").notes,
    ["Warning until SFPUC resamples.", "Posted for a sewer overflow."]);
  // No rain data: the card says so.
  assert.deepEqual(wq(bacteria, null, "2026-11-10 10:00").notes,
    ["Warning until Thursday morning.", "Posted Nov 9 for high bacteria.", "Rain data didn’t load, so recent rain wasn’t considered."]);
  assert.deepEqual(wq(clean, null, "2026-11-12 10:00").notes, ["Last sample, Nov 9, was clean.", "Rain data didn’t load, so recent rain wasn’t considered. If it’s rained in the last 3 days, use caution."]);
});

test("water quality: times are parts of the day, said from the hour shown", () => {
  const from = zq("2026-11-20 10:00"); // a Friday
  const say = t => partOfDay(zq(t), from, spot.timeZone);
  assert.equal(say("2026-11-20 11:00"), "this morning");
  assert.equal(say("2026-11-20 14:00"), "this afternoon");
  assert.equal(say("2026-11-20 19:00"), "this evening");
  assert.equal(say("2026-11-20 22:00"), "tonight");
  assert.equal(say("2026-11-21 02:00"), "tonight");
  assert.equal(say("2026-11-21 08:00"), "tomorrow morning");
  assert.equal(say("2026-11-22 03:00"), "tomorrow night");
  assert.equal(say("2026-11-22 18:00"), "Sunday evening");
  assert.equal(say("2026-11-28 09:00"), "Nov 28");
});

test("water quality: missing postings are unrated unless rain says otherwise", () => {
  assert.deepEqual(wq(null, dry, "2026-11-12 10:00").notes, ["SFPUC didn’t load."]);
  for (const q of [{ status: "unrecorded" }, {}]) assert.deepEqual(wq(q, dry, "2026-11-12 10:00").notes, ["No record of this day’s posting."]);
  assert.deepEqual(wq({ status: "unsampled", sampled: null }, dry, "2026-11-12 10:00").notes, ["SFPUC isn’t sampling here right now."]);
  // Other factors at caution or worse still show as reasons behind a posting.
  const f = { current: { level: "caution" }, waves: { level: "low" }, wind: { level: "high" }, waterTemp: { level: "low" },
    waterQuality: wq(overflow, dry, "2026-11-19 10:00") };
  assert.deepEqual(overall(f).drivers, ["waterQuality", "current", "wind"]);
});

test("one day’s posting, out of a multi-day load", () => {
  assert.equal(forDate({ waterQuality: { "2026-11-17": { status: "posted" } } }, "2026-11-17").waterQuality.status, "posted");
  assert.deepEqual(forDate({ waterQuality: { "2026-11-17": { status: "posted" } } }, "2026-11-18").waterQuality, {});
});

test("current card: direction and next two slacks", () => {
  const z = t => zonedToMs(t, spot.timeZone);
  const start = z("2026-11-15 13:00");
  const ev = [{ ms: start - 2 * H, knots: -2 }, { ms: start + 40 * 60e3, knots: 0 }, { ms: start + 3 * H, knots: 1.5 }];
  const c = assessCurrent(ev, start, spot);
  assert.equal(c.value, "0.4 kn"); // 0.77 kn in the channel at 1 PM, half of it at the beach
  // One slack left in the events: just that one.
  assert.deepEqual(c.notes, ["Ebb, pulling west toward the Gate", "Slack at 1:40 PM"]);
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
  assert.equal(skyLine({ text: "Chance Showers And Thunderstorms", rainPct: 40 }), "Thunderstorms · 40% chance");
  assert.equal(skyLine({ text: "Patchy Fog", rainPct: 25 }), "Patchy fog · 25% rain");
});

test("a dry sky drops a chance of rain under 20%; a wet one keeps it", () => {
  assert.equal(skyLine({ text: "Patchy Fog", rainPct: 5 }), "Patchy fog");
  assert.equal(skyLine({ text: "Mostly Sunny", rainPct: 0 }), "Mostly sunny");
  assert.equal(skyLine({ text: "Mostly Sunny", rainPct: 19.4 }), "Mostly sunny");
  assert.equal(skyLine({ text: "Mostly Sunny", rainPct: 19.6 }), "Mostly sunny · 20% rain");
  assert.equal(skyLine({ text: "Slight Chance Light Rain", rainPct: 8 }), "Light rain · 8% chance");
  assert.equal(showsRain(19.4), false);
  assert.equal(showsRain(19.6), true);
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

test("tide: half a cosine between highs and lows, unrated, with the next turn", () => {
  const z = t => zonedToMs(t, spot.timeZone);
  const turns = [{ ms: z("2026-11-18 06:45"), ft: 4.94, type: "high" }, { ms: z("2026-11-18 12:45"), ft: -0.6, type: "low" },
    { ms: z("2026-11-18 18:03"), ft: 4.1, type: "high" }];
  assert.equal(tideAt(turns, z("2026-11-18 06:45")), 4.94);
  assert.ok(Math.abs(tideAt(turns, z("2026-11-18 09:45")) - (4.94 - 0.6) / 2) < 1e-9); // halfway
  assert.equal(tideAt(turns, z("2026-11-18 05:00")), null);
  const tide = { turns, levels: null };
  const t = assessTide(tide, z("2026-11-18 09:00"), spot);
  assert.equal(t.level, "unrated");
  assert.equal(t.trend, "Falling");
  assert.match(t.value, /^\d\.\d ft ↓$/);
  assert.deepEqual(t.notes, ["Low −0.6 ft at 12:45 PM", "Tide only, without storm surge"]);
  assert.equal(assessTide(tide, z("2026-11-18 14:00"), spot).trend, "Rising");
  assert.equal(assessTide(tide, z("2026-11-18 19:00"), spot).level, "unknown");
  assert.equal(feet(-0.04), "0.0");
  // Tide never moves the rating.
  const f = { current: { level: "low" }, waves: { level: "low" }, wind: { level: "low" }, waterTemp: { level: "low" },
    tide: t, waterQuality: { level: "low" } };
  assert.equal(overall(f).level, "low");
});

test("water level: the STOFS forecast where it reaches, the tide alone elsewhere", () => {
  const z = t => zonedToMs(t, spot.timeZone);
  const turns = [{ ms: z("2026-11-22 22:34"), ft: 4.8, type: "high" }, { ms: z("2026-11-23 03:07"), ft: 2.5, type: "low" },
    { ms: z("2026-11-23 09:25"), ft: 6.7, type: "high" },
    { ms: z("2026-11-23 16:18"), ft: -1.1, type: "low" }];
  // Half-hourly forecast from 2 AM to 4:30 PM: a high near 9, about a foot over the tide.
  const levels = [3.6, 3.4, 3.4, 3.5, 3.7, 4.1, 4.6, 5.1, 5.6, 6.2, 6.8, 7.2, 7.5, 7.7, 7.8, 7.7, 7.4, 7.0, 6.5, 5.9, 5.2,
    4.4, 3.6, 2.8, 2.0, 1.3, 0.7, 0.2, -0.2, -0.5].map((ft, k) => ({ ms: z("2026-11-23 02:00") + k * 1800e3, ft }));
  const tide = { turns, levels };
  // Through each forecast value exactly, smooth between.
  assert.ok(Math.abs(levelAt(tide, z("2026-11-23 09:00")) - 7.8) < 1e-9);
  const between = levelAt(tide, z("2026-11-23 08:45"));
  assert.ok(between > 7.7 && between < 7.8);
  // Outside the forecast, the tide alone; near its ends, fading from one to the other.
  assert.equal(levelAt(tide, z("2026-11-23 01:00")), tideAt(turns, z("2026-11-23 01:00")));
  const edge = z("2026-11-23 03:30"), w = 0.5; // an hour and a half into the 3-hour fade
  assert.ok(Math.abs(levelAt(tide, edge) - (tideAt(turns, edge) + (3.5 - tideAt(turns, edge)) * w)) < 1e-9);
  // A high keeps the tide’s time and takes the water level then.
  const high = highsAndLows(tide)[2];
  assert.equal(high.ms, z("2026-11-23 09:25"));
  assert.ok(high.ft > 7.7 && high.ft < 7.8);

  const warning = { event: "Coastal Flood Warning", onsetMs: z("2026-11-23 06:00"), endsMs: z("2026-11-26 16:00") };
  const surf = { event: "High Surf Warning", onsetMs: z("2026-11-23 06:00"), endsMs: z("2026-11-26 16:00") };
  const t = assessTide(tide, z("2026-11-23 08:00"), spot, [surf, warning]);
  assert.equal(t.value, "7.5 ft ↑");
  assert.deepEqual(t.notes, ["High 7.7 ft at 9:25 AM", "Forecast with storm surge", "Coastal flood warning in effect"]);
  // Before the warning starts, no flood note; before the forecast, tide only.
  assert.deepEqual(assessTide(tide, z("2026-11-23 01:00"), spot, [warning]).notes,
    ["Low 2.8 ft at 3:07 AM", "Tide only, without storm surge"]);
});

test("a day ahead marks the latest water temperature as an estimate, named by its day, still rated", () => {
  assert.deepEqual(assessWaterTemp({ f: 61.6 }, spot), { level: "low", value: "62°F", notes: [] });
  // Read late on Sat 21 local time: the note names the day it was read, not UTC’s Sun 22.
  assert.deepEqual(assessWaterTemp({ f: 47.2, ms: zonedToMs("2026-11-21 23:30", spot.timeZone), estimate: true }, spot),
    { level: "caution", value: "~47°F",
      notes: ["Estimate based on the Sat 21 reading, since water temperature isn’t forecast."] });
});

test("open-beach waves are rated on the height they break at", () => {
  // Long-period swell grows on its way in: 1 m at 13 s, 10 m deep, breaks at about 1.6 m.
  assert.ok(Math.abs(breakerFt({ hsM: 1, tpS: 13, depthM: 10 }) * 0.3048 - 1.62) < 0.02);
  assert.ok(breakerFt({ hsM: 1, tpS: 16, depthM: 10 }) > breakerFt({ hsM: 1, tpS: 8, depthM: 10 }));
  assert.equal(breakerFt({ hsM: 0, tpS: 13, depthM: 10 }), null);
  const calm = assessWaves({ nearshore: { hsM: 0.25, tpS: 8, depthM: 10 } }, baker);
  assert.equal(calm.level, "low");
  assert.deepEqual(calm.notes, ["Breaking height, 8-second swell"]);
  assert.equal(assessWaves({ nearshore: { hsM: 1, tpS: 13, depthM: 10 } }, baker).level, "high");
});

test("each beach says which way its current runs", () => {
  const ebb = [{ ms: 0, knots: -1 }, { ms: 2 * H, knots: 0 }];
  assert.equal(assessCurrent(ebb, 0, spot).notes[0], "Ebb, pulling west toward the Gate");
  assert.equal(assessCurrent(ebb, 0, baker).notes[0], "Ebb, pulling south toward China Beach");
});

test("a beach with several stations takes the worst of them", () => {
  const station = (stationid, more) => ({ stationid, sample_date: "11/19/26", ...more });
  const ids = ["1", "2", "3"];
  assert.deepEqual(worstPosting([station("1"), station("2", { sample_date: "11/18/26" }), station("3")], ids),
    { status: "clean", sampled: "2026-11-18" });
  assert.deepEqual(worstPosting([station("1"), station("2", { s_color: "R" }), station("3", { cso: "Baker" })], ids),
    { status: "posted", reason: "overflow", sampled: "2026-11-19" });
  assert.deepEqual(worstPosting([station("1"), station("2", { s_color: "Y" }), station("3")], ids),
    { status: "unsampled", sampled: "2026-11-19" });
  // A station missing from the feed isn’t known to be clean.
  assert.equal(worstPosting([station("1"), station("2")], ids).status, "unsampled");
  assert.throws(() => worstPosting([], ids));
});
