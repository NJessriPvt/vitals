'use strict';
/**
 * The data-type catalog — the one place that knows how each Google Health data
 * type is named, filtered, aggregated and drawn.
 *
 * Three naming forms exist for the SAME type and mixing them up is the single
 * easiest way to get a 400 back:
 *
 *   id      kebab-case   used in the URL path     .../dataTypes/body-fat/dataPoints
 *   snake   snake_case   used inside `filter`     body_fat.sample_time.physical_time >= "..."
 *   payload camelCase    the key inside a dataPoint JSON body   { "bodyFat": {...} }
 *
 * (The kebab/snake split is documented; the camelCase payload key is proto3-JSON
 * convention. normalize.js does not trust it — it tries all three and then falls
 * back to "the one key that isn't name/dataSource" — but the hint makes the common
 * case exact instead of heuristic.)
 *
 * recordType decides the FILTER FIELD, which is not guessable per type:
 *   INTERVAL -> <snake>.interval.start_time        (steps, distance, calories)
 *   SAMPLE   -> <snake>.sample_time.physical_time  (heart rate, weight, SpO2)
 *   DAILY    -> <snake>.date                       (pre-rolled daily summaries)
 *   SESSION  -> <snake>.interval.end_time          (sleep, exercise)
 *
 * maxDays is the API's documented maximum query range and it is NOT uniform: four
 * high-cardinality types cap at 14 days, everything else at 90. Ask for more and the
 * request fails, so the sync engine chunks against this number.
 */

const INTERVAL = 'INTERVAL';
const SAMPLE = 'SAMPLE';
const DAILY = 'DAILY';
const SESSION = 'SESSION';

// OAuth scope groups. Ask only for what the enabled types need — the consent screen
// lists every scope, and a wall of them is how a user decides not to click Allow.
const SCOPE_BASE = 'https://www.googleapis.com/auth/googlehealth';
const SCOPES = {
  activity: `${SCOPE_BASE}.activity_and_fitness.readonly`,
  metrics: `${SCOPE_BASE}.health_metrics_and_measurements.readonly`,
  sleep: `${SCOPE_BASE}.sleep.readonly`,
  nutrition: `${SCOPE_BASE}.nutrition.readonly`,
  profile: `${SCOPE_BASE}.profile.readonly`,
  settings: `${SCOPE_BASE}.settings.readonly`,
  ecg: `${SCOPE_BASE}.ecg.readonly`,
  irn: `${SCOPE_BASE}.irn.readonly`,
  location: `${SCOPE_BASE}.location.readonly`,
};

/**
 * agg is how MANY points collapse into ONE bucket, and it is a property of the
 * measurement, not a UI preference:
 *   sum  — the quantity accumulates over the bucket (steps, calories, distance)
 *   avg  — the quantity is a level sampled through the bucket (heart rate, SpO2)
 *   last — the quantity is a standing value; the newest reading wins (weight, height)
 *   max  — peak matters (VO2 max)
 * Summing a heart rate produces a number that means nothing, so this is not
 * configurable from the UI.
 */
const TYPES = [
  // ---- Activity -------------------------------------------------------------
  {
    id: 'steps', snake: 'steps', payload: 'steps', label: 'Steps',
    group: 'Activity', recordType: INTERVAL, maxDays: 90, scope: 'activity',
    unit: 'steps', agg: 'sum', chart: 'bar', precision: 0, primary: true,
    valueFields: ['count', 'countSum', 'steps', 'value'],
    goal: 10000,
  },
  {
    id: 'distance', snake: 'distance', payload: 'distance', label: 'Distance',
    group: 'Activity', recordType: INTERVAL, maxDays: 90, scope: 'activity',
    // The API's standard unit is MILLIMETRES. Storing raw and scaling at the edge
    // keeps the DB in the API's units, so a display change never needs a re-sync.
    unit: 'km', agg: 'sum', chart: 'bar', precision: 2, scale: 1e-6, primary: true,
    valueFields: ['millimeters', 'distanceMillimeters', 'distanceSum'],
  },
  {
    id: 'floors', snake: 'floors', payload: 'floors', label: 'Floors climbed',
    group: 'Activity', recordType: INTERVAL, maxDays: 90, scope: 'activity',
    listMethod: 'dailyRollUp',
    unit: 'floors', agg: 'sum', chart: 'bar', precision: 0,
    valueFields: ['countSum', 'count', 'floors'],
  },
  {
    id: 'active-minutes', snake: 'active_minutes', payload: 'activeMinutes', label: 'Active minutes',
    group: 'Activity', recordType: INTERVAL, maxDays: 14, scope: 'activity',
    unit: 'min', agg: 'sum', chart: 'bar', precision: 0,
    valueFields: ['minutes', 'minutesSum', 'value', 'duration'],
  },
  {
    id: 'active-zone-minutes', snake: 'active_zone_minutes', payload: 'activeZoneMinutes',
    label: 'Active zone minutes',
    group: 'Activity', recordType: INTERVAL, maxDays: 90, scope: 'activity',
    unit: 'AZM', agg: 'sum', chart: 'bar', precision: 0, primary: true,
    valueFields: ['activeZoneMinutes', 'minutes', 'totalMinutes'],
  },
  {
    id: 'sedentary-period', snake: 'sedentary_period', payload: 'sedentaryPeriod',
    label: 'Sedentary time',
    group: 'Activity', recordType: INTERVAL, maxDays: 90, scope: 'activity',
    unit: 'h', agg: 'sum', chart: 'bar', precision: 1, scale: 1 / 3600000,
    // These points carry NO value field — a sedentary period is expressed purely as
    // an interval, so its duration IS the measurement.
    valueFromDuration: true, valueFields: [],
  },
  {
    id: 'exercise', snake: 'exercise', payload: 'exercise', label: 'Workouts',
    group: 'Activity', recordType: SESSION, maxDays: 90, scope: 'activity',
    // Measured, not assumed: every physical-time member is rejected for this type.
    filterMember: 'interval.civil_start_time',
    unit: 'min', agg: 'sum', chart: 'bar', precision: 0,
    valueFields: ['activeDuration', 'duration'], scale: 1 / 60000,
  },

  // ---- Energy ---------------------------------------------------------------
  {
    id: 'active-energy-burned', snake: 'active_energy_burned', payload: 'activeEnergyBurned',
    label: 'Active calories',
    group: 'Energy', recordType: INTERVAL, maxDays: 90, scope: 'activity',
    unit: 'kcal', agg: 'sum', chart: 'bar', precision: 0,
    valueFields: ['kcal', 'calories', 'caloriesKcal'],
  },
  {
    id: 'total-calories', snake: 'total_calories', payload: 'totalCalories', label: 'Total calories',
    group: 'Energy', recordType: INTERVAL, maxDays: 14, scope: 'activity',
    // The API refuses `list` for this type: "List is not supported for data type
    // total-calories, but the following actions are supported: rollup, dailyRollup".
    listMethod: 'dailyRollUp',
    unit: 'kcal', agg: 'sum', chart: 'bar', precision: 0, primary: true,
    // Rollup values are suffixed: {"totalCalories": {"kcalSum": 2736.23}}.
    valueFields: ['kcalSum', 'calories', 'caloriesKcal'],
  },

  // ---- Heart ----------------------------------------------------------------
  {
    id: 'heart-rate', snake: 'heart_rate', payload: 'heartRate', label: 'Heart rate',
    group: 'Heart', recordType: SAMPLE, maxDays: 14, scope: 'activity',
    unit: 'bpm', agg: 'avg', chart: 'line', precision: 0, band: true,
    valueFields: ['beatsPerMinute', 'bpm', 'value', 'rate'],
  },
  {
    id: 'daily-resting-heart-rate', snake: 'daily_resting_heart_rate', payload: 'dailyRestingHeartRate',
    label: 'Resting heart rate',
    group: 'Heart', recordType: DAILY, maxDays: 90, scope: 'activity',
    unit: 'bpm', agg: 'avg', chart: 'line', precision: 0, primary: true,
    valueFields: ['beatsPerMinute', 'restingHeartRate', 'bpm', 'value'],
  },
  {
    id: 'heart-rate-variability', snake: 'heart_rate_variability', payload: 'heartRateVariability',
    label: 'HRV (samples)',
    group: 'Heart', recordType: SAMPLE, maxDays: 90, scope: 'activity',
    unit: 'ms', agg: 'avg', chart: 'line', precision: 0,
    valueFields: ['rootMeanSquareOfSuccessiveDifferencesMilliseconds', 'rmssdMillis', 'rmssd'],
  },
  {
    id: 'daily-heart-rate-variability', snake: 'daily_heart_rate_variability',
    payload: 'dailyHeartRateVariability', label: 'HRV',
    group: 'Heart', recordType: DAILY, maxDays: 90, scope: 'activity',
    unit: 'ms', agg: 'avg', chart: 'line', precision: 0, primary: true,
    valueFields: ['dailyRmssd', 'rmssdMillis', 'millis', 'value'],
  },
  {
    id: 'time-in-heart-rate-zone', snake: 'time_in_heart_rate_zone', payload: 'timeInHeartRateZone',
    label: 'Time in HR zones',
    group: 'Heart', recordType: INTERVAL, maxDays: 90, scope: 'activity',
    unit: 'min', agg: 'sum', chart: 'stacked', precision: 0,
    // Zones are an ORDERED scale (fat burn -> peak), so they are drawn with the
    // ordinal ramp, never three categorical hues. See charts.js.
    //
    // OUT_OF_RANGE is deliberately not stacked: it is ~1,200 minutes a day against
    // 20–50 for the zones that matter, so including it flattens every meaningful
    // segment into an invisible sliver at the top of the bar. It is still stored,
    // still in the table view, and still in the tooltip total — just not given 96%
    // of the plot to say "the rest of the day happened".
    // Live shape: one point per minute-interval tagged `heartRateZoneType`, with NO
    // minutes field — the interval's own duration is the time in that zone.
    stackKey: 'zone', stackOrder: ['LIGHT', 'FAT_BURN', 'MODERATE', 'CARDIO', 'VIGOROUS', 'PEAK'],
    stackIgnore: ['OUT_OF_RANGE'],
    stackLabels: {
      OUT_OF_RANGE: 'Out of range', LIGHT: 'Light', FAT_BURN: 'Fat burn', MODERATE: 'Moderate',
      CARDIO: 'Cardio', VIGOROUS: 'Vigorous', PEAK: 'Peak',
    },
    valueFields: [],
  },

  // ---- Sleep ----------------------------------------------------------------
  {
    id: 'sleep', snake: 'sleep', payload: 'sleep', label: 'Sleep',
    group: 'Sleep', recordType: SESSION, maxDays: 90, scope: 'sleep',
    unit: 'h', agg: 'sum', chart: 'stacked', precision: 1, primary: true,
    scale: 1 / 3600000, goal: 8,
    // A night belongs to the morning you woke up, not to the evening you went to
    // bed. Bucketing sleep by start time puts a 23:40 bedtime and a 00:20 bedtime
    // on different calendar days, so some days show two sleeps stacked into one
    // 15-hour bar and the next day shows none.
    bucketBy: 'end',
    // The stack reads DEEP at the bottom, but the ORDINAL RAMP has to run the other
    // way: deep sleep is the "most" end of the scale and must be the darkest step.
    // Mapping stack order straight onto the ramp paints deep sleep the palest blue
    // and wakefulness the darkest — an inversion of what the colour is saying.
    stackKey: 'stage', stackOrder: ['DEEP', 'REM', 'LIGHT', 'AWAKE'], rampReverse: true,
    stackLabels: { DEEP: 'Deep', REM: 'REM', LIGHT: 'Light', AWAKE: 'Awake' },
    valueFields: [],
  },
  {
    id: 'respiratory-rate-sleep-summary', snake: 'respiratory_rate_sleep_summary',
    payload: 'respiratoryRateSleepSummary', label: 'Respiratory rate (sleep)',
    group: 'Sleep', recordType: SAMPLE, maxDays: 90, scope: 'sleep',
    unit: 'br/min', agg: 'avg', chart: 'line', precision: 1,
    // Dotted paths: the payload nests one set of stats per sleep stage, and the
    // full-night figure is the one to plot. Without the path, a plain key search
    // returns whichever stage happens to serialise first (deep sleep).
    valueFields: ['fullSleepStats.breathsPerMinute', 'lightSleepStats.breathsPerMinute',
      'deepSleepStats.breathsPerMinute', 'breathsPerMinute'],
  },
  {
    id: 'daily-respiratory-rate', snake: 'daily_respiratory_rate', payload: 'dailyRespiratoryRate',
    label: 'Respiratory rate',
    group: 'Sleep', recordType: DAILY, maxDays: 90, scope: 'metrics',
    unit: 'br/min', agg: 'avg', chart: 'line', precision: 1,
    valueFields: ['breathsPerMinute', 'value', 'rate'],
  },
  {
    id: 'daily-sleep-temperature-derivations', snake: 'daily_sleep_temperature_derivations',
    payload: 'dailySleepTemperatureDerivations', label: 'Skin temp variation',
    group: 'Sleep', recordType: DAILY, maxDays: 90, scope: 'metrics',
    unit: '°C', agg: 'avg', chart: 'line', precision: 1, diverging: true,
    valueFields: ['temperatureDeltaCelsius', 'deltaCelsius', 'celsius', 'value'],
  },

  // ---- Body & metrics -------------------------------------------------------
  {
    id: 'weight', connectGaps: true, snake: 'weight', payload: 'weight', label: 'Weight',
    group: 'Body', recordType: SAMPLE, maxDays: 90, scope: 'metrics',
    unit: 'kg', agg: 'last', chart: 'line', precision: 1, primary: true,
    // The API reports GRAMS (88000), not kilograms. Storing the API's own unit and
    // scaling at the edge keeps one convention everywhere.
    scale: 1 / 1000,
    valueFields: ['weightGrams', 'weightKilograms', 'kilograms'],
  },
  {
    id: 'body-fat', connectGaps: true, snake: 'body_fat', payload: 'bodyFat', label: 'Body fat',
    group: 'Body', recordType: SAMPLE, maxDays: 90, scope: 'metrics',
    unit: '%', agg: 'last', chart: 'line', precision: 1,
    valueFields: ['percentage', 'percent', 'value'],
  },
  {
    id: 'height', connectGaps: true, snake: 'height', payload: 'height', label: 'Height',
    group: 'Body', recordType: SAMPLE, maxDays: 90, scope: 'metrics',
    unit: 'cm', agg: 'last', chart: 'line', precision: 1, scale: 1 / 10,
    valueFields: ['heightMillimeters', 'heightCentimeters', 'centimeters'],
  },
  {
    id: 'oxygen-saturation', snake: 'oxygen_saturation', payload: 'oxygenSaturation',
    label: 'SpO2 (samples)',
    group: 'Body', recordType: SAMPLE, maxDays: 90, scope: 'metrics',
    unit: '%', agg: 'avg', chart: 'line', precision: 1,
    valueFields: ['percentage', 'percent', 'value'],
  },
  {
    id: 'daily-oxygen-saturation', snake: 'daily_oxygen_saturation', payload: 'dailyOxygenSaturation',
    label: 'SpO2',
    group: 'Body', recordType: DAILY, maxDays: 90, scope: 'metrics',
    unit: '%', agg: 'avg', chart: 'line', precision: 1, primary: true,
    valueFields: ['averagePercentage', 'percentage', 'percent', 'value'],
  },
  {
    id: 'daily-vo2-max', snake: 'daily_vo2_max', payload: 'dailyVo2Max', label: 'VO2 max',
    group: 'Body', recordType: DAILY, maxDays: 90, scope: 'metrics',
    unit: 'ml/kg/min', agg: 'max', chart: 'line', precision: 1,
    valueFields: ['vo2Max', 'value'],
  },
  {
    id: 'core-body-temperature', snake: 'core_body_temperature', payload: 'coreBodyTemperature',
    label: 'Body temperature',
    group: 'Body', recordType: SAMPLE, maxDays: 90, scope: 'metrics',
    unit: '°C', agg: 'avg', chart: 'line', precision: 1,
    valueFields: ['celsius', 'temperatureCelsius', 'value'],
  },
  {
    id: 'blood-glucose', snake: 'blood_glucose', payload: 'bloodGlucose', label: 'Blood glucose',
    group: 'Body', recordType: SAMPLE, maxDays: 90, scope: 'metrics',
    unit: 'mg/dL', agg: 'avg', chart: 'line', precision: 0,
    valueFields: ['milligramsPerDeciliter', 'mgPerDl', 'value'],
  },

  // ---- Intake ---------------------------------------------------------------
  {
    id: 'hydration-log', snake: 'hydration_log', payload: 'hydrationLog', label: 'Hydration',
    group: 'Intake', recordType: SESSION, maxDays: 90, scope: 'nutrition',
    filterMember: 'interval.civil_start_time',
    unit: 'L', agg: 'sum', chart: 'bar', precision: 2, scale: 1 / 1000,
    valueFields: ['milliliters', 'volumeMl', 'value'],
  },
  {
    id: 'nutrition-log', snake: 'nutrition_log', payload: 'nutritionLog', label: 'Calories eaten',
    group: 'Intake', recordType: SAMPLE, maxDays: 90, scope: 'nutrition',
    filterMember: 'interval.civil_start_time',
    unit: 'kcal', agg: 'sum', chart: 'bar', precision: 0,
    valueFields: ['calories', 'caloriesKcal', 'value'],
  },
];

const BY_ID = new Map(TYPES.map((t) => [t.id, t]));

/** Types the webhook subscriber can push in real time — the API supports six, but
 * `altitude` has no catalog entry here, so subscribing to it would only produce an
 * eternal "unhandled data type" log line for every push. */
const WEBHOOK_TYPES = ['steps', 'distance', 'floors', 'weight', 'sleep'];

function get(id) {
  return BY_ID.get(id) || null;
}

function all() {
  return TYPES;
}

function groups() {
  const out = [];
  for (const t of TYPES) {
    let g = out.find((x) => x.name === t.group);
    if (!g) out.push((g = { name: t.group, types: [] }));
    g.types.push(t.id);
  }
  return out;
}

/** The distinct scopes a set of enabled type ids needs, plus profile (for identity). */
function scopesFor(ids) {
  const want = new Set([SCOPES.profile]);
  for (const id of ids) {
    const t = get(id);
    if (t && SCOPES[t.scope]) want.add(SCOPES[t.scope]);
  }
  return [...want];
}

/**
 * The filter field for a type. Getting this wrong is a 400, not a wrong answer.
 * Derived from recordType, with a per-type `filterMember` override for the types
 * that don't follow their record type's default — measured against the live API,
 * not assumed: exercise, hydration-log and nutrition-log reject every physical-time
 * member and accept ONLY `interval.civil_start_time`.
 */
function filterField(t) {
  if (t.filterMember) return `${t.snake}.${t.filterMember}`;
  switch (t.recordType) {
    case INTERVAL: return `${t.snake}.interval.start_time`;
    case SESSION: return `${t.snake}.interval.end_time`;
    case SAMPLE: return `${t.snake}.sample_time.physical_time`;
    case DAILY: return `${t.snake}.date`;
    default: throw new Error(`unknown recordType ${t.recordType}`);
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** Local wall-clock, no zone designator — what a civil_* member requires. */
function civilDateTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The rollUp `range` takes a CivilDateTime, which nests its parts under `date`
 * (and optionally `time`) — NOT bare {year, month, day}. Sending the flat form is
 * rejected with `Unknown name "year" at 'range.start'`.
 */
function civilDate(ms) {
  const d = new Date(ms);
  return { date: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() } };
}

/**
 * Three literal formats, and sending the wrong one is a 400:
 *   DAILY      a bare civil date        "2026-08-14"
 *   civil_*    local wall clock, no Z   "2026-08-14T00:00:00"
 *   everything RFC-3339 UTC             "2026-08-14T00:00:00Z"
 */
function timeRangeFilter(t, fromMs, toMs) {
  const field = filterField(t);
  const fmt = t.recordType === DAILY
    ? (ms) => new Date(ms).toISOString().slice(0, 10)
    : field.includes('civil')
      ? civilDateTime
      : (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // DAILY truncates both bounds to civil dates, and the upper bound is EXCLUSIVE —
  // so `date < "<today>"` silently drops today, every day, for every DAILY type.
  // Round the exclusive end up to the day after the one toMs falls in, exactly as
  // health.dailyRollUp() does for the same trap on the rollup path.
  const upper = t.recordType === DAILY ? toMs + 86399999 : toMs;
  return `${field} >= "${fmt(fromMs)}" AND ${field} < "${fmt(upper)}"`;
}

module.exports = {
  civilDate, WEBHOOK_TYPES,
  all, get, groups, scopesFor, filterField, timeRangeFilter,
};
