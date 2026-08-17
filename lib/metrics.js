'use strict';
/**
 * Derived metrics — the numbers Google Health does NOT send.
 *
 * Cardio load and heart-rate zones are not data types in the API. Fitbit shows them
 * in its own app; the API exposes neither, so they are computed here from the raw
 * heart-rate stream. Everything in this file is therefore DERIVED, and every payload
 * that carries these values says so — passing a computed training load off as the
 * device's own figure would be the kind of quiet fiction a health dashboard must not
 * commit.
 *
 * ZONES follow the Whoop convention: six bands of percentage-of-max-heart-rate.
 * Which makes max HR load-bearing — get it wrong and every boundary shifts — so it
 * comes from `220 - age` with the age stored in settings, not guessed from the data.
 *
 * CARDIO LOAD is Edwards' TRIMP: minutes in each zone multiplied by that zone's
 * weight, summed. It is a standard, explainable training-load figure rather than an
 * imitation of Whoop's proprietary 0–21 strain score — claiming the latter would
 * imply a scale this cannot actually reproduce.
 */

const db = require('./db');

const DEFAULT_AGE = 30;

/** Whoop-style bands, as fractions of max HR. Six zones, so five boundaries. */
const ZONE_FRACTIONS = [0.5, 0.6, 0.7, 0.8, 0.9];

const ZONES = [
  { zone: 1, label: 'Zone 1', range: '< 50%', note: 'Rest / very light', weight: 0 },
  { zone: 2, label: 'Zone 2', range: '50–60%', note: 'Light', weight: 1 },
  { zone: 3, label: 'Zone 3', range: '60–70%', note: 'Moderate', weight: 2 },
  { zone: 4, label: 'Zone 4', range: '70–80%', note: 'Vigorous', weight: 3 },
  { zone: 5, label: 'Zone 5', range: '80–90%', note: 'Hard', weight: 4 },
  { zone: 6, label: 'Zone 6', range: '90%+', note: 'Max', weight: 5 },
];

async function getAge() {
  const raw = await db.getSetting('age', '');
  const n = Number(raw);
  return Number.isFinite(n) && n > 5 && n < 120 ? n : DEFAULT_AGE;
}

async function setAge(age) {
  const n = Number(age);
  if (!Number.isFinite(n) || n < 5 || n > 120) {
    throw Object.assign(new Error('age must be between 5 and 120'), { status: 400 });
  }
  await db.setSetting('age', String(Math.round(n)));
  return Math.round(n);
}

const maxHeartRate = (age) => 220 - age;

function thresholdsFor(maxHr) {
  return ZONE_FRACTIONS.map((f) => Math.round(maxHr * f));
}

/** Zone definitions with the actual bpm boundaries filled in, for the UI legend. */
function zoneTable(maxHr) {
  const t = thresholdsFor(maxHr);
  return ZONES.map((z, i) => ({
    ...z,
    fromBpm: i === 0 ? 0 : t[i - 1],
    toBpm: i === ZONES.length - 1 ? null : t[i],
  }));
}

/**
 * Edwards' TRIMP. `minutesByZone` is indexed by zone number (1-based).
 * Zone 1 carries weight 0 on purpose: sitting still for eight hours is not training
 * load, and weighting it would make a sedentary day outscore a workout.
 */
function cardioLoad(minutesByZone) {
  let load = 0;
  for (const z of ZONES) load += (minutesByZone[z.zone] || 0) * z.weight;
  return Math.round(load);
}

/**
 * Zone minutes and cardio load over a window, optionally bucketed (hourly, daily).
 * Returns { total: {minutes, load}, buckets: [{t, minutes, load}] }.
 */
async function zoneBreakdown(fromMs, toMs, { bucketMs = 0, offsetMs = 0, maxHr } = {}) {
  const rows = await db.heartRateZones(fromMs, toMs, thresholdsFor(maxHr), bucketMs, offsetMs);

  const byBucket = new Map();
  const totalMinutes = {};
  for (const r of rows) {
    const minutes = r.ms / 60000;
    totalMinutes[r.zone] = (totalMinutes[r.zone] || 0) + minutes;
    if (!byBucket.has(r.t)) byBucket.set(r.t, {});
    byBucket.get(r.t)[r.zone] = (byBucket.get(r.t)[r.zone] || 0) + minutes;
  }

  const round1 = (v) => Number(v.toFixed(1));
  const buckets = [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([t, mins]) => {
    const minutes = {};
    for (const z of ZONES) minutes[z.zone] = round1(mins[z.zone] || 0);
    return { t, minutes, load: cardioLoad(mins) };
  });

  const minutes = {};
  for (const z of ZONES) minutes[z.zone] = round1(totalMinutes[z.zone] || 0);

  return {
    maxHeartRate: maxHr,
    zones: zoneTable(maxHr),
    total: {
      minutes,
      load: cardioLoad(totalMinutes),
      // Time the watch actually reported a heart rate — the denominator for
      // "how much of the day is this based on".
      trackedMinutes: round1(Object.values(totalMinutes).reduce((a, b) => a + b, 0)),
    },
    buckets,
    derived: true,
    method: 'Edwards TRIMP over Whoop-style %maxHR bands; max HR = 220 − age',
  };
}

module.exports = {
  ZONES, ZONE_FRACTIONS, DEFAULT_AGE,
  getAge, setAge, maxHeartRate, thresholdsFor, zoneTable, cardioLoad, zoneBreakdown,
};
