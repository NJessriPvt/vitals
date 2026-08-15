'use strict';
/**
 * Read side — turns stored points into the payloads the dashboard draws.
 *
 * This is deliberately separate from server.js (which is routing) and from db.js
 * (which is storage): it is the layer that knows what a chart needs, and it is pure
 * enough to test without starting an HTTP server.
 */

const catalog = require('./catalog');
const db = require('./db');

const BUCKETS = {
  raw: 0,
  minute: 60000,
  '5min': 300000,
  hour: 3600000,
  day: 86400000,
  week: 604800000,
};

/** Scale stored API units (millimetres, milliseconds) into display units. */
function scaled(v, type) {
  if (v === null || v === undefined) return null;
  return type.scale ? v * type.scale : v;
}

/**
 * Emit EVERY bucket in the range, present or not.
 *
 * Without this a sparse metric is drawn from whatever buckets happen to exist, and
 * the chart positions them by array index — so three workouts on Jul 20, Jul 29 and
 * Aug 3 come out evenly spaced, silently redrawing a nine-day gap and a five-day gap
 * as the same distance. Missing buckets carry null, which charts render as a break
 * rather than a zero: "no data" and "measured zero" are different claims.
 */
function denseBuckets(rows, from, to, bucketMs, offsetMs, make) {
  if (!bucketMs) return rows;
  const start = Math.floor((from + offsetMs) / bucketMs) * bucketMs - offsetMs;
  const byT = new Map(rows.map((r) => [r.t, r]));
  const out = [];
  for (let t = start; t < to; t += bucketMs) out.push(byT.has(t) ? byT.get(t) : make(t));
  return out;
}

async function seriesPayload(typeId, from, to, bucketMs, offsetMs) {
  const type = catalog.get(typeId);
  if (!type) throw Object.assign(new Error('unknown type'), { status: 404 });

  if (type.chart === 'stacked') {
    const ignore = new Set(type.stackIgnore || []);
    const rows = (await db.stackedSeries(typeId, from, to, bucketMs, offsetMs))
      .filter((r) => !ignore.has(r.key));
    const byBucket = new Map();
    for (const r of rows) {
      if (!byBucket.has(r.t)) byBucket.set(r.t, {});
      byBucket.get(r.t)[r.key] = scaled(r.v, type);
    }
    const keys = type.stackOrder.filter((k) => rows.some((r) => r.key === k));
    // A key the API sends that the catalog didn't anticipate still gets drawn,
    // appended after the known order rather than silently dropped from the total.
    for (const r of rows) if (!keys.includes(r.key)) keys.push(r.key);

    return {
      type: typeId, unit: type.unit, chart: 'stacked', bucketMs,
      precision: type.precision, goal: type.goal || null,
      keys, labels: type.stackLabels || {}, rampReverse: Boolean(type.rampReverse),
      points: denseBuckets(
        [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([t, parts]) => ({ t, parts })),
        from, to, bucketMs, offsetMs, (t) => ({ t, parts: {} }),
      ),
    };
  }

  const rows = await db.series(typeId, from, to, bucketMs, type.agg, offsetMs);
  return {
    type: typeId, unit: type.unit, chart: type.chart, bucketMs, agg: type.agg,
    band: Boolean(type.band) && bucketMs > 0,
    diverging: Boolean(type.diverging),
    // Standing values (weight, body fat, height) connect across empty buckets: your
    // weight did not stop existing on the days you didn't step on the scale, and a
    // field of disconnected dots is unreadable as a trend. Accumulating and sampled
    // metrics keep their gaps, where a missing bucket really does mean "not measured".
    connectGaps: Boolean(type.connectGaps),
    goal: type.goal || null,
    precision: type.precision,
    points: denseBuckets(
      rows.map((r) => ({
        t: r.t,
        v: scaled(r.v, type),
        lo: scaled(r.lo, type),
        hi: scaled(r.hi, type),
        n: r.n,
      })),
      from, to, bucketMs, offsetMs,
      (t) => ({ t, v: null, lo: null, hi: null, n: 0 }),
    ),
  };
}

/**
 * Stat tiles: a headline value, a delta against the previous equal-length period,
 * and a daily sparkline.
 *
 * The headline is computed from DAILY buckets rather than from the raw points,
 * because the honest summary of a cumulative metric is its daily average — summing
 * 30 days of steps gives a number nobody has an intuition for, and averaging raw
 * hourly points gives "average steps per hour", which answers nothing.
 */
async function summaryPayload(from, to, offsetMs) {
  const span = to - from;
  const out = [];

  for (const type of catalog.all().filter((t) => t.primary)) {
    const daily = await db.series(type.id, from, to, 86400000, type.agg, offsetMs);
    const values = daily.map((r) => r.v).filter((v) => v !== null && Number.isFinite(v));
    if (!values.length) continue;

    const headline = (vals) => {
      if (type.agg === 'max') return Math.max(...vals);
      if (type.agg === 'last') return vals[vals.length - 1];
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const mode = type.agg === 'sum' ? 'daily average'
      : type.agg === 'max' ? 'best'
        : type.agg === 'last' ? 'latest' : 'average';

    const value = headline(values);
    const prev = (await db.series(type.id, from - span, from, 86400000, type.agg, offsetMs))
      .map((r) => r.v).filter((v) => v !== null && Number.isFinite(v));
    let delta = null;
    if (prev.length) {
      const prevValue = headline(prev);
      if (prevValue) delta = ((value - prevValue) / Math.abs(prevValue)) * 100;
    }

    out.push({
      type: type.id,
      label: type.label,
      unit: type.unit,
      precision: type.precision,
      mode,
      value: scaled(value, type),
      delta,
      // Up is not always good: a rising resting heart rate is a worse number, and
      // painting it green because it went up would be actively misleading.
      upIsGood: !['daily-resting-heart-rate', 'body-fat', 'sedentary-period'].includes(type.id),
      goal: type.goal || null,
      spark: daily.map((r) => scaled(r.v, type)),
    });
  }
  return out;
}

async function tablePayload(typeId, from, to, limit) {
  const type = catalog.get(typeId);
  if (!type) throw Object.assign(new Error('unknown type'), { status: 404 });
  const rows = await db.rawPoints(typeId, from, to, limit);
  return {
    type: typeId, unit: type.unit, precision: type.precision,
    rows: rows.map((r) => ({
      start: r.start_ms, end: r.end_ms, anchor: r.anchor_ms,
      v: scaled(r.value, type),
      platform: r.platform, recording: r.recording,
      fields: r.fields ? JSON.parse(r.fields) : null,
    })),
  };
}


// ---------------------------------------------------------------------------
// Assistant digest
// ---------------------------------------------------------------------------

/**
 * Everything needed to answer "how did I sleep", "am I moving less this week",
 * "what was my heart rate today" in ONE call.
 *
 * This exists because the alternative is the assistant orchestrating five requests
 * and doing arithmetic on the results — which is slow, and which is where a language
 * model quietly invents a number. Aggregation belongs here, next to the data and the
 * units; the model's job is to read it out, not to compute it.
 *
 * Everything is pre-labelled with units and civil dates, and the payload states its
 * own freshness and coverage so the assistant can say "I only have data from the
 * 14th" instead of implying an absence of data is a zero.
 */

const TZ_OFFSET_MS = Number(process.env.VITALS_TZ_OFFSET_MIN || 240) * 60000;

function civilDayStart(ms, offsetMs) {
  return Math.floor((ms + offsetMs) / 86400000) * 86400000 - offsetMs;
}

const round = (v, p = 1) => (v === null || v === undefined || !Number.isFinite(v)
  ? null : Number(v.toFixed(p)));

/** One metric over one window, in display units. */
async function windowValue(typeId, from, to, agg) {
  const type = catalog.get(typeId);
  if (!type) return null;
  const v = await db.aggregate(typeId, from, to, agg || type.agg);
  return v === null ? null : scaled(v, type);
}

async function dayBlock(dayStart, offsetMs) {
  const dayEnd = dayStart + 86400000;
  const [steps, distance, azm, activeCal, totalCal, activeMin, restingHr, hrv, spo2] =
    await Promise.all([
      windowValue('steps', dayStart, dayEnd),
      windowValue('distance', dayStart, dayEnd),
      windowValue('active-zone-minutes', dayStart, dayEnd),
      windowValue('active-energy-burned', dayStart, dayEnd),
      windowValue('total-calories', dayStart, dayEnd),
      windowValue('active-minutes', dayStart, dayEnd),
      windowValue('daily-resting-heart-rate', dayStart, dayEnd, 'avg'),
      windowValue('daily-heart-rate-variability', dayStart, dayEnd, 'avg'),
      windowValue('daily-oxygen-saturation', dayStart, dayEnd, 'avg'),
    ]);

  // Heart rate needs min/avg/max together, which one aggregate cannot give.
  const [hrDay] = await db.series('heart-rate', dayStart, dayEnd, 86400000, 'avg', offsetMs);

  /**
   * Fall back to the SAMPLE types when the pre-rolled DAILY one is absent.
   *
   * This account gets no daily-resting-heart-rate, daily-hrv or daily-spo2 at all —
   * the device reports the underlying samples instead. Reporting null there would
   * tell the user "no data" about metrics they can plainly see on their watch, so
   * the fallback is computed here and labelled `derived` rather than passed off as
   * the device's own figure.
   */
  const [hrvFallback, spo2Fallback] = await Promise.all([
    hrv === null ? windowValue('heart-rate-variability', dayStart, dayEnd, 'avg') : null,
    spo2 === null ? windowValue('oxygen-saturation', dayStart, dayEnd, 'avg') : null,
  ]);

  // Resting heart rate: the lowest sustained rate while asleep is the standard
  // approximation, and the sleep window is the honest place to take it — a daytime
  // minimum catches a single quiet moment, not a resting baseline.
  let restingSource = restingHr === null ? null : 'device';
  let resting = restingHr;
  if (resting === null) {
    const nightEnd = dayStart + 8 * 3600000;
    const [night] = await db.series('heart-rate', dayStart - 4 * 3600000, nightEnd, 86400000 * 2, 'min', offsetMs);
    if (night && night.v !== null) { resting = night.v; restingSource = 'derived'; }
  }
  const [sleepRow] = await db.series('sleep', dayStart, dayEnd, 86400000, 'sum', offsetMs);
  const sleepParts = await db.stackedSeries('sleep', dayStart, dayEnd, 86400000, offsetMs);

  const stages = {};
  let stageTotal = 0;
  for (const p of sleepParts) {
    stages[p.key.toLowerCase()] = round(p.v / 3600000, 2);
    stageTotal += p.v;
  }
  const asleepMs = sleepRow ? sleepRow.v : null;

  return {
    date: new Date(dayStart + offsetMs).toISOString().slice(0, 10),
    steps: round(steps, 0),
    distanceKm: round(distance, 2),
    activeZoneMinutes: round(azm, 0),
    activeMinutes: round(activeMin, 0),
    activeCalories: round(activeCal, 0),
    totalCalories: round(totalCal, 0),
    restingHeartRateBpm: round(resting, 0),
    restingHeartRateSource: restingSource,
    heartRateBpm: hrDay
      ? { min: round(hrDay.lo, 0), avg: round(hrDay.v, 0), max: round(hrDay.hi, 0), samples: hrDay.n }
      : null,
    hrvMs: round(hrv === null ? hrvFallback : hrv, 0),
    spo2Percent: round(spo2 === null ? spo2Fallback : spo2, 1),
    sleep: asleepMs
      ? {
        hoursAsleep: round(asleepMs / 3600000, 2),
        // Efficiency is time asleep over time in bed; AWAKE is in `stages` but not
        // in `hoursAsleep`, so the two are not interchangeable.
        efficiencyPercent: stageTotal ? round((asleepMs / stageTotal) * 100, 0) : null,
        stageHours: stages,
      }
      : null,
  };
}

async function assistantDigest(nowMs = Date.now(), offsetMs = TZ_OFFSET_MS) {
  const today = civilDayStart(nowMs, offsetMs);
  const [stats, cursors, tokens] = await Promise.all([
    db.typeStats(), db.allCursors(), db.getTokens(),
  ]);

  const withData = stats.filter((s) => s.points > 0);
  const dataFrom = withData.length ? Math.min(...withData.map((s) => s.first_ms)) : null;
  const dataTo = withData.length ? Math.max(...withData.map((s) => s.last_ms)) : null;
  const lastSync = cursors.reduce((a, c) => Math.max(a, c.last_sync_ms || 0), 0) || null;

  // The last 14 civil days, newest first — enough to answer "compared to last week"
  // without a second call, and small enough to stay readable in a prompt.
  const days = [];
  for (let i = 0; i < 14; i++) {
    const start = today - i * 86400000;
    if (dataFrom !== null && start + 86400000 < dataFrom) break;
    days.push(await dayBlock(start, offsetMs));
  }

  const average = (key, n) => {
    const vals = days.slice(0, n).map((d) => d[key]).filter((v) => v !== null && Number.isFinite(v));
    return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 1) : null;
  };
  const period = (n) => ({
    days: Math.min(n, days.length),
    stepsPerDay: average('steps', n),
    distanceKmPerDay: average('distanceKm', n),
    activeZoneMinutesPerDay: average('activeZoneMinutes', n),
    totalCaloriesPerDay: average('totalCalories', n),
    restingHeartRateBpm: average('restingHeartRateBpm', n),
    hrvMs: average('hrvMs', n),
    sleepHoursPerNight: (() => {
      const vals = days.slice(0, n).map((d) => (d.sleep ? d.sleep.hoursAsleep : null))
        .filter((v) => v !== null);
      return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 2) : null;
    })(),
  });

  const notes = [];
  if (dataFrom) {
    notes.push(`Google Health holds this account's data from ${new Date(dataFrom + offsetMs).toISOString().slice(0, 10)} onward; there is no history before that.`);
  }
  // Types whose pre-rolled DAILY summary is absent but whose samples are present —
  // dayBlock fills these in from the samples. Listing them as "no data" would flatly
  // contradict the values in the same payload, and the assistant would repeat it.
  const DERIVED_FROM_SAMPLES = {
    'daily-resting-heart-rate': 'heart-rate',
    'daily-heart-rate-variability': 'heart-rate-variability',
    'daily-oxygen-saturation': 'oxygen-saturation',
  };
  const has = (id) => withData.some((s) => s.data_type === id);

  const substituted = Object.entries(DERIVED_FROM_SAMPLES)
    .filter(([daily, sample]) => !has(daily) && has(sample))
    .map(([daily]) => catalog.get(daily).label);
  if (substituted.length) {
    notes.push(`${substituted.join(', ')}: the device sends no daily summary for these, so the figures are DERIVED from raw samples. Treat them as close, not official.`);
  }

  const missing = catalog.all().filter((t) => t.primary
    && !has(t.id)
    && !(DERIVED_FROM_SAMPLES[t.id] && has(DERIVED_FROM_SAMPLES[t.id])));
  if (missing.length) {
    notes.push(`No data at all for: ${missing.map((t) => t.label).join(', ')} — the device does not report these.`);
  }
  notes.push('HR zones are DERIVED from raw heart-rate samples, not reported by Google Health.');

  return {
    generatedAt: new Date(nowMs).toISOString(),
    timezoneOffsetMinutes: offsetMs / 60000,
    connected: Boolean(tokens && tokens.refresh_token),
    freshness: {
      lastSyncAt: lastSync ? new Date(lastSync).toISOString() : null,
      lastSyncAgeMinutes: lastSync ? Math.round((nowMs - lastSync) / 60000) : null,
      dataThrough: dataTo ? new Date(dataTo).toISOString() : null,
      note: 'Sync runs every 5 minutes. POST /api/sync to force a refresh before answering if the user asks for right-now numbers.',
    },
    coverage: { from: dataFrom ? new Date(dataFrom).toISOString() : null, to: dataTo ? new Date(dataTo).toISOString() : null, totalPoints: withData.reduce((a, s) => a + s.points, 0) },
    today: days[0] || null,
    yesterday: days[1] || null,
    last7Days: period(7),
    last30Days: period(14),
    recentDays: days,
    notes,
  };
}

module.exports = {
  BUCKETS, scaled, denseBuckets, seriesPayload, summaryPayload, tablePayload,
  assistantDigest, dayBlock, civilDayStart, TZ_OFFSET_MS,
};
