// Offline support (see sw.js). Browsers without service workers just skip it.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

import spot from "./spots/crissy-east.js";
import { forDate, loadAll } from "./sources.js";
import { advisoryParagraphs, advisorySummary, assessHour, skyKind, skyLine, summarizeDay, thresholds, waterAdvisories } from "./model.js";
import { addDays, hourLabel, zonedParts, zonedToMs } from "./time.js";

// The days you can swipe between: yesterday, today and five ahead. Five is as far as
// the NWS nearshore wave model reaches; past it a rating would lean on the rougher
// offshore estimate alone. Yesterday is there to check the rating against how the
// water felt.
const DAYS_BACK = 1, DAYS_AHEAD = 5;

const LABELS = { low: "Low", caution: "Caution", high: "High", unknown: "No rating" };
// Factor cards in order. The first three change hour to hour and open to show the
// day’s curve; the rest are single readings.
const FACTORS = [
  { key: "current", name: "Current", curve: true },
  { key: "waves", name: "Waves", curve: true },
  { key: "wind", name: "Wind", curve: true },
  { key: "waterTemp", name: "Water temperature" },
  { key: "waterQuality", name: "Water quality" },
];
const THRESHOLDS = thresholds(spot);
const REFRESH_AFTER_MS = 15 * 60e3;

const $ = id => document.getElementById(id);
const clock = ms => new Intl.DateTimeFormat("en-US", { timeZone: spot.timeZone, hour: "numeric", minute: "2-digit" }).format(ms);
const dayAndHour = ms => new Intl.DateTimeFormat("en-US", { timeZone: spot.timeZone, weekday: "short", hour: "numeric" }).format(ms);

// el("p", { class: "x" }, "text", child) → element. Text goes in as text, never as HTML.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, v === true ? "" : v);
  node.append(...children.flat().filter(c => c != null && c !== false));
  return node;
}
// The same for SVG.
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  node.append(...children.flat().filter(c => c != null && c !== false));
  return node;
}

// Sky icons, 24 × 24, drawn with the text color. Clouds are filled with the page color
// so a sun or moon behind them is hidden.
const CLOUD = (d) => svg("path", { d, class: "cloud" });
const SKY_ICONS = {
  sun: () => [svg("circle", { cx: 12, cy: 12, r: 4 }),
    svg("path", { d: "M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" })],
  moon: () => [svg("path", { d: "M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10z" })],
  cloud: () => [CLOUD("M7 19h10a4 4 0 0 0 .4-8A6 6 0 0 0 6 11.3 3.9 3.9 0 0 0 7 19z")],
  "partly-day": () => [svg("circle", { cx: 16, cy: 8, r: 3 }), svg("path", { d: "M16 2.5v1.3M21.5 8h-1.3M19.9 4.1l-.9.9" }),
    CLOUD("M6.5 20h8.5a3.5 3.5 0 0 0 .3-7A5 5 0 0 0 5.8 14 3 3 0 0 0 6.5 20z")],
  "partly-night": () => [svg("path", { d: "M21 11A4 4 0 1 1 15.5 5.3a3.2 3.2 0 0 0 5.5 5.7z" }),
    CLOUD("M6.5 20h8.5a3.5 3.5 0 0 0 .3-7A5 5 0 0 0 5.8 14 3 3 0 0 0 6.5 20z")],
  "rain-light": () => [CLOUD("M7 14.5h10a3.5 3.5 0 0 0 .4-7A5.5 5.5 0 0 0 6.6 8.6 3 3 0 0 0 7 14.5z"),
    svg("path", { d: "M10.2 18.4v.01M13.6 19.8v.01", class: "dots" })],
  "rain-heavy": () => [CLOUD("M7 13.5h10a3.5 3.5 0 0 0 .4-7A5.5 5.5 0 0 0 6.6 7.6 3 3 0 0 0 7 13.5z"),
    svg("path", { d: "M9 16l-1.5 5M12.5 16l-1.5 5M16 16l-1.5 5", class: "heavy" })],
  rain: () => [CLOUD("M7 14.5h10a3.5 3.5 0 0 0 .4-7A5.5 5.5 0 0 0 6.6 8.6 3 3 0 0 0 7 14.5z"),
    svg("path", { d: "M10.5 17.5l-1 3M14.5 17.5l-1 3" })],
  storm: () => [CLOUD("M7 14.5h10a3.5 3.5 0 0 0 .4-7A5.5 5.5 0 0 0 6.6 8.6 3 3 0 0 0 7 14.5z"),
    svg("path", { d: "M12.5 15.5l-2 3.5h3l-2 3.5" })],
  fog: () => [svg("path", { d: "M4 8h16M3 12h18M5 16h14M8 20h8" })],
};
// What’s driving the selected hour’s rating, after the time on the Risk line: icons for
// current, waves, wind and water quality (a drop with specks in it), the reading itself
// for water temperature.
const DRIVER_ICONS = {
  waterQuality: () => [svg("path", { d: "M12 3c-3.3 4.2-6.2 7.6-6.2 11a6.2 6.2 0 0 0 12.4 0C18.2 10.6 15.3 7.2 12 3z" }),
    svg("path", { d: "M11 11v.01M14.4 13.6v.01M10.8 16v.01", class: "dots" })],
  current: () => [svg("path", { d: "M3 9c2.5-2 5-2 7.5 0s5 2 7.5 0 3-1.5 3-1.5M3 15c2.5-2 5-2 7.5 0s5 2 7.5 0 3-1.5 3-1.5" })],
  waves: () => [svg("path", { d: "M2.5 16c2 0 3-1 4.5-3.5S10 7 13 7c2.5 0 3.5 2 3 3.5-1.5-1-3-.3-3 1.3 0 2.2 2.5 4.2 6 4.2h2.5" }),
    svg("path", { d: "M2.5 20c2.5 0 3.5-1.2 6-1.2s3.5 1.2 6 1.2 3.5-1.2 6-1.2" })],
  wind: () => [svg("path", { d: "M3 9h11a3 3 0 1 0-3-3" }), svg("path", { d: "M3 13h15a3 3 0 1 1-3 3" }), svg("path", { d: "M3 17h7" })],
};
function driverMarks(r) {
  if (r.overall.level !== "caution" && r.overall.level !== "high") return [];
  return r.overall.drivers.map(k =>
    DRIVER_ICONS[k] ? svg("svg", { class: "driver-icon", viewBox: "0 0 24 24", "aria-hidden": "true" }, DRIVER_ICONS[k]())
    : k === "waterTemp" ? el("span", { class: "driver-temp", "aria-hidden": "true" }, r.factors.waterTemp.value.replace(/F$/, ""))
    : null).filter(Boolean);
}

const skyIcon = sky => svg("svg", { class: "sky-icon", viewBox: "0 0 24 24", "aria-hidden": "true" }, SKY_ICONS[skyKind(sky)]());

// date: the day shown. selected: the hour picked, or null for “now” (on other days,
// the hour it is now). Both carry across days, so swiping compares the same hour.
const state = { today: null, dates: [], days: {}, alerts: null, date: null, selected: null,
  open: new Set(), rainOpen: false, advisoriesOpen: false, lastLoad: 0, loading: false };

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $("refresh").disabled = true;
  if (state.lastLoad) $("updated").textContent = "Updating…"; // the first load keeps “Loading…”
  const today = zonedParts(Date.now(), spot.timeZone).date;
  const dates = Array.from({ length: DAYS_BACK + 1 + DAYS_AHEAD }, (_, i) => addDays(today, i - DAYS_BACK));
  try {
    const { data, sources } = await loadAll(spot, dates, (done, total) => {
      $("loader").max = total;
      $("loader").value = done;
    });
    if (today !== state.today) { state.date = today; state.selected = null; } // a new day starts back at “now”
    state.today = today;
    state.dates = dates;
    state.alerts = data.alerts;
    state.days = Object.fromEntries(dates.map(date => {
      const day = forDate(data, date);
      const hours = [];
      for (let hour = spot.firstHour; hour <= spot.lastHour; hour++) {
        hours.push(assessHour(hour, zonedToMs(`${date} ${hour}:00`, spot.timeZone), day, spot));
      }
      // The forecast’s sky where it has the hour; what a station reported where it doesn’t.
      return [date, { hours, sky: { ...day.skyObserved, ...day.sky } }];
    }));
    state.lastLoad = Date.now();
    renderStatus(sources);
    render();
  } finally {
    document.querySelector("main").classList.remove("first-load");
    state.loading = false;
    $("refresh").disabled = false;
  }
}

// ---- Days and hours ------------------------------------------------------------------

const clampHour = h => Math.min(spot.lastHour, Math.max(spot.firstHour, h));
const now = () => zonedParts(Date.now(), spot.timeZone);
const selectedHour = () => state.selected ?? clampHour(now().hour);
// Where “now” falls in the day’s window: the current hour, or the nearest end of it.
// Null on any other day.
function nowHour(date) {
  const n = now();
  return n.date === date ? clampHour(n.hour) : null;
}
function isPast(date, hour) {
  const n = now();
  return n.date === date && hour < n.hour;
}
const isNow = (date, hour) => hour === nowHour(date) && !isPast(date, hour);

const dayIndex = date => state.dates.indexOf(date);
const utcDate = date => { const [y, m, d] = date.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const weekday = (date, style) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: style }).format(utcDate(date));
const longDate = date => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(utcDate(date));
// The day and hour on the Risk line, always with the weekday: “Now, Mon, 10 AM”,
// “Today, Mon, 12 PM”, “Yesterday, Sun 15, 1 PM”, “Tomorrow, Tue 17, 1 PM”, “Thu 19, 1 PM”.
function whenLabel(date, hour) {
  const wd = weekday(date, "short"), wdDate = `${wd} ${Number(date.slice(8))}`;
  const n = dayIndex(date) - dayIndex(state.today);
  if (n === 0) return `${isNow(date, hour) ? "Now" : "Today"}, ${wd}, ${hourLabel(hour)}`;
  const word = n === -1 ? "Yesterday, " : n === 1 ? "Tomorrow, " : "";
  return `${word}${wdDate}, ${hourLabel(hour)}`;
}

// ---- Rendering -------------------------------------------------------------------------

function renderStatus(sources) {
  const stale = sources.filter(s => s.stale);
  $("updated").textContent = stale.length
    ? `Partly offline · ${clock(Math.min(...stale.map(s => s.fetchedAt)))}`
    : `Updated ${clock(Date.now())}`;
}

// The shown day with the day before and after it beside it, ready to swipe in, and the
// dots that say which day this is.
function render() {
  const i = dayIndex(state.date);
  $("track").replaceChildren(dayPanel(state.dates[i - 1], -1), dayPanel(state.date, 0), dayPanel(state.dates[i + 1], 1));
  $("days").replaceChildren(...state.dates.map(date => {
    const button = el("button", { type: "button", class: date === state.today ? "today" : null,
      "aria-current": date === state.date ? "true" : null,
      "aria-label": `${date === state.today ? "Today, " : ""}${longDate(date)}` }, el("span", { class: "dot" }));
    button.addEventListener("click", () => goTo(date));
    return button;
  }));
  const r = state.days[state.date].hours.find(h => h.hour === selectedHour());
  $("announce").textContent = `${whenLabel(state.date, r.hour)}: ${LABELS[r.overall.level]}`;
}

// One day: hero, sky icons, hour strip, summary, factor cards for the selected hour and
// the day’s advisories. side: -1 and 1 are the neighbors, there only to swipe in, so
// they’re hidden from screen readers and keyboard. Past either end, a note says why
// there’s nothing more.
function dayPanel(date, side) {
  if (!date) {
    return el("section", { class: `day end ${side < 0 ? "before" : "after"}`, inert: true, "aria-hidden": "true" },
      el("p", {}, side < 0 ? "Nothing before yesterday" : "No forecast past here"));
  }
  const { hours, sky } = state.days[date];
  const selected = selectedHour();
  const r = hours.find(h => h.hour === selected);
  const marks = driverMarks(r);
  const rain = rainPcts(sky, hours);
  const hasRain = rain.some(p => p != null);
  const skyBits = sky[selected] ? [skyIcon(sky[selected]), el("span", {}, skyLine(sky[selected]))] : [];

  const hero = el("section", { class: "hero", "data-level": r.overall.level },
    el("p", { class: "hero-when eyebrow" },
      el("span", { class: "when" }, `Risk · ${whenLabel(date, selected)}`),
      marks.length ? el("span", { class: "drivers", role: "img",
        "aria-label": `because of ${r.overall.drivers.map(k => FACTORS.find(f => f.key === k)?.name.toLowerCase()).join(" and ")}` }, marks) : null),
    el("p", { class: "level-word" }, LABELS[r.overall.level]),
    // The sky line opens the day’s chance of rain, when the forecast has it.
    el("p", { class: "hero-sky" }, hasRain
      ? el("button", { type: "button", class: "rain-toggle", "aria-expanded": String(state.rainOpen) },
        skyBits, el("span", { class: "visually-hidden" }, "Chance of rain through the day"),
        el("span", { class: "chevron", "aria-hidden": "true" }))
      : skyBits));
  hero.querySelector(".rain-toggle")?.addEventListener("click", toggleRain);

  const skyRow = el("div", { class: "sky-row", "aria-hidden": "true", style: `--hours: ${hours.length}` },
    hours.map(h => el("span", { class: isPast(date, h.hour) ? "past" : null }, sky[h.hour] ? skyIcon(sky[h.hour]) : null)));

  const strip = el("div", { class: "strip", role: "group", "aria-label": "Pick an hour", style: `--hours: ${hours.length}` },
    hours.map(h => {
      const label = hourLabel(h.hour);
      const button = el("button", {
        type: "button", "data-level": h.overall.level, "aria-pressed": String(h.hour === selected),
        "aria-label": [label, LABELS[h.overall.level], sky[h.hour]?.text].filter(Boolean).join(", "),
        class: [isNow(date, h.hour) ? "now" : "", isPast(date, h.hour) ? "past" : ""].join(" ").trim() || null,
      },
        el("span", { class: "bar", "aria-hidden": "true" }),
        el("span", { class: "label", "aria-hidden": "true" }, label.split(" ")[0]));
      // Keyboard selection; pointer taps and drags go through the pager’s handlers.
      button.addEventListener("click", e => { if (e.detail === 0) select(h.hour); });
      return button;
    }));

  // Water temperature is a latest reading, not a forecast: every day shows today’s, and
  // says so.
  const latestOnly = date !== state.today && {
    waterTemp: "Today’s reading. There’s no forecast for water temperature.",
  };
  const factors = el("ul", { class: "factors", "aria-label": "Factors for the selected hour" },
    FACTORS.map(({ key, name, curve }, i) => {
      const f = r.factors[key];
      const rated = f.level in LABELS && f.level !== "unknown";
      const open = curve && state.open.has(key);
      const card = el("li", {
        class: ["factor", curve ? "expandable" : "", i > 0 && !curve && FACTORS[i - 1].curve ? "group-start" : ""].join(" ").trim(),
        "data-level": f.level,
      },
        curve ? el("button", { type: "button", class: "expand", "aria-expanded": String(open),
          "aria-label": `${open ? "Hide" : "Show"} ${name.toLowerCase()} through the day` }) : null,
        el("p", { class: "name" }, el("span", {}, name),
          el("span", { class: "rating" }, rated ? LABELS[f.level] : null, curve ? el("span", { class: "chevron", "aria-hidden": "true" }) : null)),
        el("p", { class: "value" }, f.value),
        open ? dayCurve(key, selected, hours) : null,
        f.notes.map(n => el("p", { class: "note" }, n)),
        latestOnly?.[key] && rated ? el("p", { class: "note" }, latestOnly[key]) : null);
      card.querySelector(".expand")?.addEventListener("click", () => {
        state.open.has(key) ? state.open.delete(key) : state.open.add(key);
        render();
      });
      return card;
    }));

  return el("section", { class: "day", "aria-label": longDate(date), inert: side !== 0, "aria-hidden": side !== 0 ? "true" : null },
    hero, skyRow,
    state.rainOpen && hasRain ? el("div", { class: "rain" }, rainCurve(rain, hours, selected)) : null,
    strip,
    el("p", { class: "summary card" }, summarizeDay(hours)),
    factors,
    advisories(date));
}

// NWS advisories in force at some point in the day’s window, water-relevant ones only.
// A heads-up below the factors; they don’t change the rating.
function advisories(date) {
  const dayStart = zonedToMs(`${date} ${spot.firstHour}:00`, spot.timeZone);
  const dayEnd = zonedToMs(`${date} ${spot.lastHour + 1}:00`, spot.timeZone);
  const inForce = waterAdvisories(state.alerts).filter(a => a.onsetMs < dayEnd && (!a.endsMs || a.endsMs > dayStart));
  const card = (...children) => el("section", { class: "advisories factor", "aria-label": "NWS advisories" },
    el("p", { class: "name" }, el("span", {}, "NWS advisories"), inForce.length ? el("span", {}, `${inForce.length} active`) : null),
    children);
  if (!state.alerts) return card(el("p", { class: "value" }, "Unavailable"), el("p", { class: "note" }, "NWS advisories didn’t load."));
  if (!inForce.length) return card(el("p", { class: "value" }, "None"));
  const details = el("details", { open: state.advisoriesOpen },
    el("summary", {}, advisorySummary(inForce)),
    inForce.map(a => el("div", { class: "advisory" },
      el("p", { class: "advisory-name" }, sentenceCase(a.event)),
      a.endsMs ? el("p", { class: "advisory-when" }, `Until ${dayAndHour(a.endsMs)}`) : null,
      advisoryParagraphs(a.description).map(p => el("p", { class: "note" }, p)))));
  // Stays open or closed as you pick hours and days.
  details.addEventListener("toggle", () => { state.advisoriesOpen = details.open; });
  return card(details);
}

// “Coastal Flood Advisory” → “Coastal flood advisory”
const sentenceCase = s => s.charAt(0) + s.slice(1).toLowerCase();

function select(hour) {
  if (hour === selectedHour()) return;
  state.selected = hour;
  render();
}

// The day’s values for one factor: a line through the hours, dashed lines at the
// caution and high thresholds with their numbers at the right end, and a dot at the
// selected hour in its rating’s color.
function dayCurve(key, selected, hours) {
  const W = 300, H = 126, plotW = W - 34, top = 12, bottom = H - 22;
  const points = hours.map(h => ({ hour: h.hour, f: h.factors[key] }));
  const th = THRESHOLDS[key];
  const max = Math.max(th.high * 1.2, ...points.map(p => (p.f.amount ?? 0) * 1.1));
  const x = i => (i / (points.length - 1)) * plotW;
  const y = v => bottom - (v / max) * (bottom - top);
  const fmtTh = v => key === "current" ? v.toFixed(1) : String(v);

  // One polyline per run of hours that have a value.
  const runs = [];
  points.forEach((p, i) => {
    if (p.f.amount == null) return;
    if (i === 0 || points[i - 1].f.amount == null) runs.push([]);
    runs.at(-1).push(`${x(i).toFixed(1)},${y(p.f.amount).toFixed(1)}`);
  });

  const line = (v, level) => [
    svg("line", { x1: 0, x2: plotW + 2, y1: y(v), y2: y(v), class: `threshold ${level}` }),
    svg("text", { x: plotW + 8, y: y(v), class: `threshold-label ${level}`, "dominant-baseline": "middle" }, fmtTh(v)),
  ];
  const si = points.findIndex(p => p.hour === selected);
  const sel = points[si];
  const labelAt = (i, text, anchor) => svg("text", { x: x(i), y: H - 4, "text-anchor": anchor, class: "axis" }, text);
  // The selected hour gets its own axis label unless it would crowd an end label.
  const nearEnd = x(si) < 44 || x(si) > plotW - 44;

  return svg("svg", { class: "curve", viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `${FACTORS.find(f => f.key === key).name} through the day: ${points.map(p => `${hourLabel(p.hour)} ${p.f.value}`).join(", ")}` },
    line(th.caution, "caution"), line(th.high, "high"),
    runs.map(r => r.length > 1 ? svg("polyline", { points: r.join(" "), class: "trace" }) : null),
    sel?.f.amount != null ? svg("circle", { cx: x(si), cy: y(sel.f.amount), r: 5, class: "dot", "data-level": sel.f.level }) : null,
    labelAt(0, hourLabel(points[0].hour), "start"),
    nearEnd ? null : labelAt(si, hourLabel(selected), "middle"),
    labelAt(points.length - 1, hourLabel(points.at(-1).hour), "end"));
}

// ---- Chance of rain through the day ---------------------------------------------------

// Each hour’s chance of rain, or null where the hour only has a station report.
const rainPcts = (sky, hours) => hours.map(h => sky[h.hour] && !sky[h.hour].observed ? sky[h.hour].rainPct : null);

// A day’s content width, so the rain line can put each point under its hour to the pixel.
function contentWidth() {
  const day = $("track").children[1];
  if (!day) return 343;
  const style = getComputedStyle(day);
  return day.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}
// The width of a guide’s number. Its digits are tabular, all as wide as a 0, which a
// canvas can’t set, so it measures that many 0s instead.
const measure = document.createElement("canvas").getContext("2d");
function labelWidth(text) {
  measure.font = `600 12px ${getComputedStyle(document.body).fontFamily}`;
  return measure.measureText("0".repeat(text.length)).width;
}

// The day’s chance of rain, drawn like the factor curves: a line through the hours and a
// dot at the selected one, with dashed lines at 0, 50 and 100% and their numbers at the
// right end. Each point sits under its hour’s sky icon; the line breaks over hours with
// no chance of rain.
function rainCurve(pcts, hours, selected) {
  const W = contentWidth(), H = 72, top = 8, bottom = 64;
  const GAP = 3; // the sky row’s and hour strip’s column gap, in app.css
  const col = (W - GAP * (hours.length - 1)) / hours.length;
  const x = i => i * (col + GAP) + col / 2;
  const y = pct => bottom - (pct / 100) * (bottom - top);

  const runs = [];
  pcts.forEach((p, i) => {
    if (p == null) return;
    if (i === 0 || pcts[i - 1] == null) runs.push([]);
    runs.at(-1).push({ i, at: `${x(i).toFixed(1)},${y(p).toFixed(1)}` });
  });
  const si = hours.findIndex(h => h.hour === selected);

  return svg("svg", { class: "rain-curve", viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `Chance of rain through the day: ${hours.map((h, i) => pcts[i] == null ? null : `${hourLabel(h.hour)} ${Math.round(pcts[i])}%`).filter(Boolean).join(", ")}` },
    [0, 50, 100].map(v => svg("g", { class: "guide" },
      svg("line", { x1: 0, x2: (W - labelWidth(String(v)) - 6).toFixed(1), y1: y(v), y2: y(v) }),
      svg("text", { x: W, y: y(v), "text-anchor": "end", "dominant-baseline": "middle" }, String(v)))),
    runs.map(r => r.length > 1 ? svg("polyline", { points: r.map(p => p.at).join(" "), class: "trace", pathLength: 1,
      "data-from": r[0].i, "data-to": r.at(-1).i }) : null),
    pcts[si] != null ? svg("circle", { cx: x(si), cy: y(pcts[si]), r: 5, class: "dot", "data-i": si }) : null);
}

// Tapping the sky line. Every render builds the page afresh, so the graph is always
// built already open or already gone: the motion runs here, on the tap, never on a
// render. Picking an hour or changing days shows it as it stands.
let folding = false;
async function toggleRain(e) {
  if (folding) return;
  const refocus = e.currentTarget === document.activeElement;
  const graph = () => $("track").children[1]?.querySelector(".rain");
  if (state.rainOpen) {
    folding = true;
    if (!reduceMotion()) await fold(graph());
    folding = false;
    state.rainOpen = false;
    render();
  } else {
    state.rainOpen = true;
    render();
    if (!reduceMotion()) unfold(graph());
  }
  if (refocus) $("track").children[1]?.querySelector(".rain-toggle")?.focus();
}

const EASE = "cubic-bezier(.2,.8,.2,1)";
// The space opens; the guides fade in; the line draws left to right, and the dot pops in
// as the line reaches it.
function unfold(graph) {
  const h = graph.offsetHeight, n = state.days[state.date].hours.length - 1;
  const DRAW = 420, START = 120;
  graph.animate([{ height: "0px" }, { height: `${h}px` }], { duration: 300, easing: EASE });
  graph.querySelectorAll(".guide").forEach(g => g.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 60, fill: "backwards" }));
  graph.querySelectorAll(".trace").forEach(t => {
    const from = +t.dataset.from / n, to = +t.dataset.to / n;
    t.animate([{ strokeDasharray: "0 1" }, { strokeDasharray: "1 0" }],
      { duration: DRAW * (to - from), delay: START + DRAW * from, easing: "linear", fill: "backwards" });
  });
  graph.querySelector(".dot")?.animate([{ transform: "scale(0)" }, { transform: "scale(1.25)", offset: 0.7 }, { transform: "scale(1)" }],
    { duration: 220, delay: START + DRAW * (+graph.querySelector(".dot").dataset.i / n), easing: "ease-out", fill: "backwards" });
}

// The reverse, quicker: the dot and guides go, the line pulls back left, the space closes.
async function fold(graph) {
  if (!graph) return;
  const all = [
    ...[...graph.querySelectorAll(".guide")].map(g => g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" })),
    ...[...graph.querySelectorAll(".trace")].map(t => t.animate([{ strokeDasharray: "1 0" }, { strokeDasharray: "0 1" }], { duration: 160, easing: "ease-in", fill: "forwards" })),
    graph.querySelector(".dot")?.animate([{ transform: "scale(1)" }, { transform: "scale(0)" }], { duration: 100, fill: "forwards" }),
  ].filter(Boolean);
  // As with swipes, a browser that stops drawing frames can’t hold the tap up.
  const settle = (animations, ms) => Promise.race([Promise.all(animations.map(a => a.finished)).catch(() => {}),
    new Promise(done => setTimeout(done, ms + 150))]);
  await settle(all, 160);
  await settle([graph.animate([{ height: `${graph.offsetHeight}px` }, { height: "0px" }], { duration: 180, easing: EASE, fill: "forwards" })], 180);
}

// A wider or narrower screen moves the hours, so the line is drawn again to match.
addEventListener("resize", () => { if (state.rainOpen && state.dates.length) render(); });

// ---- Moving between days ------------------------------------------------------------------

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
let sliding = false;

function show(date) {
  state.date = date;
  if (date === state.today) state.selected = null; // back on today, back to “now”
  render();
}

// Slide one day over (delta ±1), or back into place (delta 0, or past either end).
// fromPx: where a swipe left the track.
async function slide(delta, fromPx = 0) {
  if (sliding) return;
  sliding = true;
  const w = $("pager").clientWidth;
  const target = delta ? state.dates[dayIndex(state.date) + delta] : null;
  const to = target ? -w - delta * w : -w;
  const track = $("track");
  track.style.transform = "";
  const duration = reduceMotion() ? 0 : 260;
  const move = track.animate([{ transform: `translateX(${-w + fromPx}px)` }, { transform: `translateX(${to}px)` }],
    { duration, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
  // A browser that stops drawing frames (in the background, say) can leave an animation
  // unfinished; the day changes on time regardless, so swipes never lock up.
  await Promise.race([move.finished.catch(() => {}), new Promise(done => setTimeout(done, duration + 150))]);
  if (target) show(target);
  move.cancel();
  sliding = false;
}

// A tap on a dot: slide to the day next door, or bring a farther day in from its side.
function goTo(date) {
  const delta = dayIndex(date) - dayIndex(state.date);
  if (!delta || sliding) return;
  if (Math.abs(delta) === 1) return slide(delta);
  show(date);
  if (!reduceMotion()) {
    $("track").animate([{ opacity: 0.4, transform: `translateX(calc(-100% + ${Math.sign(delta) * 32}px))` },
      { opacity: 1, transform: "translateX(-100%)" }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
}

// Touch the hour strip and drag along it to scan the hours. Anywhere else on the page,
// a sideways swipe moves a day; vertical drags still scroll the page (touch-action:
// pan-y in app.css). With a mouse, the dots and arrow keys change the day.
{
  const pager = $("pager"), track = $("track");
  let gesture = null, swiped = false;
  const strip = () => track.children[1]?.querySelector(".strip");
  const pick = e => {
    const s = strip();
    if (!s) return;
    const hours = state.days[state.date].hours;
    const box = s.getBoundingClientRect();
    const i = Math.floor(((e.clientX - box.left) / box.width) * hours.length);
    select(hours[Math.min(hours.length - 1, Math.max(0, i))].hour);
  };
  pager.addEventListener("pointerdown", e => {
    swiped = false;
    if (e.button !== 0 || !state.dates.length || sliding) return;
    if (e.target.closest(".strip") && e.target.closest(".strip") === strip()) {
      gesture = { mode: "scrub" };
      pick(e);
      pager.setPointerCapture(e.pointerId);
    } else if (e.pointerType !== "mouse") {
      gesture = { mode: "pending", x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId, dx: 0 };
    }
  });
  pager.addEventListener("pointermove", e => {
    if (!gesture) return;
    if (gesture.mode === "scrub") return pick(e);
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    if (gesture.mode === "pending") {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        gesture.mode = "swipe";
        pager.setPointerCapture(gesture.id);
      } else if (Math.abs(dy) > 10) {
        gesture = null; // a scroll
        return;
      }
    }
    if (gesture.mode === "swipe") {
      // Past either end the page follows the finger only partway.
      const i = dayIndex(state.date);
      const atEnd = (dx > 0 && i === 0) || (dx < 0 && i === state.dates.length - 1);
      gesture.dx = atEnd ? dx * 0.35 : dx;
      track.style.transform = `translateX(${-pager.clientWidth + gesture.dx}px)`;
    }
  });
  pager.addEventListener("pointerup", e => {
    if (gesture?.mode === "swipe") {
      swiped = true;
      const dx = e.clientX - gesture.x;
      const fast = Math.abs(dx) / Math.max(1, e.timeStamp - gesture.t) > 0.5;
      const far = Math.abs(dx) > pager.clientWidth * 0.2;
      slide(far || fast ? (dx < 0 ? 1 : -1) : 0, gesture.dx);
    }
    gesture = null;
  });
  pager.addEventListener("pointercancel", () => {
    if (gesture?.mode === "swipe") slide(0, gesture.dx);
    gesture = null;
  });
  // A swipe that ends over a card isn’t a tap on it.
  pager.addEventListener("click", e => { if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; } }, true);
}

document.addEventListener("keydown", e => {
  if (!state.dates.length || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.key === "ArrowRight") slide(1);
  else if (e.key === "ArrowLeft") slide(-1);
});

$("refresh").addEventListener("click", refresh);
// Coming back to the app after a while (or the next morning) loads fresh data.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - state.lastLoad > REFRESH_AFTER_MS) refresh();
});
refresh();
