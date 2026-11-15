// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { currentAt, peakCurrent, transferFactor, assessCurrent, assessWaves, overall } from "../js/model.js";
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
    wind: { level: wind }, waterTemp: { level: "unknown" }, tide: { level: "info" } });
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
