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

/**
 * Standardised deviation of `current` from the person's own history.
 *
 * z = (current − mean(history)) / max(sd(history), floor). The floor is what
 * keeps a very steady reader from being scored on a hair's width — Cadence's
 * per-metric floors (HRV 0.08 on ln, resting HR 1.5 bpm, breathing 0.5) are the
 * ones used, and callers pass them. Needs `minPoints` history values or null.
 */
function zScore(current, history, { floor = 1, minPoints = 5, transform = null } = {}) {
  if (!Number.isFinite(current)) return null;
  const clean = finite(history);
  if (clean.length < minPoints) return null;
  const f = transform || ((v) => v);
  const xs = clean.map(f);
  const m = mean(xs);
  const sd = stdev(xs);
  if (m === null) return null;
  const spread = Math.max(sd === null ? 0 : sd, floor);
  return (f(current) - m) / spread;
}

/** Average rank with ties averaged, 1-based. */
function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

/**
 * Spearman rank correlation with a two-sided p-value from the t approximation
 * (df = n − 2). Rank-based so one wild night cannot manufacture a finding.
 */
function spearman(xs, ys) {
  const px = [];
  const py = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) { px.push(xs[i]); py.push(ys[i]); }
  }
  const n = px.length;
  if (n < 4) return { rho: null, p: null, n };
  const { r } = pearson(ranks(px), ranks(py));
  if (r === null) return { rho: null, p: null, n };
  const rr = clamp(r, -0.999999, 0.999999);
  const t = rr * Math.sqrt((n - 2) / (1 - rr * rr));
  return { rho: r, p: tTwoSidedP(t, n - 2), n };
}

/** Regularised incomplete beta I_x(a, b) by continued fraction (Numerical Recipes). */
function betaInc(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);
  const cf = (xx, aa, bb) => {
    const tiny = 1e-30;
    let c = 1;
    let d = 1 - ((aa + bb) * xx) / (aa + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m;
      let num = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2));
      d = 1 + num * d; if (Math.abs(d) < tiny) d = tiny; d = 1 / d;
      c = 1 + num / c; if (Math.abs(c) < tiny) c = tiny;
      h *= d * c;
      num = -((aa + m) * (aa + bb + m) * xx) / ((aa + m2) * (aa + m2 + 1));
      d = 1 + num * d; if (Math.abs(d) < tiny) d = tiny; d = 1 / d;
      c = 1 + num / c; if (Math.abs(c) < tiny) c = tiny;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 3e-14) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2)
    ? (front * cf(x, a, b)) / a
    : 1 - (front * cf(1 - x, b, a)) / b;
}

function lgamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Two-sided p for a t statistic with `df` degrees of freedom. */
function tTwoSidedP(t, df) {
  if (!Number.isFinite(t) || df <= 0) return null;
  const x = df / (df + t * t);
  return clamp(betaInc(x, df / 2, 0.5), 0, 1);
}

/**
 * Benjamini–Hochberg step-up: q-values controlling the false discovery rate over
 * ONE family of tests. Nulls pass through as null. Four cards at |r| ≥ 0.3 with no
 * correction fire on a pure-noise month more often than not; this is the fix.
 */
function benjaminiHochberg(ps) {
  const idx = ps.map((p, i) => [p, i]).filter(([p]) => Number.isFinite(p)).sort((a, b) => a[0] - b[0]);
  const m = idx.length;
  const q = ps.map(() => null);
  let running = 1;
  for (let k = m - 1; k >= 0; k--) {
    running = Math.min(running, (idx[k][0] * m) / (k + 1));
    q[idx[k][1]] = running;
  }
  return q;
}

module.exports = {
  finite, mean, median, quantile, stdev, clamp, round, ewma, pearson,
  personalBand, minutesFrom6pm,
  zScore, spearman, tTwoSidedP, benjaminiHochberg,
};
