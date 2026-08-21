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
 * comes from `220 - age`, and the age is READ FROM THE GOOGLE ACCOUNT rather than
 * typed in: the same account that supplies the heart rate already knows how old its
 * owner is, and a number the user has to remember to update is a number that silently
 * goes stale and shifts every zone boundary with it. Sync stores it; this file only
 * reads the stored value, so the dashboard still never waits on Google.
 *
 * CARDIO LOAD is Edwards' TRIMP: minutes in each zone multiplied by that zone's
 * weight, summed. It is a standard, explainable training-load figure rather than an
 * imitation of Whoop's proprietary 0–21 strain score — claiming the latter would
 * imply a scale this cannot actually reproduce.
 */

const db = require('./db');

// Used only until the first profile sync lands — every payload that leans on it
// reports `ageSource: 'default'` so a reader can tell an assumption from a fact.
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

const validAge = (n) => Number.isFinite(n) && n > 5 && n < 120;

/**
 * The stored age, or the fallback. Returns the source too, because a caller that
 * cannot distinguish "Google says 30" from "nobody has told us, assume 30" will
 * happily present the assumption as a measurement.
 */
async function ageWithSource() {
  const n = Number(await db.getSetting('age', ''));
  if (!validAge(n)) return { age: DEFAULT_AGE, source: 'default', syncedMs: null };
  const synced = Number(await db.getSetting('age_synced_ms', ''));
  return {
    age: n,
    source: (await db.getSetting('age_source', '')) || 'google',
    syncedMs: Number.isFinite(synced) && synced > 0 ? synced : null,
  };
}

async function getAge() {
  return (await ageWithSource()).age;
}

/**
 * Record the age the account reports. Called by sync, never by a request handler —
 * this value is not a user preference and there is no endpoint that writes it.
 *
 * An out-of-range figure is DROPPED rather than stored: the previous known-good age
 * is a better input to every zone boundary than a value the API should not have sent.
 */
async function setAge(age, source = 'google') {
  const n = Number(age);
  if (!validAge(n)) {
    throw Object.assign(new Error('age must be between 5 and 120'), { status: 400 });
  }
  const rounded = Math.round(n);
  await db.setSetting('age', String(rounded));
  await db.setSetting('age_source', source);
  await db.setSetting('age_synced_ms', String(Date.now()));
  return rounded;
}

const maxHeartRate = (age) => 220 - age;

async function getProfile() {
  const { age, source, syncedMs } = await ageWithSource();
  const estimatedMaxHeartRate = maxHeartRate(age);
  const raw = await db.getSetting('maxHeartRate', '');
  const manual = Number(raw);
  const hasManual = Number.isFinite(manual) && manual >= 100 && manual <= 240;
  return {
    age,
    ageSource: source,
    ageSyncedMs: syncedMs,
    estimatedMaxHeartRate,
    maxHeartRate: hasManual ? Math.round(manual) : estimatedMaxHeartRate,
    maxHeartRateSource: hasManual ? 'manual' : 'age-estimate',
  };
}

/**
 * Update the physiological inputs the user actually owns — which is max HR alone.
 *
 * Age is deliberately NOT patchable: it comes from the Google account, and accepting
 * a typed value here would let a stale hand-entered number win over the account until
 * someone noticed the zones had drifted. `null`/empty max HR clears the override and
 * returns to the age estimate.
 */
async function setProfile(patch) {
  const next = {};
  if (Object.hasOwn(patch, 'maxHeartRate')) {
    if (patch.maxHeartRate === null || patch.maxHeartRate === '') {
      next.maxHeartRate = '';
    } else {
      const maxHr = Number(patch.maxHeartRate);
      if (!Number.isFinite(maxHr) || maxHr < 100 || maxHr > 240) {
        throw Object.assign(new Error('maxHeartRate must be between 100 and 240, or null'), { status: 400 });
      }
      next.maxHeartRate = Math.round(maxHr);
    }
  }

  if (Object.hasOwn(next, 'maxHeartRate')) await db.setSetting('maxHeartRate', next.maxHeartRate);
  return getProfile();
}

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
async function zoneBreakdown(fromMs, toMs, {
  bucketMs = 0, offsetMs = 0, maxHr, maxHrSource = 'age-estimate',
} = {}) {
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
    // The method must state where max HR actually came from — claiming "220 − age"
    // over a manual override would misdescribe every zone boundary.
    method: `Edwards TRIMP over Whoop-style %maxHR bands; max HR = ${
      maxHrSource === 'manual' ? 'manual override' : '220 − age'}`,
  };
}

module.exports = {
  ZONES, DEFAULT_AGE,
  getAge, setAge, ageWithSource, getProfile, setProfile,
  maxHeartRate, thresholdsFor, zoneTable, cardioLoad, zoneBreakdown,
};
