'use strict';
/**
 * The five screens — Today, Sleep, Train, Trends, You — one payload each.
 *
 * Same contract as lib/views.js (which still serves the legacy endpoints): each
 * screen asks ONE question and gets a purpose-built payload, aggregation happens
 * here next to the data, and the browser renders rather than computes. These
 * payloads are also the API a future native app would consume — which is why they
 * carry their own dates, units, methods and freshness instead of assuming a
 * particular client.
 *
 * Query discipline: shared inputs (the day's load series, the night's sessions,
 * baselines) are fetched ONCE per request and passed into the pure builders in
 * scores/night/training/trends — never refetched per card.
 */

const catalog = require('./catalog');
const db = require('./db');
const metrics = require('./metrics');
const insights = require('./insights');
const night = require('./night');
const scores = require('./scores');
const training = require('./training');
const trends = require('./trends');
const goals = require('./goals');
const stats = require('./stats');
const { dayRange, todayString } = require('./views');
const { scaled, denseBuckets } = require('./query');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// Intraday heart rate: five minutes is the finest bucket that still reads as a
// shape rather than noise on a phone-width axis, and it divides the hour evenly so
// bucket edges land on the clock. The reference band is measured over the same
// bucket size (see db.bucketBand) or it would not be comparable.
const HR_BUCKET_MS = 5 * 60000;
const HR_BAND_DAYS = 14;
const { round } = stats;

// ---------------------------------------------------------------------------
// Shared input fetchers
// ---------------------------------------------------------------------------

// Daily values with the DAILY→sample fallback — one implementation, shared with
// the legacy insights layer (a second copy here is how two screens end up
// disagreeing about the same baseline).
const dailyWithFallback = insights.dailyValues;

async function value(typeId, from, to, agg) {
  const type = catalog.get(typeId);
  if (!type) return null;
  const v = await db.aggregate(typeId, from, to, agg || type.agg);
  return v === null ? null : scaled(v, type);
}

/** Resting HR for a day, with the derived overnight-minimum fallback and source. */
async function restingFor(from, offsetMs) {
  const device = await db.aggregate('daily-resting-heart-rate', from, from + DAY_MS, 'avg');
  if (device !== null) return { value: device, source: 'device' };
  const [nightRow] = await db.series('heart-rate', from, from + 8 * HOUR_MS, DAY_MS, 'min', offsetMs);
  if (nightRow && nightRow.v !== null) return { value: nightRow.v, source: 'derived' };
  return { value: null, source: null };
}

/** HRV for a day, daily summary first, raw-sample average as the labelled fallback. */
async function hrvFor(from) {
  const daily = await db.aggregate('daily-heart-rate-variability', from, from + DAY_MS, 'avg');
  if (daily !== null) return { value: daily, source: 'device' };
  const sampled = await db.aggregate('heart-rate-variability', from, from + DAY_MS, 'avg');
  if (sampled !== null) return { value: sampled, source: 'derived' };
  return { value: null, source: null };
}

/**
 * Everything readiness needs for one morning, fetched once. `loadSeries` (ending
 * the day AFTER dayStart) supplies yesterday's strain and the typical strain.
 */
async function readinessInputs(dayStart, offsetMs, loadSeries, sleepRow, need) {
  const baseFrom = dayStart - 28 * DAY_MS;
  const [rhr, hrv, rhrBase, hrvBase, respBase, tempDev, resp] = await Promise.all([
    restingFor(dayStart, offsetMs),
    hrvFor(dayStart),
    dailyWithFallback('daily-resting-heart-rate', 'heart-rate', baseFrom, dayStart, 'min', offsetMs),
    dailyWithFallback('daily-heart-rate-variability', 'heart-rate-variability', baseFrom, dayStart, 'avg', offsetMs),
    dailyWithFallback('daily-respiratory-rate', 'respiratory-rate-sleep-summary', baseFrom, dayStart, 'avg', offsetMs),
    value('daily-sleep-temperature-derivations', dayStart, dayStart + DAY_MS, 'avg'),
    dailyWithFallback('daily-respiratory-rate', 'respiratory-rate-sleep-summary', dayStart, dayStart + DAY_MS, 'avg', offsetMs)
      .then((v) => (v.length ? v[v.length - 1] : null)),
  ]);

  const strains = loadSeries
    .filter((d) => d.load !== null && d.t < dayStart)
    .map((d) => training.strainOf(d.load));
  const yesterday = loadSeries.find((d) => d.t === dayStart - DAY_MS);

  return {
    hrv: { current: hrv.value, source: hrv.source, baseline: stats.median(hrvBase), baselineCount: hrvBase.length },
    restingHeartRate: { current: rhr.value, source: rhr.source, baseline: stats.median(rhrBase), baselineCount: rhrBase.length },
    // Hours ASLEEP, not the in-bed span — need is learned from asleep hours, so
    // the ratio must compare like with like.
    sleep: { hours: sleepRow ? sleepRow.mainAsleepHours : null, needHours: need.baseNeedHours },
    debtHours: need.debtHours,
    temperature: { deviation: tempDev },
    respiratoryRate: { current: resp, baseline: stats.median(respBase), baselineCount: respBase.length },
    yesterdayStrain: {
      value: yesterday && yesterday.load !== null ? training.strainOf(yesterday.load) : null,
      typical: stats.median(strains),
    },
    // The raw baseline arrays, so radarFor can reuse them instead of re-issuing
    // the identical queries (the module's fetch-once rule).
    baselines: { rhr: rhrBase, hrv: hrvBase, resp: respBase },
  };
}

/** Symptom-radar signals for a morning, bands from the prior 28 days. */
async function radarFor(dayStart, offsetMs, inputs) {
  const baseFrom = dayStart - 28 * DAY_MS;
  const [tempBase, spo2Base, spo2] = await Promise.all([
    trends.dailySeries('daily-sleep-temperature-derivations', baseFrom, dayStart, offsetMs, 'avg'),
    dailyWithFallback('daily-oxygen-saturation', 'oxygen-saturation', baseFrom, dayStart, 'avg', offsetMs),
    dailyWithFallback('daily-oxygen-saturation', 'oxygen-saturation', dayStart, dayStart + DAY_MS, 'avg', offsetMs)
      .then((v) => (v.length ? v[v.length - 1] : null)),
  ]);
  return scores.buildSymptomRadar([
    {
      id: 'temperature', label: 'Skin temp', unit: '°C', precision: 2,
      current: inputs.temperature.deviation,
      band: stats.personalBand(tempBase.map((r) => r.v)), direction: 'both-bad',
    },
    {
      id: 'respiratory-rate', label: 'Breathing', unit: 'br/min', precision: 1,
      current: inputs.respiratoryRate.current,
      band: stats.personalBand(inputs.baselines.resp),
      direction: 'high-bad',
    },
    {
      id: 'resting-heart-rate', label: 'Resting HR', unit: 'bpm', precision: 0,
      current: inputs.restingHeartRate.current,
      band: stats.personalBand(inputs.baselines.rhr),
      direction: 'high-bad',
    },
    {
      id: 'hrv', label: 'HRV', unit: 'ms', precision: 0,
      current: inputs.hrv.current,
      band: stats.personalBand(inputs.baselines.hrv),
      direction: 'low-bad',
    },
    {
      id: 'spo2', label: 'SpO2', unit: '%', precision: 1,
      current: spo2,
      band: stats.personalBand(spo2Base), direction: 'low-bad',
    },
  ]);
}

// ---------------------------------------------------------------------------
// TODAY
// ---------------------------------------------------------------------------

async function todayPayload(dateStr, offsetMs) {
  const date = dateStr || todayString(offsetMs);
  const [from, to] = dayRange(date, offsetMs);
  const isToday = date === todayString(offsetMs);
  const now = Date.now();
  const effectiveTo = isToday ? Math.min(to, now) : to;

  const profile = await metrics.getProfile();
  const thresholds = metrics.thresholdsFor(profile.maxHeartRate);

  const [loadSeries, nightRows, zones, hrHourly, sessionBundle, hrDayRows, hrBand] = await Promise.all([
    training.dailyLoadSeries(to, 35, offsetMs, profile),
    night.dayRows(from, to, offsetMs),
    metrics.zoneBreakdown(from, effectiveTo, { bucketMs: HOUR_MS, offsetMs, maxHr: profile.maxHeartRate, maxHrSource: profile.maxHeartRateSource }),
    db.series('heart-rate', from, effectiveTo, HOUR_MS, 'avg', offsetMs),
    training.sessionsFor(from, effectiveTo, offsetMs, profile, { detectDays: 2 }),
    db.series('heart-rate', from, effectiveTo, HR_BUCKET_MS, 'avg', offsetMs),
    db.bucketBand('heart-rate', from - HR_BAND_DAYS * DAY_MS, from, HR_BUCKET_MS, offsetMs),
  ]);
  const nightRow = nightRows[0] || null;
  const napRanges = nightRow ? nightRow.naps.map((n) => ({ start: n.start, end: n.end })) : [];
  const sessionRanges = sessionBundle.sessions.map((s) => ({ start: s.start, end: s.end }));

  const yesterdayLoad = loadSeries.find((d) => d.t === from - DAY_MS);
  const need = await night.sleepNeedFor(from, offsetMs, {
    yesterdayStrain: yesterdayLoad && yesterdayLoad.load !== null
      ? training.strainOf(yesterdayLoad.load) : null,
  });

  const inputs = await readinessInputs(from, offsetMs, loadSeries, nightRow, need);
  const readiness = scores.buildReadiness(inputs);
  const target = scores.strainTarget(readiness.score);

  const todayLoad = loadSeries.find((d) => d.t === from);
  // Strain is a COUNTER of load spent so far (the WHOOP framing): for today it
  // accumulates from the zones computed through `now`, not from the device's
  // daily point, which can restate the whole day ahead of time. A past day uses
  // the settled daily load. No zone data at all stays null — never a zero spent.
  const soFarLoad = zones.total.trackedMinutes > 0 ? zones.total.load : null;
  const settledLoad = todayLoad && todayLoad.load !== null ? todayLoad.load : null;
  const spentLoad = isToday ? (soFarLoad !== null ? soFarLoad : settledLoad) : settledLoad;
  const hourLoads = zones.buckets.map((b) => ({ t: b.t, load: b.load }));
  const hours = [];
  const hrByHour = new Map(hrHourly.map((r) => [r.t, r.v]));
  for (let t = from; t < effectiveTo; t += HOUR_MS) {
    hours.push({ t, avgHr: hrByHour.get(t) ?? null });
  }

  // Heart rate through the day. Every bucket is emitted, gaps included: a watch
  // taken off is NOT a low heart rate, so the line has to break rather than dip.
  // `lo`/`hi` are the real min and max inside each bucket — an average of 71 that
  // hides a 48–160 day is the exact shape of lie this band exists to prevent.
  const hrDay = denseBuckets(
    hrDayRows, from, effectiveTo, HR_BUCKET_MS, offsetMs,
    (t) => ({ t, v: null, lo: null, hi: null, n: 0 }),
  ).map((r) => ({
    t: r.t,
    v: r.v === null ? null : Math.round(r.v),
    lo: r.lo === null ? null : Math.round(r.lo),
    hi: r.hi === null ? null : Math.round(r.hi),
  }));
  const hrTracked = hrDay.filter((r) => r.v !== null);
  const heartRateDay = {
    available: hrTracked.length > 0,
    points: hrDay,
    unit: 'bpm',
    bucketMinutes: HR_BUCKET_MS / 60000,
    trackedMinutes: hrTracked.length * (HR_BUCKET_MS / 60000),
    min: hrTracked.length ? Math.min(...hrTracked.map((r) => r.lo)) : null,
    max: hrTracked.length ? Math.max(...hrTracked.map((r) => r.hi)) : null,
    // The band is the viewer's OWN recent distribution, never a population norm.
    refBand: hrBand ? { ...hrBand, days: HR_BAND_DAYS } : null,
    restingHeartRate: round(inputs.restingHeartRate.current, 0),
    zone3Bpm: thresholds[1],
    derived: false,
    method: `Measured heart rate averaged into ${HR_BUCKET_MS / 60000}-minute buckets; `
      + 'the shaded range is the lowest and highest reading inside each bucket. '
      + (hrBand
        ? `Your own p10–p90 over the prior ${HR_BAND_DAYS} days sits behind it, `
          + 'measured at the same bucket size.'
        : `Not enough of the prior ${HR_BAND_DAYS} days to show your usual range yet.`),
    limitation: 'Gaps are hours the watch was not measuring — not a resting heart rate.',
  };

  const stress = scores.buildStressTimeline({
    hours,
    restingHr: inputs.restingHeartRate.current,
    zone3Bpm: thresholds[1],
    sessionRanges,
    napRanges,
  });

  const sleepRatio = nightRow && nightRow.mainAsleepHours !== null && need.baseNeedHours
    ? nightRow.mainAsleepHours / need.baseNeedHours : null;
  const battery = scores.buildBattery({
    wakeMs: nightRow && nightRow.main ? nightRow.main.end : null,
    sleepRatio,
    efficiencyPercent: nightRow ? nightRow.efficiencyPercent : null,
    stress,
    hourLoads,
    napRanges,
    nowMs: effectiveTo,
    dayStart: from,
  });

  const forecast = scores.buildEnergyForecast({
    wakeMs: nightRow && nightRow.main ? nightRow.main.end : null,
    needHours: need.tonightNeedHours,
    debtHours: need.debtHours,
    dayStart: from,
    nowMs: now,
  });

  const baseFrom = from - 28 * DAY_MS;
  const [stepsBase, calBase, steps, distance, activeCal, azm] = await Promise.all([
    trends.dailySeries('steps', baseFrom, from, offsetMs),
    trends.dailySeries('active-energy-burned', baseFrom, from, offsetMs),
    value('steps', from, to),
    value('distance', from, to),
    value('active-energy-burned', from, to),
    value('active-zone-minutes', from, to),
  ]);
  const adaptive = goals.buildAdaptiveGoals({
    stepsMedian: stats.median(stepsBase.map((r) => r.v)),
    activeCalMedian: stats.median(calBase.map((r) => r.v)),
    readinessScore: readiness.score,
    tonightNeedHours: need.tonightNeedHours,
  });
  const rings = goals.buildRings(adaptive, {
    activeCalories: activeCal,
    activeZoneMinutes: azm,
    sleepHours: nightRow ? nightRow.mainAsleepHours : null,
  });

  const [radar, highlights, pai] = await Promise.all([
    radarFor(from, offsetMs, inputs),
    trends.highlightsFor(offsetMs),
    Promise.resolve(scores.buildWeeklyIntensity(loadSeries.filter((d) => d.t <= from))),
  ]);

  const localWeekday = new Date(from + offsetMs).getUTCDay();

  return {
    view: 'today',
    date,
    isToday,
    timezoneOffsetMinutes: offsetMs / 60000,
    range: { from, to, through: effectiveTo },
    profile,
    readiness,
    strain: {
      today: spentLoad !== null ? training.strainOf(spentLoad) : null,
      load: spentLoad,
      spentSoFar: isToday,
      target,
      source: isToday && soFarLoad !== null ? 'computed-so-far'
        : todayLoad ? todayLoad.source : null,
      max: 21,
      derived: true,
      method: training.STRAIN_METHOD,
    },
    battery,
    stress,
    heartRateDay,
    forecast,
    pai,
    rings,
    goals: adaptive,
    sleepStrip: nightRow ? {
      mainHours: nightRow.mainHours,
      asleepHours: nightRow.mainAsleepHours,
      needHours: need.tonightNeedHours,
      debtHours: need.debtHours,
      efficiencyPercent: nightRow.efficiencyPercent,
      wakeMs: nightRow.main ? nightRow.main.end : null,
      naps: nightRow.naps,
    } : {
      mainHours: null,
      asleepHours: null,
      needHours: need.tonightNeedHours,
      debtHours: need.debtHours,
      efficiencyPercent: null,
      wakeMs: null,
      naps: [],
    },
    radar,
    highlights: highlights.cards.slice(0, 2),
    stats: {
      steps: round(steps, 0),
      stepsGoal: adaptive.steps.goal,
      distanceKm: round(distance, 2),
      activeCalories: round(activeCal, 0),
      activeZoneMinutes: round(azm, 0),
      restingHeartRate: round(inputs.restingHeartRate.current, 0),
      restingSource: inputs.restingHeartRate.source,
      hrv: round(inputs.hrv.current, 0),
      hrvSource: inputs.hrv.source,
    },
    mondayReport: localWeekday === 1,
  };
}

// ---------------------------------------------------------------------------
// SLEEP
// ---------------------------------------------------------------------------

async function sleepScreenPayload(dateStr, offsetMs) {
  const date = dateStr || todayString(offsetMs);
  const [from, to] = dayRange(date, offsetMs);

  const [rows7, needToday, detail] = await Promise.all([
    night.dayRows(to - 7 * DAY_MS, to, offsetMs),
    night.sleepNeedFor(from, offsetMs),
    // The staged timeline for the hypnogram comes from the legacy helper — same
    // parse, same shape the old sleep screen proved out.
    require('./views').sleepForDay(from, to, offsetMs),
  ]);
  const nightRow = rows7[rows7.length - 1] || null;

  const mains = rows7.filter((r) => r.main).map((r) => r.main);
  const consistency = night.buildConsistency(mains, offsetMs);
  const dip = await night.hrDipFor(nightRow ? nightRow.main : null, from);

  const [tempBand, monthRows] = await Promise.all([
    trends.bandSeriesFor('daily-sleep-temperature-derivations', 14, offsetMs, { agg: 'avg' }),
    (async () => {
      const local = new Date(from + offsetMs);
      const monthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offsetMs;
      return night.dayRows(monthStart, Math.min(monthStart + 31 * DAY_MS, to), offsetMs);
    })(),
  ]);
  const pattern = night.buildMonthPattern(monthRows, offsetMs);

  const napsWeek = rows7.flatMap((r) => r.naps.map((n) => ({ ...n, day: r.t })));

  return {
    view: 'sleep',
    date,
    timezoneOffsetMinutes: offsetMs / 60000,
    night: detail, // hoursAsleep, hoursInBed, efficiency, stages, timeline, bedtime, wakeTime
    naps: nightRow ? nightRow.naps : [],
    napsWeek,
    need: needToday,
    consistency,
    heartRateDip: dip,
    temperature: tempBand,
    trend: rows7.map((r) => ({
      t: r.t,
      mainHours: r.mainHours,
      hoursInBed: r.hoursInBed,
      efficiencyPercent: r.efficiencyPercent,
      stageHours: r.stageHours,
      naps: r.naps.length,
    })),
    pattern,
    goalHours: needToday.tonightNeedHours ?? catalog.get('sleep').goal,
  };
}

// ---------------------------------------------------------------------------
// TRAIN
// ---------------------------------------------------------------------------

async function trainPayload(offsetMs) {
  const today = dayRange(todayString(offsetMs), offsetMs)[0];
  const now = Date.now();
  const profile = await metrics.getProfile();

  const loadSeries = await training.dailyLoadSeries(today + DAY_MS, 120, offsetMs, profile);
  const model = training.buildLoadModel(loadSeries);

  // Corridor width listens to this morning's readiness (a run-down body earns a
  // smaller ceiling); the full 14-day average would cost 14 baseline rebuilds.
  const nightRows = await night.dayRows(today, today + DAY_MS, offsetMs);
  const need = await night.sleepNeedFor(today, offsetMs);
  const inputs = await readinessInputs(today, offsetMs, loadSeries, nightRows[0] || null, need);
  const readiness = scores.buildReadiness(inputs);
  const corridor = training.buildCorridor(model, { readinessAvg: readiness.score });

  const sessionBundle = await training.sessionsFor(today - 14 * DAY_MS, now, offsetMs, profile, { detectDays: 7 });
  const latest = sessionBundle.sessions[0] || null;

  const countdown = training.buildRecoveryCountdown({
    lastSession: latest ? { end: latest.end, load: latest.load } : null,
    readinessScore: readiness.score,
    nowMs: now,
  });

  const records = await training.recordsFor(offsetMs, profile, loadSeries);

  const [strengthRows, stepsYear] = await Promise.all([
    db.strengthList(now - 60 * DAY_MS, now),
    trends.dailySeries('steps', today - 365 * DAY_MS, today + DAY_MS, offsetMs),
  ]);
  const streak = goals.longestStreak(stepsYear.map((r) => r.v), 10000);
  if (streak >= 7) {
    records.push({
      id: 'streak', label: 'Longest 10k-step streak', value: streak, unit: 'days', atMs: null, window: 'last 12 months',
    });
  }

  const weeks = [];
  for (let i = 8; i >= 1; i--) {
    const start = today - (i * 7 - 1) * DAY_MS;
    const slice = loadSeries.filter((d) => d.t >= start && d.t < start + 7 * DAY_MS && d.load !== null);
    weeks.push({
      t: start,
      load: slice.length ? Math.round(slice.reduce((a, d) => a + d.load, 0)) : null,
    });
  }

  return {
    view: 'train',
    timezoneOffsetMinutes: offsetMs / 60000,
    profile,
    zoneTable: metrics.zoneTable(profile.maxHeartRate),
    latestSession: latest,
    sessions: sessionBundle.sessions,
    sessionsMethod: sessionBundle.method,
    sessionsLimitation: sessionBundle.limitation,
    countdown,
    corridor,
    loadModel: {
      current: model.current,
      series: model.series.filter((d) => d.t >= today - 90 * DAY_MS),
      method: model.method,
      limitation: model.limitation,
      derived: true,
    },
    season: {
      cells: loadSeries.map((d) => ({ t: d.t, v: d.load })),
      // quantile() drops nulls itself; a truthiness filter here would also drop
      // measured load-0 rest days and compute the scale from training days only.
      thresholds: [0.2, 0.4, 0.6, 0.8]
        .map((q) => stats.quantile(loadSeries.map((d) => d.load), q))
        .map((v) => round(v, 0)),
    },
    weeklyLoad: weeks,
    records,
    strength: {
      entries: strengthRows.map((r) => ({
        ...r,
        muscularIndex: training.muscularIndex(r.volume_kg),
      })),
      method: 'Muscular volume index = 6·log10(1 + kg-volume/100), capped at 30 — kept beside cardio load, never summed into it.',
    },
    readinessScore: readiness.score,
  };
}

// ---------------------------------------------------------------------------
// TRENDS
// ---------------------------------------------------------------------------

const COMPARE_METRICS = ['heart-rate', 'steps'];

async function compareSide(dateStr, metric, offsetMs, { hourly = false } = {}) {
  const [from, to] = dayRange(dateStr, offsetMs);
  const effTo = Math.min(to, Date.now());
  const profile = await metrics.getProfile();
  const [zones, sleepRows] = await Promise.all([
    metrics.zoneBreakdown(from, effTo, { bucketMs: 0, offsetMs, maxHr: profile.maxHeartRate, maxHrSource: profile.maxHeartRateSource }),
    night.dayRows(from, to, offsetMs),
  ]);
  const [steps, distance, azm, activeCal, rhr, hrv] = await Promise.all([
    value('steps', from, to),
    value('distance', from, to),
    value('active-zone-minutes', from, to),
    value('active-energy-burned', from, to),
    restingFor(from, offsetMs).then((r) => r.value),
    hrvFor(from).then((r) => r.value),
  ]);
  // Against a "typical" ghost the ghost is hourly, so this side must be hourly
  // too — mixing a 2-minute trace with hourly medians would misalign every point.
  let curve;
  if (metric === 'steps' || hourly) {
    const agg = metric === 'steps' ? 'sum' : 'avg';
    const rows = await db.series(metric, from, effTo, HOUR_MS, agg, offsetMs);
    const byT = new Map(rows.map((r) => [r.t, r.v]));
    curve = [];
    for (let t = from; t < effTo; t += HOUR_MS) {
      const v = byT.get(t);
      curve.push({ t, v: v === undefined || v === null ? null : Math.round(v * 10) / 10 });
    }
    return finishSide(dateStr, curve, HOUR_MS, { steps, distance, azm, activeCal, rhr, hrv, sleepRows, zones });
  }
  const trace = await db.heartRateTrace(from, effTo, 360);
  return finishSide(dateStr, trace.points, trace.bucketMs, { steps, distance, azm, activeCal, rhr, hrv, sleepRows, zones });
}

function finishSide(dateStr, curve, bucketMs, { steps, distance, azm, activeCal, rhr, hrv, sleepRows, zones }) {
  return {
    date: dateStr,
    curve,
    // The curve's real bucket size, so a client can align two days by TIME rather
    // than by array index — the traces are sparse and differently bucketed.
    bucketMs,
    metrics: {
      steps: round(steps, 0),
      distanceKm: round(distance, 2),
      activeZoneMinutes: round(azm, 0),
      activeCalories: round(activeCal, 0),
      sleepHours: sleepRows[0] ? sleepRows[0].mainAsleepHours : null,
      restingHeartRate: round(rhr, 0),
      hrv: round(hrv, 0),
      strain: training.strainOf(zones.total.load),
    },
  };
}

async function trendsPayload(offsetMs, { a, b, metric, heatType } = {}) {
  const today = todayString(offsetMs);
  const dateA = a || today;
  const compareMetric = COMPARE_METRICS.includes(metric) ? metric : 'heart-rate';
  const heat = catalog.get(heatType) ? heatType : 'steps';

  const [fromA] = dayRange(dateA, offsetMs);
  const weekdayA = new Date(fromA + offsetMs).getUTCDay();

  const vsTypical = !b || b === 'typical';
  const sideA = await compareSide(dateA, compareMetric, offsetMs, { hourly: vsTypical });
  let sideB = null;
  let typical = null;
  if (!vsTypical) {
    sideB = await compareSide(b, compareMetric, offsetMs);
  } else {
    typical = await trends.typicalDayFor(weekdayA, compareMetric, offsetMs);
  }

  const profile = await metrics.getProfile();
  const loadSeries = await training.dailyLoadSeries(dayRange(today, offsetMs)[0] + DAY_MS, 42, offsetMs, profile);
  const loadByDay = new Map(loadSeries.map((d) => [d.t, d.load]));
  const model = training.buildLoadModel(loadSeries);

  const [verdicts, heatData, correlations, weekly] = await Promise.all([
    trends.verdictsFor(offsetMs),
    trends.heatFor(heat, 8, offsetMs),
    trends.correlationsFor(offsetMs),
    trends.weeklyReportFor(dayRange(today, offsetMs)[0], offsetMs, {
      loadByDay,
      fitness: model.current ? model.current.fitness : null,
    }),
  ]);

  return {
    view: 'trends',
    timezoneOffsetMinutes: offsetMs / 60000,
    compare: {
      metric: compareMetric,
      metricOptions: COMPARE_METRICS,
      a: sideA,
      b: sideB,
      typical,
      method: 'Two days on one axis; “typical” is the hourly median with a p25–p75 band over your last six same-weekdays.',
    },
    verdicts,
    heat: heatData,
    heatOptions: ['steps', 'sleep', 'active-zone-minutes'],
    correlations,
    weeklyReport: weekly,
  };
}

// ---------------------------------------------------------------------------
// YOU
// ---------------------------------------------------------------------------

async function youPayload(offsetMs) {
  const today = dayRange(todayString(offsetMs), offsetMs)[0];
  const profile = await metrics.getProfile();
  const goalHours = catalog.get('sleep').goal;

  const fitnessAge = await insights.fitnessAgeOutlook(today, offsetMs, profile, goalHours);

  // The 12-month arc: the same estimator evaluated at each month-end. Expensive-ish
  // (a dozen windows) but every window is an indexed daily aggregate.
  const arc = [];
  for (let m = 11; m >= 1; m--) {
    const at = today - m * 30 * DAY_MS;
    const est = await insights.fitnessAgeOutlook(at, offsetMs, profile, goalHours);
    arc.push({ t: at, estimate: est.estimate });
  }
  arc.push({ t: today, estimate: fitnessAge.estimate });

  // Resilience from cheap dailies: sleep-vs-need ratio and the HRV trend. The
  // stress share needs intraday scans and is passed as unknown — the builder
  // treats unknown as "contributes nothing", never as calm.
  const need = await night.sleepNeedFor(today, offsetMs);
  const nights14 = await night.nightHours(today - 14 * DAY_MS, today + DAY_MS, offsetMs);
  const hrv14 = await dailyWithFallback('daily-heart-rate-variability', 'heart-rate-variability', today - 14 * DAY_MS, today + DAY_MS, 'avg', offsetMs);
  const hrvPrior = await dailyWithFallback('daily-heart-rate-variability', 'heart-rate-variability', today - 28 * DAY_MS, today - 14 * DAY_MS, 'avg', offsetMs);
  const hrvTrend = stats.median(hrv14) !== null && stats.median(hrvPrior)
    ? ((stats.median(hrv14) - stats.median(hrvPrior)) / stats.median(hrvPrior)) * 100 : null;
  const resilience = scores.buildResilience({
    stressShareAvg: null,
    sleepRatioAvg: need.baseNeedHours ? stats.mean(nights14) / need.baseNeedHours : null,
    hrvTrendPercent: hrvTrend,
    coveredDays: Math.max(nights14.length, hrv14.length),
  });

  // Radar history: bands recomputed per morning from the preceding 28 days, all
  // from four prefetched windows — no per-day queries.
  const histFrom = today - 42 * DAY_MS;
  const [tempH, respH, rhrH, hrvH, spo2H] = await Promise.all([
    trends.dailySeries('daily-sleep-temperature-derivations', histFrom, today + DAY_MS, offsetMs, 'avg'),
    trends.dailySeries('daily-respiratory-rate', histFrom, today + DAY_MS, offsetMs, 'avg'),
    trends.dailySeries('daily-resting-heart-rate', histFrom, today + DAY_MS, offsetMs, 'avg'),
    trends.dailySeries('daily-heart-rate-variability', histFrom, today + DAY_MS, offsetMs, 'avg'),
    trends.dailySeries('daily-oxygen-saturation', histFrom, today + DAY_MS, offsetMs, 'avg'),
  ]);
  const seriesAll = { temperature: tempH, 'respiratory-rate': respH, 'resting-heart-rate': rhrH, hrv: hrvH, spo2: spo2H };
  const radarHistory = [];
  for (let i = 28; i < tempH.length; i++) {
    const dayT = tempH[i].t;
    const sig = (id, label, unit, precision, direction, rows) => ({
      id,
      label,
      unit,
      precision,
      direction,
      current: rows[i] ? rows[i].v : null,
      band: stats.personalBand(rows.slice(i - 28, i).map((r) => r.v)),
    });
    const radar = scores.buildSymptomRadar([
      sig('temperature', 'Skin temp', '°C', 2, 'both-bad', seriesAll.temperature),
      sig('respiratory-rate', 'Breathing', 'br/min', 1, 'high-bad', seriesAll['respiratory-rate']),
      sig('resting-heart-rate', 'Resting HR', 'bpm', 0, 'high-bad', seriesAll['resting-heart-rate']),
      sig('hrv', 'HRV', 'ms', 0, 'low-bad', seriesAll.hrv),
      sig('spo2', 'SpO2', '%', 1, 'low-bad', seriesAll.spo2),
    ]);
    radarHistory.push({ t: dayT, level: radar.level, flagged: radar.flaggedCount });
  }
  const radarToday = radarHistory[radarHistory.length - 1] || null;

  // Quarterly review: this quarter against the previous one.
  const local = new Date(today + offsetMs);
  const qStartMonth = Math.floor(local.getUTCMonth() / 3) * 3;
  const qStart = Date.UTC(local.getUTCFullYear(), qStartMonth, 1) - offsetMs;
  const prevQStart = Date.UTC(local.getUTCFullYear(), qStartMonth - 3, 1) - offsetMs;
  const quarter = async (fromQ, toQ) => ({
    ...(await trends.periodAggregates(fromQ, toQ, offsetMs, null)),
    vo2max: await value('daily-vo2-max', fromQ, toQ, 'max'),
    weight: await value('weight', fromQ, toQ, 'last'),
    deep: await db.stackedSeries('sleep', fromQ, toQ, DAY_MS, offsetMs).then((parts) => {
      const deeps = parts.filter((p) => p.key === 'DEEP').map((p) => p.v / HOUR_MS);
      return stats.mean(deeps);
    }),
  });
  const [curQ, prevQ] = await Promise.all([quarter(qStart, today + DAY_MS), quarter(prevQStart, qStart)]);
  const qRow = (id, label, unit, precision, cur, prev, upIsGood) => ({
    id,
    label,
    unit,
    value: round(cur, precision),
    prior: round(prev, precision),
    delta: cur !== null && prev !== null ? round(cur - prev, precision) : null,
    good: cur === null || prev === null || Math.abs(cur - prev) < 1e-9 ? null
      : (cur > prev) === upIsGood,
  });
  const quarterly = {
    quarterStart: qStart,
    rows: [
      qRow('vo2max', 'VO2 max', 'ml/kg/min', 1, curQ.vo2max, prevQ.vo2max, true),
      qRow('rhr', 'Resting HR', 'bpm', 0, curQ.rhrAvg, prevQ.rhrAvg, false),
      qRow('hrv', 'HRV', 'ms', 0, curQ.hrvAvg, prevQ.hrvAvg, true),
      qRow('sleep', 'Sleep / night', 'h', 2, curQ.sleepAvg, prevQ.sleepAvg, true),
      qRow('deep', 'Deep sleep', 'h', 2, curQ.deep, prevQ.deep, true),
      qRow('weight', 'Weight', 'kg', 1, curQ.weight, prevQ.weight, false),
      qRow('steps', 'Steps / day', '', 0, curQ.stepsAvg, prevQ.stepsAvg, true),
    ].filter((r) => r.value !== null),
    derived: true,
    method: 'This calendar quarter against the previous one; weight compares latest readings, VO2 max compares bests.',
  };

  // Badges from lifetime totals.
  const statsRows = await db.typeStats();
  const firstMs = (id) => {
    const s = statsRows.find((x) => x.data_type === id);
    return s ? s.first_ms : null;
  };
  const lifetime = async (id, factor = 1) => {
    const first = firstMs(id);
    if (first === null) return null;
    const v = await db.aggregate(id, first, Date.now(), 'sum');
    return v === null ? null : v * factor;
  };
  const sleepDays = await (async () => {
    const first = firstMs('sleep');
    if (first === null) return null;
    const rows = await db.series('sleep', first, Date.now(), DAY_MS, 'sum', offsetMs);
    return rows.filter((r) => r.v !== null).length;
  })();
  const badges = goals.buildBadges({
    distance: await lifetime('distance', 1e-6),
    steps: await lifetime('steps'),
    floors: await lifetime('floors'),
    sessions: (statsRows.find((x) => x.data_type === 'exercise') || {}).points ?? null,
    nights: sleepDays,
  });

  const lifetimeRecords = await training.lifetimeRecordsFor(offsetMs);

  return {
    view: 'you',
    timezoneOffsetMinutes: offsetMs / 60000,
    profile,
    fitnessAge,
    fitnessAgeArc: arc,
    resilience,
    radar: { today: radarToday, history: radarHistory },
    quarterly,
    lifetimeRecords,
    badges,
  };
}

// ---------------------------------------------------------------------------
// Calendar (the date-jump overlay)
// ---------------------------------------------------------------------------

/** Data-richness dots for one local month: which days have anything to show. */
async function calendarPayload(monthStr, offsetMs) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr || '');
  const local = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)
    : (() => { const d = new Date(Date.now() + offsetMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); })();
  const from = local - offsetMs;
  const to = Date.UTC(new Date(local).getUTCFullYear(), new Date(local).getUTCMonth() + 1, 1) - offsetMs;

  const [steps, sleep, sessions] = await Promise.all([
    trends.dailySeries('steps', from, to, offsetMs),
    trends.dailySeries('sleep', from, to, offsetMs),
    db.series('exercise', from, to, DAY_MS, 'sum', offsetMs),
  ]);
  const sessionByT = new Map(sessions.map((r) => [r.t, r.n]));
  return {
    month: new Date(local).toISOString().slice(0, 7),
    from,
    days: steps.map((r, i) => ({
      t: r.t,
      hasSteps: r.v !== null,
      hasSleep: sleep[i] ? sleep[i].v !== null : false,
      sessions: sessionByT.get(r.t) || 0,
    })),
  };
}

module.exports = {
  todayPayload, sleepScreenPayload, trainPayload, trendsPayload, youPayload,
  calendarPayload,
};
