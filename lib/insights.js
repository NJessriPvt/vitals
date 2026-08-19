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

const MINUTE_MS = 60000;
const DAY_MS = 86400000;
const BASELINE_DAYS = 28;
const MIN_BASELINE_POINTS = 5;
const FITNESS_WINDOW_DAYS = 28;
const FITNESS_MIN_CURRENT_DAYS = 18;
const FITNESS_MIN_TREND_DAYS = 14;
const FITNESS_MIN_SIGNALS = 3;
const FITNESS_MAX_DELTA_YEARS = 10;

const round = (v, p = 1) => (v === null || v === undefined || !Number.isFinite(v)
  ? null : Number(v.toFixed(p)));

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const mean = (values) => {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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

async function dailyValues(primaryType, fallbackType, fromMs, toMs, agg, offsetMs) {
  const [primary, fallback] = await Promise.all([
    db.series(primaryType, fromMs, toMs, DAY_MS, agg, offsetMs),
    fallbackType ? db.series(fallbackType, fromMs, toMs, DAY_MS, agg, offsetMs) : [],
  ]);
  const byDay = new Map(fallback.map((row) => [row.t, row.v]));
  for (const row of primary) byDay.set(row.t, row.v);
  return [...byDay.values()].filter((value) => value !== null && Number.isFinite(value));
}

async function recoveryOutlook(dayStart, offsetMs, current, goalHours = 8) {
  const baselineFrom = dayStart - BASELINE_DAYS * DAY_MS;
  const dayEnd = dayStart + DAY_MS;
  const [currentHrvDaily, currentHrvSamples, hrv, restingHeartRate, sleepMs] = await Promise.all([
    db.aggregate('daily-heart-rate-variability', dayStart, dayEnd, 'avg'),
    db.aggregate('heart-rate-variability', dayStart, dayEnd, 'avg'),
    dailyValues('daily-heart-rate-variability', 'heart-rate-variability',
      baselineFrom, dayStart, 'avg', offsetMs),
    dailyValues('daily-resting-heart-rate', 'heart-rate',
      baselineFrom, dayStart, 'min', offsetMs),
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
 * Turn well-covered recent signals into a conservative whole-year fitness-age estimate.
 *
 * This is deliberately not a mortality model or a reconstruction of WHOOP Age. Each
 * factor is small, capped and inspectable. Sleep and active-zone minutes use explicit
 * dashboard references; resting HR and HRV use the person's own prior 28 days because
 * their absolute levels vary substantially across people and devices.
 */
function buildFitnessAge(actualAge, input, {
  sleepGoalHours = 8,
  trainingReferenceMinutes = 150,
} = {}) {
  const validAge = Number.isFinite(actualAge) && actualAge >= 18 && actualAge <= 90;
  const factors = [];

  const addFactor = ({
    id, label, available, contributionYears = null, value = null, unit = '',
    reference = null, referenceLabel = '', coverage, detail,
  }) => {
    // A decimal of "age" would imply calibration this heuristic does not have.
    // Keep both the factors and the final estimate at whole-year resolution.
    const impact = available
      ? Math.sign(contributionYears) * Math.round(Math.abs(contributionYears)) : null;
    factors.push({
      id, label, available, contributionYears: impact,
      status: !available ? 'unavailable' : impact < 0 ? 'favorable' : impact > 0 ? 'unfavorable' : 'neutral',
      value: round(value, unit === 'h' ? 2 : 0), unit,
      reference: round(reference, unit === 'h' ? 2 : 0), referenceLabel,
      coverage, detail,
    });
  };

  const sleep = input.sleep || {};
  const sleepAvailable = Number.isFinite(sleep.averageHours) && sleep.days >= FITNESS_MIN_CURRENT_DAYS;
  addFactor({
    id: 'sleep', label: 'Sleep duration', available: sleepAvailable,
    contributionYears: sleepAvailable ? clamp((sleepGoalHours - sleep.averageHours) * 1.5, -2.5, 3) : null,
    value: sleepAvailable ? sleep.averageHours : null, unit: 'h',
    reference: sleepGoalHours, referenceLabel: 'nightly goal',
    coverage: { recentDays: sleep.days || 0, requiredDays: FITNESS_MIN_CURRENT_DAYS },
    detail: sleepAvailable
      ? `${round(sleep.averageHours, 1)} h average across ${sleep.days} nights`
      : `Need ${FITNESS_MIN_CURRENT_DAYS} measured nights; have ${sleep.days || 0}`,
  });

  const training = input.training || {};
  const trainingAvailable = Number.isFinite(training.weeklyMinutes)
    && training.days >= FITNESS_MIN_CURRENT_DAYS;
  addFactor({
    id: 'training', label: 'Training volume', available: trainingAvailable,
    contributionYears: trainingAvailable
      ? clamp((trainingReferenceMinutes - training.weeklyMinutes) / 50, -3, 3) : null,
    value: trainingAvailable ? training.weeklyMinutes : null, unit: 'min/wk',
    reference: trainingReferenceMinutes, referenceLabel: 'weekly reference',
    coverage: { recentDays: training.days || 0, requiredDays: FITNESS_MIN_CURRENT_DAYS },
    detail: trainingAvailable
      ? `${round(training.weeklyMinutes, 0)} active-zone min/week across ${training.days} recorded days`
      : `Need ${FITNESS_MIN_CURRENT_DAYS} active-zone days; have ${training.days || 0}`,
  });

  const rhr = input.restingHeartRate || {};
  const rhrAvailable = Number.isFinite(rhr.recentMedian) && Number.isFinite(rhr.priorMedian)
    && rhr.recentDays >= FITNESS_MIN_TREND_DAYS && rhr.priorDays >= FITNESS_MIN_TREND_DAYS;
  const rhrChange = rhrAvailable ? rhr.recentMedian - rhr.priorMedian : null;
  addFactor({
    id: 'resting-heart-rate', label: 'Resting HR trend', available: rhrAvailable,
    contributionYears: rhrAvailable ? clamp(rhrChange / 2, -2.5, 2.5) : null,
    value: rhrAvailable ? rhr.recentMedian : null, unit: 'bpm',
    reference: rhrAvailable ? rhr.priorMedian : null, referenceLabel: 'prior median',
    coverage: {
      recentDays: rhr.recentDays || 0, priorDays: rhr.priorDays || 0,
      requiredDays: FITNESS_MIN_TREND_DAYS,
    },
    detail: rhrAvailable
      ? `${round(rhrChange, 0) > 0 ? '+' : ''}${round(rhrChange, 0)} bpm versus the prior 28-day median`
      : `Need ${FITNESS_MIN_TREND_DAYS} recent and prior days; have ${rhr.recentDays || 0}/${rhr.priorDays || 0}`,
  });

  const hrv = input.hrv || {};
  const hrvAvailable = Number.isFinite(hrv.recentMedian) && hrv.recentMedian > 0
    && Number.isFinite(hrv.priorMedian) && hrv.priorMedian > 0
    && hrv.recentDays >= FITNESS_MIN_TREND_DAYS && hrv.priorDays >= FITNESS_MIN_TREND_DAYS;
  const hrvChangePercent = hrvAvailable
    ? ((hrv.recentMedian - hrv.priorMedian) / hrv.priorMedian) * 100 : null;
  addFactor({
    id: 'hrv', label: 'HRV trend', available: hrvAvailable,
    contributionYears: hrvAvailable ? clamp(-hrvChangePercent / 5, -2.5, 2.5) : null,
    value: hrvAvailable ? hrv.recentMedian : null, unit: 'ms',
    reference: hrvAvailable ? hrv.priorMedian : null, referenceLabel: 'prior median',
    coverage: {
      recentDays: hrv.recentDays || 0, priorDays: hrv.priorDays || 0,
      requiredDays: FITNESS_MIN_TREND_DAYS,
    },
    detail: hrvAvailable
      ? `${round(hrvChangePercent, 0) > 0 ? '+' : ''}${round(hrvChangePercent, 0)}% versus the prior 28-day median`
      : `Need ${FITNESS_MIN_TREND_DAYS} recent and prior days; have ${hrv.recentDays || 0}/${hrv.priorDays || 0}`,
  });

  const available = factors.filter((factor) => factor.available);
  const coverageRatios = available.map((factor) => {
    const c = factor.coverage;
    const recent = Math.min(1, c.recentDays / FITNESS_WINDOW_DAYS);
    const prior = c.priorDays === undefined ? 1 : Math.min(1, c.priorDays / FITNESS_WINDOW_DAYS);
    return Math.min(recent, prior);
  });
  const coverageScore = mean(coverageRatios);
  const enough = validAge && available.length >= FITNESS_MIN_SIGNALS;
  const confidence = !enough ? 'insufficient'
    : available.length === factors.length && coverageRatios.every((ratio) => ratio >= 0.75)
      ? 'high' : 'moderate';

  let estimate = null;
  let deltaYears = null;
  if (enough) {
    const rawDelta = available.reduce((sum, factor) => sum + factor.contributionYears, 0);
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
      priorBaselineDays: FITNESS_WINDOW_DAYS,
      availableSignals: available.length,
      requiredSignals: FITNESS_MIN_SIGNALS,
      score: round(coverageScore, 2),
      confidence,
    },
    derived: true,
    method: 'Whole-year estimate from four bounded factors: sleep contributes 1.5 years per hour from goal; training contributes 1 year per 50 active-zone min/week from 150; resting HR contributes 1 year per 2 bpm change; HRV contributes the inverse of 1 year per 5% change. RHR and HRV use prior 28-day medians. Factor effects are rounded to whole years and the total is capped at ±10.',
    limitation: 'An experimental fitness trend estimate, not WHOOP Age, biological age, a medical diagnosis, or a prediction of lifespan. Device wear, illness, medication and individual physiology can move these signals.',
  };
}

async function fitnessAgeOutlook(dayStart, offsetMs, profile, goalHours = 8) {
  const recentTo = dayStart;
  const recentFrom = recentTo - FITNESS_WINDOW_DAYS * DAY_MS;
  const priorFrom = recentFrom - FITNESS_WINDOW_DAYS * DAY_MS;
  const [sleepMs, activeZoneMinutes, recentRhr, priorRhr, recentHrv, priorHrv] = await Promise.all([
    dailyValues('sleep', null, recentFrom, recentTo, 'sum', offsetMs),
    dailyValues('active-zone-minutes', null, recentFrom, recentTo, 'sum', offsetMs),
    dailyValues('daily-resting-heart-rate', 'heart-rate', recentFrom, recentTo, 'min', offsetMs),
    dailyValues('daily-resting-heart-rate', 'heart-rate', priorFrom, recentFrom, 'min', offsetMs),
    dailyValues('daily-heart-rate-variability', 'heart-rate-variability', recentFrom, recentTo, 'avg', offsetMs),
    dailyValues('daily-heart-rate-variability', 'heart-rate-variability', priorFrom, recentFrom, 'avg', offsetMs),
  ]);

  const result = buildFitnessAge(profile.age, {
    sleep: { averageHours: mean(sleepMs.map((value) => value / 3600000)), days: sleepMs.length },
    training: {
      weeklyMinutes: activeZoneMinutes.length ? mean(activeZoneMinutes) * 7 : null,
      days: activeZoneMinutes.length,
    },
    restingHeartRate: {
      recentMedian: median(recentRhr), priorMedian: median(priorRhr),
      recentDays: recentRhr.length, priorDays: priorRhr.length,
    },
    hrv: {
      recentMedian: median(recentHrv), priorMedian: median(priorHrv),
      recentDays: recentHrv.length, priorDays: priorHrv.length,
    },
  }, { sleepGoalHours: goalHours });
  result.coverage.completeThrough = new Date(recentTo - DAY_MS + offsetMs).toISOString().slice(0, 10);
  return result;
}

module.exports = {
  MINUTE_MS, DAY_MS, BASELINE_DAYS, MIN_BASELINE_POINTS,
  median, zoneFor, detectActivities, detectedActivities,
  buildRecoveryOutlook, recoveryOutlook,
  buildFitnessAge, fitnessAgeOutlook,
};
