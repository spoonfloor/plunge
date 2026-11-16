// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { currentAt, peakCurrent, transferFactor, assessCurrent, assessWaves, assessWind, windPush, overall, summarizeDay, hourSpan,
  assessWaterQuality, waterAdvisories, advisorySummary, advisoryParagraphs } from "../js/model.js";
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

test("wave levels from estimated beach height", () => {
  assert.equal(assessWaves([{ ft: 8, periodS: 11, dirDeg: 280 }], spot).level, "low");     // 0.88 ft
  assert.equal(assessWaves([{ ft: 12, periodS: 17, dirDeg: 275 }], spot).level, "high");   // 2.76 ft
  assert.equal(assessWaves([], spot).level, "unknown");
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

test("day summary groups hours by rating", () => {
  const h = (hour, level, drivers = []) => ({ hour, overall: { level, drivers } });
  const day = [h(6, "low"), h(7, "low"), h(8, "high", ["wind"]), h(9, "high", ["wind", "waves"]),
    h(10, "caution", ["current"]), h(11, "low")];
  assert.equal(summarizeDay(day),
    "Low 6–8 AM. High 8–10 AM, because of the wind and waves. Caution 10–11 AM, because of the current. Low 11 AM–12 PM.");
  assert.equal(hourSpan(11, 13), "11 AM–1 PM");
  assert.equal(hourSpan(13, 18), "1–6 PM");
});

test("a posted beach is High every hour, even without current or wave data", () => {
  const posted = assessWaterQuality({ status: "posted", sampled: "2026-11-09" });
  assert.equal(posted.level, "high");
  const f = { current: { level: "unknown" }, waves: { level: "low" }, wind: { level: "low" },
    waterTemp: { level: "low" }, waterQuality: posted };
  assert.deepEqual(overall(f), { level: "high", drivers: ["waterQuality"], why: "SFPUC has posted this beach for bacteria or a sewer overflow. Don’t go in." });
  assert.equal(assessWaterQuality({ status: "clean", sampled: "2026-11-09" }).level, "low");
  assert.deepEqual(assessWaterQuality({ status: "clean", sampled: "2026-11-09" }).notes, ["Sampled Nov 9"]);
  assert.equal(assessWaterQuality({ status: "unsampled", sampled: null }).level, "unknown");
  assert.equal(assessWaterQuality(null).level, "unknown");
});

test("current card: direction, next slack and water level", () => {
  const start = zonedToMs("2026-11-15 13:00", spot.timeZone);
  const ev = [{ ms: start - 2 * H, knots: -2 }, { ms: start + 40 * 60e3, knots: 0 }, { ms: start + 3 * H, knots: 1.5 }];
  const c = assessCurrent(ev, start, spot, 4.43);
  assert.equal(c.value, "0.4 kn"); // 0.77 kn in the channel at 1 PM, half of it at the beach
  assert.deepEqual(c.notes, ["Ebb, pulling west toward the Gate", "Slack at 1:40 PM", "Water level 4.4 ft"]);
  // A slack past midnight says so; no tide leaves the line out.
  const late = zonedToMs("2026-11-15 17:00", spot.timeZone);
  const ev2 = [{ ms: late - H, knots: 1 }, { ms: zonedToMs("2026-11-16 00:30", spot.timeZone), knots: 0 }];
  assert.deepEqual(assessCurrent(ev2, late, spot).notes, ["Flood, pushing east toward the Marina", "Slack at 12:30 AM tomorrow"]);
});

test("wind says which way it pushes a wader on a north-facing beach", () => {
  assert.equal(windPush("S", 0), "Offshore, pushing you out");
  assert.equal(windPush("SSW", 0), "Offshore, pushing you out");
  assert.equal(windPush("N", 0), "Onshore, pushing you in");
  assert.equal(windPush("W", 0), "Along the shore, pushing you east");
  assert.equal(windPush("E", 0), "Along the shore, pushing you west");
  assert.equal(windPush("", 0), null);
  assert.deepEqual(assessWind({ mph: 12, dir: "W" }, spot), { level: "low", value: "12 mph", notes: ["Along the shore, pushing you east"] });
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
