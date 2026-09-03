'use strict';
/**
 * Training — load, form, sessions, and what they imply about tomorrow.
 *
 * The load currency everywhere in this file is Edwards TRIMP (lib/metrics.js): zone
 * minutes × zone weight. On top of it sit the classic impulse-response pair —
 * Fitness (42-day EWMA) and Fatigue (7-day EWMA), Form being the gap — which is
 * TrainingPeaks' CTL/ATL/TSB with the vocabulary consumer apps put on it. None of
 * this pretends to be WHOOP Strain or COROS EvoLab; every payload carries the
 * formula it actually used.
 *
 * DAILY LOAD PREFERS THE DEVICE'S OWN ZONE MINUTES. The time-in-heart-rate-zone
 * data type arrives pre-bucketed and costs one cheap parts query for any range;
 * recomputing zones from raw 2-second samples costs a scan of the largest table.
 * The computed path exists as a fallback for accounts whose device does not send
 * zone minutes, and each day says which source fed it.
 *
 * A REST DAY IS ZERO, A PRE-HISTORY DAY IS NULL. "Did not train" is a measured
 * zero and decays fitness like one; days before the account has any zone data at
 * all are unknown and stay null so the model does not invent a detraining spiral
 * that never happened.
 */

const db = require('./db');
const metrics = require('./metrics');
const insights = require('./insights');
const stats = require('./stats');

const DAY_MS = 86400000;
const MINUTE_MS = 60000;
const { clamp, round } = stats;

const CTL_DAYS = 42;
const ATL_DAYS = 7;

/**
 * Fitbit's zone names mapped onto Edwards weights. OUT_OF_RANGE is the rest of the
 * day and carries no load — same reasoning as Zone 1 in metrics.js: sitting still
 * for twenty hours must not outscore a workout.
 */
const DEVICE_ZONE_WEIGHTS = {
  OUT_OF_RANGE: 0, LIGHT: 1, FAT_BURN: 2, MODERATE: 3, CARDIO: 4, VIGOROUS: 5, PEAK: 5,
};

/**
 * Strain: daily TRIMP compressed onto a bounded 0–21 scale with a saturation curve,
 * so the top of the scale takes exponentially more work — the property that makes a
 * bounded strain score readable. 21·(1−e^(−load/350)): load 150 ≈ 7.3, 350 ≈ 13.3,
 * 700 ≈ 18.2, 1200 ≈ 20.3. This is a TRIMP transform, not WHOOP's algorithm.
 */
function strainOf(load) {
  if (load === null || load === undefined || !Number.isFinite(load) || load < 0) return null;
  return round(21 * (1 - Math.exp(-load / 350)), 1);
}

const STRAIN_METHOD = 'Strain = 21·(1−e^(−dailyTRIMP/350)) — a bounded transform of Edwards TRIMP, not WHOOP’s proprietary score.';

// ---------------------------------------------------------------------------
// Daily load series
// ---------------------------------------------------------------------------

/**
 * Dense daily TRIMP for the `days` ending at (and excluding) `toDay`.
 * Device zone minutes where available, computed zones as fallback for the recent
 * window, null before the account's first zone data.
 */
async function dailyLoadSeries(toDay, days, offsetMs, profile, { computedFallbackDays = 30 } = {}) {
  const fromDay = toDay - days * DAY_MS;
  const deviceRows = await db.stackedSeries('time-in-heart-rate-zone', fromDay, toDay, DAY_MS, offsetMs);

  const byDay = new Map();
  for (const r of deviceRows) {
    const w = DEVICE_ZONE_WEIGHTS[r.key];
    if (w === undefined) continue;
    byDay.set(r.t, (byDay.get(r.t) || 0) + r.v * w);
  }

  // Computed fallback, bounded two ways. The day cap keeps a rare gap from
  // scanning years of raw samples; the data floor keeps PRE-HISTORY out of the
  // gap list. Without the floor, a 30-day window reaching before the account's
  // first data point (an 11-day overhang, for this account) put permanently
  // unfillable days in missingRecent, and since the recompute starts at the
  // OLDEST missing day, every single render re-derived zones over the entire
  // heart-rate table — the 4.7s query behind every slow screen. Those days can
  // never gain data, so they must never be treated as gaps.
  const stats = await db.typeStats();
  const firstMs = Math.min(...['heart-rate', 'time-in-heart-rate-zone']
    .map((id) => { const s = stats.find((x) => x.data_type === id); return s && s.first_ms ? s.first_ms : Infinity; }));
  const missingRecent = [];
  for (let t = Math.max(fromDay, toDay - computedFallbackDays * DAY_MS); t < toDay; t += DAY_MS) {
    if (t + DAY_MS <= firstMs) continue; // pre-history: no data can exist there
    if (!byDay.has(t)) missingRecent.push(t);
  }
  if (missingRecent.length) {
    const from = missingRecent[0];
    const zones = await metrics.zoneBreakdown(from, toDay, {
      bucketMs: DAY_MS, offsetMs, maxHr: profile.maxHeartRate, maxHrSource: profile.maxHeartRateSource,
    });
    for (const b of zones.buckets) {
      if (!byDay.has(b.t) && b.load > 0) byDay.set(b.t, b.load);
    }
  }

  const firstData = byDay.size ? Math.min(...byDay.keys()) : null;
  const out = [];
  for (let t = fromDay; t < toDay; t += DAY_MS) {
    if (firstData === null || t < firstData) out.push({ t, load: null, source: null });
    else if (byDay.has(t)) {
      out.push({ t, load: Math.round(byDay.get(t)), source: deviceRows.some((r) => r.t === t) ? 'device-zones' : 'computed' });
    } else out.push({ t, load: 0, source: 'rest' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fitness / fatigue / form
// ---------------------------------------------------------------------------

/**
 * Pure model over a dense daily-load array (nulls = pre-history).
 * Status vocabulary follows the acute:chronic ratio the endurance platforms use.
 */
function buildLoadModel(dailyLoads) {
  const loads = dailyLoads.map((d) => d.load);
  const fitness = stats.ewma(loads, CTL_DAYS);
  const fatigue = stats.ewma(loads, ATL_DAYS);

  const series = dailyLoads.map((d, i) => ({
    t: d.t,
    load: d.load,
    fitness: round(fitness[i], 1),
    fatigue: round(fatigue[i], 1),
    form: fitness[i] === null || fatigue[i] === null ? null : round(fitness[i] - fatigue[i], 1),
  }));

  const last = series[series.length - 1] || null;
  let status = null;
  let ratio = null;
  if (last && last.fitness !== null && last.fitness >= 5 && last.fatigue !== null) {
    ratio = last.fatigue / last.fitness;
    status = ratio < 0.7 ? 'detraining'
      : ratio <= 1.1 ? 'maintaining'
        : ratio <= 1.45 ? 'productive'
          : 'overreaching';
  } else if (last && last.fitness !== null) {
    status = 'building';
  }

  return {
    series,
    // No measured day yet means no model — an object of nulls would invite the UI
    // to render a zero-fitness athlete who never existed.
    current: last && last.fitness !== null ? {
      fitness: last.fitness, fatigue: last.fatigue, form: last.form,
      ratio: round(ratio, 2), status,
    } : null,
    derived: true,
    method: `Fitness = ${CTL_DAYS}-day EWMA of daily TRIMP, Fatigue = ${ATL_DAYS}-day EWMA, Form = Fitness − Fatigue. `
      + 'Status from the fatigue:fitness ratio — under 0.7 detraining, to 1.1 maintaining, to 1.45 productive, above it overreaching.',
    limitation: 'Heart-rate-derived load only; strength work barely moves it (log sets to see it separately).',
  };
}

/**
 * The healthy-load corridor (Gentler Streak's shape): a band around Fitness that
 * your 7-day load should thread through. Low recent readiness narrows the top —
 * a run-down body earns a smaller ceiling.
 */
function buildCorridor(loadModel, { readinessAvg = null } = {}) {
  const upperFactor = Number.isFinite(readinessAvg) && readinessAvg < 50 ? 1.15 : 1.35;
  const series = loadModel.series.map((d) => (d.fitness === null ? {
    t: d.t, lo: null, hi: null, fatigue: d.fatigue,
  } : {
    t: d.t,
    lo: round(d.fitness * 0.7, 1),
    hi: round(d.fitness * upperFactor, 1),
    fatigue: d.fatigue,
  }));

  const last = series[series.length - 1];
  const cur = loadModel.current;
  let state = null;
  if (cur && cur.fitness !== null && cur.fitness >= 5 && last.lo !== null) {
    state = cur.fatigue < last.lo ? 'below' : cur.fatigue > last.hi ? 'above' : 'inside';
  } else if (cur) {
    state = 'building';
  }

  return {
    series,
    state,
    upperFactor,
    derived: true,
    method: `Corridor = 0.7×Fitness to ${upperFactor}×Fitness; your line is 7-day load (Fatigue). `
      + 'Inside means the load is one your body is conditioned for — rest days keep you inside.',
  };
}

// ---------------------------------------------------------------------------
// Recovery countdown
// ---------------------------------------------------------------------------

/**
 * Hours until ready for the next hard effort. Time-denominated on purpose —
 * "13 h to full" answers a question a 0-100 score makes the reader compute.
 */
function buildRecoveryCountdown({ lastSession, readinessScore = null, nowMs }) {
  if (!lastSession || !Number.isFinite(lastSession.end)) {
    return { state: 'ready', hoursRemaining: 0, derived: true };
  }
  const load = Number.isFinite(lastSession.load) ? lastSession.load : 0;
  let hours = clamp(6 + load * 0.12, 6, 72);
  if (Number.isFinite(readinessScore) && readinessScore < 45) hours *= 1.25;
  const fullAt = lastSession.end + hours * 3600000;
  const remaining = Math.max(0, (fullAt - nowMs) / 3600000);
  return {
    state: remaining <= 0 ? 'ready' : remaining <= hours * 0.35 ? 'easy-ok' : 'recovering',
    hoursRemaining: round(remaining, 1),
    fullAtMs: fullAt,
    baseHours: round(hours, 1),
    sessionLoad: Math.round(load),
    derived: true,
    method: 'Hours = 6 + 0.12×session TRIMP (bounded 6–72), ×1.25 when readiness is under 45. Green under 35% remaining.',
    limitation: 'Recomputed at each sync, not live.',
  };
}

// ---------------------------------------------------------------------------
// Sessions: recorded workouts merged with HR-detected activity
// ---------------------------------------------------------------------------

const titleCase = (s) => String(s || '').toLowerCase()
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Merge policy, pure for tests: a detected session that overlaps a recorded one for
 * at least half of either window is the same event seen twice — the typed recording
 * wins, and the detected copy is dropped rather than double-counting the load.
 */
function mergeSessions(recorded, detected) {
  const survivors = detected.filter((d) => !recorded.some((r) => {
    const overlap = Math.min(d.end, r.end) - Math.max(d.start, r.start);
    if (overlap <= 0) return false;
    return overlap >= 0.5 * Math.min(d.end - d.start, r.end - r.start);
  }));
  return [...recorded, ...survivors].sort((a, b) => b.start - a.start);
}

/**
 * Heart-rate recovery: the drop in the first minute after a session ends — Apple's
 * Cardio Recovery. Needs a sample near the end and one near +60 s; sparse sampling
 * yields null rather than an interpolated claim.
 */
function buildHeartRateRecovery(samples, endMs) {
  const at = (target, tolerance) => {
    let best = null;
    for (const s of samples) {
      if (Math.abs(s.t - target) <= tolerance
        && (best === null || Math.abs(s.t - target) < Math.abs(best.t - target))) best = s;
    }
    return best;
  };
  const peak = at(endMs, 20000);
  const after = at(endMs + 60000, 20000);
  if (!peak || !after) return null;
  return {
    dropBpm: Math.round(peak.v - after.v),
    fromBpm: Math.round(peak.v),
    toBpm: Math.round(after.v),
    derived: true,
    method: 'HR at session end minus HR sixty seconds later (±20 s sample tolerance).',
  };
}

/**
 * Sessions for a day range: typed workouts from the exercise data type, plus
 * HR-detected sessions (existing insights engine) for up to `detectDays` recent
 * days — detection reads raw samples and is deliberately not run over months.
 */
async function sessionsFor(fromDay, toDay, offsetMs, profile, { detectDays = 7 } = {}) {
  const rows = await db.rawPoints('exercise', fromDay, toDay, 200);
  const recorded = await Promise.all(rows.map(async (r) => {
    const fields = r.fields ? JSON.parse(r.fields) : {};
    const zones = await metrics.zoneBreakdown(r.start_ms, r.end_ms, {
      bucketMs: 0, offsetMs, maxHr: profile.maxHeartRate, maxHrSource: profile.maxHeartRateSource,
    });
    const trackedMin = zones.total.trackedMinutes;
    return {
      kind: 'recorded',
      type: fields.exerciseType || null,
      label: fields.displayName || titleCase(fields.exerciseType) || 'Workout',
      start: r.start_ms,
      end: r.end_ms,
      durationMinutes: Math.round((r.value ?? (r.end_ms - r.start_ms)) / MINUTE_MS),
      load: zones.total.load,
      strain: strainOf(zones.total.load),
      zoneMinutes: zones.total.minutes,
      trackedMinutes: trackedMin,
      averageHeartRate: null, // filled below when samples are close enough
      calories: fields.calories ?? null,
      distanceKm: fields.distanceMm ? round(fields.distanceMm / 1e6, 2) : null,
      steps: fields.steps ?? null,
      platform: r.platform,
    };
  }));

  // Detection window: recent days only (raw-sample reads are capped at 2 days each).
  const detectFrom = Math.max(fromDay, toDay - detectDays * DAY_MS);
  const detected = [];
  for (let t = detectFrom; t < toDay; t += DAY_MS) {
    const day = await insights.detectedActivities(t, Math.min(t + DAY_MS, toDay), profile);
    for (const s of day.sessions) {
      detected.push({
        kind: 'detected',
        type: null,
        label: 'Elevated heart rate',
        start: s.start,
        end: s.end,
        durationMinutes: s.durationMinutes,
        load: s.cardioLoad,
        strain: strainOf(s.cardioLoad),
        zoneMinutes: s.zoneMinutes,
        averageHeartRate: s.averageHeartRate,
        maxHeartRate: s.maxHeartRate,
        peakZone: s.peakZone,
        calories: s.activeCalories,
      });
    }
  }

  const merged = mergeSessions(recorded, detected);

  // Heart-rate recovery for sessions recent enough to still have samples nearby.
  await Promise.all(merged.slice(0, 10).map(async (s) => {
    try {
      const samples = await db.heartRateSamples(s.end - 5 * MINUTE_MS, s.end + 4 * MINUTE_MS);
      s.heartRateRecovery = buildHeartRateRecovery(samples, s.end);
    } catch { s.heartRateRecovery = null; }
  }));

  return {
    sessions: merged,
    derived: true,
    method: 'Typed workouts from the device, merged with HR-detected sessions (10 min over 60% max HR); when both describe the same window the typed recording wins.',
    limitation: 'Detected sessions are heart-rate-only and never guess an activity type.',
  };
}

// ---------------------------------------------------------------------------
// Personal records
// ---------------------------------------------------------------------------

/**
 * Pure assembly from pre-fetched aggregates, so the record rules are testable.
 * Every record states its window — an all-time best and a last-90-days best are
 * different claims and must not share a label.
 */
function buildRecords({
  maxDaySteps, maxDayDistanceKm, maxDayAzm, maxDayFloors,
  longestSessionMin, maxDayLoad, maxWeekLoad, sessionCount,
}) {
  const rows = [
    { id: 'steps-day', label: 'Biggest step day', value: maxDaySteps ? Math.round(maxDaySteps.v) : null, unit: 'steps', atMs: maxDaySteps ? maxDaySteps.t : null, window: 'all-time' },
    { id: 'distance-day', label: 'Longest day on foot', value: round(maxDayDistanceKm ? maxDayDistanceKm.v : null, 2), unit: 'km', atMs: maxDayDistanceKm ? maxDayDistanceKm.t : null, window: 'all-time' },
    { id: 'azm-day', label: 'Most zone minutes', value: maxDayAzm ? Math.round(maxDayAzm.v) : null, unit: 'AZM', atMs: maxDayAzm ? maxDayAzm.t : null, window: 'all-time' },
    { id: 'floors-day', label: 'Most floors climbed', value: maxDayFloors ? Math.round(maxDayFloors.v) : null, unit: 'floors', atMs: maxDayFloors ? maxDayFloors.t : null, window: 'all-time' },
    { id: 'session', label: 'Longest workout', value: longestSessionMin ? Math.round(longestSessionMin.v) : null, unit: 'min', atMs: longestSessionMin ? longestSessionMin.t : null, window: 'all-time' },
    { id: 'load-day', label: 'Peak training day', value: maxDayLoad ? Math.round(maxDayLoad.v) : null, unit: 'TRIMP', atMs: maxDayLoad ? maxDayLoad.t : null, window: 'last 120 days' },
    { id: 'load-week', label: 'Peak training week', value: maxWeekLoad ? Math.round(maxWeekLoad.v) : null, unit: 'TRIMP', atMs: maxWeekLoad ? maxWeekLoad.t : null, window: 'last 120 days' },
    { id: 'sessions', label: 'Workouts recorded', value: sessionCount ?? null, unit: '', atMs: null, window: 'all-time' },
  ];
  return rows.filter((r) => r.value !== null && r.value > 0);
}

/** Top-N single days of a type over its whole history, best first, as [{v, t}]. */
async function topDaysOf(typeId, n, offsetMs) {
  const statsRows = await db.typeStats();
  const s = statsRows.find((x) => x.data_type === typeId);
  if (!s || !s.points) return [];
  const rows = await db.series(typeId, s.first_ms, s.last_ms + DAY_MS, DAY_MS, 'sum', offsetMs);
  return rows.filter((r) => r.v !== null && r.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, n)
    .map((r) => ({ v: r.v, t: r.t }));
}

/** Best single day of a type over its whole history, as {v, t}. */
async function bestDay(typeId, offsetMs) {
  const top = await topDaysOf(typeId, 1, offsetMs);
  return top[0] || null;
}

/**
 * Lifetime records: the top-N days ever, one podium per metric. Pure assembly so
 * the ranking rules are testable — a measured zero is a day that happened but can
 * never make a podium, an unmeasured metric says nothing at all. Strain podiums
 * rank by load (the transform is monotonic) and present the bounded strain value.
 */
function buildLifetimeRecords({
  totalCalories, activeCalories, steps, distanceKm, strainLoads, azm, floors, top = 3,
} = {}) {
  const podium = (list, precision, transform) => (list || [])
    .filter((r) => r && Number.isFinite(r.v) && r.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, top)
    .map((r) => ({ value: round(transform ? transform(r.v) : r.v, precision), atMs: r.t }));
  const rows = [
    { id: 'total-calories-day', label: 'Most calories burned', unit: 'kcal', precision: 0, top: podium(totalCalories, 0) },
    { id: 'active-calories-day', label: 'Most active calories', unit: 'kcal', precision: 0, top: podium(activeCalories, 0) },
    { id: 'steps-day', label: 'Most steps', unit: 'steps', precision: 0, top: podium(steps, 0) },
    { id: 'distance-day', label: 'Longest day on foot', unit: 'km', precision: 2, top: podium(distanceKm, 2) },
    { id: 'strain-day', label: 'Highest strain', unit: '', precision: 1, top: podium(strainLoads, 1, strainOf) },
    { id: 'azm-day', label: 'Most zone minutes', unit: 'AZM', precision: 0, top: podium(azm, 0) },
    { id: 'floors-day', label: 'Most floors climbed', unit: 'floors', precision: 0, top: podium(floors, 0) },
  ].filter((r) => r.top.length);
  return {
    rows,
    top,
    window: 'all-time',
    derived: true,
    method: `Top ${top} days over the whole history. ${STRAIN_METHOD} Strain days use device zone minutes only, so an off-wrist day cannot place.`,
  };
}

/** Lifetime records over the whole synced history — top-3 podium per metric. */
async function lifetimeRecordsFor(offsetMs) {
  const N = 3;
  const [totalCalories, activeCalories, steps, distance, azm, floors, statsRows] = await Promise.all([
    topDaysOf('total-calories', N, offsetMs),
    topDaysOf('active-energy-burned', N, offsetMs),
    topDaysOf('steps', N, offsetMs),
    topDaysOf('distance', N, offsetMs),
    topDaysOf('active-zone-minutes', N, offsetMs),
    topDaysOf('floors', N, offsetMs),
    db.typeStats(),
  ]);

  // Lifetime daily load from the device's own zone minutes ONLY — one cheap parts
  // query for the whole history. No raw-sample fallback here: a rare gap day reads
  // 0 and simply cannot win a podium, whereas rebuilding it would scan years of
  // 2-second samples on every You visit.
  const zoneStats = statsRows.find((x) => x.data_type === 'time-in-heart-rate-zone');
  let strainLoads = [];
  if (zoneStats && zoneStats.points) {
    const deviceRows = await db.stackedSeries(
      'time-in-heart-rate-zone', zoneStats.first_ms, zoneStats.last_ms + DAY_MS, DAY_MS, offsetMs,
    );
    const byDay = new Map();
    for (const r of deviceRows) {
      const w = DEVICE_ZONE_WEIGHTS[r.key];
      if (w === undefined) continue;
      byDay.set(r.t, (byDay.get(r.t) || 0) + r.v * w);
    }
    strainLoads = [...byDay].map(([t, load]) => ({ t, v: load }));
  }

  return buildLifetimeRecords({
    totalCalories,
    activeCalories,
    steps,
    distanceKm: distance.map((r) => ({ v: r.v * 1e-6, t: r.t })),
    strainLoads,
    azm,
    floors,
    top: N,
  });
}

async function recordsFor(offsetMs, profile, loadSeries) {
  const scale = (rec, factor) => (rec ? { v: rec.v * factor, t: rec.t } : null);
  const [steps, distance, azm, floors, statsRows] = await Promise.all([
    bestDay('steps', offsetMs),
    bestDay('distance', offsetMs),
    bestDay('active-zone-minutes', offsetMs),
    bestDay('floors', offsetMs),
    db.typeStats(),
  ]);
  const exercise = statsRows.find((x) => x.data_type === 'exercise');
  let longestSession = null;
  if (exercise && exercise.points) {
    const rows = await db.rawPoints('exercise', exercise.first_ms, exercise.last_ms + DAY_MS, 2000);
    for (const r of rows) {
      const min = (r.value ?? (r.end_ms - r.start_ms)) / MINUTE_MS;
      if (longestSession === null || min > longestSession.v) longestSession = { v: min, t: r.start_ms };
    }
  }

  let maxDayLoad = null;
  let maxWeekLoad = null;
  if (loadSeries && loadSeries.length) {
    for (const d of loadSeries) {
      if (d.load !== null && (maxDayLoad === null || d.load > maxDayLoad.v)) maxDayLoad = { v: d.load, t: d.t };
    }
    for (let i = 6; i < loadSeries.length; i++) {
      const week = loadSeries.slice(i - 6, i + 1);
      if (week.some((d) => d.load === null)) continue;
      const sum = week.reduce((a, d) => a + d.load, 0);
      if (maxWeekLoad === null || sum > maxWeekLoad.v) maxWeekLoad = { v: sum, t: week[0].t };
    }
  }

  return buildRecords({
    maxDaySteps: steps,
    maxDayDistanceKm: scale(distance, 1e-6),
    maxDayAzm: azm,
    maxDayFloors: floors,
    longestSessionMin: longestSession,
    maxDayLoad,
    maxWeekLoad,
    sessionCount: exercise ? exercise.points : null,
  });
}

// ---------------------------------------------------------------------------
// Strength log
// ---------------------------------------------------------------------------

/**
 * Volume index for logged strength work: whole-body kg moved, compressed to a small
 * bounded number so it can sit beside cardio load without pretending to be it.
 * Kept deliberately separate — summing kg-volume into TRIMP would invent a unit.
 */
function muscularIndex(volumeKg) {
  if (!Number.isFinite(volumeKg) || volumeKg <= 0) return 0;
  return round(Math.min(30, 6 * Math.log10(1 + volumeKg / 100)), 1);
}

module.exports = {
  DAY_MS, CTL_DAYS, ATL_DAYS, DEVICE_ZONE_WEIGHTS, STRAIN_METHOD,
  strainOf, dailyLoadSeries, buildLoadModel, buildCorridor,
  buildRecoveryCountdown, mergeSessions, buildHeartRateRecovery, sessionsFor,
  buildRecords, recordsFor, muscularIndex,
  topDaysOf, buildLifetimeRecords, lifetimeRecordsFor,
};
