'use strict';
/**
 * Store — the fleet's MySQL.
 *
 * This app ran on node:sqlite until it needed to run at more than one replica.
 * SQLite is a file, and two replicas on two hosts are two files: the dashboard would
 * answer differently depending on which replica you landed on, and each would sync
 * independently against a 300 req/min budget. Shared state is the whole reason
 * `mysql2` is the one dependency this app carries.
 *
 * The design rule is unchanged from the SQLite version, and it is the important one:
 * THE RAW DATAPOINT IS ALWAYS KEPT. `points.raw` holds the exact JSON Google
 * returned, and `value`/`fields`/`parts` are a derived, re-computable projection of
 * it. Per-type value field names are not fully published — several turned out to be
 * wrong on first contact with the live API — so `renormalize()` fixes history from
 * the raw rows instead of forcing a re-sync that would burn quota and lose data that
 * has since aged out upstream.
 *
 * `raw` and `fields` are TEXT, not MySQL's JSON type, deliberately: the JSON type
 * hands back parsed objects, which would silently change the shape every caller
 * already expects from the SQLite era.
 *
 * Points are keyed by (data_type, point_id) and written with UPSERT. Google restates
 * data: a walk logged at 14:00 gets rewritten when the watch syncs at 22:00, and
 * sleep is revised the morning after. Append-only would double every total.
 */

const mysql = require('mysql2/promise');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS points (
    data_type   VARCHAR(64)  NOT NULL,
    point_id    VARCHAR(255) NOT NULL,
    start_ms    BIGINT       NOT NULL,
    end_ms      BIGINT       NOT NULL,
    -- The timestamp this point is BUCKETED and RANGE-FILTERED by, which is not
    -- always its start: a night's sleep belongs to the morning you woke up.
    anchor_ms   BIGINT       NOT NULL,
    value       DOUBLE       NULL,
    platform    VARCHAR(64)  NULL,
    recording   VARCHAR(64)  NULL,
    fields      TEXT         NULL,
    raw         LONGTEXT     NOT NULL,
    ingested_ms BIGINT       NOT NULL,
    PRIMARY KEY (data_type, point_id),
    KEY idx_points_type_time (data_type, anchor_ms)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Stacked components of one point (sleep stages, heart-rate zones). Split out of
  // the fields JSON so a stacked chart is a GROUP BY, not JSON parsing in JS.
  `CREATE TABLE IF NOT EXISTS parts (
    data_type VARCHAR(64)  NOT NULL,
    point_id  VARCHAR(255) NOT NULL,
    \`key\`     VARCHAR(64)  NOT NULL,
    anchor_ms BIGINT       NOT NULL,
    value     DOUBLE       NOT NULL,
    PRIMARY KEY (data_type, point_id, \`key\`),
    KEY idx_parts_type_time (data_type, anchor_ms)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // One row per data type: how far back we have backfilled and how far forward we
  // have tailed. Two cursors, not one, because sync runs in both directions at once.
  `CREATE TABLE IF NOT EXISTS cursors (
    data_type     VARCHAR(64) NOT NULL,
    from_ms       BIGINT      NULL,
    to_ms         BIGINT      NULL,
    backfill_done TINYINT     NOT NULL DEFAULT 0,
    last_sync_ms  BIGINT      NULL,
    last_error    TEXT        NULL,
    PRIMARY KEY (data_type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS tokens (
    id             TINYINT      NOT NULL,
    access_token   TEXT         NULL,
    refresh_token  TEXT         NULL,
    expiry_ms      BIGINT       NULL,
    scope          TEXT         NULL,
    health_user_id VARCHAR(64)  NULL,
    legacy_user_id VARCHAR(64)  NULL,
    connected_ms   BIGINT       NULL,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS events (
    id        BIGINT      NOT NULL AUTO_INCREMENT,
    ts_ms     BIGINT      NOT NULL,
    kind      VARCHAR(32) NOT NULL,
    data_type VARCHAR(64) NULL,
    message   TEXT        NULL,
    count     INT         NULL,
    PRIMARY KEY (id),
    KEY idx_events_ts (ts_ms)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /**
   * Cross-replica leases for periodic work.
   *
   * A mutex alone is NOT enough and this table's shape is the reason: a lock makes
   * replicas take turns, it does not make them stand down. Two replicas booting eight
   * seconds apart both acquire it in turn and both run the sweep — which against a
   * rate-limited upstream is exactly the failure a lock was supposed to prevent. So
   * the claim is conditional on `last_done_ms` as well: work runs only if nobody
   * ELSE has completed it recently, checked inside the same atomic UPDATE.
   */
  `CREATE TABLE IF NOT EXISTS leases (
    name         VARCHAR(64) NOT NULL,
    owner        VARCHAR(64) NOT NULL DEFAULT '',
    expires_ms   BIGINT      NOT NULL DEFAULT 0,
    last_done_ms BIGINT      NULL,
    PRIMARY KEY (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS settings (
    \`key\` VARCHAR(64) NOT NULL,
    value TEXT        NOT NULL,
    PRIMARY KEY (\`key\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Manually logged strength work — the one signal heart rate cannot carry. Volume
  // is stored denormalized (sets × reps × kg) so the log survives a formula change.
  `CREATE TABLE IF NOT EXISTS strength_log (
    id        BIGINT       NOT NULL AUTO_INCREMENT,
    ts_ms     BIGINT       NOT NULL,
    exercise  VARCHAR(80)  NOT NULL,
    sets      INT          NOT NULL,
    reps      INT          NOT NULL,
    weight_kg DOUBLE       NOT NULL,
    volume_kg DOUBLE       NOT NULL,
    note      TEXT         NULL,
    PRIMARY KEY (id),
    KEY idx_strength_ts (ts_ms)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

let pool = null;

function config() {
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'vitals',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'vitals',
  };
}

async function open(overrides = {}) {
  if (pool) return pool;
  pool = mysql.createPool({
    ...config(),
    ...overrides,
    waitForConnections: true,
    connectionLimit: 8,
    // Bounded, because the Docker build runs the test suite and an unreachable host
    // would otherwise hang the build rather than skipping the storage tests.
    connectTimeout: 8000,
    // Google serialises int64 as strings and our own BIGINTs exceed 2^53 only in
    // theory, but a BIGINT returned as a JS string would break every arithmetic
    // comparison downstream. Timestamps in ms stay far inside Number's safe range.
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    charset: 'utf8mb4',
  });
  for (const stmt of SCHEMA) await pool.query(stmt);
  return pool;
}

function handle() {
  if (!pool) throw new Error('db not opened');
  return pool;
}

async function close() {
  if (pool) await pool.end();
  pool = null;
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

const BATCH = 400;

/**
 * Upsert a batch of normalized rows. Returns {written, fresh} — `fresh` counts rows
 * that did not exist before, which is what the UI reports as "new". A re-sync that
 * rewrites 400 unchanged points is not 400 new data points.
 *
 * `fresh` is computed with an explicit existence probe rather than from affectedRows:
 * MySQL reports 1 for an insert and 2 for an update, but 0 for an update that changed
 * nothing — so a restated-but-identical point would be indistinguishable from a new one.
 */
async function putPoints(rows) {
  if (!rows.length) return { written: 0, fresh: 0 };
  const db = handle();
  const now = Date.now();
  let fresh = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);

    const byType = new Map();
    for (const r of batch) {
      if (!byType.has(r.dataType)) byType.set(r.dataType, []);
      byType.get(r.dataType).push(r.pointId);
    }
    const existing = new Set();
    for (const [dataType, ids] of byType) {
      const [found] = await db.query(
        'SELECT point_id FROM points WHERE data_type = ? AND point_id IN (?)',
        [dataType, ids],
      );
      for (const row of found) existing.add(`${dataType}\0${row.point_id}`);
    }
    for (const r of batch) if (!existing.has(`${r.dataType}\0${r.pointId}`)) fresh++;

    const values = batch.map((r) => [
      r.dataType, r.pointId, r.startMs, r.endMs,
      Number.isFinite(r.anchorMs) ? r.anchorMs : r.startMs,
      r.value === undefined ? null : r.value,
      r.platform || null, r.recording || null,
      r.fields ? JSON.stringify(r.fields) : null,
      JSON.stringify(r.raw), now,
    ]);
    await db.query(
      `INSERT INTO points
         (data_type, point_id, start_ms, end_ms, anchor_ms, value, platform, recording, fields, raw, ingested_ms)
       VALUES ? AS new
       ON DUPLICATE KEY UPDATE
         start_ms = new.start_ms, end_ms = new.end_ms, anchor_ms = new.anchor_ms,
         value = new.value, platform = new.platform, recording = new.recording,
         fields = new.fields, raw = new.raw, ingested_ms = new.ingested_ms`,
      [values],
    );

    // Parts are replaced wholesale: a revised sleep session can drop a stage the
    // first version had, and a merge would leave that ghost stage behind forever.
    const withParts = batch.filter((r) => r.parts && Object.keys(r.parts).length);
    const partIds = batch.map((r) => r.pointId);
    for (const [dataType] of byType) {
      await db.query('DELETE FROM parts WHERE data_type = ? AND point_id IN (?)',
        [dataType, partIds]);
    }
    const partRows = [];
    for (const r of withParts) {
      const anchor = Number.isFinite(r.anchorMs) ? r.anchorMs : r.startMs;
      for (const [key, value] of Object.entries(r.parts)) {
        if (Number.isFinite(value)) partRows.push([r.dataType, r.pointId, key, anchor, value]);
      }
    }
    if (partRows.length) {
      await db.query(
        `INSERT INTO parts (data_type, point_id, \`key\`, anchor_ms, value)
         VALUES ? AS new
         ON DUPLICATE KEY UPDATE anchor_ms = new.anchor_ms, value = new.value`,
        [partRows],
      );
    }
  }

  return { written: rows.length, fresh };
}

/** SQL for "which bucket does this row fall in", in the VIEWER's civil time. */
function bucketExpr(bucketMs, offsetMs) {
  if (!bucketMs) return 'anchor_ms';
  return `(FLOOR((anchor_ms + ${Number(offsetMs)}) / ${Number(bucketMs)}) * ${Number(bucketMs)} - ${Number(offsetMs)})`;
}

/**
 * Bucketed series. `offsetMs` is the viewer's UTC offset so that a "day" is the
 * viewer's civil day — bucketing steps in UTC puts an evening walk in Dubai on the
 * wrong date, which is exactly the kind of quiet wrongness a health chart must not have.
 */
async function series(dataType, fromMs, toMs, bucketMs, agg, offsetMs = 0) {
  const db = handle();
  const b = bucketExpr(bucketMs, offsetMs);

  if (agg === 'last') {
    // A standing value (weight): the newest reading in the bucket, not a mean of
    // however many times the scale was stepped on.
    const [rows] = await db.query(
      `SELECT b AS t, value AS v, value AS lo, value AS hi, 1 AS n FROM (
         SELECT ${b} AS b, value,
                ROW_NUMBER() OVER (PARTITION BY ${b} ORDER BY anchor_ms DESC) AS rn
         FROM points
         WHERE data_type = ? AND anchor_ms >= ? AND anchor_ms < ? AND value IS NOT NULL
       ) ranked WHERE rn = 1 ORDER BY t`,
      [dataType, fromMs, toMs],
    );
    return rows.map((r) => ({ t: num(r.t), v: num(r.v), lo: num(r.lo), hi: num(r.hi), n: 1 }));
  }

  const fn = agg === 'avg' ? 'AVG' : agg === 'max' ? 'MAX' : agg === 'min' ? 'MIN' : 'SUM';
  const [rows] = await db.query(
    `SELECT ${b} AS t, ${fn}(value) AS v, MIN(value) AS lo, MAX(value) AS hi, COUNT(*) AS n
     FROM points
     WHERE data_type = ? AND anchor_ms >= ? AND anchor_ms < ? AND value IS NOT NULL
     GROUP BY t ORDER BY t`,
    [dataType, fromMs, toMs],
  );
  return rows.map((r) => ({ t: num(r.t), v: num(r.v), lo: num(r.lo), hi: num(r.hi), n: num(r.n) }));
}

/** Stacked series (sleep stages, HR zones): one row per bucket per component key. */
async function stackedSeries(dataType, fromMs, toMs, bucketMs, offsetMs = 0) {
  const db = handle();
  const b = bucketExpr(bucketMs, offsetMs);
  const [rows] = await db.query(
    `SELECT ${b} AS t, \`key\`, SUM(value) AS v
     FROM parts
     WHERE data_type = ? AND anchor_ms >= ? AND anchor_ms < ?
     GROUP BY t, \`key\` ORDER BY t`,
    [dataType, fromMs, toMs],
  );
  return rows.map((r) => ({ t: num(r.t), key: r.key, v: num(r.v) }));
}

/** Raw rows for the table view — capped, newest first. */
async function rawPoints(dataType, fromMs, toMs, limit = 500) {
  const db = handle();
  const cap = Math.max(1, Math.min(5000, Number(limit) || 500));
  const [rows] = await db.query(
    `SELECT start_ms, end_ms, anchor_ms, value, platform, recording, fields
     FROM points WHERE data_type = ? AND anchor_ms >= ? AND anchor_ms < ?
     ORDER BY anchor_ms DESC LIMIT ${cap}`,
    [dataType, fromMs, toMs],
  );
  return rows.map((r) => ({
    start_ms: num(r.start_ms), end_ms: num(r.end_ms), anchor_ms: num(r.anchor_ms),
    value: num(r.value), platform: r.platform, recording: r.recording, fields: r.fields,
  }));
}

/** The raw JSON for one point, by anchor — the sleep screen needs the stage list. */
async function rawPointsWithRaw(dataType, anchorMs) {
  const [rows] = await handle().query(
    'SELECT raw FROM points WHERE data_type = ? AND anchor_ms = ? LIMIT 1',
    [dataType, anchorMs],
  );
  return rows;
}

async function latest(dataType) {
  const [rows] = await handle().query(
    `SELECT start_ms, anchor_ms, value FROM points
     WHERE data_type = ? AND value IS NOT NULL ORDER BY anchor_ms DESC LIMIT 1`,
    [dataType],
  );
  if (!rows.length) return null;
  return { start_ms: num(rows[0].start_ms), anchor_ms: num(rows[0].anchor_ms), value: num(rows[0].value) };
}

async function aggregate(dataType, fromMs, toMs, agg) {
  const db = handle();
  if (agg === 'last') {
    const [rows] = await db.query(
      `SELECT value AS v FROM points WHERE data_type = ? AND anchor_ms >= ? AND anchor_ms < ?
       AND value IS NOT NULL ORDER BY anchor_ms DESC LIMIT 1`,
      [dataType, fromMs, toMs],
    );
    return rows.length ? num(rows[0].v) : null;
  }
  const fn = agg === 'avg' ? 'AVG' : agg === 'max' ? 'MAX' : agg === 'min' ? 'MIN' : 'SUM';
  const [rows] = await db.query(
    `SELECT ${fn}(value) AS v FROM points
     WHERE data_type = ? AND anchor_ms >= ? AND anchor_ms < ? AND value IS NOT NULL`,
    [dataType, fromMs, toMs],
  );
  return rows.length && rows[0].v !== null ? num(rows[0].v) : null;
}

async function typeStats() {
  const [rows] = await handle().query(
    `SELECT data_type, COUNT(*) AS points, MIN(anchor_ms) AS first_ms, MAX(anchor_ms) AS last_ms
     FROM points GROUP BY data_type`,
  );
  return rows.map((r) => ({
    data_type: r.data_type, points: num(r.points), first_ms: num(r.first_ms), last_ms: num(r.last_ms),
  }));
}

async function platforms() {
  const [rows] = await handle().query(
    `SELECT platform, COUNT(*) AS n FROM points
     WHERE platform IS NOT NULL GROUP BY platform ORDER BY n DESC`,
  );
  return rows.map((r) => ({ platform: r.platform, n: num(r.n) }));
}

async function clearAll() {
  const db = handle();
  await db.query('DELETE FROM points');
  await db.query('DELETE FROM parts');
  await db.query('DELETE FROM cursors');
  await db.query('DELETE FROM events');
}

/** Re-derive value/fields/parts from stored raw JSON. See the header note. */
async function eachRaw(dataType, fn, batch = 400) {
  const db = handle();
  let offset = 0;
  for (;;) {
    const [rows] = await db.query(
      `SELECT data_type, point_id, raw FROM points
       WHERE data_type = ? ORDER BY point_id LIMIT ${batch} OFFSET ${offset}`,
      [dataType],
    );
    if (!rows.length) return;
    for (const r of rows) await fn(r);
    offset += rows.length;
  }
}

// ---------------------------------------------------------------------------
// Cursors, tokens, events, settings
// ---------------------------------------------------------------------------

function cursorRow(r) {
  if (!r) return null;
  return {
    data_type: r.data_type,
    from_ms: num(r.from_ms),
    to_ms: num(r.to_ms),
    backfill_done: num(r.backfill_done),
    last_sync_ms: num(r.last_sync_ms),
    last_error: r.last_error,
  };
}

async function getCursor(dataType) {
  const [rows] = await handle().query('SELECT * FROM cursors WHERE data_type = ?', [dataType]);
  return cursorRow(rows[0]);
}

async function allCursors() {
  const [rows] = await handle().query('SELECT * FROM cursors');
  return rows.map(cursorRow);
}

async function setCursor(dataType, patch) {
  const cur = (await getCursor(dataType)) || {
    data_type: dataType, from_ms: null, to_ms: null,
    backfill_done: 0, last_sync_ms: null, last_error: null,
  };
  const next = { ...cur, ...patch };
  await handle().query(
    `INSERT INTO cursors (data_type, from_ms, to_ms, backfill_done, last_sync_ms, last_error)
     VALUES (?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE
       from_ms = new.from_ms, to_ms = new.to_ms, backfill_done = new.backfill_done,
       last_sync_ms = new.last_sync_ms, last_error = new.last_error`,
    [dataType, next.from_ms, next.to_ms, next.backfill_done ? 1 : 0, next.last_sync_ms, next.last_error],
  );
  return next;
}

async function getTokens() {
  const [rows] = await handle().query('SELECT * FROM tokens WHERE id = 1');
  if (!rows.length) return null;
  const r = rows[0];
  return { ...r, expiry_ms: num(r.expiry_ms), connected_ms: num(r.connected_ms) };
}

async function putTokens(t) {
  await handle().query(
    `INSERT INTO tokens (id, access_token, refresh_token, expiry_ms, scope, health_user_id, legacy_user_id, connected_ms)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE
       -- EVERY field is a partial update. Callers legitimately write one field at a
       -- time — the OAuth callback stores the user id right after the token exchange
       -- — and a plain assignment there nulls whatever the caller did not pass. That
       -- is how a SUCCESSFUL login once ended up with a live refresh token and no
       -- access token, reporting "not connected" from then on.
       access_token  = COALESCE(new.access_token, tokens.access_token),
       -- A refresh grant does NOT return a refresh_token; keep the one we hold.
       refresh_token = COALESCE(new.refresh_token, tokens.refresh_token),
       expiry_ms     = COALESCE(new.expiry_ms, tokens.expiry_ms),
       scope         = COALESCE(new.scope, tokens.scope),
       health_user_id = COALESCE(new.health_user_id, tokens.health_user_id),
       legacy_user_id = COALESCE(new.legacy_user_id, tokens.legacy_user_id),
       connected_ms   = COALESCE(tokens.connected_ms, new.connected_ms)`,
    [
      t.access_token || null, t.refresh_token || null, t.expiry_ms || null,
      t.scope || null, t.health_user_id || null, t.legacy_user_id || null,
      t.connected_ms || Date.now(),
    ],
  );
}

async function clearTokens() {
  await handle().query('DELETE FROM tokens');
}

async function addEvent(kind, dataType, message, count) {
  const db = handle();
  await db.query(
    'INSERT INTO events (ts_ms, kind, data_type, message, count) VALUES (?, ?, ?, ?, ?)',
    [Date.now(), kind, dataType || null, message || null, Number.isFinite(count) ? count : null],
  );
  // Keep the log short — it is a status strip, not an audit trail.
  await db.query('DELETE FROM events WHERE id <= (SELECT * FROM (SELECT MAX(id) - 500 FROM events) x)');
}

async function recentEvents(limit = 40) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 40));
  const [rows] = await handle().query(`SELECT * FROM events ORDER BY id DESC LIMIT ${cap}`);
  return rows.map((r) => ({ ...r, ts_ms: num(r.ts_ms), count: num(r.count) }));
}

async function getSetting(key, fallback = null) {
  const [rows] = await handle().query('SELECT value FROM settings WHERE `key` = ?', [key]);
  return rows.length ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  await handle().query(
    'INSERT INTO settings (`key`, value) VALUES (?, ?) AS new ON DUPLICATE KEY UPDATE value = new.value',
    [key, String(value)],
  );
}

/**
 * Time spent in each heart-rate zone, computed in SQL.
 *
 * Zone time is not a stored metric — Google Health sends ~88k raw samples every two
 * seconds and no per-zone durations, so the duration of each sample is the gap to the
 * NEXT sample. That is a window function, and doing it in JS would mean pulling a
 * day of samples over the wire to add up numbers the database can add up in place.
 *
 * `capMs` bounds that gap: the watch comes off, leaving gaps of 20+ minutes, and
 * without a cap a single sample before a gap would bank the whole absence as time
 * spent at that heart rate.
 */
async function heartRateZones(fromMs, toMs, thresholds, bucketMs, offsetMs = 0, capMs = 60000) {
  const b = bucketExpr(bucketMs, offsetMs);
  const [t1, t2, t3, t4, t5] = thresholds;
  const [rows] = await handle().query(
    `SELECT bucket AS t, zone, SUM(dt) AS ms FROM (
       SELECT ${b} AS bucket,
              CASE WHEN value < ? THEN 1
                   WHEN value < ? THEN 2
                   WHEN value < ? THEN 3
                   WHEN value < ? THEN 4
                   WHEN value < ? THEN 5
                   ELSE 6 END AS zone,
              LEAST(GREATEST(COALESCE(LEAD(anchor_ms) OVER (ORDER BY anchor_ms) - anchor_ms, 0), 0), ?) AS dt
       FROM points
       WHERE data_type = 'heart-rate' AND anchor_ms >= ? AND anchor_ms < ? AND value IS NOT NULL
     ) z GROUP BY bucket, zone ORDER BY bucket, zone`,
    [t1, t2, t3, t4, t5, capMs, fromMs, toMs],
  );
  return rows.map((r) => ({ t: num(r.t), zone: num(r.zone), ms: num(r.ms) }));
}

/** Raw heart-rate samples, thinned to at most `maxPoints` for an intraday chart. */
async function heartRateTrace(fromMs, toMs, maxPoints = 720) {
  const span = Math.max(1, toMs - fromMs);
  // One bucket per ~2 minutes of a day; enough shape for a chart without shipping
  // 40,000 points to a browser.
  const bucket = Math.max(60000, Math.ceil(span / maxPoints / 60000) * 60000);
  const [rows] = await handle().query(
    `SELECT (FLOOR(anchor_ms / ?) * ?) AS t, AVG(value) AS v, MIN(value) AS lo, MAX(value) AS hi
     FROM points
     WHERE data_type = 'heart-rate' AND anchor_ms >= ? AND anchor_ms < ? AND value IS NOT NULL
     GROUP BY t ORDER BY t`,
    [bucket, bucket, fromMs, toMs],
  );
  return {
    bucketMs: bucket,
    points: rows.map((r) => ({ t: num(r.t), v: num(r.v), lo: num(r.lo), hi: num(r.hi) })),
  };
}

/**
 * Heart-rate samples for one insight window.
 *
 * Activity detection needs the real cadence; using the chart's thinned trace would
 * turn a visual optimization into a physiological claim. The caller is deliberately
 * limited to two days so this cannot become an unbounded export of the largest table.
 */
async function heartRateSamples(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs
    || toMs - fromMs > 2 * 86400000) {
    throw Object.assign(new Error('heart-rate sample range must be between 0 and 2 days'), { status: 400 });
  }
  const [rows] = await handle().query(
    `SELECT anchor_ms AS t, value AS v FROM points
     WHERE data_type = 'heart-rate' AND anchor_ms >= ? AND anchor_ms < ? AND value IS NOT NULL
     ORDER BY anchor_ms`,
    [fromMs, toMs],
  );
  return rows.map((row) => ({ t: num(row.t), v: num(row.v) }));
}

// A day-scale active-energy point is the fallback Google supplies when there is no
// useful interval detail. Twenty hours includes 23/25-hour civil days around DST while
// keeping even unusually long workouts in the granular set.
const DAILY_INTERVAL_MIN_MS = 20 * 3600000;

/** Duration covered by a union of half-open intervals, clipped to [fromMs, toMs). */
function coveredDuration(intervals, fromMs, toMs) {
  const clipped = intervals
    .map(({ start, end }) => [Math.max(start, fromMs), Math.min(end, toMs)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!clipped.length) return 0;

  let total = 0;
  let [start, end] = clipped[0];
  for (let i = 1; i < clipped.length; i++) {
    const [nextStart, nextEnd] = clipped[i];
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else {
      total += end - start;
      [start, end] = [nextStart, nextEnd];
    }
  }
  return total + end - start;
}

/**
 * Attribute interval-recorded energy to one activity window.
 *
 * Granular records are measured for their own intervals, so their prorated overlap is
 * used first. A day-scale point is only an estimate: use its uniform rate for portions
 * of the activity not covered by any granular interval. Merely summing both shapes
 * counts the same energy twice whenever Google returns a daily total beside detail.
 */
function attributeIntervalValue(rows, fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;

  const usable = rows.map((row) => {
    const start = num(row.start_ms ?? row.startMs);
    const end = num(row.end_ms ?? row.endMs);
    const value = num(row.value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(value) || end <= start) return null;
    const overlap = Math.min(end, toMs) - Math.max(start, fromMs);
    return overlap > 0 ? { start, end, value, duration: end - start, overlap } : null;
  }).filter(Boolean);
  if (!usable.length) return null;

  const granular = usable.filter((row) => row.duration < DAILY_INTERVAL_MIN_MS);
  const daily = usable.filter((row) => row.duration >= DAILY_INTERVAL_MIN_MS);
  let total = 0;
  let attributed = false;

  for (const row of granular) {
    total += row.value * row.overlap / row.duration;
    attributed = true;
  }

  for (const row of daily) {
    const overlapStart = Math.max(row.start, fromMs);
    const overlapEnd = Math.min(row.end, toMs);
    const granularMs = coveredDuration(granular, overlapStart, overlapEnd);
    const uncoveredMs = Math.max(0, overlapEnd - overlapStart - granularMs);
    if (!uncoveredMs) continue;
    total += row.value * uncoveredMs / row.duration;
    attributed = true;
  }

  return attributed ? total : null;
}

async function intervalValue(dataType, fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  const [rows] = await handle().query(
    `SELECT start_ms, end_ms, value
     FROM points
     WHERE data_type = ? AND value IS NOT NULL AND start_ms < ? AND end_ms > ?
     ORDER BY start_ms, end_ms`,
    [dataType, toMs, fromMs],
  );
  return attributeIntervalValue(rows, fromMs, toMs);
}

/**
 * Try to claim `name` for `ttlMs`, but only if the work has not been completed by
 * anyone within `minIntervalMs`. Returns true if this replica should do the work.
 *
 * Both conditions live in ONE atomic UPDATE, because checking them separately is the
 * classic race: two replicas read "stale" at the same instant and both proceed.
 */
async function acquireLease(name, owner, ttlMs, minIntervalMs = 0) {
  const db = handle();
  const now = Date.now();
  await db.query('INSERT IGNORE INTO leases (name, owner, expires_ms) VALUES (?, ?, 0)', [name, owner]);
  const [res] = await db.query(
    `UPDATE leases SET owner = ?, expires_ms = ?
     WHERE name = ?
       AND expires_ms <= ?
       AND (last_done_ms IS NULL OR last_done_ms <= ?)`,
    [owner, now + ttlMs, name, now, now - minIntervalMs],
  );
  return res.affectedRows === 1;
}

/** Mark the work done and release, so the next window is timed from completion. */
async function releaseLease(name, owner, done = true) {
  const now = Date.now();
  await handle().query(
    `UPDATE leases SET expires_ms = 0, last_done_ms = IF(?, ?, last_done_ms)
     WHERE name = ? AND owner = ?`,
    [done ? 1 : 0, now, name, owner],
  );
}

async function leaseState(name) {
  const [rows] = await handle().query('SELECT * FROM leases WHERE name = ?', [name]);
  if (!rows.length) return null;
  const r = rows[0];
  return { name: r.name, owner: r.owner, expires_ms: num(r.expires_ms), last_done_ms: num(r.last_done_ms) };
}

// ---------------------------------------------------------------------------
// Strength log
// ---------------------------------------------------------------------------

async function strengthAdd({ tsMs, exercise, sets, reps, weightKg, note }) {
  const s = Math.round(Number(sets));
  const r = Math.round(Number(reps));
  const w = Number(weightKg);
  const t = Number(tsMs) || Date.now();
  const name = String(exercise || '').trim().slice(0, 80);
  if (!name || !Number.isFinite(s) || s < 1 || s > 50
    || !Number.isFinite(r) || r < 1 || r > 200
    || !Number.isFinite(w) || w < 0 || w > 1000) {
    throw Object.assign(new Error('strength entry needs exercise, sets 1–50, reps 1–200, weight 0–1000 kg'), { status: 400 });
  }
  const volume = s * r * w;
  const [res] = await handle().query(
    `INSERT INTO strength_log (ts_ms, exercise, sets, reps, weight_kg, volume_kg, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [t, name, s, r, w, volume, note ? String(note).slice(0, 500) : null],
  );
  return { id: res.insertId, ts_ms: t, exercise: name, sets: s, reps: r, weight_kg: w, volume_kg: volume };
}

async function strengthList(fromMs, toMs) {
  const [rows] = await handle().query(
    'SELECT * FROM strength_log WHERE ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms DESC LIMIT 500',
    [fromMs, toMs],
  );
  return rows.map((r) => ({
    id: num(r.id), ts_ms: num(r.ts_ms), exercise: r.exercise,
    sets: num(r.sets), reps: num(r.reps), weight_kg: num(r.weight_kg),
    volume_kg: num(r.volume_kg), note: r.note,
  }));
}

async function strengthDelete(id) {
  const [res] = await handle().query('DELETE FROM strength_log WHERE id = ?', [Number(id)]);
  return res.affectedRows === 1;
}

/** Cheap liveness probe for the load balancer's health check. */
async function ping() {
  const [rows] = await handle().query('SELECT 1 AS ok');
  return rows.length === 1;
}

module.exports = {
  open, handle, close, config, ping,
  acquireLease, releaseLease, leaseState,
  heartRateZones, heartRateTrace, heartRateSamples, intervalValue, attributeIntervalValue,
  putPoints, series, stackedSeries, rawPoints, latest, aggregate,
  typeStats, platforms, clearAll, eachRaw, rawPointsWithRaw,
  getCursor, allCursors, setCursor,
  getTokens, putTokens, clearTokens,
  addEvent, recentEvents,
  getSetting, setSetting,
  strengthAdd, strengthList, strengthDelete,
};
