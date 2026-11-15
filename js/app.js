// Offline support (see sw.js). Browsers without service workers just skip it.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

import spot from "./spots/crissy-east.js";
import { loadAll } from "./sources.js";
import { assessHour } from "./model.js";
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

let lastLoad = 0;
let loading = false;

async function refresh() {
  if (loading) return;
  loading = true;
  $("refresh").disabled = true;
  $("updated").textContent = "Updating…";
  const date = zonedParts(Date.now(), spot.timeZone).date;
  try {
    const { data, sources } = await loadAll(spot, date);
    render(date, data, sources);
    lastLoad = Date.now();
  } finally {
    loading = false;
    $("refresh").disabled = false;
  }
}

function render(date, data, sources) {
  const now = zonedParts(Date.now(), spot.timeZone);
  const [y, m, d] = date.split("-").map(Number);
  $("date").textContent = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" })
    .format(Date.UTC(y, m - 1, d)) + ` · ${spot.name}`;

  const stale = sources.filter(s => s.stale);
  $("updated").textContent = stale.length
    ? `Partly offline · ${clock(Math.min(...stale.map(s => s.fetchedAt)))}`
    : `Updated ${clock(Date.now())}`;

  const dayStart = zonedToMs(`${date} ${spot.firstHour}:00`, spot.timeZone);
  const dayEnd = zonedToMs(`${date} ${spot.lastHour + 1}:00`, spot.timeZone);
  $("alerts").replaceChildren(...(data.alerts ?? [])
    .filter(a => a.onsetMs < dayEnd && (!a.endsMs || a.endsMs > dayStart))
    .map(a => el("div", { class: "alert" },
      el("strong", {}, `NWS ${a.event}`),
      el("p", {}, `${a.endsMs ? `Until ${dayAndHour(a.endsMs)}. ` : ""}Covers ${a.areas}.`),
      el("p", {}, "A regional warning, shown for comparison. The ratings below are for this beach."))));

  // Keep rows the person opened open across refreshes; first time, open the current hour.
  const wasOpen = new Set([...document.querySelectorAll("#hours details[open]")].map(x => Number(x.dataset.hour)));
  const firstRender = !$("hours").children.length;

  const rows = [];
  for (let hour = spot.firstHour; hour <= spot.lastHour; hour++) {
    const r = assessHour(hour, zonedToMs(`${date} ${hour}:00`, spot.timeZone), data, spot);
    const isNow = now.date === date && now.hour === hour;
    const isPast = now.date === date && hour < now.hour;
    const open = wasOpen.has(hour) || (firstRender && isNow);
    const glance = ["current", "waves", "wind"].map(k => r.factors[k])
      .map(f => f.level === "unknown" ? "–" : f.value.replace(/ at the beach$/, "")).join(" · ");
    rows.push(el("li", { class: isPast ? "past" : null },
      el("details", { "data-hour": hour, open },
        el("summary", {},
          el("span", { class: "time" }, isNow ? el("small", {}, "Now") : null, hourLabel(hour)),
          el("span", { class: "chip", "data-level": r.overall.level }, LABELS[r.overall.level]),
          el("span", { class: "glance" }, glance)),
        el("div", { class: "detail" },
          el("p", {}, r.overall.why),
          el("ul", { class: "factors" }, FACTORS.map(([key, name]) => {
            const f = r.factors[key];
            return el("li", { "data-level": f.level },
              el("span", { class: "dot", "aria-hidden": "true" }),
              el("div", {},
                el("div", { class: "head" },
                  el("span", {}, `${name}${f.level in LABELS && f.level !== "unknown" ? ` · ${LABELS[f.level]}` : ""}`),
                  el("span", {}, f.value)),
                el("p", {}, f.why)));
          }))))));
  }
  $("hours").replaceChildren(...rows);

  $("sources").replaceChildren(...sources.map(s => el("li", {},
    s.link ? el("a", { href: s.link, target: "_blank", rel: "noopener" }, s.label) : s.label,
    s.error && !s.stale ? el("span", { class: "problem" }, ` · Unavailable: ${s.error}`)
      : s.stale ? el("span", { class: "problem" }, ` · Couldn’t update; showing copy from ${clock(s.fetchedAt)}`)
      : ` · ${clock(s.fetchedAt)}`)));
}

$("water-quality").href = spot.links.waterQuality;
$("water-quality").target = "_blank";
$("refresh").addEventListener("click", refresh);
// Coming back to the app after a while (or the next morning) loads fresh data.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastLoad > REFRESH_AFTER_MS) refresh();
});
refresh();
