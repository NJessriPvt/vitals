'use strict';
/**
 * vitals — view controller.
 *
 * Four screens, three endpoints. Each screen asks a different question and gets a
 * payload built for it, so the browser renders rather than computes: no screen
 * derives a total, an average or a zone here. Anything that looks like arithmetic in
 * this file is a formatting decision, not a health figure.
 *
 * COLOUR FOLLOWS THE ENTITY. A metric's colour comes from its position in a fixed
 * list, never from its position in the current view, so a value keeps its colour
 * wherever it appears.
 */

import {
  lineChart, barChart, zoneBars, hypnogram, fmtNumber,
} from './charts.js';

const $ = (id) => document.getElementById(id);
const api = (p) => `./api/${p}`;
const DAY_MS = 86400000;

const state = {
  view: 'day',
  date: null,          // YYYY-MM-DD for the day/sleep screens
  hours: 24,           // "last X hours" filter on the day screen
  sleepDays: 7,
  status: null,
  data: null,
  loading: false,
};

// Fixed colour per metric, so steps are the same colour on every screen.
const TINT = {
  steps: 1, distance: 2, cardioLoad: 3, calories: 4, heart: 6, sleep: 5,
};
const tint = (name) => `var(--series-${TINT[name] || 1})`;

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== null && text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function card(title, sub) {
  const c = el('section', null, 'card');
  if (title) {
    const head = el('div', null, 'card-head');
    const left = el('div');
    left.appendChild(el('h2', title));
    if (sub) left.appendChild(el('p', sub, 'card-sub'));
    head.appendChild(left);
    c.appendChild(head);
    c.head = head;
  }
  return c;
}

/** A metric tile. `sub` carries the caveat — derived, source, goal. */
function metric(label, value, unit, sub, colorName) {
  const m = el('div', null, 'metric');
  m.style.setProperty('--tint', tint(colorName));
  m.appendChild(el('div', label, 'metric-label'));
  const v = el('div', null, 'metric-value');
  // Formatters already render an absent value as an em dash, so test the RENDERED
  // text, not the argument — otherwise a missing metric reads "— AZM", a unit
  // attached to nothing.
  const shown = value === null || value === undefined || value === '' ? '—' : String(value);
  v.appendChild(document.createTextNode(shown));
  if (unit && shown !== '—') v.appendChild(el('span', ` ${unit}`, 'metric-unit'));
  m.appendChild(v);
  const s = el('div', null, 'metric-sub');
  if (sub) {
    if (sub.derived) {
      const d = el('span', 'derived', 'derived');
      s.append(d, document.createTextNode(` ${sub.text || ''}`));
    } else {
      s.textContent = sub.text || sub;
    }
  }
  m.appendChild(s);
  return m;
}

function segmented(options, current, onPick) {
  const wrap = el('div', null, 'seg');
  for (const [value, label] of options) {
    const b = el('button', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(value === current));
    b.addEventListener('click', () => onPick(value));
    wrap.appendChild(b);
  }
  return wrap;
}

const hhmm = (h) => (h === null || h === undefined ? '—'
  : `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`);

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const tzMs = () => -new Date().getTimezoneOffset() * 60000;
const todayStr = () => new Date(Date.now() + tzMs()).toISOString().slice(0, 10);

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

function prettyDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (dateStr === todayStr()) return 'Today';
  if (dateStr === shiftDate(todayStr(), -1)) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Day screen
// ---------------------------------------------------------------------------

function renderDay(d) {
  const main = $('view');
  main.replaceChildren();
  const h = d.headline;

  // --- headline metrics ----------------------------------------------------
  const metrics = el('section', null, 'metrics');
  metrics.append(
    metric('Steps', fmtNumber(h.steps, 0), '', h.steps !== null && d.goals.steps
      ? { text: `goal ${fmtNumber(d.goals.steps, 0, true)}` } : null, 'steps'),
    metric('Distance', h.distanceKm === null ? null : h.distanceKm.toFixed(2), 'km', null, 'distance'),
    metric('Cardio load', fmtNumber(h.cardioLoad, 0), '',
      { derived: true, text: `${Math.round(d.zones.total.trackedMinutes)} min tracked` }, 'cardioLoad'),
    metric('Energy burned', fmtNumber(h.activeCalories, 0), 'kcal',
      h.totalCalories ? { text: `${fmtNumber(h.totalCalories, 0)} total` } : null, 'calories'),
    metric('Sleep', hhmm(h.sleepHours), '',
      h.sleepEfficiencyPercent ? { text: `${h.sleepEfficiencyPercent}% efficiency` } : null, 'sleep'),
    metric('Heart rate',
      h.heartRate ? `${h.heartRate.min}–${h.heartRate.max}` : null, 'bpm',
      h.heartRate ? { text: `avg ${h.heartRate.avg}` } : null, 'heart'),
    metric('Resting HR', fmtNumber(h.restingHeartRate, 0), 'bpm',
      h.restingHeartRateSource === 'derived'
        ? { derived: true, text: 'lowest while asleep' } : null, 'heart'),
    metric('Active zone min', fmtNumber(h.activeZoneMinutes, 0), 'AZM', null, 'cardioLoad'),
  );
  main.appendChild(metrics);

  // --- heart rate through the day -----------------------------------------
  const hrCard = card('Heart rate', `${d.heartRateTrace.points.length} points · min/max band`);
  const hrHost = el('div', null, 'chart');
  hrCard.appendChild(hrHost);
  main.appendChild(hrCard);

  // --- zones ---------------------------------------------------------------
  const zoneCard = card('Time in zones',
    `Zones 1–6 by % of max HR (${d.zones.maxHeartRate} bpm, from age ${d.age}) · derived from raw samples`);
  const zoneHost = el('div');
  zoneCard.appendChild(zoneHost);
  main.appendChild(zoneCard);

  // --- hourly, with the last-X-hours filter --------------------------------
  const hourCard = card('Through the day', 'Cardio load and calories per hour');
  const filter = segmented(
    [[24, 'All day'], [12, 'Last 12h'], [6, 'Last 6h'], [3, 'Last 3h']],
    state.hours,
    (v) => { state.hours = v; renderDay(d); },
  );
  hourCard.head.appendChild(filter);

  const loadHost = el('div', null, 'chart');
  const calLabel = el('p', 'Calories per hour', 'card-sub');
  const calHost = el('div', null, 'chart');
  const stepLabel = el('p', 'Steps per hour', 'card-sub');
  const stepHost = el('div', null, 'chart');
  hourCard.append(el('p', 'Cardio load per hour', 'card-sub'), loadHost, calLabel, calHost, stepLabel, stepHost);
  main.appendChild(hourCard);

  // --- sleep summary -------------------------------------------------------
  if (d.sleep) {
    const sleepCard = card('Last night', 'Tap Sleep for the full night');
    const hypHost = el('div', null, 'hypno');
    sleepCard.appendChild(hypHost);
    main.appendChild(sleepCard);
    requestAnimationFrame(() => hypnogram(hypHost, d.sleep.timeline, {
      from: Date.parse(d.sleep.bedtime), to: Date.parse(d.sleep.wakeTime),
    }));
  }

  // Charts after layout, so they measure a real width.
  requestAnimationFrame(() => {
    const height = window.innerWidth < 560 ? 170 : 210;

    lineChart(hrHost, {
      points: d.heartRateTrace.points, unit: 'bpm', precision: 0,
      bucketMs: d.heartRateTrace.bucketMs, label: 'Heart rate',
      band: true, color: getComputedStyle(document.documentElement).getPropertyValue('--series-6').trim(),
    }, height);

    zoneBars(zoneHost, d.zones.zones, d.zones.total.minutes);

    // The filter trims the window; the payload is always the whole day, so this is
    // a display slice and never a different question asked of the server.
    const cut = (rows) => (state.hours >= 24 ? rows : rows.slice(-state.hours));
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

    barChart(loadHost, {
      points: cut(d.hourly.cardioLoad), unit: 'load', precision: 0,
      bucketMs: d.hourly.bucketMs, label: 'Cardio load', color: css('--series-3'),
    }, height);
    barChart(calHost, {
      points: cut(d.hourly.activeCalories), unit: 'kcal', precision: 0,
      bucketMs: d.hourly.bucketMs, label: 'Calories', color: css('--series-4'),
    }, height);
    barChart(stepHost, {
      points: cut(d.hourly.steps), unit: 'steps', precision: 0,
      bucketMs: d.hourly.bucketMs, label: 'Steps', color: css('--series-1'),
    }, height);
  });
}

// ---------------------------------------------------------------------------
// Week / Month screen
// ---------------------------------------------------------------------------

const OVERVIEW_COLUMNS = [
  ['date', 'Day', (r) => prettyDate(r.date)],
  ['steps', 'Steps', (r) => fmtNumber(r.steps, 0)],
  ['distanceKm', 'Dist (km)', (r) => (r.distanceKm === null ? '—' : r.distanceKm.toFixed(2))],
  ['cardioLoad', 'Load', (r) => fmtNumber(r.cardioLoad, 0)],
  ['activeCalories', 'Active kcal', (r) => fmtNumber(r.activeCalories, 0)],
  ['sleepHours', 'Sleep', (r) => (r.sleepHours === null ? '—' : hhmm(r.sleepHours))],
  ['hr', 'HR min–max', (r) => (r.heartRate ? `${r.heartRate.min}–${r.heartRate.max}` : '—')],
];

function renderOverview(d) {
  const main = $('view');
  main.replaceChildren();
  const a = d.averages;

  const metrics = el('section', null, 'metrics');
  metrics.append(
    metric('Steps / day', fmtNumber(a.stepsPerDay, 0), '', { text: `${fmtNumber(d.totals.steps, 0, true)} total` }, 'steps'),
    metric('Distance / day', a.distanceKmPerDay === null ? null : a.distanceKmPerDay.toFixed(2), 'km',
      { text: `${d.totals.distanceKm} km total` }, 'distance'),
    metric('Cardio load / day', fmtNumber(a.cardioLoadPerDay, 0), '',
      { derived: true, text: `${fmtNumber(d.totals.cardioLoad, 0)} total` }, 'cardioLoad'),
    metric('Active kcal / day', fmtNumber(a.activeCaloriesPerDay, 0), 'kcal', null, 'calories'),
    metric('Sleep / night', hhmm(a.sleepHoursPerNight), '', null, 'sleep'),
    metric('AZM / day', fmtNumber(a.activeZoneMinutesPerDay, 0), '', null, 'cardioLoad'),
  );
  main.appendChild(metrics);

  const chartsCard = card(`Per day · last ${d.days} days`, 'One bar per day, so gaps are real gaps');
  const hosts = {};
  for (const [key, label, color] of [
    ['steps', 'Steps', '--series-1'],
    ['cardioLoad', 'Cardio load', '--series-3'],
    ['sleepHours', 'Sleep (hours)', '--series-5'],
    ['activeCalories', 'Active calories', '--series-4'],
  ]) {
    chartsCard.appendChild(el('p', label, 'card-sub'));
    hosts[key] = el('div', null, 'chart');
    hosts[key].dataset.color = color;
    chartsCard.appendChild(hosts[key]);
  }
  main.appendChild(chartsCard);

  const tableCard = card('Compare', 'Every metric, day by day');
  const wrap = el('div', null, 'table-wrap');
  const table = el('table', null, 'data-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const [, label] of OVERVIEW_COLUMNS) hr.appendChild(el('th', label));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const row of [...d.rows].reverse()) {
    const tr = el('tr');
    for (const [key, , fmt] of OVERVIEW_COLUMNS) {
      const td = el('td', fmt(row));
      if (key !== 'date' && (row[key] === null || row[key] === undefined)) td.className = 'dim';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  tableCard.appendChild(wrap);
  main.appendChild(tableCard);

  requestAnimationFrame(() => {
    const height = window.innerWidth < 560 ? 150 : 190;
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    for (const [key, host] of Object.entries(hosts)) {
      barChart(host, {
        points: d.rows.map((r) => ({ t: r.t, v: r[key] })),
        unit: '', precision: key === 'sleepHours' ? 1 : 0,
        bucketMs: DAY_MS, label: key, color: css(host.dataset.color),
      }, height);
    }
  });
}

// ---------------------------------------------------------------------------
// Sleep screen
// ---------------------------------------------------------------------------

function renderSleep(d) {
  const main = $('view');
  main.replaceChildren();
  const n = d.night;
  const a = d.averages;

  const metrics = el('section', null, 'metrics');
  metrics.append(
    metric('Asleep', hhmm(n ? n.hoursAsleep : null), '',
      d.goalHours ? { text: `goal ${d.goalHours}h` } : null, 'sleep'),
    metric('In bed', hhmm(n ? n.hoursInBed : null), '', null, 'sleep'),
    metric('Efficiency', n && n.efficiencyPercent !== null ? n.efficiencyPercent : null, '%',
      { text: 'asleep ÷ in bed' }, 'sleep'),
    metric('Deep', hhmm(n && n.stageHours ? n.stageHours.deep : null), '', null, 'sleep'),
    metric('REM', hhmm(n && n.stageHours ? n.stageHours.rem : null), '', null, 'sleep'),
    metric('Awake', hhmm(n && n.stageHours ? n.stageHours.awake : null), '', null, 'sleep'),
  );
  main.appendChild(metrics);

  const nightCard = card('The night', n && n.bedtime
    ? `${new Date(n.bedtime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} → ${new Date(n.wakeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'No staged sleep recorded');
  const hypHost = el('div', null, 'hypno');
  nightCard.appendChild(hypHost);
  main.appendChild(nightCard);

  const trendCard = card('Trend', `Averages over ${a.nights} night${a.nights === 1 ? '' : 's'}`);
  trendCard.head.appendChild(segmented(
    [[7, 'Week'], [30, 'Month']], state.sleepDays,
    (v) => { state.sleepDays = v; load(); },
  ));
  trendCard.appendChild(el('p',
    `Average ${hhmm(a.hoursAsleep)} asleep · ${a.efficiencyPercent ?? '—'}% efficiency · `
    + `deep ${hhmm(a.stageHours.deep)} · REM ${hhmm(a.stageHours.rem)}`, 'card-sub'));
  const trendHost = el('div', null, 'chart');
  trendCard.appendChild(trendHost);
  main.appendChild(trendCard);

  requestAnimationFrame(() => {
    if (n) {
      hypnogram(hypHost, n.timeline, { from: Date.parse(n.bedtime), to: Date.parse(n.wakeTime) });
    } else {
      hypnogram(hypHost, []);
    }
    const height = window.innerWidth < 560 ? 160 : 200;
    const css = (x) => getComputedStyle(document.documentElement).getPropertyValue(x).trim();
    barChart(trendHost, {
      points: d.trend.map((x) => ({ t: x.t, v: x.hoursAsleep })),
      unit: 'h', precision: 1, bucketMs: DAY_MS, label: 'Asleep',
      goal: d.goalHours, color: css('--series-5'),
    }, height);
  });
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function renderStatus() {
  const s = state.status;
  if (!s) return;
  $('mark').classList.toggle('live', Boolean(s.sync && s.sync.running));

  let label;
  if (!s.connected) label = 'not connected';
  else if (s.sync.phase === 'tail') label = 'syncing…';
  else if (s.sync.phase === 'backfill') label = 'backfilling…';
  else if (s.sync.lastTailMs) label = `synced ${ago(s.sync.lastTailMs)}`;
  else label = 'idle';
  $('sync-state').textContent = label;
  $('btn-sync').disabled = !s.connected;
}

function ago(ms) {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function renderDayBar() {
  const bar = $('daybar');
  const usesDate = state.view === 'day' || state.view === 'sleep';
  bar.hidden = !usesDate;
  if (!usesDate) return;

  const label = $('day-label');
  label.replaceChildren();
  label.appendChild(document.createTextNode(prettyDate(state.date)));
  label.appendChild(el('small', state.date));
  // No stepping into the future: there is no data there and an empty screen would
  // read as a bug rather than as tomorrow.
  $('day-next').disabled = state.date >= todayStr();
}

let token = 0;
async function load() {
  const mine = ++token;
  const main = $('view');
  main.classList.add('loading');
  const tz = tzMs();

  try {
    let data;
    if (state.view === 'day') {
      data = await getJson(`${api('view/day')}?date=${state.date}&tz=${tz}`);
    } else if (state.view === 'sleep') {
      data = await getJson(`${api('view/sleep')}?date=${state.date}&days=${state.sleepDays}&tz=${tz}`);
    } else {
      data = await getJson(`${api('view/overview')}?days=${state.view === 'week' ? 7 : 30}&tz=${tz}`);
    }
    if (mine !== token) return;
    state.data = data;

    if (state.view === 'day') renderDay(data);
    else if (state.view === 'sleep') renderSleep(data);
    else renderOverview(data);
  } catch (err) {
    if (mine !== token) return;
    main.replaceChildren();
    const c = card('Could not load');
    c.appendChild(el('div', err.message, 'notice'));
    main.appendChild(c);
  } finally {
    if (mine === token) main.classList.remove('loading');
  }
}

function setView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
  renderDayBar();
  load();
}

async function refreshStatus() {
  try {
    state.status = await getJson(api('status'));
    renderStatus();
  } catch { /* the shell should not break because a status poll failed */ }
}

function initEvents() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  }
  $('day-prev').addEventListener('click', () => {
    state.date = shiftDate(state.date, -1);
    renderDayBar(); load();
  });
  $('day-next').addEventListener('click', () => {
    if (state.date >= todayStr()) return;
    state.date = shiftDate(state.date, 1);
    renderDayBar(); load();
  });
  $('btn-sync').addEventListener('click', async () => {
    const b = $('btn-sync');
    b.disabled = true; b.textContent = '…';
    try { await postJson(api('sync')); await refreshStatus(); await load(); } catch (e) {
      $('sync-state').textContent = e.message;
    } finally { b.textContent = 'Sync'; b.disabled = false; }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    // Charts are measured, not fluid, so a resize needs a redraw — debounced,
    // because a phone rotating fires this a dozen times.
    resizeTimer = setTimeout(() => {
      if (!state.data) return;
      if (state.view === 'day') renderDay(state.data);
      else if (state.view === 'sleep') renderSleep(state.data);
      else renderOverview(state.data);
    }, 220);
  });

  const es = new EventSource(api('stream'));
  let evtTimer;
  es.addEventListener('message', (msg) => {
    let evt; try { evt = JSON.parse(msg.data); } catch { return; }
    clearTimeout(evtTimer);
    evtTimer = setTimeout(() => { refreshStatus(); if (evt.count) load(); }, 1500);
  });
}

async function boot() {
  state.date = todayStr();
  initEvents();
  renderDayBar();
  await refreshStatus();
  await load();
  setInterval(refreshStatus, 30000);
}

boot().catch((err) => {
  $('view').appendChild(el('div', `Failed to start: ${err.message}`, 'notice'));
});
