'use strict';
/**
 * dataPoint (Google's JSON) -> row (our SQLite shape).
 *
 * A dataPoint looks like this — the type-named key is where everything lives:
 *
 *   {
 *     "name": "users/2515.../dataTypes/exercise/dataPoints/8896...",
 *     "dataSource": { "recordingMethod": "MANUAL", "platform": "FITBIT" },
 *     "exercise": { "interval": { "startTime": "...", "endTime": "..." }, ... }
 *   }
 *
 * WHY THIS FILE IS DEFENSIVE. The v4 reference publishes the envelope, the record
 * types and the filter fields, but not a per-type table of value field names. So the
 * catalog carries a *hint list* per type and this module walks it in order, then
 * falls back to "the first plausible numeric leaf". Every fallback is recorded in
 * `notes`, and the caller logs them — an unrecognised shape shows up as a visible
 * warning in the UI rather than as a chart that is quietly empty.
 *
 * Nothing here is lossy: db.putPoints stores the raw JSON alongside, and
 * `renormalize` re-runs this file over stored raw when a hint is corrected.
 */

const catalog = require('./catalog');

const ENVELOPE_KEYS = new Set(['name', 'dataSource', 'dataOrigin', 'etag', 'updateTime']);

/** Pull the type-named payload object out of the envelope. */
function payloadOf(point, type) {
  const candidates = [type.payload, type.snake, type.id, camel(type.snake)];
  for (const key of candidates) {
    if (key && point[key] && typeof point[key] === 'object') return { key, body: point[key] };
  }
  // Fallback: the single object key that isn't envelope metadata.
  for (const [key, body] of Object.entries(point)) {
    if (!ENVELOPE_KEYS.has(key) && body && typeof body === 'object' && !Array.isArray(body)) {
      return { key, body, guessed: true };
    }
  }
  return null;
}

function camel(snake) {
  return String(snake).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function toMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  // Bare civil date (DAILY types) — anchor at local midnight so a daily value lands
  // on its own calendar day rather than being shifted by the UTC parse.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** "900s" | "900.5s" | 900000 | "900000" -> milliseconds. */
function durationMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const secs = /^(-?\d+(?:\.\d+)?)s$/.exec(s);
  if (secs) return Number(secs[1]) * 1000;
  const iso = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s);
  if (iso && s.length > 1) {
    const [, d, h, m, sec] = iso;
    return ((Number(d || 0) * 86400) + (Number(h || 0) * 3600)
      + (Number(m || 0) * 60) + Number(sec || 0)) * 1000;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Google serialises int64 as a JSON string ("2038"), so numbers arrive as strings. */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const d = durationMs(v);
    return d === null ? null : d;
  }
  return null;
}

/**
 * Look up a value field. A dotted name walks an exact path; a bare name searches
 * nested objects. The distinction matters where the payload holds the same key
 * several times — respiratory rate nests one stats block per sleep stage, and a
 * bare search returns whichever stage serialises first rather than the one asked for.
 */
function digPath(obj, spec) {
  if (!spec.includes('.')) return dig(obj, spec);
  let cur = obj;
  for (const part of spec.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function dig(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const hit = dig(v, key);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** Times, by record type. Returns {startMs, endMs} or null. */
function timesOf(body, type) {
  const iv = body.interval || body.physicalTimeInterval || null;
  if (iv) {
    const s = toMs(iv.startTime), e = toMs(iv.endTime);
    if (s !== null) return { startMs: s, endMs: e === null ? s : e };
  }
  const st = body.sampleTime || body.sample_time || null;
  if (st) {
    const s = toMs(st.physicalTime || st.physical_time || st.time || st);
    if (s !== null) return { startMs: s, endMs: s };
  }
  if (body.date) {
    const s = toMs(body.date);
    if (s !== null) return { startMs: s, endMs: s + 86400000 };
  }
  // Sleep's documented example carries bare startTime/endTime, no interval wrapper.
  if (body.startTime) {
    const s = toMs(body.startTime), e = toMs(body.endTime);
    if (s !== null) return { startMs: s, endMs: e === null ? s : e };
  }
  const anyTime = toMs(dig(body, 'startTime') ?? dig(body, 'physicalTime') ?? dig(body, 'date'));
  if (anyTime !== null) return { startMs: anyTime, endMs: anyTime };
  return null;
}

/** First numeric leaf, skipping time-ish and identifier-ish keys. */
const SKIP_LEAF = /time|date|offset|id$|version|type$|name|zone$|method|platform/i;
function firstNumericLeaf(body, depth = 0) {
  if (depth > 3 || !body || typeof body !== 'object') return null;
  for (const [k, v] of Object.entries(body)) {
    if (SKIP_LEAF.test(k)) continue;
    const n = num(v);
    if (n !== null) return { key: k, value: n };
  }
  for (const [k, v] of Object.entries(body)) {
    if (SKIP_LEAF.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const hit = firstNumericLeaf(v, depth + 1);
    if (hit) return { key: `${k}.${hit.key}`, value: hit.value };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-type extractors for the shapes that aren't a single number
// ---------------------------------------------------------------------------

/**
 * Sleep. `value` is TIME ASLEEP (stages minus AWAKE), not time in bed — the number a
 * sleep tile should show. Time in bed stays in fields, and the stacked chart draws
 * every stage including AWAKE from `parts`.
 */
function extractSleep(body, times) {
  const stages = body.sleepStages || body.stages || body.levels || [];
  const awakenings = body.shortAwakenings || body.awakenings || [];
  const parts = {};
  let asleepMs = 0;
  let awakeMs = 0;

  const addStage = (s) => {
    const a = toMs(s.startTime), b = toMs(s.endTime);
    if (a === null || b === null || b <= a) return;
    const key = String(s.type || s.level || s.stage || 'UNKNOWN').toUpperCase();
    parts[key] = (parts[key] || 0) + (b - a);
    if (key === 'AWAKE' || key === 'WAKE') awakeMs += b - a;
    else asleepMs += b - a;
  };
  for (const s of stages) addStage(s);
  for (const s of awakenings) addStage(s);

  const inBedMs = times && times.endMs > times.startMs ? times.endMs - times.startMs : null;
  // A CLASSIC (non-staged) sleep record has no stages at all; fall back to duration
  // so those nights still plot instead of silently reading as zero.
  const value = asleepMs > 0 ? asleepMs : (inBedMs || null);
  if (asleepMs === 0 && inBedMs) parts.LIGHT = inBedMs;

  const fields = {
    sleepType: body.sleepType || null,
    inBedMs,
    awakeMs,
    asleepMs: asleepMs || inBedMs || null,
    efficiency: inBedMs && asleepMs ? Math.round((asleepMs / inBedMs) * 100) : null,
  };
  return { value, parts, fields };
}

/**
 * Heart-rate zones. The live shape is one point per short interval tagged with a
 * `heartRateZoneType` and NO minutes field at all — so the interval's own duration
 * is the time in that zone. (An array-of-zones form is also handled, since the
 * reference describes rollup values that way.)
 */
function extractZones(body, times) {
  const parts = {};
  const arr = body.zones || body.heartRateZones || body.timeInZones || null;

  if (Array.isArray(arr)) {
    for (const z of arr) {
      const key = String(z.zone || z.heartRateZoneType || z.name || z.type || 'UNKNOWN')
        .toUpperCase().replace(/\s+/g, '_');
      const v = num(z.minutes ?? z.minutesInZone ?? z.duration ?? z.value);
      if (v !== null) parts[key] = (parts[key] || 0) + v;
    }
  } else {
    const key = String(body.heartRateZoneType || body.zone || body.zoneName || body.type || '')
      .toUpperCase().replace(/\s+/g, '_');
    let v = num(body.minutes ?? body.minutesInZone ?? body.value);
    if (v === null && times && times.endMs > times.startMs) {
      v = (times.endMs - times.startMs) / 60000;
    }
    if (key && v !== null) parts[key] = v;
  }
  const value = Object.values(parts).reduce((a, b) => a + b, 0) || null;
  return { value, parts, fields: null };
}

/**
 * Active minutes arrive as an array broken down by activity level, not as a scalar.
 * The levels are an ordered scale, so they are kept as stack parts too.
 */
function extractActiveMinutes(body) {
  const arr = body.activeMinutesByActivityLevel || body.byActivityLevel || null;
  if (!Array.isArray(arr)) return null;
  const parts = {};
  for (const entry of arr) {
    const key = String(entry.activityLevel || entry.level || 'UNKNOWN').toUpperCase();
    const v = num(entry.activeMinutes ?? entry.minutes ?? entry.value);
    if (v !== null) parts[key] = (parts[key] || 0) + v;
  }
  const value = Object.values(parts).reduce((a, b) => a + b, 0);
  return { value: value || null, parts, fields: null };
}

/** Exercise sessions — duration is the plotted value, the summary is kept in fields. */
function extractExercise(body, times) {
  const active = durationMs(body.activeDuration ?? body.duration);
  const span = times && times.endMs > times.startMs ? times.endMs - times.startMs : null;
  const m = body.metricsSummary || {};
  return {
    value: active ?? span,
    parts: {},
    fields: {
      exerciseType: body.exerciseType || null,
      displayName: body.displayName || null,
      calories: num(m.caloriesKcal ?? m.calories),
      distanceMm: num(m.distanceMillimiters ?? m.distanceMillimeters),
      steps: num(m.steps),
      activeZoneMinutes: num(m.activeZoneMinutes),
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Normalize one dataPoint. Returns a row, or null if it has no usable timestamp
 * (a point we cannot place in time is not chartable and is not worth storing).
 * `notes` carries anything the caller should surface.
 */
function normalizePoint(point, type, notes) {
  const found = payloadOf(point, type);
  if (!found) {
    notes.add(`${type.id}: no payload object found in dataPoint`);
    return null;
  }
  const { body, guessed } = found;
  if (guessed) notes.add(`${type.id}: payload key guessed as "${found.key}"`);

  const times = timesOf(body, type);
  if (!times) {
    notes.add(`${type.id}: no timestamp found`);
    return null;
  }

  let value = null;
  let parts = {};
  let fields = null;

  const activeMinutes = type.id === 'active-minutes' ? extractActiveMinutes(body) : null;

  if (type.id === 'sleep') {
    ({ value, parts, fields } = extractSleep(body, times));
  } else if (type.id === 'time-in-heart-rate-zone') {
    ({ value, parts, fields } = extractZones(body, times));
  } else if (type.id === 'exercise') {
    ({ value, parts, fields } = extractExercise(body, times));
  } else if (activeMinutes) {
    ({ value, parts, fields } = activeMinutes);
  } else if (type.valueFromDuration) {
    // The measurement IS the interval (sedentary periods carry no value field).
    value = times.endMs > times.startMs ? times.endMs - times.startMs : null;
  } else {
    for (const f of type.valueFields || []) {
      const v = num(digPath(body, f));
      if (v !== null) { value = v; break; }
    }
    if (value === null) {
      const leaf = firstNumericLeaf(body);
      if (leaf) {
        value = leaf.value;
        notes.add(`${type.id}: value taken from unlisted field "${leaf.key}"`);
      } else {
        notes.add(`${type.id}: no numeric value found`);
      }
    }
  }

  const src = point.dataSource || point.dataOrigin || {};
  return {
    dataType: type.id,
    // The resource name is the stable per-point identity; fall back to a time key so
    // a nameless point still de-duplicates instead of multiplying on every sync.
    pointId: point.name || `${type.id}:${times.startMs}`,
    startMs: times.startMs,
    endMs: times.endMs,
    // What this point is bucketed by. Sleep anchors on wake time (catalog
    // `bucketBy: 'end'`) so a night lands on the day you got up.
    anchorMs: type.bucketBy === 'end' ? times.endMs : times.startMs,
    value,
    platform: src.platform || src.packageName || null,
    recording: src.recordingMethod || null,
    fields,
    parts,
    raw: point,
  };
}

function normalizeBatch(points, type) {
  const notes = new Set();
  const rows = [];
  for (const p of points) {
    const row = normalizePoint(p, type, notes);
    if (row) rows.push(row);
  }
  return { rows, notes: [...notes] };
}

/** {year, month, day, hours?, minutes?} -> local epoch ms. */
function civilToMs(c) {
  if (!c || typeof c !== 'object') return null;
  const src = c.date && typeof c.date === 'object' ? { ...c.date, ...(c.time || {}) } : c;
  if (!Number.isFinite(Number(src.year))) return null;
  return new Date(
    Number(src.year), Number(src.month || 1) - 1, Number(src.day || 1),
    Number(src.hours || 0), Number(src.minutes || 0), Number(src.seconds || 0),
  ).getTime();
}

/**
 * A rollup data point is a different animal from a list data point: no `name`, no
 * `interval`, no `dataSource` — just civil start/end and a type-named rollup value
 * (`{"steps": {"countSum": 8234}}`). It gets a synthetic, stable id so re-reading a
 * window updates the same row instead of duplicating it.
 */
function normalizeRollupPoint(point, type, notes) {
  const startMs = civilToMs(point.civilStartTime || point.startTime);
  const endMs = civilToMs(point.civilEndTime || point.endTime);
  if (startMs === null) {
    notes.add(`${type.id}: rollup point without a civil start time`);
    return null;
  }

  const found = payloadOf(point, type);
  const body = found ? found.body : null;
  let value = null;
  if (body) {
    for (const f of type.valueFields || []) {
      const v = num(digPath(body, f));
      if (v !== null) { value = v; break; }
    }
    if (value === null) {
      const leaf = firstNumericLeaf(body);
      if (leaf) {
        value = leaf.value;
        notes.add(`${type.id}: rollup value taken from unlisted field "${leaf.key}"`);
      } else {
        notes.add(`${type.id}: rollup point carried no numeric value`);
      }
    }
  } else {
    notes.add(`${type.id}: no rollup payload found`);
  }

  return {
    dataType: type.id,
    pointId: `${type.id}:rollup:${startMs}`,
    startMs,
    endMs: endMs === null ? startMs + 86400000 : endMs,
    anchorMs: startMs,
    value,
    platform: 'ROLLUP',
    recording: 'DERIVED',
    fields: null,
    parts: {},
    raw: point,
  };
}

function normalizeRollupBatch(points, type) {
  const notes = new Set();
  const rows = [];
  for (const p of points) {
    const row = normalizeRollupPoint(p, type, notes);
    if (row) rows.push(row);
  }
  return { rows, notes: [...notes] };
}

/** Re-derive stored rows from raw JSON, for when a value hint is corrected. */
async function renormalize(db, typeId) {
  const type = catalog.get(typeId);
  if (!type) throw new Error(`unknown type ${typeId}`);
  const notes = new Set();
  let batch = [];
  // Rollup points have no interval and no dataSource — re-deriving them through the
  // list-shaped path finds no timestamp and silently drops every row.
  const derive = type.listMethod === 'dailyRollUp' ? normalizeRollupPoint : normalizePoint;
  await db.eachRaw(typeId, async (r) => {
    const row = derive(JSON.parse(r.raw), type, notes);
    if (row) batch.push(row);
    if (batch.length >= 400) { await db.putPoints(batch); batch = []; }
  });
  if (batch.length) await db.putPoints(batch);
  return [...notes];
}

module.exports = {
  normalizePoint, normalizeBatch, normalizeRollupPoint, normalizeRollupBatch, renormalize,
  // exported for tests
  toMs, durationMs, num, payloadOf, timesOf, extractSleep, extractZones,
  extractActiveMinutes, digPath, civilToMs,
};
