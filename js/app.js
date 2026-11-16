// Offline support (see sw.js). Browsers without service workers just skip it.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

import spot from "./spots/crissy-east.js";
import { loadAll } from "./sources.js";
import { advisoryParagraphs, advisorySummary, assessHour, skyKind, skyLine, summarizeDay, thresholds, waterAdvisories } from "./model.js";
import { hourLabel, zonedParts, zonedToMs } from "./time.js";

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
    svg("path", { d: "M9 18.5v.01M15 18.5v.01M12 21v.01", class: "dots" })],
  "rain-heavy": () => [CLOUD("M7 13.5h10a3.5 3.5 0 0 0 .4-7A5.5 5.5 0 0 0 6.6 7.6 3 3 0 0 0 7 13.5z"),
    svg("path", { d: "M7.5 16l-1.5 5M11 16l-1.5 5M14.5 16l-1.5 5M18 16l-1.5 5", class: "heavy" })],
  rain: () => [CLOUD("M7 14.5h10a3.5 3.5 0 0 0 .4-7A5.5 5.5 0 0 0 6.6 8.6 3 3 0 0 0 7 14.5z"),
    svg("path", { d: "M8.5 17.5l-1 3M12.5 17.5l-1 3M16.5 17.5l-1 3" })],
  storm: () => [CLOUD("M7 14.5h10a3.5 3.5 0 0 0 .4-7A5.5 5.5 0 0 0 6.6 8.6 3 3 0 0 0 7 14.5z"),
    svg("path", { d: "M12.5 15.5l-2 3.5h3l-2 3.5" })],
  fog: () => [svg("path", { d: "M4 8h16M3 12h18M5 16h14M8 20h8" })],
};
const skyIcon = sky => svg("svg", { class: "sky-icon", viewBox: "0 0 24 24", "aria-hidden": "true" }, SKY_ICONS[skyKind(sky)]());

const state = { date: null, hours: [], sky: {}, selected: null, open: new Set(), lastLoad: 0, loading: false };

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $("refresh").disabled = true;
  $("updated").textContent = "Updating…";
  const date = zonedParts(Date.now(), spot.timeZone).date;
  try {
    const { data, sources } = await loadAll(spot, date);
    if (date !== state.date) state.selected = null; // a new day starts back at “now”
    state.date = date;
    state.sky = data.sky ?? {};
    state.hours = [];
    for (let hour = spot.firstHour; hour <= spot.lastHour; hour++) {
      state.hours.push(assessHour(hour, zonedToMs(`${date} ${hour}:00`, spot.timeZone), data, spot));
    }
    state.lastLoad = Date.now();
    renderDay(data, sources);
    renderHour();
  } finally {
    state.loading = false;
    $("refresh").disabled = false;
  }
}

// Where “now” falls in today’s window: the current hour, or the nearest end of it.
function nowHour() {
  const now = zonedParts(Date.now(), spot.timeZone);
  if (now.date !== state.date) return null;
  return Math.min(spot.lastHour, Math.max(spot.firstHour, now.hour));
}
function isPast(hour) {
  const now = zonedParts(Date.now(), spot.timeZone);
  return now.date === state.date && hour < now.hour;
}

function renderDay(data, sources) {
  const stale = sources.filter(s => s.stale);
  $("updated").textContent = stale.length
    ? `Partly offline · ${clock(Math.min(...stale.map(s => s.fetchedAt)))}`
    : `Updated ${clock(Date.now())}`;

  $("summary").textContent = summarizeDay(state.hours);

  renderAdvisories(data.alerts);
}

// NWS advisories in force at some point in today’s window, water-relevant ones only.
// A heads-up below the factors; they don’t change the rating.
function renderAdvisories(alerts) {
  const dayStart = zonedToMs(`${state.date} ${spot.firstHour}:00`, spot.timeZone);
  const dayEnd = zonedToMs(`${state.date} ${spot.lastHour + 1}:00`, spot.timeZone);
  const today = waterAdvisories(alerts).filter(a => a.onsetMs < dayEnd && (!a.endsMs || a.endsMs > dayStart));
  const name = el("p", { class: "name" }, el("span", {}, "NWS advisories"),
    today.length ? el("span", {}, `${today.length} active`) : null);
  if (!alerts) {
    $("advisories").replaceChildren(name, el("p", { class: "value" }, "Unavailable"),
      el("p", { class: "note" }, "NWS advisories didn’t load."));
  } else if (!today.length) {
    $("advisories").replaceChildren(name, el("p", { class: "value" }, "None"));
  } else {
    $("advisories").replaceChildren(name, el("details", {},
      el("summary", {}, advisorySummary(today)),
      today.map(a => el("div", { class: "advisory" },
        el("p", { class: "advisory-name" }, sentenceCase(a.event)),
        a.endsMs ? el("p", { class: "advisory-when" }, `Until ${dayAndHour(a.endsMs)}`) : null,
        advisoryParagraphs(a.description).map(p => el("p", { class: "note" }, p))))));
  }
}

// “Coastal Flood Advisory” → “Coastal flood advisory”
const sentenceCase = s => s.charAt(0) + s.slice(1).toLowerCase();

// Hero, strip selection and factor cards for the selected hour.
function renderHour() {
  const current = nowHour();
  const selected = state.selected ?? current ?? spot.firstHour;
  const r = state.hours.find(h => h.hour === selected);
  const isNow = h => h === current && !isPast(h);

  $("hero").dataset.level = r.overall.level;
  $("hero-when").textContent = `Risk · ${isNow(selected) ? `Now, ${hourLabel(selected)}` : hourLabel(selected)}`;
  $("hero-level").textContent = LABELS[r.overall.level];
  const sky = state.sky[selected];
  $("hero-sky").replaceChildren(...(sky ? [skyIcon(sky), el("span", {}, skyLine(sky))] : []));

  $("sky-row").replaceChildren(...state.hours.map(h => el("span", { class: isPast(h.hour) ? "past" : null },
    state.sky[h.hour] ? skyIcon(state.sky[h.hour]) : null)));

  $("strip").style.setProperty("--hours", state.hours.length);
  $("sky-row").style.setProperty("--hours", state.hours.length);
  $("strip").replaceChildren(...state.hours.map(h => {
    const label = hourLabel(h.hour);
    const button = el("button", {
      type: "button", "data-level": h.overall.level, "aria-pressed": String(h.hour === selected),
      "aria-label": [label, LABELS[h.overall.level], state.sky[h.hour]?.text].filter(Boolean).join(", "),
      class: [isNow(h.hour) ? "now" : "", isPast(h.hour) ? "past" : ""].join(" ").trim() || null,
    },
      el("span", { class: "bar", "aria-hidden": "true" }),
      el("span", { class: "label", "aria-hidden": "true" }, label.split(" ")[0]));
    // Keyboard selection; pointer taps and drags go through the strip’s own handlers.
    button.addEventListener("click", e => { if (e.detail === 0) select(h.hour); });
    return button;
  }));

  $("factors").replaceChildren(...FACTORS.map(({ key, name, curve }, i) => {
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
      open ? dayCurve(key, selected) : null,
      f.notes.map(n => el("p", { class: "note" }, n)));
    card.querySelector(".expand")?.addEventListener("click", () => {
      state.open.has(key) ? state.open.delete(key) : state.open.add(key);
      renderHour();
    });
    return card;
  }));
}

function select(hour) {
  if (hour === (state.selected ?? nowHour() ?? spot.firstHour)) return;
  state.selected = hour;
  renderHour();
}

// The day’s values for one factor: a line through the hours, dashed lines at the
// caution and high thresholds with their numbers at the right end, and a dot at the
// selected hour in its rating’s color.
function dayCurve(key, selected) {
  const W = 300, H = 126, plotW = W - 34, top = 12, bottom = H - 22;
  const points = state.hours.map(h => ({ hour: h.hour, f: h.factors[key] }));
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

// Touch or click the strip and drag along it to scan the hours. Vertical drags still
// scroll the page (touch-action: pan-y in app.css).
{
  const strip = $("strip");
  let dragging = false;
  const pick = e => {
    const box = strip.getBoundingClientRect();
    const i = Math.floor(((e.clientX - box.left) / box.width) * state.hours.length);
    const h = state.hours[Math.min(state.hours.length - 1, Math.max(0, i))];
    if (h) select(h.hour);
  };
  strip.addEventListener("pointerdown", e => {
    if (e.button !== 0 || !state.hours.length) return;
    dragging = true;
    pick(e);
    strip.setPointerCapture(e.pointerId);
  });
  strip.addEventListener("pointermove", e => { if (dragging) pick(e); });
  for (const end of ["pointerup", "pointercancel"]) strip.addEventListener(end, () => { dragging = false; });
}

$("refresh").addEventListener("click", refresh);
// Coming back to the app after a while (or the next morning) loads fresh data.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - state.lastLoad > REFRESH_AFTER_MS) refresh();
});
refresh();
