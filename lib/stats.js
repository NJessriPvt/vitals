'use strict';
/**
 * Small statistics shared by every derived-insight module.
 *
 * These exist once because scores.js, night.js, training.js and trends.js all need
 * the same medians, quantiles and rolling averages — and because each of them being
 * subtly different (one sorting in place, one treating NaN as zero) is how two
 * screens end up disagreeing about the same baseline.
 *
 * Every function here treats null/undefined/NaN as "not measured" and drops it.
 * Nothing in this file ever substitutes a zero for an absence — that rule is
 * load-bearing across the whole app.
 */

const finite = (values) => values.filter((v) => v !== null && v !== undefined && Number.isFinite(v));

function mean(values) {
  const clean = finite(values);
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function median(values) {
  return quantile(values, 0.5);
}

/** Linear-interpolated quantile, q in [0,1]. */
function quantile(values, q) {
  const sorted = finite(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stdev(values) {
  const clean = finite(values);
  if (clean.length < 2) return null;
  const m = clean.reduce((a, b) => a + b, 0) / clean.length;
  return Math.sqrt(clean.reduce((a, v) => a + (v - m) ** 2, 0) / (clean.length - 1));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const round = (v, p = 1) => (v === null || v === undefined || !Number.isFinite(v)
  ? null : Number(v.toFixed(p)));

/**
 * Exponentially weighted moving average over a DENSE daily series.
 *
 * `values[i] = null` means "not measured" and leaves the average where it was —
 * decaying toward a missing day would treat an off-wrist day as a zero-load day,
 * which is a claim the data does not make. Training load deliberately passes real
 * zeros for rest days instead, because "did not train" IS zero load.
 */
function ewma(values, spanDays) {
  const alpha = 1 / spanDays;
  const out = [];
  let prev = null;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) {
      out.push(prev);
      continue;
    }
    prev = prev === null ? v : prev + alpha * (v - prev);
    out.push(prev);
  }
  return out;
}

/** Pearson correlation over paired samples; pairs with a missing side are dropped. */
function pearson(xs, ys) {
  const pairs = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
  }
  if (pairs.length < 3) return { r: null, n: pairs.length };
  const mx = pairs.reduce((a, p) => a + p[0], 0) / pairs.length;
  const my = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  if (!dx || !dy) return { r: null, n: pairs.length };
  return { r: num / Math.sqrt(dx * dy), n: pairs.length };
}

/**
 * Personal typical band: the middle of the person's own recent distribution.
 * p10/p90 rather than min/max so one bad night does not stretch the band forever.
 */
function personalBand(values, minPoints = 5) {
  const clean = finite(values);
  if (clean.length < minPoints) return null;
  return {
    median: median(clean),
    p10: quantile(clean, 0.1),
    p90: quantile(clean, 0.9),
    n: clean.length,
  };
}

/**
 * Minutes-of-day for clock arithmetic near midnight, anchored at 18:00 — a 23:40
 * bedtime and a 00:20 bedtime must read as 40 minutes apart, not 23 hours. Anything
 * from 18:00 to 17:59 the next day maps onto one continuous 0..1439 scale.
 */
function minutesFrom6pm(ms, offsetMs = 0) {
  const local = ms + offsetMs;
  const minutesOfDay = Math.floor((local % 86400000) / 60000);
  return (minutesOfDay - 18 * 60 + 1440) % 1440;
}

module.exports = {
  finite, mean, median, quantile, stdev, clamp, round, ewma, pearson,
  personalBand, minutesFrom6pm,
};
