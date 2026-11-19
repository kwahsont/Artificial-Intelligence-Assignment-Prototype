/* UTP Cafeteria Batch Advisor - dashboard logic.
 *
 * Data sources
 *  - data/dashboard_data.js    trained decision tree + survey summary (built by src/train_model.py)
 *  - data/academic_calendar.js UTP semester periods + public holidays printed in the UTP calendar
 *  - data/public_holidays.js   Perak public holidays pulled by src/update_holidays.py
 *                              (refreshed weekly by a GitHub Action)
 *  - Open-Meteo APIs          live hourly weather + air-quality (haze) forecast for UTP,
 *                              re-fetched every 10 minutes while the page is open
 *
 * The decision tree trained in Python is walked node-by-node here, so the browser
 * gives exactly the same prediction as the scikit-learn model.
 */
(function () {
  "use strict";
  const D = window.DASHBOARD_DATA;
  const CAL = window.ACADEMIC_CALENDAR || { periods: [], public_holidays: [] };
  const PH = window.PUBLIC_HOLIDAYS || { holidays: [] };
  // One holiday list: UTP-calendar holidays + the pulled Perak gazette (a date in either counts)
  const HOLIDAYS = new Map();
  (CAL.public_holidays || []).forEach((h) => HOLIDAYS.set(h.date, { date: h.date, name: h.name, src: "UTP calendar" }));
  (PH.holidays || []).forEach((h) => {
    const e = HOLIDAYS.get(h.date);
    if (e) e.src = "UTP calendar + gazette";
    else HOLIDAYS.set(h.date, { date: h.date, name: h.name, src: h.scope === "Perak" ? "Perak gazette" : "national gazette" });
  });
  const HOLIDAY_LIST = [...HOLIDAYS.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const holidayOn = (iso) => HOLIDAYS.get(iso);
  if (!D) { document.body.innerHTML = "<p style='padding:40px;color:#fff'>dashboard_data.js missing - run <code>python src/run_all.py</code>.</p>"; return; }

  const S = D.survey, M = S.multipliers, CFG = D.settings, TREE = D.tree;
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 0) => Number(n).toLocaleString("en-MY", { maximumFractionDigits: d, minimumFractionDigits: d });

  // Theme palettes for chart colours (CSS handles the rest via variables)
  const THEMES = {
    dark: { colors: { Low: "#34d399", Medium: "#fbbf24", High: "#f87171", brand: "#38bdf8", teal: "#2dd4bf", grey: "#475569" },
      grid: "rgba(148,163,184,.10)", text: "#8b9ab0", tipBg: "#0b1220", tipBorder: "rgba(148,163,184,.25)", tipText: "#e6edf7",
      bar: "#2a3547", line: "rgba(226,232,240,.55)", marker: "rgba(255,255,255,.75)", meta: "#070b14" },
    light: { colors: { Low: "#059669", Medium: "#d97706", High: "#dc2626", brand: "#0284c7", teal: "#0d9488", grey: "#94a3b8" },
      grid: "rgba(15,23,42,.08)", text: "#56657a", tipBg: "#ffffff", tipBorder: "rgba(15,23,42,.15)", tipText: "#0f172a",
      bar: "#cbd5e1", line: "rgba(15,23,42,.45)", marker: "rgba(15,23,42,.65)", meta: "#eef2f8" },
  };
  let THEME = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  let TH = THEMES[THEME];
  const COLORS = { ...TH.colors };
  const SOFT = {};
  const setSoft = () => { for (const k of ["Low", "Medium", "High"]) SOFT[k] = COLORS[k] + "24"; };
  setSoft();
  const RANK = { Low: 0, Medium: 1, High: 2 };
  let GRID = TH.grid;
  const DAY_FULL = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
  const ICONS = { "Normal week": "📘", "Exam week": "📝", "Holiday / break": "🏖️", Clear: "☀️", "Heavy rain": "🌧️", Haze: "🌫️" };
  const SHORT = { "Normal week": "Normal", "Exam week": "Exam", "Holiday / break": "Holiday" };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* ------------------------------------------------------------ settings */
  const UTP = { lat: 4.385, lon: 100.979 };
  const RULES = { heavyRainMm: 1.0, heavyRainProb: 75, hazePm25: 35 };
  const REFRESH_MS = 10 * 60 * 1000;
  const OPEN = 7 * 60, CLOSE = 23 * 60, STEP = 30;
  // Meal periods (minutes since midnight). `meal` is what the model was trained on.
  const PERIODS = [
    { key: "breakfast", name: "Breakfast", icon: "☕", start: 420, end: 630, meal: "Dinner", surveyed: false, color: "#a78bfa" },
    { key: "prep", name: "Prep", icon: "🔪", start: 630, end: 660, meal: "Dinner", surveyed: false, color: "#64748b", gap: true },
    { key: "lunch", name: "Lunch", icon: "🍛", start: 660, end: 900, meal: "Lunch", surveyed: true, color: "#38bdf8" },
    { key: "tea", name: "Tea", icon: "🫖", start: 900, end: 1020, meal: "Dinner", surveyed: false, color: "#2dd4bf" },
    { key: "dinner", name: "Dinner", icon: "🌙", start: 1020, end: 1260, meal: "Dinner", surveyed: true, color: "#818cf8" },
    { key: "supper", name: "Supper", icon: "🌃", start: 1260, end: 1381, meal: "Dinner", surveyed: false, color: "#f472b6" },
  ];

  /* --------------------------------------------------------- date / time */
  const klParts = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { iso: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
  };
  const todayKL = () => klParts().iso;
  const nowSlot = () => Math.min(CLOSE, Math.max(OPEN, Math.floor(klParts().min / STEP) * STEP));
  const toDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
  const toIso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const addDays = (iso, n) => { const d = toDate(iso); d.setDate(d.getDate() + n); return toIso(d); };
  const dowIdx = (iso) => (toDate(iso).getDay() + 6) % 7; // Mon = 0
  const shortDate = (iso) => { const d = toDate(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const fmtTime = (min) => {
    const h = Math.floor(min / 60) % 24, m = min % 60, ap = h < 12 ? "AM" : "PM", h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
  };
  const fmtHour = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
  const clock = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" });
  const periodOf = (min) => PERIODS.find((p) => p.start <= min && min < p.end) || PERIODS[PERIODS.length - 1];
  const isPast = (iso, min) => { const k = klParts(); return iso < k.iso || (iso === k.iso && min + STEP <= k.min); };

  /* --------------------------------------------------------------- state */
  const state = {
    date: todayKL(), time: nowSlot(), follow: true, live: true, ovCal: false, ovWx: false,
    day: "Wed", calendar: "Normal week", weather: "Clear", shortBreak: false, batch: 120, basis: "fuzzy",
  };
  const WX = { status: "loading", hours: {}, first: null, last: null, updated: null };

  /* ------------------------------------------------------------ calendar */
  function calendarFor(iso) {
    const inside = (CAL.periods || []).filter((x) => x.start <= iso && iso <= x.end);
    const p = inside.find((x) => x.type === "no_class") || inside.find((x) => x.type === "blended") || inside[0];
    const lectureWeek = () => {
      const t = inside.find((x) => x.type === "teaching");
      return t ? Math.floor((toDate(iso) - toDate(t.start)) / 864e5 / 7) + 1 : null;
    };
    const semLine = p ? p.semester + (p.estimated ? " · estimated dates" : "") : "";
    const hol = holidayOn(iso);
    if (hol) return { calendar: "Holiday / break", title: hol.name, sub: `Public holiday (${hol.src})` + (p ? ` · ${p.semester}` : ""), ico: "🏖️", holiday: true };
    if (!p) return { calendar: "Normal week", title: "No calendar entry", sub: "Treated as a normal week", ico: "📘" };
    if (p.type === "teaching") return { calendar: "Normal week", title: `Lecture week ${lectureWeek()}`, sub: semLine, ico: "📘" };
    if (p.type === "blended") return { calendar: "Normal week", title: `Lecture week ${lectureWeek()} · blended learning`, sub: semLine + " · some classes online", ico: "💻" };
    const map = { study: ["Exam week", "📚"], exam: ["Exam week", "📝"], break: ["Holiday / break", "🏖️"], orientation: ["Holiday / break", "🎒"], no_class: ["Holiday / break", "🏠"] };
    const [cal, ico] = map[p.type] || ["Normal week", "📘"];
    return { calendar: cal, title: p.name, sub: semLine, ico };
  }

  /* ------------------------------------------------------------- weather */
  async function fetchWeather() {
    const tz = "Asia%2FKuala_Lumpur";
    const fUrl = `https://api.open-meteo.com/v1/forecast?latitude=${UTP.lat}&longitude=${UTP.lon}` +
      `&hourly=precipitation,precipitation_probability,weather_code,temperature_2m&timezone=${tz}&forecast_days=16`;
    const aUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${UTP.lat}&longitude=${UTP.lon}` +
      `&hourly=pm2_5&timezone=${tz}&forecast_days=5`;
    const get = (u) => fetch(u, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
    const [f, a] = await Promise.allSettled([get(fUrl), get(aUrl)]);
    if (f.status !== "fulfilled") throw new Error("forecast unavailable");
    const hours = {};
    const H = f.value.hourly;
    H.time.forEach((t, i) => {
      const iso = t.slice(0, 10), h = +t.slice(11, 13);
      (hours[iso] = hours[iso] || [])[h] = {
        rain: H.precipitation[i] || 0, prob: H.precipitation_probability[i] || 0,
        code: H.weather_code[i] || 0, temp: H.temperature_2m[i], pm: null,
      };
    });
    if (a.status === "fulfilled") {
      const A = a.value.hourly;
      A.time.forEach((t, i) => {
        const slot = hours[t.slice(0, 10)] && hours[t.slice(0, 10)][+t.slice(11, 13)];
        if (slot && A.pm2_5[i] != null) slot.pm = A.pm2_5[i];
      });
    }
    const dates = Object.keys(hours).sort();
    return { hours, first: dates[0], last: dates[dates.length - 1], aq: a.status === "fulfilled" };
  }

  async function refreshWeather(reason) {
    const before = snapshot();
    const t0 = performance.now();
    elog("API", `${reason === "auto" ? "Auto-refresh (10 min)" : reason === "manual" ? "Manual refresh" : "Startup"}: GET <b>api.open-meteo.com/v1/forecast</b> + <b>air-quality-api.open-meteo.com</b> · UTP ${UTP.lat}, ${UTP.lon}`);
    try {
      const r = await fetchWeather();
      Object.assign(WX, { hours: r.hours, first: r.first, last: r.last, updated: Date.now(), status: r.aq ? "ok" : "partial" });
      const nHours = Object.values(r.hours).reduce((a, d) => a + d.filter(Boolean).length, 0);
      elog("API", `<span class="g">200 OK</span> · ${nHours} hourly rows (${shortDate(r.first)} – ${shortDate(r.last)}) · PM2.5 ${r.aq ? '<span class="g">ok</span>' : '<span class="y">unavailable</span>'} · ${Math.round(performance.now() - t0)} ms`);
      ENG.lastSig = ""; // force a fresh trace with the new data
      const el = $("updated");
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
      if (reason !== "initial") announceChanges(before, snapshot());
    } catch (e) {
      WX.status = WX.updated ? "stale" : "error";
      elog("API", `<span class="r">FAILED</span> (${e.message || e}) · ${WX.updated ? "keeping data from " + clock(WX.updated) : "falling back to manual weather"}`);
    }
    render();
  }

  function codeIcon(code) {
    if (code >= 95) return "⛈️";
    if (code >= 51) return "🌧️";
    if (code === 45 || code === 48) return "🌫️";
    if (code >= 2) return "⛅";
    return "☀️";
  }

  function weatherAt(iso, hour) {
    const s = WX.hours[iso] && WX.hours[iso][hour];
    if (!s) return null;
    let weather = "Clear";
    if (s.rain >= RULES.heavyRainMm || s.prob >= RULES.heavyRainProb) weather = "Heavy rain";
    else if (s.pm != null && s.pm >= RULES.hazePm25) weather = "Haze";
    const title = weather === "Heavy rain"
      ? (s.code >= 95 ? "Thunderstorm expected" : s.rain >= RULES.heavyRainMm ? "Heavy rain expected" : `Rain likely (${Math.round(s.prob)}% chance)`)
      : weather === "Haze" ? "Hazy air expected"
      : s.rain >= 0.1 ? "Light drizzle only" : (s.code >= 2 ? "Cloudy, dry" : "Fair and dry");
    const parts = [`${s.rain.toFixed(1)} mm rain`, `${Math.round(s.prob)}% chance`];
    if (s.temp != null) parts.push(`${Math.round(s.temp)}°C`);
    parts.push(s.pm != null ? `PM2.5 ${Math.round(s.pm)} µg/m³` : "no haze data");
    return { weather, title, sub: parts.join(" · "), ico: weather === "Haze" ? "🌫️" : codeIcon(s.code), rain: s.rain };
  }

  /* ------------------------------------------------------------ scenario */
  function scenarioFor(iso, min = state.time, opts = {}) {
    const period = periodOf(min);
    const hour = Math.floor(min / 60);
    const cal = calendarFor(iso);
    const wx = weatherAt(iso, hour);
    const base = { date: iso, min, hour, period, meal: period.meal, shortBreak: state.shortBreak, cal, wx };
    if (opts.forceLive) // auto analysis: always the real forecast + calendar, ignoring what-if overrides
      return { ...base, forceLive: true, day: CFG.days[dowIdx(iso)], calendar: cal.calendar, weather: wx ? wx.weather : "Clear", src: { cal: "live", wx: wx ? "live" : "fallback" } };
    if (!state.live) {
      return { ...base, day: opts.day || state.day, calendar: state.calendar, weather: state.weather, src: { cal: "manual", wx: "manual" } };
    }
    return {
      ...base, day: CFG.days[dowIdx(iso)],
      calendar: state.ovCal ? state.calendar : cal.calendar,
      weather: state.ovWx ? state.weather : (wx ? wx.weather : "Clear"),
      src: { cal: state.ovCal ? "manual" : "live", wx: state.ovWx ? "manual" : (wx ? "live" : "fallback") },
    };
  }

  /* --------------------------------------------------------------- model */
  function encode(s) {
    return {
      is_friday: +(s.day === "Fri"),
      is_weekend: +(s.day === "Sat" || s.day === "Sun"),
      exam_week: +(s.calendar === "Exam week"),
      holiday: +(s.calendar === "Holiday / break"),
      heavy_rain: +(s.weather === "Heavy rain"),
      haze: +(s.weather === "Haze"),
      short_break: +s.shortBreak,
      is_lunch: +(s.meal === "Lunch"),
    };
  }

  // Same formula as src/build_dataset.py -> expected_demand()
  function demand(s) {
    const f = [];
    if (s.day === "Fri") f.push(["Friday", M.friday]);
    else if (s.day === "Sat" || s.day === "Sun") f.push(["Weekend", M.weekend]);
    if (s.calendar === "Exam week") f.push(["Exam week", M.exam_week]);
    else if (s.calendar === "Holiday / break") f.push(["Holiday / break", M.holiday]);
    if (s.weather === "Heavy rain") f.push(["Heavy rain", M.heavy_rain]);
    else if (s.weather === "Haze") f.push(["Haze", M.haze]);
    if (s.shortBreak && s.meal === "Lunch" && !["Sat", "Sun"].includes(s.day) && s.calendar !== "Holiday / break")
      f.push(["Short class breaks", M.short_break]);
    const raw = f.reduce((a, [, m]) => a * m, 1);
    return { value: Math.max(raw, CFG.demand_floor), raw, factors: f, floored: raw < CFG.demand_floor };
  }

  function predict(features) {
    const nodes = TREE.nodes, path = [];
    let i = 0;
    while (nodes[i].left !== -1) {
      const n = nodes[i], x = features[n.feature];
      path.push({ feature: n.feature, yes: !!x, node: i, samples: n.samples, gini: n.gini, threshold: n.threshold });
      i = x > n.threshold ? n.right : n.left;
    }
    const probs = nodes[i].probs;
    let best = 0;
    probs.forEach((p, k) => { if (p > probs[best]) best = k; });
    return { tier: TREE.classes[best], confidence: probs[best], path, leafSamples: nodes[i].samples, leaf: i, probs };
  }

  /* --------------------------------------------- fuzzy logic (Mamdani) */
  // Same membership functions, rules and inference steps as src/fuzzy_model.py
  const FZ = D.fuzzy;
  const trap = (x, [a, b, c, d]) => {
    const l = a === b ? 1 : Math.min(Math.max((x - a) / (b - a), 0), 1);
    const r = c === d ? 1 : Math.min(Math.max((d - x) / (d - c), 0), 1);
    return Math.min(l, r);
  };
  const FZ_U = Array.from({ length: 201 }, (_, i) => i * 0.5); // output universe 0..100

  function fuzzyInputs(sc) {
    // day demand = day + calendar + class breaks only (weather is handled by the fuzzy rain/air inputs)
    const dayDem = demand({ ...sc, weather: "Clear" }).value * 100;
    const raw = WX.hours[sc.date] && WX.hours[sc.date][sc.hour];
    const useLive = (sc.forceLive || (state.live && !state.ovWx)) && raw;
    const cat = FZ.category_values[sc.weather] || FZ.category_values.Clear;
    return {
      day_demand: dayDem,
      rain: useLive ? raw.rain : cat.rain,
      air: useLive ? (raw.pm != null ? raw.pm : cat.air) : cat.air,
      source: useLive ? "live forecast" : `${sc.weather.toLowerCase()} (typical values)`,
    };
  }

  function fuzzyInfer(x) {
    const mu = {};
    for (const k of Object.keys(FZ.inputs)) {
      mu[k] = {};
      for (const [s, p] of Object.entries(FZ.inputs[k].sets)) mu[k][s] = trap(Math.min(Math.max(x[k], FZ.inputs[k].range[0]), FZ.inputs[k].range[1]), p);
    }
    const agg = FZ_U.map(() => 0);
    const fired = [];
    for (const r of FZ.rules) {
      const w = Math.min(mu.day_demand[r.day_demand], mu.rain[r.rain], mu.air[r.air]);
      if (w <= 0) continue;
      const p = FZ.output.sets[r.then];
      FZ_U.forEach((u, i) => { agg[i] = Math.max(agg[i], Math.min(w, trap(u, p))); });
      fired.push({ ...r, strength: w });
    }
    const area = agg.reduce((a, b) => a + b, 0);
    const score = area > 0 ? FZ_U.reduce((s, u, i) => s + u * agg[i], 0) / area : 50;
    const tier = score < FZ.tier_cuts.Low ? "Low" : score < FZ.tier_cuts.Medium ? "Medium" : "High";
    const dem = Math.max(100 - score, CFG.demand_floor * 100);
    return { mu, agg, score, tier, demand: dem, fired: fired.sort((a, b) => b.strength - a.strength) };
  }

  const fuzzyFor = (sc) => { const x = fuzzyInputs(sc); return { x, ...fuzzyInfer(x) }; };
  // demand actually used for the batch size: fuzzy (smooth) or survey formula (crisp)
  const usedDemand = (dem, fz) => (state.basis === "fuzzy" ? fz.demand / 100 : dem.value);

  const tierAt = (iso, min) => {
    const sc = scenarioFor(iso, min), dem = demand(sc), fz = fuzzyFor(sc);
    return { sc, dem, fz, pred: predict(encode(sc)), used: usedDemand(dem, fz) };
  };

  function assumptions() {
    const v = (id, d) => { const x = parseFloat($(id).value); return isFinite(x) && x >= 0 ? x : d; };
    return { kg: v("a-kg", 0.35), rm: v("a-rm", 4), kwh: v("a-kwh", 0.4), warm: v("a-warm", 1.5), hrs: v("a-hrs", 2), co2: v("a-co2", 0.58) };
  }

  /* ------------------------------------------------- forecast change alerts */
  function snapshot() {
    if (!state.live) return null;
    const out = {};
    for (let h = OPEN / 60; h <= CLOSE / 60; h++) {
      const wx = weatherAt(state.date, h);
      out[h] = { wx: wx ? wx.weather : null, tier: tierAt(state.date, h * 60).pred.tier };
    }
    return out;
  }

  let toastTimer;
  function toast(title, body) {
    const t = $("toast");
    t.innerHTML = `<strong>${title}</strong>${body}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 8000);
  }

  function announceChanges(before, after) {
    if (!before || !after) return;
    const changed = Object.keys(after).map(Number).filter((h) => before[h] && before[h].wx && after[h].wx && before[h].wx !== after[h].wx);
    if (!changed.length) return;
    const selH = Math.floor(state.time / 60);
    const h = changed.includes(selH) ? selH : changed[0];
    const a = after[h], b = before[h];
    const what = a.wx === "Heavy rain" ? "rain now expected" : a.wx === "Haze" ? "haze now expected"
      : b.wx === "Heavy rain" ? "rain no longer expected" : "haze has cleared";
    const dir = RANK[a.tier] > RANK[b.tier] ? `risk raised to ${a.tier}` : RANK[a.tier] < RANK[b.tier] ? `risk lowered to ${a.tier}` : `risk stays ${a.tier}`;
    const more = changed.length > 1 ? ` (+${changed.length - 1} other hour${changed.length > 2 ? "s" : ""} changed)` : "";
    toast("Forecast changed", `${what[0].toUpperCase() + what.slice(1)} at ${fmtHour(h)} → ${dir}${more}.`);
    elog("API", `<span class="y">Forecast changed</span>: ${what} at ${fmtHour(h)} (${b.wx} → ${a.wx}) → ${dir}${more}`);
    changedHours = new Set(changed);
    setTimeout(() => { changedHours = new Set(); }, 3000);
  }
  let changedHours = new Set();

  /* ------------------------------------------------------------ controls */
  function buildControls() {
    setupDatePicker();
    const seg = (el, key, opts, ov) => opts.forEach((o) => {
      const b = document.createElement("button");
      b.className = "seg-btn"; b.type = "button"; b.dataset.val = o;
      b.innerHTML = `<span class="ico">${ICONS[o] || ""}</span><span>${SHORT[o] || o}</span>`;
      b.onclick = () => { state[key] = o; if (ov && state.live) state[ov] = true; render(); };
      $(el).appendChild(b);
    });
    seg("cal-seg", "calendar", CFG.calendar, "ovCal");
    seg("wx-seg", "weather", CFG.weather, "ovWx");
    document.querySelectorAll("#basis-seg .seg-btn").forEach((b) => b.onclick = () => { state.basis = b.dataset.val; render(); });

    // time scrubber: meal-period bands, hour icons, ticks
    const span = CLOSE - OPEN;
    const pos = (min) => ((min - OPEN) / span) * 100;
    $("bands").innerHTML = PERIODS.map((p) => {
      const end = Math.min(p.end, CLOSE);
      return `<div class="band${p.gap ? " gap" : ""}" data-key="${p.key}" style="--bc:${p.color};left:${pos(p.start)}%;width:calc(${pos(end) - pos(p.start)}% - 2px)" title="${p.name} ${fmtTime(p.start)} – ${fmtTime(end)}">${p.gap ? "" : `<span>${p.icon}</span><span class="bl">${p.name}</span>`}</div>`;
    }).join("");
    $("bands").querySelectorAll(".band").forEach((el) => el.onclick = () => {
      const p = PERIODS.find((x) => x.key === el.dataset.key);
      setTime(p.key === "lunch" ? 750 : p.key === "dinner" ? 1110 : p.start);
    });
    let icons = "", ticks = "";
    for (let h = OPEN / 60, k = 0; h <= CLOSE / 60; h++, k++) {
      icons += `<span class="hicon${k % 2 ? " odd" : ""}" data-h="${h}" style="left:${pos(h * 60)}%"></span>`;
      if (k % 2 === 0) ticks += `<span class="tick${k % 4 ? " odd" : ""}" style="left:${pos(h * 60)}%">${fmtHour(h).replace(" ", "").toLowerCase()}</span>`;
    }
    $("hour-icons").innerHTML = icons;
    $("hour-ticks").innerHTML = ticks;
    $("hour-icons").querySelectorAll(".hicon").forEach((el) => el.onclick = () => setTime(+el.dataset.h * 60));

    $("time").oninput = (e) => setTime(+e.target.value);
    $("now-btn").onclick = () => { state.date = todayKL(); state.time = nowSlot(); state.follow = true; state.ovCal = state.ovWx = false; render(); };
    $("refresh-btn").onclick = () => { $("updated").textContent = "Refreshing…"; refreshWeather("manual"); };

    $("today-btn").onclick = () => { if (state.live) pickDate(todayKL()); };
    $("live").onchange = (e) => {
      if (!e.target.checked) {
        const sc = scenarioFor(state.date);
        Object.assign(state, { day: sc.day, calendar: sc.calendar, weather: sc.weather });
      }
      state.live = e.target.checked; state.ovCal = state.ovWx = false;
      $("whatif").open = !state.live;
      render();
    };
    $("reset-live").onclick = () => { state.ovCal = state.ovWx = false; render(); };
    $("short-break").onchange = (e) => { state.shortBreak = e.target.checked; render(); };
    const setBatch = (v) => { state.batch = Math.max(1, Math.min(2000, Math.round(v) || 1)); render(); };
    $("batch-range").oninput = (e) => setBatch(+e.target.value);
    $("batch").oninput = (e) => setBatch(+e.target.value);
    ["a-kg", "a-rm", "a-kwh", "a-warm", "a-hrs", "a-co2"].forEach((id) => { $(id).oninput = render; });
    $("cafe").onchange = render;
  }

  /* --------------------------------------------------------- date picker */
  // A week strip (‹ week › + 7 day buttons) and a month calendar grouped into week rows,
  // colour-coded by the UTP academic calendar.
  const DP = { month: state.date.slice(0, 7), open: false };
  const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function calKind(iso) {
    const c = calendarFor(iso);
    if (c.holiday) return { kind: "hol", c };
    if (c.calendar === "Exam week") return { kind: "exam", c };
    if (c.calendar === "Holiday / break") return { kind: "brk", c };
    if (/Lecture week/.test(c.title)) return { kind: /blended/.test(c.title) ? "blend" : "lec", c };
    return { kind: "none", c };
  }

  // what to call a week: its lecture-week number, otherwise the main calendar period
  function weekLabel(monIso) {
    const days = Array.from({ length: 7 }, (_, k) => calendarFor(addDays(monIso, k)));
    const lec = days.map((c) => c.title.match(/Lecture week (\d+)/)).find(Boolean);
    if (lec) return { long: `Lecture week ${lec[1]}`, short: `W${lec[1]}` };
    const periods = [...new Set(days.slice(0, 5).filter((c) => c.title !== "No calendar entry" && !c.holiday).map((c) => c.title))];
    const main = days.slice(0, 5).find((c) => c.title === periods[0]) || days[2];
    const short = main.calendar === "Exam week" ? (/Study/.test(main.title) ? "Study" : "Exam") : main.calendar === "Holiday / break" ? (/Orientation/.test(main.title) ? "Orient." : "Break") : "";
    const long = periods.length ? periods.slice(0, 2).join(" → ") : "Outside the semester";
    return { long, short };
  }

  function rangeLabel(monIso) {
    const a = toDate(monIso), b = toDate(addDays(monIso, 6));
    const left = a.getMonth() === b.getMonth() ? `${a.getDate()}` : `${a.getDate()} ${MONTHS[a.getMonth()]}`;
    return `${left} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  }

  function pickDate(iso) {
    state.date = iso; state.follow = false; state.ovCal = state.ovWx = false;
    DP.month = iso.slice(0, 7);
    closeMonth();
    render();
  }

  function setupDatePicker() {
    $("wk-prev").onclick = () => { if (state.live) pickDate(addDays(state.date, -7)); };
    $("wk-next").onclick = () => { if (state.live) pickDate(addDays(state.date, 7)); };
    $("week-strip").onclick = (e) => {
      const b = e.target.closest(".wpill");
      if (!b) return;
      if (state.live) pickDate(b.dataset.iso);
      else { state.day = b.dataset.day; render(); }
    };
    $("dp-open").onclick = () => (DP.open ? closeMonth() : openMonth());
    // the calendar lives at the top level of the page so it can't be clipped or
    // re-anchored by the blurred card around the date picker
    document.body.appendChild($("dp-pop"));
    window.addEventListener("resize", () => { if (DP.open) placeMonth(); });
    $("dp-pop").onclick = (e) => {
      e.stopPropagation(); // clicks inside the calendar never count as "outside"
      const nav = e.target.closest("[data-mnav]");
      if (nav) { const [y, m] = DP.month.split("-").map(Number); const d = new Date(y, m - 1 + +nav.dataset.mnav, 1); DP.month = toIso(d).slice(0, 7); renderMonth(); return; }
      const cell = e.target.closest(".mcell");
      if (cell) pickDate(cell.dataset.iso);
      if (e.target.closest("[data-mtoday]")) pickDate(todayKL());
      if (e.target.closest("[data-mclose]")) closeMonth();
    };
    document.addEventListener("click", (e) => { if (DP.open && !e.target.closest("#datepick, #dp-pop")) closeMonth(); });
    document.addEventListener("keydown", (e) => { if (DP.open && e.key === "Escape") { closeMonth(); $("dp-open").focus(); } });
  }

  function openMonth() {
    if (!state.live) return;
    DP.open = true; DP.month = state.date.slice(0, 7);
    $("dp-pop").hidden = false; $("dp-open").setAttribute("aria-expanded", "true");
    renderMonth();
    placeMonth();
  }
  // desktop: open just under the week title; phones: CSS turns it into a bottom sheet
  function placeMonth() {
    const pop = $("dp-pop");
    if (window.matchMedia("(max-width: 760px)").matches) { pop.style.top = pop.style.left = ""; return; }
    const r = $("datepick").getBoundingClientRect(), head = document.querySelector(".dp-head").getBoundingClientRect();
    pop.style.top = `${Math.round(head.bottom + window.scrollY + 6)}px`;
    pop.style.left = `${Math.round(Math.max(12, Math.min(r.left + window.scrollX, window.innerWidth - 372)))}px`;
  }
  function closeMonth() {
    DP.open = false;
    $("dp-pop").hidden = true; $("dp-open").setAttribute("aria-expanded", "false");
  }

  const KIND_ICON = { exam: "📝", brk: "🏖️", hol: "🎉", blend: "💻" };

  function renderDatePicker(sc) {
    const live = state.live, today = todayKL();
    const mon = addDays(state.date, -dowIdx(state.date));
    const wl = weekLabel(mon);
    $("dp-week").textContent = live ? wl.long : "Manual mode";
    $("dp-range").textContent = live ? rangeLabel(mon) : "pick a day of the week";
    $("wk-prev").disabled = $("wk-next").disabled = !live;
    $("dp-open").disabled = !live;
    const h = Math.floor(state.time / 60);
    $("week-strip").innerHTML = CFG.days.map((d, k) => {
      const iso = addDays(mon, k), { kind, c } = calKind(iso);
      const wx = weatherAt(iso, h);
      const sel = live ? iso === state.date : d === state.day;
      const mark = live ? (wx ? wx.ico : KIND_ICON[kind] || "·") : "";
      const tip = live ? `${DAY_FULL[d]} ${shortDate(iso)} · ${c.title}${wx ? " · " + wx.title + " at " + fmtHour(h) : ""}` : DAY_FULL[d];
      return `<button type="button" class="wpill k-${live ? kind : "none"}${sel ? " sel" : ""}${live && iso === today ? " today" : ""}" data-iso="${iso}" data-day="${d}" title="${tip}" aria-pressed="${sel}">
        <span class="wd">${d}</span>${live ? `<span class="dn">${toDate(iso).getDate()}</span><span class="wm">${mark}</span>` : ""}</button>`;
    }).join("");
    if (DP.open) renderMonth();
  }

  function renderMonth() {
    const [y, m] = DP.month.split("-").map(Number);
    const first = `${DP.month}-01`, startMon = addDays(first, -dowIdx(first));
    const daysIn = new Date(y, m, 0).getDate(), rows = Math.ceil((dowIdx(first) + daysIn) / 7);
    const today = todayKL(), h = Math.floor(state.time / 60);
    let grid = `<div class="mrow mhead"><span class="mwk"></span>${CFG.days.map((d) => `<span>${d.slice(0, 2)}</span>`).join("")}</div>`;
    for (let r = 0; r < rows; r++) {
      const mon = addDays(startMon, r * 7), wl = weekLabel(mon);
      grid += `<div class="mrow"><span class="mwk" title="${wl.long}">${wl.short}</span>`;
      for (let k = 0; k < 7; k++) {
        const iso = addDays(mon, k), dt = toDate(iso), { kind, c } = calKind(iso), wx = weatherAt(iso, h);
        const cls = ["mcell", "k-" + kind, dt.getMonth() !== m - 1 ? "out" : "", iso === state.date ? "sel" : "", iso === today ? "today" : ""].join(" ");
        grid += `<button type="button" class="${cls}" data-iso="${iso}" title="${DAY_FULL[CFG.days[k]]} ${shortDate(iso)} · ${c.title}${wx ? " · " + wx.title : ""}">
          <span class="mn">${dt.getDate()}</span>${wx ? `<span class="mx">${wx.ico}</span>` : kind === "hol" ? '<span class="mx">🎉</span>' : ""}</button>`;
      }
      grid += "</div>";
    }
    $("dp-pop").innerHTML = `
      <div class="mhd"><button type="button" class="dp-nav" data-mnav="-1" aria-label="Previous month">‹</button>
        <strong>${MONTHS_LONG[m - 1]} ${y}</strong>
        <button type="button" class="dp-nav" data-mnav="1" aria-label="Next month">›</button></div>
      <div class="mgrid">${grid}</div>
      <div class="mlegend">
        <span><i class="k-lec"></i>Lectures</span><span><i class="k-exam"></i>Study / exams</span>
        <span><i class="k-brk"></i>Break / no class</span><span><i class="k-hol"></i>Public holiday</span>
        <span>☀️ forecast available</span></div>
      <div class="mfoot"><button type="button" class="ghost-btn" data-mtoday>Go to today</button><button type="button" class="ghost-btn" data-mclose>Close</button></div>`;
  }

  function setTime(min) {
    if (PLAY.on) stopPlay(); // the user took over the time slider
    state.time = Math.min(CLOSE, Math.max(OPEN, min));
    state.follow = false;
    render();
  }

  function badge(el, src) {
    const b = $(el);
    if (!state.live || !src) { b.textContent = ""; b.className = "badge"; return; }
    const map = { live: ["LIVE", "live"], manual: ["MANUAL", "manual"], fallback: ["NO FORECAST", "manual"] };
    const [t, c] = map[src] || ["", ""];
    b.textContent = t; b.className = "badge " + c;
  }

  function syncControls(sc) {
    renderDatePicker(sc);
    [["cal-seg", sc.calendar], ["wx-seg", sc.weather], ["basis-seg", state.basis]].forEach(([el, v]) =>
      document.querySelectorAll(`#${el} .seg-btn`).forEach((b) => b.classList.toggle("active", b.dataset.val === v)));
    $("today-btn").disabled = !state.live || state.date === todayKL();
    $("short-break").checked = state.shortBreak;
    if (+$("batch").value !== state.batch) $("batch").value = state.batch;
    $("batch-range").value = Math.min(400, state.batch);
    badge("b-day", state.live ? "live" : "");
    badge("b-cal", sc.src.cal);
    badge("b-wx", sc.src.wx);
    $("reset-live").hidden = !(state.live && (state.ovCal || state.ovWx));
    renderAutoBox(sc);
  }

  /* ----------------------------------- auto-detected inputs (left panel) */
  const calMult = (cal) => (cal === "Exam week" ? M.exam_week : cal === "Holiday / break" ? M.holiday : 1);
  const dayMult = (d) => (d === "Fri" ? M.friday : d === "Sat" || d === "Sun" ? M.weekend : 1);
  const xf = (m) => (m === 1 ? "normal footfall" : `footfall ×${m.toFixed(2)}`);

  function renderAutoBox(sc) {
    const live = scenarioFor(state.date, state.time, { forceLive: true });
    const c = live.cal, wx = live.wx, d = live.day;
    const wxSub = wx ? `${wx.weather} · ${wx.sub}`
      : WX.status === "loading" ? "Fetching the Open-Meteo forecast…"
      : WX.last && state.date > WX.last ? `Beyond the 16-day forecast (ends ${shortDate(WX.last)}) · assumed clear`
      : "Forecast unavailable · assumed clear";
    const wxM = wx ? (wx.weather === "Heavy rain" ? M.heavy_rain : wx.weather === "Haze" ? M.haze : 1) : 1;
    const rows = [
      ["📅", `${DAY_FULL[d]}${d === "Sat" || d === "Sun" ? " · weekend" : ""}`, xf(dayMult(d))],
      [c.ico, c.title, `${c.calendar} · ${xf(calMult(c.calendar))}${c.sub ? " · " + c.sub : ""}`],
      [wx ? wx.ico : "🛰️", wx ? `${wx.title} at ${fmtHour(live.hour)}` : "No hourly forecast", wx ? `${wxSub} · ${xf(wxM)}` : wxSub],
    ];
    const over = !state.live || state.ovCal || state.ovWx;
    $("auto-box").innerHTML = rows.map(([i, t, s]) => `<div class="auto-row"><span class="auto-ico">${i}</span><span><b>${t}</b><small>${s}</small></span></div>`).join("") +
      (over ? `<div class="auto-warn">⚠ ${state.live ? "A what-if override is on" : "Live data is off"}: the prediction uses the values you set below, not these.</div>` : "");
    if (over) $("whatif").open = true;
  }

  /* ------------------------------------ automatic forecast & calendar analysis */
  const REP_MIN = { breakfast: 480, lunch: 750, tea: 960, dinner: 1110, supper: 1290 };
  const hourRanges = (hs) => {
    const r = [];
    hs.forEach((h) => { const l = r[r.length - 1]; if (l && l[1] === h - 1) l[1] = h; else r.push([h, h]); });
    return r.map(([a, b]) => `${fmtHour(a)}–${fmtHour(b + 1)}`).join(", ");
  };
  const dayName = (iso) => `${CFG.days[dowIdx(iso)]} ${shortDate(iso)}`;
  const daysAway = (iso) => {
    const n = Math.round((toDate(iso) - toDate(todayKL())) / 864e5);
    return n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : n > 0 ? `in ${n} days` : `${-n} days ago`;
  };

  // rain / haze summary for every forecast hour inside one meal period
  function periodWeather(iso, p) {
    const day = WX.hours[iso];
    if (!day) return null;
    const sH = Math.floor(p.start / 60), eH = Math.ceil(Math.min(p.end, CLOSE) / 60) - 1;
    const out = { mm: 0, maxProb: 0, maxPm: null, wet: [], hazy: [], n: 0 };
    for (let h = sH; h <= eH; h++) {
      const s = day[h], w = weatherAt(iso, h);
      if (!s || !w) continue;
      out.n++; out.mm += s.rain; out.maxProb = Math.max(out.maxProb, s.prob);
      if (s.pm != null) out.maxPm = Math.max(out.maxPm || 0, s.pm);
      if (w.weather === "Heavy rain") out.wet.push(h); else if (w.weather === "Haze") out.hazy.push(h);
    }
    return out.n ? out : null;
  }

  function evalService(iso, min) {
    const sc = scenarioFor(iso, min, { forceLive: true }), dem = demand(sc), fz = fuzzyFor(sc);
    return { sc, min, pred: predict(encode(sc)), used: usedDemand(dem, fz) };
  }
  // every hour of a meal period: lowest / highest demand and the worst hour
  function serviceRange(iso, p) {
    const sH = Math.floor(p.start / 60), eH = Math.ceil(Math.min(p.end, CLOSE) / 60) - 1;
    let lo = null, hi = null;
    for (let h = sH; h <= eH; h++) {
      const e = evalService(iso, Math.max(p.start, h * 60));
      if (!lo || e.used < lo.used || (e.used === lo.used && RANK[e.pred.tier] > RANK[lo.pred.tier])) lo = e;
      if (!hi || e.used > hi.used) hi = e;
    }
    return { lo, hi };
  }
  const listDays = (arr, of) => (arr.length <= 3 ? arr.join(", ") : `${arr.length} of the next ${of} days`);

  let AN_SIG = "";
  function renderAnalysis() {
    const iso = state.date;
    const sig = [iso, todayKL(), WX.updated, WX.status, state.shortBreak, state.basis, state.batch].join("|");
    if (sig === AN_SIG) return;
    AN_SIG = sig;
    $("an-day").textContent = `${DAY_FULL[CFG.days[dowIdx(iso)]]} ${shortDate(iso)}`;

    // 1. this day, meal by meal
    $("an-meals").innerHTML = PERIODS.filter((p) => !p.gap).map((p) => {
      const w = periodWeather(iso, p), { lo, hi } = serviceRange(iso, p);
      const a = Math.round(lo.used * 100), b = Math.round(hi.used * 100);
      const pctTxt = a === b ? `${a}%` : `${a}–${b}%`;
      const worstAt = a === b ? "" : ` · lowest at ${fmtTime(lo.min).replace(":00", "")}`;
      let ico, verdict;
      if (!w) [ico, verdict] = ["·", WX.status === "loading" ? "Loading…" : "No forecast · assumed dry"];
      else if (w.wet.length) [ico, verdict] = ["🌧️", `${w.mm >= RULES.heavyRainMm ? "Heavy rain" : "Rain likely"} ${hourRanges(w.wet)}`];
      else if (w.hazy.length) [ico, verdict] = ["🌫️", `Haze ${hourRanges(w.hazy)}`];
      else if (w.mm >= 0.1) [ico, verdict] = ["🌦️", "Light showers only"];
      else [ico, verdict] = ["☀️", "Dry"];
      const detail = (w ? `${w.mm.toFixed(1)} mm · up to ${Math.round(w.maxProb)}% chance${w.maxPm != null ? ` · PM2.5 ≤ ${Math.round(w.maxPm)}` : ""}` : "") + worstAt;
      const sel = periodOf(state.time).key === p.key;
      return `<button type="button" class="an-meal${sel ? " sel" : ""}" data-min="${REP_MIN[p.key]}" style="--pc:${p.color}" title="Show ${p.name.toLowerCase()} in the advisor">
        <span class="an-p">${p.icon} ${p.name}<small>${fmtTime(p.start).replace(":00", "")}–${fmtTime(Math.min(p.end, CLOSE)).replace(":00", "")}</small></span>
        <span class="an-w">${ico} <b>${verdict}</b>${detail ? `<small>${detail}</small>` : ""}</span>
        <span class="an-r" title="Expected demand across the service (% of a normal weekday) · worst-hour risk"><span class="an-pct">${pctTxt}</span><span class="t t-${lo.pred.tier}">${lo.pred.tier}</span></span></button>`;
    }).join("");
    $("an-meals").querySelectorAll(".an-meal").forEach((b) => (b.onclick = () => setTime(+b.dataset.min)));

    // 2. headlines: calendar now / next change / next holiday / 7-day weather / riskiest service
    const heads = [];
    const c = calendarFor(iso);
    heads.push(["📘", `<b>${c.title}</b>: ${xf(calMult(c.calendar))}${c.calendar === "Exam week" ? " (students stay in to revise)" : c.calendar === "Holiday / break" ? " (most students leave campus)" : ""}.`]);

    const key = (cc) => (cc.holiday ? null : /^Lecture week/.test(cc.title) ? "Lectures" : cc.title);
    let base = null;
    for (let k = 0; k < 150; k++) {
      const d = addDays(iso, k), cc = calendarFor(d), kk = key(cc);
      if (kk == null) continue;
      if (base == null) { base = kk; continue; }
      if (kk !== base) {
        heads.push(["🗓️", `Next: <b>${cc.title}</b> from ${dayName(d)} (${daysAway(d)}) → ${xf(calMult(cc.calendar))}.`]);
        break;
      }
    }

    const hol = HOLIDAY_LIST.find((h) => h.date >= iso);
    if (hol) heads.push(["🏖️", hol.date === iso
      ? `<b>${hol.name}</b> is a public holiday (${hol.src}): ${xf(M.holiday)}.`
      : `Next public holiday: <b>${hol.name}</b>, ${dayName(hol.date)} (${daysAway(hol.date)}).`]);

    if (WX.last) {
      const L = PERIODS.find((p) => p.key === "lunch"), Dn = PERIODS.find((p) => p.key === "dinner");
      const wetL = [], wetD = [], hazy = [];
      let aqDays = 0, fcDays = 0;
      for (let k = 0; k < 7; k++) {
        const d = addDays(iso, k);
        if (!WX.hours[d]) continue;
        fcDays++;
        const l = periodWeather(d, L), n = periodWeather(d, Dn);
        if (l && l.wet.length) wetL.push(dayName(d));
        if (n && n.wet.length) wetD.push(dayName(d));
        const pms = WX.hours[d].filter((s) => s && s.pm != null);
        if (pms.length) { aqDays++; if (pms.some((s) => s.pm >= RULES.hazePm25)) hazy.push(dayName(d)); }
      }
      if (fcDays) {
        heads.push(["🌧️", wetL.length || wetD.length
          ? `Heavy rain forecast${wetL.length ? ` at lunch on <b>${listDays(wetL, fcDays)}</b>` : ""}${wetL.length && wetD.length ? ";" : ""}${wetD.length ? ` at dinner on <b>${listDays(wetD, fcDays)}</b>` : ""} → ${xf(M.heavy_rain)} in those hours.`
          : `No heavy rain forecast at lunch or dinner over the next ${fcDays} day${fcDays > 1 ? "s" : ""}.`]);
        if (aqDays) heads.push(["🌫️", hazy.length
          ? `Haze (PM2.5 ≥ ${RULES.hazePm25}) expected on <b>${listDays(hazy, aqDays)}</b> → ${xf(M.haze)}.`
          : `Air quality stays good (PM2.5 below ${RULES.hazePm25}) for the ${aqDays} day${aqDays > 1 ? "s" : ""} with air-quality data.`]);
      }
      let worst = null;
      for (let k = 0; k < 7; k++) {
        const d = addDays(iso, k);
        for (const p of [L, Dn]) {
          const { lo } = serviceRange(d, p);
          if (!worst || lo.used < worst.used) worst = { ...lo, d };
        }
      }
      if (worst) heads.push(["⚠️", worst.pred.tier === "Low"
        ? "Every lunch and dinner in the next 7 days looks <b>Low</b> risk: cook as usual."
        : `Riskiest service this week: <b>${dayName(worst.d)} ${periodOf(worst.min).name.toLowerCase()}</b> around ${fmtTime(worst.min).replace(":00", "")}, ${Math.round(worst.used * 100)}% of normal demand (<span class="t t-${worst.pred.tier}">${worst.pred.tier}</span>) → cook about ${Math.round(state.batch * worst.used)} of your usual ${state.batch}.`]);
      heads.push(["🛰️", iso > WX.last
        ? `This date is past the 16-day forecast (ends ${shortDate(WX.last)}), so weather is assumed clear.`
        : `Forecast runs to ${shortDate(WX.last)} (air quality about 5 days). Updated ${clock(WX.updated)}, refreshes every 10 min.`]);
    } else {
      heads.push(["🛰️", WX.status === "loading" ? "Loading the weather forecast…" : "Weather forecast unavailable: weather is assumed clear."]);
    }
    $("an-heads").innerHTML = heads.map(([i, t]) => `<li><span class="an-i">${i}</span><span>${t}</span></li>`).join("");
    const ph = PH.updated ? ` · holidays pulled ${PH.updated.slice(0, 10)}` : "";
    $("an-note").textContent = `Open-Meteo forecast · UTP academic calendar · Perak public holidays${ph}`;
  }

  /* -------------------------------------------------------------- render */
  let slotChart, dayChart;

  function render() {
    const sc = scenarioFor(state.date);
    syncControls(sc);
    const dem = demand(sc), pred = predict(encode(sc)), A = assumptions();
    const fz = fuzzyFor(sc), used = usedDemand(dem, fz);
    const tier = pred.tier, pct = Math.round(used * 100);
    document.documentElement.style.setProperty("--risk", COLORS[tier]);
    document.documentElement.style.setProperty("--risk-soft", SOFT[tier]);

    const rec = Math.round(state.batch * used);
    renderTime(sc, rec);
    renderLive(sc);
    renderAnalysis();
    document.querySelectorAll("#an-meals .an-meal").forEach((b) => b.classList.toggle("sel", periodOf(+b.dataset.min).key === sc.period.key));

    const when = state.live ? `${DAY_FULL[sc.day]} ${shortDate(sc.date)}` : DAY_FULL[sc.day];
    $("scenario-title").textContent = `${$("cafe").value} · ${when} · ${sc.period.name} (${fmtTime(sc.period.start)} – ${fmtTime(Math.min(sc.period.end, CLOSE))})`;
    $("risk-tier").textContent = tier;
    $("risk-msg").textContent = {
      Low: "Customer numbers should be close to a normal day. Cook as usual and keep the normal warmer schedule.",
      Medium: "Expect noticeably fewer customers. Cook a smaller first batch and top up only if it sells.",
      High: "Expect far fewer customers than usual. Cook a small first batch and cook more only when needed.",
    }[tier];
    const pn = $("period-note");
    pn.hidden = sc.period.surveyed;
    pn.textContent = `⚠ ${sc.period.name} wasn't covered by the student survey, so this uses dinner-style rules. Treat it as a rough guide.`;
    $("demand-pct").textContent = pct;
    const arc = 157.1;
    $("gauge-fg").style.strokeDasharray = arc;
    $("gauge-fg").style.strokeDashoffset = arc * (1 - Math.min(used, 1));
    document.querySelector(".gauge-lbl").textContent = `of normal-day demand · ${state.basis === "fuzzy" ? "fuzzy logic" : "survey formula"}`;
    $("v-tree").innerHTML = `🌳 Decision tree: <b style="--vc:${COLORS[tier]}">${tier}</b> (${Math.round(pred.confidence * 100)}% sure)`;
    $("v-fuzzy").innerHTML = `〰️ Fuzzy logic: <b style="--vc:${COLORS[fz.tier]}">${Math.round(fz.score)}/100 · ${fz.tier}</b>`;
    $("conf-bar").style.width = Math.round(pred.confidence * 100) + "%";
    $("conf-pct").textContent = Math.round(pred.confidence * 100) + "%";

    const lo = Math.round(rec * 0.9), hi = Math.min(state.batch, Math.round(rec * 1.1));
    const saved = state.batch - rec;
    const warmerKwh = tier === "High" ? A.warm * A.hrs : tier === "Medium" ? A.warm * A.hrs * 0.5 : 0;
    const kwh = saved * A.kwh + warmerKwh;
    $("kpi-rec").textContent = fmt(rec);
    $("kpi-range").textContent = `portions for ${sc.period.name.toLowerCase()} · range ${fmt(lo)}–${fmt(hi)}`;
    $("kpi-saved").textContent = fmt(saved);
    $("kpi-kg").textContent = fmt(saved * A.kg, 1) + " kg";
    $("kpi-rm").textContent = `≈ RM ${fmt(saved * A.rm)} in ingredients`;
    $("kpi-kwh").textContent = fmt(kwh, 1) + " kWh";
    $("kpi-co2").textContent = `≈ ${fmt(kwh * A.co2, 1)} kg CO₂ avoided`;

    renderPlan(sc, tier, rec);
    renderHourNote(sc);
    renderWhy(dem, pred);
    renderFuzzy(fz);
    renderWeek();
    renderSlots(sc, used, tier);
    renderEngineHeader(sc, tier, rec);
    CALCS.forEach((c) => c.update({ fz, pred, used, rec, saved, kwh, warmerKwh, A, tier }));
    engineRun({ sc, dem, fz, pred, used, rec, lo, hi, saved, kwh, tier });
    renderTips(sc);
  }

  function renderTime(sc, rec) {
    const p = sc.period;
    $("time").value = state.time;
    $("time").style.setProperty("--fill", ((state.time - OPEN) / (CLOSE - OPEN)) * 100 + "%");
    $("time").setAttribute("aria-valuetext", `${fmtTime(state.time)}, ${p.name}`);
    $("time-label").textContent = fmtTime(state.time);
    const chip = $("period-chip");
    chip.textContent = `${p.icon} ${p.name} · ${fmtTime(p.start)} – ${fmtTime(Math.min(p.end, CLOSE))}`;
    chip.style.setProperty("--pc", p.color);
    chip.style.setProperty("--pc-soft", p.color + "22");
    $("past-tag").hidden = !(state.live && isPast(state.date, state.time));
    document.querySelectorAll(".band").forEach((b) => b.classList.toggle("active", b.dataset.key === p.key));

    const selH = sc.hour;
    document.querySelectorAll(".hicon").forEach((el) => {
      const h = +el.dataset.h, wx = weatherAt(state.date, h);
      el.textContent = wx ? wx.ico : "·";
      el.title = wx ? `${fmtHour(h)}: ${wx.title} (${wx.sub})` : `${fmtHour(h)}: no forecast`;
      el.classList.toggle("na", !wx);
      el.classList.toggle("past", !!wx && isPast(state.date, h * 60 + 30));
      el.classList.toggle("sel", h === selH);
      el.classList.toggle("changed", changedHours.has(h));
    });

    // which half-hour slot of the meal are we in?
    if (p.key === "lunch") {
      const bucket = state.time < 720 ? "Before 12:00 pm" : state.time < 780 ? "12:00 to 1:00 pm" : state.time < 840 ? "1:00 to 2:00 pm" : "After 2:00 pm";
      const share = S.lunch_time[bucket].pct / 2;
      $("slot-line").innerHTML = `<strong>${fmtTime(state.time)} – ${fmtTime(state.time + STEP)}</strong>: about <strong>${fmt(share, 1)}%</strong> of lunch customers come in this half-hour (≈ <strong>${Math.round(rec * share / 100)}</strong> of ${rec} expected portions, survey Q5).`;
    } else if (p.key === "dinner") {
      $("slot-line").innerHTML = `<strong>Dinner</strong>: the survey didn't ask about dinner timing, so this is the forecast for the whole service.`;
    } else if (p.gap) {
      $("slot-line").innerHTML = `<strong>Prep window</strong> before lunch. Use it to cook the first lunch batch.`;
    } else {
      $("slot-line").innerHTML = `<strong>${p.name}</strong> is a smaller service the survey didn't cover. ${fmt(S.meals[p.key === "tea" ? "Tea and snacks" : p.name] ? S.meals[p.key === "tea" ? "Tea and snacks" : p.name].pct : 0)}% of students said they eat ${p.name.toLowerCase()} at the cafeteria.`;
    }

    // status line
    const upd = $("updated");
    if (WX.status === "loading") upd.textContent = "Connecting…";
    else if (WX.status === "error") upd.textContent = "Weather offline";
    else if (WX.status === "stale") upd.textContent = `Weather offline · last updated ${clock(WX.updated)}`;
    else {
      const mins = Math.floor((Date.now() - WX.updated) / 60000);
      upd.textContent = `Updated ${mins < 1 ? "just now" : mins === 1 ? "1 min ago" : mins + " min ago"} · next in ${Math.max(0, Math.ceil((REFRESH_MS - (Date.now() - WX.updated)) / 60000))} min`;
    }

    // note under the day chart
    const has = !!WX.hours[state.date];
    $("time-note").textContent = has
      ? `Bars = forecast rain (mm) each hour · line = expected demand at that hour · ${state.live ? "updates automatically" : "manual mode: line uses your chosen weather"}`
      : WX.status === "loading" ? "Loading the hourly forecast…"
      : WX.last ? `No hourly forecast for this date (forecast covers ${shortDate(WX.first)} – ${shortDate(WX.last)}), so the weather is assumed clear.`
      : "Hourly forecast unavailable. Set the weather by hand.";
    renderDayChart();
  }

  // vertical marker for the selected hour on the day chart
  const markerPlugin = {
    id: "marker",
    afterDatasetsDraw(chart) {
      const i = chart.$sel;
      if (i == null) return;
      const x = chart.scales.x.getPixelForValue(i);
      const { top, bottom } = chart.chartArea;
      const c = chart.ctx;
      c.save();
      c.strokeStyle = TH.marker; c.setLineDash([4, 4]); c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      c.restore();
    },
  };

  function renderDayChart() {
    const hours = [];
    for (let h = OPEN / 60; h <= CLOSE / 60; h++) hours.push(h);
    const labels = hours.map((h) => fmtHour(h).replace(" ", "").toLowerCase());
    const rain = hours.map((h) => { const s = WX.hours[state.date] && WX.hours[state.date][h]; return s ? +s.rain.toFixed(1) : 0; });
    const pts = hours.map((h) => tierAt(state.date, h * 60));
    const dem = pts.map((p) => Math.round(p.used * 100));
    const ptColors = pts.map((p) => COLORS[p.pred.tier]);
    const sel = Math.floor(state.time / 60) - OPEN / 60;
    const data = {
      labels,
      datasets: [
        { type: "line", label: "Expected demand %", data: dem, yAxisID: "y", borderColor: TH.line, borderWidth: 2,
          pointBackgroundColor: ptColors, pointBorderColor: ptColors, pointRadius: hours.map((_, i) => (i === sel ? 6 : 3)), tension: .3, order: 0 },
        { type: "bar", label: "Rain (mm)", data: rain, yAxisID: "y1", borderRadius: 4, maxBarThickness: 18, order: 1,
          backgroundColor: hours.map((_, i) => (i === sel ? "rgba(56,189,248,.95)" : "rgba(56,189,248,.45)")) },
      ],
    };
    if (dayChart) { dayChart.data = data; dayChart.$sel = sel; dayChart.update("none"); return; }
    dayChart = new Chart($("day-chart"), {
      data,
      plugins: [markerPlugin],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        onClick: (_, els) => { if (els.length) setTime((els[0].index + OPEN / 60) * 60); },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.dataset.yAxisID === "y" ? `Expected demand ${c.parsed.y}% (${pts[c.dataIndex].pred.tier} risk)` : `Rain ${c.parsed.y} mm`} } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 8, font: { size: 10.5 } } },
          y: { min: 0, max: 110, position: "left", grid: { color: GRID }, ticks: { stepSize: 50, callback: (v) => (v <= 100 ? v + "%" : "") } },
          y1: { min: 0, suggestedMax: 5, position: "right", grid: { display: false }, ticks: { callback: (v) => v + " mm", maxTicksLimit: 4 } },
        },
      },
    });
    dayChart.$sel = sel;
    dayChart.update("none");
  }

  function renderLive(sc) {
    const applied = state.live ? "" : " · not applied (manual mode)";
    $("wx-when").textContent = `${fmtTime(sc.hour * 60).replace(":00", "")} · ${shortDate(sc.date)}`;
    if (sc.wx) {
      $("wx-ico").textContent = sc.wx.ico;
      $("wx-title").textContent = sc.wx.title + (sc.src.wx === "manual" ? " (overridden)" : "");
      $("wx-sub").textContent = sc.wx.sub + applied;
    } else {
      $("wx-ico").textContent = "🛰️";
      $("wx-title").textContent = WX.status === "loading" ? "Loading forecast…" : WX.status === "error" ? "Forecast unavailable" : "Outside forecast range";
      $("wx-sub").textContent = WX.status === "error" ? "Offline or blocked. Set the weather by hand."
        : WX.last ? `Forecast covers ${shortDate(WX.first)} – ${shortDate(WX.last)}. Assumed clear.` : "Open-Meteo · UTP, Seri Iskandar";
    }
    $("cal-ico").textContent = sc.cal.ico;
    $("cal-title").textContent = sc.cal.title + (sc.src.cal === "manual" ? " (overridden)" : "");
    $("cal-sub").textContent = `${sc.cal.sub}${applied}`;

    const wxMap = {
      loading: ["", "Weather: connecting…"], ok: ["ok", "Live weather · Open-Meteo"],
      partial: ["warn", "Live weather · no haze data"], error: ["err", "Weather offline · manual"],
      stale: ["warn", `Weather offline · last ${WX.updated ? clock(WX.updated) : ""}`],
    };
    const [cls, txt] = wxMap[WX.status];
    $("pill-weather").className = "pill " + cls;
    $("pill-weather").innerHTML = `<span class="dot"></span>${txt}`;
    $("pill-cal").className = "pill ok";
    $("pill-cal").innerHTML = `<span class="dot"></span>UTP academic calendar`;
  }

  function renderPlan(sc, tier, rec) {
    const p = sc.period, lunch = p.key === "lunch";
    const end = Math.min(p.end, CLOSE);
    const t = { prep: `By ${fmtTime(p.start - 30)}`, peak: `${fmtTime(Math.min(p.start + 90, end - 30))} check`, late: `After ${fmtTime(end - 30)}` };
    const first = { Low: rec, Medium: Math.round(rec * 0.8), High: Math.round(rec * 0.6) }[tier];
    const topUp = Math.max(rec - first, 0);
    const steps = {
      Low: [
        [t.prep, `Cook the full first batch of <strong>${first} portions</strong> for ${p.name.toLowerCase()}.`],
        [t.peak, lunch ? `Expect a normal rush: ${S.lunch_time["12:00 to 1:00 pm"].pct}% of lunch customers arrive 12–1 PM.` : `Expect a normal ${p.name.toLowerCase()} crowd.`],
        [t.late, lunch ? `Keep the warmers on, because ${S.lunch_time["After 2:00 pm"].pct}% of students eat lunch after 2 PM. Switch to low heat after 3:00 PM.` : "Turn the warmers down to low once the rush ends."],
      ],
      Medium: [
        [t.prep, `Cook <strong>${first} portions</strong> first. Prep the ingredients for another ${topUp}, but don't cook them yet.`],
        [t.peak, `If more than half has sold, cook the <strong>${topUp}-portion top-up</strong>. If not, skip it.`],
        [t.late, "Move leftovers into fewer warmer wells, switch off the empty wells and run the exhaust hood on low."],
      ],
      High: [
        [t.prep, `Cook only a small first batch of <strong>${first} portions</strong>.`],
        [t.peak, `Cook small top-ups of about ${Math.max(Math.round(state.batch * 0.1), 1)} portions only when a tray is less than a quarter full, up to ${topUp} more in total.`],
        [t.late, "Switch off unused warmer wells and turn the exhaust hood to its lowest setting. This saves gas and electricity on idle equipment."],
      ],
    }[tier];
    $("plan").innerHTML = steps.map(([time, txt]) => `<li><span class="time">${time}</span>${txt}</li>`).join("");
  }

  // "This hour" note: rain / haze inside the current meal period
  function renderHourNote(sc) {
    const el = $("hour-note"), p = sc.period;
    if (!WX.hours[state.date] || !state.live || state.ovWx) { el.hidden = true; return; }
    const startH = Math.floor(p.start / 60), endH = Math.ceil(Math.min(p.end, CLOSE) / 60) - 1;
    const rainy = [];
    for (let h = startH; h <= endH; h++) { const w = weatherAt(state.date, h); if (w && w.weather === "Heavy rain") rainy.push(h); }
    const ranges = [];
    rainy.forEach((h) => { const r = ranges[ranges.length - 1]; if (r && r[1] === h - 1) r[1] = h; else ranges.push([h, h]); });
    const txt = ranges.map(([a, b]) => `${fmtHour(a)}–${fmtHour(b + 1)}`).join(", ");
    if (sc.weather === "Heavy rain") {
      const cur = ranges.find(([a, b]) => a <= sc.hour && sc.hour <= b);
      el.innerHTML = `🌧️ <strong>Rain from ${cur ? `${fmtHour(cur[0])}–${fmtHour(cur[1] + 1)}` : fmtHour(sc.hour)}</strong>: hold the next top-up until it clears and keep food covered on low heat.`;
    } else if (ranges.length) {
      el.innerHTML = `🌧️ <strong>Rain expected ${txt}</strong> during ${p.name.toLowerCase()}. Cook your top-up before the rain starts, or wait until it clears.`;
    } else if (sc.weather === "Haze") {
      el.innerHTML = `🌫️ <strong>Hazy at ${fmtHour(sc.hour)}</strong>. Expect more takeaway orders than dine-in.`;
    } else {
      el.innerHTML = `☀️ <strong>No heavy rain expected</strong> during ${p.name.toLowerCase()} (${fmtTime(p.start)} – ${fmtTime(Math.min(p.end, CLOSE))}).`;
    }
    el.hidden = false;
  }

  function renderWhy(dem, pred) {
    const rows = [["Normal weekday", 1], ...dem.factors];
    let html = rows.map(([lbl, m]) => `
      <div class="factor"><span>${lbl}</span><div class="fbar"><div style="width:${Math.min(m, 1) * 100}%"></div></div>
      <span class="fv">${lbl === "Normal weekday" ? "100%" : "×" + m.toFixed(2)}</span></div>`).join("");
    html += `<div class="factor total"><span>Expected demand${dem.floored ? " (floor)" : ""}</span><div class="fbar"><div style="width:${dem.value * 100}%"></div></div><span class="fv">${Math.round(dem.value * 100)}%</span></div>`;
    $("factors").innerHTML = html;
    const L = CFG.feature_labels;
    const steps = pred.path.map((p) => `<li>${L[p.feature].replace(/ \(.*\)/, "")}? <span class="${p.yes ? "yes" : "no"}">${p.yes ? "Yes" : "No"}</span></li>`);
    steps.push(`<li class="leaf">→ <span style="color:${COLORS[pred.tier]}">${pred.tier} risk</span> <span class="muted small">(${Math.round(pred.confidence * 100)}% of ${pred.leafSamples} similar training days)</span></li>`);
    $("path").innerHTML = steps.join("");
  }

  /* --------------------------------------------- fuzzy card (live view) */
  const FZ_COLORS = {
    day_demand: { Low: "#f87171", Medium: "#fbbf24", High: "#34d399" },
    rain: { Dry: "#34d399", Light: "#38bdf8", Heavy: "#818cf8" },
    air: { Good: "#34d399", Moderate: "#fbbf24", Hazy: "#a8a29e" },
    out: { "Very low": "#34d399", Low: "#a3e635", Medium: "#fbbf24", High: "#fb923c", "Very high": "#f87171" },
  };
  // vertical line at chart.$x (linear x axis)
  const vlinePlugin = {
    id: "vline",
    afterDatasetsDraw(chart) {
      if (chart.$x == null) return;
      const x = chart.scales.x.getPixelForValue(chart.$x), { top, bottom } = chart.chartArea, c = chart.ctx;
      const col = chart.$xc || TH.marker;
      c.save(); c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 2.5;
      c.shadowColor = col; c.shadowBlur = 6;
      c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      c.beginPath(); c.arc(x, top, 4, 0, Math.PI * 2); c.fill(); c.restore();
    },
  };
  const fzCharts = {};
  function fzChart(id, spec, colors, extra = []) {
    const [lo, hi] = spec.range, xs = Array.from({ length: 121 }, (_, i) => lo + (hi - lo) * i / 120);
    const sets = Object.entries(spec.sets).map(([name, p]) => ({
      label: name, data: xs.map((x) => ({ x, y: trap(x, p) })), borderColor: colors[name], borderWidth: 2,
      pointRadius: 0, fill: false, tension: 0,
    }));
    return new Chart($(id), {
      type: "line", data: { datasets: [...extra, ...sets] }, plugins: [vlinePlugin],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, events: [],
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { type: "linear", min: lo, max: hi, grid: { display: false }, ticks: { maxTicksLimit: 5, font: { size: 10 } } },
          y: { min: 0, max: 1.05, grid: { color: GRID }, ticks: { stepSize: 0.5, font: { size: 10 } } },
        },
      },
    });
  }

  function renderFuzzy(fz) {
    if (!FZ || !window.Chart || !Chart.register) return;
    for (const k of Object.keys(FZ.inputs)) {
      const spec = FZ.inputs[k];
      if (!fzCharts[k]) fzCharts[k] = fzChart("fz-" + k, spec, FZ_COLORS[k]);
      fzCharts[k].$x = Math.min(Math.max(fz.x[k], spec.range[0]), spec.range[1]);
      fzCharts[k].update("none");
      const val = k === "rain" ? fz.x[k].toFixed(1) : Math.round(fz.x[k]);
      $("fz-t-" + k).innerHTML = `${spec.label} = <strong>${val}${k === "day_demand" ? "%" : " " + spec.unit}</strong>`;
      $("fz-mu-" + k).innerHTML = Object.entries(fz.mu[k]).map(([s, v]) =>
        `<span><i class="dot" style="background:${FZ_COLORS[k][s]}"></i>${s} <b>${v.toFixed(2)}</b></span>`).join("");
    }
    // output: faint term shapes + aggregated (clipped) area + centroid line
    if (!fzCharts.out) {
      fzCharts.out = fzChart("fz-out", FZ.output, FZ_COLORS.out, [{
        label: "aggregated", data: [], borderColor: "rgba(56,189,248,.9)", backgroundColor: "rgba(56,189,248,.35)",
        borderWidth: 1.5, pointRadius: 0, fill: "origin", tension: 0,
      }]);
      fzCharts.out.data.datasets.slice(1).forEach((d) => { d.borderWidth = 1; d.borderColor += "88"; });
    }
    const out = fzCharts.out;
    out.data.datasets[0].data = FZ_U.map((u, i) => ({ x: u, y: fz.agg[i] }));
    out.$x = fz.score; out.$xc = COLORS[fz.tier];
    out.update("none");
    $("fz-t-out").innerHTML = `Waste risk = <strong>${Math.round(fz.score)}/100</strong>`;
    $("fz-result").innerHTML = `Centroid <strong>${Math.round(fz.score)}</strong> → <strong>${fz.tier}</strong> risk → expected demand <strong>${Math.round(fz.demand)}%</strong> <span class="muted">(${fz.x.source})</span>`;

    const top = fz.fired.slice(0, 5);
    $("fz-rules").innerHTML = top.map((r) => `<li>
      <span>IF day demand is <b>${r.day_demand}</b> AND rain is <b>${r.rain}</b> AND air is <b>${r.air}</b> THEN risk is <em style="--tc:${FZ_COLORS.out[r.then]}">${r.then}</em></span>
      <div class="rb"><div style="width:${r.strength * 100}%"></div></div><span class="rv">${r.strength.toFixed(2)}</span></li>`).join("")
      + (fz.fired.length > 5 ? `<li><span class="muted small">+ ${fz.fired.length - 5} weaker rule${fz.fired.length - 5 > 1 ? "s" : ""} also firing</span></li>` : "");
  }

  function buildFuzzyModel() {
    if (!FZ) return;
    $("fz-m-rules").textContent = FZ.metrics.rules;
    $("fz-m-agree").textContent = Math.round(FZ.metrics.tier_agreement_with_crisp * 1000) / 10 + "%";
    $("fz-m-diff").textContent = fmt(FZ.metrics.mean_abs_demand_diff, 1);

    // rule base matrix, one table per air-quality level
    const dayT = Object.keys(FZ.inputs.day_demand.sets), rainT = Object.keys(FZ.inputs.rain.sets);
    $("fz-matrix").innerHTML = Object.keys(FZ.inputs.air.sets).map((a) => `<table><caption>Air: ${a}</caption>
      <tr><th>Day ↓ / Rain →</th>${rainT.map((r) => `<th>${r}</th>`).join("")}</tr>
      ${dayT.slice().reverse().map((d) => `<tr><th>${d}</th>${rainT.map((r) => {
        const rule = FZ.rules.find((x) => x.day_demand === d && x.rain === r && x.air === a);
        return `<td style="background:${FZ_COLORS.out[rule.then]}" title="${rule.evidence}">${rule.then}</td>`;
      }).join("")}</tr>`).join("")}</table>`).join("");

    // crisp vs fuzzy as rain increases (normal weekday lunch, good air)
    const rains = Array.from({ length: 101 }, (_, i) => i * 0.05);
    const base = 100;
    new Chart($("ch-sweep"), {
      type: "line",
      data: { datasets: [
        { label: "Crisp rule (≥ 1 mm = heavy rain)", data: rains.map((r) => ({ x: r, y: r >= RULES.heavyRainMm ? base * M.heavy_rain : base })), borderColor: "#64748b", borderWidth: 2.5, pointRadius: 0, stepped: true },
        { label: "Fuzzy logic (Mamdani)", data: rains.map((r) => ({ x: r, y: fuzzyInfer({ day_demand: base, rain: r, air: 10 }).demand })), borderColor: COLORS.brand, borderWidth: 3, pointRadius: 0, tension: .2 },
      ] },
      options: { ...baseOpts({ x: { type: "linear", min: 0, max: 5, title: { display: true, text: "Rain in the hour (mm)" } }, y: { min: 0, max: 105, ticks: pctTick, title: { display: true, text: "Expected demand" } } }),
        interaction: { mode: "index", intersect: false } },
    });
  }

  function renderWeek() {
    const el = $("week");
    el.innerHTML = "";
    const start = state.live ? state.date : addDays(state.date, -dowIdx(state.date));
    for (let k = 0; k < 7; k++) {
      const iso = addDays(start, k);
      const sc = scenarioFor(iso, state.time, { day: CFG.days[k] });
      const dm = { value: usedDemand(demand(sc), fuzzyFor(sc)) }, p = predict(encode(sc));
      const selected = state.live ? iso === state.date : sc.day === state.day;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wday" + (selected ? " sel" : "");
      b.style.setProperty("--tc", COLORS[p.tier]);
      b.innerHTML = `<div class="d">${sc.day}</div>${state.live ? `<div class="dt">${shortDate(iso)}</div>` : ""}
        <div class="wi" title="${sc.weather} · ${sc.calendar}">${sc.calendar === "Holiday / break" ? "🏖️" : sc.wx && state.live && !state.ovWx ? sc.wx.ico : ICONS[sc.weather]}</div>
        <div class="p">${Math.round(dm.value * 100)}%</div><span class="t t-${p.tier}">${p.tier}</span>`;
      b.onclick = () => { if (state.live) { state.date = iso; state.follow = false; state.ovCal = state.ovWx = false; } else state.day = sc.day; render(); };
      el.appendChild(b);
    }
    $("week-note").textContent = `At ${fmtTime(state.time)} each day · ${state.live ? "live forecast & calendar" : `${state.calendar} · ${state.weather}`} · click a day`;
  }

  function renderSlots(sc, usedDem, tier) {
    const dem = { value: usedDem };
    let labels, normal, scen, active = -1;
    if (sc.meal === "Lunch" && sc.period.key === "lunch") {
      const keys = ["Before 12:00 pm", "12:00 to 1:00 pm", "1:00 to 2:00 pm", "After 2:00 pm"];
      labels = ["11–12", "12–1 PM", "1–2 PM", "2–3 PM"];
      const shares = keys.map((k) => S.lunch_time[k].pct / 100);
      normal = shares.map((s) => Math.round(state.batch * s));
      scen = shares.map((s) => Math.round(state.batch * dem.value * s));
      active = state.time < 720 ? 0 : state.time < 780 ? 1 : state.time < 840 ? 2 : 3;
      $("slot-note").textContent = "Lunch timing from survey Q5 · highlighted = selected time";
    } else {
      labels = [`Whole ${sc.period.name.toLowerCase()} service`];
      normal = [state.batch]; scen = [Math.round(state.batch * dem.value)];
      $("slot-note").textContent = `${sc.period.name} timing wasn't surveyed, so only the total is shown`;
    }
    const data = { labels, datasets: [
      { label: "Normal weekday", data: normal, backgroundColor: TH.bar, borderRadius: 8 },
      { label: "This service", data: scen, borderRadius: 8,
        backgroundColor: scen.map((_, i) => (active === -1 || i === active ? COLORS[tier] : COLORS[tier] + "66")) },
    ] };
    if (slotChart) { slotChart.data = data; slotChart.update(); return; }
    slotChart = new Chart($("slot-chart"), { type: "bar", data, options: baseOpts({ y: { title: { display: true, text: "Expected customers" } } }) });
  }

  function renderTips(sc) {
    const pct = (o, k) => (o[k] ? o[k].pct : 0);
    const tips = [];
    if (sc.weather === "Heavy rain")
      tips.push(["☔", "Rain plan", `${Math.round(pct(S.dining_mode, "Both equally") + pct(S.dining_mode, "Takeaway"))}% of students sometimes take their food away. Have containers ready for quick grab-and-go orders.`]);
    if (sc.weather === "Haze")
      tips.push(["🌫️", "Haze plan", "Students stay indoors more on hazy days. Keep the menu short and push takeaway."]);
    if (sc.calendar === "Holiday / break")
      tips.push(["🏖️", "Break day", `Only ${Math.round(M.holiday * 100)}% of students stay on campus during breaks. Run a short menu with your 2–3 best sellers.`]);
    if (sc.calendar === "Exam week")
      tips.push(["📝", "Exam period", "Students stay in to study, so quick takeaway food sells better than full dine-in meals."]);
    if (sc.shortBreak && sc.meal === "Lunch")
      tips.push(["⏱️", "Short breaks", `${pct(S.short_break, "Eat before or after class")}% of students eat before or after class instead. Expect small rushes before 12 and after 2 PM.`]);
    const portion = pct(S.leave_reason, "Ordered too much") + pct(S.leave_reason, "Portion too big");
    tips.push(["🍽️", "Offer a small portion", `${Math.round(portion)}% of students who leave food say they ordered too much or the portion was too big. A half-portion option cuts plate waste.`]);
    const shift = pct(S.forecast_reaction, "Eat somewhere else") + pct(S.forecast_reaction, "Eat earlier or later");
    tips.push(["📣", "Post your quiet hours", `${Math.round(shift)}% of students would change when or where they eat if told it's busy. Posting quiet times spreads out the rush.`]);
    $("tips").innerHTML = tips.slice(0, 3).map(([i, t, d]) => `<div class="card tip"><span class="ti">${i}</span><div><strong>${t}</strong>${d}</div></div>`).join("");
  }

  /* ------------------------------------------- live calculation (animated) */
  // A "machine" view: input dials → data pipes → decision tree + fuzzy engine → formula + cooking pot.
  // Everything eases to its new value whenever an input changes; auto-play sweeps the day.
  const RM = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const PLAY = { on: false, speed: 1, timer: null };
  let CALCS = [];
  let calcUid = 0;

  const KNOB_GEO = { cx: 60, cy: 54, r: 40 };
  const kAngle = (k, v) => -135 + 270 * (Math.min(Math.max(v, k.min), k.max) - k.min) / (k.max - k.min);
  const kPoint = (deg, r = KNOB_GEO.r) => {
    const t = (deg * Math.PI) / 180;
    return [KNOB_GEO.cx + r * Math.sin(t), KNOB_GEO.cy - r * Math.cos(t)];
  };
  const kArc = (d0, d1) => {
    const [x0, y0] = kPoint(d0), [x1, y1] = kPoint(d1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${KNOB_GEO.r} ${KNOB_GEO.r} 0 ${d1 - d0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  // zones = fuzzy sets, split where neighbouring membership functions cross
  function zonesFromSets(spec, colors) {
    const names = Object.keys(spec.sets), [lo, hi] = spec.range, z = [];
    let from = lo;
    names.forEach((n, i) => {
      const p = spec.sets[n], q = names[i + 1] && spec.sets[names[i + 1]];
      const to = q ? (p[2] + p[3] + q[0] + q[1]) / 4 : hi;
      z.push({ name: n, from, to, color: colors[n] });
      from = to;
    });
    return z;
  }

  function knobDefs() {
    return [
      { key: "rain", icon: "🌧️", label: "Rain", min: 0, max: 6, unit: "mm / hour", fmt: (v) => v.toFixed(1), zones: zonesFromSets(FZ.inputs.rain, FZ_COLORS.rain) },
      { key: "air", icon: "🌫️", label: "Air (PM2.5)", min: 0, max: 100, unit: "µg/m³", fmt: (v) => Math.round(v), zones: zonesFromSets(FZ.inputs.air, FZ_COLORS.air) },
      { key: "day", icon: "📅", label: "Day demand", min: 0, max: 100, unit: "% of normal", fmt: (v) => Math.round(v), zones: zonesFromSets(FZ.inputs.day_demand, FZ_COLORS.day_demand) },
      { key: "time", icon: "🕒", label: "Time of day", min: OPEN, max: CLOSE, unit: "", fmt: (v) => fmtTime(v).split(" ")[0], unitFn: (v) => fmtTime(v).split(" ")[1],
        zones: PERIODS.map((p) => ({ name: p.name, from: p.start, to: Math.min(p.end, CLOSE), color: p.color })) },
    ];
  }

  function knobHTML(k) {
    const ticks = Array.from({ length: 11 }, (_, i) => {
      const d = -135 + 27 * i, [x0, y0] = kPoint(d, 47), [x1, y1] = kPoint(d, 50);
      return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="currentColor" opacity=".35"/>`;
    }).join("");
    const zones = k.zones.map((z) => `<path class="k-zone" d="${kArc(kAngle(k, z.from), kAngle(k, z.to) - 0.01)}" stroke="${z.color}"/>`).join("");
    return `<div class="knob" data-k="${k.key}">
      <div class="k-name">${k.icon} ${k.label}</div>
      <svg viewBox="0 0 120 100" aria-hidden="true">
        <path class="k-track" d="${kArc(-135, 135)}"/>${zones}<g style="color:var(--muted)">${ticks}</g>
        <g class="needle" style="transform-box:view-box;transform-origin:${KNOB_GEO.cx}px ${KNOB_GEO.cy}px;transform:rotate(-135deg)">
          <line x1="${KNOB_GEO.cx}" y1="${KNOB_GEO.cy}" x2="${KNOB_GEO.cx}" y2="${KNOB_GEO.cy - 31}"/><circle cx="${KNOB_GEO.cx}" cy="${KNOB_GEO.cy}" r="5"/>
        </g>
        <text class="k-val" x="60" y="86">–</text><text class="k-unit" x="60" y="97">${k.unit}</text>
      </svg>
      <span class="k-zone-lbl">–</span></div>`;
  }

  function potHTML(uid) {
    const body = "M18 36 L102 36 L96 116 Q95 123 88 123 L32 123 Q25 123 24 116 Z";
    let wave = "M-40 40";
    for (let x = -40; x < 160; x += 20) wave += " q5 -4 10 0 t10 0";
    return `<div class="pot"><svg viewBox="0 0 120 132" aria-hidden="true">
      <defs><clipPath id="pot-clip-${uid}"><path d="${body}"/></clipPath></defs>
      <g class="p-steam"><path d="M45 20 q-5 -6 0 -11 t0 -9"/><path d="M60 20 q-5 -6 0 -11 t0 -9"/><path d="M75 20 q-5 -6 0 -11 t0 -9"/></g>
      <g clip-path="url(#pot-clip-${uid})"><g class="p-liquid" style="transform:translateY(83px)">
        <path class="p-wave" d="${wave} L160 46 L-40 46 Z"/><rect x="0" y="44" width="120" height="100"/></g></g>
      <path class="p-body" d="${body}"/>
      <path class="p-handle" d="M18 46 H8 M102 46 H112"/><path class="p-handle" d="M12 36 H108"/>
      <line class="p-usual" x1="22" y1="40" x2="98" y2="40"/><text class="p-usual-t" x="60" y="29" text-anchor="middle">usual batch</text>
    </svg><div class="pot-lbl">cook <b class="num n-pcook">0</b> of <b class="num n-pbatch">0</b></div></div>`;
  }

  const fmtNum = (v, dec) => Number(v).toLocaleString("en-MY", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  function tween(el, to, dec = 0) {
    if (!el) return;
    const from = el._v == null ? to : el._v;
    el._v = to;
    cancelAnimationFrame(el._raf);
    if (RM || from === to) { el.textContent = fmtNum(to, dec); return; }
    const t0 = performance.now(), dur = 700;
    const step = (t) => {
      const k = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmtNum(from + (to - from) * e, dec);
      if (k < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
    el.classList.remove("rolled"); void el.offsetWidth; el.classList.add("rolled");
  }

  const SHORT_FEAT = { is_friday: "Friday", is_weekend: "Weekend", exam_week: "Exam", holiday: "Holiday", heavy_rain: "Rain", haze: "Haze", short_break: "Short breaks", is_lunch: "Lunch" };

  function createCalc(host, compact) {
    if (!host || !FZ) return null;
    const uid = ++calcUid, knobs = knobDefs();
    host.innerHTML = `
      <div class="calc-head">
        <div><h3>⚙️ Live calculation</h3><p class="muted small">${compact
          ? "The same machine as the Daily advisor: inputs → AI engines → batch size."
          : "Watch the live inputs flow through both AI engines into the batch size. Drag the time slider or press auto-play."}</p></div>
        <div class="calc-ctrl">
          <button type="button" class="ghost-btn play-btn">▶ Auto-play the day</button>
          <div class="segmented speed-seg">${[0.5, 1, 2].map((v) => `<button type="button" class="seg-btn" data-v="${v}">${v}×</button>`).join("")}</div>
        </div>
      </div>
      <div class="machine">
        <div class="m-col knobs">${knobs.map(knobHTML).join("")}</div>
        <div class="pipe"><i></i><i></i><i></i></div>
        <div class="m-col engines">
          <div class="eng-box tree-box"><div class="eb-title"><span>🌳 Decision tree</span><span class="tier-badge t-tree">–</span></div><div class="tree-path"></div></div>
          <div class="eng-box fz-box"><div class="eb-title"><span>〰️ Fuzzy logic</span><span class="tier-badge t-fz">–</span></div>
            <svg class="fz-mini" viewBox="0 0 200 62" preserveAspectRatio="none" aria-hidden="true">
              <line class="fz-base" x1="0" y1="60" x2="200" y2="60"/><path class="fz-area" d="M0 60 L200 60 Z"/>
              <g class="fz-cent"><line x1="0" y1="2" x2="0" y2="60"/></g></svg>
            <div class="fz-score">centroid <b class="num n-score">0</b>/100 → demand <b class="num n-fzd">0</b>%</div></div>
        </div>
        <div class="pipe"><i></i><i></i><i></i></div>
        <div class="m-col out">
          <div class="formula">
            <div class="f-line main"><span class="f-lbl">usual batch × expected demand (<span class="f-basis">fuzzy</span>)</span>
              <span class="num n-batch">0</span><span class="op">×</span><span class="f-unit"><span class="num n-dem">0</span>%</span><span class="op">=</span><span class="num res n-rec">0</span><span class="f-unit">portions to cook</span></div>
            <div class="f-line"><span class="f-lbl">food saved</span><span class="f-unit"><span class="num n-saved">0</span> not cooked</span><span class="op">×</span><span class="f-unit"><span class="num n-kgp">0</span> kg</span><span class="op">=</span><span class="f-unit"><span class="num n-kg">0</span> kg</span></div>
            <div class="f-line"><span class="f-lbl">energy saved (cooking + warmers)</span><span class="f-unit"><span class="num n-saved2">0</span> ×</span><span class="f-unit"><span class="num n-kwhp">0</span> kWh</span><span class="op">+</span><span class="f-unit"><span class="num n-warm">0</span> kWh</span><span class="op">=</span><span class="f-unit"><span class="num n-kwh">0</span> kWh</span></div>
          </div>
          ${compact ? "" : potHTML(uid)}
        </div>
      </div>`;
    const q = (s) => host.querySelector(s), qa = (s) => host.querySelectorAll(s);
    q(".play-btn").onclick = () => (PLAY.on ? stopPlay() : startPlay());
    qa(".speed-seg .seg-btn").forEach((b) => b.onclick = () => setSpeed(+b.dataset.v));
    const last = { sig: "", path: "", zones: {} };

    function pulse() {
      qa(".pipe").forEach((p) => { p.classList.remove("burst"); void p.offsetWidth; p.classList.add("burst"); });
      clearTimeout(last.pt);
      last.pt = setTimeout(() => qa(".pipe").forEach((p) => p.classList.remove("burst")), 1100);
      qa(".eng-box").forEach((b) => b.classList.add("hot"));
      clearTimeout(last.ht);
      last.ht = setTimeout(() => qa(".eng-box").forEach((b) => b.classList.remove("hot")), 700);
    }

    function update(d) {
      const { fz, pred, used, rec, saved, kwh, warmerKwh, A, tier } = d;
      const vals = { rain: fz.x.rain, air: fz.x.air, day: fz.x.day_demand, time: state.time };
      const sig = [vals.rain.toFixed(2), Math.round(vals.air), Math.round(vals.day), vals.time, rec, state.basis].join("|");
      if (sig !== last.sig) { last.sig = sig; pulse(); }

      knobs.forEach((k) => {
        const el = q(`.knob[data-k="${k.key}"]`), v = vals[k.key];
        el.querySelector(".needle").style.transform = `rotate(${kAngle(k, v).toFixed(1)}deg)`;
        el.querySelector(".k-val").textContent = k.fmt(v);
        if (k.unitFn) el.querySelector(".k-unit").textContent = k.unitFn(v);
        const z = k.zones.find((zz) => v >= zz.from && v < zz.to) || k.zones[v < k.min ? 0 : k.zones.length - 1];
        const lbl = el.querySelector(".k-zone-lbl");
        lbl.textContent = z.name; lbl.style.setProperty("--zc", z.color);
        if (last.zones[k.key] && last.zones[k.key] !== z.name) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
        last.zones[k.key] = z.name;
      });

      // decision tree: questions light up one after another
      const pathSig = pred.path.map((s) => s.node).join(",") + ">" + pred.leaf;
      if (pathSig !== last.path) {
        last.path = pathSig;
        q(".tree-path").innerHTML = pred.path.map((s, i) =>
          `<span class="lit" style="animation-delay:${RM ? 0 : i * 140}ms">${SHORT_FEAT[s.feature]}? <b class="${s.yes ? "" : "no"}">${s.yes ? "Yes" : "No"}</b></span>`).join("");
      }
      const tb = q(".t-tree");
      tb.textContent = `${tier} · ${Math.round(pred.confidence * 100)}%`; tb.style.setProperty("--tc", COLORS[tier]);

      // fuzzy: aggregated output shape morphs, centroid slides
      let dpath = "M0 60";
      for (let i = 0; i < FZ_U.length; i += 4) dpath += ` L${(FZ_U[i] * 2).toFixed(1)} ${(60 - fz.agg[i] * 56).toFixed(1)}`;
      dpath += " L200 60 Z";
      const area = q(".fz-area");
      if (CSS && CSS.supports && CSS.supports("d", 'path("M0 0")')) area.style.d = `path("${dpath}")`; else area.setAttribute("d", dpath);
      const cent = q(".fz-cent");
      cent.style.transform = `translateX(${(fz.score * 2).toFixed(1)}px)`;
      cent.style.setProperty("--tc", COLORS[fz.tier]);
      const fb = q(".t-fz");
      fb.textContent = fz.tier; fb.style.setProperty("--tc", COLORS[fz.tier]);
      tween(q(".n-score"), Math.round(fz.score));
      tween(q(".n-fzd"), Math.round(fz.demand));

      // formula strip with rolling numbers
      q(".f-basis").textContent = state.basis === "fuzzy" ? "fuzzy logic" : "survey formula";
      tween(q(".n-batch"), state.batch);
      tween(q(".n-dem"), Math.round(used * 100));
      tween(q(".n-rec"), rec);
      tween(q(".n-saved"), saved);
      tween(q(".n-kgp"), A.kg, 2);
      tween(q(".n-kg"), saved * A.kg, 1);
      tween(q(".n-saved2"), saved);
      tween(q(".n-kwhp"), A.kwh, 2);
      tween(q(".n-warm"), warmerKwh, 1);
      tween(q(".n-kwh"), kwh, 1);

      // cooking pot fills to the recommended share of the usual batch
      const liquid = q(".p-liquid");
      if (liquid) {
        const frac = Math.max(0, Math.min(rec / Math.max(state.batch, 1), 1));
        liquid.style.transform = `translateY(${(83 * (1 - frac)).toFixed(1)}px)`;
        tween(q(".n-pcook"), rec);
        tween(q(".n-pbatch"), state.batch);
      }
    }

    return { update, host };
  }

  function syncPlayButtons() {
    CALCS.forEach((c) => {
      const b = c.host.querySelector(".play-btn");
      b.textContent = PLAY.on ? "❚❚ Pause auto-play" : (state.time >= CLOSE ? "↺ Replay the day" : "▶ Auto-play the day");
      b.classList.toggle("on", PLAY.on);
      c.host.querySelectorAll(".speed-seg .seg-btn").forEach((s) => s.classList.toggle("active", +s.dataset.v === PLAY.speed));
    });
  }

  function startPlay() {
    if (state.time >= CLOSE) state.time = OPEN;
    PLAY.on = true;
    state.follow = false;
    clearInterval(PLAY.timer);
    PLAY.timer = setInterval(() => {
      if (state.time >= CLOSE) { stopPlay(); render(); return; }
      state.time = Math.min(CLOSE, state.time + STEP);
      render();
    }, 500 / PLAY.speed); // 1× = one hour of the day per second
    elog("SYS", `auto-play started at ${fmtTime(state.time)} (${PLAY.speed}× speed)`);
    syncPlayButtons();
    render();
  }

  function stopPlay() {
    PLAY.on = false;
    clearInterval(PLAY.timer);
    elog("SYS", `auto-play stopped at ${fmtTime(state.time)}`);
    syncPlayButtons();
  }

  function setSpeed(v) {
    PLAY.speed = v;
    if (PLAY.on) { stopPlay(); startPlay(); } else syncPlayButtons();
  }

  /* ------------------------------------------------------- engine console */
  // A "backend view": every prediction is traced step by step (data → features → decision tree →
  // fuzzy engine → advice), and training can be replayed in the browser on the same dataset.
  const ENG = { open: false, paused: false, lastSig: "", timer: null, runs: 0, training: false };
  const TAGS = { RUN: "#e6edf7", API: "#38bdf8", CAL: "#a78bfa", INPUT: "#94a3b8", RULE: "#fb923c", ENCODE: "#2dd4bf",
    TREE: "#34d399", FUZZY: "#fbbf24", ADVICE: "#f472b6", TIME: "#64748b", TRAIN: "#a3e635", SYS: "#64748b" };
  const stamp = () => { const d = new Date(); return d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0"); };

  function elog(tag, html, cls = "") {
    if (ENG.paused && tag !== "TRAIN" && tag !== "SYS") return;
    const box = $("eng-log");
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const ln = document.createElement("div");
    ln.className = `ln new ${cls}`;
    ln.innerHTML = `<span class="lt">${stamp()}</span><span class="tag" style="--tc:${TAGS[tag] || "#94a3b8"}">${tag}</span><span class="msg">${html}</span>`;
    box.appendChild(ln);
    while (box.childElementCount > 600) box.removeChild(box.firstChild);
    if (nearBottom || cls === "run") box.scrollTop = box.scrollHeight;
  }

  const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
  const msFmt = (ms) => (ms < 0.1 ? "<0.1 ms" : ms.toFixed(2) + " ms");
  const fmtFeat = (x) => CFG.features.map((f) => `${f}=${x[f]}`).join(" ");

  // called from render(); debounced and only logs when the inputs actually changed
  function engineRun(ctx) {
    const { sc, fz } = ctx;
    const sig = [sc.date, sc.min, sc.day, sc.calendar, sc.weather, sc.shortBreak, state.batch, state.basis, state.live,
      f2(fz.x.rain), Math.round(fz.x.air), Math.round(fz.x.day_demand)].join("|");
    if (sig === ENG.lastSig) return;
    clearTimeout(ENG.timer);
    ENG.timer = setTimeout(() => { ENG.lastSig = sig; trace(ctx); }, 220);
  }

  function trace({ sc, dem, fz, pred, used, rec, lo, hi, saved, kwh, tier }) {
    ENG.runs++;
    const p = sc.period;
    // re-time the two engines for the trace
    let t = performance.now(); predict(encode(sc)); const tTree = performance.now() - t;
    t = performance.now(); fuzzyInfer(fz.x); const tFz = performance.now() - t;

    elog("RUN", `── Run #${ENG.runs} · ${DAY_FULL[sc.day]} ${shortDate(sc.date)} · ${fmtTime(sc.min)} · ${p.name} (${fmtTime(p.start)}–${fmtTime(Math.min(p.end, CLOSE))}) · ${state.live ? "LIVE mode" : "MANUAL mode"} ──`, "run");
    elog("INPUT", `cafeteria=<b>${$("cafe").value}</b> usual_batch=<b>${state.batch}</b> short_breaks=<b>${state.shortBreak ? "yes" : "no"}</b> model_meal=<b>${sc.meal}</b>${p.surveyed ? "" : ' <span class="y">(period not surveyed → dinner-style rules)</span>'}`);

    const raw = WX.hours[sc.date] && WX.hours[sc.date][sc.hour];
    if (raw) elog("API", `forecast @ ${fmtHour(sc.hour)}: rain <b>${raw.rain.toFixed(1)} mm</b>, chance <b>${Math.round(raw.prob)}%</b>, code ${raw.code}, temp ${raw.temp != null ? Math.round(raw.temp) + "°C" : "–"}, PM2.5 <b>${raw.pm != null ? Math.round(raw.pm) : "n/a"}</b>${WX.updated ? ` · data from ${clock(WX.updated)}` : ""}`);
    else elog("API", `<span class="y">no hourly forecast for ${shortDate(sc.date)} ${fmtHour(sc.hour)}</span> → weather falls back to Clear`);

    elog("CAL", `${sc.date} → <b>${sc.cal.title}</b> (${sc.cal.sub || "no calendar entry"}) → calendar = <b>${sc.cal.calendar}</b>${sc.src.cal === "manual" ? ' <span class="y">overridden → ' + sc.calendar + "</span>" : ""}`);
    if (raw && sc.src.wx === "live") {
      const why = raw.rain >= RULES.heavyRainMm ? `${raw.rain.toFixed(1)} mm ≥ ${RULES.heavyRainMm} mm` : raw.prob >= RULES.heavyRainProb ? `chance ${Math.round(raw.prob)}% ≥ ${RULES.heavyRainProb}%`
        : raw.pm != null && raw.pm >= RULES.hazePm25 ? `PM2.5 ${Math.round(raw.pm)} ≥ ${RULES.hazePm25}` : "below every threshold";
      elog("RULE", `crisp weather rule: ${why} → weather = <b>${sc.weather}</b>`);
    } else elog("RULE", `weather = <b>${sc.weather}</b> (${sc.src.wx === "manual" ? "set by hand" : "fallback"})`);

    const x = encode(sc);
    elog("ENCODE", `feature vector x = [${CFG.features.map((f) => `<b>${x[f]}</b>`).join(", ")}]  ← ${fmtFeat(x)}`);

    elog("TREE", `walk trained DecisionTreeClassifier (depth ${D.metrics.tree_depth}, ${D.metrics.tree_leaves} leaves, ${D.metrics.train_rows.toLocaleString()} training rows)`);
    pred.path.forEach((s, k) => elog("TREE", `${"  ".repeat(k)}node ${s.node}: <b>${s.feature}</b> ≤ ${s.threshold}? x=${x[s.feature]} → <b>${s.yes ? "right (yes)" : "left (no)"}</b>  · ${s.samples.toLocaleString()} samples, gini ${f2(s.gini)}`));
    const P = (lbl) => f2(pred.probs[TREE.classes.indexOf(lbl)]);
    elog("TREE", `${"  ".repeat(pred.path.length)}leaf ${pred.leaf} → P(Low ${P("Low")}, Medium ${P("Medium")}, High ${P("High")}) →<b style="color:${COLORS[pred.tier]}">${pred.tier}</b> (${Math.round(pred.confidence * 100)}% of ${pred.leafSamples} training days)`);

    elog("FUZZY", `crisp inputs: day_demand <b>${Math.round(fz.x.day_demand)}%</b> · rain <b>${fz.x.rain.toFixed(1)} mm/h</b> · PM2.5 <b>${Math.round(fz.x.air)}</b>  (${fz.x.source})`);
    for (const k of Object.keys(FZ.inputs)) {
      elog("FUZZY", `fuzzify ${k}: ${Object.entries(fz.mu[k]).map(([s, v]) => `${s} <b class="${v > 0 ? "c" : ""}">${f2(v)}</b>`).join(" · ")}`);
    }
    fz.fired.slice(0, 6).forEach((r) => elog("FUZZY", `rule: IF ${r.day_demand} ∧ ${r.rain} ∧ ${r.air} THEN <b>${r.then}</b>  strength = min(${f2(fz.mu.day_demand[r.day_demand])}, ${f2(fz.mu.rain[r.rain])}, ${f2(fz.mu.air[r.air])}) = <b>${f2(r.strength)}</b>`));
    if (fz.fired.length > 6) elog("FUZZY", `… ${fz.fired.length - 6} more rules fired with lower strength`);
    elog("FUZZY", `${fz.fired.length}/${FZ.rules.length} rules fired → clip (min) → aggregate (max) over ${FZ_U.length} points → centroid <b>${f2(fz.score)}</b> → <b style="color:${COLORS[fz.tier]}">${fz.tier}</b> → demand ${Math.round(fz.demand)}%`);

    const basis = state.basis === "fuzzy" ? `fuzzy demand ${Math.round(fz.demand)}%` : `survey formula ${Math.round(dem.value * 100)}% (${dem.factors.map(([n, m]) => `${n} ×${m.toFixed(2)}`).join(" · ") || "normal day"})`;
    elog("ADVICE", `demand from ${basis}`);
    elog("ADVICE", `batch = ${state.batch} × ${Math.round(used * 100)}% = <b>${rec} portions</b> (range ${lo}–${hi}) · headline tier from tree: <b style="color:${COLORS[tier]}">${tier}</b> · saves ${saved} portions ≈ ${kwh.toFixed(1)} kWh`);
    elog("TIME", `tree ${msFmt(tTree)} · fuzzy ${msFmt(tFz)} · all in your browser, no server`);

    updatePipe({ sc, x, pred, fz, rec, tier, raw, tTree, tFz });
  }

  function updatePipe({ sc, x, pred, fz, rec, tier, raw, tTree, tFz }) {
    const bits = CFG.features.map((f) => `<span class="${x[f] ? "on" : ""}" title="${f}">${x[f]}</span>`).join("");
    const stages = [
      ["🛰️", "Data sources", raw ? `${raw.rain.toFixed(1)} mm · ${Math.round(raw.prob)}% · PM ${raw.pm != null ? Math.round(raw.pm) : "–"}` : "no forecast → Clear", WX.updated ? clock(WX.updated) : "–"],
      ["📅", "Calendar", sc.cal.title, sc.calendar.split(" ")[0]],
      ["🔢", "Feature encoding", `<div class="bits">${bits}</div>`, "8 features"],
      ["🌳", "Decision tree", `${pred.path.length} questions → leaf ${pred.leaf} → ${pred.tier}`, msFmt(tTree)],
      ["〰️", "Fuzzy engine", `${fz.fired.length} rules → centroid ${Math.round(fz.score)} → ${fz.tier}`, msFmt(tFz)],
      ["🍛", "Advice", `cook ${rec} · ${tier} risk`, state.basis],
    ];
    $("eng-pipe").innerHTML = stages.map(([i, n, v, m], k) => `${k ? '<div class="stage-arrow">▼</div>' : ""}
      <div class="stage lit" style="animation-delay:${k * 110}ms"><span class="si">${i}</span>
      <div><div class="sn">${n}</div><div class="sv">${v}</div></div><span class="sm">${m}</span></div>`).join("");
  }

  /* ---- training replay: CART decision tree (Gini) grown in the browser on the exported dataset ---- */
  function cart() {
    const T = D.training, F = T.features, K = T.labels.length;
    const train = T.rows.filter((r) => !r[2]), test = T.rows.filter((r) => r[2]);
    const counts = (rs) => { const c = new Array(K).fill(0); rs.forEach((r) => c[r[1]]++); return c; };
    const gini = (c, n) => 1 - c.reduce((s, v) => s + (v / n) ** 2, 0);
    const events = [];
    let nodes = 0, leaves = 0, maxDepth = 0;
    function grow(rs, depth, path) {
      const c = counts(rs), n = rs.length, g = gini(c, n), id = nodes++;
      maxDepth = Math.max(maxDepth, depth);
      const leaf = () => { leaves++; const cls = c.indexOf(Math.max(...c)); events.push({ type: "leaf", depth, n, c, cls, path }); return { cls }; };
      if (depth >= T.max_depth || n < 2 * T.min_samples_leaf || g === 0) return leaf();
      let best = null;
      F.forEach((f, i) => {
        const L = rs.filter((r) => !((r[0] >> i) & 1)), R = rs.filter((r) => (r[0] >> i) & 1);
        if (L.length < T.min_samples_leaf || R.length < T.min_samples_leaf) return;
        const w = (L.length * gini(counts(L), L.length) + R.length * gini(counts(R), R.length)) / n;
        if (!best || w < best.w - 1e-12) best = { i, f, w, L, R };
      });
      if (!best || best.w >= g - 1e-12) return leaf();
      events.push({ type: "split", id, depth, n, g, w: best.w, f: best.f, path, nodes, leaves });
      return { i: best.i, left: grow(best.L, depth + 1, [...path, `${best.f}=0`]), right: grow(best.R, depth + 1, [...path, `${best.f}=1`]) };
    }
    const tree = grow(train, 0, []);
    const classify = (bits) => { let nd = tree; while (nd.cls === undefined) nd = (bits >> nd.i) & 1 ? nd.right : nd.left; return nd.cls; };
    const correct = test.filter((r) => classify(r[0]) === r[1]).length;
    return { events, nodes, leaves, maxDepth, train: train.length, test: test.length, acc: correct / test.length, correct };
  }

  function replayTraining() {
    if (ENG.training || !D.training) return;
    ENG.training = true;
    $("eng-train").disabled = true;
    $("eng-dot").className = "eng-dot busy";
    const panel = $("eng-trainpanel");
    $("eng-pipe").hidden = true; panel.hidden = false;
    const t0 = performance.now();
    const res = cart();
    const ms = performance.now() - t0;
    const splits = res.events.filter((e) => e.type === "split");
    panel.innerHTML = `<div class="tp-title">🧠 Learning engine: training replay</div>
      <div class="tp-bar"><div id="tp-bar"></div></div>
      <div class="tp-stats">
        <div class="tp-stat"><span>Training rows</span><strong>${res.train.toLocaleString()}</strong></div>
        <div class="tp-stat"><span>Splits learned</span><strong id="tp-splits">0</strong></div>
        <div class="tp-stat"><span>Current depth</span><strong id="tp-depth">0</strong></div>
        <div class="tp-stat"><span>Leaves</span><strong id="tp-leaves">0</strong></div>
      </div>
      <div class="tp-now" id="tp-now">Starting…</div>
      <div id="tp-result"></div>`;
    elog("RUN", "── Training replay: CART decision tree, Gini impurity, same data & settings as the Python model ──", "run");
    elog("TRAIN", `load ${D.training.rows.length.toLocaleString()} simulated service days → split 75/25 (same split as Python) → <b>${res.train.toLocaleString()} train</b> / <b>${res.test.toLocaleString()} test</b>`);
    elog("TRAIN", `settings: max_depth=${D.training.max_depth}, min_samples_leaf=${D.training.min_samples_leaf}, criterion=gini · features: ${D.training.features.join(", ")}`);
    let k = 0, leavesSeen = 0;
    const step = () => {
      const batch = Math.max(1, Math.ceil(res.events.length / 90));
      for (let j = 0; j < batch && k < res.events.length; j++, k++) {
        const e = res.events[k];
        if (e.type === "split") {
          const where = e.path.length ? e.path.join(" ∧ ") : "root (all training days)";
          elog("TRAIN", `${"  ".repeat(e.depth)}split #${splits.indexOf(e) + 1} @ depth ${e.depth} [${where}] n=${e.n.toLocaleString()} → ask <b>${e.f}?</b>  gini ${f2(e.g)} → ${f2(e.w)} (gain <span class="g">${f2(e.g - e.w)}</span>)`);
          $("tp-splits").textContent = splits.indexOf(e) + 1;
          $("tp-depth").textContent = e.depth + 1;
          $("tp-now").innerHTML = `testing 8 questions at [${where}]<br>best: <b>${e.f}</b>, impurity ${f2(e.g)} → ${f2(e.w)}`;
        } else {
          leavesSeen++;
          $("tp-leaves").textContent = leavesSeen;
        }
      }
      $("tp-bar").style.width = (k / res.events.length) * 100 + "%";
      if (k < res.events.length) { setTimeout(step, 40); return; }
      // done
      const pyAcc = D.metrics.test_accuracy;
      elog("TRAIN", `grown in ${ms.toFixed(1)} ms → ${splits.length} splits, ${res.leaves} leaves, depth ${res.maxDepth}`);
      elog("TRAIN", `evaluate on ${res.test.toLocaleString()} unseen test days → <b class="g">${res.correct.toLocaleString()} correct = ${(res.acc * 100).toFixed(1)}% accuracy</b> (Python/scikit-learn model: ${(pyAcc * 100).toFixed(1)}%)`);
      elog("TRAIN", `the dashboard keeps using the exported scikit-learn model; this replay shows how it was learned`);
      $("tp-now").textContent = "Training complete.";
      $("tp-result").innerHTML = `<div class="tp-result">✅ <b>${(res.acc * 100).toFixed(1)}%</b> test accuracy (${res.correct.toLocaleString()} / ${res.test.toLocaleString()}) · ${splits.length} splits · ${res.leaves} leaves.<br>Python model: <b>${(pyAcc * 100).toFixed(1)}%</b>. <a href="#" id="tp-back">Back to live pipeline</a></div>`;
      $("tp-back").onclick = (ev) => { ev.preventDefault(); panel.hidden = true; $("eng-pipe").hidden = false; };
      ENG.training = false;
      $("eng-train").disabled = false;
      $("eng-dot").className = "eng-dot" + (ENG.paused ? " paused" : "");
    };
    step();
  }

  function setupEngine() {
    $("eng-clear").onclick = () => { $("eng-log").innerHTML = ""; elog("SYS", "log cleared"); };
    $("eng-pause").onclick = () => {
      ENG.paused = !ENG.paused;
      $("eng-pause").textContent = ENG.paused ? "▶ Resume" : "❚❚ Pause";
      $("eng-dot").className = "eng-dot" + (ENG.paused ? " paused" : "");
      elog("SYS", ENG.paused ? "paused: new runs are not logged" : "resumed");
      if (!ENG.paused) { ENG.lastSig = ""; render(); }
    };
    $("eng-train").onclick = replayTraining;
    $("eng-time").oninput = (e) => setTime(+e.target.value);
    document.querySelectorAll("[data-goto]").forEach((el) => el.onclick = (e) => { e.preventDefault(); showTab(el.dataset.goto); window.scrollTo({ top: 0 }); });
    elog("SYS", `engine ready · decision tree: ${D.metrics.tree_leaves} leaves, test accuracy ${(D.metrics.test_accuracy * 100).toFixed(1)}% · fuzzy: Mamdani, ${FZ.rules.length} rules · model built ${D.generated}`);
  }

  // header of the engine tab: what is being traced right now
  function renderEngineHeader(sc, tier, rec) {
    $("eng-time").value = state.time;
    $("eng-time-lbl").textContent = `${fmtTime(state.time)} · ${sc.period.name}`;
    $("eng-now-title").innerHTML = `${DAY_FULL[sc.day]}${state.live ? " " + shortDate(sc.date) : ""} · ${fmtTime(state.time)} · <span style="color:${COLORS[tier]}">${tier} risk</span> · cook ${rec}`;
    $("eng-now-sub").textContent = `${sc.calendar} · ${sc.weather} · ${$("cafe").value} · usual batch ${state.batch} · ${state.live ? "live data" : "manual mode"}`;
  }

  /* ---------------------------------------------------------- chart utils */
  function baseOpts(scales = {}, extra = {}) {
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "rectRounded" } } },
      scales: {
        x: { grid: { display: false }, border: { color: GRID }, ...(scales.x || {}) },
        y: { grid: { color: GRID }, border: { display: false }, beginAtZero: true, ...(scales.y || {}) },
      },
      indexAxis: extra.indexAxis || "x",
    };
  }
  const pctTick = { callback: (v) => v + "%" };
  function hbar(id, obj, color, opts = {}) {
    const labels = Object.keys(obj), vals = labels.map((k) => obj[k].pct);
    return new Chart($(id), {
      type: "bar",
      data: { labels, datasets: [{ data: vals, backgroundColor: color, borderRadius: 6, maxBarThickness: 26 }] },
      options: {
        ...baseOpts({ x: { grid: { color: GRID }, ticks: pctTick, beginAtZero: true, max: opts.max }, y: { grid: { display: false } } }, { indexAxis: "y" }),
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.x}% (${obj[c.label].count} students)` } } },
      },
    });
  }

  /* ------------------------------------------------------------- insights */
  let insightsBuilt = false;
  function buildInsights() {
    if (insightsBuilt) return;
    insightsBuilt = true;
    const multLabels = { exam_week: "Exam week", friday: "Friday", haze: "Hazy day", weekend: "Weekend", short_break: "Short breaks (lunch)", heavy_rain: "Heavy rain", holiday: "Holiday / break" };
    const keys = Object.keys(multLabels).sort((a, b) => M[b] - M[a]);
    const vals = keys.map((k) => Math.round(M[k] * 100));
    const th = CFG.risk_thresholds;
    new Chart($("ch-mult"), {
      type: "bar",
      data: { labels: ["Normal weekday", ...keys.map((k) => multLabels[k])],
        datasets: [{ data: [100, ...vals], borderRadius: 6, maxBarThickness: 26,
          backgroundColor: [COLORS.grey, ...vals.map((v) => v >= th.Low * 100 ? COLORS.Low : v >= th.Medium * 100 ? COLORS.Medium : COLORS.High)] }] },
      options: { ...baseOpts({ x: { grid: { color: GRID }, ticks: pctTick, max: 100 }, y: { grid: { display: false } } }, { indexAxis: "y" }),
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.x}% of normal-day demand` } } } },
    });

    const lk = { exam_week: "Exam week", friday: "Friday", weekend: "Weekend", haze: "Haze", heavy_rain: "Heavy rain" };
    const levels = ["Very unlikely", "Somewhat unlikely", "Neither likely nor unlikely", "Somewhat likely", "Very likely"];
    const lkColors = [COLORS.High, "#fb923c", COLORS.grey, COLORS.brand, COLORS.teal];
    new Chart($("ch-likert"), {
      type: "bar",
      data: { labels: Object.values(lk),
        datasets: levels.map((lv, i) => ({ label: lv.replace(" nor unlikely", ""), data: Object.keys(lk).map((k) => S.likert[k][lv].pct), backgroundColor: lkColors[i], maxBarThickness: 30 })) },
      options: { ...baseOpts({ x: { stacked: true, max: 100, ticks: pctTick, grid: { color: GRID } }, y: { stacked: true, grid: { display: false } } }, { indexAxis: "y" }),
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.x}%` } } } },
    });

    hbar("ch-lunch", S.lunch_time, COLORS.brand);
    hbar("ch-meals", S.meals, COLORS.teal, { max: 100 });
    hbar("ch-days", S.days_per_week, COLORS.brand);
    hbar("ch-break", S.short_break, COLORS.teal);
    hbar("ch-reason", Object.fromEntries(Object.entries(S.leave_reason).sort((a, b) => b[1].pct - a[1].pct)), "#fb923c");
    hbar("ch-forecast", S.forecast_reaction, COLORS.teal);
    hbar("ch-village", S.residence, "#818cf8");
    hbar("ch-year", S.year, "#818cf8");
  }

  function fillStats() {
    document.querySelectorAll('[data-bind="n"]').forEach((e) => (e.textContent = S.n));
    const lr = S.likert.heavy_rain;
    $("st-rain").textContent = Math.round(lr["Very unlikely"].pct + lr["Somewhat unlikely"].pct) + "%";
    $("st-holiday").textContent = Math.round(S.holiday_stay.Never.pct + S.holiday_stay.Rarely.pct) + "%";
    $("st-plate").textContent = Math.round(S.leave_food.Never.pct + S.leave_food.Rarely.pct) + "%";
    $("st-forecast").textContent = Math.round(S.forecast_reaction["Eat somewhere else"].pct + S.forecast_reaction["Eat earlier or later"].pct) + "%";
    $("gen-date").textContent = D.generated;
    $("r-rain").textContent = RULES.heavyRainMm;
    $("r-prob").textContent = RULES.heavyRainProb;
    $("r-pm").textContent = RULES.hazePm25;
    $("cal-verify").textContent = `All semesters (Jan 2026 to Sept 2027), blended-learning and no-physical-class weeks, and public holidays come from the official ${CAL.source || "UTP academic calendar"}. Blended-learning weeks stay as normal weeks, because students living in the villages still eat on campus.`;
  }

  /* ---------------------------------------------------------------- model */
  let modelBuilt = false;
  function buildModel() {
    if (modelBuilt) return;
    modelBuilt = true;
    const mt = D.metrics;
    $("m-acc").textContent = Math.round(mt.test_accuracy * 1000) / 10 + "%";
    $("m-agree").textContent = Math.round(mt.agreement_with_survey_rule * 1000) / 10 + "%";
    $("m-leaves").textContent = mt.tree_leaves;
    $("m-depth").textContent = mt.tree_depth;
    $("m-rows").textContent = fmt(mt.train_rows + mt.test_rows);

    const imp = Object.entries(mt.feature_importance).sort((a, b) => b[1] - a[1]);
    new Chart($("ch-imp"), {
      type: "bar",
      data: { labels: imp.map(([k]) => CFG.feature_labels[k]), datasets: [{ data: imp.map(([, v]) => Math.round(v * 1000) / 10),
        backgroundColor: imp.map((_, i) => i < 3 ? COLORS.brand : "#2a5b78"), borderRadius: 6, maxBarThickness: 22 }] },
      options: { ...baseOpts({ x: { grid: { color: GRID }, ticks: pctTick }, y: { grid: { display: false } } }, { indexAxis: "y" }), plugins: { legend: { display: false } } },
    });

    const cm = mt.confusion_matrix, max = Math.max(...cm.matrix.flat());
    let html = `<div class="h"></div>` + cm.labels.map((l) => `<div class="h">${l}</div>`).join("");
    cm.matrix.forEach((row, i) => {
      html += `<div class="h">${cm.labels[i]}</div>`;
      row.forEach((v, j) => {
        const a = v / max;
        const bg = i === j ? `rgba(56,189,248,${0.12 + 0.55 * a})` : v ? `rgba(248,113,113,${0.12 + 0.5 * a})` : "rgba(148,163,184,.06)";
        html += `<div class="c" style="background:${bg}">${v}</div>`;
      });
    });
    $("cm").innerHTML = html;

    const tb = $("tests");
    tb.innerHTML = `<thead><tr><th>Scenario</th><th>Meal</th><th>Calendar</th><th>Weather</th><th class="num">Demand</th><th>Risk</th><th class="num">Confidence</th><th class="num">Cook (of 100)</th></tr></thead><tbody>` +
      D.test_scenarios.map((t, i) => `<tr data-i="${i}"><td><strong>${t.scenario}</strong></td><td>${t.meal}</td><td>${t.calendar}</td><td>${t.weather}${t.short_break ? " · short breaks" : ""}</td><td class="num">${t.expected_demand_pct}%</td><td><span class="t t-${t.predicted_risk}">${t.predicted_risk}</span></td><td class="num">${t.confidence_pct}%</td><td class="num">${t.recommended_batch_if_usual_100}</td></tr>`).join("") + "</tbody>";
    tb.querySelectorAll("tbody tr").forEach((tr) => tr.onclick = () => {
      const t = D.test_scenarios[+tr.dataset.i];
      Object.assign(state, { live: false, follow: false, ovCal: false, ovWx: false, day: t.day, time: t.meal === "Lunch" ? 750 : 1110,
        calendar: t.calendar, weather: t.weather, shortBreak: t.short_break, batch: 100 });
      $("live").checked = false;
      showTab("predict"); render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    buildFuzzyModel();
    $("m-base").textContent = S.baseline_weekday_probability;
    $("m-floor").textContent = Math.round(CFG.demand_floor * 100);
    $("m-low").textContent = Math.round(CFG.risk_thresholds.Low * 100);
    $("m-med").textContent = Math.round(CFG.risk_thresholds.Medium * 100);
  }

  /* ---------------------------------------------------------------- guide */
  // "?" buttons on each card open the matching guide section; "Show me →" in the guide
  // jumps back to that part of the dashboard and highlights it.
  function spotlight(el) {
    if (!el) return;
    el.classList.remove("spot"); void el.offsetWidth; el.classList.add("spot");
    setTimeout(() => el.classList.remove("spot"), 2300);
  }

  function goGuide(id) {
    showTab("guide");
    const el = $(id);
    if (!el) return;
    setTimeout(() => { el.scrollIntoView({ behavior: "auto", block: "start" }); spotlight(el); }, 40);
  }

  function setupGuide() {
    const headingWith = (sel, text) => [...document.querySelectorAll(sel)].find((h) => h.textContent.includes(text));
    const HELP = [
      [document.querySelector(".inputs h2"), "g-inputs"],
      [document.querySelector(".date-label > span"), "g-date"],
      [document.querySelector(".time-card .live-lbl"), "g-time"],
      [document.querySelector("#calc-main .calc-head h3"), "g-calc"],
      [document.querySelector("#calc-eng .calc-head h3"), "g-calc"],
      [document.querySelector("#wx-card .live-lbl"), "g-live"],
      [document.querySelector("#cal-card .live-lbl"), "g-live"],
      [document.querySelector(".risk-title"), "g-risk"],
      [document.querySelector(".kpi.primary .kpi-lbl"), "g-kpi"],
      [document.querySelector(".fuzzy-card h3"), "g-fuzzy"],
      [headingWith("#tab-predict h3", "Automatic forecast"), "g-analysis"],
      [headingWith("#tab-predict h3", "Cooking"), "g-plan"],
      [headingWith("#tab-predict h3", "Why the model"), "g-why"],
      [headingWith("#tab-predict h3", "Next 7 days"), "g-week"],
      [headingWith("#tab-predict h3", "Expected customers"), "g-slots"],
      [document.querySelector("#tab-insights .insight-grid h3"), "g-insights"],
      [document.querySelector("#tab-model h3"), "g-model"],
      [document.querySelector(".eng-title strong"), "g-engine"],
    ];
    HELP.forEach(([el, id]) => {
      if (!el) return;
      const b = document.createElement("button");
      b.type = "button"; b.className = "help-i"; b.textContent = "?";
      b.title = "What is this? Open the guide"; b.setAttribute("aria-label", "Help: open the guide for this part");
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); goGuide(id); };
      el.appendChild(b);
    });

    document.querySelectorAll(".g-jump").forEach((b) => b.onclick = () => {
      showTab(b.dataset.tab);
      const el = document.querySelector(b.dataset.jump);
      if (!el) return;
      setTimeout(() => { el.scrollIntoView({ behavior: "auto", block: "center" }); spotlight(el.closest(".card") || el); }, 40);
    });

    // contents list: smooth scroll + highlight the section being read
    const links = [...document.querySelectorAll(".g-toc a")];
    links.forEach((a) => a.onclick = (e) => {
      e.preventDefault();
      const el = document.querySelector(a.getAttribute("href"));
      if (el) el.scrollIntoView({ behavior: RM || document.hidden ? "auto" : "smooth", block: "start" });
    });
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + en.target.id));
        });
      }, { rootMargin: "-130px 0px -60% 0px" });
      document.querySelectorAll(".g-body > article[id]").forEach((s) => io.observe(s));
    }
  }

  /* ---------------------------------------------------------------- theme */
  function applyChartDefaults() {
    Chart.defaults.color = TH.text;
    Chart.defaults.borderColor = TH.grid;
    Object.assign(Chart.defaults.plugins.tooltip, { backgroundColor: TH.tipBg, borderColor: TH.tipBorder, titleColor: TH.tipText, bodyColor: TH.tipText });
  }

  function setTheme(name) {
    THEME = name; TH = THEMES[name]; GRID = TH.grid;
    Object.assign(COLORS, TH.colors); setSoft();
    document.documentElement.dataset.theme = name;
    document.querySelector('meta[name="theme-color"]').setAttribute("content", TH.meta);
    $("theme-btn").setAttribute("aria-label", name === "dark" ? "Switch to light mode" : "Switch to dark mode");
    try { localStorage.setItem("advisor-theme", name); } catch (e) { /* storage unavailable: theme still applies */ }
    if (!window.Chart || !Chart.instances) { render(); return; }
    applyChartDefaults();
    // charts are rebuilt so every axis, grid line and tier colour picks up the new palette
    rebuildCharts();
    render();
  }

  function rebuildCharts() {
    Object.values(Chart.instances).forEach((ch) => ch.destroy());
    dayChart = null; slotChart = null;
    for (const k of Object.keys(fzCharts)) delete fzCharts[k];
    const insightsWas = insightsBuilt, modelWas = modelBuilt;
    insightsBuilt = false; modelBuilt = false;
    if (insightsWas) buildInsights();
    if (modelWas) buildModel();
  }

  /* ----------------------------------------------------------------- tabs */
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
    if (name === "insights") buildInsights();
    if (name === "model") buildModel();
    if (name === "engine") { ENG.lastSig = ""; render(); }
  }

  /* ----------------------------------------------------------------- init */
  if (window.Chart) {
    Chart.defaults.font.family = "Inter, system-ui, sans-serif";
    applyChartDefaults();
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.padding = 10;
  } else {
    window.Chart = function () { return { update() {}, data: { datasets: [{}] } }; }; // offline: skip charts
  }
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
  $("theme-btn").onclick = () => setTheme(THEME === "dark" ? "light" : "dark");
  $("theme-btn").setAttribute("aria-label", THEME === "dark" ? "Switch to light mode" : "Switch to dark mode");
  buildControls();
  CALCS = [createCalc($("calc-main"), false), createCalc($("calc-eng"), true)].filter(Boolean);
  syncPlayButtons();
  setupEngine();
  setupGuide();
  fillStats();
  buildModel(); // assumption inputs live in the model tab and are read by render()
  render();
  refreshWeather("initial");
  setInterval(() => refreshWeather("auto"), REFRESH_MS);
  // every 30 s: keep "updated x min ago" fresh and, while following the clock, move the slider with time
  setInterval(() => {
    if (state.live && state.follow) {
      const k = klParts();
      if (k.iso !== state.date) state.date = k.iso;
      state.time = nowSlot();
    }
    render();
  }, 30000);

  // small hook for demos / testing in the browser console
  window.BatchAdvisor = { refresh: () => refreshWeather("manual"), state, weather: WX };
})();
