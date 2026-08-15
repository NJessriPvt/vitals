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

module.exports = { BUCKETS, scaled, denseBuckets, seriesPayload, summaryPayload, tablePayload };
