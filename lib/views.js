'use strict';
/**
 * View payloads — one endpoint per screen.
 *
 * The dashboard has three screens and each asks a different question, so each gets a
 * purpose-built payload rather than a dozen generic /api/series calls stitched
 * together in the browser. The day view in particular needs eight metrics, an hourly
 * breakdown, a zone histogram and an intraday trace; assembling that client-side
 * would be eight round trips and eight chances to disagree about the range.
 *
 * Every payload states the civil day it describes and the offset it was computed
 * with, because "today" is the viewer's day, not the server's.
 */

const catalog = require('./catalog');
const db = require('./db');
const insights = require('./insights');
const metrics = require('./metrics');
const { scaled, denseBuckets } = require('./query');

const DAY_MS = 86400000;

const round = (v, p = 1) => (v === null || v === undefined || !Number.isFinite(v)
  ? null : Number(v.toFixed(p)));

/** "2026-08-15" + offset -> [startMs, endMs) of that civil day. */
function dayRange(dateStr, offsetMs) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const start = Date.UTC(y, m - 1, d) - offsetMs;
  return [start, start + DAY_MS];
}

function civilDate(ms, offsetMs) {
  return new Date(ms + offsetMs).toISOString().slice(0, 10);
}

function todayString(offsetMs) {
  return civilDate(Date.now(), offsetMs);
}

async function value(typeId, from, to, agg) {
  const type = catalog.get(typeId);
  if (!type) return null;
  const v = await db.aggregate(typeId, from, to, agg || type.agg);
  return v === null ? null : scaled(v, type);
}

/** Sleep for the night that ENDED on this day, with its stages. */
async function sleepForDay(from, to, offsetMs) {
  const [row] = await db.series('sleep', from, to, DAY_MS, 'sum', offsetMs);
  if (!row || row.v === null) return null;

  const parts = await db.stackedSeries('sleep', from, to, DAY_MS, offsetMs);
  const stages = {};
  let inBedMs = 0;
  for (const p of parts) {
    stages[p.key.toLowerCase()] = round(p.v / 3600000, 2);
    inBedMs += p.v;
  }
  const asleepMs = row.v;

  // The raw session carries the actual clock times AND the stage-by-stage timeline,
  // which is the whole point of a sleep screen: totals say you slept seven hours, a
  // hypnogram says whether it was seven hours or four wakings.
  const raw = await db.rawPoints('sleep', from, to, 5);
  const session = raw[0] || null;

  let timeline = [];
  if (session) {
    const [full] = await db.rawPointsWithRaw('sleep', session.anchor_ms);
    if (full) {
      try {
        const body = JSON.parse(full.raw);
        const payload = body.sleep || body[Object.keys(body).find((k) => k !== 'name' && k !== 'dataSource')] || {};
        const src = payload.stages || payload.sleepStages || payload.levels || [];
        timeline = src.map((st) => ({
          from: Date.parse(st.startTime),
          to: Date.parse(st.endTime),
          stage: String(st.type || st.level || 'UNKNOWN').toUpperCase(),
        })).filter((x) => Number.isFinite(x.from) && Number.isFinite(x.to) && x.to > x.from)
          .sort((a, b) => a.from - b.from);
      } catch { /* a malformed session should not take the whole screen down */ }
    }
  }

  return {
    hoursAsleep: round(asleepMs / 3600000, 2),
    hoursInBed: round(inBedMs / 3600000, 2),
    // Efficiency is time asleep over time in bed. `stageHours` includes AWAKE, so it
    // does not sum to hoursAsleep — that is the point of reporting both.
    efficiencyPercent: inBedMs ? Math.round((asleepMs / inBedMs) * 100) : null,
    stageHours: stages,
    bedtime: session ? new Date(session.start_ms).toISOString() : null,
    wakeTime: session ? new Date(session.end_ms).toISOString() : null,
    timeline,
    derived: false,
  };
}

/**
 * The day screen. Default is the viewer's today; any past date can be asked for.
 */
async function dayPayload(dateStr, offsetMs) {
  const date = dateStr || todayString(offsetMs);
  const [from, to] = dayRange(date, offsetMs);
  const isToday = date === todayString(offsetMs);
  // For today, cut the hourly series at the current hour — trailing empty hours read
  // as "you did nothing this evening" rather than "the evening hasn't happened".
  const effectiveTo = isToday ? Math.min(to, Date.now()) : to;

  const profile = await metrics.getProfile();
  const { age, maxHeartRate: maxHr } = profile;
  const activitiesPromise = insights.detectedActivities(from, effectiveTo, profile);
  const fitnessAgePromise = insights.fitnessAgeOutlook(
    from, offsetMs, profile, catalog.get('sleep').goal,
  );

  const [
    steps, distance, activeCal, totalCal, azm, activeMin, restingHr, sleep, zones, trace,
  ] = await Promise.all([
    value('steps', from, to),
    value('distance', from, to),
    value('active-energy-burned', from, to),
    value('total-calories', from, to),
    value('active-zone-minutes', from, to),
    value('active-minutes', from, to),
    value('daily-resting-heart-rate', from, to, 'avg'),
    sleepForDay(from, to, offsetMs),
    metrics.zoneBreakdown(from, effectiveTo, { bucketMs: 3600000, offsetMs, maxHr }),
    db.heartRateTrace(from, effectiveTo),
  ]);

  const [hrDay] = await db.series('heart-rate', from, to, DAY_MS, 'avg', offsetMs);

  // Resting HR: no daily summary exists for this account, so fall back to the lowest
  // sustained rate overnight and say it is derived rather than the device's figure.
  let resting = restingHr;
  let restingSource = restingHr === null ? null : 'device';
  if (resting === null) {
    const [night] = await db.series('heart-rate', from, from + 8 * 3600000, DAY_MS, 'min', offsetMs);
    if (night && night.v !== null) { resting = night.v; restingSource = 'derived'; }
  }

  const [activities, recovery, fitnessAge] = await Promise.all([
    activitiesPromise,
    insights.recoveryOutlook(from, offsetMs, {
      restingHeartRate: resting,
      restingHeartRateSource: restingSource,
      sleepHours: sleep ? sleep.hoursAsleep : null,
    }, catalog.get('sleep').goal),
    fitnessAgePromise,
  ]);

  // Hourly series, dense so an idle hour is a gap in the bar chart rather than a
  // missing column that shifts every later hour left.
  const hourly = async (typeId, agg) => {
    const type = catalog.get(typeId);
    if (!type) return [];
    const rows = await db.series(typeId, from, effectiveTo, 3600000, agg || type.agg, offsetMs);
    return denseBuckets(
      rows.map((r) => ({ t: r.t, v: scaled(r.v, type) })),
      from, effectiveTo, 3600000, offsetMs, (t) => ({ t, v: null }),
    );
  };
  const [stepsHourly, caloriesHourly] = await Promise.all([
    hourly('steps'), hourly('active-energy-burned'),
  ]);

  const loadByBucket = new Map(zones.buckets.map((b) => [b.t, b]));
  const loadHourly = denseBuckets(
    zones.buckets.map((b) => ({ t: b.t, v: b.load })),
    from, effectiveTo, 3600000, offsetMs, (t) => ({ t, v: null }),
  );

  return {
    view: 'day',
    date,
    isToday,
    timezoneOffsetMinutes: offsetMs / 60000,
    range: { from, to, through: effectiveTo },
    age,
    profile,
    headline: {
      steps: round(steps, 0),
      distanceKm: round(distance, 2),
      cardioLoad: zones.total.load,
      activeCalories: round(activeCal, 0),
      totalCalories: round(totalCal, 0),
      activeZoneMinutes: round(azm, 0),
      activeMinutes: round(activeMin, 0),
      heartRate: hrDay && hrDay.v !== null
        ? { min: round(hrDay.lo, 0), avg: round(hrDay.v, 0), max: round(hrDay.hi, 0) }
        : null,
      restingHeartRate: round(resting, 0),
      restingHeartRateSource: restingSource,
      sleepHours: sleep ? sleep.hoursAsleep : null,
      sleepEfficiencyPercent: sleep ? sleep.efficiencyPercent : null,
      hrv: recovery.signals.find((signal) => signal.id === 'hrv')?.current ?? null,
      hrvSource: recovery.signals.find((signal) => signal.id === 'hrv')?.source ?? null,
    },
    insights: { fitnessAge, activities, recovery },
    zones,
    sleep,
    hourly: {
      bucketMs: 3600000,
      steps: stepsHourly,
      activeCalories: caloriesHourly,
      cardioLoad: loadHourly,
      zoneMinutes: zones.buckets.map((b) => ({ t: b.t, minutes: b.minutes })),
      // Zone detail per hour, for the tooltip on the load chart.
      byBucket: [...loadByBucket.keys()],
    },
    heartRateTrace: trace,
    goals: { steps: catalog.get('steps').goal, sleepHours: catalog.get('sleep').goal },
  };
}

/**
 * The overview screen: one row per civil day so days can be compared directly.
 * `days` is 7 for the week view and 30 for the month view — the same shape, because
 * the question ("how does today compare") does not change with the window.
 */
async function overviewPayload(days, offsetMs) {
  const n = Math.max(1, Math.min(120, Number(days) || 7));
  const profile = await metrics.getProfile();
  const { age, maxHeartRate: maxHr } = profile;

  const todayStart = dayRange(todayString(offsetMs), offsetMs)[0];
  const from = todayStart - (n - 1) * DAY_MS;
  const to = todayStart + DAY_MS;

  const seriesFor = async (typeId, agg) => {
    const type = catalog.get(typeId);
    if (!type) return new Map();
    const rows = await db.series(typeId, from, to, DAY_MS, agg || type.agg, offsetMs);
    return new Map(rows.map((r) => [r.t, { v: scaled(r.v, type), lo: scaled(r.lo, type), hi: scaled(r.hi, type) }]));
  };

  const [steps, distance, activeCal, totalCal, azm, sleep, hr, zones] = await Promise.all([
    seriesFor('steps'), seriesFor('distance'), seriesFor('active-energy-burned'),
    seriesFor('total-calories'), seriesFor('active-zone-minutes'), seriesFor('sleep'),
    seriesFor('heart-rate', 'avg'),
    metrics.zoneBreakdown(from, to, { bucketMs: DAY_MS, offsetMs, maxHr }),
  ]);
  const loadByDay = new Map(zones.buckets.map((b) => [b.t, b]));

  const rows = [];
  for (let i = 0; i < n; i++) {
    const t = from + i * DAY_MS;
    const hrDay = hr.get(t);
    const z = loadByDay.get(t);
    rows.push({
      t,
      date: civilDate(t, offsetMs),
      steps: round(steps.get(t)?.v, 0),
      distanceKm: round(distance.get(t)?.v, 2),
      activeCalories: round(activeCal.get(t)?.v, 0),
      totalCalories: round(totalCal.get(t)?.v, 0),
      activeZoneMinutes: round(azm.get(t)?.v, 0),
      cardioLoad: z ? z.load : null,
      zoneMinutes: z ? z.minutes : null,
      // `seriesFor` already applied the type's scale, so this is HOURS. Dividing by
      // 3,600,000 again turned every night into 0.0000022 and rounded it to zero.
      sleepHours: round(sleep.get(t)?.v ?? null, 2),
      heartRate: hrDay && hrDay.v !== null
        ? { min: round(hrDay.lo, 0), avg: round(hrDay.v, 0), max: round(hrDay.hi, 0) } : null,
    });
  }

  const avg = (key) => {
    const vals = rows.map((r) => r[key]).filter((v) => v !== null && Number.isFinite(v));
    return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 1) : null;
  };
  const sum = (key) => {
    const vals = rows.map((r) => r[key]).filter((v) => v !== null && Number.isFinite(v));
    return vals.length ? round(vals.reduce((a, b) => a + b, 0), 0) : null;
  };

  return {
    view: 'overview',
    days: n,
    timezoneOffsetMinutes: offsetMs / 60000,
    range: { from, to },
    age,
    profile,
    zoneTable: metrics.zoneTable(maxHr),
    totals: {
      steps: sum('steps'),
      distanceKm: round(rows.reduce((a, r) => a + (r.distanceKm || 0), 0), 1),
      cardioLoad: sum('cardioLoad'),
      activeCalories: sum('activeCalories'),
    },
    averages: {
      stepsPerDay: avg('steps'),
      distanceKmPerDay: avg('distanceKm'),
      cardioLoadPerDay: avg('cardioLoad'),
      activeCaloriesPerDay: avg('activeCalories'),
      totalCaloriesPerDay: avg('totalCalories'),
      sleepHoursPerNight: avg('sleepHours'),
      activeZoneMinutesPerDay: avg('activeZoneMinutes'),
    },
    rows,
  };
}

/**
 * The sleep screen: one night in detail plus the trend behind it.
 */
async function sleepPayload(dateStr, days, offsetMs) {
  const date = dateStr || todayString(offsetMs);
  const [from, to] = dayRange(date, offsetMs);
  const n = Math.max(2, Math.min(120, Number(days) || 7));

  const trendTo = dayRange(todayString(offsetMs), offsetMs)[0] + DAY_MS;
  const trendFrom = trendTo - n * DAY_MS;

  const [night, rows, parts] = await Promise.all([
    sleepForDay(from, to, offsetMs),
    db.series('sleep', trendFrom, trendTo, DAY_MS, 'sum', offsetMs),
    db.stackedSeries('sleep', trendFrom, trendTo, DAY_MS, offsetMs),
  ]);

  const stagesByDay = new Map();
  for (const p of parts) {
    if (!stagesByDay.has(p.t)) stagesByDay.set(p.t, {});
    stagesByDay.get(p.t)[p.key.toLowerCase()] = round(p.v / 3600000, 2);
  }
  const asleepByDay = new Map(rows.map((r) => [r.t, r.v]));

  const trend = [];
  for (let t = trendFrom; t < trendTo; t += DAY_MS) {
    const asleep = asleepByDay.get(t);
    const stages = stagesByDay.get(t) || null;
    const inBed = stages ? Object.values(stages).reduce((a, b) => a + b, 0) : null;
    trend.push({
      t,
      date: civilDate(t, offsetMs),
      hoursAsleep: asleep ? round(asleep / 3600000, 2) : null,
      hoursInBed: round(inBed, 2),
      efficiencyPercent: asleep && inBed ? Math.round((asleep / 3600000 / inBed) * 100) : null,
      stageHours: stages,
    });
  }

  const withData = trend.filter((d) => d.hoursAsleep !== null);
  const mean = (key) => {
    const vals = withData.map((d) => d[key]).filter((v) => v !== null && Number.isFinite(v));
    return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 2) : null;
  };
  const stageMean = (stage) => {
    const vals = withData.map((d) => (d.stageHours ? d.stageHours[stage] : null))
      .filter((v) => v !== null && Number.isFinite(v));
    return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 2) : null;
  };

  return {
    view: 'sleep',
    date,
    days: n,
    timezoneOffsetMinutes: offsetMs / 60000,
    goalHours: catalog.get('sleep').goal,
    night,
    trend,
    averages: {
      nights: withData.length,
      hoursAsleep: mean('hoursAsleep'),
      hoursInBed: mean('hoursInBed'),
      efficiencyPercent: mean('efficiencyPercent'),
      stageHours: {
        deep: stageMean('deep'), rem: stageMean('rem'),
        light: stageMean('light'), awake: stageMean('awake'),
      },
    },
  };
}

module.exports = { dayPayload, overviewPayload, sleepPayload, dayRange, todayString, DAY_MS };
