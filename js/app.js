// Offline support (see sw.js). Browsers without service workers just skip it.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

import spot from "./spots/crissy-east.js";
import { forDate, loadAll } from "./sources.js";
import { advisoryParagraphs, advisorySummary, assessHour, feet, showsRain, skyKind, skyLine, summarizeDay, thresholds, tideAt,
  waterAdvisories } from "./model.js";
import { addDays, hourLabel, zonedParts, zonedToMs } from "./time.js";

// The days you can swipe between: yesterday, today and five ahead. Five is as far as
// the NWS nearshore wave model reaches; past it a rating would lean on the rougher
// offshore estimate alone. Yesterday is there to check the rating against how the
// water felt.
const DAYS_BACK = 1, DAYS_AHEAD = 5;

const LABELS = { low: "Low", caution: "Caution", high: "High", unknown: "No rating" };
// Factor cards in order. The first four change hour to hour and open to show the
// day’s curve; the rest are single readings. Tide isn’t rated, only shown.
const FACTORS = [
  { key: "current", name: "Current", curve: true },
  { key: "tide", name: "Tide", curve: true },
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
  open: new Set(), rainOpen: false, summaryOpen: false, advisoriesOpen: false, lastLoad: 0, loading: false };

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
      return [date, { hours, sky: { ...day.skyObserved, ...day.sky }, tide: data.tide }];
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
// The day and hour on the sky line, always with the weekday and date: “Now, Mon 16,
// 10 AM”, “Today, Mon 16, 12 PM”, “Sun 15, 1 PM”. Today also gets a word; the day dots
// up top say where the others fall.
function whenLabel(date, hour) {
  const day = `${weekday(date, "short")} ${Number(date.slice(8))}`;
  if (date === state.today) return `${isNow(date, hour) ? "Now" : "Today"}, ${day}, ${hourLabel(hour)}`;
  return `${day}, ${hourLabel(hour)}`;
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
  fitSummaries();
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
  const { hours, sky, tide } = state.days[date];
  const selected = selectedHour();
  const r = hours.find(h => h.hour === selected);
  const marks = driverMarks(r);
  const rain = rainPcts(sky, hours);
  // The graph opens only on a day that reaches the chance worth showing.
  const hasRain = rain.some(p => p != null && showsRain(p));
  const skyBits = sky[selected] ? [el("span", {}, skyLine(sky[selected]))] : [];
  const when = whenLabel(date, selected);

  const hero = el("section", { class: "hero", "data-level": r.overall.level },
    el("p", { class: "hero-risk eyebrow" },
      el("span", {}, "Risk"),
      marks.length ? el("span", { class: "drivers", role: "img",
        "aria-label": `because of ${r.overall.drivers.map(k => FACTORS.find(f => f.key === k)?.name.toLowerCase()).join(" and ")}` }, marks) : null),
    el("p", { class: "level-word" }, LABELS[r.overall.level]),
    // The hour, then its sky: “Now, Tue, 3 PM · Sunny”. The sky part opens the day’s
    // chance of rain, when the forecast has it.
    el("p", { class: "hero-sky eyebrow" },
      el("span", { class: "when" }, skyBits.length ? `${when} ·` : when),
      hasRain
        ? el("button", { type: "button", class: "sky rain-toggle", "aria-expanded": String(state.rainOpen) },
          skyBits, el("span", { class: "visually-hidden" }, "Chance of rain through the day"),
          el("span", { class: "chevron", "aria-hidden": "true" }))
        : el("span", { class: "sky" }, skyBits)));
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

  // Water temperature is a reading, not a forecast: days ahead show today’s, and say so.
  const latestOnly = date > state.today && {
    waterTemp: "Today’s reading. There’s no forecast for water temperature.",
  };
  const factors = el("ul", { class: "factors", "aria-label": "Factors for the selected hour" },
    FACTORS.map(({ key, name, curve }, i) => {
      const f = r.factors[key];
      const rated = f.level in LABELS && f.level !== "unknown";
      const open = curve && state.open.has(key);
      const graph = !open ? null : key === "tide" ? tideCurve(tide, date, selected, hours) : dayCurve(key, selected, hours);
      const card = el("li", {
        class: ["factor", curve ? "expandable" : "", i > 0 && !curve && FACTORS[i - 1].curve ? "group-start" : ""].join(" ").trim(),
        "data-level": f.level,
      },
        curve ? el("button", { type: "button", class: "expand", "aria-expanded": String(open),
          "aria-label": `${open ? "Hide" : "Show"} ${name.toLowerCase()} through the day` }) : null,
        el("p", { class: "name" }, el("span", {}, name),
          el("span", { class: "rating" }, rated ? LABELS[f.level] : f.trend, curve ? el("span", { class: "chevron", "aria-hidden": "true" }) : null)),
        el("p", { class: "value" }, f.value),
        graph,
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
    summaryCard(hours),
    factors,
    advisories(date));
}

// The day in a sentence or three, cut to two lines until tapped. Open or closed carries
// across hours and days. Whether it needs cutting is only known once it’s on screen:
// fitSummaries() hides the chevron when two lines hold it all.
function summaryCard(hours) {
  const card = el("div", { class: `summary card expandable${state.summaryOpen ? " open" : ""}` },
    el("button", { type: "button", class: "expand", "aria-expanded": String(state.summaryOpen),
      "aria-label": state.summaryOpen ? "Show less of the summary" : "Show all of the summary" }),
    el("p", { class: "summary-text" }, summarizeDay(hours)),
    el("span", { class: "chevron", "aria-hidden": "true" }));
  card.querySelector(".expand").addEventListener("click", () => {
    state.summaryOpen = !state.summaryOpen;
    render();
  });
  return card;
}
function fitSummaries() {
  for (const card of $("track").querySelectorAll(".summary")) {
    const text = card.querySelector(".summary-text");
    const fits = text.scrollHeight <= parseFloat(getComputedStyle(text).lineHeight) * 2 + 1;
    card.classList.toggle("fits", fits);
  }
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

  return svg("svg", { class: "curve", viewBox: `0 0 ${W} ${H}`, role: "img", ...scrubAttrs(key, 0, x(1)),
    "aria-label": `${FACTORS.find(f => f.key === key).name} through the day: ${points.map(p => `${hourLabel(p.hour)} ${p.f.value}`).join(", ")}` },
    line(th.caution, "caution"), line(th.high, "high"),
    runs.map(r => r.length > 1 ? svg("polyline", { points: r.join(" "), class: "trace" }) : null),
    sel?.f.amount != null ? svg("circle", { cx: x(si), cy: y(sel.f.amount), r: 5, class: "dot", "data-level": sel.f.level }) : null,
    labelAt(0, hourLabel(points[0].hour), "start"),
    nearEnd ? null : labelAt(si, hourLabel(selected), "middle"),
    labelAt(points.length - 1, hourLabel(points.at(-1).hour), "end"));
}

// Where a graph’s hours sit, so a finger on it picks the hour under it: the first hour’s
// x and the step from one hour to the next, in the graph’s own units. key finds the
// same graph again after each redraw.
const scrubAttrs = (key, first, step) => ({ "data-graph": key, "data-first": first, "data-step": step });

// The day’s water level, drawn like the factor curves but unrated: a smooth line from
// NOAA’s highs and lows, shaded beneath, with a dashed line at 0 ft (MLLW; lows go
// below it), each high and low in the window marked with its height and time, and a
// dot at the selected hour.
function tideCurve(turns, date, selected, hours) {
  if (!turns) return null;
  const W = 300, H = 140, plotW = W - 34, top = 26, bottom = 104;
  const first = hours[0].hour, last = hours.at(-1).hour;
  const startMs = zonedToMs(`${date} ${first}:00`, spot.timeZone);
  const endMs = zonedToMs(`${date} ${last}:00`, spot.timeZone);
  const x = ms => ((ms - startMs) / (endMs - startMs)) * plotW;
  // Every ten minutes is smooth at this size.
  const samples = [];
  for (let ms = startMs; ms <= endMs; ms += 10 * 60e3) samples.push([ms, tideAt(turns, ms)]);
  if (samples.some(([, ft]) => ft === null)) return null;
  const lo = Math.min(0, ...samples.map(([, ft]) => ft)), hi = Math.max(...samples.map(([, ft]) => ft));
  const y = ft => bottom - ((ft - lo) / (hi - lo || 1)) * (bottom - top);
  const line = samples.map(([ms, ft]) => `${x(ms).toFixed(1)},${y(ft).toFixed(1)}`).join(" ");
  const inWindow = turns.filter(t => t.ms >= startMs && t.ms <= endMs);
  const short = ms => clock(ms).replace(/\s?[AP]M$/, "");
  // Labels near either end lean inward so they stay inside the card.
  const anchor = px => px < 40 ? "start" : px > plotW - 40 ? "end" : "middle";
  const si = hours.findIndex(h => h.hour === selected);
  const selMs = zonedToMs(`${date} ${selected}:00`, spot.timeZone);
  const axis = (px, text, a) => svg("text", { x: px, y: H - 4, "text-anchor": a, class: "axis" }, text);
  const nearEnd = x(selMs) < 44 || x(selMs) > plotW - 44;

  return svg("svg", { class: "curve tide-curve", viewBox: `0 0 ${W} ${H}`, role: "img",
    ...scrubAttrs("tide", 0, plotW / (hours.length - 1)),
    "aria-label": `Tide through the day: ${inWindow.map(t => `${t.type} ${feet(t.ft)} feet at ${clock(t.ms)}`).join(", ") || "no high or low in these hours"}` },
    svg("polygon", { class: "fill", points: `0,${bottom} ${line} ${plotW},${bottom}` }),
    svg("line", { x1: 0, x2: plotW + 2, y1: y(0), y2: y(0), class: "guide" }),
    svg("text", { x: plotW + 8, y: y(0), class: "guide-label", "dominant-baseline": "middle" }, "0"),
    svg("polyline", { points: line, class: "trace" }),
    inWindow.flatMap(t => [
      svg("circle", { cx: x(t.ms), cy: y(t.ft), r: 3.5, class: "turn" }),
      svg("text", { x: x(t.ms), y: y(t.ft) + (t.type === "high" ? -9 : 16), "text-anchor": anchor(x(t.ms)), class: "turn-label" },
        `${feet(t.ft)} ft · ${short(t.ms)}`)]),
    si >= 0 ? svg("circle", { cx: x(selMs), cy: y(tideAt(turns, selMs)), r: 5, class: "dot unrated" }) : null,
    axis(0, hourLabel(first), "start"),
    nearEnd ? null : axis(x(selMs), hourLabel(selected), "middle"),
    axis(plotW, hourLabel(last), "end"));
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

  return svg("svg", { class: "rain-curve", viewBox: `0 0 ${W} ${H}`, role: "img", ...scrubAttrs("rain", x(0), x(1) - x(0)),
    "aria-label": `Chance of rain through the day: ${hours.map((h, i) => pcts[i] == null ? null : `${hourLabel(h.hour)} ${Math.round(pcts[i])}%`).filter(Boolean).join(", ")}` },
    [0, 50, 100].map(v => svg("g", { class: "guide" },
      svg("line", { x1: 0, x2: (W - labelWidth(String(v)) - 6).toFixed(1), y1: y(v), y2: y(v) }),
      svg("text", { x: W, y: y(v), "text-anchor": "end", "dominant-baseline": "middle" }, String(v)))),
    runs.map(r => r.length > 1 ? svg("polyline", { points: r.map(p => p.at).join(" "), class: "trace" }) : null),
    pcts[si] != null ? svg("circle", { cx: x(si), cy: y(pcts[si]), r: 5, class: "dot" }) : null);
}

// Tapping the sky line opens or closes the graph at once, like the factor curves. The
// page is built afresh, so focus goes back to the new sky line.
function toggleRain(e) {
  const refocus = e.currentTarget === document.activeElement;
  state.rainOpen = !state.rainOpen;
  render();
  if (refocus) $("track").children[1]?.querySelector(".rain-toggle")?.focus();
}

// A wider or narrower screen moves the hours, so the rain line is drawn again to match,
// and changes where the summary wraps.
addEventListener("resize", () => {
  if (!state.dates.length) return;
  if (state.rainOpen) render();
  else fitSummaries();
});

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

// Touch the hour strip and drag along it to scan the hours. On a graph, tap an hour or
// drag sideways to scan them; a drag that starts upward or downward scrolls instead, so
// the big graphs don’t snag the page. Either way the whole page follows the hour.
// Anywhere else, a sideways swipe moves a day; vertical drags still scroll the page
// (touch-action: pan-y in app.css). With a mouse, the dots and arrow keys change the day.
{
  const pager = $("pager"), track = $("track");
  let gesture = null, swiped = false;
  const current = () => track.children[1];
  // The hour under the pointer on the strip, or on graph key (looked up afresh: each
  // pick redraws the page).
  const pick = (e, graph) => {
    const hours = state.days[state.date].hours;
    let i;
    if (graph) {
      const g = current()?.querySelector(`[data-graph="${graph}"]`);
      if (!g) return;
      const box = g.getBoundingClientRect();
      const at = ((e.clientX - box.left) / box.width) * g.viewBox.baseVal.width;
      i = Math.round((at - Number(g.dataset.first)) / Number(g.dataset.step));
    } else {
      const s = current()?.querySelector(".strip");
      if (!s) return;
      const box = s.getBoundingClientRect();
      i = Math.floor(((e.clientX - box.left) / box.width) * hours.length);
    }
    select(hours[Math.min(hours.length - 1, Math.max(0, i))].hour);
  };
  pager.addEventListener("pointerdown", e => {
    swiped = false;
    if (e.button !== 0 || !state.dates.length || sliding) return;
    const graph = e.target.closest("[data-graph]");
    if (e.target.closest(".strip") && current()?.contains(e.target)) {
      gesture = { mode: "scrub" };
      pick(e);
      pager.setPointerCapture(e.pointerId);
    } else if (graph && current()?.contains(graph)) {
      gesture = { mode: "pending", graph: graph.dataset.graph, x: e.clientX, y: e.clientY, id: e.pointerId };
    } else if (e.pointerType !== "mouse") {
      gesture = { mode: "pending", x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId, dx: 0 };
    }
  });
  pager.addEventListener("pointermove", e => {
    if (!gesture) return;
    if (gesture.mode === "scrub") return pick(e, gesture.graph);
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    if (gesture.mode === "pending") {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        gesture.mode = gesture.graph ? "scrub" : "swipe";
        pager.setPointerCapture(gesture.id);
        if (gesture.graph) return pick(e, gesture.graph);
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
    if (gesture?.graph) {
      if (gesture.mode === "pending") pick(e, gesture.graph); // a tap
      swiped = true; // not a tap on the card behind
    }
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
  // A swipe or scan that ends over a card isn’t a tap on it.
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
