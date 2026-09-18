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
// catalog is a pure data module (it requires nothing), so this cannot cycle back.
const catalog = require('./catalog');

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
    KEY idx_points_type_time_value (data_type, anchor_ms, value)
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

  /**
   * Per-minute heart-rate rollup — the one materialized view this app keeps.
   *
   * Heart rate arrives as ~2-second PPG: 1.2M rows and 800 MB after five weeks,
   * growing ~34k rows a day. Every derived figure on every screen (sleeping HR,
   * the personal reference band, the intraday trace, any hourly/daily HR series)
   * re-derived itself from those raw samples, and MySQL answers such a scan by
   * walking the CLUSTERED index — which carries `raw` inline. Measured: the
   * sleeping-HR decile took 2.9s, the reference band 2.7s, an hourly series over
   * the whole history 3.1s. Off this table the same three answer in 35ms, 18ms
   * and 42ms, VALUE-FOR-VALUE IDENTICAL, because each of them was already
   * averaging up to whole minutes.
   *
   * It stores sums and counts, never a pre-divided average: a five-minute bucket
   * is SUM(sum_v)/SUM(n), which is the mean of the samples, whereas an average of
   * per-minute averages would silently weight a sparse minute like a full one.
   *
   * It is a projection, never a source. `points` stays authoritative; putPoints
   * rebuilds every minute it touched straight from `points`, so Google's
   * restatement, a renormalize and a demo load all repair it for free.
   */
  `CREATE TABLE IF NOT EXISTS hr_minute (
    minute_ms BIGINT NOT NULL,
    sum_v     DOUBLE NOT NULL,
    n         INT    NOT NULL,
    min_v     DOUBLE NOT NULL,
    max_v     DOUBLE NOT NULL,
    PRIMARY KEY (minute_ms)
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
  // Migration for databases created before the covering index. (data_type,
  // anchor_ms) alone sent every series/aggregate through a row lookup into rows
  // carrying the full `raw` JSON — 1.2s for one day of heart rate; covering
  // `value` made the same query 25ms. The old index is dropped because it is a
  // strict prefix of the new one: keeping both would double index maintenance on
  // the hottest write path for zero read benefit.
  await pool.query('ALTER TABLE points ADD INDEX idx_points_type_time_value (data_type, anchor_ms, value)')
    .catch((e) => { if (e.code !== 'ER_DUP_KEYNAME') throw e; });
  await pool.query('ALTER TABLE points DROP INDEX idx_points_type_time')
    .catch((e) => { if (e.code !== 'ER_CANT_DROP_FIELD_OR_KEY') throw e; });
  // `SELECT platform, COUNT(*) ... GROUP BY platform` had no index at all, so the
  // status strip — fetched on every page load and polled every 30 seconds — ran a
  // full scan of the 800 MB table: 3.55s measured, 195ms on this index.
  await pool.query('ALTER TABLE points ADD INDEX idx_points_platform (platform)')
    .catch((e) => { if (e.code !== 'ER_DUP_KEYNAME') throw e; });
  await backfillHrMinute(pool);
  return pool;
}

/**
 * Bring `hr_minute` up to date with `points`, for the range it does not yet cover.
 *
 * Runs at boot. A fresh database and a database written before this table existed
 * are the same case, so this is a rebuild of whatever is missing rather than a
 * one-shot migration: it walks from the last minute already rolled up (re-doing
 * that minute, which may have been half-written) to the newest sample there is.
 * Empty table + five weeks of history measured 1.2s; steady state is a no-op.
 */
async function backfillHrMinute(p) {
  const [[covered]] = await p.query('SELECT MAX(minute_ms) AS m FROM hr_minute');
  const [[have]] = await p.query(
    `SELECT MAX(anchor_ms) AS m FROM points FORCE INDEX (idx_points_type_time_value)
     WHERE data_type = 'heart-rate'`,
  );
  if (have.m === null) return;
  const from = covered.m === null ? -1 : Number(covered.m);
  if (Number(have.m) < from) return;
  await p.query(
    `REPLACE INTO hr_minute (minute_ms, sum_v, n, min_v, max_v)
     SELECT FLOOR(anchor_ms / 60000) * 60000, SUM(value), COUNT(*), MIN(value), MAX(value)
     FROM points FORCE INDEX (idx_points_type_time_value)
     WHERE data_type = 'heart-rate' AND anchor_ms >= ? AND value IS NOT NULL
     GROUP BY 1`,
    [from],
  );
}

// ---------------------------------------------------------------------------
// Read memo
//
// Three read shapes dominate every screen render and cannot be made cheap in SQL:
// zone time re-derives durations from ~600k two-second samples through a window
// function (4.7s), the personal reference band takes quantiles over 28 days of
// bucket averages, and typeStats groups the whole table for every 30-second
// status poll. All three answer with data that a 5-minute sync cadence cannot
// meaningfully change faster than the TTLs below, so each replica remembers its
// last answer instead of re-deriving it per request.
//
// Per-process on purpose: replicas would need shared invalidation to share a
// cache, and a per-replica stale window bounded by TTL is exactly as stale as
// the sync cadence already makes everything else.
// ---------------------------------------------------------------------------

// stats can be long: putPoints invalidates it on every write, so the TTL only
// bounds staleness while nothing is being written — and nothing writes, nothing
// changes. At 60s the whole-table group scans re-ran once a minute per replica,
// which is exactly the 1.4s /api/status the access logs showed the user eating.
const MEMO_TTLS = { zones: 5 * 60000, zonesDaily: 3600000, band: 6 * 3600000, stats: 30 * 60000, read: 5 * 60000 };
const memoStore = new Map();

/**
 * Memo keys quantize timestamps to the minute. Screen windows end at Date.now(),
 * so the raw arguments mint a fresh key every request and the cache never hits;
 * a key rounded to 60s serves the same answer to every request in that minute,
 * trailing reality by at most the quantum — well inside what the TTLs and the
 * 5-minute sync cadence already concede.
 */
const qMs = (v) => (typeof v === 'number' && v > 1e10 ? Math.floor(v / 60000) : v);

async function memoized(kind, keyParts, fn, coversToMs) {
  const key = `${kind}:${keyParts.map(qMs).join(',')}`;
  const hit = memoStore.get(key);
  if (hit && Date.now() < hit.until) return hit.value;
  const value = await fn();
  memoStore.set(key, { value, until: Date.now() + MEMO_TTLS[kind], coversToMs });
  // The store cannot grow past the handful of key shapes the screens use, but a
  // date-scrubbing user mints new day windows; cap it rather than trust that.
  if (memoStore.size > 500) {
    for (const [k, v] of memoStore) if (Date.now() >= v.until) memoStore.delete(k);
    if (memoStore.size > 500) memoStore.clear();
  }
  return value;
}

function memoInvalidate(prefix = '') {
  for (const k of memoStore.keys()) if (k.startsWith(prefix)) memoStore.delete(k);
}

/**
 * Drop the memo entries a write could have changed, and ONLY those.
 *
 * Every entry that passes a `coversToMs` is an aggregate over `anchor_ms < that`,
 * so a write whose oldest touched anchor is at or after it cannot have moved a
 * single row inside that window. `oldestMs` is taken over both the incoming
 * anchors AND the anchors those point ids held before the write, so a restatement
 * that moves a point to a different day still invalidates the day it left.
 *
 * This is what makes the cache worth having. The tail re-reads 36 hours every five
 * minutes and rewrites points every time, so a blanket invalidation meant the
 * memo was empty for the first visitor of every five-minute period — the cold path
 * was the normal path. Now only windows that reach into the restated tail reload.
 * An entry with no `coversToMs` (the whole-table stats) is always dropped.
 */
function memoInvalidateSince(prefix, oldestMs) {
  for (const [k, v] of memoStore) {
    if (!k.startsWith(prefix)) continue;
    if (Number.isFinite(v.coversToMs) && Number.isFinite(oldestMs) && v.coversToMs <= oldestMs) continue;
    memoStore.delete(k);
  }
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
 * Merge a sorted list of minute stamps into contiguous ranges, joining runs less
 * than `gapMs` apart. A sync writes a continuous window, so this collapses a
 * thousand touched minutes into one or two range queries — and re-rolling a few
 * untouched minutes inside a run costs nothing and computes the same values.
 */
function minuteRuns(minutes, gapMs = 30 * 60000) {
  const sorted = [...minutes].sort((a, b) => a - b);
  const runs = [];
  for (const m of sorted) {
    const last = runs[runs.length - 1];
    if (last && m - last.to <= gapMs) last.to = m;
    else runs.push({ from: m, to: m });
  }
  return runs;
}

/** Rebuild `hr_minute` for every minute a write touched, straight from `points`. */
async function rollUpHrMinutes(db, minutes) {
  for (const run of minuteRuns(minutes)) {
    await db.query(
      `REPLACE INTO hr_minute (minute_ms, sum_v, n, min_v, max_v)
       SELECT FLOOR(anchor_ms / 60000) * 60000, SUM(value), COUNT(*), MIN(value), MAX(value)
       FROM points FORCE INDEX (idx_points_type_time_value)
       WHERE data_type = 'heart-rate' AND anchor_ms >= ? AND anchor_ms < ? AND value IS NOT NULL
       GROUP BY 1`,
      [run.from, run.to + 60000],
    );
  }
}

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
  // A write makes the bucketed reads it TOUCHED stale immediately — this is what
  // keeps a manual "Sync now" honest, since the read TTL alone would hide its points
  // for up to five minutes. Which entries those are can only be decided once the
  // pre-write anchors are known, so read:/band: are pruned at the end of this
  // function (memoInvalidateSince) rather than emptied here. Whole-table stats carry
  // no window and go now.
  memoInvalidate('stats:');
  const db = handle();
  const now = Date.now();
  let fresh = 0;
  // The oldest anchor this write touches — over the incoming rows AND over the rows
  // being overwritten, because a restatement can move a point to a different day and
  // the day it LEFT changes too. Windows that end before this cannot be affected.
  let oldest = Infinity;
  for (const r of rows) {
    const anchor = Number.isFinite(r.anchorMs) ? r.anchorMs : r.startMs;
    if (Number.isFinite(anchor) && anchor < oldest) oldest = anchor;
  }

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
        'SELECT point_id, anchor_ms FROM points WHERE data_type = ? AND point_id IN (?)',
        [dataType, ids],
      );
      for (const row of found) {
        existing.add(`${dataType}\0${row.point_id}`);
        const prev = num(row.anchor_ms);
        if (Number.isFinite(prev) && prev < oldest) oldest = prev;
      }
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
    // Deletion is per-type with that type's OWN ids — the whole batch's id list
    // against every type would fan out N× and could clip an unrelated type's row
    // if a point id were ever reused across types.
    const withParts = batch.filter((r) => r.parts && Object.keys(r.parts).length);
    for (const [dataType, ids] of byType) {
      await db.query('DELETE FROM parts WHERE data_type = ? AND point_id IN (?)',
        [dataType, ids]);
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

  // The rollup is rebuilt AFTER the upserts, from `points` — so a restated sample
  // (Google rewrites a whole day when the watch syncs late) corrects it, and a
  // failure here can never leave a half-applied write behind.
  const touched = new Set();
  for (const r of rows) {
    if (r.dataType !== 'heart-rate') continue;
    const anchor = Number.isFinite(r.anchorMs) ? r.anchorMs : r.startMs;
    if (Number.isFinite(anchor)) touched.add(Math.floor(anchor / 60000) * 60000);
  }
  if (touched.size) await rollUpHrMinutes(db, touched);

  // Only now, with the pre-write anchors known, can the read memos be pruned by
  // range rather than emptied. A five-minute tail sync leaves everything that ends
  // before the restated window intact — which is most of every screen.
  memoInvalidateSince('read:', oldest);
  memoInvalidateSince('band:', oldest);

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
  return memoized('read', ['series', dataType, fromMs, toMs, bucketMs, agg, offsetMs],
    () => seriesUncached(dataType, fromMs, toMs, bucketMs, agg, offsetMs), toMs);
}

/**
 * Whether a heart-rate read can be answered from `hr_minute` instead of the raw
 * samples. Only when the buckets are whole minutes and land on minute boundaries —
 * otherwise a bucket would cut a minute in half and the rollup could not say which
 * samples fell on which side. Measured identical, not assumed: see test/run.js.
 */
function hrRollupUsable(dataType, bucketMs, offsetMs) {
  return dataType === 'heart-rate'
    && Number.isFinite(bucketMs) && bucketMs >= 60000 && bucketMs % 60000 === 0
    && Number(offsetMs) % 60000 === 0;
}

/** `hr_minute`'s equivalent of bucketExpr, over minute_ms. */
function minuteBucketExpr(bucketMs, offsetMs) {
  return `(FLOOR((minute_ms + ${Number(offsetMs)}) / ${Number(bucketMs)}) * ${Number(bucketMs)} - ${Number(offsetMs)})`;
}

async function seriesUncached(dataType, fromMs, toMs, bucketMs, agg, offsetMs) {
  const db = handle();
  const b = bucketExpr(bucketMs, offsetMs);

  // An hourly heart-rate series over the whole history: 3088ms off `points`, 42ms
  // here, row-for-row identical. `SUM(sum_v)/SUM(n)` is the mean of the SAMPLES —
  // averaging the per-minute means would weight a sparse minute like a full one.
  if (hrRollupUsable(dataType, bucketMs, offsetMs) && ['avg', 'min', 'max'].includes(agg)) {
    const mb = minuteBucketExpr(bucketMs, offsetMs);
    const fn = agg === 'avg' ? 'SUM(sum_v) / SUM(n)' : agg === 'min' ? 'MIN(min_v)' : 'MAX(max_v)';
    const [rows] = await db.query(
      `SELECT ${mb} AS t, ${fn} AS v, MIN(min_v) AS lo, MAX(max_v) AS hi, SUM(n) AS n
       FROM hr_minute WHERE minute_ms >= ? AND minute_ms < ?
       GROUP BY t ORDER BY t`,
      [fromMs, toMs],
    );
    return rows.map((r) => ({ t: num(r.t), v: num(r.v), lo: num(r.lo), hi: num(r.hi), n: num(r.n) }));
  }

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

/**
 * The p10 / median / p90 of a type's BUCKET AVERAGES over a window — one row out,
 * not one per bucket.
 *
 * This is the reference band behind an intraday chart ("is today normal for me"),
 * and it has to be computed at the same bucket size the chart draws, or the two are
 * not comparable: quantiles of raw one-minute samples are far wider than quantiles
 * of five-minute averages, and painting the wider band behind the narrower line
 * makes an ordinary day look becalmed.
 *
 * Done in SQL because the honest window is weeks long — 14 days of five-minute
 * heart-rate buckets is ~4,000 rows to ship to Node just to take three quantiles of.
 * PERCENT_RANK is used rather than PERCENTILE_CONT, which MySQL does not have.
 */
async function bucketBand(dataType, fromMs, toMs, bucketMs, offsetMs = 0) {
  return memoized('band', [dataType, fromMs, toMs, bucketMs, offsetMs],
    () => bucketBandUncached(dataType, fromMs, toMs, bucketMs, offsetMs), toMs);
}

async function bucketBandUncached(dataType, fromMs, toMs, bucketMs, offsetMs) {
  const db = handle();
  const b = bucketExpr(bucketMs, offsetMs);
  // The only caller is heart rate at five-minute buckets — 2730ms off `points`,
  // 18ms here, to the same three quantiles.
  const buckets = hrRollupUsable(dataType, bucketMs, offsetMs)
    ? `SELECT SUM(sum_v) / SUM(n) AS v FROM hr_minute
       WHERE minute_ms >= ? AND minute_ms < ? GROUP BY ${minuteBucketExpr(bucketMs, offsetMs)}`
    : null;
  if (buckets) {
    const [rows] = await db.query(
      `SELECT
         MAX(CASE WHEN pr <= 0.10 THEN v END) AS p10,
         MAX(CASE WHEN pr <= 0.50 THEN v END) AS median,
         MAX(CASE WHEN pr <= 0.90 THEN v END) AS p90,
         COUNT(*) AS n
       FROM (SELECT v, PERCENT_RANK() OVER (ORDER BY v) AS pr FROM (${buckets}) buckets) ranked`,
      [fromMs, toMs],
    );
    return bandRow(rows[0]);
  }
  const [rows] = await db.query(
    `SELECT
       MAX(CASE WHEN pr <= 0.10 THEN v END) AS p10,
       MAX(CASE WHEN pr <= 0.50 THEN v END) AS median,
       MAX(CASE WHEN pr <= 0.90 THEN v END) AS p90,
       COUNT(*) AS n
     FROM (
       SELECT v, PERCENT_RANK() OVER (ORDER BY v) AS pr FROM (
         SELECT AVG(value) AS v
         FROM points
         WHERE data_type = ? AND anchor_ms >= ? AND anchor_ms < ? AND value IS NOT NULL
         GROUP BY ${b}
       ) buckets
     ) ranked`,
    [dataType, fromMs, toMs],
  );
  return bandRow(rows[0]);
}

/**
 * PERCENT_RANK gives the FIRST row a rank of 0, so a single bucket yields a band
 * of zero width. Too little history is no band at all, not a false-precision one.
 */
function bandRow(r) {
  if (!r || !r.n || num(r.n) < 12) return null;
  return { p10: num(r.p10), median: num(r.median), p90: num(r.p90), n: num(r.n) };
}

/** Stacked series (sleep stages, HR zones): one row per bucket per component key. */
async function stackedSeries(dataType, fromMs, toMs, bucketMs, offsetMs = 0) {
  return memoized('read', ['stacked', dataType, fromMs, toMs, bucketMs, offsetMs],
    () => stackedSeriesUncached(dataType, fromMs, toMs, bucketMs, offsetMs), toMs);
}

async function stackedSeriesUncached(dataType, fromMs, toMs, bucketMs, offsetMs) {
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
  return memoized('read', ['agg', dataType, fromMs, toMs, agg],
    () => aggregateUncached(dataType, fromMs, toMs, agg), toMs);
}

async function aggregateUncached(dataType, fromMs, toMs, agg) {
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
  return memoized('stats', [], typeStatsUncached);
}

/**
 * Per-type first/last timestamp, WITHOUT the point count.
 *
 * Every caller outside the status strip used `points` only as "does this type have
 * any data", and that one column is what made the query expensive: COUNT(*) cannot
 * be answered without walking all 1.2M index entries (440ms), while MIN/MAX per type
 * are two index dives. Asking per type, in one UNION, turns the whole thing into 28
 * dives — 10ms — and `first_ms === null` is exactly the same test as `points === 0`,
 * since anchor_ms is NOT NULL.
 */
async function typeRange() {
  return memoized('stats', ['ranges'], typeRangeUncached);
}

async function typeRangeUncached() {
  const ids = catalog.all().map((t) => t.id);
  if (!ids.length) return [];
  const sql = ids
    .map(() => 'SELECT ? AS data_type, MIN(anchor_ms) AS first_ms, MAX(anchor_ms) AS last_ms FROM points WHERE data_type = ?')
    .join(' UNION ALL ');
  const [rows] = await handle().query(sql, ids.flatMap((id) => [id, id]));
  return rows.map((r) => ({
    data_type: r.data_type,
    first_ms: num(r.first_ms),
    last_ms: num(r.last_ms),
    hasData: r.first_ms !== null,
  }));
}

/**
 * How many points one type holds. Cheap for a small type (an index range scan over
 * just that type's entries) and the honest answer where a count is actually being
 * REPORTED rather than tested for zero — `exercise` is 49 rows, not 1.2M.
 */
async function typeCount(dataType) {
  return memoized('stats', ['count', dataType], async () => {
    const [rows] = await handle().query(
      'SELECT COUNT(*) AS n FROM points FORCE INDEX (idx_points_type_time_value) WHERE data_type = ?',
      [dataType],
    );
    return num(rows[0].n);
  });
}

async function typeStatsUncached() {
  const [rows] = await handle().query(
    `SELECT data_type, COUNT(*) AS points, MIN(anchor_ms) AS first_ms, MAX(anchor_ms) AS last_ms
     FROM points GROUP BY data_type`,
  );
  return rows.map((r) => ({
    data_type: r.data_type, points: num(r.points), first_ms: num(r.first_ms), last_ms: num(r.last_ms),
  }));
}

async function platforms() {
  return memoized('stats', ['platforms'], platformsUncached);
}

async function platformsUncached() {
  const [rows] = await handle().query(
    `SELECT platform, COUNT(*) AS n FROM points
     WHERE platform IS NOT NULL GROUP BY platform ORDER BY n DESC`,
  );
  return rows.map((r) => ({ platform: r.platform, n: num(r.n) }));
}

async function clearAll() {
  memoInvalidate();
  const db = handle();
  await db.query('DELETE FROM points');
  await db.query('DELETE FROM parts');
  // The rollup is a projection of `points`: leaving it behind would let a cleared
  // store still answer with the old account's heart rate.
  await db.query('DELETE FROM hr_minute');
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

/**
 * Patch a cursor ATOMICALLY — no read-modify-write. The tail and backfill leases
 * are separate, so two replicas can legitimately write the same cursor at once; a
 * JS-side merge lets the loser overwrite the winner (a replayed chunk, or a hole
 * in the backfill). Fields absent from `patch` are left untouched; `from_ms` only
 * ever moves BACKWARD (both tail and backfill extend history) and `to_ms` only
 * forward, enforced in SQL so concurrent writers compose instead of racing.
 */
async function setCursor(dataType, patch) {
  const has = (k) => Object.hasOwn(patch, k);
  const sets = [];
  if (has('from_ms')) sets.push('from_ms = LEAST(COALESCE(cursors.from_ms, new.from_ms), new.from_ms)');
  if (has('to_ms')) sets.push('to_ms = GREATEST(COALESCE(cursors.to_ms, new.to_ms), new.to_ms)');
  if (has('backfill_done')) sets.push('backfill_done = new.backfill_done');
  if (has('last_sync_ms')) sets.push('last_sync_ms = new.last_sync_ms');
  if (has('last_error')) sets.push('last_error = new.last_error');
  if (!sets.length) return getCursor(dataType);
  await handle().query(
    `INSERT INTO cursors (data_type, from_ms, to_ms, backfill_done, last_sync_ms, last_error)
     VALUES (?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE ${sets.join(', ')}`,
    [
      dataType,
      has('from_ms') ? patch.from_ms : null,
      has('to_ms') ? patch.to_ms : null,
      has('backfill_done') && patch.backfill_done ? 1 : 0,
      has('last_sync_ms') ? patch.last_sync_ms : null,
      has('last_error') ? patch.last_error : null,
    ],
  );
  return getCursor(dataType);
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
  // Day-bucketed zone series cover PAST days (their windows end on a day
  // boundary), which only change through Google's 36h restatement — an hour of
  // staleness on a daily TRIMP bar is invisible, and this is the 4.7s query.
  // Intraday and session windows keep the sync-cadence TTL.
  const kind = bucketMs >= 86400000 ? 'zonesDaily' : 'zones';
  return memoized(kind, [fromMs, toMs, thresholds.join('|'), bucketMs, offsetMs, capMs],
    () => heartRateZonesUncached(fromMs, toMs, thresholds, bucketMs, offsetMs, capMs), toMs);
}

async function heartRateZonesUncached(fromMs, toMs, thresholds, bucketMs, offsetMs, capMs) {
  // FORCE INDEX, and it is not a micro-optimisation: the optimiser costs a scan of
  // the CLUSTERED index (which carries `raw` inline, 800 MB) as cheaper than the
  // covering index and picks it, because its cost model does not charge for the
  // LONGTEXT pages it drags through a 128 MB buffer pool. Measured on 28 days:
  // 7538ms its way, 5336ms this way, identical rows. This is the one HR figure the
  // rollup cannot serve — a zone is decided per SAMPLE, and a minute's mean would
  // smear samples across zone boundaries — so it stays on the raw stream, memoized.
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
       FROM points FORCE INDEX (idx_points_type_time_value)
       WHERE data_type = 'heart-rate' AND anchor_ms >= ? AND anchor_ms < ? AND value IS NOT NULL
     ) z GROUP BY bucket, zone ORDER BY bucket, zone`,
    [t1, t2, t3, t4, t5, capMs, fromMs, toMs],
  );
  return rows.map((r) => ({ t: num(r.t), zone: num(r.zone), ms: num(r.ms) }));
}

/**
 * Sleeping heart rate per civil day: the mean of the LOWEST DECILE of one-minute
 * heart-rate averages inside the night window [day 22:00, day+1 08:00) — the
 * night that ENDS on the returned day, so it lines up with sleep's wake anchor.
 *
 * A single-sample minimum of two-second PPG data is an artefact, not a level;
 * the decile of per-minute means is the standard approximation (Cadence's
 * RestingHrDerivation, Fitbit's own sleeping-HR method). Sixty measured minutes
 * or the night is null. One query for a whole baseline window, so the current
 * value, its 28-day history and the assistant's digest all take the SAME number
 * from the SAME window — the previous three windows disagreed with each other.
 */
async function sleepingHeartRateDaily(fromDayMs, toDayMs, offsetMs = 0, { minMinutes = 60, decile = 0.1 } = {}) {
  // A window whose last night ended more than half a day ago only changes through
  // Google's restatement, so it can hold for an hour like a daily zone series;
  // a window that includes last night follows the sync cadence.
  const kind = toDayMs - 16 * 3600000 < Date.now() - 12 * 3600000 ? 'zonesDaily' : 'read';
  return memoized(kind, ['sleepingHr', fromDayMs, toDayMs, offsetMs, minMinutes, decile],
    () => sleepingHeartRateDailyUncached(fromDayMs, toDayMs, offsetMs, minMinutes, decile), toDayMs);
}

async function sleepingHeartRateDailyUncached(fromDayMs, toDayMs, offsetMs, minMinutes, decile) {
  const DAY = 86400000;
  const HOUR = 3600000;
  // Shift by 2 h so a 22:00 sample buckets into the NEXT civil day (its wake day).
  const shifted = Number(offsetMs) + 2 * HOUR;
  const dayExpr = `(FLOOR((anchor_ms + ${shifted}) / ${DAY}) * ${DAY} - ${Number(offsetMs)})`;
  // The inner query used to group 1.2M raw samples into per-minute means before
  // ranking them — 2875ms. `hr_minute` IS that inner grouping, kept up to date at
  // write time, so the same 28 rows come back in 35ms with identical values.
  const [rows] = await handle().query(
    `SELECT day AS t, AVG(m) AS v, MAX(cnt) AS n FROM (
       SELECT day, m,
              ROW_NUMBER() OVER (PARTITION BY day ORDER BY m) AS rn,
              COUNT(*) OVER (PARTITION BY day) AS cnt
       FROM (
         SELECT ${dayExpr.replace('anchor_ms', 'minute_ms')} AS day, sum_v / n AS m
         FROM hr_minute
         WHERE minute_ms >= ? AND minute_ms < ?
           AND MOD(FLOOR((minute_ms + ${shifted}) / ${HOUR}), 24) < 10
       ) minutes
     ) ranked
     WHERE cnt >= ? AND rn <= CEIL(cnt * ?)
     GROUP BY day ORDER BY day`,
    [fromDayMs - 2 * HOUR, toDayMs - 16 * HOUR, minMinutes, decile],
  );
  return rows.map((r) => ({ t: num(r.t), v: num(r.v), n: num(r.n) }));
}

/** Raw heart-rate samples, thinned to at most `maxPoints` for an intraday chart. */
async function heartRateTrace(fromMs, toMs, maxPoints = 720) {
  return memoized('read', ['trace', fromMs, toMs, maxPoints],
    () => heartRateTraceUncached(fromMs, toMs, maxPoints), toMs);
}

async function heartRateTraceUncached(fromMs, toMs, maxPoints) {
  const span = Math.max(1, toMs - fromMs);
  // One bucket per ~2 minutes of a day; enough shape for a chart without shipping
  // 40,000 points to a browser.
  const bucket = Math.max(60000, Math.ceil(span / maxPoints / 60000) * 60000);
  // `bucket` is always a whole number of minutes (see above), so the rollup can
  // answer this exactly: the mean over its sums and counts, and the true per-sample
  // min/max — not the min/max of per-minute means, which would flatten the range.
  const [rows] = await handle().query(
    `SELECT (FLOOR(minute_ms / ?) * ?) AS t, SUM(sum_v) / SUM(n) AS v,
            MIN(min_v) AS lo, MAX(max_v) AS hi
     FROM hr_minute
     WHERE minute_ms >= ? AND minute_ms < ?
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
  heartRateZones, heartRateTrace, heartRateSamples, sleepingHeartRateDaily, intervalValue, attributeIntervalValue,
  putPoints, series, stackedSeries, bucketBand, rawPoints, latest, aggregate,
  typeStats, typeRange, typeCount, platforms, clearAll, eachRaw, rawPointsWithRaw,
  getCursor, allCursors, setCursor,
  getTokens, putTokens, clearTokens,
  addEvent, recentEvents,
  getSetting, setSetting,
  strengthAdd, strengthList, strengthDelete,
};
