'use strict';
/**
 * Explainable, WHOOP-inspired insights derived from data we actually hold.
 *
 * These are not WHOOP's proprietary Activity Strain or Recovery algorithms. Activity
 * detection uses only the heart-rate stream (there is no accelerometer or movement
 * model here), and recovery is a transparent comparison with the user's own recent
 * baseline. Payloads carry the method and `derived: true` so the UI cannot quietly
 * present an estimate as a device measurement.
 */

const db = require('./db');
const metrics = require('./metrics');
const stats = require('./stats');

const MINUTE_MS = 60000;
const DAY_MS = 86400000;
const BASELINE_DAYS = 28;
const MIN_BASELINE_POINTS = 5;
const FITNESS_WINDOW_DAYS = 28;
const FITNESS_MIN_CURRENT_DAYS = 18;
const FITNESS_MIN_TREND_DAYS = 14;
const FITNESS_MIN_SIGNALS = 3;
const FITNESS_MAX_DELTA_YEARS = 8;

// Shared statistics from lib/stats.js — this module re-implementing its own
// round/median/mean/clamp was exactly the drift stats.js exists to prevent.
const { round, median, mean, clamp } = stats;

function zoneFor(value, thresholds) {
  const i = thresholds.findIndex((threshold) => value < threshold);
  return i === -1 ? 6 : i + 1;
}

/**
 * Segment a sorted HR stream into sustained elevated-HR sessions.
 *
 * - Entry is Zone 3 (60% of max HR), so age/manual max HR changes the threshold.
 * - Ten elevated minutes are required, matching WHOOP's published minimum as of
 *   August 2026.
 * - A five-minute dip ends a session; shorter dips preserve interval workouts.
 * - A five-minute sample gap also ends a session instead of inventing activity while
 *   the watch was off-wrist.
 */
function detectActivities(samples, {
  maxHr,
  minDurationMs = 10 * MINUTE_MS,
  breakMs = 5 * MINUTE_MS,
  maxSampleGapMs = 5 * MINUTE_MS,
  coverageCapMs = MINUTE_MS,
} = {}) {
  if (!Number.isFinite(maxHr) || maxHr <= 0) return [];

  const thresholds = metrics.thresholdsFor(maxHr);
  const enterBpm = thresholds[1]; // 60% max HR: the start of Zone 3.
  const clean = samples
    .map((sample) => ({ t: Number(sample.t), v: Number(sample.v) }))
    .filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.v) && sample.v > 0)
    .sort((a, b) => a.t - b.t);

  const sessions = [];
  let candidate = null;
  let previous = null;

  const finish = () => {
    if (!candidate) return;
    const finished = candidate;
    const end = finished.lastElevated;
    const durationMs = end - finished.start;
    const inWindow = finished.samples.filter((sample) => sample.t <= end);
    candidate = null;
    if (durationMs < minDurationMs || inWindow.length < 2) return;

    const zoneMs = {};
    let weightedHr = 0;
    let trackedMs = 0;
    let elevatedMs = 0;
    let max = 0;
    for (let i = 0; i < inWindow.length - 1; i++) {
      const sample = inWindow[i];
      // Match db.heartRateZones(): one sparse sample never claims more than one
      // minute of physiological coverage, even though up to five minutes is allowed
      // when deciding whether an interval workout remains one session.
      const dt = Math.min(coverageCapMs, Math.max(0, inWindow[i + 1].t - sample.t), end - sample.t);
      if (!dt) continue;
      const zone = zoneFor(sample.v, thresholds);
      zoneMs[zone] = (zoneMs[zone] || 0) + dt;
      weightedHr += sample.v * dt;
      trackedMs += dt;
      if (sample.v >= enterBpm) elevatedMs += dt;
      max = Math.max(max, sample.v);
    }
    max = Math.max(max, ...inWindow.map((sample) => sample.v));
    if (elevatedMs < minDurationMs) return;

    const minutes = {};
    for (const zone of metrics.ZONES) minutes[zone.zone] = round((zoneMs[zone.zone] || 0) / MINUTE_MS, 1);
    const peakZone = zoneFor(max, thresholds);
    const averageHr = trackedMs ? weightedHr / trackedMs : null;
    sessions.push({
      start: finished.start,
      end,
      durationMinutes: round(durationMs / MINUTE_MS, 0),
      elevatedMinutes: round(elevatedMs / MINUTE_MS, 0),
      averageHeartRate: round(averageHr, 0),
      maxHeartRate: round(max, 0),
      averagePercentMax: averageHr === null ? null : round((averageHr / maxHr) * 100, 0),
      peakZone,
      zoneMinutes: minutes,
      cardioLoad: metrics.cardioLoad(Object.fromEntries(
        Object.entries(zoneMs).map(([zone, ms]) => [zone, ms / MINUTE_MS]),
      )),
      source: 'heart-rate',
      derived: true,
    });
  };

  for (const sample of clean) {
    if (previous && sample.t - previous.t >= maxSampleGapMs) finish();

    if (sample.v >= enterBpm) {
      if (candidate && sample.t - candidate.lastElevated > breakMs) finish();
      if (!candidate) candidate = { start: sample.t, lastElevated: sample.t, samples: [] };
      candidate.lastElevated = sample.t;
      candidate.samples.push(sample);
    } else if (candidate) {
      candidate.samples.push(sample);
      if (sample.t - candidate.lastElevated >= breakMs) finish();
    }
    previous = sample;
  }
  finish();

  return sessions;
}

async function detectedActivities(fromMs, toMs, profile) {
  const samples = await db.heartRateSamples(fromMs, toMs);
  const sessions = detectActivities(samples, { maxHr: profile.maxHeartRate });
  await Promise.all(sessions.map(async (session) => {
    session.activeCalories = round(await db.intervalValue('active-energy-burned', session.start, session.end), 0);
  }));
  return {
    sessions,
    count: sessions.length,
    thresholdBpm: metrics.thresholdsFor(profile.maxHeartRate)[1],
    minimumMinutes: 10,
    maxHeartRate: profile.maxHeartRate,
    maxHeartRateSource: profile.maxHeartRateSource,
    derived: true,
    method: 'At least 10 minutes at or above 60% max HR; gaps or dips of 5 minutes end a session',
    limitation: 'Heart-rate only: activity type needs movement or GPS data and is not guessed. Calories use granular active-energy intervals where available, with daily energy prorated only across uncovered time.',
  };
}

function signal(id, label, unit, current, baseline, baselineCount, status, extra = {}) {
  return {
    id, label, unit,
    current: round(current, unit === 'h' ? 2 : 0),
    baseline: round(baseline, unit === 'h' ? 2 : 0),
    baselineCount,
    status,
    ...extra,
  };
}

/** Pure classification so boundary behavior is unit-testable. */
function buildRecoveryOutlook(current, baselines, goalHours = 8) {
  const hrvBaseline = baselines.hrv.length >= MIN_BASELINE_POINTS ? median(baselines.hrv) : null;
  const rhrBaseline = baselines.restingHeartRate.length >= MIN_BASELINE_POINTS
    ? median(baselines.restingHeartRate) : null;
  const sleepBaseline = baselines.sleepHours.length >= MIN_BASELINE_POINTS
    ? median(baselines.sleepHours) : null;

  const hrvDelta = current.hrv !== null && hrvBaseline
    ? ((current.hrv - hrvBaseline) / hrvBaseline) * 100 : null;
  const rhrDelta = current.restingHeartRate !== null && rhrBaseline !== null
    ? current.restingHeartRate - rhrBaseline : null;
  const sleepRatio = current.sleepHours !== null ? current.sleepHours / goalHours : null;

  const hrvStatus = hrvDelta === null ? 'unavailable'
    : hrvDelta >= 5 ? 'positive' : hrvDelta <= -10 ? 'negative' : 'neutral';
  const rhrStatus = rhrDelta === null ? 'unavailable'
    : rhrDelta <= -2 ? 'positive' : rhrDelta >= 3 ? 'negative' : 'neutral';
  const sleepStatus = sleepRatio === null ? 'unavailable'
    : sleepRatio >= 1 ? 'positive' : sleepRatio < 0.8 ? 'negative' : 'neutral';

  const signals = [
    signal('hrv', 'HRV', 'ms', current.hrv, hrvBaseline, baselines.hrv.length, hrvStatus, {
      deltaPercent: round(hrvDelta, 0), source: current.hrvSource || null,
    }),
    signal('resting-heart-rate', 'Resting HR', 'bpm', current.restingHeartRate,
      rhrBaseline, baselines.restingHeartRate.length, rhrStatus, {
        delta: round(rhrDelta, 0), source: current.restingHeartRateSource || null,
      }),
    signal('sleep', 'Sleep', 'h', current.sleepHours, sleepBaseline,
      baselines.sleepHours.length, sleepStatus, {
        goal: goalHours, goalPercent: round(sleepRatio === null ? null : sleepRatio * 100, 0),
      }),
  ];

  const available = signals.filter((item) => item.status !== 'unavailable');
  const positives = available.filter((item) => item.status === 'positive').length;
  const negatives = available.filter((item) => item.status === 'negative').length;
  let status = 'calibrating';
  if (available.length >= 2) {
    if (negatives >= 2) status = 'low';
    else if (positives >= 2 && negatives === 0) status = 'strong';
    else status = 'balanced';
  }

  const labels = {
    calibrating: 'Building baseline', low: 'Recovery signals low',
    balanced: 'Recovery signals balanced', strong: 'Recovery signals strong',
  };
  return {
    status,
    label: labels[status],
    signals,
    availableSignals: available.length,
    baselineDays: BASELINE_DAYS,
    minimumBaselinePoints: MIN_BASELINE_POINTS,
    derived: true,
    method: 'HRV and resting HR versus the prior 28-day median; sleep versus the 8-hour goal',
    limitation: 'A transparent training guide, not WHOOP Recovery and not medical advice.',
  };
}

/** Daily values with the DAILY→sample fallback, oldest→newest, nulls dropped.
 * Shared with lib/screens.js — one implementation so baselines cannot drift. */
async function dailyValues(primaryType, fallbackType, fromMs, toMs, agg, offsetMs) {
  const [primary, fallback] = await Promise.all([
    db.series(primaryType, fromMs, toMs, DAY_MS, agg, offsetMs),
    fallbackType ? db.series(fallbackType, fromMs, toMs, DAY_MS, agg, offsetMs) : [],
  ]);
  const byDay = new Map(fallback.map((row) => [row.t, row.v]));
  for (const row of primary) byDay.set(row.t, row.v);
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
    .filter((value) => value !== null && Number.isFinite(value));
}

/**
 * Resting heart rate per day, oldest→newest, as {t, v, source}: the device's daily
 * figure where it sends one, otherwise the DERIVED sleeping heart rate (lowest
 * decile of one-minute averages over the night, see db.sleepingHeartRateDaily).
 * ONE implementation for the current value, the 28-day baseline, fitness age and
 * the assistant digest — they used to take three different windows and compare
 * unlike things.
 */
async function restingDaily(fromMs, toMs, offsetMs) {
  const [device, derived] = await Promise.all([
    db.series('daily-resting-heart-rate', fromMs, toMs, DAY_MS, 'avg', offsetMs),
    db.sleepingHeartRateDaily(fromMs, toMs, offsetMs),
  ]);
  const byDay = new Map();
  for (const r of derived) if (r.v !== null) byDay.set(r.t, { t: r.t, v: r.v, source: 'derived' });
  for (const r of device) if (r.v !== null) byDay.set(r.t, { t: r.t, v: r.v, source: 'device' });
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

async function recoveryOutlook(dayStart, offsetMs, current, goalHours = 8) {
  const baselineFrom = dayStart - BASELINE_DAYS * DAY_MS;
  const dayEnd = dayStart + DAY_MS;
  const [currentHrvDaily, currentHrvSamples, hrv, restingHeartRate, sleepMs] = await Promise.all([
    db.aggregate('daily-heart-rate-variability', dayStart, dayEnd, 'avg'),
    db.aggregate('heart-rate-variability', dayStart, dayEnd, 'avg'),
    dailyValues('daily-heart-rate-variability', 'heart-rate-variability',
      baselineFrom, dayStart, 'avg', offsetMs),
    restingDaily(baselineFrom, dayStart, offsetMs).then((rows) => rows.map((r) => r.v)),
    dailyValues('sleep', null, baselineFrom, dayStart, 'sum', offsetMs),
  ]);

  return buildRecoveryOutlook({
    hrv: currentHrvDaily === null ? currentHrvSamples : currentHrvDaily,
    hrvSource: currentHrvDaily !== null ? 'device' : currentHrvSamples !== null ? 'derived' : null,
    restingHeartRate: current.restingHeartRate,
    restingHeartRateSource: current.restingHeartRateSource,
    sleepHours: current.sleepHours,
  }, {
    hrv,
    restingHeartRate,
    sleepHours: sleepMs.map((value) => value / 3600000),
  }, goalHours);
}

/**
 * Population reference tables — the referent the word "age" needs. Sex is not
 * known to this app (the Google profile grants age only), so every table is the
 * male/female mean; that is stated in the payload.
 *
 *  - HRV: nightly RMSSD medians by five-year age band from Tegegne et al. 2020
 *    (Lifelines cohort, n = 84,772; daytime values), lifted by e^0.30 to the
 *    nocturnal level — the one constant here that is not from a paper (Cadence's
 *    AgeNorms, unchanged so the two apps read the same person the same way).
 *  - Resting HR: 64 male / 67 female from Quer et al. 2020 (wearable cohort,
 *    n = 92,457).
 *  - VO2max: 15.3 × HRmax / HRrest (Uth et al. 2004), read against the FRIEND
 *    registry decade medians (Kaminsky 2015), interpolated in ln.
 */
const NORM_AGES_HRV = [22, 27, 32, 37, 42, 47, 52, 57, 62, 67, 72, 77];
const NORM_HRV_MALE = [47.6, 42.3, 36.9, 32.8, 29.0, 26.0, 23.7, 21.0, 19.1, 17.7, 16.0, 14.9];
const NORM_HRV_FEMALE = [52.1, 47.5, 42.3, 37.9, 33.9, 29.2, 26.6, 22.5, 20.5, 17.8, 17.0, 16.1];
const NOCTURNAL_LN_SHIFT = 0.30;
const NORM_AGES_VO2 = [25, 35, 45, 55, 65, 75];
const NORM_VO2_MALE = [49.5, 45.0, 41.0, 37.3, 33.9, 30.9];
const NORM_VO2_FEMALE = [40.6, 36.9, 33.6, 30.6, 27.8, 25.3];
const NORM_RHR = (64 + 67) / 2;
const unisex = (m, f) => m.map((v, i) => (v + f[i]) / 2);
const NORM_HRV = unisex(NORM_HRV_MALE, NORM_HRV_FEMALE).map((v) => v * Math.exp(NOCTURNAL_LN_SHIFT));
const NORM_VO2 = unisex(NORM_VO2_MALE, NORM_VO2_FEMALE);

/** Piecewise-linear in ln(value) over age, extrapolated at the ends, then clamped. */
function normAgeFor(value, ages, table) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const logs = table.map(Math.log);
  const y = Math.log(value);
  // Tables fall with age, so walk them descending in value.
  const seg = (i) => {
    const [x0, y0, x1, y1] = [logs[i], ages[i], logs[i + 1], ages[i + 1]];
    return y0 + ((y1 - y0) * (y - x0)) / (x1 - x0);
  };
  let i = logs.findIndex((l, k) => k < logs.length - 1 && y <= l && y >= logs[k + 1]);
  if (i === -1) i = y > logs[0] ? 0 : logs.length - 2;
  return clamp(seg(i), 18, 90);
}

/**
 * Fitness age: profile age plus five bounded driver contributions, each the gap
 * between where the person sits on a published norm and their calendar age.
 *
 * The previous version scored two of its four factors on CHANGE against the
 * person's own prior month, so a stable excellent resting heart rate earned
 * nothing and a training block that lifted it four beats "aged" the reader two
 * years. A level needs a referent; these tables are it. Whole-year resolution
 * and a hard ±8-year clamp keep the estimate honest about its precision.
 */
function buildFitnessAge(actualAge, input, { sleepGoalHours = 8, trainingReferenceMinutes = 150 } = {}) {
  const validAge = Number.isFinite(actualAge) && actualAge >= 18 && actualAge <= 90;
  const factors = [];
  const addFactor = ({
    id, label, available, contributionYears = null, value = null, unit = '',
    reference = null, referenceLabel = '', coverage, detail,
  }) => {
    const impact = available ? round(contributionYears, 1) : null;
    factors.push({
      id, label, available, contributionYears: impact,
      status: !available ? 'unavailable' : impact < -0.25 ? 'favorable' : impact > 0.25 ? 'unfavorable' : 'neutral',
      value: round(value, unit === 'h' ? 2 : unit === 'ml/kg/min' ? 1 : 0), unit,
      reference: round(reference, unit === 'h' ? 2 : unit === 'ml/kg/min' ? 1 : 0), referenceLabel,
      coverage, detail,
    });
  };

  const hrv = input.hrv || {};
  const hrvOk = Number.isFinite(hrv.recentMedian) && hrv.recentMedian > 0 && hrv.recentDays >= FITNESS_MIN_TREND_DAYS;
  const hrvAge = hrvOk ? normAgeFor(hrv.recentMedian, NORM_AGES_HRV, NORM_HRV) : null;
  addFactor({
    id: 'hrv', label: 'HRV vs norms', available: hrvOk && validAge,
    contributionYears: hrvOk && validAge ? clamp(hrvAge - actualAge, -16, 16) * 0.25 : null,
    value: hrvOk ? hrv.recentMedian : null, unit: 'ms',
    reference: validAge ? interpolateNorm(actualAge, NORM_AGES_HRV, NORM_HRV) : null, referenceLabel: 'median for your age',
    coverage: { recentDays: hrv.recentDays || 0, requiredDays: FITNESS_MIN_TREND_DAYS },
    detail: hrvOk && validAge
      ? `your nightly HRV sits where the population median is at ${Math.round(hrvAge)} (Lifelines, n = 84,772)`
      : `Need ${FITNESS_MIN_TREND_DAYS} measured nights; have ${hrv.recentDays || 0}`,
  });

  const rhr = input.restingHeartRate || {};
  const rhrOk = Number.isFinite(rhr.recentMedian) && rhr.recentDays >= FITNESS_MIN_TREND_DAYS;
  addFactor({
    id: 'resting-heart-rate', label: 'Resting HR vs norms', available: rhrOk,
    contributionYears: rhrOk ? clamp(rhr.recentMedian - NORM_RHR, -6, 6) * 0.20 : null,
    value: rhrOk ? rhr.recentMedian : null, unit: 'bpm',
    reference: NORM_RHR, referenceLabel: 'population median',
    coverage: { recentDays: rhr.recentDays || 0, requiredDays: FITNESS_MIN_TREND_DAYS },
    detail: rhrOk
      ? `${round(rhr.recentMedian - NORM_RHR, 0) > 0 ? '+' : ''}${round(rhr.recentMedian - NORM_RHR, 0)} bpm vs the wearable-cohort median of ${NORM_RHR} (n = 92,457)`
      : `Need ${FITNESS_MIN_TREND_DAYS} measured days; have ${rhr.recentDays || 0}`,
  });

  // Cardio fitness from Uth's HRmax/HRrest ratio. With an age-estimated max HR the
  // estimate is a monotone function of the same resting HR the driver above reads,
  // so its weight is halved — it only earns full weight from a measured max.
  // Cardio fitness from Uth's HRmax/HRrest ratio — only with a MEASURED max HR.
  // With `220 − age` in the numerator the estimate is a function of the same
  // resting HR the driver above already reads, and against FRIEND norms it
  // reads a person on every median about a year younger; so it is not a driver
  // until a real max is set through /api/settings.
  const maxHr = input.maxHeartRate || {};
  const measuredMax = maxHr.source === 'manual';
  const cardioOk = rhrOk && measuredMax && Number.isFinite(maxHr.value) && maxHr.value > rhr.recentMedian;
  const vo2 = cardioOk ? (15.3 * maxHr.value) / rhr.recentMedian : null;
  const vo2Age = cardioOk ? normAgeFor(vo2, NORM_AGES_VO2, NORM_VO2) : null;
  addFactor({
    id: 'cardio', label: 'Cardio fitness', available: cardioOk && validAge,
    contributionYears: cardioOk && validAge ? clamp(vo2Age - actualAge, -10, 10) * 0.25 : null,
    value: vo2, unit: 'ml/kg/min',
    reference: validAge ? interpolateNorm(actualAge, NORM_AGES_VO2, NORM_VO2) : null, referenceLabel: 'median for your age',
    coverage: { recentDays: rhr.recentDays || 0, requiredDays: FITNESS_MIN_TREND_DAYS },
    detail: cardioOk && validAge
      ? `VO2max ≈ 15.3 × ${Math.round(maxHr.value)} ÷ ${Math.round(rhr.recentMedian)} (Uth 2004) against FRIEND decade medians`
      : 'Needs a measured max HR (set maxHeartRate in settings) and a resting HR history',
  });

  const training = input.training || {};
  const trainingOk = Number.isFinite(training.weeklyMinutes) && training.days >= FITNESS_MIN_CURRENT_DAYS;
  addFactor({
    id: 'training', label: 'Activity', available: trainingOk,
    contributionYears: trainingOk ? -clamp((training.weeklyMinutes - trainingReferenceMinutes) / 37.5, -4, 4) * 0.10 : null,
    value: trainingOk ? training.weeklyMinutes : null, unit: 'min/wk',
    reference: trainingReferenceMinutes, referenceLabel: 'WHO weekly minimum',
    coverage: { recentDays: training.days || 0, requiredDays: FITNESS_MIN_CURRENT_DAYS },
    detail: trainingOk
      ? `${round(training.weeklyMinutes, 0)} active-zone min/week across ${training.days} recorded days vs the WHO ${trainingReferenceMinutes}`
      : `Need ${FITNESS_MIN_CURRENT_DAYS} active-zone days; have ${training.days || 0}`,
  });

  const sleep = input.sleep || {};
  const sleepOk = Number.isFinite(sleep.averageHours) && sleep.days >= FITNESS_MIN_CURRENT_DAYS;
  const outside = sleepOk ? (sleep.averageHours < 7 ? 7 - sleep.averageHours : sleep.averageHours > 9 ? sleep.averageHours - 9 : 0) : null;
  addFactor({
    id: 'sleep', label: 'Sleep duration', available: sleepOk,
    contributionYears: sleepOk ? clamp(outside * 2, 0, 4) * 0.10 : null,
    value: sleepOk ? sleep.averageHours : null, unit: 'h',
    reference: sleepGoalHours, referenceLabel: 'NSF 7–9 h',
    coverage: { recentDays: sleep.days || 0, requiredDays: FITNESS_MIN_CURRENT_DAYS },
    detail: sleepOk
      ? `${round(sleep.averageHours, 1)} h average across ${sleep.days} nights${outside ? `, ${round(outside, 1)} h outside the 7–9 h range` : ', inside the 7–9 h range'}`
      : `Need ${FITNESS_MIN_CURRENT_DAYS} measured nights; have ${sleep.days || 0}`,
  });

  const available = factors.filter((f) => f.available);
  const coverageRatios = available.map((f) => Math.min(1, f.coverage.recentDays / FITNESS_WINDOW_DAYS));
  const coverageScore = mean(coverageRatios);
  const enough = validAge && available.length >= FITNESS_MIN_SIGNALS
    && available.some((f) => f.id === 'hrv') && available.some((f) => f.id === 'resting-heart-rate');
  // Cardio is optional by design (it needs a measured max), so it does not count
  // against confidence.
  const required = factors.filter((f) => f.id !== 'cardio');
  const confidence = !enough ? 'insufficient'
    : required.every((f) => f.available) && coverageRatios.every((r) => r >= 0.75) ? 'high' : 'moderate';

  let estimate = null;
  let deltaYears = null;
  if (enough) {
    const rawDelta = available.reduce((sum, f) => sum + f.contributionYears, 0);
    const boundedDelta = clamp(Math.round(rawDelta), -FITNESS_MAX_DELTA_YEARS, FITNESS_MAX_DELTA_YEARS);
    estimate = clamp(actualAge + boundedDelta, 18, 90);
    deltaYears = estimate - actualAge;
  }

  return {
    estimate,
    actualAge: validAge ? actualAge : null,
    deltaYears,
    direction: deltaYears === null ? 'unavailable' : deltaYears < 0 ? 'younger' : deltaYears > 0 ? 'older' : 'aligned',
    factors,
    coverage: {
      recentWindowDays: FITNESS_WINDOW_DAYS,
      availableSignals: available.length,
      requiredSignals: FITNESS_MIN_SIGNALS,
      score: round(coverageScore, 2),
      confidence,
    },
    derived: true,
    method: 'Profile age plus five bounded drivers, each the gap between where you sit on a published norm and your calendar age: '
      + 'nightly HRV vs Lifelines age-band medians (Tegegne 2020, n = 84,772, lifted e^0.30 to the nocturnal level — the one uncited constant) × 0.25; '
      + 'resting HR vs the wearable-cohort median 65.5 (Quer 2020, n = 92,457), ±6 bpm × 0.20; '
      + 'VO2max ≈ 15.3 × HRmax ÷ HRrest (Uth 2004) vs FRIEND decade medians × 0.25, only with a measured max HR; '
      + 'activity vs the WHO 150 min/week × 0.10; sleep outside 7–9 h × 0.10. '
      + `Norms are the male/female mean because sex is not known here. Whole years, capped at ±${FITNESS_MAX_DELTA_YEARS}; needs HRV, resting HR and one more driver.`,
    limitation: 'An experimental estimate, not WHOOP Age, biological age, a medical diagnosis, or a prediction of lifespan. Uth’s VO2max estimate alone carries about five years of error, which is why it is capped and needs a measured max.',
  };
}

function interpolateNorm(age, ages, table) {
  const logs = table.map(Math.log);
  const a = clamp(age, ages[0], ages[ages.length - 1]);
  let i = ages.findIndex((x, k) => k < ages.length - 1 && a >= x && a <= ages[k + 1]);
  if (i === -1) i = ages.length - 2;
  const t = (a - ages[i]) / (ages[i + 1] - ages[i]);
  return Math.exp(logs[i] + (logs[i + 1] - logs[i]) * t);
}

/** `prefetched.resting` may carry restingDaily rows for a SUPERSET window (the
 * You screen evaluates twelve windows and fetches once). */
async function fitnessAgeOutlook(dayStart, offsetMs, profile, goalHours = 8, prefetched = {}) {
  const recentTo = dayStart;
  const recentFrom = recentTo - FITNESS_WINDOW_DAYS * DAY_MS;
  const restingRows = prefetched.resting
    ? Promise.resolve(prefetched.resting.filter((r) => r.t >= recentFrom && r.t < recentTo))
    : restingDaily(recentFrom, recentTo, offsetMs);
  const [sleepMs, activeZoneMinutes, recentRhr, recentHrv] = await Promise.all([
    dailyValues('sleep', null, recentFrom, recentTo, 'sum', offsetMs),
    dailyValues('active-zone-minutes', null, recentFrom, recentTo, 'sum', offsetMs),
    restingRows.then((rows) => rows.map((r) => r.v)),
    dailyValues('daily-heart-rate-variability', 'heart-rate-variability', recentFrom, recentTo, 'avg', offsetMs),
  ]);

  const result = buildFitnessAge(profile.age, {
    sleep: { averageHours: mean(sleepMs.map((value) => value / 3600000)), days: sleepMs.length },
    training: {
      weeklyMinutes: activeZoneMinutes.length ? mean(activeZoneMinutes) * 7 : null,
      days: activeZoneMinutes.length,
    },
    restingHeartRate: { recentMedian: median(recentRhr), recentDays: recentRhr.length },
    hrv: { recentMedian: median(recentHrv), recentDays: recentHrv.length },
    maxHeartRate: { value: profile.maxHeartRate, source: profile.maxHeartRateSource },
  }, { sleepGoalHours: goalHours });
  result.coverage.completeThrough = new Date(recentTo - DAY_MS + offsetMs).toISOString().slice(0, 10);
  return result;
}

module.exports = {
  detectActivities, detectedActivities, dailyValues, restingDaily,
  buildRecoveryOutlook, recoveryOutlook,
  buildFitnessAge, fitnessAgeOutlook,
  fitnessNorms: { hrvAt: (age) => interpolateNorm(age, NORM_AGES_HRV, NORM_HRV), restingHr: NORM_RHR },
};
