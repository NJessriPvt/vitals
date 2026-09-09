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

/**
 * Need is anchored on physiology, not on habit. The base is 8 h (or the
 * `sleepNeedHours` setting), and only the strain top-up and standing debt move
 * tonight's number. The previous model took the median of the last 28 nights as
 * the need — which defined the need as whatever the person had been doing, so a
 * chronic 6h40 sleeper was told 6h40 was their need and then congratulated for
 * meeting 115 % of it. Bounds are the plausible adult range.
 */
const DEFAULT_NEED_H = 8;
const NEED_MIN_H = 6;
const NEED_MAX_H = 11;
const DEBT_WINDOW_NIGHTS = 14;
const DEBT_DECAY = 0.85;
const DEBT_CAP_H = 15;
/**
 * Fraction of standing debt added to tonight's need. Σ 0.85^i over 14 nights is
 * 5.08, so a repayment rate r gives the need↔debt loop a gain of 5.08·r: at the
 * old 0.25 the gain was 1.27 — above one — and every sub-8 h sleeper's need
 * chased itself up to the cap. 0.05 (gain 0.25) settles at 8h00 / 8h10 / 8h20 /
 * 8h30 for 8 / 7.5 / 7 / 6 h sleepers.
 */
const DEBT_REPAY = 0.05;

/** Sessions on the same civil day at most this far apart are one night: Fitbit
 * splits a night on a bathroom break, and scoring the longer half alone read a
 * 260 + 200 minute night as a 4h20 night. The gap counts as awake, in bed. */
const MERGE_GAP_MS = 90 * 60000;
/** A sleep session at or under this length, starting in the daytime, is a nap.
 * Longer daytime sessions are STILL listed — nothing measured is dropped. */
const NAP_MAX_MS = 3 * HOUR_MS;
/** Naps repay debt at half rate — fragmented daytime sleep restores less than the
 * same time at night. The credit is visible on the nap row AND enters the debt
 * arithmetic (it used to be printed and never applied). */
const NAP_CREDIT = 0.5;

// ---------------------------------------------------------------------------
// Need & debt
// ---------------------------------------------------------------------------

/**
 * Pure model so the arithmetic is unit-testable.
 *
 * `nights` is oldest→newest, one entry per MEASURED night: hours asleep in the
 * main night plus half-credit for that day's naps; absent nights are simply not
 * in the list. `yesterdayStrain` adds up to 45 minutes after a hard day (five
 * minutes per strain point over 10), `baseNeedHours` is the profile setting.
 */
function buildSleepNeed(nights, { yesterdayStrain = null, baseNeedHours = null } = {}) {
  const hasSetting = Number.isFinite(baseNeedHours) && baseNeedHours >= NEED_MIN_H && baseNeedHours <= NEED_MAX_H;
  const baseNeed = hasSetting ? baseNeedHours : DEFAULT_NEED_H;

  // Under four hours is a tracking artefact (a watch taken off mid-night, an
  // unstitched split) far more often than a real night; it must not owe debt.
  const usable = nights.filter((h) => Number.isFinite(h) && h >= 4);

  const debtOf = (list) => {
    if (!list.length) return 0;
    const recent = list.slice(-DEBT_WINDOW_NIGHTS);
    let sum = 0;
    recent.forEach((h, i) => {
      const age = recent.length - 1 - i; // 0 = last night
      const weight = DEBT_DECAY ** age;
      const delta = baseNeed - h;
      // A long night repays debt, but only at half value — nine hours on Saturday
      // does not cancel two five-hour weeknights, however much we wish it did.
      sum += (delta > 0 ? delta : delta * 0.5) * weight;
    });
    return clamp(sum, 0, DEBT_CAP_H);
  };
  const debt = usable.length ? debtOf(usable) : null;

  const strainTopUp = Number.isFinite(yesterdayStrain)
    ? clamp((yesterdayStrain - 10) * (5 / 60), 0, 0.75) : 0;
  const tonightNeed = clamp(baseNeed + strainTopUp + (debt || 0) * DEBT_REPAY, NEED_MIN_H, NEED_MAX_H);
  // The need that applied to the NEWEST night in the list: the debt carried INTO
  // it, not the debt it left behind — scoring a short night against a need that
  // already includes its own shortfall double-charges it.
  const lastNightNeed = clamp(baseNeed + strainTopUp + debtOf(usable.slice(0, -1)) * DEBT_REPAY, NEED_MIN_H, NEED_MAX_H);

  return {
    baseNeedHours: round(baseNeed, 2),
    baseSource: hasSetting ? 'setting' : 'default',
    tonightNeedHours: round(tonightNeed, 2),
    lastNightNeedHours: round(lastNightNeed, 2),
    debtHours: round(debt, 1),
    nightsUsed: usable.length,
    derived: true,
    method: `Need starts at ${hasSetting ? 'your set' : 'the adult default of'} ${round(baseNeed, 1)} h; tonight adds five minutes per strain point over 10 (up to 45 min) and ${DEBT_REPAY * 100}% of standing debt, bounded ${NEED_MIN_H}–${NEED_MAX_H} h. `
      + `Debt sums nightly shortfall vs need over ${DEBT_WINDOW_NIGHTS} measured nights with ${DEBT_DECAY} decay per night; long nights repay at half rate, naps credit at half rate; capped at ${DEBT_CAP_H} h.`,
    limitation: 'Computed from measured nights only — untracked nights are excluded, not counted as zero sleep. The base is a physiological default, not a measurement of you.',
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
 * Stitch sessions that are close together in time into one: the watch splits a
 * night at a bathroom break and both halves arrive as separate records. The
 * merged session keeps the sum of asleep time, the total gap (awake, in bed) and
 * how many records it came from, so a screen can say "2 sessions stitched".
 */
function stitchSessions(sessions) {
  const asleepOf = (x) => (Number.isFinite(x.asleepMs) ? x.asleepMs : x.end - x.start);
  const sorted = [...sessions].sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      // OVERLAPPING records are the same sleep written twice (two writers, or a
      // restated night under a new id) — never two sleeps to add up. Keep the
      // wider span and the larger measured asleep time.
      last.end = Math.max(last.end, s.end);
      last.anchor = Math.max(last.anchor ?? last.end, s.anchor ?? s.end);
      last.asleepMs = Math.max(asleepOf(last), asleepOf(s));
      last.stagesEstimated = !!(last.stagesEstimated && s.stagesEstimated);
    } else if (last && s.start - last.end <= MERGE_GAP_MS) {
      const gap = s.start - last.end;
      last.end = s.end;
      last.anchor = Math.max(last.anchor ?? last.end, s.anchor ?? s.end);
      last.asleepMs = asleepOf(last) + asleepOf(s);
      last.gapMs = (last.gapMs || 0) + gap;
      last.sessionCount = (last.sessionCount || 1) + 1;
    } else {
      out.push({ ...s, asleepMs: asleepOf(s), gapMs: s.gapMs || 0, sessionCount: s.sessionCount || 1 });
    }
  }
  return out;
}

/**
 * Split one civil day's sleep sessions into the main night and the rest.
 *
 * Sessions within 90 minutes of each other are stitched first; the longest
 * stitched session is the night. Everything else is listed under `naps` — a
 * daytime sleep over three hours is flagged `long` rather than dropped, because a
 * measured four hours of sleep that appears on no screen is data loss. Naps
 * credit debt at half rate but never join the night's stage totals — Garmin's
 * accounting, which fixed the classic "my nap inflated my sleep score" complaint
 * in the other direction.
 */
function splitSessions(sessions) {
  if (!sessions.length) return { main: null, naps: [] };
  const sorted = stitchSessions(sessions).sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const main = sorted[0];
  const naps = sorted.slice(1)
    .sort((a, b) => a.start - b.start)
    .map((s) => ({
      start: s.start,
      end: s.end,
      hours: round(asleepHoursOf(s), 2),
      long: s.end - s.start > NAP_MAX_MS,
      debtCreditHours: round(asleepHoursOf(s) * NAP_CREDIT, 2),
    }));
  return { main, naps };
}

/** Sleep sessions anchored inside [from, to), STITCHED (records ≤ 90 min apart
 * are one night, so a split that straddles local midnight merges before any
 * day grouping sees it), as {start,end,anchor,asleepMs,gapMs,sessionCount}.
 * `asleepMs` is the stored point value: stage time minus AWAKE, or 92 % of the
 * in-bed span for a stageless record (`stagesEstimated`). */
async function sessionsInRange(from, to) {
  const rows = await db.rawPoints('sleep', from, to, 400);
  const parse = (f) => { try { return typeof f === 'string' ? JSON.parse(f) : f; } catch { return null; } };
  return stitchSessions(rows.map((r) => {
    const fields = parse(r.fields);
    return {
      start: r.start_ms, end: r.end_ms, anchor: r.anchor_ms, asleepMs: r.value,
      stagesEstimated: !!(fields && fields.stagesEstimated),
    };
  }));
}

/** Hours ACTUALLY ASLEEP in a session — never the in-bed span when stages exist. */
function asleepHoursOf(session) {
  if (!session) return null;
  const ms = Number.isFinite(session.asleepMs) ? session.asleepMs : session.end - session.start;
  return ms / HOUR_MS;
}

/**
 * Measured sleep hours per VIEWER civil day over a window — the input for
 * need/debt: the main night's asleep hours plus HALF of that day's nap hours (the
 * nap credit, applied here so the debt number and the "repaid" note agree).
 * Returns oldest→newest for days that HAVE a main night. Grouping uses the viewer
 * offset like dayRows does: a pre-4am-local wake must not fold into the previous
 * UTC day and silently drop a night.
 */
async function nightHours(fromDay, toDay, offsetMs = 0) {
  const sessions = await sessionsInRange(fromDay, toDay);
  const byDay = new Map();
  for (const s of sessions) {
    const day = Math.floor((s.anchor + offsetMs) / DAY_MS);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const { main, naps } = splitSessions(byDay.get(day));
    if (main) out.push(asleepHoursOf(main) + naps.reduce((a, n) => a + (n.debtCreditHours || 0), 0));
  }
  return out;
}

/** Need/debt for the night ending on dayStart's civil day. */
async function sleepNeedFor(dayStart, offsetMs = 0, { yesterdayStrain = null } = {}) {
  const [hours, setting] = await Promise.all([
    nightHours(dayStart - DEBT_WINDOW_NIGHTS * DAY_MS, dayStart + DAY_MS, offsetMs),
    db.getSetting('sleepNeedHours', ''),
  ]);
  const baseNeedHours = Number(setting);
  return buildSleepNeed(hours, { yesterdayStrain, baseNeedHours: setting === '' ? null : baseNeedHours });
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
  const [trace, daytimeAvg] = await Promise.all([
    db.heartRateTrace(main.start, main.end, 240),
    // One aggregate over the window — day-bucketing a 10-hour span that straddles
    // a UTC midnight returns two rows and [0] would be a partial average.
    db.aggregate('heart-rate', dayStart - DAY_MS + 10 * HOUR_MS, dayStart - DAY_MS + 20 * HOUR_MS, 'avg'),
  ]);
  return buildHrDip(trace.points, daytimeAvg);
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
  const hours = nights.map((r) => r.mainAsleepHours ?? (r.main.end - r.main.start) / HOUR_MS);
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
    const inBed = stages
      ? Object.values(stages).reduce((a, b) => a + b, 0) + (main && main.gapMs ? main.gapMs / HOUR_MS : 0)
      : null;
    const asleepMs = asleepByDay.get(t) ?? null;
    rows.push({
      t,
      main,
      naps,
      hoursAsleep: asleepMs === null ? null : round(asleepMs / HOUR_MS, 2),
      hoursInBed: round(inBed, 2),
      mainHours: main ? round((main.end - main.start) / HOUR_MS, 2) : null,
      // Time asleep within the MAIN night (naps excluded) — the number that
      // compares against need. mainHours is the in-bed span; at ~90% efficiency
      // they differ by ~45 min, and mixing them made two screens disagree.
      mainAsleepHours: main ? round(asleepHoursOf(main), 2) : null,
      stitchedSessions: main ? main.sessionCount || 1 : null,
      // A stageless record's asleep time (and so its efficiency) is the 92 %
      // estimate, and every consumer must be able to say so.
      stagesEstimated: main ? !!main.stagesEstimated : false,
      efficiencyPercent: asleepMs !== null && inBed
        ? Math.round((asleepMs / HOUR_MS / inBed) * 100) : null,
      stageHours: stages,
    });
  }
  return rows;
}

module.exports = {
  buildSleepNeed, buildConsistency, buildHrDip, buildMonthPattern,
  splitSessions, stitchSessions, nightHours, sleepNeedFor, hrDipFor, dayRows,
  NEED_MIN_H, NEED_MAX_H,
};
