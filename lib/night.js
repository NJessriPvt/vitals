'use strict';
/**
 * Sleep intelligence — need, debt, consistency, naps, the monthly pattern.
 *
 * Everything here is DERIVED from the sleep sessions Google already sends; nothing
 * asks the API for more. The two design anchors, in order of how expensive they were
 * to learn:
 *
 *   - A night belongs to the morning you woke up (anchor_ms is wake time), so "the
 *     night of Aug 20" means the sleep that ENDED on Aug 20. Every window in this
 *     file follows that convention.
 *   - A missing night is "not tracked", never "did not sleep". Debt and consistency
 *     therefore work on measured nights only and say how many they had — a week of
 *     off-wrist nights must not read as a 56-hour sleep debt.
 *
 * The need/debt model is the Rise framing (a personal requirement learned from your
 * own history, and a rolling balance against it in hours) rather than a nightly
 * 0-100 grade — per NJ's pick, last night is DESCRIBED, not scored.
 */

const db = require('./db');
const stats = require('./stats');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const { clamp, round } = stats;

/** Bounds for a learned nightly need — outside this range the data is telling us
 * about tracking quality, not about the person's physiology. */
const NEED_MIN_H = 6.5;
const NEED_MAX_H = 9.5;
const NEED_WINDOW_NIGHTS = 28;
const DEBT_WINDOW_NIGHTS = 14;
const DEBT_DECAY = 0.85;
const DEBT_CAP_H = 15;

/** A sleep session at or under this length, starting in the daytime, is a nap. */
const NAP_MAX_MS = 3 * HOUR_MS;
/** Naps repay debt at half rate — fragmented daytime sleep restores less than the
 * same time at night. The credit is visible on the nap row, so the discount is a
 * statement, not a hidden fudge. */
const NAP_CREDIT = 0.5;

// ---------------------------------------------------------------------------
// Need & debt
// ---------------------------------------------------------------------------

/**
 * Pure model so the arithmetic is unit-testable.
 *
 * `nights` is oldest→newest, one entry per MEASURED night (hours asleep, naps
 * already excluded); absent nights are simply not in the list. `yesterdayStrain`
 * nudges tonight's need upward after a hard day, WHOOP-style.
 */
function buildSleepNeed(nights, { yesterdayStrain = null } = {}) {
  // Under four hours is a tracking artefact (a watch taken off mid-night, a split
  // session) far more often than a real night; letting those into the median would
  // teach the model a "need" nobody has.
  const usable = nights.filter((h) => Number.isFinite(h) && h >= 4);
  const baseNeed = usable.length >= 7
    ? clamp(stats.median(usable.slice(-NEED_WINDOW_NIGHTS)), NEED_MIN_H, NEED_MAX_H)
    : null;

  let debt = null;
  if (baseNeed !== null) {
    const recent = usable.slice(-DEBT_WINDOW_NIGHTS);
    let sum = 0;
    recent.forEach((h, i) => {
      const age = recent.length - 1 - i; // 0 = last night
      const weight = DEBT_DECAY ** age;
      const delta = baseNeed - h;
      // A long night repays debt, but only at half value — nine hours on Saturday
      // does not cancel two five-hour weeknights, however much we wish it did.
      sum += (delta > 0 ? delta : delta * 0.5) * weight;
    });
    debt = clamp(sum, 0, DEBT_CAP_H);
  }

  let tonightNeed = null;
  if (baseNeed !== null) {
    tonightNeed = baseNeed
      + Math.min(1.5, (debt || 0) * 0.25)
      + (Number.isFinite(yesterdayStrain) && yesterdayStrain >= 14 ? 0.3 : 0);
    tonightNeed = clamp(tonightNeed, NEED_MIN_H, NEED_MAX_H + 1.5);
  }

  return {
    baseNeedHours: round(baseNeed, 2),
    tonightNeedHours: round(tonightNeed, 2),
    debtHours: round(debt, 1),
    nightsUsed: usable.length,
    derived: true,
    method: `Need is the median of your last ${NEED_WINDOW_NIGHTS} measured nights, bounded ${NEED_MIN_H}–${NEED_MAX_H} h. `
      + `Debt sums nightly shortfall vs need over ${DEBT_WINDOW_NIGHTS} nights with ${DEBT_DECAY} decay per night; long nights repay at half rate; capped at ${DEBT_CAP_H} h. `
      + 'Tonight adds up to 1.5 h for standing debt and 0.3 h after a 14+ strain day.',
    limitation: 'Computed from measured nights only — untracked nights are excluded, not counted as zero sleep.',
  };
}

// ---------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------

/**
 * How aligned bed and wake times are across recent nights, 0–100.
 * Times are measured on the 18:00-anchored clock so midnight is not a cliff.
 */
function buildConsistency(sessions, offsetMs = 0) {
  const beds = sessions.map((s) => stats.minutesFrom6pm(s.start, offsetMs));
  const wakes = sessions.map((s) => stats.minutesFrom6pm(s.end, offsetMs));
  if (sessions.length < 4) {
    return {
      score: null, nights: sessions.length, requiredNights: 4,
      derived: true,
      method: 'Standard deviation of bed and wake clock times over the last 7 nights; 15 minutes or less of spread scores 100, each extra minute costs 1.2 points.',
    };
  }
  const spread = (stats.stdev(beds) + stats.stdev(wakes)) / 2;
  const score = Math.round(clamp(100 - Math.max(0, spread - 15) * 1.2, 0, 100));
  return {
    score,
    spreadMinutes: Math.round(spread),
    nights: sessions.length,
    derived: true,
    method: 'Standard deviation of bed and wake clock times over the last 7 nights; 15 minutes or less of spread scores 100, each extra minute costs 1.2 points.',
  };
}

// ---------------------------------------------------------------------------
// Sessions per day: the main night and its naps
// ---------------------------------------------------------------------------

/**
 * Split one civil day's sleep sessions into the main night and naps.
 *
 * The main night is the longest session; anything else at or under three hours
 * counts as a nap. Naps credit debt at half rate but never join the night's stage
 * totals — Garmin's accounting, which fixed the classic "my nap inflated my sleep
 * score" complaint in the other direction.
 */
function splitSessions(sessions) {
  if (!sessions.length) return { main: null, naps: [] };
  const sorted = [...sessions].sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const main = sorted[0];
  const naps = sorted.slice(1)
    .filter((s) => s.end - s.start <= NAP_MAX_MS)
    .sort((a, b) => a.start - b.start)
    .map((s) => ({
      start: s.start,
      end: s.end,
      hours: round((s.end - s.start) / HOUR_MS, 2),
      debtCreditHours: round(((s.end - s.start) / HOUR_MS) * NAP_CREDIT, 2),
    }));
  return { main, naps };
}

/** Raw sleep sessions anchored inside [from, to), as plain {start,end,anchor}. */
async function sessionsInRange(from, to) {
  const rows = await db.rawPoints('sleep', from, to, 400);
  return rows.map((r) => ({ start: r.start_ms, end: r.end_ms, anchor: r.anchor_ms }))
    .sort((a, b) => a.start - b.start);
}

/**
 * Measured night hours per civil day over a window, naps excluded — the input for
 * need/debt. Returns oldest→newest hours for days that HAVE a main night.
 */
async function nightHours(fromDay, toDay) {
  const sessions = await sessionsInRange(fromDay, toDay);
  const byDay = new Map();
  for (const s of sessions) {
    const day = Math.floor(s.anchor / DAY_MS); // grouping key only; buckets come from anchor
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const { main } = splitSessions(byDay.get(day));
    if (main) out.push((main.end - main.start) / HOUR_MS);
  }
  return out;
}

/** Need/debt for the night ending on dayStart's civil day. */
async function sleepNeedFor(dayStart, { yesterdayStrain = null } = {}) {
  const hours = await nightHours(dayStart - NEED_WINDOW_NIGHTS * DAY_MS, dayStart + DAY_MS);
  return buildSleepNeed(hours, { yesterdayStrain });
}

// ---------------------------------------------------------------------------
// Overnight heart-rate dip
// ---------------------------------------------------------------------------

/**
 * How far sleeping heart rate fell below the previous day's waking level, and when
 * it bottomed out. A late bottom-out (after ~4am) is the classic alcohol/late-meal
 * signature; a shallow dip is a recovery flag. Needs the intraday trace on both
 * sides — absent samples make it null, never a guess.
 */
function buildHrDip(nightPoints, daytimeAvg) {
  const values = nightPoints.map((p) => p.v).filter((v) => Number.isFinite(v));
  if (values.length < 5 || !Number.isFinite(daytimeAvg) || daytimeAvg <= 0) {
    return { dipPercent: null, derived: true };
  }
  const sleepingAvg = stats.mean(values);
  const floor = stats.quantile(values, 0.1);
  let bottomAt = null;
  let best = Infinity;
  for (const p of nightPoints) {
    if (Number.isFinite(p.v) && p.v < best) { best = p.v; bottomAt = p.t; }
  }
  return {
    dipPercent: Math.round(((daytimeAvg - sleepingAvg) / daytimeAvg) * 100),
    sleepingAvg: Math.round(sleepingAvg),
    daytimeAvg: Math.round(daytimeAvg),
    floorBpm: Math.round(floor),
    bottomAtMs: bottomAt,
    derived: true,
    method: 'Average sleeping HR vs the prior day’s 10:00–20:00 average; floor is the night’s 10th percentile.',
  };
}

async function hrDipFor(main, dayStart) {
  if (!main) return { dipPercent: null, derived: true };
  const [trace, dayRow] = await Promise.all([
    db.heartRateTrace(main.start, main.end, 240),
    db.series('heart-rate', dayStart - DAY_MS + 10 * HOUR_MS, dayStart - DAY_MS + 20 * HOUR_MS,
      DAY_MS, 'avg', 0),
  ]);
  return buildHrDip(trace.points, dayRow[0] ? dayRow[0].v : null);
}

// ---------------------------------------------------------------------------
// Monthly sleep pattern (the Fitbit "sleep profile", minus the animal)
// ---------------------------------------------------------------------------

/**
 * Ten-ish metrics over a calendar month, each against a plainly stated typical
 * range, plus one sentence naming the month's dominant pattern. Rule-based on
 * purpose: a classifier would be a black box wearing a cute mascot.
 */
function buildMonthPattern(rows, offsetMs = 0) {
  const nights = rows.filter((r) => r.main);
  if (nights.length < 14) {
    return {
      available: false,
      nights: nights.length,
      requiredNights: 14,
      note: `Needs 14 measured nights in the month; have ${nights.length}.`,
      derived: true,
    };
  }
  const hours = nights.map((r) => (r.main.end - r.main.start) / HOUR_MS);
  const beds = nights.map((r) => stats.minutesFrom6pm(r.main.start, offsetMs));
  const effs = nights.map((r) => r.efficiencyPercent).filter((v) => v !== null);
  const deepShare = nights.map((r) => (r.stageHours && r.hoursAsleep
    ? (r.stageHours.deep || 0) / r.hoursAsleep : null));
  const remShare = nights.map((r) => (r.stageHours && r.hoursAsleep
    ? (r.stageHours.rem || 0) / r.hoursAsleep : null));
  const napCount = rows.reduce((a, r) => a + r.naps.length, 0);

  const metric = (id, label, value, lo, hi, unit, precision = 1) => ({
    id,
    label,
    value: round(value, precision),
    typical: [lo, hi],
    unit,
    status: value === null ? 'unavailable' : value < lo ? 'below' : value > hi ? 'above' : 'typical',
  });

  const metrics = [
    metric('duration', 'Nightly duration', stats.mean(hours), 7, 9, 'h'),
    metric('variability', 'Bedtime variability', stats.stdev(beds), 0, 45, 'min', 0),
    metric('efficiency', 'Efficiency', stats.mean(effs), 85, 100, '%', 0),
    metric('deep', 'Deep share', stats.mean(deepShare) === null ? null : stats.mean(deepShare) * 100, 13, 23, '%', 0),
    metric('rem', 'REM share', stats.mean(remShare) === null ? null : stats.mean(remShare) * 100, 18, 28, '%', 0),
    metric('naps', 'Naps taken', napCount, 0, 8, '', 0),
  ];

  // The sentence names the strongest deviation; ties go to the earlier metric.
  const off = metrics.filter((m) => m.status === 'below' || m.status === 'above');
  const sentences = {
    duration: { below: 'Short nights were the story this month.', above: 'Long nights all month — watch whether they are repaying a debt.' },
    variability: { above: 'Bedtimes moved around a lot; the schedule was the weak point.' },
    efficiency: { below: 'Plenty of time in bed, less of it asleep.' },
    deep: { below: 'Deep sleep ran light this month.', above: 'A deep-sleep-heavy month.' },
    rem: { below: 'REM ran light this month.', above: 'A REM-heavy month.' },
    naps: { above: 'A lot of napping — check what the nights are missing.' },
  };
  let sentence = 'A steady month: every measured sleep metric sat in its typical range.';
  for (const m of off) {
    const s = sentences[m.id] && sentences[m.id][m.status];
    if (s) { sentence = s; break; }
  }

  return {
    available: true,
    nights: nights.length,
    metrics,
    sentence,
    derived: true,
    method: 'Calendar-month averages against broadly typical adult ranges; the sentence names the largest deviation. Descriptive, not diagnostic.',
  };
}

// ---------------------------------------------------------------------------
// Per-day detail rows (shared by the sleep screen and the month pattern)
// ---------------------------------------------------------------------------

/**
 * One row per civil day in [fromDay, toDay): main night, naps, stage hours,
 * efficiency. Days with no sleep sessions yield a row with main: null.
 */
async function dayRows(fromDay, toDay, offsetMs) {
  const [sessions, parts, asleep] = await Promise.all([
    sessionsInRange(fromDay, toDay),
    db.stackedSeries('sleep', fromDay, toDay, DAY_MS, offsetMs),
    db.series('sleep', fromDay, toDay, DAY_MS, 'sum', offsetMs),
  ]);

  const bucketOf = (anchor) => Math.floor((anchor + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  const byDay = new Map();
  for (const s of sessions) {
    const t = bucketOf(s.anchor);
    if (!byDay.has(t)) byDay.set(t, []);
    byDay.get(t).push(s);
  }
  const stagesByDay = new Map();
  for (const p of parts) {
    if (!stagesByDay.has(p.t)) stagesByDay.set(p.t, {});
    stagesByDay.get(p.t)[p.key.toLowerCase()] = round(p.v / HOUR_MS, 2);
  }
  const asleepByDay = new Map(asleep.map((r) => [r.t, r.v]));

  const rows = [];
  for (let t = fromDay; t < toDay; t += DAY_MS) {
    const { main, naps } = splitSessions(byDay.get(t) || []);
    const stages = stagesByDay.get(t) || null;
    const inBed = stages ? Object.values(stages).reduce((a, b) => a + b, 0) : null;
    const asleepMs = asleepByDay.get(t) ?? null;
    rows.push({
      t,
      main,
      naps,
      hoursAsleep: asleepMs === null ? null : round(asleepMs / HOUR_MS, 2),
      hoursInBed: round(inBed, 2),
      mainHours: main ? round((main.end - main.start) / HOUR_MS, 2) : null,
      efficiencyPercent: asleepMs !== null && inBed
        ? Math.round((asleepMs / HOUR_MS / inBed) * 100) : null,
      stageHours: stages,
    });
  }
  return rows;
}

module.exports = {
  DAY_MS, NAP_MAX_MS, NAP_CREDIT,
  buildSleepNeed, buildConsistency, buildHrDip, buildMonthPattern,
  splitSessions, sessionsInRange, nightHours, sleepNeedFor, hrDipFor, dayRows,
};
