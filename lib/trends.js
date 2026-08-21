'use strict';
/**
 * Compare & trends — baselines, verdicts, ghost days, the day duel, reports,
 * highlights, correlations.
 *
 * Three rules govern everything here:
 *
 *   - Comparison is always against YOURSELF: a band is your own p10–p90, a verdict
 *     is your last 90 days against your prior year, a ghost is your own typical
 *     Thursday. Population norms appear nowhere in this file.
 *   - Robust statistics only. Medians and quantiles, because a single feverish
 *     night or a marathon day must not bend a baseline for a month.
 *   - Correlation cards say "associated", state n and r, and never use the word
 *     "causes". The guardrails (n ≥ 14, |r| ≥ 0.3) are constants, not vibes.
 */

const catalog = require('./catalog');
const db = require('./db');
const stats = require('./stats');
const { scaled } = require('./query');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const { round } = stats;

/** Dense daily values for a type, display-scaled, oldest→newest. */
async function dailySeries(typeId, fromDay, toDay, offsetMs, agg) {
  const type = catalog.get(typeId);
  if (!type) return [];
  const rows = await db.series(typeId, fromDay, toDay, DAY_MS, agg || type.agg, offsetMs);
  const byT = new Map(rows.map((r) => [r.t, scaled(r.v, type)]));
  const out = [];
  for (let t = fromDay; t < toDay; t += DAY_MS) out.push({ t, v: byT.get(t) ?? null });
  return out;
}

// ---------------------------------------------------------------------------
// Baseline bands
// ---------------------------------------------------------------------------

/**
 * A recent series plus the personal band behind it — the layer every metric chart
 * gains. The band is computed from the WINDOW BEFORE the series starts where
 * possible, so the line is being compared against its past, not against itself.
 */
async function bandSeriesFor(typeId, days, offsetMs, { agg, bandDays = 28 } = {}) {
  const type = catalog.get(typeId);
  const today = Math.floor((Date.now() + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  const toDay = today + DAY_MS;
  const fromDay = toDay - days * DAY_MS;
  const series = await dailySeries(typeId, fromDay, toDay, offsetMs, agg);
  const bandSource = await dailySeries(typeId, fromDay - bandDays * DAY_MS, fromDay, offsetMs, agg);
  let band = stats.personalBand(bandSource.map((r) => r.v));
  // A young account has no "before" — fall back to the visible window and say so.
  let bandWindow = 'prior';
  if (!band) {
    band = stats.personalBand(series.map((r) => r.v));
    bandWindow = 'visible';
  }
  return {
    type: typeId,
    unit: type.unit,
    precision: type.precision,
    label: type.label,
    points: series.map((r) => ({ t: r.t, v: round(r.v, type.precision + 1) })),
    band: band ? {
      median: round(band.median, type.precision + 1),
      p10: round(band.p10, type.precision + 1),
      p90: round(band.p90, type.precision + 1),
      n: band.n,
      window: bandWindow,
    } : null,
    derived: true,
  };
}

// ---------------------------------------------------------------------------
// Trend verdicts — 90 days vs the prior 275
// ---------------------------------------------------------------------------

/** Pure so the arrow logic is testable: medians, and a 3% dead zone so one odd
 * week cannot flip a verdict. */
function buildVerdict({ id, label, unit, precision, upIsGood, recent, prior }) {
  const recentMedian = stats.median(recent);
  const priorMedian = stats.median(prior);
  const available = recentMedian !== null && priorMedian !== null && priorMedian !== 0
    && stats.finite(recent).length >= 14 && stats.finite(prior).length >= 30;
  let direction = null;
  let deltaPercent = null;
  let good = null;
  if (available) {
    deltaPercent = ((recentMedian - priorMedian) / Math.abs(priorMedian)) * 100;
    direction = Math.abs(deltaPercent) < 3 ? 'flat' : deltaPercent > 0 ? 'up' : 'down';
    good = direction === 'flat' ? null : (direction === 'up') === upIsGood;
  }
  return {
    id,
    label,
    unit,
    value: round(recentMedian, precision),
    prior: round(priorMedian, precision),
    deltaPercent: round(deltaPercent, 1),
    direction,
    good,
    available,
  };
}

const VERDICT_METRICS = [
  { id: 'steps', label: 'Steps', upIsGood: true },
  { id: 'sleep', label: 'Sleep', upIsGood: true },
  { id: 'daily-resting-heart-rate', label: 'Resting HR', upIsGood: false },
  { id: 'daily-heart-rate-variability', label: 'HRV', upIsGood: true },
  { id: 'active-zone-minutes', label: 'Zone minutes', upIsGood: true },
  { id: 'distance', label: 'Distance', upIsGood: true },
  { id: 'weight', label: 'Weight', upIsGood: false },
  { id: 'daily-respiratory-rate', label: 'Breathing', upIsGood: false },
  { id: 'daily-oxygen-saturation', label: 'SpO2', upIsGood: true },
];

async function verdictsFor(offsetMs) {
  const today = Math.floor((Date.now() + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  const out = await Promise.all(VERDICT_METRICS
    .filter((m) => catalog.get(m.id))
    .map(async (m) => {
      const type = catalog.get(m.id);
      const [recent, prior] = await Promise.all([
        dailySeries(m.id, today - 90 * DAY_MS, today + DAY_MS, offsetMs),
        dailySeries(m.id, today - 365 * DAY_MS, today - 90 * DAY_MS, offsetMs),
      ]);
      return {
        ...buildVerdict({
          id: m.id,
          label: m.label,
          unit: type.unit,
          precision: type.precision,
          upIsGood: m.upIsGood,
          recent: recent.map((r) => r.v),
          prior: prior.map((r) => r.v),
        }),
        spark: recent.filter((_, i) => i % 3 === 0).map((r) => round(r.v, type.precision + 1)),
      };
    }));
  return {
    metrics: out,
    derived: true,
    method: 'Median of the last 90 days vs the median of the prior 275; moves under 3% read as flat. Needs 14 recent and 30 prior measured days.',
  };
}

// ---------------------------------------------------------------------------
// Heat calendar
// ---------------------------------------------------------------------------

/** Daily cells for a metric over N weeks, plus quintile thresholds so every client
 * paints the same scale. */
async function heatFor(typeId, weeks, offsetMs) {
  const type = catalog.get(typeId);
  const today = Math.floor((Date.now() + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  const toDay = today + DAY_MS;
  const fromDay = toDay - weeks * 7 * DAY_MS;
  const series = await dailySeries(typeId, fromDay, toDay, offsetMs);
  const values = series.map((r) => r.v);
  const thresholds = [0.2, 0.4, 0.6, 0.8].map((q) => stats.quantile(values, q));
  return {
    type: typeId,
    label: type.label,
    unit: type.unit,
    precision: type.precision,
    from: fromDay,
    weeks,
    cells: series.map((r) => ({ t: r.t, v: round(r.v, type.precision) })),
    thresholds: thresholds.map((v) => round(v, type.precision + 1)),
  };
}

// ---------------------------------------------------------------------------
// Ghost days — your typical curve for this weekday
// ---------------------------------------------------------------------------

/**
 * The hourly median (and p25–p75) over the last `sample` same-weekdays. Weekdays
 * are different species — a typical Tuesday is not a typical Saturday — so the
 * ghost is per-weekday, never a flat average of everything.
 */
async function typicalDayFor(weekdayOf, typeId, offsetMs, { sample = 6 } = {}) {
  const type = catalog.get(typeId);
  const today = Math.floor((Date.now() + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  const from = today - sample * 7 * DAY_MS;
  const rows = await db.series(typeId, from, today, HOUR_MS, type.agg === 'sum' ? 'sum' : 'avg', offsetMs);

  const byHour = new Map();
  for (const r of rows) {
    if (r.v === null) continue;
    const local = r.t + offsetMs;
    const day = Math.floor(local / DAY_MS) * DAY_MS;
    const weekday = new Date(day).getUTCDay();
    if (weekday !== weekdayOf) continue;
    const hour = Math.floor((local - day) / HOUR_MS);
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour).push(scaled(r.v, type));
  }

  const points = [];
  for (let h = 0; h < 24; h++) {
    const vals = byHour.get(h) || [];
    points.push({
      hour: h,
      v: round(stats.median(vals), type.precision + 1),
      p25: round(stats.quantile(vals, 0.25), type.precision + 1),
      p75: round(stats.quantile(vals, 0.75), type.precision + 1),
      n: vals.length,
    });
  }
  return {
    type: typeId,
    weekday: weekdayOf,
    sampleWeeks: sample,
    points,
    derived: true,
    method: `Hourly median and p25–p75 over your last ${sample} same-weekdays.`,
  };
}

// ---------------------------------------------------------------------------
// Weekly / monthly report
// ---------------------------------------------------------------------------

/** Pure: aggregates for one period against the mean of the prior periods. */
function buildReport(current, priors, extras = {}) {
  const row = (id, label, unit, precision, value, priorValues, upIsGood) => {
    const prior = stats.mean(priorValues);
    const delta = value !== null && prior !== null && prior !== 0
      ? ((value - prior) / Math.abs(prior)) * 100 : null;
    return {
      id,
      label,
      unit,
      value: round(value, precision),
      prior: round(prior, precision),
      deltaPercent: round(delta, 1),
      good: delta === null || Math.abs(delta) < 3 ? null : (delta > 0) === upIsGood,
    };
  };
  const rows = [
    row('sleep', 'Sleep / night', 'h', 2, current.sleepAvg, priors.map((p) => p.sleepAvg), true),
    row('rhr', 'Resting HR', 'bpm', 0, current.rhrAvg, priors.map((p) => p.rhrAvg), false),
    row('hrv', 'HRV', 'ms', 0, current.hrvAvg, priors.map((p) => p.hrvAvg), true),
    row('load', 'Training load', 'TRIMP', 0, current.loadTotal, priors.map((p) => p.loadTotal), true),
    row('steps', 'Steps / day', '', 0, current.stepsAvg, priors.map((p) => p.stepsAvg), true),
    row('azm', 'Zone min / day', 'AZM', 0, current.azmAvg, priors.map((p) => p.azmAvg), true),
  ].filter((r) => r.value !== null);

  // Strain-vs-capacity balance: the load so far against what fitness could absorb
  // over the SAME number of elapsed days — dividing a Tuesday's partial sum by a
  // full week's capacity would read "restoring" every early week.
  let balance = null;
  const elapsedDays = Number.isFinite(extras.elapsedDays) ? extras.elapsedDays : 7;
  if (Number.isFinite(current.loadTotal) && Number.isFinite(extras.fitness)
    && extras.fitness >= 5 && elapsedDays > 0) {
    const ratio = current.loadTotal / (extras.fitness * elapsedDays);
    balance = {
      ratio: round(ratio, 2),
      elapsedDays,
      zone: ratio < 0.8 ? 'restoring' : ratio <= 1.25 ? 'optimal' : 'overreaching',
    };
  }
  return { rows, balance, priorPeriods: priors.length };
}

async function periodAggregates(from, to, offsetMs, loadByDay) {
  const avgOf = async (typeId, agg) => {
    const rows = await dailySeries(typeId, from, to, offsetMs, agg);
    return stats.mean(rows.map((r) => r.v));
  };
  let loadTotal = null;
  if (loadByDay) {
    const loads = [];
    for (let t = from; t < to; t += DAY_MS) {
      const l = loadByDay.get(t);
      if (l !== undefined && l !== null) loads.push(l);
    }
    loadTotal = loads.length ? loads.reduce((a, b) => a + b, 0) : null;
  }
  return {
    sleepAvg: await avgOf('sleep'),
    rhrAvg: await avgOf('daily-resting-heart-rate', 'avg'),
    hrvAvg: await avgOf('daily-heart-rate-variability', 'avg'),
    stepsAvg: await avgOf('steps'),
    azmAvg: await avgOf('active-zone-minutes'),
    loadTotal,
  };
}

/** The report for the week containing `dayStart` (weeks start Monday, viewer time). */
async function weeklyReportFor(dayStart, offsetMs, { loadByDay, fitness } = {}) {
  const local = dayStart + offsetMs;
  const weekday = (new Date(local).getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = dayStart - weekday * DAY_MS;
  // Mid-week, the current period is PARTIAL. Prior weeks are truncated to the same
  // elapsed span (Mon–today), because comparing a two-day load SUM against three
  // full-week sums reads as a −70% collapse by arithmetic alone.
  const end = Math.min(weekStart + 7 * DAY_MS, dayStart + DAY_MS);
  const spanMs = end - weekStart;
  const [current, ...priors] = await Promise.all([
    periodAggregates(weekStart, end, offsetMs, loadByDay),
    ...[1, 2, 3].map((i) => periodAggregates(
      weekStart - i * 7 * DAY_MS, weekStart - i * 7 * DAY_MS + spanMs, offsetMs, loadByDay,
    )),
  ]);
  return {
    weekStart,
    elapsedDays: spanMs / DAY_MS,
    ...buildReport(current, priors, { fitness, elapsedDays: spanMs / DAY_MS }),
    derived: true,
    method: 'This week against the mean of the prior three, each cut to the same elapsed weekdays; balance = TRIMP so far ÷ (elapsed days × Fitness) — under 0.8 restoring, to 1.25 optimal, above it overreaching.',
  };
}

// ---------------------------------------------------------------------------
// Highlights — passive anomaly surfacing
// ---------------------------------------------------------------------------

/**
 * Pure rules over 60-day daily windows. Ranked by how surprising the fact is and
 * capped at three — this is an editor, not a firehose. Each card carries the exact
 * claim it is making, including the window.
 */
function buildHighlights(metricWindows) {
  const cards = [];
  for (const m of metricWindows) {
    const values = stats.finite(m.values);
    if (values.length < 21) continue;
    const latestIdx = m.values.length - 1 - [...m.values].reverse().findIndex((v) => v !== null && Number.isFinite(v));
    const latest = m.values[latestIdx];
    if (latest === null || latest === undefined) continue;
    const others = values.filter((_, i) => i !== values.indexOf(latest));
    if (!others.length) continue;
    const isMax = latest >= Math.max(...others);
    const isMin = latest <= Math.min(...others);
    const sd = stats.stdev(values) || 0;
    const med = stats.median(values);
    const z = sd ? Math.abs(latest - med) / sd : 0;
    if (isMax && m.maxText) cards.push({ id: `${m.id}-max`, text: m.maxText(latest), metric: m.id, z: z + 1, atMs: m.times ? m.times[latestIdx] : null });
    else if (isMin && m.minText) cards.push({ id: `${m.id}-min`, text: m.minText(latest), metric: m.id, z: z + 1, atMs: m.times ? m.times[latestIdx] : null });
  }
  return cards.sort((a, b) => b.z - a.z).slice(0, 3).map(({ z, ...c }) => c);
}

async function highlightsFor(offsetMs) {
  const today = Math.floor((Date.now() + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  const window = async (typeId, agg) => {
    const rows = await dailySeries(typeId, today - 60 * DAY_MS, today + DAY_MS, offsetMs, agg);
    return { values: rows.map((r) => r.v), times: rows.map((r) => r.t) };
  };
  const fmt = (v, p = 0) => Number(v.toFixed(p)).toLocaleString();
  const [steps, sleep, rhr, hrv] = await Promise.all([
    window('steps'), window('sleep'), window('daily-resting-heart-rate', 'avg'),
    window('daily-heart-rate-variability', 'avg'),
  ]);
  return {
    cards: buildHighlights([
      { id: 'steps', ...steps, maxText: (v) => `Biggest step day in two months — ${fmt(v)} steps.` },
      { id: 'sleep', ...sleep, maxText: (v) => `Longest night in two months — ${fmt(v, 1)} h asleep.`, minText: (v) => `Shortest night in two months — ${fmt(v, 1)} h.` },
      { id: 'rhr', ...rhr, minText: (v) => `Lowest resting heart rate in two months — ${fmt(v)} bpm.`, maxText: (v) => `Highest resting heart rate in two months — ${fmt(v)} bpm.` },
      { id: 'hrv', ...hrv, maxText: (v) => `Highest HRV in two months — ${fmt(v)} ms.` },
    ]),
    derived: true,
    method: 'Each card is a two-month extreme reached today or on the most recent measured day; at most three show, most surprising first.',
  };
}

// ---------------------------------------------------------------------------
// Correlations — automated n-of-1 findings
// ---------------------------------------------------------------------------

const CORR_MIN_N = 14;
const CORR_MIN_R = 0.3;

/**
 * Pure: one candidate pair, already lag-aligned. Reports the split comparison
 * (mean of Y on above-median-X days vs below) because "r = −0.41" convinces
 * statisticians and "−9 ms" convinces people.
 */
function buildCorrelation({ id, xLabel, yLabel, unit, precision = 0, xs, ys }) {
  const { r, n } = stats.pearson(xs, ys);
  if (r === null || n < CORR_MIN_N || Math.abs(r) < CORR_MIN_R) return null;
  const xMed = stats.median(xs);
  const hi = [];
  const lo = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === null || ys[i] === null || !Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    (xs[i] >= xMed ? hi : lo).push(ys[i]);
  }
  const hiMean = stats.mean(hi);
  const loMean = stats.mean(lo);
  if (hiMean === null || loMean === null) return null;
  return {
    id,
    xLabel,
    yLabel,
    unit,
    r: round(r, 2),
    n,
    aboveMean: round(hiMean, precision),
    belowMean: round(loMean, precision),
    delta: round(hiMean - loMean, precision),
    derived: true,
  };
}

async function correlationsFor(offsetMs) {
  const today = Math.floor((Date.now() + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  const from = today - 45 * DAY_MS;
  const get = (rows) => rows.map((r) => r.v);
  const [sleep, hrv, rhr, steps, deep] = await Promise.all([
    dailySeries('sleep', from, today + DAY_MS, offsetMs),
    dailySeries('daily-heart-rate-variability', from, today + DAY_MS, offsetMs, 'avg'),
    dailySeries('daily-resting-heart-rate', from, today + DAY_MS, offsetMs, 'avg'),
    dailySeries('steps', from, today + DAY_MS, offsetMs),
    db.stackedSeries('sleep', from, today + DAY_MS, DAY_MS, offsetMs)
      .then((parts) => {
        const byT = new Map();
        for (const p of parts) if (p.key === 'DEEP') byT.set(p.t, p.v / HOUR_MS);
        const out = [];
        for (let t = from; t < today + DAY_MS; t += DAY_MS) out.push({ t, v: byT.get(t) ?? null });
        return out;
      }),
  ]);

  // Lag alignment: a night is anchored to its WAKE day, so "last night's sleep vs
  // today's HRV" pairs index i with index i — and "today's steps vs tonight's
  // sleep" pairs i with i+1.
  const shift = (rows) => rows.slice(1).map((r) => r.v);
  const cards = [
    buildCorrelation({
      id: 'sleep-hrv', xLabel: 'nights over your median sleep', yLabel: 'same-morning HRV', unit: 'ms',
      xs: get(sleep), ys: get(hrv),
    }),
    buildCorrelation({
      id: 'sleep-rhr', xLabel: 'nights over your median sleep', yLabel: 'same-morning resting HR', unit: 'bpm',
      xs: get(sleep), ys: get(rhr),
    }),
    buildCorrelation({
      id: 'steps-sleep', xLabel: 'days over your median steps', yLabel: 'that night’s sleep', unit: 'h', precision: 2,
      xs: get(steps).slice(0, -1), ys: shift(sleep),
    }),
    buildCorrelation({
      id: 'steps-deep', xLabel: 'days over your median steps', yLabel: 'that night’s deep sleep', unit: 'h', precision: 2,
      xs: get(steps).slice(0, -1), ys: shift(deep),
    }),
  ].filter(Boolean);

  return {
    cards,
    windowDays: 45,
    derived: true,
    method: `Pearson r over the last 45 days, shown only when n ≥ ${CORR_MIN_N} and |r| ≥ ${CORR_MIN_R}; the numbers are means on days above vs below your median. Associated, not causal.`,
  };
}

module.exports = {
  dailySeries, bandSeriesFor,
  buildVerdict, verdictsFor, heatFor, typicalDayFor,
  buildReport, weeklyReportFor, periodAggregates,
  buildHighlights, highlightsFor,
  buildCorrelation, correlationsFor,
};
