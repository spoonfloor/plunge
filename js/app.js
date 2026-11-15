// Offline support (see sw.js). Browsers without service workers just skip it.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

import spot from "./spots/crissy-east.js";
import { loadAll } from "./sources.js";
import { assessHour, summarizeDay } from "./model.js";
import { hourLabel, zonedParts, zonedToMs } from "./time.js";

const LABELS = { low: "Low", caution: "Caution", high: "High", unknown: "No rating" };
const FACTORS = [
  ["current", "Current"], ["waves", "Waves"], ["wind", "Wind"],
  ["waterTemp", "Water temperature"], ["tide", "Tide"],
];
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

const state = { date: null, hours: [], selected: null, lastLoad: 0, loading: false };

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

  const dayStart = zonedToMs(`${state.date} ${spot.firstHour}:00`, spot.timeZone);
  const dayEnd = zonedToMs(`${state.date} ${spot.lastHour + 1}:00`, spot.timeZone);
  const alerts = (data.alerts ?? []).filter(a => a.onsetMs < dayEnd && (!a.endsMs || a.endsMs > dayStart));
  $("alerts-more").hidden = !alerts.length;
  $("alerts-title").textContent = alerts.length === 1 ? `NWS ${alerts[0].event}` : `${alerts.length} NWS alerts`;
  $("alerts").replaceChildren(...alerts.map(a => el("div", { class: "alert" },
    alerts.length > 1 ? el("p", {}, el("strong", {}, a.event)) : null,
    el("p", {}, `${a.endsMs ? `Until ${dayAndHour(a.endsMs)}. ` : ""}Covers ${a.areas}.`),
    el("p", {}, "A regional warning, shown for comparison. The ratings above are for this beach."))));
}

// Hero, strip selection and factor cards for the selected hour.
function renderHour() {
  const current = nowHour();
  const selected = state.selected ?? current ?? spot.firstHour;
  const r = state.hours.find(h => h.hour === selected);

  $("hero").dataset.level = r.overall.level;
  $("hero-when").textContent = selected === current && !isPast(selected) ? `Now · ${hourLabel(selected)}` : hourLabel(selected);
  $("hero-level").textContent = LABELS[r.overall.level];
  $("hero-why").textContent = r.overall.why;

  $("strip").style.setProperty("--hours", state.hours.length);
  $("strip").replaceChildren(...state.hours.map(h => {
    const label = hourLabel(h.hour);
    const button = el("button", {
      type: "button", "data-level": h.overall.level, "aria-pressed": String(h.hour === selected),
      "aria-label": `${label}, ${LABELS[h.overall.level]}`,
      class: [h.hour === current && !isPast(h.hour) ? "now" : "", isPast(h.hour) ? "past" : ""].join(" ").trim() || null,
    },
      el("span", { class: "bar", "aria-hidden": "true" }),
      el("span", { class: "label", "aria-hidden": "true" }, label.split(" ")[0]));
    button.addEventListener("click", () => { state.selected = h.hour; renderHour(); });
    return button;
  }));

  $("factors").replaceChildren(...FACTORS.map(([key, name]) => {
    const f = r.factors[key];
    const rated = f.level in LABELS && f.level !== "unknown";
    return el("li", { "data-level": f.level },
      el("p", { class: "name" }, el("span", {}, name), rated ? el("span", { class: "rating" }, LABELS[f.level]) : null),
      el("p", { class: "value" }, f.value.replace(/ at the beach$/, "")),
      el("p", { class: "why" }, f.why));
  }));
}

$("refresh").addEventListener("click", refresh);
// Coming back to the app after a while (or the next morning) loads fresh data.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - state.lastLoad > REFRESH_AFTER_MS) refresh();
});
refresh();
