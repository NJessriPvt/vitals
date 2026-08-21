'use strict';
/**
 * Tests for the parts that fail silently in production.
 *
 * The bias here is deliberate: these cover the things whose failure mode is a chart
 * that looks fine and is wrong (filter syntax, window chunking, restatement,
 * timezone bucketing) plus the webhook's auth ordering, which fails registration
 * rather than at runtime. Rendering is checked by looking at the page.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// .env so a developer's tunnel settings are picked up without exporting anything.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

/**
 * Storage tests need a real MySQL, which a Docker build does not have — and the
 * Dockerfile runs this suite as a build gate. So they are SKIPPED, loudly, when no
 * database is reachable, and the pure tests (naming, filters, chunking, normalizing,
 * webhook auth) still gate every build. They never touch the live `vitals` schema:
 * VITALS_TEST_DATABASE is a separate database that gets truncated on entry.
 */
const TEST_DATABASE = process.env.VITALS_TEST_DATABASE || 'vitals_test';
let dbReady = false;

const catalog = require('../lib/catalog');
const health = require('../lib/health');
const normalize = require('../lib/normalize');
const db = require('../lib/db');
const query = require('../lib/query');
const webhook = require('../lib/webhook');
const views = require('../lib/views');
const metrics = require('../lib/metrics');
const insights = require('../lib/insights');
const demo = require('../lib/demo');
const stats = require('../lib/stats');
const nightlib = require('../lib/night');
const scores = require('../lib/scores');
const training = require('../lib/training');
const trends = require('../lib/trends');
const goals = require('../lib/goals');
const screens = require('../lib/screens');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('use testAsync for async tests');
    passed++;
  } catch (err) {
    failures.push([name, err]);
  }
}

const asyncTests = [];
function testAsync(name, fn) { asyncTests.push([name, fn]); }

// Async tests that need a live database; skipped when none is reachable.
const DB_BACKED = new Set(["restated points upsert instead of doubling the total", "day buckets follow the viewer offset, not UTC", "stacked parts are replaced wholesale on restatement", "avg never sums: a bucketed heart rate stays a rate", "last takes the newest reading in the bucket", "a partial token write never nulls the fields it did not pass", "a second replica does not simply take its turn", "two bedtimes either side of midnight land on different days", "sparse metrics keep their real spacing on the time axis", "denseBuckets never invents a bucket outside the range", "out-of-range zone time is stored but kept out of the stack", "the delta compares against the previous equal-length period", "overview reports sleep in hours, not scaled twice", "zone bands come from 220 - age and cover the range", "activity calories use the database interval rows", "fitness age integrates recent database trends", "strength log validates, stores and deletes entries", "screen payloads survive an empty database", "daily load prefers device zone minutes and marks rest days zero"]);

// ---------------------------------------------------------------------------
// catalog — the filter field is per record type and a wrong one is a 400
// ---------------------------------------------------------------------------

test('filter field follows the record type', () => {
  const from = Date.UTC(2026, 4, 14);
  const to = Date.UTC(2026, 4, 15);

  assert.strictEqual(
    catalog.timeRangeFilter(catalog.get('steps'), from, to),
    'steps.interval.start_time >= "2026-05-14T00:00:00Z" AND steps.interval.start_time < "2026-05-15T00:00:00Z"',
  );
  assert.match(catalog.timeRangeFilter(catalog.get('heart-rate'), from, to),
    /^heart_rate\.sample_time\.physical_time >=/);
  assert.match(catalog.timeRangeFilter(catalog.get('sleep'), from, to),
    /^sleep\.interval\.end_time >=/);
});

test('daily types filter on a civil date, never a timestamp', () => {
  const f = catalog.timeRangeFilter(catalog.get('daily-resting-heart-rate'),
    Date.UTC(2026, 4, 14), Date.UTC(2026, 4, 15));
  assert.strictEqual(f,
    'daily_resting_heart_rate.date >= "2026-05-14" AND daily_resting_heart_rate.date < "2026-05-15"');
  assert.ok(!f.includes('T00:00:00Z'), 'daily filter must not carry a time');
});

test('multi-word types use snake_case in the filter and kebab-case as the id', () => {
  const t = catalog.get('active-zone-minutes');
  assert.strictEqual(t.id, 'active-zone-minutes');
  assert.strictEqual(t.snake, 'active_zone_minutes');
  assert.ok(catalog.timeRangeFilter(t, 0, 1).startsWith('active_zone_minutes.'));
});

test('scopes are deduplicated and always include profile', () => {
  const s = catalog.scopesFor(['steps', 'distance', 'sleep']);
  assert.strictEqual(new Set(s).size, s.length);
  assert.ok(s.some((x) => x.endsWith('.profile.readonly')));
  assert.ok(s.some((x) => x.endsWith('.activity_and_fitness.readonly')));
  assert.ok(s.some((x) => x.endsWith('.sleep.readonly')));
});

// ---------------------------------------------------------------------------
// health — window chunking against the documented max query range
// ---------------------------------------------------------------------------

test('chunks never exceed the type max window and cover the range', () => {
  const to = Date.UTC(2026, 7, 1);
  const from = to - 365 * 86400000;

  for (const id of ['steps', 'heart-rate']) {
    const type = catalog.get(id);
    const cs = health.chunks(type, from, to);
    const maxMs = type.maxDays * 86400000;
    for (const [a, b] of cs) assert.ok(b - a <= maxMs, `${id}: chunk longer than ${type.maxDays}d`);
    assert.strictEqual(cs[0][1], to, 'newest chunk first');
    assert.strictEqual(cs[cs.length - 1][0], from, 'oldest chunk reaches the start');
    // Contiguous, no gaps — a gap is silently missing data.
    for (let i = 1; i < cs.length; i++) assert.strictEqual(cs[i][1], cs[i - 1][0]);
  }
  assert.ok(health.chunks(catalog.get('heart-rate'), from, to).length > 25,
    'a year of heart rate must chunk at 14 days');
});

test('rollup types chunk to the rollup cap, not their list window', () => {
  // floors lists at 90 days but rolls up at 14 civil days, and the request rounds
  // its exclusive end up a day — so chunks must stay at 13 or every call 400s.
  const to = Date.UTC(2026, 7, 1);
  const from = to - 90 * 86400000;
  const type = catalog.get('floors');
  assert.strictEqual(type.listMethod, 'dailyRollUp');
  for (const [a, b] of health.chunks(type, from, to)) {
    assert.ok((b - a) <= 13 * 86400000, 'rollup chunk longer than the 13-day cap');
  }
});

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

test('interval point: value, times and source', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'users/1/dataTypes/steps/dataPoints/9',
    dataSource: { recordingMethod: 'AUTO_DETECTED', platform: 'FITBIT' },
    steps: {
      interval: { startTime: '2026-05-14T08:00:00Z', endTime: '2026-05-14T09:00:00Z' },
      count: '2038',
    },
  }, catalog.get('steps'), notes);

  assert.strictEqual(row.value, 2038, 'int64-as-string must parse');
  assert.strictEqual(row.startMs, Date.parse('2026-05-14T08:00:00Z'));
  assert.strictEqual(row.endMs, Date.parse('2026-05-14T09:00:00Z'));
  assert.strictEqual(row.platform, 'FITBIT');
  assert.strictEqual(notes.size, 0, 'a documented shape must produce no warnings');
});

test('sample point: sampleTime.physicalTime is the instant', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'p/1',
    heartRate: { sampleTime: { physicalTime: '2026-05-14T08:30:00Z' }, beatsPerMinute: 72 },
  }, catalog.get('heart-rate'), notes);
  assert.strictEqual(row.value, 72);
  assert.strictEqual(row.startMs, row.endMs);
});

test('a civil date anchors identically on any host timezone', () => {
  // Regression: anchors were computed with `new Date(y, m, d)`, which is
  // process-local. The same rollup day read by a UTC container and a UTC+4 laptop
  // produced two anchors, two point ids, and a daily total that double-counted.
  // The anchor is UTC; local-day placement happens at query time via the offset.
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'p/2',
    dailyRestingHeartRate: { date: '2026-05-14', beatsPerMinute: 54 },
  }, catalog.get('daily-resting-heart-rate'), notes);
  assert.strictEqual(row.value, 54);
  assert.strictEqual(row.startMs, Date.UTC(2026, 4, 14), 'anchor must be UTC midnight');

  const rollup = normalize.normalizeRollupPoint({
    civilStartTime: { date: { year: 2026, month: 5, day: 14 } },
    civilEndTime: { date: { year: 2026, month: 5, day: 15 } },
    totalCalories: { kcalSum: 2736 },
  }, catalog.get('total-calories'), notes);
  assert.strictEqual(rollup.anchorMs, Date.UTC(2026, 4, 14));
  assert.strictEqual(rollup.pointId, `total-calories:rollup:${Date.UTC(2026, 4, 14)}`,
    'the id must not vary with the host timezone');
});

test('sleep: value is time ASLEEP, stages become parts, awake is excluded', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'sleeps/12345',
    sleep: {
      startTime: '2026-04-20T22:30:00Z',
      endTime: '2026-04-21T06:30:00Z',
      sleepType: 'STAGES',
      sleepStages: [
        { startTime: '2026-04-20T22:30:00Z', endTime: '2026-04-20T23:30:00Z', type: 'LIGHT' },
        { startTime: '2026-04-20T23:30:00Z', endTime: '2026-04-21T01:00:00Z', type: 'DEEP' },
        { startTime: '2026-04-21T01:00:00Z', endTime: '2026-04-21T01:15:00Z', type: 'AWAKE' },
      ],
    },
  }, catalog.get('sleep'), notes);

  assert.strictEqual(row.parts.LIGHT, 3600000);
  assert.strictEqual(row.parts.DEEP, 5400000);
  assert.strictEqual(row.parts.AWAKE, 900000);
  assert.strictEqual(row.value, 9000000, 'asleep = light + deep, awake excluded');
  assert.strictEqual(row.fields.inBedMs, 8 * 3600000);
});

test('sleep without stages still plots (CLASSIC records have none)', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'sleeps/2',
    sleep: { startTime: '2026-04-20T23:00:00Z', endTime: '2026-04-21T06:00:00Z', sleepType: 'CLASSIC' },
  }, catalog.get('sleep'), notes);
  assert.strictEqual(row.value, 7 * 3600000);
  assert.ok(row.parts.LIGHT > 0, 'must still produce a drawable segment');
});

test('sleep anchors on wake time, everything else on start', () => {
  const notes = new Set();
  const sleep = normalize.normalizePoint({
    name: 'sleeps/3',
    sleep: { startTime: '2026-04-20T23:40:00Z', endTime: '2026-04-21T07:10:00Z' },
  }, catalog.get('sleep'), notes);
  assert.strictEqual(sleep.anchorMs, Date.parse('2026-04-21T07:10:00Z'),
    'a night belongs to the morning you woke up');

  const steps = normalize.normalizePoint({
    name: 's/1',
    steps: { interval: { startTime: '2026-04-20T08:00:00Z', endTime: '2026-04-20T09:00:00Z' }, count: 10 },
  }, catalog.get('steps'), notes);
  assert.strictEqual(steps.anchorMs, steps.startMs);
});

test('exercise: "900s" duration parses to milliseconds', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'e/1',
    exercise: {
      interval: { startTime: '2026-02-23T13:10:00Z', endTime: '2026-02-23T13:25:00Z' },
      exerciseType: 'WALKING', activeDuration: '900s',
      metricsSummary: { caloriesKcal: 16, steps: '2038' },
    },
  }, catalog.get('exercise'), notes);
  assert.strictEqual(row.value, 900000);
  assert.strictEqual(row.fields.calories, 16);
  assert.strictEqual(row.fields.steps, 2038);
});

test('heart-rate zones split into ordered parts', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'z/1',
    timeInHeartRateZone: {
      interval: { startTime: '2026-05-14T00:00:00Z', endTime: '2026-05-15T00:00:00Z' },
      zones: [{ zone: 'FAT_BURN', minutes: 30 }, { zone: 'CARDIO', minutes: 12 }],
    },
  }, catalog.get('time-in-heart-rate-zone'), notes);
  assert.strictEqual(row.parts.FAT_BURN, 30);
  assert.strictEqual(row.value, 42);
});

test('an unknown value field is used but reported, never silently dropped', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'p/9',
    floors: { interval: { startTime: '2026-05-14T00:00:00Z', endTime: '2026-05-15T00:00:00Z' }, flightsClimbed: 12 },
  }, catalog.get('floors'), notes);
  assert.strictEqual(row.value, 12);
  assert.ok([...notes].some((n) => n.includes('unlisted field')), 'must warn about the guess');
});

test('a point with no usable timestamp is dropped, not stored at epoch 0', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({ name: 'p/x', steps: { count: 5 } }, catalog.get('steps'), notes);
  assert.strictEqual(row, null);
  assert.ok(notes.size > 0);
});

// ---------------------------------------------------------------------------
// db
// ---------------------------------------------------------------------------


testAsync('restated points upsert instead of doubling the total', async () => {
  const base = {
    dataType: 'steps', pointId: 'users/1/steps/1',
    startMs: Date.UTC(2026, 4, 14, 8), endMs: Date.UTC(2026, 4, 14, 9),
    value: 1000, platform: 'FITBIT', parts: {}, raw: { v: 1 },
  };
  let r = await db.putPoints([base]);
  assert.strictEqual(r.fresh, 1);

  // Same point, corrected upward — exactly what a late watch sync does.
  r = await db.putPoints([{ ...base, value: 1800, raw: { v: 2 } }]);
  assert.strictEqual(r.fresh, 0, 'a restatement is not a new point');

  const total = await db.aggregate('steps', Date.UTC(2026, 4, 14), Date.UTC(2026, 4, 15), 'sum');
  assert.strictEqual(total, 1800, 'the corrected value replaces the original');
});

testAsync('day buckets follow the viewer offset, not UTC', async () => {
  // 21:30 UTC on the 14th is 01:30 on the 15th at UTC+4.
  await db.putPoints([{
    dataType: 'floors', pointId: 'f/1',
    startMs: Date.UTC(2026, 4, 14, 21, 30), endMs: Date.UTC(2026, 4, 14, 22),
    value: 7, parts: {}, raw: {},
  }]);
  const from = Date.UTC(2026, 4, 10);
  const to = Date.UTC(2026, 4, 20);

  const utc = await db.series('floors', from, to, 86400000, 'sum', 0);
  const gulf = await db.series('floors', from, to, 86400000, 'sum', 4 * 3600000);
  assert.strictEqual(new Date(utc[0].t).getUTCDate(), 14);
  assert.strictEqual(new Date(gulf[0].t + 4 * 3600000).getUTCDate(), 15,
    'at UTC+4 the point belongs to the 15th');
});

testAsync('stacked parts are replaced wholesale on restatement', async () => {
  const row = {
    dataType: 'sleep', pointId: 'sleeps/1', startMs: Date.UTC(2026, 4, 14, 22),
    endMs: Date.UTC(2026, 4, 15, 6), value: 100, raw: {},
    parts: { DEEP: 60, LIGHT: 40, AWAKE: 10 },
  };
  await db.putPoints([row]);
  // The revision drops AWAKE entirely; a merge would leave a ghost segment behind.
  await db.putPoints([{ ...row, parts: { DEEP: 70, LIGHT: 30 } }]);
  const rows = await db.stackedSeries('sleep', Date.UTC(2026, 4, 14), Date.UTC(2026, 4, 16), 86400000, 0);
  const keys = rows.map((r) => r.key);
  assert.ok(!keys.includes('AWAKE'), 'a stage removed upstream must not survive locally');
  assert.strictEqual(rows.find((r) => r.key === 'DEEP').v, 70);
});

testAsync('avg never sums: a bucketed heart rate stays a rate', async () => {
  await db.putPoints([60, 80, 100].map((v, i) => ({
    dataType: 'heart-rate', pointId: `hr/${i}`,
    startMs: Date.UTC(2026, 4, 14, 8, i * 10), endMs: Date.UTC(2026, 4, 14, 8, i * 10),
    value: v, parts: {}, raw: {},
  })));
  const [bucket] = await db.series('heart-rate', Date.UTC(2026, 4, 14), Date.UTC(2026, 4, 15), 86400000, 'avg', 0);
  assert.strictEqual(bucket.v, 80);
  assert.strictEqual(bucket.lo, 60);
  assert.strictEqual(bucket.hi, 100, 'the band keeps the range the average hides');
});

testAsync('last takes the newest reading in the bucket', async () => {
  await db.putPoints([
    { dataType: 'weight', pointId: 'w/1', startMs: Date.UTC(2026, 4, 14, 7), endMs: Date.UTC(2026, 4, 14, 7), value: 78.4, parts: {}, raw: {} },
    { dataType: 'weight', pointId: 'w/2', startMs: Date.UTC(2026, 4, 14, 19), endMs: Date.UTC(2026, 4, 14, 19), value: 79.1, parts: {}, raw: {} },
  ]);
  const [b] = await db.series('weight', Date.UTC(2026, 4, 14), Date.UTC(2026, 4, 15), 86400000, 'last', 0);
  assert.strictEqual(b.v, 79.1);
});

testAsync('a partial token write never nulls the fields it did not pass', async () => {
  // Regression: the OAuth callback stores the user id immediately after the token
  // exchange. A plain-assignment upsert wiped access_token/expiry, so a successful
  // login reported "not connected" from the next request onward.
  await db.putTokens({
    access_token: 'ya29.initial', refresh_token: '1//refresh',
    expiry_ms: 4102444800000, scope: 'a b',
  });
  await db.putTokens({ health_user_id: '5680734231359142911' });

  const t = await db.getTokens();
  assert.strictEqual(t.access_token, 'ya29.initial', 'access token must survive');
  assert.strictEqual(t.refresh_token, '1//refresh');
  assert.strictEqual(t.expiry_ms, 4102444800000, 'expiry must survive');
  assert.strictEqual(t.scope, 'a b');
  assert.strictEqual(t.health_user_id, '5680734231359142911');

  // A refresh grant returns no refresh_token; the stored one must be kept.
  await db.putTokens({ access_token: 'ya29.second', expiry_ms: 4102444900000 });
  assert.strictEqual((await db.getTokens()).refresh_token, '1//refresh');
  await db.clearTokens();
});

testAsync('a second replica does not simply take its turn', async () => {
  // The failure this guards: a plain mutex makes replicas take TURNS rather than
  // stand down, so two of them booting seconds apart BOTH run the sweep and the
  // rate-limited upstream sees double the traffic. The claim is conditional on
  // completion time, checked inside the same atomic UPDATE as the lock.
  const A = 'replica-a';
  const B = 'replica-b';

  assert.strictEqual(await db.acquireLease('t-lease', A, 60000, 60000), true, 'A claims it');
  assert.strictEqual(await db.acquireLease('t-lease', B, 60000, 60000), false, 'B is locked out');

  await db.releaseLease('t-lease', A, true);
  // The lock is free now — a plain mutex would hand it straight to B.
  assert.strictEqual(await db.acquireLease('t-lease', B, 60000, 60000), false,
    'B must stand down: the work was just completed by A');

  // A manual sync passes minInterval 0 and is allowed to override the cadence.
  assert.strictEqual(await db.acquireLease('t-lease', B, 60000, 0), true, 'manual sync overrides');
  await db.releaseLease('t-lease', B, true);
});

testAsync('two bedtimes either side of midnight land on different days', async () => {
  // The bug this guards: bucketing sleep by START puts a 23:40 and a 00:20 bedtime
  // on different calendar days, so one day shows a 15-hour double night and the
  // next shows none.
  const nights = [
    { start: '2026-06-01T23:40:00Z', end: '2026-06-02T07:00:00Z' },
    { start: '2026-06-03T00:20:00Z', end: '2026-06-03T08:00:00Z' },
  ];
  const notes = new Set();
  const rows = nights.map((n, i) => normalize.normalizePoint({
    name: `sleeps/anchor-${i}`,
    sleep: { startTime: n.start, endTime: n.end },
  }, catalog.get('sleep'), notes));
  await db.putPoints(rows);

  const series = await db.series('sleep', Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 5), 86400000, 'sum', 0);
  assert.strictEqual(series.length, 2, 'one bar per night, never two nights in one bar');
  assert.deepStrictEqual(
    series.map((s) => new Date(s.t).getUTCDate()), [2, 3],
    'each night lands on its wake day',
  );
});

// ---------------------------------------------------------------------------
// query — the read side
// ---------------------------------------------------------------------------

testAsync('sparse metrics keep their real spacing on the time axis', async () => {
  // Two workouts nine days apart. Positioned by array index they would be drawn as
  // neighbours; the range must come back with one bucket per day so the gap is real.
  const days = [1, 10];
  await db.putPoints(days.map((d) => ({
    dataType: 'exercise', pointId: `ex/${d}`,
    startMs: Date.UTC(2026, 6, d, 18), endMs: Date.UTC(2026, 6, d, 19),
    value: 3600000, parts: {}, raw: {},
  })));

  const from = Date.UTC(2026, 6, 1);
  const to = Date.UTC(2026, 6, 15);
  const payload = await query.seriesPayload('exercise', from, to, 86400000, 0);

  assert.strictEqual(payload.points.length, 14, 'one bucket per day in the range');
  const withData = payload.points.filter((p) => p.v !== null);
  assert.strictEqual(withData.length, 2);
  const [a, b] = withData.map((p) => payload.points.indexOf(p));
  assert.strictEqual(b - a, 9, 'nine empty buckets separate the two workouts');
  assert.strictEqual(payload.points[a + 1].v, null, 'an empty day is null, never 0');
});

testAsync('denseBuckets never invents a bucket outside the range', async () => {
  const from = Date.UTC(2026, 6, 1);
  const to = Date.UTC(2026, 6, 4);
  const dense = query.denseBuckets([], from, to, 86400000, 0, (t) => ({ t, v: null }));
  assert.strictEqual(dense.length, 3);
  assert.strictEqual(dense[0].t, from);
  assert.ok(dense[dense.length - 1].t < to);
});

testAsync('out-of-range zone time is stored but kept out of the stack', async () => {
  await db.putPoints([{
    dataType: 'time-in-heart-rate-zone', pointId: 'z/day1',
    startMs: Date.UTC(2026, 6, 20), endMs: Date.UTC(2026, 6, 21),
    value: 1242, parts: { OUT_OF_RANGE: 1200, FAT_BURN: 30, CARDIO: 12 }, raw: {},
  }]);
  const payload = await query.seriesPayload('time-in-heart-rate-zone',
    Date.UTC(2026, 6, 20), Date.UTC(2026, 6, 21), 86400000, 0);
  assert.deepStrictEqual(payload.keys, ['FAT_BURN', 'CARDIO'],
    'a 1,200-minute segment would flatten every zone that matters');
  assert.strictEqual(payload.points[0].parts.OUT_OF_RANGE, undefined);
  // Still on disk, still in the table view.
  const table = await query.tablePayload('time-in-heart-rate-zone',
    Date.UTC(2026, 6, 20), Date.UTC(2026, 6, 21), 10);
  assert.strictEqual(table.rows.length, 1);
});

testAsync('the delta compares against the previous equal-length period', async () => {
  // 50 bpm across the earlier week, 55 across the later one: +10%.
  const rows = [];
  for (let d = 0; d < 14; d++) {
    rows.push({
      dataType: 'daily-resting-heart-rate', pointId: `rhr/${d}`,
      startMs: Date.UTC(2026, 8, 1 + d), endMs: Date.UTC(2026, 8, 1 + d),
      value: d < 7 ? 50 : 55, parts: {}, raw: {},
    });
  }
  await db.putPoints(rows);

  const tiles = await query.summaryPayload(Date.UTC(2026, 8, 8), Date.UTC(2026, 8, 15), 0);
  const tile = tiles.find((x) => x.type === 'daily-resting-heart-rate');
  assert.strictEqual(tile.value, 55);
  assert.ok(Math.abs(tile.delta - 10) < 0.001, `expected +10%, got ${tile.delta}`);
  // The flag that stops the UI painting a rising resting heart rate green.
  assert.strictEqual(tile.upIsGood, false);
});

testAsync('overview reports sleep in hours, not scaled twice', async () => {
  // Regression: seriesFor() already applies the type's scale (ms -> hours), and the
  // row builder divided by 3,600,000 a second time — turning every night into
  // 0.0000022 and rounding it to a confident 0.
  const offsetMs = 0;
  // Three days back, so it falls inside the window rather than in the future.
  const dayStart = views.dayRange(views.todayString(offsetMs), offsetMs)[0] - 3 * views.DAY_MS;
  const wake = dayStart + 7 * 3600000;
  await db.putPoints([{
    dataType: 'sleep', pointId: 'sleeps/overview-1',
    startMs: dayStart - 3600000, endMs: wake, anchorMs: wake,
    value: 7 * 3600000, parts: { DEEP: 2 * 3600000, LIGHT: 5 * 3600000 }, raw: {},
  }]);

  const payload = await views.overviewPayload(5, offsetMs);
  const wanted = new Date(dayStart).toISOString().slice(0, 10);
  const row = payload.rows.find((r) => r.date === wanted);
  assert.ok(row, `the night must appear in the overview (${wanted})`);
  assert.strictEqual(row.sleepHours, 7, 'hours, not a scaled-twice fraction');
});

testAsync('zone bands come from 220 - age and cover the range', async () => {
  await metrics.setAge(30);
  const maxHr = metrics.maxHeartRate(await metrics.getAge());
  assert.strictEqual(maxHr, 190);

  const table = metrics.zoneTable(maxHr);
  assert.strictEqual(table.length, 6, 'six zones, Whoop-style');
  assert.strictEqual(table[0].fromBpm, 0);
  assert.strictEqual(table[1].fromBpm, 95, '50% of 190');
  assert.strictEqual(table[5].toBpm, null, 'the top zone is open-ended');
  // Contiguous: no bpm can fall between two zones.
  for (let i = 1; i < table.length; i++) {
    assert.strictEqual(table[i].fromBpm, table[i - 1].toBpm, 'zones must not leave a gap');
  }

  // Rest carries no training load — otherwise a sedentary day outscores a workout.
  assert.strictEqual(metrics.cardioLoad({ 1: 600 }), 0);
  assert.strictEqual(metrics.cardioLoad({ 2: 10, 6: 10 }), 10 * 1 + 10 * 5);
});

// ---------------------------------------------------------------------------
// activity calorie attribution — detail wins; a daily estimate only fills gaps
// ---------------------------------------------------------------------------

test('activity calories prorate a daily-only record', () => {
  const hour = 3600000;
  const rows = [{ start_ms: 0, end_ms: 24 * hour, value: 2400 }];
  assert.strictEqual(db.attributeIntervalValue(rows, 9 * hour, 12 * hour), 300);
});

test('activity calories use the measured overlap of granular records', () => {
  const hour = 3600000;
  const rows = [{ start_ms: 9 * hour, end_ms: 11 * hour, value: 300 }];
  assert.strictEqual(db.attributeIntervalValue(rows, 10 * hour, 11 * hour), 150);
});

test('activity calories do not double-count daily and granular overlap', () => {
  const hour = 3600000;
  const rows = [
    { start_ms: 0, end_ms: 24 * hour, value: 2400 },
    { start_ms: 10 * hour, end_ms: 11 * hour, value: 250 },
  ];
  // 09:00–12:00: measured 250 for 10:00–11:00, plus the daily rate only for
  // the two uncovered hours. The old SUM returned 550 by counting the overlap twice.
  assert.strictEqual(db.attributeIntervalValue(rows, 9 * hour, 12 * hour), 450);
});

test('activity calorie intervals are half-open at their boundaries', () => {
  const hour = 3600000;
  const rows = [
    { start_ms: 0, end_ms: 24 * hour, value: 2400 },
    { start_ms: 10 * hour, end_ms: 11 * hour, value: 250 },
  ];
  assert.strictEqual(db.attributeIntervalValue(rows, 9 * hour, 10 * hour), 100,
    'a granular record starting at the activity end covers none of it');
  assert.strictEqual(db.attributeIntervalValue(rows, 11 * hour, 12 * hour), 100,
    'a granular record ending at the activity start covers none of it');
});

test('zero-duration energy points neither divide by zero nor hide daily fallback', () => {
  const hour = 3600000;
  const zero = { start_ms: 9.5 * hour, end_ms: 9.5 * hour, value: 500 };
  assert.strictEqual(db.attributeIntervalValue([zero], 9 * hour, 10 * hour), null);
  assert.strictEqual(db.attributeIntervalValue([
    { start_ms: 0, end_ms: 24 * hour, value: 2400 }, zero,
  ], 9 * hour, 10 * hour), 100);
});

testAsync('activity calories use the database interval rows', async () => {
  const hour = 3600000;
  const day = Date.UTC(2030, 0, 1);
  await db.putPoints([
    {
      dataType: 'active-energy-burned', pointId: 'calorie-test/daily',
      startMs: day, endMs: day + 24 * hour, value: 2400, parts: {}, raw: {},
    },
    {
      dataType: 'active-energy-burned', pointId: 'calorie-test/granular',
      startMs: day + 10 * hour, endMs: day + 11 * hour, value: 250, parts: {}, raw: {},
    },
  ]);
  assert.strictEqual(await db.intervalValue(
    'active-energy-burned', day + 9 * hour, day + 12 * hour,
  ), 450);
});

test('automatic activity detection uses sustained age-aware heart rate', () => {
  const minute = 60000;
  const samples = [];
  for (let i = 0; i <= 22; i++) {
    // Twelve minutes above 60% of max HR, followed by five minutes back at rest.
    samples.push({ t: i * minute, v: i >= 2 && i <= 14 ? 130 : 75 });
  }

  const sessions = insights.detectActivities(samples, { maxHr: 190 });
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].start, 2 * minute);
  assert.strictEqual(sessions[0].end, 14 * minute);
  assert.strictEqual(sessions[0].durationMinutes, 12);
  assert.strictEqual(sessions[0].elevatedMinutes, 12);
  assert.ok(sessions[0].averageHeartRate >= 120);
  assert.ok(sessions[0].cardioLoad > 0);

  // The same absolute HR can be activity for an older profile and below the entry
  // zone for a younger one — proof that age/max HR is load-bearing, not decoration.
  const moderate = Array.from({ length: 16 }, (_, i) => ({ t: i * minute, v: 112 }));
  assert.strictEqual(insights.detectActivities(moderate, { maxHr: 170 }).length, 1);
  assert.strictEqual(insights.detectActivities(moderate, { maxHr: 200 }).length, 0);
});

test('automatic activity detection rejects short bursts and off-wrist gaps', () => {
  const minute = 60000;
  const short = Array.from({ length: 10 }, (_, i) => ({ t: i * minute, v: 140 }));
  assert.strictEqual(insights.detectActivities(short, { maxHr: 190 }).length, 0,
    'nine elapsed minutes is below the ten-minute minimum');

  const gapped = [
    ...Array.from({ length: 7 }, (_, i) => ({ t: i * minute, v: 140 })),
    ...Array.from({ length: 7 }, (_, i) => ({ t: (i + 11) * minute, v: 140 })),
  ];
  assert.strictEqual(insights.detectActivities(gapped, { maxHr: 190 }).length, 0,
    'a five-minute missing-watch gap must not be filled in as exercise');
});

test('recovery outlook compares physiology with a personal baseline', () => {
  const baseline = {
    hrv: [48, 50, 51, 49, 50, 52, 47],
    restingHeartRate: [59, 60, 61, 60, 60, 62, 58],
    sleepHours: [7.2, 7.5, 7.8, 7.4, 7.6, 7.3, 7.7],
  };
  const strong = insights.buildRecoveryOutlook({
    hrv: 56, restingHeartRate: 57, restingHeartRateSource: 'device', sleepHours: 8.1,
  }, baseline, 8);
  assert.strictEqual(strong.status, 'strong');
  assert.ok(strong.signals.every((signal) => signal.status === 'positive'));

  const low = insights.buildRecoveryOutlook({
    hrv: 40, restingHeartRate: 64, restingHeartRateSource: 'device', sleepHours: 6,
  }, baseline, 8);
  assert.strictEqual(low.status, 'low');
  assert.ok(low.signals.every((signal) => signal.status === 'negative'));

  const calibrating = insights.buildRecoveryOutlook({
    hrv: 50, restingHeartRate: 60, restingHeartRateSource: 'device', sleepHours: 8,
  }, { hrv: [49, 51], restingHeartRate: [60], sleepHours: [7.5] }, 8);
  assert.strictEqual(calibrating.status, 'calibrating');
});

// ---------------------------------------------------------------------------
// fitness age — transparent bounded direction, never false precision
// ---------------------------------------------------------------------------

const coveredFitnessSignals = (overrides = {}) => ({
  sleep: { averageHours: 8, days: 28 },
  training: { weeklyMinutes: 150, days: 28 },
  restingHeartRate: { recentMedian: 60, priorMedian: 60, recentDays: 28, priorDays: 28 },
  hrv: { recentMedian: 50, priorMedian: 50, recentDays: 28, priorDays: 28 },
  ...overrides,
});

test('favorable fitness signals produce a younger estimate', () => {
  const result = insights.buildFitnessAge(40, coveredFitnessSignals({
    sleep: { averageHours: 8.5, days: 28 },
    training: { weeklyMinutes: 250, days: 28 },
    restingHeartRate: { recentMedian: 55, priorMedian: 60, recentDays: 28, priorDays: 28 },
    hrv: { recentMedian: 60, priorMedian: 50, recentDays: 28, priorDays: 28 },
  }));
  assert.ok(result.estimate < 40);
  assert.strictEqual(result.direction, 'younger');
  assert.strictEqual(result.coverage.confidence, 'high');
  assert.ok(result.factors.every((factor) => factor.status === 'favorable'));
});

test('unfavorable fitness signals produce an older estimate', () => {
  const result = insights.buildFitnessAge(40, coveredFitnessSignals({
    sleep: { averageHours: 6, days: 28 },
    training: { weeklyMinutes: 20, days: 28 },
    restingHeartRate: { recentMedian: 66, priorMedian: 60, recentDays: 28, priorDays: 28 },
    hrv: { recentMedian: 38, priorMedian: 50, recentDays: 28, priorDays: 28 },
  }));
  assert.ok(result.estimate > 40);
  assert.strictEqual(result.direction, 'older');
});

test('neutral fitness signals stay aligned with profile age', () => {
  const result = insights.buildFitnessAge(40, coveredFitnessSignals());
  assert.strictEqual(result.estimate, 40);
  assert.strictEqual(result.deltaYears, 0);
  assert.strictEqual(result.direction, 'aligned');
  assert.ok(result.factors.every((factor) => factor.status === 'neutral'));
});

test('fitness age stays unavailable when coverage is insufficient', () => {
  const result = insights.buildFitnessAge(40, coveredFitnessSignals({
    restingHeartRate: { recentMedian: null, priorMedian: null, recentDays: 3, priorDays: 2 },
    hrv: { recentMedian: null, priorMedian: null, recentDays: 0, priorDays: 0 },
  }));
  assert.strictEqual(result.estimate, null);
  assert.strictEqual(result.deltaYears, null);
  assert.strictEqual(result.coverage.availableSignals, 2);
  assert.strictEqual(result.coverage.confidence, 'insufficient');
  const missing = result.factors.find((factor) => factor.id === 'hrv');
  assert.strictEqual(missing.available, false);
  assert.strictEqual(missing.value, null, 'missing HRV must not become zero');
});

test('fitness age clamps extreme inputs to a plausible adjustment', () => {
  const younger = insights.buildFitnessAge(40, coveredFitnessSignals({
    sleep: { averageHours: 14, days: 28 },
    training: { weeklyMinutes: 2000, days: 28 },
    restingHeartRate: { recentMedian: 30, priorMedian: 100, recentDays: 28, priorDays: 28 },
    hrv: { recentMedian: 500, priorMedian: 10, recentDays: 28, priorDays: 28 },
  }));
  const older = insights.buildFitnessAge(40, coveredFitnessSignals({
    sleep: { averageHours: 2, days: 28 },
    training: { weeklyMinutes: 0, days: 28 },
    restingHeartRate: { recentMedian: 120, priorMedian: 40, recentDays: 28, priorDays: 28 },
    hrv: { recentMedian: 5, priorMedian: 100, recentDays: 28, priorDays: 28 },
  }));
  assert.strictEqual(younger.deltaYears, -10);
  assert.strictEqual(older.deltaYears, 10);
  assert.ok(younger.estimate >= 18 && older.estimate <= 90);
});

testAsync('fitness age integrates recent database trends', async () => {
  const start = Date.UTC(2035, 0, 1);
  const rows = [];
  for (let day = 0; day < 56; day++) {
    const t = start + day * 86400000;
    const recent = day >= 28;
    rows.push(
      {
        dataType: 'daily-resting-heart-rate', pointId: `fitness-rhr/${day}`,
        startMs: t, endMs: t, value: recent ? 56 : 60, parts: {}, raw: {},
      },
      {
        dataType: 'daily-heart-rate-variability', pointId: `fitness-hrv/${day}`,
        startMs: t, endMs: t, value: recent ? 55 : 50, parts: {}, raw: {},
      },
    );
    if (recent) {
      rows.push(
        {
          dataType: 'sleep', pointId: `fitness-sleep/${day}`,
          startMs: t, endMs: t + 8.5 * 3600000, value: 8.5 * 3600000, parts: {}, raw: {},
        },
        {
          dataType: 'active-zone-minutes', pointId: `fitness-azm/${day}`,
          startMs: t, endMs: t + 86400000, value: 30, parts: {}, raw: {},
        },
      );
    }
  }
  await db.putPoints(rows);
  const result = await insights.fitnessAgeOutlook(start + 56 * 86400000, 0, { age: 40 }, 8);
  assert.ok(result.estimate < 40);
  assert.strictEqual(result.coverage.availableSignals, 4);
  assert.strictEqual(result.coverage.confidence, 'high');
});

// ---------------------------------------------------------------------------
// demo — proves the whole normalize path, since it uses the same one
// ---------------------------------------------------------------------------

test('demo data normalizes with no shape warnings', () => {
  const byType = demo.generate(3);
  let rows = 0;
  for (const [typeId, points] of byType) {
    const { rows: r, notes } = normalize.normalizeBatch(points, catalog.get(typeId));
    assert.strictEqual(notes.length, 0, `${typeId}: ${notes.join('; ')}`);
    assert.ok(r.length > 0, `${typeId} produced no rows`);
    assert.ok(r.every((x) => Number.isFinite(x.startMs)), `${typeId} has a bad timestamp`);
    rows += r.length;
  }
  assert.ok(rows > 100);
});

test('demo point ids stay unique across adjacent days', () => {
  const byType = demo.generate(3);
  for (const [typeId, points] of byType) {
    const names = points.map((point) => point.name);
    assert.strictEqual(new Set(names).size, names.length, `${typeId} has colliding demo ids`);
  }
});

// ---------------------------------------------------------------------------
// scores — readiness, strain, battery, stress: bounded and honest about absence
// ---------------------------------------------------------------------------

const neutralReadiness = (overrides = {}) => ({
  hrv: { current: 50, baseline: 50, baselineCount: 20 },
  restingHeartRate: { current: 58, baseline: 58, baselineCount: 20 },
  sleep: { hours: 7.2, needHours: 8 },
  debtHours: 0,
  temperature: { deviation: 0 },
  respiratoryRate: { current: 14, baseline: 14, baselineCount: 20 },
  yesterdayStrain: { value: 10, typical: 10 },
  ...overrides,
});

test('an ordinary morning reads as an ordinary readiness', () => {
  const r = scores.buildReadiness(neutralReadiness());
  assert.ok(r.score >= 55 && r.score <= 70, `neutral inputs should land in the 60s, got ${r.score}`);
  assert.strictEqual(r.band, 'moderate');
});

test('readiness moves with the body, in both directions, bounded', () => {
  const high = scores.buildReadiness(neutralReadiness({
    hrv: { current: 60, baseline: 50, baselineCount: 20 },
    restingHeartRate: { current: 54, baseline: 58, baselineCount: 20 },
    sleep: { hours: 8.4, needHours: 8 },
  }));
  assert.strictEqual(high.band, 'high');

  const low = scores.buildReadiness(neutralReadiness({
    hrv: { current: 36, baseline: 50, baselineCount: 20 },
    restingHeartRate: { current: 66, baseline: 58, baselineCount: 20 },
    sleep: { hours: 5.1, needHours: 8 },
    debtHours: 6,
    temperature: { deviation: 0.8 },
  }));
  assert.strictEqual(low.band, 'low');
  assert.ok(low.score >= 0, 'the floor is 0, never negative');

  const absurd = scores.buildReadiness(neutralReadiness({
    hrv: { current: 500, baseline: 50, baselineCount: 20 },
    restingHeartRate: { current: 20, baseline: 58, baselineCount: 20 },
    sleep: { hours: 14, needHours: 8 },
  }));
  assert.ok(absurd.score <= 100, 'the ceiling is 100');
});

test('a missing input lowers coverage, never the score', () => {
  const withHrv = scores.buildReadiness(neutralReadiness());
  const withoutHrv = scores.buildReadiness(neutralReadiness({
    hrv: { current: null, baseline: null, baselineCount: 0 },
  }));
  assert.strictEqual(withHrv.score, withoutHrv.score,
    'losing a NEUTRAL signal must not move the number');
  const c = withoutHrv.contributors.find((x) => x.id === 'hrv');
  assert.strictEqual(c.status, 'unavailable');
  assert.strictEqual(c.points, null, 'unavailable is null, not zero');
});

test('readiness refuses to exist on one core signal', () => {
  const r = scores.buildReadiness({
    sleep: { hours: 7, needHours: 8 },
  });
  assert.strictEqual(r.score, null);
  assert.strictEqual(r.band, 'calibrating');
});

test('strain saturates: the top of the scale costs exponentially more', () => {
  assert.strictEqual(training.strainOf(null), null);
  assert.strictEqual(training.strainOf(0), 0);
  const low = training.strainOf(150);
  const mid = training.strainOf(350);
  const high = training.strainOf(700);
  assert.ok(low < mid && mid < high, 'monotonic');
  assert.ok((mid - low) > (high - mid), 'each step up buys less');
  assert.ok(training.strainOf(100000) <= 21, 'bounded at 21');
  const target = scores.strainTarget(80);
  assert.ok(target.lo > scores.strainTarget(30).hi - 1, 'a ready day earns a higher band than a wrecked one');
  assert.strictEqual(scores.strainTarget(null), null);
});

test('the stress timeline never mistakes absence or exertion for calm', () => {
  const HOUR = 3600000;
  const hours = [
    { t: 0, avgHr: 60 },        // calm
    { t: HOUR, avgHr: null },   // off wrist
    { t: 2 * HOUR, avgHr: 130 }, // during a session -> active
    { t: 3 * HOUR, avgHr: 120 }, // high (>= zone3)
    { t: 4 * HOUR, avgHr: 74 },  // elevated (rhr + 12)
  ];
  const s = scores.buildStressTimeline({
    hours, restingHr: 58, zone3Bpm: 114,
    sessionRanges: [{ start: 2 * HOUR, end: 3 * HOUR }],
  });
  assert.deepStrictEqual(s.points.map((p) => p.state),
    ['calm', null, 'active', 'high', 'elevated']);
  assert.strictEqual(s.trackedHours, 4, 'the off-wrist hour is untracked, not calm');
});

test('the battery stays inside 5–100 and drains harder on stressed hours', () => {
  const HOUR = 3600000;
  const mk = (state) => scores.buildBattery({
    wakeMs: 7 * HOUR,
    sleepRatio: 1,
    efficiencyPercent: 92,
    stress: { points: Array.from({ length: 24 }, (_, h) => ({ t: h * HOUR, state: h >= 8 ? state : null })) },
    hourLoads: [],
    nowMs: 24 * HOUR,
    dayStart: 0,
  });
  const calm = mk('calm');
  const stressed = mk('high');
  assert.ok(calm.points.every((p) => p.v >= 5 && p.v <= 100));
  assert.ok(stressed.current < calm.current, 'a stressed afternoon costs more than a calm one');
  const noSleep = scores.buildBattery({
    wakeMs: null, sleepRatio: null, efficiencyPercent: null,
    stress: { points: [] }, hourLoads: [], nowMs: 12 * HOUR, dayStart: 0,
  });
  assert.strictEqual(noSleep.points[0].v, 55, 'no sleep data starts at the stated default, not zero');
});

test('weekly intensity caps a heroic day and counts only measured days', () => {
  const DAY = 86400000;
  const days = [500, 0, null, 20, 40, 0, 900].map((load, i) => ({ t: i * DAY, load }));
  const w = scores.buildWeeklyIntensity(days);
  const capped = w.days.filter((d) => d.points === 35).length;
  assert.strictEqual(capped, 2, 'both huge days hit the 35-point cap');
  assert.strictEqual(w.measuredDays, 6);
  assert.strictEqual(w.total, 35 + 0 + 5 + 10 + 0 + 35);
});

test('resilience needs coverage and moves by whole levels', () => {
  assert.strictEqual(scores.buildResilience({ coveredDays: 6 }).level, null);
  const strong = scores.buildResilience({
    stressShareAvg: 0.05, sleepRatioAvg: 1.02, hrvTrendPercent: 6, coveredDays: 14,
  });
  assert.strictEqual(strong.level, 'Exceptional');
  const worn = scores.buildResilience({
    stressShareAvg: 0.3, sleepRatioAvg: 0.7, hrvTrendPercent: -8, coveredDays: 14,
  });
  assert.strictEqual(worn.level, 'Limited');
  const unknownStress = scores.buildResilience({
    stressShareAvg: null, sleepRatioAvg: 1, hrvTrendPercent: 0, coveredDays: 12,
  });
  assert.strictEqual(unknownStress.level, 'Solid', 'unknown stress contributes nothing either way');
});

test('the symptom radar fires on joint deviation, never on one signal', () => {
  const band = { p10: 40, p90: 60, median: 50 };
  const sig = (id, current, direction = 'high-bad') => ({
    id, label: id, unit: '', current, band, direction,
  });
  const one = scores.buildSymptomRadar([
    sig('a', 75), sig('b', 50), sig('c', 50), sig('d', 50),
  ]);
  assert.strictEqual(one.level, 'none', 'one outlier is a shrug');
  const two = scores.buildSymptomRadar([
    sig('a', 75), sig('b', 75), sig('c', 50), sig('d', 50),
  ]);
  assert.strictEqual(two.level, 'minor');
  const three = scores.buildSymptomRadar([
    sig('a', 75), sig('b', 75), sig('c', 30, 'low-bad'), sig('d', 50),
  ]);
  assert.strictEqual(three.level, 'major');
  assert.ok(three.signals.find((s) => s.id === 'c').flagged, 'low-bad flags below p10');
  const thin = scores.buildSymptomRadar([sig('a', 75), { id: 'b', label: 'b', unit: '', current: null, band: null }]);
  assert.strictEqual(thin.level, 'unavailable', 'two measurable vitals are not enough to call it');
});

test('the energy forecast is bounded, needs a wake time, and debt deepens the dip', () => {
  const HOUR = 3600000;
  const none = scores.buildEnergyForecast({ wakeMs: null, dayStart: 0, nowMs: 0 });
  assert.strictEqual(none.available, false);
  const fresh = scores.buildEnergyForecast({ wakeMs: 7 * HOUR, needHours: 8, debtHours: 0, dayStart: 0, nowMs: 0 });
  const tired = scores.buildEnergyForecast({ wakeMs: 7 * HOUR, needHours: 8, debtHours: 8, dayStart: 0, nowMs: 0 });
  assert.ok(fresh.points.every((p) => p.v >= 5 && p.v <= 100));
  assert.ok(tired.zones.dip.v < fresh.zones.dip.v, 'sleep debt deepens the afternoon dip');
  assert.strictEqual(fresh.zones.bedTarget, 7 * HOUR + 16 * HOUR, 'bed target = wake + (24 − need)');
});

// ---------------------------------------------------------------------------
// night — need, debt, consistency, naps
// ---------------------------------------------------------------------------

test('sleep need is learned from history and debt decays, half-credits and caps', () => {
  const steady = nightlib.buildSleepNeed(Array(28).fill(8));
  assert.strictEqual(steady.baseNeedHours, 8);
  assert.strictEqual(steady.debtHours, 0);

  const short = nightlib.buildSleepNeed([...Array(21).fill(8), ...Array(7).fill(5.5)]);
  assert.ok(short.debtHours > 5, `a week of 5.5s owes real hours, got ${short.debtHours}`);
  assert.ok(short.tonightNeedHours > short.baseNeedHours, 'debt raises tonight');

  const repaid = nightlib.buildSleepNeed([...Array(21).fill(8), ...Array(4).fill(5.5), 10, 10, 10]);
  assert.ok(repaid.debtHours < short.debtHours, 'long nights repay');
  const bank = nightlib.buildSleepNeed([...Array(21).fill(8), 12, 12, 12, 12, 12, 12, 12]);
  assert.strictEqual(bank.debtHours, 0, 'debt floors at zero — sleep cannot be banked');

  const chronic = nightlib.buildSleepNeed(Array(28).fill(3.5));
  assert.strictEqual(chronic.baseNeedHours, null, 'sub-4h nights are tracking noise, not a need');

  const young = nightlib.buildSleepNeed([8, 8, 8]);
  assert.strictEqual(young.baseNeedHours, null, 'needs a week of nights first');

  const strained = nightlib.buildSleepNeed(Array(28).fill(8), { yesterdayStrain: 16 });
  assert.ok(strained.tonightNeedHours > 8, 'a hard day raises tonight’s need');
});

test('consistency survives midnight: 23:40 and 00:20 are forty minutes apart', () => {
  assert.strictEqual(
    Math.abs(stats.minutesFrom6pm(Date.UTC(2026, 5, 2, 0, 20)) - stats.minutesFrom6pm(Date.UTC(2026, 5, 1, 23, 40))),
    40,
  );
  const H = 3600000;
  const night = (bedH, bedM = 0) => {
    const start = Date.UTC(2026, 5, 1, bedH, bedM);
    return { start, end: start + 8 * H };
  };
  const tight = nightlib.buildConsistency([night(23), night(23, 10), night(22, 55), night(23, 5), night(23)], 0);
  assert.strictEqual(tight.score, 100, '≤15 min of spread is a perfect score');
  const loose = nightlib.buildConsistency([night(21), night(23, 30), night(1), night(22), night(2)], 0);
  assert.ok(loose.score < tight.score);
  assert.strictEqual(nightlib.buildConsistency([night(23), night(23)], 0).score, null, 'two nights is not a pattern');
});

test('naps split from the main night and credit debt at half rate', () => {
  const H = 3600000;
  const dayStart = Date.UTC(2026, 5, 2);
  const main = { start: dayStart - 8 * H, end: dayStart - 0.5 * H };
  const nap = { start: dayStart + 14 * H, end: dayStart + 15 * H };
  const long = { start: dayStart + 9 * H, end: dayStart + 13 * H }; // 4h: not a nap
  const split = nightlib.splitSessions([nap, main, long]);
  assert.strictEqual(split.main.start, main.start, 'the longest session is the night');
  assert.strictEqual(split.naps.length, 1, 'a four-hour daytime sleep is not filed as a nap');
  assert.strictEqual(split.naps[0].debtCreditHours, 0.5, 'one hour napped repays half an hour');
});

test('the overnight dip needs real samples on both sides', () => {
  const pts = (vals) => vals.map((v, i) => ({ t: i * 600000, v }));
  assert.strictEqual(nightlib.buildHrDip(pts([60, 58]), 80).dipPercent, null, 'too few samples');
  assert.strictEqual(nightlib.buildHrDip(pts([60, 58, 55, 54, 53, 52]), null).dipPercent, null, 'no daytime reference');
  const ok = nightlib.buildHrDip(pts([60, 56, 52, 50, 49, 50, 52]), 76);
  assert.ok(ok.dipPercent >= 25 && ok.dipPercent <= 35, `plausible dip, got ${ok.dipPercent}`);
  assert.strictEqual(ok.bottomAtMs, 4 * 600000, 'bottom-out is the lowest sample’s time');
});

test('the month pattern waits for 14 nights and names the dominant deviation', () => {
  const H = 3600000;
  const mkRow = (i, hours) => {
    const start = Date.UTC(2026, 5, 1 + i, 23) ;
    return {
      t: Date.UTC(2026, 5, 2 + i),
      main: { start, end: start + hours * H },
      naps: [],
      hoursAsleep: hours,
      efficiencyPercent: 92,
      stageHours: { deep: hours * 0.18, rem: hours * 0.22, light: hours * 0.55, awake: hours * 0.05 },
    };
  };
  const thin = nightlib.buildMonthPattern(Array.from({ length: 10 }, (_, i) => mkRow(i, 8)));
  assert.strictEqual(thin.available, false);
  const short = nightlib.buildMonthPattern(Array.from({ length: 20 }, (_, i) => mkRow(i, 5.8)));
  assert.ok(short.sentence.includes('Short nights'), short.sentence);
  const steady = nightlib.buildMonthPattern(Array.from({ length: 20 }, (_, i) => mkRow(i, 8)));
  assert.ok(steady.metrics.every((m) => m.status !== 'below' || m.id === 'variability'),
    'a steady month has no deviating metric');
});

// ---------------------------------------------------------------------------
// training — the load model, corridor, countdown, merge, HRR
// ---------------------------------------------------------------------------

test('fitness rises slowly, fatigue fast, and the ratio names the state', () => {
  const DAY = 86400000;
  // The EWMAs seed at the first measured day, so an account that arrives already
  // training does not begin in a fictional detraining ramp from zero.
  const flat = Array.from({ length: 60 }, (_, i) => ({ t: i * DAY, load: 100 }));
  const model = training.buildLoadModel(flat);
  const last = model.series[model.series.length - 1];
  assert.ok(Math.abs(last.fatigue - 100) < 5 && Math.abs(last.fitness - 100) < 5,
    'a steady diet converges both averages onto it');
  assert.strictEqual(model.current.status, 'maintaining');

  const ramp = training.buildLoadModel([
    ...Array.from({ length: 40 }, (_, i) => ({ t: i * DAY, load: 80 })),
    ...Array.from({ length: 10 }, (_, i) => ({ t: (40 + i) * DAY, load: 110 })),
  ]);
  const rampLast = ramp.series[ramp.series.length - 1];
  assert.ok(rampLast.fatigue > rampLast.fitness, 'on a ramp, fatigue outruns fitness');
  assert.strictEqual(ramp.current.status, 'productive', 'a gentle ramp is productive, not alarming');

  const spike = training.buildLoadModel([
    ...Array.from({ length: 50 }, (_, i) => ({ t: i * DAY, load: 60 })),
    ...Array.from({ length: 10 }, (_, i) => ({ t: (50 + i) * DAY, load: 400 })),
  ]);
  assert.strictEqual(spike.current.status, 'overreaching', 'a sudden 6× ramp is flagged');

  const stopped = training.buildLoadModel([
    ...Array.from({ length: 50 }, (_, i) => ({ t: i * DAY, load: 150 })),
    ...Array.from({ length: 20 }, (_, i) => ({ t: (50 + i) * DAY, load: 0 })),
  ]);
  assert.strictEqual(stopped.current.status, 'detraining', 'three weeks of rest days reads as detraining');

  const young = training.buildLoadModel(Array.from({ length: 10 }, (_, i) => ({ t: i * DAY, load: null })));
  assert.strictEqual(young.current, null, 'pre-history stays unknown, not zero');
});

test('the corridor narrows for a run-down body and places the load line', () => {
  const DAY = 86400000;
  const loads = Array.from({ length: 60 }, (_, i) => ({ t: i * DAY, load: 100 }));
  const model = training.buildLoadModel(loads);
  const fresh = training.buildCorridor(model, { readinessAvg: 80 });
  const worn = training.buildCorridor(model, { readinessAvg: 30 });
  assert.strictEqual(fresh.upperFactor, 1.35);
  assert.strictEqual(worn.upperFactor, 1.15);
  assert.strictEqual(fresh.state, 'inside', 'steady training threads the corridor');

  const rested = training.buildLoadModel([
    ...Array.from({ length: 55 }, (_, i) => ({ t: i * DAY, load: 150 })),
    ...Array.from({ length: 12 }, (_, i) => ({ t: (55 + i) * DAY, load: 0 })),
  ]);
  assert.strictEqual(training.buildCorridor(rested, {}).state, 'below');
});

test('the recovery countdown is bounded and stretches on a low-readiness morning', () => {
  const now = Date.UTC(2026, 7, 20, 12);
  const end = now - 2 * 3600000;
  const light = training.buildRecoveryCountdown({ lastSession: { end, load: 10 }, nowMs: now });
  assert.ok(light.baseHours >= 6, 'floor of six hours');
  const heavy = training.buildRecoveryCountdown({ lastSession: { end, load: 100000 }, nowMs: now });
  assert.ok(heavy.baseHours <= 72, 'ceiling of seventy-two');
  const normal = training.buildRecoveryCountdown({ lastSession: { end, load: 200 }, readinessScore: 80, nowMs: now });
  const wrecked = training.buildRecoveryCountdown({ lastSession: { end, load: 200 }, readinessScore: 30, nowMs: now });
  assert.ok(wrecked.hoursRemaining > normal.hoursRemaining, 'low readiness stretches recovery');
  assert.strictEqual(training.buildRecoveryCountdown({ lastSession: null, nowMs: now }).state, 'ready');
});

test('a detected session overlapping a recorded one is the same event, not two', () => {
  const H = 3600000;
  const recorded = [{ kind: 'recorded', start: 10 * H, end: 11 * H, load: 80 }];
  const overlapping = { kind: 'detected', start: 10.2 * H, end: 11.2 * H, load: 75 };
  const separate = { kind: 'detected', start: 18 * H, end: 18.7 * H, load: 40 };
  const merged = training.mergeSessions(recorded, [overlapping, separate]);
  assert.strictEqual(merged.length, 2);
  assert.ok(!merged.includes(overlapping), 'the typed recording wins');
  assert.ok(merged.includes(separate), 'a genuinely separate detection survives');
});

test('heart-rate recovery needs samples at the end and at +60s', () => {
  const end = 1000000;
  const good = training.buildHeartRateRecovery([
    { t: end - 5000, v: 165 }, { t: end + 58000, v: 128 },
  ], end);
  assert.strictEqual(good.dropBpm, 37);
  assert.strictEqual(training.buildHeartRateRecovery([{ t: end - 5000, v: 165 }], end), null,
    'no +60s sample, no claim');
  assert.strictEqual(training.buildHeartRateRecovery([
    { t: end - 90000, v: 165 }, { t: end + 60000, v: 128 },
  ], end), null, 'a stale peak sample is not the session end');
});

test('records only exist with real values and each states its window', () => {
  const rows = training.buildRecords({
    maxDaySteps: { v: 24812, t: 1 }, maxDayDistanceKm: null, maxDayAzm: { v: 0, t: 2 },
    longestSessionMin: { v: 134, t: 3 }, maxDayLoad: { v: 420, t: 4 }, maxWeekLoad: null,
    sessionCount: 88, maxDayFloors: null,
  });
  assert.ok(rows.every((r) => r.value !== null && r.value > 0), 'zero-value records are noise');
  assert.ok(rows.find((r) => r.id === 'load-day').window.includes('120'), 'bounded windows are labelled');
});

test('lifetime records rank whole-history days, best first, and drop what was never measured', () => {
  const out = training.buildLifetimeRecords({
    steps: [{ v: 100, t: 1 }, { v: 300, t: 2 }, { v: 200, t: 3 }, { v: 250, t: 4 }],
    strainLoads: [{ v: 700, t: 5 }, { v: 0, t: 6 }],
    totalCalories: [],
  });
  const steps = out.rows.find((r) => r.id === 'steps-day');
  assert.deepStrictEqual(steps.top.map((e) => e.value), [300, 250, 200], 'top 3, best first');
  assert.strictEqual(steps.top[0].atMs, 2, 'each podium entry carries its day');
  const strain = out.rows.find((r) => r.id === 'strain-day');
  assert.strictEqual(strain.top.length, 1, 'a measured-zero day cannot make a podium');
  assert.strictEqual(strain.top[0].value, training.strainOf(700), 'strain podiums present the bounded value');
  assert.ok(!out.rows.find((r) => r.id === 'total-calories-day'), 'an unmeasured metric says nothing');
  assert.strictEqual(out.window, 'all-time');
});

test('the muscular index is bounded and separate from cardio load', () => {
  assert.strictEqual(training.muscularIndex(0), 0);
  assert.strictEqual(training.muscularIndex(null), 0);
  assert.ok(training.muscularIndex(2000) > training.muscularIndex(500));
  assert.ok(training.muscularIndex(1e9) <= 30);
});

// ---------------------------------------------------------------------------
// trends — verdicts, highlights, correlations, reports
// ---------------------------------------------------------------------------

test('a verdict has a dead zone, so one odd week cannot flip an arrow', () => {
  const base = { id: 'x', label: 'X', unit: '', precision: 0, upIsGood: true };
  const flat = trends.buildVerdict({
    ...base, recent: Array(60).fill(102), prior: Array(60).fill(100),
  });
  assert.strictEqual(flat.direction, 'flat', '2% is inside the dead zone');
  const up = trends.buildVerdict({
    ...base, recent: Array(60).fill(110), prior: Array(60).fill(100),
  });
  assert.strictEqual(up.direction, 'up');
  assert.strictEqual(up.good, true);
  const rhr = trends.buildVerdict({
    ...base, upIsGood: false, recent: Array(60).fill(110), prior: Array(60).fill(100),
  });
  assert.strictEqual(rhr.good, false, 'up is not always good');
  const thin = trends.buildVerdict({
    ...base, recent: Array(5).fill(1), prior: Array(60).fill(1),
  });
  assert.strictEqual(thin.available, false, 'fourteen measured days or no verdict');
});

test('highlights cap at three and only fire on a window extreme', () => {
  const win = (values) => ({ values, times: values.map((_, i) => i) });
  const cards = trends.buildHighlights([
    { id: 'a', ...win([...Array(59).fill(50), 90]), maxText: (v) => `max ${v}` },
    { id: 'b', ...win([...Array(59).fill(50), 10]), minText: (v) => `min ${v}` },
    { id: 'c', ...win([...Array(59).fill(50), 89]), maxText: (v) => `max ${v}` },
    { id: 'd', ...win([...Array(59).fill(50), 91]), maxText: (v) => `max ${v}` },
    { id: 'e', ...win([...Array(59).fill(50), 50]), maxText: (v) => `max ${v}` },
  ]);
  assert.ok(cards.length <= 3, 'an editor, not a firehose');
  assert.ok(!cards.some((c) => c.metric === 'e'), 'an ordinary day is not a highlight');
  const thin = trends.buildHighlights([{ id: 'a', ...win(Array(10).fill(5)), maxText: () => 'x' }]);
  assert.strictEqual(thin.length, 0, 'under 21 days there is no window to be extreme in');
});

test('correlation cards demand n and r, and report the split in real units', () => {
  const xs = [];
  const ys = [];
  for (let i = 0; i < 40; i++) { xs.push(6 + (i % 5)); ys.push(40 + (i % 5) * 3); }
  const card = trends.buildCorrelation({ id: 't', xLabel: 'x', yLabel: 'y', unit: 'ms', xs, ys });
  assert.ok(card, 'a strong association over 40 days yields a card');
  assert.ok(card.delta > 0, 'above-median days show the higher mean');
  assert.strictEqual(trends.buildCorrelation({ id: 't', xLabel: 'x', yLabel: 'y', unit: '', xs: xs.slice(0, 10), ys: ys.slice(0, 10) }), null,
    'thirteen days of data is an anecdote');
  const noise = trends.buildCorrelation({
    id: 't', xLabel: 'x', yLabel: 'y', unit: '',
    xs: Array.from({ length: 40 }, (_, i) => (i * 7919) % 13),
    ys: Array.from({ length: 40 }, (_, i) => ((i + 5) * 104729) % 17),
  });
  assert.strictEqual(noise, null, 'weak correlations stay unreported');
});

test('the weekly report balance names restoring, optimal and overreaching', () => {
  const current = { sleepAvg: 7.5, rhrAvg: 56, hrvAvg: 52, loadTotal: 700, stepsAvg: 9000, azmAvg: 30 };
  const priors = [{ ...current, loadTotal: 650 }, { ...current, loadTotal: 700 }, { ...current, loadTotal: 690 }];
  const optimal = trends.buildReport(current, priors, { fitness: 100 });
  assert.strictEqual(optimal.balance.zone, 'optimal');
  assert.strictEqual(trends.buildReport({ ...current, loadTotal: 400 }, priors, { fitness: 100 }).balance.zone, 'restoring');
  assert.strictEqual(trends.buildReport({ ...current, loadTotal: 1000 }, priors, { fitness: 100 }).balance.zone, 'overreaching');
  assert.strictEqual(trends.buildReport(current, priors, { fitness: 2 }).balance, null,
    'no meaningful fitness, no balance claim');
});

// ---------------------------------------------------------------------------
// goals — adaptive targets, rings, badges
// ---------------------------------------------------------------------------

test('goals adapt down on a low-readiness morning, with the reason attached', () => {
  const normal = goals.buildAdaptiveGoals({
    stepsMedian: 9000, activeCalMedian: 520, readinessScore: 75, tonightNeedHours: 8.2,
  });
  assert.strictEqual(normal.steps.reason, null);
  const low = goals.buildAdaptiveGoals({
    stepsMedian: 9000, activeCalMedian: 520, readinessScore: 38, tonightNeedHours: 8.2,
  });
  assert.ok(low.steps.goal < normal.steps.goal);
  assert.ok(low.steps.reason.includes('38'), 'the goal explains itself');
  assert.strictEqual(low.recover.goal, 8.2, 'the recover goal is tonight’s need');
  const empty = goals.buildAdaptiveGoals({ stepsMedian: null, activeCalMedian: null, readinessScore: null, tonightNeedHours: null });
  assert.strictEqual(empty.steps.goal, 10000, 'no history falls back to the stated default');
});

test('rings fill against the adaptive goals and cap their overshoot', () => {
  const g = goals.buildAdaptiveGoals({ stepsMedian: 9000, activeCalMedian: 500, readinessScore: 70, tonightNeedHours: 8 });
  const rings = goals.buildRings(g, { activeCalories: 5000, activeZoneMinutes: 10, sleepHours: null });
  assert.strictEqual(rings.find((r) => r.id === 'move').fraction, 1.5, 'overshoot caps at 150%');
  assert.strictEqual(rings.find((r) => r.id === 'recover').fraction, null, 'no measurement, no fill');
  assert.strictEqual(rings.find((r) => r.id === 'train').closed, false);
});

test('badges earn from lifetime totals and show progress to the next rung', () => {
  const b = goals.buildBadges({ distance: 1200, steps: 6.2e6, floors: 40, sessions: 55, nights: 400 });
  const distance = b.badges.find((x) => x.id === 'distance');
  assert.strictEqual(distance.earned.length, 3, '100, 500 and 1000 km are earned');
  assert.strictEqual(distance.next.threshold, 2500);
  assert.ok(distance.next.progress > 0.4 && distance.next.progress < 0.5);
  assert.ok(!b.badges.find((x) => x.id === 'floors').earned.length, '40 floors has earned nothing yet');
  assert.strictEqual(goals.longestStreak([1, 1, 0, 1, 1, 1, null, 1], 1), 3,
    'a null day breaks a streak — untracked is not achieved');
});

// ---------------------------------------------------------------------------
// storage-backed: strength log, empty-database resilience, load sourcing
// ---------------------------------------------------------------------------

testAsync('strength log validates, stores and deletes entries', async () => {
  await assert.rejects(() => db.strengthAdd({ exercise: '', sets: 3, reps: 10, weightKg: 60 }));
  await assert.rejects(() => db.strengthAdd({ exercise: 'Squat', sets: 0, reps: 10, weightKg: 60 }));
  const entry = await db.strengthAdd({ exercise: 'Squat', sets: 5, reps: 5, weightKg: 80 });
  assert.strictEqual(entry.volume_kg, 2000);
  const listed = await db.strengthList(entry.ts_ms - 1000, entry.ts_ms + 1000);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(await db.strengthDelete(entry.id), true);
  assert.strictEqual(await db.strengthDelete(entry.id), false, 'a second delete finds nothing');
});

testAsync('screen payloads survive an empty database', async () => {
  // A brand-new account must get calibration states, not crashes or zeros.
  // Earlier storage tests leave points behind (one zone row lands inside the
  // 35-day load window), so make "empty" actually true first.
  await db.clearAll();
  const today = await screens.todayPayload(null, 0);
  assert.strictEqual(today.readiness.band, 'calibrating');
  assert.strictEqual(today.strain.today, null, 'no zone data, no strain — never 0');
  const sleep = await screens.sleepScreenPayload(null, 0);
  assert.strictEqual(sleep.consistency.score, null);
  const train = await screens.trainPayload(0);
  assert.strictEqual(train.latestSession, null);
  const you = await screens.youPayload(0);
  assert.strictEqual(you.resilience.level, null);
  const trendsView = await screens.trendsPayload(0, {});
  assert.ok(Array.isArray(trendsView.verdicts.metrics));
});

testAsync('daily load prefers device zone minutes and marks rest days zero', async () => {
  const day = Date.UTC(2031, 2, 10);
  await db.putPoints([{
    dataType: 'time-in-heart-rate-zone', pointId: 'load-test/z1',
    startMs: day, endMs: day + 86400000, value: 62,
    parts: { OUT_OF_RANGE: 1200, FAT_BURN: 30, CARDIO: 12 }, raw: {},
  }]);
  const series = await training.dailyLoadSeries(day + 3 * 86400000, 5, 0, { maxHeartRate: 190 });
  const withData = series.find((d) => d.t === day);
  assert.strictEqual(withData.load, 30 * 2 + 12 * 4, 'FAT_BURN×2 + CARDIO×4, OUT_OF_RANGE×0');
  assert.strictEqual(withData.source, 'device-zones');
  const after = series.find((d) => d.t === day + 86400000);
  assert.strictEqual(after.load, 0, 'a day after data began with no zones is a rest day');
  const before = series.find((d) => d.t === day - 86400000);
  assert.strictEqual(before.load, null, 'a day before data began is unknown, not rest');
});

// ---------------------------------------------------------------------------
// webhook — the auth ordering is what makes registration succeed
// ---------------------------------------------------------------------------

testAsync('unauthenticated handshake gets 401 (registration depends on it)', async () => {
  process.env.VITALS_WEBHOOK_SECRET = 'test-secret';
  const res = await webhook.handle(
    { headers: {} },
    Buffer.from(JSON.stringify({ type: 'verification' })),
    { onChange: async () => {}, log: () => {} },
  );
  assert.strictEqual(res.status, 401,
    'an endpoint that 200s an unauthenticated probe fails subscriber creation');
});

testAsync('authorized handshake gets 200', async () => {
  process.env.VITALS_WEBHOOK_SECRET = 'test-secret';
  const res = await webhook.handle(
    { headers: { authorization: 'Bearer test-secret' } },
    Buffer.from(JSON.stringify({ type: 'verification' })),
    { onChange: async () => {}, log: () => {} },
  );
  assert.strictEqual(res.status, 200);
});

testAsync('a wrong secret is rejected even with a valid-looking body', async () => {
  process.env.VITALS_WEBHOOK_SECRET = 'test-secret';
  const res = await webhook.handle(
    { headers: { authorization: 'Bearer wrong' } },
    Buffer.from(JSON.stringify({ type: 'verification' })),
    { onChange: async () => {}, log: () => {} },
  );
  assert.strictEqual(res.status, 401);
});

testAsync('an unsigned notification is refused by default', async () => {
  process.env.VITALS_WEBHOOK_SECRET = 'test-secret';
  delete process.env.VITALS_WEBHOOK_REQUIRE_SIGNATURE;
  const res = await webhook.handle(
    { headers: { authorization: 'Bearer test-secret' } },
    Buffer.from(JSON.stringify({ data: { dataType: 'steps', operation: 'UPSERT', intervals: [] } })),
    { onChange: async () => {}, log: () => {} },
  );
  assert.strictEqual(res.status, 403, 'this endpoint is public; the signature is the boundary');
});

testAsync('a notification triggers a targeted fetch of its interval', async () => {
  process.env.VITALS_WEBHOOK_SECRET = 'test-secret';
  process.env.VITALS_WEBHOOK_REQUIRE_SIGNATURE = '0';
  const calls = [];
  const res = await webhook.handle(
    { headers: { authorization: 'Bearer test-secret' } },
    Buffer.from(JSON.stringify({
      data: {
        dataType: 'steps',
        operation: 'UPSERT',
        intervals: [{
          physicalTimeInterval: {
            startTime: '2026-03-08T01:29:00Z', endTime: '2026-03-08T01:34:00Z',
          },
        }],
      },
    })),
    { onChange: async (...a) => calls.push(a), log: () => {} },
  );
  assert.strictEqual(res.status, 204, 'Google wants 204 immediately');
  await res.after();
  assert.strictEqual(calls.length, 1);
  const [typeId, from, to] = calls[0];
  assert.strictEqual(typeId, 'steps');
  assert.ok(from < Date.parse('2026-03-08T01:29:00Z'), 'window is padded either side');
  assert.ok(to > Date.parse('2026-03-08T01:34:00Z'));
  delete process.env.VITALS_WEBHOOK_REQUIRE_SIGNATURE;
});

test('the post-login redirect lands on the app root, not inside /auth', () => {
  // Regression: Location './' resolves against the DIRECTORY of /auth/callback,
  // giving /auth/ — an unrouted path — so a SUCCESSFUL login rendered
  // {"error":"not found"}. '../' is correct in both mount modes.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const callback = src.slice(src.indexOf("pathname === '/auth/callback'"));
  const redirect = /location:\s*'([^']+)'/.exec(callback);
  assert.ok(redirect, 'callback must redirect somewhere');
  assert.strictEqual(redirect[1], '../');

  const resolve = (base, rel) => new URL(rel, `http://x${base}`).pathname;
  assert.strictEqual(resolve('/auth/callback', redirect[1]), '/', 'local mount');
  assert.strictEqual(resolve('/vitals/auth/callback', redirect[1]), '/vitals/', 'fleet mount');
  assert.strictEqual(resolve('/auth/callback', './'), '/auth/', 'the bug this guards');
});

test('notification data types resolve in every naming form', () => {
  assert.strictEqual(webhook.resolveType('steps').id, 'steps');
  assert.strictEqual(webhook.resolveType('body_fat').id, 'body-fat');
  assert.strictEqual(webhook.resolveType('body-fat').id, 'body-fat');
  assert.strictEqual(webhook.resolveType('nope'), null);
});

// ---------------------------------------------------------------------------

(async () => {
  try {
    await db.open({ database: TEST_DATABASE });
    await db.clearAll();
    await db.clearTokens();
    // Leases too: they are deliberately time-based, so a run that finished less than
    // a minute ago would correctly refuse the next run's claim and fail the suite for
    // the very reason the feature exists.
    await db.handle().query('DELETE FROM leases');
    dbReady = true;
  } catch (err) {
    process.stdout.write(`\n  SKIPPING storage tests — no database (${err.message})\n`
      + '  Pure tests still ran. For the full suite point MYSQL_* at a server.\n\n');
  }

  let skipped = 0;
  for (const [name, fn] of asyncTests) {
    if (!dbReady && DB_BACKED.has(name)) { skipped++; continue; }
    try { await fn(); passed++; } catch (err) { failures.push([name, err]); }
  }

  if (dbReady) await db.close();

  if (failures.length) {
    for (const [name, err] of failures) {
      process.stderr.write(`FAIL  ${name}\n      ${err.message}\n`);
    }
    process.stderr.write(`\n${failures.length} failed, ${passed} passed\n`);
    process.exit(1);
  }
  process.stdout.write(`${passed} tests passed${skipped ? ` (${skipped} storage tests skipped)` : ''}\n`);
})();
