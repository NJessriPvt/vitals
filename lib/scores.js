'use strict';
/**
 * Morning scores — readiness, strain targets, the energy battery, the stress
 * timeline, PAI-style weekly intensity, resilience, and the symptom radar.
 *
 * Everything is a transparent comparison against the person's OWN recent history
 * (28-day medians and bands), because that is the honest version of what the
 * wearable industry ships: absolute thresholds vary by person and device, and a
 * black-box 0-100 would be indistinguishable from fiction. Every builder here is
 * pure — screens.js fetches the inputs once per request and feeds them in — and
 * every payload carries `derived`, its method, and its limitation.
 *
 * The one rule that must survive any edit: an unavailable input LOWERS COVERAGE,
 * never the score. Missing HRV is "we don't know", not "recovery is worse".
 */

const stats = require('./stats');

const { clamp, round } = stats;

/**
 * Readiness weights — Cadence's published table, itself the WHOOP-shaped split:
 * HRV carries the most, resting HR and sleep a quarter each, and the slow vitals
 * (breathing, skin temperature) share a small pool. Yesterday's strain is a
 * vitals addition to that pool: it can only subtract, and only when the day was
 * unusually hard for this person.
 */
const WEIGHTS = { hrv: 0.40, 'resting-heart-rate': 0.25, sleep: 0.25 };
const MINOR_POOL = 0.10;
const MINOR_IDS = ['respiratory-rate', 'temperature', 'yesterday-strain'];
/** Per-metric floors on the personal standard deviation, so a very steady reader is
 * not scored on a hair's width: HRV on the ln scale, others in their own unit. */
const SD_FLOORS = { hrv: 0.08, rhr: 1.5, resp: 0.5, temp: 0.15, strain: 2 };
const Z_CLAMP = 3;
const SCORE_PER_Z = 20;
const READINESS_MID = 50;
const MIN_BASELINE = 5;

/** One contributor: its z (already signed so that positive is good), weight and the words. */
function contributor(id, label, unit, current, reference, referenceLabel, z, detail) {
  const available = z !== null;
  const decimals = unit === 'h' ? 2 : unit === '°C' ? 2 : unit === 'strain' ? 1 : 0;
  return {
    id,
    label,
    unit,
    current: round(current, decimals),
    reference: round(reference, decimals),
    referenceLabel,
    z: available ? round(clamp(z, -Z_CLAMP, Z_CLAMP), 2) : null,
    points: null, // filled once the weights are known
    status: !available ? 'unavailable' : z > 0.5 ? 'positive' : z < -0.5 ? 'negative' : 'neutral',
    detail,
  };
}

const signed = (v, d = 0) => `${v > 0 ? '+' : ''}${round(v, d)}`;

/**
 * Readiness 0–100.
 *
 * Every input is z-scored against the person's own recent history (28 days,
 * personal SD with a floor), clamped at ±3, and combined as a weighted mean over
 * the inputs that ARE available: score = 50 + 20 × Σ w·z / Σ w. Dividing by Σw is
 * what makes "an unavailable input lowers coverage, never the score" literally
 * true — a neutral signal dropping out leaves the number where it was — and
 * z-scoring is what makes a point mean the same thing to a jittery reader and a
 * steady one. Bands at 67/33 (WHOOP's published cut points, also Cadence's).
 *
 * Calibrated by test: over thousands of stationary days the score must read
 * mean ≈ 50, SD ≈ 12, roughly a tenth of mornings high and a tenth low, and a
 * genuinely bad night must cost twenty points. The additive base-62 model this
 * replaced had no such test and was structurally pessimistic (four of its seven
 * terms could only subtract).
 */
function buildReadiness(input) {
  const c = [];
  const hist = (o) => (o && Array.isArray(o.history) ? o.history : []);
  const count = (o) => stats.finite(hist(o)).length;

  const hrv = input.hrv || {};
  const hrvBase = stats.median(hist(hrv));
  const hrvZ = hrv.current > 0
    ? stats.zScore(hrv.current, hist(hrv).filter((v) => v > 0), { floor: SD_FLOORS.hrv, minPoints: MIN_BASELINE, transform: Math.log })
    : null;
  c.push(contributor('hrv', 'HRV', 'ms', hrv.current, hrvBase, '28-day median', hrvZ,
    hrvZ !== null
      ? `${signed(((hrv.current - hrvBase) / hrvBase) * 100)}% vs your median (${signed(hrvZ, 1)} σ)`
      : `needs ${MIN_BASELINE} baseline days`));

  const rhr = input.restingHeartRate || {};
  const rhrBase = stats.median(hist(rhr));
  const rhrZraw = stats.zScore(rhr.current, hist(rhr), { floor: SD_FLOORS.rhr, minPoints: MIN_BASELINE });
  const rhrZ = rhrZraw === null ? null : -rhrZraw;
  c.push(contributor('resting-heart-rate', 'Resting HR', 'bpm', rhr.current, rhrBase, '28-day median', rhrZ,
    rhrZ !== null
      ? `${signed(rhr.current - rhrBase)} bpm vs your median (${signed(rhrZ, 1)} σ)`
      : `needs ${MIN_BASELINE} baseline days`));

  // Sleep performance = hours ÷ need, on a fixed scale (85 % is the neutral point,
  // ten points per σ) — the need already carries the person's debt and strain.
  const sleep = input.sleep || {};
  const sleepOk = Number.isFinite(sleep.hours) && Number.isFinite(sleep.needHours) && sleep.needHours > 0;
  const perf = sleepOk ? Math.min(100, (sleep.hours / sleep.needHours) * 100) : null;
  const sleepZ = sleepOk ? clamp((perf - 85) / 10, -2, 2) : null;
  c.push(contributor('sleep', 'Sleep vs need', 'h', sleep.hours, sleep.needHours, 'last night’s need', sleepZ,
    sleepOk ? `${Math.round((sleep.hours / sleep.needHours) * 100)}% of the ${round(sleep.needHours, 1)} h you needed` : 'no measured night'));

  const resp = input.respiratoryRate || {};
  const respBase = stats.median(hist(resp));
  const respZraw = stats.zScore(resp.current, hist(resp), { floor: SD_FLOORS.resp, minPoints: MIN_BASELINE });
  const respZ = respZraw === null ? null : -respZraw;
  c.push(contributor('respiratory-rate', 'Breathing', 'br/min', resp.current, respBase, '28-day median', respZ,
    respZ !== null ? `${signed(resp.current - respBase, 1)} br/min vs your median` : 'not measured'));

  // Skin temperature: the device already reports a deviation from ITS baseline; the
  // z is that deviation against the person's own spread of deviations, and it costs
  // in both directions (a cold night is as odd as a warm one).
  const temp = input.temperature || {};
  const tempZraw = stats.zScore(temp.deviation, hist(temp), { floor: SD_FLOORS.temp, minPoints: MIN_BASELINE });
  const tempZ = tempZraw === null ? null : -Math.abs(tempZraw);
  c.push(contributor('temperature', 'Skin temp', '°C', temp.deviation, stats.median(hist(temp)), 'your usual deviation', tempZ,
    tempZ !== null ? `${signed(temp.deviation, 2)} °C overnight deviation` : 'not measured'));

  // Yesterday's strain: harder than usual for THIS person subtracts; an easy day
  // does not add — rest is the absence of a cost, not a credit.
  const strain = input.yesterdayStrain || {};
  const strainZraw = stats.zScore(strain.value, hist(strain), { floor: SD_FLOORS.strain, minPoints: MIN_BASELINE });
  const strainZ = strainZraw === null ? null : -Math.max(0, strainZraw);
  c.push(contributor('yesterday-strain', 'Yesterday', 'strain', strain.value, stats.median(hist(strain)), 'typical day', strainZ,
    strainZ !== null ? `strain ${round(strain.value, 1)} vs typical ${round(stats.median(hist(strain)), 1)}` : 'no strain history'));

  // Weights: the fixed three, then the minor pool shared equally by whichever of
  // its members are measured. Σw over available inputs is the divisor.
  const available = c.filter((x) => x.status !== 'unavailable');
  const minorAvailable = available.filter((x) => MINOR_IDS.includes(x.id)).length;
  const weightOf = (x) => (WEIGHTS[x.id] !== undefined ? WEIGHTS[x.id]
    : minorAvailable ? MINOR_POOL / minorAvailable : 0);
  const sumW = available.reduce((a, x) => a + weightOf(x), 0);
  for (const x of available) {
    x.weight = round(weightOf(x), 3);
    x.points = round((SCORE_PER_Z * weightOf(x) * x.z) / (sumW || 1), 1);
  }

  const core = ['hrv', 'resting-heart-rate', 'sleep'];
  const coreAvailable = available.filter((x) => core.includes(x.id)).length;

  let score = null;
  let band = 'calibrating';
  if (coreAvailable >= 2 && sumW > 0) {
    const composite = available.reduce((a, x) => a + weightOf(x) * x.z, 0) / sumW;
    score = Math.round(clamp(READINESS_MID + SCORE_PER_Z * composite, 0, 100));
    band = score >= 67 ? 'high' : score <= 33 ? 'low' : 'moderate';
  }

  const labels = {
    calibrating: 'Building your baseline',
    high: 'Ready for a hard day',
    moderate: 'Ready for an ordinary day',
    low: 'Ask less of today',
  };
  return {
    score,
    band,
    label: labels[band],
    contributors: c,
    availableContributors: available.length,
    coverage: round(sumW / (Object.values(WEIGHTS).reduce((a, b) => a + b, 0) + MINOR_POOL), 2),
    derived: true,
    method: 'Each input is a z-score against your own 28-day history (personal SD, floored so a steady reader is not over-read), clamped at ±3, and combined as a weighted mean over the inputs that are measured: '
      + 'HRV 40%, resting HR 25%, sleep vs need 25%, breathing / skin temperature / yesterday’s strain sharing 10%. '
      + `Score = ${READINESS_MID} + ${SCORE_PER_Z} × that mean; high at 67, low at 33. Needs two of HRV / resting HR / sleep to produce a number.`,
    limitation: 'A transparent comparison with your own history — not WHOOP Recovery, not Oura Readiness, not medical advice. A missing input lowers coverage, never the score.',
  };
}

/** Strain target band for the day, from this morning's readiness. */
function strainTarget(readinessScore) {
  if (!Number.isFinite(readinessScore)) return null;
  if (readinessScore >= 67) return { lo: 11, hi: 16, note: 'green light for a hard session' };
  if (readinessScore > 33) return { lo: 7, hi: 12, note: 'a normal training day' };
  return { lo: 0, hi: 8, note: 'movement, not training' };
}

// ---------------------------------------------------------------------------
// Stress timeline
// ---------------------------------------------------------------------------

/**
 * Classify each hour of the day from average heart rate against resting level,
 * with detected/recorded sessions cut out as 'active' (exertion is not stress) and
 * nap windows marked 'restorative'. Hours without samples stay null — an off-wrist
 * afternoon is unknown, not calm.
 */
function buildStressTimeline({
  hours, restingHr, zone3Bpm, sessionRanges = [], napRanges = [],
}) {
  const HOUR_MS = 3600000;
  const overlaps = (t, ranges) => ranges.some((r) => t < r.end && t + HOUR_MS > r.start);
  const ok = Number.isFinite(restingHr) && Number.isFinite(zone3Bpm);

  const points = hours.map((h) => {
    let state = null;
    if (overlaps(h.t, napRanges)) state = 'restorative';
    else if (overlaps(h.t, sessionRanges)) state = 'active';
    else if (h.avgHr === null || !ok) state = null;
    else if (h.avgHr >= zone3Bpm) state = 'high';
    else if (h.avgHr >= restingHr + 12) state = 'elevated';
    else state = 'calm';
    return { t: h.t, state, avgHr: h.avgHr === null ? null : Math.round(h.avgHr) };
  });

  const classified = points.filter((p) => p.state && p.state !== 'active' && p.state !== 'restorative');
  const share = (s) => (classified.length
    ? round(classified.filter((p) => p.state === s).length / classified.length, 2) : null);

  return {
    points,
    shares: { calm: share('calm'), elevated: share('elevated'), high: share('high') },
    trackedHours: points.filter((p) => p.state !== null).length,
    derived: true,
    method: 'Hourly average HR vs resting level: calm under resting+12, high at or over 60% of max HR; sessions are cut out as activity, naps as restorative. No samples = unknown, never calm.',
    limitation: 'Heart-rate only — without movement data, an animated phone call and a brisk walk can read the same.',
  };
}

// ---------------------------------------------------------------------------
// Energy battery
// ---------------------------------------------------------------------------

/**
 * A day-scoped energy model: last night charges it, load and stressed hours drain
 * it, naps and calm idle hours trickle it back. States its own assumptions instead
 * of imitating Firstbeat: daytime HRV is sparse in this data, so daytime drain is
 * HR-and-load-modelled.
 */
function buildBattery({
  wakeMs, sleepRatio, efficiencyPercent, stress, hourLoads, napRanges = [], nowMs, dayStart,
}) {
  const HOUR_MS = 3600000;
  const hasSleep = Number.isFinite(sleepRatio);
  const wakeLevel = hasSleep
    ? clamp(35 + 50 * Math.min(1.2, sleepRatio) + (efficiencyPercent >= 90 ? 5 : 0), 20, 100)
    : 55;

  const loadByHour = new Map(hourLoads.map((h) => [h.t, h.load || 0]));
  const stateByHour = new Map(stress.points.map((p) => [p.t, p.state]));
  const inNap = (t) => napRanges.some((r) => t < r.end && t + HOUR_MS > r.start);

  const points = [];
  let level = hasSleep ? clamp(wakeLevel - 12, 5, 100) : 55; // midnight: still asleep, near charged
  const end = Math.min(dayStart + 24 * HOUR_MS, nowMs + HOUR_MS);
  for (let t = dayStart; t < end; t += HOUR_MS) {
    const asleep = Number.isFinite(wakeMs) && t + HOUR_MS <= wakeMs;
    if (asleep) {
      // Charge through the night toward the wake level.
      level = Math.min(wakeLevel, level + (wakeLevel - level) * 0.35 + 1);
    } else {
      const load = loadByHour.get(t) || 0;
      const state = stateByHour.get(t);
      const drain = load * 0.3
        + (state === 'high' ? 3 : state === 'elevated' ? 1.5 : state === 'calm' ? 0.8 : 0.5);
      const charge = inNap(t) ? 8 : state === 'calm' && load === 0 ? 1.2 : 0;
      level = clamp(level - drain + charge, 5, 100);
    }
    // `known` must be false for hours with no observation at all — get() returns
    // undefined for the trailing not-yet-classified hour, and `undefined !== null`
    // would claim the simulated hour was measured.
    points.push({
      t,
      v: Math.round(level),
      known: asleep || (stateByHour.get(t) ?? null) !== null || loadByHour.has(t),
    });
  }

  return {
    points,
    current: points.length ? points[points.length - 1].v : null,
    wakeLevel: Math.round(wakeLevel),
    derived: true,
    method: 'Wake level = 35 + 50×(sleep ÷ need, capped 1.2) + 5 for 90%+ efficiency. Each hour drains 0.3×TRIMP plus a stress-state cost (0.5–3), naps recharge 8, calm idle hours 1.2. Bounded 5–100.',
    limitation: 'An energy model, not a measurement — daytime HRV is too sparse here to do it Firstbeat’s way, and the payload says so.',
  };
}

// ---------------------------------------------------------------------------
// Weekly intensity (PAI-style) and resilience
// ---------------------------------------------------------------------------

/**
 * Rolling seven days of intensity as one number with one target: 100. Points are
 * capped per day so one heroic Sunday cannot buy a sedentary week — the property
 * that gives PAI its epidemiological backing.
 */
function buildWeeklyIntensity(dailyLoads) {
  const days = dailyLoads.slice(-7);
  const points = days.map((d) => ({
    t: d.t,
    points: d.load === null ? null : round(Math.min(35, d.load * 0.25), 1),
  }));
  const measured = points.filter((p) => p.points !== null);
  const total = measured.length ? Math.round(measured.reduce((a, p) => a + p.points, 0)) : null;
  return {
    total,
    target: 100,
    days: points,
    measuredDays: measured.length,
    derived: true,
    method: 'Daily points = 0.25×TRIMP capped at 35; the score is the 7-day sum against a fixed target of 100. PAI-inspired; not Amazfit’s algorithm.',
  };
}

const RESILIENCE_LEVELS = ['Limited', 'Adequate', 'Solid', 'Strong', 'Exceptional'];

/**
 * A deliberately slow 14-day trait: how the balance of stress, sleep and HRV trend
 * has been running. Changes by whole levels, so it reads as a state, not a mood.
 */
function buildResilience({
  stressShareAvg, sleepRatioAvg, hrvTrendPercent, coveredDays,
}) {
  if (!Number.isFinite(coveredDays) || coveredDays < 10) {
    return {
      level: null,
      levels: RESILIENCE_LEVELS,
      coveredDays: coveredDays || 0,
      requiredDays: 10,
      derived: true,
      method: 'Needs 10 covered days in the last 14.',
    };
  }
  let idx = 2;
  if (Number.isFinite(hrvTrendPercent) && hrvTrendPercent >= 3
    && Number.isFinite(sleepRatioAvg) && sleepRatioAvg >= 0.95) idx += 1;
  if (Number.isFinite(stressShareAvg) && stressShareAvg < 0.08) idx += 1;
  if (Number.isFinite(stressShareAvg) && stressShareAvg > 0.2) idx -= 1;
  if (Number.isFinite(sleepRatioAvg) && sleepRatioAvg < 0.8) idx -= 1;
  if (Number.isFinite(hrvTrendPercent) && hrvTrendPercent <= -5) idx -= 1;
  idx = clamp(idx, 0, 4);
  return {
    level: RESILIENCE_LEVELS[idx],
    levelIndex: idx,
    levels: RESILIENCE_LEVELS,
    inputs: {
      stressShareAvg: round(stressShareAvg, 2),
      sleepRatioAvg: round(sleepRatioAvg, 2),
      hrvTrendPercent: round(hrvTrendPercent, 1),
    },
    coveredDays,
    derived: true,
    method: 'Starts at Solid over the last 14 days; rises with an HRV uptrend plus well-met sleep need and very low stress share; falls with a high stress share, short sleep, or an HRV downtrend.',
    limitation: 'A slow trait estimate, not Oura Resilience.',
  };
}

// ---------------------------------------------------------------------------
// Symptom radar
// ---------------------------------------------------------------------------

/** Per-signal deviation that counts as adverse under the JOINT rule. Lower than a
 * single-detector threshold on purpose: the gate is two signals moving together,
 * so each one can be read at 1.8 σ (about 4 % of nights one-sided by chance;
 * measured by test, the joint card fires on under 3 % of ordinary nights) where
 * a lone chip would need 2.25. */
const RADAR_Z = 1.8;
const RADAR_MIN_HISTORY = 7;

/**
 * Joint overnight deviation across the slow vitals. One signal out of band is a
 * shrug; two or more moving together in the "wrong" direction is worth a card —
 * Apple's published two-signal rule. Each signal is measured as a z-score against
 * the person's own flat 28-day mean and SD (floored), NOT an exponentially
 * weighted one: a moving baseline chases a fever and goes quiet on day four.
 * The old p10–p90 band flagged a tenth of ordinary nights per signal by
 * construction. Wording is deliberately "signs of strain"; this must never claim
 * illness.
 */
function buildSymptomRadar(signals) {
  const evaluated = signals.map((s) => {
    const history = stats.finite(s.history || []);
    const z = stats.zScore(s.current, history, { floor: s.floor ?? 1, minPoints: RADAR_MIN_HISTORY });
    const hasBand = z !== null;
    let flagged = false;
    if (hasBand) {
      if (s.direction === 'high-bad') flagged = z >= RADAR_Z;
      else if (s.direction === 'low-bad') flagged = z <= -RADAR_Z;
      else flagged = Math.abs(z) >= RADAR_Z;
    }
    const m = stats.mean(history);
    const spread = hasBand ? Math.max(stats.stdev(history) ?? 0, s.floor ?? 1) : null;
    const p = s.precision ?? 1;
    return {
      id: s.id,
      label: s.label,
      unit: s.unit,
      current: round(s.current, p),
      z: hasBand ? round(z, 2) : null,
      band: hasBand ? { lo: round(m - RADAR_Z * spread, p), hi: round(m + RADAR_Z * spread, p), median: round(stats.median(history), p) } : null,
      direction: s.direction,
      flagged,
      available: hasBand,
    };
  });

  const available = evaluated.filter((s) => s.available);
  const flagged = available.filter((s) => s.flagged);
  const level = available.length < 3 ? 'unavailable'
    : flagged.length >= 3 ? 'major'
      : flagged.length === 2 ? 'minor' : 'none';

  return {
    level,
    flaggedCount: flagged.length,
    availableCount: available.length,
    signals: evaluated,
    derived: true,
    method: `Each overnight vital as a z-score against your own 28-day mean and spread; a signal counts when it moves ${RADAR_Z} σ the wrong way. Two adverse signals together read as minor signs of strain, three or more as major. Needs three measurable vitals with a week of history.`,
    limitation: 'Signs of physiological strain, never a diagnosis. Illness, alcohol, heat and late meals all move these numbers.',
  };
}

// ---------------------------------------------------------------------------
// Energy forecast — the day ahead, not another rear-view score
// ---------------------------------------------------------------------------

/**
 * A predicted alertness curve for today from the classic two-process sketch:
 * a circadian wave anchored on this morning's wake time, homeostatic pressure
 * that builds with hours awake, and sleep debt deepening the afternoon dip.
 *
 * This is the Rise/SleepWise idea implemented as an openly simple model — the
 * point is planning ("put the hard work in the peak, walk in the dip"), and the
 * payload says exactly what it is. Values are unitless 0–100 alertness, not a
 * measurement of anything.
 */
function buildEnergyForecast({ wakeMs, needHours, debtHours, dayStart, nowMs }) {
  const HOUR_MS = 3600000;
  if (!Number.isFinite(wakeMs) || wakeMs <= dayStart || wakeMs >= dayStart + 20 * HOUR_MS) {
    return { available: false, reason: 'no measured wake time for this morning', derived: true };
  }
  const debt = Number.isFinite(debtHours) ? debtHours : 0;
  const need = Number.isFinite(needHours) ? needHours : 8;
  const bedTarget = wakeMs + (24 - need) * HOUR_MS;

  const at = (ms) => {
    const a = (ms - wakeMs) / HOUR_MS; // hours since wake
    if (a < 0) return 20; // still asleep / pre-wake
    const wave = 38 * Math.sin((Math.PI * Math.min(a, 16)) / 16);
    const grog = a < 1 ? -25 * (1 - a) : 0;
    const dip = -18 * Math.exp(-((a - 7) ** 2) / 4) * (1 + debt / 10);
    const pressure = -2.2 * a * (1 + debt / 25);
    return clamp(55 + wave + grog + dip + pressure, 5, 100);
  };

  const points = [];
  for (let t = dayStart; t < dayStart + 24 * HOUR_MS; t += 30 * 60000) {
    points.push({ t, v: Math.round(at(t)) });
  }

  // Named windows, computed from the same curve so the labels cannot disagree
  // with the line they sit on.
  const waking = points.filter((p) => p.t >= wakeMs && p.t < bedTarget);
  let peak = null;
  let dip = null;
  for (const p of waking) {
    if (!peak || p.v > peak.v) peak = p;
    const a = (p.t - wakeMs) / HOUR_MS;
    if (a >= 4 && a <= 11 && (!dip || p.v < dip.v)) dip = p;
  }
  return {
    available: true,
    points,
    zones: {
      grogginess: { from: wakeMs, to: wakeMs + HOUR_MS },
      peak: peak ? { at: peak.t, v: peak.v } : null,
      dip: dip ? { at: dip.t, v: dip.v } : null,
      windDown: { from: bedTarget - 90 * 60000, to: bedTarget },
      bedTarget,
    },
    nowMs,
    derived: true,
    method: 'Two-process sketch anchored on this morning’s measured wake time: a 16-hour circadian wave, linear waking pressure, and an afternoon dip that deepens with sleep debt. Bed target = wake + (24 − sleep need).',
    limitation: 'A planning curve, not a measurement — Rise-style, from sleep timing alone; no light or chronotype input.',
  };
}

module.exports = {
  buildReadiness, strainTarget, buildStressTimeline, buildBattery,
  buildWeeklyIntensity, buildResilience, buildSymptomRadar, buildEnergyForecast,
};
