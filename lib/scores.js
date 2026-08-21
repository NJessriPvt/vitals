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

const READINESS_BASE = 62;

/** Contributor definitions: id, points function, and the caps that bound it. */
function contributor(id, label, unit, current, reference, referenceLabel, points, detail) {
  const available = points !== null;
  return {
    id,
    label,
    unit,
    current: round(current, unit === 'h' ? 2 : unit === '°C' ? 2 : 0),
    reference: round(reference, unit === 'h' ? 2 : unit === '°C' ? 2 : 0),
    referenceLabel,
    points: available ? round(points, 1) : null,
    status: !available ? 'unavailable' : points > 1 ? 'positive' : points < -1 ? 'negative' : 'neutral',
    detail,
  };
}

/**
 * Readiness 0–100.
 *
 * Starts at 62 (a typical day lands in the 60s — most days SHOULD be ordinary) and
 * moves by bounded per-contributor points. The core three are HRV, resting HR and
 * sleep; at least two must be measured or the score refuses to exist.
 */
function buildReadiness(input) {
  const c = [];

  const hrv = input.hrv || {};
  const hrvOk = Number.isFinite(hrv.current) && Number.isFinite(hrv.baseline) && hrv.baseline > 0
    && (hrv.baselineCount || 0) >= 5;
  const hrvDelta = hrvOk ? ((hrv.current - hrv.baseline) / hrv.baseline) * 100 : null;
  c.push(contributor('hrv', 'HRV', 'ms', hrv.current, hrv.baseline, '28-day median',
    hrvOk ? clamp(hrvDelta * 0.8, -20, 15) : null,
    hrvOk ? `${hrvDelta > 0 ? '+' : ''}${Math.round(hrvDelta)}% vs your median` : 'needs 5 baseline days'));

  const rhr = input.restingHeartRate || {};
  const rhrOk = Number.isFinite(rhr.current) && Number.isFinite(rhr.baseline)
    && (rhr.baselineCount || 0) >= 5;
  const rhrDelta = rhrOk ? rhr.current - rhr.baseline : null;
  c.push(contributor('resting-heart-rate', 'Resting HR', 'bpm', rhr.current, rhr.baseline, '28-day median',
    rhrOk ? clamp(-rhrDelta * 2.5, -18, 10) : null,
    rhrOk ? `${rhrDelta > 0 ? '+' : ''}${Math.round(rhrDelta)} bpm vs your median` : 'needs 5 baseline days'));

  const sleep = input.sleep || {};
  const sleepOk = Number.isFinite(sleep.hours) && Number.isFinite(sleep.needHours) && sleep.needHours > 0;
  const ratio = sleepOk ? sleep.hours / sleep.needHours : null;
  c.push(contributor('sleep', 'Sleep vs need', 'h', sleep.hours, sleep.needHours, 'tonight’s need',
    sleepOk ? clamp((ratio - 0.9) * 90, -22, 12) : null,
    sleepOk ? `${Math.round(ratio * 100)}% of the ${round(sleep.needHours, 1)} h your history asks for` : 'no measured night'));

  const debtOk = Number.isFinite(input.debtHours);
  c.push(contributor('sleep-debt', 'Sleep debt', 'h', input.debtHours, 0, 'no debt',
    debtOk ? clamp(-input.debtHours * 1.8, -12, 0) : null,
    debtOk ? `${round(input.debtHours, 1)} h owed over 14 nights` : 'needs a week of nights'));

  const temp = input.temperature || {};
  const tempOk = Number.isFinite(temp.deviation);
  const tempAbs = tempOk ? Math.abs(temp.deviation) : null;
  c.push(contributor('temperature', 'Skin temp', '°C', temp.deviation, 0, 'your baseline',
    tempOk ? (tempAbs > 0.3 ? clamp(-(tempAbs - 0.3) * 25, -15, 0) : 0) : null,
    tempOk ? `${temp.deviation > 0 ? '+' : ''}${round(temp.deviation, 2)} °C overnight deviation` : 'not measured'));

  const resp = input.respiratoryRate || {};
  const respOk = Number.isFinite(resp.current) && Number.isFinite(resp.baseline)
    && (resp.baselineCount || 0) >= 5;
  const respDelta = respOk ? resp.current - resp.baseline : null;
  c.push(contributor('respiratory-rate', 'Breathing', 'br/min', resp.current, resp.baseline, '28-day median',
    respOk ? (respDelta >= 1 ? clamp(-(respDelta - 0.5) * 6, -10, 0) : 0) : null,
    respOk ? `${respDelta > 0 ? '+' : ''}${round(respDelta, 1)} br/min vs your median` : 'not measured'));

  const strain = input.yesterdayStrain || {};
  const strainOk = Number.isFinite(strain.value) && Number.isFinite(strain.typical);
  c.push(contributor('yesterday-strain', 'Yesterday', 'strain', strain.value, strain.typical, 'typical day',
    strainOk ? (strain.value > strain.typical + 4
      ? clamp(-(strain.value - strain.typical - 4) * 1.5, -8, 0) : 0) : null,
    strainOk ? `strain ${round(strain.value, 1)} vs typical ${round(strain.typical, 1)}` : 'no strain history'));

  const core = ['hrv', 'resting-heart-rate', 'sleep'];
  const coreAvailable = c.filter((x) => core.includes(x.id) && x.status !== 'unavailable').length;
  const available = c.filter((x) => x.status !== 'unavailable');

  let score = null;
  let band = 'calibrating';
  if (coreAvailable >= 2) {
    score = Math.round(clamp(
      READINESS_BASE + available.reduce((a, x) => a + x.points, 0), 0, 100,
    ));
    band = score >= 70 ? 'high' : score >= 45 ? 'moderate' : 'low';
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
    derived: true,
    method: `Starts at ${READINESS_BASE} and moves by bounded contributor points against your own 28-day medians `
      + '(HRV ±20/15, resting HR ±18/10, sleep vs need ±22/12, debt to −12, temperature to −15, breathing to −10, yesterday’s strain to −8). '
      + 'Needs two of HRV / resting HR / sleep to produce a number.',
    limitation: 'A transparent training guide against your own history — not WHOOP Recovery, not Oura Readiness, not medical advice.',
  };
}

/** Strain target band for the day, from this morning's readiness. */
function strainTarget(readinessScore) {
  if (!Number.isFinite(readinessScore)) return null;
  if (readinessScore >= 70) return { lo: 11, hi: 16, note: 'green light for a hard session' };
  if (readinessScore >= 45) return { lo: 7, hi: 12, note: 'a normal training day' };
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
    points.push({ t, v: Math.round(level), known: asleep || stateByHour.get(t) !== null || loadByHour.has(t) });
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

/**
 * Joint overnight deviation across the slow vitals. One signal out of band is a
 * shrug; two or more moving together in the "wrong" direction is worth a card —
 * Apple's published two-signal rule. Wording is deliberately "signs of strain";
 * this must never claim illness.
 */
function buildSymptomRadar(signals) {
  const evaluated = signals.map((s) => {
    const hasBand = s.band && Number.isFinite(s.current);
    let flagged = false;
    if (hasBand) {
      if (s.direction === 'high-bad') flagged = s.current > s.band.p90;
      else if (s.direction === 'low-bad') flagged = s.current < s.band.p10;
      else flagged = s.current > s.band.p90 || s.current < s.band.p10;
    }
    return {
      id: s.id,
      label: s.label,
      unit: s.unit,
      current: round(s.current, s.precision ?? 1),
      band: s.band ? { p10: round(s.band.p10, s.precision ?? 1), p90: round(s.band.p90, s.precision ?? 1), median: round(s.band.median, s.precision ?? 1) } : null,
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
    method: 'Each overnight vital against your own 28-day p10–p90 band; two adverse signals together read as minor signs of strain, three or more as major. Needs three measurable vitals.',
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
  READINESS_BASE, RESILIENCE_LEVELS,
  buildReadiness, strainTarget, buildStressTimeline, buildBattery,
  buildWeeklyIntensity, buildResilience, buildSymptomRadar, buildEnergyForecast,
};
