'use strict';
/**
 * vitals — view controller for the five rooms.
 *
 * Five screens, one endpoint each: Today (how am I now), Sleep (how did I sleep),
 * Train (how is training going), Trends (what is changing), You (who am I
 * becoming). Every payload arrives pre-aggregated; anything that looks like
 * arithmetic here is a formatting decision, not a health figure.
 *
 * COLOUR FOLLOWS THE ENTITY: a metric keeps its series slot on every screen.
 * Semantic colours (good/warn/bad) appear only where the payload has already made
 * the judgement — the UI never grades a number itself.
 */

import {
  lineChart, barChart, stackedChart, zoneBars, hypnogram, sparkline,
  ringGauge, arcGauge, ringTrio, corridorChart, overlayChart, heatCalendar,
  stateStrip, tableView, fmtNumber,
} from './charts.js';

const $ = (id) => document.getElementById(id);
const api = (p) => `./api/${p}`;
const DAY_MS = 86400000;

const state = {
  view: 'today',
  date: null,           // YYYY-MM-DD for the day-scoped rooms
  status: null,
  data: null,
  calMonth: null,       // YYYY-MM shown in the jump overlay
  compare: { b: 'typical', metric: 'heart-rate', heat: 'steps' },
};

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const TINT = { steps: 1, distance: 2, cardioLoad: 3, calories: 4, heart: 6, sleep: 5 };
const tint = (name) => `var(--series-${TINT[name] || 1})`;
const seriesOf = (name) => css(`--series-${TINT[name] || 1}`);

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

function metric(label, value, unit, sub, colorName) {
  const m = el('div', null, 'metric');
  m.style.setProperty('--tint', tint(colorName));
  m.appendChild(el('div', label, 'metric-label'));
  const v = el('div', null, 'metric-value');
  const shown = value === null || value === undefined || value === '' ? '—' : String(value);
  v.appendChild(document.createTextNode(shown));
  if (unit && shown !== '—') v.appendChild(el('span', ` ${unit}`, 'metric-unit'));
  m.appendChild(v);
  const s = el('div', null, 'metric-sub');
  if (sub) {
    if (sub.derived) {
      const d = el('span', 'derived', 'derived');
      s.append(d, document.createTextNode(` ${sub.text || ''}`));
    } else s.textContent = sub.text || sub;
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
const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

async function sendJson(url, body, method = 'POST') {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body || {}),
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

function methodNote(c, obj) {
  if (obj && obj.method) c.appendChild(el('p', obj.method, 'method-note'));
  if (obj && obj.limitation) c.appendChild(el('p', obj.limitation, 'method-note'));
}

/** Civil date string for an epoch ms, in the viewer's zone — one implementation,
 * because ad-hoc copies of this idiom are how a weekday label ends up in UTC. */
const dateStrOf = (ms) => new Date(ms + tzMs()).toISOString().slice(0, 10);
const prettyMs = (ms) => prettyDate(dateStrOf(ms));

/** Label/value rows in the shared report style. */
function reportRows(pairs) {
  const rows = el('div', null, 'report-rows');
  for (const [label, v] of pairs) {
    const row = el('div', null, 'report-row');
    row.append(el('span', label, 'label'), el('b', v));
    rows.appendChild(row);
  }
  return rows;
}

/**
 * Every chart carries a table twin — the WCAG-clean view that also satisfies the
 * relief rule for the low-contrast palette slots. The toggle lives in the card
 * head; `draw` re-renders the chart, `tableSpec` feeds charts.tableView.
 */
function withTable(cardEl, host, draw, tableSpec) {
  let mode = 'chart';
  const btn = el('button', 'table', 'table-toggle');
  btn.type = 'button';
  btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', () => {
    mode = mode === 'chart' ? 'table' : 'chart';
    btn.textContent = mode === 'table' ? 'chart' : 'table';
    btn.setAttribute('aria-pressed', String(mode === 'table'));
    if (mode === 'table') tableView(host, tableSpec);
    else draw();
  });
  (cardEl.head || cardEl).appendChild(btn);
  draw();
}

/** Jump to a specific day in a day-scoped room — every heat cell uses this. */
function jumpToDay(dateStr, view = 'today') {
  state.date = dateStr > todayStr() ? todayStr() : dateStr;
  setView(view);
}

// ---------------------------------------------------------------------------
// TODAY — the orbital
// ---------------------------------------------------------------------------

const BAND_COLOR = { high: '--good', moderate: '--warn', low: '--bad' };

function renderToday(d) {
  const main = $('view');
  main.replaceChildren();
  main.className = 'room';

  // --- hero: readiness with strain and battery orbiting ---------------------
  const hero = card('Readiness', `${d.readiness.availableContributors} signals vs your 28-day baselines`);
  hero.classList.add('span-2');
  const orbital = el('div', null, 'orbital');
  const left = el('div', null, 'side');
  const strainHost = el('div');
  left.appendChild(strainHost);
  const core = el('div', null, 'core');
  const ringHost = el('div');
  core.appendChild(ringHost);
  const right = el('div', null, 'side');
  const battHost = el('div');
  right.appendChild(battHost);
  orbital.append(left, core, right);
  hero.appendChild(orbital);

  const label = el('p', null, 'readiness-label');
  if (d.readiness.score === null) {
    label.append(el('b', d.readiness.label), document.createTextNode(' — a few more tracked mornings and this lights up.'));
  } else {
    label.append(el('b', d.readiness.label));
    if (d.strain.target) label.append(document.createTextNode(` · strain target ${d.strain.target.lo}–${d.strain.target.hi}`));
  }
  hero.appendChild(label);

  const chips = el('div', null, 'contrib-row');
  for (const c of d.readiness.contributors) {
    const chip = el('span', null, `contrib ${c.status}`);
    chip.append(document.createTextNode(`${c.label} `), el('b', c.current === null ? '—' : String(c.current)));
    chip.title = c.detail || '';
    // The detail must be reachable without a mouse hover — title alone is
    // invisible to keyboard and touch users.
    if (c.detail) { chip.setAttribute('aria-label', `${c.label}: ${c.detail}`); chip.tabIndex = 0; }
    chips.appendChild(chip);
  }
  hero.appendChild(chips);
  methodNote(hero, d.readiness);
  main.appendChild(hero);

  // --- energy forecast ------------------------------------------------------
  const fc = card('Energy forecast', d.forecast.available
    ? `Peak ${d.forecast.zones.peak ? timeOf(d.forecast.zones.peak.at) : '—'} · dip ${d.forecast.zones.dip ? timeOf(d.forecast.zones.dip.at) : '—'} · wind down ${timeOf(d.forecast.zones.windDown.from)}`
    : 'Needs a measured wake time');
  const fcHost = el('div', null, 'chart');
  fc.appendChild(fcHost);
  if (d.forecast.available) methodNote(fc, { method: d.forecast.method });
  main.appendChild(fc);

  // --- rings + goals --------------------------------------------------------
  const ringsCard = card('Rings', d.goals.adapted ? 'Targets adapted to this morning' : 'Move · Train · Recover');
  const wrap = el('div', null, 'rings-wrap');
  const trioHost = el('div');
  wrap.appendChild(trioHost);
  const legend = el('div', null, 'rings-legend');
  // Colour follows the ENTITY: Move is active calories, so it wears the calories
  // slot — the same number as the "Active kcal" tile below must not change colour.
  const ringColors = { move: seriesOf('calories'), train: seriesOf('cardioLoad'), recover: seriesOf('sleep') };
  for (const r of d.rings) {
    const line = el('div', null, 'ring-line');
    const sw = el('span', null, 'swatch');
    sw.style.background = ringColors[r.id];
    const val = r.unit === 'h' ? hhmm(r.value) : fmtNumber(r.value, 0);
    line.append(sw, el('span', r.label), el('b', r.value === null ? '—' : val),
      el('span', `/ ${r.unit === 'h' ? `${r.goal}h` : fmtNumber(r.goal, 0)} ${r.unit === 'h' ? '' : r.unit}`, 'goal'));
    if (r.closed) line.append(el('span', '● closed', 'goal'));
    legend.appendChild(line);
  }
  const pai = el('div', null, 'pai-chip');
  pai.append(el('span', 'Weekly intensity'), el('b', d.pai.total === null ? '—' : String(d.pai.total)),
    el('span', `/ ${d.pai.target} · ${d.pai.measuredDays} days measured`));
  legend.appendChild(pai);
  wrap.appendChild(legend);
  ringsCard.appendChild(wrap);
  if (d.goals.steps.reason) ringsCard.appendChild(el('p', `Goals ${d.goals.steps.reason}`, 'goal-reason'));
  main.appendChild(ringsCard);

  // --- stress timeline --------------------------------------------------------
  const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
  const stressCard = card('Stress', d.stress.trackedHours
    ? `calm ${pct(d.stress.shares.calm)} · elevated ${pct(d.stress.shares.elevated)} · high ${pct(d.stress.shares.high)} · ${d.stress.trackedHours}h tracked`
    : 'No tracked hours yet today');
  const stressHost = el('div');
  stressCard.appendChild(stressHost);
  methodNote(stressCard, d.stress);
  main.appendChild(stressCard);

  // --- heart rate through the day ---------------------------------------------
  const hrDay = d.heartRateDay;
  const hrCard = card('Heart rate today', hrDay.available
    ? `${hrDay.min}–${hrDay.max} bpm · ${Math.round(hrDay.trackedMinutes / 60)}h measured`
    : 'No heart rate measured yet today');
  hrCard.classList.add('span-2');
  const hrHost = el('div');
  hrCard.appendChild(hrHost);
  methodNote(hrCard, hrDay);
  main.appendChild(hrCard);

  // --- symptom radar (only when it has something to say) --------------------
  if (d.radar.level === 'minor' || d.radar.level === 'major') {
    const radar = card('Symptom radar', `${d.radar.flaggedCount} overnight signals outside your range`);
    radar.classList.add('span-2');
    const grid = el('div', null, 'radar-signals');
    for (const s of d.radar.signals.filter((x) => x.available)) {
      const item = el('article', null, `signal ${s.flagged ? 'negative' : 'positive'}`);
      item.appendChild(el('div', s.label, 'signal-label'));
      const v = el('div', String(s.current), 'signal-value');
      v.appendChild(el('span', ` ${s.unit}`, 'metric-unit'));
      item.append(v, el('div', s.band ? `your range ${s.band.p10}–${s.band.p90}` : '', 'signal-detail'));
      grid.appendChild(item);
    }
    radar.appendChild(grid);
    methodNote(radar, d.radar);
    main.appendChild(radar);
  }

  // --- highlights -----------------------------------------------------------
  if (d.highlights.length) {
    const hl = card('Highlights');
    for (const h of d.highlights) {
      const item = el('div', null, 'insight-card');
      item.append(el('div', 'highlight', 'insight-kind'), el('div', h.text, 'insight-text'));
      hl.appendChild(item);
    }
    main.appendChild(hl);
  }

  // --- last night strip -----------------------------------------------------
  const sleep = card('Last night', 'The full night lives in Sleep');
  const strip = el('div', null, 'debt-hero');
  // The headline is time ASLEEP — that is what need/debt compare against. The
  // in-bed span sits in the subline so the two never read as the same number.
  const asleepH = d.sleepStrip.asleepHours ?? d.sleepStrip.mainHours;
  strip.append(el('b', asleepH === null ? '—' : hhmm(asleepH)));
  const sub = el('div', null, 'sub');
  sub.append(document.createTextNode(
    `need ${d.sleepStrip.needHours ? hhmm(d.sleepStrip.needHours) : '—'} · debt ${d.sleepStrip.debtHours === null ? '—' : `${d.sleepStrip.debtHours}h`}`
    + (d.sleepStrip.mainHours !== null && d.sleepStrip.mainHours !== asleepH ? ` · in bed ${hhmm(d.sleepStrip.mainHours)}` : '')
    + (d.sleepStrip.efficiencyPercent ? ` · ${d.sleepStrip.efficiencyPercent}% efficient` : ''),
  ));
  strip.appendChild(sub);
  sleep.appendChild(strip);
  if (d.sleepStrip.naps && d.sleepStrip.naps.length) {
    for (const n of d.sleepStrip.naps) {
      const row = el('div', null, 'nap-row');
      row.append(el('b', hhmm(n.hours)), el('span', `nap at ${timeOf(n.start)} · repaid ${n.debtCreditHours}h of debt`));
      sleep.appendChild(row);
    }
  }
  main.appendChild(sleep);

  // --- day stats ------------------------------------------------------------
  const statsCard = el('section', null, 'metrics span-2');
  statsCard.append(
    metric('Steps', fmtNumber(d.stats.steps, 0), '', { text: `goal ${fmtNumber(d.stats.stepsGoal, 0, true)}` }, 'steps'),
    metric('Distance', d.stats.distanceKm === null ? null : d.stats.distanceKm.toFixed(2), 'km', null, 'distance'),
    metric('Active kcal', fmtNumber(d.stats.activeCalories, 0), '', null, 'calories'),
    metric('Zone minutes', fmtNumber(d.stats.activeZoneMinutes, 0), 'AZM', null, 'cardioLoad'),
    metric('Resting HR', fmtNumber(d.stats.restingHeartRate, 0), 'bpm',
      d.stats.restingSource === 'derived' ? { derived: true, text: 'lowest while asleep' } : null, 'heart'),
    metric('HRV', fmtNumber(d.stats.hrv, 0), 'ms',
      d.stats.hrvSource === 'derived' ? { derived: true, text: 'from raw samples' } : null, 'heart'),
  );
  main.appendChild(statsCard);

  if (d.mondayReport) {
    const mon = card('Monday');
    const link = el('button', 'Your weekly report is ready → Trends', 'btn');
    link.type = 'button';
    link.addEventListener('click', () => setView('trends'));
    mon.appendChild(link);
    main.appendChild(mon);
  }

  requestAnimationFrame(() => {
    const bandVar = BAND_COLOR[d.readiness.band];
    ringGauge(ringHost, {
      value: d.readiness.score, max: 100,
      sublabel: 'readiness',
      color: bandVar ? css(bandVar) : css('--muted'),
      size: 150,
    });
    // A counter of strain SPENT (it fills as the day accumulates), never a
    // budget-remaining gauge — the band on the track is the day's target.
    arcGauge(strainHost, {
      value: d.strain.today, max: d.strain.max,
      label: d.strain.spentSoFar ? 'strain spent' : 'day strain',
      band: d.strain.target, color: seriesOf('cardioLoad'),
      format: (v) => v.toFixed(1),
    });
    arcGauge(battHost, {
      value: d.battery.current, max: 100, label: 'battery',
      // Neutral ink, not the calories slot: the battery is a derived level, not
      // the calories entity, and a metric colour here would claim it is.
      color: css('--text-2'), format: (v) => `${v}%`,
    });
    if (d.forecast.available) {
      const fcSpec = {
        points: d.forecast.points, unit: '', precision: 0, bucketMs: 1800000,
        label: 'Predicted energy', area: true, color: seriesOf('sleep'),
      };
      withTable(fc, fcHost,
        () => lineChart(fcHost, fcSpec, window.innerWidth < 560 ? 150 : 180), fcSpec);
    } else {
      fcHost.replaceChildren(el('div', 'No wake time measured this morning', 'chart-empty'));
    }
    stateStrip(stressHost, d.stress.points);
    if (hrDay.available) {
      // `band` draws each bucket's real min–max; `refBand` is the viewer's own
      // p10–p90 behind it. No connectGaps — an unworn watch is a gap, not a line.
      const hrSpec = {
        points: hrDay.points, unit: hrDay.unit, precision: 0,
        bucketMs: hrDay.bucketMinutes * 60000, label: 'Heart rate',
        color: seriesOf('heart'), band: true, refBand: hrDay.refBand,
      };
      withTable(hrCard, hrHost,
        () => lineChart(hrHost, hrSpec, window.innerWidth < 560 ? 170 : 220), hrSpec);
    } else {
      hrHost.replaceChildren(el('div', 'No heart-rate samples for this day', 'chart-empty'));
    }
    ringTrio(trioHost, d.rings.map((r) => ({ fraction: r.fraction, color: ringColors[r.id] })));
  });
}

// ---------------------------------------------------------------------------
// SLEEP — night first
// ---------------------------------------------------------------------------

function renderSleepScreen(d) {
  const main = $('view');
  main.replaceChildren();
  main.className = 'room';
  const n = d.night;

  const metrics = el('section', null, 'metrics span-2');
  metrics.append(
    metric('Asleep', hhmm(n ? n.hoursAsleep : null), '',
      d.need.tonightNeedHours ? { text: `need ${hhmm(d.need.tonightNeedHours)}` } : null, 'sleep'),
    metric('In bed', hhmm(n ? n.hoursInBed : null), '', { text: 'asleep + awake in session' }, 'sleep'),
    metric('Efficiency', n && n.efficiencyPercent !== null ? n.efficiencyPercent : null, '%',
      { text: 'asleep ÷ in bed' }, 'sleep'),
    metric('Sleep debt', d.need.debtHours === null ? null : d.need.debtHours, 'h',
      { derived: true, text: `over 14 nights` }, 'sleep'),
    metric('Consistency', d.consistency.score, '%',
      d.consistency.score === null
        ? { text: `needs ${d.consistency.requiredNights} nights` }
        : { text: `±${d.consistency.spreadMinutes} min over ${d.consistency.nights} nights` }, 'sleep'),
    metric('Naps today', d.naps.length, '', d.naps.length
      ? { text: `repaid ${d.naps.reduce((a, x) => a + x.debtCreditHours, 0).toFixed(1)}h debt` } : null, 'sleep'),
  );
  main.appendChild(metrics);

  const nightCard = card('The night', n && n.bedtime
    ? `${timeOf(Date.parse(n.bedtime))} → ${timeOf(Date.parse(n.wakeTime))}`
    : 'No staged sleep recorded');
  nightCard.classList.add('span-2');
  const hypHost = el('div', null, 'hypno');
  nightCard.appendChild(hypHost);
  main.appendChild(nightCard);

  const needCard = card('Need & debt', 'Rise-style: a balance in hours, not a nightly grade');
  needCard.appendChild(reportRows([
    ['Your learned need', d.need.baseNeedHours ? hhmm(d.need.baseNeedHours) : '—'],
    ['Tonight’s need', d.need.tonightNeedHours ? hhmm(d.need.tonightNeedHours) : '—'],
    ['Debt to repay', d.need.debtHours === null ? '—' : `${d.need.debtHours} h`],
    ['Nights it learned from', String(d.need.nightsUsed)],
  ]));
  methodNote(needCard, d.need);
  main.appendChild(needCard);

  const dipCard = card('Overnight heart-rate dip', 'How far your sleeping heart rate fell');
  if (d.heartRateDip.dipPercent === null) {
    dipCard.appendChild(el('p', 'Not enough overnight samples for this night.', 'empty-state'));
  } else {
    const hero = el('div', null, 'debt-hero');
    hero.append(el('b', `${d.heartRateDip.dipPercent}%`),
      el('div', `sleeping ${d.heartRateDip.sleepingAvg} vs daytime ${d.heartRateDip.daytimeAvg} bpm · floor ${d.heartRateDip.floorBpm} at ${timeOf(d.heartRateDip.bottomAtMs)}`, 'sub'));
    dipCard.appendChild(hero);
    methodNote(dipCard, d.heartRateDip);
  }
  main.appendChild(dipCard);

  const tempCard = card('Night temperature', 'Skin deviation from your own baseline');
  const tempHost = el('div', null, 'chart');
  tempCard.appendChild(tempHost);
  main.appendChild(tempCard);

  const trendCard = card('Seven nights', 'Stages per night · deep is darkest');
  trendCard.classList.add('span-2');
  const trendHost = el('div', null, 'chart');
  trendCard.appendChild(trendHost);
  main.appendChild(trendCard);

  if (d.napsWeek.length) {
    const napCard = card('Naps this week');
    for (const nap of d.napsWeek) {
      const row = el('div', null, 'nap-row');
      row.append(el('b', hhmm(nap.hours)),
        el('span', `${prettyMs(nap.day)} at ${timeOf(nap.start)} · repaid ${nap.debtCreditHours}h`));
      napCard.appendChild(row);
    }
    main.appendChild(napCard);
  }

  const patCard = card('This month’s pattern', d.pattern.available
    ? `${d.pattern.nights} nights measured` : null);
  if (!d.pattern.available) {
    patCard.appendChild(el('p', d.pattern.note, 'empty-state'));
  } else {
    patCard.appendChild(el('p', d.pattern.sentence, 'pattern-sentence'));
    const grid = el('div', null, 'pattern-grid');
    for (const m of d.pattern.metrics) {
      const item = el('div', null, `pattern-metric ${m.status}`);
      item.append(el('b', m.value === null ? '—' : `${m.value}${m.unit}`),
        el('small', `${m.label} · typical ${m.typical[0]}–${m.typical[1]}${m.unit}`));
      grid.appendChild(item);
    }
    patCard.appendChild(grid);
    methodNote(patCard, d.pattern);
  }
  main.appendChild(patCard);

  requestAnimationFrame(() => {
    if (n && n.timeline && n.timeline.length) {
      hypnogram(hypHost, n.timeline, { from: Date.parse(n.bedtime), to: Date.parse(n.wakeTime) });
    } else hypnogram(hypHost, []);

    const height = window.innerWidth < 560 ? 160 : 200;
    const tempSpec = {
      points: d.temperature.points, unit: d.temperature.unit, precision: 2,
      bucketMs: DAY_MS, label: 'Deviation', diverging: true,
      color: seriesOf('heart'),
      refBand: d.temperature.band,
    };
    withTable(tempCard, tempHost, () => lineChart(tempHost, tempSpec, height), tempSpec);

    const trendSpec = {
      points: d.trend.map((r) => ({
        t: r.t,
        parts: r.stageHours
          ? { DEEP: r.stageHours.deep || 0, REM: r.stageHours.rem || 0, LIGHT: r.stageHours.light || 0, AWAKE: r.stageHours.awake || 0 }
          : {},
      })),
      keys: ['DEEP', 'REM', 'LIGHT', 'AWAKE'],
      labels: { DEEP: 'Deep', REM: 'REM', LIGHT: 'Light', AWAKE: 'Awake' },
      colors: { DEEP: css('--ord-6'), REM: css('--ord-4'), LIGHT: css('--ord-2'), AWAKE: css('--ord-1') },
      unit: 'h', precision: 1, bucketMs: DAY_MS, goal: d.goalHours,
    };
    withTable(trendCard, trendHost, () => stackedChart(trendHost, trendSpec, height), trendSpec);
  });
}

// ---------------------------------------------------------------------------
// TRAIN — session first
// ---------------------------------------------------------------------------

/** One list of session stat pairs, so the hero and the list cannot drift apart. */
function sessionStatItems(s, extended) {
  const cal = s.calories === null || s.calories === undefined ? '—' : `${fmtNumber(s.calories, 0)} kcal`;
  return extended
    ? [
      ['Effort', s.load === null ? '—' : String(Math.round(s.load))],
      ['Avg', s.averageHeartRate ? `${s.averageHeartRate} bpm` : '—'],
      ['Max', s.maxHeartRate ? `${s.maxHeartRate} bpm` : '—'],
      ['Burned', cal],
      ['HRR', s.heartRateRecovery ? `−${s.heartRateRecovery.dropBpm}` : '—'],
    ]
    : [
      ['Effort', s.load === null ? '—' : String(Math.round(s.load))],
      ['Strain', s.strain === null ? '—' : s.strain.toFixed(1)],
      ['Avg HR', s.averageHeartRate ? `${s.averageHeartRate}` : '—'],
      ['Burned', cal],
      ['HR recovery', s.heartRateRecovery ? `−${s.heartRateRecovery.dropBpm} bpm` : '—'],
    ];
}

function sessionStats(s) {
  const stats = el('div', null, 'session-stats');
  for (const [label, value] of sessionStatItems(s, false)) {
    const stat = el('div', null, 'stat');
    stat.append(el('b', value), el('small', label));
    stats.appendChild(stat);
  }
  return stats;
}

function renderTrain(d) {
  const main = $('view');
  main.replaceChildren();
  main.className = 'room';

  // --- latest session hero --------------------------------------------------
  const hero = card('Latest session', d.sessionsLimitation);
  hero.classList.add('span-2');
  if (!d.latestSession) {
    hero.appendChild(el('p', 'No sessions in the last two weeks — the next workout lands here.', 'empty-state'));
  } else {
    const s = d.latestSession;
    const wrap = el('div', null, 'session-hero');
    const title = el('div', null, 'session-title');
    title.append(el('strong', s.label),
      el('span', null, `kind-chip ${s.kind}`),
      el('span', `${prettyMs(s.start)} ${timeOf(s.start)}–${timeOf(s.end)} · ${s.durationMinutes} min`, 'when'));
    title.querySelector('.kind-chip').textContent = s.kind === 'detected' ? 'detected' : 'recorded';
    wrap.appendChild(title);
    wrap.appendChild(sessionStats(s));
    const zonesHost = el('div');
    wrap.appendChild(zonesHost);
    hero.appendChild(wrap);
    requestAnimationFrame(() => zoneBars(zonesHost, d.zoneTable, s.zoneMinutes || {}));
  }
  // Three states, three messages — 'easy-ok' wears the green dot, so printing
  // "Recovering" for it made the text and the colour disagree.
  const cd = el('span', null, `countdown-chip ${d.countdown.state}`);
  const cdText = {
    ready: ['Recovered — ', 'ready for a hard session'],
    'easy-ok': ['Nearly there — ', `easy session is fine · ${d.countdown.hoursRemaining}h to full`],
    recovering: ['Recovering — ', `${d.countdown.hoursRemaining}h to full`],
  }[d.countdown.state] || ['Recovering — ', `${d.countdown.hoursRemaining}h to full`];
  cd.append(document.createTextNode(cdText[0]), el('b', cdText[1]));
  cd.title = d.countdown.method || '';
  if (d.countdown.method) { cd.setAttribute('aria-label', `${cdText[0]}${cdText[1]}. ${d.countdown.method}`); cd.tabIndex = 0; }
  hero.appendChild(cd);
  main.appendChild(hero);

  // --- corridor -------------------------------------------------------------
  const corr = card('Load corridor', 'Your 7-day load threading the healthy band');
  if (d.corridor.state) {
    corr.head.appendChild(el('span', d.corridor.state, `status-chip ${d.corridor.state}`));
  }
  const corrHost = el('div', null, 'chart');
  corr.appendChild(corrHost);
  methodNote(corr, d.corridor);
  main.appendChild(corr);

  // --- fitness / fatigue / form ---------------------------------------------
  const lm = card('Fitness & fatigue', d.loadModel.current
    ? `Form ${d.loadModel.current.form > 0 ? '+' : ''}${d.loadModel.current.form}`
    : 'Building history');
  if (d.loadModel.current) {
    lm.head.appendChild(el('span', d.loadModel.current.status, `status-chip ${d.loadModel.current.status}`));
  }
  const lmHost = el('div', null, 'chart');
  lm.appendChild(lmHost);
  methodNote(lm, d.loadModel);
  main.appendChild(lm);

  // --- season ---------------------------------------------------------------
  const season = card('Season', 'Daily load · tap a day to open it');
  const seasonHost = el('div');
  season.appendChild(seasonHost);
  const weeksHost = el('div', null, 'chart');
  season.append(el('p', 'Weekly load · 8 weeks', 'card-sub'), weeksHost);
  main.appendChild(season);

  // --- calories burned per day ----------------------------------------------
  const cal = card('Calories burned', d.calories.band
    ? `Daily total · typical day ${fmtNumber(d.calories.band.median, 0)} kcal`
    : `Daily total · ${d.calories.days} days`);
  const calHost = el('div', null, 'chart');
  cal.appendChild(calHost);
  methodNote(cal, d.calories);
  main.appendChild(cal);

  // --- sessions list (recorded + detected, with their insights) -------------
  const list = card('Sessions · 14 days', d.sessionsMethod);
  if (!d.sessions.length) list.appendChild(el('p', 'Nothing yet.', 'empty-state'));
  const ol = el('ol', null, 'activity-list');
  for (const s of d.sessions.slice(0, 12)) {
    const row = el('li', null, 'activity-row');
    const head = el('div', null, 'activity-main');
    const left = el('div');
    const strong = el('strong', `${s.label} `);
    strong.appendChild(el('span', s.kind === 'detected' ? 'detected' : 'recorded', `kind-chip ${s.kind}`));
    left.appendChild(strong);
    head.append(left,
      el('span', `${prettyMs(s.start)} · ${timeOf(s.start)} · ${s.durationMinutes} min`));
    row.appendChild(head);
    const stats = el('div', null, 'activity-stats');
    for (const [label, value] of sessionStatItems(s, true)) {
      const stat = el('span');
      stat.append(el('small', label), document.createTextNode(value));
      stats.appendChild(stat);
    }
    row.appendChild(stats);
    ol.appendChild(row);
  }
  list.appendChild(ol);
  main.appendChild(list);

  // --- records --------------------------------------------------------------
  const rec = card('Personal records');
  const recList = el('div', null, 'record-list');
  for (const r of d.records) {
    const row = el('div', null, 'record-row');
    row.append(el('span', r.label, 'label'), el('b', `${fmtNumber(r.value, 0)} ${r.unit}`),
      el('span', r.atMs ? `${dateStrOf(r.atMs)} · ${r.window}` : r.window, 'window'));
    recList.appendChild(row);
  }
  rec.appendChild(recList);
  main.appendChild(rec);

  // --- strength -------------------------------------------------------------
  const st = card('Strength log', 'Logged sets, beside cardio — never summed into it');
  const logBtn = el('button', 'Log strength', 'btn btn-accent');
  logBtn.type = 'button';
  logBtn.addEventListener('click', () => $('strength-dialog').showModal());
  st.head.appendChild(logBtn);
  if (!d.strength.entries.length) {
    st.appendChild(el('p', 'No entries in the last 60 days.', 'empty-state'));
  } else {
    for (const e2 of d.strength.entries.slice(0, 10)) {
      const row = el('div', null, 'nap-row');
      row.append(el('b', e2.exercise),
        el('span', `${dateStrOf(e2.ts_ms)} · ${e2.sets}×${e2.reps} @ ${e2.weight_kg}kg · ${fmtNumber(e2.volume_kg, 0)}kg volume · index ${e2.muscularIndex}`));
      const del = el('button', '×', 'dialog-close');
      del.type = 'button';
      del.setAttribute('aria-label', `Delete ${e2.exercise}`);
      del.addEventListener('click', async () => {
        // Same discipline as every other mutation: a failed delete must say so,
        // not reject unhandled while the row invites another tap.
        del.disabled = true;
        try {
          await sendJson(`${api('strength')}?id=${e2.id}`, undefined, 'DELETE');
          await load();
        } catch (e) {
          del.disabled = false;
          row.appendChild(el('span', e.message, 'form-error'));
        }
      });
      row.appendChild(del);
      st.appendChild(row);
    }
  }
  methodNote(st, { method: d.strength.method });
  main.appendChild(st);

  requestAnimationFrame(() => {
    const height = window.innerWidth < 560 ? 170 : 210;
    const corrSeries = d.corridor.series.filter((x) => x.t >= Date.now() - 90 * DAY_MS);
    withTable(corr, corrHost,
      () => corridorChart(corrHost, { series: corrSeries, bucketMs: DAY_MS }, height),
      {
        bucketMs: DAY_MS,
        precision: 0,
        series: [
          { label: '7-day load', points: corrSeries.map((x) => ({ t: x.t, v: x.fatigue })) },
          { label: 'Corridor low', points: corrSeries.map((x) => ({ t: x.t, v: x.lo })) },
          { label: 'Corridor high', points: corrSeries.map((x) => ({ t: x.t, v: x.hi })) },
        ],
      });
    // Fitness emphasized, fatigue thin — same load scale, one axis.
    const pts = d.loadModel.series;
    const lmA = { label: 'Fitness (42d)', points: pts.map((x) => ({ t: x.t, v: x.fitness })) };
    const lmB = { label: 'Fatigue (7d)', points: pts.map((x) => ({ t: x.t, v: x.fatigue })) };
    withTable(lm, lmHost,
      () => overlayChart(lmHost, {
        a: lmA, b: lmB,
        unit: 'TRIMP', precision: 0, bucketMs: DAY_MS, nonNegative: true,
        color: seriesOf('cardioLoad'),
      }, height),
      { bucketMs: DAY_MS, precision: 0, series: [lmA, lmB] });
    heatCalendar(seasonHost, {
      cells: d.season.cells.slice(-56), thresholds: d.season.thresholds,
      unit: 'TRIMP', precision: 0, offsetMs: tzMs(),
    }, (dateStr) => jumpToDay(dateStr));
    const weeksSpec = {
      points: d.weeklyLoad.map((w) => ({ t: w.t, v: w.load })),
      unit: 'TRIMP', precision: 0, bucketMs: 7 * DAY_MS, label: 'Weekly load',
      color: seriesOf('cardioLoad'),
    };
    withTable(season, weeksHost,
      () => barChart(weeksHost, weeksSpec, window.innerWidth < 560 ? 130 : 160), weeksSpec);
    const calSpec = {
      points: d.calories.points,
      unit: d.calories.unit, precision: d.calories.precision,
      bucketMs: DAY_MS, label: d.calories.label,
      color: seriesOf('calories'),
    };
    withTable(cal, calHost, () => barChart(calHost, calSpec, height), calSpec);
  });
}

// ---------------------------------------------------------------------------
// TRENDS — compare first
// ---------------------------------------------------------------------------

function renderTrends(d) {
  const main = $('view');
  main.replaceChildren();
  main.className = 'room';

  // --- compare workbench ----------------------------------------------------
  const cmp = card('Compare days', d.compare.method);
  cmp.classList.add('span-2');

  const bench = el('div', null, 'bench');
  const dateA = document.createElement('input');
  dateA.type = 'date';
  dateA.name = 'compare-a';
  dateA.value = d.compare.a.date;
  dateA.max = todayStr();
  dateA.className = 'bench-date';
  dateA.setAttribute('aria-label', 'Day A');
  dateA.addEventListener('change', () => {
    if (dateA.value) { state.compare.a = dateA.value; load(); }
  });
  bench.appendChild(dateA);
  bench.appendChild(el('span', 'vs', 'vs'));

  const bSel = document.createElement('select');
  bSel.name = 'compare-b';
  bSel.setAttribute('aria-label', 'Day B');
  // timeZone UTC, because 'YYYY-MM-DD' parses as UTC midnight — formatted in a
  // west-of-UTC locale it names the previous weekday, and the server picks the
  // ghost's weekday from the date itself.
  const wd = new Date(dateA.value).toLocaleDateString([], { weekday: 'long', timeZone: 'UTC' });
  for (const [v, label] of [
    ['typical', `Typical ${wd}`],
    [shiftDate(d.compare.a.date, -1), 'Day before'],
    [shiftDate(d.compare.a.date, -7), 'Same day last week'],
    ['pick', 'Pick a date…'],
  ]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    bSel.appendChild(o);
  }
  bSel.value = ['typical'].includes(state.compare.b) ? state.compare.b
    : [shiftDate(d.compare.a.date, -1), shiftDate(d.compare.a.date, -7)].includes(state.compare.b)
      ? state.compare.b : 'pick';
  const dateB = document.createElement('input');
  dateB.type = 'date';
  dateB.name = 'compare-b-date';
  dateB.max = todayStr();
  dateB.hidden = bSel.value !== 'pick';
  if (bSel.value === 'pick' && state.compare.b !== 'typical') dateB.value = state.compare.b;
  dateB.setAttribute('aria-label', 'Custom day B');
  bSel.addEventListener('change', () => {
    if (bSel.value === 'pick') { dateB.hidden = false; return; }
    state.compare.b = bSel.value;
    load();
  });
  dateB.addEventListener('change', () => {
    if (dateB.value) { state.compare.b = dateB.value; load(); }
  });
  bench.append(bSel, dateB);
  bench.appendChild(segmented([['heart-rate', 'Heart rate'], ['steps', 'Steps']], d.compare.metric,
    (v) => { state.compare.metric = v; load(); }));
  cmp.appendChild(bench);

  const cmpHost = el('div', null, 'chart');
  cmp.appendChild(cmpHost);

  // A-vs-B numbers under the canvas.
  const bm = d.compare.b ? d.compare.b.metrics : null;
  const am = d.compare.a.metrics;
  const table = el('div', null, 'bench-table');
  table.append(el('span', '', 'h'), el('span', prettyDate(d.compare.a.date), 'h'),
    el('span', d.compare.b ? prettyDate(d.compare.b.date) : `typical ${wd}`, 'h'));
  const rows = [
    ['Strain', (m) => (m.strain === null ? '—' : m.strain.toFixed(1))],
    ['Steps', (m) => fmtNumber(m.steps, 0)],
    ['Zone min', (m) => fmtNumber(m.activeZoneMinutes, 0)],
    ['Sleep', (m) => hhmm(m.sleepHours)],
    ['Resting HR', (m) => fmtNumber(m.restingHeartRate, 0)],
    ['HRV', (m) => fmtNumber(m.hrv, 0)],
  ];
  for (const [label, fmt] of rows) {
    table.append(el('span', label, 'm'), el('span', fmt(am), 'n'),
      el('span', bm ? fmt(bm) : '—', `n${bm ? '' : ' ghosted'}`));
  }
  cmp.appendChild(table);
  main.appendChild(cmp);

  // --- verdicts -------------------------------------------------------------
  const ver = card('90 vs 365 days', d.verdicts.method);
  const grid = el('div', null, 'verdict-grid');
  for (const m of d.verdicts.metrics.filter((x) => x.available)) {
    const item = el('div', null, 'verdict');
    const arrow = el('span', m.direction === 'up' ? '↑' : m.direction === 'down' ? '↓' : '→',
      `arrow${m.good === true ? ' good' : m.good === false ? ' bad' : ''}`);
    item.appendChild(arrow);
    item.append(el('div', m.label, 'signal-label'));
    const v = el('div', null, 'v');
    v.textContent = `${fmtNumber(m.value, m.id === 'sleep' ? 1 : 0)} ${m.unit}`;
    item.appendChild(v);
    const spark = el('div', null, 'spark');
    item.appendChild(spark);
    requestAnimationFrame(() => sparkline(spark, m.spark, css('--axis')));
    grid.appendChild(item);
  }
  if (!grid.children.length) ver.appendChild(el('p', 'Verdicts need 90 days of history.', 'empty-state'));
  else ver.appendChild(grid);
  main.appendChild(ver);

  // --- heat calendar --------------------------------------------------------
  const heat = card('Eight weeks', `${d.heat.label} · darker is more · tap a day`);
  heat.head.appendChild(segmented(
    d.heatOptions.map((t) => [t, { steps: 'Steps', sleep: 'Sleep', 'active-zone-minutes': 'AZM' }[t] || t]),
    d.heat.type, (v) => { state.compare.heat = v; load(); },
  ));
  const heatHost = el('div');
  heat.appendChild(heatHost);
  main.appendChild(heat);

  // --- correlations ---------------------------------------------------------
  const corr = card('What moves what', d.correlations.method);
  if (!d.correlations.cards.length) {
    corr.appendChild(el('p', 'No associations strong enough to report yet — that is a finding too.', 'empty-state'));
  } else {
    for (const c of d.correlations.cards) {
      const item = el('div', null, 'insight-card');
      const delta = c.delta > 0 ? `+${c.delta}` : String(c.delta);
      item.append(
        el('div', 'association', 'insight-kind'),
        el('div', `${c.xLabel}: ${c.yLabel} averages ${fmtNumber(c.aboveMean, 2)} ${c.unit} vs ${fmtNumber(c.belowMean, 2)} ${c.unit} (${delta} ${c.unit})`, 'insight-text'),
        el('div', `r ${c.r} over ${c.n} days · associated, not causal`, 'insight-sub'),
      );
      corr.appendChild(item);
    }
  }
  main.appendChild(corr);

  // --- weekly report --------------------------------------------------------
  const wk = card('This week', d.weeklyReport.method);
  const wkRows = el('div', null, 'report-rows');
  for (const r of d.weeklyReport.rows) {
    const row = el('div', null, 'report-row');
    const deltaText = r.deltaPercent === null ? '' : `${r.deltaPercent > 0 ? '+' : ''}${r.deltaPercent}%`;
    row.append(el('span', r.label, 'label'),
      el('b', `${fmtNumber(r.value, r.unit === 'h' ? 2 : 0)} ${r.unit}`),
      el('span', deltaText, `delta${r.good === true ? ' good' : r.good === false ? ' bad' : ''}`));
    wkRows.appendChild(row);
  }
  wk.appendChild(wkRows);
  if (d.weeklyReport.balance) {
    const chip = el('span', `${d.weeklyReport.balance.zone} · ${d.weeklyReport.balance.ratio}× capacity`,
      `status-chip balance-chip ${d.weeklyReport.balance.zone === 'optimal' ? 'productive' : d.weeklyReport.balance.zone === 'overreaching' ? 'overreaching' : 'detraining'}`);
    wk.appendChild(chip);
  }
  main.appendChild(wk);

  requestAnimationFrame(() => {
    const height = window.innerWidth < 560 ? 190 : 240;
    const aColor = d.compare.metric === 'steps' ? seriesOf('steps') : seriesOf('heart');
    // Each side is positioned by time-of-day against its OWN local midnight —
    // the curves are sparse and differently bucketed, so index alignment would
    // put one day's timestamps under the other day's points.
    const originOf = (dateStr) => {
      const [y, m2, dd] = dateStr.split('-').map(Number);
      return Date.UTC(y, m2 - 1, dd) - tzMs();
    };
    const aOrigin = originOf(d.compare.a.date);
    let bSeries = null;
    if (d.compare.b) {
      bSeries = {
        label: prettyDate(d.compare.b.date),
        points: d.compare.b.curve,
        origin: originOf(d.compare.b.date),
        bucketMs: d.compare.b.bucketMs,
      };
    } else if (d.compare.typical) {
      bSeries = {
        label: `typical ${wd}`,
        points: d.compare.typical.points.map((p) => ({
          t: aOrigin + p.hour * 3600000, v: p.v, p25: p.p25, p75: p.p75,
        })),
        origin: aOrigin,
        bucketMs: 3600000,
      };
    }
    overlayChart(cmpHost, {
      a: {
        label: prettyDate(d.compare.a.date),
        points: d.compare.a.curve,
        origin: aOrigin,
        bucketMs: d.compare.a.bucketMs,
      },
      b: bSeries,
      unit: d.compare.metric === 'steps' ? 'steps' : 'bpm',
      precision: 0,
      bucketMs: d.compare.a.bucketMs || 3600000,
      spanMs: DAY_MS,
      nonNegative: d.compare.metric === 'steps',
      color: aColor,
    }, height);
    heatCalendar(heatHost, { ...d.heat, offsetMs: tzMs() }, (dateStr) => jumpToDay(dateStr));
  });
}

// ---------------------------------------------------------------------------
// YOU — the arc
// ---------------------------------------------------------------------------

function renderYou(d) {
  const main = $('view');
  main.replaceChildren();
  main.className = 'room';

  // Fitness age hero: the existing transparent estimator, plus its 12-month arc.
  const fa = card('Fitness age', `Recent ${d.fitnessAge.coverage.recentWindowDays} complete days · ${d.fitnessAge.coverage.confidence} confidence`);
  fa.classList.add('span-2');
  const hero = el('div', null, 'debt-hero');
  if (d.fitnessAge.estimate === null) {
    hero.append(el('b', '—'), el('div', `Building history — ${d.fitnessAge.coverage.availableSignals} of ${d.fitnessAge.coverage.requiredSignals} signals ready`, 'sub'));
  } else {
    hero.append(el('b', String(d.fitnessAge.estimate)),
      el('div', d.fitnessAge.deltaYears === 0
        ? `in line with profile age ${d.fitnessAge.actualAge}`
        : `${Math.abs(d.fitnessAge.deltaYears)} year${Math.abs(d.fitnessAge.deltaYears) === 1 ? '' : 's'} ${d.fitnessAge.direction} than profile age ${d.fitnessAge.actualAge}`, 'sub'));
  }
  fa.appendChild(hero);
  const arcHost = el('div', null, 'chart');
  fa.appendChild(arcHost);
  const factors = el('div', null, 'fitness-factor-grid');
  for (const factor of d.fitnessAge.factors) {
    const item = el('article', null, `fitness-factor ${factor.status}`);
    item.appendChild(el('div', factor.label, 'signal-label'));
    item.appendChild(el('div', factor.available ? `${factor.value} ${factor.unit}` : '—', 'fitness-factor-value'));
    item.appendChild(el('div', factor.detail, 'signal-detail'));
    factors.appendChild(item);
  }
  fa.appendChild(factors);
  methodNote(fa, d.fitnessAge);
  main.appendChild(fa);

  // Resilience level track.
  const res = card('Resilience', 'A slow 14-day trait, not a daily mood');
  if (d.resilience.level === null) {
    res.appendChild(el('p', `Needs ${d.resilience.requiredDays} covered days in the last 14 — have ${d.resilience.coveredDays}.`, 'empty-state'));
  } else {
    const track = el('div', null, 'level-track');
    d.resilience.levels.forEach((_, i) => {
      track.appendChild(el('span', null, `level-step${i <= d.resilience.levelIndex ? ' on' : ''}`));
    });
    res.appendChild(track);
    const names = el('div', null, 'level-names');
    names.append(el('span', d.resilience.levels[0]), el('span', d.resilience.level), el('span', d.resilience.levels[4]));
    res.appendChild(names);
  }
  methodNote(res, d.resilience);
  main.appendChild(res);

  // Radar history.
  const radar = card('Symptom radar · 14 mornings', d.radar.today && d.radar.today.level !== 'unavailable'
    ? `today: ${d.radar.today.level === 'none' ? 'no signs' : `${d.radar.today.level} signs`}` : 'not enough vitals yet');
  const strip = el('div', null, 'radar-strip');
  for (const day of d.radar.history.slice(-14)) {
    const cell = el('span', null, `radar-day ${day.level === 'unavailable' ? 'none' : day.level}`);
    cell.title = `${dateStrOf(day.t)} — ${day.level === 'unavailable' ? 'not measured' : day.level === 'none' ? 'no signs' : `${day.level} signs (${day.flagged} signals)`}`;
    cell.setAttribute('role', 'img');
    cell.setAttribute('aria-label', cell.title);
    strip.appendChild(cell);
  }
  radar.appendChild(strip);
  main.appendChild(radar);

  // Quarterly review.
  const q = card('Quarterly review', d.quarterly.method);
  const qRows = el('div', null, 'report-rows');
  for (const r of d.quarterly.rows) {
    const row = el('div', null, 'report-row');
    const deltaText = r.delta === null ? '' : `${r.delta > 0 ? '+' : ''}${r.delta} ${r.unit}`;
    row.append(el('span', r.label, 'label'),
      el('b', `${fmtNumber(r.value, r.unit === 'h' ? 2 : r.unit === 'kg' || r.unit === 'ml/kg/min' ? 1 : 0)} ${r.unit}`),
      el('span', deltaText, `delta${r.good === true ? ' good' : r.good === false ? ' bad' : ''}`));
    qRows.appendChild(row);
  }
  q.appendChild(qRows);
  main.appendChild(q);

  // Lifetime records — top-3 podium per metric, whole history.
  const lr = card('Lifetime records', 'Your top 3 days ever, per metric');
  if (!d.lifetimeRecords || !d.lifetimeRecords.rows.length) {
    lr.appendChild(el('p', 'Records appear once there is daily history to rank.', 'empty-state'));
  } else {
    const lrList = el('div', null, 'record-list');
    for (const r of d.lifetimeRecords.rows) {
      const row = el('div', null, 'podium-row');
      row.appendChild(el('span', r.label, 'label'));
      const podium = el('div', null, 'podium');
      r.top.forEach((e2, i) => {
        const entry = el('span', null, 'podium-entry');
        entry.append(el('i', String(i + 1)),
          el('b', `${fmtNumber(e2.value, r.precision)}${r.unit ? ` ${r.unit}` : ''}`),
          el('span', dateStrOf(e2.atMs), 'window'));
        podium.appendChild(entry);
      });
      row.appendChild(podium);
      lrList.appendChild(row);
    }
    lr.appendChild(lrList);
    methodNote(lr, d.lifetimeRecords);
  }
  main.appendChild(lr);

  // Badges.
  const bd = card('Milestones', `${d.badges.earnedCount} earned · lifetime totals from the whole history`);
  for (const b of d.badges.badges) {
    const row = el('div', null, 'badge-row');
    row.append(el('span', `${b.label} · ${fmtNumber(b.total, 0)}${b.unit ? ` ${b.unit}` : ''}`, 'badge-name'));
    const earned = el('div', null, 'badge-earned');
    for (const e2 of b.earned) earned.appendChild(el('span', e2.label, 'badge-pip'));
    row.appendChild(earned);
    if (b.next) {
      const next = el('div', null, 'badge-next');
      const track = el('div', null, 'badge-track');
      const fill = el('div', null, 'badge-fill');
      fill.style.width = `${Math.min(100, b.next.progress * 100)}%`;
      track.appendChild(fill);
      next.append(track, el('div', `next: ${b.next.label} · ${Math.round(b.next.progress * 100)}%`, 'badge-sub'));
      row.appendChild(next);
    }
    bd.appendChild(row);
  }
  methodNote(bd, d.badges);
  main.appendChild(bd);

  requestAnimationFrame(() => {
    lineChart(arcHost, {
      points: d.fitnessAgeArc.map((p) => ({ t: p.t, v: p.estimate })),
      unit: 'yrs', precision: 0, bucketMs: 30 * DAY_MS, label: 'Fitness age',
      connectGaps: true, color: seriesOf('heart'),
    }, window.innerWidth < 560 ? 140 : 170);
  });
}

// ---------------------------------------------------------------------------
// Calendar overlay — tap the date, land anywhere
// ---------------------------------------------------------------------------

async function openCalendar() {
  const dlg = $('calendar-dialog');
  state.calMonth = state.date.slice(0, 7);
  await renderCalendar();
  dlg.showModal();
}

async function renderCalendar() {
  const grid = $('cal-grid');
  const [y, m] = state.calMonth.split('-').map(Number);
  $('cal-title').textContent = new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: 'UTC' });
  grid.replaceChildren();
  for (const dow of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) grid.appendChild(el('span', dow, 'cal-dow'));

  let days = [];
  try {
    days = (await getJson(`${api('screen/calendar')}?month=${state.calMonth}&tz=${tzMs()}`)).days;
  } catch { /* the grid still renders; dots are decoration */ }
  const richness = new Map(days.map((x) => [dateStrOf(x.t), x]));

  const first = new Date(Date.UTC(y, m - 1, 1));
  const pad = (first.getUTCDay() + 6) % 7;
  for (let i = 0; i < pad; i++) grid.appendChild(el('span'));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${state.calMonth}-${String(day).padStart(2, '0')}`;
    const b = el('button', String(day), 'cal-day');
    b.type = 'button';
    const info = richness.get(dateStr);
    if (dateStr > todayStr()) b.disabled = true;
    if (dateStr === todayStr()) b.classList.add('today');
    if (dateStr === state.date) b.classList.add('picked');
    if (info && (info.hasSteps || info.hasSleep)) b.appendChild(el('span', null, 'dot'));
    if (info && info.sessions) b.classList.add('session');
    b.addEventListener('click', () => {
      $('calendar-dialog').close();
      state.date = dateStr;
      renderDayBar();
      load();
    });
    grid.appendChild(b);
  }
}

function shiftCalMonth(delta) {
  const [y, m] = state.calMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  state.calMonth = d.toISOString().slice(0, 7);
  renderCalendar();
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function renderStatus() {
  const s = state.status;
  if (!s) return;
  $('mark').classList.toggle('live', Boolean(s.sync && s.sync.running));
  let label;
  renderAuthBanner(s);
  if (s.authError) label = 'reconnect needed';
  else if (!s.connected) label = s.demo ? 'demo data' : 'not connected';
  else if (s.sync.phase === 'tail') label = 'syncing…';
  else if (s.sync.phase === 'backfill') label = 'backfilling…';
  else if (s.sync.lastTailMs) label = `synced ${ago(s.sync.lastTailMs)}`;
  else label = 'idle';
  $('sync-state').textContent = label;
  $('btn-sync').disabled = !s.connected;
}

/**
 * A refused refresh token leaves `connected` true (the row is still there) and the
 * header reading "synced 4d ago" — which is how four days of empty screens went
 * unexplained. Reconnecting takes the user, not a retry, so say so above the fold.
 */
function renderAuthBanner(s) {
  const banner = $('auth-banner');
  const needsSignIn = Boolean(s.authError) || (!s.connected && !s.demo);
  banner.hidden = !needsSignIn;
  if (!needsSignIn) return;
  $('auth-banner-text').textContent = s.authError
    ? 'Google stopped accepting the saved sign-in, so nothing has synced since '
      + (s.sync && s.sync.lastTailMs ? ago(s.sync.lastTailMs) : 'the token expired')
      + '. Sign in again to resume.'
    : 'Not connected to Google Health yet.';
}

function ago(ms) {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function renderDayBar() {
  const bar = $('daybar');
  const usesDate = state.view === 'today' || state.view === 'sleep';
  bar.hidden = !usesDate;
  if (!usesDate) return;
  const label = $('day-label');
  label.replaceChildren();
  label.appendChild(document.createTextNode(prettyDate(state.date)));
  label.appendChild(el('small', `${state.date} · tap to jump`));
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
    if (state.view === 'today') {
      data = await getJson(`${api('screen/today')}?date=${state.date}&tz=${tz}`);
    } else if (state.view === 'sleep') {
      data = await getJson(`${api('screen/sleep')}?date=${state.date}&tz=${tz}`);
    } else if (state.view === 'train') {
      data = await getJson(`${api('screen/train')}?tz=${tz}`);
    } else if (state.view === 'trends') {
      const p = state.compare;
      const a = p.a || todayStr();
      data = await getJson(`${api('screen/trends')}?tz=${tz}&a=${a}&b=${p.b}&metric=${p.metric}&heat=${p.heat}`);
    } else {
      data = await getJson(`${api('screen/you')}?tz=${tz}`);
    }
    if (mine !== token) return;
    state.data = data;
    render();
  } catch (err) {
    if (mine !== token) return;
    state.data = null;
    main.replaceChildren();
    main.className = '';
    const c = card('Could not load');
    c.appendChild(el('div', err.message, 'notice'));
    main.appendChild(c);
  } finally {
    if (mine === token) main.classList.remove('loading');
  }
}

function render() {
  const d = state.data;
  if (!d) return;
  // Belt and braces: never push a payload through another screen's renderer.
  if (d.view && d.view !== state.view) return;
  if (state.view === 'today') renderToday(d);
  else if (state.view === 'sleep') renderSleepScreen(d);
  else if (state.view === 'train') renderTrain(d);
  else if (state.view === 'trends') renderTrends(d);
  else renderYou(d);
}

function setView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll('.tab')) {
    const selected = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
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
  const tabs = [...document.querySelectorAll('.tab')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  }
  // The declared tablist pattern owes its keyboard model: one tab stop, arrows
  // move between tabs, Home/End jump.
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const i = tabs.findIndex((tab) => tab.dataset.view === state.view);
    let next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    setView(tabs[next].dataset.view);
    tabs[next].focus();
  });
  $('day-prev').addEventListener('click', () => {
    state.date = shiftDate(state.date, -1);
    renderDayBar();
    load();
  });
  $('day-next').addEventListener('click', () => {
    if (state.date >= todayStr()) return;
    state.date = shiftDate(state.date, 1);
    renderDayBar();
    load();
  });
  $('day-label').addEventListener('click', openCalendar);
  $('cal-prev').addEventListener('click', () => shiftCalMonth(-1));
  $('cal-next').addEventListener('click', () => shiftCalMonth(1));
  $('calendar-dialog').addEventListener('click', (e) => {
    if (e.target === $('calendar-dialog')) $('calendar-dialog').close();
  });

  $('strength-close').addEventListener('click', () => $('strength-dialog').close());
  $('strength-cancel').addEventListener('click', () => $('strength-dialog').close());
  $('strength-form').addEventListener('submit', saveStrength);

  $('btn-sync').addEventListener('click', async () => {
    const b = $('btn-sync');
    b.disabled = true;
    b.textContent = '…';
    try {
      const r = await sendJson(api('sync'));
      if (r.skipped) $('sync-state').textContent = 'already syncing…';
      else if (r.authError) $('sync-state').textContent = 'reconnect needed';
      await refreshStatus();
      await load();
    } catch (e) {
      $('sync-state').textContent = e.message;
    } finally {
      b.textContent = 'Sync';
      b.disabled = false;
    }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.data) render(); }, 220);
  });

  const es = new EventSource(api('stream'));
  let evtTimer;
  let evtHasData = false; // accumulated across the debounce window — the last
  // event alone can be a countless one that would cancel a pending reload.
  es.addEventListener('message', (msg) => {
    let evt;
    try { evt = JSON.parse(msg.data); } catch { return; }
    evtHasData = evtHasData || Boolean(evt.count);
    clearTimeout(evtTimer);
    evtTimer = setTimeout(() => {
      refreshStatus();
      if (evtHasData) { evtHasData = false; load(); }
    }, 1500);
  });
}

async function saveStrength(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const err = $('strength-error');
  err.hidden = true;
  try {
    await sendJson(api('strength'), {
      exercise: $('strength-exercise').value,
      sets: Number($('strength-sets').value),
      reps: Number($('strength-reps').value),
      weightKg: Number($('strength-weight').value),
    });
    $('strength-dialog').close();
    form.reset();
    await load();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

async function boot() {
  state.date = todayStr();
  state.compare.a = todayStr();
  initEvents();
  for (const tab of document.querySelectorAll('.tab')) {
    tab.tabIndex = tab.dataset.view === state.view ? 0 : -1;
  }
  renderDayBar();
  await refreshStatus();
  await load();
  setInterval(refreshStatus, 30000);
}

boot().catch((err) => {
  $('view').appendChild(el('div', `Failed to start: ${err.message}`, 'notice'));
});
